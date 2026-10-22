import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `50000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SESSION = id(1), TOKEN = id(2), JOB = id(3), SITE = id(4), SOURCE_SITE = id(5), PACKAGE = id(6);
const PLAN_HASH = 'a'.repeat(64), MAPPING_HASH = 'b'.repeat(64), OTHER_HASH = 'c'.repeat(64);
const SECRET = 'private-session-job-token-password-source-row-never-expose';
const OPERATIONS = ['plan', 'status', 'begin', 'chunk', 'verify'];
const WRITES = ['begin', 'chunk', 'verify'];
const TABLES = ['dispatch_group_members', 'used_order_data'];
const BINDINGS = ['job_id', 'site_id', 'source_site_id', 'package_id', 'plan_hash', 'mapping_hash'];
const CONFLICTS = ['target_members_not_empty', 'target_used_not_empty', 'unmapped_assigner'];
const FLAGS = { maintenance: true, dependencies_pending: true, can_restore: false, complete_employee_backup: false,
  can_archive: false, can_replace: false, full_site_complete: false };
const rpc = operation => `employee_import_mapped_dependency_${operation}`;
let forbiddenNetwork = 0;
mock.method(globalThis, 'fetch', () => { forbiddenNetwork++; assert.fail('network/formal services forbidden'); });
after(() => { assert.equal(forbiddenNetwork, 0); mock.restoreAll(); });

const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/employeeMappedDependency.ts'; export {setHarness} from 'dependency-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'isolated-mapped-dependency', setup(builder) {
    builder.onResolve({ filter: /^(?:dependency-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'dependency-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'dependency-test' }, ({ path }) => ({ contents: path === 'dependency-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth'
        ? 'import{current}from"dependency-test:state";export function getAdminFinancialSessionToken(){const h=current();h.reads++;h.onAuth?.();if(h.authError)throw h.authError;return h.session;}'
        : 'import{current}from"dependency-test:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const redacted = error => {
  assert.ok(error instanceof Error);
  for (const secret of [SECRET, SESSION, TOKEN, JOB, PLAN_HASH, MAPPING_HASH]) assert.equal(String(error).includes(secret), false);
  for (const key of ['cause', 'details', 'hint']) assert.equal(key in error, false);
  return true;
};
const aborted = error => redacted(error) && error.name === 'AbortError';
const pair = (members = 0, used = 0) => ({ dispatch_group_members: members, used_order_data: used });
const common = () => ({ scope: 'employee-mapped-dependencies', job_id: JOB, site_id: SITE, source_site_id: SOURCE_SITE,
  package_id: PACKAGE, plan_hash: PLAN_HASH, mapping_hash: MAPPING_HASH, totals: pair(3, 2), chunks: pair(2, 2), ...FLAGS });
const plan = () => ({ ...common(), can_begin: true, conflicts: [] });
const status = (members = 0, used = 0, verified = false) => ({ ...common(), started: true,
  counts: pair(members === 0 ? 0 : members === 1 ? 1 : 3, used), next_chunks: pair(members, used), verified });
const notStarted = () => ({ ...status(), started: false });
const emptyShape = value => ({ ...value, totals: pair(), chunks: pair(1, 1),
  ...('counts' in value ? { counts: pair() } : {}) });
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
const invoke = (s, op, signal) => op === 'begin' ? s.begin(plan(), signal)
  : op === 'chunk' ? s.chunk(TABLES[0], 0, signal) : s[op](signal);
const replyFor = op => op === 'plan' ? plan() : op === 'chunk' ? status(1) : op === 'verify' ? status(2, 2, true) : status();
async function ready(op) {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN);
  if (op === 'chunk' || op === 'verify') {
    h.respond(op === 'chunk' ? status() : status(2, 2)); await s.status();
  }
  return { h, s, before: h.calls.length };
}
async function writesBlocked(s, h) {
  const calls = h.calls.length, reads = h.reads;
  for (const op of WRITES) await assert.rejects(invoke(s, op), redacted);
  assert.equal(h.calls.length, calls); assert.equal(h.reads, reads);
}

test('lazy browser bundle isolates SDK/network and exposes only five explicit operations and pure validators', () => {
  assert.deepEqual(Object.keys(api).sort(), ['createEmployeeMappedDependencySession', 'setHarness',
    'validateEmployeeMappedDependencyPlan', 'validateEmployeeMappedDependencyStatus']);
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN);
  assert.deepEqual(Object.keys(s).sort(), [...OPERATIONS].sort()); assert.equal(h.reads, 0); assert.equal(h.calls.length, 0);
  assert.equal(Object.keys(compiled.metafile.inputs).some(path => /node_modules|(?:^|\/)src\/lib\/(?:auth|supabase)\.ts$|\/(?:employeeMappedIdentity|employeeIdentityReservation|employeeIdentityProjection|employeeSafetyBackup|siteImport|identityApi|api|crypto|container)\.ts$/.test(path)), false);
});
test('five-operation protocol: fresh auth, exact args, members before used, and only maintenance-stage success', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN), signal = new AbortController().signal;
  h.respond(plan()); const p = await s.plan(signal);
  h.respond(notStarted()); assert.equal((await s.status(signal)).started, false);
  h.respond(status()); await s.begin(p, signal);
  const chunks = [[TABLES[0], 0, status(1)], [TABLES[0], 1, status(2)],
    [TABLES[1], 0, status(2, 1)], [TABLES[1], 1, status(2, 2)]];
  for (const [key, no, reply] of chunks) {
    h.session = id(20 + h.calls.length); h.respond(reply); assert.deepEqual(await s.chunk(key, no, signal), reply);
  }
  h.respond(status(2, 2, true)); assert.equal((await s.verify(signal)).verified, true);
  h.respond(plan()); assert.deepEqual(await s.plan(signal), p); // SQL50 returns the original plan even after begin.
  h.respond(status(2, 2, true)); assert.equal((await s.status(signal)).verified, true);
  h.respond(status(2, 2, true)); assert.equal((await s.begin(p, signal)).verified, true); // Explicit idempotent begin.
  h.respond(status(2, 2, true)); await s.verify(signal);
  assert.deepEqual(h.calls.map(c => c.name), ['plan', 'status', 'begin', 'chunk', 'chunk', 'chunk', 'chunk', 'verify', 'plan', 'status', 'begin', 'verify'].map(rpc));
  for (const [index, call] of h.calls.entries()) {
    const args = { p_admin_session_token: index < 3 ? SESSION : id(index < 7 ? index + 20 : 26), p_job_token: TOKEN };
    if ([2, 10].includes(index)) args.p_plan_hash = PLAN_HASH;
    if (index >= 3 && index < 7) Object.assign(args, { p_table_key: chunks[index - 3][0], p_chunk_no: chunks[index - 3][1] });
    assert.deepEqual(call, { name: call.name, args, signals: [signal] });
  }
  assert.equal(h.reads, h.calls.length);
  for (const [key, value] of Object.entries(FLAGS)) assert.equal(p[key], value);
});
test('zero rows require one empty chunk per table, including completing empty members before empty used', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN);
  h.respond(emptyShape(plan())); const p = await s.plan();
  h.respond(emptyShape(status())); await s.begin(p);
  await assert.rejects(s.verify(), redacted); await assert.rejects(s.chunk(TABLES[1], 0), redacted); assert.equal(h.calls.length, 2);
  h.respond(emptyShape(status(1))); await s.chunk(TABLES[0], 0);
  await assert.rejects(s.verify(), redacted); assert.equal(h.calls.length, 3);
  h.respond(emptyShape(status(1, 1))); await s.chunk(TABLES[1], 0);
  h.respond(emptyShape(status(1, 1, true))); assert.equal((await s.verify()).verified, true);
  assert.equal(h.calls.length, 5);
});
for (const conflict of CONFLICTS) test(`allowlisted conflict blocks begin before auth: ${conflict}`, async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN), raw = { ...plan(), can_begin: false, conflicts: [conflict] };
  h.respond(raw); const p = await s.plan(); assert.deepEqual(p, raw);
  await assert.rejects(s.begin(p), redacted); assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
});
test('all three conflicts may coexist, preserve order, and can clear without changing the immutable plan binding', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN);
  h.respond({ ...plan(), can_begin: false, conflicts: [...CONFLICTS].reverse() }); await s.plan();
  h.respond(plan()); const p = await s.plan(); h.respond(status()); await s.begin(p);
});

const malformedCommon = [
  ['wrong scope', p => { p.scope = 'employee-mapped-identity'; }],
  ['unexpected repeated', p => { p.repeated = false; }], ['unexpected closed', p => { p.closed = false; }],
  ['unknown authority', p => { p.password = SECRET; }],
  ['missing totals', p => { delete p.totals; }], ['null chunks', p => { p.chunks = null; }],
  ['extra table', p => { p.totals.users = 1; }], ['missing table', p => { delete p.chunks.used_order_data; }],
  ['zero chunks', p => { p.chunks.dispatch_group_members = 0; }],
  ['too many nonempty chunks', p => { p.chunks.dispatch_group_members = 4; }],
  ['insufficient chunks for rows', p => { p.totals.dispatch_group_members = 401; }],
  ['multiple empty chunks', p => { p.totals.dispatch_group_members = 0; }],
  ['SQL catalog row limit', p => { p.totals.dispatch_group_members = 500001; p.chunks.dispatch_group_members = 500001; }],
];
for (const field of BINDINGS) {
  malformedCommon.push([`missing ${field}`, p => { delete p[field]; }]);
  malformedCommon.push([`invalid ${field}`, p => { p[field] = SECRET; }]);
  malformedCommon.push([`newline ${field}`, p => { p[field] += '\n'; }]);
  malformedCommon.push([`uppercase ${field}`, p => { p[field] = field.endsWith('hash') ? p[field].toUpperCase() : id(0xab).toUpperCase(); }]);
}
for (const [field, expected] of Object.entries(FLAGS)) malformedCommon.push([`unsafe ${field}`, p => { p[field] = !expected; }]);
for (const value of [-1, 0.5, '2', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  malformedCommon.push([`non-integer counts ${String(value)}`, p => { p.totals.used_order_data = value; }]);
  malformedCommon.push([`non-integer chunks ${String(value)}`, p => { p.chunks.used_order_data = value; }]);
}
for (const [label, change] of malformedCommon) test(`common schema fails closed in both plan and status: ${label}`, () => {
  for (const [factory, validate] of [[plan, api.validateEmployeeMappedDependencyPlan], [status, api.validateEmployeeMappedDependencyStatus]]) {
    const value = factory(); change(value); assert.throws(() => validate(value), redacted);
  }
});
const malformedPlan = [
  ['missing conflicts', p => { delete p.conflicts; }], ['nonboolean can_begin', p => { p.can_begin = 'true'; }],
  ['empty conflicts but blocked', p => { p.can_begin = false; }], ['conflict but permitted', p => { p.conflicts = [CONFLICTS[0]]; }],
  ['unknown conflict', p => { p.conflicts = ['backup_verified']; }], ['duplicate conflicts', p => { p.conflicts = [CONFLICTS[0], CONFLICTS[0]]; }],
  ['non-array conflicts', p => { p.conflicts = {}; }], ['sparse conflicts', p => { p.conflicts = new Array(1); }],
  ['extra array key', p => { p.conflicts.extra = true; }], ['array symbol', p => { p.conflicts[Symbol('authority')] = true; }],
  ['unexpected started', p => { p.started = false; }],
];
for (const [label, change] of malformedPlan) test(`plan schema: ${label}`, async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN), value = plan(); change(value);
  h.respond(value); await assert.rejects(s.plan(), redacted);
  await assert.rejects(s.begin(value), redacted); assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
});
const malformedStatus = [
  ['missing started', p => { delete p.started; }], ['nonboolean started', p => { p.started = 1; }],
  ['nonboolean verified', p => { p.verified = 'false'; }], ['unexpected can_begin', p => { p.can_begin = true; }],
  ['unexpected conflicts', p => { p.conflicts = []; }], ['missing counts key', p => { delete p.counts.used_order_data; }],
  ['extra cursor key', p => { p.next_chunks.accounts = 1; }],
  ['rows at zero cursor', p => { p.counts.dispatch_group_members = 1; }],
  ['rows exceed total', p => { p.counts.dispatch_group_members = 4; }],
  ['cursor exceeds chunks', p => { p.next_chunks.dispatch_group_members = 3; }],
  ['complete cursor missing rows', p => { p.next_chunks.dispatch_group_members = 2; p.counts.dispatch_group_members = 2; }],
  ['nonempty chunk has zero rows', p => { p.next_chunks.dispatch_group_members = 1; }],
  ['chunk has over 200 rows', p => { p.totals.dispatch_group_members = 202; p.next_chunks.dispatch_group_members = 1; p.counts.dispatch_group_members = 201; }],
  ['remaining rows cannot fit', p => { p.totals.dispatch_group_members = 202; p.next_chunks.dispatch_group_members = 1; p.counts.dispatch_group_members = 1; }],
  ['premature all rows', p => { p.next_chunks.dispatch_group_members = 1; p.counts.dispatch_group_members = 3; }],
  ['used starts before members complete', p => { p.next_chunks.used_order_data = 1; p.counts.used_order_data = 1; }],
  ['unstarted has progress', p => { p.started = false; p.next_chunks.dispatch_group_members = 1; p.counts.dispatch_group_members = 1; }],
  ['unstarted verified', p => { p.started = false; p.verified = true; }], ['incomplete verified', p => { p.verified = true; }],
  ['fractional count', p => { p.counts.dispatch_group_members = 0.5; }], ['string cursor', p => { p.next_chunks.dispatch_group_members = '0'; }],
];
for (const [label, change] of malformedStatus) test(`status schema: ${label}`, async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN), value = status(); change(value);
  assert.throws(() => api.validateEmployeeMappedDependencyStatus(value), redacted);
  h.respond(value); await assert.rejects(s.status(), redacted);
  await assert.rejects(s.chunk(TABLES[0], 0), redacted); await assert.rejects(s.verify(), redacted);
  assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
});
test('SQL catalog boundaries allow 500000 rows and 1..200 rows per chunk without assuming fixed chunk sizes', () => {
  const p = plan(); p.totals = pair(500000, 1); p.chunks = pair(2500, 1);
  assert.deepEqual(api.validateEmployeeMappedDependencyPlan(p), p);
  const r = { ...status(), totals: p.totals, chunks: p.chunks, next_chunks: pair(2500, 1), counts: p.totals, verified: true };
  assert.deepEqual(api.validateEmployeeMappedDependencyStatus(r), r);
  p.chunks.dispatch_group_members = 500000; assert.deepEqual(api.validateEmployeeMappedDependencyPlan(p), p);
});
test('exact descriptors reject accessors, hidden/symbol fields, exotic prototypes and throwing proxies without getter execution', () => {
  let getters = 0;
  for (const locate of [p => [p, 'job_id'], p => [p.totals, TABLES[0]], p => [p.chunks, TABLES[1]],
    p => { p.conflicts = [CONFLICTS[0]]; return [p.conflicts, '0']; }]) {
    const p = plan(), [value, key] = locate(p);
    Object.defineProperty(value, key, { enumerable: true, get() { getters++; throw Error(SECRET); } });
    assert.throws(() => api.validateEmployeeMappedDependencyPlan(p), redacted);
  }
  assert.equal(getters, 0);
  const hidden = plan(); Object.defineProperty(hidden, 'job_id', { enumerable: false, value: JOB });
  const symbol = plan(); symbol[Symbol('authority')] = true;
  for (const p of [hidden, symbol, Object.setPrototypeOf(plan(), { authority: true }),
    new Proxy(plan(), { ownKeys() { throw Error(SECRET); } }), null, [], 1, SECRET]) {
    assert.throws(() => api.validateEmployeeMappedDependencyPlan(p), redacted);
  }
  const p = Object.assign(Object.create(null), plan()); p.totals = Object.assign(Object.create(null), p.totals);
  assert.deepEqual(api.validateEmployeeMappedDependencyPlan(p), plan());
});
test('plans, nested totals/chunks/conflicts and statuses are detached and deeply frozen', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN), raw = plan(); h.respond(raw); const p = await s.plan();
  raw.job_id = id(80); raw.totals.dispatch_group_members = 99; raw.chunks.used_order_data = 99; raw.conflicts.push(CONFLICTS[0]);
  assert.deepEqual(p, plan());
  for (const value of [p, p.totals, p.chunks, p.conflicts]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { p.totals.used_order_data = 9; }, TypeError);
  const reply = status(); h.respond(reply); const r = await s.begin(p); reply.counts.dispatch_group_members = 3; reply.next_chunks.dispatch_group_members = 2;
  for (const value of [r, r.totals, r.chunks, r.counts, r.next_chunks]) assert.equal(Object.isFrozen(value), true);
  assert.throws(() => { r.next_chunks.used_order_data = 1; }, TypeError);
  h.respond(status(1)); await s.chunk(TABLES[0], 0);
});
test('begin snapshots caller plan synchronously before auth callbacks and async work', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN), input = plan(), signal = new AbortController().signal;
  h.onAuth = () => { input.plan_hash = OTHER_HASH; input.totals.dispatch_group_members = 90; };
  h.respond(status()); const pending = s.begin(input, signal); input.job_id = id(80); input.mapping_hash = OTHER_HASH; input.conflicts.push(CONFLICTS[0]);
  assert.deepEqual(await pending, status());
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_plan_hash: PLAN_HASH });
});
test('pending begin caller mutation cannot rewrite the validation baseline; first unknown begin pins the original task', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN), input = plan(), wait = deferred();
  h.replies.push({ wait: wait.promise }); const pending = s.begin(input); await turn(); input.job_id = id(80); input.plan_hash = OTHER_HASH;
  wait.resolve({ data: { ...status(), job_id: id(80), plan_hash: OTHER_HASH }, error: null });
  await assert.rejects(pending, redacted); await writesBlocked(s, h);
  h.respond({ ...status(), job_id: id(80), plan_hash: OTHER_HASH }); await assert.rejects(s.status(), redacted);
  h.respond(status()); await s.status(); h.respond(status(1)); await s.chunk(TABLES[0], 0);
});
for (const field of [...BINDINGS, 'totals', 'chunks']) test(`all reads remain pinned to prior ${field}, and caller changes fail before auth`, async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN); h.respond(plan()); await s.plan();
  const change = p => {
    if (field === 'totals') p.totals.dispatch_group_members = 4;
    else if (field === 'chunks') p.chunks.dispatch_group_members = 3;
    else p[field] = field.endsWith('hash') ? OTHER_HASH : id(80);
    return p;
  };
  await assert.rejects(s.begin(change(plan())), redacted); assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
  h.respond(change(plan())); await assert.rejects(s.plan(), redacted);
  h.respond(change(notStarted())); await assert.rejects(s.status(), redacted);
  h.respond(notStarted()); assert.deepEqual(await s.status(), notStarted());
});
test('status-first binds totals/chunks/mapping even before begin and does not authorize chunks', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN); h.respond(notStarted()); await s.status();
  await assert.rejects(s.chunk(TABLES[0], 0), redacted); await assert.rejects(s.verify(), redacted);
  h.respond({ ...plan(), mapping_hash: OTHER_HASH }); await assert.rejects(s.plan(), redacted);
  h.respond(plan()); const p = await s.plan(); h.respond(status()); await s.begin(p);
});
for (const op of OPERATIONS) test(`${op} rejects valid-shaped but changed task/mapping receipt`, async () => {
  const { h, s } = await ready(op);
  if (op === 'plan' || op === 'status') { h.respond(plan()); await s.plan(); }
  const raw = replyFor(op); raw.mapping_hash = OTHER_HASH; h.respond(raw); await assert.rejects(invoke(s, op), redacted);
  if (WRITES.includes(op)) await writesBlocked(s, h);
});
test('plans cannot imply begin, and explicit begin may resume an already advanced/verified server state', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN); h.respond(plan()); const p = await s.plan();
  await assert.rejects(s.chunk(TABLES[0], 0), redacted); await assert.rejects(s.verify(), redacted);
  h.respond(status(2, 2, true)); assert.equal((await s.begin(p)).verified, true);
  await assert.rejects(s.chunk(TABLES[0], 0), redacted); assert.equal(h.calls.length, 2);
});
for (const chunk of [-1, 0.1, NaN, Infinity, '0', null, undefined, 2147483648]) test(`invalid chunk ${String(chunk)} fails before auth`, async () => {
  const { h, s } = await ready('chunk'); await assert.rejects(s.chunk(TABLES[0], chunk), redacted);
  assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
});
test('local guards reject foreign tables, gaps, replay, used before members, incomplete verify and post-verify chunks', async () => {
  const { h, s } = await ready('chunk');
  for (const key of ['users', 'valid_order_data', 'DISPATCH_GROUP_MEMBERS', null, {}, undefined]) await assert.rejects(s.chunk(key, 0), redacted);
  await assert.rejects(s.chunk(TABLES[0], 1), redacted); await assert.rejects(s.chunk(TABLES[1], 0), redacted);
  await assert.rejects(s.verify(), redacted); assert.equal(h.calls.length, 1);
  h.respond(status(1)); await s.chunk(TABLES[0], 0); await assert.rejects(s.chunk(TABLES[0], 0), redacted);
  await assert.rejects(s.chunk(TABLES[1], 0), redacted); assert.equal(h.calls.length, 2);
  h.respond(status(2, 2, true)); await s.status(); await assert.rejects(s.chunk(TABLES[1], 1), redacted); assert.equal(h.calls.length, 3);
});
const badChunkReplies = [
  ['no advancement', () => status()], ['cursor skip', () => status(2)],
  ['other table advanced', () => status(2, 1)], ['early verified', () => status(2, 2, true)],
  ['unexpected repeated', () => ({ ...status(1), repeated: true })],
  ['valid schema wrong totals', () => ({ ...status(1), totals: pair(4, 2) })],
];
for (const [label, reply] of badChunkReplies) test(`chunk receipt ${label} leaves uncertainty without optimistic progress`, async () => {
  const { h, s } = await ready('chunk'); h.respond(reply()); await assert.rejects(s.chunk(TABLES[0], 0), redacted);
  h.respond(plan()); await s.plan(); await writesBlocked(s, h);
  h.respond(status()); await s.status(); h.respond(status(1)); await s.chunk(TABLES[0], 0);
});
for (const [label, prior, next] of [
  ['started rollback', status(), notStarted()], ['cursor rollback', status(1), status()],
  ['verified rollback', status(2, 2, true), status(2, 2)],
  ['same-cursor counts changed', status(1), { ...status(1), counts: pair(2, 0) }],
]) test(`status rejects ${label} and preserves confirmed high-water marks`, async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN); h.respond(prior); await s.status();
  h.respond(next); await assert.rejects(s.status(), redacted);
  h.respond(prior); assert.deepEqual(await s.status(), prior);
});
test('row regression at advancing cursor is invalid, even when both individual status schemas are feasible', async () => {
  const shape = (cursor, rows) => ({ ...status(), totals: pair(5, 2), chunks: pair(3, 2), next_chunks: pair(cursor, 0), counts: pair(rows, 0) });
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN), prior = shape(1, 3), next = shape(2, 2);
  assert.deepEqual(api.validateEmployeeMappedDependencyStatus(next), next); h.respond(prior); await s.status();
  h.respond(next); await assert.rejects(s.status(), redacted); h.respond(prior); await s.status();
});
test('advancing chunk cannot add zero or >200 rows although the absolute receipts are each feasible', async () => {
  const shape = (cursor, rows) => ({ ...status(), totals: pair(403, 2), chunks: pair(4, 2), next_chunks: pair(cursor, 0), counts: pair(rows, 0) });
  for (const [before, after] of [[shape(1, 200), shape(2, 200)], [shape(1, 1), shape(2, 202)]]) {
    const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN);
    assert.deepEqual(api.validateEmployeeMappedDependencyStatus(after), after); h.respond(before); await s.status();
    h.respond(after); await assert.rejects(s.chunk(TABLES[0], 1), redacted); await writesBlocked(s, h);
  }
});
test('a syntactically valid receipt cannot advance used during the final members chunk', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN), next = status(2, 1);
  assert.deepEqual(api.validateEmployeeMappedDependencyStatus(next), next);
  h.respond(status(1)); await s.status(); h.respond(next);
  await assert.rejects(s.chunk(TABLES[0], 1), redacted); await writesBlocked(s, h);
});
test('verify must return started/verified true with the exact plan; failure requires explicit status', async () => {
  const { h, s } = await ready('verify'); h.respond(status(2, 2)); await assert.rejects(s.verify(), redacted);
  await writesBlocked(s, h); h.respond(status(2, 2)); await s.status(); h.respond(status(2, 2, true)); await s.verify();
});
test('begin cannot roll back a previously confirmed started state; plan reads cannot erase that high-water mark', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN); h.respond(status()); await s.status();
  h.respond(notStarted()); await assert.rejects(s.begin(plan()), redacted);
  h.respond(plan()); await s.plan(); await writesBlocked(s, h);
  h.respond(notStarted()); await assert.rejects(s.status(), redacted); await writesBlocked(s, h);
  h.respond(status()); await s.status(); h.respond(status(1)); await s.chunk(TABLES[0], 0);
});
test('repeated begin cannot reset confirmed cursors or verification even if its receipt is otherwise valid', async () => {
  for (const [prior, rollback] of [[status(1), status()], [status(2, 2, true), status(2, 2)]]) {
    const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN); h.respond(prior); await s.status();
    h.respond(rollback); await assert.rejects(s.begin(plan()), redacted);
    h.respond(plan()); await s.plan(); h.respond(rollback); await assert.rejects(s.status(), redacted); await writesBlocked(s, h);
    h.respond(prior); assert.deepEqual(await s.status(), prior);
  }
});
test('first begin returning unstarted is unconfirmed, not a successful no-op or permission to rebegin', async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN); h.respond(notStarted());
  await assert.rejects(s.begin(plan()), redacted); await writesBlocked(s, h);
  h.respond(plan()); await s.plan(); await writesBlocked(s, h);
  h.respond(notStarted()); await s.status(); h.respond(status()); await s.begin(plan());
  assert.equal(h.calls.filter(c => c.name === rpc('begin')).length, 2);
});
for (const committed of [false, true]) test(`lost first begin response: status started=${committed} reconciles only the original plan`, async () => {
  const h = harness(), s = api.createEmployeeMappedDependencySession(TOKEN);
  h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.begin(plan()), redacted);
  await writesBlocked(s, h); h.respond(plan()); await s.plan(); await writesBlocked(s, h);
  h.respond({ ...notStarted(), mapping_hash: OTHER_HASH }); await assert.rejects(s.status(), redacted); await writesBlocked(s, h);
  h.replies.push({ error: { message: SECRET } }); await assert.rejects(s.status(), redacted); await writesBlocked(s, h);
  h.respond(committed ? status() : notStarted()); await s.status();
  if (!committed) {
    await assert.rejects(s.chunk(TABLES[0], 0), redacted);
    h.respond(status()); await s.begin(plan()); // Explicit rebegin only after zero-progress status.
  }
  h.respond(status(1)); await s.chunk(TABLES[0], 0);
  assert.equal(h.calls.filter(c => c.name === rpc('begin')).length, committed ? 1 : 2);
});
test('lost committed chunk response is reconciled by status and continues at next cursor without replay', async () => {
  const { h, s } = await ready('chunk'); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.chunk(TABLES[0], 0), redacted);
  h.respond(plan()); await s.plan(); await writesBlocked(s, h);
  h.respond(status(1)); await s.status(); await assert.rejects(s.chunk(TABLES[0], 0), redacted);
  h.respond(status(2)); await s.chunk(TABLES[0], 1);
  assert.deepEqual(h.calls.filter(c => c.name === rpc('chunk')).map(c => c.args.p_chunk_no), [0, 1]);
});
test('lost verify response may resume verified status, without replay or full restore authorization', async () => {
  const { h, s } = await ready('verify'); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.verify(), redacted);
  await writesBlocked(s, h); h.respond(status(2, 2, true)); const r = await s.status();
  assert.equal(r.verified, true); assert.equal(r.full_site_complete, false); assert.equal(h.calls.length, 3);
});
test('invalid job/auth UUIDs, missing/throwing auth and invalid plan never dispatch or poison a later explicit begin', async () => {
  const h = harness();
  for (const value of [null, 1, SECRET, TOKEN + '\n', id(0xab).toUpperCase()]) assert.throws(() => api.createEmployeeMappedDependencySession(value), redacted);
  const s = api.createEmployeeMappedDependencySession(TOKEN);
  for (const op of ['plan', 'status', 'begin']) {
    for (const value of [null, SECRET, SESSION + '\n', id(0xab).toUpperCase()]) {
      h.session = value; await assert.rejects(invoke(s, op), redacted);
    }
    h.session = SESSION; h.authError = Error(SECRET); await assert.rejects(invoke(s, op), redacted); h.authError = null;
  }
  for (const key of Object.keys(plan())) { const p = plan(); delete p[key]; await assert.rejects(s.begin(p), redacted); }
  assert.equal(h.calls.length, 0); h.respond(status()); await s.begin(plan()); assert.equal(h.calls.length, 1);
});
for (const op of OPERATIONS) for (const mode of ['throw', 'reject', 'error', 'null', 'malformed', 'error-with-data']) test(`${op}: ${mode} is redacted, single-attempt and never silently reconciled`, async () => {
  const { h, s, before } = await ready(op);
  h.replies.push(mode === 'error' ? { error: { message: SECRET, details: SECRET, hint: SECRET } }
    : mode === 'null' ? { data: null } : mode === 'malformed' ? { data: { secret: SECRET } }
      : mode === 'error-with-data' ? { data: replyFor(op), error: { message: SECRET } } : { [mode]: Error(SECRET) });
  await assert.rejects(invoke(s, op), redacted); await turn(); assert.equal(h.calls.length, before + 1);
  if (WRITES.includes(op)) await writesBlocked(s, h);
});
for (const op of OPERATIONS) {
  test(`${op}: pre-abort, same-turn abort and auth-time abort never dispatch`, async () => {
    const { h, s, before } = await ready(op), reads = h.reads, first = new AbortController(); first.abort(SECRET);
    await assert.rejects(invoke(s, op, first.signal), aborted);
    const second = new AbortController(), pending = invoke(s, op, second.signal); second.abort(SECRET); await assert.rejects(pending, aborted);
    assert.equal(h.calls.length, before); assert.equal(h.reads, reads);
    const third = new AbortController(); h.onAuth = () => third.abort(SECRET);
    await assert.rejects(invoke(s, op, third.signal), aborted); assert.equal(h.calls.length, before);
    h.onAuth = null;
    h.respond(replyFor(op)); await invoke(s, op); // No uncertain write was dispatched.
  });
  test(`${op}: signal-ignoring late completion stays mutually exclusive after prompt cancellation`, async () => {
    const { h, s, before } = await ready(op), wait = deferred(), controller = new AbortController();
    h.replies.push({ wait: wait.promise }); const pending = invoke(s, op, controller.signal); await turn();
    assert.equal(h.calls.length, before + 1); assert.deepEqual(h.calls.at(-1).signals, [controller.signal]);
    controller.abort(SECRET); await assert.rejects(pending, aborted); const reads = h.reads;
    for (const other of OPERATIONS) await assert.rejects(invoke(s, other), redacted);
    assert.equal(h.calls.length, before + 1); assert.equal(h.reads, reads);
    wait.resolve({ data: { ...replyFor(op), job_id: id(80) }, error: null }); await turn();
    if (WRITES.includes(op)) await writesBlocked(s, h);
    h.respond(op === 'verify' ? status(2, 2) : status()); await s.status();
    assert.equal(h.calls.length, before + 2);
  });
  test(`${op}: cancellation during response validation never confirms success`, async () => {
    const { h, s } = await ready(op), controller = new AbortController();
    h.respond(new Proxy(replyFor(op), { ownKeys(target) { controller.abort(SECRET); return Reflect.ownKeys(target); } }));
    await assert.rejects(invoke(s, op, controller.signal), aborted);
    if (WRITES.includes(op)) await writesBlocked(s, h);
  });
  test(`${op}: abortSignal adapter failure is generic and single-attempt`, async () => {
    const { h, s, before } = await ready(op); h.replies.push({ data: replyFor(op), signalError: Error(SECRET) });
    await assert.rejects(invoke(s, op, new AbortController().signal), redacted); assert.equal(h.calls.length, before + 1);
    if (WRITES.includes(op)) await writesBlocked(s, h);
  });
  test(`${op}: pending call rejects all five overlapping operations without queuing or extra auth`, async () => {
    const { h, s, before } = await ready(op), wait = deferred(); h.replies.push({ wait: wait.promise });
    const pending = invoke(s, op); await turn(); const reads = h.reads;
    for (const other of OPERATIONS) await assert.rejects(invoke(s, other), redacted);
    assert.equal(h.calls.length, before + 1); assert.equal(h.reads, reads);
    wait.resolve({ data: replyFor(op), error: null }); await pending; await turn(); assert.equal(h.calls.length, before + 1);
  });
}
test('separate instances are independent; aborted rejecting transport releases only its own lock after settling', async () => {
  const h = harness(), a = api.createEmployeeMappedDependencySession(TOKEN), b = api.createEmployeeMappedDependencySession(TOKEN);
  const wait = deferred(), controller = new AbortController(); h.replies.push({ wait: wait.promise });
  const pending = a.begin(plan(), controller.signal); await turn(); h.respond(plan()); await b.plan();
  controller.abort(SECRET); await assert.rejects(pending, aborted); await assert.rejects(a.status(), redacted);
  wait.reject(Error(SECRET)); await turn(); await writesBlocked(a, h);
  h.respond(notStarted()); await a.status(); h.respond(status()); await a.begin(plan()); assert.equal(h.calls.length, 4);
});

test('actual shared transport: exact five RPCs use 120s, one POST on HTTP/network/timeout/abort, no XHR or retry', async t => {
  const transportBuild = await build({ entryPoints: [`${root}src/lib/supabase.ts`], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://local.invalid'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('isolated-test-key') },
    plugins: [{ name: 'capture-fetch-no-real-sdk', setup(builder) {
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
  await transport.supabase.testFetch('https://local.invalid/rest/v1/rpc/employee_import_mapped_dependency_status_not_a_contract', { method: 'POST' });
  assert.deepEqual(delays, [8000]);
});
