import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createSites, adminLogin, rpc as baseRpc, rows, scalar } from './support/transfer-harness.mjs';
import { NEW, OLD, PASSWORDS, buildNewSite } from './support/transfer-fixtures.mjs';

// Run directly with node --test. Do not skip absent/broken 19–22 or extend the 12-failure baseline.
const migration = '20261102000022_restore_employee_verification_media.sql';
const KEYS = {
  shared: ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'],
  dispatch: ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'],
  identity: ['accounts', 'credentials', 'orders'],
  finance: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit'],
  activity: ['employee_login_history', 'work_sessions', 'work_stop_markers'],
  verification: ['verification_requests'],
};
const ACTIVITY = ['public.employee_login_history', 'public.work_sessions', 'private.employee_work_stop_markers'];
const FLAGS = { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
const id = n => `72000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const F = { history: id(1), noHeartbeat: id(2), empty: id(3), outsider: id(999), login: id(1001), running: id(2205), noHeartbeatWork: id(3001) };
const EMPLOYEES = [F.history, F.noHeartbeat, F.empty];
const PRECISE = '12345678901234567890.12345678901234567890';
const SOURCE_SESSION = id(8001);
const hash = text => createHash('sha256').update(text).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
function chunks(text) {
  const result = []; let part = '', count = 0;
  for (const line of lines(text)) {
    if (count === 200 || Buffer.byteLength(part + line) > 262144) { result.push(part); part = ''; count = 0; }
    part += line; count++;
  }
  if (part || !result.length) result.push(part);
  return result;
}
let replay, source, db, session, sourceSession, branch, emergency, other, modules;
let packageId, dispatch, identity, finance, activity, verification, task, guarded;
let sequence = 0;
async function transaction(fn, site = db, commit = false) {
  await site.exec('BEGIN');
  try { const result = await fn(); await site.exec(commit ? 'COMMIT' : 'ROLLBACK'); return result; }
  catch (error) { await site.exec('ROLLBACK'); throw error; }
}
// A rejected anon request must not poison the surrounding negative-test transaction.
async function on(site, name, args, role = 'anon') {
  const point = `activity_${++sequence}`;
  await site.exec(`SAVEPOINT ${point}`);
  try {
    assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
    await site.exec(`SET LOCAL ROLE ${role}`);
    const result = await baseRpc(site, name, args, { role: null });
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`);
    return result;
  } catch (error) { await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); throw error; }
}
const rpc = (name, args) => on(db, name, args);
const auth = (job = task, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
const permits = () => scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits');
const state = () => scalar(db, 'SELECT summary FROM private.employee_transfer_jobs WHERE id=$1', [task.job_id]);
const flags = value => { for (const [key, expected] of Object.entries(FLAGS)) assert.equal(value[key], expected, key); };
const bind = (input = activity, extra = {}) => rpc('employee_import_activity_bind', { ...auth(), p_catalog: input.catalog, ...extra });
const plan = (extra = {}) => rpc('get_employee_import_activity_plan', { ...auth(), ...extra });
const apply = (p, employee = F.history, extra = {}) => rpc('employee_import_activity_apply', { ...auth(), p_employee_id: employee, p_plan_hash: p.plan_hash, ...extra });
const verify = (extra = {}) => rpc('employee_import_activity_verify', { ...auth(), ...extra });
const stageChunk = (key, no, text, extra = {}) => rpc('employee_import_activity_stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text, ...extra });
async function stage(input = activity) {
  await bind(input);
  for (const key of KEYS.activity) for (const [no, text] of chunks(input.texts[key]).entries()) {
    const receipt = await stageChunk(key, no, text);
    assert.equal(receipt.rows, lines(text).length); assert.equal(receipt.bytes, Buffer.byteLength(text)); assert.equal(receipt.sha256, hash(text));
  }
  return plan();
}
async function restore(p) { for (const employee of EMPLOYEES) await apply(p, employee); return verify(); }
const business = (site = db, outsideActivity = false) => rows(site, guarded.filter(name => !outsideActivity || !ACTIVITY.includes(name)).map(name =>
  `SELECT '${name}' AS name,count(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} AS r`).join(' UNION ALL '));
const triggers = () => rows(db, `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,private.employee_transfer_trigger_digest(t.oid) AS digest
  FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid JOIN pg_namespace AS n ON n.oid=c.relnamespace
  WHERE NOT t.tgisinternal AND (n.nspname='public' OR (n.nspname='private' AND c.relname='employee_work_stop_markers')) ORDER BY n.nspname,c.relname,t.tgname`);
async function stillClosed() {
  assert.equal(await permits(), 0);
  assert.equal(await scalar(db, `SELECT count(*)::int FROM public.users WHERE id=ANY($1::uuid[]) AND (is_active IS DISTINCT FROM false
    OR current_session_token IS NOT NULL OR current_tab_id IS NOT NULL OR session_created_at IS NOT NULL OR last_heartbeat_at IS NOT NULL)`, [EMPLOYEES]), 0);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.employee_financial_sessions WHERE user_id=ANY($1::uuid[])', [EMPLOYEES]), 0);
  assert.deepEqual(await rpc('get_employee_transfer_maintenance', { p_admin_session_token: session }),
    { active: true, job_id: task.job_id, dirty: true, full_site_complete: false });
}
function transport(site = db, token = session) {
  modules.setHarness({ token, rpc(name, args) {
    const query = { abortSignal() { return query; }, then(resolve, reject) { return on(site, name, args).then(data => ({ data, error: null })).then(resolve, reject); } };
    return query;
  } });
}
async function capture(kind, { completeMedia = true } = {}) {
  const sourceBefore = ['activity', 'verification'].includes(kind) ? await business(source) : null;
  const job = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
    ...(['identity', 'finance', 'activity', 'verification'].includes(kind) ? { p_package_id: packageId } : {}) });
  assert.equal(job.success, true);
  const texts = {}, pages = {};
  for (const key of KEYS[kind]) {
    let text = '', after = null; pages[key] = [];
    do {
      const page = await on(source, `get_employee_export_${kind}_page`, { ...auth(job, sourceSession), p_table_key: key, p_after: after, p_limit: 200 });
      assert.equal(page.sha256, hash(page.ndjson)); assert.equal(page.count, lines(page.ndjson).length);
      assert.ok(page.count <= 200); assert.ok(Buffer.byteLength(page.ndjson) <= 262144);
      if (kind === 'activity') modules.validateActivityPage(page, key, after);
      pages[key].push(page.count); text += page.ndjson; after = page.next_after;
    } while (after !== null);
    texts[key] = text;
  }
  const files = kind === 'verification' ? syntheticMedia(texts.verification_requests) : undefined;
  // Keep raw fixtures available even when media SQL is broken. This branch explicitly cancels an
  // UNVERIFIED source task; it neither edits summary nor pretends files were downloaded/read back.
  if (kind === 'verification' && !completeMedia) await on(source, 'employee_transfer_cancel', auth(job, sourceSession));
  else {
    if (files) {
      await commitMedia(source, job, sourceSession, files, 'download');
      await commitMedia(source, job, sourceSession, files, 'recheck-export');
    }
    assert.equal((await on(source, `employee_export_${kind}_verify`, auth(job, sourceSession))).verified, true);
    await on(source, kind === 'shared' ? 'employee_transfer_cancel' : `employee_export_${kind}_close`, auth(job, sourceSession));
  }
  if (sourceBefore) assert.deepEqual(await business(source), sourceBefore);
  return { catalog: job.catalog, texts, pages, ...(files ? { files } : {}) };
}
async function* disk(path) {
  const file = await open(path, 'r');
  try { const bytes = Buffer.alloc(65521); for (;;) { const r = await file.read(bytes); if (!r.bytesRead) return; yield bytes.subarray(0, r.bytesRead); } }
  finally { await file.close(); }
}
// Use the real api.ts backup source (including frozen-descriptor verification), not a canned verified response.
async function prepare(kind, input) {
  transport();
  const client = kind === 'shared' ? modules.createSharedSettingsReplacementSession(packageId, PASSWORDS.root) : modules.createDispatchImportSession(packageId, PASSWORDS.root);
  await client.target.begin(input.catalog);
  for (const key of KEYS[kind]) for (const [no, text] of chunks(input.texts[key]).entries()) await client.target.stage(key, no, text);
  const p = await client.target.dryRun(), backup = await client.backup();
  const dir = await mkdtemp(join(tmpdir(), 'activity-db-backup-')), path = join(dir, 'independent.edx'), plain = new Map(); let opens = 0;
  try {
    const saved = await (kind === 'shared' ? modules.createReplacementBackup : modules.createDispatchBackup)(backup.descriptor, backup.source, {
      async append(name, bytes) { plain.set(name, [...(plain.get(name) ?? []), Buffer.from(bytes)]); },
      open(name) { return (async function* () { yield* plain.get(name) ?? []; })(); }, async abort() { plain.clear(); },
    }, {
      async write(stream) { const file = await open(path, 'wx'); try { for await (const bytes of stream) await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } },
      open() { opens++; return disk(path); },
    }, {
      append(no, hex) { assert.equal(opens, 2); return backup.receiver.append(no, hex); },
      seal(sha256, bytes) { return backup.receiver.seal(sha256, bytes); },
    }, 'local-activity-independent-backup-passphrase');
    assert.equal(opens, 2); assert.equal(plain.size, 0); assert.equal(saved.sealReceipt.success, true);
    const key = client.identity();
    assert.ok(await scalar(db, 'SELECT sealed_at IS NOT NULL AND byte_count>0 FROM private.employee_transfer_shared_backups WHERE id=$1', [key.jobId]));
    return { client, job: { job_id: key.jobId, job_token: key.jobToken }, plan: p };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function ready(prepared) {
  await rpc('employee_import_dispatch_enter_maintenance', { ...auth(), p_plan_hash: prepared.plan_hash, p_confirmation: '確認暫停業務並導入派單資料', p_admin_password: PASSWORDS.root });
  const config = await rpc('get_employee_import_dispatch_configuration_plan', auth());
  assert.equal((await rpc('employee_import_dispatch_apply_configuration', { ...auth(), p_plan_hash: config.plan_hash })).configuration_applied, true);
  const valid = await rpc('employee_import_dispatch_valid_begin', { ...auth(), p_plan_hash: config.plan_hash });
  for (let no = 0; no < valid.chunks; no++) await rpc('employee_import_dispatch_valid_chunk', { ...auth(), p_chunk_no: no });
  assert.equal((await rpc('employee_import_dispatch_valid_verify', auth())).verified, true);
  await rpc('employee_import_identity_bind', { ...auth(), p_catalog: identity.catalog });
  for (const key of KEYS.identity) for (const [no, text] of chunks(identity.texts[key]).entries()) await rpc('employee_import_identity_stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  const ip = await rpc('get_employee_import_identity_plan', auth()); assert.equal(ip.can_restore, true, JSON.stringify(ip.conflicts));
  const identities = await rpc('employee_import_identity_begin', { ...auth(), p_plan_hash: ip.plan_hash });
  for (const key of KEYS.identity) for (let no = 0; no < identities.chunks[key]; no++) await rpc('employee_import_identity_chunk', { ...auth(), p_table_key: key, p_chunk_no: no });
  assert.equal((await rpc('employee_import_identity_verify', auth())).verified, true);
  const dp = await rpc('get_employee_import_dispatch_dependency_plan', auth()); assert.equal(dp.can_restore, true);
  const dependencies = await rpc('employee_import_dispatch_dependency_begin', { ...auth(), p_plan_hash: dp.plan_hash });
  for (const key of ['dispatch_group_members', 'used_order_data']) for (let no = 0; no < dependencies.chunks[key]; no++) await rpc('employee_import_dispatch_dependency_chunk', { ...auth(), p_table_key: key, p_chunk_no: no });
  assert.equal((await rpc('employee_import_dispatch_dependency_verify', auth())).verified, true);
  await rpc('employee_import_finance_bind', { ...auth(), p_catalog: finance.catalog });
  for (const key of KEYS.finance) for (const [no, text] of chunks(finance.texts[key]).entries()) await rpc('employee_import_finance_stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  const fp = await rpc('get_employee_import_finance_plan', auth()); assert.equal(fp.can_restore, true, JSON.stringify(fp.conflicts));
  for (const employee of EMPLOYEES) assert.equal((await rpc('employee_import_finance_apply', { ...auth(), p_employee_id: employee, p_plan_hash: fp.plan_hash })).verified, true);
  const verified = await rpc('employee_import_finance_verify', auth()); assert.equal(verified.verified, true); assert.equal(verified.completed_employees, 3); flags(verified);
}
// Deliberate local drift only. Restore the actual saved O/A trigger states, never use replica mode or a write permit.
async function localChange(site, relation, sql, args = []) {
  const modes = await rows(site, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal ORDER BY tgname', [relation]);
  for (const t of modes) await site.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
  try { await site.query(sql, args); }
  finally { for (const t of modes) await site.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`); }
}
// Mutate untrusted activity files, not server verification/mapping state or the real identity catalog.
function changedInput(key, change) {
  const ordered = lines(change(activity.texts[key])).sort((a, b) => JSON.parse(a).id.localeCompare(JSON.parse(b).id)).join('');
  const texts = { ...activity.texts, [key]: ordered };
  return { texts, catalog: { ...activity.catalog, tables: KEYS.activity.map(key => ({ key, rows: lines(texts[key]).length,
    bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: hash(lines(texts[key]).map(hash).join('')) })) } };
}
const activityRows = (site, key) => rows(site, `SELECT to_jsonb(r)::text AS body FROM ${key === 'work_stop_markers' ?
  '(SELECT user_id AS id,user_id,stopped_at FROM private.employee_work_stop_markers)' : `public.${key}`} AS r ORDER BY id`);
async function assertRestored() {
  // Canonical SQL text compares every field without JSON.parse rounding device_info numeric values or timestamps.
  const siteId = activity.catalog.site_id;
  const expectedLogin = await rows(source, `SELECT (to_jsonb(r)||jsonb_build_object('session_id',CASE WHEN session_id IS NULL THEN NULL ELSE
    'history-'||encode(extensions.digest(convert_to($1||':'||user_id::text||':'||session_id,'UTF8'),'sha256'),'hex') END))::text AS body
    FROM public.employee_login_history AS r ORDER BY id`, [siteId]);
  assert.deepEqual(await activityRows(db, 'employee_login_history'), expectedLogin);
  assert.equal(await scalar(db, 'SELECT device_info IS NULL FROM public.employee_login_history WHERE id=$1', [id(1002)]), true);
  assert.equal(await scalar(db, "SELECT device_info IS NOT NULL AND device_info='null'::jsonb FROM public.employee_login_history WHERE id=$1", [id(1007)]), true);
  const expectedWork = await rows(source, `SELECT (to_jsonb(r)||CASE WHEN end_time IS NULL THEN jsonb_build_object(
    'end_time',GREATEST(start_time,COALESCE(last_heartbeat_at,start_time)),
    'duration_minutes',GREATEST(round(extract(epoch FROM (GREATEST(start_time,COALESCE(last_heartbeat_at,start_time))-start_time))/60)::int,0)) ELSE '{}'::jsonb END)::text AS body
    FROM public.work_sessions AS r ORDER BY id`);
  assert.deepEqual(await activityRows(db, 'work_sessions'), expectedWork);
  assert.deepEqual(await activityRows(db, 'work_stop_markers'), await activityRows(source, 'work_stop_markers'));
}

const SOURCE_ORIGIN = 'https://source.supabase.co';
const TARGET_ORIGIN = 'https://target.supabase.co';
const MEDIA_PREFIX = '/storage/v1/object/public/verification-documents';
const MEDIA_AUTH = 'employee_transfer_verification_media_authorize';
const MEDIA_COMMIT = 'employee_transfer_verification_media_commit';
const V = { first: id(4001), secondEmployee: id(4204), residual: id(4999) };
// Scope: SQL protocol tests only. These synthetic tuples simulate an Edge worker that has already
// validated bytes. SQL cannot prove Storage bytes, existence, MIME sniffing, upload or readback.
// The independent 227-case employee-transfer-verification-media.test.mjs covers the real Edge logic.
// Never fetch even the fake source.supabase.co URLs, write private receipts/maps, or forge verified.
function syntheticMedia(text) {
  const urls = new Set();
  for (const line of lines(text)) for (const field of ['id_front_url', 'id_back_url', 'selfie_url']) {
    const url = JSON.parse(line)[field]; if (url !== null) urls.add(url);
  }
  return [...urls].map(source_url => {
    const bytes = Buffer.from(`synthetic-offline-only:${source_url}`);
    return { key: hash(source_url), source_url, bytes: bytes.length, sha256: hash(bytes),
      content_type: source_url.endsWith('.jpg') ? 'image/jpeg' : source_url.endsWith('.png') ? 'image/png' : 'application/pdf' };
  }).sort((a, b) => a.key.localeCompare(b.key));
}
const mediaInventory = (site, job, token, direction) => on(site, 'get_employee_transfer_verification_media', { ...auth(job, token), p_direction: direction });
const mediaAuthorize = (site, job, token, action, key, role = 'service_role') => on(site, MEDIA_AUTH,
  { ...auth(job, token), p_action: action, p_object_key: key }, role);
const mediaCommit = (site, job, token, action, file, extra = {}, role = 'service_role') => on(site, MEDIA_COMMIT,
  { ...auth(job, token), p_action: action, p_object_key: file.key, p_bytes: file.bytes, p_sha256: file.sha256,
    p_content_type: file.content_type, p_storage_origin: ['download', 'recheck-export'].includes(action) ? SOURCE_ORIGIN : TARGET_ORIGIN, ...extra }, role);
async function commitMedia(site, job, token, files, action) {
  for (const file of files) {
    const context = await mediaAuthorize(site, job, token, action, file.key);
    assert.equal(context.key, file.key); assert.equal(context.source_url, file.source_url); assert.equal(context.bucket, 'verification-documents');
    const originalPath = file.source_url.split(MEDIA_PREFIX + '/')[1];
    if (context.direction === 'export') assert.equal(context.path, originalPath);
    else {
      const [folder, name] = originalPath.split('/');
      assert.equal(context.path, `${folder}/${name.slice(0, 36)}-transfer-${hash(`${job.job_id}:${file.key}`).slice(0, 32)}.${name.split('.').at(-1).toLowerCase()}`);
      assert.deepEqual(context.file, file);
    }
    const receipt = await mediaCommit(site, job, token, action, file);
    assert.deepEqual(receipt, { success: true, key: file.key, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, full_site_complete: false });
  }
}
const vbind = (input = verification, extra = {}) => rpc('employee_import_verification_bind', { ...auth(), p_catalog: input.catalog, ...extra });
const vchunk = (no, text, extra = {}) => rpc('employee_import_verification_stage', { ...auth(), p_table_key: 'verification_requests', p_chunk_no: no, p_ndjson: text, ...extra });
const vplan = (extra = {}) => rpc('get_employee_import_verification_plan', { ...auth(), ...extra });
const vapply = (p, employee = F.history, extra = {}) => rpc('employee_import_verification_apply', { ...auth(), p_employee_id: employee, p_plan_hash: p.plan_hash, ...extra });
const vverify = (extra = {}) => rpc('employee_import_verification_verify', { ...auth(), ...extra });
const vmediaBind = (files = verification.files, extra = {}) => rpc('employee_import_verification_media_bind', { ...auth(), p_files: files, ...extra });
async function vraw(input = verification) {
  await vbind(input);
  for (const [no, text] of chunks(input.texts.verification_requests).entries()) {
    const receipt = await vchunk(no, text);
    assert.equal(receipt.rows, lines(text).length); assert.equal(receipt.bytes, Buffer.byteLength(text)); assert.equal(receipt.sha256, hash(text));
  }
}
async function vstage(input = verification, { media = true } = {}) {
  // Every new import test first performs the genuine stage/apply/verify activity prerequisite.
  await restore(await stage()); await vraw(input);
  if (media) { await vmediaBind(input.files); await commitMedia(db, task, session, input.files, 'upload'); }
  return vplan();
}
async function vrestore(p, { recheck = true } = {}) {
  for (const employee of EMPLOYEES) await vapply(p, employee);
  if (recheck) await commitMedia(db, task, session, verification.files, 'recheck-import');
  return vverify();
}
function changedVerification(change) {
  const text = lines(verification.texts.verification_requests).map(line => JSON.stringify(change(JSON.parse(line))) + '\n').join('');
  return { texts: { verification_requests: text }, files: syntheticMedia(text), catalog: { ...verification.catalog,
    tables: [{ key: 'verification_requests', rows: lines(text).length, bytes: Buffer.byteLength(text), row_hashes_sha256: hash(lines(text).map(hash).join('')) }] } };
}
const voutside = () => business(db).then(values => values.filter(row => row.name !== 'public.verification_requests'));
const verifiedFlags = () => rows(db, 'SELECT id,is_verified FROM public.users WHERE id=ANY($1::uuid[]) ORDER BY id', [EMPLOYEES]);
async function expectedVerificationRows() {
  const adminMap = (await state()).identity_restore.admin_map;
  // Independently derive URL namespaces from job/key, not from private receipts or SQL's expected helper.
  return rows(source, `SELECT (to_jsonb(r)||jsonb_build_object('audited_by',$1::jsonb->>audited_by::text)||
    (SELECT jsonb_object_agg(field,CASE WHEN to_jsonb(r)->>field IS NULL THEN 'null'::jsonb ELSE to_jsonb(
      $2::text||'/storage/v1/object/public/verification-documents/'||split_part(split_part(to_jsonb(r)->>field,'/verification-documents/',2),'/',1)||'/'||
      r.user_id::text||'-transfer-'||left(encode(extensions.digest(convert_to($3::text||':'||encode(extensions.digest(convert_to(to_jsonb(r)->>field,'UTF8'),'sha256'),'hex'),'UTF8'),'sha256'),'hex'),32)||'.'||
      lower(substring(to_jsonb(r)->>field FROM '[.]([A-Za-z0-9]{1,8})$'))) END)
      FROM unnest(ARRAY['id_front_url','id_back_url','selfie_url']) AS f(field)))::text AS body FROM public.verification_requests AS r ORDER BY id`,
    [JSON.stringify(adminMap), TARGET_ORIGIN, task.job_id]);
}
async function assertVerificationRestored() {
  const expected = await expectedVerificationRows();
  assert.deepEqual(await rows(db, 'SELECT to_jsonb(r)::text AS body FROM public.verification_requests AS r ORDER BY id'), expected);
  assert.deepEqual(await verifiedFlags(), await rows(source, 'SELECT id,is_verified FROM public.users WHERE id=ANY($1::uuid[]) ORDER BY id', [EMPLOYEES]));
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.verification_requests'), 205);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM public.verification_requests WHERE id_front_url LIKE 'https://source.%' OR id_back_url LIKE 'https://source.%' OR selfie_url LIKE 'https://source.%'"), 0);
}

before(async () => {
  const noNetwork = () => assert.fail('activity/verification DB tests prohibit all network and real Storage access');
  mock.method(globalThis, 'fetch', noNetwork);
  for (const [object, methods] of [[http, ['request', 'get']], [https, ['request', 'get']], [net, ['connect', 'createConnection']], [tls, ['connect']]])
    for (const method of methods) mock.method(object, method, noNetwork);
  await access(new URL(`../migrations/${migration}`, import.meta.url));
  replay = await createSites({ upTo: migration }); source = replay.oldSite; db = replay.newSite;
  await db.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]); await buildNewSite(db);
  for (const [admin, name, role, password] of [[OLD.root, 'root', 'super_admin', PASSWORDS.root], [OLD.branch, 'branch', 'secondary_admin', PASSWORDS.branch]]) {
    await source.query("INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$4,true)", [admin, name, password, role]);
    await source.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [admin]);
  }
  await source.query('UPDATE public.dispatch_groups SET created_by=$1', [OLD.root]); await source.query('UPDATE public.dispatch_order_pools SET created_by=$1', [OLD.root]);
  for (const [employee, name] of [[F.history, 'activity-history'], [F.noHeartbeat, 'activity-no-heartbeat'], [F.empty, 'activity-empty']]) {
    await source.query("INSERT INTO public.users(id,username,password_hash,employee_id,created_by,total_income,is_active) VALUES($1,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$2,$4,0,true)", [employee, name, PASSWORDS.employee, OLD.branch]);
    await source.query('INSERT INTO public.dispatch_group_members(group_id,user_id,assigned_by) SELECT id,$1,$2 FROM public.dispatch_groups WHERE is_default', [employee, OLD.root]);
  }
  // Approved/pending/rejected requests must never be used to recompute this independent flag.
  await source.query('UPDATE public.users SET is_verified=(id=$1) WHERE id=ANY($2::uuid[])', [F.noHeartbeat, EMPLOYEES]);
  await source.query(`INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status,audit_remark,audited_by,audited_at,created_at,updated_at,id_front_url,id_back_url,selfie_url)
    SELECT ('72000000-0000-4000-8000-'||lpad(to_hex(4000+n),12,'0'))::uuid,
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
    FROM generate_series(1,205) AS x(n)`, [F.history, F.noHeartbeat, OLD.root, OLD.branch, SOURCE_ORIGIN + MEDIA_PREFIX]);
  await source.query(`UPDATE public.users SET current_session_token=$2,current_tab_id='source-tab-must-not-transfer',
    session_created_at=now(),last_heartbeat_at=now() WHERE id=$1`, [F.history, SOURCE_SESSION]);
  await source.query(`INSERT INTO public.employee_financial_sessions(user_id,token_hash,tab_id,session_marker,expires_at)
    VALUES($1,private.hash_financial_token($2),'source-tab-must-not-transfer',$2,now()+interval '1 day')`, [F.history, SOURCE_SESSION]);
  // No orders; legal zero wallets keep all finance checks real without copying its unrelated negative fixtures.
  await transaction(async () => {
    const disabled = await scalar(source, "SELECT private.employee_transfer_bypass_triggers(ARRAY['wallets','employee_login_history','work_sessions'])");
    await source.exec('DELETE FROM public.wallet_balance_baselines; DELETE FROM public.wallet_ledger_entries; UPDATE public.wallets SET available_balance=0,frozen_balance=0');
    await source.query(`INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,ip_address,user_agent,session_id,created_at,device_info)
      SELECT ('72000000-0000-4000-8000-'||lpad(to_hex(1000+n),12,'0'))::uuid,$1,'歷史名稱𠮷 é é','原員工號',
        CASE WHEN n%2=0 THEN 'logout' ELSE 'login' END,CASE WHEN n%2=0 THEN NULL ELSE '2001:db8::1' END,
        CASE WHEN n%2=0 THEN NULL ELSE E'UA \\n{} " \\t' END,CASE WHEN n%2=0 THEN NULL ELSE $2 END,
        CASE WHEN n=2 THEN NULL ELSE '2023-02-03T04:05:06.654321Z'::timestamptz END,
        CASE n WHEN 1 THEN ('{"id":"device","children":[{"id":"left","precise":'||$3||'},{"id":"right"}],"other":{"id":"nested"},"escaped":"{} [] : \\\""}')::jsonb
          WHEN 2 THEN NULL WHEN 7 THEN 'null'::jsonb WHEN 3 THEN '[]'::jsonb WHEN 4 THEN '"文字𠮷"'::jsonb WHEN 5 THEN $3::jsonb WHEN 6 THEN 'true'::jsonb ELSE '{}'::jsonb END
      FROM generate_series(1,205) AS x(n)`, [F.history, SOURCE_SESSION, PRECISE]);
    await source.query(`INSERT INTO public.work_sessions(id,user_id,start_time,end_time,duration_minutes,created_at,last_heartbeat_at)
      SELECT ('72000000-0000-4000-8000-'||lpad(to_hex(2000+n),12,'0'))::uuid,$1,
        '2023-01-01T00:00:00.123456Z'::timestamptz+n*interval '1 day',
        CASE WHEN n=205 THEN NULL ELSE '2023-01-01T00:01:30.123456Z'::timestamptz+n*interval '1 day' END,
        CASE WHEN n IN (2,205) THEN NULL ELSE 777 END,CASE WHEN n=2 THEN NULL ELSE '2020-01-02T03:04:05.654321Z'::timestamptz END,
        CASE WHEN n=2 THEN NULL ELSE '2023-01-01T00:01:30.123456Z'::timestamptz+n*interval '1 day' END
      FROM generate_series(1,205) AS x(n)`, [F.history]);
    await source.query("INSERT INTO public.work_sessions(id,user_id,start_time,end_time,duration_minutes,created_at,last_heartbeat_at) VALUES($1,$2,'2024-02-29T12:34:56.123456Z',NULL,999,NULL,NULL)", [F.noHeartbeatWork, F.noHeartbeat]);
    await source.query("INSERT INTO private.employee_work_stop_markers(user_id,stopped_at) VALUES($1,'2023-04-05T06:07:08.123456Z'),($2,'2024-02-29T12:34:56.654321Z')", [F.history, F.noHeartbeat]);
    await source.query('SELECT private.employee_transfer_restore_triggers($1::jsonb)', [JSON.stringify(disabled)]);
  }, source, true);
  await db.query("INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,'activity-other-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)", [id(900), PASSWORDS.root]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [id(900)]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency); other = await adminLogin(db, 'activity-other-root', PASSWORDS.root);
  guarded = await scalar(db, 'SELECT private.employee_transfer_guarded_tables()'); packageId = randomUUID();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const compiled = await build({ stdin: { contents: `export {createReplacementBackup} from './src/lib/employeeTransfer/replacementBackup.ts';
    export {createDispatchBackup} from './src/lib/employeeTransfer/dispatchBackup.ts';
    export {createSharedSettingsReplacementSession,createDispatchImportSession} from './src/lib/employeeTransfer/api.ts';
    export * from './src/lib/employeeTransfer/activityApi.ts'; export * from './src/lib/employeeTransfer/activityTransfer.ts';
    export {setHarness} from 'activity-db:state';`, resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020',
    plugins: [{ name: 'local-activity-anon-sql', setup(builder) {
      builder.onResolve({ filter: /^(?:activity-db:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'activity-db' }));
      builder.onLoad({ filter: /.*/, namespace: 'activity-db' }, ({ path }) => ({ contents: path === 'activity-db:state'
        ? 'let h;export const setHarness=x=>{h=x};export const current=()=>h;'
        : path === '../auth' ? 'import{current}from"activity-db:state";export const getAdminFinancialSessionToken=()=>current().token;'
          : 'import{current}from"activity-db:state";export const supabase={rpc:(...args)=>current().rpc(...args)};export const formatSupabaseError=e=>String(e?.message??e);' }));
    } }] });
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const shared = await transaction(() => capture('shared'), source, true);
  await transaction(async () => { const r = await prepare('shared', shared); assert.equal((await r.client.apply(r.plan.plan_hash)).success, true); await rpc('employee_transfer_cancel', auth(r.job)); }, db, true);
  dispatch = await transaction(() => capture('dispatch'), source, true); identity = await transaction(() => capture('identity'), source, true);
  finance = await transaction(() => capture('finance'), source, true); activity = await transaction(() => capture('activity'), source, true);
  verification = await transaction(() => capture('verification', { completeMedia: false }), source, true);
  assert.deepEqual(activity.catalog.identity_catalog, identity.catalog); assert.deepEqual(finance.catalog.identity_catalog, identity.catalog);
  // Commit this expensive authentic prerequisite chain once; individual activity tests roll back to it.
  await transaction(async () => { const r = await prepare('dispatch', dispatch); task = r.job; await ready(r.plan); await stillClosed(); }, db, true);
}, { timeout: 240000 });
after(async () => { try {
  assert.equal(globalThis.fetch.mock.callCount(), 0, 'no fetch, including fake Storage URLs');
  await Promise.all([source?.close(), db?.close()]);
} finally { mock.restoreAll(); } });

test('549 real migrations preserve exactly the 12 historical failures and install activity 19/20 and verification 21/22', () => {
  assert.equal(replay.files.length, 549); assert.equal(replay.failures.length, 12); assert.equal(replay.validation.freshDatabaseVerified, false); assert.equal(replay.files.at(-1), migration);
  for (const file of ['20261102000019_export_stage_employee_activity.sql', '20261102000020_restore_employee_activity.sql',
    '20261102000021_export_stage_employee_verification.sql']) assert.ok(replay.files.includes(file));
});
for (const [name, args] of [
  ['employee_export_activity_begin', ['p_admin_session_token', 'p_admin_password', 'p_package_id']],
  ['get_employee_export_activity_page', ['p_admin_session_token', 'p_job_token', 'p_table_key', 'p_after', 'p_limit']],
  ['employee_export_activity_verify', ['p_admin_session_token', 'p_job_token']], ['employee_export_activity_close', ['p_admin_session_token', 'p_job_token']],
  ['employee_import_activity_bind', ['p_admin_session_token', 'p_job_token', 'p_catalog']],
  ['employee_import_activity_stage', ['p_admin_session_token', 'p_job_token', 'p_table_key', 'p_chunk_no', 'p_ndjson']],
  ['get_employee_import_activity_plan', ['p_admin_session_token', 'p_job_token']],
  ['employee_import_activity_apply', ['p_admin_session_token', 'p_job_token', 'p_employee_id', 'p_plan_hash']], ['employee_import_activity_verify', ['p_admin_session_token', 'p_job_token']],
]) test(`${name} has fixed arguments, definer search path and explicit browser-only grants`, () => transaction(async () => {
  const functions = await rows(db, `SELECT proargnames,prosecdef,proconfig,has_function_privilege('anon',oid,'EXECUTE') AS anon,
    has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS everyone
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1`, [name]);
  assert.equal(functions.length, 1); const fn = functions[0]; assert.deepEqual(fn.proargnames, args); assert.equal(fn.prosecdef, true);
  assert.equal(fn.anon, true); assert.equal(fn.authenticated, true); assert.equal(fn.everyone, false); assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
  if (name === 'get_employee_export_activity_page') assert.equal(await scalar(db, "SELECT format_type(proargtypes[3],NULL) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1", [name]), 'text');
}));

test('real prerequisites are verified by their RPCs and retain the source-to-target administrator mapping', () => transaction(async () => {
  const summary = await state();
  for (const key of ['identity_restore', 'dependency_restore', 'finance_restore']) assert.equal(summary[key].verified, true, key);
  assert.equal(summary.identity_restore.admin_map[OLD.root], NEW.root); assert.ok(summary.identity_restore.admin_map[OLD.branch]);
  assert.notEqual(summary.identity_restore.admin_map[OLD.branch], OLD.branch);
  assert.equal(await scalar(db, 'SELECT created_by FROM public.users WHERE id=$1', [F.history]), summary.identity_restore.admin_map[OLD.branch]);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.orders'), 0); await stillClosed();
}));

test('raw activity pages preserve 11/7/3 fields, NULL/microseconds/nested numeric and hash historical session IDs', () => transaction(async () => {
  assert.deepEqual(activity.pages.employee_login_history, [200, 5]); assert.deepEqual(activity.pages.work_sessions, [200, 6]);
  assert.equal(activity.catalog.scope, 'employee-activity'); assert.deepEqual(activity.catalog.identity_catalog, finance.catalog.identity_catalog);
  assert.match(activity.texts.employee_login_history, new RegExp(PRECISE.replace('.', '\\.'))); assert.doesNotMatch(activity.texts.employee_login_history, new RegExp(SOURCE_SESSION));
  for (const [key, count] of [['employee_login_history', 11], ['work_sessions', 7], ['work_stop_markers', 3]]) {
    const text = activity.texts[key]; assert.equal(activity.catalog.tables.find(t => t.key === key).row_hashes_sha256, hash(lines(text).map(hash).join('')));
    for (const line of lines(text)) assert.equal(Object.keys(JSON.parse(line)).length, count);
  }
  const log = lines(activity.texts.employee_login_history).map(line => JSON.parse(line));
  assert.equal(log[0].session_id, `history-${hash(`${activity.catalog.site_id}:${F.history}:${SOURCE_SESSION}`)}`); assert.equal(log[1].session_id, null); assert.equal(log[1].created_at, null);
  assert.equal(log[1].device_info, null); assert.equal(log[1].device_info_is_sql_null, true);
  assert.equal(log[6].device_info, null); assert.equal(log[6].device_info_is_sql_null, false);
  assert.equal(log[0].device_info.children[0].id, 'left'); assert.equal(log[0].device_info.children[1].id, 'right');
  assert.equal(lines(activity.texts.work_sessions).filter(line => JSON.parse(line).end_time === null).length, 2);
  for (const line of lines(activity.texts.work_stop_markers)) { const r = JSON.parse(line); assert.equal(r.id, r.user_id); }
  assert.deepEqual(await rows(db, "SELECT attname FROM pg_attribute WHERE attrelid='private.employee_work_stop_markers'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum"), [{ attname: 'user_id' }, { attname: 'stopped_at' }]);
  assert.equal((await on(source, 'get_employee_transfer_log', { p_admin_session_token: sourceSession })).last_export_at, null);
}, source));

test('one employee transaction restores all activity fields, closes only running work and never changes money or outside-scope tables', () => transaction(async () => {
  const outside = await business(db, true), sourceBefore = await business(source), original = await triggers(), p = await stage();
  assert.deepEqual(p.counts, { employee_login_history: 205, work_sessions: 206, work_stop_markers: 2 }); assert.equal(p.employees, 3); assert.equal(p.running_work_sessions, 2);
  assert.equal(p.can_restore, true, JSON.stringify(p.conflicts)); assert.deepEqual(p.conflicts, []); assert.match(p.plan_hash, /^[0-9a-f]{64}$/); flags(p); assert.deepEqual(modules.validateActivityPlan(p), p);
  await assert.rejects(verify(), /incomplete/i);
  for (const employee of EMPLOYEES) {
    const receipt = await apply(p, employee); assert.equal(receipt.verified, true); flags(receipt); assert.equal(receipt.employee_id, employee);
    assert.deepEqual(await apply(p, employee), { ...receipt, repeated: true }); assert.equal(await permits(), 0);
    if (employee === F.empty) assert.deepEqual(receipt.counts, { employee_login_history: 0, work_sessions: 0, work_stop_markers: 0 });
  }
  const result = await verify(); assert.equal(result.completed_employees, 3); assert.deepEqual(result.counts, p.counts); flags(result);
  assert.deepEqual(await verify(), { ...result, repeated: true }); assert.deepEqual(await plan(), p); await assertRestored();
  assert.equal(await scalar(db, 'SELECT duration_minutes FROM public.work_sessions WHERE id=$1', [F.running]), 2);
  assert.equal(await scalar(db, 'SELECT duration_minutes FROM public.work_sessions WHERE id=$1', [F.noHeartbeatWork]), 0);
  assert.equal(await scalar(db, 'SELECT end_time=start_time AND last_heartbeat_at IS NULL FROM public.work_sessions WHERE id=$1', [F.noHeartbeatWork]), true);
  assert.equal(await scalar(db, 'SELECT duration_minutes FROM public.work_sessions WHERE id=$1', [id(2001)]), 777);
  assert.equal(await scalar(db, 'SELECT duration_minutes FROM public.work_sessions WHERE id=$1', [id(2002)]), null);
  assert.deepEqual(await business(db, true), outside); assert.deepEqual(await business(source), sourceBefore); assert.deepEqual(await triggers(), original); await stillClosed();
}));

test('real activityApi/Transfer bundle streams raw bytes to anon SQL and resumes with a fresh client', () => transaction(async () => {
  const captured = await transaction(async () => {
    transport(source, sourceSession); const exp = modules.createActivityExportSession(packageId, PASSWORDS.root), catalog = await exp.begin(), files = new Map();
    const exported = await modules.exportActivityData(exp.source, { async append(path, bytes) { files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)])); }, async abort() { files.clear(); } });
    assert.equal(exported.rows, 413); await exp.close(); return { catalog, files };
  }, source);
  transport(); const imp = modules.createActivityImportSession(task.job_token); let discarded = 0, progress = 0;
  const result = await modules.stageActivityImport(captured.catalog, { open(path) { return (async function* () { const bytes = captured.files.get(path); assert.ok(bytes); for (let n = 0; n < bytes.length; n += 37) yield bytes.subarray(n, n + 37); })(); }, async abort() { discarded++; } }, imp.target,
    { onProgress(p) { if (p.phase === 'stage') progress = p.rows; } });
  assert.equal(discarded, 1); assert.equal(progress, 413); assert.equal(result.plan.can_restore, true);
  await imp.apply(F.history, result.plan.plan_hash);
  const resumed = modules.createActivityImportSession(task.job_token); await resumed.target.bind(captured.catalog); const rp = await resumed.plan(); assert.deepEqual(rp, result.plan);
  assert.equal((await resumed.apply(F.history, rp.plan_hash)).repeated, true); await resumed.apply(F.noHeartbeat, rp.plan_hash); await resumed.apply(F.empty, rp.plan_hash);
  assert.equal((await resumed.verify()).completed_employees, 3); await assertRestored(); await stillClosed();
}));

for (const [label, relation, sql, args] of [
  ['login nested precision', ACTIVITY[0], `UPDATE public.employee_login_history SET device_info=jsonb_set(device_info,'{children,0,precise}','12345678901234567890.12345678901234567891'::jsonb) WHERE id=$1`, () => [F.login]],
  ['device JSON null versus SQL null', ACTIVITY[0], 'UPDATE public.employee_login_history SET device_info=NULL WHERE id=$1', () => [id(1007)]],
  ['login nullable timestamp', ACTIVITY[0], 'UPDATE public.employee_login_history SET created_at=NULL WHERE id=$1', () => [F.login]],
  ['work NULL duration', ACTIVITY[1], 'UPDATE public.work_sessions SET duration_minutes=0 WHERE id=$1', () => [id(2002)]],
  ['work heartbeat', ACTIVITY[1], "UPDATE public.work_sessions SET last_heartbeat_at=last_heartbeat_at+interval '1 microsecond' WHERE id=$1", () => [F.running]],
  ['private marker', ACTIVITY[2], "UPDATE private.employee_work_stop_markers SET stopped_at=stopped_at+interval '1 microsecond' WHERE user_id=$1", () => [F.history]],
  ['extra row count', ACTIVITY[0], 'INSERT INTO public.employee_login_history SELECT $1,user_id,username,employee_id,action_type,ip_address,user_agent,session_id,created_at,device_info FROM public.employee_login_history WHERE id=$2', () => [id(1999), F.login]],
]) test(`committed ${label} drift blocks repeat/plan/verify without silently accepting identical counts`, () => transaction(async () => {
  const p = await stage(); await restore(p); await localChange(db, relation, sql, args()); const before = await business(), saved = await state();
  for (const action of [() => plan(), () => apply(p), () => verify()]) await assert.rejects(action(), /post-write|committed|content|count|verification/i);
  assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved); await stillClosed();
}));

for (const [key, relation, sql, args, reason] of [
  ['login target residual', ACTIVITY[0], "INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type) VALUES($1,$2,'residual','residual','login')", () => [id(9999), F.history], 'activity_target_not_empty'],
  ['work target residual', ACTIVITY[1], "INSERT INTO public.work_sessions(id,user_id,start_time,end_time) VALUES($1,$2,'2022-01-01','2022-01-02')", () => [id(9999), F.history], 'activity_target_not_empty'],
  ['marker target residual', ACTIVITY[2], "INSERT INTO private.employee_work_stop_markers(user_id,stopped_at) VALUES($1,'2022-01-01')", () => [F.history], 'activity_target_not_empty'],
  ['login UUID belonging to another employee', ACTIVITY[0], "INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type) VALUES($1,$2,'other','other','login')", () => [F.login, F.noHeartbeat], 'activity_uuid_collision'],
  ['work UUID belonging to another employee', ACTIVITY[1], "INSERT INTO public.work_sessions(id,user_id,start_time,end_time) VALUES($1,$2,'2022-01-01','2022-01-02')", () => [F.running, F.noHeartbeat], 'activity_uuid_collision'],
]) test(`plan reports ${key} and refuses overwriting or ON CONFLICT skipping`, () => transaction(async () => {
  await localChange(db, relation, sql, args()); const before = await business(), p = await stage(); flags(p); assert.equal(p.can_restore, false); assert.ok(p.conflicts.includes(reason));
  await assert.rejects(apply(p), /conflict-free|conflict/i); assert.deepEqual(await business(), before); await stillClosed();
}));

test('a foreign employee UUID collision introduced after planning blocks that employee and preserves an earlier commit', () => transaction(async () => {
  const p = await stage(); await apply(p, F.empty);
  await localChange(db, ACTIVITY[0], "INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type) VALUES($1,$2,'other','other','logout')", [F.login, F.noHeartbeat]);
  const before = await business(), saved = await state(); await assert.rejects(apply(p), /collision|changed|empty|conflict/i);
  assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved); assert.equal((await apply(p, F.empty)).repeated, true); await stillClosed();
}));

for (const key of KEYS.activity) test(`${key} source ownership must exist in the bound identity, including the no-FK private marker`, () => transaction(async () => {
  const input = changedInput(key, text => text.replaceAll(F.history, F.outsider)), before = await business(), p = await stage(input);
  assert.equal(p.can_restore, false); assert.ok(p.conflicts.includes('source_employee_missing')); flags(p); await assert.rejects(apply(p), /conflict-free|conflict/i); assert.deepEqual(await business(), before);
}));

test('running work with an out-of-range derived int duration is a blocked plan, not overflow/truncation or repaired source', () => transaction(async () => {
  const input = changedInput('work_sessions', text => lines(text).map(line => {
    if (JSON.parse(line).id !== F.running) return line;
    return JSON.stringify({ ...JSON.parse(line), start_time: '0001-01-01T00:00:00+00:00', last_heartbeat_at: '9999-12-31T23:59:59+00:00' }) + '\n';
  }).join(''));
  const before = await business(), p = await stage(input); assert.equal(p.can_restore, false); assert.ok(p.conflicts.includes('work_duration_out_of_range')); flags(p);
  await assert.rejects(apply(p), /conflict-free|conflict/i); assert.deepEqual(await business(), before);
}));

test('heartbeat earlier than start clamps to start and zero, and export retains the original unfinished fields', () => transaction(async () => {
  const input = await transaction(async () => {
    await localChange(source, ACTIVITY[1], "UPDATE public.work_sessions SET last_heartbeat_at=start_time-interval '1 second',duration_minutes=123 WHERE id=$1", [F.running]); return capture('activity');
  }, source);
  const raw = JSON.parse(lines(input.texts.work_sessions).find(line => JSON.parse(line).id === F.running)); assert.equal(raw.end_time, null); assert.equal(raw.duration_minutes, 123);
  const p = await stage(input); assert.equal(p.can_restore, true); await apply(p);
  assert.equal(await scalar(db, 'SELECT end_time=start_time AND duration_minutes=0 AND last_heartbeat_at<start_time FROM public.work_sessions WHERE id=$1', [F.running]), true);
}));

for (const [label, change] of [
  ['package', c => { c.package_id = randomUUID(); c.identity_catalog.package_id = c.package_id; }],
  ['source site', c => { c.site_id = randomUUID(); c.identity_catalog.site_id = c.site_id; }],
  ['complete identity row hash', c => { c.identity_catalog.tables[0].row_hashes_sha256 = hash('different identity'); }],
  ['identity metadata', c => { c.identity_catalog.processing_orders++; }],
]) test(`activity bind checks exact ${label}, not just the presence of finance verified`, () => transaction(async () => {
  const catalog = structuredClone(activity.catalog); change(catalog); const before = await business(); await assert.rejects(bind({ catalog }), /binding|identity|package|catalog|source/i);
  assert.deepEqual(await business(), before); assert.equal(await permits(), 0);
}));

for (const [label, relation, sql] of [
  ['verified identity', 'public.users', "UPDATE public.users SET remarks='prerequisite drift' WHERE id=$1"],
  ['verified finance', 'public.wallets', "UPDATE public.wallets SET updated_at='2001-01-01' WHERE user_id=$1"],
]) test(`activity rechecks actual ${label} content rather than trusting its old verified flag`, () => transaction(async () => {
  const p = await stage(); await localChange(db, relation, sql, [F.history]); const before = await business(), saved = await state();
  for (const action of [() => plan(), () => apply(p), () => verify()]) await assert.rejects(action(), /post-write|committed|content|verification|changed/i);
  assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved); assert.equal(await permits(), 0);
}));

test('catalog, staged bytes, employee membership and plan hash are immutable authorization bindings', () => transaction(async () => {
  await bind(); assert.equal((await bind()).repeated, true);
  const changed = changedInput('employee_login_history', text => text.replace('歷史名稱', '其他名稱'));
  await assert.rejects(bind(changed), /immutable|binding/i);
  const first = chunks(activity.texts.employee_login_history)[0]; await stageChunk('employee_login_history', 0, first);
  assert.equal((await stageChunk('employee_login_history', 0, first)).repeated, true);
  await assert.rejects(stageChunk('employee_login_history', 0, first.replace('歷史名稱', '其他名稱')), /changed/i);
  const p = await stage(); await assert.rejects(apply({ plan_hash: hash('forged') }), /conflict-free|plan/i); await assert.rejects(apply(p, F.outsider), /verified member|source package|employee/i);
  const before = await business(); await assert.rejects(stageChunk('employee_login_history', 2, lines(activity.texts.employee_login_history)[0]), /frozen|catalog|order/i); assert.deepEqual(await business(), before);
}));

for (const [label, sql] of [
  ['unknown login trigger', 'CREATE TRIGGER aa_activity_unknown BEFORE INSERT ON public.employee_login_history FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['unknown work trigger', 'CREATE TRIGGER aa_activity_unknown BEFORE INSERT ON public.work_sessions FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['unknown private marker trigger', 'CREATE TRIGGER aa_activity_unknown BEFORE INSERT ON private.employee_work_stop_markers FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['disabled login signal trigger', 'ALTER TABLE public.employee_login_history DISABLE TRIGGER employee_login_history_emit_event'],
  ['replica work validation trigger', 'ALTER TABLE public.work_sessions ENABLE REPLICA TRIGGER trigger_validate_work_session'],
  ['disabled private maintenance guard', 'ALTER TABLE private.employee_work_stop_markers DISABLE TRIGGER zz_employee_transfer_maintenance'],
]) test(`activity refuses ${label} without writes or trigger-state normalization`, () => transaction(async () => {
  const p = await stage(); await db.exec(sql); const before = await business(), original = await triggers();
  await assert.rejects(apply(p), /Unreviewed|guard|trigger/i); assert.deepEqual(await business(), before); assert.deepEqual(await triggers(), original); assert.equal(await permits(), 0);
}));

test('late activity event failure rolls back all three tables/receipt for only the current employee and restores triggers', () => transaction(async () => {
  const p = await stage(); await apply(p, F.noHeartbeat); const before = await business(), saved = await state(), original = await triggers();
  await db.exec(`CREATE FUNCTION public.activity_event_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='activity_employee_restored' THEN RAISE EXCEPTION 'late activity failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER activity_event_fail BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.activity_event_fail()`);
  await assert.rejects(apply(p), /late activity failure/); assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved); assert.deepEqual(await triggers(), original);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1 AND employee_id=$2 AND table_key='activity-done'", [task.job_id, F.history]), 0);
  assert.equal((await apply(p, F.noHeartbeat)).repeated, true); await stillClosed();
  await db.exec('DROP TRIGGER activity_event_fail ON private.employee_transfer_events; DROP FUNCTION public.activity_event_fail()');
  assert.equal((await apply(p)).verified, true); await apply(p, F.empty); assert.equal((await verify()).verified, true); await assertRestored();
}));

for (const [label, token] of [['secondary', () => branch], ['emergency', () => emergency], ['another super-admin', () => other], ['unknown session', randomUUID]]) test(`activity preparation/writes reject ${label}`, () => transaction(async () => {
  const p = await stage(), before = await business(), extra = { p_admin_session_token: token() };
  for (const action of [() => bind(activity, extra), () => stageChunk('work_stop_markers', 0, activity.texts.work_stop_markers, extra), () => plan(extra), () => apply(p, F.history, extra), () => verify(extra)])
    await assert.rejects(action(), /Super administrator|invalid or expired/i);
  assert.deepEqual(await business(), before); assert.equal(await permits(), 0);
}));

for (const [label, sql, args] of [
  ['expired admin session', "UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1", () => [NEW.root]],
  ['expired task', "UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", () => [task.job_id]],
  ['lost independent backup seal', 'UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1', () => [task.job_id]],
]) test(`activity continuation rechecks ${label} and cannot release dirty maintenance`, () => transaction(async () => {
  const p = await stage(); await apply(p, F.noHeartbeat); await db.query(sql, args()); const before = await business();
  for (const action of [() => bind(), () => plan(), () => apply(p), () => verify()]) await assert.rejects(action(), /invalid or expired|running dispatch owner|backup/i);
  assert.deepEqual(await business(), before); assert.equal(await permits(), 0); assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
}));

for (const timing of ['before first page', 'after pages']) test(`source drift ${timing} invalidates export verification without changing source sessions`, () => transaction(async () => {
  const exp = await on(source, 'employee_export_activity_begin', { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root, p_package_id: packageId });
  await assert.rejects(on(source, 'employee_export_activity_close', auth(exp, sourceSession)), /not been verified|unverified/i);
  if (timing === 'after pages') await on(source, 'get_employee_export_activity_page', { ...auth(exp, sourceSession), p_table_key: 'employee_login_history', p_after: null, p_limit: 200 });
  await localChange(source, ACTIVITY[0], "UPDATE public.employee_login_history SET user_agent='same-count source drift' WHERE id=$1", [F.login]);
  const before = await business(source); await assert.rejects(on(source, 'employee_export_activity_verify', auth(exp, sourceSession)), /source changed/i); assert.deepEqual(await business(source), before);
  await assert.rejects(on(source, 'employee_export_activity_close', auth(exp, sourceSession)), /not been verified|unverified/i);
}, source));

test('identity drift alone invalidates the activity source catalog, including after a successful verify', () => transaction(async () => {
  const exp = await on(source, 'employee_export_activity_begin', { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root, p_package_id: packageId });
  assert.equal((await on(source, 'employee_export_activity_verify', auth(exp, sourceSession))).verified, true);
  await source.query("UPDATE public.users SET remarks='identity changed without activity count change' WHERE id=$1", [F.history]);
  await assert.rejects(on(source, 'employee_export_activity_verify', auth(exp, sourceSession)), /source changed/i);
}, source));

test('export protocol/page limits/cursors cannot cross into finance or old employee import and never advance full export time', () => transaction(async () => {
  await transaction(async () => {
    const exp = await on(source, 'employee_export_activity_begin', { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root, p_package_id: packageId });
    for (const key of ['orders', 'finance-done', 'work_stop_markers;DROP TABLE users', null]) await assert.rejects(on(source, 'get_employee_export_activity_page', { ...auth(exp, sourceSession), p_table_key: key }), /Unsupported|Invalid/i);
    for (const limit of [0, 201, null]) await assert.rejects(on(source, 'get_employee_export_activity_page', { ...auth(exp, sourceSession), p_table_key: 'work_sessions', p_limit: limit }), /page size|limit/i);
    await assert.rejects(on(source, 'get_employee_export_activity_page', { ...auth(exp, sourceSession), p_table_key: 'work_sessions', p_after: F.outsider }), /cursor/i);
    for (const name of ['employee_export_finance_verify', 'employee_export_identity_verify', 'employee_export_finish']) await assert.rejects(on(source, name, { ...auth(exp, sourceSession), ...(name.endsWith('finish') ? { p_summary: {} } : {}) }), /protocol/i);
    await on(source, 'employee_export_activity_verify', auth(exp, sourceSession)); await on(source, 'employee_export_activity_close', auth(exp, sourceSession));
    assert.equal((await on(source, 'get_employee_transfer_log', { p_admin_session_token: sourceSession })).last_export_at, null);
  }, source);
  const p = await stage(); await apply(p);
  for (const name of ['employee_import_finish', 'employee_import_finalize_employee']) await assert.rejects(rpc(name, { ...auth(), ...(name.endsWith('finish') ? { p_summary: {} } : { p_employee_id: F.history, p_expected: {} }) }), /protocol/i);
  await stillClosed();
}));

test('activity export checks the password, role, expiration and cancellation instead of trusting a job token', () => transaction(async () => {
  const begin = extra => on(source, 'employee_export_activity_begin', { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root, p_package_id: packageId, ...extra });
  assert.equal((await begin({ p_admin_password: 'wrong-local-password' })).success, false);
  const branchToken = await adminLogin(source, 'branch', PASSWORDS.branch);
  await assert.rejects(begin({ p_admin_session_token: branchToken, p_admin_password: PASSWORDS.branch }), /Super administrator/i);
  const exp = await begin({});
  await assert.rejects(on(source, 'employee_export_activity_verify', auth(exp, branchToken)), /Super administrator|invalid or expired/i);
  await source.query("UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", [exp.job_id]);
  for (const name of ['get_employee_export_activity_page', 'employee_export_activity_verify', 'employee_export_activity_close'])
    await assert.rejects(on(source, name, { ...auth(exp, sourceSession), ...(name.includes('_page') ? { p_table_key: 'work_sessions' } : {}) }), /invalid or expired/i);
  assert.equal((await on(source, 'employee_transfer_cancel', auth(exp, sourceSession))).cancelled, true);
  const cancelled = await begin({}); await on(source, 'employee_transfer_cancel', auth(cancelled, sourceSession));
  await assert.rejects(on(source, 'employee_export_activity_verify', auth(cancelled, sourceSession)), /invalid or expired/i);
}, source));

test('activity private helpers stay inaccessible and malformed/raw duplicate JSON is rejected per object, not across objects', () => transaction(async () => {
  await bind(); const functions = await rows(db, "SELECT oid,proname FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%activity%'"); assert.ok(functions.length > 0);
  for (const fn of functions) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2::oid,'EXECUTE')", [role, fn.oid]), false, fn.proname);
  for (const key of ['orders', 'activity-done', 'private.employee_work_stop_markers', null]) await assert.rejects(stageChunk(key, 0, ''), /Unsupported|Invalid/i);
  const line = lines(activity.texts.employee_login_history)[0]; assert.match(line, /"children"/);
  for (const text of [line.replace('{', '{"user_id":"' + F.history + '",'), line.replace('{', '{"unexpected":1,'),
    line.replace('"left"', '"left","id":"duplicate"'), line.replace('"left"', '"left","\\u0069d":"escaped duplicate"'),
    line.replace(/history-[0-9a-f]{64}/, SOURCE_SESSION), line.slice(0, -1)]) await assert.rejects(stageChunk('employee_login_history', 0, text), /Invalid|fields|session/i);
  // Nested id keys in independent objects are valid, and high precision must remain in the original bytes.
  assert.equal((await stageChunk('employee_login_history', 0, chunks(activity.texts.employee_login_history)[0])).rows, 200);
  await assert.rejects(stageChunk('work_sessions', 0, activity.texts.work_sessions), /limit|chunk|rows/i);
  const malformedMarker = activity.texts.work_stop_markers.replace(F.history, F.outsider); await assert.rejects(stageChunk('work_stop_markers', 0, malformedMarker), /Invalid|owner|identity/i);
  assert.equal(await permits(), 0);
}));

test('same-length raw-byte corruption cannot satisfy the catalog digest even with valid row fields', () => transaction(async () => {
  await bind();
  for (const key of KEYS.activity) for (const [no, text] of chunks(activity.texts[key]).entries()) await stageChunk(key, no, key === 'employee_login_history' ? text.replace('12345678901234567890.12345678901234567890', '12345678901234567890.12345678901234567891') : text);
  const before = await business(); await assert.rejects(plan(), /catalog|verification|digest/i); assert.deepEqual(await business(), before); assert.equal(await permits(), 0);
}));

// Verification tests are isolated from the original activity suite; no verification prerequisite is
// forged in the shared before hook, so a broken media RPC cannot suppress existing activity coverage.
for (const [name, args, service] of [
  ['employee_export_verification_begin', ['p_admin_session_token', 'p_admin_password', 'p_package_id']],
  ['get_employee_export_verification_page', ['p_admin_session_token', 'p_job_token', 'p_table_key', 'p_after', 'p_limit']],
  ['employee_export_verification_verify', ['p_admin_session_token', 'p_job_token']],
  ['employee_export_verification_close', ['p_admin_session_token', 'p_job_token']],
  ['employee_import_verification_bind', ['p_admin_session_token', 'p_job_token', 'p_catalog']],
  ['employee_import_verification_stage', ['p_admin_session_token', 'p_job_token', 'p_table_key', 'p_chunk_no', 'p_ndjson']],
  ['get_employee_transfer_verification_media', ['p_admin_session_token', 'p_job_token', 'p_direction']],
  ['employee_import_verification_media_bind', ['p_admin_session_token', 'p_job_token', 'p_files']],
  ['get_employee_import_verification_plan', ['p_admin_session_token', 'p_job_token']],
  ['employee_import_verification_apply', ['p_admin_session_token', 'p_job_token', 'p_employee_id', 'p_plan_hash']],
  ['employee_import_verification_verify', ['p_admin_session_token', 'p_job_token']],
  [MEDIA_AUTH, ['p_admin_session_token', 'p_job_token', 'p_action', 'p_object_key'], true],
  [MEDIA_COMMIT, ['p_admin_session_token', 'p_job_token', 'p_action', 'p_object_key', 'p_bytes', 'p_sha256', 'p_content_type', 'p_storage_origin'], true],
]) test(`verification ${name} keeps exact signature, definer search path and ${service ? 'service-only' : 'browser'} grants`, () => transaction(async () => {
  const found = await rows(db, `SELECT oid,proargnames,prosecdef,proconfig,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS everyone
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1`, [name]);
  assert.equal(found.length, 1); const fn = found[0]; assert.deepEqual(fn.proargnames, args); assert.equal(fn.prosecdef, true);
  assert.equal(fn.everyone, false); assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2::oid,\'EXECUTE\')', [role, fn.oid]), service ? role === 'service_role' : role !== 'service_role');
}));

test('verification raw source export has 205 rows over two pages, all 15 fields, three statuses, NULL, UTF8 and microseconds', () => transaction(async () => {
  assert.deepEqual(verification.pages.verification_requests, [200, 5]); assert.equal(verification.catalog.scope, 'employee-verification');
  assert.deepEqual(verification.catalog.identity_catalog, identity.catalog);
  const text = verification.texts.verification_requests, raw = lines(text).map(line => JSON.parse(line));
  assert.equal(raw.length, 205); assert.equal(new Set(raw.map(r => r.user_id)).size, 2);
  assert.deepEqual([...new Set(raw.map(r => r.status))].sort(), ['approved', 'pending', 'rejected']);
  assert.deepEqual([...new Set(raw.map(r => r.audited_by))].sort(), [null, OLD.root, OLD.branch].sort());
  for (const r of raw) assert.equal(Object.keys(r).length, 15);
  for (const field of ['audit_remark', 'audited_by', 'audited_at', 'created_at', 'updated_at', 'id_front_url', 'id_back_url', 'selfie_url']) {
    assert.ok(raw.some(r => r[field] === null), field); assert.ok(raw.some(r => r[field] !== null), field);
  }
  assert.match(text, /𠮷/); assert.match(text, /é é/); assert.match(text, /123456/); assert.match(text, /654321/); assert.match(text, /000001/);
  assert.equal(verification.catalog.tables[0].bytes, Buffer.byteLength(text)); assert.equal(verification.catalog.tables[0].row_hashes_sha256, hash(lines(text).map(hash).join('')));
  assert.equal(verification.files.length, 6);
  const expected = await expectedVerificationRows(); assert.equal(expected.length, 205);
  for (const row of expected) assert.equal(Object.keys(JSON.parse(row.body)).length, 15);
  for (const file of verification.files) { assert.equal(file.key, hash(file.source_url)); assert.equal(new URL(file.source_url).origin, SOURCE_ORIGIN); }
  assert.equal((await on(source, 'get_employee_transfer_log', { p_admin_session_token: sourceSession })).last_export_at, null);
}, source));

const vexportBegin = () => on(source, 'employee_export_verification_begin', { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root, p_package_id: packageId });
test('verification media inventory has exact deduplicated refs; verify blocks before download and before second readback, then verifies/closes without full export time', () => transaction(async () => {
  const original = await business(source), exp = await vexportBegin();
  const inventory = await mediaInventory(source, exp, sourceSession, 'export');
  assert.equal(inventory.scope, 'employee-verification-media'); assert.equal(inventory.full_site_complete, false);
  assert.deepEqual(inventory.files, verification.files.map(file => ({ key: file.key, source_url: file.source_url, bucket: 'verification-documents', path: file.source_url.split(MEDIA_PREFIX + '/')[1], file: null })));
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(exp, sourceSession)), /media export is incomplete/i);
  await assert.rejects(on(source, 'employee_export_verification_close', auth(exp, sourceSession)), /not been verified/i);
  for (const file of verification.files) await assert.rejects(mediaAuthorize(source, exp, sourceSession, 'recheck-export', file.key), /first be downloaded/i);
  await commitMedia(source, exp, sourceSession, verification.files, 'download');
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(exp, sourceSession)), /media export is incomplete/i);
  await commitMedia(source, exp, sourceSession, verification.files.slice(0, -1), 'recheck-export');
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(exp, sourceSession)), /media export is incomplete/i);
  await commitMedia(source, exp, sourceSession, verification.files.slice(-1), 'recheck-export');
  assert.deepEqual((await mediaInventory(source, exp, sourceSession, 'export')).files.map(ref => ref.file), verification.files);
  const result = await on(source, 'employee_export_verification_verify', auth(exp, sourceSession)); assert.equal(result.verified, true); assert.equal(result.full_site_complete, false);
  assert.equal((await on(source, 'employee_export_verification_close', auth(exp, sourceSession))).success, true);
  assert.equal((await on(source, 'get_employee_transfer_log', { p_admin_session_token: sourceSession })).last_export_at, null);
  assert.deepEqual(await business(source), original);
}, source));

test('verification capture can complete only through actual service-role download/recheck RPCs, not summary injection', () => transaction(async () => {
  const exported = await capture('verification'); assert.deepEqual(exported, verification);
}, source));

for (const [label, extra] of [
  ['wrong source origin', { p_storage_origin: TARGET_ORIGIN }],
  ['changed bytes', { p_bytes: 1 }], ['changed digest', { p_sha256: hash('changed synthetic') }], ['changed MIME', { p_content_type: 'image/gif' }],
]) test(`verification source commit rejects ${label} without changing the real receipt`, () => transaction(async () => {
  const exp = await vexportBegin(), file = verification.files[0]; await commitMedia(source, exp, sourceSession, [file], 'download');
  const saved = await rows(source, "SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 ORDER BY table_key,chunk_no", [exp.job_id]);
  await assert.rejects(mediaCommit(source, exp, sourceSession, 'recheck-export', file, extra), /not stored on this site|content changed/i);
  assert.deepEqual(await rows(source, "SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 ORDER BY table_key,chunk_no", [exp.job_id]), saved);
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(exp, sourceSession)), /incomplete/i);
}, source));

for (const role of ['anon', 'authenticated']) test(`verification ${role} cannot call media authorize/commit even with valid administrator/job tokens`, () => transaction(async () => {
  const exp = await vexportBegin(), file = verification.files[0];
  await assert.rejects(mediaAuthorize(source, exp, sourceSession, 'download', file.key, role), /permission denied/i);
  await assert.rejects(mediaCommit(source, exp, sourceSession, 'download', file, {}, role), /permission denied/i);
}, source));

for (const [label, url] of [
  ['foreign employee path', `${SOURCE_ORIGIN}${MEDIA_PREFIX}/id-front/${F.outsider}-synthetic.jpg`],
  ['unmanaged URL', `${SOURCE_ORIGIN}${MEDIA_PREFIX}/id-front/${F.history}-synthetic.jpg?unmanaged=1`],
]) test(`verification source media refuses ${label} rather than silently dropping a file`, () => transaction(async () => {
  await localChange(source, 'public.verification_requests', 'UPDATE public.verification_requests SET id_front_url=$2 WHERE id=$1', [V.first, url]);
  const exp = await vexportBegin(); await assert.rejects(mediaInventory(source, exp, sourceSession, 'export'), /does not belong|Unmanaged/i);
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(exp, sourceSession)), /does not belong|Unmanaged/i);
}, source));

for (const [label, relation, sql] of [
  ['request same-count drift', 'public.verification_requests', "UPDATE public.verification_requests SET audit_remark='source drift' WHERE id=$1"],
  ['identity drift', 'public.users', "UPDATE public.users SET remarks='source identity drift' WHERE id=$1"],
]) test(`verification source rechecks ${label} after real media receipts, including after successful verify`, () => transaction(async () => {
  const exp = await vexportBegin(); await commitMedia(source, exp, sourceSession, verification.files, 'download'); await commitMedia(source, exp, sourceSession, verification.files, 'recheck-export');
  await on(source, 'employee_export_verification_verify', auth(exp, sourceSession));
  await localChange(source, relation, sql, [relation === 'public.users' ? F.history : V.first]);
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(exp, sourceSession)), /source changed/i);
}, source));

test('verification bind cannot bypass real restored activity prerequisites', () => transaction(async () => {
  const before = await business(); await assert.rejects(vbind(), /Invalid employee activity catalog\.|Verified same-package.*activity.*required/i); assert.deepEqual(await business(), before); await stillClosed();
}));

test('verification media_incomplete blocks import before media bind, with missing receipts, and with a missing last upload', () => transaction(async () => {
  const p = await vstage(verification, { media: false }); assert.equal(p.can_restore, false); assert.ok(p.conflicts.includes('media_incomplete')); flags(p);
  await assert.rejects(vapply(p), /conflict-free/i);
  await vmediaBind(); let next = await vplan(); assert.ok(next.conflicts.includes('media_incomplete'));
  await commitMedia(db, task, session, verification.files.slice(0, -1), 'upload'); next = await vplan(); assert.ok(next.conflicts.includes('media_incomplete'));
  await assert.rejects(vapply(next), /conflict-free/i);
  await commitMedia(db, task, session, verification.files.slice(-1), 'upload'); next = await vplan(); assert.equal(next.can_restore, true); flags(next); await stillClosed();
}));

test('verification restores every original column except mapped reviewers/namespaced URLs; is_verified, money, activity, triggers and dirty maintenance stay independent', () => transaction(async () => {
  const originalFlags = await verifiedFlags(); const p = await vstage(), before = await voutside(), original = await triggers(), sourceBefore = await business(source);
  assert.equal(p.can_restore, true, JSON.stringify(p.conflicts)); assert.deepEqual(p.counts, { verification_requests: 205 }); assert.equal(p.employees, 3); flags(p);
  await assert.rejects(vverify(), /incomplete/i);
  for (const employee of EMPLOYEES) {
    const receipt = await vapply(p, employee); assert.equal(receipt.verified, true); flags(receipt); assert.equal(receipt.scope, 'employee-verification');
    assert.equal(receipt.employee_id, employee); assert.deepEqual(await vapply(p, employee), { ...receipt, repeated: true });
    assert.deepEqual(receipt.counts, { verification_requests: employee === F.history ? 203 : employee === F.noHeartbeat ? 2 : 0 });
  }
  await assert.rejects(vverify(), /final document readback is incomplete/i);
  await commitMedia(db, task, session, verification.files, 'recheck-import'); const verified = await vverify(); flags(verified); assert.equal(verified.completed_employees, 3);
  assert.deepEqual(await vverify(), { ...verified, repeated: true }); assert.deepEqual(await vplan(), p);
  await assertVerificationRestored(); assert.deepEqual(await verifiedFlags(), originalFlags); assert.deepEqual(await voutside(), before);
  assert.deepEqual(await triggers(), original); assert.deepEqual(await business(source), sourceBefore); await stillClosed();
}));

test('verification final readback must occur after the last actual employee apply, not an earlier successful recheck-import', () => transaction(async () => {
  const p = await vstage(); await commitMedia(db, task, session, verification.files, 'recheck-import');
  for (const employee of EMPLOYEES) await vapply(p, employee);
  await assert.rejects(vverify(), /final document readback is incomplete/i);
  await commitMedia(db, task, session, verification.files.slice(0, -1), 'recheck-import'); await assert.rejects(vverify(), /incomplete/i);
  await commitMedia(db, task, session, verification.files.slice(-1), 'recheck-import'); assert.equal((await vverify()).verified, true); await stillClosed();
}));

for (const [label, change] of [
  ['package', c => { c.package_id = randomUUID(); c.identity_catalog.package_id = c.package_id; }],
  ['source site', c => { c.site_id = randomUUID(); c.identity_catalog.site_id = c.site_id; }],
  ['identity raw digest', c => { c.identity_catalog.tables[0].row_hashes_sha256 = hash('other raw identity'); }],
]) test(`verification bind requires exact same ${label} and refuses replacement catalogs`, () => transaction(async () => {
  await restore(await stage()); const catalog = structuredClone(verification.catalog); change(catalog); const before = await business();
  await assert.rejects(vbind({ catalog }), /binding|source|catalog|identity|package/i); assert.deepEqual(await business(), before);
  await vbind(); assert.equal((await vbind()).repeated, true); const modified = changedVerification(r => ({ ...r, real_name: r.real_name + 'x' }));
  await assert.rejects(vbind(modified), /immutable/i); await stillClosed();
}));

for (const [label, change, conflict] of [
  ['missing reviewer mapping', r => r.id === V.first ? { ...r, audited_by: F.outsider } : r, 'verification_admin_unmapped'],
  ['missing source employee', r => r.id === V.first ? { ...r, user_id: F.outsider, id_front_url: null, id_back_url: null, selfie_url: null } : r, 'source_employee_missing'],
]) test(`verification plan blocks ${label} from untrusted source files without modifying private maps`, () => transaction(async () => {
  const p = await vstage(changedVerification(change)); assert.equal(p.can_restore, false); assert.ok(p.conflicts.includes(conflict)); flags(p);
  const before = await business(), saved = await state(); await assert.rejects(vapply(p), /conflict-free/i); assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved); await stillClosed();
}));

const insertVerification = (request, employee) => localChange(db, 'public.verification_requests',
  "INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status) VALUES($1,$2,'synthetic-residual','fake-id','fake-phone','fake-address','pending')", [request, employee]);
for (const [label, request, employee, reason] of [
  ['target residual', V.residual, F.history, 'verification_target_not_empty'],
  ['UUID collision owned by another package employee', V.first, F.noHeartbeat, 'verification_uuid_collision'],
]) test(`verification plan refuses ${label} without deleting or skipping target rows`, () => transaction(async () => {
  const p = await vstage(); assert.equal(p.can_restore, true); await insertVerification(request, employee); const before = await business(), blocked = await vplan();
  assert.equal(blocked.can_restore, false); assert.ok(blocked.conflicts.includes(reason)); await assert.rejects(vapply(blocked), /conflict-free|changed/i);
  assert.deepEqual(await business(), before); await stillClosed();
}));

test('verification UUID introduced after planning blocks a later employee without claiming an earlier employee commit was reversed', () => transaction(async () => {
  const p = await vstage(); await vapply(p, F.noHeartbeat); await insertVerification(V.first, F.empty); const before = await business(), saved = await state();
  await assert.rejects(vapply(p), /UUID collision changed/i); assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved);
  assert.equal((await vapply(p, F.noHeartbeat)).repeated, true); assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.verification_requests WHERE user_id=$1', [F.noHeartbeat]), 2); await stillClosed();
}));

for (const [field, value] of [['id', V.residual], ['user_id', F.empty], ['real_name', 'drift'], ['wallet_address', 'drift'], ['phone', 'drift'], ['email', 'drift'],
  ['status', 'rejected'], ['audit_remark', null], ['audited_by', NEW.branch], ['audited_at', null], ['created_at', null],
  ['updated_at', '2001-01-01T00:00:00.000001Z'], ['id_front_url', null], ['id_back_url', `${TARGET_ORIGIN}${MEDIA_PREFIX}/id-back/${F.history}-drift.png`], ['selfie_url', null]])
  test(`verification same-count ${field} drift blocks repeated apply, plan and final verify`, () => transaction(async () => {
    const p = await vstage(); await vrestore(p);
    await localChange(db, 'public.verification_requests', `UPDATE public.verification_requests SET ${field}=$2 WHERE id=$1`, [V.first, value]);
    const before = await business(), saved = await state();
    for (const action of [() => vapply(p), () => vplan(), () => vverify()]) await assert.rejects(action(), /committed content changed/i);
    assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved); await stillClosed();
  }));

for (const [label, change] of [
  ['missing file', files => files.slice(1)], ['wrong key', files => { files[0].key = hash('wrong key'); return files; }],
  ['wrong source URL', files => { files[0].source_url = files[1].source_url; return files; }],
  ['reordered refs', files => files.reverse()], ['zero bytes', files => { files[0].bytes = 0; return files; }],
  ['unknown MIME', files => { files[0].content_type = 'text/html'; return files; }],
]) test(`verification media bind rejects ${label} without accepting an incomplete or misbound file inventory`, () => transaction(async () => {
  await restore(await stage()); await vraw(); const before = await business(), saved = await state();
  await assert.rejects(vmediaBind(change(structuredClone(verification.files))), /Invalid|mismatched/i); assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved);
}));

test('verification media binding is immutable and import commits require exact tuple plus one target origin', () => transaction(async () => {
  await restore(await stage()); await vraw(); await vmediaBind(); assert.equal((await vmediaBind()).repeated, true);
  const changed = structuredClone(verification.files); changed[0].sha256 = hash('different content'); await assert.rejects(vmediaBind(changed), /immutable/i);
  const file = verification.files[0]; const context = await mediaAuthorize(db, task, session, 'upload', file.key); assert.deepEqual(context.file, file);
  for (const extra of [{ p_bytes: 1 }, { p_sha256: hash('changed') }, { p_content_type: 'image/gif' }]) await assert.rejects(mediaCommit(db, task, session, 'upload', file, extra), /content changed/i);
  await commitMedia(db, task, session, [file], 'upload');
  await assert.rejects(mediaCommit(db, task, session, 'upload', verification.files[1], { p_storage_origin: SOURCE_ORIGIN }), /origin changed/i);
  const inventory = await mediaInventory(db, task, session, 'import'); assert.deepEqual(inventory.files.map(ref => ref.file), verification.files);
  await stillClosed();
}));

for (const [label, text] of [
  ['invalid request UUID', () => lines(verification.texts.verification_requests)[0].replace(V.first, 'not-a-uuid')],
  ['invalid employee UUID', () => lines(verification.texts.verification_requests)[0].replace(F.history, 'not-a-uuid')],
  ['invalid reviewer UUID', () => lines(verification.texts.verification_requests)[0].replace(OLD.root, 'not-a-uuid')],
  ['duplicate JSON field', () => lines(verification.texts.verification_requests)[0].replace('{', '{"id":"' + V.first + '",')],
  ['missing LF', () => lines(verification.texts.verification_requests)[0].slice(0, -1)],
  ['over 200 rows', () => verification.texts.verification_requests],
]) test(`verification immutable raw staging rejects ${label}`, () => transaction(async () => {
  await restore(await stage()); await vbind(); await assert.rejects(vchunk(0, text()), /Invalid|row limit/i); assert.equal(await permits(), 0);
}));

test('verification staging preserves raw chunks, rejects changed retries and detects same-length raw corruption', () => transaction(async () => {
  await restore(await stage()); await vbind(); const first = chunks(verification.texts.verification_requests)[0];
  assert.equal((await vchunk(0, first)).rows, 200); assert.equal((await vchunk(0, first)).repeated, true);
  await assert.rejects(vchunk(0, first.replace('合成姓名', '不同姓名')), /content changed/i);
  await vchunk(1, chunks(verification.texts.verification_requests)[1].replace('123456', '123457'));
  await assert.rejects(vplan(), /staged catalog verification failed/i);
}));

for (const [label, sql] of [
  ['unknown verification trigger', 'CREATE TRIGGER aa_verification_unknown BEFORE INSERT ON public.verification_requests FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['disabled maintenance guard', 'ALTER TABLE public.verification_requests DISABLE TRIGGER zz_employee_transfer_maintenance'],
  ['replica maintenance guard', 'ALTER TABLE public.verification_requests ENABLE REPLICA TRIGGER zz_employee_transfer_maintenance'],
]) test(`verification refuses ${label} before writing and never normalizes its trigger state`, () => transaction(async () => {
  const p = await vstage(); await db.exec(sql); const before = await business(), original = await triggers();
  await assert.rejects(vapply(p), /Unreviewed|guard|trigger/i); assert.deepEqual(await business(), before); assert.deepEqual(await triggers(), original); assert.equal(await permits(), 0);
}));

for (const [label, relation, sql] of [
  ['identity', 'public.users', "UPDATE public.users SET remarks='actual identity drift' WHERE id=$1"],
  ['finance', 'public.wallets', "UPDATE public.wallets SET updated_at='2001-01-01' WHERE user_id=$1"],
  ['activity', 'public.employee_login_history', "UPDATE public.employee_login_history SET user_agent='actual activity drift' WHERE id=$1"],
]) test(`verification continuation rechecks actual ${label} rather than its previous verified flag`, () => transaction(async () => {
  const p = await vstage(); await localChange(db, relation, sql, [label === 'activity' ? F.login : F.history]); const before = await business();
  for (const action of [() => vplan(), () => vapply(p), () => vverify()]) await assert.rejects(action(), /changed|verification|content/i);
  assert.deepEqual(await business(), before); assert.equal(await permits(), 0);
}));

test('verification late per-employee event failure rolls back 203 inserted requests, receipt and progress, retaining earlier employee result', () => transaction(async () => {
  const p = await vstage(); await vapply(p, F.noHeartbeat); const before = await business(), saved = await state(), original = await triggers();
  await db.exec(`CREATE FUNCTION public.verification_event_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='verification_employee_restored' AND NEW.details->>'employee_id'='${F.history}' THEN RAISE EXCEPTION 'late verification failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER verification_event_fail BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.verification_event_fail()`);
  await assert.rejects(vapply(p), /late verification failure/); assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved); assert.deepEqual(await triggers(), original);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1 AND employee_id=$2 AND table_key='verification-done'", [task.job_id, F.history]), 0);
  assert.equal((await vapply(p, F.noHeartbeat)).repeated, true); await stillClosed();
  await db.exec('DROP TRIGGER verification_event_fail ON private.employee_transfer_events; DROP FUNCTION public.verification_event_fail()');
  await vapply(p); await vapply(p, F.empty); await commitMedia(db, task, session, verification.files, 'recheck-import'); assert.equal((await vverify()).verified, true); await assertVerificationRestored();
}));

for (const [label, token] of [['secondary', () => branch], ['emergency', () => emergency], ['another root', () => other], ['unknown session', randomUUID]])
  test(`verification browser and service-role protocols reject ${label} identity even with the right job`, () => transaction(async () => {
    const p = await vstage(), extra = { p_admin_session_token: token() }, before = await business();
    for (const action of [() => vbind(verification, extra), () => vchunk(0, chunks(verification.texts.verification_requests)[0], extra), () => vmediaBind(verification.files, extra),
      () => vplan(extra), () => vapply(p, F.history, extra), () => vverify(extra),
      () => mediaAuthorize(db, task, extra.p_admin_session_token, 'upload', verification.files[0].key),
      () => mediaCommit(db, task, extra.p_admin_session_token, 'upload', verification.files[0])]) await assert.rejects(action(), /Super administrator|invalid or expired/i);
    assert.deepEqual(await business(), before); await stillClosed();
  }));

for (const [label, sql, args] of [
  ['expired admin session', "UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1", () => [NEW.root]],
  ['expired task', "UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", () => [task.job_id]],
]) test(`verification ${label} blocks all continuation including service commits and keeps dirty maintenance`, () => transaction(async () => {
  const p = await vstage(); await vapply(p, F.noHeartbeat); await db.query(sql, args()); const before = await business();
  for (const action of [() => vbind(), () => vplan(), () => vapply(p), () => vverify(), () => mediaAuthorize(db, task, session, 'upload', verification.files[0].key),
    () => mediaCommit(db, task, session, 'recheck-import', verification.files[0])]) await assert.rejects(action(), /invalid or expired|running dispatch owner/i);
  assert.deepEqual(await business(), before); assert.equal(await permits(), 0); assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
}));

test('verification plan hash and package membership cannot be forged or bypassed through legacy finish', () => transaction(async () => {
  const p = await vstage(), before = await business(), saved = await state();
  await assert.rejects(vapply({ plan_hash: hash('forged verification plan') }), /matching conflict-free verification plan/i);
  await assert.rejects(vapply(p, F.outsider), /outside this package/i);
  for (const name of ['employee_import_finish', 'employee_import_finalize_employee']) await assert.rejects(rpc(name,
    { ...auth(), ...(name.endsWith('finish') ? { p_summary: {} } : { p_employee_id: F.history, p_expected: {} }) }), /protocol/i);
  assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved); await stillClosed();
}));

test('verification cancellation after a partial employee result blocks browser/service continuation but retains committed history and disabled accounts', () => transaction(async () => {
  const p = await vstage(); await vapply(p, F.noHeartbeat); const before = await business();
  await rpc('employee_transfer_cancel', auth());
  for (const action of [() => vbind(), () => vplan(), () => vapply(p), () => vverify(),
    () => mediaAuthorize(db, task, session, 'upload', verification.files[0].key), () => mediaCommit(db, task, session, 'recheck-import', verification.files[0])])
    await assert.rejects(action(), /invalid or expired/i);
  assert.deepEqual(await business(), before); assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.verification_requests WHERE user_id=$1', [F.noHeartbeat]), 2);
  await stillClosed();
}));

test('verification source expiration/cancellation and unsupported objects/actions cannot manufacture a verified export', () => transaction(async () => {
  const exp = await vexportBegin(), file = verification.files[0];
  await assert.rejects(mediaAuthorize(source, exp, sourceSession, 'download', hash('outside task')), /outside this task/i);
  await assert.rejects(mediaAuthorize(source, exp, sourceSession, 'delete', file.key), /Unsupported/i);
  await source.query("UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", [exp.job_id]);
  for (const action of [() => mediaInventory(source, exp, sourceSession, 'export'), () => mediaAuthorize(source, exp, sourceSession, 'download', file.key),
    () => mediaCommit(source, exp, sourceSession, 'download', file), () => on(source, 'employee_export_verification_verify', auth(exp, sourceSession))]) await assert.rejects(action(), /invalid or expired/i);
  await on(source, 'employee_transfer_cancel', auth(exp, sourceSession)); const cancelled = await vexportBegin(); await on(source, 'employee_transfer_cancel', auth(cancelled, sourceSession));
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(cancelled, sourceSession)), /invalid or expired/i);
}, source));

test('verification helpers and private media receipts/maps remain inaccessible to browser and service roles', () => transaction(async () => {
  const functions = await rows(db, "SELECT oid,proname FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%verification%'"); assert.ok(functions.length > 0);
  for (const fn of functions) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2::oid,'EXECUTE')", [role, fn.oid]), false, fn.proname);
  for (const role of ['anon', 'authenticated', 'service_role']) for (const relation of ['private.employee_transfer_staging', 'private.employee_transfer_jobs']) {
    assert.equal(await scalar(db, "SELECT has_table_privilege($1,$2,'UPDATE')", [role, relation]), false);
    assert.equal(await scalar(db, "SELECT has_table_privilege($1,$2,'INSERT')", [role, relation]), false);
  }
}));

test('verification real committed transactions survive a new PGlite connection, late failure and cancellation without falsely undoing earlier employees', async () => {
  // An isolated durable in-memory clone leaves the original activity continuation test unchanged.
  const activityDb = db; const extensions = { pgcrypto, pg_trgm, uuid_ossp };
  db = new PGlite({ loadDataDir: await activityDb.dumpDataDir('none'), extensions }); await db.waitReady;
  try {
    let p;
    await transaction(async () => { p = await vstage(); }, db, true);
    await transaction(async () => { assert.equal((await vapply(p, F.noHeartbeat)).completed_employees, 1); }, db, true);
    const dump = await db.dumpDataDir('none'); await db.close(); db = new PGlite({ loadDataDir: dump, extensions }); await db.waitReady;
    await transaction(async () => {
      await vbind(); assert.deepEqual(await vplan(), p); assert.equal((await vapply(p, F.noHeartbeat)).repeated, true); await assert.rejects(vverify(), /incomplete/i);
    }, db, true);
    await transaction(async () => {
      await db.exec(`CREATE FUNCTION public.verification_resume_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.action='verification_employee_restored' THEN RAISE EXCEPTION 'late committed verification failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER verification_resume_fail BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.verification_resume_fail()`);
    }, db, true);
    await assert.rejects(transaction(() => vapply(p), db, true), /late committed verification failure/);
    await transaction(async () => {
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.verification_requests WHERE user_id=$1', [F.history]), 0);
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.verification_requests WHERE user_id=$1', [F.noHeartbeat]), 2);
      assert.equal((await state()).verification_restore.completed_employees, 1); assert.equal((await vapply(p, F.noHeartbeat)).repeated, true); await stillClosed();
      await db.exec('DROP TRIGGER verification_resume_fail ON private.employee_transfer_events; DROP FUNCTION public.verification_resume_fail()');
    }, db, true);
    await transaction(async () => { await vapply(p); }, db, true); await transaction(async () => { await vapply(p, F.empty); }, db, true);
    await transaction(async () => { await assert.rejects(vverify(), /incomplete/i); await commitMedia(db, task, session, verification.files, 'recheck-import'); assert.equal((await vverify()).verified, true); }, db, true);
    await transaction(async () => { await assertVerificationRestored(); await stillClosed(); await rpc('employee_transfer_cancel', auth()); }, db, true);
    await transaction(async () => {
      for (const action of [() => vbind(), () => vplan(), () => vapply(p), () => vverify(), () => mediaAuthorize(db, task, session, 'upload', verification.files[0].key),
        () => mediaCommit(db, task, session, 'recheck-import', verification.files[0])]) await assert.rejects(action(), /invalid or expired/i);
      await assertVerificationRestored(); await stillClosed();
      assert.ok(await scalar(db, 'SELECT sealed_at IS NOT NULL FROM private.employee_transfer_shared_backups WHERE id=$1', [task.job_id]));
    });
  } finally { await db.close(); db = activityDb; transport(); }
});

// Last: real COMMITs are intentional. No outer rollback can masquerade as cross-request continuation.
test('separate committed activity transactions resume via a new activityApi, then cancellation preserves history and dirty maintenance', async () => {
  let p; const outside = await business(db, true), original = await triggers();
  await transaction(async () => { p = await stage(); }, db, true);
  await transaction(async () => { assert.equal((await apply(p, F.history)).completed_employees, 1); }, db, true);
  await transaction(async () => {
    transport(); const resume = modules.createActivityImportSession(task.job_token); await resume.target.bind(activity.catalog); const rp = await resume.plan(); assert.deepEqual(rp, p);
    assert.equal((await resume.apply(F.history, rp.plan_hash)).repeated, true); await assert.rejects(resume.verify(), /outcome is unknown or unconfirmed/);
    assert.equal((await resume.apply(F.noHeartbeat, rp.plan_hash)).completed_employees, 2);
  }, db, true);
  await transaction(async () => { transport(); const resume = modules.createActivityImportSession(task.job_token); await resume.target.bind(activity.catalog); const rp = await resume.plan();
    assert.equal((await resume.apply(F.empty, rp.plan_hash)).completed_employees, 3); assert.equal((await resume.verify()).verified, true); }, db, true);
  await transaction(async () => { await assertRestored(); assert.deepEqual(await business(db, true), outside); assert.deepEqual(await triggers(), original); await stillClosed(); }, db, true);
  await transaction(async () => { await rpc('employee_transfer_cancel', auth()); }, db, true);
  await transaction(async () => {
    for (const action of [() => bind(), () => plan(), () => apply(p), () => verify()]) await assert.rejects(action(), /invalid or expired/i);
    await assertRestored(); await stillClosed();
    assert.ok(await scalar(db, 'SELECT sealed_at IS NOT NULL FROM private.employee_transfer_shared_backups WHERE id=$1', [task.job_id]));
  });
});
