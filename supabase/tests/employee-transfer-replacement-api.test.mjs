import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test';
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
const PASSWORD = 'Local-test-only-password';
const KEYS = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
const hash = text => createHash('sha256').update(text).digest('hex');
const PLAN = hash('local replacement plan');
const TARGET = hash('local frozen target');
const CIPHER = hash('local ciphertext');
const BYTES = 321;
const auth = () => ({ p_admin_session_token: SESSION, p_job_token: TOKEN });
const started = () => ({ success: true, scope: 'shared-settings', full_site_complete: false,
  job_id: JOB, job_token: TOKEN });
const confirmed = () => ({ success: true, scope: 'shared-settings', full_site_complete: false });
const catalog = () => ({ version: 1, scope: 'shared-settings', site_id: SITE,
  tables: KEYS.map(key => ({ key, rows: 0, bytes: 0, sha256: hash('') })),
  excluded_system_keys: ['ios_config'], full_site_complete: false });
const descriptor = () => ({ backup_id: JOB, plan_hash: PLAN, target_hash: TARGET, catalog: catalog() });
const chunkAck = () => ({ success: true, bytes: 3, sha256: hash(Buffer.from('0001ff', 'hex')), repeated: false });
const sealAck = () => ({ success: true, backup_id: JOB, sha256: CIPHER, bytes: BYTES,
  full_site_complete: false, repeated: false });
const page = () => ({ table_key: 'admins', count: 0, ndjson: '', next_after: null, sha256: hash('') });

const compiled = await build({
  stdin: {
    contents: `export * from './src/lib/employeeTransfer/api.ts';
      export { setHarness } from 'replacement-api-test:state';`,
    resolveDir: root, sourcefile: 'replacement-api-test-entry.mjs', loader: 'js',
  },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', metafile: true,
  plugins: [{
    name: 'memory-only-auth-and-supabase',
    setup(build) {
      build.onResolve({ filter: /^\.\.\/(auth|supabase)$/ }, args => {
        assert.equal(args.importer, apiPath, 'do not silently stub unrelated modules');
        return { path: args.path.slice(3), namespace: 'replacement-api-test' };
      });
      build.onResolve({ filter: /^replacement-api-test:state$/ }, () => ({
        path: 'state', namespace: 'replacement-api-test',
      }));
      build.onLoad({ filter: /.*/, namespace: 'replacement-api-test' }, ({ path }) => {
        if (path === 'state') return { contents: `
          let harness;
          export function setHarness(value) { harness = value; }
          export function currentHarness() {
            if (!harness) throw new Error('RPC harness has not been installed.');
            return harness;
          }
        ` };
        if (path === 'auth') return { contents: `
          import { currentHarness } from 'replacement-api-test:state';
          export function getAdminFinancialSessionToken() {
            currentHarness().sessionReads++;
            return ${JSON.stringify(SESSION)};
          }
        ` };
        assert.equal(path, 'supabase');
        return { contents: `
          import { currentHarness } from 'replacement-api-test:state';
          export const supabase = { rpc: (...args) => currentHarness().rpc(...args) };
          export function formatSupabaseError(error) { return currentHarness().format(error); }
        ` };
      });
    },
  }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

function harness() {
  const value = {
    calls: [], pending: [], formatted: [], sessionReads: 0,
    respond(data) { value.pending.push({ data }); },
    enqueue(response) { value.pending.push(response); },
    format(error) { value.formatted.push(error); return `stub-formatted: ${error.message}`; },
    rpc(name, args) {
      const call = { name, args: structuredClone(args), signals: [], awaits: 0 };
      value.calls.push(call);
      assert.ok(value.pending.length, `unexpected RPC (possible automatic retry/apply): ${name}`);
      const response = value.pending.shift();
      if (response.rpcThrow) throw response.rpcThrow;
      const query = {
        abortSignal(signal) {
          call.signals.push(signal);
          if (response.abortThrow) throw response.abortThrow;
          return query;
        },
        then(resolve, reject) {
          call.awaits++;
          return Promise.resolve().then(() => {
            if (response.reject) throw response.reject;
            if (response.wait) return response.wait;
            return { data: response.data, error: response.error ?? null };
          }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return value;
}
function expectCall(call, name, args, signal) {
  assert.equal(call.name, name);
  assert.deepEqual(call.args, args);
  assert.deepEqual(call.signals, signal ? [signal] : []);
  assert.equal(call.awaits, 1, 'each RPC must be awaited exactly once');
}
function noApply(h) {
  assert.equal(h.calls.some(call => /_apply$/.test(call.name)), false, 'never automatically apply');
}
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

before(() => {
  mock.method(globalThis, 'fetch', () => assert.fail('network access is forbidden in this API test'));
});
after(() => mock.restoreAll());

describe('shared replacement API: real TS with memory-only RPC', { concurrency: false }, () => {
  let h;
  beforeEach(() => { h = harness(); api.setHarness(h); });
  afterEach(() => { assert.equal(h.pending.length, 0, 'all explicitly queued RPC replies must be consumed'); });

  const create = replace => (replace ? api.createSharedSettingsReplacementSession : api.createSharedSettingsImportSession)(PACKAGE, PASSWORD);
  async function begin(session, signal) {
    h.respond(started());
    assert.deepEqual(await session.target.begin(catalog(), signal), confirmed());
  }
  async function backup(session) {
    h.respond(descriptor());
    return session.backup();
  }

  test('bundle includes the real API/catalog validator and excludes real auth, Supabase and network clients', () => {
    const inputs = Object.keys(compiled.metafile.inputs);
    assert.ok(inputs.some(path => path.endsWith('src/lib/employeeTransfer/api.ts')));
    assert.ok(inputs.some(path => path.endsWith('src/lib/employeeTransfer/sharedExport.ts')));
    for (const name of ['auth', 'supabase', 'state']) {
      assert.ok(inputs.includes(`replacement-api-test:${name}`));
    }
    assert.equal(inputs.some(path => /(?:^|\/)src\/lib\/(?:auth|supabase)\.ts$|node_modules/.test(path)), false);
  });

  test('factories capture the fixed financial session once, remain lazy, and expose no implicit target.apply', () => {
    for (const replace of [false, true]) {
      const session = create(replace);
      assert.equal(session.identity(), null);
      assert.deepEqual(Object.keys(session.target).sort(), ['begin', 'dryRun', 'stage']);
      assert.equal(typeof session.apply, 'function');
      assert.equal(typeof session.backup, 'function');
    }
    assert.equal(h.sessionReads, 2);
    assert.equal(h.calls.length, 0);
  });

  test('begin retains an unconditional finally password-clear in the real compiled function (structural check)', () => {
    // The lexical password cannot be inspected; this is not a memory-erasure measurement.
    for (const replace of [false, true]) {
      const session = create(replace);
      assert.match(session.target.begin.toString(), /finally\s*\{\s*adminPassword\s*=\s*(?:''|"");?\s*\}/);
    }
  });

  test('unconfirmed replacement operations reject locally without RPCs', async () => {
    const session = create(true);
    for (const operation of [() => session.target.stage('admins', 0, '{}\n'),
      () => session.target.dryRun(), () => session.apply(PLAN), () => session.backup()]) {
      await assert.rejects(operation(), /has not been confirmed/);
    }
    assert.equal(session.identity(), null);
    assert.equal(h.calls.length, 0);
  });

  test('replacement begin/stage/dryRun and backup source/receiver use exact endpoints, tokens and arguments', async () => {
    const session = create(true);
    const input = catalog();
    h.respond(started());
    assert.deepEqual(await session.target.begin(input), confirmed());
    expectCall(h.calls.at(-1), 'employee_import_shared_replace_begin', {
      p_admin_session_token: SESSION, p_admin_password: PASSWORD, p_package_id: PACKAGE, p_catalog: input,
    });
    const identity = session.identity();
    assert.deepEqual(identity, { jobId: JOB, jobToken: TOKEN });
    identity.jobId = OTHER;
    identity.jobToken = OTHER;
    assert.deepEqual(session.identity(), { jobId: JOB, jobToken: TOKEN });

    const ndjson = '{"label":"管理员𠮷"}\n';
    const staged = { success: true, rows: 1, bytes: Buffer.byteLength(ndjson), sha256: hash(ndjson), repeated: false };
    h.respond(staged);
    assert.strictEqual(await session.target.stage('admin_groups', 7, ndjson), staged);
    expectCall(h.calls.at(-1), 'employee_import_shared_stage', {
      ...auth(), p_table_key: 'admin_groups', p_chunk_no: 7, p_ndjson: ndjson,
    });
    const plan = { scope: 'shared-settings', full_site_complete: false, can_apply: true, plan_hash: PLAN };
    h.respond(plan);
    assert.strictEqual(await session.target.dryRun(), plan);
    expectCall(h.calls.at(-1), 'get_employee_import_shared_replace_dry_run', auth());

    const response = { ...descriptor(), extra_server_field: 'not exposed' };
    h.respond(response);
    const task = await session.backup();
    expectCall(h.calls.at(-1), 'get_employee_import_shared_backup', auth());
    assert.deepEqual(Object.keys(task).sort(), ['descriptor', 'receiver', 'source']);
    assert.deepEqual(task.descriptor, descriptor());
    assert.notStrictEqual(task.descriptor, response);
    assert.notStrictEqual(task.descriptor.catalog, response.catalog);
    assert.notStrictEqual(task.descriptor.catalog.tables[0], response.catalog.tables[0]);
    const callCount = h.calls.length;
    assert.deepEqual(await task.source.catalog(), descriptor().catalog);
    assert.equal(h.calls.length, callCount, 'catalog comes from the captured descriptor, not another RPC');

    for (const after of [null, 'frozen-cursor']) {
      const result = page();
      h.respond(result);
      assert.strictEqual(await task.source.page('admins', after), result);
      expectCall(h.calls.at(-1), 'get_employee_import_shared_backup_page', {
        ...auth(), p_table_key: 'admins', p_after: after, p_limit: 200,
      });
    }
    h.respond(descriptor());
    assert.deepEqual(await task.source.verify(), { verified: true, scope: 'shared-settings', full_site_complete: false });
    expectCall(h.calls.at(-1), 'get_employee_import_shared_backup', auth());
    h.respond({ ...chunkAck(), extra_server_field: true });
    assert.deepEqual(await task.receiver.append(4, '0001ff'), chunkAck());
    expectCall(h.calls.at(-1), 'employee_import_shared_backup_append', {
      ...auth(), p_plan_hash: PLAN, p_chunk_no: 4, p_hex: '0001ff',
    });
    const receipt = sealAck();
    h.respond(receipt);
    assert.strictEqual(await task.receiver.seal(CIPHER, BYTES), receipt);
    expectCall(h.calls.at(-1), 'employee_import_shared_backup_seal', {
      ...auth(), p_plan_hash: PLAN, p_sha256: CIPHER, p_bytes: BYTES,
    });
    assert.equal(h.sessionReads, 1);
    assert.equal(h.calls.slice(1).some(call => Object.hasOwn(call.args, 'p_admin_password')), false);
    noApply(h);
  });

  test('create-only retains old begin/dryRun/apply endpoints and refuses backup before and after begin', async () => {
    const session = create(false);
    await assert.rejects(session.backup(), /Create-only tasks/);
    assert.equal(h.calls.length, 0);
    await begin(session);
    expectCall(h.calls.at(-1), 'employee_import_shared_begin', {
      p_admin_session_token: SESSION, p_admin_password: PASSWORD, p_package_id: PACKAGE, p_catalog: catalog(),
    });
    h.respond({ success: true });
    await session.target.stage('system_configs', 0, '');
    expectCall(h.calls.at(-1), 'employee_import_shared_stage', {
      ...auth(), p_table_key: 'system_configs', p_chunk_no: 0, p_ndjson: '',
    });
    h.respond({ can_apply: true, plan_hash: PLAN });
    await session.target.dryRun();
    expectCall(h.calls.at(-1), 'get_employee_import_shared_dry_run', auth());
    const before = h.calls.length;
    await assert.rejects(session.backup(new AbortController().signal), /Create-only tasks/);
    assert.equal(h.calls.length, before);
    noApply(h);
    const receipt = { success: true, full_site_complete: false };
    h.respond(receipt);
    assert.strictEqual(await session.apply(PLAN), receipt);
    expectCall(h.calls.at(-1), 'employee_import_shared_apply', { ...auth(), p_plan_hash: PLAN });
    assert.equal(h.sessionReads, 1);
  });

  for (const replace of [false, true]) {
    test(`${replace ? 'replacement' : 'create-only'} begin cannot be retried while pending or after success`, async () => {
      const session = create(replace);
      const waiting = deferred();
      h.enqueue({ wait: waiting.promise });
      const pending = session.target.begin(catalog());
      await assert.rejects(session.target.begin(catalog()), /cannot be retried automatically/);
      assert.equal(session.identity(), null);
      assert.equal(h.calls.length, 1);
      waiting.resolve({ data: started(), error: null });
      assert.deepEqual(await pending, confirmed());
      await assert.rejects(session.target.begin(catalog()), /cannot be retried automatically/);
      assert.equal(h.calls.length, 1);
    });
  }

  for (const [label, configure] of [
    ['RPC error', error => ({ data: started(), error })],
    ['rejected request', error => ({ reject: error })],
    ['synchronous rpc throw', error => ({ rpcThrow: error })],
    ['abortSignal throw', error => ({ abortThrow: error })],
    ['cancelled request', () => ({ reject: new DOMException('local cancellation', 'AbortError') })],
  ]) {
    for (const replace of [false, true]) {
      test(`${replace ? 'replacement' : 'create-only'} begin ${label}: no retry, identity, apply or password reuse`, async () => {
        const session = create(replace);
        const failure = new Error('local request failure');
        const controller = new AbortController();
        if (label === 'cancelled request') controller.abort();
        h.enqueue(configure(failure));
        await assert.rejects(session.target.begin(catalog(), controller.signal), error => {
          if (label === 'RPC error') assert.equal(error.message, 'stub-formatted: local request failure');
          else if (label === 'cancelled request') assert.equal(error.name, 'AbortError');
          else assert.strictEqual(error, failure);
          return true;
        });
        await nextTurn();
        await assert.rejects(session.target.begin(catalog()), /cannot be retried automatically/);
        await assert.rejects(session.target.stage('admins', 0, ''), /has not been confirmed/);
        assert.equal(session.identity(), null);
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0].args.p_admin_password, PASSWORD);
        assert.deepEqual(h.formatted, label === 'RPC error' ? [failure] : []);
        noApply(h);
      });
    }
  }

  for (const [label, mutate] of [
    ['null', () => null], ['array', () => []], ['missing fields', () => ({})],
    ['success false', value => ({ ...value, success: false })],
    ['truthy success', value => ({ ...value, success: 1 })],
    ['wrong scope', value => ({ ...value, scope: 'full-site' })],
    ['complete site', value => ({ ...value, full_site_complete: true })],
    ['missing completion flag', value => { delete value.full_site_complete; return value; }],
    ['invalid job UUID', value => ({ ...value, job_id: 'not-a-uuid' })],
    ['missing job UUID', value => { delete value.job_id; return value; }],
    ['non-string job UUID', value => ({ ...value, job_id: 1 })],
    ['invalid token UUID', value => ({ ...value, job_token: 'not-a-uuid' })],
    ['missing job token', value => { delete value.job_token; return value; }],
    ['non-string job token', value => ({ ...value, job_token: null })],
  ]) {
    test(`begin rejects ${label} without trusting identity or retrying`, async () => {
      const session = create(true);
      h.respond(mutate(started()));
      await assert.rejects(session.target.begin(catalog()), /creation was not confirmed/);
      await assert.rejects(session.target.begin(catalog()), /cannot be retried automatically/);
      await assert.rejects(session.backup(), /has not been confirmed/);
      assert.equal(session.identity(), null);
      assert.equal(h.calls.length, 1);
      noApply(h);
    });
  }

  const invalidDescriptors = [
    ['null', () => null], ['array', () => []],
    ['different job_id/backup_id', value => { value.backup_id = OTHER; }],
    ['missing backup ID', value => { delete value.backup_id; }],
    ['invalid backup ID', value => { value.backup_id = 'invalid'; }],
  ];
  for (const field of ['plan_hash', 'target_hash']) {
    for (const [label, value] of [['missing', undefined], ['non-string', 1], ['short', 'a'.repeat(63)],
      ['uppercase', 'A'.repeat(64)], ['non-hex', 'z'.repeat(64)], ['too long', 'a'.repeat(65)]]) {
      invalidDescriptors.push([`${field} ${label}`, item => { item[field] = value; }]);
    }
  }
  for (const [label, change] of [
    ['null', () => null], ['array', () => []],
    ['missing table', value => { value.tables.pop(); }],
    ['duplicate table', value => { value.tables[6] = { ...value.tables[0] }; }],
    ['unknown table', value => { value.tables[0].key = 'users'; }],
    ['unknown field', value => { value.unreviewed_field = true; }],
    ['unknown table field', value => { value.tables[0].unreviewed_field = true; }],
    ['version', value => { value.version = 2; }],
    ['scope', value => { value.scope = 'full-site'; }],
    ['full_site_complete', value => { value.full_site_complete = true; }],
    ['site UUID', value => { value.site_id = 'invalid'; }],
    ['negative row count', value => { value.tables[0].rows = -1; }],
    ['fractional byte count', value => { value.tables[0].bytes = 0.5; }],
    ['table row limit', value => { value.tables[0].rows = 10001; }],
    ['total byte limit', value => { value.tables[0].bytes = 8 * 1024 * 1024; value.tables[1].bytes = 1; }],
    ['table SHA', value => { value.tables[0].sha256 = 'short'; }],
    ['unreviewed excluded key', value => { value.excluded_system_keys = ['secret']; }],
  ]) {
    invalidDescriptors.push([`catalog ${label}`, value => {
      const changed = change(value.catalog);
      if (changed !== undefined) value.catalog = changed;
    }]);
  }
  for (const [label, mutate] of invalidDescriptors) {
    test(`backup descriptor rejects ${label}, with no page/upload/apply or retry`, async () => {
      const session = create(true);
      await begin(session);
      const value = descriptor();
      const changed = mutate(value);
      h.respond(changed === undefined ? value : changed);
      await assert.rejects(session.backup(), /Invalid replacement backup descriptor|Invalid shared-settings export/);
      assert.deepEqual(h.calls.map(call => call.name), ['employee_import_shared_replace_begin', 'get_employee_import_shared_backup']);
      noApply(h);
    });
  }

  for (const [label, mutate] of [
    ['backup ID', value => { value.backup_id = OTHER; }],
    ['plan hash', value => { value.plan_hash = hash('another plan'); }],
    ['target hash', value => { value.target_hash = hash('another target'); }],
    ['catalog site', value => { value.catalog.site_id = OTHER; }],
    ['catalog rows', value => { value.catalog.tables[0].rows = 1; }],
    ['catalog bytes', value => { value.catalog.tables[0].bytes = 1; }],
    ['catalog table hash', value => { value.catalog.tables[0].sha256 = hash('changed table'); }],
    ['catalog excluded keys', value => { value.catalog.excluded_system_keys = []; }],
  ]) {
    test(`source.verify rejects changed frozen ${label}`, async () => {
      const session = create(true);
      await begin(session);
      const task = await backup(session);
      const changed = descriptor();
      mutate(changed);
      h.respond(changed);
      await assert.rejects(task.source.verify(), /frozen backup identity changed|Invalid replacement backup descriptor/);
      assert.equal(h.calls.length, 3);
      noApply(h);
    });
  }

  test('page and verify remain bound to the captured job and snapshot, not mutable RPC responses or identity copies', async () => {
    const session = create(true);
    await begin(session);
    const server = descriptor();
    h.respond(server);
    const task = await session.backup();
    server.plan_hash = hash('mutated transport response');
    server.catalog.tables[0].sha256 = hash('mutated transport catalog');
    const identity = session.identity();
    identity.jobId = OTHER;
    identity.jobToken = OTHER;
    assert.deepEqual(await task.source.catalog(), descriptor().catalog);
    h.respond(page());
    await task.source.page('admins', 'cursor');
    expectCall(h.calls.at(-1), 'get_employee_import_shared_backup_page', {
      ...auth(), p_table_key: 'admins', p_after: 'cursor', p_limit: 200,
    });
    h.respond(descriptor());
    assert.deepEqual(await task.source.verify(), { verified: true, scope: 'shared-settings', full_site_complete: false });
    expectCall(h.calls.at(-1), 'get_employee_import_shared_backup', auth());
    noApply(h);
  });

  test('separate backup handles keep their own captured plan hashes instead of using the last descriptor read', async () => {
    const session = create(true);
    await begin(session);
    const first = await backup(session);
    const secondDescriptor = descriptor();
    secondDescriptor.plan_hash = hash('second explicitly read plan');
    h.respond(secondDescriptor);
    const second = await session.backup();
    for (const [task, planHash] of [[first, PLAN], [second, secondDescriptor.plan_hash]]) {
      h.respond(chunkAck());
      await task.receiver.append(0, '0001ff');
      expectCall(h.calls.at(-1), 'employee_import_shared_backup_append', {
        ...auth(), p_plan_hash: planHash, p_chunk_no: 0, p_hex: '0001ff',
      });
    }
    h.respond(secondDescriptor);
    await assert.rejects(first.source.verify(), /frozen backup identity changed/);
    noApply(h);
  });

  test('caller mutation of the exposed descriptor cannot retarget an existing receiver', async () => {
    const session = create(true);
    await begin(session);
    const task = await backup(session);
    try { task.descriptor.plan_hash = hash('caller-selected replacement plan'); } catch (error) {
      assert.ok(error instanceof TypeError);
    }
    h.respond(chunkAck());
    await task.receiver.append(0, '0001ff');
    expectCall(h.calls.at(-1), 'employee_import_shared_backup_append', {
      ...auth(), p_plan_hash: PLAN, p_chunk_no: 0, p_hex: '0001ff',
    });
    noApply(h);
  });

  test('caller mutation of the exposed descriptor cannot make verify accept a changed server plan', async () => {
    const session = create(true);
    await begin(session);
    const task = await backup(session);
    const changed = descriptor();
    changed.plan_hash = hash('changed frozen server plan');
    try { task.descriptor.plan_hash = changed.plan_hash; } catch (error) {
      assert.ok(error instanceof TypeError);
    }
    h.respond(changed);
    await assert.rejects(task.source.verify(), /frozen backup identity changed/);
    noApply(h);
  });

  test('caller mutation of source.catalog cannot rewrite the frozen verification baseline', async () => {
    const session = create(true);
    await begin(session);
    const task = await backup(session);
    const exposed = await task.source.catalog();
    try { exposed.tables[0].sha256 = hash('changed frozen table'); } catch (error) {
      assert.ok(error instanceof TypeError);
    }
    const changed = descriptor();
    changed.catalog.tables[0].sha256 = hash('changed frozen table');
    h.respond(changed);
    await assert.rejects(task.source.verify(), /frozen backup identity changed/);
    noApply(h);
  });

  for (const [label, mutate] of [
    ['null', () => null], ['array', () => []], ['empty object', () => ({})],
    ['false success', value => ({ ...value, success: false })],
    ['truthy success', value => ({ ...value, success: 'true' })],
    ['missing bytes', value => { delete value.bytes; return value; }],
    ['non-number bytes', value => ({ ...value, bytes: '3' })],
    ['missing SHA', value => { delete value.sha256; return value; }],
    ['non-string SHA', value => ({ ...value, sha256: 123 })],
    ['missing repeated', value => { delete value.repeated; return value; }],
    ['non-boolean repeated', value => ({ ...value, repeated: 0 })],
  ]) {
    test(`append rejects ${label} acknowledgement without retry, seal or apply`, async () => {
      const session = create(true);
      await begin(session);
      const task = await backup(session);
      h.respond(mutate(chunkAck()));
      await assert.rejects(task.receiver.append(0, '0001ff'), /Invalid backup chunk acknowledgement/);
      assert.equal(h.calls.length, 3);
      assert.equal(h.calls.at(-1).name, 'employee_import_shared_backup_append');
      noApply(h);
    });
  }

  for (const [label, mutate] of [
    ['null', () => null], ['array', () => []], ['empty object', () => ({})],
    ['false success', value => ({ ...value, success: false })],
    ['wrong backup ID', value => ({ ...value, backup_id: OTHER })],
    ['missing backup ID', value => { delete value.backup_id; return value; }],
    ['wrong ciphertext hash', value => ({ ...value, sha256: PLAN })],
    ['missing ciphertext hash', value => { delete value.sha256; return value; }],
    ['wrong bytes', value => ({ ...value, bytes: BYTES + 1 })],
    ['string bytes', value => ({ ...value, bytes: String(BYTES) })],
    ['missing bytes', value => { delete value.bytes; return value; }],
    ['full_site_complete true', value => ({ ...value, full_site_complete: true })],
    ['missing full_site_complete', value => { delete value.full_site_complete; return value; }],
    ['truthy repeated', value => ({ ...value, repeated: 'true' })],
    ['missing repeated', value => { delete value.repeated; return value; }],
  ]) {
    test(`seal rejects ${label} receipt without retry or apply`, async () => {
      const session = create(true);
      await begin(session);
      const task = await backup(session);
      h.respond(mutate(sealAck()));
      await assert.rejects(task.receiver.seal(CIPHER, BYTES), /backup seal was not confirmed/);
      assert.equal(h.calls.length, 3);
      assert.equal(h.calls.at(-1).name, 'employee_import_shared_backup_seal');
      noApply(h);
    });
  }

  test('append and seal accept repeated=true while preserving exact validated acknowledgements', async () => {
    const session = create(true);
    await begin(session);
    const task = await backup(session);
    h.respond({ ...chunkAck(), repeated: true });
    assert.deepEqual(await task.receiver.append(0, '0001ff'), { ...chunkAck(), repeated: true });
    const sealed = { ...sealAck(), repeated: true };
    h.respond(sealed);
    assert.strictEqual(await task.receiver.seal(CIPHER, BYTES), sealed);
    assert.equal(h.calls.length, 4);
    noApply(h);
  });

  async function operation(label) {
    const session = create(true);
    if (label === 'begin') return { session, invoke: signal => session.target.begin(catalog(), signal),
      endpoint: 'employee_import_shared_replace_begin', reply: started() };
    await begin(session);
    if (label === 'stage') return { session, invoke: signal => session.target.stage('admins', 0, '', signal),
      endpoint: 'employee_import_shared_stage', reply: { success: true } };
    if (label === 'dryRun') return { session, invoke: signal => session.target.dryRun(signal),
      endpoint: 'get_employee_import_shared_replace_dry_run', reply: { can_apply: true, plan_hash: PLAN } };
    if (label === 'apply') return { session, invoke: signal => session.apply(PLAN, signal),
      endpoint: 'employee_import_shared_replace_apply', reply: { success: true } };
    if (label === 'backup') return { session, invoke: signal => session.backup(signal),
      endpoint: 'get_employee_import_shared_backup', reply: descriptor() };
    const task = await backup(session);
    if (label === 'page') return { session, invoke: signal => task.source.page('admins', null, signal),
      endpoint: 'get_employee_import_shared_backup_page', reply: page() };
    if (label === 'verify') return { session, invoke: signal => task.source.verify(signal),
      endpoint: 'get_employee_import_shared_backup', reply: descriptor() };
    if (label === 'append') return { session, invoke: signal => task.receiver.append(0, '0001ff', signal),
      endpoint: 'employee_import_shared_backup_append', reply: chunkAck() };
    assert.equal(label, 'seal');
    return { session, invoke: signal => task.receiver.seal(CIPHER, BYTES, signal),
      endpoint: 'employee_import_shared_backup_seal', reply: sealAck() };
  }
  const operations = ['begin', 'stage', 'dryRun', 'apply', 'backup', 'page', 'verify', 'append', 'seal'];
  for (const label of operations) {
    for (const withSignal of [false, true]) {
      test(`${label} ${withSignal ? 'forwards the exact optional abortSignal' : 'does not call abortSignal without a signal'}`, async () => {
        const item = await operation(label);
        const signal = withSignal ? new AbortController().signal : undefined;
        h.respond(item.reply);
        const before = h.calls.length;
        await item.invoke(signal);
        assert.equal(h.calls.length, before + 1);
        const call = h.calls.at(-1);
        assert.equal(call.name, item.endpoint);
        assert.deepEqual(call.signals, signal ? [signal] : []);
        assert.equal(call.awaits, 1);
        assert.equal(call.args.p_admin_session_token, SESSION);
        if (label !== 'begin') assert.equal(call.args.p_job_token, TOKEN);
        assert.equal(h.sessionReads, 1);
        if (label !== 'apply') noApply(h);
      });
    }
    for (const mode of ['error', 'reject', 'cancel']) {
      test(`${label} ${mode} propagates once with no automatic request/retry/apply`, async () => {
        const item = await operation(label);
        const controller = new AbortController();
        const failure = mode === 'cancel' ? new DOMException('local cancellation', 'AbortError') : new Error('local failure');
        if (mode === 'cancel') controller.abort();
        h.enqueue(mode === 'error' ? { data: item.reply, error: failure } : { reject: failure });
        const before = h.calls.length;
        await assert.rejects(item.invoke(controller.signal), error => {
          if (mode === 'error') assert.equal(error.message, 'stub-formatted: local failure');
          else assert.strictEqual(error, failure);
          return true;
        });
        await nextTurn();
        assert.equal(h.calls.length, before + 1);
        assert.equal(h.calls.at(-1).name, item.endpoint);
        assert.deepEqual(h.calls.at(-1).signals, [controller.signal]);
        assert.equal(h.calls.at(-1).awaits, 1);
        assert.deepEqual(h.formatted, mode === 'error' ? [failure] : []);
        if (label !== 'apply') noApply(h);
        else assert.equal(h.calls.filter(call => /_apply$/.test(call.name)).length, 1);
      });
    }
  }

  test('backup initial signal is not reused for later page/verify/append/seal requests', async () => {
    const session = create(true);
    await begin(session);
    const first = new AbortController().signal;
    h.respond(descriptor());
    const task = await session.backup(first);
    assert.deepEqual(h.calls.at(-1).signals, [first]);
    for (const [invoke, reply] of [
      [signal => task.source.page('admins', null, signal), page()],
      [signal => task.source.verify(signal), descriptor()],
      [signal => task.receiver.append(0, '0001ff', signal), chunkAck()],
      [signal => task.receiver.seal(CIPHER, BYTES, signal), sealAck()],
    ]) {
      const ownSignal = new AbortController().signal;
      h.respond(reply);
      await invoke(ownSignal);
      assert.deepEqual(h.calls.at(-1).signals, [ownSignal]);
      h.respond(reply);
      await invoke();
      assert.deepEqual(h.calls.at(-1).signals, []);
    }
    const before = h.calls.length;
    await task.source.catalog(first);
    assert.equal(h.calls.length, before);
    noApply(h);
  });

  test('apply is a separate explicit confirmation and forwards the caller hash, not a cached dry-run/backup hash', async () => {
    const session = create(true);
    await begin(session);
    h.respond({ can_apply: true, plan_hash: hash('dry-run plan') });
    await session.target.dryRun();
    const task = await backup(session);
    h.respond(sealAck());
    await task.receiver.seal(CIPHER, BYTES);
    noApply(h);
    const confirmation = hash('separately confirmed plan');
    const signal = new AbortController().signal;
    const receipt = { success: true, scope: 'shared-settings', full_site_complete: false };
    h.respond(receipt);
    assert.strictEqual(await session.apply(confirmation, signal), receipt);
    expectCall(h.calls.at(-1), 'employee_import_shared_replace_apply', { ...auth(), p_plan_hash: confirmation }, signal);
    assert.equal(h.calls.filter(call => /_apply$/.test(call.name)).length, 1);
    assert.deepEqual(session.identity(), { jobId: JOB, jobToken: TOKEN });
  });
});
