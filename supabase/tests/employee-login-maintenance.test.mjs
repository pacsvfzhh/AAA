import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const loginMigration = '20261103000000_employee_login_maintenance.sql';
const migration = '20261103000001_team_employee_maintenance.sql';
const clockMigration = '20261103000002_dispatch_server_clock.sql';
const statusMigration = '20261103000007_dispatch_session_status.sql';
const dispatchStatusCalls = [
  { name: 'prepare_next_dispatch_order_status_secure', legacy: 'prepare_next_dispatch_order_secure' },
  { name: 'assign_next_dispatch_order_status_secure', legacy: 'assign_next_dispatch_order_secure' },
  { name: 'update_session_heartbeat_status_secure', legacy: 'update_session_heartbeat_secure' },
];
const statusSignatures = [
  'private.get_employee_dispatch_call_status(uuid,uuid,text,uuid,boolean)',
  'public.prepare_next_dispatch_order_status_secure(uuid,uuid,text,uuid)',
  'public.assign_next_dispatch_order_status_secure(uuid,uuid,text,uuid,uuid,text)',
  'public.update_session_heartbeat_status_secure(uuid,uuid,text,uuid)',
].sort();
let statusCatalogBefore;
let statusCatalogAfter;
let isolatedBrowserCalls = false;
let allTableSnapshotSQL;
const clockSignatures = [
  'prepare_next_dispatch_order_secure(uuid,uuid,text,uuid)',
  'assign_next_dispatch_order_secure(uuid,uuid,text,uuid,uuid,text)',
];
const clockPatch = "'server_now', clock_timestamp(), ";
const clockDefinitions = {};
let clockPermissions;
const GROUP = '20000000-0000-4000-8000-000000000001';
const INVALID_TOKEN = '99999999-0000-4000-8000-000000000001';
const TAB = 'qa-tab';
const migrationDir = new URL('../migrations/', import.meta.url);
const supportDir = new URL('./support/', import.meta.url);
const SUPER = '00000000-0000-4000-8000-000000000001';
const TEAM = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const EMERGENCY = '00000000-0000-4000-8000-000000000004';
const TOKENS = {
  [SUPER]: '10000000-0000-4000-8000-000000000001',
  [TEAM]: '10000000-0000-4000-8000-000000000002',
  [OTHER]: '10000000-0000-4000-8000-000000000003',
  [EMERGENCY]: '10000000-0000-4000-8000-000000000004',
};
let db;
// Known empty-database replay gaps; never silently accept a new historical failure.
const historicalFailures = [
  '20251031230000_add_admins_update_policy.sql',
  '20251114230000_add_admin_scope_to_account_locks.sql',
  '20251114235000_fix_account_locks_rls_policies.sql',
  '20251129073341_fix_all_function_search_paths.sql',
  '20260411213553_insert_bart_members_simulation_data.sql',
  '20260411213832_fix_bart_commission_amounts_and_wallet_balances.sql',
  '20260706000801_revoke_unused_security_definer_functions.sql',
  '20260706001347_fix_security_definer_revoke_from_public.sql',
  '20260706002034_convert_client_functions_to_security_invoker.sql',
  '20260706002123_convert_internal_functions_to_security_invoker.sql',
  '20260928080144_align_weighted_dispatch_assignment.sql',
  '20261026000000_archive_legacy_empty_notifications.sql',
];
const failures = [];
const originals = {};
let previousEmployeeLogin;
let previousEmployeeRecovery;
let replayedFiles;
let fixtureSequence = 0;

async function asBrowser(sql, params = [], role = 'anon') {
  assert(['anon', 'authenticated'].includes(role));
  // New regressions run in rollback-only transactions. A failed real RPC must
  // not leave that transaction aborted or prevent RESET ROLE / later assertions.
  if (isolatedBrowserCalls) await db.exec('SAVEPOINT browser_call');
  try {
    await db.exec(`SET ROLE ${role}`);
    const result = await db.query(sql, params);
    await db.exec('RESET ROLE');
    if (isolatedBrowserCalls) await db.exec('RELEASE SAVEPOINT browser_call');
    return result;
  } catch (error) {
    if (isolatedBrowserCalls) await db.exec('ROLLBACK TO SAVEPOINT browser_call; RELEASE SAVEPOINT browser_call');
    else await db.exec('RESET ROLE');
    throw error;
  }
}
async function call(name, args) {
  const keys = Object.keys(args);
  return (await asBrowser(`SELECT public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')}) AS result`, keys.map(key => args[key]))).rows[0].result;
}
const get = (actor, owner = actor) => call('get_employee_login_maintenance', { p_admin_session_token: TOKENS[actor], p_owner_admin_id: owner });
const set = (actor, owner, enabled, password = `password-${actor === SUPER ? 'root' : actor === TEAM ? 'team' : 'other'}`) => call('set_employee_login_maintenance', { p_admin_session_token: TOKENS[actor], p_owner_admin_id: owner, p_admin_password: password, p_enabled: enabled });
const login = (username, password = 'employee-secret', tab = TAB) => call('create_employee_financial_session', { p_username: username, p_password: password, p_tab_id: tab });
const count = async table => Number((await db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
const identity = session => ({ p_user_id: session.user.id, p_session_token: session.session_token, p_tab_id: TAB });
const valid = session => call('validate_employee_session', identity(session));
const status = (session, overrides = {}) => call('get_employee_maintenance_status', { ...identity(session), ...overrides });
const work = (name, session, extra = {}) => call(name, { ...identity(session), ...extra });
const definition = async signature => (await db.query('SELECT pg_get_functiondef(to_regprocedure($1)) AS definition', [signature])).rows[0].definition;
const rowsOf = async table => (await db.query(`SELECT to_jsonb(t) AS row FROM ${table} AS t ORDER BY to_jsonb(t)::text`)).rows;
async function moneyAndOrders() {
  const result = {};
  for (const table of ['orders', 'wallets', 'wallet_transactions', 'wallet_ledger_entries', 'financial_operations', 'financial_employee_credentials']) {
    result[table] = await rowsOf(`public.${table}`);
  }
  return result;
}
async function employee(owner = TEAM) {
  const username = `maintenance-fixture-${++fixtureSequence}`;
  await db.query(`INSERT INTO public.users(username, employee_id, password_hash, created_by, is_verified)
    VALUES ($1, $1, extensions.crypt('employee-secret', extensions.gen_salt('bf', 4)), $2, true)`, [username, owner]);
  await db.query(`INSERT INTO public.financial_employee_credentials(user_id, password_hash)
    SELECT id, password_hash FROM public.users WHERE username = $1
    ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [username]);
  await db.query(`INSERT INTO public.dispatch_group_members(group_id, user_id, assigned_by)
    SELECT $1, id, $2 FROM public.users WHERE username = $3`, [GROUP, SUPER, username]);
  const result = await login(username);
  assert.equal(result.success, true);
  return result;
}
async function dispatch(session, accepted = false) {
  const started = await work('start_employee_dispatch_session_secure', session);
  assert.equal(started.success, true);
  const prepared = await work('prepare_next_dispatch_order_secure', session, { p_session_id: started.session_id });
  assert.equal(prepared.available, true);
  // Advance only the isolated fixture's server due time, rather than waiting.
  await db.query(`UPDATE public.dispatch_pool_selections SET selected_at = now() - interval '2 seconds', due_at = now() - interval '1 second' WHERE session_id = $1`, [started.session_id]);
  const assigned = await work('assign_next_dispatch_order_secure', session, { p_session_id: started.session_id, p_group_id: GROUP });
  assert.equal(assigned.success, true);
  const assignment = assigned.assignment;
  if (accepted) {
    const code = `ASN-MAINT-${++fixtureSequence}`;
    assert.equal((await work('accept_dispatch_assignment_secure', session, {
      p_session_id: started.session_id, p_assignment_id: assignment.id, p_assignment_code: code,
    })).success, true);
    assignment.assignment_id = code;
  }
  return { ...started, assignment };
}
async function order(session, assignmentCode = null) {
  const transaction = `maintenance-order-${++fixtureSequence}`;
  return (await asBrowser(`INSERT INTO public.orders(user_id, username, product_type_id, product_value, order_number, transaction_id, status, assignment_id)
    SELECT $1, $4, id, 100, $2, $2, 'processing', $3 FROM public.product_types WHERE name = 'Maintenance QA'
    RETURNING *`, [session.user.id, transaction, assignmentCode, session.user.username])).rows[0];
}
async function validData() {
  return (await db.query(`INSERT INTO public.valid_order_data(product_value, transaction_id, created_by)
    VALUES (100, $1, $2) RETURNING id`, [`maintenance-valid-${++fixtureSequence}`, SUPER])).rows[0].id;
}

// Capture definitions and raw catalog metadata, not merely function names or
// source text. This pins owners, ACLs, security/search_path and existing objects.
async function catalogFingerprints() {
  const functions = (await db.query(`SELECT p.oid::text AS oid,
      n.nspname || '.' || p.proname || '(' || replace(oidvectortypes(p.proargtypes), ', ', ',') || ')' AS signature,
      md5(to_jsonb(p)::text || pg_get_functiondef(p.oid)) AS fingerprint
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prokind <> 'a'
    ORDER BY p.oid`)).rows;
  const catalogs = ['pg_namespace', 'pg_class', 'pg_attribute', 'pg_attrdef', 'pg_constraint',
    'pg_index', 'pg_trigger', 'pg_policy', 'pg_type', 'pg_enum', 'pg_sequence',
    'pg_default_acl', 'pg_publication', 'pg_publication_rel', 'pg_event_trigger', 'pg_extension'];
  const objects = {};
  for (const catalog of catalogs) {
    objects[catalog] = (await db.query(`SELECT md5(to_jsonb(c)::text) AS fingerprint
      FROM pg_catalog.${catalog} c ORDER BY to_jsonb(c)::text`)).rows;
  }
  objects.cron = await rowsOf('cron.job');
  return { functions, objects };
}

// Include every application table (also audit/queue/stop-marker/recovery tables),
// with physical tuple identity so an UPDATE writing identical values is detected.
async function dispatchSnapshot() {
  if (!allTableSnapshotSQL) {
    const { rows } = await db.query(`SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'private') AND c.relkind = 'r' ORDER BY 1`);
    allTableSnapshotSQL = rows.map(({ name }) => `SELECT '${name}' AS table_name, count(*)::int AS count,
      md5(coalesce(string_agg(to_jsonb(t)::text || t.xmin::text || t.ctid::text,
        E'\\n' ORDER BY to_jsonb(t)::text, t.ctid), '')) AS fingerprint FROM ${name} t`).join(' UNION ALL ');
  }
  return (await db.query(allTableSnapshotSQL)).rows;
}
function dispatchArgs(rpc, sessionId, overrides = {}) {
  return { p_session_id: sessionId, ...(rpc.name.startsWith('assign_') ? { p_group_id: GROUP } : {}), ...overrides };
}
function regression(name, fn) {
  test(name, async t => {
    await db.exec('BEGIN');
    isolatedBrowserCalls = true;
    try { await fn(t); }
    finally {
      isolatedBrowserCalls = false;
      await db.exec('ROLLBACK');
    }
  });
}
async function trial(fn) {
  await db.exec('SAVEPOINT legacy_comparison');
  try { return await fn(); }
  finally { await db.exec('ROLLBACK TO SAVEPOINT legacy_comparison; RELEASE SAVEPOINT legacy_comparison'); }
}
const withoutClock = result => Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'server_now'));
async function assertClockedResult(result, expected) {
  assert(Number.isFinite(Date.parse(result.server_now)), 'response must include the real server clock');
  assert.deepEqual(withoutClock(result), expected);
}
async function assertQuietStatus(session, sessionId, expected) {
  for (const rpc of dispatchStatusCalls) {
    // Heartbeats deliberately have no stale cutoff; only ended is a quiet result.
    if (expected === 'stale' && rpc.name.startsWith('update_')) continue;
    const before = await dispatchSnapshot();
    const result = await work(rpc.name, session, dispatchArgs(rpc, sessionId));
    if (rpc.name.startsWith('update_')) {
      assert.deepEqual(result, { success: false, session_status: expected, reason: 'work_session_ended',
        session_id: sessionId, user_id: session.user.id, heartbeat_at: null, work_sessions_updated: 0 });
    } else {
      await assertClockedResult(result, { success: false, session_status: expected,
        ...(rpc.name.startsWith('prepare_') ? { available: false } : { assignment: null }) });
    }
    assert.deepEqual(await dispatchSnapshot(), before, `${rpc.name} ${expected} must not write any application table`);
  }
}
async function due(sessionId) {
  await db.query(`UPDATE public.dispatch_pool_selections
    SET selected_at = now() - interval '2 seconds', due_at = now() - interval '1 second'
    WHERE session_id = $1`, [sessionId]);
}

before(async () => {
  const segments = [{ before: null, sql: '' }];
  for (const line of (await readFile(new URL('baseline.sql', supportDir), 'utf8')).split('\n')) {
    const marker = line.match(/^-- @before (\S+)/);
    if (marker) segments.push({ before: marker[1], sql: '' }); else segments.at(-1).sql += `${line}\n`;
  }
  db = new PGlite({ extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await db.exec(await readFile(new URL('platform.sql', supportDir), 'utf8'));
  const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
  assert(files.includes(clockMigration));
  assert(files.includes(statusMigration));
  replayedFiles = files;
  for (const [index, file] of files.entries()) {
    for (const segment of segments) if (segment.before && file.startsWith(segment.before)) await db.exec(segment.sql);
    if (file === loginMigration) {
      for (const fn of ['create_admin_financial_session(text,text)', 'validate_employee_session(uuid,uuid,text)',
        'private.get_financial_employee_id(uuid,uuid,text)', 'process_pending_orders()',
        'auto_create_commission_and_update_wallet()', 'private.snapshot_order_dispatch_rates()',
        'start_employee_dispatch_session_secure(uuid,uuid,text)', 'stop_employee_dispatch_session_secure(uuid,uuid,text,uuid)',
        'resume_employee_dispatch_session_secure(uuid,uuid,text,uuid)',
        'prepare_next_dispatch_order_secure(uuid,uuid,text,uuid)', 'assign_next_dispatch_order_secure(uuid,uuid,text,uuid,uuid,text)',
        'accept_dispatch_assignment_secure(uuid,uuid,text,uuid,uuid,text)', 'update_session_heartbeat_secure(uuid,uuid,text,uuid)']) {
        originals[fn] = await definition(fn);
        assert(originals[fn], `${fn} must exist before the migration`);
      }
    }
    if (file === migration) {
      previousEmployeeLogin = await definition('create_employee_financial_session(text,text,text)');
      previousEmployeeRecovery = await definition('recover_employee_dispatch_assignment_secure(uuid,uuid,text)');
    }
    if (file === clockMigration) {
      for (const signature of clockSignatures) clockDefinitions[signature] = await definition(signature);
      clockPermissions = (await db.query(`SELECT oid, proowner, prosecdef, proconfig, proacl::text
        FROM pg_proc WHERE oid = ANY($1::regprocedure[]) ORDER BY oid`, [clockSignatures])).rows;
    }
    if (file === statusMigration) statusCatalogBefore = await catalogFingerprints();
    const sql = (await readFile(new URL(file, migrationDir), 'utf8')).replace(/CREATE EXTENSION IF NOT EXISTS pg_cron[^;]*;/gi, '').replace(/CREATE EXTENSION IF NOT EXISTS pg_trgm;/gi, '');
    try { await db.exec(sql); } catch (error) {
      failures.push({ file, message: String(error.message).split('\n')[0] });
      try { await db.exec('ROLLBACK'); } catch { /* historical migration may not open a transaction */ }
    }
    if (file === statusMigration) statusCatalogAfter = await catalogFingerprints();
    if (index === 0) await db.exec(segments[0].sql);
  }
  await db.exec(`
    INSERT INTO public.admins(id, username, password_hash, role, parent_id) VALUES
      ('${SUPER}', 'maintenance-root', extensions.crypt('password-root', extensions.gen_salt('bf', 4)), 'super_admin', NULL),
      ('${TEAM}', 'maintenance-team', extensions.crypt('password-team', extensions.gen_salt('bf', 4)), 'secondary_admin', '${SUPER}'),
      ('${OTHER}', 'maintenance-other', extensions.crypt('password-other', extensions.gen_salt('bf', 4)), 'secondary_admin', '${SUPER}'),
      ('${EMERGENCY}', 'maintenance-emergency', extensions.crypt('password-emergency', extensions.gen_salt('bf', 4)), 'emergency_admin', '${SUPER}');
    INSERT INTO public.financial_admin_credentials(admin_id, password_hash)
      SELECT id, password_hash FROM public.admins WHERE id IN ('${SUPER}', '${TEAM}', '${OTHER}', '${EMERGENCY}')
      ON CONFLICT (admin_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
    INSERT INTO public.admin_financial_sessions(admin_id, token_hash, expires_at) VALUES
      ('${SUPER}', private.hash_financial_token('${TOKENS[SUPER]}'), now() + interval '1 day'),
      ('${TEAM}', private.hash_financial_token('${TOKENS[TEAM]}'), now() + interval '1 day'),
      ('${OTHER}', private.hash_financial_token('${TOKENS[OTHER]}'), now() + interval '1 day'),
      ('${EMERGENCY}', private.hash_financial_token('${TOKENS[EMERGENCY]}'), now() + interval '1 day');
    INSERT INTO public.users(username, employee_id, password_hash, created_by) VALUES
      ('maintenance-employee', 'M-1', extensions.crypt('employee-secret', extensions.gen_salt('bf', 4)), '${TEAM}'),
      ('other-employee', 'M-2', extensions.crypt('employee-secret', extensions.gen_salt('bf', 4)), '${OTHER}'),
      ('root-employee', 'M-3', extensions.crypt('employee-secret', extensions.gen_salt('bf', 4)), '${SUPER}');
    INSERT INTO public.financial_employee_credentials(user_id, password_hash)
      SELECT id, password_hash FROM public.users WHERE employee_id IN ('M-1','M-2','M-3')
      ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash;
    INSERT INTO public.dispatch_groups(id, group_name, created_by, dispatch_success_rate)
      VALUES ('${GROUP}', 'Maintenance QA', '${SUPER}', 100);
    INSERT INTO public.dispatch_group_orders(group_id, pool_id, order_content, created_by)
      SELECT '${GROUP}', id, 'Maintenance QA order ' || n, '${SUPER}'
      FROM public.dispatch_order_pools CROSS JOIN generate_series(1, 8) AS n WHERE group_id = '${GROUP}' AND is_base;
    INSERT INTO public.dispatch_group_members(group_id, user_id, assigned_by)
      SELECT '${GROUP}', id, '${SUPER}' FROM public.users WHERE employee_id IN ('M-1','M-2','M-3');
    INSERT INTO public.product_types(name) VALUES ('Maintenance QA');
    -- Hosted public-schema default grants are not represented by platform.sql.
    -- Keep the real RLS/triggers; grant only the direct submission fixture paths.
    GRANT SELECT, INSERT ON public.orders, public.used_order_data TO anon, authenticated;
    GRANT SELECT ON public.product_types TO anon, authenticated;
    GRANT SELECT, UPDATE ON public.valid_order_data TO anon, authenticated;
  `);
});
after(async () => { await db?.close(); });

test('new migration applies after the real history without changing admin login or session validation', async t => {
  t.diagnostic(`Replayed ${replayedFiles.length} migrations; ${failures.length} historical replay failures (not a clean-database proof).`);
  for (const failure of failures) t.diagnostic(`${failure.file}: ${failure.message}`);
  assert.deepEqual(failures.filter(f => f.file >= loginMigration), []);
  assert.deepEqual(failures.map(f => f.file), historicalFailures);
  for (const [fn, definition] of Object.entries(originals)) {
    const actual = (await db.query('SELECT pg_get_functiondef(to_regprocedure($1)) AS definition', [fn])).rows[0].definition;
    assert.equal(clockSignatures.includes(fn) ? actual.replaceAll(clockPatch, '') : actual, definition);
  }
});

test('maintenance defaults off and is private with guarded RPC permissions', async () => {
  assert.deepEqual(await get(TEAM), { owner_admin_id: TEAM, enabled: false, updated_at: null });
  for (const table of ['employee_login_maintenance', 'employee_login_maintenance_confirmations', 'employee_login_maintenance_events']) {
    const { rows: [r] } = await db.query(`SELECT has_table_privilege('anon', $1, 'SELECT,INSERT,UPDATE,DELETE') AS anon, has_table_privilege('authenticated', $1, 'SELECT,INSERT,UPDATE,DELETE') AS authenticated, (SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass) AS rls`, [`private.${table}`]);
    assert.deepEqual(r, { anon: false, authenticated: false, rls: true });
  }
  for (const role of ['anon', 'authenticated']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
      assert.equal((await db.query('SELECT has_column_privilege($1, $2, $3, $4) AS allowed',
        [role, 'public.employee_financial_sessions', 'maintenance_revoked_at', privilege])).rows[0].allowed, false);
    }
  }
  for (const signature of ['get_employee_login_maintenance(uuid,uuid)', 'set_employee_login_maintenance(uuid,uuid,text,boolean)',
    'get_employee_maintenance_status(uuid,uuid,text)', 'recover_employee_dispatch_assignment_secure(uuid,uuid,text)']) {
    const { rows: [r] } = await db.query(`SELECT prosecdef, proconfig, has_function_privilege('anon', oid, 'EXECUTE') AS anon, EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public FROM pg_proc WHERE oid = to_regprocedure($1)`, [`public.${signature}`]);
    assert.equal(r.prosecdef, true); assert.equal(r.anon, true); assert.equal(r.public, false);
    assert.equal((await db.query(`SELECT has_function_privilege('authenticated', to_regprocedure($1), 'EXECUTE') AS allowed`, [`public.${signature}`])).rows[0].allowed, true);
    assert(r.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
  }
});

test('secondary administrators cannot read or modify other teams, including root', async () => {
  for (const owner of [OTHER, SUPER]) {
    await assert.rejects(get(TEAM, owner), /Permission denied/);
    await assert.rejects(set(TEAM, owner, true), /Permission denied/);
  }
  await assert.rejects(get(EMERGENCY, TEAM), /invalid or expired/);
  await assert.rejects(get(SUPER, EMERGENCY), /not available/);
  await assert.rejects(call('get_employee_login_maintenance', { p_admin_session_token: '99999999-0000-4000-8000-000000000001', p_owner_admin_id: TEAM }), /invalid or expired/);
});

test('both enabling and disabling require the operator password, not the target password', async () => {
  const online = await employee();
  const sessionBefore = await rowsOf('public.employee_financial_sessions');
  const markersBefore = await rowsOf('private.employee_work_stop_markers');
  assert.equal((await set(TEAM, TEAM, true, 'wrong')).error, 'invalid_password');
  assert.equal((await get(TEAM)).enabled, false);
  assert.equal(await count('private.employee_login_maintenance_events'), 0);
  assert.equal((await set(SUPER, TEAM, true, 'password-team')).error, 'invalid_password');
  assert.equal(await valid(online), true);
  assert.deepEqual(await rowsOf('public.employee_financial_sessions'), sessionBefore);
  assert.deepEqual(await rowsOf('private.employee_work_stop_markers'), markersBefore);
  assert.equal((await set(SUPER, TEAM, true)).success, true);
  assert.equal((await get(TEAM)).enabled, true);
  assert.equal((await get(OTHER)).enabled, false);
  assert.equal((await get(SUPER)).enabled, false);
  assert.equal((await set(SUPER, TEAM, false, '')).error, 'invalid_password');
  assert.equal((await get(TEAM)).enabled, true);
  assert.equal((await set(TEAM, TEAM, false)).success, true);
  assert.equal((await get(TEAM)).enabled, false);
});

test('enable revokes old sessions; blocked login creates no session or history and does not count as a failed password', async () => {
  const original = await login('maintenance-employee');
  assert.equal(original.success, true);
  await set(TEAM, TEAM, true);
  const before = { sessions: await count('public.employee_financial_sessions'), history: await count('public.employee_login_history'), failures: await count('public.financial_login_attempts') };
  for (let i = 0; i < 7; i++) assert.deepEqual(await login('maintenance-employee'), { success: false, code: 'employee_login_maintenance' });
  assert.deepEqual({ sessions: await count('public.employee_financial_sessions'), history: await count('public.employee_login_history'), failures: await count('public.financial_login_attempts') }, before);
  const { rows: [user] } = await db.query('SELECT current_session_token FROM public.users WHERE username = $1', ['maintenance-employee']);
  assert.equal(user.current_session_token, null);
  const revoked = (await db.query('SELECT revoked_at, maintenance_revoked_at FROM public.employee_financial_sessions WHERE token_hash = private.hash_financial_token($1)', [original.session_token])).rows[0];
  assert(revoked.revoked_at); assert(revoked.maintenance_revoked_at);
  assert.equal(await valid(original), false);
  assert.deepEqual(await status(original), { maintenance: true, session_valid: false });
  assert.equal((await login('other-employee')).success, true);
  assert.equal((await login('root-employee')).success, true);
  const admin = await call('create_admin_financial_session', { p_username: 'maintenance-team', p_password: 'password-team' });
  assert.equal(admin.success, true);
  assert.equal((await login('maintenance-employee', 'wrong-password')).error, 'Invalid credentials');
  await set(TEAM, TEAM, false);
  assert.equal(await valid(original), false);
  assert.deepEqual(await status(original), { maintenance: true, session_valid: false });
  const fresh = await login('maintenance-employee');
  assert.equal(fresh.success, true);
  assert.equal(await valid(fresh), true);
  assert.deepEqual(await status(fresh), { maintenance: false, session_valid: true });
});

test('super administrator can independently maintain its own team without affecting other teams', async () => {
  await set(SUPER, SUPER, true);
  assert.equal((await login('root-employee')).code, 'employee_login_maintenance');
  assert.equal((await login('other-employee')).success, true);
  assert.equal((await call('create_admin_financial_session', { p_username: 'maintenance-root', p_password: 'password-root' })).success, true);
  await set(SUPER, SUPER, false);
});

test('password confirmation failures persist and lock only that operator confirmation for fifteen minutes', async () => {
  for (let i = 0; i < 4; i++) assert.equal((await set(OTHER, OTHER, true, 'wrong')).error, 'invalid_password');
  const locked = await set(OTHER, OTHER, true, 'wrong');
  assert.equal(locked.error, 'confirmation_locked');
  assert(Date.parse(locked.locked_until) > Date.now() + 14 * 60 * 1000);
  assert.equal((await set(OTHER, OTHER, true)).error, 'confirmation_locked');
  assert.equal((await get(OTHER)).enabled, false);
  assert.equal((await set(SUPER, OTHER, true)).success, true);
  assert.equal((await call('create_admin_financial_session', { p_username: 'maintenance-other', p_password: 'password-other' })).success, true);
  await db.query('UPDATE private.employee_login_maintenance_confirmations SET locked_until = now() - interval \'1 second\' WHERE admin_id = $1', [OTHER]);
  assert.equal((await set(OTHER, OTHER, false)).success, true);
  assert.equal((await db.query('SELECT failed_attempts FROM private.employee_login_maintenance_confirmations WHERE admin_id = $1', [OTHER])).rows[0].failed_attempts, 0);
});

test('team lock is the only login change and precedes financial/user locks and submission snapshots', async () => {
  const current = await definition('create_employee_financial_session(text,text,text)');
  const shared = "  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-maintenance:' || v_user.created_by::text, 0));\n\n";
  assert(current.includes(shared));
  assert.equal(current.replace(shared, ''), previousEmployeeLogin);
  assert(current.indexOf('verify_bcrypt_password') < current.indexOf(shared));
  assert(current.indexOf(shared) < current.indexOf('FROM private.employee_login_maintenance'));
  const setter = await definition('set_employee_login_maintenance(uuid,uuid,text,boolean)');
  assert(setter.indexOf('verify_bcrypt_password') < setter.indexOf('pg_advisory_xact_lock('));
  assert(setter.indexOf('pg_advisory_xact_lock(') < setter.indexOf('UPDATE public.employee_financial_sessions'));
  const triggers = (await db.query(`SELECT c.relname, t.tgname, t.tgtype,
      p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
      EXISTS(SELECT 1 FROM aclexplode(p.proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE p.proname = 'guard_employee_maintenance_submission' ORDER BY c.relname`)).rows;
  assert.deepEqual(triggers.map(t => t.relname), ['orders', 'used_order_data']);
  for (const trigger of triggers) {
    assert.equal(trigger.tgtype, 7); // ROW + BEFORE + INSERT, not UPDATE or DELETE.
    assert.equal(trigger.prosecdef, true);
    assert.equal(trigger.anon, false); assert.equal(trigger.authenticated, false); assert.equal(trigger.public, false);
    assert(trigger.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    assert(trigger.tgname < 'snapshot_order_dispatch_rates');
  }
  const guard = await definition('private.guard_employee_maintenance_submission()');
  assert(guard.includes('NEW.user_id'));
  assert(guard.includes("pg_advisory_xact_lock_shared(hashtextextended('employee-maintenance:' || v_owner_admin_id::text, 0))"));
  assert(guard.indexOf('pg_advisory_xact_lock_shared') < guard.indexOf('FROM private.employee_login_maintenance'));
  const recovery = await definition('recover_employee_dispatch_assignment_secure(uuid,uuid,text)');
  const financialLock = '  FOR UPDATE OF financial_session, employee;';
  assert(recovery.indexOf(financialLock) > recovery.indexOf('private.hash_financial_token(p_session_token)'));
  assert(recovery.indexOf(financialLock) < recovery.indexOf('FROM public.dispatch_assignments'));
  assert(recovery.indexOf(financialLock) < recovery.indexOf('UPDATE public.dispatch_assignments'));
  assert.equal(recovery.includes('pg_advisory_xact_lock'), false);
  const guardStart = recovery.indexOf('  IF v_candidate.id IS NOT NULL AND EXISTS (');
  const guardEnd = recovery.indexOf('  IF v_candidate.id IS NULL THEN');
  assert(guardStart > recovery.indexOf('INTO v_candidate'));
  assert(guardEnd > guardStart);
  assert.equal(recovery.replace(recovery.slice(guardStart, guardEnd), '')
    .replace('employee.is_active = true\n' + financialLock, 'employee.is_active = true;')
    .replace('assignment.accepted_at, assignment.assigned_at,', 'assignment.accepted_at,'), previousEmployeeRecovery);
  const migrationSQL = await readFile(new URL(migration, migrationDir), 'utf8');
  assert.equal(/\/\*|^\s*--.*\n\s*--/m.test(migrationSQL), false);
});

test('enable atomically stops all teammates at heartbeat cutoff, cancels only unsubmitted assignments and cannot resume old work', async () => {
  const a = await employee();
  const b = await employee();
  const other = await employee(OTHER);
  const pending = await dispatch(a);
  const accepted = await dispatch(b, true);
  const otherWork = await dispatch(other);
  const otherBefore = {
    sessions: (await db.query('SELECT * FROM public.dispatch_sessions WHERE user_id = $1', [other.user.id])).rows,
    work: (await db.query('SELECT * FROM public.work_sessions WHERE user_id = $1', [other.user.id])).rows,
    assignment: (await db.query('SELECT * FROM public.dispatch_assignments WHERE user_id = $1', [other.user.id])).rows,
  };
  await db.query(`UPDATE public.dispatch_sessions SET started_at = now() - interval '20 minutes',
    last_activity_at = now() - interval '5 minutes' WHERE id = $1`, [pending.session_id]);
  await db.query(`UPDATE public.work_sessions SET start_time = now() - interval '20 minutes',
    last_heartbeat_at = now() - interval '5 minutes' WHERE user_id = $1 AND end_time IS NULL`, [a.user.id]);
  const expectedEnd = (await db.query(`SELECT last_heartbeat_at + interval '1 minute' AS cutoff,
    GREATEST(round(extract(epoch FROM (last_heartbeat_at + interval '1 minute' - start_time)) / 60)::integer, 0) AS duration
    FROM public.work_sessions WHERE user_id = $1 AND end_time IS NULL`, [a.user.id])).rows[0];
  await db.query(`INSERT INTO public.users(username, employee_id, password_hash, created_by, is_active)
    VALUES ('maintenance-disabled', 'M-disabled', 'unchanged-disabled-hash', $1, false)`, [TEAM]);
  const protectedBefore = await moneyAndOrders();
  const attributes = (await db.query(`SELECT to_jsonb(u) - ARRAY['current_session_token','current_tab_id','updated_at'] AS row
    FROM public.users u WHERE created_by = $1 ORDER BY id`, [TEAM])).rows;
  const teamCount = Number((await db.query('SELECT count(*) FROM public.users WHERE created_by = $1', [TEAM])).rows[0].count);
  const result = await set(TEAM, TEAM, true);
  assert.equal(result.success, true); assert.equal(result.affected_employees, teamCount);
  assert.equal(result.stopped_sessions, 2);
  assert.deepEqual(await moneyAndOrders(), protectedBefore);
  assert.deepEqual((await db.query(`SELECT to_jsonb(u) - ARRAY['current_session_token','current_tab_id','updated_at'] AS row
    FROM public.users u WHERE created_by = $1 ORDER BY id`, [TEAM])).rows, attributes);
  const stopped = (await db.query('SELECT end_time, duration_minutes FROM public.work_sessions WHERE user_id = $1 ORDER BY start_time DESC LIMIT 1', [a.user.id])).rows[0];
  assert.equal(stopped.end_time.getTime(), expectedEnd.cutoff.getTime());
  assert.equal(stopped.duration_minutes, expectedEnd.duration);
  assert.equal((await db.query('SELECT ended_at FROM public.dispatch_sessions WHERE id = $1', [pending.session_id])).rows[0].ended_at.getTime(), expectedEnd.cutoff.getTime());
  for (const [session, active] of [[a, pending], [b, accepted]]) {
    assert.equal(await valid(session), false);
    assert.deepEqual(await status(session), { maintenance: true, session_valid: false });
    assert.equal((await db.query('SELECT status FROM public.dispatch_assignments WHERE id = $1', [active.assignment.id])).rows[0].status, 'cancelled');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.work_sessions WHERE user_id = $1 AND end_time IS NULL', [session.user.id])).rows[0].n, 0);
    const { rows: [times] } = await db.query(`SELECT d.status, d.ended_at, m.stopped_at FROM public.dispatch_sessions d
      JOIN private.employee_work_stop_markers m ON m.user_id = d.user_id WHERE d.id = $1`, [active.session_id]);
    assert.equal(times.status, 'offline'); assert(times.ended_at <= times.stopped_at);
    for (const [fn, extra] of [
      ['start_employee_dispatch_session_secure', {}],
      ['recover_employee_dispatch_assignment_secure', {}],
      ['resume_employee_dispatch_session_secure', { p_previous_session_id: active.session_id }],
      ['update_session_heartbeat_secure', { p_session_id: active.session_id }],
      ['accept_dispatch_assignment_secure', { p_session_id: active.session_id, p_assignment_id: active.assignment.id, p_assignment_code: 'ASN-BLOCKED' }],
    ]) await assert.rejects(work(fn, session, extra), /invalid|expired|offline/i);
    await assert.rejects(db.query('SELECT private.get_financial_employee_id($1, $2, $3)', [session.user.id, session.session_token, TAB]), /invalid or expired/);
  }
  assert.equal(await valid(other), true);
  assert.deepEqual((await db.query('SELECT * FROM public.dispatch_sessions WHERE user_id = $1', [other.user.id])).rows, otherBefore.sessions);
  assert.deepEqual((await db.query('SELECT * FROM public.work_sessions WHERE user_id = $1', [other.user.id])).rows, otherBefore.work);
  assert.deepEqual((await db.query('SELECT * FROM public.dispatch_assignments WHERE user_id = $1', [other.user.id])).rows, otherBefore.assignment);
  assert.equal((await work('update_session_heartbeat_secure', other, { p_session_id: otherWork.session_id })).success, true);
  const workBeforeDisable = await rowsOf('public.work_sessions');
  await set(TEAM, TEAM, false);
  assert.deepEqual(await rowsOf('public.work_sessions'), workBeforeDisable);
  assert.equal((await db.query('SELECT is_active FROM public.users WHERE username = $1', ['maintenance-disabled'])).rows[0].is_active, false);
  for (const session of [a, b]) {
    assert.equal(await valid(session), false); // Remember-me/refresh cannot restore the old token.
    const fresh = await login(session.user.username);
    assert.equal(fresh.success, true); assert.equal(await valid(fresh), true);
    assert.equal((await work('recover_employee_dispatch_assignment_secure', fresh)).recovered, false);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.dispatch_sessions WHERE user_id = $1 AND status = $2', [session.user.id, 'online'])).rows[0].n, 0);
  }
});

test('maintenance reason requires the real unexpired financial token, its user and its exact tab', async () => {
  const a = await employee();
  const superseded = await login(a.user.username);
  assert.deepEqual(await status(a), { maintenance: false, session_valid: false });
  const b = await employee();
  await set(TEAM, TEAM, true);
  assert.deepEqual(await status(superseded), { maintenance: true, session_valid: false });
  assert.deepEqual(await status(a), { maintenance: false, session_valid: false }); // Ordinary revoked token is not upgraded.
  for (const overrides of [
    { p_session_token: INVALID_TOKEN }, { p_session_token: superseded.session_marker },
    { p_user_id: b.user.id }, { p_user_id: null }, { p_session_token: null },
    { p_tab_id: 'wrong-tab' }, { p_tab_id: null }, { p_tab_id: '' },
  ]) assert.deepEqual(await status(superseded, overrides), { maintenance: false, session_valid: false });
  assert.deepEqual((await asBrowser('SELECT public.get_employee_maintenance_status($1, $2, $3) AS result',
    [superseded.user.id, superseded.session_token, TAB], 'authenticated')).rows[0].result, { maintenance: true, session_valid: false });
  // Also exercise the current-team branch independently of the historical reason.
  await db.query(`UPDATE public.employee_financial_sessions SET revoked_at = NULL, maintenance_revoked_at = NULL
    WHERE token_hash = private.hash_financial_token($1)`, [b.session_token]);
  await db.query('UPDATE public.users SET current_session_token = $1, current_tab_id = $2 WHERE id = $3', [b.session_marker, TAB, b.user.id]);
  assert.deepEqual(await status(b), { maintenance: true, session_valid: false });
  await db.query(`UPDATE public.employee_financial_sessions SET expires_at = now() - interval '1 second'
    WHERE token_hash = private.hash_financial_token($1)`, [superseded.session_token]);
  assert.deepEqual(await status(superseded), { maintenance: false, session_valid: false });
  await set(TEAM, TEAM, true); // Re-revoke the isolated branch fixture.
  await set(TEAM, TEAM, false);
  assert.equal(await valid(b), false);
});

test('maintenance ends orphan work and heartbeat-only dispatch rows without changing already ended sessions', async () => {
  const orphan = await employee();
  const dispatchOnly = await employee();
  await db.query(`INSERT INTO public.work_sessions(user_id, start_time, last_heartbeat_at)
    VALUES ($1, now() - interval '20 minutes', now() - interval '5 minutes')`, [orphan.user.id]);
  const active = await work('start_employee_dispatch_session_secure', dispatchOnly);
  await db.query('DELETE FROM public.work_sessions WHERE user_id = $1', [dispatchOnly.user.id]);
  await db.query(`UPDATE public.dispatch_sessions SET started_at = now() - interval '20 minutes',
    last_activity_at = now() - interval '5 minutes' WHERE id = $1`, [active.session_id]);
  const expected = (await db.query(`SELECT last_activity_at + interval '1 minute' AS cutoff
    FROM public.dispatch_sessions WHERE id = $1`, [active.session_id])).rows[0].cutoff;
  const endedBefore = (await db.query('SELECT * FROM public.work_sessions WHERE end_time IS NOT NULL ORDER BY id')).rows;
  await set(TEAM, TEAM, true);
  assert.equal((await db.query('SELECT ended_at FROM public.dispatch_sessions WHERE id = $1', [active.session_id])).rows[0].ended_at.getTime(), expected.getTime());
  assert.equal((await db.query(`SELECT end_time = last_heartbeat_at + interval '1 minute' AS capped
    FROM public.work_sessions WHERE user_id = $1`, [orphan.user.id])).rows[0].capped, true);
  assert.deepEqual((await db.query(`SELECT * FROM public.work_sessions WHERE id = ANY($1::uuid[]) ORDER BY id`, [endedBefore.map(s => s.id)])).rows, endedBefore);
  const stopped = await rowsOf('public.dispatch_sessions');
  assert.equal((await set(TEAM, TEAM, true)).stopped_sessions, 0);
  assert.deepEqual(await rowsOf('public.dispatch_sessions'), stopped);
  await set(TEAM, TEAM, false);
});

test('submitted assignments and actual orders survive maintenance, while direct inserts are blocked only for that team', async t => {
  const actual = await employee();
  const marked = await employee();
  const pendingActual = await employee();
  const other = await employee(OTHER);
  const submitted = await dispatch(actual, true);
  const flagOnly = await dispatch(marked, true);
  const pending = await dispatch(pendingActual, true);
  const existingOrder = await order(actual, submitted.assignment.assignment_id);
  await order(pendingActual, pending.assignment.assignment_id);
  await db.query('UPDATE public.dispatch_assignments SET status = $1 WHERE id = $2', ['pending', pending.assignment.id]);
  await db.query('UPDATE public.dispatch_assignments SET order_submitted = true WHERE id = $1', [flagOnly.assignment.id]);
  const assignments = (await db.query('SELECT * FROM public.dispatch_assignments WHERE id = ANY($1::uuid[]) ORDER BY id',
    [[submitted.assignment.id, flagOnly.assignment.id, pending.assignment.id]])).rows;
  const otherExistingOrder = await order(other);
  const protectedBefore = await moneyAndOrders();
  const dataId = await validData();
  const authenticatedDataId = await validData();
  const invalidDataId = await validData();
  await set(TEAM, TEAM, true);
  assert.deepEqual(await moneyAndOrders(), protectedBefore);
  assert.deepEqual((await db.query('SELECT * FROM public.dispatch_assignments WHERE id = ANY($1::uuid[]) ORDER BY id',
    [[submitted.assignment.id, flagOnly.assignment.id, pending.assignment.id]])).rows, assignments);
  await assert.rejects(order(actual), /employee_login_maintenance/);
  await assert.rejects(order(actual, submitted.assignment.assignment_id), /employee_login_maintenance/);
  const usageSQL = 'INSERT INTO public.used_order_data(user_id, valid_order_data_id, order_id) VALUES ($1,$2,$3) RETURNING id';
  for (const [role, validId] of [['anon', dataId], ['authenticated', authenticatedDataId]]) {
    const params = [actual.user.id, validId, existingOrder.id];
    assert((await asBrowser(usageSQL, params, role)).rows[0].id);
    await assert.rejects(asBrowser(usageSQL, params, role), error => error.code === '23505'
      && error.constraint === 'used_order_data_user_id_valid_order_data_id_key');
    for (const invalidOrderId of [otherExistingOrder.id, null, INVALID_TOKEN]) {
      await assert.rejects(asBrowser(usageSQL, [actual.user.id, invalidDataId, invalidOrderId], role), /employee_login_maintenance/);
    }
    await assert.rejects(asBrowser('INSERT INTO public.used_order_data(user_id, valid_order_data_id) VALUES ($1,$2)',
      [actual.user.id, invalidDataId], role), /employee_login_maintenance/);
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.used_order_data WHERE user_id = $1', [actual.user.id])).rows[0].n, 2);
  assert.deepEqual(await moneyAndOrders(), protectedBefore);
  const otherOrder = await order(other);
  await asBrowser('INSERT INTO public.used_order_data(user_id, valid_order_data_id, order_id) VALUES ($1,$2,$3)', [other.user.id, dataId, otherOrder.id]);
  // Existing-order UPDATE is not guarded. Exercise a system scheduling write
  // without bypassing any trigger; settlement functions are definition-pinned.
  await db.query('UPDATE public.orders SET scheduled_process_at = now() WHERE id = $1', [existingOrder.id]);
  assert((await db.query('SELECT scheduled_process_at FROM public.orders WHERE id = $1', [existingOrder.id])).rows[0].scheduled_process_at);
  // The real history has an unrelated broken status-audit trigger. Record the
  // exact limitation, not a fake successful settlement or a trigger/schema patch.
  await assert.rejects(db.query("UPDATE public.orders SET status = 'failure', processed_at = now() WHERE id = $1", [existingOrder.id]),
    /column "old_order_status" of relation "commission_audit_log" does not exist/);
  t.diagnostic('Full settlement is NOT verified: legacy commission_audit_log lacks old_order_status; no trigger was bypassed or audit schema patched.');
  assert.equal((await db.query('SELECT status FROM public.orders WHERE id = $1', [existingOrder.id])).rows[0].status, 'processing');
  const walletBeforeRepeat = await rowsOf('public.wallet_transactions');
  await set(TEAM, TEAM, true);
  await set(TEAM, TEAM, false);
  assert.deepEqual(await rowsOf('public.wallet_transactions'), walletBeforeRepeat);
  const fresh = await employee();
  assert((await order(fresh)).id);
});

test('new login cannot auto-recover a pre-maintenance submitted assignment but can explicitly start work', async () => {
  for (const submittedFlag of [false, true]) {
    const original = await employee();
    const active = await dispatch(original, true);
    await order(original, active.assignment.assignment_id);
    if (submittedFlag) await db.query('UPDATE public.dispatch_assignments SET order_submitted = true WHERE id = $1', [active.assignment.id]);
    const assignmentBefore = (await db.query('SELECT * FROM public.dispatch_assignments WHERE id = $1', [active.assignment.id])).rows;
    const protectedBefore = await moneyAndOrders();
    assert.equal((await set(TEAM, TEAM, true)).success, true);
    assert.equal((await set(TEAM, TEAM, false)).success, true);
    // Historical maintenance evidence must survive the old token's expiry.
    await db.query(`UPDATE public.employee_financial_sessions SET expires_at = now() - interval '1 second'
      WHERE token_hash = private.hash_financial_token($1)`, [original.session_token]);
    const fresh = await login(original.user.username);
    assert.equal(fresh.success, true); assert.equal(await valid(fresh), true);
    assert.equal(await valid(original), false);
    assert.equal((await get(TEAM)).enabled, false);
    const dispatchBefore = await rowsOf('public.dispatch_sessions');
    const workBefore = await rowsOf('public.work_sessions');
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await work('recover_employee_dispatch_assignment_secure', fresh),
        { success: true, recovered: false, assignment: null });
    }
    assert.deepEqual(await rowsOf('public.dispatch_sessions'), dispatchBefore);
    assert.deepEqual(await rowsOf('public.work_sessions'), workBefore);
    assert.deepEqual((await db.query('SELECT * FROM public.dispatch_assignments WHERE id = $1', [active.assignment.id])).rows, assignmentBefore);
    assert.deepEqual(await moneyAndOrders(), protectedBefore);
    const started = await work('start_employee_dispatch_session_secure', fresh);
    assert.equal(started.success, true);
    assert.notEqual(started.session_id, active.session_id);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.dispatch_sessions WHERE user_id = $1 AND status = 'online'", [fresh.user.id])).rows[0].n, 1);
    assert.equal((await work('end_employee_dispatch_session_secure', fresh)).success, true);
  }
});

test('recovery still works for post-maintenance assignments and stop markers without maintenance revocation', async () => {
  const original = await employee();
  await set(TEAM, TEAM, true);
  await set(TEAM, TEAM, false);
  const fresh = await login(original.user.username);
  const active = await dispatch(fresh, true);
  assert.equal((await db.query(`SELECT a.assigned_at > max(s.maintenance_revoked_at) AS newer
    FROM public.dispatch_assignments a JOIN public.employee_financial_sessions s ON s.user_id = a.user_id
    WHERE a.id = $1 GROUP BY a.assigned_at`, [active.assignment.id])).rows[0].newer, true);
  await work('stop_employee_dispatch_session_secure', fresh, { p_session_id: active.session_id });
  const recovered = await work('recover_employee_dispatch_assignment_secure', fresh);
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.assignment.id, active.assignment.id);
  await work('end_employee_dispatch_session_secure', fresh);

  const other = await employee(OTHER);
  const otherActive = await dispatch(other, true);
  await work('end_employee_dispatch_session_secure', other);
  const otherFresh = await login(other.user.username);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM public.employee_financial_sessions
    WHERE user_id = $1 AND maintenance_revoked_at IS NOT NULL`, [other.user.id])).rows[0].n, 0);
  const otherRecovered = await work('recover_employee_dispatch_assignment_secure', otherFresh);
  assert.equal(otherRecovered.recovered, true);
  assert.equal(otherRecovered.assignment.id, otherActive.assignment.id);
  await work('end_employee_dispatch_session_secure', otherFresh);
});

test('late failure rolls back settings, revocations, markers, sessions, assignments and audit together', async () => {
  const session = await employee();
  await dispatch(session);
  const tables = ['private.employee_login_maintenance', 'private.employee_login_maintenance_confirmations',
    'private.employee_login_maintenance_events', 'public.employee_financial_sessions', 'public.users',
    'private.employee_work_stop_markers', 'public.dispatch_sessions', 'public.work_sessions', 'public.dispatch_assignments'];
  const before = {};
  for (const table of tables) before[table] = await rowsOf(table);
  await db.exec(`ALTER TABLE private.employee_login_maintenance_events ADD CONSTRAINT maintenance_qa_failure
    CHECK (owner_admin_id <> '${TEAM}' OR NOT enabled) NOT VALID`);
  try {
    await assert.rejects(set(TEAM, TEAM, true), /maintenance_qa_failure/);
    for (const table of tables) assert.deepEqual(await rowsOf(table), before[table], `${table} must roll back`);
    assert.equal(await valid(session), true);
  } finally { await db.exec('ALTER TABLE private.employee_login_maintenance_events DROP CONSTRAINT maintenance_qa_failure'); }
});

test('employee password lockout and external account locks still take precedence over maintenance', async () => {
  const session = await employee();
  await set(TEAM, TEAM, true);
  for (let i = 0; i < 5; i++) assert.equal((await login(session.user.username, 'wrong')).error, 'Invalid credentials');
  assert.equal((await login(session.user.username)).error, 'Account is temporarily locked.');
  await db.query(`UPDATE public.financial_login_attempts SET locked_until = now() - interval '1 second'
    WHERE account_type = 'employee' AND username = $1`, [session.user.username]);
  assert.equal((await login(session.user.username)).code, 'employee_login_maintenance');
  await set(TEAM, TEAM, false);
  assert.equal((await login(session.user.username)).success, true);
  await db.query(`INSERT INTO public.account_locks(identifier, identifier_type, lock_until)
    VALUES ($1, 'username', now() + interval '15 minutes')`, [session.user.username]);
  assert.equal((await login(session.user.username)).error, 'Account is temporarily locked.');
  await db.query('DELETE FROM public.account_locks WHERE identifier = $1', [session.user.username]);
});

test('expired sessions, null states, invalid targets, and direct private-table access are rejected', async () => {
  await assert.rejects(set(SUPER, TEAM, null), /must not be null/);
  await assert.rejects(get(SUPER, null), /Permission denied/);
  await assert.rejects(get(SUPER, '99999999-0000-4000-8000-000000000099'), /not available/);
  await db.query('UPDATE public.admin_financial_sessions SET expires_at = now() - interval \'1 second\' WHERE token_hash = private.hash_financial_token($1)', [TOKENS[OTHER]]);
  await assert.rejects(get(OTHER), /invalid or expired/);
  await db.exec('SET ROLE anon');
  try { await assert.rejects(db.query('SELECT * FROM private.employee_login_maintenance'), /permission denied/); }
  finally { await db.exec('RESET ROLE'); }
});

test('dispatch clock migration only extends responses, preserving random algorithms and permissions', async () => {
  for (const signature of clockSignatures) {
    const actual = await definition(signature);
    assert(actual.includes(clockPatch));
    assert.equal(actual.replaceAll(clockPatch, ''), clockDefinitions[signature]);
  }
  assert.deepEqual((await db.query(`SELECT oid, proowner, prosecdef, proconfig, proacl::text
    FROM pg_proc WHERE oid = ANY($1::regprocedure[]) ORDER BY oid`, [clockSignatures])).rows, clockPermissions);
});

test('server time accompanies configurable intervals, sticky selections and not-due retries', async () => {
  const session = await employee();
  const started = await work('start_employee_dispatch_session_secure', session);
  const args = { p_session_id: started.session_id };
  const pool = (await db.query('SELECT id FROM public.dispatch_order_pools WHERE group_id = $1 AND is_base', [GROUP])).rows[0].id;
  for (const [min, max] of [[1, 1], [30, 150], [87, 213], [3000, 3000]]) {
    await db.query('DELETE FROM public.dispatch_pool_selections WHERE session_id = $1', [started.session_id]);
    await db.query('UPDATE public.dispatch_order_pools SET dispatch_interval_min = $2, dispatch_interval_max = $3 WHERE id = $1', [pool, min, max]);
    const prepared = await work('prepare_next_dispatch_order_secure', session, args);
    assert.equal(prepared.available, true);
    assert(Number.isFinite(Date.parse(prepared.server_now)));
    const seconds = Number((await db.query('SELECT extract(epoch FROM due_at - selected_at) AS seconds FROM public.dispatch_pool_selections WHERE session_id = $1', [started.session_id])).rows[0].seconds);
    assert(Number.isInteger(seconds) && seconds >= min && seconds <= max);
    await db.query('UPDATE public.dispatch_order_pools SET dispatch_interval_min = 1, dispatch_interval_max = 1 WHERE id = $1', [pool]);
    const repeated = await work('prepare_next_dispatch_order_secure', session, args);
    assert.equal(repeated.due_at, prepared.due_at);
    assert(Date.parse(repeated.server_now) >= Date.parse(prepared.server_now));
    const early = await work('assign_next_dispatch_order_secure', session, { ...args, p_group_id: GROUP });
    assert.equal(early.success, false);
    assert.equal(early.due_at, prepared.due_at);
    assert(Number.isFinite(Date.parse(early.server_now)));
  }
  await db.query("UPDATE public.dispatch_pool_selections SET selected_at = now() - interval '2 seconds', due_at = now() - interval '1 second' WHERE session_id = $1", [started.session_id]);
  const assigned = await work('assign_next_dispatch_order_secure', session, { ...args, p_group_id: GROUP });
  assert.equal(assigned.success, true);
  assert(Number.isFinite(Date.parse(assigned.server_now)));
  const active = await work('prepare_next_dispatch_order_secure', session, args);
  assert.equal(active.available, false);
  assert(Number.isFinite(Date.parse(active.server_now)));
  await assert.rejects(work('prepare_next_dispatch_order_secure', session, { ...args, p_session_token: INVALID_TOKEN }), /invalid|expired/i);
  await assert.rejects(work('assign_next_dispatch_order_secure', session, { ...args, p_group_id: GROUP, p_session_token: INVALID_TOKEN }), /invalid|expired/i);
  await work('end_employee_dispatch_session_secure', session);
});

test('dispatch status migration adds exactly four functions without changing existing catalog fingerprints', async t => {
  assert(statusCatalogBefore && statusCatalogAfter, 'capture immediately before and after the real status migration');
  const previous = new Set(statusCatalogBefore.functions.map(fn => fn.oid));
  const added = statusCatalogAfter.functions.filter(fn => !previous.has(fn.oid));
  assert.deepEqual(added.map(fn => fn.signature).sort(), statusSignatures);
  assert.equal(statusCatalogAfter.functions.length, statusCatalogBefore.functions.length + 4);
  assert.deepEqual(statusCatalogAfter.functions.filter(fn => previous.has(fn.oid)), statusCatalogBefore.functions);
  assert.deepEqual(statusCatalogAfter.objects, statusCatalogBefore.objects);
  assert.deepEqual(failures.map(f => f.file), historicalFailures); // Never widen the twelve-item allowlist.
  assert.deepEqual(failures.filter(f => f.file >= loginMigration), []);
  t.diagnostic(`Status migration: ${statusCatalogBefore.functions.length} existing function definitions/ACLs unchanged; exactly 4 added; all other captured catalogs and cron unchanged.`);
});

regression('status RPC ACLs, private-helper isolation, lock order and direct legacy return paths are pinned', async () => {
  for (const signature of statusSignatures) {
    const privateHelper = signature.startsWith('private.');
    const { rows: [metadata] } = await db.query(`SELECT prosecdef, proconfig,
        EXISTS (SELECT 1 FROM aclexplode(proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public,
        has_function_privilege('anon', oid, 'EXECUTE') AS anon,
        has_function_privilege('authenticated', oid, 'EXECUTE') AS authenticated
      FROM pg_proc WHERE oid = to_regprocedure($1)`, [signature]);
    assert.deepEqual(metadata, { prosecdef: true, proconfig: ['search_path=pg_catalog, public, private, pg_temp'],
      public: false, anon: !privateHelper, authenticated: !privateHelper });
  }
  const helper = await definition(statusSignatures.find(signature => signature.startsWith('private.')));
  const identityLock = helper.indexOf('FOR UPDATE OF financial_session, employee;');
  const dispatchRead = helper.indexOf('FROM public.dispatch_sessions AS session');
  const dispatchLock = helper.indexOf('FOR UPDATE;', dispatchRead);
  assert(identityLock > helper.indexOf('private.hash_financial_token(p_session_token)'));
  assert(identityLock < dispatchRead && dispatchRead < dispatchLock);
  assert(helper.indexOf("RETURN 'ended'") > dispatchLock);
  assert(helper.indexOf("RETURN 'ended'") < helper.indexOf("RETURN 'stale'"));
  for (const rpc of dispatchStatusCalls) {
    const source = await definition(statusSignatures.find(signature => signature.startsWith(`public.${rpc.name}(`)));
    assert(source.includes(`RETURN public.${rpc.legacy}(`), 'active branch returns the original JSON, not a reconstructed envelope');
    assert.match(source, new RegExp(`p_session_id, ${rpc.name.startsWith('update_') ? 'false' : 'true'}\\)`));
    assert.equal(/EXCEPTION|WHEN OTHERS/i.test(source), false, 'do not catch and relabel business errors');
  }
  const session = await employee();
  const started = await work('start_employee_dispatch_session_secure', session);
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(asBrowser('SELECT private.get_employee_dispatch_call_status($1,$2,$3,$4,true)',
      [session.user.id, session.session_token, TAB, started.session_id], role), { code: '42501' });
    assert.equal((await asBrowser(`SELECT public.prepare_next_dispatch_order_status_secure($1,$2,$3,$4) AS result`,
      [session.user.id, session.session_token, TAB, started.session_id], role)).rows[0].result.available, true);
  }
});

for (const endedCase of ['offline', 'ended_at', 'offline_without_end']) {
  regression(`valid identity gets ended with zero writes for all three status RPCs (${endedCase})`, async () => {
    const session = await employee();
    const active = await dispatch(session, true);
    await order(session, active.assignment.assignment_id); // Protect nonempty real orders, wallets and ledger too.
    await db.query(`UPDATE public.dispatch_sessions SET status = $2, ended_at = $3,
      last_activity_at = now() - interval '3 minutes' WHERE id = $1`,
    [active.session_id, endedCase === 'ended_at' ? 'online' : 'offline', endedCase === 'offline_without_end' ? null : new Date()]);
    await assertQuietStatus(session, active.session_id, 'ended'); // Ended wins even when also stale.
  });
}

for (const activity of ['older_than_two_minutes', 'null']) {
  regression(`prepare and assign return stale without writes, but heartbeat still updates (${activity})`, async () => {
    const session = await employee();
    const started = await work('start_employee_dispatch_session_secure', session);
    assert.equal((await work('prepare_next_dispatch_order_status_secure', session, { p_session_id: started.session_id })).available, true);
    await due(started.session_id); // A due selection must not be consumed by the stale wrapper.
    await db.query(`UPDATE public.dispatch_sessions SET last_activity_at =
      ${activity === 'null' ? 'NULL' : "now() - interval '2 minutes 1 second'"} WHERE id = $1`, [started.session_id]);
    await assertQuietStatus(session, started.session_id, 'stale');
    const beat = await work('update_session_heartbeat_status_secure', session, { p_session_id: started.session_id });
    assert.equal(beat.success, true);
    assert.equal(beat.work_sessions_updated, 1);
    assert.equal('session_status' in beat, false);
    const { rows: [times] } = await db.query(`SELECT d.last_activity_at = w.last_heartbeat_at AS same,
      d.last_activity_at >= now() - interval '1 second' AS fresh FROM public.dispatch_sessions d
      JOIN public.work_sessions w ON w.user_id = d.user_id AND w.end_time IS NULL WHERE d.id = $1`, [started.session_id]);
    assert.deepEqual(times, { same: true, fresh: true });
    assert.equal((await work('assign_next_dispatch_order_status_secure', session,
      { p_session_id: started.session_id, p_group_id: GROUP })).success, true);
  });
}

regression('exactly two minutes remains active for prepare/assign; only older activity is stale', async () => {
  const session = await employee();
  const started = await work('start_employee_dispatch_session_secure', session);
  // now() is fixed for this rollback-only transaction: exercise the inclusive
  // boundary without sleeps or clock tolerance that could hide a threshold bug.
  await db.query("UPDATE public.dispatch_sessions SET last_activity_at = now() - interval '2 minutes' WHERE id = $1", [started.session_id]);
  const prepared = await work('prepare_next_dispatch_order_status_secure', session, { p_session_id: started.session_id });
  assert.equal(prepared.available, true);
  assert.equal('session_status' in prepared, false);
  await due(started.session_id);
  const assigned = await work('assign_next_dispatch_order_status_secure', session,
    { p_session_id: started.session_id, p_group_id: GROUP });
  assert.equal(assigned.success, true);
  assert.equal('session_status' in assigned, false);
});

regression('base/random pool modes retain real eligibility filtering and sticky selection without trusting caller hints', async () => {
  const session = await employee();
  const started = await work('start_employee_dispatch_session_secure', session);
  const base = (await db.query('SELECT id FROM public.dispatch_order_pools WHERE group_id = $1 AND is_base', [GROUP])).rows[0].id;
  const alternate = (await db.query(`INSERT INTO public.dispatch_order_pools(group_id, pool_name,
    dispatch_interval_min, dispatch_interval_max, created_by) VALUES ($1, 'Status alternate', 87, 87, $2) RETURNING id`, [GROUP, SUPER])).rows[0].id;
  await db.query(`INSERT INTO public.dispatch_group_orders(group_id, pool_id, order_content, created_by)
    VALUES ($1, $2, 'Status alternate real order', $3)`, [GROUP, alternate, SUPER]);
  await db.query("UPDATE public.dispatch_groups SET pool_selection_mode = 'base' WHERE id = $1", [GROUP]);
  const args = { p_session_id: started.session_id };
  assert.equal((await work('prepare_next_dispatch_order_status_secure', session, args)).pool_id, base);
  await db.query('DELETE FROM public.dispatch_pool_selections WHERE session_id = $1', [started.session_id]);
  await db.query("UPDATE public.dispatch_groups SET pool_selection_mode = 'random' WHERE id = $1", [GROUP]);
  await db.query('UPDATE public.dispatch_order_pools SET is_active = false WHERE id = $1', [base]);
  const prepared = await work('prepare_next_dispatch_order_status_secure', session, args);
  assert.equal(prepared.pool_id, alternate);
  assert.equal(prepared.config.dispatch_interval_min, 87);
  assert.equal(prepared.config.dispatch_interval_max, 87);
  const legacy = await work('prepare_next_dispatch_order_secure', session, args);
  await assertClockedResult(prepared, withoutClock(legacy));
  await due(started.session_id);
  const assigned = await work('assign_next_dispatch_order_status_secure', session,
    { ...args, p_group_id: INVALID_TOKEN, p_dispatch_mode: 'sequential' });
  assert.equal(assigned.success, true);
  assert.equal(assigned.assignment.group_id, GROUP);
  assert.equal(assigned.assignment.pool_id, alternate);
  assert.equal(assigned.assignment.order_content, 'Status alternate real order');
});

for (const rpc of dispatchStatusCalls) {
  regression(`${rpc.name}: invalid token/tab/user/marker/disabled/revoked/expired identity wins over ended and stale`, async () => {
    const session = await employee();
    const other = await employee();
    const started = await work('start_employee_dispatch_session_secure', session);
    const variants = [
      { label: 'invalid token', overrides: { p_session_token: INVALID_TOKEN } },
      { label: 'null token', overrides: { p_session_token: null } },
      { label: 'marker is not token', overrides: { p_session_token: session.session_marker } },
      { label: 'wrong user', overrides: { p_user_id: other.user.id } },
      { label: 'null user', overrides: { p_user_id: null } },
      ...['wrong-tab', '', '   ', null].map(tab => ({ label: `tab ${tab}`, overrides: { p_tab_id: tab } })),
      { label: 'user marker changed', sql: 'UPDATE public.users SET current_session_token = $2 WHERE id = $1', value: INVALID_TOKEN },
      { label: 'financial marker changed', sql: 'UPDATE public.employee_financial_sessions SET session_marker = $2 WHERE user_id = $1', value: INVALID_TOKEN },
      { label: 'current tab changed', sql: 'UPDATE public.users SET current_tab_id = $2 WHERE id = $1', value: 'new-tab' },
      { label: 'disabled user', sql: 'UPDATE public.users SET is_active = false WHERE id = $1' },
      { label: 'revoked token', sql: 'UPDATE public.employee_financial_sessions SET revoked_at = now() WHERE user_id = $1' },
      { label: 'expired token', sql: "UPDATE public.employee_financial_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1" },
    ];
    for (const state of ['ended', 'stale']) {
      await db.query(`UPDATE public.dispatch_sessions SET status = $2, ended_at = $3,
        last_activity_at = now() - interval '3 minutes' WHERE id = $1`,
      [started.session_id, state === 'ended' ? 'offline' : 'online', state === 'ended' ? new Date() : null]);
      for (const variant of variants) {
        await trial(async () => {
          if (variant.sql) await db.query(variant.sql, variant.value === undefined ? [session.user.id] : [session.user.id, variant.value]);
          const before = await dispatchSnapshot();
          await assert.rejects(work(rpc.name, session, dispatchArgs(rpc, started.session_id, variant.overrides)),
            error => error.code === 'P0001' && error.message === 'Employee session is invalid or expired.', `${variant.label}, ${state}`);
          assert.deepEqual(await dispatchSnapshot(), before, `${variant.label} must fail before any write`);
        });
      }
    }
  });
  regression(`${rpc.name}: unknown, NULL, and another employee's dispatch session remain exceptions`, async () => {
    const session = await employee();
    const other = await employee();
    const foreign = await work('start_employee_dispatch_session_secure', other);
    await work('end_employee_dispatch_session_secure', other); // Even foreign ended sessions cannot be inspected.
    for (const sessionId of [INVALID_TOKEN, null, foreign.session_id]) {
      const before = await dispatchSnapshot();
      await assert.rejects(work(rpc.name, session, dispatchArgs(rpc, sessionId)),
        error => error.code === 'P0001' && error.message === 'Employee work session is invalid, offline, or stale.');
      assert.deepEqual(await dispatchSnapshot(), before);
    }
  });
}

regression('status prepare preserves real pool selection, arbitrary intervals, sticky due times and legacy response shape', async () => {
  const session = await employee();
  const started = await work('start_employee_dispatch_session_secure', session);
  const args = { p_session_id: started.session_id };
  const pool = (await db.query('SELECT id FROM public.dispatch_order_pools WHERE group_id = $1 AND is_base', [GROUP])).rows[0].id;
  await db.query("UPDATE public.dispatch_groups SET pool_selection_mode = 'base', grab_success_rate = 73 WHERE id = $1", [GROUP]);
  for (const [min, max] of [[1, 1], [30, 150], [87, 213], [3000, 3000]]) {
    await db.query('DELETE FROM public.dispatch_pool_selections WHERE session_id = $1', [started.session_id]);
    await db.query('UPDATE public.dispatch_order_pools SET dispatch_interval_min = $2, dispatch_interval_max = $3 WHERE id = $1', [pool, min, max]);
    const prepared = await work('prepare_next_dispatch_order_status_secure', session, args);
    assert.equal(prepared.available, true);
    assert.equal(prepared.pool_id, pool);
    assert.equal(prepared.config.dispatch_interval_min, min);
    assert.equal(prepared.config.dispatch_interval_max, max);
    assert.equal(prepared.config.grab_success_rate, 73);
    const { rows: [selection] } = await db.query(`SELECT pool_id, due_at, extract(epoch FROM due_at - selected_at)::float8 AS seconds
      FROM public.dispatch_pool_selections WHERE session_id = $1`, [started.session_id]);
    assert.equal(selection.pool_id, pool);
    assert.equal(Date.parse(prepared.due_at), selection.due_at.getTime());
    assert(Number.isInteger(selection.seconds) && selection.seconds >= min && selection.seconds <= max);
    await db.query('UPDATE public.dispatch_order_pools SET dispatch_interval_min = 1, dispatch_interval_max = 1 WHERE id = $1', [pool]);
    const before = await dispatchSnapshot();
    const legacy = await work('prepare_next_dispatch_order_secure', session, args);
    const repeated = await work('prepare_next_dispatch_order_status_secure', session, args);
    await assertClockedResult(repeated, withoutClock(legacy));
    assert.equal(repeated.due_at, prepared.due_at);
    assert.deepEqual(await dispatchSnapshot(), before, 'sticky read must not rewrite or reselect the pool');
  }
});

regression('status assign keeps not-due, due real assignment and duplicate prevention identical to legacy', async () => {
  const session = await employee();
  const started = await work('start_employee_dispatch_session_secure', session);
  const args = { p_session_id: started.session_id, p_group_id: GROUP, p_dispatch_mode: 'sequential' };
  await db.query("UPDATE public.dispatch_order_pools SET dispatch_interval_min = 3000, dispatch_interval_max = 3000, dispatch_order_mode = 'sequential' WHERE group_id = $1", [GROUP]);
  assert.equal((await work('prepare_next_dispatch_order_status_secure', session, { p_session_id: started.session_id })).available, true);
  const before = await dispatchSnapshot();
  const earlyLegacy = await work('assign_next_dispatch_order_secure', session, args);
  assert.equal(earlyLegacy.message, 'Dispatch order is not due yet.');
  await assertClockedResult(await work('assign_next_dispatch_order_status_secure', session, args), withoutClock(earlyLegacy));
  assert.deepEqual(await dispatchSnapshot(), before);
  await due(started.session_id);
  const legacy = await trial(() => work('assign_next_dispatch_order_secure', session, args));
  const assigned = await work('assign_next_dispatch_order_status_secure', session, args);
  assert.equal(assigned.success, true);
  const { rows: [saved] } = await db.query('SELECT * FROM public.dispatch_assignments WHERE id = $1', [assigned.assignment.id]);
  assert.equal(saved.user_id, session.user.id);
  assert.equal(saved.status, 'pending');
  assert.equal(saved.dispatch_session_id, started.session_id);
  assert.equal(Date.parse(assigned.assignment.assigned_at), saved.assigned_at.getTime());
  assert.equal(Date.parse(assigned.assignment.accept_deadline_at), saved.accept_deadline_at.getTime());
  assert.equal(saved.accept_deadline_at.getTime() - saved.assigned_at.getTime(), 60000);
  // Only DB-generated UUIDs / clock instants differ between independent writes.
  await assertClockedResult(assigned, { ...withoutClock(legacy), assignment: { ...legacy.assignment,
    id: assigned.assignment.id, assigned_at: assigned.assignment.assigned_at,
    accept_deadline_at: assigned.assignment.accept_deadline_at } });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.dispatch_pool_selections WHERE session_id = $1', [started.session_id])).rows[0].n, 0);
  const after = await dispatchSnapshot();
  for (const rpc of dispatchStatusCalls.slice(0, 2)) {
    const rpcArgs = dispatchArgs(rpc, started.session_id);
    const original = await work(rpc.legacy, session, rpcArgs);
    assert.equal(original.message, 'An active dispatch assignment already exists.');
    await assertClockedResult(await work(rpc.name, session, rpcArgs), withoutClock(original));
  }
  assert.deepEqual(await dispatchSnapshot(), after, 'repeat assign cannot create another assignment/order or consume money');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.dispatch_assignments WHERE user_id = $1', [session.user.id])).rows[0].n, 1);
});

for (const grabRate of [0, 100]) {
  regression(`status-assigned orders inherit legacy grab ${grabRate}% and immutable commission/order-success snapshots`, async () => {
    const session = await employee();
    await db.query(`UPDATE public.dispatch_groups SET grab_success_rate = $2, dispatch_success_rate = 37,
      commission_rate = 0.1234, session_timeout_minutes = 13, submit_wait_min_seconds = 7, submit_wait_max_seconds = 19
      WHERE id = $1`, [GROUP, grabRate]);
    const started = await work('start_employee_dispatch_session_secure', session);
    await work('prepare_next_dispatch_order_status_secure', session, { p_session_id: started.session_id });
    await due(started.session_id);
    const assigned = await work('assign_next_dispatch_order_status_secure', session,
      { p_session_id: started.session_id, p_group_id: GROUP });
    assert.equal(assigned.success, true);
    const { rows: [snapshot] } = await db.query(`SELECT grab_success_rate_snapshot, dispatch_success_rate_snapshot,
      commission_rate_snapshot::float8, session_timeout_minutes_snapshot, submit_wait_min_seconds_snapshot,
      submit_wait_max_seconds_snapshot FROM public.dispatch_assignments WHERE id = $1`, [assigned.assignment.id]);
    assert.deepEqual(snapshot, { grab_success_rate_snapshot: grabRate, dispatch_success_rate_snapshot: 37,
      commission_rate_snapshot: 0.1234, session_timeout_minutes_snapshot: 13,
      submit_wait_min_seconds_snapshot: 7, submit_wait_max_seconds_snapshot: 19 });
    // Later settings must not change either the grab decision or order rate.
    await db.query(`UPDATE public.dispatch_groups SET grab_success_rate = $2, dispatch_success_rate = 91,
      commission_rate = 0.5, session_timeout_minutes = 20, submit_wait_min_seconds = 30, submit_wait_max_seconds = 40
      WHERE id = $1`, [GROUP, 100 - grabRate]);
    const code = `ASN-STATUS-${++fixtureSequence}`;
    const accepted = await work('accept_dispatch_assignment_secure', session,
      { p_session_id: started.session_id, p_assignment_id: assigned.assignment.id, p_assignment_code: code });
    if (grabRate === 0) {
      assert.deepEqual(accepted, { success: false, reason: 'grab_failed', assignment_status: 'cancelled', unaccepted_count: null });
    } else {
      assert.equal(accepted.success, true);
      const savedOrder = await order(session, code);
      assert.equal(Number(savedOrder.dispatch_commission_rate_snapshot), 0.1234);
      assert.equal(savedOrder.dispatch_success_rate_snapshot, 37);
      const wait = await work('get_employee_dispatch_submit_wait_secure', session);
      // Actual order exists, so the old submission guard must reject another one.
      assert.equal(wait.available, false);
    }
    assert.equal((await db.query('SELECT status FROM public.dispatch_assignments WHERE id = $1', [assigned.assignment.id])).rows[0].status,
      grabRate === 0 ? 'cancelled' : 'accepted');
  });
}

regression('normal status heartbeat preserves raw legacy envelope and updates both activity/work time', async () => {
  const session = await employee();
  const started = await work('start_employee_dispatch_session_secure', session);
  await db.query(`UPDATE public.dispatch_sessions SET started_at = now() - interval '20 minutes',
    last_activity_at = now() - interval '5 minutes' WHERE id = $1`, [started.session_id]);
  await db.query(`UPDATE public.work_sessions SET start_time = now() - interval '20 minutes',
    last_heartbeat_at = now() - interval '5 minutes' WHERE user_id = $1 AND end_time IS NULL`, [session.user.id]);
  const args = { p_session_id: started.session_id };
  const legacy = await trial(() => work('update_session_heartbeat_secure', session, args));
  const beat = await work('update_session_heartbeat_status_secure', session, args);
  assert.deepEqual(beat, { ...legacy, heartbeat_at: beat.heartbeat_at });
  assert.equal(beat.success, true);
  assert.equal(beat.work_sessions_updated, 1);
  assert(Number.isFinite(Date.parse(beat.heartbeat_at)));
  const { rows: [times] } = await db.query(`SELECT d.last_activity_at, w.last_heartbeat_at,
    extract(epoch FROM w.last_heartbeat_at - w.start_time)::float8 AS seconds
    FROM public.dispatch_sessions d JOIN public.work_sessions w ON w.user_id = d.user_id AND w.end_time IS NULL
    WHERE d.id = $1`, [started.session_id]);
  assert.equal(times.last_activity_at.getTime(), Date.parse(beat.heartbeat_at));
  assert.equal(times.last_heartbeat_at.getTime(), Date.parse(beat.heartbeat_at));
  assert(times.seconds >= 1200);
  assert.equal((await work('end_employee_dispatch_session_secure', session)).success, true);
  const { rows: [ended] } = await db.query(`SELECT duration_minutes, end_time FROM public.work_sessions
    WHERE user_id = $1 ORDER BY start_time DESC LIMIT 1`, [session.user.id]);
  assert.equal(ended.duration_minutes, 20);
  assert(ended.end_time);
  await assertQuietStatus(session, started.session_id, 'ended');
});

regression('heartbeat with no open work session returns the unchanged legacy business failure, not ended', async () => {
  const session = await employee();
  const started = await work('start_employee_dispatch_session_secure', session);
  await db.query('DELETE FROM public.work_sessions WHERE user_id = $1', [session.user.id]);
  const before = await dispatchSnapshot();
  const args = { p_session_id: started.session_id };
  const legacy = await work('update_session_heartbeat_secure', session, args);
  assert.deepEqual(legacy, { success: false, reason: 'no_open_work_session', session_id: started.session_id,
    user_id: session.user.id, heartbeat_at: null, work_sessions_updated: 0 });
  assert.deepEqual(await work('update_session_heartbeat_status_secure', session, args), legacy);
  assert.deepEqual(await dispatchSnapshot(), before);
});

regression('explicit end remains stopped; beacon stop still recovers inside thirty seconds and old IDs return ended', async () => {
  const session = await employee();
  const started = await work('start_employee_dispatch_session_secure', session);
  await work('end_employee_dispatch_session_secure', session);
  await assertQuietStatus(session, started.session_id, 'ended');
  assert.equal((await work('recover_employee_dispatch_guarded', session, {
    p_expected_session_id: started.session_id, p_operation_id: (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id,
  })).recovered, false);
  assert.equal((await work('recover_employee_dispatch_assignment_secure', session)).recovered, false);
  // Separate employee: backdating only a later beacon's end time on the same
  // employee would incorrectly place it before the earlier explicit-stop marker.
  const beacon = await employee();
  const active = await work('start_employee_dispatch_session_secure', beacon);
  await work('stop_employee_dispatch_session_secure', beacon, { p_session_id: active.session_id });
  await db.query(`UPDATE public.dispatch_sessions SET started_at = now() - interval '40 seconds',
    last_activity_at = now() - interval '29 seconds', ended_at = now() - interval '29 seconds' WHERE id = $1`, [active.session_id]);
  await assertQuietStatus(beacon, active.session_id, 'ended');
  const recovered = await work('recover_employee_dispatch_guarded', beacon, {
    p_expected_session_id: active.session_id, p_operation_id: (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id,
  });
  assert.equal(recovered.recovered, true);
  assert.notEqual(recovered.session_id, active.session_id);
  assert.equal((await work('update_session_heartbeat_status_secure', beacon, { p_session_id: recovered.session_id })).success, true);
  await assertQuietStatus(beacon, active.session_id, 'ended');
  await assertQuietStatus(session, started.session_id, 'ended');
  assert.equal((await db.query("SELECT count(*)::int AS n FROM public.dispatch_sessions WHERE user_id = $1 AND status = 'online' AND ended_at IS NULL", [beacon.user.id])).rows[0].n, 1);

  const expired = await employee();
  const old = await work('start_employee_dispatch_session_secure', expired);
  await work('stop_employee_dispatch_session_secure', expired, { p_session_id: old.session_id });
  await db.query(`UPDATE public.dispatch_sessions SET started_at = now() - interval '40 seconds',
    last_activity_at = now() - interval '31 seconds', ended_at = now() - interval '31 seconds' WHERE id = $1`, [old.session_id]);
  assert.equal((await work('recover_employee_dispatch_guarded', expired, {
    p_expected_session_id: old.session_id, p_operation_id: (await db.query('SELECT gen_random_uuid() AS id')).rows[0].id,
  })).recovered, false);
  await assertQuietStatus(expired, old.session_id, 'ended');
});

for (const unavailable of ['no_group', 'no_orders']) {
  regression(`status prepare/assign keep legacy ${unavailable} responses and selection cleanup`, async () => {
    const session = await employee();
    const started = await work('start_employee_dispatch_session_secure', session);
    await work('prepare_next_dispatch_order_status_secure', session, { p_session_id: started.session_id });
    await due(started.session_id);
    if (unavailable === 'no_group') await db.query('DELETE FROM public.dispatch_group_members WHERE user_id = $1', [session.user.id]);
    else await db.query('UPDATE public.dispatch_group_orders SET is_active = false WHERE group_id = $1', [GROUP]);
    for (const rpc of dispatchStatusCalls.slice(0, 2)) {
      // Restore the due selection between interfaces, so assign really reaches
      // its no-candidate branch rather than prepare's prior cleanup hiding it.
      await trial(async () => {
        const args = dispatchArgs(rpc, started.session_id);
        const legacy = await work(rpc.legacy, session, args);
        // Restore the selected row after legacy's cleanup before comparing.
        await db.exec('ROLLBACK TO SAVEPOINT legacy_comparison');
        const actual = await work(rpc.name, session, args);
        await assertClockedResult(actual, withoutClock(legacy));
        const preparing = rpc.name.startsWith('prepare_');
        assert.equal(preparing ? actual.available : actual.success, false);
        assert.equal(actual.message, unavailable === 'no_group'
          ? (preparing ? 'No active dispatch group assigned.' : 'A new dispatch pool selection is required.')
          : (preparing ? 'No active orders in pool' : 'No active orders in selected pool.'));
        assert.equal('session_status' in actual, false);
        assert.equal((await db.query('SELECT count(*)::int AS n FROM public.dispatch_pool_selections WHERE session_id = $1', [started.session_id])).rows[0].n, 0);
      });
    }
  });
}

for (const rpc of dispatchStatusCalls.slice(0, 2)) {
  regression(`${rpc.name}: five-unaccepted auto-stop keeps legacy envelope and closes real work`, async () => {
    const session = await employee();
    const active = await dispatch(session); // Exercise the existing genuine assignment fixture.
    assert.equal((await work('finish_dispatch_assignment_secure', session,
      { p_assignment_id: active.assignment.id, p_status: 'cancelled' })).success, true);
    await db.query('UPDATE public.dispatch_sessions SET consecutive_unaccepted_count = 5 WHERE id = $1', [active.session_id]);
    const args = dispatchArgs(rpc, active.session_id);
    const legacy = await trial(() => work(rpc.legacy, session, args));
    const actual = await work(rpc.name, session, args);
    await assertClockedResult(actual, withoutClock(legacy));
    assert.equal(actual.auto_stopped, true);
    assert.equal('session_status' in actual, false);
    assert.equal((await db.query('SELECT status FROM public.dispatch_sessions WHERE id = $1', [active.session_id])).rows[0].status, 'offline');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.work_sessions WHERE user_id = $1 AND end_time IS NULL', [session.user.id])).rows[0].n, 0);
    await assertQuietStatus(session, active.session_id, 'ended');
  });
}

regression('five real unaccepted status assignments still auto-stop once and never reassign the same order', async () => {
  const session = await employee();
  const started = await work('start_employee_dispatch_session_secure', session);
  const assignedOrders = new Set();
  for (let missed = 1; missed <= 5; missed++) {
    const prepared = await work('prepare_next_dispatch_order_status_secure', session, { p_session_id: started.session_id });
    assert.equal(prepared.available, true);
    await due(started.session_id);
    const assigned = await work('assign_next_dispatch_order_status_secure', session,
      { p_session_id: started.session_id, p_group_id: GROUP });
    assert.equal(assigned.success, true);
    assert(!assignedOrders.has(assigned.assignment.dispatch_order_id));
    assignedOrders.add(assigned.assignment.dispatch_order_id);
    await db.query("UPDATE public.dispatch_assignments SET accept_deadline_at = now() - interval '1 second' WHERE id = $1", [assigned.assignment.id]);
    const expired = await work('expire_pending_dispatch_assignment_secure', session,
      { p_session_id: started.session_id, p_assignment_id: assigned.assignment.id });
    assert.equal(expired.success, true);
    assert.equal(expired.reason, 'expired');
    assert.equal(expired.unaccepted_count, missed);
    assert.equal(expired.auto_stopped, missed === 5);
    assert.equal(expired.schedule_next, missed < 5);
    const beforeRepeat = await dispatchSnapshot();
    const repeated = await work('expire_pending_dispatch_assignment_secure', session,
      { p_session_id: started.session_id, p_assignment_id: assigned.assignment.id });
    assert.equal(repeated.reason, 'already_resolved');
    assert.equal(repeated.unaccepted_count, missed);
    assert.deepEqual(await dispatchSnapshot(), beforeRepeat, 'repeated expiry must not count a missed order twice');
  }
  assert.equal((await db.query("SELECT count(*)::int AS n FROM public.dispatch_assignments WHERE user_id = $1 AND status = 'cancelled'", [session.user.id])).rows[0].n, 5);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM public.work_sessions WHERE user_id = $1 AND end_time IS NULL', [session.user.id])).rows[0].n, 0);
  await assertQuietStatus(session, started.session_id, 'ended');
});

for (const rpc of dispatchStatusCalls) {
  regression(`${rpc.name}: real downstream trigger exception propagates unchanged and rolls every write back`, async () => {
    const session = await employee();
    const started = await work('start_employee_dispatch_session_secure', session);
    if (rpc.name.startsWith('assign_')) {
      await work('prepare_next_dispatch_order_status_secure', session, { p_session_id: started.session_id });
      await due(started.session_id);
    }
    const beforeCatalog = await catalogFingerprints();
    const before = await dispatchSnapshot();
    await trial(async () => {
      const table = rpc.name.startsWith('prepare_') ? 'dispatch_pool_selections'
        : rpc.name.startsWith('assign_') ? 'dispatch_assignments' : 'work_sessions';
      const operation = rpc.name.startsWith('update_') ? 'UPDATE' : 'INSERT';
      // AFTER ensures real writes have run first (heartbeat also updates dispatch
      // before work). No production function, trigger or schema is bypassed.
      await db.exec(`CREATE FUNCTION private.qa_dispatch_status_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'qa real dispatch failure',
          DETAIL = 'qa downstream detail', HINT = 'qa downstream hint'; END $$;
        CREATE TRIGGER qa_dispatch_status_failure AFTER ${operation} ON public.${table}
          FOR EACH ROW WHEN (NEW.user_id = '${session.user.id}'::uuid)
          EXECUTE FUNCTION private.qa_dispatch_status_failure();`);
      const errors = [];
      for (const name of [rpc.legacy, rpc.name]) {
        await assert.rejects(work(name, session, dispatchArgs(rpc, started.session_id)), error => {
          errors.push({ code: error.code, message: error.message, detail: error.detail, hint: error.hint });
          return error.code === '23514' && error.message === 'qa real dispatch failure';
        });
        assert.deepEqual(await dispatchSnapshot(), before, `${name} must roll back every table, not just the failing row`);
      }
      assert.deepEqual(errors[1], errors[0]);
      assert.deepEqual(errors[1], { code: '23514', message: 'qa real dispatch failure',
        detail: 'qa downstream detail', hint: 'qa downstream hint' });
    });
    assert.deepEqual(await catalogFingerprints(), beforeCatalog, 'isolated failing trigger/function must be rolled back');
    assert.deepEqual(await dispatchSnapshot(), before);
    const retry = await work(rpc.name, session, dispatchArgs(rpc, started.session_id));
    assert.equal(rpc.name.startsWith('prepare_') ? retry.available : retry.success, true);
  });
}
