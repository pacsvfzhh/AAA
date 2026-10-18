import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, mock, test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SESSION = '11111111-1111-4111-8111-111111111111';
const PACKAGE = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const TOKEN = '44444444-4444-4444-8444-444444444444';
const SITE = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const PASSWORD = 'never-echo-verification-password-or-backend-text';
const PLAN = 'a'.repeat(64), KEY = 'verification_requests', TIME = '2024-02-29T12:34:56.123456+00:00';
const sha = value => createHash('sha256').update(value).digest('hex');
const flags = () => ({ maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false });
const counts = (n = 1) => ({ verification_requests: n });
const plan = (n = 1, employees = 1) => ({ scope: 'employee-verification', can_restore: true, counts: counts(n), employees, conflicts: [], plan_hash: PLAN, ...flags() });
const verified = () => ({ verified: true, scope: 'employee-verification', full_site_complete: false });
const closed = () => ({ success: true, scope: 'employee-verification', full_site_complete: false });
const bound = () => ({ ...closed(), repeated: false });
const receipt = (n = 1, employees = 1) => ({ ...closed(), counts: counts(n), completed_employees: employees, total_employees: employees, verified: true, repeated: false, ...flags() });
const applied = () => ({ ...receipt(), employee_id: OTHER });
const row = () => ({ id: OTHER, user_id: OTHER, real_name: '原文é 𠮷', wallet_address: 'historically-identity-number', phone: '+123', email: 'historically-address',
  status: 'approved', audit_remark: null, audited_by: null, audited_at: TIME, created_at: TIME, updated_at: null,
  id_front_url: `https://source.supabase.co/storage/v1/object/public/verification-documents/id-front/${OTHER}-old.png`, id_back_url: null, selfie_url: null });
const text = () => JSON.stringify(row()) + '\n';
const ack = (raw = text()) => ({ success: true, rows: raw === '' ? 0 : raw.split('\n').length - 1, bytes: Buffer.byteLength(raw), sha256: sha(raw), repeated: false });
const page = () => ({ table_key: KEY, count: 1, ndjson: text(), next_after: null, sha256: sha(text()) });
function catalog(raw = text(), employees = 1) {
  return { version: 1, scope: 'employee-verification', site_id: SITE, package_id: PACKAGE,
    identity_catalog: { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE,
      tables: ['accounts', 'credentials', 'orders'].map((key, i) => ({ key, rows: i === 0 ? employees : 0, bytes: i === 0 ? employees * 500 : 0, row_hashes_sha256: sha('') })),
      processing_orders: 0, full_site_complete: false },
    tables: [{ key: KEY, rows: raw === '' ? 0 : 1, bytes: Buffer.byteLength(raw), row_hashes_sha256: sha(raw === '' ? '' : sha(raw)) }], full_site_complete: false };
}
const begun = () => ({ ...closed(), job_id: JOB, job_token: TOKEN, site_id: SITE, catalog: catalog() });
const auth = () => ({ p_admin_session_token: SESSION, p_job_token: TOKEN });
const redacted = error => {
  assert.ok(error instanceof Error);
  for (const secret of [PASSWORD, SESSION, TOKEN, row().wallet_address, row().id_front_url]) assert.equal(String(error).includes(secret), false);
  assert.equal('cause' in error, false); return true;
};
const unknown = error => redacted(error) && /unknown or unconfirmed.*reconcile.*No automatic retry, cancel, rollback, restore or close/.test(error.message);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function soon(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('cancellation stalled')), 1500); })]); }
  finally { clearTimeout(timer); }
}
let transport;
mock.method(globalThis, 'fetch', (...args) => {
  assert.ok(transport, 'all production/network access forbidden'); return transport(...args);
});
const logs = ['log', 'info', 'warn', 'error', 'debug'].map(name => mock.method(console, name, () => {}));
after(() => { for (const log of logs) assert.equal(log.mock.callCount(), 0); mock.restoreAll(); });
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/verificationApi.ts';
    export * from './src/lib/employeeTransfer/verificationTransfer.ts'; export { setHarness } from 'verification-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'verification-memory-transport', setup(builder) {
    builder.onResolve({ filter: /^(?:verification-test:state|\.\.\/(?:auth|supabase))$/ }, args => {
      if (args.path.startsWith('..')) assert.equal(args.importer, `${root}src/lib/employeeTransfer/verificationApi.ts`);
      return { path: args.path, namespace: 'verification-test' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'verification-test' }, ({ path }) => {
      if (path === 'verification-test:state') return { contents: 'let h; export const setHarness = v => {h=v;}; export const current = () => h;' };
      if (path === '../auth') return { contents: `import {current} from 'verification-test:state'; export function getAdminFinancialSessionToken() {const h=current();h.reads++;return h.session;}` };
      return { contents: `import {current} from 'verification-test:state'; export const supabase={rpc:(...args)=>current().rpc(...args)};` };
    });
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness() {
  const h = { calls: [], replies: [], reads: 0, session: SESSION,
    respond(data) { h.replies.push({ data }); },
    rpc(name, args) {
      const call = { name, args: structuredClone(args), signals: [], awaits: 0 }; h.calls.push(call);
      assert.ok(h.replies.length, `unexpected RPC ${name}`);
      const result = h.replies.shift(); if (result.throw) throw result.throw;
      const query = { abortSignal(signal) { call.signals.push(signal); return query; }, then(resolve, reject) {
        call.awaits++;
        return Promise.resolve().then(() => { if (result.reject) throw result.reject; return result.wait ?? { data: result.data, error: result.error ?? null }; }).then(resolve, reject);
      } }; return query;
    } };
  api.setHarness(h); return h;
}
async function exported(h) { const s = api.createVerificationExportSession(PACKAGE, PASSWORD); h.respond(begun()); await s.begin(); return s; }
async function imported(h, planned = false) {
  const s = api.createVerificationImportSession(TOKEN); h.respond(bound()); await s.target.bind(catalog());
  if (planned) { h.respond(plan()); await s.plan(); } return s;
}

test('lightweight API imports verification/identity/checks/SHA only, with no media browser, activity, ZIP or Edge dependency', () => {
  const inputs = Object.keys(compiled.metafile.inputs);
  for (const name of ['verificationTransfer', 'verificationApi', 'identityTransfer', 'dispatchTransfer', 'sha256']) assert.ok(inputs.some(path => path.endsWith(`/${name}.ts`)));
  assert.equal(inputs.some(path => /node_modules|\/(?:activityApi|activityTransfer|financeTransfer|api|container|crypto|manifest|.*[Mm]edia.*)\.ts$/.test(path)), false);
});
test('factories validate UUIDs locally and never start implicitly', () => {
  const h = harness();
  for (const value of [null, 'bad', TOKEN + '\n', 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']) {
    assert.throws(() => api.createVerificationExportSession(value, PASSWORD), redacted);
    assert.throws(() => api.createVerificationImportSession(value), redacted);
  }
  h.session = SESSION + '\n';
  assert.throws(() => api.createVerificationExportSession(PACKAGE, PASSWORD)); assert.throws(() => api.createVerificationImportSession(TOKEN));
  assert.equal(h.calls.length, 0);
});
test('export begin is explicit/one-use; public identity and all nested catalog snapshots are isolated', async () => {
  const h = harness(), s = api.createVerificationExportSession(PACKAGE, PASSWORD);
  assert.equal(h.calls.length, 0); assert.equal(h.reads, 1); assert.equal(s.identity(), null);
  await assert.rejects(s.source.catalog(), /not been confirmed/); await assert.rejects(s.close(), /not been confirmed/);
  const raw = begun(); h.respond(raw); const copy = await s.begin();
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_admin_password: PASSWORD, p_package_id: PACKAGE });
  copy.tables[0].rows = 99; copy.identity_catalog.tables[0].rows = 99; raw.catalog.tables[0].rows = 88; s.identity().jobToken = OTHER; h.session = OTHER;
  const next = await s.source.catalog(); assert.deepEqual(next, catalog()); next.identity_catalog.tables[0].row_hashes_sha256 = PLAN;
  assert.deepEqual(await s.source.catalog(), catalog());
  await assert.rejects(s.begin(), /cannot be retried/); await assert.rejects(s.close(), /explicitly verified/);
  h.respond(verified()); await s.source.verify(); h.respond(closed()); await s.close();
  for (const run of [() => s.source.catalog(), () => s.source.page(KEY, null), () => s.source.verify(), () => s.close()]) await assert.rejects(run(), /closed/);
  assert.deepEqual(h.calls.map(c => c.name), ['employee_export_verification_begin', 'employee_export_verification_verify', 'employee_export_verification_close']);
  assert.ok(h.calls.slice(1).every(c => JSON.stringify(c.args) === JSON.stringify(auth())));
});
test('export page uses only verification table, canonical UUID cursor and limit 200; reading invalidates close permission', async () => {
  const h = harness(), s = await exported(h); h.respond(verified()); await s.source.verify(); h.respond(page());
  assert.deepEqual(await s.source.page(KEY, JOB), page());
  assert.deepEqual(h.calls.at(-1).args, { ...auth(), p_table_key: KEY, p_after: JOB, p_limit: 200 });
  await assert.rejects(s.close(), /explicitly verified/);
  const before = h.calls.length;
  for (const [key, after] of [['work_sessions', null], [KEY, 1], [KEY, TOKEN + '\n'], [KEY, 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA']]) await assert.rejects(s.source.page(key, after), redacted);
  assert.equal(h.calls.length, before);
});
test('source verify and close propagate missing-media rejection, never synthesize success or call service-only RPCs', async () => {
  const h = harness(), s = await exported(h);
  h.replies.push({ error: { message: 'Verification media export is incomplete. ' + PASSWORD } });
  await assert.rejects(s.source.verify(), unknown); await assert.rejects(s.close(), /explicitly verified/);
  h.respond(verified()); await s.source.verify();
  h.replies.push({ error: { message: 'Verification media export is incomplete. ' + PASSWORD } });
  await assert.rejects(s.close(), unknown); assert.deepEqual(await s.source.catalog(), catalog());
  h.replies.push({ error: { message: PASSWORD } }); await assert.rejects(s.source.verify(), unknown);
  await assert.rejects(s.close(), /explicitly verified/);
  assert.deepEqual(h.calls.map(c => c.name), ['employee_export_verification_begin', 'employee_export_verification_verify', 'employee_export_verification_verify', 'employee_export_verification_close', 'employee_export_verification_verify']);
});
test('records-only export does not implicitly verify or close before the external media coordinator', async () => {
  const h = harness(), s = await exported(h), stored = [];
  h.respond(page()); const result = await api.exportVerificationData(s.source, { async append(path, raw) { stored.push([path, Buffer.from(raw).toString()]); }, async abort() { assert.fail('unexpected cleanup'); } });
  assert.equal(result.fullSiteComplete, false); assert.deepEqual(stored, [[`data/verification-${KEY}.ndjson`, text()]]);
  assert.deepEqual(h.calls.map(c => c.name), ['employee_export_verification_begin', 'get_employee_export_verification_page']);
  await assert.rejects(s.close(), /explicitly verified/);
});
test('import reuses dispatch token, guards order, stages raw 15-field records and binds approval to exact hash/counts/employees', async () => {
  const h = harness(), s = api.createVerificationImportSession(TOKEN);
  assert.deepEqual(Object.keys(s).sort(), ['target', 'plan', 'apply', 'verify'].sort());
  assert.deepEqual(Object.keys(s.target).sort(), ['bind', 'stage', 'plan'].sort());
  for (const run of [() => s.plan(), () => s.target.stage(KEY, 0, text()), () => s.apply(OTHER, PLAN), () => s.verify()]) await assert.rejects(run());
  const cat = catalog(); h.respond(bound()); await s.target.bind(cat); cat.tables[0].rows = 99; cat.identity_catalog.tables[0].rows = 99;
  assert.deepEqual(h.calls[0].args, { ...auth(), p_catalog: catalog() });
  h.respond(ack()); await s.target.stage(KEY, 0, text()); assert.deepEqual(h.calls.at(-1).args, { ...auth(), p_table_key: KEY, p_chunk_no: 0, p_ndjson: text() });
  const raw = plan(); h.respond(raw); const p = await s.target.plan(); p.plan_hash = 'b'.repeat(64); p.counts[KEY] = 999; raw.employees = 999;
  await assert.rejects(s.apply(OTHER, 'b'.repeat(64)), /conflict-free/); h.respond(applied()); const r = await s.apply(OTHER, PLAN); r.counts[KEY] = 99;
  h.respond(receipt()); await s.verify();
  assert.deepEqual(h.calls[3].args, { ...auth(), p_employee_id: OTHER, p_plan_hash: PLAN });
  assert.deepEqual(h.calls.map(c => c.name), ['employee_import_verification_bind', 'employee_import_verification_stage', 'get_employee_import_verification_plan', 'employee_import_verification_apply', 'employee_import_verification_verify']);
  assert.ok(h.calls.every(c => c.awaits === 1));
});
test('conflicted media plan cannot be mutated into approval; new bind/stage/failed plan discard prior approval', async () => {
  const h = harness(), s = await imported(h), raw = { ...plan(), can_restore: false, conflicts: ['media_incomplete'] };
  h.respond(raw); const p = await s.plan(); p.can_restore = true; p.conflicts.length = 0; raw.conflicts.length = 0;
  await assert.rejects(s.apply(OTHER, PLAN), /conflict-free/); await assert.rejects(s.verify(), /conflict-free/);
  for (const mode of ['stage', 'bind', 'plan']) {
    h.respond(plan()); await s.plan();
    if (mode === 'stage') { h.respond(ack()); await s.target.stage(KEY, 0, text()); }
    if (mode === 'bind') { h.respond(bound()); await s.target.bind(catalog()); }
    if (mode === 'plan') { h.respond({ ...plan(), employees: 2 }); await assert.rejects(s.plan(), unknown); }
    await assert.rejects(s.apply(OTHER, PLAN), /conflict-free/); await assert.rejects(s.verify(), /conflict-free/);
  }
});
for (const [label, edit] of [
  ['counts', p => { p.counts[KEY]++; }], ['employees', p => { p.employees++; }], ['activity-only running field', p => { p.running_work_sessions = 0; }],
  ['wrong scope', p => { p.scope = 'employee-activity'; }], ['unknown conflict', p => { p.can_restore = false; p.conflicts = [PASSWORD]; }],
]) test(`plan rejects ${label} and cannot authorize apply`, async () => {
  const h = harness(), s = await imported(h), p = plan(); edit(p); h.respond(p);
  await assert.rejects(s.plan(), unknown); await assert.rejects(s.apply(OTHER, PLAN), /conflict-free/);
});
test('catalog binding is immutable across every identity fingerprint, package and record digest', async () => {
  const h = harness(), s = await imported(h), before = h.calls.length;
  for (const edit of [c => { c.package_id = JOB; c.identity_catalog.package_id = JOB; }, c => { c.site_id = JOB; c.identity_catalog.site_id = JOB; },
    c => { c.tables[0].row_hashes_sha256 = PLAN; }, ...[0, 1, 2].map(i => c => { c.identity_catalog.tables[i].row_hashes_sha256 = PLAN; })]) {
    const c = catalog(); edit(c); await assert.rejects(s.target.bind(c), /immutable/);
  }
  assert.equal(h.calls.length, before);
});
for (const [kind, label, edit] of [
  ['apply', 'employee', r => { r.employee_id = JOB; }], ['apply', 'excess counts', r => { r.counts[KEY] = 2; }], ['apply', 'total employees', r => { r.total_employees = 2; }],
  ['verify', 'global counts', r => { r.counts[KEY] = 0; }], ['verify', 'incomplete', r => { r.completed_employees = 0; }], ['verify', 'unexpected employee', r => { r.employee_id = OTHER; }],
]) test(`${kind} rejects mismatched real receipt: ${label}`, async () => {
  const h = harness(), s = await imported(h, true), r = kind === 'apply' ? applied() : receipt(); edit(r); h.respond(r);
  await assert.rejects(kind === 'apply' ? s.apply(OTHER, PLAN) : s.verify(), unknown);
});
for (const field of Object.keys(flags())) test(`unsafe ${field} never accepted in plan or committed receipt`, async () => {
  for (const kind of ['plan', 'apply', 'verify']) {
    const h = harness(), s = await imported(h, kind !== 'plan'), r = kind === 'plan' ? plan() : kind === 'apply' ? applied() : receipt(); r[field] = !r[field]; h.respond(r);
    await assert.rejects(kind === 'plan' ? s.plan() : kind === 'apply' ? s.apply(OTHER, PLAN) : s.verify(), unknown);
  }
});
test('empty histories still apply to each employee and verify exact global counts without inventing records', async () => {
  const h = harness(), s = api.createVerificationImportSession(TOKEN); h.respond(bound()); await s.target.bind(catalog('', 3));
  h.respond(ack('')); await s.target.stage(KEY, 0, ''); await assert.rejects(s.target.stage(KEY, 1, ''));
  h.respond(plan(0, 3)); await s.plan(); h.respond({ ...receipt(0, 3), completed_employees: 1, employee_id: OTHER }); await s.apply(OTHER, PLAN);
  h.respond(receipt(0, 3)); await s.verify();
});
test('invalid staging/employee/hash arguments fail locally; exact UTF8 bytes and SHA are checked against acknowledgement', async () => {
  const h = harness(), s = await imported(h), before = h.calls.length;
  for (const [key, no, raw] of [[KEY, 0, ''], ['work_sessions', 0, text()], [KEY, -1, text()], [KEY, 500001, text()], [KEY, 0, text().trimEnd()],
    [KEY, 0, text().repeat(201)], [KEY, 0, 'é'.repeat(131073)], [KEY, 0, text().replace('{', '{"status":"pending",')]]) await assert.rejects(s.target.stage(key, no, raw), redacted);
  assert.equal(h.calls.length, before);
  for (const field of ['rows', 'bytes', 'sha256', 'success']) {
    const r = ack(); r[field] = field === 'sha256' ? PLAN : field === 'success' ? false : r[field] + 1; h.respond(r);
    await assert.rejects(s.target.stage(KEY, 0, text()), unknown);
  }
  h.respond(plan()); await s.plan(); const afterPlan = h.calls.length;
  for (const [employee, hash] of [[OTHER + '\n', PLAN], [OTHER, PLAN + '\n'], [OTHER, 'A'.repeat(64)]]) await assert.rejects(s.apply(employee, hash), redacted);
  assert.equal(h.calls.length, afterPlan);
});
test('fresh factory resumes original server task through explicit rebind/replan/repeated apply, without enable or maintenance release', async () => {
  const h = harness(), first = await imported(h, true); h.respond(applied()); await first.apply(OTHER, PLAN);
  const next = api.createVerificationImportSession(TOKEN); assert.equal(h.calls.length, 3); await assert.rejects(next.apply(OTHER, PLAN));
  h.respond({ ...bound(), repeated: true }); await next.target.bind(catalog()); h.respond(plan()); await next.plan();
  h.respond({ ...applied(), repeated: true }); assert.equal((await next.apply(OTHER, PLAN)).repeated, true);
  h.respond(receipt()); assert.deepEqual(await next.verify(), receipt());
  assert.equal(h.calls.some(c => /begin|cancel|finish|enable|close|maintenance|rollback|finalize|media/.test(c.name)), false);
});
const operations = {
  begin: async () => { const s = api.createVerificationExportSession(PACKAGE, PASSWORD); return { s, run: signal => s.begin(signal), good: begun() }; },
  page: async h => { const s = await exported(h); return { s, run: signal => s.source.page(KEY, null, signal), good: page() }; },
  exportVerify: async h => { const s = await exported(h); return { s, run: signal => s.source.verify(signal), good: verified() }; },
  close: async h => { const s = await exported(h); h.respond(verified()); await s.source.verify(); return { s, run: signal => s.close(signal), good: closed() }; },
  bind: async () => { const s = api.createVerificationImportSession(TOKEN); return { s, run: signal => s.target.bind(catalog(), signal), good: bound() }; },
  stage: async h => { const s = await imported(h); return { s, run: signal => s.target.stage(KEY, 0, text(), signal), good: ack() }; },
  plan: async h => { const s = await imported(h, true); return { s, run: signal => s.plan(signal), good: plan() }; },
  apply: async h => { const s = await imported(h, true); return { s, run: signal => s.apply(OTHER, PLAN, signal), good: applied() }; },
  verify: async h => { const s = await imported(h, true); return { s, run: signal => s.verify(signal), good: receipt() }; },
};
for (const [name, setup] of Object.entries(operations)) {
  for (const mode of ['rpcThrow', 'promiseReject', 'expired', 'getter', 'extra', 'invalid']) test(`${name}: ${mode} is redacted/unconfirmed, with one attempt and no implicit followup`, async () => {
    const h = harness(), { s, run, good } = await setup(h), before = h.calls.length;
    let getterReads = 0;
    if (mode === 'rpcThrow') h.replies.push({ throw: Error(PASSWORD) });
    if (mode === 'promiseReject') h.replies.push({ reject: Error(PASSWORD) });
    if (mode === 'expired') h.replies.push({ error: { message: 'Administrator session has expired. ' + PASSWORD, details: SESSION, hint: row().id_front_url }, data: good });
    if (mode === 'getter') { Object.defineProperty(good, Object.keys(good)[0], { enumerable: true, get() { getterReads++; throw Error(PASSWORD); } }); h.respond(good); }
    if (mode === 'extra') h.respond({ ...good, secret: PASSWORD });
    if (mode === 'invalid') h.respond(null);
    await assert.rejects(run(), unknown); assert.equal(h.calls.length, before + 1); assert.equal(h.replies.length, 0);
    assert.equal(getterReads, 0, 'response accessors must not execute, even when errors are redacted');
    if (name === 'begin') { assert.equal(s.identity(), null); await assert.rejects(run(), /cannot be retried/); }
    if (name === 'plan') await assert.rejects(s.apply(OTHER, PLAN), /conflict-free/);
    if (name === 'apply' || name === 'verify') await assert.rejects(s.target.stage(KEY, 0, text()), /restore was attempted/);
    assert.equal(h.calls.length, before + 1);
  });
  test(`${name}: abort cannot prove rollback; prompt unknown-result error, no late state or automatic retry`, async () => {
    const h = harness(), { s, run, good } = await setup(h), gate = deferred(), c = new AbortController(), before = h.calls.length;
    h.replies.push({ wait: gate.promise }); const pending = run(c.signal); await nextTurn();
    c.abort(PASSWORD); await assert.rejects(soon(pending), e => e.name === 'AbortError' && unknown(e));
    gate.resolve({ data: good, error: null }); await nextTurn();
    assert.equal(h.calls.length, before + 1); assert.deepEqual(h.calls.at(-1).signals, [c.signal]);
    if (name === 'begin') { assert.equal(s.identity(), null); await assert.rejects(run(), /cannot be retried/); }
    if (name === 'bind') await assert.rejects(s.plan(), /not been confirmed/);
    if (name === 'plan') await assert.rejects(s.apply(OTHER, PLAN), /conflict-free/);
    if (name === 'exportVerify') await assert.rejects(s.close(), /explicitly verified/);
    if (name === 'apply' || name === 'verify') await assert.rejects(s.target.stage(KEY, 0, text()), /restore was attempted/);
    assert.equal(h.calls.length, before + 1);
  });
  test(`${name}: pre-abort sends no RPC or private abort reason`, async () => {
    const h = harness(), { run } = await setup(h), c = new AbortController(), before = h.calls.length; c.abort(PASSWORD);
    await assert.rejects(run(c.signal), e => e.name === 'AbortError' && redacted(e)); assert.equal(h.calls.length, before);
    if (name === 'begin') await assert.rejects(run(), /cannot be retried/);
  });
}
for (const [label, edit] of [['site', v => { v.site_id = JOB; }], ['package', v => { v.catalog.package_id = JOB; v.catalog.identity_catalog.package_id = JOB; }],
  ['success', v => { v.success = false; }], ['token', v => { v.job_token += '\n'; }]]) test(`begin rejects mismatched ${label} and consumes password once`, async () => {
  const h = harness(), s = api.createVerificationExportSession(PACKAGE, PASSWORD), raw = begun(); edit(raw); h.respond(raw);
  await assert.rejects(s.begin(), unknown); assert.equal(s.identity(), null); await assert.rejects(s.begin(), /cannot be retried/); assert.equal(h.calls.length, 1);
});
test('all export/import methods are mutually exclusive, including local catalog access while requests are pending', async () => {
  const h = harness(), s = api.createVerificationExportSession(PACKAGE, PASSWORD), gate = deferred(); h.replies.push({ wait: gate.promise });
  const pending = s.begin(); await assert.rejects(s.begin(), /cannot be retried/);
  for (const run of [() => s.source.catalog(), () => s.source.page(KEY, null), () => s.source.verify(), () => s.close()]) await assert.rejects(run(), /already in progress/);
  gate.resolve({ data: begun(), error: null }); await pending;
  const i = await imported(h), g = deferred(); h.replies.push({ wait: g.promise }); const planning = i.plan();
  for (const run of [() => i.plan(), () => i.target.bind(catalog()), () => i.target.stage(KEY, 0, text()), () => i.apply(OTHER, PLAN), () => i.verify()]) await assert.rejects(run(), /already in progress/);
  g.resolve({ data: plan(), error: null }); await planning;
});

const sql = (await Promise.all(['21_export_stage_employee_verification', '22_restore_employee_verification_media']
  .map(name => readFile(`${root}supabase/migrations/202611020000${name}.sql`, 'utf8')))).join('\n');
const sqlRpcs = [...sql.matchAll(/CREATE FUNCTION public\.([a-z_]+)\(([^)]*)\)/g)];
const supabaseText = await readFile(`${root}src/lib/supabase.ts`, 'utf8');
const transportBuild = await build({
  stdin: { contents: supabaseText + '\nexport { getRequestTimeout, isReadOnlyRpcRequest };', resolveDir: `${root}src/lib`, loader: 'ts' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020',
  define: { 'import.meta.env.VITE_SUPABASE_URL': '"https://offline.invalid"', 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"offline-test"' },
  plugins: [{ name: 'no-supabase-network-client', setup(builder) {
    builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'client', namespace: 'offline' }));
    builder.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents: 'export const createClient = (_url, _key, options) => ({ testFetch: options.global.fetch });' }));
  } }],
});
const transportApi = await import(`data:text/javascript;base64,${Buffer.from(transportBuild.outputFiles[0].text).toString('base64')}`);
const url = name => `https://offline.invalid/rest/v1/rpc/${name}`;
test('SQL21/22 all 13 RPC arguments and exact returned types match, including nullable service-only media metadata', () => {
  assert.equal(sqlRpcs.length, 13);
  const virtualPath = `${root}verification-api-typecheck.virtual.ts`;
  const contracts = `import type { Database } from './src/types/database';
    import type { VerificationCatalog, VerificationPlan, VerificationApplyReceipt, VerificationVerifyReceipt } from './src/lib/employeeTransfer/verificationTransfer';
    import type { VerificationExportSession, VerificationImportSession } from './src/lib/employeeTransfer/verificationApi';
    import { createVerificationExportSession, createVerificationImportSession } from './src/lib/employeeTransfer/verificationApi';
    type F = Database['public']['Functions'];
    type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
    type Same<A,B> = Equal<{[K in keyof A]:A[K]}, {[K in keyof B]:B[K]}>;
    type Assert<T extends true> = T;
    type File = {key:string;source_url:string;bytes:number;sha256:string;content_type:'image/jpeg'|'image/png'|'image/gif'|'image/webp'|'application/pdf'};
    type Ref = {key:string;source_url:string;bucket:'verification-documents';path:string;file:File|null};
    type Returns = {
      employee_export_verification_begin: {success:true;job_id:string;job_token:string;site_id:string;catalog:VerificationCatalog;scope:'employee-verification';full_site_complete:false}
        | {success:false;error:'Invalid credentials'} | {success:false;error:'Account is temporarily locked.';locked_until:string};
      get_employee_export_verification_page: {table_key:'verification_requests';count:number;ndjson:string;next_after:string|null;sha256:string};
      employee_export_verification_verify: {verified:true;scope:'employee-verification';full_site_complete:false};
      employee_export_verification_close: {success:true;scope:'employee-verification';full_site_complete:false};
      employee_import_verification_bind: {success:true;scope:'employee-verification';full_site_complete:false;repeated:boolean};
      employee_import_verification_stage: {success:true;rows:number;bytes:number;sha256:string;repeated:boolean};
      get_employee_transfer_verification_media: {scope:'employee-verification-media';direction:'export'|'import';files:Ref[];full_site_complete:false};
      employee_import_verification_media_bind: {success:true;scope:'employee-verification-media';files:number;bytes:number;repeated:boolean;full_site_complete:false};
      employee_transfer_verification_media_authorize: Ref & {direction:'export'|'import'};
      employee_transfer_verification_media_commit: {success:true;key:string;bytes:number;sha256:string;content_type:File['content_type'];full_site_complete:false};
      get_employee_import_verification_plan: VerificationPlan;
      employee_import_verification_apply: VerificationApplyReceipt;
      employee_import_verification_verify: VerificationVerifyReceipt;
    };
    ${sqlRpcs.map(([, name, args], i) => {
      const fields = args.split(',').map(arg => {
        const [, key, sqlType, defaultValue] = /^\s*(\w+)\s+(uuid|text|integer|jsonb)(?:\s+DEFAULT\s+(\w+))?\s*$/i.exec(arg) ?? [];
        assert.ok(key, arg);
        let type = sqlType === 'integer' ? 'number' : sqlType === 'jsonb' ? key === 'p_catalog' ? 'VerificationCatalog' : 'File[]' : 'string';
        if (key === 'p_table_key') type = "'verification_requests'";
        if (key === 'p_direction') type = "'export'|'import'";
        if (key === 'p_action') type = "'download'|'recheck-export'|'upload'|'recheck-import'";
        if (key === 'p_content_type') type = "File['content_type']";
        if (defaultValue === 'NULL') type += '|null';
        return `${key}${defaultValue ? '?' : ''}:${type}`;
      });
      return `type Args${i} = Assert<Same<F['${name}']['Args'],{${fields.join(';')}}>>;
        type Returns${i} = Assert<Same<F['${name}']['Returns'],Returns['${name}']>>;`;
    }).join('\n')}
    type ExportFactory = Assert<Same<ReturnType<typeof createVerificationExportSession>,VerificationExportSession>>;
    type ImportFactory = Assert<Same<ReturnType<typeof createVerificationImportSession>,VerificationImportSession>>;
    type NoRunning = Assert<Equal<Extract<'running_work_sessions', keyof F['get_employee_import_verification_plan']['Returns']>,never>>;`;
  const options = { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: ['vite/client'] };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, ...args) => path === virtualPath ? ts.createSourceFile(path, contracts, options.target, true) : original(path, ...args);
  const program = ts.createProgram([virtualPath], options, host), diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: p => p, getNewLine: () => '\n' }));
});
test('source verify/close retain SQL media gates and service-only grants stay separate', () => {
  for (const name of ['verify', 'close']) {
    const body = sql.split(`CREATE FUNCTION public.employee_export_verification_${name}(`)[1].split('\n$$;')[0];
    assert.match(body, /PERFORM private\.employee_transfer_check_verification_media_export\(v_job\)/);
  }
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.employee_transfer_verification_media_authorize[^;]+TO service_role;/);
});
for (const [, name] of sqlRpcs) test(`${name}: 120s for string/URL/Request; only genuine get reads retryable`, () => {
  for (const input of [url(name), new URL(url(name) + '?x=1'), new Request(url(name))]) assert.equal(transportApi.getRequestTimeout(input), 120000);
  assert.equal(transportApi.getRequestTimeout(url(name + '_unrelated')), 8000);
  assert.equal(transportApi.isReadOnlyRpcRequest(url(name), 'POST'), name.startsWith('get_') && name !== 'get_employee_import_verification_plan');
});
test('employee-transfer-media receives 120s, without POST replay', async () => {
  for (const input of ['https://offline.invalid/functions/v1/employee-transfer-media', new URL('https://offline.invalid/functions/v1/employee-transfer-media?action=download'), new Request('https://offline.invalid/functions/v1/employee-transfer-media')]) assert.equal(transportApi.getRequestTimeout(input), 120000);
  assert.equal(transportApi.getRequestTimeout('https://offline.invalid/functions/v1/employee-transfer-media-extra'), 8000);
  let attempts = 0; transport = async () => { attempts++; return new Response('', { status: 503 }); };
  try { assert.equal((await transportApi.supabase.testFetch('https://offline.invalid/functions/v1/employee-transfer-media', { method: 'POST', body: '{"action":"upload"}' })).status, 503); }
  finally { transport = undefined; }
  assert.equal(attempts, 1);
});
test('write RPCs and get-named plan use one actual fetch attempt for 503/network failure, never XHR fallback', async () => {
  for (const [, name] of sqlRpcs.filter(([, name]) => !name.startsWith('get_') || name === 'get_employee_import_verification_plan')) {
    for (const mode of ['status', 'network']) {
      let attempts = 0; transport = async () => { attempts++; if (mode === 'network') throw new TypeError('Failed to fetch'); return new Response('', { status: 503 }); };
      try {
        const pending = transportApi.supabase.testFetch(url(name), { method: 'POST', body: '{}' });
        if (mode === 'network') await assert.rejects(pending, { name: 'SupabaseNetworkError' }); else assert.equal((await pending).status, 503);
      } finally { transport = undefined; }
      assert.equal(attempts, 1, name);
    }
  }
  assert.equal(transportApi.isReadOnlyRpcRequest(url('GET_EMPLOYEE_IMPORT_VERIFICATION_PLAN'), 'POST'), false);
});
test('other get reads and HTTP GET still retry; older mutating-plan exceptions stay excluded', async () => {
  for (const [endpoint, method] of [[url('get_employee_export_verification_page'), 'POST'], [url('get_employee_transfer_verification_media'), 'POST'], ['https://offline.invalid/rest/v1/users', 'GET']]) {
    let attempts = 0; transport = async () => new Response('', { status: ++attempts === 1 ? 503 : 200 });
    try { assert.equal((await transportApi.supabase.testFetch(endpoint, { method })).status, 200); } finally { transport = undefined; }
    assert.equal(attempts, 2);
  }
  for (const name of ['get_or_create_service_session', 'get_employee_import_dispatch_configuration_plan', 'get_employee_import_identity_plan',
    'get_employee_import_dispatch_dependency_plan', 'get_employee_import_finance_plan', 'get_employee_import_activity_plan']) assert.equal(transportApi.isReadOnlyRpcRequest(url(name), 'POST'), false);
});
