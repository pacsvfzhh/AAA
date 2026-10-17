import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const foundation = await readFile(new URL('../migrations/20261102000000_employee_data_transfer_foundation.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/20261102000004_harden_employee_transfer_triggers.sql', import.meta.url), 'utf8');
let db;

async function rows(sql, params = []) {
  return (await db.query(sql, params)).rows;
}
async function scalar(sql, params = []) {
  return Object.values((await rows(sql, params))[0])[0];
}
async function bypass(tables = ['wallet_transactions', 'wallets']) {
  return scalar('SELECT private.employee_transfer_bypass_triggers($1::text[])', [tables]);
}
async function restore(payload) {
  return db.query('SELECT private.employee_transfer_restore_triggers($1::jsonb)', [JSON.stringify(payload)]);
}
async function modes() {
  return rows(`SELECT relation.relname AS "table", trigger.tgname AS "trigger", trigger.tgenabled::text AS mode
    FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid = trigger.tgrelid
    WHERE NOT trigger.tgisinternal AND relation.relnamespace = 'public'::regnamespace
    ORDER BY relation.relname, trigger.tgname`);
}
async function transaction(fn) {
  await db.exec('BEGIN');
  try {
    await fn();
  } finally {
    await db.exec('ROLLBACK');
  }
}
async function rejected(fn, pattern) {
  const beforeModes = await modes();
  await db.exec('SAVEPOINT rejected_call');
  try {
    await assert.rejects(fn, pattern);
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT rejected_call; RELEASE SAVEPOINT rejected_call');
  }
  assert.deepEqual(await modes(), beforeModes, 'a failed call must not partially alter trigger modes');
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA private;
    REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
    CREATE TABLE public.admins (id uuid, username text);
    CREATE TABLE public.financial_login_attempts (
      account_type text, username text, failed_attempts integer, locked_until timestamptz, last_attempt_at timestamptz
    );
  `);
  await db.exec(foundation);
  const tables = await scalar('SELECT private.employee_transfer_tables()');
  for (const table of tables) {
    assert.match(table, /^[a-z_]+$/);
    await db.exec(`CREATE TABLE public.${table} (id integer PRIMARY KEY, value text)`);
  }
  await db.exec(`
    CREATE TABLE private.observed_effects (table_name text, trigger_name text);
    CREATE FUNCTION private.fixture_effect() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO private.observed_effects VALUES (TG_TABLE_NAME, TG_NAME);
      RETURN COALESCE(NEW, OLD);
    END;
    $$;
    CREATE FUNCTION private.fixture_protection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' OR NEW.value = TG_NAME THEN
        RAISE EXCEPTION 'Protection fired: %', TG_NAME;
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER trigger_enqueue_changed_wallet AFTER INSERT ON public.wallets
      FOR EACH ROW EXECUTE FUNCTION private.fixture_effect();
    CREATE TRIGGER prevent_delete_wallets BEFORE DELETE ON public.wallets
      FOR EACH ROW EXECUTE FUNCTION private.fixture_protection();
    ALTER TABLE public.wallets ENABLE ALWAYS TRIGGER prevent_delete_wallets;
    CREATE TRIGGER queue_notification_automation_from_wallet_transaction AFTER INSERT ON public.wallet_transactions
      FOR EACH ROW EXECUTE FUNCTION private.fixture_effect();
    CREATE TRIGGER trigger_audit_commission_transaction AFTER INSERT ON public.wallet_transactions
      FOR EACH ROW EXECUTE FUNCTION private.fixture_effect();
    ALTER TABLE public.wallet_transactions ENABLE ALWAYS TRIGGER trigger_audit_commission_transaction;
    CREATE TRIGGER trigger_track_wallet_transaction_ledger AFTER INSERT ON public.wallet_transactions
      FOR EACH ROW EXECUTE FUNCTION private.fixture_effect();
    ALTER TABLE public.wallet_transactions ENABLE REPLICA TRIGGER trigger_track_wallet_transaction_ledger;
    CREATE TRIGGER prevent_delete_wallet_transactions BEFORE DELETE ON public.wallet_transactions
      FOR EACH ROW EXECUTE FUNCTION private.fixture_protection();
    CREATE TRIGGER trigger_track_withdrawal_ledger AFTER INSERT ON public.withdrawals
      FOR EACH ROW EXECUTE FUNCTION private.fixture_effect();
    ALTER TABLE public.withdrawals DISABLE TRIGGER trigger_track_withdrawal_ledger;
    CREATE TABLE public.fixture_parent (id integer PRIMARY KEY);
    INSERT INTO public.fixture_parent VALUES (1);
    ALTER TABLE public.wallets ADD CONSTRAINT fixture_parent_fk FOREIGN KEY (id) REFERENCES public.fixture_parent(id);
  `);
  for (const trigger of [
    'aa_reject_archived_employee_chat', 'freeze_service_rich_card_before_insert',
    'trg_check_conversation_group_isolation', 'guard_content_audit_public_media_reference',
    'guard_employee_chat_image_reference',
  ]) {
    await db.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON public.customer_employee_conversations
      FOR EACH ROW EXECUTE FUNCTION private.fixture_protection()`);
  }
  await db.exec(migration);
});

after(async () => { if (db) await db.close(); });

test('original foundation reproduces ALWAYS mode loss, replacement preserves it', async () => {
  const original = foundation.slice(
    foundation.indexOf('CREATE FUNCTION private.employee_transfer_bypass_triggers('),
    foundation.indexOf('REVOKE ALL ON FUNCTION private.employee_transfer_admin('),
  ).replaceAll('CREATE FUNCTION private.', 'CREATE OR REPLACE FUNCTION private.');
  await transaction(async () => {
    await db.exec(original);
    const payload = await bypass();
    assert.ok(payload.every(item => Object.keys(item).length === 2));
    await restore(payload);
    assert.equal(await scalar(`SELECT tgenabled::text FROM pg_trigger
      WHERE tgname = 'trigger_audit_commission_transaction'`), 'O');
  });
  await transaction(async () => {
    const initial = await modes();
    const payload = await bypass(['withdrawals', 'wallet_transactions', 'wallets']);
    assert.equal(payload.length, 3);
    assert.deepEqual(payload.map(item => [item.table, item.trigger, item.mode]), [
      ['wallet_transactions', 'queue_notification_automation_from_wallet_transaction', 'O'],
      ['wallet_transactions', 'trigger_audit_commission_transaction', 'A'],
      ['wallets', 'trigger_enqueue_changed_wallet', 'O'],
    ]);
    for (const item of payload) {
      assert.equal(item.schema, 'public');
      assert.match(item.definition_digest, /^[0-9a-f]{64}$/);
      const digest = await scalar(`SELECT private.employee_transfer_trigger_digest(oid) FROM pg_trigger
        WHERE tgrelid = to_regclass($1) AND tgname = $2`, [`public.${item.table}`, item.trigger]);
      assert.equal(digest, item.definition_digest, 'disabling does not change the trigger/function digest');
    }
    for (const item of await modes()) {
      const changed = payload.some(entry => entry.table === item.table && entry.trigger === item.trigger);
      assert.equal(item.mode, changed ? 'D' : initial.find(entry => entry.table === item.table && entry.trigger === item.trigger).mode);
    }
    await restore([...payload].reverse());
    assert.deepEqual(await modes(), initial);
    assert.equal(await scalar('SELECT private.employee_transfer_pending_trigger_bypass()'), null);
  });
});

test('bypass suppresses only approved side effects; guards and foreign keys still fire', async () => {
  await transaction(async () => {
    await db.exec(`INSERT INTO public.wallets VALUES (1, 'before'); INSERT INTO public.wallet_transactions VALUES (1, 'before')`);
    assert.equal(await scalar('SELECT count(*)::int FROM private.observed_effects'), 3);
    await db.exec('TRUNCATE private.observed_effects');
    const payload = await bypass(['wallets', 'wallet_transactions', 'customer_employee_conversations']);
    await db.exec(`INSERT INTO public.wallet_transactions VALUES (2, 'import')`);
    assert.equal(await scalar('SELECT count(*)::int FROM private.observed_effects'), 0);
    await rejected(() => db.exec('DELETE FROM public.wallets WHERE id = 1'), /Protection fired: prevent_delete_wallets/);
    await rejected(() => db.exec('DELETE FROM public.wallet_transactions WHERE id = 1'), /Protection fired: prevent_delete_wallet_transactions/);
    await rejected(() => db.exec(`INSERT INTO public.wallets VALUES (999, 'bad foreign key')`), /fixture_parent_fk/);
    for (const trigger of [
      'aa_reject_archived_employee_chat', 'freeze_service_rich_card_before_insert',
      'trg_check_conversation_group_isolation', 'guard_content_audit_public_media_reference',
      'guard_employee_chat_image_reference',
    ]) {
      await rejected(() => db.query('INSERT INTO public.customer_employee_conversations VALUES (1, $1)', [trigger]),
        new RegExp(`Protection fired: ${trigger}`));
    }
    await restore(payload);
    await db.exec(`INSERT INTO public.wallet_transactions VALUES (3, 'after')`);
    assert.equal(await scalar('SELECT count(*)::int FROM private.observed_effects'), 2);
  });
});

test('null, empty, malformed, duplicate and unapproved table arrays fail closed', async t => {
  for (const expression of [
    'NULL::text[]', "'{}'::text[]", 'ARRAY[NULL]::text[]', "ARRAY['wallets', NULL]",
    "ARRAY['wallets', 'wallets']", "ARRAY[['wallets', 'withdrawals']]",
    "'[0:0]={wallets}'::text[]", "ARRAY['public.wallets']", "ARRAY['private.wallets']",
    "ARRAY['admins']", "ARRAY['wallets; DROP TABLE public.users']", "ARRAY['']",
    "ARRAY[' wallets']", "ARRAY['WALLETS']", "ARRAY['fixture_parent']",
  ]) {
    await t.test(expression, () => transaction(async () => {
      await rejected(() => db.query(`SELECT private.employee_transfer_bypass_triggers(${expression})`), /Invalid .* table list/);
    }));
  }
  await t.test('missing approved table', () => transaction(async () => {
    await db.exec('DROP TABLE public.withdrawals');
    await rejected(() => bypass(['wallet_transactions', 'withdrawals']), /table is missing/);
  }));
});

test('fixed whitelist cannot be widened by policy rows or the old table inventory helper', async () => {
  await transaction(async () => {
    await db.exec(`
      UPDATE private.employee_transfer_trigger_policy SET action = 'bypass' WHERE trigger_name = 'prevent_delete_wallets';
      INSERT INTO private.employee_transfer_trigger_policy VALUES ('admins', 'evil_trigger', 'bypass', 'not reviewed');
      CREATE OR REPLACE FUNCTION private.employee_transfer_tables() RETURNS text[] LANGUAGE sql AS $$ SELECT ARRAY['admins'] $$;
    `);
    await rejected(() => bypass(['admins']), /Invalid .* table list/);
    const payload = await bypass(['wallets']);
    assert.deepEqual(payload.map(item => item.trigger), ['trigger_enqueue_changed_wallet']);
    assert.equal(await scalar(`SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'prevent_delete_wallets'`), 'A');
    await restore(payload);
  });
});

test('unknown trigger names are rejected even when disabled, replica-only or inserted into mutable policy', async t => {
  for (const mode of ['ENABLE', 'ENABLE ALWAYS', 'ENABLE REPLICA', 'DISABLE']) {
    await t.test(mode, () => transaction(async () => {
      await db.exec(`
        CREATE TRIGGER unreviewed_side_effect AFTER INSERT ON public.work_sessions
          FOR EACH ROW EXECUTE FUNCTION private.fixture_effect();
        ALTER TABLE public.work_sessions ${mode} TRIGGER unreviewed_side_effect;
        INSERT INTO private.employee_transfer_trigger_policy VALUES ('work_sessions', 'unreviewed_side_effect', 'bypass', 'not reviewed');
      `);
      await rejected(() => bypass(), /not reviewed.*unreviewed_side_effect/);
    }));
  }
});

test('malicious restore payloads cannot change modes, scope, definitions, membership or batch completeness', async t => {
  const mutations = [
    ['JSON null', () => null], ['object', () => ({})], ['string', () => '[]'],
    ['null entry', () => [null]], ['array entry', () => [[]]], ['scalar entry', () => [1]],
    ['truncated batch', p => p.slice(0, 1)], ['empty batch', () => []],
    ['duplicate entry', p => [...p, p[0]]],
    ['unknown property', p => [{ ...p[0], extra: true }, ...p.slice(1)]],
    ['missing property', p => { delete p[0].mode; return p; }],
    ...['schema', 'table', 'trigger', 'mode', 'definition_digest', 'bypass_id'].map(key =>
      [`non-string ${key}`, p => [{ ...p[0], [key]: null }, ...p.slice(1)]]),
    ['other schema', p => [{ ...p[0], schema: 'private' }, ...p.slice(1)]],
    ['table injection', p => [{ ...p[0], table: 'wallets; DROP TABLE users' }, ...p.slice(1)]],
    ['trigger injection', p => [{ ...p[0], trigger: 'ALL' }, ...p.slice(1)]],
    ['qualified table', p => [{ ...p[0], table: 'public.wallet_transactions' }, ...p.slice(1)]],
    ['cross-table trigger', p => [{ ...p[0], table: 'wallets' }, ...p.slice(1)]],
    ['protection trigger', p => [{ ...p[0], table: 'wallets', trigger: 'prevent_delete_wallets' }, ...p.slice(1)]],
    ['pre-disabled trigger', p => [{ ...p[0], table: 'withdrawals', trigger: 'trigger_track_withdrawal_ledger' }, ...p.slice(1)]],
    ['replica-only trigger', p => [{ ...p[0], trigger: 'trigger_track_wallet_transaction_ledger' }, ...p.slice(1)]],
    ['invented batch', p => [{ ...p[0], bypass_id: '00000000-0000-0000-0000-000000000000' }, ...p.slice(1)]],
    ['wrong digest', p => [{ ...p[0], definition_digest: '0'.repeat(64) }, ...p.slice(1)]],
    ['invalid digest', p => [{ ...p[0], definition_digest: 'no' }, ...p.slice(1)]],
    ...['D', 'R', 'ALL', '', 'o', 'A'].map(mode =>
      [`forged original mode ${mode}`, p => [{ ...p[0], mode }, ...p.slice(1)]]),
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name, () => transaction(async () => {
      const payload = await bypass();
      await rejected(() => restore(mutate(structuredClone(payload))), /Invalid|Duplicate|does not match/);
      await restore(payload);
    }));
  }
});

test('restore requires a real same-transaction receipt and consumes it exactly once', async () => {
  let payload;
  await transaction(async () => {
    payload = await bypass();
    await rejected(() => bypass(['withdrawals']), /Restore the pending/);
    await restore(payload);
    await rejected(() => restore(payload), /does not match/);
    const next = await bypass();
    await rejected(() => restore(payload), /does not match/);
    await restore(next);
  });
  await transaction(async () => {
    await rejected(() => restore(payload), /does not match/);
    await rejected(() => db.query('SELECT private.employee_transfer_restore_triggers(NULL::jsonb)'), /Invalid .* payload/);
    await restore([]);
  });
});

test('bypass, import and restore work within one server-side statement, as existing RPCs require', async () => {
  await transaction(async () => {
    const initial = await modes();
    await db.exec(`DO $$
      DECLARE disabled jsonb;
      BEGIN
        disabled := private.employee_transfer_bypass_triggers(ARRAY['wallets', 'wallet_transactions']);
        INSERT INTO public.wallet_transactions VALUES (77, 'imported');
        PERFORM private.employee_transfer_restore_triggers(disabled);
      END;
      $$`);
    assert.deepEqual(await modes(), initial);
    assert.equal(await scalar('SELECT count(*)::int FROM private.observed_effects'), 0);
    assert.equal(await scalar('SELECT count(*)::int FROM public.wallet_transactions WHERE id = 77'), 1);
    assert.equal(await scalar('SELECT private.employee_transfer_pending_trigger_bypass()'), null);
  });
});

test('successful commit preserves exact modes, but its receipt cannot be replayed in a later transaction', async () => {
  const initial = await modes();
  let payload;
  await db.exec('BEGIN');
  try {
    payload = await bypass();
    await restore(payload);
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
  assert.deepEqual(await modes(), initial);
  await transaction(async () => {
    await rejected(() => restore(payload), /does not match/);
  });
});

test('all tables are locked before the first change; changes follow canonical order regardless of input order', async () => {
  await transaction(async () => {
    await db.exec(`
      CREATE TABLE private.fixture_ddl_order (id bigint GENERATED ALWAYS AS IDENTITY, table_name text);
      CREATE FUNCTION private.fixture_ddl_order() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT count(*) FROM pg_locks WHERE pid = pg_backend_pid() AND granted AND mode = 'AccessExclusiveLock'
          AND relation IN ('public.wallets'::regclass, 'public.wallet_transactions'::regclass, 'public.withdrawals'::regclass)) <> 3 THEN
          RAISE EXCEPTION 'Tables were not all locked before the first DDL';
        END IF;
        INSERT INTO private.fixture_ddl_order (table_name)
          SELECT object_identity FROM pg_event_trigger_ddl_commands() WHERE command_tag = 'ALTER TABLE';
      END;
      $$;
      CREATE EVENT TRIGGER fixture_ddl_order ON ddl_command_end WHEN TAG IN ('ALTER TABLE')
        EXECUTE FUNCTION private.fixture_ddl_order();
    `);
    const payload = await bypass(['withdrawals', 'wallets', 'wallet_transactions']);
    const expected = ['public.wallet_transactions', 'public.wallet_transactions', 'public.wallets'];
    assert.deepEqual((await rows('SELECT table_name FROM private.fixture_ddl_order ORDER BY id')).map(item => item.table_name), expected);
    await db.exec('TRUNCATE private.fixture_ddl_order');
    await restore([...payload].reverse());
    assert.deepEqual((await rows('SELECT table_name FROM private.fixture_ddl_order ORDER BY id')).map(item => item.table_name), expected);
    const lockHelper = await scalar("SELECT pg_get_functiondef('private.employee_transfer_lock_trigger_tables(text[])'::regprocedure)");
    assert.match(lockHelper, /ORDER BY table_name COLLATE "C"[\s\S]*LOCK TABLE ONLY/);
  });
});

test('keep-policy triggers retain each of O, A, R and D unchanged', async t => {
  for (const [mode, command] of [['O', 'ENABLE'], ['A', 'ENABLE ALWAYS'], ['R', 'ENABLE REPLICA'], ['D', 'DISABLE']]) {
    await t.test(mode, () => transaction(async () => {
      await db.exec(`ALTER TABLE public.wallets ${command} TRIGGER prevent_delete_wallets`);
      const initial = await modes();
      const payload = await bypass(['wallets']);
      assert.equal(await scalar("SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'prevent_delete_wallets'"), mode);
      await restore(payload);
      assert.deepEqual(await modes(), initial);
    }));
  }
});

test('pre-disabled and replica-only triggers produce no restore entries and remain untouched', async () => {
  await transaction(async () => {
    await db.exec(`ALTER TABLE public.wallets ENABLE REPLICA TRIGGER trigger_enqueue_changed_wallet`);
    const initial = await modes();
    assert.deepEqual(await bypass(['wallets', 'withdrawals']), []);
    await restore([]);
    assert.deepEqual(await modes(), initial);
    assert.equal(await scalar('SELECT private.employee_transfer_pending_trigger_bypass()'), null);
  });
});

test('trigger and trigger-function definition changes block restore before any mode is changed', async t => {
  const changes = [
    ['trigger timing', `DROP TRIGGER trigger_enqueue_changed_wallet ON public.wallets;
      CREATE TRIGGER trigger_enqueue_changed_wallet BEFORE INSERT ON public.wallets
        FOR EACH ROW EXECUTE FUNCTION private.fixture_effect();
      ALTER TABLE public.wallets DISABLE TRIGGER trigger_enqueue_changed_wallet`],
    ['trigger function body', `CREATE OR REPLACE FUNCTION private.fixture_effect() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN COALESCE(NEW, OLD); END; $$`],
    ['trigger function settings', `ALTER FUNCTION private.fixture_effect() SET search_path = public`],
    ['missing trigger', `DROP TRIGGER trigger_enqueue_changed_wallet ON public.wallets`],
    ['unexpected enabled mode', `ALTER TABLE public.wallets ENABLE TRIGGER trigger_enqueue_changed_wallet`],
    ['new unreviewed trigger', `CREATE TRIGGER new_protection BEFORE INSERT ON public.wallets
      FOR EACH ROW EXECUTE FUNCTION private.fixture_protection()`],
  ];
  for (const [name, sql] of changes) {
    await t.test(name, () => transaction(async () => {
      const payload = await bypass();
      await db.exec(sql);
      await rejected(() => restore(payload), /definition or disabled state changed|not reviewed/);
      assert.equal(await scalar(`SELECT tgenabled::text FROM pg_trigger
        WHERE tgname = 'queue_notification_automation_from_wallet_transaction'`), 'D', 'preflight prevents partial restore');
    }));
  }
});

test('transaction rollback restores modes and receipts after import/restore errors', async () => {
  const initial = await modes();
  const eventCount = await scalar('SELECT count(*)::int FROM private.employee_transfer_events');
  await assert.rejects(db.exec(`DO $$
    DECLARE disabled jsonb;
    BEGIN
      disabled := private.employee_transfer_bypass_triggers(ARRAY['wallets', 'wallet_transactions']);
      INSERT INTO public.wallet_transactions VALUES (42, 'must roll back');
      RAISE EXCEPTION 'Import failed';
    END;
    $$`), /Import failed/);
  assert.deepEqual(await modes(), initial);
  assert.equal(await scalar('SELECT count(*)::int FROM public.wallet_transactions'), 0);
  assert.equal(await scalar('SELECT count(*)::int FROM private.employee_transfer_events'), eventCount);
  await db.exec(`DO $$
    DECLARE disabled jsonb;
    BEGIN
      BEGIN
        disabled := private.employee_transfer_bypass_triggers(ARRAY['wallets', 'wallet_transactions']);
        PERFORM private.employee_transfer_restore_triggers('[]'::jsonb);
      EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%does not match%' THEN RAISE; END IF;
      END;
    END;
    $$`);
  assert.deepEqual(await modes(), initial, 'an exception block enclosing bypass rolls back disabled modes');
  assert.equal(await scalar('SELECT count(*)::int FROM private.employee_transfer_events'), eventCount);
});

test('mid-bypass and mid-restore DDL exceptions roll back all helper-local changes', async () => {
  await transaction(async () => {
    await db.exec(`
      CREATE FUNCTION private.fixture_ddl_failure() RETURNS event_trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_event_trigger_ddl_commands() WHERE object_identity = 'public.wallets') THEN
          RAISE EXCEPTION 'Injected DDL failure';
        END IF;
      END;
      $$;
      CREATE EVENT TRIGGER fixture_ddl_failure ON ddl_command_end WHEN TAG IN ('ALTER TABLE')
        EXECUTE FUNCTION private.fixture_ddl_failure();
    `);
    await rejected(() => bypass(), /Injected DDL failure/);
    assert.equal(await scalar('SELECT private.employee_transfer_pending_trigger_bypass()'), null);
    await db.exec('DROP EVENT TRIGGER fixture_ddl_failure');
    const payload = await bypass();
    await db.exec(`CREATE EVENT TRIGGER fixture_ddl_failure ON ddl_command_end WHEN TAG IN ('ALTER TABLE')
      EXECUTE FUNCTION private.fixture_ddl_failure()`);
    await rejected(() => restore(payload), /Injected DDL failure/);
    assert.ok((await modes()).filter(item => payload.some(entry => entry.trigger === item.trigger)).every(item => item.mode === 'D'));
    await db.exec('DROP EVENT TRIGGER fixture_ddl_failure');
    await restore(payload);
  });
});

test('helpers reject non-origin replication modes without changing the setting', async t => {
  for (const mode of ['replica', 'local']) {
    await t.test(mode, () => transaction(async () => {
      await db.exec(`SET LOCAL session_replication_role = '${mode}'`);
      await rejected(() => bypass(), /requires origin replication mode/);
      await rejected(() => restore([]), /requires origin replication mode/);
      assert.equal(await scalar("SELECT current_setting('session_replication_role')"), mode);
    }));
  }
});

test('all changed helpers use SECURITY DEFINER, a fixed search path and explicit private-only execute', async () => {
  for (const name of [
    'employee_transfer_trigger_tables()', 'employee_transfer_fixed_trigger_policy()',
    'employee_transfer_lock_trigger_tables(text[])', 'employee_transfer_trigger_digest(oid)',
    'employee_transfer_pending_trigger_bypass()', 'employee_transfer_unreviewed_triggers()',
    'employee_transfer_bypass_triggers(text[])', 'employee_transfer_restore_triggers(jsonb)',
  ]) {
    const [fn] = await rows(`SELECT oid, prosecdef, proconfig,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner)))
        WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS public_execute
      FROM pg_proc WHERE oid = to_regprocedure($1)`, [`private.${name}`]);
    assert.equal(fn.prosecdef, true, name);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'), name);
    assert.equal(fn.public_execute, false, name);
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await scalar('SELECT has_function_privilege($1, $2::oid, $3)', [role, fn.oid, 'EXECUTE']), false, `${role}: ${name}`);
    }
  }
  assert.doesNotMatch(migration, /\bGRANT\b|session_replication_role\s*=|\bcron\./i);
});
