import assert from 'node:assert/strict';
import { after, before, mock, test as registerTest } from 'node:test';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { access, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { createSites, adminLogin, rpc as baseRpc, rows, scalar } from './support/transfer-harness.mjs';
import { EXPECTED_REPLAY_FAILURES } from './support/replay-migrations.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Only this NEW mapped-verification file is written. Real SQL replay, source exports, independent disk
// AES/ZIP backups and SQL48/49/50/51/52 RPCs establish ALL positive prerequisites.
// Most media tuples are explicitly SYNTHETIC offline service receipts, not proof of Storage bytes.
// One additional real-handler/fakeStorage case hashes actual magic-byte fixtures but is NOT real Storage acceptance.
// Source verification is seeded BEFORE every catalog capture (including the identity binding).
// Direct postgres changes are local business fixtures or explicitly negative corruption.
// No production network, manufactured jobs/maps/verified summaries or backup proof.
// PGlite is not native PostgreSQL concurrency, PostgREST, Storage or capacity acceptance.
// Optional, explicit grouping for slow PGlite scans. No range = the whole file.
// e.g. EMPLOYEE_MAPPED_VERIFICATION_DB_RANGE=1-20 / 21-40 / 41-58, separately.
// node --test supabase/tests/employee-transfer-mapped-verification-db.test.mjs
// No SQL is skipped: every group still performs the complete strict replay and prerequisites.
const rangeText = process.env.EMPLOYEE_MAPPED_VERIFICATION_DB_RANGE;
let range = null, caseNo = 0, selectedCases = 0;
if (rangeText !== undefined) {
  assert.match(rangeText, /^[1-9][0-9]*-[1-9][0-9]*$/);
  range = rangeText.split('-').map(Number);
  assert.ok(range.every(Number.isSafeInteger) && range[0] <= range[1]);
  console.log(`Explicit SQL53 test selection ${rangeText}; excluded cases are NOT counted as passed.`);
}
function test(name, fn) {
  caseNo++;
  if (range && (caseNo < range[0] || caseNo > range[1])) return;
  selectedCases++; return registerTest(name, fn);
}
const MIGRATION = '20261102000053_restore_mapped_employee_verification.sql';
const PREFIX = 'employee_import_mapped_verification_';
const OPERATIONS = ['bind', 'stage', 'plan', 'begin', 'apply', 'status', 'verify'];
const FINANCE = ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit'];
const ACTIVITY = ['employee_login_history', 'work_sessions', 'work_stop_markers'];
const VERIFICATION = ['verification_requests'];
const RELATIONS = { employee_login_history: 'public.employee_login_history', work_sessions: 'public.work_sessions', work_stop_markers: 'private.employee_work_stop_markers' };
const TABLES = {
  shared: ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'],
  dispatch: ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'],
  identity: ['accounts', 'credentials', 'orders'], finance: FINANCE, activity: ACTIVITY, verification: VERIFICATION,
};
const ZERO = '00000000-0000-0000-0000-000000000000';
const STATE = 'mapped-verification-v1';
const DONE = 'mapped-verification-done-v1';
const GATES = ['can_restore', 'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete'];
const COMMON = ['scope', 'job_id', 'site_id', 'source_site_id', 'package_id', 'catalog_hash', 'mapping_hash', 'plan_hash',
  'totals', 'employees', 'maintenance', 'dependencies_pending', 'financial_data_pending', ...GATES];
// Load the production conflict allowlist, rather than inventing SQL53-only reasons.
let CONFLICTS;
const id = n => `53000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const S = { one: id(1), two: id(2), branch: id(3), group: id(4), product: id(5), unknownAdmin: id(6),
  memberOne: id(10), memberTwo: id(11), validMax: id(20), validNull: id(21), validSmall: id(22),
  tx: id(500), manual: id(501), pending: id(600), pendingExtra: id(601), pendingTwo: id(602),
  cursor: '9007199254740993', after: '9007199254740994', audit: '9007199254740999', unrelated: id(999) };
const EMPLOYEES = [S.one, S.two];
const OWNERS = [S.one, S.two, S.one, S.two];
const USERNAMES = { [S.one]: 'mapped-verification-one', [S.two]: 'mapped-verification-legacy' };
const PRECISE = '12345678901234567890.1234567890123456789';
const PENDING = '3.12345678901234567890123456789';
const AVAILABLE = '101.12345678901234567890123456789';
const TIME = '2030-03-04T05:06:07.654321Z';
const sha = text => createHash('sha256').update(text).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
function chunks(text, size = 200) {
  const result = []; let part = '', n = 0;
  for (const line of lines(text)) {
    if (n === size || Buffer.byteLength(part + line) > 262144) { result.push(part); part = ''; n = 0; }
    part += line; n++;
  }
  if (part || !result.length) result.push(part);
  return result;
}
let source, db, session, sourceSession, branch, emergency, other, pkg, task, sharedTask;
let identity, dispatch, shared, finance, activity, verification, modules, bindings, sharedDump, preFinanceDump, preActivityDump, readyDump, readyTask, replay;
let counter = 0;
const auth = (job = task, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
async function on(site, name, args, role = 'anon') {
  const point = `mapped_verification_${++counter}`;
  await site.exec(`SAVEPOINT ${point}`);
  try {
    await site.exec(`SET LOCAL ROLE ${role}`);
    const value = await baseRpc(site, name, args, { role: null });
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`);
    return value;
  } catch (error) {
    await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
    throw error;
  }
}
const rpc = (name, args, role) => on(db, name, args, role);
const call = (key, extra = {}, role = 'anon') => rpc(PREFIX + key, { ...auth(), ...extra }, role);
const bind = (input = verification, extra = {}, role) => call('bind', { p_catalog: input.catalog, ...extra }, role);
const stageChunk = (key, no, text, extra = {}, role) => call('stage', { p_table_key: key, p_chunk_no: no, p_ndjson: text, ...extra }, role);
const plan = (extra = {}, role) => call('plan', extra, role);
const status = (sourceId = null, extra = {}, role) => call('status', { p_source_id: sourceId, ...extra }, role);
const begin = (p, extra = {}, role) => call('begin', { p_plan_hash: p.plan_hash, ...extra }, role);
const apply = (p, sourceId = S.one, extra = {}, role) => call('apply', { p_source_id: sourceId, p_plan_hash: p.plan_hash, ...extra }, role);
const verify = (extra = {}, role) => call('verify', extra, role);
const argsFor = (op, p) => op === 'bind' ? { p_catalog: verification.catalog }
  : op === 'stage' ? { p_table_key: 'verification_requests', p_chunk_no: 0, p_ndjson: chunks(verification.texts.verification_requests)[0] }
    : op === 'begin' ? { p_plan_hash: p.plan_hash } : op === 'apply' ? { p_source_id: S.one, p_plan_hash: p.plan_hash }
      : op === 'status' ? { p_source_id: null } : {};
const summary = () => scalar(db, 'SELECT summary FROM private.employee_transfer_jobs WHERE id=$1', [task.job_id]);
const permits = () => scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits');
async function transaction(fn, site = db, commit = false) {
  await site.exec('BEGIN');
  try { const result = await fn(); await site.exec(commit ? 'COMMIT' : 'ROLLBACK'); return result; }
  catch (error) { await site.exec('ROLLBACK'); throw error; }
}
async function clone(dump) {
  const site = new PGlite({ loadDataDir: dump, extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await site.waitReady; return site;
}
async function withClone(dump, job, fn) {
  const previous = { db, task, bindings }; const site = await clone(dump); db = site; task = job;
  try { return await fn(); }
  finally { db = previous.db; task = previous.task; bindings = previous.bindings; await site.close(); }
}
async function capture(kind) {
  console.log(`SQL53 setup: capture ${kind}`);
  const job = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession,
    p_admin_password: PASSWORDS.root, ...['identity', 'finance', 'activity', 'verification'].includes(kind) ? { p_package_id: pkg } : {} });
  assert.equal(job.success, true);
  const texts = {};
  for (const key of TABLES[kind]) {
    texts[key] = ''; let after = null;
    do {
      const page = await on(source, `get_employee_export_${kind}_page`, { ...auth(job, sourceSession), p_table_key: key, p_after: after, p_limit: 1 });
      assert.equal(page.sha256, sha(page.ndjson)); texts[key] += page.ndjson; after = page.next_after;
    } while (after !== null);
  }
  const files = kind === 'verification' ? syntheticMedia(texts.verification_requests) : undefined;
  if (files) {
    await sourceMedia(job, files, 'download');
    await sourceMedia(job, files, 'recheck-export');
  }
  assert.equal((await on(source, `employee_export_${kind}_verify`, auth(job, sourceSession))).verified, true);
  await on(source, kind === 'shared' ? 'employee_transfer_cancel' : `employee_export_${kind}_close`, auth(job, sourceSession));
  return { catalog: job.catalog, texts, ...(files ? { files } : {}) };
}
async function* readDisk(path) {
  const handle = await open(path, 'r');
  try { const bytes = Buffer.alloc(65521); for (;;) { const part = await handle.read(bytes); if (!part.bytesRead) return; yield bytes.subarray(0, part.bytesRead); } }
  finally { await handle.close(); }
}
async function prepare(kind, input) {
  const job = await rpc(kind === 'shared' ? 'employee_import_shared_replace_begin' : 'employee_import_dispatch_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: pkg, p_catalog: input.catalog,
  });
  for (const key of TABLES[kind]) for (const [no, text] of chunks(input.texts[key], 2).entries())
    await rpc(`employee_import_${kind}_stage`, { ...auth(job), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  const p = await rpc(kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', auth(job));
  const descriptor = await rpc(`get_employee_import_${kind}_backup`, auth(job));
  const dir = await mkdtemp(join(tmpdir(), 'employee-mapped-verification-')), path = join(dir, 'independent.edx'), plain = new Map();
  let opens = 0;
  try {
    const result = await (kind === 'shared' ? modules.createReplacementBackup : modules.createDispatchBackup)(descriptor, {
      async catalog() { return (await rpc(`get_employee_import_${kind}_backup`, auth(job))).catalog; },
      page(key, after) { return rpc(`get_employee_import_${kind}_backup_page`, { ...auth(job), p_table_key: key, p_after: after, p_limit: 200 }); },
      async verify() {
        // No standalone backup verify RPC; compare a fresh complete SQL descriptor.
        assert.deepEqual(await rpc(`get_employee_import_${kind}_backup`, auth(job)), descriptor);
        return { verified: true, scope: kind === 'shared' ? 'shared-settings' : 'dispatch-submission', full_site_complete: false };
      },
    }, {
      async append(name, bytes) { plain.set(name, [...plain.get(name) ?? [], Buffer.from(bytes)]); },
      open(name) { return (async function* () { yield* plain.get(name) ?? []; })(); }, async abort() { plain.clear(); },
    }, {
      async write(stream) { const handle = await open(path, 'wx'); try { for await (const bytes of stream) await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } },
      open() { opens++; return readDisk(path); },
    }, {
      append(no, hex) { assert.equal(opens, 2); return rpc(`employee_import_${kind}_backup_append`, { ...auth(job), p_plan_hash: p.plan_hash, p_chunk_no: no, p_hex: hex }); },
      seal(hash, bytes) { return rpc(`employee_import_${kind}_backup_seal`, { ...auth(job), p_plan_hash: p.plan_hash, p_sha256: hash, p_bytes: bytes }); },
    }, 'local-mapped-verification-independent-backup-passphrase');
    assert.equal(result.sealReceipt.success, true); assert.equal(plain.size, 0); assert.equal(opens, 2);
    assert.equal(await scalar(db, 'SELECT sealed_at IS NOT NULL FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), true);
    return { job, plan: p };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function configure(input) {
  const prepared = await prepare('dispatch', input); task = prepared.job;
  await rpc('employee_import_dispatch_enter_maintenance', { ...auth(), p_plan_hash: prepared.plan.plan_hash,
    p_confirmation: '確認暫停業務並導入派單資料', p_admin_password: PASSWORDS.root });
  const p = await rpc('get_employee_import_dispatch_configuration_plan', auth());
  assert.equal((await rpc('employee_import_dispatch_apply_configuration', { ...auth(), p_plan_hash: p.plan_hash })).configuration_applied, true);
}
async function restoreValid() {
  const config = (await summary()).dispatch_config_plan;
  const started = await rpc('employee_import_dispatch_valid_begin', { ...auth(), p_plan_hash: config.plan_hash });
  for (let no = 0; no < started.chunks; no++) await rpc('employee_import_dispatch_valid_chunk', { ...auth(), p_chunk_no: no });
  assert.equal((await rpc('employee_import_dispatch_valid_verify', auth())).verified, true);
}
async function restoreIdentities(input = identity, employees = EMPLOYEES, { incomplete = null, omit = null } = {}) {
  await rpc('employee_import_identity_bind', { ...auth(), p_catalog: input.catalog });
  for (const key of TABLES.identity) for (const [no, text] of chunks(input.texts[key], 2).entries())
    await rpc('employee_import_identity_stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  bindings = {};
  for (const sourceId of employees) {
    const observed = await rpc('employee_import_identity_reservation_status', { ...auth(), p_source_id: sourceId });
    assert.equal(observed.reservation, null);
    const r = await rpc('employee_import_identity_reserve', { ...auth(), p_source_id: sourceId,
      p_source_fingerprint: observed.observed.source_fingerprint, p_target_fingerprint: observed.observed.target_fingerprint });
    assert.equal(r.candidate_available, true); assert.equal(r.source_unchanged, true); assert.equal(r.target_unchanged, true);
    bindings[sourceId] = r.reservation; assert.notEqual(r.reservation.target_id, sourceId);
  }
  for (const sourceId of employees) {
    if (sourceId === omit) continue;
    const p = await rpc('employee_import_mapped_identity_plan', { ...auth(), p_source_id: sourceId });
    assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
    await rpc('employee_import_mapped_identity_core', { ...auth(), p_source_id: sourceId, p_plan_hash: p.plan_hash });
    for (let no = 0; no < p.order_chunks; no++) await rpc('employee_import_mapped_identity_orders', { ...auth(), p_source_id: sourceId, p_chunk_no: no });
    if (sourceId !== incomplete) assert.equal((await rpc('employee_import_mapped_identity_verify', { ...auth(), p_source_id: sourceId })).verified, true);
  }
}
async function restoreDependencies({ incomplete = false } = {}) {
  const p = await rpc('employee_import_mapped_dependency_plan', auth()); assert.equal(p.can_begin, true);
  await rpc('employee_import_mapped_dependency_begin', { ...auth(), p_plan_hash: p.plan_hash });
  for (const key of ['dispatch_group_members', 'used_order_data']) for (let no = 0; no < p.chunks[key]; no++)
    await rpc('employee_import_mapped_dependency_chunk', { ...auth(), p_table_key: key, p_chunk_no: no });
  if (!incomplete) assert.equal((await rpc('employee_import_mapped_dependency_verify', auth())).verified, true);
}
// Explicitly local business setup/negative tampering. Restore EVERY original mode.
async function change(relation, sql, params = [], site = db) {
  const modes = await rows(site, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
  for (const t of modes) await site.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
  const point = `local_change_${++counter}`; let isolated = false;
  try { await site.exec(`SAVEPOINT ${point}`); isolated = true; } catch (error) { if (error.code !== '25P01') throw error; }
  try { await site.query(sql, params); }
  catch (error) { if (isolated) await site.exec(`ROLLBACK TO SAVEPOINT ${point}`); throw error; }
  finally { if (isolated) await site.exec(`RELEASE SAVEPOINT ${point}`); for (const t of modes) await site.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`); }
}
async function snapshot(site = db) {
  const names = (await rows(site, `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') ORDER BY 1`)).map(r => r.name);
  return rows(site, names.map(name => `SELECT '${name}' AS name,count(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} AS r`).join(' UNION ALL '));
}
async function unrelatedEmployee() {
  await change('public.users', `INSERT INTO public.users(id,username,password_hash,employee_id,created_by,is_active)
    VALUES($1,'unrelated-verification-target','local-only','MF-UNRELATED',$2,false)`, [S.unrelated, NEW.root]);
}
const business = () => snapshot().then(all => all.filter(r => r.name.startsWith('public.') || !r.name.startsWith('private.employee_transfer_')));
const triggers = () => rows(db, `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') ORDER BY 1,2,3`);
async function isolated(fn) {
  const point = `negative_verification_${++counter}`; await db.exec(`SAVEPOINT ${point}`);
  try { return await fn(); } finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
}
function counts(value) {
  assert.deepEqual(Object.keys(value).sort(), [...VERIFICATION].sort());
  for (const n of Object.values(value)) assert.ok(Number.isSafeInteger(n) && n >= 0);
}
function common(value, p = null) {
  const isPlan = Object.hasOwn(value, 'can_begin');
  assert.deepEqual(Object.keys(value).sort(), [...COMMON, ...isPlan ? ['can_begin', 'conflicts'] : ['started', 'completed_employees', 'verified', 'employee']].sort());
  assert.equal(value.scope, 'employee-mapped-verification'); assert.equal(value.job_id, task.job_id);
  assert.equal(value.package_id, pkg); assert.equal(value.source_site_id, verification.catalog.site_id);
  for (const key of ['job_id', 'site_id', 'source_site_id', 'package_id']) assert.match(value[key], /^[0-9a-f-]{36}$/);
  for (const key of ['catalog_hash', 'mapping_hash', 'plan_hash']) assert.match(value[key], /^[0-9a-f]{64}$/);
  for (const key of ['maintenance', 'dependencies_pending', 'financial_data_pending']) assert.equal(value[key], true);
  for (const key of GATES) assert.equal(value[key], false, key);
  counts(value.totals); assert.ok(Number.isSafeInteger(value.employees) && value.employees >= 0);
  if (p) for (const key of COMMON) assert.deepEqual(value[key], p[key], key);
  if (isPlan) {
    assert.ok(Array.isArray(value.conflicts)); assert.equal(new Set(value.conflicts).size, value.conflicts.length);
    for (const reason of value.conflicts) assert.ok(CONFLICTS.includes(reason), reason);
    assert.equal(value.can_begin, value.conflicts.length === 0);
  } else {
    assert.equal(typeof value.started, 'boolean'); assert.equal(typeof value.verified, 'boolean');
    assert.ok(Number.isSafeInteger(value.completed_employees) && value.completed_employees >= 0 && value.completed_employees <= value.employees);
    if (value.employee !== null) {
      assert.deepEqual(Object.keys(value.employee).sort(), ['source_id', 'target_id', 'applied', 'counts'].sort());
      assert.equal(value.employee.target_id, bindings[value.employee.source_id].target_id);
      assert.equal(typeof value.employee.applied, 'boolean'); counts(value.employee.counts);
    }
  }
  assert.doesNotMatch(JSON.stringify(value), /password|session_token|job_token|identity_map|admin_map/);
}
async function stage(input = verification, role = 'anon', media = true) {
  const r = await bind(input, {}, role);
  assert.deepEqual(Object.keys(r).sort(), ['success', 'scope', 'catalog_hash', 'full_site_complete'].sort());
  assert.equal(r.success, true); assert.equal(r.scope, 'employee-mapped-verification'); assert.equal(r.full_site_complete, false);
  assert.match(r.catalog_hash, /^[0-9a-f]{64}$/);
  for (const key of VERIFICATION) for (const [no, text] of chunks(input.texts[key]).entries()) {
    assert.deepEqual(await stageChunk(key, no, text, {}, role), { success: true, scope: 'employee-mapped-verification', table_key: key, chunk_no: no,
      rows: lines(text).length, bytes: Buffer.byteLength(text), sha256: sha(text), full_site_complete: false });
  }
  if (media) { await mediaBind(input.files, {}, role); await commitMedia(input.files, 'upload'); }
  const p = await plan({}, role); common(p); assert.equal(p.catalog_hash, r.catalog_hash); return p;
}
async function finish(p, employees = EMPLOYEES, role = 'anon') {
  await begin(p, {}, role);
  for (const sourceId of employees) { const r = await apply(p, sourceId, {}, role); common(r, p); assert.equal(r.employee.applied, true); }
  await commitMedia(verification.files, 'recheck-import');
  const result = await verify({}, role); common(result, p); assert.equal(result.verified, true); return result;
}
async function restoreFinance({ applied = EMPLOYEES, verified = true } = {}) {
  const prefix = 'employee_import_mapped_finance_';
  await rpc(prefix + 'bind', { ...auth(), p_catalog: finance.catalog });
  for (const key of FINANCE) for (const [no, text] of chunks(finance.texts[key], 2).entries())
    await rpc(prefix + 'stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  const p = await rpc(prefix + 'plan', auth()); assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
  await rpc(prefix + 'begin', { ...auth(), p_plan_hash: p.plan_hash });
  for (const sourceId of applied) assert.equal((await rpc(prefix + 'apply', { ...auth(), p_source_id: sourceId, p_plan_hash: p.plan_hash })).employee.applied, true);
  if (verified) assert.equal((await rpc(prefix + 'verify', auth())).verified, true);
}
async function noLegacy() {
  const s = await summary();
  for (const key of ['identity_restore', 'dependency_restore', 'verified_identity_map', 'finance_catalog', 'finance_plan', 'finance_restore', 'activity_catalog', 'activity_plan', 'activity_restore', 'verification_catalog', 'verification_plan', 'verification_restore', 'verification_media_files', 'verification_storage_origin']) assert.equal(s[key], undefined, key);
  assert.equal(await permits(), 0);
}
async function denyAll(p, extra = {}, pattern, operations = OPERATIONS) {
  const frozen = await snapshot(), modes = await triggers();
  for (const role of ['anon', 'authenticated']) {
    for (const op of operations) await assert.rejects(call(op, { ...argsFor(op, p), ...extra }, role), pattern);
    await assert.rejects(inventory(extra, role), pattern);
    await assert.rejects(mediaBind(verification.files, extra, role), pattern);
  }
  await assert.rejects(authorize('upload', verification.files[0].key, extra), pattern);
  await assert.rejects(mediaCommit('upload', verification.files[0], { p_generation: '0', ...extra }), pattern);
  assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.equal(await permits(), 0);
}

const SOURCE_ORIGIN = 'https://source.supabase.co';
const TARGET_ORIGIN = 'https://target.supabase.co';
const MEDIA_PREFIX = '/storage/v1/object/public/verification-documents';
const MEDIA_INVENTORY = 'get_employee_transfer_mapped_verification_media';
const MEDIA_AUTH = 'employee_transfer_mapped_verification_media_authorize';
const MEDIA_COMMIT = 'employee_transfer_mapped_verification_media_commit';
const MEDIA_SCOPE = 'employee-mapped-verification-media';
const FIELDS = ['id', 'user_id', 'real_name', 'wallet_address', 'phone', 'email', 'status', 'audit_remark',
  'audited_by', 'audited_at', 'created_at', 'updated_at', 'id_front_url', 'id_back_url', 'selfie_url'];
const URL_FIELDS = ['id_front_url', 'id_back_url', 'selfie_url'];
const V = { first: id(4001), second: id(4204), residual: id(4999) };
// SYNTHETIC SQL protocol receipts only: no HTTP, byte decoding, real upload/readback or Storage claim.
// Submit these only through the real service-role authorize/commit functions, NEVER private DML.
function syntheticMedia(text) {
  const urls = new Set();
  for (const line of lines(text)) for (const field of URL_FIELDS) {
    const url = JSON.parse(line)[field]; if (url !== null) urls.add(url);
  }
  return [...urls].map(source_url => {
    const bytes = Buffer.from(`synthetic-offline-only:${source_url}`);
    return { key: sha(source_url), source_url, bytes: bytes.length, sha256: sha(bytes),
      content_type: source_url.endsWith('.jpg') ? 'image/jpeg' : source_url.endsWith('.png') ? 'image/png' : 'application/pdf' };
  }).sort((a, b) => a.key.localeCompare(b.key));
}
async function sourceMedia(job, files, action) {
  // Capture old export media through ORIGINAL SQL22 service receipts before export verify/close.
  for (const file of files) {
    const context = await on(source, 'employee_transfer_verification_media_authorize', {
      ...auth(job, sourceSession), p_action: action, p_object_key: file.key }, 'service_role');
    assert.equal(context.direction, 'export'); assert.equal(context.generation, 'export');
    assert.equal(context.path, file.source_url.split(MEDIA_PREFIX + '/')[1]);
    const r = await on(source, 'employee_transfer_verification_media_commit', { ...auth(job, sourceSession),
      p_action: action, p_object_key: file.key, p_bytes: file.bytes, p_sha256: file.sha256,
      p_content_type: file.content_type, p_storage_origin: SOURCE_ORIGIN, p_generation: context.generation }, 'service_role');
    assert.deepEqual(r, { success: true, key: file.key, bytes: file.bytes, sha256: file.sha256,
      content_type: file.content_type, full_site_complete: false });
  }
}
const inventory = (extra = {}, role = 'anon') => rpc(MEDIA_INVENTORY, { ...auth(), ...extra }, role);
const mediaBind = (files = verification.files, extra = {}, role = 'anon') => call('media_bind', { p_files: files, ...extra }, role);
const authorize = (action = 'upload', key = verification.files[0].key, extra = {}, role = 'service_role') =>
  rpc(MEDIA_AUTH, { ...auth(), p_action: action, p_object_key: key, ...extra }, role);
async function mediaCommit(action, file = verification.files[0], extra = {}, role = 'service_role') {
  const generation = Object.hasOwn(extra, 'p_generation') ? extra.p_generation : (await authorize(action, file.key)).generation;
  return rpc(MEDIA_COMMIT, { ...auth(), p_action: action, p_object_key: file.key, p_bytes: file.bytes,
    p_sha256: file.sha256, p_content_type: file.content_type, p_storage_origin: TARGET_ORIGIN, p_generation: generation, ...extra }, role);
}
function targetPath(file) {
  const original = file.source_url.split(MEDIA_PREFIX + '/')[1], [folder, name] = original.split('/');
  const sourceId = name.slice(0, 36), targetId = bindings[sourceId].target_id;
  return `${folder}/${targetId}-transfer-${sha(`${task.job_id}:${file.key}`).slice(0, 32)}.${name.split('.').at(-1).toLowerCase()}`;
}
async function commitMedia(files = verification.files, action = 'upload') {
  for (const file of files) {
    const context = await authorize(action, file.key);
    assert.deepEqual(Object.keys(context).sort(), ['direction', 'key', 'bucket', 'path', 'source_url', 'file', 'generation', 'source_id', 'target_id'].sort());
    const sourceId = file.source_url.split(MEDIA_PREFIX + '/')[1].split('/')[1].slice(0, 36);
    assert.equal(context.direction, 'import'); assert.equal(context.key, file.key); assert.equal(context.bucket, 'verification-documents');
    assert.equal(context.source_url, file.source_url); assert.equal(context.source_id, sourceId);
    assert.equal(context.target_id, bindings[sourceId].target_id); assert.equal(context.path, targetPath(file));
    assert.deepEqual(context.file, file); assert.equal(context.generation, String((await status()).completed_employees));
    const r = await mediaCommit(action, file, { p_generation: context.generation });
    assert.deepEqual(r, { success: true, key: file.key, bytes: file.bytes, sha256: file.sha256,
      content_type: file.content_type, full_site_complete: false });
  }
}
async function restoreActivity({ applied = EMPLOYEES, verified = true } = {}) {
  const prefix = 'employee_import_mapped_activity_';
  await rpc(prefix + 'bind', { ...auth(), p_catalog: activity.catalog });
  for (const key of ACTIVITY) for (const [no, text] of chunks(activity.texts[key], 2).entries())
    await rpc(prefix + 'stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  const p = await rpc(prefix + 'plan', auth()); assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
  await rpc(prefix + 'begin', { ...auth(), p_plan_hash: p.plan_hash });
  for (const sourceId of applied) assert.equal((await rpc(prefix + 'apply', { ...auth(), p_source_id: sourceId, p_plan_hash: p.plan_hash })).employee.applied, true);
  if (verified) assert.equal((await rpc(prefix + 'verify', auth())).verified, true);
}
async function seedVerification() {
  // Real local source rows, with normal verification protections enabled, BEFORE identity captures.
  // Approved/rejected/pending requests must NOT recompute the independently stored is_verified flag.
  await source.query('UPDATE public.users SET is_verified=(id=$1) WHERE id=ANY($2::uuid[])', [S.two, EMPLOYEES]);
  await source.query(`INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status,audit_remark,audited_by,audited_at,created_at,updated_at,id_front_url,id_back_url,selfie_url)
    SELECT ('53000000-0000-4000-8000-'||lpad(to_hex(4000+n),12,'0'))::uuid,
      CASE WHEN n<=203 THEN $1::uuid ELSE $2::uuid END,
      E'合成姓名𠮷 é é \\n"測試"',E'ID-純虛構-\\t'||n::text,'+000-synthetic',E'地址𠮷\\n無真實個資',
      CASE n%3 WHEN 0 THEN 'pending' WHEN 1 THEN 'approved' ELSE 'rejected' END,
      CASE WHEN n%3=0 THEN NULL ELSE E'審閱𠮷\\n"原文"\\t' END,
      CASE n%3 WHEN 0 THEN NULL WHEN 1 THEN $3::uuid ELSE $4::uuid END,
      CASE WHEN n%3=0 THEN NULL ELSE '2022-02-03T04:05:06.123456Z'::timestamptz END,
      CASE WHEN n%5=0 THEN NULL ELSE '2020-01-02T03:04:05.654321Z'::timestamptz END,
      CASE WHEN n%7=0 THEN NULL ELSE '2023-04-05T06:07:08.000001Z'::timestamptz END,
      CASE WHEN n%4=0 THEN NULL ELSE $5||'/id-front/'||(CASE WHEN n<=203 THEN $1 ELSE $2 END)::text||'-synthetic.jpg' END,
      CASE WHEN n%4=1 THEN NULL ELSE $5||'/id-back/'||(CASE WHEN n<=203 THEN $1 ELSE $2 END)::text||'-synthetic.png' END,
      CASE WHEN n%4=2 THEN NULL ELSE $5||'/selfie/'||(CASE WHEN n<=203 THEN $1 ELSE $2 END)::text||'-synthetic.pdf' END
    FROM generate_series(1,205) AS x(n)`, [S.one, S.two, NEW.root, S.branch, SOURCE_ORIGIN + MEDIA_PREFIX]);
}
async function assertVerification(originalText = verification.texts.verification_requests, employees = EMPLOYEES) {
  // Independent expectation: fixed 15 source fields, only employee/admin/URL remaps. No SQL53 helpers.
  const original = lines(originalText).map(line => JSON.parse(line));
  for (const sourceId of employees) {
    const targetId = bindings[sourceId].target_id;
    const wanted = original.filter(r => r.user_id === sourceId).map(row => {
      assert.deepEqual(Object.keys(row).sort(), [...FIELDS].sort());
      const r = { ...row, user_id: targetId, audited_by: row.audited_by === null ? null : row.audited_by === S.branch ? NEW.branch : NEW.root };
      for (const field of URL_FIELDS) if (r[field] !== null) r[field] = TARGET_ORIGIN + MEDIA_PREFIX + '/' + targetPath({ source_url: r[field], key: sha(r[field]) });
      return r;
    });
    const actual = await rows(db, 'SELECT to_jsonb(r)::text AS body FROM public.verification_requests r WHERE user_id=$1 ORDER BY id', [targetId]);
    assert.deepEqual(actual.map(r => JSON.parse(r.body)), wanted);
    assert.equal(await scalar(db, 'SELECT count(*)::integer FROM public.verification_requests WHERE user_id=$1', [sourceId]), 0);
  }
}
async function sourceVariant(mutate, run) {
  const input = await transaction(async () => { await mutate(); return capture('verification'); }, source);
  assert.deepEqual(input.catalog.identity_catalog, identity.catalog, 'Source variant must not silently change identity prerequisites');
  const previous = verification; verification = input;
  try { return await transaction(() => run(input)); } finally { verification = previous; }
}
// NEGATIVE input only: self-consistent wire catalog with malicious/invalid source rows; never positive proof.
function adversarialInput(transform) {
  const text = lines(verification.texts.verification_requests).map((line, n) => JSON.stringify(transform(JSON.parse(line), n)) + '\n').join('');
  return { texts: { verification_requests: text }, files: syntheticMedia(text), catalog: { ...verification.catalog,
    tables: [{ key: 'verification_requests', rows: lines(text).length, bytes: Buffer.byteLength(text), row_hashes_sha256: sha(lines(text).map(sha).join('')) }] } };
}

async function seedActivity() {
  // Deliberately inconsistent historical duration/heartbeat values are legal original rows.
  // Only source business fixture triggers are temporarily bypassed; never fabricate transfer state.
  await change('public.employee_login_history', `INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,ip_address,user_agent,session_id,created_at,device_info)
    SELECT ('53000000-0000-4000-8000-'||lpad(to_hex(1000+n),12,'0'))::uuid,CASE WHEN n=7 THEN $2::uuid ELSE $1::uuid END,
      '歷史名稱𠮷 é é','歷史員工號-0042',CASE WHEN n%2=0 THEN 'logout' ELSE 'login' END,
      CASE WHEN n=2 THEN NULL ELSE '2001:db8::1' END,CASE WHEN n=2 THEN NULL ELSE E'UA \\n{} " \\t' END,
      CASE WHEN n=2 THEN NULL ELSE 'source-live-session-never-import' END,CASE WHEN n=2 THEN NULL ELSE '2023-02-03T04:05:06.654321Z'::timestamptz END,
      CASE n WHEN 1 THEN ('{"children":[{"id":"left","precise":'||$3||'},{"id":"right"}],"nested":{"id":"device"}}')::jsonb
      WHEN 2 THEN NULL WHEN 3 THEN 'null'::jsonb WHEN 4 THEN $3::jsonb WHEN 5 THEN '"文字𠮷"'::jsonb WHEN 6 THEN '[]'::jsonb ELSE 'true'::jsonb END
    FROM generate_series(1,7) x(n)`, [S.one, S.two, PRECISE], source);
  await change('public.work_sessions', `INSERT INTO public.work_sessions(id,user_id,start_time,end_time,duration_minutes,created_at,last_heartbeat_at)
    SELECT ('53000000-0000-4000-8000-'||lpad(to_hex(2000+n),12,'0'))::uuid,CASE WHEN n=6 THEN $2::uuid ELSE $1::uuid END,
      '2023-01-01T00:00:00.123456Z'::timestamptz+n*interval '1 day',
      CASE WHEN n IN (1,6) THEN NULL ELSE '2023-01-01T00:01:30.987654Z'::timestamptz+n*interval '1 day' END,
      CASE WHEN n=5 THEN NULL ELSE 777 END,CASE WHEN n IN (2,5) THEN NULL ELSE '2020-01-02T03:04:05.654321Z'::timestamptz END,
      CASE WHEN n IN (2,5) THEN NULL WHEN n=3 THEN '2022-12-31T23:59:59.123456Z'::timestamptz+n*interval '1 day'
      WHEN n=6 THEN '2023-01-01T00:00:30.123455Z'::timestamptz+n*interval '1 day'
      ELSE '2023-01-01T00:01:30.987654Z'::timestamptz+n*interval '1 day' END FROM generate_series(1,6) x(n)`, [S.one, S.two], source);
  await change('private.employee_work_stop_markers', `INSERT INTO private.employee_work_stop_markers(user_id,stopped_at)
    VALUES($1,'2023-04-05T06:07:08.123456Z'),($2,'2024-02-29T12:34:56.654321Z')`, [S.one, S.two], source);
}

before(async () => {
  // Missing SQL53 is a hard failure, not a skip and not an invented implementation.
  await access(new URL(`../migrations/${MIGRATION}`, import.meta.url));
  for (const [module, names] of [[globalThis, ['fetch']], [http, ['request', 'get']], [https, ['request', 'get']],
    [net, ['connect', 'createConnection']], [tls, ['connect']]])
    for (const name of names) mock.method(module, name, () => assert.fail('network and production services forbidden'));
  console.log('SQL53 setup: strict replay started');
  replay = await createSites({ upTo: MIGRATION }); source = replay.oldSite; db = replay.newSite;
  console.log('SQL53 setup: strict replay completed');
  assert.equal(replay.files.at(-1), MIGRATION); assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.deepEqual(replay.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
  await buildNewSite(source); await buildNewSite(db);
  await source.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await source.query('DELETE FROM public.financial_admin_credentials WHERE admin_id=$1', [NEW.branch]);
  await source.query('UPDATE public.admins SET id=$1 WHERE id=$2', [S.branch, NEW.branch]);
  await source.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [S.branch]);
  await source.query("INSERT INTO public.dispatch_groups(id,group_name,created_by) VALUES($1,'Mapped activity source group',$2)", [S.group, S.branch]);
  for (const sourceId of EMPLOYEES) {
    await source.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,is_active,total_income,remarks,created_at)
      VALUES($1,$2,$3,extensions.crypt($4,extensions.gen_salt('bf',4)),$5,true,$6::numeric,$7,'2026-09-01T01:02:03.123456Z')`,
    [sourceId, USERNAMES[sourceId], sourceId === S.one ? 'MF-001' : 'MF-002', PASSWORDS.employee, sourceId === S.one ? NEW.root : S.branch,
      sourceId === S.one ? '32.12345678901234567890123456789' : '0', sourceId === S.one ? 'private source remark é 𠮷' : null]);
    await source.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [sourceId]);
  }
  await source.query("INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Mapped activity historical product',false)", [S.product]);
  for (const [n, owner] of OWNERS.entries()) await change('public.orders', `INSERT INTO public.orders(id,user_id,username,product_type_id,
    product_value,order_number,transaction_id,status,commission_amount,commission_rate,created_at,processed_at)
    VALUES($1,$2,$3,$4,99.9,$5,$6,$7,$8::numeric,$9::numeric,'2026-09-04T01:02:03.123456Z',$10::timestamptz)`,
  [id(100 + n), owner, USERNAMES[owner], S.product, `PRIVATE-MF-ORDER-${n}`, `PRIVATE-MF-TX-${n}`, n % 2 ? 'failure' : 'success',
    n % 2 ? null : PRECISE, n % 2 ? null : '0.1234567890123456789', n % 2 ? null : '2026-09-05T02:03:04.654321Z'], source);
  await source.query(`INSERT INTO public.dispatch_group_members(id,group_id,user_id,assigned_by,assigned_at) VALUES
    ($1,$2,$3,$4,'2021-01-02T03:04:05.123456Z'),($5,$6,$7,$8,NULL)`, [S.memberOne, NEW.groupA, S.one, NEW.root, S.memberTwo, S.group, S.two, S.branch]);
  for (const [n, valid] of [S.validMax, S.validNull, S.validSmall].entries()) await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by,usage_count,last_used_at,tags,priority)
    VALUES($1,$2::numeric,$3,$4,0,NULL,$5::text[],$6)`, [valid, PRECISE, `source-valid-é-𠮷-${n}`, n % 2 ? S.branch : NEW.root, n ? null : ['é', null, '', 'é'], n]);
  for (const [n, owner] of OWNERS.entries()) await source.query(`INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at)
    VALUES($1,$2,$3,$4,$5::timestamptz)`, [id(200 + n), owner, [S.validMax, S.validNull, S.validSmall, S.validMax][n], id(100 + n), n === 1 ? null : '2021-03-04T05:06:07.123456Z']);
  await source.query(`UPDATE public.valid_order_data SET usage_count=CASE id WHEN $1 THEN 2147483647 WHEN $2 THEN NULL ELSE 17 END,
    last_used_at=CASE id WHEN $2 THEN NULL ELSE $3::timestamptz END`, [S.validMax, S.validNull, TIME]);
  await transaction(async () => {
    await change('public.wallet_transactions', `INSERT INTO public.wallet_transactions(id,user_id,type,amount,balance_before,balance_after,reference_id,remarks,created_by,created_at,operation_id)
      VALUES($1,$2,'commission',32.12345678901234567890123456789,0,32.12345678901234567890123456789,$3,NULL,$4,'2023-02-03T04:05:06.654321Z',$5),
      ($6,$2,'manual_adjustment',1.1234567890123456789,32,33.1234567890123456789,NULL,E'來源備註\\n𠮷 é é',NULL,NULL,NULL)`, [S.tx, S.one, id(100), S.branch, id(700), S.manual], source);
    for (const [n, state, amount, owner] of [[600, 'pending', PENDING, S.one], [601, 'pending', '0.87654321098765432109876543211', S.one],
      [602, 'pending', '7.00000000000000000000000000001', S.two], [603, 'approved', '2.5', S.one], [604, 'rejected', '4.125', S.one], [605, 'cancelled', '5', S.one]])
      await change('public.withdrawals', `INSERT INTO public.withdrawals(id,user_id,amount,status,audit_remark,audited_by,audited_at,created_at,last_operation_id)
        VALUES($1,$2,$3::numeric,$4,$5,$6,$7::timestamptz,$8::timestamptz,$9)`, [id(n), owner, amount, state, n % 2 ? '原文 é 𠮷' : null,
        state === 'pending' ? null : n % 2 ? NEW.root : S.branch, n % 2 ? '2023-02-03T04:05:06.654321Z' : null,
        n % 2 ? null : '2023-02-03T04:05:06.123456Z', n % 2 ? null : id(800 + n)], source);
    await change('public.wallets', `UPDATE public.wallets SET available_balance=CASE user_id WHEN $1 THEN $2::numeric ELSE 40 END,
      frozen_balance=CASE user_id WHEN $1 THEN 4 ELSE 7.00000000000000000000000000001 END,
      created_at='2021-01-02T03:04:05.123456Z',updated_at=NULL`, [S.one, AVAILABLE], source);
    await change('public.wallet_balance_baselines', 'DELETE FROM public.wallet_balance_baselines', [], source);
    await change('public.wallet_ledger_entries', 'DELETE FROM public.wallet_ledger_entries', [], source);
    await source.query(`INSERT INTO public.wallet_ledger_entries(id,user_id,operation_id,source_type,source_id,event_type,available_delta,frozen_delta,income_delta,created_at) VALUES
      (1,$1,$3,'wallet_transaction',$4,'before',100,0,30,'2020-01-02T03:04:05.123456Z'),
      (9007199254740993,$1,$5,'wallet_transaction',$4,'at',0,0,0,'2021-01-02T03:04:05.123456Z'),
      (9007199254740994,$1,$6,'wallet_transaction',$4,'after',5.12345678901234567890123456789,0,2.12345678901234567890123456789,'2022-01-02T03:04:05.123456Z'),
      (3,$2,$7,'withdrawal',$8,'historical-withdrawal',0,0,0,'2020-01-02T03:04:05.123456Z'),
      (4,$2,$9,'wallet_transaction',$10,'deleted-historical-event',0,0,0,'2020-01-02T03:04:05.654321Z')`,
    [S.one, S.two, id(710), S.tx, id(711), id(712), id(713), S.pendingTwo, id(714), id(777)]);
    await source.query(`INSERT INTO public.wallet_balance_baselines(user_id,available_balance,frozen_balance,total_income,last_ledger_id,established_at)
      VALUES($1,100,0,30,9007199254740993,'2022-01-02T03:04:05.123456Z')`, [S.one]);
    await source.query(`INSERT INTO public.wallet_reconciliation_audit(id,user_id,available_before,available_after,frozen_before,frozen_after,income_before,income_after,pending_amount,ledger_total,reason,repaired_at)
      VALUES(9007199254740999,$1,103,$2::numeric,2,4,31,32.12345678901234567890123456789,4,105.12345678901234567890123456789,'來源對賬原因 é 𠮷','2023-03-04T05:06:07.123456Z')`, [S.one, AVAILABLE]);
  }, source, true);
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active) SELECT $1,'mapped-verification-other-root',password_hash,'super_admin',true FROM public.admins WHERE id=$2`, [id(300), NEW.root]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [id(300)]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  other = await adminLogin(db, 'mapped-verification-other-root', PASSWORDS.root); pkg = randomUUID();
  const compiled = await build({ stdin: { contents: `export {createReplacementBackup} from './src/lib/employeeTransfer/replacementBackup.ts';
    export {createDispatchBackup} from './src/lib/employeeTransfer/dispatchBackup.ts';
    export {createEmployeeMappedVerificationSession} from './src/lib/employeeTransfer/employeeMappedVerification.ts';
    export {VERIFICATION_CONFLICT_REASONS} from './src/lib/employeeTransfer/verificationTransfer.ts';
    export {createEmployeeTransferMediaHandler} from './supabase/functions/employee-transfer-media/handler.ts';
    export {setHarness} from 'mapped-verification-db:state';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', plugins: [{ name: 'local-mapped-verification-sql', setup(builder) {
      builder.onResolve({ filter: /^(?:mapped-verification-db:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'mapped-verification-db' }));
      builder.onLoad({ filter: /.*/, namespace: 'mapped-verification-db' }, ({ path }) => ({ contents: path === 'mapped-verification-db:state'
        ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
        : path === '../auth' ? 'import{current}from"mapped-verification-db:state";export const getAdminFinancialSessionToken=()=>current().token;'
          : 'import{current}from"mapped-verification-db:state";export const supabase={rpc:(name,args)=>current().rpc(name,args)};' }));
    } }] });
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  CONFLICTS = modules.VERIFICATION_CONFLICT_REASONS;
  await transaction(async () => {
    await seedActivity(); await seedVerification();
    shared = await capture('shared'); dispatch = await capture('dispatch'); identity = await capture('identity');
    finance = await capture('finance'); activity = await capture('activity'); verification = await capture('verification');
  }, source, true);
  assert.deepEqual(activity.catalog.identity_catalog, identity.catalog);
  assert.deepEqual(verification.catalog.identity_catalog, identity.catalog);
  assert.deepEqual(finance.catalog.identity_catalog, identity.catalog); assert.deepEqual(identity.catalog.tables.map(t => t.rows), [2, 2, 4]);
  await transaction(async () => {
    const prepared = await prepare('shared', shared); sharedTask = prepared.job;
    const r = await rpc('employee_import_shared_replace_apply', { ...auth(sharedTask), p_plan_hash: prepared.plan.plan_hash });
    assert.equal(r.success, true); assert.equal(r.admin_map[S.branch], NEW.branch); assert.equal(r.admin_map[NEW.root], NEW.root);
    await rpc('employee_transfer_cancel', auth(sharedTask));
  }, db, true);
  console.log('SQL53 setup: shared restore completed');
  sharedDump = await db.dumpDataDir('none');
  await transaction(() => configure(dispatch), db, true);
  await transaction(async () => { await restoreValid(); await restoreIdentities(); await restoreDependencies(); await noLegacy(); }, db, true);
  console.log('SQL53 setup: mapped identity and dependencies completed');
  readyTask = task; preFinanceDump = await db.dumpDataDir('none');
  await transaction(() => restoreFinance(), db, true);
  await transaction(() => noLegacy());
  console.log('SQL53 setup: mapped finance completed');
  preActivityDump = await db.dumpDataDir('none');
  await transaction(() => restoreActivity(), db, true);
  await transaction(() => noLegacy());
  readyDump = await db.dumpDataDir('none');
  console.log('SQL53 setup: verified mapped activity ready');
}, { timeout: 600000 });
after(async () => { await Promise.allSettled([source?.close(), db?.close()]); mock.restoreAll(); });


test('SQL53 strict replay executes migration 580 with exactly the same twelve historical failures', () => {
  assert.equal(replay.files.length, 580); assert.equal(replay.files.at(-1), MIGRATION);
  assert.deepEqual(replay.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
  assert.equal(replay.validation.freshDatabaseVerified, false);
});

test('SQL53 seven core signatures match SQL52; private helpers and STABLE reads have strict privileges', () => transaction(async () => {
  const specs = { bind: [['p_catalog', 'jsonb']], stage: [['p_table_key', 'text'], ['p_chunk_no', 'integer'], ['p_ndjson', 'text']],
    plan: [], begin: [['p_plan_hash', 'text']], apply: [['p_source_id', 'uuid'], ['p_plan_hash', 'text']], status: [['p_source_id', 'uuid']], verify: [] };
  const fns = await rows(db, `SELECT proname,provolatile,prosecdef,proconfig,proargnames,pronargdefaults,
    (SELECT array_agg(format_type(t,NULL) ORDER BY n) FROM unnest(proargtypes::oid[]) WITH ORDINALITY a(t,n)) AS types,
    oid::regprocedure::text AS signature,EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'employee_import_mapped_verification_%'
      AND proname<>'employee_import_mapped_verification_media_bind' ORDER BY proname`);
  assert.deepEqual(fns.map(f => f.proname).sort(), OPERATIONS.map(k => PREFIX + k).sort());
  for (const fn of fns) {
    const op = fn.proname.slice(PREFIX.length), spec = specs[op];
    assert.equal(fn.provolatile, ['plan', 'status'].includes(op) ? 's' : 'v'); assert.equal(fn.prosecdef, true);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp')); assert.equal(fn.public_execute, false); assert.equal(fn.pronargdefaults, 0);
    assert.deepEqual(fn.proargnames, ['p_admin_session_token', 'p_job_token', ...spec.map(r => r[0])]);
    assert.deepEqual(fn.types, ['uuid', 'uuid', ...spec.map(r => r[1])]);
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, fn.signature]), role !== 'service_role');
    await assert.rejects(call(op, argsFor(op, { plan_hash: '0'.repeat(64) }), 'service_role'), /permission denied/);
  }
  const helpers = await rows(db, `SELECT proname,prosecdef,proconfig,oid::regprocedure::text AS signature,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_mapped_verification_%'`);
  assert.ok(helpers.length > 0);
  for (const fn of helpers) {
    assert.equal(fn.prosecdef, true); assert.equal(fn.public_execute, false); assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, fn.signature]), false);
  }
  await assert.rejects(call('status'), { code: '42883' });
}));

test('SQL53 media signatures preserve SQL22 service arguments; inventory is STABLE and browser cannot execute service endpoints', () => transaction(async () => {
  const specs = [
    [MEDIA_INVENTORY, [], [], false],
    [PREFIX + 'media_bind', ['p_files'], ['jsonb'], false],
    [MEDIA_AUTH, ['p_action', 'p_object_key'], ['text', 'text'], true],
    [MEDIA_COMMIT, ['p_action', 'p_object_key', 'p_bytes', 'p_sha256', 'p_content_type', 'p_storage_origin', 'p_generation'], ['text', 'text', 'integer', 'text', 'text', 'text', 'text'], true],
  ];
  for (const [name, args, types, service] of specs) {
    const [fn] = await rows(db, `SELECT proargnames,provolatile,prosecdef,proconfig,pronargdefaults,oid::regprocedure::text AS signature,
      (SELECT array_agg(format_type(t,NULL) ORDER BY n) FROM unnest(proargtypes::oid[]) WITH ORDINALITY a(t,n)) AS types,
      EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1`, [name]);
    assert.ok(fn, name); assert.deepEqual(fn.proargnames, ['p_admin_session_token', 'p_job_token', ...args]);
    assert.deepEqual(fn.types, ['uuid', 'uuid', ...types]); assert.equal(fn.prosecdef, true); assert.equal(fn.public_execute, false); assert.equal(fn.pronargdefaults, 0);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    if (name === MEDIA_INVENTORY) assert.equal(fn.provolatile, 's');
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, fn.signature]), service ? role === 'service_role' : role !== 'service_role');
  }
  const p = await stage(); await begin(p);
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(authorize('upload', verification.files[0].key, {}, role), /permission denied/);
    await assert.rejects(mediaCommit('upload', verification.files[0], { p_generation: '0' }, role), /permission denied/);
  }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await db.exec(`SAVEPOINT private_access; SET LOCAL ROLE ${role}`);
    try { await assert.rejects(db.query('SELECT * FROM private.employee_transfer_staging LIMIT 1'), /permission denied/); }
    finally { await db.exec('ROLLBACK TO SAVEPOINT private_access; RELEASE SAVEPOINT private_access'); }
  }
}));

for (const role of ['anon', 'authenticated']) test(`SQL53 ${role}: full 15-field restore, mapped UUID/admin/media only, every full-restore gate false`, () => transaction(async () => {
  const initial = await business(), modes = await triggers(), oldSummary = await summary(), originalSource = await snapshot(source);
  const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
  const flags = await rows(db, 'SELECT id,is_verified,is_active FROM public.users ORDER BY id');
  const p = await stage(verification, role); common(p); assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
  assert.deepEqual(p.totals, { verification_requests: 205 }); assert.equal(p.employees, 2); assert.notEqual(p.site_id, p.source_site_id);
  assert.equal((await status(null, {}, role)).started, false);
  const begun = await begin(p, {}, role); common(begun, p); assert.equal(begun.completed_employees, 0); assert.equal(begun.started, true);
  await assert.rejects(verify({}, role));
  for (const [n, sourceId] of EMPLOYEES.entries()) {
    assert.equal((await status(sourceId, {}, role)).employee.applied, false);
    const r = await apply(p, sourceId, {}, role); common(r, p); assert.equal(r.completed_employees, n + 1); assert.equal(r.employee.applied, true);
    assert.deepEqual(r.employee.counts, { verification_requests: sourceId === S.one ? 203 : 2 });
    assert.deepEqual(await status(sourceId, {}, role), r); assert.deepEqual(await plan({}, role), p);
    const frozen = await snapshot(); assert.deepEqual(await apply(p, sourceId, {}, role), r); assert.deepEqual(await snapshot(), frozen);
    assert.deepEqual(await triggers(), modes); await noLegacy();
  }
  await assert.rejects(verify({}, role)); await commitMedia(verification.files, 'recheck-import');
  const result = await verify({}, role); common(result, p); assert.equal(result.verified, true);
  const frozen = await snapshot(); assert.deepEqual(await verify({}, role), result); assert.deepEqual(await begin(p, {}, role), result);
  assert.deepEqual(await status(null, {}, role), result); assert.deepEqual(await snapshot(), frozen);
  await assertVerification(); await noLegacy();
  const changed = (await business()).filter((r, n) => JSON.stringify(r) !== JSON.stringify(initial[n])).map(r => r.name);
  assert.deepEqual(changed, ['public.verification_requests']);
  // Includes all finances, sessions, running queues, notifications, realtime events, orders and counters.
  assert.deepEqual(await rows(db, 'SELECT id,is_verified,is_active FROM public.users ORDER BY id'), flags);
  assert.deepEqual(await summary(), oldSummary); assert.deepEqual(await snapshot(source), originalSource);
  assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance);
  assert.deepEqual(await triggers(), modes);
}));

test('SQL53 real READ ONLY plan/status/media inventory before begin and after one committed employee', () => withClone(readyDump, readyTask, async () => {
  let p; await transaction(async () => { p = await stage(); }, db, true);
  for (const progressed of [false, true]) {
    if (progressed) await transaction(async () => { await begin(p); await apply(p, S.two); }, db, true);
    await transaction(async () => {
      await db.exec('SET TRANSACTION READ ONLY'); const frozen = await snapshot();
      common(await plan(), p); const s = await status(); common(s, p); assert.equal(s.completed_employees, progressed ? 1 : 0);
      assert.equal((await status(S.two)).employee.applied, progressed); assert.equal((await status(S.one)).employee.applied, false);
      assert.equal((await inventory()).scope, MEDIA_SCOPE); assert.deepEqual(await snapshot(), frozen);
    });
  }
}));

test('SQL53 NULLs, Unicode, historic field meanings and microseconds survive non-UTC clients; is_verified never recomputed', () => transaction(async () => {
  const flags = await rows(db, 'SELECT id,is_verified FROM public.users ORDER BY id');
  const p = await stage(); await db.exec("SET LOCAL TimeZone='America/New_York'"); assert.deepEqual(await plan(), p); await finish(p);
  assert.equal(await scalar(db, "SELECT current_setting('TimeZone')"), 'America/New_York'); await db.exec("SET LOCAL TimeZone='UTC'");
  await assertVerification(); assert.deepEqual(await rows(db, 'SELECT id,is_verified FROM public.users ORDER BY id'), flags);
  assert.equal(await scalar(db, 'SELECT audited_by IS NULL AND audited_at IS NULL AND audit_remark IS NULL FROM public.verification_requests WHERE id=$1', [id(4003)]), true);
  assert.equal(await scalar(db, 'SELECT created_at IS NULL FROM public.verification_requests WHERE id=$1', [id(4005)]), true);
  assert.equal(await scalar(db, 'SELECT updated_at IS NULL FROM public.verification_requests WHERE id=$1', [id(4007)]), true);
  assert.equal(await scalar(db, "SELECT to_char(audited_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') FROM public.verification_requests WHERE id=$1", [V.first]), '2022-02-03 04:05:06.123456');
  assert.equal(await scalar(db, "SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') FROM public.verification_requests WHERE id=$1", [V.first]), '2023-04-05 06:07:08.000001');
  assert.equal(await scalar(db, 'SELECT real_name FROM public.verification_requests WHERE id=$1', [V.first]), '合成姓名𠮷 é é \n"測試"');
  assert.equal(await scalar(db, 'SELECT wallet_address FROM public.verification_requests WHERE id=$1', [V.first]), 'ID-純虛構-\t1');
}));

test('SQL53 205 source requests cross real 200/5 chunk boundary, exact ordered hashes and per-employee counts', () => transaction(async () => {
  assert.deepEqual(chunks(verification.texts.verification_requests).map(text => lines(text).length), [200, 5]);
  const table = verification.catalog.tables[0]; assert.equal(table.rows, 205);
  assert.equal(table.bytes, Buffer.byteLength(verification.texts.verification_requests));
  assert.equal(table.row_hashes_sha256, sha(lines(verification.texts.verification_requests).map(sha).join('')));
  const p = await stage(); await finish(p); await assertVerification();
  assert.equal((await status(S.one)).employee.counts.verification_requests, 203);
  assert.equal((await status(S.two)).employee.counts.verification_requests, 2);
}));

test('SQL53 frozen catalog/chunks/media tuples allow exact no-op repeats, never changed or additional input', () => transaction(async () => {
  const p = await stage(); const first = chunks(verification.texts.verification_requests)[0], frozen = await snapshot();
  await bind(); await stageChunk('verification_requests', 0, first); assert.equal((await mediaBind()).repeated, true);
  assert.deepEqual(await snapshot(), frozen); await begin(p); const begun = await snapshot();
  await bind(); await stageChunk('verification_requests', 0, first); await mediaBind();
  await assert.rejects(stageChunk('verification_requests', 0, first.replace('合成姓名', 'changed')));
  await assert.rejects(stageChunk('verification_requests', 2, first));
  await assert.rejects(bind({ catalog: { ...verification.catalog, tables: [{ ...verification.catalog.tables[0], rows: 206 }] } }));
  assert.deepEqual(await snapshot(), begun); await finish(p);
}));

test('SQL53 exact plan hash/source UUIDs and premature apply/verify reject with no writes', () => transaction(async () => {
  const p = await stage(), frozen = await snapshot(); await assert.rejects(apply(p)); await assert.rejects(verify());
  for (const hash of [null, '', '0'.repeat(63), 'A'.repeat(64), '0'.repeat(64)]) await assert.rejects(begin(p, { p_plan_hash: hash }));
  assert.deepEqual(await snapshot(), frozen); await begin(p);
  for (const sourceId of [null, randomUUID(), bindings[S.one].target_id]) {
    await assert.rejects(apply(p, sourceId)); if (sourceId) await assert.rejects(status(sourceId));
  }
  for (const hash of [null, '', '0'.repeat(64)]) await assert.rejects(apply(p, S.one, { p_plan_hash: hash }));
  await apply(p); await assert.rejects(verify()); await apply(p, S.two); await commitMedia(verification.files, 'recheck-import'); assert.equal((await verify()).verified, true);
}));

test('SQL53 catalog source/package/identity/schema binding cannot accept caller UUID maps or backup proof', () => transaction(async () => {
  for (const patch of [{ package_id: randomUUID() }, { site_id: randomUUID() }, { unexpected: true }, { full_site_complete: true },
    { identity_catalog: { ...identity.catalog, tables: identity.catalog.tables.map(t => ({ ...t, row_hashes_sha256: '0'.repeat(64) })) } }])
    await assert.rejects(bind({ catalog: { ...verification.catalog, ...patch } }));
  await bind(); const frozen = await snapshot();
  await assert.rejects(bind({ catalog: { ...verification.catalog, tables: [{ ...verification.catalog.tables[0], bytes: 1 }] } }));
  for (const op of OPERATIONS) {
    const names = await scalar(db, "SELECT proargnames FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1", [PREFIX + op]);
    assert.ok(!names.some(n => /target_id|identity_map|backup_verified|rows/.test(n)));
  }
  assert.deepEqual(await snapshot(), frozen);
}));

test('SQL53 complete staging required; absent/reordered/duplicated chunks and unsupported keys are not success', () => transaction(async () => {
  await bind(); await assert.rejects(plan()); await assert.rejects(status());
  for (const key of [null, 'orders', 'public.verification_requests', 'verification_requests;DROP TABLE users']) await assert.rejects(stageChunk(key, 0, ''));
  for (const no of [null, -1, 999]) await assert.rejects(stageChunk('verification_requests', no, lines(verification.texts.verification_requests)[0]));
  await stageChunk('verification_requests', 0, lines(verification.texts.verification_requests)[0]);
  await assert.rejects(stageChunk('verification_requests', 1, lines(verification.texts.verification_requests)[0])); await assert.rejects(plan());
  await noLegacy();
}));

test('SQL53 rescans fixed 15 raw fields, duplicate keys, final newline and UUID order, without lossy JSON repair', () => transaction(async () => {
  await bind(); const raw = lines(verification.texts.verification_requests)[0], frozen = await snapshot();
  const body = JSON.parse(raw), missing = { ...body }; delete missing.email;
  for (const text of [raw.replace('{', '{"user_id":"' + S.one + '",'), raw.replace('{', '{"extra":true,'), raw.slice(0, -1),
    JSON.stringify(missing) + '\n', JSON.stringify({ ...body, audited_by: 'invalid-uuid' }) + '\n',
    raw + raw, lines(verification.texts.verification_requests).slice(0, 2).reverse().join('')])
    await assert.rejects(stageChunk('verification_requests', 0, text));
  assert.deepEqual(await snapshot(), frozen);
}));

test('SQL53 rejects 201-row chunks and over-64KiB rows instead of truncating originals', () => transaction(async () => {
  await bind(); const frozen = await snapshot(), row = JSON.parse(lines(verification.texts.verification_requests)[0]);
  await assert.rejects(stageChunk('verification_requests', 0, lines(verification.texts.verification_requests).slice(0, 201).join('')));
  await assert.rejects(stageChunk('verification_requests', 0, JSON.stringify({ ...row, real_name: 'x'.repeat(65536) }) + '\n'));
  assert.deepEqual(await snapshot(), frozen);
}));

for (const [label, extras] of [
  ['invalid sessions', () => [null, randomUUID(), sourceSession].map(v => ({ p_admin_session_token: v }))],
  ['secondary/emergency/foreign-root roles', () => [branch, emergency, other].map(v => ({ p_admin_session_token: v }))],
  ['invalid/foreign tasks', () => [null, randomUUID(), sharedTask.job_token].map(v => ({ p_job_token: v }))],
]) test(`SQL53 denies ${label} for core, browser media and service media entry points`, () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two); for (const extra of extras()) await denyAll(p, extra);
}));

test('SQL53 task expiry/revocation/protocol, owner demotion and missing maintenance/seal block without side effects', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const [sql, params] of [
    ["UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", [task.job_id]],
    ["UPDATE private.employee_transfer_jobs SET status='failed' WHERE id=$1", [task.job_id]],
    ["UPDATE private.employee_transfer_jobs SET options=jsonb_set(options,'{import_protocol}','\"shared-import-v1\"') WHERE id=$1", [task.job_id]],
    ['DELETE FROM private.employee_transfer_maintenance WHERE job_id=$1', [task.job_id]],
    ['UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1', [task.job_id]],
    ["UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE token_hash=private.hash_financial_token($1)", [session]],
    ["UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=private.hash_financial_token($1)", [session]],
  ]) await isolated(async () => { await db.query(sql, params); await denyAll(p); });
  await isolated(async () => { await change('public.admins', "UPDATE public.admins SET role='secondary_admin' WHERE id=$1", [NEW.root]); await denyAll(p); });
}));

test('SQL53 cancellation retains written requests, untouched money and dirty maintenance, but revokes continuation', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  const before = await business(), maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
  assert.equal((await rpc('employee_transfer_cancel', auth())).success, true); assert.deepEqual(await business(), before);
  assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance); await denyAll(p);
}));

for (const missing of ['not begun', 'one employee only', 'all applied but unverified']) test(`SQL53 requires actual SQL52 activity verified after finance: ${missing}`, () => withClone(preActivityDump, readyTask, () => transaction(async () => {
  if (missing !== 'not begun') await restoreActivity({ applied: missing === 'one employee only' ? [S.one] : EMPLOYEES, verified: false });
  await denyAll({ plan_hash: '0'.repeat(64) }); await noLegacy();
})));

test('SQL53 cannot bypass unverified/incomplete SQL51 funds by skipping real SQL52 activity prerequisites', () => withClone(preFinanceDump, readyTask, () => transaction(async () => {
  await restoreFinance({ applied: [S.one], verified: false }); await denyAll({ plan_hash: '0'.repeat(64) }); await noLegacy();
})));

for (const [label, relation, sql, params] of [
  ['identity', 'public.users', "UPDATE public.users SET remarks='same-count identity drift' WHERE id=$1", () => [bindings[S.one].target_id]],
  ['orders', 'public.orders', 'UPDATE public.orders SET commission_amount=commission_amount+0.00000000000000000000000000001 WHERE id=$1', () => [id(100)]],
  ['funds', 'public.wallets', 'UPDATE public.wallets SET available_balance=available_balance+0.00000000000000000000000000001 WHERE user_id=$1', () => [bindings[S.one].target_id]],
  ['login', 'public.employee_login_history', "UPDATE public.employee_login_history SET device_info='null'::jsonb WHERE id=$1", () => [id(1002)]],
  ['work', 'public.work_sessions', "UPDATE public.work_sessions SET last_heartbeat_at=last_heartbeat_at+interval '1 microsecond' WHERE id=$1", () => [id(2001)]],
  ['stop marker', 'private.employee_work_stop_markers', "UPDATE private.employee_work_stop_markers SET stopped_at=stopped_at+interval '1 microsecond' WHERE user_id=$1", () => [bindings[S.one].target_id]],
]) test(`SQL53 every entry rechecks prior ${label} actual rows even after verification is complete`, () => transaction(async () => {
  const p = await stage(); await finish(p); const beforeCounts = (await business()).map(r => [r.name, r.n]);
  await change(relation, sql, params()); assert.deepEqual((await business()).map(r => [r.name, r.n]), beforeCounts); await denyAll(p);
}));

test('SQL53 SQL48–52 map/verified drift and legacy summaries cannot manufacture prerequisites', () => transaction(async () => {
  const p = await stage(); await finish(p);
  for (const [key, employee, path, value] of [
    ['identity-reservation-v1', S.two, ['target_id'], S.one], ['mapped-identity-v1', S.two, ['verified'], false],
    ['mapped-dependencies-v1', ZERO, ['identity_map'], {}], ['mapped-finance-v1', ZERO, ['verified'], false],
    ['mapped-activity-v1', ZERO, ['verified'], false], ['mapped-activity-done-v1', S.two, ['counts', 'work_sessions'], 0],
  ]) await isolated(async () => {
    const updated = await rows(db, 'UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$4::text[],$5::jsonb) WHERE job_id=$1 AND employee_id=$2 AND table_key=$3 RETURNING employee_id', [task.job_id, employee, key, path, JSON.stringify(value)]);
    assert.equal(updated.length, 1); await denyAll(p);
  });
  await isolated(async () => {
    await db.query("UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{verification_restore}','{}'::jsonb) WHERE id=$1", [task.job_id]); await denyAll(p);
  });
}));

test('SQL53 raw NDJSON and parsed body cannot diverge after one employee has committed', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const expression of ["jsonb_set(payload,'{ndjson}',to_jsonb((payload->>'ndjson')||E'\\n'))", "jsonb_set(payload,'{rows,0,user_id}',to_jsonb('" + S.unrelated + "'::text))"])
    await isolated(async () => {
      const updated = await rows(db, `UPDATE private.employee_transfer_staging SET payload=${expression} WHERE job_id=$1 AND table_key='mapped-verification-in:verification_requests' AND chunk_no=0 RETURNING employee_id`, [task.job_id]);
      assert.equal(updated.length, 1); await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
    });
}));

test('SQL53 staged byte/hash/last-id/order/catalog corruption cannot be hidden by matching row counts', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const [key, expression] of [
    ['mapped-verification-in:verification_requests', "jsonb_set(payload,'{bytes}',to_jsonb((payload->>'bytes')::integer+1))"],
    ['mapped-verification-in:verification_requests', "jsonb_set(payload,'{row_hashes}',to_jsonb(repeat('0',length(payload->>'row_hashes'))))"],
    ['mapped-verification-in:verification_requests', "jsonb_set(payload,'{last_id}','null'::jsonb)"],
    ['mapped-verification-catalog-v1', "jsonb_set(payload,'{package_id}',to_jsonb('" + S.unrelated + "'::text))"],
  ]) await isolated(async () => {
    const updated = await rows(db, `UPDATE private.employee_transfer_staging SET payload=${expression} WHERE job_id=$1 AND table_key=$2 AND chunk_no=0 RETURNING employee_id`, [task.job_id, key]);
    assert.equal(updated.length, 1); await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
  });
}));

test('SQL53 saved maps/plan/count/progress types and extra fields are authenticated against real state', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const [path, value] of [[['identity_map'], {}], [['admin_map'], {}], [['completed_employees'], 0], [['completed_employees'], '1'],
    [['verified'], true], [['plan', 'plan_hash'], '0'.repeat(64)], [['plan', 'totals', 'verification_requests'], 204], [['plan', 'can_restore'], true]])
    await isolated(async () => {
      const updated = await rows(db, 'UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$3::text[],$4::jsonb) WHERE job_id=$1 AND table_key=$2 RETURNING employee_id', [task.job_id, STATE, path, JSON.stringify(value)]);
      assert.equal(updated.length, 1); await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
    });
}));

test('SQL53 completion UUID/hash/count and namespace tuple cannot substitute another employee', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  for (const [path, value] of [[['source_id'], S.one], [['target_id'], S.two], [['plan_hash'], '0'.repeat(64)], [['counts', 'verification_requests'], 0], [['counts', 'verification_requests'], '2']])
    await isolated(async () => {
      const updated = await rows(db, 'UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$4::text[],$5::jsonb) WHERE job_id=$1 AND employee_id=$2 AND table_key=$3 RETURNING employee_id', [task.job_id, S.two, DONE, path, JSON.stringify(value)]);
      assert.equal(updated.length, 1); await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
    });
  for (const assignment of ['chunk_no=999', 'row_count=2', `employee_id='${S.unrelated}'`]) await isolated(async () => {
    const updated = await rows(db, `UPDATE private.employee_transfer_staging SET ${assignment} WHERE job_id=$1 AND table_key=$2 RETURNING employee_id`, [task.job_id, DONE]);
    assert.equal(updated.length, 1); await denyAll(p, {}, undefined, ['plan', 'apply', 'status', 'verify']);
  });
}));

for (const [label, request, owner, reason] of [
  ['target residual', V.residual, () => bindings[S.two].target_id, 'verification_target_not_empty'],
  ['UUID collision on unrelated account', V.first, () => S.unrelated, 'verification_uuid_collision'],
]) test(`SQL53 ${label} blocks before begin and after frozen plan, never overwrites`, () => transaction(async () => {
  await unrelatedEmployee(); const p = await stage();
  const insert = () => change('public.verification_requests', "INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status) VALUES($1,$2,'synthetic residual','fake-id','fake-phone','fake-address','pending')", [request, owner()]);
  await isolated(async () => {
    await insert(); const frozen = await business(), blocked = await plan(); common(blocked); assert.equal(blocked.can_begin, false); assert.ok(blocked.conflicts.includes(reason));
    await assert.rejects(begin(blocked)); assert.deepEqual(await business(), frozen);
  });
  await begin(p); await insert(); const frozen = await snapshot(); await assert.rejects(apply(p)); assert.deepEqual(await snapshot(), frozen);
}));

test('SQL53 source_employee_missing is a blocked plan for malicious self-consistent source UUID input', () => transaction(async () => {
  const input = adversarialInput((row, n) => n ? row : { ...row, user_id: S.unrelated, id_front_url: null, id_back_url: null, selfie_url: null });
  const p = await stage(input); common(p); assert.equal(p.can_begin, false); assert.ok(p.conflicts.includes('source_employee_missing'));
  const frozen = await business(); await assert.rejects(begin(p)); assert.deepEqual(await business(), frozen);
}));

test('SQL53 real source auditor absent from shared export causes verification_admin_unmapped, not NULL fallback', () => sourceVariant(async () => {
  await source.query("INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,'source-unmapped-auditor','local-only','secondary_admin',true)", [S.unknownAdmin]);
  await source.query('UPDATE public.verification_requests SET audited_by=$2 WHERE id=$1', [V.first, S.unknownAdmin]);
}, async () => {
  const p = await stage(); assert.equal(p.can_begin, false); assert.ok(p.conflicts.includes('verification_admin_unmapped'));
  const frozen = await business(); await assert.rejects(begin(p)); assert.deepEqual(await business(), frozen);
}));

test('SQL53 refuses unknown verification triggers and changed ALWAYS maintenance modes without normalizing them', () => transaction(async () => {
  const p = await stage(); await begin(p);
  for (const sql of [
    'CREATE TRIGGER mapped_verification_unknown BEFORE INSERT ON public.verification_requests FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()',
    'ALTER TABLE public.verification_requests DISABLE TRIGGER zz_employee_transfer_maintenance',
    'ALTER TABLE public.verification_requests ENABLE REPLICA TRIGGER zz_employee_transfer_maintenance',
  ]) await isolated(async () => { await db.exec(sql); await denyAll(p); });
}));

test('SQL53 permits only verification writes and never disables triggers or bypasses business protection', () => transaction(async () => {
  const definition = await scalar(db, 'SELECT pg_get_functiondef(oid) FROM pg_proc WHERE pronamespace=\'public\'::regnamespace AND proname=$1', [PREFIX + 'apply']);
  assert.match(definition, /employee_transfer_write_permits/); assert.match(definition, /ARRAY\s*\[\s*'public\.verification_requests'\s*\]/i);
  assert.doesNotMatch(definition, /DISABLE\s+TRIGGER|employee_transfer_bypass_triggers|session_replication_role/i);
  const p = await stage(), before = await triggers(); await finish(p); assert.deepEqual(await triggers(), before); assert.equal(await permits(), 0);
  for (const sql of ["UPDATE public.users SET is_verified=NOT is_verified WHERE id='" + bindings[S.one].target_id + "'", 'DELETE FROM public.verification_requests']) {
    const point = `forbidden_write_${++counter}`; await db.exec(`SAVEPOINT ${point}`);
    try { await assert.rejects(db.exec(sql)); } finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
  }
  await assertVerification();
}));

for (const fault of ['constraint', 'audit']) test(`SQL53 late ${fault} failure rolls back current employee only; prior COMMITTED employee remains intact`, () => withClone(readyDump, readyTask, async () => {
  let p; await transaction(async () => { p = await stage(); await begin(p); await apply(p, S.two); }, db, true);
  await transaction(async () => {
    if (fault === 'constraint') await db.exec(`ALTER TABLE public.verification_requests ADD CONSTRAINT mapped_verification_late CHECK(id<>'${id(4203)}'::uuid) NOT VALID`);
    else await db.exec(`CREATE FUNCTION public.mapped_verification_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'mapped verification final audit failed'; END $$;
      CREATE TRIGGER mapped_verification_late_failure BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.mapped_verification_late_failure()`);
    const frozen = await snapshot(), modes = await triggers(); await assert.rejects(apply(p));
    assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.equal(await permits(), 0);
    assert.equal((await status(S.two)).employee.applied, true); assert.equal((await status(S.one)).employee.applied, false);
    assert.equal(await scalar(db, 'SELECT count(*)::integer FROM public.verification_requests WHERE user_id=$1', [bindings[S.one].target_id]), 0);
    await assertVerification(verification.texts.verification_requests, [S.two]);
    if (fault === 'constraint') await db.exec('ALTER TABLE public.verification_requests DROP CONSTRAINT mapped_verification_late');
    else await db.exec('DROP TRIGGER mapped_verification_late_failure ON private.employee_transfer_events; DROP FUNCTION public.mapped_verification_late_failure()');
    await apply(p); await commitMedia(verification.files, 'recheck-import'); assert.equal((await verify()).verified, true); await assertVerification(); await noLegacy();
  }, db, true);
}));

test('SQL53 actual COMMIT/lost apply response resumes from independent database dump without duplicates', () => withClone(readyDump, readyTask, async () => {
  let p; await transaction(async () => { p = await stage(); await begin(p); }, db, true);
  await assert.rejects((async () => { await transaction(() => apply(p), db, true); throw new Error('local response lost AFTER COMMIT'); })(), /AFTER COMMIT/);
  const committed = await db.dumpDataDir('none');
  await withClone(committed, readyTask, () => transaction(async () => {
    const r = await status(S.one); common(r, p); assert.equal(r.employee.applied, true); assert.equal(r.completed_employees, 1);
    assert.equal((await status(S.two)).employee.applied, false); const frozen = await snapshot(); assert.deepEqual(await apply(p), r); assert.deepEqual(await snapshot(), frozen);
    await apply(p, S.two); await commitMedia(verification.files, 'recheck-import'); assert.equal((await verify()).verified, true); await assertVerification(); await noLegacy();
  }, db, true));
}));

test('SQL53 real client to anon RPC: lost committed apply needs SAME-source status and never automatically retries', () => withClone(readyDump, readyTask, async () => {
  let p; await transaction(async () => { p = await stage(); }, db, true);
  const calls = []; let drop = true;
  modules.setHarness({ token: session, rpc(name, args) {
    const query = transaction(async () => { calls.push({ name, args }); return on(db, name, args); }, db, true).then(data => {
      if (drop && name === PREFIX + 'apply') { drop = false; throw new Error('response lost AFTER COMMIT'); }
      return { data, error: null };
    }); query.abortSignal = () => query; return query;
  } });
  const client = modules.createEmployeeMappedVerificationSession(task.job_token); await client.bind(verification.catalog);
  for (const [no, text] of chunks(verification.texts.verification_requests).entries()) await client.stage('verification_requests', no, text);
  p = await client.plan(); common(p); await client.begin(p); await assert.rejects(client.apply(S.one), /unconfirmed/);
  const n = calls.length; await assert.rejects(client.apply(S.two), /unconfirmed/); assert.equal(calls.length, n);
  await client.plan(); await client.status(S.two); const afterWrong = calls.length;
  await assert.rejects(client.apply(S.two), /unconfirmed/); assert.equal(calls.length, afterWrong);
  assert.equal((await client.status(S.one)).employee.applied, true); assert.equal((await client.apply(S.two)).employee.applied, true);
  await transaction(() => commitMedia(verification.files, 'recheck-import'), db, true); assert.equal((await client.verify()).verified, true);
  assert.equal(drop, false); assert.equal(calls.filter(c => c.name === PREFIX + 'apply').length, 2);
  assert.equal(calls.filter(c => c.name === PREFIX + 'begin').length, 1); assert.equal(calls.filter(c => c.name === PREFIX + 'verify').length, 1);
  for (const c of calls) assert.equal(c.args.p_job_token, task.job_token);
  await transaction(async () => { await assertVerification(); await noLegacy(); });
}));

test('SQL53 brand-new client observes committed partial state by explicit status then completes original task', () => withClone(readyDump, readyTask, async () => {
  let p; await transaction(async () => { p = await stage(); await begin(p); await apply(p, S.two); }, db, true);
  modules.setHarness({ token: session, rpc(name, args) {
    const query = transaction(() => on(db, name, args), db, true).then(data => ({ data, error: null })); query.abortSignal = () => query; return query;
  } });
  const fresh = modules.createEmployeeMappedVerificationSession(task.job_token), s = await fresh.status(S.two);
  common(s, p); assert.equal(s.employee.applied, true); assert.equal(s.completed_employees, 1);
  assert.equal((await fresh.status(S.one)).employee.applied, false); assert.equal((await fresh.apply(S.one)).employee.applied, true);
  await transaction(() => commitMedia(verification.files, 'recheck-import'), db, true); assert.equal((await fresh.verify()).verified, true);
  await transaction(async () => { await assertVerification(); await noLegacy(); });
}));

test('SQL53 media inventory retains old exact refs/file shape, new import-only scope and mapped authorization path', () => transaction(async () => {
  await stage(verification, 'anon', false);
  const bare = await inventory(); assert.deepEqual(Object.keys(bare).sort(), ['scope', 'direction', 'files', 'full_site_complete'].sort());
  assert.equal(bare.scope, MEDIA_SCOPE); assert.equal(bare.direction, 'import'); assert.equal(bare.full_site_complete, false);
  assert.deepEqual(bare.files, verification.files.map(file => ({ key: file.key, source_url: file.source_url, bucket: 'verification-documents', path: file.source_url.split(MEDIA_PREFIX + '/')[1], file: null })));
  assert.equal(verification.files.length, 6); // Each employee's repeated document URL deduplicated across 205 rows.
  const r = await mediaBind(); assert.deepEqual(r, { success: true, scope: MEDIA_SCOPE, files: verification.files.length,
    bytes: verification.files.reduce((n, file) => n + file.bytes, 0), repeated: false, full_site_complete: false });
  assert.deepEqual((await inventory()).files.map(ref => ref.file), verification.files); await commitMedia();
  for (const file of verification.files) {
    const c = await authorize('upload', file.key); assert.equal(c.path, targetPath(file)); assert.notEqual(c.source_id, c.target_id);
    assert.ok(c.path.split('/')[1].startsWith(c.target_id + '-')); assert.ok(!c.path.split('/')[1].startsWith(c.source_id + '-'));
  }
}));

test('SQL53 missing media bind, missing uploads and missing last file keep media_incomplete and refuse begin', () => transaction(async () => {
  let p = await stage(verification, 'anon', false); assert.equal(p.can_begin, false); assert.ok(p.conflicts.includes('media_incomplete')); await assert.rejects(begin(p));
  await mediaBind(); p = await plan(); assert.ok(p.conflicts.includes('media_incomplete'));
  await commitMedia(verification.files.slice(0, -1)); p = await plan(); assert.equal(p.can_begin, false); await assert.rejects(begin(p));
  await commitMedia(verification.files.slice(-1)); p = await plan(); assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []); await noLegacy();
}));

test('SQL53 malformed/missing/reordered/extra media tuples refuse without accepting partial inventories', () => transaction(async () => {
  await stage(verification, 'anon', false); const frozen = await snapshot();
  const mutations = [files => files.slice(0, -1), files => [...files, files[0]], files => files.reverse(),
    files => { files[0].key = '0'.repeat(64); return files; }, files => { files[0].source_url += '?signed=forbidden'; return files; },
    files => { files[0].bytes = 0; return files; }, files => { files[0].bytes = 52428801; return files; },
    files => { files[0].bytes = '10'; return files; }, files => { files[0].content_type = 'text/html'; return files; },
    files => { files[0].sha256 = 'A'.repeat(64); return files; }, files => { files[0].extra = true; return files; }];
  for (const mutate of mutations) await assert.rejects(mediaBind(mutate(structuredClone(verification.files))));
  assert.deepEqual(await snapshot(), frozen);
}));

test('SQL53 immutable file tuples, exact content receipt and one target origin cannot be rebound', () => transaction(async () => {
  await stage(); const changed = structuredClone(verification.files); changed[0].sha256 = sha('changed content');
  const frozen = await snapshot(); await assert.rejects(mediaBind(changed)); assert.deepEqual(await snapshot(), frozen);
  for (const extra of [{ p_bytes: 1 }, { p_sha256: sha('different') }, { p_content_type: 'image/gif' },
    { p_storage_origin: SOURCE_ORIGIN }, { p_storage_origin: TARGET_ORIGIN + '?token=forbidden' }]) {
    await assert.rejects(mediaCommit('upload', verification.files[0], extra));
  }
  assert.deepEqual(await snapshot(), frozen);
}));

test('SQL53 mapped service scope permits only upload/recheck-import, never old export/download or foreign object keys', () => transaction(async () => {
  await stage(); const frozen = await snapshot();
  for (const action of ['download', 'recheck-export', 'read', 'delete', null]) {
    await assert.rejects(authorize(action)); await assert.rejects(mediaCommit(action, verification.files[0], { p_generation: '0' }));
  }
  for (const key of [null, '', 'A'.repeat(64), sha('outside-task')]) await assert.rejects(authorize('upload', key));
  for (const action of ['upload', 'recheck-import']) await assert.rejects(rpc('employee_transfer_verification_media_authorize', {
    ...auth(), p_action: action, p_object_key: verification.files[0].key }, 'service_role'));
  assert.deepEqual(await snapshot(), frozen);
}));

test('SQL53 generation race: authorize at zero then employee apply rejects stale commit, even after earlier successful readback', () => transaction(async () => {
  const p = await stage(); await begin(p); const file = verification.files[0], original = await authorize('recheck-import', file.key);
  assert.equal(original.generation, '0'); await commitMedia(verification.files, 'recheck-import'); await apply(p, S.two);
  const frozen = await snapshot(); await assert.rejects(mediaCommit('recheck-import', file, { p_generation: original.generation })); assert.deepEqual(await snapshot(), frozen);
  const next = await authorize('recheck-import', file.key); assert.equal(next.generation, '1');
  await mediaCommit('recheck-import', file, { p_generation: next.generation }); await apply(p);
  await assert.rejects(verify()); await commitMedia(verification.files, 'recheck-import'); assert.equal((await verify()).verified, true);
}));

test('SQL53 verify requires every file final rechecked after LAST employee; partial final recheck cannot pass', () => transaction(async () => {
  const p = await stage(); await begin(p); await commitMedia(verification.files, 'recheck-import');
  await apply(p); await apply(p, S.two); await assert.rejects(verify());
  await commitMedia(verification.files.slice(0, -1), 'recheck-import'); const frozen = await snapshot(); await assert.rejects(verify()); assert.deepEqual(await snapshot(), frozen);
  await commitMedia(verification.files.slice(-1), 'recheck-import'); assert.equal((await verify()).verified, true); await assertVerification();
}));

test('SQL53 changed written raw field/admin/URL or deleted row blocks every entry, without overwriting drift', () => transaction(async () => {
  const p = await stage(); await finish(p);
  for (const sql of [
    "UPDATE public.verification_requests SET audit_remark='same-count drift' WHERE id=$1",
    'UPDATE public.verification_requests SET audited_by=NULL WHERE id=$1',
    "UPDATE public.verification_requests SET id_front_url='https://target.supabase.co/wrong' WHERE id=$1",
    "UPDATE public.verification_requests SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1",
    'DELETE FROM public.verification_requests WHERE id=$1',
  ]) await isolated(async () => { await change('public.verification_requests', sql, [V.first]); await denyAll(p); });
}));

test('SQL53 actual source without media preserves NULL URL fields and does not invent Storage receipts', () => sourceVariant(async () => {
  await source.query('UPDATE public.verification_requests SET id_front_url=NULL,id_back_url=NULL,selfie_url=NULL');
}, async () => {
  assert.deepEqual(verification.files, []); const p = await stage(); assert.equal(p.can_begin, true); await finish(p); await assertVerification();
  assert.equal(await scalar(db, 'SELECT count(*)::integer FROM public.verification_requests WHERE id_front_url IS NOT NULL OR id_back_url IS NOT NULL OR selfie_url IS NOT NULL'), 0);
}));

test('SQL53 real source two employees with empty verification histories still require explicit empty chunk', () => sourceVariant(async () => {
  await source.query('DELETE FROM public.verification_requests');
}, async () => {
  await bind(); await assert.rejects(plan()); await stageChunk('verification_requests', 0, ''); await mediaBind([]);
  const p = await plan(); common(p); assert.equal(p.can_begin, true); assert.deepEqual(p.totals, { verification_requests: 0 });
  await finish(p); await assertVerification(); assert.equal((await status()).completed_employees, 2);
}));

test('SQL53 zero employees uses actual source exports, independent encrypted backups and true SQL48–52 empty prerequisites', async () => {
  const empty = await transaction(async () => {
    await source.query('DELETE FROM public.verification_requests');
    for (const key of ACTIVITY) await change(RELATIONS[key], `DELETE FROM ${RELATIONS[key]}`, [], source);
    for (const key of [...FINANCE].reverse().concat(['used_order_data', 'dispatch_group_members', 'orders', 'financial_employee_credentials', 'users']))
      await change('public.' + key, `DELETE FROM public.${key}`, [], source);
    return { dispatch: await capture('dispatch'), identity: await capture('identity'), finance: await capture('finance'), activity: await capture('activity'), verification: await capture('verification') };
  }, source);
  const previous = { finance, activity, verification }; finance = empty.finance; activity = empty.activity; verification = empty.verification;
  try { await withClone(sharedDump, null, () => transaction(async () => {
    await configure(empty.dispatch); await restoreValid(); await restoreIdentities(empty.identity, []); await restoreDependencies();
    await restoreFinance({ applied: [] }); await restoreActivity({ applied: [] });
    const p = await stage(); common(p); assert.equal(p.can_begin, true); assert.equal(p.employees, 0); assert.deepEqual(p.totals, { verification_requests: 0 });
    await begin(p); assert.equal((await verify()).verified, true); assert.equal((await status()).completed_employees, 0); await noLegacy();
    assert.equal(await scalar(db, 'SELECT count(*)::integer FROM public.verification_requests'), 0);
  })); } finally { finance = previous.finance; activity = previous.activity; verification = previous.verification; }
});

test('SQL53 unmanaged/encoded/signed/wrong-employee media paths reject explicitly, not silently omit a document', () => transaction(async () => {
  for (const url of ['https://external.invalid/doc.jpg', SOURCE_ORIGIN + MEDIA_PREFIX + '/id-front/' + S.one + '-synthetic.jpg?token=signed',
    SOURCE_ORIGIN + MEDIA_PREFIX + '/id-front/' + S.one + '-%73ynthetic.jpg',
    SOURCE_ORIGIN + MEDIA_PREFIX + '/id-front/' + S.two + '-wrong-owner.jpg',
    SOURCE_ORIGIN + MEDIA_PREFIX + '/unreviewed/' + S.one + '-synthetic.jpg']) await isolated(async () => {
    const input = adversarialInput((row, n) => n ? row : { ...row, id_front_url: url }), frozen = await business();
    await assert.rejects(async () => { await stage(input, 'anon', false); await inventory(); });
    assert.deepEqual(await business(), frozen); assert.equal(await permits(), 0);
  });
}));

test('SQL53 REAL handler + fakeStorage + service SQL upload/readback and final recheck; missing object cannot fabricate success', () => transaction(async () => {
  // Real handler, actual SHA/magic-byte checks and SQL service authorization; isolated memory Storage only.
  // This is NOT real Supabase Storage/CORS or a document decoder/virus scan.
  const bytesFor = type => type === 'image/jpeg' ? Uint8Array.of(255, 216, 255, 224, 0, 3, 9, 255, 217)
    : type === 'image/png' ? Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3)
      : new TextEncoder().encode('%PDF-1.7\nsynthetic\n%%EOF');
  const payloads = new Map(), files = verification.files.map(file => {
    const bytes = bytesFor(file.content_type); payloads.set(file.key, bytes);
    return { ...file, bytes: bytes.length, sha256: sha(bytes) };
  });
  await stage(verification, 'anon', false); await mediaBind(files);
  const objects = new Map(), uploads = [], serviceCalls = [];
  const handler = modules.createEmployeeTransferMediaHandler({ supabaseUrl: TARGET_ORIGIN, crypto: webcrypto,
    async rpc(name, args) {
      assert.ok([MEDIA_AUTH, MEDIA_COMMIT].includes(name)); serviceCalls.push({ name, args });
      try { return { data: await rpc(name, args, 'service_role'), error: null }; }
      catch { return { data: null, error: { message: 'isolated SQL service refusal' } }; }
    },
    store: {
      async upload(bucket, path, bytes, options) {
        assert.equal(bucket, 'verification-documents'); assert.equal(options.upsert, false); assert.equal(objects.has(path), false);
        const file = files.find(file => targetPath(file) === path); assert.ok(file); assert.equal(options.contentType, file.content_type);
        objects.set(path, Uint8Array.from(bytes)); uploads.push(path); return { data: { path }, error: null };
      },
      async download(bucket, path, signal) {
        assert.equal(bucket, 'verification-documents'); assert.ok(signal instanceof AbortSignal);
        const bytes = objects.get(path); return { data: bytes ? new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }) : new Response('missing', { status: 404 }), error: null };
      },
      remove() { assert.fail('no delete or fake rollback'); },
    },
  });
  const request = (action, file) => new Request('https://edge-fixture.invalid/employee-transfer-media', { method: 'POST',
    headers: { 'x-transfer-scope': 'mapped-verification', 'x-transfer-action': action, 'x-admin-session-token': session,
      'x-transfer-job-token': task.job_token, 'x-transfer-object-key': file.key },
    ...(action === 'upload' ? { body: payloads.get(file.key) } : {}) });
  for (const file of files) { const response = await handler(request('upload', file)); assert.equal(response.status, 200); assert.equal((await response.json()).success, true); }
  assert.deepEqual(uploads.sort(), files.map(targetPath).sort()); const p = await plan(); common(p); assert.equal(p.can_begin, true);
  await begin(p); for (const sourceId of EMPLOYEES) await apply(p, sourceId); await assert.rejects(verify());
  const missing = files[0], missingPath = targetPath(missing), saved = objects.get(missingPath); objects.delete(missingPath);
  const frozen = await snapshot(), commits = serviceCalls.filter(c => c.name === MEDIA_COMMIT).length;
  assert.notEqual((await handler(request('recheck-import', missing))).status, 200);
  assert.equal(serviceCalls.filter(c => c.name === MEDIA_COMMIT).length, commits); assert.deepEqual(await snapshot(), frozen);
  objects.set(missingPath, saved);
  for (const file of files) { const response = await handler(request('recheck-import', file)); assert.equal(response.status, 200); assert.equal((await response.json()).success, true); }
  assert.equal((await verify()).verified, true); await assertVerification(); await noLegacy();
  assert.equal(uploads.length, files.length); assert.equal(serviceCalls.filter(c => c.name === MEDIA_COMMIT).length, files.length * 2);
}));

console.log(`SQL53 registered ${caseNo} unique cases; selected ${selectedCases}${range ? ` in explicit range ${rangeText}` : ' (whole file)'}. Excluded cases are not passed tests.`);
assert.ok(caseNo >= 40 && caseNo <= 60, 'Keep SQL53 focused at 40–60 meaningful registered scenarios.');
assert.ok(selectedCases > 0, 'The explicit test range selected no cases.');
if (range) assert.ok(range[1] <= caseNo, `Range ends beyond the ${caseNo} registered cases.`);
