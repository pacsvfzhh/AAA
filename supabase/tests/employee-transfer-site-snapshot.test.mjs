import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, mock, test } from 'node:test';
import { assertExpectedReplayFailures, replayMigrations } from './support/replay-migrations.mjs';
import { adminLogin, rows, rpc as baseRpc, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Local real SQL, sessions, ACLs, RLS, catalog hashing and serial begin/page/verify/close.
// Historical platform substitutes remain; no network, actual Storage, native PG
// multi-connection concurrency, PostgREST timing or atomic full-site backup claim.
const PREVIOUS = '20261102000040_close_shared_export.sql';
const MIGRATION = '20261102000041_snapshot_site_export.sql';
const RPC = 'get_employee_export_site_snapshot';
const SIGNATURE = `public.${RPC}(uuid,uuid)`;
const DOMAINS = ['shared', 'products', 'dispatch', 'identity', 'finance', 'activity', 'verification', 'notifications', 'chat', 'archives'];
const SHARED = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
const PACKAGED = DOMAINS.slice(3);
const id = n => `41000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const I = { employee: id(1), product: id(2), message: id(3), customer: id(4), chat: id(5), login: id(6),
  verification: id(7), audit: id(8), adminGroup: id(9), adminMember: id(10), groupOrder: id(11), valid: id(12) };
const PACKAGE = id(100);
const TIME = '2024-02-29T03:04:05.123456Z';
const CANARY = 'LOCAL-SNAPSHOT-RAW-CONTENT-MUST-NOT-LEAK';
const sha = text => createHash('sha256').update(text).digest('hex');
const quote = value => '"' + value.replaceAll('"', '""') + '"';
let db, replay, session, branch, emergency, employeeToken, baseline;
let schemaBefore, schemaAfter, dataBefore, dataAfter, inside = false;

async function isolated(fn, mode = '') {
  await db.exec(`BEGIN ${mode}`); inside = true;
  try { return await fn(); } finally { inside = false; await db.exec('ROLLBACK'); }
}
async function call(name, args, role = 'anon') {
  assert.ok(['anon', 'authenticated', 'service_role', 'site_snapshot_untrusted'].includes(role));
  const owned = !inside;
  if (owned) await db.exec('BEGIN');
  await db.exec('SAVEPOINT snapshot_call');
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    const result = await baseRpc(db, name, args, { role: null });
    await db.exec('RESET ROLE; RELEASE SAVEPOINT snapshot_call');
    if (owned) await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT snapshot_call; RELEASE SAVEPOINT snapshot_call');
    if (owned) await db.exec('ROLLBACK');
    throw error;
  }
}
const snapshot = (args = {}, role) => call(RPC, { p_admin_session_token: session, p_package_id: PACKAGE, ...args }, role);
const auth = job => ({ p_admin_session_token: session, p_job_token: job.job_token });
async function dataState() {
  const relations = await rows(db, `SELECT n.nspname,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private','storage','cron') AND c.relkind IN ('r','p','S') ORDER BY 1,2`);
  return rows(db, relations.map(r => {
    const name = `${quote(r.nspname)}.${quote(r.relname)}`;
    const source = r.relkind === 'S' ? `(SELECT last_value,is_called FROM ${name})` : name;
    return `SELECT '${r.nspname}.${r.relname}' AS relation,md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n'
      ORDER BY to_jsonb(t)::text COLLATE "C"),'')) AS digest FROM ${source} t`;
  }).join(' UNION ALL '));
}
async function schemaState() {
  return {
    functions: await rows(db, `SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition,p.proacl::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','private') AND p.prokind='f'
        AND p.oid<>COALESCE(to_regprocedure($1),0::oid) ORDER BY signature`, [SIGNATURE]),
    relations: await rows(db, `SELECT c.oid::regclass::text AS relation,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,
      a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_value
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname IN ('public','private','storage','cron') ORDER BY relation,a.attnum`),
    triggers: await rows(db, `SELECT tgrelid::regclass::text AS relation,tgname,tgenabled,pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2`),
    policies: await rows(db, 'SELECT * FROM pg_policies ORDER BY schemaname,tablename,policyname'),
  };
}
// Privileged LOCAL fixture changes, not a migration/RPC write path. Restore exact
// trigger modes before invoking any catalog (maintenance/schema assertions stay real).
async function change(relation, sql, params = []) {
  await db.exec('SAVEPOINT snapshot_fixture');
  try {
    const triggers = await rows(db, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
    for (const t of triggers) await db.exec(`ALTER TABLE ${relation} DISABLE TRIGGER ${quote(t.tgname)}`);
    const result = await db.query(sql, params);
    for (const t of triggers) await db.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER ${quote(t.tgname)}`);
    await db.exec('RELEASE SAVEPOINT snapshot_fixture');
    return result;
  } catch (error) { await db.exec('ROLLBACK TO SAVEPOINT snapshot_fixture; RELEASE SAVEPOINT snapshot_fixture'); throw error; }
}
function exactKeys(value, expected) { assert.deepEqual(Object.keys(value).sort(), [...expected].sort()); }
function consistent(s, pkg = PACKAGE) {
  exactKeys(s, ['version', 'protocol', 'site_id', 'package_id', 'catalogs', 'sha256', 'full_site_complete', 'import_ready']);
  assert.equal(s.version, 1); assert.equal(s.protocol, 'site-bundle-set-v1'); assert.equal(s.package_id, pkg);
  assert.equal(s.full_site_complete, false); assert.equal(s.import_ready, false); assert.match(s.sha256, /^[0-9a-f]{64}$/);
  exactKeys(s.catalogs, DOMAINS);
  for (const [key, catalog] of Object.entries(s.catalogs)) {
    assert.equal(catalog.version, 1); assert.equal(catalog.site_id, s.site_id); assert.equal(catalog.full_site_complete, false);
    if (PACKAGED.includes(key)) assert.equal(catalog.package_id, pkg);
    else assert.equal(Object.hasOwn(catalog, 'package_id'), false);
    if (Object.hasOwn(catalog, 'identity_catalog')) assert.deepEqual(catalog.identity_catalog, s.catalogs.identity);
    if (Object.hasOwn(catalog, 'finance_catalog')) assert.deepEqual(catalog.finance_catalog, s.catalogs.finance);
  }
  for (const key of ['finance', 'activity', 'verification', 'notifications', 'chat']) {
    assert.deepEqual(s.catalogs[key].identity_catalog, s.catalogs.identity);
  }
  for (const key of ['notifications', 'chat']) assert.deepEqual(s.catalogs[key].finance_catalog, s.catalogs.finance);
}
const descriptor = (s, domain, key) => s.catalogs[domain].tables.find(t => t.key === key);
async function checkedRead() {
  const before = await dataState();
  const result = await snapshot(); consistent(result);
  assert.deepEqual(await dataState(), before, 'snapshot must not write any table, sequence, heartbeat, staging or event');
  return result;
}
async function begin(domain, pkg = PACKAGE) {
  const job = await call(`employee_export_${domain}_begin`, { p_admin_session_token: session, p_admin_password: PASSWORDS.root,
    ...(PACKAGED.includes(domain) ? { p_package_id: pkg } : {}) });
  assert.equal(job.success, true); return job;
}
async function exportStage(domain) {
  const job = await begin(domain);
  for (const table of job.catalog.tables) {
    let after = null, text = '', count = 0;
    do {
      const page = await call(`get_employee_export_${domain}_page`, { ...auth(job),
        ...(domain === 'products' ? {} : { p_table_key: table.key }), p_after: after, p_limit: 2 });
      assert.equal(page.sha256, sha(page.ndjson));
      text += page.ndjson; count += page.count; after = page.next_after;
    } while (after !== null);
    assert.equal(count, table.rows); assert.equal(Buffer.byteLength(text), table.bytes);
    if (table.sha256) assert.equal(sha(text), table.sha256);
    else assert.equal(sha((text.match(/[^\n]*\n/g) ?? []).map(sha).join('')), table.row_hashes_sha256);
  }
  assert.equal((await call(`employee_export_${domain}_verify`, auth(job))).verified, true);
  const close = await call(domain === 'products' ? 'employee_products_close' : `employee_export_${domain}_close`, auth(job));
  assert.equal(close.success, true); assert.equal(close.full_site_complete, false);
  assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [job.job_id]), 'finished');
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging WHERE job_id=$1', [job.job_id]), 0);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status='running'"), 0);
  return job.catalog;
}

before(async () => {
  mock.method(globalThis, 'fetch', () => assert.fail('Network/production/Storage access forbidden'));
  replay = await replayMigrations({ upTo: PREVIOUS, strict: true }); db = replay.db;
  schemaBefore = await schemaState(); dataBefore = await dataState();
  await db.exec(await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8'));
  schemaAfter = await schemaState(); dataAfter = await dataState();
  // The entire sorted replay INCLUDING SQL41 accepts exactly the fixed historical
  // failure file/message set, never a new allowlist inferred from this run.
  replay.files.push(MIGRATION);
  assertExpectedReplayFailures(replay, { upTo: MIGRATION });
  await buildNewSite(db);
  await db.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,remarks)
    VALUES($1,'snapshot_employee','SNAP-001',extensions.crypt($2,extensions.gen_salt('bf',4)),$3,$4)`,
  [I.employee, PASSWORDS.employee, NEW.root, CANARY]);
  await db.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [I.employee]);
  await db.query(`INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Snapshot product',true)`, [I.product]);
  await db.query(`INSERT INTO public.admin_groups(id,name,created_by) VALUES($1,'Snapshot shared group',$2)`, [I.adminGroup, NEW.root]);
  await db.query(`INSERT INTO public.admin_group_members(id,group_id,admin_id) VALUES($1,$2,$3)`, [I.adminMember, I.adminGroup, NEW.branch]);
  await db.query(`INSERT INTO public.admin_configs(admin_id,config_type,config_value) VALUES($1,'company_name',$2)
    ON CONFLICT(admin_id,config_type) DO UPDATE SET config_value=EXCLUDED.config_value`, [NEW.branch, CANARY]);
  await db.query(`INSERT INTO public.system_configs(key,value) VALUES('ios_config','{"excluded_secret":"local-only"}')
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
  await db.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,created_by)
    SELECT $1,group_id,id,$2,$3 FROM public.dispatch_order_pools WHERE group_id=$4 AND is_base`, [I.groupOrder, CANARY, NEW.root, NEW.groupA]);
  await db.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by) VALUES($1,12.345678901,'SNAP-VALID',$2)`, [I.valid, NEW.root]);
  await db.query(`INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,created_at,device_info)
    VALUES($1,$2,'snapshot_employee','SNAP-001','login',$3,NULL)`, [I.login, I.employee, TIME]);
  await db.query(`INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status)
    VALUES($1,$2,$3,'SNAP-ID','555-0000','SNAP-ADDRESS','pending')`, [I.verification, I.employee, CANARY]);
  await db.query(`INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority,notification_category,audit_origin,delivery_mode)
    VALUES($1,$2,'root','Snapshot notification',$3,'realtime','normal','standard','manual_admin','realtime_only')`, [I.message, NEW.root, CANARY]);
  await db.query('INSERT INTO public.message_recipients(message_id,recipient_id) VALUES($1,$2)', [I.message, I.employee]);
  await db.query(`INSERT INTO public.simulated_customers(id,admin_id,customer_name,customer_id,source_type,target_employee_ids)
    VALUES($1,$2,'Snapshot customer','SNAP-CUSTOMER','aaa_service',NULL)`, [I.customer, NEW.root]);
  await db.query(`INSERT INTO public.customer_employee_conversations(id,customer_id,employee_id,sender_type,message_content,message_type,source_type)
    VALUES($1,$2,$3,'customer',$4,'text','aaa_service')`, [I.chat, I.customer, I.employee, CANARY]);
  await db.query(`INSERT INTO private.content_audit_events(id,operation_id,entity_type,entity_id,action,owner_admin_id,actor_admin_id,
    actor_username,actor_role,before_data,after_data,media_refs,occurred_at)
    VALUES($1,$2,'notification',$3,'edit',$4,$4,'root','super_admin',NULL,'null','{}',$5)`, [I.audit, id(20), I.message, NEW.root, TIME]);
  session = await adminLogin(db, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch);
  emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  employeeToken = randomUUID();
  await db.query(`INSERT INTO public.employee_financial_sessions(user_id,token_hash,tab_id,session_marker,expires_at)
    VALUES($1,private.hash_financial_token($2),'local-snapshot-tab',$3,now()+interval '1 hour')`, [I.employee, employeeToken, randomUUID()]);
  await db.exec('CREATE ROLE site_snapshot_untrusted NOLOGIN; GRANT USAGE ON SCHEMA public TO site_snapshot_untrusted');
  baseline = await checkedRead();
}, { timeout: 180000 });
after(async () => { await db?.close(); mock.restoreAll(); });

test('SQL41 follows SQL40, preserves precisely 12 old replay failures and changes no existing function/table/RLS/trigger/data', () => {
  assert.deepEqual(replay.files.slice(-2), [PREVIOUS, MIGRATION]); assert.equal(replay.failures.length, 12);
  assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.deepEqual(schemaAfter, schemaBefore); assert.deepEqual(dataAfter, dataBefore);
});
test('RPC is STABLE SECURITY DEFINER with fixed search_path/UTC/ISO and SQL40-style ACL', async () => {
  const p = (await rows(db, `SELECT prosecdef,provolatile,proconfig,proacl::text,pronargdefaults,proargnames,proisstrict
    FROM pg_proc WHERE oid=to_regprocedure($1)`, [SIGNATURE]))[0];
  assert.equal(p.prosecdef, true); assert.equal(p.provolatile, 's'); assert.equal(p.proisstrict, false);
  assert.deepEqual(p.proconfig, ['search_path=pg_catalog, public, private, pg_temp', 'TimeZone=UTC', 'DateStyle=ISO, YMD']);
  assert.equal(p.pronargdefaults, 0); assert.deepEqual(p.proargnames, ['p_admin_session_token', 'p_package_id']);
  assert.doesNotMatch(p.proacl, /(?:^|,)=[^,]*X/);
  for (const [role, allowed] of [['anon', true], ['authenticated', true], ['service_role', false], ['site_snapshot_untrusted', false]]) {
    assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, SIGNATURE]), allowed);
  }
});
test('exact response, seven-table shared metadata and server jsonb catalogs TEXT SHA256 (not JS JSON text)', async () => {
  consistent(baseline);
  assert.equal(baseline.site_id, await scalar(db, 'SELECT site_id FROM private.employee_transfer_site'));
  assert.deepEqual(baseline.catalogs.shared.tables.map(t => t.key), SHARED);
  assert.ok(baseline.catalogs.shared.excluded_system_keys.includes('ios_config'));
  const text = await scalar(db, 'SELECT ($1::jsonb)::text', [JSON.stringify(baseline.catalogs)]);
  assert.equal(baseline.sha256, sha(text));
  assert.notEqual(baseline.sha256, sha(JSON.stringify(baseline.catalogs)));
  assert.deepEqual(await checkedRead(), baseline);
});
test('only metadata is returned: no plaintext/hash credentials, account/content originals, session/job tokens or captured rows', async () => {
  const text = JSON.stringify(baseline);
  const secrets = (await rows(db, `SELECT password_hash AS secret FROM public.admins UNION ALL SELECT password_hash FROM public.users
    UNION ALL SELECT password_hash FROM public.financial_admin_credentials UNION ALL SELECT password_hash FROM public.financial_employee_credentials
    UNION ALL SELECT token_hash FROM public.admin_financial_sessions UNION ALL SELECT token_hash FROM public.employee_financial_sessions`)).map(r => r.secret);
  for (const value of [...Object.values(PASSWORDS), ...secrets, CANARY, session, employeeToken, 'snapshot_employee', 'SNAP-ID', 'SNAP-ADDRESS', 'local-only']) {
    assert.equal(text.includes(value), false, `must not return original value ${value.slice(0, 12)}`);
  }
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (!Array.isArray(value)) for (const key of Object.keys(value)) {
      assert.doesNotMatch(key, /password|token|ndjson|payload|device_info|before_data|after_data|username/);
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(baseline);
  for (const [key, catalog] of Object.entries(baseline.catalogs)) for (const table of catalog.tables) {
    exactKeys(table, ['key', 'rows', 'bytes', ['shared', 'products'].includes(key) ? 'sha256' : 'row_hashes_sha256']);
    assert.equal(typeof table.rows, 'number'); assert.equal(typeof table.bytes, 'number');
  }
});

test('all ten committed serial exports equal the baseline, close normally without cancel, and leave its ending fingerprint unchanged', async () => {
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_jobs'), 0);
  for (const domain of DOMAINS) {
    assert.deepEqual(await exportStage(domain), baseline.catalogs[domain], domain);
    assert.deepEqual(await checkedRead(), baseline, `${domain} technical task changes must not drift business catalogs`);
  }
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE kind='export' AND status='finished'"), 10);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_events WHERE action LIKE '%cancel%'"), 0);
});
test('successful independent stage verification cannot hide drift between stages: start/end fingerprint comparison rejects the bundle', async () => isolated(async () => {
  const start = await checkedRead();
  assert.deepEqual(await exportStage('shared'), start.catalogs.shared);
  await change('public.users', 'UPDATE public.users SET remarks=$2 WHERE id=$1', [I.employee, 'Changed after shared stage closed']);
  const identity = await exportStage('identity');
  assert.notDeepEqual(identity, start.catalogs.identity, 'each individual stage can verify its own newer source');
  const end = await checkedRead(); assert.deepEqual(identity, end.catalogs.identity);
  assert.notEqual(end.sha256, start.sha256, 'coordinator must reject rather than certify this mixed-time bundle');
  assert.equal(end.full_site_complete, false); assert.equal(end.import_ready, false);
}));
test('snapshot inside READ ONLY succeeds for anon/authenticated and cannot write business/technical data or advance sequences', async () => isolated(async () => {
  assert.equal(await scalar(db, "SELECT current_setting('transaction_read_only')"), 'on');
  const before = await dataState();
  assert.deepEqual(await snapshot(), baseline); assert.deepEqual(await snapshot({}, 'authenticated'), baseline);
  assert.deepEqual(await dataState(), before);
}, 'READ ONLY'));
test('snapshot neither starts a task nor renews/changes an already running export', async () => isolated(async () => {
  const job = await begin('shared');
  await db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '1 hour' WHERE id=$1", [job.job_id]);
  assert.deepEqual(await checkedRead(), baseline);
  assert.equal(await scalar(db, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status='running'"), 1);
}));
test('another package changes packaged catalogs and SHA, including every nested identity/finance binding', async () => {
  const pkg = randomUUID(), other = await snapshot({ p_package_id: pkg }); consistent(other, pkg);
  assert.notEqual(other.sha256, baseline.sha256);
  for (const key of DOMAINS.slice(0, 3)) assert.deepEqual(other.catalogs[key], baseline.catalogs[key]);
  for (const key of PACKAGED) assert.notDeepEqual(other.catalogs[key], baseline.catalogs[key]);
});

for (const [label, token] of [['NULL', () => null], ['unknown', randomUUID], ['secondary admin', () => branch],
  ['emergency admin', () => emergency], ['employee token', () => employeeToken]]) {
  test(`rejects ${label} session without writes`, async () => {
    const before = await dataState();
    await assert.rejects(snapshot({ p_admin_session_token: token() }), /session is invalid or expired|Super administrator permission/);
    assert.deepEqual(await dataState(), before);
  });
}
for (const [label, sql] of [
  ['expired', "UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1"],
  ['revoked', 'UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE admin_id=$1'],
  ['disabled admin', 'UPDATE public.admins SET is_active=false WHERE id=$1'],
  ['downgraded admin', "UPDATE public.admins SET role='secondary_admin' WHERE id=$1"],
]) {
  test(`rejects ${label} real super-admin session`, async () => isolated(async () => {
    await db.query(sql, [NEW.root]); const before = await dataState();
    await assert.rejects(snapshot(), /session is invalid or expired|Super administrator permission/);
    assert.deepEqual(await dataState(), before);
  }));
}
test('NULL package is rejected explicitly, not a NULL/partial catalog or autogenerated id', async () => {
  const before = await dataState();
  await assert.rejects(snapshot({ p_package_id: null }), /site export package id is required/);
  await assert.rejects(snapshot({ p_package_id: '' }), /invalid input syntax for type uuid/);
  assert.deepEqual(await dataState(), before);
});
for (const role of ['service_role', 'site_snapshot_untrusted']) {
  test(`${role} has no public RPC execution even with a valid super-admin token`, async () => {
    const before = await dataState(); await assert.rejects(snapshot({}, role), /permission denied for function/);
    assert.deepEqual(await dataState(), before);
  });
}
for (const role of ['anon', 'authenticated']) {
  test(`${role} cannot read/write private transfer tables or call private catalogs directly`, async () => isolated(async () => {
    for (const sql of ['SELECT * FROM private.employee_transfer_jobs', 'SELECT * FROM private.employee_transfer_archive_records',
      'SELECT private.employee_transfer_identity_catalog(NULL)', 'INSERT INTO private.employee_transfer_site(site_id) VALUES(gen_random_uuid())']) {
      await db.exec('SAVEPOINT direct_acl');
      try {
        await db.exec(`SET LOCAL ROLE ${role}`); await assert.rejects(db.exec(sql), /permission denied/);
      } finally { await db.exec('ROLLBACK TO SAVEPOINT direct_acl; RELEASE SAVEPOINT direct_acl'); }
    }
    assert.deepEqual(await snapshot({}, role), baseline);
  }));
}

const DRIFTS = [
  ['shared admin account', 'shared', 'admins', 'public.admins', `UPDATE public.admins SET username='branch-snapshot-drift' WHERE id='${NEW.branch}'`],
  ['shared credential', 'shared', 'financial_admin_credentials', 'public.financial_admin_credentials', `UPDATE public.financial_admin_credentials SET password_hash='local-changed-credential' WHERE admin_id='${NEW.branch}'`],
  ['shared group', 'shared', 'admin_groups', 'public.admin_groups', `UPDATE public.admin_groups SET name='changed' WHERE id='${I.adminGroup}'`],
  ['shared member', 'shared', 'admin_group_members', 'public.admin_group_members', `UPDATE public.admin_group_members SET created_at=created_at-interval '1 minute' WHERE id='${I.adminMember}'`],
  ['shared admin config', 'shared', 'admin_configs', 'public.admin_configs', `UPDATE public.admin_configs SET config_value='changed' WHERE admin_id='${NEW.branch}' AND config_type='company_name'`],
  ['shared system config', 'shared', 'system_configs', 'public.system_configs', `UPDATE public.system_configs SET value='"Changed title"' WHERE key='login_title'`],
  ['shared retention config', 'shared', 'history_cleanup_config', 'public.history_cleanup_config', 'UPDATE public.history_cleanup_config SET retention_days=retention_days+1 WHERE table_name=(SELECT min(table_name) FROM public.history_cleanup_config)'],
  ['product name', 'products', 'product_types', 'public.product_types', `UPDATE public.product_types SET name='Changed product' WHERE id='${I.product}'`],
  ['dispatch config', 'dispatch', 'dispatch_groups', 'public.dispatch_groups', `UPDATE public.dispatch_groups SET description='Changed dispatch config' WHERE id='${NEW.groupA}'`],
  ['dispatch content', 'dispatch', 'dispatch_group_orders', 'public.dispatch_group_orders', `UPDATE public.dispatch_group_orders SET order_content='Changed content' WHERE id='${I.groupOrder}'`],
  ['submission usage', 'dispatch', 'valid_order_data', 'public.valid_order_data', `UPDATE public.valid_order_data SET usage_count=7 WHERE id='${I.valid}'`],
  ['employee account', 'identity', 'accounts', 'public.users', `UPDATE public.users SET remarks='Changed account',tags=ARRAY['x',NULL] WHERE id='${I.employee}'`],
  ['employee credential', 'identity', 'credentials', 'public.financial_employee_credentials', `UPDATE public.financial_employee_credentials SET password_hash='local-employee-credential-drift' WHERE user_id='${I.employee}'`],
  ['money with precision', 'finance', 'wallets', 'public.wallets', `UPDATE public.wallets SET available_balance=12345678901234567890.1234567890123456789 WHERE user_id='${I.employee}'`],
  ['activity data', 'activity', 'employee_login_history', 'public.employee_login_history', `UPDATE public.employee_login_history SET device_info='{"browser":"changed"}' WHERE id='${I.login}'`],
  ['verification original', 'verification', 'verification_requests', 'public.verification_requests', `UPDATE public.verification_requests SET email='Changed address' WHERE id='${I.verification}'`],
  ['notification content', 'notifications', 'messages', 'public.messages', `UPDATE public.messages SET content='Changed notification' WHERE id='${I.message}'`],
  ['notification read state', 'notifications', 'message_recipients', 'public.message_recipients', `UPDATE public.message_recipients SET is_read=true WHERE message_id='${I.message}' AND recipient_id='${I.employee}'`],
  ['chat content', 'chat', 'customer_employee_conversations', 'public.customer_employee_conversations', `UPDATE public.customer_employee_conversations SET message_content='Changed chat' WHERE id='${I.chat}'`],
  ['chat role visibility', 'chat', 'simulated_customers', 'public.simulated_customers', `UPDATE public.simulated_customers SET target_employee_ids=ARRAY['${I.employee}']::uuid[] WHERE id='${I.customer}'`],
  ['archive original', 'archives', 'content_audit_events', 'private.content_audit_events', `UPDATE private.content_audit_events SET before_data='{"changed":true}' WHERE id='${I.audit}'`],
];
for (const [label, domain, key, relation, sql] of DRIFTS) {
  test(`${label} changes ending SHA without a row-count change; nested catalogs remain identical and RPC remains read-only`, async () => isolated(async () => {
    assert.ok((await change(relation, `${sql} RETURNING 1`)).rows.length > 0);
    const changed = await checkedRead();
    assert.notEqual(changed.sha256, baseline.sha256);
    assert.notDeepEqual(descriptor(changed, domain, key), descriptor(baseline, domain, key));
    assert.equal(descriptor(changed, domain, key).rows, descriptor(baseline, domain, key).rows);
  }));
}
for (const relation of ['public.users', 'public.product_types', 'public.dispatch_groups', 'public.messages', 'public.customer_employee_conversations', 'private.content_audit_events']) {
  test(`unreviewed schema field on ${relation} blocks the entire snapshot (no partial catalogs)`, async () => isolated(async () => {
    await db.exec(`ALTER TABLE ${relation} ADD COLUMN snapshot_unreviewed text`);
    const before = await dataState(); await assert.rejects(snapshot(), /Unreviewed|schema|inventory/i);
    assert.deepEqual(await dataState(), before);
  }));
}

test('SQL NULL versus JSON null in activity and archive originals changes SHA, never normalizes either to empty', async () => isolated(async () => {
  for (const [relation, column, row, domain] of [['public.employee_login_history', 'device_info', I.login, 'activity'],
    ['private.content_audit_events', 'before_data', I.audit, 'archives']]) {
    const initial = await snapshot();
    await change(relation, `UPDATE ${relation} SET ${column}='null'::jsonb WHERE id=$1`, [row]);
    const jsonNull = await checkedRead(); assert.notEqual(jsonNull.sha256, initial.sha256);
    assert.notDeepEqual(jsonNull.catalogs[domain], initial.catalogs[domain]);
    await change(relation, `UPDATE ${relation} SET ${column}=NULL WHERE id=$1`, [row]);
    assert.deepEqual(await snapshot(), initial);
  }
}));
test('role visibility NULL and [] differ; invalid [NULL] preserves the source catalog fail-closed guard', async () => isolated(async () => {
  await change('public.simulated_customers', 'UPDATE public.simulated_customers SET target_employee_ids=$2::uuid[] WHERE id=$1', [I.customer, []]);
  assert.notEqual((await checkedRead()).sha256, baseline.sha256);
  await change('public.simulated_customers', 'UPDATE public.simulated_customers SET target_employee_ids=$2::uuid[] WHERE id=$1', [I.customer, [null]]);
  const before = await dataState();
  await assert.rejects(snapshot(), /Invalid chat array identity/);
  assert.deepEqual(await dataState(), before);
}));
test('one real SQL statement uses its pre-write MVCC snapshot even with a sibling data-modifying CTE; next statement detects drift', async () => isolated(async () => {
  // No second connection is simulated: this tests statement visibility, not native
  // PG/PostgREST concurrency. No catalog or authentication function is replaced.
  await db.exec('SET LOCAL ROLE postgres');
  const result = (await rows(db, `WITH changed AS (
      UPDATE public.wallets SET available_balance=available_balance+0.01 WHERE user_id=$2 RETURNING user_id
    ) SELECT public.get_employee_export_site_snapshot($1,$3) AS snapshot,(SELECT count(*)::int FROM changed) AS changes`,
  [session, I.employee, PACKAGE]))[0];
  assert.equal(result.changes, 1); consistent(result.snapshot); assert.deepEqual(result.snapshot, baseline);
  const next = await checkedRead(); assert.notEqual(next.sha256, baseline.sha256);
}));
test('caller timezone/datestyle/search_path cannot change the catalogs or leak GUC changes', async () => isolated(async () => {
  await db.exec(`SET LOCAL timezone='Pacific/Honolulu'; SET LOCAL datestyle='SQL, DMY'; SET LOCAL search_path=pg_temp,public`);
  const before = await scalar(db, "SELECT jsonb_build_array(current_setting('timezone'),current_setting('datestyle'),current_setting('search_path'))");
  assert.deepEqual(await checkedRead(), baseline);
  assert.deepEqual(await scalar(db, "SELECT jsonb_build_array(current_setting('timezone'),current_setting('datestyle'),current_setting('search_path'))"), before);
}));
test('shared validation errors propagate instead of silently omitting settings', async () => isolated(async () => {
  await db.query("INSERT INTO public.system_configs(key,value) VALUES('snapshot_unknown_secret','{}')");
  const before = await dataState(); await assert.rejects(snapshot(), /Unreviewed shared setting key/);
  assert.deepEqual(await dataState(), before);
}));
test('site snapshot rejects nested structured device secrets before any export task or plaintext file is created', async () => isolated(async () => {
  for (const key of ['current_session_token', 'Access-Token', 'AUTHORIZATION', 'api/key', 'Client:Secret']) {
    await change('public.employee_login_history', 'UPDATE public.employee_login_history SET device_info=$2::jsonb WHERE id=$1',
      [I.login, JSON.stringify({ devices: [{ [key]: CANARY }] })]);
    const before = await dataState();
    await assert.rejects(snapshot(), /structured secret/);
    assert.deepEqual(await dataState(), before);
  }
}));
test('device metadata with historical session timestamps is preserved, not silently stripped', async () => isolated(async () => {
  const device = { browser: 'Chromium', session_created_at: TIME, token_count: 2, notes: 'session_id is only text here' };
  await change('public.employee_login_history', 'UPDATE public.employee_login_history SET device_info=$2::jsonb WHERE id=$1',
    [I.login, JSON.stringify(device)]);
  consistent(await snapshot());
  assert.deepEqual(await scalar(db, 'SELECT device_info FROM public.employee_login_history WHERE id=$1', [I.login]), device);
}));
test('any existing imported archive namespace fails closed, including foreign/unverified namespace; SQL33 error is preserved', async () => isolated(async () => {
  const job = await begin('archives');
  // LOCAL fixture: use a real job FK, not a fabricated successful restore receipt.
  // Even an unverified foreign namespace must block; SQL41 cannot hide/skip it.
  await db.query(`INSERT INTO private.employee_transfer_archive_records(source_site_id,package_id,table_key,source_id,body,source_line,job_id)
    VALUES($1,$2,'content_audit_events',$3,'{}',E'{}\n',$4)`, [randomUUID(), randomUUID(), I.audit, job.job_id]);
  const before = await dataState();
  await db.exec('SAVEPOINT archive_direct');
  await assert.rejects(db.query('SELECT private.employee_transfer_archives_catalog($1)', [PACKAGE]), /namespace-preserving re-export protocol/);
  await db.exec('ROLLBACK TO SAVEPOINT archive_direct; RELEASE SAVEPOINT archive_direct');
  for (const pkg of [PACKAGE, randomUUID()]) {
    await assert.rejects(snapshot({ p_package_id: pkg }), /Previously transferred archive snapshots require a namespace-preserving re-export protocol; this export cannot omit them\./);
  }
  assert.deepEqual(await dataState(), before);
}));
