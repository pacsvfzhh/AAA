import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `37000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SESSION = id(1), TOKEN = id(2), JOB = id(3), SITE = id(4), PACKAGE = id(5), SOURCE = id(6), TARGET = id(7);
const SECRET = 'backend-password-session-token-raw-private-data-must-not-leak';
const PLAN = 'employee_import_replacement_plan', STATUS = 'employee_import_replacement_status';
const HASH = 'a'.repeat(64), SOURCE_HASH = 'b'.repeat(64), OTHER_HASH = 'c'.repeat(64);
const PRECISE = '12345678901234567890.12345678901234567890';
const BARRIERS = ['complete_employee_backup_missing', 'identity_mapping_missing', 'maintenance_blocks_existing_archive'];
const redacted = error => {
  assert.ok(error instanceof Error); assert.equal(String(error).includes(SECRET), false);
  assert.equal('cause' in error, false); assert.equal('details' in error, false); return true;
};
mock.method(globalThis, 'fetch', () => assert.fail('network and formal services forbidden'));
after(() => mock.restoreAll());
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/employeeReplacement.ts'; export {setHarness} from 'replacement-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'isolated-replacement-read-transport', setup(builder) {
    builder.onResolve({ filter: /^(?:replacement-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'replacement-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'replacement-test' }, ({ path }) => ({ contents: path === 'replacement-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth' ? 'import{current}from"replacement-test:state";export function getAdminFinancialSessionToken(){const h=current();h.reads++;if(h.authError)throw h.authError;return h.session;}'
        : 'import{current}from"replacement-test:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' }));
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function plan(archived = false) {
  const target = { target_id: TARGET, username: 'same-name', employee_no: 'TARGET-NUMBER', archived,
    archive_record_id: archived ? id(99) : null, archive_evidence: archived,
    available_balance: PRECISE, frozen_balance: '0.00000000000000000001', pending_withdrawals: 1, pending_amount: PRECISE,
    completed_orders: 10, chat: archived ? 0 : 20, login: 2, last_login: '2024-02-29T00:00:00.123456+00:00',
    fingerprint: HASH, username_released: archived, employee_no_released: archived };
  return { scope: 'employee-replacement', checked: true, job_id: JOB, source_site_id: SITE, package_id: PACKAGE,
    after: null, limit: 100, next_after: null, total_sources: 1, counts: { sources: 1, conflicts: 1, archived: archived ? 1 : 0 },
    rows: [{ source_id: SOURCE, username: 'same-name', source_employee_no: 'SOURCE-NUMBER', targets: [target], blockers: [...BARRIERS], backup_required: true, can_archive: false }],
    source_fingerprint: SOURCE_HASH, target_fingerprint: HASH, backup_required: true,
    username_released: archived, employee_no_released: archived, source_employee_no_released: true,
    maintenance: true, can_archive: false, can_replace: false, complete_employee_backup_missing: true, identity_mapping_missing: true, full_site_complete: false };
}
const baseline = () => ({ after: null, limit: 100, source_fingerprint: SOURCE_HASH, target_fingerprint: HASH });
const status = (archived = false, changed = false) => ({ ...plan(archived), target_fingerprint: changed ? OTHER_HASH : HASH, expected_target_fingerprint: HASH, target_unchanged: !changed });
function harness() {
  const h = { session: SESSION, calls: [], replies: [], reads: 0, authError: null,
    respond(data) { h.replies.push({ data }); }, rpc(name, args) {
      assert.ok([PLAN, STATUS].includes(name)); assert.ok(h.replies.length, `unexpected ${name}`);
      const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
      const reply = h.replies.shift(); if (reply.throw) throw reply.throw;
      const query = { abortSignal(signal) { call.signals.push(signal); return query; }, then(resolve, reject) {
        return Promise.resolve().then(() => { if (reply.reject) throw reply.reject; return reply.wait ?? { data: reply.data, error: reply.error ?? null }; }).then(resolve, reject);
      } }; return query;
    } };
  api.setHarness(h); return h;
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }

test('module exposes read-only plan/status and no archive, write, backup callback or completion capability', () => {
  assert.deepEqual(Object.keys(api).sort(), ['EMPLOYEE_REPLACEMENT_BLOCKERS', 'createEmployeeReplacementSession', 'employeeReplacementCheckpoint', 'setHarness', 'validateEmployeeReplacementPlan', 'validateEmployeeReplacementStatus']);
  const h = harness(), s = api.createEmployeeReplacementSession(TOKEN);
  assert.deepEqual(Object.keys(s).sort(), ['plan', 'status']); assert.equal(h.calls.length, 0); assert.equal(h.reads, 0);
  const inputs = Object.keys(compiled.metafile.inputs);
  assert.equal(inputs.some(path => /node_modules|\/(?:container|crypto|replacementBackup|identityApi|identityTransfer|api)\.ts$/.test(path)), false);
});
test('exact parameters from original task and fresh financial session on each request; no target IDs or backed-up claims', async () => {
  const h = harness(), s = api.createEmployeeReplacementSession(TOKEN), signal = new AbortController().signal;
  h.respond(plan()); const p = await s.plan(null, 100, signal);
  assert.deepEqual(h.calls[0], { name: PLAN, args: { p_after: null, p_limit: 100, p_admin_session_token: SESSION, p_job_token: TOKEN }, signals: [signal] });
  h.session = id(20); h.respond(status()); await s.status(api.employeeReplacementCheckpoint(p));
  assert.deepEqual(h.calls[1].args, { p_after: null, p_limit: 100, p_source_fingerprint: SOURCE_HASH, p_target_fingerprint: HASH,
    p_admin_session_token: id(20), p_job_token: TOKEN });
  assert.equal(h.reads, 2); assert.equal(h.calls.length, 2);
});
test('decimal money, microseconds and observed page counts remain unchanged and detached from input', async () => {
  const h = harness(), s = api.createEmployeeReplacementSession(TOKEN), input = plan(); h.respond(input);
  const p = await s.plan(); assert.deepEqual(p, input); assert.equal(p.rows[0].targets[0].available_balance, PRECISE);
  p.rows[0].targets[0].available_balance = '0'; p.counts.sources = 0; p.rows[0].blockers.pop();
  assert.equal(input.rows[0].targets[0].available_balance, PRECISE); assert.equal(input.counts.sources, 1); assert.equal(input.rows[0].blockers.length, 3);
  assert.deepEqual(api.employeeReplacementCheckpoint(input), baseline());
});
test('a saved checkpoint resumes on a new client, archived observation and drift never imply replacement completion', async () => {
  const h = harness(), saved = baseline(), s = api.createEmployeeReplacementSession(TOKEN);
  h.respond(status(true, true)); const r = await s.status(saved);
  assert.equal(r.counts.archived, 1); assert.equal(r.rows[0].targets[0].archive_evidence, true); assert.equal(r.target_unchanged, false);
  assert.equal(r.can_archive, false); assert.equal(r.can_replace, false); assert.equal(r.backup_required, true); assert.equal(r.full_site_complete, false);
  saved.target_fingerprint = OTHER_HASH; assert.equal(h.calls[0].args.p_target_fingerprint, HASH);
});
for (const [label, change] of [
  ['archive enabled', p => { p.can_archive = true; }], ['replace enabled', p => { p.can_replace = true; }],
  ['complete claimed', p => { p.full_site_complete = true; }], ['missing backup gate', p => { p.complete_employee_backup_missing = false; }],
  ['missing map gate', p => { p.identity_mapping_missing = false; }], ['unchecked', p => { p.checked = false; }],
  ['maintenance hidden', p => { p.maintenance = false; }], ['unknown property', p => { p.backup_verified = true; }],
  ['missing property', p => { delete p.can_archive; }], ['wrong scope', p => { p.scope = 'employee-identity'; }],
  ['incorrect source count', p => { p.counts.sources++; }], ['incorrect conflict count', p => { p.counts.conflicts = 0; }],
  ['incorrect archived count', p => { p.counts.archived = 1; }], ['invented progress', p => { p.counts.completed = 1; }],
  ['wrong total', p => { p.total_sources = 0; }], ['unsafe total', p => { p.total_sources = 500001; }],
  ['truncated first page', p => { p.total_sources = 2; }],
  ['wrong backup requirement', p => { p.backup_required = false; }], ['row backup omitted', p => { p.rows[0].backup_required = false; }],
  ['row archive enabled', p => { p.rows[0].can_archive = true; }], ['unknown blocker', p => { p.rows[0].blockers.push(SECRET); }],
  ['duplicate blocker', p => { p.rows[0].blockers.push(p.rows[0].blockers[0]); }], ['backup blocker removed', p => { p.rows[0].blockers.shift(); }],
  ['ambiguous flag incorrect', p => { p.rows[0].blockers.push('ambiguous_target_history'); }],
  ['mismatched target username', p => { p.rows[0].targets[0].username = 'arbitrary-person'; }],
  ['wrong target ID', p => { p.rows[0].targets[0].target_id = SECRET; }], ['forged release', p => { p.rows[0].targets[0].username_released = true; }],
  ['invented evidence', p => { p.rows[0].targets[0].archive_evidence = true; }],
  ['missing archive record', p => { const t = p.rows[0].targets[0]; t.archived = true; t.archive_evidence = true; }],
  ['aggregate release mismatch', p => { p.username_released = true; }], ['aggregate employee number release mismatch', p => { p.employee_no_released = true; }],
  ['numeric money', p => { p.rows[0].targets[0].available_balance = 0.1; }], ['partial null wallet', p => { p.rows[0].targets[0].frozen_balance = null; }],
  ['exponent amount', p => { p.rows[0].targets[0].pending_amount = '1e20'; }], ['newline amount', p => { p.rows[0].targets[0].pending_amount = '1\n'; }],
  ['NaN amount', p => { p.rows[0].targets[0].pending_amount = 'NaN'; }], ['negative pending', p => { p.rows[0].targets[0].pending_amount = '-1'; }],
  ['leading zero amount', p => { p.rows[0].targets[0].available_balance = '001'; }],
  ['bad timestamp', p => { p.rows[0].targets[0].last_login = '2024-02-30T00:00:00Z'; }],
  ['newline timestamp', p => { p.rows[0].targets[0].last_login += '\n'; }], ['numeric timestamp', p => { p.rows[0].targets[0].last_login = 1; }],
  ['negative chat count', p => { p.rows[0].targets[0].chat = -1; }], ['fractional login count', p => { p.rows[0].targets[0].login = 0.5; }],
  ['hash wrong length', p => { p.target_fingerprint += '\n'; }], ['bad source hash', p => { p.source_fingerprint = SECRET; }],
  ['wrong job ID', p => { p.job_id = 0; }], ['wrong package ID', p => { p.package_id += '\n'; }],
  ['source surrogate', p => { p.rows[0].username = '\ud800'; }], ['zero limit', p => { p.limit = 0; }],
  ['oversized limit', p => { p.limit = 201; }], ['unconfirmed next cursor', p => { p.next_after = SOURCE; }],
  ['duplicate source', p => { p.rows.push(structuredClone(p.rows[0])); p.counts.sources++; p.counts.conflicts++; p.total_sources++; }],
  ['source behind cursor', p => { p.after = SOURCE; }], ['duplicate target', p => { p.rows[0].targets.push(structuredClone(p.rows[0].targets[0])); }],
]) test(`strict receipt rejects ${label} without a retry or progress`, async () => {
  const h = harness(), s = api.createEmployeeReplacementSession(TOKEN), p = plan(); change(p); h.respond(p);
  await assert.rejects(s.plan(), redacted); assert.equal(h.calls.length, 1);
  assert.throws(() => api.validateEmployeeReplacementPlan(p), redacted);
});
for (const [label, change] of [
  ['wrong baseline', r => { r.expected_target_fingerprint = OTHER_HASH; }], ['false unchanged', r => { r.target_unchanged = false; }],
  ['source changed', r => { r.source_fingerprint = OTHER_HASH; }], ['wrong page', r => { r.limit = 200; }],
  ['absent evidence status', r => { delete r.target_unchanged; }], ['backup declaration', r => { r.backup_saved = true; }],
]) test(`status rejects ${label}`, async () => {
  const h = harness(), s = api.createEmployeeReplacementSession(TOKEN), r = status(); change(r); h.respond(r);
  await assert.rejects(s.status(baseline()), redacted); assert.equal(h.calls.length, 1);
});
test('getters, sparse arrays, symbol properties and proxies cannot inject baseline or success', () => {
  let invoked = 0;
  for (const field of ['rows', 'can_archive', 'target_fingerprint']) {
    const p = plan(); Object.defineProperty(p, field, { enumerable: true, get() { invoked++; throw Error(SECRET); } });
    assert.throws(() => api.validateEmployeeReplacementPlan(p), redacted);
  }
  const p = plan(); Object.defineProperty(p.rows, '0', { enumerable: true, get() { invoked++; throw Error(SECRET); } });
  assert.throws(() => api.validateEmployeeReplacementPlan(p), redacted); assert.equal(invoked, 0);
  const sparse = plan(); delete sparse.rows[0]; assert.throws(() => api.validateEmployeeReplacementPlan(sparse), redacted);
  const symbol = plan(); symbol[Symbol('backup')] = true; assert.throws(() => api.validateEmployeeReplacementPlan(symbol), redacted);
  assert.throws(() => api.validateEmployeeReplacementPlan(new Proxy(plan(), { ownKeys() { throw Error(SECRET); } })), redacted);
});
for (const operation of ['plan', 'status']) for (const mode of ['throw', 'reject', 'error', 'malformed']) test(`${operation} ${mode}: backend error sanitized, no automatic retry`, async () => {
  const h = harness(), s = api.createEmployeeReplacementSession(TOKEN);
  h.replies.push(mode === 'error' ? { error: { message: SECRET, details: SECRET } } : mode === 'malformed' ? { data: { error: SECRET } } : { [mode]: Error(SECRET) });
  await assert.rejects(operation === 'plan' ? s.plan() : s.status(baseline()), redacted); assert.equal(h.calls.length, 1);
});
test('invalid source cursor/limits/checkpoints and expired/throwing auth are rejected before dispatch', async () => {
  const h = harness(), s = api.createEmployeeReplacementSession(TOKEN);
  assert.throws(() => api.createEmployeeReplacementSession(SECRET), redacted);
  for (const args of [[TARGET + '\n', 100], [null, 0], [null, 201], [null, 1.5]]) await assert.rejects(s.plan(...args), redacted);
  for (const input of [{ ...baseline(), target_ids: [TARGET] }, { ...baseline(), backup_verified: true }, { ...baseline(), target_fingerprint: SECRET }]) {
    await assert.rejects(s.status(input), redacted);
  }
  h.session = null; await assert.rejects(s.plan(), redacted); h.authError = Error(SECRET); await assert.rejects(s.status(baseline()), redacted);
  assert.equal(h.calls.length, 0);
  h.authError = null; h.session = SESSION; h.respond(plan()); assert.equal((await s.plan()).full_site_complete, false);
});
test('cancellation, concurrency and late responses cannot confirm a completed operation', async () => {
  const h = harness(), s = api.createEmployeeReplacementSession(TOKEN), controller = new AbortController(); controller.abort(SECRET);
  await assert.rejects(s.plan(null, 100, controller.signal), error => redacted(error) && error.name === 'AbortError'); assert.equal(h.calls.length, 0);
  const wait = deferred(), current = new AbortController(); h.replies.push({ wait: wait.promise });
  const pending = s.plan(null, 100, current.signal); await Promise.resolve(); await Promise.resolve();
  await assert.rejects(s.status(baseline()), redacted); assert.equal(h.calls.length, 1);
  current.abort(SECRET); await assert.rejects(pending, error => redacted(error) && error.name === 'AbortError');
  wait.resolve({ data: plan(), error: null }); h.respond(status()); assert.equal((await s.status(baseline())).can_replace, false);
});
test('actual shared supabase transport makes one POST attempt, no implicit retries or XHR fallback', async t => {
  const compiled = await build({ entryPoints: [`${root}src/lib/supabase.ts`], bundle: true, write: false, platform: 'browser', format: 'esm',
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://local.invalid'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('local-only-test-key') },
    plugins: [{ name: 'capture-config-not-network', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'local-client', namespace: 'capture' }));
      builder.onLoad({ filter: /.*/, namespace: 'capture' }, () => ({ contents: 'export const createClient=(url,key,options)=>({testFetch:options.global.fetch});' }));
    } }] });
  let calls = 0, xhrCalls = 0, fail = false;
  t.mock.method(globalThis, 'fetch', async () => { calls++; if (fail) throw new TypeError('Failed to fetch'); return new Response('{}', { status: 503 }); });
  const transport = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const xhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: function () { xhrCalls++; assert.fail('XHR fallback forbidden'); } });
  t.after(() => { if (xhr) Object.defineProperty(globalThis, 'XMLHttpRequest', xhr); else delete globalThis.XMLHttpRequest; });
  for (const name of [PLAN, STATUS]) {
    calls = 0; fail = false; assert.equal((await transport.supabase.testFetch(`https://local.invalid/rest/v1/rpc/${name}`, { method: 'POST' })).status, 503);
    assert.equal(calls, 1); calls = 0; fail = true;
    await assert.rejects(transport.supabase.testFetch(`https://local.invalid/rest/v1/rpc/${name}`, { method: 'POST' })); assert.equal(calls, 1); assert.equal(xhrCalls, 0);
  }
});
test('fresh, nullable-wallet and empty last-page observations remain read-only, counts are not invented', () => {
  const p = plan(); p.rows[0].targets = []; p.rows[0].blockers = []; p.rows[0].backup_required = false;
  p.backup_required = false; p.username_released = true; p.employee_no_released = true; p.counts.conflicts = 0;
  assert.deepEqual(api.validateEmployeeReplacementPlan(p), p);
  const admin = structuredClone(p); admin.rows[0].blockers = ['administrator_username_conflict']; admin.counts.conflicts = 1; admin.username_released = false;
  assert.deepEqual(api.validateEmployeeReplacementPlan(admin), admin);
  admin.username_released = true; assert.throws(() => api.validateEmployeeReplacementPlan(admin), redacted);
  const empty = { ...p, after: SOURCE, rows: [], counts: { sources: 0, conflicts: 0, archived: 0 } };
  assert.deepEqual(api.validateEmployeeReplacementPlan(empty), empty);
  const nullable = plan(); nullable.rows[0].targets[0].available_balance = null; nullable.rows[0].targets[0].frozen_balance = null;
  nullable.rows[0].targets[0].last_login = null; assert.deepEqual(api.validateEmployeeReplacementPlan(nullable), nullable);
});
