import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const output = await build({ entryPoints: ['src/lib/employeeTransfer/dispatchTransfer.ts'],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020' });
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const hash = value => createHash('sha256').update(value).digest('hex');
const SITE = '11111111-1111-4111-8111-111111111111';
const id = n => `20000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
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
function fixture({ empty = false, lineChange } = {}) {
  const texts = Object.fromEntries(api.DISPATCH_TABLE_KEYS.map(key => {
    const record = Object.fromEntries(fields[key].map(field => [field, field === 'id' ? id(1) : null]));
    if (key === 'dispatch_group_orders') record.order_content = '來源原文 𠮷 é é';
    if (key === 'dispatch_groups') { record.is_default = true; record.commission_rate = 0.12345678; }
    if (key === 'dispatch_order_pools') { record.is_base = true; record.pool_name = '來源默認池'; }
    let text = empty ? '' : JSON.stringify(record) + '\n';
    if (lineChange) text = lineChange(text, key);
    return [key, text];
  }));
  const catalog = { version: 1, scope: 'dispatch-submission', site_id: SITE,
    tables: api.DISPATCH_TABLE_KEYS.map(key => ({ key, rows: texts[key].split('\n').length - 1,
      bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: hash(texts[key].match(/[^\n]*\n/g)?.map(line => hash(line)).join('') ?? '') })),
    processing_orders: 2, full_site_complete: false };
  const stored = new Map(), progress = [], calls = { pages: 0, aborts: 0, writes: 0, verify: 0 };
  const value = { texts, catalog, stored, progress, calls };
  value.source = {
    async catalog() { return value.catalog; },
    async page(key, after) {
      calls.pages++; assert.equal(after, null);
      const ndjson = texts[key];
      return { table_key: key, count: ndjson.split('\n').length - 1, ndjson, next_after: null, sha256: hash(ndjson) };
    },
    async verify() { calls.verify++; return { verified: true, scope: 'dispatch-submission', full_site_complete: false }; },
  };
  value.sink = {
    async append(path, bytes) { calls.writes++; stored.set(path, Buffer.from(bytes)); },
    async abort() { calls.aborts++; stored.clear(); },
  };
  return value;
}
const run = (v, options = {}) => api.exportDispatchData(v.source, v.sink, {
  onProgress(p) { v.progress.push(p); }, ...options,
});

test('seven source tables retain raw bytes, separate page/row hashes and final manifest hashes', async () => {
  const value = fixture(); const result = await run(value);
  assert.equal(value.calls.aborts, 0); assert.equal(value.calls.verify, 1);
  assert.equal(result.fullSiteComplete, false); assert.equal(result.catalog.processing_orders, 2);
  assert.equal(result.rows, 7); assert.equal(value.progress.length, 7);
  for (const [index, entry] of result.entries.entries()) {
    assert.equal(entry.kind, 'ndjson'); assert.equal(entry.sha256, hash(value.texts[api.DISPATCH_TABLE_KEYS[index]]));
    assert.equal(value.stored.get(entry.path).toString(), value.texts[api.DISPATCH_TABLE_KEYS[index]]);
  }
  assert.equal(value.progress.at(-1).bytes, result.bytes);
});
test('empty tables have explicit zero-byte files and empty SHA-256 fingerprints', async () => {
  const value = fixture({ empty: true }); const result = await run(value);
  assert.equal(result.rows, 0); assert.equal(result.bytes, 0); assert.equal(value.stored.size, 7);
  assert.ok(result.entries.every(entry => entry.sha256 === hash('')));
});
test('do not parse and reserialize numeric data with more precision than JavaScript supports', async () => {
  const value = fixture({ lineChange: (text, key) => key === 'valid_order_data'
    ? text.replace('"product_value":null', '"product_value":12345678901234567890.123456789') : text });
  const result = await run(value);
  assert.match(value.stored.get('data/dispatch-valid_order_data.ndjson').toString(), /12345678901234567890\.123456789/);
  assert.equal(result.entries.find(entry => entry.path.includes('valid_order_data')).sha256, hash(value.texts.valid_order_data));
});

for (const [label, change] of [
  ['wrong scope', v => { v.scope = 'shared-settings'; }],
  ['wrong version', v => { v.version = 2; }],
  ['wrong site', v => { v.site_id = 'bad'; }],
  ['false full success', v => { v.full_site_complete = true; }],
  ['unknown header', v => { v.secret = 'never export'; }],
  ['missing table', v => { v.tables.pop(); }],
  ['duplicate table', v => { v.tables[1] = v.tables[0]; }],
  ['reordered table', v => { v.tables.reverse(); }],
  ['extra table column', v => { v.tables[0].sha256 = hash(''); }],
  ['fractional count', v => { v.tables[0].rows = 0.5; }],
  ['row limit', v => { v.tables[0].rows = 500001; }],
  ['byte limit', v => { v.tables[0].bytes = 268435457; }],
  ['global byte limit', v => { v.tables.forEach(t => { t.bytes = 268435456; }); }],
  ['hash format', v => { v.tables[0].row_hashes_sha256 = 'invalid'; }],
  ['negative processing count', v => { v.processing_orders = -1; }],
  ['unsafe processing count', v => { v.processing_orders = Number.MAX_SAFE_INTEGER + 1; }],
  ['empty count with content', v => { v.tables[0].rows = 0; }],
]) test(`reject catalog ${label} before reading or writing any rows`, async () => {
  const value = fixture(); change(value.catalog);
  await assert.rejects(run(value)); assert.equal(value.calls.pages, 0); assert.equal(value.calls.aborts, 1);
});

for (const [label, change] of [
  ['wrong table', p => { p.table_key = 'admins'; }],
  ['extra field', p => { p.extra = 'not allowed'; }],
  ['page hash', p => { p.sha256 = hash('bad'); }],
  ['page count', p => { p.count++; }],
  ['row count limit', p => { p.count = 201; }],
  ['unknown cursor', p => { p.next_after = 'bad'; }],
  ['cursor not last row', p => { p.next_after = id(2); }],
  ['empty advancing page', p => { p.ndjson = ''; p.count = 0; p.sha256 = hash(''); p.next_after = id(1); }],
  ['missing LF', p => { p.ndjson = p.ndjson.trimEnd(); p.sha256 = hash(p.ndjson); }],
  ['unpaired Unicode', p => { p.ndjson += '\ud800'; }],
  ['page allocation limit', p => { p.ndjson = 'x'.repeat(262145); }],
]) test(`reject page ${label}, abort plaintext and do not advance progress`, async () => {
  const value = fixture(), page = value.source.page;
  value.source.page = async (...args) => { const result = await page(...args); change(result); return result; };
  await assert.rejects(run(value)); assert.equal(value.progress.length, 0);
  assert.equal(value.calls.aborts, 1); assert.equal(value.calls.verify, 0);
});

for (const key of api.DISPATCH_TABLE_KEYS) test(`reject unknown/missing row columns for ${key}`, async () => {
  for (const mutation of [row => { row.extra = 'not reviewed'; }, row => { delete row.id; }]) {
    const value = fixture({ lineChange(text, table) {
      if (table !== key) return text;
      const row = JSON.parse(text); mutation(row); return JSON.stringify(row) + '\n';
    } });
    await assert.rejects(run(value)); assert.equal(value.calls.aborts, 1);
  }
});

test('reject escaped duplicate keys despite JSON.parse accepting the last value', async () => {
  const value = fixture({ lineChange: (text, key) => key === 'dispatch_config'
    ? text.replace('"id":', `"\\u0069d":"${id(2)}","id":`) : text });
  await assert.rejects(run(value)); assert.equal(value.calls.writes, 0);
});
test('64KiB line limit includes LF and is measured in UTF-8 bytes', async () => {
  for (const bytes of [65536, 65537]) {
    const value = fixture({ empty: true, lineChange(text, key) {
      if (key !== 'dispatch_config') return text;
      const row = Object.fromEntries(fields[key].map(field => [field, field === 'id' ? id(1) : field === 'description' ? '' : null]));
      const base = JSON.stringify(row) + '\n';
      return base.replace('"description":""', `"description":"${'x'.repeat(bytes - Buffer.byteLength(base))}"`);
    } });
    if (bytes === 65536) await run(value); else await assert.rejects(run(value));
  }
});
test('same count and length but altered row content fails the catalog fingerprint', async () => {
  const value = fixture(); value.catalog.tables[0].row_hashes_sha256 = hash('different');
  await assert.rejects(run(value)); assert.equal(value.calls.verify, 0); assert.equal(value.stored.size, 0);
});
test('server verification failure discards all previously written plaintext', async () => {
  const value = fixture(); value.source.verify = async () => { throw new Error('sensitive source details'); };
  await assert.rejects(run(value), error => !error.message.includes('sensitive'));
  assert.equal(value.stored.size, 0); assert.equal(value.calls.aborts, 1);
});
test('verification cannot claim full-site success', async () => {
  const value = fixture(); value.source.verify = async () => ({ verified: true, scope: 'dispatch-submission', full_site_complete: true });
  await assert.rejects(run(value)); assert.equal(value.calls.aborts, 1);
});
test('sink failure never credits the unconfirmed page', async () => {
  const value = fixture(); value.sink.append = async () => { throw new Error('disk full'); };
  await assert.rejects(run(value)); assert.equal(value.progress.length, 0); assert.equal(value.calls.verify, 0);
});
test('failed cleanup explicitly marks workspace unusable', async () => {
  const value = fixture(); value.sink.append = async () => { throw new Error('disk failure'); };
  value.sink.abort = async () => { throw new Error('cleanup failure'); };
  await assert.rejects(run(value), error => error instanceof api.DispatchExportCleanupError && error.cleanupRequired);
});
test('backpressure does not read another page or count bytes before append resolves', async () => {
  const value = fixture(); let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const original = value.sink.append;
  value.sink.append = async (...args) => {
    if (value.calls.writes === 0) { started(); await new Promise(resolve => { release = resolve; }); }
    return original(...args);
  };
  const pending = run(value); await waiting;
  assert.equal(value.calls.pages, 1); assert.equal(value.progress.length, 0);
  release(); await pending;
});
for (const operation of ['page', 'append']) test(`cancellation interrupts a stalled ${operation} and ignores late completion`, async () => {
  const value = fixture(), controller = new AbortController(); let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const deferred = () => { started(); return new Promise(resolve => { release = resolve; }); };
  if (operation === 'page') value.source.page = deferred; else value.sink.append = deferred;
  const pending = run(value, { signal: controller.signal }); await waiting; controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(value.calls.aborts, 1); assert.equal(value.progress.length, 0);
  release(undefined); await new Promise(resolve => setImmediate(resolve)); assert.equal(value.calls.verify, 0);
});
test('already cancelled export makes no source requests', async () => {
  const value = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(run(value, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(value.calls.pages, 0);
});
test('mutating validated catalog copies cannot alter source descriptor', () => {
  const value = fixture(); const result = api.validateDispatchCatalog(value.catalog);
  result.tables[0].rows = 88; assert.equal(value.catalog.tables[0].rows, 1);
});

const preflightKeys = ['orders', 'orders_history', 'used_submissions', 'submission_usage', 'assignments',
  'pool_selections', 'dispatch_sessions', 'wallet_transactions', 'ledger_entries', 'withdrawals',
  'wallet_funds', 'income', 'baseline_funds', 'work_sessions', 'legacy_dispatch_content', 'reconciliation_audit'];
function preflight() {
  return { scope: 'dispatch-submission', site_id: SITE, counts: Object.fromEntries(preflightKeys.map(key => [key, 0])),
    blockers: [], eligible_for_empty_target_mode: true, replacement_ready: false, full_site_complete: false };
}
for (const [label, mutate] of [
  ['missing blocker', v => { v.counts.orders = 1; }],
  ['fake ready', v => { v.replacement_ready = true; }],
  ['fake completion', v => { v.full_site_complete = true; }],
  ['unknown count', v => { v.counts.unknown = 0; }],
  ['incorrect blocker count', v => { v.counts.orders = 1; v.blockers = [{ code: 'orders', count: 2 }]; v.eligible_for_empty_target_mode = false; }],
  ['duplicate blocker', v => { v.counts.orders = 1; v.blockers = [{ code: 'orders', count: 1 }, { code: 'orders', count: 1 }]; v.eligible_for_empty_target_mode = false; }],
]) test(`target preflight rejects ${label}`, () => {
  const value = preflight(); mutate(value); assert.throws(() => api.validateDispatchPreflight(value));
});
test('valid empty target preflight is eligibility only, not permission to replace data', () => {
  assert.deepEqual(api.validateDispatchPreflight(preflight()), preflight());
});
