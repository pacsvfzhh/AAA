import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, mock, test } from 'node:test';
import { build } from 'esbuild';
import { replayMigrations, assertExpectedReplayFailures } from './support/replay-migrations.mjs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { adminLogin, rows, scalar, rpc as baseRpc } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, OLD, PASSWORDS } from './support/transfer-fixtures.mjs';

// Local SQL replay, real anon RPCs and independent AES-GCM/ZIP backups only.
// No fabricated checkpoint/job/receipt in success paths. Explicit private-state
// corruption tests below model lost/legacy/ambiguous metadata, not real Storage,
// native PG concurrency, PostgREST performance or a complete ten-domain restore.
const PREVIOUS = '20261102000044_preflight_site_restore.sql';
const MIGRATION = '20261102000045_verify_site_prerequisites.sql';
const VERIFY = 'employee_import_site_verify_prerequisites';
const PREFLIGHT = 'get_employee_import_site_preflight';
const VERIFY_SIGNATURE = `public.${VERIFY}(uuid,uuid)`;
const PREFLIGHT_SOURCE = '45000000-0000-4000-8000-000000000001';
const BLOCKERS = ['same_site', 'active_maintenance', 'active_transfer_task', 'target_has_business', 'missing_backend_support'];
const previousSql = await readFile(new URL(`../migrations/${PREVIOUS}`, import.meta.url), 'utf8');
const signatures44 = [...previousSql.match(/FOREACH v_rpc IN ARRAY ARRAY\[([\s\S]*?)\]::text\[\] LOOP/)[1]
  .matchAll(/'(public\.[a-z_]+\([a-z,]*\))'/g)].map(match => match[1]);
const signatures45 = [...signatures44, VERIFY_SIGNATURE];
const SHARED = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'];
const DISPATCH = ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'];
const IDENTITY = ['accounts', 'credentials', 'orders'];
const PINNED = ['employee_transfer_guarded_tables()', 'employee_transfer_guard_write()', 'employee_transfer_lock_maintenance_tables()',
  'employee_transfer_allow_config_write(uuid)', 'employee_transfer_clear_write_permit()'];
const RECEIPT = { success: true, scope: 'site-prerequisites', verified: true, maintenance: true, full_site_complete: false };
const PACKAGE = randomUUID(), OTHER = randomUUID(), TARGET_PRODUCT = randomUUID(), SOURCE_PRODUCT = randomUUID(), ONLY_PRODUCT = randomUUID();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sql = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8');
const root = fileURLToPath(new URL('../../', import.meta.url));
let db, source, replay, session, otherSession, branch, emergency, sourceSession, modules;
let shared, products, dispatch, sharedPlan, productPlan, dispatchPlan, sharedReceipt, productReceipt;
let packages, pinnedBefore, originalBodies, originalPreflight, legacyDump, snapshotBefore, snapshotAfter, sharedCheckpoint, productCheckpoint, inside = false;

async function transaction(fn, site = db, mode = '') {
  await site.exec(`BEGIN ${mode}`);
  const previous = inside; inside = true;
  try { return await fn(); } finally { inside = previous; await site.exec('ROLLBACK'); }
}
async function call(site, name, args, role = 'anon') {
  assert.ok(['anon', 'authenticated', 'service_role', 'prerequisite_untrusted'].includes(role));
  const own = !inside;
  if (own) await site.exec('BEGIN');
  await site.exec('SAVEPOINT prerequisite_rpc');
  try {
    await site.exec(`SET LOCAL ROLE ${role}`);
    const result = await baseRpc(site, name, args, { role: null });
    await site.exec('RESET ROLE; RELEASE SAVEPOINT prerequisite_rpc');
    if (own) await site.exec('COMMIT');
    return result;
  } catch (error) {
    await site.exec('ROLLBACK TO SAVEPOINT prerequisite_rpc; RELEASE SAVEPOINT prerequisite_rpc');
    if (own) await site.exec('ROLLBACK');
    throw error;
  }
}
const rpc = (name, args, role) => call(db, name, args, role);
const auth = (job = dispatch, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
const verify = (args = {}, role) => rpc(VERIFY, { ...auth(), ...args }, role);
const checkpoint = job => scalar(db, "SELECT summary->'site_prerequisite_checkpoint' FROM private.employee_transfer_jobs WHERE id=$1", [job.job_id]);
const apply = (kind, job, plan) => rpc(kind === 'shared' ? 'employee_import_shared_replace_apply' : 'employee_import_products_apply', { ...auth(job), p_plan_hash: plan.plan_hash });
const enter = (job = dispatch, plan = dispatchPlan) => rpc('employee_import_dispatch_enter_maintenance', {
  ...auth(job), p_plan_hash: plan.plan_hash, p_confirmation: '確認暫停業務並導入派單資料', p_admin_password: PASSWORDS.root,
});
const quote = s => '"' + s.replaceAll('"', '""') + '"';
async function dataState(site = db) {
  const tables = await rows(site, `SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private','storage','cron') AND c.relkind IN ('r','p') ORDER BY 1,2`);
  return rows(site, tables.map(r => `SELECT '${r.nspname}.${r.relname}' AS relation,count(*)::integer,
    md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n' ORDER BY to_jsonb(t)::text COLLATE "C"),'')) AS hash
    FROM ${quote(r.nspname)}.${quote(r.relname)} t`).join(' UNION ALL '));
}
const preflight = (args = {}, role) => rpc(PREFLIGHT, { p_admin_session_token: session, p_source_site_id: PREFLIGHT_SOURCE, ...args }, role);
async function preflightState(site = db) {
  return { data: await dataState(site), sequences: await rows(site, `SELECT schemaname,sequencename,last_value FROM pg_sequences
    WHERE schemaname IN ('public','private','storage','cron') ORDER BY schemaname,sequencename`) };
}
async function checkedPreflight(blockers = [], missing = [], args = {}, role) {
  const state = await preflightState();
  const result = await preflight(args, role);
  assert.deepEqual(result, { version: 1, protocol: 'site-maintenance-restore-v1',
    site_id: await scalar(db, 'SELECT site_id FROM private.employee_transfer_site'), source_site_id: args.p_source_site_id ?? PREFLIGHT_SOURCE,
    can_restore_to_maintenance: blockers.length === 0, blockers, missing_rpcs: missing, full_site_complete: false, can_release: false });
  assert.deepEqual(result.blockers, BLOCKERS.filter(code => blockers.includes(code)));
  assert.equal(new Set(result.blockers).size, result.blockers.length); assert.equal(new Set(result.missing_rpcs).size, result.missing_rpcs.length);
  assert.deepEqual(await preflightState(), state, 'preflight does not write business/sequence/job/audit/staging/heartbeat/permit state');
  return result;
}
async function hideSignature(signature, name = 'prerequisite_hidden_capability') {
  assert.ok(signatures45.includes(signature));
  await db.exec(`ALTER FUNCTION ${signature} RENAME TO ${quote(name)}`);
}
async function rejected(args = {}, pattern = /prerequisite|invalid or expired|protocol|permission|Super administrator/) {
  const before = await dataState();
  await assert.rejects(verify(args), pattern);
  assert.deepEqual(await dataState(), before, 'failure rolls back heartbeat, receipts, audits, permits and all business writes');
}
async function schemaState() {
  return {
    tables: await rows(db, `SELECT c.oid,n.nspname,c.relname,c.relacl::text,c.relrowsecurity,a.attnum,a.attname,a.atttypid,a.attnotnull
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') ORDER BY c.oid,a.attnum`),
    triggers: await rows(db, 'SELECT oid,tgrelid,tgname,tgenabled,pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal ORDER BY oid'),
    policies: await rows(db, 'SELECT * FROM pg_policies ORDER BY schemaname,tablename,policyname'),
  };
}
const pinned = () => rows(db, `SELECT oid::regprocedure::text,pg_get_functiondef(oid),proacl::text FROM pg_proc
  WHERE oid=ANY($1::regprocedure[]::oid[]) ORDER BY oid`, [PINNED.map(s => `private.${s}`)]);
async function capture(kind) {
  const task = await call(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
    ...(kind === 'identity' ? { p_package_id: PACKAGE } : {}) });
  assert.equal(task.success, true);
  const texts = {};
  for (const key of kind === 'shared' ? SHARED : kind === 'products' ? ['product_types'] : kind === 'identity' ? IDENTITY : DISPATCH) {
    let after = null, text = '';
    do {
      const page = await call(source, `get_employee_export_${kind}_page`, { ...auth(task, sourceSession),
        ...(kind === 'products' ? {} : { p_table_key: key }), p_after: after, p_limit: 200 });
      assert.equal(page.sha256, hash(page.ndjson)); text += page.ndjson; after = page.next_after;
    } while (after !== null);
    texts[key] = text;
  }
  assert.equal((await call(source, `employee_export_${kind}_verify`, auth(task, sourceSession))).verified, true);
  await call(source, kind === 'shared' ? 'employee_export_shared_close' : kind === 'products' ? 'employee_products_close' : `employee_export_${kind}_close`, auth(task, sourceSession));
  return { catalog: task.catalog, texts };
}
async function prepare(kind) {
  const input = packages[kind];
  const task = await rpc(kind === 'shared' ? 'employee_import_shared_replace_begin' : `employee_import_${kind}_begin`, {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: PACKAGE, p_catalog: input.catalog,
  });
  assert.equal(task.success, true);
  for (const [key, text] of Object.entries(input.texts)) {
    assert.equal((await rpc(`employee_import_${kind}_stage`, { ...auth(task), ...(kind === 'products' ? {} : { p_table_key: key }), p_chunk_no: 0, p_ndjson: text })).success, true);
  }
  const plan = await rpc(kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : `get_employee_import_${kind}_dry_run`, auth(task));
  assert.equal(kind === 'dispatch' ? plan.preparation_ready : plan.can_apply, true, JSON.stringify(plan));
  return { task, plan };
}
async function* disk(path) {
  const f = await open(path, 'r');
  try { for await (const bytes of f.createReadStream({ autoClose: false, highWaterMark: 65521 })) yield bytes; }
  finally { await f.close(); }
}
async function sealBackup(kind, task, plan) {
  const descriptor = await rpc(`get_employee_import_${kind}_backup`, auth(task));
  const directory = await mkdtemp(join(tmpdir(), 'site-prerequisites-'));
  const paths = new Map(), filePath = join(directory, 'independent.edx'); let opens = 0, eof = 0;
  const passphrase = 'local-only-prerequisite-independent-backup-passphrase';
  try {
    const result = await modules[kind](descriptor, {
      async catalog() { return (await rpc(`get_employee_import_${kind}_backup`, auth(task))).catalog; },
      page(key, after) {
        return rpc(`get_employee_import_${kind}_backup_page`, { ...auth(task), ...(kind === 'products' ? { p_after: key } : { p_table_key: key, p_after: after }), p_limit: 200 });
      },
      async verify() {
        assert.deepEqual(await rpc(`get_employee_import_${kind}_backup`, auth(task)), descriptor);
        return { verified: true, scope: descriptor.catalog.scope, full_site_complete: false };
      },
    }, {
      async append(name, bytes) {
        if (!paths.has(name)) paths.set(name, join(directory, `plain-${paths.size}`));
        const f = await open(paths.get(name), 'a'); try { await f.writeFile(bytes); } finally { await f.close(); }
      },
      open(name) { return disk(paths.get(name)); },
      async abort() { await Promise.all([...paths.values()].map(path => rm(path, { force: true }))); },
    }, {
      async write(stream) {
        const f = await open(filePath, 'wx');
        try { for await (const bytes of stream) await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
      },
      open() { opens++; return (async function* () { yield* disk(filePath); eof++; })(); },
    }, {
      append(no, hex) {
        assert.equal(opens, 2); assert.ok(eof >= 1, 'independent ciphertext authenticated through EOF before server upload');
        return rpc(`employee_import_${kind}_backup_append`, { ...auth(task), p_plan_hash: plan.plan_hash, p_chunk_no: no, p_hex: hex });
      },
      seal(sha256, bytes) { return rpc(`employee_import_${kind}_backup_seal`, { ...auth(task), p_plan_hash: plan.plan_hash, p_sha256: sha256, p_bytes: bytes }); },
    }, passphrase);
    assert.equal(eof, 2); assert.equal(result.sealReceipt.success, true);
    const bytes = await readFile(filePath);
    assert.equal(hash(bytes), result.cipherSha256);
    const saved = await rpc(`get_employee_${kind}_saved_backup_chunk`, { p_admin_session_token: session, p_backup_id: task.job_id, p_chunk_no: 0 });
    assert.equal(saved.sha256, hash(bytes));
    assert.deepEqual(Buffer.from(saved.hex, 'hex'), bytes, 'small fixture is one real saved ciphertext chunk');
    await modules.verify(disk(filePath), passphrase, { async append() {}, async abort() { assert.fail('independent backup must authenticate'); } },
      { expectedMetadata: { exportId: task.job_id, volumeId: task.job_id } });
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function compiled(name, symbol) {
  const output = await build({ entryPoints: [`${root}src/lib/employeeTransfer/${name}.ts`], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020' });
  return (await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`))[symbol];
}

before(async () => {
  mock.method(globalThis, 'fetch', () => assert.fail('All production/network/Storage access prohibited'));
  replay = await replayMigrations({ upTo: PREVIOUS, strict: true }); db = replay.db;
  pinnedBefore = await pinned(); snapshotBefore = await schemaState();
  originalBodies = await rows(db, `SELECT proname,prosrc,proconfig FROM pg_proc WHERE oid IN (
    'public.employee_import_shared_replace_apply(uuid,uuid,text)'::regprocedure,'public.employee_import_products_apply(uuid,uuid,text)'::regprocedure) ORDER BY proname`);
  originalPreflight = await scalar(db, `SELECT jsonb_build_object('body',prosrc,'config',proconfig,'volatility',provolatile,'args',proargnames)
    FROM pg_proc WHERE oid='public.get_employee_import_site_preflight(uuid,uuid)'::regprocedure`);
  legacyDump = await db.dumpDataDir('none');
  const state = await dataState();
  await db.exec(sql); snapshotAfter = await schemaState(); assert.deepEqual(await dataState(), state);
  replay.files.push(MIGRATION); replay.validation = assertExpectedReplayFailures(replay, { upTo: MIGRATION });
  source = new PGlite({ loadDataDir: await db.dumpDataDir('none'), extensions: { pgcrypto, pg_trgm, uuid_ossp } }); await source.waitReady;
  await db.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await buildNewSite(db);
  for (const [site, id, username, role, password] of [
    [source, OLD.root, 'root', 'super_admin', PASSWORDS.root], [source, OLD.branch, 'branch', 'secondary_admin', PASSWORDS.branch],
    [source, OLD.emergency, 'emergency', 'emergency_admin', PASSWORDS.emergency], [db, OTHER, 'other-super', 'super_admin', PASSWORDS.root],
  ]) {
    await site.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$4,true)`, [id, username, password, role]);
    await site.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [id]);
  }
  await source.query(`UPDATE public.admins SET parent_id=$1 WHERE id IN ($2,$3)`, [OLD.root, OLD.branch, OLD.emergency]);
  for (const [site, value] of [[source, 'Source title'], [db, 'Target title']]) await site.query(`INSERT INTO public.system_configs(key,value)
    VALUES('login_title',to_jsonb($1::text)) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [value]);
  await source.query(`INSERT INTO public.admin_configs(admin_id,config_type,config_value) VALUES($1,'company_name','Source brand')`, [OLD.branch]);
  await source.query(`INSERT INTO public.product_types(id,name,is_active,sort_order,created_at,updated_at) VALUES
    ($1,'Mapped product',false,-7,'2024-01-02T03:04:05.123456Z',NULL),($2,'New product',true,12,NULL,'2025-02-03T04:05:06.654321Z')`, [OLD.product, SOURCE_PRODUCT]);
  // The real insert trigger assigns nonpositive values; model a legacy saved
  // negative sort with the supported subsequent UPDATE, not a trigger bypass.
  await source.query('UPDATE public.product_types SET sort_order=-7 WHERE id=$1', [OLD.product]);
  await db.query(`INSERT INTO public.product_types(id,name,is_active,sort_order) VALUES($1,'Mapped product',true,33),($2,'Target-only product',true,80)`, [TARGET_PRODUCT, ONLY_PRODUCT]);
  session = await adminLogin(db, 'root', PASSWORDS.root); otherSession = await adminLogin(db, 'other-super', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  packages = {};
  for (const kind of ['shared', 'products', 'dispatch', 'identity']) packages[kind] = await capture(kind);
  modules = { shared: await compiled('replacementBackup', 'createReplacementBackup'), products: await compiled('productBackup', 'createProductBackup'),
    dispatch: await compiled('dispatchBackup', 'createDispatchBackup'), verify: await compiled('container', 'verifyEncryptedVolume') };
  await db.exec('CREATE ROLE prerequisite_untrusted NOLOGIN; GRANT USAGE ON SCHEMA public TO prerequisite_untrusted');
}, { timeout: 180000 });
after(async () => { await source?.close(); await db?.close(); mock.restoreAll(); });

test('SQL45 follows the complete SQL44 replay with precisely 12 historical failures; preserves all tables, guards, triggers and policies', async t => {
  assert.deepEqual(replay.files.slice(-2), [PREVIOUS, MIGRATION]); assert.equal(replay.failures.length, 12);
  assert.equal(replay.validation.freshDatabaseVerified, false); assert.deepEqual(snapshotBefore, snapshotAfter); assert.deepEqual(await pinned(), pinnedBefore);
  await db.query('SELECT private.employee_transfer_assert_maintenance_guards()');
  const bodies = await rows(db, `SELECT replace(proname,'_base','') AS proname,prosrc,proconfig FROM pg_proc WHERE oid IN (
    'private.employee_import_shared_replace_apply_base(uuid,uuid,text)'::regprocedure,'private.employee_import_products_apply_base(uuid,uuid,text)'::regprocedure) ORDER BY proname`);
  assert.deepEqual(bodies, originalBodies);
  assert.deepEqual(await scalar(db, `SELECT jsonb_build_object('body',prosrc,'config',proconfig,'volatility',provolatile,'args',proargnames)
    FROM pg_proc WHERE oid='private.employee_transfer_site_preflight_base(uuid,uuid)'::regprocedure`), originalPreflight);
  assert.doesNotMatch(sql, /\bEXECUTE\s+(?:format|'|v_)|DISABLE TRIGGER|session_replication_role|INSERT INTO private.employee_transfer_write_permits|UPDATE private.employee_transfer_maintenance/i);
  t.diagnostic(`${replay.files.length} sorted migrations, exactly 12 original failures; not a clean database build`);
});
test('exact write RPC signatures/SECURITY DEFINER/search_path/UTC/ISO and ACL; no public, untrusted or service_role execute on bases/helpers', async () => {
  const publicFns = ['employee_import_shared_replace_apply(uuid,uuid,text)', 'employee_import_products_apply(uuid,uuid,text)', `${VERIFY}(uuid,uuid)`, `${PREFLIGHT}(uuid,uuid)`];
  const privateFns = ['employee_import_shared_replace_apply_base(uuid,uuid,text)', 'employee_import_products_apply_base(uuid,uuid,text)', 'employee_transfer_site_prerequisite_checkpoint(private.employee_transfer_jobs,text)', 'employee_transfer_site_preflight_base(uuid,uuid)'];
  for (const [schema, signatures] of [['public', publicFns], ['private', privateFns]]) for (const sig of signatures) {
    const name = `${schema}.${sig}`;
    const p = (await rows(db, `SELECT prosecdef,provolatile,prorettype::regtype::text AS result,proconfig,proacl::text,proargnames FROM pg_proc WHERE oid=to_regprocedure($1)`, [name]))[0];
    assert.equal(p.prosecdef, true); assert.equal(p.result, 'jsonb'); assert.ok(p.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    if (sig !== 'employee_transfer_site_preflight_base(uuid,uuid)') {
      assert.ok(p.proconfig.includes('TimeZone=UTC')); assert.ok(p.proconfig.includes('DateStyle=ISO, YMD'));
    }
    if (sig === `${PREFLIGHT}(uuid,uuid)`) {
      assert.equal(p.provolatile, 's'); assert.deepEqual(p.proargnames, ['p_admin_session_token', 'p_source_site_id']);
    }
    assert.doesNotMatch(p.proacl, /(?:^|,)=[^,]*X/);
    if (sig.startsWith(VERIFY)) { assert.equal(p.provolatile, 'v'); assert.deepEqual(p.proargnames, ['p_admin_session_token', 'p_job_token']); }
    for (const role of ['anon', 'authenticated', 'service_role', 'prerequisite_untrusted']) assert.equal(
      await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, name]), schema === 'public' && ['anon', 'authenticated'].includes(role), `${role} ${name}`);
  }
  for (const role of ['service_role', 'prerequisite_untrusted']) {
    await assert.rejects(rpc(VERIFY, { p_admin_session_token: session, p_job_token: randomUUID() }, role), /permission denied for function/);
    await assert.rejects(preflight({}, role), /permission denied for function/);
    await transaction(async () => {
      await db.exec(`SET LOCAL ROLE ${role}`);
      await assert.rejects(db.query('SELECT private.employee_transfer_site_preflight_base($1::uuid,$2::uuid)', [session, PREFLIGHT_SOURCE]), /permission denied/);
    });
  }
});
test('actual SQL44-only server still has 110-signature admission and cannot discover an uninstalled SQL45 (client capability check remains required)', async t => {
  const legacy = new PGlite({ loadDataDir: legacyDump, extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  try {
    await legacy.waitReady; await buildNewSite(legacy);
    const token = await adminLogin(legacy, 'root', PASSWORDS.root);
    assert.equal(await scalar(legacy, 'SELECT to_regprocedure($1)::text', [VERIFY_SIGNATURE]), null);
    assert.equal(await scalar(legacy, "SELECT to_regprocedure('private.employee_transfer_site_preflight_base(uuid,uuid)')::text"), null);
    const state = await preflightState(legacy);
    await transaction(async () => {
      const result = await call(legacy, PREFLIGHT, { p_admin_session_token: token, p_source_site_id: PREFLIGHT_SOURCE });
      assert.deepEqual(result, { version: 1, protocol: 'site-maintenance-restore-v1',
        site_id: await scalar(legacy, 'SELECT site_id FROM private.employee_transfer_site'), source_site_id: PREFLIGHT_SOURCE,
        can_restore_to_maintenance: true, blockers: [], missing_rpcs: [], full_site_complete: false, can_release: false });
      assert.deepEqual(await preflightState(legacy), state);
    }, legacy, 'READ ONLY');
    t.diagnostic('Unmodified SQL44 has no knowledge of SQL45; no shared import/job/permit is started by this probe.');
  } finally { await legacy.close(); legacyDump = null; }
});
test('SQL45 wrapper retains the original shape and represents 111 exact jsonb capabilities without exposing a count or invoking writes', async t => {
  assert.equal(signatures44.length, 110); assert.equal(signatures45.length, 111); assert.equal(new Set(signatures45).size, 111);
  for (const signature of signatures45) assert.equal(await scalar(db, `SELECT count(*)::int FROM pg_proc
    WHERE oid=to_regprocedure($1) AND prokind='f' AND prorettype='jsonb'::regtype`, [signature]), 1, signature);
  const result = await checkedPreflight();
  const base = await scalar(db, 'SELECT private.employee_transfer_site_preflight_base($1::uuid,$2::uuid)', [session, PREFLIGHT_SOURCE]);
  assert.deepEqual(result, base); assert.deepEqual(result.missing_rpcs, []);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_jobs'), 0);
  t.diagnostic('111 exact backend signatures = SQL44 original 110 + SQL45 verify; healthy missing_rpcs remains [].');
});
for (const role of ['anon', 'authenticated']) {
  test(`${role} SQL45 preflight runs in READ ONLY with no task/heartbeat/audit/sequence/permit writes`, async () => {
    await transaction(() => checkedPreflight([], [], {}, role), db, 'READ ONLY');
  });
  test(`${role} missing SQL45 verifier blocks in READ ONLY before any shared import is started`, async () => {
    // Trusted local DDL changes only capability existence and is undone even if
    // the READ ONLY assertion fails. The admission RPC itself does no DDL/writes.
    await hideSignature(VERIFY_SIGNATURE);
    try {
      await transaction(() => checkedPreflight(['missing_backend_support'], [VERIFY_SIGNATURE], {}, role), db, 'READ ONLY');
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_jobs'), 0);
    } finally {
      await db.exec(`ALTER FUNCTION public.prerequisite_hidden_capability(uuid,uuid) RENAME TO ${VERIFY}`);
    }
  });
}
for (const signature of signatures45) {
  test(`SQL45 wrapper blocks missing exact capability in fixed 111-signature baseline: ${signature}`, async () => transaction(async () => {
    await hideSignature(signature);
    await checkedPreflight(['missing_backend_support'], [signature]);
  }));
}
for (const [label, definition] of [
  ['wrong UUID/text overload and correct private-schema name', `CREATE FUNCTION public.${VERIFY}(uuid,text) RETURNS jsonb LANGUAGE sql STABLE AS 'SELECT ''{}''::jsonb';
    CREATE FUNCTION private.${VERIFY}(uuid,uuid) RETURNS jsonb LANGUAGE sql STABLE AS 'SELECT ''{}''::jsonb'`],
  ['exact parameters but wrong return type', `CREATE FUNCTION public.${VERIFY}(uuid,uuid) RETURNS text LANGUAGE sql STABLE AS 'SELECT ''not-jsonb'''`],
  ['procedure instead of function', `CREATE PROCEDURE public.${VERIFY}(uuid,uuid) LANGUAGE plpgsql AS 'BEGIN NULL; END'`],
]) test(`SQL45 capability ${label} cannot satisfy the required public jsonb signature`, async () => transaction(async () => {
  await hideSignature(VERIFY_SIGNATURE); await db.exec(definition);
  await checkedPreflight(['missing_backend_support'], [VERIFY_SIGNATURE]);
}));
test('missing old and SQL45 capabilities accumulate once in review order; existing missing_backend_support never duplicates', async () => transaction(async () => {
  const missing = [signatures44[0], signatures44[12], signatures44.at(-1), VERIFY_SIGNATURE];
  for (const [index, signature] of [...missing].reverse().entries()) await hideSignature(signature, `prerequisite_hidden_${index}`);
  await checkedPreflight(['missing_backend_support'], missing);
}));
test('all five blockers keep SQL44 fixed order with missing SQL45 support and no raw data/state changes (synthetic maintenance metadata negative)', async () => transaction(async () => {
  await db.query(`INSERT INTO public.valid_order_data(product_value,transaction_id,created_by,usage_count,last_used_at)
    VALUES(123.456,'LOCAL-PREREQUISITE-PREFLIGHT-CANARY',$1,1,now())`, [NEW.root]);
  const job = randomUUID();
  await db.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options,summary)
    VALUES($1,'import',$2,'LOCAL-PREREQUISITE-PREFLIGHT-CANARY',private.hash_financial_token($3),'running','{"private_options":"raw"}','{"private_summary":"raw"}')`, [job, NEW.root, randomUUID()]);
  await db.query(`INSERT INTO private.employee_transfer_maintenance(job_id,admin_id,plan_hash,target_hash,entered_at,dirty)
    VALUES($1,$2,repeat('a',64),repeat('b',64),now(),true)`, [job, NEW.root]);
  const missing = [signatures44.at(-1), VERIFY_SIGNATURE];
  for (const [index, signature] of [...missing].reverse().entries()) await hideSignature(signature, `prerequisite_hidden_${index}`);
  await checkedPreflight(BLOCKERS, missing, { p_source_site_id: await scalar(db, 'SELECT site_id FROM private.employee_transfer_site') });
}));
test('preflight never invokes SQL45 verifier, including a valid-signature implementation that would throw if called', async () => transaction(async () => {
  const definition = await scalar(db, 'SELECT pg_get_functiondef(to_regprocedure($1))', [VERIFY_SIGNATURE]);
  const start = definition.indexOf('AS $function$'); assert.ok(start > 0);
  await db.exec(definition.slice(0, start) + "AS $function$ BEGIN RAISE EXCEPTION 'Verifier must not execute during admission'; END; $function$;");
  await checkedPreflight();
}));
for (const [label, args] of [
  ['NULL session', () => ({ p_admin_session_token: null })], ['random session', () => ({ p_admin_session_token: randomUUID() })],
  ['secondary session', () => ({ p_admin_session_token: branch })], ['emergency session', () => ({ p_admin_session_token: emergency })],
  ['NULL source', () => ({ p_source_site_id: null })],
]) test(`preflight ${label} preserves original validation and makes no writes`, async () => {
  const state = await preflightState();
  await assert.rejects(preflight(args()), /invalid or expired|Super administrator permission|source site id is required/);
  assert.deepEqual(await preflightState(), state);
});

test('shared wrapper preserves sealed-backup gate, creates no checkpoint on failure, then captures actual post-write target and unchanged return shape', async () => {
  ({ task: shared, plan: sharedPlan } = await prepare('shared'));
  await assert.rejects(apply('shared', shared, sharedPlan), /saved and sealed/); assert.equal(await checkpoint(shared), null);
  await sealBackup('shared', shared, sharedPlan);
  sharedReceipt = await apply('shared', shared, sharedPlan);
  assert.deepEqual(Object.keys(sharedReceipt).sort(), ['success','scope','full_site_complete','repeated','backup_id','admin_map','admin_group_map','created_admins','replaced_admins'].sort());
  assert.equal(sharedReceipt.repeated, false); assert.equal(sharedReceipt.success, true);
  sharedCheckpoint = await checkpoint(shared);
  assert.deepEqual(sharedCheckpoint, { protocol: 'site-prerequisites-v1', source_site_id: packages.shared.catalog.site_id, package_id: PACKAGE, type: 'shared-settings',
    hash: hash(await scalar(db, 'SELECT private.employee_transfer_shared_capture()::text')) });
  assert.notEqual(sharedCheckpoint.hash, sharedPlan.plan_hash);
  assert.equal(await scalar(db, 'SELECT is_active FROM public.admins WHERE id=$1', [NEW.branch]), false);
  assert.equal(await scalar(db, "SELECT value FROM public.system_configs WHERE key='login_title'"), 'Source title');
  assert.doesNotMatch(JSON.stringify(sharedCheckpoint), /Source title|password_hash|Source brand/);
});
test('shared repeat keeps original receipt/checkpoint and old checkpoint-less apply explicitly blocks without backfill', async () => {
  assert.deepEqual(await apply('shared', shared, sharedPlan), { ...sharedReceipt, repeated: true }); assert.deepEqual(await checkpoint(shared), sharedCheckpoint);
  await transaction(async () => {
    await db.query("UPDATE private.employee_transfer_jobs SET summary=summary-'site_prerequisite_checkpoint' WHERE id=$1", [shared.job_id]);
    await assert.rejects(apply('shared', shared, sharedPlan), /Historical shared apply.*not a backfill/); assert.equal(await checkpoint(shared), null);
  });
  await transaction(async () => {
    await db.exec(`UPDATE public.system_configs SET value='"Changed after shared"' WHERE key='login_title'`);
    await assert.rejects(apply('shared', shared, sharedPlan), /checkpoint drift/); assert.deepEqual(await checkpoint(shared), sharedCheckpoint);
  });
});
test('product real sealed backup/apply preserves target-only product; checkpoint uses only mapped exact six-column target rows and binds source mapping', async () => {
  await rpc('employee_transfer_cancel', auth(shared));
  ({ task: products, plan: productPlan } = await prepare('products'));
  await assert.rejects(apply('products', products, productPlan), /saved and sealed/); assert.equal(await checkpoint(products), null);
  await sealBackup('products', products, productPlan);
  const only = await scalar(db, 'SELECT to_jsonb(p) FROM public.product_types p WHERE id=$1', [ONLY_PRODUCT]);
  productReceipt = await apply('products', products, productPlan);
  assert.deepEqual(Object.keys(productReceipt).sort(), ['success','scope','full_site_complete','product_map','repeated'].sort());
  assert.equal(productReceipt.product_map[OLD.product], TARGET_PRODUCT); assert.equal(productReceipt.product_map[SOURCE_PRODUCT], SOURCE_PRODUCT);
  const actual = await scalar(db, `SELECT jsonb_object_agg(m.key,jsonb_build_object('id',p.id,'name',p.name,'is_active',p.is_active,
    'sort_order',p.sort_order,'created_at',p.created_at,'updated_at',p.updated_at) ORDER BY m.key COLLATE "C")::text
    FROM jsonb_each_text($1::jsonb) m JOIN public.product_types p ON p.id=m.value::uuid`, [JSON.stringify(productReceipt.product_map)]);
  productCheckpoint = await checkpoint(products);
  assert.deepEqual(productCheckpoint, { protocol: 'site-prerequisites-v1', source_site_id: packages.products.catalog.site_id, package_id: PACKAGE, type: 'product-catalog', hash: hash(actual) });
  assert.notEqual(productCheckpoint.hash, productPlan.plan_hash);
  assert.deepEqual(await scalar(db, 'SELECT to_jsonb(p) FROM public.product_types p WHERE id=$1', [ONLY_PRODUCT]), only);
  assert.equal(await scalar(db, 'SELECT sort_order FROM public.product_types WHERE id=$1', [TARGET_PRODUCT]), -7);
});
test('product repeat cannot refresh drift or backfill a legacy checkpoint', async () => {
  assert.deepEqual(await apply('products', products, productPlan), { ...productReceipt, repeated: true }); assert.deepEqual(await checkpoint(products), productCheckpoint);
  await transaction(async () => {
    await db.query("UPDATE public.product_types SET name='Changed mapped product' WHERE id=$1", [TARGET_PRODUCT]);
    await assert.rejects(apply('products', products, productPlan), /checkpoint drift/); assert.deepEqual(await checkpoint(products), productCheckpoint);
  });
  await transaction(async () => {
    await db.query("UPDATE private.employee_transfer_jobs SET summary=summary-'site_prerequisite_checkpoint' WHERE id=$1", [products.job_id]);
    await assert.rejects(apply('products', products, productPlan), /Historical product apply.*not a backfill/); assert.equal(await checkpoint(products), null);
  });
  await rpc('employee_products_close', auth(products));
});

// Mutations here are REAL pre-maintenance business writes. Prepare/seal/enter
// afterward, so admin activation/deletion also evades SQL11's target fingerprint
// and must be rejected by the immutable post-apply checkpoint, not a fake one.
const driftCases = [
  ['login copy', "UPDATE public.system_configs SET value='\"After apply drift\"' WHERE key='login_title'"],
  ['company copy', "UPDATE public.admin_configs SET config_value='After apply brand' WHERE config_type='company_name'"],
  ['admin activated', `UPDATE public.admins SET is_active=true WHERE id='${NEW.branch}'`],
  ['admin deleted', async () => {
    const args = { p_admin_session_token: session, p_action: 'admin_delete', p_target_ids: [NEW.branch], p_employee_id: null };
    const prepared = await rpc('prepare_content_audit_change', args, 'service_role');
    await rpc('commit_content_audit_change', { ...args, p_expected_hash: prepared.hash, p_payload: {}, p_operation_id: randomUUID(), p_media: {} }, 'service_role');
  }],
  ['admin password', `UPDATE public.admins SET password_hash='changed-local-hash' WHERE id='${NEW.branch}'`],
  ['financial credential changed', `UPDATE public.financial_admin_credentials SET password_hash='changed-local-credential' WHERE admin_id='${NEW.branch}'`],
  ['financial credential deleted', `DELETE FROM public.financial_admin_credentials WHERE admin_id='${NEW.branch}'`],
  ...['name', 'is_active', 'sort_order', 'created_at', 'updated_at'].map((key, i) => [`product ${key}`, `UPDATE public.product_types SET ${key}=${["'After apply product'", 'true', '44', "'2020-01-01T00:00:00Z'", "'2020-01-01T00:00:00Z'"][i]} WHERE id='${TARGET_PRODUCT}'`]),
  ['product id', `UPDATE public.product_types SET id='${randomUUID()}' WHERE id='${SOURCE_PRODUCT}'`],
  ['mapped product deleted', `DELETE FROM public.product_types WHERE id='${SOURCE_PRODUCT}'`],
];
for (const [label, mutation] of driftCases) test(`real ${label} drift between apply/end and maintenance is rejected with zero failure side effects`, async () => transaction(async () => {
  if (typeof mutation === 'function') await mutation(); else await db.exec(mutation);
  const prepared = await prepare('dispatch'); dispatch = prepared.task; dispatchPlan = prepared.plan;
  await sealBackup('dispatch', dispatch, dispatchPlan); await enter();
  await rejected({}, /checkpoint drift|mapped products are missing|credentials are missing/);
  assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), false);
  assert.deepEqual(await checkpoint(shared), sharedCheckpoint); assert.deepEqual(await checkpoint(products), productCheckpoint);
}));

test('unmapped different-name target product changes are outside the checkpoint and do not false-positive', async () => transaction(async () => {
  await db.query("UPDATE public.product_types SET name='Target-only changed',is_active=false WHERE id=$1", [ONLY_PRODUCT]);
  ({ task: dispatch, plan: dispatchPlan } = await prepare('dispatch')); await sealBackup('dispatch', dispatch, dispatchPlan); await enter();
  assert.deepEqual(await verify(), RECEIPT); assert.deepEqual(await checkpoint(products), productCheckpoint);
}));

test('real dispatch sealed backup requires maintenance; initial verification succeeds before config apply and writes only technical receipt/audit', async () => {
  ({ task: dispatch, plan: dispatchPlan } = await prepare('dispatch')); await sealBackup('dispatch', dispatch, dispatchPlan);
  await rejected({}, /matching dispatch maintenance/);
  await enter();
  const before = await dataState(); const events = await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_events');
  assert.deepEqual(await verify(), RECEIPT);
  const after = await dataState();
  assert.deepEqual(after.filter(r => !['private.employee_transfer_jobs','private.employee_transfer_events'].includes(r.relation)),
    before.filter(r => !['private.employee_transfer_jobs','private.employee_transfer_events'].includes(r.relation)));
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_events'), events + 1);
  assert.deepEqual(await scalar(db, "SELECT summary->'site_prerequisites_verified' FROM private.employee_transfer_jobs WHERE id=$1", [dispatch.job_id]), RECEIPT);
  assert.deepEqual(await scalar(db, "SELECT details FROM private.employee_transfer_events WHERE action='site_prerequisites_verified' ORDER BY id DESC LIMIT 1"), RECEIPT);
  assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), false);
});
test('after real config apply and identity begin creates disabled placeholder, dirty=true verification/repeat still succeeds without refreshing checkpoints', async () => {
  const plan = await rpc('get_employee_import_dispatch_configuration_plan', auth()); assert.equal(plan.can_apply_configuration, true);
  assert.equal((await rpc('employee_import_dispatch_apply_configuration', { ...auth(), p_plan_hash: plan.plan_hash })).configuration_applied, true);
  assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
  await rpc('employee_import_identity_bind', { ...auth(), p_catalog: packages.identity.catalog });
  for (const key of IDENTITY) await rpc('employee_import_identity_stage', { ...auth(), p_table_key: key, p_chunk_no: 0, p_ndjson: packages.identity.texts[key] });
  const identity = await rpc('get_employee_import_identity_plan', auth()); assert.equal(identity.can_restore, true, JSON.stringify(identity));
  await rpc('employee_import_identity_begin', { ...auth(), p_plan_hash: identity.plan_hash });
  assert.equal(await scalar(db, "SELECT is_active FROM public.product_types WHERE name='舊站匯入（精簡訂單）'"), false);
  for (const role of ['anon','authenticated']) assert.deepEqual(await verify({}, role), RECEIPT);
  assert.deepEqual(await checkpoint(shared), sharedCheckpoint); assert.deepEqual(await checkpoint(products), productCheckpoint);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits'), 0);
  await assert.rejects(rpc('employee_transfer_leave_maintenance', { p_admin_session_token: session, p_job_id: dispatch.job_id,
    p_confirmation: '確認取消尚未寫入的遷移', p_admin_password: PASSWORDS.root }), /Maintenance contains committed writes and cannot be cancelled/);
});
for (const [label, token] of [['NULL', () => null], ['random', randomUUID], ['secondary/revoked', () => branch], ['emergency/revoked', () => emergency], ['non-owner super', () => otherSession]]) {
  test(`${label} session/token is rejected and cannot release dirty maintenance, activate accounts, issue permits or send messages`, () => rejected({ p_admin_session_token: token() }));
}
for (const [label, mutate] of [
  ['expired session', () => db.query("UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=private.hash_financial_token($1)", [session])],
  ['stale job', () => db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", [dispatch.job_id])],
  ['12-hour job', () => db.query("UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", [dispatch.job_id])],
  ['cancelled job', () => db.query("UPDATE private.employee_transfer_jobs SET status='cancelled' WHERE id=$1", [dispatch.job_id])],
  ['non-dispatch protocol', () => db.query("UPDATE private.employee_transfer_jobs SET options=jsonb_set(options,'{import_protocol}','\"products-v1\"') WHERE id=$1", [dispatch.job_id])],
  ['missing maintenance', () => db.exec('DELETE FROM private.employee_transfer_maintenance')],
  ['maintenance admin mismatch', () => db.query('UPDATE private.employee_transfer_maintenance SET admin_id=$1', [OTHER])],
  ['maintenance job mismatch', () => db.query('UPDATE private.employee_transfer_maintenance SET job_id=$1', [shared.job_id])],
  ['maintenance plan mismatch', () => db.exec("UPDATE private.employee_transfer_maintenance SET plan_hash=repeat('a',64)")],
  ['maintenance target mismatch', () => db.exec("UPDATE private.employee_transfer_maintenance SET target_hash=repeat('b',64)")],
  ['missing sealed backup', () => db.query('UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1', [dispatch.job_id])],
]) test(`${label} explicitly rejects without modifying failure state`, async () => transaction(async () => { await mutate(); await rejected(); }));
for (const kind of ['shared', 'products']) {
  const task = () => kind === 'shared' ? shared : products;
  for (const [label, change] of [
    ['missing checkpoint', "summary=summary-'site_prerequisite_checkpoint'"],
    ['checkpoint protocol drift', "summary=jsonb_set(summary,'{site_prerequisite_checkpoint,protocol}','\"untrusted-v0\"')"],
    ['checkpoint package drift', `summary=jsonb_set(summary,'{site_prerequisite_checkpoint,package_id}',to_jsonb('${randomUUID()}'::text))`],
    ['checkpoint source drift', `summary=jsonb_set(summary,'{site_prerequisite_checkpoint,source_site_id}',to_jsonb('${randomUUID()}'::text))`],
    ['checkpoint type drift', "summary=jsonb_set(summary,'{site_prerequisite_checkpoint,type}','\"wrong-type\"')"],
    ['checkpoint hash drift', "summary=jsonb_set(summary,'{site_prerequisite_checkpoint,hash}',to_jsonb(repeat('0',64)))"],
    ['same package wrong owner', `admin_id='${OTHER}'`],
    ['different package', `options=jsonb_set(options,'{package_id}',to_jsonb('${randomUUID()}'::text))`],
    ['different source site', `options=jsonb_set(options,'{catalog,site_id}',to_jsonb('${randomUUID()}'::text))`],
    ['not applied', `summary=summary-'${kind === 'shared' ? 'shared_applied' : 'products_applied'}'`],
  ]) test(`${kind} ${label} is rejected, retaining dirty maintenance and existing checkpoints`, async () => transaction(async () => {
    await db.query(`UPDATE private.employee_transfer_jobs SET ${change} WHERE id=$1`, [task().job_id]); await rejected();
  }));
  test(`${kind} identical second applied server job is ambiguous, never DISTINCT-hash deduplicated (synthetic metadata-only negative)`, async () => transaction(async () => {
    await db.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options,summary,admin_map)
      SELECT $2,kind,admin_id,admin_username,private.hash_financial_token($3),'finished',options,summary,admin_map
      FROM private.employee_transfer_jobs WHERE id=$1`, [task().job_id, randomUUID(), randomUUID()]);
    await rejected({}, /unique applied same-package/);
  }));
}
test('changed shared administrator map rejects even when target rows are unchanged', async () => transaction(async () => {
  await db.query("UPDATE private.employee_transfer_jobs SET admin_map='{}' WHERE id=$1", [shared.job_id]); await rejected({}, /administrator mapping changed/);
}));
for (const [label, value] of [['missing', null], ['non-UUID', { [OLD.product]: 'invalid' }], ['duplicate targets', { [OLD.product]: TARGET_PRODUCT, [SOURCE_PRODUCT]: TARGET_PRODUCT }],
  ['source-target swap', { [OLD.product]: SOURCE_PRODUCT, [SOURCE_PRODUCT]: TARGET_PRODUCT }], ['too few', { [OLD.product]: TARGET_PRODUCT }]]) {
  test(`server product_map ${label} rejects without hashing unrelated products`, async () => transaction(async () => {
    await db.query("UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{products_receipt,product_map}',$2::jsonb) WHERE id=$1", [products.job_id, JSON.stringify(value)]);
    await rejected({}, /product mapping|checkpoint drift/);
  }));
}
test('unknown token and finished non-dispatch token cannot borrow the real dirty maintenance', async () => {
  await rejected({ p_job_token: randomUUID() }); await rejected({ p_job_token: null }); await rejected(auth(products));
});
test('maintenance still blocks unrelated writes, no account activation/messages/queue side effects; no SQL44 allowlist or retry changes', async () => {
  const before = await dataState();
  await transaction(async () => {
    await assert.rejects(db.exec("UPDATE public.product_types SET name=name"), /Business writes are paused/);
  });
  assert.deepEqual(await dataState(), before);
  assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.admins WHERE id IN ($1,$2) AND is_active', [NEW.branch, NEW.emergency]), 0);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.messages'), 0);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_queue'), 0);
  const preflight = await readFile(new URL(`../migrations/${PREVIOUS}`, import.meta.url), 'utf8'); assert.ok(!preflight.includes(VERIFY));
  const retry = await readFile(`${root}src/lib/supabase.ts`, 'utf8'); assert.ok(!retry.includes(VERIFY));
});
