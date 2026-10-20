import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TRANSFER_SCOPE_COVERAGE_INVENTORY } from './support/transfer-scope.mjs';

// In-memory bytes and injected RPC/Storage only. Never use environment credentials or real fetch.
const root = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = 'https://chat-fixture.supabase.co', PREFIX = '/storage/v1/object/public/';
const ADMIN = '11111111-1111-4111-8111-111111111111', JOB = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333', PACKAGE = '44444444-4444-4444-8444-444444444444';
const SECRET = 'never-echo-chat-media-or-backend-diagnostics', ANON = 'synthetic-anon';
const TIME = '2024-02-29T12:34:56.123456+00:00', PRECISE = '12345678901234567890.12345678901234567890';
const TABLES = ['simulated_customers', 'cs_message_templates', 'customer_auto_messages', 'rich_card_contents',
  'customer_employee_conversations', 'customer_service_sessions', 'ccc_conversation_annotations',
  'customer_auto_message_logs', 'rating_requests', 'service_ratings'];
const enc = value => new TextEncoder().encode(value), sha = value => createHash('sha256').update(value).digest('hex');
const md5 = value => createHash('md5').update(value).digest('hex');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const recordPath = key => `data/chat-${key}.ndjson`, mediaPath = file => `media/${file.source_url.split(PREFIX)[1]}`;
const rawLines = raw => raw.match(/[^\n]*\n/g) ?? [];
const rowHash = raw => sha(rawLines(raw).map(sha).join(''));
const SAMPLES = [
  ['chat-images', 'nested/image.JPG', 'image/jpeg', Uint8Array.of(255, 216, 255, 1, 2, 3)],
  ['template-images', 'nested/animation.gif', 'image/gif', enc('GIF89a-synthetic')],
  ['announcement-images', 'chat-referenced/file.pdf', 'application/pdf', enc('%PDF-1.7\nsynthetic')],
  ['super-customer-avatars', 'avatars/avatar.png', 'image/png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1)],
  ['chat-images', 'movie.mp4', 'video/mp4', Uint8Array.from([0, 0, 0, 20, ...enc('ftypisom'), 0, 0, 0, 0, ...enc('mp42')])],
];
const URLS = SAMPLES.map(([bucket, path]) => ORIGIN + PREFIX + bucket + '/' + path);
const tuple = (url, bytes, type) => ({ key: sha(url), source_url: url, bytes: bytes.length, sha256: sha(bytes), content_type: type });
const pending = { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
const receipt = f => ({ success: true, key: f.key, bytes: f.bytes, sha256: f.sha256, content_type: f.content_type, full_site_complete: false });
function row(key) {
  const columns = TRANSFER_SCOPE_COVERAGE_INVENTORY.find(t => t.schema === 'public' && t.name === key).columns;
  const r = Object.fromEntries(columns.map(c => [c.name, ({ uuid: id(1), text: '原文é é 𠮷', integer: 1, boolean: true,
    'timestamp with time zone': TIME, 'uuid[]': [id(1)], jsonb: { tip_amount: 0, nested: [null, true, '原文'] } })[c.type]]));
  if ('source_type' in r) r.source_type = 'aaa_service';
  if ('content_type' in r) r.content_type = 'rich_card';
  if (key === TABLES[0]) Object.assign(r, { customer_avatar: 'customer-avatar:regular:2', custom_avatar_url: URLS[3], badge_type: 'vip' });
  if (key === TABLES[1]) r.content = `<IMG SRC='${URLS[0]}'><img src="${URLS[1]}"><a href="${URLS[2]}">附件</a>`;
  if (key === TABLES[2]) Object.assign(r, { message_type: 'quick_send', content: `<video src="${URLS[4]}" poster="${URLS[0]}"></video>` });
  if (key === TABLES[3]) Object.assign(r, { html_content: `<p>${SECRET}𠮷 é é</p><img src="${URLS[0]}">`, content_hash: null });
  if (key === TABLES[4]) Object.assign(r, { sender_type: 'customer', message_type: 'rich_card', image_url: URLS[0],
    message_content: `<span style="color:red">原文</span><img src='${URLS[0]}'>`, rating_data_sql_null: false });
  if (key === TABLES[5]) r.status = 'active';
  if (key === TABLES[6]) r.id = `${r.customer_id}:${r.employee_id}`;
  if (key === TABLES[8]) r.status = 'completed';
  return r;
}
function fixture(edit, empty = false) {
  const texts = Object.fromEntries(TABLES.map(key => {
    const r = row(key); edit?.(r, key);
    if (key === TABLES[3]) r.content_hash = md5(r.html_content);
    return [key, empty ? '' : JSON.stringify(r).replace('"tip_amount":0', `"tip_amount":${PRECISE}`) + '\n'];
  }));
  const identity = { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE, processing_orders: 0, full_site_complete: false,
    tables: ['accounts', 'credentials', 'orders'].map((key, i) => ({ key, rows: i === 0 ? 1 : 0, bytes: i === 0 ? 500 : 0, row_hashes_sha256: sha('') })) };
  const catalog = { version: 1, scope: 'site-chat', site_id: SITE, package_id: PACKAGE, identity_catalog: identity,
    finance_catalog: { version: 1, scope: 'employee-finance', site_id: SITE, package_id: PACKAGE, identity_catalog: structuredClone(identity),
      tables: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit']
        .map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })), full_site_complete: false },
    tables: TABLES.map(key => ({ key, rows: rawLines(texts[key]).length, bytes: enc(texts[key]).length, row_hashes_sha256: rowHash(texts[key]) })), full_site_complete: false };
  const files = empty ? [] : SAMPLES.map(([, , type, bytes], i) => tuple(URLS[i], bytes, type)).sort((a, b) => a.key < b.key ? -1 : 1);
  const contents = new Map([...TABLES.map(key => [recordPath(key), enc(texts[key])]), ...files.map(f => [mediaPath(f), SAMPLES[URLS.indexOf(f.source_url)][3].slice()])]);
  return { texts, catalog, contents, media: { version: 1, scope: 'site-chat-media', chat_catalog: catalog, files, full_site_complete: false },
    manifest: { version: 1, scope: 'replacement-backup', exportId: PACKAGE, volumeId: 'chat-media-one', sourceSiteId: SITE,
      createdAt: '2026-10-20T00:00:00.000Z', volumeIndex: 1, volumeCount: 1,
      entries: [...contents].map(([path, bytes]) => ({ path, kind: path.startsWith('data/') ? 'ndjson' : 'media', bytes: bytes.length, sha256: sha(bytes) })) } };
}
const plan = f => ({ scope: 'site-chat', checked: true, can_restore: false, restore_pending: true, media_pending: true,
  counts: Object.fromEntries(f.catalog.tables.map(t => [t.key, t.rows])), employees: 1, roles: [], conflicts: [], plan_hash: 'a'.repeat(64), ...pending });
const noNetwork = mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
const logs = ['log', 'warn', 'error', 'info', 'debug', 'trace'].map(k => mock.method(console, k, () => {}));
const unhandled = [], onUnhandled = e => unhandled.push(e); process.on('unhandledRejection', onUnhandled);
after(async () => { await nextTurn(); assert.equal(noNetwork.mock.callCount(), 0); for (const l of logs) assert.equal(l.mock.callCount(), 0);
  assert.deepEqual(unhandled, []); process.off('unhandledRejection', onUnhandled); mock.restoreAll(); });
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/chatMedia.ts';
  export * from './src/lib/employeeTransfer/container.ts'; export {createEmployeeTransferMediaHandler} from './supabase/functions/employee-transfer-media/handler.ts';
  export {setHarness} from 'chat-media:state';`, resolveDir: root, loader: 'js' }, bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(ORIGIN), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(ANON) },
  plugins: [{ name: 'offline', setup(b) {
    b.onResolve({ filter: /^(chat-media:state|\.\.\/(auth|supabase))$/ }, a => ({ path: a.path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === 'chat-media:state' ? 'let h;export const setHarness=v=>h=v;export const current=()=>h;'
      : path === '../auth' ? `import {current} from 'chat-media:state';export const getAdminFinancialSessionToken=()=>current().admin;`
        : `import {current} from 'chat-media:state';export const supabase={rpc:(...a)=>current().rpc(...a)};` }));
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness(f = fixture(), direction = 'import') {
  const h = { f, direction, admin: ADMIN, bound: null, contents: new Map(f.contents), objects: new Map(), stored: new Map(), staged: new Map(),
    calls: [], edgeCalls: [], fetches: [], opens: new Map(), cleanup: 0, generation: '0', checked: new Map(), verifies: 0 };
  const refs = () => f.media.files.map(file => ({ key: file.key, source_url: file.source_url, bucket: file.source_url.split('/')[7],
    path: file.source_url.split(PREFIX)[1].split('/').slice(1).join('/'),
    avatar: file.source_url.split('/')[7] === 'super-customer-avatars' || rawLines(f.texts[TABLES[0]]).some(line => {
      const role = JSON.parse(line); return role.custom_avatar_url === file.source_url || role.customer_avatar === file.source_url;
    }), file: h.bound?.find(x => x.key === file.key) ?? null }));
  const runRpc = async (name, args) => {
    h.calls.push({ name, args: structuredClone(args) });
    if (h.beforeRpc) { const r = await h.beforeRpc(name, args); if (r) return r; }
    assert.equal(args.p_admin_session_token, h.admin); assert.equal(args.p_job_token, JOB);
    if (name === 'get_employee_transfer_chat_media') return { data: { version: 1, scope: 'site-chat-media', direction, chat_catalog: f.catalog, files: refs(), full_site_complete: false } };
    assert.equal(name, 'employee_import_chat_media_bind'); h.bound = structuredClone(args.p_files);
    return { data: { success: true, version: 1, scope: 'site-chat-media', files: h.bound.length, bytes: h.bound.reduce((n, f) => n + f.bytes, 0), repeated: false, full_site_complete: false } };
  };
  h.rpc = (name, args) => {
    const query = { abortSignal() { return query; }, then(yes, no) { return runRpc(name, args).then(yes, no); } };
    return query;
  };
  const edge = api.createEmployeeTransferMediaHandler({ supabaseUrl: ORIGIN, crypto: webcrypto,
    rpc: async (name, args) => {
      h.edgeCalls.push({ name, args: structuredClone(args) });
      if (h.beforeEdge) { const r = await h.beforeEdge(name, args); if (r) return r; }
      const file = f.media.files.find(f => f.key === args.p_object_key); assert.ok(file);
      if (name === 'employee_transfer_chat_media_authorize') {
        const ref = refs().find(r => r.key === file.key), exporting = args.p_action === 'download' || args.p_action === 'recheck-export';
        return { data: { direction: exporting ? 'export' : 'import', key: file.key, bucket: ref.bucket,
          path: exporting ? ref.path : `${ref.bucket === 'super-customer-avatars' ? 'avatars' : ADMIN}/transfer-${sha(`${JOB}:${file.key}`).slice(0, 32)}.${ref.path.split('.').at(-1).toLowerCase()}`,
          source_url: file.source_url, avatar: ref.avatar, file: exporting && args.p_action === 'download' ? null : file, generation: exporting ? '0' : h.generation } };
      }
      assert.equal(name, 'employee_transfer_chat_media_commit');
      if (args.p_generation !== h.generation) return { error: Error(SECRET) };
      if (args.p_action.startsWith('recheck-')) h.checked.set(file.key, args.p_generation);
      return { data: receipt(file) };
    }, store: {
      async upload(bucket, path, bytes, options) {
        assert.deepEqual(options, { upsert: false, contentType: f.media.files.find(f => f.sha256 === sha(bytes)).content_type });
        h.edgeCalls.push({ name: 'upload', bucket, path });
        if (h.beforeUpload) await h.beforeUpload();
        const key = bucket + '/' + path;
        if (h.objects.has(key)) return { error: { statusCode: '409' } };
        h.objects.set(key, bytes.slice()); return { data: {} };
      },
      async download(bucket, path, signal) {
        h.edgeCalls.push({ name: 'readback', bucket, path });
        if (h.beforeReadback) { const r = await h.beforeReadback(bucket, path, signal); if (r) return r; }
        const bytes = direction === 'export' ? f.contents.get('media/' + bucket + '/' + path) : h.objects.get(bucket + '/' + path);
        return { data: bytes ? new Response(bytes) : new Response('', { status: 404 }) };
      },
    } });
  h.transport = async (url, init) => {
    assert.equal(url, ORIGIN + '/functions/v1/employee-transfer-media'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    const headers = new Headers(init.headers); assert.equal(headers.get('x-transfer-scope'), 'chat'); assert.equal(headers.get('apikey'), ANON);
    assert.equal(headers.get('x-admin-session-token'), h.admin); assert.ok(!Object.values(init.headers).some(v => String(v).includes('service-role')));
    h.fetches.push(headers.get('x-transfer-action'));
    return edge(new Request(url, { ...init, duplex: 'half' }));
  };
  h.source = { async catalog() { return f.catalog; }, async page(key) { const raw = f.texts[key]; return { table_key: key, count: rawLines(raw).length, ndjson: raw, next_after: null, sha256: sha(raw) }; },
    async verify() { h.verifies++; return { verified: true, scope: 'site-chat', media_pending: true, full_site_complete: false }; } };
  h.target = {
    async bind(c) { assert.deepEqual(c, f.catalog); h.recordBound = true; },
    async stage(key, no, raw) { if (h.beforeStage) await h.beforeStage(key); assert.equal(raw, f.texts[key]); h.staged.set(key, raw);
      return { success: true, rows: rawLines(raw).length, bytes: enc(raw).length, sha256: sha(raw), repeated: false }; },
    async plan() { return h.makePlan ? h.makePlan() : plan(f); },
  };
  // stageChatImport validates its bind receipt, not just the caller's promise.
  h.target.bind = async c => { assert.deepEqual(c, f.catalog); h.recordBound = true; return { success: true, scope: 'site-chat', repeated: false, media_pending: true, full_site_complete: false }; };
  h.files = { paths: () => [...h.contents.keys()], open(path) {
    const n = (h.opens.get(path) ?? 0) + 1; h.opens.set(path, n);
    return (async function* () { if (h.beforeOpen) await h.beforeOpen(path, n); const raw = h.contents.get(path); assert.ok(raw);
      for (let at = 0; at < raw.length; at += 97) yield raw.slice(at, at + 97); })();
  }, async abort() { h.cleanup++; if (h.beforeCleanup) await h.beforeCleanup(); h.contents.clear(); } };
  h.sink = { async append(path, bytes) { if (h.beforeAppend) await h.beforeAppend(path); h.stored.set(path, bytes.slice()); }, async abort() { h.cleanup++; h.stored.clear(); } };
  api.setHarness(h); h.media = api.createChatMediaSession(JOB, direction, h.transport);
  h.stage = options => api.stageChatBundle({ catalog: f.catalog, media: f.media, manifest: f.manifest }, h.files, h.target, h.media, options);
  h.export = options => api.exportChatBundle(h.source, h.sink, h.media, options);
  return h;
}
const redacted = error => { assert.ok(error instanceof Error); for (const text of [SECRET, ADMIN, JOB, URLS[0], ANON]) assert.ok(!String(error).includes(text)); return true; };
const failed = (mayExist, cancelled = false, cleanup = false) => e => redacted(e) && e.serverStagingOrUploadsMayExist === mayExist && e.cancelled === cancelled && e.cleanupRequired === cleanup;
function defer() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
async function* chunks(raw) { for (let at = 0; at < raw.length; at += 113) yield raw.subarray(at, at + 113); }
async function collect(input) { const out = []; for await (const bytes of input) out.push(Buffer.from(bytes)); return Buffer.concat(out); }

test('real container EOF + chat client + real Edge readback: all ten original tables and four referenced buckets', async () => {
  const f = fixture(), out = harness(f, 'export'), exported = await out.export();
  assert.deepEqual(exported.media, f.media); assert.deepEqual(exported.entries, f.manifest.entries); assert.equal(out.verifies, 2);
  for (const [path, raw] of f.contents) assert.deepEqual(out.stored.get(path), raw);
  const info = { ...f.manifest }; delete info.version; delete info.entries;
  const entries = async function* () { for (const [path, raw] of out.stored) yield { path, bytes: raw.length, open: () => chunks(raw) }; };
  const cipher = await collect(api.writeEncryptedVolume(entries(), info, 'synthetic-passphrase', { chunkSize: 127 }));
  const into = harness(f), quarantine = new Map(); let authenticated = false;
  const manifest = await api.verifyEncryptedVolume(chunks(cipher), 'synthetic-passphrase', {
    async append(path, bytes) { quarantine.set(path, Buffer.concat([quarantine.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)])); }, async abort() { quarantine.clear(); },
  }, { expectedMetadata: { exportId: PACKAGE, volumeId: info.volumeId } });
  authenticated = true; into.contents = quarantine; into.beforeOpen = () => assert.equal(authenticated, true);
  const result = await api.stageChatBundle({ catalog: f.catalog, media: exported.media, manifest }, into.files, into.target, into.media);
  assert.equal(result.files, 5); assert.equal(result.rows, 10); assert.equal(result.fullSiteComplete, false); assert.equal(result.plan.can_restore, false);
  assert.equal(result.plan.media_pending, true); assert.equal(into.cleanup, 1); assert.equal(quarantine.size, 0);
  for (const key of TABLES) assert.equal(into.staged.get(key), f.texts[key]);
  for (const file of f.media.files) assert.equal(into.opens.get(mediaPath(file)), 2, 'second hash before upload');
  assert.equal(into.objects.size, 5); assert.ok([...into.objects.keys()].some(p => p.startsWith('super-customer-avatars/avatars/transfer-')));
  assert.deepEqual(into.fetches, Array(5).fill('upload')); into.generation = '9007199254740993'; await into.media.recheckImport(f.media.files);
  assert.deepEqual([...into.checked.values()], Array(5).fill(into.generation));
  assert.equal(into.staged.get(TABLES[0]).includes('customer-avatar:regular:2'), true);
  const original = JSON.parse(into.staged.get(TABLES[3])); assert.equal(original.content_hash, md5(original.html_content));
  await out.sink.abort();
});
for (const damage of ['truncated', 'tampered']) test(`container ${damage} cannot stage before complete EOF authentication`, async () => {
  const f = fixture(), h = harness(f), info = { ...f.manifest }; delete info.version; delete info.entries;
  const entries = async function* () { for (const [path, raw] of f.contents) yield { path, bytes: raw.length, open: () => chunks(raw) }; };
  let raw = await collect(api.writeEncryptedVolume(entries(), info, 'synthetic-passphrase'));
  if (damage === 'truncated') raw = raw.subarray(0, -1); else raw[raw.length - 10] ^= 1;
  const quarantine = new Map();
  await assert.rejects(api.verifyEncryptedVolume(chunks(raw), 'synthetic-passphrase', { async append(p, b) { quarantine.set(p, b); }, async abort() { quarantine.clear(); } }, { expectedMetadata: { exportId: PACKAGE, volumeId: info.volumeId } }));
  assert.equal(quarantine.size, 0); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0);
});
test('real customer_avatar Storage URL is included; virtual VIP key is not a media object', async () => {
  for (const avatar of [URLS[3], URLS[0], 'customer-avatar:vip:31']) {
    const f = fixture((r, key) => { if (key === TABLES[0]) r.customer_avatar = avatar; }), h = harness(f);
    const result = await h.stage(); assert.equal(result.files, 5); assert.ok(h.staged.get(TABLES[0]).includes(avatar));
  }
});
test('role avatar in a non-avatar bucket still rejects PDF before any server write', async () => {
  const h = harness(fixture((r, key) => { if (key === TABLES[0]) r.customer_avatar = URLS[2]; }));
  await assert.rejects(h.stage(), failed(false)); assert.equal(h.calls.length, 0);
});
test('empty records/media still stage every table and bind the empty versioned catalog', async () => {
  const h = harness(fixture(null, true)); const result = await h.stage(); assert.equal(result.files, 0); assert.equal(h.staged.size, 10); assert.deepEqual(h.bound, []); assert.equal(h.fetches.length, 0);
});
const unsafe = ['<img src="https://evil.invalid/x.jpg">', '<img src="data:image/png;base64,AA">', '<img src="blob:x">',
  `<img src=${URLS[0]}>`, `<img srcset="${URLS[0]} 1x">`, '<!-- comment -->', '<script>x</script>', '<img src="unterminated>',
  '<p style="background:u&#114;l(x)">x</p>', `<p style="background:url(${URLS[0]})">x</p>`,
  `<a href="${URLS[2].replace('https:', 'https&colon;')}">x</a>`, URLS[0] + '%20', URLS[0] + '?token=x', URLS[0] + '#x',
  URLS[0].replace('/public/', '/sign/'), URLS[0].replace('/nested/', '/%2f/'), URLS[0].replace('https:', 'https%3A'),
  URLS[0].replace('.supabase.co', '.supabase.co.evil.invalid')];
for (const [i, content] of unsafe.entries()) test(`unsupported HTML/encoded media ${i} blocks before server writes`, async () => {
  const f = fixture((r, key) => { if (key === TABLES[1]) r.content = content; }), h = harness(f);
  await assert.rejects(h.stage(), failed(false)); assert.equal(h.calls.length, 0); assert.equal(h.recordBound, undefined); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
  const out = harness(f, 'export'); await assert.rejects(out.export(), failed(false)); assert.equal(out.fetches.length, 0);
});
for (const value of ['https://evil.invalid/avatar.jpg', 'customer-avatar:regular:2\n', '', URLS[3].replace('/avatars/', '/other/'), URLS[3] + '?token=x']) {
  test(`unknown avatar ${JSON.stringify(value)} fails closed`, async () => {
    const h = harness(fixture((r, key) => { if (key === TABLES[0]) r.customer_avatar = value; }));
    await assert.rejects(h.stage(), failed(false)); assert.equal(h.calls.length, 0);
  });
}
for (const comment of ['100% satisfied', '服務:很好', 'good data',
  'https://docs.invalid/guide?note=100%25 https://unreferenced-fixture.supabase.co/storage/v1/object/public/chat-images/comment-only.png']) {
  test(`rating comment is plain text and retains original bytes/digests: ${JSON.stringify(comment)}`, async () => {
    const f = fixture((r, key) => { if (key === TABLES[4]) r.rating_data = { ...r.rating_data, comment }; });
    const raw = f.texts[TABLES[4]], out = harness(f, 'export'), exported = await out.export();
    assert.deepEqual(out.stored.get(recordPath(TABLES[4])), enc(raw));
    assert.equal(exported.entries.find(e => e.path === recordPath(TABLES[4])).sha256, sha(raw));
    assert.deepEqual(exported.catalog, f.catalog); assert.deepEqual(exported.media.files, f.media.files);
    assert.equal(exported.media.files.length, 5, 'URLs inside a comment are not additional media objects');
    const into = harness(f), result = await into.stage();
    assert.equal(into.staged.get(TABLES[4]), raw, 'no comment normalization or rating JSON reserialization');
    assert.equal(JSON.parse(into.staged.get(TABLES[4])).rating_data.comment, comment);
    assert.ok(into.staged.get(TABLES[4]).includes(PRECISE), 'neighboring numeric lexemes remain exact');
    assert.equal(result.files, 5); assert.equal(into.cleanup, 1); await out.sink.abort();
  });
}
for (const value of [{ nested: [{ url: URLS[0] }] }, { note: URLS[0] }, { note: 'folder/photo.png' }, { note: 'https%3A%2F%2Fx' },
  { image: null }, { note: '<img src=x>' }, { note: 'photo.jpg' },
  { comment: '100% satisfied', media_url: URLS[0] }, { comment: '服務:很好', unknown: URLS[0] },
  { comment: { nested: [{ media_url: URLS[0] }] } }, { comment: [URLS[0]] },
  { comment: [{ comment: 'good data', unknown: URLS[0] }] }, { Comment: URLS[0] },
]) test('rating JSON suspected file reference is rejected, never omitted or reserialized', async () => {
  const f = fixture((r, key) => { if (key === TABLES[4]) r.rating_data = value; }), h = harness(f);
  await assert.rejects(h.stage(), failed(false)); assert.equal(h.recordBound, undefined); assert.equal(h.fetches.length, 0);
  const out = harness(f, 'export'); await assert.rejects(out.export(), failed(false));
  assert.equal(out.fetches.length, 0); assert.equal(out.stored.size, 0); assert.equal(out.cleanup, 1);
});
const mutations = [
  ['missing file', (f, h) => h.contents.delete(mediaPath(f.media.files[0]))],
  ['extra file', (_f, h) => h.contents.set('media/chat-images/extra.png', enc('x'))],
  ['missing tuple', f => f.media.files.pop()], ['unordered tuple', f => f.media.files.reverse()],
  ['wrong version', f => { f.media.version = 2; }], ['wrong scope', f => { f.media.scope = 'site-notifications-media'; }],
  ['hash', f => { f.media.files[0].sha256 = 'a'.repeat(64); }], ['MIME', f => { f.media.files[0].content_type = 'image/webp'; }],
  ['size', f => { f.media.files[0].bytes++; }], ['50MiB overflow', f => { f.media.files[0].bytes = 52428801; }],
  ['avatar5MiB overflow', f => { f.media.files.find(f => f.source_url === URLS[3]).bytes = 5242881; }],
  ['avatar PDF', f => { f.media.files.find(f => f.source_url === URLS[3]).content_type = 'application/pdf'; }],
  ['record hash', f => { f.catalog.tables.at(-1).row_hashes_sha256 = 'a'.repeat(64); }],
  ['manifest bytes', f => { f.manifest.entries.at(-1).bytes++; }], ['manifest SHA', f => { f.manifest.entries[0].sha256 = 'a'.repeat(64); }],
  ['cross-package', f => { f.manifest.exportId = JOB; }], ['3001 files', f => { f.media.files = Array(3001).fill(f.media.files[0]); }],
  ['corrupt bytes', (f, h) => h.contents.set(mediaPath(f.media.files.at(-1)), enc('corrupt'))],
];
for (const [name, change] of mutations) test(`${name}: full validation before bind/stage/upload`, async () => {
  const f = fixture(), h = harness(f); change(f, h); await assert.rejects(h.stage(), failed(false));
  assert.equal(h.recordBound, undefined); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
});
test('records plus media 1GiB limit is checked before scanning or writes', async () => {
  const f = fixture(); f.catalog.tables[0].bytes = 536870912; f.catalog.tables[1].bytes = 536870912;
  assert.throws(() => api.validateChatMediaCatalog(f.media));
});
test('fresh admin session is read per request; no stale token captured', async () => {
  const h = harness(); h.admin = id(99); await h.stage(); assert.ok(h.calls.every(c => c.args.p_admin_session_token === id(99)));
});
test('session inventory rejects catalog drift between confirmed reads', async () => {
  const h = harness(); await h.media.inventory();
  h.beforeRpc = () => { const catalog = structuredClone(h.f.catalog); catalog.tables[0].row_hashes_sha256 = 'a'.repeat(64);
    return { data: { version: 1, scope: 'site-chat-media', direction: 'import', chat_catalog: catalog, files: [], full_site_complete: false } }; };
  await assert.rejects(h.media.inventory(), failed(false)); assert.equal(h.fetches.length, 0);
});
test('source inventory omissions reject before uploads', async () => {
  const h = harness(); h.beforeRpc = name => name === 'get_employee_transfer_chat_media' ? { data: { version: 1, scope: 'site-chat-media', direction: 'import', chat_catalog: h.f.catalog, files: [], full_site_complete: false } } : null;
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.fetches.length, 0);
});
test('conflicting preflight never uploads or claims restored', async () => {
  const h = harness(); h.makePlan = () => ({ ...plan(h.f), conflicts: ['rich_card_unresolvable'] });
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.fetches.length, 0);
});
test('changed second-read media is rejected before upload with staging warning', async () => {
  const h = harness(); h.beforeOpen = (path, n) => { if (path.startsWith('media/') && n === 2) h.contents.set(path, enc('changed')); };
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.fetches.length, 0);
});
test('actual readback failure leaves uploaded object, no receipt/rollback/delete/retry', async () => {
  const h = harness(); h.beforeReadback = () => ({ data: new Response('', { status: 404 }) });
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.objects.size, 1); assert.equal(h.fetches.length, 1);
  assert.ok(!h.edgeCalls.some(c => c.name === 'employee_transfer_chat_media_commit'));
});
test('generation captured before readback cannot be refreshed at commit', async () => {
  const h = harness(); h.beforeReadback = () => { h.generation = '1'; };
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.objects.size, 1);
  assert.equal(h.edgeCalls.find(c => c.name === 'employee_transfer_chat_media_commit').args.p_generation, '0');
});
test('pre-cancel is clean; cancellation during pending stage waits before cleanup and warns staging may exist', async () => {
  const before = harness(), pre = new AbortController(); pre.abort(); await assert.rejects(before.stage({ signal: pre.signal }), failed(false, true)); assert.equal(before.calls.length, 0);
  const h = harness(), started = defer(), release = defer(), controller = new AbortController();
  h.beforeStage = async () => { started.resolve(); await release.promise; };
  const pending = h.stage({ signal: controller.signal }); await started.promise; controller.abort(); await nextTurn(); assert.equal(h.cleanup, 0);
  release.resolve(); await assert.rejects(pending, failed(true, true)); assert.equal(h.cleanup, 1); assert.equal(h.fetches.length, 0);
});
test('cancellation during SDK upload waits for uncertain object without deleting or committing it', async () => {
  const h = harness(), started = defer(), release = defer(), controller = new AbortController();
  h.beforeUpload = async () => { started.resolve(); await release.promise; };
  const pending = h.stage({ signal: controller.signal }); await started.promise; controller.abort(); await nextTurn(); assert.equal(h.cleanup, 0);
  release.resolve(); await assert.rejects(pending, failed(true, true)); assert.equal(h.objects.size, 1);
  assert.ok(!h.edgeCalls.some(c => c.name === 'employee_transfer_chat_media_commit')); assert.equal(h.cleanup, 1);
});
test('cleanup failure and cancellation during cleanup remain explicit, even after uploads', async () => {
  const h = harness(); h.beforeCleanup = () => { throw Error(SECRET); }; await assert.rejects(h.stage(), failed(true, false, true));
  const g = harness(), controller = new AbortController(); g.beforeCleanup = () => controller.abort();
  await assert.rejects(g.stage({ signal: controller.signal }), failed(true, true));
});
