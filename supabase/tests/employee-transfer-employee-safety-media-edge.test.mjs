import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { after, afterEach, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { build } from 'esbuild';

const ORIGIN = 'https://employee-safety-fixture.supabase.co';
const id = n => `83000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ADMIN = id(1), TOKEN = id(2), SITE = id(3), JOB = id(4), EMPLOYEE = id(5);
const SITE_TOKEN = id(6), SECRET = 'never-echo-employee-media-diagnostics';
const sha = input => createHash('sha256').update(input).digest('hex');
const enc = text => new TextEncoder().encode(text);
const FINGERPRINT = sha('synthetic SQL46 records'), ROW_SHA = sha('synthetic row\n'), REF_SHA = sha('synthetic reference');
const AUTH = 'employee_safety_backup_media_authorize', COMMIT = 'employee_safety_backup_media_commit';
const KINDS = ['verification', 'chat', 'notifications', 'archives'];
const ACTIONS = ['download', 'recheck-export'];
const CONTEXT_KEYS = ['direction', 'key', 'bucket', 'path', 'source_url', 'file', 'generation', 'avatar', 'kind'];
const FLAGS = ['complete_employee_backup', 'can_archive', 'can_replace'];
const JPEG = Uint8Array.of(255, 216, 255, 0, 1, 2);
const MP4 = Uint8Array.from([0, 0, 0, 20, ...enc('ftypisom'), 0, 0, 0, 0, ...enc('mp42')]);
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, ...enc('webm')]);
const SAMPLES = [
  ['image/jpeg', JPEG], ['image/png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)],
  ['image/gif', enc('GIF87a-fixture')], ['image/gif', enc('GIF89a-fixture')],
  ['image/webp', enc('RIFF0000WEBP-fixture')], ['application/pdf', enc('%PDF-1.7-fixture')],
  ['video/mp4', MP4], ['video/webm', WEBM],
];
void mock.timers;
await nextTurn();
const logs = ['log', 'info', 'warn', 'error', 'debug', 'trace'].map(name => mock.method(console, name, () => {}));
mock.method(globalThis, 'fetch', () => assert.fail('No network or source_url fetch is allowed'));
const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);
after(async () => {
  await nextTurn();
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
  assert.deepEqual(unhandled, []);
  process.off('unhandledRejection', onUnhandled);
  mock.restoreAll();
});
const built = await build({ entryPoints: [new URL('../functions/employee-transfer-media/handler.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser' });
const { createEmployeeTransferMediaHandler: factory, MAX_MEDIA_BYTES, MAX_AVATAR_BYTES, MEDIA_DOWNLOAD_TIMEOUT_MS } =
  await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const tuple = (ctx, bytes = JPEG, type = 'image/jpeg') => ({ key: ctx.key, source_url: ctx.source_url,
  bytes: bytes.length, sha256: sha(bytes), content_type: type });
const receipt = (file, safety = true) => ({ success: true, key: file.key, bytes: file.bytes, sha256: file.sha256,
  content_type: file.content_type, full_site_complete: false,
  ...(safety ? { complete_employee_backup: false, can_archive: false, can_replace: false } : {}) });
function bind(ctx) {
  ctx.source_url = `employee-safety-media-v1:${SITE}:${JOB}:${EMPLOYEE}:${FINGERPRINT}:${ROW_SHA}:${REF_SHA}:${sha(ctx.bucket + '/' + ctx.path)}`;
  ctx.key = sha(ctx.source_url);
  if (ctx.file) Object.assign(ctx.file, { key: ctx.key, source_url: ctx.source_url });
}
const location = ctx => ctx.bucket + '/' + ctx.path;
const active = [];
afterEach(() => {
  for (const h of active.splice(0)) {
    assert.ok(!h.calls.some(c => ['upload', 'remove', 'update'].includes(c.op)));
    if (h.before) assert.deepEqual([...h.objects], h.before, 'Storage remains unchanged');
  }
});
function harness({ action = 'download', kind = 'verification', bucket, path, avatar = false, bytes = JPEG, type = 'image/jpeg', origin = ORIGIN } = {}) {
  const ctx = { direction: 'export', key: '', bucket: bucket ?? (kind === 'verification' ? 'verification-documents' :
    kind === 'archives' ? 'content-audit-evidence' : 'chat-images'),
  path: path ?? (kind === 'verification' ? `id-front/${EMPLOYEE}-fixture.jpg` : kind === 'archives' ? `${EMPLOYEE}/shared/0` : 'nested/fixture.JPG'),
  source_url: '', file: null, generation: FINGERPRINT, avatar, kind };
  bind(ctx);
  if (action !== 'download') ctx.file = tuple(ctx, bytes, type);
  const h = { ctx, action, bytes, type, scope: 'employee-safety', calls: [], objects: new Map([[location(ctx), bytes.slice()]]),
    allowed: [AUTH, COMMIT], authorize: null, commit: null, read: null };
  h.rpc = async (name, args) => {
    h.calls.push({ op: name, args: structuredClone(args) });
    assert.ok(h.allowed.includes(name), 'No fallback, task lifecycle, site, or business RPC');
    if (name.endsWith('_authorize')) return h.authorize ? h.authorize(args) : { data: structuredClone(h.ctx) };
    if (h.commit) return h.commit(args);
    return { data: receipt({ key: args.p_object_key, bytes: args.p_bytes, sha256: args.p_sha256, content_type: args.p_content_type }, h.scope === 'employee-safety') };
  };
  h.store = {
    async download(bucket, path, signal) {
      h.calls.push({ op: 'download', bucket, path, signal });
      assert.ok(signal instanceof AbortSignal);
      if (h.read) return h.read(bucket, path, signal);
      const stored = h.objects.get(bucket + '/' + path);
      return stored ? { data: new Response(stored, { headers: { 'content-type': 'text/html' } }) } : { error: { message: SECRET } };
    },
    upload() { h.calls.push({ op: 'upload' }); assert.fail('Export cannot upload'); },
    remove() { h.calls.push({ op: 'remove' }); assert.fail('Export cannot delete'); },
    update() { h.calls.push({ op: 'update' }); assert.fail('Export cannot overwrite'); },
  };
  h.handler = factory({ supabaseUrl: origin, rpc: h.rpc, store: h.store, crypto: webcrypto });
  active.push(h);
  return h;
}
function request(h, overrides = {}, init = {}) {
  h.before = structuredClone([...h.objects]);
  const headers = new Headers({ 'x-transfer-scope': h.scope, 'x-transfer-action': h.action,
    'x-admin-session-token': ADMIN, 'x-transfer-job-token': TOKEN, 'x-transfer-object-key': h.ctx.key });
  for (const [name, value] of Object.entries(overrides)) value === null ? headers.delete(name) : headers.set(name, value);
  return new Request('https://edge-fixture.invalid/media?bucket=ignored&path=ignored', { method: 'POST', headers, ...init });
}
const ops = h => h.calls.map(c => c.op);
async function failed(response, status = 502, code = 'TRANSFER_FAILED') {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { success: false, error: code });
  for (const secret of [SECRET, ADMIN, TOKEN, SITE_TOKEN, EMPLOYEE, SITE, JOB, ORIGIN, FINGERPRINT]) {
    assert.ok(!text.includes(secret));
    assert.ok(![...response.headers.values()].some(value => value.includes(secret)));
  }
}
async function contextDenied(h) {
  await failed(await h.handler(request(h)));
  assert.deepEqual(ops(h), [AUTH]);
}
function stream(chunks, cancel = () => {}) {
  const s = { reads: 0, cancels: 0 };
  s.body = new ReadableStream({
    pull(c) { const chunk = chunks[s.reads++]; if (chunk === undefined) c.close(); else c.enqueue(chunk); },
    cancel() { s.cancels++; return cancel(); },
  }, { highWaterMark: 0 });
  return s;
}
function defer() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

const variants = [
  ...['id-front', 'id-back', 'selfie'].map(folder => ({ kind: 'verification', bucket: 'verification-documents', path: `${folder}/${EMPLOYEE}-fixture.jpg` })),
  ...['chat', 'notifications'].flatMap(kind => ['announcement-images', 'chat-images', 'template-images'].map(bucket => ({ kind, bucket }))),
  { kind: 'chat', bucket: 'super-customer-avatars', path: 'avatars/fixture.jpg', avatar: true },
  { kind: 'chat', bucket: 'chat-images', avatar: true },
  { kind: 'archives' },
];
for (const variant of variants) for (const [type, bytes] of SAMPLES) for (const action of ACTIONS) {
  if ((variant.avatar && !type.startsWith('image/')) || (variant.kind === 'verification' && type.startsWith('video/')) ||
    (variant.kind === 'archives' && ['application/pdf', 'video/webm'].includes(type))) continue;
  test(`${action}: ${variant.kind}/${variant.bucket ?? 'content-audit-evidence'}/${variant.path ?? 'default'}/${variant.avatar ?? false} ${type}/${sha(bytes).slice(0, 8)} actual bytes`, async () => {
    const h = harness({ ...variant, action, type, bytes });
    const response = await h.handler(request(h));
    assert.equal(response.status, 200);
    if (action === 'download') {
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
      assert.equal(response.headers.get('content-type'), 'application/octet-stream');
      assert.equal(response.headers.get('content-disposition'), 'attachment');
      assert.equal(response.headers.get('x-transfer-sha256'), sha(bytes));
      assert.equal(response.headers.get('x-transfer-content-type'), type);
      assert.ok(![...response.headers.values()].some(value => value.includes(h.ctx.source_url) || value.includes(EMPLOYEE)));
    } else assert.deepEqual(await response.json(), receipt(tuple(h.ctx, bytes, type)));
    assert.deepEqual(ops(h), [AUTH, 'download', COMMIT]);
    assert.deepEqual(h.calls[0].args, { p_admin_session_token: ADMIN, p_job_token: TOKEN, p_action: action, p_object_key: h.ctx.key });
    assert.deepEqual(h.calls[2].args, { ...h.calls[0].args, p_bytes: bytes.length, p_sha256: sha(bytes), p_content_type: type,
      p_storage_origin: ORIGIN, p_generation: FINGERPRINT });
    assert.equal(h.calls[1].bucket, h.ctx.bucket); assert.equal(h.calls[1].path, h.ctx.path);
    assert.deepEqual(Object.keys(h.ctx).sort(), [...CONTEXT_KEYS].sort());
  });
}
test('repeat download validates an existing exact file tuple', async () => {
  const h = harness(); h.ctx.file = tuple(h.ctx);
  assert.equal((await h.handler(request(h))).status, 200);
  assert.deepEqual(ops(h), [AUTH, 'download', COMMIT]);
});
for (const action of ['upload', 'recheck-import', 'read', 'close', 'cancel', 'DOWNLOAD', 'download, upload', '']) test(`${action}: denied before any RPC or Storage`, async () => {
  const h = harness({ action });
  const s = stream([JPEG]);
  await failed(await h.handler(request(h, {}, { body: s.body, duplex: 'half' })), 400, 'INVALID_REQUEST');
  assert.deepEqual(h.calls, []); assert.equal(s.reads, 0); assert.equal(s.cancels, 1);
});
for (const scope of ['', 'employee-safety-media', 'employee_safety', 'Employee-Safety', 'employee-safety, chat', '__proto__', 'constructor']) test(`invalid explicit scope ${scope}`, async () => {
  const h = harness();
  await failed(await h.handler(request(h, { 'x-transfer-scope': scope })), 400, 'INVALID_REQUEST'); assert.deepEqual(h.calls, []);
});
for (const field of CONTEXT_KEYS) test(`context must contain ${field}`, async () => {
  const h = harness(), key = h.ctx.key; delete h.ctx[field];
  await failed(await h.handler(request(h, { 'x-transfer-object-key': key })));
  assert.deepEqual(ops(h), [AUTH]);
});
for (const [label, change] of [
  ['extra origin', c => c.origin = ORIGIN], ['extra scope', c => c.scope = 'employee-safety'], ['extra URL', c => c.url = SECRET],
  ['import direction', c => c.direction = 'import'], ['read direction', c => c.direction = 'read'], ['direction control suffix', c => c.direction += '\n'],
  ['wrong context key', c => c.key = 'f'.repeat(64)], ['null kind', c => c.kind = null], ['unknown kind', c => c.kind = 'employee-safety'],
  ['kind control suffix', c => c.kind += '\n'], ['null avatar', c => c.avatar = null], ['string avatar', c => c.avatar = 'false'],
  ['null source', c => c.source_url = null], ['null path', c => c.path = null], ['null bucket', c => c.bucket = null],
]) test(`strict context: ${label}`, async () => { const h = harness(); change(h.ctx); await contextDenied(h); });
for (const value of [null, undefined, [], {}, false, 'opaque']) test(`malformed context ${JSON.stringify(value)}`, async () => {
  const h = harness(); h.authorize = () => ({ data: value });
  await failed(await h.handler(request(h)), value == null ? 403 : 502, value == null ? 'NOT_AUTHORIZED' : 'TRANSFER_FAILED');
  assert.deepEqual(ops(h), [AUTH]);
});
for (const generation of [null, undefined, 0, '', '0', 'export', 'f'.repeat(64), FINGERPRINT.toUpperCase(), FINGERPRINT + '\n']) test(`generation must equal identity fingerprint ${JSON.stringify(generation)}`, async () => {
  const h = harness(); h.ctx.generation = generation; await contextDenied(h);
});
for (const kind of KINDS) for (const [label, mutate] of [
  ['public URL', () => ORIGIN + '/storage/v1/object/public/chat-images/a.jpg'],
  ['private URL', () => ORIGIN + '/storage/v1/object/content-audit-evidence/a'],
  ['external URL', () => 'https://evil.invalid/a.jpg'], ['metadata URL', () => 'http://169.254.169.254/latest/meta-data'],
  ['legacy identity', s => s.replace('employee-safety-media-v1:', 'archive-evidence-v1:')],
  ['wrong version', s => s.replace('-v1:', '-v2:')], ['query', s => s + '?token=secret'], ['fragment', s => s + '#secret'],
  ['missing component', s => s.slice(0, s.lastIndexOf(':'))], ['extra component', s => s + ':extra'],
  ...['\n', '\r', '\0', '\t', '\u007f', '\u2028', '\u2029', ' '].map(suffix => ['suffix ' + JSON.stringify(suffix), s => s + suffix]),
  ...[1, 2, 3, 4, 5, 6, 7].map(index => ['invalid identity component ' + index, s => { const parts = s.split(':'); parts[index] = index <= 3 ? 'not-a-uuid' : 'a'.repeat(63); return parts.join(':'); }]),
]) test(`${kind}: ${label} rejected even with recomputed object key`, async () => {
  const h = harness({ kind }); h.ctx.source_url = mutate(h.ctx.source_url); h.ctx.key = sha(h.ctx.source_url); await contextDenied(h);
});
for (const part of [1, 2, 3, 4, 5, 6, 7]) test(`identity component ${part} tamper without recomputing key`, async () => {
  const h = harness(); const parts = h.ctx.source_url.split(':'); parts[part] = part <= 3 ? id(99) : sha('other'); h.ctx.source_url = parts.join(':');
  await contextDenied(h);
});
for (const kind of KINDS) test(`${kind}: key is real SHA-256 of opaque identity, not a caller-supplied digest`, async () => {
  const h = harness({ kind }); h.ctx.key = 'a'.repeat(64); await contextDenied(h);
});
for (const kind of KINDS) for (const field of ['bucket', 'path']) test(`${kind}: ${field} drift must match bucket/path digest`, async () => {
  const h = harness({ kind }); h.ctx[field] = field === 'bucket' ? 'template-images' : h.ctx.path.replace('fixture', 'different').replace('/0', '/1');
  await contextDenied(h);
});
test('verification ownership is bound to identity employee UUID, not just a valid UUID filename', async () => {
  const h = harness({ path: `id-front/${id(99)}-fixture.jpg` }); await contextDenied(h);
});
test('verification identity employee tamper with recomputed key still cannot read another employee path', async () => {
  const h = harness(); h.ctx.source_url = h.ctx.source_url.replace(EMPLOYEE, id(99)); h.ctx.key = sha(h.ctx.source_url); await contextDenied(h);
});
const unsafePaths = ['../file.jpg', '/file.jpg', 'a//file.jpg', 'a/./file.jpg', 'a/../file.jpg', 'a/file..jpg',
  'a/%2e%2e/file.jpg', 'a/%2Ffile.jpg', 'a\\file.jpg', 'a/file.jpg?token=secret', 'a/file.jpg#secret', 'a/file name.jpg',
  'a/中文.jpg', 'a/file+name.jpg', 'a/file&name.jpg', 'a/file.jpg/',
  ...['\n', '\r', '\0', '\t', '\u007f', '\u2028', '\u2029', ' '].map(s => 'a/file.jpg' + s)];
for (const kind of KINDS) for (const path of unsafePaths) test(`${kind}: rejects fully hash-bound unsafe path ${JSON.stringify(path)}`, async () => {
  const h = harness({ kind, path }); await contextDenied(h);
});
for (const kind of ['verification', 'chat', 'notifications']) for (const suffix of ['', '.', '.abcdefghi', '.jpg.exe123456', '.jpg\n', '.jpg\u2028']) test(`${kind}: public path requires a strict 1-8 character extension ${JSON.stringify(suffix)}`, async () => {
  const path = (kind === 'verification' ? `selfie/${EMPLOYEE}-fixture` : 'a/fixture') + suffix;
  const h = harness({ kind, path }); await contextDenied(h);
});
for (const path of ['unknown/' + EMPLOYEE + '-fixture.jpg', `id-front/${EMPLOYEE}/fixture.jpg`, `id-front/${EMPLOYEE}fixture.jpg`, `id-front/${EMPLOYEE}-${'x'.repeat(90)}.jpg`]) test(`strict verification filename ${path.length}`, async () => {
  await contextDenied(harness({ path }));
});
for (const kind of KINDS) for (const bucket of ['', 'other', 'CHAT-IMAGES', 'chat-images/../template-images']) test(`${kind}: disallowed bucket ${bucket}`, async () => {
  await contextDenied(harness({ kind, bucket }));
});
for (const [kind, bucket] of [['verification', 'chat-images'], ['chat', 'verification-documents'], ['chat', 'content-audit-evidence'],
  ['notifications', 'super-customer-avatars'], ['notifications', 'content-audit-evidence'], ['archives', 'chat-images'], ['archives', 'verification-documents']]) test(`${kind} cannot borrow bucket ${bucket}`, async () => {
  await contextDenied(harness({ kind, bucket }));
});
for (const kind of ['verification', 'notifications', 'archives']) test(`${kind} must not enable avatar usage`, async () => {
  await contextDenied(harness({ kind, avatar: true }));
});
for (const [path, avatar] of [['other/fixture.jpg', true], ['avatars/fixture.jpg', false], ['avatars-fixture.jpg', true]]) test(`super-customer-avatars requires avatars/ and true (${path}/${avatar})`, async () => {
  await contextDenied(harness({ kind: 'chat', bucket: 'super-customer-avatars', path, avatar }));
});
for (const [kind, limit, path] of [
  ['verification', 128, n => `id-front/${EMPLOYEE}-${'a'.repeat(n - 41)}.jpg`],
  ['chat', 1024, n => 'a'.repeat(n - 4) + '.jpg'], ['notifications', 1024, n => 'a'.repeat(n - 4) + '.jpg'],
  ['archives', 512, n => 'a'.repeat(n)],
]) for (const excess of [0, 1]) test(`${kind}: path size ${limit + excess} ${excess ? 'rejected' : 'inclusive'}`, async () => {
  const h = harness({ kind, path: path(limit + excess) });
  if (excess) await contextDenied(h);
  else { h.objects.set(location(h.ctx), JPEG); assert.equal((await h.handler(request(h))).status, 200); }
});
for (const origin of ['http://fixture.supabase.co', 'https://evil.invalid', ORIGIN + ':443', ORIGIN + '?secret', ORIGIN + '\n',
  'https://user:pass@employee-safety-fixture.supabase.co', 'https://127.0.0.1', ORIGIN + '.evil.invalid', ORIGIN + '/storage', ORIGIN + '//']) test(`invalid configured Storage origin ${JSON.stringify(origin)}`, async () => {
  const h = harness({ origin }); await failed(await h.handler(request(h)), 500); assert.deepEqual(h.calls, []);
});
test('configured origin with single trailing slash stays fixed at commit', async () => {
  const h = harness({ origin: ORIGIN + '/' }); assert.equal((await h.handler(request(h))).status, 200);
  assert.equal(h.calls.at(-1).args.p_storage_origin, ORIGIN);
});
for (const [field, values] of [
  ['key', [null, 'f'.repeat(64)]], ['source_url', [null, 'https://evil.invalid/file']],
  ['bytes', [0, -1, 1.5, '6', null, MAX_MEDIA_BYTES + 1, Number.MAX_SAFE_INTEGER + 1]],
  ['sha256', [null, 'A'.repeat(64), 'a'.repeat(63), sha(JPEG) + '\n']],
  ['content_type', [null, 'text/html', 'image/svg+xml', 'IMAGE/JPEG', 'image/jpeg; charset=utf-8', 'image/jpeg\n']],
]) for (const value of values) test(`strict file tuple ${field}=${JSON.stringify(value)}`, async () => {
  const h = harness({ action: 'recheck-export' }); h.ctx.file[field] = value; await contextDenied(h);
});
for (const field of ['key', 'source_url', 'bytes', 'sha256', 'content_type']) test(`file tuple requires ${field}`, async () => {
  const h = harness({ action: 'recheck-export' }); delete h.ctx.file[field]; await contextDenied(h);
});
test('file tuple rejects extra properties', async () => {
  const h = harness(); h.ctx.file = { ...tuple(h.ctx), extra: SECRET }; await contextDenied(h);
});
test('recheck-export cannot authorize null initial file', async () => {
  const h = harness({ action: 'recheck-export' }); h.ctx.file = null; await contextDenied(h);
});
for (const [kind, type, bytes, avatar] of [
  ['verification', 'video/mp4', MP4, false], ['verification', 'video/webm', WEBM, false],
  ['archives', 'application/pdf', enc('%PDF-1.7'), false], ['archives', 'video/webm', WEBM, false],
  ['chat', 'application/pdf', enc('%PDF-1.7'), true], ['chat', 'video/mp4', MP4, true], ['chat', 'video/webm', WEBM, true],
]) for (const action of ACTIONS) test(`${action}: effective ${kind} avatar=${avatar} denies ${type}`, async () => {
  const h = harness({ action, kind, type, bytes, avatar });
  await failed(await h.handler(request(h)), action === 'download' ? 422 : 502, action === 'download' ? 'INVALID_MEDIA' : 'TRANSFER_FAILED');
  assert.deepEqual(ops(h), action === 'download' ? [AUTH, 'download'] : [AUTH]);
});
for (const kind of KINDS) for (const bytes of [new Uint8Array(), enc('<script>fake media</script>'), JPEG.subarray(0, 2), enc('RIFF0000WAVE')]) test(`${kind}: actual invalid magic/empty bytes ${sha(bytes)}`, async () => {
  const h = harness({ kind, bytes }); await failed(await h.handler(request(h)), 422, 'INVALID_MEDIA'); assert.deepEqual(ops(h), [AUTH, 'download']);
});
for (const kind of KINDS) for (const action of ACTIONS) for (const drift of ['bytes', 'size', 'type', 'missing']) test(`${kind}/${action}: actual ${drift} drift never commits`, async () => {
  const h = harness({ kind, action }); h.ctx.file = tuple(h.ctx);
  const data = drift === 'bytes' ? Uint8Array.of(255, 216, 255, 9, 9, 9) : drift === 'size' ? JPEG.subarray(0, 5) : SAMPLES[1][1];
  h.objects.set(location(h.ctx), data);
  if (drift === 'missing') h.read = () => ({ data: null, error: { message: SECRET } });
  await failed(await h.handler(request(h)), drift === 'missing' ? 502 : 422, drift === 'missing' ? 'TRANSFER_FAILED' : 'INVALID_MEDIA');
  assert.deepEqual(ops(h), [AUTH, 'download']);
});
for (const [avatar, max] of [[false, MAX_MEDIA_BYTES], [true, MAX_AVATAR_BYTES]]) for (const excess of [0, 1]) test(`${avatar ? 'avatar' : 'ordinary'} actual byte limit ${max + excess}`, async () => {
  const bytes = new Uint8Array(max + excess); bytes.set(JPEG);
  const h = harness({ kind: 'chat', avatar, bytes }); const response = await h.handler(request(h));
  if (excess) { await failed(response, 422, 'INVALID_MEDIA'); assert.deepEqual(ops(h), [AUTH, 'download']); }
  else { assert.equal(response.status, 200); assert.equal((await response.arrayBuffer()).byteLength, max); assert.equal(h.calls.at(-1).args.p_sha256, sha(bytes)); }
});
test('avatar tuple over 5MiB is rejected before Storage', async () => {
  const h = harness({ kind: 'chat', avatar: true, action: 'recheck-export' }); h.ctx.file.bytes = MAX_AVATAR_BYTES + 1; await contextDenied(h);
});
for (const [headers, status] of [
  [{ 'content-range': 'bytes 0-5/12' }, 502], [{ 'content-encoding': 'gzip' }, 502],
  [{ 'content-length': `${MAX_MEDIA_BYTES + 1}` }, 422], [{ 'content-length': '0' }, 422],
  [{ 'content-length': '01' }, 502], [{ 'content-length': `${JPEG.length + 1}` }, 422],
]) test(`bounded download validates Storage headers ${JSON.stringify(headers)}`, async () => {
  const h = harness({ action: 'recheck-export' }), s = stream([JPEG]); h.read = () => ({ data: new Response(s.body, { headers }) });
  await failed(await h.handler(request(h)), status, status === 422 ? 'INVALID_MEDIA' : 'TRANSFER_FAILED');
  assert.equal(s.reads, 0); assert.equal(s.cancels, 1); assert.deepEqual(ops(h), [AUTH, 'download']);
});
test('actual stream overflow stops at first excess chunk without draining untrusted tail', { timeout: 2000 }, async () => {
  const h = harness({ action: 'recheck-export' }), s = stream([JPEG, Uint8Array.of(1), new Uint8Array(1024)], () => new Promise(() => {}));
  h.read = () => ({ data: new Response(s.body) }); await failed(await h.handler(request(h)), 422, 'INVALID_MEDIA');
  assert.equal(s.reads, 2); assert.equal(s.cancels, 1); assert.deepEqual(ops(h), [AUTH, 'download']);
});
for (const action of ACTIONS) for (const phase of ['authorize', 'download', 'commit']) for (const thrown of [false, true]) test(`${action}: ${phase} ${thrown ? 'throws' : 'returns'} service error without diagnostics/retry`, async () => {
  const h = harness({ action }); h[{ authorize: 'authorize', download: 'read', commit: 'commit' }[phase]] = () => {
    if (thrown) throw Error(`${SECRET} ${ADMIN} ${h.ctx.source_url}`);
    return { error: { message: SECRET, details: h.ctx.source_url, token: TOKEN } };
  };
  await failed(await h.handler(request(h)), phase === 'authorize' && !thrown ? 403 : 502, phase === 'authorize' && !thrown ? 'NOT_AUTHORIZED' : 'TRANSFER_FAILED');
  assert.deepEqual(ops(h), phase === 'authorize' ? [AUTH] : phase === 'download' ? [AUTH, 'download'] : [AUTH, 'download', COMMIT]);
});
for (const flag of FLAGS) for (const value of [undefined, true, null, 0, 'false']) for (const action of ACTIONS) test(`${action}: receipt ${flag} must be explicit false (${JSON.stringify(value)})`, async () => {
  const h = harness({ action }); h.commit = () => { const data = receipt(tuple(h.ctx)); if (value === undefined) delete data[flag]; else data[flag] = value; return { data }; };
  await failed(await h.handler(request(h))); assert.deepEqual(ops(h), [AUTH, 'download', COMMIT]);
});
for (const field of ['success', 'key', 'bytes', 'sha256', 'content_type', 'full_site_complete', 'extra', 'missing']) test(`commit receipt strict base contract ${field}`, async () => {
  const h = harness(); h.commit = () => { const data = receipt(tuple(h.ctx));
    if (field === 'missing') delete data.sha256;
    else data[field] = { success: false, key: SECRET, bytes: JPEG.length + 1, sha256: sha('other'), content_type: 'image/png', full_site_complete: true, extra: SECRET }[field];
    return { data };
  };
  await failed(await h.handler(request(h))); assert.deepEqual(ops(h), [AUTH, 'download', COMMIT]);
});
for (const action of ACTIONS) test(`${action}: commit response loss emits no bytes or success and is never retried`, async () => {
  const h = harness({ action }); let serverCommits = 0;
  h.commit = () => { serverCommits++; throw Error(SECRET); };
  await failed(await h.handler(request(h))); assert.equal(serverCommits, 1); assert.deepEqual(ops(h), [AUTH, 'download', COMMIT]);
});
for (const action of ACTIONS) test(`${action}: commit keeps original generation when records change during read`, async () => {
  const h = harness({ action }), started = defer(), release = defer(); let committed = false;
  h.read = async () => { started.resolve(); await release.promise; return { data: new Response(JPEG) }; };
  h.commit = args => { if (args.p_generation !== h.ctx.generation) return { error: { message: SECRET } }; committed = true; return { data: receipt(tuple(h.ctx)) }; };
  const pending = h.handler(request(h)); await started.promise; h.ctx.generation = sha('changed records'); release.resolve();
  await failed(await pending); assert.equal(committed, false); assert.equal(h.calls.at(-1).args.p_generation, FINGERPRINT);
  assert.deepEqual(ops(h), [AUTH, 'download', COMMIT]);
});
test('commit waits until the entire actual stream is read', { timeout: 2000 }, async () => {
  const h = harness(), started = defer(), release = defer(); let stage = 0, ended = false;
  h.read = () => ({ data: new Response(new ReadableStream({ async pull(c) {
    if (stage++ === 0) { c.enqueue(JPEG); started.resolve(); }
    else { await release.promise; ended = true; c.close(); }
  } }, { highWaterMark: 0 })) });
  h.commit = () => { assert.equal(ended, true); return { data: receipt(tuple(h.ctx)) }; };
  const pending = h.handler(request(h)); await started.promise; await nextTurn(); assert.deepEqual(ops(h), [AUTH, 'download']); release.resolve();
  const response = await pending; assert.equal(response.status, 200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), JPEG);
});
for (const action of ACTIONS) test(`${action}: independent SQL46 token is passed unchanged; site token rejection has no fallback`, async () => {
  const h = harness({ action }); h.authorize = args => args.p_job_token === TOKEN ? { data: structuredClone(h.ctx) } : { error: { message: SECRET } };
  await failed(await h.handler(request(h, { 'x-transfer-job-token': SITE_TOKEN })), 403, 'NOT_AUTHORIZED');
  assert.equal(h.calls[0].args.p_job_token, SITE_TOKEN); assert.deepEqual(ops(h), [AUTH]);
});
for (const action of ACTIONS) for (const reason of ['expired', 'cancelled', 'wrong employee', 'wrong owner', 'wrong object']) test(`${action}: SQL denies ${reason} without Storage or fallback`, async () => {
  const h = harness({ action }); h.authorize = () => ({ data: null, error: { message: SECRET, reason } });
  await failed(await h.handler(request(h)), 403, 'NOT_AUTHORIZED'); assert.deepEqual(ops(h), [AUTH]);
});
for (const phase of ['headers', 'body']) for (const cause of ['deadline', 'abort']) test(`${cause} during ${phase} shares existing 90s bounded download`, { timeout: 2000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); assert.equal(MEDIA_DOWNLOAD_TIMEOUT_MS, 90_000);
  const h = harness(), started = defer(), reading = defer(), headers = defer(), controller = new AbortController(); let cancels = 0;
  const body = new ReadableStream({ pull() { reading.resolve(); }, cancel() { cancels++; return new Promise(() => {}); } }, { highWaterMark: 0 });
  h.read = (_b, _p, signal) => { started.resolve(signal);
    return phase === 'headers' ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error(SECRET)), { once: true })) : headers.promise;
  };
  const pending = h.handler(request(h, {}, { signal: controller.signal })); const signal = await started.promise;
  t.mock.timers.tick(89_999); assert.equal(signal.aborted, false);
  if (phase === 'body') { headers.resolve({ data: new Response(body) }); await reading.promise; }
  if (cause === 'deadline') t.mock.timers.tick(1); else controller.abort(Error(SECRET));
  await failed(await pending); assert.equal(signal.aborted, true); assert.equal(cancels, phase === 'body' ? 1 : 0);
  assert.deepEqual(ops(h), [AUTH, 'download']);
});
test('pre-aborted request cannot authorize or read', async () => {
  const h = harness(), controller = new AbortController(); controller.abort();
  await failed(await h.handler(request(h, {}, { signal: controller.signal })), 400, 'INVALID_REQUEST'); assert.deepEqual(h.calls, []);
});
test('abort during commit cannot turn an uncertain receipt into success', async () => {
  const h = harness(), controller = new AbortController(); h.commit = () => { controller.abort(); return { data: receipt(tuple(h.ctx)) }; };
  await failed(await h.handler(request(h, {}, { signal: controller.signal }))); assert.deepEqual(ops(h), [AUTH, 'download', COMMIT]);
});
for (const header of ['x-admin-session-token', 'x-transfer-job-token', 'x-transfer-object-key']) for (const value of [null, '', 'invalid', 'a'.repeat(63), 'A'.repeat(64)]) test(`invalid request ${header} ${JSON.stringify(value)}`, async () => {
  const h = harness(); await failed(await h.handler(request(h, { [header]: value })), 400, 'INVALID_REQUEST'); assert.deepEqual(h.calls, []);
});
for (const headers of [{ 'content-length': '1' }, { 'content-length': '01' }, { 'content-encoding': 'identity' }, { 'content-range': 'bytes 0-1/2' }]) test(`reject request framing before RPC ${JSON.stringify(headers)}`, async () => {
  const h = harness(); const oversized = headers['content-length'] === '1';
  await failed(await h.handler(request(h, headers)), oversized ? 413 : 400, oversized ? 'BODY_TOO_LARGE' : 'INVALID_REQUEST'); assert.deepEqual(h.calls, []);
});
test('nonempty request stream cannot become an alternate path or upload', async () => {
  const h = harness(), s = stream([enc('../secret')]);
  await failed(await h.handler(request(h, {}, { body: s.body, duplex: 'half' })), 413, 'BODY_TOO_LARGE'); assert.deepEqual(ops(h), [AUTH]);
});
test('caller path, bucket, origin, generation and RPC selectors are ignored', async () => {
  const h = harness({ kind: 'archives' }); assert.equal((await h.handler(request(h, { 'x-transfer-path': '../secret', 'x-transfer-url': 'http://127.0.0.1',
    'x-transfer-bucket': 'verification-documents', 'x-transfer-rpc': 'employee_transfer_archive_media_read_authorize', 'x-transfer-generation': sha('other') }))).status, 200);
  assert.deepEqual(ops(h), [AUTH, 'download', COMMIT]); assert.equal(h.calls[1].path, h.ctx.path); assert.equal(h.calls.at(-1).args.p_storage_origin, ORIGIN);
});
const legacyRpcs = {
  verification: ['employee_transfer_verification_media_authorize', 'employee_transfer_verification_media_commit'],
  notifications: ['employee_transfer_notification_media_authorize', 'employee_transfer_notification_media_commit'],
  chat: ['employee_transfer_chat_media_authorize', 'employee_transfer_chat_media_commit'],
  archives: ['employee_transfer_archive_media_authorize', 'employee_transfer_archive_media_commit'],
};
function legacyContext(kind) {
  const h = harness({ kind }); const ctx = structuredClone(h.ctx); delete ctx.kind; delete ctx.avatar;
  ctx.generation = kind === 'archives' ? sha('legacy generation') : kind === 'chat' ? '0' : 'export';
  ctx.source_url = kind === 'archives' ? `archive-evidence-v1:${SITE}:${JOB}:${EMPLOYEE}:${ROW_SHA}:${REF_SHA}:${sha(ctx.path)}` : ORIGIN + '/storage/v1/object/public/' + location(ctx);
  ctx.key = sha(ctx.source_url); if (kind === 'chat') ctx.avatar = false;
  return { h, ctx };
}
for (const kind of KINDS) test(`new scope refuses legacy ${kind} context without fallback`, async () => {
  const { h, ctx } = legacyContext(kind); h.ctx = ctx; await contextDenied(h);
});
for (const kind of KINDS) test(`legacy ${kind} scope refuses new context, using only its original RPC`, async () => {
  const h = harness({ kind }); h.scope = kind; h.allowed = legacyRpcs[kind];
  await failed(await h.handler(request(h))); assert.deepEqual(ops(h), [legacyRpcs[kind][0]]);
});
for (const kind of KINDS) test(`legacy ${kind} rejects opaque new identity even with legacy context shape/generation`, async () => {
  const h = harness({ kind }); h.scope = kind; h.allowed = legacyRpcs[kind]; delete h.ctx.kind;
  if (kind !== 'chat') delete h.ctx.avatar;
  h.ctx.generation = kind === 'archives' ? FINGERPRINT : kind === 'chat' ? '0' : 'export';
  await failed(await h.handler(request(h))); assert.deepEqual(ops(h), [legacyRpcs[kind][0]]);
});
for (const kind of KINDS) test(`legacy ${kind} still accepts its exact original six-field receipt without new flags`, async () => {
  const { h, ctx } = legacyContext(kind); h.ctx = ctx; h.action = 'recheck-export'; h.ctx.file = tuple(h.ctx); h.scope = kind; h.allowed = legacyRpcs[kind];
  const response = await h.handler(request(h)); assert.equal(response.status, 200); assert.deepEqual(await response.json(), receipt(h.ctx.file, false));
  assert.deepEqual(ops(h), [legacyRpcs[kind][0], 'download', legacyRpcs[kind][1]]);
});
for (const kind of KINDS) test(`legacy ${kind} does not silently accept employee-safety receipt fields`, async () => {
  const { h, ctx } = legacyContext(kind); h.ctx = ctx; h.scope = kind; h.allowed = legacyRpcs[kind]; h.commit = () => ({ data: receipt(tuple(h.ctx)) });
  await failed(await h.handler(request(h))); assert.deepEqual(ops(h), [legacyRpcs[kind][0], 'download', legacyRpcs[kind][1]]);
});
test('missing scope still selects verification, never employee-safety', async () => {
  const h = harness(); h.allowed = legacyRpcs.verification;
  await failed(await h.handler(request(h, { 'x-transfer-scope': null }))); assert.deepEqual(ops(h), [legacyRpcs.verification[0]]);
});
