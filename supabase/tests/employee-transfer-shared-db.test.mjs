import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { replayMigrations } from './support/replay-migrations.mjs';
import { adminLogin, rows, rpc as baseRpc, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

const keys = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
const hash = text => createHash('sha256').update(text).digest('hex');
let db;
let session;
let branchSession;
let emergencySession;
let exporter;

before(async () => {
  ({ db } = await replayMigrations({ strict: true }));
  await buildNewSite(db);
  session = await adminLogin(db, 'root', PASSWORDS.root);
  branchSession = await adminLogin(db, 'branch', PASSWORDS.branch);
  emergencySession = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../../src/lib/employeeTransfer/sharedExport.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020',
  });
  exporter = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
}, { timeout: 180000 });
after(async () => { await db?.close(); });

async function transaction(fn) {
  await db.exec('BEGIN');
  try { await fn(); } finally { await db.exec('ROLLBACK'); }
}
async function rpc(database, name, args) {
  await database.exec('SAVEPOINT shared_rpc');
  try {
    await database.exec('SET LOCAL ROLE anon');
    const result = await baseRpc(database, name, args, { role: null });
    await database.exec('RESET ROLE; RELEASE SAVEPOINT shared_rpc');
    return result;
  } catch (error) {
    await database.exec('ROLLBACK TO SAVEPOINT shared_rpc; RELEASE SAVEPOINT shared_rpc');
    throw error;
  }
}
const auth = job => ({ p_admin_session_token: session, p_job_token: job.job_token });
async function begin() {
  const job = await rpc(db, 'employee_export_shared_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root,
  });
  assert.equal(job.success, true);
  return job;
}
const page = (job, key, after = null, limit = 200) => rpc(db, 'get_employee_export_shared_page', {
  ...auth(job), p_table_key: key, p_after: after, p_limit: limit,
});
async function table(job, key, limit = 200) {
  let after = null;
  let text = '';
  do {
    const result = await page(job, key, after, limit);
    assert.equal(result.sha256, hash(result.ndjson));
    assert.equal(result.count, result.ndjson.split('\n').length - 1);
    text += result.ndjson;
    after = result.next_after;
  } while (after !== null);
  return { text, rows: text.trim() ? text.trimEnd().split('\n').map(line => JSON.parse(line)) : [] };
}
function sink() {
  const files = new Map();
  return {
    files, aborted: false,
    async append(path, bytes) {
      assert.equal(this.aborted, false);
      if (!files.has(path)) files.set(path, []);
      files.get(path).push(Buffer.from(bytes));
    },
    async abort() { this.aborted = true; files.clear(); },
  };
}
const source = job => ({
  catalog: () => rpc(db, 'get_employee_export_shared_catalog', auth(job)),
  page: (key, after) => page(job, key, after, 2),
  verify: () => rpc(db, 'employee_export_shared_verify', auth(job)),
});

const schemas = {
  admins: ['id', 'username', 'role', 'parent_id', 'is_active', 'is_pinned', 'created_at', 'updated_at'],
  financial_admin_credentials: ['admin_id', 'password_hash', 'created_at', 'updated_at'],
  admin_groups: ['id', 'name', 'created_by', 'created_at', 'updated_at'],
  admin_group_members: ['id', 'group_id', 'admin_id', 'created_at'],
  admin_configs: ['id', 'admin_id', 'config_type', 'config_value', 'icon_type', 'icon_custom_url', 'created_at', 'updated_at'],
  system_configs: ['key', 'value'],
  history_cleanup_config: ['table_name', 'retention_days', 'auto_cleanup_enabled', 'schedule_time_utc'],
};

test('real RPC exports all seven shared domains to NDJSON and checks exact hashes before source verification', async () => transaction(async () => {
  await db.query('UPDATE public.admins SET parent_id = $1 WHERE id = $2', [NEW.root, NEW.branch]);
  const group = randomUUID();
  await db.query('INSERT INTO public.admin_groups (id, name, created_by) VALUES ($1, $2, $3)', [group, '迁移𠮷', NEW.root]);
  await db.query('INSERT INTO public.admin_group_members (group_id, admin_id) VALUES ($1, $2)', [group, NEW.branch]);
  await db.query(`INSERT INTO public.admin_configs (admin_id, config_type, config_value) VALUES ($1, 'company_name', '资料𠮷')
    ON CONFLICT (admin_id, config_type) DO UPDATE SET config_value = EXCLUDED.config_value`, [NEW.branch]);
  const job = await begin();
  assert.deepEqual(job.catalog.tables.map(item => item.key), keys);
  assert.equal(job.catalog.scope, 'shared-settings');
  assert.equal(job.catalog.full_site_complete, false);
  const output = sink();
  const progress = [];
  const result = await exporter.exportSharedSettings(source(job), output, { onProgress: item => progress.push(item) });
  assert.equal(result.fullSiteComplete, false);
  assert.equal(result.entries.length, 7);
  assert.equal(progress.at(-1).rows, result.rows);
  assert.equal(progress.at(-1).bytes, result.bytes);
  assert.equal(await scalar(db, 'SELECT summary->>\'shared_verified\' FROM private.employee_transfer_jobs WHERE id = $1', [job.job_id]), 'true');
  for (const entry of result.entries) {
    const text = Buffer.concat(output.files.get(entry.path)).toString('utf8');
    const expected = job.catalog.tables.find(item => entry.path === `data/shared-${item.key}.ndjson`);
    assert.equal(entry.sha256, hash(text));
    assert.equal(entry.bytes, Buffer.byteLength(text));
    assert.equal(expected.sha256, entry.sha256);
    assert.equal(expected.rows, text.split('\n').length - 1);
    for (const line of text.trimEnd().split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      const allowed = [...schemas[expected.key]];
      if (expected.key === 'admins' && row.role !== 'super_admin') allowed.push('password_hash');
      assert.deepEqual(Object.keys(row).sort(), allowed.sort());
    }
  }
  const admins = (await table(job, 'admins', 1)).rows;
  const root = admins.find(item => item.id === NEW.root);
  const branch = admins.find(item => item.id === NEW.branch);
  const emergency = admins.find(item => item.id === NEW.emergency);
  assert.equal(root.role, 'super_admin');
  assert.equal(Object.hasOwn(root, 'password_hash'), false);
  assert.equal(branch.parent_id, NEW.root);
  assert.equal(emergency.role, 'emergency_admin');
  const credentials = (await table(job, 'financial_admin_credentials', 1)).rows;
  assert.equal(credentials.some(item => item.admin_id === NEW.root), false);
  for (const id of [NEW.branch, NEW.emergency]) {
    assert.equal(credentials.find(item => item.admin_id === id).password_hash,
      await scalar(db, 'SELECT password_hash FROM public.financial_admin_credentials WHERE admin_id = $1', [id]));
    assert.equal(admins.find(item => item.id === id).password_hash,
      await scalar(db, 'SELECT password_hash FROM public.admins WHERE id = $1', [id]));
  }
  const retained = (await table(job, 'history_cleanup_config')).rows;
  assert.equal(retained.length, 16);
  for (const row of retained) {
    assert.equal(Object.hasOwn(row, 'last_cleanup_at'), false);
    assert.match(row.schedule_time_utc, /^\d\d:\d\d:00$/);
  }
  await assert.rejects(rpc(db, 'employee_export_finish', { ...auth(job), p_summary: { employees: 999, full_site_complete: true } }),
    /not a completed full-site export/);
  assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id = $1', [job.job_id]), 'running');
}));

test('shared start rejects non-super sessions and verifies the password without logging it', async () => transaction(async () => {
  for (const token of [randomUUID(), branchSession, emergencySession]) {
    await assert.rejects(rpc(db, 'employee_export_shared_begin', {
      p_admin_session_token: token, p_admin_password: PASSWORDS.root,
    }), /permission|session|administrator/i);
  }
  const wrong = await rpc(db, 'employee_export_shared_begin', {
    p_admin_session_token: session, p_admin_password: 'WrongPass-local-only',
  });
  assert.equal(wrong.success, false);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status = 'running'"), 0);
  const job = await begin();
  for (const token of [randomUUID(), branchSession, emergencySession]) {
    await assert.rejects(rpc(db, 'get_employee_export_shared_catalog', { ...auth(job), p_admin_session_token: token }),
      /permission|session|administrator|invalid/i);
  }
  await assert.rejects(rpc(db, 'get_employee_export_shared_catalog', { ...auth(job), p_job_token: randomUUID() }), /invalid or expired/);
  const events = await rows(db, 'SELECT details FROM private.employee_transfer_events WHERE job_id = $1', [job.job_id]);
  assert.doesNotMatch(JSON.stringify(events), /RootPass|WrongPass|password_hash|job_token/);
}));

test('frozen pages are retry-safe, cursor-bound, and refuse unknown table names or invalid page limits', async () => transaction(async () => {
  const job = await begin();
  const first = await page(job, 'admins', null, 1);
  assert.ok(first.next_after);
  assert.deepEqual(await page(job, 'admins', null, 1), first);
  for (const key of [null, 'admin_financial_sessions', 'private.employee_transfer_staging', "admins'; DROP TABLE admins;--"]) {
    await assert.rejects(page(job, key), /Unsupported shared export table key/);
  }
  for (const limit of [0, -1, 201, null]) await assert.rejects(page(job, 'admins', null, limit), /page limit/);
  await assert.rejects(page(job, 'admins', randomUUID()), /cursor/);
  await assert.rejects(page(job, 'admins', 'x'.repeat(100000)), /cursor/);
  const oldHash = (await table(job, 'admins')).rows.find(item => item.id === NEW.branch).password_hash;
  await db.query('UPDATE public.admins SET password_hash = $1 WHERE id = $2', ['changed-local-only', NEW.branch]);
  assert.equal((await table(job, 'admins')).rows.find(item => item.id === NEW.branch).password_hash, oldHash);
  await assert.rejects(rpc(db, 'employee_export_shared_verify', auth(job)), /source data changed/);
  assert.notEqual(await scalar(db, 'SELECT summary->>\'shared_verified\' FROM private.employee_transfer_jobs WHERE id = $1', [job.job_id]), 'true');
}));

test('a changed configuration with identical row counts invalidates verification and discards temporary files', async () => transaction(async () => {
  const job = await begin();
  const live = source(job);
  const beforeVerify = live.verify;
  live.verify = async () => {
    await db.query(`UPDATE public.system_configs SET value = '"New title"'::jsonb WHERE key = 'login_title'`);
    return beforeVerify();
  };
  const output = sink();
  await assert.rejects(exporter.exportSharedSettings(live, output), /source data changed/);
  assert.equal(output.aborted, true);
  assert.equal(output.files.size, 0);
}));

test('super administrator password and transient session changes are deliberately not part of the business snapshot', async () => transaction(async () => {
  const job = await begin();
  await db.query('UPDATE public.admins SET password_hash = $1 WHERE id = $2', ['not-exported-root-hash', NEW.root]);
  await db.query('UPDATE public.financial_admin_credentials SET password_hash = $1 WHERE admin_id = $2', ['not-exported-root-credential', NEW.root]);
  await db.query('UPDATE public.admin_financial_sessions SET created_at = now() - interval \'1 hour\' WHERE admin_id = $1', [NEW.branch]);
  assert.equal((await rpc(db, 'employee_export_shared_verify', auth(job))).verified, true);
  const text = (await table(job, 'admins')).text + (await table(job, 'financial_admin_credentials')).text;
  assert.doesNotMatch(text, /not-exported-root|token_hash|expires_at|revoked_at/);
}));

test('unknown keys and malformed JSON settings block begin atomically, without leaking the value into errors', async () => transaction(async () => {
  await db.query('INSERT INTO public.system_configs (key, value) VALUES ($1, $2::jsonb)', ['unreviewed_setting', '{"token":"sensitive-fixture-secret"}']);
  await assert.rejects(begin(), error => /Unreviewed shared setting key/.test(error.message) && !error.message.includes('sensitive-fixture-secret'));
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status = 'running'"), 0);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging'), 0);
}));

for (const [key, value] of [
  ['login_title', { endpoint: 'fixture-secret' }], ['announcement_carousel_enabled', 'true'],
  ['announcement_carousel_speed', 99], ['login_subtitle', ''],
  ['admin_navigation_preferences', { order: [], labels: {}, token: 'fixture-secret' }],
  ['admin_navigation_preferences', { order: ['nonexistent-tab'], labels: {} }],
]) {
  test(`invalid setting shape is rejected for ${key} ${JSON.stringify(value)}`, async () => transaction(async () => {
    await db.query('INSERT INTO public.system_configs (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, JSON.stringify(value)]);
    await assert.rejects(begin(), /Invalid shared setting value/);
  }));
}

test('known obsolete system settings are listed but their arbitrary JSON never enters the export', async () => transaction(async () => {
  for (const key of ['ios_config', 'auto_cleanup_schedule', 'auto_cleanup_history']) {
    await db.query('INSERT INTO public.system_configs (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
      [key, '{"secret":"obsolete-not-exported"}']);
  }
  const job = await begin();
  assert.deepEqual(job.catalog.excluded_system_keys, ['auto_cleanup_history', 'auto_cleanup_schedule', 'ios_config']);
  const exported = await table(job, 'system_configs');
  assert.doesNotMatch(exported.text, /obsolete-not-exported|description|created_at/);
  assert.ok(exported.rows.every(row => ['login_title', 'login_subtitle', 'admin_navigation_preferences',
    'announcement_carousel_enabled', 'announcement_carousel_speed'].includes(row.key)));
}));

test('byte caps split pages before the row cap and reject oversized rows or shared totals', async () => transaction(async () => {
  await db.query(`INSERT INTO public.admin_groups (name, created_by)
    SELECT repeat('x', 10000) || number, $1 FROM generate_series(1, 40) AS number`, [NEW.root]);
  const job = await begin();
  const first = await page(job, 'admin_groups');
  assert.ok(first.count > 0 && first.count < 40);
  assert.ok(first.next_after);
  assert.ok(Buffer.byteLength(first.ndjson) <= 262144);
  assert.equal((await table(job, 'admin_groups')).rows.length, 40);
  await rpc(db, 'employee_transfer_cancel', auth(job));
  await db.query(`INSERT INTO public.admin_groups (name, created_by) VALUES (repeat('y', 65536), $1)`, [NEW.root]);
  await assert.rejects(begin(), /size limit/);
}));

test('source mutations after begin and missing staged data cannot be marked verified', async () => transaction(async () => {
  const job = await begin();
  await db.query("DELETE FROM private.employee_transfer_staging WHERE job_id = $1 AND table_key = 'shared:admin_groups'", [job.job_id]);
  await assert.rejects(page(job, 'admin_groups'), /snapshot is missing/);
  await assert.rejects(rpc(db, 'employee_export_shared_verify', auth(job)), /source data changed/);
}));

test('cancel/expired sessions/expired tasks revoke access and cancellation clears sensitive snapshots', async () => transaction(async () => {
  let job = await begin();
  await db.query("UPDATE private.employee_transfer_jobs SET last_activity_at = now() - interval '4 hours' WHERE id = $1", [job.job_id]);
  await assert.rejects(page(job, 'admins'), /invalid or expired/);
  await rpc(db, 'employee_transfer_cancel', auth(job));
  job = await begin();
  await rpc(db, 'employee_transfer_cancel', auth(job));
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id = $1', [job.job_id]), 0);
  await assert.rejects(page(job, 'admins'), /invalid or expired/);
  job = await begin();
  await db.query('UPDATE public.admin_financial_sessions SET expires_at = now() - interval \'1 minute\' WHERE admin_id = $1', [NEW.root]);
  await assert.rejects(page(job, 'admins'), /session is invalid or expired/);
}));

test('all shared capture helpers share one STABLE query snapshot rather than advancing snapshots between tables', async () => transaction(async () => {
  for (const signature of ['employee_transfer_shared_validate()', 'employee_transfer_shared_rows(text)',
    'employee_transfer_shared_snapshot(text)', 'employee_transfer_shared_capture()']) {
    assert.equal(await scalar(db, 'SELECT provolatile FROM pg_proc WHERE oid = to_regprocedure($1)', [`private.${signature}`]), 's');
  }
  const capture = await scalar(db, 'SELECT private.employee_transfer_shared_capture()');
  assert.deepEqual(Object.keys(capture).sort(), [...keys].sort());
  const job = await begin();
  for (const key of keys) {
    const descriptor = job.catalog.tables.find(item => item.key === key);
    assert.equal(descriptor.sha256, capture[key].sha256);
    assert.equal(descriptor.bytes, capture[key].bytes);
    assert.equal(descriptor.rows, capture[key].count);
  }
}));

test('shared row and byte limits reject oversized settings before a task or sensitive staging can commit', async () => transaction(async () => {
  await db.query(`INSERT INTO public.admin_groups (name, created_by)
    SELECT repeat('x', 61000) || number, $1 FROM generate_series(1, 140) AS number`, [NEW.root]);
  await assert.rejects(begin(), /size limit/);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status = 'running'"), 0);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging'), 0);
}));

test('the fixed shared table row bound is enforced independently of the total byte bound', async () => transaction(async () => {
  await db.query(`INSERT INTO public.admin_groups (name, created_by)
    SELECT 'group-' || number, $1 FROM generate_series(1, 10001) AS number`, [NEW.root]);
  await assert.rejects(begin(), /row limit/);
}));

test('shared credentials require their own protocol and cannot be exposed by an old employee-only task', async () => transaction(async () => {
  const legacy = await rpc(db, 'employee_export_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  await assert.rejects(page(legacy, 'financial_admin_credentials'), /not a shared settings export/);
  await assert.rejects(rpc(db, 'get_employee_export_shared_catalog', auth(legacy)), /not a shared settings export/);
  await assert.rejects(rpc(db, 'employee_export_shared_verify', auth(legacy)), /not a shared settings export/);
}));
