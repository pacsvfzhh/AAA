import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const [lifecycleSQL, resumeSQL, poolsSQL, fixSQL] = await Promise.all([
  migration('20260918210000_harden_admin_employee_management.sql'),
  migration('20260918215530_server_authoritative_dispatch_lifecycle.sql'),
  migration('20260927080031_add_secure_dispatch_order_pools.sql'),
  migration('20261101000003_keep_user_stopped_work_sessions_stopped.sql'),
]);

function functionSQL(source, name) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.notEqual(start, -1, `Function not found: ${name}`);
  const end = source.indexOf('$function$;', start);
  assert.notEqual(end, -1, `Function end not found: ${name}`);
  return source.slice(start, end + '$function$;'.length);
}

const EMPLOYEE = '00000000-0000-4000-8000-000000000001';
const TOKEN = '10000000-0000-4000-8000-000000000001';
const MARKER = '20000000-0000-4000-8000-000000000001';
const TAB = 'tab-1';
let db;

const call = async (fn, extra = '') =>
  (await db.query(`SELECT public.${fn}($1, $2, $3${extra}) AS result`, [EMPLOYEE, TOKEN, TAB])).rows[0].result;
const start = () => call('start_employee_dispatch_session_secure');
const beaconStop = sessionId => call('stop_employee_dispatch_session_secure', `, '${sessionId}'::uuid`);
const recover = () => call('recover_employee_dispatch_assignment_secure');
const onlineCount = async () => Number((await db.query(
  `SELECT count(*) FROM public.dispatch_sessions WHERE user_id = $1 AND status = 'online'`, [EMPLOYEE])).rows[0].count);

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA private;
    CREATE FUNCTION private.hash_financial_token(p_token uuid) RETURNS text
      LANGUAGE sql IMMUTABLE AS $$ SELECT md5(p_token::text) $$;
    CREATE TABLE public.users(id uuid PRIMARY KEY, current_session_token uuid, current_tab_id text,
      is_active boolean DEFAULT true);
    CREATE TABLE public.employee_financial_sessions(user_id uuid, token_hash text, revoked_at timestamptz,
      expires_at timestamptz, tab_id text, session_marker uuid);
    CREATE TABLE public.dispatch_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
      status text DEFAULT 'online', started_at timestamptz DEFAULT now(), ended_at timestamptz,
      last_activity_at timestamptz DEFAULT now(), consecutive_unaccepted_count integer DEFAULT 0);
    CREATE TABLE public.work_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
      start_time timestamptz, end_time timestamptz, duration_minutes integer, last_heartbeat_at timestamptz);
    CREATE TABLE public.dispatch_groups(id uuid PRIMARY KEY, session_timeout_minutes integer);
    CREATE TABLE public.dispatch_group_orders(id uuid PRIMARY KEY, group_id uuid, order_content text);
    CREATE TABLE public.dispatch_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
      status text, assigned_at timestamptz DEFAULT now(), accepted_at timestamptz, accept_deadline_at timestamptz,
      completed_at timestamptz, remarks text, dispatch_session_id uuid, dispatch_order_id uuid, group_id uuid,
      assignment_id uuid, order_submitted boolean DEFAULT false, session_timeout_minutes_snapshot integer,
      order_content_snapshot text);
    CREATE TABLE public.orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignment_id uuid, status text,
      created_at timestamptz DEFAULT now(), processed_at timestamptz);
    INSERT INTO public.users VALUES ('${EMPLOYEE}', '${MARKER}', '${TAB}', true);
    INSERT INTO public.employee_financial_sessions
      VALUES ('${EMPLOYEE}', md5('${TOKEN}'), NULL, now() + interval '1 day', '${TAB}', '${MARKER}');
  `);
  for (const name of ['start_employee_dispatch_session_secure', 'stop_employee_dispatch_session_secure']) {
    await db.exec(functionSQL(lifecycleSQL, `public.${name}`));
  }
  await db.exec(functionSQL(resumeSQL, 'public.resume_employee_dispatch_session_secure'));
  await db.exec(functionSQL(poolsSQL, 'public.recover_employee_dispatch_assignment_secure'));
});

test('before the fix a deliberately stopped session is resumed by a refresh', async () => {
  const session = await start();
  await beaconStop(session.session_id);
  const result = await recover();
  assert.equal(result.recovered, true);
  await call('stop_employee_dispatch_session_secure', ', NULL');
});

test('after the fix End Session stays ended across a refresh', async () => {
  await db.exec(fixSQL);
  const session = await start();
  const ended = await call('end_employee_dispatch_session_secure', `, '${session.session_id}'::uuid`);
  assert.equal(ended.success, true);
  assert.equal(ended.stopped_count, 1);
  assert.equal(await onlineCount(), 0);

  const result = await recover();
  assert.equal(result.recovered, false);
  assert.equal(await onlineCount(), 0);
});

test('a refresh (unload beacon stop) still resumes work', async () => {
  const session = await start();
  await beaconStop(session.session_id);
  const result = await recover();
  assert.equal(result.recovered, true);
  assert.equal(await onlineCount(), 1);
  await call('end_employee_dispatch_session_secure', ', NULL');
});

test('starting again after End Session and refreshing resumes the new session', async () => {
  await call('end_employee_dispatch_session_secure', ', NULL');
  await new Promise(resolve => setTimeout(resolve, 20));
  const session = await start();
  await beaconStop(session.session_id);
  const result = await recover();
  assert.equal(result.recovered, true);
  await call('end_employee_dispatch_session_secure', ', NULL');
});

test('End Session rejects an invalid employee session without writing a marker', async () => {
  const markersBefore = (await db.query('SELECT stopped_at FROM private.employee_work_stop_markers')).rows;
  await assert.rejects(
    db.query(`SELECT public.end_employee_dispatch_session_secure($1, $2, $3, NULL)`,
      [EMPLOYEE, '30000000-0000-4000-8000-000000000001', TAB]),
    /Employee session is invalid or expired/);
  const markersAfter = (await db.query('SELECT stopped_at FROM private.employee_work_stop_markers')).rows;
  assert.deepEqual(markersAfter, markersBefore);
});

test('browser roles can call End Session but cannot touch the marker table', async () => {
  const privilege = async (role, check) => (await db.query(check, [role])).rows[0].allowed;
  assert.equal(await privilege('anon',
    `SELECT has_function_privilege($1, 'public.end_employee_dispatch_session_secure(uuid, uuid, text, uuid)', 'EXECUTE') AS allowed`), true);
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await privilege(role,
      `SELECT has_table_privilege($1, 'private.employee_work_stop_markers', 'SELECT') AS allowed`), false);
  }
});
