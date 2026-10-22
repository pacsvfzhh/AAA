import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `50000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SESSION = id(1), TOKEN = id(2), JOB = id(3), SITE = id(4), SOURCE_SITE = id(5), PACKAGE = id(6);
const A = id(10), B = id(11), TA = id(30), TB = id(31), ZERO = '00000000-0000-0000-0000-000000000000';
const CATALOG_HASH = 'a'.repeat(64), MAPPING_HASH = 'b'.repeat(64), PLAN_HASH = 'c'.repeat(64), OTHER_HASH = 'd'.repeat(64);
const SECRET = 'private-session-job-token-password-source-row-never-expose';
const PRECISE = '9007199254740993.123456789012345678901234567890';
const TABLES = ['verification_requests'];
const OPERATIONS = ['bind', 'stage', 'plan', 'begin', 'apply', 'status', 'verify'];
const WRITES = ['bind', 'stage', 'begin', 'apply', 'verify'];
const BINDINGS = ['job_id', 'site_id', 'source_site_id', 'package_id', 'catalog_hash', 'mapping_hash', 'plan_hash'];
const CONFLICTS = ['verification_target_not_empty', 'verification_uuid_collision', 'source_employee_missing', 'verification_admin_unmapped', 'media_incomplete'];
const MEDIA_RPCS = ['get_employee_transfer_mapped_verification_media', 'employee_import_mapped_verification_media_bind'];
const FLAGS = { maintenance: true, dependencies_pending: true, financial_data_pending: true,
  can_restore: false, complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false };
const rpc = op => `employee_import_mapped_verification_${op}`;
const sha = text => createHash('sha256').update(text).digest('hex');
const counts = (...values) => Object.fromEntries(TABLES.map((key, n) => [key, values[n] ?? 0]));
const TOTALS = counts(3), CA = counts(2), CB = counts(1);
const TIME = '2026-10-22T01:02:03.123456Z';
const verification = (n, user = A) => ({ id: id(n), user_id: user, real_name: '历史\\n姓名', wallet_address: PRECISE,
  phone: '000012345678', email: '原文\\\\地址', status: 'pending', audit_remark: null, audited_by: null,
  audited_at: null, created_at: TIME, updated_at: null,
  id_front_url: `https://source-project.supabase.co/storage/v1/object/public/verification-documents/id-front/${user}.jpg`,
  id_back_url: null, selfie_url: null });
const lines = rows => rows.map(row => JSON.stringify(row) + '\n').join('');
const DATA = {
  verification_requests: lines([verification(100), { ...verification(101), status: 'approved', audited_by: id(90), audited_at: TIME,
    audit_remark: `原文 {"numeric":${PRECISE}}`, id_front_url: '', id_back_url: '历史\\\\链接', selfie_url: '原文链接' },
    { ...verification(102, B), status: 'rejected', created_at: null, updated_at: TIME, id_front_url: null }]),
};
function catalog() {
  return { version: 1, scope: 'employee-verification', site_id: SOURCE_SITE, package_id: PACKAGE,
    identity_catalog: { version: 1, scope: 'employee-identity', site_id: SOURCE_SITE, package_id: PACKAGE,
      tables: ['accounts', 'credentials', 'orders'].map((key, n) => ({ key, rows: n === 0 ? 2 : 0, bytes: n === 0 ? 300 : 0,
        row_hashes_sha256: sha('') })), processing_orders: 0, full_site_complete: false },
    tables: TABLES.map(key => ({ key, rows: TOTALS[key], bytes: Buffer.byteLength(DATA[key]),
      row_hashes_sha256: sha(DATA[key].match(/.*\n/g).map(sha).join('')) })), full_site_complete: false };
}
const common = () => ({ scope: 'employee-mapped-verification', job_id: JOB, site_id: SITE, source_site_id: SOURCE_SITE,
  package_id: PACKAGE, catalog_hash: CATALOG_HASH, mapping_hash: MAPPING_HASH, plan_hash: PLAN_HASH,
  totals: { ...TOTALS }, employees: 2, ...FLAGS });
const plan = () => ({ ...common(), can_begin: true, conflicts: [] });
const employee = (source = A, applied = false) => ({ source_id: source, target_id: source === A ? TA : TB,
  applied, counts: applied ? { ...(source === A ? CA : CB) } : counts() });
const status = (completed = 0, source = null, applied = false, verified = false) => ({ ...common(), started: true,
  completed_employees: completed, verified, employee: source === null ? null : employee(source, applied) });
const notStarted = (source = null) => ({ ...status(0, source), started: false });
const bindReply = () => ({ success: true, scope: 'employee-mapped-verification', catalog_hash: CATALOG_HASH, full_site_complete: false });
const stageReply = (key = 'verification_requests', no = 0, text = DATA[key]) => ({ success: true, scope: 'employee-mapped-verification', table_key: key,
  chunk_no: no, rows: text.split('\n').length - 1, bytes: Buffer.byteLength(text), sha256: sha(text), full_site_complete: false });
let forbiddenNetwork = 0;
mock.method(globalThis, 'fetch', () => { forbiddenNetwork++; assert.fail('network/formal services forbidden'); });
after(() => { assert.equal(forbiddenNetwork, 0); mock.restoreAll(); });
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/employeeMappedVerification.ts'; export {setHarness} from 'verification-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'isolated-mapped-verification', setup(builder) {
    builder.onResolve({ filter: /^(?:verification-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'verification-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'verification-test' }, ({ path }) => ({ contents: path === 'verification-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth'
        ? 'import{current}from"verification-test:state";export function getAdminFinancialSessionToken(){const h=current();h.reads++;h.onAuth?.();if(h.authError)throw h.authError;return h.session;}'
        : 'import{current}from"verification-test:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const redacted = error => {
  assert.ok(error instanceof Error);
  for (const secret of [SECRET, SESSION, TOKEN, JOB, A, TA, PRECISE, PLAN_HASH, MAPPING_HASH, CATALOG_HASH]) assert.equal(String(error).includes(secret), false);
  for (const key of ['cause', 'details', 'hint']) assert.equal(key in error, false);
  return true;
};
const aborted = error => redacted(error) && error.name === 'AbortError';
function harness() {
  const h = { session: SESSION, calls: [], replies: [], reads: 0, onAuth: null, authError: null, inspectArgs: null,
    respond(data) { h.replies.push({ data }); },
    rpc(name, args) {
      assert.ok(OPERATIONS.map(rpc).includes(name), `forbidden RPC ${name}`);
      assert.ok(h.replies.length, `unexpected ${name}`);
      h.inspectArgs?.(args);
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
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const turn = async () => { for (let n = 0; n < 16; n++) await Promise.resolve(); };
const invoke = (s, op, signal) => op === 'bind' ? s.bind(catalog(), signal) : op === 'stage' ? s.stage('verification_requests', 0, DATA.verification_requests, signal)
  : op === 'begin' ? s.begin(plan(), signal) : op === 'apply' ? s.apply(A, signal) : op === 'status' ? s.status(null, signal) : s[op](signal);
const replyFor = op => op === 'bind' ? bindReply() : op === 'stage' ? stageReply() : op === 'plan' ? plan()
  : op === 'apply' ? status(1, A, true) : op === 'verify' ? status(2, null, false, true) : status();
async function ready(op) {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN);
  if (op === 'stage') { h.respond(bindReply()); await s.bind(catalog()); }
  if (op === 'apply' || op === 'verify') { h.respond(status(op === 'verify' ? 2 : 0)); await s.status(); }
  return { h, s, before: h.calls.length };
}
async function writesBlocked(s, h) {
  const calls = h.calls.length, reads = h.reads;
  for (const op of WRITES) await assert.rejects(invoke(s, op), redacted);
  assert.equal(h.calls.length, calls); assert.equal(h.reads, reads);
}

test('lazy browser bundle isolates network/SDK/legacy APIs and exposes seven explicit operations', () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN);
  assert.deepEqual(Object.keys(s).sort(), [...OPERATIONS].sort()); assert.equal(h.reads, 0); assert.equal(h.calls.length, 0);
  assert.deepEqual(Object.keys(api).sort(), ['createEmployeeMappedVerificationSession', 'setHarness', 'validateEmployeeMappedVerificationPlan', 'validateEmployeeMappedVerificationStatus']);
  assert.equal(Object.keys(compiled.metafile.inputs).some(path => /node_modules|(?:^|\/)src\/lib\/(?:auth|supabase)\.ts$|\/(?:verificationApi|employeeMappedFinance|financeApi|financeTransfer|employeeMappedDependency|employeeMappedIdentity|siteImport|siteRestoreApi|api|crypto|container)\.ts$/.test(path)), false);
});
test('exact seven RPCs, all 15 raw columns/NULL/microseconds/identity text, fresh auth, repeat requests and maintenance-only success', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN), signal = new AbortController().signal;
  const call = async (op, action, reply, extra = {}) => {
    h.session = id(400 + h.calls.length); h.respond(reply); const session = h.session;
    assert.deepEqual(await action(), reply);
    assert.deepEqual(h.calls.at(-1), { name: rpc(op), args: { p_admin_session_token: session, p_job_token: TOKEN, ...extra }, signals: [signal] });
  };
  await call('bind', () => s.bind(catalog(), signal), bindReply(), { p_catalog: catalog() });
  for (const key of TABLES) await call('stage', () => s.stage(key, 0, DATA[key], signal), stageReply(key), { p_table_key: key, p_chunk_no: 0, p_ndjson: DATA[key] });
  await call('stage', () => s.stage('verification_requests', 0, DATA.verification_requests, signal), stageReply(), { p_table_key: 'verification_requests', p_chunk_no: 0, p_ndjson: DATA.verification_requests });
  await call('plan', () => s.plan(signal), plan());
  await call('status', () => s.status(undefined, signal), notStarted(), { p_source_id: null });
  await call('begin', () => s.begin(plan(), signal), status(), { p_plan_hash: PLAN_HASH });
  await call('apply', () => s.apply(A, signal), status(1, A, true), { p_source_id: A, p_plan_hash: PLAN_HASH });
  await call('apply', () => s.apply(A, signal), status(1, A, true), { p_source_id: A, p_plan_hash: PLAN_HASH });
  await call('apply', () => s.apply(B, signal), status(2, B, true), { p_source_id: B, p_plan_hash: PLAN_HASH });
  await call('verify', () => s.verify(signal), status(2, null, false, true));
  await call('status', () => s.status(A, signal), status(2, A, true, true), { p_source_id: A });
  await call('begin', () => s.begin(plan(), signal), status(2, null, false, true), { p_plan_hash: PLAN_HASH });
  await call('plan', () => s.plan(signal), plan());
  assert.equal(h.reads, h.calls.length);
  assert.equal(h.calls.find(c => c.name === rpc('stage')).args.p_ndjson.includes(PRECISE), true);
});
test('raw whitespace, CRLF, escapes, identity digits and JSON-looking text are not reserialized', async () => {
  const { h, s } = await ready('stage');
  const raw = DATA.verification_requests.replaceAll('{', '{ ').replaceAll('\n', '\r\n'), c = catalog(); c.tables[0].bytes = Buffer.byteLength(raw);
  const h2 = harness(), s2 = api.createEmployeeMappedVerificationSession(TOKEN); h2.respond(bindReply()); await s2.bind(c);
  h2.respond(stageReply('verification_requests', 0, raw)); await s2.stage('verification_requests', 0, raw);
  assert.equal(h2.calls.at(-1).args.p_ndjson, raw); assert.equal(h.calls.length, 1); assert.ok(s);
});
test('empty package requires real bind/stage/server begin/verify; no local success synthesis', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN), c = catalog();
  for (const table of [...c.tables, ...c.identity_catalog.tables]) Object.assign(table, { rows: 0, bytes: 0, row_hashes_sha256: sha('') });
  const empty = value => ({ ...value, totals: counts(), employees: 0 });
  h.respond(bindReply()); await s.bind(c);
  for (const key of TABLES) { h.respond(stageReply(key, 0, '')); await s.stage(key, 0, ''); }
  h.respond(empty(plan())); const p = await s.plan(); h.respond(empty(status())); await s.begin(p);
  h.respond(empty(status(0, null, false, true))); assert.equal((await s.verify()).verified, true); assert.equal(h.calls.length, 5);
});
for (const reason of CONFLICTS) test(`plan conflict allowlist blocks begin: ${reason}`, async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN), raw = { ...plan(), can_begin: false, conflicts: [reason] };
  h.respond(raw); const p = await s.plan(); await assert.rejects(s.begin(p), redacted); assert.equal(h.calls.length, 1);
});
test('employees with zero verification still require explicit apply and completed checkpoints before verification', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN), c = catalog();
  for (const table of c.tables) Object.assign(table, { rows: 0, bytes: 0, row_hashes_sha256: sha('') });
  const empty = value => ({ ...value, totals: counts(),
    ...(value.employee ? { employee: { ...value.employee, counts: counts() } } : {}) });
  h.respond(bindReply()); await s.bind(c);
  for (const key of TABLES) { h.respond(stageReply(key, 0, '')); await s.stage(key, 0, ''); }
  h.respond(empty(plan())); const p = await s.plan(); h.respond(empty(status())); await s.begin(p);
  await assert.rejects(s.verify(), redacted);
  h.respond(empty(status(1, A, true))); assert.equal((await s.apply(A)).employee.applied, true);
  await assert.rejects(s.verify(), redacted);
  h.respond(empty(status(2, B, true))); await s.apply(B);
  h.respond(empty(status(2, null, false, true))); await s.verify();
  assert.equal(h.calls.length, 7); assert.equal(h.calls.filter(call => call.name === rpc('apply')).length, 2);
});
test('one employee may own all verification requests while another has none; no one-to-one row requirement', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN);
  const adapt = value => ({ ...value, totals: counts(3),
    ...(value.employee ? { employee: { ...value.employee, counts: value.employee.applied && value.employee.source_id === A ? counts(3) : counts() } } : {}) });
  h.respond(adapt(plan())); const p = await s.plan(); h.respond(adapt(status())); await s.begin(p);
  h.respond(adapt(status(1, A, true))); await s.apply(A);
  h.respond(adapt(status(2, B, true))); await s.apply(B);
  h.respond(adapt(status(2, null, false, true))); assert.equal((await s.verify()).verified, true);
});
test('all five conflicts may clear without changing immutable plan fields', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN);
  h.respond({ ...plan(), can_begin: false, conflicts: [...CONFLICTS].reverse() }); await s.plan();
  h.respond(plan()); const p = await s.plan(); h.respond(status()); await s.begin(p);
});
const badCommon = [
  ['scope', p => { p.scope = 'employee-verification'; }], ['extra field', p => { p.repeated = true; }],
  ['missing totals', p => { delete p.totals; }], ['missing count', p => { delete p.totals.verification_requests; }],
  ['extra count', p => { p.totals.users = 1; }], ['employee limit', p => { p.employees = 500001; }],
  ['forbidden activity-only field', p => { p.running_work_sessions = 0; }],
  ['foreign activity totals', p => { p.totals.work_sessions = 0; }],
  ['legacy financial pending field', p => { p.pending_withdrawals = { count: 0, amount: '0' }; }],
  ['legacy financial totals', p => { p.totals.wallets = 1; }],
];
for (const field of BINDINGS) for (const mode of ['missing', 'invalid', 'newline', 'uppercase']) badCommon.push([`${field} ${mode}`, p => {
  if (mode === 'missing') delete p[field]; else p[field] = mode === 'invalid' ? SECRET : mode === 'newline' ? p[field] + '\n'
    : field.endsWith('hash') ? p[field].toUpperCase() : id(0xab).toUpperCase();
}]);
for (const [key, expected] of Object.entries(FLAGS)) badCommon.push([`unsafe ${key}`, p => { p[key] = !expected; }]);
for (const value of [-1, 0.5, '2', null, undefined, NaN, Infinity, 500001]) {
  for (const field of ['employees', 'totals']) badCommon.push([`${field} invalid ${String(value)}`, p => {
    if (field === 'totals') p.totals.verification_requests = value;
    else p.employees = value;
  }]);
}
for (const [label, change] of badCommon) test(`common strict validation: ${label}`, () => {
  for (const [make, validate] of [[plan, api.validateEmployeeMappedVerificationPlan], [status, api.validateEmployeeMappedVerificationStatus]]) {
    const raw = make(); change(raw); assert.throws(() => validate(raw), redacted);
  }
});
for (const employees of [0, 1, 3, 500000]) test(`employee count independent of verification totals: ${employees}`, () => {
  const raw = { ...plan(), employees };
  assert.equal(api.validateEmployeeMappedVerificationPlan(raw).employees, employees);
  assert.equal(api.validateEmployeeMappedVerificationStatus({ ...status(), employees }).employees, employees);
});
const badPlans = [
  ['missing conflicts', p => { delete p.conflicts; }], ['wrong can_begin', p => { p.can_begin = 'true'; }],
  ['empty but blocked', p => { p.can_begin = false; }], ['conflicted but allowed', p => { p.conflicts = [CONFLICTS[0]]; }],
  ['unknown conflict', p => { p.can_begin = false; p.conflicts = ['backup_verified']; }],
  ['duplicates', p => { p.can_begin = false; p.conflicts = [CONFLICTS[0], CONFLICTS[0]]; }],
  ['sparse', p => { p.conflicts = new Array(1); }], ['extra array key', p => { p.conflicts.extra = true; }],
  ['array symbol', p => { p.conflicts[Symbol('authority')] = true; }], ['unexpected status key', p => { p.started = false; }],
];
for (const [label, change] of badPlans) test(`plan response and begin input: ${label}`, async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN), raw = plan(); change(raw);
  h.respond(raw); await assert.rejects(s.plan(), redacted); await assert.rejects(s.begin(raw), redacted); assert.equal(h.calls.length, 1);
});
const badStatuses = [
  ['missing employee', p => { delete p.employee; }], ['extra can_begin', p => { p.can_begin = true; }],
  ['nonboolean started', p => { p.started = 1; }], ['nonboolean verified', p => { p.verified = 'false'; }],
  ['completed exceeds total', p => { p.completed_employees = 3; }], ['fractional completed', p => { p.completed_employees = 0.5; }],
  ['unstarted progress', p => { p.started = false; p.completed_employees = 1; }],
  ['unstarted verified', p => { p.started = false; p.verified = true; }], ['early verified', p => { p.verified = true; }],
  ['employee unknown key', p => { p.employee = { ...employee(), repeated: false }; }],
  ['same candidate', p => { p.employee = { ...employee(), target_id: A }; }],
  ['zero candidate', p => { p.employee = { ...employee(), target_id: ZERO }; }],
  ['zero source', p => { p.employee = { ...employee(), source_id: ZERO }; }],
  ['unapplied nonzero counts', p => { p.employee = employee(); p.employee.counts.verification_requests = 1; }],
  ['applied before started', p => { p.employee = employee(A, true); p.started = false; }],
  ['applied at zero completed', p => { p.employee = employee(A, true); }],
  ['zero employees with an employee', p => { p.employees = 0; p.employee = employee(); }],
  ['nonboolean applied', p => { p.employee = { ...employee(), applied: 1 }; }],
  ['counts exceed total', p => { p.employee = employee(A, true); p.employee.counts.verification_requests = 4; p.completed_employees = 1; }],
  ['all completed but unapplied', p => { p.completed_employees = 2; p.employee = employee(); }],
];
for (const [label, change] of badStatuses) test(`status strict schema: ${label}`, () => {
  const raw = status(); change(raw); assert.throws(() => api.validateEmployeeMappedVerificationStatus(raw), redacted);
});
test('exact descriptors reject accessors/hidden/symbol/prototype/proxies without invoking getters', () => {
  let getters = 0;
  for (const locate of [p => [p, 'job_id'], p => [p.totals, 'verification_requests'], p => [p, 'employees'],
    p => { p.conflicts = [CONFLICTS[0]]; return [p.conflicts, '0']; }]) {
    const p = plan(), [value, key] = locate(p);
    Object.defineProperty(value, key, { enumerable: true, get() { getters++; throw Error(SECRET); } });
    assert.throws(() => api.validateEmployeeMappedVerificationPlan(p), redacted);
  }
  assert.equal(getters, 0);
  const hidden = plan(); Object.defineProperty(hidden, 'job_id', { value: JOB, enumerable: false });
  const symbol = plan(); symbol[Symbol('authority')] = true;
  for (const p of [hidden, symbol, Object.setPrototypeOf(plan(), { authority: true }), new Proxy(plan(), { ownKeys() { throw Error(SECRET); } }), null, [], SECRET]) {
    assert.throws(() => api.validateEmployeeMappedVerificationPlan(p), redacted);
  }
  assert.deepEqual(api.validateEmployeeMappedVerificationPlan(Object.assign(Object.create(null), plan())), plan());
});
test('catalog, plans and all nested response data are detached/frozen before auth mutation', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN), c = catalog();
  h.inspectArgs = args => {
    const snapshot = args.p_catalog;
    for (const value of [snapshot, snapshot.tables, ...snapshot.tables, snapshot.identity_catalog,
      snapshot.identity_catalog.tables, ...snapshot.identity_catalog.tables]) assert.equal(Object.isFrozen(value), true);
  };
  h.onAuth = () => { c.site_id = id(90); c.tables[0].rows = 99; c.identity_catalog.tables[0].rows = 98; };
  h.respond(bindReply()); await s.bind(c); assert.deepEqual(h.calls[0].args.p_catalog, catalog()); h.onAuth = null; h.inspectArgs = null;
  h.respond(plan()); const p = await s.plan();
  for (const v of [p, p.totals, p.conflicts]) assert.equal(Object.isFrozen(v), true);
  const input = plan(); h.onAuth = () => { input.plan_hash = OTHER_HASH; input.employees = 0; };
  h.respond(status()); const pending = s.begin(input); input.totals.verification_requests = 99; await pending;
  assert.equal(h.calls.at(-1).args.p_plan_hash, PLAN_HASH); h.onAuth = null;
  const raw = status(1, A, true); h.respond(raw); const r = await s.apply(A); raw.employee.counts.verification_requests = 9;
  for (const v of [r, r.totals, r.employee, r.employee.counts]) assert.equal(Object.isFrozen(v), true);
  assert.equal(r.employee.counts.verification_requests, 2); assert.throws(() => { r.employee.counts.verification_requests = 9; }, TypeError);
});
for (const field of [...BINDINGS, 'totals', 'employees']) test(`task/plan binding remains pinned: ${field}`, async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN); h.respond(plan()); await s.plan();
  const change = value => {
    if (field === 'totals') value.totals.verification_requests++;
    else if (field === 'employees') value.employees++;
    else value[field] = field.endsWith('hash') ? OTHER_HASH : id(90);
    return value;
  };
  await assert.rejects(s.begin(change(plan())), redacted); assert.equal(h.calls.length, 1);
  h.respond(change(plan())); await assert.rejects(s.plan(), redacted);
  h.respond(change(status())); await assert.rejects(s.status(), redacted);
  h.respond(status()); await s.status();
});
test('bound catalog is immutable, same catalog repeat still dispatches, and status/plan must match its source/counts/hash', async () => {
  const { h, s } = await ready('stage'); const c = catalog(); c.tables[0].row_hashes_sha256 = OTHER_HASH;
  await assert.rejects(s.bind(c), redacted); assert.equal(h.calls.length, 1);
  h.respond(bindReply()); await s.bind(catalog()); assert.equal(h.calls.length, 2);
  for (const change of [p => { p.source_site_id = id(90); }, p => { p.package_id = id(90); }, p => { p.catalog_hash = OTHER_HASH; },
    p => { p.totals.verification_requests++; }, p => { p.employees++; }]) {
    const raw = plan(); change(raw); h.respond(raw); await assert.rejects(s.plan(), redacted);
  }
});
const badCatalogs = [
  ['foreign scope', c => { c.scope = 'employee-mapped-verification'; }], ['foreign package', c => { c.identity_catalog.package_id = id(90); }],
  ['missing table', c => { c.tables.pop(); }], ['foreign table', c => { c.tables[0].key = 'work_sessions'; }],
  ['extra authority', c => { c.can_restore = true; }], ['bad hash newline', c => { c.tables[0].row_hashes_sha256 += '\n'; }],
  ['UUID newline', c => { c.site_id += '\n'; c.identity_catalog.site_id += '\n'; }],
  ['bad rows', c => { c.tables[0].rows = '2'; }], ['accessor', c => { Object.defineProperty(c, 'tables', { get() { throw Error(SECRET); } }); }],
];
for (const [label, change] of badCatalogs) test(`bind input fails before auth: ${label}`, async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN), c = catalog(); change(c);
  await assert.rejects(s.bind(c), redacted); assert.equal(h.calls.length, 0); assert.equal(h.reads, 0);
});
const badStages = [
  ['missing LF', DATA.verification_requests.slice(0, -1)], ['blank line', '\n'], ['trailing blank', DATA.verification_requests + '\n'],
  ['invalid JSON', '{bad}\n'], ['extra column', lines([{ ...verification(100), password: SECRET }])],
  ['duplicate key', DATA.verification_requests.replace('"id":', `"id":"${A}","id":`)],
  ['escaped duplicate', DATA.verification_requests.replace('"id":', `"\\u0069d":"${A}","id":`)],
  ['bad UUID', DATA.verification_requests.replace(A, SECRET)],
  ['invalid status', lines([{ ...verification(100), status: 'verified' }])],
  ['nontext identity', lines([{ ...verification(100), wallet_address: 123 }])],
  ['invalid auditor UUID', lines([{ ...verification(100), audited_by: SECRET }])],
  ['nontext media', lines([{ ...verification(100), id_front_url: { url: 'image.jpg' } }])],
  ['null required text', lines([{ ...verification(100), real_name: null }])],
  ['invalid time', DATA.verification_requests.replace(TIME, '2026-02-30T00:00:00Z')],
  ['unordered', lines([verification(102), verification(100)])], ['duplicate ID', lines([verification(100), verification(100)])],
  ['invalid unicode', DATA.verification_requests + '\ud800\n'], ['NUL', DATA.verification_requests + '\0\n'],
  ['page bytes', ' '.repeat(262145)], ['page row limit', lines(Array.from({ length: 201 }, (_, n) => verification(500 + n)))],
  ['empty nonempty table', ''], ['nonstring', null],
];
for (const [label, text] of badStages) test(`stage validates exact raw input before auth: ${label}`, async () => {
  const { h, s } = await ready('stage'); await assert.rejects(s.stage('verification_requests', 0, text), redacted);
  assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
});
for (const no of [-1, 0.1, NaN, Infinity, '0', null, undefined, 500001]) test(`stage chunk bound rejects ${String(no)}`, async () => {
  const { h, s } = await ready('stage'); await assert.rejects(s.stage('verification_requests', no, DATA.verification_requests), redacted); assert.equal(h.calls.length, 1);
});
test('stage rejects foreign keys/missing bind and requires each of the 15 physical fields', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN);
  await assert.rejects(s.stage('verification_requests', 0, DATA.verification_requests), redacted); assert.equal(h.reads, 0);
  h.respond(bindReply()); await s.bind(catalog());
  for (const key of ['users', 'wallets', 'work_sessions', 'VERIFICATION_REQUESTS', null, {}, undefined]) {
    await assert.rejects(s.stage(key, 0, DATA.verification_requests), redacted);
  }
  for (const field of Object.keys(verification(100))) {
    const row = verification(100); delete row[field];
    await assert.rejects(s.stage('verification_requests', 0, lines([row])), redacted);
  }
  assert.equal(h.calls.length, 1);
});
for (const op of ['bind', 'stage']) for (const change of ['extra', 'missing', 'scope', 'success', 'full', 'hash', 'context']) test(`${op} rejects mismatched receipt: ${change}`, async () => {
  const { h, s } = await ready(op), raw = replyFor(op);
  if (change === 'extra') raw.repeated = true;
  if (change === 'missing') delete raw.success;
  if (change === 'scope') raw.scope = 'employee-verification';
  if (change === 'success') raw.success = false;
  if (change === 'full') raw.full_site_complete = true;
  if (change === 'hash') raw[op === 'bind' ? 'catalog_hash' : 'sha256'] += '\n';
  if (change === 'context') { if (op === 'bind') raw.plan_hash = PLAN_HASH; else raw.table_key = 'work_stop_markers'; }
  h.respond(raw); await assert.rejects(invoke(s, op), redacted); await writesBlocked(s, h);
});
for (const field of ['rows', 'bytes', 'chunk_no', 'sha256']) test(`stage compares actual ${field}, not a server-shaped success`, async () => {
  const { h, s } = await ready('stage'), raw = stageReply(); raw[field] = field === 'sha256' ? OTHER_HASH : raw[field] + 1;
  h.respond(raw); await assert.rejects(s.stage('verification_requests', 0, DATA.verification_requests), redacted); await writesBlocked(s, h);
});
for (const [label, before, after] of [
  ['started', status(), notStarted()], ['completed', status(1), status()], ['verified', status(2, null, false, true), status(2)],
  ['candidate', status(0, A), { ...status(0, A), employee: { ...employee(), target_id: TB } }],
  ['applied', status(1, A, true), status(1, A)],
  ['applied counts', status(1, A, true), { ...status(1, A, true), employee: { ...employee(A, true), counts: { ...CA, verification_requests: 1 } } }],
]) test(`status cannot roll back ${label}`, async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN), source = before.employee?.source_id ?? null;
  h.respond(before); await s.status(source); h.respond(after); await assert.rejects(s.status(source), redacted);
  h.respond(before); assert.deepEqual(await s.status(source), before);
});
test('observed mappings are one-to-one and cannot target another observed source', async () => {
  for (const target of [TA, A]) {
    const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN); h.respond(status(0, A)); await s.status(A);
    const raw = status(0, B); raw.employee.target_id = target; h.respond(raw); await assert.rejects(s.status(B), redacted);
  }
});
test('all observed applied employee counts must sum to catalog; changed source receipts never adopt a candidate', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN); h.respond(status(1, A, true)); await s.status(A);
  const raw = status(2, B, true); raw.employee.counts.verification_requests = 0;
  h.respond(raw); await assert.rejects(s.apply(B), redacted); await writesBlocked(s, h);
  h.respond(status(2, B, true)); await s.status(B);
  h.respond(status(2, B, true)); await assert.rejects(s.apply(A), redacted); await writesBlocked(s, h);
});
for (const key of TABLES) test(`all observed employees must account for the entire ${key} total`, async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN);
  h.respond(status(1, A, true)); await s.status(A);
  const missing = status(2, B, true); missing.employee.counts[key]--;
  h.respond(missing); await assert.rejects(s.status(B), redacted);
  h.respond(status(2, B, true)); await s.status(B);
});
test('partial known employee counts cannot already exceed a table total', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN);
  const adapt = value => ({ ...value, employees: 3 });
  h.respond(adapt(status(1, A, true))); await s.status(A);
  const excessive = adapt(status(2, B, true)); excessive.employee.counts.verification_requests = 2;
  h.respond(excessive); await assert.rejects(s.status(B), redacted);
});
test('plan is not started authorization; new factory status resumes directly and verify waits for all employees', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN); h.respond(plan()); await s.plan();
  await assert.rejects(s.apply(A), redacted); await assert.rejects(s.verify(), redacted); assert.equal(h.calls.length, 1);
  const fresh = api.createEmployeeMappedVerificationSession(TOKEN); h.respond(status(1, A, true)); await fresh.status(A);
  await assert.rejects(fresh.verify(), redacted); h.respond(status(2, B, true)); await fresh.apply(B);
  h.respond(status(2, null, false, true)); await fresh.verify(); assert.equal(h.calls.filter(c => c.name === rpc('begin')).length, 0);
});
for (const op of ['begin', 'apply', 'verify']) test(`${op} must return its operation-specific confirmed state`, async () => {
  const { h, s } = await ready(op); h.respond(op === 'begin' ? notStarted() : op === 'apply' ? status(0, A) : status(2));
  await assert.rejects(invoke(s, op), redacted); await writesBlocked(s, h);
});
for (const op of ['begin', 'apply', 'verify']) for (const committed of [false, true]) test(`${op} lost response committed=${committed}: only explicit matching status reconciles`, async () => {
  const { h, s } = await ready(op); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(invoke(s, op), redacted);
  await writesBlocked(s, h); h.respond(plan()); await s.plan(); await writesBlocked(s, h);
  h.replies.push({ error: { message: SECRET } }); await assert.rejects(s.status(op === 'apply' ? A : null), redacted); await writesBlocked(s, h);
  const raw = op === 'apply' ? status(committed ? 1 : 0, A, committed) : op === 'verify' ? status(2, null, false, committed) : committed ? status() : notStarted();
  h.respond(raw); await s.status(op === 'apply' ? A : null);
  if (op === 'begin' && !committed) { h.respond(status()); await s.begin(plan()); }
  else if (op === 'apply') { h.respond(status(1, A, true)); await s.apply(A); }
  else if (op === 'verify') { h.respond(status(2, null, false, true)); await s.verify(); }
  assert.equal(h.calls.filter(c => c.name === rpc(op)).length, (op === 'begin' && committed) ? 1 : 2);
});
test('unknown apply cannot be unlocked by global/other-source status or plan, only the original source', async () => {
  const { h, s } = await ready('apply'); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(s.apply(A), redacted);
  h.respond(status(1)); await s.status(); await writesBlocked(s, h);
  h.respond(status(1, B)); await s.status(B); await writesBlocked(s, h);
  h.respond(plan()); await s.plan(); await writesBlocked(s, h);
  h.respond(status(1, A, true)); await s.status(A); h.respond(status(2, B, true)); await s.apply(B);
});
for (const op of ['bind', 'stage']) test(`${op} unknown before complete staging: incomplete-stage status refusal keeps all writes paused`, async () => {
  const { h, s } = await ready(op); h.replies.push({ reject: Error(SECRET) }); await assert.rejects(invoke(s, op), redacted);
  for (let n = 0; n < 2; n++) {
    h.replies.push({ error: { code: '22023', message: 'Mapped verification status request rejected.' } });
    await assert.rejects(s.status(), error => redacted(error) && /complete staging.*pause/.test(error.message)); await writesBlocked(s, h);
  }
  assert.equal(h.calls.filter(c => c.name === rpc(op)).length, 1);
});
for (const op of ['bind', 'stage']) test(`${op} lost repeated response after the single table staged can reconcile via explicit status`, async () => {
  const { h, s } = await ready('stage');
  for (const key of TABLES) { h.respond(stageReply(key)); await s.stage(key, 0, DATA[key]); }
  const before = h.calls.length;
  h.replies.push({ reject: Error(SECRET) }); await assert.rejects(invoke(s, op), redacted); await writesBlocked(s, h);
  h.respond(plan()); const p = await s.plan(); await writesBlocked(s, h);
  h.respond(notStarted()); await s.status(); h.respond(status()); await s.begin(p);
  assert.equal(h.calls.length, before + 4); // No replay of bind/stage, only plan/status/explicit begin.
});
for (const [label, first, second, source] of [
  ['applied without completed advancement', status(1, A), status(1, A, true), A],
  ['too few remaining employees', status(1, A), status(1, B), B],
  ['more known sources than employees', status(0, A), status(0, B), B],
]) test(`cross-observation progress feasibility: ${label}`, async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN);
  if (label === 'more known sources than employees') {
    first.employees = second.employees = 1;
  }
  h.respond(first); await s.status(A); h.respond(second); await assert.rejects(s.status(source), redacted);
});
test('a later completed count can supersede an earlier unapplied observation without assuming no other worker', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN);
  h.respond(status(0, A)); await s.status(A); h.respond(status(1)); await s.status();
  h.respond(status(1, A, true)); await s.status(A);
});
test('stage line and UTF-8 byte limits reject before dispatch even below the JS character limit', async () => {
  const { h, s } = await ready('stage');
  for (const audit_remark of ['a'.repeat(65536), '汉'.repeat(22000)]) {
    const text = lines([{ ...verification(100), audit_remark }]);
    await assert.rejects(s.stage('verification_requests', 0, text), redacted);
  }
  assert.equal(h.calls.length, 1);
});
for (const [label, edit] of [
  ['source mismatch', raw => { raw.employee = employee(B, true); }],
  ['missing employee', raw => { raw.employee = null; }],
  ['not applied', raw => { raw.employee = employee(A); }],
  ['candidate drift', raw => { raw.employee.target_id = TB; }],
]) test(`apply result must confirm the requested stable candidate: ${label}`, async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN); h.respond(status(0, A)); await s.status(A);
  const raw = status(1, A, true); edit(raw); h.respond(raw); await assert.rejects(s.apply(A), redacted); await writesBlocked(s, h);
});
test('first unknown begin pins original task/plan; conflicting later reads cannot reconcile it', async () => {
  const h = harness(), s = api.createEmployeeMappedVerificationSession(TOKEN), input = plan(), wait = deferred();
  h.replies.push({ wait: wait.promise }); const pending = s.begin(input); await turn(); input.job_id = id(90); input.plan_hash = OTHER_HASH;
  const changed = { ...status(), job_id: id(90), plan_hash: OTHER_HASH }; wait.resolve({ data: changed, error: null });
  await assert.rejects(pending, redacted); h.respond(changed); await assert.rejects(s.status(), redacted); await writesBlocked(s, h);
  h.respond(status()); await s.status(); h.respond(status(1, A, true)); await s.apply(A);
});
test('job/auth/source validation happens before dispatch and auth failures do not poison later explicit writes', async () => {
  const h = harness();
  for (const value of [null, 1, SECRET, TOKEN + '\n', id(0xab).toUpperCase()]) assert.throws(() => api.createEmployeeMappedVerificationSession(value), redacted);
  const s = api.createEmployeeMappedVerificationSession(TOKEN);
  for (const value of [null, SECRET, SESSION + '\n', id(0xab).toUpperCase()]) {
    h.session = value; await assert.rejects(s.bind(catalog()), redacted); await assert.rejects(s.status(), redacted);
  }
  h.session = SESSION; h.authError = Error(SECRET); await assert.rejects(s.begin(plan()), redacted); h.authError = null;
  for (const value of [1, SECRET, A + '\n', id(0xab).toUpperCase()]) await assert.rejects(s.status(value), redacted);
  assert.equal(h.calls.length, 0); h.respond(status()); await s.begin(plan());
  for (const value of [null, undefined, ZERO, SECRET]) await assert.rejects(s.apply(value), redacted);
  assert.equal(h.calls.length, 1);
});
for (const op of OPERATIONS) for (const mode of ['throw', 'reject', 'error', 'null', 'malformed', 'error-with-data']) test(`${op}: ${mode} is generic and single-attempt`, async () => {
  const { h, s, before } = await ready(op);
  h.replies.push(mode === 'error' ? { error: { message: SECRET, details: SECRET, hint: SECRET } }
    : mode === 'null' ? { data: null } : mode === 'malformed' ? { data: { password: SECRET } }
      : mode === 'error-with-data' ? { data: replyFor(op), error: { message: SECRET } } : { [mode]: Error(SECRET) });
  await assert.rejects(invoke(s, op), redacted); await turn(); assert.equal(h.calls.length, before + 1);
  if (WRITES.includes(op)) await writesBlocked(s, h);
});
for (const op of OPERATIONS) {
  test(`${op}: pre/same-turn/auth-time abort never dispatches or creates uncertainty`, async () => {
    const { h, s, before } = await ready(op), reads = h.reads, first = new AbortController(); first.abort(SECRET);
    await assert.rejects(invoke(s, op, first.signal), aborted);
    const second = new AbortController(), pending = invoke(s, op, second.signal); second.abort(SECRET); await assert.rejects(pending, aborted);
    assert.equal(h.calls.length, before); assert.equal(h.reads, reads);
    const third = new AbortController(); h.onAuth = () => third.abort(SECRET);
    await assert.rejects(invoke(s, op, third.signal), aborted); assert.equal(h.calls.length, before);
    h.onAuth = null; h.respond(replyFor(op)); await invoke(s, op);
  });
  test(`${op}: signal-ignoring pending call retains mutex after prompt cancellation until actual settle`, async () => {
    const { h, s, before } = await ready(op), wait = deferred(), controller = new AbortController();
    h.replies.push({ wait: wait.promise }); const pending = invoke(s, op, controller.signal); await turn();
    assert.equal(h.calls.length, before + 1); assert.deepEqual(h.calls.at(-1).signals, [controller.signal]);
    controller.abort(SECRET); await assert.rejects(pending, aborted); const reads = h.reads;
    for (const other of OPERATIONS) await assert.rejects(invoke(s, other), redacted);
    assert.equal(h.calls.length, before + 1); assert.equal(h.reads, reads);
    wait.resolve({ data: replyFor(op), error: null }); await turn();
    if (WRITES.includes(op)) await writesBlocked(s, h);
    h.respond(op === 'verify' ? status(2) : op === 'apply' ? status(1, A, true) : status());
    await s.status(op === 'apply' ? A : null); assert.equal(h.calls.length, before + 2);
  });
  test(`${op}: abort while validating never confirms receipt`, async () => {
    const { h, s } = await ready(op), controller = new AbortController();
    h.respond(new Proxy(replyFor(op), { ownKeys(target) { controller.abort(SECRET); return Reflect.ownKeys(target); } }));
    await assert.rejects(invoke(s, op, controller.signal), aborted); if (WRITES.includes(op)) await writesBlocked(s, h);
  });
  test(`${op}: adapter failure still tracks underlying request and leaves unknown writes locked`, async () => {
    const { h, s } = await ready(op), wait = deferred(); h.replies.push({ wait: wait.promise, signalError: Error(SECRET) });
    await assert.rejects(invoke(s, op, new AbortController().signal), redacted);
    await assert.rejects(s.status(), redacted); wait.reject(Error(SECRET)); await turn();
    if (WRITES.includes(op)) await writesBlocked(s, h);
  });
  test(`${op}: all seven overlapping operations fail without queuing/auth`, async () => {
    const { h, s, before } = await ready(op), wait = deferred(); h.replies.push({ wait: wait.promise });
    const pending = invoke(s, op); await turn(); const reads = h.reads;
    for (const other of OPERATIONS) await assert.rejects(invoke(s, other), redacted);
    assert.equal(h.calls.length, before + 1); assert.equal(h.reads, reads);
    wait.resolve({ data: replyFor(op), error: null }); await pending; assert.equal(h.calls.length, before + 1);
  });
}
test('instances are independent, rejected late transport cannot adopt state or release another instance lock', async () => {
  const h = harness(), a = api.createEmployeeMappedVerificationSession(TOKEN), b = api.createEmployeeMappedVerificationSession(TOKEN);
  const wait = deferred(), controller = new AbortController(); h.replies.push({ wait: wait.promise });
  const pending = a.begin(plan(), controller.signal); await turn(); h.respond(status(1, A, true)); await b.status(A);
  controller.abort(SECRET); await assert.rejects(pending, aborted); await assert.rejects(a.status(), redacted);
  wait.reject(Error(SECRET)); await turn(); await writesBlocked(a, h);
  h.respond(notStarted()); await a.status(); h.respond(status()); await a.begin(plan()); assert.equal(h.calls.length, 4);
});

test('database types expose seven session/four media RPCs and exact required arguments', async () => {
  const source = await readFile(`${root}src/types/database.ts`, 'utf8');
  for (const op of OPERATIONS) assert.match(source, new RegExp(`${rpc(op)}: \\{`));
  assert.match(source, /employee_import_mapped_verification_status: \{\s*Args: \{ p_admin_session_token: string; p_job_token: string; p_source_id: string \| null \}/);
  const mediaArgs = {
    get_employee_transfer_mapped_verification_media: ['p_admin_session_token', 'p_job_token'],
    employee_import_mapped_verification_media_bind: ['p_admin_session_token', 'p_job_token', 'p_files'],
    employee_transfer_mapped_verification_media_authorize: ['p_admin_session_token', 'p_job_token', 'p_action', 'p_object_key'],
    employee_transfer_mapped_verification_media_commit: ['p_admin_session_token', 'p_job_token', 'p_action', 'p_object_key',
      'p_bytes', 'p_sha256', 'p_content_type', 'p_storage_origin', 'p_generation'],
  };
  for (const [name, keys] of Object.entries(mediaArgs)) {
    const declaration = source.match(new RegExp(`${name}: \\{\\s*Args: \\{([^}]+)\\};\\s*Returns: Record<string, unknown>;`));
    assert.ok(declaration, name);
    assert.deepEqual([...declaration[1].matchAll(/(p_[a-z0-9_]+):/g)].map(match => match[1]), keys);
    assert.equal(declaration[1].includes('?'), false);
    assert.equal(declaration[1].includes('p_direction'), false);
  }
});
test('actual shared transport: all nine exact browser RPCs use 120s and one POST on HTTP/network/timeout/abort without SDK/XHR/retries', async t => {
  const output = await build({ entryPoints: [`${root}src/lib/supabase.ts`], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://local.invalid'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('isolated-test-key') },
    plugins: [{ name: 'capture-no-sdk', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'local-client', namespace: 'capture' }));
      builder.onLoad({ filter: /.*/, namespace: 'capture' }, () => ({ contents: 'export const createClient=(url,key,options)=>({testFetch:options.global.fetch});' }));
    } }],
  });
  assert.equal(Object.keys(output.metafile.inputs).some(path => path.includes('node_modules')), false);
  let calls = 0, xhrCalls = 0, mode = 'http', fireTimeout; const delays = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(new URL(_url).origin, 'https://local.invalid'); calls++;
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (mode === 'timeout' || mode === 'abort') return new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      if (mode === 'timeout') queueMicrotask(fireTimeout);
    });
    return new Response('{}', { status: mode === 'success' ? 200 : 503 });
  });
  const transport = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { delays.push(delay); fireTimeout = callback; return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const xhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: function () { xhrCalls++; assert.fail('XHR forbidden'); } });
  t.after(() => { if (xhr) Object.defineProperty(globalThis, 'XMLHttpRequest', xhr); else delete globalThis.XMLHttpRequest; });
  for (const name of [...OPERATIONS.map(rpc), ...MEDIA_RPCS]) for (const failureMode of ['http', 'network', 'timeout', 'abort']) {
    calls = 0; delays.length = 0; mode = failureMode; const controller = new AbortController();
    const pending = transport.supabase.testFetch(`https://local.invalid/rest/v1/rpc/${name}`, { method: 'POST', signal: controller.signal });
    if (mode === 'abort') controller.abort(SECRET);
    if (mode === 'http') assert.equal((await pending).status, 503); else await assert.rejects(pending);
    assert.equal(calls, 1); assert.equal(xhrCalls, 0); assert.deepEqual(delays, [120000]);
  }
  mode = 'success';
  for (const name of [...OPERATIONS.map(rpc), ...MEDIA_RPCS].map(name => name + '_not_a_contract')) {
    delays.length = 0; await transport.supabase.testFetch(`https://local.invalid/rest/v1/rpc/${name}`, { method: 'POST' }); assert.deepEqual(delays, [8000]);
  }
});
