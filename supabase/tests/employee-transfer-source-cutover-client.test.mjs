import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { createHash } from 'node:crypto';
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
// Independent Node crypto oracle for the exact PostgreSQL jsonb::text ASCII preimage.
const pgCutoffText = r => `{"policy": "${r.policy}", "site_id": "${r.site_id}", "version": ${r.version}, "cutoff_id": "${r.cutoff_id}", "frozen_at": "${r.frozen_at}"}`;
const sha = text => createHash('sha256').update(text, 'ascii').digest('hex');
const cutoff = (overrides = {}) => {
  const r = { version: 1, policy: 'drained-queue-v1', site_id: SITE, cutoff_id: CUTOFF, frozen_at: TIME, ...overrides };
  return { ...r, cutoff_hash: sha(pgCutoffText(r)) };
};
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
async function reconcile(h, reply = status()) {
  const calls = h.calls.length;
  h.respond(reply);
  assert.deepEqual(await api.getSourceCutoverStatus(), reply);
  assert.equal(h.calls.length, calls + 1);
  assert.equal(h.calls.at(-1).name, STATUS_RPC, 'only a real, explicit valid status read restores the module gate');
}
async function writesBlocked(h) {
  const calls = h.calls.length, reads = h.authReads, replies = h.replies.length;
  await assert.rejects(invoke('freeze'), safeError);
  await assert.rejects(invoke('resume'), safeError);
  assert.equal(h.calls.length, calls, 'blocked writes must not reach the RPC boundary');
  assert.equal(h.authReads, reads, 'blocked writes must not read authentication');
  assert.equal(h.replies.length, replies);
}
// Fresh harnesses are NOT production state resets. Reconcile the real module before each test.
beforeEach(async () => { await reconcile(harness()); });

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
    assert.throws(() => api.validateSourceCutoff(cutoff({ frozen_at })), safeError);
  }
});
// Preserve all original negative assertions; no TODO/skip/expected-failure annotations.
test('cutoff UTC format rejects a trailing newline rather than accepting a non-exact timestamp', () => {
  assert.throws(() => api.validateSourceCutoff(cutoff({ frozen_at: TIME + '\n' })), safeError);
});
test('freeze refuses an otherwise valid unfrozen receipt instead of reporting an unconfirmed freeze as success', async () => {
  const h = harness(); h.respond(status(false)); await assert.rejects(api.freezeSourceCutover(PASSWORD, FREEZE), safeError);
  await writesBlocked(h);
});
test('resume refuses a still-frozen receipt', async () => {
  const h = harness(); h.respond(status(true)); await assert.rejects(api.resumeSourceCutover(PASSWORD, RESUME, CUTOFF), safeError);
  await writesBlocked(h);
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
    await writesBlocked(h);
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

test('cutoff hash matches a fixed independent Node SHA256 vector for the exact PG text, not JSON.stringify', () => {
  const expected = '39a5383553570cc1da868c2afc3ff3f6ef63cfaee4f1c8bfced3cc4b897a66ff';
  assert.equal(cutoff().cutoff_hash, expected);
  assert.deepEqual(api.validateSourceCutoff(cutoff()), cutoff());
  const { cutoff_hash, ...fields } = cutoff();
  assert.notEqual(sha(JSON.stringify(fields)), cutoff_hash, 'compact JSON is not the PG text preimage');
  assert.throws(() => api.validateSourceCutoff({ ...fields, cutoff_hash: sha(JSON.stringify(fields)) }), safeError);
  for (const overrides of [{ site_id: id(90) }, { cutoff_id: id(91) }, { frozen_at: '2026-10-23T00:00:00.000001Z' }]) {
    const raw = cutoff(overrides);
    assert.notEqual(raw.cutoff_hash, expected);
    assert.deepEqual(api.validateSourceCutoff(raw), raw, 'a correctly rebound independent PG digest is valid');
  }
});
const digestMutations = [
  ['well-formed incorrect hash', r => { r.cutoff_hash = 'f'.repeat(64); }],
  ['site UUID drift', r => { r.site_id = id(99); }],
  ['cutoff UUID drift', r => { r.cutoff_id = id(98); }],
  ['UTC microsecond drift', r => { r.frozen_at = '2026-10-22T20:13:14.123457Z'; }],
];
for (const [label, mutate] of digestMutations) test(`cutoff rejects valid-format ${label} with a stale/mismatched digest`, async () => {
  const raw = cutoff(); mutate(raw);
  assert.throws(() => api.validateSourceCutoff(raw), safeError);
  for (const op of ['status', 'freeze']) {
    const h = harness();
    await reconcile(h); h.calls.length = 0; h.authReads = 0;
    const reply = status(true); reply.cutoff = structuredClone(raw); reply.site_id = raw.site_id;
    h.respond(reply); await assert.rejects(invoke(op), safeError);
    assert.equal(h.calls.length, 1);
    if (op === 'freeze') await writesBlocked(h);
  }
});
test('a correctly hashed cutoff still cannot bind a status from another site', async () => {
  const h = harness(), reply = status(true); reply.cutoff = cutoff({ site_id: id(99) });
  assert.deepEqual(api.validateSourceCutoff(reply.cutoff), reply.cutoff, 'prove independent cutoff digest itself is valid');
  h.respond(reply); await assert.rejects(api.getSourceCutoverStatus(), safeError);
});
for (const op of ['freeze', 'resume']) test(`${op}: lost response locks both writes across harness changes until a validated explicit status read`, async () => {
  const h = harness(); h.replies.push({ reject: Error(PASSWORD + ' PRIVATE-BACKEND-ERROR') });
  await assert.rejects(invoke(op), safeError); await writesBlocked(h); await turn();
  assert.equal(h.calls.length, 1, 'no automatic retry/recovery read');
  // Replacing an auth/RPC harness does not reset production module state.
  const next = harness(); await writesBlocked(next);
  assert.deepEqual(api.validateSourceCutoff(cutoff()), cutoff()); await writesBlocked(next);
  const controller = new AbortController(); controller.abort(PASSWORD);
  await assert.rejects(api.getSourceCutoverStatus(controller.signal), aborted); await writesBlocked(next);
  const badHash = status(true); badHash.cutoff.cutoff_hash = 'a'.repeat(64);
  const drift = status(true); drift.cutoff.frozen_at = '2026-10-22T20:13:14.123457Z';
  for (const failedRead of [{ error: { message: PASSWORD } }, { reject: Error(PASSWORD) },
    { data: { ...status(), full_site_complete: true } }, { data: badHash }, { data: drift }]) {
    next.replies.push(failedRead); await assert.rejects(api.getSourceCutoverStatus(), safeError); await writesBlocked(next);
  }
  const gate = deferred(); next.replies.push({ wait: gate.promise });
  const reading = api.getSourceCutoverStatus(); await turn();
  try { await writesBlocked(next); }
  finally { gate.resolve({ data: status(true), error: null }); }
  assert.deepEqual(await reading, status(true));
  const reads = next.calls.length;
  next.respond(validReply(op)); assert.deepEqual(await invoke(op), validReply(op));
  assert.equal(next.calls.length, reads + 1);
  assert.equal(next.calls.at(-1).name, op === 'freeze' ? FREEZE_RPC : RESUME_RPC);
});
for (const op of ['freeze', 'resume']) test(`${op}: aborted status and its late valid response cannot unlock an unknown write`, async () => {
  const h = harness(); h.replies.push({ reject: Error(PASSWORD) }); await assert.rejects(invoke(op), safeError);
  const gate = deferred(), c = new AbortController(); h.replies.push({ wait: gate.promise });
  const pending = api.getSourceCutoverStatus(c.signal), observed = pending.then(value => ({ value }), error => ({ error }));
  await turn(); c.abort(PASSWORD);
  try { await writesBlocked(h); }
  finally { gate.resolve({ data: status(true), error: null }); await observed; }
  const result = await observed; assert.ok(result.error); assert.equal(aborted(result.error), true);
  await writesBlocked(h); await reconcile(h);
  h.respond(validReply(op)); await invoke(op);
});

for (const outcome of ['lost', 'success']) for (const returnAt of ['after-write', 'during-write']) {
  test(`interleaving: status starts first, freeze ${outcome}, valid false old status returns ${returnAt}`, async () => {
    const h = harness(), oldGate = deferred(), writeGate = deferred(), stale = status(false);
    let oldSettled = false, writeSettled = false;
    h.replies.push({ wait: oldGate.promise });
    const oldRead = api.getSourceCutoverStatus().then(value => { oldSettled = true; return { value }; }, error => { oldSettled = true; return { error }; });
    await turn();
    assert.deepEqual(h.calls.map(c => c.name), [STATUS_RPC]);
    assert.equal(oldSettled, false, 'the genuine status request must be pending before the write begins');
    h.replies.push({ wait: writeGate.promise });
    const writing = api.freezeSourceCutover(PASSWORD, FREEZE).then(value => { writeSettled = true; return { value }; }, error => { writeSettled = true; return { error }; });
    try {
      await turn();
      assert.deepEqual(h.calls.map(c => c.name), [STATUS_RPC, FREEZE_RPC]);
      assert.equal(oldSettled, false); assert.equal(writeSettled, false);
      if (returnAt === 'during-write') {
        oldGate.resolve({ data: stale, error: null });
        const old = await oldRead;
        assert.ok(old.error, 'a valid stale read must be rejected while a write is still active'); safeError(old.error);
        assert.equal(writeSettled, false, 'the stale read must finish before the underlying write settles');
        await writesBlocked(h);
        await assert.rejects(api.getSourceCutoverStatus(), safeError);
        assert.equal(h.calls.length, 2, 'active write also blocks a new status before RPC');
      }
      if (outcome === 'lost') writeGate.reject(Error(PASSWORD + ' PRIVATE-BACKEND-ERROR'));
      else writeGate.resolve({ data: status(true), error: null });
      const written = await writing;
      if (outcome === 'lost') { assert.ok(written.error); safeError(written.error); await writesBlocked(h); }
      else { assert.equal('error' in written, false); assert.deepEqual(written.value, status(true)); }
      if (returnAt === 'after-write') {
        assert.equal(oldSettled, false);
        oldGate.resolve({ data: stale, error: null });
        const old = await oldRead;
        assert.ok(old.error, 'old status must not be accepted after the write generation changes'); safeError(old.error);
      }
      await turn();
      assert.deepEqual(h.calls.map(c => c.name), [STATUS_RPC, FREEZE_RPC], 'neither operation is retried or reconciled automatically');
      assert.deepEqual(stale, status(false), 'the late server reply really is a well-formed unfrozen status, not a malformed rejection fixture');
      if (outcome === 'lost') {
        await writesBlocked(h); // The old read must not release uncertainWrite after the lost response.
        await reconcile(h, status(true));
      } else {
        assert.deepEqual(written.value, status(true), 'rejected stale reads do not replace the confirmed frozen result');
        // A rejected read must not poison an already confirmed successful write.
      }
      h.respond(status(false)); assert.deepEqual(await api.resumeSourceCutover(PASSWORD, RESUME, CUTOFF), status(false));
      assert.deepEqual(h.calls.map(c => c.name), [STATUS_RPC, FREEZE_RPC, ...(outcome === 'lost' ? [STATUS_RPC] : []), RESUME_RPC]);
      assert.equal(h.authReads, h.calls.length);
    } finally {
      oldGate.resolve({ data: stale, error: null }); writeGate.resolve({ data: status(true), error: null });
      await Promise.all([oldRead, writing]);
    }
  });
}

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
