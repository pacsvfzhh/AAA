import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createSites, adminLogin, rpc as baseRpc, scalar, rows } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

const migration = '20261102000009_export_dispatch_submission_data.sql';
const hash = value => createHash('sha256').update(value).digest('hex');
const id = n => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const keys = ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders',
  'dispatch_group_members', 'valid_order_data', 'used_order_data'];
const names = ['employee_export_dispatch_begin', 'get_employee_export_dispatch_page',
  'employee_export_dispatch_verify', 'employee_export_dispatch_close', 'get_employee_import_dispatch_preflight'];
let source, target, session, targetSession, branch, sourceGroup, sourcePool, modules, sequence = 0;
async function transaction(fn, db = source) {
  await db.exec('BEGIN');
  try { return await fn(); } finally { await db.exec('ROLLBACK'); }
}
async function isolated(db, fn) {
  const savepoint = `dispatch_test_${++sequence}`;
  await db.exec(`SAVEPOINT ${savepoint}`);
  try {
    await db.exec('SET LOCAL ROLE anon');
    const result = await fn();
    await db.exec(`RESET ROLE; RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
const rpc = (name, args, db = source) => isolated(db, () => baseRpc(db, name, args, { role: null }));
const auth = job => ({ p_admin_session_token: session, p_job_token: job.job_token });
const begin = (token = session, password = PASSWORDS.root) => rpc('employee_export_dispatch_begin', {
  p_admin_session_token: token, p_admin_password: password,
});
const page = (job, key, after = null, limit = 200) => rpc('get_employee_export_dispatch_page', {
  ...auth(job), p_table_key: key, p_after: after, p_limit: limit,
});
const verify = job => rpc('employee_export_dispatch_verify', auth(job));
const close = job => rpc('employee_export_dispatch_close', auth(job));
async function capture(job, key, limit = 200) {
  let text = '', after = null, count = 0, calls = 0;
  do {
    const value = await page(job, key, after, limit);
    assert.equal(value.table_key, key);
    assert.equal(hash(value.ndjson), value.sha256);
    assert.ok(value.count <= limit);
    assert.ok(Buffer.byteLength(value.ndjson) <= 262144);
    text += value.ndjson; count += value.count; after = value.next_after; calls++;
  } while (after !== null);
  const expected = job.catalog.tables.find(item => item.key === key);
  assert.equal(count, expected.rows);
  assert.equal(Buffer.byteLength(text), expected.bytes);
  assert.equal(hash(text.match(/[^\n]*\n/g)?.map(line => hash(line)).join('') ?? ''), expected.row_hashes_sha256);
  return { text, count, calls, values: text.trim() ? text.trimEnd().split('\n').map(line => JSON.parse(line)) : [] };
}
async function preflight() {
  return rpc('get_employee_import_dispatch_preflight', { p_admin_session_token: targetSession }, target);
}
async function createEmployee(db, number = 1) {
  await db.query(`INSERT INTO public.users(id,username,password_hash,employee_id,created_by,is_active)
    VALUES($1,$2,'unused-password-hash',$3,$4,false)`, [id(number), `dispatch-employee-${number}`, `D-${number}`, NEW.root]);
}
async function createOrder(db, status = 'failure') {
  await db.query(`INSERT INTO public.product_types(id,name) VALUES($1,'Dispatch fixture product')`, [id(900)]);
  await db.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status)
    VALUES($1,$2,'dispatch-employee-1',$3,1,'local-order','local-order-tx',$4)`, [id(901), id(1), id(900), status]);
}

before(async () => {
  const sites = await createSites({ upTo: migration });
  source = sites.oldSite; target = sites.newSite;
  assert.equal(sites.files.length, 536);
  assert.equal(sites.failures.length, 12);
  assert.ok(!sites.failures.some(item => item.file === migration));
  await target.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  await buildNewSite(source); await buildNewSite(target);
  session = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(source, 'branch', PASSWORDS.branch);
  targetSession = await adminLogin(target, 'root', PASSWORDS.root);
  sourceGroup = await scalar(source, 'SELECT id FROM public.dispatch_groups WHERE is_default');
  await source.query(`UPDATE public.dispatch_groups SET group_name='來源默認組',description='來源，不是新站預設',
    dispatch_interval_min=7,dispatch_interval_max=9,session_timeout_minutes=3,dispatch_order_mode='sequential',
    dispatch_success_rate=37,pool_selection_mode='weighted',submit_wait_min_seconds=11,submit_wait_max_seconds=18,
    commission_rate=0.12345678,withdrawal_amount_threshold=123.45,withdrawal_orders_threshold=17,
    withdrawal_condition_mode='AND',grab_success_rate=63 WHERE id=$1`, [sourceGroup]);
  sourcePool = await scalar(source, 'SELECT id FROM public.dispatch_order_pools WHERE group_id=$1 AND is_base', [sourceGroup]);
  await source.query(`UPDATE public.dispatch_order_pools SET pool_name='舊站真正默認池',dispatch_interval_min=15,
    dispatch_interval_max=19,session_timeout_minutes=2,dispatch_order_mode='sequential',dispatch_success_rate=29,
    trigger_probability=70,created_by=$2 WHERE id=$1`, [sourcePool, NEW.root]);
  await source.query(`INSERT INTO public.dispatch_order_pools(id,group_id,pool_name,trigger_probability,created_by)
    VALUES($1,$2,'來源第二池',30,$3)`, [id(100), sourceGroup, NEW.root]);
  await createEmployee(source);
  await source.query(`INSERT INTO public.dispatch_group_members(id,group_id,user_id,assigned_by,assigned_at)
    VALUES($1,$2,$3,$4,'2026-09-01T01:02:03.123456Z')`, [id(101), sourceGroup, id(1), NEW.root]);
  await source.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,created_by)
    SELECT ('20000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,$1,$2,
      '來源池資料：保留交單原文 𠮷 '||n,$3 FROM generate_series(1,413) AS n`, [sourceGroup, sourcePool, NEW.root]);
  await createOrder(source);
  await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by,usage_count,tags,priority)
    VALUES($1,12345678901234567890.123456789,'原文-é-𠮷',$2,6,ARRAY['來源','已用'],9)`, [id(102), NEW.root]);
  await source.query(`INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at)
    VALUES($1,$2,$3,$4,'2026-09-02T01:02:03.123456Z')`, [id(103), id(1), id(102), id(901)]);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const output = await build({
    stdin: { contents: `export * from './src/lib/employeeTransfer/api.ts';
      export * from './src/lib/employeeTransfer/dispatchTransfer.ts';
      export { setHarness } from 'dispatch-test:state';`, resolveDir: root, sourcefile: 'dispatch-db-entry.mjs' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020',
    plugins: [{ name: 'local-dispatch-rpc', setup(builder) {
      builder.onResolve({ filter: /^dispatch-test:state$/ }, () => ({ path: 'state', namespace: 'dispatch-test' }));
      builder.onResolve({ filter: /^\.\.\/(auth|supabase)$/ }, args => {
        assert.equal(args.importer, `${root}src/lib/employeeTransfer/api.ts`);
        return { path: args.path.slice(3), namespace: 'dispatch-test' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'dispatch-test' }, ({ path }) => ({ contents: path === 'state'
        ? 'let h; export const setHarness = v => { h=v; }; export const current = () => h;'
        : path === 'auth' ? `import { current } from 'dispatch-test:state'; export const getAdminFinancialSessionToken = () => current().token;`
          : `import { current } from 'dispatch-test:state'; export const supabase={rpc:(...args)=>current().rpc(...args)}; export const formatSupabaseError=e=>e.message;` }));
    } }],
  });
  modules = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
});
after(async () => { await Promise.all([source?.close(), target?.close()]); });

test('seven fixed tables export complete source default identity, settings, content and usage', () => transaction(async () => {
  const job = await begin();
  assert.equal(job.scope, 'dispatch-submission'); assert.equal(job.full_site_complete, false);
  assert.deepEqual(job.catalog.tables.map(item => item.key), keys);
  for (const key of keys) {
    const actual = await capture(job, key, 37);
    const expected = await rows(source, `SELECT to_jsonb(r) AS body FROM public.${key} AS r ORDER BY id`);
    assert.deepEqual(actual.values, expected.map(row => row.body), key);
  }
  const exported = await capture(job, 'valid_order_data');
  assert.match(exported.text, /12345678901234567890\.123456789/);
  assert.equal(exported.values[0].usage_count, 7, 'retained usage may exceed surviving used rows; never recompute it');
  const pools = (await capture(job, 'dispatch_order_pools')).values;
  assert.equal(pools.find(pool => pool.id === sourcePool).trigger_probability, 70);
  assert.equal(pools.find(pool => pool.id === sourcePool).is_base, true);
  assert.equal((await capture(job, 'dispatch_group_orders')).calls, 3);
  assert.equal((await verify(job)).verified, true);
  const state = await scalar(source, `SELECT status FROM private.employee_transfer_jobs WHERE id=$1`, [job.job_id]);
  assert.equal(state, 'running', 'server verification does not imply files were saved');
  await close(job);
  assert.equal((await rpc('get_employee_transfer_log', { p_admin_session_token: session })).last_export_at, null);
}));

test('real bundled API calls anon SQL without reshaping responses; only acknowledged writes count as progress', () => transaction(async () => {
  const trace = [], stored = new Map(), progress = [];
  modules.setHarness({ token: session, rpc(name, args) {
    assert.ok(names.includes(name)); assert.equal(args.p_admin_session_token, session);
    trace.push(name);
    const query = { abortSignal() { return query; }, async then(resolve, reject) {
      try { return resolve({ data: await rpc(name, args), error: null }); }
      catch (error) { return reject(error); }
    } };
    return query;
  } });
  const task = await modules.beginDispatchExport(PASSWORDS.root);
  task.catalog.tables[0].rows = 999999;
  const result = await modules.exportDispatchData(task.source, {
    async append(path, chunk) {
      if (!stored.has(path)) stored.set(path, []);
      stored.get(path).push(Buffer.from(chunk));
    }, async abort() { assert.fail('valid export must not abort'); },
  }, { onProgress(value) { progress.push(value); } });
  assert.equal(result.fullSiteComplete, false);
  assert.equal(result.entries.length, 7);
  assert.equal(progress.at(-1).bytes, result.bytes);
  for (const entry of result.entries) assert.equal(hash(Buffer.concat(stored.get(entry.path))), entry.sha256);
  assert.equal(trace.filter(name => name === 'get_employee_export_dispatch_page').length, 9);
  assert.ok(!trace.includes('employee_export_dispatch_close'));
  assert.deepEqual(await task.close(), { success: true, scope: 'dispatch-submission', full_site_complete: false });
}));

for (const mutate of [
  () => source.query('UPDATE public.dispatch_order_pools SET dispatch_success_rate=30 WHERE id=$1', [sourcePool]),
  () => source.query("UPDATE public.dispatch_group_orders SET order_content='same count changed body' WHERE id=(SELECT id FROM public.dispatch_group_orders ORDER BY id LIMIT 1)"),
  () => source.query("UPDATE public.valid_order_data SET transaction_id='changed-content' WHERE id=$1", [id(102)]),
  () => source.query('UPDATE public.used_order_data SET created_at=created_at+interval \'1 second\' WHERE id=$1', [id(103)]),
  () => source.query('DELETE FROM public.dispatch_group_members WHERE id=$1', [id(101)]),
]) test('source content or membership change invalidates export even when totals can remain equal', () => transaction(async () => {
  const job = await begin(); await mutate();
  await assert.rejects(verify(job), /source changed/);
}));

for (const [key, after, limit] of [['orders', null, 200], ["dispatch_groups;DELETE FROM users", null, 200],
  ['dispatch_groups', null, 0], ['dispatch_groups', null, 201], ['dispatch_groups', randomUUID(), 200]]) {
  test(`reject invalid dispatch page boundary ${key}/${limit}`, () => transaction(async () => {
    const job = await begin(); await assert.rejects(page(job, key, after, limit), /Unknown|Invalid|disappeared/);
  }));
}

test('page bytes are bounded independently of row count, UTF-8 lines round trip', () => transaction(async () => {
  await source.exec("UPDATE public.dispatch_group_orders SET order_content=repeat('𠮷',5000)");
  const job = await begin(); const first = await page(job, 'dispatch_group_orders');
  assert.ok(first.count < 200); assert.ok(first.count > 0); assert.ok(Buffer.byteLength(first.ndjson) <= 262144);
  assert.equal((await capture(job, 'dispatch_group_orders')).count, 413);
}));

test('12,000 submission rows stream through keyset pages without changing usage or audit data', { timeout: 180000 }, () => transaction(async () => {
  await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by)
    SELECT ('30000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,12.34,'large-'||n,$1 FROM generate_series(1,12000) n`, [NEW.root]);
  const before = await scalar(source, 'SELECT count(*) FROM public.bulk_import_log');
  const job = await begin(); const result = await capture(job, 'valid_order_data');
  assert.equal(result.count, 12001); assert.ok(result.calls > 60);
  await verify(job);
  assert.equal(await scalar(source, 'SELECT count(*) FROM public.bulk_import_log'), before);
}));

for (const [label, change, pattern] of [
  ['missing default', () => source.exec('UPDATE public.dispatch_groups SET is_default=false'), /default.*ambiguous/],
  ['multiple defaults', () => source.query('UPDATE public.dispatch_groups SET is_default=true WHERE id=$1', [NEW.groupA]), /default.*ambiguous/],
  ['invalid probabilities', () => source.query('UPDATE public.dispatch_order_pools SET trigger_probability=69 WHERE id=$1', [sourcePool]), /probabilities/],
  ['unknown setting', () => source.exec("INSERT INTO public.dispatch_config(config_key,config_value) VALUES('api_secret','not-for-export')"), /configuration/],
  ['invalid setting', () => source.exec("UPDATE public.dispatch_config SET config_value='0' WHERE config_key='session_timeout_minutes'"), /configuration/],
  ['legacy content', () => source.exec("INSERT INTO public.dispatch_orders(order_content) VALUES('legacy original')"), /Legacy/],
  ['unfinished used order', async () => {
    await source.query(`INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status)
      VALUES($1,$2,'dispatch-employee-1',$3,1,'unfinished-linked','unfinished-linked','processing')`, [id(902), id(1), id(900)]);
    await source.query('UPDATE public.used_order_data SET order_id=$1', [id(902)]);
  }, /unfinished/],
  ['unknown column', () => source.exec('ALTER TABLE public.dispatch_groups ADD COLUMN unreviewed_secret text'), /schema/],
  ['changed nullability', () => source.exec('ALTER TABLE public.dispatch_groups ALTER COLUMN is_default SET NOT NULL'), /schema/],
  ['oversized row', () => source.query("UPDATE public.dispatch_group_orders SET order_content=repeat('x',65536) WHERE id=(SELECT id FROM public.dispatch_group_orders ORDER BY id LIMIT 1)"), /limits/],
]) test(`source preconditions fail closed: ${label}`, () => transaction(async () => {
  await change();
  await assert.rejects(begin(), pattern);
  assert.equal(await scalar(source, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status='running'"), 0);
}));

test('processing orders without a used-data dependency are counted, never exported as order details', () => transaction(async () => {
  await source.query(`INSERT INTO public.orders(user_id,username,product_type_id,product_value,order_number,transaction_id,status)
    VALUES($1,'dispatch-employee-1',$2,1,'processing-only','processing-only','processing')`, [id(1), id(900)]);
  const job = await begin(); assert.equal(job.catalog.processing_orders, 1);
  assert.ok(job.catalog.tables.every(item => !['orders', 'dispatch_assignments'].includes(item.key)));
}));

test('permission, password and task ownership boundaries are enforced', () => transaction(async () => {
  await assert.rejects(begin(branch, PASSWORDS.branch), /Super administrator/);
  await assert.rejects(begin(randomUUID()), /invalid or expired/);
  assert.equal((await begin(session, 'wrong-password')).success, false);
  const job = await begin();
  await assert.rejects(close(job), /not been verified/);
  await assert.rejects(rpc('get_employee_export_directory', auth(job)), /protocol/);
  await assert.rejects(rpc('employee_export_finish', { ...auth(job), p_summary: { full_site_complete: true } }), /protocol/);
  await assert.rejects(rpc('get_employee_export_products_page', auth(job)), /protocol/);
  await assert.rejects(rpc('get_employee_export_shared_page', { ...auth(job), p_table_key: 'admins' }), /protocol/);
  await assert.rejects(rpc('get_employee_export_dispatch_page', { ...auth(job), p_admin_session_token: branch, p_table_key: 'dispatch_groups' }), /Super administrator/);
  await source.exec("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours'");
  await assert.rejects(verify(job), /invalid or expired/);
}));

test('legacy initializer cannot forge any reserved protocol marker', () => transaction(async () => {
  for (const key of ['export_protocol', 'import_protocol', 'catalog', 'package_id']) {
    await assert.rejects(rpc('employee_export_begin', {
      p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_options: { [key]: 'dispatch-submission-v1' },
    }), /Reserved/);
  }
  const job = await rpc('employee_export_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  await assert.rejects(page(job, 'dispatch_groups'), /protocol/);
  assert.equal((await rpc('employee_transfer_cancel', auth(job))).cancelled, true);
}));

test('dispatch task cancellation works and removes access without touching business rows', () => transaction(async () => {
  const job = await begin(); const before = await scalar(source, 'SELECT count(*) FROM public.dispatch_group_orders');
  assert.equal((await rpc('employee_transfer_cancel', auth(job))).cancelled, true);
  await assert.rejects(verify(job), /invalid or expired/);
  assert.equal(await scalar(source, 'SELECT count(*) FROM public.dispatch_group_orders'), before);
}));

test('target preflight is read only and explicitly does not permit replacement yet', () => transaction(async () => {
  const before = await scalar(target, 'SELECT count(*) FROM private.employee_transfer_jobs');
  const result = await preflight();
  assert.equal(result.eligible_for_empty_target_mode, true); assert.equal(result.replacement_ready, false);
  assert.equal(result.full_site_complete, false); assert.deepEqual(result.blockers, []);
  assert.equal(await scalar(target, 'SELECT count(*) FROM private.employee_transfer_jobs'), before);
  assert.deepEqual(modules.validateDispatchPreflight(result), result);
}, target));

for (const [label, change, code] of [
  ['wallet funds', () => target.query('UPDATE public.wallets SET available_balance=1 WHERE user_id=$1', [id(1)]), 'wallet_funds'],
  ['employee income', () => target.query('UPDATE public.users SET total_income=1 WHERE id=$1', [id(1)]), 'income'],
  ['baseline funds', () => target.query('UPDATE public.wallet_balance_baselines SET available_balance=1 WHERE user_id=$1', [id(1)]), 'baseline_funds'],
  ['previous usage', () => target.query("INSERT INTO public.valid_order_data(product_value,transaction_id,created_by,usage_count) VALUES(1,'target-used',$1,1)", [NEW.root]), 'submission_usage'],
  ['previous use time', () => target.query("INSERT INTO public.valid_order_data(product_value,transaction_id,created_by,last_used_at) VALUES(1,'target-used',$1,now())", [NEW.root]), 'submission_usage'],
  ['offline session', () => target.query("INSERT INTO public.dispatch_sessions(user_id,status,ended_at) VALUES($1,'offline',now())", [id(1)]), 'dispatch_sessions'],
  ['actual orders', () => createOrder(target), 'orders'],
  ['legacy dispatch', () => target.exec("INSERT INTO public.dispatch_orders(order_content) VALUES('target legacy')"), 'legacy_dispatch_content'],
]) test(`empty target mode is blocked by ${label}`, () => transaction(async () => {
  await createEmployee(target); await change();
  const result = await preflight();
  assert.equal(result.eligible_for_empty_target_mode, false); assert.equal(result.replacement_ready, false);
  assert.ok(result.blockers.some(item => item.code === code && item.count > 0));
}, target));

test('ordinary unused target configuration is not mistaken for business history', () => transaction(async () => {
  await target.query("INSERT INTO public.valid_order_data(product_value,transaction_id,created_by) VALUES(1,'unused-target-content',$1)", [NEW.root]);
  const result = await preflight(); assert.equal(result.eligible_for_empty_target_mode, true);
  await assert.rejects(rpc('get_employee_import_dispatch_preflight', { p_admin_session_token: branch }, target), /invalid or expired/);
}, target));
