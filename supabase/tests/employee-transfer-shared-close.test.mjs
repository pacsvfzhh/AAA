import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, mock, test } from 'node:test';
import { replayMigrations } from './support/replay-migrations.mjs';
import { adminLogin, rows, rpc as baseRpc, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Real SQL/session/ACL/staging/audit execution in local PGlite only. Platform and
// historical baseline substitutes are retained, not called a clean database build.
// No browser, PostgREST, multi-connection PostgreSQL or actual Storage is exercised.
const MIGRATION = '20261102000040_close_shared_export.sql';
const PREVIOUS = '20261102000039_export_employee_replacement_backup.sql';
const CLOSE = 'public.employee_export_shared_close(uuid,uuid)';
const CAPS = 'public.get_employee_transfer_capabilities(uuid)';
const RECEIPT = { success: true, scope: 'shared-settings', full_site_complete: false };
const BLOCKERS = ['complete_employee_backup_missing', 'unified_uuid_mapping_missing', 'full_site_release_missing'];
const KEYS = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
// Independent contract: every dependency is removed in its own rollback below.
const REQUIRED_RPCS = [
  'public.employee_transfer_cancel(uuid,uuid)',
  'public.get_employee_transfer_log(uuid,integer)',
  'public.employee_export_shared_begin(uuid,text)',
  'public.get_employee_export_shared_catalog(uuid,uuid)',
  'public.get_employee_export_shared_page(uuid,uuid,text,text,integer)',
  'public.employee_export_shared_verify(uuid,uuid)',
  CLOSE,
  'public.employee_export_products_begin(uuid,text)',
  'public.get_employee_export_products_page(uuid,uuid,text,integer)',
  'public.employee_export_products_verify(uuid,uuid)',
  'public.employee_products_close(uuid,uuid)',
  'public.employee_export_dispatch_begin(uuid,text)',
  'public.get_employee_export_dispatch_page(uuid,uuid,text,uuid,integer)',
  'public.employee_export_dispatch_verify(uuid,uuid)',
  'public.employee_export_dispatch_close(uuid,uuid)',
  'public.employee_export_identity_begin(uuid,text,uuid)',
  'public.get_employee_export_identity_page(uuid,uuid,text,uuid,integer)',
  'public.employee_export_identity_verify(uuid,uuid)',
  'public.employee_export_identity_close(uuid,uuid)',
  'public.employee_export_finance_begin(uuid,text,uuid)',
  'public.get_employee_export_finance_page(uuid,uuid,text,text,integer)',
  'public.employee_export_finance_verify(uuid,uuid)',
  'public.employee_export_finance_close(uuid,uuid)',
  'public.employee_export_activity_begin(uuid,text,uuid)',
  'public.get_employee_export_activity_page(uuid,uuid,text,text,integer)',
  'public.employee_export_activity_verify(uuid,uuid)',
  'public.employee_export_activity_close(uuid,uuid)',
  'public.employee_export_verification_begin(uuid,text,uuid)',
  'public.get_employee_export_verification_page(uuid,uuid,text,text,integer)',
  'public.employee_export_verification_verify(uuid,uuid)',
  'public.employee_export_verification_close(uuid,uuid)',
  'public.get_employee_transfer_verification_media(uuid,uuid,text)',
  'public.employee_transfer_verification_media_authorize(uuid,uuid,text,text)',
  'public.employee_transfer_verification_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
  'public.employee_export_notifications_begin(uuid,text,uuid)',
  'public.get_employee_export_notifications_page(uuid,uuid,text,text,integer)',
  'public.employee_export_notifications_verify(uuid,uuid)',
  'public.employee_export_notifications_close(uuid,uuid)',
  'public.get_employee_transfer_notification_media(uuid,uuid,text)',
  'public.employee_transfer_notification_media_authorize(uuid,uuid,text,text)',
  'public.employee_transfer_notification_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
  'public.employee_export_chat_begin(uuid,text,uuid)',
  'public.get_employee_export_chat_page(uuid,uuid,text,text,integer)',
  'public.employee_export_chat_verify(uuid,uuid)',
  'public.employee_export_chat_close(uuid,uuid)',
  'public.get_employee_transfer_chat_media(uuid,uuid,text)',
  'public.employee_transfer_chat_media_authorize(uuid,uuid,text,text)',
  'public.employee_transfer_chat_media_commit(uuid,uuid,text,text,integer,text,text,text,bigint)',
  'public.employee_export_archives_begin(uuid,text,uuid)',
  'public.get_employee_export_archives_page(uuid,uuid,text,text,integer)',
  'public.employee_export_archives_verify(uuid,uuid)',
  'public.employee_export_archives_close(uuid,uuid)',
  'public.employee_transfer_archive_media_inventory(uuid,uuid,text)',
  'public.employee_transfer_archive_media_status(uuid,uuid,text)',
  'public.employee_transfer_archive_media_authorize(uuid,uuid,text,text)',
  'public.employee_transfer_archive_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
  'public.employee_transfer_archive_media_verify(uuid,uuid,text)',
  'public.get_employee_archive_reexport_inventory(uuid)',
  'public.get_employee_archive_reexport_catalog(uuid,uuid,uuid)',
  'public.get_employee_archive_reexport_page(uuid,uuid,uuid,text,text,text,integer)',
  'public.get_employee_archive_reexport_verify(uuid,uuid,uuid,text)',
  'public.get_employee_archive_reexport_media(uuid,uuid,uuid,text)',
  'public.employee_transfer_archive_media_read_authorize(uuid,uuid,uuid,uuid,text)',
];
const sha = text => createHash('sha256').update(text).digest('hex');
const quote = identifier => '"' + identifier.replaceAll('"', '""') + '"';
let db, replay, session, branch, emergency, otherRoot, inside = false;
let schemaBefore, schemaAfter, migrationBusinessBefore, migrationBusinessAfter;
const group = randomUUID();
const member = randomUUID();

async function businessSnapshot() {
  const result = {};
  for (const { schema, name } of await rows(db, `SELECT n.nspname AS schema,c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p')
      AND c.oid NOT IN ('private.employee_transfer_jobs'::regclass,
        'private.employee_transfer_staging'::regclass,'private.employee_transfer_events'::regclass)
    ORDER BY n.nspname,c.relname`)) {
    result[`${schema}.${name}`] = await scalar(db, `SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,E'\n'
      ORDER BY to_jsonb(t)::text COLLATE "C"),'')) FROM ${quote(schema)}.${quote(name)} t`);
  }
  return result;
}
async function schemaSnapshot() {
  return {
    functions: await rows(db, `SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS definition,p.proacl::text
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','private') AND p.prokind='f'
        AND p.oid NOT IN (COALESCE(to_regprocedure($1),0::oid),COALESCE(to_regprocedure($2),0::oid))
      ORDER BY signature`, [CLOSE, CAPS]),
    relations: await rows(db, `SELECT c.oid::regclass::text AS relation,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,
      a.attnum,a.attname,a.atttypid,a.atttypmod,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) AS default_value
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname IN ('public','private') ORDER BY relation,a.attnum`),
    triggers: await rows(db, `SELECT t.tgrelid::regclass::text AS relation,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','private') ORDER BY relation,t.tgname`),
    policies: await rows(db, `SELECT * FROM pg_policies WHERE schemaname IN ('public','private') ORDER BY schemaname,tablename,policyname`),
  };
}
async function isolated(fn) {
  await db.exec('BEGIN'); inside = true;
  try { await fn(); } finally { inside = false; await db.exec('ROLLBACK'); }
}
async function call(name, args, role = 'anon') {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  const owned = !inside;
  if (owned) await db.exec('BEGIN');
  await db.exec('SAVEPOINT shared_close_call');
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    const value = await baseRpc(db, name, args, { role: null });
    await db.exec('RESET ROLE; RELEASE SAVEPOINT shared_close_call');
    if (owned) await db.exec('COMMIT');
    return value;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT shared_close_call; RELEASE SAVEPOINT shared_close_call');
    if (owned) await db.exec('ROLLBACK');
    throw error;
  }
}
const auth = job => ({ p_admin_session_token: session, p_job_token: job.job_token });
const close = (job, args = {}, role) => call('employee_export_shared_close', { ...auth(job), ...args }, role);
const verify = job => call('employee_export_shared_verify', auth(job));
const capabilities = (args = {}, role) => call('get_employee_transfer_capabilities', { p_admin_session_token: session, ...args }, role);
async function begin() {
  const job = await call('employee_export_shared_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  assert.equal(job.success, true);
  return job;
}
const jobState = job => scalar(db, 'SELECT to_jsonb(j) FROM private.employee_transfer_jobs j WHERE id=$1', [job.job_id]);
const staging = job => scalar(db, `SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY table_key,chunk_no),'[]')
  FROM private.employee_transfer_staging s WHERE job_id=$1`, [job.job_id]);
const events = job => rows(db, 'SELECT action,details FROM private.employee_transfer_events WHERE job_id=$1 ORDER BY id', [job.job_id]);
async function rejectedClose(job, pattern, args = {}, role) {
  const before = { job: await jobState(job), staged: await staging(job), events: await events(job) };
  await assert.rejects(close(job, args, role), pattern);
  assert.deepEqual({ job: await jobState(job), staged: await staging(job), events: await events(job) }, before);
}
const expectedCapabilities = (site, missing = []) => ({ version: 1, site_id: site, export_protocol: 'site-bundle-set-v1',
  can_export: missing.length === 0, can_import: false, import_blockers: BLOCKERS, missing_rpcs: missing });

before(async () => {
  mock.method(globalThis, 'fetch', () => assert.fail('Network, production and Storage access forbidden'));
  replay = await replayMigrations({ upTo: PREVIOUS, strict: true }); db = replay.db;
  schemaBefore = await schemaSnapshot(); migrationBusinessBefore = await businessSnapshot();
  await db.exec(await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8'));
  schemaAfter = await schemaSnapshot(); migrationBusinessAfter = await businessSnapshot();
  await buildNewSite(db);
  session = await adminLogin(db, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch);
  emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  const otherId = randomUUID();
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    VALUES($1,'shared-close-other-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [otherId, PASSWORDS.root]);
  await db.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash)
    SELECT id,password_hash FROM public.admins WHERE id=$1`, [otherId]);
  otherRoot = await adminLogin(db, 'shared-close-other-root', PASSWORDS.root);
  await db.query(`INSERT INTO public.admin_groups(id,name,created_by) VALUES($1,'Shared close fixture',$2)`, [group, NEW.root]);
  await db.query(`INSERT INTO public.admin_group_members(id,group_id,admin_id) VALUES($1,$2,$3)`, [member, group, NEW.branch]);
  await db.query(`INSERT INTO public.admin_configs(admin_id,config_type,config_value) VALUES($1,'company_name','Shared close fixture')
    ON CONFLICT(admin_id,config_type) DO UPDATE SET config_value=EXCLUDED.config_value`, [NEW.branch]);
}, { timeout: 180000 });
after(async () => { await db?.close(); mock.restoreAll(); });

test('SQL40 installs after all SQL39 migrations, preserving exactly 12 known failures, business data and existing definitions', () => {
  assert.equal(replay.files.at(-1), PREVIOUS);
  assert.equal(replay.failures.length, 12);
  assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.deepEqual(schemaAfter, schemaBefore);
  assert.deepEqual(migrationBusinessAfter, migrationBusinessBefore);
});
for (const [signature, volatility] of [[CLOSE, 'v'], [CAPS, 's']]) {
  test(`${signature} has fixed search_path, SECURITY DEFINER and explicit anon/authenticated-only ACL`, async () => {
    const p = (await rows(db, `SELECT prosecdef,provolatile,proconfig,proacl::text,pronargdefaults,proargnames
      FROM pg_proc WHERE oid=to_regprocedure($1)`, [signature]))[0];
    assert.equal(p.prosecdef, true); assert.equal(p.provolatile, volatility);
    assert.deepEqual(p.proconfig, ['search_path=pg_catalog, public, private, pg_temp']);
    assert.equal(p.pronargdefaults, 0);
    assert.deepEqual(p.proargnames, signature === CLOSE ? ['p_admin_session_token', 'p_job_token'] : ['p_admin_session_token']);
    assert.doesNotMatch(p.proacl, /(?:^|,)=[^,]*X/);
    for (const [role, allowed] of [['anon', true], ['authenticated', true], ['service_role', false]]) {
      assert.equal(await scalar(db, `SELECT has_function_privilege($1,$2,'EXECUTE')`, [role, signature]), allowed);
    }
  });
}

test('real seven-table export -> verify -> committed close frees the global running lock for the next export without cancel or business changes', async () => {
  const business = await businessSnapshot();
  const site = await scalar(db, 'SELECT site_id FROM private.employee_transfer_site');
  const job = await begin();
  assert.deepEqual(job.catalog.tables.map(t => t.key), KEYS);
  for (const descriptor of job.catalog.tables) {
    let after = null, text = '', count = 0;
    do {
      const page = await call('get_employee_export_shared_page', { ...auth(job), p_table_key: descriptor.key, p_after: after, p_limit: 1 });
      assert.equal(page.sha256, sha(page.ndjson));
      count += page.count; text += page.ndjson; after = page.next_after;
    } while (after !== null);
    assert.equal(count, descriptor.rows); assert.equal(Buffer.byteLength(text), descriptor.bytes);
    assert.equal(sha(text), descriptor.sha256);
  }
  await assert.rejects(call('employee_export_products_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root }), /still running/);
  assert.deepEqual(await verify(job), { verified: true, scope: 'shared-settings', full_site_complete: false });
  const catalog = (await jobState(job)).summary.shared_catalog;
  assert.deepEqual(await close(job), RECEIPT);
  const state = await jobState(job);
  assert.equal(state.status, 'finished'); assert.ok(state.finished_at); assert.equal(state.error, null);
  assert.deepEqual(state.summary, { shared_catalog: catalog, shared_verified: true, scope: 'shared-settings', full_site_complete: false });
  assert.deepEqual(await staging(job), []);
  assert.equal(await scalar(db, `SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status='running'`), 0);
  const audit = await events(job);
  assert.deepEqual(audit.map(e => e.action), ['export_begin', 'shared_source_verified', 'shared_source_verified', 'export_finished']);
  assert.equal(audit.at(-1).details.full_site_complete, false);
  assert.equal(audit.at(-1).details.shared_verified, true);
  assert.deepEqual(audit.at(-1).details.shared_catalog, catalog);
  assert.doesNotMatch(JSON.stringify(audit), /RootPass|password_hash|job_token|token_hash|export_cancelled/);
  const logAfter = await call('get_employee_transfer_log', { p_admin_session_token: session });
  // Existing log excludes other subprotocols, but NOT shared-settings-v1. SQL40
  // must not rewrite it: its timestamp is only a finished export, not full-site
  // success. Coordinators must use the explicit scoped receipt, never this time.
  assert.equal(logAfter.last_export_at, state.finished_at);
  assert.equal(logAfter.running, null);
  assert.deepEqual(await capabilities(), expectedCapabilities(site));
  const next = await call('employee_export_products_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  assert.equal(next.success, true); assert.notEqual(next.job_id, job.job_id);
  await call('employee_export_products_verify', auth(next));
  assert.equal((await call('employee_products_close', auth(next))).success, true);
  assert.deepEqual(await businessSnapshot(), business);
  await rejectedClose(job, /invalid or expired/);
  await assert.rejects(call('get_employee_export_shared_page', { ...auth(job), p_table_key: 'admins' }), /invalid or expired/);
});

test('authenticated can close and close rereads the verification-written job summary rather than overwriting a stale receipt', async () => isolated(async () => {
  const job = await begin(); await verify(job);
  // Local technical-table instrumentation only: makes the real verifier's UPDATE
  // carry an observable new receipt, without replacing any existing function.
  await db.exec(`CREATE FUNCTION pg_temp.shared_close_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN NEW.summary:=NEW.summary||'{"reverify_receipt":"fresh-local-receipt"}'::jsonb; RETURN NEW; END; $$;
    CREATE TRIGGER shared_close_receipt BEFORE UPDATE OF summary ON private.employee_transfer_jobs
    FOR EACH ROW WHEN (NEW.status='running') EXECUTE FUNCTION pg_temp.shared_close_receipt();`);
  assert.deepEqual(await close(job, {}, 'authenticated'), RECEIPT);
  assert.equal((await jobState(job)).summary.reverify_receipt, 'fresh-local-receipt');
  assert.equal((await events(job)).at(-1).details.reverify_receipt, 'fresh-local-receipt');
}));

for (const marker of [undefined, null, false, 'true', 1, {}, []]) {
  test(`close rejects a missing/non-boolean verified marker ${JSON.stringify(marker)} without silently verifying`, async () => isolated(async () => {
    const job = await begin();
    if (marker !== undefined) await db.query(`UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('shared_verified',$2::jsonb) WHERE id=$1`,
      [job.job_id, JSON.stringify(marker)]);
    await rejectedClose(job, /has not been verified/);
  }));
}
const DRIFTS = [
  ['admins', `UPDATE public.admins SET username='branch-drift' WHERE id='${NEW.branch}'`],
  ['financial_admin_credentials', `UPDATE public.financial_admin_credentials SET password_hash='changed-local-hash' WHERE admin_id='${NEW.branch}'`],
  ['admin_groups', `UPDATE public.admin_groups SET name='Changed fixture' WHERE id='${group}'`],
  ['admin_group_members', `UPDATE public.admin_group_members SET created_at=created_at-interval '1 minute' WHERE id='${member}'`],
  ['admin_configs', `UPDATE public.admin_configs SET config_value='Changed fixture' WHERE admin_id='${NEW.branch}' AND config_type='company_name'`],
  ['system_configs', `UPDATE public.system_configs SET value='"Changed title"'::jsonb WHERE key='login_title'`],
  ['history_cleanup_config', `UPDATE public.history_cleanup_config SET retention_days=retention_days+1 WHERE table_name=(SELECT min(table_name) FROM public.history_cleanup_config)`],
];
for (const [key, sql] of DRIFTS) {
  test(`verified source drift in ${key} is detected again at close, with identical row counts and no partial finish`, async () => isolated(async () => {
    const job = await begin(); await verify(job);
    await db.exec(sql);
    const business = await businessSnapshot();
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_shared_rows($1)', [key]), job.catalog.tables.find(t => t.key === key).rows);
    await rejectedClose(job, /source data changed/);
    assert.deepEqual(await businessSnapshot(), business);
  }));
}
test('missing staged table after verification blocks close and retains remaining sensitive staging for explicit cancellation', async () => isolated(async () => {
  const job = await begin(); await verify(job);
  await db.query(`DELETE FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key='shared:admin_groups'`, [job.job_id]);
  await rejectedClose(job, /source data changed/);
}));

for (const protocol of [null, 'employee-v1', 'shared-settings-v2', 'products-v1', 'dispatch-submission-v1',
  'employee-identity-v1', 'employee-finance-v1', 'employee-activity-v1', 'employee-verification-v1',
  'site-notifications-v1', 'site-chat-v1', 'site-archives-v1']) {
  test(`close refuses another/missing export protocol ${protocol}`, async () => isolated(async () => {
    const job = await begin(); await verify(job);
    await db.query(`UPDATE private.employee_transfer_jobs SET options=$2::jsonb WHERE id=$1`,
      [job.job_id, JSON.stringify(protocol === null ? {} : { export_protocol: protocol })]);
    await rejectedClose(job, /not a shared settings export|protocol does not permit/);
  }));
}
test('an import job cannot use shared close even with a forged shared export protocol and verified marker', async () => isolated(async () => {
  const job = await begin(); await verify(job);
  await db.query(`UPDATE private.employee_transfer_jobs SET kind='import' WHERE id=$1`, [job.job_id]);
  await rejectedClose(job, /invalid or expired/);
}));
for (const reason of ['null-session', 'random-session', 'secondary', 'emergency', 'other-owner', 'revoked-session', 'expired-session', 'inactive-admin', 'demoted-admin']) {
  test(`close and capabilities enforce server session permissions for ${reason}`, async () => isolated(async () => {
    const job = await begin(); await verify(job);
    const token = { 'null-session': null, 'random-session': randomUUID(), secondary: branch, emergency, 'other-owner': otherRoot }[reason];
    if (reason === 'revoked-session') await db.query('UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE admin_id=$1', [NEW.root]);
    if (reason === 'expired-session') await db.query(`UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE admin_id=$1`, [NEW.root]);
    if (reason === 'inactive-admin') await db.query('UPDATE public.admins SET is_active=false WHERE id=$1', [NEW.root]);
    if (reason === 'demoted-admin') await db.query(`UPDATE public.admins SET role='secondary_admin' WHERE id=$1`, [NEW.root]);
    const args = { p_admin_session_token: token === undefined ? session : token };
    await rejectedClose(job, /session|permission|administrator|invalid or expired/i, args);
    if (reason === 'other-owner') assert.equal((await capabilities(args)).can_export, true);
    else await assert.rejects(capabilities(args), /session|permission|administrator/i);
  }));
}
for (const token of [null, randomUUID()]) {
  test(`close rejects ${token === null ? 'null' : 'unknown'} job token atomically`, async () => isolated(async () => {
    const job = await begin(); await verify(job);
    await rejectedClose(job, /invalid or expired/, { p_job_token: token });
  }));
}
for (const [field, age] of [['last_activity_at', '3 hours'], ['last_activity_at', '4 hours'], ['started_at', '12 hours'], ['started_at', '13 hours']]) {
  test(`close rejects expired job ${field} at ${age}`, async () => isolated(async () => {
    const job = await begin(); await verify(job);
    await db.query(`UPDATE private.employee_transfer_jobs SET ${field}=now()-interval '${age}' WHERE id=$1`, [job.job_id]);
    await rejectedClose(job, /invalid or expired/);
  }));
}
for (const status of ['cancelled', 'finished', 'failed', 'abandoned']) {
  test(`close cannot resurrect a ${status} job`, async () => isolated(async () => {
    const job = await begin(); await verify(job);
    await db.query('UPDATE private.employee_transfer_jobs SET status=$2 WHERE id=$1', [job.job_id, status]);
    await rejectedClose(job, /invalid or expired/);
  }));
}
test('service_role has no execute access even with a valid owner token', async () => isolated(async () => {
  const job = await begin(); await verify(job);
  await rejectedClose(job, /permission denied/, {}, 'service_role');
  await assert.rejects(capabilities({}, 'service_role'), /permission denied/);
}));
test('legacy full-site finish remains forbidden before/after verify; only the scoped close can finish shared', async () => isolated(async () => {
  const job = await begin();
  for (const verified of [false, true]) {
    if (verified) await verify(job);
    await assert.rejects(call('employee_export_finish', { ...auth(job), p_summary: { full_site_complete: true } }), /not a completed full-site export/);
    assert.equal((await jobState(job)).status, 'running');
  }
  assert.deepEqual(await close(job), RECEIPT);
  assert.equal((await jobState(job)).summary.full_site_complete, false);
}));

test('capabilities is a fixed seven-field read-only code declaration for both browser roles, not a success/import receipt', async () => {
  const before = await businessSnapshot();
  const technical = await scalar(db, `SELECT jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM private.employee_transfer_jobs j),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM private.employee_transfer_events e))`);
  const site = await scalar(db, 'SELECT site_id FROM private.employee_transfer_site');
  await db.exec('BEGIN READ ONLY'); inside = true;
  try {
    for (const role of ['anon', 'authenticated']) assert.deepEqual(await capabilities({}, role), expectedCapabilities(site));
    await db.exec('COMMIT');
  } catch (error) { await db.exec('ROLLBACK'); throw error; } finally { inside = false; }
  assert.deepEqual(await businessSnapshot(), before);
  assert.deepEqual(await scalar(db, `SELECT jsonb_build_object('jobs',(SELECT jsonb_agg(to_jsonb(j) ORDER BY id) FROM private.employee_transfer_jobs j),
    'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM private.employee_transfer_events e))`), technical);
});
test('close preserves dirty maintenance and cannot promote a forged full-site summary into a release receipt', async () => isolated(async () => {
  const job = await begin(); await verify(job);
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=summary||'{"full_site_complete":true,"scope":"site","local_summary_note":"keep"}'::jsonb WHERE id=$1`, [job.job_id]);
  // Synthetic dirty maintenance owned by this local fixture; no production
  // maintenance entry/release RPC, account enablement or write permit is used.
  await db.query(`INSERT INTO private.employee_transfer_maintenance(job_id,admin_id,plan_hash,target_hash,entered_at,dirty)
    VALUES($1,$2,$3,$4,now(),true)`, [job.job_id, NEW.root, 'a'.repeat(64), 'b'.repeat(64)]);
  const business = await businessSnapshot();
  assert.equal((await capabilities()).can_import, false);
  assert.deepEqual(await close(job), RECEIPT);
  const state = await jobState(job);
  assert.equal(state.summary.scope, 'shared-settings'); assert.equal(state.summary.full_site_complete, false);
  assert.equal(state.summary.local_summary_note, 'keep');
  assert.equal(await scalar(db, 'SELECT dirty FROM private.employee_transfer_maintenance'), true);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits'), 0);
  assert.deepEqual(await businessSnapshot(), business);
}));
test('capabilities never refreshes a running job heartbeat or clears staging/audit', async () => isolated(async () => {
  const job = await begin();
  await db.query(`UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '1 minute' WHERE id=$1`, [job.job_id]);
  const before = { job: await jobState(job), staged: await staging(job), events: await events(job) };
  assert.equal((await capabilities()).can_export, true);
  assert.deepEqual({ job: await jobState(job), staged: await staging(job), events: await events(job) }, before);
}));
for (const signature of REQUIRED_RPCS) {
  test(`missing exact RPC signature fails export capability closed: ${signature}`, async () => isolated(async () => {
    assert.notEqual(await scalar(db, 'SELECT to_regprocedure($1)::text', [signature]), null);
    await db.exec(`ALTER FUNCTION ${signature} RENAME TO shared_close_missing_rpc_fixture`);
    const site = await scalar(db, 'SELECT site_id FROM private.employee_transfer_site');
    assert.deepEqual(await capabilities(), expectedCapabilities(site, [signature]));
  }));
}
test('missing RPCs accumulate in protocol order, and an unrelated same-name overload cannot satisfy the contract', async () => isolated(async () => {
  const missing = [REQUIRED_RPCS[2], REQUIRED_RPCS[6], REQUIRED_RPCS.at(-1)];
  for (const [i, signature] of missing.entries()) await db.exec(`ALTER FUNCTION ${signature} RENAME TO shared_close_missing_${i}`);
  await db.exec(`CREATE FUNCTION public.employee_export_shared_begin(text,text) RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$`);
  const site = await scalar(db, 'SELECT site_id FROM private.employee_transfer_site');
  assert.deepEqual(await capabilities(), expectedCapabilities(site, missing));
}));
test('missing optional legacy employee-only exporter does not block the dedicated serial export protocol', async () => isolated(async () => {
  await db.exec('ALTER FUNCTION public.employee_export_begin(uuid,text,jsonb) RENAME TO shared_close_legacy_export_fixture');
  assert.equal((await capabilities()).can_export, true);
}));
test('a previously imported namespace still blocks native archives; capabilities does not pretend to be a data preflight', async () => isolated(async () => {
  const priorJob = randomUUID();
  await db.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options)
    VALUES($1,'import',$2,'root','synthetic-local-archive-token','cancelled','{}')`, [priorJob, NEW.root]);
  // Minimal persisted-row fixture only: no claim this is a verified archive import.
  await db.query(`INSERT INTO private.employee_transfer_archive_records(source_site_id,package_id,table_key,source_id,body,source_line,job_id)
    VALUES($1,$2,'deleted_employee_accounts','fixture','{}','{}',$3)`, [randomUUID(), randomUUID(), priorJob]);
  assert.equal((await capabilities()).can_export, true);
  const job = await begin(); await verify(job); assert.deepEqual(await close(job), RECEIPT);
  await assert.rejects(call('employee_export_archives_begin', { p_admin_session_token: session,
    p_admin_password: PASSWORDS.root, p_package_id: randomUUID() }), /namespace-preserving re-export protocol/);
  assert.equal(await scalar(db, `SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status='running'`), 0);
}));
