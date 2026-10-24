import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const REGION_MIGRATION = '20261102000000_add_employee_regions.sql';
const PER_ADMIN_MIGRATION = '20261102000001_per_admin_employee_regions.sql';
const PIN_MIGRATION = '20261102000002_pin_employee_regions.sql';
const migrationDir = new URL('../migrations/', import.meta.url);
const supportDir = new URL('./support/', import.meta.url);

// baseline.sql segments: the first runs right after the first migration, the others before the named file.
// A few historical files cannot run on an empty database; only the region migrations must succeed here.
async function replayMigrations(beforeFile) {
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
    await beforeFile?.(database, file);
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

// Seeded with the earlier shared-region schema to check the per-admin conversion.
const LEGACY_A = '40000000-0000-4000-8000-000000000001';
const LEGACY_B = '40000000-0000-4000-8000-000000000002';
const SHARED_REGION = '50000000-0000-4000-8000-000000000001';
const UNUSED_REGION = '50000000-0000-4000-8000-000000000002';
const ORPHAN_REGION = '50000000-0000-4000-8000-000000000003';
const LEGACY_USER_A = '60000000-0000-4000-8000-000000000001';
const LEGACY_USER_B = '60000000-0000-4000-8000-000000000002';

let db;
let replay;

async function call(fn, args) {
  const keys = Object.keys(args);
  const placeholders = keys.map((key, index) => `${key} => $${index + 1}`).join(', ');
  const { rows } = await db.query(`SELECT public.${fn}(${placeholders}) AS result`, keys.map(key => args[key]));
  return rows[0].result;
}

const createRegion = (token, ownerId, name) => call('admin_create_employee_region', {
  p_admin_session_token: token,
  p_owner_admin_id: ownerId,
  p_name: name,
});
const renameRegion = (token, regionId, name) => call('admin_rename_employee_region', {
  p_admin_session_token: token,
  p_region_id: regionId,
  p_name: name,
});
const setRegionPinned = (token, regionId, isPinned) => call('admin_set_employee_region_pinned', {
  p_admin_session_token: token,
  p_region_id: regionId,
  p_is_pinned: isPinned,
});
const deleteRegion = (token, regionId, replacementId) => call('admin_delete_employee_region', {
  p_admin_session_token: token,
  p_region_id: regionId,
  ...(replacementId === undefined ? {} : { p_replacement_region_id: replacementId }),
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
const countUsers = async () => (await db.query('SELECT count(*)::int AS count FROM public.users')).rows[0].count;

before(async () => {
  replay = await replayMigrations(async (database, file) => {
    if (file !== PER_ADMIN_MIGRATION) return;
    await database.exec(`
      INSERT INTO public.admins (id, username, password_hash, role) VALUES
        ('${LEGACY_A}', 'legacy-a', 'x', 'secondary_admin'),
        ('${LEGACY_B}', 'legacy-b', 'x', 'secondary_admin');
      INSERT INTO public.employee_regions (id, name, created_by) VALUES
        ('${SHARED_REGION}', '共用地區', '${LEGACY_A}'),
        ('${UNUSED_REGION}', '未使用', '${LEGACY_B}'),
        ('${ORPHAN_REGION}', '無主', NULL);
      INSERT INTO public.users (id, username, password_hash, employee_id, created_by, region_id) VALUES
        ('${LEGACY_USER_A}', 'legacy-user-a', 'x', 'LA', '${LEGACY_A}', '${SHARED_REGION}'),
        ('${LEGACY_USER_B}', 'legacy-user-b', 'x', 'LB', '${LEGACY_B}', '${SHARED_REGION}');
    `);
  });
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

test('the region migrations apply on top of the full migration history', () => {
  assert.ok(replay.files.includes(REGION_MIGRATION));
  assert.ok(replay.files.includes(PER_ADMIN_MIGRATION));
  assert.ok(replay.files.includes(PIN_MIGRATION));
  assert.deepEqual(replay.failures.filter(failure => failure.file >= REGION_MIGRATION), []);
});

test('shared regions are split into each administrator group that uses them', async () => {
  const { rows } = await db.query(`
    SELECT region.id, region.name, region.admin_id, region.is_pinned
    FROM public.employee_regions AS region
    WHERE region.admin_id IN ($1, $2)
    ORDER BY region.admin_id, region.name
  `, [LEGACY_A, LEGACY_B]);
  assert.deepEqual(rows.map(row => [row.admin_id, row.name]), [
    [LEGACY_A, '共用地區'],
    [LEGACY_B, '共用地區'],
    [LEGACY_B, '未使用'],
  ]);
  assert.ok(rows.every(row => row.is_pinned === false), 'pre-existing regions default to unpinned');
  const regionA = rows.find(row => row.admin_id === LEGACY_A).id;
  const regionB = rows.find(row => row.admin_id === LEGACY_B && row.name === '共用地區').id;
  assert.notEqual(regionA, regionB);
  assert.equal(await regionOf(LEGACY_USER_A), regionA);
  assert.equal(await regionOf(LEGACY_USER_B), regionB);
  assert.equal(rows.find(row => row.name === '未使用').id, UNUSED_REGION);

  const { rows: gone } = await db.query('SELECT id FROM public.employee_regions WHERE id = ANY($1)', [[SHARED_REGION, ORPHAN_REGION]]);
  assert.deepEqual(gone, []);
  const { rows: [columns] } = await db.query(`
    SELECT
      (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'employee_regions' AND column_name = 'admin_id') AS admin_nullable,
      EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'employee_regions' AND column_name = 'created_by') AS has_created_by,
      (SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'employee_regions' AND column_name = 'is_pinned') AS pinned_nullable,
      (SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'employee_regions' AND column_name = 'is_pinned') AS pinned_type,
      (SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'employee_regions' AND column_name = 'is_pinned') AS pinned_default
  `);
  assert.deepEqual(columns, {
    admin_nullable: 'NO', has_created_by: false, pinned_nullable: 'NO', pinned_type: 'boolean', pinned_default: 'false',
  });
  await assert.rejects(db.query('UPDATE public.employee_regions SET is_pinned = NULL WHERE id = $1', [UNUSED_REGION]), /not-null constraint/);
});

test('regions are only reachable through the administrator RPCs', async () => {
  const { rows: [privileges] } = await db.query(`
    SELECT
      has_table_privilege('anon', 'public.employee_regions', 'SELECT, INSERT, UPDATE, DELETE') AS anon_table,
      has_table_privilege('authenticated', 'public.employee_regions', 'SELECT, INSERT, UPDATE, DELETE') AS auth_table,
      (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.employee_regions'::regclass) AS rls,
      has_column_privilege('anon', 'public.users', 'region_id', 'SELECT') AS anon_region_column,
      has_column_privilege('anon', 'public.users', 'region_id', 'UPDATE') AS anon_region_update,
      has_function_privilege('anon', 'public.admin_create_employee_region(uuid, uuid, text)', 'EXECUTE') AS anon_create_region,
      has_function_privilege('anon', 'public.admin_rename_employee_region(uuid, uuid, text)', 'EXECUTE') AS anon_rename_region,
      has_function_privilege('anon', 'public.admin_delete_employee_region(uuid, uuid, uuid)', 'EXECUTE') AS anon_delete_region,
      has_function_privilege('anon', 'public.admin_set_employee_region_pinned(uuid, uuid, boolean)', 'EXECUTE') AS anon_pin_region,
      has_function_privilege('authenticated', 'public.admin_set_employee_region_pinned(uuid, uuid, boolean)', 'EXECUTE') AS auth_pin_region,
      has_function_privilege('service_role', 'public.admin_set_employee_region_pinned(uuid, uuid, boolean)', 'EXECUTE') AS service_pin_region,
      (SELECT prosecdef FROM pg_proc
        WHERE oid = 'public.admin_set_employee_region_pinned(uuid, uuid, boolean)'::regprocedure) AS pin_security_definer,
      (SELECT proconfig FROM pg_proc
        WHERE oid = 'public.admin_set_employee_region_pinned(uuid, uuid, boolean)'::regprocedure) AS pin_config,
      has_function_privilege('anon',
        'public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid, uuid, uuid)',
        'EXECUTE') AS anon_create_employee,
      has_function_privilege('anon', 'public.admin_update_employee_account_unlocked(uuid, uuid, jsonb)', 'EXECUTE') AS anon_unlocked,
      has_function_privilege('service_role', 'public.admin_update_employee_account_unlocked(uuid, uuid, jsonb)', 'EXECUTE') AS service_unlocked,
      has_function_privilege('anon', 'private.resolve_employee_region_owner(uuid, text, uuid)', 'EXECUTE') AS anon_owner_helper,
      (SELECT count(*) FROM pg_proc AS p, aclexplode(p.proacl) AS acl
        WHERE p.oid IN (
          'public.admin_create_employee_region(uuid, uuid, text)'::regprocedure,
          'public.admin_rename_employee_region(uuid, uuid, text)'::regprocedure,
          'public.admin_delete_employee_region(uuid, uuid, uuid)'::regprocedure,
          'public.admin_set_employee_region_pinned(uuid, uuid, boolean)'::regprocedure,
          'public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid, uuid, uuid)'::regprocedure
        ) AND acl.grantee = 0) AS public_grants,
      (SELECT count(*) FROM pg_proc WHERE proname = 'admin_create_employee_account_with_automation_plan') AS create_signatures,
      (SELECT count(*) FROM pg_proc WHERE proname = 'admin_create_employee_region') AS region_signatures
  `);
  assert.deepEqual(privileges, {
    anon_table: false,
    auth_table: false,
    rls: true,
    anon_region_column: true,
    anon_region_update: false,
    anon_create_region: true,
    anon_rename_region: true,
    anon_delete_region: true,
    anon_pin_region: true,
    auth_pin_region: true,
    service_pin_region: true,
    pin_security_definer: true,
    pin_config: ['search_path=pg_catalog, public, private, pg_temp'],
    anon_create_employee: true,
    anon_unlocked: false,
    service_unlocked: false,
    anon_owner_helper: false,
    public_grants: 0,
    create_signatures: 1,
    region_signatures: 1,
  });
});

test('each administrator group keeps its own trimmed and de-duplicated regions', async () => {
  const secondaryTaipei = await createRegion(TOKENS.secondary, SECONDARY, '  台北  ');
  assert.deepEqual(secondaryTaipei, {
    id: secondaryTaipei.id, name: '台北', admin_id: SECONDARY, is_pinned: false, created: true,
  });

  const again = await createRegion(TOKENS.super, SECONDARY, '台北');
  assert.deepEqual([again.id, again.created], [secondaryTaipei.id, false]);

  const otherTaipei = await createRegion(TOKENS.other, OTHER, '台北');
  assert.notEqual(otherTaipei.id, secondaryTaipei.id);
  assert.equal(otherTaipei.created, true);
  assert.equal(otherTaipei.is_pinned, false);

  const superTaipei = await createRegion(TOKENS.super, SUPER, '\u3000台北\u3000');
  assert.equal(superTaipei.admin_id, SUPER);
  assert.notEqual(superTaipei.id, secondaryTaipei.id);

  const latin = await createRegion(TOKENS.other, OTHER, 'Kuala Lumpur');
  assert.equal((await createRegion(TOKENS.super, OTHER, 'kuala lumpur')).id, latin.id);

  await assert.rejects(createRegion(TOKENS.secondary, OTHER, '台中'), /another administrator group/);
  await assert.rejects(createRegion(TOKENS.super, null, '台中'), /administrator group must be selected/);
  await assert.rejects(createRegion(TOKENS.super, EMERGENCY, '台中'), /administrator group is not available/);
  await assert.rejects(createRegion(TOKENS.super, SECONDARY, '   '), /1 to 30 characters/);
  await assert.rejects(createRegion(TOKENS.super, SECONDARY, 'x'.repeat(31)), /1 to 30 characters/);
  assert.equal((await createRegion(TOKENS.super, SECONDARY, 'y'.repeat(30))).created, true);
  await assert.rejects(createRegion(TOKENS.emergency, SECONDARY, '台中'), /session is invalid or expired/);
  await assert.rejects(createRegion('10000000-0000-4000-8000-0000000000ff', SECONDARY, '台中'), /session is invalid or expired/);
});

test('administrators rename only their own regions and names stay unique per group', async () => {
  const region = await createRegion(TOKENS.secondary, SECONDARY, '新北');
  await createRegion(TOKENS.secondary, SECONDARY, '桃園');
  await createRegion(TOKENS.other, OTHER, '新竹');

  const renamed = await renameRegion(TOKENS.secondary, region.id, '  新竹  ');
  assert.deepEqual(renamed, { id: region.id, name: '新竹', admin_id: SECONDARY, is_pinned: false });
  assert.equal((await renameRegion(TOKENS.super, region.id, '新竹市')).name, '新竹市');
  assert.equal((await renameRegion(TOKENS.secondary, region.id, '新竹市')).name, '新竹市');

  await assert.rejects(renameRegion(TOKENS.secondary, region.id, '桃園'), /already exists/);
  await assert.rejects(renameRegion(TOKENS.secondary, region.id, ' '), /1 to 30 characters/);
  await assert.rejects(renameRegion(TOKENS.other, region.id, '別人的'), /another administrator group/);
  await assert.rejects(renameRegion(TOKENS.super, MISSING_REGION, '不存在'), /region is not available/);
});

test('administrators persist exact pin and unpin assignments idempotently within their allowed groups', async () => {
  const own = await createRegion(TOKENS.secondary, SECONDARY, '置頂地區');
  const other = await createRegion(TOKENS.other, OTHER, '置頂地區');
  const root = await createRegion(TOKENS.super, SUPER, '置頂地區');
  assert.ok([own, other, root].every(region => region.is_pinned === false));

  for (const [token, region] of [
    [TOKENS.secondary, own],
    [TOKENS.other, other],
    [TOKENS.super, own],
    [TOKENS.super, other],
    [TOKENS.super, root],
  ]) {
    for (const isPinned of [true, true, false, false]) {
      assert.deepEqual(await setRegionPinned(token, region.id, isPinned), {
        id: region.id, name: region.name, admin_id: region.admin_id, is_pinned: isPinned,
      });
      const { rows: [persisted] } = await db.query('SELECT is_pinned FROM public.employee_regions WHERE id = $1', [region.id]);
      assert.equal(persisted.is_pinned, isPinned);
    }
  }

  // Exercise SECURITY DEFINER with the actual granted roles, not only the database owner.
  for (const role of ['anon', 'authenticated', 'service_role']) {
    try {
      await db.exec(`SET ROLE ${role}`);
      for (const isPinned of [true, true, false, false]) {
        assert.equal((await setRegionPinned(TOKENS.secondary, own.id, isPinned)).is_pinned, isPinned);
      }
      await assert.rejects(setRegionPinned(TOKENS.other, own.id, true), /another administrator group/);
    } finally {
      await db.exec('RESET ROLE');
    }
    const { rows: [persisted] } = await db.query('SELECT is_pinned FROM public.employee_regions WHERE id = $1', [own.id]);
    assert.equal(persisted.is_pinned, false);
  }
});

test('pin assignments reject cross-group, unauthorized, missing and null inputs without changing stored pins', async () => {
  const own = await createRegion(TOKENS.secondary, SECONDARY, '置頂權限');
  const other = await createRegion(TOKENS.other, OTHER, '置頂權限');
  await setRegionPinned(TOKENS.secondary, own.id, true);
  await setRegionPinned(TOKENS.other, other.id, true);

  await assert.rejects(setRegionPinned(TOKENS.other, own.id, false), /another administrator group/);
  await assert.rejects(setRegionPinned(TOKENS.secondary, other.id, false), /another administrator group/);
  await assert.rejects(setRegionPinned(TOKENS.emergency, own.id, false), /session is invalid or expired/);
  await assert.rejects(setRegionPinned('10000000-0000-4000-8000-0000000000ff', own.id, false), /session is invalid or expired/);
  await assert.rejects(setRegionPinned(null, own.id, false), /session is invalid or expired/);
  await assert.rejects(setRegionPinned(TOKENS.super, MISSING_REGION, true), /region is not available/);
  await assert.rejects(setRegionPinned(TOKENS.secondary, MISSING_REGION, false), /region is not available/);
  await assert.rejects(setRegionPinned(TOKENS.super, null, true), /region is not available/);
  await assert.rejects(setRegionPinned(TOKENS.secondary, own.id, null), /pinned state must not be null/);
  await assert.rejects(setRegionPinned(TOKENS.super, own.id, null), /pinned state must not be null/);

  const { rows } = await db.query('SELECT id, is_pinned FROM public.employee_regions WHERE id = ANY($1)', [[own.id, other.id]]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(region => region.is_pinned === true));
});

test('rename and duplicate create responses preserve an existing true pin', async () => {
  const region = await createRegion(TOKENS.secondary, SECONDARY, 'Pin Keep');
  await createRegion(TOKENS.other, OTHER, 'Pin Keep Renamed');
  await createRegion(TOKENS.secondary, SECONDARY, 'Pin Conflict');
  await setRegionPinned(TOKENS.secondary, region.id, true);

  const duplicate = await createRegion(TOKENS.super, SECONDARY, '  pin keep  ');
  assert.deepEqual(duplicate, { ...region, is_pinned: true, created: false });
  const renamed = await renameRegion(TOKENS.secondary, region.id, '  Pin Keep Renamed  ');
  assert.deepEqual(renamed, { id: region.id, name: 'Pin Keep Renamed', admin_id: SECONDARY, is_pinned: true });
  assert.deepEqual(await renameRegion(TOKENS.super, region.id, 'Pin Keep Renamed'), renamed);
  assert.deepEqual(await createRegion(TOKENS.secondary, SECONDARY, 'pin keep renamed'), { ...renamed, created: false });
  await assert.rejects(renameRegion(TOKENS.secondary, region.id, 'Pin Conflict'), /already exists/);

  const { rows: [persisted] } = await db.query('SELECT id, name, admin_id, is_pinned FROM public.employee_regions WHERE id = $1', [region.id]);
  assert.deepEqual(persisted, renamed);
});

test('deleting a region in use requires moving its employees to another region of the same group', async () => {
  const keep = await createRegion(TOKENS.super, SECONDARY, '保留區');
  const remove = await createRegion(TOKENS.super, SECONDARY, '刪除區');
  const unused = await createRegion(TOKENS.super, SECONDARY, '空區');
  const foreign = await createRegion(TOKENS.super, OTHER, '外組');
  const first = (await createEmployee(TOKENS.super, SECONDARY, { p_region_id: remove.id })).user;
  const second = (await createEmployee(TOKENS.super, SECONDARY, { p_region_id: remove.id })).user;
  const archived = (await createEmployee(TOKENS.super, SECONDARY, { p_region_id: remove.id })).user;
  await db.exec(`
    SET session_replication_role = replica;
    UPDATE public.users SET archived_at = now(), is_active = false WHERE id = '${archived.id}';
    RESET session_replication_role;
  `);

  assert.deepEqual(await deleteRegion(TOKENS.secondary, unused.id), { id: unused.id, replacement_region_id: null, moved_count: 0 });

  await assert.rejects(deleteRegion(TOKENS.secondary, remove.id), /still assigned to 2 employees/);
  await assert.rejects(deleteRegion(TOKENS.secondary, remove.id, foreign.id), /replacement region is not available/);
  await assert.rejects(deleteRegion(TOKENS.secondary, remove.id, remove.id), /replacement region is not available/);
  await assert.rejects(deleteRegion(TOKENS.other, remove.id, keep.id), /another administrator group/);

  const result = await deleteRegion(TOKENS.secondary, remove.id, keep.id);
  assert.deepEqual(result, { id: remove.id, replacement_region_id: keep.id, moved_count: 2 });
  assert.equal(await regionOf(first.id), keep.id);
  assert.equal(await regionOf(second.id), keep.id);
  assert.equal(await regionOf(archived.id), null);
  assert.deepEqual((await db.query('SELECT id FROM public.employee_regions WHERE id = $1', [remove.id])).rows, []);
});

test('creating an employee requires a region from the employee administrator group', async () => {
  const { id: taipei } = await createRegion(TOKENS.super, SECONDARY, '台北');
  const { id: otherTaipei } = await createRegion(TOKENS.super, OTHER, '台北');

  const withRegion = await createEmployee(TOKENS.super, SECONDARY, { p_region_id: taipei });
  assert.equal(withRegion.success, true);
  assert.equal(withRegion.user.region_id, taipei);

  const bySecondary = await createEmployee(TOKENS.secondary, SECONDARY, { p_region_id: taipei });
  assert.equal(await regionOf(bySecondary.user.id), taipei);

  const before = await countUsers();
  await assert.rejects(createEmployee(TOKENS.super, SECONDARY), /region must be selected/);
  await assert.rejects(createEmployee(TOKENS.super, SECONDARY, { p_region_id: null }), /region must be selected/);
  await assert.rejects(createEmployee(TOKENS.super, SECONDARY, { p_region_id: otherTaipei }), /region is not available/);
  await assert.rejects(createEmployee(TOKENS.secondary, SECONDARY, { p_region_id: MISSING_REGION }), /region is not available/);
  await assert.rejects(call('admin_create_employee_account', {
    p_admin_session_token: TOKENS.super,
    p_username: 'region-legacy-wrapper',
    p_password: 'secret-123',
    p_employee_id: 'R-legacy',
    p_created_by: OTHER,
    p_remarks: '',
    p_dispatch_group_id: GROUP,
  }), /region must be selected/);
  assert.equal(await countUsers(), before);
});

test('employee updates change the region within the group but never clear it', async () => {
  const { id: taipei } = await createRegion(TOKENS.super, SECONDARY, '台北');
  const { id: kaohsiung } = await createRegion(TOKENS.super, SECONDARY, '高雄');
  const { id: otherTaipei } = await createRegion(TOKENS.super, OTHER, '台北');
  const employee = (await createEmployee(TOKENS.super, SECONDARY, { p_region_id: taipei })).user;
  const update = (token, updates) => call('admin_update_employee_account', {
    p_admin_session_token: token,
    p_user_id: employee.id,
    p_updates: JSON.stringify(updates),
  });

  assert.equal((await update(TOKENS.secondary, { region_id: kaohsiung })).region_id, kaohsiung);
  assert.equal((await update(TOKENS.super, { region_id: taipei, remarks: 'still here' })).region_id, taipei);
  assert.equal((await update(TOKENS.super, { tags: ['a'] })).region_id, taipei);

  await assert.rejects(update(TOKENS.super, { region_id: null }), /region must be selected/);
  await assert.rejects(update(TOKENS.super, { region_id: '' }), /region must be selected/);
  await assert.rejects(update(TOKENS.super, { region_id: otherTaipei }), /region is not available/);
  await assert.rejects(update(TOKENS.super, { region_id: MISSING_REGION }), /region is not available/);
  await assert.rejects(update(TOKENS.other, { region_id: otherTaipei }), /permission to manage this employee/);
  await assert.rejects(update(TOKENS.super, { region: taipei }), /protected field/);

  const { rows: [row] } = await db.query('SELECT region_id, remarks, tags FROM public.users WHERE id = $1', [employee.id]);
  assert.deepEqual(row, { region_id: taipei, remarks: 'still here', tags: ['a'] });
});

test('the employee snapshot returns persisted boolean pins only for visible administrator groups', async () => {
  const { id: taipei } = await createRegion(TOKENS.super, OTHER, '台北');
  const secondaryPinned = await createRegion(TOKENS.secondary, SECONDARY, '快照置頂');
  const unpinned = await createRegion(TOKENS.secondary, SECONDARY, '快照未置頂');
  await setRegionPinned(TOKENS.secondary, secondaryPinned.id, true);
  await setRegionPinned(TOKENS.super, taipei, true);
  const created = (await createEmployee(TOKENS.super, OTHER, { p_region_id: taipei })).user;

  const superSnapshot = await call('get_employee_management_snapshot', { p_admin_session_token: TOKENS.super });
  const { rows: visibleRegions } = await db.query(`
    SELECT region.id, region.name, region.admin_id, region.is_pinned
    FROM public.employee_regions AS region
    INNER JOIN public.admins AS a ON a.id = region.admin_id AND a.role <> 'emergency_admin'
    ORDER BY region.created_at, region.name, region.id
  `);
  assert.deepEqual(superSnapshot.regions, visibleRegions);
  assert.ok(superSnapshot.regions.every(region => typeof region.is_pinned === 'boolean'));
  assert.equal(superSnapshot.regions.find(region => region.id === secondaryPinned.id).is_pinned, true);
  assert.equal(superSnapshot.regions.find(region => region.id === taipei).is_pinned, true);
  assert.equal(superSnapshot.regions.find(region => region.id === unpinned.id).is_pinned, false);
  assert.equal(superSnapshot.employees.find(employee => employee.id === created.id).region_id, taipei);
  assert.ok(superSnapshot.employees.every(employee => 'region_id' in employee));

  const secondarySnapshot = await call('get_employee_management_snapshot', { p_admin_session_token: TOKENS.secondary });
  assert.ok(secondarySnapshot.regions.length > 0);
  assert.deepEqual(secondarySnapshot.regions, visibleRegions.filter(region => region.admin_id === SECONDARY));
  assert.ok(secondarySnapshot.employees.every(employee => employee.created_by === SECONDARY));
  assert.equal(secondarySnapshot.regions.find(region => region.id === secondaryPinned.id).is_pinned, true);
  assert.equal(secondarySnapshot.regions.find(region => region.id === unpinned.id).is_pinned, false);

  const otherSnapshot = await call('get_employee_management_snapshot', { p_admin_session_token: TOKENS.other });
  assert.deepEqual(otherSnapshot.regions, visibleRegions.filter(region => region.admin_id === OTHER));
  assert.ok(otherSnapshot.employees.every(employee => employee.created_by === OTHER));

  await setRegionPinned(TOKENS.super, secondaryPinned.id, false);
  const refreshed = await call('get_employee_management_snapshot', { p_admin_session_token: TOKENS.secondary });
  assert.deepEqual(refreshed.regions, secondarySnapshot.regions.map(region => (
    region.id === secondaryPinned.id ? { ...region, is_pinned: false } : region
  )));
});
