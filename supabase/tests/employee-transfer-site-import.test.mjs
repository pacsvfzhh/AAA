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
import { replayProductionTransferMigrations } from './support/production-transfer.mjs';

// LOCAL ONLY. Only the two foundations (auth/supabase) are replaced. The coordinator,
// ten export/import drivers, SQL, plans, backup seals and verification receipts are REAL.
// PGlite/platform substitutes are not native PostgreSQL/PostgREST acceptance. Ciphertexts
// are real disk files; temporary plaintext workspaces and Edge Storage are in memory.
// Source fixture trigger changes finish BEFORE import; no importer error is bypassed.
const root = fileURLToPath(new URL('../../', import.meta.url));
const LAST = '20261102000057_release_imported_site.sql';
const schemaProfile = process.env.EMPLOYEE_TRANSFER_SCHEMA_PROFILE;
if (schemaProfile !== undefined && !['production-columns', 'production-triggers'].includes(schemaProfile)) throw new Error('Unknown site-import schema profile');
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
  stdin: { contents: `export {exportSiteBundleSet, inspectSiteBundleSet, withAuthenticatedSiteBundleSet} from './src/lib/employeeTransfer/siteTransfer.ts';
    export {freezeSourceCutover, getSourceCutoverStatus} from './src/lib/employeeTransfer/sourceCutover.ts';
    export {importSiteBundleSetToMaintenance} from './src/lib/employeeTransfer/siteImport.ts';
    export {createSiteReleaseSession} from './src/lib/employeeTransfer/siteRelease.ts';
    export {readTransferMetadata} from './src/lib/employeeTransfer/crypto.ts';
    export {verifyEncryptedVolume, writeEncryptedVolume} from './src/lib/employeeTransfer/container.ts';
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
async function isolated(db, token, use, alreadyInTransaction = false) {
  active = db; session = token; inside = true; state.calls = []; state.afterSql = null;
  api.setHarness({ session, rpc: bridge });
  if (!alreadyInTransaction) await db.exec('BEGIN');
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
async function fixtureChange(db, relation, sql, args = [], completedImport = null) {
  if (inside) {
    assert.equal(db, target);
    assert.equal(completedImport?.maintenance, true, 'only an already-returned importer result permits a corruption fixture');
    assert.ok(callsOf('employee_import_site_verify').some(c => c.result?.job_id === completedImport.jobId && !c.error));
  } else assert.equal(completedImport, null);
  // With no completed result, keep the original pre-export/import-only fixture boundary.
  // Corruption fixtures restore every trigger BEFORE the RPC under test; never bypass a failed importer.
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
async function exportSet(checkResult = () => {}) {
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
  checkResult(result);
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
  replay = await createSites({ upTo: LAST }, schemaProfile ? {
    replay: options => replayProductionTransferMigrations({ ...options, triggerProfile: schemaProfile === 'production-triggers' }),
  } : {});
  source = replay.oldSite; target = replay.newSite;
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
test('strict latest 43–57 replay and real adapters; no importer/driver/SQL receipt mocks', t => {
  assert.equal(replay.files.length, 584);
  assert.deepEqual(replay.files.slice(-15), ['20261102000043_preserve_transfer_announcements.sql',
    '20261102000044_preflight_site_restore.sql', '20261102000045_verify_site_prerequisites.sql',
    '20261102000046_backup_employee_before_restore.sql', '20261102000047_backup_employee_media.sql',
    '20261102000048_reserve_employee_identities.sql', '20261102000049_restore_mapped_employee_identities.sql',
    '20261102000050_restore_mapped_dispatch_dependencies.sql', '20261102000051_restore_mapped_employee_finance.sql',
    '20261102000052_restore_mapped_employee_activity.sql', '20261102000053_restore_mapped_employee_verification.sql',
    '20261102000054_prepare_mapped_notifications.sql', '20261102000055_verify_site_restore.sql',
    '20261102000056_freeze_cutover_source.sql', LAST]);
  assert.equal(replay.failures.length, 12);
  const paths = Object.keys(compiled.metafile.inputs);
  for (const module of ['siteTransfer', 'sourceCutover', 'siteRelease', 'siteImport', 'siteRestoreApi', 'siteExportApi', 'identityApi', 'financeApi', 'chatMergeApi', 'archiveBundle', 'crypto'])
    assert.ok(paths.some(p => p.endsWith(`/employeeTransfer/${module}.ts`)), module);
  assert.equal(paths.some(p => /src\/lib\/(?:auth|supabase)\.ts$|node_modules\/@supabase\//.test(p)), false);
  t.diagnostic(`${replay.files.length} real SQL files; exactly 12 historical failures; ${schemaProfile ?? 'local-replay'}; no clean-build/native-PG claim`);
  if (schemaProfile) return Promise.all([source, target].map(async db => {
    assert.equal(await scalar(db, "SELECT to_regclass('public.notification_automation_date_runs')"), null);
    await scalar(db, 'SELECT private.employee_transfer_assert_maintenance_guards()');
  }));
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
  assert.equal(result.sourceCutover, null); assert.equal(result.releaseSession, null);
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

test('frozen golden: real source freeze -> 11 disk .edx -> authenticated cutoff -> empty target maintenance restore (NO resume/release)', { timeout: 300000 }, async t => {
  let frozenFiles, cutoff, packageId;
  await isolated(source, sourceSession, async () => {
    assert.equal(await scalar(source, 'SELECT count(*)::int FROM private.employee_transfer_maintenance'), 0);
    const modes = await triggers(source), pending = await scalar(source, 'SELECT count(*)::int FROM public.notification_automation_queue');
    assert.ok(pending > 0, 'fixture login/work triggers really queued automation');
    // Drain through the actual worker, not DELETE/TRUNCATE or a fabricated empty receipt.
    await scalar(source, 'SELECT public.process_notification_automation_queue_fast(100)');
    for (const table of ['notification_automation_queue', 'notification_automation_failures'])
      assert.equal(await scalar(source, `SELECT count(*)::int FROM public.${table}`), 0, table);
    assert.equal(await scalar(source, "SELECT count(*)::int FROM public.orders WHERE status='processing'"), 0);
    const frozen = await api.freezeSourceCutover(PASSWORDS.root, '確認暫停舊站業務並導出');
    assert.equal(frozen.success, true); assert.equal(frozen.frozen, true); assert.deepEqual(frozen.blockers, []);
    assert.deepEqual(frozen.counts, { pending_automation: 0, failed_automation: 0, processing_orders: 0 });
    assert.equal(frozen.full_site_complete, false); cutoff = structuredClone(frozen.cutoff);
    assert.equal(cutoff.site_id, sourceId);
    const stored = await scalar(source, "SELECT summary->'source_cutover' FROM private.employee_transfer_jobs WHERE id=$1 AND kind='export' AND status='finished'", [cutoff.cutoff_id]);
    assert.deepEqual(cutoff, stored);
    assert.equal(cutoff.cutoff_hash, await scalar(source, `SELECT encode(extensions.digest(convert_to(((summary->'source_cutover')-'cutoff_hash')::text,'UTF8'),'sha256'),'hex')
      FROM private.employee_transfer_jobs WHERE id=$1`, [cutoff.cutoff_id]), 'real PG jsonb digest, not JS JSON.stringify');
    const maintenance = await rows(source, 'SELECT to_jsonb(m)::text AS body FROM private.employee_transfer_maintenance m');
    assert.equal(await scalar(source, 'SELECT dirty FROM private.employee_transfer_maintenance'), false);
    frozenFiles = await exportSet(result => {
      assert.deepEqual(result.sourceCutover, cutoff); packageId = result.packageId;
    });
    assert.deepEqual(await rows(source, 'SELECT to_jsonb(m)::text AS body FROM private.employee_transfer_maintenance m'), maintenance,
      'all ten export closes preserve the original source freeze');
    assert.deepEqual(await api.getSourceCutoverStatus(), frozen);
    const snapshots = callsOf('get_employee_export_site_snapshot');
    assert.equal(snapshots.length, 2);
    for (const call of snapshots) { assert.equal(call.error, null); assert.deepEqual(call.result.source_cutover, cutoff); }
    const closes = state.calls.filter(call => /^employee_export_.*_close$|^employee_products_close$/.test(call.name));
    assert.equal(closes.length, 10); assert.ok(closes.every(call => !call.error && call.result.success === true));
    assert.equal(await scalar(source, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status='running'"), 0);
    assert.equal(names().some(name => /resume|leave_maintenance|employee_transfer_cancel/.test(name)), false);
    await source.exec('SAVEPOINT frozen_write_probe');
    try {
      await assert.rejects(source.query("UPDATE public.users SET remarks='must remain frozen' WHERE id=$1", [I.employee]),
        /Business writes are paused for employee transfer maintenance/);
    } finally { await source.exec('ROLLBACK TO SAVEPOINT frozen_write_probe; RELEASE SAVEPOINT frozen_write_probe'); }
    assert.deepEqual(await triggers(source), modes);
  });
  // isolated() rolls back ONLY this local test transaction; no resume RPC or fake restoration.
  assert.equal(await scalar(source, 'SELECT count(*)::int FROM private.employee_transfer_maintenance'), 0);
  state.calls = [];
  const w = workspaces(), files = fileList(frozenFiles);
  const inspected = await api.inspectSiteBundleSet(files, PASS, w.create);
  assert.equal(inspected.packageId, packageId); assert.deepEqual(inspected.sourceCutover, cutoff);
  inspected.sourceCutover.cutoff_hash = '0'.repeat(64);
  await api.withAuthenticatedSiteBundleSet(files, PASS, w.create, async bundle => {
    assert.equal(bundle.sourceSiteId, sourceId); assert.equal(bundle.packageId, packageId);
    assert.deepEqual(bundle.sourceCutover, cutoff);
    // Public return values are copies: changing one cannot rewrite the authenticated index.
    bundle.sourceCutover.cutoff_hash = 'f'.repeat(64); bundle.sourceCutover.frozen_at = '2000-01-01T00:00:00.000000Z';
    await bundle.readDomain('activity', async input => { assert.equal(input.manifest.sourceSiteId, cutoff.site_id); });
  });
  await api.withAuthenticatedSiteBundleSet(files, PASS, w.create, async bundle => { assert.deepEqual(bundle.sourceCutover, cutoff); });
  assert.equal(state.calls.length, 0, 'standalone index authentication/reader never calls SQL'); allDead(w);

  // A valid encrypted ZIP with a forged cutoff hash must still fail semantic authentication.
  const index = frozenFiles.find(file => file.name === 'site-index.edx'), raw = index.raw;
  const bytes = value => ({ async *[Symbol.asyncIterator]() { for (let i = 0; i < value.length; i += 65536) yield value.subarray(i, i + 65536); } });
  const tamperSpaces = workspaces(), space = tamperSpaces.create();
  try {
    const metadata = await api.readTransferMetadata(bytes(raw));
    const manifest = await api.verifyEncryptedVolume(bytes(raw), PASS, space, { expectedMetadata: metadata, limits: { maxLineBytes: 2 * 1024 * 1024 } });
    assert.equal(manifest.entries.length, 1);
    const path = manifest.entries[0].path, parts = [];
    for await (const part of space.open(path)) parts.push(Buffer.from(part));
    const document = JSON.parse(Buffer.concat(parts).toString('utf8'));
    assert.deepEqual(document.snapshot.source_cutover, cutoff);
    document.snapshot.source_cutover.cutoff_hash = '0'.repeat(64);
    const payload = Buffer.from(JSON.stringify(document) + '\n');
    const { exportId, sourceSiteId, volumeId, createdAt, scope, volumeIndex, volumeCount } = manifest;
    const info = { exportId, sourceSiteId, volumeId, createdAt, scope, volumeIndex, volumeCount }, output = directory();
    const file = output.createFile(index.name);
    await file.write(api.writeEncryptedVolume((async function* () {
      yield { path, bytes: payload.length, open: () => bytes(payload) };
    })(), info, PASS));
    // Prove GCM/ZIP/manifest are valid; only the cutoff's PG digest is wrong.
    await api.verifyEncryptedVolume(file.open(), PASS, tamperSpaces.create(), { expectedMetadata: metadata, limits: { maxLineBytes: 2 * 1024 * 1024 } });
    const forgedRaw = await readFile(output.outputs.get(index.name).path);
    const forged = fileList(frozenFiles.map(value => value.name === index.name ? { name: index.name, raw: forgedRaw } : value));
    let consumed = false;
    await assert.rejects(api.withAuthenticatedSiteBundleSet(forged, PASS, tamperSpaces.create, async () => { consumed = true; }));
    assert.equal(consumed, false); assert.equal(state.calls.length, 0);
  } finally { for (const temporary of tamperSpaces.spaces) await temporary.abort(); allDead(tamperSpaces); }

  await isolated(target, targetSession, async () => {
    assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.users'), 0);
    const before = await targetExcluded(), modes = await triggers(target);
    const context = startImport({ options: { files: fileList(frozenFiles) } }), result = await mustComplete(context, t);
    assert.deepEqual(result.verifiedDomains, DOMAINS); assert.equal(result.maintenance, true);
    assert.equal(result.fullSiteComplete, false); assert.equal(result.importReady, false);
    assert.deepEqual(result.serverVerification.verified_domains, DOMAINS);
    assert.deepEqual(result.serverVerification.counts, { employees: 1, pending_withdrawals: 1, pending_withdrawal_amount: '3' });
    assert.equal(callsOf('employee_import_site_verify').length, 1);
    await assertMaintenance(result); await assertBackups(context); await assertBusiness();
    for (const table of ['notification_automation_plans', 'notification_automation_tasks'])
      assert.equal(await scalar(target, `SELECT count(*)::int FROM public.${table} WHERE status='active'`), 0);
    assert.deepEqual(await targetExcluded(), before); assert.deepEqual(await triggers(target), modes);
    assertProgress(context); allDead(context.w); assert.equal(context.progress.at(-1).phase, 'maintenance');
    assert.equal(names().some(name => /resume|leave_maintenance|employee_import_finish/.test(name)), false);
  });
  t.diagnostic('Real worker -> SQL56 freeze -> 11 disk ciphertexts -> authenticated PG cutoff (including re-encrypted forged-hash rejection) -> ten-domain SQL55 maintenance verification; no source resume or target release. Local source/target isolation ROLLBACK only.');
});

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

// Last on purpose: the final lost-response case crosses a REAL COMMIT. All earlier
// negative cases share ONE real target import and roll back only their savepoints.
test('release专项: real drained worker -> freeze -> eleven ciphertexts -> import -> SQL57 release, rollback gates and worker deduplication', { timeout: 600000 }, async t => {
  const R = { active: id(600), disabled: id(601), nullable: id(602), adminNull: id(603),
    plan: id(610), pausedPlan: id(611), archivedPlan: id(612), recurring: id(620),
    draft: id(621), paused: id(622), pausedActive: id(623), archivedActive: id(624), branch: id(630) };
  let frozenFiles, cutoff, expected, historicalExecution;
  const now = Date.now();
  const money = db => rows(db, `SELECT u.id,u.total_income::text,w.available_balance::text,w.frozen_balance::text
    FROM public.users u JOIN public.wallets w ON w.user_id=u.id ORDER BY u.id`);
  const sourceStates = db => rows(db, 'SELECT username,is_active FROM public.users ORDER BY username');
  const automation = db => rows(db, `SELECT 'plan' AS kind,name,status,activated_at::text,NULL::int AS version FROM public.notification_automation_plans
    UNION ALL SELECT 'task',name,status,activated_at::text,version FROM public.notification_automation_tasks ORDER BY kind,name`);
  const worker = db => scalar(db, 'SELECT public.process_notification_automation_queue_fast(100)');
  await source.exec('BEGIN');
  try {
    const modes = await triggers(source);
    for (const [key, enabled] of [['active', true], ['disabled', false], ['nullable', null]]) {
      await source.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,is_active)
        VALUES($1,$2,$3,extensions.crypt($4,extensions.gen_salt('bf',4)),$5,$6)`,
      [R[key], 'release_' + key, 'RELEASE-' + key, PASSWORDS.employee, NEW.root, enabled]);
      await source.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [R[key]]);
    }
    await source.query('UPDATE public.admins SET is_active=false WHERE id=$1', [NEW.emergency]);
    await source.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      VALUES($1,'release_null_admin',extensions.crypt($2,extensions.gen_salt('bf',4)),'secondary_admin',NULL)`, [R.adminNull, PASSWORDS.branch]);
    await source.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [R.adminNull]);
    // Start each plan active, attach active tasks, then pause/archive the plan. This
    // is legal under the real plan/task validation trigger, which remains enabled.
    for (const [plan, name] of [[R.plan, 'Release active'], [R.pausedPlan, 'Release paused'], [R.archivedPlan, 'Release archived']]) {
      await source.query(`INSERT INTO public.notification_automation_plans(id,owner_admin_id,name,status,activated_at)
        VALUES($1,$2,$3,'active','2020-01-01T00:00:00Z')`, [plan, NEW.branch, name]);
    }
    await source.query(`INSERT INTO public.notification_automation_plan_members(plan_id,user_id,created_at)
      VALUES($1,$2,'2020-01-01T00:00:00Z')`, [R.plan, I.employee]);
    for (const [task, plan, name, status] of [
      [R.recurring, R.plan, 'Release recurring reward', 'active'], [R.draft, R.plan, 'Release draft task', 'draft'],
      [R.paused, R.plan, 'Release paused task', 'paused'], [R.pausedActive, R.pausedPlan, 'Release active under paused', 'active'],
      [R.archivedActive, R.archivedPlan, 'Release active under archived', 'active'],
    ]) await source.query(`INSERT INTO public.notification_automation_tasks(id,owner_admin_id,plan_id,name,status,trigger_type,
      trigger_mode,threshold_value,recipient_scope,title_template,content_template,reward_enabled,reward_amount,version,activated_at,starts_at)
      VALUES($1,$2,$3,$4,$5,'total_orders','recurring',$6,'selected','Release stage {{value}}','Local real worker reward',$7,$8,3,
        '2020-01-01T00:00:00Z','2020-01-01T00:00:00Z')`,
    [task, NEW.branch, plan, name, status, task === R.recurring ? 2 : 10000, task === R.recurring, task === R.recurring ? '7.25' : null]);
    await source.query("UPDATE public.notification_automation_plans SET status='paused' WHERE id=$1", [R.pausedPlan]);
    await source.query("UPDATE public.notification_automation_plans SET status='archived' WHERE id=$1", [R.archivedPlan]);
    assert.deepEqual(await triggers(source), modes);
    await isolated(source, sourceSession, async () => {
      startEdge();
      await t.test('real worker failure is retained and prevents source freeze; no delete-to-drain', async () => {
        await source.exec('SAVEPOINT release_source_failure');
        try {
          await source.exec('ALTER TABLE public.messages ADD CONSTRAINT local_release_source_failure CHECK(automation_execution_id IS NULL) NOT VALID');
          const ran = await worker(source);
          assert.ok(ran.failed_tasks > 0 || await scalar(source, 'SELECT count(*)::int FROM public.notification_automation_failures') > 0, JSON.stringify(ran));
          const denied = await execAs('anon', 'employee_export_cutover_freeze', {
            p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root, p_confirmation: '確認暫停舊站業務並導出',
          });
          assert.equal(denied.error, null); assert.equal(denied.data.frozen, false);
          assert.ok(denied.data.blockers.includes('failed_automation')); assert.ok(denied.data.counts.failed_automation > 0);
          assert.ok(await scalar(source, 'SELECT count(*)::int FROM public.notification_automation_failures') > 0);
          assert.equal(await scalar(source, 'SELECT count(*)::int FROM private.employee_transfer_maintenance'), 0);
        } finally { await source.exec('ROLLBACK TO SAVEPOINT release_source_failure; RELEASE SAVEPOINT release_source_failure'); }
      });
      const drained = await worker(source);
      assert.equal(drained.success, true);
      for (const table of ['notification_automation_queue', 'notification_automation_failures'])
        assert.equal(await scalar(source, `SELECT count(*)::int FROM public.${table}`), 0, table);
      const executions = await rows(source, `SELECT id,task_version,stage::text,status,message_id,wallet_transaction_id FROM public.notification_automation_executions`);
      assert.equal(executions.length, 1); historicalExecution = executions[0];
      assert.equal(historicalExecution.status, 'succeeded'); assert.equal(historicalExecution.stage, '1'); assert.equal(historicalExecution.task_version, 3);
      assert.equal(await scalar(source, "SELECT count(*)::int FROM public.wallet_transactions WHERE type='performance_bonus'"), 1);
      expected = { money: await money(source), employees: await sourceStates(source), automation: await automation(source),
        admins: await rows(source, "SELECT username,is_active FROM public.admins WHERE role<>'super_admin' ORDER BY username") };
      assert.notEqual(expected.money.find(row => row.id === I.employee).available_balance, '7', 'the real bonus changes the original fixture balance');
      const frozen = await api.freezeSourceCutover(PASSWORDS.root, '確認暫停舊站業務並導出');
      assert.equal(frozen.frozen, true); cutoff = structuredClone(frozen.cutoff);
      assert.deepEqual(frozen.counts, { pending_automation: 0, failed_automation: 0, processing_orders: 0 });
      frozenFiles = await exportSet(result => assert.deepEqual(result.sourceCutover, cutoff));
      assert.deepEqual(await triggers(source), modes);
    }, true);
  } catch (error) { if (!inside) await source.exec('ROLLBACK'); throw error; }
  t.diagnostic(`release source seed/worker/freeze/11-file export: ${Date.now() - now}ms; real cutoff ${cutoff.frozen_at}`);

  await isolated(target, targetSession, async () => {
    // Authenticate a real secondary session BEFORE the importer disables it.
    await target.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      VALUES($1,'branch',extensions.crypt($2,extensions.gen_salt('bf',4)),'secondary_admin',true)`, [R.branch, PASSWORDS.branch]);
    await target.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [R.branch]);
    const branchSession = await adminLogin(target, 'branch', PASSWORDS.branch);
    startEdge();
    const excluded = await targetExcluded(), rootBefore = await rows(target, 'SELECT to_jsonb(a)::text AS body FROM public.admins a WHERE id=$1', [I.targetRoot]);
    const modes = await triggers(target), c = startImport({ options: { files: fileList(frozenFiles) } }), result = await mustComplete(c, t);
    assert.deepEqual(result.verifiedDomains, DOMAINS); assert.deepEqual(result.sourceCutover, cutoff); assert.ok(result.releaseSession);
    await assertMaintenance(result); await assertBackups(c); allDead(c.w);
    assert.deepEqual(await money(target), expected.money, 'real bonus and finance directory migrated together, not default assertBusiness balance');
    assert.equal(callsOf('employee_import_site_bind_cutoff').length, 1);
    const binding = callsOf('employee_import_site_bind_cutoff')[0]; assert.equal(binding.error, null);
    assert.equal(binding.result.job_id, result.jobId); assert.deepEqual(binding.result.cutoff, cutoff);
    const token = binding.args.p_job_token, hash = result.serverVerification.verification_hash;
    const auth = { p_admin_session_token: targetSession, p_job_token: token };
    const releaseArgs = { ...auth, p_admin_password: PASSWORDS.root, p_confirmation: '確認啟用新站', p_verification_hash: hash };
    const release = (args = releaseArgs, role = 'anon') => execAs(role, 'employee_import_site_release', args);
    const statusArgs = { p_admin_session_token: targetSession, p_job_id: result.jobId };
    const guarded = await scalar(target, 'SELECT private.employee_transfer_guarded_tables()');
    // Independent full-row rollback oracle; does not accept a saved verified flag or
    // call the release implementation's own fingerprint as its expected result.
    const snapshot = async () => {
      const business = {};
      for (const relation of guarded) business[relation] = sha(await scalar(target, `SELECT COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text COLLATE "C"),'') FROM ${relation} t`));
      const unchangedColumns = {};
      for (const [relation, field] of [['public.users', 'is_active'], ['public.admins', 'is_active'],
        ['public.notification_automation_plans', 'status'], ['public.notification_automation_tasks', 'status']])
        unchangedColumns[relation] = sha(await scalar(target, `SELECT COALESCE(string_agg((to_jsonb(t)-$1::text)::text,E'\\n' ORDER BY (to_jsonb(t)-$1::text)::text COLLATE "C"),'') FROM ${relation} t`, [field]));
      return { business, unchangedColumns, maintenance: await rows(target, 'SELECT to_jsonb(m)::text AS body FROM private.employee_transfer_maintenance m'),
        permits: await rows(target, 'SELECT * FROM private.employee_transfer_write_permits'),
        job: await rows(target, "SELECT status,finished_at,summary->'site_release' AS receipt FROM private.employee_transfer_jobs WHERE id=$1", [result.jobId]),
        releasedEvents: await scalar(target, "SELECT count(*)::int FROM private.employee_transfer_events WHERE job_id=$1 AND action='site_released'", [result.jobId]) };
    };
    const original = await snapshot(); assert.deepEqual(original.permits, []);
    const scenario = (name, use) => t.test(name, async () => {
      await target.exec('SAVEPOINT release_case');
      try { await use(); }
      finally { await target.exec('ROLLBACK TO SAVEPOINT release_case; RELEASE SAVEPOINT release_case'); }
      assert.deepEqual(await snapshot(), original, 'case rollback preserves the original paused import and five backups');
    });
    const denied = async (args = releaseArgs, pattern = null, role = 'anon') => {
      const before = await snapshot(), response = await release(args, role);
      assert.ok(response.error || response.data?.success === false, JSON.stringify(response.data));
      if (pattern) assert.match(response.error?.message ?? JSON.stringify(response.data), pattern);
      assert.deepEqual(await snapshot(), before, 'rejected release is fully atomic, with no leaked permit');
      assert.equal(await scalar(target, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
      return response;
    };
    const corrupt = (relation, sql, args = []) => fixtureChange(target, relation, sql, args, result);
    const rehash = metadata => scalar(target, `SELECT $1::jsonb||jsonb_build_object('cutoff_hash',encode(extensions.digest(convert_to($1::jsonb::text,'UTF8'),'sha256'),'hex'))`, [JSON.stringify(Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'cutoff_hash')))]);

    await t.test('fresh client status matches authenticated cutoff and all ten real verified domains', async () => {
      const s = await result.releaseSession.status();
      assert.equal(s.can_release, true); assert.equal(s.released, false); assert.equal(s.maintenance, true); assert.deepEqual(s.blockers, []);
      assert.equal(s.verification_hash, hash); assert.deepEqual(s.cutoff, cutoff);
    });
    for (const [name, args, pattern, role] of [
      ['wrong administrator token', { ...releaseArgs, p_admin_session_token: id(9991) }, /session|expired|invalid/i],
      ['wrong job token', { ...releaseArgs, p_job_token: id(9992) }, /task|expired|invalid/i],
      ['wrong password', { ...releaseArgs, p_admin_password: 'Wrong-local-password' }, null],
      ['wrong confirmation', { ...releaseArgs, p_confirmation: '確認啟用' }, /confirmation/i],
      ['wrong verification hash', { ...releaseArgs, p_verification_hash: '0'.repeat(64) }, /digest differs/i],
      ['service role cannot call browser release', releaseArgs, /permission denied/i, 'service_role'],
    ]) await scenario(name, () => denied(args, pattern, role));
    await scenario('real active secondary session cannot release or inspect super-admin import', async () => {
      await corrupt('public.admins', 'UPDATE public.admins SET is_active=true WHERE id=$1', [R.branch]);
      await denied({ ...releaseArgs, p_admin_session_token: branchSession }, /super|permission|administrator/i);
      const s = await execAs('anon', 'get_employee_import_site_release_status', { ...statusArgs, p_admin_session_token: branchSession });
      assert.ok(s.error); assert.equal(s.data, null);
    });
    await scenario('expired admin session', async () => {
      await target.query("UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=private.hash_financial_token($1)", [targetSession]);
      await denied(releaseArgs, /session|expired|invalid/i);
    });
    await scenario('missing cutoff is not inferred from completed verification', async () => {
      await target.query("UPDATE private.employee_transfer_jobs SET summary=summary-'source_cutover' WHERE id=$1", [result.jobId]);
      const s = await execAs('anon', 'get_employee_import_site_release_status', statusArgs);
      assert.equal(s.error, null); assert.ok(s.data.blockers.includes('missing_cutoff')); assert.equal(s.data.can_release, false);
      await denied(releaseArgs, /cutoff/i);
    });
    await scenario('cutoff digest tamper', async () => {
      await target.query("UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{source_cutover,cutoff_hash}',to_jsonb($2::text)) WHERE id=$1", [result.jobId, 'f'.repeat(64)]);
      await denied(releaseArgs, /digest/i);
    });
    await scenario('bound cutoff cannot change even with a correct PG digest', async () => {
      const changed = await rehash({ ...cutoff, cutoff_id: id(9993) });
      const response = await execAs('anon', 'employee_import_site_bind_cutoff', { ...auth, p_cutoff: changed });
      assert.match(response.error?.message ?? '', /already bound|cannot change/i); assert.equal(response.data, null);
    });
    for (const [name, expression] of [['previous UTC date', "clock_timestamp()-interval '1 day'"], ['future cutoff', "clock_timestamp()+interval '1 hour'"]]) {
      await scenario(name + ': valid PG metadata may bind for inspection but must not release', async () => {
        const frozen_at = await scalar(target, `SELECT to_char((${expression}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);
        const changed = await rehash({ ...cutoff, frozen_at });
        // Negative-only corruption: remove the binding, then use the REAL bind RPC.
        // No job/plan/catalog/verified success is fabricated or reset.
        await target.query("UPDATE private.employee_transfer_jobs SET summary=summary-'source_cutover' WHERE id=$1", [result.jobId]);
        const bound = await execAs('anon', 'employee_import_site_bind_cutoff', { ...auth, p_cutoff: changed });
        assert.equal(bound.error, null); assert.equal(bound.data.success, true);
        const s = await execAs('anon', 'get_employee_import_site_release_status', statusArgs);
        assert.equal(s.error, null); assert.ok(s.data.blockers.includes('cutoff_expired')); assert.equal(s.data.can_release, false);
        await denied(releaseArgs, /same UTC date/i);
      });
    }
    for (const [name, relation, sql, args] of [
      ['target queue', 'public.notification_automation_queue', 'INSERT INTO public.notification_automation_queue(user_id) VALUES($1)', [I.employee]],
      ['target failure', 'public.notification_automation_failures', `INSERT INTO public.notification_automation_failures(task_id,user_id,owner_admin_id,last_error)
        SELECT id,$1,owner_admin_id,'Local negative failure' FROM public.notification_automation_tasks WHERE name='Release recurring reward'`, [I.employee]],
      ['wallet', 'public.wallets', 'UPDATE public.wallets SET available_balance=available_balance+1 WHERE user_id=$1', [I.employee]],
      ['employee original activation', 'public.users', 'UPDATE public.users SET is_active=true WHERE id=$1', [I.employee]],
    ]) await scenario(name + ' drift rejects even though historical status still reports verified', async () => {
      await corrupt(relation, sql, args);
      const s = await execAs('anon', 'get_employee_import_site_release_status', statusArgs);
      assert.equal(s.error, null); assert.equal(s.data.released, false);
      await denied();
    });
    await scenario('stored automation original statuses drift cannot authorize activation', async () => {
      await target.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,
        ARRAY['notification_restore','original_statuses','notification_automation_tasks',
          (SELECT id::text FROM public.notification_automation_tasks WHERE name='Release draft task')], '"active"') WHERE id=$1`, [result.jobId]);
      await denied(releaseArgs, /status|source|differ|changed/i);
    });
    await scenario('source administrator state binding drift is rejected', async () => {
      await target.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,
        ARRAY['site_original_admin_bindings',$2::text,'source_id'],to_jsonb($3::text))
        WHERE options->>'import_protocol'='shared-import-v1' AND options->'package_id'=(SELECT options->'package_id' FROM private.employee_transfer_jobs WHERE id=$1)`,
      [result.jobId, R.branch, id(9994)]);
      await denied(releaseArgs, /snapshot binding|states|mapping/i);
    });
    await scenario('late queue constraint failure rolls back account/task changes and clears every permit', async () => {
      await target.exec('ALTER TABLE public.notification_automation_queue ADD CONSTRAINT local_release_late_failure CHECK(attempts<0) NOT VALID');
      await denied(releaseArgs, /local_release_late_failure/i);
      assert.deepEqual(await triggers(target), modes);
    });

    await t.test('actual client release COMMIT then lost response -> fresh historical status, never resend', async () => {
      const utcDate = await scalar(target, "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD')");
      assert.equal(utcDate, cutoff.frozen_at.slice(0, 10), 'ENVIRONMENT: actual freeze crossed UTC midnight; safe refusal is not a release implementation defect');
      const before = await snapshot(), beforeAutomation = await automation(target), started = Date.now();
      let committed = false;
      state.afterSql = async (call, actual) => {
        if (call.name !== 'employee_import_site_release' || actual.error || actual.data?.released !== true) return actual;
        await target.exec('COMMIT; BEGIN'); committed = true;
        return { data: null, error: { message: 'Local transport loss AFTER real release COMMIT' } };
      };
      await assert.rejects(result.releaseSession.release(PASSWORDS.root, '確認啟用新站'), /unconfirmed|fresh explicit status/i);
      state.afterSql = null;
      const actual = callsOf('employee_import_site_release').at(-1);
      if (!committed) t.diagnostic(JSON.stringify({ actualError: actual?.error, actualResult: actual?.result }));
      assert.equal(committed, true); assert.equal(actual.error, null); assert.equal(actual.result.released, true);
      t.diagnostic(`SQL57 real release/full guarded fingerprint: ${Date.now() - started}ms; ${guarded.length} guarded tables`);
      const count = callsOf('employee_import_site_release').length;
      await assert.rejects(result.releaseSession.release(PASSWORDS.root, '確認啟用新站'));
      assert.equal(callsOf('employee_import_site_release').length, count, 'unknown result must not cause a second write');
      const fresh = api.createSiteReleaseSession({ jobId: result.jobId, jobToken: token, sourceSiteId: sourceId,
        packageId: result.serverVerification.package_id, verificationHash: hash, cutoff });
      const s = await fresh.status();
      assert.equal(s.released, true); assert.equal(s.can_release, false); assert.equal(s.maintenance, false); assert.deepEqual(s.blockers, []);
      assert.deepEqual(s.receipt, actual.result);
      assert.deepEqual(s.receipt.counts, { employees: 4, active_employees: 2, active_admins: 1, active_plans: 1, active_tasks: 3, queued_employees: 2 });
      assert.equal(await scalar(target, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [result.jobId]), 'finished');
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.employee_transfer_maintenance'), 0);
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.employee_transfer_write_permits'), 0);
      assert.deepEqual(await sourceStates(target), expected.employees);
      assert.deepEqual(await rows(target, "SELECT username,is_active FROM public.admins WHERE role<>'super_admin' ORDER BY username"), expected.admins);
      assert.deepEqual(await automation(target), expected.automation, 'original statuses, versions and activated_at survive paused/archived active-task combinations');
      assert.notDeepEqual(beforeAutomation, expected.automation, 'import really paused automation before release');
      assert.deepEqual(await money(target), expected.money);
      assert.deepEqual(await targetExcluded(), excluded);
      assert.deepEqual(await rows(target, 'SELECT to_jsonb(a)::text AS body FROM public.admins a WHERE id=$1', [I.targetRoot]), rootBefore);
      await assertBackups(c); assert.deepEqual(await triggers(target), modes);
      const after = await snapshot();
      assert.deepEqual(after.unchangedColumns, before.unchangedColumns, 'only is_active/status may change, not timestamps, passwords, versions or other fields');
      for (const relation of guarded.filter(name => !['public.users', 'public.admins', 'public.notification_automation_plans', 'public.notification_automation_tasks', 'public.notification_automation_queue'].includes(name)))
        assert.equal(after.business[relation], before.business[relation], relation + ': release cannot change financial/history/progress/full rows');
      assert.deepEqual(await rows(target, 'SELECT user_id,attempts,last_error,requested_at=next_attempt_at AS fresh FROM public.notification_automation_queue ORDER BY user_id'),
        [I.employee, R.active].sort().map(user_id => ({ user_id, attempts: 0, last_error: null, fresh: true })));
      await assert.rejects(fresh.release(PASSWORDS.root, '確認啟用新站')); assert.equal(callsOf('employee_import_site_release').length, count);
      const duplicate = await release(); assert.ok(duplicate.error); assert.equal(duplicate.data, null);
      assert.equal(await scalar(target, "SELECT count(*)::int FROM private.employee_transfer_events WHERE job_id=$1 AND action='site_released'", [result.jobId]), 1);
      const first = await worker(target); assert.equal(first.success, true); assert.equal(first.created_notifications, 0, JSON.stringify(first));
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.notification_automation_failures'), 0);
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.notification_automation_queue'), 0);
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.notification_automation_executions'), 1);
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.messages WHERE automation_execution_id IS NOT NULL'), 1);
      assert.equal(await scalar(target, "SELECT count(*)::int FROM public.wallet_transactions WHERE type='performance_bonus'"), 1);
      assert.deepEqual(await money(target), expected.money, 'release queue evaluation does not duplicate the old reward');
      // New final failure orders are legitimate business input. INSERT (not the
      // known broken legacy UPDATE audit path), every trigger remains enabled.
      for (let n = 0; n < 2; n++) await target.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status,processed_at)
        SELECT $1,$2,'import_employee',id,100,$3,$4,'failure',clock_timestamp()-interval '1 second' FROM public.product_types WHERE name='Import product'`,
      [id(640 + n), I.employee, 'RELEASE-NEXT-' + n, 'RELEASE-NEXT-TX-' + n]);
      assert.equal(await scalar(target, "SELECT count(*)::int FROM public.orders WHERE user_id=$1 AND status IN ('success','failure')", [I.employee]), 4);
      const next = await worker(target); assert.equal(next.success, true); assert.equal(next.created_notifications, 1, JSON.stringify(next));
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.notification_automation_failures'), 0);
      assert.deepEqual(await rows(target, `SELECT stage::text,status FROM public.notification_automation_executions ORDER BY stage`), [{ stage: '1', status: 'succeeded' }, { stage: '2', status: 'succeeded' }]);
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.messages WHERE automation_execution_id IS NOT NULL'), 2);
      assert.equal(await scalar(target, "SELECT count(*)::int FROM public.wallet_transactions WHERE type='performance_bonus'"), 2);
      const expectedBalance = expected.money.find(row => row.id === I.employee).available_balance;
      assert.equal(await scalar(target, 'SELECT available_balance=$2::numeric+7.25 FROM public.wallets WHERE user_id=$1', [I.employee, expectedBalance]), true);
      const nextMoney = await money(target);
      const again = await worker(target); assert.equal(again.created_notifications, 0, JSON.stringify(again));
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.notification_automation_executions'), 2);
      assert.equal(await scalar(target, 'SELECT count(*)::int FROM public.messages WHERE automation_execution_id IS NOT NULL'), 2);
      assert.equal(await scalar(target, "SELECT count(*)::int FROM public.wallet_transactions WHERE type='performance_bonus'"), 2);
      assert.deepEqual(await money(target), nextMoney);
      assert.equal(await scalar(target, 'SELECT stage::text FROM public.notification_automation_executions WHERE id=$1', [historicalExecution.id]), '1');
      const history = await fresh.status(); assert.equal(history.released, true); assert.deepEqual(history.receipt, s.receipt);
      await assertBackups(c); assert.deepEqual(await triggers(target), modes);
    });
  });
});
