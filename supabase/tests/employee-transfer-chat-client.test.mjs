import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TRANSFER_SCOPE_COVERAGE_INVENTORY } from './support/transfer-scope.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SITE = '55555555-5555-4555-8555-555555555555', PACKAGE = '22222222-2222-4222-8222-222222222222';
const TIME = '2024-02-29T12:34:56.123456+00:00', SECRET = 'never-echo-chat-raw-or-backend-error';
const PRECISE = '12345678901234567890.12345678901234567890';
const TABLES = ['simulated_customers', 'cs_message_templates', 'customer_auto_messages', 'rich_card_contents',
  'customer_employee_conversations', 'customer_service_sessions', 'ccc_conversation_annotations',
  'customer_auto_message_logs', 'rating_requests', 'service_ratings'];
const CONFLICTS = ['source_employee_missing', 'source_admin_unmapped', 'source_reference_missing', 'source_scope_mismatch',
  'source_unique_collision', 'rich_card_unresolvable', 'source_visibility_unmapped'];
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const sha = value => createHash('sha256').update(value).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
const rowHash = text => sha(lines(text).map(sha).join(''));
const columns = key => TRANSFER_SCOPE_COVERAGE_INVENTORY.find(t => t.schema === 'public' && t.name === key).columns;
function row(key, n = 1) {
  const result = Object.fromEntries(columns(key).map(c => [c.name, ({ uuid: id(n), text: '原文é é 𠮷 \\ " \n', integer: 1,
    boolean: true, 'timestamp with time zone': TIME, 'uuid[]': [id(1), id(2)], jsonb: { nested: [{ id: 'nested', precise: 0 }] } })[c.type]]));
  if ('source_type' in result) result.source_type = 'aaa_service';
  if ('content_type' in result) result.content_type = 'rich_card';
  if (key === 'simulated_customers') result.badge_type = 'vip';
  if (key === 'customer_auto_messages') result.message_type = 'quick_send';
  if (key === 'customer_employee_conversations') Object.assign(result, { sender_type: 'customer', message_type: 'tip', rating_data_sql_null: false });
  if (key === 'customer_service_sessions') result.status = 'active';
  if (key === 'rating_requests') result.status = 'pending';
  if (key === 'ccc_conversation_annotations') result.id = `${result.customer_id}:${result.employee_id}`;
  return result;
}
const line = (key, n = 1) => JSON.stringify(row(key, n)).replace('"precise":0', `"precise":${PRECISE}`) + '\n';
const page = (key, raw, next_after = null) => ({ table_key: key, count: lines(raw).length, ndjson: raw, next_after, sha256: sha(raw) });
const ack = raw => ({ success: true, rows: lines(raw).length, bytes: Buffer.byteLength(raw), sha256: sha(raw), repeated: false });
const bound = () => ({ success: true, scope: 'site-chat', repeated: false, full_site_complete: false });
const verified = () => ({ verified: true, scope: 'site-chat', media_pending: true, full_site_complete: false });
const flags = () => ({ maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false });
function catalog(texts) {
  const identity = { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE, processing_orders: 0, full_site_complete: false,
    tables: ['accounts', 'credentials', 'orders'].map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })) };
  return { version: 1, scope: 'site-chat', site_id: SITE, package_id: PACKAGE, identity_catalog: identity,
    finance_catalog: { version: 1, scope: 'employee-finance', site_id: SITE, package_id: PACKAGE, identity_catalog: structuredClone(identity),
      tables: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit']
        .map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })), full_site_complete: false },
    tables: TABLES.map(key => ({ key, rows: lines(texts[key]).length, bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: rowHash(texts[key]) })), full_site_complete: false };
}
function role() {
  return { source_id: id(1), source_name: '原文角色𠮷', source_number: 'CUS-01', target_admin_id: id(2), source_type: 'ccc_service',
    match: 'ambiguous', target_id: null, candidates: [{ id: id(3), name: '新站角色', number: 'CUS-02' }], needs_confirmation: true,
    number_occupied: false, visibility_employee_ids: [id(4)], multi_source_target: true };
}
const plan = cat => ({ scope: 'site-chat', checked: true, can_restore: false, restore_pending: true, media_pending: true,
  counts: Object.fromEntries(cat.tables.map(t => [t.key, t.rows])), employees: 0, conflicts: [], roles: [role()], plan_hash: 'a'.repeat(64), ...flags() });
const redacted = error => { assert.ok(error instanceof Error); assert.equal(String(error).includes(SECRET), false); assert.equal('cause' in error, false); return true; };
mock.method(globalThis, 'fetch', () => assert.fail('network/production/Storage access forbidden'));
after(() => mock.restoreAll());
const compiled = await build({ entryPoints: [`${root}src/lib/employeeTransfer/chatTransfer.ts`], bundle: true, write: false,
  platform: 'browser', format: 'esm', target: 'es2020', metafile: true });
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
    f.calls.open.push(path); const key = TABLES.find(key => path === api.chatEntryPath(key)); assert.ok(key);
    const bytes = Buffer.from(f.texts[key]);
    return { async *[Symbol.asyncIterator]() { for (let i = 0; i < bytes.length; i += 13) yield bytes.subarray(i, i + 13); f.calls.eof.push(key); } };
  }, async abort() { f.calls.cleanup++; f.stored.clear(); } };
  f.target = { async bind(input) { assert.deepEqual(input, f.cat); assert.deepEqual(f.calls.eof, TABLES); f.calls.bind++; return bound(); },
    async stage(key, chunkNo, raw) { f.calls.stages.push({ key, chunkNo, raw }); return ack(raw); },
    async plan() { f.calls.plan++; return plan(f.cat); } };
  return f;
}
const run = (f, options = {}) => api.stageChatImport(f.cat, f.files, f.target, { onProgress: p => f.progress.push(p), ...options });
const exp = (f, options = {}) => api.exportChatData(f.source, f.sink, options);

test('fixed site-chat-v1 order, limits and lightweight dependencies', () => {
  assert.equal(api.CHAT_PROTOCOL, 'site-chat-v1'); assert.deepEqual(api.CHAT_TABLE_KEYS, TABLES); assert.deepEqual(api.CHAT_CONFLICT_REASONS, CONFLICTS);
  assert.deepEqual(api.CHAT_TRANSFER_LIMITS, { maxRows: 1000000, maxTableBytes: 536870912, maxTotalBytes: 1073741824,
    maxLineBytes: 65536, maxPageRows: 200, maxPageBytes: 262144, maxRoles: 2000, maxChunks: 1000001, maxInputBytes: 1048576 });
  assert.equal(Object.keys(compiled.metafile.inputs).some(p => /transfer-scope|node_modules|\/(?:container|crypto|manifest)\.ts$/.test(p)), false);
});
for (const key of TABLES) test(`${key}: fixed inventory columns, nullability, wrong types and escaped duplicate keys`, () => {
  assert.equal(api.validateChatRow(line(key), key), row(key).id);
  for (const c of columns(key)) {
    const missing = row(key); delete missing[c.name]; assert.throws(() => api.validateChatRow(JSON.stringify(missing), key), c.name);
    const wrong = row(key); wrong[c.name] = c.type === 'jsonb' ? undefined : {}; assert.throws(() => api.validateChatRow(JSON.stringify(wrong), key), c.name);
    const empty = row(key); empty[c.name] = null;
    if (c.nullable) assert.equal(api.validateChatRow(JSON.stringify(empty), key), empty.id, c.name);
    else assert.throws(() => api.validateChatRow(JSON.stringify(empty), key), c.name);
  }
  const extra = row(key); extra.secret = SECRET; assert.throws(() => api.validateChatRow(JSON.stringify(extra), key), redacted);
  for (const name of ['id', '\\u0069d']) assert.throws(() => api.validateChatRow(line(key).replace('{', `{"${name}":"${row(key).id}",`), key));
});
test('physical text administrator IDs are not coerced to UUIDs', () => {
  for (const key of ['cs_message_templates', 'customer_auto_messages']) { const r = row(key); r.admin_id = 'legacy-admin-text'; api.validateChatRow(JSON.stringify(r), key); }
});
test('SQL NULL marker is required and distinguishes JSON null and every raw JSON value', () => {
  const key = TABLES[4];
  for (const rating_data of [null, 1, true, '文字', [], { nested: [1, null] }]) {
    const r = { ...row(key), rating_data }; api.validateChatRow(JSON.stringify(r), key);
    r.rating_data_sql_null = true;
    if (rating_data === null) api.validateChatRow(JSON.stringify(r), key); else assert.throws(() => api.validateChatRow(JSON.stringify(r), key));
  }
  for (const marker of [null, 'false', 0]) assert.throws(() => api.validateChatRow(JSON.stringify({ ...row(key), rating_data_sql_null: marker }), key));
  const r = row(key); delete r.rating_data_sql_null; assert.throws(() => api.validateChatRow(JSON.stringify(r), key));
});
test('nested rating JSON preserves number lexemes, limits depth32 and rejects escaped duplicates/invalid Unicode', () => {
  const key = TABLES[4], raw = line(key);
  api.validateChatRow(raw.replace(PRECISE, '1e400'), key);
  for (const value of ['{"id":1,"\\u0069d":2}', '{"nested":{"x":1,"x":2}}', '"\\u0000"', '"\\ud800"']) {
    assert.throws(() => api.validateChatRow(JSON.stringify({ ...row(key), rating_data: null }).replace('"rating_data":null', `"rating_data":${value}`), key));
  }
  const nested = depth => JSON.stringify({ ...row(key), rating_data: null }).replace('"rating_data":null', `"rating_data":${'['.repeat(depth)}0${']'.repeat(depth)}`);
  api.validateChatRow(nested(32), key); assert.throws(() => api.validateChatRow(nested(33), key));
  api.validateChatRow(raw.replace('"id":"nested"', '"\\u0069d":"nested"'), key);
});
test('each UUID array member is validated; null and empty lists remain distinct', () => {
  const key = TABLES[0];
  for (const value of [null, [], [id(1), id(2)]]) api.validateChatRow(JSON.stringify({ ...row(key), target_employee_ids: value }), key);
  for (const value of [[null], [id(1), 'bad'], [id(1) + '\n'], [1], {}]) assert.throws(() => api.validateChatRow(JSON.stringify({ ...row(key), target_employee_ids: value }), key));
});
test('annotations virtual identity and cursor require exactly customer:employee UUIDs', () => {
  const key = TABLES[6], r = row(key); assert.equal(api.chatCursor(key, r.id), r.id);
  for (const value of [id(1), r.id + '\n', `${id(1)}:${id(2)}:x`, 'bad']) assert.throws(() => api.chatCursor(key, value));
  r.id = `${id(2)}:${id(1)}`; assert.throws(() => api.validateChatRow(JSON.stringify(r), key));
});
test('timestamps preserve NULL and microseconds while rejecting normalized invalid dates', () => {
  const key = TABLES[5];
  for (const time of [TIME, '2000-02-29T00:00:00Z', null]) api.validateChatRow(JSON.stringify({ ...row(key), created_at: time }), key);
  for (const time of ['2023-02-29T00:00:00Z', '2024-04-31T00:00:00Z', TIME + '\n', '2024-01-01T24:00:00Z']) assert.throws(() => api.validateChatRow(JSON.stringify({ ...row(key), created_at: time }), key));
});
test('catalog rejects wrong order, missing tables, date_runs, bounds and same-package dependency drift', () => {
  const f = fixture(); assert.deepEqual(api.validateChatCatalog(f.cat), f.cat);
  for (const change of [c => c.tables.reverse(), c => c.tables.pop(), c => { c.date_runs_supported = false; }, c => { c.tables[0].rows = 2001; },
    c => { c.tables[4].rows = 1000001; }, c => { c.tables[4].bytes = 536870913; }, c => { c.tables.forEach(t => { t.bytes = 536870912; }); },
    c => { c.finance_catalog.identity_catalog.processing_orders++; }, c => { c.identity_catalog.site_id = id(9); },
    c => { c.finance_catalog.tables[0].row_hashes_sha256 += '\n'; }, c => { c.site_id += '\n'; }, c => { c.tables[0].row_hashes_sha256 += '\n'; }]) {
    const c = structuredClone(f.cat); change(c); assert.throws(() => api.validateChatCatalog(c));
  }
  const c = structuredClone(f.cat); c.tables[4].rows = 1000000; c.tables[4].bytes = 536870912; api.validateChatCatalog(c);
});
test('catalog and role descriptors reject accessors, inherited/extra fields and sparse arrays', () => {
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.cat, 'site_id', { enumerable: true, get() { reads++; throw Error(SECRET); } });
  assert.throws(() => api.validateChatCatalog(f.cat)); assert.equal(reads, 0);
  for (const change of [r => { r.extra = true; }, r => { r.candidates[0].extra = true; }, r => { delete r.candidates[0]; },
    r => { r.visibility_employee_ids = [id(1), null]; }, r => { r.match = 'browser-guessed'; }, r => { r.source_type = 'other'; },
    r => { r.needs_confirmation = 1; }, r => { Object.setPrototypeOf(r, { secret: SECRET }); }]) {
    const p = plan(fixture().cat); change(p.roles[0]); assert.throws(() => api.validateChatPlan(p));
  }
});
test('plan preserves every server match/decision without browser inference and accepts only fixed conflicts', () => {
  for (const match of ['exact', 'name', 'ambiguous', 'number_conflict', 'new', 'unmapped']) {
    const p = plan(fixture().cat); Object.assign(p.roles[0], { match, target_admin_id: null, target_id: null });
    assert.deepEqual(api.validateChatPlan(p), p);
  }
  for (const reason of CONFLICTS) { const p = plan(fixture().cat); p.conflicts = [reason]; assert.deepEqual(api.validateChatPlan(p), p); }
  for (const field of ['checked', 'can_restore', 'restore_pending', 'media_pending', ...Object.keys(flags())]) {
    const p = plan(fixture().cat); p[field] = !p[field]; assert.throws(() => api.validateChatPlan(p));
  }
  for (const patch of [{ counts: {} }, { conflicts: [SECRET] }, { employees: 0.5 }, { plan_hash: 'a'.repeat(64) + '\n' },
    { roles: Array.from({ length: 2001 }, role) }, { automation_pending: true }]) assert.throws(() => api.validateChatPlan({ ...plan(fixture().cat), ...patch }));
  const p = plan(fixture().cat), checked = api.validateChatPlan(p); checked.roles[0].candidates[0].name = 'changed'; assert.notEqual(p.roles[0].candidates[0].name, 'changed');
});
test('page validates raw SHA, LF, count, C-order, composite cursor and limits', () => {
  const key = TABLES[6], raw = line(key, 1) + line(key, 2); api.validateChatPage(page(key, raw, row(key, 2).id), key, null);
  for (const bad of [page(key, line(key, 2) + line(key, 1)), page(key, line(key) + line(key)), page(key, raw, row(key).id),
    { ...page(key, raw), sha256: 'a'.repeat(64) }, { ...page(key, raw), count: 1 }, page(key, raw.trimEnd()), page(key, '', row(key).id),
    page(key, Array.from({ length: 201 }, (_, i) => line(key, i + 1)).join(''))]) assert.throws(() => api.validateChatPage(bad, key, null));
  assert.throws(() => api.validateChatPage(page(key, raw), key, row(key).id));
});
test('all ten tables round-trip original UTF8, NULL, JSON precision and SHA digests with no restore', async () => {
  const f = fixture(); const exported = await exp(f); assert.equal(exported.entries.length, 10); assert.equal(f.calls.verify, 1);
  for (const entry of exported.entries) { const key = TABLES.find(key => entry.path === api.chatEntryPath(key)); assert.equal(f.stored.get(entry.path).toString(), f.texts[key]); assert.equal(entry.sha256, sha(f.texts[key])); }
  assert.ok(f.texts[TABLES[4]].includes(PRECISE));
  const result = await run(f); assert.equal(result.rows, 10); assert.equal(result.plan.can_restore, false); assert.equal(result.fullSiteComplete, false);
  assert.deepEqual(f.calls.open, [...TABLES, ...TABLES].map(api.chatEntryPath)); assert.equal(f.calls.cleanup, 1);
  for (const stage of f.calls.stages) assert.equal(stage.raw, f.texts[stage.key]);
  assert.equal(f.progress.at(-1).phase, 'plan');
});
test('multi-page 203 rows per table stream in byte-exact chunks, including byte-boundary pages', async () => {
  const f = fixture(203); await exp(f); await run(f);
  for (const key of TABLES) { const chunks = f.calls.stages.filter(s => s.key === key); assert.equal(chunks.length, 2); assert.equal(chunks.map(s => s.raw).join(''), f.texts[key]); assert.deepEqual(chunks.map(s => s.chunkNo), [0, 1]); }
  const wide = fixture(); wide.texts[TABLES[3]] = Array.from({ length: 6 }, (_, n) => JSON.stringify({ ...row(TABLES[3], n + 1), html_content: '漢'.repeat(20000) }) + '\n').join('');
  wide.cat = catalog(wide.texts); await run(wide); assert.equal(wide.calls.stages.filter(s => s.key === TABLES[3]).length, 2);
});
test('empty tables still receive one explicit empty chunk and are cleaned', async () => {
  const f = fixture(0); await run(f); assert.equal(f.calls.stages.length, 10); assert.ok(f.calls.stages.every(s => s.raw === '' && s.chunkNo === 0));
});
for (const mode of ['digest', 'duplicate', 'UTF8', 'truncated']) test(`damaged last table ${mode} causes no bind or stage`, async () => {
  const f = fixture(); const last = TABLES.at(-1);
  if (mode === 'digest') f.texts[last] = f.texts[last].replace('原文', '變更');
  if (mode === 'duplicate') f.texts[last] = f.texts[last].replace('{', '{"id":"x",');
  if (mode === 'truncated') f.texts[last] = f.texts[last].slice(0, -1);
  if (mode === 'UTF8') { const open = f.files.open; f.files.open = path => path === api.chatEntryPath(last) ? { async *[Symbol.asyncIterator]() { yield new Uint8Array([0xff, 10]); } } : open(path); }
  await assert.rejects(run(f), redacted); assert.equal(f.calls.bind, 0); assert.equal(f.calls.stages.length, 0); assert.equal(f.calls.cleanup, 1);
});
test('second-read drift is rejected and warns that prior server staging may exist', async () => {
  const f = fixture(), open = f.files.open;
  f.files.open = path => { if (f.calls.open.length === 10) f.texts[TABLES[0]] = f.texts[TABLES[0]].replace('原文', '變更'); return open(path); };
  await assert.rejects(run(f), e => redacted(e) && e.stagingMayExist === true); assert.equal(f.calls.bind, 1); assert.equal(f.calls.cleanup, 1);
});
test('malformed final plan never claims restoration, unknown stage response never retries', async () => {
  const f = fixture(); f.target.plan = async () => ({ ...plan(f.cat), can_restore: true });
  await assert.rejects(run(f), e => e.stagingMayExist === true); assert.equal(f.calls.stages.length, 10);
  const g = fixture(); g.target.stage = async (...args) => { g.calls.stages.push(args); throw Error(SECRET); };
  await assert.rejects(run(g), e => redacted(e) && e.stagingMayExist === true); assert.equal(g.calls.stages.length, 1); assert.equal(g.calls.plan, 0);
});
test('export verification failure discards temporary data and redacts backend text', async () => {
  const f = fixture(); f.source.verify = async () => { throw Error(SECRET); };
  await assert.rejects(exp(f), redacted); assert.equal(f.calls.cleanup, 1); assert.equal(f.stored.size, 0);
});
test('pre-cancellation, validation cancellation and cancellation during successful cleanup discard plaintext', async () => {
  const before = fixture(), a = new AbortController(); a.abort(SECRET); await assert.rejects(run(before, { signal: a.signal }), redacted);
  assert.equal(before.calls.bind, 0); assert.equal(before.calls.cleanup, 1);
  const during = fixture(), b = new AbortController(); await assert.rejects(run(during, { signal: b.signal, onProgress() { b.abort(SECRET); } }), redacted); assert.equal(during.calls.bind, 0);
  const after = fixture(), c = new AbortController(); after.files.abort = async () => { after.calls.cleanup++; c.abort(SECRET); };
  await assert.rejects(run(after, { signal: c.signal }), e => redacted(e) && e.stagingMayExist && e.cancelled); assert.equal(after.calls.cleanup, 1);
});
test('cancellation interrupts a blocked reader, returns iterator and does not wait for late data', async () => {
  const f = fixture(), controller = new AbortController(); let returned = 0;
  f.files.open = () => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return() { returned++; return Promise.resolve({ done: true }); } }; } });
  const pending = run(f, { signal: controller.signal }); await Promise.resolve(); controller.abort(SECRET);
  await assert.rejects(pending, redacted); assert.equal(returned, 1); assert.equal(f.calls.bind, 0); assert.equal(f.calls.cleanup, 1);
});
test('64KiB line bound, UTF8 bytes, terminal LF and input chunk bounds are enforced', async () => {
  const key = TABLES[3], r = row(key); r.html_content = ''; const base = JSON.stringify(r) + '\n';
  r.html_content = 'x'.repeat(65536 - Buffer.byteLength(base)); const exact = JSON.stringify(r) + '\n';
  assert.equal(Buffer.byteLength(exact), 65536); api.validateChatRow(exact, key);
  r.html_content += 'x'; assert.throws(() => api.validateChatRow(JSON.stringify(r) + '\n', key));
  r.html_content = '漢'.repeat(22000); assert.throws(() => api.validateChatRow(JSON.stringify(r), key));
  const f = fixture(); f.files.open = () => ({ async *[Symbol.asyncIterator]() { yield new Uint8Array(1048577); } });
  await assert.rejects(run(f)); assert.equal(f.calls.bind, 0); assert.equal(f.calls.cleanup, 1);
});
test('last-table second-pass drift preserves earlier staging but never yields a successful plan', async () => {
  const f = fixture(), original = f.target.stage;
  f.target.stage = async (...args) => {
    const receipt = await original(...args);
    if (args[0] === TABLES[8]) f.texts[TABLES[9]] = f.texts[TABLES[9]].replace('原文', '變更');
    return receipt;
  };
  await assert.rejects(run(f), e => redacted(e) && e.stagingMayExist); assert.equal(f.calls.stages.length, 9);
  assert.equal(f.calls.plan, 0); assert.equal(f.calls.cleanup, 1);
});
test('cancel during an unconfirmed bind stops staging and reports unknown server outcome', async () => {
  const f = fixture(), controller = new AbortController(); let calls = 0;
  f.target.bind = async () => { calls++; controller.abort(SECRET); return bound(); };
  await assert.rejects(run(f, { signal: controller.signal }), e => redacted(e) && e.stagingMayExist && e.cancelled);
  assert.equal(calls, 1); assert.equal(f.calls.stages.length, 0); assert.equal(f.calls.cleanup, 1);
});
test('isolated ten-entry manifest checks package, paths, bytes and digest shape but not ciphertext authentication', async () => {
  const f = fixture(), exported = await exp(f);
  const manifest = { version: 1, scope: 'replacement-backup', exportId: PACKAGE, volumeId: id(9), sourceSiteId: SITE,
    createdAt: TIME, volumeIndex: 1, volumeCount: 1, entries: exported.entries };
  api.validateChatManifest(manifest, f.cat);
  for (const change of [m => { m.exportId = id(9); }, m => { m.entries.reverse(); }, m => { m.entries[0].bytes++; }, m => { m.entries[0].sha256 += '\n'; }]) {
    const m = structuredClone(manifest); change(m); assert.throws(() => api.validateChatManifest(m, f.cat));
  }
});
test('cleanup failure has priority and never exposes cleanup contents', async () => {
  const f = fixture(); f.files.abort = async () => { throw Error(SECRET); };
  await assert.rejects(run(f), e => redacted(e) && e.cleanupRequired && e.stagingMayExist);
  const g = fixture(); g.source.verify = async () => { throw Error(SECRET); }; g.sink.abort = async () => { throw Error(SECRET); };
  await assert.rejects(exp(g), e => redacted(e) && e.cleanupRequired);
});
