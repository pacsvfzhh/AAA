import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TRANSFER_SCOPE_COVERAGE_INVENTORY } from './support/transfer-scope.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = 'https://local-fixture.supabase.co', PREFIX = '/storage/v1/object/public/';
const ADMIN = '11111111-1111-4111-8111-111111111111', JOB = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333', PACKAGE = '44444444-4444-4444-8444-444444444444';
const SECRET = 'never-echo-notification-body-or-backend-errors', ANON = 'synthetic-anon-not-service-key';
const TIME = '2024-02-29T12:34:56.123456+00:00', PRECISE = '12345678901234567890.12345678901234567890';
const TABLES = ['notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
  'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
  'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients',
  'message_templates', 'broadcast_messages', 'broadcast_recipients'];
const LEASES = ['delivery_claim_token', 'delivery_claim_channel', 'delivery_claim_until', 'delivery_completed_claim_token'];
const COMPOSITE = [TABLES[2], TABLES[3], TABLES[4], TABLES[6], TABLES[7]];
const sha = value => createHash('sha256').update(value).digest('hex');
const bytesOf = value => new TextEncoder().encode(value);
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const recordPath = key => `data/notifications-${key}.ndjson`;
const mediaPath = file => `media/${file.source_url.split(PREFIX)[1]}`;
const compare = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
const nrows = raw => raw ? raw.split('\n').length - 1 : 0;
const rowHash = raw => sha((raw.match(/[^\n]*\n/g) ?? []).map(line => sha(line)).join(''));
const flags = { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
const verified = { verified: true, scope: 'site-notifications', media_pending: true, full_site_complete: false };
const receipt = file => ({ success: true, key: file.key, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, full_site_complete: false });
const tuple = (url, bytes, type) => ({ key: sha(url), source_url: url, bytes: bytes.length, sha256: sha(bytes), content_type: type });
const SAMPLES = [
  ['announcement-images', 'jpg', 'image/jpeg', Uint8Array.of(255, 216, 255, 224, 1, 2, 3, 255, 217)],
  ['chat-images', 'png', 'image/png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1)],
  ['template-images', 'gif', 'image/gif', bytesOf('GIF89a-synthetic')],
  ['announcement-images', 'webp', 'image/webp', bytesOf('RIFF----WEBP-synthetic')],
  ['chat-images', 'pdf', 'application/pdf', bytesOf('%PDF-1.7\nsynthetic')],
  ['template-images', 'mp4', 'video/mp4', Uint8Array.of(0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 50)],
  ['announcement-images', 'webm', 'video/webm', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...bytesOf('webm')])],
];
const URLS = SAMPLES.map(([bucket, ext], index) => `${ORIGIN}${PREFIX}${bucket}/folder/${index}-fixture.${ext}`);
function row(key) {
  const columns = TRANSFER_SCOPE_COVERAGE_INVENTORY.find(t => t.schema === 'public' && t.name === key).columns.filter(c => !LEASES.includes(c.name));
  const result = Object.fromEntries(columns.map(c => [c.name, ({ uuid: id(1), text: '原文é é 𠮷', integer: 1, smallint: 1,
    bigint: '9223372036854775807', numeric: 0, boolean: true, 'timestamp with time zone': TIME,
    jsonb: { trigger_type: 'total_orders', trigger_mode: 'reach_once', threshold_value: 0, minimum_daily_orders: null, minimum_daily_work_minutes: null } })[c.type]]));
  if ('status' in result) result.status = key === TABLES[5] ? 'succeeded' : 'active';
  if ('message_type' in result) result.message_type = key === TABLES[11] ? 'image' : 'realtime';
  Object.assign(result, Object.fromEntries(Object.entries({ priority: 'normal', delivery_mode: 'realtime_with_login_fallback', delivery_channel: null,
    notification_category: 'standard', audit_origin: 'unverified', target_type: 'all', trigger_type: 'total_orders', trigger_mode: 'reach_once',
    recipient_scope: 'selected', period_key: 'A:2024-02_29.01', last_period_key: 'A:2024-02_29.01', error_message: null,
    last_error: 'redacted migration error', image_url: null }).filter(([key]) => key in result)));
  if (COMPOSITE.includes(key)) {
    if (key === TABLES[2]) result.id = result.user_id;
    else if (key === TABLES[6]) result.id = `${result.task_id}:0000000001:${result.period_key}`;
    else result.id = `${result.task_id}:${result.user_id}`;
  }
  return result;
}
function catalog(texts) {
  const identity = { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE, processing_orders: 0, full_site_complete: false,
    tables: ['accounts', 'credentials', 'orders'].map((key, index) => ({ key, rows: index === 0 ? 1 : 0, bytes: index === 0 ? 500 : 0, row_hashes_sha256: sha('') })) };
  return { version: 1, scope: 'site-notifications', site_id: SITE, package_id: PACKAGE, identity_catalog: identity,
    finance_catalog: { version: 1, scope: 'employee-finance', site_id: SITE, package_id: PACKAGE, identity_catalog: structuredClone(identity),
      tables: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit']
        .map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })), full_site_complete: false },
    date_runs_supported: true, tables: TABLES.map(key => ({ key, rows: nrows(texts[key]), bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: rowHash(texts[key]) })), full_site_complete: false };
}
function fixture({ empty = false, editRow, origin = ORIGIN, noMedia = false } = {}) {
  const urls = URLS.map(url => url.replace(ORIGIN, origin));
  const texts = Object.fromEntries(TABLES.map(key => {
    const r = row(key);
    if (!noMedia) {
      if (key === 'messages') r.content = `<p>${SECRET}</p><IMG SRC='${urls[0]}'><video src="${urls[5]}" poster="${urls[1]}" controls></video>`;
      if (key === 'message_templates') r.content = `<a href="${urls[4]}">附件</a><img src="${urls[2]}">`;
      if (key === 'notification_automation_tasks') r.content_template = `<source src="${urls[6]}">`;
      if (key === 'notification_automation_executions') r.content_snapshot = `${urls[3]} <span data-file="${urls[4]}">原文</span>`;
      if (key === 'broadcast_messages') { r.message_content = `<img src="${urls[0]}">`; r.image_url = urls[1]; }
    }
    editRow?.(r, key, urls);
    return [key, empty ? '' : JSON.stringify(r).replace(/"(threshold_value|actual_value|last_metric|reward_amount)":0/g, `"$1":${PRECISE}`) + '\n'];
  }));
  const media = empty || noMedia ? [] : SAMPLES.map(([, , type, bytes], index) => tuple(urls[index], bytes, type)).sort(compare);
  const contents = new Map([...TABLES.map(key => [recordPath(key), bytesOf(texts[key])]), ...media.map(file => [mediaPath(file), SAMPLES[urls.indexOf(file.source_url)][3]])]);
  return { texts, catalog: catalog(texts), media, contents, manifest: { version: 1, scope: 'replacement-backup', exportId: PACKAGE,
    volumeId: 'notifications-media-single-volume', sourceSiteId: SITE, createdAt: '2026-10-19T00:00:00.000Z', volumeIndex: 1, volumeCount: 1,
    entries: [...contents].map(([path, bytes]) => ({ path, kind: path.startsWith('data/') ? 'ndjson' : 'media', bytes: bytes.length, sha256: sha(bytes) })) } };
}
function plan(f) {
  return { scope: 'site-notifications', checked: true, can_restore: false, restore_pending: true, media_pending: true, automation_pending: true,
    counts: Object.fromEntries(f.catalog.tables.map(t => [t.key, t.rows])), employees: 1, rewards: 0, conflicts: [], plan_hash: 'a'.repeat(64), ...flags };
}
function redacted(error) {
  assert.ok(error instanceof Error);
  for (const value of [SECRET, ADMIN, JOB, ANON, URLS[0]]) assert.equal(String(error).includes(value), false);
  assert.equal('cause' in error, false); return true;
}
const failed = (mayExist, cancelled = false, cleanup = false) => e => redacted(e)
  && e.serverStagingOrUploadsMayExist === mayExist && e.cancelled === cancelled && e.cleanupRequired === cleanup;
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function* fragments(bytes, size = 127) { for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size); }
async function collect(source) { const parts = []; for await (const bytes of source) parts.push(Buffer.from(bytes)); return Buffer.concat(parts); }
const noNetwork = mock.method(globalThis, 'fetch', () => assert.fail('real network forbidden'));
const logs = ['log', 'warn', 'error', 'info', 'debug', 'trace'].map(key => mock.method(console, key, () => {}));
const unhandled = [], onUnhandled = error => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);
after(async () => {
  await nextTurn(); assert.equal(noNetwork.mock.callCount(), 0);
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
  assert.deepEqual(unhandled, []); process.off('unhandledRejection', onUnhandled); mock.restoreAll();
});
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/notificationsMedia.ts';
    export * from './src/lib/employeeTransfer/notificationsApi.ts'; export * from './src/lib/employeeTransfer/container.ts';
    export {setHarness} from 'notifications-media:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(ORIGIN), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(ANON) },
  plugins: [{ name: 'offline-only', setup(b) {
    b.onResolve({ filter: /^(notifications-media:state|\.\.\/(auth|supabase))$/ }, a => ({ path: a.path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === 'notifications-media:state'
      ? 'let h; export const setHarness=v=>{h=v}; export const current=()=>h;'
      : path === '../auth' ? `import {current} from 'notifications-media:state'; export const getAdminFinancialSessionToken=()=>current().admin;`
        : `import {current} from 'notifications-media:state'; export const supabase={rpc:(...a)=>current().rpc(...a)};` }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness(f = fixture(), direction = 'import') {
  const h = { f, direction, admin: ADMIN, calls: [], fetches: [], events: [], opened: new Map(), contents: new Map(f.contents), stored: new Map(),
    staged: new Map(), bound: null, objects: new Map(), checked: new Map(), generation: '0', cleanup: 0, plans: 0, verifies: 0 };
  const refs = () => f.media.map(file => ({ key: file.key, source_url: file.source_url, bucket: file.source_url.split(PREFIX)[1].split('/')[0],
    path: file.source_url.split(PREFIX)[1].split('/').slice(1).join('/'), file: h.bound?.find(x => x.key === file.key) ?? null }));
  const query = task => { let signal; const q = { abortSignal(s) { signal = s; return q; }, then(yes, no) { return Promise.resolve().then(() => task(signal)).then(yes, no); } }; return q; };
  h.rpc = (name, args) => query(async signal => {
    h.calls.push({ name, args: structuredClone(args), signal }); h.events.push(name);
    if (h.beforeRpc) { const override = await h.beforeRpc(name, args); if (override) return override; }
    assert.equal(args.p_admin_session_token, ADMIN);
    if (name === 'employee_export_notifications_begin') {
      assert.equal(args.p_admin_password, 'synthetic-password'); assert.equal(args.p_package_id, PACKAGE);
      return { data: { success: true, job_id: JOB, job_token: JOB, site_id: SITE, catalog: f.catalog, scope: 'site-notifications', full_site_complete: false } };
    }
    assert.equal(args.p_job_token, JOB);
    if (name === 'get_employee_export_notifications_page') {
      assert.equal(args.p_after, null); assert.equal(args.p_limit, 200);
      const raw = f.texts[args.p_table_key];
      return { data: { table_key: args.p_table_key, count: nrows(raw), ndjson: raw, next_after: null, sha256: sha(raw) } };
    }
    if (name === 'employee_export_notifications_verify') {
      h.verifies++; if (h.verifies === 2) assert.equal(h.checked.size, f.media.length);
      return { data: verified };
    }
    if (name === 'employee_import_notifications_bind') {
      assert.deepEqual(args.p_catalog, f.catalog); h.recordBound = true;
      return { data: { success: true, scope: 'site-notifications', repeated: false, full_site_complete: false } };
    }
    if (name === 'employee_import_notifications_stage') {
      assert.equal(h.recordBound, true); assert.equal(args.p_chunk_no, 0);
      const raw = args.p_ndjson; assert.equal(raw, f.texts[args.p_table_key]); h.staged.set(args.p_table_key, raw);
      return { data: { success: true, rows: nrows(raw), bytes: Buffer.byteLength(raw), sha256: sha(raw), repeated: false } };
    }
    if (name === 'get_employee_import_notifications_plan') {
      h.plans++; assert.equal(h.staged.size, TABLES.length);
      return { data: h.makePlan ? h.makePlan(h.plans) : plan(f) };
    }
    if (name === 'get_employee_transfer_notification_media') {
      assert.equal(args.p_direction, direction);
      if (direction === 'import') assert.equal(h.staged.size, TABLES.length, 'all 13 raw tables must be staged');
      return { data: { scope: 'site-notifications-media', direction, files: refs(), full_site_complete: false } };
    }
    assert.equal(name, 'employee_import_notification_media_bind'); assert.equal(direction, 'import');
    if (h.bound) assert.deepEqual(args.p_files, h.bound); else h.bound = structuredClone(args.p_files);
    return { data: { success: true, scope: 'site-notifications-media', files: h.bound.length, bytes: h.bound.reduce((n, file) => n + file.bytes, 0), repeated: false, full_site_complete: false } };
  });
  h.transport = async (url, init) => {
    const headers = new Headers(init.headers), action = headers.get('x-transfer-action'), key = headers.get('x-transfer-object-key');
    assert.equal(url, ORIGIN + '/functions/v1/employee-transfer-media'); assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.equal(headers.get('x-transfer-scope'), 'notifications'); assert.equal(headers.get('apikey'), ANON);
    assert.equal(headers.get('x-admin-session-token'), ADMIN); assert.equal(headers.get('x-transfer-job-token'), JOB);
    assert.equal(headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual([...headers.keys()].sort(), ['apikey', 'content-type', 'x-admin-session-token', 'x-transfer-action', 'x-transfer-job-token', 'x-transfer-object-key', 'x-transfer-scope'].sort());
    h.fetches.push({ action, key, init }); h.events.push(action);
    if (h.beforeTransport) { const override = await h.beforeTransport(action, init); if (override) return override; }
    const file = f.media.find(file => file.key === key); assert.ok(file);
    if (action === 'upload') {
      assert.ok(init.body instanceof Uint8Array); assert.ok(h.bound?.some(f => f.key === key));
      assert.equal(init.body.length, file.bytes); assert.equal(sha(init.body), file.sha256);
      if (h.objects.has(key)) assert.deepEqual(h.objects.get(key), init.body); else h.objects.set(key, new Uint8Array(init.body));
    } else assert.equal(init.body, undefined);
    if (action === 'recheck-import') { assert.equal(sha(h.objects.get(key)), file.sha256); h.checked.set(key, h.generation); }
    if (action === 'recheck-export') { assert.equal(sha(f.contents.get(mediaPath(file))), file.sha256); h.checked.set(key, 'export'); }
    let response = action === 'download'
      ? new Response(f.contents.get(mediaPath(file)), { headers: { 'content-type': 'application/octet-stream', 'x-transfer-sha256': file.sha256, 'x-transfer-content-type': file.content_type } })
      : new Response(JSON.stringify(receipt(file)));
    if (h.afterTransport) response = await h.afterTransport(response, action);
    return response;
  };
  h.files = {
    paths: () => h.paths ?? [...h.contents.keys()],
    open(path) {
      const n = (h.opened.get(path) ?? 0) + 1; h.opened.set(path, n); h.events.push(`open:${path}:${n}`);
      return (async function* () {
        if (h.beforeRead) await h.beforeRead(path, n);
        const raw = h.contents.get(path); assert.ok(raw, 'missing isolated file');
        const copy = new Uint8Array(raw);
        yield* fragments(copy, 97);
      })();
    },
    async abort(reason) { redacted(reason); h.cleanup++; h.events.push('cleanup'); if (h.beforeAbort) await h.beforeAbort(); h.contents.clear(); },
  };
  h.sink = {
    async append(path, bytes, signal) {
      if (h.beforeAppend) await h.beforeAppend(path, bytes, signal);
      assert.equal(h.cleanup, 0); h.events.push('append:' + path);
      h.stored.set(path, Buffer.concat([h.stored.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)]));
    },
    async abort(reason) { redacted(reason); h.cleanup++; h.events.push('cleanup'); if (h.beforeAbort) await h.beforeAbort(); h.stored.clear(); },
  };
  api.setHarness(h);
  h.session = api.createNotificationsMediaSession(JOB, direction, h.transport);
  h.records = direction === 'import' ? api.createNotificationsImportSession(JOB) : api.createNotificationsExportSession(PACKAGE, 'synthetic-password');
  h.stage = options => api.stageNotificationsBundle({ catalog: f.catalog, media: f.media, manifest: f.manifest }, h.files, h.records.target, h.session, options);
  h.export = async options => { await h.records.begin(options?.signal); return api.exportNotificationsBundle(h.records.source, h.sink, h.session, options); };
  return h;
}

test('real encrypted save/reopen/EOF: 13 raw tables plus all three buckets, images/PDF/MP4/WebM, then offline Edge staging', async () => {
  const f = fixture(), out = harness(f, 'export'), exported = await out.export();
  assert.deepEqual(exported.catalog, f.catalog); assert.deepEqual(exported.media, f.media); assert.deepEqual(exported.entries, f.manifest.entries);
  assert.equal(exported.rows, 13); assert.equal(exported.fullSiteComplete, false); assert.equal(out.verifies, 2);
  for (const [path, raw] of f.contents) assert.deepEqual(out.stored.get(path), Buffer.from(raw));
  assert.deepEqual(out.fetches.map(x => x.action), [...f.media.map(() => 'download'), ...f.media.map(() => 'recheck-export')]);
  const directory = await mkdtemp(join(tmpdir(), 'notifications-media-offline-'));
  try {
    const info = { ...f.manifest }; delete info.version; delete info.entries;
    const entries = async function* () { for (const [path, raw] of out.stored) yield { path, bytes: raw.length, open: () => fragments(raw) }; };
    const encrypted = await collect(api.writeEncryptedVolume(entries(), info, 'synthetic-transfer-passphrase', { chunkSize: 113 }));
    await writeFile(join(directory, 'notifications.edx'), encrypted, { flag: 'wx', mode: 0o600 });
    await out.sink.abort(Error('Export plaintext discarded after encrypted save.'));
    assert.equal(out.stored.size, 0);
    const saved = new Uint8Array(await readFile(join(directory, 'notifications.edx'))), into = harness(f), quarantine = new Map();
    let authenticated = false;
    const manifest = await api.verifyEncryptedVolume(fragments(saved), 'synthetic-transfer-passphrase', {
      async append(path, bytes) { quarantine.set(path, Buffer.concat([quarantine.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)])); },
      async abort() { quarantine.clear(); },
    }, { expectedMetadata: { exportId: PACKAGE, volumeId: info.volumeId } });
    authenticated = true; into.contents = quarantine;
    const open = into.files.open; into.files.open = path => { assert.equal(authenticated, true); return open(path); };
    const progress = [], result = await api.stageNotificationsBundle({ catalog: exported.catalog, media: exported.media, manifest }, into.files, into.records.target, into.session, { onProgress: p => progress.push(p) });
    assert.deepEqual(result.plan, plan(f)); assert.equal(result.plan.can_restore, false); assert.equal(result.plan.media_pending, true);
    assert.equal(result.files, 7); assert.equal(result.rows, 13); assert.equal(result.bytes, exported.bytes); assert.equal(result.fullSiteComplete, false);
    assert.equal(result.serverStagingOrUploadsMayExist, true); assert.equal(quarantine.size, 0); assert.equal(into.cleanup, 1);
    assert.equal(into.staged.size, 13); for (const key of TABLES) assert.equal(into.staged.get(key), f.texts[key]);
    assert.deepEqual(progress.filter(p => p.phase === 'upload').map(p => p.files), [1, 2, 3, 4, 5, 6, 7]);
    assert.ok(progress.every(p => p.scope === 'site-notifications-media' && p.fullSiteComplete === false));
    assert.deepEqual(into.fetches.map(x => x.action), f.media.map(() => 'upload')); assert.equal(into.checked.size, 0);
    for (const file of f.media) assert.equal(into.opened.get(mediaPath(file)), 2);
    assert.equal(into.calls.some(x => /restore|close|finish|cancel|delete/.test(x.name)), false);
    into.generation = '2'; // Synthetic post-restore generation, not a SQL restore test.
    await into.session.recheckImport(exported.media);
    assert.deepEqual([...into.checked.values()], Array(7).fill('2'));
  } finally {
    if (out.stored.size) await out.sink.abort(Error('Discard export plaintext.'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('truncated/tampered containers never expose quarantine to a staging caller before complete EOF', async () => {
  const f = fixture(), info = { ...f.manifest }; delete info.version; delete info.entries;
  const entries = async function* () { for (const [path, raw] of f.contents) yield { path, bytes: raw.length, open: () => fragments(raw) }; };
  const good = await collect(api.writeEncryptedVolume(entries(), info, 'synthetic-transfer-passphrase', { chunkSize: 127 }));
  const flipped = Buffer.from(good); flipped[flipped.length - 12] ^= 1;
  for (const encrypted of [good.subarray(0, -1), good.subarray(0, -64), flipped]) {
    const h = harness(f), quarantine = new Map(); let authenticated = false;
    await assert.rejects(async () => {
      const manifest = await api.verifyEncryptedVolume(fragments(encrypted), 'synthetic-transfer-passphrase', {
        async append(path, raw) { quarantine.set(path, raw); }, async abort() { quarantine.clear(); },
      });
      authenticated = true;
      await api.stageNotificationsBundle({ catalog: f.catalog, media: f.media, manifest }, h.files, h.records.target, h.session);
    });
    assert.equal(authenticated, false); assert.equal(quarantine.size, 0); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0);
  }
});

test('factory is lazy, strict token/direction, isolated current endpoint/scope, no extra operations', () => {
  const h = harness(); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0);
  for (const token of ['', 'bad', JOB + '\n']) assert.throws(() => api.createNotificationsMediaSession(token, 'import', h.transport), redacted);
  assert.throws(() => api.createNotificationsMediaSession(JOB, 'download', h.transport), redacted);
  h.admin = 'bad'; assert.throws(() => api.createNotificationsMediaSession(JOB, 'import', h.transport), redacted);
  assert.deepEqual(Object.keys(h.session).sort(), ['direction', 'inventory', 'bind', 'download', 'upload', 'recheckExport', 'recheckImport'].sort());
  assert.deepEqual(api.NOTIFICATIONS_MEDIA_LIMITS, { maxFiles: 3000, maxFileBytes: 52428800, maxTotalBytes: 1073741824 });
  assert.equal(Object.keys(compiled.metafile.inputs).some(path => /verification(Media|Transfer)\.ts$/.test(path)), false);
});
for (const empty of [false, true]) test(`no media ${empty ? 'and no history' : 'with all13 raw tables'} still uses real bind/stage/plan, never local approval`, async () => {
  const h = harness(fixture({ empty, noMedia: true })), result = await h.stage();
  assert.equal(result.files, 0); assert.equal(result.rows, empty ? 0 : 13); assert.equal(result.plan.can_restore, false);
  assert.deepEqual(h.bound, []); assert.equal(h.staged.size, 13); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
});

const unsafe = [
  '<img src="https://evil.invalid/x.jpg">', '<img src="data:image/png;base64,AAAA">', '<img src="blob:unknown">', '<img src="/relative.jpg">',
  `<img src=${URLS[0]}>`, `<img srcset="${URLS[0]} 1x">`, '<img srcset>', '<!-- comment -->', '<!DOCTYPE html>', '<?processing?>',
  '<script>anything</script>', '<STYLE>nothing</STYLE>', '<img src="unterminated>', '<img src>', '<img src="">', '<img /broken>',
  `<p style="background:url(${URLS[0]})">x</p>`, '<p style="background:u&#114;l(x)">x</p>', '<p style="background:u\\72l(x)">x</p>',
  '<p style="/*hidden*/">x</p>', '<a href="data:application/pdf,x">x</a>', '<a href="BLOB:x">x</a>',
  `<a href=${URLS[4]}>pdf</a>`, `<a href="${URLS[0].replace('/public/', '/sign/')}?token=x">x</a>`,
  URLS[0] + '?token=secret', URLS[0] + '#fragment', URLS[0] + '&amp;x', URLS[0] + '%20', URLS[0] + ',unsafe',
  URLS[0].replace('https:', 'http:'), URLS[0].replace('.supabase.co', '.supabase.co.evil.invalid'), URLS[0].replace('https://', 'https://user:password@'),
  URLS[0].replace('.supabase.co', '.supabase.co:443'), URLS[0].replace('/folder/', '/folder/../'), URLS[0].replace('/folder/', '/./'),
  URLS[0].replace('/folder/', '/folder/a..b/'), URLS[0].replace('/folder/', '/folder/%2f/'), URLS[0].replace('announcement-images', 'verification-documents'),
];
for (const [index, content] of unsafe.entries()) test(`SQL26 tokenizer/URL rejection ${index}: no skipped files, no server staging`, async () => {
  const f = fixture({ editRow: (r, key) => { if (key === 'messages') r.content = content; } }), h = harness(f);
  await assert.rejects(h.stage(), failed(false)); assert.equal(h.cleanup, 1); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0);
  const out = harness(f, 'export'); await assert.rejects(out.export(), failed(false));
  assert.equal(out.cleanup, 1); assert.equal(out.fetches.length, 0); assert.equal(out.stored.size, 0);
});
for (const key of ['messages', 'message_templates', 'notification_automation_tasks', 'notification_automation_executions', 'broadcast_messages']) {
  test(`media extraction includes ${key}, not only live messages`, async () => {
    const field = ({ messages: 'content', message_templates: 'content', notification_automation_tasks: 'content_template',
      notification_automation_executions: 'content_snapshot', broadcast_messages: 'message_content' })[key];
    const h = harness(fixture({ editRow: (r, table) => { if (table === key) r[field] = '<img src="https://evil.invalid/x.jpg">'; } }));
    await assert.rejects(h.stage(), failed(false)); assert.equal(h.calls.length, 0);
  });
}
for (const value of ['', URLS[0] + '\n', 'https://evil.invalid/x.jpg']) test(`broadcast direct image_url rejects ${JSON.stringify(value)}`, async () => {
  const h = harness(fixture({ editRow: (r, key) => { if (key === 'broadcast_messages') r.image_url = value; } }));
  await assert.rejects(h.stage(), failed(false)); assert.equal(h.calls.length, 0);
});

test('plain Storage attachments, mixed attribute case, harmless hyperlinks, quoted >, null direct image remain exact', async () => {
  const f = fixture({ editRow(r, key, urls) {
    if (key === 'messages') r.content += ` text ${urls[4]} <a href="https://docs.invalid/guide">guide</a><span style="color: red; text-align: center" title='a > b' data-file="${urls[4]}"><strong>附件</strong><br /></span>`;
    if (key === 'broadcast_messages') r.image_url = null;
  } }), h = harness(f); const result = await h.stage();
  assert.equal(result.files, 7); assert.equal(h.staged.get('messages'), f.texts.messages); assert.equal(h.cleanup, 1);
});
test('mixed source Storage origins are rejected before writes; old-site import still uses CURRENT Edge only', async () => {
  const old = fixture({ origin: 'https://old-fixture.supabase.co' }), into = harness(old); await into.stage();
  assert.equal(into.fetches.length, 7);
  const out = harness(old, 'export'); await assert.rejects(out.export(), failed(true)); assert.equal(out.fetches.length, 0);
  const mixed = harness(fixture({ editRow(r, key) { if (key === 'messages') r.content += `<img src="${URLS[0].replace(ORIGIN, 'https://other-fixture.supabase.co')}">`; } }));
  await assert.rejects(mixed.stage(), failed(false)); assert.equal(mixed.calls.length, 0);
});

const bundleMutations = [
  ['missing file', (f, h) => h.contents.delete(mediaPath(f.media[0]))], ['extra file', (_f, h) => h.contents.set('data/extra.ndjson', bytesOf(''))],
  ['missing record entry', f => f.manifest.entries.splice(2, 1)], ['missing media entry', f => f.manifest.entries.pop()],
  ['duplicate entry', f => { f.manifest.entries[1] = f.manifest.entries[0]; }], ['extra entry', f => f.manifest.entries.push({ path: 'data/extra.ndjson', kind: 'ndjson', bytes: 0, sha256: sha('') })],
  ['cross-package', f => { f.manifest.exportId = JOB; }], ['cross-site', f => { f.manifest.sourceSiteId = JOB; }],
  ['wrong scope', f => { f.manifest.scope = 'full-site'; }], ['multivolume', f => { f.manifest.volumeCount = 2; }],
  ['path traversal', f => { f.manifest.entries.at(-1).path = 'media/chat-images/../x.jpg'; }], ['wrong kind', f => { f.manifest.entries[0].kind = 'media'; }],
  ['record manifest digest', f => { f.manifest.entries[12].sha256 = 'a'.repeat(64); }], ['trailing digest newline', f => { f.manifest.entries[0].sha256 += '\n'; }],
  ['row digest', f => { f.catalog.tables[12].row_hashes_sha256 = 'a'.repeat(64); }], ['row bytes', f => { f.catalog.tables[12].bytes--; }],
  ['missing tuple', f => { f.media.pop(); }], ['tuple key', f => { f.media[0].key = 'a'.repeat(64); }], ['tuple extra', f => { f.media[0].extra = SECRET; }],
  ['tuple order', f => { f.media.reverse(); }], ['tuple duplicate', f => { f.media.push(f.media.at(-1)); }],
  ['tuple content type', f => { f.media[0].content_type = 'text/html'; }], ['tuple hash', f => { f.media[0].sha256 = 'a'.repeat(64); f.manifest.entries.find(e => e.path === mediaPath(f.media[0])).sha256 = 'a'.repeat(64); }],
  ['magic mismatch', f => { f.media[0].content_type = f.media[0].content_type === 'image/png' ? 'image/jpeg' : 'image/png'; }],
  ['last media corrupt', (f, h) => h.contents.set(mediaPath(f.media.at(-1)), bytesOf('not media'))],
  ['file truncated', (f, h) => { const path = mediaPath(f.media[0]); h.contents.set(path, h.contents.get(path).subarray(0, -1)); }],
  ['tuple bytes0', f => { f.media[0].bytes = 0; }], ['file50MiB overflow', f => { f.media[0].bytes = 52428801; }],
  ['3001 files', f => { f.media = Array(3001).fill(f.media[0]); }], ['duplicate paths', (_f, h) => { h.paths = [...h.contents.keys(), ...h.contents.keys()].slice(0, h.contents.size); h.paths[1] = h.paths[0]; }],
];
for (const [label, mutate] of bundleMutations) test(`complete preflight: ${label} blocks before ANY record/media write`, async () => {
  const f = fixture(), h = harness(f); mutate(f, h);
  await assert.rejects(h.stage(), failed(false)); assert.equal(h.cleanup, 1); assert.equal(h.contents.size, 0); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0);
});
for (const key of TABLES) test(`every table's real bytes/digest verified before writes: ${key}`, async () => {
  const f = fixture(), h = harness(f), path = recordPath(key);
  // Every table has this valid timestamp; some contain no free-text 原文 field.
  const original = h.contents.get(path), changed = bytesOf(f.texts[key].replace(TIME, TIME.replace('12:34', '13:34')));
  assert.equal(changed.length, original.length); assert.notDeepEqual(changed, original);
  assert.notEqual(sha(changed), sha(original)); h.contents.set(path, changed);
  await assert.rejects(h.stage(), failed(false)); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0);
  assert.equal(h.cleanup, 1); assert.equal(h.contents.size, 0);
});
test('strict MP4 ftyp and finite WebM DocType checks reject matching hashes before record writes or uploads', async () => {
  const invalidVideos = [
    ['video/mp4', SAMPLES[5][3].subarray(0, 12)],
    ['video/mp4', SAMPLES[5][3].subarray(0, 20)],
    ['video/mp4', Uint8Array.from([0, 0, 0, 0, ...SAMPLES[5][3].subarray(4)])],
    ['video/mp4', Uint8Array.from([0, 0, 0, 21, ...SAMPLES[5][3].subarray(4)])],
    ['video/mp4', Uint8Array.from([0, 0, 0, 16, ...bytesOf('ftypheic'), 0, 0, 0, 0])],
    ['video/webm', SAMPLES[6][3].subarray(0, 4)],
    ['video/webm', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, ...bytesOf('webm')])],
    ['video/webm', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0xff, ...SAMPLES[6][3].subarray(5)])],
    ['video/webm', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x86, 0x84, ...bytesOf('webm')])],
    ['video/webm', Uint8Array.from([...SAMPLES[6][3].subarray(0, 8), ...bytesOf('xxxx')])],
  ];
  for (const [type, bytes] of invalidVideos) {
    const f = fixture(), file = f.media.find(file => file.content_type === type), path = mediaPath(file);
    Object.assign(file, tuple(file.source_url, bytes, type)); f.contents.set(path, bytes);
    Object.assign(f.manifest.entries.find(entry => entry.path === path), { bytes: bytes.length, sha256: sha(bytes) });
    const h = harness(f); await assert.rejects(h.stage(), failed(false));
    assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
    await assert.rejects(h.session.upload(file, bytes), failed(false)); assert.equal(h.fetches.length, 0);
    const out = harness(f, 'export'); await assert.rejects(out.export(), failed(true));
    assert.equal(out.fetches.at(-1).action, 'download'); assert.equal(out.stored.size, 0); assert.equal(out.cleanup, 1);
  }
});
test('aggregate1GiB/media limits and exact path list checked before opening plaintext', async () => {
  const f = fixture(), h = harness(f);
  f.media = Array.from({ length: 22 }, (_, n) => ({ ...tuple(`${ORIGIN}${PREFIX}chat-images/${n}.jpg`, SAMPLES[0][3], 'image/jpeg'), bytes: 52428800 })).sort(compare);
  await assert.rejects(h.stage(), failed(false)); assert.equal(h.opened.size, 0); assert.equal(h.calls.length, 0);
});

for (const [label, mutate] of [
  ['wrong scope', r => { r.scope = 'employee-verification-media'; }], ['direction', r => { r.direction = 'import'; }], ['full site', r => { r.full_site_complete = true; }],
  ['extra', r => { r.extra = SECRET; }], ['missing ref', r => { r.files.pop(); }], ['wrong key', r => { r.files[0].key = 'a'.repeat(64); }],
  ['wrong bucket', r => { r.files[0].bucket = 'verification-documents'; }], ['path mismatch', r => { r.files[0].path += 'x'; }],
  ['extra ref field', r => { r.files[0].target_url = SECRET; }], ['tuple malformed', r => { r.files[0].file = {}; }],
  ['out of order', r => { r.files.reverse(); }], ['accessor', r => { Object.defineProperty(r.files[0], 'key', { enumerable: true, get() { assert.fail('getter executed'); } }); }],
]) test(`server reference correspondence strictly validates ${label}`, async () => {
  const h = harness(fixture(), 'export');
  h.beforeRpc = name => {
    if (name !== 'get_employee_transfer_notification_media') return;
    const data = { scope: 'site-notifications-media', direction: 'export', files: h.f.media.map(file => ({ key: file.key, source_url: file.source_url,
      bucket: file.source_url.split(PREFIX)[1].split('/')[0], path: file.source_url.split(PREFIX)[1].split('/').slice(1).join('/'), file: null })), full_site_complete: false };
    mutate(data); return { data };
  };
  await assert.rejects(h.export(), failed(false)); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
});
for (const n of [2, 3]) test(`record read ${n} mutation is caught, never uploads or fabricates success`, async () => {
  const h = harness(); h.beforeRead = (path, no) => {
    if (path === recordPath('messages') && no === n) h.contents.set(path, bytesOf(h.f.texts.messages.replace('原文', '篡改')));
  };
  await assert.rejects(h.stage(), failed(n === 3)); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
});
test('second media read rehash catches changes after real records staging and media binding', async () => {
  const h = harness(); h.beforeRpc = name => {
    if (name === 'employee_import_notification_media_bind') { const path = mediaPath(h.f.media[0]), changed = new Uint8Array(h.contents.get(path)); changed[changed.length - 1] ^= 1; h.contents.set(path, changed); }
  };
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.staged.size, 13); assert.ok(h.bound); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
});
for (const phase of ['before', 'after']) test(`${phase} upload: real conflicted preflight is never replaced with local approval`, async () => {
  const h = harness(); h.makePlan = no => ({ ...plan(h.f), conflicts: phase === 'before' || no === 2 ? ['source_admin_unmapped'] : [], plan_hash: 'b'.repeat(64) });
  if (phase === 'before') { await assert.rejects(h.stage(), failed(true)); assert.equal(h.fetches.length, 0); assert.equal(h.bound, null); }
  else { const result = await h.stage(); assert.equal(result.plan.can_restore, false); assert.deepEqual(result.plan.conflicts, ['source_admin_unmapped']); assert.equal(result.plan.plan_hash, 'b'.repeat(64)); }
  assert.equal(h.cleanup, 1);
});

for (const field of ['success', 'key', 'bytes', 'sha256', 'content_type', 'full_site_complete', 'extra']) test(`unconfirmed upload receipt ${field}: no progress/retry/delete`, async () => {
  const h = harness(), progress = [];
  h.afterTransport = async (res, action) => {
    if (action !== 'upload') return res;
    const r = await res.json(); r[field] = field === 'bytes' ? r.bytes + 1 : field === 'full_site_complete' ? true : SECRET;
    return new Response(JSON.stringify(r));
  };
  await assert.rejects(h.stage({ onProgress: p => progress.push(p) }), failed(true));
  assert.equal(h.objects.size, 1); assert.equal(h.fetches.length, 1); assert.equal(progress.some(p => p.phase === 'upload'), false); assert.equal(h.cleanup, 1);
});
for (const field of ['success', 'scope', 'files', 'bytes', 'repeated', 'full_site_complete']) test(`bad media binding receipt ${field} blocks uploads`, async () => {
  const h = harness(); h.beforeRpc = name => {
    if (name !== 'employee_import_notification_media_bind') return;
    const data = { success: true, scope: 'site-notifications-media', files: h.f.media.length, bytes: h.f.media.reduce((n, f) => n + f.bytes, 0), repeated: false, full_site_complete: false };
    data[field] = SECRET; return { data };
  };
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
});
for (const mode of ['http', 'json', 'oversized', 'redirect', 'throw']) test(`Edge ${mode} failure is redacted, leaves already uploaded objects and is never retried`, async () => {
  const h = harness(); h.afterTransport = () => {
    if (mode === 'throw') throw Error(SECRET);
    const response = new Response(mode === 'json' ? SECRET : JSON.stringify({ error: SECRET.repeat(mode === 'oversized' ? 500 : 1) }), { status: mode === 'http' ? 502 : 200 });
    if (mode === 'redirect') Object.defineProperty(response, 'redirected', { value: true }); return response;
  };
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.objects.size, 1); assert.equal(h.fetches.length, 1); assert.equal(h.cleanup, 1);
});
for (const header of ['content-type', 'x-transfer-sha256', 'x-transfer-content-type']) test(`download header ${header} tampering rejects real bytes`, async () => {
  const h = harness(fixture(), 'export'); h.afterTransport = (res, action) => {
    if (action !== 'download') return res;
    const headers = new Headers(res.headers); headers.set(header, header.endsWith('sha256') ? 'a'.repeat(64) : 'text/html'); return new Response(res.body, { headers });
  };
  await assert.rejects(h.export(), failed(true)); assert.equal(h.fetches.length, 1); assert.equal(h.stored.size, 0);
});
test('oversized streamed download is bounded and cancelled, not unbounded arrayBuffer', async () => {
  const h = harness(fixture(), 'export'); let pulls = 0, cancels = 0;
  h.beforeTransport = () => {
    const response = new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(52428801)); }, cancel() { cancels++; } }, { highWaterMark: 0 }),
      { headers: { 'content-type': 'application/octet-stream', 'x-transfer-sha256': h.f.media[0].sha256, 'x-transfer-content-type': h.f.media[0].content_type } });
    response.arrayBuffer = () => assert.fail('unbounded arrayBuffer'); return response;
  };
  await assert.rejects(h.export(), failed(true)); assert.equal(pulls, 1); assert.equal(cancels, 1);
});
test('last source verification happens after all rechecks; old media_pending does not imply full-site completion', async () => {
  const h = harness(fixture(), 'export'); h.beforeRpc = name => {
    if (name === 'employee_export_notifications_verify' && h.verifies === 1) return { error: { message: SECRET } };
  };
  await assert.rejects(h.export(), failed(true)); assert.equal(h.checked.size, 7); assert.equal(h.stored.size, 0); assert.equal(h.cleanup, 1);
});
test('explicit post-restore recheck detects same-size target drift without deletion or false rollback', async () => {
  const h = harness(); await h.stage(); const changed = new Uint8Array(h.objects.get(h.f.media[0].key)); changed[changed.length - 1] ^= 1; h.objects.set(h.f.media[0].key, changed);
  await assert.rejects(h.session.recheckImport(h.f.media), failed(true)); assert.equal(h.checked.size, 0); assert.equal(h.objects.size, 7);
});

for (const operation of ['stage', 'export']) test(`${operation} pre-cancel sends nothing and always discards plaintext`, async () => {
  const h = harness(fixture(), operation === 'export' ? 'export' : 'import'), c = new AbortController(); c.abort(SECRET);
  const run = operation === 'export' ? api.exportNotificationsBundle(h.records.source, h.sink, h.session, { signal: c.signal }) : h.stage({ signal: c.signal });
  await assert.rejects(run, failed(false, true)); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
});
for (const phase of ['record-bind', 'record-stage', 'record-plan', 'upload', 'record-sink', 'media-sink']) test(`pending ${phase}: await settlement before abort cleanup; progress only after confirmation`, async () => {
  const exporting = phase.endsWith('sink'), h = harness(fixture(), exporting ? 'export' : 'import'), gate = deferred(), entered = deferred(), c = new AbortController(), progress = [];
  const wait = async () => { entered.resolve(); await gate.promise; };
  const recordRpc = { 'record-bind': 'employee_import_notifications_bind', 'record-stage': 'employee_import_notifications_stage', 'record-plan': 'get_employee_import_notifications_plan' }[phase];
  if (recordRpc) h.beforeRpc = async name => { if (name === recordRpc) await wait(); };
  if (phase === 'upload') h.afterTransport = async (response, action) => { if (action === 'upload') await wait(); return response; };
  if (exporting) h.beforeAppend = async path => { if (phase === 'media-sink' ? path.startsWith('media/') : path === recordPath(TABLES[0])) await wait(); };
  let finished = false;
  const pending = h[exporting ? 'export' : 'stage']({ signal: c.signal, onProgress: p => progress.push(p) });
  const rejected = assert.rejects(pending, failed(phase !== 'record-sink', true)).finally(() => { finished = true; });
  await entered.promise; c.abort(SECRET); await nextTurn(); assert.equal(finished, false); assert.equal(h.cleanup, 0);
  gate.resolve(); await rejected; assert.equal(h.cleanup, 1); assert.equal(progress.some(p => p.phase === 'upload' || p.phase === 'export'), false);
  const events = h.events.length; await nextTurn(); assert.equal(h.events.length, events);
});
for (const failure of [false, true]) test(`cancel during ${failure ? 'failed' : 'successful'} cleanup retains uncertain server state`, async () => {
  const h = harness(), gate = deferred(), entered = deferred(), c = new AbortController();
  h.beforeAbort = async () => { entered.resolve(); await gate.promise; };
  if (failure) h.beforeTransport = () => { throw Error(SECRET); };
  const pending = h.stage({ signal: c.signal }), rejected = assert.rejects(pending, failed(true, true));
  await entered.promise; c.abort(SECRET); gate.resolve(); await rejected; assert.equal(h.contents.size, 0); assert.equal(h.cleanup, 1);
});
for (const afterWrite of [false, true]) test(`abort failure ${afterWrite ? 'after upload' : 'before writes'} cannot be swallowed`, async () => {
  const f = fixture(), h = harness(f); h.beforeAbort = () => { throw Error(SECRET); };
  if (!afterWrite) h.contents.delete(mediaPath(f.media[0]));
  await assert.rejects(h.stage(), failed(afterWrite, false, true)); assert.equal(h.cleanup, 1); assert.equal(h.objects.size, afterWrite ? 7 : 0);
});
test('export cleanup failure is explicit even before media writes', async () => {
  const h = harness(fixture({ editRow(r, key) { if (key === 'messages') r.content = '<img srcset>'; } }), 'export');
  h.beforeAbort = () => { throw Error(SECRET); };
  await assert.rejects(h.export(), failed(false, false, true)); assert.equal(h.cleanup, 1);
});
test('session remains exclusive until cancelled transport settles; late response body is cancelled', async () => {
  const h = harness(fixture(), 'export'), gate = deferred(), entered = deferred(), c = new AbortController(); let cancelled = 0;
  h.beforeTransport = async () => { entered.resolve(); await gate.promise; return new Response(new ReadableStream({ cancel() { cancelled++; } })); };
  const ref = (await h.session.inventory()).files[0], pending = h.session.download(ref, c.signal), rejected = assert.rejects(pending, failed(true, true));
  await entered.promise; c.abort(SECRET); await assert.rejects(h.session.inventory(), failed(false));
  gate.resolve(); await rejected; assert.equal(cancelled, 1); assert.equal(h.fetches.length, 1);
});
test('unconfirmed second upload reports only the first confirmed progress and preserves first object', async () => {
  const h = harness(), progress = []; h.beforeTransport = action => { if (action === 'upload' && h.fetches.length === 2) throw Error(SECRET); };
  await assert.rejects(h.stage({ onProgress: p => progress.push(p) }), failed(true));
  assert.deepEqual(progress.filter(p => p.phase === 'upload').map(p => p.files), [1]); assert.equal(h.objects.size, 1); assert.equal(h.fetches.length, 2);
});
