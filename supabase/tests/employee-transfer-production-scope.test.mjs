import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  TRANSFER_SCOPE_COVERAGE_INVENTORY as local,
  TRANSFER_PRODUCTION_COVERAGE_INVENTORY as production,
  TRANSFER_PRODUCTION_SCHEMA_FINGERPRINT,
  assertTransferScopeCoverage,
} from './support/transfer-scope.mjs';

const options = { profile: 'production-2026-10-17' };
const clone = () => structuredClone(production);

test('production schema profile matches the independently fetched read-only catalog fingerprint', () => {
  const columns = production.flatMap(table => table.columns.map(column =>
    `${table.schema}.${table.name}.${column.name}:${column.type}:${column.nullable}`)).sort();
  assert.equal(createHash('sha256').update(columns.join('\n')).digest('hex'), TRANSFER_PRODUCTION_SCHEMA_FINGERPRINT);
  assert.equal(production.length, 96);
  assert.equal(columns.length, 871);
  assert.equal(Object.isFrozen(production), true);
  for (const table of production) {
    assert.equal(Object.isFrozen(table), true);
    assert.equal(Object.isFrozen(table.columns), true);
    for (const column of table.columns) assert.equal(Object.isFrozen(column), true);
  }
  assert.deepEqual(assertTransferScopeCoverage(clone(), options), { tableCount: 96, columnCount: 871, exportAuthorized: false });
});

test('the two profiles have exactly seven table and eight nullable differences, no implicit relaxation', () => {
  const keys = new Set(production.map(table => `${table.schema}.${table.name}`));
  const absent = local.filter(table => !keys.has(`${table.schema}.${table.name}`));
  assert.equal(absent.length, 7);
  assert.equal(absent.filter(table => table.schema === 'private' && table.name.startsWith('employee_transfer_')).length, 6);
  assert.equal(absent.filter(table => table.name === 'notification_automation_date_runs').length, 1);
  const differences = [];
  for (const table of production) {
    const original = local.find(item => item.schema === table.schema && item.name === table.name);
    assert.ok(original);
    assert.equal(table.columns.length, original.columns.length);
    for (const column of table.columns) {
      const previous = original.columns.find(item => item.name === column.name);
      assert.equal(column.type, previous.type);
      if (column.nullable !== previous.nullable) differences.push(`${table.schema}.${table.name}.${column.name}`);
    }
  }
  assert.deepEqual(differences.sort(), [
    'private.content_audit_events.actor_admin_id', 'public.bulk_import_log.import_type',
    'public.bulk_import_log.table_name', 'public.bulk_import_log.total_records',
    'public.group_configs.config_type', 'public.group_configs.config_value',
    'public.group_configs.group_id', 'public.users.created_by',
  ]);
  assert.throws(() => assertTransferScopeCoverage(local, options), /inventory mismatch/);
  assert.throws(() => assertTransferScopeCoverage(production), /inventory mismatch/);
  assert.throws(() => assertTransferScopeCoverage(production, { profile: 'auto' }), /Unknown transfer schema profile/);
});

test('production validation rejects unknown/missing objects, type and nullable drift without learning them', () => {
  const cases = [
    tables => tables.push({ schema: 'public', name: 'unreviewed', columns: [] }),
    tables => tables.pop(),
    tables => tables.push(structuredClone(tables[0])),
    tables => tables[0].columns.push({ name: 'secret', type: 'text', nullable: true }),
    tables => tables[0].columns.pop(),
    tables => { tables[0].columns[0].type = 'text'; },
    tables => { tables[0].columns[0].nullable = !tables[0].columns[0].nullable; },
  ];
  for (const change of cases) {
    const tables = clone();
    change(tables);
    const before = structuredClone(tables);
    assert.throws(() => assertTransferScopeCoverage(tables, options), /inventory mismatch/);
    assert.deepEqual(tables, before);
    assert.throws(() => assertTransferScopeCoverage(tables, options), /inventory mismatch/);
  }
  assertTransferScopeCoverage(clone(), options);
});
