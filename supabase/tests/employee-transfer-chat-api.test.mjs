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
const SECRET = 'never-echo-chat-password-session-or-backend-error', TIME = '2024-02-29T12:34:56.123456+00:00';
const TABLES = ['simulated_customers', 'cs_message_templates', 'customer_auto_messages', 'rich_card_contents',
  'customer_employee_conversations', 'customer_service_sessions', 'ccc_conversation_annotations',
  'customer_auto_message_logs', 'rating_requests', 'service_ratings'];
const KEY = TABLES[4];
const RPCS = ['employee_export_chat_begin', 'get_employee_export_chat_page', 'employee_export_chat_verify', 'employee_export_chat_close',
  'employee_import_chat_bind', 'employee_import_chat_stage', 'get_employee_import_chat_plan'];
const sha = value => createHash('sha256').update(value).digest('hex');
const raw = JSON.stringify({ id: SESSION, customer_id: SESSION, employee_id: OTHER, sender_type: 'customer', message_content: '原文é é 𠮷',
  is_read: null, created_at: TIME, message_type: 'tip', image_url: null, rating_data: { nested: [{ amount: 0 }] }, read_at: null,
  source_type: 'ccc_service', title: null, rich_card_content_id: null, subtitle: null, source_template_id: null, source_auto_message_id: null,
  content_frozen: false, rating_data_sql_null: false }).replace('"amount":0', '"amount":12345678901234567890.12345678901234567890') + '\n';
const ack = (text = raw) => ({ success: true, rows: text ? text.split('\n').length - 1 : 0, bytes: Buffer.byteLength(text), sha256: sha(text), repeated: false });
const bound = () => ({ success: true, scope: 'site-chat', repeated: false, full_site_complete: false });
const verified = () => ({ verified: true, scope: 'site-chat', media_pending: true, full_site_complete: false });
const closed = () => ({ success: true, scope: 'site-chat', media_pending: true, full_site_complete: false });
function catalog(withMessage = true) {
  const identity = { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE, processing_orders: 0, full_site_complete: false,
    tables: ['accounts', 'credentials', 'orders'].map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })) };
  return { version: 1, scope: 'site-chat', site_id: SITE, package_id: PACKAGE, identity_catalog: identity,
    finance_catalog: { version: 1, scope: 'employee-finance', site_id: SITE, package_id: PACKAGE, identity_catalog: structuredClone(identity),
      tables: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit']
        .map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })), full_site_complete: false },
    tables: TABLES.map(key => ({ key, rows: key === KEY && withMessage ? 1 : 0, bytes: key === KEY && withMessage ? Buffer.byteLength(raw) : 0,
      row_hashes_sha256: sha(key === KEY && withMessage ? sha(raw) : '') })), full_site_complete: false };
}
const begin = () => ({ success: true, job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog(), scope: 'site-chat', full_site_complete: false });
const page = (text = raw, key = KEY) => ({ table_key: key, count: text ? text.split('\n').length - 1 : 0, ndjson: text, next_after: null, sha256: sha(text) });
const plan = () => ({ scope: 'site-chat', checked: true, can_restore: false, restore_pending: true, media_pending: true,
  counts: Object.fromEntries(catalog().tables.map(t => [t.key, t.rows])), employees: 0, roles: [], conflicts: [], plan_hash: 'a'.repeat(64),
  maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false });
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const redacted = error => { assert.ok(error instanceof Error); assert.equal(String(error).includes(SECRET), false); assert.equal('cause' in error, false); return true; };
mock.method(globalThis, 'fetch', () => assert.fail('network/production/Storage access forbidden'));
after(() => mock.restoreAll());
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/chatTransfer.ts';
  export * from './src/lib/employeeTransfer/chatApi.ts'; export {setHarness} from 'chat-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', plugins: [{ name: 'isolated-chat-transport', setup(builder) {
    builder.onResolve({ filter: /^(?:chat-test:state|\.\.\/(?:auth|supabase))$/ }, args => {
      if (args.path.startsWith('..')) assert.equal(args.importer, `${root}src/lib/employeeTransfer/chatApi.ts`);
      return { path: args.path, namespace: 'chat-test' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'chat-test' }, ({ path }) => {
      if (path === 'chat-test:state') return { contents: 'let h;export const setHarness=v=>{h=v;};export const current=()=>h;' };
      if (path === '../auth') return { contents: 'import{current}from"chat-test:state";export function getAdminFinancialSessionToken(){const h=current();h.reads++;if(h.authError)throw h.authError;return h.session;}' };
      return { contents: 'import{current}from"chat-test:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' };
    });
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness() {
  const h = { calls: [], replies: [], session: SESSION, reads: 0, authError: null, respond(data) { h.replies.push({ data }); }, rpc(name, args) {
    assert.ok(RPCS.includes(name), `unauthorized interface ${name}`);
    const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call); assert.ok(h.replies.length, `unexpected RPC ${name}`);
    const reply = h.replies.shift(); if (reply.throw) throw reply.throw;
    const query = { abortSignal(signal) { call.signals.push(signal); return query; }, then(resolve, reject) {
      return Promise.resolve().then(() => { if (reply.reject) throw reply.reject; return reply.wait ?? { data: reply.data, error: reply.error ?? null }; }).then(resolve, reject);
    } }; return query;
  } }; api.setHarness(h); return h;
}
async function exporting(h) { const s = api.createChatExportSession(PACKAGE, SECRET); h.respond(begin()); await s.begin(); return s; }
async function importing(h, cat = catalog()) { const s = api.createChatImportSession(TOKEN); h.respond(bound()); await s.target.bind(cat); return s; }

test('lazy one-shot export begin reads current session at request time and sends exact package/password', async () => {
  const h = harness(), s = api.createChatExportSession(PACKAGE, SECRET); assert.equal(h.reads, 0); assert.equal(h.calls.length, 0); assert.equal(s.identity(), null);
  h.session = OTHER; const server = begin(); h.respond(server); const result = await s.begin();
  assert.deepEqual(h.calls[0], { name: RPCS[0], args: { p_admin_session_token: OTHER, p_admin_password: SECRET, p_package_id: PACKAGE }, signals: [] });
  result.tables[0].rows = 99; server.catalog.identity_catalog.processing_orders++; assert.deepEqual(await s.source.catalog(), catalog());
  const saved = s.identity(); saved.jobToken = OTHER; assert.equal(s.identity().jobToken, TOKEN);
  await assert.rejects(s.begin()); assert.equal(h.calls.length, 1);
});
test('all seven RPCs refresh financial session rather than retaining factory or earlier request token', async () => {
  const h = harness(), s = await exporting(h), controller = new AbortController();
  h.session = OTHER; h.respond(page()); await s.source.page(KEY, null, controller.signal);
  h.session = SESSION; h.respond(verified()); await s.source.verify();
  h.session = OTHER; h.respond(closed()); await s.close();
  const imp = await importing(h); h.session = SESSION; h.respond(ack()); await imp.target.stage(KEY, 0, raw);
  h.session = OTHER; h.respond(plan()); await imp.plan();
  assert.deepEqual(h.calls.map(c => c.name), [RPCS[0], RPCS[1], RPCS[2], RPCS[3], RPCS[4], RPCS[5], RPCS[6]]);
  assert.deepEqual(h.calls.map(c => c.args.p_admin_session_token), [SESSION, OTHER, SESSION, OTHER, OTHER, SESSION, OTHER]);
  assert.equal(h.reads, 7); assert.equal(h.calls[1].signals[0], controller.signal);
});
test('expired session or thrown auth helper is redacted and can resume with fresh session plus original job/catalog', async () => {
  const h = harness(), imp = await importing(h); h.session = null;
  await assert.rejects(imp.target.stage(KEY, 0, raw), redacted); assert.equal(h.calls.length, 1);
  h.authError = Error(SECRET); await assert.rejects(imp.plan(), redacted); assert.equal(h.calls.length, 1);
  h.authError = null; h.session = OTHER; const resumed = await importing(h); h.respond(ack()); await resumed.target.stage(KEY, 0, raw); h.respond(plan()); await resumed.plan();
  assert.ok(h.calls.slice(1).every(c => c.args.p_job_token === TOKEN && c.args.p_admin_session_token === OTHER));
});
test('export pages invalidate verify permission, no automatic close and closed job rejects further RPCs', async () => {
  const h = harness(), s = await exporting(h); await assert.rejects(s.close());
  h.respond(verified()); await s.source.verify(); h.respond(page()); await s.source.page(KEY, null); await assert.rejects(s.close());
  h.respond(verified()); await s.source.verify(); h.respond(closed()); await s.close(); const count = h.calls.length;
  for (const fn of [() => s.source.page(KEY, null), () => s.source.verify(), () => s.source.catalog(), () => s.close()]) await assert.rejects(fn());
  assert.equal(h.calls.length, count);
});
test('annotations cursor is relayed unchanged and invalid keys/cursors never dispatch', async () => {
  const h = harness(), s = await exporting(h), key = TABLES[6], after = `${SESSION}:${OTHER}`; h.respond(page('', key)); await s.source.page(key, after);
  assert.deepEqual(h.calls.at(-1).args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_table_key: key, p_after: after, p_limit: 200 });
  for (const fn of [() => s.source.page('orders', null), () => s.source.page(key, SESSION), () => s.source.page(KEY, SESSION + '\n')]) await assert.rejects(fn());
  assert.equal(h.calls.length, 2);
});
test('import exposes only bind/stage/read-only plan; immutable binding and detached receipts', async () => {
  const h = harness(), s = api.createChatImportSession(TOKEN); assert.deepEqual(Object.keys(s).sort(), ['plan', 'target']); assert.deepEqual(Object.keys(s.target).sort(), ['bind', 'plan', 'stage']);
  await assert.rejects(s.plan()); await assert.rejects(s.target.stage(KEY, 0, raw)); assert.equal(h.calls.length, 0);
  const c = catalog(); h.respond(bound()); await s.target.bind(c); c.identity_catalog.processing_orders++; c.finance_catalog.identity_catalog.processing_orders++;
  h.respond({ ...bound(), repeated: true }); assert.equal((await s.target.bind(catalog())).repeated, true);
  await assert.rejects(s.target.bind(c), redacted); assert.equal(h.calls.length, 2);
});
test('stage relays original decimal/Unicode/NULL text, confirms SHA bytes and repeated status', async () => {
  const h = harness(), s = await importing(h); h.respond({ ...ack(), repeated: true }); const r = await s.target.stage(KEY, 0, raw);
  assert.equal(r.repeated, true); assert.deepEqual(h.calls.at(-1).args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_table_key: KEY, p_chunk_no: 0, p_ndjson: raw });
  h.respond(ack('')); await s.target.stage(TABLES[0], 0, ''); assert.equal(h.calls.at(-1).args.p_ndjson, '');
});
test('stage validates table, limits, LF, duplicates, SQL-null marker and bound size before dispatch', async () => {
  const h = harness(), s = await importing(h);
  for (const [key, chunk, value] of [['orders', 0, raw], [KEY, -1, raw], [KEY, 1000001, raw], [KEY, 0, ''], [TABLES[0], 1, ''],
    [KEY, 0, raw.trimEnd()], [KEY, 0, raw.replace('{', '{"\\u0069d":"x",')], [KEY, 0, raw.replace('"rating_data_sql_null":false', '"rating_data_sql_null":true')],
    [KEY, 0, 'x'.repeat(262145)]]) await assert.rejects(s.target.stage(key, chunk, value));
  assert.equal(h.calls.length, 1);
  const empty = await importing(h, catalog(false)); await assert.rejects(empty.target.stage(KEY, 0, raw)); assert.equal(h.calls.length, 2);
});
for (const operation of ['begin', 'page', 'verify', 'close', 'bind', 'stage', 'plan']) test(`${operation}: backend throw/reject/error is sanitized and never automatically retried`, async () => {
  for (const mode of ['throw', 'reject', 'error']) {
    const h = harness(), s = ['bind', 'stage', 'plan'].includes(operation) ? await importing(h) : operation === 'begin' ? api.createChatExportSession(PACKAGE, SECRET) : await exporting(h);
    if (operation === 'close') { h.respond(verified()); await s.source.verify(); }
    const before = h.calls.length; h.replies.push(mode === 'error' ? { error: { message: SECRET, details: SECRET } } : { [mode]: Error(SECRET) });
    const fn = { begin: () => s.begin(), page: () => s.source.page(KEY, null), verify: () => s.source.verify(), close: () => s.close(),
      bind: () => s.target.bind(catalog()), stage: () => s.target.stage(KEY, 0, raw), plan: () => s.plan() }[operation];
    await assert.rejects(fn(), e => redacted(e) && /unknown|unconfirmed/.test(e.message)); assert.equal(h.calls.length, before + 1);
    if (operation === 'begin') { assert.equal(s.identity(), null); await assert.rejects(s.begin()); assert.equal(h.calls.length, before + 1); }
  }
});
test('malformed begin/verify/close/bind/stage responses fail closed and cannot confer completion', async () => {
  for (const corrupt of [v => { v.media_pending = false; }, v => { v.full_site_complete = true; }, v => { v.extra = SECRET; }]) {
    const h = harness(), s = await exporting(h), result = verified(); corrupt(result); h.respond(result);
    await assert.rejects(s.source.verify(), redacted); await assert.rejects(s.close()); assert.equal(h.calls.length, 2);
  }
  for (const patch of [{ bytes: 0 }, { rows: 0 }, { sha256: sha(raw) + '\n' }, { repeated: 'yes' }, { extra: SECRET }]) {
    const h = harness(), s = await importing(h); h.respond({ ...ack(), ...patch }); await assert.rejects(s.target.stage(KEY, 0, raw), redacted); assert.equal(h.calls.length, 2);
  }
  const h = harness(), s = api.createChatExportSession(PACKAGE, SECRET), wrong = begin(); wrong.catalog.package_id = OTHER; h.respond(wrong);
  await assert.rejects(s.begin(), redacted); assert.equal(s.identity(), null);
  const imp = api.createChatImportSession(TOKEN); h.respond({ ...bound(), success: false }); await assert.rejects(imp.target.bind(catalog()), redacted); await assert.rejects(imp.plan());
});
test('plan rejects unsafe flags, wrong counts and unknown roles/conflicts; copies valid server decisions unchanged', async () => {
  const h = harness(), s = await importing(h);
  for (const patch of [{ can_restore: true }, { media_pending: false }, { restore_pending: false }, { dependencies_pending: false }, { maintenance: false },
    { replacement_ready: true }, { full_site_complete: true }, { employees: 1 }, { conflicts: [SECRET] }, { roles: [{}] }, { automation_pending: true }]) {
    h.respond({ ...plan(), ...patch }); await assert.rejects(s.plan(), redacted);
  }
  const wrong = plan(); wrong.counts[KEY]++; h.respond(wrong); await assert.rejects(s.plan(), redacted);
  const good = plan(); good.roles = [{ source_id: SESSION, source_name: '來源', source_number: 'A', target_admin_id: null, source_type: 'aaa_service', match: 'unmapped',
    target_id: null, candidates: [], needs_confirmation: true, number_occupied: true, visibility_employee_ids: [OTHER], multi_source_target: true }];
  h.respond(good); const result = await s.target.plan(); assert.deepEqual(result, good); result.roles[0].visibility_employee_ids.pop(); assert.equal(good.roles[0].visibility_employee_ids.length, 1);
});
test('pre-aborted begin consumes attempt without sending password; in-flight abort cannot confirm late success', async () => {
  const h = harness(), s = api.createChatExportSession(PACKAGE, SECRET), a = new AbortController(); a.abort(SECRET);
  await assert.rejects(s.begin(a.signal), redacted); await assert.rejects(s.begin()); assert.equal(h.calls.length, 0);
  const other = api.createChatExportSession(PACKAGE, SECRET), wait = deferred(), b = new AbortController(); h.replies.push({ wait: wait.promise });
  const pending = other.begin(b.signal); await Promise.resolve(); await Promise.resolve(); b.abort(SECRET);
  await assert.rejects(pending, e => redacted(e) && e.name === 'AbortError'); wait.resolve({ data: begin(), error: null }); assert.equal(other.identity(), null);
});
test('bind/stage/plan mutual exclusion and blocked transport cancellation preserve unknown-staging warning', async () => {
  const h = harness(), s = await importing(h), wait = deferred(), controller = new AbortController(); h.replies.push({ wait: wait.promise });
  const pending = s.target.stage(KEY, 0, raw, controller.signal);
  for (const fn of [() => s.target.bind(catalog()), () => s.plan(), () => s.target.stage(KEY, 0, raw)]) await assert.rejects(fn(), /in progress/);
  controller.abort(SECRET); await assert.rejects(pending, e => redacted(e) && e.name === 'AbortError' && /staging may exist/.test(e.message));
  wait.resolve({ data: ack(), error: null }); assert.equal(h.calls.length, 2);
});
test('new instance rebinds identical catalog after lost bind response with refreshed owner session', async () => {
  const h = harness(), original = api.createChatImportSession(TOKEN); h.replies.push({ reject: Error(SECRET) });
  await assert.rejects(original.target.bind(catalog()), redacted); await assert.rejects(original.target.stage(KEY, 0, raw));
  h.session = OTHER; const resumed = api.createChatImportSession(TOKEN); h.respond({ ...bound(), repeated: true }); await resumed.target.bind(catalog());
  h.respond({ ...ack(), repeated: true }); await resumed.target.stage(KEY, 0, raw); h.respond(plan()); await resumed.plan();
  assert.equal(h.calls.length, 4); assert.ok(h.calls.slice(1).every(c => c.args.p_admin_session_token === OTHER && c.args.p_job_token === TOKEN));
});
test('real ChatTransfer plus API validates all ten tables before bind, cleans plaintext and never applies or uploads', async () => {
  const h = harness(), source = await exporting(h), saved = new Map();
  for (const key of TABLES) h.respond(page(key === KEY ? raw : '', key)); h.respond(verified());
  const exported = await api.exportChatData(source.source, { async append(path, bytes) { saved.set(path, Buffer.from(bytes)); }, async abort() { saved.clear(); } });
  const target = api.createChatImportSession(TOKEN); h.respond(bound()); for (const key of TABLES) h.respond(ack(key === KEY ? raw : '')); h.respond(plan());
  let cleanup = 0; const result = await api.stageChatImport(exported.catalog, { open(path) { return { async *[Symbol.asyncIterator]() { yield saved.get(path); } }; },
    async abort() { cleanup++; saved.clear(); } }, target.target);
  assert.equal(result.plan.can_restore, false); assert.equal(result.fullSiteComplete, false); assert.equal(cleanup, 1); assert.equal(saved.size, 0);
  assert.equal(h.calls.filter(c => c.name === RPCS[5]).length, 10); assert.equal(h.calls.some(c => /apply|upload|restore|cancel|close/.test(c.name)), false);
});
test('untrusted catalog/response/signal descriptors cannot leak text or execute getters', async () => {
  const h = harness(), s = api.createChatImportSession(TOKEN); let reads = 0; const c = catalog();
  Object.defineProperty(c, 'site_id', { enumerable: true, get() { reads++; throw Error(SECRET); } });
  await assert.rejects(s.target.bind(c), redacted); assert.equal(reads, 0); assert.equal(h.calls.length, 0);
  await assert.rejects(s.target.bind(new Proxy({}, { ownKeys() { throw Error(SECRET); } })), redacted);
  const signal = { get aborted() { throw Error(SECRET); } }; await assert.rejects(s.target.bind(catalog(), signal), redacted);
  h.respond(bound()); await s.target.bind(catalog()); h.respond(new Proxy({}, { ownKeys() { throw Error(SECRET); } }));
  await assert.rejects(s.plan(), redacted); assert.equal(h.calls.length, 2);
});
test('only typed public RPC calls are present; no any/unknown casting, service key or media/apply interface', async () => {
  const text = await readFile(`${root}src/lib/employeeTransfer/chatApi.ts`, 'utf8');
  assert.equal(/as\s+(?:any|unknown)|\.from\(|service_role|functions\.invoke|employee_import_chat_(?:apply|begin|verify)/.test(text), false);
  for (const name of RPCS) assert.ok(text.includes(`'${name}'`));
});
