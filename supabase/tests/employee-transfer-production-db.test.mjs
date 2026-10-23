import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { replayMigrations } from './support/replay-migrations.mjs';
import { rows, scalar } from './support/transfer-harness.mjs';
import { replayProductionTransferMigrations, PRODUCTION_TRANSFER_LAST } from './support/production-transfer.mjs';

let production, local;
const assertGuards = db => scalar(db, 'SELECT private.employee_transfer_assert_maintenance_guards()');
async function transaction(db, use) {
  await db.exec('BEGIN');
  try { return await use(); }
  finally { await db.exec('ROLLBACK'); }
}
before(async () => {
  production = await replayProductionTransferMigrations();
  local = await replayMigrations({ upTo: '20261102000033_transfer_readonly_archives.sql', strict: true });
}, { timeout: 300000 });
after(async () => { await production?.db.close(); await local?.db.close(); });

test('all 58 transfer migrations install over the exact audited 96-table/871-column structural profile', async t => {
  assert.equal(production.files.length, 584);
  assert.equal(production.files.at(-1), PRODUCTION_TRANSFER_LAST);
  assert.equal(production.failures.length, 12);
  assert.equal(production.validation.freshDatabaseVerified, false);
  assert.deepEqual(production.productionColumnBaseline, { tableCount: 96, columnCount: 871, exportAuthorized: false,
    fingerprint: 'cc05ccfbec83f315554f6e598a80c4ca442169e8911089ce4fb081d5ae0db128' });
  assert.equal(await scalar(production.db, "SELECT to_regclass('public.notification_automation_date_runs')"), null);
  await assertGuards(production.db);
  t.diagnostic('Column-catalog adaptation only; local historical functions/platform substitutes and 12 known replay gaps remain. No production/native-PG/Storage acceptance claim.');
});

test('the absent capability is frozen before guards are installed, including the SQL33 archive extension', async () => {
  const db = production.db;
  const tables = await scalar(db, 'SELECT private.employee_transfer_guarded_tables()');
  assert.equal(tables.includes('public.notification_automation_date_runs'), false);
  assert.equal(tables.includes('private.employee_transfer_archive_records'), true);
  assert.equal(tables.length, 94);
  const guards = await rows(db, `SELECT n.nspname||'.'||c.relname AS name,t.tgenabled FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE t.tgname='zz_employee_transfer_maintenance' ORDER BY 1`);
  assert.deepEqual(guards.map(row => row.name).sort(), [...tables].sort());
  assert.ok(guards.every(row => row.tgenabled === 'A'));
  const definition = await scalar(db, "SELECT pg_get_functiondef('private.employee_transfer_guarded_tables()'::regprocedure)");
  assert.equal(/to_regclass|pg_class/.test(definition), false);
  await transaction(db, async () => {
    await scalar(db, 'SELECT private.employee_transfer_lock_maintenance_tables()');
    await scalar(db, 'SELECT private.employee_transfer_cutover_lock()');
    const fingerprint = await scalar(db, "SELECT private.employee_transfer_site_release_fingerprint('{}'::jsonb)");
    assert.equal(Object.hasOwn(fingerprint, 'public.notification_automation_date_runs'), false);
    assert.equal(Object.hasOwn(fingerprint, 'private.employee_transfer_archive_records'), true);
  });
});

test('the installation snapshot keeps every private maintenance helper inaccessible to browser and service roles', async () => {
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await scalar(production.db, `SELECT count(*)::int FROM pg_proc WHERE pronamespace='private'::regnamespace
      AND proname IN ('employee_transfer_guarded_tables','employee_transfer_guard_write','employee_transfer_lock_maintenance_tables',
        'employee_transfer_assert_maintenance_guards','employee_transfer_allow_config_write','employee_transfer_clear_write_permit')
      AND has_function_privilege($1,oid,'EXECUTE')`, [role]), 0);
  }
  const metadata = await rows(production.db, `SELECT p.prosecdef,p.provolatile,p.proconfig FROM pg_proc p
    WHERE p.oid='private.employee_transfer_guarded_tables()'::regprocedure`);
  assert.equal(metadata[0].prosecdef, true);
  assert.equal(metadata[0].provolatile, 'i');
  assert.ok(metadata[0].proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
});

for (const [name, ddl] of [
  ['a date table created after an absent-capability installation', `CREATE TABLE public.notification_automation_date_runs(
    task_id uuid NOT NULL,task_version integer NOT NULL,period_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(task_id,task_version,period_key))`],
  ['an unknown new business table', 'CREATE TABLE public.unreviewed_transfer_business(id uuid PRIMARY KEY)'],
  ['a required existing table removed after installation', 'DROP TABLE public.wallets'],
  ['a frozen inventory function changed after installation', `CREATE OR REPLACE FUNCTION private.employee_transfer_guarded_tables()
    RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,private,pg_temp
    AS $$ SELECT ARRAY['public.users']::text[] $$`],
]) test(`strict guards reject ${name}`, async () => {
  await transaction(production.db, async () => {
    await production.db.exec(ddl);
    await assert.rejects(assertGuards(production.db), /Unreviewed employee transfer maintenance inventory or guards/);
  });
  await assertGuards(production.db);
});

test('a missing required table still rejects the entire SQL11 installation without leaving partial guards', { timeout: 120000 }, async () => {
  const result = await replayProductionTransferMigrations({ upTo: '20261102000010_prepare_dispatch_submission_import.sql' });
  try {
    await result.db.exec('ALTER TABLE public.valid_data_query_performance RENAME TO required_table_missing_fixture');
    const sql = await readFile(new URL('../migrations/20261102000011_guard_transfer_maintenance.sql', import.meta.url), 'utf8');
    await assert.rejects(result.db.exec(sql), /relation "public.valid_data_query_performance" does not exist/);
    await result.db.exec('ROLLBACK');
    assert.equal(await scalar(result.db, "SELECT to_regclass('private.employee_transfer_maintenance')"), null);
    assert.equal(await scalar(result.db, "SELECT count(*)::int FROM pg_trigger WHERE tgname='zz_employee_transfer_maintenance'"), 0);
  } finally { await result.db.close(); }
});

test('the ordinary present-table baseline still pins its date table and rejects deletion after installation', async () => {
  const db = local.db;
  assert.ok((await scalar(db, 'SELECT private.employee_transfer_guarded_tables()')).includes('public.notification_automation_date_runs'));
  await assertGuards(db);
  await transaction(db, async () => {
    await db.exec('DROP TABLE public.notification_automation_date_runs');
    await assert.rejects(assertGuards(db), /Unreviewed employee transfer maintenance inventory or guards/);
  });
  await assertGuards(db);
});
