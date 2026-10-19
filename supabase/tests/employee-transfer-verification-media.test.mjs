import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

// Only repository source is read. No fixtures on disk, env credentials, network,
// database or genuine media are used; esbuild emits exclusively into memory.
const root = fileURLToPath(new globalThis.URL('../../', import.meta.url));
const entry = `${root}supabase/functions/employee-transfer-media/`;
const SOURCE = 'https://source-fixture.supabase.co';
const TARGET = 'https://target-fixture.supabase.co';
const PREFIX = '/storage/v1/object/public/verification-documents/';
const BUCKET = 'verification-documents';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const SECRET = 'never-echo-backend-secret-or-document-id';
const PATH = `id-front/${USER}-synthetic.jpg`;
const IMPORT_PATH = `id-front/${USER}-transfer-${'a'.repeat(32)}.jpg`;
const AUTH = 'employee_transfer_verification_media_authorize';
const COMMIT = 'employee_transfer_verification_media_commit';
const sha = value => createHash('sha256').update(value).digest('hex');
const URL = SOURCE + PREFIX + PATH;
const KEY = sha(URL);
const SAMPLES = [
  ['image/jpeg', Uint8Array.of(255, 216, 255, 224, 0, 3, 9, 255, 217)],
  ['image/png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3)],
  ['image/gif', new TextEncoder().encode('GIF87a-synthetic')],
  ['image/gif', new TextEncoder().encode('GIF89a-synthetic')],
  ['image/webp', Uint8Array.of(82, 73, 70, 70, 16, 0, 0, 0, 87, 69, 66, 80, 1, 2)],
  ['application/pdf', new TextEncoder().encode('%PDF-1.7\nsynthetic\n%%EOF')],
];
const [JPEG_TYPE, JPEG] = SAMPLES[0];
const rawError = extra => ({ message: `${SECRET} ${ADMIN} ${JOB} ${URL}`, details: SECRET, ...extra });
const logs = ['log', 'info', 'warn', 'error', 'debug', 'trace'].map(name => mock.method(console, name, () => {}));
const denyFetch = () => assert.fail('network is forbidden');
mock.method(globalThis, 'fetch', denyFetch);
let expectedFetchCalls = 0;
const unhandled = [];
const onUnhandled = reason => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
after(async () => {
  await nextTurn();
  for (const log of logs) assert.equal(log.mock.callCount(), 0, 'no sensitive console logging');
  assert.equal(globalThis.fetch.mock.callCount(), expectedFetchCalls, 'only explicitly injected fake fetch; no SSRF/retry');
  assert.deepEqual(unhandled, [], 'no uncaught secrets/rejections');
  process.off('unhandledRejection', onUnhandled);
  mock.restoreAll();
});
const compiled = await build({ entryPoints: [`${entry}handler.ts`], bundle: true, write: false,
  platform: 'browser', format: 'esm', target: 'es2020' });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const { createEmployeeTransferMediaHandler: factory, MAX_MEDIA_BYTES } = api;
const tuple = (bytes = JPEG, type = JPEG_TYPE) => ({ key: KEY, source_url: URL, bytes: bytes.length, sha256: sha(bytes), content_type: type });
const receipt = file => ({ success: true, key: file.key, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, full_site_complete: false });
const commands = ['download', 'recheck-export', 'upload', 'recheck-import'];
function harness({ direction = 'export', bytes = JPEG, type = JPEG_TYPE, file = direction === 'import' ? tuple(bytes, type) : null, origin } = {}) {
  const h = { calls: [], objects: new Map(), removed: 0, ctx: { direction, key: KEY, bucket: BUCKET,
    path: direction === 'export' ? PATH : IMPORT_PATH, source_url: URL, file, generation: direction === 'export' ? 'export' : '0' }, authorize: null, commit: null, read: null, write: null };
  if (direction === 'export') h.objects.set(PATH, new Blob([bytes], { type: 'application/x-untrusted' }));
  h.rpc = async (name, args) => {
    h.calls.push({ op: name, args: structuredClone(args) });
    assert.ok([AUTH, COMMIT].includes(name), 'Edge must not close/cancel a job or use another RPC');
    if (name === AUTH) return h.authorize ? h.authorize(args) : { data: structuredClone(h.ctx), error: null };
    if (h.commit) return h.commit(args);
    assert.equal(args.p_generation, h.ctx.generation, 'commit binds the generation captured BEFORE object read');
    return { data: { success: true, key: args.p_object_key, bytes: args.p_bytes, sha256: args.p_sha256,
      content_type: args.p_content_type, full_site_complete: false }, error: null };
  };
  h.store = {
    async download(bucket, path) {
      h.calls.push({ op: 'download', bucket, path });
      assert.equal(bucket, BUCKET);
      if (h.read) return h.read(bucket, path);
      const blob = h.objects.get(path);
      return blob ? { data: new Response(blob.stream(), { headers: { 'content-type': blob.type } }), error: null } :
        { data: new Response(SECRET, { status: 404 }), error: null };
    },
    async upload(bucket, path, data, options) {
      h.calls.push({ op: 'upload', bucket, path, options: { ...options }, bytes: data.length, sha256: sha(data) });
      assert.equal(bucket, BUCKET);
      assert.deepEqual(options, { upsert: false, contentType: h.ctx.file.content_type });
      if (h.write) return h.write(bucket, path, data, options);
      if (h.objects.has(path)) return { data: null, error: rawError({ status: 400, statusCode: '409' }) };
      h.objects.set(path, new Blob([data], { type: options.contentType }));
      return { data: { path }, error: null };
    },
    remove() { h.removed++; assert.fail('delete forbidden'); },
    update() { assert.fail('overwrite forbidden'); },
  };
  h.handler = factory({ supabaseUrl: origin ?? (direction === 'export' ? SOURCE : TARGET), rpc: h.rpc, store: h.store, crypto: webcrypto });
  return h;
}
function request(action = 'download', body, overrides = {}, init = {}) {
  const headers = new Headers({ 'x-transfer-action': action, 'x-admin-session-token': ADMIN,
    'x-transfer-job-token': JOB, 'x-transfer-object-key': KEY });
  for (const [name, value] of Object.entries(overrides)) value === null ? headers.delete(name) : headers.set(name, value);
  return new Request('https://edge-fixture.invalid/employee-transfer-media', {
    method: 'POST', headers, ...(body === undefined ? {} : { body, duplex: 'half' }), ...init,
  });
}
function secured(response) {
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
}
async function failed(response, status, error) {
  secured(response);
  assert.equal(response.status, status);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { success: false, error });
  for (const sensitive of [SECRET, ADMIN, JOB, USER, URL, KEY, PATH]) {
    assert.ok(!text.includes(sensitive));
    assert.ok(![...response.headers.values()].some(value => value.includes(sensitive)));
  }
}
const operations = h => h.calls.map(call => call.op);
function noStorage(h) { assert.deepEqual(operations(h), [AUTH]); assert.equal(h.removed, 0); }
function streamOf(chunks, { error = false, cancelError = false } = {}) {
  const state = { reads: 0, cancels: 0 };
  state.stream = new ReadableStream({
    pull(controller) {
      const item = chunks[state.reads++];
      if (item !== undefined) controller.enqueue(item);
      else if (error) controller.error(Error(SECRET));
      else controller.close();
    },
    cancel() { state.cancels++; if (cancelError) throw Error(SECRET); },
  }, { highWaterMark: 0 });
  return state;
}

for (const [index, [type, bytes]] of SAMPLES.entries()) {
  test(`golden download magic ${index}: ${type}, actual digest, no URL/name in binary headers`, async () => {
    const h = harness({ bytes });
    const res = await h.handler(request('download', undefined, { 'content-length': '0' }));
    secured(res); assert.equal(res.status, 200);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
    assert.equal(res.headers.get('x-transfer-sha256'), sha(bytes));
    assert.equal(res.headers.get('x-transfer-content-type'), type);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('content-disposition'), 'attachment');
    assert.deepEqual(operations(h), [AUTH, 'download', COMMIT]);
    assert.deepEqual(h.calls[0].args, { p_admin_session_token: ADMIN, p_job_token: JOB, p_action: 'download', p_object_key: KEY });
    assert.deepEqual(h.calls[2].args, { ...h.calls[0].args, p_bytes: bytes.length, p_sha256: sha(bytes), p_content_type: type, p_storage_origin: SOURCE, p_generation: 'export' });
  });
  test(`golden upload ${index}: ${type}, streamed request and mandatory storage readback before commit`, async () => {
    const h = harness({ direction: 'import', bytes, type });
    const s = streamOf([bytes.subarray(0, 2), bytes.subarray(2)]);
    const req = request('upload', s.stream, { 'content-type': 'application/zip', 'content-length': `${bytes.length}` });
    req.arrayBuffer = () => assert.fail('Request.arrayBuffer is forbidden');
    const res = await h.handler(req);
    assert.equal(res.status, 200); secured(res);
    assert.deepEqual(await res.json(), receipt(tuple(bytes, type)));
    assert.deepEqual(operations(h), [AUTH, 'upload', 'download', COMMIT]);
    assert.equal(h.calls[3].args.p_storage_origin, TARGET);
    assert.deepEqual(new Uint8Array(await h.objects.get(IMPORT_PATH).arrayBuffer()), bytes);
    assert.equal(h.removed, 0);
  });
}
for (const action of ['recheck-export', 'recheck-import']) {
  test(`${action}: read actual storage, verify whole tuple, no upload or task completion`, async () => {
    const h = harness({ direction: action.endsWith('import') ? 'import' : 'export', file: tuple() });
    h.objects.set(h.ctx.path, new Blob([JPEG], { type: 'text/html' }));
    const res = await h.handler(request(action));
    assert.equal(res.status, 200); secured(res);
    assert.deepEqual(await res.json(), receipt(tuple()));
    assert.deepEqual(operations(h), [AUTH, 'download', COMMIT]);
    assert.equal(h.calls.at(-1).args.p_action, action);
  });
}
test('repeat download checks the immutable existing file tuple', async () => {
  const h = harness({ file: tuple() });
  const res = await h.handler(request());
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), JPEG);
});
for (const [name, bytes] of [
  ['HTML', new TextEncoder().encode('<script>secret</script>')], ['empty', new Uint8Array()],
  ['short JPEG', Uint8Array.of(255, 216)], ['short PNG', Uint8Array.of(137, 80, 78, 71)],
  ['wrong GIF', new TextEncoder().encode('GIF88a')], ['wrong RIFF', new TextEncoder().encode('RIFF----WAVE')],
  ['short WebP', new TextEncoder().encode('RIFF----WEB')], ['short PDF', new TextEncoder().encode('%PDF')],
]) {
  test(`reject unsupported/truncated magic: ${name}`, async () => {
    const h = harness({ bytes });
    await failed(await h.handler(request()), 422, 'INVALID_MEDIA');
    assert.deepEqual(operations(h), [AUTH, 'download']);
  });
}
for (const field of ['bytes', 'sha256', 'content_type']) {
  for (const action of commands) {
    test(`${action}: reject actual ${field} mismatch and never commit`, async () => {
      const file = tuple();
      file[field] = { bytes: JPEG.length + 1, sha256: 'f'.repeat(64), content_type: 'image/png' }[field];
      const h = harness({ direction: action.endsWith('import') || action === 'upload' ? 'import' : 'export', file });
      h.objects.set(h.ctx.path, new Blob([JPEG]));
      const res = await h.handler(request(action, action === 'upload' ? JPEG : undefined));
      await failed(res, action === 'upload' && field === 'bytes' ? 400 : 422, action === 'upload' && field === 'bytes' ? 'INVALID_REQUEST' : 'INVALID_MEDIA');
      assert.ok(!operations(h).includes(COMMIT));
      assert.ok(!operations(h).includes('upload'));
    });
  }
}

test('declared >50MiB Response rejected before reading even the first chunk', async () => {
  const s = streamOf([JPEG], { cancelError: true });
  const h = harness(); h.read = () => ({ data: new Response(s.stream, { headers: { 'content-length': `${MAX_MEDIA_BYTES + 1}` } }), error: null });
  await failed(await h.handler(request()), 422, 'INVALID_MEDIA');
  assert.equal(s.reads, 0); assert.equal(s.cancels, 1); assert.deepEqual(operations(h), [AUTH, 'download']);
});
test('50MiB inclusive boundary is accepted with exact bytes/digest, not sliced', async () => {
  const bytes = new Uint8Array(MAX_MEDIA_BYTES); bytes.set(JPEG);
  const h = harness({ bytes });
  const res = await h.handler(request());
  assert.equal(res.status, 200);
  assert.equal((await res.arrayBuffer()).byteLength, MAX_MEDIA_BYTES);
  assert.equal(res.headers.get('x-transfer-sha256'), sha(bytes));
  assert.equal(h.calls.at(-1).args.p_bytes, MAX_MEDIA_BYTES);
});
test('lying/truncated Response Content-Length cannot commit', async () => {
  const s = streamOf([JPEG]);
  const h = harness(); h.read = () => ({ data: new Response(s.stream, { headers: { 'content-length': `${JPEG.length + 1}` } }), error: null });
  await failed(await h.handler(request()), 422, 'INVALID_MEDIA');
  assert.ok(!operations(h).includes(COMMIT));
});
for (const chunks of [[JPEG.subarray(0, 2)], [], [JPEG, Uint8Array.of(1)], [new Uint8Array(MAX_MEDIA_BYTES + 1)]]) {
  test(`upload bounded stream rejects ${chunks.reduce((n, c) => n + c.length, 0)} bytes without write`, async () => {
    const h = harness({ direction: 'import' });
    const s = streamOf(chunks, { cancelError: true });
    const res = await h.handler(request('upload', s.stream));
    const over = chunks.reduce((n, c) => n + c.length, 0) > JPEG.length;
    await failed(res, over ? 413 : 400, over ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST');
    noStorage(h);
    if (over) assert.equal(s.cancels, 1);
  });
}
test('stop at first chunk past bound; never drain unlimited stream', async () => {
  const h = harness({ direction: 'import' });
  const s = streamOf([JPEG, Uint8Array.of(0), new Uint8Array(MAX_MEDIA_BYTES)]);
  await failed(await h.handler(request('upload', s.stream)), 413, 'BODY_TOO_LARGE');
  assert.equal(s.reads, 2); assert.equal(s.cancels, 1); noStorage(h);
});
test('stream read error cannot escape as sensitive exception', async () => {
  const h = harness({ direction: 'import' });
  const s = streamOf([JPEG.subarray(0, 1)], { error: true });
  await failed(await h.handler(request('upload', s.stream)), 502, 'TRANSFER_FAILED'); noStorage(h);
});
for (const action of commands.filter(a => a !== 'upload')) {
  test(`${action} rejects any nonempty body even without Content-Length`, async () => {
    const h = harness({ direction: action === 'recheck-import' ? 'import' : 'export', file: tuple() });
    const s = streamOf([Uint8Array.of(0), JPEG]);
    await failed(await h.handler(request(action, s.stream)), 413, 'BODY_TOO_LARGE');
    assert.equal(s.reads, 1); assert.equal(s.cancels, 1); noStorage(h);
  });
}
for (const size of ['-1', '1.0', '1e1', '+1', '01', 'NaN', 'Infinity', '1, 1', '999999999999999999999']) {
  test(`malformed Content-Length rejected before authorize: ${size}`, async () => {
    const h = harness({ direction: 'import' });
    await failed(await h.handler(request('upload', JPEG, { 'content-length': size })), 400, 'INVALID_REQUEST');
    assert.deepEqual(h.calls, []);
  });
}
for (const [action, length, status] of [['download', '1', 413], ['upload', `${MAX_MEDIA_BYTES + 1}`, 413], ['upload', '0', 400], ['upload', '1', 400]]) {
  test(`${action} declared length ${length} cannot bypass bounds/catalog`, async () => {
    const h = harness({ direction: action === 'upload' ? 'import' : 'export' });
    await failed(await h.handler(request(action, action === 'upload' ? JPEG : undefined, { 'content-length': length })), status,
      status === 413 ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST');
    assert.ok(!operations(h).includes('upload'));
  });
}
test('Content-Length matching catalog still rejects truncated actual bytes', async () => {
  const h = harness({ direction: 'import' });
  await failed(await h.handler(request('upload', JPEG.subarray(0, 2), { 'content-length': `${JPEG.length}` })), 400, 'INVALID_REQUEST'); noStorage(h);
});

for (const [header, values] of [
  ['x-admin-session-token', [null, '', 'not-uuid', `${ADMIN}, ${ADMIN}`, ADMIN + '\ninvalid']],
  ['x-transfer-job-token', [null, '', SECRET, `${JOB}, ${JOB}`]],
  ['x-transfer-object-key', [null, '', 'a'.repeat(63), 'A'.repeat(64), `${KEY}, ${KEY}`, '../' + KEY]],
  ['x-transfer-action', [null, '', 'close', 'cancel', 'DOWNLOAD', 'download, upload']],
]) {
  for (const value of values) {
    if (value?.includes('\n')) continue; // Fetch Headers itself rejects CR/LF before handler invocation.
    test(`request header ${header}: reject ${String(value).length}-character invalid value`, async () => {
      const h = harness();
      await failed(await h.handler(request('download', undefined, { [header]: value })), 400, 'INVALID_REQUEST');
      assert.deepEqual(h.calls, []);
    });
  }
}
for (const name of ['content-encoding', 'content-range']) {
  test(`reject ambiguous request ${name}`, async () => {
    const h = harness();
    await failed(await h.handler(request('download', undefined, { [name]: 'identity' })), 400, 'INVALID_REQUEST');
    assert.deepEqual(h.calls, []);
  });
}
for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) {
  test(`CORS/method boundary rejects ${method}`, async () => {
    const h = harness();
    await failed(await h.handler(request('download', undefined, {}, { method })), 405, 'METHOD_NOT_ALLOWED');
    assert.deepEqual(h.calls, []);
  });
}
test('OPTIONS allows only POST and explicit request headers; exposes integrity headers', async () => {
  const h = harness();
  const headers = { 'access-control-request-method': 'POST', 'access-control-request-headers':
    'X-Transfer-Action, X-Admin-Session-Token, X-Transfer-Job-Token, X-Transfer-Object-Key, Content-Type, authorization, apikey, x-client-info' };
  const res = await h.handler(request('download', undefined, headers, { method: 'OPTIONS' }));
  assert.equal(res.status, 204); assert.equal(await res.text(), ''); secured(res);
  assert.equal(res.headers.get('access-control-expose-headers'), 'x-transfer-sha256, x-transfer-content-type');
  assert.ok(!res.headers.get('access-control-allow-headers').includes('*'));
  for (const bad of [{ 'access-control-request-method': 'DELETE' }, { 'access-control-request-headers': 'x-transfer-url' }]) {
    await failed(await h.handler(request('download', undefined, bad, { method: 'OPTIONS' })), 400, 'INVALID_REQUEST');
  }
  assert.deepEqual(h.calls, []);
});

for (const reason of ['unauthorized', 'expired', 'cancelled', 'wrong job', 'wrong object']) {
  test(`authorize denies ${reason}; body not consumed, no storage or retry`, async () => {
    const h = harness({ direction: 'import' }); h.authorize = () => ({ data: null, error: rawError({ reason }) });
    const s = streamOf([JPEG], { cancelError: true });
    await failed(await h.handler(request('upload', s.stream)), 403, 'NOT_AUTHORIZED');
    assert.equal(s.reads, 0); assert.equal(s.cancels, 1); noStorage(h);
  });
}
for (const value of [undefined, null, [], {}, false, { direction: 'export' }]) {
  test(`malformed/null authorize response ${JSON.stringify(value)} fails closed`, async () => {
    const h = harness(); h.authorize = () => ({ data: value, error: null });
    await failed(await h.handler(request()), value == null ? 403 : 502, value == null ? 'NOT_AUTHORIZED' : 'TRANSFER_FAILED');
    noStorage(h);
  });
}
const unsafeUrls = [
  'http://source-fixture.supabase.co' + PREFIX + PATH,
  'https://evil.invalid' + PREFIX + PATH,
  'https://source-fixture.supabase.co.evil.invalid' + PREFIX + PATH,
  'https://user:password@source-fixture.supabase.co' + PREFIX + PATH,
  'https://127.0.0.1' + PREFIX + PATH,
  'https://169.254.169.254/latest/meta-data',
  '//source-fixture.supabase.co' + PREFIX + PATH,
  'https://source-fixture.supabase.co:443' + PREFIX + PATH,
  'https://SOURCE-fixture.supabase.co' + PREFIX + PATH,
  URL + '?token=' + SECRET, URL + '#' + SECRET,
  SOURCE + '/storage/v1/object/sign/verification-documents/' + PATH,
  SOURCE + '/storage/v1/object/public/other/' + PATH,
  SOURCE + PREFIX + PATH.replace('synthetic', '../synthetic'),
  SOURCE + PREFIX + PATH.replace('synthetic', '%2e%2e%2fsynthetic'),
  SOURCE + PREFIX + PATH.replace('id-front/', 'id-front//'),
  SOURCE + PREFIX + PATH.replace('id-front/', 'id-front/./'),
  SOURCE + PREFIX + PATH.replace('id-front/', 'id-front/../id-front/'),
  SOURCE + PREFIX + PATH.replace('id-front/', 'id-front\\'),
  SOURCE + PREFIX + PATH + '\n', 'data:image/jpeg;base64,' + SECRET,
  SOURCE + PREFIX + `id-front/${USER}-${'a'.repeat(150)}.jpg`,
];
for (const [index, source] of unsafeUrls.entries()) {
  test(`raw malicious source URL ${index} rejected without normalization/fetch`, async () => {
    const h = harness(); h.ctx.source_url = source; h.ctx.key = sha(source);
    await failed(await h.handler(request('download', undefined, { 'x-transfer-object-key': sha(source) })), 502, 'TRANSFER_FAILED'); noStorage(h);
  });
}
test('valid different source origin is still forbidden for export', async () => {
  const h = harness(); h.ctx.source_url = TARGET + PREFIX + PATH; h.ctx.key = sha(h.ctx.source_url);
  await failed(await h.handler(request('download', undefined, { 'x-transfer-object-key': h.ctx.key })), 502, 'TRANSFER_FAILED'); noStorage(h);
});
for (const path of ['../secret', '/' + PATH, PATH + '?x', PATH + '#x', PATH.replace('id-front', 'unknown'),
  PATH.replace('synthetic', '%2f'), PATH.replace('synthetic', '..'), PATH.replace('id-front/', 'id-front//')]) {
  test(`unsafe authorized path ${path.length} fails before any storage`, async () => {
    const h = harness(); h.ctx.path = path;
    await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); noStorage(h);
  });
}
for (const [field, value] of [['direction', 'import'], ['key', 'a'.repeat(64)], ['bucket', 'chat-images'], ['path', PATH.replace('synthetic', 'different')]]) {
  test(`authorize ${field} mismatch is not trusted`, async () => {
    const h = harness(); h.ctx[field] = value;
    await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); noStorage(h);
  });
}
test('source_url must hash to the object key, not just match file fields', async () => {
  const h = harness(); h.ctx.key = 'a'.repeat(64);
  await failed(await h.handler(request('download', undefined, { 'x-transfer-object-key': h.ctx.key })), 502, 'TRANSFER_FAILED'); noStorage(h);
});
for (const action of ['upload', 'recheck-import', 'recheck-export']) {
  test(`${action} requires non-null file; only initial download may omit it`, async () => {
    const h = harness({ direction: action === 'recheck-export' ? 'export' : 'import', file: null });
    await failed(await h.handler(request(action, action === 'upload' ? JPEG : undefined)), 502, 'TRANSFER_FAILED'); noStorage(h);
  });
}
for (const [field, values] of [
  ['key', ['a'.repeat(64), null]], ['source_url', [URL + '?secret', null]],
  ['bytes', [0, -1, MAX_MEDIA_BYTES + 1, '9', 1.5, null]],
  ['sha256', [null, 'F'.repeat(64), 'a'.repeat(63), sha(JPEG) + '\n']],
  ['content_type', [null, 'text/html', 'IMAGE/JPEG', 'image/jpeg; charset=utf-8']],
]) {
  for (const value of values) test(`file tuple invalid ${field}: ${String(value).length} characters`, async () => {
    const h = harness({ file: { ...tuple(), [field]: value } });
    await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); noStorage(h);
  });
}
for (const change of [file => ({ ...file, extra: SECRET }), file => { delete file.sha256; return file; }]) {
  test('file tuple must have exactly SQL22 fields', async () => {
    const h = harness({ file: change(tuple()) });
    await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); noStorage(h);
  });
}
for (const path of [PATH, IMPORT_PATH.replace(USER, ADMIN), IMPORT_PATH.replace('id-front', 'selfie'),
  IMPORT_PATH.replace('.jpg', '.png'), IMPORT_PATH.replace('-transfer-', '-other-')]) {
  test('import destination must be managed, same employee/slot/extension and transfer-namespaced', async () => {
    const h = harness({ direction: 'import' }); h.ctx.path = path;
    await failed(await h.handler(request('upload', JPEG)), 502, 'TRANSFER_FAILED'); noStorage(h);
  });
}
test('extra request URL/path headers or JSON body cannot select an object', async () => {
  const h = harness();
  const res = await h.handler(request('download', undefined, { 'x-transfer-url': 'http://127.0.0.1', 'x-transfer-path': '../secret' }));
  assert.equal(res.status, 200); assert.equal(h.calls[1].path, PATH);
  const h2 = harness({ direction: 'import' });
  await failed(await h2.handler(request('upload', JSON.stringify({ url: URL, path: IMPORT_PATH }))), 413, 'BODY_TOO_LARGE'); noStorage(h2);
});
for (const origin of ['', 'http://source-fixture.supabase.co', SOURCE + '/unsafe', SOURCE + '?x', SOURCE + ':443', SOURCE + '\n', SOURCE + '\r', SOURCE + '\u2028', 'https://127.0.0.1']) {
  test(`invalid configured origin ${origin.length} fails before RPC/storage`, async () => {
    const h = harness({ origin }); await failed(await h.handler(request()), 500, 'TRANSFER_FAILED'); assert.deepEqual(h.calls, []);
  });
}
test('configured trailing slash normalized only for trusted env origin', async () => {
  const h = harness({ origin: SOURCE + '/' }); const res = await h.handler(request());
  assert.equal(res.status, 200); assert.equal(h.calls.at(-1).args.p_storage_origin, SOURCE);
});

for (const error of [rawError({ status: 400, statusCode: '409' }), rawError({ status: 409 }), rawError({ statusCode: 409 })]) {
  test('occupied identical path may be reused only after actual download/hash/type verification', async () => {
    const h = harness({ direction: 'import' }); const original = new Blob([JPEG]); h.objects.set(IMPORT_PATH, original);
    h.write = () => ({ data: null, error });
    const res = await h.handler(request('upload', JPEG));
    assert.equal(res.status, 200); assert.deepEqual(await res.json(), receipt(tuple()));
    assert.deepEqual(operations(h), [AUTH, 'upload', 'download', COMMIT]);
    assert.equal(h.objects.get(IMPORT_PATH), original); assert.equal(h.removed, 0);
  });
}
test('occupied path with different bytes is never overwritten or deleted', async () => {
  const h = harness({ direction: 'import' }); const different = JPEG.slice(); different[4] ^= 1;
  const existing = new Blob([different]); h.objects.set(IMPORT_PATH, existing);
  await failed(await h.handler(request('upload', JPEG)), 422, 'INVALID_MEDIA');
  assert.deepEqual(operations(h), [AUTH, 'upload', 'download']); assert.equal(h.objects.get(IMPORT_PATH), existing); assert.equal(h.removed, 0);
});
for (const variant of ['different bytes', 'different type', 'missing', 'download error', 'invalid magic', 'empty']) {
  test(`upload final readback drift: ${variant} blocks commit, leaves already uploaded object`, async () => {
    const h = harness({ direction: 'import' });
    h.read = () => {
      if (variant === 'missing') return { data: null, error: null };
      if (variant === 'download error') return { data: null, error: rawError() };
      const different = JPEG.slice(); different[4] ^= 1;
      return { data: new Response(variant === 'different bytes' ? different : variant === 'different type' ? SAMPLES[1][1] : variant === 'empty' ? new Uint8Array() : new Uint8Array(JPEG.length)), error: null };
    };
    const res = await h.handler(request('upload', JPEG));
    await failed(res, ['missing', 'download error'].includes(variant) ? 502 : 422, ['missing', 'download error'].includes(variant) ? 'TRANSFER_FAILED' : 'INVALID_MEDIA');
    assert.deepEqual(operations(h), [AUTH, 'upload', 'download']); assert.ok(h.objects.has(IMPORT_PATH)); assert.equal(h.removed, 0);
  });
}
for (const action of commands) {
  test(`${action}: commit reauthorization expiry/cancellation returns generic uncertain error, no rollback/retry`, async () => {
    const h = harness({ direction: action === 'upload' || action === 'recheck-import' ? 'import' : 'export', file: action === 'download' ? null : tuple() });
    if (action === 'recheck-import') h.objects.set(IMPORT_PATH, new Blob([JPEG]));
    let authorized = false;
    h.authorize = () => { authorized = true; return { data: h.ctx, error: null }; };
    h.commit = () => { assert.ok(authorized); return { data: null, error: rawError({ reason: 'authorize recheck: job cancelled/expired' }) }; };
    await failed(await h.handler(request(action, action === 'upload' ? JPEG : undefined)), 502, 'TRANSFER_FAILED');
    assert.equal(operations(h).filter(op => op === AUTH).length, 1); assert.equal(operations(h).filter(op => op === COMMIT).length, 1);
    assert.ok(h.objects.has(h.ctx.path)); assert.equal(h.removed, 0);
  });
}
for (const field of ['success', 'key', 'bytes', 'sha256', 'content_type', 'full_site_complete', 'extra', 'missing']) {
  test(`commit receipt ${field} drift must not produce success or disclose backend data`, async () => {
    const h = harness(); h.commit = () => {
      const data = receipt(tuple());
      if (field === 'missing') delete data.sha256;
      else data[field] = { success: false, key: SECRET, bytes: JPEG.length + 1, sha256: '0'.repeat(64), content_type: 'image/png', full_site_complete: true, extra: SECRET }[field];
      return { data, error: null };
    };
    await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); assert.equal(operations(h).filter(op => op === COMMIT).length, 1);
  });
}
for (const stage of ['authorize', 'upload', 'download', 'commit', 'digest']) {
  test(`thrown secret at ${stage} is caught, never logged, retried or used for cleanup`, async () => {
    const h = harness({ direction: 'import' });
    const boom = () => { throw Error(`${SECRET} ${URL} ${ADMIN}`); };
    if (stage === 'authorize') h.authorize = boom;
    if (stage === 'upload') h.write = boom;
    if (stage === 'download') h.read = boom;
    if (stage === 'commit') h.commit = boom;
    if (stage === 'digest') h.handler = factory({ supabaseUrl: TARGET, rpc: h.rpc, store: h.store, crypto: { subtle: { digest: boom } } });
    await failed(await h.handler(request('upload', JPEG)), 502, 'TRANSFER_FAILED');
    for (const name of [AUTH, 'upload', 'download', COMMIT]) assert.ok(operations(h).filter(op => op === name).length <= 1);
    assert.equal(h.removed, 0);
  });
}
for (const error of [rawError({ status: 500 }), rawError({ status: 400, message: 'already exists 409 ' + SECRET }), rawError({ status: 403 })]) {
  test('non-occupied upload failure is uncertain and never retried/read/deleted', async () => {
    const h = harness({ direction: 'import' });
    h.write = () => { h.objects.set(IMPORT_PATH, new Blob([JPEG])); return { data: null, error }; };
    await failed(await h.handler(request('upload', JPEG)), 502, 'TRANSFER_FAILED');
    assert.deepEqual(operations(h), [AUTH, 'upload']); assert.ok(h.objects.has(IMPORT_PATH)); assert.equal(h.removed, 0);
  });
}
test('separate explicit repeat can reuse identical object; Edge performs no automatic retry', async () => {
  const h = harness({ direction: 'import' });
  for (let i = 0; i < 2; i++) assert.equal((await h.handler(request('upload', JPEG))).status, 200);
  assert.deepEqual(operations(h), [AUTH, 'upload', 'download', COMMIT, AUTH, 'upload', 'download', COMMIT]);
  assert.equal(h.objects.size, 1); assert.equal(h.removed, 0);
});
test('request aborted before authorize cannot access storage', async () => {
  const h = harness(); const controller = new AbortController(); controller.abort(Error(SECRET));
  await failed(await h.handler(request('download', undefined, {}, { signal: controller.signal })), 400, 'INVALID_REQUEST');
  assert.deepEqual(h.calls, []);
});
test('abort during pending bounded read cancels reader without hanging or database cancel RPC', async () => {
  const h = harness({ direction: 'import' }); const controller = new AbortController(); let reading;
  const started = new Promise(resolve => { reading = resolve; }); let cancels = 0;
  const stream = new ReadableStream({ pull() { reading(); }, cancel() { cancels++; throw Error(SECRET); } }, { highWaterMark: 0 });
  const res = h.handler(request('upload', stream, {}, { signal: controller.signal }));
  await started; controller.abort(Error(SECRET));
  await failed(await res, 400, 'INVALID_REQUEST'); assert.equal(cancels, 1); noStorage(h);
});
test('abort after upload leaves file and returns generic uncertain result without read/delete/commit', async () => {
  const h = harness({ direction: 'import' }); const controller = new AbortController();
  h.write = (_bucket, path, bytes) => { h.objects.set(path, new Blob([bytes])); controller.abort(Error(SECRET)); return { data: { path }, error: null }; };
  await failed(await h.handler(request('upload', JPEG, {}, { signal: controller.signal })), 502, 'TRANSFER_FAILED');
  assert.deepEqual(operations(h), [AUTH, 'upload']); assert.ok(h.objects.has(IMPORT_PATH)); assert.equal(h.removed, 0);
});
test('abort during final storage readback never commits or deletes', async () => {
  const h = harness({ direction: 'import' }); const controller = new AbortController();
  h.read = () => { controller.abort(Error(SECRET)); return { data: new Response(JPEG), error: null }; };
  await failed(await h.handler(request('upload', JPEG, {}, { signal: controller.signal })), 502, 'TRANSFER_FAILED');
  assert.deepEqual(operations(h), [AUTH, 'upload', 'download']); assert.ok(h.objects.has(IMPORT_PATH)); assert.equal(h.removed, 0);
});

for (const suffix of ['\n', '\r', '\u2028', '\u2029', '\0']) {
  test(`reject fully consistent raw source/path control suffix U+${suffix.charCodeAt(0).toString(16)}`, async () => {
    const h = harness();
    h.ctx.source_url = URL + suffix; h.ctx.path = PATH + suffix; h.ctx.key = sha(h.ctx.source_url);
    await failed(await h.handler(request('download', undefined, { 'x-transfer-object-key': h.ctx.key })), 502, 'TRANSFER_FAILED'); noStorage(h);
  });
  test(`reject raw source origin control before fixed storage prefix U+${suffix.charCodeAt(0).toString(16)}`, async () => {
    const h = harness({ direction: 'import' });
    h.ctx.source_url = SOURCE + suffix + PREFIX + PATH; h.ctx.key = sha(h.ctx.source_url);
    h.ctx.file = { ...tuple(), key: h.ctx.key, source_url: h.ctx.source_url };
    await failed(await h.handler(request('upload', JPEG, { 'x-transfer-object-key': h.ctx.key })), 502, 'TRANSFER_FAILED'); noStorage(h);
  });
}
for (const change of [ctx => ({ ...ctx, extra: SECRET }), ctx => { delete ctx.file; return ctx; }]) {
  test('authorize response must exactly match SQL22 shape', async () => {
    const h = harness(); h.ctx = change(h.ctx);
    await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); noStorage(h);
  });
}
test('Response read rejection cannot escape or leak backend secrets', async () => {
  const s = streamOf([JPEG.subarray(0, 2)], { error: true });
  const h = harness(); h.read = () => ({ data: new Response(s.stream), error: null });
  await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); assert.deepEqual(operations(h), [AUTH, 'download']);
});
test('abort while commit is in flight cannot report success or fake rollback', async () => {
  const h = harness({ direction: 'import' }); const controller = new AbortController();
  h.commit = () => { controller.abort(Error(SECRET)); return { data: receipt(tuple()), error: null }; };
  await failed(await h.handler(request('upload', JPEG, {}, { signal: controller.signal })), 502, 'TRANSFER_FAILED');
  assert.deepEqual(operations(h), [AUTH, 'upload', 'download', COMMIT]); assert.ok(h.objects.has(IMPORT_PATH)); assert.equal(h.removed, 0);
});
for (const generation of ['0', '1', '499999', '500000']) {
  test(`import generation ${generation} is passed unchanged to commit`, async () => {
    const h = harness({ direction: 'import' }); h.ctx.generation = generation;
    assert.equal((await h.handler(request('upload', JPEG))).status, 200);
    assert.equal(h.calls.at(-1).args.p_generation, generation);
  });
}
for (const [direction, values] of [
  ['export', [null, undefined, '', '0', 'Export', 'export\n', 0]],
  ['import', [null, undefined, '', 'export', 0, 500000, '-1', '+1', '01', '1.0', '1e2', '500001', '999999999999999999999', ' 1', '1 ', '1\n', '1\u2028']],
]) {
  for (const generation of values) test(`${direction} rejects invalid generation ${typeof generation}/${String(generation).length}`, async () => {
    const h = harness({ direction }); h.ctx.generation = generation;
    await failed(await h.handler(request(direction === 'export' ? 'download' : 'upload', direction === 'export' ? undefined : JPEG)), 502, 'TRANSFER_FAILED');
    noStorage(h);
  });
}
test('legacy authorize shape without generation fails closed', async () => {
  const h = harness(); delete h.ctx.generation;
  await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); noStorage(h);
});
for (const action of ['upload', 'recheck-import']) {
  for (const before of ['0', '499999']) test(`${action}: apply during delayed read changes generation ${before}, cannot mark final checked`, async () => {
    const h = harness({ direction: 'import' }); h.ctx.generation = before;
    if (action === 'recheck-import') h.objects.set(IMPORT_PATH, new Blob([JPEG]));
    let release, reading;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { reading = resolve; });
    h.read = async () => { reading(); await gate; return { data: new Response(JPEG), error: null }; };
    let finalChecked = false;
    h.commit = args => {
      assert.equal(args.p_generation, before, 'must not refresh generation after downloading');
      if (args.p_generation !== h.ctx.generation) return { data: null, error: rawError({ reason: 'generation changed during final apply' }) };
      finalChecked = true; return { data: receipt(tuple()), error: null };
    };
    const pending = h.handler(request(action, action === 'upload' ? JPEG : undefined));
    await started;
    h.ctx.generation = String(Number(before) + 1); // Last apply commits while the old read is in flight.
    release();
    await failed(await pending, 502, 'TRANSFER_FAILED');
    assert.equal(finalChecked, false);
    assert.equal(operations(h).filter(op => op === AUTH).length, 1);
    assert.equal(operations(h).filter(op => op === COMMIT).length, 1);
    assert.equal(h.calls.at(-1).args.p_generation, before);
    assert.ok(h.objects.has(IMPORT_PATH)); assert.equal(h.removed, 0);
    assert.deepEqual(new Uint8Array(await h.objects.get(IMPORT_PATH).arrayBuffer()), JPEG);
  });
}
function largeResponse(total = 55 * 1024 * 1024, headers = {}, cancelPromise) {
  const chunkSize = 64 * 1024;
  const s = { reads: 0, produced: 0, cancels: 0, ended: false };
  const stream = new ReadableStream({
    pull(controller) {
      s.reads++;
      if (s.produced === total) { s.ended = true; controller.close(); return; }
      const chunk = new Uint8Array(Math.min(chunkSize, total - s.produced));
      if (s.produced === 0) chunk.set(JPEG.subarray(0, Math.min(JPEG.length, chunk.length)));
      s.produced += chunk.length; controller.enqueue(chunk);
    },
    cancel() { s.cancels++; return cancelPromise; },
  }, { highWaterMark: 0 });
  s.response = new Response(stream, { headers });
  s.response.blob = () => assert.fail('Response.blob forbidden');
  s.response.arrayBuffer = () => assert.fail('Response.arrayBuffer forbidden');
  return s;
}
test('unknown 55MiB response stops/cancels at first chunk over 50MiB, before stream end', async () => {
  const s = largeResponse(); const h = harness(); h.read = () => ({ data: s.response, error: null });
  await failed(await h.handler(request()), 422, 'INVALID_MEDIA');
  assert.equal(s.produced, MAX_MEDIA_BYTES + 64 * 1024);
  assert.equal(s.reads, MAX_MEDIA_BYTES / (64 * 1024) + 1);
  assert.equal(s.ended, false); assert.equal(s.cancels, 1);
  assert.ok(s.produced < 55 * 1024 * 1024); assert.deepEqual(operations(h), [AUTH, 'download']);
});
test('declared 55MiB response cancels before producing any bytes', async () => {
  const s = largeResponse(undefined, { 'content-length': `${55 * 1024 * 1024}` }); const h = harness();
  h.read = () => ({ data: s.response, error: null });
  await failed(await h.handler(request()), 422, 'INVALID_MEDIA');
  assert.equal(s.produced, 0); assert.equal(s.reads, 0); assert.equal(s.cancels, 1); assert.equal(s.ended, false);
});
for (const action of commands) {
  test(`${action}: known tuple bounds download at expected bytes, not global 50MiB`, async () => {
    const s = streamOf([JPEG, Uint8Array.of(1), new Uint8Array(1024 * 1024)], { cancelError: true });
    const h = harness({ direction: action === 'upload' || action === 'recheck-import' ? 'import' : 'export', file: tuple() });
    h.read = () => ({ data: new Response(s.stream), error: null });
    await failed(await h.handler(request(action, action === 'upload' ? JPEG : undefined)), 422, 'INVALID_MEDIA');
    assert.equal(s.reads, 2); assert.equal(s.cancels, 1); assert.ok(!operations(h).includes(COMMIT)); assert.equal(h.removed, 0);
    if (action === 'upload') assert.ok(h.objects.has(IMPORT_PATH));
  });
}
test('overflow does not wait for untrusted cancellation promise or drain tail', { timeout: 2000 }, async () => {
  const s = largeResponse(undefined, {}, new Promise(() => {})); const h = harness({ file: tuple() });
  h.read = () => ({ data: s.response, error: null });
  await failed(await h.handler(request()), 422, 'INVALID_MEDIA');
  assert.equal(s.reads, 1); assert.equal(s.cancels, 1); assert.equal(s.ended, false);
});
for (const header of ['-1', '1.0', '1e1', '+9', '09', 'NaN', 'Infinity', '9, 9', '999999999999999999999']) {
  test(`invalid download Content-Length ${header} rejected without consuming body`, async () => {
    const s = streamOf([JPEG]); const h = harness();
    h.read = () => ({ data: new Response(s.stream, { headers: { 'content-length': header } }), error: null });
    await failed(await h.handler(request()), 502, 'TRANSFER_FAILED');
    assert.equal(s.reads, 0); assert.equal(s.cancels, 1); assert.ok(!operations(h).includes(COMMIT));
  });
}
for (const length of [0, JPEG.length - 1, JPEG.length + 1, MAX_MEDIA_BYTES + 1]) {
  test(`known tuple rejects declared download length ${length} before reading`, async () => {
    const s = streamOf([JPEG]); const h = harness({ file: tuple() });
    h.read = () => ({ data: new Response(s.stream, { headers: { 'content-length': `${length}` } }), error: null });
    await failed(await h.handler(request()), 422, 'INVALID_MEDIA');
    assert.equal(s.reads, 0); assert.equal(s.cancels, 1);
  });
}
for (const [length, chunks] of [[JPEG.length - 1, [JPEG]], [JPEG.length + 1, [JPEG]], [JPEG.length, [JPEG, Uint8Array.of(1)]], [JPEG.length, [JPEG.subarray(0, 2)]]]) {
  test('unknown tuple still verifies actual bytes against declared length', async () => {
    const s = streamOf(chunks); const h = harness();
    h.read = () => ({ data: new Response(s.stream, { headers: { 'content-length': `${length}` } }), error: null });
    await failed(await h.handler(request()), 422, 'INVALID_MEDIA'); assert.ok(!operations(h).includes(COMMIT));
  });
}
for (const status of [201, 206, 301, 302, 303, 307, 308, 401, 403, 404, 500]) {
  test(`download status ${status} rejected without reading/following Location`, async () => {
    const s = streamOf([JPEG], { cancelError: true }); const h = harness();
    h.read = () => ({ data: new Response(s.stream, { status, headers: { location: 'http://127.0.0.1/' + SECRET } }), error: null });
    await failed(await h.handler(request()), 502, 'TRANSFER_FAILED');
    assert.equal(s.reads, 0); assert.equal(s.cancels, 1); assert.deepEqual(operations(h), [AUTH, 'download']);
  });
}
for (const property of ['redirected', 'content-range']) {
  test(`download ${property} must not bypass full-object verification`, async () => {
    const s = streamOf([JPEG]); const h = harness(); const response = new Response(s.stream);
    if (property === 'redirected') Object.defineProperty(response, property, { value: true }); else response.headers.set(property, 'bytes 0-8/55');
    h.read = () => ({ data: response, error: null });
    await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); assert.equal(s.reads, 0); assert.equal(s.cancels, 1);
  });
}
for (const encoding of ['gzip', 'br', 'deflate', 'identity,gzip', '']) {
  test(`reject non-identity Content-Encoding ${encoding.length} before streaming`, async () => {
    const s = streamOf([JPEG]); const h = harness();
    h.read = () => ({ data: new Response(s.stream, { headers: { 'content-encoding': encoding } }), error: null });
    await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); assert.equal(s.reads, 0); assert.equal(s.cancels, 1);
  });
}
for (const known of [true, false]) {
  test(`valid Response with Content-Length and identity works (${known ? 'known' : 'unknown'} tuple) without buffering APIs`, async () => {
    const s = streamOf([JPEG.subarray(0, 2), JPEG.subarray(2)]); const h = harness({ file: known ? tuple() : null });
    const response = new Response(s.stream, { headers: { 'content-length': `${JPEG.length}`, 'content-encoding': 'identity' } });
    response.blob = response.arrayBuffer = () => assert.fail('unbounded response API forbidden');
    h.read = () => ({ data: response, error: null });
    const res = await h.handler(request()); assert.equal(res.status, 200);
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), JPEG); assert.equal(s.reads, 3);
  });
}
test('no-body 200 response rejected as empty media', async () => {
  const h = harness(); h.read = () => ({ data: new Response(null), error: null });
  await failed(await h.handler(request()), 422, 'INVALID_MEDIA'); assert.ok(!operations(h).includes(COMMIT));
});
test('response body non-byte chunk is cancelled and sanitized', async () => {
  const s = streamOf([SECRET]); const h = harness(); h.read = () => ({ data: new Response(s.stream), error: null });
  await failed(await h.handler(request()), 502, 'TRANSFER_FAILED'); assert.equal(s.cancels, 1);
});
test('abort pending download read cancels HTTP stream without hanging', { timeout: 2000 }, async () => {
  const controller = new AbortController(); const h = harness(); let reading, cancels = 0;
  const started = new Promise(resolve => { reading = resolve; });
  const body = new ReadableStream({ pull() { reading(); }, cancel() { cancels++; return new Promise(() => {}); } }, { highWaterMark: 0 });
  h.read = () => ({ data: new Response(body), error: null });
  const pending = h.handler(request('download', undefined, {}, { signal: controller.signal }));
  await started; controller.abort(Error(SECRET));
  await failed(await pending, 502, 'TRANSFER_FAILED'); assert.equal(cancels, 1); assert.deepEqual(operations(h), [AUTH, 'download']);
});
test('SQL22 contract: service_role-only authorize/commit, commit itself reauthorizes', async () => {
  const sql = await readFile(`${root}supabase/migrations/20261102000022_restore_employee_verification_media.sql`, 'utf8');
  assert.match(sql, /CREATE FUNCTION public\.employee_transfer_verification_media_authorize\(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text\)/);
  const commitArgs = sql.match(/CREATE FUNCTION public\.employee_transfer_verification_media_commit\(([^)]+)\)/)?.[1];
  assert.ok(commitArgs, 'media commit must exist');
  assert.deepEqual(commitArgs.split(',').map(arg => arg.trim()).sort(),
    ['p_admin_session_token uuid', 'p_job_token uuid', 'p_action text', 'p_object_key text', 'p_bytes integer', 'p_sha256 text', 'p_content_type text', 'p_storage_origin text', 'p_generation text'].sort());
  assert.match(sql, /'generation'/);
  assert.match(sql, /p_generation IS (?:NULL|DISTINCT FROM)/);
  assert.match(sql, /v_context:=public\.employee_transfer_verification_media_authorize\(p_admin_session_token,p_job_token,p_action,p_object_key\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.employee_transfer_verification_media_authorize\([^;]+FROM PUBLIC,anon,authenticated,service_role/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.employee_transfer_verification_media_authorize\([^;]+TO service_role/);
});
test('Deno index and handler strictly typecheck against locally installed SDK without network or emit', () => {
  const filename = `${entry}index.ts`;
  const options = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'] };
  const host = ts.createCompilerHost(options);
  const originalRead = host.readFile.bind(host);
  host.readFile = path => {
    const text = originalRead(path);
    return path === filename ? `declare const Deno: {env: {get(name: string): string | undefined}; serve(handler: (request: Request) => Promise<Response>): void};\n${text}` : text;
  };
  host.resolveModuleNames = (names, containingFile) => names.map(name => ts.resolveModuleName(
    name.startsWith('npm:@supabase/supabase-js@') ? '@supabase/supabase-js' : name, containingFile, options, host).resolvedModule);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnostics(diagnostics,
    { getCanonicalFileName: value => value, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
});
test('thin Deno index injects env service client with no auth persistence, header forwarding, network or retry', async () => {
  const h = harness({ direction: 'import' }); let handle; let creates = 0; let env = [];
  const sdk = { rpc: h.rpc, storage: { from(bucket) { return {
    download() { assert.fail('SDK download would buffer the entire Blob'); },
    upload: (path, bytes, options) => h.store.upload(bucket, path, bytes, options),
  }; } } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
  const stateKey = '__employeeTransferOfflineSdk';
  globalThis[stateKey] = (url, key, options) => {
    creates++; assert.equal(url, TARGET); assert.equal(key, SECRET);
    assert.deepEqual(options, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    return sdk;
  };
  Object.defineProperty(globalThis, 'Deno', { configurable: true, value: {
    env: { get(name) { env.push(name); return name === 'SUPABASE_URL' ? TARGET : SECRET; } },
    serve(handler) { handle = handler; },
  } });
  globalThis.fetch.mock.mockImplementation(async (url, options) => {
    expectedFetchCalls++;
    assert.equal(url, `${TARGET}/storage/v1/object/${BUCKET}/${h.ctx.path}`);
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Authorization: `Bearer ${SECRET}`, apikey: SECRET, 'Accept-Encoding': 'identity' });
    const result = await h.store.download(BUCKET, h.ctx.path);
    return result.data;
  });
  try {
    const result = await build({ entryPoints: [`${entry}index.ts`], bundle: true, write: false, format: 'esm', platform: 'browser',
      plugins: [{ name: 'offline-supabase-only', setup(builder) {
        builder.onResolve({ filter: /^npm:@supabase\/supabase-js@/ }, args => ({ path: args.path, namespace: 'fake-sdk' }));
        builder.onLoad({ filter: /.*/, namespace: 'fake-sdk' }, () => ({ contents: `export const createClient = (...args) => globalThis.${stateKey}(...args);` }));
      } }] });
    await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
    assert.deepEqual(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']); assert.equal(creates, 0);
    const res = await handle(request('upload', JPEG, { authorization: 'Bearer must-not-forward' }));
    assert.equal(res.status, 200); assert.equal(creates, 1);
    assert.deepEqual(operations(h), [AUTH, 'upload', 'download', COMMIT]);
    assert.equal(h.calls.at(-1).args.p_storage_origin, TARGET);
    assert.equal(h.calls.at(-1).args.p_generation, '0');
    const imported = structuredClone(h.ctx);
    h.ctx = { ...h.ctx, direction: 'export', generation: 'export', path: PATH, source_url: TARGET + PREFIX + PATH, file: null };
    h.ctx.key = sha(h.ctx.source_url);
    const s = largeResponse(); h.read = () => ({ data: s.response, error: null });
    await failed(await handle(request('download', undefined, { 'x-transfer-object-key': h.ctx.key })), 422, 'INVALID_MEDIA');
    assert.equal(s.produced, MAX_MEDIA_BYTES + 64 * 1024); assert.equal(s.cancels, 1); assert.equal(s.ended, false);
    h.ctx = imported;
    const redirected = streamOf([JPEG]);
    h.read = () => ({ data: new Response(redirected.stream, { status: 302, headers: { location: 'http://127.0.0.1/' + SECRET } }), error: null });
    const beforeRedirect = expectedFetchCalls;
    await failed(await handle(request('recheck-import')), 502, 'TRANSFER_FAILED');
    assert.equal(expectedFetchCalls, beforeRedirect + 1); assert.equal(redirected.reads, 0); assert.equal(redirected.cancels, 1);
    const safePath = h.ctx.path; h.ctx.path = '../' + SECRET;
    await failed(await handle(request('recheck-import')), 502, 'TRANSFER_FAILED');
    assert.equal(expectedFetchCalls, beforeRedirect + 1, 'malicious authorized path never reaches raw fetch'); h.ctx.path = safePath;
    const initialFetches = expectedFetchCalls;
    globalThis.fetch.mock.mockImplementation(() => { expectedFetchCalls++; throw Error(`${SECRET} ${URL}`); });
    await failed(await handle(request('recheck-import')), 502, 'TRANSFER_FAILED');
    assert.equal(expectedFetchCalls, initialFetches + 1, 'raw fetch failure never retries');
  } finally {
    globalThis.fetch.mock.mockImplementation(denyFetch);
    delete globalThis[stateKey];
    if (previous) Object.defineProperty(globalThis, 'Deno', previous); else delete globalThis.Deno;
  }
});
