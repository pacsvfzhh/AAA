import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const loginMigration = '20261103000000_employee_login_maintenance.sql';
const migration = '20261103000001_team_employee_maintenance.sql';
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
  await db.exec(`SET ROLE ${role}`);
  try { return await db.query(sql, params); }
  finally { await db.exec('RESET ROLE'); }
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

before(async () => {
  const segments = [{ before: null, sql: '' }];
  for (const line of (await readFile(new URL('baseline.sql', supportDir), 'utf8')).split('\n')) {
    const marker = line.match(/^-- @before (\S+)/);
    if (marker) segments.push({ before: marker[1], sql: '' }); else segments.at(-1).sql += `${line}\n`;
  }
  db = new PGlite({ extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await db.exec(await readFile(new URL('platform.sql', supportDir), 'utf8'));
  const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
  assert.equal(files.at(-1), migration);
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
    const sql = (await readFile(new URL(file, migrationDir), 'utf8')).replace(/CREATE EXTENSION IF NOT EXISTS pg_cron[^;]*;/gi, '').replace(/CREATE EXTENSION IF NOT EXISTS pg_trgm;/gi, '');
    try { await db.exec(sql); } catch (error) {
      failures.push({ file, message: String(error.message).split('\n')[0] });
      try { await db.exec('ROLLBACK'); } catch { /* historical migration may not open a transaction */ }
    }
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
    assert.equal((await db.query('SELECT pg_get_functiondef(to_regprocedure($1)) AS definition', [fn])).rows[0].definition, definition);
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
