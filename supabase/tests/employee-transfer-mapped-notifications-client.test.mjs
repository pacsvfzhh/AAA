import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TRANSFER_SCOPE_COVERAGE_INVENTORY } from './support/transfer-scope.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `60000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const AUTH = id(1), TOKEN = id(2), JOB = id(3), SITE = id(4), SOURCE = id(5), PACKAGE = id(6);
const HASH = 'a'.repeat(64), MAPPING = 'b'.repeat(64), PLAN_HASH = 'c'.repeat(64), OTHER = 'd'.repeat(64);
const SECRET = 'never-expose-token-password-backend-or-raw-row';
const PRECISE = '9007199254740993.123456789012345678901234567890';
const TIME = '2024-02-29T12:34:56.123456+00:00';
const SCOPE = 'employee-mapped-notifications';
const TABLES = ['notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
  'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
  'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients',
  'message_templates', 'broadcast_messages', 'broadcast_recipients'];
const CONFLICTS = ['source_employee_missing', 'source_admin_unmapped', 'source_reference_missing', 'source_scope_mismatch',
  'source_unique_collision', 'reward_link_mismatch', 'unfinished_execution', 'unsupported_date_runs',
  'mapped_reward_mismatch', 'notification_target_not_empty', 'notification_uuid_collision'].sort();
const LEASES = ['delivery_claim_token', 'delivery_claim_channel', 'delivery_claim_until', 'delivery_completed_claim_token'];
const FLAGS = { maintenance: true, dependencies_pending: true, financial_data_pending: true, can_restore: false,
  complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false,
  configuration_pending: true, records_pending: true, media_pending: true, automation_pending: true };
const sha = value => createHash('sha256').update(value).digest('hex');
const rowCount = text => text.split('\n').length - 1;
const rowHash = text => sha((text.match(/[^\n]*\n/g) ?? []).map(sha).join(''));
const rpcName = op => `employee_import_mapped_notifications_${op}`;
const columns = key => TRANSFER_SCOPE_COVERAGE_INVENTORY.find(t => t.schema === 'public' && t.name === key).columns.filter(c => !LEASES.includes(c.name));
function row(key, n = 1) {
  const r = Object.fromEntries(columns(key).map(c => [c.name, ({ uuid: id(n + 100), text: '原文é é 𠮷', integer: 1, smallint: 1,
    bigint: '9223372036854775807', numeric: 0, boolean: true, 'timestamp with time zone': TIME,
    jsonb: { trigger_type: 'total_orders', trigger_mode: 'reach_once', threshold_value: 0, minimum_daily_orders: null, minimum_daily_work_minutes: null } })[c.type]]));
  if ('status' in r) r.status = key === TABLES[5] ? 'succeeded' : 'active';
  if ('message_type' in r) r.message_type = key === TABLES[11] ? 'text' : 'realtime';
  if ('priority' in r) r.priority = 'normal';
  if ('delivery_mode' in r) r.delivery_mode = 'realtime_with_login_fallback';
  if ('delivery_channel' in r) r.delivery_channel = null;
  if ('notification_category' in r) r.notification_category = 'standard';
  if ('audit_origin' in r) r.audit_origin = 'unverified';
  if ('target_type' in r) r.target_type = 'all';
  if ('trigger_type' in r) r.trigger_type = 'total_orders';
  if ('trigger_mode' in r) r.trigger_mode = 'reach_once';
  if ('recipient_scope' in r) r.recipient_scope = 'selected';
  if ('period_key' in r) r.period_key = 'A:2024-02_29.01';
  if ('last_period_key' in r) r.last_period_key = 'A:2024-02_29.01';
  if ('error_message' in r) r.error_message = null;
  if ('last_error' in r) r.last_error = 'redacted migration error';
  if (key === TABLES[2]) r.id = r.user_id;
  if ([TABLES[3], TABLES[4], TABLES[7]].includes(key)) r.id = `${r.task_id}:${r.user_id}`;
  if (key === TABLES[6]) r.id = `${r.task_id}:${String(r.task_version).padStart(10, '0')}:${r.period_key}`;
  return r;
}
const line = (key, n = 1) => JSON.stringify(row(key, n)).replace(/"(threshold_value|actual_value|last_metric|reward_amount)":0/g, `"$1":${PRECISE}`) + '\n';
const data = () => Object.fromEntries(TABLES.map(key => [key, line(key)]));
const emptyData = () => Object.fromEntries(TABLES.map(key => [key, '']));
function catalog(texts = data(), employees = 1) {
  const identity = { version: 1, scope: 'employee-identity', site_id: SOURCE, package_id: PACKAGE, processing_orders: 0,
    tables: ['accounts', 'credentials', 'orders'].map((key, i) => ({ key, rows: i === 0 ? employees : 0,
      bytes: i === 0 ? employees * 500 : 0, row_hashes_sha256: sha('') })), full_site_complete: false };
  return { version: 1, scope: 'site-notifications', site_id: SOURCE, package_id: PACKAGE, identity_catalog: identity,
    finance_catalog: { version: 1, scope: 'employee-finance', site_id: SOURCE, package_id: PACKAGE, identity_catalog: structuredClone(identity),
      tables: ['wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit']
        .map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })), full_site_complete: false },
    date_runs_supported: true, tables: TABLES.map(key => ({ key, rows: rowCount(texts[key]), bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: rowHash(texts[key]) })), full_site_complete: false };
}
const common = () => ({ scope: SCOPE, job_id: JOB, site_id: SITE, source_site_id: SOURCE, package_id: PACKAGE, mapping_hash: MAPPING, ...FLAGS });
const plan = (c = catalog()) => ({ ...common(), catalog_hash: HASH, plan_hash: PLAN_HASH, checked: true,
  counts: Object.fromEntries(c.tables.map(t => [t.key, t.rows])), employees: c.identity_catalog.tables[0].rows, rewards: 1, conflicts: [] });
const chunk = (key, no = 0, text = line(key)) => ({ table_key: key, chunk_no: no, rows: rowCount(text), bytes: Buffer.byteLength(text), sha256: sha(text) });
const bindReply = () => ({ success: true, scope: SCOPE, catalog_hash: HASH, full_site_complete: false });
const stageReply = (key = 'messages', no = 0, text = line(key)) => ({ success: true, scope: SCOPE, ...chunk(key, no, text), full_site_complete: false });
function status(c = catalog(), staged = {}, receipt = null, withPlan = true) {
  const tables = TABLES.map(key => {
    const blocks = staged[key] ?? [], text = blocks.join('');
    return { key, chunks: blocks.length, rows: rowCount(text), bytes: Buffer.byteLength(text), row_hashes_sha256: rowHash(text) };
  });
  const complete = tables.every((t, i) => t.chunks > 0 && t.rows === c.tables[i].rows && t.bytes === c.tables[i].bytes && t.row_hashes_sha256 === c.tables[i].row_hashes_sha256);
  return { ...common(), bound: true, catalog_hash: HASH, catalog: structuredClone(c), tables, complete,
    plan: complete && withPlan ? plan(c) : null, chunk: receipt };
}
function unbound() {
  return { ...status(), bound: false, catalog_hash: null, catalog: null, complete: false, plan: null, chunk: null };
}
const allStaged = texts => Object.fromEntries(TABLES.map(key => [key, [texts[key]]]));
let networkCalls = 0;
mock.method(globalThis, 'fetch', () => { networkCalls++; assert.fail('formal services/network forbidden'); });
after(() => { assert.equal(networkCalls, 0); mock.restoreAll(); });
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/employeeMappedNotifications.ts'; export {setHarness} from 'notifications-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'isolated-notifications-client', setup(builder) {
    builder.onResolve({ filter: /^(?:notifications-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'notifications-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'notifications-test' }, ({ path }) => ({ contents: path === 'notifications-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth'
        ? 'import{current}from"notifications-test:state";export function getAdminFinancialSessionToken(){const h=current();h.reads++;h.onAuth?.();if(h.authError)throw h.authError;return h.auth;}'
        : 'import{current}from"notifications-test:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const redacted = error => {
  assert.ok(error instanceof Error);
  for (const secret of [SECRET, AUTH, TOKEN, JOB, HASH, MAPPING, PLAN_HASH, PRECISE]) assert.equal(String(error).includes(secret), false);
  for (const key of ['cause', 'details', 'hint']) assert.equal(key in error, false);
  return true;
};
const aborted = error => redacted(error) && error.name === 'AbortError';
function harness() {
  const h = { auth: AUTH, reads: 0, calls: [], replies: [], onAuth: null, authError: null,
    respond(data) { h.replies.push({ data }); },
    rpc(name, args) {
      assert.ok(['bind', 'stage', 'plan', 'status'].map(rpcName).includes(name), `forbidden RPC ${name}`);
      assert.ok(h.replies.length, `unexpected ${name}`);
      const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
      const reply = h.replies.shift();
      if (reply.throw) throw reply.throw;
      const query = {
        abortSignal(signal) { call.signals.push(signal); if (reply.signalError) throw reply.signalError; return query; },
        then(resolve, reject) { return Promise.resolve().then(() => {
          if (reply.reject) throw reply.reject;
          return reply.wait ?? { data: reply.data, error: reply.error ?? null };
        }).then(resolve, reject); },
      };
      return query;
    },
  };
  api.setHarness(h); return h;
}
const session = () => api.createEmployeeMappedNotificationsSession(TOKEN);
async function ready(c = catalog()) { const h = harness(), s = session(); h.respond(bindReply()); await s.bind(c); return { h, s }; }
const turn = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function writesBlocked(s, h, c = catalog()) {
  const calls = h.calls.length, reads = h.reads;
  await assert.rejects(s.bind(c), redacted); await assert.rejects(s.stage('messages', 0, line('messages')), redacted);
  assert.equal(h.calls.length, calls); assert.equal(h.reads, reads);
}

// Tests use real catalog/page validators; only auth and the four RPC transports are replaced.
test('lazy isolated bundle exposes only four explicit methods and loads real lightweight validators', () => {
  const h = harness(), s = session();
  assert.deepEqual(Object.keys(s).sort(), ['bind', 'plan', 'stage', 'status']); assert.equal(h.reads, 0); assert.equal(h.calls.length, 0);
  assert.deepEqual(Object.keys(api).sort(), ['createEmployeeMappedNotificationsSession', 'setHarness', 'validateEmployeeMappedNotificationsPlan', 'validateEmployeeMappedNotificationsStatus']);
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const name of ['notificationsTransfer', 'identityTransfer', 'financeTransfer', 'sha256']) assert.ok(inputs.some(path => path.endsWith(`/${name}.ts`)));
  assert.equal(inputs.some(path => /node_modules|\/(?:notificationsApi|notificationsRestoreApi|notificationsMedia|siteImport|siteRestoreApi|container|crypto)\.ts$/.test(path)), false);
});
test('13-table raw staging, precise numeric/bigint/UTF8/NULL/microseconds, fresh auth and exact four RPC argument contracts', async () => {
  const texts = data(), c = catalog(texts), { h, s } = await ready(c), signal = new AbortController().signal;
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: AUTH, p_job_token: TOKEN, p_catalog: c });
  for (const key of TABLES) {
    h.auth = id(h.calls.length + 500); h.respond(stageReply(key));
    assert.deepEqual(await s.stage(key, 0, texts[key], signal), stageReply(key));
    assert.deepEqual(h.calls.at(-1), { name: rpcName('stage'), args: { p_admin_session_token: h.auth, p_job_token: TOKEN,
      p_table_key: key, p_chunk_no: 0, p_ndjson: texts[key] }, signals: [signal] });
  }
  const final = status(c, allStaged(texts)); h.respond(final); assert.deepEqual(await s.status(null, null, signal), final);
  assert.deepEqual(h.calls.at(-1).args, { p_admin_session_token: h.auth, p_job_token: TOKEN, p_table_key: null, p_chunk_no: null });
  h.respond(plan(c)); assert.deepEqual(await s.plan(signal), plan(c));
  assert.deepEqual(h.calls.at(-1).args, { p_admin_session_token: h.auth, p_job_token: TOKEN });
  h.respond({ ...final, chunk: chunk('messages') }); await s.status('messages', 0, signal);
  h.respond(stageReply()); await s.stage('messages', 0, texts.messages);
  assert.equal(h.reads, h.calls.length);
  for (const value of [final, plan(c)]) for (const [key, flag] of Object.entries(FLAGS)) assert.equal(value[key], flag);
  assert.ok(h.calls.some(call => call.args.p_ndjson?.includes(PRECISE)));
});
test('empty package still needs explicit bind and one authenticated empty block for every table', async () => {
  const texts = emptyData(), c = catalog(texts, 0), { h, s } = await ready(c);
  h.respond(status(c)); assert.equal((await s.status()).complete, false);
  for (const key of TABLES) { h.respond(stageReply(key, 0, '')); await s.stage(key, 0, ''); }
  h.respond(status(c, allStaged(texts))); const result = await s.status();
  assert.equal(result.complete, true); assert.equal(result.plan.checked, true); assert.equal(result.plan.employees, 0);
  assert.equal(result.can_restore, false); assert.equal('can_begin' in result.plan, false);
});
test('raw CRLF/whitespace and unrounded numeric lexemes survive multi-block stages and explicit repeats', async () => {
  const texts = emptyData(), raws = [line('messages', 1), line('messages', 2)].map(raw => raw.replace('{', '{ ').replace('\n', '\r\n'));
  texts.messages = raws.join(''); const c = catalog(texts), { h, s } = await ready(c);
  for (let no = 0; no < 2; no++) { h.respond(stageReply('messages', no, raws[no])); await s.stage('messages', no, raws[no]); }
  h.respond(stageReply('messages', 0, raws[0])); await s.stage('messages', 0, raws[0]);
  assert.deepEqual(h.calls.slice(1).map(call => call.args.p_ndjson), [raws[0], raws[1], raws[0]]);
  h.respond(status(c, { messages: raws }, chunk('messages', 1, raws[1]))); await s.status('messages', 1);
});
test('true 200+1 rows use two exact blocks; repeated local blocks cannot consume counts twice', async () => {
  const texts = emptyData(), raws = Array.from({ length: 201 }, (_, n) => line('broadcast_messages', n + 1));
  texts.broadcast_messages = raws.join(''); const c = catalog(texts), { h, s } = await ready(c);
  for (const [no, raw] of [raws.slice(0, 200).join(''), raws[200]].entries()) {
    h.respond(stageReply('broadcast_messages', no, raw)); await s.stage('broadcast_messages', no, raw);
  }
  h.respond(stageReply('broadcast_messages', 0, raws.slice(0, 200).join(''))); await s.stage('broadcast_messages', 0, raws.slice(0, 200).join(''));
  h.respond(status(c, { broadcast_messages: [raws.slice(0, 200).join(''), raws[200]] })); await s.status();
});
test('sorted unique conflict allowlist, checked-only permission and bounded plan counters', () => {
  const raw = { ...plan(), conflicts: [...CONFLICTS] }; assert.deepEqual(api.validateEmployeeMappedNotificationsPlan(raw), raw);
  for (const edit of [p => { p.can_begin = true; }, p => { p.restore_pending = true; }, p => { p.checked = false; },
    p => { p.conflicts = [...CONFLICTS].reverse(); }, p => { p.conflicts = [CONFLICTS[0], CONFLICTS[0]]; },
    p => { p.conflicts = ['media_verified']; }, p => { delete p.counts.messages; }, p => { p.counts.users = 0; }]) {
    const p = plan(); edit(p); assert.throws(() => api.validateEmployeeMappedNotificationsPlan(p), redacted);
  }
  for (const field of ['employees', 'rewards', 'counts']) for (const value of [-1, 0.5, '1', null, undefined, NaN, Infinity, 500001]) {
    const p = plan(); if (field === 'counts') p.counts.messages = value; else p[field] = value;
    assert.throws(() => api.validateEmployeeMappedNotificationsPlan(p), redacted);
  }
  for (const value of [0, 500000]) assert.equal(api.validateEmployeeMappedNotificationsPlan({ ...plan(), employees: value, rewards: value }).employees, value);
});
test('common exact fields, flags, lowercase UUID/hash and no trailing-newline loopholes', () => {
  for (const [make, validate] of [[plan, api.validateEmployeeMappedNotificationsPlan], [status, api.validateEmployeeMappedNotificationsStatus]]) {
    for (const field of ['job_id', 'site_id', 'source_site_id', 'package_id', 'mapping_hash']) for (const mode of ['missing', 'bad', 'newline', 'upper']) {
      const raw = make(); if (mode === 'missing') delete raw[field]; else raw[field] = mode === 'bad' ? SECRET : mode === 'newline' ? raw[field] + '\n'
        : field.endsWith('hash') ? raw[field].toUpperCase() : id(0xab).toUpperCase();
      assert.throws(() => validate(raw), redacted);
    }
    for (const [field, expected] of Object.entries(FLAGS)) { const raw = make(); raw[field] = !expected; assert.throws(() => validate(raw), redacted); }
    for (const edit of [r => { r.scope = 'site-notifications'; }, r => { r.extra = true; }, r => { delete r.scope; }]) {
      const raw = make(); edit(raw); assert.throws(() => validate(raw), redacted);
    }
  }
});
test('status validates unbound, exact 13-table order, complete equivalence, receipt limits and nested plan bindings', () => {
  assert.deepEqual(api.validateEmployeeMappedNotificationsStatus(unbound()), unbound());
  const texts = data(), c = catalog(texts), full = () => status(c, allStaged(texts));
  assert.equal(api.validateEmployeeMappedNotificationsStatus(full()).complete, true);
  const noPlan = full(); noPlan.plan = null; assert.equal(api.validateEmployeeMappedNotificationsStatus(noPlan).complete, true);
  const edits = [r => { r.bound = false; }, r => { r.catalog_hash = null; }, r => { r.catalog = null; },
    r => { r.tables.reverse(); }, r => { r.tables.pop(); }, r => { r.tables[0].chunks = 0; },
    r => { r.tables[0].rows = 500001; }, r => { r.tables[0].bytes = 256 * 1024 * 1024 + 1; },
    r => { r.tables[0].chunks = 500002; }, r => { r.tables[0].chunks = 2; }, r => { r.tables[0].row_hashes_sha256 = OTHER; },
    r => { r.complete = false; }, r => { r.plan.catalog_hash = OTHER; }, r => { r.plan.mapping_hash = OTHER; },
    r => { r.plan.job_id = id(50); }, r => { r.plan.employees = 2; }, r => { r.plan.counts.messages = 0; },
    r => { r.chunk = chunk('messages', 1); }, r => { r.chunk = { ...chunk('messages'), success: true }; },
    r => { r.chunk = { ...chunk('messages'), rows: 201 }; }, r => { r.chunk = { ...chunk('messages'), bytes: 262145 }; },
    r => { r.chunk = { ...chunk('messages'), bytes: 0 }; }];
  for (const edit of edits) { const raw = full(); edit(raw); assert.throws(() => api.validateEmployeeMappedNotificationsStatus(raw), redacted); }
  for (const edit of [r => { r.tables[0].chunks = 1; }, r => { r.plan = plan(); }, r => { r.chunk = chunk('messages'); }, r => { r.complete = true; }]) {
    const raw = unbound(); edit(raw); assert.throws(() => api.validateEmployeeMappedNotificationsStatus(raw), redacted);
  }
  const partial = status(); partial.plan = plan(); assert.throws(() => api.validateEmployeeMappedNotificationsStatus(partial), redacted);
  const empty = status(catalog(emptyData()), { messages: ['', ''] }); assert.throws(() => api.validateEmployeeMappedNotificationsStatus(empty), redacted);
});
test('Object descriptors, array holes/symbols/prototypes/proxies and nested catalogs cannot execute getters', async () => {
  let getters = 0;
  for (const locate of [p => [p, 'job_id'], p => [p.counts, 'messages'], p => { p.conflicts = [CONFLICTS[0]]; return [p.conflicts, '0']; }]) {
    const raw = plan(), [value, key] = locate(raw);
    Object.defineProperty(value, key, { enumerable: true, get() { getters++; throw Error(SECRET); } });
    assert.throws(() => api.validateEmployeeMappedNotificationsPlan(raw), redacted);
  }
  for (const locate of [s => [s, 'catalog'], s => [s.tables, '0'], s => [s.tables[0], 'chunks'],
    s => [s.catalog.finance_catalog.identity_catalog.tables, '0']]) {
    const raw = status(), [value, key] = locate(raw);
    Object.defineProperty(value, key, { enumerable: true, get() { getters++; throw Error(SECRET); } });
    assert.throws(() => api.validateEmployeeMappedNotificationsStatus(raw), redacted);
  }
  assert.equal(getters, 0);
  const badArrays = [new Array(1), Object.assign([], { hidden: true }), Object.assign([], { [Symbol('secret')]: true }), Object.setPrototypeOf([], null)];
  for (const conflicts of badArrays) assert.throws(() => api.validateEmployeeMappedNotificationsPlan({ ...plan(), conflicts }), redacted);
  const hidden = plan(); Object.defineProperty(hidden, 'job_id', { value: JOB, enumerable: false });
  for (const raw of [hidden, Object.assign(plan(), { [Symbol('secret')]: true }), Object.setPrototypeOf(plan(), { authority: true }),
    new Proxy(plan(), { ownKeys() { throw Error(SECRET); } }), null, [], SECRET]) assert.throws(() => api.validateEmployeeMappedNotificationsPlan(raw), redacted);
  const { h, s } = await ready(); const c = catalog(); Object.defineProperty(c.finance_catalog.tables, '0', { enumerable: true, get() { getters++; throw Error(SECRET); } });
  await assert.rejects(s.bind(c), redacted); assert.equal(h.calls.length, 1); assert.equal(getters, 0);
});
test('validated outputs are detached and deeply frozen, including nested finance/identity catalogs', () => {
  const raw = status(catalog(), allStaged(data())), output = api.validateEmployeeMappedNotificationsStatus(raw);
  const visit = value => { if (value && typeof value === 'object') { assert.equal(Object.isFrozen(value), true); Object.values(value).forEach(visit); } };
  visit(output); raw.catalog.finance_catalog.identity_catalog.tables[0].rows = 999; raw.plan.counts.messages = 0;
  assert.equal(output.catalog.finance_catalog.identity_catalog.tables[0].rows, 1); assert.equal(output.plan.counts.messages, 1);
  assert.throws(() => { output.tables[0].rows = 0; }, TypeError);
});
test('catalog is snapshotted before auth callbacks, and subsequent caller changes cannot rebind it', async () => {
  const h = harness(), s = session(), c = catalog(), expected = structuredClone(c);
  h.onAuth = () => { c.tables[0].rows = 22; c.finance_catalog.identity_catalog.tables[0].rows = 22; };
  h.respond(bindReply()); await s.bind(c); assert.deepEqual(h.calls[0].args.p_catalog, expected);
  h.onAuth = null; await assert.rejects(s.bind(c), redacted); assert.equal(h.calls.length, 1);
});
test('input table/chunk pairs, gaps, missing bind, raw schema/lease/duplicates and size failures occur before auth/transport', async () => {
  const h0 = harness(), s0 = session(); await assert.rejects(s0.stage('messages', 0, line('messages')), redacted); assert.equal(h0.reads, 0);
  const { h, s } = await ready();
  for (const [key, no] of [[null, 0], ['messages', null], ['users', 0], ['messages', -1], ['messages', 0.5], ['messages', '0'], ['messages', 500001]]) {
    await assert.rejects(s.status(key, no), redacted);
  }
  await assert.rejects(s.stage('messages', 1, line('messages')), redacted);
  const invalidRaw = [line('messages').trimEnd(), line('messages').replace('{', '{"id":"' + id(101) + '",'),
    line('messages').replace(TIME, '2024-02-30T12:34:56.123456Z'), line('messages').replace(PRECISE, '"bad-number"'),
    line('messages') + line('messages'), '\n', '\ud800\n', '{}\n', 'x'.repeat(262145)];
  for (const raw of invalidRaw) await assert.rejects(s.stage('messages', 0, raw), redacted);
  for (const field of LEASES) await assert.rejects(s.stage('message_recipients', 0, JSON.stringify({ ...row('message_recipients'), [field]: null }) + '\n'), redacted);
  await assert.rejects(s.stage('broadcast_messages', 0, Array.from({ length: 201 }, (_, n) => line('broadcast_messages', n + 1)).join('')), redacted);
  assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
});
test('invalid job/auth and auth failures are redacted without making a write uncertain', async () => {
  for (const token of [null, SECRET, TOKEN + '\n', id(0xab).toUpperCase()]) assert.throws(() => api.createEmployeeMappedNotificationsSession(token), redacted);
  const h = harness(), s = session(); h.authError = Error(SECRET); await assert.rejects(s.bind(catalog()), redacted);
  h.authError = null; h.auth = AUTH + '\n'; await assert.rejects(s.bind(catalog()), redacted);
  h.auth = AUTH; h.respond(bindReply()); await s.bind(catalog()); assert.equal(h.calls.length, 1);
});
test('status consistency freezes job/candidate mapping/catalog/hash and plan counters across responses', async () => {
  for (const edit of [r => { r.job_id = id(77); }, r => { r.site_id = id(77); }, r => { r.mapping_hash = OTHER; },
    r => { r.catalog_hash = OTHER; }, r => { r.catalog.date_runs_supported = false; }, r => { r.bound = false; r.catalog = null; r.catalog_hash = null; }]) {
    const { h, s } = await ready(); h.respond(status()); await s.status(); const raw = status(); edit(raw); h.respond(raw); await assert.rejects(s.status(), redacted);
    h.respond(status()); await s.status();
  }
  const { h, s } = await ready(); h.respond(plan()); await s.plan();
  for (const edit of [p => { p.plan_hash = OTHER; }, p => { p.rewards = 2; }, p => { p.employees = 2; }, p => { p.counts.messages = 2; }]) {
    const p = plan(); edit(p); h.respond(p); await assert.rejects(s.plan(), redacted);
  }
  h.respond(status()); await assert.rejects(s.status(), redacted); // complete evidence cannot regress
});
test('a plan read before any local catalog still binds counts when complete status omits its optional plan', async () => {
  const h = harness(), s = session(); h.respond(plan()); await s.plan();
  const texts = data(); texts.messages += line('messages', 2); const changed = catalog(texts);
  h.respond(status(changed, allStaged(texts), null, false)); await assert.rejects(s.status(), redacted);
  h.respond(status(catalog(), allStaged(data()), null, false)); await s.status();
});
test('progress cannot regress or change hash at the same chunk count; receipts must match the queried block', async () => {
  const texts = emptyData(), raws = [line('messages', 1), line('messages', 2)]; texts.messages = raws.join('');
  const c = catalog(texts), { h, s } = await ready(c), partial = status(c, { messages: [raws[0]] });
  h.respond(partial); await s.status();
  for (const raw of [status(c), { ...partial, tables: partial.tables.map(t => t.key === 'messages' ? { ...t, row_hashes_sha256: OTHER } : t) }]) {
    h.respond(raw); await assert.rejects(s.status(), redacted);
  }
  h.respond({ ...partial, chunk: chunk('messages', 0, raws[0]) }); await s.status('messages', 0);
  h.respond({ ...partial, chunk: { ...chunk('messages', 0, raws[0]), sha256: OTHER } }); await assert.rejects(s.status('messages', 0), redacted);
  h.respond(partial); await assert.rejects(s.status('messages', 0), redacted);
  h.respond({ ...partial, chunk: chunk('messages', 0, raws[0]) }); await assert.rejects(s.status(), redacted);
  h.respond({ ...partial, chunk: chunk('messages', 0, raws[0]) }); await assert.rejects(s.status('messages', 1), redacted);
  h.respond(status(c, { messages: raws }, chunk('messages', 1, raws[1]))); await s.status('messages', 1);
});
test('a queried new receipt must exactly account for its progress delta, not just fit the total counters', async () => {
  const texts = emptyData(), raws = [line('messages', 1), line('messages', 2), line('messages', 3)];
  texts.messages = raws.join(''); const c = catalog(texts), { h, s } = await ready(c);
  h.respond(status(c, { messages: [raws[0]] })); await s.status();
  const final = status(c, { messages: [raws[0], raws[1] + raws[2]] });
  h.respond({ ...final, chunk: chunk('messages', 1, raws[1]) }); await assert.rejects(s.status('messages', 1), redacted);
  h.respond({ ...final, chunk: chunk('messages', 1, raws[1] + raws[2]) }); await s.status('messages', 1);
});
test('locally confirmed stages constrain later status even when no prior status was requested', async () => {
  const { h, s } = await ready(); h.respond(stageReply()); await s.stage('messages', 0, line('messages'));
  h.respond(status()); await assert.rejects(s.status(), redacted);
  const raw = status(catalog(), { messages: [line('messages')] }, chunk('messages'));
  h.respond(raw); await s.status('messages', 0);
  await assert.rejects(s.stage('messages', 0, line('messages').replace('unverified', 'automation')), redacted);
  await assert.rejects(s.stage('messages', 1, line('messages')), redacted);
  assert.equal(h.calls.length, 4);
});
for (const mode of ['backend', 'reject', 'throw', 'malformed']) test(`unknown bind ${mode}: exact catalog status required; only user-explicit bind/stage can continue`, async () => {
  const h = harness(), s = session();
  h.replies.push(mode === 'backend' ? { error: { message: SECRET } } : mode === 'reject' ? { reject: Error(SECRET) }
    : mode === 'throw' ? { throw: Error(SECRET) } : { data: { ...bindReply(), repeated: true } });
  await assert.rejects(s.bind(catalog()), redacted); await writesBlocked(s, h);
  const bad = status(); bad.catalog.date_runs_supported = false; h.respond(bad); await assert.rejects(s.status(), redacted); await writesBlocked(s, h);
  h.respond(status()); await s.status(); assert.equal(h.calls.length, 3);
  h.respond(stageReply()); await s.stage('messages', 0, line('messages')); assert.equal(h.calls.length, 4);
});
test('uncommitted unknown bind can explicitly retry only the exact pinned catalog, without automatic resend', async () => {
  const h = harness(), s = session(); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.bind(catalog()), redacted);
  h.respond(unbound()); await s.status(); assert.equal(h.calls.length, 2);
  const other = catalog(); other.date_runs_supported = false; await assert.rejects(s.bind(other), redacted);
  h.respond(bindReply()); await s.bind(catalog()); assert.equal(h.calls.length, 3);
});
test('successful plan cannot unlock an unknown bind or stage; explicit status remains mandatory', async () => {
  for (const op of ['bind', 'stage']) {
    const h = harness(), s = session();
    if (op === 'stage') { h.respond(bindReply()); await s.bind(catalog()); }
    h.replies.push({ reject: Error(SECRET) });
    await assert.rejects(op === 'bind' ? s.bind(catalog()) : s.stage('messages', 0, line('messages')), redacted);
    h.respond(plan()); await s.plan(); await writesBlocked(s, h);
    h.respond(status(catalog(), allStaged(data()), op === 'stage' ? chunk('messages') : null));
    await s.status(op === 'stage' ? 'messages' : null, op === 'stage' ? 0 : null);
    h.respond(bindReply()); await s.bind(catalog());
  }
});
for (const submitted of [false, true]) test(`unknown stage submitted=${submitted}: only same table+chunk status clears uncertainty`, async () => {
  const { h, s } = await ready(); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.stage('messages', 0, line('messages')), redacted);
  const staged = submitted ? { messages: [line('messages')] } : {};
  h.respond(status(catalog(), staged)); await s.status(); await writesBlocked(s, h);
  h.respond(status(catalog(), staged)); await s.status('messages', 1); await writesBlocked(s, h);
  h.respond(status(catalog(), staged)); await s.status('broadcast_messages', 0); await writesBlocked(s, h);
  if (submitted) {
    h.respond(status(catalog(), staged, { ...chunk('messages'), sha256: OTHER })); await assert.rejects(s.status('messages', 0), redacted); await writesBlocked(s, h);
  }
  h.respond(status(catalog(), staged, submitted ? chunk('messages') : null)); await s.status('messages', 0);
  const calls = h.calls.length; h.respond(stageReply()); await s.stage('messages', 0, line('messages')); assert.equal(h.calls.length, calls + 1);
});
test('stage receipts are unknown writes on failure, not success; all identity/byte/digest fields are checked', async () => {
  const edits = [r => { r.scope = 'site-notifications'; }, r => { r.success = false; }, r => { r.full_site_complete = true; },
    r => { r.repeated = true; }, r => { r.table_key = 'broadcast_messages'; }, r => { r.chunk_no = 1; },
    r => { r.rows = 0; }, r => { r.bytes++; }, r => { r.sha256 = OTHER; }, r => { r.sha256 += '\n'; }];
  for (const edit of edits) {
    const { h, s } = await ready(); const raw = stageReply(); edit(raw); h.respond(raw);
    await assert.rejects(s.stage('messages', 0, line('messages')), redacted); await writesBlocked(s, h);
    h.respond(status()); await s.status('messages', 0); h.respond(stageReply()); await s.stage('messages', 0, line('messages'));
  }
});
test('pre-abort and auth-time abort dispatch no write and do not poison the session', async () => {
  for (const duringAuth of [false, true]) {
    const h = harness(), s = session(), controller = new AbortController();
    if (duringAuth) h.onAuth = () => controller.abort(SECRET); else controller.abort(SECRET);
    await assert.rejects(s.bind(catalog(), controller.signal), aborted); assert.equal(h.calls.length, 0);
    h.onAuth = null; h.respond(bindReply()); await s.bind(catalog()); assert.equal(h.calls.length, 1);
  }
});
for (const op of ['bind', 'stage', 'plan', 'status']) test(`cancel ${op}: signal-ignoring underlying request retains mutex until actual settlement`, async () => {
  const h = harness(), s = session(), controller = new AbortController(), wait = deferred();
  if (op === 'stage') { h.respond(bindReply()); await s.bind(catalog()); }
  h.replies.push({ wait: wait.promise });
  const call = op === 'bind' ? s.bind(catalog(), controller.signal) : op === 'stage' ? s.stage('messages', 0, line('messages'), controller.signal)
    : op === 'status' ? s.status(null, null, controller.signal) : s.plan(controller.signal);
  await turn(); controller.abort(SECRET); await assert.rejects(call, aborted);
  const calls = h.calls.length, reads = h.reads;
  await assert.rejects(s.status(), redacted); await assert.rejects(s.plan(), redacted); await writesBlocked(s, h);
  assert.equal(h.calls.length, calls); assert.equal(h.reads, reads);
  wait.resolve({ data: op === 'bind' ? bindReply() : op === 'stage' ? stageReply() : op === 'plan' ? plan() : status(), error: null }); await turn();
  if (op === 'bind' || op === 'stage') await writesBlocked(s, h);
  h.respond(status()); await s.status(op === 'stage' ? 'messages' : null, op === 'stage' ? 0 : null);
  h.respond(bindReply()); await s.bind(catalog());
});
test('abortSignal attachment error still tracks original transport and requires explicit unknown-write reconciliation', async () => {
  const h = harness(), s = session(), wait = deferred(), signal = new AbortController().signal;
  h.replies.push({ signalError: Error(SECRET), wait: wait.promise }); await assert.rejects(s.bind(catalog(), signal), redacted);
  await assert.rejects(s.status(), redacted); wait.reject(Error(SECRET)); await turn(); await writesBlocked(s, h);
  h.respond(unbound()); await s.status(); h.respond(bindReply()); await s.bind(catalog());
});
test('noncancelled concurrent operations are rejected locally, and settled read errors never unlock unknown writes', async () => {
  const { h, s } = await ready(), wait = deferred(); h.replies.push({ wait: wait.promise }); const active = s.plan(); await turn();
  await assert.rejects(s.status(), redacted); await assert.rejects(s.bind(catalog()), redacted);
  wait.reject(Error(SECRET)); await assert.rejects(active, redacted);
  h.replies.push({ error: { message: SECRET } }); await assert.rejects(s.stage('messages', 0, line('messages')), redacted);
  h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.status('messages', 0), redacted); await writesBlocked(s, h);
  h.respond(status()); await s.status('messages', 0);
});
