import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSites, adminLogin, rpc as baseRpc, scalar, rows } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, OLD, PASSWORDS } from './support/transfer-fixtures.mjs';

// Local real SQL only: no migration/trigger/function patches, no production requests and no apply.
const migration = '20261102000010_prepare_dispatch_submission_import.sql';
const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const KEYS = ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders',
  'dispatch_group_members', 'valid_order_data', 'used_order_data'];
const RPCS = ['employee_import_dispatch_begin', 'employee_import_dispatch_stage',
  'get_employee_import_dispatch_dry_run', 'get_employee_import_dispatch_backup',
  'get_employee_import_dispatch_backup_page', 'employee_import_dispatch_backup_append',
  'employee_import_dispatch_backup_seal', 'get_employee_dispatch_saved_backup_chunk'];
const EXPORT_RPCS = ['employee_export_dispatch_begin', 'get_employee_export_dispatch_page',
  'employee_export_dispatch_verify', 'employee_export_dispatch_close'];
const PASSPHRASE = 'local-only-dispatch-db-independent-backup-passphrase';
const pathFor = key => `data/dispatch-${key}.ndjson`;
const lines = text => text.match(/[^\n]*\n/g) ?? [];
const rowHashes = text => hash(lines(text).map(line => hash(line)).join(''));
let source, db, replay, session, sourceSession, branch, emergency, otherRoot, sourceGroup, sourcePool;
let targetGroup, targetPool, pkg, modules, sequence = 0;
const businessTables = [...KEYS, 'admins', 'users', 'financial_admin_credentials', 'financial_employee_credentials',
  'orders', 'orders_history', 'product_types', 'wallets', 'wallet_transactions', 'wallet_ledger_entries',
  'wallet_balance_baselines', 'wallet_reconciliation_audit', 'wallet_reconciliation_queue', 'withdrawals',
  'withdrawal_events', 'financial_operations', 'commission_audit_log', 'money_data_protection_audit',
  'dispatch_assignments', 'dispatch_pool_selections', 'dispatch_sessions', 'dispatch_orders', 'work_sessions',
  'bulk_import_log', 'announcements', 'announcement_categories', 'admin_configs', 'system_configs',
  'history_cleanup_config', 'notification_automation_plans'];
// Compare SQL text digests, not JS numeric representations, including tables outside the seven inputs.
async function businessState(site = db) {
  return rows(site, businessTables.map(table => `SELECT '${table}' AS name,count(*)::int AS rows,
    md5(COALESCE(string_agg(to_jsonb(r)::text,E'\n' ORDER BY to_jsonb(r)::text),'')) AS digest
    FROM public.${table} AS r`).join(' UNION ALL '));
}
async function transaction(fn, site = db, unchanged = true) {
  await site.exec('BEGIN');
  const original = unchanged ? await businessState(site) : null;
  try { return await fn(); }
  finally {
    try { if (unchanged) assert.deepEqual(await businessState(site), original, 'preparation must not change business data'); }
    finally { await site.exec('ROLLBACK'); }
  }
}
async function isolated(site, fn, role = 'anon') {
  const savepoint = `dispatch_prepare_${++sequence}`;
  await site.exec(`SAVEPOINT ${savepoint}`);
  try {
    await site.exec(`SET LOCAL ROLE ${role}`);
    const result = await fn();
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await site.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
const callOn = (site, name, args) => isolated(site, () => baseRpc(site, name, args, { role: null }));
const rpc = (name, args) => callOn(db, name, args);
const auth = (job, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
const begin = (input = pkg, token = session, password = PASSWORDS.root) => rpc('employee_import_dispatch_begin', {
  p_admin_session_token: token, p_admin_password: password, p_package_id: input.packageId, p_catalog: input.catalog,
});
const stage = (job, key, text = pkg.texts[key], no = 0) => rpc('employee_import_dispatch_stage', {
  ...auth(job), p_table_key: key, p_chunk_no: no, p_ndjson: text,
});
const dryRun = job => rpc('get_employee_import_dispatch_dry_run', auth(job));
const descriptor = job => rpc('get_employee_import_dispatch_backup', auth(job));
const page = (job, key, after = null, limit = 200) => rpc('get_employee_import_dispatch_backup_page', {
  ...auth(job), p_table_key: key, p_after: after, p_limit: limit,
});
const append = (job, plan, no, bytes) => rpc('employee_import_dispatch_backup_append', {
  ...auth(job), p_plan_hash: plan.plan_hash, p_chunk_no: no, p_hex: bytes.toString('hex'),
});
const seal = (job, plan, bytes, sha256 = hash(bytes), size = bytes.length) => rpc('employee_import_dispatch_backup_seal', {
  ...auth(job), p_plan_hash: plan.plan_hash, p_sha256: sha256, p_bytes: size,
});
const cancel = job => rpc('employee_transfer_cancel', auth(job));
const saved = (backupId, no = 0, token = session) => rpc('get_employee_dispatch_saved_backup_chunk', {
  p_admin_session_token: token, p_backup_id: backupId, p_chunk_no: no,
});
const backupCount = job => scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]);
const stageCount = job => scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [job.job_id]);
const lastExport = () => rpc('get_employee_transfer_log', { p_admin_session_token: session }).then(value => value.last_export_at);
function preparation(plan, input = pkg) {
  assert.equal(plan.scope, 'dispatch-submission'); assert.equal(plan.preparation_ready, true);
  assert.equal(plan.replacement_ready, false); assert.equal(plan.can_apply, false); assert.equal(plan.full_site_complete, false);
  assert.equal(plan.source_default_group_id, sourceGroup);
  assert.deepEqual(plan.counts, Object.fromEntries(input.catalog.tables.map(t => [t.key, t.rows])));
  assert.match(plan.plan_hash, /^[0-9a-f]{64}$/);
}
function chunks(text) {
  const result = []; let part = '', count = 0;
  for (const line of lines(text)) {
    if (count === 200 || Buffer.byteLength(part + line) > 262144) { result.push(part); part = ''; count = 0; }
    part += line; count++;
  }
  if (part || !result.length) result.push(part);
  return result;
}
async function stageAll(job, input = pkg, skip = null) {
  for (const key of KEYS) if (key !== skip) {
    for (const [no, text] of chunks(input.texts[key]).entries()) {
      const ack = await stage(job, key, text, no);
      assert.deepEqual(ack, { success: true, rows: lines(text).length, bytes: Buffer.byteLength(text), sha256: hash(text), repeated: false });
    }
  }
}
async function prepared(input = pkg) {
  const job = await begin(input); assert.equal(job.success, true);
  await stageAll(job, input);
  const plan = await dryRun(job); preparation(plan, input);
  return { job, plan };
}
function fromTexts(texts, base = pkg) {
  const catalog = structuredClone(base.catalog);
  for (const table of catalog.tables) Object.assign(table, { rows: lines(texts[table.key]).length,
    bytes: Buffer.byteLength(texts[table.key]), row_hashes_sha256: rowHashes(texts[table.key]) });
  return { ...base, texts: { ...texts }, catalog };
}
// Mutate malicious inputs in SQL so even tests of unrelated fields retain arbitrary numeric precision.
async function edited(key, expression, predicate = 'true', base = pkg) {
  const text = await scalar(source, `WITH input AS (
    SELECT raw,ordinal,raw::jsonb AS body FROM unnest(string_to_array(rtrim($1,E'\n'),E'\n')) WITH ORDINALITY AS line(raw,ordinal)
  ) SELECT COALESCE(string_agg(CASE WHEN ${predicate} THEN (${expression})::text ELSE raw END||E'\n','' ORDER BY ordinal),'') FROM input`, [base.texts[key]]);
  return fromTexts({ ...base.texts, [key]: text }, base);
}
async function captureExport() {
  const job = await callOn(source, 'employee_export_dispatch_begin', {
    p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
  });
  assert.equal(job.success, true); const texts = {};
  for (const key of KEYS) {
    let text = '', after = null;
    do {
      const value = await callOn(source, 'get_employee_export_dispatch_page', {
        ...auth(job, sourceSession), p_table_key: key, p_after: after, p_limit: 200,
      });
      assert.equal(value.sha256, hash(value.ndjson)); text += value.ndjson; after = value.next_after;
    } while (after !== null);
    texts[key] = text;
    const table = job.catalog.tables.find(t => t.key === key);
    assert.equal(lines(text).length, table.rows); assert.equal(Buffer.byteLength(text), table.bytes);
    assert.equal(rowHashes(text), table.row_hashes_sha256);
  }
  assert.equal((await callOn(source, 'employee_export_dispatch_verify', auth(job, sourceSession))).verified, true);
  await callOn(source, 'employee_export_dispatch_close', auth(job, sourceSession));
  return { texts, catalog: job.catalog, packageId: randomUUID() };
}
async function addEmployee(site, number, admin) {
  await site.query(`INSERT INTO public.users(id,username,password_hash,employee_id,created_by,is_active)
    VALUES($1,$2,'local-fixture-only',$3,$4,false)`, [id(number), `prepare-employee-${number}`, `PREP-${number}`, admin]);
}
async function addOrder(site, user = id(201)) {
  await site.query(`INSERT INTO public.dispatch_group_members(group_id,user_id,assigned_by)
    VALUES($1,$2,$3) ON CONFLICT(user_id) DO NOTHING`, [site === source ? sourceGroup : targetGroup, user, site === source ? OLD.root : NEW.root]);
  await site.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status)
    VALUES($1,$2,$3,$4,1,'prepare-order','prepare-tx','failure')`,
  [id(901), user, `prepare-employee-${site === source ? 1 : 201}`, site === source ? OLD.product : NEW.product]);
}
function bridge(site, token, trace) {
  return { token, rpc(name, args) {
    assert.ok([...RPCS, ...EXPORT_RPCS, 'employee_transfer_cancel'].includes(name), `dedicated RPC only: ${name}`);
    assert.equal(args.p_admin_session_token, token);
    const entry = { name, args: structuredClone(args) }; trace.push(entry);
    let pending;
    const query = { abortSignal() { return query; }, then(resolve, reject) {
      pending ??= isolated(site, async () => {
        assert.equal(await scalar(site, 'SELECT current_user'), 'anon');
        const data = await baseRpc(site, name, args, { role: null });
        entry.response = structuredClone(data); return { data, error: null };
      }).catch(error => { entry.error = { message: error.message, code: error.code }; return { data: null, error: entry.error }; });
      return pending.then(resolve, reject);
    } };
    return query;
  } };
}
async function* diskSource(path) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(65521);
    for (;;) { const { bytesRead } = await file.read(buffer); if (!bytesRead) return; yield buffer.subarray(0, bytesRead); }
  } finally { await file.close(); }
}
function workspace(directory, prefix) {
  const files = new Map(KEYS.map(key => [pathFor(key), join(directory, `${prefix}-${key}.ndjson`)]));
  let discarded = false;
  return {
    files,
    async append(path, bytes) {
      assert.equal(discarded, false); assert.ok(files.has(path));
      const file = await open(files.get(path), 'a');
      try { await file.writeFile(bytes); } finally { await file.close(); }
    },
    open(path) { assert.equal(discarded, false); assert.ok(files.has(path)); return diskSource(files.get(path)); },
    async abort() { discarded = true; await Promise.all([...files.values()].map(path => rm(path, { force: true }))); },
  };
}
// These bytes test SQL's length/hash gates ONLY, not encryption. The end-to-end test uses actual AES-GCM/ZIP files.
const gateCipher = () => Buffer.concat([Buffer.from('EDXSTRM1'), Buffer.alloc(88, 0xa5)]);

before(async () => {
  replay = await createSites({ upTo: migration }); source = replay.oldSite; db = replay.newSite;
  await db.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await buildNewSite(db);
  for (const [admin, name, role, password] of [[OLD.root, 'root', 'super_admin', PASSWORDS.root],
    [OLD.branch, 'branch', 'secondary_admin', PASSWORDS.branch]]) {
    await source.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      VALUES($1,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$4,true)`, [admin, name, password, role]);
    await source.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash)
      VALUES($1,extensions.crypt($2,extensions.gen_salt('bf',4)))`, [admin, password]);
  }
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    VALUES($1,'other-prepare-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [id(999), PASSWORDS.root]);
  await db.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash)
    VALUES($1,extensions.crypt($2,extensions.gen_salt('bf',4)))`, [id(999), PASSWORDS.root]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  otherRoot = await adminLogin(db, 'other-prepare-root', PASSWORDS.root);
  sourceGroup = id(10);
  await source.exec('UPDATE public.dispatch_groups SET is_default=false');
  await source.query(`INSERT INTO public.dispatch_groups(id,group_name,is_default,created_by)
    VALUES($1,'來源真正默認組',true,$2)`, [sourceGroup, OLD.root]);
  await source.query(`UPDATE public.dispatch_groups SET created_by=$1`, [OLD.root]);
  await source.query(`UPDATE public.dispatch_groups SET description='來源全量設定，不是目標初始化值',
    dispatch_interval_min=7,dispatch_interval_max=9,session_timeout_minutes=3,dispatch_order_mode='sequential',
    dispatch_success_rate=37,pool_selection_mode='weighted',submit_wait_min_seconds=11,submit_wait_max_seconds=18,
    commission_rate=0.12345678,withdrawal_amount_threshold=123.45,withdrawal_orders_threshold=17,
    withdrawal_condition_mode='AND',grab_success_rate=63 WHERE id=$1`, [sourceGroup]);
  sourcePool = await scalar(source, 'SELECT id FROM public.dispatch_order_pools WHERE group_id=$1 AND is_base', [sourceGroup]);
  await source.query(`UPDATE public.dispatch_order_pools SET pool_name='來源真正Base',dispatch_interval_min=15,
    dispatch_interval_max=19,session_timeout_minutes=2,dispatch_order_mode='sequential',dispatch_success_rate=29,
    trigger_probability=70,created_by=$2 WHERE id=$1`, [sourcePool, OLD.branch]);
  await source.query(`INSERT INTO public.dispatch_order_pools(id,group_id,pool_name,trigger_probability,created_by)
    VALUES($1,$2,'來源第二池',30,$3)`, [id(100), sourceGroup, OLD.root]);
  await addEmployee(source, 1, OLD.root); await addEmployee(source, 2, OLD.branch);
  for (const n of [1, 2]) await source.query(`INSERT INTO public.dispatch_group_members(id,group_id,user_id,assigned_by,assigned_at)
    VALUES($1,$2,$3,$4,'2026-09-01T01:02:03.123456Z')`, [id(110 + n), sourceGroup, id(n), OLD.branch]);
  await source.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,created_by)
    SELECT ('20000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,$1,$2,'來源原文 é é 𠮷 '||n,$3
    FROM generate_series(1,413) AS n`, [sourceGroup, sourcePool, OLD.root]);
  await source.query(`INSERT INTO public.product_types(id,name) VALUES($1,'Source preparation product')`, [OLD.product]);
  await addOrder(source, id(1));
  await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by,usage_count,tags,priority)
    VALUES($1,12345678901234567890.1234567890123456789,'來源原文-é-𠮷',$2,6,ARRAY['來源','已用'],9)`, [id(102), OLD.root]);
  await source.query(`INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at)
    VALUES($1,$2,$3,$4,'2026-09-02T01:02:03.123456Z')`, [id(103), id(1), id(102), id(901)]);
  await source.query(`UPDATE public.valid_order_data SET last_used_at='2026-09-02T01:02:03.123456Z' WHERE id=$1`, [id(102)]);
  targetGroup = await scalar(db, 'SELECT id FROM public.dispatch_groups WHERE is_default');
  targetPool = await scalar(db, 'SELECT id FROM public.dispatch_order_pools WHERE group_id=$1 AND is_base', [targetGroup]);
  await db.query(`UPDATE public.dispatch_groups SET group_name='目標舊默認組',commission_rate=0.00001001,
    dispatch_order_mode='random' WHERE id=$1`, [targetGroup]);
  await db.query(`UPDATE public.dispatch_order_pools SET pool_name='目標初始化Base',dispatch_success_rate=91 WHERE id=$1`, [targetPool]);
  await db.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,created_by)
    SELECT ('50000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,$1,$2,repeat('目標備份原文 𠮷 ',60)||n,$3
    FROM generate_series(1,203) AS n`, [targetGroup, targetPool, NEW.root]);
  await addEmployee(db, 201, NEW.root);
  await db.query(`INSERT INTO public.product_types(id,name) VALUES($1,'Target preparation product')`, [NEW.product]);
  // The old initializer normally creates this placeholder. Seed it as fixture data, so even the
  // backwards-protocol test cannot change business tables merely by opening an old task.
  await db.exec("INSERT INTO public.product_types(name,is_active) VALUES('舊站匯入（精簡訂單）',false)");
  await db.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by)
    VALUES($1,98765432109876543210.9876543210987654321,'目標尚未使用精確資料',$2)`, [id(202), NEW.root]);
  pkg = await transaction(captureExport, source);
  const compiled = await build({
    stdin: { contents: `export * from './src/lib/employeeTransfer/api.ts';
      export * from './src/lib/employeeTransfer/dispatchTransfer.ts';
      export * from './src/lib/employeeTransfer/dispatchImport.ts';
      export * from './src/lib/employeeTransfer/dispatchBackup.ts';
      export { verifyEncryptedVolume } from './src/lib/employeeTransfer/container.ts';
      export { setBridge } from 'dispatch-prepare-db:bridge';`, resolveDir: root, sourcefile: 'dispatch-prepare-db-entry.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', metafile: true,
    plugins: [{ name: 'dispatch-prepare-db-auth-transport-only', setup(builder) {
      builder.onResolve({ filter: /^dispatch-prepare-db:bridge$/ }, () => ({ path: 'state', namespace: 'dispatch-prepare-db' }));
      builder.onResolve({ filter: /^\.\.\/(auth|supabase)$/ }, args => {
        assert.equal(args.importer, `${root}src/lib/employeeTransfer/api.ts`);
        return { path: args.path.slice(3), namespace: 'dispatch-prepare-db' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'dispatch-prepare-db' }, ({ path }) => ({ contents: path === 'state'
        ? 'let bridge; export const setBridge=v=>{bridge=v;}; export const current=()=>bridge;'
        : path === 'auth' ? `import {current} from 'dispatch-prepare-db:bridge'; export const getAdminFinancialSessionToken=()=>current().token;`
          : `import {current} from 'dispatch-prepare-db:bridge'; export const supabase={rpc:(...args)=>current().rpc(...args)}; export const formatSupabaseError=e=>e.message;` }));
    } }],
  });
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const name of ['api', 'dispatchImport', 'dispatchBackup', 'dispatchTransfer', 'container', 'crypto', 'sha256'])
    assert.ok(inputs.some(path => path.endsWith(`/employeeTransfer/${name}.ts`)), `real ${name} implementation required`);
  assert.equal(inputs.some(path => /src\/lib\/(auth|supabase)\.ts$/.test(path)), false);
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  mock.method(globalThis, 'fetch', () => assert.fail('dispatch preparation tests prohibit network access'));
}, { timeout: 180000 });
after(async () => { mock.restoreAll(); await Promise.all([source?.close(), db?.close()]); });

test('537 actual SQL migrations retain exactly 12 historical failures, not a verified fresh database', () => {
  assert.equal(replay.files.length, 537); assert.equal(replay.files.at(-1), migration);
  assert.equal(replay.failures.length, 12); assert.equal(replay.validation.matched.length, 12);
  assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.ok(!replay.failures.some(f => f.file === migration));
});

test('eight dedicated RPCs have fixed SECURITY DEFINER grants; private tables/helpers stay inaccessible', () => transaction(async () => {
  const functions = await rows(db, `SELECT proname,prosecdef,proconfig,
    has_function_privilege('anon',oid,'EXECUTE') AS anon,has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`, [RPCS]);
  assert.equal(functions.length, 8);
  for (const fn of functions) {
    assert.equal(fn.prosecdef, true); assert.equal(fn.anon, true); assert.equal(fn.authenticated, true);
    assert.equal(fn.public_execute, false); assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
  }
  await assert.rejects(isolated(db, () => db.query('SELECT * FROM private.employee_transfer_shared_backups')), /permission denied/);
  await assert.rejects(isolated(db, () => db.query('SELECT private.employee_transfer_dispatch_catalog()')), /permission denied/);
  assert.equal(await scalar(db, `SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname LIKE 'employee_import_dispatch%apply%'`), 0, 'preparation must expose no apply');
}));

test('real source seven-table export stages exact high precision, source default/Base and dependencies without mapping or replacement', () => transaction(async () => {
  const { job, plan } = await prepared();
  assert.notEqual(sourceGroup, targetGroup); assert.notEqual(sourcePool, targetPool);
  assert.deepEqual(plan.dependencies, { administrators: 2, employees: 2, orders: 1 });
  assert.equal('admin_map' in plan, false); assert.equal('employee_map' in plan, false);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.users WHERE id=ANY($1::uuid[])', [[id(1), id(2)]]), 0);
  const raw = await scalar(db, `SELECT payload->>'ndjson' FROM private.employee_transfer_staging
    WHERE job_id=$1 AND table_key='dispatch-in:valid_order_data'`, [job.job_id]);
  assert.equal(raw, pkg.texts.valid_order_data); assert.match(raw, /12345678901234567890\.1234567890123456789/);
  const amount = await scalar(db, `SELECT body->>'product_value' FROM private.employee_transfer_dispatch_input($1,'valid_order_data')`, [job.job_id]);
  assert.equal(amount, '12345678901234567890.1234567890123456789');
  assert.match(pkg.texts.used_order_data, /01:02:03\.123456/);
  assert.equal(await scalar(db, `SELECT (body->>'usage_count')::int FROM private.employee_transfer_dispatch_input($1,'valid_order_data')`, [job.job_id]), 7);
  const pool = await scalar(db, `SELECT body FROM private.employee_transfer_dispatch_input($1,'dispatch_order_pools') WHERE id=$2`, [job.job_id, sourcePool]);
  assert.equal(pool.is_base, true); assert.equal(pool.pool_name, '來源真正Base'); assert.equal(pool.trigger_probability, 70);
  assert.equal(pool.dispatch_success_rate, 29); assert.equal(pool.dispatch_interval_min, 15);
  assert.deepEqual(await dryRun(job), plan, 'repeat dry-run keeps the exact frozen plan');
  assert.equal(await scalar(db, `SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key LIKE 'dispatch-backup:%'`, [job.job_id]), 7);
  assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [job.job_id]), 'running');
}));

test('real bundled API -> anon export/stage/prepare -> independent disk AES-GCM backup/reread/upload/seal -> saved chunks, never apply',
  { timeout: 120000 }, () => transaction(async () => transaction(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dispatch-prepare-db-'));
    const exportFiles = workspace(directory, 'source'), backupFiles = workspace(directory, 'backup');
    const cipherPath = join(directory, 'independent-target-backup.edx');
    const trace = [], progress = [], beforeTime = await lastExport();
    try {
      modules.setBridge(bridge(source, sourceSession, trace));
      const exported = await modules.beginDispatchExport(PASSWORDS.root);
      const data = await modules.exportDispatchData(exported.source, exportFiles);
      assert.equal(data.fullSiteComplete, false);
      for (const key of KEYS) assert.equal((await readFile(exportFiles.files.get(pathFor(key)))).toString(), pkg.texts[key]);
      await exported.close();
      modules.setBridge(bridge(db, session, trace));
      const imported = modules.createDispatchImportSession(randomUUID(), PASSWORDS.root);
      assert.equal(imported.identity(), null);
      const result = await modules.stageDispatchImport(data.catalog, exportFiles, imported.target, { onProgress: p => progress.push(p) });
      preparation(result.dryRun); assert.equal(result.fullSiteComplete, false);
      assert.ok(progress.every(p => p.fullSiteComplete === false));
      const identity = imported.identity(), job = { job_id: identity.jobId, job_token: identity.jobToken };
      const returnedIdentity = imported.identity(); returnedIdentity.jobToken = randomUUID();
      assert.equal(imported.identity().jobToken, job.job_token);
      const backup = await imported.backup(), frozen = structuredClone(backup.descriptor);
      // Public descriptor tampering must not alter source/receiver closure bindings.
      backup.descriptor.plan_hash = hash('forged public plan'); backup.descriptor.backup_id = randomUUID();
      backup.descriptor.catalog.tables[0].rows = 999999;
      assert.deepEqual(await backup.source.catalog(), frozen.catalog);
      let opens = 0, eof = 0;
      const file = {
        async write(stream) {
          const handle = await open(cipherPath, 'wx');
          try { for await (const bytes of stream) await handle.writeFile(bytes); await handle.sync(); }
          finally { await handle.close(); }
        },
        open() { opens++; return (async function* () { yield* diskSource(cipherPath); eof++; })(); },
      };
      const receiver = {
        append(no, hex, signal) { assert.equal(opens, 2); assert.ok(eof >= 1, 'authenticate independent saved file through EOF before upload'); return backup.receiver.append(no, hex, signal); },
        seal: (...args) => backup.receiver.seal(...args),
      };
      const backed = await modules.createDispatchBackup(frozen, backup.source, backupFiles, file, receiver, PASSPHRASE);
      const disk = await readFile(cipherPath); assert.equal(opens, 2); assert.equal(eof, 2);
      assert.equal(backed.cipherSha256, hash(disk)); assert.equal(backed.bytes, disk.length); assert.ok(backed.chunks > 1);
      assert.equal(disk.subarray(0, 8).toString(), 'EDXSTRM1'); assert.equal(disk.includes(Buffer.from('目標備份原文')), false);
      for (const path of backupFiles.files.values()) await assert.rejects(stat(path), { code: 'ENOENT' });
      const recovered = [];
      for (let no = 0; no < backed.chunks; no++) {
        const chunk = await saved(job.job_id, no); assert.equal(chunk.sha256, hash(disk)); assert.equal(chunk.bytes, disk.length);
        assert.equal(chunk.chunks, backed.chunks); recovered.push(Buffer.from(chunk.hex, 'hex'));
      }
      assert.deepEqual(Buffer.concat(recovered), disk);
      const plaintext = new Map();
      const manifest = await modules.verifyEncryptedVolume(diskSource(cipherPath), PASSPHRASE, {
        async append(path, bytes) { if (!plaintext.has(path)) plaintext.set(path, []); plaintext.get(path).push(Buffer.from(bytes)); },
        async abort() { assert.fail('independent saved backup must authenticate'); },
      }, { expectedMetadata: { exportId: job.job_id, volumeId: job.job_id } });
      assert.equal(manifest.scope, 'replacement-backup'); assert.equal(manifest.entries.length, 7);
      for (const table of frozen.catalog.tables) {
        const text = Buffer.concat(plaintext.get(pathFor(table.key))).toString();
        assert.equal(lines(text).length, table.rows); assert.equal(Buffer.byteLength(text), table.bytes); assert.equal(rowHashes(text), table.row_hashes_sha256);
      }
      assert.match(Buffer.concat(plaintext.get(pathFor('valid_order_data'))).toString(), /98765432109876543210\.9876543210987654321/);
      assert.equal(backed.sealReceipt.full_site_complete, false);
      assert.equal((await backup.receiver.seal(hash(disk), disk.length)).repeated, true);
      assert.ok(trace.filter(e => /backup_(append|seal)$/.test(e.name)).every(e => e.args.p_plan_hash === frozen.plan_hash));
      assert.equal(trace.some(e => /apply|finish/.test(e.name)), false);
      assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [job.job_id]), 'running');
      assert.deepEqual(await imported.cancel(), { success: true, cancelled: true });
      assert.equal(await stageCount(job), 0); assert.equal(await backupCount(job), 1);
      assert.deepEqual(Buffer.from((await saved(job.job_id)).hex, 'hex'), recovered[0]);
      assert.equal(await lastExport(), beforeTime);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, source)));

for (const key of KEYS) test(`missing staged table ${key} cannot freeze a preparation or backup`, () => transaction(async () => {
  const job = await begin(); await stageAll(job, pkg, key);
  await assert.rejects(dryRun(job), /catalog verification failed/);
  assert.equal(await backupCount(job), 0); await assert.rejects(descriptor(job), /verified dispatch preparation/);
}));

for (const [label, mutate] of [
  ['unknown catalog key', c => { c.unreviewed = true; }],
  ['wrong scope', c => { c.scope = 'product-catalog'; }],
  ['table order', c => { c.tables.reverse(); }],
  ['negative count', c => { c.tables[0].rows = -1; }],
  ['noninteger count', c => { c.tables[0].rows = 1.5; }],
  ['uppercase hash', c => { c.tables[0].row_hashes_sha256 = 'A'.repeat(64); }],
  ['full-site completion', c => { c.full_site_complete = true; }],
]) test(`catalog rejects ${label} before creating a task`, () => transaction(async () => {
  const input = structuredClone(pkg); mutate(input.catalog);
  await assert.rejects(begin(input), /catalog/);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status='running'"), 0);
}));

for (const [label, mutate] of [
  ['hash', c => { c.tables[0].row_hashes_sha256 = hash('incorrect'); }],
  ['count', c => { c.tables[0].rows++; }],
  ['bytes', c => { c.tables[0].bytes++; }],
]) test(`staged ${label} mismatch rejects dry-run without a backup`, () => transaction(async () => {
  const input = structuredClone(pkg); mutate(input.catalog); const job = await begin(input); await stageAll(job, input);
  await assert.rejects(dryRun(job), /catalog verification failed/); assert.equal(await backupCount(job), 0);
}));

test('stage repeated identity is idempotent, conflicting bytes and post-freeze chunks are rejected', () => transaction(async () => {
  const job = await begin(); const key = 'dispatch_groups'; const text = pkg.texts[key];
  assert.equal((await stage(job, key, text)).repeated, false);
  assert.equal((await stage(job, key, text)).repeated, true);
  const changed = await edited(key, "jsonb_set(body,'{description}','\"changed\"'::jsonb)", 'ordinal=1');
  await assert.rejects(stage(job, key, changed.texts[key]), /identity has different contents/);
  await stageAll(job, pkg, key); await dryRun(job);
  await assert.rejects(stage(job, key, text), /frozen dispatch preparation/);
}));

test('stage requires contiguous chunks and strict ID order both within and across chunks', () => transaction(async () => {
  const job = await begin(), key = 'dispatch_group_orders', all = lines(pkg.texts[key]);
  await assert.rejects(stage(job, key, all[0], 1), /catalog or cursor order/);
  await assert.rejects(stage(job, key, all[1] + all[0]), /strictly ordered/);
  await assert.rejects(stage(job, key, all[0] + all[0]), /strictly ordered/);
  await stage(job, key, all[1]);
  await assert.rejects(stage(job, key, all[0], 1), /catalog or cursor order/);
  assert.equal(await stageCount(job), 1);
}));

for (const [label, key, make] of [
  ['unknown table', 'orders', () => '{}\n'],
  ['unknown row key', 'dispatch_groups', () => pkg.texts.dispatch_groups.replace('{', '{"unknown_secret":true,')],
  ['missing field', 'dispatch_group_members', async () => (await edited('dispatch_group_members', "body-'assigned_at'")).texts.dispatch_group_members],
  ['duplicate JSON key', 'dispatch_groups', () => pkg.texts.dispatch_groups.replace('{', '{"id":"' + id(300) + '",')],
  ['boolean string', 'dispatch_groups', async () => (await edited('dispatch_groups', "jsonb_set(body,'{is_active}','\"false\"'::jsonb)")).texts.dispatch_groups],
  ['required null', 'dispatch_order_pools', async () => (await edited('dispatch_order_pools', "jsonb_set(body,'{pool_name}','null'::jsonb)")).texts.dispatch_order_pools],
  ['numeric string', 'valid_order_data', async () => (await edited('valid_order_data', "jsonb_set(body,'{product_value}','\"1.25\"'::jsonb)")).texts.valid_order_data],
  ['numeric typmod precision loss', 'dispatch_groups', async () => (await edited('dispatch_groups', "jsonb_set(body,'{commission_rate}','0.123456789'::jsonb)")).texts.dispatch_groups],
  ['constraint violation', 'dispatch_groups', async () => (await edited('dispatch_groups', "jsonb_set(body,'{dispatch_success_rate}','101'::jsonb)")).texts.dispatch_groups],
  ['invalid timestamp', 'dispatch_group_members', async () => (await edited('dispatch_group_members', "jsonb_set(body,'{assigned_at}','\"2026-01-01T25:00:00Z\"'::jsonb)")).texts.dispatch_group_members],
]) test(`stage rejects ${label} atomically`, () => transaction(async () => {
  const job = await begin(); await assert.rejects(stage(job, key, await make()), /Invalid dispatch import|Invalid dispatch identity|Unreviewed/);
  assert.equal(await stageCount(job), 0);
}));

test('stage enforces LF, 200 rows, 256KiB chunks and 64KiB lines independently', () => transaction(async () => {
  const job = await begin(), key = 'dispatch_group_orders', all = lines(pkg.texts[key]);
  for (const text of [all[0].trimEnd(), all.slice(0, 201).join(''), 'x'.repeat(262144) + '\n',
    all[0].replace('來源原文', 'x'.repeat(65536))]) await assert.rejects(stage(job, key, text), /chunk|limits/);
  assert.equal(await stageCount(job), 0);
}));

for (const [label, key, expression, predicate, pattern] of [
  ['missing source default', 'dispatch_groups', "jsonb_set(body,'{is_default}','false'::jsonb)", 'true', /default.*ambiguous or missing/],
  ['multiple source defaults', 'dispatch_groups', "jsonb_set(body,'{is_default}','true'::jsonb)", 'true', /default.*ambiguous or missing/],
  ['missing Base', 'dispatch_order_pools', "jsonb_set(body,'{is_base}','false'::jsonb)", 'true', /base pool.*ambiguous or missing/],
  ['multiple Base', 'dispatch_order_pools', "jsonb_set(body,'{is_base}','true'::jsonb)", `body->>'group_id'='${id(10)}'`, /base pool.*ambiguous or missing/],
  ['invalid weighted sum', 'dispatch_order_pools', "jsonb_set(body,'{trigger_probability}','29'::jsonb)", `body->>'id'='${id(100)}'`, /weighted probabilities/],
  ['pool references missing group', 'dispatch_order_pools', `jsonb_set(body,'{group_id}','"${id(404)}"'::jsonb)`, `body->>'id'='${id(100)}'`, /references are incomplete/],
  ['content references wrong pool', 'dispatch_group_orders', `jsonb_set(body,'{pool_id}','"${id(404)}"'::jsonb)`, 'ordinal=1', /references are incomplete/],
  ['membership references missing group', 'dispatch_group_members', `jsonb_set(body,'{group_id}','"${id(404)}"'::jsonb)`, 'ordinal=1', /references are incomplete/],
  ['usage references missing valid data', 'used_order_data', `jsonb_set(body,'{valid_order_data_id}','"${id(404)}"'::jsonb)`, 'true', /references are incomplete/],
  ['duplicate employee membership', 'dispatch_group_members', `jsonb_set(body,'{user_id}','"${id(1)}"'::jsonb)`, 'true', /Duplicate source dispatch business identity/],
  ['unknown configuration', 'dispatch_config', "jsonb_set(body,'{config_key}','\"unreviewed_secret\"'::jsonb)", 'ordinal=1', /Unreviewed source dispatch configuration/],
  ['negative usage', 'valid_order_data', "jsonb_set(body,'{usage_count}','-1'::jsonb)", 'true', /Invalid source submission usage/],
]) test(`dry-run rejects ${label} without filling from target defaults`, () => transaction(async () => {
  let input = await edited(key, expression, predicate);
  if (label === 'pool references missing group') {
    // Isolate the foreign-key check instead of failing earlier because moving a weighted pool
    // also changes the source group's probability sum.
    input = await edited('dispatch_groups', "jsonb_set(body,'{pool_selection_mode}','\"random\"'::jsonb)", 'true', input);
  }
  const job = await begin(input); await stageAll(job, input);
  await assert.rejects(dryRun(job), pattern); assert.equal(await backupCount(job), 0);
}));

test('unknown administrator/employee/order dependencies are only counted, never claimed mapped or applied', () => transaction(async () => {
  let input = await edited('dispatch_group_members', `jsonb_set(body,'{user_id}','"${id(405)}"'::jsonb)`, 'ordinal=2');
  input = await edited('dispatch_order_pools', `jsonb_set(body,'{created_by}','"${id(406)}"'::jsonb)`, `body->>'id'='${id(100)}'`, input);
  input = await edited('used_order_data', `jsonb_set(body,'{order_id}','"${id(407)}"'::jsonb)`, 'true', input);
  const { job, plan } = await prepared(input);
  assert.deepEqual(plan.dependencies, { administrators: 3, employees: 2, orders: 1 });
  assert.deepEqual(await scalar(db, 'SELECT admin_map FROM private.employee_transfer_jobs WHERE id=$1', [job.job_id]), {});
  assert.equal(plan.can_apply, false); assert.equal(plan.replacement_ready, false);
}));

for (const [label, change, pattern] of [
  ['new wallet funds', () => db.query('UPDATE public.wallets SET available_balance=1 WHERE user_id=$1', [id(201)]), /business history/],
  ['new order', () => addOrder(db), /business history/],
  ['new reconciliation audit', () => db.query(`INSERT INTO public.wallet_reconciliation_audit(user_id,available_before,available_after,
    frozen_before,frozen_after,income_before,income_after,pending_amount,ledger_total,reason)
    VALUES($1,1,0,0,0,0,0,0,0,'prepare local audit')`, [id(201)]), /business history/],
  ['administrator identity change', () => db.query("UPDATE public.admins SET username='branch-changed' WHERE id=$1", [NEW.branch]), /target changed/],
  ['employee identity change', () => db.query("UPDATE public.users SET employee_id='PREP-CHANGED' WHERE id=$1", [id(201)]), /target changed/],
  ['retention setting change', () => db.exec("UPDATE public.history_cleanup_config SET retention_days=retention_days+1"), /target changed/],
  ['same-count pool content change', () => db.query('UPDATE public.dispatch_order_pools SET dispatch_success_rate=90 WHERE id=$1', [targetPool]), /target changed/],
  ['same-count order content change', () => db.exec("UPDATE public.dispatch_group_orders SET order_content='same count, changed body' WHERE id=(SELECT id FROM public.dispatch_group_orders ORDER BY id LIMIT 1)"), /target changed/],
  ['same-count submission content change', () => db.query("UPDATE public.valid_order_data SET transaction_id='same-count-changed' WHERE id=$1", [id(202)]), /target changed/],
]) test(`target ${label} blocks both repeat dry-run and seal without touching changed business data`, () => transaction(async () => {
  const { job, plan } = await prepared(); const cipher = gateCipher(); await append(job, plan, 0, cipher);
  const beforeChange = await businessState(); await change(); const changed = await businessState();
  assert.notDeepEqual(changed, beforeChange, 'the mutation fixture must really change target data');
  await assert.rejects(dryRun(job), pattern); await assert.rejects(seal(job, plan, cipher), pattern);
  assert.deepEqual(await businessState(), changed);
  assert.equal(await scalar(db, 'SELECT sealed_at FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), null);
}, db, false));

test('target backup above 8MiB is rejected without truncation or a frozen backup', { timeout: 120000 }, () => transaction(async () => {
  await db.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,created_by)
    SELECT ('60000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,$1,$2,repeat('x',64000),$3
    FROM generate_series(1,132) AS n`, [targetGroup, targetPool, NEW.root]);
  const before = await businessState(); const job = await begin(); await stageAll(job);
  await assert.rejects(dryRun(job), /multi-volume support.*without truncation/);
  assert.equal(await backupCount(job), 0); assert.deepEqual(await businessState(), before);
}, db, false));

test('backup pages are frozen, bounded and reject unknown keys, invalid limits and absent cursors', () => transaction(async () => {
  const { job } = await prepared(); const frozen = await descriptor(job);
  for (const [key, after, limit] of [['orders', null, 200], ['dispatch_groups', null, 0], ['dispatch_groups', null, 201],
    ['dispatch_groups', randomUUID(), 200]]) await assert.rejects(page(job, key, after, limit), /Unknown|Invalid|cursor|Cursor/);
  for (const key of KEYS) {
    let text = '', after = null;
    do { const value = await page(job, key, after, 37); assert.equal(value.table_key, key); assert.ok(value.count <= 37);
      assert.ok(Buffer.byteLength(value.ndjson) <= 262144); assert.equal(value.sha256, hash(value.ndjson));
      text += value.ndjson; after = value.next_after;
    } while (after !== null);
    const table = frozen.catalog.tables.find(t => t.key === key); assert.equal(rowHashes(text), table.row_hashes_sha256);
  }
}));

test('encrypted backup chunks require contiguous identity, matching plan, exact repeats and valid hex/size', () => transaction(async () => {
  const { job, plan } = await prepared(); const cipher = gateCipher();
  await assert.rejects(append(job, plan, 1, cipher), /contiguous/);
  await assert.rejects(append(job, { plan_hash: hash('wrong') }, 0, cipher), /does not accept/);
  await assert.rejects(append(job, plan, 0, Buffer.alloc(131073)), /Invalid encrypted dispatch backup chunk/);
  await assert.rejects(rpc('employee_import_dispatch_backup_append', { ...auth(job), p_plan_hash: plan.plan_hash, p_chunk_no: 0, p_hex: 'FG' }), /Invalid encrypted/);
  assert.equal((await append(job, plan, 0, cipher)).repeated, false);
  assert.equal((await append(job, plan, 0, cipher)).repeated, true);
  await assert.rejects(append(job, plan, 0, gateCipher().fill(7, 20)), /identity has different contents/);
  assert.equal(await scalar(db, 'SELECT byte_count FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), cipher.length);
}));

test('seal rejects wrong hash/count/header and retrieval requires sealed own dispatch backup', () => transaction(async () => {
  const { job, plan } = await prepared(); const cipher = gateCipher();
  await assert.rejects(saved(job.job_id), /unavailable/);
  await append(job, plan, 0, cipher);
  await assert.rejects(seal(job, plan, cipher, hash('wrong')), /does not match/);
  await assert.rejects(seal(job, plan, cipher, hash(cipher), cipher.length + 1), /does not match/);
  await assert.rejects(seal(job, { plan_hash: hash('wrong') }, cipher), /Invalid dispatch backup seal/);
  await seal(job, plan, cipher);
  for (const no of [-1, 1]) await assert.rejects(saved(job.job_id, no), /unavailable/);
  await assert.rejects(saved(job.job_id, 0, otherRoot), /unavailable/);
  await assert.rejects(append(job, plan, 1, cipher), /does not accept/);
  await cancel(job);
  const next = await prepared(); const invalidHeader = Buffer.alloc(96, 0xa5);
  await append(next.job, next.plan, 0, invalidHeader);
  await assert.rejects(seal(next.job, next.plan, invalidHeader), /does not match/);
}));

test('super-admin permission, second password, invalid and revoked financial session fail closed', () => transaction(async () => {
  await assert.rejects(begin(pkg, branch, PASSWORDS.branch), /Super administrator/);
  // Emergency administrators are excluded by the underlying financial session validator itself.
  await assert.rejects(begin(pkg, emergency, PASSWORDS.emergency), /invalid or expired/i);
  await assert.rejects(begin(pkg, randomUUID()), /invalid or expired/i);
  assert.equal((await begin(pkg, session, 'wrong-local-password')).success, false);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status='running'"), 0);
  const job = await begin();
  await db.query('UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE admin_id=$1', [NEW.root]);
  await assert.rejects(dryRun(job), /invalid or expired/i);
}));

test('another super-admin cannot use task token and idle/absolute expiry block staging', () => transaction(async () => {
  const job = await begin();
  await assert.rejects(rpc('employee_import_dispatch_stage', { ...auth(job, otherRoot), p_table_key: 'dispatch_config', p_chunk_no: 0, p_ndjson: pkg.texts.dispatch_config }), /invalid or expired/);
  await db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", [job.job_id]);
  await assert.rejects(stage(job, 'dispatch_config'), /invalid or expired/);
  await db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now(),started_at=now()-interval '13 hours' WHERE id=$1", [job.job_id]);
  await assert.rejects(stage(job, 'dispatch_config'), /invalid or expired/);
}));

test('same-site catalog identity and absent package identity are rejected', () => transaction(async () => {
  const input = structuredClone(pkg); input.catalog.site_id = await scalar(db, 'SELECT site_id FROM private.employee_transfer_site');
  await assert.rejects(begin(input), /source identity/);
  await assert.rejects(begin({ ...pkg, packageId: null }), /source identity/);
}));

for (const [name, extra] of [
  ['employee_import_finish', { p_summary: { full_site_complete: true } }],
  ['employee_import_stage_chunk', { p_employee_id: id(1), p_table_key: 'account', p_chunk_no: 0, p_rows: [] }],
  ['employee_import_apply_core', { p_employee_id: id(1), p_expected: {} }],
  ['employee_import_rows_batch', { p_employee_id: id(1), p_table_key: 'orders', p_rows: [] }],
  ['employee_import_chat_batch', { p_employee_id: id(1), p_table_key: 'chat_messages', p_rows: [] }],
  ['employee_import_products_stage', { p_chunk_no: 0, p_ndjson: '' }],
  ['employee_import_shared_stage', { p_table_key: 'admins', p_chunk_no: 0, p_ndjson: '' }],
]) test(`dispatch token cannot bypass preparation through ${name}`, () => transaction(async () => {
  const job = await begin(); await assert.rejects(rpc(name, { ...auth(job), ...extra }), /protocol/);
  assert.equal(await stageCount(job), 0);
  assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [job.job_id]), 'running');
}));

test('legacy task cannot stage dispatch rows or forge reserved dispatch protocol markers', () => transaction(async () => {
  for (const reserved of ['import_protocol', 'export_protocol', 'catalog', 'package_id']) await assert.rejects(rpc('employee_import_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_decisions: {}, p_summary: { [reserved]: 'dispatch-submission-v1' },
  }), /Reserved/);
  const job = await rpc('employee_import_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_decisions: {} });
  await assert.rejects(stage(job, 'dispatch_config'), /protocol/); await cancel(job);
}));

test('cancel clears source staging and unsealed backup, is idempotent and never advances full-export time', () => transaction(async () => {
  const before = await lastExport(); const { job, plan } = await prepared(); await append(job, plan, 0, gateCipher());
  assert.ok(await stageCount(job)); assert.equal(await backupCount(job), 1);
  assert.deepEqual(await cancel(job), { success: true, cancelled: true });
  assert.equal(await stageCount(job), 0); assert.equal(await backupCount(job), 0);
  assert.deepEqual(await cancel(job), { success: true, cancelled: false });
  await assert.rejects(dryRun(job), /invalid or expired/); await assert.rejects(saved(job.job_id), /unavailable/);
  assert.equal(await lastExport(), before);
}));

test('cancel preserves sealed ciphertext independently of expired job while clearing staging and keeping full-export time', () => transaction(async () => {
  const before = await lastExport(); const { job, plan } = await prepared(); const cipher = gateCipher();
  await append(job, plan, 0, cipher); await seal(job, plan, cipher); await cancel(job);
  assert.equal(await stageCount(job), 0); assert.equal(await backupCount(job), 1);
  assert.equal((await saved(job.job_id)).hex, cipher.toString('hex'));
  assert.equal(await lastExport(), before);
}));

test('new task abandons stale preparation and removes only unsealed backups', () => transaction(async () => {
  const { job, plan } = await prepared(); await append(job, plan, 0, gateCipher());
  await db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", [job.job_id]);
  const next = await begin(); assert.equal(next.success, true);
  assert.equal(await backupCount(job), 0); assert.equal(await stageCount(job), 0);
  assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [job.job_id]), 'abandoned');
}));

test('12,001 valid submission rows export and stage once without float loss, truncation, apply or audit writes', { timeout: 180000 }, () => transaction(async () => transaction(async () => {
  await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by)
    SELECT ('30000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,12.34567890123456789,'large-prepare-'||n,$1
    FROM generate_series(1,12000) AS n`, [OLD.root]);
  const input = await captureExport(); assert.equal(input.catalog.tables.find(t => t.key === 'valid_order_data').rows, 12001);
  const { job, plan } = await prepared(input);
  assert.equal(plan.counts.valid_order_data, 12001);
  assert.equal(await scalar(db, `SELECT count(*)::int FROM private.employee_transfer_staging
    WHERE job_id=$1 AND table_key='dispatch-in:valid_order_data'`, [job.job_id]), 61);
  const exact = await scalar(db, `SELECT body->>'product_value' FROM private.employee_transfer_dispatch_input($1,'valid_order_data') WHERE id=$2`, [job.job_id, id(102)]);
  assert.equal(exact, '12345678901234567890.1234567890123456789');
}, source, false)));
