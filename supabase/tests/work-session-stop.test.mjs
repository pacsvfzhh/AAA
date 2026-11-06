import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migration = name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const [lifecycleSQL, resumeSQL, poolsSQL, fixSQL, maintenanceSQL, guardedSQL, replaySubmittedSQL, financialSQL] = await Promise.all([
  migration('20260918210000_harden_admin_employee_management.sql'),
  migration('20260918215530_server_authoritative_dispatch_lifecycle.sql'),
  migration('20260927080031_add_secure_dispatch_order_pools.sql'),
  migration('20261101000003_keep_user_stopped_work_sessions_stopped.sql'),
  migration('20261103000001_team_employee_maintenance.sql'),
  migration('20261103000005_guard_dispatch_recovery.sql'),
  migration('20261103000006_replay_submitted_order_recovery.sql'),
  migration('20260914220000_add_atomic_wallet_financial_system.sql'),
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
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA private; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions;');
  const hashStart = financialSQL.indexOf('CREATE OR REPLACE FUNCTION private.hash_financial_token(');
  const hashEnd = financialSQL.indexOf('$$;', hashStart);
  assert.ok(hashStart >= 0 && hashEnd > hashStart, 'real financial token hash function exists');
  await db.exec(financialSQL.slice(hashStart, hashEnd + 3));
  await db.exec(`
    CREATE TABLE public.users(id uuid PRIMARY KEY, current_session_token uuid, current_tab_id text,
      is_active boolean DEFAULT true);
    CREATE TABLE public.employee_financial_sessions(user_id uuid, token_hash text, revoked_at timestamptz,
      expires_at timestamptz, tab_id text, session_marker uuid, maintenance_revoked_at timestamptz);
    CREATE TABLE public.dispatch_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
      status text DEFAULT 'online', started_at timestamptz DEFAULT now(), ended_at timestamptz,
      last_activity_at timestamptz DEFAULT now(), consecutive_unaccepted_count integer DEFAULT 0);
    CREATE TABLE public.work_sessions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
      start_time timestamptz, end_time timestamptz, duration_minutes integer, last_heartbeat_at timestamptz);
    CREATE TABLE public.dispatch_groups(id uuid PRIMARY KEY, session_timeout_minutes integer, dispatch_success_rate integer);
    CREATE TABLE public.dispatch_group_orders(id uuid PRIMARY KEY, group_id uuid, order_content text);
    CREATE TABLE public.dispatch_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
      status text, assigned_at timestamptz DEFAULT now(), accepted_at timestamptz, accept_deadline_at timestamptz,
      completed_at timestamptz, remarks text, dispatch_session_id uuid, dispatch_order_id uuid, group_id uuid,
      assignment_id text, order_submitted boolean DEFAULT false, session_timeout_minutes_snapshot integer,
      dispatch_success_rate_snapshot integer, order_content_snapshot text);
    CREATE TABLE public.orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignment_id text, user_id uuid, status text,
      created_at timestamptz DEFAULT now(), processed_at timestamptz);
    INSERT INTO public.users VALUES ('${EMPLOYEE}', '${MARKER}', '${TAB}', true);
    INSERT INTO public.employee_financial_sessions
      VALUES ('${EMPLOYEE}', private.hash_financial_token('${TOKEN}'), NULL, now() + interval '1 day', '${TAB}', '${MARKER}', NULL);
  `);
  for (const name of ['start_employee_dispatch_session_secure', 'stop_employee_dispatch_session_secure']) {
    await db.exec(functionSQL(lifecycleSQL, `public.${name}`));
  }
  await db.exec(functionSQL(resumeSQL, 'public.resume_employee_dispatch_session_secure'));
  await db.exec(functionSQL(resumeSQL, 'public.mark_dispatch_assignment_submitted_secure'));
  await db.exec(functionSQL(poolsSQL, 'public.accept_dispatch_assignment_secure'));
  await db.exec(functionSQL(poolsSQL, 'public.finish_dispatch_assignment_secure'));
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

const OTHER = '00000000-0000-4000-8000-000000000002';
const OTHER_TOKEN = '10000000-0000-4000-8000-000000000002';
const OTHER_MARKER = '20000000-0000-4000-8000-000000000002';
const NEW_TOKEN = '10000000-0000-4000-8000-000000000003';
const NEW_MARKER = '20000000-0000-4000-8000-000000000003';

const guarded = async (expected, operation, user = EMPLOYEE, token = TOKEN, tab = TAB) =>
  (await db.query('SELECT public.recover_employee_dispatch_guarded($1,$2,$3,$4,$5) AS result',
    [user, token, tab, expected, operation])).rows[0].result;
const end = id => call('end_employee_dispatch_session_secure', id ? `, '${id}'::uuid` : ', NULL');
const assignment = async (status, sessionId) => {
  const id = randomUUID();
  await db.query(`INSERT INTO public.dispatch_assignments
    (id, user_id, status, dispatch_session_id, assigned_at, accepted_at, accept_deadline_at, assignment_id)
    VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '10 minutes', $5)`,
  [id, EMPLOYEE, status, sessionId, randomUUID()]);
  return id;
};
const state = async () => (await db.query(`SELECT
  (SELECT count(*)::int FROM public.dispatch_sessions WHERE user_id = $1) AS dispatch_count,
  (SELECT count(*)::int FROM public.work_sessions WHERE user_id = $1) AS work_count,
  (SELECT count(*)::int FROM public.dispatch_sessions WHERE user_id = $1 AND status = 'online' AND ended_at IS NULL) AS online_count,
  (SELECT count(*)::int FROM public.work_sessions WHERE user_id = $1 AND end_time IS NULL) AS open_work_count`, [EMPLOYEE])).rows[0];
const businessSnapshot = async () => (await db.query(`SELECT jsonb_build_object(
  'dispatch', (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.id) FROM public.dispatch_sessions d),
  'work', (SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM public.work_sessions w),
  'assignments', (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM public.dispatch_assignments a),
  'orders', (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM public.orders o),
  'operations', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.operation_id) FROM private.employee_dispatch_recovery_operations r)
) AS snapshot`)).rows[0].snapshot;
const prepareAssignmentRecovery = async status => {
  await resetGuarded();
  const session = await start();
  const id = await assignment(status, session.session_id);
  const op = randomUUID();
  const result = await guarded(session.session_id, op);
  assert.equal(result.recovered, true);
  assert.equal(result.assignment.id, id);
  return { session, id, op, result };
};
const expectSafeReplay = async (session, op) => {
  const before = await businessSnapshot();
  assert.deepEqual(await guarded(session.session_id, op), { success: true, recovered: false, assignment: null });
  assert.deepEqual(await businessSnapshot(), before);
};
const resetGuarded = async () => {
  await db.exec(`TRUNCATE private.employee_dispatch_recovery_operations, private.employee_work_stop_markers,
    public.dispatch_assignments, public.dispatch_sessions, public.work_sessions, public.orders,
    public.employee_financial_sessions, public.users;
    INSERT INTO public.users VALUES ('${EMPLOYEE}', '${MARKER}', '${TAB}', true),
      ('${OTHER}', '${OTHER_MARKER}', '${TAB}', true);
    INSERT INTO public.employee_financial_sessions VALUES
      ('${EMPLOYEE}', private.hash_financial_token('${TOKEN}'), NULL, now() + interval '1 day', '${TAB}', '${MARKER}', NULL),
      ('${OTHER}', private.hash_financial_token('${OTHER_TOKEN}'), NULL, now() + interval '1 day', '${TAB}', '${OTHER_MARKER}', NULL);`);
};

test('install the guarded migration alongside the actual latest legacy recovery definition', async () => {
  await db.exec(functionSQL(maintenanceSQL, 'public.recover_employee_dispatch_assignment_secure'));
  await db.exec(guardedSQL);
  await db.exec(replaySubmittedSQL);
  await resetGuarded();
  const session = await start();
  await beaconStop(session.session_id);
  assert.equal((await recover()).recovered, true, 'legacy endpoint remains callable');
});

test('guarded refresh resumes once and repeats the exact result without splitting work again', async () => {
  await resetGuarded();
  const session = await start();
  await beaconStop(session.session_id);
  const op = randomUUID();
  const result = await guarded(session.session_id, op);
  assert.equal(result.recovered, true);
  assert.notEqual(result.session_id, session.session_id);
  const counts = await state();
  assert.deepEqual(counts, { dispatch_count: 2, work_count: 2, online_count: 1, open_work_count: 1 });
  assert.deepEqual(await guarded(session.session_id, op), result);
  assert.deepEqual(await state(), counts);
  const row = (await db.query('SELECT token_hash, result FROM private.employee_dispatch_recovery_operations WHERE operation_id=$1', [op])).rows[0];
  assert.equal(row.token_hash, (await db.query('SELECT private.hash_financial_token($1) AS hash', [TOKEN])).rows[0].hash);
  assert.notEqual(row.token_hash, TOKEN);
  assert.deepEqual(row.result, result);
});

test('a null expected id selects the latest session when no explicit stop exists', async () => {
  await resetGuarded();
  const session = await start();
  await beaconStop(session.session_id);
  const op = randomUUID();
  const result = await guarded(null, op);
  assert.equal(result.recovered, true);
  assert.notEqual(result.session_id, session.session_id);
  const counts = await state();
  assert.deepEqual(await guarded(null, op), result);
  assert.deepEqual(await state(), counts);
});

test('stop after recovery makes its replay inactive and a fresh old request cannot revive it', async () => {
  await resetGuarded();
  const session = await start();
  const op = randomUUID();
  const result = await guarded(session.session_id, op);
  assert.equal(result.recovered, true);
  await end(result.session_id);
  const counts = await state();
  assert.equal((await guarded(session.session_id, op)).recovered, false);
  assert.equal((await guarded(session.session_id, randomUUID())).recovered, false);
  assert.deepEqual(await state(), counts);
});

test('explicit stop before first request blocks both explicit and null recovery', async () => {
  await resetGuarded();
  const session = await start();
  await end(session.session_id);
  const counts = await state();
  assert.equal((await guarded(session.session_id, randomUUID())).recovered, false);
  assert.equal((await guarded(null, randomUUID())).recovered, false);
  assert.deepEqual(await state(), counts);
});

for (const status of ['pending', 'accepted']) {
  test(`${status} assignment cannot revive a stopped session, including a null expected id`, async () => {
    await resetGuarded();
    const session = await start();
    await assignment(status, session.session_id);
    await end(session.session_id);
    const counts = await state();
    assert.equal((await guarded(session.session_id, randomUUID())).recovered, false);
    assert.equal((await guarded(null, randomUUID())).recovered, false);
    assert.deepEqual(await state(), counts);
    assert.equal((await db.query('SELECT status FROM public.dispatch_assignments')).rows[0].status, status);
  });

  test(`${status} assignment resumes and binds the new session only once`, async () => {
    await resetGuarded();
    const session = await start();
    const id = await assignment(status, session.session_id);
    await beaconStop(session.session_id);
    const op = randomUUID();
    const result = await guarded(session.session_id, op);
    assert.equal(result.recovered, true);
    assert.equal(result.assignment.id, id);
    assert.equal(result.assignment.dispatch_session_id, result.session_id);
    const counts = await state();
    assert.deepEqual(await guarded(session.session_id, op), result);
    assert.deepEqual(await state(), counts);
  });
}

for (const status of ['pending', 'accepted']) {
  test(`idle snapshot fails closed if a new ${status} task appears`, async () => {
    await resetGuarded();
    const session = await start();
    const op = randomUUID();
    const result = await guarded(session.session_id, op);
    assert.equal(result.assignment, null);
    await assignment(status, result.session_id);
    await expectSafeReplay(session, op);
  });
}

test('a real accept RPC invalidates the previously pending snapshot without touching work', async () => {
  const { session, id, op, result } = await prepareAssignmentRecovery('pending');
  const accepted = (await db.query(`SELECT public.accept_dispatch_assignment_secure($1,$2,$3,$4,$5,$6) AS result`,
    [EMPLOYEE, TOKEN, TAB, result.session_id, id, 'accepted-code'])).rows[0].result;
  assert.equal(accepted.success, true);
  await expectSafeReplay(session, op);
});

test('real finish RPC makes an accepted assignment snapshot unusable', async () => {
  const { session, id, op } = await prepareAssignmentRecovery('accepted');
  const finished = (await db.query(`SELECT public.finish_dispatch_assignment_secure($1,$2,$3,$4,'completed',NULL) AS result`,
    [EMPLOYEE, TOKEN, TAB, id])).rows[0].result;
  assert.equal(finished.success, true);
  await expectSafeReplay(session, op);
});

test('a real order submission invalidates an accepted unsubmitted snapshot', async () => {
  const { session, id, op, result } = await prepareAssignmentRecovery('accepted');
  const order = randomUUID();
  await db.query(`INSERT INTO public.orders(id,user_id,assignment_id,status) VALUES ($1,$2,$3,'pending')`,
    [order, EMPLOYEE, result.assignment.assignment_id]);
  assert.equal((await db.query(`SELECT public.mark_dispatch_assignment_submitted_secure($1,$2,$3,$4,$5,$6) AS marked`,
    [EMPLOYEE, TOKEN, TAB, id, result.assignment.assignment_id, order])).rows[0].marked, true);
  await expectSafeReplay(session, op);
});

for (const [label, sql, value] of [
  ['session', 'dispatch_session_id=$2', randomUUID()],
  ['assignment code', 'assignment_id=$2', 'changed-code'],
  ['submitted flag', 'order_submitted=$2', true],
  ['accepted timestamp', "accepted_at=accepted_at + interval '1 second'", null],
  ['accept deadline', "accept_deadline_at=accept_deadline_at + interval '1 second'", null],
  ['assigned timestamp', "assigned_at=assigned_at + interval '1 second'", null],
  ['completed timestamp', 'completed_at=clock_timestamp()', null],
  ['remarks', 'remarks=$2', 'changed remarks'],
  ['order content', 'order_content_snapshot=$2', 'changed content'],
  ['timeout configuration', 'session_timeout_minutes_snapshot=$2', 23],
  ['dispatch order', 'dispatch_order_id=$2', randomUUID()],
]) {
  test(`changed ${label} is not returned from an accepted snapshot`, async () => {
    const { session, id, op } = await prepareAssignmentRecovery('accepted');
    await db.query(`UPDATE public.dispatch_assignments SET ${sql} WHERE id=$1`, value === null ? [id] : [id, value]);
    await expectSafeReplay(session, op);
  });
}

test('deleted assignment or a second active task invalidates the snapshot', async () => {
  let { session, id, op, result } = await prepareAssignmentRecovery('accepted');
  await db.query('DELETE FROM public.dispatch_assignments WHERE id=$1', [id]);
  await expectSafeReplay(session, op);

  ({ session, op, result } = await prepareAssignmentRecovery('accepted'));
  await assignment('pending', result.session_id);
  await expectSafeReplay(session, op);
});

test('pending deadline expiration invalidates an otherwise unchanged cached snapshot', async () => {
  await resetGuarded();
  const session = await start();
  const id = await assignment('pending', session.session_id);
  await db.query(`UPDATE public.dispatch_assignments SET accept_deadline_at=clock_timestamp()+interval '1 second' WHERE id=$1`, [id]);
  const op = randomUUID();
  const result = await guarded(session.session_id, op);
  assert.equal(result.recovered, true);
  assert.deepEqual(await guarded(session.session_id, op), result);
  await db.exec('SELECT pg_sleep(1.2)');
  await expectSafeReplay(session, op);
});

test('accepted and submitted-without-order snapshots expire without reopening the session', async () => {
  for (const submitted of [false, true]) {
    await resetGuarded();
    const session = await start();
    const id = await assignment('accepted', session.session_id);
    await db.query(`UPDATE public.dispatch_assignments
      SET accepted_at=clock_timestamp() - CASE WHEN $2 THEN interval '29 minutes 59 seconds' ELSE interval '59 seconds' END,
          order_submitted=$2, session_timeout_minutes_snapshot=1 WHERE id=$1`, [id, submitted]);
    const op = randomUUID();
    const result = await guarded(session.session_id, op);
    assert.equal(result.recovered, true);
    assert.deepEqual(await guarded(session.session_id, op), result);
    await db.exec('SELECT pg_sleep(1.2)');
    await expectSafeReplay(session, op);
  }
});

for (const [status, created] of [['pending', 'now()'], ['pending', "now() - interval '31 minutes'"],
  ['success', 'now()'], ['failure', 'now()'], ['error', 'now()']]) {
  test(`associated ${status} order (${created}) prevents stale replay without updates`, async () => {
    const { session, op, result } = await prepareAssignmentRecovery('accepted');
    await db.query(`INSERT INTO public.orders(user_id,assignment_id,status,created_at)
      VALUES ($1,$2,$3,${created})`, [EMPLOYEE, result.assignment.assignment_id, status]);
    await expectSafeReplay(session, op);
  });
}

test('a processing submitted order can replay its recovery result without splitting work', async () => {
  await resetGuarded();
  const session = await start();
  const id = await assignment('accepted', session.session_id);
  const code = (await db.query('SELECT assignment_id FROM public.dispatch_assignments WHERE id=$1', [id])).rows[0].assignment_id;
  await db.query('UPDATE public.dispatch_assignments SET order_submitted=true WHERE id=$1', [id]);
  const orderId = randomUUID();
  await db.query(`INSERT INTO public.orders(id,user_id,assignment_id,status,created_at)
    VALUES ($1,$2,$3,'processing',clock_timestamp())`, [orderId, EMPLOYEE, code]);
  await beaconStop(session.session_id);
  const op = randomUUID();
  const first = await guarded(session.session_id, op);
  assert.equal(first.recovered, true);
  assert.equal(first.assignment.id, id);
  const counts = await state();
  const cached = (await db.query('SELECT replay_order_snapshot FROM private.employee_dispatch_recovery_operations WHERE operation_id=$1', [op])).rows[0].replay_order_snapshot;
  assert.equal(cached.id, orderId);
  assert.equal(cached.user_id, EMPLOYEE);
  assert.equal(cached.assignment_id, code);
  assert.equal(cached.status, 'processing');
  assert.equal(new Date(cached.created_at).getTime(),
    (await db.query('SELECT created_at FROM public.orders WHERE id=$1', [orderId])).rows[0].created_at.getTime());
  assert.equal(cached.processed_at, null);
  assert.deepEqual(await guarded(session.session_id, op), first);
  assert.deepEqual(await state(), counts);
  await db.query('UPDATE private.employee_dispatch_recovery_operations SET replay_order_snapshot=NULL WHERE operation_id=$1', [op]);
  assert.deepEqual(await guarded(session.session_id, op), first);
  assert.equal((await db.query('SELECT replay_order_snapshot FROM private.employee_dispatch_recovery_operations WHERE operation_id=$1', [op])).rows[0].replay_order_snapshot.status, 'processing');
  assert.deepEqual(await state(), counts);
});

for (const [orderStatus, assignmentStatus] of [['success', 'completed'], ['failure', 'error'], ['error', 'error']]) {
  test(`${orderStatus} order completion is finalized by the real recovery function on replay`, async () => {
    await resetGuarded();
    const session = await start();
    const id = await assignment('accepted', session.session_id);
    const code = (await db.query('SELECT assignment_id FROM public.dispatch_assignments WHERE id=$1', [id])).rows[0].assignment_id;
    await db.query('UPDATE public.dispatch_assignments SET order_submitted=true WHERE id=$1', [id]);
    const orderId = randomUUID();
    await db.query(`INSERT INTO public.orders(id,user_id,assignment_id,status,created_at)
      VALUES ($1,$2,$3,'processing',clock_timestamp())`, [orderId, EMPLOYEE, code]);
    await beaconStop(session.session_id);
    const op = randomUUID();
    assert.equal((await guarded(session.session_id, op)).recovered, true);
    if (orderStatus !== 'failure') {
      await db.query('UPDATE private.employee_dispatch_recovery_operations SET replay_order_snapshot=NULL WHERE operation_id=$1', [op]);
    }
    await db.query(`UPDATE public.orders SET status=$2, processed_at=clock_timestamp() WHERE id=$1`, [orderId, orderStatus]);
    const result = await guarded(session.session_id, op);
    assert.equal(result.recovered, false);
    assert.equal((await db.query('SELECT status FROM public.dispatch_assignments WHERE id=$1', [id])).rows[0].status, assignmentStatus);
    assert.equal((await state()).online_count, 0);
    const snapshot = await businessSnapshot();
    assert.deepEqual(await guarded(session.session_id, op), result);
    assert.deepEqual(await businessSnapshot(), snapshot);
  });
}

test('an unrelated order does not invalidate an unchanged accepted snapshot', async () => {
  const { session, op, result } = await prepareAssignmentRecovery('accepted');
  await db.query(`INSERT INTO public.orders(user_id,assignment_id,status) VALUES ($1,$2,'success')`, [OTHER, 'unrelated']);
  const before = await businessSnapshot();
  assert.deepEqual(await guarded(session.session_id, op), result);
  assert.deepEqual(await businessSnapshot(), before);
});

test('after stop and a new start old requests cannot stop or replace the new session', async () => {
  await resetGuarded();
  const old = await start();
  await assignment('accepted', old.session_id);
  const oldOp = randomUUID();
  await end(old.session_id);
  assert.equal((await guarded(old.session_id, oldOp)).recovered, false);
  const current = await start();
  const counts = await state();
  assert.equal((await guarded(old.session_id, oldOp)).recovered, false);
  assert.equal((await guarded(old.session_id, randomUUID())).recovered, false);
  assert.equal((await guarded(null, randomUUID())).recovered, false);
  assert.deepEqual(await state(), counts);
  const row = (await db.query('SELECT status, ended_at FROM public.dispatch_sessions WHERE id=$1', [current.session_id])).rows[0];
  assert.equal(row.status, 'online');
  assert.equal(row.ended_at, null);
});

test('a fresh new session after stop may be recovered, while a replaced result is never active', async () => {
  await resetGuarded();
  const first = await start();
  await end(first.session_id);
  const current = await start();
  await beaconStop(current.session_id);
  const op = randomUUID();
  const result = await guarded(current.session_id, op);
  assert.equal(result.recovered, true);
  assert.deepEqual(await guarded(current.session_id, op), result);
  const newer = await start();
  const counts = await state();
  assert.equal((await guarded(current.session_id, op)).recovered, false);
  assert.equal((await guarded(current.session_id, randomUUID())).recovered, false);
  assert.deepEqual(await state(), counts);
  assert.equal((await db.query('SELECT status FROM public.dispatch_sessions WHERE id=$1', [newer.session_id])).rows[0].status, 'online');
});

test('unbound legacy assignments use assignment time and latest session without bypassing the stop marker', async () => {
  await resetGuarded();
  await assignment('pending', null);
  const op = randomUUID();
  const result = await guarded(null, op);
  assert.equal(result.recovered, true, 'legacy unbound assignment without any stop may start');
  assert.deepEqual(await guarded(null, op), result);
  await end(result.session_id);
  const counts = await state();
  assert.equal((await guarded(null, randomUUID())).recovered, false);
  assert.deepEqual(await state(), counts);

  await resetGuarded();
  const previous = await start();
  await assignment('accepted', null);
  await end(previous.session_id);
  const newer = await start();
  const before = await state();
  assert.equal((await guarded(null, randomUUID())).recovered, false);
  assert.equal((await guarded(previous.session_id, randomUUID())).recovered, false);
  assert.equal((await guarded(newer.session_id, randomUUID())).recovered, false);
  assert.deepEqual(await state(), before);
});

test('foreign users, invalid credentials, mismatched operation ids and new login reuse are rejected', async () => {
  await resetGuarded();
  const old = await start();
  const other = (await db.query('SELECT public.start_employee_dispatch_session_secure($1,$2,$3) AS result', [OTHER, OTHER_TOKEN, TAB])).rows[0].result;
  const op = randomUUID();
  await guarded(old.session_id, op);
  const counts = await state();
  await assert.rejects(guarded(old.session_id, op, EMPLOYEE, OTHER_TOKEN), /invalid or expired/);
  await assert.rejects(guarded(old.session_id, op, EMPLOYEE, TOKEN, 'wrong-tab'), /invalid or expired/);
  await assert.rejects(guarded(other.session_id, randomUUID()), /Previous employee work session is invalid/);
  await assert.rejects(guarded(other.session_id, op, OTHER, OTHER_TOKEN), /does not match/);
  await assert.rejects(guarded(null, op), /does not match/);
  await assert.rejects(guarded(old.session_id, null), /Invalid recovery operation/);
  await db.query(`UPDATE public.employee_financial_sessions SET revoked_at = now() WHERE user_id=$1`, [EMPLOYEE]);
  await db.query('UPDATE public.users SET current_session_token=$2 WHERE id=$1', [EMPLOYEE, NEW_MARKER]);
  await db.query(`INSERT INTO public.employee_financial_sessions VALUES ($1, private.hash_financial_token($2), NULL, now() + interval '1 day', $3, $4, NULL)`, [EMPLOYEE, NEW_TOKEN, TAB, NEW_MARKER]);
  await assert.rejects(guarded(old.session_id, op, EMPLOYEE, NEW_TOKEN), /does not match/);
  await assert.rejects(guarded(old.session_id, op), /invalid or expired/);
  assert.deepEqual(await state(), counts);
});

test('an old no-assignment request cannot close or replace an independently started session', async () => {
  await resetGuarded();
  const previous = await start();
  await end(previous.session_id);
  const current = await start();
  const counts = await state();
  assert.equal((await guarded(previous.session_id, randomUUID())).recovered, false);
  assert.equal((await guarded(null, randomUUID())).recovered, false);
  assert.deepEqual(await state(), counts);
  assert.equal((await db.query('SELECT status FROM public.dispatch_sessions WHERE id=$1', [current.session_id])).rows[0].status, 'online');
});

test('beacon-stopped or replaced cached sessions are not reported active', async () => {
  await resetGuarded();
  const previous = await start();
  const op = randomUUID();
  const recovered = await guarded(previous.session_id, op);
  await beaconStop(recovered.session_id);
  const counts = await state();
  assert.equal((await guarded(previous.session_id, op)).recovered, false);
  assert.deepEqual(await state(), counts);
});

test('equal stop time, missing start time and ambiguous assignment ordering fail closed', async () => {
  await resetGuarded();
  const session = await start();
  await assignment('pending', session.session_id);
  await db.query(`INSERT INTO private.employee_work_stop_markers(user_id, stopped_at)
    SELECT user_id, started_at FROM public.dispatch_sessions WHERE id=$1`, [session.session_id]);
  const counts = await state();
  assert.equal((await guarded(session.session_id, randomUUID())).recovered, false);
  assert.deepEqual(await state(), counts);

  await resetGuarded();
  const nullTime = await start();
  await db.query('UPDATE public.dispatch_sessions SET started_at=NULL WHERE id=$1', [nullTime.session_id]);
  const nullCounts = await state();
  assert.equal((await guarded(nullTime.session_id, randomUUID())).recovered, false);
  assert.equal((await guarded(null, randomUUID())).recovered, false);
  assert.deepEqual(await state(), nullCounts);

  await resetGuarded();
  const tied = await start();
  await assignment('pending', tied.session_id);
  await assignment('accepted', tied.session_id);
  await db.exec(`UPDATE public.dispatch_assignments SET assigned_at = '2026-01-01 00:00:00+00'`);
  const tiedCounts = await state();
  assert.equal((await guarded(tied.session_id, randomUUID())).recovered, false);
  assert.deepEqual(await state(), tiedCounts);
});

test('expired legacy null-session assignment is cancelled once and returns the cached false result', async () => {
  await resetGuarded();
  const session = await start();
  const id = await assignment('pending', null);
  await db.query(`UPDATE public.dispatch_assignments SET accept_deadline_at = clock_timestamp() - interval '1 minute' WHERE id=$1`, [id]);
  const op = randomUUID();
  const result = await guarded(session.session_id, op);
  assert.equal(result.recovered, false);
  assert.equal((await db.query('SELECT status FROM public.dispatch_assignments WHERE id=$1', [id])).rows[0].status, 'cancelled');
  const counts = await state();
  assert.equal(counts.online_count, 0);
  assert.deepEqual(await guarded(session.session_id, op), result);
  assert.deepEqual(await state(), counts);
});

test('a failure writing the operation rolls back the legacy recovery and can be retried', async () => {
  await resetGuarded();
  const session = await start();
  const id = await assignment('accepted', session.session_id);
  await beaconStop(session.session_id);
  const before = await state();
  await db.exec(`CREATE FUNCTION private.fail_recovery_test() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected recovery failure'; END $$;
    CREATE TRIGGER fail_recovery_test BEFORE INSERT ON private.employee_dispatch_recovery_operations
    FOR EACH ROW EXECUTE FUNCTION private.fail_recovery_test();`);
  const op = randomUUID();
  try {
    await assert.rejects(guarded(session.session_id, op), /injected recovery failure/);
    assert.deepEqual(await state(), before);
    const unchanged = (await db.query('SELECT status, dispatch_session_id FROM public.dispatch_assignments WHERE id=$1', [id])).rows[0];
    assert.deepEqual(unchanged, { status: 'accepted', dispatch_session_id: session.session_id });
    assert.equal(Number((await db.query('SELECT count(*) FROM private.employee_dispatch_recovery_operations')).rows[0].count), 0);
  } finally {
    await db.exec('DROP TRIGGER fail_recovery_test ON private.employee_dispatch_recovery_operations; DROP FUNCTION private.fail_recovery_test();');
  }
  assert.equal((await guarded(session.session_id, op)).recovered, true);
});

for (const invalidation of ['expired', 'revoked']) {
  test(`operation id remains bound after its ${invalidation} token and record are older than 24 hours`, async () => {
    await resetGuarded();
    const session = await start();
    const oldOp = randomUUID();
    assert.equal((await guarded(session.session_id, oldOp)).recovered, true);
    await db.query(`UPDATE private.employee_dispatch_recovery_operations
      SET created_at=clock_timestamp() - interval '25 hours' WHERE operation_id=$1`, [oldOp]);
    await db.query(`UPDATE public.employee_financial_sessions
      SET ${invalidation === 'expired' ? "expires_at=clock_timestamp() - interval '25 hours'" : "revoked_at=clock_timestamp() - interval '25 hours'"}
      WHERE user_id=$1`, [EMPLOYEE]);
    await db.query('UPDATE public.users SET current_session_token=$2 WHERE id=$1', [EMPLOYEE, NEW_MARKER]);
    await db.query(`INSERT INTO public.employee_financial_sessions VALUES
      ($1, private.hash_financial_token($2), NULL, now()+interval '1 day', $3, $4, NULL)`,
    [EMPLOYEE, NEW_TOKEN, TAB, NEW_MARKER]);
    await guarded(null, randomUUID(), EMPLOYEE, NEW_TOKEN);
    await assert.rejects(guarded(session.session_id, oldOp, EMPLOYEE, NEW_TOKEN), /does not match/);
    await assert.rejects(guarded(session.session_id, oldOp, OTHER, OTHER_TOKEN), /does not match/);
    await assert.rejects(guarded(session.session_id, oldOp), /invalid or expired/);
    assert.equal(Number((await db.query('SELECT count(*) FROM private.employee_dispatch_recovery_operations WHERE operation_id=$1', [oldOp])).rows[0].count), 1);
  });
}

test('operations older than 48 hours remain replayable while their original token is valid', async () => {
  await resetGuarded();
  const session = await start();
  const op = randomUUID();
  const result = await guarded(session.session_id, op);
  await db.query(`UPDATE private.employee_dispatch_recovery_operations
    SET created_at=clock_timestamp() - interval '49 hours' WHERE operation_id=$1`, [op]);
  const before = await businessSnapshot();
  assert.deepEqual(await guarded(session.session_id, op), result);
  assert.deepEqual(await businessSnapshot(), before);
});

for (const invalidation of ['expired', 'revoked']) {
  test(`cleanup only removes this employee's operations older than 48 hours with an ${invalidation} token`, async () => {
    await resetGuarded();
    const session = await start();
    const oldOp = randomUUID();
    const recentOp = randomUUID();
    const otherOp = randomUUID();
    await guarded(session.session_id, oldOp);
    await db.query(`UPDATE private.employee_dispatch_recovery_operations
      SET created_at=clock_timestamp() - interval '49 hours' WHERE operation_id=$1`, [oldOp]);
    await db.query(`INSERT INTO private.employee_dispatch_recovery_operations
      (operation_id, user_id, token_hash, tab_id, expected_session_id, result, created_at, replay_order_snapshot)
      SELECT $1, user_id, token_hash, tab_id, expected_session_id, result,
        clock_timestamp() - interval '47 hours 59 minutes', replay_order_snapshot
      FROM private.employee_dispatch_recovery_operations WHERE operation_id=$2`, [recentOp, oldOp]);
    await db.query(`INSERT INTO private.employee_dispatch_recovery_operations
      (operation_id, user_id, token_hash, tab_id, expected_session_id, result, created_at, replay_order_snapshot)
      SELECT $1, $2, 'expired-other-token', tab_id, NULL, result,
        clock_timestamp() - interval '49 hours', replay_order_snapshot
      FROM private.employee_dispatch_recovery_operations WHERE operation_id=$3`, [otherOp, OTHER, oldOp]);
    await db.query(`UPDATE public.employee_financial_sessions
      SET ${invalidation === 'expired' ? "expires_at=clock_timestamp() - interval '1 minute'" : 'revoked_at=clock_timestamp()'}
      WHERE user_id=$1`, [EMPLOYEE]);
    const before = await businessSnapshot();
    await assert.rejects(guarded(session.session_id, oldOp), /invalid or expired/);
    assert.deepEqual(await businessSnapshot(), before);
    await db.query('UPDATE public.users SET current_session_token=$2 WHERE id=$1', [EMPLOYEE, NEW_MARKER]);
    await db.query(`INSERT INTO public.employee_financial_sessions VALUES
      ($1, private.hash_financial_token($2), NULL, now()+interval '1 day', $3, $4, NULL)`,
    [EMPLOYEE, NEW_TOKEN, TAB, NEW_MARKER]);
    const currentOp = randomUUID();
    await guarded(null, currentOp, EMPLOYEE, NEW_TOKEN);
    const remaining = (await db.query('SELECT operation_id FROM private.employee_dispatch_recovery_operations')).rows.map(row => row.operation_id);
    assert.deepEqual(remaining.sort(), [recentOp, otherOp, currentOp].sort());
    await assert.rejects(guarded(session.session_id, oldOp), /invalid or expired/);
  });
}

test('operation cache is private, RLS protected, retained over 24 hours and RPC privileges are limited', async () => {
  await resetGuarded();
  const session = await start();
  const op = randomUUID();
  const result = await guarded(session.session_id, op);
  await db.query(`UPDATE private.employee_dispatch_recovery_operations SET created_at = clock_timestamp() - interval '25 hours' WHERE operation_id=$1`, [op]);
  const counts = await state();
  assert.deepEqual(await guarded(session.session_id, op), result);
  assert.deepEqual(await state(), counts);
  for (const role of ['anon', 'authenticated']) {
    const checks = (await db.query(`SELECT
      has_function_privilege($1, 'public.recover_employee_dispatch_guarded(uuid,uuid,text,uuid,uuid)', 'EXECUTE') AS can_call,
      has_table_privilege($1, 'private.employee_dispatch_recovery_operations', 'SELECT,INSERT,UPDATE,DELETE') AS can_touch`, [role])).rows[0];
    assert.equal(checks.can_call, true);
    assert.equal(checks.can_touch, false);
  }
  const security = (await db.query(`SELECT c.relrowsecurity,
    NOT EXISTS (SELECT 1 FROM pg_proc p, LATERAL aclexplode(p.proacl) a
      WHERE p.oid = 'public.recover_employee_dispatch_guarded(uuid,uuid,text,uuid,uuid)'::regprocedure
        AND a.grantee=0 AND a.privilege_type='EXECUTE') AS no_public_execute
    FROM pg_class c WHERE c.oid='private.employee_dispatch_recovery_operations'::regclass`)).rows[0];
  assert.deepEqual(security, { relrowsecurity: true, no_public_execute: true });
});
