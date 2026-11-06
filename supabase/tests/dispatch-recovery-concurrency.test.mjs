import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';

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
const sessionStatus = sqlFile('20261103000007_dispatch_session_status.sql');
const financial = sqlFile('20260914220000_add_atomic_wallet_financial_system.sql');
const groups = sqlFile('20251102171543_create_dispatch_groups_system.sql');
const pools = sqlFile('20260927080031_add_secure_dispatch_order_pools.sql');
const groupTimes = sqlFile('20260927120102_unify_dispatch_group_time_settings.sql');
const groupRates = sqlFile('20260927120150_move_order_rates_to_dispatch_groups.sql');
const weighted = sqlFile('20260927165054_add_weighted_dispatch_pool_selection.sql');
const grabRates = sqlFile('20260927182058_separate_dispatch_grab_and_order_success_rates.sql');
const weightedAssignment = sqlFile('20260928080144_align_weighted_dispatch_assignment.sql');
const serverClock = sqlFile('20261103000002_dispatch_server_clock.sql');

function functionSQL(source, name, delimiter = '$function$;') {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  assert.notEqual(start, -1, `Missing real migration function ${name}`);
  const end = source.indexOf(delimiter, start);
  assert.notEqual(end, -1, `Missing function terminator for ${name}`);
  return source.slice(start, end + delimiter.length);
}

function tableSQL(source, name) {
  const match = new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? (?:public\\.)?${name} \\(`).exec(source);
  assert.ok(match, `Missing real table ${name}`);
  const end = source.indexOf('\n);', match.index);
  assert.notEqual(end, -1, `Missing table terminator for ${name}`);
  return source.slice(match.index, end + '\n);'.length);
}

function functionPatchSQL(source, name) {
  const start = source.indexOf(`  SELECT pg_get_functiondef('public.${name}(`);
  assert.notEqual(start, -1, `Missing real patch for ${name}`);
  const blockEnd = source.indexOf('\nEND;\n$block$;', start);
  const nextFunction = source.indexOf('\n  SELECT pg_get_functiondef(', start + 1);
  assert.notEqual(blockEnd, -1, `Missing patch block terminator for ${name}`);
  const end = nextFunction >= 0 && nextFunction < blockEnd ? nextFunction : blockEnd;
  return `DO $native_patch$ DECLARE v_source text; v_old text; v_new text;
    BEGIN\n${source.slice(start, end)}\nEND; $native_patch$;`;
}

const assignmentSQL = functionSQL(groupTimes, 'public.assign_next_dispatch_order_secure');
// The legacy patch anchor differs only in whitespace; normalize it in this isolated fixture.
const multilinePoolLock = "AND (v_group.pool_selection_mode = 'random' OR is_base)\n  FOR SHARE";
assert.equal(assignmentSQL.split(multilinePoolLock).length, 2);
const fixtureAssignmentSQL = assignmentSQL.replace(multilinePoolLock, multilinePoolLock.replace('\n  ', ' '));
const dispatchPatches = [
  functionPatchSQL(groupRates, 'prepare_next_dispatch_order_secure'),
  functionPatchSQL(groupRates, 'assign_next_dispatch_order_secure'),
  functionPatchSQL(weighted, 'prepare_next_dispatch_order_secure'),
  functionPatchSQL(grabRates, 'prepare_next_dispatch_order_secure'),
  functionPatchSQL(grabRates, 'assign_next_dispatch_order_secure'),
  functionPatchSQL(grabRates, 'accept_dispatch_assignment_secure'),
  weightedAssignment,
  serverClock,
].join('\n');

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
let legacyHeartbeatDefinition;
let legacyDispatchDefinitions;

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
CREATE TABLE public.admins(id uuid PRIMARY KEY);
CREATE TABLE public.dispatch_groups(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_timeout_minutes integer NOT NULL DEFAULT 10 CHECK (session_timeout_minutes BETWEEN 1 AND 60),
  dispatch_success_rate integer NOT NULL DEFAULT 100 CHECK (dispatch_success_rate BETWEEN 0 AND 100),
  grab_success_rate integer NOT NULL DEFAULT 100 CHECK (grab_success_rate BETWEEN 0 AND 100),
  commission_rate numeric(12,8) NOT NULL DEFAULT 0.001 CHECK (commission_rate BETWEEN 0.00001 AND 1),
  submit_wait_min_seconds integer NOT NULL DEFAULT 5 CHECK (submit_wait_min_seconds BETWEEN 3 AND 120),
  submit_wait_max_seconds integer NOT NULL DEFAULT 20 CHECK (submit_wait_max_seconds BETWEEN 3 AND 300),
  pool_selection_mode text NOT NULL DEFAULT 'base' CHECK (pool_selection_mode IN ('base', 'random', 'weighted')),
  is_active boolean DEFAULT true, archived_at timestamptz,
  CHECK (submit_wait_min_seconds <= submit_wait_max_seconds));
${tableSQL(groups, 'dispatch_group_members')}
CREATE UNIQUE INDEX dispatch_group_members_one_group_per_user ON public.dispatch_group_members(user_id);
${tableSQL(pools, 'dispatch_order_pools')}
ALTER TABLE public.dispatch_order_pools ADD COLUMN trigger_probability integer NOT NULL DEFAULT 0
  CHECK (trigger_probability BETWEEN 0 AND 100);
${tableSQL(pools, 'dispatch_pool_selections')}
CREATE TABLE public.dispatch_group_orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.dispatch_groups(id), order_content text NOT NULL,
  pool_id uuid NOT NULL, is_active boolean DEFAULT true, archived_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), created_by uuid REFERENCES public.admins(id),
  FOREIGN KEY (pool_id, group_id) REFERENCES public.dispatch_order_pools(id, group_id));
CREATE TABLE public.dispatch_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid,
  status text, assigned_at timestamptz DEFAULT now(), accepted_at timestamptz, accept_deadline_at timestamptz,
  completed_at timestamptz, remarks text, dispatch_session_id uuid, dispatch_order_id uuid, group_id uuid,
  assignment_id text, order_submitted boolean DEFAULT false, session_timeout_minutes_snapshot integer,
  dispatch_success_rate_snapshot integer, order_content_snapshot text,
  pool_id uuid REFERENCES public.dispatch_order_pools(id),
  submit_wait_min_seconds_snapshot integer CHECK (submit_wait_min_seconds_snapshot BETWEEN 3 AND 120),
  submit_wait_max_seconds_snapshot integer CHECK (submit_wait_max_seconds_snapshot BETWEEN 3 AND 300),
  commission_rate_snapshot numeric(12,8) CHECK (commission_rate_snapshot BETWEEN 0.00001 AND 1),
  grab_success_rate_snapshot integer CHECK (grab_success_rate_snapshot BETWEEN 0 AND 100),
  UNIQUE (dispatch_order_id, user_id), UNIQUE (assignment_id),
  CHECK (submit_wait_min_seconds_snapshot <= submit_wait_max_seconds_snapshot));
CREATE TABLE public.orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), assignment_id text, user_id uuid, status text,
  created_at timestamptz DEFAULT now(), processed_at timestamptz);
${functionSQL(lifecycle, 'public.start_employee_dispatch_session_secure')}
${functionSQL(lifecycle, 'public.stop_employee_dispatch_session_secure')}
${functionSQL(lifecycle, 'public.update_session_heartbeat_secure')}
${functionSQL(resume, 'public.resume_employee_dispatch_session_secure')}
${stopFix}
${functionSQL(maintenance, 'public.recover_employee_dispatch_assignment_secure')}
${guarded}
${replaySubmitted}
${functionSQL(resume, 'private.close_dispatch_session_from_system')}
${functionSQL(groupTimes, 'public.prepare_next_dispatch_order_secure')}
${fixtureAssignmentSQL}
${functionSQL(pools, 'public.accept_dispatch_assignment_secure')}
${dispatchPatches}
`;

const credentials = `'${EMPLOYEE}', '${TOKEN}', '${TAB}'`;
const start = session => session.json(`SELECT public.start_employee_dispatch_session_secure(${credentials});`);
const stop = (session, id) => session.json(`SELECT public.stop_employee_dispatch_session_secure(${credentials}, ${id ? `'${id}'` : 'NULL'});`);
const end = (session, id) => session.json(`SELECT public.end_employee_dispatch_session_secure(${credentials}, ${id ? `'${id}'` : 'NULL'});`);
const recover = (session, expected, operation) => session.json(`SELECT public.recover_employee_dispatch_guarded(${credentials}, '${expected}', '${operation}');`);
const state = (session = observer) => session.json(`SELECT jsonb_build_object(
  'dispatch', (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY d.id), '[]'::jsonb) FROM public.dispatch_sessions d),
  'work', (SELECT COALESCE(jsonb_agg(to_jsonb(w) ORDER BY w.id), '[]'::jsonb) FROM public.work_sessions w),
  'assignments', (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.id), '[]'::jsonb) FROM public.dispatch_assignments a),
  'operations', (SELECT COALESCE(jsonb_agg(to_jsonb(o) ORDER BY o.operation_id), '[]'::jsonb) FROM private.employee_dispatch_recovery_operations o));`);
const online = snapshot => snapshot.dispatch.filter(row => row.status === 'online' && row.ended_at === null);
const openWork = snapshot => snapshot.work.filter(row => row.end_time === null);
const settled = promise => promise.then(value => ({ value }), error => ({ error }));
const heartbeat = (session, id) => session.json(`SELECT public.update_session_heartbeat_status_secure(${credentials}, '${id}');`);
const callStatus = (session, id, requireFresh = true) => session.query(
  `SELECT private.get_employee_dispatch_call_status(${credentials}, '${id}', ${requireFresh});`);
const dispatchStatus = (session, action, id) => session.json(
  `SELECT public.${action}_next_dispatch_order_status_secure(${credentials}, '${id}'${action === 'assign' ? ', NULL' : ''});`);

// Include tuple versions/locations as well as persisted fixture data: even a
// no-op UPDATE in the same transaction must fail the zero-write assertion.
const statusState = (session = observer) => session.json(`SELECT
  COALESCE(jsonb_agg(snapshot ORDER BY snapshot.table_name, snapshot.row_value::text), '[]'::jsonb)
  FROM (${[
    'public.users', 'public.employee_financial_sessions', 'public.dispatch_sessions',
    'public.work_sessions', 'public.dispatch_assignments', 'public.orders',
    'public.dispatch_groups', 'public.dispatch_group_orders', 'public.dispatch_group_members',
    'public.dispatch_order_pools', 'public.dispatch_pool_selections',
    'private.employee_dispatch_recovery_operations', 'private.employee_work_stop_markers',
  ].map(table => `SELECT '${table}' AS table_name, to_jsonb(entry) AS row_value,
    entry.xmin::text AS row_version, entry.ctid::text AS row_location FROM ${table} AS entry`).join(' UNION ALL ')}) AS snapshot;`);

function assertEndedHeartbeat(result, id) {
  assert.deepEqual(result, {
    success: false, session_status: 'ended', reason: 'work_session_ended',
    session_id: id, user_id: EMPLOYEE, heartbeat_at: null, work_sessions_updated: 0,
  });
}

function assertDispatchStatus(result, action, status) {
  assert.equal(typeof result.server_now, 'string');
  assert.ok(Number.isFinite(Date.parse(result.server_now)), 'Status response must include a valid server clock');
  assert.deepEqual(result, {
    success: false, session_status: status, server_now: result.server_now,
    ...(action === 'prepare' ? { available: false } : { assignment: null }),
  });
}

function assertHeartbeatApplied(result, snapshot, id) {
  assert.equal(result.success, true);
  assert.equal(result.session_id, id);
  assert.equal(result.user_id, EMPLOYEE);
  assert.equal(result.work_sessions_updated, 1);
  assert.ok(Number.isFinite(Date.parse(result.heartbeat_at)));
  assert.equal(snapshot.dispatch.find(row => row.id === id).last_activity_at, result.heartbeat_at);
  assert.equal(openWork(snapshot).length, 1);
  assert.equal(openWork(snapshot)[0].last_heartbeat_at, result.heartbeat_at);
}

async function seedDispatch(mode = 'base') {
  const config = {
    mode, group: randomUUID(), basePool: randomUUID(), extraPool: randomUUID(),
    baseOrder: randomUUID(), extraOrder: randomUUID(),
  };
  config.pool = mode === 'base' ? config.basePool : config.extraPool;
  config.order = mode === 'base' ? config.baseOrder : config.extraOrder;
  await observer.query(`INSERT INTO public.dispatch_groups
    (id, session_timeout_minutes, dispatch_success_rate, grab_success_rate, commission_rate,
     submit_wait_min_seconds, submit_wait_max_seconds, pool_selection_mode)
    VALUES ('${config.group}', 17, 29, 100, 0.01234567, 7, 23, '${mode}');
    INSERT INTO public.dispatch_group_members (group_id, user_id) VALUES ('${config.group}', '${EMPLOYEE}');
    INSERT INTO public.dispatch_order_pools
      (id, group_id, pool_name, is_base, is_active, dispatch_interval_min, dispatch_interval_max,
       dispatch_order_mode, dispatch_success_rate, trigger_probability)
    VALUES ('${config.basePool}', '${config.group}', 'Base', true, ${mode !== 'random'}, 60, 60, 'sequential', 3, 0),
      ('${config.extraPool}', '${config.group}', 'Weighted', false, true, 60, 60, 'sequential', 3, 100);
    INSERT INTO public.dispatch_group_orders (id, group_id, pool_id, order_content, created_at)
    VALUES ('${config.baseOrder}', '${config.group}', '${config.basePool}', 'base-first', now() - interval '2 days'),
      (gen_random_uuid(), '${config.group}', '${config.basePool}', 'base-second', now() - interval '1 day'),
      ('${config.extraOrder}', '${config.group}', '${config.extraPool}', 'extra-first', now() - interval '2 days'),
      (gen_random_uuid(), '${config.group}', '${config.extraPool}', 'extra-second', now() - interval '1 day');`);
  return config;
}

const selectionRows = (session, id) => session.json(`SELECT COALESCE(jsonb_agg(to_jsonb(selection)), '[]'::jsonb)
  FROM public.dispatch_pool_selections AS selection WHERE session_id = '${id}';`);
const legacyDispatch = (session, action, id, extra = '') => session.json(
  `SELECT public.${action}_next_dispatch_order_secure(${credentials}, '${id}'${action === 'assign' ? `, ${extra || 'NULL'}` : ''});`);

async function makeSelectionDue(id) {
  // Age the isolated fixture's selection, preserving due_at > selected_at. Do
  // not weaken real intervals, freshness thresholds or sleep for a whole minute.
  await observer.query(`UPDATE public.dispatch_pool_selections
    SET selected_at = selected_at - interval '2 minutes', due_at = due_at - interval '2 minutes'
    WHERE session_id = '${id}';`);
}

function assertAtMostOneActive(snapshot) {
  const counts = new Map();
  for (const assignment of snapshot.assignments.filter(row => ['pending', 'accepted'].includes(row.status))) {
    counts.set(assignment.user_id, (counts.get(assignment.user_id) || 0) + 1);
  }
  for (const [user, count] of counts) assert.ok(count <= 1, `${user} has ${count} active assignments`);
}

async function assertPrepared(result, config, id, session = observer) {
  assert.equal(result.available, true);
  assert.equal(Object.hasOwn(result, 'session_status'), false);
  assert.equal(result.group_id, config.group);
  assert.equal(result.pool_id, config.pool);
  assert.ok(Number.isFinite(Date.parse(result.server_now)));
  assert.deepEqual(result.config, {
    dispatch_interval_min: 60, dispatch_interval_max: 60, session_timeout_minutes: 17,
    dispatch_order_mode: 'sequential', grab_success_rate: 100,
  });
  const selections = await selectionRows(session, id);
  assert.equal(selections.length, 1);
  assert.equal(selections[0].session_id, id);
  assert.equal(selections[0].user_id, EMPLOYEE);
  assert.equal(selections[0].group_id, config.group);
  assert.equal(selections[0].pool_id, config.pool);
  assert.equal(selections[0].due_at, result.due_at);
  assert.equal(Date.parse(selections[0].due_at) - Date.parse(selections[0].selected_at), 60000);
  assertAtMostOneActive(await state(session));
}

async function assertAssigned(result, config, id, session = observer) {
  assert.equal(result.success, true);
  assert.equal(Object.hasOwn(result, 'session_status'), false);
  assert.ok(Number.isFinite(Date.parse(result.server_now)));
  assert.equal(result.assignment.dispatch_order_id, config.order);
  assert.equal(result.assignment.group_id, config.group);
  assert.equal(result.assignment.pool_id, config.pool);
  assert.equal(result.assignment.dispatch_session_id, id);
  assert.equal(result.assignment.status, 'pending');
  assert.equal(result.assignment.session_timeout_minutes, 17);
  assert.equal(Date.parse(result.assignment.accept_deadline_at) - Date.parse(result.assignment.assigned_at), 60000);
  const snapshot = await state(session);
  assert.equal(snapshot.assignments.length, 1);
  assertAtMostOneActive(snapshot);
  const assignment = snapshot.assignments[0];
  assert.equal(assignment.id, result.assignment.id);
  assert.equal(assignment.dispatch_order_id, config.order);
  assert.equal(assignment.dispatch_session_id, id);
  assert.equal(assignment.order_content_snapshot, config.mode === 'base' ? 'base-first' : 'extra-first');
  assert.equal(assignment.dispatch_success_rate_snapshot, 29, 'Use group settlement odds, not pool odds');
  assert.equal(assignment.grab_success_rate_snapshot, 100);
  assert.equal(assignment.commission_rate_snapshot, 0.01234567);
  assert.equal(assignment.session_timeout_minutes_snapshot, 17);
  assert.equal(assignment.submit_wait_min_seconds_snapshot, 7);
  assert.equal(assignment.submit_wait_max_seconds_snapshot, 23);
  assert.deepEqual(await selectionRows(session, id), []);
}

async function assertNoFurtherDispatch(id) {
  const stopped = await statusState();
  for (const action of ['prepare', 'assign']) {
    assertDispatchStatus(await dispatchStatus(first, action, id), action, 'ended');
  }
  assert.deepEqual(await statusState(), stopped, 'A stopped session must neither select nor assign again');
  const snapshot = await state();
  assert.equal(online(snapshot).length, 0);
  assert.equal(openWork(snapshot).length, 0);
  assertAtMostOneActive(snapshot);
}

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
    public.employee_financial_sessions, public.users, public.dispatch_pool_selections,
    public.dispatch_group_members, public.dispatch_group_orders, public.dispatch_order_pools, public.dispatch_groups;
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
  legacyHeartbeatDefinition = await observer.query(
    `SELECT pg_get_functiondef('public.update_session_heartbeat_secure(uuid,uuid,text,uuid)'::regprocedure);`);
  legacyDispatchDefinitions = await observer.json(`SELECT jsonb_object_agg(proname, pg_get_functiondef(oid))
    FROM pg_proc WHERE oid IN (
      'public.prepare_next_dispatch_order_secure(uuid,uuid,text,uuid)'::regprocedure,
      'public.assign_next_dispatch_order_secure(uuid,uuid,text,uuid,uuid,text)'::regprocedure);`);
  await observer.query(sessionStatus);
});

afterEach(async () => {
  for (const session of sessions) {
    assert.doesNotMatch(session.stderr, /\b(?:ERROR|FATAL|PANIC):/, `${session.name} stderr: ${session.stderr}`);
  }
  if (observer && observer.process.exitCode === null && observer.pending === null) {
    assertAtMostOneActive(await state());
  }
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

test('end holds the lock before status heartbeat; the waiting heartbeat returns ended without any writes', async () => {
  await reset();
  const initial = await start(first);
  await first.query('BEGIN;');
  const ended = await end(first, initial.session_id);
  assert.equal(ended.stopped_count, 1);
  const stopped = await statusState(first);
  await second.query('BEGIN;');
  const waitingHeartbeat = settled(heartbeat(second, initial.session_id));
  await waitForBlocked(second, first);
  await first.query('COMMIT;');
  const result = await waitingHeartbeat;
  if (result.error) throw result.error;
  assertEndedHeartbeat(result.value, initial.session_id);
  await second.query('COMMIT;');
  assert.deepEqual(await statusState(), stopped);
  const snapshot = await state();
  assert.equal(online(snapshot).length, 0);
  assert.equal(openWork(snapshot).length, 0);
});

test('status heartbeat holds the lock before end; end waits and a late heartbeat stays ended', async () => {
  await reset();
  const initial = await start(first);
  await first.query('BEGIN;');
  const refreshed = await heartbeat(first, initial.session_id);
  assertHeartbeatApplied(refreshed, await state(first), initial.session_id);
  await second.query('BEGIN;');
  const waitingEnd = settled(end(second, initial.session_id));
  await waitForBlocked(second, first);
  await first.query('COMMIT;');
  const ended = await waitingEnd;
  if (ended.error) throw ended.error;
  assert.equal(ended.value.success, true);
  assert.equal(ended.value.stopped_count, 1);
  assert.equal(ended.value.work_sessions_ended, 1);
  await second.query('COMMIT;');
  const stopped = await statusState();
  assertEndedHeartbeat(await heartbeat(first, initial.session_id), initial.session_id);
  assert.deepEqual(await statusState(), stopped);
  const snapshot = await state();
  assert.equal(snapshot.dispatch.length, 1);
  assert.equal(snapshot.work.length, 1);
  assert.equal(online(snapshot).length, 0);
  assert.equal(openWork(snapshot).length, 0);
});

for (const action of ['prepare', 'assign']) {
  test(`recovery holds the lock before status ${action}; the old session returns ended without new dispatch writes`, async () => {
    await reset();
    const initial = await start(first);
    await stop(first, initial.session_id);
    await first.query('BEGIN;');
    const recovered = await recover(first, initial.session_id, randomUUID());
    assert.equal(recovered.recovered, true);
    assert.notEqual(recovered.session_id, initial.session_id);
    const recoveredState = await statusState(first);
    await second.query('BEGIN;');
    const waitingDispatch = settled(dispatchStatus(second, action, initial.session_id));
    await waitForBlocked(second, first);
    await first.query('COMMIT;');
    const result = await waitingDispatch;
    if (result.error) throw result.error;
    assertDispatchStatus(result.value, action, 'ended');
    await second.query('COMMIT;');
    assert.deepEqual(await statusState(), recoveredState);
    const snapshot = await state();
    assert.equal(snapshot.dispatch.length, 2);
    assert.equal(snapshot.work.length, 2);
    assert.equal(snapshot.operations.length, 1);
    assert.equal(snapshot.assignments.length, 0);
    assert.equal(online(snapshot).length, 1);
    assert.equal(online(snapshot)[0].id, recovered.session_id);
    assert.equal(openWork(snapshot).length, 1);
  });
}

for (const lockFirst of ['heartbeat', 'freshness helper']) {
  test(`${lockFirst} holds the lock first; stale heartbeat refresh and read-only freshness checks serialize`, async () => {
    await reset();
    const initial = await start(first);
    await observer.query(`UPDATE public.dispatch_sessions
      SET last_activity_at = clock_timestamp() - interval '121 seconds' WHERE id = '${initial.session_id}';
      UPDATE public.work_sessions SET last_heartbeat_at = clock_timestamp() - interval '121 seconds'
      WHERE user_id = '${EMPLOYEE}' AND end_time IS NULL;`);
    const staleState = await statusState();
    assert.equal(await callStatus(first, initial.session_id), 'stale');
    assert.equal(await callStatus(first, initial.session_id, false), 'active');
    assert.deepEqual(await statusState(), staleState, 'Freshness classification must not update rows');

    await first.query('BEGIN;');
    if (lockFirst === 'heartbeat') {
      const refreshed = await heartbeat(first, initial.session_id);
      assert.equal(refreshed.success, true, 'Heartbeat must refresh a stale but still online session');
      const refreshedState = await statusState(first);
      await second.query('BEGIN;');
      const waitingCheck = settled(callStatus(second, initial.session_id));
      await waitForBlocked(second, first);
      await first.query('COMMIT;');
      const checked = await waitingCheck;
      if (checked.error) throw checked.error;
      assert.equal(checked.value, 'active', 'A waiting freshness check must read the committed heartbeat');
      await second.query('COMMIT;');
      assert.deepEqual(await statusState(), refreshedState, 'The waiting helper must not write state');
      assertHeartbeatApplied(refreshed, await state(), initial.session_id);
    } else {
      assert.equal(await callStatus(first, initial.session_id), 'stale');
      assert.deepEqual(await statusState(first), staleState);
      await second.query('BEGIN;');
      const waitingHeartbeat = settled(heartbeat(second, initial.session_id));
      await waitForBlocked(second, first);
      assert.deepEqual(await statusState(), staleState, 'Heartbeat cannot write while the helper holds its locks');
      await first.query('COMMIT;');
      const refreshed = await waitingHeartbeat;
      if (refreshed.error) throw refreshed.error;
      await second.query('COMMIT;');
      assertHeartbeatApplied(refreshed.value, await state(), initial.session_id);
      const refreshedState = await statusState();
      assert.equal(await callStatus(first, initial.session_id), 'active');
      assert.deepEqual(await statusState(), refreshedState);
    }
    const snapshot = await state();
    assert.equal(snapshot.dispatch.length, 1);
    assert.equal(snapshot.work.length, 1);
    assert.equal(snapshot.assignments.length, 0);
    assert.equal(snapshot.operations.length, 0);
  });
}

for (const action of ['prepare', 'assign']) {
  test(`status ${action} returns stale without invoking active business or writing state`, async () => {
    await reset();
    const initial = await start(first);
    await observer.query(`UPDATE public.dispatch_sessions SET last_activity_at = clock_timestamp() - interval '121 seconds'
      WHERE id = '${initial.session_id}';`);
    const staleState = await statusState();
    assertDispatchStatus(await dispatchStatus(first, action, initial.session_id), action, 'stale');
    assert.deepEqual(await statusState(), staleState);
    assert.equal(online(await state()).length, 1, 'Stale classification alone must not stop work');
    assert.equal(openWork(await state()).length, 1);
  });
}

test('freshness retains the exact two-minute cutoff and classifies NULL activity without writes', async () => {
  await reset();
  const initial = await start(first);
  await first.query('BEGIN;');
  // now() is constant within this transaction, so the boundary needs no sleeps
  // or weakened production threshold to avoid timing-dependent assertions.
  for (const [activity, expected] of [
    ["now() - interval '2 minutes'", 'active'],
    ["now() - interval '2 minutes' - interval '1 microsecond'", 'stale'],
    ['NULL', 'stale'],
  ]) {
    await first.query(`UPDATE public.dispatch_sessions SET last_activity_at = ${activity} WHERE id = '${initial.session_id}';`);
    const beforeCheck = await statusState(first);
    assert.equal(await callStatus(first, initial.session_id), expected);
    assert.equal(await callStatus(first, initial.session_id, false), 'active');
    assert.deepEqual(await statusState(first), beforeCheck);
  }
  await first.query('ROLLBACK;');
});

test('status migration preserves legacy heartbeat definition, active response and ended-session error', async () => {
  await reset();
  assert.equal(await observer.query(
    `SELECT pg_get_functiondef('public.update_session_heartbeat_secure(uuid,uuid,text,uuid)'::regprocedure);`),
  legacyHeartbeatDefinition);
  assert.equal(await observer.query(`SELECT
    to_regprocedure('public.prepare_next_dispatch_order_secure(uuid,uuid,text,uuid)') IS NOT NULL AND
    to_regprocedure('public.assign_next_dispatch_order_secure(uuid,uuid,text,uuid,uuid,text)') IS NOT NULL;`), 't');
  const initial = await start(first);
  const legacy = await first.json(`SELECT public.update_session_heartbeat_secure(${credentials}, '${initial.session_id}');`);
  assertHeartbeatApplied(legacy, await state(), initial.session_id);
  const current = await heartbeat(first, initial.session_id);
  assertHeartbeatApplied(current, await state(), initial.session_id);
  assert.deepEqual({ ...current, heartbeat_at: null }, { ...legacy, heartbeat_at: null });
  assert.equal(Object.hasOwn(current, 'session_status'), false, 'Active heartbeat delegates the unchanged legacy response');
  await end(first, initial.session_id);
  const stopped = await statusState();
  assertEndedHeartbeat(await heartbeat(first, initial.session_id), initial.session_id);

  // An expected legacy ERROR exits only this disposable psql, never one of the
  // suite's persistent sessions. The environment and socket remain local-only.
  const legacyEnded = spawnSync(join(pgBin, 'psql'), [
    '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres',
    '-h', directory, '-p', PORT, '-d', 'postgres',
  ], {
    env: { ...env, PGAPPNAME: 'dispatch-recovery-legacy-ended' },
    encoding: 'utf8', timeout: 12000,
    input: `SET statement_timeout='10s';
      SELECT public.update_session_heartbeat_secure(${credentials}, '${initial.session_id}');`,
  });
  assert.ifError(legacyEnded.error);
  assert.equal(legacyEnded.signal, null);
  assert.equal(legacyEnded.status, 3, legacyEnded.stderr);
  assert.equal(legacyEnded.stdout.trim(), '');
  assert.match(legacyEnded.stderr, /ERROR:\s+Employee session is invalid or expired\./);
  assert.doesNotMatch(legacyEnded.stderr, /\b(?:FATAL|PANIC):/);
  assert.deepEqual(await statusState(), stopped);
});

for (const mode of ['base', 'random', 'weighted']) {
  test(`active status delegation preserves real ${mode} selection, sticky due time, sequential assignment and group snapshots`, async () => {
    await reset();
    const config = await seedDispatch(mode);
    const initial = await start(first);
    const currentDefinitions = await observer.json(`SELECT jsonb_object_agg(proname, pg_get_functiondef(oid))
      FROM pg_proc WHERE oid IN (
        'public.prepare_next_dispatch_order_secure(uuid,uuid,text,uuid)'::regprocedure,
        'public.assign_next_dispatch_order_secure(uuid,uuid,text,uuid,uuid,text)'::regprocedure);`);
    assert.deepEqual(currentDefinitions, legacyDispatchDefinitions, 'Status migration must not rewrite either business function');
    assert.match(currentDefinitions.prepare_next_dispatch_order_secure, /-ln\(greatest\(random\(\), 0\.000000000001\)\) \/ pool\.trigger_probability/);
    assert.match(currentDefinitions.assign_next_dispatch_order_secure, /trigger_probability > 0/);

    const prepared = await dispatchStatus(first, 'prepare', initial.session_id);
    await assertPrepared(prepared, config, initial.session_id);
    const selection = await selectionRows(observer, initial.session_id);
    const sticky = await dispatchStatus(second, 'prepare', initial.session_id);
    const legacyPrepared = await legacyDispatch(second, 'prepare', initial.session_id);
    assert.deepEqual({ ...sticky, server_now: null }, { ...prepared, server_now: null });
    assert.deepEqual({ ...legacyPrepared, server_now: null }, { ...prepared, server_now: null });
    assert.deepEqual(await selectionRows(observer, initial.session_id), selection);
    const notDue = await dispatchStatus(first, 'assign', initial.session_id);
    assert.equal(notDue.success, false);
    assert.equal(notDue.message, 'Dispatch order is not due yet.');
    assert.equal(notDue.due_at, prepared.due_at);
    assert.ok(Number.isFinite(Date.parse(notDue.server_now)));
    assert.equal((await state()).assignments.length, 0);
    await makeSelectionDue(initial.session_id);
    const beforeAssignment = await statusState();

    // Compare both genuine entry points on the same selection in rollback-only
    // transactions. Random UUIDs and server instants are the only differences.
    await first.query('BEGIN;');
    const legacyAssigned = await legacyDispatch(first, 'assign', initial.session_id, `'${randomUUID()}', 'random'`);
    await assertAssigned(legacyAssigned, config, initial.session_id, first);
    await first.query('ROLLBACK;');
    assert.deepEqual(await statusState(), beforeAssignment);
    await first.query('BEGIN;');
    const assigned = await dispatchStatus(first, 'assign', initial.session_id);
    await assertAssigned(assigned, config, initial.session_id, first);
    const comparable = result => ({ ...result, server_now: null, assignment: {
      ...result.assignment, id: null, assigned_at: null, accept_deadline_at: null,
    } });
    assert.deepEqual(comparable(assigned), comparable(legacyAssigned));
    await first.query('COMMIT;');
    await assertAssigned(assigned, config, initial.session_id);
    await end(second, initial.session_id);
    await assertNoFurtherDispatch(initial.session_id);
  });
}

for (const termination of ['end', 'stop']) {
  const terminate = termination === 'end' ? end : stop;
  for (const action of ['prepare', 'assign']) {
    test(`active status ${action} holds the lock; real ${termination} waits and prevents later dispatch`, async () => {
      await reset();
      const config = await seedDispatch('weighted');
      const initial = await start(first);
      if (action === 'assign') {
        await assertPrepared(await dispatchStatus(first, 'prepare', initial.session_id), config, initial.session_id);
        await makeSelectionDue(initial.session_id);
      }
      await first.query('BEGIN;');
      const active = await dispatchStatus(first, action, initial.session_id);
      if (action === 'prepare') await assertPrepared(active, config, initial.session_id, first);
      else await assertAssigned(active, config, initial.session_id, first);
      await second.query('BEGIN;');
      const waitingStop = settled(terminate(second, initial.session_id));
      await waitForBlocked(second, first);
      await first.query('COMMIT;');
      const stopped = await waitingStop;
      if (stopped.error) throw stopped.error;
      assert.equal(stopped.value.success, true);
      assert.equal(stopped.value.stopped_count, 1);
      assert.equal(stopped.value.work_sessions_ended, 1);
      await second.query('COMMIT;');
      await assertNoFurtherDispatch(initial.session_id);
      assert.equal((await state()).assignments.length, action === 'assign' ? 1 : 0);
    });

    test(`real ${termination} holds the lock; waiting status ${action} returns ended without selecting or assigning`, async () => {
      await reset();
      const config = await seedDispatch('weighted');
      const initial = await start(first);
      if (action === 'assign') {
        await assertPrepared(await dispatchStatus(first, 'prepare', initial.session_id), config, initial.session_id);
        await makeSelectionDue(initial.session_id);
      }
      await first.query('BEGIN;');
      assert.equal((await terminate(first, initial.session_id)).stopped_count, 1);
      const stoppedState = await statusState(first);
      await second.query('BEGIN;');
      const waitingDispatch = settled(dispatchStatus(second, action, initial.session_id));
      await waitForBlocked(second, first);
      await first.query('COMMIT;');
      const result = await waitingDispatch;
      if (result.error) throw result.error;
      assertDispatchStatus(result.value, action, 'ended');
      await second.query('COMMIT;');
      assert.deepEqual(await statusState(), stoppedState);
      await assertNoFurtherDispatch(initial.session_id);
      assert.equal((await state()).assignments.length, 0);
    });
  }
}

for (const action of ['prepare', 'assign']) {
  test(`real guarded recovery holds the lock before ${action}; old session ends and new session selects and assigns normally`, async () => {
    await reset();
    const config = await seedDispatch('weighted');
    const initial = await start(first);
    await assertPrepared(await dispatchStatus(first, 'prepare', initial.session_id), config, initial.session_id);
    await makeSelectionDue(initial.session_id);
    await stop(first, initial.session_id);
    await first.query('BEGIN;');
    const recovered = await recover(first, initial.session_id, randomUUID());
    assert.equal(recovered.recovered, true);
    assert.notEqual(recovered.session_id, initial.session_id);
    const recoveredState = await statusState(first);
    await second.query('BEGIN;');
    const waitingOldDispatch = settled(dispatchStatus(second, action, initial.session_id));
    await waitForBlocked(second, first);
    await first.query('COMMIT;');
    const old = await waitingOldDispatch;
    if (old.error) throw old.error;
    assertDispatchStatus(old.value, action, 'ended');
    await second.query('COMMIT;');
    assert.deepEqual(await statusState(), recoveredState);
    await assertPrepared(await dispatchStatus(first, 'prepare', recovered.session_id), config, recovered.session_id);
    await makeSelectionDue(recovered.session_id);
    const assigned = await dispatchStatus(first, 'assign', recovered.session_id);
    await assertAssigned(assigned, config, recovered.session_id);
    const snapshot = await state();
    assert.equal(snapshot.dispatch.length, 2);
    assert.equal(snapshot.work.length, 2);
    assert.equal(snapshot.operations.length, 1);
    assert.equal(online(snapshot).length, 1);
    assert.equal(online(snapshot)[0].id, recovered.session_id);
    await end(second, recovered.session_id);
    await assertNoFurtherDispatch(recovered.session_id);
  });

  test(`active status ${action} holds the lock before guarded recovery; committed selection or assignment cannot duplicate`, async () => {
    await reset();
    const config = await seedDispatch('weighted');
    const initial = await start(first);
    if (action === 'assign') {
      await assertPrepared(await dispatchStatus(first, 'prepare', initial.session_id), config, initial.session_id);
      await makeSelectionDue(initial.session_id);
    }
    await first.query('BEGIN;');
    const active = await dispatchStatus(first, action, initial.session_id);
    if (action === 'prepare') await assertPrepared(active, config, initial.session_id, first);
    else await assertAssigned(active, config, initial.session_id, first);
    await second.query('BEGIN;');
    const waitingRecovery = settled(recover(second, initial.session_id, randomUUID()));
    await waitForBlocked(second, first);
    await first.query('COMMIT;');
    const result = await waitingRecovery;
    if (result.error) throw result.error;
    assert.equal(result.value.recovered, true);
    await second.query('COMMIT;');
    const currentId = result.value.session_id;
    const snapshot = await state();
    assert.equal(online(snapshot).length, 1);
    assert.equal(online(snapshot)[0].id, currentId);
    assert.equal(openWork(snapshot).length, 1);
    assertAtMostOneActive(snapshot);
    if (action === 'prepare') {
      // Recovery may resume the same live session; its sticky selection must win.
      const prepared = await dispatchStatus(first, 'prepare', currentId);
      await assertPrepared(prepared, config, currentId);
      if (currentId === initial.session_id) assert.equal(prepared.due_at, active.due_at);
      await makeSelectionDue(currentId);
      await assertAssigned(await dispatchStatus(first, 'assign', currentId), config, currentId);
    } else {
      assert.equal(snapshot.assignments.length, 1);
      assert.equal(snapshot.assignments[0].id, active.assignment.id);
      assert.equal(snapshot.assignments[0].dispatch_session_id, currentId);
      const beforeRetry = await statusState();
      const retry = await dispatchStatus(first, 'assign', currentId);
      assert.equal(retry.success, false);
      assert.equal(retry.message, 'An active dispatch assignment already exists.');
      assert.deepEqual(await statusState(), beforeRetry);
    }
    await end(second, currentId);
    await assertNoFurtherDispatch(currentId);
  });
}

for (const existingStatus of ['pending', 'accepted']) {
  test(`two active assign requests serialize and retain just one ${existingStatus} assignment`, async () => {
    await reset();
    const config = await seedDispatch('weighted');
    const initial = await start(first);
    await assertPrepared(await dispatchStatus(first, 'prepare', initial.session_id), config, initial.session_id);
    await makeSelectionDue(initial.session_id);
    await first.query('BEGIN;');
    const assigned = await dispatchStatus(first, 'assign', initial.session_id);
    await assertAssigned(assigned, config, initial.session_id, first);
    if (existingStatus === 'accepted') {
      const accepted = await first.json(`SELECT public.accept_dispatch_assignment_secure(${credentials},
        '${initial.session_id}', '${assigned.assignment.id}', '${randomUUID()}');`);
      assert.equal(accepted.success, true, 'Real acceptance uses the separate 100% grab snapshot, not 29% settlement odds');
    }
    const assignedState = await statusState(first);
    await second.query('BEGIN;');
    const waitingAssignment = settled(dispatchStatus(second, 'assign', initial.session_id));
    await waitForBlocked(second, first);
    await first.query('COMMIT;');
    const later = await waitingAssignment;
    if (later.error) throw later.error;
    assert.equal(later.value.success, false);
    assert.equal(later.value.message, 'An active dispatch assignment already exists.');
    await second.query('COMMIT;');
    assert.deepEqual(await statusState(), assignedState);
    const snapshot = await state();
    assert.equal(snapshot.assignments.length, 1);
    assert.equal(snapshot.assignments[0].status, existingStatus);
    assertAtMostOneActive(snapshot);
    const prepareRetry = await dispatchStatus(first, 'prepare', initial.session_id);
    assert.equal(prepareRetry.available, false);
    assert.equal(prepareRetry.message, 'An active dispatch assignment already exists.');
    assert.deepEqual(await statusState(), assignedState);
    await end(second, initial.session_id);
    await assertNoFurtherDispatch(initial.session_id);
  });
}
