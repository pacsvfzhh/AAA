import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const apiPath = fileURLToPath(new URL('../../src/lib/employeeTransfer/api.ts', import.meta.url));
const SESSION = '11111111-1111-4111-8111-111111111111';
const PACKAGE = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const PASSWORD = 'local-test-only-password';
const PREPARATION = 'a'.repeat(64), PLAN = 'b'.repeat(64);
const ENTER = '確認暫停業務並導入派單資料', LEAVE = '確認取消尚未寫入的遷移';
const CONFLICTS = ['group_mapping_collision', 'pool_mapping_collision', 'reserved_retirement_name'];
const TABLES = ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders',
  'dispatch_group_members', 'valid_order_data', 'used_order_data'];
const auth = () => ({ p_admin_session_token: SESSION, p_job_token: TOKEN });
const catalog = () => ({ version: 1, scope: 'dispatch-submission', site_id: SITE, processing_orders: 0,
  full_site_complete: false, tables: TABLES.map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: 'c'.repeat(64) })) });
const started = () => ({ success: true, job_id: JOB, job_token: TOKEN, scope: 'dispatch-submission', full_site_complete: false });
const plan = () => ({ scope: 'dispatch-configuration', can_apply_configuration: true, full_site_complete: false,
  replacement_ready: false, conflicts: [], group_map: { [JOB]: OTHER }, pool_map: { [TOKEN]: SITE },
  preparation_plan_hash: PREPARATION, plan_hash: PLAN });
const applied = () => ({ success: true, scope: 'dispatch-configuration', configuration_applied: true, maintenance: true,
  dependencies_pending: true, replacement_ready: false, full_site_complete: false, repeated: false,
  group_map: { [JOB]: OTHER }, pool_map: { [TOKEN]: SITE } });
const entered = () => ({ success: true, maintenance: true, dirty: false, repeated: false, full_site_complete: false });
const inactive = () => ({ active: false, job_id: null, dirty: false, full_site_complete: false });
const active = dirty => ({ active: true, job_id: JOB, dirty, full_site_complete: false });
const left = () => ({ success: true, maintenance: false, full_site_complete: false });

// Only auth and the RPC transport are substituted. All API/validator/business modules are real TS.
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/api.ts';
    export { setHarness } from 'configuration-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', metafile: true,
  plugins: [{ name: 'configuration-memory-transport', setup(builder) {
    builder.onResolve({ filter: /^\.\.\/(auth|supabase)$/ }, args => {
      assert.equal(args.importer, apiPath, 'never replace a business module');
      return { path: args.path.slice(3), namespace: 'configuration-test' };
    });
    builder.onResolve({ filter: /^configuration-test:state$/ }, () => ({ path: 'state', namespace: 'configuration-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'configuration-test' }, ({ path }) => {
      if (path === 'state') return { contents: `let h; export function setHarness(value) { h = value; }
        export function current() { if (!h) throw new Error('missing harness'); return h; }` };
      if (path === 'auth') return { contents: `import { current } from 'configuration-test:state';
        export function getAdminFinancialSessionToken() { const h = current(); h.sessionReads++;
          if (h.authError) throw h.authError; return h.session; }` };
      assert.equal(path, 'supabase');
      return { contents: `import { current } from 'configuration-test:state';
        export const supabase = { rpc: (...args) => current().rpc(...args) };
        export function formatSupabaseError() { throw new Error('backend errors must not be formatted/exposed'); }` };
    });
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function harness() {
  const h = {
    calls: [], pending: [], session: SESSION, sessionReads: 0,
    respond(data) { h.pending.push({ data }); },
    rpc(name, args) {
      const call = { name, args: structuredClone(args), signals: [], awaits: 0 }; h.calls.push(call);
      assert.ok(h.pending.length, `unexpected implicit RPC: ${name}`);
      const reply = h.pending.shift();
      if (reply.rpcThrow) throw reply.rpcThrow;
      const query = {
        abortSignal(signal) { call.signals.push(signal); if (reply.abortThrow) throw reply.abortThrow; return query; },
        then(resolve, reject) {
          call.awaits++;
          return Promise.resolve().then(() => {
            if (reply.reject) throw reply.reject;
            return reply.wait ?? { data: reply.data, error: reply.error ?? null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return h;
}
function expectCall(h, name, args, signal) {
  const call = h.calls.at(-1);
  assert.equal(call.name, name); assert.deepEqual(call.args, args);
  assert.deepEqual(call.signals, signal ? [signal] : []); assert.equal(call.awaits, 1);
}
let consoleSpies;
before(() => {
  mock.method(globalThis, 'fetch', () => assert.fail('production/network access forbidden'));
  consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map(name => mock.method(console, name, () => {}));
});
after(() => {
  for (const spy of consoleSpies) assert.equal(spy.mock.callCount(), 0, 'no console credential/error logging');
  mock.restoreAll();
});

describe('dispatch configuration client: real bundled API with transport-only stubs', { concurrency: false }, () => {
  let h;
  beforeEach(() => { h = harness(); api.setHarness(h); });
  afterEach(() => { assert.equal(h.pending.length, 0); });
  const create = () => api.createDispatchImportSession(PACKAGE, PASSWORD);
  async function begin(s = create()) { h.respond(started()); await s.target.begin(catalog()); return s; }
  async function planned() { const s = await begin(); h.respond(plan()); await s.configurationPlan(); return s; }
  const operations = {
    enter: { response: entered, name: 'employee_import_dispatch_enter_maintenance',
      async setup() { const s = await begin(); return signal => s.enterMaintenance(PREPARATION, ENTER, PASSWORD, signal); } },
    plan: { response: plan, name: 'get_employee_import_dispatch_configuration_plan',
      async setup() { const s = await begin(); return signal => s.configurationPlan(signal); } },
    apply: { response: applied, name: 'employee_import_dispatch_apply_configuration',
      async setup() { const s = await planned(); return signal => s.applyConfiguration(PLAN, signal); } },
    status: { response: inactive, name: 'get_employee_transfer_maintenance',
      async setup() { return signal => api.getTransferMaintenance(signal); } },
    leave: { response: left, name: 'employee_transfer_leave_maintenance',
      async setup() { return signal => api.leaveTransferMaintenance(JOB, PASSWORD, LEAVE, signal); } },
  };

  test('lightweight bundle contains real validators, no container/crypto/fflate/node_modules', () => {
    const inputs = Object.keys(compiled.metafile.inputs);
    for (const name of ['api', 'dispatchTransfer', 'dispatchImport']) assert.ok(inputs.some(path => path.endsWith(`/${name}.ts`)));
    assert.equal(inputs.some(path => /node_modules|\/(?:container|crypto|dispatchBackup|replacementBackup)\.ts$/.test(path)), false);
    assert.equal(inputs.some(path => /src\/lib\/(?:auth|supabase)\.ts$/.test(path)), false);
  });
  test('factory is lazy, captures one financial token, exposes only explicit operations', () => {
    const s = create(); assert.equal(s.identity(), null); assert.equal(h.calls.length, 0); assert.equal(h.sessionReads, 1);
    assert.deepEqual(Object.keys(s).sort(), ['identity', 'target', 'backup', 'cancel', 'enterMaintenance', 'configurationPlan', 'applyConfiguration'].sort());
    assert.deepEqual(Object.keys(s.target).sort(), ['begin', 'dryRun', 'stage']);
  });
  test('both new password parameters have unconditional finally cleanup (not a memory-erasure claim)', () => {
    for (const fn of [create().enterMaintenance, api.leaveTransferMaintenance]) {
      assert.match(fn.toString(), /finally\s*\{\s*adminPassword\d*\s*=\s*(?:''|"");?\s*\}/);
    }
  });
  test('every new session operation rejects before confirmed begin, without RPC', async () => {
    const s = create();
    for (const op of [() => s.enterMaintenance(PREPARATION, ENTER, PASSWORD), () => s.configurationPlan(), () => s.applyConfiguration(PLAN)]) {
      await assert.rejects(op(), /not been confirmed/);
    }
    assert.equal(h.calls.length, 0);
  });
  test('failed begin cannot unlock configuration or be automatically retried', async () => {
    const s = create(); h.respond({ success: false }); await assert.rejects(s.target.begin(catalog()));
    await assert.rejects(s.target.begin(catalog()), /cannot be retried/);
    await assert.rejects(s.configurationPlan(), /not been confirmed/); assert.equal(h.calls.length, 1);
  });
  test('explicit begin -> enter -> plan -> apply has exact tokens/parameters and never auto-leaves', async () => {
    const signal = new AbortController().signal, s = await begin();
    expectCall(h, 'employee_import_dispatch_begin', { p_admin_session_token: SESSION, p_admin_password: PASSWORD,
      p_package_id: PACKAGE, p_catalog: catalog() });
    const identity = s.identity(); identity.jobToken = OTHER; identity.jobId = OTHER;
    assert.deepEqual(s.identity(), { jobId: JOB, jobToken: TOKEN });
    h.session = OTHER;
    h.respond(entered()); assert.deepEqual(await s.enterMaintenance(PREPARATION, ENTER, PASSWORD, signal), entered());
    expectCall(h, operations.enter.name, { ...auth(), p_plan_hash: PREPARATION, p_confirmation: ENTER, p_admin_password: PASSWORD }, signal);
    assert.equal(h.calls.length, 2);
    h.respond(plan()); assert.deepEqual(await s.configurationPlan(signal), plan());
    expectCall(h, operations.plan.name, auth(), signal); assert.equal(h.calls.length, 3);
    h.respond(applied()); assert.deepEqual(await s.applyConfiguration(PLAN, signal), applied());
    expectCall(h, operations.apply.name, { ...auth(), p_plan_hash: PLAN }, signal);
    assert.equal(h.calls.length, 4); assert.equal(h.sessionReads, 1);
    await nextTurn(); assert.equal(h.calls.length, 4);
    h.respond({ ...applied(), repeated: true }); assert.equal((await s.applyConfiguration(PLAN)).repeated, true);
    assert.equal(h.calls.length, 5, 'only an explicit second apply is sent');
  });
  test('independent status/leave read the current financial token every time, without login/job token/cookies', async () => {
    const signal = new AbortController().signal;
    for (const token of [SESSION, OTHER]) {
      h.session = token; h.respond(active(true)); assert.deepEqual(await api.getTransferMaintenance(signal), active(true));
      expectCall(h, operations.status.name, { p_admin_session_token: token }, signal);
      h.respond(left()); assert.deepEqual(await api.leaveTransferMaintenance(JOB, PASSWORD, LEAVE, signal), left());
      expectCall(h, operations.leave.name, { p_admin_session_token: token, p_job_id: JOB,
        p_admin_password: PASSWORD, p_confirmation: LEAVE }, signal);
    }
    assert.equal(h.sessionReads, 4); assert.equal(h.calls.length, 4);
  });
  test('dirty maintenance is not automatically released; only explicit leave lets the server reject it', async () => {
    h.respond(active(true)); assert.equal((await api.getTransferMaintenance()).dirty, true);
    assert.equal(h.calls.length, 1);
    h.pending.push({ error: { message: 'Maintenance contains committed writes and cannot be cancelled.' } });
    await assert.rejects(api.leaveTransferMaintenance(JOB, PASSWORD, LEAVE), /uncertain/);
    assert.equal(h.calls.length, 2);
    h.respond(active(true)); assert.deepEqual(await api.getTransferMaintenance(), active(true));
  });
  test('invalid confirmation is rejected locally, including empty/near-match text', async () => {
    const s = await begin(), count = h.calls.length;
    for (const confirmation of ['', `${ENTER} `, LEAVE, null]) await assert.rejects(s.enterMaintenance(PREPARATION, confirmation, PASSWORD), /confirmation/);
    for (const confirmation of ['', `${LEAVE} `, ENTER, null]) await assert.rejects(api.leaveTransferMaintenance(JOB, PASSWORD, confirmation), /confirmation/);
    assert.equal(h.calls.length, count);
  });
  test('invalid input hashes/job IDs and apply before explicit plan are rejected locally', async () => {
    const s = await begin(), count = h.calls.length;
    for (const value of [null, {}, 7, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), `${PLAN}\n`]) {
      await assert.rejects(s.enterMaintenance(value, ENTER, PASSWORD)); await assert.rejects(s.applyConfiguration(value));
    }
    for (const value of [null, {}, '', 'not-a-uuid', `${JOB}\n`, JOB.toUpperCase().replace('3', 'G')]) {
      await assert.rejects(api.leaveTransferMaintenance(value, PASSWORD, LEAVE));
    }
    await assert.rejects(s.applyConfiguration(PLAN), /conflict-free/); assert.equal(h.calls.length, count);
  });
  for (const conflict of CONFLICTS) test(`false plan gate: ${conflict} is safe to display but cannot apply`, async () => {
    const s = await begin(); h.respond({ ...plan(), conflicts: [conflict, conflict], can_apply_configuration: false });
    const result = await s.configurationPlan(); assert.equal(result.can_apply_configuration, false);
    assert.deepEqual(result.conflicts, [conflict, conflict]);
    await assert.rejects(s.applyConfiguration(PLAN), /conflict-free/); assert.equal(h.calls.length, 2);
  });
  test('apply requires matching plan; unsuccessful replan clears the previous local gate', async () => {
    const s = await planned(); await assert.rejects(s.applyConfiguration(PREPARATION), /matching/);
    h.respond({ ...plan(), full_site_complete: true }); await assert.rejects(s.configurationPlan());
    await assert.rejects(s.applyConfiguration(PLAN), /conflict-free/); assert.equal(h.calls.length, 3);
  });
  test('returned plans/maps/conflicts are independent frozen copies, not mutable backend references', async () => {
    const s = await begin(), raw = plan(); h.respond(raw); const result = await s.configurationPlan();
    assert.notStrictEqual(result, raw); assert.notStrictEqual(result.conflicts, raw.conflicts);
    for (const key of ['group_map', 'pool_map']) assert.notStrictEqual(result[key], raw[key]);
    assert.throws(() => { result.plan_hash = PREPARATION; }, TypeError);
    assert.throws(() => { result.group_map[JOB] = SITE; }, TypeError);
    assert.throws(() => result.conflicts.push(CONFLICTS[0]), TypeError);
    raw.plan_hash = PREPARATION; raw.group_map[JOB] = SITE; raw.conflicts.push(CONFLICTS[0]);
    assert.deepEqual(result, plan());
    h.respond(applied()); assert.deepEqual(await s.applyConfiguration(PLAN), applied());
    expectCall(h, operations.apply.name, { ...auth(), p_plan_hash: PLAN });
  });
  for (const [label, op] of Object.entries(operations)) {
    test(`${label} returns a frozen defensive copy even for frozen server data`, async () => {
      const run = await op.setup(), raw = op.response(); Object.freeze(raw);
      h.respond(raw); const result = await run(); assert.deepEqual(result, raw); assert.notStrictEqual(result, raw); assert.ok(Object.isFrozen(result));
      if (raw.group_map) {
        assert.notStrictEqual(result.group_map, raw.group_map); assert.ok(Object.isFrozen(result.group_map));
        assert.notStrictEqual(result.pool_map, raw.pool_map); assert.ok(Object.isFrozen(result.pool_map));
      }
    });
    test(`${label} pre-abort sends no RPC and late abort cannot produce success or follow-up`, async () => {
      const run = await op.setup(), count = h.calls.length, pre = new AbortController(); pre.abort();
      await assert.rejects(run(pre.signal), { name: 'AbortError' }); assert.equal(h.calls.length, count);
      const controller = new AbortController(), wait = deferred(); h.pending.push({ wait: wait.promise });
      const task = run(controller.signal); await nextTurn(); assert.equal(h.calls.length, count + 1);
      const rejection = assert.rejects(task, { name: 'AbortError' }); controller.abort(); await rejection;
      wait.resolve({ data: op.response(), error: null }); await nextTurn();
      assert.equal(h.calls.length, count + 1); assert.deepEqual(h.calls.at(-1).signals, [controller.signal]);
    });
    test(`${label} observes a late rejection without unhandled promises or retries`, async () => {
      const run = await op.setup(), count = h.calls.length, controller = new AbortController(), wait = deferred();
      h.pending.push({ wait: wait.promise }); const task = run(controller.signal); await nextTurn();
      const rejection = assert.rejects(task, { name: 'AbortError' }); controller.abort(); await rejection;
      wait.resolve(Promise.reject(new Error('late transport failure'))); await nextTurn(); assert.equal(h.calls.length, count + 1);
    });
    for (const [mode, reply] of [
      ['wrong password', { data: { success: false, error: PASSWORD, locked: false } }],
      ['backend error', { error: { message: PASSWORD, details: SESSION } }],
      ['network rejection', { reject: new TypeError(PASSWORD) }],
      ['synchronous RPC throw', { rpcThrow: new Error(PASSWORD) }],
      ['abort attachment throw', { abortThrow: new Error(PASSWORD) }],
      ['unknown null outcome', { data: null }],
      ['unknown empty outcome', { data: {} }],
    ]) test(`${label}: ${mode} fails once without exposing credentials/retrying/auto-leaving`, async () => {
      const run = await op.setup(), count = h.calls.length; h.pending.push(reply);
      await assert.rejects(run(new AbortController().signal), error => {
        assert.doesNotMatch(error.message, new RegExp(`${PASSWORD}|${SESSION}`)); return true;
      });
      await nextTurn(); assert.equal(h.calls.length, count + 1); assert.equal(h.calls.at(-1).name, op.name);
    });
    for (const mutation of ['extra', 'missing', 'symbol', 'getter', 'nonenumerable', 'prototype']) {
      test(`${label}: rejects ${mutation} keys without invoking getters`, async () => {
        const run = await op.setup(), raw = op.response(), first = Object.keys(raw)[0]; let reads = 0;
        if (mutation === 'extra') raw.unexpected = true;
        if (mutation === 'missing') delete raw[first];
        if (mutation === 'symbol') raw[Symbol('unexpected')] = true;
        if (mutation === 'getter') Object.defineProperty(raw, first, { enumerable: true, get() { reads++; return true; } });
        if (mutation === 'nonenumerable') Object.defineProperty(raw, first, { enumerable: false });
        if (mutation === 'prototype') Object.setPrototypeOf(raw, { unexpected: true });
        h.respond(raw); await assert.rejects(run()); assert.equal(reads, 0);
      });
    }
    const valid = op.response();
    for (const [key, value] of Object.entries(valid)) {
      if (typeof value !== 'boolean' && key !== 'scope') continue;
      const invalidValues = typeof value === 'boolean' ? [null, 0, 'false', !value] : ['', 'dispatch-submission', null];
      // repeated is a boolean, not a fixed gate; active/dirty combinations are tested separately.
      for (const bad of invalidValues.filter(bad => !(['repeated', 'active', 'dirty'].includes(key) && typeof bad === 'boolean'))) {
        test(`${label}: rejects invalid ${key}=${String(bad)}`, async () => {
          const run = await op.setup(); h.respond({ ...op.response(), [key]: bad }); await assert.rejects(run());
        });
      }
    }
  }
  test('late aborted plan never installs the local apply gate', async () => {
    const s = await begin(), controller = new AbortController(), wait = deferred(); h.pending.push({ wait: wait.promise });
    const task = s.configurationPlan(controller.signal); await nextTurn(); const rejection = assert.rejects(task, { name: 'AbortError' });
    controller.abort(); await rejection; wait.resolve({ data: plan(), error: null }); await nextTurn();
    await assert.rejects(s.applyConfiguration(PLAN), /conflict-free/); assert.equal(h.calls.length, 2);
  });
  test('abort fired during response descriptor inspection cannot return success or install a plan', async () => {
    const s = await begin(), controller = new AbortController();
    h.respond(new Proxy(plan(), { getOwnPropertyDescriptor(target, key) {
      if (key === 'plan_hash') controller.abort(); return Reflect.getOwnPropertyDescriptor(target, key);
    } }));
    await assert.rejects(s.configurationPlan(controller.signal), { name: 'AbortError' });
    await assert.rejects(s.applyConfiguration(PLAN), /conflict-free/);
  });
  test('plan/receipt proxies cannot alter values through repeated property gets', async () => {
    const s = await begin(); let gets = 0;
    const wrap = raw => new Proxy(raw, { get() { gets++; throw new Error('must use captured descriptors'); } });
    const raw = plan(); raw.group_map = wrap(raw.group_map); raw.pool_map = wrap(raw.pool_map); raw.conflicts = wrap(raw.conflicts);
    h.respond(wrap(raw)); assert.deepEqual(await s.configurationPlan(), plan());
    const ack = applied(); ack.group_map = wrap(ack.group_map); ack.pool_map = wrap(ack.pool_map);
    h.respond(wrap(ack)); assert.deepEqual(await s.applyConfiguration(PLAN), applied()); assert.equal(gets, 0);
  });
  for (const factory of [plan, applied]) for (const key of ['group_map', 'pool_map']) {
    for (const [label, make] of [
      ['array', () => []], ['null', () => null], ['string', () => JOB], ['invalid source ID', () => ({ wrong: JOB })],
      ['invalid target ID', () => ({ [JOB]: 'wrong' })], ['null target ID', () => ({ [JOB]: null })],
      ['object target ID', () => ({ [JOB]: { value: TOKEN } })], ['newline ID', () => ({ [JOB]: `${TOKEN}\n` })],
      ['uppercase ID', () => ({ ['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA']: TOKEN })],
      ['dangerous key', () => JSON.parse('{"__proto__":"ignored"}')],
      ['symbol key', () => ({ [Symbol('bad')]: TOKEN })],
      ['getter', () => Object.defineProperty({}, JOB, { enumerable: true, get() { assert.fail('map getter invoked'); } })],
      ['hidden key', () => Object.defineProperty({}, JOB, { enumerable: false, value: TOKEN })],
      ['custom prototype', () => Object.assign(Object.create({ inherited: TOKEN }), { [JOB]: TOKEN })],
      ['throwing proxy', () => new Proxy({}, { ownKeys() { throw new Error('untrusted trap'); } })],
    ]) test(`${factory.name} rejects ${key} ${label}`, async () => {
      const run = await operations[factory === plan ? 'plan' : 'apply'].setup(); h.respond({ ...factory(), [key]: make() }); await assert.rejects(run());
    });
  }
  for (const key of ['preparation_plan_hash', 'plan_hash']) for (const bad of [null, 7, {}, '', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), `${PLAN}\n`]) {
    test(`plan rejects ${key} ${String(bad)}`, async () => {
      const run = await operations.plan.setup(); h.respond({ ...plan(), [key]: bad }); await assert.rejects(run());
    });
  }
  for (const [label, make] of [
    ['unknown conflict', () => ['server-secret-text']], ['object', () => ({})], ['null', () => null], ['sparse', () => Array(1)],
    ['non-string', () => [1]], ['extra key', () => Object.assign([], { secret: true })],
    ['symbol key', () => Object.assign([], { [Symbol('bad')]: true })],
    ['getter', () => Object.defineProperty([CONFLICTS[0]], '0', { enumerable: true, get() { assert.fail('conflict getter invoked'); } })],
    ['custom prototype', () => Object.setPrototypeOf([], {})],
    ['excessive length', () => Array(1000002)],
  ]) test(`conflicts reject ${label}`, async () => {
    const run = await operations.plan.setup(); h.respond({ ...plan(), can_apply_configuration: false, conflicts: make() }); await assert.rejects(run());
  });
  test('conflicts and can_apply_configuration must agree', async () => {
    const s = await begin();
    for (const raw of [{ ...plan(), conflicts: [CONFLICTS[0]] }, { ...plan(), can_apply_configuration: false }]) {
      h.respond(raw); await assert.rejects(s.configurationPlan());
    }
  });
  for (const raw of [inactive(), active(false), active(true)]) test(`valid status ${JSON.stringify(raw)}`, async () => {
    h.respond(raw); assert.deepEqual(await api.getTransferMaintenance(), raw);
  });
  for (const raw of [
    { ...inactive(), job_id: JOB }, { ...inactive(), dirty: true }, { ...active(false), job_id: null },
    { ...active(true), job_id: null }, { ...active(false), job_id: 'invalid' }, { ...active(false), job_id: `${JOB}\n` },
    { ...active(false), job_id: {} },
  ]) test(`reject inconsistent/invalid status ${JSON.stringify(raw)}`, async () => {
    h.respond(raw); await assert.rejects(api.getTransferMaintenance());
  });
});

// Exercise the actual timeout/retry implementation separately; only SDK construction is stubbed.
const transportBundle = await build({
  entryPoints: [fileURLToPath(new URL('../../src/lib/supabase.ts', import.meta.url))], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2020',
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://local.invalid'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('local-test-key') },
  plugins: [{ name: 'sdk-config-only', setup(builder) {
    builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'sdk', namespace: 'transport-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'transport-test' }, () => ({
      contents: 'export function createClient(url, key, options) { return { transport: options.global.fetch }; }',
    }));
  } }],
});
let transportSequence = 0;
async function realTransport(reply, run) {
  const timers = [], clear = mock.method(globalThis, 'clearTimeout', () => {});
  const timer = mock.method(globalThis, 'setTimeout', (fn, delay) => {
    timers.push({ fn, delay }); if (delay === 250) queueMicrotask(fn); return timers.length;
  });
  const network = mock.method(globalThis, 'fetch', reply);
  const xhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class { constructor() { assert.fail('write requests must not use XHR fallback'); } };
  try {
    const module = await import(`data:text/javascript;base64,${Buffer.from(transportBundle.outputFiles[0].text).toString('base64')}#${++transportSequence}`);
    await run(module.supabase.transport, timers, network);
  } finally {
    timer.mock.restore(); clear.mock.restore(); network.mock.restore();
    if (xhr === undefined) delete globalThis.XMLHttpRequest; else globalThis.XMLHttpRequest = xhr;
  }
}
for (const name of ['employee_import_dispatch_enter_maintenance', 'get_employee_transfer_maintenance',
  'employee_transfer_leave_maintenance', 'get_employee_import_dispatch_configuration_plan', 'employee_import_dispatch_apply_configuration']) {
  test(`real transport: ${name} receives exactly 120s timeout`, () => realTransport(async () => new Response('{}'), async (fetch, timers, network) => {
    await fetch(`https://local.invalid/rest/v1/rpc/${name}`, { method: 'POST' });
    assert.deepEqual(timers.map(timer => timer.delay), [120000]); assert.equal(network.mock.callCount(), 1);
  }));
}
for (const name of ['employee_import_dispatch_enter_maintenance', 'employee_transfer_leave_maintenance',
  'get_employee_import_dispatch_configuration_plan', 'employee_import_dispatch_apply_configuration']) {
  test(`real transport: ${name} never retries a 503`, () => realTransport(async () => new Response('{}', { status: 503 }), async (fetch, timers, network) => {
    assert.equal((await fetch(`https://local.invalid/rest/v1/rpc/${name}`, { method: 'POST' })).status, 503);
    assert.equal(network.mock.callCount(), 1); assert.deepEqual(timers.map(timer => timer.delay), [120000]);
  }));
  test(`real transport: ${name} never retries/falls back after network error`, () => realTransport(async () => { throw new TypeError('Failed to fetch'); }, async (fetch, timers, network) => {
    await assert.rejects(fetch(`https://local.invalid/rest/v1/rpc/${name}`, { method: 'POST' }), { name: 'SupabaseNetworkError' });
    assert.equal(network.mock.callCount(), 1); assert.deepEqual(timers.map(timer => timer.delay), [120000]);
  }));
  test(`real transport: ${name} never retries/falls back after timeout`, () => realTransport((input, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  }), async (fetch, timers, network) => {
    const request = fetch(`https://local.invalid/rest/v1/rpc/${name}`, { method: 'POST' });
    const rejection = assert.rejects(request, { name: 'SupabaseTimeoutError' }); timers[0].fn(); await rejection;
    assert.equal(network.mock.callCount(), 1); assert.deepEqual(timers.map(timer => timer.delay), [120000]);
  }));
}
