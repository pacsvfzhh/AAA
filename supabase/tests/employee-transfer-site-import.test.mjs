import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdtempSync } from 'node:fs';
import { open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { assertExpectedReplayFailures } from './support/replay-migrations.mjs';
import { adminLogin, createSites, rows, rpc as baseRpc, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// LOCAL ONLY. Only the two foundations (auth/supabase) are replaced. The coordinator,
// ten export/import drivers, SQL, plans, backup seals and verification receipts are REAL.
// PGlite/platform substitutes are not native PostgreSQL/PostgREST acceptance. Ciphertexts
// are real disk files; temporary plaintext workspaces and Edge Storage are in memory.
// Source fixture trigger changes finish BEFORE import; no importer error is bypassed.
const root = fileURLToPath(new URL('../../', import.meta.url));
const LAST = '20261102000055_verify_site_restore.sql';
const ORIGIN = 'https://offline.supabase.co';
const ENDPOINT = ORIGIN + '/functions/v1/employee-transfer-media';
const PASS = 'offline site import passphrase 合成';
const CANARY = 'LOCAL-IMPORT-RAW-CONTENT-DO-NOT-EXPOSE';
const TIME = '2024-02-29T03:04:05.123456Z';
const DOMAINS = ['shared', 'products', 'dispatch', 'identity', 'finance', 'activity', 'verification', 'notifications', 'chat', 'archives'];
const FILENAMES = [...DOMAINS.map((d, i) => `${String(i + 1).padStart(2, '0')}-${d}.edx`), 'site-index.edx'];
const BACKUPS = ['backup-shared.edx', 'backup-products.edx', 'backup-dispatch.edx', 'backup-notifications.edx', 'backup-chat.edx'];
const id = n => `45000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const I = { employee: id(1), product: id(2), success: id(3), failure: id(4), withdrawal: id(5), valid: id(6), used: id(7),
  login: id(8), work: id(9), verification: id(10), message: id(11), customer: id(12), chat: id(13), audit: id(14),
  archive: id(15), operation: id(16), groupOrder: id(17), targetRoot: id(100), targetGroup: id(101), targetNotice: id(102) };
const quote = s => '"' + s.replaceAll('"', '""') + '"';
const sha = raw => createHash('sha256').update(raw).digest('hex');
const edge = { handler: null, calls: [], foreign: [], objects: new Map(), uploads: [], rpcErrors: [] };
mock.method(globalThis, 'fetch', async (url, init) => {
  if (String(url) !== ENDPOINT || !edge.handler) {
    edge.foreign.push(String(url)); throw new Error('External network/production access forbidden');
  }
  assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
  edge.calls.push({ action: init.headers['x-transfer-action'], scope: init.headers['x-transfer-scope'] ?? 'verification' });
  const response = await edge.handler(new Request(url, init));
  edge.calls.at(-1).status = response.status;
  return response;
});
const compiled = await build({
  stdin: { contents: `export {exportSiteBundleSet, withAuthenticatedSiteBundleSet} from './src/lib/employeeTransfer/siteTransfer.ts';
    export {importSiteBundleSetToMaintenance} from './src/lib/employeeTransfer/siteImport.ts';
    export {readTransferMetadata} from './src/lib/employeeTransfer/crypto.ts';
    export {verifyEncryptedVolume} from './src/lib/employeeTransfer/container.ts';
    export {setHarness} from 'site-import-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(ORIGIN), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('offline-test-key') },
  plugins: [{ name: 'offline-site-import', setup(b) {
    b.onResolve({ filter: /^(?:site-import-test:state|\.\.\/(?:auth|supabase))$/ }, a => ({ path: a.path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === 'site-import-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth' ? "import{current}from'site-import-test:state';export const getAdminFinancialSessionToken=()=>current().session;"
      : "import{current}from'site-import-test:state';export const formatSupabaseError=e=>String(e?.message??e);export const supabase={rpc:(...args)=>current().rpc(...args)};" }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const edgeBuild = await build({ entryPoints: [root + 'supabase/functions/employee-transfer-media/handler.ts'], bundle: true,
  write: false, platform: 'browser', format: 'esm' });
const edgeModule = await import(`data:text/javascript;base64,${Buffer.from(edgeBuild.outputFiles[0].text).toString('base64')}`);
let source, target, replay, sourceSession, targetSession, sourceId, targetId, setA, setB, setMedia;
let active, session, inside = false, queue = Promise.resolve();
const state = { calls: [], afterSql: null };
const dirs = [];
function bridge(name, args) {
  assert.ok(inside, 'RPC outside local isolated transaction');
  assert.equal(args.p_admin_session_token, session);
  const call = { name, args: structuredClone(args), result: null, error: null };
  state.calls.push(call);
  const query = { abortSignal() { return query; }, then(resolve, reject) {
    const result = queue.then(async () => {
      const actual = await execAs('anon', name, args);
      call.result = actual.data; call.error = actual.error?.message ?? null;
      // Transport loss ONLY AFTER the actual SQL executed; never fabricate an SQL success.
      return await state.afterSql?.(call, actual) ?? actual;
    });
    queue = result.catch(() => undefined); return result.then(resolve, reject);
  } };
  return query;
}
async function execAs(role, name, args) {
  await active.exec('SAVEPOINT site_import_rpc');
  try {
    await active.exec(`SET LOCAL ROLE ${role}`);
    const data = await baseRpc(active, name, args, { role: null });
    await active.exec('RESET ROLE; RELEASE SAVEPOINT site_import_rpc');
    return { data, error: null };
  } catch (error) {
    await active.exec('ROLLBACK TO SAVEPOINT site_import_rpc; RELEASE SAVEPOINT site_import_rpc');
    return { data: null, error: { message: error.message } };
  }
}
async function isolated(db, token, use) {
  active = db; session = token; inside = true; state.calls = []; state.afterSql = null;
  api.setHarness({ session, rpc: bridge }); await db.exec('BEGIN');
  try { return await use(); }
  finally { await queue; await db.exec('ROLLBACK'); inside = false; state.afterSql = null; edge.handler = null; }
}
const names = () => state.calls.map(c => c.name);
const callsOf = name => state.calls.filter(c => c.name === name);
async function triggers(db) {
  return rows(db, `SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
    FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2`);
}
// Trusted fixture only, same scoped savepoint/state restoration as existing support tests.
async function fixtureChange(db, relation, sql, args = []) {
  assert.equal(inside, false, 'never disable triggers while an importer/exporter is running');
  await db.exec('SAVEPOINT fixture_change');
  try {
    const modes = await rows(db, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
    for (const t of modes) await db.exec(`ALTER TABLE ${relation} DISABLE TRIGGER ${quote(t.tgname)}`);
    await db.query(sql, args);
    for (const t of modes) await db.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER ${quote(t.tgname)}`);
    await db.exec('RELEASE SAVEPOINT fixture_change');
  } catch (e) { await db.exec('ROLLBACK TO SAVEPOINT fixture_change; RELEASE SAVEPOINT fixture_change'); throw e; }
}
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'site-import-')); dirs.push(dir);
  const outputs = new Map();
  return { dir, outputs, name: 'offline-disk', async writeText() { throw new Error('unused'); }, createFile(name) {
    assert.equal(outputs.has(name), false, 'never overwrite an output');
    const out = { name, path: join(dir, name), opens: 0, writes: 0 }; outputs.set(name, out);
    return { async write(stream, signal) {
      out.writes++; const file = await open(out.path, 'wx');
      try { for await (const raw of stream) { assert.notEqual(signal?.aborted, true); await file.writeFile(raw); } await file.sync(); }
      finally { await file.close(); }
    }, open() { out.opens++; return disk(out.path); } };
  } };
}
const disk = path => ({ async *[Symbol.asyncIterator]() { for await (const raw of createReadStream(path, { highWaterMark: 65536 })) yield raw; } });
function workspaces({ failCleanup = () => false } = {}) {
  const spaces = [];
  const create = () => {
    const s = { data: new Map(), dead: false, aborts: 0 }; spaces.push(s);
    return Object.assign(s, { async append(path, bytes) {
      assert.equal(s.dead, false); assert.ok(bytes instanceof Uint8Array && bytes.length <= 1048576);
      s.data.set(path, Buffer.concat([s.data.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)]));
    }, open(path) {
      assert.equal(s.dead, false); assert.ok(s.data.has(path), path);
      return { async *[Symbol.asyncIterator]() {
        const raw = s.data.get(path);
        for (let i = 0; i < raw.length; i += 65536) { assert.equal(s.dead, false); yield Buffer.from(raw.subarray(i, i + 65536)); }
      } };
    }, async abort() {
      s.aborts++; s.dead = true;
      for (const b of s.data.values()) b.fill(0); s.data.clear();
      if (failCleanup(s)) throw new Error('Synthetic temporary cleanup failure');
    } });
  };
  return { create, spaces };
}
function allDead(w) { assert.ok(w.spaces.every(s => s.dead && !s.data.size)); }
const fileList = set => set.map(f => new File([f.raw], f.name));
const readDirectory = output => Promise.all([...output.outputs.values()].map(async f => ({ name: f.name, raw: await readFile(f.path) })));
async function exportSet() {
  const output = directory(), w = workspaces();
  let last;
  let result;
  try { result = await api.exportSiteBundleSet({ adminPassword: PASSWORDS.root, passphrase: PASS, directory: output,
    createWorkspace: w.create, onProgress: e => { last = e; } }); }
  catch (error) { throw new Error(JSON.stringify({ message: error.message, last, sqlErrors: state.calls.filter(c => c.error).map(c => ({ rpc: c.name, error: c.error })), edgeCalls: edge.calls, edgeErrors: edge.rpcErrors })); }
  assert.deepEqual((await readdir(output.dir)).sort(), [...FILENAMES].sort());
  assert.equal(result.importReady, false); assert.equal(result.fullSiteComplete, false); allDead(w);
  const files = await readDirectory(output);
  for (const v of result.volumes) { const f = files.find(f => f.name === v.filename); assert.equal(sha(f.raw), v.cipherSha256); }
  return files;
}
function explicitRoles(plan) {
  assert.equal(plan.scope, 'site-chat'); assert.ok(Array.isArray(plan.roles));
  return plan.roles.map(role => {
    assert.ok(['new', 'exact', 'name'].includes(role.match), `explicit decision required for ${role.match}`);
    return { source_id: role.source_id, target_id: role.match === 'new' ? null : role.target_id,
      allow_visibility: true, confirmed: true };
  });
}
function startImport(extra = {}) {
  const output = directory(), w = extra.w ?? workspaces(), progress = [], plans = [], proofs = [];
  const options = { files: fileList(setA), passphrase: PASS, adminPassword: PASSWORDS.root, directory: output,
    createWorkspace: w.create, confirmation: '確認導入員工資料', approvePlan: async (domain, plan) => { plans.push({ domain, plan }); return true; },
    chooseChatRoles: async plan => explicitRoles(plan), onProgress: e => {
      progress.push({ ...e });
      if (e.phase === 'verified') proofs.push({ domain: e.domain, confirmed: domainConfirmed(e.domain) });
    }, ...extra.options };
  const promise = api.importSiteBundleSetToMaintenance(options);
  return { output, w, progress, plans, proofs, promise };
}
function explain(error) {
  return { name: error.name, domain: error.domain, phase: error.phase, jobId: error.jobId,
    verifiedDomains: error.verifiedDomains, cleanupRequired: error.cleanupRequired,
    message: error.message, causes: error.originalErrors?.map(explain), sqlErrors: state.calls.filter(c => c.error).map(c => ({ rpc: c.name, error: c.error })) };
}
async function mustComplete(context, t) {
  try { return await context.promise; }
  catch (error) { t.diagnostic(JSON.stringify(explain(error))); throw error; }
}
async function seedSource() {
  await source.exec('BEGIN');
  try {
    await buildNewSite(source);
    await source.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,remarks,tags,is_pinned,is_verified)
      VALUES($1,'import_employee','IMPORT-001',extensions.crypt($2,extensions.gen_salt('bf',4)),$3,$4,ARRAY['vip','合成'],true,true)`,
    [I.employee, PASSWORDS.employee, NEW.branch, CANARY]);
    await source.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [I.employee]);
    await source.query('INSERT INTO public.dispatch_group_members(group_id,user_id,assigned_by) VALUES($1,$2,$3)', [NEW.groupA, I.employee, NEW.root]);
    await source.query("INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Import product',true)", [I.product]);
    // Persist historical final rows without replaying operational commission side effects.
    // The legacy commission audit trigger references old_order_status (absent in the replay).
    // Restore every original trigger mode before ANY exporter/importer runs.
    for (const [orderId, status, commission] of [[I.success, 'success', 10], [I.failure, 'failure', null]]) {
      await fixtureChange(source, 'public.orders', `INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status,commission_amount,commission_rate,created_at,processed_at)
        VALUES($1,$2,'import_employee',$3,100,$4,$5,$6,$7,0.1,$8,$8)`, [orderId, I.employee, I.product, 'SOURCE-ORDER-' + status, 'SOURCE-TX-' + status, status, commission, TIME]);
    }
    await fixtureChange(source, 'public.wallet_transactions', `INSERT INTO public.wallet_transactions(id,user_id,type,amount,balance_before,balance_after,reference_id,remarks,created_at)
      VALUES($1,$2,'commission',10,0,10,$3,'synthetic historical commission',$4)`, [id(18), I.employee, I.success, TIME]);
    await fixtureChange(source, 'public.wallet_ledger_entries', `INSERT INTO public.wallet_ledger_entries(user_id,operation_id,source_type,source_id,event_type,available_delta,frozen_delta,income_delta,created_at)
      VALUES($1,$2,'wallet_transaction',$3,'commission',10,0,10,$5),($1,$4,'withdrawal',$6,'freeze',-3,3,0,$5)`,
    [I.employee, id(19), id(18), id(20), TIME, I.withdrawal]);
    await fixtureChange(source, 'public.withdrawals', "INSERT INTO public.withdrawals(id,user_id,amount,status,created_at) VALUES($1,$2,3,'pending',$3)", [I.withdrawal, I.employee, TIME]);
    await fixtureChange(source, 'public.users', 'UPDATE public.users SET total_income=10 WHERE id=$1', [I.employee]);
    await fixtureChange(source, 'public.wallets', 'UPDATE public.wallets SET available_balance=7,frozen_balance=3 WHERE user_id=$1', [I.employee]);
    await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by,usage_count)
      VALUES($1,100,'IMPORT-VALID',$2,0)`, [I.valid, NEW.root]);
    await source.query('INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at) VALUES($1,$2,$3,$4,$5)', [I.used, I.employee, I.valid, I.success, TIME]);
    await source.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,created_by)
      SELECT $1,group_id,id,$2,$3 FROM public.dispatch_order_pools WHERE group_id=$4 AND is_base`, [I.groupOrder, CANARY, NEW.root, NEW.groupA]);
    await source.query(`INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,created_at,session_id,device_info)
      VALUES($1,$2,'import_employee','IMPORT-001','login',$3,'old-session-not-live','{"os":"synthetic"}')`, [I.login, I.employee, TIME]);
    await source.query(`INSERT INTO public.work_sessions(id,user_id,start_time,end_time,duration_minutes,last_heartbeat_at)
      VALUES($1,$2,'2024-02-29T03:00:00Z','2024-02-29T04:00:00Z',60,'2024-02-29T04:00:00Z')`, [I.work, I.employee]);
    await source.query(`INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status,audited_by,audited_at)
      VALUES($1,$2,'合成人名','SYNTHETIC-ID','000-synthetic','合成地址','approved',$3,$4)`, [I.verification, I.employee, NEW.root, TIME]);
    await source.query(`INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority,notification_category,audit_origin,delivery_mode)
      VALUES($1,$2,'root','Synthetic notice',$3,'realtime','normal','standard','manual_admin','realtime_only')`, [I.message, NEW.root, CANARY]);
    await source.query('INSERT INTO public.message_recipients(message_id,recipient_id,is_read,read_at) VALUES($1,$2,true,$3)', [I.message, I.employee, TIME]);
    await source.query(`INSERT INTO public.simulated_customers(id,admin_id,customer_name,customer_id,source_type,target_employee_ids,customer_avatar)
      VALUES($1,$2,'Import role','IMPORT-CUSTOMER','aaa_service',NULL,'customer-avatar:regular:1')`, [I.customer, NEW.root]);
    await source.query(`INSERT INTO public.customer_employee_conversations(id,customer_id,employee_id,sender_type,message_content,message_type,source_type)
      VALUES($1,$2,$3,'customer',$4,'text','aaa_service')`, [I.chat, I.customer, I.employee, CANARY]);
    await source.query(`INSERT INTO private.content_audit_events(id,operation_id,entity_type,entity_id,action,owner_admin_id,actor_admin_id,
      actor_username,actor_role,before_data,after_data,media_refs,occurred_at)
      VALUES($1,$2,'notification',$3,'edit',$4,$4,'root','super_admin',NULL,'null','{}',$5)`, [I.audit, I.operation, I.message, NEW.root, TIME]);
    await source.query(`INSERT INTO private.deleted_employee_accounts(id,operation_id,employee_id,account_username,employee_number,
      owner_admin_id,actor_admin_id,actor_username,actor_role,deletion_source,deleted_at,account_remarks)
      VALUES($1,$2,$3,'synthetic-deleted','DELETED-001',$4,$4,'root','super_admin','employee_delete',$5,$6)`,
    [I.archive, I.operation, id(999), NEW.root, TIME, CANARY]);
    await source.query(`INSERT INTO public.system_configs(key,value) VALUES('announcement_carousel_enabled','true'),('announcement_carousel_speed','4')
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
    await source.exec('COMMIT');
  } catch (e) { await source.exec('ROLLBACK'); throw e; }
}
async function seedTarget() {
  await target.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await target.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    VALUES($1,'root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [I.targetRoot, PASSWORDS.root]);
  await target.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [I.targetRoot]);
  await target.query("INSERT INTO public.dispatch_groups(id,group_name,created_by) VALUES($1,'Empty target group',$2)", [I.targetGroup, I.targetRoot]);
  await target.query(`INSERT INTO public.announcements(id,title,content,created_by) VALUES($1,'TARGET ONLY NOTICE','TARGET ONLY CONTENT',$2)`, [I.targetNotice, I.targetRoot]);
  await target.query(`INSERT INTO public.system_configs(key,value) VALUES('announcement_carousel_enabled','false'),('announcement_carousel_speed','37')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
}
before(async () => {
  replay = await createSites({ upTo: LAST }); source = replay.oldSite; target = replay.newSite;
  assertExpectedReplayFailures(replay, { upTo: LAST });
  await seedSource(); await seedTarget();
  sourceSession = await adminLogin(source, 'root', PASSWORDS.root); targetSession = await adminLogin(target, 'root', PASSWORDS.root);
  sourceId = await scalar(source, 'SELECT site_id FROM private.employee_transfer_site');
  targetId = await scalar(target, 'SELECT site_id FROM private.employee_transfer_site'); assert.notEqual(sourceId, targetId);
  setA = await isolated(source, sourceSession, exportSet);
  setB = await isolated(source, sourceSession, exportSet);
}, { timeout: 300000 });
after(async () => {
  await source?.close(); await target?.close();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  const foreign = edge.foreign.slice(); mock.restoreAll(); assert.deepEqual(foreign, []);
});
test('strict latest 43–55 replay and real adapters; no importer/driver/SQL receipt mocks', t => {
  assert.equal(replay.files.length, 582);
  assert.deepEqual(replay.files.slice(-13), ['20261102000043_preserve_transfer_announcements.sql',
    '20261102000044_preflight_site_restore.sql', '20261102000045_verify_site_prerequisites.sql',
    '20261102000046_backup_employee_before_restore.sql', '20261102000047_backup_employee_media.sql',
    '20261102000048_reserve_employee_identities.sql', '20261102000049_restore_mapped_employee_identities.sql',
    '20261102000050_restore_mapped_dispatch_dependencies.sql', '20261102000051_restore_mapped_employee_finance.sql',
    '20261102000052_restore_mapped_employee_activity.sql', '20261102000053_restore_mapped_employee_verification.sql',
    '20261102000054_prepare_mapped_notifications.sql', LAST]);
  assert.equal(replay.failures.length, 12);
  const paths = Object.keys(compiled.metafile.inputs);
  for (const module of ['siteTransfer', 'siteImport', 'siteRestoreApi', 'siteExportApi', 'identityApi', 'financeApi', 'chatMergeApi', 'archiveBundle', 'crypto'])
    assert.ok(paths.some(p => p.endsWith(`/employeeTransfer/${module}.ts`)), module);
  assert.equal(paths.some(p => /src\/lib\/(?:auth|supabase)\.ts$|node_modules\/@supabase\//.test(p)), false);
  t.diagnostic(`${replay.files.length} real SQL files; exactly 12 historical failures; no clean-build/native-PG claim`);
});
async function targetExcluded() {
  return { announcements: await rows(target, 'SELECT to_jsonb(t)::text AS body FROM public.announcements t ORDER BY id'),
    carousel: await rows(target, "SELECT to_jsonb(t)::text AS body FROM public.system_configs t WHERE key LIKE 'announcement_carousel_%' ORDER BY key") };
}
async function assertMaintenance(result) {
  const m = (await rows(target, 'SELECT * FROM private.employee_transfer_maintenance'))[0];
  assert.equal(m.job_id, result.jobId); assert.equal(m.dirty, true);
  assert.equal(await scalar(target, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [result.jobId]), 'running');
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.users WHERE is_active IS DISTINCT FROM false'), 0);
  assert.equal(await scalar(target, "SELECT count(*)::int FROM public.admins WHERE role<>'super_admin' AND is_active IS DISTINCT FROM false"), 0);
  assert.equal(await scalar(target, 'SELECT is_active FROM public.admins WHERE id=$1', [I.targetRoot]), true);
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.users WHERE current_session_token IS NOT NULL OR current_tab_id IS NOT NULL'), 0);
  assert.equal(await scalar(target, 'SELECT password_hash=extensions.crypt($2,password_hash) FROM public.financial_admin_credentials WHERE admin_id=$1', [I.targetRoot, PASSWORDS.root]), true);
  await target.exec('SAVEPOINT maintenance_probe');
  try {
    await assert.rejects(target.query("UPDATE public.users SET remarks='forbidden ordinary write' WHERE id=$1", [I.employee]), /Business writes are paused for employee transfer maintenance/);
  } finally { await target.exec('ROLLBACK TO SAVEPOINT maintenance_probe; RELEASE SAVEPOINT maintenance_probe'); }
}
async function assertBackups(context) {
  assert.deepEqual([...context.output.outputs.keys()], BACKUPS);
  for (const f of context.output.outputs.values()) {
    assert.equal(f.writes, 1); assert.ok(f.opens >= 2); assert.ok((await stat(f.path)).size > 0);
    const metadata = await api.readTransferMetadata(disk(f.path)), sink = workspaces();
    await api.verifyEncryptedVolume(disk(f.path), PASS, sink.create(), { expectedMetadata: metadata });
    for (const s of sink.spaces) await s.abort(); allDead(sink);
    assert.equal((await readFile(f.path)).includes(Buffer.from(CANARY)), false);
  }
  const persisted = [];
  for (const table of ['shared', 'notification', 'chat']) {
    persisted.push(...await rows(target, `SELECT sealed_sha256,byte_count,
      encode(extensions.digest(COALESCE((SELECT string_agg(u.raw,''::bytea ORDER BY u.n)
        FROM unnest(b.chunks) WITH ORDINALITY AS u(raw,n)),''::bytea),'sha256'),'hex') AS actual_sha
      FROM private.employee_transfer_${table}_backups b WHERE sealed_at IS NOT NULL`));
  }
  const diskReceipts = await Promise.all([...context.output.outputs.values()].map(async f => {
    const raw = await readFile(f.path); return { sealed_sha256: sha(raw), byte_count: raw.length, actual_sha: sha(raw) };
  }));
  const order = list => list.sort((a, b) => a.sealed_sha256.localeCompare(b.sealed_sha256));
  assert.deepEqual(order(persisted), order(diskReceipts), 'five disk files equal the actual sealed server ciphertext chunks');
  const seals = state.calls.filter(c => /backup_seal$/.test(c.name));
  assert.equal(seals.length, 5); assert.ok(seals.every(c => c.result?.success === true && !c.error));
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE sealed_at IS NOT NULL'), 3);
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.employee_transfer_notification_backups WHERE sealed_at IS NOT NULL'), 1);
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.employee_transfer_chat_backups WHERE sealed_at IS NOT NULL'), 1);
}
function domainConfirmed(domain) {
  const rpc = { shared: 'employee_import_shared_replace_apply', products: 'employee_import_products_apply', dispatch: 'employee_import_dispatch_dependency_verify',
    identity: 'employee_import_identity_verify', finance: 'employee_import_finance_verify', activity: 'employee_import_activity_verify',
    verification: 'employee_import_verification_verify', notifications: 'employee_import_notifications_verify', chat: 'employee_import_chat_verify', archives: 'employee_import_archives_verify' }[domain];
  const checked = callsOf(rpc).some(c => !c.error && (c.result?.verified === true
    || domain === 'archives' && c.result?.records_verified === true
    || ['shared', 'products'].includes(domain) && c.result?.success === true));
  return checked && (domain !== 'archives' || callsOf('employee_transfer_archive_media_verify').some(c => !c.error && c.result?.verified === true));
}
function assertProgress(context) {
  for (const event of context.progress) assert.deepEqual(Object.keys(event).sort(),
    ['domain', 'phase', 'completedDomains', 'totalDomains', 'rows', 'files', 'bytes'].sort());
  const text = JSON.stringify(context.progress);
  for (const secret of [PASS, CANARY, ...Object.values(PASSWORDS), sourceSession, targetSession, 'import_employee', 'SYNTHETIC-ID']) assert.equal(text.includes(secret), false);
  for (const proof of context.proofs) assert.equal(proof.confirmed, true, `${proof.domain}: real SQL verification must PRECEDE verified progress`);
}
async function assertBusiness() {
  const employee = (await rows(target, 'SELECT username,remarks,tags,is_pinned,is_verified,password_hash=extensions.crypt($2,password_hash) AS password_ok FROM public.users WHERE id=$1', [I.employee, PASSWORDS.employee]))[0];
  assert.deepEqual(employee, { username: 'import_employee', remarks: CANARY, tags: ['vip', '合成'], is_pinned: true, is_verified: true, password_ok: true });
  assert.deepEqual(await rows(target, 'SELECT status,count(*)::int AS n,sum(commission_amount)::text AS commission FROM public.orders WHERE user_id=$1 GROUP BY status ORDER BY status', [I.employee]),
    await rows(source, 'SELECT status,count(*)::int AS n,sum(commission_amount)::text AS commission FROM public.orders WHERE user_id=$1 GROUP BY status ORDER BY status', [I.employee]));
  assert.deepEqual(await rows(target, 'SELECT available_balance::text,frozen_balance::text FROM public.wallets WHERE user_id=$1', [I.employee]), await rows(source, 'SELECT available_balance::text,frozen_balance::text FROM public.wallets WHERE user_id=$1', [I.employee]));
  assert.equal(await scalar(target, "SELECT amount::text FROM public.withdrawals WHERE id=$1 AND status='pending'", [I.withdrawal]),
    await scalar(source, "SELECT amount::text FROM public.withdrawals WHERE id=$1 AND status='pending'", [I.withdrawal]));
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.used_order_data WHERE user_id=$1', [I.employee]), 1);
  assert.equal(await scalar(target, 'SELECT usage_count FROM public.valid_order_data WHERE id=$1', [I.valid]), await scalar(source, 'SELECT usage_count FROM public.valid_order_data WHERE id=$1', [I.valid]));
  for (const [table, key] of [['employee_login_history', I.login], ['work_sessions', I.work], ['verification_requests', I.verification], ['messages', I.message], ['customer_employee_conversations', I.chat]])
    assert.equal(await scalar(target, `SELECT count(*)::int FROM public.${table} WHERE id=$1`, [key]), 1, table);
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.dispatch_group_members WHERE user_id=$1', [I.employee]), 1);
  for (const functionName of ['get_daily_order_stats', 'get_user_completed_orders_count']) {
    assert.deepEqual(await rows(target, `SELECT * FROM public.${functionName}($1)`, [I.employee]),
      await rows(source, `SELECT * FROM public.${functionName}($1)`, [I.employee]), `${functionName}: real success/failure/commission statistics`);
  }
  assert.equal(await scalar(target, `SELECT body->>'account_remarks' FROM private.employee_transfer_archive_records
    WHERE source_site_id=$1 AND table_key='deleted_employee_accounts' AND source_id=$2`, [sourceId, I.archive]), CANARY);
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.users WHERE id=$1', [id(999)]), 0, 'read-only archives never create active employees');
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.content_audit_events WHERE id=$1', [I.audit]), 0, 'native evidence remains in independent source namespace');
}
test('real SQL ten-domain export -> 11 disk .edx -> empty distinct target import: all ten verified, five sealed backups, dirty maintenance (NO release)', { timeout: 300000 }, async t => isolated(target, targetSession, async () => {
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.users'), 0);
  const before = await targetExcluded(), modes = await triggers(target), context = startImport();
  const result = await mustComplete(context, t);
  assert.deepEqual(result.verifiedDomains, DOMAINS); assert.equal(result.maintenance, true);
  assert.equal(result.fullSiteComplete, false); assert.equal(result.importReady, false);
  await assertMaintenance(result); await assertBackups(context); await assertBusiness();
  assert.deepEqual(result.serverVerification.verified_domains, DOMAINS);
  assert.deepEqual(result.serverVerification.counts, { employees: 1, pending_withdrawals: 1, pending_withdrawal_amount: '3' });
  assert.equal(callsOf('employee_import_site_verify').length, 1);
  assert.match(result.serverVerification.verification_hash, /^[a-f0-9]{64}$/);
  assert.equal(callsOf('employee_import_site_verify_prerequisites').length, 2);
  assert.ok(callsOf('employee_import_site_verify_prerequisites').every(call => !call.error && call.result.verified));
  assert.deepEqual(await targetExcluded(), before); assert.deepEqual(await triggers(target), modes);
  assertProgress(context); allDead(context.w); assert.equal(context.progress.at(-1).phase, 'maintenance');
  assert.equal(names().includes('employee_import_finish'), false); assert.equal(names().includes('employee_transfer_leave_maintenance'), false);
}));

test('wrong confirmation makes ZERO RPC; wrong passphrase / tampered LAST domain / missing / mixed package reject before first write', { timeout: 180000 }, async () => isolated(target, targetSession, async () => {
  let c = startImport({ options: { confirmation: '確認導入' } }); await assert.rejects(c.promise); assert.equal(state.calls.length, 0);
  const last = Buffer.from(setA.find(f => f.name === '10-archives.edx').raw); last[last.length - 1] ^= 1;
  const cases = [
    { passphrase: PASS + '-wrong' },
    { files: fileList(setA.map(f => f.name === '10-archives.edx' ? { ...f, raw: last } : f)) },
    { files: fileList(setA.filter(f => f.name !== '09-chat.edx')) },
    { files: fileList(setA.map(f => f.name === '10-archives.edx' ? setB.find(x => x.name === f.name) : f)) },
  ];
  for (const options of cases) {
    c = startImport({ options }); await assert.rejects(c.promise); assert.equal(state.calls.length, 0); assert.equal(c.output.outputs.size, 0); allDead(c.w);
  }
}));
test('authenticated owner inspects ALL eleven files with zero RPC, then reauthenticates each domain and rejects use after cleanup', { timeout: 120000 }, async () => {
  state.calls = [];
  const counts = new Map();
  const files = setA.map(({ name, raw }) => {
    const f = new File([raw], name), original = f.slice.bind(f);
    f.slice = (...args) => { counts.set(name, (counts.get(name) ?? 0) + 1); return original(...args); };
    return f;
  });
  const w = workspaces(); let retained;
  await api.withAuthenticatedSiteBundleSet(files, PASS, w.create, async bundle => {
    retained = bundle;
    assert.equal(state.calls.length, 0); assert.equal(counts.size, 11, 'all inputs read before callback admission');
    for (const [i, domain] of DOMAINS.entries()) {
      const name = FILENAMES[i], before = counts.get(name);
      await bundle.readDomain(domain, async input => { assert.equal(input.manifest.sourceSiteId, sourceId); });
      assert.ok(counts.get(name) > before, `${domain}: actual ciphertext reopened and authenticated`);
    }
  });
  await assert.rejects(retained.readDomain('shared', async () => assert.fail('expired bundle consumer')));
  allDead(w); assert.equal(state.calls.length, 0);
});
test('input changed AFTER whole-set inspection fails domain reauthentication before consumer or SQL', { timeout: 120000 }, async () => {
  state.calls = [];
  let changed = false, consumed = false;
  const selected = setA.map(({ name, raw }) => {
    const f = new File([raw], name);
    if (name === '10-archives.edx') f.slice = (...args) => {
      const bytes = Buffer.from(raw); if (changed) bytes[bytes.length - 1] ^= 1;
      return new Blob([bytes]).slice(...args);
    };
    return f;
  });
  const w = workspaces();
  await assert.rejects(api.withAuthenticatedSiteBundleSet(selected, PASS, w.create, async bundle => {
    changed = true;
    await bundle.readDomain('archives', async () => { consumed = true; });
  }));
  assert.equal(consumed, false); assert.equal(state.calls.length, 0); allDead(w);
});
async function insertJob(status = 'running') {
  const job = { id: randomUUID(), token: randomUUID() };
  await target.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status)
    VALUES($1,'import',$2,'root',private.hash_financial_token($3),$4)`, [job.id, I.targetRoot, job.token, status]);
  return job;
}
for (const condition of ['same site', 'target business', 'active maintenance', 'active task', 'missing interface']) {
  test(`${condition} refused before ANY shared write`, { timeout: 120000 }, async () => isolated(target, targetSession, async () => {
    if (condition === 'same site') await target.query('UPDATE private.employee_transfer_site SET site_id=$1', [sourceId]);
    if (condition === 'target business') {
      await target.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,total_income)
        VALUES($1,'existing_business','TARGET-BUSINESS',extensions.crypt($2,extensions.gen_salt('bf',4)),$3,1)`, [id(201), PASSWORDS.employee, I.targetRoot]);
    }
    if (condition === 'active task') await insertJob();
    if (condition === 'active maintenance') {
      const j = await insertJob('cancelled');
      await target.query(`INSERT INTO private.employee_transfer_maintenance(job_id,admin_id,plan_hash,target_hash,entered_at,dirty)
        VALUES($1,$2,$3,$4,now(),true)`, [j.id, I.targetRoot, 'a'.repeat(64), 'b'.repeat(64)]);
    }
    if (condition === 'missing interface') await target.exec('ALTER FUNCTION public.employee_import_finance_apply(uuid,uuid,uuid,text) RENAME TO offline_missing_finance_apply');
    const c = startImport(); await assert.rejects(c.promise); assert.deepEqual(names(), ['get_employee_import_site_preflight']);
    assert.equal(c.output.outputs.size, 0); allDead(c.w);
  }));
}
for (const rejected of ['shared', 'products', 'dispatch', 'identity', 'finance', 'activity', 'verification', 'notifications', 'chat']) {
  test(`approvePlan rejects ${rejected}: no stage backup/apply; already-written stages are NOT undone`, { timeout: 240000 }, async t => isolated(target, targetSession, async () => {
    const c = startImport({ options: { approvePlan: async domain => domain !== rejected } });
    await assert.rejects(c.promise, error => { if (error.domain !== rejected) t.diagnostic(JSON.stringify(explain(error))); assert.equal(error.domain, rejected); return true; });
    assert.equal(c.output.outputs.has(`backup-${rejected}.edx`), false);
    const backupPrepare = { shared: 'get_employee_import_shared_backup', products: 'get_employee_import_products_backup',
      dispatch: 'get_employee_import_dispatch_backup', notifications: 'employee_import_notification_backup_prepare', chat: 'employee_import_chat_backup_prepare' }[rejected];
    if (backupPrepare) assert.equal(callsOf(backupPrepare).length, 0, 'denial must precede the real backup freeze RPC');
    const prefix = { shared: 'employee_import_shared_replace_apply', products: 'employee_import_products_apply', dispatch: 'employee_import_dispatch_enter_maintenance',
      identity: 'employee_import_identity_begin', finance: 'employee_import_finance_apply', activity: 'employee_import_activity_apply',
      verification: 'employee_import_verification_apply', notifications: 'employee_import_notifications_begin', chat: 'employee_import_chat_begin' }[rejected];
    assert.equal(callsOf(prefix).length, 0); allDead(c.w); assertProgress(c);
  }));
}
test('approvePlan rejecting archives must prevent archive begin/chunk/verify (no implicit approval)', { timeout: 240000 }, async t => isolated(target, targetSession, async () => {
  const approved = [];
  const c = startImport({ options: { approvePlan: async domain => { approved.push(domain); return domain !== 'archives'; } } });
  const outcome = c.promise.then(result => {
    t.diagnostic(JSON.stringify({ approvedDomains: approved, archiveApprovalRequested: approved.includes('archives'),
      actualArchiveWrites: state.calls.filter(c => /^employee_import_archives_(begin|chunk|verify)$/.test(c.name)).map(c => ({ rpc: c.name, recordsVerified: c.result?.records_verified })),
      returnedVerifiedDomains: result.verifiedDomains }));
    return result;
  });
  await assert.rejects(outcome, error => { assert.equal(error.domain, 'archives'); return true; }, 'archive restore must not execute without plan approval');
  assert.equal(callsOf('employee_import_archives_begin').length, 0);
  assert.equal(callsOf('employee_import_archives_chunk').length, 0); allDead(c.w);
}));
test('same-name employee conflict never archives/deletes/enables the target employee', { timeout: 240000 }, async t => isolated(target, targetSession, async () => {
  await target.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,is_active,remarks)
    VALUES($1,'import_employee','TARGET-CONFLICT',extensions.crypt($2,extensions.gen_salt('bf',4)),$3,false,'TARGET MUST SURVIVE')`, [id(301), PASSWORDS.employee, I.targetRoot]);
  const c = startImport();
  await assert.rejects(c.promise, error => { if (error.domain !== 'identity') t.diagnostic(JSON.stringify(explain(error))); assert.equal(error.domain, 'identity'); return true; });
  assert.equal(await scalar(target, 'SELECT remarks FROM public.users WHERE id=$1', [id(301)]), 'TARGET MUST SURVIVE');
  assert.equal(await scalar(target, 'SELECT is_active FROM public.users WHERE id=$1', [id(301)]), false);
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.deleted_employee_accounts'), 0);
  assert.equal(callsOf('employee_import_identity_begin').length, 0); assert.equal(callsOf('employee_import_finance_bind').length, 0);
  assert.equal(names().some(n => /delete|archive_employee|enable|leave_maintenance/.test(n)), false); allDead(c.w);
}));
test('lost actual configuration-apply response: ONE SQL write, retains real task/backup/dirty maintenance, no later domains', { timeout: 240000 }, async t => isolated(target, targetSession, async () => {
  state.afterSql = async (call, actual) => call.name === 'employee_import_dispatch_apply_configuration' && !actual.error
    ? { data: null, error: { message: 'Synthetic lost HTTP response after SQL committed its statement' } } : actual;
  const c = startImport();
  await assert.rejects(c.promise, error => { if (error.phase !== 'configuration-apply') t.diagnostic(JSON.stringify(explain(error))); assert.equal(error.phase, 'configuration-apply'); return true; });
  assert.equal(callsOf('employee_import_dispatch_apply_configuration').length, 1);
  assert.equal(callsOf('employee_import_dispatch_apply_configuration')[0].error, null);
  for (const name of ['employee_import_dispatch_valid_begin', 'employee_import_identity_bind', 'employee_import_finance_bind',
    'employee_import_activity_bind', 'employee_import_verification_bind', 'employee_import_notifications_bind', 'employee_import_chat_bind', 'employee_import_archives_bind'])
    assert.equal(callsOf(name).length, 0, `${name}: no later SQL after unknown write outcome`);
  assert.equal(callsOf('employee_transfer_cancel').length, 1, 'only the deliberately closed shared stage was cancelled; dirty task remains');
  const m = (await rows(target, 'SELECT job_id,dirty FROM private.employee_transfer_maintenance'))[0]; assert.equal(m.dirty, true);
  assert.equal(await scalar(target, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [m.job_id]), 'running');
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE sealed_at IS NOT NULL'), 3);
  assert.deepEqual([...c.output.outputs.keys()], BACKUPS.slice(0, 3)); assertProgress(c); allDead(c.w);
}));
for (const changed of ['shared setting', 'administrator activation', 'mapped product']) {
  test(`maintenance admission rechecks actual ${changed} drift before dispatch configuration writes`, { timeout: 180000 }, async () => isolated(target, targetSession, async () => {
    let mutated = false;
    const c = startImport({ options: { approvePlan: async domain => {
      if (domain === 'dispatch' && !mutated) {
        mutated = true;
        if (changed === 'shared setting') await target.query("INSERT INTO public.system_configs(key,value) VALUES('login_title','\"CHANGED AFTER SHARED APPLY\"'::jsonb) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
        if (changed === 'administrator activation') await target.query("UPDATE public.admins SET is_active=true WHERE username='branch'");
        if (changed === 'mapped product') await target.query("UPDATE public.product_types SET sort_order=sort_order+1 WHERE name='Import product'");
      }
      return true;
    } } });
    await assert.rejects(c.promise, error => {
      assert.equal(error.phase, changed === 'administrator activation' ? 'backup-seal' : 'verify-prerequisites');
      return true;
    });
    assert.equal(mutated, true);
    if (changed === 'administrator activation') {
      assert.equal(callsOf('employee_import_site_verify_prerequisites').length, 0);
      assert.ok(state.calls.some(call => call.error && /changed|drift|mismatch/i.test(call.error)));
    } else {
      assert.equal(callsOf('employee_import_site_verify_prerequisites').length, 1);
      assert.match(callsOf('employee_import_site_verify_prerequisites')[0].error, /checkpoint drift/);
    }
    assert.equal(callsOf('employee_import_dispatch_apply_configuration').length, 0);
    assert.equal(callsOf('employee_import_identity_bind').length, 0);
    assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.employee_transfer_maintenance'), changed === 'administrator activation' ? 0 : 1);
    allDead(c.w);
  }));
}
test('mutating plan callback cannot alter the server-authorized hash or counts', { timeout: 300000 }, async t => isolated(target, targetSession, async () => {
  const originals = [];
  const c = startImport({ options: { approvePlan: async (domain, plan) => {
    originals.push({ domain, hash: plan.plan_hash }); plan.plan_hash = '0'.repeat(64); plan.conflicts = ['forged'];
    if (plan.counts) for (const key of Object.keys(plan.counts)) plan.counts[key] = 999;
    return true;
  } } });
  const result = await mustComplete(c, t); assert.deepEqual(result.verifiedDomains, DOMAINS);
  for (const call of state.calls.filter(c => c.args.p_plan_hash)) assert.notEqual(call.args.p_plan_hash, '0'.repeat(64));
  assert.ok(originals.length >= 10); assertProgress(c); allDead(c.w);
}));
test('cleanup failure cannot report successful import or advance later domains', { timeout: 180000 }, async t => isolated(target, targetSession, async () => {
  const w = workspaces({ failCleanup: () => callsOf('employee_import_shared_replace_apply').length > 0 });
  const c = startImport({ w });
  await assert.rejects(c.promise, error => { t.diagnostic(JSON.stringify(explain(error))); assert.match(error.message, /cleanup|Temporary plaintext/); return true; });
  assert.equal(callsOf('employee_import_products_begin').length, 0);
  assert.equal(c.progress.some(p => p.phase === 'maintenance'), false); allDead(w);
}));

test('SQL55 admission requires the total verifier before any shared write and keeps the private wrapper uncallable', { timeout: 120000 }, async () => isolated(target, targetSession, async () => {
  const preflight = await execAs('anon', 'get_employee_import_site_preflight', { p_admin_session_token: targetSession, p_source_site_id: sourceId });
  assert.equal(preflight.error, null); assert.equal(preflight.data.protocol, 'site-maintenance-restore-v3');
  assert.equal(preflight.data.can_restore_to_maintenance, true);
  const definition = await scalar(target, "SELECT pg_get_functiondef('public.employee_import_site_verify(uuid,uuid)'::regprocedure)");
  assert.match(definition, /FOR UPDATE NOWAIT/);
  assert.match(definition, /ACCESS EXCLUSIVE MODE NOWAIT/);
  assert.equal((definition.match(/pg_try_advisory_xact_lock/g) ?? []).length, 2);
  assert.ok(definition.indexOf("pg_try_advisory_xact_lock(hashtextextended('notification_automation_queue'") < definition.indexOf('ACCESS EXCLUSIVE MODE NOWAIT'));
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await scalar(target, "SELECT has_function_privilege($1,'private.employee_transfer_site_preflight_v2(uuid,uuid)','execute')", [role]), false);
  }
  await target.exec('ALTER FUNCTION public.employee_import_site_verify(uuid,uuid) RENAME TO unavailable_site_verify');
  const c = startImport(); await assert.rejects(c.promise);
  assert.deepEqual(names(), ['get_employee_import_site_preflight']);
  assert.deepEqual(callsOf('get_employee_import_site_preflight')[0].result.missing_rpcs, ['public.employee_import_site_verify(uuid,uuid)']);
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.employee_transfer_jobs'), 0);
  allDead(c.w);
}));

for (const mode of ['lost response', 'wrong task binding']) test(`site-wide verifier ${mode}: no retry or completion despite actual server verification`, { timeout: 300000 }, async t => isolated(target, targetSession, async () => {
  state.afterSql = (call, actual) => {
    if (call.name === 'employee_import_site_verify' && !actual.error) {
      return mode === 'lost response' ? { data: null, error: { message: 'Synthetic response loss after commit' } }
        : { data: { ...actual.data, job_id: id(994) }, error: null };
    }
  };
  const c = startImport();
  await assert.rejects(c.promise, error => {
    t.diagnostic(JSON.stringify(explain(error)));
    assert.equal(error.domain, 'site'); assert.equal(error.phase, 'verify-site'); return true;
  });
  const call = callsOf('employee_import_site_verify')[0];
  assert.equal(callsOf('employee_import_site_verify').length, 1);
  assert.equal(call.result.success, true, 'the SQL really ran before the transport outcome changed');
  assert.equal(c.progress.some(value => value.phase === 'maintenance'), false);
  assert.deepEqual(await scalar(target, "SELECT summary->'site_verification' FROM private.employee_transfer_jobs WHERE id=$1", [call.result.job_id]), call.result);
  await assertMaintenance({ jobId: call.result.job_id }); allDead(c.w);
}));

test('site-wide verifier rechecks actual restored contents, seals, media and permissions instead of accepting cached success', { timeout: 600000 }, async t => isolated(target, targetSession, async () => {
  const c = startImport(), result = await mustComplete(c, t);
  const token = callsOf('employee_import_site_verify')[0].args.p_job_token;
  const auth = { p_admin_session_token: targetSession, p_job_token: token };
  const check = (args = auth, role = 'anon') => execAs(role, 'employee_import_site_verify', args);
  const eventCount = () => scalar(target, "SELECT count(*)::int FROM private.employee_transfer_events WHERE job_id=$1 AND action='site_restore_verified'", [result.jobId]);
  await t.test('explicit repeat physically rechecks, returns the same binding and emits no duplicate success audit', async () => {
    const before = await eventCount(), actual = await check();
    assert.equal(actual.error, null); assert.deepEqual(actual.data, result.serverVerification);
    assert.equal(await eventCount(), before);
    assert.deepEqual(await scalar(target, 'SELECT summary->\'site_verification\' FROM private.employee_transfer_jobs WHERE id=$1', [result.jobId]), result.serverVerification);
  });
  const rejectMutation = async (name, sql, args = [], relation = null) => t.test(name, async () => {
    await target.exec('SAVEPOINT site_verify_corruption');
    const before = await eventCount();
    try {
      if (relation) {
        const modes = await rows(target, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
        for (const mode of modes) await target.exec(`ALTER TABLE ${relation} DISABLE TRIGGER ${quote(mode.tgname)}`);
        await target.query(sql, args);
        for (const mode of modes) await target.exec(`ALTER TABLE ${relation} ${mode.tgenabled === 'A' ? 'ENABLE ALWAYS' : mode.tgenabled === 'R' ? 'ENABLE REPLICA' : mode.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER ${quote(mode.tgname)}`);
      } else await target.query(sql, args);
      const response = await check();
      assert.ok(response.error, 'a historical verification must not authorize changed data');
      assert.equal(response.data, null); assert.equal(await eventCount(), before);
      assert.equal(await scalar(target, 'SELECT dirty FROM private.employee_transfer_maintenance WHERE job_id=$1', [result.jobId]), true);
    } finally { await target.exec('ROLLBACK TO SAVEPOINT site_verify_corruption; RELEASE SAVEPOINT site_verify_corruption'); }
  });
  for (const key of ['identity_restore', 'dependency_restore', 'finance_restore', 'activity_restore', 'verification_restore', 'notification_restore', 'chat_restore']) {
    await rejectMutation(`missing ${key} completion is not repaired by total verification`, 'UPDATE private.employee_transfer_jobs SET summary=summary #- $2::text[] WHERE id=$1', [result.jobId, [key, 'verified']]);
  }
  await rejectMutation('archive completion cannot be omitted', "UPDATE private.employee_transfer_jobs SET summary=summary #- '{archives_restore,records_verified}' WHERE id=$1", [result.jobId]);
  await rejectMutation('archive media verification cannot be omitted', "UPDATE private.employee_transfer_jobs SET summary=summary #- '{archives_media,verified}' WHERE id=$1", [result.jobId]);
  for (const [name, relation, sql, args] of [
    ['employee fields', 'public.users', "UPDATE public.users SET remarks='corrupted' WHERE id=$1", [I.employee]],
    ['order commission', 'public.orders', 'UPDATE public.orders SET commission_amount=11 WHERE id=$1', [I.success]],
    ['wallet balance', 'public.wallets', 'UPDATE public.wallets SET available_balance=8 WHERE user_id=$1', [I.employee]],
    ['pending withdrawal', 'public.withdrawals', 'UPDATE public.withdrawals SET amount=4 WHERE id=$1', [I.withdrawal]],
    ['work session', 'public.work_sessions', 'UPDATE public.work_sessions SET duration_minutes=61 WHERE id=$1', [I.work]],
    ['verification content', 'public.verification_requests', "UPDATE public.verification_requests SET real_name='changed' WHERE id=$1", [I.verification]],
    ['notification content', 'public.messages', "UPDATE public.messages SET title='changed' WHERE id=$1", [I.message]],
    ['chat content', 'public.customer_employee_conversations', "UPDATE public.customer_employee_conversations SET message_content='changed' WHERE id=$1", [I.chat]],
    ['product checkpoint', 'public.product_types', "UPDATE public.product_types SET name='changed' WHERE name='Import product'", []],
  ]) await rejectMutation(`late ${name} drift is rejected despite all verified flags`, sql, args, relation);
  await rejectMutation('archive raw bytes cannot drift behind a cached namespace hash', "UPDATE private.employee_transfer_archive_records SET source_line=source_line||' ' WHERE source_site_id=$1 AND source_id=$2", [sourceId, I.archive], 'private.employee_transfer_archive_records');
  await rejectMutation('sealed backup ciphertext cannot change', "UPDATE private.employee_transfer_notification_backups SET chunks=ARRAY[decode('00','hex')] WHERE job_id=$1", [result.jobId]);
  await rejectMutation('sealed backup cannot disappear', 'DELETE FROM private.employee_transfer_chat_backups WHERE job_id=$1', [result.jobId]);
  await rejectMutation('new-UUID preparation is not misreported as empty-site completion', `INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES($1,$2,'identity-reservation-v1',0,0,'{}')`, [result.jobId, I.employee]);
  for (const [name, args, role] of [
    ['wrong task token', { ...auth, p_job_token: id(997) }, 'anon'],
    ['employee/lookalike session', { ...auth, p_admin_session_token: id(998) }, 'anon'],
    ['service role has no public permission', auth, 'service_role'],
  ]) await t.test(name, async () => { const response = await check(args, role); assert.ok(response.error); assert.equal(response.data, null); });
  await rejectMutation('expired admin session is denied', "UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=private.hash_financial_token($1)", [targetSession]);
  await t.test('valid data still pass after all isolated corruptions; accounts and all financial totals remain unchanged', async () => {
    const actual = await check(); assert.equal(actual.error, null); assert.deepEqual(actual.data, result.serverVerification);
    await assertMaintenance(result); await assertBusiness(); assertProgress(c); allDead(c.w);
  });
}));

// Synthetic file branch: REAL Edge handler + REAL SQL service-only authorize/commit;
// fakeStorage is strictly in memory and never Supabase Storage acceptance.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const MEDIA = {
  verification: { bucket: 'verification-documents', path: `id-front/${I.employee}-front.png`, raw: Buffer.concat([PNG, Buffer.from('synthetic-id')]) },
  notification: { bucket: 'announcement-images', path: 'offline/notice.png', raw: Buffer.concat([PNG, Buffer.from('synthetic-notice')]) },
  avatar: { bucket: 'super-customer-avatars', path: 'avatars/offline-avatar.png', raw: Buffer.concat([PNG, Buffer.from('synthetic-avatar')]) },
  chat: { bucket: 'chat-images', path: 'offline/photo.png', raw: Buffer.concat([PNG, Buffer.from('synthetic-chat')]) },
};
const mediaUrl = o => `${ORIGIN}/storage/v1/object/public/${o.bucket}/${o.path}`;
function startEdge() {
  edge.handler = edgeModule.createEmployeeTransferMediaHandler({ supabaseUrl: ORIGIN,
    store: { async download(bucket, path) {
      const raw = edge.objects.get(`${bucket}/${path}`);
      return raw ? { data: new Response(raw, { headers: { 'content-length': String(raw.length) } }), error: null } : { data: null, error: 'missing' };
    }, async upload(bucket, path, raw, options) {
      assert.equal(options.upsert, false); const key = `${bucket}/${path}`;
      if (edge.objects.has(key)) return { data: null, error: 'exists' };
      const bytes = Buffer.from(raw instanceof Blob ? await raw.arrayBuffer() : raw);
      edge.objects.set(key, bytes); edge.uploads.push({ bucket, path, sha256: sha(bytes) }); return { data: { path }, error: null };
    } }, rpc: (name, args) => {
      const result = queue.then(async () => {
        const value = await execAs('service_role', name, args);
        if (value.error) edge.rpcErrors.push({ rpc: name, error: value.error.message });
        return value;
      }); queue = result.catch(() => undefined); return result;
    } });
}
test('synthetic verification/notification/chat media: disk set -> real handler/SQL import -> verified rewritten links and byte hashes', { timeout: 300000 }, async t => {
  await source.exec('BEGIN');
  try {
    const modes = await triggers(source);
    await fixtureChange(source, 'public.verification_requests', 'UPDATE public.verification_requests SET id_front_url=$2 WHERE id=$1', [I.verification, mediaUrl(MEDIA.verification)]);
    await fixtureChange(source, 'public.messages', 'UPDATE public.messages SET content=$2 WHERE id=$1', [I.message, `<p>${CANARY}</p><img src="${mediaUrl(MEDIA.notification)}">`]);
    await fixtureChange(source, 'public.simulated_customers', 'UPDATE public.simulated_customers SET custom_avatar_url=$2 WHERE id=$1', [I.customer, mediaUrl(MEDIA.avatar)]);
    await fixtureChange(source, 'public.customer_employee_conversations', 'UPDATE public.customer_employee_conversations SET image_url=$2 WHERE id=$1', [I.chat, mediaUrl(MEDIA.chat)]);
    assert.deepEqual(await triggers(source), modes);
    await source.exec('COMMIT');
  } catch (e) { await source.exec('ROLLBACK'); throw e; }
  for (const o of Object.values(MEDIA)) edge.objects.set(`${o.bucket}/${o.path}`, o.raw);
  await isolated(source, sourceSession, async () => {
    startEdge();
    try { setMedia = await exportSet(); }
    catch (error) { t.diagnostic(error.message); throw error; }
  });
  await isolated(target, targetSession, async () => {
    startEdge(); const before = await targetExcluded(), modes = await triggers(target);
    const c = startImport({ options: { files: fileList(setMedia) } }), result = await mustComplete(c, t);
    assert.deepEqual(result.verifiedDomains, DOMAINS); await assertMaintenance(result); await assertBackups(c);
    assert.deepEqual(await targetExcluded(), before); assert.deepEqual(await triggers(target), modes);
    assert.equal(edge.uploads.length, 4);
    assert.deepEqual(edge.uploads.map(o => o.sha256).sort(), Object.values(MEDIA).map(o => sha(o.raw)).sort());
    const links = [await scalar(target, 'SELECT id_front_url FROM public.verification_requests WHERE id=$1', [I.verification]),
      await scalar(target, 'SELECT content FROM public.messages WHERE id=$1', [I.message]),
      await scalar(target, 'SELECT custom_avatar_url FROM public.simulated_customers WHERE id=$1', [I.customer]),
      await scalar(target, 'SELECT image_url FROM public.customer_employee_conversations WHERE id=$1', [I.chat])];
    for (const [i, o] of Object.values(MEDIA).entries()) {
      assert.equal(links[i].includes(mediaUrl(o)), false); assert.ok(links[i].includes('transfer-'));
    }
    assertProgress(c); allDead(c.w);
  });
});
