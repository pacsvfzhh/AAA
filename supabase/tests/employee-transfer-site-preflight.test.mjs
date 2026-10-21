import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, mock, test } from 'node:test';
import { assertExpectedReplayFailures, replayMigrations } from './support/replay-migrations.mjs';
import { adminLogin, rows, rpc as baseRpc, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Real sorted local SQL replay (including SQL43), sessions, ACL and business
// preflight. Historical platform substitutes are NOT native PG/PostgREST,
// deployed Edge, real Storage or an eleven-file/full-site restore acceptance.
const PREVIOUS = '20261102000043_preserve_transfer_announcements.sql';
const MIGRATION = '20261102000044_preflight_site_restore.sql';
const RPC = 'get_employee_import_site_preflight';
const SIGNATURE = `public.${RPC}(uuid,uuid)`;
const SOURCE = '44000000-0000-4000-8000-000000000001';
const EMPLOYEE = '44000000-0000-4000-8000-000000000002';
const OTHER_ADMIN = '44000000-0000-4000-8000-000000000003';
const CANARY = 'LOCAL-PREFLIGHT-RAW-DATA-MUST-NOT-LEAK';
const BLOCKERS = ['same_site', 'active_maintenance', 'active_transfer_task', 'target_has_business', 'missing_backend_support'];
const FIELDS = ['version', 'protocol', 'site_id', 'source_site_id', 'can_restore_to_maintenance',
  'blockers', 'missing_rpcs', 'full_site_complete', 'can_release'];
const migration = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8');
// Extract only the reviewed literal array; source coverage below is independently
// derived from the actual restore clients, not from this production allowlist.
const whitelist = [...migration.match(/FOREACH v_rpc IN ARRAY ARRAY\[([\s\S]*?)\]::text\[\] LOOP/)[1]
  .matchAll(/'(public\.[a-z_]+\([a-z,]*\))'/g)].map(match => match[1]);
const quote = value => '"' + value.replaceAll('"', '""') + '"';
let db, replay, session, branch, emergency, employeeToken, siteId;
let schemaBefore, schemaAfter, dataBefore, dataAfter, inside = false;

async function isolated(fn, mode = '') {
  await db.exec(`BEGIN ${mode}`); inside = true;
  try { return await fn(); } finally { inside = false; await db.exec('ROLLBACK'); }
}
async function call(name, args, role = 'anon') {
  assert.ok(['anon', 'authenticated', 'service_role', 'site_preflight_untrusted'].includes(role));
  const own = !inside;
  if (own) await db.exec('BEGIN');
  await db.exec('SAVEPOINT preflight_call');
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    const result = await baseRpc(db, name, args, { role: null });
    await db.exec('RESET ROLE; RELEASE SAVEPOINT preflight_call');
    if (own) await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT preflight_call; RELEASE SAVEPOINT preflight_call');
    if (own) await db.exec('ROLLBACK');
    throw error;
  }
}
const preflight = (args = {}, role) => call(RPC, { p_admin_session_token: session, p_source_site_id: SOURCE, ...args }, role);
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
function exact(result, blockers = [], missing = [], source = SOURCE) {
  assert.deepEqual(Object.keys(result).sort(), [...FIELDS].sort());
  assert.equal(result.version, 1); assert.equal(result.protocol, 'site-maintenance-restore-v1');
  assert.equal(result.site_id, siteId); assert.equal(result.source_site_id, source);
  assert.deepEqual(result.blockers, blockers); assert.deepEqual(result.missing_rpcs, missing);
  assert.equal(result.can_restore_to_maintenance, blockers.length === 0);
  assert.equal(result.full_site_complete, false); assert.equal(result.can_release, false);
  assert.deepEqual(result.blockers, BLOCKERS.filter(code => blockers.includes(code)));
  assert.equal(new Set(result.blockers).size, result.blockers.length);
}
async function checked(blockers = [], missing = [], args = {}, role) {
  const before = await dataState();
  const result = await preflight(args, role);
  exact(result, blockers, missing, args.p_source_site_id ?? SOURCE);
  assert.deepEqual(await dataState(), before, 'no business/table/sequence/job/event/staging/heartbeat/permit writes');
  return result;
}
async function addJob({ owner = OTHER_ADMIN, kind = 'import', status = 'running', stale = false } = {}) {
  const id = randomUUID(), token = randomUUID();
  await db.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options,summary,started_at,last_activity_at)
    VALUES($1,$2,$3,$4,private.hash_financial_token($5),$6,'{"local_only":"private-options"}',
      '{"private_payload":"private-summary"}',now()-$7::interval,now()-$7::interval)`,
  [id, kind, owner, CANARY, token, status, stale ? '13 hours' : '1 minute']);
  return { id, token };
}
async function addMaintenance(job, dirty) {
  await db.query(`INSERT INTO private.employee_transfer_maintenance(job_id,admin_id,plan_hash,target_hash,entered_at,dirty)
    VALUES($1,$2,$3,$4,now()-interval '13 hours',$5)`, [job.id, OTHER_ADMIN, 'a'.repeat(64), 'b'.repeat(64), dirty]);
}
// Only the trusted LOCAL fixture code uses ALTER FUNCTION, never the RPC. Rename
// preserves real dependencies and proves the exact public signature is required.
async function hide(signature, name = 'site_preflight_hidden_rpc') {
  assert.ok(whitelist.includes(signature));
  await db.exec(`ALTER FUNCTION ${signature} RENAME TO ${quote(name)}`);
}

before(async () => {
  mock.method(globalThis, 'fetch', () => assert.fail('No production/network/Storage access allowed'));
  replay = await replayMigrations({ upTo: PREVIOUS, strict: true }); db = replay.db;
  schemaBefore = await schemaState(); dataBefore = await dataState();
  await db.exec(migration);
  schemaAfter = await schemaState(); dataAfter = await dataState();
  replay.files.push(MIGRATION);
  replay.validation = assertExpectedReplayFailures(replay, { upTo: MIGRATION });
  await buildNewSite(db);
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    VALUES($1,'preflight_other_super',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [OTHER_ADMIN, PASSWORDS.root]);
  await db.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash)
    SELECT id,password_hash FROM public.admins WHERE id=$1`, [OTHER_ADMIN]);
  await db.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,remarks)
    VALUES($1,'preflight_employee','PF-001',extensions.crypt($2,extensions.gen_salt('bf',4)),$3,$4)`,
  [EMPLOYEE, PASSWORDS.employee, NEW.root, CANARY]);
  await db.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [EMPLOYEE]);
  employeeToken = randomUUID();
  await db.query(`INSERT INTO public.employee_financial_sessions(user_id,token_hash,tab_id,session_marker,expires_at)
    VALUES($1,private.hash_financial_token($2),'local-preflight-tab',$3,now()+interval '1 hour')`, [EMPLOYEE, employeeToken, randomUUID()]);
  session = await adminLogin(db, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch);
  emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  siteId = await scalar(db, 'SELECT site_id FROM private.employee_transfer_site');
  assert.notEqual(siteId, SOURCE);
  await db.exec('CREATE ROLE site_preflight_untrusted NOLOGIN; GRANT USAGE ON SCHEMA public TO site_preflight_untrusted');
}, { timeout: 180000 });
after(async () => { await db?.close(); mock.restoreAll(); });

test('SQL44 strictly follows SQL43 with exactly the original 12 replay failures; no existing schema/data changes', t => {
  assert.deepEqual(replay.files.slice(-2), [PREVIOUS, MIGRATION]);
  assert.equal(replay.failures.length, 12); assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.deepEqual(schemaBefore, schemaAfter); assert.deepEqual(dataBefore, dataAfter);
  t.diagnostic(`${replay.files.length} SQL files replayed; exactly ${replay.failures.length} known failures; ${whitelist.length} audited signatures`);
});
test('STABLE SECURITY DEFINER jsonb RPC, exact two UUID parameters and fixed search_path; no PUBLIC/service grants', async () => {
  const p = (await rows(db, `SELECT prosecdef,provolatile,proconfig,pronargdefaults,proargnames,proisstrict,prorettype::regtype::text AS result,
    proacl::text FROM pg_proc WHERE oid=to_regprocedure($1)`, [SIGNATURE]))[0];
  assert.equal(p.prosecdef, true); assert.equal(p.provolatile, 's'); assert.equal(p.proisstrict, false);
  assert.equal(p.result, 'jsonb'); assert.equal(p.pronargdefaults, 0);
  assert.deepEqual(p.proargnames, ['p_admin_session_token', 'p_source_site_id']);
  assert.deepEqual(p.proconfig, ['search_path=pg_catalog, public, private, pg_temp']);
  assert.doesNotMatch(p.proacl, /(?:^|,)=[^,]*X/);
  for (const [role, allowed] of [['anon', true], ['authenticated', true], ['service_role', false], ['site_preflight_untrusted', false]]) {
    assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, SIGNATURE]), allowed);
  }
  assert.doesNotMatch(migration, /\bEXECUTE\s+(?:format|v_|')|FOR UPDATE|INSERT INTO|UPDATE private|DELETE FROM|pg_advisory|pg_current_xact_id\(/i);
});
test('SQL44 signature set plus SQL45 prerequisite covers actual restore clients, not legacy finish/export/release', async () => {
  const files = ['siteRestoreApi', 'api', 'identityApi', 'dependencyApi', 'financeApi', 'activityApi', 'verificationApi', 'verificationMedia',
    'notificationsApi', 'notificationsConfigurationApi', 'notificationsRestoreApi', 'notificationsMedia',
    'chatApi', 'chatMergeApi', 'chatRestoreApi', 'chatMedia', 'archiveApi', 'archiveMedia'];
  const names = new Set();
  // These create-only/leave APIs share api.ts but are NOT used by siteRestore.
  const excluded = new Set(['employee_import_shared_begin', 'get_employee_import_shared_dry_run',
    'employee_import_shared_apply', 'employee_transfer_leave_maintenance']);
  for (const file of files) {
    const source = await readFile(new URL(`../../src/lib/employeeTransfer/${file}.ts`, import.meta.url), 'utf8');
    for (const [, name] of source.matchAll(/['"]((?:get_employee_(?:import|transfer)_|employee_(?:import|transfer)_)[a-z_]+|employee_products_close)['"]/g)) {
      if (!excluded.has(name)) names.add(`public.${name}`);
    }
  }
  const handler = await readFile(new URL('../functions/employee-transfer-media/handler.ts', import.meta.url), 'utf8');
  for (const [, name] of handler.matchAll(/['"](employee_transfer_[a-z_]+_media_(?:authorize|commit|read_authorize))['"]/g)) names.add(`public.${name}`);
  const listed = whitelist.map(signature => signature.split('(')[0]);
  assert.equal(new Set(whitelist).size, whitelist.length); assert.equal(new Set(listed).size, listed.length);
  const v2Only = ['public.employee_import_site_verify_prerequisites'];
  assert.deepEqual([...listed, ...v2Only].sort(), [...names].sort());
  for (const signature of whitelist) {
    assert.match(signature, /^public\.[a-z_]+\((?:uuid|text|jsonb|integer|bigint)(?:,(?:uuid|text|jsonb|integer|bigint))*\)$/);
    assert.doesNotMatch(signature, /employee_import_finish|employee_export_|leave_maintenance|release/);
    assert.equal(await scalar(db, `SELECT count(*)::int FROM pg_proc WHERE oid=to_regprocedure($1) AND prokind='f' AND prorettype='jsonb'::regtype`, [signature]), 1, signature);
  }
});
for (const role of ['anon', 'authenticated']) {
  test(`${role} super-admin receives exact true-to-maintenance/false-to-release fields on a genuinely eligible target`, async () => {
    assert.equal((await call('get_employee_import_dispatch_preflight', { p_admin_session_token: session }, role)).eligible_for_empty_target_mode, true);
    await checked([], [], {}, role);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_jobs'), 0);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_events'), 0);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_staging'), 0);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits'), 0);
  });
  test(`${role} can call within READ ONLY and cannot read private state or gain write permits`, async () => isolated(async () => {
    assert.equal(await scalar(db, "SELECT current_setting('transaction_read_only')"), 'on');
    await checked([], [], {}, role);
    for (const sql of ['SELECT * FROM private.employee_transfer_jobs', 'SELECT * FROM private.employee_transfer_write_permits']) {
      await db.exec('SAVEPOINT private_acl');
      try { await db.exec(`SET LOCAL ROLE ${role}`); await assert.rejects(db.exec(sql), /permission denied/); }
      finally { await db.exec('ROLLBACK TO SAVEPOINT private_acl; RELEASE SAVEPOINT private_acl'); }
    }
  }, 'READ ONLY'));
}
for (const [label, token] of [['NULL', () => null], ['invalid', randomUUID], ['secondary', () => branch],
  ['emergency', () => emergency], ['employee', () => employeeToken]]) {
  test(`${label} session is rejected without changes or original-data response`, async () => {
    const before = await dataState();
    await assert.rejects(preflight({ p_admin_session_token: token() }), /session is invalid or expired|Super administrator permission/);
    assert.deepEqual(await dataState(), before);
  });
}
for (const [label, sql] of [
  ['expired', "UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1"],
  ['revoked', 'UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE admin_id=$1'],
  ['disabled', 'UPDATE public.admins SET is_active=false WHERE id=$1'],
  ['downgraded', "UPDATE public.admins SET role='secondary_admin' WHERE id=$1"],
]) {
  test(`${label} real super-admin session is rejected without writes`, async () => isolated(async () => {
    await db.query(sql, [NEW.root]); const before = await dataState();
    await assert.rejects(preflight(), /session is invalid or expired|Super administrator permission/);
    assert.deepEqual(await dataState(), before);
  }));
}
for (const role of ['service_role', 'site_preflight_untrusted']) {
  test(`${role} cannot execute the new public RPC even with a valid super-admin token`, async () => {
    await assert.rejects(preflight({}, role), /permission denied for function/);
  });
}
test('NULL/empty source is explicitly rejected and cannot generate an identity or write state', async () => {
  const before = await dataState();
  await assert.rejects(preflight({ p_source_site_id: null }), /A source site id is required/);
  await assert.rejects(preflight({ p_source_site_id: '' }), /invalid input syntax for type uuid/);
  assert.deepEqual(await dataState(), before);
});
test('same-site alone is a blocker and echoes only source/target identifiers with all release flags false', async () => {
  await checked(['same_site'], [], { p_source_site_id: siteId });
});
for (const kind of ['export', 'import']) for (const owner of [NEW.root, OTHER_ADMIN]) {
  test(`global running ${kind} by ${owner === NEW.root ? 'self' : 'another super-admin'} blocks without heartbeats or cleanup`, async () => isolated(async () => {
    await addJob({ kind, owner }); await checked(['active_transfer_task']);
  }));
}
for (const status of ['finished', 'cancelled', 'failed', 'abandoned']) {
  test(`${status} task does not block or get changed/cleaned`, async () => isolated(async () => {
    await addJob({ status }); await checked();
  }));
}
test('expired but still-running row is not silently expired/cancelled and retains the global task blocker', async () => isolated(async () => {
  const job = await addJob({ stale: true });
  await db.query(`INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES($1,$2,'local-canary',0,1,$3::jsonb)`, [job.id, EMPLOYEE, JSON.stringify([{ secret: CANARY }])]);
  await checked(['active_transfer_task']);
  assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [job.id]), 'running');
}));
for (const dirty of [false, true]) for (const status of ['running', 'cancelled']) {
  test(`${dirty ? 'dirty' : 'clean'} maintenance with expired ${status} job always blocks, without release/renewal`, async () => isolated(async () => {
    const job = await addJob({ status, stale: true }); await addMaintenance(job, dirty);
    await checked(status === 'running' ? ['active_maintenance', 'active_transfer_task'] : ['active_maintenance']);
  }));
}
const businessCases = [
  ['wallet funds', 'UPDATE public.wallets SET available_balance=12.34 WHERE user_id=$1'],
  ['frozen funds', 'UPDATE public.wallets SET frozen_balance=0.01 WHERE user_id=$1'],
  ['income', 'UPDATE public.users SET total_income=1 WHERE id=$1'],
  ['historical work', `INSERT INTO public.work_sessions(user_id,start_time,end_time,duration_minutes,last_heartbeat_at)
    VALUES($1,now()-interval '2 hours',now()-interval '1 hour',60,now()-interval '1 hour')`],
  ['withdrawal', "INSERT INTO public.withdrawals(user_id,amount,status) VALUES($1,0.01,'pending')"],
  ['actual transaction', `INSERT INTO public.wallet_transactions(user_id,type,amount,balance_before,balance_after,remarks)
    VALUES($1,'manual_adjustment',1,0,1,'${CANARY}')`],
];
for (const [label, sql] of businessCases) {
  test(`${label} is rejected by the real shared dispatch eligible_for_empty_target_mode predicate`, async () => isolated(async () => {
    await db.query(sql, [EMPLOYEE]);
    assert.equal((await call('get_employee_import_dispatch_preflight', { p_admin_session_token: session })).eligible_for_empty_target_mode, false);
    await checked(['target_has_business']);
  }));
}
test('used valid submission data is business, not merely harmless initialized configuration', async () => isolated(async () => {
  await db.query(`INSERT INTO public.valid_order_data(product_value,transaction_id,created_by,usage_count,last_used_at)
    VALUES(123.456,'LOCAL-PREFLIGHT-USED',$1,1,now())`, [NEW.root]);
  await checked(['target_has_business']);
}));
test('unused product/pool/submission configuration does not imply business or a full-site release permit', async () => isolated(async () => {
  await db.query("INSERT INTO public.product_types(name,is_active) VALUES('Preflight unused product',true)");
  await db.query(`INSERT INTO public.valid_order_data(product_value,transaction_id,created_by,usage_count)
    VALUES(123.456,'LOCAL-PREFLIGHT-UNUSED',$1,0)`, [NEW.root]);
  await checked();
}));
for (const signature of whitelist) {
  test(`missing exact backend signature blocks: ${signature}`, async () => isolated(async () => {
    await hide(signature);
    const result = await preflight(); exact(result, ['missing_backend_support'], [signature]);
  }));
}
test('multiple missing RPCs are unique and follow the fixed review order, not rename/catalog order', async () => isolated(async () => {
  const selected = [whitelist[0], whitelist[12], whitelist.at(-1)];
  for (const [index, signature] of [...selected].reverse().entries()) await hide(signature, `site_preflight_hidden_${index}`);
  await checked(['missing_backend_support'], selected);
}));
test('wrong overload and same-name other-schema function cannot satisfy a missing public signature', async () => isolated(async () => {
  const signature = 'public.employee_import_finance_apply(uuid,uuid,uuid,text)';
  await hide(signature);
  await db.exec(`CREATE FUNCTION public.employee_import_finance_apply(uuid,uuid,uuid,integer) RETURNS jsonb LANGUAGE sql
    AS 'SELECT ''{}''::jsonb';
    CREATE FUNCTION private.employee_import_finance_apply(uuid,uuid,uuid,text) RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb'`);
  await checked(['missing_backend_support'], [signature]);
}));
test('matching procedure or wrong return type is not the public jsonb RPC protocol', async () => isolated(async () => {
  const a = 'public.employee_import_finance_apply(uuid,uuid,uuid,text)', b = 'public.employee_import_activity_apply(uuid,uuid,uuid,text)';
  await hide(a, 'hidden_finance'); await hide(b, 'hidden_activity');
  await db.exec(`CREATE PROCEDURE public.employee_import_finance_apply(uuid,uuid,uuid,text) LANGUAGE plpgsql AS 'BEGIN NULL; END';
    CREATE FUNCTION public.employee_import_activity_apply(uuid,uuid,uuid,text) RETURNS text LANGUAGE sql AS 'SELECT ''no'''`);
  await checked(['missing_backend_support'], [a, b]);
}));
test('all five blockers accumulate once in the specified order with no data, task, event or permit writes', async () => isolated(async () => {
  await db.query('UPDATE public.wallets SET frozen_balance=1 WHERE user_id=$1', [EMPLOYEE]);
  const job = await addJob(); await addMaintenance(job, true);
  const missing = whitelist.at(-2); await hide(missing);
  await checked(BLOCKERS, [missing], { p_source_site_id: siteId });
}));
test('gate never invokes write dependencies, old employee-only finish, or maintenance release', async () => isolated(async () => {
  for (const signature of whitelist) {
    if (signature === 'public.get_employee_import_dispatch_preflight(uuid)') continue;
    const definition = await scalar(db, 'SELECT pg_get_functiondef(to_regprocedure($1))', [signature]);
    // Real catalog headers/ACLs/signatures are retained. Any attempted invocation
    // now fails, including status/media functions that are unnecessary to preflight.
    const start = definition.indexOf('AS $function$'), end = definition.lastIndexOf('$function$');
    assert.ok(start > 0 && end > start);
    await db.exec(definition.slice(0, start).replace(/LANGUAGE sql\b/, 'LANGUAGE plpgsql')
      + "AS $function$ BEGIN RAISE EXCEPTION 'Dependency must not execute'; END; $function$;");
  }
  await checked();
}));
test('response never returns raw content, credentials, password hashes, tokens, tasks/options or audit/staging payloads', async () => isolated(async () => {
  const job = await addJob();
  const result = await checked(['active_transfer_task']);
  const secrets = (await rows(db, `SELECT password_hash AS secret FROM public.admins UNION ALL SELECT password_hash FROM public.users
    UNION ALL SELECT password_hash FROM public.financial_admin_credentials UNION ALL SELECT password_hash FROM public.financial_employee_credentials
    UNION ALL SELECT token_hash FROM public.admin_financial_sessions UNION ALL SELECT token_hash FROM public.employee_financial_sessions
    UNION ALL SELECT token_hash FROM private.employee_transfer_jobs`)).map(row => row.secret);
  const text = JSON.stringify(result);
  for (const secret of [...secrets, ...Object.values(PASSWORDS), session, branch, emergency, employeeToken, CANARY,
    job.id, job.token, EMPLOYEE, OTHER_ADMIN, 'preflight_employee', 'private-options', 'private-summary']) {
    assert.equal(text.includes(secret), false, 'secret/original value must not appear in the response');
  }
}));
