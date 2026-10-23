import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chown, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { after, before, test } from 'node:test';

// Mechanism fixtures, not full-schema/PostgREST/Storage or production capacity acceptance.
const required = process.env.EMPLOYEE_TRANSFER_NATIVE_REQUIRED === '1';
const bin = process.env.EMPLOYEE_TRANSFER_PG_BIN;
const driver = process.env.EMPLOYEE_TRANSFER_PG_DRIVER;
const enabled = Boolean(bin && driver);
const foundation = await readFile(new URL('../migrations/20261102000000_employee_data_transfer_foundation.sql', import.meta.url), 'utf8');
const hardening = await readFile(new URL('../migrations/20261102000004_harden_employee_transfer_triggers.sql', import.meta.url), 'utf8');
const maintenance = await readFile(new URL('../migrations/20261102000011_guard_transfer_maintenance.sql', import.meta.url), 'utf8');
const JOB = 'dc000000-0000-4000-8000-000000000001';
const ADMIN = 'dc000000-0000-4000-8000-000000000002';
const connections = [];
let directory, data, socket, started = false, a, b, observer;
const owner = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
const childEnv = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C',
  LD_LIBRARY_PATH: bin ? resolve(bin, '../lib') : '' };
function command(name, args) {
  const result = spawnSync(join(bin, name), args, { ...owner, env: childEnv, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, `${name}: ${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const scalar = async (db, sql, values = []) => Object.values((await db.query(sql, values)).rows[0])[0];
const snapshot = async () => ({
  modes: (await observer.query(`SELECT c.relname,t.tgname,t.tgenabled::text FROM pg_trigger t
    JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace='public'::regnamespace
    ORDER BY c.relname,t.tgname`)).rows,
  rows: await scalar(observer, 'SELECT count(*)::int FROM public.wallet_transactions'),
  effects: await scalar(observer, 'SELECT count(*)::int FROM private.native_effects'),
  events: await scalar(observer, 'SELECT count(*)::int FROM private.employee_transfer_events'),
  permits: await scalar(observer, 'SELECT count(*)::int FROM private.employee_transfer_write_permits'),
});
const bypass = (db, tables = ['wallet_transactions', 'wallets']) => scalar(db,
  'SELECT private.employee_transfer_bypass_triggers($1::text[])', [tables]);
const restore = (db, payload) => db.query('SELECT private.employee_transfer_restore_triggers($1::jsonb)', [JSON.stringify(payload)]);
const rollback = async () => { for (const db of [a, b]) if (db) await db.query('ROLLBACK'); };
async function unchanged(beforeState) {
  await rollback();
  assert.deepEqual(await snapshot(), beforeState);
}
async function waiting(db, eventType, event) {
  const pid = db.processID;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = (await observer.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0];
    if (state?.wait_event_type === eventType && (!event || state.wait_event === event)) return;
    await delay(10);
  }
  assert.fail(`Native connection ${pid} did not enter ${eventType}/${event ?? '*'}`);
}
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));
function sqlFunction(source, signature) {
  const start = source.indexOf(`CREATE FUNCTION ${signature}`);
  const end = source.indexOf('\n$$;', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end + 4);
}
async function enterMaintenance() {
  await a.query(`INSERT INTO private.employee_transfer_maintenance
    (job_id,admin_id,plan_hash,target_hash,entered_at) VALUES ($1,$2,'native-plan','native-target',now())`, [JOB, ADMIN]);
}

before(async () => {
  if (!enabled) {
    assert.ok(!required, 'Set EMPLOYEE_TRANSFER_PG_BIN and EMPLOYEE_TRANSFER_PG_DRIVER for required native acceptance');
    return;
  }
  assert.ok(isAbsolute(bin) && isAbsolute(driver), 'Native tools must use explicit absolute local paths');
  const { default: { Client } } = await import(pathToFileURL(driver).href);
  assert.match(command('postgres', ['--version']), /PostgreSQL\) 17\./);
  directory = await mkdtemp(join(tmpdir(), 'employee-transfer-pg17-'));
  if (owner.uid !== undefined) await chown(directory, owner.uid, owner.gid);
  socket = join(directory, 'socket'); data = join(directory, 'data');
  await mkdir(socket, { mode: 0o700 });
  if (owner.uid !== undefined) await chown(socket, owner.uid, owner.gid);
  command('initdb', ['-D', data, '-U', 'native_harness', '--no-locale', '--encoding=UTF8', '--auth-local=trust', '--auth-host=reject']);
  command('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', '-t', '15', '-o',
    `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c max_connections=12`, 'start']);
  started = true;
  async function connect(user) {
    const db = new Client({ host: socket, port: 5432, user, database: 'postgres', connectionTimeoutMillis: 5000 });
    connections.push(db); await db.connect(); await db.query("SET statement_timeout='10s'"); return db;
  }
  observer = await connect('native_harness');
  await observer.query(`CREATE ROLE postgres LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS NOREPLICATION;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
    GRANT anon TO postgres; GRANT CREATE ON DATABASE postgres TO postgres; ALTER SCHEMA public OWNER TO postgres;`);
  a = await connect('postgres'); b = await connect('postgres');
  await a.query(`CREATE SCHEMA private; REVOKE ALL ON SCHEMA private FROM PUBLIC,anon,authenticated,service_role;
    CREATE TABLE public.admins(id uuid,username text);
    CREATE TABLE public.financial_login_attempts(account_type text,username text,failed_attempts integer,
      locked_until timestamptz,last_attempt_at timestamptz);`);
  await a.query(foundation);
  for (const table of await scalar(a, 'SELECT private.employee_transfer_tables()')) {
    assert.match(table, /^[a-z_]+$/);
    await a.query(`CREATE TABLE public.${table}(id integer PRIMARY KEY,value text)`);
  }
  await a.query(`CREATE TABLE private.native_effects(table_name text,trigger_name text);
    CREATE FUNCTION private.native_effect() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN INSERT INTO private.native_effects VALUES(TG_TABLE_NAME,TG_NAME); RETURN NEW; END; $$;
    CREATE FUNCTION private.native_protection() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Native delete protection'; END; $$;
    CREATE TRIGGER trigger_enqueue_changed_wallet AFTER INSERT ON public.wallets FOR EACH ROW EXECUTE FUNCTION private.native_effect();
    CREATE TRIGGER prevent_delete_wallets BEFORE DELETE ON public.wallets FOR EACH ROW EXECUTE FUNCTION private.native_protection();
    ALTER TABLE public.wallets ENABLE ALWAYS TRIGGER prevent_delete_wallets;
    CREATE TRIGGER queue_notification_automation_from_wallet_transaction AFTER INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION private.native_effect();
    CREATE TRIGGER trigger_audit_commission_transaction AFTER INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION private.native_effect();
    ALTER TABLE public.wallet_transactions ENABLE ALWAYS TRIGGER trigger_audit_commission_transaction;
    CREATE TRIGGER trigger_track_wallet_transaction_ledger AFTER INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION private.native_effect();
    ALTER TABLE public.wallet_transactions ENABLE REPLICA TRIGGER trigger_track_wallet_transaction_ledger;
    CREATE TRIGGER trigger_track_withdrawal_ledger AFTER INSERT ON public.withdrawals FOR EACH ROW EXECUTE FUNCTION private.native_effect();
    ALTER TABLE public.withdrawals DISABLE TRIGGER trigger_track_withdrawal_ledger;
    CREATE TABLE public.native_parent(id integer PRIMARY KEY); INSERT INTO public.native_parent VALUES(1);
    ALTER TABLE public.wallets ADD CONSTRAINT native_parent_fk FOREIGN KEY(id) REFERENCES public.native_parent(id);`);
  await a.query(hardening);
  const tableStart = maintenance.indexOf('CREATE TABLE private.employee_transfer_maintenance');
  const tableEnd = maintenance.indexOf('CREATE FUNCTION private.employee_transfer_guarded_tables()');
  assert.ok(tableStart >= 0 && tableEnd > tableStart);
  await a.query(maintenance.slice(tableStart, tableEnd));
  await a.query(sqlFunction(maintenance, 'private.employee_transfer_guard_write()'));
  await a.query(`REVOKE ALL ON FUNCTION private.employee_transfer_guard_write() FROM PUBLIC,anon,authenticated,service_role;
    CREATE TABLE public.dispatch_assignments(id integer PRIMARY KEY);
    CREATE TABLE public.native_guard_probe(id integer PRIMARY KEY);
    CREATE TRIGGER zz_employee_transfer_maintenance BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.native_guard_probe
      FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write();
    ALTER TABLE public.native_guard_probe ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance;
    INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash)
      VALUES('${JOB}','import','${ADMIN}','native-fixture','not-an-authentication-token');`);
});

after(async () => {
  try {
    if (started) await rollback();
  } finally {
    await Promise.all(connections.map(db => db.end()));
    if (started) { command('pg_ctl', ['-D', data, '-w', '-t', '15', '-m', 'fast', 'stop']); started = false; }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

const native = (name, fn) => test(name, { skip: !enabled ? 'Explicit local PostgreSQL 17 tools not configured; not native acceptance' : false, timeout: 20_000 }, async t => {
  try { await fn(t); }
  finally {
    if (enabled) {
      await rollback();
      await a.query('RESET statement_timeout; RESET lock_timeout; DELETE FROM private.employee_transfer_maintenance');
    }
  }
});

native('native PG17 uses independent connections and a non-superuser BYPASSRLS owner', async t => {
  assert.notEqual(a.processID, b.processID); assert.notEqual(a.processID, observer.processID);
  const role = (await a.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(role, { current_user: 'postgres', rolsuper: false, rolbypassrls: true });
  assert.equal(await scalar(a, 'SHOW listen_addresses'), '');
  assert.equal(await scalar(a, 'SHOW session_replication_role'), 'origin');
  t.diagnostic(await scalar(a, 'SELECT version()'));
});

native('non-superuser restores O/A modes without changing replica-only or disabled triggers', async () => {
  const beforeState = await snapshot(); await a.query('BEGIN');
  const payload = await bypass(a, ['withdrawals', 'wallet_transactions', 'wallets']);
  assert.deepEqual(payload.map(p => p.mode).sort(), ['A', 'O', 'O']);
  assert.equal(await scalar(a, `SELECT count(*)::int FROM pg_trigger WHERE tgenabled='D' AND tgname IN
    ('trigger_enqueue_changed_wallet','queue_notification_automation_from_wallet_transaction','trigger_audit_commission_transaction')`), 3);
  await restore(a, payload.reverse());
  assert.equal(await scalar(a, 'SELECT private.employee_transfer_pending_trigger_bypass()'), null);
  await unchanged(beforeState);
});

native('reviewed side effects are bypassed but foreign keys and delete protection remain', async () => {
  const beforeState = await snapshot(); await a.query('BEGIN');
  const payload = await bypass(a);
  await a.query(`INSERT INTO public.wallets VALUES(1,'synthetic'); INSERT INTO public.wallet_transactions VALUES(1,'synthetic')`);
  assert.equal(await scalar(a, 'SELECT count(*)::int FROM private.native_effects'), beforeState.effects);
  for (const [sql, code] of [[`INSERT INTO public.wallets VALUES(999,'invalid')`, '23503'], ['DELETE FROM public.wallets WHERE id=1', 'P0001']]) {
    await a.query('SAVEPOINT expected_failure');
    await assert.rejects(a.query(sql), { code });
    await a.query('ROLLBACK TO SAVEPOINT expected_failure');
  }
  await restore(a, payload); await unchanged(beforeState);
});

native('omitted restore rejects real COMMIT and rolls back data, events and trigger DDL', async () => {
  const beforeState = await snapshot(); await a.query('BEGIN'); await bypass(a);
  await a.query(`INSERT INTO public.wallet_transactions VALUES(20,'must rollback')`);
  await assert.rejects(a.query('COMMIT'), /must be restored before committing/);
  await unchanged(beforeState);
});

native('restore receipts from a rolled-back transaction cannot be replayed', async () => {
  const beforeState = await snapshot(); await a.query('BEGIN'); const receipt = await bypass(a); await a.query('ROLLBACK; BEGIN');
  await assert.rejects(restore(a, receipt), /does not match the pending bypass/);
  await unchanged(beforeState);
});

native('a second writer waits until COMMIT then sees restored trigger definitions', async () => {
  const beforeState = await snapshot(); await a.query('BEGIN'); const receipt = await bypass(a, ['wallet_transactions']);
  await a.query(`INSERT INTO public.wallet_transactions VALUES(30,'imported without effects')`);
  const writer = outcome(b.query(`INSERT INTO public.wallet_transactions VALUES(31,'normal writer')`));
  try {
    await waiting(b, 'Lock', 'relation');
    assert.equal(await scalar(observer, `SELECT count(*)::int FROM pg_locks WHERE pid=$1
      AND relation='public.wallet_transactions'::regclass AND mode='AccessExclusiveLock' AND granted`, [a.processID]), 1);
    await restore(a, receipt); await waiting(b, 'Lock', 'relation');
    await a.query('COMMIT');
    assert.equal((await writer).error, undefined);
    assert.equal(await scalar(observer, 'SELECT count(*)::int FROM private.native_effects'), beforeState.effects + 2);
    assert.equal(await scalar(observer, 'SELECT count(*)::int FROM public.wallet_transactions'), beforeState.rows + 2);
    assert.deepEqual((await snapshot()).modes, beforeState.modes);
  } finally { await a.query('ROLLBACK'); await writer; }
});

native('lock timeout unwinds a partially acquired canonical table-lock set', async () => {
  const beforeState = await snapshot(); await a.query('BEGIN; LOCK TABLE public.wallets IN ROW EXCLUSIVE MODE');
  await b.query("BEGIN; SET LOCAL lock_timeout='150ms'");
  await assert.rejects(bypass(b), { code: '55P03' });
  await unchanged(beforeState);
  assert.equal(await scalar(observer, `SELECT count(*)::int FROM pg_locks WHERE pid=$1 AND relation IN
    ('public.wallets'::regclass,'public.wallet_transactions'::regclass)`, [b.processID]), 0);
});

native('NOWAIT fails immediately against an independent relation-lock holder', async () => {
  await a.query('BEGIN; LOCK TABLE public.wallet_transactions IN ROW EXCLUSIVE MODE');
  await b.query('BEGIN');
  await assert.rejects(b.query('LOCK TABLE ONLY public.wallet_transactions IN ACCESS EXCLUSIVE MODE NOWAIT'), { code: '55P03' });
});

native('canceling a waiting bypass releases locks without disabling triggers', async () => {
  const beforeState = await snapshot(); await a.query('BEGIN; LOCK TABLE public.wallet_transactions IN ROW EXCLUSIVE MODE');
  await b.query('BEGIN'); const pending = outcome(bypass(b));
  try {
    await waiting(b, 'Lock', 'relation');
    assert.equal(await scalar(observer, 'SELECT pg_cancel_backend($1)', [b.processID]), true);
    assert.equal((await pending).error?.code, '57014');
    await unchanged(beforeState);
  } finally { await scalar(observer, 'SELECT pg_cancel_backend($1)', [b.processID]); await pending; }
});

native('canceling after trigger DDL rolls back imported rows and append-only receipts', async () => {
  const beforeState = await snapshot(); await a.query('BEGIN'); await bypass(a);
  await a.query(`INSERT INTO public.wallet_transactions VALUES(40,'must rollback')`);
  const pending = outcome(a.query('SELECT pg_sleep(15)'));
  try {
    await waiting(a, 'Timeout', 'PgSleep');
    assert.equal(await scalar(observer, 'SELECT pg_cancel_backend($1)', [a.processID]), true);
    assert.equal((await pending).error?.code, '57014');
    await unchanged(beforeState);
  } finally { await scalar(observer, 'SELECT pg_cancel_backend($1)', [a.processID]); await pending; }
});

native('the real three-second statement timeout rolls back an entire bypassing statement', async () => {
  const beforeState = await snapshot(); await a.query("SET statement_timeout='3s'");
  assert.equal(await scalar(a, 'SHOW statement_timeout'), '3s');
  await assert.rejects(a.query(`DO $$ DECLARE receipt jsonb; BEGIN
    receipt := private.employee_transfer_bypass_triggers(ARRAY['wallet_transactions']);
    INSERT INTO public.wallet_transactions VALUES(50,'must rollback');
    PERFORM pg_sleep(15);
    PERFORM private.employee_transfer_restore_triggers(receipt);
  END; $$`), error => error.code === '57014' && /statement timeout/.test(error.message));
  await unchanged(beforeState);
});

native('an anon caller cannot execute private bypass or alter trigger modes', async () => {
  const beforeState = await snapshot(); await a.query('BEGIN; SET LOCAL ROLE anon');
  await assert.rejects(bypass(a), { code: '42501' });
  await a.query('ROLLBACK; BEGIN; SET LOCAL ROLE anon');
  await assert.rejects(a.query('ALTER TABLE public.wallets DISABLE TRIGGER trigger_enqueue_changed_wallet'), { code: '42501' });
  await unchanged(beforeState);
});

native('the unmodified maintenance guard rejects writes and TRUNCATE even with a table permit', async () => {
  await enterMaintenance(); await b.query('BEGIN');
  await assert.rejects(b.query('INSERT INTO public.native_guard_probe VALUES(60)'), { code: '55000' });
  await b.query('ROLLBACK');
  await a.query('BEGIN');
  await a.query(`INSERT INTO private.employee_transfer_write_permits VALUES(pg_current_xact_id(),$1,ARRAY['public.native_guard_probe'])`, [JOB]);
  await a.query('INSERT INTO public.native_guard_probe VALUES(61)');
  await assert.rejects(a.query('TRUNCATE public.native_guard_probe'), { code: '55000' });
  await rollback();
  assert.equal(await scalar(observer, 'SELECT count(*)::int FROM public.native_guard_probe'), 0);
  assert.equal(await scalar(observer, 'SELECT count(*)::int FROM private.employee_transfer_write_permits'), 0);
});

native('maintenance permits are bound to the exact transaction, not a second connection', async () => {
  await enterMaintenance(); await a.query('BEGIN');
  await a.query(`INSERT INTO private.employee_transfer_write_permits VALUES(pg_current_xact_id(),$1,ARRAY['public.native_guard_probe'])`, [JOB]);
  await a.query('INSERT INTO public.native_guard_probe VALUES(70)');
  await assert.rejects(b.query('INSERT INTO public.native_guard_probe VALUES(71)'), { code: '55000' });
  await rollback();
  assert.equal(await scalar(observer, 'SELECT count(*)::int FROM public.native_guard_probe'), 0);
  assert.equal(await scalar(observer, 'SELECT count(*)::int FROM private.employee_transfer_write_permits'), 0);
});

native('an in-flight guarded writer holds the shared maintenance advisory lock until transaction end', async () => {
  await b.query('BEGIN; INSERT INTO public.native_guard_probe VALUES(80)');
  await a.query('BEGIN');
  const tryLock = () => scalar(a, `SELECT pg_try_advisory_xact_lock(hashtextextended('employee-transfer-maintenance',0))`);
  assert.equal(await tryLock(), false);
  await b.query('ROLLBACK');
  assert.equal(await tryLock(), true);
});

for (const isolation of ['READ COMMITTED', 'REPEATABLE READ']) {
  native(`maintenance committed by another connection cannot be missed at ${isolation}`, async () => {
    await b.query(`BEGIN ISOLATION LEVEL ${isolation}; SELECT count(*) FROM private.employee_transfer_maintenance`);
    await enterMaintenance();
    await assert.rejects(b.query('INSERT INTO public.native_guard_probe VALUES(90)'), { code: '55000' });
    await b.query('ROLLBACK');
    assert.equal(await scalar(observer, 'SELECT count(*)::int FROM public.native_guard_probe'), 0);
  });
}
