import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// No SQL, credentials, production hosts or network: real handler/client, synthetic RPC and Storage.
const root = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE = 'https://mapped-source-fixture.supabase.co';
const TARGET = 'https://mapped-target-fixture.supabase.co';
const PREFIX = '/storage/v1/object/public/verification-documents/';
const BUCKET = 'verification-documents';
const SCOPE = 'employee-mapped-verification-media';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const ADMIN2 = '11111111-1111-4111-8111-111111111112';
const JOB = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';
const NEW = '44444444-4444-4444-8444-444444444444';
const ANON = 'offline-anon-key';
const SECRET = 'never-echo-document-or-backend-details';
const INVENTORY = 'get_employee_transfer_mapped_verification_media';
const BIND = 'employee_import_mapped_verification_media_bind';
const AUTHORIZE = 'employee_transfer_mapped_verification_media_authorize';
const COMMIT = 'employee_transfer_mapped_verification_media_commit';
const sha = value => createHash('sha256').update(value).digest('hex');
const text = value => new TextEncoder().encode(value);
const JPEG = Uint8Array.of(255, 216, 255, 224, 0, 3, 9, 255, 217);
const SAMPLES = [
  ['image/jpeg', JPEG], ['image/png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1)],
  ['image/gif', text('GIF87a-synthetic')], ['image/gif', text('GIF89a-synthetic')],
  ['image/webp', text('RIFF----WEBP-synthetic')], ['application/pdf', text('%PDF-1.7\nsynthetic')],
];
const sourcePath = (suffix = 'fixture.JPG', folder = 'id-front') => `${folder}/${OLD}-${suffix}`;
const fileOf = (bytes = JPEG, type = 'image/jpeg', suffix, folder) => {
  const url = SOURCE + PREFIX + sourcePath(suffix, folder);
  return { key: sha(url), source_url: url, bytes: bytes.length, sha256: sha(bytes), content_type: type };
};
const sorted = files => files.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
const receipt = file => ({ success: true, key: file.key, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, full_site_complete: false });
const bindReceipt = (files, repeated = false) => ({ success: true, scope: SCOPE, files: files.length,
  bytes: files.reduce((n, f) => n + f.bytes, 0), repeated, full_site_complete: false });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const noNetwork = mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
const logs = ['log', 'warn', 'error', 'info', 'debug', 'trace'].map(name => mock.method(console, name, () => {}));
const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on('unhandledRejection', onUnhandled);
after(async () => {
  await nextTurn();
  assert.equal(noNetwork.mock.callCount(), 0);
  for (const log of logs) assert.equal(log.mock.callCount(), 0, 'no sensitive logging');
  assert.deepEqual(unhandled, []);
  process.off('unhandledRejection', onUnhandled);
  mock.restoreAll();
});
async function compile(url = TARGET, key = ANON) {
  const compiled = await build({
    stdin: { contents: `export * from './src/lib/employeeTransfer/employeeMappedVerificationMedia.ts';
      export {createEmployeeTransferMediaHandler} from './supabase/functions/employee-transfer-media/handler.ts';
      export {setHarness} from 'mapped-media:state';`, resolveDir: root, loader: 'js' },
    bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', logLevel: 'silent',
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(url), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(key) },
    plugins: [{ name: 'offline', setup(b) {
      b.onResolve({ filter: /^(mapped-media:state|\.\.\/(auth|supabase))$/ }, a => ({ path: a.path, namespace: 'offline' }));
      b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === 'mapped-media:state'
        ? 'let h; export const setHarness=v=>{h=v}; export const current=()=>h;'
        : path === '../auth' ? `import {current} from 'mapped-media:state'; export const getAdminFinancialSessionToken=()=>current().getAdmin();`
          : `import {current} from 'mapped-media:state'; export const supabase={rpc(...args){return current().rpc(...args)}};` }));
    } }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
}
const api = await compile();
function harness(files = [fileOf()], { bound = true } = {}) {
  const h = { files: structuredClone(files), bound: bound ? structuredClone(files) : null, admin: ADMIN, calls: [],
    fetches: [], auths: 0, objects: new Map(), generation: '2', overrideContext: null,
    beforeRpc: null, afterRpc: null, beforeAuth: null, beforeRead: null, beforeWrite: null,
    beforeCommit: null, beforeFetch: null, afterFetch: null, abortQueryThrows: false };
  h.path = file => {
    const [folder, name] = file.source_url.split(PREFIX)[1].split('/');
    return `${folder}/${NEW}-transfer-${sha(JOB + ':' + file.key).slice(0, 32)}.${name.split('.').at(-1).toLowerCase()}`;
  };
  h.inventory = () => ({ scope: SCOPE, direction: 'import', full_site_complete: false, files: h.files.map(file => ({
    key: file.key, source_url: file.source_url, bucket: BUCKET, path: file.source_url.split(PREFIX)[1],
    file: h.bound?.find(f => f.key === file.key) ?? null,
  })) });
  h.getAdmin = () => { h.auths++; h.beforeAuth?.(); return h.admin; };
  h.rpc = (name, args) => {
    let signal;
    const pending = Promise.resolve().then(async () => {
      h.calls.push({ op: name, args: structuredClone(args), signal });
      assert.ok([INVENTORY, BIND].includes(name), 'no legacy/record RPC or close');
      if (h.beforeRpc) { const result = await h.beforeRpc(name, args); if (result) return result; }
      assert.deepEqual(Object.keys(args).sort(), [...(name === BIND ? ['p_files'] : []), 'p_admin_session_token', 'p_job_token'].sort());
      assert.equal(args.p_job_token, JOB); assert.equal(args.p_admin_session_token, h.admin);
      let result;
      if (name === INVENTORY) result = { data: structuredClone(h.inventory()) };
      else {
        const repeated = h.bound !== null;
        if (repeated) assert.deepEqual(args.p_files, h.bound);
        h.bound = structuredClone(args.p_files);
        result = { data: bindReceipt(h.bound, repeated) };
      }
      return h.afterRpc ? await h.afterRpc(name, result) : result;
    });
    const q = { then(yes, no) { return pending.then(yes, no); }, abortSignal(s) {
      signal = s; if (h.abortQueryThrows) throw Error(SECRET); return q;
    } };
    return q;
  };
  h.edgeRpc = async (name, args) => {
    h.calls.push({ op: name, args: structuredClone(args) });
    assert.ok([AUTHORIZE, COMMIT, 'employee_transfer_verification_media_authorize', 'employee_transfer_verification_media_commit'].includes(name));
    if (name.endsWith('_authorize')) {
      const file = h.bound?.find(f => f.key === args.p_object_key);
      if (!file) return { error: { message: SECRET } };
      let ctx = { direction: 'import', key: file.key, bucket: BUCKET, path: h.path(file), source_url: file.source_url,
        file: structuredClone(file), generation: h.generation, source_id: OLD, target_id: NEW };
      if (name === 'employee_transfer_verification_media_authorize') { delete ctx.source_id; delete ctx.target_id; }
      if (h.overrideContext) ctx = h.overrideContext(ctx);
      return { data: ctx };
    }
    if (h.beforeCommit) { const result = await h.beforeCommit(args); if (result) return result; }
    if (args.p_generation !== h.generation) return { error: { message: SECRET } };
    assert.equal(args.p_storage_origin, TARGET);
    return { data: receipt({ key: args.p_object_key, bytes: args.p_bytes, sha256: args.p_sha256, content_type: args.p_content_type }) };
  };
  h.store = {
    async upload(bucket, path, bytes, options) {
      h.calls.push({ op: 'upload', bucket, path, options: { ...options }, sha256: sha(bytes), bytes: bytes.length });
      assert.equal(bucket, BUCKET); assert.equal(options.upsert, false);
      if (h.beforeWrite) { const result = await h.beforeWrite(path, bytes); if (result) return result; }
      if (h.objects.has(path)) return { error: { statusCode: '409' } };
      h.objects.set(path, new Uint8Array(bytes)); return { data: { path } };
    },
    async download(bucket, path, signal) {
      h.calls.push({ op: 'read', bucket, path });
      assert.equal(bucket, BUCKET); assert.ok(signal instanceof AbortSignal);
      if (h.beforeRead) { const result = await h.beforeRead(path, signal); if (result) return result; }
      const bytes = h.objects.get(path);
      return { data: bytes ? new Response(bytes, { headers: { 'content-type': 'text/html' } }) : new Response(SECRET, { status: 404 }) };
    },
    remove() { assert.fail('delete forbidden'); }, update() { assert.fail('overwrite forbidden'); },
  };
  h.handler = api.createEmployeeTransferMediaHandler({ supabaseUrl: TARGET, crypto: webcrypto, rpc: h.edgeRpc, store: h.store });
  h.fetch = async (url, init) => {
    const headers = new Headers(init.headers);
    h.fetches.push({ url, init, action: headers.get('x-transfer-action') });
    assert.equal(url, TARGET + '/functions/v1/employee-transfer-media');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.equal(headers.get('x-transfer-scope'), 'mapped-verification');
    assert.equal(headers.get('apikey'), ANON); assert.equal(headers.get('x-admin-session-token'), h.admin);
    assert.equal(headers.get('x-transfer-job-token'), JOB);
    if (h.beforeFetch) { const result = await h.beforeFetch(url, init); if (result) return result; }
    const response = await h.handler(new Request(url, init));
    return h.afterFetch ? h.afterFetch(response) : response;
  };
  api.setHarness(h);
  h.session = api.createEmployeeMappedVerificationMediaSession(JOB, h.fetch);
  return h;
}
function request(h, action = 'upload', bytes = JPEG, overrides = {}, signal) {
  const file = h.files[0];
  const headers = new Headers({ 'x-transfer-scope': 'mapped-verification', 'x-transfer-action': action,
    'x-admin-session-token': ADMIN, 'x-transfer-job-token': JOB, 'x-transfer-object-key': file.key });
  for (const [key, value] of Object.entries(overrides)) value === null ? headers.delete(key) : headers.set(key, value);
  return new Request('https://offline-edge.invalid/employee-transfer-media', {
    method: 'POST', headers, signal, ...(bytes === undefined ? {} : { body: bytes, duplex: 'half' }),
  });
}
const ops = h => h.calls.map(c => c.op);
function redacted(error, mayExist, cancelled = false) {
  assert.ok(error instanceof api.EmployeeMappedVerificationMediaError);
  assert.equal(error.serverStagingOrUploadsMayExist, mayExist);
  assert.equal(error.cancelled, cancelled);
  for (const sensitive of [SECRET, ADMIN, JOB, OLD, NEW, SOURCE, ANON]) assert.ok(!String(error).includes(sensitive));
  assert.ok(!('cause' in error)); return true;
}
const fails = (promise, mayExist = false, cancelled = false) => assert.rejects(promise, error => redacted(error, mayExist, cancelled));
async function edgeFails(h, req, status = 502, code = 'TRANSFER_FAILED') {
  const res = await h.handler(req);
  assert.equal(res.status, status);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const raw = await res.text();
  assert.deepEqual(JSON.parse(raw), { success: false, error: code });
  for (const sensitive of [SECRET, ADMIN, JOB, OLD, NEW, SOURCE]) assert.ok(!raw.includes(sensitive));
}

for (const [index, [type, bytes]] of SAMPLES.entries()) {
  for (const folder of ['id-front', 'id-back', 'selfie']) {
    test(`SQL53 client/handler roundtrip ${index}/${folder}: bind, target UUID upload, actual recheck`, async () => {
      const file = fileOf(bytes, type, `sample-${index}.EXT`, folder), h = harness([file], { bound: false });
      assert.deepEqual(Object.keys(h.session).sort(), ['direction', 'inventory', 'bind', 'upload', 'recheckImport'].sort());
      assert.equal(h.session.direction, 'import'); assert.ok(Object.isFrozen(h.session));
      const initial = await h.session.inventory();
      assert.equal(initial.scope, SCOPE); assert.equal(initial.files[0].file, null);
      await h.session.bind([file]);
      await h.session.upload(file, bytes);
      await h.session.recheckImport([file]);
      const current = await h.session.inventory();
      assert.deepEqual(current.files[0].file, file); assert.equal(current.full_site_complete, false);
      assert.ok(Object.isFrozen(current) && Object.isFrozen(current.files) && Object.isFrozen(current.files[0].file));
      assert.deepEqual(h.objects.get(h.path(file)), bytes);
      assert.match(h.path(file), new RegExp(`^${folder}/${NEW}-transfer-[0-9a-f]{32}\\.ext$`));
      assert.deepEqual(h.fetches.map(f => f.action), ['upload', 'recheck-import']);
      assert.deepEqual(ops(h).filter(op => ![INVENTORY, BIND].includes(op)), [AUTHORIZE, 'upload', 'read', COMMIT, AUTHORIZE, 'read', COMMIT]);
      const commits = h.calls.filter(c => c.op === COMMIT);
      assert.ok(commits.every(c => c.args.p_generation === '2' && c.args.p_storage_origin === TARGET));
    });
  }
}
test('zero-media inventory/bind/recheck succeeds with no Storage or Edge call', async () => {
  const h = harness([], { bound: false });
  await h.session.bind([]); await h.session.recheckImport([]);
  assert.deepEqual((await h.session.inventory()).files, []);
  assert.equal(h.fetches.length, 0);
});
for (const action of ['download', 'recheck-export', 'read', 'delete', 'close', 'UPLOAD', '']) {
  test(`mapped scope rejects action ${action} before authorization`, async () => {
    const h = harness(); await edgeFails(h, request(h, action), 400, 'INVALID_REQUEST');
    assert.deepEqual(h.calls, []);
  });
}
for (const scope of ['employee-mapped-verification-media', 'mapped_verification', 'unknown']) {
  test(`wrong Edge scope ${scope} never dispatches`, async () => {
    const h = harness(); await edgeFails(h, request(h, 'upload', JPEG, { 'x-transfer-scope': scope }), 400, 'INVALID_REQUEST');
    assert.deepEqual(h.calls, []);
  });
}
for (const scope of [null, 'verification']) {
  test(`old verification scope ${scope}: different owner still rejected, no mapped RPC`, async () => {
    const h = harness(); await edgeFails(h, request(h, 'upload', JPEG, { 'x-transfer-scope': scope }));
    assert.deepEqual(ops(h), ['employee_transfer_verification_media_authorize']);
  });
}
test('old verification same-owner upload remains accepted', async () => {
  const h = harness(); h.overrideContext = ctx => ({ ...ctx, path: ctx.path.replace(NEW, OLD) });
  const res = await h.handler(request(h, 'upload', JPEG, { 'x-transfer-scope': 'verification' }));
  assert.equal(res.status, 200);
  assert.deepEqual(ops(h), ['employee_transfer_verification_media_authorize', 'upload', 'read', 'employee_transfer_verification_media_commit']);
});
const badContexts = [
  ['legacy lacks source_id', c => { delete c.source_id; }], ['legacy lacks target_id', c => { delete c.target_id; }],
  ['extra scope', c => { c.scope = SCOPE; }], ['export', c => { c.direction = 'export'; }],
  ['same UUID', c => { c.target_id = OLD; c.path = c.path.replace(NEW, OLD); }],
  ['source UUID not owner', c => { c.source_id = JOB; }], ['target UUID not owner', c => { c.target_id = JOB; }],
  ['bad source UUID', c => { c.source_id = 'bad'; }], ['bad target UUID', c => { c.target_id = null; }],
  ['source prefixed target path', c => { c.path = c.path.replace(NEW, OLD); }],
  ['wrong folder', c => { c.path = c.path.replace('id-front/', 'id-back/'); }],
  ['not transfer filename', c => { c.path = `id-front/${NEW}-file.jpg`; }],
  ['wrong transfer hash', c => { c.path = c.path.replace(/transfer-[a-f0-9]+/, 'transfer-xyz'); }],
  ['upper target extension', c => { c.path = c.path.replace('.jpg', '.JPG'); }],
  ['different extension', c => { c.path = c.path.replace('.jpg', '.png'); }],
  ['wrong bucket', c => { c.bucket = 'chat-images'; }], ['no file', c => { c.file = null; }],
  ['external source', c => { c.source_url = 'https://evil.invalid' + PREFIX + sourcePath(); }],
  ['signed source', c => { c.source_url += '?token=secret'; }], ['encoded source', c => { c.source_url = c.source_url.replace('id-front', '%69d-front'); }],
  ['source traversal', c => { c.source_url = SOURCE + PREFIX + '../' + sourcePath(); }],
  ['source ownership', c => { c.source_url = c.source_url.replace(OLD, NEW); }],
  ['target traversal', c => { c.path = 'id-front/../' + c.path; }],
  ['target newline', c => { c.path += '\n'; }], ['source newline', c => { c.source_url += '\n'; }],
  ['tuple mismatch', c => { c.file.key = 'f'.repeat(64); }],
  ['tuple extra', c => { c.file.owner = NEW; }], ['video MIME', c => { c.file.content_type = 'video/mp4'; }],
  ['oversize tuple', c => { c.file.bytes = 50 * 1024 * 1024 + 1; }],
];
for (const [name, mutate] of badContexts) {
  test(`mapped authorize context rejects ${name} before Storage`, async () => {
    const h = harness(); h.overrideContext = c => { mutate(c); return c; };
    await edgeFails(h, request(h)); assert.deepEqual(ops(h), [AUTHORIZE]);
  });
}
for (const value of [null, 0, 'export', '', '-1', '01', '1.0', '+1', '1e1', '500001', '1000000', '2\n']) {
  test(`generation rejects ${JSON.stringify(value)}`, async () => {
    const h = harness(); h.generation = value;
    await edgeFails(h, request(h)); assert.deepEqual(ops(h), [AUTHORIZE]);
  });
}
for (const generation of ['0', '1', '499999', '500000']) {
  test(`generation ${generation} passed unchanged to commit`, async () => {
    const h = harness(); h.generation = generation;
    assert.equal((await h.handler(request(h))).status, 200);
    assert.equal(h.calls.at(-1).args.p_generation, generation);
  });
}
test('generation changing during readback is not refreshed; old commit fails safely', async () => {
  const h = harness(); h.beforeRead = () => { h.generation = '3'; };
  await edgeFails(h, request(h));
  assert.deepEqual(ops(h), [AUTHORIZE, 'upload', 'read', COMMIT]);
  assert.equal(h.calls.at(-1).args.p_generation, '2'); assert.equal(h.objects.size, 1);
});
for (const [name, bytes, type] of [
  ['MP4 actual', Uint8Array.of(0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0), 'image/jpeg'],
  ['WebM actual', Uint8Array.of(26, 69, 223, 163, 135, 66, 130, 132, 119, 101, 98, 109), 'image/jpeg'],
  ['HTML', text('<script>bad</script>'), 'image/jpeg'], ['wrong magic MIME', JPEG, 'image/png'],
]) {
  test(`verification MIME rejects ${name} without uploading`, async () => {
    const file = fileOf(bytes, type), h = harness([file]);
    await edgeFails(h, request(h, 'upload', bytes), 422, 'INVALID_MEDIA');
    assert.deepEqual(ops(h), [AUTHORIZE]);
    await fails(h.session.upload(file, bytes)); assert.equal(h.fetches.length, 0);
  });
}
for (const existing of [JPEG, Uint8Array.of(255, 216, 255, 1, 1)]) {
  test(`occupied target ${sha(existing)} is never upserted; only identical readback is reusable`, async () => {
    const h = harness(), file = h.files[0]; h.objects.set(h.path(file), existing);
    const res = await h.handler(request(h));
    assert.equal(res.status, sha(existing) === file.sha256 ? 200 : 422);
    assert.deepEqual(h.objects.get(h.path(file)), existing);
    assert.equal(h.calls.find(c => c.op === 'upload').options.upsert, false);
    assert.equal(ops(h).includes(COMMIT), res.ok);
  });
}
for (const readback of [null, Uint8Array.of(255, 216, 255), 'oversize', 'redirect', 'partial']) {
  test(`unconfirmed readback ${String(readback)} leaves object but never commits`, async () => {
    const h = harness(); h.beforeRead = () => ({ data: readback === null ? new Response('', { status: 404 })
      : readback === 'oversize' ? new Response(JPEG, { headers: { 'content-length': String(50 * 1024 * 1024 + 1) } })
        : readback === 'redirect' ? new Response(null, { status: 302 })
          : readback === 'partial' ? new Response(JPEG, { status: 206 }) : new Response(readback) });
    await fails(h.session.upload(h.files[0], JPEG), true);
    assert.equal(h.objects.size, 1); assert.ok(!ops(h).includes(COMMIT));
  });
}
test('recheck-import reads target only, never source URL or upload', async () => {
  const h = harness(), file = h.files[0]; h.objects.set(h.path(file), JPEG);
  await h.session.recheckImport([file]);
  assert.deepEqual(ops(h), [INVENTORY, AUTHORIZE, 'read', COMMIT]);
});
for (const field of ['success', 'key', 'bytes', 'sha256', 'content_type', 'full_site_complete', 'extra']) {
  test(`strict service commit receipt ${field}`, async () => {
    const h = harness(); h.beforeCommit = () => {
      const r = receipt(h.files[0]); r[field] = field === 'extra' ? false : null; return { data: r };
    };
    await fails(h.session.upload(h.files[0], JPEG), true); assert.equal(h.objects.size, 1);
  });
  test(`strict client Edge receipt ${field}`, async () => {
    const h = harness(); h.afterFetch = async res => {
      const r = await res.json(); r[field] = field === 'extra' ? false : null; return new Response(JSON.stringify(r));
    };
    await fails(h.session.upload(h.files[0], JPEG), true);
  });
}
for (const field of ['scope', 'files', 'bytes', 'success', 'repeated', 'full_site_complete', 'extra']) {
  test(`strict SQL53 bind receipt ${field}`, async () => {
    const h = harness(); h.afterRpc = (name, r) => { if (name === BIND) r.data[field] = null; return r; };
    await fails(h.session.bind(h.files), true);
    const count = h.calls.length;
    await fails(h.session.upload(h.files[0], JPEG));
    assert.equal(h.calls.length, count, 'failed bind pauses writes');
  });
}
const badInventories = [
  ['scope', r => { r.scope = 'employee-verification-media'; }], ['direction', r => { r.direction = 'export'; }],
  ['extra', r => { r.can_restore = true; }], ['complete', r => { r.full_site_complete = true; }],
  ['target inventory path', r => { r.files[0].path = r.files[0].path.replace(OLD, NEW); }],
  ['bucket', r => { r.files[0].bucket = 'chat-images'; }], ['duplicate', r => { r.files.push(r.files[0]); }],
  ['tuple mismatch', r => { r.files[0].file.source_url += '?query'; }],
  ['tuple MIME', r => { r.files[0].file.content_type = 'video/webm'; }],
  ['source hash', r => { r.files[0].key = 'f'.repeat(64); }],
];
for (const [name, mutate] of badInventories) {
  test(`inventory rejects ${name} before write`, async () => {
    const h = harness(); h.afterRpc = (name, r) => { if (name === INVENTORY) mutate(r.data); return r; };
    await fails(h.session.inventory()); await fails(h.session.bind(h.files));
    assert.ok(ops(h).every(op => op === INVENTORY)); assert.equal(h.fetches.length, 0);
  });
}
for (const field of ['key', 'source_url', 'sha256', 'bytes', 'content_type', 'extra']) {
  test(`strict input tuple rejects ${field} without RPC`, async () => {
    const h = harness(), file = structuredClone(h.files[0]); file[field] = null;
    await fails(h.session.bind([file])); await fails(h.session.upload(file, JPEG)); assert.deepEqual(h.calls, []);
  });
}
test('accessors, sparse/extended arrays and inherited records are rejected without invoking getters', async () => {
  const h = harness(), file = h.files[0], getter = () => assert.fail('getter invoked');
  const accessor = { ...file }; Object.defineProperty(accessor, 'bytes', { enumerable: true, get: getter });
  const items = [new Array(1), Object.assign([file], { extra: 1 }), [Object.create(file)], [accessor]];
  const accessorArray = [file]; Object.defineProperty(accessorArray, '0', { enumerable: true, get: getter }); items.push(accessorArray);
  for (const files of items) await fails(h.session.bind(files));
  assert.deepEqual(h.calls, []);
});
test('unsorted input and inventory reject without sorting or truncation', async () => {
  const files = sorted([fileOf(), fileOf(JPEG, 'image/jpeg', 'second.jpg')]), h = harness(files);
  await fails(h.session.bind([...files].reverse())); assert.deepEqual(h.calls, []);
  h.afterRpc = (name, r) => { r.data.files.reverse(); return r; };
  await fails(h.session.inventory());
});
test('upload/recheck require exact bound inventory; missing or differing tuple never reaches Edge', async () => {
  const h = harness(undefined, { bound: false });
  await fails(h.session.upload(h.files[0], JPEG)); await fails(h.session.recheckImport(h.files));
  await fails(h.session.bind([])); assert.equal(h.fetches.length, 0);
  await h.session.bind(h.files);
  h.bound = null;
  await fails(h.session.inventory()); assert.equal(h.fetches.length, 0);
});
test('mutable producer bytes and metadata copied before auth and inventory awaits', async () => {
  const h = harness(), file = structuredClone(h.files[0]), bytes = new Uint8Array(JPEG), gate = deferred(), entered = deferred();
  h.beforeAuth = () => { bytes.fill(0); file.sha256 = '0'.repeat(64); };
  h.beforeRpc = async name => { if (name === INVENTORY) { entered.resolve(); await gate.promise; } };
  const promise = h.session.upload(file, bytes); await entered.promise;
  gate.resolve(); await promise;
  assert.deepEqual(h.objects.get(h.path(h.files[0])), JPEG);
});
test('bind snapshots producer catalog before async inventory', async () => {
  const h = harness(undefined, { bound: false }), input = structuredClone(h.files), gate = deferred(), entered = deferred();
  h.beforeRpc = async name => { if (name === INVENTORY) { entered.resolve(); await gate.promise; } };
  const promise = h.session.bind(input); await entered.promise;
  input[0].sha256 = '0'.repeat(64); input.length = 0; gate.resolve(); await promise;
  assert.deepEqual(h.bound, h.files);
});
test('fresh admin session for every RPC and every Edge command, including a multi-file recheck', async () => {
  const files = sorted([fileOf(), fileOf(JPEG, 'image/jpeg', 'second.jpg')]), h = harness(files, { bound: false });
  h.admin = ADMIN2; await h.session.bind(files);
  assert.ok(h.calls.every(c => c.args.p_admin_session_token === ADMIN2));
  for (const file of files) h.objects.set(h.path(file), JPEG);
  h.admin = ADMIN; h.beforeRead = () => { h.admin = ADMIN2; };
  await h.session.recheckImport(files);
  assert.equal(new Headers(h.fetches[0].init.headers).get('x-admin-session-token'), ADMIN);
  assert.equal(new Headers(h.fetches[1].init.headers).get('x-admin-session-token'), ADMIN2);
  assert.equal(h.auths, 5); // bind: inventory+bind; recheck: inventory+two Edge requests.
});
for (const admin of [null, '', SECRET, ADMIN + '\n', '0'.repeat(64)]) {
  test(`invalid current admin ${String(admin).length} cannot dispatch`, async () => {
    const h = harness(); h.admin = admin;
    await fails(h.session.inventory()); await fails(h.session.upload(h.files[0], JPEG)); assert.deepEqual(h.calls, []);
  });
}
for (const job of [null, '', SECRET, JOB + '\n', 1]) {
  test(`invalid job ${String(job).length} fails factory`, () => {
    assert.throws(() => api.createEmployeeMappedVerificationMediaSession(job), e => redacted(e, false));
  });
}
for (const url of ['https://evil.invalid', TARGET + '/evil', TARGET + '?x', 'http://mapped-target-fixture.supabase.co', TARGET + '\n']) {
  test(`configured endpoint rejects ${url}`, async () => {
    const variant = await compile(url); assert.throws(() => variant.createEmployeeMappedVerificationMediaSession(JOB));
  });
}
for (const key of ['', ' key ', 'key\nsecret']) {
  test(`configured API key rejects ${JSON.stringify(key)}`, async () => {
    const variant = await compile(TARGET, key); assert.throws(() => variant.createEmployeeMappedVerificationMediaSession(JOB));
  });
}
test('single trailing slash configured origin remains environment-only', async () => {
  const variant = await compile(TARGET + '/'), h = harness(); variant.setHarness(h);
  const session = variant.createEmployeeMappedVerificationMediaSession(JOB, h.fetch);
  await session.upload(h.files[0], JPEG);
});
for (const count of [3000, 3001]) {
  test(`media count ${count} is checked without truncation`, async () => {
    const files = sorted(Array.from({ length: count }, (_, i) => fileOf(JPEG, 'image/jpeg', `${i}.jpg`))), h = harness(files);
    if (count === 3000) assert.equal((await h.session.inventory()).files.length, 3000);
    else { await fails(h.session.bind(files)); assert.deepEqual(h.calls, []); await fails(h.session.inventory()); }
  });
}
for (const over of [false, true]) {
  test(`total 1GiB ${over ? 'plus one rejects' : 'inclusive accepts'}`, async () => {
    const max = 50 * 1024 * 1024;
    const files = sorted(Array.from({ length: 21 }, (_, i) => ({ ...fileOf(JPEG, 'image/jpeg', `${i}.jpg`), bytes: i === 20 ? 24 * 1024 * 1024 + Number(over) : max })));
    const h = harness(files, { bound: false });
    if (over) { await fails(h.session.bind(files)); assert.deepEqual(h.calls, []); }
    else await h.session.bind(files);
  });
}
test('50MiB inclusive upload with actual readback, >50MiB tuple blocked before RPC', async () => {
  const bytes = new Uint8Array(50 * 1024 * 1024); bytes.set(JPEG);
  const file = fileOf(bytes), h = harness([file]); await h.session.upload(file, bytes);
  assert.equal(h.calls.at(-1).args.p_bytes, bytes.length);
  const bad = { ...file, bytes: bytes.length + 1 };
  const calls = h.calls.length; await fails(h.session.upload(bad, bytes)); assert.equal(h.calls.length, calls);
});
for (const fault of ['network after commit', 'invalid JSON', 'oversize JSON', 'redirect', 'http failure']) {
  test(`uncertain ${fault}: no retry/delete/close, writes pause but inventory remains read-only`, async () => {
    const h = harness(); h.afterFetch = async response => {
      if (fault === 'network after commit') throw Error(SECRET);
      if (fault === 'invalid JSON') return new Response('{');
      if (fault === 'oversize JSON') return new Response(' '.repeat(4097));
      if (fault === 'redirect') { Object.defineProperty(response, 'redirected', { value: true }); return response; }
      return new Response(SECRET, { status: 502 });
    };
    await fails(h.session.upload(h.files[0], JPEG), true);
    assert.equal(h.fetches.length, 1); assert.equal(h.objects.size, 1);
    await fails(h.session.upload(h.files[0], JPEG)); await fails(h.session.recheckImport(h.files));
    assert.equal(h.fetches.length, 1); await h.session.inventory();
  });
}
for (const phase of ['bind', 'upload', 'recheck']) {
  test(`cancel ${phase} ignores signal underneath: prompt reject, mutex held until actual settlement`, async () => {
    const h = harness(), controller = new AbortController(), gate = deferred(), entered = deferred();
    if (phase === 'bind') h.beforeRpc = async name => { if (name === BIND) { entered.resolve(); await gate.promise; } };
    else h.beforeFetch = async () => { entered.resolve(); await gate.promise; };
    if (phase === 'recheck') h.objects.set(h.path(h.files[0]), JPEG);
    const promise = phase === 'bind' ? h.session.bind(h.files, controller.signal)
      : phase === 'upload' ? h.session.upload(h.files[0], JPEG, controller.signal) : h.session.recheckImport(h.files, controller.signal);
    const rejected = fails(promise, true, true);
    await entered.promise; controller.abort(SECRET); await rejected;
    const calls = h.calls.length;
    await fails(h.session.inventory()); assert.equal(h.calls.length, calls, 'mutex still held');
    gate.resolve(); await nextTurn(); await nextTurn();
    await h.session.inventory();
    await fails(h.session.bind(h.files));
    assert.equal(h.fetches.length, phase === 'bind' ? 0 : 1);
  });
}
test('cancel before any write, even during an ignoring read, retains mutex then permits a new explicit operation', async () => {
  const h = harness(), controller = new AbortController(), gate = deferred(), entered = deferred();
  h.beforeRpc = async () => { entered.resolve(); await gate.promise; };
  const promise = h.session.upload(h.files[0], JPEG, controller.signal), rejected = fails(promise, false, true);
  await entered.promise; controller.abort(SECRET); await rejected;
  await fails(h.session.inventory()); gate.resolve(); await nextTurn(); h.beforeRpc = null;
  await h.session.upload(h.files[0], JPEG); assert.equal(h.fetches.length, 1);
});
test('synchronous auth cancellation does not dispatch or create an unhandled pending rejection', async () => {
  const h = harness(), controller = new AbortController();
  h.beforeAuth = () => controller.abort(SECRET);
  await fails(h.session.upload(h.files[0], JPEG, controller.signal), false, true);
  await nextTurn(); assert.deepEqual(h.calls, []);
});
test('throwing abortSignal retains mutex while the already-dispatched RPC settles', async () => {
  const h = harness(), controller = new AbortController(), gate = deferred(), entered = deferred();
  h.abortQueryThrows = true; h.beforeRpc = async () => { entered.resolve(); await gate.promise; };
  const promise = h.session.inventory(controller.signal), rejected = fails(promise, false, true);
  await entered.promise; controller.abort(); await rejected; await fails(h.session.inventory());
  gate.resolve(); await nextTurn(); h.abortQueryThrows = false; h.beforeRpc = null;
  await h.session.inventory();
});
test('cancel in actual non-abortable Storage upload never commits, removes, retries or reports success', async () => {
  const h = harness(), controller = new AbortController(), gate = deferred(), entered = deferred();
  h.beforeWrite = async () => { entered.resolve(); await gate.promise; };
  const promise = h.session.upload(h.files[0], JPEG, controller.signal), rejected = fails(promise, true, true);
  await entered.promise; controller.abort(SECRET); await rejected;
  await fails(h.session.inventory()); gate.resolve(); await nextTurn(); await nextTurn();
  assert.equal(h.objects.size, 1); assert.ok(!ops(h).includes(COMMIT)); assert.ok(!ops(h).includes('read'));
  await h.session.inventory(); assert.equal(h.fetches.length, 1);
});
test('preaborted operation invokes neither auth, RPC, nor transport', async () => {
  const h = harness(), controller = new AbortController(); controller.abort(SECRET);
  await fails(h.session.upload(h.files[0], JPEG, controller.signal), false, true);
  assert.equal(h.auths, 0); assert.deepEqual(h.calls, []);
});
