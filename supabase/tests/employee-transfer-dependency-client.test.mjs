import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SESSION = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64), OTHER_HASH = 'b'.repeat(64);
const SECRET = 'never-echo-backend-diagnostics-or-abort-reason';
const KEYS = ['dispatch_group_members', 'used_order_data'];
const REASONS = ['target_members_not_empty', 'target_used_not_empty', 'unmapped_assigner'];
const RPC = {
  plan: 'get_employee_import_dispatch_dependency_plan', begin: 'employee_import_dispatch_dependency_begin',
  chunk: 'employee_import_dispatch_dependency_chunk', verify: 'employee_import_dispatch_dependency_verify',
};
const flags = () => ({ maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false });
const counts = (members = 1, used = 1) => ({ dispatch_group_members: members, used_order_data: used });
const plan = (totals = counts()) => ({ scope: 'dispatch-dependencies', can_restore: true, counts: totals,
  conflicts: [], plan_hash: HASH, ...flags() });
const receipt = (restored = counts(0, 0), next = counts(0, 0), verified = false) => ({
  success: true, scope: 'dispatch-dependencies', counts: restored, next_chunks: next, chunks: counts(), totals: counts(),
  verified, repeated: false, ...flags(),
});
const complete = () => receipt(counts(), counts(), true);
const advanced = key => {
  const r = receipt(); r.counts[key] = 1; r.next_chunks[key] = 1; return r;
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function soon(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('abort did not settle promptly')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}
mock.method(globalThis, 'fetch', () => { assert.fail('all real network/production access is forbidden'); });
const logs = ['log', 'info', 'warn', 'error', 'debug'].map(name => mock.method(console, name, () => {}));
after(() => { for (const log of logs) assert.equal(log.mock.callCount(), 0); mock.restoreAll(); });
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/dependencyApi.ts';
    export {setHarness} from 'dependency-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'dependency-transport-only', setup(builder) {
    builder.onResolve({ filter: /^(?:dependency-test:state|\.\.\/(?:auth|supabase))$/ }, args => {
      if (args.path.startsWith('..')) assert.equal(args.importer, `${root}src/lib/employeeTransfer/dependencyApi.ts`);
      return { path: args.path, namespace: 'dependency-test' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'dependency-test' }, ({ path }) => {
      if (path === 'dependency-test:state') return { contents: 'let h; export const setHarness=v=>{h=v;}; export const current=()=>h;' };
      if (path === '../auth') return { contents: `import {current} from 'dependency-test:state';
        export function getAdminFinancialSessionToken(){const h=current();h.reads++;if(h.authError)throw h.authError;return h.session;}` };
      return { contents: `import {current} from 'dependency-test:state'; export const supabase={rpc:(...args)=>current().rpc(...args)};` };
    });
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness() {
  const h = { calls: [], replies: [], reads: 0, session: SESSION,
    respond(data) { h.replies.push({ data }); },
    rpc(name, args) {
      const call = { name, args: structuredClone(args), signals: [] }; h.calls.push(call);
      assert.ok(h.replies.length, `unexpected or automatic RPC ${name}`);
      const result = h.replies.shift();
      if (result.throw) throw result.throw;
      const query = {
        abortSignal(signal) { call.signals.push(signal); if (result.signalThrow) throw result.signalThrow; return query; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (result.reject) throw result.reject;
            return result.wait ?? { data: result.data, error: result.error ?? null };
          }).then(resolve, reject);
        },
      };
      result.onCall?.();
      return query;
    },
  };
  api.setHarness(h); return h;
}
async function prepared(h, phase = 'begin', totals = counts()) {
  const s = api.createDispatchDependencySession(TOKEN);
  if (phase !== 'plan') { h.respond(plan(totals)); await s.plan(); }
  if (phase === 'chunk' || phase === 'verify') {
    h.respond({ ...receipt(), totals }); await s.begin(HASH);
  }
  return s;
}
const run = (s, phase, signal) => phase === 'plan' ? s.plan(signal) : phase === 'begin' ? s.begin(HASH, signal)
  : phase === 'chunk' ? s.chunk(KEYS[0], 0, signal) : s.verify(signal);
const good = phase => phase === 'plan' ? plan() : phase === 'chunk' ? advanced(KEYS[0]) : phase === 'verify' ? complete() : receipt();
const redacted = error => {
  assert.ok(error instanceof Error || error instanceof DOMException);
  assert.match(error.message, /outcome.*unknown.*reconcile/i);
  for (const secret of [SECRET, SESSION, TOKEN, OTHER, HASH]) assert.equal(String(error).includes(secret), false);
  assert.equal('cause' in error, false);
  return true;
};
function assertFrozen(value) {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true);
  for (const item of Object.values(value)) assertFrozen(item);
}
function accessor(value, key, effects) {
  Object.defineProperty(value, key, { enumerable: true, configurable: true, get() { effects.reads++; throw Error(SECRET); } });
}

test('real dependency/checks bundle is lightweight: no identity, ZIP, crypto, import/backup API or packages', () => {
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const key of ['dependencyApi', 'dispatchTransfer']) assert.ok(inputs.some(path => path.endsWith(`/${key}.ts`)));
  assert.equal(inputs.some(path => /node_modules|\/(?:api|identityApi|identityTransfer|container|crypto|manifest|dispatchImport|dispatchBackup|replacementBackup)\.ts$/.test(path)), false);
  assert.deepEqual(Object.keys(api).sort(), ['createDispatchDependencySession', 'setHarness']);
});
test('factory is lazy, captures admin token once, exposes only four explicit methods and sends exact RPC arguments', async () => {
  const h = harness(), s = api.createDispatchDependencySession(TOKEN);
  assert.equal(h.reads, 1); assert.equal(h.calls.length, 0);
  assert.deepEqual(Object.keys(s).sort(), ['begin', 'chunk', 'plan', 'verify']);
  h.session = OTHER;
  const signal = new AbortController().signal;
  h.respond(plan()); await s.plan(signal);
  h.respond(receipt()); await s.begin(HASH, signal);
  for (const key of KEYS) { h.respond(advanced(key)); await s.chunk(key, 0, signal); }
  h.respond(complete()); await s.verify(signal);
  assert.deepEqual(h.calls, [
    { name: RPC.plan, args: { p_admin_session_token: SESSION, p_job_token: TOKEN }, signals: [signal] },
    { name: RPC.begin, args: { p_admin_session_token: SESSION, p_job_token: TOKEN, p_plan_hash: HASH }, signals: [signal] },
    ...KEYS.map(key => ({ name: RPC.chunk, args: { p_admin_session_token: SESSION, p_job_token: TOKEN, p_table_key: key, p_chunk_no: 0 }, signals: [signal] })),
    { name: RPC.verify, args: { p_admin_session_token: SESSION, p_job_token: TOKEN }, signals: [signal] },
  ]);
  assert.equal(h.reads, 1); assert.equal(h.replies.length, 0);
});
for (const field of ['session', 'job']) for (const value of [null, undefined, 1, '', 'bad', {}, SESSION.toUpperCase().replace('1', 'A')]) {
  test(`factory rejects invalid ${field} ${String(value)} without RPC`, () => {
    const h = harness(); if (field === 'session') h.session = value;
    assert.throws(() => api.createDispatchDependencySession(field === 'job' ? value : TOKEN)); assert.equal(h.calls.length, 0);
  });
}
test('plan, begin, chunk and verify remain explicit; local ordering failures make no requests', async () => {
  const h = harness(), s = api.createDispatchDependencySession(TOKEN);
  await assert.rejects(s.begin(HASH), /matching conflict-free/);
  await assert.rejects(s.chunk(KEYS[0], 0), /begin has not been confirmed/);
  await assert.rejects(s.verify(), /begin has not been confirmed/);
  h.respond(plan()); await s.plan();
  await assert.rejects(s.begin(OTHER_HASH), /matching conflict-free/);
  await assert.rejects(s.chunk(KEYS[1], 0), /begin has not been confirmed/);
  await assert.rejects(s.verify(), /begin has not been confirmed/);
  assert.deepEqual(h.calls.map(c => c.name), [RPC.plan]);
});
for (const reason of REASONS) test(`plan accepts only reason string ${reason}; conflict blocks begin`, async () => {
  const h = harness(), s = api.createDispatchDependencySession(TOKEN), raw = { ...plan(), can_restore: false, conflicts: [reason] };
  h.respond(raw); const copy = await s.plan(); assert.deepEqual(copy, raw); assertFrozen(copy);
  assert.throws(() => { copy.can_restore = true; }); assert.throws(() => copy.conflicts.pop());
  raw.can_restore = true; raw.conflicts.length = 0;
  await assert.rejects(s.begin(HASH), /matching conflict-free/); assert.equal(h.calls.length, 1);
});
test('plan accepts exact row/conflict limits and empty counts, with detached frozen nested snapshots', async () => {
  for (const n of [0, 500000]) {
    const h = harness(), s = api.createDispatchDependencySession(TOKEN), raw = plan(counts(n, n));
    if (n) { raw.can_restore = false; raw.conflicts = Array(200).fill(REASONS[0]); }
    h.respond(raw); const copy = await s.plan(); assert.deepEqual(copy, raw); assertFrozen(copy);
    assert.notEqual(copy.counts, raw.counts); assert.notEqual(copy.conflicts, raw.conflicts);
  }
});
const planCases = [
  ['wrong scope', p => { p.scope = 'employee-identity'; }], ['nonboolean restore', p => { p.can_restore = 1; }],
  ['conflict-free false', p => { p.can_restore = false; }], ['conflicted true', p => { p.conflicts = [REASONS[0]]; }],
  ['201 conflicts', p => { p.can_restore = false; p.conflicts = Array(201).fill(REASONS[0]); }],
  ...['unknown', '', null, 1, true, {}, { reason: REASONS[0] }, new String(REASONS[0])].map((reason, i) =>
    [`bad reason ${i}`, p => { p.can_restore = false; p.conflicts = [reason]; }]),
  ...[null, {}, '[]', new Set()].map((value, i) => [`nonarray conflicts ${i}`, p => { p.conflicts = value; }]),
  ['sparse conflicts', p => { p.can_restore = false; p.conflicts = new Array(1); }],
  ['array extra', p => { p.conflicts.extra = 1; }], ['array symbol', p => { p.conflicts[Symbol('secret')] = SECRET; }],
  ['array iterator', p => { p.conflicts[Symbol.iterator] = () => { throw Error(SECRET); }; }],
  ['array subclass', p => { p.conflicts = new (class extends Array {})(); }],
  ['array null prototype', p => { Object.setPrototypeOf(p.conflicts, null); }],
  ['array inherited prototype', p => { Object.setPrototypeOf(p.conflicts, []); }],
  ['array hidden index', p => { p.can_restore = false; p.conflicts = [REASONS[0]]; Object.defineProperty(p.conflicts, 0, { enumerable: false }); }],
  ['array accessor', (p, e) => { p.can_restore = false; p.conflicts = [REASONS[0]]; accessor(p.conflicts, 0, e); }],
  ['array nonindex', p => { p.conflicts['01'] = REASONS[0]; }],
  ...['', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), null, 3, new String(HASH)].map((value, i) =>
    [`invalid plan hash ${i}`, p => { p.plan_hash = value; }]),
];
for (const [label, mutate] of planCases) test(`plan rejects ${label} without authorization or accessor reads`, async () => {
  const h = harness(), s = api.createDispatchDependencySession(TOKEN), raw = plan(), effects = { reads: 0 };
  mutate(raw, effects); h.respond(raw);
  await assert.rejects(s.plan(), redacted); assert.equal(effects.reads, 0);
  await assert.rejects(s.begin(HASH), /matching conflict-free/); assert.equal(h.calls.length, 1);
});
for (const phase of Object.keys(RPC)) {
  for (const value of [null, undefined, [], 'response', 1, true, () => {}, new Date()]) test(`${phase} rejects non-record ${String(value)}`, async () => {
    const h = harness(), s = await prepared(h, phase); h.respond(value); await assert.rejects(run(s, phase), redacted);
  });
  for (const key of Object.keys(good(phase))) for (const kind of ['missing', 'hidden', 'getter']) {
    test(`${phase} rejects ${kind} field ${key} without getter execution`, async () => {
      const h = harness(), s = await prepared(h, phase), raw = good(phase), effects = { reads: 0 };
      if (kind === 'missing') delete raw[key];
      if (kind === 'hidden') Object.defineProperty(raw, key, { enumerable: false });
      if (kind === 'getter') accessor(raw, key, effects);
      h.respond(raw); await assert.rejects(run(s, phase), redacted); assert.equal(effects.reads, 0);
    });
  }
  for (const kind of ['extra', 'symbol', 'inherited', 'class', 'proxy descriptor throw', 'proxy prototype throw', 'proxy keys throw']) {
    test(`${phase} rejects ${kind} record`, async () => {
      const h = harness(), s = await prepared(h, phase); let raw = good(phase);
      if (kind === 'extra') raw.backend_raw = SECRET;
      if (kind === 'symbol') raw[Symbol(SECRET)] = SECRET;
      if (kind === 'inherited') Object.setPrototypeOf(raw, { extra: SECRET });
      if (kind === 'class') raw = Object.assign(new (class {})(), raw);
      if (kind === 'proxy descriptor throw') raw = new Proxy(raw, { getOwnPropertyDescriptor() { throw Error(SECRET); } });
      if (kind === 'proxy prototype throw') raw = new Proxy(raw, { getPrototypeOf() { throw Error(SECRET); } });
      if (kind === 'proxy keys throw') raw = new Proxy(raw, { ownKeys() { throw Error(SECRET); } });
      h.respond(raw); await assert.rejects(run(s, phase), redacted);
    });
  }
  test(`${phase} accepts null-prototype records/proxy get traps without executing getters or iterators`, async () => {
    const h = harness(), s = await prepared(h, phase), expected = good(phase), raw = structuredClone(expected);
    let gets = 0;
    for (const field of phase === 'plan' ? ['counts'] : ['counts', 'totals', 'chunks', 'next_chunks']) {
      raw[field] = new Proxy(Object.assign(Object.create(null), raw[field]), { get() { gets++; throw Error(SECRET); } });
    }
    if (phase === 'plan') raw.conflicts = new Proxy(raw.conflicts, { get() { gets++; throw Error(SECRET); } });
    h.respond(new Proxy(Object.assign(Object.create(null), raw), { get() { gets++; throw Error(SECRET); } }));
    const result = await run(s, phase); assert.deepEqual(result, expected); assert.equal(gets, 0); assertFrozen(result);
  });
  for (const flag of Object.keys(flags())) for (const value of [!flags()[flag], null, 0, 'true']) {
    test(`${phase} rejects unsafe flag ${flag}=${value}`, async () => {
      const h = harness(), s = await prepared(h, phase), raw = good(phase); raw[flag] = value;
      h.respond(raw); await assert.rejects(run(s, phase), redacted);
    });
  }
}
// All count maps must have exactly two own enumerable data fields, even in deeply nested receipts.
for (const [phase, fields] of [['plan', ['counts']], ['begin', ['counts', 'totals', 'chunks', 'next_chunks']]]) {
  for (const field of fields) {
    for (const key of KEYS) {
      for (const value of [-1, 0.5, NaN, Infinity, -Infinity, '1', null, true, undefined, 1n, new Number(1)]) {
        test(`${phase}.${field}.${key} rejects ${String(value)} (${typeof value})`, async () => {
          const h = harness(), s = await prepared(h, phase), raw = good(phase); raw[field][key] = value;
          h.respond(raw); await assert.rejects(run(s, phase), redacted);
        });
      }
      for (const kind of ['missing', 'hidden', 'getter']) test(`${phase}.${field} rejects ${kind} ${key}`, async () => {
        const h = harness(), s = await prepared(h, phase), raw = good(phase), effects = { reads: 0 };
        if (kind === 'missing') delete raw[field][key];
        if (kind === 'hidden') Object.defineProperty(raw[field], key, { enumerable: false });
        if (kind === 'getter') accessor(raw[field], key, effects);
        h.respond(raw); await assert.rejects(run(s, phase), redacted); assert.equal(effects.reads, 0);
      });
      test(`${phase}.${field}.${key} rejects value over upper bound`, async () => {
        const h = harness(), s = await prepared(h, phase), raw = good(phase);
        raw[field][key] = field === 'chunks' || field === 'next_chunks' ? 500002 : 500001;
        h.respond(raw); await assert.rejects(run(s, phase), redacted);
      });
    }
    for (const kind of ['extra', 'symbol', 'prototype', 'null', 'array', 'alias key']) test(`${phase}.${field} rejects ${kind}`, async () => {
      const h = harness(), s = await prepared(h, phase), raw = good(phase);
      if (kind === 'extra') raw[field].secret = SECRET;
      if (kind === 'symbol') raw[field][Symbol(SECRET)] = SECRET;
      if (kind === 'prototype') Object.setPrototypeOf(raw[field], { secret: SECRET });
      if (kind === 'null') raw[field] = null;
      if (kind === 'array') raw[field] = [0, 0];
      if (kind === 'alias key') { raw[field].members = raw[field].dispatch_group_members; delete raw[field].dispatch_group_members; }
      h.respond(raw); await assert.rejects(run(s, phase), redacted);
    });
  }
}
const receiptCases = [
  ['false success', r => { r.success = false; }], ['truthy success', r => { r.success = 1; }],
  ['wrong scope', r => { r.scope = 'dispatch-valid-data'; }], ['nonboolean verified', r => { r.verified = 1; }],
  ['nonboolean repeated', r => { r.repeated = null; }], ['plan hash forbidden', r => { r.plan_hash = HASH; }],
  ...KEYS.flatMap(key => [
    [`${key}: counts over total`, r => { r.counts[key] = 2; r.next_chunks[key] = 1; }],
    [`${key}: count before first chunk`, r => { r.counts[key] = 1; r.next_chunks[key] = 0; }],
    [`${key}: next beyond chunks`, r => { r.next_chunks[key] = 2; }],
    [`${key}: no chunks`, r => { r.chunks[key] = 0; }],
    [`${key}: final chunk incomplete count`, r => { r.next_chunks[key] = 1; r.counts[key] = 0; }],
    [`${key}: verified incomplete rows`, r => { r.verified = true; r.counts = counts(); r.next_chunks = counts(); r.chunks[key] = 2; r.counts[key] = 0; }],
    [`${key}: verified incomplete cursor`, r => { r.verified = true; r.counts = counts(); r.next_chunks = counts(); r.chunks[key] = 2; }],
    [`${key}: totals mismatch plan`, r => { r.totals[key] = 2; }],
  ]),
];
for (const phase of ['begin', 'chunk', 'verify']) for (const [label, mutate] of receiptCases) {
  test(`${phase} rejects malformed receipt ${label}`, async () => {
    const h = harness(), s = await prepared(h, phase), raw = receipt(); mutate(raw); h.respond(raw);
    await assert.rejects(run(s, phase), redacted);
    if (phase === 'begin') {
      const before = h.calls.length; await assert.rejects(s.verify(), /begin has not been confirmed/);
      await assert.rejects(s.chunk(KEYS[0], 0), /begin has not been confirmed/); assert.equal(h.calls.length, before);
    }
  });
}
test('successful plan/receipt snapshots are recursively frozen and backend mutations cannot change begin authorization', async () => {
  const h = harness(), s = api.createDispatchDependencySession(TOKEN), raw = plan(); h.respond(raw);
  const p = await s.plan(); assertFrozen(p);
  assert.throws(() => { p.plan_hash = OTHER_HASH; }); assert.throws(() => { p.counts[KEYS[0]] = 5; });
  assert.throws(() => { p.conflicts.push(REASONS[0]); });
  raw.plan_hash = OTHER_HASH; raw.counts[KEYS[0]] = 5; raw.conflicts.push(REASONS[0]);
  await assert.rejects(s.begin(OTHER_HASH), /matching conflict-free/);
  const ack = receipt(); h.respond(ack); const r = await s.begin(HASH); assertFrozen(r);
  for (const field of ['counts', 'next_chunks', 'chunks', 'totals']) {
    assert.notEqual(r[field], ack[field]); assert.throws(() => { r[field][KEYS[0]] = 20; }); ack[field][KEYS[0]] = 50;
  }
  h.respond(complete()); assertFrozen(await s.verify()); assert.equal(h.calls.at(-1).name, RPC.verify);
});
test('exact maxima, empty blocks and intermediate progress are legal; verify is never inferred from counts', async () => {
  for (const total of [0, 500000]) {
    const h = harness(), s = await prepared(h, 'begin', counts(total, total));
    const r = { ...receipt(), totals: counts(total, total), chunks: counts(500001, 1) };
    h.respond(r); await s.begin(HASH);
    if (total) {
      h.respond({ ...r, counts: counts(1, 0), next_chunks: counts(1, 0) }); await s.chunk(KEYS[0], 0);
    }
    const done = { ...r, counts: counts(total, total), next_chunks: counts(500001, 1) };
    h.respond(done); const ack = await s.chunk(KEYS[0], 500000); assert.equal(ack.verified, false);
    h.respond({ ...done, verified: true }); const v = await s.verify(); assert.equal(v.verified, true);
  }
  const h = harness(), s = await prepared(h, 'begin', counts(0, 0));
  const empty = { ...receipt(), totals: counts(0, 0) }; h.respond(empty); await s.begin(HASH);
  for (const key of KEYS) { empty.next_chunks[key] = 1; h.respond(structuredClone(empty)); await s.chunk(key, 0); }
  h.respond({ ...empty, verified: true }); assert.equal((await s.verify()).verified, true);
});
for (const key of KEYS) test(`chunk requires progress for requested key ${key}, not the other key`, async () => {
  const h = harness(), s = await prepared(h, 'chunk');
  h.respond(receipt()); await assert.rejects(s.chunk(key, 0), redacted);
  h.respond(advanced(KEYS.find(k => k !== key))); await assert.rejects(s.chunk(key, 0), redacted);
  h.respond(advanced(key)); await s.chunk(key, 0);
});
test('verify requires explicit verified=true even if every row and chunk is complete', async () => {
  const h = harness(), s = await prepared(h, 'verify'); const r = complete(); r.verified = false;
  h.respond(r); await assert.rejects(s.verify(), redacted);
});
for (const key of ['', 'members', 'used', 'accounts', 'valid_order_data', '__proto__', 'constructor', null, 1, {}, new String(KEYS[0])]) {
  test(`chunk rejects non-whitelisted key ${String(key)} locally`, async () => {
    const h = harness(), s = await prepared(h, 'chunk'), before = h.calls.length;
    await assert.rejects(s.chunk(key, 0)); assert.equal(h.calls.length, before);
  });
}
for (const no of [-1, 0.1, 500001, Number.MAX_SAFE_INTEGER, NaN, Infinity, '0', null, undefined, true, 1n, new Number(0)]) {
  test(`chunk rejects invalid number ${String(no)} (${typeof no}) locally`, async () => {
    const h = harness(), s = await prepared(h, 'chunk'), before = h.calls.length;
    await assert.rejects(s.chunk(KEYS[0], no)); assert.equal(h.calls.length, before);
  });
}
for (const value of ['', 'A'.repeat(64), 'a'.repeat(63), null, 1, new String(HASH)]) test(`begin rejects malformed planHash ${String(value)} locally`, async () => {
  const h = harness(), s = await prepared(h), before = h.calls.length;
  await assert.rejects(s.begin(value)); assert.equal(h.calls.length, before);
});
test('duplicate begin/chunk/verify are explicit and repeated receipts, including later cursors, are allowed', async () => {
  const h = harness(), s = await prepared(h);
  for (let i = 0; i < 2; i++) {
    h.respond({ ...receipt(), repeated: !!i }); assert.equal((await s.begin(HASH)).repeated, !!i);
  }
  const done = { ...complete(), repeated: true };
  for (const key of KEYS) for (let i = 0; i < 2; i++) { h.respond(done); assert.equal((await s.chunk(key, 0)).repeated, true); }
  for (let i = 0; i < 2; i++) { h.respond(done); assert.equal((await s.verify()).verified, true); }
  assert.equal(h.calls.length, 9);
});
test('new factory resumes by querying fixed original plan then repeating begin to obtain committed progress', async () => {
  const h = harness(), first = await prepared(h); h.respond(receipt()); await first.begin(HASH);
  h.respond(advanced(KEYS[0])); await first.chunk(KEYS[0], 0);
  h.session = OTHER; const resumed = api.createDispatchDependencySession(TOKEN);
  const before = h.calls.length; await assert.rejects(resumed.chunk(KEYS[1], 0), /begin has not been confirmed/);
  await assert.rejects(resumed.verify(), /begin has not been confirmed/); assert.equal(h.calls.length, before);
  h.respond(plan()); const p = await resumed.plan(); assert.equal(p.plan_hash, HASH);
  h.respond({ ...advanced(KEYS[0]), repeated: true }); const ack = await resumed.begin(HASH);
  assert.equal(ack.repeated, true); assert.equal(ack.counts[KEYS[0]], 1);
  h.respond(complete()); await resumed.verify();
  assert.deepEqual(h.calls.slice(before).map(c => c.name), [RPC.plan, RPC.begin, RPC.verify]);
  assert.ok(h.calls.slice(before).every(c => c.args.p_admin_session_token === OTHER && c.args.p_job_token === TOKEN));
});
test('new failed or conflicted plan invalidates old begin approval, not a previously confirmed begin snapshot', async () => {
  const h = harness(), s = await prepared(h); h.respond({ ...plan(), plan_hash: 'bad' });
  await assert.rejects(s.plan(), redacted); await assert.rejects(s.begin(HASH), /matching conflict-free/);
  h.respond(plan()); await s.plan(); h.respond(receipt()); await s.begin(HASH);
  h.respond({ ...plan(), can_restore: false, conflicts: [REASONS[0]], counts: counts(20, 20) }); await s.plan();
  await assert.rejects(s.begin(HASH), /matching conflict-free/);
  h.respond(complete()); await s.verify();
});
for (const phase of Object.keys(RPC)) {
  for (const mode of ['sync throw', 'rejection', 'backend error', 'null response', 'false success']) test(`${phase}: ${mode} is redacted, single attempt, no automatic follow-up`, async () => {
    const h = harness(), s = await prepared(h, phase), before = h.calls.length, data = good(phase);
    if (mode === 'sync throw') h.replies.push({ throw: Error(SECRET + TOKEN) });
    if (mode === 'rejection') h.replies.push({ reject: Error(SECRET + SESSION) });
    if (mode === 'backend error') h.replies.push({ data, error: { message: SECRET, details: TOKEN, hint: SESSION } });
    if (mode === 'null response') h.respond(null);
    if (mode === 'false success') h.respond({ ...data, ...(phase === 'plan' ? { full_site_complete: true } : { success: false }) });
    await assert.rejects(run(s, phase), redacted); await nextTurn();
    assert.equal(h.calls.length, before + 1); assert.equal(h.replies.length, 0);
    if (phase === 'plan' || phase === 'begin') {
      await assert.rejects(s.chunk(KEYS[0], 0), /begin has not been confirmed/);
      await assert.rejects(s.verify(), /begin has not been confirmed/); assert.equal(h.calls.length, before + 1);
    }
    // Only this explicit caller action retries. Unknown outcomes must not make the session permanently unusable.
    h.respond(good(phase)); await run(s, phase); assert.equal(h.calls.length, before + 2);
  });
  test(`${phase}: pre-abort sends no RPC and does not clear prior approval`, async () => {
    const h = harness(), s = await prepared(h, phase), before = h.calls.length, c = new AbortController(); c.abort(Error(SECRET));
    await assert.rejects(run(s, phase, c.signal), { name: 'AbortError' }); assert.equal(h.calls.length, before);
    h.respond(good(phase)); await run(s, phase);
  });
  test(`${phase}: microtask abort before transport sends nothing`, async () => {
    const h = harness(), s = await prepared(h, phase), before = h.calls.length, c = new AbortController();
    const pending = run(s, phase, c.signal); c.abort(Error(SECRET));
    await assert.rejects(pending, e => e.name === 'AbortError' && redacted(e)); assert.equal(h.calls.length, before);
  });
  for (const late of ['resolve', 'reject']) test(`${phase}: abort interrupts blocked RPC; late ${late} cannot authorize or resume`, async () => {
    const h = harness(), s = await prepared(h, phase), before = h.calls.length, c = new AbortController(), gate = deferred();
    h.replies.push({ wait: gate.promise }); const pending = run(s, phase, c.signal); await nextTurn();
    assert.equal(h.calls.length, before + 1); assert.deepEqual(h.calls.at(-1).signals, [c.signal]); c.abort(Error(SECRET));
    await assert.rejects(soon(pending), e => e.name === 'AbortError' && redacted(e));
    if (late === 'resolve') gate.resolve({ data: good(phase), error: null }); else gate.reject(Error(SECRET));
    await nextTurn(); assert.equal(h.calls.length, before + 1);
    if (phase === 'plan') await assert.rejects(s.begin(HASH), /matching conflict-free/);
    if (phase === 'begin' || phase === 'plan') await assert.rejects(s.verify(), /begin has not been confirmed/);
    h.respond(good(phase)); await run(s, phase); // Lock released even if the old transport ignored abort.
    assert.equal(h.calls.length, before + 2);
  });
  test(`${phase}: abort while reading descriptors cannot commit client approval`, async () => {
    const h = harness(), s = await prepared(h, phase), c = new AbortController(), data = good(phase);
    h.respond(new Proxy(data, { ownKeys(target) { c.abort(SECRET); return Reflect.ownKeys(target); } }));
    await assert.rejects(run(s, phase, c.signal), e => e.name === 'AbortError' && redacted(e));
    if (phase === 'plan') await assert.rejects(s.begin(HASH), /matching conflict-free/);
    if (phase === 'begin') await assert.rejects(s.verify(), /begin has not been confirmed/);
  });
  test(`${phase}: abortSignal binding failure is redacted and not retried`, async () => {
    const h = harness(), s = await prepared(h, phase), before = h.calls.length;
    h.replies.push({ signalThrow: Error(SECRET) });
    await assert.rejects(run(s, phase, new AbortController().signal), redacted); assert.equal(h.calls.length, before + 1);
  });
  test(`${phase}: all methods are mutually exclusive until the pending RPC settles`, async () => {
    const h = harness(), s = await prepared(h, phase), gate = deferred(); h.replies.push({ wait: gate.promise });
    const pending = run(s, phase); await nextTurn(); const before = h.calls.length;
    for (const concurrent of Object.keys(RPC)) await assert.rejects(run(s, concurrent), /already in progress/);
    const c = new AbortController(); c.abort();
    await assert.rejects(s.plan(c.signal), { name: 'AbortError' }); assert.equal(h.calls.length, before);
    gate.resolve({ data: good(phase), error: null }); await pending;
    h.respond(good(phase)); await run(s, phase); assert.equal(h.calls.length, before + 1);
  });
}
test('an in-flight begin never authorizes chunk or verify until acknowledgement', async () => {
  const h = harness(), s = await prepared(h), gate = deferred(); h.replies.push({ wait: gate.promise });
  const pending = s.begin(HASH); await nextTurn();
  await assert.rejects(s.chunk(KEYS[0], 0), /already in progress/); await assert.rejects(s.verify(), /already in progress/);
  gate.resolve({ data: receipt(), error: null }); await pending;
  h.respond(complete()); await s.verify();
});
