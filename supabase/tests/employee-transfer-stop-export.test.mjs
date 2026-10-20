import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, mock, test } from 'node:test';
import { replayMigrations } from './support/replay-migrations.mjs';
import { adminLogin, rows, rpc as baseRpc, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Real SQL/session/ACL/job-lock/audit execution in local PGlite only. No browser,
// PostgREST, multi-connection PostgreSQL or actual Storage is exercised.
const MIGRATION = '20261102000042_stop_owned_export.sql';
const PREVIOUS = '20261102000041_snapshot_site_export.sql';
const STOP = 'public.employee_export_stop_owned(uuid,text,uuid,text)';
const CONFIRM = '確認停止導出任務';
const PROTOCOLS = ['shared-settings-v1', 'products-v1', 'dispatch-submission-v1', 'employee-identity-v1',
  'employee-finance-v1', 'employee-activity-v1', 'employee-verification-v1', 'site-notifications-v1',
  'site-chat-v1', 'site-archives-v1'];
const quote = identifier => '"' + identifier.replaceAll('"', '""') + '"';
let db, replay, session, branch, emergency, otherRoot, inside = false;
let schemaBefore, schemaAfter, businessBefore, businessAfter;

async function businessSnapshot() {
  const result = {};
  for (const { schema, name } of await rows(db, `SELECT n.nspname AS schema,c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p')
      AND c.oid NOT IN ('private.employee_transfer_jobs'::regclass,
        'private.employee_transfer_staging'::regclass,'private.employee_transfer_events'::regclass,
        'public.financial_login_attempts'::regclass)
    ORDER BY n.nspname,c.relname`)) {
    result[`${schema}.${name}`] = await scalar(db, `SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n'
      ORDER BY to_jsonb(t)::text COLLATE "C"),'')) FROM ${quote(schema)}.${quote(name)} t`);
  }
  return result;
}
async function schemaSnapshot() {
  return {
    functions: await rows(db, `SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition,p.proacl::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','private') AND p.prokind='f'
        AND p.oid<>COALESCE(to_regprocedure($1),0::oid) ORDER BY signature`, [STOP]),
    relations: await rows(db, `SELECT c.oid::regclass::text AS relation,c.relkind,c.relrowsecurity,c.relacl::text,
      a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      WHERE n.nspname IN ('public','private') ORDER BY relation,a.attnum`),
    triggers: await rows(db, `SELECT t.tgrelid::regclass::text AS relation,t.tgname,t.tgenabled
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','private') ORDER BY relation,t.tgname`),
    policies: await rows(db, `SELECT * FROM pg_policies WHERE schemaname IN ('public','private') ORDER BY schemaname,tablename,policyname`),
  };
}
async function isolated(fn) {
  await db.exec('BEGIN'); inside = true;
  try { await fn(); } finally { inside = false; await db.exec('ROLLBACK'); }
}
async function call(name, args, role = 'anon') {
  const owned = !inside;
  if (owned) await db.exec('BEGIN');
  await db.exec('SAVEPOINT stop_call');
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    const value = await baseRpc(db, name, args, { role: null });
    await db.exec('RESET ROLE; RELEASE SAVEPOINT stop_call');
    if (owned) await db.exec('COMMIT');
    return value;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT stop_call; RELEASE SAVEPOINT stop_call');
    if (owned) await db.exec('ROLLBACK');
    throw error;
  }
}
const stopArgs = (jobId, over = {}) => ({ p_admin_session_token: session, p_admin_password: PASSWORDS.root,
  p_job_id: jobId, p_confirmation: CONFIRM, ...over });
const stop = (jobId, over, role) => call('employee_export_stop_owned', stopArgs(jobId, over), role);
const log = () => call('get_employee_transfer_log', { p_admin_session_token: session });
const beginShared = () => call('employee_export_shared_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
const jobRow = id => scalar(db, 'SELECT to_jsonb(j) FROM private.employee_transfer_jobs j WHERE id=$1', [id]);
const events = id => rows(db, 'SELECT action,details,admin_id FROM private.employee_transfer_events WHERE job_id=$1 ORDER BY id', [id]);
const technical = () => scalar(db, `SELECT jsonb_build_object('jobs',(SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY id),'[]') FROM private.employee_transfer_jobs j),
  'staging',(SELECT count(*)::int FROM private.employee_transfer_staging),
  'events',(SELECT count(*)::int FROM private.employee_transfer_events))`);
async function insertJob({ kind = 'export', protocol = PROTOCOLS[0], admin = NEW.root, status = 'running', username = 'root', extra = '' } = {}) {
  const id = randomUUID();
  await db.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [id, kind, admin, username, randomUUID().replaceAll('-', ''), status,
    JSON.stringify(protocol === null ? {} : { export_protocol: protocol })]);
  if (extra) await db.query(extra, [id]);
  return id;
}

before(async () => {
  mock.method(globalThis, 'fetch', () => assert.fail('Network, production and Storage access forbidden'));
  replay = await replayMigrations({ upTo: PREVIOUS, strict: true }); db = replay.db;
  schemaBefore = await schemaSnapshot(); businessBefore = await businessSnapshot();
  await db.exec(await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8'));
  schemaAfter = await schemaSnapshot(); businessAfter = await businessSnapshot();
  await buildNewSite(db);
  session = await adminLogin(db, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch);
  emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  const otherId = randomUUID();
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    VALUES($1,'stop-other-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [otherId, PASSWORDS.root]);
  await db.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash)
    SELECT id,password_hash FROM public.admins WHERE id=$1`, [otherId]);
  otherRoot = await adminLogin(db, 'stop-other-root', PASSWORDS.root);
  await db.query(`UPDATE private.employee_transfer_jobs SET status='cancelled' WHERE status='running'`);
}, { timeout: 180000 });
after(async () => { await db?.close(); mock.restoreAll(); });

test('SQL42 installs after SQL41 with exactly 12 known failures and no other schema or business change', () => {
  assert.equal(replay.files.at(-1), PREVIOUS);
  assert.equal(replay.failures.length, 12);
  assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.deepEqual(schemaAfter, schemaBefore);
  assert.deepEqual(businessAfter, businessBefore);
});

test('stop RPC has fixed search_path, lock_timeout, SECURITY DEFINER and anon/authenticated-only ACL', async () => {
  const p = (await rows(db, `SELECT prosecdef,provolatile,proconfig,proacl::text,pronargdefaults,proargnames,prorettype::regtype::text AS ret
    FROM pg_proc WHERE oid=to_regprocedure($1)`, [STOP]))[0];
  assert.equal(p.prosecdef, true); assert.equal(p.provolatile, 'v'); assert.equal(p.ret, 'jsonb');
  assert.deepEqual([...p.proconfig].sort(), ['lock_timeout=2s', 'search_path=pg_catalog, public, private, pg_temp']);
  assert.equal(p.pronargdefaults, 0);
  assert.deepEqual(p.proargnames, ['p_admin_session_token', 'p_admin_password', 'p_job_id', 'p_confirmation']);
  assert.doesNotMatch(p.proacl, /(?:^|,)=[^,]*X/);
  for (const [role, allowed] of [['anon', true], ['authenticated', true], ['service_role', false]]) {
    assert.equal(await scalar(db, `SELECT has_function_privilege($1,$2,'EXECUTE')`, [role, STOP]), allowed);
  }
});

test('lost begin response: the logged running id stops the export, frees the lock, and the next export starts', async () => {
  const business = await businessSnapshot();
  await beginShared(); // response deliberately discarded, so the job token is unknown
  await assert.rejects(call('employee_export_products_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root }), /still running/);
  const running = (await log()).running;
  assert.ok(running.id); assert.equal(running.kind, 'export');
  const receipt = await stop(running.id);
  assert.deepEqual(receipt, { success: true, cancelled: true, job_id: running.id, scope: 'export-task', full_site_complete: false });
  assert.doesNotMatch(JSON.stringify(receipt), /token/i);
  const state = await jobRow(running.id);
  assert.equal(state.status, 'cancelled'); assert.ok(state.finished_at); assert.equal(state.error, null);
  assert.deepEqual(state.summary, { scope: 'export-task', stopped_by_owner: true, export_protocol: 'shared-settings-v1', full_site_complete: false });
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [running.id]), 0);
  assert.equal((await log()).running, null);
  const audit = await events(running.id);
  assert.deepEqual(audit.map(e => e.action), ['export_begin', 'export_cancelled']);
  assert.equal(audit[1].admin_id, NEW.root);
  const text = JSON.stringify(audit);
  assert.doesNotMatch(text, new RegExp(`${PASSWORDS.root}|password_hash|job_token|token_hash|${CONFIRM}`));
  const next = await call('employee_export_products_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  assert.equal(next.success, true); assert.notEqual(next.job_id, running.id);
  assert.equal((await stop(next.job_id)).cancelled, true);
  assert.deepEqual(await businessSnapshot(), business);
});

for (const protocol of PROTOCOLS) {
  test(`stops an own running export of protocol ${protocol} only`, async () => isolated(async () => {
    const id = await insertJob({ protocol });
    await db.query(`INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES($1,$2,'k',0,1,'{}'::jsonb)`, [id, randomUUID()]);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [id]), 1);
    const result = await stop(id);
    assert.deepEqual(result, { success: true, cancelled: true, job_id: id, scope: 'export-task', full_site_complete: false });
    assert.equal((await jobRow(id)).status, 'cancelled');
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [id]), 0);
  }));
}

test('stop rejects unknown protocols, import tasks, other owners, unknown or null ids without changing technical state', async () => isolated(async () => {
  const cases = [{ protocol: 'site-bundle-set-v1' }, { protocol: 'unknown-v9' }, { protocol: null },
    { kind: 'import', protocol: 'shared-settings-v1' }, { admin: NEW.branch, username: 'branch' }];
  for (const spec of cases) {
    const id = await insertJob(spec);
    const before = await technical();
    await assert.rejects(stop(id), /cannot be stopped/);
    assert.deepEqual(await technical(), before);
    await db.query(`UPDATE private.employee_transfer_jobs SET status='cancelled' WHERE id=$1`, [id]);
  }
  const id = await insertJob();
  const before = await technical();
  await assert.rejects(stop(randomUUID()), /cannot be stopped/);
  await assert.rejects(stop(null), /cannot be stopped/);
  await assert.rejects(stop(id, { p_admin_session_token: otherRoot }), /cannot be stopped/);
  assert.deepEqual(await technical(), before);
  assert.equal((await jobRow(id)).status, 'running');
}));

for (const [label, over] of [['wrong text', { p_confirmation: '確認停止' }], ['null', { p_confirmation: null }],
  ['padded', { p_confirmation: CONFIRM + ' ' }], ['empty', { p_confirmation: '' }]]) {
  test(`stop rejects confirmation: ${label}`, async () => isolated(async () => {
    const id = await insertJob(); const before = await technical();
    await assert.rejects(stop(id, over), /confirmation/);
    assert.deepEqual(await technical(), before);
  }));
}

test('wrong or empty password returns success:false without leaking, stopping or auditing', async () => isolated(async () => {
  const id = await insertJob(); const before = await technical();
  for (const password of ['wrong-password', '', null]) {
    const result = await stop(id, { p_admin_password: password });
    assert.equal(result.success, false);
    assert.deepEqual(Object.keys(result).filter(key => !['success', 'error', 'locked_until'].includes(key)), []);
    assert.doesNotMatch(JSON.stringify(result), /job|running|token/i);
  }
  assert.deepEqual(await technical(), before);
  assert.equal((await jobRow(id)).status, 'running');
}));

for (const reason of ['null-session', 'random-session', 'secondary', 'emergency', 'revoked-session', 'expired-session', 'inactive-admin', 'demoted-admin']) {
  test(`stop enforces server session permissions for ${reason}`, async () => isolated(async () => {
    const id = await insertJob(); const before = await technical();
    const token = { 'null-session': null, 'random-session': randomUUID(), secondary: branch, emergency }[reason];
    if (reason === 'revoked-session') await db.query('UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE admin_id=$1', [NEW.root]);
    if (reason === 'expired-session') await db.query(`UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1`, [NEW.root]);
    if (reason === 'inactive-admin') await db.query('UPDATE public.admins SET is_active=false WHERE id=$1', [NEW.root]);
    if (reason === 'demoted-admin') await db.query(`UPDATE public.admins SET role='secondary_admin' WHERE id=$1`, [NEW.root]);
    await assert.rejects(stop(id, { p_admin_session_token: token === undefined ? session : token }), /session|permission|administrator|invalid or expired/i);
    assert.deepEqual(await technical(), before);
  }));
}

test('repeat stop and finished/cancelled/failed/abandoned/expired jobs return cancelled:false without data or maintenance changes', async () => isolated(async () => {
  const id = await insertJob();
  assert.equal((await stop(id)).cancelled, true);
  await db.query(`INSERT INTO private.employee_transfer_maintenance(job_id,admin_id,plan_hash,target_hash,entered_at,dirty)
    VALUES($1,$2,$3,$4,now(),true)`, [id, NEW.root, 'a'.repeat(64), 'b'.repeat(64)]);
  const business = await businessSnapshot(); const tech = await technical();
  const again = await stop(id);
  assert.deepEqual(again, { success: true, cancelled: false, job_id: id, status: 'cancelled', scope: 'export-task', full_site_complete: false });
  assert.deepEqual(await technical(), tech);
  for (const status of ['finished', 'failed', 'abandoned']) {
    const other = await insertJob({ protocol: 'products-v1', status });
    assert.deepEqual(await stop(other), { success: true, cancelled: false, job_id: other, status, scope: 'export-task', full_site_complete: false });
    assert.equal((await jobRow(other)).status, status);
  }
  for (const column of ['last_activity_at', 'started_at']) {
    const expired = await insertJob({ protocol: 'site-chat-v1' });
    await db.query(`UPDATE private.employee_transfer_jobs SET ${column}=now()-interval '13 hours' WHERE id=$1`, [expired]);
    const result = await stop(expired);
    assert.deepEqual(result, { success: true, cancelled: false, job_id: expired, status: 'expired', scope: 'export-task', full_site_complete: false });
    assert.equal((await jobRow(expired)).status, 'running');
    await db.query(`UPDATE private.employee_transfer_jobs SET status='abandoned' WHERE id=$1`, [expired]);
  }
  assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits'), 0);
  assert.deepEqual(await businessSnapshot(), business);
  // Terminal other-owner / import jobs are still rejected, not reported as idempotent.
  const foreign = await insertJob({ status: 'finished', admin: NEW.branch, username: 'branch' });
  await assert.rejects(stop(foreign), /cannot be stopped/);
}));

test('stopping never touches an import task, maintenance or business data and is not full-site completion', async () => isolated(async () => {
  const importId = await insertJob({ kind: 'import', protocol: null, status: 'finished' });
  await db.query(`INSERT INTO private.employee_transfer_maintenance(job_id,admin_id,plan_hash,target_hash,entered_at,dirty)
    VALUES($1,$2,$3,$4,now(),true)`, [importId, NEW.root, 'a'.repeat(64), 'b'.repeat(64)]);
  const live = await insertJob({ protocol: 'products-v1' });
  const business = await businessSnapshot();
  const importBefore = await jobRow(importId);
  const result = await stop(live);
  assert.equal(result.full_site_complete, false); assert.equal(result.scope, 'export-task');
  assert.deepEqual(await businessSnapshot(), business);
  assert.deepEqual(await jobRow(importId), importBefore);
  assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
  const audit = await events(live);
  assert.deepEqual(audit.map(e => e.action), ['export_cancelled']);
  assert.equal(audit[0].details.full_site_complete, false);
  assert.equal(audit[0].details.scope, 'export-task');
  assert.doesNotMatch(JSON.stringify(audit), /RootPass|password|token/i);
}));

test('a running import task is never stopped through the export stop RPC', async () => isolated(async () => {
  const importId = await insertJob({ kind: 'import', protocol: 'shared-settings-v1' });
  const before = await technical();
  await assert.rejects(stop(importId), /cannot be stopped/);
  assert.deepEqual(await technical(), before);
  assert.equal((await jobRow(importId)).status, 'running');
}));
