import assert from 'node:assert/strict';
import { test, mock, after } from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { build } from 'esbuild';

mock.method(globalThis, 'fetch', () => assert.fail('No network or opaque-identity URL fetch is allowed'));
after(() => { assert.equal(globalThis.fetch.mock.callCount(), 0);mock.restoreAll(); });
const built = await build({ entryPoints: [new URL('../functions/employee-transfer-media/handler.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { createEmployeeTransferMediaHandler: factory } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const AUTH = 'employee_transfer_archive_media_authorize', COMMIT = 'employee_transfer_archive_media_commit', READ = 'employee_transfer_archive_media_read_authorize';
const id = n => `82000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ADMIN = id(1), JOB = id(2), SITE = id(3), PACKAGE = id(4), EVENT = id(5), REF = 'original-opaque-ref';
const PATH = `${id(6)}/shared/0`, sha = input => createHash('sha256').update(input).digest('hex');
const SOURCE = `archive-evidence-v1:${SITE}:${PACKAGE}:${EVENT}:${'a'.repeat(64)}:${sha(REF)}:${sha(PATH)}`, KEY = sha(SOURCE);
const JPEG = Uint8Array.of(255, 216, 255, 0, 0), enc = text => new TextEncoder().encode(text);
const SAMPLES = [
  ['image/jpeg', JPEG], ['image/png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)],
  ['image/gif', enc('GIF89a-synthetic')], ['image/webp', enc('RIFF0000WEBP-synthetic')],
  ['video/mp4', Uint8Array.from([0, 0, 0, 20, ...enc('ftypisom'), 0, 0, 0, 0, ...enc('mp42')])],
];
const receipt = f => ({ success: true, key: f.key, bytes: f.bytes, sha256: f.sha256, content_type: f.content_type, full_site_complete: false });
function harness(action = 'download', bytes = JPEG, type = 'image/jpeg') {
  const file = { key: KEY, source_url: SOURCE, bytes: bytes.length, sha256: sha(bytes), content_type: type };
  const h = { action, bytes, file, calls: [], objects: new Map(), authorize: null, commit: null, download: null, upload: null };
  h.ctx = { direction: action === 'read' ? 'read' : ['download', 'recheck-export'].includes(action) ? 'export' : 'import', key: KEY,
    source_url: SOURCE, bucket: 'content-audit-evidence', path: ['download', 'recheck-export'].includes(action) ? PATH : `transfer-archives/${JOB}/${KEY}`,
    file: action === 'download' ? null : file, generation: 'b'.repeat(64) };
  h.objects.set(h.ctx.path, bytes);
  h.handler = factory({ supabaseUrl: 'https://fixture.supabase.co', crypto: webcrypto,
    rpc: async (name, args) => { h.calls.push({ op: name, args });
      if (name === COMMIT) return h.commit ? h.commit(args) : { data: receipt(file) };
      return h.authorize ? h.authorize(args) : { data: structuredClone(h.ctx) };
    },
    store: {
      async download(bucket, path, signal) { h.calls.push({ op: 'download', bucket, path, signal });
        return h.download ? h.download(bucket, path, signal) : { data: new Response(h.objects.get(path)) };
      },
      async upload(bucket, path, bytes, options) { h.calls.push({ op: 'upload', bucket, path, options });
        if (h.upload) return h.upload(bucket, path, bytes, options);
        if (h.objects.has(path)) return { error: { statusCode: '409' } };h.objects.set(path, bytes.slice());return { data: {} };
      },
    },
  });
  h.request = (headers = {}, body) => new Request('https://edge.invalid/private?path=ignored', { method: 'POST', headers: {
    'x-transfer-scope': 'archives', 'x-transfer-action': h.action, 'x-admin-session-token': ADMIN,
    ...(h.action === 'read' ? {} : { 'x-transfer-job-token': JOB, 'x-transfer-object-key': KEY }), ...headers,
  }, body: body ?? (h.action === 'read' ? JSON.stringify({ source_site_id: SITE, package_id: PACKAGE, event_id: EVENT, ref_key: REF }) : h.action === 'upload' ? bytes : undefined) });
  return h;
}
const ops = h => h.calls.map(c => c.op);
async function failed(response, status = 502) {
  assert.equal(response.status, status);assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();assert.equal(JSON.parse(body).success, false);
  for (const secret of [ADMIN, JOB, SITE, SOURCE, REF, 'private-backend-secret']) assert.ok(!body.includes(secret));
}
for (const [type, bytes] of SAMPLES) for (const action of ['download', 'recheck-export', 'upload', 'recheck-import', 'read']) test(`${action}: private ${type} actual digest and readback`, async () => {
  const h = harness(action, bytes, type), response = await h.handler(h.request());assert.equal(response.status, 200);
  if (action === 'read' || action === 'download') {
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);assert.equal(response.headers.get('x-transfer-sha256'), sha(bytes));
    assert.equal(response.headers.get('content-type'), action === 'read' ? type : 'application/octet-stream');
  } else assert.deepEqual(await response.json(), receipt(h.file));
  assert.deepEqual(ops(h), action === 'read' ? [READ, 'download', READ] : action === 'upload' ? [AUTH, 'upload', 'download', COMMIT] : [AUTH, 'download', COMMIT]);
  assert.ok(h.calls.filter(c => c.bucket).every(c => c.bucket === 'content-audit-evidence' && c.path === h.ctx.path));
  if (action === 'upload') assert.deepEqual(h.calls[1].options, { upsert: false, contentType: type });
});
for (const action of ['download', 'upload', 'read']) for (const [label, mutate] of [
  ['public bucket', c => c.bucket = 'chat-images'], ['URL source', c => c.source_url = 'https://evil.invalid/file'],
  ['source URL with query', c => c.source_url += '?token=secret'], ['wrong object key', c => c.key = 'f'.repeat(64)],
  ['dotdot', c => c.path = '../private'], ['encoded traversal', c => c.path = '%2e%2e/private'],
  ['backslash', c => c.path = 'a\\b'], ['extra field', c => c.signed_url = 'https://evil.invalid'],
  ['bad generation', c => c.generation = '1'], ['unknown MIME', c => { c.file = { ...harness('upload').file, content_type: 'text/html' }; }],
]) test(`${action}: rejects ${label} authorization before Storage`, async () => {
  const h = harness(action);mutate(h.ctx);await failed(await h.handler(h.request()));assert.deepEqual(ops(h), [action === 'read' ? READ : AUTH]);
});
for (const action of ['upload', 'read']) for (const path of [PATH, `transfer-archives/${JOB}/${'f'.repeat(64)}`, `transfer-notifications/${JOB}/${KEY}`, `transfer-archives/${JOB}/${KEY}/child`]) test(`${action} never targets legacy/foreign path ${path}`, async () => {
  const h = harness(action);h.ctx.path = path;await failed(await h.handler(h.request()));assert.equal(h.calls.length, 1);
});
for (const type of ['application/pdf', 'video/webm', 'image/svg+xml']) for (const action of ['upload', 'read']) test(`${action}: archives rejects MIME ${type}`, async () => {
  const h = harness(action, enc('%PDF-1.7'), type);await failed(await h.handler(h.request()));assert.equal(h.calls.length, 1);
});
for (const bytes of [enc('%PDF-1.7'), enc('<svg>'), Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), enc('fake-png')]) test(`download rejects disallowed or forged actual bytes ${sha(bytes)}`, async () => {
  const h = harness('download', bytes);await failed(await h.handler(h.request()), 422);assert.deepEqual(ops(h), [AUTH, 'download']);
});
test('source private path must hash to the opaque identity, never URL fetch or arbitrary private read', async () => {
  const h = harness();h.ctx.path = `${JOB}/shared/99`;await failed(await h.handler(h.request()));assert.deepEqual(ops(h), [AUTH]);
});
for (const mutation of [b => b.path = PATH, b => b.source_site_id = JOB, b => b.package_id = JOB, b => b.event_id = JOB, b => b.ref_key = 'another-ref']) test(`read binding refuses request/path tampering ${mutation}`, async () => {
  const h = harness('read'), body = { source_site_id: SITE, package_id: PACKAGE, event_id: EVENT, ref_key: REF };mutation(body);
  await failed(await h.handler(h.request({}, JSON.stringify(body))), 'path' in body ? 400 : 502);assert.ok(!ops(h).includes('download'));
});
test('read performs a second super-admin/namespace check after actual bytes; revoked session emits no Blob', async () => {
  const h = harness('read');let n = 0;h.authorize = () => ++n === 1 ? { data: h.ctx } : { error: { message: 'private-backend-secret' } };
  await failed(await h.handler(h.request()), 403);assert.deepEqual(ops(h), [READ, 'download', READ]);
});
test('read second sidecar generation drift rejects; no commit or signed URL', async () => {
  const h = harness('read');let n = 0;h.authorize = () => ({ data: { ...h.ctx, generation: ++n === 1 ? 'b'.repeat(64) : 'c'.repeat(64) } });
  await failed(await h.handler(h.request()), 403);assert.deepEqual(ops(h), [READ, 'download', READ]);
});
test('upload response lost after object write: no delete, overwrite, commit or automatic retry', async () => {
  const h = harness('upload');h.objects.clear();h.upload = (_b, path, bytes) => { h.objects.set(path, bytes.slice());throw Error('private-backend-secret'); };
  await failed(await h.handler(h.request()));assert.equal(h.objects.size, 1);assert.deepEqual(ops(h), [AUTH, 'upload']);
});
test('occupied path is never overwritten; only exact actual readback permits a receipt', async () => {
  const h = harness('upload');h.objects.set(h.ctx.path, Uint8Array.of(255, 216, 255, 9, 9));
  await failed(await h.handler(h.request()), 422);assert.deepEqual(ops(h), [AUTH, 'upload', 'download']);
});
test('corrupted readback blocks commit; valid upload receipt cannot substitute for actual reading', async () => {
  const h = harness('upload');h.objects.clear();h.download = () => ({ data: new Response(Uint8Array.of(255, 216, 255, 9, 9)) });
  await failed(await h.handler(h.request()), 422);assert.deepEqual(ops(h), [AUTH, 'upload', 'download']);
});
test('commit unknown response stays unknown, does not reauthorize or retry', async () => {
  const h = harness('upload');h.commit = () => { throw Error('private-backend-secret'); };await failed(await h.handler(h.request()));
  assert.deepEqual(ops(h), [AUTH, 'upload', 'download', COMMIT]);
});
for (const scope of ['verification', 'notifications', 'chat']) test(`old ${scope} scope cannot accept archives context or read`, async () => {
  const h = harness('download');await failed(await h.handler(h.request({ 'x-transfer-scope': scope })));assert.ok(!ops(h).includes('download'));
  const read = harness('read');await failed(await read.handler(read.request({ 'x-transfer-scope': scope })), 400);assert.deepEqual(read.calls, []);
});
for (const bytes of [new Uint8Array(), new Uint8Array(50 * 1024 * 1024 + 1)]) test(`download rejects empty/oversized actual Storage ${bytes.length}`, async () => {
  const h = harness('download', bytes);await failed(await h.handler(h.request()), 422);assert.deepEqual(ops(h), [AUTH, 'download']);
});
for (const action of ['download', 'upload', 'read']) test(`${action}: 50MiB inclusive exact actual bytes`, async () => {
  const bytes = new Uint8Array(50 * 1024 * 1024);bytes.set(JPEG);const h = harness(action, bytes);
  const response = await h.handler(h.request());assert.equal(response.status, 200);
  if (action !== 'upload') assert.equal((await response.arrayBuffer()).byteLength, bytes.length);
});
for (const action of ['download', 'read']) for (const headers of [{ 'content-range': 'bytes 0-4/10' }, { 'content-encoding': 'gzip' }, { 'content-length': '99999999' }, { 'content-length': '6' }]) test(`${action}: rejects inconsistent/ranged/encoded private Storage ${JSON.stringify(headers)}`, async () => {
  const h = harness(action);h.download = () => ({ data: new Response(JPEG, { headers }) });
  const response = await h.handler(h.request());assert.ok(response.status >= 400);assert.ok(!ops(h).includes(COMMIT));assert.equal(ops(h).filter(x => x === READ).length, action === 'read' ? 1 : 0);
});
test('pre-aborted archives read never authorizes or downloads', async () => {
  const h = harness('read'), controller = new AbortController();controller.abort();
  await failed(await h.handler(new Request(h.request(), { signal: controller.signal })), 400);assert.deepEqual(h.calls, []);
});
test('read rejects unexpected job token header and nonempty transfer requests reject bodies', async () => {
  const h = harness('read');await failed(await h.handler(h.request({ 'x-transfer-job-token': JOB })), 400);assert.deepEqual(h.calls, []);
  const d = harness('download');await failed(await d.handler(d.request({}, 'arbitrary path')), 413);assert.deepEqual(ops(d), [AUTH]);
});
