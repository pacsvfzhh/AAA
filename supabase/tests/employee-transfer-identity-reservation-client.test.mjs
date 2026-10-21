import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const id = n => `48000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SESSION = id(1), TOKEN = id(2), JOB = id(3), SITE = id(4), SOURCE_SITE = id(5), PACKAGE = id(6);
const CANDIDATE = id(7), HISTORICAL = id(8), SOURCE = id(20), PREVIOUS = id(19);
const SOURCE_HASH = 'a'.repeat(64), TARGET_HASH = 'b'.repeat(64), BINDING_HASH = 'c'.repeat(64), OTHER_HASH = 'd'.repeat(64);
const SECRET = 'private-session-job-token-password-source-row-must-not-leak';
const STATUS = 'employee_import_identity_reservation_status', RESERVE = 'employee_import_identity_reserve';
const GATES = ['can_restore', 'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete'];
const IDENTITIES = ['job_id', 'site_id', 'source_site_id', 'package_id'];
const CHECKPOINT_KEYS = [...IDENTITIES, 'source_id', 'source_fingerprint', 'target_fingerprint'];
const BARRIERS = ['complete_employee_backup_missing', 'identity_mapping_missing', 'maintenance_blocks_existing_archive'];
let forbiddenNetwork = 0;
mock.method(globalThis, 'fetch', () => { forbiddenNetwork++; assert.fail('network/formal services forbidden'); });
after(() => { assert.equal(forbiddenNetwork, 0); mock.restoreAll(); });

const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/employeeIdentityReservation.ts'; export {setHarness} from 'reservation-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'isolated-identity-reservation', setup(builder) {
    builder.onResolve({ filter: /^(?:reservation-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'reservation-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'reservation-test' }, ({ path }) => ({ contents: path === 'reservation-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth'
        ? 'import{current}from"reservation-test:state";export function getAdminFinancialSessionToken(){const h=current();h.reads++;h.onAuth?.();if(h.authError)throw h.authError;return h.session;}'
        : 'import{current}from"reservation-test:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const redacted = error => {
  assert.ok(error instanceof Error);
  for (const secret of [SECRET, SESSION, TOKEN, SOURCE, SOURCE_HASH, BINDING_HASH]) assert.equal(String(error).includes(secret), false);
  assert.equal('cause' in error, false); assert.equal('details' in error, false); assert.equal('hint' in error, false);
  return true;
};
const aborted = error => redacted(error) && error.name === 'AbortError';
function observed() {
  return {
    scope: 'employee-replacement', checked: true, job_id: JOB, source_site_id: SOURCE_SITE, package_id: PACKAGE,
    after: null, limit: 1, next_after: null, total_sources: 1, counts: { sources: 1, conflicts: 1, archived: 0 },
    rows: [{ source_id: SOURCE, username: 'same-name', source_employee_no: 'SOURCE-NUMBER',
      targets: [{ target_id: HISTORICAL, username: 'same-name', employee_no: 'TARGET-NUMBER', archived: false,
        archive_record_id: null, archive_evidence: false, available_balance: '12345678901234567890.12345678901234567890',
        frozen_balance: '0.00000000000000000001', pending_withdrawals: 1, pending_amount: '0.00000000000000000001',
        completed_orders: 3, chat: 2, login: 1, last_login: '2024-02-29T00:00:00.123456+00:00',
        fingerprint: OTHER_HASH, username_released: false, employee_no_released: false }],
      blockers: [...BARRIERS], backup_required: true, can_archive: false }],
    source_fingerprint: SOURCE_HASH, target_fingerprint: TARGET_HASH, backup_required: true,
    username_released: false, employee_no_released: false, source_employee_no_released: true,
    maintenance: true, can_archive: false, can_replace: false, complete_employee_backup_missing: true,
    identity_mapping_missing: true, full_site_complete: false,
  };
}
const checkpoint = () => ({ job_id: JOB, site_id: SITE, source_site_id: SOURCE_SITE, package_id: PACKAGE,
  source_id: SOURCE, source_fingerprint: SOURCE_HASH, target_fingerprint: TARGET_HASH });
function status(reserved = false) {
  return { scope: 'employee-identity-reservation', checked: true,
    job_id: JOB, site_id: SITE, source_site_id: SOURCE_SITE, package_id: PACKAGE, source_id: SOURCE,
    observed: observed(), reservation: reserved ? { ...checkpoint(), version: 1, target_id: CANDIDATE, binding_hash: BINDING_HASH } : null,
    source_unchanged: reserved, target_unchanged: reserved, candidate_available: reserved,
    can_restore: false, complete_employee_backup: false, can_archive: false, can_replace: false, full_site_complete: false };
}
function harness() {
  const h = { session: SESSION, calls: [], replies: [], reads: 0, authError: null, onAuth: null,
    respond(data) { h.replies.push({ data }); },
    rpc(name, args) {
      assert.ok([STATUS, RESERVE].includes(name), `forbidden RPC: ${name}`);
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
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const turn = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
const invoke = (session, operation, signal) => operation === 'status' ? session.status(SOURCE, signal) : session.reserve(checkpoint(), signal);

// The entire browser dependency graph is bundled, with auth and Supabase replaced before evaluation.
test('only status/reserve and pure validation/checkpoint exports, with no restore/archive/deployment dependency', () => {
  assert.deepEqual(Object.keys(api).sort(), ['createEmployeeIdentityReservationSession', 'employeeIdentityReservationCheckpoint', 'setHarness', 'validateEmployeeIdentityReservationStatus']);
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN);
  assert.deepEqual(Object.keys(s).sort(), ['reserve', 'status']); assert.equal(h.reads, 0); assert.equal(h.calls.length, 0);
  const inputs = Object.keys(compiled.metafile.inputs);
  assert.ok(inputs.includes('src/lib/employeeTransfer/employeeReplacement.ts'));
  assert.equal(inputs.some(path => /node_modules|(?:^|\/)src\/lib\/(?:auth|supabase)\.ts$|\/(?:api|identityApi|identityTransfer|employeeIdentityProjection|employeeSafetyBackup|container|crypto)\.ts$/.test(path)), false);
});
test('exactly one request per call, fresh admin token, signal forwarded, never a client target ID', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), signal = new AbortController().signal;
  h.respond(status()); const checked = await s.status(SOURCE, signal);
  assert.deepEqual(checked, status());
  assert.deepEqual(h.calls[0], { name: STATUS, args: { p_admin_session_token: SESSION, p_job_token: TOKEN, p_source_id: SOURCE }, signals: [signal] });
  h.session = id(30); h.respond(status(true)); const saved = await s.reserve(api.employeeIdentityReservationCheckpoint(checked), signal);
  assert.deepEqual(h.calls[1], { name: RESERVE, args: { p_admin_session_token: id(30), p_job_token: TOKEN,
    p_source_id: SOURCE, p_source_fingerprint: SOURCE_HASH, p_target_fingerprint: TARGET_HASH }, signals: [signal] });
  assert.equal(saved.reservation.target_id, CANDIDATE); assert.equal(h.calls.length, 2); assert.equal(h.reads, 2);
  for (const gate of GATES) assert.equal(saved[gate], false);
});
test('checkpoint is exact, frozen, detached, and derived from current validated observation even after drift', () => {
  const h = harness(), input = status(true); input.observed.source_fingerprint = OTHER_HASH; input.source_unchanged = false;
  input.observed.target_fingerprint = BINDING_HASH; input.target_unchanged = false;
  const cp = api.employeeIdentityReservationCheckpoint(input);
  assert.deepEqual(Object.keys(cp).sort(), [...CHECKPOINT_KEYS].sort()); assert.equal(Object.isFrozen(cp), true);
  assert.deepEqual(cp, { ...checkpoint(), source_fingerprint: OTHER_HASH, target_fingerprint: BINDING_HASH });
  assert.throws(() => { cp.source_fingerprint = SOURCE_HASH; }, TypeError);
  input.job_id = id(80); input.observed.source_fingerprint = SOURCE_HASH; input.reservation.target_id = id(81);
  assert.equal(cp.job_id, JOB); assert.equal(cp.source_fingerprint, OTHER_HASH); assert.equal(h.calls.length, 0);
});
test('validated copies preserve SQL37 money and microseconds without retaining raw mutable references', () => {
  harness(); const input = status(true), result = api.validateEmployeeIdentityReservationStatus(input);
  assert.deepEqual(result, input); assert.equal(Object.isFrozen(result.reservation), true);
  result.observed.rows[0].targets[0].available_balance = '0'; result.observed.rows[0].blockers.pop();
  assert.equal(input.observed.rows[0].targets[0].available_balance, '12345678901234567890.12345678901234567890');
  assert.equal(input.observed.rows[0].blockers.length, 3); input.reservation.binding_hash = OTHER_HASH;
  assert.equal(result.reservation.binding_hash, BINDING_HASH);
});
test('one-row previous-source cursor is accepted without pretending the client knows the staged predecessor', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), r = status();
  r.observed.after = PREVIOUS; r.observed.total_sources = 3; r.observed.next_after = SOURCE;
  h.respond(r); assert.deepEqual(await s.status(SOURCE), r); assert.equal(h.calls.length, 1);
});
test('fresh source with no target or blockers can obtain a candidate without claiming a backup', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), r = status(true), p = r.observed;
  p.rows[0].targets = []; p.rows[0].blockers = []; p.rows[0].backup_required = false;
  p.counts.conflicts = 0; p.backup_required = false; p.username_released = true; p.employee_no_released = true;
  h.respond(r); const result = await s.reserve(checkpoint());
  assert.equal(result.observed.backup_required, false); for (const gate of GATES) assert.equal(result[gate], false);
});
for (const sourceDrift of [false, true]) for (const targetDrift of [false, true]) for (const available of [false, true]) {
  test(`status faithfully reports source drift=${sourceDrift}, target drift=${targetDrift}, available=${available}`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), r = status(true);
    if (sourceDrift) r.observed.source_fingerprint = OTHER_HASH;
    if (targetDrift) r.observed.target_fingerprint = OTHER_HASH;
    r.source_unchanged = !sourceDrift; r.target_unchanged = !targetDrift; r.candidate_available = available;
    h.respond(r); const result = await s.status(SOURCE);
    assert.deepEqual(result, r); assert.equal(result.reservation.source_fingerprint, SOURCE_HASH);
    for (const gate of GATES) assert.equal(result[gate], false);
    assert.equal(h.calls.length, 1);
  });
}
for (const field of ['source_unchanged', 'target_unchanged', 'candidate_available']) {
  test(`null reservation rejects a premature ${field} claim`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), r = status(); r[field] = true; h.respond(r);
    await assert.rejects(s.status(SOURCE), redacted); assert.equal(h.calls.length, 1);
  });
}
const malformed = [
  ['wrong scope', r => { r.scope = 'employee-identity'; }], ['unchecked', r => { r.checked = false; }],
  ['extra envelope key', r => { r.restored = true; }], ['missing reservation', r => { delete r.reservation; }],
  ['undefined reservation', r => { r.reservation = undefined; }], ['array reservation', r => { r.reservation = []; }],
  ['extra reservation key', r => { r.reservation.public_users_reserved = true; }],
  ['missing binding hash', r => { delete r.reservation.binding_hash; }], ['wrong reservation version', r => { r.reservation.version = 2; }],
  ['string reservation version', r => { r.reservation.version = '1'; }], ['invalid target UUID', r => { r.reservation.target_id = SECRET; }],
  ['newline target UUID', r => { r.reservation.target_id += '\n'; }], ['uppercase target UUID', r => { r.reservation.target_id = id(0xab).toUpperCase(); }],
  ['wrong binding hash', r => { r.reservation.binding_hash = SECRET; }], ['newline binding hash', r => { r.reservation.binding_hash += '\n'; }],
  ['uppercase source hash', r => { r.reservation.source_fingerprint = SOURCE_HASH.toUpperCase(); }],
  ['numeric target hash', r => { r.reservation.target_fingerprint = 1; }],
  ['source unchanged lie', r => { r.source_unchanged = false; }], ['target unchanged lie', r => { r.target_unchanged = false; }],
  ['source drift hidden', r => { r.observed.source_fingerprint = OTHER_HASH; }],
  ['target drift hidden', r => { r.observed.target_fingerprint = OTHER_HASH; }],
  ['missing observed', r => { delete r.observed; }], ['extra observed key', r => { r.observed.can_restore = false; }],
  ['observed page limit not one', r => { r.observed.limit = 100; }], ['observed empty page', r => {
    r.observed.after = SOURCE; r.observed.rows = []; r.observed.counts = { sources: 0, conflicts: 0, archived: 0 };
    r.observed.backup_required = false; r.observed.username_released = true; r.observed.employee_no_released = true;
  }],
  ['observed wrong source', r => { r.observed.rows[0].source_id = id(21); }],
  ['observed cursor equal source', r => { r.observed.after = SOURCE; r.observed.total_sources = 2; }],
  ['observed cursor after source', r => { r.observed.after = id(21); r.observed.total_sources = 2; }],
  ['observed invalid counts', r => { r.observed.counts.sources = 0; }],
  ['observed duplicate rows', r => { r.observed.rows.push(structuredClone(r.observed.rows[0])); }],
  ['observed invented archive evidence', r => { r.observed.rows[0].targets[0].archive_evidence = true; }],
  ['observed numeric money', r => { r.observed.rows[0].targets[0].available_balance = 1; }],
  ['observed invalid time', r => { r.observed.rows[0].targets[0].last_login = '2024-02-30T00:00:00Z'; }],
  ['observed restore gates lifted', r => { r.observed.identity_mapping_missing = false; }],
  ['observed malformed fingerprint', r => { r.observed.source_fingerprint += '\n'; }],
];
for (const field of GATES) for (const value of [true, null, 0, 'false', undefined]) {
  malformed.push([`${field} is ${String(value)}`, r => { r[field] = value; }]);
}
for (const field of ['source_unchanged', 'target_unchanged', 'candidate_available']) for (const value of [0, 'true', null, undefined]) {
  malformed.push([`${field} is not boolean (${String(value)})`, r => { r[field] = value; }]);
}
for (const field of [...IDENTITIES, 'source_id']) {
  malformed.push([`invalid envelope ${field}`, r => { r[field] = SECRET; }]);
  malformed.push([`missing envelope ${field}`, r => { delete r[field]; }]);
  malformed.push([`reservation cross-bound ${field}`, r => { r.reservation[field] = id(90); }]);
  malformed.push([`candidate equals ${field}`, r => { r.reservation.target_id = r[field]; }]);
}
for (const field of ['job_id', 'source_site_id', 'package_id']) {
  malformed.push([`observed cross-bound ${field}`, r => { r.observed[field] = id(90); }]);
}
for (const [label, change] of malformed) test(`fail closed: ${label}`, async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), r = status(true); change(r); h.respond(r);
  assert.throws(() => api.validateEmployeeIdentityReservationStatus(r), redacted);
  assert.throws(() => api.employeeIdentityReservationCheckpoint(r), redacted);
  await assert.rejects(s.status(SOURCE), redacted); assert.equal(h.calls.length, 1);
});
for (const [label, change] of [
  ['no reservation', () => status()],
  ['source drift', r => { r.observed.source_fingerprint = OTHER_HASH; r.source_unchanged = false; return r; }],
  ['target drift', r => { r.observed.target_fingerprint = OTHER_HASH; r.target_unchanged = false; return r; }],
  ['unavailable candidate', r => { r.candidate_available = false; return r; }],
  ['both source hashes replaced', r => { r.observed.source_fingerprint = OTHER_HASH; r.reservation.source_fingerprint = OTHER_HASH; return r; }],
  ['both target hashes replaced', r => { r.observed.target_fingerprint = OTHER_HASH; r.reservation.target_fingerprint = OTHER_HASH; return r; }],
  ['all source IDs replaced', r => { r.source_id = id(21); r.observed.rows[0].source_id = id(21); r.reservation.source_id = id(21); return r; }],
]) test(`reserve requires confirmed same-checkpoint binding: ${label}`, async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN); h.respond(change(status(true)));
  await assert.rejects(s.reserve(checkpoint()), redacted); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, RESERVE);
});
for (const field of IDENTITIES) {
  test(`coherently foreign ${field} cannot confirm reserve`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), r = status(true);
    r[field] = id(90); r.reservation[field] = id(90); if (field in r.observed) r.observed[field] = id(90);
    h.respond(r); await assert.rejects(s.reserve(checkpoint()), redacted); assert.equal(h.calls.length, 1);
  });
  test(`known session rejects foreign checkpoint ${field} before sending any write`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN); h.respond(status()); await s.status(SOURCE);
    const cp = { ...checkpoint(), [field]: id(90) };
    await assert.rejects(s.reserve(cp), redacted); assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
  });
  test(`known session rejects coherently foreign status ${field} and retains original binding`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN); h.respond(status()); await s.status(SOURCE);
    const r = status(true); r[field] = id(90); r.reservation[field] = id(90); if (field in r.observed) r.observed[field] = id(90);
    h.respond(r); await assert.rejects(s.status(SOURCE), redacted);
    h.respond(status(true)); assert.equal((await s.reserve(checkpoint())).job_id, JOB); assert.equal(h.calls.length, 3);
  });
}
test('foreign checkpoint job on a fresh session cannot be detected preflight but cannot be confirmed by actual-task reply', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN); h.respond(status(true));
  await assert.rejects(s.reserve({ ...checkpoint(), job_id: id(90) }), redacted);
  assert.equal(h.calls.length, 1); assert.equal('p_job_id' in h.calls[0].args, false);
  h.respond(status(true)); assert.equal((await s.reserve(checkpoint())).reservation.target_id, CANDIDATE);
});
test('current task is copied internally; returned status mutation cannot rebind session to foreign checkpoint', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN); h.respond(status()); const r = await s.status(SOURCE);
  r.job_id = id(90); r.observed.job_id = id(90);
  await assert.rejects(s.reserve(api.employeeIdentityReservationCheckpoint(r)), redacted); assert.equal(h.calls.length, 1);
});
test('multiple source IDs share the same task, without client-side global exclusivity claims', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN); h.respond(status()); await s.status(SOURCE);
  const r = status(true); r.source_id = id(21); r.observed.rows[0].source_id = id(21); r.reservation.source_id = id(21);
  h.respond(r); assert.deepEqual(await s.status(id(21)), r); assert.equal(h.calls.length, 2);
});
test('saved checkpoint can be explicitly submitted on a new session with no hidden status or retry', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN); h.respond(status(true));
  const result = await s.reserve(api.employeeIdentityReservationCheckpoint(status()));
  assert.equal(result.reservation.binding_hash, BINDING_HASH); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].name, RESERVE);
});
for (const field of CHECKPOINT_KEYS) test(`reserve rejects invalid checkpoint ${field} before auth or request`, async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN);
  await assert.rejects(s.reserve({ ...checkpoint(), [field]: SECRET }), redacted);
  const missing = checkpoint(); delete missing[field]; await assert.rejects(s.reserve(missing), redacted);
  assert.equal(h.calls.length, 0); assert.equal(h.reads, 0);
});
for (const field of ['target_id', 'can_restore', 'backup_verified', 'binding_hash', 'p_job_token']) {
  test(`reserve accepts no caller-selected ${field}`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN);
    await assert.rejects(s.reserve({ ...checkpoint(), [field]: CANDIDATE }), redacted); assert.equal(h.calls.length, 0);
  });
}
test('getters, sparse arrays, symbols, exotic prototypes and throwing proxies fail closed without getter evaluation', () => {
  harness(); let getters = 0;
  for (const field of ['job_id', 'reservation', 'source_unchanged', 'observed']) {
    const r = status(true); Object.defineProperty(r, field, { enumerable: true, get() { getters++; throw Error(SECRET); } });
    assert.throws(() => api.validateEmployeeIdentityReservationStatus(r), redacted);
  }
  const nested = status(true); Object.defineProperty(nested.reservation, 'target_id', { enumerable: true, get() { getters++; throw Error(SECRET); } });
  assert.throws(() => api.validateEmployeeIdentityReservationStatus(nested), redacted);
  const row = status(true); Object.defineProperty(row.observed.rows, '0', { enumerable: true, get() { getters++; throw Error(SECRET); } });
  assert.throws(() => api.validateEmployeeIdentityReservationStatus(row), redacted); assert.equal(getters, 0);
  const sparse = status(); delete sparse.observed.rows[0]; assert.throws(() => api.validateEmployeeIdentityReservationStatus(sparse), redacted);
  for (const locate of [r => r, r => r.reservation, r => r.observed, r => r.observed.rows]) {
    const r = status(true); locate(r)[Symbol('hidden-authority')] = true;
    assert.throws(() => api.validateEmployeeIdentityReservationStatus(r), redacted);
  }
  const exotic = Object.setPrototypeOf(status(), { can_restore: true });
  assert.throws(() => api.validateEmployeeIdentityReservationStatus(exotic), redacted);
  assert.throws(() => api.validateEmployeeIdentityReservationStatus(new Proxy(status(), { ownKeys() { throw Error(SECRET); } })), redacted);
  const nonEnumerable = status(); Object.defineProperty(nonEnumerable, 'job_id', { enumerable: false, value: JOB });
  assert.throws(() => api.validateEmployeeIdentityReservationStatus(nonEnumerable), redacted);
  const nullPrototype = Object.assign(Object.create(null), status());
  assert.deepEqual(api.validateEmployeeIdentityReservationStatus(nullPrototype), status());
});
test('malicious checkpoint getter/proxy cannot dispatch or leak secrets', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN); let getters = 0;
  const cp = checkpoint(); Object.defineProperty(cp, 'source_fingerprint', { enumerable: true, get() { getters++; throw Error(SECRET); } });
  await assert.rejects(s.reserve(cp), redacted);
  await assert.rejects(s.reserve(new Proxy(checkpoint(), { ownKeys() { throw Error(SECRET); } })), redacted);
  assert.equal(getters, 0); assert.equal(h.calls.length, 0);
});
test('checkpoint values are captured synchronously before auth and signal-deferred transport; later mutation is irrelevant', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), cp = checkpoint(), controller = new AbortController();
  h.respond(status(true)); h.onAuth = () => { cp.source_fingerprint = BINDING_HASH; cp.job_id = id(91); };
  const pending = s.reserve(cp, controller.signal);
  Object.assign(cp, { source_id: id(90), source_fingerprint: OTHER_HASH, target_fingerprint: OTHER_HASH, site_id: id(92) });
  assert.equal((await pending).reservation.source_id, SOURCE);
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_job_token: TOKEN, p_source_id: SOURCE,
    p_source_fingerprint: SOURCE_HASH, p_target_fingerprint: TARGET_HASH });
});
test('mutation during pending reserve cannot replace the baseline used to validate response', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), cp = checkpoint(), wait = deferred();
  h.replies.push({ wait: wait.promise }); const pending = s.reserve(cp); await turn();
  cp.source_fingerprint = OTHER_HASH;
  const r = status(true); r.reservation.source_fingerprint = OTHER_HASH; r.observed.source_fingerprint = OTHER_HASH;
  wait.resolve({ data: r, error: null }); await assert.rejects(pending, redacted); assert.equal(h.calls.length, 1);
});
for (const operation of ['status', 'reserve']) for (const mode of ['throw', 'reject', 'error', 'malformed', 'null']) {
  test(`${operation}: ${mode} is secret-free and never automatically retried`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN);
    h.replies.push(mode === 'error' ? { error: { message: SECRET, details: SECRET, hint: SECRET } }
      : mode === 'malformed' ? { data: { error: SECRET } } : mode === 'null' ? { data: null } : { [mode]: Error(SECRET) });
    await assert.rejects(invoke(s, operation), redacted); assert.equal(h.calls.length, 1);
    h.respond(status(operation === 'reserve')); await invoke(s, operation); assert.equal(h.calls.length, 2);
  });
}
test('errors accompanying valid data never produce optimistic success', async () => {
  const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN);
  for (const operation of ['status', 'reserve']) {
    h.replies.push({ data: status(true), error: { message: SECRET } }); await assert.rejects(invoke(s, operation), redacted);
  }
  assert.equal(h.calls.length, 2);
});
test('invalid tokens/source inputs and expired/throwing auth dispatch nothing', async () => {
  const h = harness();
  for (const token of [null, undefined, 1, SECRET, TOKEN + '\n']) assert.throws(() => api.createEmployeeIdentityReservationSession(token), redacted);
  const s = api.createEmployeeIdentityReservationSession(TOKEN);
  for (const source of [null, 1, SECRET, SOURCE + '\n']) await assert.rejects(s.status(source), redacted);
  for (const operation of ['status', 'reserve']) {
    h.session = null; await assert.rejects(invoke(s, operation), redacted);
    h.authError = Error(SECRET); await assert.rejects(invoke(s, operation), redacted); h.authError = null;
  }
  assert.equal(h.calls.length, 0);
  h.session = SESSION; h.respond(status()); await s.status(SOURCE); assert.equal(h.calls.length, 1);
});
for (const operation of ['status', 'reserve']) {
  test(`${operation}: already aborted and same-turn abort dispatch no request`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), first = new AbortController(); first.abort(SECRET);
    await assert.rejects(invoke(s, operation, first.signal), aborted); assert.equal(h.reads, 0);
    const second = new AbortController(), pending = invoke(s, operation, second.signal); second.abort(SECRET);
    await assert.rejects(pending, aborted); await turn(); assert.equal(h.calls.length, 0); assert.equal(h.reads, 0);
  });
  test(`${operation}: abort during auth cannot dispatch a write or expose reason`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), controller = new AbortController();
    h.onAuth = () => controller.abort(SECRET);
    await assert.rejects(invoke(s, operation, controller.signal), aborted); assert.equal(h.calls.length, 0);
  });
  test(`${operation}: cancellation rejects promptly even when transport ignores signal and later resolves`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), wait = deferred(), controller = new AbortController();
    h.replies.push({ wait: wait.promise }); const pending = invoke(s, operation, controller.signal); await turn();
    assert.equal(h.calls.length, 1); controller.abort(SECRET); await assert.rejects(pending, aborted);
    const foreign = status(true); foreign.job_id = id(90); foreign.observed.job_id = id(90); foreign.reservation.job_id = id(90);
    wait.resolve({ data: foreign, error: null }); await turn();
    h.respond(status(true)); assert.equal((await s.reserve(checkpoint())).job_id, JOB); assert.equal(h.calls.length, 2);
  });
  test(`${operation}: abort during reply validation fails closed before pinning task or confirming success`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), controller = new AbortController();
    const r = new Proxy(status(true), { ownKeys(target) { controller.abort(SECRET); return Reflect.ownKeys(target); } });
    h.respond(r); await assert.rejects(invoke(s, operation, controller.signal), aborted); assert.equal(h.calls.length, 1);
  });
  test(`${operation}: abortSignal transport errors are sanitized without retries`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN);
    h.replies.push({ data: status(true), signalError: Error(SECRET) });
    await assert.rejects(invoke(s, operation, new AbortController().signal), redacted); assert.equal(h.calls.length, 1);
  });
}
for (const first of ['status', 'reserve']) for (const second of ['status', 'reserve']) {
  test(`per-session overlap ${first}/${second} is rejected, never queued or automatically replayed`, async () => {
    const h = harness(), s = api.createEmployeeIdentityReservationSession(TOKEN), wait = deferred(); h.replies.push({ wait: wait.promise });
    const pending = invoke(s, first); await turn(); await assert.rejects(invoke(s, second), redacted);
    assert.equal(h.calls.length, 1); assert.equal(h.reads, 1);
    wait.resolve({ data: status(first === 'reserve'), error: null }); await pending;
    h.respond(status(second === 'reserve')); await invoke(s, second); assert.equal(h.calls.length, 2);
  });
}
test('separate sessions are not a browser-global employee lock', async () => {
  const h = harness(), a = api.createEmployeeIdentityReservationSession(TOKEN), b = api.createEmployeeIdentityReservationSession(TOKEN);
  const wait = deferred(); h.replies.push({ wait: wait.promise }); const pending = a.status(SOURCE); await turn();
  h.respond(status()); await b.status(SOURCE); assert.equal(h.calls.length, 2);
  wait.resolve({ data: status(), error: null }); await pending;
});

test('actual shared transport: only long timeout addition, one POST attempt on HTTP/network/timeout/abort, no XHR', async t => {
  const transportBuild = await build({ entryPoints: [`${root}src/lib/supabase.ts`], bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://local.invalid'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('isolated-test-key') },
    plugins: [{ name: 'capture-fetch-no-real-supabase', setup(builder) {
      builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'local-client', namespace: 'capture' }));
      builder.onLoad({ filter: /.*/, namespace: 'capture' }, () => ({ contents: 'export const createClient=(url,key,options)=>({testFetch:options.global.fetch});' }));
    } }],
  });
  assert.equal(Object.keys(transportBuild.metafile.inputs).some(path => path.includes('node_modules')), false);
  let calls = 0, xhrCalls = 0, mode = 'http'; const delays = [];
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
  let fireTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { delays.push(delay); fireTimeout = callback; return 1; });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const xhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
  Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, value: function () { xhrCalls++; assert.fail('XHR fallback forbidden'); } });
  t.after(() => { if (xhr) Object.defineProperty(globalThis, 'XMLHttpRequest', xhr); else delete globalThis.XMLHttpRequest; });
  for (const name of [STATUS, RESERVE]) for (const failureMode of ['http', 'network', 'timeout', 'abort']) {
    calls = 0; mode = failureMode; delays.length = 0;
    const controller = new AbortController();
    const pending = transport.supabase.testFetch(`https://local.invalid/rest/v1/rpc/${name}`, { method: 'POST', signal: controller.signal });
    if (mode === 'abort') controller.abort(SECRET);
    if (mode === 'http') assert.equal((await pending).status, 503); else await assert.rejects(pending);
    assert.equal(calls, 1); assert.equal(xhrCalls, 0); assert.deepEqual(delays, [120000]);
  }
});
