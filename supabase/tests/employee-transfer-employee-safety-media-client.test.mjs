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
function account() {
  return Object.fromEntries(Object.keys(api.EMPLOYEE_BACKUP_PROJECTIONS.accounts).map(key => [key,
    key === 'id' ? EMPLOYEE : key === 'username' ? NAME : key === 'password_hash' ? '$2a$private-record-hash' : key === 'employee_id' ? 'E-001' : null]));
}
function recordCatalog(texts) {
  return { version: 1, protocol: 'employee-safety-records-v1', scope: 'employee-safety-records', job_id: JOB, site_id: SITE,
    employee_id: EMPLOYEE, username: NAME,
    tables: TABLES.map(key => ({ key, rows: texts[key] ? 1 : 0, bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: sha(texts[key] ? sha(texts[key]) : '') })), fingerprint: FINGERPRINT, ...RECORD_FLAGS };
}
function ref(c, kind = 'chat', options = {}) {
  const r = { key: '', source_url: '', kind, bucket: kind === 'verification' ? 'verification-documents' : kind === 'archives' ? 'content-audit-evidence' : 'chat-images',
    path: kind === 'verification' ? `id-front/${EMPLOYEE}-fixture.jpg` : kind === 'archives' ? 'PRIVATE-evidence/shared/raw' : 'fixture.jpg', avatar: false, file: null, ...options };
  r.source_url = `employee-safety-media-v1:${c.site_id}:${c.job_id}:${c.employee_id}:${c.fingerprint}:${sha('row\n')}:${sha(r.kind + ':' + r.path)}:${sha(r.bucket + '/' + r.path)}`;
  r.key = sha(r.source_url); return r;
}
const fileTuple = (r, bytes = JPEG, type = 'image/jpeg') => ({ key: r.key, source_url: r.source_url, bytes: bytes.length, sha256: sha(bytes), content_type: type });
const receipt = file => ({ success: true, key: file.key, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, ...FLAGS });
function base() {
  const texts = Object.fromEntries(TABLES.map(key => [key, key === 'accounts' ? JSON.stringify(account()) + '\n' : '']));
  const catalog = recordCatalog(texts); return { texts, catalog };
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
  const b = base(), h = { ...b, directory, spaces: [], events: [], calls: [], session: SESSION, bound: new Map(), checked: new Set(), objects: new Map(),
    rpcHook: null, transform: null, transportHook: null, cleanupHook: null, appendHook: null, fileWriteHook: null, edgeCommitHook: null, transportCalls: 0, verifyCount: 0 };
  h.refs = empty ? [] : [ref(h.catalog, 'verification'), ref(h.catalog, 'chat', { bucket: 'super-customer-avatars', path: 'avatars/fixture.png', avatar: true }),
    ref(h.catalog, 'notifications', { path: 'notification.pdf' }), ref(h.catalog, 'archives')].sort((a, b) => a.key.localeCompare(b.key));
  for (const r of h.refs) h.objects.set(r.key, { bytes: r.avatar ? PNG : r.kind === 'notifications' ? PDF : JPEG, type: r.avatar ? 'image/png' : r.kind === 'notifications' ? 'application/pdf' : 'image/jpeg' });
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
    const w = { base: join(directory, `workspace-${h.spaces.length}`), cleaned: false, cleanups: 0,
      async append(path, raw, signal) {
        assert.equal(w.cleaned, false); assert.equal(signal.aborted, false); assert.ok(raw.length <= 1024 * 1024);
        if (h.appendHook) await h.appendHook(w, path, raw, signal);
        assert.equal(w.cleaned, false); assert.equal(signal.aborted, false);
        await mkdir(dirname(join(w.base, path)), { recursive: true }); assert.equal(w.cleaned, false); await appendFile(join(w.base, path), raw);
      },
      open(path) { return { async *[Symbol.asyncIterator]() {
        assert.equal(w.cleaned, false); for await (const chunk of createReadStream(join(w.base, path), { highWaterMark: 4096 })) { assert.equal(w.cleaned, false); yield chunk; }
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
  assert.equal(r.files, h.refs.length); assert.equal(r.mediaVerified, true); assert.equal(r.cipherSha256, sha(disk)); assert.equal(r.cipherBytes, disk.length);
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
  const h = await prepared(t, true);
  h.refs = Array.from({ length: 80 }, (_, i) => ref(h.catalog, 'chat', { path: `con./${'a'.repeat(120)}/${i}.JPG` })).sort((a, b) => a.key.localeCompare(b.key));
  for (const r of h.refs) h.objects.set(r.key, { bytes: JPEG, type: 'image/jpeg' });
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
  const h = await prepared(t, true), r = ref(h.catalog), inv = inventory(h.catalog, [r]);
  h.source = { inventory: async () => inv, download: async () => ({ file: { ...fileTuple(r), bytes: JPEG.length + 1 }, bytes: JPEG }),
    recheck: async () => assert.fail('Invalid bytes cannot reach recheck'), verify: async () => assert.fail('Invalid bytes cannot reach verify') };
  await failedExport(h, {}, e => assert.equal(e.encryptedFileState, 'not-written')); assert.equal(h.media.writes, 0);
});
test('local magic inspection covers PDF/MP4/WebM in their allowed media kinds', async t => {
  const h = await prepared(t, true);
  h.refs = [ref(h.catalog, 'notifications', { path: 'a.mp4' }), ref(h.catalog, 'chat', { path: 'b.webm' }), ref(h.catalog, 'verification', { path: `selfie/${EMPLOYEE}-a.pdf` })].sort((a, b) => a.key.localeCompare(b.key));
  for (const r of h.refs) h.objects.set(r.key, { bytes: r.path.endsWith('mp4') ? MP4 : r.path.endsWith('webm') ? WEBM : PDF });
  await h.export(); await h.read(); cleaned(h);
});
