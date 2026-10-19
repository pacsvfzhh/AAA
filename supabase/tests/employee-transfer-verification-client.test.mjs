import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Synthetic in-memory fixtures only; network and real credentials/documents are forbidden.
const root = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = 'https://local-fixture.supabase.co';
const PREFIX = '/storage/v1/object/public/verification-documents/';
const ADMIN = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';
const PACKAGE = '55555555-5555-4555-8555-555555555555';
const KEY = 'verification_requests', RECORD_PATH = `data/verification-${KEY}.ndjson`;
const SECRET = 'never-echo-backend-document-number-or-abort-reason';
const ANON = 'synthetic-anon-not-a-service-key';
const TIME = '2024-02-29T12:34:56.123456+00:00';
const sha = x => createHash('sha256').update(x).digest('hex');
const bytesOf = x => new TextEncoder().encode(x);
const JPG = Uint8Array.of(255, 216, 255, 224, 1, 2, 3, 4, 255, 217);
const SAMPLES = [
  ['image/jpeg', JPG], ['image/png', Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 1, 2)],
  ['image/gif', bytesOf('GIF89a-synthetic')], ['image/webp', bytesOf('RIFF----WEBP-synthetic')],
  ['application/pdf', bytesOf('%PDF-1.7\nsynthetic')],
];
function row(url = ORIGIN + PREFIX + `id-front/${USER}-fixture.jpg`) {
  return { id: USER, user_id: USER, real_name: '原文é𠮷', wallet_address: SECRET, phone: '+123', email: 'synthetic address', status: 'approved',
    audit_remark: null, audited_by: null, audited_at: TIME, created_at: TIME, updated_at: null,
    id_front_url: url, id_back_url: null, selfie_url: null };
}
function catalog(raw) {
  return { version: 1, scope: 'employee-verification', site_id: SITE, package_id: PACKAGE,
    identity_catalog: { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE,
      tables: ['accounts', 'credentials', 'orders'].map((key, i) => ({ key, rows: i === 0 ? 1 : 0, bytes: i === 0 ? 500 : 0, row_hashes_sha256: sha('') })),
      processing_orders: 0, full_site_complete: false },
    tables: [{ key: KEY, rows: raw ? raw.split('\n').length - 1 : 0, bytes: Buffer.byteLength(raw), row_hashes_sha256: sha(raw ? raw.split('\n').slice(0, -1).map(line => sha(line + '\n')).join('') : '') }], full_site_complete: false };
}
const flags = { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
const verified = { verified: true, scope: 'employee-verification', full_site_complete: false };
const fileTuple = (url, bytes = JPG, type = 'image/jpeg') => ({ key: sha(url), source_url: url, bytes: bytes.length, sha256: sha(bytes), content_type: type });
const mediaPath = file => `media/verification-documents/${file.source_url.split(PREFIX)[1]}`;
const receipt = file => ({ success: true, key: file.key, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, full_site_complete: false });
function fixture({ url, bytes = JPG, type = 'image/jpeg', raw } = {}) {
  raw ??= JSON.stringify(row(url)) + '\n';
  const records = raw ? raw.split('\n').slice(0, -1).map(line => JSON.parse(line)) : [];
  const media = [...new Set(records.flatMap(r => [r.id_front_url, r.id_back_url, r.selfie_url]).filter(x => x !== null))]
    .map(u => fileTuple(u, bytes, type)).sort((a, b) => a.key.localeCompare(b.key));
  const contents = new Map([[RECORD_PATH, bytesOf(raw)], ...media.map(file => [mediaPath(file), bytes])]);
  return { raw, catalog: catalog(raw), media, contents,
    manifest: { version: 1, scope: 'replacement-backup', exportId: PACKAGE, volumeId: 'single-verification-volume', sourceSiteId: SITE,
      createdAt: '2026-10-19T00:00:00.000Z', volumeIndex: 1, volumeCount: 1,
      entries: [...contents].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes), kind: path === RECORD_PATH ? 'ndjson' : 'media' })) } };
}
function redacted(e) {
  assert.ok(e instanceof Error);
  for (const v of [SECRET, ADMIN, JOB, ANON, row().id_front_url, USER]) assert.equal(String(e).includes(v), false);
  assert.equal('cause' in e, false); return true;
}
function failed(mayExist, cancelled = false, cleanup = false) {
  return e => redacted(e) && e.serverStagingOrUploadsMayExist === mayExist && e.cancelled === cancelled && e.cleanupRequired === cleanup;
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const noNetwork = mock.method(globalThis, 'fetch', () => assert.fail('real network forbidden'));
const logs = ['log', 'warn', 'error', 'info', 'debug', 'trace'].map(k => mock.method(console, k, () => {}));
const unhandled = [];
const rejection = e => unhandled.push(e);
process.on('unhandledRejection', rejection);
after(async () => {
  await nextTurn();
  assert.equal(noNetwork.mock.callCount(), 0);
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
  assert.deepEqual(unhandled, []);
  process.off('unhandledRejection', rejection); mock.restoreAll();
});
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/verificationMedia.ts';
    export * from './src/lib/employeeTransfer/container.ts';
    export {createEmployeeTransferMediaHandler} from './supabase/functions/employee-transfer-media/handler.ts';
    export {setHarness} from 'media-client:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020',
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(ORIGIN), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(ANON) },
  plugins: [{ name: 'offline-only', setup(b) {
    b.onResolve({ filter: /^(media-client:state|\.\.\/(auth|supabase))$/ }, a => ({ path: a.path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === 'media-client:state'
      ? 'let h; export const setHarness = v => {h=v}; export const current = () => h;'
      : path === '../auth' ? `import {current} from 'media-client:state'; export const getAdminFinancialSessionToken=()=>current().admin;`
        : `import {current} from 'media-client:state'; export const supabase={rpc:(...a)=>current().rpc(...a)};` }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness(f = fixture(), direction = 'import') {
  const h = { f, admin: ADMIN, direction, events: [], calls: [], fetches: [], objects: new Map(), bound: null,
    receipts: new Map(), checked: new Set(), recordBound: false, staged: false, applied: false, cleanup: 0,
    recordCatalog: null, recordRaw: null, appliedEmployees: new Set(), appliedRecords: new Map(),
    beforeFetch: null, afterFetch: null, beforeRpc: null, beforeRead: null, beforeWrite: null, beforeAbort: null,
    beforeAppend: null, beforeStage: null, beforePlan: null, paths: null, opens: new Map(), contents: new Map(f.contents) };
  const refs = () => f.media.map(file => ({ key: file.key, source_url: file.source_url, bucket: 'verification-documents',
    path: file.source_url.split(PREFIX)[1], file: direction === 'import' ? h.bound?.find(x => x.key === file.key) ?? null : h.receipts.get(file.key) ?? null }));
  const query = task => {
    let signal;
    const q = { abortSignal(s) { signal = s; return q; }, then(yes, no) { return Promise.resolve().then(() => task(signal)).then(yes, no); } }; return q;
  };
  h.rpc = (name, args) => query(async signal => {
    h.calls.push({ name, args: structuredClone(args), signal }); h.events.push(name);
    if (h.beforeRpc) { const override = await h.beforeRpc(name, args); if (override) return override; }
    assert.deepEqual({ p_admin_session_token: args.p_admin_session_token, p_job_token: args.p_job_token }, { p_admin_session_token: ADMIN, p_job_token: JOB });
    if (name === 'get_employee_transfer_verification_media') {
      assert.equal(args.p_direction, direction);
      if (direction === 'import' && !h.staged) return { error: { message: SECRET } };
      return { data: { scope: 'employee-verification-media', direction, files: refs(), full_site_complete: false } };
    }
    assert.equal(name, 'employee_import_verification_media_bind');
    assert.equal(h.staged, true, 'real record staging is a prerequisite');
    const repeated = h.bound !== null;
    if (repeated) assert.deepEqual(args.p_files, h.bound, 'media binding is immutable');
    else h.bound = structuredClone(args.p_files);
    return { data: { success: true, scope: 'employee-verification-media', files: h.bound.length, bytes: h.bound.reduce((n, x) => n + x.bytes, 0), repeated, full_site_complete: false } };
  });
  const edgeRpc = async (name, args) => {
    h.events.push(name);
    const file = f.media.find(x => x.key === args.p_object_key); assert.ok(file);
    if (name === 'employee_transfer_verification_media_authorize') {
      const bound = direction === 'import' ? h.bound?.find(x => x.key === file.key) : h.receipts.get(file.key) ?? null;
      if (direction === 'import' && !bound) return { error: { message: SECRET } };
      return { data: { direction, key: file.key, source_url: file.source_url, bucket: 'verification-documents',
        path: direction === 'export' ? file.source_url.split(PREFIX)[1] : targetPath(file), file: bound,
        generation: direction === 'export' ? 'export' : String(h.appliedEmployees.size) } };
    }
    assert.equal(name, 'employee_transfer_verification_media_commit');
    assert.equal(args.p_storage_origin, ORIGIN);
    const actual = { ...file, bytes: args.p_bytes, sha256: args.p_sha256, content_type: args.p_content_type };
    h.receipts.set(file.key, actual);
    if (args.p_action.startsWith('recheck')) h.checked.add(file.key);
    return { data: receipt(actual) };
  };
  const targetPath = file => {
    const [folder, name] = file.source_url.split(PREFIX)[1].split('/');
    return `${folder}/${name.slice(0, 36)}-transfer-${sha(file.key).slice(0, 32)}.${name.split('.').at(-1).toLowerCase()}`;
  };
  h.targetPath = targetPath;
  for (const file of f.media) if (direction === 'export') h.objects.set(file.source_url.split(PREFIX)[1], new Blob([f.contents.get(mediaPath(file))]));
  const handler = api.createEmployeeTransferMediaHandler({ supabaseUrl: ORIGIN, rpc: edgeRpc, crypto: webcrypto,
    store: {
      async download(bucket, path) {
        assert.equal(bucket, 'verification-documents'); h.events.push('store-read');
        if (h.beforeRead) { const override = await h.beforeRead(path); if (override) return override; }
        const blob = h.objects.get(path);
        return blob ? { data: new Response(blob.stream()), error: null } : { data: null, error: { message: SECRET } };
      },
      async upload(bucket, path, bytes, options) {
        assert.equal(bucket, 'verification-documents'); assert.equal(options.upsert, false); h.events.push('store-upload');
        if (h.beforeWrite) { const override = await h.beforeWrite(path, bytes); if (override) return override; }
        if (h.objects.has(path)) return { error: { statusCode: 409 } };
        h.objects.set(path, new Blob([bytes])); return { data: { path } };
      },
      remove() { assert.fail('no delete'); }, update() { assert.fail('no overwrite'); },
    } });
  h.fetch = async (url, init) => {
    const headers = new Headers(init.headers), action = headers.get('x-transfer-action');
    assert.equal(url, ORIGIN + '/functions/v1/employee-transfer-media'); assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.equal(headers.get('apikey'), ANON); assert.equal(headers.get('x-admin-session-token'), ADMIN); assert.equal(headers.get('x-transfer-job-token'), JOB);
    assert.equal(headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual([...headers.keys()].sort(), ['apikey', 'content-type', 'x-admin-session-token', 'x-transfer-action', 'x-transfer-job-token', 'x-transfer-object-key']);
    if (action === 'upload') assert.ok(init.body instanceof Uint8Array); else assert.equal(init.body, undefined);
    h.fetches.push({ url, init, action }); h.events.push(action);
    if (h.beforeFetch) { const override = await h.beforeFetch(action, init); if (override) return override; }
    const res = await handler(new Request(url, init));
    return h.afterFetch ? h.afterFetch(res, action) : res;
  };
  h.files = {
    paths: () => h.paths ?? [...h.contents.keys()],
    open(path) {
      const n = (h.opens.get(path) ?? 0) + 1; h.opens.set(path, n); h.events.push(`open:${path}:${n}`);
      return (async function* () {
        const bytes = h.contents.get(path); assert.ok(bytes, 'fixture missing');
        // Producer buffers must not change an already-open file.
        const copy = new Uint8Array(bytes);
        for (let i = 0; i < copy.length; i += 17) yield copy.subarray(i, i + 17);
      })();
    },
    async abort(reason) { redacted(reason); h.cleanup++; h.events.push('cleanup'); if (h.beforeAbort) await h.beforeAbort(); h.contents.clear(); },
  };
  h.sink = { stored: new Map(),
    async append(path, bytes, signal) {
      if (h.beforeAppend) await h.beforeAppend(path, bytes, signal);
      assert.equal(h.cleanup, 0, 'no late writes after cleanup');
      h.events.push('append:' + path);
      h.sink.stored.set(path, Buffer.concat([h.sink.stored.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)]));
    },
    async abort(reason) { redacted(reason); h.cleanup++; h.events.push('cleanup'); if (h.beforeAbort) await h.beforeAbort(); h.sink.stored.clear(); },
  };
  h.target = {
    async bind(cat, signal) {
      assert.deepEqual(cat, f.catalog); h.events.push('record-bind');
      const repeated = h.recordBound;
      if (repeated) assert.deepEqual(cat, h.recordCatalog, 'record catalog binding is immutable');
      else h.recordCatalog = structuredClone(cat);
      h.recordBound = true; h.recordSignal = signal;
      return { success: true, scope: 'employee-verification', full_site_complete: false, repeated };
    },
    async stage(key, n, raw, signal) {
      h.events.push('record-stage'); assert.equal(key, KEY); assert.equal(n, 0); assert.equal(raw, f.raw); assert.equal(h.recordBound, true); h.recordSignal = signal;
      if (h.beforeStage) await h.beforeStage();
      const repeated = h.staged;
      if (repeated) assert.equal(raw, h.recordRaw, 'repeated stage accepts only identical bytes');
      else h.recordRaw = raw;
      h.staged = true;
      return { success: true, rows: f.catalog.tables[0].rows, bytes: Buffer.byteLength(raw), sha256: sha(raw), repeated };
    },
    async plan() {
      h.events.push('record-plan'); if (h.beforePlan) { const override = await h.beforePlan(); if (override) return override; }
      const ready = h.bound && h.bound.every(x => {
        const stored = h.receipts.get(x.key);
        return stored && JSON.stringify(stored) === JSON.stringify(x);
      });
      return { scope: 'employee-verification', can_restore: Boolean(ready), counts: { verification_requests: f.catalog.tables[0].rows }, employees: f.catalog.identity_catalog.tables[0].rows,
        conflicts: ready ? [] : ['media_incomplete'], plan_hash: 'a'.repeat(64), ...flags };
    },
    apply() { assert.fail('automatic apply forbidden'); },
    verify() { assert.fail('automatic verify forbidden'); },
    close() { assert.fail('automatic close forbidden'); },
  };
  h.apply = async employeeId => {
    assert.equal((await h.target.plan()).can_restore, true);
    const records = h.recordRaw.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(r => r.user_id === employeeId);
    assert.ok(records.length);
    for (const record of records) {
      for (const field of ['id_front_url', 'id_back_url', 'selfie_url']) {
        if (record[field] !== null) record[field] = ORIGIN + PREFIX + h.targetPath(h.bound.find(file => file.source_url === record[field]));
      }
      const previous = h.appliedRecords.get(record.id);
      if (previous) assert.deepEqual(previous, record);
      else h.appliedRecords.set(record.id, record);
    }
    h.appliedEmployees.add(employeeId);
  };
  h.source = {
    async catalog() { h.events.push('catalog'); return f.catalog; },
    async page() { h.events.push('page'); return { table_key: KEY, count: f.catalog.tables[0].rows, ndjson: f.raw, next_after: null, sha256: sha(f.raw) }; },
    async verify() { h.events.push('source-verify'); assert.ok(f.media.every(x => h.checked.has(x.key))); if (h.sourceChange) throw Error(SECRET); return verified; },
  };
  api.setHarness(h);
  h.session = api.createVerificationMediaSession(JOB, direction, h.fetch);
  h.stage = options => api.stageVerificationBundle({ catalog: f.catalog, media: f.media, manifest: f.manifest }, h.files, h.target, h.session, options);
  h.export = options => api.exportVerificationBundle(h.source, h.sink, h.session, options);
  return h;
}

for (const [type, bytes] of SAMPLES) test(`real handler export/import: ${type}, exact original bytes, explicit final readback`, async () => {
  const f = fixture({ bytes, type }), h = harness(f, 'export'), p = [];
  const result = await h.export({ onProgress: x => p.push(x) });
  assert.deepEqual(result.media, f.media); assert.deepEqual(result.catalog, f.catalog); assert.deepEqual(result.entries, f.manifest.entries);
  assert.deepEqual(h.sink.stored.get(RECORD_PATH), Buffer.from(f.raw));
  assert.deepEqual(h.sink.stored.get(mediaPath(f.media[0])), Buffer.from(bytes));
  assert.equal(h.events.at(-1), 'source-verify'); assert.deepEqual(h.fetches.map(x => x.action), ['download', 'recheck-export']);
  assert.equal(h.cleanup, 0); assert.equal(result.fullSiteComplete, false);
  assert.equal(p.at(-1).bytes, Buffer.byteLength(f.raw) + bytes.length); assert.equal(p.at(-1).files, 1);
  const imported = harness(f), progress = [], c = new AbortController();
  const staged = await imported.stage({ signal: c.signal, onProgress: x => progress.push(x) });
  assert.equal(staged.plan.can_restore, true); assert.equal(staged.serverStagingOrUploadsMayExist, true);
  assert.equal(imported.recordSignal, c.signal); assert.equal(imported.cleanup, 1); assert.equal(imported.contents.size, 0);
  assert.deepEqual(imported.fetches.map(x => x.action), ['upload']);
  assert.equal(imported.opens.get(mediaPath(f.media[0])), 2);
  assert.ok(imported.events.indexOf('record-bind') > imported.events.indexOf(`open:${mediaPath(f.media[0])}:1`));
  assert.equal(progress.filter(x => x.phase === 'upload').at(-1).files, 1);
  assert.equal(imported.checked.size, 0, 'no implicit final readback or SQL verify/apply/close');
  // SQL owns the apply/readback timestamp check.
  imported.applied = true;
  await imported.session.recheckImport(f.media);
  assert.equal(imported.checked.size, 1);
  assert.deepEqual(imported.fetches.map(x => x.action), ['upload', 'recheck-import']);
});
test('factories are lazy, validate direction/token/session, and never allow caller URL overrides', () => {
  const h = harness(); assert.deepEqual(h.calls, []); assert.deepEqual(h.fetches, []);
  for (const token of ['bad', JOB + '\n', JOB.toUpperCase() + 'x']) assert.throws(() => api.createVerificationMediaSession(token, 'import', h.fetch), redacted);
  assert.throws(() => api.createVerificationMediaSession(JOB, 'download', h.fetch), redacted);
  h.admin = 'bad'; assert.throws(() => api.createVerificationMediaSession(JOB, 'import', h.fetch), redacted);
  assert.deepEqual(Object.keys(h.session).sort(), ['direction', 'inventory', 'bind', 'download', 'upload', 'recheckExport', 'recheckImport'].sort());
});
test('managed old-site URLs import through CURRENT env Edge only; export rejects foreign origin without fetching it', async () => {
  const f = fixture({ url: 'https://old-site-fixture.supabase.co' + PREFIX + `id-front/${USER}-fixture.jpg` });
  const into = harness(f); await into.stage();
  assert.ok(into.fetches.every(x => x.url === ORIGIN + '/functions/v1/employee-transfer-media'));
  assert.equal(into.objects.size, 1);
  const out = harness(f, 'export'); await assert.rejects(out.export(), redacted);
  assert.equal(out.fetches.length, 0); assert.equal(out.cleanup, 1);
});
test('low-level inventory/media bind cannot bypass actual raw record staging', async () => {
  const h = harness();
  await assert.rejects(h.session.bind(h.f.media), failed(false));
  assert.equal(h.calls.length, 1); assert.equal(h.fetches.length, 0); assert.equal(h.bound, null);
});
test('download progress waits for actual sink confirmation, not the Edge receipt', async () => {
  const h = harness(fixture(), 'export'), gate = deferred(), entered = deferred(), progress = [];
  h.beforeAppend = async path => { if (path.startsWith('media/')) { entered.resolve(); await gate.promise; } };
  const pending = h.export({ onProgress: p => progress.push(p) });
  await entered.promise; assert.deepEqual(progress, []); assert.ok(!h.events.includes('source-verify'));
  gate.resolve(); await pending; assert.equal(progress[0].files, 1);
});
test('upload progress waits for mandatory Storage readback AND commit receipt', async () => {
  const h = harness(), gate = deferred(), entered = deferred(), progress = [];
  h.beforeRead = async () => { entered.resolve(); await gate.promise; };
  const pending = h.stage({ onProgress: p => progress.push(p) });
  await entered.promise; assert.equal(progress.some(x => x.phase === 'upload'), false); assert.equal(h.cleanup, 0);
  gate.resolve(); await pending; assert.equal(progress.filter(x => x.phase === 'upload').length, 1);
});
test('export source changes only checked last; discard all temporary bytes, never close', async () => {
  const h = harness(fixture(), 'export'); h.sourceChange = true;
  await assert.rejects(h.export(), failed(true));
  assert.equal(h.cleanup, 1); assert.equal(h.sink.stored.size, 0); assert.equal(h.events.at(-2), 'source-verify');
});

const inventoryMutations = [
  ['scope', r => { r.scope = 'employee-verification'; }], ['direction', r => { r.direction = 'import'; }],
  ['extra', r => { r.url = SECRET; }], ['duplicate', r => { r.files.push(r.files[0]); }],
  ['wrong key', r => { r.files[0].key = 'a'.repeat(64); }], ['path', r => { r.files[0].path += 'x'; }],
  ['bucket', r => { r.files[0].bucket = 'chat-images'; }], ['unknown file', r => { r.files[0].file = {}; }],
  ['50MiB overflow', r => { r.files[0].file = { ...fileTuple(row().id_front_url), bytes: 50 * 1024 * 1024 + 1 }; }],
  ['3001 files', r => { r.files = Array.from({ length: 3001 }, () => r.files[0]); }],
  ['accessor', r => { Object.defineProperty(r.files[0], 'key', { enumerable: true, get() { assert.fail('accessor must not execute'); } }); }],
];
for (const [label, mutate] of inventoryMutations) test(`inventory strict validation: ${label}`, async () => {
  const h = harness(fixture(), 'export');
  h.beforeRpc = () => {
    const data = { scope: 'employee-verification-media', direction: 'export', files: h.f.media.map(f => ({ key: f.key, source_url: f.source_url, bucket: 'verification-documents', path: f.source_url.split(PREFIX)[1], file: null })), full_site_complete: false };
    mutate(data); return { data };
  };
  await assert.rejects(h.session.inventory(), failed(false)); assert.equal(h.calls.length, 1); assert.equal(h.fetches.length, 0);
});
const unsafeUrls = [
  'http://local-fixture.supabase.co' + PREFIX + `id-front/${USER}-x.jpg`,
  'https://evil.invalid' + PREFIX + `id-front/${USER}-x.jpg`,
  'https://local-fixture.supabase.co.evil.invalid' + PREFIX + `id-front/${USER}-x.jpg`,
  'https://user:pass@local-fixture.supabase.co' + PREFIX + `id-front/${USER}-x.jpg`,
  ORIGIN + ':443' + PREFIX + `id-front/${USER}-x.jpg`,
  ORIGIN + PREFIX + `id-front/${USER}-x.jpg?token=secret`,
  ORIGIN + PREFIX + `id-front/${USER}-x.jpg#fragment`,
  ORIGIN + PREFIX + `id-front/${USER}-a..b.jpg`,
  ORIGIN + PREFIX + `id-front/${USER}-%2f.jpg`,
  ORIGIN + PREFIX + `id-front/${ADMIN}-wrong-owner.jpg`,
  ORIGIN + '/storage/v1/object/public/chat-images/' + `id-front/${USER}-x.jpg`,
  ORIGIN + PREFIX + `id-front/${USER}-x.jpg\n`, '',
];
for (const [i, url] of unsafeUrls.entries()) test(`raw records reject unmanaged URL/owner ${i} before any write`, async () => {
  const h = harness(fixture({ url }));
  await assert.rejects(h.stage(), failed(false)); assert.equal(h.cleanup, 1); assert.equal(h.recordBound, false); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0);
  const ex = harness(fixture({ url }), 'export'); await assert.rejects(ex.export(), failed(false)); assert.equal(ex.calls.length, 0); assert.equal(ex.cleanup, 1);
});
for (const [label, mutate] of [
  ['manifest missing media', f => { f.manifest.entries.pop(); }], ['manifest extra', f => { f.manifest.entries.push({ path: 'media/verification-documents/extra.jpg', kind: 'media', bytes: 1, sha256: sha('x') }); }],
  ['file missing', (_f, h) => { h.contents.delete(mediaPath(h.f.media[0])); }], ['file extra', (_f, h) => { h.contents.set('data/extra.ndjson', bytesOf('x')); }],
  ['manifest digest', f => { f.manifest.entries[0].sha256 = 'a'.repeat(64); }], ['media manifest digest', f => { f.manifest.entries[1].sha256 = 'a'.repeat(64); }],
  ['manifest wrong scope', f => { f.manifest.scope = 'full-site'; }], ['manifest cross-package', f => { f.manifest.exportId = JOB; }],
  ['multivolume', f => { f.manifest.volumeCount = 2; }], ['duplicate path', f => { f.manifest.entries[1].path = RECORD_PATH; }],
  ['raw catalog row digest', f => { f.catalog.tables[0].row_hashes_sha256 = 'a'.repeat(64); }],
  ['raw catalog bytes', f => { f.catalog.tables[0].bytes--; f.manifest.entries[0].bytes--; }],
  ['tuple hash', f => { f.media[0].sha256 = 'a'.repeat(64); f.manifest.entries[1].sha256 = 'a'.repeat(64); }],
  ['tuple MIME', f => { f.media[0].content_type = 'image/png'; }], ['unsupported MIME', f => { f.media[0].content_type = 'text/html'; }],
  ['tuple bytes', f => { f.media[0].bytes++; f.manifest.entries[1].bytes++; }], ['tuple key', f => { f.media[0].key = 'a'.repeat(64); }],
  ['tuple omitted', f => { f.media = []; f.manifest.entries.pop(); }], ['tuple duplicate', f => { f.media.push(f.media[0]); }],
  ['path traversal', f => { f.manifest.entries[1].path = 'media/verification-documents/../x.jpg'; }],
  ['malformed raw type', (f, h) => {
    const raw = f.raw.replace('"approved"', '123'); h.contents.set(RECORD_PATH, bytesOf(raw)); f.catalog = catalog(raw);
    f.manifest.entries[0] = { path: RECORD_PATH, kind: 'ndjson', bytes: Buffer.byteLength(raw), sha256: sha(raw) };
  }],
  ['duplicate raw field', (f, h) => {
    const raw = f.raw.replace('{', '{"status":"pending",'); h.contents.set(RECORD_PATH, bytesOf(raw)); f.catalog = catalog(raw);
    f.manifest.entries[0] = { path: RECORD_PATH, kind: 'ndjson', bytes: Buffer.byteLength(raw), sha256: sha(raw) };
  }],
]) test(`full preflight rejects ${label} before raw/media bind or upload`, async () => {
  const f = fixture(), h = harness(f); mutate(f, h);
  await assert.rejects(h.stage(), failed(false));
  assert.equal(h.cleanup, 1); assert.equal(h.contents.size, 0); assert.equal(h.recordBound, false); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0);
});
test('strict key order and aggregate 1GiB bound reject before opening plaintext or writing', async () => {
  for (const mode of ['order', 'total']) {
    const f = fixture(), h = harness(f);
    f.media = Array.from({ length: 22 }, (_, i) => fileTuple(ORIGIN + PREFIX + `id-front/${USER}-${i}.jpg`)).sort((a, b) => a.key.localeCompare(b.key));
    if (mode === 'order') f.media.reverse(); else f.media.forEach(file => { file.bytes = 50 * 1024 * 1024; });
    await assert.rejects(h.stage(), failed(false)); assert.equal(h.opens.size, 0); assert.equal(h.calls.length, 0);
  }
});
for (const header of ['x-transfer-sha256', 'x-transfer-content-type', 'content-type']) test(`download header ${header} tampering discards plaintext`, async () => {
  const h = harness(fixture(), 'export');
  h.afterFetch = (res, action) => {
    if (action !== 'download') return res;
    const headers = new Headers(res.headers); headers.set(header, header.endsWith('sha256') ? 'a'.repeat(64) : 'image/png');
    return new Response(res.body, { headers });
  };
  await assert.rejects(h.export(), failed(true)); assert.equal(h.cleanup, 1); assert.equal(h.fetches.length, 1); assert.ok(!h.events.includes('source-verify'));
});
test('bounded download does not call arrayBuffer or read beyond first oversized fragment', async () => {
  const h = harness(fixture(), 'export'); let pulls = 0, cancels = 0;
  h.beforeFetch = () => {
    const response = new Response(new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(50 * 1024 * 1024 + 1)); }, cancel() { cancels++; } }, { highWaterMark: 0 }),
      { headers: { 'content-type': 'application/octet-stream', 'x-transfer-sha256': sha(JPG), 'x-transfer-content-type': 'image/jpeg' } });
    response.arrayBuffer = () => assert.fail('unbounded arrayBuffer forbidden'); return response;
  };
  await assert.rejects(h.export(), failed(true)); assert.equal(pulls, 1); assert.equal(cancels, 1);
});
test('media second read catches mutable workspace drift before upload', async () => {
  const h = harness();
  h.beforeRpc = name => { if (name === 'employee_import_verification_media_bind') { const changed = new Uint8Array(JPG); changed[4] ^= 1; h.contents.set(mediaPath(h.f.media[0]), changed); } };
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1); assert.ok(h.bound);
});
test('extra server inventory file prevents media bind/upload after actual raw staging', async () => {
  const h = harness();
  h.beforeRpc = name => name === 'get_employee_transfer_verification_media' ? { data: { scope: 'employee-verification-media', direction: 'import', files: [], full_site_complete: false } } : null;
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.staged, true); assert.equal(h.bound, null); assert.equal(h.fetches.length, 0);
});
test('upload readback drift leaves object intact, no retry/delete or fake rollback', async () => {
  const h = harness();
  h.beforeRead = () => ({ data: new Response(Uint8Array.of(255, 216, 255, 5)), error: null });
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.objects.size, 1); assert.equal(h.fetches.length, 1); assert.equal(h.cleanup, 1);
});
test('explicit final import recheck detects same-size post-apply drift', async () => {
  const h = harness(); await h.stage();
  const changed = new Uint8Array(JPG); changed[5] ^= 1;
  h.objects.set(h.targetPath(h.f.media[0]), new Blob([changed]));
  await assert.rejects(h.session.recheckImport(h.f.media), failed(true));
  assert.equal(h.checked.size, 0); assert.equal(h.objects.size, 1); assert.deepEqual(h.fetches.map(x => x.action), ['upload', 'recheck-import']);
});
for (const action of ['download', 'recheck-export', 'upload', 'recheck-import']) test(`${action} failure is redacted and never automatically retried`, async () => {
  const h = harness(fixture(), action.endsWith('export') || action === 'download' ? 'export' : 'import');
  if (action === 'recheck-import') await h.stage();
  const before = h.fetches.length;
  h.beforeFetch = a => { if (a === action) throw Error(`${SECRET} ${ADMIN} ${row().id_front_url}`); };
  if (action === 'recheck-import') await assert.rejects(h.session.recheckImport(h.f.media), failed(true));
  else await assert.rejects(action === 'upload' ? h.stage() : h.export(), failed(true));
  assert.equal(h.fetches.filter(x => x.action === action).length, 1);
  assert.ok(h.fetches.length <= before + (action === 'recheck-export' ? 2 : 1));
});
test('raw record changes on later read cannot upload or invent a plan', async () => {
  const h = harness(), open = h.files.open;
  h.files.open = path => { if (path === RECORD_PATH && h.opens.get(path) === 1) h.contents.set(path, bytesOf(h.f.raw.replace('approved', 'rejected'))); return open(path); };
  await assert.rejects(h.stage(), failed(false)); assert.equal(h.recordBound, false); assert.equal(h.fetches.length, 0);
});
for (const operation of ['stage', 'export']) test(`${operation}: pre-abort and abort reason never leak or send requests`, async () => {
  const h = harness(fixture(), operation === 'stage' ? 'import' : 'export'), c = new AbortController(); c.abort(SECRET);
  await assert.rejects(h[operation]({ signal: c.signal }), failed(false, true)); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
});
for (const phase of ['record-stage', 'upload', 'sink', 'record-sink']) test(`abort during pending ${phase} awaits settlement before plaintext cleanup`, async () => {
  const isExport = phase === 'sink' || phase === 'record-sink';
  const h = harness(fixture(), isExport ? 'export' : 'import'), gate = deferred(), entered = deferred(), c = new AbortController(), p = [];
  const wait = async () => { entered.resolve(); await gate.promise; };
  if (phase === 'record-stage') h.beforeStage = wait;
  if (phase === 'upload') h.beforeWrite = wait;
  if (isExport) h.beforeAppend = async path => { if (phase === 'record-sink' ? path === RECORD_PATH : path.startsWith('media/')) await wait(); };
  let finished = false;
  const pending = (isExport ? h.export : h.stage)({ signal: c.signal, onProgress: x => p.push(x) });
  const rejectionCheck = assert.rejects(pending, failed(phase !== 'record-sink', true)).finally(() => { finished = true; });
  await entered.promise; c.abort(SECRET); await nextTurn(); assert.equal(finished, false); assert.equal(h.cleanup, 0);
  gate.resolve(); await rejectionCheck; assert.equal(h.cleanup, 1);
  assert.equal(p.some(x => x.phase === 'upload' || x.phase === 'export'), false);
  const events = h.events.length; await nextTurn(); assert.equal(h.events.length, events, 'no late writes after cleanup');
});
for (const mode of ['success', 'failure']) test(`abort while ${mode} cleanup is pending still reports possible server staging/uploads`, async () => {
  const h = harness(), gate = deferred(), entered = deferred(), c = new AbortController();
  h.beforeAbort = async () => { entered.resolve(); await gate.promise; };
  if (mode === 'failure') h.beforeFetch = () => { throw Error(SECRET); };
  const pending = h.stage({ signal: c.signal }), rejectionCheck = assert.rejects(pending, failed(true, true));
  await entered.promise; c.abort(SECRET); gate.resolve(); await rejectionCheck;
  assert.equal(h.cleanup, 1); assert.equal(h.contents.size, 0);
});
test('cleanup failure is explicit and redacted; uploads remain, workspace cannot be reused', async () => {
  const h = harness(); h.beforeAbort = () => { throw Error(SECRET); };
  await assert.rejects(h.stage(), failed(true, false, true)); assert.equal(h.objects.size, 1); assert.equal(h.cleanup, 1);
});
test('session is mutually exclusive until aborted transport settles; no overlapping workers', async () => {
  const h = harness(fixture(), 'export'), gate = deferred(), entered = deferred(), c = new AbortController();
  h.beforeFetch = async () => { entered.resolve(); await gate.promise; throw Error(SECRET); };
  const pending = h.session.download((await h.session.inventory()).files[0], c.signal), rejected = assert.rejects(pending, failed(true, true));
  await entered.promise; c.abort(SECRET);
  await assert.rejects(h.session.inventory(), failed(false)); assert.equal(h.fetches.length, 1);
  gate.resolve(); await rejected;
});
test('empty history uses actual empty raw stage and real media binding/plan; no fabricated files/progress', async () => {
  const h = harness(fixture({ raw: '' })), p = [];
  const result = await h.stage({ onProgress: x => p.push(x) });
  assert.equal(result.files, 0); assert.equal(result.rows, 0); assert.equal(result.bytes, 0); assert.equal(result.plan.can_restore, true);
  assert.equal(h.staged, true); assert.deepEqual(h.bound, []); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
  assert.equal(p.some(x => x.phase === 'upload'), false);
});
function multiFixture() {
  const r = row(); r.id_back_url = ORIGIN + PREFIX + `id-back/${USER}-second.jpg`; r.selfie_url = ORIGIN + PREFIX + `selfie/${USER}-third.jpg`;
  return fixture({ raw: JSON.stringify(r) + '\n' });
}
function twoEmployeeFixture() {
  const first = row(), employeeId = '66666666-6666-4666-8666-666666666666';
  const second = { ...row(ORIGIN + PREFIX + `id-front/${employeeId}-fixture.jpg`), id: employeeId, user_id: employeeId };
  const f = fixture({ raw: [first, second].map(r => JSON.stringify(r) + '\n').join('') });
  f.catalog.identity_catalog.tables[0].rows = 2;
  f.catalog.identity_catalog.tables[0].bytes = 1000;
  return f;
}
function reopen(h) {
  h.contents = new Map([...h.f.contents].map(([path, bytes]) => [path, new Uint8Array(bytes)]));
  h.session = api.createVerificationMediaSession(JOB, 'import', h.fetch);
}
for (const partialApply of [false, true]) test(`same-package replay after actual Edge uploads, ${partialApply ? 'one of two employees applied' : 'no employee applied'}`, async () => {
  const f = twoEmployeeFixture(), h = harness(f), first = await h.stage();
  assert.equal(first.plan.can_restore, true); assert.equal(h.objects.size, f.media.length);
  if (partialApply) await h.apply(USER);
  assert.equal(h.appliedEmployees.size, partialApply ? 1 : 0);
  const serverPlan = await h.target.plan();
  assert.equal(serverPlan.can_restore, true); assert.deepEqual(serverPlan.conflicts, []);
  const records = structuredClone([...h.appliedRecords]), employees = [...h.appliedEmployees];
  const bound = structuredClone(h.bound), raw = h.recordRaw, serverCatalog = structuredClone(h.recordCatalog);
  const objects = new Map(h.objects), opens = new Map(h.opens), fetchCount = h.fetches.length, callCount = h.calls.length, eventCount = h.events.length;
  const input = structuredClone({ catalog: f.catalog, media: f.media, manifest: f.manifest });
  reopen(h);
  const progress = [], result = await h.stage({ onProgress: p => progress.push(p) });
  assert.deepEqual(result.plan, serverPlan); assert.equal(result.fullSiteComplete, false);
  assert.deepEqual([...h.appliedRecords], records); assert.deepEqual([...h.appliedEmployees], employees);
  assert.equal(h.recordRaw, raw); assert.equal(raw, f.raw); assert.deepEqual(h.recordCatalog, serverCatalog); assert.deepEqual(h.bound, bound);
  assert.deepEqual({ catalog: f.catalog, media: f.media, manifest: f.manifest }, input);
  assert.equal(h.opens.get(RECORD_PATH) - opens.get(RECORD_PATH), 3);
  for (const file of f.media) {
    assert.equal(h.opens.get(mediaPath(file)) - opens.get(mediaPath(file)), 2);
    assert.equal(h.objects.get(h.targetPath(file)), objects.get(h.targetPath(file)), 'occupied object is not overwritten');
    assert.deepEqual(new Uint8Array(await h.objects.get(h.targetPath(file)).arrayBuffer()), f.contents.get(mediaPath(file)));
  }
  assert.equal(h.cleanup, 2); assert.equal(h.contents.size, 0); assert.equal(h.objects.size, objects.size);
  assert.deepEqual(h.fetches.slice(fetchCount).map(x => x.action), ['upload', 'upload']);
  assert.deepEqual(h.calls.slice(callCount).map(x => x.name), ['get_employee_transfer_verification_media', 'get_employee_transfer_verification_media', 'employee_import_verification_media_bind']);
  assert.deepEqual(progress.filter(p => p.phase === 'upload').map(p => p.files), [1, 2]);
  const replayEvents = h.events.slice(eventCount);
  for (const file of f.media) assert.ok(replayEvents.indexOf(`open:${mediaPath(file)}:3`) < replayEvents.indexOf('record-bind'));
  assert.equal(replayEvents.filter(e => e === 'record-stage').length, 1);
  assert.equal(replayEvents.filter(e => e === 'store-read').length, 2);
  assert.equal(replayEvents.some(e => /apply|verify|close|recheck/.test(e)), false);
  assert.equal(h.checked.size, 0);
});
for (const change of ['tuple', 'catalog', 'record', 'first-read-media', 'second-read-media', 'inventory']) test(`approved replay still rejects ${change} drift without altering existing employees/files`, async () => {
  const f = twoEmployeeFixture(), h = harness(f); await h.stage(); await h.apply(USER);
  const records = structuredClone([...h.appliedRecords]), bound = structuredClone(h.bound), objects = new Map(h.objects), raw = h.recordRaw;
  const beforeFetch = h.fetches.length, beforeCalls = h.calls.length;
  reopen(h);
  if (change === 'tuple') {
    const file = f.media[0], bytes = new Uint8Array(JPG); bytes[4] ^= 1;
    file.sha256 = sha(bytes); h.contents.set(mediaPath(file), bytes);
    f.manifest.entries.find(e => e.path === mediaPath(file)).sha256 = file.sha256;
  } else if (change === 'catalog') {
    f.raw = f.raw.replace('approved', 'rejected'); f.catalog.tables = catalog(f.raw).tables;
    h.contents.set(RECORD_PATH, bytesOf(f.raw));
    f.manifest.entries[0] = { path: RECORD_PATH, kind: 'ndjson', bytes: Buffer.byteLength(f.raw), sha256: sha(f.raw) };
  } else if (change === 'record') h.contents.set(RECORD_PATH, bytesOf(f.raw.replace('approved', 'rejected')));
  else if (change === 'first-read-media') h.contents.set(mediaPath(f.media.at(-1)), bytesOf('corrupt'));
  else if (change === 'second-read-media') {
    h.beforeRpc = name => { if (name === 'employee_import_verification_media_bind') {
      const bytes = new Uint8Array(JPG); bytes[4] ^= 1; h.contents.set(mediaPath(f.media[0]), bytes);
    } };
  } else h.beforeRpc = name => name === 'get_employee_transfer_verification_media'
    ? { data: { scope: 'employee-verification-media', direction: 'import', files: [], full_site_complete: false } } : null;
  await assert.rejects(h.stage(), failed(!['record', 'first-read-media'].includes(change)));
  assert.equal(h.fetches.length, beforeFetch); assert.equal(h.cleanup, 2); assert.equal(h.contents.size, 0);
  assert.deepEqual([...h.appliedRecords], records); assert.deepEqual(h.bound, bound); assert.equal(h.recordRaw, raw);
  for (const [path, blob] of objects) assert.equal(h.objects.get(path), blob);
  if (change === 'tuple') assert.deepEqual(h.calls.slice(beforeCalls).map(x => x.name), ['get_employee_transfer_verification_media']);
});
test('replay cannot replace immutable media binding even if inventory omits its existing tuple', async () => {
  const f = fixture(), h = harness(f); await h.stage();
  const bound = structuredClone(h.bound), objects = new Map(h.objects), calls = h.calls.length, fetches = h.fetches.length;
  reopen(h);
  const bytes = new Uint8Array(JPG); bytes[4] ^= 1;
  f.media[0].sha256 = sha(bytes); h.contents.set(mediaPath(f.media[0]), bytes);
  f.manifest.entries[1].sha256 = sha(bytes);
  h.beforeRpc = name => name === 'get_employee_transfer_verification_media' ? { data: {
    scope: 'employee-verification-media', direction: 'import', full_site_complete: false,
    files: [{ key: f.media[0].key, source_url: f.media[0].source_url, bucket: 'verification-documents', path: f.media[0].source_url.split(PREFIX)[1], file: null }],
  } } : null;
  await assert.rejects(h.stage(), failed(true));
  assert.equal(h.calls.at(-1).name, 'employee_import_verification_media_bind'); assert.equal(h.calls.length - calls, 3);
  assert.equal(h.fetches.length, fetches); assert.deepEqual(h.bound, bound); assert.deepEqual(h.objects, objects); assert.equal(h.cleanup, 2);
});
for (const conflict of ['verification_target_not_empty', 'verification_uuid_collision', 'source_employee_missing', 'verification_admin_unmapped']) {
  for (const hasMedia of [true, false]) test(`no media_incomplete: ${conflict} blocks uploads/binding with ${hasMedia ? 'media' : 'no media'}`, async () => {
    const h = harness(hasMedia ? fixture() : fixture({ raw: '' }));
    const plan = { scope: 'employee-verification', can_restore: false, counts: { verification_requests: h.f.catalog.tables[0].rows }, employees: 1,
      conflicts: [conflict], plan_hash: 'b'.repeat(64), ...flags };
    h.beforePlan = () => structuredClone(plan);
    await assert.rejects(h.stage(), failed(true));
    assert.equal(h.staged, true); assert.equal(h.bound, null); assert.equal(h.calls.length, 0); assert.equal(h.fetches.length, 0);
    assert.equal(h.cleanup, 1); assert.equal(h.contents.size, 0); assert.equal(plan.can_restore, false); assert.deepEqual(plan.conflicts, [conflict]);
  });
}
test('all media files must validate before the FIRST record bind, even when the final file is corrupt', async () => {
  const f = multiFixture(), h = harness(f), last = f.media.at(-1);
  h.contents.set(mediaPath(last), bytesOf('bad file'));
  await assert.rejects(h.stage(), failed(false));
  assert.equal(h.recordBound, false); assert.equal(h.fetches.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.cleanup, 1);
});
test('multiple files are truly serial with strict key order, full rechecks, exact paths and confirmed progress', async () => {
  const f = multiFixture(), h = harness(f, 'export'), out = await h.export();
  assert.deepEqual(out.media.map(x => x.key), f.media.map(x => x.key));
  assert.deepEqual(h.fetches.map(x => x.action), ['download', 'download', 'download', 'recheck-export', 'recheck-export', 'recheck-export']);
  const into = harness(f), p = []; await into.stage({ onProgress: x => p.push(x) });
  assert.deepEqual(into.fetches.map(x => x.init.headers['x-transfer-object-key']), f.media.map(x => x.key));
  assert.deepEqual(p.filter(x => x.phase === 'upload').map(x => x.files), [1, 2, 3]);
  for (const file of f.media) assert.equal(into.opens.get(mediaPath(file)), 2);
  await into.session.recheckImport(f.media); assert.equal(into.checked.size, 3);
});
test('no progress for an unconfirmed second upload; previously uploaded objects stay untouched', async () => {
  const f = multiFixture(), h = harness(f), p = [];
  h.beforeFetch = action => { if (action === 'upload' && h.fetches.length === 2) throw Error(SECRET); };
  await assert.rejects(h.stage({ onProgress: x => p.push(x) }), failed(true));
  assert.deepEqual(p.filter(x => x.phase === 'upload').map(x => x.files), [1]);
  assert.equal(h.objects.size, 1); assert.equal(h.cleanup, 1); assert.equal(h.fetches.length, 2);
});
for (const direction of ['export', 'import']) test(`${direction} inventory correspondence rejects source tuple drift`, async () => {
  const h = harness(fixture(), direction);
  h.beforeRpc = name => name === 'get_employee_transfer_verification_media' ? { data: {
    scope: 'employee-verification-media', direction, full_site_complete: false,
    files: [fileTuple(ORIGIN + PREFIX + `id-front/${USER}-different.jpg`)].map(f => ({ key: f.key, source_url: f.source_url, bucket: 'verification-documents', path: f.source_url.split(PREFIX)[1], file: null })),
  } } : null;
  await assert.rejects(direction === 'export' ? h.export() : h.stage(), failed(direction === 'import'));
  assert.equal(h.bound, null); assert.equal(h.fetches.length, 0);
});
for (const field of ['key', 'bytes', 'sha256', 'content_type', 'success', 'full_site_complete', 'extra']) test(`upload acknowledgement ${field} mismatch is not progress/success`, async () => {
  const h = harness(), p = [];
  h.afterFetch = async (res, action) => {
    if (action !== 'upload') return res;
    const r = await res.json();
    r[field] = field === 'bytes' ? r.bytes + 1 : field === 'success' ? false : field === 'full_site_complete' ? true : SECRET;
    return new Response(JSON.stringify(r));
  };
  await assert.rejects(h.stage({ onProgress: x => p.push(x) }), failed(true));
  assert.equal(p.some(x => x.phase === 'upload'), false); assert.equal(h.fetches.length, 1); assert.equal(h.objects.size, 1);
});
for (const mode of ['http-error', 'invalid-json', 'oversized-json']) test(`Edge ${mode} never leaks backend text or retries`, async () => {
  const h = harness();
  h.afterFetch = () => new Response(mode === 'invalid-json' ? SECRET : JSON.stringify({ error: SECRET.repeat(mode === 'oversized-json' ? 500 : 1) }), { status: mode === 'http-error' ? 502 : 200 });
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.fetches.length, 1); assert.equal(h.objects.size, 1);
});
for (const field of ['success', 'scope', 'files', 'bytes', 'repeated', 'full_site_complete']) test(`media bind receipt ${field} must be exact before any upload`, async () => {
  const h = harness();
  h.beforeRpc = name => {
    if (name !== 'employee_import_verification_media_bind') return;
    const r = { success: true, scope: 'employee-verification-media', files: 1, bytes: JPG.length, repeated: false, full_site_complete: false };
    r[field] = SECRET; return { data: r };
  };
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.fetches.length, 0); assert.equal(h.cleanup, 1);
});
test('media bind backend rejection cannot be treated as server rollback', async () => {
  const h = harness(); h.beforeRpc = name => name.endsWith('media_bind') ? { error: { message: SECRET } } : null;
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.fetches.length, 0); assert.equal(h.calls.filter(x => x.name.endsWith('media_bind')).length, 1);
});
test('media-independent raw record semantic violations cannot pass with matching container digests', async () => {
  for (const replacement of ['"bad-status"', 'null', '123']) {
    const raw = (JSON.stringify(row(null)) + '\n').replace('"approved"', replacement), f = fixture({ raw }), h = harness(f);
    await assert.rejects(h.stage(), failed(false)); assert.equal(h.recordBound, false); assert.equal(h.fetches.length, 0);
  }
});
test('already downloaded inventory tuple is checked against actual download, not trusted', async () => {
  const h = harness(fixture(), 'export'); h.receipts.set(h.f.media[0].key, { ...h.f.media[0], sha256: 'a'.repeat(64) });
  await assert.rejects(h.export(), failed(true)); assert.equal(h.fetches.length, 1); assert.equal(h.cleanup, 1);
});
test('recheck-export content drift blocks final source.verify', async () => {
  const h = harness(fixture(), 'export');
  h.beforeFetch = action => { if (action === 'recheck-export') { const changed = new Uint8Array(JPG); changed[6] ^= 1; h.objects.set(h.f.media[0].source_url.split(PREFIX)[1], new Blob([changed])); } };
  await assert.rejects(h.export(), failed(true)); assert.ok(!h.events.includes('source-verify')); assert.equal(h.cleanup, 1);
});
test('refreshed server plan is returned unchanged if still conflicted; no fabricated conflict-free approval', async () => {
  const h = harness(); let calls = 0;
  h.beforePlan = () => ++calls === 2 ? { scope: 'employee-verification', can_restore: false, counts: { verification_requests: 1 }, employees: 1,
    conflicts: ['verification_admin_unmapped'], plan_hash: 'b'.repeat(64), ...flags } : null;
  const r = await h.stage(); assert.equal(r.plan.can_restore, false); assert.deepEqual(r.plan.conflicts, ['verification_admin_unmapped']);
  assert.equal(r.plan.plan_hash, 'b'.repeat(64)); assert.equal(h.cleanup, 1);
});
test('approved server plan never skips inventory/tuple correspondence', async () => {
  const h = harness(); h.beforePlan = () => ({ scope: 'employee-verification', can_restore: true, counts: { verification_requests: 1 }, employees: 1,
    conflicts: [], plan_hash: 'a'.repeat(64), ...flags });
  h.beforeRpc = () => ({ data: { scope: 'employee-verification-media', direction: 'import', files: [], full_site_complete: false } });
  await assert.rejects(h.stage(), failed(true)); assert.equal(h.bound, null); assert.equal(h.fetches.length, 0);
  assert.equal(h.calls[0].name, 'get_employee_transfer_verification_media');
});
for (const direction of ['import', 'export']) test(`${direction} cleanup failures before any server write retain accurate uncertainty`, async () => {
  const h = harness(fixture({ url: '' }), direction); h.beforeAbort = () => { throw Error(SECRET); };
  await assert.rejects(direction === 'import' ? h.stage() : h.export(), failed(false, false, true));
  assert.equal(h.cleanup, 1); assert.equal(h.fetches.length, 0);
});
test('late Edge response after abort is cancelled and awaited before plaintext cleanup', async () => {
  const h = harness(fixture(), 'export'), gate = deferred(), entered = deferred(), c = new AbortController(); let cancelled = 0;
  h.beforeFetch = async () => {
    entered.resolve(); await gate.promise;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { 'content-type': 'application/octet-stream' } });
  };
  const pending = h.export({ signal: c.signal }), rejected = assert.rejects(pending, failed(true, true));
  await entered.promise; c.abort(SECRET); assert.equal(h.cleanup, 0); gate.resolve(); await rejected;
  assert.equal(cancelled, 1); assert.equal(h.cleanup, 1);
});
async function collect(source) { const parts = []; for await (const p of source) parts.push(Buffer.from(p)); return Buffer.concat(parts); }
async function* fragments(bytes) { for (let i = 0; i < bytes.length; i += 127) yield bytes.subarray(i, i + 127); }
test('real encrypted container: do not expose quarantined plaintext until authenticated EOF; truncation never stages', async () => {
  const f = fixture(), info = { ...f.manifest }; delete info.entries; delete info.version;
  const entries = async function* () { for (const [path, bytes] of f.contents) yield { path, bytes: bytes.length, open: () => fragments(bytes) }; };
  const encrypted = await collect(api.writeEncryptedVolume(entries(), info, 'local-fixture-passphrase', { chunkSize: 113 }));
  for (const broken of [true, false]) {
    const h = harness(f), quarantine = new Map(); let authenticated = false;
    const sink = { async append(path, bytes) { quarantine.set(path, Buffer.concat([quarantine.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)])); }, async abort() { quarantine.clear(); } };
    const load = async () => {
      const manifest = await api.verifyEncryptedVolume(fragments(broken ? encrypted.subarray(0, -1) : encrypted), 'local-fixture-passphrase', sink,
        { expectedMetadata: { exportId: info.exportId, volumeId: info.volumeId } });
      authenticated = true; h.contents = quarantine;
      const open = h.files.open; h.files.open = path => { assert.equal(authenticated, true); return open(path); };
      return api.stageVerificationBundle({ catalog: f.catalog, media: f.media, manifest }, h.files, h.target, h.session);
    };
    if (broken) {
      await assert.rejects(load()); assert.equal(authenticated, false); assert.equal(h.recordBound, false); assert.equal(h.fetches.length, 0); assert.equal(quarantine.size, 0);
    } else { const r = await load(); assert.equal(r.plan.can_restore, true); assert.equal(quarantine.size, 0); }
  }
});
