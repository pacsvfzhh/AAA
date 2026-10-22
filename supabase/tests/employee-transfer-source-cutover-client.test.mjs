import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// LOCAL ONLY. Real sourceCutover/validators/transport; auth, SDK and network are isolated.
const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `b9000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SITE = id(1), CUTOFF = id(2), AUTH = id(3), PASSWORD = 'local-cutover-password-CANARY';
const FREEZE = '確認暫停舊站業務並導出', RESUME = '確認恢復舊站業務並放棄切站';
const STATUS_RPC = 'get_employee_export_cutover_status', FREEZE_RPC = 'employee_export_cutover_freeze', RESUME_RPC = 'employee_export_cutover_resume';
const COUNT_KEYS = ['pending_automation', 'failed_automation', 'processing_orders'];
const BLOCKERS = [...COUNT_KEYS, 'transfer_running', 'other_maintenance'];
const TIME = '2026-10-22T20:13:14.123456Z';
const cutoff = () => ({ version: 1, policy: 'drained-queue-v1', site_id: SITE, cutoff_id: CUTOFF, frozen_at: TIME, cutoff_hash: 'a'.repeat(64) });
const status = (frozen = false) => ({ version: 1, success: true, scope: 'source-cutover', site_id: SITE, frozen,
  cutoff: frozen ? cutoff() : null, blockers: [], counts: Object.fromEntries(COUNT_KEYS.map(key => [key, 0])), full_site_complete: false });
const turn = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let externalCalls = 0;
mock.method(globalThis, 'fetch', () => { externalCalls++; assert.fail('No real network or production services allowed'); });
after(() => { assert.equal(externalCalls, 0); mock.restoreAll(); });
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/sourceCutover.ts';export{setHarness}from'cutover-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
  plugins: [{ name: 'source-cutover-auth-rpc-boundaries', setup(b) {
    b.onResolve({ filter: /^(?:cutover-test:state|\.\.\/(?:auth|supabase))$/ }, a => ({ path: a.path, namespace: 'cutover-test' }));
    b.onLoad({ filter: /.*/, namespace: 'cutover-test' }, ({ path }) => ({ contents: path === 'cutover-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth'
        ? 'import{current}from"cutover-test:state";export function getAdminFinancialSessionToken(){const h=current();h.authReads++;if(h.authError)throw h.authError;return h.auth;}'
        : 'import{current}from"cutover-test:state";export const supabase={rpc:(...a)=>current().rpc(...a)};' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function safeError(error) {
  assert.ok(error instanceof Error);
  for (const secret of [PASSWORD, AUTH, 'PRIVATE-BACKEND-ERROR']) assert.equal(String(error).includes(secret), false);
  for (const key of ['cause', 'details', 'hint']) assert.equal(key in error, false);
  return true;
}
const aborted = error => safeError(error) && error.name === 'AbortError';
function harness() {
  const h = { calls: [], replies: [], auth: AUTH, authReads: 0, authError: null,
    respond(data) { h.replies.push({ data }); },
    rpc(name, args) {
      assert.ok([STATUS_RPC, FREEZE_RPC, RESUME_RPC].includes(name), `unexpected RPC ${name}`);
      assert.ok(h.replies.length, `unscripted RPC ${name}`);
      const reply = h.replies.shift(), call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
      if (reply.throw) throw reply.throw;
      const q = { abortSignal(signal) { call.signals.push(signal); return q; },
        then(resolve, reject) { return Promise.resolve().then(() => {
          if (reply.reject) throw reply.reject;
          return reply.wait ?? { data: reply.data, error: reply.error ?? null };
        }).then(resolve, reject); } };
      return q;
    } };
  api.setHarness(h); return h;
}
const invoke = (op, signal) => op === 'status' ? api.getSourceCutoverStatus(signal)
  : op === 'freeze' ? api.freezeSourceCutover(PASSWORD, FREEZE, signal)
    : api.resumeSourceCutover(PASSWORD, RESUME, CUTOFF, signal);
const validReply = op => status(op === 'freeze');

test('isolated bundle uses real sourceCutover and dispatch checks with no SDK/auth/network implementation', () => {
  const inputs = Object.keys(compiled.metafile.inputs);
  assert.ok(inputs.some(p => p.endsWith('/sourceCutover.ts')));
  assert.ok(inputs.some(p => p.endsWith('/dispatchTransfer.ts')));
  assert.equal(inputs.some(p => /node_modules|src\/lib\/(?:supabase|auth)\.ts/.test(p)), false);
  assert.deepEqual(Object.keys(api).sort(), ['freezeSourceCutover', 'getSourceCutoverStatus', 'resumeSourceCutover', 'setHarness', 'validateSourceCutoff']);
});
for (const op of ['status', 'freeze', 'resume']) test(`${op}: exact RPC name, current admin session, exact parameters and AbortSignal`, async () => {
  const h = harness(), signal = new AbortController().signal;
  h.auth = id(20); h.respond(validReply(op)); assert.deepEqual(await invoke(op, signal), validReply(op));
  const args = { p_admin_session_token: id(20), ...(op === 'status' ? {} : { p_admin_password: PASSWORD, p_confirmation: op === 'freeze' ? FREEZE : RESUME }),
    ...(op === 'resume' ? { p_cutoff_id: CUTOFF } : {}) };
  assert.deepEqual(h.calls, [{ name: op === 'status' ? STATUS_RPC : op === 'freeze' ? FREEZE_RPC : RESUME_RPC, args, signals: [signal] }]);
  h.auth = id(21); h.respond(validReply(op)); await invoke(op); assert.equal(h.calls[1].args.p_admin_session_token, id(21));
  assert.deepEqual(h.calls[1].signals, []); assert.equal(h.authReads, 2);
});
for (const op of ['freeze', 'resume']) test(`${op}: wrong confirmation and empty password are rejected before auth or RPC`, async () => {
  const h = harness(), text = op === 'freeze' ? FREEZE : RESUME;
  for (const confirmation of ['', 'wrong', ' ' + text, text + ' ', text + '\n', op === 'freeze' ? RESUME : FREEZE]) {
    await assert.rejects(op === 'freeze' ? api.freezeSourceCutover(PASSWORD, confirmation) : api.resumeSourceCutover(PASSWORD, confirmation, CUTOFF), safeError);
  }
  await assert.rejects(op === 'freeze' ? api.freezeSourceCutover('', text) : api.resumeSourceCutover('', text, CUTOFF), safeError);
  assert.equal(h.authReads, 0); assert.deepEqual(h.calls, []);
});
test('resume: invalid cutoff UUID is rejected before auth/RPC', async () => {
  const h = harness();
  for (const value of ['', null, 42, 'not-a-uuid', id(0xab).toUpperCase()]) await assert.rejects(api.resumeSourceCutover(PASSWORD, RESUME, value), safeError);
  assert.equal(h.authReads, 0); assert.equal(h.calls.length, 0);
});
for (const op of ['status', 'freeze', 'resume']) test(`${op}: pre-abort has no request and does not poison subsequent operations`, async () => {
  const h = harness(), c = new AbortController(); c.abort(PASSWORD);
  await assert.rejects(invoke(op, c.signal), aborted); assert.equal(h.authReads, 0); assert.equal(h.calls.length, 0);
  h.respond(validReply(op)); await invoke(op); assert.equal(h.calls.length, 1);
});
for (const op of ['status', 'freeze', 'resume']) for (const fault of ['rpc-error', 'reject', 'synchronous-throw', 'auth']) {
  test(`${op}: ${fault} is redacted and never retried or rolled back`, async () => {
    const h = harness(), secret = Error(`${PASSWORD} ${AUTH} PRIVATE-BACKEND-ERROR`);
    if (fault === 'auth') h.authError = secret;
    else h.replies.push(fault === 'rpc-error' ? { error: { message: secret.message, details: PASSWORD } }
      : fault === 'reject' ? { reject: secret } : { throw: secret });
    await assert.rejects(invoke(op), safeError); await turn();
    assert.equal(h.authReads, 1); assert.equal(h.calls.length, fault === 'auth' ? 0 : 1); assert.equal(h.replies.length, 0);
  });
}
const receiptMutations = [
  ['missing version', r => { delete r.version; }], ['extra authorization', r => { r.can_release = true; }],
  ['wrong version', r => { r.version = 2; }], ['failed success flag', r => { r.success = false; }],
  ['wrong scope', r => { r.scope = 'site-restore-verification'; }], ['forged complete', r => { r.full_site_complete = true; }],
  ['invalid site UUID', r => { r.site_id = 'not-a-uuid'; }], ['string frozen flag', r => { r.frozen = 'true'; }],
  ['frozen without cutoff', r => { r.cutoff = null; }], ['unfrozen with cutoff', r => { r.frozen = false; }],
  ['cutoff bound to other site', r => { r.cutoff.site_id = id(99); }], ['wrong cutoff policy', r => { r.cutoff.policy = 'allow-pending'; }],
  ['extra cutoff field', r => { r.cutoff.can_resume = true; }], ['invalid cutoff id', r => { r.cutoff.cutoff_id = 'forged'; }],
  ['invalid cutoff hash', r => { r.cutoff.cutoff_hash = 'z'.repeat(64); }], ['missing counts', r => { delete r.counts; }],
  ['extra count', r => { r.counts.other = 0; }], ['missing count', r => { delete r.counts.pending_automation; }],
  ['unknown blocker', r => { r.blockers = ['can_ignore']; }], ['duplicate blocker', r => { r.blockers = ['other_maintenance', 'other_maintenance']; }],
  ['too many blockers', r => { r.blockers = Array(6).fill('other_maintenance'); }], ['sparse blockers', r => { r.blockers = new Array(1); }],
];
for (const [label, mutate] of receiptMutations) test(`status rejects malformed/misbound receipt: ${label}`, async () => {
  const h = harness(), raw = status(true); mutate(raw); h.respond(raw); await assert.rejects(api.getSourceCutoverStatus(), safeError);
  assert.equal(h.calls.length, 1);
});
test('status/cutoff/count object getters, inherited fields and hidden/symbol fields cannot forge a receipt', async () => {
  let reads = 0;
  for (const locate of [r => [r, 'scope'], r => [r.counts, 'pending_automation'], r => [r.cutoff, 'cutoff_hash']]) {
    const h = harness(), raw = status(true), [target, key] = locate(raw);
    Object.defineProperty(target, key, { enumerable: true, get() { reads++; throw Error(PASSWORD); } });
    h.respond(raw); await assert.rejects(api.getSourceCutoverStatus(), safeError);
  }
  assert.equal(reads, 0);
  for (const mutate of [r => Object.setPrototypeOf(r, { success: true }), r => { r[Symbol('authority')] = true; },
    r => Object.defineProperty(r, 'success', { value: true, enumerable: false })]) {
    const h = harness(), raw = status(); mutate(raw); h.respond(raw); await assert.rejects(api.getSourceCutoverStatus(), safeError);
  }
});
for (const key of COUNT_KEYS) {
  test(`${key}: exact positive-count/blocker equivalence, frozen zero and safe integer bounds`, async () => {
    for (const value of [1, 9007199254740991]) {
      const h = harness(), raw = status(); raw.counts[key] = value; raw.blockers = [key]; h.respond(raw);
      assert.deepEqual(await api.getSourceCutoverStatus(), raw);
    }
    for (const [value, blockers, frozen] of [[1, [], false], [0, [key], false], [1, [key], true],
      [-1, [], false], [0.5, [key], false], ['1', [key], false], [null, [], false], [NaN, [], false], [Infinity, [key], false], [9007199254740992, [key], false]]) {
      const h = harness(), raw = status(frozen); raw.counts[key] = value; raw.blockers = blockers; h.respond(raw);
      await assert.rejects(api.getSourceCutoverStatus(), safeError);
    }
  });
}
test('all 32 blocker subsets are accepted only with matching three counters; technical blockers remain distinct', async () => {
  for (let bits = 0; bits < 32; bits++) {
    const h = harness(), raw = status(); raw.blockers = BLOCKERS.filter((_, i) => bits & (1 << i));
    for (const key of COUNT_KEYS) raw.counts[key] = raw.blockers.includes(key) ? 3 : 0;
    h.respond(raw); assert.deepEqual(await api.getSourceCutoverStatus(), raw);
  }
});
test('cutoff requires exact six-digit UTC format, finite timestamp and fixed policy/identity/hash', () => {
  assert.deepEqual(api.validateSourceCutoff(cutoff()), cutoff());
  for (const frozen_at of ['2026-10-22T20:13:14Z', '2026-10-22T20:13:14.123Z', '2026-10-22T20:13:14.1234567Z',
    '2026-10-22T20:13:14.123456+00:00', '2026-10-23T04:13:14.123456+08:00', '2026-10-22 20:13:14.123456Z',
    '2026-13-22T20:13:14.123456Z', '2026-10-22T99:13:14.123456Z', '', null, 42]) {
    assert.throws(() => api.validateSourceCutoff({ ...cutoff(), frozen_at }), safeError);
  }
});
// These are intentionally ordinary assertions, not TODO/skip/expected-failure tests.
// Implementation gaps must stay visible until a separately authorized implementation fix.
test('cutoff UTC format rejects a trailing newline rather than accepting a non-exact timestamp', () => {
  assert.throws(() => api.validateSourceCutoff({ ...cutoff(), frozen_at: TIME + '\n' }), safeError);
});
test('freeze refuses an otherwise valid unfrozen receipt instead of reporting an unconfirmed freeze as success', async () => {
  const h = harness(); h.respond(status(false)); await assert.rejects(api.freezeSourceCutover(PASSWORD, FREEZE), safeError);
});
test('resume refuses a still-frozen receipt', async () => {
  const h = harness(); h.respond(status(true)); await assert.rejects(api.resumeSourceCutover(PASSWORD, RESUME, CUTOFF), safeError);
});
for (const op of ['freeze', 'resume']) for (const settlement of ['resolve', 'reject']) {
  test(`${op}: cancel with signal-ignoring ${settlement} retains write mutex until underlying request settles`, async () => {
    const h = harness(), gate = deferred(), c = new AbortController(); h.replies.push({ wait: gate.promise });
    const pending = invoke(op, c.signal), observed = pending.then(value => ({ value }), error => ({ error }));
    try {
      await turn(); c.abort(PASSWORD); await turn();
      assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0].signals, [c.signal]);
      for (const next of ['status', 'freeze', 'resume']) await assert.rejects(invoke(next), safeError);
      assert.equal(h.calls.length, 1); assert.equal(h.authReads, 1);
    } finally {
      if (settlement === 'resolve') gate.resolve({ data: validReply(op), error: null }); else gate.reject(Error(PASSWORD));
      await observed;
    }
    const result = await observed; assert.ok(result.error); assert.equal(aborted(result.error), true);
    h.respond(status()); await api.getSourceCutoverStatus(); assert.equal(h.calls.length, 2);
  });
}
for (const op of ['freeze', 'resume']) test(`${op}: non-cancelled write blocks concurrent status and both writes locally`, async () => {
  const h = harness(), gate = deferred(); h.replies.push({ wait: gate.promise }); const pending = invoke(op); await turn();
  try {
    for (const next of ['status', 'freeze', 'resume']) await assert.rejects(invoke(next), safeError);
    assert.equal(h.calls.length, 1); assert.equal(h.authReads, 1);
  } finally { gate.resolve({ data: validReply(op), error: null }); await pending; }
});

test('real supabase transport: exact cutover RPC 120s list, POST failure/abort single attempt and lookalikes 8s', async t => {
  const output = await build({ entryPoints: [root + 'src/lib/supabase.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://cutover.local.invalid'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('local-synthetic-key') },
    plugins: [{ name: 'capture-real-fetch-policy', setup(b) {
      b.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'sdk', namespace: 'cutover-transport' }));
      b.onLoad({ filter: /.*/, namespace: 'cutover-transport' }, () => ({ contents: 'export const createClient=(url,key,options)=>({testUrl:url,testFetch:options.global.fetch});' }));
    } }],
  });
  assert.ok(Object.keys(output.metafile.inputs).some(p => p.endsWith('src/lib/supabase.ts')));
  assert.equal(Object.keys(output.metafile.inputs).some(p => p.includes('node_modules')), false);
  let expectedInput, mode, expectedTimeout, calls, xhrCalls = 0, sequence = 0, nativeSignal;
  const timers = [], cleared = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    calls++; assert.equal(input, expectedInput);
    assert.equal(new URL(input instanceof Request ? input.url : input.toString()).origin, 'https://cutover.local.invalid');
    assert.equal(init?.method || (input instanceof Request ? input.method : 'GET'), 'POST'); nativeSignal = init.signal;
    if (mode === 'network') throw new TypeError('Failed to fetch');
    if (mode === 'timeout' || mode === 'abort') return new Promise((_, reject) => {
      nativeSignal.addEventListener('abort', () => reject(nativeSignal.reason), { once: true });
      if (mode === 'timeout') queueMicrotask(timers[0].callback);
    });
    return new Response('{}', { status: typeof mode === 'number' ? mode : 200 });
  });
  const transport = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  assert.equal(transport.supabase.testUrl, 'https://cutover.local.invalid');
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, expectedTimeout, 'no retry-delay timer is allowed'); const timer = { id: ++sequence, callback, delay }; timers.push(timer); return timer.id;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { cleared.push(timer); });
  const originalXhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: function () { xhrCalls++; throw Error('XHR replay forbidden'); } });
  t.after(() => { if (originalXhr) Object.defineProperty(globalThis, 'XMLHttpRequest', originalXhr); else delete globalThis.XMLHttpRequest; });
  const names = [STATUS_RPC, FREEZE_RPC, RESUME_RPC], forms = ['string', 'URL', 'Request'];
  let exactCases = 0, lookalikes = 0;
  const run = async (name, form, failure, timeout) => {
    mode = failure; expectedTimeout = timeout; calls = 0; timers.length = 0; cleared.length = 0;
    const controller = new AbortController(), url = `https://cutover.local.invalid/rest/v1/rpc/${name}`;
    const init = { method: 'POST', body: '{}', signal: controller.signal };
    expectedInput = form === 'Request' ? new Request(url, init) : form === 'URL' ? new URL(url) : url;
    const pending = transport.supabase.testFetch(expectedInput, form === 'Request' ? undefined : init);
    if (mode === 'abort') controller.abort(PASSWORD);
    if (typeof mode === 'number') assert.equal((await pending).status, mode);
    else await assert.rejects(pending, error => safeError(error) && error.name === ({ network: 'SupabaseNetworkError', timeout: 'SupabaseTimeoutError', abort: 'AbortError' })[mode]);
    assert.equal(calls, 1, `${name}/${form}/${failure}: only one POST`); assert.equal(xhrCalls, 0);
    assert.deepEqual(timers.map(timer => timer.delay), [timeout]); assert.deepEqual(cleared, [timers[0].id]);
    assert.equal(nativeSignal.aborted, mode === 'timeout' || mode === 'abort');
    assert.equal(controller.signal.aborted, mode === 'abort');
  };
  for (const name of names) for (const form of forms) for (const failure of [200, 408, 425, 429, 500, 502, 503, 504, 'network', 'timeout', 'abort']) {
    await run(name, form, failure, 120000); exactCases++;
  }
  for (const name of names) for (const lookalike of [`prefix_${name}`, `${name}_suffix`, name.toUpperCase()]) for (const form of forms) {
    await run(lookalike, form, 200, 8000); lookalikes++;
  }
  assert.equal(exactCases, 99); assert.equal(lookalikes, 27); assert.equal(externalCalls, 0);
  t.diagnostic(`real transport combinations: ${exactCases} exact + ${lookalikes} lookalikes; fetch fully mocked; XHR/external 0`);
});
