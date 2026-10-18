import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSites, adminLogin, rpc as baseRpc, scalar, rows } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';
import { TRANSFER_SCOPE_COVERAGE_INVENTORY } from './support/transfer-scope.mjs';

// Real local migrations/RPCs only. No production requests, cron changes, guard stubs,
// public apply substitute or claim of native PostgreSQL multi-connection testing.
const migration = '20261102000011_guard_transfer_maintenance.sql';
const root = fileURLToPath(new URL('../../', import.meta.url));
const KEYS = ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders',
  'dispatch_group_members', 'valid_order_data', 'used_order_data'];
const EXCLUDED = ['private.employee_transfer_events', 'private.employee_transfer_excluded_columns',
  'private.employee_transfer_jobs', 'private.employee_transfer_shared_backups', 'private.employee_transfer_site',
  'private.employee_transfer_staging', 'private.employee_transfer_trigger_policy', 'public.admin_financial_sessions',
  'public.financial_login_attempts', 'public.account_locks', 'public.account_lock_events', 'public.login_attempts'];
// Use the reviewed 104-root subset even when the main thread subsequently adds the two
// maintenance tables to the shared inventory. Unexpected other roots still fail this test.
const guarded = TRANSFER_SCOPE_COVERAGE_INVENTORY.map(t => `${t.schema}.${t.name}`)
  .filter(name => !EXCLUDED.includes(name) && !['private.employee_transfer_maintenance', 'private.employee_transfer_write_permits'].includes(name))
  .concat(['public.orders_history_2025', 'public.orders_history_2026']).sort();
const RPCS = ['employee_import_dispatch_enter_maintenance', 'get_employee_transfer_maintenance', 'employee_transfer_leave_maintenance'];
const HELPERS = ['employee_transfer_guarded_tables', 'employee_transfer_guard_write', 'employee_transfer_lock_maintenance_tables',
  'employee_transfer_assert_maintenance_guards', 'employee_transfer_allow_config_write', 'employee_transfer_clear_write_permit'];
const AUDITS = ['employee_transfer_assert_shared_insert_triggers', 'employee_transfer_assert_shared_replace_triggers', 'employee_transfer_assert_product_triggers'];
const PAUSED = 'Business writes are paused for employee transfer maintenance.';
const ENTER = '確認暫停業務並導入派單資料', LEAVE = '確認取消尚未寫入的遷移';
const OTHER_ROOT = '11000000-0000-4000-8000-000000000001';
const EMPLOYEE = '11000000-0000-4000-8000-000000000002';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let replay, db, source, session, otherSession, branch, emergency, sourceSession, job, plan, pkg, cipher, backupApi, sequence = 0;

async function isolated(site, fn, role = null) {
  const savepoint = `maintenance_test_${++sequence}`;
  await site.exec(`SAVEPOINT ${savepoint}`);
  try {
    if (role) await site.exec(`SET LOCAL ROLE ${role}`);
    const value = await fn();
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${savepoint}`);
    return value;
  } catch (error) {
    await site.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
const on = (site, name, args) => isolated(site, () => baseRpc(site, name, args, { role: null }), 'anon');
const rpc = (name, args) => on(db, name, args);
const auth = (task = job, token = session) => ({ p_admin_session_token: token, p_job_token: task.job_token });
const enter = (overrides = {}) => rpc('employee_import_dispatch_enter_maintenance', {
  ...auth(), p_plan_hash: plan.plan_hash, p_confirmation: ENTER, p_admin_password: PASSWORDS.root, ...overrides,
});
const leave = (overrides = {}) => rpc('employee_transfer_leave_maintenance', {
  p_admin_session_token: session, p_job_id: job.job_id, p_admin_password: PASSWORDS.root, p_confirmation: LEAVE, ...overrides,
});
const status = (token = session) => rpc('get_employee_transfer_maintenance', { p_admin_session_token: token });
const cancel = () => rpc('employee_transfer_cancel', auth());
const clean = () => ({ active: false, job_id: null, dirty: false, full_site_complete: false });
const active = (dirty = false) => ({ active: true, job_id: job.job_id, dirty, full_site_complete: false });
const receipt = repeated => ({ success: true, maintenance: true, dirty: false, repeated, full_site_complete: false });
const assertGuards = () => scalar(db, 'SELECT private.employee_transfer_assert_maintenance_guards()');
const permitCount = () => scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits');
async function transaction(fn) {
  await db.exec('BEGIN');
  try { return await fn(); }
  finally { await db.exec('ROLLBACK'); }
}
async function blocked(fn) {
  await assert.rejects(isolated(db, fn), error => {
    assert.equal(error.message, PAUSED); assert.equal(error.code, '55000'); return true;
  });
}
async function businessState() {
  return rows(db, guarded.map(name => `SELECT '${name}' AS name, count(*)::int AS count,
    md5(COALESCE(string_agg(to_jsonb(r)::text,E'\n' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} AS r`).join(' UNION ALL '));
}

async function sourceExport() {
  const task = await on(source, 'employee_export_dispatch_begin', { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root });
  const texts = {};
  for (const key of KEYS) {
    let text = '', after = null;
    do {
      const page = await on(source, 'get_employee_export_dispatch_page', {
        ...auth(task, sourceSession), p_table_key: key, p_after: after, p_limit: 200,
      });
      assert.equal(page.sha256, hash(page.ndjson)); text += page.ndjson; after = page.next_after;
    } while (after !== null);
    texts[key] = text;
  }
  assert.equal((await on(source, 'employee_export_dispatch_verify', auth(task, sourceSession))).verified, true);
  await on(source, 'employee_export_dispatch_close', auth(task, sourceSession));
  return { catalog: task.catalog, texts, packageId: randomUUID() };
}
async function prepare() {
  const task = await rpc('employee_import_dispatch_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: pkg.packageId, p_catalog: pkg.catalog,
  });
  assert.equal(task.success, true);
  for (const key of KEYS) await rpc('employee_import_dispatch_stage', {
    ...auth(task), p_table_key: key, p_chunk_no: 0, p_ndjson: pkg.texts[key],
  });
  const dry = await rpc('get_employee_import_dispatch_dry_run', auth(task));
  assert.equal(dry.can_apply, false); assert.equal(dry.full_site_complete, false);
  return { task, dry };
}
async function sealRealBackup(task, dry) {
  const descriptor = await rpc('get_employee_import_dispatch_backup', auth(task));
  const directory = await mkdtemp(join(tmpdir(), 'transfer-maintenance-'));
  const path = join(directory, 'independent.edx');
  const temporary = new Map();
  async function* stream(bytes) { yield bytes; }
  try {
    const result = await backupApi.createDispatchBackup(descriptor, {
      async catalog() { return descriptor.catalog; },
      page: (key, after) => rpc('get_employee_import_dispatch_backup_page', {
        ...auth(task), p_table_key: key, p_after: after, p_limit: 200,
      }),
      async verify() { return { verified: true, scope: 'dispatch-submission', full_site_complete: false }; },
    }, {
      async append(name, bytes) { temporary.set(name, Buffer.concat([temporary.get(name) ?? Buffer.alloc(0), Buffer.from(bytes)])); },
      open(name) { return stream(temporary.get(name)); },
      async abort() { temporary.clear(); },
    }, {
      async write(input) { const parts = []; for await (const bytes of input) parts.push(Buffer.from(bytes)); await writeFile(path, Buffer.concat(parts), { flag: 'wx' }); },
      async *open() { yield await readFile(path); },
    }, {
      append: (no, hex) => rpc('employee_import_dispatch_backup_append', {
        ...auth(task), p_plan_hash: dry.plan_hash, p_chunk_no: no, p_hex: hex,
      }),
      seal: (sha256, bytes) => rpc('employee_import_dispatch_backup_seal', {
        ...auth(task), p_plan_hash: dry.plan_hash, p_sha256: sha256, p_bytes: bytes,
      }),
    }, 'local-only-maintenance-independent-passphrase');
    const bytes = await readFile(path);
    assert.equal(bytes.subarray(0, 8).toString(), 'EDXSTRM1');
    assert.equal(result.cipherSha256, hash(bytes)); assert.equal(result.bytes, bytes.length);
    assert.equal(result.sealReceipt.full_site_complete, false); assert.equal(temporary.size, 0);
    // The real client authenticated the saved AES-GCM/ZIP and compared its catalog. The
    // server has no passphrase: its seal proves cipher length/magic/hash ONLY, not plaintext.
    return bytes;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

before(async () => {
  replay = await createSites({ upTo: migration }); source = replay.oldSite; db = replay.newSite;
  await db.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await buildNewSite(source); await buildNewSite(db);
  // The platform substitute omits Supabase's default table grants. Model the documented
  // anon-writable product surface locally; do NOT grant or alter anything in production.
  await db.exec('GRANT SELECT,INSERT,UPDATE,DELETE ON public.product_types TO anon');
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    VALUES($1,'maintenance-other-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [OTHER_ROOT, PASSWORDS.root]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [OTHER_ROOT]);
  await db.query(`INSERT INTO public.users(id,username,password_hash,employee_id,created_by,is_active)
    VALUES($1,'maintenance-employee',extensions.crypt($2,extensions.gen_salt('bf',4)),'MAINT-1',$3,true)`, [EMPLOYEE, PASSWORDS.employee, NEW.root]);
  await db.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [EMPLOYEE]);
  sourceSession = await adminLogin(source, 'root', PASSWORDS.root); session = await adminLogin(db, 'root', PASSWORDS.root);
  otherSession = await adminLogin(db, 'maintenance-other-root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  // Pure client bundling; no auth/transport mocks and no output file written into the repo.
  const compiled = await build({ stdin: { contents: "export { createDispatchBackup } from './src/lib/employeeTransfer/dispatchBackup.ts';",
    resolveDir: root, sourcefile: 'maintenance-backup-entry.mjs' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020' });
  backupApi = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  await source.exec('BEGIN');
  try { pkg = await sourceExport(); } finally { await source.exec('COMMIT'); }
  await db.exec('BEGIN');
  try {
    const prepared = await prepare(); job = prepared.task; plan = prepared.dry;
    cipher = await sealRealBackup(job, plan);
    await db.exec('COMMIT');
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
  mock.method(globalThis, 'fetch', () => assert.fail('maintenance tests prohibit network access'));
}, { timeout: 180000 });
after(async () => { mock.restoreAll(); await Promise.all([source?.close(), db?.close()]); });

test('538 real SQL migrations through 11 retain exactly 12 known historical gaps, not a clean native PG build', () => {
  assert.equal(replay.files.length, 538); assert.equal(replay.files.at(-1), migration);
  assert.equal(replay.validation.matched.length, 12); assert.equal(replay.failures.length, 12);
  assert.equal(replay.validation.freshDatabaseVerified, false);
});

test('private tables are RLS-protected without browser/service grants; three public RPCs use fixed SECURITY DEFINER grants', () => transaction(async () => {
  for (const table of ['employee_transfer_maintenance', 'employee_transfer_write_permits']) {
    assert.equal(await scalar(db, 'SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass', [`private.${table}`]), true);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])
        assert.equal(await scalar(db, 'SELECT has_table_privilege($1,$2,$3)', [role, `private.${table}`, privilege]), false);
    }
    await assert.rejects(isolated(db, () => db.exec(`SELECT * FROM private.${table}`), 'anon'), /permission denied/);
  }
  const functions = await rows(db, `SELECT proname,prosecdef,proconfig,
    has_function_privilege('anon',oid,'EXECUTE') AS anon,has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`, [RPCS]);
  assert.equal(functions.length, 3);
  for (const fn of functions) {
    assert.equal(fn.prosecdef, true); assert.equal(fn.anon, true); assert.equal(fn.authenticated, true);
    assert.equal(fn.public_execute, false); assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
  }
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db,
    `SELECT count(*)::int FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname=ANY($1::text[]) AND has_function_privilege($2,oid,'EXECUTE')`, [HELPERS, role]), 0);
  await assert.rejects(isolated(db, () => db.query('SELECT private.employee_transfer_allow_config_write($1)', [job.job_id]), 'anon'), /permission denied/);
  const permitColumns = await rows(db, `SELECT attname,format_type(atttypid,atttypmod) AS type FROM pg_attribute
    WHERE attrelid='private.employee_transfer_write_permits'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`);
  assert.deepEqual(permitColumns, [{ attname: 'transaction_id', type: 'xid8' }, { attname: 'job_id', type: 'uuid' }, { attname: 'table_names', type: 'text[]' }]);
}));

test('fixed 92 business roots plus both history leaves have BEFORE STATEMENT all-write ALWAYS guards; existing triggers remain enabled', () => transaction(async () => {
  assert.equal(guarded.length, 94);
  assert.deepEqual(await scalar(db, 'SELECT private.employee_transfer_guarded_tables()'), guarded);
  const triggers = await rows(db, `SELECT n.nspname||'.'||c.relname AS name,t.tgtype,t.tgenabled,t.tgisinternal,
    t.tgfoid='private.employee_transfer_guard_write()'::regprocedure AS correct_function
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE t.tgname='zz_employee_transfer_maintenance' ORDER BY (n.nspname||'.'||c.relname) COLLATE "C"`);
  assert.equal(triggers.length, 94);
  for (const t of triggers) { assert.equal(t.tgtype, 62); assert.equal(t.tgenabled, 'A'); assert.equal(t.tgisinternal, false); assert.equal(t.correct_function, true); }
  assert.equal(await scalar(db, `SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgname<>'zz_employee_transfer_maintenance' AND tgenabled<>'O'`), 0);
  await assertGuards();
}));

test('outside maintenance normal no-op business writes and anon product INSERT/UPDATE/DELETE, employee/admin login work', () => transaction(async () => {
  assert.deepEqual(await status(), clean());
  for (const table of guarded) await db.exec(`DELETE FROM ${table} WHERE false`);
  await isolated(db, () => db.exec("INSERT INTO public.product_types(name) VALUES('maintenance-normal-product'); UPDATE public.product_types SET name='maintenance-normal-renamed' WHERE name='maintenance-normal-product'; DELETE FROM public.product_types WHERE name='maintenance-normal-renamed'"), 'anon');
  const employee = await rpc('create_employee_financial_session', { p_username: 'maintenance-employee', p_password: PASSWORDS.employee, p_tab_id: 'maintenance-normal-tab' });
  assert.equal(employee.success, true);
  assert.ok(await isolated(db, () => adminLogin(db, 'root', PASSWORDS.root)));
}));

test('real seven-table source export -> stage/dry-run -> independent authenticated AES-GCM/ZIP seal is required before enter', () => transaction(async () => {
  assert.ok(cipher.length > 64);
  const saved = await rpc('get_employee_dispatch_saved_backup_chunk', { p_admin_session_token: session, p_backup_id: job.job_id, p_chunk_no: 0 });
  assert.equal(saved.hex, cipher.toString('hex')); assert.equal(saved.sha256, hash(cipher));
  const before = await businessState();
  assert.deepEqual(await enter(), receipt(false)); assert.deepEqual(await enter(), receipt(true));
  assert.deepEqual(await status(), active()); assert.deepEqual(await status(otherSession), active());
  assert.equal(await permitCount(), 0); assert.deepEqual(await businessState(), before);
  assert.deepEqual(await leave(), { success: true, maintenance: false, full_site_complete: false });
  assert.deepEqual(await status(), clean()); assert.deepEqual(await businessState(), before);
  assert.equal((await rpc('get_employee_dispatch_saved_backup_chunk', { p_admin_session_token: session, p_backup_id: job.job_id, p_chunk_no: 0 })).hex, saved.hex);
}));

for (const [label, override, pattern] of [
  ['secondary admin', () => ({ p_admin_session_token: branch, p_admin_password: PASSWORDS.branch }), /Super administrator/],
  ['emergency admin', () => ({ p_admin_session_token: emergency }), /invalid or expired/i],
  ['invalid session', () => ({ p_admin_session_token: randomUUID() }), /invalid or expired/i],
  ['other super-admin task access', () => ({ p_admin_session_token: otherSession }), /invalid or expired/i],
  ['wrong token', () => ({ p_job_token: randomUUID() }), /invalid or expired/i],
  ['wrong plan', () => ({ p_plan_hash: hash('wrong') }), /preparation plan/],
  ['null plan', () => ({ p_plan_hash: null }), /preparation plan/],
  ['wrong confirmation', () => ({ p_confirmation: '确认暂停业务并导入派单资料' }), /confirmation/],
]) test(`enter rejects ${label} without creating maintenance or a permit`, () => transaction(async () => {
  await assert.rejects(enter(override()), pattern); assert.deepEqual(await status(), clean()); assert.equal(await permitCount(), 0);
}));

test('wrong second passwords persist rate-limit attempts and never enter/leave maintenance', () => transaction(async () => {
  assert.equal((await enter({ p_admin_password: 'wrong' })).success, false);
  assert.equal(await scalar(db, "SELECT failed_attempts FROM public.financial_login_attempts WHERE username='root' AND account_type='admin'"), 1);
  await enter(); assert.equal((await leave({ p_admin_password: 'wrong' })).success, false);
  assert.deepEqual(await status(), active());
}));

test('a genuinely new unprepared/unsealed task cannot enter; incomplete source staging cannot prepare', () => transaction(async () => {
  await cancel(); const task = await rpc('employee_import_dispatch_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: pkg.packageId, p_catalog: pkg.catalog,
  });
  await assert.rejects(enter({ p_job_token: task.job_token }), /preparation plan/);
  await assert.rejects(rpc('get_employee_import_dispatch_dry_run', auth(task)), /catalog verification/);
  for (const key of KEYS) await rpc('employee_import_dispatch_stage', { ...auth(task), p_table_key: key, p_chunk_no: 0, p_ndjson: pkg.texts[key] });
  const dry = await rpc('get_employee_import_dispatch_dry_run', auth(task));
  await assert.rejects(enter({ p_job_token: task.job_token, p_plan_hash: dry.plan_hash }), /saved and sealed/);
  assert.deepEqual(await status(), clean());
}));

for (const [label, sql] of [
  ['same-count dispatch target drift', "UPDATE public.dispatch_order_pools SET dispatch_success_rate=37 WHERE is_base"],
  ['retention target drift', 'UPDATE public.history_cleanup_config SET retention_days=retention_days+1'],
  ['administrator identity drift', "UPDATE public.admins SET username='maintenance-changed-branch' WHERE id='" + NEW.branch + "'"],
]) test(`enter rechecks sealed target fingerprint: ${label}`, () => transaction(async () => {
  await db.exec(sql); const before = await businessState();
  await assert.rejects(enter(), /target changed/); assert.deepEqual(await status(), clean()); assert.deepEqual(await businessState(), before);
}));

// These zero-row DELETEs exercise every statement guard, including postgres, audit/cleanup,
// money/automation/chat/announcement tables, root partitions and direct leaf access.
for (const table of guarded) test(`maintenance blocks direct postgres no-op DELETE on ${table}`, () => transaction(async () => {
  await enter(); await blocked(() => db.exec(`DELETE FROM ${table} WHERE false`)); assert.deepEqual(await status(), active());
}));

for (const sql of [
  "INSERT INTO public.product_types(name) SELECT 'maintenance-blocked' WHERE false",
  "UPDATE public.product_types SET name=name WHERE false",
  'DELETE FROM public.product_types WHERE false',
]) test(`anon's otherwise writable product table is blocked for ${sql.split(' ')[0]}`, () => transaction(async () => {
  await enter(); await blocked(() => isolated(db, () => db.exec(sql), 'anon'));
}));

for (const table of ['public.dispatch_config', 'public.orders_history_2025', 'public.orders_history_2026'])
  test(`maintenance blocks TRUNCATE of ${table}`, () => transaction(async () => {
    await enter(); await blocked(() => db.exec(`TRUNCATE ${table}`));
  }));

test('ALWAYS guards still block postgres replica mode including direct leaf UPDATE/DELETE/TRUNCATE', () => transaction(async () => {
  await enter(); await db.exec("SET LOCAL session_replication_role='replica'");
  await blocked(() => db.exec('DELETE FROM public.announcements WHERE false'));
  for (const table of ['public.orders_history_2025', 'public.orders_history_2026']) {
    await blocked(() => db.exec(`UPDATE ${table} SET status=status WHERE false`));
    await blocked(() => db.exec(`DELETE FROM ${table} WHERE false`));
    await blocked(() => db.exec(`TRUNCATE ${table}`));
  }
}));

test('forged GUCs, role=postgres, unrelated/stale transaction permits never authorize a business write', () => transaction(async () => {
  await enter();
  await db.query("SELECT set_config('employee_transfer.job_id',$1,true),set_config('employee_transfer.write_permit','true',true),set_config('employee_transfer.maintenance','off',true),set_config('employee_transfer.transaction_id',pg_current_xact_id()::text,true)", [job.job_id]);
  await blocked(() => db.exec('DELETE FROM public.dispatch_config WHERE false'));
  // Privileged negative fixtures ONLY: browser roles cannot insert any permit.
  await db.query(`INSERT INTO private.employee_transfer_write_permits VALUES((pg_current_xact_id()::text::bigint+1)::text::xid8,$1,ARRAY['public.dispatch_config'])`, [job.job_id]);
  await blocked(() => db.exec('DELETE FROM public.dispatch_config WHERE false'));
  await db.query("INSERT INTO private.employee_transfer_write_permits VALUES(pg_current_xact_id(),$1,ARRAY['public.dispatch_config'])", [randomUUID()]);
  await blocked(() => db.exec('DELETE FROM public.dispatch_config WHERE false'));
}));

for (const [name, args] of [
  ['enqueue_all_wallets_for_reconciliation', ''],
  ['auto_cleanup_dispatch_system', ''],
  ['process_wallet_reconciliation_queue', '100'],
]) test(`real SECURITY DEFINER cron function ${name} cannot write in maintenance`, () => transaction(async () => {
  assert.equal(await scalar(db, "SELECT prosecdef FROM pg_proc WHERE oid=to_regprocedure($1)", [`public.${name}(${args ? 'integer' : ''})`]), true);
  await enter(); const before = await businessState();
  await blocked(() => db.exec(`SELECT public.${name}(${args})`)); assert.deepEqual(await businessState(), before);
}));

test('real due-history cron cannot even record failed cleanup during maintenance; no cron schedule is changed', () => transaction(async () => {
  // Local business fixture, before prepare: ensure a real due task exists and freeze its
  // retention settings in a new plan, rather than disabling/patching the cron function.
  await cancel();
  const due = await rows(db, "UPDATE public.history_cleanup_config SET auto_cleanup_enabled=true,schedule_time_utc='00:00' WHERE table_name='orders_history' AND can_cleanup RETURNING table_name");
  assert.equal(due.length, 1);
  const { task, dry } = await prepare(); await sealRealBackup(task, dry);
  await enter({ p_job_token: task.job_token, p_plan_hash: dry.plan_hash });
  const before = await businessState(); await blocked(() => db.exec('SELECT public.auto_cleanup_due_history_data()'));
  assert.deepEqual(await businessState(), before);
}));

for (const token of ['branch', 'emergency', 'random']) test(`maintenance status rejects ${token} session`, () => transaction(async () => {
  await assert.rejects(status(token === 'branch' ? branch : token === 'emergency' ? emergency : randomUUID()), /Super administrator|invalid or expired/i);
}));

for (const change of ['idle expiry', 'absolute expiry', 'cancel']) test(`${change} leaves maintenance in place; original super-admin new session can leave clean state`, () => transaction(async () => {
  await enter();
  if (change === 'cancel') await cancel();
  else await db.query(`UPDATE private.employee_transfer_jobs SET ${change === 'idle expiry' ? "last_activity_at=now()-interval '4 hours'" : "started_at=now()-interval '13 hours'"} WHERE id=$1`, [job.job_id]);
  await assert.rejects(enter(), /invalid or expired/); assert.deepEqual(await status(), active());
  await assert.rejects(isolated(db, () => db.query('SELECT private.employee_transfer_allow_config_write($1)', [job.job_id])), /running maintenance owner/);
  await db.query('UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE admin_id=$1', [NEW.root]);
  await assert.rejects(status(), /invalid or expired/i);
  const newSession = await isolated(db, () => adminLogin(db, 'root', PASSWORDS.root));
  assert.deepEqual(await status(newSession), active());
  assert.deepEqual(await leave({ p_admin_session_token: newSession }), { success: true, maintenance: false, full_site_complete: false });
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE id=$1 AND sealed_at IS NOT NULL', [job.job_id]), 1);
}));

test('leave requires original admin/job/confirmation and cannot accept another super-admin or an invalid session', () => transaction(async () => {
  await enter();
  await assert.rejects(leave({ p_admin_session_token: otherSession }), /original maintenance owner/);
  await assert.rejects(leave({ p_job_id: randomUUID() }), /original maintenance owner/);
  await assert.rejects(leave({ p_confirmation: 'wrong' }), /confirmation/);
  await assert.rejects(leave({ p_admin_session_token: randomUUID() }), /invalid or expired/i);
  assert.deepEqual(await status(), active());
}));

test('leave refuses changed target hash even when dirty=false; privileged corruption is not silently released', () => transaction(async () => {
  await enter();
  // postgres-only negative fixture simulates a target mismatch without disabling a guard.
  await db.query('UPDATE private.employee_transfer_maintenance SET target_hash=$1', [hash('changed')]);
  await assert.rejects(leave(), /target changed/); assert.deepEqual(await status(), active());
}));

test('private permit fixture allows exactly five dispatch tables plus empty-assignment UPDATE only; clear removes current xid only', () => transaction(async () => {
  await assert.rejects(isolated(db, () => db.query('SELECT private.employee_transfer_allow_config_write($1)', [job.job_id])), /running maintenance owner/);
  await enter();
  await assert.rejects(isolated(db, () => db.query('SELECT private.employee_transfer_allow_config_write($1)', [randomUUID()])), /running maintenance owner/);
  // This postgres-only helper call is a permission-controlled fixture, NOT public import
  // acceptance. Migration 12 must authenticate/lock/assert, allow, then clear in finally.
  await db.query('SELECT private.employee_transfer_allow_config_write($1)', [job.job_id]);
  try {
    assert.deepEqual(await status(), active(true));
    const permit = (await rows(db, 'SELECT transaction_id=pg_current_xact_id() AS current,job_id,table_names FROM private.employee_transfer_write_permits'))[0];
    assert.equal(permit.current, true); assert.equal(permit.job_id, job.job_id);
    assert.deepEqual(permit.table_names, ['public.dispatch_config','public.dispatch_groups','public.dispatch_order_pools','public.dispatch_group_orders','public.dispatch_group_members','public.dispatch_assignments']);
    for (const table of permit.table_names.slice(0, 5)) await db.exec(`DELETE FROM ${table} WHERE false`);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_assignments'), 0);
    assert.deepEqual(await rows(db, 'UPDATE public.dispatch_assignments SET dispatch_order_id=NULL RETURNING id'), []);
    await blocked(() => db.query('INSERT INTO public.dispatch_assignments(user_id) SELECT $1::uuid WHERE false', [EMPLOYEE]));
    await blocked(() => db.query('INSERT INTO public.dispatch_assignments(user_id) VALUES($1)', [EMPLOYEE]));
    await blocked(() => db.exec('DELETE FROM public.dispatch_assignments'));
    // Include the FK-referencing log table explicitly so TRUNCATE reaches the guard;
    // no CASCADE, disabled protections or generic FK-error acceptance.
    await blocked(() => db.exec('TRUNCATE public.dispatch_assignments,public.dispatch_system_logs'));
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_assignments'), 0);
    await db.exec("UPDATE public.dispatch_config SET config_value='19' WHERE config_key='dispatch_interval_min'");
    for (const table of ['public.valid_order_data','public.used_order_data','public.admins','public.users','public.financial_admin_credentials','public.messages'])
      await blocked(() => db.exec(`DELETE FROM ${table} WHERE false`));
    await blocked(() => db.exec('TRUNCATE public.dispatch_config'));
  } finally { await db.exec('SELECT private.employee_transfer_clear_write_permit()'); }
  assert.equal(await permitCount(), 0); assert.deepEqual(await status(), active(true));
  await blocked(() => db.exec('DELETE FROM public.dispatch_config WHERE false'));
  await blocked(() => db.exec('UPDATE public.dispatch_assignments SET dispatch_order_id=NULL WHERE false'));
  await assert.rejects(leave(), /committed writes/);
  await assert.rejects(enter(), /task or state/);
  await cancel(); assert.deepEqual(await status(), active(true)); await assert.rejects(leave(), /committed writes/);
}));

test('private guard-only maintenance fixture rejects assignment UPDATE whenever any legitimate assignment exists, even for zero matching rows', () => transaction(async () => {
  const orderId = randomUUID(), assignmentId = randomUUID();
  assert.deepEqual(await status(), clean());
  await db.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,created_by)
    SELECT $1,pool.group_id,pool.id,'local assignment guard fixture',$2
    FROM public.dispatch_order_pools AS pool JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id=pool.group_id
    WHERE pool.is_base AND dispatch_group.is_default`, [orderId, NEW.root]);
  await db.query(`INSERT INTO public.dispatch_assignments(id,dispatch_order_id,user_id,status,group_id,pool_id,
    order_content_snapshot,dispatch_success_rate_snapshot,session_timeout_minutes_snapshot)
    SELECT $1,dispatch_order.id,$2,'pending',dispatch_order.group_id,dispatch_order.pool_id,
      dispatch_order.order_content,pool.dispatch_success_rate,pool.session_timeout_minutes
    FROM public.dispatch_group_orders AS dispatch_order JOIN public.dispatch_order_pools AS pool ON pool.id=dispatch_order.pool_id
    WHERE dispatch_order.id=$3`, [assignmentId, EMPLOYEE, orderId]);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_assignments WHERE id=$1 AND dispatch_order_id=$2', [assignmentId, orderId]), 1);
  await assert.rejects(enter(), /business history/);
  assert.deepEqual(await status(), clean());
  // Privileged local fixture ONLY: the real enter correctly rejects this nonempty target.
  // This private row isolates the guard's existing-assignment check; it is NOT enter,
  // empty-site eligibility, public import/apply or backup acceptance evidence.
  await db.query(`INSERT INTO private.employee_transfer_maintenance(job_id,admin_id,plan_hash,target_hash,entered_at)
    SELECT task.id,task.admin_id,backup.plan_hash,backup.target_hash,clock_timestamp()
    FROM private.employee_transfer_jobs AS task JOIN private.employee_transfer_shared_backups AS backup ON backup.id=task.id
    WHERE task.id=$1`, [job.job_id]);
  await db.query('SELECT private.employee_transfer_allow_config_write($1)', [job.job_id]);
  try {
    const before = await businessState();
    await blocked(() => db.exec('UPDATE public.dispatch_assignments SET dispatch_order_id=NULL'));
    await blocked(() => db.exec('UPDATE public.dispatch_assignments SET dispatch_order_id=NULL WHERE false'));
    await blocked(() => db.query('DELETE FROM public.dispatch_group_orders WHERE id=$1', [orderId]));
    assert.deepEqual(await businessState(), before);
    assert.deepEqual(await status(), active(true));
  } finally { await db.exec('SELECT private.employee_transfer_clear_write_permit()'); }
  assert.equal(await permitCount(), 0);
}));

test('failed controlled-write fixture rolls back dirty flag, business changes and permit, including exception cleanup', () => transaction(async () => {
  await enter(); const before = await businessState();
  await assert.rejects(isolated(db, () => db.query(`DO $fixture$ BEGIN
    PERFORM private.employee_transfer_allow_config_write('${job.job_id}'::uuid);
    BEGIN
      UPDATE public.dispatch_config SET config_value='21' WHERE config_key='dispatch_interval_min';
      RAISE EXCEPTION 'fixture apply failed';
    EXCEPTION WHEN OTHERS THEN
      PERFORM private.employee_transfer_clear_write_permit(); RAISE;
    END;
    PERFORM private.employee_transfer_clear_write_permit();
  END $fixture$`)), /fixture apply failed/);
  assert.deepEqual(await status(), active()); assert.equal(await permitCount(), 0); assert.deepEqual(await businessState(), before);
  await leave();
}));

for (const [label, sql] of [
  ['new business root', 'CREATE TABLE public.maintenance_unknown_business(id integer)'],
  ['disguised new transfer root', 'CREATE TABLE private.employee_transfer_unknown_business(id integer)'],
  ['new history partition', "CREATE TABLE public.orders_history_2027 PARTITION OF public.orders_history FOR VALUES FROM ('2027-01-01') TO ('2028-01-01')"],
  ['missing guard', 'DROP TRIGGER zz_employee_transfer_maintenance ON public.product_types'],
  ['disabled guard', 'ALTER TABLE public.product_types DISABLE TRIGGER zz_employee_transfer_maintenance'],
  ['ordinary rather than ALWAYS guard', 'ALTER TABLE public.product_types ENABLE TRIGGER zz_employee_transfer_maintenance'],
  ['replica-only guard', 'ALTER TABLE public.product_types ENABLE REPLICA TRIGGER zz_employee_transfer_maintenance'],
  ['table owner change', 'ALTER TABLE public.product_types OWNER TO authenticated'],
  ['guard owner change', 'ALTER FUNCTION private.employee_transfer_guard_write() OWNER TO authenticated'],
  ['guard SECURITY INVOKER change', 'ALTER FUNCTION private.employee_transfer_guard_write() SECURITY INVOKER'],
  ['guard search_path change', 'ALTER FUNCTION private.employee_transfer_guard_write() SET search_path=public'],
  ['guard ACL change', 'GRANT EXECUTE ON FUNCTION private.employee_transfer_guard_write() TO anon'],
  ['permit helper ACL change', 'GRANT EXECUTE ON FUNCTION private.employee_transfer_allow_config_write(uuid) TO anon'],
]) test(`assert/enter fail closed on ${label}`, () => transaction(async () => {
  await db.exec(sql);
  await assert.rejects(isolated(db, assertGuards), /Unreviewed employee transfer maintenance/);
  await assert.rejects(enter(), /Unreviewed employee transfer maintenance/); assert.deepEqual(await status(), clean());
  for (const name of AUDITS) await assert.rejects(isolated(db, () => db.exec(`SELECT private.${name}()`)), /Unreviewed employee transfer maintenance/);
}));

test('guard and fixed inventory function-body changes, same-name wrong trigger definition are refused', () => transaction(async () => {
  for (const name of ['employee_transfer_guard_write', 'employee_transfer_guarded_tables', 'employee_transfer_allow_config_write']) {
    await isolated(db, async () => {
      await db.exec('SAVEPOINT body_change');
      try {
        const definition = await scalar(db, "SELECT pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname=$1", [name]);
        await db.exec(definition.replace('AS $function$', 'AS $function$\n-- changed definition\n'));
        await assert.rejects(isolated(db, assertGuards), /Unreviewed employee transfer maintenance/);
      } finally { await db.exec('ROLLBACK TO SAVEPOINT body_change; RELEASE SAVEPOINT body_change'); }
    });
  }
  await db.exec(`DROP TRIGGER zz_employee_transfer_maintenance ON public.product_types;
    CREATE TRIGGER zz_employee_transfer_maintenance BEFORE INSERT ON public.product_types FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write();
    ALTER TABLE public.product_types ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance`);
  await assert.rejects(isolated(db, assertGuards), /Unreviewed employee transfer maintenance/);
}));

test('legacy exact shared/product trigger audits accept the reviewed keep guard but still reject every other unknown trigger', () => transaction(async () => {
  for (const name of AUDITS) await db.exec(`SELECT private.${name}()`);
  assert.deepEqual(await scalar(db, 'SELECT private.employee_transfer_unreviewed_triggers()'), []);
  const tables = await scalar(db, 'SELECT private.employee_transfer_trigger_tables()');
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_fixed_trigger_policy() WHERE trigger_name='zz_employee_transfer_maintenance' AND action='keep'"), tables.length);
  const disabled = await scalar(db, "SELECT private.employee_transfer_bypass_triggers(ARRAY['orders','wallet_transactions'])");
  assert.ok(disabled.every(t => t.trigger !== 'zz_employee_transfer_maintenance'));
  await db.query('SELECT private.employee_transfer_restore_triggers($1::jsonb)', [JSON.stringify(disabled)]); await assertGuards();
  for (const [table, name] of [['public.admin_configs', AUDITS[0]], ['public.admins', AUDITS[1]], ['public.product_types', AUDITS[2]]]) {
    await db.exec('SAVEPOINT unknown_trigger');
    try {
      await db.exec(`CREATE TRIGGER maintenance_unknown_write BEFORE INSERT OR UPDATE OR DELETE ON ${table} FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()`);
      await assert.rejects(isolated(db, () => db.exec(`SELECT private.${name}()`)), /unreviewed.*trigger/i);
    } finally { await db.exec('ROLLBACK TO SAVEPOINT unknown_trigger; RELEASE SAVEPOINT unknown_trigger'); }
  }
}));

test('leave also asserts guard integrity and never releases clean maintenance after guard tampering', () => transaction(async () => {
  await enter(); await db.exec('ALTER TABLE public.announcements DISABLE TRIGGER zz_employee_transfer_maintenance');
  await assert.rejects(leave(), /Unreviewed employee transfer maintenance/); assert.deepEqual(await status(), active());
}));

test('lock acquisition SQL is sorted table-first without ONLY, exclusive advisory last; no claim of native multi-session deadlock testing', () => transaction(async () => {
  const definition = await scalar(db, "SELECT pg_get_functiondef('private.employee_transfer_lock_maintenance_tables()'::regprocedure)");
  assert.match(definition, /ORDER BY name COLLATE "C"/);
  assert.match(definition, /LOCK TABLE %I\.%I IN SHARE ROW EXCLUSIVE MODE/);
  assert.ok(definition.indexOf("EXECUTE format('LOCK TABLE") < definition.indexOf('PERFORM pg_advisory_xact_lock('));
  assert.doesNotMatch(definition, /LOCK TABLE ONLY/);
  await db.exec('SELECT private.employee_transfer_lock_maintenance_tables()');
  // PGlite is single-connection: it cannot prove native PG lock waits/cancellation or
  // deadlock recovery. Parent/leaf access is exercised above, lock ordering is inspected.
}));

test('repeatable-read old-snapshot write transactions fail closed instead of claiming visibility of new maintenance rows', async () => {
  await db.exec('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await assert.rejects(isolated(db, () => db.exec('DELETE FROM public.product_types WHERE false')), error => error.message === PAUSED);
    await assert.rejects(isolated(db, () => db.exec('SELECT private.employee_transfer_lock_maintenance_tables()')), /read committed/);
  } finally { await db.exec('ROLLBACK'); }
});

test('committed maintenance crosses request transactions; committed dirty survives clear, expiry and cancellation without automatic release', async () => {
  async function committed(fn) {
    await db.exec('BEGIN');
    try { const value = await fn(); await db.exec('COMMIT'); return value; }
    catch (error) { await db.exec('ROLLBACK'); throw error; }
  }
  await committed(async () => { assert.deepEqual(await enter(), receipt(false)); });
  await transaction(async () => {
    assert.deepEqual(await status(), active());
    await blocked(() => db.exec('DELETE FROM public.orders_history_2026 WHERE false'));
    await blocked(() => isolated(db, () => db.exec('DELETE FROM public.product_types WHERE false'), 'anon'));
  });
  await committed(async () => { assert.deepEqual(await enter(), receipt(true)); await leave(); });
  await transaction(async () => { assert.deepEqual(await status(), clean()); await db.exec('DELETE FROM public.product_types WHERE false'); });
  await committed(async () => { await enter(); });
  await committed(async () => {
    // Private postgres-only fixture, not public apply acceptance. Real changes COMMIT;
    // finally removes the permit before COMMIT, but dirty intentionally persists.
    await db.query('SELECT private.employee_transfer_allow_config_write($1)', [job.job_id]);
    try { await db.exec("UPDATE public.dispatch_config SET config_value='18' WHERE config_key='dispatch_interval_min'"); }
    finally { await db.exec('SELECT private.employee_transfer_clear_write_permit()'); }
  });
  await transaction(async () => {
    assert.deepEqual(await status(), active(true)); assert.equal(await permitCount(), 0);
    assert.equal(await scalar(db, "SELECT config_value FROM public.dispatch_config WHERE config_key='dispatch_interval_min'"), '18');
    await blocked(() => db.exec('DELETE FROM public.dispatch_config WHERE false'));
    await assert.rejects(leave(), /committed writes/);
  });
  await committed(() => db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", [job.job_id]));
  await transaction(async () => {
    assert.deepEqual(await status(), active(true)); await assert.rejects(leave(), /committed writes/);
    await assert.rejects(isolated(db, () => db.query('SELECT private.employee_transfer_allow_config_write($1)', [job.job_id])), /running maintenance owner/);
  });
  await committed(cancel);
  await transaction(async () => {
    assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [job.job_id]), 'cancelled');
    assert.deepEqual(await status(), active(true)); await assert.rejects(leave(), /committed writes/);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_shared_backups WHERE id=$1 AND sealed_at IS NOT NULL', [job.job_id]), 1);
  });
  // Intentionally retain dirty maintenance until the local in-memory database is closed.
});
