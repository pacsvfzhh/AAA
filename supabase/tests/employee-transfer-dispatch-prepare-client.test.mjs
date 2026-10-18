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
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/dispatchTransfer.ts';
    export * from './src/lib/employeeTransfer/dispatchImport.ts';
    export * from './src/lib/employeeTransfer/dispatchBackup.ts';
    export { writePlainVolume, writeEncryptedVolume, verifyEncryptedVolume, MAX_CONTAINER_INPUT_BYTES }
      from './src/lib/employeeTransfer/container.ts';
    export { encryptTransferStream } from './src/lib/employeeTransfer/crypto.ts';`,
  resolveDir: root, sourcefile: 'dispatch-prepare-client-entry.mjs', loader: 'js' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', metafile: true,
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const SITE = '11111111-1111-4111-8111-111111111111';
const PACKAGE = '22222222-2222-4222-8222-222222222222';
const BACKUP = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const PASSPHRASE = 'local-only-dispatch-encryption-passphrase';
const WRONG_PASSPHRASE = 'local-only-wrong-dispatch-passphrase';
const SECRET = 'local-only-sensitive-order-password-token';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PLAN = hash('dispatch preparation only');
const TARGET = hash('target not yet replaced');
const id = n => `20000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const KEYS = ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders',
  'dispatch_group_members', 'valid_order_data', 'used_order_data'];
// Freeze the reviewed columns independently of the implementation, as in dispatch-client.
const fields = {
  dispatch_config: ['id', 'config_key', 'config_value', 'description', 'updated_at'],
  dispatch_groups: ['id', 'group_name', 'description', 'dispatch_interval_min', 'dispatch_interval_max',
    'session_timeout_minutes', 'dispatch_order_mode', 'is_default', 'is_active', 'created_by', 'created_at',
    'updated_at', 'dispatch_success_rate', 'pool_selection_mode', 'archived_at', 'submit_wait_min_seconds',
    'submit_wait_max_seconds', 'commission_rate', 'withdrawal_amount_threshold', 'withdrawal_orders_threshold',
    'withdrawal_condition_mode', 'grab_success_rate'],
  dispatch_order_pools: ['id', 'group_id', 'pool_name', 'is_base', 'is_active', 'dispatch_interval_min',
    'dispatch_interval_max', 'session_timeout_minutes', 'dispatch_order_mode', 'dispatch_success_rate',
    'archived_at', 'created_by', 'created_at', 'updated_at', 'trigger_probability'],
  dispatch_group_orders: ['id', 'group_id', 'order_content', 'is_active', 'created_by', 'created_at',
    'updated_at', 'pool_id', 'archived_at'],
  dispatch_group_members: ['id', 'group_id', 'user_id', 'assigned_by', 'assigned_at'],
  valid_order_data: ['id', 'product_value', 'transaction_id', 'is_active', 'created_by', 'created_at',
    'updated_at', 'usage_count', 'last_used_at', 'deactivated_at', 'deactivation_reason', 'priority', 'tags'],
  used_order_data: ['id', 'user_id', 'valid_order_data_id', 'order_id', 'created_at'],
};
const pathFor = key => `data/dispatch-${key}.ndjson`;
const keyFor = path => { const key = KEYS.find(key => pathFor(key) === path); assert.ok(key, 'unexpected plaintext path'); return key; };
function row(key, n = 1) {
  const value = Object.fromEntries(fields[key].map(field => [field, field === 'id' ? id(n) : null]));
  if (key === 'dispatch_config') value.description = '來源設定 é é 𠮷';
  if (key === 'dispatch_groups') { value.is_default = true; value.commission_rate = 0.12345678; }
  if (key === 'dispatch_order_pools') { value.is_base = true; value.pool_name = '來源默認池'; }
  if (key === 'dispatch_group_orders') value.order_content = '來源原文 é é 𠮷';
  return value;
}
const line = (key, n = 1) => JSON.stringify(row(key, n)) + '\n';
const lines = (key, n) => Array.from({ length: n }, (_, i) => line(key, i + 1)).join('');
const count = text => (text.match(/\n/g) ?? []).length;
// Protocol: hash every original line INCLUDING LF, then hash concatenated lowercase hex digests.
const rowHashes = text => hash((text.match(/[^\n]*\n/g) ?? []).map(value => hash(value)).join(''));
const confirmed = () => ({ success: true, scope: 'dispatch-submission', full_site_complete: false });
const verified = () => ({ verified: true, scope: 'dispatch-submission', full_site_complete: false });
const ack = text => ({ success: true, rows: count(text), bytes: Buffer.byteLength(text), sha256: hash(text), repeated: false });
const seal = (sha256, bytes) => ({ success: true, backup_id: BACKUP, sha256, bytes, repeated: false, full_site_complete: false });
const info = { scope: 'replacement-backup', exportId: PACKAGE, volumeId: BACKUP, sourceSiteId: SITE,
  volumeIndex: 1, volumeCount: 1, createdAt: '2026-10-18T01:02:03.000Z' };
const metadata = { exportId: PACKAGE, volumeId: BACKUP };
function catalogFor(texts) {
  return { version: 1, scope: 'dispatch-submission', site_id: SITE,
    tables: KEYS.map(key => ({ key, rows: count(texts[key]), bytes: Buffer.byteLength(texts[key]),
      row_hashes_sha256: rowHashes(texts[key]) })), processing_orders: 2, full_site_complete: false };
}
const dryFor = catalog => ({ scope: 'dispatch-submission', full_site_complete: false,
  preparation_ready: true, replacement_ready: false, can_apply: false, plan_hash: PLAN,
  source_default_group_id: id(1), counts: Object.fromEntries(catalog.tables.map(t => [t.key, t.rows])),
  dependencies: { administrators: 2, employees: 3, orders: 4 } });
const directories = [];
before(() => { mock.method(globalThis, 'fetch', () => assert.fail('network access is forbidden in dispatch preparation tests')); });
after(async () => { mock.restoreAll(); await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });
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
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('cancellation did not settle promptly')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
function sanitized(error) {
  const visible = `${error.name}\n${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const secret of [SECRET, PASSPHRASE, WRONG_PASSPHRASE]) assert.equal(visible.includes(secret), false);
  assert.equal(error.cause, undefined, 'sensitive underlying errors must not be attached');
  return true;
}
function fixture({ empty = false, texts: changes = {}, fragmentSize = 4093 } = {}) {
  const texts = { ...Object.fromEntries(KEYS.map(key => [key, empty ? '' : line(key)])), ...changes };
  const catalog = catalogFor(texts);
  const calls = { catalog: 0, pages: [], verify: 0, append: [], abort: 0, reads: [], begin: [], stage: [],
    dryRun: 0, apply: 0, close: 0, cancel: 0, save: 0, reread: 0, upload: [], seal: [] };
  const v = { texts, catalog, descriptor: { backup_id: BACKUP, plan_hash: PLAN, target_hash: TARGET,
    catalog: structuredClone(catalog) }, calls, stored: new Map(), progress: [], events: [], invalidated: false };
  v.source = {
    async catalog() { calls.catalog++; return v.catalog; },
    async page(key, after) {
      calls.pages.push({ key, after });
      const all = texts[key].match(/[^\n]*\n/g) ?? [];
      let start = after === null ? 0 : all.findIndex(text => JSON.parse(text).id === after) + 1;
      if (after !== null) assert.ok(start > 0, 'unknown fixture cursor');
      const page = []; let bytes = 0;
      while (start < all.length && page.length < 200 && bytes + Buffer.byteLength(all[start]) <= 262144) {
        bytes += Buffer.byteLength(all[start]); page.push(all[start++]);
      }
      const ndjson = page.join('');
      return { table_key: key, count: page.length, ndjson,
        next_after: start < all.length ? JSON.parse(page.at(-1)).id : null, sha256: hash(ndjson) };
    },
    async verify() { calls.verify++; v.events.push('source-verified'); return verified(); },
  };
  v.temporary = {
    async append(path, bytes) {
      assert.equal(v.invalidated, false); keyFor(path); calls.append.push({ path, bytes: bytes.length });
      if (!v.stored.has(path)) v.stored.set(path, []);
      v.stored.get(path).push(Buffer.from(bytes));
    },
    open(path) {
      assert.equal(v.invalidated, false);
      const key = keyFor(path), pass = calls.reads.filter(read => read.key === key).length + 1;
      const read = { key, pass, pulls: 0, eof: false, closed: false }; calls.reads.push(read);
      const body = v.stored.has(path) ? Buffer.concat(v.stored.get(path)) : Buffer.from(texts[key]);
      return { async *[Symbol.asyncIterator]() {
        try {
          for await (const chunk of fragments(body, fragmentSize)) { read.pulls++; yield chunk; }
          read.eof = true; v.events.push(`eof:${key}:${pass}`);
        } finally { read.closed = true; }
      } };
    },
    async abort() { calls.abort++; v.invalidated = true; v.stored.clear(); v.events.push('plaintext-deleted'); },
  };
  v.target = {
    async begin(input) { calls.begin.push(input); v.events.push('begin'); return confirmed(); },
    async stage(key, chunkNo, ndjson) { calls.stage.push({ key, chunkNo, ndjson }); return ack(ndjson); },
    async dryRun() { calls.dryRun++; return dryFor(catalog); },
    async apply() { calls.apply++; assert.fail('preparation must never apply business data'); },
    async close() { calls.close++; assert.fail('preparation must never auto-close'); },
    async cancel() { calls.cancel++; assert.fail('uncertain writes must not be auto-cancelled'); },
  };
  v.file = {
    async write(source) { calls.save++; v.saved = await collect(source); v.events.push('cipher-saved'); },
    open() {
      assert.equal(v.invalidated, true, 'only the independent ciphertext may survive plaintext deletion');
      const pass = ++calls.reread;
      return { async *[Symbol.asyncIterator]() {
        yield* fragments(v.saved); v.events.push(`cipher-eof:${pass}`);
      } };
    },
  };
  v.receiver = {
    async append(chunkNo, hex) {
      assert.ok(v.events.includes('cipher-eof:1'), 'saved file must authenticate through EOF before upload');
      assert.match(hex, /^(?:[0-9a-f]{2})+$/);
      const bytes = Buffer.from(hex, 'hex'); calls.upload.push({ chunkNo, bytes });
      return { success: true, bytes: bytes.length, sha256: hash(bytes), repeated: false };
    },
    async seal(sha256, bytes) { calls.seal.push({ sha256, bytes }); return seal(sha256, bytes); },
  };
  return v;
}
const stageRun = (v, options = {}) => api.stageDispatchImport(v.catalog, v.temporary, v.target,
  { onProgress: p => v.progress.push(p), ...options });
const backupRun = (v, options = {}) => api.createDispatchBackup(v.descriptor, v.source, v.temporary, v.file,
  v.receiver, PASSPHRASE, { onProgress: p => v.progress.push(p), ...options });
function noAutomaticWrites(v) { assert.equal(v.calls.apply, 0); assert.equal(v.calls.close, 0); assert.equal(v.calls.cancel, 0); }
function noBegin(v) { assert.equal(v.calls.begin.length, 0); assert.equal(v.calls.stage.length, 0); assert.equal(v.calls.dryRun, 0); noAutomaticWrites(v); }
const stageProgress = v => v.progress.filter(p => p.phase === 'stage');
async function* entriesFor(v, change = entries => entries) {
  for (const entry of change(KEYS.map(key => ({ path: pathFor(key), body: Buffer.from(v.texts[key]) })))) {
    yield { path: entry.path, bytes: entry.body.length, open: () => fragments(entry.body) };
  }
}
async function encrypted(v, { entries, identity = {}, password = PASSPHRASE } = {}) {
  return collect(api.writeEncryptedVolume(entriesFor(v, entries), { ...info, ...identity }, password));
}
const volumeRun = (v, bytes, options = {}, password = PASSPHRASE) => api.importDispatchVolume(v.catalog,
  fragments(bytes), password, metadata, v.temporary, v.target, { onProgress: p => v.progress.push(p), ...options });
const manifestFor = v => ({ version: 1, ...info, entries: KEYS.map(key => ({ path: pathFor(key), kind: 'ndjson',
  bytes: Buffer.byteLength(v.texts[key]), sha256: hash(v.texts[key]) })) });

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Mutate the actual writer's stored ZIP, repairing both CRCs. The outer GCM will be genuine,
// so a manifest mismatch cannot accidentally pass this test by failing an earlier checksum.
function corruptPlainManifest(original, mutate) {
  const zip = Buffer.from(original); let offset = 0, manifestOffset, crc;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const size = zip.readUInt32LE(offset + 22), nameBytes = zip.readUInt16LE(offset + 26);
    assert.equal(zip.readUInt16LE(offset + 28), 0);
    const start = offset + 30 + nameBytes;
    if (zip.subarray(offset + 30, start).toString() === 'manifest.json') {
      const manifest = JSON.parse(zip.subarray(start, start + size)); mutate(manifest);
      const changed = Buffer.from(JSON.stringify(manifest)); assert.equal(changed.length, size);
      changed.copy(zip, start); crc = crc32(changed); zip.writeUInt32LE(crc, offset + 14); manifestOffset = offset;
    }
    offset = start + size;
  }
  assert.notEqual(manifestOffset, undefined); let repaired = 0;
  while (zip.readUInt32LE(offset) === 0x02014b50) {
    if (zip.readUInt32LE(offset + 42) === manifestOffset) { zip.writeUInt32LE(crc, offset + 16); repaired++; }
    offset += 46 + zip.readUInt16LE(offset + 28) + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  assert.equal(repaired, 1); return zip;
}

// No API, database, auth or transport substitutes are bundled: exercise the shipped TS implementations.
test('real dispatch preparation, container, crypto and SHA-256 are bundled with independent fixed bounds', () => {
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const name of ['dispatchTransfer', 'dispatchImport', 'dispatchBackup', 'container', 'crypto', 'manifest', 'sha256']) {
    assert.ok(inputs.some(path => path.endsWith(`/employeeTransfer/${name}.ts`)), name);
  }
  assert.equal(inputs.some(path => /src\/lib\/(auth|supabase)\.ts$|\/employeeTransfer\/api\.ts$/.test(path)), false);
  assert.deepEqual(api.DISPATCH_TABLE_KEYS, KEYS);
  assert.deepEqual(api.DISPATCH_TRANSFER_LIMITS, { maxRows: 500000, maxTableBytes: 268435456,
    maxTotalBytes: 1073741824, maxPageRows: 200, maxPageBytes: 262144, maxLineBytes: 65536 });
  assert.equal(api.MAX_DISPATCH_BACKUP_PLAINTEXT_BYTES, 8388608);
  assert.equal(api.MAX_DISPATCH_BACKUP_BYTES, 9437184); assert.equal(api.DISPATCH_BACKUP_CHUNK_BYTES, 131072);
  assert.deepEqual(api.DISPATCH_BACKUP_CONTAINER_LIMITS, { maxEntries: 7, maxEntryBytes: 8388608,
    maxTotalBytes: 8388608, maxZipBytes: 9437184, maxManifestBytes: 16384, maxLineBytes: 65536 });
  assert.deepEqual(api.DISPATCH_IMPORT_CONTAINER_LIMITS, { maxEntries: 7, maxEntryBytes: 268435456,
    maxTotalBytes: 1073741824, maxZipBytes: 1074790400, maxManifestBytes: 16384, maxLineBytes: 65536 });
});
test('all seven first-pass EOFs precede begin; raw second pass stages bounded pages and only prepares', async () => {
  const v = fixture({ texts: { dispatch_config: lines('dispatch_config', 405) }, fragmentSize: 13 });
  const result = await stageRun(v);
  for (const key of KEYS) {
    assert.ok(v.events.indexOf(`eof:${key}:1`) < v.events.indexOf('begin'), key);
    assert.equal(v.calls.reads.filter(read => read.key === key).length, 2);
    assert.ok(v.calls.reads.filter(read => read.key === key).every(read => read.eof && read.closed));
    assert.equal(v.calls.stage.filter(page => page.key === key).map(page => page.ndjson).join(''), v.texts[key]);
  }
  const pages = v.calls.stage.filter(page => page.key === KEYS[0]);
  assert.deepEqual(pages.map(page => count(page.ndjson)), [200, 200, 5]);
  assert.deepEqual(pages.map(page => page.chunkNo), [0, 1, 2]);
  assert.ok(v.calls.stage.filter(page => page.key !== KEYS[0]).every(page => page.chunkNo === 0));
  assert.deepEqual(stageProgress(v).map(p => p.rows), [200, 400, 405, 406, 407, 408, 409, 410, 411]);
  assert.deepEqual(v.progress.filter(p => p.phase === 'validate').map(p => p.rows), [405, 406, 407, 408, 409, 410, 411]);
  assert.equal(result.rows, 411); assert.equal(result.bytes, v.catalog.tables.reduce((sum, t) => sum + t.bytes, 0));
  assert.deepEqual(result.dryRun, dryFor(v.catalog)); assert.equal(result.fullSiteComplete, false);
  assert.deepEqual(v.progress.at(-1), { scope: 'dispatch-submission', phase: 'dry-run', rows: result.rows,
    bytes: result.bytes, fullSiteComplete: false });
  assert.ok(v.progress.every(p => p.fullSiteComplete === false)); assert.equal(v.calls.dryRun, 1); noAutomaticWrites(v);
});
test('seven empty files still open twice and each stages chunk zero with empty SHA-256', async () => {
  const v = fixture({ empty: true }); const result = await stageRun(v);
  assert.equal(v.calls.reads.length, 14);
  assert.deepEqual(v.calls.stage, KEYS.map(key => ({ key, chunkNo: 0, ndjson: '' })));
  assert.equal(result.rows, 0); assert.equal(result.bytes, 0); assert.equal(stageProgress(v).length, 7); noAutomaticWrites(v);
});
test('high-precision decimal, JSON spelling, key order, Unicode and microsecond timestamps are never reserialized', async () => {
  const raw = JSON.stringify(Object.fromEntries(Object.entries(row('valid_order_data')).reverse()))
    .replace('"product_value":null', '"product_value":12345678901234567890.1234567890123456789')
    .replace('"transaction_id":null', '"transaction_id":"來源é é 𠮷 \\u0061"')
    .replace('"updated_at":null', '"updated_at":"2024-02-29T23:59:59.123456+08:00"') + ' \n';
  const v = fixture({ texts: { valid_order_data: raw }, fragmentSize: 1 });
  await stageRun(v);
  assert.equal(v.calls.stage.find(page => page.key === 'valid_order_data').ndjson, raw);
  assert.notEqual(hash(raw), v.catalog.tables.find(table => table.key === 'valid_order_data').row_hashes_sha256);
});
for (const [label, mutate] of [
  ['scope', c => { c.scope = 'product-catalog'; }], ['version', c => { c.version = 2; }],
  ['site UUID', c => { c.site_id = 'invalid'; }], ['full-site success', c => { c.full_site_complete = true; }],
  ['extra property', c => { c.secret = SECRET; }], ['missing table', c => { c.tables.pop(); }],
  ['duplicate table', c => { c.tables[1] = c.tables[0]; }], ['table order', c => { c.tables.reverse(); }],
  ['unreviewed table field', c => { c.tables[0].sha256 = hash(''); }],
  ['negative rows', c => { c.tables[0].rows = -1; }], ['fractional rows', c => { c.tables[0].rows = 0.5; }],
  ['row limit', c => { c.tables[0].rows = 500001; }], ['table byte limit', c => { c.tables[0].bytes = 268435457; }],
  ['total byte limit', c => { c.tables.forEach(t => { t.bytes = 268435456; }); }],
  ['uppercase hash', c => { c.tables[0].row_hashes_sha256 = 'A'.repeat(64); }],
  ['unsafe count', c => { c.processing_orders = Number.MAX_SAFE_INTEGER + 1; }],
  ['zero rows with bytes', c => { c.tables[0].rows = 0; }],
]) test(`catalog ${label} rejects before opening files or beginning`, async () => {
  const v = fixture(); mutate(v.catalog);
  await assert.rejects(stageRun(v), sanitized); assert.equal(v.calls.reads.length, 0); noBegin(v);
});
for (const key of KEYS) test(`missing ${key} file prevents begin even when earlier files validated`, async () => {
  const v = fixture(), original = v.temporary.open;
  v.temporary.open = path => { if (path === pathFor(key)) throw new Error(SECRET); return original(path); };
  await assert.rejects(stageRun(v), sanitized); noBegin(v);
});
for (const key of KEYS) test(`${key} requires exactly the fixed reviewed row columns`, async () => {
  for (const change of [r => { r.unreviewed = SECRET; }, r => { delete r[fields[key].at(-1)]; }]) {
    const value = row(key); change(value);
    const v = fixture({ texts: { [key]: JSON.stringify(value) + '\n' } });
    await assert.rejects(stageRun(v), sanitized); noBegin(v);
  }
});
for (const [label, body] of [
  ['malformed JSON', '{\n'], ['array row', '[]\n'], ['null row', 'null\n'],
  ['duplicate literal key', line(KEYS[0]).replace('"id":', `"id":"${id(2)}","id":`)],
  ['escaped duplicate key', line(KEYS[0]).replace('"id":', `"\\u0069d":"${id(2)}","id":`)],
  ['unpaired Unicode escape', JSON.stringify({ ...row(KEYS[0]), description: '\ud800' }) + '\n'],
  ['duplicate ID', line(KEYS[0]) + line(KEYS[0])],
  ['descending ID', line(KEYS[0], 2) + line(KEYS[0], 1)],
  ['BOM', '\ufeff' + line(KEYS[0])], ['missing LF', line(KEYS[0]).slice(0, -1)],
]) test(`first validation rejects ${label} and never begins`, async () => {
  const v = fixture({ texts: { dispatch_config: body }, fragmentSize: 1 });
  if (label === 'missing LF') v.catalog.tables[0].rows = 1;
  await assert.rejects(stageRun(v), sanitized); noBegin(v);
});
test('invalid UTF-8 and producer input larger than 1MiB fail before begin', async () => {
  for (const bytes of [Buffer.from([0xff, 10]), Buffer.alloc(1048577)]) {
    const v = fixture(); v.catalog.tables[0].bytes = bytes.length;
    v.temporary.open = () => fragments(bytes, bytes.length);
    await assert.rejects(stageRun(v), sanitized); noBegin(v);
  }
});
for (const [label, mutate] of [
  ['ordered line hash', t => { t.row_hashes_sha256 = hash('wrong'); }],
  ['whole-file hash substituted for line hashes', t => { t.row_hashes_sha256 = hash(line(KEYS[0])); }],
  ['too many catalog rows', t => { t.rows++; }], ['too few catalog rows', t => { t.rows--; }],
  ['short catalog bytes', t => { t.bytes--; }], ['long catalog bytes', t => { t.bytes++; }],
]) test(`first pass catches ${label}, with no server preparation`, async () => {
  const v = fixture({ texts: { dispatch_config: lines(KEYS[0], 2) } }); mutate(v.catalog.tables[0]);
  await assert.rejects(stageRun(v), sanitized); noBegin(v);
});
for (const [label, change] of [
  ['same-length valid content', text => text.replace('來源', '来原')],
  ['illegal JSON', text => '[' + text.slice(1)],
  ['escaped duplicate key', text => text.replace('"id":', `"\\u0069d":"${id(2)}","id":`)],
  ['truncated last byte', text => text.slice(0, -1)], ['extra row', text => text + line(KEYS[0], 2)],
]) test(`second-pass ${label} reports staging may exist, never dry-runs or auto-retries`, async () => {
  const v = fixture(), original = v.temporary.open; let opened = 0;
  v.temporary.open = path => path === pathFor(KEYS[0]) && ++opened === 2
    ? fragments(Buffer.from(change(v.texts[KEYS[0]])), 7) : original(path);
  await assert.rejects(stageRun(v), error => {
    assert.equal(error.name, 'DispatchImportStagingMayExistError'); assert.equal(error.stagingMayExist, true);
    assert.equal(error.cancelled, false); return sanitized(error);
  });
  assert.equal(v.calls.begin.length, 1); assert.equal(v.calls.dryRun, 0); noAutomaticWrites(v);
});
function sizedLine(key, n, bytes) {
  const value = { ...row(key, n), description: '' };
  const base = JSON.stringify(value) + '\n', padding = bytes - Buffer.byteLength(base);
  assert.ok(padding >= 0);
  // Multi-byte padding proves limits are UTF-8 byte limits, not JS string length.
  return base.replace('"description":""', `"description":"${'界'.repeat(Math.floor(padding / 3))}${'x'.repeat(padding % 3)}"`);
}
test('64KiB line bound includes LF, accepts split Unicode, and refuses one extra byte', async () => {
  for (const bytes of [65536, 65537]) {
    const text = sizedLine(KEYS[0], 1, bytes); assert.equal(Buffer.byteLength(text), bytes);
    const v = fixture({ empty: true, texts: { dispatch_config: text }, fragmentSize: 4093 });
    if (bytes === 65536) assert.equal((await stageRun(v)).bytes, bytes);
    else { await assert.rejects(stageRun(v)); noBegin(v); }
  }
});
test('256KiB pages flush both exactly at the byte bound and before a row that would exceed it', async () => {
  for (const size of [65536, 65535]) {
    const text = Array.from({ length: 5 }, (_, i) => sizedLine(KEYS[0], i + 1, size)).join('');
    const v = fixture({ empty: true, texts: { dispatch_config: text }, fragmentSize: 1048576 });
    await stageRun(v); const pages = v.calls.stage.filter(p => p.key === KEYS[0]);
    assert.deepEqual(pages.map(p => Buffer.byteLength(p.ndjson)), [size * 4, size]);
    assert.deepEqual(pages.map(p => p.chunkNo), [0, 1]); assert.equal(pages.map(p => p.ndjson).join(''), text);
  }
});
test('exactly 200 rows end a table without inventing an extra empty stage chunk', async () => {
  const v = fixture({ empty: true, texts: { dispatch_config: lines(KEYS[0], 200) } });
  await stageRun(v);
  assert.deepEqual(v.calls.stage.filter(page => page.key === KEYS[0]).map(page => [page.chunkNo, count(page.ndjson)]), [[0, 200]]);
});
test('source staging is not incorrectly restricted to the smaller 8MiB target-backup limit', async () => {
  const text = Array.from({ length: 129 }, (_, i) => sizedLine(KEYS[0], i + 1, 65536)).join('');
  const v = fixture({ empty: true, texts: { dispatch_config: text }, fragmentSize: 1048576 });
  assert.equal((await stageRun(v)).bytes, 8454144);
  assert.equal(v.calls.stage.filter(p => p.key === KEYS[0]).length, 33); noAutomaticWrites(v);
});
for (const [label, mutate] of [
  ['success', a => { a.success = false; }], ['scope', a => { a.scope = 'shared-settings'; }],
  ['full-site completion', a => { a.full_site_complete = true; }], ['extra key', a => { a.secret = SECRET; }],
]) test(`begin ${label} mismatch is uncertain staging, not a safe rollback`, async () => {
  const v = fixture(); v.target.begin = async c => { v.calls.begin.push(c); const value = confirmed(); mutate(value); return value; };
  await assert.rejects(stageRun(v), error => error.stagingMayExist === true && sanitized(error));
  assert.equal(v.calls.begin.length, 1); assert.equal(v.calls.stage.length, 0); assert.equal(v.calls.dryRun, 0); noAutomaticWrites(v);
});
for (const operation of ['begin', 'stage', 'dryRun']) test(`${operation} transport errors are sanitized, uncertain and never retried`, async () => {
  const v = fixture(), original = v.target[operation];
  v.target[operation] = async (...args) => { await original(...args); throw new Error(SECRET); };
  await assert.rejects(stageRun(v), error => {
    assert.equal(error.stagingMayExist, true); assert.equal(error.cancelled, false); return sanitized(error);
  });
  assert.equal(v.calls.begin.length, 1);
  if (operation === 'begin') assert.equal(v.calls.stage.length, 0);
  if (operation === 'stage') { assert.equal(v.calls.stage.length, 1); assert.equal(stageProgress(v).length, 0); }
  assert.equal(v.calls.dryRun, operation === 'dryRun' ? 1 : 0); noAutomaticWrites(v);
});
for (const [label, mutate] of [
  ['success', a => { a.success = false; }], ['rows', a => { a.rows++; }], ['bytes', a => { a.bytes++; }],
  ['hash', a => { a.sha256 = hash('wrong'); }], ['repeated flag', a => { a.repeated = 'true'; }],
  ['extra key', a => { a.secret = SECRET; }], ['missing key', a => { delete a.repeated; }],
]) test(`stage ${label} receipt mismatch never credits rows or calls dry-run`, async () => {
  const v = fixture(); v.target.stage = async (key, chunkNo, ndjson) => {
    v.calls.stage.push({ key, chunkNo, ndjson }); const value = ack(ndjson); mutate(value); return value;
  };
  await assert.rejects(stageRun(v), error => error.stagingMayExist === true && sanitized(error));
  assert.equal(stageProgress(v).length, 0); assert.equal(v.calls.stage.length, 1); assert.equal(v.calls.dryRun, 0); noAutomaticWrites(v);
});
test('backpressure stops pulling source rows and progress until the exact receipt resolves; repeated=true counts once', async () => {
  const v = fixture({ empty: true, texts: { dispatch_config: lines(KEYS[0], 201) } });
  const original = v.temporary.open;
  v.temporary.open = path => {
    if (path !== pathFor(KEYS[0]) || !v.calls.reads.some(read => read.key === KEYS[0])) return original(path);
    const read = { key: KEYS[0], pass: 2, pulls: 0 }; v.calls.reads.push(read);
    return { async *[Symbol.asyncIterator]() { for (const text of v.texts[KEYS[0]].match(/[^\n]*\n/g)) { read.pulls++; yield Buffer.from(text); } } };
  };
  const entered = deferred(), gate = deferred(), stage = v.target.stage;
  v.target.stage = async (...args) => {
    const receipt = await stage(...args);
    if (v.calls.stage.length === 1) { entered.resolve(); await gate.promise; }
    return { ...receipt, repeated: true };
  };
  const pending = stageRun(v); await entered.promise;
  assert.equal(v.calls.reads.at(-1).pulls, 200); assert.equal(v.calls.stage.length, 1);
  assert.equal(stageProgress(v).length, 0); assert.equal(v.calls.dryRun, 0);
  gate.resolve(); const result = await pending;
  assert.equal(result.rows, 201); assert.deepEqual(stageProgress(v).slice(0, 2).map(p => p.rows), [200, 201]);
  assert.equal(v.calls.stage.length, 8); noAutomaticWrites(v);
});
for (const field of ['full_site_complete', 'replacement_ready', 'can_apply']) {
  for (const value of [true, 0, null, undefined, 'false']) test(`dry-run ${field} must be literal false, not ${String(value)}`, async () => {
    const v = fixture(); v.target.dryRun = async () => { v.calls.dryRun++; return { ...dryFor(v.catalog), [field]: value }; };
    await assert.rejects(stageRun(v), error => error.stagingMayExist === true && sanitized(error));
    assert.equal(v.calls.dryRun, 1); assert.equal(v.progress.some(p => p.phase === 'dry-run'), false); noAutomaticWrites(v);
  });
}
for (const [label, mutate] of [
  ['preparation not ready', d => { d.preparation_ready = false; }], ['truthy preparation', d => { d.preparation_ready = 1; }],
  ['wrong scope', d => { d.scope = 'full-site'; }], ['unknown property', d => { d.secret = SECRET; }],
  ['missing property', d => { delete d.can_apply; }], ['bad plan hash', d => { d.plan_hash = 'A'.repeat(64); }],
  ['bad default group UUID', d => { d.source_default_group_id = 'invalid'; }],
  ['missing count', d => { delete d.counts.used_order_data; }], ['extra count', d => { d.counts.orders = 0; }],
  ['negative count', d => { d.counts.dispatch_config = -1; }], ['row limit', d => { d.counts.dispatch_config = 500001; }],
  ['count string', d => { d.counts.dispatch_config = '1'; }], ['fractional dependency', d => { d.dependencies.orders = 0.5; }],
  ['unsafe dependency', d => { d.dependencies.employees = Number.MAX_SAFE_INTEGER + 1; }],
  ['negative dependency', d => { d.dependencies.administrators = -1; }], ['extra dependency', d => { d.dependencies.unknown = 0; }],
  ['accessor property', d => { Object.defineProperty(d, 'can_apply', { enumerable: true, get() { throw new Error(SECRET); } }); }],
]) test(`strict dry-run validator rejects ${label}`, () => {
  const value = dryFor(fixture().catalog); mutate(value);
  assert.throws(() => api.validateDispatchImportDryRun(value), sanitized);
});
for (const key of KEYS) test(`dry-run ${key} count must equal the validated source`, async () => {
  const v = fixture(); v.target.dryRun = async () => { v.calls.dryRun++; const value = dryFor(v.catalog); value.counts[key]++; return value; };
  await assert.rejects(stageRun(v), { stagingMayExist: true }); assert.equal(v.progress.some(p => p.phase === 'dry-run'), false); noAutomaticWrites(v);
});
test('dry-run returns detached counts and dependency data, with preparation-only flags unchanged', () => {
  const input = dryFor(fixture().catalog), result = api.validateDispatchImportDryRun(input);
  assert.deepEqual(result, input); result.counts.dispatch_config = 90; result.dependencies.orders = 99;
  assert.equal(input.counts.dispatch_config, 1); assert.equal(input.dependencies.orders, 4);
});
test('already aborted import does not open files or begin', async () => {
  const v = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(stageRun(v, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(v.calls.reads.length, 0); noBegin(v);
});
for (const operation of ['begin', 'stage', 'dryRun']) {
  for (const late of ['resolve', 'reject']) test(`abort during ${operation} ignores late ${late}, never retries or advances progress`, async () => {
    const v = fixture(), controller = new AbortController(), entered = deferred(), blocked = deferred();
    const original = v.target[operation];
    v.target[operation] = async (...args) => { const receipt = await original(...args); entered.resolve(receipt); return blocked.promise; };
    const pending = stageRun(v, { signal: controller.signal }); const receipt = await entered.promise;
    controller.abort(); await assert.rejects(soon(pending), error => {
      assert.equal(error.stagingMayExist, true); assert.equal(error.cancelled, true); return sanitized(error);
    });
    const before = structuredClone({ calls: [v.calls.begin.length, v.calls.stage.length, v.calls.dryRun], progress: v.progress });
    if (late === 'resolve') blocked.resolve(receipt); else blocked.reject(new Error(SECRET));
    await nextTurn();
    assert.deepEqual({ calls: [v.calls.begin.length, v.calls.stage.length, v.calls.dryRun], progress: v.progress }, before);
    if (operation === 'stage') assert.equal(stageProgress(v).length, 0);
    noAutomaticWrites(v);
  });
}
for (const pass of [1, 2]) test(`aborting stalled async-iterator read on pass ${pass} closes without waiting for return()`, async () => {
  const v = fixture(), controller = new AbortController(), entered = deferred(), blocked = deferred(), original = v.temporary.open;
  let opens = 0, returns = 0;
  v.temporary.open = path => {
    if (path !== pathFor(KEYS[0]) || ++opens !== pass) return original(path);
    return { [Symbol.asyncIterator]() { return this; }, next() { entered.resolve(); return blocked.promise; },
      return() { returns++; return new Promise(() => {}); } };
  };
  const pending = stageRun(v, { signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(soon(pending), pass === 1 ? { name: 'AbortError' } : { stagingMayExist: true, cancelled: true });
  assert.equal(returns, 1); blocked.reject(new Error(SECRET)); await nextTurn();
  assert.equal(v.calls.dryRun, 0); if (pass === 1) noBegin(v); noAutomaticWrites(v);
});
test('ReadableStream reader is cancelled and its lock released on validation failure and abort', async () => {
  for (const abort of [false, true]) {
    const v = fixture(), controller = new AbortController(), entered = deferred(); let cancelled = 0;
    const stream = new ReadableStream({
      pull(control) { entered.resolve(); if (!abort) control.enqueue(Buffer.from('{\n')); },
      cancel() { cancelled++; },
    }, { highWaterMark: 0 });
    v.temporary.open = () => stream;
    const pending = stageRun(v, { signal: controller.signal }); await entered.promise;
    if (abort) controller.abort();
    await assert.rejects(soon(pending)); assert.equal(cancelled, 1); assert.equal(stream.locked, false); noBegin(v);
  }
});
test('successful ReadableStream scans release all fourteen reader locks at EOF', async () => {
  const v = fixture(), streams = [];
  v.temporary.open = path => {
    const stream = new ReadableStream({ start(control) { control.enqueue(Buffer.from(v.texts[keyFor(path)])); control.close(); } });
    streams.push(stream); return stream;
  };
  assert.equal((await stageRun(v)).rows, 7); assert.equal(streams.length, 14);
  assert.ok(streams.every(stream => stream.locked === false)); noAutomaticWrites(v);
});
test('invalid async-iterator input closes its producer even when return rejects', async () => {
  const v = fixture(); let returns = 0;
  v.temporary.open = () => ({ [Symbol.asyncIterator]() { return this; }, async next() { return { value: Buffer.from('{\n'), done: false }; },
    async return() { returns++; throw new Error(SECRET); } });
  await assert.rejects(stageRun(v), sanitized); await nextTurn(); assert.equal(returns, 1); noBegin(v);
});
for (const phase of ['validate', 'stage', 'dry-run']) test(`progress callback failure during ${phase} is sanitized and never resumes`, async () => {
  const v = fixture();
  await assert.rejects(stageRun(v, { onProgress(p) { if (p.phase === phase) throw new Error(SECRET); } }), error => {
    assert.equal(error.stagingMayExist === true, phase !== 'validate'); return sanitized(error);
  });
  if (phase === 'validate') noBegin(v); noAutomaticWrites(v);
});
for (const [label, change] of [
  ['scope', m => { m.scope = 'full-site'; }], ['site', m => { m.sourceSiteId = OTHER; }],
  ['volume index', m => { m.volumeIndex = 2; }], ['volume count', m => { m.volumeCount = 2; }],
  ['missing entry', m => { m.entries.pop(); }], ['unexpected entry', m => { m.entries[0].path = 'data/unexpected.ndjson'; }],
  ['wrong kind', m => { m.entries[0].kind = 'media'; }], ['wrong size', m => { m.entries[0].bytes++; }],
]) test(`dispatch manifest ${label} does not authorize preparation`, () => {
  const v = fixture(), manifest = manifestFor(v); change(manifest);
  assert.throws(() => api.validateDispatchManifest(manifest, v.catalog));
});
test('manifest file SHA-256 and catalog ordered line hashes are deliberately separate checks', () => {
  const v = fixture(), manifest = manifestFor(v);
  assert.notEqual(manifest.entries[0].sha256, v.catalog.tables[0].row_hashes_sha256);
  api.validateDispatchManifest(manifest, v.catalog);
});

test('encrypted import authenticates final EOF before any begin and then cleans all seven plaintext files', async () => {
  const v = fixture(), bytes = await encrypted(v), entered = deferred(), eof = deferred();
  const source = { async *[Symbol.asyncIterator]() { yield* fragments(bytes); entered.resolve(); await eof.promise; v.events.push('encrypted-eof'); } };
  const pending = api.importDispatchVolume(v.catalog, source, PASSPHRASE, metadata, v.temporary, v.target);
  await entered.promise; noBegin(v); eof.resolve(); const result = await pending;
  assert.ok(v.events.indexOf('encrypted-eof') < v.events.indexOf('begin'));
  assert.equal(result.rows, 7); assert.equal(v.calls.abort, 1); assert.equal(v.invalidated, true); assert.equal(v.stored.size, 0); noAutomaticWrites(v);
});
test('whole-volume corruption, wrong password, wrong manifest or catalog can never begin', async t => {
  const base = fixture(), bytes = await encrypted(base), tampered = Buffer.from(bytes); tampered[tampered.length - 1] ^= 1;
  const cases = [
    ['wrong password', bytes, undefined, WRONG_PASSPHRASE], ['authentication tag', tampered],
    ['truncation', bytes.subarray(0, -1)], ['trailing byte', Buffer.concat([bytes, Buffer.from([0])])],
    ['wrong entry path', await encrypted(base, { entries: entries => entries.map((e, i) => i ? e : { ...e, path: 'data/wrong.ndjson' }) })],
    ['missing table file', await encrypted(base, { entries: entries => entries.slice(0, -1) })],
    ['wrong site', await encrypted(base, { identity: { sourceSiteId: OTHER } })],
    ['wrong scope', await encrypted(base, { identity: { scope: 'full-site' } })],
    ['wrong package', await encrypted(base, { identity: { exportId: OTHER } })],
    ['wrong volume', await encrypted(base, { identity: { volumeId: OTHER } })],
    ['multiple volumes', await encrypted(base, { identity: { volumeCount: 2 } })],
    ['wrong catalog hash', bytes, v => { v.catalog.tables[0].row_hashes_sha256 = hash('wrong'); }],
    ['catalog byte mismatch', bytes, v => { v.catalog.tables[0].bytes++; }],
    ['catalog row mismatch', bytes, v => { v.catalog.tables[0].rows++; }],
    ['authenticated illegal JSON', await encrypted(base, { entries: entries => entries.map((e, i) => i ? e : { ...e, body: Buffer.from('{\n') }) })],
  ];
  for (const [label, body, change, password] of cases) await t.test(label, async () => {
    const v = fixture(); change?.(v);
    await assert.rejects(volumeRun(v, body, {}, password), sanitized);
    noBegin(v); assert.equal(v.calls.abort, 1); assert.equal(v.stored.size, 0);
  });
});
test('an authenticated but invalid final ZIP directory cannot begin after plaintext was already emitted', async () => {
  const v = fixture(), plain = await collect(api.writePlainVolume(entriesFor(v), info));
  const bad = plain.subarray(0, -1);
  const bytes = await collect(api.encryptTransferStream(fragments(bad), PASSPHRASE, metadata));
  await assert.rejects(volumeRun(v, bytes), sanitized);
  assert.ok(v.calls.append.length > 0); assert.equal(v.calls.abort, 1); noBegin(v);
});
test('genuine GCM and repaired ZIP CRCs cannot hide an incorrect manifest SHA-256 or byte count', async t => {
  const original = fixture(), plain = await collect(api.writePlainVolume(entriesFor(original), info));
  for (const [label, mutate] of [
    ['SHA-256', m => { m.entries[0].sha256 = hash('different plaintext'); }],
    ['byte count', m => { m.entries[0].bytes++; }],
  ]) await t.test(label, async () => {
    const zip = corruptPlainManifest(plain, mutate);
    const bytes = await collect(api.encryptTransferStream(fragments(zip), PASSPHRASE, metadata));
    const v = fixture(); await assert.rejects(volumeRun(v, bytes), sanitized);
    assert.ok(v.calls.append.length > 0); assert.equal(v.calls.abort, 1); assert.equal(v.stored.size, 0); noBegin(v);
  });
});
for (const afterStage of [false, true]) test(`import cleanup failure is explicit ${afterStage ? 'after staging' : 'before staging'}`, async () => {
  const v = fixture(), bytes = afterStage ? await encrypted(v) : Buffer.from('bad-container');
  v.temporary.abort = async () => { v.calls.abort++; throw new Error(SECRET); };
  await assert.rejects(volumeRun(v, bytes), error => {
    assert.equal(error.name, 'DispatchImportCleanupError'); assert.equal(error.cleanupRequired, true);
    assert.equal(error.stagingMayExist, afterStage); return sanitized(error);
  });
  assert.equal(v.calls.abort, 1); if (!afterStage) noBegin(v); noAutomaticWrites(v);
});
test('aborted encrypted read closes the producer, discards plaintext and ignores late rejection', async () => {
  const v = fixture(), controller = new AbortController(), entered = deferred(), stalled = deferred(); let returns = 0;
  const source = { [Symbol.asyncIterator]() { return this; }, next() { entered.resolve(); return stalled.promise; },
    async return() { returns++; return { done: true }; } };
  const pending = api.importDispatchVolume(v.catalog, source, PASSPHRASE, metadata, v.temporary, v.target, { signal: controller.signal });
  await entered.promise; controller.abort(); await assert.rejects(soon(pending), { name: 'AbortError' });
  stalled.reject(new Error(SECRET)); await nextTurn(); assert.equal(returns, 1); assert.equal(v.calls.abort, 1); noBegin(v);
});

function diskSource(path, onEof = () => {}) {
  return { async *[Symbol.asyncIterator]() {
    const file = await open(path, 'r'), buffer = Buffer.alloc(65521);
    try {
      while (true) {
        const { bytesRead } = await file.read(buffer); if (!bytesRead) { onEof(); break; }
        yield buffer.subarray(0, bytesRead); // Intentionally reused Buffer across awaited consumers.
      }
    } finally { await file.close(); }
  } };
}
test('independent real-fs backup survives seven-file cleanup, authenticates row summaries, uploads 128KiB chunks and seals', async () => {
  const v = fixture({ texts: { valid_order_data: lines('valid_order_data', 1800) } });
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-prepare-backup-')); directories.push(directory);
  const cipherPath = join(directory, 'independent.edx'), plainPaths = KEYS.map(key => join(directory, `${key}.ndjson`));
  v.temporary = {
    async append(path, bytes) {
      const file = await open(plainPaths[KEYS.indexOf(keyFor(path))], 'a');
      try { await file.writeFile(bytes); } finally { await file.close(); }
    },
    open(path) { return diskSource(plainPaths[KEYS.indexOf(keyFor(path))]); },
    async abort() { v.calls.abort++; await Promise.all(plainPaths.map(path => rm(path, { force: true }))); v.events.push('plaintext-deleted'); },
  };
  v.file = {
    async write(source) {
      v.calls.save++; const file = await open(cipherPath, 'wx');
      try { for await (const bytes of source) await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      v.events.push('cipher-saved');
    },
    open() { const pass = ++v.calls.reread; return diskSource(cipherPath, () => v.events.push(`cipher-eof:${pass}`)); },
  };
  const append = v.receiver.append;
  v.receiver.append = async (...args) => {
    assert.equal(v.calls.reread, 2); assert.ok(v.events.includes('plaintext-deleted'));
    return { ...await append(...args), repeated: true };
  };
  const result = await backupRun(v), saved = await readFile(cipherPath);
  for (const path of plainPaths) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.ok((await stat(cipherPath)).size > 0); assert.equal(saved.subarray(0, 8).toString(), 'EDXSTRM1');
  assert.equal(v.calls.save, 1); assert.equal(v.calls.reread, 2); assert.equal(v.calls.abort, 1);
  assert.ok(v.events.indexOf('cipher-saved') < v.events.indexOf('plaintext-deleted'));
  assert.equal(result.cipherSha256, hash(saved)); assert.equal(result.bytes, saved.length);
  assert.equal(result.chunks, v.calls.upload.length); assert.ok(result.chunks > 1);
  assert.deepEqual(Buffer.concat(v.calls.upload.map(page => page.bytes)), saved);
  assert.deepEqual(v.calls.upload.map(page => page.chunkNo), v.calls.upload.map((_, index) => index));
  assert.ok(v.calls.upload.slice(0, -1).every(page => page.bytes.length === 131072));
  assert.deepEqual(v.calls.seal, [{ sha256: hash(saved), bytes: saved.length }]);
  assert.deepEqual(result.sealReceipt, { ...seal(hash(saved), saved.length) });
  const recovered = new Map();
  const manifest = await api.verifyEncryptedVolume(diskSource(cipherPath), PASSPHRASE, {
    async append(path, bytes) { if (!recovered.has(path)) recovered.set(path, []); recovered.get(path).push(Buffer.from(bytes)); },
    async abort() { assert.fail('independent file must remain valid'); },
  }, { expectedMetadata: { exportId: BACKUP, volumeId: BACKUP } });
  assert.equal(manifest.scope, 'replacement-backup'); assert.equal(manifest.sourceSiteId, SITE);
  assert.equal(manifest.volumeIndex, 1); assert.equal(manifest.volumeCount, 1);
  for (const key of KEYS) {
    const entry = manifest.entries.find(entry => entry.path === pathFor(key));
    assert.deepEqual(entry, { path: pathFor(key), kind: 'ndjson', bytes: Buffer.byteLength(v.texts[key]), sha256: hash(v.texts[key]) });
    assert.deepEqual(Buffer.concat(recovered.get(pathFor(key))), Buffer.from(v.texts[key]));
    const verifier = new api.DispatchTableVerifier(v.catalog.tables.find(table => table.key === key));
    for (const chunk of recovered.get(pathFor(key))) await verifier.push(chunk);
    assert.equal(verifier.finish(), hash(v.texts[key]));
  }
  assert.deepEqual([...new Set(v.progress.map(p => p.phase))], ['snapshot', 'save', 'verify', 'upload', 'seal']);
  for (const phase of ['save', 'verify', 'upload', 'seal']) assert.equal(v.progress.filter(p => p.phase === phase).at(-1).completed, true);
  assert.equal(v.progress.filter(p => p.phase === 'upload').at(-1).bytes, saved.length); noAutomaticWrites(v);
});
test('valid authenticated file with same-length changed plaintext still fails catalog row hashes before upload', async () => {
  const v = fixture(), original = v.temporary.open;
  v.temporary.open = path => path === pathFor(KEYS[0])
    ? fragments(Buffer.from(v.texts[KEYS[0]].replace('來源', '来原'))) : original(path);
  await assert.rejects(backupRun(v), { name: 'DispatchBackupError', phase: 'verify', serverChunksMayExist: false });
  const manifest = await api.verifyEncryptedVolume(fragments(v.saved), PASSPHRASE, { async append() {}, async abort() { assert.fail(); } },
    { expectedMetadata: { exportId: BACKUP, volumeId: BACKUP } });
  assert.equal(manifest.entries[0].bytes, v.catalog.tables[0].bytes);
  assert.notEqual(manifest.entries[0].sha256, hash(v.texts[KEYS[0]]));
  assert.equal(v.calls.upload.length, 0); assert.equal(v.calls.seal.length, 0); assert.equal(v.calls.abort, 1);
});
for (const [label, mutate, phase] of [
  ['early save acknowledgement', v => { v.file.write = async () => { v.calls.save++; }; }, 'save'],
  ['file write failure', v => { v.file.write = async () => { v.calls.save++; throw new Error(SECRET); }; }, 'save'],
  ['saved ciphertext changed', v => { const write = v.file.write; v.file.write = async (...args) => { await write(...args); v.saved[v.saved.length - 1] ^= 1; }; }, 'verify'],
  ['ciphertext truncated', v => { const write = v.file.write; v.file.write = async (...args) => { await write(...args); v.saved = v.saved.subarray(0, -1); }; }, 'verify'],
  ['upload reread changed', v => { const read = v.file.open; v.file.open = () => { if (v.calls.reread === 1) v.saved[v.saved.length - 1] ^= 1; return read(); }; }, 'upload'],
  ['source verification failure', v => { v.source.verify = async () => { v.calls.verify++; throw new Error(SECRET); }; }, 'snapshot'],
  ['descriptor catalog drift', v => { v.descriptor.catalog.tables[0].row_hashes_sha256 = hash('changed'); }, 'snapshot'],
  ['plaintext cleanup failure', v => { v.temporary.abort = async () => { v.calls.abort++; throw new Error(SECRET); }; }, 'save'],
  ['seal transport outcome unknown', v => { v.receiver.seal = async () => { v.calls.seal.push({}); throw new Error(SECRET); }; }, 'seal'],
]) test(`backup ${label} is sanitized, cleaned once and never retried or applied`, async () => {
  const v = fixture(); mutate(v);
  await assert.rejects(backupRun(v), error => {
    assert.equal(error.name, 'DispatchBackupError'); assert.equal(error.phase, phase); assert.equal(error.cancelled, false);
    assert.equal(error.cleanupRequired, label === 'plaintext cleanup failure');
    assert.equal(error.serverChunksMayExist, ['upload', 'seal'].includes(phase));
    assert.equal(error.sealMayHaveSucceeded, phase === 'seal'); return sanitized(error);
  });
  assert.equal(v.calls.abort, 1); noAutomaticWrites(v);
  if (['snapshot', 'save', 'verify'].includes(phase)) assert.equal(v.calls.upload.length, 0);
  if (phase !== 'seal') assert.equal(v.calls.seal.length, 0);
});
for (const [label, change] of [
  ['wrong saved password', { password: WRONG_PASSPHRASE }], ['saved manifest scope', { identity: { scope: 'full-site' } }],
  ['saved manifest site', { identity: { sourceSiteId: OTHER } }], ['saved manifest volume count', { identity: { volumeCount: 2 } }],
  ['saved manifest path', { entries: entries => entries.map((e, i) => i ? e : { ...e, path: 'data/unexpected.ndjson' }) }],
]) test(`backup reauthentication rejects ${label} before sending ciphertext`, async () => {
  const v = fixture(), write = v.file.write;
  v.file.write = async (...args) => {
    await write(...args);
    v.saved = await encrypted(v, { ...change, identity: { exportId: BACKUP, ...change.identity } });
  };
  await assert.rejects(backupRun(v), error => {
    assert.equal(error.phase, 'verify'); assert.equal(error.serverChunksMayExist, false); return sanitized(error);
  });
  assert.equal(v.calls.reread, 1); assert.equal(v.calls.upload.length, 0); assert.equal(v.calls.seal.length, 0); noAutomaticWrites(v);
});
for (const [label, mutate] of [
  ['success', a => { a.success = false; }], ['bytes', a => { a.bytes++; }], ['sha256', a => { a.sha256 = hash('bad'); }],
  ['repeated', a => { a.repeated = 1; }], ['extra field', a => { a.secret = SECRET; }], ['missing field', a => { delete a.sha256; }],
]) test(`backup upload ${label} mismatch never credits progress or seals`, async () => {
  const v = fixture(), append = v.receiver.append;
  v.receiver.append = async (...args) => { const value = await append(...args); mutate(value); return value; };
  await assert.rejects(backupRun(v), error => {
    assert.equal(error.phase, 'upload'); assert.equal(error.serverChunksMayExist, true); return sanitized(error);
  });
  assert.equal(v.calls.upload.length, 1); assert.equal(v.calls.seal.length, 0);
  assert.deepEqual(v.progress.filter(p => p.phase === 'upload'), [{ phase: 'upload', bytes: 0, completed: false }]); noAutomaticWrites(v);
});
for (const [label, mutate] of [
  ['success', a => { a.success = false; }], ['backup identity', a => { a.backup_id = OTHER; }],
  ['bytes', a => { a.bytes++; }], ['hash', a => { a.sha256 = hash('bad'); }],
  ['repeated', a => { a.repeated = 'false'; }], ['full-site completion', a => { a.full_site_complete = true; }],
  ['extra field', a => { a.secret = SECRET; }], ['missing field', a => { delete a.full_site_complete; }],
]) test(`backup seal ${label} mismatch remains uncertain, never claims success`, async () => {
  const v = fixture(), original = v.receiver.seal;
  v.receiver.seal = async (...args) => { const value = await original(...args); mutate(value); return value; };
  await assert.rejects(backupRun(v), error => {
    assert.equal(error.phase, 'seal'); assert.equal(error.sealMayHaveSucceeded, true);
    assert.equal(error.serverChunksMayExist, true); return sanitized(error);
  });
  assert.equal(v.calls.seal.length, 1); assert.equal(v.progress.some(p => p.phase === 'seal' && p.completed), false); noAutomaticWrites(v);
});
test('upload backpressure counts only confirmed ciphertext and does not read another input chunk while pending', async () => {
  const v = fixture({ texts: { valid_order_data: lines('valid_order_data', 1800) } });
  const entered = deferred(), blocked = deferred(), append = v.receiver.append, read = v.file.open; let pulls = 0;
  v.file.open = () => {
    if (v.calls.reread === 0) return read();
    v.calls.reread++;
    return { async *[Symbol.asyncIterator]() {
      for await (const bytes of fragments(v.saved, 131072)) { pulls++; yield bytes; }
      v.events.push('cipher-eof:2');
    } };
  };
  v.receiver.append = async (...args) => {
    const result = await append(...args);
    if (v.calls.upload.length === 1) { entered.resolve(); await blocked.promise; }
    return result;
  };
  const pending = backupRun(v); await entered.promise;
  assert.equal(pulls, 1); assert.equal(v.calls.upload.length, 1); assert.equal(v.calls.seal.length, 0);
  assert.deepEqual(v.progress.filter(p => p.phase === 'upload'), [{ phase: 'upload', bytes: 0, completed: false }]);
  blocked.resolve(); const result = await pending;
  const progress = v.progress.filter(p => p.phase === 'upload');
  assert.equal(progress[1].bytes, 131072); assert.equal(progress.at(-1).bytes, result.bytes); assert.equal(progress.at(-1).completed, true);
});
for (const operation of ['save', 'append', 'seal']) test(`backup abort during ${operation} ignores late failure with correct uncertainty flags`, async () => {
  const v = fixture(), controller = new AbortController(), entered = deferred(), blocked = deferred();
  if (operation === 'save') v.file.write = async () => { v.calls.save++; entered.resolve(); return blocked.promise; };
  else {
    const original = v.receiver[operation];
    v.receiver[operation] = async (...args) => { await original(...args); entered.resolve(); return blocked.promise; };
  }
  const pending = backupRun(v, { signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(soon(pending), error => {
    assert.equal(error.name, 'DispatchBackupError'); assert.equal(error.cancelled, true);
    assert.equal(error.phase, operation === 'append' ? 'upload' : operation);
    assert.equal(error.serverChunksMayExist, operation !== 'save'); assert.equal(error.sealMayHaveSucceeded, operation === 'seal');
    return sanitized(error);
  });
  const calls = [v.calls.save, v.calls.reread, v.calls.upload.length, v.calls.seal.length], progress = structuredClone(v.progress);
  blocked.reject(new Error(SECRET)); await nextTurn();
  assert.deepEqual([v.calls.save, v.calls.reread, v.calls.upload.length, v.calls.seal.length], calls);
  assert.deepEqual(v.progress, progress); assert.equal(v.calls.abort, 1); noAutomaticWrites(v);
});
for (const phase of ['verify', 'upload']) test(`backup abort during stalled ${phase} read closes the independent-file iterator`, async () => {
  const v = fixture(), controller = new AbortController(), entered = deferred(), stalled = deferred(), read = v.file.open;
  let returns = 0;
  v.file.open = () => {
    if (phase === 'upload' && v.calls.reread === 0) return read();
    v.calls.reread++;
    return { [Symbol.asyncIterator]() { return this; }, next() { entered.resolve(); return stalled.promise; },
      return() { returns++; return Promise.reject(new Error(SECRET)); } };
  };
  const pending = backupRun(v, { signal: controller.signal }); await soon(entered.promise); controller.abort();
  await assert.rejects(soon(pending), error => {
    assert.equal(error.phase, phase); assert.equal(error.cancelled, true); assert.equal(error.serverChunksMayExist, false);
    assert.equal(error.sealMayHaveSucceeded, false); return sanitized(error);
  });
  stalled.reject(new Error(SECRET)); await nextTurn(); assert.equal(returns, 1);
  assert.equal(v.calls.abort, 1); assert.equal(v.calls.upload.length, 0); assert.equal(v.calls.seal.length, 0); noAutomaticWrites(v);
});
test('backup pre-abort makes no source/save/upload calls but invalidates plaintext once', async () => {
  const v = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(backupRun(v, { signal: controller.signal }), { name: 'DispatchBackupError', phase: 'snapshot', cancelled: true });
  assert.equal(v.calls.catalog, 0); assert.equal(v.calls.save, 0); assert.equal(v.calls.upload.length, 0); assert.equal(v.calls.abort, 1);
});
test('terminal seal observer failure cannot turn an acknowledged seal into a failed backup', async () => {
  const v = fixture();
  const result = await backupRun(v, { onProgress(p) { if (p.phase === 'seal' && p.completed) throw new Error(SECRET); } });
  assert.equal(result.sealReceipt.success, true); assert.equal(v.calls.seal.length, 1); noAutomaticWrites(v);
});
test('backup descriptor enforces the aggregate 8MiB plaintext ceiling before source reads, without truncation', async () => {
  const v = fixture({ empty: true });
  v.descriptor.catalog.tables[0] = { key: KEYS[0], rows: 128, bytes: 8388608, row_hashes_sha256: hash('bounded fixture') };
  assert.equal(api.validateDispatchBackupDescriptor(v.descriptor).catalog.tables[0].bytes, 8388608);
  v.descriptor.catalog.tables[1] = { key: KEYS[1], rows: 1, bytes: 1, row_hashes_sha256: hash('overflow') };
  assert.throws(() => api.validateDispatchBackupDescriptor(v.descriptor), { name: 'DispatchBackupLimitError', kind: 'plaintext' });
  await assert.rejects(backupRun(v), error => {
    assert.equal(error.phase, 'snapshot'); assert.equal(error.limitExceeded, true); assert.equal(error.serverChunksMayExist, false); return sanitized(error);
  });
  assert.equal(v.calls.catalog, 0); assert.equal(v.calls.save, 0); assert.equal(v.calls.abort, 1); assert.equal(v.calls.upload.length, 0);
});
test('a real exactly-8MiB plaintext backup completes without truncating any table or ciphertext chunk', async () => {
  const body = Array.from({ length: 128 }, (_, i) => sizedLine(KEYS[0], i + 1, 65536)).join('');
  assert.equal(Buffer.byteLength(body), 8388608);
  const v = fixture({ empty: true, texts: { dispatch_config: body } });
  const result = await backupRun(v);
  assert.equal(v.catalog.tables.reduce((sum, t) => sum + t.bytes, 0), 8388608);
  assert.ok(result.bytes > 8388608 && result.bytes < 9437184);
  assert.deepEqual(Buffer.concat(v.calls.upload.map(p => p.bytes)), v.saved);
  assert.equal(result.bytes, v.saved.length); assert.equal(result.cipherSha256, hash(v.saved));
  assert.equal(v.calls.seal.length, 1); assert.equal(v.calls.abort, 1); noAutomaticWrites(v);
});
test('9MiB ciphertext upload-reread ceiling is enforced before sealing and marked as uncertain partial upload', async () => {
  const v = fixture(), read = v.file.open;
  v.file.open = () => {
    if (v.calls.reread === 0) return read();
    v.calls.reread++;
    return { async *[Symbol.asyncIterator]() {
      yield* fragments(v.saved);
      yield* fragments(Buffer.alloc(9437185 - v.saved.length), 1048576);
    } };
  };
  // Retain only counters for this malicious reread, not 9MiB of duplicated test ciphertext/hex.
  v.receiver.append = async (chunkNo, hex) => {
    const bytes = Buffer.from(hex, 'hex'); v.calls.upload.push({ chunkNo, length: bytes.length });
    return { success: true, bytes: bytes.length, sha256: hash(bytes), repeated: false };
  };
  await assert.rejects(backupRun(v), error => {
    assert.equal(error.phase, 'upload'); assert.equal(error.limitExceeded, true); assert.equal(error.serverChunksMayExist, true);
    assert.equal(error.sealMayHaveSucceeded, false); return sanitized(error);
  });
  assert.ok(v.calls.upload.length > 0); assert.equal(v.calls.seal.length, 0); assert.equal(v.calls.abort, 1); noAutomaticWrites(v);
});
