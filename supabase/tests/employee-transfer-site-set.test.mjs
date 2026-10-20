import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdtempSync } from 'node:fs';
import { open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assertExpectedReplayFailures, replayMigrations } from './support/replay-migrations.mjs';
import { adminLogin, rows, rpc as baseRpc, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Local only. Real SQL41 snapshot + the ten real domain export RPCs/drivers (siteExportApi is the real
// adapter, siteTransfer the real coordinator), real PBKDF2/AES/ZIP and ciphertext files on a temp disk.
// ONLY auth/supabase are replaced, by a PGlite RPC bridge. Workspaces are in-memory and cleanup-tracked.
// The fixture has no media references: the media domains still run real inventory/verify RPCs, and any
// network transport is forbidden. No Storage, browser disk, PostgREST, native PG concurrency or
// full-site/import acceptance is claimed (results are always fullSiteComplete=false/importReady=false).
mock.method(globalThis, 'fetch', () => assert.fail('Network/production/Storage access forbidden'));
const root = fileURLToPath(new URL('../../', import.meta.url));
const compiled = await build({
  stdin: { contents: `export {exportSiteBundleSet, inspectSiteBundleSet, getSiteTransferCapabilities, getSiteTransferHistory, SITE_DOMAINS} from './src/lib/employeeTransfer/siteTransfer.ts';
    export {writeEncryptedVolume, verifyEncryptedVolume} from './src/lib/employeeTransfer/container.ts';
    export {readTransferMetadata} from './src/lib/employeeTransfer/crypto.ts';
    export {setHarness} from 'site-set-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://offline.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('offline-test-key') },
  plugins: [{ name: 'offline-site-set', setup(builder) {
    builder.onResolve({ filter: /^(?:site-set-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'offline' }));
    builder.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => {
      if (path === 'site-set-test:state') return { contents: 'let h;export const setHarness=v=>{h=v};export const current=()=>h;' };
      if (path === '../auth') return { contents: "import{current}from'site-set-test:state';export function getAdminFinancialSessionToken(){return current().session;}" };
      return { contents: "import{current}from'site-set-test:state';export const formatSupabaseError=e=>String(e?.message??e);export const supabase={rpc:(...args)=>current().rpc(...args)};" };
    });
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

const PREVIOUS = '20261102000040_close_shared_export.sql';
const MIGRATION = '20261102000041_snapshot_site_export.sql';
const DOMAINS = ['shared', 'products', 'dispatch', 'identity', 'finance', 'activity', 'verification', 'notifications', 'chat', 'archives'];
const FILES = DOMAINS.map((d, i) => `${String(i + 1).padStart(2, '0')}-${d}.edx`);
const INDEX = 'site-index.edx';
const INDEX_PATH = 'data/site-index.ndjson';
const PASS = 'local site set passphrase 测试';
const CANARY = 'LOCAL-SITE-SET-RAW-CONTENT-MUST-NOT-LEAK';
const TIME = '2024-02-29T03:04:05.123456Z';
const id = n => `42000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const I = { employee: id(1), product: id(2), message: id(3), customer: id(4), chat: id(5), login: id(6),
  verification: id(7), audit: id(8), adminGroup: id(9), adminMember: id(10), groupOrder: id(11), valid: id(12) };
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const sha = raw => createHash('sha256').update(raw).digest('hex');
const GENERIC = /could not be confirmed as a complete, matching domain set/;
let db, replay, session, inside = false, queue = Promise.resolve();
const state = { rpcCalls: [], counts: new Map(), intercept: null, session: null };
const dirs = [];

// ---- DB bridge: each client RPC is one real SQL call as anon, with savepoint error isolation ----
async function change(relation, sql, params = []) {
  await db.exec('SAVEPOINT site_fixture');
  try {
    const triggers = await rows(db, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
    for (const t of triggers) await db.exec(`ALTER TABLE ${relation} DISABLE TRIGGER ${quote(t.tgname)}`);
    const result = await db.query(sql, params);
    for (const t of triggers) await db.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER ${quote(t.tgname)}`);
    await db.exec('RELEASE SAVEPOINT site_fixture');
    return result;
  } catch (error) { await db.exec('ROLLBACK TO SAVEPOINT site_fixture; RELEASE SAVEPOINT site_fixture'); throw error; }
}
async function run(call) {
  const forced = await state.intercept?.(call.name, call.n, call.args);
  if (forced?.error) return { data: null, error: { message: forced.error } };
  await db.exec('SAVEPOINT site_rpc');
  try {
    await db.exec('SET LOCAL ROLE anon');
    const data = await baseRpc(db, call.name, call.args, { role: null });
    await db.exec('RESET ROLE; RELEASE SAVEPOINT site_rpc');
    return { data, error: null };
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT site_rpc; RELEASE SAVEPOINT site_rpc');
    return { data: null, error: { message: error.message } };
  }
}
function bridge(name, args) {
  assert.ok(inside, 'every site RPC must run in an isolated rollback transaction');
  assert.equal(args.p_admin_session_token, session, 'fresh real super-admin session, never a client-forged admin id');
  const n = (state.counts.get(name) ?? 0) + 1; state.counts.set(name, n);
  const call = { name, n, args: structuredClone(args), signal: undefined }; state.rpcCalls.push(call);
  const query = { abortSignal(signal) { call.signal = signal; return query; }, then(resolve, reject) {
    const result = queue.then(() => run(call));
    queue = result.catch(() => undefined);
    return result.then(resolve, reject);
  } };
  return query;
}
async function isolated(fn) {
  await db.exec('BEGIN'); inside = true;
  state.rpcCalls = []; state.counts = new Map(); state.intercept = null;
  try { return await fn(); } finally { inside = false; state.intercept = null; await db.exec('ROLLBACK'); }
}
const names = () => state.rpcCalls.map(call => call.name);
const callsOf = name => state.rpcCalls.filter(call => call.name === name).length;
async function jobStats() {
  return { jobs: await rows(db, 'SELECT status,count(*)::int AS n FROM private.employee_transfer_jobs GROUP BY status ORDER BY status'),
    cancels: await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_events WHERE action LIKE '%cancel%'") };
}
const statusCount = (stats, status) => stats.jobs.find(job => job.status === status)?.n ?? 0;

// ---- disk ciphertext files, workspaces ----
function directory(hooks = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'site-set-')); dirs.push(dir);
  const outputs = new Map();
  const result = { dir, outputs, name: 'local-test', created: [], async writeText() { throw new Error('unused'); },
    createFile(name) {
      if (outputs.has(name)) throw new Error('Duplicate transfer output filename.');
      const path = hooks.pathFor?.(name) ?? join(dir, name), out = { name, path, writes: 0, opens: 0 };
      outputs.set(name, out); result.created.push(name);
      return {
        async write(source, signal) {
          out.writes++;
          await hooks.beforeWrite?.(out, result);
          const handle = await open(path, 'wx');
          try { for await (const chunk of source) { assert.notEqual(signal?.aborted, true); await handle.writeFile(chunk); } await handle.sync(); }
          finally { await handle.close(); }
          await hooks.afterWrite?.(out, result);
        },
        open() {
          out.opens++;
          return { async *[Symbol.asyncIterator]() { for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) yield chunk; } };
        },
      };
    } };
  return result;
}
function workspaces({ same = false, failAbortAt = 0 } = {}) {
  const spaces = [];
  const make = () => {
    const space = { data: new Map(), dead: false, aborts: 0, index: spaces.length + 1 };
    spaces.push(space);
    return Object.assign(space, {
      async append(path, bytes, signal) {
        assert.equal(space.dead, false); assert.notEqual(signal?.aborted, true);
        assert.ok(bytes instanceof Uint8Array && bytes.length <= 1048576);
        space.data.set(path, Buffer.concat([space.data.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)]));
      },
      open(path) {
        assert.equal(space.dead, false); assert.ok(space.data.has(path), `missing temporary entry ${path}`);
        return { async *[Symbol.asyncIterator]() {
          const saved = space.data.get(path);
          for (let i = 0; i < saved.length; i += 70001) { assert.equal(space.dead, false); yield Buffer.from(saved.subarray(i, i + 70001)); }
        } };
      },
      async abort() {
        space.aborts++; space.dead = true;
        for (const bytes of space.data.values()) bytes.fill(0);
        space.data.clear();
        if (failAbortAt === space.index) throw new Error('local workspace cleanup failure');
      },
    });
  };
  let first;
  return { spaces, create: same ? () => (first ??= make()) : make };
}
const allDead = (w, except = 0) => { for (const s of w.spaces) if (s.index !== except) { assert.equal(s.dead, true); assert.equal(s.data.size, 0); } };
const flip = async (path, at = 'middle') => {
  const raw = await readFile(path), position = at === 'middle' ? Math.floor(raw.length / 2) : raw.length - 1;
  raw[position] ^= 1; await writeFile(path, raw);
};
async function exportSet(extra = {}, dirHooks = {}) {
  const output = directory(dirHooks), w = extra.workspaces ?? workspaces(), events = [];
  api.setHarness({ session, rpc: bridge });
  const promise = api.exportSiteBundleSet({ adminPassword: PASSWORDS.root, passphrase: PASS, directory: output,
    createWorkspace: w.create, onProgress: event => { events.push(event); extra.onProgress?.(event); }, ...extra.options });
  return { output, w, events, promise };
}
const filesOf = async output => Promise.all([...output.outputs.values()].map(async out => ({ name: out.name, raw: await readFile(out.path) })));
const toFiles = list => list.map(({ name, raw }) => new File([raw], name));
async function inspect(files, { passphrase = PASS, w = workspaces(), options } = {}) {
  const before = state.rpcCalls.length, events = [];
  try { return await api.inspectSiteBundleSet(files, passphrase, w.create, { onProgress: e => events.push(e), ...options }); }
  finally { assert.equal(state.rpcCalls.length, before, 'inspection performs no database RPC'); allDead(w); void events; }
}
let setA, setB, resultA, snapshotA;

before(async () => {
  replay = await replayMigrations({ upTo: PREVIOUS, strict: true }); db = replay.db;
  await db.exec(await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8'));
  replay.files.push(MIGRATION);
  assertExpectedReplayFailures(replay, { upTo: MIGRATION });
  await buildNewSite(db);
  await db.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,remarks)
    VALUES($1,'site_employee','SITE-001',extensions.crypt($2,extensions.gen_salt('bf',4)),$3,$4)`, [I.employee, PASSWORDS.employee, NEW.root, CANARY]);
  await db.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [I.employee]);
  await db.query(`INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Site product',true)`, [I.product]);
  await db.query(`INSERT INTO public.admin_groups(id,name,created_by) VALUES($1,'Site shared group',$2)`, [I.adminGroup, NEW.root]);
  await db.query(`INSERT INTO public.admin_group_members(id,group_id,admin_id) VALUES($1,$2,$3)`, [I.adminMember, I.adminGroup, NEW.branch]);
  await db.query(`INSERT INTO public.admin_configs(admin_id,config_type,config_value) VALUES($1,'company_name',$2)
    ON CONFLICT(admin_id,config_type) DO UPDATE SET config_value=EXCLUDED.config_value`, [NEW.branch, CANARY]);
  await db.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,created_by)
    SELECT $1,group_id,id,$2,$3 FROM public.dispatch_order_pools WHERE group_id=$4 AND is_base`, [I.groupOrder, CANARY, NEW.root, NEW.groupA]);
  await db.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by) VALUES($1,12.345678901,'SITE-VALID',$2)`, [I.valid, NEW.root]);
  await db.query(`INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,created_at,device_info)
    VALUES($1,$2,'site_employee','SITE-001','login',$3,NULL)`, [I.login, I.employee, TIME]);
  await db.query(`INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status)
    VALUES($1,$2,$3,'SITE-ID','555-0000','SITE-ADDRESS','pending')`, [I.verification, I.employee, CANARY]);
  await db.query(`INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority,notification_category,audit_origin,delivery_mode)
    VALUES($1,$2,'root','Site notification',$3,'realtime','normal','standard','manual_admin','realtime_only')`, [I.message, NEW.root, CANARY]);
  await db.query('INSERT INTO public.message_recipients(message_id,recipient_id) VALUES($1,$2)', [I.message, I.employee]);
  await db.query(`INSERT INTO public.simulated_customers(id,admin_id,customer_name,customer_id,source_type,target_employee_ids)
    VALUES($1,$2,'Site customer','SITE-CUSTOMER','aaa_service',NULL)`, [I.customer, NEW.root]);
  // The DB default emoji avatar is rejected by exportChatBundle (managed URL or virtual avatar only).
  await db.query("UPDATE public.simulated_customers SET customer_avatar='customer-avatar:regular:1' WHERE id=$1", [I.customer]);
  await db.query(`INSERT INTO public.customer_employee_conversations(id,customer_id,employee_id,sender_type,message_content,message_type,source_type)
    VALUES($1,$2,$3,'customer',$4,'text','aaa_service')`, [I.chat, I.customer, I.employee, CANARY]);
  await db.query(`INSERT INTO private.content_audit_events(id,operation_id,entity_type,entity_id,action,owner_admin_id,actor_admin_id,
    actor_username,actor_role,before_data,after_data,media_refs,occurred_at)
    VALUES($1,$2,'notification',$3,'edit',$4,$4,'root','super_admin',NULL,'null','{}',$5)`, [I.audit, id(20), I.message, NEW.root, TIME]);
  session = await adminLogin(db, 'root', PASSWORDS.root);
}, { timeout: 240000 });
after(async () => {
  await db?.close();
  const fetches = globalThis.fetch.mock.callCount();
  mock.restoreAll();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  assert.equal(fetches, 0, 'no network/Storage access at all');
});

test('isolation uses real coordinator/adapter/drivers/container/crypto and no Supabase client or network', () => {
  const paths = Object.keys(compiled.metafile.inputs);
  for (const name of ['siteTransfer', 'siteExportApi', 'identityApi', 'financeApi', 'chatApi', 'archiveBundle', 'container', 'crypto', 'verificationMedia'])
    assert.ok(paths.some(path => path.endsWith(`/employeeTransfer/${name}.ts`)), name);
  assert.equal(paths.some(path => /src\/lib\/(?:auth|supabase)\.ts$|node_modules\/@supabase\//.test(path)), false);
});

test('real round trip: SQL41 snapshot, ten real serial domain exports, ten encrypted volumes plus encrypted index', { timeout: 240000 }, async () => {
  await isolated(async () => {
    const { output, w, events, promise } = await exportSet();
    resultA = await promise;
    snapshotA = (await bridgeRead('get_employee_export_site_snapshot', { p_package_id: resultA.packageId }));
    assert.deepEqual(output.created, [...FILES, INDEX]);
    assert.deepEqual((await readdir(output.dir)).sort(), [...FILES, INDEX].sort());
    assert.deepEqual(resultA.volumes.map(v => v.domain), [...DOMAINS, 'index']);
    assert.deepEqual(resultA.volumes.map(v => v.filename), [...FILES, INDEX]);
    assert.equal(resultA.fullSiteComplete, false); assert.equal(resultA.importReady, false);
    assert.equal(resultA.sourceSiteId, snapshotA.site_id);
    const disk = await filesOf(output);
    for (const volume of resultA.volumes) {
      const file = disk.find(f => f.name === volume.filename);
      assert.equal(file.raw.length, volume.cipherBytes); assert.equal(sha(file.raw), volume.cipherSha256);
      assert.equal((await stat(join(output.dir, volume.filename))).size, volume.cipherBytes);
      for (const secret of [CANARY, 'site_employee', PASS, 'SITE-ID', 'SITE-ADDRESS'])
        assert.equal(file.raw.includes(Buffer.from(secret)), false, `${volume.filename} must not contain plaintext ${secret.slice(0, 8)}`);
    }
    for (const domain of DOMAINS) {
      assert.equal(resultA.volumes.find(v => v.domain === domain).rows,
        snapshotA.catalogs[domain].tables.reduce((n, t) => n + t.rows, 0), domain);
    }
    assert.ok(resultA.volumes.filter(v => v.domain !== 'index').reduce((n, v) => n + v.rows, 0) > 20);
    assert.equal(resultA.volumes.reduce((n, v) => n + v.files, 0), 0, 'fixture has no media');
    // Strictly serial: begin -> close for each domain, then a second snapshot, no cancel.
    const sequence = names();
    assert.deepEqual(sequence.slice(0, 2), ['get_employee_transfer_capabilities', 'get_employee_export_site_snapshot']);
    assert.equal(sequence.at(-1) === 'get_employee_export_site_snapshot' || sequence.at(-2) === 'get_employee_export_site_snapshot', true);
    const begins = sequence.map((name, i) => /^employee_export_\w+_begin$/.test(name) ? i : -1).filter(i => i >= 0);
    const closes = sequence.map((name, i) => /^employee_(?:export_\w+|products)_close$/.test(name) ? i : -1).filter(i => i >= 0);
    assert.equal(begins.length, 10); assert.equal(closes.length, 10);
    for (let n = 0; n < 10; n++) { assert.ok(begins[n] < closes[n]); if (n) assert.ok(closes[n - 1] < begins[n]); }
    assert.equal(sequence.findIndex(name => /cancel/.test(name)), -1);
    assert.equal(callsOf('get_employee_export_site_snapshot'), 3, 'baseline, final recheck and this test readback');
    const stats = await jobStats();
    assert.equal(statusCount(stats, 'finished'), 10); assert.equal(statusCount(stats, 'running'), 0); assert.equal(stats.cancels, 0);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging'), 0);
    allDead(w);
    const last = events.at(-1);
    assert.equal(last.phase, 'complete'); assert.equal(last.completedDomains, 10); assert.equal(last.totalDomains, 10);
    for (const domain of DOMAINS) for (const phase of ['begin', 'authenticate', 'close'])
      assert.ok(events.some(e => e.domain === domain && e.phase === phase), `${domain}/${phase}`);
    const capabilities = await api.getSiteTransferCapabilities();
    assert.equal(capabilities.can_import, false); assert.ok(capabilities.import_blockers.length > 0);
    assert.equal(capabilities.can_export, true);
    setA = disk;
  });
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});
async function bridgeRead(name, args) {
  api.setHarness({ session, rpc: bridge });
  const { data, error } = await bridge(name, { p_admin_session_token: session, ...args });
  assert.equal(error, null); return data;
}

test('a second independent real export creates a different package/volume set for mixed-package tests', { timeout: 240000 }, async () => {
  await isolated(async () => {
    const { output, promise } = await exportSet();
    const result = await promise;
    assert.notEqual(result.packageId, resultA.packageId);
    setB = await filesOf(output);
    assert.notEqual(sha(setB[0].raw), sha(setA[0].raw));
  });
});

test('inspect selects the 11 saved files (any order), authenticates real crypto/ZIP, matches export receipts and stays read-only', async () => {
  api.setHarness({ session, rpc: bridge });
  state.rpcCalls = [];
  const events = [], w = workspaces();
  const shuffled = toFiles([...setA].reverse());
  const result = await api.inspectSiteBundleSet(shuffled, PASS, w.create, { onProgress: e => events.push(e) });
  assert.deepEqual(result, resultA);
  assert.equal(result.fullSiteComplete, false); assert.equal(result.importReady, false);
  assert.equal(state.rpcCalls.length, 0); allDead(w);
  assert.equal(events.at(-1).phase, 'complete');
  assert.deepEqual(await inspect(toFiles(setA)), resultA);
});

test('inspect rejects wrong passphrase, truncation, tampering, missing, duplicate, mixed-package and renamed sets with a generic error', async () => {
  const byName = name => setA.find(f => f.name === name);
  const swap = (list, name, raw) => list.map(f => f.name === name ? { name, raw } : f);
  const cases = {
    'wrong passphrase': { files: setA, passphrase: PASS + 'x' },
    'empty passphrase': { files: setA, passphrase: '' },
    'truncated domain volume': { files: swap(setA, FILES[4], byName(FILES[4]).raw.subarray(0, -7)) },
    'truncated index': { files: swap(setA, INDEX, byName(INDEX).raw.subarray(0, -7)) },
    'index cut to header only': { files: swap(setA, INDEX, byName(INDEX).raw.subarray(0, 20)) },
    'tampered domain volume (same size)': { files: await tampered(FILES[5]) },
    'tampered last byte of domain volume': { files: await tampered(FILES[8], 'last') },
    'tampered index': { files: await tampered(INDEX) },
    'missing volume': { files: setA.filter(f => f.name !== FILES[8]) },
    'missing index': { files: setA.filter(f => f.name !== INDEX) },
    'extra unknown file': { files: [...setA, { name: 'notes.txt', raw: Buffer.from('x') }] },
    'duplicate volume replaces another': { files: setA.map(f => f.name === FILES[1] ? { name: FILES[0], raw: byName(FILES[0]).raw } : f) },
    'empty volume': { files: swap(setA, FILES[2], Buffer.alloc(0)) },
    'mixed package volume': { files: swap(setA, FILES[4], setB.find(f => f.name === FILES[4]).raw) },
    'mixed package index': { files: swap(setA, INDEX, setB.find(f => f.name === INDEX).raw) },
    'swapped domain contents under swapped names': { files: setA.map(f => f.name === FILES[0] ? { name: FILES[0], raw: byName(FILES[1]).raw }
      : f.name === FILES[1] ? { name: FILES[1], raw: byName(FILES[0]).raw } : f) },
    'renamed volume': { files: setA.map(f => f.name === FILES[3] ? { name: 'copy-' + FILES[3], raw: f.raw } : f) },
    'case-changed index name': { files: setA.map(f => f.name === INDEX ? { name: INDEX.toUpperCase(), raw: f.raw } : f) },
  };
  async function tampered(name, at) {
    const raw = Buffer.from(byName(name).raw), position = at === 'last' ? raw.length - 1 : Math.floor(raw.length / 2);
    raw[position] ^= 1; return swap(setA, name, raw);
  }
  api.setHarness({ session, rpc: bridge });
  for (const [label, item] of Object.entries(cases)) {
    await assert.rejects(inspect(toFiles(item.files), { passphrase: item.passphrase ?? PASS }), error => {
      assert.match(error.message, GENERIC, label);
      assert.equal(error.message.includes(PASS), false);
      return true;
    }, label);
  }
});

async function resign(mutate) {
  const index = setA.find(f => f.name === INDEX).raw;
  const source = { [Symbol.asyncIterator]: async function* () { yield new Uint8Array(index); } };
  const metadata = await api.readTransferMetadata(source);
  const sink = workspaces().create();
  const manifest = await api.verifyEncryptedVolume(source, PASS, sink, { expectedMetadata: metadata, limits: { maxLineBytes: 2 * 1024 * 1024 } });
  const parts = []; for await (const chunk of sink.open(INDEX_PATH)) parts.push(Buffer.from(chunk));
  const document = JSON.parse(Buffer.concat(parts).toString('utf8'));
  mutate(document);
  const raw = Buffer.from(JSON.stringify(document) + '\n');
  const info = { exportId: manifest.exportId, sourceSiteId: manifest.sourceSiteId, volumeId: manifest.volumeId,
    createdAt: manifest.createdAt, scope: manifest.scope, volumeIndex: 1, volumeCount: 1 };
  const out = [];
  for await (const chunk of api.writeEncryptedVolume((async function* () {
    yield { path: INDEX_PATH, bytes: raw.length, open: () => (async function* () { yield raw; })() };
  })(), info, PASS, { limits: { maxLineBytes: 2 * 1024 * 1024 } })) out.push(Buffer.from(chunk));
  return { name: INDEX, raw: Buffer.concat(out) };
}
test('inspect rejects a validly encrypted but semantically changed index (digest, rows, order, snapshot, completion flags)', async () => {
  assert.deepEqual(await inspect(toFiles(setA.map(f => f.name === INDEX ? { name: INDEX, raw: f.raw } : f))), resultA, 'control');
  // Control with an unchanged re-signed index must be accepted: it proves the helper itself is valid.
  const control = await resign(() => undefined);
  assert.deepEqual((await inspect(toFiles(setA.map(f => f.name === INDEX ? control : f)))).volumes.map(v => v.domain), [...DOMAINS, 'index']);
  const mutations = {
    'cipher digest': d => { d.volumes[3].cipherSha256 = '0'.repeat(64); },
    'cipher size': d => { d.volumes[3].cipherBytes += 1; },
    'row count': d => { d.volumes[4].rows += 1; },
    'volume order': d => { d.volumes.reverse(); },
    'volume id reused': d => { d.volumes[1].volumeId = d.volumes[0].volumeId; },
    'media file count': d => { d.volumes[6].files = 1; },
    'snapshot hash': d => { d.snapshot.sha256 = 'f'.repeat(64); },
    'package id': d => { d.snapshot.package_id = randomUUID(); },
    'full_site_complete': d => { d.full_site_complete = true; },
    'import_ready': d => { d.import_ready = true; },
    'snapshot completion flag': d => { d.snapshot.full_site_complete = true; },
    'unknown field': d => { d.extra = 1; },
  };
  for (const [label, mutate] of Object.entries(mutations)) {
    const changed = await resign(mutate);
    await assert.rejects(inspect(toFiles(setA.map(f => f.name === INDEX ? changed : f))), GENERIC, label);
  }
});
test('inspect cancellation and cleanup failure discard all temporary plaintext and never report success', async () => {
  const controller = new AbortController(), w = workspaces();
  await assert.rejects(api.inspectSiteBundleSet(toFiles(setA), PASS, w.create, { signal: controller.signal,
    onProgress: e => { if (e.domain === 'chat' && e.phase === 'validate') controller.abort(); } }), error => error.name === 'AbortError');
  allDead(w);
  const reused = workspaces({ same: true });
  await assert.rejects(api.inspectSiteBundleSet(toFiles(setA), PASS, reused.create), GENERIC);
  allDead(reused);
  const failing = workspaces({ failAbortAt: 3 });
  await assert.rejects(api.inspectSiteBundleSet(toFiles(setA), PASS, failing.create), /cleanup could not be confirmed/);
  allDead(failing, 3);
  await assert.rejects(api.inspectSiteBundleSet(toFiles(setA), PASS, workspaces().create, { signal: AbortSignal.abort() }), error => error.name === 'AbortError');
});

// ---- export failures: real SQL/drivers; each case keeps the server task state honest ----
async function failed(label, setup, check) {
  await isolated(async () => {
    const context = await setup();
    const { output, w, promise } = context;
    await assert.rejects(promise, error => { context.error = error; return true; }, label);
    assert.equal(output.created.includes(INDEX), false, `${label}: no success index file may be created`);
    assert.equal(names().some(name => /cancel/.test(name)), false, `${label}: no automatic cancel RPC`);
    const stats = await jobStats(); assert.equal(stats.cancels, 0);
    await check({ ...context, stats });
    if (!context.skipDead) allDead(w);
  });
}
const STOPPED = /Site export stopped during/;

test('drift before the first domain begin: begin catalog is compared to the baseline, task stays open, no volume or index', { timeout: 120000 }, async () => {
  await failed('start drift', async () => {
    const context = await exportSet();
    state.intercept = async name => {
      if (name === 'employee_export_shared_begin') await change('public.admin_configs',
        "UPDATE public.admin_configs SET config_value='changed-at-start' WHERE admin_id=$1 AND config_type='company_name'", [NEW.branch]);
    };
    return context;
  }, ({ error, output, stats }) => {
    assert.match(error.message, /stopped during begin/); assert.deepEqual(output.created, []);
    assert.equal(statusCount(stats, 'running'), 1, 'unverified server task is kept for explicit reconciliation');
    assert.equal(callsOf('employee_export_shared_close'), 0); assert.equal(callsOf('employee_export_shared_begin'), 1);
  });
});
test('drift between two verified domain volumes is rejected at the next begin (mixed-time bundle never completes)', { timeout: 120000 }, async () => {
  await failed('mid drift', async () => {
    const context = await exportSet();
    state.intercept = async name => {
      if (name === 'employee_export_identity_begin') await change('public.users', 'UPDATE public.users SET remarks=$2 WHERE id=$1', [I.employee, 'changed between domains']);
    };
    return context;
  }, ({ error, output, stats }) => {
    assert.match(error.message, /stopped during begin/); assert.deepEqual(output.created, FILES.slice(0, 3));
    assert.equal(statusCount(stats, 'finished'), 3); assert.equal(statusCount(stats, 'running'), 1);
    assert.equal(callsOf('employee_export_identity_close'), 0);
  });
});
test('drift after all ten volumes closed fails the final snapshot comparison; no site-index.edx is written', { timeout: 240000 }, async () => {
  await failed('end drift', async () => {
    const context = await exportSet();
    state.intercept = async (name, n) => {
      if (name === 'get_employee_export_site_snapshot' && n === 2) await change('public.users',
        'UPDATE public.users SET remarks=$2 WHERE id=$1', [I.employee, 'changed after every domain']);
    };
    return context;
  }, async ({ error, output, stats }) => {
    assert.match(error.message, /stopped during recheck/); assert.deepEqual(output.created, FILES);
    assert.equal(statusCount(stats, 'finished'), 10); assert.equal(statusCount(stats, 'running'), 0);
    assert.equal((await readdir(output.dir)).includes(INDEX), false);
  });
});
test('saved ciphertext corrupted before independent readback keeps the unverified domain task open and stops', { timeout: 120000 }, async () => {
  await failed('readback corruption', () => exportSet({}, { afterWrite: async out => { if (out.name === FILES[3]) await flip(out.path); } }),
    ({ error, output, stats }) => {
      assert.match(error.message, /stopped during authenticate/); assert.deepEqual(output.created, FILES.slice(0, 4));
      assert.equal(statusCount(stats, 'running'), 1); assert.equal(callsOf('employee_export_identity_close'), 0);
      assert.equal(callsOf('employee_export_finance_begin'), 0);
    });
});
test('an earlier volume modified on disk after its domain closed is caught by the final ciphertext recheck', { timeout: 240000 }, async () => {
  await failed('earlier volume changed', () => exportSet({}, { afterWrite: async (out, dir) => {
    if (out.name === FILES[5]) await flip(dir.outputs.get(FILES[0]).path);
  } }), ({ error, output, stats }) => {
    assert.match(error.message, /stopped during recheck/); assert.deepEqual(output.created, FILES);
    assert.equal(statusCount(stats, 'finished'), 10);
  });
});
test('two output wrappers sharing one underlying path: the second write is rejected, never overwrites, never retried', { timeout: 120000 }, async () => {
  let before;
  const shared = join(mkdtempSync(join(tmpdir(), 'site-set-shared-')), 'shared.edx');
  dirs.push(join(shared, '..'));
  await failed('shared path', () => exportSet({}, { pathFor: name => name === FILES[0] || name === FILES[1] ? shared : join(dirs.at(-1), name),
    afterWrite: async out => { if (out.name === FILES[0]) before = sha(await readFile(out.path)); } }),
  async ({ error, output, stats }) => {
    assert.match(error.message, /stopped during save/);
    assert.deepEqual(output.created, FILES.slice(0, 2)); assert.equal(output.outputs.get(FILES[1]).writes, 1);
    assert.equal(sha(await readFile(shared)), before, 'first ciphertext is not overwritten or truncated');
    assert.equal(statusCount(stats, 'running'), 1); assert.equal(callsOf('employee_products_close') + callsOf('employee_export_products_close'), 0);
    assert.equal(callsOf('employee_export_products_begin'), 1);
  });
});
test('a failed domain-volume write is not retried, does not close the unverified task and starts no later domain', { timeout: 120000 }, async () => {
  await failed('write failure', () => exportSet({}, { beforeWrite: out => { if (out.name === FILES[6]) throw new Error('disk secret /private/path'); } }),
    ({ error, output, stats }) => {
      assert.match(error.message, /stopped during save/); assert.equal(error.message.includes('/private/path'), false);
      assert.equal(output.outputs.get(FILES[6]).writes, 1); assert.equal(output.created.length, 7);
      assert.equal(callsOf('employee_export_verification_close'), 0); assert.equal(callsOf('employee_export_notifications_begin'), 0);
      assert.equal(statusCount(stats, 'running'), 1);
    });
});
test('begin and close RPC failures are never retried and do not hide an uncertain active task', { timeout: 240000 }, async () => {
  await failed('begin failure', async () => {
    const context = await exportSet();
    state.intercept = async name => name === 'employee_export_products_begin' ? { error: 'private backend detail' } : undefined;
    return context;
  }, ({ error, output }) => {
    assert.match(error.message, /stopped during begin/); assert.equal(error.message.includes('private backend'), false);
    assert.equal(callsOf('employee_export_products_begin'), 1); assert.deepEqual(output.created, [FILES[0]]);
  });
  await failed('close failure', async () => {
    const context = await exportSet();
    state.intercept = async name => name === 'employee_export_chat_close' ? { error: 'private backend detail' } : undefined;
    return context;
  }, ({ error, output, stats }) => {
    assert.match(error.message, /stopped during close/); assert.equal(callsOf('employee_export_chat_close'), 1);
    assert.deepEqual(output.created, FILES.slice(0, 9)); assert.equal(callsOf('employee_export_archives_begin'), 0);
    assert.equal(statusCount(stats, 'running'), 1, 'task whose close outcome is unknown remains for reconciliation');
  });
});
test('cancellation leaves the active server task for explicit reconciliation, discards workspaces and writes no index', { timeout: 120000 }, async () => {
  const controller = new AbortController();
  await failed('cancel', () => exportSet({ options: { signal: controller.signal },
    onProgress: e => { if (e.domain === 'chat' && e.phase === 'records') controller.abort(); } }),
  ({ error, stats }) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(statusCount(stats, 'running'), 1); assert.equal(callsOf('employee_export_chat_close'), 0);
    assert.equal(callsOf('employee_export_archives_begin'), 0);
  });
  await isolated(async () => {
    const before = state.rpcCalls.length;
    const { promise } = await exportSet({ options: { signal: AbortSignal.abort() } });
    await assert.rejects(promise, error => error.name === 'AbortError');
    assert.equal(state.rpcCalls.length, before, 'pre-aborted export contacts no backend');
  });
});
test('workspace reuse is refused and unconfirmed workspace cleanup is reported without a success result', { timeout: 120000 }, async () => {
  const reused = workspaces({ same: true });
  await failed('workspace reuse', () => exportSet({ workspaces: reused }), ({ error, output, stats }) => {
    assert.match(error.message, /stopped during/); assert.equal(statusCount(stats, 'running'), 1);
    assert.ok(output.created.length <= 1);
  });
  await isolated(async () => {
    const failing = workspaces({ failAbortAt: 1 });
    const { promise } = await exportSet({ workspaces: failing });
    await assert.rejects(promise, /Site transfer plaintext cleanup could not be confirmed\. Do not reuse its workspace\./);
    allDead(failing, 1);
  });
});
test('export result and metadata state records only, never full-site completion, import readiness or restore capability', async () => {
  assert.equal(resultA.fullSiteComplete, false); assert.equal(resultA.importReady, false);
  const index = await resign(d => { assert.equal(d.full_site_complete, false); assert.equal(d.import_ready, false);
    assert.equal(d.snapshot.full_site_complete, false); assert.equal(d.snapshot.import_ready, false); });
  assert.ok(index.raw.length > 0);
  await isolated(async () => {
    api.setHarness({ session, rpc: bridge });
    const capabilities = await api.getSiteTransferCapabilities();
    assert.equal(capabilities.can_import, false); assert.ok(capabilities.import_blockers.length > 0);
    assert.deepEqual(await api.getSiteTransferHistory().then(list => list.every(item => !/import_finished/.test(item.kind))), true);
  });
});
