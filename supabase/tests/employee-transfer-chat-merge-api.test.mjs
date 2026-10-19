import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SESSION = id(1), JOB = id(2), PACKAGE = id(3), SOURCE = id(4), TARGET = id(5), BACKUP = id(6), OTHER = id(7);
const SECRET = 'never-echo-chat-merge-token-password-or-backend-details';
const PLAN = 'a'.repeat(64), HASH = 'b'.repeat(64);
const sha = value => createHash('sha256').update(value).digest('hex');
const TABLES = ['simulated_customers', 'cs_message_templates', 'customer_auto_messages', 'rich_card_contents',
  'customer_employee_conversations', 'customer_service_sessions', 'ccc_conversation_annotations',
  'customer_auto_message_logs', 'rating_requests', 'service_ratings'];
const RPC = { plan: 'get_employee_import_chat_merge_plan', prepare: 'employee_import_chat_backup_prepare',
  page: 'get_employee_import_chat_backup_page', verify: 'employee_import_chat_backup_verify',
  append: 'employee_import_chat_backup_append', seal: 'employee_import_chat_backup_seal', saved: 'get_employee_chat_saved_backup_chunk' };
const HEX = Buffer.from('EDXSTRM1' + 'x'.repeat(56)).toString('hex'), CIPHER = sha(Buffer.from(HEX, 'hex'));
const KEY = 'customer_employee_conversations';
const RAW = JSON.stringify({ id: id(80), customer_id: id(10), employee_id: OTHER, sender_type: 'customer', message_content: '原文é é 𠮷',
  is_read: null, created_at: '2024-02-29T12:34:56.123456+00:00', message_type: 'tip', image_url: null, rating_data: { amount: 0 },
  read_at: null, source_type: 'ccc_service', title: null, rich_card_content_id: null, subtitle: null,
  source_template_id: null, source_auto_message_id: null, content_frozen: false, rating_data_sql_null: false })
  .replace('"amount":0', '"amount":12345678901234567890.12345678901234567890') + '\n';
const decisions = () => [{ source_id: id(10), target_id: null, allow_visibility: false, confirmed: true },
  { source_id: id(11), target_id: id(20), allow_visibility: false, confirmed: true }];
function catalog() {
  const identity = { version: 1, scope: 'employee-identity', site_id: SOURCE, package_id: PACKAGE, processing_orders: 0,
    tables: ['accounts', 'credentials', 'orders'].map(key => ({ key, rows: key === 'accounts' ? 2 : 0,
      bytes: key === 'accounts' ? 200 : 0, row_hashes_sha256: sha(key === 'accounts' ? 'identity' : '') })), full_site_complete: false };
  return { version: 1, scope: 'site-chat', site_id: SOURCE, package_id: PACKAGE, identity_catalog: identity,
    finance_catalog: { version: 1, scope: 'employee-finance', site_id: SOURCE, package_id: PACKAGE, identity_catalog: structuredClone(identity),
      tables: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit']
        .map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })), full_site_complete: false },
    tables: TABLES.map(key => ({ key, rows: key === TABLES[0] ? 2 : key === KEY ? 1 : 0,
      bytes: key === TABLES[0] ? 200 : key === KEY ? Buffer.byteLength(RAW) : 0,
      row_hashes_sha256: sha(key === TABLES[0] ? 'roles' : key === KEY ? sha(RAW) : '') })), full_site_complete: false };
}
function plan(cat = catalog(), chosen = decisions()) {
  const canonical = structuredClone(chosen).sort((a, b) => a.source_id < b.source_id ? -1 : 1);
  return { scope: 'chat-merge', checked: true, decisions: canonical, roles: canonical.map(d => ({
    source_id: d.source_id, target_id: d.target_id ?? d.source_id, action: d.target_id === null ? 'create' : 'merge',
    number: d.target_id === null ? 'CUS-0123456789AB' : '目標原編號', visibility_employee_ids: d.target_id === null ? [] : [OTHER],
    allow_visibility: d.allow_visibility, multi_source_target: canonical.filter(x => (x.target_id ?? x.source_id) === (d.target_id ?? d.source_id)).length > 1,
  })), counts: Object.fromEntries(cat.tables.map(t => [t.key, t.rows])), conflicts: [], can_prepare_backup: true,
  can_restore: false, backup_required: true, media_pending: true, maintenance: true, replacement_ready: false,
  full_site_complete: false, target_hash: HASH, plan_hash: PLAN };
}
function descriptor() {
  return { backup_id: BACKUP, plan_hash: PLAN, target_hash: HASH, catalog: { version: 1, scope: 'chat-backup',
    site_id: TARGET, package_id: PACKAGE, tables: TABLES.map(key => ({ key, rows: key === KEY ? 1 : 0,
      bytes: key === KEY ? Buffer.byteLength(RAW) : 0, row_hashes_sha256: sha(key === KEY ? sha(RAW) : '') })),
    media_included: false, full_site_complete: false } };
}
const verification = () => ({ verified: true, backup_id: BACKUP, plan_hash: PLAN, target_hash: HASH, media_included: false, media_pending: true, full_site_complete: false });
const page = (key = KEY, ndjson = RAW) => ({ table_key: key, count: ndjson.split('\n').length - 1, ndjson, next_after: null, sha256: sha(ndjson) });
const appended = (hex = HEX) => ({ success: true, bytes: hex.length / 2, sha256: sha(Buffer.from(hex, 'hex')), repeated: false, media_pending: true, full_site_complete: false });
const sealed = (sha256 = CIPHER, bytes = 64) => ({ success: true, backup_id: BACKUP, sha256, bytes, repeated: false, media_pending: true, full_site_complete: false });
const saved = () => ({ backup_id: BACKUP, chunk_no: 0, hex: HEX, sha256: CIPHER, bytes: 64, chunks: 1 });
const redacted = error => {
  assert.ok(error instanceof Error); const visible = `${error.name}\n${error.message}\n${error.stack}\n${JSON.stringify(error)}`;
  assert.equal(visible.includes(SECRET), false); assert.equal('cause' in error, false); return true;
};
const uncertain = error => { redacted(error); assert.match(error.message, /outcome is unknown or unconfirmed/); assert.match(error.message, /Reconcile before retrying/); return true; };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function soon(promise) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('local cancellation stalled')), 1500); })]); }
  finally { clearTimeout(timer); }
}
mock.method(globalThis, 'fetch', () => assert.fail('network/production/Storage forbidden'));
after(() => mock.restoreAll());
const output = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/chatMergeApi.ts'; export {setHarness} from 'merge-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', plugins: [{ name: 'isolated-merge', setup(builder) {
    builder.onResolve({ filter: /^(?:merge-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'merge-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'merge-test' }, ({ path }) => {
      if (path === 'merge-test:state') return { contents: 'let h;export const setHarness=v=>{h=v;};export const current=()=>h;' };
      if (path === '../auth') return { contents: 'import{current}from"merge-test:state";export function getAdminFinancialSessionToken(){const h=current();h.reads++;if(h.authError)throw h.authError;return h.session;}' };
      return { contents: 'import{current}from"merge-test:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' };
    });
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function harness() {
  const h = { calls: [], replies: [], reads: 0, session: SESSION, authError: null, respond(data) { h.replies.push({ data }); }, rpc(name, args) {
    assert.ok(Object.values(RPC).includes(name), `forbidden RPC ${name}`);
    const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call); assert.ok(h.replies.length, `unexpected RPC ${name}`);
    const reply = h.replies.shift(); if (reply.throw) throw reply.throw;
    const query = { abortSignal(signal) { call.signals.push(signal); return query; }, then(resolve, reject) {
      return Promise.resolve().then(() => { if (reply.reject) throw reply.reject; return reply.wait ?? { data: reply.data, error: reply.error ?? null }; }).then(resolve, reject);
    } }; return query;
  } }; api.setHarness(h); return h;
}
async function planned(h) { const s = api.createChatMergeSession(JOB, catalog()); h.respond(plan()); await s.plan(decisions()); return s; }
async function prepared(h) { const s = await planned(h); h.respond(descriptor()); return { s, b: await s.backup(PLAN, decisions()) }; }
async function ready(h) { const context = await prepared(h); h.respond(verification()); await context.b.source.verify(); return context; }
function actions(s, b) { return { plan: signal => s.plan(decisions(), signal), prepare: signal => s.backup(PLAN, decisions(), signal),
  catalog: signal => b.source.catalog(signal), page: signal => b.source.page(KEY, null, signal), verify: signal => b.source.verify(signal),
  append: signal => b.receiver.append(0, HEX, signal), seal: signal => b.receiver.seal(CIPHER, 64, signal), saved: signal => s.savedChunk(BACKUP, 0, signal) }; }
const replyFor = key => ({ plan, prepare: descriptor, page, verify: verification, append: appended, seal: sealed, saved })[key]();

test('factory is lazy; all seven RPCs read the current session, preserve exact arguments and forward signals', async () => {
  const h = harness(), signal = new AbortController().signal, s = api.createChatMergeSession(JOB, catalog()); assert.equal(h.reads, 0);
  h.respond(plan()); assert.deepEqual(await s.plan(decisions().reverse(), signal), plan());
  h.session = OTHER; h.respond(descriptor()); const b = await s.backup(PLAN, decisions(), signal);
  h.respond(page()); await b.source.page(KEY, null, signal); h.session = SESSION;
  h.respond(verification()); await b.source.verify(signal); h.respond(appended()); await b.receiver.append(0, HEX, signal);
  h.session = OTHER; h.respond(sealed()); await b.receiver.seal(CIPHER, 64, signal); h.respond(saved()); await s.savedChunk(BACKUP, 0, signal);
  const auth = token => ({ p_admin_session_token: token, p_job_token: JOB });
  const args = token => ({ ...auth(token), p_backup_id: BACKUP });
  assert.deepEqual(h.calls.map(c => [c.name, c.args]), [
    [RPC.plan, { ...auth(SESSION), p_decisions: decisions() }], [RPC.prepare, { ...auth(OTHER), p_plan_hash: PLAN, p_decisions: decisions() }],
    [RPC.page, { ...args(OTHER), p_table_key: KEY, p_after: null, p_limit: 200 }], [RPC.verify, args(SESSION)],
    [RPC.append, { ...args(SESSION), p_chunk_no: 0, p_hex: HEX }], [RPC.seal, { ...args(OTHER), p_sha256: CIPHER, p_bytes: 64 }],
    [RPC.saved, { p_admin_session_token: OTHER, p_backup_id: BACKUP, p_chunk_no: 0 }],
  ]); assert.equal(h.reads, 7); for (const call of h.calls) assert.deepEqual(call.signals, [signal]);
  assert.deepEqual(Object.keys(s).sort(), ['backup', 'plan', 'savedChunk']);
});
test('all bindings are detached from caller catalog, decisions, plans, descriptor and server payloads', async () => {
  const h = harness(), c = catalog(), d = decisions(), s = api.createChatMergeSession(JOB, c); c.tables[0].rows = 100;
  const server = plan(); h.respond(server); const returned = await s.plan(d); d[0].allow_visibility = true; returned.plan_hash = HASH;
  returned.decisions[0].target_id = OTHER; server.roles[1].target_id = OTHER;
  const raw = descriptor(); h.respond(raw); const b = await s.backup(PLAN, decisions()); raw.backup_id = OTHER; b.descriptor.backup_id = OTHER;
  b.descriptor.catalog.tables[0].rows = 99; assert.deepEqual(await b.source.catalog(), descriptor().catalog);
  h.respond(verification()); await b.source.verify(); h.respond(appended()); await b.receiver.append(0, HEX);
  assert.equal(h.calls.at(-1).args.p_backup_id, BACKUP);
});
test('many-to-one and retained visibility restrictions are explicitly confirmed, not silently enabled', async () => {
  const h = harness(), s = api.createChatMergeSession(JOB, catalog()), d = decisions(); d[0].target_id = d[1].target_id;
  const p = plan(catalog(), d); assert.ok(p.roles.every(r => r.multi_source_target)); h.respond(p);
  assert.deepEqual(await s.plan(d), p); h.respond(descriptor()); await s.backup(PLAN, d);
  assert.ok(h.calls[1].args.p_decisions.every(d => d.confirmed && !d.allow_visibility));
});
const decisionMutations = [
  ['unconfirmed', d => { d[0].confirmed = false; }], ['missing confirmation', d => { delete d[0].confirmed; }],
  ['truthy confirmation', d => { d[0].confirmed = 1; }], ['visibility not bool', d => { d[0].allow_visibility = 1; }],
  ['missing target', d => { delete d[0].target_id; }], ['invalid target', d => { d[0].target_id = SECRET; }],
  ['UUID newline', d => { d[0].source_id += '\n'; }], ['extra field', d => { d[0].secret = SECRET; }],
  ['duplicate source', d => { d[1].source_id = d[0].source_id; }], ['missing source', d => { d.pop(); }],
  ['extra source', d => { d.push({ ...d[0], source_id: OTHER }); }], ['sparse', d => { delete d[0]; }],
  ['symbol', d => { d[Symbol('secret')] = SECRET; }], ['accessor', d => { Object.defineProperty(d[0], 'source_id', { enumerable: true, get() { assert.fail('getter invoked'); } }); }],
];
for (const [label, mutate] of decisionMutations) test(`decision ${label} is rejected before RPC and cannot authorize backup`, async () => {
  const h = harness(), s = api.createChatMergeSession(JOB, catalog()), d = decisions(); mutate(d);
  await assert.rejects(s.plan(d), redacted); await assert.rejects(s.backup(PLAN, decisions())); assert.equal(h.calls.length, 0);
});
test('decision bound 2000 and canonical ASCII sorting, no implicit confirmation or getter coercion', () => {
  const d = Array.from({ length: 2000 }, (_, n) => ({ source_id: id(100 + n), target_id: null, allow_visibility: false, confirmed: true }));
  assert.equal(api.validateChatMergeDecisions(d.reverse()).length, 2000);
  assert.equal(api.validateChatMergeDecisions(d)[0].source_id, id(100));
  assert.throws(() => api.validateChatMergeDecisions([...d, { ...d[0], source_id: id(9000) }]), redacted);
});
for (const key of TABLES) test(`plan requires exact same-package count ${key}`, async () => {
  const h = harness(), s = api.createChatMergeSession(JOB, catalog()), p = plan(); p.counts[key]++; h.respond(p);
  await assert.rejects(s.plan(decisions()), uncertain); await assert.rejects(s.backup(PLAN, decisions())); assert.equal(h.calls.length, 1);
});
const planMutations = [
  ['scope', p => { p.scope = 'site-chat'; }], ['checked', p => { p.checked = false; }], ['can_restore', p => { p.can_restore = true; }],
  ['media_pending', p => { p.media_pending = false; }], ['maintenance', p => { p.maintenance = false; }], ['replacement_ready', p => { p.replacement_ready = true; }],
  ['full_site_complete', p => { p.full_site_complete = true; }], ['backup_required', p => { p.backup_required = false; }],
  ['hash newline', p => { p.plan_hash += '\n'; }], ['extra field', p => { p.secret = SECRET; }],
  ['missing role', p => { p.roles.pop(); }], ['role order', p => { p.roles.reverse(); }], ['decision order', p => { p.decisions.reverse(); }],
  ['changed decision', p => { p.decisions[1].allow_visibility = true; p.roles[1].allow_visibility = true; }],
  ['create remap', p => { p.roles[0].target_id = OTHER; }], ['action', p => { p.roles[0].action = 'restore'; }],
  ['create visibility', p => { p.roles[0].visibility_employee_ids = [OTHER]; }], ['hidden multi', p => { p.roles[1].multi_source_target = true; }],
  ['visibility duplicate', p => { p.roles[1].visibility_employee_ids = [OTHER, OTHER]; }], ['visibility unsorted', p => { p.roles[1].visibility_employee_ids = [id(9), OTHER]; }],
  ['unknown conflict', p => { p.conflicts = [SECRET]; p.can_prepare_backup = false; }],
  ['false prepareable', p => { p.conflicts = ['source_admin_unmapped']; }], ['empty falsely blocked', p => { p.can_prepare_backup = false; }],
  ['missing counts', p => { delete p.counts.service_ratings; }], ['extra count', p => { p.counts.orders = 1; }],
  ['accessor', p => { Object.defineProperty(p.roles[0], 'number', { enumerable: true, get() { assert.fail('getter invoked'); } }); }],
];
for (const [label, mutate] of planMutations) test(`unsafe plan ${label} never enables prepare`, async () => {
  const h = harness(), s = api.createChatMergeSession(JOB, catalog()), p = plan(); mutate(p); h.respond(p);
  await assert.rejects(s.plan(decisions()), uncertain); await assert.rejects(s.backup(PLAN, decisions())); assert.equal(h.calls.length, 1);
});
for (const reason of api.CHAT_MERGE_CONFLICT_REASONS) test(`server conflict ${reason} is visible but blocks preparation`, async () => {
  const h = harness(), s = api.createChatMergeSession(JOB, catalog()), p = plan(); p.conflicts = [reason]; p.can_prepare_backup = false; h.respond(p);
  assert.deepEqual((await s.plan(decisions())).conflicts, [reason]); await assert.rejects(s.backup(PLAN, decisions())); assert.equal(h.calls.length, 1);
});
test('backup binds exact decision values, not merely plan hash, and failed/preaborted replanning revokes old plan', async () => {
  const h = harness(), s = await planned(h), changed = decisions(); changed[1].allow_visibility = true;
  await assert.rejects(s.backup(PLAN, changed)); assert.equal(h.calls.length, 1);
  const controller = new AbortController(); controller.abort(SECRET); await assert.rejects(s.plan(decisions(), controller.signal), redacted);
  await assert.rejects(s.backup(PLAN, decisions())); assert.equal(h.calls.length, 1);
});
for (const [field, change] of [
  ['backup', d => { d.backup_id += '\n'; }], ['plan', d => { d.plan_hash = HASH; }], ['target', d => { d.target_hash = PLAN; }],
  ['same site', d => { d.catalog.site_id = SOURCE; }], ['package', d => { d.catalog.package_id = OTHER; }],
  ['scope', d => { d.catalog.scope = 'site-chat'; }], ['date flag', d => { d.catalog.date_runs_supported = false; }],
  ['media', d => { d.catalog.media_included = true; }], ['overflow', d => { d.catalog.tables[4].bytes = 8388609; }],
]) test(`prepare rejects descriptor ${field}`, async () => {
  const h = harness(), s = await planned(h), d = descriptor(); change(d); h.respond(d); await assert.rejects(s.backup(PLAN, decisions()), uncertain); assert.equal(h.calls.length, 2);
});
for (const operation of ['append', 'seal']) test(`${operation} needs verified snapshot, preaborted reverify and any page invalidate permission`, async () => {
  const h = harness(), { s, b } = await prepared(h); await assert.rejects(actions(s, b)[operation]()); assert.equal(h.calls.length, 2);
  h.respond(verification()); await b.source.verify(); const controller = new AbortController(); controller.abort(SECRET);
  await assert.rejects(b.source.verify(controller.signal), redacted); await assert.rejects(actions(s, b)[operation]());
  h.respond(verification()); await b.source.verify(); h.respond(page()); await b.source.page(KEY, null);
  await assert.rejects(actions(s, b)[operation]()); assert.equal(h.calls.length, 5);
});
for (const key of TABLES) test(`fixed table ${key} supports canonical cursors and limit200`, async () => {
  const h = harness(), { b } = await prepared(h), after = key === 'ccc_conversation_annotations' ? `${id(50)}:${id(51)}` : id(50);
  h.respond(page(key, '')); await b.source.page(key, after); assert.equal(h.calls.at(-1).args.p_after, after); assert.equal(h.calls.at(-1).args.p_limit, 200);
});
for (const operation of ['plan', 'prepare', 'page', 'verify', 'append', 'seal', 'saved']) for (const mode of ['error', 'reject', 'throw', 'malformed']) test(`${operation} ${mode} is redacted, uncertain and never automatically retried`, async () => {
  const h = harness(), { s, b } = await ready(h), before = h.calls.length;
  h.replies.push(mode === 'error' ? { error: { message: SECRET } } : mode === 'reject' ? { reject: Error(SECRET) }
    : mode === 'throw' ? { throw: Error(SECRET) } : { data: { secret: SECRET } });
  await assert.rejects(actions(s, b)[operation](), uncertain); assert.equal(h.calls.length, before + 1);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.length, before + 1);
});
for (const operation of ['plan', 'prepare', 'catalog', 'page', 'verify', 'append', 'seal', 'saved']) test(`${operation} pre-abort sends nothing and does not reveal reason`, async () => {
  const h = harness(), { s, b } = await ready(h), before = h.calls.length, controller = new AbortController(); controller.abort(Error(SECRET));
  await assert.rejects(actions(s, b)[operation](controller.signal), e => redacted(e) && e.name === 'AbortError'); assert.equal(h.calls.length, before);
});
for (const operation of ['plan', 'prepare', 'page', 'verify', 'append', 'seal', 'saved']) test(`${operation} in-flight cancellation ignores late success and releases lock`, async () => {
  const h = harness(), { s, b } = await ready(h), before = h.calls.length, controller = new AbortController(), wait = deferred(), entered = deferred(), rpc = h.rpc;
  h.rpc = (...args) => { const result = rpc(...args); entered.resolve(); return result; };
  h.replies.push({ wait: wait.promise }); const pending = actions(s, b)[operation](controller.signal); await soon(entered.promise); controller.abort(Error(SECRET));
  await assert.rejects(soon(pending), e => uncertain(e) && e.name === 'AbortError'); wait.resolve({ data: replyFor(operation), error: null });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.calls.length, before + 1); assert.deepEqual(await b.source.catalog(), descriptor().catalog);
  if (operation === 'verify' || operation === 'page') await assert.rejects(b.receiver.append(0, HEX));
});
for (const operation of ['plan', 'prepare', 'page', 'verify', 'append', 'seal', 'saved']) test(`${operation} holds one session-wide exclusive lock`, async () => {
  const h = harness(), { s, b } = await ready(h), wait = deferred(); h.replies.push({ wait: wait.promise }); const pending = actions(s, b)[operation]();
  const attempts = Object.values(actions(s, b)).map(action => assert.rejects(action(), /already in progress/));
  wait.resolve({ data: replyFor(operation), error: null }); await Promise.all(attempts); await pending;
});
for (const field of ['verified', 'backup_id', 'plan_hash', 'target_hash', 'media_included', 'media_pending', 'full_site_complete']) test(`verify receipt ${field} rejects and revokes permission`, async () => {
  const h = harness(), { b } = await ready(h), receipt = verification(); receipt[field] = typeof receipt[field] === 'boolean' ? !receipt[field] : OTHER;
  h.respond(receipt); await assert.rejects(b.source.verify(), uncertain); await assert.rejects(b.receiver.append(0, HEX));
});
for (const field of ['success', 'bytes', 'sha256', 'repeated', 'media_pending', 'full_site_complete', 'extra']) test(`append receipt ${field} is strict`, async () => {
  const h = harness(), { b } = await ready(h), receipt = appended(); receipt[field] = SECRET; h.respond(receipt);
  await assert.rejects(b.receiver.append(0, HEX), uncertain); assert.equal(h.calls.length, 4);
});
for (const field of ['success', 'backup_id', 'bytes', 'sha256', 'repeated', 'media_pending', 'full_site_complete', 'extra']) test(`seal receipt ${field} is strict`, async () => {
  const h = harness(), { b } = await ready(h), receipt = sealed(); receipt[field] = SECRET; h.respond(receipt);
  await assert.rejects(b.receiver.seal(CIPHER, 64), uncertain); assert.equal(h.calls.length, 4);
});
for (const field of ['backup_id', 'chunk_no', 'hex', 'sha256', 'bytes', 'chunks', 'extra']) test(`saved sealed chunk ${field} is strictly bound without job token`, async () => {
  const h = harness(), s = api.createChatMergeSession(JOB, catalog()), receipt = saved(); receipt[field] = SECRET; h.respond(receipt);
  await assert.rejects(s.savedChunk(BACKUP, 0), uncertain); assert.equal('p_job_token' in h.calls[0].args, false);
});
test('saved sealed backup can be read in a fresh session without preparing or planning again', async () => {
  const h = harness(), s = api.createChatMergeSession(JOB, catalog()); h.session = OTHER; h.respond(saved()); assert.deepEqual(await s.savedChunk(BACKUP, 0), saved());
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].args, { p_admin_session_token: OTHER, p_backup_id: BACKUP, p_chunk_no: 0 });
});
test('auth failures are private and re-login can resume with the original job and frozen catalog', async () => {
  const h = harness(), s = api.createChatMergeSession(JOB, catalog()); h.session = null; await assert.rejects(s.plan(decisions()), uncertain);
  h.authError = Error(SECRET); await assert.rejects(s.plan(decisions()), uncertain); assert.equal(h.calls.length, 0);
  h.authError = null; h.session = OTHER; h.respond(plan()); await s.plan(decisions()); assert.equal(h.calls[0].args.p_admin_session_token, OTHER);
});
test('SQL30 exposes exactly seven signatures, independent 11-column RLS backup and precise inventory exclusion', async () => {
  const sql = await readFile(`${root}supabase/migrations/20261102000030_prepare_chat_merge.sql`, 'utf8');
  const declared = [...sql.matchAll(/CREATE FUNCTION public\.([a-z_]+)\(([^)]*)\)/g)];
  assert.deepEqual(Object.fromEntries(declared.map(([, name, args]) => [name, args])), {
    [RPC.plan]: 'p_admin_session_token uuid,p_job_token uuid,p_decisions jsonb',
    [RPC.prepare]: 'p_admin_session_token uuid,p_job_token uuid,p_plan_hash text,p_decisions jsonb',
    [RPC.page]: 'p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200',
    [RPC.verify]: 'p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid',
    [RPC.append]: 'p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_chunk_no integer,p_hex text',
    [RPC.seal]: 'p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_sha256 text,p_bytes integer',
    [RPC.saved]: 'p_admin_session_token uuid,p_backup_id uuid,p_chunk_no integer',
  }); assert.equal(declared.length, 7);
  assert.match(sql, /ALTER TABLE private\.employee_transfer_chat_backups ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /WHERE job_id=NEW\.id AND sealed_at IS NULL/);
  assert.match(sql, /private\.employee_transfer_notification_backups'',''private\.employee_transfer_shared_backups/);
  assert.equal(/proname LIKE|ALTER TABLE.*DISABLE TRIGGER|session_replication_role/.test(sql), false);
  const helper = sql.slice(sql.indexOf('CREATE FUNCTION private.employee_transfer_chat_merge_plan'), sql.indexOf('CREATE FUNCTION public.get_employee_import_chat_merge_plan'));
  assert.match(helper, /STABLE SECURITY DEFINER/); assert.equal(/UPDATE |INSERT |DELETE |heartbeat/.test(helper), false);
  assert.match(sql, /private\.employee_transfer_chat_unique_json\(v_json\)/);
});
