import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { TRANSFER_PRODUCTION_COVERAGE_INVENTORY } from './support/transfer-scope.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const TABLES = ['content_audit_events', 'deleted_employee_accounts', 'deleted_employee_notifications',
  'content_audit_recipient_versions', 'deleted_employee_summaries', 'deleted_employee_withdrawals'];
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SESSION = id(8001), OTHER = id(8002), JOB = id(8003), TOKEN = id(8004), SITE = id(8005), PACKAGE = id(8006);
const TIME = '2024-02-29T12:34:56.123456+00:00', HASH = 'a'.repeat(64);
const SECRET = 'never-echo-archives-password-token-backend-or-plaintext';
const PRECISE = '12345678901234567890.12345678901234567890';
const FORBIDDEN = ['delivery_claim_token', 'delivery_claim_channel', 'delivery_claim_until', 'delivery_completed_claim_token',
  'password', 'password_hash', 'current_session_token', 'current_tab_id',
  'session_token', 'token_hash', 'access_token', 'refresh_token', 'service_role_key', 'anon_key'];
const RPC = {
  exportBegin: 'employee_export_archives_begin', page: 'get_employee_export_archives_page', exportVerify: 'employee_export_archives_verify',
  close: 'employee_export_archives_close', bind: 'employee_import_archives_bind', stage: 'employee_import_archives_stage',
  plan: 'get_employee_import_archives_plan', begin: 'employee_import_archives_begin', chunk: 'employee_import_archives_chunk',
  verify: 'employee_import_archives_verify', status: 'get_employee_import_archives_status',
};
const sha = value => createHash('sha256').update(value).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
const rowHash = text => sha(lines(text).map(sha).join(''));
function columns(key) {
  if (key === TABLES[4]) return [
    { name: 'id', type: 'uuid', nullable: false }, { name: 'employee_id', type: 'uuid', nullable: false },
    { name: 'source_present', type: 'boolean', nullable: false }, { name: 'is_verified', type: 'boolean', nullable: true },
    ...['total_income', 'available_balance', 'frozen_balance'].map(name => ({ name, type: 'numeric', nullable: true })),
    { name: 'total_orders', type: 'bigint', nullable: false },
  ];
  if (key === TABLES[5]) return [
    { name: 'id', type: 'composite', nullable: false }, { name: 'record_id', type: 'uuid', nullable: false },
    { name: 'withdrawal_id', type: 'uuid', nullable: false }, { name: 'employee_id', type: 'uuid', nullable: false },
    { name: 'amount', type: 'numeric', nullable: false }, { name: 'status', type: 'text', nullable: false },
    { name: 'created_at', type: 'timestamp with time zone', nullable: true },
  ];
  const result = TRANSFER_PRODUCTION_COVERAGE_INVENTORY.find(t => t.schema === 'private' && t.name === key).columns.map(c => ({ ...c }));
  if (key === TABLES[0]) for (const name of ['before_data_sql_null', 'after_data_sql_null']) result.push({ name, type: 'boolean', nullable: false });
  if (key === TABLES[2]) for (const name of ['message_data_sql_null', 'recipient_data_sql_null']) result.push({ name, type: 'boolean', nullable: false });
  if (key === TABLES[3]) result.unshift({ name: 'id', type: 'composite', nullable: false });
  return result;
}
function row(key, n = 1) {
  const result = Object.fromEntries(columns(key).map(c => [c.name, ({ uuid: id(n), text: '原文é é 𠮷 \\ " \n', numeric: 0,
    boolean: true, bigint: '9223372036854775807', 'timestamp with time zone': TIME,
    jsonb: { snapshot: [{ precise: 0, text: 'password access_token delivery_claim_token are free text, not keys' }] }, composite: '' })[c.type]]));
  for (const key of Object.keys(result)) if (key.endsWith('_sql_null')) result[key] = false;
  if (key === TABLES[3]) result.id = `${result.message_id}:${result.recipient_id}`;
  if (key === TABLES[5]) result.id = `${result.record_id}:${result.withdrawal_id}`;
  return result;
}
const line = (key, n = 1) => JSON.stringify(row(key, n)).replaceAll('"precise":0', `"precise":${PRECISE}`)
  .replaceAll('"total_income":0', `"total_income":${PRECISE}`).replaceAll('"amount":0', `"amount":${PRECISE}`) + '\n';
const page = (key, raw, next_after = null) => ({ table_key: key, count: lines(raw).length, ndjson: raw, next_after, sha256: sha(raw) });
const ack = raw => ({ success: true, rows: lines(raw).length, bytes: Buffer.byteLength(raw), sha256: sha(raw), repeated: false });
const bound = () => ({ success: true, scope: 'site-archives', repeated: false, media_pending: true, full_site_complete: false });
const verified = () => ({ verified: true, scope: 'site-archives', media_pending: true, full_site_complete: false });
const closed = () => ({ success: true, scope: 'site-archives', media_pending: true, full_site_complete: false });
const flags = () => ({ maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false });
const counts = (value = 0) => Object.fromEntries(TABLES.map(key => [key, value]));
function catalog(texts = Object.fromEntries(TABLES.map(key => [key, '']))) {
  return { version: 1, scope: 'site-archives', site_id: SITE, package_id: PACKAGE,
    tables: TABLES.map(key => ({ key, rows: lines(texts[key]).length, bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: rowHash(texts[key]) })), full_site_complete: false };
}
const plan = cat => ({ scope: 'site-archives', checked: true, can_restore: true, counts: Object.fromEntries(cat.tables.map(t => [t.key, t.rows])),
  conflicts: [], plan_hash: HASH, media_pending: true, ...flags() });
function status(cat = catalog(), options = {}) {
  const started = options.started ?? true;
  return { scope: 'site-archives', started, records_verified: false, counts: Object.fromEntries(cat.tables.map(t => [t.key, t.rows])),
    chunks: Object.fromEntries(cat.tables.map(t => [t.key, started ? Math.max(1, Math.ceil(t.rows / 200)) : 0])),
    completed_chunks: counts(), media_pending: true, ...flags(), ...options };
}
const redacted = error => { assert.ok(error instanceof Error); assert.equal(String(error).includes(SECRET), false); assert.equal('cause' in error, false); return true; };
const uncertain = error => { redacted(error); assert.match(error.message, /unknown or unconfirmed/); assert.match(error.message, /Read server status/); return true; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
mock.method(globalThis, 'fetch', () => assert.fail('network/production/Storage access forbidden'));
after(() => mock.restoreAll());
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/archiveTransfer.ts';
  export * from './src/lib/employeeTransfer/archiveApi.ts'; export {setHarness} from 'archives-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'isolated-archives-transport', setup(builder) {
    builder.onResolve({ filter: /^(?:archives-test:state|\.\.\/(?:auth|supabase))$/ }, args => {
      if (args.path.startsWith('..')) assert.equal(args.importer, `${root}src/lib/employeeTransfer/archiveApi.ts`);
      return { path: args.path, namespace: 'archives-test' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'archives-test' }, ({ path }) => {
      if (path === 'archives-test:state') return { contents: 'let h; export const setHarness=v=>{h=v;}; export const current=()=>h;' };
      if (path === '../auth') return { contents: `import{current}from'archives-test:state';
        export function getAdminFinancialSessionToken(){const h=current();h.reads++;if(h.authError)throw h.authError;return h.session;}` };
      return { contents: "import{current}from'archives-test:state';export const supabase={rpc:(...args)=>current().rpc(...args)};" };
    });
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function fixture(n = 1) {
  const texts = Object.fromEntries(TABLES.map(key => [key, Array.from({ length: n }, (_, i) => line(key, i + 1)).join('')]));
  const f = { texts, cat: catalog(texts), calls: { open: [], eof: [], stages: [], bind: 0, plan: 0, verify: 0, cleanup: 0 }, stored: new Map(), progress: [] };
  f.source = { async catalog() { return f.cat; }, async page(key, after) {
    const all = lines(f.texts[key]); let index = after === null ? 0 : all.findIndex(s => JSON.parse(s).id === after) + 1;
    const result = []; let bytes = 0;
    while (index < all.length && result.length < 200 && bytes + Buffer.byteLength(all[index]) <= 262144) {
      bytes += Buffer.byteLength(all[index]); result.push(all[index++]);
    }
    return page(key, result.join(''), index < all.length ? JSON.parse(result.at(-1)).id : null);
  }, async verify() { f.calls.verify++; return verified(); } };
  f.sink = { async append(path, bytes) { f.stored.set(path, Buffer.concat([f.stored.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)])); },
    async abort() { f.calls.cleanup++; f.stored.clear(); } };
  f.files = { open(path) {
    f.calls.open.push(path); const key = TABLES.find(key => path === api.archivesEntryPath(key)); assert.ok(key);
    const bytes = Buffer.from(f.texts[key]);
    return { async *[Symbol.asyncIterator]() { for (let i = 0; i < bytes.length; i += 137) yield bytes.subarray(i, i + 137); f.calls.eof.push(key); } };
  }, async abort() { f.calls.cleanup++; f.stored.clear(); } };
  f.target = { async bind(input) { assert.deepEqual(input, f.cat); assert.deepEqual(f.calls.eof, TABLES); f.calls.bind++; return bound(); },
    async stage(key, chunkNo, raw) { f.calls.stages.push({ key, chunkNo, raw }); return ack(raw); },
    async plan() { f.calls.plan++; return plan(f.cat); } };
  return f;
}
const run = (f, options = {}) => api.stageArchivesImport(f.cat, f.files, f.target, { onProgress: p => f.progress.push(p), ...options });
const exp = (f, options = {}) => api.exportArchivesData(f.source, f.sink, options);
function harness() {
  const h = { calls: [], replies: [], session: SESSION, reads: 0, authError: null, respond(data) { h.replies.push({ data }); }, rpc(name, args) {
    assert.ok(Object.values(RPC).includes(name), `forbidden RPC ${name}`);
    const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
    assert.ok(h.replies.length, `unexpected RPC ${name}`); const reply = h.replies.shift(); if (reply.throw) throw reply.throw;
    const query = { abortSignal(signal) { call.signals.push(signal); return query; }, then(resolve, reject) {
      return Promise.resolve().then(() => {
        if (reply.reject) throw reply.reject;
        return reply.wait ?? { data: reply.data, error: reply.error ?? null };
      }).then(resolve, reject);
    } }; return query;
  } }; api.setHarness(h); return h;
}
const exportBegin = cat => ({ success: true, job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: cat, scope: 'site-archives', media_pending: true, full_site_complete: false });
async function exporting(h, cat = catalog()) {
  const s = api.createArchivesExportSession(PACKAGE, SECRET); h.respond(exportBegin(cat)); await s.begin(); return s;
}
async function importing(h, cat = fixture().cat) {
  const s = api.createArchivesImportSession(TOKEN); h.respond(bound()); await s.target.bind(cat); return s;
}
async function begun(h, cat = catalog(), options = {}) {
  const s = api.createArchivesRestoreSession(TOKEN, cat); h.respond(status(cat, options)); await s.begin(HASH); return s;
}

test('site-archives-v1 uses isolated six-key catalog, paths and fixed byte/row limits', () => {
  assert.equal(api.ARCHIVES_PROTOCOL, 'site-archives-v1'); assert.deepEqual(api.ARCHIVES_TABLE_KEYS, TABLES);
  assert.deepEqual(api.ARCHIVES_TRANSFER_LIMITS, { maxRows: 500000, maxTableBytes: 268435456, maxTotalBytes: 1073741824,
    maxLineBytes: 65536, maxPageRows: 200, maxPageBytes: 262144, maxChunks: 500001, maxInputBytes: 1048576 });
  assert.deepEqual(Object.keys(catalog()).sort(), ['version', 'scope', 'site_id', 'package_id', 'tables', 'full_site_complete'].sort());
  for (const key of TABLES) assert.equal(api.archivesEntryPath(key), `data/archives-${key}.ndjson`);
  assert.equal(Object.keys(compiled.metafile.inputs).some(p => /transfer-scope|node_modules|\/(?:container|crypto|manifest)\.ts$/.test(p)), false);
});
for (const key of TABLES) test(`${key}: exact inventory columns, nullability, types and no extra keys`, () => {
  assert.equal(api.validateArchivesRow(line(key), key), row(key).id);
  for (const c of columns(key)) {
    const missing = row(key); delete missing[c.name]; assert.throws(() => api.validateArchivesRow(JSON.stringify(missing), key), c.name);
    const wrong = row(key); wrong[c.name] = c.type === 'jsonb' ? undefined : {}; assert.throws(() => api.validateArchivesRow(JSON.stringify(wrong), key), c.name);
    const empty = row(key); empty[c.name] = null;
    if (c.nullable || c.type === 'jsonb') api.validateArchivesRow(JSON.stringify(empty), key);
    else assert.throws(() => api.validateArchivesRow(JSON.stringify(empty), key), c.name);
  }
  assert.throws(() => api.validateArchivesRow(JSON.stringify({ ...row(key), secret: SECRET }), key), redacted);
  for (const name of ['id', '\\u0069d']) assert.throws(() => api.validateArchivesRow(line(key).replace('{', `{"${name}":"${row(key).id}",`), key));
});
test('final event actor_admin_id can be SQL NULL without relaxing account actor_admin_id', () => {
  api.validateArchivesRow(JSON.stringify({ ...row(TABLES[0]), actor_admin_id: null }), TABLES[0]);
  assert.throws(() => api.validateArchivesRow(JSON.stringify({ ...row(TABLES[1]), actor_admin_id: null }), TABLES[1]));
});
for (const [key, field] of [[TABLES[0], 'before_data'], [TABLES[0], 'after_data'], [TABLES[2], 'message_data'], [TABLES[2], 'recipient_data']]) {
  test(`${key}.${field}: explicit SQL NULL differs from JSON null and all JSON scalar/container snapshots`, () => {
    for (const value of [null, 123, true, '原文', [], { nested: [null] }]) {
      const r = { ...row(key), [field]: value, [`${field}_sql_null`]: false }; api.validateArchivesRow(JSON.stringify(r), key);
      r[`${field}_sql_null`] = true;
      if (value === null) api.validateArchivesRow(JSON.stringify(r), key); else assert.throws(() => api.validateArchivesRow(JSON.stringify(r), key));
    }
    for (const value of [null, 'false', 0]) assert.throws(() => api.validateArchivesRow(JSON.stringify({ ...row(key), [`${field}_sql_null`]: value }), key));
  });
}
for (const [key, field] of [[TABLES[0], 'before_data'], [TABLES[0], 'after_data'], [TABLES[0], 'media_refs'],
  [TABLES[2], 'message_data'], [TABLES[2], 'recipient_data'], [TABLES[3], 'recipient_data']]) {
  test(`${key}.${field}: recursively rejects all 14 reserved keys, including escaped names`, () => {
    for (const forbidden of FORBIDDEN) for (const escaped of [false, true]) {
      const name = escaped ? `\\u${forbidden.charCodeAt(0).toString(16).padStart(4, '0')}${forbidden.slice(1)}` : forbidden;
      const r = JSON.stringify({ ...row(key), [field]: null }).replace(`"${field}":null`, `"${field}":{"outer":[{"${name}":"${SECRET}"}]}`);
      assert.throws(() => api.validateArchivesRow(r, key), redacted);
    }
    const r = { ...row(key), [field]: { free_text: FORBIDDEN.join(' ') } };
    api.validateArchivesRow(JSON.stringify(r), key); // No speculative string redaction.
  });
  test(`${key}.${field}: historical session/heartbeat times survive nested snapshots byte-for-byte`, async () => {
    const heartbeat = '2024-03-01T01:02:03.000001Z', f = fixture();
    const snapshot = { session_created_at: TIME, last_heartbeat_at: heartbeat,
      nested: [{ session_created_at: heartbeat, last_heartbeat_at: TIME, precise: 0 },
        { history: { session_created_at: null, last_heartbeat_at: '2024-02-29T12:34:56.654321+00:00' } }] };
    // Preserve even escaped-equivalent property spellings and raw numeric lexemes; do not stringify after validation.
    const raw = JSON.stringify({ ...row(key), [field]: snapshot })
      .replace('"session_created_at":', '"\\u0073ession_created_at":').replace('"precise":0', `"precise":${PRECISE}`) + '\n';
    assert.equal(api.validateArchivesRow(raw, key), row(key).id);
    f.texts[key] = raw; f.cat = catalog(f.texts);
    const exported = await exp(f), path = api.archivesEntryPath(key);
    assert.equal(f.stored.get(path).toString('utf8'), raw);
    assert.equal(exported.entries.find(entry => entry.path === path).sha256, sha(raw));
    await run(f);
    const staged = f.calls.stages.find(chunk => chunk.key === key).raw;
    assert.equal(staged, raw);
    const restored = JSON.parse(staged)[field];
    assert.equal(restored.session_created_at, TIME); assert.equal(restored.last_heartbeat_at, heartbeat);
    assert.equal(restored.nested[0].session_created_at, heartbeat); assert.equal(restored.nested[0].last_heartbeat_at, TIME);
    assert.deepEqual(restored.nested[1], snapshot.nested[1]);
    assert.ok(staged.includes(TIME)); assert.ok(staged.includes(heartbeat)); assert.ok(staged.includes(PRECISE));
    assert.ok(staged.includes('"\\u0073ession_created_at":'));
    assert.equal(f.calls.cleanup, 1);
  });
}
test('snapshot duplicates, escaped duplicates, invalid Unicode and depth >32 are rejected on ORIGINAL JSON', () => {
  const key = TABLES[0];
  const raw = value => JSON.stringify({ ...row(key), before_data: null }).replace('"before_data":null', `"before_data":${value}`);
  for (const value of ['{"id":1,"\\u0069d":2}', '{"inner":{"x":1,"x":2}}', '"\\u0000"', '"\\ud800"']) assert.throws(() => api.validateArchivesRow(raw(value), key));
  api.validateArchivesRow(raw('['.repeat(32) + '1e400' + ']'.repeat(32)), key);
  assert.throws(() => api.validateArchivesRow(raw('['.repeat(33) + '0' + ']'.repeat(33)), key));
  api.validateArchivesRow(raw('{"a":{"id":1},"b":{"id":2}}'), key);
});
test('summary required source_present, decimal bigint string and nullable numeric retain independent meanings', () => {
  const key = TABLES[4];
  for (const value of ['0', '9007199254740993', '9223372036854775807']) api.validateArchivesRow(JSON.stringify({ ...row(key), total_orders: value }), key);
  for (const value of [0, -1, '01', '-1', '1.0', '1e3', '9223372036854775808', '0\n', '1\r', '1\u2028', '1\u2029', null]) {
    assert.throws(() => api.validateArchivesRow(JSON.stringify({ ...row(key), total_orders: value }), key));
  }
  api.validateArchivesRow(JSON.stringify({ ...row(key), source_present: false, is_verified: null, total_income: null, available_balance: null, frozen_balance: null }), key);
  for (const value of [null, 0, 'false']) assert.throws(() => api.validateArchivesRow(JSON.stringify({ ...row(key), source_present: value }), key));
  api.validateArchivesRow(line(key).replace(PRECISE, '1e400'), key);
  assert.throws(() => api.validateArchivesRow(JSON.stringify({ ...row(key), total_income: PRECISE }), key));
});
for (const key of [TABLES[3], TABLES[5]]) test(`${key}: composite UUID cursor and original identity relation are exact`, () => {
  const r = row(key, 10); assert.equal(api.archivesCursor(key, r.id), r.id);
  for (const value of [id(1), r.id + '\n', r.id + '\r\n', `${id(1)}:${id(2)}:x`, r.id.toUpperCase(), 'bad']) assert.throws(() => api.archivesCursor(key, value));
  r.id = `${id(2)}:${id(1)}`; assert.throws(() => api.validateArchivesRow(JSON.stringify(r), key));
});
test('every physical UUID rejects trailing LF/CRLF and uppercase; UTC time preserves microseconds and rejects normalization', () => {
  for (const key of TABLES) for (const c of columns(key).filter(c => c.type === 'uuid')) {
    for (const value of [id(10) + '\n', id(10) + '\r\n', id(10).toUpperCase(), 'bad']) assert.throws(() => api.validateArchivesRow(JSON.stringify({ ...row(key), [c.name]: value }), key));
  }
  const key = TABLES[5];
  for (const value of [TIME, '2000-02-29T00:00:00Z', null]) api.validateArchivesRow(JSON.stringify({ ...row(key), created_at: value }), key);
  for (const value of ['2023-02-29T00:00:00Z', '2024-04-31T00:00:00Z', '0000-01-01T00:00:00Z', '2024-01-01T24:00:00Z', TIME + '\n',
    '2024-01-01T00:00:00+08:00', '2024-01-01T00:00:00.1234567Z']) assert.throws(() => api.validateArchivesRow(JSON.stringify({ ...row(key), created_at: value }), key));
});
test('catalog rejects extra dependency catalogs, invalid order, bounds, empty digests and suffix-anchor loopholes', () => {
  const f = fixture(); assert.deepEqual(api.validateArchivesCatalog(f.cat), f.cat);
  for (const change of [c => c.tables.reverse(), c => c.tables.pop(), c => { c.identity_catalog = {}; }, c => { c.version = 2; },
    c => { c.tables[0].rows = 500001; }, c => { c.tables[0].bytes = 268435457; }, c => { c.tables.forEach(t => { t.bytes = 268435456; }); },
    c => { c.site_id += '\n'; }, c => { c.package_id += '\r\n'; }, c => { c.tables[0].row_hashes_sha256 += '\n'; },
    c => { c.full_site_complete = true; }, c => { c.scope = 'site-chat'; }]) {
    const c = structuredClone(f.cat); change(c); assert.throws(() => api.validateArchivesCatalog(c));
  }
  const c = catalog(); c.tables[0].row_hashes_sha256 = HASH; assert.throws(() => api.validateArchivesCatalog(c));
  const max = structuredClone(f.cat); max.tables[0].rows = 500000; max.tables[0].bytes = 268435456; api.validateArchivesCatalog(max);
});
test('catalog rejects accessors, class instances, sparse and extra array properties without getter execution', () => {
  for (const mode of ['getter', 'array getter', 'sparse', 'symbol', 'class', 'array extra']) {
    const c = fixture().cat; let hits = 0;
    if (mode === 'getter') Object.defineProperty(c, 'site_id', { enumerable: true, get() { hits++; throw Error(SECRET); } });
    if (mode === 'array getter') Object.defineProperty(c.tables, '0', { enumerable: true, get() { hits++; throw Error(SECRET); } });
    if (mode === 'sparse') delete c.tables[0];
    if (mode === 'symbol') c[Symbol('secret')] = SECRET;
    if (mode === 'class') Object.setPrototypeOf(c, class {}.prototype);
    if (mode === 'array extra') c.tables.extra = SECRET;
    assert.throws(() => api.validateArchivesCatalog(c), redacted); assert.equal(hits, 0);
  }
});
test('pages enforce hash, LF, count, row order, after/next cursors and byte/row limits', () => {
  const key = TABLES[5], raw = line(key, 1) + line(key, 2); api.validateArchivesPage(page(key, raw, row(key, 2).id), key, null);
  for (const value of [page(key, line(key, 2) + line(key, 1)), page(key, line(key) + line(key)), page(key, raw, row(key).id),
    { ...page(key, raw), count: 1 }, { ...page(key, raw), sha256: HASH }, { ...page(key, raw), sha256: sha(raw) + '\n' },
    page(key, raw.trimEnd()), page(key, '', row(key).id), page(key, Array.from({ length: 201 }, (_, n) => line(key, n + 1)).join(''))]) {
    assert.throws(() => api.validateArchivesPage(value, key, null));
  }
  assert.throws(() => api.validateArchivesPage(page(key, raw), key, row(key).id));
  assert.throws(() => api.validateArchivesPage(page(key, raw), key, row(key).id + '\n'));
});
test('64KiB lines count UTF8 and terminal LF; page byte limit and input fragment cap are enforced', async () => {
  const key = TABLES[1], r = row(key); r.account_remarks = '';
  const base = JSON.stringify(r) + '\n'; r.account_remarks = 'x'.repeat(65536 - Buffer.byteLength(base));
  const exact = JSON.stringify(r) + '\n'; assert.equal(Buffer.byteLength(exact), 65536); api.validateArchivesRow(exact, key);
  r.account_remarks += 'x'; assert.throws(() => api.validateArchivesRow(JSON.stringify(r) + '\n', key));
  r.account_remarks = '漢'.repeat(22000); assert.throws(() => api.validateArchivesRow(JSON.stringify(r), key));
  const wide = Array.from({ length: 5 }, (_, i) => exact.replaceAll(id(1), id(i + 1))).join('');
  assert.throws(() => api.validateArchivesPage(page(key, wide), key, null));
  const f = fixture(); f.files.open = () => ({ async *[Symbol.asyncIterator]() { yield new Uint8Array(1048577); } });
  await assert.rejects(run(f)); assert.equal(f.calls.bind, 0); assert.equal(f.calls.cleanup, 1);
});
test('six-table round trip preserves all original UTF8/numeric lexemes, row hashes and SQL NULL markers', async () => {
  const f = fixture(2);
  f.texts[TABLES[0]] = [true, false].map((sqlNull, i) => JSON.stringify({ ...row(TABLES[0], i + 1), before_data: null, before_data_sql_null: sqlNull }) + '\n').join('');
  f.cat = catalog(f.texts); const exported = await exp(f); assert.equal(exported.entries.length, 6); assert.equal(f.calls.verify, 1);
  for (const entry of exported.entries) {
    const key = TABLES.find(key => entry.path === api.archivesEntryPath(key)); assert.equal(f.stored.get(entry.path).toString(), f.texts[key]); assert.equal(entry.sha256, sha(f.texts[key]));
  }
  const result = await run(f); assert.equal(result.rows, 12); assert.equal(result.fullSiteComplete, false); assert.equal(result.plan.media_pending, true);
  assert.deepEqual(f.calls.open, [...TABLES, ...TABLES].map(api.archivesEntryPath)); assert.equal(f.calls.cleanup, 1);
  for (const staged of f.calls.stages) assert.equal(staged.raw, f.texts[staged.key]);
  assert.ok(f.calls.stages.find(s => s.key === TABLES[4]).raw.includes(PRECISE));
  assert.deepEqual(lines(f.calls.stages[0].raw).map(s => JSON.parse(s).before_data_sql_null), [true, false]);
});
test('203 rows/table and byte-boundary staging are contiguous and byte exact', async () => {
  const f = fixture(203); await exp(f); await run(f);
  for (const key of TABLES) {
    const chunks = f.calls.stages.filter(s => s.key === key); assert.equal(chunks.length, 2); assert.deepEqual(chunks.map(s => s.chunkNo), [0, 1]);
    assert.equal(chunks.map(s => s.raw).join(''), f.texts[key]);
  }
  const wide = fixture(); wide.texts[TABLES[1]] = Array.from({ length: 6 }, (_, n) => JSON.stringify({ ...row(TABLES[1], n + 1), account_remarks: '漢'.repeat(19000) }) + '\n').join('');
  wide.cat = catalog(wide.texts); await exp(wide); await run(wide);
  assert.equal(wide.calls.stages.filter(s => s.key === TABLES[1]).length, 2);
});
test('empty tables still open and explicitly stage one empty chunk', async () => {
  const f = fixture(0); await exp(f); await run(f); assert.equal(f.calls.stages.length, 6); assert.ok(f.calls.stages.every(s => s.raw === '' && s.chunkNo === 0));
});
for (const mode of ['hash', 'duplicate', 'UTF8', 'truncated', 'order', 'reserved']) test(`last-table ${mode} fails ALL validation before bind`, async () => {
  const f = fixture(2), key = TABLES.at(-1);
  if (mode === 'hash') f.texts[key] = f.texts[key].replace('原文', '變更');
  if (mode === 'duplicate') f.texts[key] = f.texts[key].replace('{', '{"id":"x",');
  if (mode === 'truncated') f.texts[key] = f.texts[key].slice(0, -1);
  if (mode === 'order') f.texts[key] = lines(f.texts[key]).reverse().join('');
  if (mode === 'reserved') f.texts[TABLES[3]] = f.texts[TABLES[3]].replace('"snapshot":', '"password":');
  if (mode === 'UTF8') { const open = f.files.open; f.files.open = path => path === api.archivesEntryPath(key) ? { async *[Symbol.asyncIterator]() { yield new Uint8Array([0xff, 10]); } } : open(path); }
  await assert.rejects(run(f), redacted); assert.equal(f.calls.bind, 0); assert.equal(f.calls.stages.length, 0); assert.equal(f.calls.cleanup, 1);
});
test('second-read drift is rejected locally; earlier staging may remain and never produces a successful plan', async () => {
  const f = fixture(), stage = f.target.stage;
  f.target.stage = async (...args) => { const result = await stage(...args); if (args[0] === TABLES[4]) f.texts[TABLES[5]] = f.texts[TABLES[5]].replace('原文', '變更'); return result; };
  await assert.rejects(run(f), e => redacted(e) && e.stagingMayExist); assert.equal(f.calls.bind, 1); assert.equal(f.calls.stages.length, 5); assert.equal(f.calls.plan, 0); assert.equal(f.calls.cleanup, 1);
});
test('SQL contract fixture rejects second-pass drift dispatched at a full chunk BEFORE local end-of-table digest check', async () => {
  // Isolated local SQL contract, NOT the production archives RPC migration/permission/concurrency suite.
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`CREATE EXTENSION pgcrypto;
      CREATE TABLE archive_fixture_expected(key text PRIMARY KEY, digest text NOT NULL);
      CREATE TABLE archive_fixture_staged(key text PRIMARY KEY, raw text NOT NULL);
      CREATE FUNCTION archive_fixture_stage(k text, raw text) RETURNS void LANGUAGE plpgsql AS $$
      DECLARE actual text;
      BEGIN
        SELECT encode(digest(convert_to(coalesce(string_agg(encode(digest(convert_to(part||E'\\n','UTF8'),'sha256'),'hex'),'' ORDER BY ord),''),'UTF8'),'sha256'),'hex')
        INTO actual FROM unnest(string_to_array(left(raw,length(raw)-1),E'\\n')) WITH ORDINALITY s(part,ord);
        IF actual IS DISTINCT FROM (SELECT digest FROM archive_fixture_expected WHERE key=k) THEN RAISE EXCEPTION 'archive row hash drift'; END IF;
        INSERT INTO archive_fixture_staged VALUES(k,raw);
      END $$;`);
    const f = fixture(0); f.texts[TABLES[0]] = Array.from({ length: 200 }, (_, n) => line(TABLES[0], n + 1)).join(''); f.cat = catalog(f.texts);
    const expected = f.cat.tables[0].row_hashes_sha256; await db.query('INSERT INTO archive_fixture_expected VALUES($1,$2)', [TABLES[0], expected]);
    await db.query('SELECT archive_fixture_stage($1,$2)', [TABLES[0], f.texts[TABLES[0]]]);
    assert.equal((await db.query('SELECT raw FROM archive_fixture_staged')).rows[0].raw, f.texts[TABLES[0]]);
    await db.exec('DELETE FROM archive_fixture_staged');
    const originalBind = f.target.bind; let sqlRejections = 0;
    f.target.bind = async input => { const result = await originalBind(input); f.texts[TABLES[0]] = f.texts[TABLES[0]].replaceAll('原文', '變更'); return result; };
    f.target.stage = async (key, chunkNo, raw) => {
      f.calls.stages.push({ key, chunkNo, raw });
      try { await db.query('SELECT archive_fixture_stage($1,$2)', [key, raw]); }
      catch (error) { assert.match(error.message, /archive row hash drift/); sqlRejections++; throw error; }
      return ack(raw);
    };
    await assert.rejects(run(f), e => e.stagingMayExist === true); assert.equal(sqlRejections, 1); assert.equal(f.calls.stages.length, 1);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM archive_fixture_staged')).rows[0].n, 0); assert.equal(f.calls.plan, 0);
  } finally { await db.close(); }
});
test('pre-cancel, validate-cancel and cleanup-cancel discard plaintext and retain staging risk', async () => {
  const a = new AbortController(), before = fixture(); a.abort(SECRET); await assert.rejects(run(before, { signal: a.signal }), redacted); assert.equal(before.calls.bind, 0); assert.equal(before.calls.cleanup, 1);
  const b = new AbortController(), during = fixture(); await assert.rejects(run(during, { signal: b.signal, onProgress() { b.abort(SECRET); } }), redacted); assert.equal(during.calls.bind, 0);
  const c = new AbortController(), after = fixture(); after.files.abort = async () => { after.calls.cleanup++; c.abort(SECRET); };
  await assert.rejects(run(after, { signal: c.signal }), e => redacted(e) && e.stagingMayExist && e.cancelled); assert.equal(after.calls.cleanup, 1);
});
test('blocked iterator/reader cancellation returns or cancels without waiting for late data', async () => {
  for (const stream of [false, true]) {
    const f = fixture(), c = new AbortController(); let stopped = 0;
    f.files.open = () => stream ? new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { stopped++; } })
      : { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return() { stopped++; return Promise.resolve({ done: true }); } }; } };
    const pending = run(f, { signal: c.signal }); await tick(); c.abort(SECRET);
    await assert.rejects(pending, redacted); assert.equal(stopped, 1); assert.equal(f.calls.bind, 0); assert.equal(f.calls.cleanup, 1);
  }
});
test('unconfirmed bind/stage and cancellation never automatically retry, restore or roll back', async () => {
  for (const where of ['bind', 'stage']) {
    const f = fixture(), c = new AbortController(); let calls = 0;
    f.target[where] = async () => { calls++; c.abort(SECRET); throw Error(SECRET); };
    await assert.rejects(run(f, { signal: c.signal }), e => redacted(e) && e.stagingMayExist && e.cancelled); assert.equal(calls, 1); assert.equal(f.calls.plan, 0); assert.equal(f.calls.cleanup, 1);
  }
});
test('export verify failure or cancellation clears temporary sink; cleanup failure has priority and is redacted', async () => {
  const f = fixture(); f.source.verify = async () => { throw Error(SECRET); }; await assert.rejects(exp(f), redacted); assert.equal(f.stored.size, 0); assert.equal(f.calls.cleanup, 1);
  const g = fixture(); g.files.abort = async () => { throw Error(SECRET); };
  await assert.rejects(run(g), e => redacted(e) && e.cleanupRequired && e.stagingMayExist);
  f.sink.abort = async () => { throw Error(SECRET); }; await assert.rejects(exp(f), e => redacted(e) && e.cleanupRequired && !e.stagingMayExist);
  const c = new AbortController(), late = fixture(), wait = deferred(); let invalidated = false;
  late.sink.append = async () => { await wait.promise; assert.equal(invalidated, true); };
  late.sink.abort = async () => { invalidated = true; late.calls.cleanup++; };
  const pending = exp(late, { signal: c.signal }); await tick(); c.abort(SECRET); await assert.rejects(pending, redacted); wait.resolve(); await tick(); assert.equal(late.calls.cleanup, 1);
});
test('isolated six-entry manifest requires same site/package, exact paths/bytes/order and whole digest; not ciphertext authentication', async () => {
  const f = fixture(), result = await exp(f);
  const manifest = { version: 1, scope: 'replacement-backup', exportId: PACKAGE, volumeId: id(9), sourceSiteId: SITE,
    createdAt: TIME, volumeIndex: 1, volumeCount: 1, entries: result.entries };
  api.validateArchivesManifest(manifest, f.cat);
  for (const patch of [m => { m.exportId = OTHER; }, m => { m.sourceSiteId = OTHER; }, m => { m.entries.reverse(); },
    m => { m.entries[0].bytes++; }, m => { m.entries[0].path = 'data/chat-content_audit_events.ndjson'; }, m => { m.entries[0].sha256 += '\n'; },
    m => { m.volumeCount = 2; }, m => { m.entries.push(m.entries[0]); }]) {
    const m = structuredClone(manifest); patch(m); assert.throws(() => api.validateArchivesManifest(m, f.cat));
  }
});
test('plan preserves server decision only, fixed conflicts and pending flags without media/full-site claims', () => {
  const cat = fixture().cat; assert.deepEqual(api.validateArchivesPlan(plan(cat)), plan(cat));
  for (const conflict of ['archive_reference_missing', 'archive_record_conflict']) {
    const p = { ...plan(cat), can_restore: false, conflicts: [conflict] }; assert.deepEqual(api.validateArchivesPlan(p), p);
  }
  for (const patch of [{ can_restore: 1 }, { conflicts: ['unknown'] }, { conflicts: ['archive_record_conflict'] }, { media_pending: false }, { checked: false },
    { plan_hash: HASH + '\n' }, { counts: {} }, { restore_pending: true }]) assert.throws(() => api.validateArchivesPlan({ ...plan(cat), ...patch }));
  for (const field of Object.keys(flags())) assert.throws(() => api.validateArchivesPlan({ ...plan(cat), [field]: !flags()[field] }));
});

test('export begin is lazy, one-shot and detached; original owner session is read at dispatch', async () => {
  const h = harness(), cat = fixture().cat, s = api.createArchivesExportSession(PACKAGE, SECRET);
  assert.equal(h.reads, 0); assert.equal(s.identity(), null); h.session = OTHER; h.respond(exportBegin(cat)); const result = await s.begin();
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: OTHER, p_admin_password: SECRET, p_package_id: PACKAGE });
  result.tables[0].rows = 99; cat.tables[0].rows = 88; assert.deepEqual(await s.source.catalog(), fixture().cat);
  const identity = s.identity(); identity.jobToken = OTHER; assert.equal(s.identity().jobToken, TOKEN);
  await assert.rejects(s.begin()); assert.equal(h.calls.length, 1);
});
test('export page invalidates verification and close is explicit; composite cursor and p_limit are unchanged', async () => {
  const h = harness(), cat = fixture().cat, s = await exporting(h, cat), key = TABLES[3], after = `${id(1)}:${id(1)}`;
  await assert.rejects(s.close()); h.respond(verified()); await s.source.verify();
  h.session = OTHER; h.respond(page(key, '')); await s.source.page(key, after); await assert.rejects(s.close());
  assert.deepEqual(h.calls.at(-1).args, { p_admin_session_token: OTHER, p_job_token: TOKEN, p_table_key: key, p_after: after, p_limit: 200 });
  h.respond(verified()); await s.source.verify(); h.respond(closed()); await s.close(); const n = h.calls.length;
  for (const op of [() => s.source.page(key, null), () => s.source.verify(), () => s.source.catalog(), () => s.close()]) await assert.rejects(op());
  assert.equal(h.calls.length, n);
});
test('export unknown begin, pre-abort and malformed receipts never retain identity/password or retry', async () => {
  for (const mode of ['reject', 'wrong package', 'missing media', 'aborted']) {
    const h = harness(), s = api.createArchivesExportSession(PACKAGE, SECRET), c = new AbortController(), result = exportBegin(catalog());
    if (mode === 'reject') h.replies.push({ reject: Error(SECRET) });
    if (mode === 'wrong package') { result.catalog.package_id = OTHER; h.respond(result); }
    if (mode === 'missing media') { delete result.media_pending; h.respond(result); }
    if (mode === 'aborted') c.abort(SECRET);
    await assert.rejects(s.begin(c.signal), redacted); assert.equal(s.identity(), null); await assert.rejects(s.begin()); assert.equal(h.calls.length, mode === 'aborted' ? 0 : 1);
  }
});
test('import bind is immutable and stage relays original raw decimals with exact args and repeated acknowledgment', async () => {
  const h = harness(), cat = fixture().cat, s = await importing(h, cat); cat.tables[0].rows++;
  await assert.rejects(s.target.bind(cat), uncertain); assert.equal(h.calls.length, 1);
  h.session = OTHER; h.respond({ ...ack(line(TABLES[5])), repeated: true }); const r = await s.target.stage(TABLES[5], 0, line(TABLES[5]));
  assert.equal(r.repeated, true); assert.deepEqual(h.calls.at(-1).args, { p_admin_session_token: OTHER, p_job_token: TOKEN, p_table_key: TABLES[5], p_chunk_no: 0, p_ndjson: line(TABLES[5]) });
  h.respond(plan(fixture().cat)); await s.plan(); assert.equal(h.calls.at(-1).name, RPC.plan);
});
test('invalid keys, cursor, raw page, bound bytes and chunk numbers never dispatch', async () => {
  const h = harness(), s = await importing(h), raw = line(TABLES[5]), key = TABLES[5];
  for (const [k, n, text] of [['orders', 0, raw], [key, -1, raw], [key, 500001, raw], [key, 0, ''], [key, 0, raw.trimEnd()],
    [key, 0, raw.replace('{', '{"id":"bad",')], [key, 0, raw + raw], [key, 0, 'x'.repeat(262145)]]) await assert.rejects(s.target.stage(k, n, text), uncertain);
  assert.equal(h.calls.length, 1);
  const e = await exporting(h); const before = h.calls.length;
  for (const [k, cursor] of [['orders', null], [TABLES[3], id(1)], [TABLES[0], id(1) + '\n']]) await assert.rejects(e.source.page(k, cursor));
  assert.equal(h.calls.length, before);
});
test('unknown import bind/stage receipt requires explicit status then explicit resume, never automatic retry', async () => {
  for (const operation of ['bind', 'stage']) {
    const h = harness(), cat = fixture().cat, s = operation === 'bind' ? api.createArchivesImportSession(TOKEN) : await importing(h, cat);
    h.replies.push({ reject: Error(SECRET) }); const before = h.calls.length;
    await assert.rejects(operation === 'bind' ? s.target.bind(cat) : s.target.stage(TABLES[0], 0, line(TABLES[0])), uncertain);
    await assert.rejects(s.target.bind(cat), uncertain); await assert.rejects(s.target.stage(TABLES[0], 0, line(TABLES[0])), uncertain); await assert.rejects(s.plan(), uncertain);
    assert.equal(h.calls.length, before + 1);
    h.respond(status(cat, { started: false })); h.session = OTHER; await s.status();
    h.respond({ ...bound(), repeated: true }); await s.target.bind(cat);
    h.respond({ ...ack(line(TABLES[0])), repeated: true }); await s.target.stage(TABLES[0], 0, line(TABLES[0]));
    assert.ok(h.calls.slice(before + 1).every(c => c.args.p_admin_session_token === OTHER && c.args.p_job_token === TOKEN));
  }
});
test('lost bind acknowledgment accepts catalog-only unstarted status, then requires explicit identical rebind', async () => {
  const h = harness(), cat = fixture().cat, s = api.createArchivesImportSession(TOKEN);
  // The server may have committed ONLY the catalog; none of the six tables has been staged yet.
  h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.target.bind(cat), uncertain);
  await assert.rejects(s.target.bind(cat), uncertain); await assert.rejects(s.target.stage(TABLES[0], 0, line(TABLES[0])), uncertain);
  assert.deepEqual(h.calls.map(call => call.name), [RPC.bind]);
  h.session = OTHER; h.respond(status(cat, { started: false })); const checked = await s.status(); await tick();
  assert.deepEqual(checked.counts, Object.fromEntries(cat.tables.map(table => [table.key, table.rows])));
  assert.deepEqual(checked.chunks, counts()); assert.deepEqual(checked.completed_chunks, counts());
  assert.equal(checked.started, false); assert.equal(checked.records_verified, false);
  assert.deepEqual(h.calls.map(call => call.name), [RPC.bind, RPC.status]);
  // A successful read removes uncertainty but does not invent a confirmed bind or replay writes.
  await assert.rejects(s.target.stage(TABLES[0], 0, line(TABLES[0])), uncertain);
  const changed = structuredClone(cat); changed.package_id = OTHER; await assert.rejects(s.target.bind(changed), uncertain);
  assert.equal(h.calls.length, 2);
  h.respond({ ...bound(), repeated: true }); assert.equal((await s.target.bind(cat)).repeated, true);
  h.respond(ack(line(TABLES[0]))); await s.target.stage(TABLES[0], 0, line(TABLES[0]));
  assert.deepEqual(h.calls.map(call => call.name), [RPC.bind, RPC.status, RPC.bind, RPC.stage]);
  assert.deepEqual(h.calls[2].args, { p_admin_session_token: OTHER, p_job_token: TOKEN, p_catalog: cat });
  assert.equal(h.calls.filter(call => call.name === RPC.stage).length, 1);
});
test('lost partial-stage acknowledgment permits status then explicit SAME chunk without rebind or automatic retry', async () => {
  const h = harness(), f = fixture(0), key = TABLES[0];
  f.texts[key] = Array.from({ length: 203 }, (_, n) => line(key, n + 1)).join('');
  f.texts[TABLES[2]] = line(TABLES[2]); f.cat = catalog(f.texts);
  const s = await importing(h, f.cat), first = lines(f.texts[key]).slice(0, 100).join(''), last = lines(f.texts[key]).slice(100).join('');
  h.respond(ack(first)); await s.target.stage(key, 0, first);
  // The first table is only partially staged and the other five have NO stage calls.
  h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.target.stage(key, 1, last), uncertain);
  await assert.rejects(s.target.stage(key, 1, last), uncertain); await assert.rejects(s.target.bind(f.cat), uncertain); await assert.rejects(s.plan(), uncertain);
  assert.deepEqual(h.calls.map(call => call.name), [RPC.bind, RPC.stage, RPC.stage]);
  // Counts must describe the bound SOURCE catalog, not whatever staging has been acknowledged.
  const wrong = status(f.cat, { started: false }); wrong.counts[key] = 100; h.respond(wrong);
  await assert.rejects(s.status(), uncertain); await assert.rejects(s.target.stage(key, 1, last), uncertain); assert.equal(h.calls.length, 4);
  h.session = OTHER; h.respond(status(f.cat, { started: false })); const checked = await s.status(); await tick();
  assert.equal(checked.counts[key], 203); assert.equal(checked.counts[TABLES[2]], 1);
  assert.deepEqual(checked.chunks, counts()); assert.deepEqual(checked.completed_chunks, counts());
  assert.equal(h.calls.length, 5); assert.equal(h.calls.filter(call => call.name === RPC.bind).length, 1);
  h.respond({ ...ack(last), repeated: true }); assert.equal((await s.target.stage(key, 1, last)).repeated, true);
  assert.deepEqual(h.calls.map(call => call.name), [RPC.bind, RPC.stage, RPC.stage, RPC.status, RPC.status, RPC.stage]);
  assert.deepEqual(h.calls.at(-1).args, { ...h.calls[2].args, p_admin_session_token: OTHER });
  assert.equal(h.calls.at(-1).args.p_ndjson, last);
  assert.equal(h.calls.filter(call => call.name === RPC.stage).length, 3);
});
test('fresh import instance supports same-job rebind and reads newly authenticated tokens, never factory tokens', async () => {
  const h = harness(), cat = fixture().cat; await importing(h, cat); h.session = OTHER;
  const s = api.createArchivesImportSession(TOKEN); h.respond({ ...bound(), repeated: true }); await s.target.bind(cat);
  h.respond(ack(line(TABLES[0]))); await s.target.stage(TABLES[0], 0, line(TABLES[0])); h.respond(plan(cat)); await s.target.plan();
  assert.ok(h.calls.slice(1).every(c => c.args.p_job_token === TOKEN && c.args.p_admin_session_token === OTHER)); assert.equal(h.reads, h.calls.length);
});
test('malformed import acknowledgments require status and wrong plan counts never confer readiness', async () => {
  for (const patch of [{ rows: 0 }, { bytes: 0 }, { sha256: HASH + '\n' }, { repeated: 'yes' }, { extra: SECRET }]) {
    const h = harness(), s = await importing(h); h.respond({ ...ack(line(TABLES[0])), ...patch }); await assert.rejects(s.target.stage(TABLES[0], 0, line(TABLES[0])), uncertain);
    await assert.rejects(s.target.stage(TABLES[0], 0, line(TABLES[0])), uncertain); assert.equal(h.calls.length, 2);
  }
  const h = harness(), s = await importing(h), p = plan(fixture().cat); p.counts[TABLES[0]]++; h.respond(p); await assert.rejects(s.plan(), uncertain);
});
test('restore status before begin has zero chunks/completed and all six source counts; records verification never clears pending flags', () => {
  const cat = fixture().cat, value = status(cat, { started: false }); assert.deepEqual(api.validateArchivesStatus(value), value);
  for (const patch of [{ records_verified: true }, { chunks: counts(1) }, { completed_chunks: counts(1) }, { counts: {} },
    { media_pending: false }, { success: true }, { started: 'false' }]) assert.throws(() => api.validateArchivesStatus({ ...value, ...patch }));
  const done = status(cat, { records_verified: true, completed_chunks: counts(1) }); assert.deepEqual(api.validateArchivesStatus(done), done);
  for (const field of Object.keys(flags())) assert.throws(() => api.validateArchivesStatus({ ...done, [field]: !flags()[field] }));
});
test('restore factory exposes only four explicit operations and rejects bad tokens/catalog without RPC or auth', () => {
  const h = harness(), s = api.createArchivesRestoreSession(TOKEN, catalog()); assert.deepEqual(Object.keys(s).sort(), ['begin', 'chunk', 'status', 'verify']); assert.equal(h.reads, 0);
  for (const value of [null, TOKEN + '\n', TOKEN + '\r\n', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) assert.throws(() => api.createArchivesRestoreSession(value, catalog()), redacted);
  const cat = catalog(); cat.tables.reverse(); assert.throws(() => api.createArchivesRestoreSession(TOKEN, cat), redacted); assert.equal(h.calls.length, 0);
});
test('six-table actual chunk restore consumes server chunk counts and requires explicit final verify', async () => {
  const h = harness(), cat = fixture().cat, initial = status(cat), s = api.createArchivesRestoreSession(TOKEN, cat), signal = new AbortController().signal;
  h.respond(status(cat, { started: false })); await s.status(signal); h.session = OTHER; h.respond(initial); const result = await s.begin(HASH, signal);
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.counts)); assert.ok(Object.isFrozen(result.chunks));
  const completed = counts();
  for (const [index, key] of TABLES.entries()) {
    h.session = id(9000 + index); completed[key] = 1; h.respond(status(cat, { completed_chunks: { ...completed } }));
    await s.chunk(key, 0, signal);
    assert.deepEqual(h.calls.at(-1).args, { p_admin_session_token: id(9000 + index), p_job_token: TOKEN, p_table_key: key, p_chunk_no: 0 });
  }
  h.session = OTHER; h.respond(status(cat, { completed_chunks: counts(1), records_verified: true })); const done = await s.verify(signal);
  assert.equal(done.records_verified, true); assert.equal(done.media_pending, true); assert.equal(done.full_site_complete, false); assert.equal(done.replacement_ready, false);
  assert.equal(h.calls.length, 9); assert.equal(h.reads, 9); assert.ok(h.calls.every(c => c.signals[0] === signal));
  assert.deepEqual(h.calls[1].args, { p_admin_session_token: OTHER, p_job_token: TOKEN, p_plan_hash: HASH });
});
test('server byte-limited chunks are not guessed solely from row counts; skip/future chunks and premature verify are rejected', async () => {
  const h = harness(), f = fixture(5), key = TABLES[1], chunkCounts = counts(1); chunkCounts[key] = 3;
  const s = await begun(h, f.cat, { chunks: chunkCounts }); await assert.rejects(s.chunk(key, 1), uncertain); await assert.rejects(s.verify(), uncertain); assert.equal(h.calls.length, 1);
  for (let n = 0; n < 3; n++) {
    h.respond(status(f.cat, { chunks: chunkCounts, completed_chunks: { ...counts(), [key]: n + 1 } })); await s.chunk(key, n);
  }
  assert.equal(h.calls.length, 4);
});
for (const operation of ['begin', 'chunk', 'verify']) for (const mode of ['throw', 'reject', 'error', 'malformed']) {
  test(`restore ${operation}/${mode}: unknown write sends once, blocks writes until status, then explicit new-session resume`, async () => {
    const h = harness(), cat = fixture().cat;
    const s = operation === 'begin' ? api.createArchivesRestoreSession(TOKEN, cat) : await begun(h, cat);
    if (operation === 'verify') { h.respond(status(cat, { completed_chunks: counts(1) })); await s.status(); }
    const before = h.calls.length;
    if (mode === 'malformed') h.respond({ ...status(cat), media_pending: false });
    else h.replies.push(mode === 'error' ? { error: { message: SECRET } } : { [mode]: Error(SECRET) });
    await assert.rejects(operation === 'begin' ? s.begin(HASH) : operation === 'chunk' ? s.chunk(TABLES[0], 0) : s.verify(), uncertain);
    for (const op of [() => s.begin(HASH), () => s.chunk(TABLES[0], 0), () => s.verify()]) await assert.rejects(op(), uncertain);
    assert.equal(h.calls.length, before + 1);
    h.session = OTHER; const resumed = api.createArchivesRestoreSession(TOKEN, cat), completed = operation === 'verify' ? counts(1) : { ...counts(), [TABLES[0]]: 1 };
    await assert.rejects(resumed.chunk(TABLES[0], 0), uncertain); assert.equal(h.calls.length, before + 1);
    h.respond(status(cat, { completed_chunks: completed, records_verified: operation === 'verify' })); await resumed.status();
    if (operation !== 'verify') { h.respond(status(cat, { completed_chunks: completed })); await resumed.chunk(TABLES[0], 0); }
    assert.ok(h.calls.slice(before + 1).every(c => c.args.p_admin_session_token === OTHER && c.args.p_job_token === TOKEN));
  });
}
test('same restore session requires explicit status after unknown chunk and resumes only from confirmed server cursor', async () => {
  const h = harness(), cat = fixture().cat, s = await begun(h, cat); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.chunk(TABLES[0], 0), uncertain);
  h.respond(status(cat, { completed_chunks: { ...counts(), [TABLES[0]]: 1 } })); await s.status();
  h.respond(status(cat, { completed_chunks: { ...counts(), [TABLES[0]]: 1, [TABLES[1]]: 1 } })); await s.chunk(TABLES[1], 0);
  assert.deepEqual(h.calls.map(c => c.name), [RPC.begin, RPC.chunk, RPC.status, RPC.chunk]);
});
test('restore begin consumes one dispatched attempt; status never silently writes or retries begin', async () => {
  const h = harness(), cat = fixture().cat, s = api.createArchivesRestoreSession(TOKEN, cat); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.begin(HASH), uncertain);
  h.respond(status(cat, { started: false })); await s.status(); await assert.rejects(s.begin(HASH), uncertain); assert.equal(h.calls.length, 2);
  const fresh = api.createArchivesRestoreSession(TOKEN, cat); h.respond(status(cat, { started: false })); await fresh.status(); h.respond(status(cat)); await fresh.begin(HASH); assert.equal(h.calls.length, 4);
});
test('restore status validates source counts, stable chunk layout, monotonic progress and verified state', async () => {
  for (const patch of [{ counts: counts(99) }, { completed_chunks: counts(2) }, { records_verified: true }, { scope: 'site-chat' }, { chunks: {} }, { plan_hash: HASH }]) {
    const h = harness(), s = await begun(h, fixture().cat); h.respond({ ...status(fixture().cat), ...patch }); await assert.rejects(s.status(), uncertain);
    await assert.rejects(s.chunk(TABLES[0], 0), uncertain); assert.equal(h.calls.length, 2);
  }
  const h = harness(), cat = fixture().cat, s = await begun(h, cat); h.respond(status(cat, { completed_chunks: counts(1), records_verified: true })); await s.status();
  h.respond(status(cat, { completed_chunks: counts(1) })); await assert.rejects(s.status(), uncertain);
});
test('restore chunk receipt cannot advance another table, jump progress or assert verification; failed read does not unlock writes', async () => {
  for (const completed of [counts(1), counts(), { ...counts(), [TABLES[1]]: 1 }]) {
    const h = harness(), cat = fixture().cat, s = await begun(h, cat); h.respond(status(cat, { completed_chunks: completed }));
    await assert.rejects(s.chunk(TABLES[0], 0), uncertain); h.respond({ ...status(cat), media_pending: false }); await assert.rejects(s.status(), uncertain);
    await assert.rejects(s.chunk(TABLES[0], 0), uncertain); assert.equal(h.calls.length, 3);
  }
});
test('in-flight restore cancellation cannot adopt late success; concurrent rejection preserves active confirmation', async () => {
  const h = harness(), cat = fixture().cat, s = await begun(h, cat), c = new AbortController(), wait = deferred(); h.replies.push({ wait: wait.promise });
  const pending = s.chunk(TABLES[0], 0, c.signal); await tick();
  for (const op of [() => s.status(), () => s.verify(), () => s.chunk(TABLES[1], 0)]) await assert.rejects(op(), /in progress/);
  c.abort(SECRET); await assert.rejects(pending, e => uncertain(e) && e.name === 'AbortError');
  wait.resolve({ data: status(cat, { completed_chunks: { ...counts(), [TABLES[0]]: 1 } }), error: null }); await tick();
  await assert.rejects(s.chunk(TABLES[0], 0), uncertain); assert.equal(h.calls.length, 2);
  h.session = OTHER; h.respond(status(cat, { completed_chunks: { ...counts(), [TABLES[0]]: 1 } })); await s.status();
  const live = deferred(); h.replies.push({ wait: live.promise }); const active = s.chunk(TABLES[1], 0); await tick(); await assert.rejects(s.status(), /in progress/);
  live.resolve({ data: status(cat, { completed_chunks: { ...counts(), [TABLES[0]]: 1, [TABLES[1]]: 1 } }), error: null }); await active;
  h.respond(status(cat, { completed_chunks: { ...counts(), [TABLES[0]]: 1, [TABLES[1]]: 1, [TABLES[2]]: 1 } })); await s.chunk(TABLES[2], 0);
});
test('auth expiration and invalid tokens fail locally; new tokens are read on every operation', async () => {
  const h = harness(), cat = fixture().cat, s = await begun(h, cat); const n = h.calls.length;
  for (const token of [null, SESSION + '\n', SESSION + '\r\n', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']) { h.session = token; await assert.rejects(s.status(), uncertain); }
  h.authError = Error(SECRET); await assert.rejects(s.status(), uncertain); assert.equal(h.calls.length, n);
  h.authError = null; h.session = OTHER; h.respond(status(cat)); await s.status(); assert.equal(h.calls.at(-1).args.p_admin_session_token, OTHER);
  const i = await importing(h, cat); h.session = SESSION; h.respond(ack(line(TABLES[0]))); await i.target.stage(TABLES[0], 0, line(TABLES[0])); assert.equal(h.calls.at(-1).args.p_admin_session_token, SESSION);
});
test('malformed hash and catalog/receipt descriptors never expose getter/backend/abort contents', async () => {
  const h = harness(), cat = fixture().cat; let hits = 0;
  Object.defineProperty(cat, 'site_id', { enumerable: true, get() { hits++; throw Error(SECRET); } });
  assert.throws(() => api.createArchivesRestoreSession(TOKEN, cat), redacted); assert.equal(hits, 0);
  const s = api.createArchivesRestoreSession(TOKEN, fixture().cat);
  for (const digest of [HASH + '\n', HASH + '\r\n', HASH.toUpperCase(), null]) await assert.rejects(s.begin(digest), uncertain); assert.equal(h.calls.length, 0);
  await assert.rejects(s.status({ get aborted() { throw Error(SECRET); } }), redacted);
  const receipt = status(fixture().cat); Object.defineProperty(receipt, 'started', { enumerable: true, get() { hits++; throw Error(SECRET); } });
  h.respond(receipt); await assert.rejects(s.status(), redacted); assert.equal(hits, 0);
});
test('real export/import API composition validates all six tables before bind and never restores implicitly', async () => {
  const h = harness(), f = fixture(), source = await exporting(h, f.cat);
  for (const key of TABLES) h.respond(page(key, f.texts[key])); h.respond(verified());
  const result = await api.exportArchivesData(source.source, f.sink); assert.equal(result.fullSiteComplete, false);
  const target = api.createArchivesImportSession(TOKEN); h.respond(bound()); for (const key of TABLES) h.respond(ack(f.texts[key])); h.respond(plan(f.cat));
  const imported = await api.stageArchivesImport(result.catalog, f.files, target.target); assert.equal(imported.plan.can_restore, true);
  assert.equal(imported.plan.media_pending, true); assert.equal(f.calls.cleanup, 1); assert.deepEqual(f.calls.eof, [...TABLES, ...TABLES]);
  assert.equal(h.calls.some(c => [RPC.begin, RPC.chunk, RPC.verify, RPC.close].includes(c.name)), false); assert.equal(h.calls.filter(c => c.name === RPC.stage).length, 6);
});
test('API references only the eleven fixed public RPCs, no table insertion/media/delete transport', async () => {
  const text = await readFile(`${root}src/lib/employeeTransfer/archiveApi.ts`, 'utf8');
  for (const name of Object.values(RPC)) assert.ok(text.includes(`supabase.rpc('${name}'`), name);
  assert.equal(/ArchivesRpcArgs|as\s+unknown\s+as|rpc\.bind\(|\.from\(|functions\.invoke|service_role|\.delete\(|\.insert\(|as\s+any\b/.test(text), false);
});
