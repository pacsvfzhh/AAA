import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TRANSFER_SCOPE_COVERAGE_INVENTORY } from './support/transfer-scope.mjs';

mock.method(globalThis, 'fetch', () => assert.fail('network access forbidden in local backup tests'));
const directories = [];
after(async () => { mock.restoreAll(); await Promise.all(directories.map(path => rm(path, { recursive: true, force: true }))); });
const root = fileURLToPath(new URL('../../', import.meta.url));
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/notificationsBackup.ts';
  export { writeEncryptedVolume, verifyEncryptedVolume } from './src/lib/employeeTransfer/container.ts';`,
resolveDir: root, sourcefile: 'notifications-backup-test-entry.mjs', loader: 'js' },
bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', metafile: true });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const SITE = '11111111-1111-4111-8111-111111111111', PACKAGE = '22222222-2222-4222-8222-222222222222';
const BACKUP = '33333333-3333-4333-8333-333333333333', OTHER = '44444444-4444-4444-8444-444444444444';
const PASSPHRASE = 'local-notifications-independent-backup-passphrase', WRONG = 'local-notifications-wrong-passphrase';
const SECRET = 'private-notifications-token-error-must-not-escape';
const TIME = '2024-02-29T12:34:56.123456+00:00', PRECISE = '12345678901234567890.12345678901234567890';
const TABLES = ['notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
  'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
  'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients',
  'message_templates', 'broadcast_messages', 'broadcast_recipients'];
const LEASES = ['delivery_claim_token', 'delivery_claim_channel', 'delivery_claim_until', 'delivery_completed_claim_token'];
const sha = value => createHash('sha256').update(value).digest('hex');
const PLAN = sha('notification configuration plan'), TARGET = sha('frozen target notifications');
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const pathFor = key => `data/notifications-${key}.ndjson`;
const keyFor = path => { const key = TABLES.find(key => pathFor(key) === path); assert.ok(key); return key; };
const rows = text => (text.match(/\n/g) ?? []).length;
const rowHash = text => sha((text.match(/[^\n]*\n/g) ?? []).map(line => sha(line)).join(''));
function row(key, n = 1) {
  const columns = TRANSFER_SCOPE_COVERAGE_INVENTORY.find(t => t.schema === 'public' && t.name === key).columns;
  const result = Object.fromEntries(columns.filter(c => !LEASES.includes(c.name)).map(c => [c.name,
    ({ uuid: id(n), text: '原文é é 𠮷', integer: 1, smallint: 1, bigint: '9223372036854775807', numeric: 0,
      boolean: true, 'timestamp with time zone': TIME, jsonb: { trigger_type: 'total_orders', trigger_mode: 'reach_once',
        threshold_value: 0, minimum_daily_orders: null, minimum_daily_work_minutes: null } })[c.type]]));
  if ('status' in result) result.status = key === TABLES[5] ? 'succeeded' : 'active';
  if ('message_type' in result) result.message_type = key === TABLES[11] ? 'text' : 'realtime';
  if ('priority' in result) result.priority = 'normal';
  if ('delivery_mode' in result) result.delivery_mode = 'realtime_with_login_fallback';
  if ('delivery_channel' in result) result.delivery_channel = null;
  if ('notification_category' in result) result.notification_category = 'standard';
  if ('audit_origin' in result) result.audit_origin = 'unverified';
  if ('target_type' in result) result.target_type = 'all';
  if ('trigger_type' in result) result.trigger_type = 'total_orders';
  if ('trigger_mode' in result) result.trigger_mode = 'reach_once';
  if ('recipient_scope' in result) result.recipient_scope = 'selected';
  if ('period_key' in result) result.period_key = 'A:2024-02_29.01';
  if ('last_period_key' in result) result.last_period_key = 'A:2024-02_29.01';
  if ('error_message' in result) result.error_message = null;
  if ('last_error' in result) result.last_error = 'redacted migration error';
  if ([TABLES[3], TABLES[4], TABLES[7]].includes(key)) { result.task_id = id(1); result.id = `${result.task_id}:${result.user_id}`; }
  if (key === TABLES[2]) result.id = result.user_id;
  if (key === TABLES[6]) { result.task_id = id(1); result.task_version = n; result.id = `${result.task_id}:${String(n).padStart(10, '0')}:${result.period_key}`; }
  return result;
}
const line = (key, n = 1) => JSON.stringify(row(key, n)).replace(/"(threshold_value|actual_value|last_metric|reward_amount)":0/g, `"$1":${PRECISE}`) + '\n';
const lines = (key, n) => Array.from({ length: n }, (_, i) => line(key, i + 1)).join('');
const page = (key, ndjson, next_after = null) => ({ table_key: key, count: rows(ndjson), ndjson, next_after, sha256: sha(ndjson) });
const verification = () => ({ verified: true, backup_id: BACKUP, plan_hash: PLAN, target_hash: TARGET, media_included: false, full_site_complete: false });
const seal = (sha256, bytes) => ({ success: true, backup_id: BACKUP, sha256, bytes, repeated: false, media_pending: true, full_site_complete: false });
function catalogFor(texts) {
  return { version: 1, scope: 'notification-backup', site_id: SITE, package_id: PACKAGE, date_runs_supported: true,
    tables: TABLES.map(key => ({ key, rows: rows(texts[key]), bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: rowHash(texts[key]) })),
    media_included: false, full_site_complete: false };
}
async function* fragments(bytes, size = 4093) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}
async function collect(source) { const chunks = []; for await (const chunk of source) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function soon(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cancellation stalled')), 2000); })]); }
  finally { clearTimeout(timer); }
}
function sanitized(error) {
  const visible = `${error.name}\n${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  for (const value of [SECRET, PASSPHRASE, WRONG]) assert.equal(visible.includes(value), false);
  assert.equal('cause' in error, false); return true;
}
function fixture({ empty = false, texts: changes = {}, fragmentSize = 4093 } = {}) {
  const texts = { ...Object.fromEntries(TABLES.map(key => [key, empty ? '' : line(key)])), ...changes }, catalog = catalogFor(texts);
  const calls = { catalog: 0, pages: [], verify: 0, append: [], abort: 0, save: 0, reads: [], reread: 0, upload: [], seal: [],
    apply: 0, close: 0, cancel: 0, delete: 0 };
  const f = { texts, catalog, descriptor: { backup_id: BACKUP, plan_hash: PLAN, target_hash: TARGET, catalog: structuredClone(catalog) },
    calls, stored: new Map(), invalidated: false, events: [], progress: [] };
  f.source = {
    async catalog(signal) { assert.ok(signal instanceof AbortSignal); calls.catalog++; return f.catalog; },
    async page(key, after, signal) {
      assert.equal(signal.aborted, false); calls.pages.push({ key, after });
      const all = texts[key].match(/[^\n]*\n/g) ?? [];
      let index = after === null ? 0 : all.findIndex(raw => JSON.parse(raw).id === after) + 1;
      if (after !== null) assert.ok(index > 0);
      const output = []; let bytes = 0;
      while (index < all.length && output.length < 200 && bytes + Buffer.byteLength(all[index]) <= 262144) {
        bytes += Buffer.byteLength(all[index]); output.push(all[index++]);
      }
      return page(key, output.join(''), index < all.length ? JSON.parse(output.at(-1)).id : null);
    },
    async verify(signal) { assert.equal(signal.aborted, false); calls.verify++; f.events.push('source-verified'); return verification(); },
  };
  f.temporary = {
    async append(path, bytes, signal) {
      assert.equal(f.invalidated, false); assert.equal(signal.aborted, false); keyFor(path);
      calls.append.push({ path, bytes: bytes.length });
      f.stored.set(path, Buffer.concat([f.stored.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)]));
    },
    open(path) {
      assert.equal(f.invalidated, false); const key = keyFor(path), pass = calls.reads.filter(read => read.key === key).length + 1;
      calls.reads.push({ key, pass }); const body = f.stored.get(path); assert.ok(body);
      return fragments(body, fragmentSize);
    },
    async abort(reason) { assert.equal(String(reason).includes(SECRET), false); calls.abort++; f.invalidated = true; f.stored.clear(); f.events.push('plaintext-deleted'); },
  };
  f.file = {
    async write(source, signal) { assert.equal(signal.aborted, false); calls.save++; f.saved = await collect(source); f.events.push('cipher-saved'); },
    open() {
      assert.equal(f.invalidated, true); const pass = ++calls.reread;
      return { async *[Symbol.asyncIterator]() { yield* fragments(f.saved); f.events.push(`cipher-eof:${pass}`); } };
    },
    async delete() { calls.delete++; assert.fail('independent ciphertext must not be deleted'); },
  };
  f.receiver = {
    async append(chunkNo, hex, signal) {
      assert.equal(signal.aborted, false); assert.ok(f.events.includes('cipher-eof:1'));
      assert.match(hex, /^(?:[0-9a-f]{2})+$/);
      const bytes = Buffer.from(hex, 'hex'); calls.upload.push({ chunkNo, bytes });
      return { success: true, bytes: bytes.length, sha256: sha(bytes), repeated: false };
    },
    async seal(sha256, bytes, signal) {
      assert.equal(signal.aborted, false); assert.ok(f.events.includes('cipher-eof:2'));
      calls.seal.push({ sha256, bytes }); return seal(sha256, bytes);
    },
    async apply() { calls.apply++; assert.fail('business apply forbidden'); },
    async close() { calls.close++; assert.fail('automatic close forbidden'); },
    async cancel() { calls.cancel++; assert.fail('automatic cancel forbidden'); },
  };
  return f;
}
const run = (f, options = {}, password = PASSPHRASE) => api.createNotificationsBackup(f.descriptor, f.source, f.temporary,
  f.file, f.receiver, password, { onProgress: p => f.progress.push(p), ...options });
function noAutomaticWrites(f) { for (const key of ['apply', 'close', 'cancel', 'delete']) assert.equal(f.calls[key], 0); }
async function rejected(f, expected = {}, options = {}) {
  await assert.rejects(run(f, options), error => { assert.equal(error.name, 'NotificationsBackupError');
    for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value, key); return sanitized(error); });
  assert.equal(f.calls.abort, 1); noAutomaticWrites(f);
}
async function encrypted(f, { entries = values => values, identity = {}, password = PASSPHRASE } = {}) {
  const info = { scope: 'replacement-backup', exportId: BACKUP, volumeId: BACKUP, sourceSiteId: SITE,
    volumeIndex: 1, volumeCount: 1, createdAt: '2026-10-19T01:02:03.000Z', ...identity };
  async function* input() {
    for (const entry of entries(TABLES.map(key => ({ path: pathFor(key), body: Buffer.from(f.texts[key]) })))) {
      yield { path: entry.path, bytes: entry.body.length, open: () => fragments(entry.body) };
    }
  }
  return collect(api.writeEncryptedVolume(input(), info, password));
}
async function recover(bytes, password = PASSPHRASE) {
  const files = new Map();
  const manifest = await api.verifyEncryptedVolume(fragments(bytes), password, {
    async append(path, chunk) { files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), Buffer.from(chunk)])); },
    async abort() { files.clear(); },
  }, { expectedMetadata: { exportId: BACKUP, volumeId: BACKUP }, limits: api.NOTIFICATIONS_BACKUP_CONTAINER_LIMITS });
  return { manifest, files };
}
function sizedLine(key, n, bytes) {
  const r = row(key, n); r.description = '';
  r.description = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(r) + '\n'));
  const text = JSON.stringify(r) + '\n'; assert.equal(Buffer.byteLength(text), bytes); return text;
}
function diskSource(path, onEof = () => {}) {
  return { async *[Symbol.asyncIterator]() {
    const file = await open(path, 'r'), buffer = Buffer.alloc(65521);
    try {
      while (true) { const { bytesRead } = await file.read(buffer); if (!bytesRead) { onEof(); return; } yield buffer.subarray(0, bytesRead); }
    } finally { await file.close(); }
  } };
}

test('fixed bounds and local-only dependencies, no runtime replacement backup or API', () => {
  assert.equal(api.MAX_NOTIFICATIONS_BACKUP_PLAINTEXT_BYTES, 8388608); assert.equal(api.MAX_NOTIFICATIONS_BACKUP_BYTES, 9437184);
  assert.equal(api.NOTIFICATIONS_BACKUP_CHUNK_BYTES, 131072);
  assert.deepEqual(api.NOTIFICATIONS_BACKUP_CONTAINER_LIMITS, { maxEntries: 13, maxEntryBytes: 8388608,
    maxTotalBytes: 8388608, maxZipBytes: 9437184, maxManifestBytes: 16384, maxLineBytes: 65536 });
  const inputs = Object.keys(compiled.metafile.inputs);
  assert.equal(inputs.some(path => /(?:supabase|auth|Api|replacementBackup)\.ts$/.test(path)), false);
});
test('catalog/descriptor copies are detached and do not embed business identity or finance catalogs', () => {
  const f = fixture(), copy = api.validateNotificationsBackupDescriptor(f.descriptor);
  assert.deepEqual(copy, f.descriptor); copy.catalog.tables[0].rows++;
  assert.equal(f.descriptor.catalog.tables[0].rows, 1);
  assert.equal('identity_catalog' in copy.catalog, false); assert.equal('finance_catalog' in copy.catalog, false);
});
for (const [label, change] of [
  ['scope', c => { c.scope = 'site-notifications'; }], ['version', c => { c.version = 2; }],
  ['site UUID', c => { c.site_id += '\n'; }], ['package UUID', c => { c.package_id = OTHER + '\n'; }],
  ['media', c => { c.media_included = true; }], ['full site', c => { c.full_site_complete = true; }],
  ['date flag', c => { c.date_runs_supported = 0; }], ['unsupported nonempty date runs', c => { c.date_runs_supported = false; }],
  ['identity catalog', c => { c.identity_catalog = {}; }], ['finance catalog', c => { c.finance_catalog = {}; }],
  ['unknown field', c => { c.secret = SECRET; }], ['missing table', c => { c.tables.pop(); }],
  ['extra table', c => { c.tables.push(c.tables[0]); }], ['wrong order', c => { c.tables.reverse(); }],
  ['duplicate table', c => { c.tables[1] = c.tables[0]; }], ['sparse array', c => { delete c.tables[0]; }],
  ['extra array field', c => { c.tables.extra = true; }], ['symbol array field', c => { c.tables[Symbol('x')] = true; }],
  ['rows fraction', c => { c.tables[0].rows = 1.5; }], ['rows maximum', c => { c.tables[0].rows = 500001; }],
  ['negative bytes', c => { c.tables[0].bytes = -1; }], ['missing bytes', c => { delete c.tables[0].bytes; }],
  ['row digest newline', c => { c.tables[0].row_hashes_sha256 += '\n'; }], ['row digest case', c => { c.tables[0].row_hashes_sha256 = 'A'.repeat(64); }],
  ['zero rows/nonzero bytes', c => { c.tables[0].rows = 0; }], ['nonzero rows/zero bytes', c => { c.tables[0].bytes = 0; }],
  ['table unknown field', c => { c.tables[0].secret = SECRET; }], ['array subclass', c => { Object.setPrototypeOf(c.tables, Object.create(Array.prototype)); }],
]) test(`catalog rejects ${label}`, () => { const f = fixture(); change(f.catalog); assert.throws(() => api.validateNotificationsBackupCatalog(f.catalog), sanitized); });
for (const field of ['backup_id', 'plan_hash', 'target_hash', 'catalog']) test(`descriptor requires ${field}`, () => {
  const f = fixture(); delete f.descriptor[field]; assert.throws(() => api.validateNotificationsBackupDescriptor(f.descriptor), sanitized);
});
for (const [field, values] of [['backup_id', ['', OTHER + '\n', null, 1]], ['plan_hash', ['', 'a'.repeat(64) + '\n', 'A'.repeat(64), null]],
  ['target_hash', ['', 'a'.repeat(63), 'b'.repeat(64) + '\n', {}]]]) for (const value of values) test(`descriptor rejects ${field} ${JSON.stringify(value)}`, () => {
  const f = fixture(); f.descriptor[field] = value; assert.throws(() => api.validateNotificationsBackupDescriptor(f.descriptor), sanitized);
});
for (const location of ['descriptor', 'catalog', 'array', 'table']) for (const kind of ['getter', 'hidden', 'symbol', 'inherited', 'proxy']) {
  test(`${location} rejects ${kind} without invoking accessors or leaking proxy errors`, () => {
    const f = fixture(); let reads = 0;
    let value = location === 'descriptor' ? f.descriptor : location === 'catalog' ? f.catalog : location === 'array' ? f.catalog.tables : f.catalog.tables[0];
    const key = location === 'array' ? '0' : Object.keys(value)[0];
    if (kind === 'getter') Object.defineProperty(value, key, { enumerable: true, get() { reads++; throw Error(SECRET); } });
    if (kind === 'hidden') Object.defineProperty(value, key, { enumerable: false });
    if (kind === 'symbol') value[Symbol('x')] = true;
    if (kind === 'inherited') Object.setPrototypeOf(value, { secret: SECRET });
    if (kind === 'proxy') value = new Proxy(value, { ownKeys() { throw Error(SECRET); } });
    if (location === 'array') f.catalog.tables = value;
    if (location === 'table') f.catalog.tables[0] = value;
    assert.throws(() => location === 'descriptor' ? api.validateNotificationsBackupDescriptor(value)
      : api.validateNotificationsBackupCatalog(location === 'catalog' ? value : f.catalog), sanitized);
    assert.equal(reads, 0);
  });
}
test('empty row digest must be SHA256 of empty bytes, including unsupported date runs', () => {
  const f = fixture({ empty: true }); f.catalog.date_runs_supported = false;
  assert.deepEqual(api.validateNotificationsBackupCatalog(f.catalog), f.catalog);
  f.catalog.tables[6].row_hashes_sha256 = sha('not empty'); assert.throws(() => api.validateNotificationsBackupCatalog(f.catalog));
});
test('aggregate 8MiB bound is enforced before source access, without truncation', async () => {
  const f = fixture({ empty: true });
  f.descriptor.catalog.tables[0] = { key: TABLES[0], rows: 128, bytes: 8388608, row_hashes_sha256: sha('bounded') };
  assert.equal(api.validateNotificationsBackupDescriptor(f.descriptor).catalog.tables[0].bytes, 8388608);
  f.descriptor.catalog.tables[1] = { key: TABLES[1], rows: 1, bytes: 1, row_hashes_sha256: sha('overflow') };
  assert.throws(() => api.validateNotificationsBackupCatalog(f.descriptor.catalog), { name: 'NotificationsBackupLimitError', kind: 'plaintext' });
  await rejected(f, { phase: 'snapshot', limitExceeded: true, serverChunksMayExist: false });
  assert.equal(f.calls.catalog, 0); assert.equal(f.calls.save, 0);
});
test('real independent .edx survives plaintext removal and preserves all raw precision, NULL, bigint and media URLs', async () => {
  const texts = Object.fromEntries(TABLES.map(key => [key, lines(key, 203)]));
  const r = row(TABLES[11]); r.image_url = 'https://example.invalid/media-not-included.png';
  texts[TABLES[11]] = JSON.stringify(r) + '\n';
  const f = fixture({ texts });
  const directory = await mkdtemp(join(tmpdir(), 'notifications-backup-')); directories.push(directory);
  const cipherPath = join(directory, 'independent.edx'), paths = TABLES.map(key => join(directory, `${key}.ndjson`));
  f.temporary = {
    async append(path, bytes) { const file = await open(paths[TABLES.indexOf(keyFor(path))], 'a'); try { await file.writeFile(bytes); } finally { await file.close(); } },
    open(path) { return diskSource(paths[TABLES.indexOf(keyFor(path))]); },
    async abort() { f.calls.abort++; await Promise.all(paths.map(path => rm(path, { force: true }))); f.events.push('plaintext-deleted'); },
  };
  f.file = {
    async write(source) {
      f.calls.save++; const file = await open(cipherPath, 'wx');
      try { for await (const bytes of source) await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      f.events.push('cipher-saved');
    },
    open() { const pass = ++f.calls.reread; return diskSource(cipherPath, () => f.events.push(`cipher-eof:${pass}`)); },
  };
  const append = f.receiver.append, originalSeal = f.receiver.seal;
  f.receiver.append = async (...args) => ({ ...await append(...args), repeated: true });
  f.receiver.seal = async (...args) => ({ ...await originalSeal(...args), repeated: true });
  const result = await run(f), saved = await readFile(cipherPath), { manifest, files } = await recover(saved);
  for (const path of paths) await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal((await stat(cipherPath)).size, result.bytes); assert.equal(saved.subarray(0, 8).toString(), 'EDXSTRM1');
  assert.equal(manifest.scope, 'replacement-backup'); assert.equal(manifest.exportId, BACKUP); assert.equal(manifest.volumeId, BACKUP);
  assert.equal(manifest.sourceSiteId, SITE); assert.equal(manifest.volumeIndex, 1); assert.equal(manifest.volumeCount, 1);
  assert.deepEqual(manifest.entries.map(e => e.path), TABLES.map(pathFor));
  for (const [index, key] of TABLES.entries()) {
    assert.deepEqual(files.get(pathFor(key)), Buffer.from(texts[key]));
    assert.deepEqual(manifest.entries[index], { path: pathFor(key), kind: 'ndjson', bytes: Buffer.byteLength(texts[key]), sha256: sha(texts[key]) });
  }
  assert.ok(files.get(pathFor(TABLES[1])).includes(Buffer.from(PRECISE)));
  assert.ok(files.get(pathFor(TABLES[5])).includes(Buffer.from('"error_message":null')));
  assert.ok(files.get(pathFor(TABLES[9])).includes(Buffer.from('"delivery_sequence":"9223372036854775807"')));
  assert.ok(files.get(pathFor(TABLES[11])).includes(Buffer.from(r.image_url)));
  for (const key of TABLES.filter(key => key !== TABLES[11])) assert.ok(f.calls.pages.filter(p => p.key === key).length > 1);
  assert.equal(f.calls.save, 1); assert.equal(f.calls.reread, 2); assert.equal(f.calls.abort, 1); assert.equal(f.calls.verify, 1);
  assert.ok(f.events.indexOf('cipher-saved') < f.events.indexOf('plaintext-deleted'));
  assert.ok(f.events.indexOf('plaintext-deleted') < f.events.indexOf('cipher-eof:1'));
  assert.equal(result.cipherSha256, sha(saved)); assert.equal(result.bytes, saved.length); assert.ok(result.chunks > 1);
  assert.deepEqual(Buffer.concat(f.calls.upload.map(c => c.bytes)), saved);
  assert.deepEqual(f.calls.upload.map(c => c.chunkNo), f.calls.upload.map((_, i) => i));
  assert.ok(f.calls.upload.slice(0, -1).every(c => c.bytes.length === 131072));
  assert.deepEqual(result.sealReceipt, { ...seal(sha(saved), saved.length), repeated: true });
  assert.deepEqual(result.descriptor, f.descriptor); assert.equal(result.descriptor.catalog.media_included, false);
  assert.equal(result.sealReceipt.media_pending, true); assert.equal(result.sealReceipt.full_site_complete, false);
  assert.deepEqual([...new Set(f.progress.map(p => p.phase))], ['snapshot', 'save', 'verify', 'upload', 'seal']);
  for (const phase of ['snapshot', 'save', 'verify', 'upload', 'seal']) assert.equal(f.progress.filter(p => p.phase === phase).at(-1).completed, true);
  assert.equal(f.progress.filter(p => p.phase === 'upload').at(-1).bytes, result.bytes); noAutomaticWrites(f);
});
for (const supported of [true, false]) test(`all 13 empty files included when date_runs_supported=${supported}`, async () => {
  const f = fixture({ empty: true }); f.catalog.date_runs_supported = supported; f.descriptor.catalog.date_runs_supported = supported;
  const result = await run(f), { manifest, files } = await recover(f.saved);
  assert.equal(manifest.entries.length, 13); assert.equal(files.size, 13); assert.equal(f.calls.pages.length, 13);
  assert.equal(f.calls.append.length, 13); assert.ok(f.calls.append.every(c => c.bytes === 0));
  assert.ok(manifest.entries.every(e => e.bytes === 0 && e.sha256 === sha(''))); assert.equal(result.sealReceipt.full_site_complete, false);
});
test('real exactly-8MiB plaintext backup is complete and remains under 9MiB ciphertext', async () => {
  const body = Array.from({ length: 128 }, (_, i) => sizedLine(TABLES[0], i + 1, 65536)).join('');
  const f = fixture({ empty: true, texts: { [TABLES[0]]: body } }), result = await run(f);
  assert.equal(Buffer.byteLength(body), 8388608); assert.ok(result.bytes > 8388608 && result.bytes < 9437184);
  assert.equal(f.calls.pages.filter(p => p.key === TABLES[0]).length, 32);
  assert.equal(f.calls.upload.length, Math.ceil(result.bytes / 131072)); assert.equal(result.cipherSha256, sha(f.saved));
  assert.deepEqual(Buffer.concat(f.calls.upload.map(c => c.bytes)), f.saved); noAutomaticWrites(f);
});
for (const key of TABLES) test(`${key} row-summary mismatch blocks before saving`, async () => {
  const f = fixture(); f.catalog.tables.find(t => t.key === key).row_hashes_sha256 = sha('wrong row hash');
  f.descriptor.catalog = structuredClone(f.catalog);
  await rejected(f, { phase: 'snapshot', serverChunksMayExist: false, sealMayHaveSucceeded: false }); assert.equal(f.calls.save, 0);
});
for (const [label, mutate] of [
  ['count', p => { p.count++; }], ['SHA256', p => { p.sha256 = sha('wrong'); }], ['table', p => { p.table_key = TABLES[1]; }],
  ['cursor', p => { p.next_after = OTHER; }], ['extra field', p => { p.secret = SECRET; }],
  ['201 rows', p => Object.assign(p, page(TABLES[0], lines(TABLES[0], 201)))],
  ['over 256KiB', p => Object.assign(p, page(TABLES[0], Array.from({ length: 5 }, (_, i) => sizedLine(TABLES[0], i + 1, 65536)).join('')))],
  ['over 64KiB line', p => Object.assign(p, page(TABLES[0], sizedLine(TABLES[0], 1, 65537)))],
  ['missing LF', p => { p.ndjson = p.ndjson.trimEnd(); p.sha256 = sha(p.ndjson); }],
  ['duplicate JSON key', p => { p.ndjson = p.ndjson.replace('{', `{"id":"${id(1)}",`); p.sha256 = sha(p.ndjson); }],
  ['invalid row type', p => { p.ndjson = p.ndjson.replace('"status":"active"', '"status":null'); p.sha256 = sha(p.ndjson); }],
  ['duplicate cursor', p => Object.assign(p, page(TABLES[0], line(TABLES[0]) + line(TABLES[0])))],
  ['empty continuation', p => Object.assign(p, page(TABLES[0], '', id(1)))],
]) test(`invalid snapshot page ${label} is sanitized before temporary write`, async () => {
  const f = fixture(); f.source.page = async key => { f.calls.pages.push({ key }); const p = page(key, f.texts[key]); mutate(p); return p; };
  await rejected(f, { phase: 'snapshot', serverChunksMayExist: false }); assert.equal(f.calls.append.length, 0); assert.equal(f.calls.save, 0);
});
test('C text ordering is enforced across pages, not locale ordering or repeated cursors', async () => {
  const f = fixture({ texts: { [TABLES[0]]: lines(TABLES[0], 201) } }), original = f.source.page;
  f.source.page = async (key, after, signal) => key === TABLES[0] && after !== null ? page(key, line(key)) : original(key, after, signal);
  await rejected(f, { phase: 'snapshot' }); assert.equal(f.calls.append.length, 1); assert.equal(f.calls.save, 0);
});
for (const field of ['site_id', 'package_id', 'date_runs_supported', 'row_hashes_sha256', 'rows', 'bytes']) test(`source catalog drift ${field} blocks before pages`, async () => {
  const f = fixture();
  if (field === 'site_id' || field === 'package_id') f.catalog[field] = OTHER;
  else if (field === 'date_runs_supported') { f.catalog.tables[6] = { key: TABLES[6], rows: 0, bytes: 0, row_hashes_sha256: sha('') }; f.catalog[field] = false; }
  else f.catalog.tables[0][field] = field === 'row_hashes_sha256' ? sha('drift') : f.catalog.tables[0][field] + 1;
  await rejected(f, { phase: 'snapshot' }); assert.equal(f.calls.pages.length, 0);
});
for (const [label, mutate] of [
  ['verified', r => { r.verified = false; }], ['backup', r => { r.backup_id = OTHER; }], ['plan', r => { r.plan_hash = sha('changed'); }],
  ['target', r => { r.target_hash = sha('changed'); }], ['media', r => { r.media_included = true; }], ['full site', r => { r.full_site_complete = true; }],
  ['missing target', r => { delete r.target_hash; }], ['extra scope', r => { r.scope = 'site-notifications'; }],
]) test(`snapshot verify receipt rejects ${label} before save`, async () => {
  const f = fixture(); f.source.verify = async () => { const r = verification(); mutate(r); return r; };
  await rejected(f, { phase: 'snapshot', serverChunksMayExist: false }); assert.equal(f.calls.save, 0);
});
test('descriptor edits after validation cannot change backup identity, plan or baseline', async () => {
  const f = fixture();
  const result = await run(f, { onProgress(p) { if (p.phase === 'snapshot' && p.bytes === 0) {
    f.descriptor.backup_id = OTHER; f.descriptor.plan_hash = sha('tamper'); f.descriptor.target_hash = sha('tamper');
    f.descriptor.catalog.tables[0].row_hashes_sha256 = sha('tamper');
  } } });
  assert.equal(result.descriptor.backup_id, BACKUP); assert.equal(result.descriptor.plan_hash, PLAN); assert.equal(result.descriptor.target_hash, TARGET);
  assert.equal(result.descriptor.catalog.tables[0].row_hashes_sha256, rowHash(f.texts[TABLES[0]]));
});
for (const field of ['backup_id', 'plan_hash', 'target_hash']) test(`descriptor pre-call ${field} tampering cannot pass bound source verification`, async () => {
  const f = fixture(); f.descriptor[field] = field === 'backup_id' ? OTHER : sha('tamper');
  await rejected(f, { phase: 'snapshot', serverChunksMayExist: false }); assert.equal(f.calls.save, 0);
});
test('valid same-size rewritten temporary plaintext authenticates but cannot pass original row summaries', async () => {
  const f = fixture(), original = f.temporary.open;
  f.temporary.open = path => path === pathFor(TABLES[0]) ? fragments(Buffer.from(f.texts[TABLES[0]].replace('原文', '篡改')), 1) : original(path);
  await rejected(f, { phase: 'verify', serverChunksMayExist: false, sealMayHaveSucceeded: false });
  const { manifest } = await recover(f.saved);
  assert.equal(manifest.entries[0].bytes, f.catalog.tables[0].bytes); assert.notEqual(manifest.entries[0].sha256, sha(f.texts[TABLES[0]]));
  assert.equal(f.calls.upload.length, 0); assert.equal(f.calls.seal.length, 0);
});
test('temporary plaintext changes between ZIP writer passes fail during save', async () => {
  const f = fixture(), original = f.temporary.open;
  f.temporary.open = path => path === pathFor(TABLES[0]) && f.calls.reads.some(r => r.key === TABLES[0])
    ? fragments(Buffer.from(f.texts[TABLES[0]].replace('原文', '篡改'))) : original(path);
  await rejected(f, { phase: 'save', serverChunksMayExist: false }); assert.equal(f.calls.upload.length, 0);
});
for (const [label, change] of [
  ['wrong passphrase', { password: WRONG }], ['scope', { identity: { scope: 'full-site' } }], ['site', { identity: { sourceSiteId: OTHER } }],
  ['export identity', { identity: { exportId: OTHER } }], ['volume identity', { identity: { volumeId: OTHER } }],
  ['multiple volumes', { identity: { volumeCount: 2 } }], ['missing table', { entries: entries => entries.slice(0, -1) }],
  ['extra path', { entries: entries => entries.map((e, i) => i ? e : { ...e, path: 'data/unexpected.ndjson' }) }],
  ['wrong order', { entries: entries => entries.reverse() }],
]) test(`saved second pass rejects authenticated replacement with ${label}`, async () => {
  const f = fixture(), original = f.file.write;
  f.file.write = async (...args) => { await original(...args); f.saved = await encrypted(f, change); };
  await rejected(f, { phase: 'verify', serverChunksMayExist: false }); assert.equal(f.calls.upload.length, 0); assert.equal(f.calls.seal.length, 0);
});
for (const [label, mutate, phase] of [
  ['catalog transport', f => { f.source.catalog = async () => { throw Error(SECRET); }; }, 'snapshot'],
  ['page transport', f => { f.source.page = async () => { throw Error(SECRET); }; }, 'snapshot'],
  ['verify transport', f => { f.source.verify = async () => { throw Error(SECRET); }; }, 'snapshot'],
  ['temporary append', f => { f.temporary.append = async () => { throw Error(SECRET); }; }, 'snapshot'],
  ['temporary open', f => { f.temporary.open = () => { throw Error(SECRET); }; }, 'save'],
  ['early write ack', f => { f.file.write = async () => { f.calls.save++; }; }, 'save'],
  ['file write', f => { f.file.write = async () => { f.calls.save++; throw Error(SECRET); }; }, 'save'],
  ['saved corruption', f => { const write = f.file.write; f.file.write = async (...args) => { await write(...args); f.saved[f.saved.length - 1] ^= 1; }; }, 'verify'],
  ['saved truncation', f => { const write = f.file.write; f.file.write = async (...args) => { await write(...args); f.saved = f.saved.subarray(0, -1); }; }, 'verify'],
  ['saved trailing bytes', f => { const write = f.file.write; f.file.write = async (...args) => { await write(...args); f.saved = Buffer.concat([f.saved, Buffer.from([0])]); }; }, 'verify'],
  ['independent file open', f => { f.file.open = () => { throw Error(SECRET); }; }, 'verify'],
  ['third pass corruption', f => { const read = f.file.open; f.file.open = () => { if (f.calls.reread === 1) f.saved[0] ^= 1; return read(); }; }, 'upload'],
  ['third pass truncation', f => { const read = f.file.open; f.file.open = () => { if (f.calls.reread === 1) f.saved = f.saved.subarray(0, -1); return read(); }; }, 'upload'],
  ['third pass empty', f => { const read = f.file.open; f.file.open = () => { if (f.calls.reread === 1) f.saved = Buffer.alloc(0); return read(); }; }, 'upload'],
  ['upload transport', f => { f.receiver.append = async () => { throw Error(SECRET); }; }, 'upload'],
  ['seal transport', f => { f.receiver.seal = async () => { f.calls.seal.push({}); throw Error(SECRET); }; }, 'seal'],
]) test(`${label} failure is sanitized and never automatically retried`, async () => {
  const f = fixture(); mutate(f);
  await rejected(f, { phase, cancelled: false, cleanupRequired: false,
    serverChunksMayExist: label === 'third pass empty' ? false : ['upload', 'seal'].includes(phase), sealMayHaveSucceeded: phase === 'seal' });
  assert.ok(f.calls.save <= 1); if (phase !== 'seal') assert.equal(f.calls.seal.length, 0);
  if (['snapshot', 'save', 'verify'].includes(phase)) assert.equal(f.calls.upload.length, 0);
});
for (const [label, mutate] of [
  ['success', r => { r.success = false; }], ['bytes', r => { r.bytes++; }], ['hash', r => { r.sha256 = sha('bad'); }],
  ['repeated', r => { r.repeated = 1; }], ['missing field', r => { delete r.sha256; }], ['extra field', r => { r.secret = SECRET; }],
  ['getter', r => { Object.defineProperty(r, 'sha256', { enumerable: true, get() { throw Error(SECRET); } }); }],
]) test(`upload receipt ${label} mismatch never credits progress or seals`, async () => {
  const f = fixture(), append = f.receiver.append; f.receiver.append = async (...args) => { const r = await append(...args); mutate(r); return r; };
  await rejected(f, { phase: 'upload', serverChunksMayExist: true, sealMayHaveSucceeded: false });
  assert.equal(f.calls.upload.length, 1); assert.equal(f.calls.seal.length, 0);
  assert.deepEqual(f.progress.filter(p => p.phase === 'upload'), [{ phase: 'upload', bytes: 0, completed: false }]);
});
for (const [label, mutate] of [
  ['success', r => { r.success = false; }], ['backup id', r => { r.backup_id = OTHER; }], ['bytes', r => { r.bytes++; }],
  ['hash', r => { r.sha256 = sha('bad'); }], ['repeated', r => { r.repeated = 'true'; }], ['full site', r => { r.full_site_complete = true; }],
  ['media pending', r => { r.media_pending = false; }], ['missing media pending', r => { delete r.media_pending; }], ['extra field', r => { r.secret = SECRET; }],
]) test(`seal receipt ${label} mismatch remains uncertain and does not claim completion`, async () => {
  const f = fixture(), original = f.receiver.seal; f.receiver.seal = async (...args) => { const r = await original(...args); mutate(r); return r; };
  await rejected(f, { phase: 'seal', serverChunksMayExist: true, sealMayHaveSucceeded: true });
  assert.equal(f.calls.seal.length, 1); assert.equal(f.progress.some(p => p.phase === 'seal' && p.completed), false);
});
for (const phase of ['snapshot', 'save', 'verify', 'upload', 'seal']) test(`observer failure during ${phase} stops before phase side effects`, async () => {
  const f = fixture();
  await rejected(f, { phase, serverChunksMayExist: phase === 'seal', sealMayHaveSucceeded: false }, { onProgress(p) { if (p.phase === phase) throw Error(SECRET); } });
  assert.equal(f.calls.upload.length > 0, phase === 'seal'); assert.equal(f.calls.seal.length, 0);
});
for (const phase of ['snapshot', 'save', 'verify', 'upload']) test(`completed ${phase} observer failure keeps acknowledged side-effect uncertainty`, async () => {
  const f = fixture();
  await rejected(f, { phase, serverChunksMayExist: phase === 'upload', sealMayHaveSucceeded: false },
    { onProgress(p) { if (p.phase === phase && p.completed) throw Error(SECRET); } });
  assert.equal(f.calls.seal.length, 0);
});
for (const terminal of ['throw', 'abort']) test(`terminal seal observer ${terminal} cannot revoke acknowledged success`, async () => {
  const f = fixture(), controller = new AbortController();
  const result = await run(f, { signal: controller.signal, onProgress(p) { if (p.phase === 'seal' && p.completed) {
    if (terminal === 'throw') throw Error(SECRET); controller.abort();
  } } });
  assert.equal(result.sealReceipt.success, true); assert.equal(f.calls.seal.length, 1); assert.equal(f.calls.abort, 1);
});
for (const phase of ['snapshot', 'save', 'verify', 'upload', 'seal']) test(`cancel from ${phase} observer stops before side effects`, async () => {
  const f = fixture(), controller = new AbortController();
  await rejected(f, { phase, cancelled: true, serverChunksMayExist: phase === 'seal', sealMayHaveSucceeded: false },
    { signal: controller.signal, onProgress(p) { if (p.phase === phase) controller.abort(SECRET); } });
  assert.equal(f.calls.upload.length > 0, phase === 'seal'); assert.equal(f.calls.seal.length, 0);
});
for (const operation of ['catalog', 'page', 'verify', 'temporary-append', 'save', 'append', 'seal']) {
  for (const late of ['resolve', 'reject']) test(`cancel pending ${operation} ignores late ${late}, cleanup runs once`, async () => {
    const f = fixture(), controller = new AbortController(), entered = deferred(), blocked = deferred(); let pendingSignal;
    const stalled = signal => { pendingSignal = signal; entered.resolve(); return blocked.promise; };
    if (operation === 'catalog' || operation === 'verify') f.source[operation] = signal => stalled(signal);
    else if (operation === 'page') f.source.page = (_key, _after, signal) => stalled(signal);
    else if (operation === 'temporary-append') f.temporary.append = async (path, bytes, signal) => {
      await stalled(signal); if (!f.invalidated) f.stored.set(path, Buffer.from(bytes));
    };
    else if (operation === 'save') f.file.write = (_source, signal) => { f.calls.save++; return stalled(signal); };
    else f.receiver[operation] = (...args) => stalled(args.at(-1));
    const pending = run(f, { signal: controller.signal }); await soon(entered.promise); controller.abort(SECRET);
    const phase = ['catalog', 'page', 'verify', 'temporary-append'].includes(operation) ? 'snapshot' : operation === 'append' ? 'upload' : operation;
    await assert.rejects(soon(pending), error => {
      assert.equal(error.phase, phase); assert.equal(error.cancelled, true); assert.equal(error.serverChunksMayExist, ['append', 'seal'].includes(operation));
      assert.equal(error.sealMayHaveSucceeded, operation === 'seal'); return sanitized(error);
    });
    assert.equal(pendingSignal.aborted, true); assert.equal(f.calls.abort, 1); assert.equal(f.stored.size, 0);
    const calls = structuredClone(f.calls), progress = structuredClone(f.progress);
    if (late === 'reject') blocked.reject(Error(SECRET)); else blocked.resolve(verification());
    await nextTurn(); assert.equal(f.stored.size, 0); assert.deepEqual(structuredClone(f.calls), calls); assert.deepEqual(f.progress, progress); noAutomaticWrites(f);
  });
}
for (const phase of ['verify', 'upload']) test(`cancel blocked ${phase} file read closes iterator without awaiting a blocked return`, async () => {
  const f = fixture(), controller = new AbortController(), entered = deferred(), blocked = deferred(), read = f.file.open;
  let returns = 0;
  f.file.open = () => {
    if (phase === 'upload' && f.calls.reread === 0) return read();
    f.calls.reread++;
    return { [Symbol.asyncIterator]() { return this; }, next() { entered.resolve(); return blocked.promise; },
      return() { returns++; return new Promise(() => {}); } };
  };
  const pending = run(f, { signal: controller.signal }); await soon(entered.promise); controller.abort();
  await assert.rejects(soon(pending), error => { assert.equal(error.phase, phase); assert.equal(error.cancelled, true);
    assert.equal(error.serverChunksMayExist, false); return sanitized(error); });
  blocked.reject(Error(SECRET)); await nextTurn(); assert.equal(returns, 1); assert.equal(f.calls.abort, 1); assert.equal(f.calls.upload.length, 0);
});
test('pre-abort skips all source/save/upload calls but invalidates plaintext', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(SECRET);
  await rejected(f, { phase: 'snapshot', cancelled: true, serverChunksMayExist: false }, { signal: controller.signal });
  assert.equal(f.calls.catalog, 0); assert.equal(f.calls.save, 0); assert.equal(f.calls.upload.length, 0);
});
for (const during of ['snapshot-failure', 'after-save', 'cancellation']) test(`cleanup failure during ${during} is explicit and not retried`, async () => {
  const f = fixture(), controller = new AbortController();
  f.temporary.abort = async () => { f.calls.abort++; throw Error(SECRET); };
  if (during === 'snapshot-failure') f.source.catalog = async () => { throw Error(SECRET); };
  if (during === 'cancellation') controller.abort();
  await rejected(f, { phase: during === 'after-save' ? 'save' : 'snapshot', cleanupRequired: true,
    cancelled: during === 'cancellation', serverChunksMayExist: false }, { signal: controller.signal });
  assert.equal(f.calls.upload.length, 0); assert.equal(f.calls.seal.length, 0);
});
test('cancellation during asynchronous plaintext cleanup waits for confirmed cleanup and blocks reread', async () => {
  const f = fixture(), controller = new AbortController(), entered = deferred(), blocked = deferred(), original = f.temporary.abort;
  f.temporary.abort = async reason => { entered.resolve(); await blocked.promise; await original(reason); };
  const pending = run(f, { signal: controller.signal }); await soon(entered.promise); controller.abort(); blocked.resolve();
  await assert.rejects(soon(pending), error => { assert.equal(error.cancelled, true); assert.equal(error.cleanupRequired, false);
    assert.equal(error.phase, 'save'); return sanitized(error); });
  assert.ok(f.saved.length > 0); assert.equal(f.calls.abort, 1); assert.equal(f.calls.reread, 0); noAutomaticWrites(f);
});
test('snapshot backpressure counts bytes only after temporary append acknowledgment', async () => {
  const f = fixture(), entered = deferred(), blocked = deferred(), original = f.temporary.append;
  f.temporary.append = async (...args) => { entered.resolve(); await blocked.promise; return original(...args); };
  const pending = run(f); await entered.promise;
  assert.equal(f.calls.pages.length, 1); assert.deepEqual(f.progress, [{ phase: 'snapshot', bytes: 0, completed: false }]);
  blocked.resolve(); await pending; assert.equal(f.progress[1].bytes, Buffer.byteLength(f.texts[TABLES[0]]));
});
test('upload backpressure prevents next read and credits only acknowledged 128KiB chunks', async () => {
  const f = fixture({ texts: { [TABLES[0]]: lines(TABLES[0], 1800) } }), entered = deferred(), blocked = deferred();
  const read = f.file.open, append = f.receiver.append; let pulls = 0;
  f.file.open = () => {
    if (f.calls.reread === 0) return read();
    f.calls.reread++;
    return { async *[Symbol.asyncIterator]() { for await (const chunk of fragments(f.saved, 131072)) { pulls++; yield chunk; } f.events.push('cipher-eof:2'); } };
  };
  f.receiver.append = async (...args) => { const r = await append(...args); if (f.calls.upload.length === 1) { entered.resolve(); await blocked.promise; } return r; };
  const pending = run(f); await entered.promise;
  assert.equal(pulls, 1); assert.equal(f.calls.upload.length, 1); assert.equal(f.calls.seal.length, 0);
  assert.deepEqual(f.progress.filter(p => p.phase === 'upload'), [{ phase: 'upload', bytes: 0, completed: false }]);
  blocked.resolve(); const result = await pending;
  assert.equal(f.progress.filter(p => p.phase === 'upload')[1].bytes, 131072); assert.equal(result.bytes, f.saved.length);
});
for (const phase of ['verify', 'upload']) for (const bad of ['over 1MiB', 'wrong type']) test(`${phase} rejects ${bad} input fragments`, async () => {
  const f = fixture(), read = f.file.open;
  f.file.open = () => {
    if (phase === 'upload' && f.calls.reread === 0) return read(); f.calls.reread++;
    return { async *[Symbol.asyncIterator]() { yield bad === 'over 1MiB' ? new Uint8Array(1048577) : 'private-string'; } };
  };
  await rejected(f, { phase, serverChunksMayExist: false }); assert.equal(f.calls.seal.length, 0);
});
test('third read exceeding 9MiB reports partial upload uncertainty and never seals', async () => {
  const f = fixture(), read = f.file.open;
  f.file.open = () => {
    if (f.calls.reread === 0) return read(); f.calls.reread++;
    return { async *[Symbol.asyncIterator]() { yield* fragments(f.saved); yield* fragments(Buffer.alloc(9437185 - f.saved.length), 1048576); } };
  };
  f.receiver.append = async (chunkNo, hex) => { const bytes = Buffer.from(hex, 'hex'); f.calls.upload.push({ chunkNo, length: bytes.length });
    return { success: true, bytes: bytes.length, sha256: sha(bytes), repeated: false }; };
  await rejected(f, { phase: 'upload', limitExceeded: true, serverChunksMayExist: true, sealMayHaveSucceeded: false });
  assert.ok(f.calls.upload.length > 0); assert.equal(f.calls.seal.length, 0);
});
