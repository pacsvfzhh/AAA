import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// Every connection is explicitly restricted to this test's private Unix socket.
// No PostgreSQL connection environment variables or project credentials are inherited.
const pgBin = ['/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin']
  .find(path => ['initdb', 'pg_ctl', 'psql'].every(binary => existsSync(join(path, binary))));
assert.ok(pgBin, 'Native PostgreSQL initdb, pg_ctl and psql are required; this test never connects to a network database');
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8' };
const asOwner = (file, args) => process.getuid?.() === 0
  ? execFileSync('runuser', ['-u', 'postgres', '--', file, ...args], { encoding: 'utf8', timeout: 30000, env })
  : execFileSync(file, args, { encoding: 'utf8', timeout: 30000, env });
const sqlFile = name => readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
const lifecycle = sqlFile('20260918210000_harden_admin_employee_management.sql');
const resume = sqlFile('20260918215530_server_authoritative_dispatch_lifecycle.sql');
const stopFix = sqlFile('20261101000003_keep_user_stopped_work_sessions_stopped.sql');
const maintenance = sqlFile('20261103000001_team_employee_maintenance.sql');
const guarded = sqlFile('20261103000005_guard_dispatch_recovery.sql');
const replaySubmitted = sqlFile('20261103000006_replay_submitted_order_recovery.sql');
const financial = sqlFile('20260914220000_add_atomic_wallet_financial_system.sql');

function functionSQL(source, name, delimiter = '$function$;') {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.notEqual(start, -1, `Missing real migration function ${name}`);
  const end = source.indexOf(delimiter, start);
  assert.notEqual(end, -1, `Missing function terminator for ${name}`);
  return source.slice(start, end + delimiter.length);
}

const EMPLOYEE = '00000000-0000-4000-8000-000000000001';
const TOKEN = '10000000-0000-4000-8000-000000000001';
const MARKER = '20000000-0000-4000-8000-000000000001';
const TAB = 'test-tab';
const PORT = '55443';
const sessions = [];
let directory;
let startAttempted = false;
let started = false;
let observer;
let first;
let second;

class Session {
  constructor(name) {
    this.name = name;
    this.pending = null;
    this.stderr = '';
    this.process = spawn(join(pgBin, 'psql'), ['-X', '-qAt', '-U', 'postgres', '-h', directory, '-p', PORT, '-d', 'postgres'], {
      env: { ...env, PGAPPNAME: name },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    sessions.push(this);
    this.process.stdout.on('data', chunk => {
      if (!this.pending) return;
      this.pending.output += chunk.toString();
      const end = this.pending.output.indexOf(`${this.pending.marker}\n`);
      if (end < 0) return;
      const pending = this.pending;
      this.pending = null;
      clearTimeout(pending.timer);
      pending.resolve(pending.output.slice(0, end).trim());
    });
    this.process.stderr.on('data', chunk => { this.stderr += chunk.toString(); });
    this.process.stdin.on('error', error => this.fail(error));
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => this.fail(new Error(`${name} psql exited (${code ?? signal}): ${this.stderr}`)));
  }
  fail(error) {
    if (!this.pending) return;
    const pending = this.pending;
    this.pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  query(sql) {
    assert.equal(this.pending, null, `Concurrent commands on ${this.name}`);
    assert.equal(this.process.exitCode, null, `${this.name} psql already exited: ${this.stderr}`);
    return new Promise((resolve, reject) => {
      const marker = `end_${randomUUID()}`;
      const timer = setTimeout(() => this.fail(new Error(`Timed out on ${this.name}: ${this.stderr}`)), 12000);
      this.pending = { resolve, reject, marker, timer, output: '' };
      this.process.stdin.write(`${sql}\n\\echo ${marker}\n`);
    });
  }
  async json(sql) { return JSON.parse(await this.query(sql)); }
}

const fixtures = `
CREATE ROLE anon; CREATE ROLE authenticated;
CREATE SCHEMA private; CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
${functionSQL(financial, 'private.hash_financial_token', '$$;')}
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
${functionSQL(lifecycle, 'public.start_employee_dispatch_session_secure')}
${functionSQL(lifecycle, 'public.stop_employee_dispatch_session_secure')}
${functionSQL(resume, 'public.resume_employee_dispatch_session_secure')}
${stopFix}
${functionSQL(maintenance, 'public.recover_employee_dispatch_assignment_secure')}
${guarded}
${replaySubmitted}
`;

const credentials = `'${EMPLOYEE}', '${TOKEN}', '${TAB}'`;
const start = session => session.json(`SELECT public.start_employee_dispatch_session_secure(${credentials});`);
const stop = (session, id) => session.json(`SELECT public.stop_employee_dispatch_session_secure(${credentials}, ${id ? `'${id}'` : 'NULL'});`);
const end = (session, id) => session.json(`SELECT public.end_employee_dispatch_session_secure(${credentials}, ${id ? `'${id}'` : 'NULL'});`);
const recover = (session, expected, operation) => session.json(`SELECT public.recover_employee_dispatch_guarded(${credentials}, '${expected}', '${operation}');`);
const state = () => observer.json(`SELECT jsonb_build_object(
  'dispatch', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id), '[]'::jsonb) FROM public.dispatch_sessions d),
  'work', (SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.id), '[]'::jsonb) FROM public.work_sessions w),
  'assignments', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb) FROM public.dispatch_assignments a),
  'operations', (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.operation_id), '[]'::jsonb) FROM private.employee_dispatch_recovery_operations o));`);
const online = snapshot => snapshot.dispatch.filter(row => row.status === 'online' && row.ended_at === null);
const openWork = snapshot => snapshot.work.filter(row => row.end_time === null);
const settled = promise => promise.then(value => ({ value }), error => ({ error }));

async function waitForBlocked(blocked, blocker) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const waiting = await observer.json(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity b JOIN pg_stat_activity a ON a.application_name = '${blocker.name}'
      WHERE b.application_name = '${blocked.name}' AND b.wait_event_type = 'Lock'
        AND a.pid = ANY(pg_blocking_pids(b.pid)))::text;`);
    if (waiting) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(`${blocked.name} did not wait on a lock held by ${blocker.name}`);
}

async function reset() {
  await first.query('ROLLBACK;');
  await second.query('ROLLBACK;');
  await observer.query(`TRUNCATE private.employee_dispatch_recovery_operations, private.employee_work_stop_markers,
    public.dispatch_assignments, public.dispatch_sessions, public.work_sessions, public.orders,
    public.employee_financial_sessions, public.users;
    INSERT INTO public.users VALUES ('${EMPLOYEE}', '${MARKER}', '${TAB}', true);
    INSERT INTO public.employee_financial_sessions VALUES
      ('${EMPLOYEE}', private.hash_financial_token('${TOKEN}'), NULL, now() + interval '1 day', '${TAB}', '${MARKER}', NULL);`);
}
async function addAssignment(status, sessionId) {
  const id = randomUUID();
  await observer.query(`INSERT INTO public.dispatch_assignments
    (id, user_id, status, dispatch_session_id, assigned_at, accepted_at, accept_deadline_at, assignment_id)
    VALUES ('${id}', '${EMPLOYEE}', '${status}', '${sessionId}', clock_timestamp(), clock_timestamp(),
      clock_timestamp() + interval '10 minutes', '${randomUUID()}');`);
  return id;
}

before(async () => {
  directory = asOwner('mktemp', ['-d', join(tmpdir(), 'dispatch-recovery-lock-test-XXXXXX')]).trim();
  asOwner(join(pgBin, 'initdb'), ['-D', join(directory, 'data'), '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '--encoding=UTF8']);
  startAttempted = true;
  asOwner(join(pgBin, 'pg_ctl'), ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'), '-o', `-k ${directory} -p ${PORT} -c listen_addresses='' -c fsync=off`, '-w', 'start']);
  started = true;
  observer = new Session('dispatch-recovery-observer');
  first = new Session('dispatch-recovery-first');
  second = new Session('dispatch-recovery-second');
  for (const session of sessions) await session.query("\\set ON_ERROR_STOP on\nSET statement_timeout='10s';");
  await observer.query(fixtures);
});

after(() => {
  for (const session of sessions) session.process.stdin.end('ROLLBACK;\n\\q\n');
  if (started || (startAttempted && existsSync(join(directory, 'data', 'postmaster.pid')))) {
    // Do not delete a live server's data directory if stopping it fails.
    asOwner(join(pgBin, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop']);
  }
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('recovery holds the lock until commit; end waits, then prevents the same operation from reopening', async () => {
  await reset();
  const initial = await start(first);
  await stop(first, initial.session_id);
  const operation = randomUUID();
  await first.query('BEGIN;');
  const recovered = await recover(first, initial.session_id, operation);
  assert.equal(recovered.recovered, true);
  assert.notEqual(recovered.session_id, initial.session_id);
  await second.query('BEGIN;');
  const waitingEnd = settled(end(second, null));
  await waitForBlocked(second, first);
  await first.query('COMMIT;');
  const ended = await waitingEnd;
  if (ended.error) throw ended.error;
  assert.equal(ended.value.success, true);
  assert.equal(ended.value.stopped_count, 1);
  await second.query('COMMIT;');
  const before = await state();
  assert.equal(online(before).length, 0);
  assert.equal(openWork(before).length, 0);
  assert.equal((await recover(first, initial.session_id, operation)).recovered, false);
  assert.deepEqual(await state(), before);
});

for (const status of ['pending', 'accepted']) {
  test(`end holds the lock before ${status} recovery; the blocked recovery cannot reopen`, async () => {
    await reset();
    const initial = await start(first);
    const assignment = await addAssignment(status, initial.session_id);
    await first.query('BEGIN;');
    const ended = await end(first, initial.session_id);
    assert.equal(ended.success, true);
    assert.equal(ended.stopped_count, 1);
    await second.query('BEGIN;');
    const waitingRecovery = settled(recover(second, initial.session_id, randomUUID()));
    await waitForBlocked(second, first);
    await first.query('COMMIT;');
    const recovered = await waitingRecovery;
    if (recovered.error) throw recovered.error;
    assert.equal(recovered.value.recovered, false);
    await second.query('COMMIT;');
    const snapshot = await state();
    assert.equal(online(snapshot).length, 0);
    assert.equal(openWork(snapshot).length, 0);
    assert.equal(snapshot.dispatch.length, 1);
    assert.equal(snapshot.work.length, 1);
    assert.equal(snapshot.assignments[0].id, assignment);
    assert.equal(snapshot.assignments[0].status, status);
    assert.equal(snapshot.assignments[0].dispatch_session_id, initial.session_id);
  });
}

for (const status of [null, 'pending', 'accepted']) {
  test(`concurrent recovery with one operation returns the identical result and creates only one session (${status ?? 'idle'})`, async () => {
    await reset();
    const initial = await start(first);
    const assignment = status ? await addAssignment(status, initial.session_id) : null;
    await stop(first, initial.session_id);
    const operation = randomUUID();
    await first.query('BEGIN;');
    const recovered = await recover(first, initial.session_id, operation);
    assert.equal(recovered.recovered, true);
    await second.query('BEGIN;');
    const waitingRecovery = settled(recover(second, initial.session_id, operation));
    await waitForBlocked(second, first);
    await first.query('COMMIT;');
    const replay = await waitingRecovery;
    if (replay.error) throw replay.error;
    assert.deepEqual(replay.value, recovered);
    await second.query('COMMIT;');
    const snapshot = await state();
    assert.equal(snapshot.dispatch.length, 2);
    assert.equal(snapshot.work.length, 2);
    assert.equal(snapshot.operations.length, 1);
    assert.equal(online(snapshot).length, 1);
    assert.equal(online(snapshot)[0].id, recovered.session_id);
    assert.equal(openWork(snapshot).length, 1);
    if (assignment) {
      assert.equal(snapshot.assignments[0].id, assignment);
      assert.equal(snapshot.assignments[0].status, status);
      assert.equal(snapshot.assignments[0].dispatch_session_id, recovered.session_id);
    }
  });
}

for (const status of [null, 'pending', 'accepted']) {
  test(`different concurrent operations for the same expected session cannot replace the first recovery (${status ?? 'idle'})`, async () => {
    await reset();
    const initial = await start(first);
    const assignment = status ? await addAssignment(status, initial.session_id) : null;
    await stop(first, initial.session_id);
    await first.query('BEGIN;');
    const recovered = await recover(first, initial.session_id, randomUUID());
    assert.equal(recovered.recovered, true);
    await second.query('BEGIN;');
    const waitingRecovery = settled(recover(second, initial.session_id, randomUUID()));
    await waitForBlocked(second, first);
    await first.query('COMMIT;');
    const before = await state();
    const later = await waitingRecovery;
    if (later.error) throw later.error;
    assert.equal(later.value.recovered, false);
    await second.query('COMMIT;');
    const after = await state();
    assert.deepEqual(after.dispatch, before.dispatch);
    assert.deepEqual(after.work, before.work);
    assert.deepEqual(after.assignments, before.assignments);
    assert.equal(after.operations.length, 2);
    assert.equal(after.dispatch.length, 2);
    assert.equal(online(after).length, 1);
    assert.equal(online(after)[0].id, recovered.session_id);
    assert.equal(openWork(after).length, 1);
    if (assignment) {
      assert.equal(after.assignments[0].id, assignment);
      assert.equal(after.assignments[0].status, status);
      assert.equal(after.assignments[0].dispatch_session_id, recovered.session_id);
    }
  });
}

for (const status of [null, 'accepted']) {
  test(`server stop followed by a new start protects the new session from old recovery (${status ?? 'idle'})`, async () => {
    await reset();
    const initial = await start(first);
    if (status) await addAssignment(status, initial.session_id);
    const oldOperation = randomUUID();
    const oldResult = await recover(first, initial.session_id, oldOperation);
    assert.equal(oldResult.recovered, true);
    assert.equal((await stop(first, oldResult.session_id)).stopped_count, 1);
    const current = await start(second);
    const before = await state();
    assert.equal(online(before).length, 1);
    assert.equal(online(before)[0].id, current.session_id);
    assert.equal((await recover(first, initial.session_id, oldOperation)).recovered, false);
    assert.deepEqual(await state(), before);
    assert.equal((await recover(first, initial.session_id, randomUUID())).recovered, false);
    assert.equal((await recover(first, oldResult.session_id, randomUUID())).recovered, false);
    const after = await state();
    assert.deepEqual(after.dispatch, before.dispatch);
    assert.deepEqual(after.work, before.work);
    assert.deepEqual(after.assignments, before.assignments);
    assert.equal(online(after).length, 1);
    assert.equal(online(after)[0].id, current.session_id);
    assert.equal(openWork(after).length, 1);
  });
}
