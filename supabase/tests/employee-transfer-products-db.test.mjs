import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSites, adminLogin, rpc as baseRpc, scalar, rows } from './support/transfer-harness.mjs';
import { buildNewSite, OLD, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Local PGlite only. Every historical SQL is really replayed; do not patch the migration or guards here.
const migration = '20261102000008_transfer_product_catalog.sql';
const root = fileURLToPath(new URL('../../', import.meta.url));
const apiPath = `${root}src/lib/employeeTransfer/api.ts`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const PATH = 'data/products.ndjson';
const PASSPHRASE = 'local-only-product-db-backup-passphrase';
const ids = {
  zero: '10000000-0000-4000-8000-000000000001',
  negative: '20000000-0000-4000-8000-000000000001',
  active: '30000000-0000-4000-8000-000000000001',
  targetOnly: '90000000-0000-4000-8000-000000000001',
  caseOnly: '90000000-0000-4000-8000-000000000002',
  employee: '90000000-0000-4000-8000-000000000003',
  order: '90000000-0000-4000-8000-000000000004',
  otherRoot: '90000000-0000-4000-8000-000000000005',
};
const publicNames = [
  'employee_export_products_begin', 'get_employee_export_products_page', 'employee_export_products_verify',
  'employee_import_products_begin', 'employee_import_products_stage', 'get_employee_import_products_dry_run',
  'get_employee_import_products_backup', 'get_employee_import_products_backup_page',
  'employee_import_products_backup_append', 'employee_import_products_backup_seal',
  'get_employee_products_saved_backup_chunk', 'employee_import_products_apply', 'employee_products_close',
];
const unaffectedTables = ['users', 'admins', 'financial_admin_credentials', 'admin_financial_sessions',
  'financial_employee_credentials', 'orders', 'orders_history', 'wallets', 'wallet_transactions',
  'wallet_ledger_entries', 'wallet_balance_baselines', 'withdrawals', 'withdrawal_events', 'financial_operations',
  'wallet_reconciliation_audit', 'wallet_reconciliation_queue', 'commission_audit_log',
  'money_data_protection_audit', 'dispatch_groups', 'dispatch_group_members', 'dispatch_order_pools',
  'dispatch_orders', 'valid_order_data', 'used_order_data', 'announcements', 'announcement_categories',
  'system_configs', 'admin_configs', 'notification_automation_plans'];
let oldSite, db, session, branchSession, emergencySession, otherSession, sourceSession, sourceBranchSession;
let pkg, replay, modules;
let savepoint = 0;

async function transaction(fn, site = db) {
  await site.exec('BEGIN');
  try { return await fn(); } finally { await site.exec('ROLLBACK'); }
}
async function isolated(site, fn, role = null) {
  const name = `product_rpc_${++savepoint}`;
  await site.exec(`SAVEPOINT ${name}`);
  try {
    if (role) await site.exec(`SET LOCAL ROLE ${role}`);
    const result = await fn();
    if (role) await site.exec('RESET ROLE');
    await site.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await site.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
const callOn = (site, name, args) => isolated(site, () => baseRpc(site, name, args, { role: null }), 'anon');
const rpc = (name, args) => callOn(db, name, args);
const auth = (job, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
const begin = (input = pkg, token = session, password = PASSWORDS.root) => rpc('employee_import_products_begin', {
  p_admin_session_token: token, p_admin_password: password, p_package_id: input.packageId, p_catalog: input.catalog,
});
const stage = (job, text = pkg.text, chunk = 0) => rpc('employee_import_products_stage', {
  ...auth(job), p_chunk_no: chunk, p_ndjson: text,
});
const dryRun = job => rpc('get_employee_import_products_dry_run', auth(job));
const descriptor = job => rpc('get_employee_import_products_backup', auth(job));
const page = (job, after = null, limit = 2) => rpc('get_employee_import_products_backup_page', {
  ...auth(job), p_after: after, p_limit: limit,
});
const append = (job, plan, no, bytes) => rpc('employee_import_products_backup_append', {
  ...auth(job), p_plan_hash: plan.plan_hash, p_chunk_no: no, p_hex: bytes.toString('hex'),
});
const seal = (job, plan, bytes, sha256 = hash(bytes), length = bytes.length) => rpc('employee_import_products_backup_seal', {
  ...auth(job), p_plan_hash: plan.plan_hash, p_sha256: sha256, p_bytes: length,
});
const apply = (job, plan) => rpc('employee_import_products_apply', { ...auth(job), p_plan_hash: plan.plan_hash });
const close = job => rpc('employee_products_close', auth(job));
const cancel = (job, token = session) => rpc('employee_transfer_cancel', auth(job, token));
const saved = (id, no = 0, token = session) => rpc('get_employee_products_saved_backup_chunk', {
  p_admin_session_token: token, p_backup_id: id, p_chunk_no: no,
});
const productState = (site = db) => scalar(site, `SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY id),'[]') FROM public.product_types AS item`);
const jobState = job => scalar(db, 'SELECT to_jsonb(item) FROM private.employee_transfer_jobs AS item WHERE id=$1', [job.job_id]);
const backupState = job => scalar(db, 'SELECT to_jsonb(item) FROM private.employee_transfer_shared_backups AS item WHERE id=$1', [job.job_id]);
const staged = job => rows(db, 'SELECT to_jsonb(item) AS value FROM private.employee_transfer_staging AS item WHERE job_id=$1 ORDER BY table_key,chunk_no', [job.job_id]);
const events = job => rows(db, 'SELECT action,details FROM private.employee_transfer_events WHERE job_id=$1 ORDER BY id', [job.job_id]);
const triggerState = () => rows(db, `SELECT tgname,tgenabled,pg_get_triggerdef(oid) AS definition FROM pg_trigger
  WHERE tgrelid='public.product_types'::regclass AND NOT tgisinternal ORDER BY tgname`);
const values = input => input.text.trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line));
function fromText(text, base = pkg, count = text.split('\n').length - 1) {
  const input = structuredClone(base);
  input.text = text;
  Object.assign(input.catalog.tables[0], { rows: count, bytes: Buffer.byteLength(text), sha256: hash(text) });
  return input;
}
function changed(mutate, base = pkg, sort = true) {
  let items = values(base);
  items = mutate(items) ?? items;
  if (sort) items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return fromText(items.map(item => JSON.stringify(item) + '\n').join(''), base, items.length);
}
async function prepared(input = pkg) {
  const job = await begin(input);
  assert.equal(job.success, true);
  await stage(job, input.text);
  return { job, plan: await dryRun(job) };
}
function applicable(plan) { assert.equal(plan.can_apply, true, JSON.stringify(plan.conflicts)); }
// Fake bytes are ONLY for server length/hash gates; the independent-file test uses real AES-GCM/ZIP.
const gateCipher = () => Buffer.concat([Buffer.from('EDXSTRM1'), Buffer.alloc(88, 0xa5)]);
async function gateBackup(job, plan) {
  applicable(plan);
  const bytes = gateCipher();
  await append(job, plan, 0, bytes);
  assert.equal((await seal(job, plan, bytes)).success, true);
  return bytes;
}
async function unaffected() {
  const state = {};
  for (const table of unaffectedTables) state[table] = await scalar(db,
    `SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY to_jsonb(item)::text),'[]') FROM public.${table} AS item`);
  return state;
}
async function* diskSource(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(65521);
    for (;;) {
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally { await handle.close(); }
}
async function exportOn(site, token, limit = 2) {
  const job = await baseRpc(site, 'employee_export_products_begin', {
    p_admin_session_token: token, p_admin_password: PASSWORDS.root,
  });
  assert.equal(job.success, true);
  let text = '', count = 0, after = null;
  do {
    const value = await baseRpc(site, 'get_employee_export_products_page', {
      ...auth(job, token), p_after: after, p_limit: limit,
    });
    assert.equal(value.table_key, 'product_types');
    assert.equal(value.sha256, hash(value.ndjson));
    assert.ok(value.count <= limit);
    text += value.ndjson; count += value.count; after = value.next_after;
  } while (after !== null);
  assert.equal(count, job.catalog.tables[0].rows);
  assert.equal(hash(text), job.catalog.tables[0].sha256);
  assert.equal(Buffer.byteLength(text), job.catalog.tables[0].bytes);
  assert.deepEqual(await baseRpc(site, 'employee_export_products_verify', auth(job, token)),
    { verified: true, scope: 'product-catalog', full_site_complete: false });
  return { job, catalog: job.catalog, text, packageId: randomUUID() };
}

function productSqlBridge(site, token, siteKey, trace) {
  return {
    token,
    rpc(name, args) {
      assert.ok(publicNames.includes(name), `the API must use a dedicated product endpoint: ${name}`);
      assert.equal(args.p_admin_session_token, token, 'the real API must pass the captured fixture session token');
      const entry = { site: siteKey, name, argumentNames: Object.keys(args).sort(), response: null, role: null, signal: false };
      trace.push(entry);
      let pending, signal;
      const execute = async () => {
        try {
          if (signal?.aborted) throw new DOMException('Local product request cancelled.', 'AbortError');
          const data = await isolated(site, async () => {
            entry.role = await scalar(site, 'SELECT current_user');
            assert.equal(entry.role, 'anon', 'SQL must execute as anon, not the fixture owner');
            return baseRpc(site, name, args, { role: null });
          }, 'anon');
          // Only the normal Supabase envelope is added. Never remove/add/normalize SQL JSON fields.
          entry.response = structuredClone(data);
          return { data, error: null };
        } catch (error) {
          entry.error = { message: error.message, code: error.code };
          return { data: null, error: entry.error };
        }
      };
      const query = {
        abortSignal(value) {
          assert.ok(value instanceof AbortSignal); signal = value; entry.signal = true; return query;
        },
        then(resolve, reject) { pending ??= execute(); return pending.then(resolve, reject); },
      };
      return query;
    },
  };
}

before(async () => {
  replay = await createSites({ upTo: migration });
  oldSite = replay.oldSite; db = replay.newSite;
  // Dump clones have the same identity. Explicitly model a second site, never weaken the guard.
  await db.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  // Use the existing real target fixture and product-focused source rows. buildOldSite's unrelated
  // success-order UPDATE hits the historical audit_order_status_change/old_order_status mismatch;
  // do not alter that trigger, fabricate missing columns or expand the 12-item replay baseline.
  for (const [id, name, role, password] of [[OLD.root, 'root', 'super_admin', PASSWORDS.root],
    [OLD.branch, 'branch', 'secondary_admin', PASSWORDS.branch], [OLD.emergency, 'emergency', 'emergency_admin', PASSWORDS.emergency]]) {
    await oldSite.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      VALUES($1,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$4,true)`, [id, name, password, role]);
    await oldSite.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash)
      VALUES($1,extensions.crypt($2,extensions.gen_salt('bf',4)))`, [id, password]);
  }
  await buildNewSite(db);
  await oldSite.query(`INSERT INTO public.product_types(id,name,is_active,sort_order,created_at,updated_at)
    VALUES($1,'Product A',NULL,1,NULL,NULL)`, [OLD.product]);
  await oldSite.query('UPDATE public.product_types SET sort_order=-2147483648 WHERE id=$1', [OLD.product]);
  for (const [id, name, active, sort] of [[ids.zero, '来源零排序产品 é 𠮷', null, 0],
    [ids.negative, '来源负排序产品', false, -17], [ids.active, '来源启用产品', true, 2147483647]]) {
    await oldSite.query(`INSERT INTO public.product_types(id,name,is_active,sort_order,created_at,updated_at)
      VALUES($1,$2,$3,1,'2024-02-29T23:59:59.123456+08:00','2025-01-02T03:04:05.000006Z')`, [id, name, active]);
    await oldSite.query('UPDATE public.product_types SET sort_order=$2 WHERE id=$1', [id, sort]);
    if (id === ids.zero) await oldSite.query('UPDATE public.product_types SET created_at=NULL,updated_at=NULL WHERE id=$1', [id]);
  }
  for (const [id, name] of [[NEW.product, 'Product A'], [ids.targetOnly, 'target-only product'], [ids.caseOnly, 'product a']]) {
    await db.query(`INSERT INTO public.product_types(id,name,is_active,sort_order,created_at,updated_at)
      VALUES($1,$2,false,33,'2026-01-02T03:04:05Z','2026-02-03T04:05:06Z')`, [id, name]);
  }
  // Real business fixtures: no trigger disabling or handcrafted ledger substitutes.
  await db.query(`INSERT INTO public.users(id,username,password_hash,employee_id,created_by)
    VALUES($1,'target-product-employee','local-fixture-hash','PRODUCT-KEEP',$2)`, [ids.employee, NEW.root]);
  await db.query(`INSERT INTO public.dispatch_group_members(group_id,user_id,assigned_by) VALUES($1,$2,$3)`,
    [NEW.groupA, ids.employee, NEW.root]);
  await db.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status,created_at)
    VALUES($1,$2,'target-product-employee',$3,100,'PRODUCT-OLD-ORDER','PRODUCT-OLD-TX','processing','2026-09-01T10:00:00Z')`,
    [ids.order, ids.employee, NEW.product]);
  await db.query(`INSERT INTO public.orders_history(id,user_id,product_type_id,product_value,transaction_id,status,
    commission_amount,created_at,updated_at) VALUES($1,$2,$3,100,'PRODUCT-ARCHIVED-TX','success',2.5,
    '2026-08-01T10:00:00Z','2026-08-01T10:00:00Z')`, [randomUUID(), ids.employee, NEW.product]);
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    VALUES($1,'other-product-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [ids.otherRoot, PASSWORDS.root]);
  await db.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash)
    VALUES($1,extensions.crypt($2,extensions.gen_salt('bf',4)))`, [ids.otherRoot, PASSWORDS.root]);
  session = await adminLogin(db, 'root', PASSWORDS.root);
  branchSession = await adminLogin(db, 'branch', PASSWORDS.branch);
  emergencySession = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  otherSession = await adminLogin(db, 'other-product-root', PASSWORDS.root);
  const adjustment = await baseRpc(db, 'admin_adjust_wallet_balance_atomic', {
    p_admin_session_token: session, p_user_id: ids.employee, p_amount: 10,
    p_remarks: 'local product transfer unchanged-finance fixture', p_operation_id: randomUUID(),
  });
  assert.equal(adjustment.success, true);
  await db.query(`INSERT INTO public.withdrawals(user_id,amount,status) VALUES($1,0.5,'pending')`, [ids.employee]);
  sourceSession = await adminLogin(oldSite, 'root', PASSWORDS.root);
  sourceBranchSession = await adminLogin(oldSite, 'branch', PASSWORDS.branch);
  pkg = await exportOn(oldSite, sourceSession);
  await baseRpc(oldSite, 'employee_products_close', auth(pkg.job, sourceSession));
  const compiled = await build({
    stdin: { contents: `export * from './src/lib/employeeTransfer/productTransfer.ts';
      export * from './src/lib/employeeTransfer/productBackup.ts';
      export * from './src/lib/employeeTransfer/api.ts';
      export { verifyEncryptedVolume } from './src/lib/employeeTransfer/container.ts';
      export { setProductDbBridge } from 'product-db:bridge';`,
    resolveDir: root, sourcefile: 'product-db-local-entry.mjs', loader: 'js' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', metafile: true,
    plugins: [{ name: 'product-db-local-auth-and-transport', setup(builder) {
      builder.onResolve({ filter: /^product-db:bridge$/ }, () => ({ path: 'bridge', namespace: 'product-db' }));
      builder.onResolve({ filter: /^\.\.\/(auth|supabase)$/ }, args => {
        assert.equal(args.importer, apiPath, 'only API auth/transport dependencies may be substituted');
        return { path: args.path.slice(3), namespace: 'product-db' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'product-db' }, ({ path }) => {
        if (path === 'bridge') return { contents: `let bridge;
          export const setProductDbBridge = value => { bridge = value; };
          export const current = () => { if (!bridge) throw new Error('Local product SQL bridge is not configured.'); return bridge; };` };
        if (path === 'auth') return { contents: `import { current } from 'product-db:bridge';
          export const getAdminFinancialSessionToken = () => current().token;` };
        assert.equal(path, 'supabase');
        return { contents: `import { current } from 'product-db:bridge';
          export const supabase = { rpc: (...args) => current().rpc(...args) };
          export const formatSupabaseError = error => error.message;` };
      });
    } }],
  });
  const bundledInputs = Object.keys(compiled.metafile.inputs);
  assert.equal(bundledInputs.some(path => /src\/lib\/(supabase|auth)\.ts$/.test(path)), false);
  for (const name of ['api', 'productTransfer', 'productBackup', 'container', 'crypto', 'sha256']) {
    assert.ok(bundledInputs.some(path => path.endsWith(`/employeeTransfer/${name}.ts`)), `real ${name}.ts must be bundled`);
  }
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  mock.method(globalThis, 'fetch', () => assert.fail('product DB tests forbid all network access'));
}, { timeout: 180000 });
after(async () => { mock.restoreAll(); await Promise.all([oldSite?.close(), db?.close()]); });

test('535 real SQL replays retain exactly 12 known historical failures, not a fresh-build success; products add no table or column', async t => {
  assert.equal(replay.files.length, 535);
  assert.equal(replay.files.at(-1), migration);
  assert.equal(replay.failures.length, 12);
  assert.equal(replay.validation.matched.length, 12);
  assert.equal(replay.validation.freshDatabaseVerified, false);
  t.diagnostic(`Actual replay: ${replay.files.length} SQL attempted, ${replay.failures.length} known historical failures; freshDatabaseVerified=false.`);
  assert.deepEqual((await rows(db, `SELECT count(*)::int AS tables,sum((SELECT count(*) FROM pg_attribute
    WHERE attrelid=relation.oid AND attnum>0 AND NOT attisdropped))::int AS columns
    FROM pg_class AS relation WHERE relnamespace IN ('public'::regnamespace,'private'::regnamespace)
    AND relkind IN ('r','p') AND NOT relispartition`))[0], { tables: 104, columns: 927 });
  assert.notEqual(await scalar(oldSite, 'SELECT site_id FROM private.employee_transfer_site'),
    await scalar(db, 'SELECT site_id FROM private.employee_transfer_site'));
});

test('all 13 product RPCs use SECURITY DEFINER, fixed search_path, browser grants and no PUBLIC execute', async () => {
  const functions = await rows(db, `SELECT proname,prosecdef,proconfig,
    has_function_privilege('anon',oid,'EXECUTE') AS anon,
    has_function_privilege('authenticated',oid,'EXECUTE') AS authenticated,
    EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`, [publicNames]);
  assert.equal(functions.length, 13);
  for (const fn of functions) {
    assert.equal(fn.prosecdef, true, fn.proname);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'), fn.proname);
    assert.equal(fn.anon, true); assert.equal(fn.authenticated, true); assert.equal(fn.public_execute, false);
  }
});

test('real replayed approved product trigger passes the unmodified migration guard (diagnoses definition/proconfig mismatch)', async t => transaction(async () => {
  // Inspect under the guard's own search_path, not the caller's deparser visibility.
  await db.exec('SET LOCAL search_path=pg_catalog,public,private,pg_temp');
  const actual = await rows(db, `SELECT tgname,tgenabled,pg_get_triggerdef(trigger.oid) AS definition,
    procedure.proconfig,pg_get_userbyid(procedure.proowner) AS owner,procedure.prosecdef,
    procedure.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AS plpgsql
    FROM pg_trigger AS trigger JOIN pg_proc AS procedure ON procedure.oid=trigger.tgfoid
    WHERE trigger.tgrelid='public.product_types'::regclass AND NOT trigger.tgisinternal`);
  for (const trigger of actual) {
    t.diagnostic(`guard-path trigger definition = ${trigger.definition}`);
    t.diagnostic(`guard-path trigger properties = ${JSON.stringify({ ...trigger, definition: undefined })}`);
  }
  await db.exec('SELECT private.employee_transfer_assert_product_triggers()');
}));

test('real dual-site export/page/verify -> client stage/dry-run -> independent encrypted disk reread/upload/seal -> apply/repeat -> product close',
  { timeout: 60000 }, async t => transaction(async () => {
    const before = await productState();
    const keep = await unaffected();
    assert.ok(keep.orders.some(item => item.id === ids.order && item.product_type_id === NEW.product));
    assert.ok(keep.wallets.length && keep.wallet_transactions.length && keep.wallet_ledger_entries.length && keep.withdrawals.length,
      'unchanged finance must be nonempty, produced by real business triggers');
    let job;
    const stagedResult = await modules.stageProductsImport(pkg.catalog, {
      open(path) { assert.equal(path, PATH); return (async function* () { yield Buffer.from(pkg.text); })(); },
    }, {
      async begin(catalog) {
        job = await begin({ ...pkg, catalog });
        return { success: job.success, scope: job.scope, full_site_complete: job.full_site_complete };
      },
      stage: (no, text) => stage(job, text, no), dryRun: () => dryRun(job),
    });
    const plan = stagedResult.dryRun;
    applicable(plan);
    assert.equal(stagedResult.rows, pkg.catalog.tables[0].rows);
    assert.equal(stagedResult.fullSiteComplete, false);
    const frozen = await descriptor(job);
    assert.equal(frozen.backup_id, job.job_id);
    assert.equal(frozen.plan_hash, plan.plan_hash);
    assert.equal(frozen.catalog.scope, 'product-catalog');
    const directory = await mkdtemp(join(tmpdir(), 'products-db-'));
    const plainPath = join(directory, 'products.ndjson'), cipherPath = join(directory, 'independent.edx');
    try {
      let expected = '', opens = 0, cleanups = 0, verified = false;
      const uploaded = [], phases = [];
      const result = await modules.createProductBackup(frozen, {
        async catalog() { return (await descriptor(job)).catalog; },
        async page(after) { const value = await page(job, after); expected += value.ndjson; return value; },
        async verify() {
          assert.deepEqual(await descriptor(job), frozen); assert.deepEqual(await dryRun(job), plan);
          verified = true;
          return { verified: true, scope: 'product-catalog', full_site_complete: false };
        },
      }, {
        async append(path, bytes) {
          assert.equal(path, PATH);
          const handle = await open(plainPath, 'a');
          try { await handle.writeFile(bytes); } finally { await handle.close(); }
        },
        open(path) { assert.equal(path, PATH); return diskSource(plainPath); },
        async abort() { cleanups++; await rm(plainPath, { force: true }); },
      }, {
        async write(source) {
          const handle = await open(cipherPath, 'wx');
          try { for await (const bytes of source) await handle.writeFile(bytes); await handle.sync(); }
          finally { await handle.close(); }
        },
        open() { opens++; return diskSource(cipherPath); },
      }, {
        async append(no, hex) {
          assert.equal(verified, true); assert.equal(opens, 2, 'authenticate saved file before upload reread');
          const bytes = Buffer.from(hex, 'hex'); uploaded.push(bytes); return append(job, plan, no, bytes);
        },
        seal: (sha256, bytes) => rpc('employee_import_products_backup_seal', { ...auth(job), p_plan_hash: plan.plan_hash,
          p_sha256: sha256, p_bytes: bytes }),
      }, PASSPHRASE, { onProgress: progress => phases.push(progress.phase) });
      const disk = await readFile(cipherPath);
      assert.equal(opens, 2); assert.equal(cleanups, 1);
      assert.deepEqual([...new Set(phases)], ['snapshot', 'save', 'verify', 'upload', 'seal']);
      assert.equal(result.cipherSha256, hash(disk)); assert.equal(result.bytes, disk.length);
      assert.deepEqual(Buffer.concat(uploaded), disk);
      await assert.rejects(stat(plainPath), { code: 'ENOENT' });
      const recovered = [];
      for (let no = 0; no < result.chunks; no++) {
        const chunk = await saved(job.job_id, no);
        assert.equal(chunk.sha256, hash(disk)); assert.equal(chunk.bytes, disk.length);
        assert.equal(chunk.chunks, result.chunks); recovered.push(Buffer.from(chunk.hex, 'hex'));
      }
      const cipher = Buffer.concat(recovered);
      assert.deepEqual(cipher, disk);
      const plain = [];
      const manifest = await modules.verifyEncryptedVolume((async function* () { yield cipher; })(), PASSPHRASE, {
        async append(path, bytes) { assert.equal(path, PATH); plain.push(Buffer.from(bytes)); },
        async abort() { assert.fail('saved real product backup must authenticate'); },
      }, { expectedMetadata: { exportId: job.job_id, volumeId: job.job_id } });
      assert.equal(manifest.scope, 'replacement-backup'); assert.equal(manifest.sourceSiteId, frozen.catalog.site_id);
      assert.equal(manifest.entries.length, 1); assert.equal(Buffer.concat(plain).toString(), expected);
      assert.equal(hash(expected), frozen.catalog.tables[0].sha256);
      assert.deepEqual(JSON.parse(expected.split('\n').find(line => line && JSON.parse(line).id === NEW.product)),
        before.find(item => item.id === NEW.product), 'backup contains pre-overwrite target six columns');
      assert.deepEqual(await productState(), before, 'backup does not itself apply');
      t.diagnostic(`Real independent backup completed before apply: ${disk.length} ciphertext bytes, ${result.chunks} persisted chunks; disk authenticated, upload reread matched, sealed server bytes decrypted to the frozen target catalog.`);
      const receipt = await apply(job, plan);
      assert.equal(receipt.success, true); assert.equal(receipt.scope, 'product-catalog');
      assert.equal(receipt.full_site_complete, false); assert.equal(receipt.repeated, false);
      assert.equal(receipt.product_map[OLD.product], NEW.product);
      const applied = await productState(), audit = await events(job);
      assert.deepEqual(await apply(job, plan), { ...receipt, repeated: true });
      assert.deepEqual(await productState(), applied); assert.deepEqual(await events(job), audit);
      assert.equal(audit.filter(item => item.action === 'products_applied').length, 1);
      assert.equal((await jobState(job)).status, 'running');
      assert.deepEqual(await close(job), { success: true, scope: 'product-catalog', full_site_complete: false });
      assert.equal((await jobState(job)).summary.full_site_complete, false);
      assert.deepEqual(await staged(job), []); assert.equal((await saved(job.job_id)).hex, recovered[0].toString('hex'));
      assert.deepEqual(await unaffected(), keep, 'existing orders/references, finance, admins and other business remain exact');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }));

test('bundled real api.ts -> anon PGlite SQL golden path: export/verify/close -> stage/dry-run -> independent disk backup -> session apply/repeat/close',
  { timeout: 60000 }, async t => transaction(async () => transaction(async () => {
    // More than one real page on BOTH sites, without changing schemas, functions or triggers.
    for (const [site, prefix, date] of [[oldSite, '40000000', '2024-03-04T05:06:07Z'], [db, '50000000', '2026-03-04T05:06:07Z']]) {
      await site.query(`INSERT INTO public.product_types(id,name,is_active,sort_order,created_at,updated_at)
        SELECT ($1||'-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'API golden product '||n,
          n%2=0,1000+n,$2::timestamptz,$2::timestamptz FROM generate_series(1,201) AS fixture(n)`, [prefix, date]);
    }
    const sourceRows = await productState(oldSite), before = await productState(), keep = await unaffected();
    const triggers = await triggerState();
    const sourceLastExport = (await callOn(oldSite, 'get_employee_transfer_log', { p_admin_session_token: sourceSession })).last_export_at;
    const targetLastExport = (await rpc('get_employee_transfer_log', { p_admin_session_token: session })).last_export_at;
    const trace = [], signal = new AbortController().signal;
    const sourceBridge = productSqlBridge(oldSite, sourceSession, 'source', trace);
    const targetBridge = productSqlBridge(db, session, 'target', trace);
    const directory = await mkdtemp(join(tmpdir(), 'products-api-sql-'));
    const exportPath = join(directory, 'source-products.ndjson');
    const backupPath = join(directory, 'target-before-import.ndjson');
    const cipherPath = join(directory, 'independent-target-before-import.edx');
    const temporary = file => {
      const stats = { opens: 0, appends: 0, aborts: 0 };
      return {
        stats,
        async append(path, bytes) {
          assert.equal(path, PATH);
          const handle = await open(file, 'a');
          try { await handle.writeFile(bytes); stats.appends++; } finally { await handle.close(); }
        },
        open(path) { assert.equal(path, PATH); stats.opens++; return diskSource(file); },
        async abort() { stats.aborts++; await rm(file, { force: true }); },
      };
    };
    const exportedFiles = temporary(exportPath), backupFiles = temporary(backupPath);
    try {
      modules.setProductDbBridge(sourceBridge);
      const exported = await modules.beginProductsExport(PASSWORDS.root, signal);
      const rawExport = trace.find(item => item.name === 'employee_export_products_begin').response;
      assert.deepEqual(Object.keys(rawExport).sort(), ['success', 'job_id', 'job_token', 'site_id', 'catalog', 'scope', 'full_site_complete'].sort(),
        'the actual SQL response, not a stub-shaped replacement, must match the real strict API decoder');
      assert.equal(exported.jobId, rawExport.job_id); assert.equal(exported.jobToken, rawExport.job_token);
      assert.equal(exported.catalog.site_id, await scalar(oldSite, 'SELECT site_id FROM private.employee_transfer_site'));
      const exportProgress = [];
      const productExport = await modules.exportProducts(exported.source, exportedFiles, {
        signal, onProgress: progress => exportProgress.push(progress),
      });
      assert.equal(productExport.rows, sourceRows.length); assert.equal(productExport.fullSiteComplete, false);
      const sourceFile = await readFile(exportPath);
      assert.equal(hash(sourceFile), exported.catalog.tables[0].sha256);
      assert.deepEqual(values({ text: sourceFile.toString() }), sourceRows);
      assert.ok(exportProgress.length >= 2); assert.equal(exportedFiles.stats.aborts, 0);
      const sourceJob = await scalar(oldSite, 'SELECT to_jsonb(item) FROM private.employee_transfer_jobs AS item WHERE id=$1', [exported.jobId]);
      assert.equal(sourceJob.status, 'running'); assert.equal(sourceJob.summary.products_verified, true);
      assert.equal(trace.filter(item => item.name === 'get_employee_export_products_page').length, 2);
      assert.equal(trace.filter(item => item.name === 'employee_export_products_verify').length, 1);
      assert.deepEqual(await exported.close(signal), { success: true, scope: 'product-catalog', full_site_complete: false });
      assert.equal((await callOn(oldSite, 'get_employee_transfer_log', { p_admin_session_token: sourceSession })).last_export_at, sourceLastExport);
      assert.equal(await scalar(oldSite, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [exported.jobId]), 0);

      modules.setProductDbBridge(targetBridge);
      const packageId = randomUUID();
      const imported = modules.createProductsImportSession(packageId, PASSWORDS.root);
      assert.equal(imported.identity(), null);
      const importProgress = [];
      const stagedResult = await modules.stageProductsImport(productExport.catalog, exportedFiles, imported.target, {
        signal, onProgress: progress => importProgress.push(progress),
      });
      const plan = stagedResult.dryRun;
      applicable(plan); assert.equal(stagedResult.rows, sourceRows.length); assert.equal(stagedResult.fullSiteComplete, false);
      const identity = imported.identity(), job = { job_id: identity.jobId, job_token: identity.jobToken };
      const rawImport = trace.find(item => item.name === 'employee_import_products_begin').response;
      assert.deepEqual(Object.keys(rawImport).sort(), ['success', 'job_id', 'job_token', 'scope', 'full_site_complete'].sort());
      assert.deepEqual(identity, { jobId: rawImport.job_id, jobToken: rawImport.job_token });
      assert.equal((await jobState(job)).options.package_id, packageId);
      assert.equal(exportedFiles.stats.opens, 2, 'stageProductsImport validates and rereads the actual exported file');
      assert.equal(trace.filter(item => item.name === 'employee_import_products_stage').length, 2);
      assert.deepEqual([...new Set(importProgress.map(item => item.phase))], ['validate', 'stage', 'dry-run']);
      assert.equal(trace.some(item => item.site === 'target' && ['employee_import_products_apply', 'employee_products_close'].includes(item.name)), false,
        'staging and dry-run do not automatically apply or close');
      assert.deepEqual(await productState(), before);

      const backup = await imported.backup(signal);
      assert.equal(backup.descriptor.backup_id, job.job_id); assert.equal(backup.descriptor.plan_hash, plan.plan_hash);
      assert.equal(backup.descriptor.catalog.site_id, await scalar(db, 'SELECT site_id FROM private.employee_transfer_site'));
      assert.notEqual(backup.descriptor.catalog.site_id, exported.catalog.site_id);
      const fileStats = { writes: 0, opens: 0, eof: [] }, backupProgress = [];
      const backupResult = await modules.createProductBackup(backup.descriptor, backup.source, backupFiles, {
        async write(source) {
          const handle = await open(cipherPath, 'wx');
          try { for await (const chunk of source) await handle.writeFile(chunk); await handle.sync(); fileStats.writes++; }
          finally { await handle.close(); }
        },
        open() {
          const read = ++fileStats.opens;
          return (async function* () { yield* diskSource(cipherPath); fileStats.eof.push(read); })();
        },
      }, backup.receiver, PASSPHRASE, { signal, onProgress: progress => backupProgress.push(progress.phase) });
      assert.equal(fileStats.writes, 1); assert.equal(fileStats.opens, 2); assert.deepEqual(fileStats.eof, [1, 2]);
      assert.equal(backupFiles.stats.aborts, 1);
      assert.deepEqual([...new Set(backupProgress)], ['snapshot', 'save', 'verify', 'upload', 'seal']);
      assert.equal(trace.filter(item => item.name === 'get_employee_import_products_backup_page').length, 2);
      await assert.rejects(stat(backupPath), { code: 'ENOENT' });
      const cipher = await readFile(cipherPath);
      assert.equal(hash(cipher), backupResult.cipherSha256); assert.equal(cipher.length, backupResult.bytes);
      const sealed = await backupState(job);
      assert.equal(sealed.sealed_sha256, hash(cipher)); assert.ok(sealed.sealed_at);
      const recovered = [];
      for (let no = 0; no < backupResult.chunks; no++) {
        const { data, error } = await targetBridge.rpc('get_employee_products_saved_backup_chunk', {
          p_admin_session_token: session, p_backup_id: job.job_id, p_chunk_no: no,
        }).abortSignal(signal);
        assert.equal(error, null); assert.equal(data.sha256, hash(cipher)); assert.equal(data.bytes, cipher.length);
        recovered.push(Buffer.from(data.hex, 'hex'));
      }
      assert.deepEqual(Buffer.concat(recovered), cipher);
      const plaintext = [];
      const manifest = await modules.verifyEncryptedVolume((async function* () { yield Buffer.concat(recovered); })(), PASSPHRASE, {
        async append(path, bytes) { assert.equal(path, PATH); plaintext.push(Buffer.from(bytes)); },
        async abort() { assert.fail('API-persisted backup must authenticate and match the actual pre-import target'); },
      }, { expectedMetadata: { exportId: job.job_id, volumeId: job.job_id }, signal });
      assert.equal(manifest.sourceSiteId, backup.descriptor.catalog.site_id);
      assert.equal(manifest.scope, 'replacement-backup');
      assert.deepEqual(values({ text: Buffer.concat(plaintext).toString() }), before);
      assert.deepEqual(await productState(), before, 'real API backup does not silently apply');
      assert.deepEqual(await unaffected(), keep);

      const applied = await imported.apply(plan.plan_hash, signal);
      assert.equal(applied.success, true); assert.equal(applied.full_site_complete, false); assert.equal(applied.repeated, false);
      assert.equal(applied.product_map[OLD.product], NEW.product);
      const after = await productState();
      const expected = [...sourceRows.map(item => ({ ...item, id: applied.product_map[item.id] })),
        ...before.filter(item => !sourceRows.some(source => source.name === item.name))].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      assert.deepEqual(after, expected, 'SQL applies all source columns, preserves matched target IDs and retains target-only products');
      const audit = await events(job);
      assert.equal(audit.filter(item => item.action === 'products_applied').length, 1);
      assert.deepEqual(await imported.apply(plan.plan_hash, signal), { ...applied, repeated: true });
      assert.deepEqual(await productState(), after); assert.deepEqual(await events(job), audit);
      assert.deepEqual(await imported.close(signal), { success: true, scope: 'product-catalog', full_site_complete: false });
      assert.equal((await jobState(job)).summary.full_site_complete, false); assert.deepEqual(await staged(job), []);
      assert.deepEqual(await backupState(job), sealed, 'sealed ciphertext survives API close independently of staging');
      assert.deepEqual(await readFile(cipherPath), cipher);
      assert.equal((await saved(job.job_id)).sha256, hash(cipher));
      assert.deepEqual(await unaffected(), keep); assert.deepEqual(await triggerState(), triggers);
      assert.deepEqual(await productState(oldSite), sourceRows);
      assert.equal((await rpc('get_employee_transfer_log', { p_admin_session_token: session })).last_export_at, targetLastExport);
      assert.deepEqual([...new Set(trace.map(item => item.name))].sort(), [...publicNames].sort());
      assert.ok(trace.every(item => item.role === 'anon' && item.signal && !item.error && item.response !== null));
      assert.equal(trace.filter(item => item.name === 'employee_export_products_begin').length, 1);
      assert.equal(trace.filter(item => item.name === 'employee_import_products_begin').length, 1);
      assert.equal(trace.filter(item => item.name === 'employee_import_products_backup_seal').length, 1);
      t.diagnostic(`Real API/SQL golden path completed: ${sourceRows.length} source products, two source and two backup pages, ${cipher.length} independent ciphertext bytes, all 13 RPCs executed as anon; raw SQL response shapes accepted without filtering.`);
      await exportedFiles.abort(); assert.equal(exportedFiles.stats.aborts, 1);
      await assert.rejects(stat(exportPath), { code: 'ENOENT' });
    } catch (error) {
      const failed = trace.filter(item => item.error).map(item => ({ site: item.site, name: item.name, error: item.error }));
      if (failed.length) t.diagnostic(`Actual local SQL failures: ${JSON.stringify(failed)}`);
      throw error;
    } finally {
      modules.setProductDbBridge(null);
      await rm(directory, { recursive: true, force: true });
    }
  }, oldSite)));

test('same global name reuses target ID, source all six columns/nulls overwrite, nonpositive sort survives insert and target-only/case variants remain', async () => transaction(async () => {
  const before = await productState(), keep = await unaffected(), triggers = await triggerState();
  const { job, plan } = await prepared();
  applicable(plan);
  assert.equal(plan.scope, 'product-catalog'); assert.equal(plan.full_site_complete, false);
  assert.deepEqual(plan.records.find(item => item.source_id === OLD.product),
    { source_id: OLD.product, target_id: NEW.product, action: 'replace' });
  await gateBackup(job, plan);
  const receipt = await apply(job, plan), after = await productState();
  for (const source of values(pkg)) assert.deepEqual(after.find(item => item.id === receipt.product_map[source.id]),
    { ...source, id: receipt.product_map[source.id] });
  assert.equal(after.find(item => item.id === NEW.product).is_active, null);
  assert.equal(after.find(item => item.id === NEW.product).created_at, null);
  assert.equal(after.find(item => item.id === NEW.product).updated_at, null);
  for (const id of [ids.targetOnly, ids.caseOnly]) assert.deepEqual(after.find(item => item.id === id), before.find(item => item.id === id));
  assert.equal(after.some(item => item.id === OLD.product), false);
  assert.equal(after.find(item => item.id === ids.zero).sort_order, 0);
  assert.equal(after.find(item => item.id === ids.negative).sort_order, -17);
  assert.equal(after.find(item => item.id === ids.active).sort_order, 2147483647);
  assert.deepEqual(await unaffected(), keep); assert.deepEqual(await triggerState(), triggers);
  await close(job);
  const second = await prepared();
  await gateBackup(second.job, second.plan);
  const again = await apply(second.job, second.plan);
  assert.deepEqual(again.product_map, receipt.product_map);
  assert.deepEqual(await productState(), after, 'a fresh import of the same package cannot duplicate products or change fields');
}));

test('real empty-source export/page/verify stages an explicit empty chunk and applies as a backed-up no-op without deleting target-only products', async () => transaction(async () => transaction(async () => {
  assert.equal(await scalar(oldSite, 'SELECT count(*)::int FROM public.orders'), 0);
  await oldSite.exec('DELETE FROM public.product_types');
  const input = await exportOn(oldSite, sourceSession);
  assert.equal(input.text, '');
  assert.deepEqual(input.catalog.tables[0], { key: 'product_types', rows: 0, bytes: 0, sha256: hash('') });
  await baseRpc(oldSite, 'employee_products_close', auth(input.job, sourceSession));
  const before = await productState(), keep = await unaffected();
  const { job, plan } = await prepared(input);
  applicable(plan); assert.deepEqual(plan.records, []);
  await gateBackup(job, plan);
  assert.deepEqual((await apply(job, plan)).product_map, {});
  await close(job);
  assert.deepEqual(await productState(), before); assert.deepEqual(await unaffected(), keep);
}, oldSite)));

for (const kind of ['same-name source ID occupied by another name', 'new-name source ID occupied by another name']) {
  test(`identity conflict blocks dry-run/apply without backup or writes: ${kind}`, async () => transaction(async () => {
    const input = changed(items => {
      const item = items.find(item => item.id === OLD.product); item.id = ids.targetOnly;
      if (kind.startsWith('new-name')) item.name = 'source-only conflict name';
    });
    const before = await productState(), keep = await unaffected();
    const { job, plan } = await prepared(input);
    assert.equal(plan.can_apply, false);
    assert.ok(plan.conflicts.some(item => item.reason === 'product_id_conflict'), JSON.stringify(plan));
    await assert.rejects(descriptor(job), /conflict-free/);
    await assert.rejects(apply(job, plan), /sealed|conflict/);
    assert.equal(await backupState(job), undefined);
    assert.deepEqual(await productState(), before); assert.deepEqual(await unaffected(), keep);
  }));
}

for (const [label, mutate] of [
  ['unknown row column', row => { row.owner_admin_id = OLD.root; }],
  ['missing field', row => { delete row.updated_at; }],
  ['invalid UUID', row => { row.id = 'not-a-uuid'; }],
  ['uppercase UUID', row => { row.id = OLD.product.toUpperCase(); }],
  ['empty name', row => { row.name = '   '; }],
  ['name number', row => { row.name = 1; }],
  ['whitespace name', row => { row.name = '\t\r\n'; }],
  ['bidi name', row => { row.name = 'name\u202e'; }],
  ['BOM name', row => { row.name = 'name\ufeff'; }],
  ['normalized midnight timestamp', row => { row.updated_at = '2024-01-01T24:00:00Z'; }],
  ['normalized leap-second timestamp', row => { row.updated_at = '2024-01-01T23:59:60Z'; }],
  ['activation string', row => { row.is_active = 'true'; }],
  ['sort null', row => { row.sort_order = null; }],
  ['sort string', row => { row.sort_order = '1'; }],
  ['sort fraction', row => { row.sort_order = 1.5; }],
  ['sort above int32', row => { row.sort_order = 2147483648; }],
  ['sort below int32', row => { row.sort_order = -2147483649; }],
  ['relative timestamp', row => { row.created_at = 'now'; }],
  ['infinite timestamp', row => { row.updated_at = 'infinity'; }],
  ['invalid calendar timestamp', row => { row.updated_at = '2025-02-30T00:00:00Z'; }],
  ['timestamp without timezone', row => { row.created_at = '2024-01-02T03:04:05'; }],
  ['timestamp number', row => { row.updated_at = 0; }],
  ['timestamp excessive precision', row => { row.updated_at = '2024-01-02T03:04:05.1234567Z'; }],
]) {
  test(`stage rejects ${label} even when the forged catalog hash/bytes match`, async () => transaction(async () => {
    const input = changed(items => { mutate(items[0]); });
    const job = await begin(input), before = await staged(job);
    await assert.rejects(stage(job, input.text), /Invalid product|limit/);
    assert.deepEqual(await staged(job), before);
  }));
}
for (const [label, text] of [
  ['duplicate raw JSON key', row => JSON.stringify(row).replace('"name":', '"name":"first","name":') + '\n'],
  ['escaped duplicate JSON key', row => JSON.stringify(row).replace('"name":', '"na\\u006de":"first","name":') + '\n'],
  ['JSON array', row => JSON.stringify([row]) + '\n'],
  ['JSON scalar', () => 'null\n'],
  ['malformed JSON', () => '{oops}\n'],
  ['blank extra row', row => JSON.stringify(row) + '\n\n'],
]) {
  test(`stage rejects ${label} without losing the fixture transaction`, async () => transaction(async () => {
    const input = fromText(text(values(pkg)[0]));
    const job = await begin(input);
    await assert.rejects(stage(job, input.text), /JSON row|Invalid product/);
    assert.deepEqual(await staged(job), []);
    assert.equal((await jobState(job)).status, 'running');
  }));
}
for (const field of ['id', 'name']) {
  test(`stage rejects duplicate product ${field} in a single chunk`, async () => transaction(async () => {
    const input = changed(items => { items[1][field] = items[0][field]; }, pkg, false);
    const job = await begin(input);
    await assert.rejects(stage(job, input.text), /Duplicate product catalog identity/);
    assert.deepEqual(await staged(job), []);
  }));
  test(`dry-run rejects duplicate product ${field} spread across contiguous chunks`, async () => transaction(async () => {
    const input = changed(items => { items[1][field] = items[0][field]; }, pkg, false);
    const job = await begin(input), lines = input.text.match(/[^\n]*\n/g);
    await stage(job, lines[0]); await stage(job, lines.slice(1).join(''), 1);
    await assert.rejects(dryRun(job), /Duplicate product catalog identity/);
    assert.equal(await backupState(job), undefined);
  }));
}

for (const [label, mutate] of [
  ['unknown top-level field', c => { c.unknown = true; }], ['wrong scope', c => { c.scope = 'shared-settings'; }],
  ['full-site flag', c => { c.full_site_complete = true; }], ['wrong version', c => { c.version = 2; }],
  ['invalid site', c => { c.site_id = 'invalid'; }], ['wrong table', c => { c.tables[0].key = 'orders'; }],
  ['extra table', c => { c.tables.push(c.tables[0]); }], ['unknown table field', c => { c.tables[0].extra = 1; }],
  ['negative count', c => { c.tables[0].rows = -1; }], ['count overflow', c => { c.tables[0].rows = 10001; }],
  ['size overflow', c => { c.tables[0].bytes = 8388609; }], ['invalid hash', c => { c.tables[0].sha256 = 'a'.repeat(63); }],
]) {
  test(`begin rejects catalog ${label}`, async () => transaction(async () => {
    const input = structuredClone(pkg); mutate(input.catalog);
    await assert.rejects(begin(input), /Invalid product catalog/);
    assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status='running'"), 0);
  }));
}
for (const field of ['rows', 'bytes', 'sha256']) {
  test(`bound catalog ${field} tampering is rejected before dry-run can freeze a backup`, async () => transaction(async () => {
    const input = structuredClone(pkg);
    input.catalog.tables[0][field] = field === 'sha256' ? hash('forged') : input.catalog.tables[0][field] + 1;
    const job = await begin(input);
    await stage(job, input.text);
    await assert.rejects(dryRun(job), /hash or size mismatch|row count mismatch/);
    assert.equal(await backupState(job), undefined);
  }));
}

test('same-count valid row tampering is detected against the original frozen export hash', async () => transaction(async () => {
  const changedText = pkg.text.replace('来源负排序产品', '来源异排序产品');
  assert.equal(Buffer.byteLength(changedText), Buffer.byteLength(pkg.text));
  const job = await begin(); await stage(job, changedText);
  await assert.rejects(dryRun(job), /hash or size mismatch/);
}));

test('dry-run requires strict C/UUID row order across chunks, even with a correct malicious catalog hash', async () => transaction(async () => {
  const input = changed(items => items.reverse(), pkg, false), job = await begin(input);
  const lines = input.text.match(/[^\n]*\n/g);
  for (let no = 0; no < lines.length; no++) await stage(job, lines[no], no);
  await assert.rejects(dryRun(job), /strictly ordered/);
  assert.equal(await backupState(job), undefined);
}));

test('staging requires contiguous immutable chunks and freezes after dry-run; repeated pre-freeze chunks return exact receipts', async () => transaction(async () => {
  const job = await begin();
  await assert.rejects(stage(job, pkg.text, 1), /contiguous/);
  const first = await stage(job);
  assert.equal(first.rows, pkg.catalog.tables[0].rows); assert.equal(first.sha256, hash(pkg.text));
  assert.deepEqual(await stage(job), { ...first, repeated: true });
  await assert.rejects(stage(job, pkg.text.replace('来源负排序产品', '来源异排序产品')), /different contents/);
  const plan = await dryRun(job); applicable(plan);
  await assert.rejects(stage(job), /frozen product import/);
  await assert.rejects(stage(job, '', 1), /frozen product import/);
  assert.deepEqual(await dryRun(job), plan);
}));
for (const [label, no, text] of [
  ['negative chunk', -1, ''], ['null chunk', null, ''], ['excessive chunk', 10001, ''],
  ['null text', 0, null], ['missing final LF', 0, '{}'], ['oversized chunk', 0, ' '.repeat(262145)],
  ['empty nonzero chunk', 1, ''],
]) {
  test(`stage rejects ${label}`, async () => transaction(async () => {
    const job = await begin();
    await assert.rejects(stage(job, text, no), /Invalid product/);
    assert.deepEqual(await staged(job), []);
  }));
}

test('stage rejects more than 200 rows or a row exceeding 64KiB', async () => transaction(async () => {
  const input = changed(() => Array.from({ length: 201 }, (_, n) => ({ ...values(pkg)[0],
    id: `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `local product ${n}` })));
  const job = await begin(input);
  await assert.rejects(stage(job, input.text), /row count/);
  await cancel(job);
  const big = changed(items => { items[0].name = 'x'.repeat(65536); });
  const next = await begin(big);
  await assert.rejects(stage(next, big.text), /row exceeds|Invalid product catalog row/);
}));

test('apply requires dry-run confirmation and a matching saved/sealed backup; close refuses an unfinished import', async () => transaction(async () => {
  const job = await begin(); await stage(job);
  await assert.rejects(descriptor(job), /dry run/); await assert.rejects(page(job), /Invalid product page/);
  await assert.rejects(apply(job, { plan_hash: hash('unconfirmed') }), /dry run/);
  await assert.rejects(close(job), /not been verified/);
  const plan = await dryRun(job), bytes = gateCipher();
  await assert.rejects(apply(job, { plan_hash: null }), /dry run/);
  await assert.rejects(apply(job, { plan_hash: hash('wrong') }), /dry run/);
  await assert.rejects(apply(job, plan), /saved and sealed/);
  await append(job, plan, 0, bytes);
  await assert.rejects(apply(job, plan), /saved and sealed/);
  await assert.rejects(seal(job, plan, bytes, hash('wrong')), /does not match/);
  await assert.rejects(seal(job, plan, bytes, hash(bytes), bytes.length + 1), /does not match/);
  await assert.rejects(saved(job.job_id), /unavailable/);
}));

for (const [label, mutate] of [
  ['same-name product', () => db.query('UPDATE public.product_types SET sort_order=sort_order+1 WHERE id=$1', [NEW.product])],
  ['target-only product', () => db.query('UPDATE public.product_types SET is_active=true WHERE id=$1', [ids.targetOnly])],
  ['new unrelated product', () => db.query("INSERT INTO public.product_types(name) VALUES('changed after backup')")],
]) {
  test(`target snapshot detects drift in ${label}; frozen backup remains readable and apply is atomic`, async () => transaction(async () => {
    const { job, plan } = await prepared(); await gateBackup(job, plan);
    const frozen = await descriptor(job), firstPage = await page(job);
    await mutate();
    const before = await productState(), task = await jobState(job), audit = await events(job);
    assert.deepEqual(await page(job), firstPage);
    await assert.rejects(apply(job, plan), /target changed/);
    await assert.rejects(dryRun(job), /target changed/);
    assert.deepEqual(await descriptor(job), frozen); assert.deepEqual(await productState(), before);
    assert.deepEqual(await jobState(job), task); assert.deepEqual(await events(job), audit);
    assert.equal((await saved(job.job_id)).sha256, hash(gateCipher()));
  }));
}

test('backup snapshot pages are frozen, paginated/hash verified; invalid cursor/limits fail', async () => transaction(async () => {
  const { job } = await prepared(), frozen = await descriptor(job);
  let text = '', count = 0, after = null;
  do {
    const value = await page(job, after, 1);
    assert.equal(value.count, 1); assert.equal(value.sha256, hash(value.ndjson));
    text += value.ndjson; count += value.count; after = value.next_after;
  } while (after !== null);
  assert.equal(count, frozen.catalog.tables[0].rows); assert.equal(hash(text), frozen.catalog.tables[0].sha256);
  assert.equal(Buffer.byteLength(text), frozen.catalog.tables[0].bytes);
  for (const [cursor, limit] of [['unknown', 1], [null, 0], [null, 201], [null, null]]) {
    await assert.rejects(page(job, cursor, limit), /Invalid product page/);
  }
}));

test('ciphertext append/seal bind plan and exact bytes, contiguous chunks and immutable repeat identity', async () => transaction(async () => {
  const { job, plan } = await prepared(), bytes = gateCipher();
  await assert.rejects(append(job, plan, 1, bytes), /contiguous/);
  await assert.rejects(append(job, { plan_hash: hash('other') }, 0, bytes), /does not accept/);
  const first = await append(job, plan, 0, bytes.subarray(0, 47));
  assert.deepEqual(first, { success: true, bytes: 47, sha256: hash(bytes.subarray(0, 47)), repeated: false });
  assert.deepEqual(await append(job, plan, 0, bytes.subarray(0, 47)), { ...first, repeated: true });
  await assert.rejects(append(job, plan, 0, Buffer.from('changed')), /different contents/);
  await assert.rejects(seal(job, plan, bytes.subarray(0, 47)), /does not match/);
  await append(job, plan, 1, bytes.subarray(47));
  const sealed = await seal(job, plan, bytes), backup = await backupState(job);
  assert.deepEqual(await seal(job, plan, bytes), { ...sealed, repeated: true });
  assert.deepEqual(await backupState(job), backup);
  await assert.rejects(append(job, plan, 2, bytes), /does not accept/);
  const recovered = Buffer.concat([Buffer.from((await saved(job.job_id, 0)).hex, 'hex'), Buffer.from((await saved(job.job_id, 1)).hex, 'hex')]);
  assert.deepEqual(recovered, bytes);
  for (const no of [-1, 2, null]) await assert.rejects(saved(job.job_id, no), /unavailable/);
}));
for (const [no, hex] of [[-1, 'aa'], [1024, 'aa'], [null, 'aa'], [0, ''], [0, 'a'],
  [0, 'GG'], [0, 'AA'], [0, null], [0, 'aa'.repeat(131073)]]) {
  test(`ciphertext append rejects invalid index/encoding (${no}, ${hex === null ? 'null' : hex.length > 10 ? `${hex.length} chars` : hex})`, async () => transaction(async () => {
    const { job, plan } = await prepared();
    await assert.rejects(rpc('employee_import_products_backup_append', { ...auth(job), p_plan_hash: plan.plan_hash,
      p_chunk_no: no, p_hex: hex }), /Invalid encrypted product backup chunk/);
    assert.equal((await backupState(job)).byte_count, 0);
  }));
}

test('server seal checks ciphertext integrity only, and does not claim to authenticate AES-GCM or its plaintext catalog', async () => transaction(async () => {
  const { job, plan } = await prepared(), bytes = await gateBackup(job, plan);
  await assert.rejects(modules.verifyEncryptedVolume((async function* () { yield bytes; })(), PASSPHRASE,
    { async append() {}, async abort() {} }));
  assert.equal((await saved(job.job_id)).hex, bytes.toString('hex'));
  assert.equal((await backupState(job)).sealed_sha256, hash(bytes));
}));

test('seal refuses absent ciphertext, wrong magic and invalid confirmation fields', async () => transaction(async () => {
  const { job, plan } = await prepared(), bytes = Buffer.alloc(96, 0x61);
  await assert.rejects(seal(job, plan, bytes), /does not match/);
  await append(job, plan, 0, bytes);
  await assert.rejects(seal(job, plan, bytes), /does not match/);
  for (const [confirmation, sha256, length] of [[hash('other'), hash(bytes), bytes.length], [plan.plan_hash, 'bad', bytes.length],
    [plan.plan_hash, null, bytes.length], [plan.plan_hash, hash(bytes), null]]) {
    await assert.rejects(rpc('employee_import_products_backup_seal', { ...auth(job), p_plan_hash: confirmation,
      p_sha256: sha256, p_bytes: length }), /Invalid product backup seal/);
  }
  await assert.rejects(saved(job.job_id), /unavailable/);
}));

for (const uploaded of [false, true]) {
  test(`cancel deletes unsealed product backup and plaintext (${uploaded ? 'uploaded ciphertext' : 'empty backup'})`, async () => transaction(async () => {
    const before = await productState(), { job, plan } = await prepared();
    if (uploaded) await append(job, plan, 0, gateCipher());
    assert.equal((await backupState(job)).sealed_at, null);
    assert.equal((await cancel(job)).cancelled, true);
    assert.equal(await backupState(job), undefined); assert.deepEqual(await staged(job), []);
    assert.equal((await jobState(job)).status, 'cancelled');
    await assert.rejects(saved(job.job_id), /unavailable/);
    assert.equal((await cancel(job)).cancelled, false); assert.deepEqual(await productState(), before);
  }));
}

test('cancel preserves sealed independent ciphertext, denies task APIs and restricts recovery to the owning super admin', async () => transaction(async () => {
  const { job, plan } = await prepared(), bytes = await gateBackup(job, plan), backup = await backupState(job);
  await cancel(job);
  assert.deepEqual(await backupState(job), backup); assert.deepEqual(await staged(job), []);
  assert.equal((await saved(job.job_id)).hex, bytes.toString('hex'));
  for (const call of [() => page(job), () => descriptor(job), () => dryRun(job), () => stage(job),
    () => append(job, plan, 1, bytes), () => seal(job, plan, bytes), () => apply(job, plan), () => close(job)]) {
    await assert.rejects(call(), /invalid or expired/);
  }
  await assert.rejects(saved(job.job_id, 0, otherSession), /unavailable/);
  for (const token of [null, randomUUID(), branchSession, emergencySession]) await assert.rejects(saved(job.job_id, 0, token), /permission|session/i);
  const renewed = await rpc('create_admin_financial_session', { p_username: 'root', p_password: PASSWORDS.root });
  assert.equal((await saved(job.job_id, 0, renewed.session_token)).sha256, hash(bytes));
}));
for (const sealed of [false, true]) {
  test(`stale-task abandonment ${sealed ? 'keeps sealed' : 'deletes unsealed'} product backup without deleting an earlier sealed backup`, async () => transaction(async () => {
    const first = await prepared(), bytes = gateCipher();
    await append(first.job, first.plan, 0, bytes);
    if (sealed) await seal(first.job, first.plan, bytes);
    const backup = await backupState(first.job);
    await db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '3 minutes' WHERE id=$1", [first.job.job_id]);
    const second = await begin();
    assert.equal(second.success, true); assert.equal((await jobState(first.job)).status, 'abandoned');
    assert.deepEqual(await staged(first.job), []);
    if (sealed) {
      assert.deepEqual(await backupState(first.job), backup); assert.equal((await saved(first.job.job_id)).hex, bytes.toString('hex'));
    } else { assert.equal(await backupState(first.job), undefined); await assert.rejects(saved(first.job.job_id), /unavailable/); }
    await cancel(second);
    if (sealed) assert.deepEqual(await backupState(first.job), backup);
  }));
}

test('same-plan backups remain task-bound and cannot satisfy another import; cross-task plan confirmation is rejected', async () => transaction(async () => {
  const first = await prepared(); await gateBackup(first.job, first.plan); await cancel(first.job);
  const second = await prepared();
  assert.equal(second.plan.plan_hash, first.plan.plan_hash); assert.notEqual(second.job.job_id, first.job.job_id);
  await assert.rejects(apply(second.job, first.plan), /saved and sealed/);
  await assert.rejects(append(first.job, first.plan, 1, gateCipher()), /invalid or expired/);
  await cancel(second.job);
  const third = await prepared(changed(items => { items[0].sort_order += 1; }));
  assert.notEqual(third.plan.plan_hash, first.plan.plan_hash);
  await assert.rejects(append(third.job, first.plan, 0, gateCipher()), /does not accept/);
  await assert.rejects(seal(third.job, first.plan, gateCipher()), /Invalid product backup seal/);
  await assert.rejects(apply(third.job, first.plan), /dry run/);
  assert.equal((await saved(first.job.job_id)).sha256, hash(gateCipher()));
}));

test('passwords, invalid/non-super sessions, source identity and foreign task ownership are enforced', async () => transaction(async () => {
  for (const token of [null, randomUUID(), branchSession, emergencySession]) await assert.rejects(begin(pkg, token), /permission|session/i);
  for (const password of [null, '', 'wrong-local-password']) assert.equal((await begin(pkg, session, password)).success, false);
  const same = structuredClone(pkg); same.catalog.site_id = await scalar(db, 'SELECT site_id FROM private.employee_transfer_site');
  await assert.rejects(begin(same), /source identity/);
  await assert.rejects(begin({ ...pkg, packageId: null }), /source identity/);
  const { job, plan } = await prepared();
  const calls = [
    ['employee_import_products_stage', { p_chunk_no: 0, p_ndjson: pkg.text }],
    ['get_employee_import_products_dry_run', {}], ['get_employee_import_products_backup', {}],
    ['get_employee_import_products_backup_page', { p_after: null, p_limit: 1 }],
    ['employee_import_products_backup_append', { p_plan_hash: plan.plan_hash, p_chunk_no: 0, p_hex: gateCipher().toString('hex') }],
    ['employee_import_products_backup_seal', { p_plan_hash: plan.plan_hash, p_sha256: hash(gateCipher()), p_bytes: gateCipher().length }],
    ['employee_import_products_apply', { p_plan_hash: plan.plan_hash }], ['employee_products_close', {}],
  ];
  for (const token of [null, randomUUID(), branchSession, emergencySession, otherSession]) {
    for (const [name, args] of calls) await assert.rejects(rpc(name, { ...auth(job, token), ...args }), /permission|session|invalid or expired/i);
  }
  for (const token of [null, randomUUID()]) await assert.rejects(rpc('get_employee_import_products_dry_run', {
    p_admin_session_token: session, p_job_token: token,
  }), /invalid or expired/i);
  assert.equal((await cancel(job, otherSession)).cancelled, false);
}));
for (const mode of ['expired session', 'revoked session', 'idle task', 'maximum task age']) {
  test(`${mode} rejects product writes and ${mode.includes('session') ? 'sealed backup recovery' : 'task reads but allows sealed recovery'}`, async () => transaction(async () => {
    const { job, plan } = await prepared(); await gateBackup(job, plan);
    if (mode.includes('session')) await db.query(`UPDATE public.admin_financial_sessions SET
      ${mode.startsWith('expired') ? "expires_at=now()-interval '1 second'" : 'revoked_at=now()'} WHERE admin_id=$1 AND revoked_at IS NULL`, [NEW.root]);
    else await db.query(`UPDATE private.employee_transfer_jobs SET ${mode === 'idle task'
      ? "last_activity_at=now()-interval '3 hours'" : "started_at=now()-interval '12 hours'"} WHERE id=$1`, [job.job_id]);
    await assert.rejects(dryRun(job), /session|expired/i); await assert.rejects(apply(job, plan), /session|expired/i);
    await assert.rejects(close(job), /session|expired/i);
    if (mode.includes('session')) await assert.rejects(saved(job.job_id), /session/i);
    else assert.equal((await saved(job.job_id)).sha256, hash(gateCipher()));
  }));
}

test('browser roles cannot read/write private backup/staging or call private product helpers', async () => transaction(async () => {
  for (const role of ['anon', 'authenticated']) for (const sql of [
    'SELECT * FROM private.employee_transfer_shared_backups', 'SELECT * FROM private.employee_transfer_staging',
    'UPDATE private.employee_transfer_shared_backups SET sealed_at=now()', 'DELETE FROM private.employee_transfer_shared_backups',
    'INSERT INTO private.employee_transfer_shared_backups DEFAULT VALUES',
    'SELECT private.employee_transfer_product_snapshot()', 'SELECT private.employee_transfer_assert_product_triggers()',
  ]) await assert.rejects(isolated(db, () => db.exec(sql), role), /permission denied/);
}));

test('legacy employee/shared import/export/finish endpoints cannot use product tokens to bypass staging, backup or full-site completion gates', async () => transaction(async () => {
  const { job, plan } = await prepared();
  const calls = [
    ['employee_import_stage_chunk', { p_employee_id: OLD.e1, p_table_key: 'account', p_chunk_no: 0, p_rows: [] }],
    ['employee_import_apply_core', { p_employee_id: OLD.e1, p_expected: {} }],
    ['employee_import_rows_batch', { p_employee_id: OLD.e1, p_table_key: 'orders', p_rows: [] }],
    ['employee_import_chat_batch', { p_employee_id: OLD.e1, p_table_key: 'chat_messages', p_rows: [] }],
    ['employee_import_finalize_employee', { p_employee_id: OLD.e1, p_expected: {} }],
    ['employee_import_apply_roles', { p_decisions: [] }], ['employee_import_finish', { p_summary: { full_site_complete: true } }],
    ['employee_import_shared_stage', { p_table_key: 'admins', p_chunk_no: 0, p_ndjson: '' }],
    ['get_employee_import_shared_dry_run', {}], ['get_employee_import_shared_replace_dry_run', {}],
    ['employee_import_shared_apply', { p_plan_hash: plan.plan_hash }], ['employee_import_shared_replace_apply', { p_plan_hash: plan.plan_hash }],
    ['get_employee_import_shared_backup', {}], ['get_employee_import_shared_backup_page', { p_table_key: 'admins', p_after: null, p_limit: 1 }],
    ['employee_import_shared_backup_append', { p_plan_hash: plan.plan_hash, p_chunk_no: 0, p_hex: gateCipher().toString('hex') }],
    ['employee_import_shared_backup_seal', { p_plan_hash: plan.plan_hash, p_sha256: hash(gateCipher()), p_bytes: gateCipher().length }],
    ['employee_export_finish', { p_summary: { full_site_complete: true } }],
  ];
  for (const [name, args] of calls) await assert.rejects(rpc(name, { ...auth(job), ...args }), /protocol|invalid or expired|does not permit/i);
  assert.equal((await jobState(job)).status, 'running');
}));

test('ordinary legacy employee import cannot invoke any product job endpoint or close itself as a product stage', async () => transaction(async () => {
  const job = await rpc('employee_import_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root,
    p_decisions: {}, p_summary: {} });
  assert.equal(job.success, true);
  for (const [name, args] of [
    ['employee_import_products_stage', { p_chunk_no: 0, p_ndjson: pkg.text }], ['get_employee_import_products_dry_run', {}],
    ['get_employee_import_products_backup', {}], ['get_employee_import_products_backup_page', { p_after: null, p_limit: 1 }],
    ['employee_import_products_backup_append', { p_plan_hash: hash('plan'), p_chunk_no: 0, p_hex: gateCipher().toString('hex') }],
    ['employee_import_products_backup_seal', { p_plan_hash: hash('plan'), p_sha256: hash(gateCipher()), p_bytes: gateCipher().length }],
    ['employee_import_products_apply', { p_plan_hash: hash('plan') }], ['employee_products_close', {}],
  ]) await assert.rejects(rpc(name, { ...auth(job), ...args }), /protocol/);
}));

test('legacy begin cannot forge a products protocol task through reserved summary fields', async () => transaction(async () => {
  for (const field of ['import_protocol', 'export_protocol', 'catalog', 'package_id']) {
    await assert.rejects(rpc('employee_import_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root,
      p_decisions: {}, p_summary: { [field]: field === 'catalog' ? pkg.catalog : 'products-v1' } }), /reserved|protocol/i);
  }
}));

for (const [label, setup] of [
  ['unknown INSERT trigger', () => db.exec(`CREATE FUNCTION public.fixture_product_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM nextval('public.fixture_product_calls'); RAISE EXCEPTION 'unknown product trigger fired'; END; $$;
    CREATE TRIGGER fixture_unknown_product BEFORE INSERT ON public.product_types FOR EACH ROW EXECUTE FUNCTION public.fixture_product_trigger()`)],
  ['unknown zero-row statement UPDATE trigger', () => db.exec(`CREATE FUNCTION public.fixture_product_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM nextval('public.fixture_product_calls'); RAISE EXCEPTION 'unknown product trigger fired'; END; $$;
    CREATE TRIGGER fixture_unknown_product AFTER UPDATE ON public.product_types FOR EACH STATEMENT EXECUTE FUNCTION public.fixture_product_trigger()`)],
  ['forged approved-name trigger/function', () => db.exec(`DROP TRIGGER assign_product_type_sort_order ON public.product_types;
    CREATE FUNCTION public.fixture_product_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM nextval('public.fixture_product_calls'); RAISE EXCEPTION 'unknown product trigger fired'; END; $$;
    CREATE TRIGGER assign_product_type_sort_order BEFORE INSERT ON public.product_types FOR EACH ROW EXECUTE FUNCTION public.fixture_product_trigger()`)],
  ['disabled approved trigger', () => db.exec('ALTER TABLE public.product_types DISABLE TRIGGER assign_product_type_sort_order')],
  ['replica-only approved trigger', () => db.exec('ALTER TABLE public.product_types ENABLE REPLICA TRIGGER assign_product_type_sort_order')],
  ['changed approved function body', () => db.exec(`CREATE OR REPLACE FUNCTION private.assign_product_type_sort_order()
    RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,private,pg_temp AS $$
    BEGIN PERFORM nextval('public.fixture_product_calls'); RETURN NEW; END; $$`)],
]) {
  test(`${label} is rejected before any write or trigger side effect`, async () => transaction(async () => {
    const { job, plan } = await prepared(); await gateBackup(job, plan);
    await db.exec('CREATE SEQUENCE public.fixture_product_calls'); await setup();
    const before = await productState(), keep = await unaffected(), task = await jobState(job), audit = await events(job);
    const backup = await backupState(job), triggers = await triggerState();
    await assert.rejects(apply(job, plan), /unreviewed product write trigger/);
    assert.equal(await scalar(db, 'SELECT is_called FROM public.fixture_product_calls'), false,
      'sequence side effects cannot hide in a rolled-back subtransaction');
    assert.deepEqual(await productState(), before); assert.deepEqual(await unaffected(), keep);
    assert.deepEqual(await jobState(job), task); assert.deepEqual(await events(job), audit);
    assert.deepEqual(await backupState(job), backup); assert.deepEqual(await triggerState(), triggers);
  }));
}

test('approved ALWAYS trigger is accepted and remains ALWAYS after product apply', async () => transaction(async () => {
  await db.exec('ALTER TABLE public.product_types ENABLE ALWAYS TRIGGER assign_product_type_sort_order');
  const { job, plan } = await prepared(); await gateBackup(job, plan);
  assert.equal((await apply(job, plan)).success, true);
  assert.equal((await triggerState())[0].tgenabled, 'A');
}));

test('unknown product schema column blocks snapshot/dry-run rather than silently omitting it', async () => transaction(async () => {
  const job = await begin(); await stage(job);
  await db.exec('ALTER TABLE public.product_types ADD COLUMN fixture_unknown_column text');
  await assert.rejects(dryRun(job), /Unreviewed product catalog schema/);
  assert.equal(await backupState(job), undefined);
}));

test('late CHECK failure rolls back earlier product inserts/replacements, receipt and events; sealed backup remains retryable', async () => transaction(async () => {
  const { job, plan } = await prepared(); await gateBackup(job, plan);
  await db.exec(`ALTER TABLE public.product_types ADD CONSTRAINT fixture_product_late_failure CHECK (sort_order <> -2147483648)`);
  const before = await productState(), keep = await unaffected(), task = await jobState(job), audit = await events(job), backup = await backupState(job);
  // A positive-path guard regression must fail this assertion, not masquerade as exercising rollback.
  await assert.rejects(apply(job, plan), /fixture_product_late_failure/);
  assert.deepEqual(await productState(), before); assert.deepEqual(await unaffected(), keep);
  assert.deepEqual(await jobState(job), task); assert.deepEqual(await events(job), audit); assert.deepEqual(await backupState(job), backup);
  await db.exec('ALTER TABLE public.product_types DROP CONSTRAINT fixture_product_late_failure');
  assert.equal((await apply(job, plan)).success, true);
}));

test('audit failure after all product writes atomically restores catalog/task/event state while retaining sealed ciphertext', async () => transaction(async () => {
  const { job, plan } = await prepared(); await gateBackup(job, plan);
  await db.exec(`CREATE FUNCTION public.fixture_product_event_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='products_applied' THEN RAISE EXCEPTION 'fixture product audit failure'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER fixture_product_event_failure BEFORE INSERT ON private.employee_transfer_events
    FOR EACH ROW EXECUTE FUNCTION public.fixture_product_event_failure()`);
  const before = await productState(), task = await jobState(job), audit = await events(job), backup = await backupState(job);
  await assert.rejects(apply(job, plan), /fixture product audit failure/);
  assert.deepEqual(await productState(), before); assert.deepEqual(await jobState(job), task);
  assert.deepEqual(await events(job), audit); assert.deepEqual(await backupState(job), backup);
}));

for (const sealed of [false, true]) {
  test(`failed cancellation restores ${sealed ? 'sealed' : 'unsealed'} ciphertext, staging and task status atomically`, async () => transaction(async () => {
    const { job, plan } = await prepared(); await append(job, plan, 0, gateCipher());
    if (sealed) await seal(job, plan, gateCipher());
    const backup = await backupState(job), task = await jobState(job), staging = await staged(job), audit = await events(job);
    await db.exec(`CREATE FUNCTION public.fixture_product_cancel_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='import_cancelled' THEN RAISE EXCEPTION 'fixture product cancellation failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fixture_product_cancel_failure BEFORE INSERT ON private.employee_transfer_events
      FOR EACH ROW EXECUTE FUNCTION public.fixture_product_cancel_failure()`);
    await assert.rejects(cancel(job), /fixture product cancellation failure/);
    assert.deepEqual(await backupState(job), backup); assert.deepEqual(await jobState(job), task);
    assert.deepEqual(await staged(job), staging); assert.deepEqual(await events(job), audit);
  }));
}

test('export passwords/permissions and product-token protocol isolation reject old/shared endpoints; close requires verification', async () => transaction(async () => {
  const exportCall = (name, args) => callOn(oldSite, name, args);
  for (const token of [null, randomUUID(), sourceBranchSession]) await assert.rejects(exportCall('employee_export_products_begin', {
    p_admin_session_token: token, p_admin_password: PASSWORDS.root,
  }), /permission|session/i);
  assert.equal((await exportCall('employee_export_products_begin', { p_admin_session_token: sourceSession,
    p_admin_password: 'wrong-local-password' })).success, false);
  const job = await exportCall('employee_export_products_begin', { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root });
  await assert.rejects(exportCall('employee_products_close', auth(job, sourceSession)), /not been verified/);
  for (const [name, args] of [['employee_export_finish', { p_summary: { full_site_complete: true } }],
    ['get_employee_export_directory', {}], ['get_employee_export_shared_catalog', {}],
    ['get_employee_export_shared_page', { p_table_key: 'admins', p_after: null, p_limit: 1 }],
    ['employee_export_shared_verify', {}]]) await assert.rejects(exportCall(name, { ...auth(job, sourceSession), ...args }), /protocol|permit/);
  for (const token of [null, randomUUID(), sourceBranchSession]) for (const name of ['get_employee_export_products_page',
    'employee_export_products_verify', 'employee_products_close']) await assert.rejects(exportCall(name, auth(job, token)), /permission|session/i);
}, oldSite));

test('export frozen pages remain unchanged but same-count source mutation makes verify fail', async () => transaction(async () => {
  const job = await callOn(oldSite, 'employee_export_products_begin', { p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root });
  const read = (after = null, limit = 2) => callOn(oldSite, 'get_employee_export_products_page', { ...auth(job, sourceSession), p_after: after, p_limit: limit });
  const first = await read();
  await oldSite.query('UPDATE public.product_types SET is_active=false WHERE id=$1', [ids.active]);
  assert.deepEqual(await read(), first);
  await assert.rejects(callOn(oldSite, 'employee_export_products_verify', auth(job, sourceSession)), /source changed/);
  await assert.rejects(callOn(oldSite, 'employee_products_close', auth(job, sourceSession)), /not been verified/);
  for (const [cursor, limit] of [['bad', 1], [null, 0], [null, 201], [null, null]]) await assert.rejects(read(cursor, limit), /Invalid product page/);
}, oldSite));

test('source products mapping to a single target ID are a conflict, not last-row-wins replacement', async () => transaction(async () => {
  const input = changed(items => {
    items.push({ ...items.find(item => item.id === ids.zero), id: NEW.product, name: 'source claims mapped target identity' });
  });
  const before = await productState(), { job, plan } = await prepared(input);
  assert.equal(plan.can_apply, false);
  assert.ok(plan.conflicts.some(item => item.reason === 'mapped_product_collision'));
  assert.ok(plan.conflicts.some(item => item.reason === 'product_id_conflict'));
  await assert.rejects(descriptor(job), /conflict-free/);
  assert.deepEqual(await productState(), before);
}));

test('export and import product tasks cannot cross-call even their own product-specific APIs', async () => transaction(async () => {
  const exported = await rpc('employee_export_products_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  for (const [name, args] of [['employee_import_products_stage', { p_chunk_no: 0, p_ndjson: pkg.text }],
    ['get_employee_import_products_dry_run', {}], ['get_employee_import_products_backup', {}],
    ['employee_import_products_apply', { p_plan_hash: hash('plan') }]]) {
    await assert.rejects(rpc(name, { ...auth(exported), ...args }), /invalid or expired/);
  }
  await cancel(exported);
  const imported = await begin();
  for (const name of ['get_employee_export_products_page', 'employee_export_products_verify']) {
    await assert.rejects(rpc(name, auth(imported)), /invalid or expired/);
  }
}));

test('old shared-settings tasks and legacy exports cannot use product APIs or close as product-only completion', async () => transaction(async () => transaction(async () => {
  const shared = await callOn(oldSite, 'employee_export_shared_begin', {
    p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
  });
  assert.equal(shared.success, true);
  const job = await rpc('employee_import_shared_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root,
    p_package_id: randomUUID(), p_catalog: shared.catalog });
  assert.equal(job.success, true);
  for (const [name, args] of [['employee_import_products_stage', { p_chunk_no: 0, p_ndjson: pkg.text }],
    ['get_employee_import_products_dry_run', {}], ['get_employee_import_products_backup', {}],
    ['employee_import_products_apply', { p_plan_hash: hash('plan') }], ['employee_products_close', {}]]) {
    await assert.rejects(rpc(name, { ...auth(job), ...args }), /protocol/);
  }
  await cancel(job);
  const exported = await rpc('employee_export_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  for (const name of ['get_employee_export_products_page', 'employee_export_products_verify', 'employee_products_close']) {
    await assert.rejects(rpc(name, auth(exported)), /protocol/);
  }
}, oldSite)));

test('product backup recovery rejects a sealed seven-table backup with the same owner', async () => transaction(async () => transaction(async () => {
  const shared = await callOn(oldSite, 'employee_export_shared_begin', {
    p_admin_session_token: sourceSession, p_admin_password: PASSWORDS.root,
  });
  const job = await rpc('employee_import_shared_replace_begin', { p_admin_session_token: session,
    p_admin_password: PASSWORDS.root, p_package_id: randomUUID(), p_catalog: shared.catalog });
  for (const table of shared.catalog.tables) {
    let after = null, no = 0;
    do {
      const value = await callOn(oldSite, 'get_employee_export_shared_page', { ...auth(shared, sourceSession),
        p_table_key: table.key, p_after: after, p_limit: 200 });
      await rpc('employee_import_shared_stage', { ...auth(job), p_table_key: table.key, p_chunk_no: no++, p_ndjson: value.ndjson });
      after = value.next_after;
    } while (after !== null);
  }
  const plan = await rpc('get_employee_import_shared_replace_dry_run', auth(job));
  applicable(plan);
  const bytes = gateCipher();
  await rpc('employee_import_shared_backup_append', { ...auth(job), p_plan_hash: plan.plan_hash, p_chunk_no: 0, p_hex: bytes.toString('hex') });
  await rpc('employee_import_shared_backup_seal', { ...auth(job), p_plan_hash: plan.plan_hash, p_sha256: hash(bytes), p_bytes: bytes.length });
  assert.equal((await backupState(job)).catalog.scope, 'shared-settings');
  await assert.rejects(saved(job.job_id), /unavailable/);
}, oldSite)));

test('product export close records only stage completion and must not advance the full-site last_export_at', async () => transaction(async () => {
  const job = await rpc('employee_export_products_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  const before = await rpc('get_employee_transfer_log', { p_admin_session_token: session });
  await rpc('employee_export_products_verify', auth(job));
  const receipt = await close(job);
  assert.deepEqual(receipt, { success: true, scope: 'product-catalog', full_site_complete: false });
  assert.equal((await jobState(job)).summary.full_site_complete, false);
  const after = await rpc('get_employee_transfer_log', { p_admin_session_token: session });
  assert.equal(after.last_export_at, before.last_export_at, 'a product-only stage is not a successful whole-site export');
}));
