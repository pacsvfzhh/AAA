import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
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

// Strict historical replay + actual SQL14 bind/stage, real sealed settings/dispatch backups,
// and actual existing archive RPC. No network, fabricated backup marker or employee deletion API.
const MIGRATION = '20261102000037_plan_employee_replacement.sql';
const PLAN = 'employee_import_replacement_plan', STATUS = 'employee_import_replacement_status';
const KEYS = {
  shared: ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'],
  dispatch: ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'],
  identity: ['accounts', 'credentials', 'orders'],
};
const id = n => `37000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const S = { same: id(1), uuid: id(2), number: id(3), admin: id(4), fresh: id(5), case: id(6), foreignUuid: id(7) };
const T = { same: id(101), number: id(103), case: id(106), unrelated: id(107), root: id(201), branch: id(202) };
const PRECISE = '12345678901234567890.12345678901234567890';
const sha = text => createHash('sha256').update(text).digest('hex');
let replay, source, db, session, sourceSession, branch, other, task, pkg, identity, modules;
let savepoint = 0;
const auth = (job = task, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
async function transaction(fn, site = db) {
  await site.exec('BEGIN');
  try { return await fn(); } finally { await site.exec('ROLLBACK'); }
}
async function on(site, name, args, role = 'anon') {
  const point = `replacement_${++savepoint}`;
  await site.exec(`SAVEPOINT ${point}`);
  try {
    await site.exec(`SET LOCAL ROLE ${role}`);
    const result = await baseRpc(site, name, args, { role: null });
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`);
    return result;
  } catch (error) {
    await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
    throw error;
  }
}
const rpc = (name, args, role) => on(db, name, args, role);
const plan = (extra = {}) => rpc(PLAN, { ...auth(), ...extra });
const checkpoint = p => ({ p_source_fingerprint: p.source_fingerprint, p_target_fingerprint: p.target_fingerprint, p_after: p.after, p_limit: p.limit });
const status = (p, extra = {}) => rpc(STATUS, { ...auth(), ...checkpoint(p), ...extra });
const rowFor = (p, sourceId) => p.rows.find(row => row.source_id === sourceId);
const targetFor = (p, sourceId) => rowFor(p, sourceId).targets[0];
async function employee(site, employeeId, username, number) {
  await site.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
    VALUES($1,$2,$3,extensions.crypt($4,extensions.gen_salt('bf',4)),$5)`, [employeeId, username, number, PASSWORDS.employee, NEW.root]);
}
async function capture(kind) {
  const job = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
    ...(kind === 'identity' ? { p_package_id: pkg } : {}) });
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
  try { const bytes = Buffer.alloc(65521); for (;;) { const r = await handle.read(bytes); if (!r.bytesRead) return; yield bytes.subarray(0, r.bytesRead); } }
  finally { await handle.close(); }
}
async function prepare(kind, input) {
  const job = await rpc(kind === 'shared' ? 'employee_import_shared_replace_begin' : 'employee_import_dispatch_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: pkg, p_catalog: input.catalog,
  });
  for (const key of KEYS[kind]) await rpc(`employee_import_${kind}_stage`, { ...auth(job), p_table_key: key, p_chunk_no: 0, p_ndjson: input.texts[key] });
  const p = await rpc(kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', auth(job));
  const descriptor = await rpc(`get_employee_import_${kind}_backup`, auth(job));
  const dir = await mkdtemp(join(tmpdir(), 'employee-replacement-')), path = join(dir, 'independent.edx'), plain = new Map();
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
    }, 'local-independent-replacement-prerequisite-backup');
    assert.equal(result.sealReceipt.success, true); assert.equal(plain.size, 0);
    assert.equal(await scalar(db, 'SELECT sealed_at IS NOT NULL FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), true);
    return { job, plan: p };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
// Deliberate local fixture edits only, exact trigger modes restored. Never a production path.
async function change(relation, sql, args = []) {
  const modes = await rows(db, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
  for (const t of modes) await db.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
  try { await db.query(sql, args); } finally {
    for (const t of modes) await db.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`);
  }
}
async function snapshot() {
  const names = (await rows(db, `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') ORDER BY 1`)).map(r => r.name);
  return rows(db, names.map(name => `SELECT '${name}' AS name,count(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} AS r`).join(' UNION ALL '));
}
function transport() {
  modules.setHarness({ token: session, rpc(name, args) {
    assert.ok([PLAN, STATUS].includes(name));
    const query = { abortSignal() { return query; }, then(resolve, reject) { return rpc(name, args).then(data => ({ data, error: null })).then(resolve, reject); } };
    return query;
  } });
}
before(async () => {
  for (const [module, name] of [[globalThis, 'fetch'], [http, 'request'], [https, 'request'], [net, 'connect'], [tls, 'connect']]) {
    mock.method(module, name, () => assert.fail('network and production services forbidden'));
  }
  replay = await createSites({ upTo: MIGRATION }); source = replay.oldSite; db = replay.newSite;
  assert.equal(replay.failures.length, 12); assert.ok(replay.files.includes(MIGRATION));
  await buildNewSite(source); await buildNewSite(db);
  await source.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  for (const [key, username, number] of [['same', 'replacement-shared', 'SOURCE-1'], ['uuid', 'replacement-uuid', 'SOURCE-2'],
    ['number', 'replacement-number', 'TAKEN'], ['admin', 'replacement-admin', 'SOURCE-4'], ['fresh', 'replacement-fresh', 'SOURCE-5'],
    ['case', 'CaseEmployee', 'SOURCE-6'], ['foreignUuid', 'replacement-foreign-id', 'SOURCE-7']]) await employee(source, S[key], username, number);
  for (const [targetId, username, number] of [[T.same, 'replacement-shared', 'TARGET-1'], [S.uuid, 'replacement-uuid', 'TARGET-2'],
    [T.number, 'someone-else', 'TAKEN'], [T.case, 'caseemployee', 'TARGET-6'], [S.foreignUuid, 'other-uuid-owner', 'TARGET-7'],
    [T.unrelated, 'unrelated', 'UNRELATED']]) await employee(db, targetId, username, number);
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES
    ($1,'replacement-admin',extensions.crypt($3,extensions.gen_salt('bf',4)),'super_admin',true),
    ($2,'replacement-secondary',extensions.crypt($4,extensions.gen_salt('bf',4)),'secondary_admin',true)`, [T.root, T.branch, PASSWORDS.root, PASSWORDS.branch]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=ANY($1::uuid[])', [[T.root, T.branch]]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'replacement-secondary', PASSWORDS.branch); other = await adminLogin(db, 'replacement-admin', PASSWORDS.root); pkg = randomUUID();
  const compiled = await build({ stdin: { contents: `export {createReplacementBackup} from './src/lib/employeeTransfer/replacementBackup.ts';
    export {createDispatchBackup} from './src/lib/employeeTransfer/dispatchBackup.ts';
    export * from './src/lib/employeeTransfer/employeeReplacement.ts'; export {setHarness} from 'replacement-db:state';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', plugins: [{ name: 'local-sql-only', setup(builder) {
    builder.onResolve({ filter: /^(?:replacement-db:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'replacement-db' }));
    builder.onLoad({ filter: /.*/, namespace: 'replacement-db' }, ({ path }) => ({ contents: path === 'replacement-db:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth' ? 'import{current}from"replacement-db:state";export const getAdminFinancialSessionToken=()=>current().token;'
        : 'import{current}from"replacement-db:state";export const supabase={rpc:(name,args)=>current().rpc(name,args)};' }));
  } }] });
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  await source.exec('BEGIN'); const shared = await capture('shared'), dispatch = await capture('dispatch'); identity = await capture('identity'); await source.exec('COMMIT');
  await db.exec('BEGIN');
  const sharedPrepared = await prepare('shared', shared);
  assert.equal((await rpc('employee_import_shared_replace_apply', { ...auth(sharedPrepared.job), p_plan_hash: sharedPrepared.plan.plan_hash })).success, true);
  await rpc('employee_transfer_cancel', auth(sharedPrepared.job));
  const prepared = await prepare('dispatch', dispatch); task = prepared.job;
  await rpc('employee_import_dispatch_enter_maintenance', { ...auth(), p_plan_hash: prepared.plan.plan_hash, p_confirmation: '確認暫停業務並導入派單資料', p_admin_password: PASSWORDS.root });
  const config = await rpc('get_employee_import_dispatch_configuration_plan', auth());
  await rpc('employee_import_dispatch_apply_configuration', { ...auth(), p_plan_hash: config.plan_hash });
  await rpc('employee_import_identity_bind', { ...auth(), p_catalog: identity.catalog });
  for (const key of KEYS.identity) await rpc('employee_import_identity_stage', { ...auth(), p_table_key: key, p_chunk_no: 0, p_ndjson: identity.texts[key] });
  // Introduce risks AFTER genuine owner setup solely to test the read-only gate. No employee-backup claim.
  await change('public.wallets', 'UPDATE public.wallets SET available_balance=$2::numeric,frozen_balance=2.345678901234567890123456789 WHERE user_id=$1', [T.same, PRECISE]);
  await change('public.withdrawals', `INSERT INTO public.withdrawals(id,user_id,amount,status) VALUES($1,$2,$3::numeric,'pending'),($4,$2,1,'approved')`, [id(301), T.same, PRECISE, id(302)]);
  await change('public.orders', `INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status,commission_amount)
    SELECT $1,$2,'replacement-shared',id,1,'replacement-order','replacement-order','success',1 FROM public.product_types LIMIT 1`, [id(303), T.same]);
  await change('public.employee_login_history', `INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,created_at) VALUES
    ($1,$2,'replacement-shared','TARGET-1','login','2026-10-01T00:00:00.123456Z'),($3,$2,'replacement-shared','TARGET-1','logout','2026-10-02T00:00:00Z')`, [id(304), T.same, id(305)]);
  await change('public.simulated_customers', `INSERT INTO public.simulated_customers(id,admin_id,customer_name,customer_id,source_type) VALUES($1,$2,'Local role','REPLACEMENT','aaa_service')`, [id(306), NEW.root]);
  await change('public.customer_employee_conversations', `INSERT INTO public.customer_employee_conversations(id,customer_id,employee_id,sender_type,message_type,message_content,source_type)
    VALUES($1,$2,$3,'customer','text','local archived evidence','aaa_service')`, [id(307), id(306), T.same]);
  await db.exec('COMMIT');
}, { timeout: 600000 });
after(async () => { await Promise.allSettled([source?.close(), db?.close()]); mock.restoreAll(); });

test('SQL37 exposes exactly two STABLE read-only RPCs, no table/write/trigger/service permissions', async () => transaction(async () => {
  const added = await rows(db, `SELECT proname,provolatile,prosecdef,proconfig FROM pg_proc WHERE proname LIKE '%replacement_%' AND pronamespace='public'::regnamespace ORDER BY proname`);
  assert.deepEqual(added.map(r => r.proname), [PLAN, STATUS]);
  for (const fn of added) { assert.equal(fn.provolatile, 's'); assert.equal(fn.prosecdef, true); assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp')); }
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [role, `public.${PLAN}(uuid,uuid,uuid,integer)`]), role !== 'service_role');
    assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [role, 'private.employee_transfer_replacement_target(uuid)']), false);
  }
  const before = await snapshot();
  await db.exec('SET TRANSACTION READ ONLY');
  const p = await plan(); assert.equal((await status(p)).target_unchanged, true);
  assert.deepEqual(await plan(), p); assert.deepEqual(await snapshot(), before);
}));
test('same-name fixed-source risks preserve decimal text, completed/chat/login counts and last login', async () => transaction(async () => {
  const p = await plan(), row = rowFor(p, S.same), target = targetFor(p, S.same);
  assert.equal(p.total_sources, 7); assert.deepEqual(p.counts, { sources: 7, conflicts: 5, archived: 0 });
  assert.equal(target.target_id, T.same); assert.equal(target.employee_no, 'TARGET-1'); assert.equal(row.source_employee_no, 'SOURCE-1');
  assert.equal(target.available_balance, PRECISE); assert.equal(target.pending_amount, PRECISE); assert.equal(target.pending_withdrawals, 1);
  assert.equal(target.frozen_balance, '2.345678901234567890123456789');
  assert.equal(target.completed_orders, 1); assert.equal(target.chat, 1); assert.equal(target.login, 1); assert.equal(target.last_login, '2026-10-01T00:00:00.123456+00:00');
  assert.equal(p.can_archive, false); assert.equal(p.can_replace, false); assert.equal(p.backup_required, true); assert.equal(p.full_site_complete, false);
  assert.ok(row.blockers.includes('maintenance_blocks_existing_archive')); assert.ok(row.blockers.includes('complete_employee_backup_missing'));
  assert.equal(rowFor(p, S.fresh).backup_required, false); assert.equal(rowFor(p, S.case).targets.length, 0);
  assert.doesNotMatch(JSON.stringify(p), /password_hash|current_session_token|local archived evidence/);
  transport(); const client = modules.createEmployeeReplacementSession(task.job_token);
  assert.deepEqual(await client.plan(), p); assert.equal((await client.status(modules.employeeReplacementCheckpoint(p))).target_unchanged, true);
}));
test('same UUID, foreign UUID owner, foreign employee number and administrator name all explicitly block', async () => transaction(async () => {
  const p = await plan();
  assert.ok(rowFor(p, S.uuid).blockers.includes('source_uuid_occupied'));
  assert.ok(rowFor(p, S.foreignUuid).blockers.includes('source_uuid_occupied')); assert.equal(rowFor(p, S.foreignUuid).targets.length, 0);
  assert.ok(rowFor(p, S.number).blockers.includes('employee_no_other_username')); assert.equal(rowFor(p, S.number).targets.length, 0);
  assert.ok(rowFor(p, S.admin).blockers.includes('administrator_username_conflict'));
  assert.equal((await scalar(db, 'SELECT username FROM public.users WHERE id=$1', [T.number])), 'someone-else');
}));
test('pagination binds source cursor and page fingerprints; no unbound target IDs or backup claims accepted', async () => transaction(async () => {
  const p = await plan({ p_limit: 2 }); assert.equal(p.rows.length, 2); assert.equal(p.next_after, S.uuid);
  const next = await plan({ p_after: p.next_after, p_limit: 2 }); assert.equal(next.rows[0].source_id, S.number);
  assert.notEqual(next.target_fingerprint, p.target_fingerprint); assert.equal(next.source_fingerprint, p.source_fingerprint);
  await assert.rejects(plan({ p_after: T.same }), /cursor/);
  await assert.rejects(plan({ p_limit: 201 }), /page size/);
  await assert.rejects(plan({ p_target_ids: [T.same] }), /no argument/);
  await assert.rejects(status(p, { p_backup_verified: true }), /no argument/);
}));
test('same-count target edits and conflict-owner changes drift; unrelated accounts do not', async () => transaction(async () => {
  const p = await plan();
  await change('public.users', 'UPDATE public.users SET remarks=\'outside\' WHERE id=$1', [T.unrelated]);
  assert.equal((await status(p)).target_unchanged, true);
  await change('public.withdrawals', 'UPDATE public.withdrawals SET audit_remark=\'same-count edit\' WHERE id=$1', [id(301)]);
  assert.equal((await status(p)).target_unchanged, false);
  const next = await plan();
  await change('public.users', 'UPDATE public.users SET remarks=\'foreign identity changed\' WHERE id=$1', [T.number]);
  assert.equal((await status(next)).target_unchanged, false);
}));
test('actual archive is blocked by maintenance; genuine archived record is observed without claiming unchanged or UUID release', async () => transaction(async () => {
  const p = await plan();
  await assert.rejects(rpc('archive_employee_without_media', { p_admin_session_token: session, p_user_id: S.uuid }), /paused/);
  // Test-only postgres fixture creates the existing flow's outcome in a maintenance-free window.
  // SQL37 cannot open this window and continues to report that real orchestration is missing.
  const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
  await db.exec('DELETE FROM private.employee_transfer_maintenance');
  const archived = await rpc('archive_employee_without_media', { p_admin_session_token: session, p_user_id: S.uuid }); assert.equal(archived.success, true);
  const withChat = await rpc('archive_employee_without_media', { p_admin_session_token: session, p_user_id: T.same }); assert.equal(withChat.success, true);
  await db.query('INSERT INTO private.employee_transfer_maintenance SELECT * FROM jsonb_populate_record(NULL::private.employee_transfer_maintenance,$1::jsonb)', [JSON.stringify(maintenance)]);
  const s = await status(p), row = rowFor(s, S.uuid), target = targetFor(s, S.uuid);
  assert.equal(target.archived, true); assert.equal(target.archive_evidence, true); assert.ok(target.archive_record_id);
  assert.equal(target.username_released, true); assert.equal(target.employee_no_released, true); assert.equal(s.counts.archived, 2);
  assert.ok(row.blockers.includes('source_uuid_occupied')); assert.equal(s.target_unchanged, false); assert.equal(s.can_archive, false); assert.equal(s.can_replace, false);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.users WHERE id=$1', [S.uuid]), 1);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.content_audit_events WHERE employee_id=$1', [T.same]), 1);
  assert.equal((await status(await plan())).target_unchanged, true); // Fresh observational baseline, still NOT authorization.
  transport(); assert.deepEqual(await modules.createEmployeeReplacementSession(task.job_token).plan(), await plan());
  await change('public.users', `UPDATE public.users SET username='replacement-uuid',employee_id='NEW-HOLDER' WHERE id=$1`, [T.unrelated]);
  const occupied = await status(p); assert.equal(targetFor(occupied, S.uuid).username_released, false);
  assert.ok(rowFor(occupied, S.uuid).blockers.includes('ambiguous_target_history'));
  await change('public.users', `UPDATE public.users SET employee_id='TARGET-2' WHERE id=$1`, [T.unrelated]);
  assert.equal(targetFor(await status(p), S.uuid).employee_no_released, false);
  await change('private.deleted_employee_accounts', 'UPDATE private.deleted_employee_accounts SET cleared_at=now() WHERE employee_id=$1', [S.uuid]);
  const cleared = await status(p); assert.equal(cleared.counts.archived, 1);
  assert.equal(rowFor(cleared, S.uuid).targets.some(t => t.target_id === S.uuid), false);
}));
test('tampered parsed source, raw source or bound catalog cannot silently become a new source', async () => transaction(async () => {
  const p = await plan();
  await db.query(`UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{rows,0,username}','"changed"') WHERE job_id=$1 AND table_key='identity-in:accounts'`, [task.job_id]);
  await assert.rejects(plan(), /source accounts changed/); await assert.rejects(status(p), /source accounts changed/);
}));
test('even coherently replaced staged accounts and catalog invalidate the original source checkpoint', async () => transaction(async () => {
  const p = await plan(), text = identity.texts.accounts.replace('replacement-shared', 'replacement-change');
  const lines = text.match(/[^\n]*\n/g), parsed = lines.map(line => JSON.parse(line)), rowHashes = lines.map(sha).join('');
  await db.query(`UPDATE private.employee_transfer_staging SET payload=jsonb_build_object('ndjson',$2::text,'rows',$3::jsonb,
    'bytes',octet_length($2::text),'row_hashes',$4::text,'last_id',$5::text) WHERE job_id=$1 AND table_key='identity-in:accounts'`,
  [task.job_id, text, JSON.stringify(parsed), rowHashes, parsed.at(-1).id]);
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(jsonb_set(summary,'{identity_catalog,tables,0,row_hashes_sha256}',to_jsonb($2::text)),
    '{identity_catalog,tables,0,bytes}',to_jsonb($3::integer)) WHERE id=$1`, [task.job_id, sha(rowHashes), Buffer.byteLength(text)]);
  assert.notEqual((await plan()).source_fingerprint, p.source_fingerprint);
  await assert.rejects(status(p), /bound replacement source changed/);
}));
test('source raw-byte and catalog drift, foreign owner, expiry, revocation, protocol and role fail closed', async () => {
  for (const changeSource of [
    () => db.query(`UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,'{ndjson}',to_jsonb(replace(payload->>'ndjson','replacement-shared','replacement-change'))) WHERE job_id=$1 AND table_key='identity-in:accounts'`, [task.job_id]),
    () => db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{identity_catalog,site_id}',to_jsonb($2::text)) WHERE id=$1`, [task.job_id, randomUUID()]),
  ]) await transaction(async () => { const p = await plan(); await changeSource(); await assert.rejects(status(p)); });
  for (const token of [null, randomUUID(), branch, other]) await transaction(async () => { await assert.rejects(plan({ p_admin_session_token: token })); });
  for (const sql of ["UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1",
    "UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1",
    "UPDATE private.employee_transfer_jobs SET options=options||'{\"import_protocol\":\"shared-import-v1\"}' WHERE id=$1"]) {
    await transaction(async () => { await db.query(sql, [task.job_id]); await assert.rejects(plan()); });
  }
  await transaction(async () => { await db.exec('DELETE FROM private.employee_transfer_maintenance'); await assert.rejects(plan(), /owner|maintenance/); });
  await transaction(async () => { await db.query('UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE token_hash=private.hash_financial_token($1)', [session]); await assert.rejects(plan()); });
  await transaction(async () => { await assert.rejects(plan({ p_job_token: randomUUID() })); await assert.rejects(rpc(PLAN, auth(), 'service_role'), /permission denied/); });
});
