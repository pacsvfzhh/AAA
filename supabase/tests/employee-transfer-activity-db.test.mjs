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

// Run directly with node --test. Do not skip absent/broken 19–25 or extend the 12-failure baseline.
const migration = '20261102000025_prepare_notification_configuration.sql';
const KEYS = {
  shared: ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'],
  dispatch: ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'],
  identity: ['accounts', 'credentials', 'orders'],
  finance: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit'],
  activity: ['employee_login_history', 'work_sessions', 'work_stop_markers'],
  verification: ['verification_requests'],
  notifications: ['notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
    'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
    'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients',
    'message_templates', 'broadcast_messages', 'broadcast_recipients'],
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
// Protocol IDs are ASCII and sorted as text COLLATE "C", never with locale-specific collation.
const compareRawIds = (left, right) => {
  const a = JSON.parse(left).id, b = JSON.parse(right).id;
  return a < b ? -1 : a > b ? 1 : 0;
};
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
let packageId, dispatch, identity, finance, activity, verification, notifications, task, guarded;
let verificationDb;
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
async function capture(kind) {
  const sourceBefore = ['activity', 'verification', 'notifications'].includes(kind) ? await business(source) : null;
  const job = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
    ...(['identity', 'finance', 'activity', 'verification', 'notifications'].includes(kind) ? { p_package_id: packageId } : {}) });
  assert.equal(job.success, true);
  const texts = {}, pages = {};
  for (const key of KEYS[kind]) {
    let text = '', after = null; pages[key] = [];
    do {
      const page = await on(source, `get_employee_export_${kind}_page`, { ...auth(job, sourceSession), p_table_key: key, p_after: after, p_limit: 200 });
      assert.equal(page.sha256, hash(page.ndjson)); assert.equal(page.count, lines(page.ndjson).length);
      assert.ok(page.count <= 200); assert.ok(Buffer.byteLength(page.ndjson) <= 262144);
      if (kind === 'activity') modules.validateActivityPage(page, key, after);
      if (kind === 'notifications') modules.validateNotificationsPage(page, key, after);
      pages[key].push(page.count); text += page.ndjson; after = page.next_after;
    } while (after !== null);
    texts[key] = text;
  }
  const files = kind === 'verification' ? syntheticMedia(texts.verification_requests) : undefined;
  if (files) {
    await commitMedia(source, job, sourceSession, files, 'download');
    await commitMedia(source, job, sourceSession, files, 'recheck-export');
  }
  assert.equal((await on(source, `employee_export_${kind}_verify`, auth(job, sourceSession))).verified, true);
  await on(source, kind === 'shared' ? 'employee_transfer_cancel' : `employee_export_${kind}_close`, auth(job, sourceSession));
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
  const point = `local_change_${++sequence}`; await site.exec(`SAVEPOINT ${point}`);
  try {
    for (const t of modes) await site.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
    await site.query(sql, args);
    for (const t of modes) await site.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`);
    await site.exec(`RELEASE SAVEPOINT ${point}`);
  } catch (error) { await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); throw error; }
}
// Mutate untrusted activity files, not server verification/mapping state or the real identity catalog.
function changedInput(key, change) {
  const ordered = lines(change(activity.texts[key])).sort(compareRawIds).join('');
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
async function mediaCommit(site, job, token, action, file, extra = {}, role = 'service_role') {
  // Capture the real authorized generation, never infer it from a fabricated receipt or summary.
  // An explicit override preserves an earlier authorization for the delayed-commit race test.
  const generation = Object.hasOwn(extra, 'p_generation') ? extra.p_generation :
    (await mediaAuthorize(site, job, token, action, file.key)).generation;
  return on(site, MEDIA_COMMIT, { ...auth(job, token), p_action: action, p_object_key: file.key, p_bytes: file.bytes, p_sha256: file.sha256,
    p_content_type: file.content_type, p_storage_origin: ['download', 'recheck-export'].includes(action) ? SOURCE_ORIGIN : TARGET_ORIGIN,
    p_generation: generation, ...extra }, role);
}
async function commitMedia(site, job, token, files, action) {
  for (const file of files) {
    const context = await mediaAuthorize(site, job, token, action, file.key);
    assert.equal(context.key, file.key); assert.equal(context.source_url, file.source_url); assert.equal(context.bucket, 'verification-documents');
    const originalPath = file.source_url.split(MEDIA_PREFIX + '/')[1];
    if (context.direction === 'export') { assert.equal(context.path, originalPath); assert.equal(context.generation, 'export'); }
    else {
      assert.match(context.generation, /^(0|[1-9][0-9]*)$/);
      assert.equal(context.generation, String((await state()).verification_restore?.completed_employees ?? 0));
      const [folder, name] = originalPath.split('/');
      assert.equal(context.path, `${folder}/${name.slice(0, 36)}-transfer-${hash(`${job.job_id}:${file.key}`).slice(0, 32)}.${name.split('.').at(-1).toLowerCase()}`);
      assert.deepEqual(context.file, file);
    }
    const receipt = await mediaCommit(site, job, token, action, file, { p_generation: context.generation });
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
async function verifiedActivity() {
  if ((await state()).activity_restore?.verified) assert.equal((await verify()).verified, true);
  else assert.equal((await restore(await stage())).verified, true);
}
async function vstage(input = verification, { media = true } = {}) {
  // Cached activity was genuinely staged/restored/verified; recheck it through the actual RPC.
  await verifiedActivity(); await vraw(input);
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

const N = { plan: id(6001), rootPlan: id(6002), recurring: id(6101), annual: id(6102), firstLogin: id(6103),
  hidden: id(6104), execution: id(6201), failed: id(6202), historical: id(6203),
  manual: id(7001), automatic: id(7002), manualRecipient: id(7101), autoRecipient: id(7102), template: id(7301), broadcast: id(7401) };
const BIG_STAGE = '9007199254740993';
const ERROR_TEXT = 'synthetic diagnostic must never leave source';
const UNKNOWN_MEDIA = 'https://unmanaged.invalid/never-fetch-notification.png';
async function seedNotifications(site) {
  // All normal protection/FK/business triggers stay enabled. Only real bonus SQL creates money.
  await site.query(`INSERT INTO public.notification_automation_plans(id,owner_admin_id,name,status,activated_at,created_at,updated_at)
    VALUES($1,$3,'來源方案 Alpha','active','2020-01-01T00:00:00.123456Z','2019-01-01','2020-01-01'),
      ($2,$4,'沒有員工也必須導出','archived',NULL,'2019-01-01','2020-01-01')`, [N.plan, N.rootPlan, OLD.branch, OLD.root]);
  for (const [taskId, name, trigger, mode, threshold, month, day, owner, planId, status, shared] of [
    [N.recurring, '循環基線', 'total_orders', 'recurring', 10, null, null, OLD.branch, N.plan, 'active', false],
    [N.annual, '年度日期', 'annual_date', 'reach_once', 1, 2, 29, OLD.branch, N.plan, 'paused', false],
    [N.firstLogin, '首次登入', 'first_login', 'reach_once', 1, null, null, OLD.branch, N.plan, 'paused', false],
    [N.hidden, '無成員舊範本', 'daily_orders', 'reach_once', 2, null, null, OLD.root, null, 'draft', true],
  ]) await site.query(`INSERT INTO public.notification_automation_tasks(id,owner_admin_id,name,trigger_type,trigger_mode,threshold_value,
      annual_month,annual_day,plan_id,status,is_shared_template,title_template,content_template,version,activated_at,starts_at,
      created_at,updated_at,reward_enabled,reward_amount,recipient_scope,delivery_mode)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'原標題𠮷','<p>原內容 {{employee_name}}</p>',7,
      '2020-01-02T03:04:05.123456Z','2020-01-01','2019-01-01','2020-01-02',true,7.25,'selected','realtime_with_login_fallback')`,
    [taskId, owner, name, trigger, mode, threshold, month, day, planId, status, shared]);
  await site.query(`INSERT INTO public.notification_automation_plan_members(plan_id,user_id,created_at)
    VALUES($1,$2,'2021-02-03T04:05:06.654321Z'),($1,$3,'2021-03-04T05:06:07.000001Z')`, [N.plan, F.history, F.noHeartbeat]);
  await site.query(`INSERT INTO public.notification_automation_task_recipients(task_id,user_id,created_at)
    VALUES($1,$2,'2021-02-03T04:05:06.654321Z'),($1,$3,'2021-03-04T05:06:07.000001Z')`, [N.recurring, F.history, F.noHeartbeat]);
  await site.query(`INSERT INTO public.notification_automation_progress(task_id,user_id,last_metric,last_stage,last_period_key,updated_at)
    VALUES($1,$2,$4::numeric,$5::bigint,'all_time','2023-01-01T00:00:00.123456Z'),($1,$3,0,0,'all_time','2023-01-02')`,
    [N.recurring, F.history, F.noHeartbeat, PRECISE, BIG_STAGE]);
  await site.query(`INSERT INTO public.notification_automation_date_runs(task_id,task_version,period_key,created_at)
    SELECT $1,7,'year-'||lpad(n::text,4,'0'),'2024-02-29T01:02:03.654321Z' FROM generate_series(1,203) AS s(n)`, [N.annual]);
  const snapshot = JSON.stringify({ trigger_type: 'total_orders', trigger_mode: 'recurring', threshold_value: 10,
    minimum_daily_orders: null, minimum_daily_work_minutes: null });
  await site.query(`INSERT INTO public.notification_automation_executions(id,task_id,task_version,owner_admin_id,user_id,employee_username,
      period_key,stage,actual_value,trigger_snapshot,title_snapshot,content_snapshot,reward_amount,reward_currency,status,executed_at,plan_id)
    VALUES($1,$2,7,$3,$4,'歷史員工名稱','all_time',$5::bigint,20,$6::jsonb,'原標題','原內容',7.25,'USDC','processing',
      '2023-04-05T06:07:08.123456Z',$7)`, [N.execution, N.recurring, OLD.branch, F.history, BIG_STAGE, snapshot, N.plan]);
  await site.query(`INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority,notification_category,
      reward_amount,reward_currency,automation_execution_id,audit_origin,delivery_mode,created_at)
    VALUES($1,$3,'branch','手動獎勵','<p>手動𠮷</p>','login_popup','high','performance_reward',12.5,'USDC',NULL,'manual_admin','login_only','2023-04-05T06:07:08.123456Z'),
      ($2,$3,'branch','自動獎勵','<p>循環獎勵</p>','realtime','normal','performance_reward',7.25,'USDC',$4,'automation','realtime_with_login_fallback','2023-04-05T06:07:08.654321Z')`,
    [N.manual, N.automatic, OLD.branch, N.execution]);
  await site.query(`INSERT INTO public.message_recipients(id,message_id,recipient_id,is_read,read_at,is_shown,shown_at,delivery_channel,delivered_at,delivery_sequence,
      delivery_claim_token,delivery_claim_channel,delivery_claim_until,delivery_completed_claim_token,created_at)
    VALUES($1,$3,$5,true,'2023-04-06T00:00:00.123456Z',true,'2023-04-05','login_popup','2023-04-05',$6::bigint,
      $7,'login_popup','2099-01-01',$8,'2023-04-05T06:07:08.123456Z'),
      ($2,$4,$5,false,NULL,false,NULL,NULL,NULL,$6::bigint+1,NULL,NULL,NULL,NULL,'2023-04-05T06:07:08.654321Z')`,
    [N.manualRecipient, N.autoRecipient, N.manual, N.automatic, F.history, BIG_STAGE, id(7991), id(7992)]);
  await scalar(site, 'SELECT private.credit_performance_bonus($1,$2,12.5,$3,$4,$5,$6)',
    [F.history, OLD.branch, 'USDC', N.manualRecipient, id(7993), 'local manual bonus']);
  const bonus = await scalar(site, 'SELECT private.credit_performance_bonus($1,$2,7.25,$3,$4,$5,$6)',
    [F.history, OLD.branch, 'USDC', N.autoRecipient, N.execution, 'local automatic bonus']);
  await site.query(`UPDATE public.notification_automation_executions SET message_id=$2,wallet_transaction_id=$3,status='succeeded',
    completed_at='2023-04-05T06:08:09.000001Z' WHERE id=$1`, [N.execution, N.automatic, bonus]);
  await site.query(`INSERT INTO public.notification_automation_executions(id,task_version,employee_username,period_key,stage,actual_value,
      trigger_snapshot,title_snapshot,content_snapshot,status,error_message,executed_at,completed_at)
    VALUES($1,1,'已不存在的歷史員工','legacy',1,0,$3::jsonb,'失敗','失敗','failed',$4,'2022-01-01','2022-01-01'),
      ($2,1,'可空歷史關聯','legacy',1,0,$3::jsonb,'歷史','歷史','failed',NULL,'2022-01-01',NULL)`,
    [N.failed, N.historical, snapshot, ERROR_TEXT]);
  await site.query(`INSERT INTO public.notification_automation_failures(task_id,user_id,owner_admin_id,attempts,last_error,first_failed_at,last_failed_at)
    VALUES($1,$2,$3,3,$4,'2022-01-01T00:00:00.123456Z','2022-01-02T00:00:00.654321Z')`, [N.recurring, F.history, OLD.branch, ERROR_TEXT]);
  await site.query(`INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority,audit_origin,delivery_mode,created_at)
    SELECT ('72000000-0000-4000-8000-'||lpad(to_hex(10000+n),12,'0'))::uuid,$1,'branch','普通通知 '||n,
      E'<p>原文𠮷 é é \\n</p>','realtime','normal','manual_admin','realtime_only',NULL FROM generate_series(1,203) AS s(n)`, [OLD.branch]);
  await site.query(`INSERT INTO public.message_recipients(id,message_id,recipient_id,is_read,is_shown,created_at)
    SELECT ('72000000-0000-4000-8000-'||lpad(to_hex(11000+n),12,'0'))::uuid,
      ('72000000-0000-4000-8000-'||lpad(to_hex(10000+n),12,'0'))::uuid,$1,NULL,NULL,NULL FROM generate_series(1,203) AS s(n)`, [F.noHeartbeat]);
  await site.query(`INSERT INTO public.message_templates(id,admin_id,name,title,content,message_type,priority,sort_order,delivery_mode)
    VALUES($1,$2,'無收件人的範本','原標題','<img src="'||$3||'">','realtime','urgent',9,'realtime_only')`, [N.template, OLD.root, UNKNOWN_MEDIA]);
  await site.query(`INSERT INTO public.broadcast_messages(id,admin_id,message_content,message_type,image_url,target_type,target_admin_id,sent_count,created_at)
    VALUES($1,NULL,'歷史廣播','image',$2,'all',NULL,NULL,NULL)`, [N.broadcast, UNKNOWN_MEDIA]);
  await site.query(`INSERT INTO public.broadcast_recipients(id,broadcast_id,employee_id,is_read,read_at,created_at)
    VALUES($1,$2,$3,true,'2023-01-01T00:00:00.654321Z',NULL)`, [id(7402), N.broadcast, F.history]);
}
const nbind = (input = notifications, extra = {}) => rpc('employee_import_notifications_bind', { ...auth(), p_catalog: input.catalog, ...extra });
const nchunk = (key, no, text, extra = {}) => rpc('employee_import_notifications_stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text, ...extra });
const nplan = (extra = {}) => rpc('get_employee_import_notifications_plan', { ...auth(), ...extra });
async function nstage(input = notifications, { omit = null, transform = (_key, _no, text) => text } = {}) {
  await nbind(input);
  for (const key of KEYS.notifications) for (const [no, text] of chunks(input.texts[key]).entries()) {
    if (omit === `${key}:${no}`) continue;
    const raw = transform(key, no, text), receipt = await nchunk(key, no, raw);
    assert.deepEqual(modules.validateNotificationsStage(receipt, lines(raw).length, Buffer.byteLength(raw), hash(raw)), receipt);
  }
}
// Rehash untrusted input files only; never manufacture private verified/map/done receipts.
function changedNotifications(changes) {
  const texts = { ...notifications.texts };
  for (const [key, change] of Object.entries(changes)) texts[key] = lines(change(texts[key])).sort(compareRawIds).join('');
  return { texts, catalog: { ...notifications.catalog, tables: KEYS.notifications.map(key => ({ key, rows: lines(texts[key]).length,
    bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: hash(lines(texts[key]).map(hash).join('')) })) } };
}
const changeNotificationRow = (match, fields) => text => lines(text).map(line => {
  const row = JSON.parse(line); return match(row) ? JSON.stringify({ ...row, ...fields }) + '\n' : line;
}).join('');
const ncounts = () => Object.fromEntries(notifications.catalog.tables.map(t => [t.key, t.rows]));
function notificationFlags(p) {
  flags(p); assert.equal(p.checked, true); assert.equal(p.can_restore, false);
  for (const key of ['restore_pending', 'media_pending', 'automation_pending']) assert.equal(p[key], true, key);
  assert.deepEqual(p.counts, ncounts()); assert.equal(p.employees, 3); assert.equal(p.rewards, 2);
  assert.deepEqual(modules.validateNotificationsPlan(p), p);
}
const transferSnapshot = (site = db) => rows(site, ['private.employee_transfer_jobs', 'private.employee_transfer_staging',
  'private.employee_transfer_events', 'private.employee_transfer_write_permits', 'private.employee_transfer_maintenance',
  'public.financial_operations', 'public.notification_automation_queue', 'public.wallet_reconciliation_queue'].map(name =>
  `SELECT '${name}' AS name,COALESCE(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),'[]'::jsonb)::text AS body FROM ${name} AS r`).join(' UNION ALL '));

before(async () => {
  const noNetwork = () => assert.fail('activity/verification/notifications DB tests prohibit all network and real Storage access');
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
  // No orders; clear initial wallets before adding real performance bonuses below.
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
  await transaction(() => seedNotifications(source), source, true);
  await db.query("INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,'activity-other-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)", [id(900), PASSWORDS.root]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [id(900)]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency); other = await adminLogin(db, 'activity-other-root', PASSWORDS.root);
  guarded = await scalar(db, 'SELECT private.employee_transfer_guarded_tables()'); packageId = randomUUID();
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const compiled = await build({ stdin: { contents: `export {createReplacementBackup} from './src/lib/employeeTransfer/replacementBackup.ts';
    export {createDispatchBackup} from './src/lib/employeeTransfer/dispatchBackup.ts';
    export * from './src/lib/employeeTransfer/notificationsBackup.ts';
    export {createSharedSettingsReplacementSession,createDispatchImportSession} from './src/lib/employeeTransfer/api.ts';
    export * from './src/lib/employeeTransfer/activityApi.ts'; export * from './src/lib/employeeTransfer/activityTransfer.ts';
    export * from './src/lib/employeeTransfer/notificationsApi.ts'; export * from './src/lib/employeeTransfer/notificationsTransfer.ts';
    export * from './src/lib/employeeTransfer/notificationsConfigurationApi.ts';
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
  verification = await transaction(() => capture('verification'), source, true);
  notifications = await transaction(() => capture('notifications'), source, true);
  assert.deepEqual(modules.validateNotificationsCatalog(notifications.catalog), notifications.catalog);
  assert.deepEqual(notifications.catalog.identity_catalog, identity.catalog); assert.deepEqual(notifications.catalog.finance_catalog, finance.catalog);
  assert.deepEqual(activity.catalog.identity_catalog, identity.catalog); assert.deepEqual(finance.catalog.identity_catalog, identity.catalog);
  // Commit this expensive authentic prerequisite chain once; individual activity tests roll back to it.
  await transaction(async () => { const r = await prepare('dispatch', dispatch); task = r.job; await ready(r.plan); await stillClosed(); }, db, true);
}, { timeout: 240000 });
after(async () => { try {
  assert.equal(globalThis.fetch.mock.callCount(), 0, 'no fetch, including fake Storage URLs');
  for (const [object, methods] of [[http, ['request', 'get']], [https, ['request', 'get']], [net, ['connect', 'createConnection']], [tls, ['connect']]])
    for (const method of methods) assert.equal(object[method].mock.callCount(), 0, `no network ${method}`);
  await Promise.all([source?.close(), db?.close(), verificationDb?.close()]);
} finally { mock.restoreAll(); } });

test('552 real migrations preserve exactly the 12 historical failures and install activity 19/20, verification 21/22 and notifications 23/24/25', () => {
  assert.equal(replay.files.length, 552); assert.equal(replay.failures.length, 12); assert.equal(replay.validation.freshDatabaseVerified, false); assert.equal(replay.files.at(-1), migration);
  for (const file of ['20261102000019_export_stage_employee_activity.sql', '20261102000020_restore_employee_activity.sql',
    '20261102000021_export_stage_employee_verification.sql', '20261102000022_restore_employee_verification_media.sql',
    '20261102000023_export_stage_site_notifications.sql']) assert.ok(replay.files.includes(file));
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

test('notifications public RPCs have exact signatures, browser grants and a genuinely STABLE direct-read plan', () => transaction(async () => {
  for (const [name, args] of [
    ['employee_export_notifications_begin', ['p_admin_session_token', 'p_admin_password', 'p_package_id']],
    ['get_employee_export_notifications_page', ['p_admin_session_token', 'p_job_token', 'p_table_key', 'p_after', 'p_limit']],
    ['employee_export_notifications_verify', ['p_admin_session_token', 'p_job_token']],
    ['employee_export_notifications_close', ['p_admin_session_token', 'p_job_token']],
    ['employee_import_notifications_bind', ['p_admin_session_token', 'p_job_token', 'p_catalog']],
    ['employee_import_notifications_stage', ['p_admin_session_token', 'p_job_token', 'p_table_key', 'p_chunk_no', 'p_ndjson']],
    ['get_employee_import_notifications_plan', ['p_admin_session_token', 'p_job_token']],
  ]) {
    const found = await rows(db, `SELECT oid,proargnames,prosecdef,provolatile,prosrc,proconfig,
      EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS everyone
      FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1`, [name]);
    assert.equal(found.length, 1); const fn = found[0]; assert.deepEqual(fn.proargnames, args); assert.equal(fn.prosecdef, true);
    assert.equal(fn.everyone, false); assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2::oid,'EXECUTE')", [role, fn.oid]), role !== 'service_role');
    if (name === 'get_employee_import_notifications_plan') {
      assert.equal(fn.provolatile, 's'); assert.match(fn.prosrc, /FROM private\.employee_transfer_jobs/);
      assert.doesNotMatch(fn.prosrc, /private\.employee_transfer_job\s*\(|\b(?:UPDATE|INSERT|DELETE)\b/i);
    }
  }
  const helpers = await rows(db, "SELECT oid,proname FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%notifications%'");
  assert.ok(helpers.length >= 10);
  for (const fn of helpers) for (const role of ['anon', 'authenticated', 'service_role'])
    assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2::oid,'EXECUTE')", [role, fn.oid]), false, fn.proname);
  for (const role of ['anon', 'authenticated', 'service_role']) for (const relation of ['private.employee_transfer_jobs', 'private.employee_transfer_staging'])
    for (const permission of ['INSERT', 'UPDATE', 'DELETE']) assert.equal(await scalar(db, 'SELECT has_table_privilege($1,$2,$3)', [role, relation, permission]), false);
  assert.equal(await scalar(db, `SELECT count(*)::int FROM pg_proc WHERE pronamespace='public'::regnamespace
    AND proname IN ('employee_import_notifications_apply','employee_import_notifications_verify','employee_import_notifications_close')`), 0);
}));

test('notifications raw SQL pages export every row of all 13 tables, composite cursors, bigint strings and only sanitized failures', () => transaction(async () => {
  assert.deepEqual(KEYS.notifications, [...modules.NOTIFICATIONS_TABLE_KEYS]);
  for (const key of KEYS.notifications) {
    const table = notifications.catalog.tables.find(t => t.key === key), text = notifications.texts[key];
    assert.equal(table.rows, await scalar(source, `SELECT count(*)::int FROM public.${key}`), key);
    assert.ok(table.rows > 0, key); assert.equal(table.bytes, Buffer.byteLength(text)); assert.equal(table.row_hashes_sha256, hash(lines(text).map(hash).join('')));
    const virtual = ['notification_automation_plan_members', 'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_date_runs', 'notification_automation_failures'].includes(key);
    let extra = "'{}'::jsonb";
    if (virtual) extra = `jsonb_build_object('id',${key === 'notification_automation_plan_members' ? 'r.user_id::text' : key === 'notification_automation_date_runs'
      ? "r.task_id::text||':'||lpad(r.task_version::text,10,'0')||':'||r.period_key" : "r.task_id::text||':'||r.user_id::text"})`;
    if (key === 'notification_automation_progress') extra += "||jsonb_build_object('last_stage',r.last_stage::text)";
    if (key === 'notification_automation_executions') extra += "||jsonb_build_object('stage',r.stage::text,'error_message',CASE WHEN r.error_message IS NULL THEN NULL ELSE 'redacted migration error' END)";
    if (key === 'notification_automation_failures') extra += "||jsonb_build_object('last_error','redacted migration error'::text)";
    if (key === 'message_recipients') extra += "||jsonb_build_object('delivery_sequence',r.delivery_sequence::text)";
    const expected = await rows(source, `SELECT body::text||E'\\n' AS line FROM (SELECT (to_jsonb(r)-ARRAY['delivery_claim_token',
      'delivery_claim_channel','delivery_claim_until','delivery_completed_claim_token']::text[])||${extra} AS body FROM public.${key} AS r) AS s ORDER BY body->>'id' COLLATE "C"`);
    assert.equal(text, expected.map(r => r.line).join(''), key);
    for (const line of lines(text)) modules.validateNotificationsRow(line, key);
  }
  for (const key of ['messages', 'message_recipients', 'notification_automation_date_runs']) assert.deepEqual(notifications.pages[key], [200, key.endsWith('date_runs') ? 3 : 5]);
  assert.match(notifications.texts.notification_automation_progress, new RegExp(PRECISE.replace('.', '\\.')));
  assert.equal(JSON.parse(lines(notifications.texts.notification_automation_progress)[0]).last_stage, BIG_STAGE);
  assert.equal(JSON.parse(lines(notifications.texts.notification_automation_executions)[0]).stage, BIG_STAGE);
  const recipients = lines(notifications.texts.message_recipients).map(line => JSON.parse(line));
  assert.equal(recipients[0].delivery_sequence, BIG_STAGE);
  assert.doesNotMatch(notifications.texts.message_recipients, /delivery_claim|completed_claim|7991|7992/);
  assert.ok(await scalar(source, 'SELECT delivery_claim_token IS NOT NULL FROM public.message_recipients WHERE id=$1', [N.manualRecipient]));
  assert.match(notifications.texts.notification_automation_failures, /redacted migration error/);
  assert.doesNotMatch(Object.values(notifications.texts).join(''), new RegExp(ERROR_TEXT));
  assert.match(notifications.texts.notification_automation_plan_members, /2021-02-03T04:05:06.654321/);
  assert.match(notifications.texts.message_templates, /無收件人的範本/); assert.match(notifications.texts.notification_automation_tasks, /無成員舊範本/);
  assert.equal((await on(source, 'get_employee_transfer_log', { p_admin_session_token: sourceSession })).last_export_at, null);
}, source));

test('notifications mixed-case and punctuation period cursors use C text order in real SQL staging and preflight', () => transaction(async () => {
  const key = 'notification_automation_date_runs', original = JSON.parse(lines(notifications.texts[key])[0]);
  const periods = ['a:1', 'Z', 'a', '_'];
  const input = changedNotifications({ [key]: () => periods.map(period_key => JSON.stringify({ ...original,
    id: `${original.task_id}:0000000007:${period_key}`, period_key }) + '\n').join('') });
  const ordered = lines(input.texts[key]).map(line => JSON.parse(line));
  assert.deepEqual(ordered.map(row => row.period_key), ['Z', '_', 'a', 'a:1']);
  modules.validateNotificationsPage({ table_key: key, count: ordered.length, ndjson: input.texts[key], next_after: null,
    sha256: hash(input.texts[key]) }, key, null);
  await nstage(input); const saved = await transferSnapshot(), before = await business(), p = await nplan();
  assert.equal(p.counts[key], periods.length); assert.deepEqual(p.conflicts, []); assert.equal(p.checked, true); assert.equal(p.can_restore, false);
  assert.deepEqual(await transferSnapshot(), saved); assert.deepEqual(await business(), before); await stillClosed();
}));

test('notifications checked preflight never restores, pays, starts automation or mutates business, heartbeat, summary or staging', () => transaction(async () => {
  const before = await business(), original = await triggers();
  assert.equal((await state()).activity_restore, undefined); assert.equal((await state()).verification_restore, undefined);
  assert.equal(await scalar(db, "SELECT sum(amount)::text FROM public.wallet_transactions WHERE type='performance_bonus'"), '19.75');
  await nstage(); const saved = await transferSnapshot();
  const p = await nplan(); notificationFlags(p); assert.deepEqual(p.conflicts, []);
  assert.deepEqual(await nplan(), p); assert.deepEqual(await transferSnapshot(), saved);
  assert.deepEqual(await business(), before); assert.deepEqual(await triggers(), original); await stillClosed();
  for (const key of KEYS.notifications) assert.equal(await scalar(db, `SELECT count(*)::int FROM public.${key}`), 0, key);
  const historical = JSON.parse(lines(notifications.texts.notification_automation_executions).find(line => JSON.parse(line).id === N.historical));
  for (const key of ['task_id', 'plan_id', 'owner_admin_id', 'user_id', 'message_id', 'wallet_transaction_id']) assert.equal(historical[key], null);
  assert.match(notifications.texts.message_templates, /unmanaged.invalid/); assert.equal(p.media_pending, true);
}));

test('notifications immutable bind and repeated raw chunks preserve exact receipts; missing blocks, order and byte drift are rejected', () => transaction(async () => {
  const before = await business(); await nbind(); assert.equal((await nbind()).repeated, true);
  const altered = changedNotifications({ messages: text => text.replace('普通通知 1', '其他通知 1') });
  await assert.rejects(nbind(altered), /immutable/i);
  const parts = chunks(notifications.texts.messages);
  await assert.rejects(nchunk('messages', 1, parts[1]), /catalog|cursor order/i);
  await assert.rejects(nchunk('messages', 0, lines(parts[0]).reverse().join('')), /strictly ordered/i);
  await nchunk('messages', 0, parts[0]); assert.equal((await nchunk('messages', 0, parts[0])).repeated, true);
  await assert.rejects(nchunk('messages', 0, parts[0].replace('手動獎勵', '其他獎勵')), /content changed/i);
  await assert.rejects(nchunk('messages', 1, parts[0]), /catalog|cursor order/i);
  await nstage(notifications, { omit: 'messages:1' }); await assert.rejects(nplan(), /staged catalog verification failed/i);
  await nchunk('messages', 1, parts[1].replace('普通通知', '其他通知'));
  const saved = await transferSnapshot(); await assert.rejects(nplan(), /staged catalog verification failed/i);
  assert.deepEqual(await transferSnapshot(), saved); assert.deepEqual(await business(), before); await stillClosed();
}));

test('notifications empty optional date table still requires an explicit immutable empty staging chunk', () => transaction(async () => {
  const input = changedNotifications({ notification_automation_date_runs: () => '' }); input.catalog.date_runs_supported = false;
  assert.deepEqual(modules.validateNotificationsCatalog(input.catalog), input.catalog);
  await nstage(input, { omit: 'notification_automation_date_runs:0' }); await assert.rejects(nplan(), /staged catalog verification failed/i);
  const receipt = await nchunk('notification_automation_date_runs', 0, '');
  assert.deepEqual(receipt, { success: true, rows: 0, bytes: 0, sha256: hash(''), repeated: false });
  assert.equal((await nchunk('notification_automation_date_runs', 0, '')).repeated, true);
  await assert.rejects(nchunk('notification_automation_date_runs', 1, ''), /empty chunk/i);
  const saved = await transferSnapshot(), before = await business(), p = await nplan();
  assert.equal(p.counts.notification_automation_date_runs, 0); assert.deepEqual(p.conflicts, []); assert.equal(p.can_restore, false);
  assert.deepEqual(await transferSnapshot(), saved); assert.deepEqual(await business(), before); await stillClosed();
}));

test('notifications stage rejects unknown/lease/duplicate keys, unsafe snapshots, malformed composite and bigint values without partial staging', () => transaction(async () => {
  await nbind(); const saved = await transferSnapshot(), before = await business();
  const line = lines(notifications.texts.message_recipients)[0], execution = lines(notifications.texts.notification_automation_executions)[0];
  for (const text of [line.replace('{', '{"unexpected":1,'), line.replace('{', '{"delivery_claim_token":null,'),
    line.replace('{', '{"delivery_claim_channel":null,'), line.replace('{', '{"delivery_claim_until":null,'), line.replace('{', '{"delivery_completed_claim_token":null,'),
    line.replace('{', '{"id":"' + N.manualRecipient + '",'), line.replace('{', '{"\\u0069d":"' + N.manualRecipient + '",'),
    line.replace(`"${BIG_STAGE}"`, BIG_STAGE), line.replace(BIG_STAGE, '9223372036854775808'), line.slice(0, -1)])
    await assert.rejects(nchunk('message_recipients', 0, text), /Invalid notifications/i);
  await assert.rejects(nchunk('notification_automation_executions', 0, execution.replace('"trigger_type":', '"threshold_value":1,"trigger_type":')), /Invalid notifications/i);
  await assert.rejects(nchunk('notification_automation_failures', 0, notifications.texts.notification_automation_failures.replace('redacted migration error', ERROR_TEXT)), /Invalid notifications/i);
  await assert.rejects(nchunk('notification_automation_progress', 0, notifications.texts.notification_automation_progress.replace(`${N.recurring}:${F.history}`, F.history)), /Invalid notifications/i);
  await assert.rejects(nchunk('messages', 0, notifications.texts.messages), /row limit/i);
  for (const key of ['orders', 'notifications-done', 'notification_automation_queue', null]) await assert.rejects(nchunk(key, 0, ''), /Unsupported/i);
  assert.deepEqual(await transferSnapshot(), saved); assert.deepEqual(await business(), before);
}));

for (const [label, change] of [
  ['package', c => { const p = randomUUID(); c.package_id = p; c.identity_catalog.package_id = p; c.finance_catalog.package_id = p; c.finance_catalog.identity_catalog.package_id = p; }],
  ['site', c => { const s = randomUUID(); c.site_id = s; c.identity_catalog.site_id = s; c.finance_catalog.site_id = s; c.finance_catalog.identity_catalog.site_id = s; }],
  ['identity raw digest', c => { c.identity_catalog.tables[0].row_hashes_sha256 = hash('untrusted changed identity'); c.finance_catalog.identity_catalog = structuredClone(c.identity_catalog); }],
  ['finance raw digest', c => { c.finance_catalog.tables[0].row_hashes_sha256 = hash('untrusted changed finance'); }],
]) test(`notifications bind rejects changed ${label} instead of forging prerequisite maps`, () => transaction(async () => {
  const catalog = structuredClone(notifications.catalog); change(catalog); const before = await business();
  await assert.rejects(nbind({ catalog }), /binding|source|catalog|identity|finance/i); assert.deepEqual(await business(), before);
  assert.equal((await state()).notifications_catalog, undefined); await stillClosed();
}));

for (const [label, changes, conflict] of [
  ['unmapped employee', { broadcast_recipients: changeNotificationRow(() => true, { employee_id: F.outsider }) }, 'source_employee_missing'],
  ['unmapped administrator', { message_templates: changeNotificationRow(() => true, { admin_id: F.outsider }) }, 'source_admin_unmapped'],
  ['missing parent', { notification_automation_tasks: changeNotificationRow(r => r.id === N.recurring, { source_task_id: F.outsider }) }, 'source_reference_missing'],
  ['cross-owner plan', { notification_automation_tasks: changeNotificationRow(r => r.id === N.recurring, { plan_id: N.rootPlan }) }, 'source_scope_mismatch'],
  ['case-folded plan uniqueness', { notification_automation_plans: text => text + JSON.stringify({ ...JSON.parse(lines(text)[0]), id: id(6999), name: '來源方案 ALPHA' }) + '\n' }, 'source_unique_collision'],
  ['reward amount', { messages: changeNotificationRow(r => r.id === N.manual, { reward_amount: 12.6 }) }, 'reward_link_mismatch'],
  ['reward user', { message_recipients: changeNotificationRow(r => r.id === N.autoRecipient, { recipient_id: F.noHeartbeat }),
    notification_automation_executions: changeNotificationRow(r => r.id === N.execution, { user_id: F.noHeartbeat }) }, 'reward_link_mismatch'],
  ['reward reference', { message_recipients: changeNotificationRow(r => r.id === N.autoRecipient, { id: id(7199) }) }, 'reward_link_mismatch'],
  ['reward operation', { messages: changeNotificationRow(r => r.id === N.automatic, { automation_execution_id: id(6299) }),
    notification_automation_executions: changeNotificationRow(r => r.id === N.execution, { id: id(6299) }) }, 'reward_link_mismatch'],
  ['wrong finance transaction', { notification_automation_executions: changeNotificationRow(r => r.id === N.execution, { wallet_transaction_id: null }) }, 'reward_link_mismatch'],
  ['succeeded missing message', { notification_automation_executions: changeNotificationRow(r => r.id === N.execution, { message_id: null }) }, 'reward_link_mismatch'],
  ['succeeded reverse execution', { messages: changeNotificationRow(r => r.id === N.automatic, { automation_execution_id: null, audit_origin: 'manual_admin' }) }, 'reward_link_mismatch'],
  ['succeeded sender mismatch', { messages: changeNotificationRow(r => r.id === N.automatic, { sender_id: OLD.root }) }, 'reward_link_mismatch'],
  ['succeeded currency mismatch', { messages: changeNotificationRow(r => r.id === N.automatic, { reward_currency: 'USD' }) }, 'reward_link_mismatch'],
  ['processing warning', { notification_automation_executions: changeNotificationRow(r => r.id === N.historical, { status: 'processing' }) }, 'unfinished_execution'],
]) test(`notifications preflight explicitly reports ${label}; no restore or money movement is permitted`, () => transaction(async () => {
  const input = changedNotifications(changes); await nstage(input); const saved = await transferSnapshot(), before = await business(), original = await triggers();
  const p = await nplan(); flags(p); assert.equal(p.checked, true); assert.equal(p.can_restore, false);
  assert.equal(p.restore_pending, true); assert.equal(p.media_pending, true); assert.equal(p.automation_pending, true);
  assert.ok(p.conflicts.includes(conflict), JSON.stringify(p.conflicts));
  assert.deepEqual(await nplan(), p); assert.deepEqual(await transferSnapshot(), saved);
  assert.deepEqual(await business(), before); assert.deepEqual(await triggers(), original); await stillClosed();
}));

for (const [label, token] of [['secondary', () => branch], ['emergency', () => emergency], ['another super-admin', () => other], ['invalid session', randomUUID]])
  test(`notifications import rejects ${label} for bind, stage and direct-read plan`, () => transaction(async () => {
    await nstage(); const before = await business(), saved = await transferSnapshot(), extra = { p_admin_session_token: token() };
    for (const action of [() => nbind(notifications, extra), () => nchunk('messages', 0, chunks(notifications.texts.messages)[0], extra), () => nplan(extra)])
      await assert.rejects(action(), /Super administrator|invalid or expired/i);
    assert.deepEqual(await transferSnapshot(), saved); assert.deepEqual(await business(), before); assert.equal(await permits(), 0);
  }));

for (const [label, sql, args] of [
  ['expired session', "UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1", () => [NEW.root]],
  ['expired job', "UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", () => [task.job_id]],
  ['stale heartbeat', "UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", () => [task.job_id]],
]) test(`notifications continuation rejects ${label} without refreshing the direct-read plan heartbeat`, () => transaction(async () => {
  await nstage(); await db.query(sql, args()); const saved = await transferSnapshot(), before = await business();
  await assert.rejects(nplan(), /invalid or expired/i); assert.deepEqual(await transferSnapshot(), saved);
  for (const action of [() => nbind(), () => nchunk('messages', 0, chunks(notifications.texts.messages)[0])]) await assert.rejects(action(), /invalid or expired/i);
  assert.deepEqual(await transferSnapshot(), saved); assert.deepEqual(await business(), before); assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
}));

test('notifications canceled dispatch task and foreign export token cannot be used for notification staging or planning', () => transaction(async () => {
  await nstage(); await rpc('employee_transfer_cancel', auth()); const saved = await transferSnapshot(), before = await business();
  for (const action of [() => nbind(), () => nchunk('messages', 0, chunks(notifications.texts.messages)[0]), () => nplan()]) await assert.rejects(action(), /invalid or expired/i);
  await transaction(async () => {
    const exp = await on(source, 'employee_export_notifications_begin', { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root, p_package_id: packageId });
    await assert.rejects(nplan({ p_job_token: exp.job_token }), /invalid or expired/i);
  }, source);
  assert.deepEqual(await transferSnapshot(), saved); assert.deepEqual(await business(), before); await stillClosed();
}));

for (const [label, relation, sql] of [
  ['identity', 'public.users', "UPDATE public.users SET remarks='notification identity drift' WHERE id=$1"],
  ['finance', 'public.wallets', "UPDATE public.wallets SET updated_at='2001-01-01' WHERE user_id=$1"],
]) test(`notifications plan rechecks real ${label} content, not a cached verified flag`, () => transaction(async () => {
  await nstage(); await localChange(db, relation, sql, [F.history]); const saved = await transferSnapshot(), before = await business();
  for (const action of [() => nplan(), () => nbind()]) await assert.rejects(action(), /changed|verification|content/i);
  assert.deepEqual(await transferSnapshot(), saved); assert.deepEqual(await business(), before); assert.equal(await permits(), 0);
}));

test('notifications real API/Transfer streams bytes, resumes committed staging on a reopened database and plans inside READ ONLY', async () => {
  const originalDb = db; let clone;
  try {
    const captured = await transaction(async () => {
      transport(source, sourceSession); const exp = modules.createNotificationsExportSession(packageId, PASSWORDS.root), catalog = await exp.begin(), files = new Map();
      const result = await modules.exportNotificationsData(exp.source, { async append(path, bytes) {
        files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)]));
      }, async abort() { assert.fail('successful notifications export must not abort'); } });
      assert.equal(result.rows, Object.values(ncounts()).reduce((a, b) => a + b, 0)); await exp.close(); return { catalog, files };
    }, source);
    clone = new PGlite({ loadDataDir: await originalDb.dumpDataDir('none'), extensions: { pgcrypto, pg_trgm, uuid_ossp } }); await clone.waitReady; db = clone;
    const before = await business(), original = await triggers(); let p;
    await transaction(async () => {
      transport(); const imp = modules.createNotificationsImportSession(task.job_token); let discarded = 0;
      const result = await modules.stageNotificationsImport(captured.catalog, { open(path) { return (async function* () {
        const raw = captured.files.get(path); assert.ok(raw); for (let n = 0; n < raw.length; n += 53) yield raw.subarray(n, n + 53);
      })(); }, async abort() { discarded++; } }, imp.target);
      assert.equal(discarded, 1); p = result.plan; notificationFlags(p); assert.deepEqual(p.conflicts, []);
    }, db, true);
    const dump = await db.dumpDataDir('none'); await db.close(); clone = new PGlite({ loadDataDir: dump, extensions: { pgcrypto, pg_trgm, uuid_ossp } }); await clone.waitReady; db = clone;
    await transaction(async () => {
      transport(); const resumed = modules.createNotificationsImportSession(task.job_token); assert.equal((await resumed.target.bind(captured.catalog)).repeated, true);
      for (const key of KEYS.notifications) for (const [no, text] of chunks(notifications.texts[key]).entries()) assert.equal((await resumed.target.stage(key, no, text)).repeated, true);
      assert.deepEqual(await resumed.plan(), p);
    }, db, true);
    const saved = await transferSnapshot();
    // Must be the first transaction statement, not a savepoint pretending to be read-only.
    await db.exec('BEGIN; SET TRANSACTION READ ONLY');
    try { assert.deepEqual(await nplan(), p); await db.exec('COMMIT'); } catch (error) { await db.exec('ROLLBACK'); throw error; }
    assert.deepEqual(await transferSnapshot(), saved); assert.deepEqual(await business(), before); assert.deepEqual(await triggers(), original);
    await transaction(async () => { await stillClosed(); await rpc('employee_transfer_cancel', auth()); }, db, true);
    await transaction(async () => { await assert.rejects(nplan(), /invalid or expired/i); await stillClosed(); });
  } finally { await clone?.close(); db = originalDb; transport(); }
});

const nexport = (extra = {}) => on(source, 'employee_export_notifications_begin', {
  p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root, p_package_id: packageId, ...extra });
test('notifications source password, role, job ownership, protocol, page limits and canonical composite cursors are enforced', () => transaction(async () => {
  assert.equal((await nexport({ p_admin_password: 'wrong-local-password' })).success, false);
  const secondary = await adminLogin(source, 'branch', PASSWORDS.branch);
  await assert.rejects(nexport({ p_admin_session_token: secondary, p_admin_password: PASSWORDS.branch }), /Super administrator/i);
  const exp = await nexport();
  for (const name of ['get_employee_export_notifications_page', 'employee_export_notifications_verify', 'employee_export_notifications_close'])
    await assert.rejects(on(source, name, { ...auth(exp, secondary), ...(name.endsWith('_page') ? { p_table_key: 'messages' } : {}) }), /Super administrator|invalid or expired/i);
  for (const key of ['notification_automation_queue', 'financial_operations', null]) await assert.rejects(on(source, 'get_employee_export_notifications_page', { ...auth(exp, sourceSession), p_table_key: key }), /Unsupported/i);
  for (const limit of [0, 201, null]) await assert.rejects(on(source, 'get_employee_export_notifications_page', { ...auth(exp, sourceSession), p_table_key: 'messages', p_limit: limit }), /page size/i);
  for (const cursor of [F.history, `${N.annual}:7:year-0001`, `${N.annual}:0000000007:year-9999`]) await assert.rejects(on(source, 'get_employee_export_notifications_page', {
    ...auth(exp, sourceSession), p_table_key: 'notification_automation_date_runs', p_after: cursor }), /cursor/i);
  for (const name of ['employee_export_activity_verify', 'employee_export_finance_verify', 'employee_export_finish']) await assert.rejects(on(source, name, {
    ...auth(exp, sourceSession), ...(name.endsWith('finish') ? { p_summary: {} } : {}) }), /protocol/i);
  await on(source, 'employee_export_notifications_verify', auth(exp, sourceSession)); await on(source, 'employee_export_notifications_close', auth(exp, sourceSession));
  const expired = await nexport(); await source.query("UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", [expired.job_id]);
  await assert.rejects(on(source, 'employee_export_notifications_verify', auth(expired, sourceSession)), /invalid or expired/i);
  await on(source, 'employee_transfer_cancel', auth(expired, sourceSession)); const canceled = await nexport(); await on(source, 'employee_transfer_cancel', auth(canceled, sourceSession));
  await assert.rejects(on(source, 'employee_export_notifications_verify', auth(canceled, sourceSession)), /invalid or expired/i);
}, source));

for (const [label, relation, sql, args] of [
  ['notification same count', 'public.messages', "UPDATE public.messages SET title='same-count notification drift' WHERE id=$1", [N.manual]],
  ['automation baseline same count', 'public.notification_automation_progress', 'UPDATE public.notification_automation_progress SET last_stage=last_stage+1 WHERE user_id=$1', [F.history]],
  ['identity same count', 'public.users', "UPDATE public.users SET remarks='same-count identity drift' WHERE id=$1", [F.history]],
  ['finance same count', 'public.wallets', "UPDATE public.wallets SET updated_at='2001-01-01' WHERE user_id=$1", [F.history]],
]) test(`notifications source verify and close reject ${label} even after an earlier successful verification`, () => transaction(async () => {
  const exp = await nexport(); await assert.rejects(on(source, 'employee_export_notifications_close', auth(exp, sourceSession)), /not been verified/i);
  await on(source, 'employee_export_notifications_verify', auth(exp, sourceSession));
  if (relation === 'public.messages') {
    // Use the existing audit protection correctly; never disable an unknown source trigger.
    await source.query("SELECT set_config('content_audit.actor',$1,true),set_config('content_audit.operation',$2,true)", [OLD.root, randomUUID()]);
  }
  await source.query(sql, args); const before = await business(source);
  for (const name of ['employee_export_notifications_verify', 'employee_export_notifications_close']) await assert.rejects(on(source, name, auth(exp, sourceSession)), /source changed/i);
  assert.deepEqual(await business(source), before);
}, source));

test('notifications source alone supports absent date_runs as an empty capability, without claiming legacy maintenance compatibility', () => transaction(async () => {
  // Local rollback-only DDL; do not call the old maintenance assert, which still requires this table.
  await source.exec('DROP TABLE public.notification_automation_date_runs');
  const exp = await nexport(); assert.equal(exp.catalog.date_runs_supported, false);
  const table = exp.catalog.tables.find(t => t.key === 'notification_automation_date_runs');
  assert.deepEqual(table, { key: 'notification_automation_date_runs', rows: 0, bytes: 0, row_hashes_sha256: hash('') });
  const page = await on(source, 'get_employee_export_notifications_page', { ...auth(exp, sourceSession), p_table_key: table.key, p_after: null, p_limit: 200 });
  assert.deepEqual(modules.validateNotificationsPage(page, table.key, null), { table_key: table.key, count: 0, ndjson: '', next_after: null, sha256: hash('') });
  assert.deepEqual(modules.validateNotificationsCatalog(exp.catalog), exp.catalog);
  await on(source, 'employee_export_notifications_verify', auth(exp, sourceSession)); await on(source, 'employee_export_notifications_close', auth(exp, sourceSession));
}, source));

// The original activity suite continues against its unchanged finance-ready database. Verification
// tests share a separate real stage/apply/verify snapshot, with each existing transaction rolled back.
// No receipt, private mapping or verified flag is manufactured; the missing-prerequisite case stays
// on the original database. The committed continuation test still clones/reopens its own database.
function verificationTest(name, run) {
  return test(name, async () => {
    if (name === 'verification bind cannot bypass real restored activity prerequisites') return run();
    const activityDb = db;
    try {
      if (!verificationDb) {
        const staged = new PGlite({ loadDataDir: await activityDb.dumpDataDir('none'), extensions: { pgcrypto, pg_trgm, uuid_ossp } });
        try {
          await staged.waitReady; db = staged;
          await transaction(async () => { await verifiedActivity(); await assertRestored(); await stillClosed(); }, staged, true);
          verificationDb = staged;
        } catch (error) { await staged.close(); throw error; }
      }
      db = verificationDb;
      return await run();
    } finally { db = activityDb; transport(); }
  });
}
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
  [MEDIA_COMMIT, ['p_admin_session_token', 'p_job_token', 'p_action', 'p_object_key', 'p_bytes', 'p_sha256', 'p_content_type', 'p_storage_origin', 'p_generation'], true],
]) verificationTest(`verification ${name} keeps exact signature, definer search path and ${service ? 'service-only' : 'browser'} grants`, () => transaction(async () => {
  const found = await rows(db, `SELECT oid,proargnames,prosecdef,proconfig,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS everyone
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1`, [name]);
  assert.equal(found.length, 1); const fn = found[0]; assert.deepEqual(fn.proargnames, args); assert.equal(fn.prosecdef, true);
  assert.equal(fn.everyone, false); assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2::oid,\'EXECUTE\')', [role, fn.oid]), service ? role === 'service_role' : role !== 'service_role');
}));

verificationTest('verification raw source export has 205 rows over two pages, all 15 fields, three statuses, NULL, UTF8 and microseconds', () => transaction(async () => {
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
verificationTest('verification media inventory has exact deduplicated refs; verify blocks before download and before second readback, then verifies/closes without full export time', () => transaction(async () => {
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

verificationTest('verification capture can complete only through actual service-role download/recheck RPCs, not summary injection', () => transaction(async () => {
  const exported = await capture('verification'); assert.deepEqual(exported, verification);
}, source));

for (const [label, extra] of [
  ['wrong source origin', { p_storage_origin: TARGET_ORIGIN }],
  ['changed bytes', { p_bytes: 1 }], ['changed digest', { p_sha256: hash('changed synthetic') }], ['changed MIME', { p_content_type: 'image/gif' }],
]) verificationTest(`verification source commit rejects ${label} without changing the real receipt`, () => transaction(async () => {
  const exp = await vexportBegin(), file = verification.files[0]; await commitMedia(source, exp, sourceSession, [file], 'download');
  const saved = await rows(source, "SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 ORDER BY table_key,chunk_no", [exp.job_id]);
  await assert.rejects(mediaCommit(source, exp, sourceSession, 'recheck-export', file, extra), /not stored on this site|content changed/i);
  assert.deepEqual(await rows(source, "SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 ORDER BY table_key,chunk_no", [exp.job_id]), saved);
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(exp, sourceSession)), /incomplete/i);
}, source));

for (const role of ['anon', 'authenticated']) verificationTest(`verification ${role} cannot call media authorize/commit even with valid administrator/job tokens`, () => transaction(async () => {
  const exp = await vexportBegin(), file = verification.files[0];
  await assert.rejects(mediaAuthorize(source, exp, sourceSession, 'download', file.key, role), /permission denied/i);
  await assert.rejects(mediaCommit(source, exp, sourceSession, 'download', file, {}, role), /permission denied/i);
}, source));

for (const [label, url] of [
  ['foreign employee path', `${SOURCE_ORIGIN}${MEDIA_PREFIX}/id-front/${F.outsider}-synthetic.jpg`],
  ['unmanaged URL', `${SOURCE_ORIGIN}${MEDIA_PREFIX}/id-front/${F.history}-synthetic.jpg?unmanaged=1`],
]) verificationTest(`verification source media refuses ${label} rather than silently dropping a file`, () => transaction(async () => {
  await localChange(source, 'public.verification_requests', 'UPDATE public.verification_requests SET id_front_url=$2 WHERE id=$1', [V.first, url]);
  const exp = await vexportBegin(); await assert.rejects(mediaInventory(source, exp, sourceSession, 'export'), /does not belong|Unmanaged/i);
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(exp, sourceSession)), /does not belong|Unmanaged/i);
}, source));

for (const [label, relation, sql] of [
  ['request same-count drift', 'public.verification_requests', "UPDATE public.verification_requests SET audit_remark='source drift' WHERE id=$1"],
  ['identity drift', 'public.users', "UPDATE public.users SET remarks='source identity drift' WHERE id=$1"],
]) verificationTest(`verification source rechecks ${label} after real media receipts, including after successful verify`, () => transaction(async () => {
  const exp = await vexportBegin(); await commitMedia(source, exp, sourceSession, verification.files, 'download'); await commitMedia(source, exp, sourceSession, verification.files, 'recheck-export');
  await on(source, 'employee_export_verification_verify', auth(exp, sourceSession));
  await localChange(source, relation, sql, [relation === 'public.users' ? F.history : V.first]);
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(exp, sourceSession)), /source changed/i);
}, source));

test('verification bind cannot bypass real restored activity prerequisites', () => transaction(async () => {
  const before = await business(); await assert.rejects(vbind(), /Invalid employee activity catalog\.|Verified same-package.*activity.*required/i); assert.deepEqual(await business(), before); await stillClosed();
}));

verificationTest('verification media_incomplete blocks import before media bind, with missing receipts, and with a missing last upload', () => transaction(async () => {
  const p = await vstage(verification, { media: false }); assert.equal(p.can_restore, false); assert.ok(p.conflicts.includes('media_incomplete')); flags(p);
  await assert.rejects(vapply(p), /conflict-free/i);
  await vmediaBind(); let next = await vplan(); assert.ok(next.conflicts.includes('media_incomplete'));
  await commitMedia(db, task, session, verification.files.slice(0, -1), 'upload'); next = await vplan(); assert.ok(next.conflicts.includes('media_incomplete'));
  await assert.rejects(vapply(next), /conflict-free/i);
  await commitMedia(db, task, session, verification.files.slice(-1), 'upload'); next = await vplan(); assert.equal(next.can_restore, true); flags(next); await stillClosed();
}));

verificationTest('verification restores every original column except mapped reviewers/namespaced URLs; is_verified, money, activity, triggers and dirty maintenance stay independent', () => transaction(async () => {
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

verificationTest('verification final readback must occur after the last actual employee apply, not an earlier successful recheck-import', () => transaction(async () => {
  const p = await vstage(); await commitMedia(db, task, session, verification.files, 'recheck-import');
  for (const employee of EMPLOYEES) await vapply(p, employee);
  await assert.rejects(vverify(), /final document readback is incomplete/i);
  await commitMedia(db, task, session, verification.files.slice(0, -1), 'recheck-import'); await assert.rejects(vverify(), /incomplete/i);
  await commitMedia(db, task, session, verification.files.slice(-1), 'recheck-import'); assert.equal((await vverify()).verified, true); await stillClosed();
}));

verificationTest('verification delayed recheck-import commit rejects the pre-final-apply generation and requires newly authorized final readback', () => transaction(async () => {
  const p = await vstage(), file = verification.files[0];
  assert.equal((await mediaAuthorize(db, task, session, 'recheck-import', file.key)).generation, '0');
  await vapply(p, F.history); await vapply(p, F.noHeartbeat);
  const oldContext = await mediaAuthorize(db, task, session, 'recheck-import', file.key);
  assert.equal(oldContext.generation, '2');
  // The file read started before the final employee apply; only the database generation changes.
  await vapply(p, F.empty);
  const saved = await rows(db, "SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key='verification-media-import' ORDER BY chunk_no", [task.job_id]);
  const summary = await state(), before = await business();
  await assert.rejects(mediaCommit(db, task, session, 'recheck-import', file, { p_generation: oldContext.generation }),
    /Verification media read generation changed; read the file again\./);
  assert.deepEqual(await rows(db, "SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key='verification-media-import' ORDER BY chunk_no", [task.job_id]), saved);
  assert.deepEqual(await state(), summary); assert.deepEqual(await business(), before);
  await assert.rejects(vverify(), /final document readback is incomplete/i);
  const freshContext = await mediaAuthorize(db, task, session, 'recheck-import', file.key);
  assert.equal(freshContext.generation, '3'); assert.notEqual(freshContext.generation, oldContext.generation);
  await mediaCommit(db, task, session, 'recheck-import', file, { p_generation: freshContext.generation });
  await assert.rejects(vverify(), /final document readback is incomplete/i);
  await commitMedia(db, task, session, verification.files.slice(1), 'recheck-import');
  assert.equal((await vverify()).verified, true); await assertVerificationRestored(); await stillClosed();
}));

for (const [label, change] of [
  ['package', c => { c.package_id = randomUUID(); c.identity_catalog.package_id = c.package_id; }],
  ['source site', c => { c.site_id = randomUUID(); c.identity_catalog.site_id = c.site_id; }],
  ['identity raw digest', c => { c.identity_catalog.tables[0].row_hashes_sha256 = hash('other raw identity'); }],
]) verificationTest(`verification bind requires exact same ${label} and refuses replacement catalogs`, () => transaction(async () => {
  await verifiedActivity(); const catalog = structuredClone(verification.catalog); change(catalog); const before = await business();
  await assert.rejects(vbind({ catalog }), /binding|source|catalog|identity|package/i); assert.deepEqual(await business(), before);
  await vbind(); assert.equal((await vbind()).repeated, true); const modified = changedVerification(r => ({ ...r, real_name: r.real_name + 'x' }));
  await assert.rejects(vbind(modified), /immutable/i); await stillClosed();
}));

for (const [label, change, conflict] of [
  ['missing reviewer mapping', r => r.id === V.first ? { ...r, audited_by: F.outsider } : r, 'verification_admin_unmapped'],
  ['missing source employee', r => r.id === V.first ? { ...r, user_id: F.outsider, id_front_url: null, id_back_url: null, selfie_url: null } : r, 'source_employee_missing'],
]) verificationTest(`verification plan blocks ${label} from untrusted source files without modifying private maps`, () => transaction(async () => {
  const p = await vstage(changedVerification(change)); assert.equal(p.can_restore, false); assert.ok(p.conflicts.includes(conflict)); flags(p);
  const before = await business(), saved = await state(); await assert.rejects(vapply(p), /conflict-free/i); assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved); await stillClosed();
}));

const insertVerification = (request, employee) => localChange(db, 'public.verification_requests',
  "INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status) VALUES($1,$2,'synthetic-residual','fake-id','fake-phone','fake-address','pending')", [request, employee]);
for (const [label, request, employee, reason] of [
  ['target residual', V.residual, F.history, 'verification_target_not_empty'],
  ['UUID collision owned by another package employee', V.first, F.noHeartbeat, 'verification_uuid_collision'],
]) verificationTest(`verification plan refuses ${label} without deleting or skipping target rows`, () => transaction(async () => {
  const p = await vstage(); assert.equal(p.can_restore, true); await insertVerification(request, employee); const before = await business(), blocked = await vplan();
  assert.equal(blocked.can_restore, false); assert.ok(blocked.conflicts.includes(reason)); await assert.rejects(vapply(blocked), /conflict-free|changed/i);
  assert.deepEqual(await business(), before); await stillClosed();
}));

verificationTest('verification UUID introduced after planning blocks a later employee without claiming an earlier employee commit was reversed', () => transaction(async () => {
  const p = await vstage(); await vapply(p, F.noHeartbeat); await insertVerification(V.first, F.empty); const before = await business(), saved = await state();
  await assert.rejects(vapply(p), /UUID collision changed/i); assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved);
  assert.equal((await vapply(p, F.noHeartbeat)).repeated, true); assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.verification_requests WHERE user_id=$1', [F.noHeartbeat]), 2); await stillClosed();
}));

for (const [field, value] of [['id', V.residual], ['user_id', F.empty], ['real_name', 'drift'], ['wallet_address', 'drift'], ['phone', 'drift'], ['email', 'drift'],
  ['status', 'rejected'], ['audit_remark', null], ['audited_by', NEW.branch], ['audited_at', null], ['created_at', null],
  ['updated_at', '2001-01-01T00:00:00.000001Z'], ['id_front_url', null], ['id_back_url', `${TARGET_ORIGIN}${MEDIA_PREFIX}/id-back/${F.history}-drift.png`], ['selfie_url', null]])
  verificationTest(`verification same-count ${field} drift blocks repeated apply, plan and final verify`, () => transaction(async () => {
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
]) verificationTest(`verification media bind rejects ${label} without accepting an incomplete or misbound file inventory`, () => transaction(async () => {
  await verifiedActivity(); await vraw(); const before = await business(), saved = await state();
  await assert.rejects(vmediaBind(change(structuredClone(verification.files))), /Invalid|mismatched/i); assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved);
}));

verificationTest('verification media binding is immutable and import commits require exact tuple plus one target origin', () => transaction(async () => {
  await verifiedActivity(); await vraw(); await vmediaBind(); assert.equal((await vmediaBind()).repeated, true);
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
]) verificationTest(`verification immutable raw staging rejects ${label}`, () => transaction(async () => {
  await verifiedActivity(); await vbind(); await assert.rejects(vchunk(0, text()), /Invalid|row limit/i); assert.equal(await permits(), 0);
}));

verificationTest('verification staging preserves raw chunks, rejects changed retries and detects same-length raw corruption', () => transaction(async () => {
  await verifiedActivity(); await vbind(); const first = chunks(verification.texts.verification_requests)[0];
  assert.equal((await vchunk(0, first)).rows, 200); assert.equal((await vchunk(0, first)).repeated, true);
  await assert.rejects(vchunk(0, first.replace('合成姓名', '不同姓名')), /content changed/i);
  await vchunk(1, chunks(verification.texts.verification_requests)[1].replace('123456', '123457'));
  await assert.rejects(vplan(), /staged catalog verification failed/i);
}));

for (const [label, sql] of [
  ['unknown verification trigger', 'CREATE TRIGGER aa_verification_unknown BEFORE INSERT ON public.verification_requests FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['disabled maintenance guard', 'ALTER TABLE public.verification_requests DISABLE TRIGGER zz_employee_transfer_maintenance'],
  ['replica maintenance guard', 'ALTER TABLE public.verification_requests ENABLE REPLICA TRIGGER zz_employee_transfer_maintenance'],
]) verificationTest(`verification refuses ${label} before writing and never normalizes its trigger state`, () => transaction(async () => {
  const p = await vstage(); await db.exec(sql); const before = await business(), original = await triggers();
  await assert.rejects(vapply(p), /Unreviewed|guard|trigger/i); assert.deepEqual(await business(), before); assert.deepEqual(await triggers(), original); assert.equal(await permits(), 0);
}));

for (const [label, relation, sql] of [
  ['identity', 'public.users', "UPDATE public.users SET remarks='actual identity drift' WHERE id=$1"],
  ['finance', 'public.wallets', "UPDATE public.wallets SET updated_at='2001-01-01' WHERE user_id=$1"],
  ['activity', 'public.employee_login_history', "UPDATE public.employee_login_history SET user_agent='actual activity drift' WHERE id=$1"],
]) verificationTest(`verification continuation rechecks actual ${label} rather than its previous verified flag`, () => transaction(async () => {
  const p = await vstage(); await localChange(db, relation, sql, [label === 'activity' ? F.login : F.history]); const before = await business();
  for (const action of [() => vplan(), () => vapply(p), () => vverify()]) await assert.rejects(action(), /changed|verification|content/i);
  assert.deepEqual(await business(), before); assert.equal(await permits(), 0);
}));

verificationTest('verification late per-employee event failure rolls back 203 inserted requests, receipt and progress, retaining earlier employee result', () => transaction(async () => {
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
  verificationTest(`verification browser and service-role protocols reject ${label} identity even with the right job`, () => transaction(async () => {
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
]) verificationTest(`verification ${label} blocks all continuation including service commits and keeps dirty maintenance`, () => transaction(async () => {
  const p = await vstage(); await vapply(p, F.noHeartbeat); await db.query(sql, args()); const before = await business();
  for (const action of [() => vbind(), () => vplan(), () => vapply(p), () => vverify(), () => mediaAuthorize(db, task, session, 'upload', verification.files[0].key),
    () => mediaCommit(db, task, session, 'recheck-import', verification.files[0])]) await assert.rejects(action(), /invalid or expired|running dispatch owner/i);
  assert.deepEqual(await business(), before); assert.equal(await permits(), 0); assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
}));

verificationTest('verification plan hash and package membership cannot be forged or bypassed through legacy finish', () => transaction(async () => {
  const p = await vstage(), before = await business(), saved = await state();
  await assert.rejects(vapply({ plan_hash: hash('forged verification plan') }), /matching conflict-free verification plan/i);
  await assert.rejects(vapply(p, F.outsider), /outside this package/i);
  for (const name of ['employee_import_finish', 'employee_import_finalize_employee']) await assert.rejects(rpc(name,
    { ...auth(), ...(name.endsWith('finish') ? { p_summary: {} } : { p_employee_id: F.history, p_expected: {} }) }), /protocol/i);
  assert.deepEqual(await business(), before); assert.deepEqual(await state(), saved); await stillClosed();
}));

verificationTest('verification cancellation after a partial employee result blocks browser/service continuation but retains committed history and disabled accounts', () => transaction(async () => {
  const p = await vstage(); await vapply(p, F.noHeartbeat); const before = await business();
  await rpc('employee_transfer_cancel', auth());
  for (const action of [() => vbind(), () => vplan(), () => vapply(p), () => vverify(),
    () => mediaAuthorize(db, task, session, 'upload', verification.files[0].key), () => mediaCommit(db, task, session, 'recheck-import', verification.files[0])])
    await assert.rejects(action(), /invalid or expired/i);
  assert.deepEqual(await business(), before); assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.verification_requests WHERE user_id=$1', [F.noHeartbeat]), 2);
  await stillClosed();
}));

verificationTest('verification source expiration/cancellation and unsupported objects/actions cannot manufacture a verified export', () => transaction(async () => {
  const exp = await vexportBegin(), file = verification.files[0];
  await assert.rejects(mediaAuthorize(source, exp, sourceSession, 'download', hash('outside task')), /outside this task/i);
  await assert.rejects(mediaAuthorize(source, exp, sourceSession, 'delete', file.key), /Unsupported/i);
  await source.query("UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", [exp.job_id]);
  for (const action of [() => mediaInventory(source, exp, sourceSession, 'export'), () => mediaAuthorize(source, exp, sourceSession, 'download', file.key),
    () => mediaCommit(source, exp, sourceSession, 'download', file), () => on(source, 'employee_export_verification_verify', auth(exp, sourceSession))]) await assert.rejects(action(), /invalid or expired/i);
  await on(source, 'employee_transfer_cancel', auth(exp, sourceSession)); const cancelled = await vexportBegin(); await on(source, 'employee_transfer_cancel', auth(cancelled, sourceSession));
  await assert.rejects(on(source, 'employee_export_verification_verify', auth(cancelled, sourceSession)), /invalid or expired/i);
}, source));

verificationTest('verification helpers and private media receipts/maps remain inaccessible to browser and service roles', () => transaction(async () => {
  const functions = await rows(db, "SELECT oid,proname FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%verification%'"); assert.ok(functions.length > 0);
  for (const fn of functions) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2::oid,'EXECUTE')", [role, fn.oid]), false, fn.proname);
  for (const role of ['anon', 'authenticated', 'service_role']) for (const relation of ['private.employee_transfer_staging', 'private.employee_transfer_jobs']) {
    assert.equal(await scalar(db, "SELECT has_table_privilege($1,$2,'UPDATE')", [role, relation]), false);
    assert.equal(await scalar(db, "SELECT has_table_privilege($1,$2,'INSERT')", [role, relation]), false);
  }
}));

verificationTest('verification real committed transactions survive a new PGlite connection, late failure and cancellation without falsely undoing earlier employees', async () => {
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

// Notification configuration/backup tests reuse the genuine sealed dispatch -> dirty maintenance ->
// identity/dependency/finance chain above. No private verified/map/permit is fabricated.
const ncplan = (extra = {}) => rpc('get_employee_import_notification_configuration_plan', { ...auth(), ...extra });
const nbprepare = (p, extra = {}) => rpc('employee_import_notification_backup_prepare', { ...auth(), p_plan_hash: p.plan_hash, ...extra });
const nbpage = (b, key, after = null, extra = {}) => rpc('get_employee_import_notification_backup_page',
  { ...auth(), p_backup_id: b.backup_id, p_table_key: key, p_after: after, ...extra });
const nbverify = (b, extra = {}) => rpc('employee_import_notification_backup_verify', { ...auth(), p_backup_id: b.backup_id, ...extra });
const nbappend = (b, no, bytes, extra = {}) => rpc('employee_import_notification_backup_append',
  { ...auth(), p_backup_id: b.backup_id, p_chunk_no: no, p_hex: Buffer.from(bytes).toString('hex'), ...extra });
const nbseal = (b, bytes, extra = {}) => rpc('employee_import_notification_backup_seal',
  { ...auth(), p_backup_id: b.backup_id, p_sha256: hash(bytes), p_bytes: bytes.length, ...extra });
const nbget = (b, no = 0, token = session) => rpc('get_employee_notification_saved_backup_chunk',
  { p_admin_session_token: token, p_backup_id: b.backup_id, p_chunk_no: no });
const C = { plan: id(16001), rootPlan: id(16002), task: id(16101), retire: id(16199), outside: id(16999), template: id(17301) };
const ncflags = p => {
  assert.equal(p.scope, 'notification-configuration');
  for (const key of ['checked', 'backup_required', 'media_pending', 'automation_pending', 'maintenance']) assert.equal(p[key], true, key);
  for (const key of ['can_apply_configuration', 'replacement_ready', 'full_site_complete']) assert.equal(p[key], false, key);
  assert.equal(p.can_prepare_backup, !p.conflicts.length); assert.match(p.plan_hash, /^[0-9a-f]{64}$/); assert.match(p.target_hash, /^[0-9a-f]{64}$/);
  for (const r of p.records) assert.deepEqual(Object.keys(r).sort(), ['action', 'source_id', 'table_key', 'target_id']);
};
const ncRecord = (p, sourceId) => p.records.find(r => r.source_id === sourceId);
async function targetPlan(targetId, name, owner = NEW.root) {
  await localChange(db, 'public.notification_automation_plans',
    "INSERT INTO public.notification_automation_plans(id,owner_admin_id,name,status) VALUES($1,$2,$3,'paused')", [targetId, owner, name]);
}
async function targetTask(targetId, name, planId = C.plan, shared = false, owner) {
  owner ??= (await state()).identity_restore.admin_map[OLD.branch];
  await localChange(db, 'public.notification_automation_tasks', `INSERT INTO public.notification_automation_tasks(id,owner_admin_id,name,plan_id,
    is_shared_template,trigger_type,trigger_mode,threshold_value,title_template,content_template,status,recipient_scope)
    VALUES($1,$2,$3,$4,$5,'total_orders','reach_once',1,'target title','target content','draft','selected')`, [targetId, owner, name, planId, shared]);
}
async function targetMember(employee, planId = C.plan) {
  await localChange(db, 'public.notification_automation_plan_members', 'INSERT INTO public.notification_automation_plan_members(plan_id,user_id) VALUES($1,$2)', [planId, employee]);
}
async function namedTarget() {
  const map = (await state()).identity_restore.admin_map;
  await targetPlan(C.plan, '來源方案 ALPHA', map[OLD.branch]); await targetPlan(C.rootPlan, '沒有員工也必須導出');
  await targetTask(C.task, '循環基線'); await targetTask(C.retire, '僅目標多餘任務');
  await targetPlan(C.outside, '范围外不同名', map[OLD.branch]); await targetTask(id(16998), '范围外任务', C.outside);
  await targetMember(F.history); await targetMember(F.empty);
  await localChange(db, 'public.message_templates', `INSERT INTO public.message_templates(id,admin_id,name,title,content,message_type,priority)
    VALUES($1,$2,'無收件人的範本','target','target','realtime','normal')`, [C.template, NEW.root]);
}
// Populate all physical target notification rows with distinct IDs/names. The 13-table snapshot
// remains outside the source matching scope, including actual leases and unsanitized diagnostics.
async function allTargetNotifications() {
  const map = { ...(await state()).identity_restore.admin_map };
  const data = {};
  for (const key of KEYS.notifications) {
    data[key] = await rows(source, `SELECT to_jsonb(r)::text AS body FROM public.${key} AS r`);
    for (const { body } of data[key]) {
      const row = JSON.parse(body); if (row.id) map[row.id] ??= id(50000 + Object.keys(map).length);
    }
  }
  const insertKeys = ['messages', ...KEYS.notifications.filter(key => key !== 'messages')];
  for (const key of insertKeys) {
    const selected = key === 'notification_automation_plan_members' ? data[key].filter(r => JSON.parse(r.body).user_id === F.history) : data[key];
    const raw = selected.map(({ body }) => {
      if (key === 'notification_automation_plan_members') body = body.replace(F.history, F.empty);
      for (const [from, to] of Object.entries(map)) body = body.replaceAll(from, to);
      if (['notification_automation_plans', 'notification_automation_tasks', 'message_templates'].includes(key))
        body = body.replace(/"name": "([^"\\]*(?:\\.[^"\\]*)*)"/, '"name": "target-only $1"');
      return body;
    }).join(',');
    await localChange(db, `public.${key}`, `INSERT INTO public.${key} SELECT * FROM jsonb_populate_recordset(NULL::public.${key},$1::jsonb)`, [`[${raw}]`]);
  }
  return map;
}
const fakeCipher = () => Buffer.concat([Buffer.from('EDXSTRM1'), Buffer.alloc(88, 37)]);
const backups = () => rows(db, 'SELECT * FROM private.employee_transfer_notification_backups ORDER BY id');
async function nbready() { await nstage(); return nbprepare(await ncplan()); }

test('notification configuration exact public signatures, SD grants and private RLS permissions are isolated', () => transaction(async () => {
  for (const [name, args] of [
    ['get_employee_import_notification_configuration_plan', ['p_admin_session_token', 'p_job_token']],
    ['employee_import_notification_backup_prepare', ['p_admin_session_token', 'p_job_token', 'p_plan_hash']],
    ['get_employee_import_notification_backup_page', ['p_admin_session_token', 'p_job_token', 'p_backup_id', 'p_table_key', 'p_after', 'p_limit']],
    ['employee_import_notification_backup_verify', ['p_admin_session_token', 'p_job_token', 'p_backup_id']],
    ['employee_import_notification_backup_append', ['p_admin_session_token', 'p_job_token', 'p_backup_id', 'p_chunk_no', 'p_hex']],
    ['employee_import_notification_backup_seal', ['p_admin_session_token', 'p_job_token', 'p_backup_id', 'p_sha256', 'p_bytes']],
    ['get_employee_notification_saved_backup_chunk', ['p_admin_session_token', 'p_backup_id', 'p_chunk_no']],
  ]) {
    const [fn] = await rows(db, "SELECT oid,proargnames,prosecdef,proconfig,provolatile FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=$1", [name]);
    assert.deepEqual(fn.proargnames, args); assert.equal(fn.prosecdef, true); assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    assert.equal(await scalar(db, "SELECT EXISTS(SELECT 1 FROM pg_proc,aclexplode(proacl) WHERE oid=$1 AND grantee=0 AND privilege_type='EXECUTE')", [fn.oid]), false);
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2::oid,\'EXECUTE\')', [role, fn.oid]), role !== 'service_role');
    if (name.endsWith('_plan')) assert.equal(fn.provolatile, 's');
  }
  assert.equal(await scalar(db, "SELECT relrowsecurity FROM pg_class WHERE oid='private.employee_transfer_notification_backups'::regclass"), true);
  const fns = await rows(db, "SELECT oid FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_notification\\_%' ESCAPE '\\'");
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const fn of fns) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2::oid,'EXECUTE')", [role, fn.oid]), false);
    for (const op of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal(await scalar(db, 'SELECT has_table_privilege($1,$2,$3)', [role, 'private.employee_transfer_notification_backups', op]), false);
  }
  const cols = await rows(db, "SELECT attname,attnotnull FROM pg_attribute WHERE attrelid='private.employee_transfer_notification_backups'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum");
  assert.deepEqual(cols.filter(c => !c.attnotnull).map(c => c.attname), ['sealed_sha256', 'sealed_at']);
}));

test('notification configuration empty target preserves all source UUIDs and remains backup-only', () => transaction(async () => {
  await nstage(); const before = await transferSnapshot(), original = await business(), p = await ncplan(); ncflags(p);
  assert.deepEqual(p.conflicts, []); assert.equal(p.records.length, 7); assert.equal(p.members_removed, 0); assert.deepEqual(p.retire_tasks, []);
  for (const r of p.records) { assert.equal(r.action, 'create'); assert.equal(r.source_id, r.target_id); }
  assert.deepEqual(await ncplan(), p); assert.deepEqual(await transferSnapshot(), before); assert.deepEqual(await business(), original); await stillClosed();
}));

test('notification configuration same-name maps only server-owned administrator and parent scope', () => transaction(async () => {
  await nstage(); await namedTarget(); const before = await business(), p = await ncplan(); ncflags(p); assert.deepEqual(p.conflicts, []);
  for (const [from, to] of [[N.plan, C.plan], [N.rootPlan, C.rootPlan], [N.recurring, C.task], [N.template, C.template]])
    assert.deepEqual(ncRecord(p, from), { table_key: from === N.template ? 'message_templates' : from === N.recurring ? 'notification_automation_tasks' : 'notification_automation_plans', source_id: from, target_id: to, action: 'replace' });
  assert.equal(ncRecord(p, N.annual).action, 'create'); assert.deepEqual(await business(), before); await stillClosed();
}));

test('notification configuration task matching is exact-name, null-safe, parent-scoped and shared-template aware', () => transaction(async () => {
  await nstage(); const owner = (await state()).identity_restore.admin_map[OLD.branch];
  await targetPlan(C.plan, '來源方案 Alpha', owner); await targetTask(C.task, '循環基線', C.plan, true);
  await targetTask(id(16102), '循環基線x'); await targetTask(id(16103), '循環基線', null);
  await targetTask(id(16104), '無成員舊範本', null, true, NEW.root);
  const p = await ncplan(); assert.equal(ncRecord(p, N.recurring).action, 'create');
  assert.equal(ncRecord(p, N.hidden).target_id, id(16104)); assert.equal(ncRecord(p, N.hidden).action, 'replace'); assert.deepEqual(p.conflicts, []);
}));

test('notification configuration retires only target-only tasks in matched plans and previews exact members, never unions', () => transaction(async () => {
  await nstage(); await namedTarget(); const p = await ncplan();
  assert.deepEqual(p.retire_tasks, [C.retire]); assert.equal(p.members_removed, 1);
  assert.ok(await scalar(db, 'SELECT EXISTS(SELECT 1 FROM public.notification_automation_tasks WHERE id=$1)', [C.retire]));
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_plan_members'), 2);
}));

test('notification configuration source empty member list previews removal of every old target member', () => transaction(async () => {
  await nstage(changedNotifications({ notification_automation_plan_members: () => '' })); await namedTarget();
  const p = await ncplan(); assert.equal(p.members_removed, 2); assert.deepEqual(p.conflicts, []); assert.equal(p.can_apply_configuration, false);
}));

test('notification configuration permits source membership moves between matched plans without changing either target yet', () => transaction(async () => {
  const secondSource = id(18300), secondTarget = id(18301);
  const input = changedNotifications({ notification_automation_plans: text => {
    const row = JSON.parse(lines(text).find(line => JSON.parse(line).id === N.plan));
    return text + JSON.stringify({ ...row, id: secondSource, name: '來源第二方案' }) + '\n';
  } });
  await nstage(input); const owner = (await state()).identity_restore.admin_map[OLD.branch];
  await targetPlan(C.plan, '來源方案 Alpha', owner); await targetPlan(secondTarget, '來源第二方案', owner); await targetMember(F.history, secondTarget);
  const before = await business(), p = await ncplan();
  assert.deepEqual(p.conflicts, []); assert.equal(p.members_removed, 1); assert.equal(p.can_prepare_backup, true);
  assert.equal(p.can_apply_configuration, false); assert.deepEqual(await business(), before); await stillClosed();
}));

test('notification configuration refuses employees assigned to a different target plan instead of silently detaching', () => transaction(async () => {
  await nstage(); await targetPlan(C.outside, '范围外方案', (await state()).identity_restore.admin_map[OLD.branch]); await targetMember(F.history, C.outside);
  const p = await ncplan(), before = await business(); assert.ok(p.conflicts.includes('target_member_outside_plan')); await assert.rejects(nbprepare(p), /conflict-free/); assert.deepEqual(await business(), before);
}));

for (const [label, key, row] of [
  ['case-folded source plans', 'notification_automation_plans', { id: id(18001), owner_admin_id: OLD.branch, name: '來源方案 ALPHA' }],
  ['source tasks', 'notification_automation_tasks', { id: id(18002), name: '循環基線' }],
]) test(`notification configuration rejects duplicate mapped ${label}`, () => transaction(async () => {
  const input = changedNotifications({ [key]: text => {
    const original = JSON.parse(lines(text)[0]); return text + JSON.stringify({ ...original, ...row }) + '\n';
  } });
  await nstage(input); await namedTarget(); const p = await ncplan(); assert.ok(p.conflicts.includes('source_configuration_collision'));
  assert.ok(p.conflicts.includes('notification_many_to_one'));
  assert.ok(p.records.filter(r => r.table_key === key && r.action === 'conflict').length >= 2); await assert.rejects(nbprepare(p), /conflict-free/);
}));

for (const kind of ['plan', 'task', 'template']) test(`notification configuration explicitly blocks ambiguous target ${kind} candidates`, () => transaction(async () => {
  await nstage(); const owner = (await state()).identity_restore.admin_map[OLD.branch];
  if (kind === 'plan') {
    await db.exec('DROP INDEX public.notification_automation_plans_owner_name_idx');
    await targetPlan(C.plan, '來源方案 Alpha', owner); await targetPlan(id(18003), '來源方案 ALPHA', owner);
  } else if (kind === 'task') {
    await targetPlan(C.plan, '來源方案 Alpha', owner); await targetTask(C.task, '循環基線'); await targetTask(id(18004), '循環基線');
  } else {
    await localChange(db, 'public.message_templates', `INSERT INTO public.message_templates(id,admin_id,name,title,content,message_type,priority)
      VALUES($1,$3,'無收件人的範本','t','c','realtime','normal'),($2,$3,'無收件人的範本','t','c','realtime','normal')`, [C.template, id(18005), NEW.root]);
  }
  const p = await ncplan(); assert.ok(p.conflicts.includes('ambiguous_notification_configuration'));
  await assert.rejects(nbprepare(p), /conflict-free/);
}));

for (const kind of ['plan', 'task', 'template']) test(`notification configuration refuses a source ${kind} UUID occupied by a different object`, () => transaction(async () => {
  await nstage();
  if (kind === 'plan') await targetPlan(N.plan, 'other name');
  else if (kind === 'task') await targetTask(N.recurring, 'other name', null);
  else await localChange(db, 'public.message_templates', `INSERT INTO public.message_templates(id,admin_id,name,title,content,message_type,priority)
    VALUES($1,$2,'other name','t','c','realtime','normal')`, [N.template, NEW.root]);
  const p = await ncplan(); assert.ok(p.conflicts.includes('notification_configuration_id_collision'));
  assert.equal(ncRecord(p, kind === 'plan' ? N.plan : kind === 'task' ? N.recurring : N.template).action, 'conflict');
}));

for (const key of ['messages', 'message_recipients', 'broadcast_messages', 'broadcast_recipients'])
  test(`notification configuration blocks source ${key} UUID collisions without removing existing history`, () => transaction(async () => {
    await nstage(); const mapping = await allTargetNotifications();
    const sourceId = JSON.parse(lines(notifications.texts[key])[0]).id, targetId = mapping[sourceId];
    await localChange(db, `public.${key}`, ['messages', 'broadcast_messages'].includes(key)
      ? `INSERT INTO public.${key} SELECT (jsonb_populate_record(NULL::public.${key},to_jsonb(r)||jsonb_build_object('id',$2::text))).* FROM public.${key} AS r WHERE id=$1`
      : `UPDATE public.${key} SET id=$2 WHERE id=$1`, [targetId, sourceId]);
    const before = await business(), p = await ncplan(); assert.ok(p.conflicts.includes('target_notification_uuid_collision'));
    await assert.rejects(nbprepare(p), /conflict-free/); assert.deepEqual(await business(), before);
  }));

for (const history of ['execution', 'progress', 'failure', 'date_runs', 'message', 'queue'])
  test(`notification configuration target_notification_history blocks actual ${history} in replaced or retired scope`, () => transaction(async () => {
    await nstage(); await namedTarget();
    if (history === 'execution') await localChange(db, 'public.notification_automation_executions', `INSERT INTO public.notification_automation_executions(
      id,task_id,plan_id,task_version,owner_admin_id,user_id,employee_username,period_key,stage,actual_value,trigger_snapshot,title_snapshot,content_snapshot,status)
      VALUES($1,$2,$3,7,$4,$5,'synthetic','all_time',$6,20,'{"trigger_type":"total_orders","trigger_mode":"recurring","threshold_value":10,"minimum_daily_orders":null,"minimum_daily_work_minutes":null}','t','c','failed')`,
      [id(18201), C.task, C.plan, (await state()).identity_restore.admin_map[OLD.branch], F.history, BIG_STAGE]);
    if (history === 'progress') await localChange(db, 'public.notification_automation_progress', 'INSERT INTO public.notification_automation_progress(task_id,user_id) VALUES($1,$2)', [C.retire, F.history]);
    if (history === 'failure') await localChange(db, 'public.notification_automation_failures', "INSERT INTO public.notification_automation_failures(task_id,user_id,owner_admin_id,last_error) VALUES($1,$2,$3,'raw synthetic')", [C.retire, F.history, NEW.root]);
    if (history === 'date_runs') await localChange(db, 'public.notification_automation_date_runs', "INSERT INTO public.notification_automation_date_runs(task_id,task_version,period_key) VALUES($1,1,'year-2024')", [C.retire]);
    if (history === 'message') {
      await localChange(db, 'public.messages', "INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority) VALUES($1,$2,'root','t','c','realtime','normal')", [id(18202), NEW.root]);
      await localChange(db, 'public.message_recipients', 'INSERT INTO public.message_recipients(message_id,recipient_id) VALUES($1,$2)', [id(18202), F.history]);
    }
    if (history === 'queue') await localChange(db, 'public.notification_automation_queue', 'INSERT INTO public.notification_automation_queue(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET attempts=99', [F.history]);
    const before = await business(), original = await triggers(), p = await ncplan();
    assert.ok(p.conflicts.includes('target_notification_history'), JSON.stringify(p.conflicts));
    if (history === 'execution') assert.ok(p.conflicts.includes('target_execution_unique_collision'));
    await assert.rejects(nbprepare(p), /conflict-free/); assert.deepEqual(await business(), before); assert.deepEqual(await triggers(), original); await stillClosed();
  }));

test('notification backup freezes all 13 projected tables with raw precision, hashes and bounded canonical paging', () => transaction(async () => {
  await nstage(); await allTargetNotifications(); const before = await business(), original = await triggers(), p = await ncplan(); assert.deepEqual(p.conflicts, []);
  const b = await nbprepare(p); assert.deepEqual(modules.validateNotificationsBackupDescriptor(b), b);
  assert.equal(b.catalog.package_id, packageId); assert.notEqual(b.backup_id, task.job_id); assert.equal(b.catalog.media_included, false);
  for (const table of b.catalog.tables) {
    let after = null, text = '', pages = [];
    do {
      const page = await nbpage(b, table.key, after); modules.validateNotificationsPage(page, table.key, after);
      pages.push(page.count); text += page.ndjson; after = page.next_after;
    } while (after !== null);
    assert.equal(table.rows, await scalar(db, `SELECT count(*)::int FROM public.${table.key}`));
    const query = await scalar(db, 'SELECT private.employee_transfer_notifications_query($1)', [table.key]);
    const expected = (await rows(db, `SELECT body::text||E'\\n' AS line FROM (${query}) AS s ORDER BY id COLLATE "C"`)).map(r => r.line).join('');
    assert.equal(text, expected); assert.equal(table.bytes, Buffer.byteLength(text)); assert.equal(table.row_hashes_sha256, hash(lines(text).map(hash).join('')));
    if (['messages', 'message_recipients', 'notification_automation_date_runs'].includes(table.key)) assert.deepEqual(pages, [200, table.key.endsWith('date_runs') ? 3 : 5]);
    if (table.key === 'notification_automation_progress') assert.ok(text.includes(PRECISE));
    if (table.key === 'message_templates') assert.ok(text.includes(UNKNOWN_MEDIA));
    assert.doesNotMatch(text, /delivery_claim_token|delivery_completed_claim_token|synthetic diagnostic/);
  }
  assert.deepEqual(await nbverify(b), { verified: true, backup_id: b.backup_id, plan_hash: b.plan_hash, target_hash: b.target_hash, media_included: false, full_site_complete: false });
  const savedPage = await nbpage(b, 'message_templates');
  await localChange(db, 'public.message_templates', "UPDATE public.message_templates SET title='live drift'");
  assert.deepEqual(await nbpage(b, 'message_templates'), savedPage); await assert.rejects(nbverify(b), /changed/);
  // All fixture changes and deliberate drift are local; backup itself did not write business.
  await localChange(db, 'public.message_templates', "UPDATE public.message_templates SET title='原標題'");
  assert.deepEqual(await business(), before); assert.deepEqual(await triggers(), original); await stillClosed();
}));

test('notification backup uses real independent encrypted file readback, append/seal, then survives task cancellation', () => transaction(async () => {
  await nstage(); await allTargetNotifications(); transport();
  const client = modules.createNotificationConfigurationSession(task.job_token, notifications.catalog);
  const configuration = await client.plan(); const bundle = await client.backup(configuration.plan_hash), b = bundle.descriptor;
  const before = await business(), original = await triggers();
  const shared = await rows(db, 'SELECT * FROM private.employee_transfer_shared_backups WHERE id=$1', [task.job_id]);
  const dir = await mkdtemp(join(tmpdir(), 'notification-db-independent-')), path = join(dir, 'notifications.edx'); let opens = 0;
  const plain = new Map();
  try {
    const saved = await modules.createNotificationsBackup(b, bundle.source, {
      async append(name, bytes) { plain.set(name, [...(plain.get(name) ?? []), Buffer.from(bytes)]); },
      open(name) { return (async function* () { yield* plain.get(name) ?? []; })(); }, async abort() { plain.clear(); },
    }, {
      async write(stream) { const f = await open(path, 'wx'); try { for await (const bytes of stream) await f.writeFile(bytes); await f.sync(); } finally { await f.close(); } },
      open() { opens++; return disk(path); },
    }, { append(no, hex) { assert.equal(opens, 2); return bundle.receiver.append(no, hex); }, seal: (sha, bytes) => bundle.receiver.seal(sha, bytes) },
    'local-notification-independent-backup-passphrase');
    assert.equal(opens, 2); assert.equal(plain.size, 0); assert.equal(saved.sealReceipt.media_pending, true);
    const file = []; for await (const part of disk(path)) file.push(Buffer.from(part)); const cipher = Buffer.concat(file);
    assert.equal(hash(cipher), saved.cipherSha256); assert.deepEqual(await nbseal(b, cipher), { ...saved.sealReceipt, repeated: true });
    const sealed = await backups(); assert.deepEqual(await nbprepare(await ncplan()), b); assert.deepEqual(await backups(), sealed);
    const events = await rows(db, "SELECT details FROM private.employee_transfer_events WHERE job_id=$1 AND action LIKE 'notification_backup_%'", [task.job_id]);
    assert.equal(events.length, 2); for (const event of events) assert.doesNotMatch(JSON.stringify(event.details), /ndjson|content|diagnostic|unmanaged/);
    await assert.rejects(nbappend(b, 0, cipher.subarray(0, 10)), /does not accept/);
    await rpc('employee_transfer_cancel', auth());
    assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key LIKE 'notifications-backup:%'", [task.job_id]), 0);
    const pieces = []; for (let no = 0; no < saved.chunks; no++) { const r = await nbget(b, no); assert.equal(r.sha256, saved.cipherSha256); assert.equal(r.bytes, cipher.length); pieces.push(Buffer.from(r.hex, 'hex')); }
    assert.deepEqual(Buffer.concat(pieces), cipher);
    const fresh = await adminLogin(db, 'root', PASSWORDS.root); assert.equal((await nbget(b, 0, fresh)).backup_id, b.backup_id);
    for (const token of [other, branch, emergency]) await assert.rejects(nbget(b, 0, token), /unavailable|Super administrator|invalid or expired/i);
    await assert.rejects(nbget(b, -1), /unavailable/); await assert.rejects(nbget(b, saved.chunks), /unavailable/);
    await assert.rejects(nbverify(b), /invalid or expired/); assert.deepEqual(await business(), before); assert.deepEqual(await triggers(), original);
    assert.deepEqual(await rows(db, 'SELECT * FROM private.employee_transfer_shared_backups WHERE id=$1', [task.job_id]), shared); await stillClosed();
  } finally { await rm(dir, { recursive: true, force: true }); }
}));

test('notification configuration and backup verification execute inside a genuine READ ONLY transaction without heartbeat writes', async () => {
  const original = db; let clone;
  try {
    clone = new PGlite({ loadDataDir: await db.dumpDataDir('none'), extensions: { pgcrypto, pg_trgm, uuid_ossp } }); await clone.waitReady; db = clone;
    let b, p; await transaction(async () => { await nstage(); p = await ncplan(); b = await nbprepare(p); }, db, true);
    const before = await transferSnapshot();
    await db.exec('BEGIN; SET TRANSACTION READ ONLY');
    try { assert.deepEqual(await ncplan(), p); assert.equal((await nbverify(b)).verified, true); await nbpage(b, 'messages'); await db.exec('COMMIT'); }
    catch (error) { await db.exec('ROLLBACK'); throw error; }
    assert.deepEqual(await transferSnapshot(), before);
  } finally { await clone?.close(); db = original; }
});

test('notification backup prepare is immutable and idempotent, refuses wrong plan and same-count target drift', () => transaction(async () => {
  const b = await nbready(), p = await ncplan(); assert.deepEqual(await nbprepare(p), b);
  const bytes = fakeCipher(); await nbappend(b, 0, bytes); const saved = await backups();
  await assert.rejects(nbprepare({ plan_hash: hash('wrong plan') }), /matching conflict-free/); assert.deepEqual(await backups(), saved);
  await targetPlan(C.outside, 'new drift'); const next = await ncplan();
  await assert.rejects(nbprepare(p), /matching conflict-free/); await assert.rejects(nbprepare(next), /changed after/); assert.deepEqual(await backups(), saved);
}));

for (const [key, sql] of [
  ['message_templates', "UPDATE public.message_templates SET content='<p>same count drift</p>'"],
  ['message_recipients', "UPDATE public.message_recipients SET delivery_claim_until='2098-01-01' WHERE delivery_claim_until IS NOT NULL"],
  ['notification_automation_executions', "UPDATE public.notification_automation_executions SET error_message='different raw diagnostic' WHERE error_message IS NOT NULL"],
  ['notification_automation_failures', "UPDATE public.notification_automation_failures SET last_error='different raw diagnostic'"],
]) test(`notification backup target fingerprint catches actual ${key} drift even when export projection is unchanged`, () => transaction(async () => {
  await nstage(); await allTargetNotifications(); const p = await ncplan(), b = await nbprepare(p), bytes = fakeCipher(); await nbappend(b, 0, bytes);
  const projected = await scalar(db, 'SELECT private.employee_transfer_notifications_query($1)', [key]);
  const exportedBefore = await rows(db, `SELECT body::text FROM (${projected}) AS s ORDER BY id COLLATE "C"`);
  await localChange(db, `public.${key}`, sql); const next = await ncplan(); assert.notEqual(next.target_hash, p.target_hash); assert.notEqual(next.plan_hash, p.plan_hash);
  if (key !== 'message_templates') assert.deepEqual(await rows(db, `SELECT body::text FROM (${projected}) AS s ORDER BY id COLLATE "C"`), exportedBefore);
  const before = await backups(); for (const action of [() => nbverify(b), () => nbseal(b, bytes), () => nbprepare(next)]) await assert.rejects(action(), /changed/);
  assert.deepEqual(await backups(), before); await stillClosed();
}));

test('notification backup paging rejects invalid table, size, UUID and nonexistent or noncanonical cursor', () => transaction(async () => {
  const b = await nbready();
  for (const extra of [{ p_table_key: 'notification_automation_queue' }, { p_limit: 0 }, { p_limit: 201 }, { p_limit: null }, { p_after: 'not-a-cursor' }, { p_backup_id: randomUUID() }])
    await assert.rejects(nbpage(b, 'messages', null, extra), /Invalid|unavailable|cursor/);
  const page = await nbpage(b, 'messages'); assert.equal(page.count, 0); assert.equal(page.ndjson, ''); assert.equal(page.sha256, hash(''));
  await assert.rejects(nbget(b), /unavailable/);
}));

test('notification backup full frozen snapshot is rehashed, not trusted from staging metadata or live table counts', () => transaction(async () => {
  await nstage(); await allTargetNotifications(); const b = await nbprepare(await ncplan()), bytes = fakeCipher(); await nbappend(b, 0, bytes);
  await db.query(`UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{ndjson}',to_jsonb(replace(payload->>'ndjson','target-only','target-drift')))
    WHERE job_id=$1 AND table_key='notifications-backup:message_templates'`, [task.job_id]);
  const before = await backups(); await assert.rejects(nbverify(b), /snapshot verification failed/); await assert.rejects(nbseal(b, bytes), /snapshot verification failed/);
  assert.deepEqual(await backups(), before);
}));

test('notification backup append enforces strict hex, contiguous full chunks, repeat identity and sealed immutability', () => transaction(async () => {
  const b = await nbready();
  for (const p_hex of ['', '0', 'zz', 'AA', '00'.repeat(131073)]) await assert.rejects(nbappend(b, 0, [], { p_hex }), /Invalid encrypted/);
  await assert.rejects(nbappend(b, 1, [0]), /contiguous/);
  const full = Buffer.alloc(131072, 13); Buffer.from('EDXSTRM1').copy(full); const r = await nbappend(b, 0, full);
  assert.deepEqual(r, { success: true, bytes: full.length, sha256: hash(full), repeated: false }); assert.deepEqual(await nbappend(b, 0, full), { ...r, repeated: true });
  await assert.rejects(nbappend(b, 0, [1]), /different contents/); await nbappend(b, 1, [99]); await assert.rejects(nbappend(b, 2, [1]), /last.*short/);
  const bytes = Buffer.concat([full, Buffer.from([99])]); await nbseal(b, bytes); await assert.rejects(nbappend(b, 1, [99]), /does not accept/);
  const sealed = await backups(); await assert.rejects(nbseal(b, bytes, { p_sha256: hash('forged') }), /match its seal/);
  await assert.rejects(nbseal(b, bytes, { p_bytes: bytes.length - 1 }), /match its seal/); assert.deepEqual(await backups(), sealed);
}));

test('notification backup ciphertext limit is exactly 9 MiB and an over-limit append leaves existing chunks intact', () => transaction(async () => {
  const b = await nbready(), full = Buffer.alloc(131072, 7);
  for (let no = 0; no < 72; no++) await nbappend(b, no, full);
  const before = await scalar(db, 'SELECT byte_count FROM private.employee_transfer_notification_backups WHERE id=$1', [b.backup_id]); assert.equal(before, 9437184);
  await assert.rejects(nbappend(b, 72, [7]), /exceeds the limit/);
  assert.equal(await scalar(db, 'SELECT byte_count FROM private.employee_transfer_notification_backups WHERE id=$1', [b.backup_id]), before);
}));

test('notification backup seal rejects absent cipher, wrong magic, bytes and hash rather than accepting a client assertion', () => transaction(async () => {
  const b = await nbready(), bytes = Buffer.alloc(96, 22);
  await assert.rejects(nbseal(b, bytes), /match its seal/); await nbappend(b, 0, bytes);
  for (const extra of [{}, { p_bytes: 95 }, { p_sha256: hash('client says verified') }, { p_sha256: null }]) await assert.rejects(nbseal(b, bytes, extra), /match its seal|Invalid/);
  assert.equal((await backups())[0].sealed_at, null); await stillClosed();
}));

test('notification backup all continuation rejects unauthorized administrators and foreign task/backup identifiers', () => transaction(async () => {
  const b = await nbready(), p = await ncplan(), bytes = fakeCipher();
  for (const token of [branch, emergency, other, randomUUID()]) {
    const extra = { p_admin_session_token: token };
    for (const action of [() => ncplan(extra), () => nbprepare(p, extra), () => nbpage(b, 'messages', null, extra), () => nbverify(b, extra), () => nbappend(b, 0, bytes, extra), () => nbseal(b, bytes, extra)])
      await assert.rejects(action(), /Super administrator|invalid or expired/);
  }
  await assert.rejects(ncplan({ p_job_token: randomUUID() }), /invalid or expired/);
  for (const action of [() => nbverify({ backup_id: task.job_id }), () => nbappend({ backup_id: randomUUID() }, 0, bytes), () => nbseal({ backup_id: randomUUID() }, bytes)]) await assert.rejects(action(), /unavailable|does not accept|Invalid/);
  await stillClosed();
}));

test('notification backup expired session, expired task or stale heartbeat cannot renew authority; sealed ciphertext remains recoverable', () => transaction(async () => {
  const b = await nbready(), bytes = fakeCipher(); await nbappend(b, 0, bytes); await nbseal(b, bytes); const p = await ncplan();
  for (const [sql, args] of [
    ["UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1", [NEW.root]],
    ["UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", [task.job_id]],
    ["UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", [task.job_id]],
  ]) {
    await db.exec('SAVEPOINT notification_expiration');
    await db.query(sql, args); const saved = await transferSnapshot();
    for (const action of [() => ncplan(), () => nbprepare(p), () => nbpage(b, 'messages'), () => nbverify(b), () => nbappend(b, 0, bytes), () => nbseal(b, bytes)]) await assert.rejects(action(), /invalid or expired/);
    assert.deepEqual(await transferSnapshot(), saved);
    if (args[0] === task.job_id) assert.equal((await nbget(b)).hex, bytes.toString('hex'));
    assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
    await db.exec('ROLLBACK TO SAVEPOINT notification_expiration; RELEASE SAVEPOINT notification_expiration');
  }
}));

test('notification backup cancellation discards only unsealed independent backup and existing task cleanup removes plaintext', () => transaction(async () => {
  const b = await nbready(); await nbappend(b, 0, fakeCipher()); const before = await business(); await rpc('employee_transfer_cancel', auth());
  assert.deepEqual(await backups(), []); assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [task.job_id]), 0);
  assert.equal(await scalar(db, 'SELECT sealed_at IS NOT NULL FROM private.employee_transfer_shared_backups WHERE id=$1', [task.job_id]), true);
  await assert.rejects(nbget(b), /unavailable/); assert.deepEqual(await business(), before); await stillClosed();
}));

test('notification backup late prepare and seal exceptions roll back snapshot, ciphertext seal and events without business side effects', () => transaction(async () => {
  await nstage(); const p = await ncplan(), before = await business(), original = await triggers();
  await db.exec(`CREATE FUNCTION public.notification_backup_event_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action IN ('notification_backup_prepared','notification_backup_sealed') THEN RAISE EXCEPTION 'late notification backup failure';END IF;RETURN NEW;END $$;
    CREATE TRIGGER notification_backup_event_fail BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.notification_backup_event_fail()`);
  await assert.rejects(nbprepare(p), /late notification backup failure/); assert.deepEqual(await backups(), []);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key LIKE 'notifications-backup:%'", [task.job_id]), 0);
  await db.exec('ALTER TABLE private.employee_transfer_events DISABLE TRIGGER notification_backup_event_fail');
  const b = await nbprepare(p), bytes = fakeCipher(); await nbappend(b, 0, bytes); const saved = await backups();
  await db.exec('ALTER TABLE private.employee_transfer_events ENABLE TRIGGER notification_backup_event_fail');
  await assert.rejects(nbseal(b, bytes), /late notification backup failure/); assert.deepEqual(await backups(), saved);
  assert.deepEqual(await business(), before); assert.deepEqual(await triggers(), original); await stillClosed();
}));

for (const large of ['row', 'total']) test(`notification backup ${large} plaintext limit blocks atomically without truncation or partial snapshot`, () => transaction(async () => {
  await nstage();
  await localChange(db, 'public.messages', `INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority)
    SELECT gen_random_uuid(),$1,'root','synthetic',repeat('x',$2),'realtime','normal' FROM generate_series(1,$3)`, [NEW.root, large === 'row' ? 65536 : 60000, large === 'row' ? 1 : 141]);
  const p = await ncplan(), before = await business(); await assert.rejects(nbprepare(p), /exceeds limits/); assert.deepEqual(await backups(), []);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key LIKE 'notifications-backup:%'", [task.job_id]), 0);
  assert.deepEqual(await business(), before); await stillClosed();
}));

test('notification backup missing date_runs is never created implicitly; existing maintenance inventory remains an explicit blocker', () => transaction(async () => {
  await nstage(changedNotifications({ notification_automation_date_runs: () => '' }));
  await db.exec('DROP TABLE public.notification_automation_date_runs');
  await scalar(db, 'SELECT private.employee_transfer_notification_lock()');
  assert.match(await scalar(db, 'SELECT private.employee_transfer_notification_target_hash()'), /^[0-9a-f]{64}$/);
  await assert.rejects(ncplan(), /maintenance inventory or guards/);
  assert.equal(await scalar(db, "SELECT to_regclass('public.notification_automation_date_runs') IS NULL"), true);
  assert.deepEqual(await backups(), []);
}));

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
