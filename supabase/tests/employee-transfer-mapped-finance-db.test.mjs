import assert from 'node:assert/strict';
import { after, before, mock, test as registerTest } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
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

// Only this new test is changed. Real SQL replay, source exports, independent disk
// AES/ZIP backups and SQL48/49/50 RPCs establish ALL positive prerequisites.
// Direct postgres changes are local business fixtures or explicitly negative corruption.
// No production network, manufactured jobs/maps/verified summaries or backup proof.
// PGlite is not native PostgreSQL concurrency, PostgREST, Storage or capacity acceptance.
// Optional, explicit grouping for slow PGlite scans. No range = the whole file.
// e.g. EMPLOYEE_MAPPED_FINANCE_DB_RANGE=1-64 node --test <this file>.
// No SQL is skipped: every group still performs the complete strict replay and prerequisites.
const rangeText = process.env.EMPLOYEE_MAPPED_FINANCE_DB_RANGE;
let range = null, caseNo = 0, selectedCases = 0;
if (rangeText !== undefined) {
  assert.match(rangeText, /^[1-9][0-9]*-[1-9][0-9]*$/);
  range = rangeText.split('-').map(Number);
  assert.ok(range.every(Number.isSafeInteger) && range[0] <= range[1]);
  console.log(`Explicit SQL51 test selection ${rangeText}; excluded cases are NOT counted as passed.`);
}
function test(name, fn) {
  caseNo++;
  if (range && (caseNo < range[0] || caseNo > range[1])) return;
  selectedCases++; return registerTest(name, fn);
}
const MIGRATION = '20261102000051_restore_mapped_employee_finance.sql';
const PREFIX = 'employee_import_mapped_finance_';
const OPERATIONS = ['bind', 'stage', 'plan', 'begin', 'apply', 'status', 'verify'];
const FINANCE = ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit'];
const TABLES = {
  shared: ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'],
  dispatch: ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'],
  identity: ['accounts', 'credentials', 'orders'], finance: FINANCE,
};
const ZERO = '00000000-0000-0000-0000-000000000000';
const STATE = 'mapped-finance-v1';
const GATES = ['can_restore', 'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete'];
const COMMON = ['scope', 'job_id', 'site_id', 'source_site_id', 'package_id', 'catalog_hash', 'mapping_hash', 'plan_hash',
  'totals', 'employees', 'pending_withdrawals', 'maintenance', 'dependencies_pending', 'financial_data_pending', ...GATES];
const CONFLICTS = ['source_employee_missing', 'inconsistent_source_finance', 'financial_target_not_empty',
  'financial_uuid_collision', 'financial_unique_collision', 'unmapped_administrator'];
const id = n => `51000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const S = { one: id(1), two: id(2), branch: id(3), group: id(4), product: id(5), unknownAdmin: id(6),
  memberOne: id(10), memberTwo: id(11), validMax: id(20), validNull: id(21), validSmall: id(22),
  tx: id(500), manual: id(501), pending: id(600), pendingExtra: id(601), pendingTwo: id(602),
  cursor: '9007199254740993', after: '9007199254740994', audit: '9007199254740999', unrelated: id(999) };
const EMPLOYEES = [S.one, S.two];
const OWNERS = [S.one, S.two, S.one, S.two];
const USERNAMES = { [S.one]: 'mapped-finance-one', [S.two]: 'mapped-finance-legacy' };
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
let identity, dispatch, shared, finance, expected, modules, bindings, sharedDump, configuredDump, configuredTask, readyDump, readyTask, replay;
let counter = 0;
const auth = (job = task, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
async function on(site, name, args, role = 'anon') {
  const point = `mapped_finance_${++counter}`;
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
const bind = (input = finance, extra = {}, role) => call('bind', { p_catalog: input.catalog, ...extra }, role);
const stageChunk = (key, no, text, extra = {}, role) => call('stage', { p_table_key: key, p_chunk_no: no, p_ndjson: text, ...extra }, role);
const plan = (extra = {}, role) => call('plan', extra, role);
const status = (sourceId = null, extra = {}, role) => call('status', { p_source_id: sourceId, ...extra }, role);
const begin = (p, extra = {}, role) => call('begin', { p_plan_hash: p.plan_hash, ...extra }, role);
const apply = (p, sourceId = S.one, extra = {}, role) => call('apply', { p_source_id: sourceId, p_plan_hash: p.plan_hash, ...extra }, role);
const verify = (extra = {}, role) => call('verify', extra, role);
const argsFor = (op, p) => op === 'bind' ? { p_catalog: finance.catalog }
  : op === 'stage' ? { p_table_key: 'wallets', p_chunk_no: 0, p_ndjson: chunks(finance.texts.wallets)[0] }
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
  const job = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession,
    p_admin_password: PASSWORDS.root, ...['identity', 'finance'].includes(kind) ? { p_package_id: pkg } : {} });
  assert.equal(job.success, true);
  const texts = {};
  for (const key of TABLES[kind]) {
    texts[key] = ''; let after = null;
    do {
      const page = await on(source, `get_employee_export_${kind}_page`, { ...auth(job, sourceSession), p_table_key: key, p_after: after, p_limit: 1 });
      assert.equal(page.sha256, sha(page.ndjson)); texts[key] += page.ndjson; after = page.next_after;
    } while (after !== null);
  }
  assert.equal((await on(source, `employee_export_${kind}_verify`, auth(job, sourceSession))).verified, true);
  await on(source, kind === 'shared' ? 'employee_transfer_cancel' : `employee_export_${kind}_close`, auth(job, sourceSession));
  return { catalog: job.catalog, texts };
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
  const dir = await mkdtemp(join(tmpdir(), 'employee-mapped-finance-')), path = join(dir, 'independent.edx'), plain = new Map();
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
    }, 'local-mapped-finance-independent-backup-passphrase');
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
    VALUES($1,'unrelated-finance-target','local-only','MF-UNRELATED',$2,false)`, [S.unrelated, NEW.root]);
}
const business = () => snapshot().then(all => all.filter(r => r.name.startsWith('public.') || !r.name.startsWith('private.employee_transfer_')));
const triggers = () => rows(db, `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','private') ORDER BY 1,2,3`);
const validSnapshot = () => rows(db, 'SELECT id,to_jsonb(v)::text AS body FROM public.valid_order_data v ORDER BY id');
function counts(value) {
  assert.deepEqual(Object.keys(value).sort(), [...FINANCE].sort());
  for (const n of Object.values(value)) assert.ok(Number.isSafeInteger(n) && n >= 0);
}
function common(value, p = null) {
  const isPlan = Object.hasOwn(value, 'can_begin');
  assert.deepEqual(Object.keys(value).sort(), [...COMMON, ...isPlan ? ['can_begin', 'conflicts'] : ['started', 'completed_employees', 'verified', 'employee']].sort());
  assert.equal(value.scope, 'employee-mapped-finance'); assert.equal(value.job_id, task.job_id);
  assert.equal(value.package_id, pkg); assert.equal(value.source_site_id, finance.catalog.site_id);
  for (const key of ['job_id', 'site_id', 'source_site_id', 'package_id']) assert.match(value[key], /^[0-9a-f-]{36}$/);
  for (const key of ['catalog_hash', 'mapping_hash', 'plan_hash']) assert.match(value[key], /^[0-9a-f]{64}$/);
  for (const key of ['maintenance', 'dependencies_pending', 'financial_data_pending']) assert.equal(value[key], true);
  for (const key of GATES) assert.equal(value[key], false, key);
  counts(value.totals); assert.ok(Number.isSafeInteger(value.employees) && value.employees >= 0);
  assert.deepEqual(Object.keys(value.pending_withdrawals).sort(), ['amount', 'count']);
  assert.ok(Number.isSafeInteger(value.pending_withdrawals.count) && value.pending_withdrawals.count >= 0);
  assert.equal(typeof value.pending_withdrawals.amount, 'string'); assert.match(value.pending_withdrawals.amount, /^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
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
  assert.doesNotMatch(JSON.stringify(value), /password|session_token|job_token|repeated|identity_map|admin_map/);
}
async function stage(input = finance, role = 'anon') {
  const r = await bind(input, {}, role);
  assert.deepEqual(Object.keys(r).sort(), ['success', 'scope', 'catalog_hash', 'full_site_complete'].sort());
  assert.equal(r.success, true); assert.equal(r.scope, 'employee-mapped-finance'); assert.equal(r.full_site_complete, false);
  assert.match(r.catalog_hash, /^[0-9a-f]{64}$/);
  for (const key of FINANCE) for (const [no, text] of chunks(input.texts[key], 2).entries()) {
    const receipt = await stageChunk(key, no, text, {}, role);
    assert.deepEqual(receipt, { success: true, scope: 'employee-mapped-finance', table_key: key, chunk_no: no,
      rows: lines(text).length, bytes: Buffer.byteLength(text), sha256: sha(text), full_site_complete: false });
  }
  const p = await plan({}, role); common(p); assert.equal(p.catalog_hash, r.catalog_hash); return p;
}
async function finish(p, employees = EMPLOYEES, role = 'anon') {
  await begin(p, {}, role);
  for (const sourceId of employees) { const r = await apply(p, sourceId, {}, role); common(r, p); assert.equal(r.employee.applied, true); }
  const result = await verify({}, role); common(result, p); assert.equal(result.verified, true); return result;
}
async function noLegacy() {
  const s = await summary();
  for (const key of ['identity_restore', 'dependency_restore', 'verified_identity_map', 'finance_catalog', 'finance_plan', 'finance_restore']) assert.equal(s[key], undefined, key);
  const point = `legacy_finance_${++counter}`; await db.exec(`SAVEPOINT ${point}`);
  try { await assert.rejects(db.query(`SELECT * FROM private.employee_transfer_verified_identity_map((SELECT j FROM private.employee_transfer_jobs j WHERE id=$1),'accounts')`, [task.job_id]), /server-verified|running dispatch owner/i); }
  finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
  assert.equal(await permits(), 0);
}
async function denyAll(p, extra = {}, pattern, operations = OPERATIONS) {
  const frozen = await snapshot(), modes = await triggers();
  for (const role of ['anon', 'authenticated']) for (const op of operations)
    await assert.rejects(call(op, { ...argsFor(op, p), ...extra }, role), pattern);
  assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.equal(await permits(), 0);
}
async function expectedFinance(input = finance) {
  // PostgreSQL parses the original NDJSON. NEVER round-trip amounts through JS JSON.
  const result = {};
  for (const key of FINANCE) result[key] = await rows(source, `SELECT body->>'id' AS id,body->>'user_id' AS owner,body::text AS body
    FROM unnest(string_to_array(rtrim($1::text,E'\n'),E'\n')) line CROSS JOIN LATERAL (SELECT line::jsonb AS body) r WHERE line<>''`, [input.texts[key]]);
  return result;
}
async function assertFinance(original = expected, employees = EMPLOYEES) {
  const adminMap = (await summary()).dispatch_config_plan.admin_map;
  for (const sourceId of employees) {
    const target = bindings[sourceId].target_id;
    for (const key of FINANCE) {
      const originals = original[key].filter(r => r.owner === sourceId);
      assert.equal(await scalar(db, `SELECT count(*)::int FROM public.${key} WHERE user_id=$1`, [target]), originals.length, key);
      for (const row of originals) {
        // Identify ledger/audit by complete business contents rather than trusting a saved map.
        // SQL comparison covers every field, numeric precision, NULL and microseconds.
        let expectedExpr = "$2::jsonb||jsonb_build_object('user_id',$1::uuid)";
        let actualExpr = 'to_jsonb(actual)';
        if (['wallets', 'wallet_balance_baselines'].includes(key)) expectedExpr = `(${expectedExpr})-'id'`;
        if (key === 'wallet_balance_baselines') {
          const cursor = await scalar(db, `SELECT COALESCE(max(actual.id),0)::text FROM public.wallet_ledger_entries actual
            JOIN unnest(string_to_array(rtrim($2::text,E'\n'),E'\n')) line ON line<>''
            AND actual.operation_id=(line::jsonb->>'operation_id')::uuid
            AND actual.source_type=line::jsonb->>'source_type' AND actual.source_id=(line::jsonb->>'source_id')::uuid
            AND actual.event_type=line::jsonb->>'event_type'
            WHERE actual.user_id=$1 AND (line::jsonb->>'id')::bigint<=($3::jsonb->>'last_ledger_id')::bigint`, [target, finance.texts.wallet_ledger_entries, row.body]);
          expectedExpr = `(${expectedExpr})||jsonb_build_object('last_ledger_id',$3::bigint)`;
          assert.equal(await scalar(db, `SELECT ${actualExpr}=(${expectedExpr}) FROM public.${key} actual WHERE user_id=$1`, [target, row.body, cursor]), true, `${key}:${sourceId}`);
          continue;
        }
        if (['wallet_ledger_entries', 'wallet_reconciliation_audit'].includes(key)) { expectedExpr = `(${expectedExpr})-'id'`; actualExpr = "to_jsonb(actual)-'id'"; }
        if (key === 'wallet_transactions') expectedExpr = `(${expectedExpr})||jsonb_build_object('created_by',$3::jsonb->($2::jsonb->>'created_by'))`;
        if (key === 'withdrawals') expectedExpr = `(${expectedExpr})||jsonb_build_object('audited_by',$3::jsonb->($2::jsonb->>'audited_by'))`;
        assert.equal(await scalar(db, `SELECT count(*)=1 FROM public.${key} actual WHERE user_id=$1 AND ${actualExpr}=(${expectedExpr})`,
          [target, row.body, ...['wallet_transactions', 'withdrawals'].includes(key) ? [JSON.stringify(adminMap)] : []]), true, `${key}:${row.id}`);
      }
    }
  }
  for (const key of FINANCE) assert.equal(await scalar(db, `SELECT count(*)::int FROM public.${key} WHERE user_id=ANY($1::uuid[])`, [EMPLOYEES]), 0, key);
}
async function sourceVariant(mutate, run) {
  const input = await transaction(async () => { await mutate(); const f = await capture('finance'); return { finance: f, expected: await expectedFinance(f) }; }, source);
  const old = finance; finance = input.finance;
  try { return await transaction(() => run(input)); } finally { finance = old; }
}

before(async () => {
  // Missing SQL51 is a hard failure, not a skip and not an invented implementation.
  await access(new URL(`../migrations/${MIGRATION}`, import.meta.url));
  for (const [module, names] of [[globalThis, ['fetch']], [http, ['request', 'get']], [https, ['request', 'get']],
    [net, ['connect', 'createConnection']], [tls, ['connect']]])
    for (const name of names) mock.method(module, name, () => assert.fail('network and production services forbidden'));
  replay = await createSites({ upTo: MIGRATION }); source = replay.oldSite; db = replay.newSite;
  assert.equal(replay.files.at(-1), MIGRATION); assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.deepEqual(replay.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
  await buildNewSite(source); await buildNewSite(db);
  await source.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await source.query('DELETE FROM public.financial_admin_credentials WHERE admin_id=$1', [NEW.branch]);
  await source.query('UPDATE public.admins SET id=$1 WHERE id=$2', [S.branch, NEW.branch]);
  await source.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [S.branch]);
  await source.query("INSERT INTO public.dispatch_groups(id,group_name,created_by) VALUES($1,'Mapped finance source group',$2)", [S.group, S.branch]);
  for (const sourceId of EMPLOYEES) {
    await source.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,is_active,total_income,remarks,created_at)
      VALUES($1,$2,$3,extensions.crypt($4,extensions.gen_salt('bf',4)),$5,true,$6::numeric,$7,'2026-09-01T01:02:03.123456Z')`,
    [sourceId, USERNAMES[sourceId], sourceId === S.one ? 'MF-001' : 'MF-002', PASSWORDS.employee, sourceId === S.one ? NEW.root : S.branch,
      sourceId === S.one ? '32.12345678901234567890123456789' : '0', sourceId === S.one ? 'private source remark é 𠮷' : null]);
    await source.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [sourceId]);
  }
  await source.query("INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Mapped finance historical product',false)", [S.product]);
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
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active) SELECT $1,'mapped-finance-other-root',password_hash,'super_admin',true FROM public.admins WHERE id=$2`, [id(300), NEW.root]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [id(300)]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  other = await adminLogin(db, 'mapped-finance-other-root', PASSWORDS.root); pkg = randomUUID();
  const compiled = await build({ stdin: { contents: `export {createReplacementBackup} from './src/lib/employeeTransfer/replacementBackup.ts';
    export {createDispatchBackup} from './src/lib/employeeTransfer/dispatchBackup.ts';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020' });
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  await transaction(async () => { shared = await capture('shared'); dispatch = await capture('dispatch'); identity = await capture('identity'); finance = await capture('finance'); expected = await expectedFinance(); }, source, true);
  assert.deepEqual(finance.catalog.identity_catalog, identity.catalog); assert.deepEqual(identity.catalog.tables.map(t => t.rows), [2, 2, 4]);
  await transaction(async () => {
    const prepared = await prepare('shared', shared); sharedTask = prepared.job;
    const r = await rpc('employee_import_shared_replace_apply', { ...auth(sharedTask), p_plan_hash: prepared.plan.plan_hash });
    assert.equal(r.success, true); assert.equal(r.admin_map[S.branch], NEW.branch); assert.equal(r.admin_map[NEW.root], NEW.root);
    await rpc('employee_transfer_cancel', auth(sharedTask));
  }, db, true);
  sharedDump = await db.dumpDataDir('none');
  await transaction(() => configure(dispatch), db, true); configuredTask = task; configuredDump = await db.dumpDataDir('none');
  await transaction(async () => { await restoreValid(); await restoreIdentities(); await restoreDependencies(); await noLegacy(); }, db, true);
  readyTask = task; readyDump = await db.dumpDataDir('none');
}, { timeout: 600000 });
after(async () => { await Promise.allSettled([source?.close(), db?.close()]); mock.restoreAll(); });

test('SQL51 strict full migration replay preserves the exact original twelve failures, never skips missing SQL', () => {
  assert.equal(replay.files.length, 578); assert.equal(replay.files.at(-1), MIGRATION);
  assert.deepEqual(replay.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
  assert.equal(replay.validation.freshDatabaseVerified, false);
});

test('SQL51 exact seven signatures, REQUIRED nullable status source, STABLE reads, definer path and explicit grants', () => transaction(async () => {
  const specs = { bind: [['p_catalog', 'jsonb']], stage: [['p_table_key', 'text'], ['p_chunk_no', 'integer'], ['p_ndjson', 'text']],
    plan: [], begin: [['p_plan_hash', 'text']], apply: [['p_source_id', 'uuid'], ['p_plan_hash', 'text']], status: [['p_source_id', 'uuid']], verify: [] };
  const fns = await rows(db, `SELECT proname,provolatile,prosecdef,proconfig,proargnames,pronargdefaults,
    (SELECT array_agg(format_type(t,NULL) ORDER BY n) FROM unnest(proargtypes::oid[]) WITH ORDINALITY a(t,n)) AS types,
    oid::regprocedure::text AS signature,EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'employee_import_mapped_finance_%' ORDER BY proname`);
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
  const privateFns = await rows(db, "SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_mapped_finance_%'");
  assert.ok(privateFns.length > 0);
  for (const fn of privateFns) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, fn.signature]), false);
  await assert.rejects(call('status'), { code: '42883' });
}));

for (const role of ['anon', 'authenticated']) {
  test(`SQL51 ${role}: golden two-site, two-admin mapped finance, exact six-table fields and no side effects`, () => transaction(async () => {
    const modes = await triggers(), valid = await validSnapshot(), initial = await business(), beforeSummary = await summary(), sourceBefore = await snapshot(source);
    const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
    const p = await stage(finance, role); assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []); assert.equal(p.employees, 2);
    assert.deepEqual(p.totals, Object.fromEntries(finance.catalog.tables.map(t => [t.key, t.rows])));
    assert.deepEqual(p.pending_withdrawals, { count: 3, amount: '11.00000000000000000000000000001' });
    assert.notEqual(p.site_id, p.source_site_id);
    assert.match(finance.texts.wallet_ledger_entries, /"id": "9007199254740994"/);
    assert.match(finance.texts.wallet_balance_baselines, /"last_ledger_id": "9007199254740993"/);
    assert.ok(finance.texts.withdrawals.includes(PENDING)); assert.ok(finance.texts.wallets.includes(AVAILABLE));
    assert.doesNotMatch(Object.values(finance.texts).join(''), /PRIVATE-MF-ORDER|password_hash|product_value/);
    const s = await status(null, {}, role); common(s, p); assert.equal(s.started, false); assert.equal(s.employee, null);
    const begun = await begin(p, {}, role); common(begun, p); assert.equal(begun.started, true); assert.equal(begun.completed_employees, 0);
    await assert.rejects(verify({}, role), { code: '22023' });
    for (const [n, sourceId] of EMPLOYEES.entries()) {
      const before = await status(sourceId, {}, role); common(before, p); assert.equal(before.employee.applied, false);
      const r = await apply(p, sourceId, {}, role); common(r, p); assert.equal(r.completed_employees, n + 1); assert.equal(r.employee.applied, true);
      assert.deepEqual(await status(sourceId, {}, role), r); assert.deepEqual(await plan({}, role), p);
      const frozen = await snapshot(); assert.deepEqual(await apply(p, sourceId, {}, role), r); assert.deepEqual(await snapshot(), frozen);
      assert.deepEqual(await triggers(), modes); assert.deepEqual(await validSnapshot(), valid); await noLegacy();
    }
    const result = await verify({}, role); common(result, p); assert.equal(result.verified, true); assert.equal(result.employee, null);
    const frozen = await snapshot(); assert.deepEqual(await verify({}, role), result); assert.deepEqual(await begin(p, {}, role), result);
    assert.deepEqual(await status(null, {}, role), result); assert.deepEqual(await snapshot(), frozen);
    await assertFinance(); await noLegacy();
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.wallet_balance_baselines WHERE user_id=$1', [bindings[S.two].target_id]), 0);
    assert.equal(await scalar(db, 'SELECT available_balance::text FROM public.wallets WHERE user_id=$1', [bindings[S.one].target_id]), AVAILABLE);
    assert.equal(await scalar(db, 'SELECT frozen_balance=sum(amount) FROM public.wallets w JOIN public.withdrawals d USING(user_id) WHERE user_id=$1 AND status=\'pending\' GROUP BY frozen_balance', [bindings[S.one].target_id]), true);
    for (const [key, owner] of [[S.one, NEW.root], [S.two, NEW.branch]]) assert.equal(await scalar(db, 'SELECT created_by=$2 AND NOT is_active AND current_session_token IS NULL FROM public.users WHERE id=$1', [bindings[key].target_id, owner]), true);
    const changed = (await business()).filter((r, i) => JSON.stringify(r) !== JSON.stringify(initial[i])).map(r => r.name);
    assert.deepEqual(changed.sort(), FINANCE.map(k => 'public.' + k).sort());
    assert.deepEqual(await summary(), beforeSummary); assert.deepEqual(await snapshot(source), sourceBefore);
    assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance);
    assert.deepEqual(await validSnapshot(), valid); assert.deepEqual(await triggers(), modes);
  }));
  for (const started of [false, true]) test(`SQL51 ${role}: genuine READ ONLY plan/status started=${started}`, () => transaction(async () => {
    const p = await stage(finance, role); if (started) { await begin(p, {}, role); await apply(p, S.two, {}, role); }
    const frozen = await snapshot(), modes = await triggers(); await db.exec('SET TRANSACTION READ ONLY');
    common(await plan({}, role), p); const s = await status(null, {}, role); common(s, p); assert.equal(s.started, started);
    assert.equal(s.completed_employees, started ? 1 : 0); assert.equal(s.employee, null);
    for (const sourceId of EMPLOYEES) { const r = await status(sourceId, {}, role); common(r, p); assert.equal(r.employee.applied, started && sourceId === S.two); }
    assert.deepEqual(await status(null, {}, role), s); assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes);
  }));
}

test('SQL51 exact plan hash, unknown employees, incomplete and explicit repeat rules', () => transaction(async () => {
  const p = await stage(); const frozen = await snapshot();
  await assert.rejects(apply(p)); await assert.rejects(verify());
  for (const hash of [null, '', '0'.repeat(63), 'A'.repeat(64), '0'.repeat(64)]) await assert.rejects(begin(p, { p_plan_hash: hash }));
  assert.deepEqual(await snapshot(), frozen); await begin(p);
  for (const sourceId of [null, randomUUID(), bindings[S.one].target_id]) { await assert.rejects(apply(p, sourceId)); if (sourceId) await assert.rejects(status(sourceId)); }
  for (const hash of [null, '', '0'.repeat(64)]) await assert.rejects(apply(p, S.one, { p_plan_hash: hash }));
  await apply(p); await assert.rejects(verify(), { code: '22023' }); await apply(p, S.two); assert.equal((await verify()).verified, true); await noLegacy();
}));

for (const [label, extra] of [
  ['NULL session', () => ({ p_admin_session_token: null })], ['random session', () => ({ p_admin_session_token: randomUUID() })],
  ['secondary admin', () => ({ p_admin_session_token: branch })], ['emergency admin', () => ({ p_admin_session_token: emergency })],
  ['foreign root', () => ({ p_admin_session_token: other })], ['source session', () => ({ p_admin_session_token: sourceSession })],
  ['NULL job', () => ({ p_job_token: null })], ['random job', () => ({ p_job_token: randomUUID() })], ['shared job', () => ({ p_job_token: sharedTask.job_token })],
]) test(`SQL51 rejects ${label} on all seven RPCs without writes`, () => transaction(async () => { const p = await stage(); await begin(p); await apply(p, S.two); await denyAll(p, extra()); }));

for (const [label, sql, params] of [
  ['expired session', "UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=private.hash_financial_token($1)", () => [session]],
  ['revoked session', 'UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE token_hash=private.hash_financial_token($1)', () => [session]],
  ['idle job', "UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", () => [task.job_id]],
  ['absolute job age', "UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", () => [task.job_id]],
  ['failed job', "UPDATE private.employee_transfer_jobs SET status='failed' WHERE id=$1", () => [task.job_id]],
  ['wrong protocol', "UPDATE private.employee_transfer_jobs SET options=jsonb_set(options,'{import_protocol}','\"shared-import-v1\"') WHERE id=$1", () => [task.job_id]],
  ['missing maintenance', 'DELETE FROM private.employee_transfer_maintenance WHERE job_id=$1', () => [task.job_id]],
  ['missing backup seal', 'UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1', () => [task.job_id]],
  ['missing shared mapping', "UPDATE private.employee_transfer_jobs SET summary=summary-'shared_receipt' WHERE id=$1", () => [sharedTask.job_id]],
]) test(`SQL51 rechecks ${label} after one employee applied`, () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two); await db.query(sql, params()); await denyAll(p);
}));

for (const owner of ['inactive', 'secondary_admin', 'emergency_admin']) test(`SQL51 task owner ${owner} loses all privileges`, () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  await change('public.admins', owner === 'inactive' ? 'UPDATE public.admins SET is_active=false WHERE id=$1' : 'UPDATE public.admins SET role=$2 WHERE id=$1', owner === 'inactive' ? [NEW.root] : [NEW.root, owner]);
  await denyAll(p);
}));

test('SQL51 real cancel retains committed money and dirty maintenance, denies continuation', () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), money = await business();
  assert.equal((await rpc('employee_transfer_cancel', auth())).success, true);
  assert.deepEqual(await business(), money); assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance);
  await denyAll(p); await noLegacy();
}));

for (const missing of ['no valid', 'no identities', 'second identity missing', 'second identity not verified', 'no dependencies', 'dependencies not verified'])
  test(`SQL51 real unfinished prerequisite ${missing} cannot be replaced by supplied finance`, () => withClone(configuredDump, configuredTask, () => transaction(async () => {
    if (missing !== 'no valid') await restoreValid();
    if (missing !== 'no identities') await restoreIdentities(identity, EMPLOYEES, { omit: missing === 'second identity missing' ? S.two : null, incomplete: missing === 'second identity not verified' ? S.two : null });
    if (missing === 'dependencies not verified') await restoreDependencies({ incomplete: true });
    await denyAll({ plan_hash: '0'.repeat(64) }); await noLegacy();
  })));

for (const [label, mutate, reason] of [
  ['missing source wallet', () => change('public.wallets', 'DELETE FROM public.wallets WHERE user_id=$1', [S.two], source), 'source_employee_missing'],
  ['pending precision mismatch', () => change('public.wallets', 'UPDATE public.wallets SET frozen_balance=frozen_balance+0.00000000000000000000000000001 WHERE user_id=$1', [S.one], source), 'inconsistent_source_finance'],
  ['baseline formula mismatch', () => source.query('UPDATE public.wallet_balance_baselines SET total_income=total_income+1 WHERE user_id=$1', [S.one]), 'inconsistent_source_finance'],
]) test(`SQL51 source ${label} is a blocked plan, never auto-repaired`, () => sourceVariant(mutate, async () => {
  const before = await business(), p = await stage(); assert.equal(p.can_begin, false); assert.ok(p.conflicts.includes(reason));
  await assert.rejects(begin(p)); assert.deepEqual(await business(), before); await noLegacy();
}));

for (const [label, relation, sql, params] of [
  ['wallet amount', 'wallets', 'UPDATE public.wallets SET available_balance=available_balance+0.00000000000000000000000000001 WHERE user_id=$1', () => [bindings[S.one].target_id]],
  ['wallet NULL timestamp', 'wallets', "UPDATE public.wallets SET updated_at='2020-01-01T00:00:00Z' WHERE user_id=$1", () => [bindings[S.one].target_id]],
  ['baseline cursor', 'wallet_balance_baselines', 'UPDATE public.wallet_balance_baselines SET last_ledger_id=0 WHERE user_id=$1', () => [bindings[S.one].target_id]],
  ['ledger event', 'wallet_ledger_entries', "UPDATE public.wallet_ledger_entries SET event_type='negative-drift' WHERE user_id=$1", () => [bindings[S.one].target_id]],
  ['transaction memo', 'wallet_transactions', "UPDATE public.wallet_transactions SET remarks='negative-drift' WHERE id=$1", () => [S.tx]],
  ['withdrawal audit', 'withdrawals', "UPDATE public.withdrawals SET audited_at=COALESCE(audited_at,'2020-01-01')+interval '1 microsecond' WHERE id=$1", () => [S.pending]],
  ['reconciliation reason', 'wallet_reconciliation_audit', "UPDATE public.wallet_reconciliation_audit SET reason='negative-drift' WHERE user_id=$1", () => [bindings[S.one].target_id]],
  ['account remark', 'users', "UPDATE public.users SET remarks='negative-drift' WHERE id=$1", () => [bindings[S.one].target_id]],
  ['account password', 'users', "UPDATE public.users SET password_hash='negative-drift' WHERE id=$1", () => [bindings[S.one].target_id]],
  ['credential password', 'financial_employee_credentials', "UPDATE public.financial_employee_credentials SET password_hash='negative-drift' WHERE user_id=$1", () => [bindings[S.two].target_id]],
  ['order amount', 'orders', 'UPDATE public.orders SET commission_amount=commission_amount+1 WHERE id=$1', () => [id(100)]],
  ['member microsecond', 'dispatch_group_members', "UPDATE public.dispatch_group_members SET assigned_at=assigned_at+interval '1 microsecond' WHERE id=$1", () => [S.memberOne]],
  ['used order', 'used_order_data', 'UPDATE public.used_order_data SET order_id=$2 WHERE id=$1', () => [id(200), id(102)]],
  ['valid counter', 'valid_order_data', 'UPDATE public.valid_order_data SET usage_count=usage_count-1 WHERE id=$1', () => [S.validMax]],
  ['configuration field', 'dispatch_groups', "UPDATE public.dispatch_groups SET description='negative-drift' WHERE id=$1", async () => [(await summary()).dispatch_config_plan.group_map[S.group]]],
]) test(`SQL51 phase-aware guard still rejects same-count ${label} after financial verification`, () => transaction(async () => {
  const p = await stage(); await finish(p); const beforeCounts = (await business()).map(r => [r.name, r.n]);
  await change('public.' + relation, sql, await params()); assert.deepEqual((await business()).map(r => [r.name, r.n]), beforeCounts);
  await denyAll(p);
}));

for (const [label, sql] of [
  ['unknown wallet trigger', 'CREATE TRIGGER aa_mapped_finance_unknown BEFORE UPDATE ON public.wallets FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['unknown baseline trigger', 'CREATE TRIGGER aa_mapped_finance_unknown BEFORE INSERT ON public.wallet_balance_baselines FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['disabled ledger effect', 'ALTER TABLE public.wallet_transactions DISABLE TRIGGER trigger_track_wallet_transaction_ledger'],
  ['replica withdrawal effect', 'ALTER TABLE public.withdrawals ENABLE REPLICA TRIGGER trigger_track_withdrawal_ledger'],
  ['changed ledger function', 'ALTER FUNCTION public.track_wallet_transaction_in_ledger() SECURITY INVOKER'],
  ['disabled maintenance', 'ALTER TABLE public.wallets DISABLE TRIGGER zz_employee_transfer_maintenance'],
]) test(`SQL51 refuses ${label} without modifying money or modes`, () => transaction(async () => {
  const p = await stage(); await begin(p); await db.exec(sql); await denyAll(p, {}, { code: '22023' });
}));

for (const timezone of ['Asia/Taipei', 'America/New_York']) test(`SQL51 exact UTC comparisons under ${timezone} caller timezone`, () => transaction(async () => {
  const p = await stage(); await db.query("SELECT set_config('TimeZone',$1,true)", [timezone]);
  assert.deepEqual(await plan(), p); await finish(p); assert.equal((await status()).verified, true);
  assert.equal(await scalar(db, "SELECT current_setting('TimeZone')"), timezone); await db.exec("SET LOCAL TimeZone='UTC'"); await assertFinance();
}));

test('SQL51 genuine reconcile is a WRITE, locally permitted and isolated, performs zero monetary repairs', () => transaction(async () => {
  const p = await stage(); await finish(p);
  const money = () => rows(db, 'SELECT user_id,available_balance::text,frozen_balance::text FROM public.wallets ORDER BY user_id');
  const before = await money(), audits = await rows(db, 'SELECT user_id,count(*)::int AS n FROM public.wallet_reconciliation_audit GROUP BY user_id ORDER BY user_id');
  await db.query(`INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names)
    VALUES(pg_current_xact_id(),$1,ARRAY['public.wallet_balance_baselines','public.wallet_reconciliation_queue'])`, [task.job_id]);
  try {
    for (const sourceId of EMPLOYEES) {
      const r = await scalar(db, 'SELECT public.reconcile_wallet_from_ledger($1)', [bindings[sourceId].target_id]);
      if (sourceId === S.two) assert.equal(r.baseline_created, true); else assert.equal(r.repaired, false);
    }
  } finally { await db.exec('SELECT private.employee_transfer_clear_write_permit()'); }
  assert.deepEqual(await money(), before); assert.deepEqual(await rows(db, 'SELECT user_id,count(*)::int AS n FROM public.wallet_reconciliation_audit GROUP BY user_id ORDER BY user_id'), audits);
  assert.equal(await permits(), 0);
  // The legacy account now has a baseline; do not pretend the import verifier is
  // still unchanged. This whole local reconcile experiment is rolled back.
}));

for (const cursor of ['0', '1', S.cursor, '9223372036854775807']) test(`SQL51 baseline cursor ${cursor}: none/first/exact/above maximum translates by numeric order`, () => sourceVariant(async () => {
  await source.query(`UPDATE public.wallet_balance_baselines b SET last_ledger_id=$2::bigint,
    available_balance=w.available_balance+w.frozen_balance-COALESCE((SELECT sum(available_delta+frozen_delta) FROM public.wallet_ledger_entries WHERE user_id=b.user_id AND id>$2::bigint),0),
    frozen_balance=0,total_income=u.total_income-COALESCE((SELECT sum(income_delta) FROM public.wallet_ledger_entries WHERE user_id=b.user_id AND id>$2::bigint),0)
    FROM public.wallets w,public.users u WHERE b.user_id=$1 AND w.user_id=b.user_id AND u.id=b.user_id`, [S.one, cursor]);
}, async input => {
  const p = await stage(); assert.equal(p.can_begin, true); await finish(p); await assertFinance(input.expected);
  const target = bindings[S.one].target_id;
  if (cursor === '0') assert.equal(await scalar(db, 'SELECT last_ledger_id::text FROM public.wallet_balance_baselines WHERE user_id=$1', [target]), '0');
  if (cursor === '9223372036854775807') assert.equal(await scalar(db, 'SELECT last_ledger_id=(SELECT max(id) FROM public.wallet_ledger_entries WHERE user_id=$1) FROM public.wallet_balance_baselines WHERE user_id=$1', [target]), true);
}));

test('SQL51 unrelated target ledger and audit retain IDs/content while fresh IDs never overlap', () => transaction(async () => {
  // Local business fixture, not a manufactured transfer state or an identity candidate.
  await change('public.wallet_ledger_entries', `INSERT INTO public.wallet_ledger_entries(user_id,operation_id,source_type,source_id,event_type,available_delta)
    VALUES($1,$2,'wallet_transaction',$3,'unrelated',19)`, [S.unrelated, id(990), id(991)]);
  await change('public.wallet_reconciliation_audit', `INSERT INTO public.wallet_reconciliation_audit(user_id,available_before,available_after,frozen_before,frozen_after,income_before,income_after,pending_amount,ledger_total,reason)
    VALUES($1,0,19,0,0,0,0,0,19,'unrelated')`, [S.unrelated]);
  const originals = {};
  for (const key of ['wallet_ledger_entries', 'wallet_reconciliation_audit']) originals[key] = await rows(db, `SELECT id::text,to_jsonb(r)::text AS body FROM public.${key} r WHERE user_id=$1 ORDER BY id`, [S.unrelated]);
  const p = await stage(); assert.equal(p.can_begin, true); await finish(p); await assertFinance();
  for (const key of ['wallet_ledger_entries', 'wallet_reconciliation_audit']) {
    assert.deepEqual(await rows(db, `SELECT id::text,to_jsonb(r)::text AS body FROM public.${key} r WHERE user_id=$1 ORDER BY id`, [S.unrelated]), originals[key]);
    assert.equal(await scalar(db, `SELECT min(id)>$2::bigint FROM public.${key} WHERE user_id=ANY($1::uuid[])`, [EMPLOYEES.map(k => bindings[k].target_id), originals[key][0].id]), true);
  }
}));

for (const [label, mutate] of [
  ['existing wallet transaction has another owner', () => source.query('UPDATE public.wallet_ledger_entries SET source_id=$2 WHERE user_id=$1 AND source_type=\'wallet_transaction\'', [S.two, S.tx])],
  ['existing withdrawal has another owner', () => source.query('UPDATE public.wallet_ledger_entries SET source_id=$2 WHERE user_id=$1 AND source_type=\'withdrawal\'', [S.two, S.pending])],
]) test(`SQL51 historical event references reject ${label} but golden deleted events remain valid`, () => sourceVariant(mutate, async () => {
  const p = await stage(); assert.equal(p.can_begin, false); assert.ok(p.conflicts.includes('inconsistent_source_finance'));
  await assert.rejects(begin(p)); await noLegacy();
}));

test('SQL51 missing same-package administrator is unmapped_administrator, never NULL/root substitution', () => sourceVariant(async () => {
  await source.query("INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,'unmapped-finance-admin','local-only','secondary_admin',false)", [S.unknownAdmin]);
  await change('public.wallet_transactions', 'UPDATE public.wallet_transactions SET created_by=$1 WHERE id=$2', [S.unknownAdmin, S.tx], source);
}, async () => {
  const p = await stage(); assert.equal(p.can_begin, false); assert.deepEqual(p.conflicts, ['unmapped_administrator']); await assert.rejects(begin(p));
}));

for (const [label, key, sql, args, reason] of [
  ['nonzero candidate wallet', 'wallets', 'UPDATE public.wallets SET available_balance=1 WHERE user_id=$1', () => [bindings[S.two].target_id], 'financial_target_not_empty'],
  ['candidate transaction residual', 'wallet_transactions', "INSERT INTO public.wallet_transactions(id,user_id,type,amount,balance_before,balance_after) VALUES($1,$2,'manual_adjustment',0,0,0)", () => [id(950), bindings[S.two].target_id], 'financial_target_not_empty'],
  ['transaction UUID', 'wallet_transactions', "INSERT INTO public.wallet_transactions(id,user_id,type,amount,balance_before,balance_after) VALUES($1,$2,'manual_adjustment',0,0,0)", () => [S.tx, S.unrelated], 'financial_uuid_collision'],
  ['withdrawal UUID', 'withdrawals', "INSERT INTO public.withdrawals(id,user_id,amount,status) VALUES($1,$2,1,'cancelled')", () => [S.pending, S.unrelated], 'financial_uuid_collision'],
  ['transaction operation/type unique', 'wallet_transactions', "INSERT INTO public.wallet_transactions(id,user_id,type,amount,balance_before,balance_after,reference_id,operation_id) VALUES($1,$2,'commission',32,0,32,$3,$4)", () => [id(951), S.unrelated, id(100), id(700)], 'financial_unique_collision'],
  ['ledger operation unique', 'wallet_ledger_entries', "INSERT INTO public.wallet_ledger_entries(user_id,operation_id,source_type,source_id,event_type) VALUES($1,$2,'wallet_transaction',$3,'before')", () => [S.unrelated, id(710), S.tx], 'financial_unique_collision'],
]) test(`SQL51 ${label} is never overwritten, unioned or silently skipped`, () => transaction(async () => {
  await unrelatedEmployee(); await stage(); await change('public.' + key, sql, args()); const frozen = await business(), p = await plan(); common(p);
  assert.equal(p.can_begin, false); assert.ok(p.conflicts.includes(reason)); await assert.rejects(begin(p)); assert.deepEqual(await business(), frozen); await noLegacy();
}));

for (const key of FINANCE) test(`SQL51 every unfinished candidate must have no ${key} finance before another employee applies`, () => transaction(async () => {
  const p = await stage(); await begin(p); const target = bindings[S.two].target_id;
  if (key === 'wallets') await change('public.wallets', 'UPDATE public.wallets SET frozen_balance=1 WHERE user_id=$1', [target]);
  else {
    const input = expected[key][0];
    // Copy original PostgreSQL JSON text and only change ownership, never JS money.
    // For baseline/audit/ledger this remains a genuine target residual, not progress.
    const record = key === 'wallet_balance_baselines' ? "($1::jsonb-'id')||jsonb_build_object('user_id',$2::uuid)"
      : "$1::jsonb||jsonb_build_object('user_id',$2::uuid)";
    await change('public.' + key, `INSERT INTO public.${key} SELECT * FROM jsonb_populate_record(NULL::public.${key},${record})`, [input.body, target]);
  }
  await denyAll(p); assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key='mapped-finance-done-v1'", [task.job_id]), 0);
}));

for (const fault of ['constraint', 'audit']) test(`SQL51 late ${fault} failure rolls back current employee only, retains a separately COMMITTED employee`, async () => {
  await withClone(readyDump, readyTask, async () => {
    let p; await transaction(async () => { p = await stage(); await begin(p); await apply(p, S.two); }, db, true);
    await transaction(async () => {
      if (fault === 'constraint') await db.exec(`ALTER TABLE public.wallet_reconciliation_audit ADD CONSTRAINT mapped_finance_late_constraint CHECK(user_id<>'${bindings[S.one].target_id}'::uuid) NOT VALID`);
      else await db.exec(`CREATE FUNCTION public.mapped_finance_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action LIKE '%finance%' THEN RAISE EXCEPTION 'mapped finance final audit failed'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER mapped_finance_late_failure BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.mapped_finance_late_failure()`);
      const frozen = await snapshot(), modes = await triggers(); await assert.rejects(apply(p), { code: '22023' });
      assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.equal(await permits(), 0);
      assert.equal((await status(S.two)).employee.applied, true); assert.equal((await status(S.one)).employee.applied, false);
      assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1 AND employee_id=$2 AND table_key LIKE 'mapped-finance-map:%'", [task.job_id, S.one]), 0);
      if (fault === 'constraint') await db.exec('ALTER TABLE public.wallet_reconciliation_audit DROP CONSTRAINT mapped_finance_late_constraint');
      else await db.exec('DROP TRIGGER mapped_finance_late_failure ON private.employee_transfer_events; DROP FUNCTION public.mapped_finance_late_failure()');
      await apply(p); assert.equal((await verify()).verified, true); await assertFinance(); await noLegacy();
    }, db, true);
  });
});

for (const key of [null, 'orders', 'finance-done', 'wallets;DROP TABLE users']) test(`SQL51 rejects unsupported stage key ${key}`, () => transaction(async () => {
  await bind(); const frozen = await snapshot(); await assert.rejects(stageChunk(key, 0, '')); assert.deepEqual(await snapshot(), frozen);
}));
for (const [label, mutate] of [
  ['duplicate JSON key', text => text.replace('{', '{"user_id":"' + S.one + '",')],
  ['extra field', text => text.replace('{', '{"unreviewed":1,')],
  ['missing newline', text => text.slice(0, -1)],
  ['numeric converted to JS-like quoted string', text => text.replace(/"available_balance": [0-9.]+/, '"available_balance": "1.0"')],
]) test(`SQL51 rejects stage ${label}`, () => transaction(async () => {
  await bind(); const frozen = await snapshot(); await assert.rejects(stageChunk('wallets', 0, mutate(lines(finance.texts.wallets)[0]))); assert.deepEqual(await snapshot(), frozen);
}));

test('SQL51 exact catalog binding and source-package mismatch are immutable', () => transaction(async () => {
  for (const patch of [{ package_id: randomUUID() }, { site_id: randomUUID() }, { unexpected: true }, { full_site_complete: true }])
    await assert.rejects(bind({ catalog: { ...finance.catalog, ...patch } }));
  const r = await bind(), frozen = await snapshot(); assert.deepEqual(await bind(), r); assert.deepEqual(await snapshot(), frozen);
  await assert.rejects(bind({ catalog: { ...finance.catalog, tables: finance.catalog.tables.map((t, n) => n ? t : { ...t, rows: t.rows + 1 }) } }));
}));

test('SQL51 legacy SQL49/50 and old finance remain safely blocked after real money restore', () => transaction(async () => {
  const p = await stage(); await finish(p); await noLegacy();
  for (const sourceId of EMPLOYEES) for (const op of ['plan', 'status', 'verify', 'core', 'orders']) await assert.rejects(rpc('employee_import_mapped_identity_' + op,
    { ...auth(), p_source_id: sourceId, ...op === 'core' ? { p_plan_hash: p.plan_hash } : op === 'orders' ? { p_chunk_no: 0 } : {} }));
  for (const op of ['plan', 'status', 'begin', 'chunk', 'verify']) await assert.rejects(rpc('employee_import_mapped_dependency_' + op,
    { ...auth(), ...op === 'begin' ? { p_plan_hash: p.plan_hash } : op === 'chunk' ? { p_table_key: 'used_order_data', p_chunk_no: 0 } : {} }));
  for (const [name, extra] of [['employee_import_finance_bind', { p_catalog: finance.catalog }],
    ['employee_import_finance_stage', { p_table_key: 'wallets', p_chunk_no: 0, p_ndjson: finance.texts.wallets }],
    ['get_employee_import_finance_plan', {}], ['employee_import_finance_apply', { p_employee_id: S.one, p_plan_hash: p.plan_hash }], ['employee_import_finance_verify', {}]])
    await assert.rejects(rpc(name, { ...auth(), ...extra }));
  await noLegacy(); assert.equal((await status()).verified, true);
}));

test('SQL51 zero employees: actual source export, real backups/configuration/valid/identity/dependency, all six explicit empty chunks', async () => {
  const empty = await transaction(async () => {
    for (const key of [...FINANCE].reverse().concat(['used_order_data', 'dispatch_group_members', 'orders', 'financial_employee_credentials', 'users']))
      await change('public.' + key, `DELETE FROM public.${key}`, [], source);
    return { dispatch: await capture('dispatch'), identity: await capture('identity'), finance: await capture('finance') };
  }, source);
  const old = finance; finance = empty.finance;
  try { await withClone(sharedDump, null, () => transaction(async () => {
    await configure(empty.dispatch); await restoreValid(); await restoreIdentities(empty.identity, []); await restoreDependencies();
    const p = await stage(); common(p); assert.equal(p.can_begin, true); assert.equal(p.employees, 0);
    assert.deepEqual(p.totals, Object.fromEntries(FINANCE.map(k => [k, 0]))); assert.deepEqual(p.pending_withdrawals, { count: 0, amount: '0' });
    await begin(p); assert.equal((await verify()).verified, true); assert.equal((await status()).completed_employees, 0); await noLegacy();
    for (const key of FINANCE) assert.equal(await scalar(db, `SELECT count(*)::int FROM public.${key}`), 0);
  })); } finally { finance = old; }
});

// These negative paths follow the ACTUAL SQL51 catalog/parse/saved/phase/check_written
// structures read from the migration, not a presumed financeApi/legacy summary shape.
for (const key of FINANCE) for (const field of ['ndjson', 'rows', 'bytes', 'row_hashes', 'last_id'])
  test(`SQL51 raw-vs-parsed rescan rejects ${key}.${field} after another employee applies`, () => transaction(async () => {
    const p = await stage(); await begin(p); await apply(p, S.two);
    const expression = field === 'rows' ? "jsonb_set(payload,'{rows,0,user_id}',to_jsonb($3::text))"
      : field === 'ndjson' ? "jsonb_set(payload,'{ndjson}',to_jsonb((payload->>'ndjson')||E'\\n'))"
        : field === 'bytes' ? "jsonb_set(payload,'{bytes}',to_jsonb((payload->>'bytes')::integer+1))"
          : field === 'last_id' ? "jsonb_set(payload,'{last_id}','null'::jsonb)"
            : "jsonb_set(payload,'{row_hashes}',to_jsonb(repeat('0',length(payload->>'row_hashes'))))";
    await db.query(`UPDATE private.employee_transfer_staging SET payload=${expression} WHERE job_id=$1 AND table_key=$2 AND chunk_no=0`,
      [task.job_id, 'mapped-finance-in:' + key, ...field === 'rows' ? [S.unrelated] : []]);
    await denyAll(p);
  }));

for (const [path, value] of [
  [['identity_map'], {}], [['admin_map'], {}], [['completed_employees'], 0], [['completed_employees'], '1'], [['verified'], true], [['verified'], 'false'],
  ...['scope', 'job_id', 'site_id', 'source_site_id', 'package_id', 'catalog_hash', 'mapping_hash', 'plan_hash'].map(k => [['plan', k], k.endsWith('hash') ? '0'.repeat(64) : k === 'scope' ? 'forged' : id(980)]),
  ...GATES.map(k => [['plan', k], true]), ...['maintenance', 'dependencies_pending', 'financial_data_pending'].map(k => [['plan', k], false]),
  [['plan', 'employees'], 1], [['plan', 'totals', 'wallets'], 0], [['plan', 'pending_withdrawals', 'amount'], '0'],
  [['plan', 'can_begin'], false], [['plan', 'conflicts'], ['unmapped_administrator']],
]) test(`SQL51 private saved state ${path.join('.')}=${JSON.stringify(value)} cannot fake authorization or completion`, () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  await db.query('UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$3::text[],$4::jsonb) WHERE job_id=$1 AND table_key=$2', [task.job_id, STATE, path, JSON.stringify(value)]);
  await denyAll(p);
}));

for (const [path, value] of [
  [['source_id'], S.one], [['target_id'], S.two], [['plan_hash'], '0'.repeat(64)], [['counts', 'wallets'], 0], [['counts', 'wallets'], '1'],
]) test(`SQL51 completion state ${path.join('.')} is reverified against actual source/target`, () => transaction(async () => {
  const p = await stage(); await begin(p); await apply(p, S.two);
  await db.query("UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$3::text[],$4::jsonb) WHERE job_id=$1 AND employee_id=$2 AND table_key='mapped-finance-done-v1'", [task.job_id, S.two, path, JSON.stringify(value)]);
  await denyAll(p);
}));

for (const [key, path, value] of [
  ['wallet_ledger_entries', ['0', 'old_id'], '9223372036854775807'], ['wallet_ledger_entries', ['0', 'new_id'], '9223372036854775807'],
  ['wallet_ledger_entries', ['0', 'new_id'], 1], ['wallet_reconciliation_audit', ['0', 'old_id'], '1'], ['wallet_reconciliation_audit', ['0', 'new_id'], '0'],
]) test(`SQL51 actual bigint map ${key}.${path.join('.')}=${JSON.stringify(value)} cannot substitute a row`, () => transaction(async () => {
  const p = await stage(); await finish(p);
  const keyName = 'mapped-finance-map:' + key;
  assert.ok(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1 AND employee_id=$2 AND table_key=$3', [task.job_id, S.one, keyName]), 'required full-table-key map namespace absent');
  await db.query('UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$4::text[],$5::jsonb) WHERE job_id=$1 AND employee_id=$2 AND table_key=$3 AND chunk_no=0', [task.job_id, S.one, keyName, path, JSON.stringify(value)]);
  await denyAll(p);
}));

for (const key of ['mapped-finance-catalog-v1', STATE, 'mapped-finance-done-v1', 'mapped-finance-in:wallets'])
  for (const field of ['employee_id', 'chunk_no', 'row_count']) test(`SQL51 namespace/shape ${key}.${field} is never silently selected or ignored`, () => transaction(async () => {
    const p = await stage(); await begin(p); await apply(p, S.two);
    const assignment = field === 'employee_id' ? `employee_id='${S.unrelated}'` : field === 'chunk_no' ? 'chunk_no=999' : 'row_count=row_count+1';
    await db.query(`UPDATE private.employee_transfer_staging SET ${assignment} WHERE job_id=$1 AND table_key=$2 AND chunk_no=0`, [task.job_id, key]);
    await denyAll(p);
  }));

for (const [label, sql, params] of [
  ['missing SQL48 reservation', "DELETE FROM private.employee_transfer_staging WHERE job_id=$1 AND employee_id=$2 AND table_key='identity-reservation-v1'", () => [task.job_id, S.two]],
  ['SQL49 verified flag removed', "UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{verified}','false') WHERE job_id=$1 AND employee_id=$2 AND table_key='mapped-identity-v1'", () => [task.job_id, S.two]],
  ['SQL49 candidate swapped', "UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{plan,target_id}',to_jsonb($3::text)) WHERE job_id=$1 AND employee_id=$2 AND table_key='mapped-identity-v1'", () => [task.job_id, S.two, bindings[S.one].target_id]],
  ['SQL50 verified flag removed', "UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{verified}','false') WHERE job_id=$1 AND table_key='mapped-dependencies-v1'", () => [task.job_id]],
  ['SQL50 identity map removed', "UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{identity_map}','{}') WHERE job_id=$1 AND table_key='mapped-dependencies-v1'", () => [task.job_id]],
  ['catalog package tampered', "UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{package_id}',to_jsonb($2::text)) WHERE job_id=$1 AND table_key='mapped-finance-catalog-v1'", () => [task.job_id, randomUUID()]],
]) test(`SQL51 retains upstream trust checks after finance: ${label}`, () => transaction(async () => {
  const p = await stage(); await finish(p); await db.query(sql, params()); await denyAll(p);
}));

for (const legacy of ['identity_restore', 'dependency_restore', 'finance_restore', 'finance_plan', 'finance_catalog', 'verified_identity_map'])
  test(`SQL51 refuses old ${legacy} even as an empty object`, () => transaction(async () => {
    const p = await stage(); await begin(p);
    await db.query("UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,$2::text[],'{}'::jsonb) WHERE id=$1", [task.job_id, [legacy]]); await denyAll(p);
  }));

test('SQL51 all RPCs reject caller-supplied target/map/rows/backup-proof parameters at SQL signature level', () => transaction(async () => {
  const p = await stage(); await begin(p); const frozen = await snapshot();
  for (const op of OPERATIONS) for (const [arg, type, value] of [['p_target_id', 'uuid', S.unrelated], ['p_identity_map', 'jsonb', '{}'], ['p_rows', 'jsonb', '[]'], ['p_backup_verified', 'boolean', true]]) {
    const names = await scalar(db, 'SELECT proargnames FROM pg_proc WHERE pronamespace=\'public\'::regnamespace AND proname=$1', [PREFIX + op]);
    const types = await scalar(db, 'SELECT ARRAY(SELECT format_type(t,NULL) FROM unnest(proargtypes::oid[]) t) FROM pg_proc WHERE pronamespace=\'public\'::regnamespace AND proname=$1', [PREFIX + op]);
    const args = { ...auth(), ...argsFor(op, p) }, params = names.map(name => types[names.indexOf(name)] === 'jsonb' ? JSON.stringify(args[name]) : args[name]);
    params.push(value); const point = `extra_finance_${++counter}`; await db.exec(`SAVEPOINT ${point}`);
    try { await db.exec('SET LOCAL ROLE anon'); await assert.rejects(db.query(`SELECT public.${PREFIX + op}(${names.map((n, i) => `${n}=>$${i + 1}::${types[i]}`).join(',')},${arg}=>$${params.length}::${type})`, params), { code: '42883' }); }
    finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
  }
  assert.deepEqual(await snapshot(), frozen); await noLegacy();
}));

test('SQL51 empty finance history with two real employees still explicitly stages all six tables', () => sourceVariant(async () => {
  for (const key of FINANCE.filter(k => k !== 'wallets')) await change('public.' + key, `DELETE FROM public.${key}`, [], source);
  await change('public.wallets', 'UPDATE public.wallets SET available_balance=0,frozen_balance=0', [], source);
}, async input => {
  await bind(); await stageChunk('wallets', 0, finance.texts.wallets);
  await assert.rejects(plan(), { code: '22023' });
  for (const key of FINANCE.filter(k => k !== 'wallets')) await stageChunk(key, 0, '');
  const p = await plan(); common(p); assert.equal(p.can_begin, true); await finish(p); await assertFinance(input.expected);
}));

test('SQL51 true COMMIT then dropped apply response resumes by status from a separate database dump', async () => {
  await withClone(readyDump, readyTask, async () => {
    let p; await transaction(async () => { p = await stage(); await begin(p); }, db, true);
    let writes = 0;
    async function loseApply() { await transaction(async () => { await apply(p, S.one); writes++; }, db, true); throw new Error('local response lost AFTER COMMIT'); }
    await assert.rejects(loseApply(), /AFTER COMMIT/); assert.equal(writes, 1);
    const committed = await db.dumpDataDir('none');
    await withClone(committed, readyTask, () => transaction(async () => {
      const r = await status(S.one); common(r, p); assert.equal(r.completed_employees, 1); assert.equal(r.employee.applied, true);
      assert.equal((await status(S.two)).employee.applied, false);
      const frozen = await snapshot(); assert.deepEqual(await apply(p), r); assert.deepEqual(await snapshot(), frozen);
      await apply(p, S.two); assert.equal((await verify()).verified, true); await assertFinance(); await noLegacy();
    }, db, true));
  });
});
assert.ok(selectedCases > 0, 'The explicit test range selected no cases.');
if (range) assert.ok(range[1] <= caseNo, `Range ends beyond the ${caseNo} available cases.`);
