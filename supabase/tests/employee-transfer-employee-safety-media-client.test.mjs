import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { createReadStream, mkdtempSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { build } from 'esbuild';

// Only local filesystem, real crypto/container and synthetic SQL47 RPC + actual Edge handler.
// This is NOT real Postgres, Supabase Storage, CORS, browser disk or full-employee restore acceptance.
for (const [module, name] of [[globalThis, 'fetch'], [http, 'request'], [https, 'request'], [net, 'connect'], [tls, 'connect']]) {
  mock.method(module, name, () => assert.fail('Production/network forbidden'));
}
const unhandled = [], onUnhandled = error => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);
after(async () => {
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(globalThis.fetch.mock.callCount(), 0); assert.deepEqual(unhandled, []);
  process.off('unhandledRejection', onUnhandled); mock.restoreAll();
});
const root = fileURLToPath(new URL('../../', import.meta.url)), ORIGIN = 'https://employee-safety-fixture.supabase.co';
const built = await build({ stdin: { resolveDir: root, contents: `export * from './src/lib/employeeTransfer/employeeSafetyMedia.ts';
  export * from './src/lib/employeeTransfer/employeeSafetyBackup.ts';
  export * from './src/lib/employeeTransfer/employeeIdentityProjection.ts';
  export {EMPLOYEE_BACKUP_PROJECTIONS} from './src/lib/employeeTransfer/employeeBackup.ts';
  export {writeEncryptedVolume} from './src/lib/employeeTransfer/container.ts';
  export {setHarness} from 'safety-media:state';` },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(ORIGIN), 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"synthetic-anon-key"' },
  plugins: [{ name: 'offline-only', setup(b) {
    b.onResolve({ filter: /^(?:safety-media:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === 'safety-media:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth' ? 'import{current}from"safety-media:state";export const getAdminFinancialSessionToken=()=>current().session;'
        : 'import{current}from"safety-media:state";export const supabase={rpc(...args){if(this!==supabase)throw new Error("Unbound RPC");return current().rpc(...args)}};' }));
  } }],
});
assert.ok(!Object.keys(built.metafile.inputs).some(p => /node_modules\/@supabase|src\/lib\/(auth|supabase)\.ts|functions\/|archiveBundle\.ts|replacementBackup\.ts/.test(p)), 'Browser bundle never includes Edge or live auth/client');
const api = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text + '\n//# sourceURL=employee-safety-media-client-isolated.mjs').toString('base64')}`);
const edgeBuild = await build({ entryPoints: [join(root, 'supabase/functions/employee-transfer-media/handler.ts')], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { createEmployeeTransferMediaHandler } = await import(`data:text/javascript;base64,${Buffer.from(edgeBuild.outputFiles[0].text).toString('base64')}`);
const id = n => `87000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SITE = id(1), JOB = id(2), EMPLOYEE = id(3), TOKEN = id(4), SESSION = id(5), OTHER = id(6);
const NAME = 'PRIVATE case-sensitive 員工', PASS = 'independent paired local media backup passphrase', SECRET = 'NEVER-ECHO-PASSWORD-OR-RAW-SERVER-ERROR';
const FINGERPRINT = 'd'.repeat(64), JPEG = Uint8Array.of(255, 216, 255, 0, 1, 2);
const PNG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), PDF = new TextEncoder().encode('%PDF-1.7-fixture');
const MP4 = Uint8Array.from([0, 0, 0, 20, ...Buffer.from('ftypisom'), 0, 0, 0, 0, ...Buffer.from('mp42')]);
const WEBM = Uint8Array.from([26, 69, 223, 163, 0x87, 0x42, 0x82, 0x84, ...Buffer.from('webm')]);
const sha = raw => createHash('sha256').update(raw).digest('hex'), enc = text => new TextEncoder().encode(text);
const FLAGS = { complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false };
const RECORD_FLAGS = { records_only: true, media_included: false, ...FLAGS };
const TABLES = api.EMPLOYEE_SAFETY_BACKUP_TABLE_KEYS, CATALOG_PATH = api.EMPLOYEE_SAFETY_MEDIA_CATALOG_PATH;
const INVENTORY = 'get_employee_safety_backup_media', VERIFY = 'employee_safety_backup_media_verify';
const AUTHORIZE = 'employee_safety_backup_media_authorize', COMMIT = 'employee_safety_backup_media_commit';
const identity = () => ({ job_id: JOB, job_token: TOKEN, site_id: SITE, employee_id: EMPLOYEE, username: NAME });
const info = () => ({ exportId: randomUUID(), volumeId: randomUUID(), sourceSiteId: SITE, scope: 'replacement-backup', volumeIndex: 1, volumeCount: 1, createdAt: '2026-10-22T00:00:00.000Z' });
const stream = raw => ({ async *[Symbol.asyncIterator]() { for (let i = 0; i < raw.length; i += 4096) yield raw.subarray(i, i + 4096); } });
async function collect(source) { const chunks = []; for await (const raw of source) chunks.push(Buffer.from(raw)); return Buffer.concat(chunks); }
const lines = text => text.match(/[^\n]*\n/g) ?? [];
async function spec(file, domain) {
  const sql = await readFile(join(root, 'supabase/migrations', file), 'utf8');
  const match = sql.match(new RegExp(`CREATE FUNCTION private.employee_transfer_${domain}_spec\\(\\)[\\s\\S]*?SELECT '([\\s\\S]*?)'::jsonb;`));
  assert.ok(match); return JSON.parse(match[1]);
}
const projections = { ...api.EMPLOYEE_BACKUP_PROJECTIONS,
  ...await spec('20261102000028_export_stage_site_chat.sql', 'chat'),
  ...await spec('20261102000023_export_stage_site_notifications.sql', 'notifications'),
  ...await spec('20261102000009_export_dispatch_submission_data.sql', 'dispatch'),
  ...await spec('20261102000033_transfer_readonly_archives.sql', 'archives'),
  orders_history: { id: 'uuid!', user_id: 'uuid!', status: 'text!', commission_amount: 'numeric', created_at: 'timestamp with time zone', completed_at: 'timestamp with time zone' },
  administrators: { id: 'uuid!', username: 'text!', role: 'text!', parent_id: 'uuid', created_at: 'timestamp with time zone', updated_at: 'timestamp with time zone' } };
const MEDIA_FIELDS = {
  verification_requests: ['id_front_url', 'id_back_url', 'selfie_url'], simulated_customers: ['custom_avatar_url', 'customer_avatar'],
  customer_employee_conversations: ['message_content', 'image_url', 'rating_data'], cs_message_templates: ['content'], customer_auto_messages: ['content'],
  rich_card_contents: ['html_content'], messages: ['content'], message_templates: ['content'], notification_automation_tasks: ['content_template'],
  notification_automation_executions: ['content_snapshot'], broadcast_messages: ['message_content', 'image_url'], content_audit_events: ['media_refs', 'before_data', 'after_data'],
};
const TIME = '2024-02-29T23:34:56.123456+00:00', PRECISE = '12345678901234567890.12345678901234567890';
function rowObject(key, index = 0) {
  const row = Object.fromEntries(Object.entries(projections[key]).map(([field, spec]) => {
    const type = spec.replace(/!$/, '');
    return [field, type === 'uuid' ? id(1000 + TABLES.indexOf(key) * 500 + index)
      : type === 'text' ? '原始文字𠮷 é é' : type.startsWith('numeric') ? '__precise__' : type.startsWith('bigint') ? '9007199254740993'
        : type === 'boolean' ? false : ['integer', 'smallint'].includes(type) ? 1 : type === 'timestamp with time zone' ? TIME
          : type === 'text[]' ? ['標籤', null] : type === 'uuid[]' ? [EMPLOYEE, null] : null];
  }));
  if (['accounts', 'credentials', 'wallets', 'wallet_balance_baselines', 'work_stop_markers'].includes(key)) row.id = EMPLOYEE;
  for (const field of ['user_id', 'employee_id', 'recipient_id']) if (Object.hasOwn(row, field) && key !== 'accounts') row[field] = EMPLOYEE;
  if (key === 'accounts') Object.assign(row, { username: NAME, password_hash: '$2a$private-record-hash', updated_at: null, remarks: '原始備註\n𠮷', is_pinned: true });
  if (key === 'credentials') row.password_hash = '$2a$hash-financial';
  if (['orders', 'orders_history'].includes(key)) row.status = 'success';
  if (['wallet_ledger_entries', 'wallet_reconciliation_audit'].includes(key)) row.id = '9007199254740993';
  if (key === 'employee_login_history') Object.assign(row, { employee_id: 'LOCAL-1000', session_id: `history-${'a'.repeat(64)}`, device_info: null, device_info_is_sql_null: true });
  if (key === 'work_sessions') Object.assign(row, { end_time: null, last_heartbeat_at: null, duration_minutes: null });
  if (key === 'simulated_customers') Object.assign(row, { source_type: 'aaa_service', badge_type: null, target_employee_ids: [null], target_employee_id: OTHER });
  if (key === 'cs_message_templates') Object.assign(row, { source_type: 'aaa_service', content_type: 'text' });
  if (key === 'customer_auto_messages') Object.assign(row, { message_type: 'quick_send', content_type: 'text' });
  if (key === 'customer_employee_conversations') Object.assign(row, { source_type: 'aaa_service', sender_type: 'employee', message_type: 'text', rating_data_sql_null: true });
  if (key === 'customer_service_sessions') row.status = 'closed';
  if (key === 'ccc_conversation_annotations') row.id = `${row.customer_id}:${row.employee_id}`;
  if (key === 'rating_requests') row.status = 'completed';
  if (key === 'service_ratings') row.rating = 5;
  if (key === 'notification_automation_plans') row.status = 'active';
  if (key === 'notification_automation_tasks') Object.assign(row, { status: 'active', trigger_type: 'total_orders', trigger_mode: 'reach_once', recipient_scope: 'selected' });
  if (key === 'notification_automation_plan_members') row.id = row.user_id;
  if (['notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_failures'].includes(key)) row.id = `${row.task_id}:${row.user_id}`;
  if (key === 'notification_automation_progress') row.last_period_key = 'all';
  if (key === 'notification_automation_executions') Object.assign(row, { status: 'succeeded', period_key: 'all', task_version: 1, error_message: null,
    trigger_snapshot: { trigger_type: 'total_orders', trigger_mode: 'reach_once', threshold_value: '__precise__', minimum_daily_orders: null, minimum_daily_work_minutes: null } });
  if (key === 'notification_automation_date_runs') Object.assign(row, { period_key: 'all', task_version: 1, id: `${row.task_id}:0000000001:all` });
  if (key === 'notification_automation_failures') row.last_error = 'redacted migration error';
  if (['messages', 'message_templates', 'notification_automation_tasks'].includes(key)) Object.assign(row, { message_type: 'realtime', priority: 'normal', delivery_mode: 'realtime_only' });
  if (key === 'messages') Object.assign(row, { notification_category: 'standard', audit_origin: 'manual_admin' });
  if (key === 'message_recipients') row.delivery_channel = 'realtime';
  if (key === 'broadcast_messages') Object.assign(row, { message_type: 'text', target_type: 'specific_employees' });
  if (key === 'content_audit_recipient_versions') row.id = `${row.message_id}:${row.recipient_id}`;
  if (key === 'administrators') Object.assign(row, { role: 'secondary_admin', parent_id: OTHER, updated_at: null });
  for (const field of MEDIA_FIELDS[key] ?? []) row[field] = projections[key][field] === 'text!' ? '' : null;
  if (key === 'content_audit_events') Object.assign(row, { before_data_sql_null: true, after_data_sql_null: true, media_refs: {}, cleared_at: null });
  return row;
}
function serialize(row) { return JSON.stringify(row).replaceAll('"__precise__"', PRECISE).replace('"id":', '"\\u0069d":') + ' \r\n'; }
const publicUrl = (bucket, path, origin = ORIGIN) => `${origin}/storage/v1/object/public/${bucket}/${path}`;
const html = url => `<p>原文</p><img src="${url}">`;
function exactRef(c, table, line, field, original, kind, options) {
  const r = ref(c, kind, options);
  r.source_url = `employee-safety-media-v1:${c.site_id}:${c.job_id}:${c.employee_id}:${c.fingerprint}:${sha(line)}:${sha(`${table}:${JSON.parse(line).id}:${field}:${original}`)}:${sha(r.bucket + '/' + r.path)}`;
  r.key = sha(r.source_url); return r;
}
function recordCatalog(texts) {
  return { version: 1, protocol: 'employee-safety-records-v1', scope: 'employee-safety-records', job_id: JOB, site_id: SITE,
    employee_id: EMPLOYEE, username: NAME,
    tables: TABLES.map(key => ({ key, rows: lines(texts[key]).length, bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: sha(lines(texts[key]).map(sha).join('')) })), fingerprint: FINGERPRINT, ...RECORD_FLAGS };
}
function ref(c, kind = 'chat', options = {}) {
  const r = { key: '', source_url: '', kind, bucket: kind === 'verification' ? 'verification-documents' : kind === 'archives' ? 'content-audit-evidence' : 'chat-images',
    path: kind === 'verification' ? `id-front/${EMPLOYEE}-fixture.jpg` : kind === 'archives' ? 'PRIVATE-evidence/shared/raw' : 'fixture.jpg', avatar: false, file: null, ...options };
  r.source_url = `employee-safety-media-v1:${c.site_id}:${c.job_id}:${c.employee_id}:${c.fingerprint}:${sha('row\n')}:${sha(r.kind + ':' + r.path)}:${sha(r.bucket + '/' + r.path)}`;
  r.key = sha(r.source_url); return r;
}
const fileTuple = (r, bytes = JPEG, type = 'image/jpeg') => ({ key: r.key, source_url: r.source_url, bytes: bytes.length, sha256: sha(bytes), content_type: type });
const receipt = file => ({ success: true, key: file.key, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, ...FLAGS });
function base(empty = false) {
  const rows = Object.fromEntries(TABLES.map(key => [key, empty && key !== 'accounts' ? [] : [rowObject(key)]])), expected = [];
  const put = (table, index, field, kind, bucket, path, format = 'direct') => {
    rows[table][index] ??= rowObject(table, index);
    const original = publicUrl(bucket, path);
    rows[table][index][field] = format === 'direct' ? original : html(original) + html(original);
    expected.push({ table, index, field, original, kind, options: { bucket, path, avatar: table === 'simulated_customers' || bucket === 'super-customer-avatars' } });
  };
  if (!empty) {
    for (const [field, dir] of [['id_front_url', 'id-front'], ['id_back_url', 'id-back'], ['selfie_url', 'selfie']]) put('verification_requests', 0, field, 'verification', 'verification-documents', `${dir}/${EMPLOYEE}-fixture.jpg`);
    put('simulated_customers', 0, 'custom_avatar_url', 'chat', 'super-customer-avatars', 'avatars/fixture.png');
    rows.simulated_customers[0].customer_avatar = 'customer-avatar:vip:123';
    for (const index of [0, 1]) for (const field of ['message_content', 'image_url']) put('customer_employee_conversations', index, field, 'chat', 'chat-images', 'fixture.jpg', field === 'message_content' ? 'html' : 'direct');
    rows.customer_employee_conversations[0].rating_data = { stars: 5, comment: 'ordinary punctuation: https://example.test/file.png' };
    rows.customer_employee_conversations[0].rating_data_sql_null = false;
    for (const [table, field] of [['cs_message_templates', 'content'], ['customer_auto_messages', 'content'], ['rich_card_contents', 'html_content']]) put(table, 0, field, 'chat', 'template-images', 'fixture.jpg', 'html');
    for (const [table, field] of [['messages', 'content'], ['message_templates', 'content'], ['notification_automation_tasks', 'content_template'], ['notification_automation_executions', 'content_snapshot'], ['broadcast_messages', 'message_content'], ['broadcast_messages', 'image_url']]) put(table, 0, field, 'notifications', 'announcement-images', 'notification.pdf', field === 'image_url' ? 'direct' : 'html');
    const evidence = rows.content_audit_events[0];
    evidence.before_data = { original: 'https://historical.invalid/image.png', src: 'data:old-snapshot' }; evidence.before_data_sql_null = false;
    evidence.after_data = { arbitrary: { media: 'blob:historical-only' } }; evidence.after_data_sql_null = false;
    evidence.media_refs = { 'https://foreign.invalid/opaque?not=a-fetch-destination%2F': 'PRIVATE-evidence/shared/raw', 'second opaque key': 'PRIVATE-evidence/shared/raw' };
    for (const original of Object.keys(evidence.media_refs)) expected.push({ table: 'content_audit_events', index: 0, field: 'media_refs', original, kind: 'archives', options: { path: evidence.media_refs[original] } });
  }
  const texts = Object.fromEntries(TABLES.map(key => [key, rows[key].map(serialize).join('')])), catalog = recordCatalog(texts);
  const refs = expected.map(e => exactRef(catalog, e.table, lines(texts[e.table])[e.index], e.field, e.original, e.kind, e.options)).sort((a, b) => a.key.localeCompare(b.key));
  return { texts, catalog, refs };
}
function inventory(c, files, verified = false) { return { version: 1, scope: 'employee-safety-media', records_catalog: c, files, verified, ...FLAGS }; }
function redacted(error, phase) {
  assert.ok(error instanceof api.EmployeeSafetyMediaError); if (phase) assert.equal(error.phase, phase);
  const text = inspect(error);
  for (const value of [NAME, SECRET, TOKEN, SESSION, PASS, 'PRIVATE-evidence', '$2a$private-record-hash']) assert.ok(!text.includes(value), 'Sensitive errors never escape');
  assert.equal('cause' in error, false); assert.match(error.message, /not a complete employee backup/); return true;
}
function cleaned(h) { for (const w of h.spaces) { assert.equal(w.cleaned, true); assert.equal(w.cleanups, 1); } }
function noLifecycle(h) { assert.ok(h.calls.every(c => [INVENTORY, VERIFY, AUTHORIZE, COMMIT].includes(c.name))); }
function harness(t, empty = false) {
  const directory = mkdtempSync(join(tmpdir(), 'safety-media-client-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const b = base(empty), h = { ...b, directory, spaces: [], events: [], calls: [], session: SESSION, bound: new Map(), checked: new Set(), objects: new Map(),
    rpcHook: null, transform: null, transportHook: null, cleanupHook: null, appendHook: null, openHook: null, fileWriteHook: null, edgeCommitHook: null, transportCalls: 0, verifyCount: 0 };
  h.refresh = () => { h.catalog = recordCatalog(h.texts); };
  h.seedObjects = () => { for (const r of h.refs) h.objects.set(r.key, { bytes: r.avatar ? PNG : r.kind === 'notifications' ? PDF : JPEG, type: r.avatar ? 'image/png' : r.kind === 'notifications' ? 'application/pdf' : 'image/jpeg' }); };
  h.seedObjects();
  h.inventory = (verified = h.refs.every(r => h.checked.has(r.key))) => inventory(structuredClone(h.catalog), h.refs.map(r => ({ ...r, file: h.bound.get(r.key) ?? null })), verified);
  h.reply = async (name, args, signal) => {
    h.calls.push({ name, args: structuredClone(args) }); h.events.push(name); noLifecycle(h);
    assert.equal(args.p_admin_session_token, h.session); assert.equal(args.p_job_token, TOKEN);
    if (h.rpcHook) await h.rpcHook(name, args, signal);
    let data;
    if ([INVENTORY, VERIFY].includes(name)) {
      assert.deepEqual(Object.keys(args).sort(), ['p_admin_session_token', 'p_job_token', 'p_catalog_fingerprint'].sort());
      assert.equal(args.p_catalog_fingerprint, FINGERPRINT); if (name === VERIFY) h.verifyCount++;
      data = h.inventory();
    } else {
      const r = h.refs.find(r => r.key === args.p_object_key); assert.ok(r); assert.ok(['download', 'recheck-export'].includes(args.p_action));
      if (name === AUTHORIZE) data = { direction: 'export', ...r, file: h.bound.get(r.key) ?? null, generation: FINGERPRINT };
      else {
        assert.equal(args.p_generation, FINGERPRINT); assert.equal(args.p_storage_origin, ORIGIN);
        if (h.edgeCommitHook) return h.edgeCommitHook(args);
        const f = { key: r.key, source_url: r.source_url, bytes: args.p_bytes, sha256: args.p_sha256, content_type: args.p_content_type };
        h.bound.set(r.key, f); if (args.p_action === 'recheck-export') h.checked.add(r.key); data = receipt(f);
      }
    }
    return { data: h.transform ? await h.transform(name, structuredClone(data)) : data, error: null };
  };
  h.rpc = (name, args) => { const q = { abortSignal(s) { q.signal = s; return q; }, then(resolve, reject) { return h.reply(name, args, q.signal).then(resolve, reject); } }; return q; };
  const handler = createEmployeeTransferMediaHandler({ supabaseUrl: ORIGIN, crypto: webcrypto, rpc: (name, args) => h.reply(name, args), store: {
    async download(bucket, path) { const r = h.refs.find(r => r.bucket === bucket && r.path === path); assert.ok(r); return { data: new Response(h.objects.get(r.key).bytes) }; },
    upload() { assert.fail('No upload'); }, remove() { assert.fail('No deletion'); },
  } });
  h.transport = async (url, init) => {
    h.transportCalls++; h.events.push('edge-' + init.headers['x-transfer-action']);
    assert.equal(url, ORIGIN + '/functions/v1/employee-transfer-media'); assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.body, undefined);
    assert.equal(init.headers.apikey, 'synthetic-anon-key'); assert.equal(init.headers['x-transfer-scope'], 'employee-safety');
    assert.equal(init.headers['x-admin-session-token'], h.session); assert.equal(init.headers['x-transfer-job-token'], TOKEN);
    assert.ok(!Object.hasOwn(init.headers, 'authorization'));
    const response = await handler(new Request(url, init)); return h.transportHook ? h.transportHook(response, init) : response;
  };
  h.factory = () => {
    const w = { base: join(directory, `workspace-${h.spaces.length}`), cleaned: false, cleanups: 0, reads: new Map(),
      async append(path, raw, signal) {
        assert.equal(w.cleaned, false); assert.equal(signal.aborted, false); assert.ok(raw.length <= 1024 * 1024);
        if (h.appendHook) await h.appendHook(w, path, raw, signal);
        assert.equal(w.cleaned, false); assert.equal(signal.aborted, false);
        await mkdir(dirname(join(w.base, path)), { recursive: true }); assert.equal(w.cleaned, false); await appendFile(join(w.base, path), raw);
      },
      open(path) { return { async *[Symbol.asyncIterator]() {
        assert.equal(w.cleaned, false); w.reads.set(path, (w.reads.get(path) ?? 0) + 1);
        if (h.openHook) { const substitute = await h.openHook(w, path, w.reads.get(path)); if (substitute) { yield* substitute; return; } }
        for await (const chunk of createReadStream(join(w.base, path), { highWaterMark: 137 })) { assert.equal(w.cleaned, false); yield chunk; }
      } }; },
      async abort() {
        w.cleaned = true; w.cleanups++; h.events.push('cleanup-' + h.spaces.indexOf(w)); await rm(w.base, { recursive: true, force: true });
        if (h.cleanupHook) await h.cleanupHook(w);
      },
    }; h.spaces.push(w); return w;
  };
  h.diskFile = name => {
    const path = join(directory, name), f = { path, writes: 0,
      async write(source, signal) {
        f.writes++; const fd = await open(path, 'wx');
        try { for await (const chunk of source) { assert.equal(signal?.aborted, false); await fd.writeFile(chunk); } await fd.sync(); }
        finally { await fd.close(); }
        if (h.fileWriteHook) await h.fileWriteHook(f);
      },
      open() { h.events.push('open-' + name); return { async *[Symbol.asyncIterator]() {
        for await (const raw of createReadStream(path, { highWaterMark: 4096 })) yield raw; h.events.push('eof-' + name);
      } }; },
    }; return f;
  };
  h.recordInfo = info(); h.mediaInfo = info(); h.records = h.diskFile('records.edx'); h.media = h.diskFile('media.edx');
  h.writeRecords = async (changes = {}) => {
    const texts = changes.texts ?? h.texts, c = changes.catalog ?? h.catalog;
    async function* entries() {
      for (const key of TABLES) { if (changes.omit === key) continue; const raw = enc(texts[key]); yield { path: api.employeeSafetyBackupEntryPath(key), bytes: raw.length, open: () => stream(raw) }; }
      const raw = enc(JSON.stringify(c) + '\n'); yield { path: api.EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH, bytes: raw.length, open: () => stream(raw) };
    }
    await h.records.write(api.writeEncryptedVolume(entries(), changes.info ?? h.recordInfo, PASS), new AbortController().signal);
  };
  h.connect = () => { api.setHarness(h); return api.createEmployeeSafetyMediaSource(identity(), h.catalog, h.transport); };
  h.export = options => api.exportEmployeeSafetyMediaBackup(h.source ??= h.connect(), h.records, h.media, h.factory, PASS, h.mediaInfo, options);
  h.read = (consume = async () => {}, options = {}, password = PASS) => api.withAuthenticatedEmployeeSafetyMediaBackup(h.records, h.media, password, h.factory, consume, options);
  return h;
}
function setMediaRows(h, entries) {
  const rows = new Map();
  for (const e of entries) {
    const index = e.index ?? 0, key = `${e.table}:${index}`;
    if (!rows.has(key)) rows.set(key, { table: e.table, index, row: rowObject(e.table, index) });
    rows.get(key).row[e.field] = e.field === 'media_refs' ? { [e.original]: e.path }
      : ['id_front_url', 'id_back_url', 'selfie_url', 'image_url', 'custom_avatar_url', 'customer_avatar'].includes(e.field) ? e.original : html(e.original);
  }
  for (const table of new Set(entries.map(e => e.table))) h.texts[table] = [...rows.values()].filter(e => e.table === table).sort((a, b) => a.index - b.index).map(e => serialize(e.row)).join('');
  h.refresh();
  h.refs = entries.map(e => exactRef(h.catalog, e.table, serialize(rows.get(`${e.table}:${e.index ?? 0}`).row), e.field, e.original, e.kind, { bucket: e.bucket, path: e.path, avatar: e.avatar ?? false })).sort((a, b) => a.key.localeCompare(b.key));
  h.seedObjects();
}
async function prepared(t, empty = false) { const h = harness(t, empty); await h.writeRecords(); return h; }
async function failedExport(h, options, check) {
  await assert.rejects(h.export(options), e => { redacted(e); check?.(e); return true; }); cleaned(h); noLifecycle(h);
}
async function rewriteMedia(h, transform = c => c, changeEntries = e => e) {
  const c = transform(structuredClone(h.result.catalog)), raw = enc(JSON.stringify(c) + '\n');
  const entries = [{ path: CATALOG_PATH, raw }, ...c.inventory.files.map(r => ({ path: api.employeeSafetyMediaEntryPath(r), raw: h.objects.get(r.key)?.bytes ?? JPEG }))];
  const f = h.diskFile('rewritten-' + randomUUID() + '.edx');
  async function* source() { for (const e of changeEntries(entries)) yield { path: e.path, bytes: e.raw.length, open: () => stream(e.raw) }; }
  await f.write(api.writeEncryptedVolume(source(), h.mediaInfo, PASS, { limits: { maxLineBytes: 4 * 1024 * 1024 } }), new AbortController().signal); h.media = f;
}

for (const empty of [false, true]) test(`real filesystem AES/ZIP/SHA export + actual client RPC/Edge bridge + paired reader (${empty ? 'empty' : 'all four kinds'})`, async t => {
  const h = await prepared(t, empty), progress = [], beforeRecords = await readFile(h.records.path); h.result = await h.export({ onProgress: p => progress.push(p) });
  const r = h.result, disk = await readFile(h.media.path);
  assert.equal(r.files, h.refs.length); assert.equal(r.mediaVerified, true);
  for (const key of TABLES) assert.equal(h.spaces[0].reads.get(api.employeeSafetyBackupEntryPath(key)), 2, `Authenticated rescan: ${key}`);
  assert.equal(h.spaces[0].reads.get(api.EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH), 2);
  assert.deepEqual(r.catalog.inventory.files.map(r => ({ ...r, file: null })), h.refs); assert.equal(r.cipherSha256, sha(disk)); assert.equal(r.cipherBytes, disk.length);
  assert.deepEqual(await readFile(h.records.path), beforeRecords); assert.equal(h.verifyCount, 2); assert.equal(h.transportCalls, h.refs.length * 3);
  assert.ok(h.events.indexOf('eof-records.edx') < h.events.indexOf(INVENTORY)); assert.ok(h.events.indexOf('cleanup-0') < h.events.indexOf(INVENTORY));
  assert.ok(h.events.lastIndexOf('cleanup-2') < h.events.lastIndexOf(VERIFY));
  assert.deepEqual(r.catalog.records_file, { export_id: h.recordInfo.exportId, volume_id: h.recordInfo.volumeId, cipher_bytes: beforeRecords.length, cipher_sha256: sha(beforeRecords) });
  assert.equal(r.catalog.inventory.verified, true); assert.deepEqual(r.catalog.inventory.records_catalog, h.catalog);
  for (const name of ['completeEmployeeBackup', 'canArchive', 'canReplace', 'fullSiteComplete']) assert.equal(r[name], false);
  assert.equal(r.catalog.inventory.records_catalog.media_included, false); assert.equal(r.catalog.inventory.records_catalog.version, 1); assert.equal(TABLES.length + 1, 49);
  assert.ok(progress.some(p => p.cipherBytes === disk.length && p.cipherSha256 === sha(disk)));
  for (const p of progress) { assert.equal(Object.hasOwn(p, 'catalog'), false); assert.ok(!JSON.stringify(p).includes(NAME)); }
  assert.equal(disk.includes(Buffer.from(NAME)), false); assert.equal(disk.includes(Buffer.from('PRIVATE-evidence')), false);
  const calls = h.calls.length; let escaped, deferred;
  const value = await h.read(async reader => {
    escaped = reader; assert.ok(Object.isFrozen(reader)); assert.deepEqual(reader.inventory, r.catalog.inventory);
    const changed = reader.inventory; changed.records_catalog.username = 'changed'; assert.equal(reader.inventory.records_catalog.username, NAME);
    assert.equal(reader.fullSiteComplete, false); assert.equal(Object.hasOwn(reader, 'append'), false);
    assert.throws(() => reader.open(CATALOG_PATH)); assert.throws(() => reader.open(api.employeeSafetyBackupEntryPath('accounts')));
    for (const ref of reader.inventory.files) {
      const path = api.employeeSafetyMediaEntryPath(ref); assert.ok(!path.includes(ref.path));
      assert.deepEqual(await collect(reader.open(path)), Buffer.from(h.objects.get(ref.key).bytes)); deferred = reader.open(path);
    }
    return 123;
  });
  assert.equal(value, 123); assert.equal(h.calls.length, calls, 'Paired reader is strictly offline');
  assert.throws(() => escaped.inventory); assert.throws(() => escaped.open(CATALOG_PATH)); if (deferred) await assert.rejects(collect(deferred)); cleaned(h); noLifecycle(h);
});

const inventoryCases = [
  ['extra field', v => { v.direction = 'export'; }], ['positive complete', v => { v.complete_employee_backup = true; }],
  ['archive permission', v => { v.can_archive = true; }], ['replacement permission', v => { v.can_replace = true; }], ['site complete', v => { v.full_site_complete = true; }],
  ['truthy verified', v => { v.verified = 1; }], ['fake verified missing file', v => { v.verified = true; }],
  ['record media flag', v => { v.records_catalog.media_included = true; }], ['partial record catalog', v => { v.records_catalog.tables.pop(); }],
  ['duplicate', v => v.files.push(v.files[0])], ['reverse', v => v.files.reverse()], ['3001 files', v => { v.files = Array.from({ length: 3001 }, () => v.files[0]); }],
  ['sparse', v => { delete v.files[0]; }], ['array extra', v => { v.files.foo = 1; }],
  ['array getter', v => Object.defineProperty(v.files, '0', { enumerable: true, get() { assert.fail('Getter executed'); } })],
  ['object getter', v => Object.defineProperty(v, 'verified', { enumerable: true, get() { assert.fail('Getter executed'); } })],
  ['nested getter', v => Object.defineProperty(v.files[0], 'path', { enumerable: true, get() { assert.fail('Getter executed'); } })],
  ['nonplain', v => Object.setPrototypeOf(v.files[0], { fake: 1 })], ['symbol', v => { v.files[0][Symbol('extra')] = 1; }],
  ['opaque newline', v => { v.files[0].source_url += '\n'; }], ['key mismatch', v => { v.files[0].key = '0'.repeat(64); }],
  ['tuple extra', v => { v.files[0].file = { ...fileTuple(v.files[0]), original_url: SECRET }; }],
  ['tuple fake hash', v => { v.files[0].file = { ...fileTuple(v.files[0]), sha256: 'z'.repeat(64) }; }],
  ['tuple zero', v => { v.files[0].file = { ...fileTuple(v.files[0]), bytes: 0 }; }],
  ['tuple oversized', v => { v.files[0].file = { ...fileTuple(v.files[0]), bytes: 52428801 }; }],
  ['tuple identity', v => { v.files[0].file = { ...fileTuple(v.files[0]), source_url: SECRET }; }],
  ['path binding', v => { v.files[0].path = 'different.jpg'; }], ['boolean avatar', v => { v.files[0].avatar = 'true'; }],
];
for (const [label, mutate] of inventoryCases) test(`defensive exact inventory rejects ${label}`, () => {
  const { catalog } = base(), refs = [ref(catalog, 'chat', { path: 'a.jpg' }), ref(catalog, 'chat', { path: 'b.jpg' })].sort((a, b) => a.key.localeCompare(b.key));
  const v = inventory(catalog, refs); mutate(v); assert.throws(() => api.validateEmployeeSafetyMediaInventory(v), e => redacted(e));
});
for (const [label, kind, options] of [
  ['verification owner', 'verification', { path: `id-front/${OTHER}-fixture.jpg` }], ['verification bucket', 'verification', { bucket: 'chat-images' }],
  ['archive traversal', 'archives', { path: 'private/../raw' }], ['archive signed path', 'archives', { path: 'private/raw?token=secret' }],
  ['archive url', 'archives', { path: 'https://external.invalid/file' }], ['notification avatar', 'notifications', { avatar: true }],
  ['notification avatar bucket', 'notifications', { bucket: 'super-customer-avatars', path: 'avatars/a.jpg' }],
  ['chat avatar prefix', 'chat', { bucket: 'super-customer-avatars', avatar: true, path: 'wrong/a.jpg' }],
  ['chat avatar false', 'chat', { bucket: 'super-customer-avatars', path: 'avatars/a.jpg' }], ['unknown bucket', 'chat', { bucket: 'website-icons' }],
  ['bad kind', 'unknown', {}], ['trailing newline', 'chat', { path: 'file.jpg\n' }],
]) test(`reference follows Edge constraints: reject ${label}`, () => {
  const { catalog } = base(); assert.throws(() => api.validateEmployeeSafetyMediaInventory(inventory(catalog, [ref(catalog, kind, options)])));
});
for (const key of ['site_id', 'job_id', 'employee_id', 'fingerprint']) test(`opaque identity must match records catalog ${key}`, () => {
  const { catalog } = base(), foreign = { ...catalog, [key]: key === 'fingerprint' ? 'a'.repeat(64) : OTHER };
  assert.throws(() => api.validateEmployeeSafetyMediaInventory(inventory(catalog, [ref(foreign)])));
});
test('tuple MIME/avatar/combined-record byte bounds reject fake positive metadata', () => {
  const { catalog } = base();
  for (const [kind, avatar, type, bytes] of [['verification', false, 'video/mp4', 20], ['archives', false, 'application/pdf', 20], ['archives', false, 'video/webm', 20],
    ['chat', true, 'application/pdf', 20], ['chat', true, 'image/jpeg', 5242881], ['chat', false, 'text/html', 20]]) {
    const r = ref(catalog, kind, { avatar }); r.file = { ...fileTuple(r), content_type: type, bytes };
    assert.throws(() => api.validateEmployeeSafetyMediaInventory(inventory(catalog, [r], true)));
  }
  const refs = Array.from({ length: 21 }, (_, i) => { const r = ref(catalog, 'chat', { path: `${i}.jpg` }); r.file = { ...fileTuple(r), bytes: 52428800 }; return r; }).sort((a, b) => a.key.localeCompare(b.key));
  assert.throws(() => api.validateEmployeeSafetyMediaInventory(inventory(catalog, refs, true)));
});
for (const key of ['site_id', 'job_id', 'employee_id', 'username', 'job_token']) test(`source factory rejects mismatched ${key}`, t => {
  const h = harness(t); api.setHarness(h); const ident = { ...identity(), [key]: key === 'username' ? NAME.toLowerCase() : key === 'job_token' ? 'site-token' : OTHER };
  assert.throws(() => api.createEmployeeSafetyMediaSource(ident, h.catalog, h.transport), e => redacted(e)); assert.equal(h.calls.length, 0);
});
test('source snapshots full catalog and identity; tokens refresh; only fixed endpoint/scope/actions', async t => {
  const h = harness(t), original = structuredClone(h.catalog), ident = identity(); api.setHarness(h);
  const c = structuredClone(h.catalog), source = api.createEmployeeSafetyMediaSource(ident, c, h.transport); c.tables[0].bytes++; c.username = 'changed'; ident.job_token = OTHER;
  const inv = await source.inventory(); assert.deepEqual(inv.records_catalog, original); inv.records_catalog.username = 'caller mutation';
  h.session = OTHER; const again = await source.inventory(); assert.equal(again.records_catalog.username, NAME);
  const downloaded = await source.download(again.files[0]); await source.recheck([downloaded.file]).then(() => assert.fail('Partial inventory must fail'), e => redacted(e));
  assert.equal(h.transportCalls, 1); noLifecycle(h);
});
for (const [label, headers] of [
  ['content-range', { 'content-range': 'bytes 0-5/6' }], ['encoding', { 'content-encoding': 'gzip' }], ['length syntax', { 'content-length': '06' }],
  ['length too large', { 'content-length': '52428801' }], ['length mismatch', { 'content-length': '1' }], ['bad binary MIME', { 'content-type': 'text/html' }],
  ['bad magic MIME', { 'x-transfer-content-type': 'video/mp4' }], ['bad SHA', { 'x-transfer-sha256': '0'.repeat(64) }],
]) test(`actual source download rejects ${label} without retry`, async t => {
  const h = harness(t), source = h.connect(), inv = await source.inventory();
  h.transportHook = async res => { const raw = await res.arrayBuffer(), next = new Headers(res.headers); for (const [key, value] of Object.entries(headers)) next.set(key, value); return new Response(raw, { headers: next }); };
  await assert.rejects(source.download(inv.files[0]), e => { redacted(e, 'download'); assert.equal(e.outcomeUnknown, true); return true; }); assert.equal(h.transportCalls, 1); noLifecycle(h);
});
for (const variant of ['redirect', 'partial', 'missing-hash', 'invalid-magic', 'bad-body', 'oversized-avatar']) test(`actual transport rejects ${variant}`, async t => {
  const h = harness(t), source = h.connect(), inv = await source.inventory(), r = variant === 'oversized-avatar' ? inv.files.find(r => r.avatar) : inv.files[0];
  h.transportHook = async res => {
    if (variant === 'redirect') { Object.defineProperty(res, 'redirected', { value: true }); return res; }
    if (variant === 'partial') return new Response(JPEG, { status: 206, headers: res.headers });
    if (variant === 'missing-hash') { res.headers.delete('x-transfer-sha256'); return res; }
    const bytes = variant === 'oversized-avatar' ? new Uint8Array(5242881) : variant === 'invalid-magic' ? enc('not an image') : new Uint8Array();
    const headers = new Headers(res.headers); headers.set('x-transfer-sha256', sha(bytes)); return new Response(bytes, { headers });
  };
  await assert.rejects(source.download(r), e => redacted(e)); assert.equal(h.transportCalls, 1);
});
for (const flag of Object.keys(FLAGS)) test(`recheck rejects forged ${flag} receipt`, async t => {
  const h = harness(t), source = h.connect(), inv = await source.inventory(), files = [];
  for (const r of inv.files) files.push((await source.download(r)).file);
  h.transportHook = async (res, init) => { if (init.headers['x-transfer-action'] === 'recheck-export') { const value = await res.json(); value[flag] = true; return Response.json(value); } return res; };
  await assert.rejects(source.recheck(files), e => { redacted(e, 'recheck'); assert.equal(e.outcomeUnknown, true); return true; });
  assert.equal(h.transportCalls, files.length + 1);
});
test('Edge commit response loss remains unknown; no retry or close', async t => {
  const h = harness(t), source = h.connect(), inv = await source.inventory(); h.edgeCommitHook = () => { throw new Error(SECRET); };
  await assert.rejects(source.download(inv.files[0]), e => { redacted(e); assert.equal(e.outcomeUnknown, true); return true; }); assert.equal(h.transportCalls, 1); noLifecycle(h);
});
test('source verifies refs AND bound tuples; a valid replacement receipt cannot hide source drift', async t => {
  const h = harness(t), source = h.connect(), inv = await source.inventory(), files = [];
  for (const r of inv.files) files.push((await source.download(r)).file); await source.recheck(files); await source.verify();
  h.bound.set(files[0].key, { ...files[0], sha256: '0'.repeat(64) }); await assert.rejects(source.verify(), e => redacted(e, 'verify'));
});
test('source detects baseline reference drift and cannot accept arbitrary caller refs', async t => {
  const h = harness(t), source = h.connect(), inv = await source.inventory();
  await assert.rejects(source.download(ref(h.catalog, 'chat', { path: 'foreign.jpg' }))); assert.equal(h.transportCalls, 0);
  h.refs = []; await assert.rejects(source.inventory());
  h.refs = inv.files; h.transform = (name, value) => { if (name === VERIFY) value.verified = false; return value; }; await assert.rejects(source.verify());
});

const delay = () => new Promise(resolve => setTimeout(resolve, 1));
async function waitFor(predicate) { for (let i = 0; i < 2000 && !predicate(); i++) await delay(); assert.ok(predicate(), 'Operation reached suspension'); }
for (const stage of ['rpc', 'transport', 'body']) test(`abort releases stalled ${stage} and never waits on stream cancel`, { timeout: 10000 }, async t => {
  const h = harness(t), source = h.connect(), inv = await source.inventory(), controller = new AbortController(); let entered = false, cancellations = 0;
  if (stage === 'rpc') h.rpcHook = () => { entered = true; return new Promise(() => {}); };
  if (stage === 'transport') h.transport = null; // factory's injected closure is replaced below for this variant.
  const actual = stage === 'transport' ? api.createEmployeeSafetyMediaSource(identity(), h.catalog, () => { entered = true; return new Promise(() => {}); }) : source;
  if (stage === 'body') h.transportHook = res => new Response(new ReadableStream({ pull() { entered = true; return new Promise(() => {}); }, cancel() { cancellations++; return new Promise(() => {}); } }), { headers: res.headers });
  const pending = stage === 'rpc' ? actual.inventory(controller.signal) : actual.download(inv.files[0], controller.signal);
  await waitFor(() => entered); controller.abort();
  await assert.rejects(pending, e => { redacted(e); assert.equal(e.cancelled, true); assert.equal(e.outcomeUnknown, stage !== 'rpc'); return true; });
  if (stage === 'body') assert.equal(cancellations, 1); noLifecycle(h);
});
test('120 second deadline covers response body, not just headers', async t => {
  const h = harness(t), source = h.connect(), inv = await source.inventory(); let entered = false, cancels = 0;
  h.transportHook = res => new Response(new ReadableStream({ pull() { entered = true; return new Promise(() => {}); }, cancel() { cancels++; return new Promise(() => {}); } }), { headers: res.headers });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = source.download(inv.files[0]);
    for (let i = 0; i < 100 && !entered; i++) await new Promise(resolve => setImmediate(resolve)); assert.ok(entered);
    mock.timers.tick(api.EMPLOYEE_SAFETY_MEDIA_TIMEOUT_MS);
    await assert.rejects(pending, e => { redacted(e); assert.equal(e.outcomeUnknown, true); assert.equal(e.cancelled, false); return true; }); assert.equal(cancels, 1);
  } finally { mock.timers.reset(); }
});
test('late fetch response after abort is cancelled without awaiting its stalled cancellation', async t => {
  const h = harness(t); api.setHarness(h); let release, entered = false, cancelled = 0;
  const source = api.createEmployeeSafetyMediaSource(identity(), h.catalog, () => { entered = true; return new Promise(resolve => { release = resolve; }); });
  const inv = await source.inventory(), controller = new AbortController(), pending = source.download(inv.files[0], controller.signal);
  await waitFor(() => entered); controller.abort(); await assert.rejects(pending, e => redacted(e));
  release(new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } })));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, 1);
});

for (const variant of ['wrong-password', 'tamper', 'truncate', 'missing-record-entry']) test(`authenticate ALL records before any media RPC: ${variant}`, async t => {
  const h = harness(t); if (variant === 'missing-record-entry') await h.writeRecords({ omit: 'credentials' }); else await h.writeRecords();
  if (variant === 'tamper' || variant === 'truncate') { const raw = await readFile(h.records.path); if (variant === 'tamper') raw[raw.length - 5] ^= 1; await writeFile(h.records.path, variant === 'truncate' ? raw.subarray(0, -7) : raw); }
  const source = h.connect();
  await assert.rejects(api.exportEmployeeSafetyMediaBackup(source, h.records, h.media, h.factory, variant === 'wrong-password' ? 'wrong password still long enough' : PASS, h.mediaInfo), e => redacted(e, 'records-authenticate'));
  assert.equal(h.calls.length, 0); assert.equal(h.media.writes, 0); cleaned(h);
});
for (const variant of ['wrong-password', 'tamper', 'truncate', 'mixed-record-ciphertext']) test(`paired reader rejects ${variant}`, async t => {
  const h = await prepared(t); h.result = await h.export();
  if (variant === 'mixed-record-ciphertext') {
    // Same full catalog and record metadata, freshly encrypted with a different salt/nonce is still a different record file.
    const original = h.records; h.records = h.diskFile('second-records.edx'); await h.writeRecords(); assert.notEqual(sha(await readFile(original.path)), sha(await readFile(h.records.path)));
  } else if (variant !== 'wrong-password') {
    const raw = await readFile(h.media.path); if (variant === 'tamper') raw[raw.length - 9] ^= 1; await writeFile(h.media.path, variant === 'truncate' ? raw.subarray(0, -3) : raw);
  }
  let consumed = false, calls = h.calls.length;
  await assert.rejects(h.read(async () => { consumed = true; }, {}, variant === 'wrong-password' ? 'wrong password still long enough' : PASS), e => redacted(e));
  assert.equal(consumed, false); assert.equal(h.calls.length, calls); cleaned(h);
});
for (const variant of ['missing', 'extra', 'mixed', 'wrong-mime', 'fake-verified', 'record-hash', 'record-bytes', 'full-catalog', 'noncanonical', 'duplicate']) test(`authenticated AES alone is insufficient: reject ${variant}`, async t => {
  const h = await prepared(t); h.result = await h.export();
  let transform = c => c, entries = e => e;
  if (variant === 'missing') entries = e => e.slice(0, -1);
  if (variant === 'extra') entries = e => [...e, { path: 'media/chat-images/extra', raw: JPEG }];
  if (variant === 'mixed') entries = e => e.map((x, i) => i === 1 ? { ...x, raw: enc('different payload') } : x);
  if (variant === 'wrong-mime') transform = c => { const f = c.inventory.files[0].file; f.content_type = f.content_type === 'image/png' ? 'image/jpeg' : 'image/png'; return c; };
  if (variant === 'fake-verified') transform = c => { c.inventory.verified = false; return c; };
  if (variant === 'record-hash') transform = c => { c.records_file.cipher_sha256 = '0'.repeat(64); return c; };
  if (variant === 'record-bytes') transform = c => { c.records_file.cipher_bytes++; return c; };
  if (variant === 'full-catalog') transform = c => { c.inventory.records_catalog.tables[0].row_hashes_sha256 = '0'.repeat(64); return c; };
  if (variant === 'noncanonical') entries = e => e.map((x, i) => i === 0 ? { ...x, raw: enc(Buffer.from(x.raw).toString().replace('{', '{"version":1,')) } : x);
  if (variant === 'duplicate') {
    await assert.rejects(rewriteMedia(h, transform, e => [...e, e[1]])); cleaned(h); return;
  }
  await rewriteMedia(h, transform, entries); let consumed = false;
  await assert.rejects(h.read(async () => { consumed = true; }), e => redacted(e)); assert.equal(consumed, false); cleaned(h);
});
for (const phase of ['inventory', 'final-reference', 'final-tuple', 'final-flag']) test(`export rejects source drift ${phase} and never returns success or closes`, async t => {
  const h = await prepared(t);
  h.transform = (name, value) => {
    if (phase === 'inventory' && name === INVENTORY) value.records_catalog.tables[0].row_hashes_sha256 = '0'.repeat(64);
    if (name === VERIFY && h.verifyCount === 2) {
      if (phase === 'final-reference') value.files.pop();
      if (phase === 'final-tuple') value.files[0].file.sha256 = '0'.repeat(64);
      if (phase === 'final-flag') value.can_archive = true;
    }
    return value;
  };
  await failedExport(h, {}, e => { assert.equal(e.encryptedFileState, phase === 'inventory' ? 'not-written' : 'verified'); });
});
for (const phase of ['record-cleanup', 'snapshot-cleanup', 'readback-cleanup']) test(`cleanup failure (${phase}) forbids success and final source recheck`, async t => {
  const h = await prepared(t), index = ['record-cleanup', 'snapshot-cleanup', 'readback-cleanup'].indexOf(phase);
  h.cleanupHook = w => { if (h.spaces.indexOf(w) === index) throw new Error(SECRET); };
  await failedExport(h, {}, e => assert.equal(e.cleanupRequired, true)); assert.ok(h.verifyCount < 2);
});
test('workspace reuse across record authentication and media snapshot is rejected', async t => {
  const h = await prepared(t), w = h.factory(), factory = () => w;
  await assert.rejects(api.exportEmployeeSafetyMediaBackup(h.connect(), h.records, h.media, factory, PASS, h.mediaInfo), e => redacted(e)); cleaned(h); assert.equal(h.media.writes, 0);
});
test('write response loss keeps partial/encrypted file and marks unknown; same output handle cannot be retried', async t => {
  const h = await prepared(t); h.fileWriteHook = () => { throw new Error(SECRET); };
  await failedExport(h, {}, e => { assert.equal(e.outcomeUnknown, true); assert.equal(e.encryptedFileState, 'unknown'); });
  assert.ok((await readFile(h.media.path)).length); assert.equal(h.media.writes, 1);
  await failedExport(h); assert.equal(h.media.writes, 1);
});
test('does not overwrite existing output or delete it after failure', async t => {
  const h = await prepared(t), original = enc('existing independent file'); await writeFile(h.media.path, original);
  await failedExport(h, {}, e => assert.equal(e.outcomeUnknown, true)); assert.deepEqual(await readFile(h.media.path), Buffer.from(original));
});
for (const stage of ['download', 'append', 'save', 'reader', 'cleanup']) test(`cancel stalled ${stage} releases waits and cleans every acquired workspace`, { timeout: 15000 }, async t => {
  const h = await prepared(t), controller = new AbortController(); let entered = false;
  let pending;
  if (stage === 'reader') {
    h.result = await h.export(); pending = h.read(() => { entered = true; return new Promise(() => {}); }, { signal: controller.signal });
  } else {
    if (stage === 'download') { const source = h.connect(); h.source = { ...source, download() { entered = true; return new Promise(() => {}); } }; }
    if (stage === 'append') h.appendHook = (w, path) => { if (path.startsWith('media/')) { entered = true; return new Promise(() => {}); } };
    if (stage === 'save') h.media.write = () => { entered = true; return new Promise(() => {}); };
    if (stage === 'cleanup') h.cleanupHook = () => { entered = true; return new Promise(() => {}); };
    pending = h.export({ signal: controller.signal });
  }
  await waitFor(() => entered); controller.abort();
  await assert.rejects(pending, e => { redacted(e); assert.equal(e.cancelled, true); if (stage === 'cleanup') assert.equal(e.cleanupRequired, true); if (['download', 'save'].includes(stage)) assert.equal(e.outcomeUnknown, true); return true; });
  cleaned(h); noLifecycle(h);
});
for (const field of ['exportId', 'volumeId', 'sourceSiteId', 'scope', 'volumeIndex', 'volumeCount']) test(`output volume rejects unsafe ${field}`, async t => {
  const h = await prepared(t); h.mediaInfo[field] = field === 'exportId' ? h.recordInfo.exportId : field === 'volumeId' ? JOB : field === 'sourceSiteId' ? OTHER : field === 'scope' ? 'full-site' : 2;
  await failedExport(h); assert.equal(h.calls.length, 0); assert.equal(h.media.writes, 0);
});
test('catalogue above 64KiB is supported as one bounded 4MiB metadata entry, with opaque portable destinations', async t => {
  const h = harness(t, true);
  setMediaRows(h, Array.from({ length: 80 }, (_, index) => {
    const path = `con./${'a'.repeat(120)}/${index}.JPG`;
    return { table: 'customer_employee_conversations', index, field: 'image_url', original: publicUrl('chat-images', path), kind: 'chat', bucket: 'chat-images', path };
  }));
  await h.writeRecords();
  h.result = await h.export(); assert.ok(h.result.manifest.entries[0].bytes > 65536); assert.ok(h.result.manifest.entries[0].bytes < 4 * 1024 * 1024);
  await h.read(async reader => assert.equal(reader.inventory.files.length, 80)); cleaned(h);
});
test('total plaintext bound includes existing record catalogue and new media catalogue before disk write', async t => {
  const h = await prepared(t, true), recordBytes = h.catalog.tables.reduce((n, t) => n + t.bytes, Buffer.byteLength(JSON.stringify(h.catalog) + '\n'));
  await failedExport(h, { limits: { maxTotalBytes: recordBytes + 10 } }); assert.equal(h.media.writes, 0);
});
test('callback failure is sanitized and escaped media reader/iterator become unusable', async t => {
  const h = await prepared(t); await h.export(); let reader, iterator;
  await assert.rejects(h.read(async r => { reader = r; iterator = r.open(api.employeeSafetyMediaEntryPath(r.inventory.files[0]))[Symbol.asyncIterator](); throw new Error(SECRET); }), e => redacted(e, 'consume'));
  assert.throws(() => reader.inventory); await assert.rejects(iterator.next()); cleaned(h);
});
test('already-started escaped iterator cannot access cleaned files or leak raw filesystem errors', async t => {
  const h = await prepared(t); await h.export(); let iterator;
  await h.read(async reader => {
    iterator = reader.open(api.employeeSafetyMediaEntryPath(reader.inventory.files[0]))[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).done, false);
  });
  await assert.rejects(iterator.next(), e => redacted(e)); cleaned(h);
});
test('paired reader refuses success when its independent plaintext cleanup fails', async t => {
  const h = await prepared(t); await h.export(); const last = h.spaces.length + 1;
  h.cleanupHook = w => { if (h.spaces.indexOf(w) === last) throw new Error(SECRET); };
  await assert.rejects(h.read(), e => { redacted(e); assert.equal(e.cleanupRequired, true); return true; }); cleaned(h);
});
test('actual encrypted package with correct payload SHA still fails magic verification', async t => {
  const h = await prepared(t); h.result = await h.export(); const bad = enc('not a real allowed magic signature');
  await rewriteMedia(h, c => {
    Object.assign(c.inventory.files[0].file, { bytes: bad.length, sha256: sha(bad) }); return c;
  }, e => e.map((entry, i) => i === 1 ? { ...entry, raw: bad } : entry));
  await assert.rejects(h.read(), e => redacted(e, 'validate')); cleaned(h);
});
test('injected source cannot falsify file size or magic even without the API factory', async t => {
  const h = await prepared(t), r = h.refs[0], inv = inventory(h.catalog, h.refs);
  h.source = { inventory: async () => inv, download: async () => ({ file: { ...fileTuple(r), bytes: JPEG.length + 1 }, bytes: JPEG }),
    recheck: async () => assert.fail('Invalid bytes cannot reach recheck'), verify: async () => assert.fail('Invalid bytes cannot reach verify') };
  await failedExport(h, {}, e => assert.equal(e.encryptedFileState, 'not-written')); assert.equal(h.media.writes, 0);
});
test('local magic inspection covers PDF/MP4/WebM in their allowed media kinds', async t => {
  const h = harness(t, true);
  setMediaRows(h, [
    { table: 'messages', field: 'content', kind: 'notifications', bucket: 'chat-images', path: 'a.mp4' },
    { table: 'customer_employee_conversations', field: 'image_url', kind: 'chat', bucket: 'chat-images', path: 'b.webm' },
    { table: 'verification_requests', field: 'selfie_url', kind: 'verification', bucket: 'verification-documents', path: `selfie/${EMPLOYEE}-a.pdf` },
  ].map(e => ({ ...e, original: publicUrl(e.bucket, e.path) })));
  for (const r of h.refs) h.objects.set(r.key, { bytes: r.path.endsWith('mp4') ? MP4 : r.path.endsWith('webm') ? WEBM : PDF });
  await h.writeRecords();
  await h.export(); await h.read(); cleaned(h);
});

function reidentify(h, r, change) {
  const originalKey = r.key, parts = r.source_url.split(':'); change(r, parts);
  parts[7] = sha(r.bucket + '/' + r.path); r.source_url = parts.join(':'); r.key = sha(r.source_url);
  if (r.file) Object.assign(r.file, { key: r.key, source_url: r.source_url });
  h.objects.set(r.key, h.objects.get(originalKey));
}
for (const variant of ['remove-one', 'remove-all', 'wrong-row-sha', 'wrong-ref-sha', 'path', 'bucket', 'kind', 'avatar', 'extra']) test(`paired reader rejects self-consistent encrypted reference forgery: ${variant}`, async t => {
  const h = await prepared(t); h.result = await h.export();
  assert.ok(JSON.parse(lines(h.texts.verification_requests)[0]).id_front_url, 'Real SQL46 records still require documents');
  const binding = structuredClone(h.result.catalog.records_file), recordCipher = await readFile(h.records.path);
  await rewriteMedia(h, c => {
    const r = c.inventory.files.find(r => r.kind === 'chat' && !r.avatar);
    if (variant === 'remove-one') c.inventory.files.splice(c.inventory.files.findIndex(r => r.kind === 'verification'), 1);
    else if (variant === 'remove-all') c.inventory.files = [];
    else if (variant === 'extra') {
      const extra = ref(h.catalog, 'chat', { path: 'extra.jpg' }); extra.file = fileTuple(extra); h.objects.set(extra.key, { bytes: JPEG }); c.inventory.files.push(extra);
    } else reidentify(h, r, (r, parts) => {
      if (variant === 'wrong-row-sha') parts[5] = sha('different row\n');
      if (variant === 'wrong-ref-sha') parts[6] = sha('different table:id:field:original');
      if (variant === 'path') r.path = 'different.jpg';
      if (variant === 'bucket') r.bucket = 'announcement-images';
      if (variant === 'kind') r.kind = 'notifications';
      if (variant === 'avatar') r.avatar = true;
    });
    c.inventory.files.sort((a, b) => a.key.localeCompare(b.key));
    assert.equal(c.inventory.verified, true); assert.deepEqual(c.records_file, binding);
    api.validateEmployeeSafetyMediaInventory(c.inventory); // Shape, hashes and file identities are internally valid.
    return c;
  });
  assert.deepEqual(await readFile(h.records.path), recordCipher);
  const calls = h.calls.length; let consumed = false;
  await assert.rejects(h.read(async () => { consumed = true; }), e => redacted(e, 'validate'));
  assert.equal(consumed, false); assert.equal(h.calls.length, calls); cleaned(h);
});
for (const variant of ['remove-one', 'remove-all', 'extra']) test(`export rejects ${variant} inventory before ANY download`, async t => {
  const h = await prepared(t);
  h.transform = (name, v) => {
    if (name === INVENTORY) {
      if (variant === 'remove-one') v.files.pop();
      if (variant === 'remove-all') { v.files = []; v.verified = true; }
      if (variant === 'extra') { v.files.push(ref(h.catalog, 'chat', { path: 'extra.jpg' })); v.files.sort((a, b) => a.key.localeCompare(b.key)); }
    }
    return v;
  };
  await failedExport(h, {}, e => { assert.equal(e.phase, 'inventory'); assert.equal(e.outcomeUnknown, false); });
  assert.equal(h.transportCalls, 0); assert.equal(h.media.writes, 0);
});
test('duplicate token dedups only within one row/field; shared objects retain separate authenticated identities', async t => {
  const h = await prepared(t); h.result = await h.export();
  const shared = h.result.catalog.inventory.files.filter(r => r.bucket === 'chat-images' && r.path === 'fixture.jpg');
  assert.equal(shared.length, 4, 'Two rows times two fields, not one shared path and not duplicate HTML tokens');
  assert.equal(new Set(shared.map(r => r.key)).size, 4);
  assert.equal(new Set(shared.map(r => r.source_url.split(':')[5])).size, 2);
  assert.equal(h.result.catalog.inventory.files.filter(r => r.kind === 'verification').length, 3);
  assert.equal(h.result.catalog.inventory.files.filter(r => r.kind === 'notifications').length, 6);
  assert.equal(h.result.catalog.inventory.files.filter(r => r.kind === 'archives').length, 2, 'Two opaque evidence keys sharing one path remain distinct');
  assert.equal(h.result.catalog.inventory.files.filter(r => r.avatar).length, 1, 'Builtin customer-avatar identifier does not download');
  assert.match(h.texts.accounts, new RegExp(PRECISE.replaceAll('.', '\\.')));
  assert.notEqual(serialize(JSON.parse(lines(h.texts.accounts)[0])), lines(h.texts.accounts)[0], 'Raw numeric precision cannot survive reserialization');
  await h.read(); cleaned(h);
});
test('URL customer_avatar is locally proven as avatar rather than a builtin identifier', async t => {
  const h = harness(t, true), path = 'avatar.jpg';
  setMediaRows(h, [{ table: 'simulated_customers', field: 'customer_avatar', kind: 'chat', bucket: 'chat-images', path, original: publicUrl('chat-images', path), avatar: true }]);
  await h.writeRecords(); const result = await h.export(); assert.equal(result.files, 1); assert.equal(result.catalog.inventory.files[0].avatar, true);
  await h.read(); cleaned(h);
});
const unsupportedRecords = [
  ['unapproved text media', 'accounts', r => { r.remarks = 'https://external.invalid/photo.png'; }],
  ['unapproved HTML', 'accounts', r => { r.remarks = '<video>'; }],
  ['unapproved CSS', 'accounts', r => { r.remarks = 'url (x)'; }],
  ['nested media key', 'employee_login_history', r => { r.device_info = { nested: [{ attachment: 'opaque reference' }] }; r.device_info_is_sql_null = false; }],
  ['nested media text', 'employee_login_history', r => { r.device_info = { nested: ['data :unsupported'] }; r.device_info_is_sql_null = false; }],
  ['nested key itself', 'employee_login_history', r => { r.device_info = { 'photo.png': null }; r.device_info_is_sql_null = false; }],
  ['residual external image', 'messages', r => { r.content = 'https://external.invalid/photo.png'; }],
  ['residual storage', 'messages', r => { r.content = 'unaccounted storage object'; }],
  ['residual data', 'messages', r => { r.content = 'blob :opaque'; }],
  ['unsupported HTML src', 'messages', r => { r.content = '<img src="https://external.invalid/a.png">'; }],
  ['encoded URL', 'messages', r => { r.content = html(publicUrl('chat-images', 'a%2Fb.jpg')); }],
  ['srcset', 'messages', r => { r.content = '<img srcset="a.jpg 2x">'; }],
  ['rating media', 'customer_employee_conversations', r => { r.rating_data = { stars: 5, image: 'opaque' }; r.rating_data_sql_null = false; }],
  ['rating nested text', 'customer_employee_conversations', r => { r.rating_data = ['photo.png']; r.rating_data_sql_null = false; }],
  ['document owner', 'verification_requests', r => { r.id_front_url = publicUrl('verification-documents', `id-front/${OTHER}-front.jpg`); }],
  ['document wrong bucket', 'verification_requests', r => { r.id_front_url = publicUrl('chat-images', 'front.jpg'); }],
  ['notification avatar bucket', 'messages', r => { r.content = html(publicUrl('super-customer-avatars', 'avatars/a.jpg')); }],
  ['mixed origins', 'messages', r => { r.content = html(publicUrl('chat-images', 'a.jpg', 'https://other-fixture.supabase.co')); }],
  ['bad builtin avatar', 'simulated_customers', r => { r.customer_avatar = 'customer-avatar:vip:123\n'; }],
  ['array evidence', 'content_audit_events', r => { r.media_refs = []; }],
  ['cleared evidence', 'content_audit_events', r => { r.cleared_at = TIME; }],
  ['evidence empty key', 'content_audit_events', r => { r.media_refs = { '': 'private/raw' }; }],
  ['evidence key controls', 'content_audit_events', r => { r.media_refs = { 'opaque\nkey': 'private/raw' }; }],
  ['evidence key bytes', 'content_audit_events', r => { r.media_refs = { ['é'.repeat(2049)]: 'private/raw' }; }],
  ['evidence nonstring', 'content_audit_events', r => { r.media_refs = { opaque: { path: 'private/raw' } }; }],
  ['evidence path bytes', 'content_audit_events', r => { r.media_refs = { opaque: 'a'.repeat(513) }; }],
  ['evidence traversal', 'content_audit_events', r => { r.media_refs = { opaque: 'private/../raw' }; }],
  ['evidence external', 'content_audit_events', r => { r.media_refs = { opaque: 'https://external.invalid/raw.jpg' }; }],
];
for (const [label, table, mutate] of unsupportedRecords) test(`fully authenticated records fail closed before media RPC: ${label}`, async t => {
  const h = harness(t), rows = lines(h.texts[table]).map(JSON.parse); mutate(rows[0]); h.texts[table] = rows.map(serialize).join(''); h.refresh(); await h.writeRecords();
  await api.withAuthenticatedEmployeeSafetyBackup(h.records, PASS, h.factory, async () => {}, {}); // Valid SQL46 rows, not a malformed container/row test.
  await failedExport(h, {}, e => assert.equal(e.phase, 'records-authenticate'));
  assert.equal(h.calls.length, 0); assert.equal(h.transportCalls, 0); assert.equal(h.media.writes, 0);
});
for (const variant of ['catalog', 'same-size-row', 'removed-row', 'extra-row', 'missing-lf', 'oversized-line', 'oversized-chunk']) test(`records workspace drift after authentication is rejected: ${variant}`, async t => {
  const h = await prepared(t); let changed = false;
  const path = variant === 'catalog' ? api.EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH : api.employeeSafetyBackupEntryPath('accounts');
  h.openHook = (w, current, count) => {
    if (h.spaces.indexOf(w) !== 0 || current !== path || count !== 2) return;
    changed = true;
    const original = h.texts.accounts;
    const raw = variant === 'catalog' ? enc((JSON.stringify(h.catalog) + '\n').replace(NAME, NAME.toLowerCase()))
      : variant === 'same-size-row' ? enc(original.replace('原始', '修改')) : variant === 'removed-row' ? enc('')
        : variant === 'extra-row' ? enc(original + original) : variant === 'missing-lf' ? enc(original.slice(0, -1))
          : variant === 'oversized-line' ? enc(' '.repeat(65536) + '\n') : new Uint8Array(1024 * 1024 + 1);
    return variant === 'oversized-chunk' ? { async *[Symbol.asyncIterator]() { yield raw; } } : stream(raw);
  };
  await failedExport(h, {}, e => assert.equal(e.phase, 'records-authenticate')); assert.equal(changed, true);
  assert.equal(h.calls.length, 0); assert.equal(h.media.writes, 0);
});
test('more than 3000 authentic distinct references is rejected before inventory or download', async t => {
  const h = harness(t, true);
  setMediaRows(h, Array.from({ length: 3001 }, (_, index) => ({ table: 'messages', index, field: 'content', kind: 'notifications', bucket: 'chat-images', path: `${index}.jpg`, original: publicUrl('chat-images', `${index}.jpg`) })));
  await h.writeRecords(); await failedExport(h, {}, e => assert.equal(e.phase, 'records-authenticate'));
  assert.equal(h.calls.length, 0); assert.equal(h.transportCalls, 0); assert.equal(h.media.writes, 0);
});

// Identity projection is local plaintext only: real paired files, never a DB restore/reservation.
const PROJECTED_EMPLOYEE = id(999999);
// Independent contract oracle. Never derive expected fields/bytes from the implementation.
const EXPECTED_IDENTITY_FIELDS = {
  accounts: ['id'], credentials: ['id'], orders: ['user_id'], wallets: ['id', 'user_id'],
  wallet_balance_baselines: ['id', 'user_id'], wallet_ledger_entries: ['user_id'], wallet_transactions: ['user_id'],
  withdrawals: ['user_id'], wallet_reconciliation_audit: ['user_id'], employee_login_history: ['user_id'],
  work_sessions: ['user_id'], work_stop_markers: ['id', 'user_id'], verification_requests: ['user_id'],
  dispatch_group_members: ['user_id'], employee_submit_time_settings: ['user_id'],
  simulated_customers: ['target_employee_id', 'target_employee_ids'], cs_message_templates: [], customer_auto_messages: [], rich_card_contents: [],
  customer_employee_conversations: ['employee_id'], customer_service_sessions: ['employee_id'],
  ccc_conversation_annotations: ['employee_id'], customer_auto_message_logs: ['employee_id'], rating_requests: ['employee_id'], service_ratings: ['employee_id'],
  notification_automation_plans: [], notification_automation_tasks: [], notification_automation_plan_members: ['id', 'user_id'],
  notification_automation_task_recipients: ['user_id'], notification_automation_progress: ['user_id'],
  notification_automation_executions: ['user_id'], notification_automation_date_runs: [], notification_automation_failures: ['user_id'],
  messages: [], message_recipients: ['recipient_id'], message_templates: [], broadcast_messages: [], broadcast_recipients: ['employee_id'],
  dispatch_config: [], dispatch_groups: [], dispatch_order_pools: [], dispatch_group_orders: [], valid_order_data: [], used_order_data: ['user_id'],
  content_audit_events: [], content_audit_recipient_versions: [], orders_history: ['user_id'], administrators: [],
};
const EXPECTED_PROJECTION_PENDING = [
  'server_identity_reservation', 'dependent_record_ids', 'shared_configuration_resolution', 'ledger_cursor_mapping',
  'media_relocation', 'archive_namespace', 'work_session_finalization', 'database_restore_and_verify',
];
const PROJECTION_FLAGS = { canRestore: false, completeEmployeeBackup: false, canArchive: false, canReplace: false, fullSiteComplete: false };
const escapedField = field => ({ id: '"\\u0069d"', user_id: '"\\u0075ser_id"', employee_id: '"\\u0065mployee_id"', recipient_id: '"\\u0072ecipient_id"' })[field] ?? JSON.stringify(field);
const regexLiteral = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SIMULATED_SOURCE_ARRAY = `[  null , "${OTHER}" , "\\u0038${EMPLOYEE.slice(1)}" , "${EMPLOYEE}"  ]`;
const SIMULATED_TARGET_ARRAY = `[  null , "${OTHER}" , "${PROJECTED_EMPLOYEE}" , "${PROJECTED_EMPLOYEE}"  ]`;
function projectionSerialize(row) {
  let raw = serialize(row);
  for (const field of ['user_id', 'employee_id', 'recipient_id']) raw = raw.replace(JSON.stringify(field) + ':', escapedField(field) + ' \t:  ');
  return ' \t' + raw.replace('{"\\u0069d":', '{ "\\u0069d" \t:  ')
    .replaceAll('"__overflow__"', '1e400').replaceAll('"__large_integer__"', '900719925474099312345678901234567890')
    .replaceAll('"__negative_zero__"', '-0').replaceAll('"__tiny__"', '9e-400');
}
function expectedProjectionLine(raw, key) {
  const row = JSON.parse(raw); let expected = raw;
  for (const field of EXPECTED_IDENTITY_FIELDS[key]) {
    if (field === 'target_employee_ids') {
      if (row[field]?.includes(EMPLOYEE)) {
        assert.ok(expected.includes(SIMULATED_SOURCE_ARRAY)); expected = expected.replace(SIMULATED_SOURCE_ARRAY, SIMULATED_TARGET_ARRAY);
      }
    } else if (row[field] === EMPLOYEE) {
      const pattern = new RegExp(`(${regexLiteral(escapedField(field))}\\s*:\\s*)${regexLiteral(JSON.stringify(EMPLOYEE))}`);
      assert.match(expected, pattern); expected = expected.replace(pattern, (_, prefix) => prefix + JSON.stringify(PROJECTED_EMPLOYEE));
    }
  }
  if (['notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_failures', 'ccc_conversation_annotations'].includes(key)) {
    const parent = key === 'ccc_conversation_annotations' ? row.customer_id : row.task_id;
    const pattern = new RegExp(`(${regexLiteral(escapedField('id'))}\\s*:\\s*)${regexLiteral(JSON.stringify(row.id))}`);
    assert.match(expected, pattern); expected = expected.replace(pattern, (_, prefix) => prefix + JSON.stringify(`${parent}:${PROJECTED_EMPLOYEE}`));
  }
  return expected;
}
function projectionRedacted(error, expected = {}) {
  assert.ok(error instanceof api.EmployeeIdentityProjectionError, inspect(error));
  for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value);
  for (const secret of [SECRET, NAME, PASS, TOKEN, SESSION, '$2a$private-record-hash', 'PRIVATE-evidence']) assert.ok(!inspect(error).includes(secret));
  assert.equal('cause' in error, false);
  assert.match(error.message, /No database restore, identity reservation, archive, replacement, retry, activation or maintenance release/);
  return true;
}
function projectionOffline(h, baseline) {
  assert.equal(h.calls.length, baseline.calls, 'No extra RPC, even a read'); assert.equal(h.transportCalls, baseline.transport, 'No Edge/Storage');
  for (const [module, name] of [[globalThis, 'fetch'], [http, 'request'], [https, 'request'], [net, 'connect'], [tls, 'connect']]) assert.equal(module[name].mock.callCount(), 0);
  noLifecycle(h);
}
function projectionBaseline(h) { return { calls: h.calls.length, transport: h.transportCalls, spaces: h.spaces.length }; }
function projectIdentity(h, consume = async () => {}, options = {}, target = PROJECTED_EMPLOYEE, password = PASS, records = h.records, factory = h.factory) {
  return api.withEmployeeSafetyIdentityProjection(records, h.media, password, target, factory, consume, options);
}
// Rebind real Edge media identities after editing raw rows, without using the projection module.
function rebindProjectionFixture(h, before) {
  h.refresh();
  h.refs = before.refs.map(r => {
    const matches = [];
    for (const [table, fields] of Object.entries(MEDIA_FIELDS)) for (const [index, raw] of lines(before.texts[table]).entries()) {
      if (sha(raw) !== r.source_url.split(':')[5]) continue;
      const row = JSON.parse(raw);
      for (const field of fields) {
        const candidates = field === 'media_refs' ? Object.keys(row[field] ?? {}) : [publicUrl(r.bucket, r.path)];
        for (const original of candidates) if (exactRef(before.catalog, table, raw, field, original, r.kind, r).key === r.key) matches.push({ table, index, field, original });
      }
    }
    assert.equal(matches.length, 1); const e = matches[0];
    return exactRef(h.catalog, e.table, lines(h.texts[e.table])[e.index], e.field, e.original, r.kind, { bucket: r.bucket, path: r.path, avatar: r.avatar });
  }).sort((a, b) => a.key.localeCompare(b.key));
  h.objects.clear(); h.seedObjects();
}
async function projectionPrepared(t, { empty = false, decorated = false, change } = {}) {
  const h = harness(t, empty), before = { texts: { ...h.texts }, refs: h.refs, catalog: h.catalog };
  if (decorated) {
    for (const key of TABLES) h.texts[key] = lines(h.texts[key]).map(raw => {
      const row = JSON.parse(raw);
      // A non-employee reference may equal the old UUID; it must still not be rewritten.
      for (const [field, type] of Object.entries(projections[key])) {
        if (type.replace(/!$/, '') === 'uuid' && field !== 'id' && !EXPECTED_IDENTITY_FIELDS[key].includes(field)) row[field] = EMPLOYEE;
        if (type.replace(/!$/, '').startsWith('numeric')) row[field] = '__precise__';
      }
      if (key === 'ccc_conversation_annotations') row.id = `${row.customer_id}:${row.employee_id}`;
      if (['notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_failures'].includes(key)) row.id = `${row.task_id}:${row.user_id}`;
      if (key === 'notification_automation_date_runs') row.id = `${row.task_id}:0000000001:all`;
      if (key === 'content_audit_recipient_versions') row.id = `${row.message_id}:${row.recipient_id}`;
      if (key === 'accounts') Object.assign(row, { employee_id: EMPLOYEE, total_income: '__precise__', remarks: `原始備註\n𠮷 ${EMPLOYEE}`, tags: [EMPLOYEE, null, 'é é'] });
      if (key === 'credentials') row.password_hash += ':' + EMPLOYEE;
      if (key === 'employee_login_history') Object.assign(row, { employee_id: EMPLOYEE, device_info: { employee_id: EMPLOYEE, nested: [{ user_id: EMPLOYEE, text: '原文\t𠮷', overflow: '__overflow__', integer: '__large_integer__' }] }, device_info_is_sql_null: false });
      if (key === 'wallet_transactions') Object.assign(row, { amount: '__overflow__', balance_before: '__large_integer__', balance_after: '__negative_zero__', remarks: `保留原文 ${EMPLOYEE}\r\n𠮷` });
      if (key === 'withdrawals') row.amount = '__tiny__';
      if (key === 'wallet_balance_baselines') row.available_balance = '__precise__';
      if (key === 'wallet_ledger_entries') Object.assign(row, { available_delta: '__precise__', frozen_delta: '__overflow__', income_delta: '__negative_zero__' });
      if (key === 'simulated_customers') Object.assign(row, { target_employee_id: EMPLOYEE, target_employee_ids: [null, OTHER, EMPLOYEE, EMPLOYEE] });
      if (key === 'content_audit_events') row.before_data = { employee_id: EMPLOYEE, nested: { user_id: EMPLOYEE, original: 'https://historical.invalid/image.png', huge: '__overflow__' } };
      if (key === 'administrators') row.username = '原始管理员文字 ' + EMPLOYEE;
      return projectionSerialize(row).replace('"target_employee_ids":[null,' + JSON.stringify(OTHER) + ',' + JSON.stringify(EMPLOYEE) + ',' + JSON.stringify(EMPLOYEE) + ']', '"target_employee_ids":' + SIMULATED_SOURCE_ARRAY);
    }).join('');
  }
  if (change) await change(h);
  rebindProjectionFixture(h, before); await h.writeRecords(); h.result = await h.export(); cleaned(h); return h;
}

// Prefix new cases so the original 176 can be excluded for a focused first run.
test('identity projection: independent 48-table raw-byte contract, exact cipher binding and offline lifecycle', async t => {
  assert.equal(Object.keys(EXPECTED_IDENTITY_FIELDS).length, 48); assert.deepEqual(Object.keys(EXPECTED_IDENTITY_FIELDS), [...TABLES]);
  assert.deepEqual(api.EMPLOYEE_IDENTITY_PROJECTION_FIELDS, EXPECTED_IDENTITY_FIELDS);
  assert.deepEqual(api.EMPLOYEE_IDENTITY_PROJECTION_PENDING, EXPECTED_PROJECTION_PENDING);
  assert.ok(Object.isFrozen(api.EMPLOYEE_IDENTITY_PROJECTION_FIELDS));
  for (const fields of Object.values(api.EMPLOYEE_IDENTITY_PROJECTION_FIELDS)) assert.ok(Object.isFrozen(fields));
  const h = await projectionPrepared(t, { decorated: true }), baseline = projectionBaseline(h), progress = [];
  const originalRecords = await readFile(h.records.path), originalMedia = await readFile(h.media.path), events = []; let recordOpens = 0, mediaOpens = 0;
  const recordsOpen = h.records.open, mediaOpen = h.media.open;
  h.records.open = () => { const n = ++recordOpens; events.push('records-open-' + n); return { async *[Symbol.asyncIterator]() { yield* recordsOpen(); events.push('records-eof-' + n); } }; };
  h.media.open = () => { const n = ++mediaOpens; events.push('media-open-' + n); return { async *[Symbol.asyncIterator]() { yield* mediaOpen(); events.push('media-eof-' + n); } }; };
  const result = await projectIdentity(h, async projection => {
    events.push('consume'); assert.equal(h.spaces.length - baseline.spaces, 4);
    assert.equal(h.spaces[baseline.spaces].cleaned, true, 'Pair record authentication has already been cleaned');
    assert.ok(events.indexOf('records-eof-2') < events.indexOf('media-open-1'));
    assert.ok(events.indexOf('media-eof-2') < events.indexOf('records-open-3'), 'Pair before second independent records authentication');
    assert.ok(events.indexOf('records-eof-4') < events.indexOf('consume'));
    assert.equal(projection.sourceSiteId, SITE); assert.equal(projection.sourceJobId, JOB);
    assert.equal(projection.sourceEmployeeId, EMPLOYEE); assert.equal(projection.targetEmployeeId, PROJECTED_EMPLOYEE); assert.equal(projection.sourceFingerprint, FINGERPRINT);
    assert.equal(projection.recordsCipherSha256, sha(originalRecords)); assert.equal(projection.recordsCipherBytes, originalRecords.length);
    for (const [flag, expected] of Object.entries(PROJECTION_FLAGS)) assert.equal(projection[flag], expected);
    assert.deepEqual([...projection.blockers].sort(), [...EXPECTED_PROJECTION_PENDING, 'submit_time_group_not_in_backup', 'external_employee_visibility'].sort());
    for (const value of [projection, projection.tables, projection.blockers, ...projection.tables]) assert.ok(Object.isFrozen(value));
    assert.throws(() => { projection.tables[0].bytes++; }); assert.throws(() => projection.blockers.pop());
    for (const key of ['append', 'restore', 'reserve', 'close', 'stop', 'seal', 'upload', 'delete']) assert.equal(Object.hasOwn(projection, key), false);
    assert.throws(() => projection.open(CATALOG_PATH)); assert.throws(() => projection.open('not-a-table'));
    for (const key of TABLES) await t.test(`identity projection: exact raw ${key}`, async () => {
      const original = h.texts[key], expected = lines(original).map(raw => expectedProjectionLine(raw, key)).join('');
      const actual = await collect(projection.open(key)), table = projection.tables.find(v => v.key === key);
      assert.ok(lines(original).length > 0, 'Every table has real-schema rows');
      assert.deepEqual(actual, Buffer.from(expected), `Only allowlisted identity tokens change in ${key}`);
      assert.deepEqual(table, { key, rows: lines(expected).length, bytes: Buffer.byteLength(expected), sha256: sha(expected) });
      const before = lines(original).map(JSON.parse), after = lines(actual.toString()).map(JSON.parse);
      for (const [index, row] of before.entries()) {
        for (const field of ['user_id', 'employee_id', 'recipient_id']) if (Object.hasOwn(row, field)) {
          const immutable = ['content_audit_events', 'content_audit_recipient_versions'].includes(key) || (field === 'employee_id' && ['accounts', 'employee_login_history'].includes(key));
          assert.equal(after[index][field], immutable ? row[field] : PROJECTED_EMPLOYEE, `${key}.${field}`);
        }
      }
      if (['content_audit_events', 'content_audit_recipient_versions', 'administrators'].includes(key)) assert.deepEqual(actual, Buffer.from(original));
      assert.ok(actual.toString().startsWith(' \t{ "\\u0069d" \t:  ')); assert.ok(actual.toString().endsWith(' \r\n'));
    });
    const login = (await collect(projection.open('employee_login_history'))).toString();
    assert.ok(login.includes('1e400')); assert.ok(login.includes('900719925474099312345678901234567890'));
    assert.equal(JSON.parse(login).device_info.nested[0].user_id, EMPLOYEE);
    const transaction = (await collect(projection.open('wallet_transactions'))).toString();
    assert.ok(transaction.includes('1e400')); assert.ok(transaction.includes('"balance_after":-0'));
    assert.ok((await collect(projection.open('withdrawals'))).toString().includes('9e-400'));
    assert.ok((await collect(projection.open('wallet_ledger_entries'))).toString().includes(PRECISE));
    assert.notEqual(JSON.stringify(JSON.parse(transaction)) + '\n', transaction, 'Reserialization destroys numeric lexemes, precision, escaping and whitespace');
    assert.equal(JSON.parse((await collect(projection.open('work_sessions'))).toString()).end_time, null, 'No work-session finalization');
    const customer = JSON.parse((await collect(projection.open('simulated_customers'))).toString());
    assert.equal(customer.target_employee_id, PROJECTED_EMPLOYEE); assert.deepEqual(customer.target_employee_ids, [null, OTHER, PROJECTED_EMPLOYEE, PROJECTED_EMPLOYEE]);
    return 'local-only-consumed';
  }, { onProgress: p => progress.push(p) });
  assert.equal(result, 'local-only-consumed'); assert.equal(recordOpens, 4); assert.equal(mediaOpens, 2); assert.equal(progress.length, 48);
  for (const [index, p] of progress.entries()) {
    const expected = TABLES.slice(0, index + 1).map(key => lines(h.texts[key]).map(raw => expectedProjectionLine(raw, key)).join(''));
    assert.deepEqual(p, { tables: index + 1, rows: expected.reduce((n, text) => n + lines(text).length, 0), bytes: expected.reduce((n, text) => n + Buffer.byteLength(text), 0), canRestore: false, fullSiteComplete: false });
    assert.ok(!inspect(p).includes(EMPLOYEE)); assert.ok(!inspect(p).includes(NAME));
  }
  assert.deepEqual(await readFile(h.records.path), originalRecords); assert.deepEqual(await readFile(h.media.path), originalMedia);
  assert.equal(h.records.writes, 1); assert.equal(h.media.writes, 1); projectionOffline(h, baseline); cleaned(h);
});

test('identity projection: zero media, mandatory account and all 47 empty table files remain valid', async t => {
  const h = await projectionPrepared(t, { empty: true }), baseline = projectionBaseline(h);
  assert.equal(h.refs.length, 0);
  await projectIdentity(h, async projection => {
    assert.equal(projection.tables.length, 48); assert.deepEqual(projection.blockers, EXPECTED_PROJECTION_PENDING);
    for (const table of projection.tables) {
      const actual = await collect(projection.open(table.key));
      if (table.key === 'accounts') { assert.equal(JSON.parse(actual.toString()).id, PROJECTED_EMPLOYEE); assert.equal(table.rows, 1); }
      else {
        assert.deepEqual(actual, Buffer.alloc(0)); assert.deepEqual(table, { key: table.key, rows: 0, bytes: 0, sha256: sha('') });
        assert.deepEqual(await readFile(join(h.spaces.at(-1).base, api.employeeSafetyBackupEntryPath(table.key))), Buffer.alloc(0));
      }
    }
    for (const [flag, value] of Object.entries(PROJECTION_FLAGS)) assert.equal(projection[flag], value);
  });
  projectionOffline(h, baseline); cleaned(h);
});

for (const [label, targetId, targetIds, blocker] of [
  ['only this employee', EMPLOYEE, [EMPLOYEE, null], false], ['unrestricted null visibility', null, null, false],
  ['empty visibility list', null, [], false], ['external singular visibility', OTHER, null, true],
  ['external list visibility', null, [OTHER, EMPLOYEE, null], true],
]) test(`identity projection: customer visibility ${label}`, async t => {
  const h = await projectionPrepared(t, { empty: true, change(h) {
    const row = rowObject('simulated_customers'); Object.assign(row, { target_employee_id: targetId, target_employee_ids: targetIds }); h.texts.simulated_customers = serialize(row);
  } }), baseline = projectionBaseline(h);
  await projectIdentity(h, async p => {
    const row = JSON.parse((await collect(p.open('simulated_customers'))).toString());
    assert.equal(row.target_employee_id, targetId === EMPLOYEE ? PROJECTED_EMPLOYEE : targetId);
    assert.deepEqual(row.target_employee_ids, targetIds?.map(v => v === EMPLOYEE ? PROJECTED_EMPLOYEE : v) ?? null);
    assert.deepEqual([...p.blockers].sort(), [...EXPECTED_PROJECTION_PENDING, ...(blocker ? ['external_employee_visibility'] : [])].sort());
  });
  projectionOffline(h, baseline); cleaned(h);
});
for (const groupId of [null, OTHER]) test(`identity projection: submit-time group ${groupId === null ? 'null' : 'dependency blocker'}`, async t => {
  const h = await projectionPrepared(t, { empty: true, change(h) {
    const row = rowObject('employee_submit_time_settings'); row.group_id = groupId; h.texts.employee_submit_time_settings = serialize(row);
  } }), baseline = projectionBaseline(h);
  await projectIdentity(h, async p => {
    const row = JSON.parse((await collect(p.open('employee_submit_time_settings'))).toString());
    assert.equal(row.group_id, groupId); assert.equal(row.user_id, PROJECTED_EMPLOYEE);
    assert.deepEqual([...p.blockers].sort(), [...EXPECTED_PROJECTION_PENDING, ...(groupId === null ? [] : ['submit_time_group_not_in_backup'])].sort());
  });
  projectionOffline(h, baseline); cleaned(h);
});

test('identity projection: reject invalid, source, site, job, export, volume and every existing UUID row identity', async t => {
  const h = await projectionPrepared(t), baseline = projectionBaseline(h);
  const cases = [
    ['null', null], ['object', {}], ['number', 123], ['empty', ''], ['whitespace', ' ' + PROJECTED_EMPLOYEE],
    ['uppercase', PROJECTED_EMPLOYEE.toUpperCase()], ['non UUID', SECRET], ['UUID v1', PROJECTED_EMPLOYEE.replace('-4000-', '-1000-')],
    ['invalid variant', PROJECTED_EMPLOYEE.replace('-8000-', '-7000-')], ['source', EMPLOYEE], ['site', SITE], ['job', JOB],
    ['records export', h.recordInfo.exportId], ['records volume', h.recordInfo.volumeId], ['visible external employee', OTHER],
  ];
  const ids = new Set();
  for (const [key, text] of Object.entries(h.texts)) for (const raw of lines(text)) {
    const value = JSON.parse(raw).id;
    if (typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) && value !== EMPLOYEE && !ids.has(value)) { ids.add(value); cases.push(['existing ' + key, value]); }
  }
  for (const [label, target] of cases) await t.test(`identity projection: rejects target ${label}`, async () => {
    let consumed = false;
    await assert.rejects(projectIdentity(h, async () => { consumed = true; }, {}, target), e => projectionRedacted(e, { cancelled: false, cleanupRequired: false }));
    assert.equal(consumed, false); projectionOffline(h, baseline); cleaned(h);
  });
});

for (const variant of ['wrong-password', 'records-tamper', 'records-truncate', 'media-tamper', 'media-truncate', 'mixed-record-ciphertext', 'missing-media-reference']) test(`identity projection: pair gate rejects ${variant} before output/callback`, async t => {
  const h = await projectionPrepared(t, { empty: variant !== 'missing-media-reference' });
  if (variant === 'mixed-record-ciphertext') { h.records = h.diskFile('mixed-identity-records.edx'); await h.writeRecords(); }
  else if (variant === 'missing-media-reference') await rewriteMedia(h, c => { c.inventory.files.pop(); return c; });
  else if (variant !== 'wrong-password') {
    const file = variant.startsWith('records-') ? h.records : h.media, bytes = await readFile(file.path);
    if (variant.endsWith('tamper')) bytes[bytes.length - 5] ^= 1;
    await writeFile(file.path, variant.endsWith('truncate') ? bytes.subarray(0, -7) : bytes);
  }
  const baseline = projectionBaseline(h); let consumed = false, progress = 0;
  await assert.rejects(projectIdentity(h, async () => { consumed = true; }, { onProgress() { progress++; } }, PROJECTED_EMPLOYEE, variant === 'wrong-password' ? SECRET : PASS), e => projectionRedacted(e));
  assert.equal(consumed, false); assert.equal(progress, 0); assert.ok(h.spaces.length - baseline.spaces <= 2, 'No second records/output before pair gate');
  projectionOffline(h, baseline); cleaned(h);
});

for (const variant of ['same-metadata-new-cipher', 'different-size-valid-cipher', 'tampered-second-cipher']) test(`identity projection: second records authentication binds exact digest/bytes (${variant})`, async t => {
  const h = await projectionPrepared(t, { empty: true }), original = h.records;
  const originalBytes = await readFile(original.path); h.records = h.diskFile('second-auth-identity.edx');
  if (variant === 'different-size-valid-cipher') {
    const row = JSON.parse(h.texts.accounts); row.remarks += ' a different but fully authentic row'; h.texts.accounts = serialize(row); h.refresh();
  }
  await h.writeRecords(); const alternate = h.records; h.records = original;
  const alternateBytes = await readFile(alternate.path);
  if (variant === 'tampered-second-cipher') { alternateBytes[alternateBytes.length - 5] ^= 1; await writeFile(alternate.path, alternateBytes); }
  if (variant === 'same-metadata-new-cipher') { assert.equal(originalBytes.length, alternateBytes.length); assert.notEqual(sha(originalBytes), sha(alternateBytes)); }
  if (variant === 'different-size-valid-cipher') assert.notEqual(originalBytes.length, alternateBytes.length);
  const baseline = projectionBaseline(h); let opened = 0, consumed = false;
  const switchAfterPair = { open() { return (++opened <= 2 ? original : alternate).open(); } };
  await assert.rejects(projectIdentity(h, async () => { consumed = true; }, {}, PROJECTED_EMPLOYEE, PASS, switchAfterPair), e => projectionRedacted(e));
  assert.equal(opened, 4); assert.equal(consumed, false); assert.equal(h.spaces.length - baseline.spaces, 3, 'No output after second-auth mismatch');
  projectionOffline(h, baseline); cleaned(h);
});

for (const stage of ['pair-records', 'second-records', 'output']) for (const variant of ['same-size', 'removed', 'extra', 'missing-lf', 'oversized-chunk']) test(`identity projection: ${stage} workspace drift rejects ${variant}`, async t => {
  const h = await projectionPrepared(t, { empty: true }), baseline = projectionBaseline(h), path = api.employeeSafetyBackupEntryPath('accounts');
  const workspaceIndex = baseline.spaces + ({ 'pair-records': 0, 'second-records': 2, output: 3 })[stage]; let changed = false, consumed = false;
  h.openHook = (w, current, count) => {
    if (h.spaces.indexOf(w) !== workspaceIndex || current !== path || count !== (stage === 'output' ? 1 : 2)) return;
    changed = true; const original = stage === 'output' ? h.texts.accounts.replace(JSON.stringify(EMPLOYEE), JSON.stringify(PROJECTED_EMPLOYEE)) : h.texts.accounts;
    const raw = variant === 'same-size' ? enc(original.replace('原始', '修改')) : variant === 'removed' ? enc('')
      : variant === 'extra' ? enc(original + original) : variant === 'missing-lf' ? enc(original.slice(0, -1)) : new Uint8Array(1024 * 1024 + 1);
    return variant === 'oversized-chunk' ? { async *[Symbol.asyncIterator]() { yield raw; } } : stream(raw);
  };
  await assert.rejects(projectIdentity(h, async () => { consumed = true; }), e => projectionRedacted(e));
  assert.equal(changed, true); assert.equal(consumed, false); projectionOffline(h, baseline); cleaned(h);
});

test('identity projection: post-validation output drift cannot produce successful consumption', async t => {
  const h = await projectionPrepared(t, { empty: true }), baseline = projectionBaseline(h); let consumed = false;
  h.openHook = (w, path, count) => {
    if (h.spaces.indexOf(w) === baseline.spaces + 3 && path === api.employeeSafetyBackupEntryPath('accounts') && count === 2) return stream(enc(h.texts.accounts.replace(JSON.stringify(EMPLOYEE), JSON.stringify(PROJECTED_EMPLOYEE)).replace('原始', '修改')));
  };
  await assert.rejects(projectIdentity(h, async p => { consumed = true; await collect(p.open('accounts')); }), e => projectionRedacted(e));
  assert.equal(consumed, true); projectionOffline(h, baseline); cleaned(h);
});

for (const stage of ['pair-records', 'pair-media', 'second-records', 'output']) test(`identity projection: ${stage} cleanup failure forbids success and cleans exactly once`, async t => {
  const h = await projectionPrepared(t, { empty: true }), baseline = projectionBaseline(h), index = baseline.spaces + ['pair-records', 'pair-media', 'second-records', 'output'].indexOf(stage); let consumed = false;
  h.cleanupHook = w => { if (h.spaces.indexOf(w) === index) throw new Error(SECRET); };
  await assert.rejects(projectIdentity(h, async () => { consumed = true; return 'not successful'; }), e => projectionRedacted(e, { cleanupRequired: true, cancelled: false }));
  if (stage === 'pair-records') assert.equal(consumed, false, 'Failed record cleanup stops before pair/output callback');
  projectionOffline(h, baseline); cleaned(h);
});

for (const stage of ['before-start', 'second-record-file', 'second-record-read', 'output-append', 'output-read', 'consume', 'cleanup']) test(`identity projection: abort releases stalled ${stage}, redacts errors and cleans all acquired workspaces`, { timeout: 15000 }, async t => {
  const h = await projectionPrepared(t, { empty: true }), baseline = projectionBaseline(h), controller = new AbortController(); let entered = false, consumed = false, opens = 0, returned = 0;
  let records = h.records, captured;
  if (stage === 'before-start') controller.abort();
  if (stage === 'second-record-file') records = { open() {
    if (++opens < 4) return h.records.open();
    return { [Symbol.asyncIterator]() { return { next() { entered = true; return new Promise(() => {}); }, return() { returned++; return new Promise(() => {}); } }; } };
  } };
  if (['second-record-read', 'output-read'].includes(stage)) h.openHook = (w, path, count) => {
    if (h.spaces.indexOf(w) === baseline.spaces + (stage === 'output-read' ? 3 : 2) && path === api.employeeSafetyBackupEntryPath('accounts') && count === (stage === 'output-read' ? 1 : 2)) return { [Symbol.asyncIterator]() { return { next() { entered = true; return new Promise(() => {}); }, return() { returned++; return new Promise(() => {}); } }; } };
  };
  if (stage === 'output-append') h.appendHook = w => { if (h.spaces.indexOf(w) === baseline.spaces + 3) { entered = true; return new Promise(() => {}); } };
  if (stage === 'cleanup') h.cleanupHook = w => { if (h.spaces.indexOf(w) === baseline.spaces + 3) { entered = true; return new Promise(() => {}); } };
  const pending = projectIdentity(h, async p => {
    consumed = true; captured = p;
    if (stage === 'consume') { entered = true; return new Promise(() => {}); }
  }, { signal: controller.signal }, PROJECTED_EMPLOYEE, PASS, records);
  const rejected = assert.rejects(pending, e => {
    projectionRedacted(e, { cancelled: true }); assert.equal(typeof e.cleanupRequired, 'boolean');
    // After abort, real fs cleanup may outlive the immediate cancellation deadline.
    // This is uncertain cleanup, never success; an intentionally stalled cleanup must say so.
    if (stage === 'cleanup') assert.equal(e.cleanupRequired, true);
    return true;
  });
  if (stage !== 'before-start') { await waitFor(() => entered); controller.abort(); }
  await rejected;
  if (stage === 'second-record-file') { await waitFor(() => returned > 0); assert.equal(returned, 1); }
  if (!['consume', 'cleanup'].includes(stage)) assert.equal(consumed, false);
  if (captured) assert.throws(() => captured.open('accounts'));
  if (stage === 'before-start') assert.equal(h.spaces.length, baseline.spaces);
  projectionOffline(h, baseline); cleaned(h);
});

for (const failure of ['consume', 'progress', 'factory', 'append', 'open']) test(`identity projection: ${failure} exception is sanitized without retry or lifecycle calls`, async t => {
  const h = await projectionPrepared(t, { empty: true }), baseline = projectionBaseline(h); let consumed = false, escaped;
  if (failure === 'append') h.appendHook = w => { if (h.spaces.indexOf(w) === baseline.spaces + 3) throw new Error(SECRET + PASS); };
  if (failure === 'open') h.openHook = (w, path) => { if (h.spaces.indexOf(w) === baseline.spaces + 3 && path === api.employeeSafetyBackupEntryPath('accounts')) throw new Error(SECRET + NAME); };
  const factory = failure === 'factory' ? () => { if (h.spaces.length === baseline.spaces + 3) throw new Error(SECRET); return h.factory(); } : h.factory;
  await assert.rejects(projectIdentity(h, async p => { consumed = true; escaped = p; throw new Error(SECRET + NAME + PASS); }, failure === 'progress' ? { onProgress() { throw new Error(SECRET); } } : {}, PROJECTED_EMPLOYEE, PASS, h.records, factory), e => projectionRedacted(e, { cancelled: false, cleanupRequired: false }));
  assert.equal(consumed, failure === 'consume'); if (escaped) assert.throws(() => escaped.open('accounts'));
  projectionOffline(h, baseline); cleaned(h);
});

for (const failure of [false, true]) test(`identity projection: reader, deferred stream and started iterator expire after ${failure ? 'throw' : 'success'}`, async t => {
  const h = await projectionPrepared(t, { empty: true }), baseline = projectionBaseline(h); let reader, deferred, notStarted, started;
  const pending = projectIdentity(h, async p => {
    reader = p; deferred = p.open('accounts'); notStarted = p.open('accounts')[Symbol.asyncIterator](); started = p.open('accounts')[Symbol.asyncIterator]();
    assert.equal((await started.next()).done, false);
    if (failure) throw new Error(SECRET); return 73;
  });
  if (failure) await assert.rejects(pending, e => projectionRedacted(e)); else assert.equal(await pending, 73);
  assert.throws(() => reader.open('accounts')); await assert.rejects(collect(deferred)); await assert.rejects(notStarted.next()); await assert.rejects(started.next());
  projectionOffline(h, baseline); cleaned(h);
});

test('identity projection: output workspace cannot reuse an authenticated source or a previous projection workspace', async t => {
  const h = await projectionPrepared(t, { empty: true }), baseline = projectionBaseline(h); let consumed = false;
  const reusedFactory = () => h.spaces.length === baseline.spaces + 3 ? h.spaces[baseline.spaces + 2] : h.factory();
  await assert.rejects(projectIdentity(h, async () => { consumed = true; }, {}, PROJECTED_EMPLOYEE, PASS, h.records, reusedFactory), e => projectionRedacted(e));
  assert.equal(consumed, false); cleaned(h);
  await projectIdentity(h); const previous = h.spaces.at(-1);
  await assert.rejects(projectIdentity(h, async () => { consumed = true; }, {}, PROJECTED_EMPLOYEE, PASS, h.records, () => previous), e => projectionRedacted(e));
  assert.equal(consumed, false); projectionOffline(h, baseline); cleaned(h);
});
