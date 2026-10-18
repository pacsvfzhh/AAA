import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SESSION = '11111111-1111-4111-8111-111111111111';
const PACKAGE = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const PASSWORD = 'never-echo-this-local-password';
const PLAN = 'a'.repeat(64), HASH = '$2b$04$' + 'a'.repeat(53);
const TABLES = ['accounts', 'credentials', 'orders'];
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const flags = () => ({ maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false });
const totals = (accounts = 1, credentials = 1, orders = 1) => ({ accounts, credentials, orders });
const plan = (counts = totals()) => ({ scope: 'employee-identity', can_restore: true, counts,
  conflicts: [], plan_hash: PLAN, ...flags() });
const receipt = (counts = totals(0, 0, 0), next = totals(0, 0, 0), verified = false) => ({ success: true,
  scope: 'employee-identity', counts, next_chunks: next, chunks: totals(), totals: totals(), verified, repeated: false, ...flags() });
const verified = () => ({ verified: true, scope: 'employee-identity', full_site_complete: false });
const closed = () => ({ success: true, scope: 'employee-identity', full_site_complete: false });
const bound = () => ({ ...closed(), repeated: false });
const row = (key, n = 1) => key === 'accounts' ? { id: id(n), username: `员工é é 𠮷${n}`, password_hash: HASH, employee_id: `E${n}`,
  is_verified: null, is_active: true, total_income: 0, first_success_order_date: null, created_by: OTHER,
  remarks: null, created_at: '2024-02-29T12:34:56.123456+08:00', updated_at: null, tags: ['one', null, 'two'], is_pinned: false }
  : key === 'credentials' ? { id: id(n), password_hash: HASH, created_at: '2024-02-29T12:34:56.123456Z', updated_at: '2024-02-29T12:34:56Z' }
    : { id: id(n), user_id: id(1), status: n % 2 ? 'success' : 'failure', commission_amount: null, commission_rate: 0,
      created_at: '2024-02-29T12:34:56.123456Z', processed_at: null };
const line = (key, n) => JSON.stringify(row(key, n)).replace('"total_income":0', '"total_income":12345678901234567890.12345678901234567890')
  .replace('"commission_rate":0', '"commission_rate":0.123456789012345678901234567890') + '\n';
const text = (key, n) => Array.from({ length: n }, (_, index) => line(key, index + 1)).join('');
const nrows = value => value ? value.split('\n').length - 1 : 0;
const ack = value => ({ success: true, rows: nrows(value), bytes: Buffer.byteLength(value), sha256: sha(value), repeated: false });
const rowHash = value => sha((value.match(/[^\n]*\n/g) ?? []).map(item => sha(item)).join(''));
function catalog(texts = Object.fromEntries(TABLES.map(key => [key, text(key, 1)]))) {
  return { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE,
    tables: TABLES.map(key => ({ key, rows: nrows(texts[key]), bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: rowHash(texts[key]) })),
    processing_orders: 3, full_site_complete: false };
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function soon(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('cancellation stalled')), 1500); })]); }
  finally { clearTimeout(timer); }
}
let network;
mock.method(globalThis, 'fetch', (...args) => { if (!network) assert.fail('all production/network access forbidden'); return network(...args); });
const logs = ['log', 'info', 'warn', 'error', 'debug'].map(name => mock.method(console, name, () => {}));
after(() => { for (const log of logs) assert.equal(log.mock.callCount(), 0); mock.restoreAll(); });
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/identityTransfer.ts';
    export * from './src/lib/employeeTransfer/identityApi.ts'; export { setHarness } from 'identity-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'identity-transport-only', setup(builder) {
    builder.onResolve({ filter: /^(?:identity-test:state|\.\.\/(?:auth|supabase))$/ }, args => {
      if (args.path.startsWith('..')) assert.equal(args.importer, `${root}src/lib/employeeTransfer/identityApi.ts`);
      return { path: args.path, namespace: 'identity-test' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'identity-test' }, ({ path }) => {
      if (path === 'identity-test:state') return { contents: 'let h; export const setHarness = v => {h=v;}; export const current = () => h;' };
      if (path === '../auth') return { contents: `import {current} from 'identity-test:state';
        export function getAdminFinancialSessionToken() {const h=current();h.reads++;return h.session;}` };
      return { contents: `import {current} from 'identity-test:state'; export const supabase={rpc:(...args)=>current().rpc(...args)};` };
    });
  } }],
});
const load = output => import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
const api = await load(compiled.outputFiles[0].text);
const supabaseSource = await readFile(`${root}src/lib/supabase.ts`, 'utf8');
const transportBuild = await build({
  stdin: { contents: supabaseSource + '\nexport {getRequestTimeout,isReadOnlyRpcRequest,fetchWithTimeout};', resolveDir: `${root}src/lib`, loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'esm', define: {
    'import.meta.env.VITE_SUPABASE_URL': '"https://local-test.invalid"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"local-test-only"',
  }, plugins: [{ name: 'no-supabase-sdk', setup(builder) {
    builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'stub', namespace: 'sdk-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'sdk-test' }, () => ({ contents: 'export const createClient = () => ({});' }));
  } }],
});
const transport = await load(transportBuild.outputFiles[0].text);
function harness() {
  const h = { calls: [], replies: [], reads: 0, session: SESSION,
    respond(data) { h.replies.push({ data }); },
    rpc(name, args) {
      const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
      assert.ok(h.replies.length, `implicit/unexpected RPC ${name}`);
      const result = h.replies.shift();
      if (result.throw) throw result.throw;
      const query = { abortSignal(signal) { call.signals.push(signal); return query; },
        then(resolve, reject) { return Promise.resolve().then(() => { if (result.reject) throw result.reject; return result.wait ?? { data: result.data, error: result.error ?? null }; }).then(resolve, reject); } };
      return query;
    } };
  api.setHarness(h); return h;
}
async function imported(h, options = {}) {
  const s = api.createIdentityImportSession(TOKEN);
  h.respond(bound()); await s.target.bind(catalog());
  if (options.plan || options.begin) { h.respond(plan()); await s.plan(); }
  if (options.begin) { h.respond(receipt()); await s.begin(PLAN); }
  return s;
}
function fixture(sizes = [2, 2, 405]) {
  const texts = Object.fromEntries(TABLES.map((key, index) => [key, text(key, sizes[index])]));
  const cat = catalog(texts), calls = { pages: [], writes: [], open: [], bind: 0, stage: [], plan: 0, verify: 0, cleanup: 0 }, events = [], progress = [], stored = new Map();
  const f = { texts, cat, calls, events, progress, stored };
  f.source = {
    async catalog() { return f.cat; },
    async page(key, after) {
      calls.pages.push({ key, after });
      const all = texts[key].match(/[^\n]*\n/g) ?? [];
      let start = after === null ? 0 : all.findIndex(item => JSON.parse(item).id === after) + 1;
      const page = []; let bytes = 0;
      while (start < all.length && page.length < 200 && bytes + Buffer.byteLength(all[start]) <= 262144) {
        bytes += Buffer.byteLength(all[start]); page.push(all[start++]);
      }
      const ndjson = page.join('');
      return { table_key: key, count: page.length, ndjson, next_after: start < all.length ? JSON.parse(page.at(-1)).id : null, sha256: sha(ndjson) };
    },
    async verify() { calls.verify++; return verified(); },
  };
  f.sink = {
    async append(path, bytes) { calls.writes.push(path); stored.set(path, Buffer.concat([stored.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)])); },
    async abort() { calls.cleanup++; stored.clear(); },
  };
  f.files = {
    open(path) {
      calls.open.push(path); const key = TABLES.find(key => path === `data/identity-${key}.ndjson`); assert.ok(key);
      const bytes = Buffer.from(f.texts[key]);
      return { async *[Symbol.asyncIterator]() { for (let i = 0; i < bytes.length; i += 13) yield bytes.subarray(i, i + 13); events.push(`eof:${key}`); } };
    },
    async abort() { calls.cleanup++; },
  };
  f.target = {
    async bind(input) { assert.deepEqual(input, cat); calls.bind++; assert.deepEqual(events.slice(0, 3), TABLES.map(key => `eof:${key}`)); return bound(); },
    async stage(key, chunkNo, ndjson) { calls.stage.push({ key, chunkNo, ndjson }); return ack(ndjson); },
    async plan() { calls.plan++; return plan(Object.fromEntries(cat.tables.map(table => [table.key, table.rows]))); },
  };
  return f;
}
const exportRun = (f, options = {}) => api.exportIdentityData(f.source, f.sink, { onProgress: p => f.progress.push(p), ...options });
const stageRun = (f, options = {}) => api.stageIdentityImport(f.cat, f.files, f.target, { onProgress: p => f.progress.push(p), ...options });
const assertRedacted = error => { assert.ok(error instanceof Error); assert.equal(String(error).includes(PASSWORD), false); assert.equal('cause' in error, false); return true; };

test('identity bundles only real lightweight identity/checks/SHA modules; no ZIP, crypto, old API or node_modules', () => {
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const key of ['identityTransfer', 'identityApi', 'dispatchTransfer', 'sha256']) assert.ok(inputs.some(path => path.endsWith(`/${key}.ts`)));
  assert.equal(inputs.some(path => /node_modules|\/(?:api|container|crypto|manifest|dispatchBackup|dispatchImport|replacementBackup)\.ts$/.test(path)), false);
  assert.equal(api.IDENTITY_PROTOCOL, 'employee-identity-v1');
  assert.deepEqual(api.IDENTITY_TABLE_KEYS, TABLES);
  assert.deepEqual(api.IDENTITY_TRANSFER_LIMITS, { maxRows: 500000, maxTableBytes: 268435456, maxTotalBytes: 805306368,
    maxLineBytes: 65536, maxPageRows: 200, maxPageBytes: 262144, maxChunks: 500001, maxInputBytes: 1048576 });
});
for (const name of ['employee_export_identity_begin', 'get_employee_export_identity_page', 'employee_export_identity_verify',
  'employee_export_identity_close', 'employee_import_identity_bind', 'employee_import_identity_stage', 'get_employee_import_identity_plan',
  'employee_import_identity_begin', 'employee_import_identity_chunk', 'employee_import_identity_verify']) {
  test(`120s timeout and retry classification: ${name}`, () => {
    const url = `https://local-test.invalid/rest/v1/rpc/${name}`;
    assert.equal(transport.getRequestTimeout(url), 120000);
    assert.equal(transport.getRequestTimeout(url + '_impostor'), 8000);
    assert.equal(transport.isReadOnlyRpcRequest(url, 'POST'), name === 'get_employee_export_identity_page');
  });
  if (name !== 'get_employee_export_identity_page') test(`real transport never retries/falls back for ${name}`, async () => {
    let calls = 0; network = async () => { calls++; throw new TypeError(PASSWORD); };
    try { await assert.rejects(transport.fetchWithTimeout(`https://local-test.invalid/rest/v1/rpc/${name}`, { method: 'POST' })); assert.equal(calls, 1); }
    finally { network = undefined; }
  });
}
const catalogCases = [
  ['wrong version', c => { c.version = 2; }], ['wrong scope', c => { c.scope = 'dispatch-submission'; }],
  ['full-site success', c => { c.full_site_complete = true; }], ['unknown key', c => { c.extra = true; }],
  ['bad site UUID', c => { c.site_id = 'x'; }], ['uppercase UUID', c => { c.package_id = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'; }],
  ['missing package', c => { delete c.package_id; }], ['table order', c => { c.tables.reverse(); }],
  ['missing table', c => { c.tables.pop(); }], ['table extra', c => { c.tables[0].details = ''; }],
  ['rows over', c => { c.tables[0].rows = 500001; }], ['negative rows', c => { c.tables[0].rows = -1; }],
  ['fractional rows', c => { c.tables[0].rows = 1.5; }], ['table bytes over', c => { c.tables[0].bytes = 268435457; }],
  ['empty mismatch', c => { c.tables[0].bytes = 0; }], ['bad row hash', c => { c.tables[0].row_hashes_sha256 = 'A'.repeat(64); }],
  ['infinite processing', c => { c.processing_orders = Infinity; }], ['processing SQL bound', c => { c.processing_orders = 1000000000000000; }],
  ['table sparse', c => { delete c.tables[1]; }], ['array extra', c => { c.tables.extra = 1; }],
  ['array iterator', c => { c.tables[Symbol.iterator] = () => { throw Error(PASSWORD); }; }],
];
for (const [label, change] of catalogCases) test(`catalog rejects ${label}`, () => { const c = catalog(); change(c); assert.throws(() => api.validateIdentityCatalog(c)); });
test('catalog accepts exact maxima and returns entirely detached snapshots', () => {
  const c = catalog(); c.processing_orders = 999999999999999;
  for (const t of c.tables) { t.rows = 500000; t.bytes = 268435456; }
  const copy = api.validateIdentityCatalog(c); assert.deepEqual(copy, c);
  copy.tables[0].bytes = 1; assert.equal(c.tables[0].bytes, 268435456);
});
for (const [label, make, validate] of [
  ['catalog', catalog, api.validateIdentityCatalog], ['plan', plan, api.validateIdentityPlan], ['receipt', receipt, api.validateIdentityReceipt],
]) {
  for (const descriptor of ['getter', 'hidden', 'symbol', 'inherited']) test(`${label} rejects ${descriptor} without invoking getters`, () => {
    const value = make(); const key = Object.keys(value)[0]; let reads = 0;
    if (descriptor === 'getter') Object.defineProperty(value, key, { enumerable: true, get() { reads++; throw Error(PASSWORD); } });
    if (descriptor === 'hidden') Object.defineProperty(value, key, { enumerable: false });
    if (descriptor === 'symbol') value[Symbol('extra')] = 1;
    if (descriptor === 'inherited') Object.setPrototypeOf(value, { extra: true });
    assert.throws(() => validate(value)); assert.equal(reads, 0);
  });
  test(`${label} accepts null-prototype data and ignores proxy get traps using descriptor snapshots`, () => {
    const value = make(), snap = Object.assign(Object.create(null), value);
    const proxy = new Proxy(snap, { get() { throw Error(PASSWORD); } });
    assert.deepEqual(validate(proxy), value);
  });
}
for (const reason of ['employee_id_conflict', 'username_requires_archive', 'employee_number_conflict', 'administrator_username_conflict',
  'unmapped_administrator', 'order_id_conflict', 'placeholder_product_active', 'dispatch_employee_missing', 'used_order_missing_or_mismatched']) {
  test(`plan accepts exact conflict enum ${reason}`, () => {
    const p = plan(); p.can_restore = false; p.conflicts = [{ source_id: id(1), reason }]; assert.deepEqual(api.validateIdentityPlan(p), p);
  });
}
for (const [label, change] of [
  ['false conflictfree', p => { p.can_restore = false; }], ['fake success', p => { p.conflicts = [{ source_id: id(1), reason: 'employee_id_conflict' }]; }],
  ['unknown reason', p => { p.can_restore = false; p.conflicts = [{ source_id: id(1), reason: 'unknown' }]; }],
  ['bad source', p => { p.can_restore = false; p.conflicts = [{ source_id: 'bad', reason: 'employee_id_conflict' }]; }],
  ['bad hash', p => { p.plan_hash = 'a'.repeat(63); }], ['count over', p => { p.counts.orders = 500001; }],
  ['array accessor', p => { p.conflicts = [null]; Object.defineProperty(p.conflicts, 0, { enumerable: true, get() { throw Error(PASSWORD); } }); }],
]) test(`plan rejects ${label}`, () => { const p = plan(); change(p); assert.throws(() => api.validateIdentityPlan(p)); });
for (const key of Object.keys(flags())) {
  for (const [label, make, validate] of [['plan', plan, api.validateIdentityPlan], ['receipt', receipt, api.validateIdentityReceipt]]) {
    test(`${label} rejects unsafe ${key}`, () => { const value = make(); value[key] = !value[key]; assert.throws(() => validate(value)); });
  }
}
for (const [label, change] of [
  ['fake success', r => { r.success = false; }], ['wrong scope', r => { r.scope = 'dispatch-valid-data'; }],
  ['unknown field', r => { r.enabled = true; }], ['nonboolean verified', r => { r.verified = 1; }], ['nonboolean repeated', r => { r.repeated = null; }],
  ['counts exceed total', r => { r.counts.accounts = 2; }], ['count with next zero', r => { r.counts.orders = 1; }],
  ['next exceeds chunks', r => { r.next_chunks.credentials = 2; }], ['zero chunks', r => { r.chunks.accounts = 0; }],
  ['chunk over', r => { r.chunks.accounts = 500002; }], ['row over', r => { r.totals.accounts = 500001; }],
  ['verified incomplete', r => { r.verified = true; }], ['verified next incomplete', r => { r.verified = true; r.counts = totals(); }],
  ['count record extra', r => { r.counts.fake = 0; }], ['negative next', r => { r.next_chunks.orders = -1; }],
]) test(`receipt rejects ${label}`, () => { const r = receipt(); change(r); assert.throws(() => api.validateIdentityReceipt(r)); });
test('receipt accepts boundary counts/chunks and verified equality for every table', () => {
  const r = receipt(totals(500000, 500000, 500000), totals(500001, 500001, 500001), true);
  r.totals = { ...r.counts }; r.chunks = { ...r.next_chunks }; assert.deepEqual(api.validateIdentityReceipt(r), r);
});
for (const key of TABLES) {
  test(`row ${key} accepts exact SQLspec, NULLs, microseconds and original high precision`, () => { assert.equal(api.validateIdentityRow(line(key, 1), key), id(1)); });
  for (const [label, change] of [
    ['unknown detail', r => { r.product_value = 3; }], ['missing field', r => { delete r.password_hash; delete r.status; }],
    ['bad UUID', r => { r.id = 'not-uuid'; }], ['null id', r => { r.id = null; }],
    ['bad timestamp', r => { r.created_at = '2024-02-30T00:00:00Z'; }], ['leap second', r => { r.created_at = '2024-02-29T00:00:60Z'; }],
    ['time without timezone', r => { r.created_at = '2024-02-29T00:00:00'; }], ['unpaired surrogate', r => { r.id = '\ud800'; }],
    ['duplicate key', null], ['escaped duplicate key', null],
  ]) test(`row ${key} rejects ${label}`, () => {
    const r = row(key); if (change) change(r);
    let value = JSON.stringify(r);
    if (label === 'duplicate key') value = value.replace('{', `{"id":"${id(2)}",`);
    if (label === 'escaped duplicate key') value = value.replace('{', `{"\\u0069d":"${id(2)}",`);
    assert.throws(() => api.validateIdentityRow(value, key));
  });
}
for (const [key, field, value] of [
  ['accounts', 'tags', [1]], ['accounts', 'tags', {}], ['accounts', 'is_active', 'true'], ['accounts', 'total_income', '1.2'],
  ['accounts', 'username', null], ['accounts', 'remarks', '\u0000'], ['credentials', 'created_at', null],
  ['credentials', 'password_hash', '$2b$03$' + 'a'.repeat(53)], ['orders', 'status', 'processing'], ['orders', 'user_id', null],
  ['orders', 'commission_amount', {}], ['orders', 'product_type_id', OTHER], ['orders', 'order_number', PASSWORD],
]) test(`SQLspec rejects ${key}.${field}=${JSON.stringify(value)}`, () => { const r = row(key); r[field] = value; assert.throws(() => api.validateIdentityRow(JSON.stringify(r), key)); });
test('large finite PostgreSQL numeric is not rejected or reserialized through JS Infinity', async () => {
  const f = fixture([1, 1, 1]); f.texts.accounts = f.texts.accounts.replace(/12345678901234567890\.12345678901234567890/, '1e400'); f.cat = catalog(f.texts);
  // Use target solely to verify raw bytes; its initial immutable fixture assertion is not applicable to edited input.
  f.target.bind = async () => bound(); await stageRun(f);
  assert.match(f.calls.stage.find(p => p.key === 'accounts').ndjson, /1e400/);
});
test('streamed export preserves all three tables, page/line hashes, Unicode, precision and real write progress', async () => {
  const f = fixture(), result = await exportRun(f);
  assert.equal(result.rows, 409); assert.equal(f.calls.verify, 1); assert.equal(f.calls.cleanup, 0);
  assert.deepEqual(f.calls.pages.filter(p => p.key === 'orders').map(p => p.after), [null, id(200), id(400)]);
  for (const key of TABLES) {
    const path = `data/identity-${key}.ndjson`;
    assert.deepEqual(f.stored.get(path), Buffer.from(f.texts[key]));
    assert.deepEqual(result.entries.find(e => e.path === path), { path, kind: 'ndjson', bytes: Buffer.byteLength(f.texts[key]), sha256: sha(f.texts[key]) });
  }
  assert.ok(f.progress.every(p => p.fullSiteComplete === false)); assert.equal(result.fullSiteComplete, false);
});
test('export backpressure: no next page/progress before a successful temporary write', async () => {
  const f = fixture(), gate = deferred(), entered = deferred(), write = f.sink.append;
  f.sink.append = async (...args) => { entered.resolve(); await gate.promise; await write(...args); };
  const pending = exportRun(f); await entered.promise; assert.equal(f.calls.pages.length, 1); assert.equal(f.progress.length, 0);
  gate.resolve(); await pending;
});
for (const [label, change] of [
  ['wrong hash', p => { p.sha256 = 'b'.repeat(64); }], ['wrong rows', p => { p.count++; }],
  ['wrong table', p => { p.table_key = 'orders'; }], ['forged cursor', p => { p.next_after = id(99); }],
  ['uppercase cursor', p => { p.next_after = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'; }],
  ['missing LF', p => { p.ndjson = p.ndjson.trimEnd(); p.sha256 = sha(p.ndjson); }],
  ['page too large', p => { p.ndjson = 'a'.repeat(262145); }], ['row count too large', p => { p.count = 201; }],
  ['reordered ids', p => { p.ndjson = p.ndjson.match(/[^\n]*\n/g).reverse().join(''); p.sha256 = sha(p.ndjson); }],
  ['unknown key', p => { p.extra = true; }],
]) test(`export rejects page ${label}, clears plaintext and never verifies`, async () => {
  const f = fixture(), page = f.source.page;
  f.source.page = async (...args) => { const p = await page(...args); change(p); return p; };
  await assert.rejects(exportRun(f), assertRedacted); assert.equal(f.calls.cleanup, 1); assert.equal(f.calls.verify, 0); assert.equal(f.progress.length, 0);
});
for (const label of ['hash', 'rows', 'bytes', 'verification', 'write', 'callback']) test(`export rejects ${label} failure and cleans once`, async () => {
  const f = fixture();
  if (label === 'hash') f.cat.tables[0].row_hashes_sha256 = '0'.repeat(64);
  if (label === 'rows') f.cat.tables[0].rows++;
  if (label === 'bytes') f.cat.tables[0].bytes++;
  if (label === 'verification') f.source.verify = async () => ({ ...verified(), verified: false });
  if (label === 'write') f.sink.append = async () => { throw Error(PASSWORD); };
  await assert.rejects(exportRun(f, label === 'callback' ? { onProgress() { throw Error(PASSWORD); } } : {}), assertRedacted);
  assert.equal(f.calls.cleanup, 1);
});
test('export surfaces cleanup failure without leaking source credentials', async () => {
  const f = fixture(); f.source.catalog = async () => { throw Error(PASSWORD); }; f.sink.abort = async () => { throw Error(PASSWORD); };
  await assert.rejects(exportRun(f), e => { assert.equal(e.cleanupRequired, true); return assertRedacted(e); });
});
test('two-pass import verifies ALL files before bind, preserves raw pages, reports only acknowledged rows and never restores', async () => {
  const f = fixture(), result = await stageRun(f);
  assert.equal(f.calls.bind, 1); assert.equal(f.calls.plan, 1); assert.equal(f.calls.cleanup, 1);
  assert.deepEqual(f.calls.open, [...TABLES, ...TABLES].map(key => `data/identity-${key}.ndjson`));
  for (const key of TABLES) assert.equal(f.calls.stage.filter(p => p.key === key).map(p => p.ndjson).join(''), f.texts[key]);
  assert.deepEqual(f.calls.stage.filter(p => p.key === 'orders').map(p => p.chunkNo), [0, 1, 2]);
  assert.equal(result.rows, 409); assert.equal(result.plan.can_restore, true); assert.equal(result.fullSiteComplete, false);
  assert.deepEqual(f.progress.filter(p => p.phase === 'stage').map(p => p.rows), [2, 4, 204, 404, 409]);
});
test('empty tables still stage exactly chunk zero and clean plaintext', async () => {
  const f = fixture([0, 0, 0]), r = await stageRun(f);
  assert.equal(r.rows, 0); assert.deepEqual(f.calls.stage, TABLES.map(key => ({ key, chunkNo: 0, ndjson: '' })));
  assert.equal(f.calls.cleanup, 1);
});
test('import supports ReadableStream and closes errored streams', async () => {
  const f = fixture([1, 1, 1]); let closedReads = 0;
  f.files.open = path => {
    const key = TABLES.find(key => path.endsWith(`${key}.ndjson`)); let sent = false;
    return new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(Buffer.from(f.texts[key])); } else controller.close(); }, cancel() { closedReads++; } });
  };
  f.target.bind = async () => bound(); await stageRun(f); assert.equal(closedReads, 0);
});
for (const label of ['last-file hash', 'invalid UTF8', 'missing LF', 'wrong input type', 'oversized fragment', 'throwing stream', 'unsorted UUID', 'duplicate JSON key', 'extra order detail']) {
  test(`import ${label} fails BEFORE bind and cleans once`, async () => {
    const f = fixture();
    if (label === 'last-file hash') f.cat.tables[2].row_hashes_sha256 = '0'.repeat(64);
    if (label === 'missing LF') f.texts.orders = f.texts.orders.trimEnd();
    if (label === 'unsorted UUID') f.texts.orders = f.texts.orders.match(/[^\n]*\n/g).reverse().join('');
    if (label === 'duplicate JSON key') f.texts.orders = f.texts.orders.replace('{', `{"id":"${id(1)}",`);
    if (label === 'extra order detail') f.texts.orders = f.texts.orders.replace('{', '{"product_value":123,');
    if (['invalid UTF8', 'wrong input type', 'oversized fragment', 'throwing stream'].includes(label)) {
      f.files.open = () => ({ async *[Symbol.asyncIterator]() {
        if (label === 'throwing stream') throw Error(PASSWORD);
        yield label === 'invalid UTF8' ? Uint8Array.from([0xc3, 0x28]) : label === 'wrong input type' ? 'bad' : new Uint8Array(1048577);
      } });
    }
    await assert.rejects(stageRun(f), assertRedacted); assert.equal(f.calls.bind, 0); assert.equal(f.calls.stage.length, 0); assert.equal(f.calls.cleanup, 1);
  });
}
for (const label of ['success', 'rows', 'bytes', 'sha256', 'repeated', 'extra']) test(`stage rejects fake acknowledgement ${label} without counting it or proceeding`, async () => {
  const f = fixture(); f.target.stage = async (key, no, ndjson) => { const a = ack(ndjson); if (label === 'extra') a.extra = 1;
    else a[label] = label === 'success' ? false : label === 'repeated' ? null : label === 'sha256' ? 'b'.repeat(64) : a[label] + 1; return a; };
  await assert.rejects(stageRun(f), e => e.stagingMayExist === true && assertRedacted(e));
  assert.equal(f.progress.filter(p => p.phase === 'stage').length, 0); assert.equal(f.calls.plan, 0); assert.equal(f.calls.cleanup, 1);
});
test('second-pass drift is detected; earlier acknowledged staging is honestly reported as possibly existing', async () => {
  const f = fixture(), bind = f.target.bind;
  f.target.bind = async c => { const ack = await bind(c); f.texts.orders = f.texts.orders.replace('"success"', '"failure"'); return ack; };
  await assert.rejects(stageRun(f), e => e.stagingMayExist === true); assert.equal(f.calls.plan, 0); assert.equal(f.calls.cleanup, 1);
});
test('plan count mismatch cannot return success', async () => {
  const f = fixture(); f.target.plan = async () => plan();
  await assert.rejects(stageRun(f), e => e.stagingMayExist === true); assert.equal(f.calls.cleanup, 1);
});
test('conflicted plan may be returned without automatic begin, apply, enable or finish', async () => {
  const f = fixture([1, 1, 1]); f.target.plan = async () => ({ ...plan(), can_restore: false, conflicts: [{ source_id: id(1), reason: 'username_requires_archive' }] });
  const r = await stageRun(f); assert.equal(r.plan.can_restore, false); assert.equal(r.plan.maintenance, true);
});
test('import waits for stage acknowledgement before counting or sending the next page', async () => {
  const f = fixture(), entered = deferred(), gate = deferred(), stage = f.target.stage;
  f.target.stage = async (...args) => { entered.resolve(); await gate.promise; return stage(...args); };
  const pending = stageRun(f); await entered.promise; assert.equal(f.progress.filter(p => p.phase === 'stage').length, 0);
  gate.resolve(); await pending;
});
for (const phase of ['catalog', 'page', 'write', 'verify', 'read', 'bind', 'stage', 'plan']) test(`abort interrupts blocked ${phase} promptly, cleans temporary files and never advances late`, async () => {
  const f = fixture([1, 1, 1]), gate = deferred(), entered = deferred(), controller = new AbortController();
  const blocked = () => { entered.resolve(); return gate.promise; };
  if (phase === 'catalog') f.source.catalog = blocked;
  if (phase === 'page') f.source.page = blocked;
  if (phase === 'write') f.sink.append = blocked;
  if (phase === 'verify') f.source.verify = blocked;
  let returned = 0;
  if (phase === 'read') f.files.open = () => ({ [Symbol.asyncIterator]() { return { next: blocked, return() { returned++; return new Promise(() => {}); } }; } });
  if (['bind', 'stage', 'plan'].includes(phase)) f.target[phase] = blocked;
  const isImport = ['read', 'bind', 'stage', 'plan'].includes(phase);
  const pending = isImport ? stageRun(f, { signal: controller.signal }) : exportRun(f, { signal: controller.signal });
  await entered.promise; controller.abort();
  await assert.rejects(soon(pending), e => isImport && phase !== 'read' ? e.stagingMayExist === true && e.cancelled === true : e.name === 'AbortError');
  const before = structuredClone(f.calls), progress = f.progress.length;
  gate.reject(Error(PASSWORD)); await nextTurn(); assert.deepEqual(f.calls, before); assert.equal(f.progress.length, progress);
  assert.equal(f.calls.cleanup, 1); if (phase === 'read') assert.equal(returned, 1);
});
test('pre-abort does no source reads, writes, bind or RPC but still discards workspace', async () => {
  for (const run of [exportRun, stageRun]) { const f = fixture(), c = new AbortController(); c.abort(); await assert.rejects(run(f, { signal: c.signal }), { name: 'AbortError' });
    assert.equal(f.calls.pages.length, 0); assert.equal(f.calls.open.length, 0); assert.equal(f.calls.cleanup, 1); }
});
test('successful staging with failed cleanup is NOT reported as successful', async () => {
  const f = fixture(); f.files.abort = async () => { throw Error(PASSWORD); };
  await assert.rejects(stageRun(f), e => e.cleanupRequired === true && e.stagingMayExist === true && assertRedacted(e));
});

test('export factory is lazy, password begin explicit once, snapshot/catalog/session copies detached; close explicit after verify', async () => {
  const h = harness(), s = api.createIdentityExportSession(PACKAGE, PASSWORD);
  assert.equal(s.identity(), null); assert.equal(h.calls.length, 0); assert.equal(h.reads, 1);
  await assert.rejects(s.source.catalog(), /not been confirmed/); await assert.rejects(s.close(), /not been confirmed/);
  const raw = { ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() };
  h.respond(raw); const c = await s.begin(); assert.deepEqual(h.calls[0], { name: 'employee_export_identity_begin', signals: [],
    args: { p_admin_session_token: SESSION, p_admin_password: PASSWORD, p_package_id: PACKAGE } });
  c.tables[0].rows = 400; raw.catalog.tables[0].rows = 300; s.identity().jobToken = OTHER; h.session = OTHER;
  assert.equal((await s.source.catalog()).tables[0].rows, 1);
  await assert.rejects(s.close(), /explicitly verified/);
  const p = { table_key: 'accounts', count: 1, ndjson: line('accounts', 1), next_after: null, sha256: sha(line('accounts', 1)) };
  h.respond(p); await s.source.page('accounts', null); assert.equal(h.calls.at(-1).args.p_job_token, TOKEN); assert.equal(h.calls.at(-1).args.p_admin_session_token, SESSION);
  h.respond(verified()); await s.source.verify(); assert.equal(h.calls.length, 3);
  h.respond(closed()); await s.close(); assert.equal(h.calls.at(-1).name, 'employee_export_identity_close');
  await assert.rejects(s.begin(), /cannot be retried/); assert.equal(h.calls.length, 4);
});
test('import factory binds existing token, exposes explicit plan/begin/chunk/verify only and guards ordering', async () => {
  const h = harness(), s = api.createIdentityImportSession(TOKEN);
  assert.deepEqual(Object.keys(s).sort(), ['target', 'plan', 'begin', 'chunk', 'verify'].sort());
  assert.deepEqual(Object.keys(s.target).sort(), ['bind', 'stage', 'plan'].sort()); assert.equal(h.calls.length, 0);
  await assert.rejects(s.target.stage('accounts', 0, line('accounts', 1)), /not been confirmed/);
  await assert.rejects(s.plan(), /not been confirmed/); await assert.rejects(s.begin(PLAN), /conflict-free/);
  await assert.rejects(s.chunk('accounts', 0), /not been confirmed/); await assert.rejects(s.verify(), /not been confirmed/);
  h.respond(bound()); await s.target.bind(catalog());
  h.respond(ack(line('accounts', 1))); await s.target.stage('accounts', 0, line('accounts', 1));
  h.respond(plan()); const p = await s.target.plan(); assert.equal(h.calls.at(-1).name, 'get_employee_import_identity_plan');
  p.plan_hash = 'b'.repeat(64); p.counts.accounts = 400; p.can_restore = false; p.conflicts.push({ source_id: id(1), reason: 'employee_id_conflict' });
  await assert.rejects(s.begin('b'.repeat(64)), /conflict-free/);
  h.respond(receipt()); await s.begin(PLAN);
  h.respond(receipt(totals(1, 0, 0), totals(1, 0, 0))); await s.chunk('accounts', 0);
  h.respond(receipt(totals(), totals(), true)); await s.verify();
  assert.deepEqual(h.calls.map(c => c.name), ['employee_import_identity_bind', 'employee_import_identity_stage', 'get_employee_import_identity_plan',
    'employee_import_identity_begin', 'employee_import_identity_chunk', 'employee_import_identity_verify']);
  assert.ok(h.calls.every(c => c.args.p_job_token === TOKEN && c.args.p_admin_session_token === SESSION && !('p_admin_password' in c.args)));
});
test('mutating conflicted plan into success cannot authorize begin', async () => {
  const h = harness(), s = await imported(h);
  const p = { ...plan(), can_restore: false, conflicts: [{ source_id: id(1), reason: 'employee_id_conflict' }] };
  h.respond(p); const copy = await s.plan(); copy.conflicts.length = 0; copy.can_restore = true; p.can_restore = true; p.conflicts.length = 0;
  const before = h.calls.length; await assert.rejects(s.begin(PLAN), /conflict-free/); assert.equal(h.calls.length, before);
});
test('failed newer plan invalidates previous stored approval', async () => {
  const h = harness(), s = await imported(h, { plan: true }); h.respond({ ...plan(), plan_hash: 'bad' });
  await assert.rejects(s.plan(), assertRedacted); const before = h.calls.length;
  await assert.rejects(s.begin(PLAN), /conflict-free/); assert.equal(h.calls.length, before);
});
test('new staging invalidates stored plan and cannot stage after explicit restore begin', async () => {
  const h = harness(), s = await imported(h, { plan: true }); h.respond(ack(line('accounts', 1))); await s.target.stage('accounts', 0, line('accounts', 1));
  await assert.rejects(s.begin(PLAN), /conflict-free/); h.respond(plan()); await s.plan(); h.respond(receipt()); await s.begin(PLAN);
  await assert.rejects(s.target.stage('accounts', 0, line('accounts', 1)), /restore has begun/);
});
test('chunk must acknowledge requested key next >= chunkNo+1; verify must actually be verified', async () => {
  const h = harness(), s = await imported(h, { begin: true }); h.respond(receipt());
  await assert.rejects(s.chunk('accounts', 0), assertRedacted); h.respond(receipt(totals(1, 0, 0), totals(1, 0, 0)));
  await assert.rejects(s.chunk('orders', 0), assertRedacted); h.respond(receipt()); await assert.rejects(s.verify(), assertRedacted);
  const r = receipt(totals(), totals(), true); r.totals.orders = 2; h.respond(r); await assert.rejects(s.verify(), assertRedacted);
});
const operations = {
  bind: async h => { const s = api.createIdentityImportSession(TOKEN); return [signal => s.target.bind(catalog(), signal), bound()]; },
  stage: async h => { const s = await imported(h); return [signal => s.target.stage('accounts', 0, line('accounts', 1), signal), ack(line('accounts', 1))]; },
  plan: async h => { const s = await imported(h); return [signal => s.plan(signal), plan()]; },
  begin: async h => { const s = await imported(h, { plan: true }); return [signal => s.begin(PLAN, signal), receipt()]; },
  chunk: async h => { const s = await imported(h, { begin: true }); return [signal => s.chunk('accounts', 0, signal), receipt(totals(1, 0, 0), totals(1, 0, 0))]; },
  verify: async h => { const s = await imported(h, { begin: true }); return [signal => s.verify(signal), receipt(totals(), totals(), true)]; },
};
for (const [name, setup] of Object.entries(operations)) {
  for (const mode of ['rpcThrow', 'promiseReject', 'backendError', 'getter', 'extraField', 'falseSuccess']) test(`${name}: ${mode} is redacted, single attempt, no implicit followup`, async () => {
    const h = harness(), [run, good] = await setup(h), before = h.calls.length;
    if (mode === 'rpcThrow') h.replies.push({ throw: Error(PASSWORD) });
    if (mode === 'promiseReject') h.replies.push({ reject: Error(PASSWORD) });
    if (mode === 'backendError') h.replies.push({ error: { message: PASSWORD, details: PASSWORD }, data: good });
    if (mode === 'getter') { const key = Object.keys(good)[0]; Object.defineProperty(good, key, { enumerable: true, get() { assert.fail('getter must not run'); } }); h.respond(good); }
    if (mode === 'extraField') h.respond({ ...good, leaked_password: PASSWORD });
    if (mode === 'falseSuccess') h.respond({ ...good, ...(name === 'plan' ? { full_site_complete: true } : { success: false }) });
    await assert.rejects(run(), assertRedacted); assert.equal(h.calls.length, before + 1); assert.equal(h.replies.length, 0);
  });
  test(`${name}: cancellation rejects promptly and never resumes state/progress after late transport`, async () => {
    const h = harness(), [run, good] = await setup(h), gate = deferred(), c = new AbortController();
    h.replies.push({ wait: gate.promise }); const pending = run(c.signal); await nextTurn(); const before = h.calls.length; c.abort();
    await assert.rejects(soon(pending), { name: 'AbortError' }); gate.resolve({ data: good }); await nextTurn();
    assert.equal(h.calls.length, before); assert.deepEqual(h.calls.at(-1).signals, [c.signal]);
  });
}
for (const mode of ['throw', 'reject', 'error', 'badPassword', 'badCatalog', 'wrongSite', 'wrongPackage', 'lateAbort']) test(`export password/creation failure ${mode} never leaks and cannot reuse password`, async () => {
  const h = harness(), s = api.createIdentityExportSession(PACKAGE, PASSWORD), c = new AbortController();
  const value = { ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() };
  if (mode === 'throw') h.replies.push({ throw: Error(PASSWORD) });
  else if (mode === 'reject') h.replies.push({ reject: Error(PASSWORD) });
  else if (mode === 'error') h.replies.push({ error: { message: PASSWORD } });
  else if (mode === 'lateAbort') { const gate = deferred(); h.replies.push({ wait: gate.promise }); const pending = s.begin(c.signal); await nextTurn(); c.abort();
    await assert.rejects(soon(pending), { name: 'AbortError' }); gate.resolve({ data: value }); await nextTurn(); }
  else { if (mode === 'badPassword') value.success = false; if (mode === 'badCatalog') value.catalog.tables[0].rows = -1;
    if (mode === 'wrongSite') value.site_id = OTHER; if (mode === 'wrongPackage') value.catalog.package_id = OTHER; h.respond(value); }
  if (mode !== 'lateAbort') await assert.rejects(s.begin(), assertRedacted);
  assert.equal(s.identity(), null); const before = h.calls.length; await assert.rejects(s.begin(), /cannot be retried/); assert.equal(h.calls.length, before);
});
test('concurrent export begin cannot clear the first request password; concurrent import calls cannot authorize stale plan', async () => {
  const h = harness(), s = api.createIdentityExportSession(PACKAGE, PASSWORD), gate = deferred(); h.replies.push({ wait: gate.promise });
  const pending = s.begin(); await assert.rejects(s.begin(), /cannot be retried/); await nextTurn(); assert.equal(h.calls[0].args.p_admin_password, PASSWORD);
  gate.resolve({ data: { ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() } }); await pending;
  const i = await imported(h), p = deferred(); h.replies.push({ wait: p.promise }); const planned = i.plan(); await nextTurn();
  await assert.rejects(i.begin(PLAN), /already in progress/); p.resolve({ data: plan() }); await planned;
});
for (const [label, edit] of [['over row limit', r => { r.tables[0].rows = 500001; }], ['accessor table', r => {
  Object.defineProperty(r.tables, 0, { enumerable: true, get() { throw Error(PASSWORD); } });
}]]) test(`streaming rejects catalog ${label} without bind or reads`, async () => {
  const f = fixture(); edit(f.cat); await assert.rejects(stageRun(f), assertRedacted); assert.equal(f.calls.open.length, 0); assert.equal(f.calls.bind, 0);
});
test('line byte boundary includes LF (exact 64KiB accepted, one byte more rejected)', async () => {
  const r = row('accounts'); r.remarks = ''; const base = JSON.stringify(r) + '\n';
  r.remarks = 'x'.repeat(65536 - Buffer.byteLength(base)); const exact = JSON.stringify(r) + '\n'; assert.equal(Buffer.byteLength(exact), 65536);
  for (const extra of [0, 1]) {
    const f = fixture([1, 0, 0]); f.texts.accounts = extra ? exact.replace('"remarks":"', '"remarks":"x') : exact; f.cat = catalog(f.texts); f.target.bind = async () => bound();
    if (extra) { await assert.rejects(stageRun(f)); assert.equal(f.calls.bind, 0); }
    else await stageRun(f);
  }
});
test('exact 256KiB pages split on bytes before the 200-row limit and retain all original rows', async () => {
  const f = fixture([5, 0, 0]);
  f.texts.accounts = Array.from({ length: 5 }, (_, index) => {
    const r = row('accounts', index + 1); r.remarks = '';
    r.remarks = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(r) + '\n'));
    return JSON.stringify(r) + '\n';
  }).join('');
  f.cat = catalog(f.texts); f.target.bind = async () => bound();
  const exported = await exportRun(f); assert.equal(exported.rows, 5);
  assert.deepEqual(f.calls.pages.filter(p => p.key === 'accounts').map(p => p.after), [null, id(4)]);
  await stageRun(f);
  assert.deepEqual(f.calls.stage.filter(p => p.key === 'accounts').map(p => Buffer.byteLength(p.ndjson)), [262144, 65536]);
});
test('detaching sink-owned buffers cannot change actual acknowledged export byte progress', async () => {
  const f = fixture([1, 1, 1]); const write = f.sink.append;
  f.sink.append = async (path, bytes) => { await write(path, bytes); structuredClone(bytes.buffer, { transfer: [bytes.buffer] }); };
  const result = await exportRun(f); assert.equal(result.bytes, f.cat.tables.reduce((sum, t) => sum + t.bytes, 0));
});
test('stream reader cancel does not await a stalled producer or cleanup of its pending read', async () => {
  const f = fixture(), c = new AbortController(), entered = deferred(); let cancelled = 0;
  f.files.open = () => new ReadableStream({ pull() { entered.resolve(); return new Promise(() => {}); }, cancel() { cancelled++; return new Promise(() => {}); } });
  const pending = stageRun(f, { signal: c.signal }); await entered.promise; c.abort();
  await assert.rejects(soon(pending), { name: 'AbortError' }); assert.equal(cancelled, 1); assert.equal(f.calls.cleanup, 1);
});
test('real isolated temporary files are exported byte-for-byte, reopened for both passes, then completely deleted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'employee-identity-client-'));
  const f = fixture([2, 2, 405]); let discarded = false;
  const filePath = path => { assert.match(path, /^data\/identity-(accounts|credentials|orders)\.ndjson$/); return join(directory, path.split('/')[1]); };
  const temporary = {
    async append(path, bytes) { assert.equal(discarded, false); const fd = await open(filePath(path), 'a', 0o600);
      try { await fd.writeFile(bytes); } finally { await fd.close(); } },
    open(path) { assert.equal(discarded, false); return { async *[Symbol.asyncIterator]() {
      const fd = await open(filePath(path), 'r'); try { for await (const bytes of fd.createReadStream({ highWaterMark: 97, autoClose: false })) yield bytes; }
      finally { await fd.close(); }
    } }; },
    async abort() { discarded = true; await rm(directory, { recursive: true, force: true }); },
  };
  try {
    const result = await api.exportIdentityData(f.source, temporary);
    for (const entry of result.entries) assert.equal(sha(await readFile(filePath(entry.path))), entry.sha256);
    f.target.bind = async c => { assert.deepEqual(c, f.cat); return bound(); };
    const imported = await api.stageIdentityImport(result.catalog, temporary, f.target);
    assert.equal(imported.rows, 409); assert.equal(discarded, true);
    await assert.rejects(readFile(join(directory, 'identity-accounts.ndjson')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('page-byte bound uses UTF8 bytes rather than UTF16 length', () => {
  const ndjson = 'é'.repeat(131073), p = { table_key: 'accounts', count: 1, ndjson, sha256: sha(ndjson), next_after: null };
  assert.throws(() => api.validateIdentityPage(p, 'accounts', null));
});
test('authenticated manifest must bind same package/site and ordered exact three file directory', () => {
  const c = catalog(), m = { version: 1, scope: 'replacement-backup', exportId: PACKAGE, volumeId: JOB, sourceSiteId: SITE,
    createdAt: '2026-10-18T01:02:03.000Z', volumeIndex: 1, volumeCount: 1,
    entries: c.tables.map(t => ({ path: `data/identity-${t.key}.ndjson`, kind: 'ndjson', bytes: t.bytes, sha256: sha(text(t.key, 1)) })) };
  api.validateIdentityManifest(m, c);
  for (const change of [v => { v.exportId = OTHER; }, v => { v.sourceSiteId = OTHER; }, v => { v.volumeCount = 2; },
    v => { v.entries.reverse(); }, v => { v.entries[0].bytes++; }, v => { v.entries.push(v.entries[0]); }, v => { v.entries[0].path = '../accounts.ndjson'; }]) {
    const bad = structuredClone(m); change(bad); assert.throws(() => api.validateIdentityManifest(bad, c));
  }
});
