import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { replayMigrations } from './support/replay-migrations.mjs';
import { replayProductionTransferMigrations, PRODUCTION_TRANSFER_LAST } from './support/production-transfer.mjs';
import { rows, scalar } from './support/transfer-harness.mjs';

const historicalEnd = '20261101000003_keep_user_stopped_work_sessions_stopped.sql';
const audits = [
  {
    scope: 'identity', file: '15_restore_employee_identities', tag: 'install_identity_audit',
    assertion: 'employee_transfer_assert_identity_triggers', error: 'Unreviewed employee identity write triggers.',
    tables: ['public.users', 'public.financial_employee_credentials', 'public.wallets', 'public.orders', 'public.product_types'],
    table: 'product_types', trigger: 'assign_product_type_sort_order', procedure: 'private.assign_product_type_sort_order()',
    mixedProcedure: 'private.protect_order_dispatch_rate_snapshots()', count: 16,
  },
  {
    scope: 'finance', file: '18_restore_employee_finance', tag: 'install_finance_audit',
    assertion: 'employee_transfer_assert_finance_triggers', error: 'Unreviewed employee finance triggers.',
    tables: ['public.wallets', 'public.wallet_balance_baselines', 'public.wallet_ledger_entries',
      'public.wallet_transactions', 'public.withdrawals', 'public.wallet_reconciliation_audit'],
    table: 'wallet_transactions', trigger: 'queue_notification_automation_from_wallet_transaction',
    procedure: 'private.queue_automation_from_wallet_transaction()',
    mixedProcedure: 'public.enqueue_changed_wallet()', count: 9,
  },
  {
    scope: 'activity', file: '20_restore_employee_activity', tag: 'install_activity_audit',
    assertion: 'employee_transfer_assert_activity_triggers', error: 'Unreviewed employee activity triggers.',
    tables: ['public.employee_login_history', 'public.work_sessions', 'private.employee_work_stop_markers'],
    table: 'work_sessions', trigger: 'queue_notification_automation_from_work_session',
    procedure: 'private.queue_automation_from_work_session()',
    mixedProcedure: 'public.cleanup_duplicate_work_sessions()', count: 7,
  },
  {
    scope: 'notifications', file: '27_restore_site_notifications', tag: 'audit',
    assertion: 'employee_transfer_notification_restore_assert', error: 'Unreviewed notification restore triggers.',
    keys: 'employee_transfer_notifications_keys',
    table: 'messages', trigger: 'sync_messages_delivery_mode', procedure: 'private.sync_notification_delivery_mode()',
    mixedProcedure: 'private.sync_notification_delivery_mode()', count: 21,
  },
  {
    scope: 'chat', file: '32_restore_site_chat', tag: 'audit',
    assertion: 'employee_transfer_chat_restore_assert', error: 'Unreviewed chat restore triggers.',
    keys: 'employee_transfer_chat_keys',
    table: 'simulated_customers', trigger: 'set_customer_id_trigger', procedure: 'public.set_customer_id()',
    mixedProcedure: 'public.set_customer_id()', count: 19,
  },
];
const supplementary = [
  { scope: 'shared timestamp', table: 'system_configs', trigger: 'set_system_configs_updated_at',
    procedure: 'public.update_system_configs_updated_at()', assertion: 'employee_transfer_assert_shared_replace_triggers' },
  { scope: 'submission counter', table: 'used_order_data', trigger: 'trigger_update_valid_data_usage',
    procedure: 'public.update_valid_data_usage_stats()', assertion: 'employee_transfer_assert_valid_triggers' },
];
const missing = [
  ['orders', 'trigger_audit_order_status', 'identity'],
  ['wallet_transactions', 'trigger_audit_commission_transaction', 'finance'],
  ['customer_employee_conversations', 'trg_sync_conversation_source_type', 'chat'],
];
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
let replay, catalog;
const historicalDefinitions = new Map();
const historicalTriggers = new Map();
const installations = new Map();

async function functionState(db, name) {
  const result = await rows(db, `SELECT pg_get_functiondef(p.oid) AS definition,p.prosrc AS source,
    p.proconfig AS config,p.proacl::text AS acl,owner.rolname AS owner,owner.rolbypassrls AS bypassrls
    FROM pg_proc p JOIN pg_roles owner ON owner.oid=p.proowner WHERE p.oid=to_regprocedure($1)`, [name]);
  assert.equal(result.length, 1, name);
  return result[0];
}

before(async () => {
  catalog = JSON.parse(await readFile(new URL('./support/production-trigger-catalog.json', import.meta.url), 'utf8'));
  for (const audit of audits) {
    const sql = await readFile(new URL(`../migrations/202611020000${audit.file}.sql`, import.meta.url), 'utf8');
    const start = sql.indexOf(`DO $${audit.tag}$`);
    const closing = `$${audit.tag}$;`;
    const end = sql.indexOf(closing, start);
    assert.ok(start >= 0 && end > start, audit.scope);
    const installation = sql.slice(start, end + closing.length);
    const reviewed = installation.match(/v_reviewed_production constant text\s*:=\s*'([a-f0-9]{64})'/);
    const localMap = installation.match(/v_expected constant jsonb\s*:=\s*'([^']+)'/);
    assert.ok(reviewed, audit.scope);
    assert.ok(localMap, audit.scope);
    installations.set(audit.scope, { sql: installation, reviewed: reviewed[1], localMap: JSON.parse(localMap[1]) });
  }
  const historical = await replayMigrations({ upTo: historicalEnd, strict: true });
  try {
    assert.equal(historical.files.length, 526);
    assert.equal(historical.validation.matched.length, 12);
    for (const audit of audits) {
      historicalDefinitions.set(audit.scope, await functionState(historical.db, audit.mixedProcedure));
    }
    for (const audit of supplementary) historicalDefinitions.set(audit.scope, await functionState(historical.db, audit.procedure));
    for (const [table, trigger] of missing) {
      const found = await rows(historical.db, `SELECT pg_get_triggerdef(oid,false) AS definition,tgenabled AS mode
        FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2 AND NOT tgisinternal`, [`public.${table}`, trigger]);
      assert.equal(found.length, 1, trigger);
      assert.equal(found[0].mode, 'O', trigger);
      historicalTriggers.set(trigger, found[0].definition);
    }
  } finally {
    await historical.db.close();
  }
  replay = await replayProductionTransferMigrations({ triggerProfile: true });
}, { timeout: 300000 });

after(async () => { await replay?.db.close(); });

const runtime = audit => scalar(replay.db, `SELECT private.${audit.assertion}()`);
const install = audit => replay.db.exec(installations.get(audit.scope).sql);

async function transaction(use) {
  const db = replay.db;
  await db.exec('BEGIN');
  try { return await use(db); }
  finally { await db.exec('ROLLBACK'); }
}

async function rejectAudit(audit, use) {
  await replay.db.exec('SAVEPOINT rejected_audit');
  try {
    await assert.rejects(use, error => {
      assert.equal(error.code, 'P0001');
      assert.equal(error.message, audit.error);
      return true;
    });
  } finally {
    await replay.db.exec('ROLLBACK TO SAVEPOINT rejected_audit; RELEASE SAVEPOINT rejected_audit');
  }
}

async function rejectBoth(audit) {
  const name = `private.${audit.assertion}()`;
  const before = await functionState(replay.db, name);
  await rejectAudit(audit, () => runtime(audit));
  await rejectAudit(audit, () => install(audit));
  assert.deepEqual(await functionState(replay.db, name), before);
}

async function triggerRows(audit) {
  const tables = audit.tables ?? (await scalar(replay.db, `SELECT private.${audit.keys}()`)).map(key => `public.${key}`);
  return rows(replay.db, `SELECT c.relname||'.'||t.tgname AS name,t.tgenabled AS mode,
    private.employee_transfer_install_trigger_digest(t.oid) AS portable,
    private.employee_transfer_trigger_digest(t.oid) AS native
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE t.tgrelid=ANY(ARRAY(SELECT to_regclass(name) FROM unnest($1::text[]) AS item(name)))
      AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance' ORDER BY 1`, [tables]);
}

async function groupState(audit) {
  const triggers = await triggerRows(audit);
  return {
    portable: Object.fromEntries(triggers.map(row => [row.name, row.portable])),
    native: Object.fromEntries(triggers.map(row => [row.name, row.native])),
    modes: Object.fromEntries(triggers.map(row => [row.name, row.mode])),
  };
}

function literalMap(source, name) {
  const match = source.match(new RegExp(`${name} constant jsonb\\s*:?=\\s*'([^']+)'::jsonb`));
  assert.ok(match, name);
  return JSON.parse(match[1]);
}

async function assertRawSnapshot(audit) {
  const state = await groupState(audit);
  const fn = await functionState(replay.db, `private.${audit.assertion}()`);
  assert.deepEqual(literalMap(fn.source, 'v_expected'), state.native);
  assert.deepEqual(literalMap(fn.source, 'v_modes'), state.modes);
  assert.doesNotMatch(fn.source, /employee_transfer_install_trigger_digest|v_reviewed_production/);
  assert.match(fn.source, /employee_transfer_trigger_digest/);
}

test('the exact fixture preserves the independent 43 full function SHAs, search paths and original ACLs', async () => {
  assert.deepEqual(replay.productionTriggerBaseline, { functions: 45, triggers: 72, droppedTriggers: 3 });
  assert.equal(catalog.functions.length, 43);
  assert.equal(new Set(catalog.functions.map(row => row[0])).size, 43);
  for (const [name, hash, path, profile] of catalog.functions) {
    const fn = await functionState(replay.db, name);
    assert.equal(sha256(fn.definition), hash, name);
    assert.ok(fn.config.includes(`search_path=${path}`), name);
    assert.equal(fn.acl, catalog.aclProfiles[profile], name);
    assert.equal(fn.owner, catalog.owner, name);
    assert.equal(fn.bypassrls, catalog.bypassrls, name);
  }
});

test('the two supplementary shared/submission functions keep their exact observed definitions and ACLs', async () => {
  for (const [name, hash, path, profile] of catalog.additionalFunctions) {
    const fn = await functionState(replay.db, name);
    assert.equal(sha256(fn.definition), hash);
    assert.deepEqual(fn.config, [`search_path=${path}`]);
    assert.equal(fn.acl, catalog.aclProfiles[profile]);
  }
  await scalar(replay.db, 'SELECT private.employee_transfer_assert_shared_replace_triggers()');
  await scalar(replay.db, 'SELECT private.employee_transfer_assert_valid_triggers()');
});

test('the five-domain union matches all 70 independent trigger digests and exactly three fixture omissions', async () => {
  const actual = new Map();
  for (const audit of audits) for (const row of await triggerRows(audit)) actual.set(row.name, row);
  assert.equal(actual.size, 70);
  assert.deepEqual(Object.fromEntries([...actual].map(([name, row]) => [name, row.portable])), catalog.triggers);
  for (const row of actual.values()) assert.equal(row.mode, 'O', row.name);
  assert.equal(catalog.mode, 'O');
  assert.deepEqual(catalog.missing, missing.map(([table, trigger]) => [table, trigger]));
  for (const [table, trigger] of missing) {
    assert.equal(await scalar(replay.db, `SELECT count(*)::int FROM pg_trigger
      WHERE tgrelid=to_regclass($1) AND tgname=$2`, [`public.${table}`, trigger]), 0, trigger);
  }
});

test('all 58 real transfer migrations install after the exact trigger and 96-table/871-column profiles', async t => {
  assert.equal(replay.files.length, 584);
  assert.equal(replay.files.filter(file => file.startsWith('20261102')).length, 58);
  assert.equal(replay.files.at(-1), PRODUCTION_TRANSFER_LAST);
  assert.equal(replay.validation.matched.length, 12);
  assert.equal(replay.failures.length, 12);
  assert.equal(replay.validation.freshDatabaseVerified, false);
  assert.deepEqual(replay.productionColumnBaseline, {
    tableCount: 96, columnCount: 871, exportAuthorized: false,
    fingerprint: 'cc05ccfbec83f315554f6e598a80c4ca442169e8911089ce4fb081d5ae0db128',
  });
  await scalar(replay.db, 'SELECT private.employee_transfer_assert_maintenance_guards()');
  for (const audit of audits) await runtime(audit);
  t.diagnostic('Local PGlite with 12 known historical replay failures; not native PostgreSQL, production or deployment acceptance.');
});

test('digest helpers and all five runtime assertions remain private with fixed SECURITY DEFINER search paths', async () => {
  const names = ['private.employee_transfer_install_trigger_digest(oid)', 'private.employee_transfer_trigger_digest(oid)',
    ...audits.map(audit => `private.${audit.assertion}()`)];
  for (const name of names) {
    const metadata = await rows(replay.db, `SELECT p.prosecdef,p.provolatile,p.proconfig,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner)))
        WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p WHERE p.oid=to_regprocedure($1)`, [name]);
    assert.equal(metadata.length, 1, name);
    assert.equal(metadata[0].prosecdef, true, name);
    assert.equal(metadata[0].provolatile, 's', name);
    assert.ok(metadata[0].proconfig.includes('search_path=pg_catalog, public, private, pg_temp'), name);
    assert.equal(metadata[0].public_execute, false, name);
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(await scalar(replay.db, "SELECT has_function_privilege($1,to_regprocedure($2),'EXECUTE')", [role, name]), false, `${role}: ${name}`);
    }
  }
});

for (const audit of audits) {
  test(`${audit.scope}: the reviewed production hash binds the entire independent portable map and exact original O modes`, async () => {
    const state = await groupState(audit);
    assert.equal(Object.keys(state.portable).length, audit.count);
    const independent = Object.fromEntries(Object.keys(state.portable).map(name => {
      assert.ok(Object.hasOwn(catalog.triggers, name), name);
      return [name, catalog.triggers[name]];
    }));
    assert.deepEqual(state.portable, independent);
    assert.ok(Object.values(state.modes).every(mode => mode === 'O'));
    assert.notDeepEqual(state.portable, installations.get(audit.scope).localMap);
    const hash = await scalar(replay.db, `SELECT encode(sha256(convert_to(jsonb_build_array($1::jsonb,$2::jsonb)::text,'UTF8')),'hex')`,
      [JSON.stringify(independent), JSON.stringify(state.modes)]);
    assert.equal(hash, installations.get(audit.scope).reviewed);
    await assertRawSnapshot(audit);
    await runtime(audit);
  });

  test(`${audit.scope}: equivalent ACL representation is installable but the old runtime pins the original raw snapshot`, async () => {
    await transaction(async db => {
      const before = await groupState(audit);
      const original = await functionState(db, audit.procedure);
      await db.exec(`REVOKE EXECUTE ON FUNCTION ${audit.procedure} FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION ${audit.procedure} TO PUBLIC`);
      const after = await groupState(audit);
      const changed = await functionState(db, audit.procedure);
      assert.notEqual(changed.acl, original.acl);
      assert.deepEqual(after.portable, before.portable);
      assert.deepEqual(after.modes, before.modes);
      assert.notDeepEqual(after.native, before.native);
      await rejectAudit(audit, () => runtime(audit));
      await db.exec(`DROP FUNCTION private.${audit.assertion}()`);
      await install(audit);
      await assertRawSnapshot(audit);
      await runtime(audit);
    });
    await runtime(audit);
    await assertRawSnapshot(audit);
  });

  for (const [reason, mutation] of [
    ['an added trigger', db => db.exec(`CREATE TRIGGER unreviewed_production_trigger BEFORE INSERT ON public.${audit.table}
      FOR EACH ROW EXECUTE FUNCTION ${audit.procedure}`)],
    ['a deleted trigger', db => db.exec(`DROP TRIGGER ${audit.trigger} ON public.${audit.table}`)],
    ['a disabled trigger', db => db.exec(`ALTER TABLE public.${audit.table} DISABLE TRIGGER ${audit.trigger}`)],
    ['a changed function body', async db => {
      const fn = await functionState(db, audit.procedure);
      const source = fn.source.replace(/\bBEGIN\b/i, 'BEGIN\n  PERFORM 1;');
      assert.notEqual(source, fn.source);
      const delimiter = fn.definition.match(/\nAS (\$function\w*\$)/);
      assert.ok(delimiter);
      const start = delimiter.index + delimiter[0].length;
      const end = fn.definition.lastIndexOf(delimiter[1]);
      assert.equal(fn.definition.slice(start, end), fn.source);
      await db.exec(fn.definition.slice(0, start) + source + fn.definition.slice(end));
      const changed = await functionState(db, audit.procedure);
      assert.equal(changed.source, source);
      assert.deepEqual(changed.config, fn.config);
      assert.equal(changed.acl, fn.acl);
    }],
    ['changed function SET configuration', db => db.exec(`ALTER FUNCTION ${audit.procedure} SET search_path=pg_catalog`)],
    ['changed effective ACLs', db => db.exec(`REVOKE EXECUTE ON FUNCTION ${audit.procedure} FROM PUBLIC`)],
    ['a changed function owner', db => db.exec(`CREATE ROLE production_trigger_unreviewed_owner BYPASSRLS;
      ALTER FUNCTION ${audit.procedure} OWNER TO production_trigger_unreviewed_owner`)],
    ['original mode O changed to A', async db => {
      assert.equal(await scalar(db, `SELECT tgenabled FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2`,
        [`public.${audit.table}`, audit.trigger]), 'O');
      await db.exec(`ALTER TABLE public.${audit.table} ENABLE ALWAYS TRIGGER ${audit.trigger}`);
    }],
  ]) {
    test(`${audit.scope}: runtime and actual installation DO both reject ${reason}`, async () => {
      await transaction(async db => {
        await mutation(db);
        await rejectBoth(audit);
      });
      await runtime(audit);
    });
  }

  test(`${audit.scope}: a locally reviewed function mixed into the production group is rejected even with formal ACLs preserved`, async () => {
    await transaction(async db => {
      const formal = await functionState(db, audit.mixedProcedure);
      const local = historicalDefinitions.get(audit.scope);
      assert.notEqual(sha256(local.definition), sha256(formal.definition));
      const observed = catalog.functions.find(row => row[0] === audit.mixedProcedure);
      assert.ok(observed);
      assert.equal(sha256(formal.definition), observed[1]);
      await db.exec(local.definition);
      const mixed = await functionState(db, audit.mixedProcedure);
      assert.equal(mixed.definition, local.definition);
      assert.deepEqual(mixed.config, local.config);
      assert.equal(mixed.acl, formal.acl);
      assert.equal(mixed.owner, formal.owner);
      await rejectBoth(audit);
    });
    await runtime(audit);
  });
}

for (const audit of supplementary) {
  for (const [reason, mutate] of [
    ['original mode', db => db.exec(`ALTER TABLE public.${audit.table} ENABLE ALWAYS TRIGGER ${audit.trigger}`)],
    ['missing trigger', db => db.exec(`DROP TRIGGER ${audit.trigger} ON public.${audit.table}`)],
    ['SET configuration', db => db.exec(`ALTER FUNCTION ${audit.procedure} SET search_path=pg_catalog`)],
    ['effective privileges', db => db.exec(`REVOKE EXECUTE ON FUNCTION ${audit.procedure} FROM PUBLIC`)],
    ['owner', db => db.exec(`CREATE ROLE supplementary_unreviewed_owner BYPASSRLS; ALTER FUNCTION ${audit.procedure} OWNER TO supplementary_unreviewed_owner`)],
    ['known other function version', db => db.exec(historicalDefinitions.get(audit.scope).definition)],
  ]) test(`${audit.scope}: installed native snapshot rejects changed ${reason}`, async () => {
    await transaction(async db => {
      await mutate(db);
      await db.exec('SAVEPOINT supplementary_reject');
      try { await assert.rejects(() => scalar(db, `SELECT private.${audit.assertion}()`), /unreviewed/i); }
      finally { await db.exec('ROLLBACK TO SAVEPOINT supplementary_reject; RELEASE SAVEPOINT supplementary_reject'); }
    });
    await scalar(replay.db, `SELECT private.${audit.assertion}()`);
  });
}

for (const [table, trigger, scope] of missing) {
  test(`${scope}: reintroducing the historically defined missing ${table}.${trigger} fails runtime and installation`, async () => {
    const audit = audits.find(item => item.scope === scope);
    await transaction(async db => {
      assert.ok(historicalTriggers.has(trigger));
      await db.exec(historicalTriggers.get(trigger));
      assert.equal(await scalar(db, `SELECT tgenabled FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2`,
        [`public.${table}`, trigger]), 'O');
      await rejectBoth(audit);
    });
    await runtime(audit);
  });
}
