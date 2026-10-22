import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  EXPECTED_REPLAY_FAILURES, assertExpectedReplayFailures, replayMigrations,
} from './support/replay-migrations.mjs';
import {
  adminLogin, createSites, rows, rpc, scalar,
} from './support/transfer-harness.mjs';
import { NEW, PASSWORDS, buildNewSite } from './support/transfer-fixtures.mjs';

const criticalMigrations = [
  '20261102000000_employee_data_transfer_foundation.sql',
  '20261102000001_employee_data_export.sql',
  '20261102000002_employee_data_import_prepare.sql',
  '20261102000003_employee_data_import_write.sql',
  '20261102000004_harden_employee_transfer_triggers.sql',
  '20261102000005_export_shared_site_settings.sql',
  '20261102000006_import_shared_site_settings.sql',
  '20261102000007_replace_shared_site_settings.sql',
  '20261102000008_transfer_product_catalog.sql',
  '20261102000009_export_dispatch_submission_data.sql',
  '20261102000010_prepare_dispatch_submission_import.sql',
  '20261102000011_guard_transfer_maintenance.sql',
  '20261102000012_restore_dispatch_configuration.sql',
  '20261102000013_restore_valid_submission_data.sql',
  '20261102000014_export_stage_employee_identities.sql',
  '20261102000015_restore_employee_identities.sql',
  '20261102000016_restore_dispatch_dependencies.sql',
  '20261102000017_export_stage_employee_finance.sql',
  '20261102000018_restore_employee_finance.sql',
  '20261102000019_export_stage_employee_activity.sql',
  '20261102000020_restore_employee_activity.sql',
  '20261102000021_export_stage_employee_verification.sql',
  '20261102000022_restore_employee_verification_media.sql',
  '20261102000023_export_stage_site_notifications.sql',
  '20261102000024_check_site_notification_links.sql',
  '20261102000025_prepare_notification_configuration.sql',
  '20261102000026_transfer_notification_media.sql',
  '20261102000027_restore_site_notifications.sql',
  '20261102000028_export_stage_site_chat.sql',
  '20261102000029_plan_site_chat_merge.sql',
  '20261102000030_prepare_chat_merge.sql',
  '20261102000031_transfer_chat_media.sql',
  '20261102000032_restore_site_chat.sql',
  '20261102000033_transfer_readonly_archives.sql',
  '20261102000034_restore_readonly_archives.sql',
  '20261102000035_transfer_archive_evidence.sql',
  '20261102000036_list_transferred_archives.sql',
  '20261102000037_plan_employee_replacement.sql',
  '20261102000038_reexport_archive_namespaces.sql',
  '20261102000039_export_employee_replacement_backup.sql',
  '20261102000040_close_shared_export.sql',
  '20261102000041_snapshot_site_export.sql',
  '20261102000042_stop_owned_export.sql',
  '20261102000043_preserve_transfer_announcements.sql',
  '20261102000044_preflight_site_restore.sql',
  '20261102000045_verify_site_prerequisites.sql',
  '20261102000046_backup_employee_before_restore.sql',
  '20261102000047_backup_employee_media.sql',
  '20261102000048_reserve_employee_identities.sql',
  '20261102000049_restore_mapped_employee_identities.sql',
  '20261102000050_restore_mapped_dispatch_dependencies.sql',
];
const expectedFiles = EXPECTED_REPLAY_FAILURES.map(item => item.file);
const expectedFailures = EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message }));
const report = () => ({ files: [...expectedFiles, ...criticalMigrations], failures: structuredClone(expectedFailures) });
const workerFlag = '--employee-transfer-replay-worker';

function mismatch(result, kind, file, options) {
  assert.throws(() => assertExpectedReplayFailures(result, options), error => {
    assert.ok(error.issues.some(issue => issue.kind === kind && issue.file === file), error.message);
    assert.match(error.message, /Replay baseline mismatch/);
    assert.equal(error.failures, result.failures);
    return true;
  });
}

// 这些替身仅用于注入资源生命周期异常，不用于证明 SQL 成功；下面的完整回放不使用它们。
function resource({ exec = async () => {}, dump = async () => new Blob(), ready = async () => {} } = {}) {
  return {
    closes: 0,
    dumps: 0,
    exec,
    get waitReady() { return ready(); },
    async dumpDataDir() { this.dumps++; return dump(); },
    async close() { this.closes++; },
  };
}

// 此清单验证迁移相关私有表的RLS/直连权限，不是可丢弃的任务metadata清单。
// archive_records保存来源namespace的业务档案，必须纳入；分类另由scope库存审核。
const transferTables = [
  'employee_transfer_site', 'employee_transfer_jobs', 'employee_transfer_events',
  'employee_transfer_staging', 'employee_transfer_excluded_columns', 'employee_transfer_trigger_policy',
  'employee_transfer_shared_backups', 'employee_transfer_notification_backups', 'employee_transfer_chat_backups', 'employee_transfer_maintenance', 'employee_transfer_write_permits',
  'employee_transfer_archive_records',
];
const archivePublicFunctions = [
  'employee_export_archives_begin(uuid,text,uuid)', 'get_employee_export_archives_page(uuid,uuid,text,text,integer)',
  'employee_export_archives_verify(uuid,uuid)', 'employee_export_archives_close(uuid,uuid)',
  'employee_import_archives_bind(uuid,uuid,jsonb)', 'employee_import_archives_stage(uuid,uuid,text,integer,text)',
  'get_employee_import_archives_plan(uuid,uuid)', 'employee_import_archives_begin(uuid,uuid,text)',
  'employee_import_archives_chunk(uuid,uuid,text,integer)', 'employee_import_archives_verify(uuid,uuid)',
  'get_employee_import_archives_status(uuid,uuid)', 'get_employee_transferred_archive_page(uuid,uuid,uuid,text,text,integer)',
];
const archiveReadOnlyFunctions = new Set([
  'get_employee_import_archives_plan(uuid,uuid)', 'get_employee_import_archives_status(uuid,uuid)',
  'get_employee_transferred_archive_page(uuid,uuid,uuid,text,text,integer)',
]);
const archivePrivateFunctions = [
  'employee_transfer_archives_keys()', 'employee_transfer_archives_spec()',
  'employee_transfer_archives_relation(text)', 'employee_transfer_archives_schema()',
  'employee_transfer_archives_redact(jsonb,integer)', 'employee_transfer_archives_cursor(text,jsonb)',
  'employee_transfer_archives_query(text)', 'employee_transfer_check_archives_row(text,jsonb)',
  'employee_transfer_check_archives_catalog(jsonb)', 'employee_transfer_archives_catalog(uuid)',
  'employee_transfer_archives_owner(private.employee_transfer_jobs)', 'employee_transfer_archives_input(uuid,text)',
  'employee_transfer_check_archives_input(private.employee_transfer_jobs)', 'employee_transfer_archives_lines(uuid,text)',
  'employee_transfer_archives_namespace_hash(uuid,uuid)', 'employee_transfer_archives_conflicts(private.employee_transfer_jobs)',
  'employee_transfer_archives_plan(private.employee_transfer_jobs)', 'employee_transfer_archives_status(private.employee_transfer_jobs)',
  'employee_transfer_archives_persisted(private.employee_transfer_jobs)',
];
const publicFunctions = [
  'employee_transfer_cancel(uuid,uuid)', 'get_employee_transfer_log(uuid,integer)',
  'employee_export_begin(uuid,text,jsonb)', 'get_employee_export_directory(uuid,uuid)',
  'employee_export_shared_begin(uuid,text)', 'get_employee_export_shared_catalog(uuid,uuid)',
  'get_employee_export_shared_page(uuid,uuid,text,text,integer)', 'employee_export_shared_verify(uuid,uuid)',
  'get_employee_export_preflight(uuid,uuid,uuid[],uuid[])',
  'get_employee_export_employee_list(uuid,uuid,uuid,integer,uuid[],uuid[])',
  'get_employee_export_core(uuid,uuid,uuid)', 'get_employee_export_rows(uuid,uuid,uuid,text,text,integer)',
  'get_employee_export_fingerprint(uuid,uuid,uuid)', 'employee_export_finish(uuid,uuid,jsonb)',
  'get_employee_import_capabilities(uuid)', 'get_employee_import_dry_run(uuid,jsonb,jsonb)',
  'employee_import_begin(uuid,text,jsonb,jsonb)', 'employee_import_apply_roles(uuid,uuid,jsonb)',
  'employee_import_stage_chunk(uuid,uuid,uuid,text,integer,jsonb)',
  'employee_import_apply_core(uuid,uuid,uuid,jsonb)', 'employee_import_rows_batch(uuid,uuid,uuid,text,jsonb)',
  'employee_import_chat_batch(uuid,uuid,uuid,text,jsonb)',
  'employee_import_finalize_employee(uuid,uuid,uuid,jsonb)', 'get_employee_import_verify(uuid,uuid,uuid[])',
  'employee_import_finish(uuid,uuid,jsonb)',
  'employee_import_shared_begin(uuid,text,uuid,jsonb)', 'employee_import_shared_stage(uuid,uuid,text,integer,text)',
  'get_employee_import_shared_dry_run(uuid,uuid)', 'employee_import_shared_apply(uuid,uuid,text)',
  'employee_import_shared_replace_begin(uuid,text,uuid,jsonb)', 'get_employee_import_shared_replace_dry_run(uuid,uuid)',
  'get_employee_import_shared_backup(uuid,uuid)', 'get_employee_import_shared_backup_page(uuid,uuid,text,text,integer)',
  'employee_import_shared_backup_append(uuid,uuid,text,integer,text)', 'employee_import_shared_backup_seal(uuid,uuid,text,text,integer)',
  'get_employee_shared_saved_backup_chunk(uuid,uuid,integer)', 'employee_import_shared_replace_apply(uuid,uuid,text)',
  'employee_export_products_begin(uuid,text)', 'get_employee_export_products_page(uuid,uuid,text,integer)',
  'employee_export_products_verify(uuid,uuid)', 'employee_import_products_begin(uuid,text,uuid,jsonb)',
  'employee_import_products_stage(uuid,uuid,integer,text)', 'get_employee_import_products_dry_run(uuid,uuid)',
  'get_employee_import_products_backup(uuid,uuid)', 'get_employee_import_products_backup_page(uuid,uuid,text,integer)',
  'employee_import_products_backup_append(uuid,uuid,text,integer,text)', 'employee_import_products_backup_seal(uuid,uuid,text,text,integer)',
  'get_employee_products_saved_backup_chunk(uuid,uuid,integer)', 'employee_import_products_apply(uuid,uuid,text)',
  'employee_products_close(uuid,uuid)',
  'employee_export_dispatch_begin(uuid,text)', 'get_employee_export_dispatch_page(uuid,uuid,text,uuid,integer)',
  'employee_export_dispatch_verify(uuid,uuid)', 'employee_export_dispatch_close(uuid,uuid)',
  'get_employee_import_dispatch_preflight(uuid)',
  'employee_import_dispatch_begin(uuid,text,uuid,jsonb)', 'employee_import_dispatch_stage(uuid,uuid,text,integer,text)',
  'get_employee_import_dispatch_dry_run(uuid,uuid)', 'get_employee_import_dispatch_backup(uuid,uuid)',
  'get_employee_import_dispatch_backup_page(uuid,uuid,text,text,integer)',
  'employee_import_dispatch_backup_append(uuid,uuid,text,integer,text)',
  'employee_import_dispatch_backup_seal(uuid,uuid,text,text,integer)', 'get_employee_dispatch_saved_backup_chunk(uuid,uuid,integer)',
  'employee_import_dispatch_enter_maintenance(uuid,uuid,text,text,text)',
  'get_employee_transfer_maintenance(uuid)', 'employee_transfer_leave_maintenance(uuid,uuid,text,text)',
  'get_employee_import_dispatch_configuration_plan(uuid,uuid)', 'employee_import_dispatch_apply_configuration(uuid,uuid,text)',
  'employee_import_dispatch_valid_begin(uuid,uuid,text)', 'employee_import_dispatch_valid_chunk(uuid,uuid,integer)',
  'employee_import_dispatch_valid_verify(uuid,uuid)',
  'employee_export_identity_begin(uuid,text,uuid)', 'get_employee_export_identity_page(uuid,uuid,text,uuid,integer)',
  'employee_export_identity_verify(uuid,uuid)', 'employee_export_identity_close(uuid,uuid)',
  'employee_import_identity_bind(uuid,uuid,jsonb)', 'employee_import_identity_stage(uuid,uuid,text,integer,text)',
  'get_employee_import_identity_plan(uuid,uuid)', 'employee_import_identity_begin(uuid,uuid,text)',
  'employee_import_identity_chunk(uuid,uuid,text,integer)', 'employee_import_identity_verify(uuid,uuid)',
  'get_employee_import_dispatch_dependency_plan(uuid,uuid)', 'employee_import_dispatch_dependency_begin(uuid,uuid,text)',
  'employee_import_dispatch_dependency_chunk(uuid,uuid,text,integer)', 'employee_import_dispatch_dependency_verify(uuid,uuid)',
  'employee_export_finance_begin(uuid,text,uuid)', 'get_employee_export_finance_page(uuid,uuid,text,text,integer)',
  'employee_export_finance_verify(uuid,uuid)', 'employee_export_finance_close(uuid,uuid)',
  'employee_import_finance_bind(uuid,uuid,jsonb)', 'employee_import_finance_stage(uuid,uuid,text,integer,text)',
  'get_employee_import_finance_plan(uuid,uuid)', 'employee_import_finance_apply(uuid,uuid,uuid,text)', 'employee_import_finance_verify(uuid,uuid)',
  'employee_export_activity_begin(uuid,text,uuid)', 'get_employee_export_activity_page(uuid,uuid,text,text,integer)',
  'employee_export_activity_verify(uuid,uuid)', 'employee_export_activity_close(uuid,uuid)',
  'employee_import_activity_bind(uuid,uuid,jsonb)', 'employee_import_activity_stage(uuid,uuid,text,integer,text)',
  'get_employee_import_activity_plan(uuid,uuid)', 'employee_import_activity_apply(uuid,uuid,uuid,text)', 'employee_import_activity_verify(uuid,uuid)',
  'employee_export_verification_begin(uuid,text,uuid)', 'get_employee_export_verification_page(uuid,uuid,text,text,integer)',
  'employee_export_verification_verify(uuid,uuid)', 'employee_export_verification_close(uuid,uuid)',
  'employee_import_verification_bind(uuid,uuid,jsonb)', 'employee_import_verification_stage(uuid,uuid,text,integer,text)',
  'get_employee_transfer_verification_media(uuid,uuid,text)', 'employee_import_verification_media_bind(uuid,uuid,jsonb)',
  'get_employee_import_verification_plan(uuid,uuid)', 'employee_import_verification_apply(uuid,uuid,uuid,text)', 'employee_import_verification_verify(uuid,uuid)',
  'employee_export_notifications_begin(uuid,text,uuid)', 'get_employee_export_notifications_page(uuid,uuid,text,text,integer)',
  'employee_export_notifications_verify(uuid,uuid)', 'employee_export_notifications_close(uuid,uuid)',
  'employee_import_notifications_bind(uuid,uuid,jsonb)', 'employee_import_notifications_stage(uuid,uuid,text,integer,text)',
  'get_employee_import_notifications_plan(uuid,uuid)',
  'get_employee_import_notification_configuration_plan(uuid,uuid)', 'employee_import_notification_backup_prepare(uuid,uuid,text)',
  'get_employee_import_notification_backup_page(uuid,uuid,uuid,text,text,integer)',
  'employee_import_notification_backup_verify(uuid,uuid,uuid)', 'employee_import_notification_backup_append(uuid,uuid,uuid,integer,text)',
  'employee_import_notification_backup_seal(uuid,uuid,uuid,text,integer)', 'get_employee_notification_saved_backup_chunk(uuid,uuid,integer)',
  'get_employee_transfer_notification_media(uuid,uuid,text)', 'employee_import_notification_media_bind(uuid,uuid,jsonb)',
  'employee_import_notifications_begin(uuid,uuid,text)', 'employee_import_notifications_chunk(uuid,uuid,integer)',
  'employee_import_notifications_verify(uuid,uuid)', 'get_employee_import_notifications_restore_status(uuid,uuid)',
  'employee_export_chat_begin(uuid,text,uuid)', 'get_employee_export_chat_page(uuid,uuid,text,text,integer)',
  'employee_export_chat_verify(uuid,uuid)', 'employee_export_chat_close(uuid,uuid)',
  'employee_import_chat_bind(uuid,uuid,jsonb)', 'employee_import_chat_stage(uuid,uuid,text,integer,text)',
  'get_employee_import_chat_plan(uuid,uuid)',
  'get_employee_import_chat_merge_plan(uuid,uuid,jsonb)', 'employee_import_chat_backup_prepare(uuid,uuid,text,jsonb)',
  'get_employee_import_chat_backup_page(uuid,uuid,uuid,text,text,integer)', 'employee_import_chat_backup_verify(uuid,uuid,uuid)',
  'employee_import_chat_backup_append(uuid,uuid,uuid,integer,text)', 'employee_import_chat_backup_seal(uuid,uuid,uuid,text,integer)',
  'get_employee_chat_saved_backup_chunk(uuid,uuid,integer)', 'get_employee_transfer_chat_media(uuid,uuid,text)',
  'employee_import_chat_media_bind(uuid,uuid,jsonb)', 'employee_import_chat_begin(uuid,uuid,text)',
  'employee_import_chat_chunk(uuid,uuid,integer)', 'employee_import_chat_verify(uuid,uuid)', 'get_employee_import_chat_restore_status(uuid,uuid)',
  'employee_import_identity_reservation_status(uuid,uuid,uuid)',
  'employee_import_identity_reserve(uuid,uuid,uuid,text,text)',
  'employee_import_mapped_identity_plan(uuid,uuid,uuid)', 'employee_import_mapped_identity_status(uuid,uuid,uuid)',
  'employee_import_mapped_identity_core(uuid,uuid,uuid,text)', 'employee_import_mapped_identity_orders(uuid,uuid,uuid,integer)',
  'employee_import_mapped_identity_verify(uuid,uuid,uuid)',
  'employee_import_mapped_dependency_plan(uuid,uuid)', 'employee_import_mapped_dependency_status(uuid,uuid)',
  'employee_import_mapped_dependency_begin(uuid,uuid,text)', 'employee_import_mapped_dependency_chunk(uuid,uuid,text,integer)',
  'employee_import_mapped_dependency_verify(uuid,uuid)',
  ...archivePublicFunctions,
];
const serviceOnlyFunctions = [
  'employee_transfer_verification_media_authorize(uuid,uuid,text,text)',
  'employee_transfer_verification_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
  'employee_transfer_notification_media_authorize(uuid,uuid,text,text)',
  'employee_transfer_notification_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
  'employee_transfer_chat_media_authorize(uuid,uuid,text,text)',
  'employee_transfer_chat_media_commit(uuid,uuid,text,text,integer,text,text,text,bigint)',
];

async function checkCatalog(db) {
  for (const name of transferTables) {
    const table = await rows(db, `SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass($1)`, [`private.${name}`]);
    assert.equal(table.length, 1, `missing private.${name}`);
    assert.equal(table[0].relrowsecurity, true, `RLS private.${name}`);
  }
  for (const name of publicFunctions) {
    const functions = await rows(db, `SELECT prosecdef, proconfig, provolatile,
      has_function_privilege('anon', oid, 'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated', oid, 'EXECUTE') AS authenticated_execute,
      has_function_privilege('service_role', oid, 'EXECUTE') AS service_role_execute,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner)))
        WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc WHERE oid = to_regprocedure($1)`, [`public.${name}`]);
    assert.equal(functions.length, 1, `missing public.${name}`);
    assert.equal(functions[0].prosecdef, true, name);
    assert.ok(functions[0].proconfig.includes('search_path=pg_catalog, public, private, pg_temp'), name);
    assert.equal(functions[0].anon_execute, true, name);
    assert.equal(functions[0].authenticated_execute, true, name);
    assert.equal(functions[0].public_execute, false, name);
    if (archivePublicFunctions.includes(name) || name.startsWith('employee_import_identity_reserv') || name.startsWith('employee_import_mapped_identity_') || name.startsWith('employee_import_mapped_dependency_')) {
      assert.equal(functions[0].service_role_execute, false, name);
    }
    if (archiveReadOnlyFunctions.has(name) || ['employee_import_identity_reservation_status(uuid,uuid,uuid)',
      'employee_import_mapped_identity_plan(uuid,uuid,uuid)', 'employee_import_mapped_identity_status(uuid,uuid,uuid)',
      'employee_import_mapped_dependency_plan(uuid,uuid)', 'employee_import_mapped_dependency_status(uuid,uuid)'].includes(name)) {
      assert.equal(functions[0].provolatile, 's', `${name} must be STABLE, not a heartbeat-writing read`);
    }
  }
  const archiveRpcs = await rows(db, `SELECT oid::regprocedure::text AS signature FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace
      AND (proname LIKE '%\\_archives\\_%' ESCAPE '\\' OR proname = 'get_employee_transferred_archive_page')`);
  assert.equal(archivePublicFunctions.length, 12);
  assert.deepEqual(archiveRpcs.map(item => item.signature).sort(), [...archivePublicFunctions].sort(),
    'all actual archive RPCs, including overloads, require explicit security review');
  for (const name of archivePrivateFunctions) {
    const helpers = await rows(db, `SELECT oid, prosecdef, proconfig, provolatile,
      has_function_privilege('service_role', oid, 'EXECUTE') AS service_role_execute
      FROM pg_proc WHERE oid = to_regprocedure($1)`, [`private.${name}`]);
    assert.equal(helpers.length, 1, `missing private.${name}`);
    assert.equal(helpers[0].prosecdef, true, name);
    assert.ok(helpers[0].proconfig.includes('search_path=pg_catalog, public, private, pg_temp'), name);
    assert.ok(['s', 'i'].includes(helpers[0].provolatile), `${name} must not write from read-only archive RPCs`);
    assert.equal(helpers[0].service_role_execute, false, `service_role private.${name}`);
  }
  const archiveHelpers = await rows(db, `SELECT oid::regprocedure::text AS signature FROM pg_proc
    WHERE pronamespace = 'private'::regnamespace
      AND (proname LIKE 'employee_transfer_archives_%' OR proname LIKE 'employee_transfer_check_archives_%')`);
  assert.deepEqual(archiveHelpers.map(item => item.signature).sort(), archivePrivateFunctions.map(name => `private.${name}`).sort(),
    'every private archive helper must be checked, not just a helper-count increase');
  for (const name of serviceOnlyFunctions) {
    const functions = await rows(db, `SELECT prosecdef, proconfig,
      has_function_privilege('anon', oid, 'EXECUTE') AS anon_execute,
      has_function_privilege('authenticated', oid, 'EXECUTE') AS authenticated_execute,
      has_function_privilege('service_role', oid, 'EXECUTE') AS service_role_execute,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner)))
        WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc WHERE oid = to_regprocedure($1)`, [`public.${name}`]);
    assert.equal(functions.length, 1, `missing public.${name}`);
    assert.equal(functions[0].prosecdef, true, name);
    assert.ok(functions[0].proconfig.includes('search_path=pg_catalog, public, private, pg_temp'), name);
    assert.equal(functions[0].anon_execute, false, name);
    assert.equal(functions[0].authenticated_execute, false, name);
    assert.equal(functions[0].public_execute, false, name);
    assert.equal(functions[0].service_role_execute, true, name);
  }
  const helpers = await rows(db, `SELECT oid, proname,
    EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner)))
      WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace = 'private'::regnamespace AND proname LIKE 'employee_transfer_%'`);
  assert.ok(helpers.length >= 20, 'transfer private helper functions must exist');
  for (const helper of helpers) assert.equal(helper.public_execute, false, helper.proname);
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await scalar(db, 'SELECT has_schema_privilege($1, $2, $3)', [role, 'private', 'USAGE']), false);
    for (const name of transferTables) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
        assert.equal(await scalar(db, 'SELECT has_table_privilege($1, $2, $3)', [role, `private.${name}`, privilege]), false,
          `${role} ${privilege} private.${name}`);
      }
    }
    for (const helper of helpers) {
      assert.equal(await scalar(db, 'SELECT has_function_privilege($1, $2::oid, $3)', [role, helper.oid, 'EXECUTE']), false,
        `${role} private.${helper.proname}`);
    }
    await db.exec(`SET ROLE ${role}`);
    try {
      for (const name of transferTables) {
        await assert.rejects(db.query(`SELECT * FROM private.${name} LIMIT 0`), error => error.code === '42501');
      }
    } finally {
      await db.exec('RESET ROLE');
    }
  }
  const archiveTable = 'private.employee_transfer_archive_records';
  for (const role of ['anon', 'authenticated', 'service_role']) {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      assert.equal(await scalar(db, 'SELECT has_table_privilege($1, $2, $3)', [role, archiveTable, privilege]), false,
        `${role} ${privilege} ${archiveTable}`);
    }
    assert.equal(await scalar(db, "SELECT has_any_column_privilege($1, $2, 'SELECT, INSERT, UPDATE, REFERENCES')", [role, archiveTable]), false,
      `${role} must not have column-level archive grants`);
  }
  await db.exec('SET ROLE service_role');
  try {
    await assert.rejects(db.query(`SELECT * FROM ${archiveTable} LIMIT 0`), error => error.code === '42501');
  } finally {
    await db.exec('RESET ROLE');
  }
  const guardedTables = await scalar(db, 'SELECT private.employee_transfer_guarded_tables()');
  assert.equal(guardedTables.filter(name => name === archiveTable).length, 1,
    'namespaced business archives must be guarded, not excluded with technical backups');
  const guards = await rows(db, `SELECT tgenabled, tgtype, tgfoid::regprocedure::text AS function
    FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal AND tgname = 'zz_employee_transfer_maintenance'`, [archiveTable]);
  assert.deepEqual(guards, [{ tgenabled: 'A', tgtype: 62, function: 'private.employee_transfer_guard_write()' }],
    'archive records require the ALWAYS statement guard for INSERT/UPDATE/DELETE/TRUNCATE');
  await db.exec('SELECT private.employee_transfer_assert_maintenance_guards()');
  await db.exec('BEGIN');
  try {
    await db.exec(`ALTER TABLE ${archiveTable} DISABLE TRIGGER zz_employee_transfer_maintenance`);
    await assert.rejects(db.query('SELECT private.employee_transfer_assert_maintenance_guards()'),
      /Unreviewed employee transfer maintenance inventory or guards\./,
      'fixed maintenance manifest must notice a disabled archive guard');
  } finally {
    await db.exec('ROLLBACK');
  }
  await db.exec('SELECT private.employee_transfer_assert_maintenance_guards()');
}

// 仅验证真实 SQL 基线与权限，不等同于全站搬迁验收。
async function exerciseRealReplay() {
  const sites = await createSites({ log: console.log });
  const { oldSite, newSite, files, failures, validation } = sites;
  try {
    const diskFiles = (await readdir(new URL('../migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
    assert.deepEqual(files, diskFiles, 'must replay every migration, including future additions');
    assert.equal(files.length, 577, 'migration baseline changed: review all additions, never expand known failures');
    assert.deepEqual(failures, expectedFailures);
    assert.equal(validation.freshDatabaseVerified, false);
    for (const file of criticalMigrations) {
      assert.ok(files.includes(file));
      assert.ok(!failures.some(failure => failure.file === file), `${file} must succeed`);
    }
    await checkCatalog(oldSite);
    await checkCatalog(newSite);

    const sourceSite = await scalar(oldSite, 'SELECT site_id FROM private.employee_transfer_site');
    assert.equal(await scalar(newSite, 'SELECT site_id FROM private.employee_transfer_site'), sourceSite,
      'dump clones intentionally have identical site identity');
    await buildNewSite(oldSite);
    await buildNewSite(newSite);
    const oldSession = await adminLogin(oldSite, 'root', PASSWORDS.root);
    const newSession = await adminLogin(newSite, 'root', PASSWORDS.root);
    const branchSession = await adminLogin(newSite, 'branch', PASSWORDS.branch);
    await assert.rejects(rpc(newSite, 'get_employee_import_capabilities', { p_admin_session_token: randomUUID() }),
      /Financial administrator session is invalid or expired\./);
    await assert.rejects(rpc(newSite, 'get_employee_import_capabilities', { p_admin_session_token: branchSession }),
      /Super administrator permission is required\./);
    assert.equal(await scalar(newSite, 'SELECT current_user'), 'postgres', 'RPC role must be reset even on failure');

    const exported = await rpc(oldSite, 'employee_export_begin', {
      p_admin_session_token: oldSession, p_admin_password: PASSWORDS.root,
    });
    assert.equal(exported.success, true);
    const directory = await rpc(oldSite, 'get_employee_export_directory', {
      p_admin_session_token: oldSession, p_job_token: exported.job_token,
    });
    assert.equal(directory.site_id, sourceSite);
    assert.ok(directory.admins.some(admin => admin.id === NEW.root));
    const cancelledExport = await rpc(oldSite, 'employee_transfer_cancel', {
      p_admin_session_token: oldSession, p_job_token: exported.job_token,
    });
    assert.equal(cancelledExport.cancelled, true);

    const manifest = { source_site_id: sourceSite, employees: [], customers: [] };
    const dryRun = () => rpc(newSite, 'get_employee_import_dry_run', {
      p_admin_session_token: newSession, p_manifest: manifest,
    });
    const beginImport = () => rpc(newSite, 'employee_import_begin', {
      p_admin_session_token: newSession, p_admin_password: PASSWORDS.root,
      p_decisions: {}, p_summary: { source_site_id: sourceSite },
    });
    assert.equal((await dryRun()).same_site, true);
    await assert.rejects(beginImport(), /created by this same site/);
    assert.equal(await scalar(newSite, "SELECT count(*)::int FROM private.employee_transfer_jobs WHERE status = 'running'"), 0);

    // 仅测试在此显式模拟独立新站身份；不在 harness 内偷偷改 ID 或关闭同站检查。
    const targetSite = randomUUID();
    assert.notEqual(targetSite, sourceSite);
    await newSite.query('UPDATE private.employee_transfer_site SET site_id = $1', [targetSite]);
    assert.equal(await scalar(oldSite, 'SELECT site_id FROM private.employee_transfer_site'), sourceSite);
    assert.equal((await dryRun()).same_site, false);
    const capabilities = await rpc(newSite, 'get_employee_import_capabilities', { p_admin_session_token: newSession });
    assert.equal(capabilities.site_id, targetSite);
    assert.deepEqual(capabilities.unreviewed_triggers, [], 'do not bypass trigger review to make import begin pass');
    const imported = await beginImport();
    assert.equal(imported.success, true);
    const employeeId = randomUUID();
    const staged = await rpc(newSite, 'employee_import_stage_chunk', {
      p_admin_session_token: newSession, p_job_token: imported.job_token, p_employee_id: employeeId,
      p_table_key: 'ledger', p_chunk_no: 0, p_rows: [],
    });
    assert.equal(staged.success, true);
    assert.equal(staged.rows, 0);
    await assert.rejects(rpc(newSite, 'employee_import_apply_core', {
      p_admin_session_token: newSession, p_job_token: imported.job_token, p_employee_id: employeeId, p_expected: {},
    }), /was not staged/);
    await assert.rejects(rpc(newSite, 'employee_import_rows_batch', {
      p_admin_session_token: newSession, p_job_token: imported.job_token, p_employee_id: employeeId,
      p_table_key: 'orders', p_rows: [],
    }), /was not created by the running import task/);
    assert.equal(await scalar(newSite, 'SELECT count(*)::int FROM public.users WHERE id = $1', [employeeId]), 0);
    assert.equal(await scalar(newSite, 'SELECT count(*)::int FROM private.employee_transfer_staging'), 1);
    const cancelledImport = await rpc(newSite, 'employee_transfer_cancel', {
      p_admin_session_token: newSession, p_job_token: imported.job_token,
    });
    assert.equal(cancelledImport.cancelled, true);
    assert.equal(await scalar(newSite, 'SELECT count(*)::int FROM private.employee_transfer_staging'), 0);
    console.log(`Baseline verified: ${files.length} attempted, ${failures.length} expected failures retained; NOT a clean/full-site migration pass.`);
  } finally {
    const closed = await Promise.allSettled([oldSite.close(), newSite.close()]);
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  }
}

if (process.argv.includes(workerFlag)) {
  // 子进程只运行真实集成检查，父进程可硬终止超时，避免 WASM/连接卡住整套测试。
  await exerciseRealReplay();
} else {
  test('validator accepts exactly the reviewed baseline, not a clean database claim', () => {
    const validation = assertExpectedReplayFailures(report());
    assert.equal(validation.expected.length, 12);
    assert.equal(validation.matched.length, 12);
    assert.equal(validation.freshDatabaseVerified, false);
    assert.ok(Object.isFrozen(EXPECTED_REPLAY_FAILURES));
    for (const item of EXPECTED_REPLAY_FAILURES) {
      assert.ok(Object.isFrozen(item));
      assert.ok(item.reason && item.realDatabaseImpact && item.message);
      assert.equal(item.blocksFreshDatabase, true);
    }
  });

  test('validator rejects unknown failures, including every critical transfer migration', async t => {
    for (const file of ['20270101000000_unreviewed_new_migration.sql', ...criticalMigrations]) {
      await t.test(file, () => {
        const result = report();
        if (!result.files.includes(file)) result.files.push(file);
        result.failures.push({ file, message: 'syntax error at or near "BROKEN"' });
        mismatch(result, 'unexpected', file);
      });
    }
  });

  test('every known filename requires its exact full message (no prefix or first-line acceptance)', () => {
    for (const [index, original] of expectedFailures.entries()) {
      for (const message of ['permission denied for schema private', `${original.message}\nunreviewed error detail`]) {
        const result = report();
        result.failures[index].message = message;
        mismatch(result, 'message-changed', original.file);
      }
    }
  });

  test('validator rejects missing expected failures, missing files and duplicate failures', () => {
    for (const original of expectedFailures) {
      const result = report();
      result.failures = result.failures.filter(item => item.file !== original.file);
      mismatch(result, 'missing', original.file);
      result.files = result.files.filter(file => file !== original.file);
      mismatch(result, 'not-replayed', original.file);
    }
    const duplicate = report();
    duplicate.failures.push(duplicate.failures[0]);
    mismatch(duplicate, 'duplicate', expectedFiles[0]);
  });

  test('upTo limits only the reviewed expectation set, inclusively, without hiding later failures', () => {
    for (const upTo of ['00000000000000.sql', expectedFiles[0], expectedFiles[5], criticalMigrations[0]]) {
      const scoped = report();
      scoped.files = scoped.files.filter(file => file <= upTo);
      scoped.failures = scoped.failures.filter(item => item.file <= upTo);
      const validation = assertExpectedReplayFailures(scoped, { upTo });
      assert.equal(validation.expected.length, expectedFiles.filter(file => file <= upTo).length);
    }
    const upTo = expectedFiles[0];
    const scoped = { files: [upTo], failures: [expectedFailures[0]] };
    mismatch({ ...scoped, failures: [] }, 'missing', upTo, { upTo });
    mismatch({ ...scoped, failures: [...scoped.failures, expectedFailures[1]] }, 'out-of-scope', expectedFiles[1], { upTo });
    mismatch({ ...scoped, files: [...scoped.files, expectedFiles[1]] }, 'out-of-scope', expectedFiles[1], { upTo });
    mismatch({ files: [], failures: [expectedFailures[0]] }, 'not-replayed', upTo, { upTo });
  });

  test('setup failures are fatal in diagnostic and strict modes and always close the database', async t => {
    const first = '20251029151618_create_quantum_trader_schema.sql';
    for (const strict of [false, true]) {
      for (const [label, anchor, upTo] of [
        ['platform.sql', 'CREATE ROLE anon', first],
        ['baseline.sql after first migration', 'CREATE TABLE IF NOT EXISTS public.admin_groups', first],
        ['baseline.sql before', 'CREATE FUNCTION public.cleanup_all_practice_data()', '20260706000801_revoke_unused_security_definer_functions.sql'],
      ]) {
        await t.test(`${strict ? 'strict' : 'diagnostic'} ${label}`, async () => {
          const fault = new Error('injected setup failure');
          const db = resource({ exec: async sql => { if (sql.includes(anchor)) throw fault; } });
          await assert.rejects(replayMigrations({ strict, upTo }, { createDatabase: () => db }), error => {
            assert.ok(error.message.includes(label), error.message);
            assert.equal(error.cause, fault);
            return true;
          });
          assert.equal(db.closes, 1);
        });
      }
    }
  });

  test('diagnostic replay retains full errors and continues, but rollback failure is fatal', async t => {
    for (const brokenRollback of [false, true]) {
      await t.test(brokenRollback ? 'rollback failure closes database' : 'collect and continue', async () => {
        const fault = new Error('injected migration failure\nretain the complete message');
        const rollbackFault = new Error('injected rollback failure');
        let failed = false;
        let continued = false;
        const db = resource({ exec: async sql => {
          if (sql === 'ROLLBACK') {
            if (brokenRollback) throw rollbackFault;
            return;
          }
          if (sql.includes('CREATE ROLE anon') || sql.includes('CREATE TABLE IF NOT EXISTS public.admin_groups')) return;
          if (!failed) { failed = true; throw fault; }
          continued = true;
        } });
        const replay = replayMigrations({ upTo: '20251029172427_add_verification_requests.sql' }, { createDatabase: () => db });
        if (brokenRollback) {
          await assert.rejects(replay, error => error === rollbackFault);
          assert.equal(db.closes, 1);
          assert.equal(continued, false);
        } else {
          const result = await replay;
          try {
            assert.ok(continued);
            assert.equal(db.closes, 0);
            assert.deepEqual(result.failures, [{ file: result.files[0], message: fault.message }]);
          } finally { await db.close(); }
        }
      });
    }
  });

  test('replay retains diagnostic ownership but closes on strict expectation mismatch', async () => {
    const upTo = expectedFiles[0];
    const diagnostic = resource();
    const result = await replayMigrations({ upTo }, { createDatabase: () => diagnostic });
    try {
      assert.equal(result.db, diagnostic);
      assert.equal(diagnostic.closes, 0);
      mismatch(result, 'missing', upTo, { upTo });
    } finally { await diagnostic.close(); }
    const strict = resource();
    await assert.rejects(replayMigrations({ strict: true, upTo }, { createDatabase: () => strict }), /Replay baseline mismatch/);
    assert.equal(strict.closes, 1);
  });

  test('createSites cannot disable validation and refuses invalid replay before dumping or cloning', async () => {
    const base = resource();
    let clones = 0;
    await assert.rejects(createSites({ strict: false }, {
      replay: async options => {
        assert.equal(options.strict, true);
        return { ...report(), failures: [], db: base };
      },
      createDatabase: () => { clones++; return resource(); },
    }), /Replay baseline mismatch/);
    assert.equal(base.dumps, 0);
    assert.equal(base.closes, 1);
    assert.equal(clones, 0);
  });

  test('createSites closes base on dump failure and every opened clone on construction/readiness failure', async t => {
    for (const failure of ['dump', 'first-ready', 'second-constructor', 'second-ready']) {
      await t.test(failure, async () => {
        const fault = new Error(`injected ${failure} failure`);
        const base = resource({ dump: async () => { if (failure === 'dump') throw fault; return new Blob(); } });
        const opened = [];
        await assert.rejects(createSites({}, {
          replay: async () => ({ ...report(), db: base }),
          createDatabase: () => {
            if (opened.length === 1 && failure === 'second-constructor') throw fault;
            const ordinal = opened.length;
            const db = resource({ ready: async () => {
              if ((ordinal === 0 && failure === 'first-ready') || (ordinal === 1 && failure === 'second-ready')) throw fault;
            } });
            opened.push(db);
            return db;
          },
        }), error => error === fault);
        assert.equal(base.closes, 1);
        for (const db of opened) assert.equal(db.closes, 1);
      });
    }
  });

  const timeoutMs = Number(process.env.EMPLOYEE_TRANSFER_REPLAY_TIMEOUT_MS ?? 120000);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000,
    'EMPLOYEE_TRANSFER_REPLAY_TIMEOUT_MS must be an integer from 1000 to 600000');
  test('full real SQL baseline creates isolated anon RPC sites; expected gaps remain', { timeout: timeoutMs + 5000 }, async t => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(import.meta.url), workerFlag], {
      env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    });
    assert.equal(stderr, '');
    assert.match(stdout, /12 expected failures retained; NOT a clean\/full-site migration pass/);
    t.diagnostic(stdout.trim());
  });
}
