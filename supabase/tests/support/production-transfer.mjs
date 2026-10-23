import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { assertExpectedReplayFailures, replayMigrations } from './replay-migrations.mjs';
import { assertTransferScopeCoverage, TRANSFER_PRODUCTION_SCHEMA_FINGERPRINT } from './transfer-scope.mjs';
import { applyProductionTriggerFixture } from './production-triggers.mjs';
import { isNativeTransferDatabase } from './native-postgres.mjs';

const historicalEnd = '20261101000003_keep_user_stopped_work_sessions_stopped.sql';
export const PRODUCTION_TRANSFER_LAST = '20261102000057_release_imported_site.sql';
const migrationDir = new URL('../../migrations/', import.meta.url);

export async function readTransferSchema(db) {
  return (await db.query(`SELECT n.nspname AS schema,c.relname AS name,
    jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),
      'nullable',NOT a.attnotnull) ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') AND NOT c.relispartition
    GROUP BY n.nspname,c.relname ORDER BY n.nspname,c.relname`)).rows;
}

// The optional trigger profile reproduces reviewed observations, not hosted Supabase or Storage.
export async function replayProductionTransferMigrations(
  { upTo = PRODUCTION_TRANSFER_LAST, log = () => {}, triggerProfile = false } = {},
  { replay = replayMigrations } = {},
) {
  if (typeof triggerProfile !== 'boolean') throw new TypeError('Explicit trigger profile boolean required');
  const transferFiles = (await readdir(migrationDir)).filter(name => name.startsWith('20261102') && name.endsWith('.sql')).sort();
  if (!transferFiles.includes(upTo)) throw new TypeError('A reviewed employee transfer migration endpoint is required');
  const result = await replay({ upTo: historicalEnd, strict: true, log });
  const { db } = result;
  try {
    if (isNativeTransferDatabase(db)) await db.finishHistoricalSetup();
    const productionTriggerBaseline = triggerProfile ? await applyProductionTriggerFixture(db) : null;
    await db.exec(`BEGIN;
      DROP TABLE public.notification_automation_date_runs;
      ALTER TABLE public.users ALTER COLUMN created_by DROP NOT NULL;
      ALTER TABLE private.content_audit_events ALTER COLUMN actor_admin_id DROP NOT NULL;
      ALTER TABLE public.bulk_import_log ALTER COLUMN table_name SET NOT NULL,
        ALTER COLUMN import_type SET NOT NULL,ALTER COLUMN total_records SET NOT NULL;
      ALTER TABLE public.group_configs ALTER COLUMN group_id SET NOT NULL,
        ALTER COLUMN config_type SET NOT NULL,ALTER COLUMN config_value SET NOT NULL;
      COMMIT;`);
    const catalog = await readTransferSchema(db);
    const baseline = assertTransferScopeCoverage(catalog, { profile: 'production-2026-10-17' });
    const columns = catalog.flatMap(table => table.columns.map(column =>
      `${table.schema}.${table.name}.${column.name}:${column.type}:${column.nullable}`)).sort();
    const fingerprint = createHash('sha256').update(columns.join('\n')).digest('hex');
    assert.equal(fingerprint, TRANSFER_PRODUCTION_SCHEMA_FINGERPRINT);
    for (const file of transferFiles.filter(name => name <= upTo)) {
      try { await db.exec(await readFile(new URL(file, migrationDir), 'utf8')); }
      catch (cause) { throw new Error(`Production-column-profile installation failed (${file}): ${cause.message}`, { cause }); }
      result.files.push(file);
    }
    result.validation = assertExpectedReplayFailures(result, { upTo });
    return { ...result, productionColumnBaseline: { ...baseline, fingerprint },
      ...(productionTriggerBaseline ? { productionTriggerBaseline } : {}) };
  } catch (error) {
    const errors = [error];
    try { await db.exec('ROLLBACK'); } catch (rollbackError) { errors.push(rollbackError); }
    try { await db.close(); } catch (closeError) { errors.push(closeError); }
    if (errors.length > 1) throw new AggregateError(errors, `${error.message}; installation cleanup failed`, { cause: error });
    throw error;
  }
}
