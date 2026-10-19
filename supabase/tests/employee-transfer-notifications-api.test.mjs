import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SESSION = '11111111-1111-4111-8111-111111111111', PACKAGE = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333', TOKEN = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555', OTHER = '66666666-6666-4666-8666-666666666666';
const PASSWORD = 'never-echo-notifications-password-or-backend-error', TIME = '2024-02-29T12:34:56.123456+00:00';
const TABLES = ['notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
  'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
  'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients',
  'message_templates', 'broadcast_messages', 'broadcast_recipients'];
const WRITES = ['employee_export_notifications_begin', 'employee_export_notifications_verify', 'employee_export_notifications_close',
  'employee_import_notifications_bind', 'employee_import_notifications_stage'];
const READS = ['get_employee_export_notifications_page', 'get_employee_import_notifications_plan'];
const sha = v => createHash('sha256').update(v).digest('hex');
const raw = JSON.stringify({ id: SESSION, sender_id: SESSION, sender_username: '原文𠮷', title: '通知', content: '原文é é 𠮷',
  message_type: 'realtime', priority: 'normal', expires_at: null, created_at: TIME, notification_category: 'standard',
  reward_amount: 0, reward_currency: null, automation_execution_id: null, delivery_mode: 'realtime_only', audit_origin: 'unverified' })
  .replace('"reward_amount":0', '"reward_amount":12345678901234567890.12345678901234567890') + '\n';
const ack = (value = raw) => ({ success: true, rows: value ? value.split('\n').length - 1 : 0, bytes: Buffer.byteLength(value), sha256: sha(value), repeated: false });
const bound = () => ({ success: true, scope: 'site-notifications', repeated: false, full_site_complete: false });
const verified = () => ({ verified: true, scope: 'site-notifications', media_pending: true, full_site_complete: false });
const closed = () => ({ success: true, scope: 'site-notifications', media_pending: true, full_site_complete: false });
const flags = () => ({ maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false });
function catalog(withMessage = true) {
  const identity = { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE, processing_orders: 0, full_site_complete: false,
    tables: ['accounts', 'credentials', 'orders'].map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })) };
  return { version: 1, scope: 'site-notifications', site_id: SITE, package_id: PACKAGE, identity_catalog: identity,
    finance_catalog: { version: 1, scope: 'employee-finance', site_id: SITE, package_id: PACKAGE, identity_catalog: structuredClone(identity),
      tables: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit']
        .map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })), full_site_complete: false },
    date_runs_supported: false, tables: TABLES.map(key => ({ key, rows: key === 'messages' && withMessage ? 1 : 0,
      bytes: key === 'messages' && withMessage ? Buffer.byteLength(raw) : 0, row_hashes_sha256: sha(key === 'messages' && withMessage ? sha(raw) : '') })), full_site_complete: false };
}
const begin = (cat = catalog()) => ({ success: true, job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: cat, scope: 'site-notifications', full_site_complete: false });
const page = (value = raw, key = 'messages') => ({ table_key: key, count: value ? value.split('\n').length - 1 : 0, ndjson: value, next_after: null, sha256: sha(value) });
const plan = (cat = catalog()) => ({ scope: 'site-notifications', checked: true, can_restore: false, restore_pending: true, media_pending: true,
  automation_pending: true, counts: Object.fromEntries(cat.tables.map(t => [t.key, t.rows])), employees: 0, rewards: 0, conflicts: [], plan_hash: 'a'.repeat(64), ...flags() });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function soon(promise) { let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cancellation stalled')), 1500); })]); }
  finally { clearTimeout(timer); }
}
const redacted = e => { assert.ok(e instanceof Error); assert.equal(String(e).includes(PASSWORD), false); assert.equal('cause' in e, false); return true; };
mock.method(globalThis, 'fetch', () => assert.fail('production/network access forbidden'));
after(() => mock.restoreAll());
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/notificationsTransfer.ts';
  export * from './src/lib/employeeTransfer/notificationsApi.ts'; export {setHarness} from 'notifications-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', plugins: [{ name: 'isolated-transport', setup(builder) {
    builder.onResolve({ filter: /^(?:notifications-test:state|\.\.\/(?:auth|supabase))$/ }, args => {
      if (args.path.startsWith('..')) assert.equal(args.importer, `${root}src/lib/employeeTransfer/notificationsApi.ts`);
      return { path: args.path, namespace: 'notifications-test' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'notifications-test' }, ({ path }) => {
      if (path === 'notifications-test:state') return { contents: 'let h; export const setHarness=v=>{h=v;}; export const current=()=>h;' };
      if (path === '../auth') return { contents: `import {current} from 'notifications-test:state'; export function getAdminFinancialSessionToken(){const h=current();h.reads++;return h.session;}` };
      return { contents: `import {current} from 'notifications-test:state'; export const supabase={rpc:(...args)=>current().rpc(...args)};` };
    });
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness() {
  const h = { calls: [], replies: [], reads: 0, session: SESSION,
    respond(data) { h.replies.push({ data }); }, rpc(name, args) {
      const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call); assert.ok(h.replies.length, `unexpected RPC ${name}`);
      const result = h.replies.shift(); if (result.throw) throw result.throw;
      const query = { abortSignal(signal) { call.signals.push(signal); return query; }, then(resolve, reject) {
        return Promise.resolve().then(() => { if (result.reject) throw result.reject; return result.wait ?? { data: result.data, error: result.error ?? null }; }).then(resolve, reject);
      } }; return query;
    } };
  api.setHarness(h); return h;
}
async function exporting(h) { const s = api.createNotificationsExportSession(PACKAGE, PASSWORD); h.respond(begin()); await s.begin(); return s; }
async function importing(h, cat = catalog()) { const s = api.createNotificationsImportSession(TOKEN); h.respond(bound()); await s.target.bind(cat); return s; }

test('lazy one-shot begin captures only financial session and exact auth/package/password; detached results', async () => {
  const h = harness(), s = api.createNotificationsExportSession(PACKAGE, PASSWORD); assert.equal(h.calls.length, 0); assert.equal(h.reads, 1); assert.equal(s.identity(), null);
  const server = begin(); h.respond(server); const c = await s.begin(); assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_admin_password: PASSWORD, p_package_id: PACKAGE });
  assert.equal(h.calls[0].name, WRITES[0]); assert.deepEqual(s.identity(), { jobId: JOB, jobToken: TOKEN });
  c.tables[0].rows = 99; c.finance_catalog.tables[0].rows = 99; server.catalog.identity_catalog.processing_orders = 1;
  assert.deepEqual(await s.source.catalog(), catalog()); const identity = s.identity(); identity.jobToken = OTHER; assert.equal(s.identity().jobToken, TOKEN);
  await assert.rejects(s.begin()); assert.equal(h.calls.length, 1);
});
for (const value of [null, '', 'bad', SESSION + '\n', SESSION.toUpperCase().replace('1111', 'AAAA')]) test(`factory rejects invalid session ${JSON.stringify(value)} before RPC`, () => {
  const h = harness(); h.session = value; assert.throws(() => api.createNotificationsExportSession(PACKAGE, PASSWORD)); assert.throws(() => api.createNotificationsImportSession(TOKEN)); assert.equal(h.calls.length, 0);
});
for (const mode of ['error', 'reject', 'throw', 'malformed', 'wrong package', 'wrong site', 'wrong scope', 'bad token']) test(`begin ${mode} sanitized, no retry or identity`, async () => {
  const h = harness(), s = api.createNotificationsExportSession(PACKAGE, PASSWORD), data = begin();
  if (mode === 'error') h.replies.push({ data: null, error: { message: PASSWORD } });
  else if (mode === 'reject') h.replies.push({ reject: Error(PASSWORD) });
  else if (mode === 'throw') h.replies.push({ throw: Error(PASSWORD) });
  else { if (mode === 'malformed') data.extra = PASSWORD;
    if (mode === 'wrong package') data.catalog.package_id = OTHER;
    if (mode === 'wrong site') data.site_id = OTHER;
    if (mode === 'wrong scope') data.scope = 'employee-activity';
    if (mode === 'bad token') data.job_token = TOKEN + '\n'; h.respond(data); }
  await assert.rejects(s.begin(), redacted); assert.equal(s.identity(), null); await assert.rejects(s.begin(), redacted); assert.equal(h.calls.length, 1);
});
test('pre-aborted begin consumes local attempt without sending password; pending begin mutually exclusive', async () => {
  const h = harness(), controller = new AbortController(), s = api.createNotificationsExportSession(PACKAGE, PASSWORD); controller.abort(PASSWORD);
  await assert.rejects(s.begin(controller.signal), redacted); await assert.rejects(s.begin()); assert.equal(h.calls.length, 0);
  const wait = deferred(), pending = api.createNotificationsExportSession(PACKAGE, PASSWORD); h.replies.push({ wait: wait.promise });
  const run = pending.begin(); await assert.rejects(pending.source.verify(), /in progress/); await assert.rejects(pending.begin()); assert.equal(h.calls.length, 1);
  wait.resolve({ data: begin(), error: null }); await run;
});
test('explicit export verify required before close; reading invalidates permission and nothing auto-closes', async () => {
  const h = harness(), s = await exporting(h); await assert.rejects(s.close()); assert.equal(h.calls.length, 1);
  h.respond(verified()); await s.source.verify(); h.respond(page()); await s.source.page('messages', null); await assert.rejects(s.close());
  h.respond(verified()); await s.source.verify(); h.respond(closed()); await s.close(); assert.deepEqual(h.calls.map(c => c.name), [WRITES[0], WRITES[1], READS[0], WRITES[1], WRITES[2]]);
  for (const action of [() => s.source.page('messages', null), () => s.source.verify(), () => s.source.catalog(), () => s.close()]) await assert.rejects(action());
  assert.equal(h.calls.length, 5);
});
test('page requests composite cursor unchanged with limit200 and financial token, validates response', async () => {
  const h = harness(), s = await exporting(h), controller = new AbortController();
  const after = `${SESSION}:0000000010:A:2024`, key = TABLES[6]; h.respond(page('', key));
  await s.source.page(key, after, controller.signal); assert.deepEqual(h.calls[1].args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_table_key: key, p_after: after, p_limit: 200 });
  assert.equal(h.calls[1].signals[0], controller.signal);
  await assert.rejects(s.source.page(key, `${SESSION}:10:A`)); await assert.rejects(s.source.page('orders', null)); assert.equal(h.calls.length, 2);
});
for (const field of ['verified', 'media_pending', 'full_site_complete', 'scope']) test(`malformed verify ${field} never unlocks close`, async () => {
  const h = harness(), s = await exporting(h), result = verified(); result[field] = field === 'scope' ? 'employee-activity' : !result[field]; h.respond(result);
  await assert.rejects(s.source.verify(), redacted); await assert.rejects(s.close()); assert.equal(h.calls.length, 2);
});
test('failed explicit verification revokes earlier permission; failed close never claims closed', async () => {
  const h = harness(), s = await exporting(h); h.respond(verified()); await s.source.verify(); h.replies.push({ reject: Error(PASSWORD) });
  await assert.rejects(s.source.verify(), redacted); await assert.rejects(s.close());
  h.respond(verified()); await s.source.verify(); h.respond({ ...closed(), success: false }); await assert.rejects(s.close(), redacted);
  assert.deepEqual(await s.source.catalog(), catalog()); assert.equal(h.calls.length, 5);
});
test('import exposes only target.bind/stage/plan and plan; no restore/verify/close API', async () => {
  const h = harness(), s = api.createNotificationsImportSession(TOKEN); assert.deepEqual(Object.keys(s).sort(), ['plan', 'target']); assert.deepEqual(Object.keys(s.target).sort(), ['bind', 'plan', 'stage']);
  await assert.rejects(s.plan()); await assert.rejects(s.target.stage('messages', 0, raw)); assert.equal(h.calls.length, 0);
});
test('binding is immutable after confirmed receipt, detached from input/RPC copies and repeated server receipt', async () => {
  const h = harness(), c = catalog(), s = await importing(h, c); c.tables[0].rows = 99; h.calls[0].args.p_catalog.tables[0].rows = 1;
  h.respond({ ...bound(), repeated: true }); assert.equal((await s.target.bind(catalog())).repeated, true);
  const changed = catalog(); changed.date_runs_supported = true; await assert.rejects(s.target.bind(changed), /immutable/); assert.equal(h.calls.length, 2);
  h.respond(plan()); assert.equal((await s.plan()).can_restore, false);
});
for (const patch of [{ success: false }, { repeated: null }, { scope: 'employee-activity' }, { full_site_complete: true }, { extra: PASSWORD }]) test(`bind rejects malformed receipt ${Object.keys(patch)[0]}`, async () => {
  const h = harness(), s = api.createNotificationsImportSession(TOKEN); h.respond({ ...bound(), ...patch }); await assert.rejects(s.target.bind(catalog()), redacted);
  await assert.rejects(s.target.stage('messages', 0, raw)); assert.equal(h.calls.length, 1);
});
test('stage forwards exact raw text and chunk, confirms server hash/bytes/count/repeated', async () => {
  const h = harness(), s = await importing(h), controller = new AbortController(); h.respond({ ...ack(), repeated: true });
  const receipt = await s.target.stage('messages', 0, raw, controller.signal); assert.equal(receipt.repeated, true);
  assert.deepEqual(h.calls[1].args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_table_key: 'messages', p_chunk_no: 0, p_ndjson: raw }); assert.equal(h.calls[1].signals[0], controller.signal);
  h.respond(ack('')); await s.target.stage(TABLES[6], 0, ''); assert.equal(h.calls[2].args.p_ndjson, '');
});
for (const patch of [{ success: false }, { repeated: 'yes' }, { rows: 0 }, { bytes: 1 }, { sha256: 'a'.repeat(64) }, { sha256: sha(raw) + '\n' }, { extra: PASSWORD }]) test(`stage rejects malformed receipt ${Object.keys(patch)[0]} once`, async () => {
  const h = harness(), s = await importing(h); h.respond({ ...ack(), ...patch }); await assert.rejects(s.target.stage('messages', 0, raw), redacted); assert.equal(h.calls.length, 2);
});
for (const [label, key, chunk, value] of [['unknown table', 'orders', 0, raw], ['negative chunk', 'messages', -1, raw], ['fractional chunk', 'messages', 0.5, raw],
  ['chunk limit', 'messages', 500001, raw], ['empty nonempty table', 'messages', 0, ''], ['empty later chunk', TABLES[0], 1, ''], ['wrong type', 'messages', 0, {}],
  ['missing LF', 'messages', 0, raw.trimEnd()], ['oversize page', 'messages', 0, 'x'.repeat(262145)], ['leases', 'messages', 0, raw.replace('{', `{"delivery_claim_token":null,`)]]) {
  test(`stage rejects ${label} before sending`, async () => { const h = harness(), s = await importing(h); await assert.rejects(s.target.stage(key, chunk, value)); assert.equal(h.calls.length, 1); });
}
test('stage rejects nonempty data against empty bound table', async () => {
  const h = harness(), s = await importing(h, catalog(false)); await assert.rejects(s.target.stage('messages', 0, raw)); assert.equal(h.calls.length, 1);
});
for (const patch of [{ checked: false }, { can_restore: true }, { restore_pending: false }, { media_pending: false }, { automation_pending: false },
  { maintenance: false }, { financial_data_pending: false }, { dependencies_pending: false }, { replacement_ready: true }, { full_site_complete: true },
  { employees: 1 }, { rewards: 500001 }, { conflicts: [PASSWORD] }, { plan_hash: 'bad' }]) test(`plan rejects unsafe/mismatched ${Object.keys(patch)[0]} once`, async () => {
  const h = harness(), s = await importing(h); h.respond({ ...plan(), ...patch }); await assert.rejects(s.plan(), redacted); assert.equal(h.calls.length, 2);
});
test('read-only plan exact counts and detached response, no conflict means still not restore-ready', async () => {
  const h = harness(), s = await importing(h), result = plan(); h.respond(result); const checked = await s.target.plan(); checked.counts.messages = 99;
  assert.equal(result.counts.messages, 1); assert.equal(checked.can_restore, false); assert.equal(checked.replacement_ready, false);
  const bad = plan(); bad.counts.messages++; h.respond(bad); await assert.rejects(s.plan(), redacted); assert.equal(h.calls.length, 3);
});
for (const operation of ['bind', 'stage', 'plan', 'page', 'verify', 'close']) test(`${operation} server failures are sanitized without API retry`, async () => {
  const h = harness(), s = ['bind', 'stage', 'plan'].includes(operation) ? await importing(h) : await exporting(h);
  if (operation === 'close') { h.respond(verified()); await s.source.verify(); }
  const before = h.calls.length; h.replies.push({ error: { message: PASSWORD, details: PASSWORD } });
  const run = { bind: () => s.target.bind(catalog()), stage: () => s.target.stage('messages', 0, raw), plan: () => s.plan(),
    page: () => s.source.page('messages', null), verify: () => s.source.verify(), close: () => s.close() }[operation];
  await assert.rejects(run(), redacted); assert.equal(h.calls.length, before + 1);
});
test('import mutual exclusion covers bind/stage/plan and late-aborted responses do not confirm anything', async () => {
  const h = harness(), s = await importing(h), wait = deferred(), controller = new AbortController(); h.replies.push({ wait: wait.promise });
  const run = s.target.stage('messages', 0, raw, controller.signal);
  await assert.rejects(s.target.bind(catalog()), /in progress/); await assert.rejects(s.plan(), /in progress/); await assert.rejects(s.target.stage('messages', 0, raw), /in progress/);
  controller.abort(Error(PASSWORD)); await assert.rejects(soon(run), e => redacted(e) && e.name === 'AbortError' && /staging may exist/.test(e.message)); assert.equal(h.calls.length, 2);
  wait.resolve({ data: ack(), error: null });
});
test('cancelled begin remains unconfirmed despite late successful response', async () => {
  const h = harness(), wait = deferred(), controller = new AbortController(), s = api.createNotificationsExportSession(PACKAGE, PASSWORD); h.replies.push({ wait: wait.promise });
  const run = s.begin(controller.signal); await Promise.resolve(); assert.equal(h.calls.length, 1);
  controller.abort(Error(PASSWORD)); await assert.rejects(soon(run), redacted); wait.resolve({ data: begin(), error: null });
  assert.equal(s.identity(), null); await assert.rejects(s.begin()); assert.equal(h.calls.length, 1);
});
test('real transfer orchestration plus API validates thirteen server page/stage receipts, no auto close', async () => {
  const h = harness(), s = await exporting(h), sink = new Map();
  for (const key of TABLES) h.respond(page(key === 'messages' ? raw : '', key)); h.respond(verified());
  const exported = await api.exportNotificationsData(s.source, { async append(path, bytes) { sink.set(path, Buffer.from(bytes)); }, async abort() { sink.clear(); } });
  assert.equal(exported.rows, 1); assert.equal(h.calls.filter(c => c.name === WRITES[2]).length, 0);
  const imported = api.createNotificationsImportSession(TOKEN); h.respond(bound()); for (const key of TABLES) h.respond(ack(key === 'messages' ? raw : '')); h.respond(plan());
  let cleanup = 0; const result = await api.stageNotificationsImport(exported.catalog, { open(path) { return { async *[Symbol.asyncIterator]() { yield sink.get(path); } }; }, async abort() { cleanup++; sink.clear(); } }, imported.target);
  assert.equal(result.plan.can_restore, false); assert.equal(cleanup, 1); assert.equal(h.calls.filter(c => c.name === WRITES[4]).length, 13);
  assert.equal(h.calls.some(c => /apply|restore|cancel/.test(c.name)), false);
});

// Exercise the actual existing Supabase fetch policy with an injected createClient transport.
// Only the native fetch is mocked; no database, real network or environment key is used.
test('all seven RPCs use120s; writes never retry; truly read-only page/plan retain existing get_ policy', async () => {
  const transport = await build({ entryPoints: [`${root}src/lib/supabase.ts`], bundle: true, write: false, platform: 'browser', format: 'esm',
    define: { 'import.meta.env.VITE_SUPABASE_URL': '"https://unit-test.invalid"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"unit-test"' },
    plugins: [{ name: 'capture-fetch', setup(builder) { builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'client', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export function createClient(url,key,options){return {request:options.global.fetch};}' })); } }] });
  let hits = 0, fail = true; const timers = [], nativeSetTimeout = globalThis.setTimeout;
  const fetchMock = mock.method(globalThis, 'fetch', async () => { hits++; return new Response('', { status: fail ? 503 : 200 }); });
  const timeoutMock = mock.method(globalThis, 'setTimeout', (fn, delay, ...args) => { timers.push(delay); return nativeSetTimeout(fn, delay === 250 ? 0 : delay, ...args); });
  try {
    const { supabase } = await import(`data:text/javascript;base64,${Buffer.from(transport.outputFiles[0].text).toString('base64')}`);
    for (const name of WRITES) { hits = 0; timers.length = 0; const res = await supabase.request(`https://unit-test.invalid/rest/v1/rpc/${name}`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 503); assert.equal(hits, 1, name); assert.deepEqual(timers, [120000], name); }
    for (const name of READS) { hits = 0; timers.length = 0; const res = await supabase.request(`https://unit-test.invalid/rest/v1/rpc/${name}`, { method: 'POST', body: '{}' });
      assert.equal(res.status, 503); assert.equal(hits, 3, name); assert.deepEqual(timers, [120000, 250, 120000, 250, 120000], name); }
    fail = false; timers.length = 0; await supabase.request('https://unit-test.invalid/rest/v1/rpc/unrelated_write', { method: 'POST' }); assert.deepEqual(timers, [8000]);
  } finally { timeoutMock.mock.restore(); fetchMock.mock.restore(); }
});
test('database declares exactly the seven local RPCs and no notification apply/import-close contract', async () => {
  const types = await readFile(`${root}src/types/database.ts`, 'utf8');
  for (const name of [...WRITES, ...READS]) assert.ok(types.includes(`      ${name}: {`));
  assert.equal(/employee_import_notifications_(?:apply|verify|close):/.test(types), false);
});
