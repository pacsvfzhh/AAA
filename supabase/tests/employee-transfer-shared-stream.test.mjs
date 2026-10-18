import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const compiled = await build({
  entryPoints: [fileURLToPath(new URL('../../src/lib/employeeTransfer/sharedExport.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020',
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const KEYS = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
const hash = value => createHash('sha256').update(value).digest('hex');
const pathFor = key => `data/shared-${key}.ndjson`;
const defaults = {
  admins: ['{ "id":"admin-1", "label":"管理员𠮷", "n":1e2 }\n', '{"id":"admin-2"}\n'],
  financial_admin_credentials: ['{"opaque_hash":"local-only-sensitive-hash"}\n'],
  admin_groups: ['{"id":"group-1"}\n{"id":"group-2"}\n'],
  admin_group_members: [''],
  admin_configs: ['{"中文":"é é 𠮷", "nested":{"x":[1,true,null]}}\n'],
  system_configs: ['{"key":"display","value":null}\n'],
  history_cleanup_config: [''],
};

function pageFor(key, ndjson, next = null) {
  return { table_key: key, count: ndjson.split('\n').length - 1, ndjson, next_after: next, sha256: hash(ndjson) };
}
function fixture(texts = defaults) {
  const pages = Object.fromEntries(KEYS.map(key => [key,
    (texts[key] ?? ['']).map((body, index, bodies) => pageFor(key, body, index + 1 < bodies.length ? `cursor-${index + 1}` : null)),
  ]));
  const catalog = {
    version: 1, scope: 'shared-settings', site_id: '82f20fb2-1122-4433-8a99-010203040506',
    tables: KEYS.map(key => {
      const body = pages[key].map(page => page.ndjson).join('');
      return { key, rows: pages[key].reduce((sum, page) => sum + page.count, 0), bytes: Buffer.byteLength(body), sha256: hash(body) };
    }),
    excluded_system_keys: ['ios_config', 'auto_cleanup_schedule'], full_site_complete: false,
  };
  const calls = { catalog: 0, pages: [], verify: 0 };
  const events = [];
  const source = {
    async catalog() { calls.catalog++; events.push('catalog'); return catalog; },
    async page(key, after, signal) {
      calls.pages.push({ key, after, signal });
      events.push(`page:${key}:${after}`);
      const index = after === null ? 0 : pages[key].findIndex(page => page.next_after === after) + 1;
      assert.ok(index >= 0 && index < pages[key].length, 'unexpected page request');
      return pages[key][index];
    },
    async verify() {
      calls.verify++;
      events.push('verify');
      return { verified: true, scope: 'shared-settings', full_site_complete: false };
    },
  };
  return { catalog, pages, source, calls, events };
}
function temporarySink(events = []) {
  const files = new Map();
  return {
    files, appends: [], aborts: [], invalidated: false,
    async append(path, chunk, signal) {
      assert.equal(this.invalidated, false, 'no append after abort');
      assert.ok(chunk instanceof Uint8Array);
      this.appends.push({ path, bytes: chunk.length, signal });
      events.push(`append:${path}:${chunk.length}`);
      if (!files.has(path)) files.set(path, []);
      files.get(path).push(Buffer.from(chunk));
    },
    async abort(reason) {
      this.aborts.push(reason);
      this.invalidated = true;
      files.clear();
      events.push('abort');
    },
  };
}
async function rejectExport(value, options = {}, sink = temporarySink()) {
  let result;
  const progress = [];
  await assert.rejects(async () => {
    result = await api.exportSharedSettings(value.source, sink, { onProgress: p => progress.push(p), ...options });
  });
  assert.equal(result, undefined);
  assert.equal(sink.aborts.length, 1);
  assert.equal(sink.files.size, 0);
  return { sink, progress };
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

// The row parser validates JSON objects and duplicate keys, not business columns/roles/credentials.
// Unknown row fields remain SQL-whitelist responsibility; unknown response/catalog fields are rejected.
test('normal pagination preserves original Unicode/formatting, exact entries and partial-site identity', async () => {
  const value = fixture();
  value.catalog.tables.reverse(); // Export order is fixed, not controlled by the response.
  const sink = temporarySink(value.events);
  const progress = [];
  const result = await api.exportSharedSettings(value.source, sink, { onProgress: p => progress.push(p) });
  assert.deepEqual(api.SHARED_TABLE_KEYS, KEYS);
  assert.ok(Object.isFrozen(api.SHARED_TABLE_KEYS));
  assert.deepEqual(result.catalog, value.catalog);
  assert.notEqual(result.catalog, value.catalog);
  assert.notEqual(result.catalog.tables[0], value.catalog.tables[0]);
  assert.notEqual(result.catalog.excluded_system_keys, value.catalog.excluded_system_keys);
  assert.deepEqual(result.entries, KEYS.map(key => {
    const body = defaults[key].join('');
    assert.deepEqual(Buffer.concat(sink.files.get(pathFor(key))), Buffer.from(body));
    return { path: pathFor(key), bytes: Buffer.byteLength(body), sha256: hash(body), kind: 'ndjson' };
  }));
  assert.deepEqual(value.calls.pages.map(({ key, after }) => [key, after]), [
    ['admins', null], ['admins', 'cursor-1'], ...KEYS.slice(1).map(key => [key, null]),
  ]);
  assert.equal(value.calls.catalog, 1);
  assert.equal(value.calls.verify, 1);
  assert.equal(value.events.at(-1), 'verify');
  assert.equal(sink.aborts.length, 0);
  assert.equal(result.fullSiteComplete, false);
  assert.equal(result.catalog.full_site_complete, false);
  assert.equal(result.rows, value.catalog.tables.reduce((sum, table) => sum + table.rows, 0));
  assert.equal(result.bytes, value.catalog.tables.reduce((sum, table) => sum + table.bytes, 0));
  assert.equal(progress.length, sink.appends.length);
  let written = 0;
  let rows = 0;
  sink.appends.forEach((append, index) => {
    const { key } = value.calls.pages[index];
    const page = value.pages[key][index === 1 ? 1 : 0];
    written += append.bytes;
    rows += page.count;
    assert.deepEqual(progress[index], { scope: 'shared-settings', tableKey: key, rows, bytes: written, fullSiteComplete: false });
  });
  assert.ok(!JSON.stringify(progress).includes('local-only-sensitive-hash'));
  // UTF-8 byte counts are not UTF-16 string lengths, and reserializing loses source formatting.
  assert.notEqual(Buffer.byteLength(defaults.admins[0]), defaults.admins[0].length);
  assert.notEqual(hash(defaults.admins[0]), hash(JSON.stringify(JSON.parse(defaults.admins[0])) + '\n'));
});

test('all empty tables still append an empty file exactly once, then verify', async () => {
  const value = fixture({});
  const sink = temporarySink();
  const progress = [];
  const result = await api.exportSharedSettings(value.source, sink, { onProgress: p => progress.push(p) });
  assert.equal(sink.files.size, 7);
  assert.equal(sink.appends.length, 7);
  assert.ok(sink.appends.every(append => append.bytes === 0));
  assert.ok(result.entries.every(entry => entry.bytes === 0 && entry.sha256 === hash('')));
  assert.ok(progress.every(p => p.bytes === 0 && p.rows === 0 && p.fullSiteComplete === false));
  assert.equal(result.rows, 0);
  assert.equal(result.bytes, 0);
  assert.equal(result.fullSiteComplete, false);
  assert.equal(value.calls.verify, 1);
});

const catalogCases = [
  ['missing table', c => c.tables.pop()],
  ['duplicate table', c => { c.tables[6] = { ...c.tables[0] }; }],
  ['unknown table', c => { c.tables[0].key = 'users'; }],
  ['unknown body field', c => { c.body = 'sensitive'; }],
  ['unknown table field', c => { c.tables[0].extra = true; }],
  ['wrong version', c => { c.version = 2; }],
  ['wrong scope', c => { c.scope = 'full-site'; }],
  ['false completion required', c => { c.full_site_complete = true; }],
  ['invalid UUID', c => { c.site_id = 'not-a-site'; }],
  ['row cap', c => { c.tables[0].rows = 10001; }],
  ['negative rows', c => { c.tables[0].rows = -1; }],
  ['fractional rows', c => { c.tables[0].rows = 1.5; }],
  ['string rows', c => { c.tables[0].rows = '2'; }],
  ['unsafe rows', c => { c.tables[0].rows = Number.MAX_SAFE_INTEGER + 1; }],
  ['negative bytes', c => { c.tables[0].bytes = -1; }],
  ['NaN bytes', c => { c.tables[0].bytes = NaN; }],
  ['infinite bytes', c => { c.tables[0].bytes = Infinity; }],
  ['fractional bytes', c => { c.tables[0].bytes = 0.1; }],
  ['total byte cap', c => { c.tables[0].bytes = 8 * 1024 * 1024; c.tables[1].bytes = 1; }],
  ['single table byte cap', c => { c.tables[0].bytes = 8 * 1024 * 1024 + 1; }],
  ['uppercase SHA', c => { c.tables[0].sha256 = 'A'.repeat(64); }],
  ['short SHA', c => { c.tables[0].sha256 = 'a'.repeat(63); }],
  ['excluded key type', c => { c.excluded_system_keys = ['safe', null]; }],
  ['excluded keys not array', c => { c.excluded_system_keys = 'key'; }],
  ['unknown excluded key', c => { c.excluded_system_keys = ['unknown']; }],
  ['duplicate excluded key', c => { c.excluded_system_keys = ['ios_config', 'ios_config']; }],
  ['excluded metadata cap', c => { c.excluded_system_keys = Array(10000).fill('ios_config'); }],
  ['sparse excluded keys', c => { c.excluded_system_keys = new Array(1); }],
  ['sparse tables', c => { delete c.tables[1]; }],
  ['symbol property', c => { c[Symbol('unexpected')] = 1; }],
  ['non-enumerable property', c => { Object.defineProperty(c, 'extra', { value: 1 }); }],
  ['inherited fields', c => { Object.setPrototypeOf(c, { extra: 1 }); }],
  ['accessor field', c => { Object.defineProperty(c, 'scope', { get() { throw new Error('getter must not run'); } }); }],
];
for (const [name, mutate] of catalogCases) {
  test(`reject catalog: ${name} before reading/writing`, async () => {
    const value = fixture();
    mutate(value.catalog);
    const { sink, progress } = await rejectExport(value);
    assert.equal(value.calls.pages.length, 0);
    assert.equal(value.calls.verify, 0);
    assert.equal(sink.appends.length, 0);
    assert.deepEqual(progress, []);
  });
}
for (const value of [null, [], 'catalog', 1, new Date()]) {
  test(`reject non-object catalog ${String(value)}`, async () => {
    await rejectExport({ source: { async catalog() { return value; } } });
  });
}

test('plain null-prototype response objects are accepted and detached', async () => {
  const value = fixture({});
  value.source.catalog = async () => Object.assign(Object.create(null), value.catalog);
  const originalPage = value.source.page;
  value.source.page = async (...args) => Object.assign(Object.create(null), await originalPage(...args));
  value.source.verify = async () => Object.assign(Object.create(null), {
    verified: true, scope: 'shared-settings', full_site_complete: false,
  });
  assert.equal((await api.exportSharedSettings(value.source, temporarySink())).fullSiteComplete, false);
});

const pageCases = [
  ['bad SHA', p => { p.sha256 = '0'.repeat(64); }],
  ['uppercase SHA', p => { p.sha256 = 'A'.repeat(64); }],
  ['wrong count', p => { p.count++; }],
  ['negative count', p => { p.count = -1; }],
  ['fractional count', p => { p.count = 0.5; }],
  ['string count', p => { p.count = '1'; }],
  ['count cap', p => { p.count = 201; }],
  ['wrong table', p => { p.table_key = 'system_configs'; }],
  ['unknown body field', p => { p.body = 'sensitive'; }],
  ['missing field', p => { delete p.next_after; }],
  ['undefined cursor', p => { p.next_after = undefined; }],
  ['empty cursor', p => { p.next_after = ''; }],
  ['cursor length cap', p => { p.next_after = 'x'.repeat(129); }],
  ['non-string cursor', p => { p.next_after = 1; }],
  ['non-string NDJSON', p => { p.ndjson = {}; }],
  ['accessor', p => { Object.defineProperty(p, 'ndjson', { get() { throw new Error('must not run'); } }); }],
];
for (const [name, mutate] of pageCases) {
  test(`reject page: ${name} before append`, async () => {
    const value = fixture();
    mutate(value.pages.admins[0]);
    const { sink, progress } = await rejectExport(value);
    assert.equal(sink.appends.length, 0);
    assert.deepEqual(progress, []);
    assert.equal(value.calls.pages.length, 1);
    assert.equal(value.calls.verify, 0);
  });
}
for (const value of [null, [], 1, 'page']) {
  test(`reject non-object page ${String(value)}`, async () => {
    const data = fixture();
    data.source.page = async () => value;
    await rejectExport(data);
  });
}

const lineCases = [
  ['null row', 'null\n'], ['array row', '[]\n'], ['string row', '"text"\n'],
  ['number row', '1\n'], ['boolean row', 'true\n'], ['empty line', '\n'],
  ['whitespace line', ' \t\r\n'], ['invalid JSON', '{"sensitive":"local-only-sensitive-hash",}\n'],
  ['missing newline', '{}'], ['extra blank line', '{}\n\n'], ['two objects on one line', '{}{}\n'],
  ['duplicate top-level key', '{"a":1,"a":2}\n'],
  ['escaped duplicate key', '{"a":1,"\\u0061":2}\n'],
  ['duplicate nested key', '{"nested":[{"x":1,"x":2}]}\n'],
  ['duplicate escape/backslash key', '{"a\\\\b":1,"a\\u005cb":2}\n'],
  ['duplicate quote key', '{"a\\\"b":1,"a\\u0022b":2}\n'],
  ['duplicate empty key', '{"":1,"":2}\n'],
  ['duplicate prototype key', '{"__proto__":1,"__proto__":2}\n'],
  ['BOM', '\ufeff{}\n'], ['unpaired high surrogate', '{"x":"\ud800"}\n'],
  ['unpaired low surrogate', '{"x":"\udc00"}\n'],
  ['line over 64KiB', '{"x":"' + 'a'.repeat(64 * 1024 - 7) + '"}\n'],
  ['Unicode line bytes over cap', '{"x":"' + '汉'.repeat(22000) + '"}\n'],
  ['page over 256KiB', ('{"x":"' + 'a'.repeat(65528) + '"}\n').repeat(4)],
  ['Unicode page bytes over cap', ('{"x":"' + '汉'.repeat(20000) + '"}\n').repeat(5)],
];
for (const [name, body] of lineCases) {
  test(`reject NDJSON: ${name}, without leaking contents`, async () => {
    const value = fixture({ admins: [body] });
    const { sink, progress } = await rejectExport(value);
    assert.equal(sink.appends.length, 0);
    assert.deepEqual(progress, []);
    assert.ok(!sink.aborts[0].message.includes('local-only-sensitive-hash'));
    assert.ok(!sink.aborts[0].message.includes(body));
  });
}

test('row fields are opaque; distinct nested keys, braces/quotes in strings and noncanonical spelling are preserved', async () => {
  const bodies = [
    '{ "__proto__":1, "constructor":2, "":3, "object":{"x":1}, "array":[{"x":2},{"x":3}], "text":"}: \\"x\\": [", "a":1, "A":2 }\n',
    '{"unknown_sql_owned_field":true,"x":-0,"y":1.2300e+2,"value":"\\ud800","key\\\\":1,"a\\\"b":2}\r\n',
    '{"é":1,"é":2,"\\u0061":3,"nested":{"a":4}}\n',
    '{"deep":' + '['.repeat(10000) + '0' + ']'.repeat(10000) + '}\n',
  ];
  const value = fixture({ admins: bodies });
  const sink = temporarySink();
  const result = await api.exportSharedSettings(value.source, sink);
  assert.equal(result.rows, 4);
  assert.deepEqual(Buffer.concat(sink.files.get(pathFor('admins'))), Buffer.from(bodies.join('')));
});

test('accept exact line (excluding LF), page and row bounds using original bytes', async () => {
  const line = '{"x":"' + 'a'.repeat(65528) + '"}';
  assert.equal(Buffer.byteLength(line), 65536);
  const page = [line + '\n', line + '\n', line + '\n', '{"x":"' + 'b'.repeat(65524) + '"}\n'].join('');
  assert.equal(Buffer.byteLength(page), 256 * 1024);
  const rows = '{}\n'.repeat(200);
  const value = fixture({ admins: [page, rows] });
  const result = await api.exportSharedSettings(value.source, temporarySink());
  assert.equal(result.rows, 204);
  assert.equal(result.bytes, Buffer.byteLength(page + rows));
});

test('accept exactly 8MiB of business NDJSON without buffering it in the sink', async () => {
  const line = '{"x":"' + 'a'.repeat(65528) + '"}';
  const page = [line + '\n', line + '\n', line + '\n', '{"x":"' + 'b'.repeat(65524) + '"}\n'].join('');
  const value = fixture({ admins: Array(32).fill(page) });
  const digest = createHash('sha256');
  let bytes = 0;
  let writes = 0;
  const result = await api.exportSharedSettings(value.source, {
    async append(path, chunk) {
      writes++;
      bytes += chunk.length;
      if (path === pathFor('admins')) digest.update(chunk);
    },
    async abort() { assert.fail('valid boundary export must not abort'); },
  });
  assert.equal(bytes, 8 * 1024 * 1024);
  assert.equal(result.bytes, bytes);
  assert.equal(result.rows, 128);
  assert.equal(writes, 32 + 6);
  assert.equal(result.entries[0].sha256, digest.digest('hex'));
  assert.equal(result.fullSiteComplete, false);
});

test('actual row count over 200 is rejected even when declared count lies', async () => {
  const value = fixture({ admins: ['{}\n'.repeat(201)] });
  value.pages.admins[0].count = 200;
  const { sink } = await rejectExport(value);
  assert.equal(sink.appends.length, 0);
});

for (const [name, mutate] of [
  ['hash', table => { table.sha256 = '0'.repeat(64); }],
  ['rows', table => { table.rows++; }],
  ['bytes', table => { table.bytes++; }],
]) {
  test(`table total ${name} mismatch aborts all previously appended files`, async () => {
    const value = fixture();
    mutate(value.catalog.tables.find(table => table.key === 'system_configs'));
    const { sink, progress } = await rejectExport(value);
    assert.ok(sink.appends.length > 2);
    assert.equal(progress.length, sink.appends.length);
    assert.equal(value.calls.verify, 0);
    assert.ok(sink.aborts[0].message.includes('table totals'));
  });
}
for (const field of ['rows', 'bytes']) {
  test(`actual table ${field} exceeds catalog before writing excess page`, async () => {
    const value = fixture();
    value.catalog.tables[0][field] = 0;
    const { sink } = await rejectExport(value);
    assert.equal(sink.appends.length, 0);
  });
}

test('second-page checksum/count failures clean up the already written first page', async t => {
  for (const field of ['sha256', 'count']) {
    await t.test(field, async () => {
      const value = fixture();
      value.pages.admins[1][field] = field === 'count' ? 2 : '0'.repeat(64);
      const { sink, progress } = await rejectExport(value);
      assert.equal(sink.appends.length, 1);
      assert.equal(progress.length, 1);
      assert.equal(value.calls.verify, 0);
    });
  }
});

test('repeated/non-advancing and cyclic cursors fail without appending the offending page', async t => {
  for (const cycle of [false, true]) {
    await t.test(cycle ? 'older cursor cycle' : 'same cursor', async () => {
      const value = fixture({ admins: ['{}\n', '{}\n', '{}\n', '{}\n'] });
      value.pages.admins[cycle ? 2 : 1].next_after = 'cursor-1';
      const { sink, progress } = await rejectExport(value);
      assert.equal(sink.appends.length, cycle ? 2 : 1);
      assert.equal(progress.length, sink.appends.length);
      assert.equal(value.calls.pages.length, cycle ? 3 : 2);
    });
  }
});

test('empty page with continuation is rejected instead of spinning', async () => {
  const value = fixture({ admins: ['', '{}\n'] });
  const { sink } = await rejectExport(value);
  assert.equal(sink.appends.length, 0);
  assert.equal(value.calls.pages.length, 1);
});

test('cursor tokens are opaque, not lexically or numerically ordered', async () => {
  const value = fixture({ admins: ['{}\n', '{}\n', '{}\n'] });
  value.pages.admins[0].next_after = 'z';
  value.pages.admins[1].next_after = 'a';
  assert.equal((await api.exportSharedSettings(value.source, temporarySink())).rows, 3);
  assert.deepEqual(value.calls.pages.slice(0, 3).map(page => page.after), [null, 'z', 'a']);
});

test('real append backpressure: no prefetch, progress or verification until each write resolves', async () => {
  const value = fixture();
  const sink = temporarySink(value.events);
  const baseAppend = sink.append.bind(sink);
  const pending = [];
  sink.append = (path, bytes, signal) => {
    const gate = deferred();
    pending.push({ path, bytes, gate });
    return gate.promise.then(() => baseAppend(path, bytes, signal));
  };
  const progress = [];
  const completion = api.exportSharedSettings(value.source, sink, { onProgress: p => progress.push(p) });
  for (let index = 0; index < 8; index++) {
    await nextTurn();
    assert.equal(pending.length, index + 1);
    assert.equal(value.calls.pages.length, index + 1);
    assert.equal(sink.appends.length, index);
    assert.equal(progress.length, index);
    assert.equal(value.calls.verify, 0);
    await nextTurn(); // A real event-loop turn, not only a microtask assertion.
    assert.equal(pending.length, index + 1);
    pending[index].gate.resolve();
  }
  const result = await completion;
  assert.equal(progress.length, 8);
  assert.equal(value.calls.verify, 1);
  assert.equal(result.fullSiteComplete, false);
  for (let index = 1; index < value.calls.pages.length; index++) {
    const current = value.calls.pages[index];
    const previous = pending[index - 1];
    assert.ok(value.events.indexOf(`append:${previous.path}:${previous.bytes.length}`)
      < value.events.indexOf(`page:${current.key}:${current.after}`));
  }
});

for (const stage of ['catalog', 'page', 'verify']) {
  test(`source ${stage} rejection aborts without retries`, async () => {
    const value = fixture();
    const failure = new Error(`local ${stage} rejected`);
    let calls = 0;
    value.source[stage] = async () => { calls++; throw failure; };
    const { sink } = await rejectExport(value);
    assert.equal(calls, 1);
    assert.equal(sink.aborts[0], failure);
    if (stage === 'verify') assert.equal(sink.appends.length, 8);
  });
}

for (const response of [
  null, [], true, {}, { verified: false, scope: 'shared-settings', full_site_complete: false },
  { verified: true, scope: 'full-site', full_site_complete: false },
  { verified: true, scope: 'shared-settings', full_site_complete: true },
  { verified: true, scope: 'shared-settings', full_site_complete: false, body: 'unknown' },
]) {
  test(`invalid verification response ${JSON.stringify(response)} never returns success`, async () => {
    const value = fixture();
    value.source.verify = async () => response;
    const { sink } = await rejectExport(value);
    assert.equal(sink.appends.length, 8);
  });
}

test('verify is awaited after all appends before returning successful substage', async () => {
  const value = fixture();
  const gate = deferred();
  const sink = temporarySink();
  value.source.verify = async () => {
    assert.equal(sink.appends.length, 8);
    return gate.promise;
  };
  let finished = false;
  const completion = api.exportSharedSettings(value.source, sink).then(result => { finished = true; return result; });
  await nextTurn();
  assert.equal(finished, false);
  gate.resolve({ verified: true, scope: 'shared-settings', full_site_complete: false });
  assert.equal((await completion).fullSiteComplete, false);
});

test('sink failure is never retried; failed append has no progress and all temporary data is removed', async () => {
  const value = fixture();
  const sink = temporarySink();
  const baseAppend = sink.append.bind(sink);
  const failure = new Error('local sink failed');
  let calls = 0;
  sink.append = async (...args) => {
    calls++;
    if (calls === 2) throw failure;
    await baseAppend(...args);
  };
  const { progress } = await rejectExport(value, {}, sink);
  assert.equal(calls, 2);
  assert.equal(progress.length, 1);
  assert.equal(value.calls.pages.length, 2);
  assert.equal(value.calls.verify, 0);
  assert.equal(sink.aborts[0], failure);
});

test('a failed cleanup exposes a non-reusable workspace and retains the original error', async () => {
  const value = fixture();
  const failure = new Error('verify failure');
  value.source.verify = async () => { throw failure; };
  const sink = temporarySink();
  sink.abort = async reason => { sink.aborts.push(reason); throw new Error('sensitive-cleanup-detail'); };
  await assert.rejects(api.exportSharedSettings(value.source, sink), error => {
    assert.ok(error instanceof api.SharedExportCleanupError);
    assert.equal(error.cleanupRequired, true);
    assert.equal(error.originalError, failure);
    assert.doesNotMatch(error.message, /sensitive-cleanup-detail|local-only-sensitive-hash/);
    return true;
  });
  assert.equal(sink.aborts.length, 1);
  assert.ok(sink.files.size > 0, 'the failure must not pretend that sensitive files were deleted');
});

test('pre-cancelled export never invokes the source and still aborts temporary sink', async () => {
  const value = fixture();
  const controller = new AbortController();
  controller.abort('local-only-sensitive-hash');
  const { sink, progress } = await rejectExport(value, { signal: controller.signal });
  assert.equal(value.calls.catalog, 0);
  assert.equal(value.calls.pages.length, 0);
  assert.equal(sink.aborts[0].name, 'AbortError');
  assert.ok(!sink.aborts[0].message.includes('local-only-sensitive-hash'));
  assert.deepEqual(progress, []);
});

for (const stage of ['catalog', 'page', 'verify']) {
  for (const lateReject of [false, true]) {
    test(`cancel pending ${stage} promptly, including late ${lateReject ? 'rejection' : 'resolution'}`, async () => {
      const value = fixture();
      const controller = new AbortController();
      const gate = deferred();
      const entered = deferred();
      const sink = temporarySink();
      const progress = [];
      value.source[stage] = (...args) => {
        assert.equal(args.at(-1), controller.signal);
        entered.resolve();
        return gate.promise;
      };
      const rejection = assert.rejects(api.exportSharedSettings(value.source, sink, {
        signal: controller.signal, onProgress: p => progress.push(p),
      }), { name: 'AbortError' });
      await entered.promise;
      const before = progress.length;
      controller.abort();
      await settlesSoon(rejection);
      assert.equal(sink.aborts.length, 1);
      assert.equal(sink.files.size, 0);
      if (lateReject) gate.reject(new Error('late source failure'));
      else gate.resolve(stage === 'catalog' ? value.catalog : stage === 'page' ? value.pages.admins[0]
        : { verified: true, scope: 'shared-settings', full_site_complete: false });
      await nextTurn();
      assert.equal(progress.length, before);
      assert.equal(sink.files.size, 0);
      assert.equal(sink.aborts.length, 1);
    });
  }
}

for (const lateReject of [false, true]) {
  test(`cancel pending append without waiting; isolated sink rejects late ${lateReject ? 'failure' : 'write'}`, async () => {
    const value = fixture();
    const controller = new AbortController();
    const sink = temporarySink();
    const baseAppend = sink.append.bind(sink);
    const gate = deferred();
    const entered = deferred();
    const progress = [];
    let writes = 0;
    sink.append = async (path, bytes, signal) => {
      assert.equal(signal, controller.signal);
      writes++;
      if (writes === 2) {
        entered.resolve();
        await gate.promise;
        if (sink.invalidated) return; // Required sink contract: abort invalidates late writes.
      }
      await baseAppend(path, bytes, signal);
    };
    const rejection = assert.rejects(api.exportSharedSettings(value.source, sink, {
      signal: controller.signal, onProgress: p => progress.push(p),
    }), { name: 'AbortError' });
    await entered.promise;
    assert.equal(progress.length, 1);
    controller.abort();
    await settlesSoon(rejection);
    assert.equal(sink.aborts.length, 1);
    assert.equal(sink.files.size, 0);
    if (lateReject) gate.reject(new Error('late append failure'));
    else gate.resolve();
    await nextTurn();
    assert.equal(sink.files.size, 0);
    assert.equal(progress.length, 1);
    assert.equal(writes, 2);
    assert.equal(value.calls.pages.length, 2);
    assert.equal(value.calls.verify, 0);
  });
}

test('cancellation in progress callback stops before another page and preserves only confirmed progress', async () => {
  const value = fixture();
  const controller = new AbortController();
  const sink = temporarySink();
  let reports = 0;
  await assert.rejects(api.exportSharedSettings(value.source, sink, {
    signal: controller.signal,
    onProgress(progress) {
      reports++;
      assert.equal(progress.bytes, Buffer.byteLength(defaults.admins[0]));
      assert.equal(sink.appends.length, 1);
      controller.abort();
    },
  }), { name: 'AbortError' });
  assert.equal(reports, 1);
  assert.equal(value.calls.pages.length, 1);
  assert.equal(sink.files.size, 0);
  assert.equal(sink.aborts.length, 1);
});

test('progress callback failure aborts without leaking or continuing source reads', async () => {
  const value = fixture();
  const sink = temporarySink();
  const failure = new Error('local callback failed');
  await assert.rejects(api.exportSharedSettings(value.source, sink, { onProgress() { throw failure; } }), error => error === failure);
  assert.equal(value.calls.pages.length, 1);
  assert.equal(sink.files.size, 0);
  assert.equal(sink.aborts[0], failure);
});

test('stream 10000 rows across 50 pages, retaining only sink-owned output', async () => {
  const bodies = Array.from({ length: 50 }, (_, page) => Array.from({ length: 200 }, (_, row) =>
    `{"id":${page * 200 + row},"unicode":"中文𠮷"}\n`).join(''));
  const value = fixture({ admins: bodies });
  const digest = createHash('sha256');
  let writes = 0;
  let bytes = 0;
  let aborted = false;
  const result = await api.exportSharedSettings(value.source, {
    async append(path, chunk) {
      assert.equal(value.calls.pages.length, ++writes, 'not prefetched');
      if (path === pathFor('admins')) { digest.update(chunk); bytes += chunk.length; }
      // Deliberately do not store pages or rows in this streaming sink.
    },
    async abort() { aborted = true; },
  });
  assert.equal(aborted, false);
  assert.equal(result.rows, 10000);
  assert.equal(result.bytes, bytes);
  assert.equal(result.entries[0].sha256, digest.digest('hex'));
  assert.equal(result.entries[0].sha256, value.catalog.tables[0].sha256);
  assert.equal(result.fullSiteComplete, false);
});
