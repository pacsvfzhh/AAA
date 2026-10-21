import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { createSites, adminLogin, rpc as baseRpc, rows, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Full historical replay, two independent PGlite sites, genuine SQL14 exports/staging and
// real encrypted on-disk shared/dispatch backups. Never fabricate a backup or restore receipt.
const MIGRATION = '20261102000049_restore_mapped_employee_identities.sql';
const PREFIX = 'employee_import_mapped_identity_';
const RPCS = ['plan', 'core', 'orders', 'verify', 'status'].map(key => PREFIX + key);
const STATE_KEY = 'mapped-identity-v1';
const GATES = ['can_restore', 'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete'];
const CONFLICTS = ['reservation_drift', 'candidate_occupied', 'source_uuid_occupied', 'username_requires_archive',
  'employee_number_conflict', 'administrator_username_conflict', 'archive_history_requires_backup',
  'unmapped_administrator', 'order_id_conflict', 'placeholder_product_active'];
const KEYS = {
  shared: ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'],
  dispatch: ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'],
  identity: ['accounts', 'credentials', 'orders'],
};
const id = n => `49000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const S = { one: id(1), two: id(2), product: id(3), branch: id(4), otherRoot: id(5) };
const COMMON_KEYS = ['scope', 'job_id', 'site_id', 'source_site_id', 'package_id', 'source_id', 'target_id',
  'source_fingerprint', 'binding_hash', 'plan_hash', 'maintenance', 'dependencies_pending', ...GATES];
const T = { existing: id(101), otherRoot: id(102) };
const EMPLOYEES = [S.one, S.two];
const USERNAMES = { [S.one]: 'mapped-fresh-one', [S.two]: 'mapped-fresh-two' };
const NUMBERS = { [S.one]: 'MAP-001', [S.two]: 'MAP-002' };
const PRECISE = '12345678901234567890.12345678901234567890';
const RATE = '0.12345678901234567890123456789';
const OMIT_ACCOUNT = ['current_session_token', 'session_created_at', 'last_heartbeat_at', 'current_tab_id', 'archived_at'];
const sha = text => createHash('sha256').update(text).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
const chunks = text => { const all = lines(text), out = []; for (let n = 0; n < all.length; n += 2) out.push(all.slice(n, n + 2).join('')); return out.length ? out : ['']; };
let source, db, replay, session, sourceSession, branch, other, task, sharedTask, pkg, identity, modules, expected;
let savepoint = 0;
const auth = (job = task, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
async function on(site, name, args, role = 'anon') {
  const point = `mapped_${++savepoint}`;
  await site.exec(`SAVEPOINT ${point}`);
  try {
    await site.exec(`SET LOCAL ROLE ${role}`);
    const value = await baseRpc(site, name, args, { role: null });
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`);
    return value;
  } catch (error) {
    await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
    throw error;
  }
}
const rpc = (name, args, role) => on(db, name, args, role);
const mapped = (key, sourceId = S.one, extra = {}, role = 'anon') => rpc(PREFIX + key, { ...auth(), p_source_id: sourceId, ...extra }, role);
const plan = (sourceId = S.one, extra = {}, role) => mapped('plan', sourceId, extra, role);
const status = (sourceId = S.one, extra = {}, role) => mapped('status', sourceId, extra, role);
const core = (p, extra = {}, role) => mapped('core', p.source_id, { p_plan_hash: p.plan_hash, ...extra }, role);
const orders = (sourceId, no, extra = {}, role) => mapped('orders', sourceId, { p_chunk_no: no, ...extra }, role);
const verify = (sourceId = S.one, extra = {}, role) => mapped('verify', sourceId, extra, role);
const summary = () => scalar(db, 'SELECT summary FROM private.employee_transfer_jobs WHERE id=$1', [task.job_id]);
const savedStates = () => rows(db, 'SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key=$2 ORDER BY employee_id,chunk_no', [task.job_id, STATE_KEY]);
const permitCount = () => scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits');
async function transaction(fn, site = db) {
  await site.exec('BEGIN');
  try { return await fn(); } finally { await site.exec('ROLLBACK'); }
}
async function stage(input) {
  await rpc('employee_import_identity_bind', { ...auth(), p_catalog: input.catalog });
  for (const key of KEYS.identity) for (const [no, text] of chunks(input.texts[key]).entries()) {
    await rpc('employee_import_identity_stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  }
}
async function reserve(sourceId, role = 'anon') {
  const observed = await rpc('employee_import_identity_reservation_status', { ...auth(), p_source_id: sourceId }, role);
  assert.equal(observed.reservation, null);
  const result = await rpc('employee_import_identity_reserve', { ...auth(), p_source_id: sourceId,
    p_source_fingerprint: observed.observed.source_fingerprint, p_target_fingerprint: observed.observed.target_fingerprint }, role);
  assert.equal(result.source_unchanged, true); assert.equal(result.target_unchanged, true); assert.equal(result.candidate_available, true);
  assert.notEqual(result.reservation.target_id, sourceId);
  return result.reservation;
}
async function scenario(fn, { input = identity, reserveCandidates = true, role = 'anon', beforeReserve } = {}) {
  return transaction(async () => {
    await stage(input);
    if (beforeReserve) await beforeReserve();
    const bindings = {};
    if (reserveCandidates) for (const sourceId of EMPLOYEES) bindings[sourceId] = await reserve(sourceId, role);
    return fn(bindings, input);
  });
}
async function capture(kind) {
  const job = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession,
    p_admin_password: PASSWORDS.root, ...(kind === 'identity' ? { p_package_id: pkg } : {}) });
  const texts = {};
  for (const key of KEYS[kind]) {
    texts[key] = ''; let after = null;
    do {
      const page = await on(source, `get_employee_export_${kind}_page`, { ...auth(job, sourceSession), p_table_key: key, p_after: after, p_limit: 200 });
      assert.equal(page.sha256, sha(page.ndjson)); texts[key] += page.ndjson; after = page.next_after;
    } while (after !== null);
  }
  assert.equal((await on(source, `employee_export_${kind}_verify`, auth(job, sourceSession))).verified, true);
  await on(source, kind === 'shared' ? 'employee_transfer_cancel' : `employee_export_${kind}_close`, auth(job, sourceSession));
  return { catalog: job.catalog, texts };
}
async function* readDisk(path) {
  const handle = await open(path, 'r');
  try { const bytes = Buffer.alloc(65521); for (;;) { const part = await handle.read(bytes); if (!part.bytesRead) return; yield bytes.subarray(0, part.bytesRead); } }
  finally { await handle.close(); }
}
async function prepare(kind, input) {
  const job = await rpc(kind === 'shared' ? 'employee_import_shared_replace_begin' : 'employee_import_dispatch_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: pkg, p_catalog: input.catalog,
  });
  for (const key of KEYS[kind]) await rpc(`employee_import_${kind}_stage`, { ...auth(job), p_table_key: key, p_chunk_no: 0, p_ndjson: input.texts[key] });
  const p = await rpc(kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', auth(job));
  const descriptor = await rpc(`get_employee_import_${kind}_backup`, auth(job));
  const dir = await mkdtemp(join(tmpdir(), 'employee-mapped-identity-')), path = join(dir, 'independent.edx'), plain = new Map();
  try {
    const result = await (kind === 'shared' ? modules.createReplacementBackup : modules.createDispatchBackup)(descriptor, {
      async catalog() { return (await rpc(`get_employee_import_${kind}_backup`, auth(job))).catalog; },
      page(key, after) { return rpc(`get_employee_import_${kind}_backup_page`, { ...auth(job), p_table_key: key, p_after: after, p_limit: 200 }); },
      async verify() {
        assert.deepEqual(await rpc(`get_employee_import_${kind}_backup`, auth(job)), descriptor);
        return { verified: true, scope: kind === 'shared' ? 'shared-settings' : 'dispatch-submission', full_site_complete: false };
      },
    }, {
      async append(name, bytes) { plain.set(name, [...plain.get(name) ?? [], Buffer.from(bytes)]); },
      open(name) { return (async function* () { yield* plain.get(name) ?? []; })(); }, async abort() { plain.clear(); },
    }, {
      async write(stream) { const handle = await open(path, 'wx'); try { for await (const bytes of stream) await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } },
      open() { return readDisk(path); },
    }, {
      append(no, hex) { return rpc(`employee_import_${kind}_backup_append`, { ...auth(job), p_plan_hash: p.plan_hash, p_chunk_no: no, p_hex: hex }); },
      seal(hash, bytes) { return rpc(`employee_import_${kind}_backup_seal`, { ...auth(job), p_plan_hash: p.plan_hash, p_sha256: hash, p_bytes: bytes }); },
    }, 'local-mapped-identity-independent-prerequisite-backup');
    assert.equal(result.sealReceipt.success, true); assert.equal(plain.size, 0);
    assert.equal(await scalar(db, 'SELECT sealed_at IS NOT NULL FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), true);
    return { job, plan: p };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
// Local postgres-only negative fixtures; no grants/receipts changed, exact trigger modes restored.
async function change(relation, sql, args = [], site = db) {
  const modes = await rows(site, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
  for (const t of modes) await site.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
  try { await site.query(sql, args); } finally {
    for (const t of modes) await site.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`);
  }
}
async function snapshot(site = db) {
  const names = (await rows(site, `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') ORDER BY 1`)).map(r => r.name);
  return rows(site, names.map(name => `SELECT '${name}' AS name,count(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} AS r`).join(' UNION ALL '));
}
const business = () => snapshot().then(all => all.filter(r => r.name.startsWith('public.') || !r.name.startsWith('private.employee_transfer_')));
const triggers = () => rows(db, `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','private') ORDER BY 1,2,3`);
function closed(value) {
  assert.equal(value.scope, 'employee-mapped-identity');
  for (const key of GATES) assert.equal(value[key], false, key);
  assert.equal(value.maintenance, true); assert.equal(value.dependencies_pending, true);
}
function common(value, binding) {
  closed(value);
  const operationKeys = 'can_begin' in value ? ['can_begin', 'conflicts', 'totals', 'order_chunks']
    : ['counts', 'totals', 'next_chunk', 'order_chunks', 'verified'];
  assert.deepEqual(Object.keys(value).sort(), [...COMMON_KEYS, ...operationKeys].sort());
  for (const key of ['job_id', 'site_id', 'source_site_id', 'package_id', 'source_id', 'target_id', 'source_fingerprint', 'binding_hash']) assert.equal(value[key], binding[key], key);
  assert.match(value.plan_hash, /^[0-9a-f]{64}$/);
  assert.equal(value.order_chunks, 3);
  assert.doesNotMatch(JSON.stringify(value), /password_hash|current_session_token|current_tab_id|commission_amount|private remark/);
}
function conflictReasons(p) {
  assert.ok(Array.isArray(p.conflicts));
  for (const reason of p.conflicts) assert.ok(CONFLICTS.includes(reason), `unreviewed conflict ${JSON.stringify(reason)}`);
  return p.conflicts;
}
async function noLegacyAuthorization() {
  const state = await summary(); assert.equal(state.identity_restore, undefined); assert.equal(state.verified_identity_map, undefined);
  const point = `legacy_map_${++savepoint}`; await db.exec(`SAVEPOINT ${point}`);
  try {
    await assert.rejects(db.query(`SELECT * FROM private.employee_transfer_verified_identity_map(
      (SELECT j FROM private.employee_transfer_jobs AS j WHERE id=$1),'accounts')`, [task.job_id]), /server-verified/);
  } finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
  assert.equal(await permitCount(), 0);
}
async function assertAccount(sourceId, targetId, inputExpected = expected) {
  const original = inputExpected.accounts.find(row => row.id === sourceId);
  const owner = sourceId === S.one ? NEW.root : NEW.branch;
  assert.equal(await scalar(db, `SELECT (to_jsonb(u)-$2::text[]) = ($3::jsonb||jsonb_build_object('id',u.id,'created_by',$4::uuid,'is_active',false))
    FROM public.users u WHERE u.id=$1`, [targetId, OMIT_ACCOUNT, original.body, owner]), true, 'all account business fields including exact numeric, NULL, tags, remarks and original timestamps');
  assert.equal(await scalar(db, `SELECT is_active=false AND archived_at IS NULL AND current_session_token IS NULL
    AND current_tab_id IS NULL AND session_created_at IS NULL AND last_heartbeat_at IS NULL FROM public.users WHERE id=$1`, [targetId]), true);
  const credential = inputExpected.credentials.find(row => row.user_id === sourceId);
  if (credential) assert.equal(await scalar(db, `SELECT to_jsonb(c)=($2::jsonb||jsonb_build_object('user_id',c.user_id))
    FROM public.financial_employee_credentials c WHERE user_id=$1`, [targetId, credential.body]), true);
  else assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.financial_employee_credentials WHERE user_id=$1', [targetId]), 0);
  assert.equal(await scalar(db, 'SELECT available_balance=0 AND frozen_balance=0 FROM public.wallets WHERE user_id=$1', [targetId]), true);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.users WHERE id=$1', [sourceId]), 0);
}
async function assertOrders(sourceId, targetId) {
  const originals = expected.orders.filter(row => row.user_id === sourceId);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.orders WHERE user_id=$1', [targetId]), originals.length);
  for (const original of originals) {
    assert.equal(await scalar(db, `SELECT jsonb_build_object('id',o.id,'user_id',o.user_id,'status',o.status,
      'commission_amount',o.commission_amount,'commission_rate',o.commission_rate,'created_at',o.created_at,'processed_at',o.processed_at)
      = ($2::jsonb||jsonb_build_object('user_id',o.user_id)) FROM public.orders o WHERE o.id=$1`, [original.id, original.body]), true, original.id);
    assert.equal(await scalar(db, `SELECT username=$2 AND product_value=0.01 AND order_number='IMPORTED-'||id::text
      AND transaction_id='IMPORTED-'||id::text AND assignment_id IS NULL AND scheduled_process_at IS NULL
      AND dispatch_commission_rate_snapshot IS NULL AND dispatch_success_rate_snapshot IS NULL
      AND product_type_id=(SELECT id FROM public.product_types WHERE name='舊站匯入（精簡訂單）' AND is_active=false)
      FROM public.orders WHERE id=$1`, [original.id, USERNAMES[sourceId]]), true);
  }
}
async function complete(p, role = 'anon') {
  await core(p, {}, role);
  for (let no = 0; no < p.order_chunks; no++) await orders(p.source_id, no, {}, role);
  const result = await verify(p.source_id, {}, role); assert.equal(result.verified, true); return result;
}
async function sourceExpected() {
  return {
    accounts: await rows(source, 'SELECT id,(to_jsonb(u)-$1::text[])::text AS body FROM public.users u ORDER BY id', [OMIT_ACCOUNT]),
    credentials: await rows(source, 'SELECT user_id,to_jsonb(c)::text AS body FROM public.financial_employee_credentials c ORDER BY user_id'),
    orders: await rows(source, `SELECT id,user_id,jsonb_build_object('id',id,'user_id',user_id,'status',status,'commission_amount',commission_amount,
      'commission_rate',commission_rate,'created_at',created_at,'processed_at',processed_at)::text AS body FROM public.orders ORDER BY id`),
  };
}
async function sourceVariant(mutate) { return transaction(async () => { await mutate(); return capture('identity'); }, source); }

before(async () => {
  // SQL49 is being written concurrently. Missing migration is a hard failure, never a skip or fake RPC.
  await access(new URL(`../migrations/${MIGRATION}`, import.meta.url));
  for (const [module, name] of [[globalThis, 'fetch'], [http, 'request'], [https, 'request'], [net, 'connect'], [tls, 'connect']]) {
    mock.method(module, name, () => assert.fail('network and production services forbidden'));
  }
  replay = await createSites({ upTo: MIGRATION }); source = replay.oldSite; db = replay.newSite;
  assert.equal(replay.failures.length, 12); assert.equal(replay.files.at(-1), MIGRATION);
  await buildNewSite(source); await buildNewSite(db);
  await source.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  // Different source administrator UUID proves SQL49 uses the actual same-package shared map.
  await source.query('DELETE FROM public.financial_admin_credentials WHERE admin_id=$1', [NEW.branch]);
  await source.query('UPDATE public.admins SET id=$1 WHERE id=$2', [S.branch, NEW.branch]);
  await source.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [S.branch]);
  for (const sourceId of EMPLOYEES) {
    await source.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,is_active,is_verified,total_income,
      first_success_order_date,remarks,tags,is_pinned,created_at,updated_at,current_session_token,session_created_at,last_heartbeat_at,current_tab_id)
      VALUES($1,$2,$3,extensions.crypt($4,extensions.gen_salt('bf',4)),$5,true,$6,$7::numeric,$8::timestamptz,$9,$10::text[],$6,
        '2026-09-01T01:02:03.123456Z','2026-09-02T03:04:05.654321Z',$11,'2026-10-01T00:00:00Z','2026-10-01T01:00:00Z','source-tab-must-not-transfer')`,
    [sourceId, USERNAMES[sourceId], NUMBERS[sourceId], PASSWORDS.employee, sourceId === S.one ? NEW.root : S.branch,
      sourceId === S.one, sourceId === S.one ? PRECISE : null, sourceId === S.one ? '2026-09-03T01:02:03.123456Z' : null,
      sourceId === S.one ? 'private remark\n𠮷 é é \\" <p>raw</p>' : null, sourceId === S.one ? ['VIP', null, '', '繁體', 'é', 'é'] : null, randomUUID()]);
    await source.query(`INSERT INTO public.financial_employee_credentials(user_id,password_hash,created_at,updated_at)
      VALUES($1,extensions.crypt('DifferentFinancialPass-456',extensions.gen_salt('bf',4)),'2026-09-01T00:00:00.111111Z','2026-09-02T00:00:00.222222Z')`, [sourceId]);
  }
  await source.query("INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Source private historical product',false)", [S.product]);
  // Global chunk 0 belongs only to one; chunk 1 only to two; chunk 2 is mixed.
  const owners = [S.one, S.one, S.two, S.two, S.one, S.two];
  for (const [index, owner] of owners.entries()) await change('public.orders', `INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,
    order_number,transaction_id,status,commission_amount,commission_rate,created_at,processed_at)
    VALUES($1,$2,$3,$4,987.65,$5,$6,$7,$8::numeric,$9::numeric,$10::timestamptz,$11::timestamptz)`,
  [id(200 + index), owner, USERNAMES[owner], S.product, `PRIVATE-ORDER-${index}`, `PRIVATE-TX-${index}`,
    index % 2 ? 'failure' : 'success', index % 2 ? null : index === 0 ? PRECISE : '0.00000000000000000000000000001',
    index % 2 ? null : RATE, index === 5 ? null : '2026-09-04T01:02:03.123456Z', index % 2 ? null : '2026-09-05T02:03:04.654321Z'], source);
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    SELECT $1,'mapped-other-root',password_hash,'super_admin',true FROM public.admins WHERE id=$2`, [T.otherRoot, NEW.root]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [T.otherRoot]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); other = await adminLogin(db, 'mapped-other-root', PASSWORDS.root); pkg = randomUUID();
  const compiled = await build({ stdin: { contents: `export {createReplacementBackup} from './src/lib/employeeTransfer/replacementBackup.ts';
    export {createDispatchBackup} from './src/lib/employeeTransfer/dispatchBackup.ts';
    export * from './src/lib/employeeTransfer/employeeMappedIdentity.ts'; export {setHarness} from 'mapped-db:state';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', plugins: [{ name: 'local-mapped-sql', setup(builder) {
    builder.onResolve({ filter: /^(?:mapped-db:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'mapped-db' }));
    builder.onLoad({ filter: /.*/, namespace: 'mapped-db' }, ({ path }) => ({ contents: path === 'mapped-db:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth' ? 'import{current}from"mapped-db:state";export const getAdminFinancialSessionToken=()=>current().token;'
        : 'import{current}from"mapped-db:state";export const supabase={rpc:(name,args)=>current().rpc(name,args)};' }));
  } }] });
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  await source.exec('BEGIN');
  const shared = await capture('shared'), dispatch = await capture('dispatch'); identity = await capture('identity'); expected = await sourceExpected();
  await source.exec('COMMIT');
  assert.deepEqual(identity.catalog.tables.map(t => t.rows), [2, 2, 6]);
  assert.match(identity.texts.accounts, new RegExp(PRECISE.replaceAll('.', '\\.')));
  assert.doesNotMatch(identity.texts.accounts, /source-tab-must-not-transfer|current_session_token/);
  assert.doesNotMatch(identity.texts.orders, /PRIVATE-ORDER|PRIVATE-TX|987\.65/);
  await db.exec('BEGIN');
  const sharedPrepared = await prepare('shared', shared); sharedTask = sharedPrepared.job;
  assert.equal((await rpc('employee_import_shared_replace_apply', { ...auth(sharedTask), p_plan_hash: sharedPrepared.plan.plan_hash })).success, true);
  await rpc('employee_transfer_cancel', auth(sharedTask));
  const prepared = await prepare('dispatch', dispatch); task = prepared.job;
  await rpc('employee_import_dispatch_enter_maintenance', { ...auth(), p_plan_hash: prepared.plan.plan_hash,
    p_confirmation: '確認暫停業務並導入派單資料', p_admin_password: PASSWORDS.root });
  const config = await rpc('get_employee_import_dispatch_configuration_plan', auth());
  await rpc('employee_import_dispatch_apply_configuration', { ...auth(), p_plan_hash: config.plan_hash });
  await db.exec('COMMIT');
}, { timeout: 600000 });
after(async () => { await Promise.allSettled([source?.close(), db?.close()]); mock.restoreAll(); });

test('SQL49 exact public signatures, STABLE read-only plan/status, definer search path and no PUBLIC/service execute', async () => scenario(async bindings => {
  const functions = await rows(db, `SELECT proname,provolatile,prosecdef,proconfig,proargnames,pronargdefaults,
    oid::regprocedure::text AS signature,EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) ORDER BY proname`, [RPCS]);
  assert.deepEqual(functions.map(f => f.proname).sort(), [...RPCS].sort());
  for (const fn of functions) {
    const key = fn.proname.slice(PREFIX.length);
    assert.equal(fn.provolatile, ['plan', 'status'].includes(key) ? 's' : 'v'); assert.equal(fn.prosecdef, true);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    assert.equal(fn.public_execute, false); assert.equal(fn.pronargdefaults, 0);
    assert.deepEqual(fn.proargnames, ['p_admin_session_token', 'p_job_token', 'p_source_id', ...key === 'core' ? ['p_plan_hash'] : key === 'orders' ? ['p_chunk_no'] : []]);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [role, fn.signature]), role !== 'service_role');
      if (role === 'service_role') await assert.rejects(mapped(key, S.one, key === 'core' ? { p_plan_hash: '0'.repeat(64) } : key === 'orders' ? { p_chunk_no: 0 } : {}, role), /permission denied/);
    }
  }
  await core(await plan());
  const before = await snapshot(), modes = await triggers(); await db.exec('SET TRANSACTION READ ONLY');
  for (const role of ['anon', 'authenticated']) {
    const p = await plan(S.one, {}, role), s = await status(S.one, {}, role);
    common(p, bindings[S.one]); common(s, bindings[S.one]); assert.deepEqual(await plan(S.one, {}, role), p); assert.deepEqual(await status(S.one, {}, role), s);
  }
  assert.deepEqual(await snapshot(), before); assert.deepEqual(await triggers(), modes);
}));

for (const role of ['anon', 'authenticated']) {
  test(`SQL49 ${role}: golden two-source mapping restores distinct stopped accounts, exact credentials/orders and no financial or messaging side effects`, async () => scenario(async bindings => {
    const initial = await business(), sourceBefore = await snapshot(source), modes = await triggers();
    const originalStaging = await rows(db, 'SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 ORDER BY employee_id,table_key,chunk_no', [task.job_id]);
    const lastEvent = await scalar(db, 'SELECT COALESCE(max(id),0)::text FROM private.employee_transfer_events');
    const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
    const first = await plan(S.one, {}, role), second = await plan(S.two, {}, role);
    assert.notEqual(first.target_id, second.target_id); assert.notEqual(first.plan_hash, second.plan_hash);
    for (const sourceId of EMPLOYEES) {
      const p = await plan(sourceId, {}, role);
      common(p, bindings[p.source_id]); assert.equal(p.can_begin, true); assert.deepEqual(conflictReasons(p), []);
      assert.deepEqual(p.totals, { accounts: 1, credentials: 1, orders: 3 });
      assert.equal((await savedStates()).some(row => row.employee_id === p.source_id), false);
      const ack = await core(p, {}, role); common(ack, bindings[p.source_id]); assert.deepEqual(ack.counts, { accounts: 1, credentials: 1, orders: 0 });
      assert.equal(ack.next_chunk, 0); assert.equal(ack.verified, false);
      assert.deepEqual(await status(p.source_id, {}, role), ack);
      await assertAccount(p.source_id, p.target_id); assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.orders WHERE user_id=$1', [p.target_id]), 0);
      await assert.rejects(verify(p.source_id, {}, role), /incomplete|cursor|orders/i);
      const coreState = await snapshot(); await core(p, {}, role); assert.deepEqual(await snapshot(), coreState);
      for (let no = 0; no < p.order_chunks; no++) {
        const receipt = await orders(p.source_id, no, {}, role); common(receipt, bindings[p.source_id]);
        const count = p.source_id === S.one ? [2, 2, 3][no] : [0, 2, 3][no];
        assert.equal(receipt.counts.orders, count); assert.equal(receipt.next_chunk, no + 1);
        assert.equal(receipt.verified, false); assert.equal(await permitCount(), 0); assert.deepEqual(await triggers(), modes);
        const frozen = await snapshot(); await orders(p.source_id, no, {}, role); assert.deepEqual(await snapshot(), frozen);
      }
      const receipt = await verify(p.source_id, {}, role); common(receipt, bindings[p.source_id]);
      assert.equal(receipt.verified, true); assert.deepEqual(receipt.counts, p.totals); assert.equal(receipt.next_chunk, p.order_chunks);
      await assertAccount(p.source_id, p.target_id); await assertOrders(p.source_id, p.target_id);
      const frozen = await snapshot(); await core(p, {}, role); await orders(p.source_id, 0, {}, role); await verify(p.source_id, {}, role);
      assert.deepEqual(await snapshot(), frozen); assert.equal((await status(p.source_id, {}, role)).verified, true);
      await noLegacyAuthorization();
    }
    const state = await savedStates(); assert.equal(state.length, 2);
    for (const row of state) { assert.ok(EMPLOYEES.includes(row.employee_id)); assert.equal(row.chunk_no, 0); assert.equal(row.row_count, 1); }
    assert.deepEqual(await rows(db, 'SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key<>$2 ORDER BY employee_id,table_key,chunk_no', [task.job_id, STATE_KEY]), originalStaging);
    const events = await rows(db, 'SELECT details FROM private.employee_transfer_events WHERE id>$1 ORDER BY id', [lastEvent]);
    assert.ok(events.length > 0);
    const details = JSON.stringify(events);
    assert.doesNotMatch(details, /password|credential_password|session_token|job_token|private remark|PRIVATE-ORDER|PRIVATE-TX|\$2[aby]\$/);
    for (const secret of [session, sourceSession, task.job_token, ...Object.values(PASSWORDS)]) assert.equal(details.includes(secret), false);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.users WHERE id=ANY($1::uuid[])', [EMPLOYEES]), 0);
    const changed = (await business()).filter((r, i) => JSON.stringify(r) !== JSON.stringify(initial[i])).map(r => r.name);
    assert.deepEqual(changed.sort(), ['public.financial_employee_credentials', 'public.orders', 'public.product_types', 'public.users', 'public.wallets'].sort());
    for (const name of ['wallet_ledger_entries', 'wallet_balance_baselines', 'wallet_transactions', 'wallet_reconciliation_queue', 'wallet_reconciliation_audit',
      'financial_operations', 'notification_automation_queue', 'notification_automation_executions', 'messages', 'message_recipients',
      'employee_financial_sessions', 'employee_login_history', 'work_sessions', 'dispatch_group_members', 'used_order_data']) {
      assert.equal(await scalar(db, `SELECT count(*)::int FROM public.${name}`), 0, name);
    }
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.deleted_employee_accounts'), 0);
    assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance);
    assert.deepEqual(await snapshot(source), sourceBefore); assert.deepEqual(await triggers(), modes); await noLegacyAuthorization();
    const legacy = await rpc('get_employee_import_identity_plan', auth(), role);
    assert.equal(legacy.can_restore, false); assert.equal(legacy.replacement_ready, false); assert.equal(legacy.full_site_complete, false);
    for (const sourceId of EMPLOYEES) assert.ok(legacy.conflicts.some(c => c.source_id === sourceId && c.reason === 'username_requires_archive'));
    await assert.rejects(rpc('employee_import_identity_begin', { ...auth(), p_plan_hash: legacy.plan_hash }, role));
    await noLegacyAuthorization();
  }, { role }));

  test(`SQL49 ${role}: missing financial credential is valid and is never synthesized from login password`, async () => {
    const input = await sourceVariant(() => source.query('DELETE FROM public.financial_employee_credentials WHERE user_id=$1', [S.two]));
    await scenario(async bindings => {
      const p = await plan(S.two, {}, role); common(p, bindings[S.two]); assert.equal(p.can_begin, true);
      assert.deepEqual(p.totals, { accounts: 1, credentials: 0, orders: 3 }); await complete(p, role);
      await assertAccount(S.two, p.target_id, { ...expected, credentials: expected.credentials.filter(c => c.user_id !== S.two) });
      await assertOrders(S.two, p.target_id); await noLegacyAuthorization();
    }, { input, role });
  });

  test(`SQL49 ${role}: unknown/null source or session/job tokens and foreign owner cannot read or mutate a real mapping`, async () => scenario(async () => {
    const p = await plan(); await core(p); const frozen = await snapshot();
    const badArgs = [
      ...[null, randomUUID(), branch, other, sourceSession].map(token => ({ p_admin_session_token: token })),
      ...[null, randomUUID(), sharedTask.job_token].map(token => ({ p_job_token: token })),
      ...[null, randomUUID(), p.target_id].map(sourceId => ({ p_source_id: sourceId })),
    ];
    for (const extra of badArgs) for (const key of ['plan', 'status', 'core', 'orders', 'verify']) {
      await assert.rejects(mapped(key, S.one, { ...key === 'core' ? { p_plan_hash: p.plan_hash } : key === 'orders' ? { p_chunk_no: 0 } : {}, ...extra }, role));
    }
    assert.deepEqual(await snapshot(), frozen); assert.equal(await permitCount(), 0);
  }, { role }));

  test(`SQL49 ${role}: plan hash and global order cursor cannot be skipped, forged or borrowed from another source`, async () => scenario(async () => {
    const p = await plan(), otherPlan = await plan(S.two), frozen = await snapshot();
    await assert.rejects(orders(S.one, 0, {}, role)); await assert.rejects(verify(S.one, {}, role));
    for (const hash of [null, '', '0'.repeat(63), 'A'.repeat(64), '0'.repeat(64), otherPlan.plan_hash]) await assert.rejects(core(p, { p_plan_hash: hash }, role));
    assert.deepEqual(await snapshot(), frozen); await core(p, {}, role);
    for (const no of [null, -1, 1, 3, 2147483647]) await assert.rejects(orders(S.one, no, {}, role));
    await orders(S.one, 0, {}, role); await assert.rejects(orders(S.one, 2, {}, role));
    await assert.rejects(verify(S.one, {}, role)); assert.equal((await status(S.one, {}, role)).next_chunk, 1);
    await orders(S.one, 1, {}, role); await orders(S.one, 2, {}, role); await verify(S.one, {}, role);
    await assert.rejects(orders(S.one, 3, {}, role)); await noLegacyAuthorization();
  }, { role }));

  test(`SQL49 ${role}: no browser table/helper access and no client target UUID or backup-proof argument`, async () => scenario(async () => {
    const p = await plan(); await core(p); const frozen = await snapshot();
    const helpers = await rows(db, `SELECT oid::regprocedure::text AS signature FROM pg_proc
      WHERE pronamespace='private'::regnamespace AND proname LIKE '%mapped_identity%'`);
    assert.ok(helpers.length > 0);
    for (const helper of helpers) for (const principal of ['anon', 'authenticated', 'service_role']) {
      assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [principal, helper.signature]), false);
    }
    for (const sql of [
      `SELECT * FROM private.employee_transfer_staging WHERE table_key='${STATE_KEY}'`,
      `UPDATE private.employee_transfer_staging SET payload='{}' WHERE table_key='${STATE_KEY}'`,
      `DELETE FROM private.employee_transfer_staging WHERE table_key='${STATE_KEY}'`,
      "INSERT INTO public.users(username,password_hash,employee_id) VALUES('browser-forged','forged','BROWSER')",
      'UPDATE public.financial_employee_credentials SET password_hash=\'forged\'',
      'UPDATE public.wallets SET available_balance=999',
    ]) {
      const point = `direct_${++savepoint}`; await db.exec(`SAVEPOINT ${point}`);
      try { await db.exec(`SET LOCAL ROLE ${role}`); await assert.rejects(db.exec(sql), /permission denied/); }
      finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
    }
    for (const key of ['plan', 'core', 'orders', 'verify', 'status']) for (const arg of ['p_target_id', 'p_backup_verified']) {
      const point = `argument_${++savepoint}`; await db.exec(`SAVEPOINT ${point}`);
      try {
        await db.exec(`SET LOCAL ROLE ${role}`);
        const suffix = key === 'core' ? ',p_plan_hash=>$4::text' : key === 'orders' ? ',p_chunk_no=>$4::integer' : '';
        await assert.rejects(db.query(`SELECT public.${PREFIX + key}(p_admin_session_token=>$1::uuid,p_job_token=>$2::uuid,p_source_id=>$3::uuid${suffix},
          ${arg}=>${arg === 'p_target_id' ? `'${p.target_id}'::uuid` : 'true'})`, [session, task.job_token, S.one, ...key === 'core' ? [p.plan_hash] : key === 'orders' ? [0] : []]), { code: '42883' });
      } finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
    }
    assert.deepEqual(await snapshot(), frozen); await noLegacyAuthorization();
  }, { role }));
}

for (const [label, sql, params] of [
  ['expired session', "UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=private.hash_financial_token($1)", () => [session]],
  ['revoked session', 'UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE token_hash=private.hash_financial_token($1)', () => [session]],
  ['idle task', "UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", () => [task.job_id]],
  ['absolute task age', "UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", () => [task.job_id]],
  ['wrong protocol', "UPDATE private.employee_transfer_jobs SET options=jsonb_set(options,'{import_protocol}','\"shared-import-v1\"') WHERE id=$1", () => [task.job_id]],
  ['wrong task status', "UPDATE private.employee_transfer_jobs SET status='failed' WHERE id=$1", () => [task.job_id]],
  ['missing maintenance', 'DELETE FROM private.employee_transfer_maintenance WHERE job_id=$1', () => [task.job_id]],
  ['unsealed actual backup', 'UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1', () => [task.job_id]],
  ['missing configuration receipt', "UPDATE private.employee_transfer_jobs SET summary=summary-'dispatch_configuration_receipt' WHERE id=$1", () => [task.job_id]],
]) test(`SQL49 every RPC rechecks ${label} after core write`, async () => scenario(async () => {
  const p = await plan(); await core(p); await db.query(sql, params()); const frozen = await snapshot(), modes = await triggers();
  for (const role of ['anon', 'authenticated']) for (const key of ['plan', 'status', 'core', 'orders', 'verify']) {
    await assert.rejects(mapped(key, S.one, key === 'core' ? { p_plan_hash: p.plan_hash } : key === 'orders' ? { p_chunk_no: 0 } : {}, role));
  }
  assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.equal(await permitCount(), 0);
}));

for (const adminChange of ['inactive', 'secondary_admin', 'emergency_admin']) test(`SQL49 ${adminChange} owner loses all mapped RPC access after core`, async () => scenario(async () => {
  const p = await plan(); await core(p);
  await change('public.admins', adminChange === 'inactive' ? 'UPDATE public.admins SET is_active=false WHERE id=$1'
    : 'UPDATE public.admins SET role=$2 WHERE id=$1', adminChange === 'inactive' ? [NEW.root] : [NEW.root, adminChange]);
  const frozen = await snapshot();
  for (const key of ['plan', 'status', 'core', 'orders', 'verify']) await assert.rejects(mapped(key, S.one,
    key === 'core' ? { p_plan_hash: p.plan_hash } : key === 'orders' ? { p_chunk_no: 0 } : {}));
  assert.deepEqual(await snapshot(), frozen); assert.equal(await permitCount(), 0);
}));

test('SQL49 actual cancellation invalidates every mapped RPC and leaves dirty maintenance in place', async () => scenario(async () => {
  const p = await plan(); await core(p);
  const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
  assert.equal((await rpc('employee_transfer_cancel', auth())).success, true);
  assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [task.job_id]), 'cancelled');
  assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance);
  const frozen = await snapshot();
  for (const key of ['plan', 'status', 'core', 'orders', 'verify']) await assert.rejects(mapped(key, S.one,
    key === 'core' ? { p_plan_hash: p.plan_hash } : key === 'orders' ? { p_chunk_no: 0 } : {}));
  assert.deepEqual(await snapshot(), frozen); assert.equal(await permitCount(), 0);
}));

for (const table of KEYS.identity) for (const representation of ['rows', 'ndjson']) {
  test(`SQL49 corrupted ${table} ${representation} cannot masquerade as an unchanged bound source`, async () => scenario(async () => {
    const p = await plan(); await core(p);
    const sql = representation === 'rows'
      ? `UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{rows,0,${table === 'accounts' ? 'remarks' : table === 'credentials' ? 'password_hash' : 'status'}}','\"tampered\"') WHERE job_id=$1 AND table_key=$2 AND chunk_no=0`
      : `UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{ndjson}',to_jsonb((payload->>'ndjson')||E'\\n')) WHERE job_id=$1 AND table_key=$2 AND chunk_no=0`;
    await db.query(sql, [task.job_id, `identity-in:${table}`]); const frozen = await snapshot();
    for (const key of ['plan', 'status', 'core', 'orders', 'verify']) await assert.rejects(mapped(key, S.one,
      key === 'core' ? { p_plan_hash: p.plan_hash } : key === 'orders' ? { p_chunk_no: 0 } : {}));
    assert.deepEqual(await snapshot(), frozen); assert.equal(await permitCount(), 0);
  }));
}

for (const [label, mutate, reason] of [
  ['source UUID occupied', () => change('public.users', `INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
    SELECT $1,'unrelated-source-uuid-holder','OTHER-NUMBER',password_hash,id FROM public.admins WHERE id=$2`, [S.one, NEW.root]), 'source_uuid_occupied'],
  ['same live username', () => change('public.users', `INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
    SELECT $1,$2,'OTHER-NUMBER',password_hash,id FROM public.admins WHERE id=$3`, [T.existing, USERNAMES[S.one], NEW.root]), 'username_requires_archive'],
  ['same employee number', () => change('public.users', `INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
    SELECT $1,'different-employee-name',$2,password_hash,id FROM public.admins WHERE id=$3`, [T.existing, NUMBERS[S.one], NEW.root]), 'employee_number_conflict'],
  ['same administrator username', () => change('public.admins', `INSERT INTO public.admins(id,username,password_hash,role,is_active)
    SELECT $1,$2,password_hash,'secondary_admin',false FROM public.admins WHERE id=$3`, [T.existing, USERNAMES[S.one], NEW.root]), 'administrator_username_conflict'],
  ['occupied old order ID', () => change('public.orders', `INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status)
    VALUES($1,$2,$3,$4,1,'PREEXISTING-COLLISION','PREEXISTING-COLLISION','failure')`, [id(200), T.existing, 'collision-holder', S.product]), 'order_id_conflict'],
]) test(`SQL49 ${label} remains blocked rather than treating candidate mapping as replacement authorization`, async () => {
  await scenario(async () => {
    const p = await plan(); assert.equal(p.can_begin, false); assert.ok(conflictReasons(p).includes(reason)); closed(p);
    const frozen = await snapshot(); await assert.rejects(core(p)); assert.deepEqual(await snapshot(), frozen);
    const legacy = await rpc('get_employee_import_identity_plan', auth()); assert.equal(legacy.can_restore, false);
    assert.equal(legacy.replacement_ready, false); assert.equal(legacy.full_site_complete, false);
    const expectedReason = reason === 'source_uuid_occupied' ? 'employee_id_conflict' : reason;
    assert.ok(legacy.conflicts.some(c => c.reason === expectedReason));
    await assert.rejects(rpc('employee_import_identity_begin', { ...auth(), p_plan_hash: legacy.plan_hash }));
    await noLegacyAuthorization();
  }, { beforeReserve: async () => {
    if (reason === 'order_id_conflict') {
      await change('public.product_types', "INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Collision fixture product',false)", [S.product]);
      await change('public.users', `INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
        SELECT $1,'collision-holder','COLLISION-HOLDER',password_hash,id FROM public.admins WHERE id=$2`, [T.existing, NEW.root]);
    }
    await mutate();
  } });
});

for (const kind of ['user', 'admin']) test(`SQL49 subsequently occupied candidate ${kind} is rejected without overwriting it`, async () => scenario(async bindings => {
  const p = await plan(), candidate = bindings[S.one].target_id;
  if (kind === 'user') await change('public.users', `INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
    SELECT $1,'candidate-holder','CANDIDATE-HOLDER',password_hash,id FROM public.admins WHERE id=$2`, [candidate, NEW.root]);
  else await change('public.admins', `INSERT INTO public.admins(id,username,password_hash,role,is_active)
    SELECT $1,'candidate-admin-holder',password_hash,'secondary_admin',false FROM public.admins WHERE id=$2`, [candidate, NEW.root]);
  const current = await plan(); assert.equal(current.can_begin, false); assert.ok(conflictReasons(current).includes('candidate_occupied'));
  const frozen = await snapshot(); await assert.rejects(core(p)); await assert.rejects(core(current));
  assert.deepEqual(await snapshot(), frozen); await noLegacyAuthorization();
}));

for (const drift of ['source', 'target']) test(`SQL49 coherent ${drift} fingerprint drift cannot rebase the SQL48 reservation`, async () => scenario(async () => {
  const p = await plan();
  if (drift === 'target') {
    await change('public.users', `INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
      SELECT $1,$2,'DRIFTED-NUMBER',password_hash,id FROM public.admins WHERE id=$3`, [T.existing, USERNAMES[S.one], NEW.root]);
  } else {
    const text = identity.texts.accounts.replace('mapped-fresh-one', 'mapped-other-one');
    const hashes = lines(text).map(sha).join('');
    await db.query(`UPDATE private.employee_transfer_staging SET payload=jsonb_build_object('ndjson',$2::text,
      'rows',(SELECT jsonb_agg(line::jsonb ORDER BY no) FROM unnest(string_to_array(left($2::text,length($2::text)-1),E'\\n')) WITH ORDINALITY AS input(line,no)),
      'bytes',octet_length($2::text),'row_hashes',$3::text,'last_id',$4::text)
      WHERE job_id=$1 AND table_key='identity-in:accounts' AND chunk_no=0`, [task.job_id, text, hashes, S.two]);
    await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(jsonb_set(summary,
      '{identity_catalog,tables,0,row_hashes_sha256}',to_jsonb($2::text)),'{identity_catalog,tables,0,bytes}',to_jsonb($3::integer)) WHERE id=$1`,
    [task.job_id, sha(hashes), Buffer.byteLength(text)]);
  }
  const observed = await rpc('employee_import_identity_reservation_status', { ...auth(), p_source_id: S.one });
  assert.equal(observed[`${drift}_unchanged`], false);
  const frozen = await snapshot(), current = await plan(); assert.equal(current.can_begin, false);
  assert.ok(conflictReasons(current).includes('reservation_drift'));
  await assert.rejects(core(p)); await assert.rejects(core(current)); assert.deepEqual(await snapshot(), frozen);
  await noLegacyAuthorization();
}));

test('SQL49 missing SQL48 reservation cannot create a user or fabricate a binding', async () => scenario(async () => {
  const frozen = await snapshot();
  await assert.rejects(plan()); await assert.rejects(status());
  await assert.rejects(mapped('core', S.one, { p_plan_hash: '0'.repeat(64) }));
  await assert.rejects(orders(S.one, 0)); await assert.rejects(verify()); assert.deepEqual(await snapshot(), frozen);
}, { reserveCandidates: false }));

test('SQL49 active historical placeholder blocks core before any stopped identity is inserted', async () => scenario(async () => {
  const p = await plan(); await change('public.product_types', "INSERT INTO public.product_types(name,is_active) VALUES('舊站匯入（精簡訂單）',true)");
  const changed = await plan(); assert.equal(changed.can_begin, false); assert.ok(conflictReasons(changed).includes('placeholder_product_active'));
  const frozen = await snapshot(); await assert.rejects(core(p)); await assert.rejects(core(changed)); assert.deepEqual(await snapshot(), frozen);
}));

test('SQL49 an administrator missing from the real same-package map is a conflict, never silently assigned to root', async () => {
  const input = await sourceVariant(async () => {
    await source.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      SELECT $1,'identity-only-administrator',password_hash,'secondary_admin',false FROM public.admins WHERE id=$2`, [S.otherRoot, NEW.root]);
    await source.query('UPDATE public.users SET created_by=$1 WHERE id=$2', [S.otherRoot, S.one]);
  });
  await scenario(async () => {
    const p = await plan(); assert.equal(p.can_begin, false); assert.ok(conflictReasons(p).includes('unmapped_administrator'));
    const frozen = await snapshot(); await assert.rejects(core(p)); assert.deepEqual(await snapshot(), frozen);
  }, { input });
});

for (const field of ['remarks', 'tags', 'total_income', 'is_active', 'session', 'credential', 'wallet', 'order_value', 'order_commission', 'extra_order']) {
  test(`SQL49 write drift in ${field} fails status/repeated core/orders/verify even after a verified success`, async () => scenario(async () => {
    const p = await plan(); await complete(p);
    if (field === 'remarks') await change('public.users', "UPDATE public.users SET remarks='post-write drift' WHERE id=$1", [p.target_id]);
    if (field === 'tags') await change('public.users', "UPDATE public.users SET tags=ARRAY['different'] WHERE id=$1", [p.target_id]);
    if (field === 'total_income') await change('public.users', 'UPDATE public.users SET total_income=total_income+0.00000000000000000001 WHERE id=$1', [p.target_id]);
    if (field === 'is_active') await change('public.users', 'UPDATE public.users SET is_active=true WHERE id=$1', [p.target_id]);
    if (field === 'session') await change('public.users', 'UPDATE public.users SET current_session_token=$2,current_tab_id=\'late-session\' WHERE id=$1', [p.target_id, randomUUID()]);
    if (field === 'credential') await change('public.financial_employee_credentials', "UPDATE public.financial_employee_credentials SET password_hash='drifted' WHERE user_id=$1", [p.target_id]);
    if (field === 'wallet') await change('public.wallets', 'UPDATE public.wallets SET available_balance=1 WHERE user_id=$1', [p.target_id]);
    if (field === 'order_value') await change('public.orders', "UPDATE public.orders SET transaction_id='unapproved historical detail' WHERE id=$1", [id(200)]);
    if (field === 'order_commission') await change('public.orders', 'UPDATE public.orders SET commission_amount=commission_amount+0.00000000000000000001 WHERE id=$1', [id(200)]);
    if (field === 'extra_order') await change('public.orders', `INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status)
      SELECT $1,$2,$3,id,0.01,'EXTRA','EXTRA','failure' FROM public.product_types WHERE name='舊站匯入（精簡訂單）'`, [id(999), p.target_id, USERNAMES[S.one]]);
    const frozen = await snapshot(), modes = await triggers();
    for (const role of ['anon', 'authenticated']) {
      await assert.rejects(status(S.one, {}, role)); await assert.rejects(core(p, {}, role));
      await assert.rejects(orders(S.one, 0, {}, role)); await assert.rejects(verify(S.one, {}, role));
    }
    assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.equal(await permitCount(), 0);
  }));
}

for (const [label, sql] of [
  ['unknown users trigger', 'CREATE TRIGGER aa_mapped_unknown BEFORE INSERT ON public.users FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['changed wallet function', 'ALTER FUNCTION public.create_wallet_for_new_user() SECURITY INVOKER'],
  ['disabled order trigger', 'ALTER TABLE public.orders DISABLE TRIGGER trigger_sync_order_to_wallet'],
  ['replica snapshot trigger', 'ALTER TABLE public.orders ENABLE REPLICA TRIGGER snapshot_order_dispatch_rates'],
]) test(`SQL49 rejects ${label}; audited trigger allowlist is not relaxed`, async () => scenario(async () => {
  const p = await plan(); await db.exec(sql); const frozen = await snapshot(), modes = await triggers();
  await assert.rejects(core(p), /Unreviewed|trigger/i); assert.deepEqual(await snapshot(), frozen);
  assert.deepEqual(await triggers(), modes); assert.equal(await permitCount(), 0);
}));

// Archives are created only by the existing RPC in a local negative fixture maintenance window.
// No archive or employee-safety backup call is part of the golden success path.
test('SQL49 real archived same-name history remains blocked even when its old username and employee number have been released', async () => scenario(async () => {
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.deleted_employee_accounts WHERE employee_id=$1 AND cleared_at IS NULL', [T.existing]), 1);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.users WHERE username=$1', [USERNAMES[S.one]]), 0);
  const frozen = await snapshot(), p = await plan(); assert.equal(p.can_begin, false);
  assert.ok(conflictReasons(p).includes('archive_history_requires_backup')); await assert.rejects(core(p));
  assert.deepEqual(await snapshot(), frozen); await noLegacyAuthorization();
}, { beforeReserve: async () => {
  const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
  await db.exec('DELETE FROM private.employee_transfer_maintenance');
  await db.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
    SELECT $1,$2,$3,password_hash,id FROM public.admins WHERE id=$4`, [T.existing, USERNAMES[S.one], NUMBERS[S.one], NEW.root]);
  assert.equal((await rpc('archive_employee_without_media', { p_admin_session_token: session, p_user_id: T.existing })).success, true);
  await db.query('INSERT INTO private.employee_transfer_maintenance SELECT * FROM jsonb_populate_record(NULL::private.employee_transfer_maintenance,$1::jsonb)', [JSON.stringify(maintenance)]);
} }));

for (const timezone of ['Asia/Taipei', 'America/New_York']) test(`SQL49 deterministic UTC core/orders/verify/status in ${timezone} session`, async () => scenario(async () => {
  await db.query("SELECT set_config('TimeZone',$1,true)", [timezone]);
  const p = await plan(); await complete(p);
  const s = await status(); assert.equal(s.verified, true);
  assert.deepEqual(await core(p), s);
  assert.equal(await scalar(db, "SELECT current_setting('TimeZone')"), timezone);
  await db.exec("SET LOCAL TimeZone='UTC'"); await assertAccount(S.one, p.target_id); await assertOrders(S.one, p.target_id);
}));

for (const [field, value] of [['scope', 'forged'], ['site_id', id(900)], ['source_site_id', id(901)], ['package_id', id(902)],
  ['source_fingerprint', '0'.repeat(64)], ['binding_hash', '0'.repeat(64)], ['plan_hash', '0'.repeat(64)],
  ['can_restore', true], ['complete_employee_backup', true], ['can_archive', true], ['can_replace', true],
  ['full_site_complete', true], ['dependencies_pending', false]]) {
  test(`SQL49 corrupted private plan ${field} never yields a verified status or write`, async () => scenario(async () => {
    const p = await plan(); await core(p);
    await db.query('UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$3::text[],$4::jsonb) WHERE job_id=$1 AND employee_id=$2 AND table_key=$5',
      [task.job_id, S.one, ['plan', field], JSON.stringify(value), STATE_KEY]);
    const frozen = await snapshot();
    await assert.rejects(status()); await assert.rejects(core(p)); await assert.rejects(orders(S.one, 0)); await assert.rejects(verify());
    assert.deepEqual(await snapshot(), frozen); assert.equal(await permitCount(), 0);
  }));
}

for (const phase of ['core', 'orders']) test(`SQL49 ${phase} constraint failure rolls back business rows, cursor, permits and trigger modes`, async () => scenario(async () => {
  const p = await plan();
  if (phase === 'orders') await core(p);
  await db.exec(`ALTER TABLE public.${phase === 'core' ? 'financial_employee_credentials' : 'orders'}
    ADD CONSTRAINT mapped_test_insert_failure CHECK(user_id<>'${p.target_id}'::uuid) NOT VALID`);
  const frozen = await snapshot(), modes = await triggers();
  await assert.rejects(phase === 'core' ? core(p) : orders(S.one, 0));
  assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.equal(await permitCount(), 0);
}));

function clientTransport(loseCore = false) {
  const calls = [];
  modules.setHarness({ token: session, rpc(name, args) {
    assert.ok(RPCS.includes(name)); calls.push(name);
    const query = { abortSignal() { return query; }, then(resolve, reject) {
      return rpc(name, args).then(data => {
        if (loseCore && name === PREFIX + 'core') { loseCore = false; throw new Error('private lost-response canary'); }
        return { data, error: null };
      }).then(resolve, reject);
    } };
    return query;
  } });
  return calls;
}

test('SQL49 real client consumes actual RPC replies and explicitly reconciles a lost core response', async () => scenario(async bindings => {
  const calls = clientTransport(true), client = modules.createEmployeeMappedIdentitySession(task.job_token);
  const p = await client.plan(S.one); common(p, bindings[S.one]);
  await assert.rejects(client.core(p), /unconfirmed/);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.users WHERE id=$1', [p.target_id]), 1);
  assert.equal(calls.filter(name => name === PREFIX + 'core').length, 1);
  const count = calls.length; await assert.rejects(client.orders(S.one, 0), /unconfirmed/); assert.equal(calls.length, count);
  const s = await client.status(S.one); common(s, bindings[S.one]); assert.equal(s.next_chunk, 0);
  for (let no = 0; no < p.order_chunks; no++) await client.orders(S.one, no);
  const verified = await client.verify(S.one); assert.equal(verified.verified, true); closed(verified);
  assert.deepEqual(await client.status(S.one), verified);
  await assertAccount(S.one, p.target_id); await assertOrders(S.one, p.target_id); await noLegacyAuthorization();
}));
