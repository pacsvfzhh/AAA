import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../../src/lib/employeeTransfer/sharedImport.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020',
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const KEYS = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
const hash = value => createHash('sha256').update(value).digest('hex');
const rowCount = bytes => bytes.reduce((count, byte) => count + (byte === 10 ? 1 : 0), 0);
const beginResponse = () => ({ success: true, scope: 'shared-settings', full_site_complete: false });
const dryResponse = () => ({ scope: 'shared-settings', full_site_complete: false, can_apply: true,
  plan_hash: hash('local-plan'), admins: [], conflicts: [] });
const acknowledgement = ndjson => ({ success: true, rows: rowCount(Buffer.from(ndjson)),
  bytes: Buffer.byteLength(ndjson), sha256: hash(ndjson), repeated: false });
const defaults = {
  admins: '{ "label":"管理员𠮷", "n":1e2 }\n'.repeat(405),
  financial_admin_credentials: '{"opaque_hash":"local-only-sensitive-hash"}\n',
  admin_groups: '{}\n', admin_group_members: '',
  admin_configs: '{"中文":"é é 𠮷", "nested":{"x":[1,true,null]}}\r\n',
  system_configs: '{"key":"display","value":null}\n', history_cleanup_config: '',
};
function byteSource(body, record, events, chunkSize) {
  let offset = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      record.reads++;
      if (offset === body.length) {
        record.ended = true;
        events.push(`eof:${record.key}:${record.pass}`);
        return { done: true };
      }
      const value = body.subarray(offset, offset + chunkSize);
      offset += value.length;
      return { value, done: false };
    },
    async return() { record.returns++; return { done: true }; },
  };
}
function fixture(texts = defaults, chunkSize = 13) {
  const bodies = Object.fromEntries(KEYS.map(key => [key, Buffer.from(texts[key] ?? '')]));
  const catalog = {
    version: 1, scope: 'shared-settings', site_id: '82f20fb2-1122-4433-8a99-010203040506',
    tables: KEYS.map(key => ({ key, rows: rowCount(bodies[key]), bytes: bodies[key].length, sha256: hash(bodies[key]) })),
    excluded_system_keys: ['ios_config'], full_site_complete: false,
  };
  const calls = { begin: [], stage: [], dryRun: [], apply: 0, cleanup: 0, opens: [] };
  const events = [];
  const value = { catalog, bodies, calls, events,
    sourceFor(body, record) { return byteSource(body, record, events, chunkSize); } };
  value.files = {
    open(key) {
      const record = { key, pass: calls.opens.filter(open => open.key === key).length + 1,
        reads: 0, returns: 0, ended: false };
      calls.opens.push(record);
      events.push(`open:${key}:${record.pass}`);
      return value.sourceFor(bodies[key], record);
    },
  };
  value.target = {
    async begin(catalog, signal) { calls.begin.push({ catalog, signal }); events.push('begin'); return beginResponse(); },
    async stage(key, chunkNo, ndjson, signal) {
      calls.stage.push({ key, chunkNo, ndjson, signal });
      events.push(`stage:${key}:${chunkNo}`);
      return acknowledgement(ndjson);
    },
    async dryRun(signal) { calls.dryRun.push(signal); events.push('dry-run'); return dryResponse(); },
    async apply() { calls.apply++; assert.fail('this module must never apply business writes'); },
    async abort() { calls.cleanup++; assert.fail('server staging must not be removed'); },
    async cancel() { calls.cleanup++; assert.fail('server staging must not be cancelled'); },
  };
  return value;
}
async function rejectImport(value, options = {}) {
  const progress = [];
  let failure;
  await assert.rejects(api.stageSharedSettingsImport(value.catalog, value.files, value.target,
    { onProgress: p => progress.push(p), ...options }), error => { failure = error; return true; });
  assert.equal(value.calls.apply, 0);
  assert.equal(value.calls.cleanup, 0);
  assert.doesNotMatch(failure.message, /local-only-sensitive-hash/);
  if (value.calls.begin.length) {
    assert.ok(failure instanceof api.SharedImportStagingMayExistError);
    assert.equal(failure.name, 'SharedImportStagingMayExistError');
    assert.equal(failure.stagingMayExist, true);
    assert.match(failure.message, /may already exist/);
    assert.equal('cause' in failure, false);
  }
  return { failure, progress };
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settlesSoon(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation did not stop promptly')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}
const lineOfSize = bytes => '{"x":"' + 'a'.repeat(bytes - 9) + '"}\n';

test('two-pass Unicode streaming preserves bytes, complete-line pagination and real per-phase counts', async () => {
  const value = fixture();
  value.catalog.tables.reverse();
  const progress = [];
  const result = await api.stageSharedSettingsImport(value.catalog, value.files, value.target,
    { onProgress: p => progress.push(p) });
  assert.deepEqual(value.calls.opens.map(({ key, pass }) => [key, pass]),
    [1, 2].flatMap(pass => KEYS.map(key => [key, pass])));
  assert.ok(value.calls.opens.every(open => open.ended && open.returns === 0));
  for (const key of KEYS) {
    assert.ok(value.events.indexOf(`eof:${key}:1`) < value.events.indexOf('begin'));
    const chunks = value.calls.stage.filter(chunk => chunk.key === key);
    assert.equal(chunks.map(chunk => chunk.ndjson).join(''), value.bodies[key].toString());
    assert.deepEqual(chunks.map(chunk => chunk.chunkNo), chunks.map((_, index) => index));
    assert.ok(chunks.every(chunk => rowCount(Buffer.from(chunk.ndjson)) <= 200 && Buffer.byteLength(chunk.ndjson) <= 262144));
  }
  assert.deepEqual(value.calls.stage.filter(chunk => chunk.key === 'admins').map(chunk => rowCount(Buffer.from(chunk.ndjson))), [200, 200, 5]);
  assert.deepEqual(result.dryRun, dryResponse());
  const expectedRows = value.catalog.tables.reduce((sum, table) => sum + table.rows, 0);
  const expectedBytes = value.catalog.tables.reduce((sum, table) => sum + table.bytes, 0);
  assert.equal(result.rows, expectedRows);
  assert.equal(result.bytes, expectedBytes);
  assert.equal(result.fullSiteComplete, false);
  assert.notEqual(expectedBytes, Object.values(defaults).join('').length);
  const checked = progress.filter(p => p.phase === 'validate');
  let rows = 0;
  let bytes = 0;
  checked.forEach((p, index) => {
    const body = value.bodies[KEYS[index]];
    rows += rowCount(body); bytes += body.length;
    assert.deepEqual(p, { scope: 'shared-settings', phase: 'validate', tableKey: KEYS[index], rows, bytes, fullSiteComplete: false });
  });
  rows = 0; bytes = 0;
  const staged = progress.filter(p => p.phase === 'stage');
  assert.equal(staged.length, value.calls.stage.length);
  staged.forEach((p, index) => {
    const chunk = value.calls.stage[index];
    rows += rowCount(Buffer.from(chunk.ndjson)); bytes += Buffer.byteLength(chunk.ndjson);
    assert.deepEqual(p, { scope: 'shared-settings', phase: 'stage', tableKey: chunk.key, rows, bytes, fullSiteComplete: false });
  });
  assert.deepEqual(progress.at(-1), { scope: 'shared-settings', phase: 'dry-run', rows, bytes, fullSiteComplete: false });
  assert.doesNotMatch(JSON.stringify(progress), /opaque_hash|local-only-sensitive-hash|plan_hash/);
  assert.equal(value.calls.begin.length, 1);
  assert.equal(value.calls.dryRun.length, 1);
  assert.equal(value.events.at(-1), 'dry-run');
  assert.equal(value.calls.apply, 0);
  assert.equal(value.calls.cleanup, 0);
});

test('all seven empty files are validated, reopened and staged with chunk zero and empty hash', async () => {
  const value = fixture({});
  value.target.stage = async (key, chunkNo, ndjson) => {
    value.calls.stage.push({ key, chunkNo, ndjson });
    return { ...acknowledgement(ndjson), repeated: true };
  };
  const result = await api.stageSharedSettingsImport(value.catalog, value.files, value.target);
  assert.deepEqual(value.calls.stage, KEYS.map(key => ({ key, chunkNo: 0, ndjson: '' })));
  assert.equal(value.calls.opens.length, 14);
  assert.equal(result.rows, 0);
  assert.equal(result.bytes, 0);
});

test('byte pages stop exactly at 256KiB, line limit includes LF, and exactly 8MiB is accepted', async () => {
  const line = lineOfSize(65536);
  const body = line.repeat(128);
  const value = fixture({ admins: body }, 1024 * 1024);
  const digest = createHash('sha256');
  let pages = 0;
  value.target.stage = async (key, chunkNo, ndjson) => {
    if (key === 'admins') {
      assert.equal(Buffer.byteLength(ndjson), 262144);
      assert.equal(rowCount(Buffer.from(ndjson)), 4);
      assert.equal(chunkNo, pages++);
      digest.update(ndjson);
    }
    return acknowledgement(ndjson);
  };
  const result = await api.stageSharedSettingsImport(value.catalog, value.files, value.target);
  assert.equal(result.bytes, 8 * 1024 * 1024);
  assert.equal(result.rows, 128);
  assert.equal(pages, 32);
  assert.equal(digest.digest('hex'), hash(body));
});

test('byte-bound pagination never splits a complete line, even below 200 rows', async () => {
  const value = fixture({ admins: lineOfSize(60000).repeat(9) }, 7777);
  await api.stageSharedSettingsImport(value.catalog, value.files, value.target);
  assert.deepEqual(value.calls.stage.filter(c => c.key === 'admins').map(c => Buffer.byteLength(c.ndjson)), [240000, 240000, 60000]);
});

test('exactly 10000 rows are accepted without accumulating a table', async () => {
  const value = fixture({ admins: '{}\n'.repeat(10000) }, 600);
  const result = await api.stageSharedSettingsImport(value.catalog, value.files, value.target);
  assert.equal(result.rows, 10000);
  assert.equal(value.calls.stage.filter(c => c.key === 'admins').length, 50);
});

const catalogCases = [
  ['missing table', c => c.tables.pop()],
  ['duplicate table', c => { c.tables[6] = { ...c.tables[0] }; }],
  ['unknown table', c => { c.tables[0].key = 'users'; }],
  ['version', c => { c.version = 2; }],
  ['scope', c => { c.scope = 'full-site'; }],
  ['completion', c => { c.full_site_complete = true; }],
  ['UUID', c => { c.site_id = 'invalid'; }],
  ['extra field', c => { c.body = 'local-only-sensitive-hash'; }],
  ['extra table field', c => { c.tables[0].body = true; }],
  ['row cap', c => { c.tables[0].rows = 10001; }],
  ['negative rows', c => { c.tables[0].rows = -1; }],
  ['fractional rows', c => { c.tables[0].rows = 0.5; }],
  ['string rows', c => { c.tables[0].rows = '1'; }],
  ['unsafe rows', c => { c.tables[0].rows = Number.MAX_SAFE_INTEGER + 1; }],
  ['NaN bytes', c => { c.tables[0].bytes = NaN; }],
  ['negative bytes', c => { c.tables[0].bytes = -1; }],
  ['total cap', c => { c.tables[0].bytes = 8 * 1024 * 1024; c.tables[1].bytes = 1; }],
  ['single-file cap', c => { c.tables[0].bytes = 8 * 1024 * 1024 + 1; }],
  ['uppercase hash', c => { c.tables[0].sha256 = 'A'.repeat(64); }],
  ['short hash', c => { c.tables[0].sha256 = 'a'.repeat(63); }],
  ['unknown excluded key', c => { c.excluded_system_keys = ['secret']; }],
  ['sparse tables', c => { delete c.tables[0]; }],
  ['accessor', c => { Object.defineProperty(c, 'scope', { get() { assert.fail('getter must not run'); } }); }],
];
for (const [name, mutate] of catalogCases) {
  test(`strict catalog rejects ${name} before opening files or begin`, async () => {
    const value = fixture();
    mutate(value.catalog);
    await rejectImport(value);
    assert.equal(value.calls.opens.length, 0);
    assert.equal(value.calls.begin.length, 0);
    assert.equal(value.calls.stage.length, 0);
    assert.equal(value.calls.dryRun.length, 0);
  });
}
for (const catalog of [null, [], 1, 'catalog', new Date()]) {
  test(`reject non-catalog ${String(catalog)}`, async () => {
    const value = fixture();
    value.catalog = catalog;
    await rejectImport(value);
    assert.equal(value.calls.opens.length, 0);
    assert.equal(value.calls.begin.length, 0);
  });
}

const invalidFiles = [
  ['null row', 'null\n'], ['array row', '[]\n'], ['string row', '"text"\n'],
  ['number row', '1\n'], ['boolean row', 'true\n'], ['blank row', '\n'],
  ['whitespace row', ' \t\r\n'], ['bad JSON', '{"secret":"local-only-sensitive-hash",}\n'],
  ['two objects', '{}{}\n'], ['missing LF', '{}'], ['trailing partial row', '{}\n{'],
  ['blank last row', '{}\n\n'], ['BOM', '\ufeff{}\n'],
  ['invalid UTF-8', Buffer.from([123, 34, 120, 34, 58, 34, 0xc3, 0x28, 34, 125, 10])],
  ['UTF-8 surrogate', Buffer.from([123, 34, 120, 34, 58, 34, 0xed, 0xa0, 0x80, 34, 125, 10])],
  ['truncated UTF-8', Buffer.from([123, 125, 0xc3, 10])],
  ['overlong UTF-8', Buffer.from([0xc0, 0xaf, 10])],
  ['line exceeds cap including LF', lineOfSize(65537)],
  ['Unicode byte limit', '{"x":"' + '汉'.repeat(22000) + '"}\n'],
  ['unterminated huge line', 'a'.repeat(65537)],
];
for (const [name, body] of invalidFiles) {
  test(`first pass rejects ${name} without begin, even in the seventh file`, async () => {
    const value = fixture({ admins: '{}\n', history_cleanup_config: body }, 5);
    const { failure } = await rejectImport(value);
    assert.equal(failure.name, 'SharedImportValidationError');
    assert.equal(value.calls.opens.length, 7);
    assert.equal(value.calls.begin.length, 0);
    assert.equal(value.calls.stage.length, 0);
    assert.equal(value.calls.dryRun.length, 0);
    assert.ok(value.calls.opens.every(open => open.ended || open.returns === 1));
  });
}
for (const [name, mutate] of [
  ['raw hash', table => { table.sha256 = '0'.repeat(64); }],
  ['too few rows', table => { table.rows++; }],
  ['too many rows', table => { table.rows--; }],
  ['too few bytes', table => { table.bytes++; }],
  ['too many bytes', table => { table.bytes--; }],
]) {
  test(`first pass compares ${name} before begin`, async () => {
    const value = fixture({ history_cleanup_config: '{ "x":1e2 }\n' });
    mutate(value.catalog.tables[6]);
    await rejectImport(value);
    assert.equal(value.calls.begin.length, 0);
    assert.equal(value.calls.dryRun.length, 0);
  });
}

test('actual row overflow is rejected even with a lying in-limit catalog', async () => {
  const value = fixture({ admins: '{}\n'.repeat(10001) }, 1024 * 1024);
  value.catalog.tables[0].rows = 10000;
  await rejectImport(value);
  assert.equal(value.calls.begin.length, 0);
  assert.equal(value.calls.opens[0].returns, 1);
});

for (const source of [null, {}, 'not-a-source', {
  async *[Symbol.asyncIterator]() { yield new Uint8Array(1024 * 1024 + 1); },
}, { async *[Symbol.asyncIterator]() { yield 'not-bytes'; } }]) {
  test(`reject invalid or oversized source ${String(source)}`, async () => {
    const value = fixture({});
    value.sourceFor = () => source;
    await rejectImport(value);
    assert.equal(value.calls.begin.length, 0);
  });
}

test('empty input chunks and opaque rows are allowed; SQL owns duplicate keys and business fields', async () => {
  const body = '{"a":1,"a":2,"nested":{"x":[true,null]},"escaped":"\\ud800"}\n';
  const value = fixture({ admins: body });
  value.sourceFor = async function* (bytes) { yield new Uint8Array(); yield bytes; yield new Uint8Array(); };
  assert.equal((await api.stageSharedSettingsImport(value.catalog, value.files, value.target)).rows, 1);
  assert.equal(value.calls.stage[0].ndjson, body);
});

for (const [name, changed] of [
  ['same-size content/hash', '{"x":2}\n'], ['row count', '{}\n{}\n'],
  ['byte count', '{"x":11}\n'], ['truncated row', '{"x":1}'], ['UTF-8', Buffer.from([0xff, 10])],
]) {
  test(`second-pass ${name} change forbids dry-run and reports possible staging`, async () => {
    const value = fixture({ admins: '{}\n'.repeat(200), history_cleanup_config: '{"x":1}\n' }, 1024 * 1024);
    const original = value.sourceFor;
    value.sourceFor = (body, record) => original(record.pass === 2 && record.key === 'history_cleanup_config' ? Buffer.from(changed) : body, record);
    const { failure } = await rejectImport(value);
    assert.equal(value.calls.begin.length, 1);
    assert.ok(value.calls.stage.length >= 1);
    assert.equal(value.calls.dryRun.length, 0);
    assert.equal(failure.cancelled, false);
    assert.equal(value.calls.cleanup, 0);
  });
}

test('one-shot files cannot skip second-pass verification', async () => {
  const value = fixture({ admins: '{}\n' });
  const original = value.sourceFor;
  value.sourceFor = (body, record) => original(record.pass === 2 ? Buffer.alloc(0) : body, record);
  await rejectImport(value);
  assert.equal(value.calls.dryRun.length, 0);
});

const responseShapes = [
  ['null', () => null], ['array', () => []], ['number', () => 1], ['string', () => 'response'],
  ['missing field', response => { delete response[Object.keys(response)[0]]; return response; }],
  ['extra field', response => ({ ...response, body: 'local-only-sensitive-hash' })],
  ['symbol field', response => { response[Symbol('extra')] = true; return response; }],
  ['hidden field', response => { Object.defineProperty(response, 'hidden', { value: 1 }); return response; }],
  ['inherited fields', response => Object.create(response)],
  ['custom prototype', response => Object.assign(Object.create({ extra: 1 }), response)],
  ['accessor', response => {
    Object.defineProperty(response, Object.keys(response)[0], { enumerable: true, get() { assert.fail('getter must not run'); } });
    return response;
  }],
  ['non-enumerable required field', response => {
    Object.defineProperty(response, Object.keys(response)[0], { enumerable: false }); return response;
  }],
];
for (const method of ['begin', 'stage', 'dryRun']) {
  for (const [name, mutate] of responseShapes) {
    test(`${method} strictly rejects ${name} and does not retry`, async () => {
      const value = fixture({});
      const base = value.target[method];
      value.target[method] = async (...args) => mutate(await base(...args));
      await rejectImport(value);
      assert.equal(value.calls[method].length, 1);
      if (method === 'begin') assert.equal(value.calls.stage.length, 0);
      if (method !== 'dryRun') assert.equal(value.calls.dryRun.length, 0);
    });
  }
}
const beginCases = [
  ['false success', r => { r.success = false; }], ['truthy success', r => { r.success = 1; }],
  ['scope', r => { r.scope = 'full-site'; }], ['complete', r => { r.full_site_complete = true; }],
];
const ackCases = [
  ['success', r => { r.success = false; }], ['rows mismatch', r => { r.rows++; }],
  ['bytes mismatch', r => { r.bytes++; }], ['hash mismatch', r => { r.sha256 = '0'.repeat(64); }],
  ['hash uppercase', r => { r.sha256 = 'A'.repeat(64); }], ['short hash', r => { r.sha256 = 'a'.repeat(63); }],
  ['repeated type', r => { r.repeated = 'false'; }], ['negative rows', r => { r.rows = -1; }],
  ['fractional rows', r => { r.rows = 0.5; }], ['string rows', r => { r.rows = '0'; }],
  ['row limit', r => { r.rows = 201; }], ['NaN bytes', r => { r.bytes = NaN; }],
  ['infinite bytes', r => { r.bytes = Infinity; }], ['fractional bytes', r => { r.bytes = 0.5; }],
  ['string bytes', r => { r.bytes = '0'; }], ['unsafe bytes', r => { r.bytes = Number.MAX_SAFE_INTEGER + 1; }],
  ['byte limit', r => { r.bytes = 262145; }],
];
const dryCases = [
  ['scope', r => { r.scope = 'full-site'; }], ['completion', r => { r.full_site_complete = true; }],
  ['can_apply type', r => { r.can_apply = 1; }], ['plan hash', r => { r.plan_hash = 'bad'; }],
  ['uppercase hash', r => { r.plan_hash = 'A'.repeat(64); }],
  ['admins array', r => { r.admins = {}; }], ['conflicts array', r => { r.conflicts = null; }],
];
for (const [method, cases] of [['begin', beginCases], ['stage', ackCases], ['dryRun', dryCases]]) {
  for (const [name, mutate] of cases) {
    test(`${method} rejects invalid ${name} without false progress`, async () => {
      const value = fixture({ admins: '{}\n' });
      const base = value.target[method];
      value.target[method] = async (...args) => { const response = await base(...args); mutate(response); return response; };
      const { progress } = await rejectImport(value);
      assert.equal(value.calls[method].length, 1);
      if (method !== 'dryRun') {
        assert.equal(progress.filter(p => p.phase === 'stage').length, 0);
        assert.equal(value.calls.dryRun.length, 0);
      }
    });
  }
}

test('null-prototype responses are accepted; begin cannot mutate the private catalog baseline', async () => {
  const value = fixture();
  const originalCatalog = structuredClone(value.catalog);
  const begin = value.target.begin;
  value.target.begin = async (catalog, signal) => {
    const response = await begin(catalog, signal);
    catalog.tables[0].rows = 0;
    catalog.tables[0].sha256 = '0'.repeat(64);
    return Object.assign(Object.create(null), response);
  };
  for (const method of ['stage', 'dryRun']) {
    const base = value.target[method];
    value.target[method] = async (...args) => Object.assign(Object.create(null), await base(...args));
  }
  const result = await api.stageSharedSettingsImport(value.catalog, value.files, value.target);
  assert.equal(result.rows, originalCatalog.tables.reduce((sum, table) => sum + table.rows, 0));
  assert.deepEqual(value.catalog, originalCatalog);
});

test('dry-run conflicts and opaque SQL decisions survive unchanged and never trigger apply', async () => {
  const value = fixture();
  const response = { ...dryResponse(), can_apply: false,
    admins: [{ action: 'map_super_admin', preserve_target_identity: true }],
    conflicts: [{ code: 'username_conflict', requires_approval: true }] };
  value.target.dryRun = async () => { value.calls.dryRun.push(undefined); return response; };
  const result = await api.stageSharedSettingsImport(value.catalog, value.files, value.target);
  assert.deepEqual(result.dryRun, response);
  assert.notEqual(result.dryRun, response);
  assert.equal(value.calls.dryRun.length, 1);
  assert.equal(value.calls.apply, 0);
});

for (const method of ['begin', 'stage', 'dryRun']) {
  test(`${method} lost reply is not retried or rolled back`, async () => {
    const value = fixture({ admins: '{}\n' });
    const base = value.target[method];
    value.target[method] = async (...args) => { await base(...args); throw new Error('local-only-sensitive-hash'); };
    const { progress } = await rejectImport(value);
    assert.equal(value.calls[method].length, 1);
    if (method !== 'dryRun') assert.equal(value.calls.dryRun.length, 0);
    if (method === 'stage') assert.equal(progress.filter(p => p.phase === 'stage').length, 0);
  });
}

for (const lostReply of [false, true]) {
  test(`second chunk ${lostReply ? 'lost reply' : 'bad acknowledgement'} preserves only confirmed progress and stops`, async () => {
    const value = fixture({ admins: '{}\n'.repeat(401) }, 600);
    const base = value.target.stage;
    value.target.stage = async (...args) => {
      const ack = await base(...args);
      if (args[1] === 1) {
        if (lostReply) throw new Error('local-only-sensitive-hash');
        ack.bytes++;
      }
      return ack;
    };
    const { progress } = await rejectImport(value);
    assert.deepEqual(value.calls.stage.map(c => [c.key, c.chunkNo]), [['admins', 0], ['admins', 1]]);
    assert.deepEqual(progress.filter(p => p.phase === 'stage').map(p => [p.rows, p.bytes]), [[200, 600]]);
    assert.equal(value.calls.opens.length, 8);
    assert.equal(value.calls.opens.at(-1).returns, 1);
    assert.equal(value.calls.dryRun.length, 0);
  });
}

test('second-pass hash change after every full page was acknowledged still prevents dry-run', async () => {
  const value = fixture({ admins: '{"x":1}\n'.repeat(400) }, 1600);
  const original = value.sourceFor;
  value.sourceFor = (body, record) => original(record.pass === 2 && record.key === 'admins'
    ? Buffer.from('{"x":1}\n'.repeat(399) + '{"x":2}\n') : body, record);
  const { progress } = await rejectImport(value);
  assert.equal(value.calls.stage.length, 2);
  assert.equal(progress.filter(p => p.phase === 'stage').at(-1).rows, 400);
  assert.equal(value.calls.dryRun.length, 0);
  assert.equal(progress.filter(p => p.phase === 'dry-run').length, 0);
});

test('repeated nonempty acknowledgements count each logical chunk once, not zero or twice', async () => {
  const value = fixture({ admins: '{}\n'.repeat(401) }, 600);
  const base = value.target.stage;
  value.target.stage = async (...args) => ({ ...await base(...args), repeated: true });
  const progress = [];
  const result = await api.stageSharedSettingsImport(value.catalog, value.files, value.target,
    { onProgress: p => progress.push(p) });
  assert.equal(result.rows, 401);
  assert.equal(result.bytes, 1203);
  assert.deepEqual(progress.filter(p => p.phase === 'stage' && p.tableKey === 'admins').map(p => p.rows), [200, 400, 401]);
});

test('backpressure waits for each checked acknowledgement with no source read-ahead or premature progress', async () => {
  const value = fixture({ admins: '{}\n'.repeat(401) }, 600);
  const originalStage = value.target.stage;
  const pending = [];
  value.target.stage = (key, chunkNo, ndjson, signal) => {
    const gate = deferred();
    pending.push({ key, chunkNo, ndjson, gate });
    return gate.promise.then(() => originalStage(key, chunkNo, ndjson, signal));
  };
  const progress = [];
  const completion = api.stageSharedSettingsImport(value.catalog, value.files, value.target,
    { onProgress: p => progress.push(p) });
  const expectedChunks = 3 + 6;
  for (let index = 0; index < expectedChunks; index++) {
    await nextTurn();
    assert.equal(pending.length, index + 1);
    assert.equal(progress.filter(p => p.phase === 'stage').length, index);
    const reads = value.calls.opens.reduce((sum, open) => sum + open.reads, 0);
    const opens = value.calls.opens.length;
    await nextTurn();
    assert.equal(value.calls.opens.reduce((sum, open) => sum + open.reads, 0), reads);
    assert.equal(value.calls.opens.length, opens);
    assert.equal(value.calls.dryRun.length, 0);
    pending[index].gate.resolve();
  }
  assert.equal((await completion).rows, 401);
  assert.equal(value.calls.dryRun.length, 1);
});

test('pre-cancelled signal never opens a file or begins staging', async () => {
  const value = fixture();
  const controller = new AbortController();
  controller.abort('local-only-sensitive-hash');
  const { failure, progress } = await rejectImport(value, { signal: controller.signal });
  assert.equal(failure.name, 'AbortError');
  assert.equal(value.calls.opens.length, 0);
  assert.equal(value.calls.begin.length, 0);
  assert.deepEqual(progress, []);
});

for (const method of ['begin', 'stage', 'dryRun']) {
  for (const lateReject of [false, true]) {
    test(`cancel pending ${method}, release active source, and ignore late ${lateReject ? 'failure' : 'reply'}`, async () => {
      const value = fixture({ admins: '{}\n'.repeat(400) }, 600);
      const controller = new AbortController();
      const gate = deferred();
      const entered = deferred();
      const base = value.target[method];
      value.target[method] = async (...args) => {
        assert.equal(args.at(-1), controller.signal);
        await base(...args);
        entered.resolve();
        return gate.promise;
      };
      const progress = [];
      const rejection = rejectImport(value, { signal: controller.signal, onProgress: p => progress.push(p) });
      await entered.promise;
      const count = progress.length;
      controller.abort('local-only-sensitive-hash');
      const { failure } = await settlesSoon(rejection);
      assert.equal(failure.cancelled, true);
      assert.equal(value.calls[method].length, 1);
      if (method === 'stage') {
        assert.equal(value.calls.opens.at(-1).returns, 1);
        assert.equal(value.calls.dryRun.length, 0);
      }
      if (lateReject) gate.reject(new Error('local-only-sensitive-hash'));
      else gate.resolve(method === 'begin' ? beginResponse() : method === 'stage' ? acknowledgement('{}\n'.repeat(200)) : dryResponse());
      await nextTurn();
      assert.equal(progress.length, count);
      assert.equal(value.calls[method].length, 1);
    });
  }
}

for (const pass of [1, 2]) {
  for (const lateReject of [false, true]) {
    test(`cancel pending iterator next in pass ${pass}; return must not stall on late ${lateReject ? 'error' : 'bytes'}`, async () => {
      const value = fixture({ admins: '{}\n' });
      const original = value.sourceFor;
      const gate = deferred();
      const entered = deferred();
      const controller = new AbortController();
      value.sourceFor = (body, record) => record.key === 'admins' && record.pass === pass ? {
        [Symbol.asyncIterator]() { return this; },
        next() { record.reads++; entered.resolve(); return gate.promise; },
        return() { record.returns++; return new Promise(() => {}); },
      } : original(body, record);
      const rejection = rejectImport(value, { signal: controller.signal });
      await entered.promise;
      controller.abort();
      const { failure } = await settlesSoon(rejection);
      assert.equal(value.calls.opens.at(-1).returns, 1);
      assert.equal(value.calls.begin.length, pass === 1 ? 0 : 1);
      assert.equal(failure.name, pass === 1 ? 'AbortError' : 'SharedImportStagingMayExistError');
      assert.equal(value.calls.stage.length, 0);
      assert.equal(value.calls.dryRun.length, 0);
      if (lateReject) gate.reject(new Error('local-only-sensitive-hash'));
      else gate.resolve({ value: Buffer.from('{}\n'), done: false });
      await nextTurn();
      assert.equal(value.calls.opens.at(-1).reads, 1);
    });
  }
}

function streamFiles(value, chunkSize = 7) {
  const streams = [];
  value.sourceFor = body => {
    let offset = 0;
    const record = { cancelled: 0 };
    const stream = new ReadableStream({
      pull(controller) {
        if (offset === body.length) { controller.close(); return; }
        controller.enqueue(body.subarray(offset, offset + chunkSize));
        offset += Math.min(chunkSize, body.length - offset);
      },
      cancel() { record.cancelled++; },
    }, { highWaterMark: 0 });
    streams.push({ stream, record });
    return stream;
  };
  return streams;
}

test('native ReadableStreams split Unicode and release every reader on normal EOF', async () => {
  const value = fixture();
  const streams = streamFiles(value);
  const result = await api.stageSharedSettingsImport(value.catalog, value.files, value.target);
  assert.equal(streams.length, 14);
  assert.ok(streams.every(({ stream, record }) => !stream.locked && record.cancelled === 0));
  assert.equal(result.bytes, value.catalog.tables.reduce((sum, table) => sum + table.bytes, 0));
});

for (const action of ['abort-read', 'abort-write', 'bad-ack', 'bad-bytes']) {
  test(`ReadableStream ${action} cancels and releases reader without awaiting stalled cancel`, async () => {
    const value = fixture({ admins: '{}\n'.repeat(400) });
    const controller = new AbortController();
    const entered = deferred();
    let stream;
    let cancels = 0;
    const original = value.sourceFor;
    value.sourceFor = (body, record) => {
      if ((action !== 'bad-bytes' && record.pass !== 2) || record.key !== 'admins') return original(body, record);
      stream = new ReadableStream({
        pull(control) {
          if (action === 'abort-read') { entered.resolve(); return new Promise(() => {}); }
          control.enqueue(action === 'bad-bytes' ? new Uint8Array(1024 * 1024 + 1) : body);
        },
        cancel() { cancels++; return new Promise(() => {}); },
      }, { highWaterMark: 0 });
      return stream;
    };
    if (action === 'abort-write' || action === 'bad-ack') {
      const base = value.target.stage;
      value.target.stage = async (...args) => {
        await base(...args);
        if (action === 'bad-ack') return { ...acknowledgement(args[2]), rows: -1 };
        entered.resolve();
        return new Promise(() => {});
      };
    }
    const rejection = rejectImport(value, { signal: controller.signal });
    if (action.startsWith('abort')) { await entered.promise; controller.abort(); }
    await settlesSoon(rejection);
    assert.equal(cancels, 1);
    assert.equal(stream.locked, false);
    assert.equal(value.calls.dryRun.length, 0);
    if (action === 'bad-bytes') assert.equal(value.calls.begin.length, 0);
  });
}

test('source and progress exceptions do not expose sensitive diagnostics or invoke later phases', async t => {
  for (const phase of ['open', 'next', 'validate-progress', 'stage-progress']) {
    await t.test(phase, async () => {
      const value = fixture({ admins: '{}\n'.repeat(400) }, 600);
      const options = {};
      if (phase === 'open') value.files.open = () => { throw new Error('local-only-sensitive-hash'); };
      else if (phase === 'next') value.sourceFor = () => ({
        [Symbol.asyncIterator]() { return this; },
        async next() { throw new Error('local-only-sensitive-hash'); },
        async return() { throw new Error('local-only-sensitive-hash'); },
      });
      else options.onProgress = p => {
        if (p.phase === (phase === 'validate-progress' ? 'validate' : 'stage')) throw new Error('local-only-sensitive-hash');
      };
      const { failure } = await rejectImport(value, options);
      assert.equal(failure.name, phase === 'stage-progress' ? 'SharedImportStagingMayExistError' : 'SharedImportError');
      assert.equal(value.calls.dryRun.length, 0);
      assert.equal(value.calls.begin.length, phase === 'stage-progress' ? 1 : 0);
    });
  }
});

test('cancellation from validation progress never calls begin; acknowledged progress can stop later uploads', async t => {
  for (const phase of ['validate', 'stage']) {
    await t.test(phase, async () => {
      const value = fixture();
      const controller = new AbortController();
      const progress = [];
      await rejectImport(value, { signal: controller.signal, onProgress: p => {
        progress.push(p); if (p.phase === phase) controller.abort();
      } });
      assert.equal(value.calls.begin.length, phase === 'validate' ? 0 : 1);
      assert.equal(value.calls.stage.length, phase === 'validate' ? 0 : 1);
      assert.equal(progress.filter(p => p.phase === phase).length, 1);
      assert.equal(value.calls.dryRun.length, 0);
    });
  }
});
