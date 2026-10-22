import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSites, adminLogin, rpc as baseRpc, rows, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Only local PGlite, real migrations, anon RPCs and real automation workers. One parent
// replays once; cases roll back to savepoints. No import/job/maintenance/permit stubs.
// Lock checks below are STATIC contracts, NOT native PostgreSQL concurrency evidence.
const MIGRATION = '20261102000056_freeze_cutover_source.sql';
const STATUS = 'get_employee_export_cutover_status';
const FREEZE = 'employee_export_cutover_freeze';
const RESUME = 'employee_export_cutover_resume';
const SNAPSHOT = 'get_employee_export_site_snapshot';
const FREEZE_CONFIRM = '確認暫停舊站業務並導出';
const RESUME_CONFIRM = '確認恢復舊站業務並放棄切站';
const PAUSED = 'Business writes are paused for employee transfer maintenance.';
const SHARED = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
const DISPATCH = ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders',
  'dispatch_group_members', 'valid_order_data', 'used_order_data'];
const id = n => `56000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = id(1), OTHER = id(2), PLAN = id(3), TASK = id(4), PRODUCT = id(5), ANNUAL = id(6);
const PAUSED_PLAN = id(7), PAUSED_TASK = id(8);
const sha = value => createHash('sha256').update(value).digest('hex');
const root = fileURLToPath(new URL('../../', import.meta.url));

// All identifiers below come from fixed names or the real PostgreSQL catalog.
const quote = name => `"${name.replaceAll('"', '""')}"`;
const relation = name => name.split('.').map(quote).join('.');

test('SQL56 source cutover: local real PGlite; static locks are not native PG concurrency tests', { timeout: 600000 }, async t => {
  let replay, db, target, session, targetSession, branch, emergency, otherSession, employeeSession;
  let sequence = 0, networkCalls = 0, backupModules;
  const network = mock.method(globalThis, 'fetch', () => { networkCalls++; assert.fail('Source cutover tests forbid all network/production access'); });
  async function statement(site, action, role = null) {
    const point = `cutover_statement_${++sequence}`;
    await site.exec(`SAVEPOINT ${point}`);
    try {
      if (role) await site.exec(`SET LOCAL ROLE ${role}`);
      const value = await action();
      await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`);
      return value;
    } catch (error) {
      await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
      throw error;
    }
  }
  const on = (site, name, args, role = 'anon') => statement(site, () => baseRpc(site, name, args, { role: null }), role);
  const rpc = (name, args, role) => on(db, name, args, role);
  const auth = (job, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
  const status = (token = session) => rpc(STATUS, { p_admin_session_token: token });
  const freeze = (extra = {}) => rpc(FREEZE, { p_admin_session_token: session, p_admin_password: PASSWORDS.root,
    p_confirmation: FREEZE_CONFIRM, ...extra });
  const resume = (cutoff, extra = {}) => rpc(RESUME, { p_admin_session_token: session, p_admin_password: PASSWORDS.root,
    p_confirmation: RESUME_CONFIRM, p_cutoff_id: cutoff, ...extra });
  const snapshot = packageId => rpc(SNAPSHOT, { p_admin_session_token: session, p_package_id: packageId });
  const sharedBegin = () => rpc('employee_export_shared_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  const cancel = (job, site = db, token = session) => on(site, 'employee_transfer_cancel', auth(job, token));
  const maintenance = site => scalar(site, 'SELECT to_jsonb(m)::text FROM private.employee_transfer_maintenance m');
  const frozenJob = cutoff => scalar(db, 'SELECT to_jsonb(j)::text FROM private.employee_transfer_jobs j WHERE id=$1', [cutoff]);
  const triggerState = site => rows(site, `SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
    FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2`);
  const digest = (site, names) => rows(site, names.map(name => `SELECT '${name}' AS name,count(*)::int AS count,
    md5(COALESCE(string_agg(to_jsonb(r)::text,E'\n' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${relation(name)} r`).join(' UNION ALL '));
  let guarded, allData;
  const business = () => digest(db, guarded);
  const state = () => digest(db, allData);
  async function blocked(action, site = db) {
    await assert.rejects(statement(site, action), error => {
      assert.equal(error.code, '55000'); assert.equal(error.message, PAUSED); return true;
    });
  }
  async function assertFrozen() {
    const s = await status(); assert.equal(s.frozen, true); assert.equal(s.full_site_complete, false);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits'), 0);
    return s;
  }
  async function freezeReady() {
    const s = await freeze(); assert.equal(s.success, true); assert.equal(s.frozen, true, JSON.stringify(s.blockers));
    assert.deepEqual(s.blockers, []); return s.cutoff;
  }
  async function order() {
    const orderId = randomUUID();
    await db.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status)
      VALUES($1,$2,'cutover-employee',$3,100,$4,$5,'processing')`, [orderId, U, PRODUCT, `CUT-${orderId}`, `TX-${orderId}`]);
    return orderId;
  }
  // Work-session completion naturally enqueues this employee, without inserting/deleting queue fixtures.
  const enqueue = () => db.query(`INSERT INTO public.work_sessions(user_id,start_time,end_time,duration_minutes,last_heartbeat_at)
    VALUES($1,clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',1,clock_timestamp()-interval '1 minute')`, [U]);
  const worker = () => statement(db, () => scalar(db, 'SELECT public.process_notification_automation_queue_fast(10)'));

  // Real two-site export/stage/plan/independent encrypted backup/enter/apply, used only
  // to obtain an actual dirty import. No handcrafted job, plan, seal or maintenance row.
  async function capture(kind, keys, packageId) {
    const job = await rpc(`employee_export_${kind}_begin`, { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
    assert.equal(job.success, true);
    const texts = {};
    for (const key of keys) {
      let text = '', after = null;
      do {
        const page = await rpc(`get_employee_export_${kind}_page`, { ...auth(job), p_table_key: key, p_after: after, p_limit: 200 });
        assert.equal(page.sha256, sha(page.ndjson)); text += page.ndjson; after = page.next_after;
      } while (after !== null);
      texts[key] = text;
    }
    assert.equal((await rpc(`employee_export_${kind}_verify`, auth(job))).verified, true);
    assert.equal((await rpc(`employee_export_${kind}_close`, auth(job))).success, true);
    return { catalog: job.catalog, texts, packageId };
  }
  async function prepare(kind, input) {
    const token = targetSession;
    const job = await on(target, kind === 'shared' ? 'employee_import_shared_replace_begin' : 'employee_import_dispatch_begin', {
      p_admin_session_token: token, p_admin_password: PASSWORDS.root, p_package_id: input.packageId, p_catalog: input.catalog,
    });
    assert.equal(job.success, true);
    for (const [key, text] of Object.entries(input.texts)) assert.equal((await on(target, `employee_import_${kind}_stage`, {
      ...auth(job, token), p_table_key: key, p_chunk_no: 0, p_ndjson: text,
    })).success, true);
    const plan = await on(target, kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', auth(job, token));
    assert.equal(kind === 'shared' ? plan.can_apply : plan.preparation_ready, true, JSON.stringify(plan));
    return { job, plan };
  }
  async function backup(kind, job, plan) {
    if (!backupModules) {
      const output = await build({ stdin: { contents: `export { createReplacementBackup } from './src/lib/employeeTransfer/replacementBackup.ts';
        export { createDispatchBackup } from './src/lib/employeeTransfer/dispatchBackup.ts';`, resolveDir: root, sourcefile: 'cutover-backup-entry.mjs' },
      bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020' });
      backupModules = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
    }
    const args = auth(job, targetSession), files = new Map();
    const descriptor = await on(target, `get_employee_import_${kind}_backup`, args);
    const directory = await mkdtemp(join(tmpdir(), 'cutover-independent-backup-'));
    const path = join(directory, 'independent.edx');
    async function* bytes(buffer) { yield buffer; }
    try {
      const result = await (kind === 'shared' ? backupModules.createReplacementBackup : backupModules.createDispatchBackup)(descriptor, {
        catalog: async () => (await on(target, `get_employee_import_${kind}_backup`, args)).catalog,
        page: (key, after) => on(target, `get_employee_import_${kind}_backup_page`, { ...args, p_table_key: key, p_after: after, p_limit: 200 }),
        async verify() {
          assert.deepEqual(await on(target, `get_employee_import_${kind}_backup`, args), descriptor);
          const again = await on(target, kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', args);
          assert.deepEqual(again, plan);
          return { verified: true, scope: kind === 'shared' ? 'shared-settings' : 'dispatch-submission', full_site_complete: false };
        },
      }, {
        async append(name, buffer) { files.set(name, Buffer.concat([files.get(name) ?? Buffer.alloc(0), Buffer.from(buffer)])); },
        open(name) { assert.ok(files.has(name)); return bytes(files.get(name)); },
        async abort() { files.clear(); },
      }, {
        async write(stream) { const parts = []; for await (const buffer of stream) parts.push(Buffer.from(buffer)); await writeFile(path, Buffer.concat(parts), { flag: 'wx' }); },
        async *open() { yield await readFile(path); },
      }, {
        append: (no, hex) => on(target, `employee_import_${kind}_backup_append`, { ...args, p_plan_hash: plan.plan_hash, p_chunk_no: no, p_hex: hex }),
        seal: (hash, count) => on(target, `employee_import_${kind}_backup_seal`, { ...args, p_plan_hash: plan.plan_hash, p_sha256: hash, p_bytes: count }),
      }, 'local-only-cutover-independent-backup-passphrase');
      const saved = await readFile(path);
      assert.equal(saved.subarray(0, 8).toString(), 'EDXSTRM1'); assert.equal(sha(saved), result.cipherSha256);
      assert.equal(result.sealReceipt.success, true); assert.equal(files.size, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  try {
    replay = await createSites({ upTo: MIGRATION }); db = replay.oldSite; target = replay.newSite;
    await target.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
    await buildNewSite(db); await buildNewSite(target);
    await db.exec('BEGIN');
    try {
      await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
        VALUES($1,'cutover-other-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [OTHER, PASSWORDS.root]);
      await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [OTHER]);
      await db.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,is_active,is_verified)
        VALUES($1,'cutover-employee','CUT-001',extensions.crypt($2,extensions.gen_salt('bf',4)),$3,true,true)`, [U, PASSWORDS.employee, NEW.root]);
      await db.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [U]);
      await db.query('INSERT INTO public.dispatch_group_members(group_id,user_id,assigned_by) VALUES($1,$2,$3)', [NEW.groupA, U, NEW.root]);
      await db.query(`INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Cutover product',true)`, [PRODUCT]);
      await db.query(`INSERT INTO public.notification_automation_plans(id,owner_admin_id,name,status,activated_at)
        VALUES($1,$2,'Cutover active plan','active','2020-01-01')`, [PLAN, NEW.root]);
      await db.query(`INSERT INTO public.notification_automation_plan_members(plan_id,user_id,created_at) VALUES($1,$2,'2020-01-01')`, [PLAN, U]);
      await db.query(`INSERT INTO public.notification_automation_tasks(id,owner_admin_id,plan_id,name,status,trigger_type,
        trigger_mode,threshold_value,recipient_scope,title_template,content_template,activated_at,starts_at)
        VALUES($1,$2,$3,'Cutover active task','active','total_orders','reach_once',100,'selected','Cutover title','Cutover body','2020-01-01','2020-01-01')`, [TASK, NEW.root, PLAN]);
      await db.query(`INSERT INTO public.notification_automation_plans(id,owner_admin_id,name,status)
        VALUES($1,$2,'Originally paused plan','paused')`, [PAUSED_PLAN, NEW.root]);
      await db.query(`INSERT INTO public.notification_automation_tasks(id,owner_admin_id,plan_id,name,status,trigger_type,
        trigger_mode,threshold_value,recipient_scope,title_template,content_template)
        VALUES($1,$2,$3,'Originally paused task','paused','total_orders','reach_once',1,'selected','Paused title','Paused body')`,
      [PAUSED_TASK, NEW.root, PAUSED_PLAN]);
      session = await adminLogin(db, 'root', PASSWORDS.root);
      branch = await adminLogin(db, 'branch', PASSWORDS.branch);
      emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
      otherSession = await adminLogin(db, 'cutover-other-root', PASSWORDS.root);
      const employee = await on(db, 'create_employee_financial_session', { p_username: 'cutover-employee', p_password: PASSWORDS.employee, p_tab_id: 'cutover-local-tab' });
      assert.equal(employee.success, true); employeeSession = employee.session_token;
      assert.match(employeeSession, /^[0-9a-f-]{36}$/i);
      const adjustment = await on(db, 'admin_adjust_wallet_balance_atomic', { p_admin_session_token: session, p_user_id: U,
        p_amount: '123.45', p_remarks: 'Local cutover fixture balance', p_operation_id: randomUUID() });
      assert.equal(adjustment.success, true);
      assert.equal(await scalar(db, 'SELECT available_balance=123.45 FROM public.wallets WHERE user_id=$1', [U]), true);
      await enqueue(); assert.equal((await worker()).processed_users, 1);
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_queue'), 0);
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_failures'), 0);
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_progress WHERE task_id=$1 AND user_id=$2', [TASK, U]), 1);
      await db.exec('COMMIT');
    } catch (error) { await db.exec('ROLLBACK'); throw error; }
    targetSession = await adminLogin(target, 'root', PASSWORDS.root);
    guarded = await scalar(db, 'SELECT private.employee_transfer_guarded_tables()');
    allData = (await rows(db, `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') ORDER BY 1`)).map(row => row.name);

    await t.test('replays through SQL56 with only the 12 exact known historical gaps; no clean native PG claim', () => {
      assert.equal(replay.files.at(-1), MIGRATION); assert.equal(replay.failures.length, 12);
      assert.equal(replay.validation.matched.length, 12); assert.equal(replay.validation.freshDatabaseVerified, false);
      assert.ok(guarded.length >= 94); assert.ok(guarded.includes('public.notification_automation_queue'));
      t.diagnostic(`${replay.files.length} migrations replayed once; ${guarded.length} guarded relations; 12 known historical gaps`);
    });

    // A real READ ONLY transaction, not just a proconfig assertion. All later cases use
    // one parent transaction with per-case and per-RPC savepoints (no repeated builds).
    await t.test('ordinary daily snapshot is genuinely READ ONLY and has no source_cutover field', async () => {
      await db.exec('BEGIN READ ONLY');
      try {
        const before = await state(), packageId = randomUUID();
        const s = await snapshot(packageId);
        assert.equal(await scalar(db, 'SHOW transaction_read_only'), 'on');
        assert.equal(Object.hasOwn(s, 'source_cutover'), false); assert.equal(s.package_id, packageId);
        assert.equal(s.full_site_complete, false); assert.equal(s.import_ready, false);
        assert.equal(Object.keys(s.catalogs).length, 10); assert.deepEqual(await state(), before);
      } finally { await db.exec('ROLLBACK'); }
    });
    await db.exec('BEGIN'); await target.exec('BEGIN');
    async function scenario(name, fn) {
      await t.test(name, async subtest => {
        const point = `cutover_case_${++sequence}`;
        await db.exec(`SAVEPOINT ${point}`); await target.exec(`SAVEPOINT ${point}`);
        try { await fn(subtest); }
        finally {
          await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
          await target.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
        }
      });
    }

    await scenario('public RPC signatures, fixed search_path/SECURITY DEFINER and private helper ACLs', async () => {
      const publicNames = [STATUS, FREEZE, RESUME, SNAPSHOT];
      const functions = await rows(db, `SELECT oid,proname,prosecdef,proconfig,pg_get_function_identity_arguments(oid) AS args,
        EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
        FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) ORDER BY proname`, [publicNames]);
      assert.equal(functions.length, 4);
      const argTypes = { [STATUS]: 'p_admin_session_token uuid', [FREEZE]: 'p_admin_session_token uuid, p_admin_password text, p_confirmation text',
        [RESUME]: 'p_admin_session_token uuid, p_admin_password text, p_confirmation text, p_cutoff_id uuid',
        [SNAPSHOT]: 'p_admin_session_token uuid, p_package_id uuid' };
      for (const fn of functions) {
        assert.equal(fn.args, argTypes[fn.proname]); assert.equal(fn.prosecdef, true);
        assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp')); assert.equal(fn.public_execute, false);
        for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db,
          'SELECT has_function_privilege($1,$2::oid,\'EXECUTE\')', [role, fn.oid]), role !== 'service_role');
      }
      for (const signature of ['private.employee_transfer_cutover_lock()', 'private.employee_transfer_source_cutoff()',
        'private.employee_transfer_site_snapshot_v1(uuid,uuid)']) {
        for (const role of ['anon', 'authenticated', 'service_role']) {
          assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [role, signature]), false);
          const invocation = signature.includes('uuid') ? 'private.employee_transfer_site_snapshot_v1(NULL,NULL)' : signature;
          await assert.rejects(statement(db, () => db.exec(`SELECT ${invocation}`), role), /permission denied/);
        }
        assert.equal(await scalar(db, `SELECT EXISTS(SELECT 1 FROM pg_proc p,aclexplode(p.proacl) a
          WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE')`, [signature]), false);
      }
      assert.equal((await rpc(STATUS, { p_admin_session_token: session }, 'authenticated')).frozen, false);
    });

    await scenario('STATIC: every explicit SQL56 table/row lock is NOWAIT and every advisory acquisition is try-lock; not PG concurrency', async () => {
      const sql = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8');
      const locks = sql.match(/LOCK TABLE\s+[^;]+;/g) ?? [];
      assert.equal(locks.length, 2);
      for (const lock of locks) assert.match(lock, /\bNOWAIT\b/);
      assert.doesNotMatch(sql, /\bpg_advisory_(?:xact_)?lock(?:_shared)?\s*\(/);
      assert.doesNotMatch(sql, /\bFOR (?:UPDATE|SHARE|NO KEY UPDATE|KEY SHARE)\b(?!\s+NOWAIT)/);
      assert.equal((sql.match(/pg_try_advisory_xact_lock\(/g) ?? []).length, 4);
      const lock = await scalar(db, `SELECT pg_get_functiondef('private.employee_transfer_cutover_lock()'::regprocedure)`);
      const markers = ["'employee-transfer-source-cutover'", 'LOCK TABLE private.employee_transfer_jobs',
        "'notification_automation_queue'", 'ACCESS EXCLUSIVE MODE NOWAIT', "'employee-transfer-maintenance'"];
      assert.deepEqual(markers.map(marker => lock.indexOf(marker)), markers.map(marker => lock.indexOf(marker)).sort((a, b) => a - b));
      assert.ok(markers.every(marker => lock.includes(marker))); assert.match(lock, /read committed/);
      for (const name of [FREEZE, RESUME]) {
        const fn = functionsFor(name);
        assert.match(await scalar(db, 'SELECT pg_get_functiondef($1::regprocedure)', [fn]), /employee_transfer_cutover_lock\(\)/);
      }
      function functionsFor(name) { return `public.${name}(${name === FREEZE ? 'uuid,text,text' : 'uuid,text,text,uuid'})`; }
    });

    await scenario('all cutover RPCs reject secondary/emergency/employee/unknown sessions without changes', async () => {
      for (const token of [branch, emergency, employeeSession, randomUUID(), null]) {
        const before = await state();
        for (const [name, args] of [[STATUS, {}], [FREEZE, { p_admin_password: PASSWORDS.root, p_confirmation: FREEZE_CONFIRM }],
          [RESUME, { p_admin_password: PASSWORDS.root, p_confirmation: RESUME_CONFIRM, p_cutoff_id: randomUUID() }]]) {
          await assert.rejects(rpc(name, { p_admin_session_token: token, ...args }), /administrator|session|expired/i);
        }
        assert.deepEqual(await state(), before);
      }
    });

    await scenario('an actually expired admin session cannot status/freeze/resume', async () => {
      await db.query(`UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second'
        WHERE token_hash=private.hash_financial_token($1)`, [session]);
      const before = await state();
      await assert.rejects(status(), /invalid or expired/i);
      await assert.rejects(freeze(), /invalid or expired/i);
      await assert.rejects(resume(randomUUID()), /invalid or expired/i);
      assert.deepEqual(await state(), before);
    });

    await scenario('wrong passwords persist rate-limit evidence; wrong/null confirmations never freeze or resume', async () => {
      const before = await business();
      assert.equal((await freeze({ p_admin_password: 'wrong-local-password' })).success, false);
      assert.equal(await scalar(db, "SELECT failed_attempts FROM public.financial_login_attempts WHERE username='root' AND account_type='admin'"), 1);
      assert.equal((await status()).frozen, false); assert.deepEqual(await business(), before);
      for (const confirmation of [null, '', '确认暂停旧站业务并导出', RESUME_CONFIRM]) await assert.rejects(freeze({ p_confirmation: confirmation }), /confirmation/i);
      const cutoff = await freezeReady(), m = await maintenance(db), job = await frozenJob(cutoff.cutoff_id);
      assert.equal((await resume(cutoff.cutoff_id, { p_admin_password: 'wrong-local-password' })).success, false);
      for (const confirmation of [null, '', '确认恢复旧站业务并放弃切站', FREEZE_CONFIRM]) await assert.rejects(resume(cutoff.cutoff_id, { p_confirmation: confirmation }), /confirmation/i);
      assert.equal(await maintenance(db), m); assert.equal(await frozenJob(cutoff.cutoff_id), job); await assertFrozen();
    });

    for (const kind of ['pending_automation', 'failed_automation', 'processing_orders', 'combined']) {
      await scenario(`real ${kind} blocks freeze and preserves all records, progress and money`, async () => {
        let orderId;
        if (kind === 'pending_automation' || kind === 'combined') {
          await enqueue(); assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_queue'), 1);
        }
        if (kind === 'failed_automation' || kind === 'combined') {
          // Deliberately fail the actual worker's progress UPDATE, rather than inserting
          // synthetic failures or replacing its return value. The worker retains its queue.
          await db.exec(`ALTER TABLE public.notification_automation_progress ADD CONSTRAINT cutover_fixture_metric_failure
            CHECK (task_id <> '${TASK}'::uuid OR last_metric < 0) NOT VALID`);
          await enqueue(); assert.equal((await worker()).processed_users, 1);
          assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_failures'), 1);
          assert.equal(await scalar(db, 'SELECT attempts FROM public.notification_automation_queue WHERE user_id=$1', [U]), 1);
        }
        if (kind === 'processing_orders' || kind === 'combined') orderId = await order();
        const before = await business();
        const s = await status(), result = await freeze();
        assert.equal(result.frozen, false); assert.equal(result.cutoff, null); assert.equal(result.full_site_complete, false);
        assert.deepEqual(result.counts, s.counts); assert.deepEqual(result.blockers, s.blockers);
        assert.ok(result.blockers.includes(kind === 'combined' ? 'processing_orders' : kind));
        if (kind === 'combined') assert.deepEqual(result.blockers, ['pending_automation', 'failed_automation', 'processing_orders']);
        if (orderId) assert.equal(await scalar(db, 'SELECT status FROM public.orders WHERE id=$1', [orderId]), 'processing');
        assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_jobs'), 0);
        assert.equal(await maintenance(db), undefined); assert.deepEqual(await business(), before);
      });
    }

    await scenario('a real running export blocks freeze, without cancellation or cleanup', async () => {
      const job = await sharedBegin(), before = await state();
      assert.deepEqual((await freeze()).blockers, ['transfer_running']);
      assert.equal((await status()).frozen, false); assert.deepEqual(await state(), before);
      assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [job.job_id]), 'running');
    });

    await scenario('normal business produces queue; real worker drains it, then freeze is idempotent and changes no business data', async () => {
      const originalSessions = await scalar(db, 'SELECT count(*)::int FROM public.work_sessions');
      await enqueue();
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_queue'), 1);
      assert.equal((await freeze()).frozen, false);
      const processed = await worker(); assert.equal(processed.success, true); assert.equal(processed.processed_users, 1);
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_queue'), 0);
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.work_sessions'), originalSessions + 1);
      const before = await business(), triggers = await triggerState(db);
      const cutoff = await freezeReady();
      assert.equal(cutoff.policy, 'drained-queue-v1'); assert.match(cutoff.frozen_at, /^\d{4}-\d\d-\d\dT.*\.\d{6}Z$/);
      assert.equal(cutoff.site_id, await scalar(db, 'SELECT site_id::text FROM private.employee_transfer_site'));
      assert.equal(cutoff.cutoff_hash, await scalar(db, `SELECT encode(extensions.digest(convert_to(($1::jsonb-'cutoff_hash')::text,'UTF8'),'sha256'),'hex')`, [JSON.stringify(cutoff)]));
      const job = JSON.parse(await frozenJob(cutoff.cutoff_id));
      assert.equal(job.kind, 'export'); assert.equal(job.status, 'finished'); assert.equal(job.admin_id, NEW.root);
      assert.equal(job.options.export_protocol, 'source-cutover-v1'); assert.deepEqual(job.summary.source_cutover, cutoff);
      const m = JSON.parse(await maintenance(db)); assert.equal(m.dirty, false); assert.equal(m.job_id, cutoff.cutoff_id);
      assert.equal(m.target_hash, cutoff.cutoff_hash); assert.equal(m.plan_hash, cutoff.cutoff_hash);
      const after = await state();
      assert.deepEqual((await freeze()).cutoff, cutoff); assert.deepEqual((await freeze()).cutoff, cutoff);
      assert.deepEqual(await state(), after, 'repeated freezes must not change jobs, audit, sessions or maintenance');
      assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_events WHERE action='source_cutover_frozen'"), 1);
      assert.deepEqual(await business(), before); assert.deepEqual(await triggerState(db), triggers); await assertFrozen();
    });

    await scenario('every guarded relation blocks INSERT/UPDATE/DELETE/TRUNCATE and real financial/queue entry points', async subtest => {
      const cutoff = await freezeReady(), before = await business(), triggers = await triggerState(db);
      const columns = await rows(db, `SELECT n.nspname||'.'||c.relname AS name,min(a.attname::text) AS column
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE n.nspname IN ('public','private') AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated=''
        GROUP BY n.nspname,c.relname`);
      for (const name of guarded) {
        const table = relation(name), column = columns.find(row => row.name === name)?.column;
        assert.ok(column, name);
        for (const sql of [`INSERT INTO ${table} DEFAULT VALUES`, `UPDATE ${table} SET ${quote(column)}=${quote(column)} WHERE false`,
          `DELETE FROM ${table} WHERE false`, `TRUNCATE TABLE ${table} CASCADE`]) {
          await blocked(() => db.exec(sql));
        }
      }
      await blocked(() => db.query("UPDATE public.users SET remarks='must not change' WHERE id=$1", [U]));
      await blocked(() => rpc('admin_adjust_wallet_balance_atomic', { p_admin_session_token: session, p_user_id: U,
        p_amount: '1', p_remarks: 'Must be blocked', p_operation_id: randomUUID() }));
      await blocked(() => scalar(db, 'SELECT private.queue_notification_automation_user($1)', [U]));
      await blocked(() => db.query('INSERT INTO public.notification_automation_queue(user_id) VALUES($1)', [U]));
      assert.deepEqual(await business(), before); assert.deepEqual(await triggerState(db), triggers);
      assert.equal((await assertFrozen()).cutoff.cutoff_id, cutoff.cutoff_id);
      subtest.diagnostic(`${guarded.length} relations x 4 write operations blocked by actual SQLSTATE 55000 guards`);
    });

    await scenario('a genuine due annual task cannot be queued by cron scheduling or worker while frozen', async () => {
      // Initial business fixture only, before freezing. No runtime trigger is disabled.
      await db.query(`INSERT INTO public.notification_automation_tasks(id,owner_admin_id,plan_id,name,status,trigger_type,
        trigger_mode,threshold_value,recipient_scope,annual_month,annual_day,title_template,content_template,activated_at,starts_at)
        VALUES($1,$2,$3,'Cutover annual task','active','annual_date','reach_once',1,'selected',
          extract(month FROM clock_timestamp() AT TIME ZONE 'UTC')::int,extract(day FROM clock_timestamp() AT TIME ZONE 'UTC')::int,
          'Annual title','Annual body','2020-01-01','2020-01-01')`, [ANNUAL, NEW.root, PLAN]);
      assert.equal(await scalar(db, `SELECT private.automation_task_applies_to_user(t,$2) FROM public.notification_automation_tasks t WHERE id=$1`, [ANNUAL, U]), true);
      await freezeReady(); const before = await business();
      await blocked(() => scalar(db, 'SELECT private.queue_annual_date_automation_users()'));
      await blocked(() => scalar(db, 'SELECT public.process_notification_automation_queue(10)'));
      // CALL with p_schedule_annual=true reaches the write guard before its first COMMIT.
      await blocked(() => db.exec('CALL private.run_notification_automation_queue(10,true)'));
      assert.deepEqual(await business(), before); await assertFrozen();
    });

    await scenario('existing shared export can begin/page/verify/close after freeze without releasing source or mutating business', async () => {
      const cutoff = await freezeReady(), before = await business();
      const job = await sharedBegin(); assert.equal(job.success, true);
      await assert.rejects(rpc('employee_export_shared_close', auth(job)), /not been verified/i);
      for (const key of SHARED) {
        const page = await rpc('get_employee_export_shared_page', { ...auth(job), p_table_key: key, p_limit: 200 });
        assert.equal(page.sha256, sha(page.ndjson));
      }
      assert.equal((await rpc('employee_export_shared_verify', auth(job))).verified, true);
      assert.equal((await rpc('employee_export_shared_close', auth(job))).success, true);
      assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [job.job_id]), 'finished');
      assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [job.job_id]), 0);
      assert.equal((await assertFrozen()).cutoff.cutoff_id, cutoff.cutoff_id); assert.deepEqual(await business(), before);
    });

    await scenario('frozen snapshot binds exact cutoff proof; source readbacks neither alter accounts/progress/money nor automatically resume', async () => {
      const cutoff = await freezeReady(), packageId = randomUUID(), before = await state();
      const s = await snapshot(packageId); assert.deepEqual(s.source_cutover, cutoff);
      assert.equal(s.full_site_complete, false); assert.equal(s.import_ready, false);
      assert.equal(s.sha256, await scalar(db, "SELECT encode(extensions.digest(convert_to($1::jsonb::text,'UTF8'),'sha256'),'hex')", [JSON.stringify(s.catalogs)]));
      assert.deepEqual(await snapshot(packageId), s); assert.deepEqual(await state(), before);
      await db.query("UPDATE private.employee_transfer_jobs SET started_at=now()-interval '2 days',last_activity_at=now()-interval '2 days' WHERE id=$1", [cutoff.cutoff_id]);
      await rpc('get_employee_transfer_log', { p_admin_session_token: session });
      assert.equal((await assertFrozen()).cutoff.cutoff_id, cutoff.cutoff_id);
      assert.equal(Object.hasOwn(JSON.parse(await frozenJob(cutoff.cutoff_id)).summary, 'source_resumed_at'), false);
      await blocked(() => db.exec('DELETE FROM public.work_sessions WHERE false'));
    });

    await scenario('generic cancellation, stop-owned and leave-maintenance cannot release a source freeze', async () => {
      const cutoff = await freezeReady(), job = await sharedBegin();
      assert.equal((await cancel(job)).cancelled, true); const m = await maintenance(db), metadata = await frozenJob(cutoff.cutoff_id);
      assert.equal((await cancel({ job_token: randomUUID() })).cancelled, false);
      await assert.rejects(rpc('employee_export_stop_owned', { p_admin_session_token: session, p_admin_password: PASSWORDS.root,
        p_confirmation: '確認停止導出任務', p_job_id: cutoff.cutoff_id }), /cannot be stopped/i);
      await assert.rejects(rpc('employee_transfer_leave_maintenance', { p_admin_session_token: session, p_admin_password: PASSWORDS.root,
        p_confirmation: '確認取消尚未寫入的遷移', p_job_id: cutoff.cutoff_id }), /target changed|blocked/i);
      assert.equal(await maintenance(db), m); assert.equal(await frozenJob(cutoff.cutoff_id), metadata); await assertFrozen();
    });

    await scenario('resume requires original super-admin, exact non-null cutoff and no running export, with no partial changes', async () => {
      const cutoff = await freezeReady();
      for (const extra of [{ p_admin_session_token: otherSession }, { p_cutoff_id: randomUUID() }, { p_cutoff_id: null }]) {
        const before = await state();
        await assert.rejects(resume(cutoff.cutoff_id, extra), /original source owner|original frozen source cutoff/i);
        assert.deepEqual(await state(), before); await assertFrozen();
      }
      const job = await sharedBegin(), before = await state();
      await assert.rejects(resume(cutoff.cutoff_id), /original source owner.*export task/i);
      assert.deepEqual(await state(), before); assert.equal((await status()).blockers.includes('transfer_running'), true);
      assert.equal((await rpc('employee_export_shared_verify', auth(job))).verified, true);
      await rpc('employee_export_shared_close', auth(job));
      assert.equal((await resume(cutoff.cutoff_id)).frozen, false);
    });

    await scenario('explicit resume restores business/real worker, marks old freeze resumed and does not reuse it automatically', async () => {
      const before = await business(), cutoff = await freezeReady();
      const result = await resume(cutoff.cutoff_id);
      assert.equal(result.success, true); assert.equal(result.frozen, false); assert.equal(result.cutoff, null);
      assert.equal(result.full_site_complete, false); assert.equal(await maintenance(db), undefined);
      assert.deepEqual(await business(), before, 'resume itself must not toggle accounts, automation, progress or money');
      assert.equal(await scalar(db, 'SELECT status FROM public.notification_automation_plans WHERE id=$1', [PAUSED_PLAN]), 'paused');
      assert.equal(await scalar(db, 'SELECT status FROM public.notification_automation_tasks WHERE id=$1', [PAUSED_TASK]), 'paused');
      const old = JSON.parse(await frozenJob(cutoff.cutoff_id));
      assert.equal(old.status, 'finished'); assert.deepEqual(old.summary.source_cutover, cutoff); assert.ok(old.summary.source_resumed_at);
      assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_events WHERE action='source_cutover_resumed'"), 1);
      await assert.rejects(resume(cutoff.cutoff_id), /original frozen source cutoff/i);
      assert.equal(Object.hasOwn(await snapshot(randomUUID()), 'source_cutover'), false);
      await db.query("UPDATE public.users SET remarks='business resumed' WHERE id=$1", [U]);
      await enqueue(); assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.notification_automation_queue'), 1);
      assert.equal((await worker()).processed_users, 1); assert.equal((await status()).frozen, false);
      const next = await freezeReady(); assert.notEqual(next.cutoff_id, cutoff.cutoff_id);
      assert.deepEqual(JSON.parse(await frozenJob(cutoff.cutoff_id)), old, 'a new explicit freeze must retain old resumed metadata');
    });

    await scenario('real backed-up import creates dirty maintenance; source resume/freeze and generic cancellation cannot release it', async () => {
      const packageId = randomUUID();
      const shared = await capture('shared', SHARED, packageId), dispatch = await capture('dispatch', DISPATCH, packageId);
      const sharedImport = await prepare('shared', shared); await backup('shared', sharedImport.job, sharedImport.plan);
      assert.equal((await on(target, 'employee_import_shared_replace_apply', { ...auth(sharedImport.job, targetSession), p_plan_hash: sharedImport.plan.plan_hash })).success, true);
      assert.equal((await cancel(sharedImport.job, target, targetSession)).cancelled, true);
      const imported = await prepare('dispatch', dispatch); await backup('dispatch', imported.job, imported.plan);
      assert.equal((await on(target, 'employee_import_dispatch_enter_maintenance', { ...auth(imported.job, targetSession), p_plan_hash: imported.plan.plan_hash,
        p_admin_password: PASSWORDS.root, p_confirmation: '確認暫停業務並導入派單資料' })).success, true);
      const config = await on(target, 'get_employee_import_dispatch_configuration_plan', auth(imported.job, targetSession));
      assert.equal(config.can_apply_configuration, true, JSON.stringify(config));
      assert.equal((await on(target, 'employee_import_dispatch_apply_configuration', { ...auth(imported.job, targetSession), p_plan_hash: config.plan_hash })).configuration_applied, true);
      assert.equal(await scalar(target, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
      // End the running import naturally; dirty protection must still hold without a
      // transfer_running blocker. Nothing deletes business to make this test pass.
      assert.equal((await cancel(imported.job, target, targetSession)).cancelled, true);
      const m = await maintenance(target), before = await digest(target, allData);
      const result = await on(target, FREEZE, { p_admin_session_token: targetSession, p_admin_password: PASSWORDS.root, p_confirmation: FREEZE_CONFIRM });
      assert.equal(result.frozen, false); assert.deepEqual(result.blockers, ['other_maintenance']);
      await assert.rejects(on(target, RESUME, { p_admin_session_token: targetSession, p_admin_password: PASSWORDS.root,
        p_confirmation: RESUME_CONFIRM, p_cutoff_id: imported.job.job_id }), /original frozen source cutoff/i);
      await assert.rejects(on(target, 'employee_transfer_leave_maintenance', { p_admin_session_token: targetSession, p_admin_password: PASSWORDS.root,
        p_confirmation: '確認取消尚未寫入的遷移', p_job_id: imported.job.job_id }), /committed writes.*cannot be cancelled/i);
      assert.equal(await maintenance(target), m); assert.deepEqual(await digest(target, allData), before);
      await blocked(() => target.exec('DELETE FROM public.users WHERE false'), target);
    });
    assert.equal(networkCalls, 0); t.diagnostic('Network calls: 0. PGlite is single-connection; NOWAIT/try-lock checks are static, not native PG concurrency validation.');
  } finally {
    // Only rollback local case transactions and close in-memory databases. No cleanup
    // function deletes real business or conceals a failed freeze/import prerequisite.
    try { if (db) await db.exec('ROLLBACK'); } finally {
      try { if (target) await target.exec('ROLLBACK'); } finally {
        try { await Promise.all([db?.close(), target?.close()]); } finally { network.mock.restore(); }
      }
    }
  }
});
