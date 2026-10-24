import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const REGION_MIGRATION = '20261102000000_add_employee_regions.sql';
const migrationDir = new URL('../migrations/', import.meta.url);
const supportDir = new URL('./support/', import.meta.url);

// baseline.sql segments: the first runs right after the first migration, the others before the named file.
// A few historical files cannot run on an empty database; only the region migration must succeed here.
async function replayMigrations() {
  const segments = [{ before: null, sql: '' }];
  for (const line of (await readFile(new URL('baseline.sql', supportDir), 'utf8')).split('\n')) {
    const marker = line.match(/^-- @before (\S+)/);
    if (marker) segments.push({ before: marker[1], sql: '' });
    else segments.at(-1).sql += `${line}\n`;
  }
  const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
  const database = new PGlite({ extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await database.exec(await readFile(new URL('platform.sql', supportDir), 'utf8'));
  const failures = [];
  for (const [index, file] of files.entries()) {
    for (const segment of segments) {
      if (segment.before && file.startsWith(segment.before)) await database.exec(segment.sql);
    }
    const sql = (await readFile(new URL(file, migrationDir), 'utf8'))
      .replace(/CREATE EXTENSION IF NOT EXISTS pg_cron[^;]*;/gi, '')
      .replace(/CREATE EXTENSION IF NOT EXISTS pg_trgm;/gi, '');
    try {
      await database.exec(sql);
    } catch (error) {
      failures.push({ file, message: String(error.message).split('\n')[0] });
      try { await database.exec('ROLLBACK'); } catch { /* no open transaction */ }
    }
    if (index === 0) await database.exec(segments[0].sql);
  }
  return { database, failures, files };
}

const SUPER = '00000000-0000-4000-8000-000000000001';
const SECONDARY = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';
const EMERGENCY = '00000000-0000-4000-8000-000000000004';
const TOKENS = {
  super: '10000000-0000-4000-8000-000000000001',
  secondary: '10000000-0000-4000-8000-000000000002',
  other: '10000000-0000-4000-8000-000000000003',
  emergency: '10000000-0000-4000-8000-000000000004',
};
const GROUP = '20000000-0000-4000-8000-000000000001';
const MISSING_REGION = '30000000-0000-4000-8000-000000000099';

let db;
let replay;

async function call(fn, args) {
  const keys = Object.keys(args);
  const placeholders = keys.map((key, index) => `${key} => $${index + 1}`).join(', ');
  const { rows } = await db.query(`SELECT public.${fn}(${placeholders}) AS result`, keys.map(key => args[key]));
  return rows[0].result;
}

const createRegion = (token, name) => call('admin_create_employee_region', {
  p_admin_session_token: token,
  p_name: name,
});

let employeeSequence = 0;
function createEmployee(token, createdBy, extra = {}) {
  employeeSequence += 1;
  return call('admin_create_employee_account_with_automation_plan', {
    p_admin_session_token: token,
    p_username: `region-user-${employeeSequence}`,
    p_password: 'secret-123',
    p_employee_id: `R-${employeeSequence}`,
    p_created_by: createdBy,
    p_remarks: '',
    p_automation_plan_id: null,
    p_dispatch_group_id: GROUP,
    ...extra,
  });
}

const regionOf = async userId => (await db.query(
  'SELECT region_id FROM public.users WHERE id = $1', [userId])).rows[0].region_id;

before(async () => {
  replay = await replayMigrations();
  db = replay.database;
  await db.exec(`
    INSERT INTO public.admins (id, username, password_hash, role, parent_id) VALUES
      ('${SUPER}', 'qa-root', 'x', 'super_admin', NULL),
      ('${SECONDARY}', 'qa-secondary', 'x', 'secondary_admin', '${SUPER}'),
      ('${OTHER}', 'qa-other', 'x', 'secondary_admin', '${SUPER}'),
      ('${EMERGENCY}', 'qa-emergency', 'x', 'emergency_admin', '${SUPER}');
    INSERT INTO public.admin_financial_sessions (admin_id, token_hash, expires_at) VALUES
      ('${SUPER}', private.hash_financial_token('${TOKENS.super}'), now() + interval '1 day'),
      ('${SECONDARY}', private.hash_financial_token('${TOKENS.secondary}'), now() + interval '1 day'),
      ('${OTHER}', private.hash_financial_token('${TOKENS.other}'), now() + interval '1 day'),
      ('${EMERGENCY}', private.hash_financial_token('${TOKENS.emergency}'), now() + interval '1 day');
    INSERT INTO public.dispatch_groups (id, group_name, is_active) VALUES ('${GROUP}', 'QA group', true);
  `);
});

test('the region migration applies on top of the full migration history', () => {
  assert.ok(replay.files.includes(REGION_MIGRATION));
  assert.deepEqual(replay.failures.filter(failure => failure.file >= REGION_MIGRATION), []);
});

test('regions are only reachable through the administrator RPCs', async () => {
  const { rows: [privileges] } = await db.query(`
    SELECT
      has_table_privilege('anon', 'public.employee_regions', 'SELECT, INSERT, UPDATE, DELETE') AS anon_table,
      has_table_privilege('authenticated', 'public.employee_regions', 'SELECT, INSERT, UPDATE, DELETE') AS auth_table,
      (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.employee_regions'::regclass) AS rls,
      has_column_privilege('anon', 'public.users', 'region_id', 'SELECT') AS anon_region_column,
      has_column_privilege('anon', 'public.users', 'region_id', 'UPDATE') AS anon_region_update,
      has_function_privilege('anon', 'public.admin_create_employee_region(uuid, text)', 'EXECUTE') AS anon_create_region,
      has_function_privilege('anon',
        'public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid, uuid, uuid)',
        'EXECUTE') AS anon_create_employee,
      has_function_privilege('anon', 'public.admin_update_employee_account_unlocked(uuid, uuid, jsonb)', 'EXECUTE') AS anon_unlocked,
      has_function_privilege('service_role', 'public.admin_update_employee_account_unlocked(uuid, uuid, jsonb)', 'EXECUTE') AS service_unlocked,
      (SELECT count(*) FROM pg_proc AS p, aclexplode(p.proacl) AS acl
        WHERE p.oid IN (
          'public.admin_create_employee_region(uuid, text)'::regprocedure,
          'public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid, uuid, uuid)'::regprocedure
        ) AND acl.grantee = 0) AS public_grants,
      (SELECT count(*) FROM pg_proc WHERE proname = 'admin_create_employee_account_with_automation_plan') AS create_signatures
  `);
  assert.deepEqual(privileges, {
    anon_table: false,
    auth_table: false,
    rls: true,
    anon_region_column: true,
    anon_region_update: false,
    anon_create_region: true,
    anon_create_employee: true,
    anon_unlocked: false,
    service_unlocked: false,
    public_grants: 0,
    create_signatures: 1,
  });
});

test('super and secondary administrators add shared, trimmed and de-duplicated regions', async () => {
  const taipei = await createRegion(TOKENS.super, '  台北  ');
  assert.equal(taipei.name, '台北');
  assert.equal(taipei.created, true);

  const again = await createRegion(TOKENS.secondary, '台北');
  assert.equal(again.id, taipei.id);
  assert.equal(again.created, false);

  const kaohsiung = await createRegion(TOKENS.secondary, '\u3000高雄\u3000');
  assert.equal(kaohsiung.name, '高雄');
  assert.equal(kaohsiung.created, true);

  const latin = await createRegion(TOKENS.other, 'Kuala Lumpur');
  const latinAgain = await createRegion(TOKENS.super, 'kuala lumpur');
  assert.equal(latinAgain.id, latin.id);
  assert.equal(latinAgain.name, 'Kuala Lumpur');
  assert.equal(latinAgain.created, false);

  await assert.rejects(createRegion(TOKENS.super, '   '), /1 to 30 characters/);
  await assert.rejects(createRegion(TOKENS.super, 'x'.repeat(31)), /1 to 30 characters/);
  assert.equal((await createRegion(TOKENS.super, 'y'.repeat(30))).created, true);
  await assert.rejects(createRegion(TOKENS.emergency, '台中'), /session is invalid or expired/);
  await assert.rejects(createRegion('10000000-0000-4000-8000-0000000000ff', '台中'), /session is invalid or expired/);

  const { rows } = await db.query(`SELECT name, created_by FROM public.employee_regions ORDER BY created_at, name`);
  assert.deepEqual(rows.map(row => row.name), ['台北', '高雄', 'Kuala Lumpur', 'y'.repeat(30)]);
  assert.deepEqual(rows.slice(0, 3).map(row => row.created_by), [SUPER, SECONDARY, OTHER]);
});

test('creating an employee stores the chosen region and the old call shape still works', async () => {
  const { id: taipei } = await createRegion(TOKENS.super, '台北');

  const withRegion = await createEmployee(TOKENS.super, SECONDARY, { p_region_id: taipei });
  assert.equal(withRegion.success, true);
  assert.equal(withRegion.user.region_id, taipei);
  assert.equal(await regionOf(withRegion.user.id), taipei);

  const withoutRegion = await createEmployee(TOKENS.super, SECONDARY);
  assert.equal(withoutRegion.success, true);
  assert.equal(await regionOf(withoutRegion.user.id), null);

  const bySecondary = await createEmployee(TOKENS.secondary, SECONDARY, { p_region_id: taipei });
  assert.equal(await regionOf(bySecondary.user.id), taipei);

  const before = (await db.query('SELECT count(*)::int AS count FROM public.users')).rows[0].count;
  await assert.rejects(createEmployee(TOKENS.super, SECONDARY, { p_region_id: MISSING_REGION }), /region is not available/);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM public.users')).rows[0].count, before);

  const legacy = await call('admin_create_employee_account', {
    p_admin_session_token: TOKENS.super,
    p_username: 'region-legacy-wrapper',
    p_password: 'secret-123',
    p_employee_id: 'R-legacy',
    p_created_by: OTHER,
    p_remarks: '',
    p_dispatch_group_id: GROUP,
  });
  assert.equal(legacy.success, true);
  assert.equal(await regionOf(legacy.user.id), null);
});

test('employee updates set and clear the region but reject unknown regions and other groups', async () => {
  const { id: taipei } = await createRegion(TOKENS.super, '台北');
  const { id: kaohsiung } = await createRegion(TOKENS.super, '高雄');
  const employee = (await createEmployee(TOKENS.super, SECONDARY, { p_remarks: 'keep me' })).user;
  const update = (token, updates) => call('admin_update_employee_account', {
    p_admin_session_token: token,
    p_user_id: employee.id,
    p_updates: JSON.stringify(updates),
  });

  assert.equal((await update(TOKENS.secondary, { region_id: kaohsiung })).region_id, kaohsiung);
  assert.equal((await update(TOKENS.super, { region_id: taipei, remarks: 'still here' })).region_id, taipei);
  assert.equal((await update(TOKENS.super, { tags: ['a'] })).region_id, taipei);
  assert.equal((await update(TOKENS.super, { region_id: null })).region_id, null);
  assert.equal((await update(TOKENS.super, { region_id: taipei })).region_id, taipei);
  assert.equal((await update(TOKENS.super, { region_id: '' })).region_id, null);

  await assert.rejects(update(TOKENS.super, { region_id: MISSING_REGION }), /region is not available/);
  await assert.rejects(update(TOKENS.other, { region_id: taipei }), /permission to manage this employee/);
  await assert.rejects(update(TOKENS.super, { region: taipei }), /protected field/);

  const { rows: [row] } = await db.query('SELECT region_id, remarks, tags FROM public.users WHERE id = $1', [employee.id]);
  assert.deepEqual(row, { region_id: null, remarks: 'still here', tags: ['a'] });
});

test('the employee snapshot lists every shared region and each employee region', async () => {
  const { id: taipei } = await createRegion(TOKENS.super, '台北');
  const created = (await createEmployee(TOKENS.super, OTHER, { p_region_id: taipei })).user;

  const superSnapshot = await call('get_employee_management_snapshot', { p_admin_session_token: TOKENS.super });
  const { rows: regionRows } = await db.query('SELECT id, name FROM public.employee_regions ORDER BY created_at, name, id');
  assert.deepEqual(superSnapshot.regions, regionRows);
  assert.equal(superSnapshot.employees.find(employee => employee.id === created.id).region_id, taipei);
  assert.ok(superSnapshot.employees.every(employee => 'region_id' in employee));

  const secondarySnapshot = await call('get_employee_management_snapshot', { p_admin_session_token: TOKENS.secondary });
  assert.deepEqual(secondarySnapshot.regions, regionRows);
  assert.ok(secondarySnapshot.employees.length > 0);
  assert.ok(secondarySnapshot.employees.every(employee => employee.created_by === SECONDARY));
});
