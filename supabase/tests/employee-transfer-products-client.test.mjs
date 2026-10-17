import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { after, before, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const apiPath = `${root}src/lib/employeeTransfer/api.ts`;
const SESSION = '11111111-1111-4111-8111-111111111111';
const PACKAGE = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const PASSWORD = 'local-only-admin-password';
const PASSPHRASE = 'local-only-encryption-passphrase';
const PATH = 'data/products.ndjson';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PLAN = hash('local product plan');
const TARGET = hash('local target products');
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const row = n => ({ id: id(n), name: `产品é é 𠮷 ${n}`, is_active: n % 3 ? n % 2 === 0 : null,
  sort_order: n % 2 ? -2147483648 : 0, created_at: n % 2 ? null : '2024-02-29T23:59:59.123456+08:00',
  updated_at: '2026-10-18T01:02:03Z' });
const lines = n => Array.from({ length: n }, (_, index) => JSON.stringify(row(index + 1)) + '\n').join('');
const count = text => [...Buffer.from(text)].filter(byte => byte === 10).length;
const confirmed = () => ({ success: true, scope: 'product-catalog', full_site_complete: false });
const verified = () => ({ verified: true, scope: 'product-catalog', full_site_complete: false });
const dry = () => ({ scope: 'product-catalog', full_site_complete: false, can_apply: true,
  conflicts: [], records: [], plan_hash: PLAN });
const ack = text => ({ success: true, rows: count(text), bytes: Buffer.byteLength(text), sha256: hash(text), repeated: false });
const seal = (sha256, bytes) => ({ success: true, backup_id: JOB, sha256, bytes, repeated: false, full_site_complete: false });
const catalogFor = text => ({ version: 1, scope: 'product-catalog', site_id: SITE,
  tables: [{ key: 'product_types', rows: count(text), bytes: Buffer.byteLength(text), sha256: hash(text) }], full_site_complete: false });
const descriptorFor = catalog => ({ backup_id: JOB, plan_hash: PLAN, target_hash: TARGET, catalog });
const info = { scope: 'replacement-backup', exportId: PACKAGE, volumeId: JOB, sourceSiteId: SITE,
  volumeIndex: 1, volumeCount: 1, createdAt: '2026-10-18T01:02:03.000Z' };
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/productTransfer.ts';
    export * from './src/lib/employeeTransfer/productBackup.ts';
    export * from './src/lib/employeeTransfer/api.ts';
    export { writeEncryptedVolume, verifyEncryptedVolume } from './src/lib/employeeTransfer/container.ts';
    export { setHarness } from 'product-test:state';`,
  resolveDir: root, sourcefile: 'products-client-entry.mjs', loader: 'js' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', metafile: true,
  plugins: [{ name: 'local-only-auth-and-rpc', setup(build) {
    build.onResolve({ filter: /^product-test:state$/ }, () => ({ path: 'state', namespace: 'product-test' }));
    build.onResolve({ filter: /^\.\.\/(auth|supabase)$/ }, args => {
      assert.equal(args.importer, apiPath);
      return { path: args.path.slice(3), namespace: 'product-test' };
    });
    build.onLoad({ filter: /.*/, namespace: 'product-test' }, ({ path }) => {
      if (path === 'state') return { contents: 'let h; export const setHarness = value => { h = value; }; export const current = () => h;' };
      if (path === 'auth') return { contents: `export const getAdminFinancialSessionToken = () => '${SESSION}';` };
      return { contents: `import { current } from 'product-test:state';
        export const supabase = { rpc: (...args) => current().rpc(...args) };
        export const formatSupabaseError = error => error.message;` };
    });
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const roots = [];
before(() => { mock.method(globalThis, 'fetch', () => assert.fail('all network access is forbidden')); });
after(async () => { mock.restoreAll(); await Promise.all(roots.map(path => rm(path, { recursive: true, force: true }))); });
async function* fragments(bytes, size = 4093) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}
async function collect(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function soon(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cancellation stalled')), 1500); })]); }
  finally { clearTimeout(timer); }
}
function fixture(text = lines(405)) {
  const catalog = catalogFor(text);
  const calls = { page: [], verify: 0, append: [], abort: 0, open: 0, begin: [], stage: [], dryRun: 0, apply: 0, close: 0,
    save: 0, reread: 0, upload: [], seal: [] };
  const stored = new Map();
  const progress = [];
  const value = { text, catalog, descriptor: descriptorFor(catalog), calls, stored, progress, events: [], invalidated: false };
  const all = text ? text.match(/[^\n]*\n/g) : [];
  value.source = {
    async catalog() { return value.catalog; },
    async page(after) {
      calls.page.push(after);
      let start = after === null ? 0 : all.findIndex(line => JSON.parse(line).id === after) + 1;
      const page = [];
      let bytes = 0;
      while (start < all.length && page.length < 200 && bytes + Buffer.byteLength(all[start]) <= 262144) {
        bytes += Buffer.byteLength(all[start]); page.push(all[start++]);
      }
      const ndjson = page.join('');
      return { table_key: 'product_types', count: page.length, ndjson,
        next_after: start < all.length ? JSON.parse(page.at(-1)).id : null, sha256: hash(ndjson) };
    },
    async verify() { calls.verify++; value.events.push('source-verified'); return verified(); },
  };
  value.temporary = {
    async append(path, bytes) {
      assert.equal(value.invalidated, false); assert.equal(path, PATH);
      calls.append.push(bytes.length);
      if (!stored.has(path)) stored.set(path, []);
      stored.get(path).push(Buffer.from(bytes));
    },
    open(path) {
      assert.equal(value.invalidated, false); assert.equal(path, PATH); calls.open++;
      const body = stored.has(path) ? Buffer.concat(stored.get(path)) : Buffer.from(value.text);
      return { async *[Symbol.asyncIterator]() {
        yield* fragments(body, 13);
        value.events.push(`eof:${calls.open}`);
      } };
    },
    async abort() { calls.abort++; value.invalidated = true; stored.clear(); value.events.push('plaintext-deleted'); },
  };
  value.target = {
    async begin(input) { calls.begin.push(input); value.events.push('begin'); return confirmed(); },
    async stage(chunkNo, ndjson) { calls.stage.push({ chunkNo, ndjson }); return ack(ndjson); },
    async dryRun() { calls.dryRun++; return dry(); },
    async apply() { calls.apply++; assert.fail('never auto apply'); },
    async close() { calls.close++; assert.fail('never auto close'); },
  };
  value.file = {
    async write(source) { calls.save++; value.saved = await collect(source); value.events.push('cipher-saved'); },
    open() {
      assert.equal(value.invalidated, true, 'ciphertext must survive plaintext deletion');
      calls.reread++;
      const read = calls.reread;
      return { async *[Symbol.asyncIterator]() { yield* fragments(value.saved); value.events.push(`cipher-eof:${read}`); } };
    },
  };
  value.receiver = {
    async append(chunkNo, hex) {
      assert.ok(value.events.includes('cipher-eof:1'), 'authenticate full saved file before upload');
      const bytes = Buffer.from(hex, 'hex'); calls.upload.push({ chunkNo, bytes });
      return { success: true, bytes: bytes.length, sha256: hash(bytes), repeated: false };
    },
    async seal(sha256, bytes) { calls.seal.push({ sha256, bytes }); return seal(sha256, bytes); },
  };
  return value;
}
const exportRun = (v, options = {}) => api.exportProducts(v.source, v.temporary, { onProgress: p => v.progress.push(p), ...options });
const stageRun = (v, options = {}) => api.stageProductsImport(v.catalog, v.temporary, v.target, { onProgress: p => v.progress.push(p), ...options });
const backupRun = (v, options = {}) => api.createProductBackup(v.descriptor, v.source, v.temporary, v.file, v.receiver,
  PASSPHRASE, { onProgress: p => v.progress.push(p), ...options });
async function encrypted(v, changeEntries = entries => entries, changeInfo = {}) {
  async function* entries() {
    for (const entry of changeEntries([{ path: PATH, body: Buffer.from(v.text) }])) {
      yield { path: entry.path, bytes: entry.body.length, open: () => fragments(entry.body) };
    }
  }
  return collect(api.writeEncryptedVolume(entries(), { ...info, ...changeInfo }, PASSPHRASE));
}
const volumeRun = (v, bytes, options = {}) => api.importProductsVolume(v.catalog, fragments(bytes), PASSPHRASE,
  { exportId: PACKAGE, volumeId: JOB }, v.temporary, v.target, options);
function noWrites(v) { assert.equal(v.calls.begin.length, 0); assert.equal(v.calls.stage.length, 0); assert.equal(v.calls.dryRun, 0); }

// Compiles the real implementation, container, WebCrypto and SHA-256, not a parallel JS reimplementation.
test('bundle uses real product/container/crypto modules and isolates only auth and RPC; protocol limits are exact', () => {
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const name of ['productTransfer', 'productBackup', 'api', 'container', 'crypto', 'sha256']) {
    assert.ok(inputs.some(path => path.endsWith(`/employeeTransfer/${name}.ts`)));
  }
  assert.equal(inputs.some(path => /src\/lib\/(auth|supabase)\.ts$/.test(path)), false);
  assert.equal(api.PRODUCT_MAX_BYTES, 8388608); assert.equal(api.MAX_PRODUCT_BACKUP_BYTES, 9437184);
  assert.equal(api.PRODUCT_BACKUP_CHUNK_BYTES, 131072);
});
test('ASCII-id streaming pages preserve exact Unicode bytes and only count completed writes', async () => {
  const v = fixture();
  const result = await exportRun(v);
  assert.deepEqual(v.calls.page, [null, id(200), id(400)]);
  assert.deepEqual(Buffer.concat(v.stored.get(PATH)), Buffer.from(v.text));
  assert.deepEqual(v.progress.map(p => p.rows), [200, 400, 405]);
  assert.deepEqual(result.entries, [{ path: PATH, kind: 'ndjson', bytes: Buffer.byteLength(v.text), sha256: hash(v.text) }]);
  assert.equal(result.fullSiteComplete, false); assert.equal(v.calls.verify, 1); assert.equal(v.calls.abort, 0);
});
test('export awaits temporary write before pulling another page and before reporting progress', async () => {
  const v = fixture(); const gate = deferred(); const entered = deferred();
  const append = v.temporary.append;
  v.temporary.append = async (...args) => { if (!v.calls.append.length) { entered.resolve(); await gate.promise; } return append(...args); };
  const pending = exportRun(v); await entered.promise;
  assert.equal(v.calls.page.length, 1); assert.equal(v.progress.length, 0);
  gate.resolve(); await pending;
  assert.deepEqual(v.progress.map(p => p.rows), [200, 400, 405]);
});
for (const [name, mutate] of [
  ['additional excluded_system_keys', v => { v.catalog.excluded_system_keys = []; }],
  ['seven-table impostor', v => { v.catalog.scope = 'shared-settings'; }],
  ['second table', v => { v.catalog.tables.push({ ...v.catalog.tables[0] }); }],
  ['unknown table field', v => { v.catalog.tables[0].extra = true; }],
  ['uppercase site', v => { v.catalog.site_id = 'ABCDEF00-0000-4000-8000-000000000000'; }],
  ['10001 rows', v => { v.catalog.tables[0].rows = 10001; }],
  ['more than 8MiB', v => { v.catalog.tables[0].bytes = 8388609; }],
  ['negative count', v => { v.catalog.tables[0].rows = -1; }],
  ['fractional count', v => { v.catalog.tables[0].rows = 0.5; }],
  ['bad hash', v => { v.catalog.tables[0].sha256 = 'a'.repeat(63); }],
  ['full site success', v => { v.catalog.full_site_complete = true; }],
]) test(`catalog rejects ${name} before reads or writes`, async () => {
  const v = fixture(lines(1)); mutate(v);
  await assert.rejects(exportRun(v)); assert.equal(v.calls.page.length, 0); assert.equal(v.calls.abort, 1);
  await assert.rejects(stageRun(v)); noWrites(v);
});
const badRows = [
  ['unknown field', { ...row(1), unexpected: true }], ['missing field', Object.fromEntries(Object.entries(row(1)).filter(([key]) => key !== 'updated_at'))],
  ['boolean string', { ...row(1), is_active: 'true' }], ['sort null', { ...row(1), sort_order: null }],
  ['sort overflow', { ...row(1), sort_order: 2147483648 }], ['sort underflow', { ...row(1), sort_order: -2147483649 }],
  ['sort fraction', { ...row(1), sort_order: 1.5 }], ['name null', { ...row(1), name: null }],
  ['empty name', { ...row(1), name: '  ' }], ['uppercase id', { ...row(1), id: 'ABCDEF00-0000-4000-8000-000000000000' }],
  ['timezone missing', { ...row(1), created_at: '2024-01-01T00:00:00' }],
  ['invalid date normalization', { ...row(1), created_at: '2024-02-30T00:00:00Z' }],
  ['infinite date', { ...row(1), updated_at: 'infinity' }], ['invalid hour', { ...row(1), updated_at: '2024-01-01T24:00:00Z' }],
  ['NUL escape', { ...row(1), name: 'a\u0000b' }], ['unpaired high surrogate', { ...row(1), name: '\ud800' }],
  ['unpaired low surrogate', { ...row(1), name: '\udc00' }], ['bidi override', { ...row(1), name: 'a\u202eb' }],
  ['bidi isolate', { ...row(1), name: 'a\u2066b' }], ['BOM name', { ...row(1), name: 'a\ufeffb' }],
];
for (const [name, value] of badRows) test(`both paths reject row ${name} before import begin`, async () => {
  const v = fixture(JSON.stringify(value) + '\n');
  await assert.rejects(exportRun(v)); assert.equal(v.calls.abort, 1); assert.equal(v.calls.append.length, 0);
  const imported = fixture(v.text); await assert.rejects(stageRun(imported)); noWrites(imported);
});
for (const [name, text] of [
  ['escaped duplicate JSON key', JSON.stringify(row(1)).replace('"id":', `"\\u0069d":"${id(2)}","id":`) + '\n'],
  ['duplicate ID', JSON.stringify(row(1)) + '\n' + JSON.stringify({ ...row(2), id: id(1) }) + '\n'],
  ['duplicate name', JSON.stringify(row(1)) + '\n' + JSON.stringify({ ...row(2), name: row(1).name }) + '\n'],
  ['descending ASCII ID', JSON.stringify(row(2)) + '\n' + JSON.stringify(row(1)) + '\n'],
  ['array row', '[]\n'], ['invalid JSON', '{\n'], ['missing LF', JSON.stringify(row(1))],
]) test(`reject ${name}`, async () => {
  const v = fixture(text);
  // Send one raw page, rather than having the fixture parse invalid JSON while constructing pages.
  v.source.page = async () => ({ table_key: 'product_types', count: count(text), ndjson: text, next_after: null, sha256: hash(text) });
  await assert.rejects(exportRun(v)); assert.equal(v.calls.abort, 1);
  const imported = fixture(text); await assert.rejects(stageRun(imported)); noWrites(imported);
});
for (const [name, modify] of [
  ['wrong table', p => { p.table_key = 'admins'; }], ['wrong count', p => { p.count++; }],
  ['wrong page hash', p => { p.sha256 = '0'.repeat(64); }], ['arbitrary cursor', p => { p.next_after = OTHER; }],
  ['unknown page field', p => { p.more = true; }], ['truncated terminal page', p => { p.next_after = null; }],
]) test(`export rejects ${name} and cleans plaintext`, async () => {
  const v = fixture(); const page = v.source.page;
  v.source.page = async (...args) => { const result = await page(...args); modify(result); return result; };
  await assert.rejects(exportRun(v)); assert.equal(v.calls.abort, 1); assert.equal(v.stored.size, 0);
});
test('table digest detects valid page-byte tampering, verification scope is checked, and cleanup errors are explicit', async () => {
  for (const verifyFailure of [false, true]) {
    const v = fixture(lines(1));
    if (verifyFailure) v.source.verify = async () => ({ ...verified(), full_site_complete: true });
    else v.catalog.tables[0].sha256 = hash('different catalog body');
    await assert.rejects(exportRun(v)); assert.equal(v.calls.abort, 1);
  }
  const v = fixture(lines(1)); v.source.verify = async () => { throw new Error(PASSPHRASE); };
  v.temporary.abort = async () => { v.calls.abort++; throw new Error(PASSWORD); };
  await assert.rejects(exportRun(v), error => error.cleanupRequired === true && !error.message.includes(PASSWORD));
});
test('two-pass import validates EOF before begin, awaits exact real receipts, never apply/close', async () => {
  const v = fixture();
  const stage = v.target.stage; const pendingAck = deferred(); const entered = deferred();
  v.target.stage = async (...args) => { if (!v.calls.stage.length) { entered.resolve(); await pendingAck.promise; } return { ...await stage(...args), repeated: true }; };
  const pending = stageRun(v); await entered.promise;
  assert.ok(v.events.indexOf('eof:1') < v.events.indexOf('begin'));
  assert.equal(v.progress.filter(p => p.phase === 'stage').length, 0);
  pendingAck.resolve(); const result = await pending;
  assert.equal(v.calls.open, 2); assert.deepEqual(v.calls.stage.map(p => count(p.ndjson)), [200, 200, 5]);
  assert.deepEqual(v.calls.stage.map(p => p.chunkNo), [0, 1, 2]);
  assert.equal(v.calls.stage.map(p => p.ndjson).join(''), v.text);
  assert.deepEqual(v.progress.filter(p => p.phase === 'stage').map(p => p.rows), [200, 400, 405]);
  assert.equal(result.rows, 405); assert.equal(result.bytes, Buffer.byteLength(v.text));
  assert.deepEqual(result.dryRun, dry()); assert.equal(result.fullSiteComplete, false);
  assert.equal(v.calls.apply, 0); assert.equal(v.calls.close, 0);
});
test('empty table remains a real file, exports and stages chunk zero with empty SHA-256', async () => {
  const v = fixture(''); const result = await exportRun(v);
  assert.equal(result.entries.length, 1); assert.deepEqual(v.calls.append, [0]);
  const imported = fixture(''); const staged = await stageRun(imported);
  assert.deepEqual(imported.calls.stage, [{ chunkNo: 0, ndjson: '' }]); assert.equal(staged.rows, 0);
});
test('line, page and total bounds are byte-based; exactly 8MiB is accepted and >64KiB row rejected', async () => {
  const sizedLine = (n, size) => {
    const value = { ...row(n), name: 'x' };
    const overhead = Buffer.byteLength(JSON.stringify(value) + '\n') - 1;
    return JSON.stringify({ ...value, name: `${n}`.padEnd(size - overhead, 'x') }) + '\n';
  };
  const body = Array.from({ length: 128 }, (_, i) => sizedLine(i + 1, 65536)).join('');
  assert.equal(Buffer.byteLength(body), 8388608);
  const v = fixture(body); v.temporary.open = () => fragments(Buffer.from(body), 1024 * 1024);
  const result = await stageRun(v);
  assert.equal(result.bytes, 8388608); assert.equal(v.calls.stage.length, 32);
  assert.ok(v.calls.stage.every(p => Buffer.byteLength(p.ndjson) === 262144));
  const exported = fixture(body); assert.equal((await exportRun(exported)).bytes, 8388608);
  const bad = fixture(sizedLine(1, 65538));
  await assert.rejects(stageRun(bad)); noWrites(bad); await assert.rejects(exportRun(bad));
});
for (const [name, mutate] of [
  ['success', a => { a.success = false; }], ['rows', a => { a.rows--; }], ['bytes', a => { a.bytes--; }],
  ['sha256', a => { a.sha256 = hash('wrong'); }], ['repeated', a => { a.repeated = 'true'; }],
  ['unknown key', a => { a.extra = true; }],
]) test(`stage ${name} receipt mismatch never advances progress or dry-run`, async () => {
  const v = fixture(lines(1)); v.target.stage = async (chunkNo, ndjson) => {
    v.calls.stage.push({ chunkNo, ndjson }); const result = ack(ndjson); mutate(result); return result;
  };
  await assert.rejects(stageRun(v), { stagingMayExist: true });
  assert.equal(v.progress.filter(p => p.phase === 'stage').length, 0); assert.equal(v.calls.dryRun, 0);
  assert.equal(v.calls.stage.length, 1); assert.equal(v.calls.apply, 0);
});
test('second read tampering and invalid UTF-8 stop without dry-run; first-read corruption never begins', async () => {
  const v = fixture(lines(1)); const original = v.temporary.open;
  v.temporary.open = path => v.calls.open ? (v.calls.open++, fragments(Buffer.from(v.text.replace('产品', '产品X')))) : original(path);
  await assert.rejects(stageRun(v), { stagingMayExist: true }); assert.equal(v.calls.dryRun, 0);
  const bad = fixture(lines(1)); bad.temporary.open = () => fragments(Buffer.from([0xff, 10]));
  await assert.rejects(stageRun(bad)); noWrites(bad);
});
test('export cancellation promptly invalidates pending writes and ignores their late completion', async () => {
  const v = fixture(); const controller = new AbortController(); const entered = deferred(); const blocked = deferred();
  v.temporary.append = async () => { entered.resolve(); await blocked.promise; if (!v.invalidated) v.stored.set(PATH, [Buffer.from('late')]); };
  const pending = exportRun(v, { signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(soon(pending), { name: 'AbortError' }); assert.equal(v.calls.abort, 1);
  blocked.resolve(); await nextTurn(); assert.equal(v.stored.size, 0); assert.equal(v.calls.page.length, 1);
});
test('import cancellation before begin writes nothing; during stage reports uncertain staging without retry', async () => {
  const before = fixture(); const aborted = new AbortController(); aborted.abort();
  await assert.rejects(stageRun(before, { signal: aborted.signal }), { name: 'AbortError' }); noWrites(before);
  const v = fixture(); const controller = new AbortController(); const entered = deferred(); const blocked = deferred();
  v.target.stage = async () => { v.calls.stage.push({}); entered.resolve(); return blocked.promise; };
  const pending = stageRun(v, { signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(soon(pending), { stagingMayExist: true, cancelled: true });
  blocked.reject(new Error(PASSWORD)); await nextTurn(); assert.equal(v.calls.stage.length, 1); assert.equal(v.calls.dryRun, 0);
});
test('full encrypted-volume authentication and catalog/manifest checks precede every begin', async () => {
  const v = fixture(lines(2)); const bytes = await encrypted(v); const result = await volumeRun(v, bytes);
  assert.equal(result.rows, 2); assert.equal(v.calls.abort, 1); assert.equal(v.invalidated, true);
  const cases = [
    ['ciphertext tamper', Buffer.from(bytes), undefined],
    ['truncated ciphertext', bytes.subarray(0, -1), undefined],
    ['wrong entry path', await encrypted(v, entries => entries.map(e => ({ ...e, path: 'data/wrong.ndjson' }))), undefined],
    ['wrong site', await encrypted(v, e => e, { sourceSiteId: OTHER }), undefined],
    ['wrong scope', await encrypted(v, e => e, { scope: 'full-site' }), undefined],
    ['wrong package', await encrypted(v, e => e, { exportId: OTHER }), undefined],
    ['wrong catalog hash', bytes, c => { c.tables[0].sha256 = hash('other'); }],
  ];
  cases[0][1][cases[0][1].length - 1] ^= 1;
  for (const [name, body, mutate] of cases) {
    const bad = fixture(lines(2)); mutate?.(bad.catalog);
    await assert.rejects(volumeRun(bad, body), undefined, name); noWrites(bad); assert.equal(bad.calls.abort, 1, name);
  }
});
test('encrypted import cleanup failure is explicit even after staging, never interpreted as rollback', async () => {
  const v = fixture(lines(1)); const bytes = await encrypted(v);
  v.temporary.abort = async () => { v.calls.abort++; throw new Error(PASSWORD); };
  await assert.rejects(volumeRun(v, bytes), { cleanupRequired: true, stagingMayExist: true });
  assert.equal(v.calls.abort, 1); assert.equal(v.calls.apply, 0); assert.equal(v.calls.close, 0);
});

function diskSource(path) {
  return { async *[Symbol.asyncIterator]() {
    const handle = await open(path, 'r'); const buffer = Buffer.alloc(65521);
    try { while (true) { const { bytesRead } = await handle.read(buffer); if (!bytesRead) break; yield buffer.subarray(0, bytesRead); } }
    finally { await handle.close(); }
  } };
}
test('independent encrypted disk file survives plaintext cleanup, authenticates fully, rereads for 128KiB upload and seals', async () => {
  const v = fixture(lines(1800)); const directory = await mkdtemp(join(tmpdir(), 'product-backup-')); roots.push(directory);
  const plainPath = join(directory, 'products.ndjson'), cipherPath = join(directory, 'independent.edx');
  v.temporary = {
    async append(path, chunk) { assert.equal(path, PATH); const file = await open(plainPath, 'a'); try { await file.writeFile(chunk); } finally { await file.close(); } },
    open(path) { assert.equal(path, PATH); return diskSource(plainPath); },
    async abort() { v.calls.abort++; await rm(plainPath, { force: true }); },
  };
  v.file = {
    async write(source) { v.calls.save++; const file = await open(cipherPath, 'wx');
      try { for await (const bytes of source) await file.writeFile(bytes); await file.sync(); } finally { await file.close(); } },
    open() { v.calls.reread++; return diskSource(cipherPath); },
  };
  v.receiver.append = async (chunkNo, hex) => {
    assert.equal(v.calls.reread, 2); const bytes = Buffer.from(hex, 'hex'); v.calls.upload.push({ chunkNo, bytes });
    return { success: true, bytes: bytes.length, sha256: hash(bytes), repeated: true };
  };
  const result = await backupRun(v); const saved = await readFile(cipherPath);
  await assert.rejects(stat(plainPath), { code: 'ENOENT' }); assert.ok((await stat(cipherPath)).size > 0);
  assert.equal(v.calls.save, 1); assert.equal(v.calls.reread, 2); assert.equal(v.calls.abort, 1);
  assert.equal(result.cipherSha256, hash(saved)); assert.equal(result.bytes, saved.length);
  assert.deepEqual(Buffer.concat(v.calls.upload.map(p => p.bytes)), saved);
  assert.deepEqual(v.calls.upload.map(p => p.chunkNo), v.calls.upload.map((_, i) => i));
  assert.ok(v.calls.upload.slice(0, -1).every(p => p.bytes.length === 131072));
  assert.deepEqual(v.calls.seal, [{ sha256: hash(saved), bytes: saved.length }]);
  const manifest = await api.verifyEncryptedVolume(diskSource(cipherPath), PASSPHRASE,
    { async append() {}, async abort() { assert.fail(); } }, { expectedMetadata: { exportId: JOB, volumeId: JOB } });
  assert.equal(manifest.scope, 'replacement-backup'); assert.equal(manifest.exportId, JOB); assert.equal(manifest.volumeId, JOB);
  assert.deepEqual(manifest.entries, [{ path: PATH, bytes: Buffer.byteLength(v.text), sha256: hash(v.text), kind: 'ndjson' }]);
  assert.deepEqual([...new Set(v.progress.map(p => p.phase))], ['snapshot', 'save', 'verify', 'upload', 'seal']);
  assert.equal(v.calls.apply, 0); assert.equal(v.calls.close, 0);
});
for (const [name, change, expectedPhase] of [
  ['saved ciphertext tamper', v => { const write = v.file.write; v.file.write = async (...args) => { await write(...args); v.saved[v.saved.length - 1] ^= 1; }; }, 'verify'],
  ['early save acknowledgement', v => { v.file.write = async () => {}; }, 'save'],
  ['plaintext cleanup failure', v => { v.temporary.abort = async () => { v.calls.abort++; throw new Error(PASSWORD); }; }, 'save'],
  ['upload reread tamper', v => { const open = v.file.open; v.file.open = () => { if (v.calls.reread === 1) v.saved[v.saved.length - 1] ^= 1; return open(); }; }, 'upload'],
  ['chunk receipt mismatch', v => { v.receiver.append = async () => { v.calls.upload.push({}); return { success: true, bytes: 1, sha256: hash('bad'), repeated: false }; }; }, 'upload'],
  ['seal receipt mismatch', v => { v.receiver.seal = async () => { v.calls.seal.push({}); return seal(hash('bad'), 1); }; }, 'seal'],
  ['frozen catalog changed', v => { v.descriptor = structuredClone(v.descriptor); v.descriptor.catalog.tables[0].sha256 = hash('other'); }, 'snapshot'],
]) test(`backup ${name} fails safely without apply, retry or deleting ciphertext`, async () => {
  const v = fixture(lines(2)); change(v);
  await assert.rejects(backupRun(v), error => {
    assert.equal(error.name, 'ProductBackupError'); assert.equal(error.phase, expectedPhase);
    assert.equal(error.cleanupRequired, name === 'plaintext cleanup failure');
    assert.equal(error.sealMayHaveSucceeded, expectedPhase === 'seal');
    assert.doesNotMatch(`${error.stack}${JSON.stringify(error)}`, new RegExp(`${PASSWORD}|${PASSPHRASE}`)); return true;
  });
  assert.equal(v.calls.abort, 1); assert.equal(v.calls.apply, 0); assert.equal(v.calls.close, 0);
  if (expectedPhase === 'verify' || expectedPhase === 'save') assert.equal(v.calls.upload.length, 0);
  if (expectedPhase !== 'seal') assert.equal(v.calls.seal.length, 0);
});
test('backup cancellation during append or seal reports uncertain state and never retries', async () => {
  for (const phase of ['append', 'seal']) {
    const v = fixture(lines(2)); const controller = new AbortController(); const entered = deferred(); const blocked = deferred();
    v.receiver[phase] = async () => { v.calls[phase === 'append' ? 'upload' : 'seal'].push({}); entered.resolve(); return blocked.promise; };
    const pending = backupRun(v, { signal: controller.signal }); await entered.promise; controller.abort();
    await assert.rejects(soon(pending), { name: 'ProductBackupError', cancelled: true, serverChunksMayExist: true,
      sealMayHaveSucceeded: phase === 'seal' });
    blocked.reject(new Error(PASSWORD)); await nextTurn(); assert.equal(v.calls.abort, 1); assert.equal(v.calls.apply, 0);
    assert.equal(v.calls[phase === 'append' ? 'upload' : 'seal'].length, 1);
  }
});

function rpcHarness() {
  const h = { calls: [], queue: [], push(data) { h.queue.push({ data }); }, rpc(name, args) {
    const response = h.queue.shift(); assert.ok(response, `unexpected RPC or automatic retry/apply/close: ${name}`);
    h.calls.push({ name, args: structuredClone(args) });
    const query = { abortSignal(signal) { h.calls.at(-1).signal = signal; return query; },
      then(resolve, reject) { return Promise.resolve(response.promise ?? response).then(resolve, reject); } };
    return query;
  } };
  api.setHarness(h); return h;
}
const auth = () => ({ p_admin_session_token: SESSION, p_job_token: TOKEN });
const begun = () => ({ ...confirmed(), job_id: JOB, job_token: TOKEN });
test('product API uses exact product RPC names/arguments; task/catalog/descriptor copies cannot rebind closures', async () => {
  const h = rpcHarness(), catalog = catalogFor(lines(1));
  h.push({ ...begun(), site_id: SITE, catalog }); const task = await api.beginProductsExport(PASSWORD);
  assert.deepEqual(h.calls.at(-1), { name: 'employee_export_products_begin', args: { p_admin_session_token: SESSION, p_admin_password: PASSWORD } });
  task.jobToken = OTHER; task.jobId = OTHER; task.catalog.tables[0].sha256 = hash('mutated'); catalog.tables[0].rows = 99;
  assert.deepEqual(await task.source.catalog(), catalogFor(lines(1)));
  h.push({}); await task.source.page(null);
  assert.deepEqual(h.calls.at(-1), { name: 'get_employee_export_products_page', args: { ...auth(), p_after: null, p_limit: 200 } });
  h.push(verified()); await task.source.verify(); assert.equal(h.calls.at(-1).name, 'employee_export_products_verify');
  const session = api.createProductsImportSession(PACKAGE, PASSWORD); assert.equal(session.identity(), null);
  h.push(begun()); await session.target.begin(catalogFor(lines(1)));
  assert.deepEqual(h.calls.at(-1), { name: 'employee_import_products_begin', args: { p_admin_session_token: SESSION,
    p_admin_password: PASSWORD, p_package_id: PACKAGE, p_catalog: catalogFor(lines(1)) } });
  const identity = session.identity(); identity.jobId = OTHER; identity.jobToken = OTHER;
  h.push(ack(lines(1))); await session.target.stage(0, lines(1));
  assert.deepEqual(h.calls.at(-1), { name: 'employee_import_products_stage', args: { ...auth(), p_chunk_no: 0, p_ndjson: lines(1) } });
  h.push(dry()); await session.target.dryRun(); assert.equal(h.calls.at(-1).name, 'get_employee_import_products_dry_run');
  const original = descriptorFor(catalogFor(lines(1))); h.push(original); const backup = await session.backup();
  assert.equal(h.calls.at(-1).name, 'get_employee_import_products_backup');
  original.plan_hash = hash('changed response'); backup.descriptor.plan_hash = hash('changed public'); backup.descriptor.target_hash = hash('changed public target');
  backup.descriptor.catalog.tables[0].rows = 10;
  assert.deepEqual(await backup.source.catalog(), catalogFor(lines(1)));
  const publicCatalog = await backup.source.catalog(); publicCatalog.tables[0].rows = 900;
  assert.deepEqual(await backup.source.catalog(), catalogFor(lines(1)));
  h.push({}); await backup.source.page(id(1));
  assert.deepEqual(h.calls.at(-1), { name: 'get_employee_import_products_backup_page', args: { ...auth(), p_after: id(1), p_limit: 200 } });
  h.push(descriptorFor(catalogFor(lines(1)))); assert.deepEqual(await backup.source.verify(), verified());
  const chunk = Buffer.from([0, 1, 255]);
  h.push({ success: true, bytes: 3, sha256: hash(chunk), repeated: false }); await backup.receiver.append(2, '0001ff');
  assert.deepEqual(h.calls.at(-1), { name: 'employee_import_products_backup_append', args: { ...auth(), p_plan_hash: PLAN, p_chunk_no: 2, p_hex: '0001ff' } });
  h.push(seal(hash(chunk), 3)); await backup.receiver.seal(hash(chunk), 3);
  assert.deepEqual(h.calls.at(-1), { name: 'employee_import_products_backup_seal', args: { ...auth(), p_plan_hash: PLAN, p_sha256: hash(chunk), p_bytes: 3 } });
  assert.equal(h.calls.some(c => /_apply$|_close$/.test(c.name)), false);
  h.push({ ...confirmed(), repeated: false, product_map: { [id(1)]: OTHER } }); await session.apply(PLAN);
  assert.deepEqual(h.calls.at(-1), { name: 'employee_import_products_apply', args: { ...auth(), p_plan_hash: PLAN } });
  h.push(confirmed()); await session.close(); assert.deepEqual(h.calls.at(-1), { name: 'employee_products_close', args: auth() });
  h.push(confirmed()); await task.close(); assert.deepEqual(h.calls.at(-1), { name: 'employee_products_close', args: auth() });
  assert.equal(h.queue.length, 0);
});
test('product API begins once even on transport failure; pre-cancelled requests issue no RPC', async () => {
  const h = rpcHarness(); const session = api.createProductsImportSession(PACKAGE, PASSWORD);
  h.queue.push({ error: { message: PASSWORD } });
  await assert.rejects(session.target.begin(catalogFor('')));
  await assert.rejects(session.target.begin(catalogFor('')), /cannot be retried/); assert.equal(h.calls.length, 1);
  assert.equal(session.identity(), null);
  const cancelled = api.createProductsImportSession(PACKAGE, PASSWORD); const controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.target.begin(catalogFor(''), controller.signal), { name: 'AbortError' }); assert.equal(h.calls.length, 1);
  for (const action of [() => cancelled.target.stage(0, ''), () => cancelled.target.dryRun(), () => cancelled.backup(),
    () => cancelled.apply(PLAN), () => cancelled.close()]) await assert.rejects(action(), /not been confirmed/);
});
test('API rejects descriptor drift and late cancelled begin cannot bind a new job', async () => {
  const h = rpcHarness(); const session = api.createProductsImportSession(PACKAGE, PASSWORD);
  h.push(begun()); await session.target.begin(catalogFor(''));
  h.push(descriptorFor(catalogFor(''))); const backup = await session.backup();
  for (const field of ['backup_id', 'plan_hash', 'target_hash']) {
    const changed = descriptorFor(catalogFor('')); changed[field] = field === 'backup_id' ? OTHER : hash(field);
    h.push(changed); await assert.rejects(backup.source.verify());
  }
  const other = api.createProductsImportSession(PACKAGE, PASSWORD), controller = new AbortController(), blocked = deferred();
  h.queue.push({ promise: blocked.promise }); const pending = other.target.begin(catalogFor(''), controller.signal);
  await nextTurn(); controller.abort(); await assert.rejects(soon(pending), { name: 'AbortError' });
  blocked.resolve({ data: begun() }); await nextTurn(); assert.equal(other.identity(), null);
});
test('duplicate names spanning pages cannot evade either transport validation pass', async () => {
  const rows = Array.from({ length: 201 }, (_, i) => row(i + 1)); rows[200].name = rows[0].name;
  const text = rows.map(value => JSON.stringify(value) + '\n').join('');
  const v = fixture(text); await assert.rejects(exportRun(v)); assert.equal(v.calls.append.length, 1); assert.equal(v.calls.abort, 1);
  const imported = fixture(text); await assert.rejects(stageRun(imported)); noWrites(imported);
});
test('stalled encrypted input cancellation cleans plaintext and never begins a server task', async () => {
  const v = fixture(lines(1)), entered = deferred(), stalled = deferred(), controller = new AbortController();
  const source = { [Symbol.asyncIterator]() { return this; },
    next() { entered.resolve(); return stalled.promise; }, async return() { return { done: true }; } };
  const pending = api.importProductsVolume(v.catalog, source, PASSPHRASE, { exportId: PACKAGE, volumeId: JOB },
    v.temporary, v.target, { signal: controller.signal });
  await entered.promise; controller.abort(); await assert.rejects(soon(pending), { name: 'AbortError' });
  stalled.reject(new Error(PASSWORD)); await nextTurn(); noWrites(v); assert.equal(v.calls.abort, 1);
});
test('cancelled backup save never authenticates or uploads an incompletely saved file', async () => {
  const v = fixture(lines(1)), entered = deferred(), stalled = deferred(), controller = new AbortController();
  v.file.write = async () => { v.calls.save++; entered.resolve(); return stalled.promise; };
  const pending = backupRun(v, { signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(soon(pending), { name: 'ProductBackupError', phase: 'save', cancelled: true,
    serverChunksMayExist: false, sealMayHaveSucceeded: false });
  stalled.reject(new Error(PASSWORD)); await nextTurn(); assert.equal(v.calls.abort, 1); assert.equal(v.calls.reread, 0);
  assert.equal(v.calls.upload.length, 0); assert.equal(v.calls.seal.length, 0);
});
