import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `49000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SESSION = id(1), TOKEN = id(2), JOB = id(3), SITE = id(4), SOURCE_SITE = id(5), PACKAGE = id(6);
const SOURCE = id(7), TARGET = id(8), OTHER_SOURCE = id(9), OTHER_TARGET = id(10);
const SOURCE_HASH = 'a'.repeat(64), BINDING_HASH = 'b'.repeat(64), PLAN_HASH = 'c'.repeat(64), OTHER_HASH = 'd'.repeat(64);
const SECRET = 'private-session-job-token-password-source-row-never-expose';
const OPERATIONS = ['plan', 'core', 'orders', 'verify', 'status'];
const rpc = operation => `employee_import_mapped_identity_${operation}`;
const TASK_KEYS = ['job_id', 'site_id', 'source_site_id', 'package_id'];
const BINDING_KEYS = [...TASK_KEYS, 'source_id', 'target_id', 'source_fingerprint', 'binding_hash', 'plan_hash'];
const FLAGS = { maintenance: true, dependencies_pending: true, can_restore: false, complete_employee_backup: false,
  can_archive: false, can_replace: false, full_site_complete: false };
const CONFLICTS = ['reservation_drift', 'candidate_occupied', 'source_uuid_occupied', 'username_requires_archive',
  'employee_number_conflict', 'administrator_username_conflict', 'archive_history_requires_backup',
  'unmapped_administrator', 'order_id_conflict', 'placeholder_product_active'];
let forbiddenNetwork = 0;
mock.method(globalThis, 'fetch', () => { forbiddenNetwork++; assert.fail('network/formal services forbidden'); });
after(() => { assert.equal(forbiddenNetwork, 0); mock.restoreAll(); });

const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/employeeMappedIdentity.ts'; export {setHarness} from 'mapped-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'isolated-mapped-identity', setup(builder) {
    builder.onResolve({ filter: /^(?:mapped-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'mapped-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'mapped-test' }, ({ path }) => ({ contents: path === 'mapped-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth'
        ? 'import{current}from"mapped-test:state";export function getAdminFinancialSessionToken(){const h=current();h.reads++;h.onAuth?.();if(h.authError)throw h.authError;return h.session;}'
        : 'import{current}from"mapped-test:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const redacted = error => {
  assert.ok(error instanceof Error);
  for (const secret of [SECRET, SESSION, TOKEN, SOURCE, SOURCE_HASH, BINDING_HASH, PLAN_HASH]) assert.equal(String(error).includes(secret), false);
  for (const key of ['cause', 'details', 'hint']) assert.equal(key in error, false);
  return true;
};
const aborted = error => redacted(error) && error.name === 'AbortError';
const common = () => ({ scope: 'employee-mapped-identity', job_id: JOB, site_id: SITE, source_site_id: SOURCE_SITE,
  package_id: PACKAGE, source_id: SOURCE, target_id: TARGET,
  source_fingerprint: SOURCE_HASH, binding_hash: BINDING_HASH, plan_hash: PLAN_HASH, ...FLAGS });
const totals = () => ({ accounts: 1, credentials: 1, orders: 2 });
const plan = () => ({ ...common(), can_begin: true, conflicts: [], totals: totals(), order_chunks: 3 });
const status = (next = 0, orders = 0, verified = false) => ({ ...common(), counts: { accounts: 1, credentials: 1, orders },
  totals: totals(), next_chunk: next, order_chunks: 3, verified });
function harness() {
  const h = { session: SESSION, calls: [], replies: [], reads: 0, authError: null, onAuth: null,
    respond(data) { h.replies.push({ data }); },
    rpc(name, args) {
      assert.ok(OPERATIONS.map(rpc).includes(name), `forbidden RPC ${name}`);
      assert.ok(h.replies.length, `unexpected ${name}`);
      const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
      const reply = h.replies.shift();
      if (reply.throw) throw reply.throw;
      const query = {
        abortSignal(signal) { call.signals.push(signal); if (reply.signalError) throw reply.signalError; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (reply.reject) throw reply.reject;
            return reply.wait ?? { data: reply.data, error: reply.error ?? null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  api.setHarness(h); return h;
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const invoke = (s, op, signal) => op === 'core' ? s.core(plan(), signal)
  : op === 'orders' ? s.orders(SOURCE, 0, signal) : s[op](SOURCE, signal);
const replyFor = op => op === 'plan' ? plan() : op === 'orders' ? status(1, 0) : op === 'verify' ? status(3, 2, true) : status();
async function ready(op) {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN);
  if (op === 'orders' || op === 'verify') {
    h.respond(op === 'orders' ? status() : status(3, 2)); await s.status(SOURCE);
  }
  return { h, s, before: h.calls.length };
}

test('browser bundle is lazy, isolated and exposes only five explicit operations plus pure validators/checkpoint', () => {
  assert.deepEqual(Object.keys(api).sort(), ['createEmployeeMappedIdentitySession', 'employeeMappedIdentityCheckpoint',
    'setHarness', 'validateEmployeeMappedIdentityPlan', 'validateEmployeeMappedIdentityStatus']);
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN);
  assert.deepEqual(Object.keys(s).sort(), [...OPERATIONS].sort()); assert.equal(h.reads, 0); assert.equal(h.calls.length, 0);
  assert.equal(Object.keys(compiled.metafile.inputs).some(path => /node_modules|(?:^|\/)src\/lib\/(?:auth|supabase)\.ts$|\/(?:identityApi|employeeIdentityReservation|employeeIdentityProjection|employeeSafetyBackup|api|container|crypto)\.ts$/.test(path)), false);
});
test('plan/core/global-order-chunks/verify/status: one RPC per explicit call, fresh auth and maintenance-only success', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN), signal = new AbortController().signal;
  h.respond(plan()); const p = await s.plan(SOURCE, signal); assert.deepEqual(p, plan());
  assert.equal(p.can_begin, true); assert.equal(p.can_restore, false);
  h.respond(status()); assert.deepEqual(await s.core(p, signal), status());
  for (const [chunk, orders] of [[0, 0], [1, 1], [2, 2]]) {
    h.session = id(30 + chunk); h.respond(status(chunk + 1, orders));
    assert.equal((await s.orders(SOURCE, chunk, signal)).counts.orders, orders);
  }
  h.respond(status(3, 2, true)); assert.equal((await s.verify(SOURCE, signal)).verified, true);
  h.respond(status(3, 2, true)); assert.equal((await s.status(SOURCE, signal)).verified, true);
  assert.deepEqual(h.calls.map(c => c.name), ['plan', 'core', 'orders', 'orders', 'orders', 'verify', 'status'].map(rpc));
  for (const [index, call] of h.calls.entries()) {
    const args = { p_admin_session_token: index < 2 ? SESSION : id(index < 5 ? index + 28 : 32), p_job_token: TOKEN, p_source_id: SOURCE };
    if (index === 1) args.p_plan_hash = PLAN_HASH;
    if (index >= 2 && index < 5) args.p_chunk_no = index - 2;
    assert.deepEqual(call, { name: call.name, args, signals: [signal] });
    assert.equal('p_target_id' in call.args, false);
  }
  assert.equal(h.calls.length, 7); assert.equal(h.reads, 7);
  for (const [field, expected] of Object.entries(FLAGS)) assert.equal(p[field], expected);
});
test('zero credentials and zero employee orders still scan every global order chunk before verification', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN);
  const shape = value => ({ ...value, totals: { accounts: 1, credentials: 0, orders: 0 },
    ...('counts' in value ? { counts: { accounts: 1, credentials: 0, orders: 0 } } : {}) });
  h.respond(shape(plan())); const p = await s.plan(SOURCE);
  h.respond(shape(status())); await s.core(p);
  await assert.rejects(s.verify(SOURCE), redacted); assert.equal(h.calls.length, 2);
  for (let chunk = 0; chunk < 3; chunk++) {
    h.respond(shape(status(chunk + 1))); await s.orders(SOURCE, chunk);
  }
  h.respond(shape(status(3, 0, true))); assert.equal((await s.verify(SOURCE)).verified, true);
  assert.equal(h.calls.length, 6);
});
test('checkpoint uses the exact plan shape, is deeply frozen and detached, and resumes with one core RPC only', async () => {
  const h = harness(), raw = plan(), cp = api.employeeMappedIdentityCheckpoint(raw);
  assert.deepEqual(Object.keys(cp).sort(), Object.keys(raw).sort());
  for (const value of [cp, cp.totals, cp.conflicts]) assert.equal(Object.isFrozen(value), true);
  raw.source_id = OTHER_SOURCE; raw.totals.orders = 99; raw.conflicts.push(CONFLICTS[0]);
  assert.deepEqual(cp, plan()); assert.throws(() => { cp.totals.orders = 99; }, TypeError);
  const s = api.createEmployeeMappedIdentitySession(TOKEN); h.respond(status());
  assert.deepEqual(await s.core(cp), status()); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, rpc('core'));
});
for (const conflict of CONFLICTS) test(`conflict enum accepted but core blocked: ${conflict}`, async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN), p = { ...plan(), can_begin: false, conflicts: [conflict] };
  h.respond(p); const result = await s.plan(SOURCE); assert.deepEqual(result, p);
  assert.throws(() => api.employeeMappedIdentityCheckpoint(result), redacted);
  await assert.rejects(s.core(result), redacted); assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
});
test('all conflicts may coexist without reordering or manufacturing full restore authorization', () => {
  harness(); const p = { ...plan(), can_begin: false, conflicts: [...CONFLICTS].reverse() };
  assert.deepEqual(api.validateEmployeeMappedIdentityPlan(p), p);
});

const malformedPlan = [
  ['extra key', p => { p.checked = true; }], ['missing conflicts', p => { delete p.conflicts; }],
  ['status instead of plan', () => status()], ['can_begin numeric', p => { p.can_begin = 1; }],
  ['empty conflict list but cannot begin', p => { p.can_begin = false; }],
  ['nonempty conflict list but can begin', p => { p.conflicts = [CONFLICTS[0]]; }],
  ['unknown conflict', p => { p.can_begin = false; p.conflicts = ['backup_verified']; }],
  ['duplicate conflict', p => { p.can_begin = false; p.conflicts = [CONFLICTS[0], CONFLICTS[0]]; }],
  ['conflicts not array', p => { p.conflicts = {}; }],
  ['sparse conflicts', p => { p.can_begin = false; p.conflicts = new Array(1); }],
  ['conflicts extra property', p => { p.conflicts.extra = true; }],
  ['conflicts symbol', p => { p.conflicts[Symbol('authority')] = true; }],
  ['wrong conflict case', p => { p.can_begin = false; p.conflicts = ['RESERVATION_DRIFT']; }],
];
const malformedStatus = [
  ['extra can_begin', p => { p.can_begin = true; }], ['extra conflicts', p => { p.conflicts = []; }],
  ['plan instead of status', () => plan()], ['missing counts', p => { delete p.counts; }],
  ['count accounts zero', p => { p.counts.accounts = 0; }], ['count credentials exceed totals', p => { p.counts.credentials = 0; }],
  ['orders exceed totals', p => { p.counts.orders = 3; }],
  ['nonzero orders at cursor zero', p => { p.counts.orders = 1; }],
  ['complete cursor with missing rows', p => { p.next_chunk = 3; p.counts.orders = 1; }],
  ['verified before complete cursor', p => { p.verified = true; p.counts.orders = 0; }],
  ['verified before all rows', p => { p.next_chunk = 3; p.verified = true; }],
  ['verified not boolean', p => { p.verified = 'true'; }],
  ['cursor negative', p => { p.next_chunk = -1; }], ['cursor fractional', p => { p.next_chunk = 0.5; }],
  ['cursor beyond chunks', p => { p.next_chunk = 4; }], ['cursor string', p => { p.next_chunk = '0'; }],
  ['extra counts key', p => { p.counts.users = 1; }], ['missing counts key', p => { delete p.counts.orders; }],
  ['negative order count', p => { p.counts.orders = -1; }], ['fractional order count', p => { p.counts.orders = 0.1; }],
];
const malformedCommon = [
  ['wrong scope', p => { p.scope = 'employee-identity'; }], ['extra secret', p => { p.password = SECRET; }],
  ['null totals', p => { p.totals = null; }], ['extra totals key', p => { p.totals.enabled = 1; }],
  ['missing totals accounts', p => { delete p.totals.accounts; }], ['totals accounts zero', p => { p.totals.accounts = 0; }],
  ['totals credentials too large', p => { p.totals.credentials = 2; }], ['totals credentials string', p => { p.totals.credentials = '1'; }],
  ['negative total orders', p => { p.totals.orders = -1; }], ['fractional total orders', p => { p.totals.orders = 1.1; }],
  ['string total orders', p => { p.totals.orders = '2'; }], ['unsafe total orders', p => { p.totals.orders = Number.MAX_SAFE_INTEGER + 1; }],
  ['zero chunks', p => { p.order_chunks = 0; }], ['negative chunks', p => { p.order_chunks = -1; }],
  ['fractional chunks', p => { p.order_chunks = 1.5; }], ['string chunks', p => { p.order_chunks = '3'; }],
  ['nonfinite chunks', p => { p.order_chunks = Infinity; }], ['SQL integer overflow chunks', p => { p.order_chunks = 2147483648; }],
];
for (const field of BINDING_KEYS) {
  malformedCommon.push([`missing ${field}`, p => { delete p[field]; }]);
  malformedCommon.push([`invalid ${field}`, p => { p[field] = SECRET; }]);
  malformedCommon.push([`newline ${field}`, p => { p[field] += '\n'; }]);
  malformedCommon.push([`uppercase ${field}`, p => { p[field] = field.endsWith('hash') || field.endsWith('fingerprint') ? p[field].toUpperCase() : id(0xab).toUpperCase(); }]);
}
for (const [field, expected] of Object.entries(FLAGS)) for (const value of [!expected, null, 0, String(expected), undefined]) {
  malformedCommon.push([`${field}=${String(value)}`, p => { p[field] = value; }]);
}
for (const field of [...TASK_KEYS, 'source_id']) malformedCommon.push([`target equals ${field}`, p => { p.target_id = p[field]; }]);
for (const [kind, cases, factory, validate] of [
  ['plan', [...malformedCommon, ...malformedPlan], plan, api.validateEmployeeMappedIdentityPlan],
  ['status', [...malformedCommon, ...malformedStatus], status, api.validateEmployeeMappedIdentityStatus],
]) for (const [label, change] of cases) test(`${kind} fails closed: ${label}`, async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN), raw = factory(), changed = change(raw) ?? raw;
  h.respond(changed); assert.throws(() => validate(changed), redacted);
  await assert.rejects(s[kind](SOURCE), redacted); assert.equal(h.calls.length, 1);
});
test('safe maximum counts and SQL integer chunk boundary accepted without inventing per-employee chunk sizes', () => {
  harness(); const p = plan(); p.totals.orders = Number.MAX_SAFE_INTEGER; p.order_chunks = 2147483647;
  assert.deepEqual(api.validateEmployeeMappedIdentityPlan(p), p);
  const r = status(2147483647, Number.MAX_SAFE_INTEGER, true); r.order_chunks = 2147483647; r.totals.orders = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(api.validateEmployeeMappedIdentityStatus(r), r);
});
test('getters, proxies, symbols, nonenumerable fields and exotic objects fail closed without invoking accessors', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN); let getters = 0;
  for (const locate of [r => [r, 'job_id'], r => [r.totals, 'orders'], r => { r.conflicts = [CONFLICTS[0]]; return [r.conflicts, '0']; }]) {
    const p = plan(), [object, key] = locate(p);
    Object.defineProperty(object, key, { enumerable: true, get() { getters++; throw Error(SECRET); } });
    assert.throws(() => api.validateEmployeeMappedIdentityPlan(p), redacted); await assert.rejects(s.core(p), redacted);
  }
  assert.equal(getters, 0); assert.equal(h.calls.length, 0);
  const shapes = [Object.setPrototypeOf(plan(), { authority: true }), new Proxy(plan(), { ownKeys() { throw Error(SECRET); } })];
  const hidden = plan(); Object.defineProperty(hidden, 'job_id', { enumerable: false, value: JOB }); shapes.push(hidden);
  const symbol = plan(); symbol[Symbol('secret-authority')] = true; shapes.push(symbol);
  for (const p of shapes) assert.throws(() => api.validateEmployeeMappedIdentityPlan(p), redacted);
  assert.deepEqual(api.validateEmployeeMappedIdentityPlan(Object.assign(Object.create(null), plan())), plan());
});

for (const operation of OPERATIONS) for (const field of BINDING_KEYS) test(`${operation} rejects foreign ${field} bindings`, async () => {
  const { h, s, before } = await ready(operation);
  // Pin the selected source/task before checking even otherwise-valid plan/status replies.
  if (before === 0) { h.respond(plan()); await s.plan(SOURCE); }
  const calls = h.calls.length, raw = replyFor(operation);
  raw[field] = field.endsWith('hash') || field.endsWith('fingerprint') ? OTHER_HASH : id(80);
  h.respond(raw); await assert.rejects(invoke(s, operation), redacted); assert.equal(h.calls.length, calls + 1);
});
for (const field of TASK_KEYS) test(`core rejects foreign checkpoint ${field} before auth or write`, async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN); h.respond(plan()); await s.plan(SOURCE);
  await assert.rejects(s.core({ ...plan(), [field]: id(80) }), redacted); assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
});
test('fresh core checkpoint cannot pin a foreign task when actual-task response differs', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN); h.respond(status());
  await assert.rejects(s.core({ ...plan(), job_id: id(80) }), redacted); assert.equal(h.calls.length, 1);
  h.respond(plan()); assert.equal((await s.plan(SOURCE)).job_id, JOB);
});
test('multiple source IDs use one task but retain fixed independent candidates and reject target reuse', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN); h.respond(plan()); await s.plan(SOURCE);
  const other = { ...plan(), source_id: OTHER_SOURCE, target_id: OTHER_TARGET, plan_hash: OTHER_HASH };
  h.respond(other); assert.deepEqual(await s.plan(OTHER_SOURCE), other);
  h.respond({ ...status(), source_id: OTHER_SOURCE, target_id: OTHER_TARGET, plan_hash: OTHER_HASH });
  assert.equal((await s.core(other)).target_id, OTHER_TARGET);
  h.respond({ ...plan(), target_id: OTHER_TARGET }); await assert.rejects(s.plan(SOURCE), redacted);
  h.respond({ ...plan(), source_id: id(90) }); await assert.rejects(s.plan(id(90)), redacted);
  h.respond(plan()); assert.equal((await s.plan(SOURCE)).target_id, TARGET); assert.equal(h.calls.length, 6);
});
test('selected source is checked even on the first plan/status response', async () => {
  const h = harness();
  for (const op of ['plan', 'status']) {
    const s = api.createEmployeeMappedIdentitySession(TOKEN), raw = replyFor(op); raw.source_id = OTHER_SOURCE;
    h.respond(raw); await assert.rejects(s[op](SOURCE), redacted);
  }
  assert.equal(h.calls.length, 2);
});
for (const field of ['totals', 'order_chunks']) test(`source ${field} stays fixed across calls`, async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN); h.respond(plan()); await s.plan(SOURCE);
  const raw = plan(); if (field === 'totals') raw.totals.orders++; else raw.order_chunks++;
  h.respond(raw); await assert.rejects(s.plan(SOURCE), redacted);
  await assert.rejects(s.core(raw), redacted); assert.equal(h.calls.length, 2);
});
test('core synchronously snapshots all caller authorization before asynchronous dispatch and auth callbacks', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN), input = plan(), controller = new AbortController();
  h.onAuth = () => { input.source_id = id(80); input.plan_hash = OTHER_HASH; input.totals.orders = 90; };
  h.respond(status()); const pending = s.core(input, controller.signal);
  input.job_id = id(81); input.binding_hash = OTHER_HASH; input.conflicts.push(CONFLICTS[0]);
  assert.deepEqual(await pending, status());
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_source_id: SOURCE, p_plan_hash: PLAN_HASH });
});
test('pending core input mutation cannot rewrite the response validation baseline', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN), input = plan(), wait = deferred();
  h.replies.push({ wait: wait.promise }); const pending = s.core(input); await turn();
  input.plan_hash = OTHER_HASH; input.target_id = OTHER_TARGET;
  wait.resolve({ data: { ...status(), plan_hash: OTHER_HASH, target_id: OTHER_TARGET }, error: null });
  await assert.rejects(pending, redacted); assert.equal(h.calls.length, 1);
});
test('returned plans/status and raw transport data cannot mutate the private task/candidate/cursor binding', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN), p = plan(); h.respond(p); const result = await s.plan(SOURCE);
  p.job_id = id(80); p.target_id = OTHER_TARGET; p.totals.orders = 99;
  for (const [obj, key, value] of [[result, 'job_id', id(80)], [result.totals, 'orders', 99], [result.conflicts, '0', CONFLICTS[0]]]) {
    assert.throws(() => { obj[key] = value; }, TypeError);
  }
  const r = status(); h.respond(r); const state = await s.core(result); r.next_chunk = 2; r.counts.orders = 2;
  assert.throws(() => { state.next_chunk = 2; }, TypeError); assert.throws(() => { state.counts.orders = 2; }, TypeError);
  h.respond(status(1)); await s.orders(SOURCE, 0); assert.equal(h.calls.length, 3);
});

for (const chunk of [-1, 0.1, NaN, Infinity, '0', null, undefined, 2147483648]) test(`invalid chunk ${String(chunk)} never authenticates or dispatches`, async () => {
  const { h, s } = await ready('orders'); await assert.rejects(s.orders(SOURCE, chunk), redacted);
  assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
});
test('orders and verify require explicit confirmed core/status; unknown server status cannot imply a core', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN);
  h.respond(plan()); await s.plan(SOURCE); await assert.rejects(s.orders(SOURCE, 0), redacted); await assert.rejects(s.verify(SOURCE), redacted);
  h.replies.push({ error: { message: SECRET } }); await assert.rejects(s.status(SOURCE), redacted);
  await assert.rejects(s.orders(SOURCE, 0), redacted); assert.equal(h.calls.length, 2);
});
test('exact cursor boundaries reject gaps, repeated chunks, complete cursor and writes after verification locally', async () => {
  const { h, s } = await ready('orders');
  await assert.rejects(s.orders(SOURCE, 1), redacted); await assert.rejects(s.orders(SOURCE, 3), redacted);
  await assert.rejects(s.verify(SOURCE), redacted); assert.equal(h.calls.length, 1);
  h.respond(status(1)); await s.orders(SOURCE, 0);
  await assert.rejects(s.orders(SOURCE, 0), redacted); assert.equal(h.calls.length, 2);
  h.respond(status(3, 2)); await s.status(SOURCE);
  await assert.rejects(s.orders(SOURCE, 3), redacted); assert.equal(h.calls.length, 3);
  h.respond(status(3, 2, true)); await s.verify(SOURCE);
  await assert.rejects(s.orders(SOURCE, 2), redacted); assert.equal(h.calls.length, 4);
});
for (const [label, shape] of [
  ['no cursor advancement', () => status()], ['cursor gap', () => status(2)],
  ['premature verification', () => status(3, 2, true)], ['wrong totals', () => ({ ...status(1), totals: { ...totals(), orders: 3 } })],
]) test(`order receipt rejects ${label} without optimistic cursor changes or retry`, async () => {
  const { h, s } = await ready('orders'); h.respond(shape()); await assert.rejects(s.orders(SOURCE, 0), redacted);
  await assert.rejects(s.orders(SOURCE, 1), redacted); await assert.rejects(s.orders(SOURCE, 0), redacted); assert.equal(h.calls.length, 2);
  h.respond(status()); await s.status(SOURCE); h.respond(status(1)); await s.orders(SOURCE, 0); assert.equal(h.calls.length, 4);
});
test('orders count cannot shrink while cursor advances, but reaching all rows before last global chunk is valid', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN); h.respond(status(1, 2)); await s.status(SOURCE);
  h.respond(status(2, 1)); await assert.rejects(s.orders(SOURCE, 1), redacted);
  h.respond(status(1, 2)); await s.status(SOURCE); h.respond(status(2, 2)); await s.orders(SOURCE, 1);
  await assert.rejects(s.verify(SOURCE), redacted); assert.equal(h.calls.length, 4);
  h.respond(status(3, 2)); await s.orders(SOURCE, 2); h.respond(status(3, 2, true)); await s.verify(SOURCE);
});
for (const [label, prior, next] of [
  ['cursor regression', status(2, 1), status(1, 1)], ['row regression', status(2, 2), status(2, 1)],
  ['verified regression', status(3, 2, true), status(3, 2)],
]) test(`status rejects ${label} and preserves confirmed state`, async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN); h.respond(prior); await s.status(SOURCE);
  h.respond(next); await assert.rejects(s.status(SOURCE), redacted); h.respond(prior); await s.status(SOURCE); assert.equal(h.calls.length, 3);
});
for (const [label, prior, next] of [
  ['cursor regression', status(2, 1), status(1, 1)], ['row regression', status(2, 2), status(2, 1)],
  ['verified regression', status(3, 2, true), status(3, 2)],
]) test(`explicit core replay rejects ${label} and an uncertain write cannot discard its confirmed high-water mark`, async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN); h.respond(prior); await s.status(SOURCE);
  h.respond(next); await assert.rejects(s.core(plan()), redacted);
  h.respond(plan()); await s.plan(SOURCE);
  await assert.rejects(s.orders(SOURCE, prior.next_chunk), redacted); assert.equal(h.calls.length, 3);
  h.respond(next); await assert.rejects(s.status(SOURCE), redacted);
  h.respond(prior); assert.deepEqual(await s.status(SOURCE), prior); assert.equal(h.calls.length, 5);
});
test('core can explicitly resume with a completed status rather than assuming every core call is a new insertion', async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN); h.respond(status(3, 2, true));
  assert.deepEqual(await s.core(api.employeeMappedIdentityCheckpoint(plan())), status(3, 2, true));
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, rpc('core'));
});
test('verify must return verified true; failure requires explicit status rather than an automatic followup', async () => {
  const { h, s } = await ready('verify'); h.respond(status(3, 2)); await assert.rejects(s.verify(SOURCE), redacted);
  await assert.rejects(s.verify(SOURCE), redacted); assert.equal(h.calls.length, 2);
  h.respond(status(3, 2)); await s.status(SOURCE); h.respond(status(3, 2, true)); await s.verify(SOURCE); assert.equal(h.calls.length, 4);
});
for (const field of Object.keys(plan())) test(`invalid/missing checkpoint ${field} never sends core`, async () => {
  const h = harness(), s = api.createEmployeeMappedIdentitySession(TOKEN), p = plan(); delete p[field];
  await assert.rejects(s.core(p), redacted); assert.equal(h.calls.length, 0); assert.equal(h.reads, 0);
});
test('invalid tokens/source IDs and missing/throwing auth never dispatch', async () => {
  const h = harness();
  for (const token of [null, 1, SECRET, TOKEN + '\n']) assert.throws(() => api.createEmployeeMappedIdentitySession(token), redacted);
  const s = api.createEmployeeMappedIdentitySession(TOKEN);
  for (const source of [null, 1, SECRET, SOURCE + '\n']) for (const op of ['plan', 'status', 'orders', 'verify']) {
    await assert.rejects(op === 'orders' ? s.orders(source, 0) : s[op](source), redacted);
  }
  for (const op of ['plan', 'core', 'status']) {
    h.session = null; await assert.rejects(invoke(s, op), redacted);
    h.authError = Error(SECRET); await assert.rejects(invoke(s, op), redacted); h.authError = null;
  }
  assert.equal(h.calls.length, 0);
});
for (const op of OPERATIONS) for (const mode of ['throw', 'reject', 'error', 'null', 'malformed', 'error-with-data']) test(`${op}: ${mode} is secret-free and never retried`, async () => {
  const { h, s, before } = await ready(op);
  h.replies.push(mode === 'error' ? { error: { message: SECRET, details: SECRET, hint: SECRET } }
    : mode === 'null' ? { data: null } : mode === 'malformed' ? { data: { secret: SECRET } }
      : mode === 'error-with-data' ? { data: replyFor(op), error: { message: SECRET } } : { [mode]: Error(SECRET) });
  await assert.rejects(invoke(s, op), redacted); await turn(); assert.equal(h.calls.length, before + 1);
});
for (const op of OPERATIONS) {
  test(`${op}: pre-abort, same-turn abort and abort during auth dispatch no request`, async () => {
    const { h, s, before } = await ready(op), reads = h.reads, first = new AbortController(); first.abort(SECRET);
    await assert.rejects(invoke(s, op, first.signal), aborted);
    const second = new AbortController(), pending = invoke(s, op, second.signal); second.abort(SECRET); await assert.rejects(pending, aborted);
    assert.equal(h.calls.length, before); assert.equal(h.reads, reads);
    const third = new AbortController(); h.onAuth = () => third.abort(SECRET);
    await assert.rejects(invoke(s, op, third.signal), aborted); assert.equal(h.calls.length, before);
  });
  test(`${op}: late completion after abort never confirms success and cannot overlap a signal-ignoring transport`, async () => {
    const { h, s, before } = await ready(op), wait = deferred(), controller = new AbortController();
    h.replies.push({ wait: wait.promise }); const pending = invoke(s, op, controller.signal); await turn(); assert.equal(h.calls.length, before + 1);
    controller.abort(SECRET); await assert.rejects(pending, aborted);
    await assert.rejects(s.plan(SOURCE), redacted); assert.equal(h.calls.length, before + 1);
    const foreign = replyFor(op); foreign.job_id = id(80); foreign.target_id = OTHER_TARGET;
    wait.resolve({ data: foreign, error: null }); await turn();
    if (op === 'orders' || op === 'verify') await assert.rejects(invoke(s, op), redacted);
    h.respond(op === 'verify' ? status(3, 2) : status());
    assert.equal((await s.status(SOURCE)).target_id, TARGET); assert.equal(h.calls.length, before + 2);
  });
  test(`${op}: abort during validation does not pin an unconfirmed task/candidate`, async () => {
    const { h, s, before } = await ready(op), controller = new AbortController();
    const r = new Proxy(replyFor(op), { ownKeys(target) { controller.abort(SECRET); return Reflect.ownKeys(target); } });
    h.respond(r); await assert.rejects(invoke(s, op, controller.signal), aborted); assert.equal(h.calls.length, before + 1);
  });
  test(`${op}: abortSignal query failure is generic and not retried`, async () => {
    const { h, s, before } = await ready(op); h.replies.push({ data: replyFor(op), signalError: Error(SECRET) });
    await assert.rejects(invoke(s, op, new AbortController().signal), redacted); assert.equal(h.calls.length, before + 1);
  });
}
for (const first of OPERATIONS) for (const second of OPERATIONS) test(`serialized ${first}/${second}: overlap rejected, never queued`, async () => {
  const { h, s, before } = await ready(first), wait = deferred(); h.replies.push({ wait: wait.promise });
  const pending = invoke(s, first); await turn(); const reads = h.reads;
  await assert.rejects(invoke(s, second), redacted); assert.equal(h.calls.length, before + 1); assert.equal(h.reads, reads);
  wait.resolve({ data: replyFor(first), error: null }); await pending; await turn(); assert.equal(h.calls.length, before + 1);
});
test('separate sessions are not a browser-global lock; an aborted rejecting transport does not poison later calls', async () => {
  const h = harness(), a = api.createEmployeeMappedIdentitySession(TOKEN), b = api.createEmployeeMappedIdentitySession(TOKEN);
  const wait = deferred(), controller = new AbortController(); h.replies.push({ wait: wait.promise }); const pending = a.plan(SOURCE, controller.signal); await turn();
  h.respond(plan()); await b.plan(SOURCE); controller.abort(SECRET); await assert.rejects(pending, aborted);
  wait.reject(Error(SECRET)); await turn(); h.respond(plan()); await a.plan(SOURCE); assert.equal(h.calls.length, 3);
});

test('actual shared transport: all five RPCs get 120s, one POST on HTTP/network/timeout/abort and no XHR/retry', async t => {
  const transportBuild = await build({ entryPoints: [`${root}src/lib/supabase.ts`], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://local.invalid'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('isolated-test-key') },
    plugins: [{ name: 'capture-fetch-no-real-client', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'local-client', namespace: 'capture' }));
      builder.onLoad({ filter: /.*/, namespace: 'capture' }, () => ({ contents: 'export const createClient=(url,key,options)=>({testFetch:options.global.fetch});' }));
    } }],
  });
  assert.equal(Object.keys(transportBuild.metafile.inputs).some(path => path.includes('node_modules')), false);
  let calls = 0, xhrCalls = 0, mode = 'http', fireTimeout; const delays = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    calls++;
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (mode === 'timeout' || mode === 'abort') return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      if (mode === 'timeout') queueMicrotask(fireTimeout);
    });
    return new Response('{}', { status: 503 });
  });
  const transport = await import(`data:text/javascript;base64,${Buffer.from(transportBuild.outputFiles[0].text).toString('base64')}`);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { delays.push(delay); fireTimeout = callback; return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const xhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: function () { xhrCalls++; assert.fail('XHR forbidden'); } });
  t.after(() => { if (xhr) Object.defineProperty(globalThis, 'XMLHttpRequest', xhr); else delete globalThis.XMLHttpRequest; });
  for (const name of OPERATIONS.map(rpc)) for (const failureMode of ['http', 'network', 'timeout', 'abort']) {
    calls = 0; delays.length = 0; mode = failureMode; const controller = new AbortController();
    const pending = transport.supabase.testFetch(`https://local.invalid/rest/v1/rpc/${name}`, { method: 'POST', signal: controller.signal });
    if (mode === 'abort') controller.abort(SECRET);
    if (mode === 'http') assert.equal((await pending).status, 503); else await assert.rejects(pending);
    assert.equal(calls, 1); assert.equal(xhrCalls, 0); assert.deepEqual(delays, [120000]);
  }
  mode = 'http'; delays.length = 0;
  await transport.supabase.testFetch('https://local.invalid/rest/v1/rpc/employee_import_mapped_identity_status_not_a_contract', { method: 'POST' });
  assert.deepEqual(delays, [8000]);
});
