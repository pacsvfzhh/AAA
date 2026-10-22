import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// LOCAL ONLY. Real client/cutoff/checks/transport; auth, SDK and all network are mocked.
const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `ba000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const AUTH = id(1), TOKEN = id(2), SOURCE = id(3), PACKAGE = id(4), CUTOFF = id(5);
const HASH = 'a'.repeat(64), OTHER_HASH = 'b'.repeat(64), PASSWORD = 'LOCAL-release-password-CANARY';
const CONFIRM = '確認啟用新站', PRIVATE = 'PRIVATE-BACKEND-ERROR';
const BIND = 'employee_import_site_bind_cutoff', STATUS = 'get_employee_import_site_release_status', RELEASE = 'employee_import_site_release';
const BLOCKERS = ['missing_cutoff', 'cutoff_expired', 'not_verified', 'task_not_running', 'maintenance_mismatch'];
const COUNTS = ['employees', 'active_employees', 'active_admins', 'active_plans', 'active_tasks', 'queued_employees'];
const TIME = '2026-10-22T10:00:00.123456Z', RELEASE_TIME = '2026-10-22T10:00:00.123457Z';
const sha = value => createHash('sha256').update(value).digest('hex');
function cutoff(overrides = {}) {
  const r = { version: 1, policy: 'drained-queue-v1', site_id: SOURCE, cutoff_id: CUTOFF, frozen_at: TIME, ...overrides };
  const raw = `{"policy": "${r.policy}", "site_id": "${r.site_id}", "version": ${r.version}, "cutoff_id": "${r.cutoff_id}", "frozen_at": "${r.frozen_at}"}`;
  return { ...r, cutoff_hash: sha(raw) };
}
let sequence = 100;
const context = (overrides = {}) => ({ jobId: id(++sequence), jobToken: TOKEN, sourceSiteId: SOURCE,
  packageId: PACKAGE, verificationHash: HASH, cutoff: cutoff(), ...overrides });
const common = (c, scope) => ({ version: 1, success: true, scope, job_id: c.jobId,
  source_site_id: c.sourceSiteId, package_id: c.packageId, full_site_complete: false });
const binding = c => ({ ...common(c, 'site-cutover-binding'), cutoff: structuredClone(c.cutoff) });
const receipt = c => ({ ...common(c, 'site-release'), cutoff_id: c.cutoff.cutoff_id, cutoff_hash: c.cutoff.cutoff_hash,
  verification_hash: c.verificationHash, released_at: RELEASE_TIME,
  counts: { employees: 3, active_employees: 2, active_admins: 1, active_plans: 4, active_tasks: 5, queued_employees: 2 },
  released: true, maintenance: false, accounts_restored: true, automation_resumed: true, source_shutdown: 'operator-managed' });
const status = (c, overrides = {}) => ({ ...common(c, 'site-release-status'), cutoff: structuredClone(c.cutoff),
  verification_hash: c.verificationHash, released: false, receipt: null, maintenance: true,
  blockers: c.cutoff ? [] : ['missing_cutoff'], can_release: c.cutoff !== null, ...overrides });
const historical = (c, maintenance = false) => status(c, { released: true, receipt: receipt(c), maintenance, can_release: false });
const turn = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let externalCalls = 0;
mock.method(globalThis, 'fetch', () => { externalCalls++; assert.fail('Production services and real network are forbidden'); });
after(() => { assert.equal(externalCalls, 0); mock.restoreAll(); });
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/siteRelease.ts';export{setHarness}from'release-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
  plugins: [{ name: 'isolated-site-release-boundaries', setup(b) {
    b.onResolve({ filter: /^(?:release-test:state|\.\.\/(?:auth|supabase))$/ }, a => ({ path: a.path, namespace: 'release-test' }));
    b.onLoad({ filter: /.*/, namespace: 'release-test' }, ({ path }) => ({ contents: path === 'release-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth'
        ? 'import{current}from"release-test:state";export function getAdminFinancialSessionToken(){const h=current();h.authReads++;if(h.authError)throw h.authError;return h.auth;}'
        : 'import{current}from"release-test:state";export const supabase={rpc:(...a)=>current().rpc(...a)};' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function safeError(error) {
  assert.ok(error instanceof Error);
  for (const secret of [PASSWORD, AUTH, TOKEN, PRIVATE]) assert.equal(String(error).includes(secret), false);
  for (const key of ['cause', 'details', 'hint']) assert.equal(key in error, false);
  return true;
}
const aborted = error => safeError(error) && error.name === 'AbortError';
function harness(c = context()) {
  const h = { c, calls: [], replies: [], auth: AUTH, authReads: 0, authError: null,
    respond(data) { h.replies.push({ data }); },
    rpc(name, args) {
      assert.ok([BIND, STATUS, RELEASE].includes(name), `unexpected RPC ${name}`);
      assert.ok(h.replies.length, `unscripted RPC ${name}`);
      const reply = h.replies.shift(), call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
      if (reply.throw) throw reply.throw;
      const q = { abortSignal(signal) { call.signals.push(signal); if (reply.signalThrow) throw Error(PRIVATE); return q; },
        then(resolve, reject) { return Promise.resolve().then(() => {
          if (reply.reject) throw reply.reject;
          return reply.wait ?? { data: reply.data, error: Object.hasOwn(reply, 'error') ? reply.error : null };
        }).then(resolve, reject); } };
      return q;
    } };
  api.setHarness(h); h.session = api.createSiteReleaseSession(c); return h;
}
const invoke = (h, op, signal, session = h.session) => op === 'bind'
  ? api.bindSiteReleaseCutoff(h.c.jobToken, h.c.jobId, h.c.sourceSiteId, h.c.packageId, h.c.cutoff, signal)
  : op === 'status' ? session.status(signal) : session.release(PASSWORD, CONFIRM, signal);
const validReply = (h, op) => op === 'bind' ? binding(h.c) : op === 'status' ? status(h.c) : receipt(h.c);
async function writesBlocked(h, session = h.session) {
  const calls = h.calls.length, reads = h.authReads;
  await assert.rejects(invoke(h, 'bind'), safeError);
  await assert.rejects(invoke(h, 'release', undefined, session), safeError);
  assert.equal(h.calls.length, calls); assert.equal(h.authReads, reads);
}
async function reconcile(h, raw = status(h.c), session = h.session) {
  h.respond(raw); assert.deepEqual(await session.status(), raw);
  assert.equal(h.calls.at(-1).name, STATUS);
}
function frozen(value) {
  if (value && typeof value === 'object') { assert.ok(Object.isFrozen(value)); for (const child of Object.values(value)) frozen(child); }
}

test('bundle uses real siteRelease, sourceCutover, SHA and dispatch object checks, not SDK/auth/network', () => {
  const paths = Object.keys(compiled.metafile.inputs);
  for (const name of ['siteRelease.ts', 'sourceCutover.ts', 'dispatchTransfer.ts', 'sha256.ts']) assert.ok(paths.some(p => p.endsWith('/' + name)));
  assert.equal(paths.some(p => /node_modules|src\/lib\/(?:auth|supabase)\.ts/.test(p)), false);
  assert.deepEqual(Object.keys(api).sort(), ['bindSiteReleaseCutoff', 'createSiteReleaseSession', 'setHarness']);
});
for (const op of ['bind', 'status', 'release']) test(`${op}: exact RPC/args, current admin token and signal, immutable owned response`, async () => {
  const h = harness(), signal = new AbortController().signal, raw = validReply(h, op);
  h.auth = id(20); h.respond(raw); const result = await invoke(h, op, signal);
  assert.deepEqual(result, raw); frozen(result); assert.notEqual(result, raw);
  const args = { p_admin_session_token: id(20), ...(op === 'status' ? { p_job_id: h.c.jobId } : { p_job_token: TOKEN }),
    ...(op === 'bind' ? { p_cutoff: cutoff() } : op === 'release'
      ? { p_admin_password: PASSWORD, p_confirmation: CONFIRM, p_verification_hash: HASH } : {}) };
  assert.deepEqual(h.calls, [{ name: ({ bind: BIND, status: STATUS, release: RELEASE })[op], args, signals: [signal] }]);
  if (op === 'release') {
    raw.counts.employees = 99; assert.equal(result.counts.employees, 3);
    await writesBlocked(h); h.auth = id(21); await reconcile(h, historical(h.c));
  } else {
    raw.cutoff.cutoff_hash = OTHER_HASH; assert.equal(result.cutoff.cutoff_hash, cutoff().cutoff_hash);
    h.auth = id(21); h.respond(validReply(h, op)); await invoke(h, op);
  }
  assert.equal(h.authReads, 2); assert.equal(h.calls[1].args.p_admin_session_token, id(21));
  assert.deepEqual(h.calls[1].signals, []); assert.equal(Object.isFrozen(raw), false);
});
test('context is an immutable closure snapshot; public session exposes no token or context', async () => {
  const c = context(), h = harness(c), original = structuredClone(c), session = h.session;
  c.jobId = id(998); c.jobToken = id(997); c.sourceSiteId = id(996); c.packageId = id(995); c.verificationHash = OTHER_HASH;
  c.cutoff.cutoff_id = id(994); c.cutoff.cutoff_hash = OTHER_HASH;
  assert.deepEqual(Reflect.ownKeys(session).sort(), ['release', 'status']); frozen(session);
  assert.equal(JSON.stringify(session), '{}');
  h.respond(status(original)); await session.status();
  h.respond(receipt(original)); assert.deepEqual(await session.release(PASSWORD, CONFIRM), receipt(original));
  assert.equal(h.calls[1].args.p_job_token, TOKEN); assert.equal(h.calls[1].args.p_verification_hash, HASH);
});
test('bind snapshots all six cutoff fields before awaiting and never freezes caller input', async () => {
  const h = harness(), original = structuredClone(h.c), gate = deferred(); h.replies.push({ wait: gate.promise });
  const pending = invoke(h, 'bind', new AbortController().signal);
  h.c.cutoff.frozen_at = '2026-10-23T00:00:00.000001Z'; h.c.cutoff.cutoff_hash = OTHER_HASH;
  await turn(); assert.deepEqual(h.calls[0].args.p_cutoff, original.cutoff);
  gate.resolve({ data: binding(original), error: null }); const result = await pending;
  assert.deepEqual(result, binding(original)); frozen(result); assert.equal(Object.isFrozen(h.c.cutoff), false);
});
for (const field of ['jobId', 'jobToken', 'sourceSiteId', 'packageId', 'verificationHash']) test(`context rejects malformed ${field} before auth/RPC`, () => {
  const h = harness();
  for (const value of ['', null, undefined, 1, 'bad', (field === 'verificationHash' ? HASH : id(0xab)) + '\n',
    (field === 'verificationHash' ? HASH : id(0xab)).toUpperCase()]) assert.throws(() => api.createSiteReleaseSession(context({ [field]: value })), safeError);
  assert.equal(h.calls.length, 0); assert.equal(h.authReads, 0);
});
for (const [label, mutate] of [
  ['missing field', c => { delete c.cutoff; }], ['extra secret', c => { c.secret = TOKEN; }],
  ['invalid digest', c => { c.cutoff.cutoff_hash = OTHER_HASH; }],
  ['valid digest wrong site', c => { c.cutoff = cutoff({ site_id: id(87) }); }],
  ['extra cutoff field', c => { c.cutoff.extra = true; }],
  ['invalid calendar date with valid digest', c => { c.cutoff = cutoff({ frozen_at: '2026-02-30T00:00:00.000000Z' }); }],
]) test(`context rejects ${label}`, () => { const h = harness(), c = context(); mutate(c); assert.throws(() => api.createSiteReleaseSession(c), safeError); assert.equal(h.authReads, 0); });
test('wrong confirmation/password and null cutoff cannot cause release/auth/RPC', async () => {
  const h = harness();
  for (const value of ['', 'wrong', ' ' + CONFIRM, CONFIRM + ' ', CONFIRM + '\n', '確認恢復舊站業務並放棄切站']) await assert.rejects(h.session.release(PASSWORD, value), safeError);
  for (const value of ['', null, undefined, 1, {}]) await assert.rejects(h.session.release(value, CONFIRM), safeError);
  const missing = api.createSiteReleaseSession(context({ cutoff: null }));
  await assert.rejects(missing.release(PASSWORD, CONFIRM), safeError);
  assert.equal(h.calls.length, 0); assert.equal(h.authReads, 0);
  h.respond(receipt(h.c)); await invoke(h, 'release');
});
test('bind rejects invalid token/identity/cutoff before authentication or RPC', async () => {
  const h = harness(), values = [TOKEN, h.c.jobId, SOURCE, PACKAGE, cutoff()];
  for (let index = 0; index < 5; index++) {
    const args = structuredClone(values); args[index] = 'invalid'; await assert.rejects(api.bindSiteReleaseCutoff(...args), safeError);
  }
  assert.equal(h.calls.length, 0); assert.equal(h.authReads, 0);
});
for (const op of ['bind', 'status', 'release']) test(`${op}: pre-abort performs no auth/request and does not poison the job`, async () => {
  const h = harness(), c = new AbortController(); c.abort(PASSWORD);
  await assert.rejects(invoke(h, op, c.signal), aborted); assert.equal(h.calls.length, 0); assert.equal(h.authReads, 0);
  h.respond(validReply(h, op)); await invoke(h, op);
});
for (const op of ['bind', 'status', 'release']) for (const fault of ['permission', 'expired', 'revoked-role', 'reject', 'sync-throw', 'auth', 'invalid-auth', 'false-error']) {
  test(`${op}: ${fault} is redacted, single attempt, no implicit verification/retry/recovery`, async () => {
    const h = harness(), secret = Error(`${PASSWORD} ${TOKEN} ${AUTH} ${PRIVATE}`);
    if (fault === 'auth') h.authError = secret;
    else if (fault === 'invalid-auth') h.auth = 'invalid';
    else h.replies.push(fault === 'reject' ? { reject: secret } : fault === 'sync-throw' ? { throw: secret }
      : { data: validReply(h, op), error: fault === 'false-error' ? false : { code: '42501', message: `${fault} ${secret.message}`, details: PASSWORD } });
    await assert.rejects(invoke(h, op), safeError); await turn();
    assert.equal(h.authReads, 1); assert.equal(h.calls.length, ['auth', 'invalid-auth'].includes(fault) ? 0 : 1);
    if (op !== 'status' && !['auth', 'invalid-auth'].includes(fault)) await writesBlocked(h);
  });
}
const commonMutations = [
  ['missing version', r => { delete r.version; }], ['extra permission', r => { r.can_activate = true; }],
  ['wrong version', r => { r.version = 2; }], ['success false', r => { r.success = false; }],
  ['wrong scope', r => { r.scope = 'site-restore-verification'; }], ['complete true', r => { r.full_site_complete = true; }],
  ['other job', r => { r.job_id = id(70); }], ['other source', r => { r.source_site_id = id(71); }],
  ['other package', r => { r.package_id = id(72); }], ['UUID trailing newline', r => { r.job_id += '\n'; }],
];
for (const op of ['bind', 'status', 'release']) for (const [label, mutate] of commonMutations) test(`${op}: rejects ${label}`, async () => {
  const h = harness(), raw = validReply(h, op); mutate(raw); h.respond(raw); await assert.rejects(invoke(h, op), safeError);
  if (op !== 'status') await writesBlocked(h);
});
const cutoffMutations = [
  ['missing cutoff field', r => { delete r.cutoff.policy; }], ['extra cutoff field', r => { r.cutoff.extra = true; }],
  ['wrong hash', r => { r.cutoff.cutoff_hash = OTHER_HASH; }], ['drifted microsecond', r => { r.cutoff.frozen_at = RELEASE_TIME; }],
  ['correctly rehashed different cutoff', r => { r.cutoff = cutoff({ cutoff_id: id(80) }); }],
  ['correctly rehashed different source', r => { r.cutoff = cutoff({ site_id: id(81) }); }],
  ['correctly rehashed different time', r => { r.cutoff = cutoff({ frozen_at: RELEASE_TIME }); }],
  ['cutoff null for non-null context', r => { r.cutoff = null; }],
];
for (const op of ['bind', 'status']) for (const [label, mutate] of cutoffMutations) test(`${op}: rejects ${label}`, async () => {
  const h = harness(), raw = validReply(h, op); mutate(raw); h.respond(raw); await assert.rejects(invoke(h, op), safeError);
});
const receiptMutations = [
  ['wrong cutoff ID', r => { r.cutoff_id = id(90); }], ['wrong cutoff hash', r => { r.cutoff_hash = OTHER_HASH; }],
  ['wrong verification hash', r => { r.verification_hash = OTHER_HASH; }], ['hash newline', r => { r.verification_hash += '\n'; }],
  ['released false', r => { r.released = false; }], ['maintenance true', r => { r.maintenance = true; }],
  ['accounts not restored', r => { r.accounts_restored = false; }], ['automation not resumed', r => { r.automation_resumed = false; }],
  ['claims remote shutdown', r => { r.source_shutdown = 'verified'; }], ['extra count', r => { r.counts.money = 1.5; }],
  ['missing count', r => { delete r.counts.employees; }], ['active exceeds total', r => { r.counts.active_employees = 4; r.counts.queued_employees = 4; }],
  ['queue differs from active', r => { r.counts.queued_employees = 1; }],
];
for (const [label, mutate] of receiptMutations) for (const op of ['release', 'historical-status']) test(`${op}: rejects ${label}`, async () => {
  const h = harness(), raw = receipt(h.c); mutate(raw); h.respond(op === 'release' ? raw : status(h.c, { released: true, receipt: raw, can_release: false }));
  await assert.rejects(invoke(h, op === 'release' ? 'release' : 'status'), safeError);
});
for (const key of COUNTS) test(`counts.${key}: rejects floats, non-number, negative and unsafe integers`, async () => {
  for (const value of [-1, 0.1, '1', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const h = harness(), raw = receipt(h.c); raw.counts[key] = value; h.respond(raw); await assert.rejects(invoke(h, 'release'), safeError);
  }
});
test('counts accept zero and maximum safe integer, never convert strings or money floats', async () => {
  for (const value of [0, Number.MAX_SAFE_INTEGER]) {
    const h = harness(), raw = receipt(h.c); for (const key of COUNTS) raw.counts[key] = value;
    h.respond(raw); assert.deepEqual(await invoke(h, 'release'), raw);
  }
});
for (const time of ['2026-10-22T10:00:00Z', '2026-10-22T10:00:00.123Z', RELEASE_TIME + '\n',
  '2026-10-22T10:00:00.123457+00:00', '2026-10-22T18:00:00.123457+08:00',
  '2026-10-23T00:00:00.000000Z', '2026-10-21T23:59:59.999999Z', '2026-10-22T10:00:00.123455Z',
  '2026-02-30T10:00:00.123457Z', '2026-10-22T24:00:00.123457Z', null, 42]) test(`release rejects timestamp ${String(time)}`, async () => {
  const h = harness(), raw = receipt(h.c); raw.released_at = time; h.respond(raw); await assert.rejects(invoke(h, 'release'), safeError);
});
test('same UTC day includes last microsecond and preserves UTC precision instead of local date', async () => {
  const h = harness(), raw = receipt(h.c); raw.released_at = '2026-10-22T23:59:59.999999Z';
  h.respond(raw); assert.equal((await invoke(h, 'release')).released_at, raw.released_at);
});
const statusMutations = [
  ['receipt before release', r => { r.receipt = receipt(r.testContext); }],
  ['released without receipt', r => { r.released = true; r.can_release = false; }],
  ['not boolean release', r => { r.released = 'false'; }], ['not boolean maintenance', r => { r.maintenance = 1; }],
  ['not boolean can_release', r => { r.can_release = 'true'; }], ['blocked but allowed', r => { r.blockers = ['task_not_running']; }],
  ['unblocked but denied', r => { r.can_release = false; }], ['null hash without blocker', r => { r.verification_hash = null; }],
  ['not_verified with hash', r => { r.blockers = ['not_verified']; r.can_release = false; }],
  ['missing_cutoff with cutoff', r => { r.blockers = ['missing_cutoff']; r.can_release = false; }],
  ['wrong verification hash', r => { r.verification_hash = OTHER_HASH; }], ['maintenance false without mismatch', r => { r.maintenance = false; }],
  ['unknown blocker', r => { r.blockers = ['can_ignore']; r.can_release = false; }],
  ['out of order blockers', r => { r.blockers = ['maintenance_mismatch', 'task_not_running']; r.can_release = false; }],
  ['duplicate blockers', r => { r.blockers = ['task_not_running', 'task_not_running']; r.can_release = false; }],
  ['sparse blockers', r => { r.blockers = new Array(1); r.can_release = false; }],
];
for (const [label, mutate] of statusMutations) test(`status rejects ${label}`, async () => {
  const h = harness(), raw = status(h.c); raw.testContext = h.c; mutate(raw); delete raw.testContext;
  h.respond(raw); await assert.rejects(h.session.status(), safeError);
});
test('all 24 logically possible ordered blocker subsets are read-only, including expired cutoff', async () => {
  let cases = 0;
  for (let bits = 0; bits < 32; bits++) {
    const reasons = BLOCKERS.filter((_, index) => bits & (1 << index));
    if (reasons.includes('missing_cutoff') && reasons.includes('cutoff_expired')) continue;
    const h = harness(context({ cutoff: reasons.includes('missing_cutoff') ? null : cutoff() }));
    const raw = status(h.c, { verification_hash: reasons.includes('not_verified') ? null : HASH,
      blockers: reasons, can_release: reasons.length === 0, maintenance: !reasons.includes('maintenance_mismatch') });
    h.respond(raw); assert.deepEqual(await h.session.status(), raw); assert.deepEqual(h.calls.map(c => c.name), [STATUS]); cases++;
  }
  assert.equal(cases, 24);
});
test('null context cutoff accepts only missing-cutoff status, never release or a substituted bound cutoff', async () => {
  const h = harness(context({ cutoff: null })); await reconcile(h);
  await assert.rejects(invoke(h, 'release'), safeError);
  for (const raw of [status(h.c, { blockers: [], can_release: true }),
    status(h.c, { blockers: ['missing_cutoff', 'cutoff_expired'], can_release: false }),
    status(h.c, { cutoff: cutoff(), blockers: [], can_release: true })]) {
    h.respond(raw); await assert.rejects(h.session.status(), safeError);
  }
});
for (const maintenance of [false, true]) test(`historical release receipt remains readable with current maintenance=${maintenance}, never re-releases`, async () => {
  const h = harness(), raw = historical(h.c, maintenance); h.respond(raw);
  const result = await h.session.status(); assert.deepEqual(result, raw); frozen(result);
  await writesBlocked(h); const other = api.createSiteReleaseSession(h.c); await writesBlocked(h, other);
  const regressed = status(h.c); h.respond(regressed); await assert.rejects(other.status(), safeError);
  const drifted = historical(h.c); drifted.receipt.counts.active_admins++;
  h.respond(drifted); await assert.rejects(h.session.status(), safeError);
  await reconcile(h, historical(h.c, !maintenance));
});
test('released status rejects blockers/can_release/non-matching saved verification and historical receipt fields', async () => {
  for (const mutate of [r => { r.can_release = true; }, r => { r.blockers = ['cutoff_expired']; },
    r => { r.verification_hash = null; }, r => { r.receipt.full_site_complete = true; }, r => { r.receipt.extra = true; }]) {
    const h = harness(), raw = historical(h.c); mutate(raw); h.respond(raw); await assert.rejects(h.session.status(), safeError);
  }
});
test('object and blocker descriptor checks reject getters/inheritance/symbols/hidden fields without invoking getters', async () => {
  let reads = 0;
  for (const locate of [r => [r, 'scope'], r => [r.cutoff, 'cutoff_hash'], r => [r.receipt, 'success'],
    r => [r.receipt.counts, 'employees'], r => [r.blockers, '0']]) {
    const h = harness(), raw = historical(h.c); raw.blockers = ['task_not_running'];
    const [target, key] = locate(raw); Object.defineProperty(target, key, { enumerable: true, get() { reads++; throw Error(PASSWORD); } });
    h.respond(raw); await assert.rejects(h.session.status(), safeError);
  }
  assert.equal(reads, 0);
  for (const mutate of [r => Object.setPrototypeOf(r, { success: true }), r => { r[Symbol('extra')] = true; },
    r => Object.defineProperty(r, 'success', { value: true, enumerable: false }),
    r => { r.blockers.extra = true; }, r => { r.blockers[Symbol.iterator] = () => { throw Error(PASSWORD); }; },
    r => Object.setPrototypeOf(r.blockers, null)]) {
    const h = harness(), raw = status(h.c); mutate(raw); h.respond(raw); await assert.rejects(h.session.status(), safeError);
  }
});
test('context accessors and cutoff accessors are rejected before their getters execute', () => {
  const h = harness(); let reads = 0;
  for (const key of ['jobToken', 'cutoff']) {
    const c = context(); Object.defineProperty(c, key, { enumerable: true, get() { reads++; throw Error(PASSWORD); } });
    assert.throws(() => api.createSiteReleaseSession(c), safeError);
  }
  assert.equal(reads, 0); assert.equal(h.authReads, 0);
});
test('same job cannot be relabeled with another source/package or rebind a different valid cutoff', async () => {
  const h = harness(); h.respond(binding(h.c)); await invoke(h, 'bind'); const calls = h.calls.length;
  for (const patch of [{ sourceSiteId: id(500), cutoff: cutoff({ site_id: id(500) }) }, { packageId: id(501) }, { cutoff: cutoff({ cutoff_id: id(502) }) }]) {
    assert.throws(() => api.createSiteReleaseSession({ ...h.c, ...patch }), safeError);
    const c = { ...h.c, ...patch }; await assert.rejects(api.bindSiteReleaseCutoff(c.jobToken, c.jobId, c.sourceSiteId, c.packageId, c.cutoff), safeError);
  }
  assert.equal(h.calls.length, calls);
  const missing = api.createSiteReleaseSession({ ...h.c, cutoff: null });
  h.respond(status({ ...h.c, cutoff: null })); await assert.rejects(missing.status(), safeError);
});
for (const op of ['bind', 'release']) test(`${op}: lost response blocks writes across sessions until a fresh matching explicit status`, async () => {
  const h = harness(); h.replies.push({ reject: Error(PRIVATE) }); await assert.rejects(invoke(h, op), safeError);
  const second = api.createSiteReleaseSession(h.c); await writesBlocked(h, second); await turn(); assert.equal(h.calls.length, 1);
  const wrong = status(h.c); wrong.package_id = id(99);
  for (const reply of [{ error: { message: PASSWORD } }, { reject: Error(PRIVATE) }, { data: wrong }]) {
    h.replies.push(reply); await assert.rejects(second.status(), safeError); await writesBlocked(h, second);
  }
  const c = new AbortController(); c.abort(); await assert.rejects(second.status(c.signal), aborted); await writesBlocked(h, second);
  await reconcile(h, status(h.c), second);
  h.respond(validReply(h, op)); assert.deepEqual(await invoke(h, op, undefined, second), validReply(h, op));
});
for (const committed of [false, true]) test(`unknown release reconciles committed=${committed} without automatic re-send`, async () => {
  const h = harness(); h.replies.push({ reject: Error(PRIVATE) }); await assert.rejects(invoke(h, 'release'), safeError);
  await writesBlocked(h); await reconcile(h, committed ? historical(h.c, true) : status(h.c));
  assert.deepEqual(h.calls.map(c => c.name), [RELEASE, STATUS]);
  if (committed) await writesBlocked(h);
  else { h.respond(receipt(h.c)); await invoke(h, 'release'); assert.equal(h.calls.length, 3); }
});
test('unknown bind can be explicitly proven unbound using null context, but does not retry itself', async () => {
  const h = harness(); h.replies.push({ reject: Error(PRIVATE) }); await assert.rejects(invoke(h, 'bind'), safeError);
  const missing = { ...h.c, cutoff: null }, readonly = api.createSiteReleaseSession(missing);
  await reconcile(h, status(missing), readonly); assert.deepEqual(h.calls.map(c => c.name), [BIND, STATUS]);
  h.respond(binding(h.c)); await invoke(h, 'bind'); assert.equal(h.calls.length, 3);
});
for (const op of ['bind', 'release']) for (const settlement of ['resolve', 'reject']) test(`${op}: Abort preserves mutex until signal-ignoring underlying ${settlement} settles`, async () => {
  const h = harness(), gate = deferred(), controller = new AbortController(); h.replies.push({ wait: gate.promise });
  const pending = invoke(h, op, controller.signal), observed = pending.then(value => ({ value }), error => ({ error }));
  await turn(); controller.abort(PASSWORD); const result = await observed; assert.ok(result.error); assert.equal(aborted(result.error), true);
  const second = api.createSiteReleaseSession(h.c);
  try {
    await writesBlocked(h, second); await assert.rejects(second.status(), safeError);
    assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].signals, [controller.signal]);
  } finally {
    if (settlement === 'resolve') gate.resolve({ data: validReply(h, op), error: null }); else gate.reject(Error(PRIVATE));
    await turn();
  }
  await writesBlocked(h); await reconcile(h); assert.equal(h.calls.length, 2);
});
for (const op of ['bind', 'release']) test(`${op}: abortSignal attachment failure also tracks the actual request before unlock`, async () => {
  const h = harness(), gate = deferred(); h.replies.push({ wait: gate.promise, signalThrow: true });
  await assert.rejects(invoke(h, op, new AbortController().signal), safeError);
  try { await writesBlocked(h); await assert.rejects(h.session.status(), safeError); }
  finally { gate.resolve({ data: validReply(h, op), error: null }); await turn(); }
  await writesBlocked(h); await reconcile(h);
});
for (const op of ['bind', 'release']) test(`${op}: active request locks the same job across sessions, not unrelated jobs`, async () => {
  const h = harness(), gate = deferred(); h.replies.push({ wait: gate.promise }); const pending = invoke(h, op); await turn();
  try {
    const second = api.createSiteReleaseSession(h.c); await writesBlocked(h, second); await assert.rejects(second.status(), safeError);
    const unrelated = context(), other = api.createSiteReleaseSession(unrelated); h.respond(receipt(unrelated));
    await other.release(PASSWORD, CONFIRM); assert.equal(h.calls.length, 2);
  } finally { gate.resolve({ data: validReply(h, op), error: null }); await pending; }
});
for (const op of ['bind', 'release']) for (const outcome of ['lost', 'success']) for (const when of ['during-write', 'after-write']) {
  test(`${op}: status started before ${outcome} write returning ${when} cannot clear pending/writeGeneration`, async () => {
    const h = harness(), readGate = deferred(), writeGate = deferred(), old = status(h.c);
    h.replies.push({ wait: readGate.promise });
    const read = h.session.status().then(value => ({ value }), error => ({ error })); await turn();
    h.replies.push({ wait: writeGate.promise });
    const write = invoke(h, op).then(value => ({ value }), error => ({ error })); await turn();
    try {
      if (when === 'during-write') { readGate.resolve({ data: old, error: null }); assert.ok((await read).error); await writesBlocked(h); }
      if (outcome === 'lost') writeGate.reject(Error(PRIVATE)); else writeGate.resolve({ data: validReply(h, op), error: null });
      const written = await write; assert.equal(Boolean(written.error), outcome === 'lost');
      if (when === 'after-write') { readGate.resolve({ data: old, error: null }); assert.ok((await read).error); }
      assert.equal(h.calls.length, 2, 'no implicit status/verification/retry');
      if (outcome === 'lost') { await writesBlocked(h); await reconcile(h); }
      else if (op === 'release') { await writesBlocked(h); await reconcile(h, historical(h.c)); }
      else { h.respond(receipt(h.c)); await invoke(h, 'release'); }
    } finally { readGate.resolve({ data: old, error: null }); writeGate.resolve({ data: validReply(h, op), error: null }); await Promise.all([read, write]); }
  });
}
for (const op of ['bind', 'release']) test(`${op}: aborted reconciliation and late valid status cannot clear unknown writes`, async () => {
  const h = harness(); h.replies.push({ reject: Error(PRIVATE) }); await assert.rejects(invoke(h, op), safeError);
  const gate = deferred(), controller = new AbortController(); h.replies.push({ wait: gate.promise });
  const pending = h.session.status(controller.signal), observed = pending.then(value => ({ value }), error => ({ error }));
  await turn(); controller.abort(PASSWORD); assert.equal(aborted((await observed).error), true);
  gate.resolve({ data: status(h.c), error: null }); await turn(); await writesBlocked(h); await reconcile(h);
});
test('status is saved status only, not a physical verification or an authorization to auto-release', async () => {
  const h = harness(); await reconcile(h); await turn();
  assert.deepEqual(h.calls.map(c => c.name), [STATUS]); assert.equal(h.calls[0].args.p_job_token, undefined);
  h.respond({ ...receipt(h.c), success: false }); await assert.rejects(invoke(h, 'release'), safeError);
  await writesBlocked(h); assert.deepEqual(h.calls.map(c => c.name), [STATUS, RELEASE]);
});

test('real transport: exact three RPCs use 120s, no POST retry/XHR for errors/timeouts/Abort; lookalikes stay 8s', async t => {
  const compiledTransport = await build({ entryPoints: [root + 'src/lib/supabase.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://release.local.invalid'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('synthetic-local-key') },
    plugins: [{ name: 'capture-real-release-transport', setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'sdk', namespace: 'release-transport' }));
      b.onLoad({ filter: /.*/, namespace: 'release-transport' }, () => ({ contents: 'export const createClient=(url,key,options)=>({testUrl:url,testFetch:options.global.fetch});' }));
    } }],
  });
  const paths = Object.keys(compiledTransport.metafile.inputs); assert.ok(paths.some(p => p.endsWith('src/lib/supabase.ts')));
  assert.equal(paths.some(p => p.includes('node_modules')), false);
  let expectedInput, mode, expectedTimeout, calls, xhrCalls = 0, serial = 0, nativeSignal;
  const timers = [], cleared = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    calls++; assert.equal(input, expectedInput);
    assert.equal(new URL(input instanceof Request ? input.url : input.toString()).origin, 'https://release.local.invalid');
    assert.equal(init?.method || (input instanceof Request ? input.method : 'GET'), 'POST'); nativeSignal = init.signal;
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (mode === 'timeout' || mode === 'abort') return new Promise((_, reject) => {
      nativeSignal.addEventListener('abort', () => reject(nativeSignal.reason), { once: true });
      if (mode === 'timeout') queueMicrotask(timers[0].callback);
    });
    return new Response('{}', { status: mode });
  });
  const transport = await import(`data:text/javascript;base64,${Buffer.from(compiledTransport.outputFiles[0].text).toString('base64')}`);
  assert.equal(transport.supabase.testUrl, 'https://release.local.invalid');
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, expectedTimeout, 'no retry-delay timer'); const timer = { id: ++serial, callback, delay }; timers.push(timer); return timer.id;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { cleared.push(timer); });
  const originalXhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: function () { xhrCalls++; throw Error('XHR replay forbidden'); } });
  t.after(() => { if (originalXhr) Object.defineProperty(globalThis, 'XMLHttpRequest', originalXhr); else delete globalThis.XMLHttpRequest; });
  const run = async (name, form, failure, timeout) => {
    mode = failure; expectedTimeout = timeout; calls = 0; timers.length = 0; cleared.length = 0;
    const controller = new AbortController(), url = `https://release.local.invalid/rest/v1/rpc/${name}`;
    const init = { method: 'POST', body: '{}', signal: controller.signal };
    expectedInput = form === 'Request' ? new Request(url, init) : form === 'URL' ? new URL(url) : url;
    const pending = transport.supabase.testFetch(expectedInput, form === 'Request' ? undefined : init);
    if (mode === 'abort') controller.abort(PASSWORD);
    if (typeof mode === 'number') assert.equal((await pending).status, mode);
    else await assert.rejects(pending, error => safeError(error) && error.name === ({ network: 'SupabaseNetworkError', timeout: 'SupabaseTimeoutError', abort: 'AbortError' })[mode]);
    assert.equal(calls, 1); assert.equal(xhrCalls, 0); assert.deepEqual(timers.map(timer => timer.delay), [timeout]);
    assert.deepEqual(cleared, [timers[0].id]); assert.equal(nativeSignal.aborted, mode === 'timeout' || mode === 'abort');
  };
  let exact = 0, lookalikes = 0;
  for (const name of [BIND, STATUS, RELEASE]) for (const form of ['string', 'URL', 'Request']) for (const fault of [200, 401, 403, 408, 425, 429, 500, 502, 503, 504, 'network', 'timeout', 'abort']) {
    await run(name, form, fault, 120000); exact++;
  }
  for (const name of [BIND, STATUS, RELEASE]) for (const lookalike of [`prefix_${name}`, `${name}_suffix`, name.toUpperCase()]) for (const form of ['string', 'URL', 'Request']) {
    await run(lookalike, form, 200, 8000); lookalikes++;
  }
  assert.equal(exact, 117); assert.equal(lookalikes, 27); assert.equal(externalCalls, 0);
  t.diagnostic(`transport combinations ${exact} exact + ${lookalikes} lookalikes; fetch mocked, external/XHR 0`);
});
