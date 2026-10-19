import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Entirely synthetic: no credentials, real Storage, SQL execution or network.
const root = fileURLToPath(new globalThis.URL('../../', import.meta.url));
const entry = `${root}supabase/functions/employee-transfer-media/`;
const SOURCE = 'https://source-fixture.supabase.co';
const TARGET = 'https://target-fixture.supabase.co';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const SECRET = 'never-echo-raw-notification-diagnostics';
const BUCKETS = ['announcement-images', 'chat-images', 'template-images'];
const AUTH = 'employee_transfer_notification_media_authorize';
const COMMIT = 'employee_transfer_notification_media_commit';
const V_AUTH = 'employee_transfer_verification_media_authorize';
const V_COMMIT = 'employee_transfer_verification_media_commit';
const ACTIONS = ['download', 'recheck-export', 'upload', 'recheck-import'];
const enc = text => new TextEncoder().encode(text);
const sha = value => createHash('sha256').update(value).digest('hex');
const prefix = bucket => `/storage/v1/object/public/${bucket}/`;
const importing = action => action === 'upload' || action === 'recheck-import';
const JPEG = Uint8Array.of(255, 216, 255, 224, 0, 3, 9, 255, 217);
const mp4 = (brand = 'isom', compatible = 'mp42') => Uint8Array.from([0, 0, 0, 20, ...enc('ftyp' + brand), 0, 0, 0, 0, ...enc(compatible)]);
const MP4 = mp4();
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...enc('webm')]);
const SAMPLES = [
  ['image/jpeg', JPEG],
  ['image/png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 1)],
  ['image/gif', enc('GIF87a-synthetic')], ['image/gif', enc('GIF89a-synthetic')],
  ['image/webp', Uint8Array.from([...enc('RIFF'), 0, 0, 0, 0, ...enc('WEBP-synthetic')])],
  ['application/pdf', enc('%PDF-1.7\nsynthetic')],
  ['video/mp4', MP4], ['video/mp4', mp4('zzzz', 'avc1')], ['video/webm', WEBM],
  ['video/webm', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x8b, 0x42, 0x86, 0x81, 1, 0x42, 0x82, 0x84, ...enc('webm')])],
];
const rawError = extra => ({ message: `${SECRET} ${ADMIN} ${JOB}`, details: SECRET, ...extra });
void mock.timers;
await nextTurn();
const logs = ['log', 'info', 'warn', 'error', 'debug', 'trace'].map(name => mock.method(console, name, () => {}));
const denyFetch = () => assert.fail('Real network/Storage access forbidden');
mock.method(globalThis, 'fetch', denyFetch);
let fakeFetches = 0;
const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);
after(async () => {
  await nextTurn();
  for (const log of logs) assert.equal(log.mock.callCount(), 0, 'no raw diagnostics logged');
  assert.equal(globalThis.fetch.mock.callCount(), fakeFetches, 'only injected fake fetch calls');
  assert.deepEqual(unhandled, []);
  process.off('unhandledRejection', onUnhandled);
  mock.restoreAll();
});
const built = await build({ entryPoints: [`${entry}handler.ts`], bundle: true, write: false, platform: 'browser', format: 'esm' });
const { createEmployeeTransferMediaHandler: factory, MAX_MEDIA_BYTES, MEDIA_DOWNLOAD_TIMEOUT_MS } =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const tuple = (ctx, bytes = JPEG, type = 'image/jpeg') => ({ key: ctx.key, source_url: ctx.source_url,
  bytes: bytes.length, sha256: sha(bytes), content_type: type });
const receipt = file => ({ success: true, key: file.key, bytes: file.bytes, sha256: file.sha256,
  content_type: file.content_type, full_site_complete: false });
function harness({ action = 'download', bucket = BUCKETS[0], bytes = JPEG, type = 'image/jpeg', scope = 'notifications',
  sourcePath = 'nested/source-file.JPG', origin } = {}) {
  const verification = scope === 'verification';
  if (verification) { bucket = 'verification-documents'; sourcePath = `id-front/${USER}-source.jpg`; }
  const source = SOURCE + prefix(bucket) + sourcePath;
  const target = verification ? `id-front/${USER}-transfer-${'a'.repeat(32)}.jpg` : `${ADMIN}/transfer-${'a'.repeat(32)}.${sourcePath.split('.').at(-1).toLowerCase()}`;
  const ctx = { direction: importing(action) ? 'import' : 'export', key: sha(source), bucket,
    path: importing(action) ? target : sourcePath, source_url: source, file: null, generation: importing(action) ? '12' : 'export' };
  if (action !== 'download') ctx.file = tuple(ctx, bytes, type);
  const h = { ctx, action, scope, bytes, calls: [], objects: new Map(), authorize: null, commit: null, read: null, write: null };
  const location = (b, p) => `${b}/${p}`;
  if (action !== 'upload') h.objects.set(location(bucket, ctx.path), bytes);
  h.rpc = async (name, args) => {
    h.calls.push({ op: name, args: structuredClone(args) });
    if (name.endsWith('_authorize')) return h.authorize ? h.authorize(args) : { data: structuredClone(h.ctx), error: null };
    if (h.commit) return h.commit(args);
    return { data: receipt({ key: args.p_object_key, bytes: args.p_bytes, sha256: args.p_sha256, content_type: args.p_content_type }), error: null };
  };
  h.store = {
    async download(b, p, signal) {
      h.calls.push({ op: 'download', bucket: b, path: p, signal });
      if (h.read) return h.read(b, p, signal);
      const data = h.objects.get(location(b, p));
      return { data: data ? new Response(data, { headers: { 'content-type': 'text/html' } }) : new Response(SECRET, { status: 404 }), error: null };
    },
    async upload(b, p, data, options) {
      h.calls.push({ op: 'upload', bucket: b, path: p, bytes: data.length, options: { ...options } });
      if (h.write) return h.write(b, p, data, options);
      if (h.objects.has(location(b, p))) return { error: rawError({ statusCode: '409', status: 400 }) };
      h.objects.set(location(b, p), data.slice());
      return { data: { path: p }, error: null };
    },
    remove() { h.calls.push({ op: 'remove' }); throw Error(SECRET); },
    update() { h.calls.push({ op: 'update' }); throw Error(SECRET); },
  };
  h.handler = factory({ supabaseUrl: origin ?? (importing(action) ? TARGET : SOURCE), rpc: h.rpc, store: h.store, crypto: webcrypto });
  return h;
}
function request(h, overrides = {}, init = {}) {
  const headers = new Headers({ 'x-transfer-action': h.action, 'x-transfer-scope': h.scope,
    'x-admin-session-token': ADMIN, 'x-transfer-job-token': JOB, 'x-transfer-object-key': h.ctx.key });
  for (const [k, v] of Object.entries(overrides)) v === null ? headers.delete(k) : headers.set(k, v);
  return new Request('https://edge-fixture.invalid/employee-transfer-media?path=ignored', {
    method: 'POST', headers, ...(h.action === 'upload' ? { body: h.bytes, duplex: 'half' } : {}), ...init,
  });
}
const ops = h => h.calls.map(call => call.op);
async function failed(res, status = 502, code = 'TRANSFER_FAILED') {
  assert.equal(res.status, status);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const text = await res.text();
  assert.deepEqual(JSON.parse(text), { success: false, error: code });
  for (const secret of [SECRET, ADMIN, JOB, USER, SOURCE, TARGET]) {
    assert.ok(!text.includes(secret));
    assert.ok(![...res.headers.values()].some(value => value.includes(secret)));
  }
}
function noStorage(h, auth = AUTH) { assert.deepEqual(ops(h), [auth]); }
function defer() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function stream(chunks, cancellation = () => {}) {
  const s = { reads: 0, cancels: 0 };
  s.body = new ReadableStream({
    pull(c) { const item = chunks[s.reads++]; if (item === undefined) c.close(); else c.enqueue(item); },
    cancel() { s.cancels++; return cancellation(); },
  }, { highWaterMark: 0 });
  return s;
}

for (const bucket of BUCKETS) for (const [i, [type, bytes]] of SAMPLES.entries()) for (const action of ACTIONS) {
  test(`notifications ${bucket} ${action} signature ${i}: ${type}`, async () => {
    const h = harness({ bucket, action, bytes, type });
    const res = await h.handler(request(h, { 'content-type': 'application/x-untrusted' }));
    assert.equal(res.status, 200);
    const file = tuple(h.ctx, bytes, type);
    if (action === 'download') {
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
      assert.equal(res.headers.get('x-transfer-content-type'), type);
      assert.equal(res.headers.get('x-transfer-sha256'), sha(bytes));
    } else assert.deepEqual(await res.json(), receipt(file));
    assert.deepEqual(ops(h), action === 'upload' ? [AUTH, 'upload', 'download', COMMIT] : [AUTH, 'download', COMMIT]);
    for (const call of h.calls.filter(c => c.bucket)) { assert.equal(call.bucket, bucket); assert.equal(call.path, h.ctx.path); }
    if (action === 'upload') assert.deepEqual(h.calls[1].options, { upsert: false, contentType: type });
    const args = { p_admin_session_token: ADMIN, p_job_token: JOB, p_action: action, p_object_key: h.ctx.key };
    assert.deepEqual(h.calls[0].args, args);
    assert.deepEqual(h.calls.at(-1).args, { ...args, p_bytes: bytes.length, p_sha256: sha(bytes), p_content_type: type,
      p_storage_origin: importing(action) ? TARGET : SOURCE, p_generation: importing(action) ? '12' : 'export' });
  });
}
for (const scope of ['', 'notification', 'NOTIFICATIONS', 'Verification', 'notifications, verification', 'notifications, notifications', '__proto__', 'constructor', 'verification/notifications']) {
  test(`reject invalid scope ${JSON.stringify(scope)} before RPC`, async () => {
    const h = harness(); await failed(await h.handler(request(h, { 'x-transfer-scope': scope })), 400, 'INVALID_REQUEST');
    assert.deepEqual(h.calls, []);
  });
}
for (const scope of [null, 'verification']) test(`verification routing remains explicit or default (${scope})`, async () => {
  const h = harness({ scope: 'verification' });
  assert.equal((await h.handler(request(h, { 'x-transfer-scope': scope }))).status, 200);
  assert.deepEqual(ops(h), [V_AUTH, 'download', V_COMMIT]);
  assert.equal(h.calls[1].bucket, 'verification-documents');
});
for (const scope of [null, 'verification']) test(`notification context cannot be accepted by ${scope ?? 'default'} verification scope`, async () => {
  const h = harness();
  await failed(await h.handler(request(h, { 'x-transfer-scope': scope }))); noStorage(h, V_AUTH);
});
test('verification context cannot be accepted by notifications scope; no fallback RPC', async () => {
  const h = harness({ scope: 'verification' });
  await failed(await h.handler(request(h, { 'x-transfer-scope': 'notifications' }))); noStorage(h);
});
for (const [type, bytes] of [['video/mp4', MP4], ['video/webm', WEBM]]) for (const action of ACTIONS) {
  test(`verification never admits ${type} for ${action}`, async () => {
    const h = harness({ action, scope: 'verification', bytes, type });
    await failed(await h.handler(request(h)), action === 'download' ? 422 : 502, action === 'download' ? 'INVALID_MEDIA' : 'TRANSFER_FAILED');
    assert.deepEqual(ops(h), action === 'download' ? [V_AUTH, 'download'] : [V_AUTH]);
  });
}
test('CORS explicitly permits scope header and rejects an unlisted selector', async () => {
  const h = harness();
  const res = await h.handler(request(h, { 'access-control-request-method': 'POST',
    'access-control-request-headers': 'X-Transfer-Scope, X-Transfer-Action, X-Admin-Session-Token' }, { method: 'OPTIONS' }));
  assert.equal(res.status, 204); assert.equal(await res.text(), '');
  assert.ok(res.headers.get('access-control-allow-headers').split(', ').includes('x-transfer-scope'));
  await failed(await h.handler(request(h, { 'access-control-request-headers': 'x-transfer-rpc' }, { method: 'OPTIONS' })), 400, 'INVALID_REQUEST');
  assert.deepEqual(h.calls, []);
});
test('untrusted request URL/path/RPC headers cannot select the target or RPC', async () => {
  const h = harness({ action: 'upload', bucket: 'chat-images' });
  assert.equal((await h.handler(request(h, { 'x-transfer-path': '../secret', 'x-transfer-url': 'http://127.0.0.1',
    'x-transfer-rpc': V_AUTH, 'x-transfer-bucket': 'verification-documents' }))).status, 200);
  assert.deepEqual(ops(h), [AUTH, 'upload', 'download', COMMIT]);
  assert.equal(h.calls[1].path, h.ctx.path); assert.equal(h.calls[1].bucket, 'chat-images');
});
for (const action of ACTIONS) test(`${action}: wrong job/scope/expired/cancelled authorization has no fallback or Storage`, async () => {
  const h = harness({ action }); h.authorize = () => ({ data: null, error: rawError({ reason: 'wrong scope or cancelled' }) });
  await failed(await h.handler(request(h)), 403, 'NOT_AUTHORIZED'); noStorage(h);
});

for (const bucket of ['verification-documents', 'avatars', 'content-audit-evidence', 'chat-images/../template-images', 'CHAT-IMAGES', '', null]) {
  test(`notification bucket whitelist rejects ${String(bucket)}`, async () => {
    const h = harness(); h.ctx.bucket = bucket; await failed(await h.handler(request(h))); noStorage(h);
  });
}
for (const action of ACTIONS) test(`${action}: mismatched source/authorized bucket fails before Storage`, async () => {
  const h = harness({ action, bucket: 'chat-images' }); h.ctx.bucket = 'template-images';
  await failed(await h.handler(request(h))); noStorage(h);
});
const malicious = [
  source => source.replace('https:', 'http:'), source => source.replace(SOURCE, 'https://evil.invalid'),
  source => source.replace(SOURCE, SOURCE + '.evil.invalid'), source => source.replace(SOURCE, 'https://user:pass@source-fixture.supabase.co'),
  source => source.replace(SOURCE, SOURCE + ':443'), source => source.replace(SOURCE, 'https://SOURCE-fixture.supabase.co'),
  source => source.replace(SOURCE, 'https://127.0.0.1'), () => 'https://169.254.169.254/latest/meta-data',
  source => source.replace('/public/', '/sign/'), source => source + '?token=' + SECRET, source => source + '#' + SECRET,
  source => source.replace('nested/', 'nested//'), source => source.replace('nested/', 'nested/./'),
  source => source.replace('nested/', 'nested/../'), source => source.replace('source-file', 'source..file'),
  source => source.replace('source-file', '%2e%2e%2fsource-file'), source => source.replace('nested/', 'nested\\'),
  source => source.replace('source-file', 'source%20file'), source => source.replace('source-file', '中文'),
  source => source.replace('source-file', 'source file'), source => source.replace('source-file', 'source+file'),
  source => source.replace('source-file', 'source&file'), source => source.replace('source-file.JPG', 'source-file'),
  source => source.replace('.JPG', '.123456789'), source => source.replace('https://', '//'),
  source => source + '\n', source => source + '\r', source => source + '\0', source => source + '\u2028',
  source => source.replace('/storage/', '\n/storage/'), source => source.replace('/storage/', '\u2028/storage/'),
  source => source.replace('source-file', 'x'.repeat(1024)),
];
for (const [i, change] of malicious.entries()) for (const action of ['download', 'upload']) {
  test(`${action}: reject raw source URL ${i} even with matching key and tuple`, async () => {
    const h = harness({ action }); h.ctx.source_url = change(h.ctx.source_url); h.ctx.key = sha(h.ctx.source_url);
    if (h.ctx.file) h.ctx.file = tuple(h.ctx);
    await failed(await h.handler(request(h))); noStorage(h);
  });
}
test('notification source URL 1024 ASCII bytes is inclusive, 1025 rejected', async () => {
  const base = SOURCE + prefix('chat-images');
  const path = 'a'.repeat(1024 - base.length - 4) + '.jpg';
  const h = harness({ bucket: 'chat-images', sourcePath: path });
  assert.equal(h.ctx.source_url.length, 1024);
  assert.equal((await h.handler(request(h))).status, 200);
  const bad = harness({ bucket: 'chat-images', sourcePath: 'a' + path });
  await failed(await bad.handler(request(bad))); noStorage(bad);
});
for (const action of ['download', 'recheck-export']) test(`${action} must use env site origin, not another valid Supabase site`, async () => {
  const h = harness({ action, origin: TARGET }); await failed(await h.handler(request(h))); noStorage(h);
});
for (const path of [`${ADMIN}/transfer-${'A'.repeat(32)}.jpg`, `${ADMIN}/transfer-${'a'.repeat(31)}.jpg`,
  `${ADMIN}/transfer-${'a'.repeat(33)}.jpg`, `${ADMIN}/transfer-${'a'.repeat(32)}.JPG`, `${ADMIN}/transfer-${'a'.repeat(32)}.png`,
  `${ADMIN}/transfer-${'a'.repeat(32)}.abcdefghi`, `${ADMIN}/other-${'a'.repeat(32)}.jpg`,
  `not-uuid/transfer-${'a'.repeat(32)}.jpg`, `/${ADMIN}/transfer-${'a'.repeat(32)}.jpg`,
  `${ADMIN}/nested/transfer-${'a'.repeat(32)}.jpg`, `${ADMIN}/./transfer-${'a'.repeat(32)}.jpg`,
  `${ADMIN}/transfer-${'a'.repeat(32)}.jpg?token=secret`, `${ADMIN}/transfer-${'a'.repeat(32)}.jpg\n`]) {
  test(`reject non-server notification target form ${JSON.stringify(path)}`, async () => {
    const h = harness({ action: 'upload' }); h.ctx.path = path;
    await failed(await h.handler(request(h))); noStorage(h);
  });
}
for (const change of [ctx => ({ ...ctx, scope: 'notifications' }), ctx => { delete ctx.generation; return ctx; },
  ctx => ({ ...ctx, direction: 'import' }), ctx => ({ ...ctx, key: '0'.repeat(64) }), ctx => ({ ...ctx, path: 'other.jpg' }),
  ctx => ({ ...ctx, generation: 0 }), ctx => ({ ...ctx, generation: '0' }), ctx => ({ ...ctx, generation: 'export\n' }),
  ctx => ({ ...ctx, file: { ...tuple(ctx), extra: SECRET } }), ctx => ({ ...ctx, file: { ...tuple(ctx), content_type: 'video/quicktime' } })]) {
  test('notification authorize retains exact seven-key/hash/path/generation/file contract', async () => {
    const h = harness(); h.ctx = change(h.ctx); await failed(await h.handler(request(h))); noStorage(h);
  });
}
for (const generation of ['0', '500000']) test(`notification import preserves generation ${generation}`, async () => {
  const h = harness({ action: 'upload' }); h.ctx.generation = generation;
  assert.equal((await h.handler(request(h))).status, 200); assert.equal(h.calls.at(-1).args.p_generation, generation);
});
for (const generation of ['-1', '01', '500001', '1\n', 1, null]) test(`reject malformed notification import generation ${JSON.stringify(generation)}`, async () => {
  const h = harness({ action: 'upload' }); h.ctx.generation = generation;
  await failed(await h.handler(request(h))); noStorage(h);
});

const invalidVideo = [
  ['ftyp alone', enc('ftyp')], ['short ftyp', Uint8Array.from([0, 0, 0, 16, ...enc('ftypisom')])],
  ['ftyp wrong offset', Uint8Array.from([...enc('ftyp'), ...MP4])],
  ...[0, 1, 8, 15, 17, 19, 21, 255].map(size => [`illegal ftyp size ${size}`, Uint8Array.from([0, 0, 0, size, ...MP4.subarray(4)])]),
  ['ftyp huge size', Uint8Array.from([255, 255, 255, 255, ...MP4.subarray(4)])],
  ['QuickTime only', mp4('qt  ', 'qt  ')], ['AVIF only', mp4('avif', 'avif')],
  ['EBML only', WEBM.subarray(0, 4)], ['unknown header size', Uint8Array.from([...WEBM.subarray(0, 4), 255, ...WEBM.subarray(5)])],
  ['truncated header', WEBM.subarray(0, WEBM.length - 1)],
  ['wrong doctype', Uint8Array.from([...WEBM.subarray(0, 8), ...enc('xxxxwebm')])],
  ['doctype not an element', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, ...enc('webm')])],
  ['unknown element size', Uint8Array.from([...WEBM.subarray(0, 7), 255, ...enc('webm')])],
  ['duplicate doctype', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x8e, ...WEBM.subarray(5), ...WEBM.subarray(5)])],
  ['zero ID', Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0, 0x82, 0x84, ...enc('webm')])],
  ['missing doctype', Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x86, 0x81, 1)],
  ['HTML', enc('<video>webm ftyp</video>')], ['empty', new Uint8Array()],
];
for (const [name, bytes] of invalidVideo) for (const action of ['download', 'upload']) {
  test(`${action} rejects malformed video signature: ${name}`, async () => {
    const h = harness({ action, bytes, type: name.includes('ftyp') ? 'video/mp4' : 'video/webm' });
    await failed(await h.handler(request(h)), bytes.length === 0 && action === 'upload' ? 502 : 422,
      bytes.length === 0 && action === 'upload' ? 'TRANSFER_FAILED' : 'INVALID_MEDIA');
    assert.ok(!ops(h).includes(COMMIT)); assert.ok(!ops(h).includes('upload'));
  });
}
for (const action of ACTIONS) for (const field of ['bytes', 'sha256', 'content_type']) {
  test(`${action}: video actual ${field} drift blocks write/commit`, async () => {
    const h = harness({ action, bytes: MP4, type: 'video/mp4' }); h.ctx.file = tuple(h.ctx, MP4, 'video/mp4');
    h.ctx.file[field] = { bytes: MP4.length + 1, sha256: 'f'.repeat(64), content_type: 'video/webm' }[field];
    await failed(await h.handler(request(h)), action === 'upload' && field === 'bytes' ? 400 : 422,
      action === 'upload' && field === 'bytes' ? 'INVALID_REQUEST' : 'INVALID_MEDIA');
    assert.ok(!ops(h).includes(COMMIT)); assert.ok(!ops(h).includes('upload'));
  });
}
for (const bucket of BUCKETS) for (const error of [{ statusCode: '409', status: 400 }, { statusCode: 409 }, { status: 409 }]) {
  test(`${bucket}: structured 409 requires identical actual readback before reuse`, async () => {
    const h = harness({ action: 'upload', bucket, bytes: WEBM, type: 'video/webm' });
    const original = WEBM.slice(); h.objects.set(`${bucket}/${h.ctx.path}`, original);
    h.write = () => ({ error: rawError(error) });
    assert.equal((await h.handler(request(h))).status, 200);
    assert.deepEqual(ops(h), [AUTH, 'upload', 'download', COMMIT]);
    assert.equal(h.objects.get(`${bucket}/${h.ctx.path}`), original);
  });
}
for (const action of ['upload', 'recheck-import', 'recheck-export']) for (const drift of ['bytes', 'size', 'type', 'missing']) {
  test(`${action}: actual readback ${drift} drift (including 409) never overwrites/deletes/commits`, async () => {
    const h = harness({ action, bytes: MP4, type: 'video/mp4' });
    const different = MP4.slice(); different[15] ^= 1;
    const original = drift === 'bytes' ? different : drift === 'size' ? MP4.subarray(0, MP4.length - 1) : WEBM;
    h.objects.set(`${h.ctx.bucket}/${h.ctx.path}`, original);
    if (drift === 'missing') h.read = () => ({ data: null, error: rawError() });
    await failed(await h.handler(request(h)), drift === 'missing' ? 502 : 422, drift === 'missing' ? 'TRANSFER_FAILED' : 'INVALID_MEDIA');
    assert.deepEqual(ops(h), action === 'upload' ? [AUTH, 'upload', 'download'] : [AUTH, 'download']);
    assert.equal(h.objects.get(`${h.ctx.bucket}/${h.ctx.path}`), original);
  });
}
test('free-form 409 diagnostic is not an occupied-path proof; no retry/readback', async () => {
  const h = harness({ action: 'upload' }); h.write = () => ({ error: rawError({ status: 400, message: '409 already exists ' + SECRET }) });
  await failed(await h.handler(request(h))); assert.deepEqual(ops(h), [AUTH, 'upload']);
});
for (const action of ACTIONS) test(`${action}: commit cancellation cannot disclose raw diagnostics or claim rollback`, async () => {
  const h = harness({ action }); h.commit = () => ({ error: rawError({ reason: 'task cancelled after read' }) });
  await failed(await h.handler(request(h)));
  assert.deepEqual(ops(h), action === 'upload' ? [AUTH, 'upload', 'download', COMMIT] : [AUTH, 'download', COMMIT]);
  assert.ok(h.objects.has(`${h.ctx.bucket}/${h.ctx.path}`));
});
for (const action of ['upload', 'recheck-import']) test(`${action}: commit binds generation captured BEFORE delayed read, never refreshes`, async () => {
  const h = harness({ action }); const started = defer(); const release = defer();
  h.read = async () => { started.resolve(); await release.promise; return { data: new Response(JPEG) }; };
  h.commit = args => args.p_generation === h.ctx.generation ? { data: receipt(tuple(h.ctx)) } : { error: rawError() };
  const pending = h.handler(request(h)); await started.promise; h.ctx.generation = '13'; release.resolve();
  await failed(await pending);
  assert.equal(h.calls.at(-1).args.p_generation, '12'); assert.equal(ops(h).filter(op => op === AUTH).length, 1);
});
for (const action of ACTIONS) for (const cause of ['deadline', 'abort']) for (const phase of ['headers', 'body']) {
  test(`${action}: ${cause} during ${phase} keeps one 90s header/body deadline`, { timeout: 2000 }, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] }); assert.equal(MEDIA_DOWNLOAD_TIMEOUT_MS, 90_000);
    const h = harness({ action }); const started = defer(); const headers = defer(); const reading = defer();
    const controller = new AbortController(); let cancels = 0;
    h.read = (_b, _p, signal) => {
      started.resolve(signal);
      if (phase === 'headers') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error(SECRET)), { once: true }));
      return headers.promise;
    };
    const body = new ReadableStream({ pull() { reading.resolve(); }, cancel() { cancels++; return new Promise(() => {}); } }, { highWaterMark: 0 });
    const pending = h.handler(request(h, {}, { signal: controller.signal })); const signal = await started.promise;
    t.mock.timers.tick(89_999); assert.equal(signal.aborted, false);
    if (phase === 'body') { headers.resolve({ data: new Response(body) }); await reading.promise; }
    if (cause === 'deadline') t.mock.timers.tick(1); else controller.abort(Error(SECRET));
    await failed(await pending); assert.equal(signal.aborted, true); assert.ok(!String(signal.reason).includes(SECRET));
    assert.equal(cancels, phase === 'body' ? 1 : 0);
    assert.deepEqual(ops(h), action === 'upload' ? [AUTH, 'upload', 'download'] : [AUTH, 'download']);
    if (action === 'upload') assert.ok(h.objects.has(`${h.ctx.bucket}/${h.ctx.path}`));
  });
}
test('abort pending upload body cancels read without writing or cancelling SQL task', { timeout: 2000 }, async () => {
  const h = harness({ action: 'upload' }); const controller = new AbortController(); const started = defer(); let cancels = 0;
  const body = new ReadableStream({ pull() { started.resolve(); }, cancel() { cancels++; throw Error(SECRET); } }, { highWaterMark: 0 });
  const pending = h.handler(request(h, {}, { signal: controller.signal, body, duplex: 'half' }));
  await started.promise; controller.abort(Error(SECRET)); await failed(await pending, 400, 'INVALID_REQUEST');
  noStorage(h); assert.equal(cancels, 1);
});
test('SDK upload cannot be forcibly aborted; an eventual object is never deleted or committed', { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ action: 'upload' }); const controller = new AbortController(); const started = defer(); const result = defer();
  h.write = () => { started.resolve(); return result.promise; };
  let settled = false;
  const pending = h.handler(request(h, {}, { signal: controller.signal })).then(res => { settled = true; return res; });
  await started.promise; controller.abort(Error(SECRET)); t.mock.timers.tick(180_000); await nextTurn();
  assert.equal(settled, false); assert.deepEqual(ops(h), [AUTH, 'upload']);
  h.objects.set(`${h.ctx.bucket}/${h.ctx.path}`, JPEG); result.resolve({ data: {} });
  await failed(await pending); assert.deepEqual(ops(h), [AUTH, 'upload']);
  assert.ok(h.objects.has(`${h.ctx.bucket}/${h.ctx.path}`));
});
test('50MiB inclusive notification media is accepted, never truncated', async () => {
  const bytes = new Uint8Array(MAX_MEDIA_BYTES); bytes.set(MP4);
  const h = harness({ bytes }); const res = await h.handler(request(h));
  assert.equal(res.status, 200); assert.equal((await res.arrayBuffer()).byteLength, MAX_MEDIA_BYTES);
  assert.equal(h.calls.at(-1).args.p_bytes, MAX_MEDIA_BYTES); assert.equal(h.calls.at(-1).args.p_sha256, sha(bytes));
});
for (const action of ['download', 'upload']) test(`${action}: >50MiB declaration stops before reading`, async () => {
  const h = harness({ action }); const s = stream([JPEG]);
  if (action === 'download') h.read = () => ({ data: new Response(s.body, { headers: { 'content-length': `${MAX_MEDIA_BYTES + 1}` } }) });
  await failed(await h.handler(request(h, action === 'upload' ? { 'content-length': `${MAX_MEDIA_BYTES + 1}` } : {})),
    action === 'upload' ? 413 : 422, action === 'upload' ? 'BODY_TOO_LARGE' : 'INVALID_MEDIA');
  assert.equal(s.reads, 0); assert.deepEqual(ops(h), action === 'upload' ? [] : [AUTH, 'download']);
});
for (const action of ACTIONS) test(`${action}: known tuple streaming overflow stops at first excess chunk`, async () => {
  const h = harness({ action }); h.ctx.file = tuple(h.ctx);
  const s = stream([JPEG, Uint8Array.of(1), new Uint8Array(1024)], () => new Promise(() => {}));
  h.read = () => ({ data: new Response(s.body) });
  await failed(await h.handler(request(h)), 422, 'INVALID_MEDIA'); assert.equal(s.reads, 2); assert.equal(s.cancels, 1);
  assert.ok(!ops(h).includes(COMMIT));
});
for (const phase of ['authorize', 'upload', 'download', 'commit']) test(`thrown ${phase} diagnostics remain sanitized, no fallback/retry/cleanup`, async () => {
  const h = harness({ action: 'upload' });
  h[{ authorize: 'authorize', upload: 'write', download: 'read', commit: 'commit' }[phase]] = () => { throw Error(`${SECRET} ${ADMIN} ${h.ctx.source_url}`); };
  await failed(await h.handler(request(h)));
  for (const op of [AUTH, 'upload', 'download', COMMIT]) assert.ok(ops(h).filter(value => value === op).length <= 1);
  assert.ok(!ops(h).includes('remove')); assert.ok(!ops(h).includes('update'));
});
test('SQL26 service-only RPC arguments, exact context and reauthorization contract match Edge', async () => {
  const sql = await readFile(`${root}supabase/migrations/20261102000026_transfer_notification_media.sql`, 'utf8');
  assert.match(sql, /CREATE FUNCTION public\.employee_transfer_notification_media_authorize\(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text\)/);
  assert.match(sql, /CREATE FUNCTION public\.employee_transfer_notification_media_commit\(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text,p_bytes integer,p_sha256 text,p_content_type text,p_storage_origin text,p_generation text\)/);
  assert.match(sql, /v_context:=public\.employee_transfer_notification_media_authorize\(p_admin_session_token,p_job_token,p_action,p_object_key\)/);
  assert.match(sql, /p_generation IS DISTINCT FROM v_context->>'generation'/);
  assert.match(sql, /FROM PUBLIC,anon,authenticated,service_role;\s*GRANT EXECUTE ON FUNCTION public\.employee_transfer_notification_media_authorize/);
  assert.match(sql, /employee_transfer_notification_media_commit\([^;]+TO service_role;/);
  assert.deepEqual(Object.keys(harness().ctx).sort(), ['direction', 'key', 'bucket', 'path', 'source_url', 'file', 'generation'].sort());
});
test('thin Deno adapter uses validated ctx.bucket for all notification buckets and fixed env fetch origin', async () => {
  let handle; let creates = 0; let active;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  const stateKey = '__notificationMediaOfflineSdk';
  globalThis[stateKey] = (url, key, options) => {
    creates++; assert.equal(url, TARGET); assert.equal(key, SECRET);
    assert.deepEqual(options, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    return { rpc: (...args) => active.rpc(...args), storage: { from(bucket) { return {
      upload: (...args) => active.store.upload(bucket, ...args),
      download() { assert.fail('SDK Blob download forbidden'); },
    }; } } };
  };
  Object.defineProperty(globalThis, 'Deno', { configurable: true, value: {
    env: { get: name => name === 'SUPABASE_URL' ? TARGET : SECRET }, serve(handler) { handle = handler; },
  } });
  globalThis.fetch.mock.mockImplementation(async (url, options) => {
    fakeFetches++;
    assert.equal(url, `${TARGET}/storage/v1/object/${active.ctx.bucket}/${active.ctx.path}`);
    assert.equal(options.redirect, 'error'); assert.equal(options.method, 'GET'); assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(options.headers, { Authorization: `Bearer ${SECRET}`, apikey: SECRET, 'Accept-Encoding': 'identity' });
    return (await active.store.download(active.ctx.bucket, active.ctx.path, options.signal)).data;
  });
  try {
    const compiled = await build({ entryPoints: [`${entry}index.ts`], bundle: true, write: false, platform: 'browser', format: 'esm',
      plugins: [{ name: 'fake-sdk', setup(builder) {
        builder.onResolve({ filter: /^npm:@supabase\/supabase-js@/ }, args => ({ path: args.path, namespace: 'offline' }));
        builder.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents: `export const createClient = (...args) => globalThis.${stateKey}(...args);` }));
      } }] });
    await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
    assert.equal(creates, 0);
    for (const bucket of BUCKETS) {
      active = harness({ action: 'upload', bucket, bytes: MP4, type: 'video/mp4' });
      assert.equal((await handle(request(active, { authorization: 'Bearer must-not-forward' }))).status, 200);
      assert.deepEqual(ops(active), [AUTH, 'upload', 'download', COMMIT]);
      active.action = 'recheck-import'; assert.equal((await handle(request(active))).status, 200);
      const before = fakeFetches; active.ctx.bucket = 'verification-documents';
      await failed(await handle(request(active))); assert.equal(fakeFetches, before);
    }
    assert.equal(creates, 1);
  } finally {
    globalThis.fetch.mock.mockImplementation(denyFetch);
    delete globalThis[stateKey];
    if (previous) Object.defineProperty(globalThis, 'Deno', previous); else delete globalThis.Deno;
  }
});
