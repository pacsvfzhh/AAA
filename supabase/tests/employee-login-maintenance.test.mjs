import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const migration = '20261103000000_employee_login_maintenance.sql';
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
const failures = [];
const originals = {};

async function call(name, args) {
  const keys = Object.keys(args);
  await db.exec('SET ROLE anon');
  try {
    return (await db.query(`SELECT public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')}) AS result`, keys.map(key => args[key]))).rows[0].result;
  } finally { await db.exec('RESET ROLE'); }
}
const get = (actor, owner = actor) => call('get_employee_login_maintenance', { p_admin_session_token: TOKENS[actor], p_owner_admin_id: owner });
const set = (actor, owner, enabled, password = `password-${actor === SUPER ? 'root' : actor === TEAM ? 'team' : 'other'}`) => call('set_employee_login_maintenance', { p_admin_session_token: TOKENS[actor], p_owner_admin_id: owner, p_admin_password: password, p_enabled: enabled });
const login = (username, password = 'employee-secret') => call('create_employee_financial_session', { p_username: username, p_password: password, p_tab_id: 'qa-tab' });
const count = async table => Number((await db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);

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
  for (const [index, file] of files.entries()) {
    for (const segment of segments) if (segment.before && file.startsWith(segment.before)) await db.exec(segment.sql);
    if (file === migration) {
      for (const fn of ['create_admin_financial_session(text,text)', 'validate_employee_session(uuid,text,text)']) {
        originals[fn] = (await db.query('SELECT pg_get_functiondef(to_regprocedure($1)) AS definition', [fn])).rows[0].definition;
      }
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
  `);
});
after(async () => { await db?.close(); });

test('new migration applies after the real history without changing admin login or session validation', async () => {
  assert.deepEqual(failures.filter(f => f.file >= migration), []);
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
  for (const signature of ['get_employee_login_maintenance(uuid,uuid)', 'set_employee_login_maintenance(uuid,uuid,text,boolean)']) {
    const { rows: [r] } = await db.query(`SELECT prosecdef, proconfig, has_function_privilege('anon', oid, 'EXECUTE') AS anon, EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public FROM pg_proc WHERE oid = to_regprocedure($1)`, [`public.${signature}`]);
    assert.equal(r.prosecdef, true); assert.equal(r.anon, true); assert.equal(r.public, false);
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
  assert.equal((await set(TEAM, TEAM, true, 'wrong')).error, 'invalid_password');
  assert.equal((await get(TEAM)).enabled, false);
  assert.equal(await count('private.employee_login_maintenance_events'), 0);
  assert.equal((await set(SUPER, TEAM, true, 'password-team')).error, 'invalid_password');
  assert.equal((await set(SUPER, TEAM, true)).success, true);
  assert.equal((await get(TEAM)).enabled, true);
  assert.equal((await get(OTHER)).enabled, false);
  assert.equal((await get(SUPER)).enabled, false);
  assert.equal((await set(SUPER, TEAM, false, '')).error, 'invalid_password');
  assert.equal((await get(TEAM)).enabled, true);
  assert.equal((await set(TEAM, TEAM, false)).success, true);
  assert.equal((await get(TEAM)).enabled, false);
});

test('blocked employee login creates no session, does not replace online sessions and does not count as a failed password', async () => {
  const original = await login('maintenance-employee');
  assert.equal(original.success, true);
  await set(TEAM, TEAM, true);
  const before = { sessions: await count('public.employee_financial_sessions'), history: await count('public.employee_login_history'), failures: await count('public.financial_login_attempts') };
  for (let i = 0; i < 7; i++) assert.deepEqual(await login('maintenance-employee'), { success: false, code: 'employee_login_maintenance' });
  assert.deepEqual({ sessions: await count('public.employee_financial_sessions'), history: await count('public.employee_login_history'), failures: await count('public.financial_login_attempts') }, before);
  const { rows: [user] } = await db.query('SELECT current_session_token FROM public.users WHERE username = $1', ['maintenance-employee']);
  assert.equal(user.current_session_token, original.session_marker);
  assert.equal((await db.query('SELECT revoked_at FROM public.employee_financial_sessions WHERE token_hash = private.hash_financial_token($1)', [original.session_token])).rows[0].revoked_at, null);
  assert.equal((await login('other-employee')).success, true);
  assert.equal((await login('root-employee')).success, true);
  const admin = await call('create_admin_financial_session', { p_username: 'maintenance-team', p_password: 'password-team' });
  assert.equal(admin.success, true);
  assert.equal((await login('maintenance-employee', 'wrong-password')).error, 'Invalid credentials');
  await set(TEAM, TEAM, false);
  assert.equal((await login('maintenance-employee')).success, true);
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
