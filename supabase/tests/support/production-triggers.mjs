import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const missingTriggers = [
  ['orders', 'trigger_audit_order_status'],
  ['wallet_transactions', 'trigger_audit_commission_transaction'],
  ['customer_employee_conversations', 'trg_sync_conversation_source_type'],
];
// SQL identifiers/roles never come from arbitrary ACL text in the observation files.
const aclProfiles = {
  default: { raw: null, grants: [] },
  owner: { raw: '{postgres=X/postgres}', grants: ['postgres'] },
  service: { raw: '{postgres=X/postgres,service_role=X/postgres}', grants: ['postgres', 'service_role'] },
  broad: {
    raw: '{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}',
    grants: ['PUBLIC', 'postgres', 'anon', 'authenticated', 'service_role'],
  },
};
const roles = ['PUBLIC', 'postgres', 'anon', 'authenticated', 'service_role'];
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const identifier = name => `"${name.replaceAll('"', '""')}"`;

async function readObservations() {
  const [catalog, overrides] = await Promise.all([
    'production-trigger-catalog.json', 'production-trigger-overrides.json',
  ].map(async file => JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'))));
  assert.equal(catalog.project, 'hxpbpqoqkoiiplvdwmld');
  assert.equal(catalog.observedAt, '2026-10-23');
  assert.equal(overrides.project, catalog.project);
  assert.equal(overrides.observedAt, catalog.observedAt);
  assert.equal(catalog.owner, 'postgres');
  assert.equal(catalog.bypassrls, true);
  assert.equal(catalog.mode, 'O');
  assert.deepEqual(catalog.aclProfiles, Object.fromEntries(Object.entries(aclProfiles).map(([key, value]) => [key, value.raw])));
  assert.deepEqual(catalog.missing, missingTriggers);
  assert.equal(catalog.functions.length, 43);
  assert.equal(new Set(catalog.functions.map(row => row[0])).size, 43);
  for (const row of catalog.functions) {
    assert.equal(row.length, 4);
    const [name, hash, path, profile] = row;
    assert.match(name, /^(public|private)\.[a-z_]+\(\)$/);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.match(path, /^(pg_catalog|public|private|pg_temp)(, (pg_catalog|public|private|pg_temp))*$/);
    assert.ok(Object.hasOwn(aclProfiles, profile), `Unknown ACL profile: ${profile}`);
  }
  assert.equal(Object.keys(overrides.functions).length, 9);
  for (const [name, definition] of Object.entries(overrides.functions)) {
    const observed = catalog.functions.find(row => row[0] === name);
    assert.ok(observed, `Override not in catalog: ${name}`);
    assert.ok(definition.startsWith(`CREATE OR REPLACE FUNCTION ${name}\n`), `Override signature mismatch: ${name}`);
    assert.equal(sha256(definition), observed[1], `Override full SHA mismatch: ${name}`);
  }
  assert.equal(Object.keys(catalog.triggers).length, 70);
  for (const [name, hash] of Object.entries(catalog.triggers)) {
    assert.match(name, /^[a-z_]+\.[a-z_]+$/);
    assert.match(hash, /^[a-f0-9]{64}$/);
  }
  return { catalog, overrides: overrides.functions };
}

async function assertEmptyHistoricalFixture(db) {
  const { rows: [state] } = await db.query(`SELECT current_user AS username,
    to_regclass('private.employee_work_stop_markers')::text AS historical_end,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','private') AND c.relname LIKE 'employee_transfer_%')
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','private') AND p.proname LIKE 'employee_transfer_%') AS transfer_installed`);
  assert.equal(state.username, 'postgres', 'Fixture must run as local postgres');
  assert.ok(state.historical_end, 'Replay all 526 historical migrations through 20261101000003 first');
  assert.equal(state.transfer_installed, false, 'Fixture must run before any transfer SQL00');
  // These tables contain configuration seeds from the historical replay, not business fixtures.
  const seeded = new Set([
    'private.content_audit_storage_origins', 'public.admin_configs', 'public.announcement_categories',
    'public.data_retention_policies', 'public.dispatch_config', 'public.dispatch_groups',
    'public.dispatch_order_pools', 'public.history_cleanup_config', 'public.product_types',
    'public.system_configs', 'storage.buckets',
  ]);
  const { rows: tables } = await db.query(`SELECT n.nspname AS schema,c.relname AS name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private','storage','auth')
      AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY 1,2`);
  for (const table of tables) {
    if (seeded.has(`${table.schema}.${table.name}`)) continue;
    const { rows: [row] } = await db.query(`SELECT EXISTS (SELECT 1 FROM ${identifier(table.schema)}.${identifier(table.name)}) AS populated`);
    assert.equal(row.populated, false, `Fixture requires an empty test database: ${table.schema}.${table.name}`);
  }
}

async function readFunction(db, name) {
  const { rows } = await db.query(`SELECT pg_get_functiondef(p.oid) AS definition,
    p.prosrc AS source,p.proacl::text AS acl,owner.rolname AS owner,owner.rolbypassrls AS bypassrls
    FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=to_regprocedure($1)`, [name]);
  assert.equal(rows.length, 1, `Historical function missing: ${name}`);
  assert.equal(rows[0].owner, 'postgres', `Unexpected local owner: ${name}`);
  assert.equal(rows[0].bypassrls, true, `Unexpected local BYPASSRLS: ${name}`);
  return rows[0];
}

function withoutSourceIndentation({ definition, source }, name) {
  // Only construct an exact test fixture. Never use this transformation for installation approval.
  const delimiter = definition.match(/\nAS (\$function\w*\$)/);
  assert.ok(delimiter, `Cannot locate source delimiter: ${name}`);
  const start = delimiter.index + delimiter[0].length;
  const end = definition.lastIndexOf(delimiter[1]);
  assert.equal(definition.slice(start, end), source, `Cannot locate exact prosrc: ${name}`);
  return definition.slice(0, start) + source.replace(/^[ \t]+/gm, '') + definition.slice(end);
}

async function applyFunction(db, [name, hash, path, profile], overrides) {
  // Always read the original full definition, source and raw ACL before changing this function.
  const original = await readFunction(db, name);
  if (Object.hasOwn(overrides, name)) {
    await db.exec(overrides[name]);
  } else {
    await db.exec(`ALTER FUNCTION ${name} SET search_path TO ${path}`);
    const configured = await readFunction(db, name);
    if (sha256(configured.definition) !== hash) {
      await db.exec(withoutSourceIndentation(configured, name));
    }
  }
  const replaced = await readFunction(db, name);
  assert.equal(sha256(replaced.definition), hash, `Observed full SHA mismatch: ${name}`);
  assert.equal(replaced.acl, original.acl, `Function replacement unexpectedly changed ACL: ${name}`);
  const expected = aclProfiles[profile];
  if (expected.raw === null) {
    // Preserve a genuinely NULL ACL; do not materialize an equivalent default ACL or edit pg_proc.
    assert.equal(original.acl, null, `Observed NULL ACL requires original NULL: ${name}`);
  } else {
    await db.exec(`REVOKE ALL ON FUNCTION ${name} FROM ${roles.join(', ')}`);
    for (const role of expected.grants) {
      await db.exec(`GRANT EXECUTE ON FUNCTION ${name} TO ${role}`);
    }
  }
  const final = await readFunction(db, name);
  assert.equal(sha256(final.definition), hash, `Final observed full SHA mismatch: ${name}`);
  assert.equal(final.acl, expected.raw, `Observed raw proacl mismatch: ${name}`);
}

async function readTriggers(db) {
  return (await db.query(`SELECT c.relname||'.'||t.tgname AS name,t.tgenabled AS mode,
    pg_get_triggerdef(t.oid,false) AS definition,t.tgfoid AS function_oid,
    encode(sha256(convert_to(jsonb_build_array(
      pg_get_triggerdef(t.oid,false),pg_get_functiondef(p.oid),owner.rolname,owner.rolbypassrls,
      (SELECT jsonb_agg(jsonb_build_array(pg_get_userbyid(acl.grantor),acl.grantee=0,
        CASE WHEN acl.grantee=0 THEN NULL ELSE pg_get_userbyid(acl.grantee) END,
        acl.privilege_type,acl.is_grantable)
        ORDER BY pg_get_userbyid(acl.grantor) COLLATE "C",acl.grantee=0,
          pg_get_userbyid(acl.grantee) COLLATE "C",acl.privilege_type COLLATE "C",acl.is_grantable)
        FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl)
    )::text,'UTF8')),'hex') AS portable
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_roles owner ON owner.oid=p.proowner
    WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)).rows;
}

// Exact observations on an empty local PGlite fixture, never production baseline approval.
export async function applyProductionTriggerFixture(db) {
  if (!(db instanceof PGlite)) throw new TypeError('Production trigger fixture accepts only a local PGlite test database');
  await db.waitReady;
  assert.equal(db.isInTransaction(), false, 'Fixture requires its own transaction');
  const { catalog, overrides } = await readObservations();
  return db.transaction(async tx => {
    await tx.exec('SET LOCAL search_path=pg_catalog,public,private,pg_temp');
    await assertEmptyHistoricalFixture(tx);
    const before = await readTriggers(tx);
    const failures = [];
    for (const observed of catalog.functions) {
      await tx.exec('SAVEPOINT observed_function');
      try {
        await applyFunction(tx, observed, overrides);
        await tx.exec('RELEASE SAVEPOINT observed_function');
      } catch (cause) {
        await tx.exec('ROLLBACK TO SAVEPOINT observed_function; RELEASE SAVEPOINT observed_function');
        failures.push(new Error(`${observed[0]}: ${cause.message}`, { cause }));
      }
    }
    if (failures.length) {
      throw new AggregateError(failures,
        `Production observation fixture mismatch (${failures.length}/43 functions):\n${failures.map(error => error.message).join('\n')}`);
    }
    for (const [table, trigger] of missingTriggers) {
      // No IF EXISTS or CASCADE: a missing historical object or a dependency must fail closed.
      await tx.exec(`DROP TRIGGER ${identifier(trigger)} ON public.${identifier(table)}`);
    }
    const after = await readTriggers(tx);
    const dropped = new Set(missingTriggers.map(([table, trigger]) => `${table}.${trigger}`));
    assert.deepEqual(after.map(row => [row.name, row.mode, row.definition, row.function_oid]),
      before.filter(row => !dropped.has(row.name)).map(row => [row.name, row.mode, row.definition, row.function_oid]),
      'Fixture changed an unrelated trigger');
    const byName = new Map(after.map(row => [row.name, row]));
    for (const [name, hash] of Object.entries(catalog.triggers)) {
      assert.ok(byName.has(name), `Observed trigger missing: ${name}`);
      assert.equal(byName.get(name).mode, catalog.mode, `Observed trigger mode mismatch: ${name}`);
      assert.equal(byName.get(name).portable, hash, `Observed portable trigger SHA mismatch: ${name}`);
    }
    for (const [name, hash, , profile] of catalog.functions) {
      const final = await readFunction(tx, name);
      assert.equal(sha256(final.definition), hash, `Final observed full SHA mismatch: ${name}`);
      assert.equal(final.acl, catalog.aclProfiles[profile], `Final observed raw proacl mismatch: ${name}`);
    }
    return { functions: catalog.functions.length, triggers: Object.keys(catalog.triggers).length, droppedTriggers: missingTriggers.length };
  });
}
