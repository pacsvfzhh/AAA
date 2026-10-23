import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { chmod, chown, mkdtemp, mkdir, realpath, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const nativeDatabases = new WeakSet();
const timeout = 30_000;
const safeInt8 = value => {
  const integer = BigInt(value);
  return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(integer) : integer;
};
const mapInt8 = value => Array.isArray(value) ? value.map(mapInt8) : value === null ? null : safeInt8(value);

export const isNativeTransferDatabase = db => nativeDatabases.has(db);

// Self-created socket clusters only; callers cannot supply a connection or data directory.
export function createNativeTransferDatabase(...args) {
  if (args.length) throw new TypeError('Native transfer databases do not accept connection or directory options');
  const configuredBin = process.env.EMPLOYEE_TRANSFER_PG_BIN;
  const configuredDriver = process.env.EMPLOYEE_TRANSFER_PG_DRIVER;
  const owner = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
  const scope = new AsyncLocalStorage();
  const queue = { tail: Promise.resolve() };
  const connections = [];
  let bin, environment, Client, types, directory, data, socket, main, bootstrap;
  let startAttempted = false, harnessCreated = false, historicalFinished = false;
  let closing = false, closePromise, cleanupPromise;

  function command(name, argv, commandTimeout = timeout) {
    return spawnSync(join(bin, name), argv, {
      ...owner, cwd: directory ?? tmpdir(), env: environment, encoding: 'utf8', timeout: commandTimeout,
    });
  }
  function checkedCommand(name, argv) {
    const result = command(name, argv);
    if (result.error || result.status !== 0) {
      throw new Error(`${name} failed (${result.status ?? result.signal}): ${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`);
    }
    return result.stdout;
  }
  function openConnection(user) {
    const client = new Client({
      host: socket, port: 5432, database: 'postgres', user, password: '', ssl: false,
      connectionTimeoutMillis: 5000, application_name: 'employee-transfer-native-local',
      options: '-c statement_timeout=30000', binary: false,
    });
    // Per-client parsers only; do not change global pg types used by other tests.
    client.setTypeParser(20, safeInt8);
    const int8Array = types.getTypeParser(1016, 'text');
    client.setTypeParser(1016, value => mapInt8(int8Array(value)));
    const connection = { client, status: null, failure: null };
    connections.push(connection);
    client.connection.on('readyForQuery', message => {
      if (!['I', 'T', 'E'].includes(message.status)) {
        connection.failure = new Error('Unknown native ReadyForQuery transaction state');
        connection.status = null;
      } else connection.status = message.status;
    });
    client.on('error', error => { connection.failure = error; connection.status = null; });
    client.on('end', () => {
      connection.failure ??= new Error('Native PostgreSQL connection ended');
      connection.status = null;
    });
    return connection;
  }
  async function connect(user) {
    const connection = openConnection(user);
    await connection.client.connect();
    return connection;
  }

  // pg emits errors before ReadyForQuery; wait for both before savepoint recovery.
  async function send(connection, config) {
    if (connection.failure) throw connection.failure;
    const wire = connection.client.connection;
    let ready, failed, ended, timer;
    const boundary = new Promise((resolveReady, rejectReady) => {
      timer = setTimeout(() => {
        connection.failure = new Error('Native connection did not reach ReadyForQuery within 35 seconds');
        connection.status = null;
        rejectReady(connection.failure);
        wire.stream.destroy();
      }, timeout + 5000);
      ready = () => resolveReady();
      failed = error => rejectReady(error);
      ended = () => rejectReady(new Error('Native connection ended before ReadyForQuery'));
      wire.once('readyForQuery', ready);
      connection.client.once('error', failed);
      connection.client.once('end', ended);
    });
    try {
      const reply = Promise.resolve(connection.client.query(config))
        .then(value => ({ value }), error => ({ error }));
      const [result] = await Promise.all([reply, boundary]);
      if (connection.failure) throw connection.failure;
      if (result.error) throw result.error;
      return result.value;
    } finally {
      clearTimeout(timer);
      wire.removeListener('readyForQuery', ready);
      connection.client.removeListener('error', failed);
      connection.client.removeListener('end', ended);
    }
  }
  function assertOpen() {
    if (closing) throw new Error('Native transfer database is closing or closed');
    if (main?.failure) throw main.failure;
  }
  function enqueue(work) {
    try {
      assertOpen();
      const context = scope.getStore();
      if (context && !context.active) throw new Error('Native transaction callback has already ended');
      const target = context ?? queue;
      const pending = target.tail.then(async () => {
        await waitReady;
        assertOpen();
        return work();
      });
      target.tail = pending.catch(() => {});
      return pending;
    } catch (error) { return Promise.reject(error); }
  }
  function checkSql(sql) {
    if (typeof sql !== 'string') throw new TypeError('Native SQL must be a string');
  }
  function results(raw) {
    return (Array.isArray(raw) ? raw : [raw]).filter(item => item.command !== null).map(item => ({
      rows: item.rows,
      fields: item.fields.map(({ name, dataTypeID }) => ({ name, dataTypeID })),
      command: item.command,
      affectedRows: ['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COPY'].includes(item.command) ? item.rowCount ?? 0 : 0,
      rowCount: item.rowCount ?? 0,
    }));
  }

  async function endConnection(connection) {
    let timer;
    try {
      await Promise.race([
        connection.client.end(),
        new Promise(resolveEnded => {
          timer = setTimeout(() => {
            connection.client.connection.stream.destroy();
            resolveEnded();
          }, 5000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        // Cancel only this cluster's own connections, including a busy bootstrap connection.
        if (connections.some(connection => connection.client.processID && !connection.failure)) {
          let control;
          try {
            control = await connect(harnessCreated ? 'native_harness' : 'postgres');
            for (const connection of connections.filter(item => item !== control)) {
              if (connection.client.processID && !connection.failure) {
                await send(control, { text: 'SELECT pg_cancel_backend($1)', values: [connection.client.processID] });
              }
            }
          } catch {
            // Broken startup/connections still MUST reach pg_ctl. A confirmed fast stop cancels all.
          } finally {
            if (control) await endConnection(control);
          }
        }
      } finally {
        try { await Promise.allSettled(connections.map(endConnection)); }
        finally {
          if (directory) {
            if (startAttempted) {
              const status = () => command('pg_ctl', ['-D', data, 'status'], 5000);
              let state = status();
              if (!state.error && state.status === 0) {
                command('pg_ctl', ['-D', data, '-w', '-t', '15', '-m', 'fast', 'stop']);
                // A successful stop command alone is not sufficient evidence to delete PGDATA.
                state = status();
              }
              if (state.error || state.status !== 3) {
                throw new Error(`Cannot confirm local cluster stopped; retained ${directory}: ${state.error?.message ?? state.stderr ?? state.status}`);
              }
            }
            await rm(directory, { recursive: true, force: true });
            directory = undefined;
          }
        }
      }
    })();
    return cleanupPromise;
  }

  async function initialize() {
    if (!configuredBin || !configuredDriver || !isAbsolute(configuredBin) || !isAbsolute(configuredDriver)) {
      throw new TypeError('Set EMPLOYEE_TRANSFER_PG_BIN and EMPLOYEE_TRANSFER_PG_DRIVER to explicit absolute local paths (no URI)');
    }
    bin = await realpath(configuredBin);
    const driver = await realpath(configuredDriver);
    if (!(await stat(bin)).isDirectory() || !(await stat(driver)).isFile()) {
      throw new TypeError('Native PostgreSQL bin must be a directory and pg driver must be a local file');
    }
    environment = { PATH: `${bin}:/usr/bin:/bin`, LANG: 'C', LC_ALL: 'C', LD_LIBRARY_PATH: resolve(bin, '../lib') };
    let version;
    for (const tool of ['postgres', 'initdb', 'pg_ctl']) {
      const output = checkedCommand(tool, ['--version']).trim();
      const match = output.match(/\(PostgreSQL\) (17\.\d+(?:\.\d+)?)(?:\s|$)/);
      if (!match || (version && version !== match[1])) throw new Error(`Matching local PostgreSQL 17 tools required: ${output}`);
      version = match[1];
    }
    const require = createRequire(driver);
    const driverPackage = require('pg/package.json');
    if (driverPackage.name !== 'pg' || !/^8\./.test(driverPackage.version)) {
      throw new Error('A local pg 8 driver with ReadyForQuery events is required');
    }
    const imported = await import(pathToFileURL(driver).href);
    ({ Client, types } = imported.default ?? imported);
    if (typeof Client !== 'function' || typeof types?.getTypeParser !== 'function') {
      throw new TypeError('Local pg driver must export Client and types');
    }
    // pg_ctl passes -o through a shell; refuse unsafe/unrepresentable temporary socket paths.
    const temporary = await realpath(tmpdir());
    if (!/^\/[a-zA-Z0-9_./-]+$/.test(temporary)) throw new Error('Native cluster requires a shell-safe local temporary directory');
    directory = await mkdtemp(join(temporary, 'employee-transfer-pg17-'));
    await chmod(directory, 0o700);
    if (owner.uid !== undefined) await chown(directory, owner.uid, owner.gid);
    data = join(directory, 'data');
    socket = join(directory, 'socket');
    if (Buffer.byteLength(join(socket, '.s.PGSQL.5432')) > 100) throw new Error('Native Unix socket path is too long');
    await mkdir(socket, { mode: 0o700 });
    if (owner.uid !== undefined) await chown(socket, owner.uid, owner.gid);
    checkedCommand('initdb', ['-D', data, '-U', 'native_harness', '--no-locale', '--encoding=UTF8', '--auth-local=trust', '--auth-host=reject']);
    startAttempted = true;
    checkedCommand('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', '-t', '15', '-o',
      `-c listen_addresses='' -c unix_socket_directories='${socket}' -c unix_socket_permissions=0700 -c max_connections=12 -c statement_timeout=30000`, 'start']);
    bootstrap = await connect('native_harness');
    await send(bootstrap, { text: `CREATE ROLE postgres LOGIN SUPERUSER BYPASSRLS;
      ALTER DATABASE postgres OWNER TO postgres; ALTER SCHEMA public OWNER TO postgres;` });
    main = await connect('postgres');
    const { rows: [server] } = await send(main, { text: `SELECT current_setting('server_version_num')::int AS version,
      current_setting('listen_addresses') AS tcp,current_setting('unix_socket_directories') AS socket` });
    if (server.version < 170000 || server.version >= 180000 || server.tcp !== '' || server.socket !== socket) {
      throw new Error('Native server version or Unix-socket isolation mismatch');
    }
    harnessCreated = true;
  }

  const waitReady = initialize().catch(async error => {
    try { await cleanup(); }
    catch (closeError) {
      throw new AggregateError([error, closeError], `${error.message}; native startup cleanup failed`, { cause: error });
    }
    throw error;
  });
  // Construction must not produce an unhandled rejection before a caller awaits readiness.
  void waitReady.catch(() => {});

  const db = Object.freeze({
    waitReady,
    query(sql, params = []) {
      return enqueue(async () => {
        checkSql(sql);
        if (!Array.isArray(params)) throw new TypeError('Native query parameters must be an array');
        // Bound queries use the extended protocol, which rejects multiple commands.
        const raw = await send(main, { text: sql, values: params });
        return { rows: (Array.isArray(raw) ? raw.at(-1) : raw)?.rows ?? [] };
      });
    },
    exec(sql) {
      return enqueue(async () => {
        checkSql(sql);
        // Send the COMPLETE source once. Splitting on ';' corrupts functions/DO blocks and atomicity.
        return results(await send(main, { text: sql }));
      });
    },
    isInTransaction() {
      if (main?.failure) throw main.failure;
      return main?.status === 'T' || main?.status === 'E';
    },
    transaction(callback) {
      if (typeof callback !== 'function') return Promise.reject(new TypeError('Transaction callback required'));
      if (scope.getStore()) return Promise.reject(new Error('Nested native transaction callbacks are not supported'));
      return enqueue(async () => {
        if (main.status !== 'I') throw new Error('Native transaction requires an idle connection');
        const context = { active: true, tail: Promise.resolve() };
        await send(main, { text: 'BEGIN' });
        try {
          const value = await scope.run(context, () => callback(db));
          context.active = false;
          await context.tail;
          if (main.status !== 'T') throw new Error('Native transaction was aborted or ended by its callback');
          await send(main, { text: 'COMMIT' });
          return value;
        } catch (error) {
          context.active = false;
          await context.tail;
          try { if (main.status === 'T' || main.status === 'E') await send(main, { text: 'ROLLBACK' }); }
          catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Native transaction rollback failed', { cause: error }); }
          throw error;
        }
      });
    },
    finishHistoricalSetup() {
      return enqueue(async () => {
        if (main.status !== 'I' || scope.getStore()) throw new Error('Finish historical setup outside any transaction');
        if (!historicalFinished) {
          const { rows: [state] } = await send(main, { text: `SELECT current_user AS username,session_user AS session,
            to_regclass('private.employee_work_stop_markers') IS NOT NULL AS historical_end,
            EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname IN ('public','private') AND c.relname LIKE 'employee_transfer_%')
            OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname IN ('public','private') AND p.proname LIKE 'employee_transfer_%') AS transfer_installed` });
          if (state.username !== 'postgres' || state.session !== 'postgres' || !state.historical_end || state.transfer_installed) {
            throw new Error('Finish all 526 historical migrations as postgres, before applying trigger fixtures or transfer SQL');
          }
          // Only role attributes/membership change. Never rewrite function owner, proacl or definition.
          try {
            await send(bootstrap, { text: `BEGIN;
              ALTER ROLE postgres NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION BYPASSRLS;
              GRANT anon, authenticated, service_role TO postgres;
              COMMIT;` });
          } catch (error) {
            try { if (bootstrap.status === 'T' || bootstrap.status === 'E') await send(bootstrap, { text: 'ROLLBACK' }); }
            catch (rollbackError) { throw new AggregateError([error, rollbackError], 'Native role downgrade rollback failed', { cause: error }); }
            throw error;
          }
          historicalFinished = true;
        }
        const { rows: [role] } = await send(bootstrap, { text: `SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,
          pg_has_role('postgres','anon','SET') AND pg_has_role('postgres','authenticated','SET')
            AND pg_has_role('postgres','service_role','SET') AS can_set_role
          FROM pg_roles WHERE rolname='postgres'` });
        if (!role || role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || !role.rolbypassrls || !role.can_set_role) {
          throw new Error('Native postgres role downgrade did not match the required baseline');
        }
      });
    },
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = (async () => {
          await waitReady.catch(() => {});
          await cleanup();
        })();
      }
      return closePromise;
    },
  });
  nativeDatabases.add(db);
  return db;
}
