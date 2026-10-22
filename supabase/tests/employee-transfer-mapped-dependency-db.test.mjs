import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { build } from 'esbuild';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { createSites, adminLogin, rpc as baseRpc, rows, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Positive prerequisites are actual SQL exports, disk AES/ZIP backups, sealed backups,
// maintenance/configuration/valid RPCs and ALL employees' SQL48 -> SQL49 restores.
// Direct postgres edits below are exclusively source fixture setup or negative corruption.
// This is PGlite evidence, not native PG concurrency/PostgREST/Storage acceptance.
const MIGRATION = '20261102000050_restore_mapped_dispatch_dependencies.sql';
const PREFIX = 'employee_import_mapped_dependency_';
const OPERATIONS = ['plan', 'status', 'begin', 'chunk', 'verify'];
const RPCS = OPERATIONS.map(key => PREFIX + key);
const STATE = 'mapped-dependencies-v1';
const ZERO = '00000000-0000-0000-0000-000000000000';
const DEPENDENCIES = ['dispatch_group_members', 'used_order_data'];
const GATES = ['can_restore', 'complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete'];
const COMMON = ['scope', 'job_id', 'site_id', 'source_site_id', 'package_id', 'plan_hash', 'mapping_hash',
  'totals', 'chunks', 'maintenance', 'dependencies_pending', ...GATES];
const CONFLICTS = ['target_members_not_empty', 'target_used_not_empty', 'unmapped_assigner'];
const TABLES = {
  shared: ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'],
  dispatch: ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'dispatch_group_members', 'valid_order_data', 'used_order_data'],
  identity: ['accounts', 'credentials', 'orders'],
};
const id = n => `50000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const S = { one: id(1), two: id(2), branch: id(3), group: id(4), product: id(5), unknownAdmin: id(6),
  memberOne: id(10), memberTwo: id(11), validMax: id(20), validNull: id(21), validSmall: id(22) };
const EMPLOYEES = [S.one, S.two];
const OWNERS = [S.one, S.two, S.one, S.two];
const USERNAMES = { [S.one]: 'dependency-one', [S.two]: 'dependency-two' };
const PRECISE = '12345678901234567890.1234567890123456789';
const TIME = '2030-03-04T05:06:07.654321Z';
const sha = text => createHash('sha256').update(text).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
function chunks(text, size = 1) {
  const all = lines(text), result = [];
  for (let no = 0; no < all.length; no += size) result.push(all.slice(no, no + size).join(''));
  return result.length ? result : [''];
}
let source, db, session, sourceSession, branch, emergency, other, pkg, task, sharedTask;
let identity, dispatch, shared, expected, modules, bindings, sharedDump, configuredDump, configuredTask;
let counter = 0;
const auth = (job = task, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
async function on(site, name, args, role = 'anon') {
  const point = `mapped_dependency_${++counter}`;
  await site.exec(`SAVEPOINT ${point}`);
  try {
    await site.exec(`SET LOCAL ROLE ${role}`);
    const value = await baseRpc(site, name, args, { role: null });
    await site.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`);
    return value;
  } catch (error) {
    await site.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
    throw error;
  }
}
const rpc = (name, args, role) => on(db, name, args, role);
const call = (key, extra = {}, role = 'anon') => rpc(PREFIX + key, { ...auth(), ...extra }, role);
const plan = (extra = {}, role) => call('plan', extra, role);
const status = (extra = {}, role) => call('status', extra, role);
const begin = (p, extra = {}, role) => call('begin', { p_plan_hash: p.plan_hash, ...extra }, role);
const chunk = (key, no, extra = {}, role) => call('chunk', { p_table_key: key, p_chunk_no: no, ...extra }, role);
const verify = (extra = {}, role) => call('verify', extra, role);
const argsFor = (operation, p) => operation === 'begin' ? { p_plan_hash: p.plan_hash }
  : operation === 'chunk' ? { p_table_key: 'used_order_data', p_chunk_no: 0 } : {};
const summary = () => scalar(db, 'SELECT summary FROM private.employee_transfer_jobs WHERE id=$1', [task.job_id]);
const states = () => rows(db, 'SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key=$2 ORDER BY employee_id,chunk_no', [task.job_id, STATE]);
const permits = () => scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_write_permits');
async function transaction(fn, site = db, commit = false) {
  await site.exec('BEGIN');
  try {
    const result = await fn();
    await site.exec(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) { await site.exec('ROLLBACK'); throw error; }
}
async function clone(dump) {
  const site = new PGlite({ loadDataDir: dump, extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await site.waitReady;
  return site;
}
async function withClone(dump, job, fn) {
  const previous = { db, task, bindings };
  const site = await clone(dump); db = site; task = job;
  try { return await fn(); }
  finally { db = previous.db; task = previous.task; bindings = previous.bindings; await site.close(); }
}
async function capture(kind) {
  const job = await on(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceSession,
    p_admin_password: PASSWORDS.root, ...(kind === 'identity' ? { p_package_id: pkg } : {}) });
  const texts = {};
  for (const key of TABLES[kind]) {
    texts[key] = ''; let after = null;
    do {
      const page = await on(source, `get_employee_export_${kind}_page`, { ...auth(job, sourceSession), p_table_key: key, p_after: after, p_limit: 200 });
      assert.equal(page.sha256, sha(page.ndjson)); texts[key] += page.ndjson; after = page.next_after;
    } while (after !== null);
  }
  assert.equal((await on(source, `employee_export_${kind}_verify`, auth(job, sourceSession))).verified, true);
  await on(source, kind === 'shared' ? 'employee_transfer_cancel' : `employee_export_${kind}_close`, auth(job, sourceSession));
  return { catalog: job.catalog, texts };
}
async function* readDisk(path) {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(65521);
    for (;;) { const part = await handle.read(bytes); if (!part.bytesRead) return; yield bytes.subarray(0, part.bytesRead); }
  } finally { await handle.close(); }
}
async function prepare(kind, input) {
  const job = await rpc(kind === 'shared' ? 'employee_import_shared_replace_begin' : 'employee_import_dispatch_begin', {
    p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_package_id: pkg, p_catalog: input.catalog,
  });
  for (const key of TABLES[kind]) for (const [no, text] of chunks(input.texts[key]).entries()) {
    await rpc(`employee_import_${kind}_stage`, { ...auth(job), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  }
  const p = await rpc(kind === 'shared' ? 'get_employee_import_shared_replace_dry_run' : 'get_employee_import_dispatch_dry_run', auth(job));
  const descriptor = await rpc(`get_employee_import_${kind}_backup`, auth(job));
  const dir = await mkdtemp(join(tmpdir(), 'employee-mapped-dependency-')), path = join(dir, 'independent.edx'), plain = new Map();
  try {
    const result = await (kind === 'shared' ? modules.createReplacementBackup : modules.createDispatchBackup)(descriptor, {
      async catalog() { return (await rpc(`get_employee_import_${kind}_backup`, auth(job))).catalog; },
      page(key, after) { return rpc(`get_employee_import_${kind}_backup_page`, { ...auth(job), p_table_key: key, p_after: after, p_limit: 200 }); },
      async verify() {
        // The backup API has no standalone verify RPC: freshly compare its complete descriptor.
        assert.deepEqual(await rpc(`get_employee_import_${kind}_backup`, auth(job)), descriptor);
        return { verified: true, scope: kind === 'shared' ? 'shared-settings' : 'dispatch-submission', full_site_complete: false };
      },
    }, {
      async append(name, bytes) { plain.set(name, [...plain.get(name) ?? [], Buffer.from(bytes)]); },
      open(name) { return (async function* () { yield* plain.get(name) ?? []; })(); }, async abort() { plain.clear(); },
    }, {
      async write(stream) {
        const handle = await open(path, 'wx');
        try { for await (const bytes of stream) await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      },
      open() { return readDisk(path); },
    }, {
      append(no, hex) { return rpc(`employee_import_${kind}_backup_append`, { ...auth(job), p_plan_hash: p.plan_hash, p_chunk_no: no, p_hex: hex }); },
      seal(hash, bytes) { return rpc(`employee_import_${kind}_backup_seal`, { ...auth(job), p_plan_hash: p.plan_hash, p_sha256: hash, p_bytes: bytes }); },
    }, 'local-mapped-dependency-real-independent-backup');
    assert.equal(result.sealReceipt.success, true); assert.equal(plain.size, 0);
    assert.equal(await scalar(db, 'SELECT sealed_at IS NOT NULL FROM private.employee_transfer_shared_backups WHERE id=$1', [job.job_id]), true);
    return { job, plan: p };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function configure(input) {
  const prepared = await prepare('dispatch', input); task = prepared.job;
  await rpc('employee_import_dispatch_enter_maintenance', { ...auth(), p_plan_hash: prepared.plan.plan_hash,
    p_confirmation: '確認暫停業務並導入派單資料', p_admin_password: PASSWORDS.root });
  const p = await rpc('get_employee_import_dispatch_configuration_plan', auth());
  assert.equal((await rpc('employee_import_dispatch_apply_configuration', { ...auth(), p_plan_hash: p.plan_hash })).configuration_applied, true);
  return p;
}
async function restoreValid() {
  const config = (await summary()).dispatch_config_plan;
  const started = await rpc('employee_import_dispatch_valid_begin', { ...auth(), p_plan_hash: config.plan_hash });
  for (let no = 0; no < started.chunks; no++) await rpc('employee_import_dispatch_valid_chunk', { ...auth(), p_chunk_no: no });
  assert.equal((await rpc('employee_import_dispatch_valid_verify', auth())).verified, true);
}
async function stageIdentity() {
  await rpc('employee_import_identity_bind', { ...auth(), p_catalog: identity.catalog });
  for (const key of TABLES.identity) for (const [no, text] of chunks(identity.texts[key], 2).entries()) {
    await rpc('employee_import_identity_stage', { ...auth(), p_table_key: key, p_chunk_no: no, p_ndjson: text });
  }
}
async function reserveAll() {
  const result = {};
  for (const sourceId of EMPLOYEES) {
    const observed = await rpc('employee_import_identity_reservation_status', { ...auth(), p_source_id: sourceId });
    assert.equal(observed.reservation, null);
    const reply = await rpc('employee_import_identity_reserve', { ...auth(), p_source_id: sourceId,
      p_source_fingerprint: observed.observed.source_fingerprint, p_target_fingerprint: observed.observed.target_fingerprint });
    assert.equal(reply.source_unchanged, true); assert.equal(reply.target_unchanged, true); assert.equal(reply.candidate_available, true);
    result[sourceId] = reply.reservation;
    assert.notEqual(result[sourceId].target_id, sourceId);
  }
  assert.notEqual(result[S.one].target_id, result[S.two].target_id);
  bindings = result;
  return result;
}
async function restoreIdentities({ incomplete = null, omit = null } = {}) {
  await stageIdentity(); await reserveAll();
  for (const sourceId of EMPLOYEES) {
    if (sourceId === omit) continue;
    const p = await rpc('employee_import_mapped_identity_plan', { ...auth(), p_source_id: sourceId });
    assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
    await rpc('employee_import_mapped_identity_core', { ...auth(), p_source_id: sourceId, p_plan_hash: p.plan_hash });
    for (let no = 0; no < p.order_chunks; no++) await rpc('employee_import_mapped_identity_orders', { ...auth(), p_source_id: sourceId, p_chunk_no: no });
    if (sourceId !== incomplete) assert.equal((await rpc('employee_import_mapped_identity_verify', { ...auth(), p_source_id: sourceId })).verified, true);
  }
}
// Only local negative tampering bypasses triggers. Every original mode is restored exactly.
async function change(relation, sql, params = [], site = db) {
  const modes = await rows(site, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
  for (const t of modes) await site.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
  try { await site.query(sql, params); }
  finally {
    for (const t of modes) await site.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`);
  }
}
async function snapshot(site = db) {
  const names = (await rows(site, `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') ORDER BY 1`)).map(r => r.name);
  return rows(site, names.map(name => `SELECT '${name}' AS name,count(*)::int AS n,md5(COALESCE(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} AS r`).join(' UNION ALL '));
}
const business = () => snapshot().then(all => all.filter(r => r.name.startsWith('public.') || !r.name.startsWith('private.employee_transfer_')));
const triggers = () => rows(db, `SELECT n.nspname,c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname IN ('public','private') ORDER BY 1,2,3`);
const validSnapshot = () => rows(db, 'SELECT id,to_jsonb(v)::text AS body FROM public.valid_order_data v ORDER BY id');
function common(value, p = null) {
  const isPlan = Object.hasOwn(value, 'can_begin');
  assert.deepEqual(Object.keys(value).sort(), [...COMMON, ...isPlan ? ['can_begin', 'conflicts'] : ['started', 'counts', 'next_chunks', 'verified']].sort());
  assert.equal(value.scope, 'employee-mapped-dependencies');
  assert.equal(value.job_id, task.job_id); assert.equal(value.package_id, pkg);
  assert.equal(value.source_site_id, dispatch.catalog.site_id);
  assert.equal(value.maintenance, true); assert.equal(value.dependencies_pending, true);
  for (const key of GATES) assert.equal(value[key], false, key);
  for (const key of ['plan_hash', 'mapping_hash']) assert.match(value[key], /^[0-9a-f]{64}$/);
  for (const key of ['totals', 'chunks', ...isPlan ? [] : ['counts', 'next_chunks']]) {
    assert.deepEqual(Object.keys(value[key]).sort(), [...DEPENDENCIES].sort());
    for (const n of Object.values(value[key])) assert.ok(Number.isSafeInteger(n) && n >= 0);
  }
  if (p) for (const key of COMMON) assert.deepEqual(value[key], p[key], key);
  if (isPlan) {
    assert.ok(Array.isArray(value.conflicts));
    for (const reason of value.conflicts) assert.ok(CONFLICTS.includes(reason), `unreviewed conflict ${reason}`);
    assert.equal(value.can_begin, value.conflicts.length === 0);
  } else { assert.equal(typeof value.started, 'boolean'); assert.equal(typeof value.verified, 'boolean'); }
  assert.doesNotMatch(JSON.stringify(value), /password|session_token|job_token|transaction_id|assigned_by|identity_map|repeated/);
}
async function noLegacy() {
  const state = await summary();
  for (const key of ['identity_restore', 'dependency_restore', 'verified_identity_map', 'dependency_plan']) assert.equal(state[key], undefined, key);
  const point = `legacy_${++counter}`; await db.exec(`SAVEPOINT ${point}`);
  try {
    await assert.rejects(db.query(`SELECT * FROM private.employee_transfer_verified_identity_map(
      (SELECT j FROM private.employee_transfer_jobs j WHERE id=$1),'accounts')`, [task.job_id]), /server-verified/i);
  } finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
  assert.equal(await permits(), 0);
}
async function denyAll(p, extra = {}, pattern) {
  const frozen = await snapshot(), modes = await triggers();
  for (const role of ['anon', 'authenticated']) for (const operation of OPERATIONS) {
    await assert.rejects(call(operation, { ...argsFor(operation, p), ...extra }, role), pattern);
  }
  assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.equal(await permits(), 0);
}
async function finishMembers(p, role = 'anon') {
  for (let no = 0; no < p.chunks.dispatch_group_members; no++) await chunk('dispatch_group_members', no, {}, role);
}
async function finish(p, role = 'anon') {
  await begin(p, {}, role); await finishMembers(p, role);
  for (let no = 0; no < p.chunks.used_order_data; no++) await chunk('used_order_data', no, {}, role);
  const result = await verify({}, role); assert.equal(result.verified, true); common(result, p);
  return result;
}
async function expectedDependencies() {
  const result = {};
  for (const key of DEPENDENCIES) result[key] = await rows(source, `SELECT id,user_id,to_jsonb(r)::text AS body FROM public.${key} r ORDER BY id`);
  return result;
}
async function assertDependencies(inputExpected = expected) {
  const config = (await summary()).dispatch_config_plan;
  for (const key of DEPENDENCIES) {
    assert.equal(await scalar(db, `SELECT count(*)::int FROM public.${key}`), inputExpected[key].length);
    for (const original of inputExpected[key]) {
      assert.equal(await scalar(db, `SELECT to_jsonb(actual)=($2::jsonb||jsonb_build_object('user_id',$3::uuid)||
        CASE WHEN $4::boolean THEN jsonb_build_object('group_id',$5::jsonb->($2::jsonb->>'group_id'),
          'assigned_by',$6::jsonb->($2::jsonb->>'assigned_by')) ELSE '{}'::jsonb END)
        FROM public.${key} actual WHERE id=$1`, [original.id, original.body, bindings[original.user_id].target_id,
        key === 'dispatch_group_members', JSON.stringify(config.group_map), JSON.stringify(config.admin_map)]), true, `${key}:${original.id}`);
    }
    assert.equal(await scalar(db, `SELECT count(*)::int FROM public.${key} WHERE user_id=ANY($1::uuid[])`, [EMPLOYEES]), 0);
  }
  assert.equal(await scalar(db, `SELECT count(*)::int FROM public.used_order_data u JOIN public.orders o ON o.id=u.order_id
    JOIN public.valid_order_data v ON v.id=u.valid_order_data_id JOIN public.users e ON e.id=u.user_id
    WHERE o.user_id=u.user_id AND o.status IN ('success','failure') AND NOT e.is_active AND e.archived_at IS NULL`), inputExpected.used_order_data.length);
}
async function variant(mutate, run) {
  const input = await transaction(async () => { await mutate(); return { dispatch: await capture('dispatch'), expected: await expectedDependencies() }; }, source);
  return withClone(sharedDump, null, () => transaction(async () => {
    await configure(input.dispatch); await restoreValid(); await restoreIdentities();
    return run(input);
  }));
}

before(async () => {
  // A missing/inapplicable SQL50 is a hard hook failure, NEVER skipped or substituted.
  await access(new URL(`../migrations/${MIGRATION}`, import.meta.url));
  for (const [module, names] of [[globalThis, ['fetch']], [http, ['request', 'get']], [https, ['request', 'get']],
    [net, ['connect', 'createConnection']], [tls, ['connect']]]) {
    for (const name of names) mock.method(module, name, () => assert.fail('network and production services forbidden'));
  }
  const replay = await createSites({ upTo: MIGRATION }); source = replay.oldSite; db = replay.newSite;
  assert.equal(replay.failures.length, 12); assert.equal(replay.files.at(-1), MIGRATION);
  assert.equal(replay.validation.freshDatabaseVerified, false);
  await buildNewSite(source); await buildNewSite(db);
  await source.query('UPDATE private.employee_transfer_site SET site_id=$1', [randomUUID()]);
  // Same username, different UUID: never the invalid same-UUID/different-name admin fixture.
  await source.query('DELETE FROM public.financial_admin_credentials WHERE admin_id=$1', [NEW.branch]);
  await source.query('UPDATE public.admins SET id=$1 WHERE id=$2', [S.branch, NEW.branch]);
  await source.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [S.branch]);
  await source.query("INSERT INTO public.dispatch_groups(id,group_name,created_by) VALUES($1,'Mapped dependency source group',$2)", [S.group, S.branch]);
  await source.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,is_active,created_by,created_at,updated_at)
    SELECT $1,$2,id,'<p>source pool content é 𠮷</p>',true,$3,'2021-01-02T03:04:05.123456Z',NULL
    FROM public.dispatch_order_pools WHERE group_id=$2 AND is_base`, [id(7), S.group, S.branch]);
  for (const sourceId of EMPLOYEES) {
    await source.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by,is_active,remarks,created_at)
      VALUES($1,$2,$3,extensions.crypt($4,extensions.gen_salt('bf',4)),$5,true,$6,'2026-09-01T01:02:03.123456Z')`,
    [sourceId, USERNAMES[sourceId], sourceId === S.one ? 'DEP-001' : 'DEP-002', PASSWORDS.employee,
      sourceId === S.one ? NEW.root : S.branch, sourceId === S.one ? 'source private remark é 𠮷' : null]);
    await source.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [sourceId]);
  }
  await source.query("INSERT INTO public.product_types(id,name,is_active) VALUES($1,'Dependency historical product',false)", [S.product]);
  for (const [n, owner] of OWNERS.entries()) await change('public.orders', `INSERT INTO public.orders(id,user_id,username,product_type_id,
    product_value,order_number,transaction_id,status,commission_amount,commission_rate,created_at,processed_at)
    VALUES($1,$2,$3,$4,99.9,$5,$6,$7,$8::numeric,$9::numeric,'2026-09-04T01:02:03.123456Z',$10::timestamptz)`,
  [id(100 + n), owner, USERNAMES[owner], S.product, `PRIVATE-DEP-ORDER-${n}`, `PRIVATE-DEP-TX-${n}`,
    n % 2 ? 'failure' : 'success', n % 2 ? null : PRECISE, n % 2 ? null : '0.1234567890123456789',
    n % 2 ? null : '2026-09-05T02:03:04.654321Z'], source);
  await source.query(`INSERT INTO public.dispatch_group_members(id,group_id,user_id,assigned_by,assigned_at) VALUES
    ($1,$2,$3,$4,'2021-01-02T03:04:05.123456Z'),($5,$6,$7,$8,NULL)`,
  [S.memberOne, NEW.groupA, S.one, NEW.root, S.memberTwo, S.group, S.two, S.branch]);
  for (const [n, valid] of [S.validMax, S.validNull, S.validSmall].entries()) {
    await source.query(`INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by,usage_count,last_used_at,tags,priority)
      VALUES($1,$2::numeric,$3,$4,0,NULL,$5::text[],$6)`,
    [valid, PRECISE, `source-valid-é-𠮷-${n}`, n % 2 ? S.branch : NEW.root, n ? null : ['é', null, '', 'é'], n]);
  }
  for (const [n, owner] of OWNERS.entries()) await source.query(`INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at)
    VALUES($1,$2,$3,$4,$5::timestamptz)`, [id(200 + n), owner, [S.validMax, S.validNull, S.validSmall, S.validMax][n], id(100 + n),
    n === 1 ? null : '2021-03-04T05:06:07.123456Z']);
  // Set historical counters AFTER ordinary source inserts; target must never increment them.
  await source.query(`UPDATE public.valid_order_data SET usage_count=CASE id WHEN $1 THEN 2147483647 WHEN $2 THEN NULL ELSE 17 END,
    last_used_at=CASE id WHEN $2 THEN NULL ELSE $3::timestamptz END`, [S.validMax, S.validNull, TIME]);
  await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
    SELECT $1,'dependency-other-root',password_hash,'super_admin',true FROM public.admins WHERE id=$2`, [id(300), NEW.root]);
  await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [id(300)]);
  session = await adminLogin(db, 'root', PASSWORDS.root); sourceSession = await adminLogin(source, 'root', PASSWORDS.root);
  branch = await adminLogin(db, 'branch', PASSWORDS.branch); emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency);
  other = await adminLogin(db, 'dependency-other-root', PASSWORDS.root); pkg = randomUUID();
  // Only compile local helpers, with auth/supabase replaced at the module boundary. No SDK network.
  const compiled = await build({ stdin: { contents: `export {createReplacementBackup} from './src/lib/employeeTransfer/replacementBackup.ts';
    export {createDispatchBackup} from './src/lib/employeeTransfer/dispatchBackup.ts';`, resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020' });
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  await transaction(async () => { shared = await capture('shared'); dispatch = await capture('dispatch'); identity = await capture('identity'); expected = await expectedDependencies(); }, source, true);
  assert.deepEqual(identity.catalog.tables.map(t => t.rows), [2, 2, 4]);
  assert.deepEqual(dispatch.catalog.tables.slice(4).map(t => t.rows), [2, 3, 4]);
  await transaction(async () => {
    const prepared = await prepare('shared', shared); sharedTask = prepared.job;
    const receipt = await rpc('employee_import_shared_replace_apply', { ...auth(sharedTask), p_plan_hash: prepared.plan.plan_hash });
    assert.equal(receipt.success, true); assert.equal(receipt.admin_map[S.branch], NEW.branch);
    await rpc('employee_transfer_cancel', auth(sharedTask));
  }, db, true);
  sharedDump = await db.dumpDataDir('none');
  await transaction(() => configure(dispatch), db, true); configuredTask = task;
  configuredDump = await db.dumpDataDir('none');
  await transaction(async () => { await restoreValid(); await restoreIdentities(); await noLegacy(); }, db, true);
}, { timeout: 600000 });
after(async () => { await Promise.allSettled([source?.close(), db?.close()]); mock.restoreAll(); });

test('SQL50 exact public UUID-only signatures, STABLE plan/status, definer path and explicit grants', () => transaction(async () => {
  const fns = await rows(db, `SELECT proname,provolatile,prosecdef,proconfig,proargnames,pronargdefaults,
    (SELECT array_agg(format_type(t,NULL) ORDER BY n) FROM unnest(proargtypes::oid[]) WITH ORDINALITY a(t,n)) AS types,
    oid::regprocedure::text AS signature,EXISTS(SELECT 1 FROM aclexplode(proacl) WHERE grantee=0 AND privilege_type='EXECUTE') AS public_execute
    FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[]) ORDER BY proname`, [RPCS]);
  assert.deepEqual(fns.map(f => f.proname).sort(), [...RPCS].sort());
  for (const fn of fns) {
    const operation = fn.proname.slice(PREFIX.length);
    assert.equal(fn.provolatile, ['plan', 'status'].includes(operation) ? 's' : 'v'); assert.equal(fn.prosecdef, true);
    assert.ok(fn.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    assert.equal(fn.public_execute, false); assert.equal(fn.pronargdefaults, 0);
    assert.deepEqual(fn.proargnames, ['p_admin_session_token', 'p_job_token', ...operation === 'begin' ? ['p_plan_hash'] : operation === 'chunk' ? ['p_table_key', 'p_chunk_no'] : []]);
    assert.deepEqual(fn.types, ['uuid', 'uuid', ...operation === 'begin' ? ['text'] : operation === 'chunk' ? ['text', 'integer'] : []]);
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, fn.signature]), role !== 'service_role');
    await assert.rejects(call(operation, argsFor(operation, { plan_hash: '0'.repeat(64) }), 'service_role'), /permission denied/);
  }
  const helpers = await rows(db, "SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_mapped_dependency_%'");
  assert.equal(helpers.length, 9);
  for (const helper of helpers) for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(db, "SELECT has_function_privilege($1,$2,'EXECUTE')", [role, helper.signature]), false);
}));

for (const role of ['anon', 'authenticated']) {
  for (const started of [false, true]) test(`SQL50 ${role}: plan/status are genuinely read-only with started=${started}`, () => transaction(async () => {
    const p = await plan({}, role); if (started) { await begin(p, {}, role); await chunk('dispatch_group_members', 0, {}, role); }
    const before = await snapshot(), modes = await triggers();
    await db.exec('SET TRANSACTION READ ONLY');
    common(await plan({}, role), p); const s = await status({}, role); common(s, p);
    assert.equal(s.started, started); assert.equal(s.verified, false);
    assert.deepEqual(s.counts, { dispatch_group_members: started ? 1 : 0, used_order_data: 0 });
    assert.deepEqual(s.next_chunks, { dispatch_group_members: started ? 1 : 0, used_order_data: 0 });
    assert.deepEqual(await plan({}, role), p); assert.deepEqual(await status({}, role), s);
    assert.deepEqual(await snapshot(), before); assert.deepEqual(await triggers(), modes);
    assert.equal((await states()).length, started ? 1 : 0);
  }));

  test(`SQL50 ${role}: golden full-package mapped members/used, exact fields, FK ownership, NULL/microseconds and counters unchanged`, () => transaction(async () => {
    const initial = await business(), sourceBefore = await snapshot(source), modes = await triggers(), valid = await validSnapshot();
    const beforeSummary = await summary(), staging = await rows(db, 'SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 ORDER BY employee_id,table_key,chunk_no', [task.job_id]);
    const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
    const lastEvent = await scalar(db, 'SELECT COALESCE(max(id),0)::text FROM private.employee_transfer_events');
    const p = await plan({}, role); common(p); assert.equal(p.can_begin, true); assert.deepEqual(p.conflicts, []);
    assert.equal(p.site_id, await scalar(db, 'SELECT site_id FROM private.employee_transfer_site'));
    assert.notEqual(p.site_id, p.source_site_id);
    assert.deepEqual(p.totals, { dispatch_group_members: 2, used_order_data: 4 }); assert.deepEqual(p.chunks, p.totals);
    const started = await begin(p, {}, role); common(started, p); assert.equal(started.started, true);
    assert.deepEqual(started.counts, { dispatch_group_members: 0, used_order_data: 0 }); assert.deepEqual(started.next_chunks, started.counts);
    assert.deepEqual(await business(), initial); assert.deepEqual(await status({}, role), started);
    await assert.rejects(verify({}, role), /incomplete/i);
    for (const key of DEPENDENCIES) for (let no = 0; no < p.chunks[key]; no++) {
      const receipt = await chunk(key, no, {}, role); common(receipt, p); assert.equal(receipt.started, true); assert.equal(receipt.verified, false);
      assert.equal(receipt.counts[key], no + 1); assert.equal(receipt.next_chunks[key], no + 1);
      assert.deepEqual(await status({}, role), receipt); assert.deepEqual(await plan({}, role), p);
      const frozen = await snapshot(); assert.deepEqual(await chunk(key, no, {}, role), receipt); assert.deepEqual(await snapshot(), frozen);
      assert.deepEqual(await validSnapshot(), valid); assert.deepEqual(await triggers(), modes); assert.equal(await permits(), 0);
    }
    const result = await verify({}, role); common(result, p); assert.equal(result.verified, true);
    assert.deepEqual(result.counts, p.totals); assert.deepEqual(result.next_chunks, p.chunks);
    const frozen = await snapshot();
    assert.deepEqual(await begin(p, {}, role), result); assert.deepEqual(await verify({}, role), result);
    assert.deepEqual(await chunk('used_order_data', 0, {}, role), result); assert.deepEqual(await status({}, role), result);
    assert.deepEqual(await snapshot(), frozen); await assertDependencies(); await noLegacy();
    const saved = await states(); assert.equal(saved.length, 1); assert.equal(saved[0].employee_id, ZERO);
    assert.equal(saved[0].chunk_no, 0); assert.equal(saved[0].row_count, 1); assert.deepEqual(saved[0].payload.plan, p);
    assert.deepEqual(saved[0].payload.identity_map, Object.fromEntries(EMPLOYEES.map(k => [k, bindings[k].target_id])));
    assert.deepEqual(await rows(db, 'SELECT * FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key<>$2 ORDER BY employee_id,table_key,chunk_no', [task.job_id, STATE]), staging);
    assert.deepEqual(await summary(), beforeSummary); assert.deepEqual(await validSnapshot(), valid);
    const changed = (await business()).filter((r, i) => JSON.stringify(r) !== JSON.stringify(initial[i])).map(r => r.name);
    assert.deepEqual(changed.sort(), DEPENDENCIES.map(k => 'public.' + k).sort());
    assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance);
    assert.deepEqual(await snapshot(source), sourceBefore); assert.deepEqual(await triggers(), modes);
    const logs = await rows(db, 'SELECT action,details FROM private.employee_transfer_events WHERE id>$1 ORDER BY id', [lastEvent]);
    assert.equal(logs.length, 16);
    assert.deepEqual(logs.filter(r => r.action.startsWith('mapped_dependencies_')).map(r => r.action),
      ['mapped_dependencies_started', ...Array(6).fill('mapped_dependencies_chunk'), 'mapped_dependencies_verified']);
    assert.equal(logs.filter(r => r.action === 'trigger_bypass').length, 4);
    assert.equal(logs.filter(r => r.action === 'trigger_restore').length, 4);
    const text = JSON.stringify(logs); assert.doesNotMatch(text, /password|session_token|job_token|PRIVATE-DEP|private remark|\$2[aby]\$/);
    for (const secret of [session, sourceSession, task.job_token, ...Object.values(PASSWORDS)]) assert.equal(text.includes(secret), false);
    assert.equal(await scalar(db, 'SELECT usage_count FROM public.valid_order_data WHERE id=$1', [S.validMax]), 2147483647);
    assert.equal(await scalar(db, 'SELECT usage_count FROM public.valid_order_data WHERE id=$1', [S.validNull]), null);
    assert.equal(await scalar(db, 'SELECT last_used_at IS NULL FROM public.valid_order_data WHERE id=$1', [S.validNull]), true);
    assert.equal(await scalar(db, 'SELECT last_used_at=$2::timestamptz FROM public.valid_order_data WHERE id=$1', [S.validMax, TIME]), true);
    assert.equal(await scalar(db, 'SELECT product_value::text FROM public.valid_order_data WHERE id=$1', [S.validMax]), PRECISE);
    for (const [sourceId, owner] of [[S.one, NEW.root], [S.two, NEW.branch]]) assert.equal(await scalar(db,
      'SELECT created_by=$2 AND NOT is_active FROM public.users WHERE id=$1', [bindings[sourceId].target_id, owner]), true);
  }));

  test(`SQL50 ${role}: direct private access and extra caller maps/rows/backup-proof parameters are forbidden`, () => transaction(async () => {
    const p = await plan(); await begin(p); const frozen = await snapshot();
    for (const sql of [`SELECT * FROM private.employee_transfer_staging WHERE table_key='${STATE}'`,
      `UPDATE private.employee_transfer_staging SET payload='{}' WHERE table_key='${STATE}'`,
      `DELETE FROM private.employee_transfer_staging WHERE table_key='${STATE}'`,
      'UPDATE public.dispatch_group_members SET assigned_at=now() WHERE false', 'DELETE FROM public.used_order_data WHERE false']) {
      const point = `direct_${++counter}`; await db.exec(`SAVEPOINT ${point}`);
      try { await db.exec(`SET LOCAL ROLE ${role}`); await assert.rejects(db.exec(sql), /permission denied|maintenance/i); }
      finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
    }
    for (const operation of OPERATIONS) for (const [argument, expression] of [
      ['p_source_id', `'${S.one}'::uuid`], ['p_target_id', `'${bindings[S.one].target_id}'::uuid`],
      ['p_employee_map', "'{}'::jsonb"], ['p_rows', "'[]'::jsonb"], ['p_backup_verified', 'true'],
    ]) {
      const point = `extra_${++counter}`; await db.exec(`SAVEPOINT ${point}`);
      try {
        await db.exec(`SET LOCAL ROLE ${role}`);
        const suffix = operation === 'begin' ? ',p_plan_hash=>$3::text' : operation === 'chunk' ? ',p_table_key=>$3::text,p_chunk_no=>$4::integer' : '';
        await assert.rejects(db.query(`SELECT public.${PREFIX + operation}(p_admin_session_token=>$1::uuid,p_job_token=>$2::uuid${suffix},${argument}=>${expression})`,
          [session, task.job_token, ...operation === 'begin' ? [p.plan_hash] : operation === 'chunk' ? ['dispatch_group_members', 0] : []]), { code: '42883' });
      } finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
    }
    assert.deepEqual(await snapshot(), frozen); await noLegacy();
  }));
}

test('SQL50 exact plan hash, all members before used, sequential multi-chunk cursor and no premature verify', () => transaction(async () => {
  const p = await plan(), frozen = await snapshot();
  await assert.rejects(chunk('dispatch_group_members', 0)); await assert.rejects(verify());
  for (const hash of [null, '', '0'.repeat(63), 'A'.repeat(64), '0'.repeat(64)]) await assert.rejects(begin(p, { p_plan_hash: hash }));
  assert.deepEqual(await snapshot(), frozen); await begin(p);
  for (const key of [null, 'orders', 'valid_order_data', 'dispatch_group_members;DROP TABLE users']) await assert.rejects(chunk(key, 0));
  for (const no of [null, -1, 1, 2, 2147483647]) await assert.rejects(chunk('dispatch_group_members', no));
  await assert.rejects(chunk('used_order_data', 0), /members before/i); await chunk('dispatch_group_members', 0);
  await assert.rejects(chunk('used_order_data', 0), /members before/i); await assert.rejects(verify(), /incomplete/i);
  await chunk('dispatch_group_members', 1); await chunk('used_order_data', 0);
  await assert.rejects(chunk('used_order_data', 2)); await assert.rejects(verify(), /incomplete/i);
  for (let no = 1; no < p.chunks.used_order_data; no++) await chunk('used_order_data', no);
  assert.equal((await verify()).verified, true); await assert.rejects(chunk('used_order_data', p.chunks.used_order_data));
  await noLegacy();
}));

test('SQL50 never opens the legacy identity/dependency/finance path even after mapped verification', () => transaction(async () => {
  const p = await plan(); await finish(p); await noLegacy(); const frozen = await snapshot();
  for (const [name, extra] of [
    ['get_employee_import_dispatch_dependency_plan', {}], ['employee_import_dispatch_dependency_begin', { p_plan_hash: p.plan_hash }],
    ['employee_import_dispatch_dependency_chunk', { p_table_key: 'used_order_data', p_chunk_no: 0 }], ['employee_import_dispatch_dependency_verify', {}],
    ['get_employee_import_finance_plan', {}],
  ]) await assert.rejects(rpc(name, { ...auth(), ...extra }));
  // The old dry-run intentionally saves identity_plan/heartbeat; isolate that real
  // technical side effect rather than falsely requiring it to be a read-only RPC.
  const point = `old_identity_plan_${++counter}`; await db.exec(`SAVEPOINT ${point}`);
  try {
    const legacy = await rpc('get_employee_import_identity_plan', auth());
    assert.equal(legacy.can_restore, false); assert.equal(legacy.replacement_ready, false); assert.equal(legacy.full_site_complete, false);
    await assert.rejects(rpc('employee_import_identity_begin', { ...auth(), p_plan_hash: legacy.plan_hash }));
    await noLegacy();
  } finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
  assert.deepEqual(await snapshot(), frozen); await noLegacy();
}));

for (const missing of ['no valid', 'valid not verified', 'no identities', 'second identity missing', 'second identity not verified']) {
  test(`SQL50 genuine unfinished prerequisite: ${missing} blocks every operation`, () => withClone(configuredDump, configuredTask, () => transaction(async () => {
    if (missing === 'valid not verified') {
      const config = (await summary()).dispatch_config_plan;
      const v = await rpc('employee_import_dispatch_valid_begin', { ...auth(), p_plan_hash: config.plan_hash });
      for (let no = 0; no < v.chunks; no++) await rpc('employee_import_dispatch_valid_chunk', { ...auth(), p_chunk_no: no });
    } else if (missing !== 'no valid') await restoreValid();
    if (missing !== 'no identities') await restoreIdentities({
      omit: missing === 'second identity missing' ? S.two : null,
      incomplete: missing === 'second identity not verified' ? S.two : null,
    });
    await denyAll({ plan_hash: '0'.repeat(64) }); assert.equal((await states()).length, 0); await noLegacy();
  })));
}

test('SQL50 empty dependency tables still require one explicit empty chunk each', () => variant(async () => {
  await source.exec('DELETE FROM public.used_order_data; DELETE FROM public.dispatch_group_members');
}, async input => {
  const p = await plan(); common(p); assert.deepEqual(p.totals, { dispatch_group_members: 0, used_order_data: 0 });
  assert.deepEqual(p.chunks, { dispatch_group_members: 1, used_order_data: 1 }); await begin(p);
  await assert.rejects(verify(), /incomplete/i); await assert.rejects(chunk('used_order_data', 0), /members before/i);
  await chunk('dispatch_group_members', 0); await assert.rejects(verify(), /incomplete/i);
  await chunk('used_order_data', 0); assert.equal((await verify()).verified, true); await assertDependencies(input.expected); await noLegacy();
}));

test('SQL50 source NULL assigner and timestamp remain NULL rather than root/default time', () => variant(async () => {
  await source.query('UPDATE public.dispatch_group_members SET assigned_by=NULL,assigned_at=NULL WHERE id=$1', [S.memberOne]);
}, async input => {
  await finish(await plan()); await assertDependencies(input.expected);
  assert.deepEqual((await rows(db, 'SELECT assigned_by,assigned_at FROM public.dispatch_group_members WHERE id=$1', [S.memberOne]))[0], { assigned_by: null, assigned_at: null });
}));

test('SQL50 source assigner absent from actual same-package admin map is only unmapped_assigner, never root substitution', () => variant(async () => {
  await source.query("INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,'dependency-unmapped','local-only','secondary_admin',false)", [S.unknownAdmin]);
  await source.query('UPDATE public.dispatch_group_members SET assigned_by=$1 WHERE id=$2', [S.unknownAdmin, S.memberOne]);
}, async () => {
  const frozen = await snapshot(), p = await plan(); common(p); assert.equal(p.can_begin, false); assert.deepEqual(p.conflicts, ['unmapped_assigner']);
  await assert.rejects(begin(p), /conflicts/i); assert.equal((await status()).started, false); assert.deepEqual(await snapshot(), frozen);
}));

for (const residual of DEPENDENCIES) test(`SQL50 preexisting ${residual} is reported and never cleared, overwritten or unioned`, () => transaction(async () => {
  const key = residual, original = expected[key][0], row = JSON.parse(original.body), config = (await summary()).dispatch_config_plan;
  row.user_id = bindings[original.user_id].target_id;
  if (key === 'dispatch_group_members') { row.group_id = config.group_map[row.group_id]; row.assigned_by = config.admin_map[row.assigned_by]; }
  await change('public.' + key, `INSERT INTO public.${key} SELECT * FROM jsonb_populate_record(NULL::public.${key},$1::jsonb)`, [JSON.stringify(row)]);
  const frozen = await snapshot(), p = await plan(); common(p); assert.equal(p.can_begin, false);
  assert.deepEqual(p.conflicts, [key === 'dispatch_group_members' ? 'target_members_not_empty' : 'target_used_not_empty']);
  await assert.rejects(begin(p)); assert.equal((await status()).started, false); assert.deepEqual(await snapshot(), frozen); await noLegacy();
}));

test('SQL50 actual exported member outside identity directory cannot be filtered away by mapping joins', () => variant(async () => {
  await source.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
    SELECT $1,'not-in-identity-package','DEP-OUTSIDE',password_hash,id FROM public.admins WHERE id=$2`, [id(400), NEW.root]);
  await source.query('UPDATE public.dispatch_group_members SET user_id=$1 WHERE id=$2', [id(400), S.memberOne]);
}, async () => {
  await denyAll({ plan_hash: '0'.repeat(64) }, {}, /references|incomplete|mapping|employee/i); await noLegacy();
}));

test('SQL50 prerequisite source exporter itself refuses a used row belonging to another completed order owner', () => transaction(async () => {
  await source.query('UPDATE public.used_order_data SET user_id=$1 WHERE id=$2', [S.two, id(202)]);
  const point = `source_order_owner_${++counter}`; await source.exec(`SAVEPOINT ${point}`);
  try { await assert.rejects(capture('dispatch'), /mismatched order/i); }
  finally { await source.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
}, source));

for (const [label, extra] of [
  ['NULL session', () => ({ p_admin_session_token: null })], ['random session', () => ({ p_admin_session_token: randomUUID() })],
  ['secondary admin', () => ({ p_admin_session_token: branch })], ['emergency admin', () => ({ p_admin_session_token: emergency })],
  ['foreign root', () => ({ p_admin_session_token: other })], ['source session', () => ({ p_admin_session_token: sourceSession })],
  ['NULL job', () => ({ p_job_token: null })], ['random job', () => ({ p_job_token: randomUUID() })],
  ['shared job', () => ({ p_job_token: sharedTask.job_token })],
]) test(`SQL50 rejects ${label} for anon and authenticated without writes`, () => transaction(async () => {
  const p = await plan(); await begin(p); await denyAll(p, extra());
}));

for (const [label, sql, params] of [
  ['expired session', "UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=private.hash_financial_token($1)", () => [session]],
  ['revoked session', 'UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE token_hash=private.hash_financial_token($1)', () => [session]],
  ['idle job', "UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", () => [task.job_id]],
  ['absolute job age', "UPDATE private.employee_transfer_jobs SET started_at=now()-interval '13 hours' WHERE id=$1", () => [task.job_id]],
  ['wrong protocol', "UPDATE private.employee_transfer_jobs SET options=jsonb_set(options,'{import_protocol}','\"shared-import-v1\"') WHERE id=$1", () => [task.job_id]],
  ['failed job', "UPDATE private.employee_transfer_jobs SET status='failed' WHERE id=$1", () => [task.job_id]],
  ['missing maintenance', 'DELETE FROM private.employee_transfer_maintenance WHERE job_id=$1', () => [task.job_id]],
  ['missing backup seal', 'UPDATE private.employee_transfer_shared_backups SET sealed_at=NULL WHERE id=$1', () => [task.job_id]],
  ['missing configuration receipt', "UPDATE private.employee_transfer_jobs SET summary=summary-'dispatch_configuration_receipt' WHERE id=$1", () => [task.job_id]],
  ['missing actual shared mapping', "UPDATE private.employee_transfer_jobs SET summary=summary-'shared_receipt' WHERE id=$1", () => [sharedTask.job_id]],
]) test(`SQL50 every RPC rechecks ${label} after committed progress`, () => transaction(async () => {
  const p = await plan(); await begin(p); await chunk('dispatch_group_members', 0); await db.query(sql, params()); await denyAll(p);
}));

for (const owner of ['inactive', 'secondary_admin', 'emergency_admin']) test(`SQL50 ${owner} task owner loses every RPC privilege`, () => transaction(async () => {
  const p = await plan(); await begin(p);
  await change('public.admins', owner === 'inactive' ? 'UPDATE public.admins SET is_active=false WHERE id=$1' : 'UPDATE public.admins SET role=$2 WHERE id=$1', owner === 'inactive' ? [NEW.root] : [NEW.root, owner]);
  await denyAll(p);
}));

test('SQL50 actual cancel invalidates plan/status/writes and retains dirty maintenance and already written member', () => transaction(async () => {
  const p = await plan(); await begin(p); await chunk('dispatch_group_members', 0);
  const maintenance = await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m');
  assert.equal((await rpc('employee_transfer_cancel', auth())).success, true);
  assert.equal(await scalar(db, 'SELECT status FROM private.employee_transfer_jobs WHERE id=$1', [task.job_id]), 'cancelled');
  assert.deepEqual(await scalar(db, 'SELECT to_jsonb(m) FROM private.employee_transfer_maintenance m'), maintenance);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM public.dispatch_group_members'), 1); await denyAll(p);
}));

for (const key of TABLES.dispatch) for (const representation of ['rows', 'ndjson', 'row_hashes']) {
  test(`SQL50 independently rescans ${key} ${representation} instead of trusting a source digest or parsed array`, () => transaction(async () => {
    const p = await plan(); await begin(p);
    const replacement = representation === 'rows' ? "jsonb_set(payload,'{rows,0,id}',to_jsonb($3::text))"
      : representation === 'ndjson' ? "jsonb_set(payload,'{ndjson}',to_jsonb((payload->>'ndjson')||E'\\n'))"
        : "jsonb_set(payload,'{row_hashes}',to_jsonb(repeat('0',length(payload->>'row_hashes'))))";
    await db.query(`UPDATE private.employee_transfer_staging SET payload=${replacement} WHERE job_id=$1 AND table_key=$2 AND chunk_no=0`,
      [task.job_id, 'dispatch-in:' + key, ...representation === 'rows' ? [id(999)] : []]);
    await denyAll(p);
  }));
}

for (const key of DEPENDENCIES) test(`SQL50 coherent changed ${key} raw/parsed/hash/catalog still invalidates a begun plan`, () => transaction(async () => {
  const p = await plan(); await begin(p);
  const original = await scalar(db, 'SELECT payload FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key=$2 AND chunk_no=0', [task.job_id, 'dispatch-in:' + key]);
  const text = original.ndjson.replace('2021-', '2022-'), hashes = lines(text).map(sha).join('');
  assert.notEqual(text, original.ndjson);
  await db.query(`UPDATE private.employee_transfer_staging SET payload=jsonb_build_object('ndjson',$3::text,'rows',jsonb_build_array($3::jsonb),
    'bytes',octet_length($3::text),'row_hashes',$4::text,'last_id',payload->'last_id') WHERE job_id=$1 AND table_key=$2 AND chunk_no=0`, [task.job_id, 'dispatch-in:' + key, text, hashes]);
  const allHashes = (await rows(db, "SELECT payload->>'row_hashes' AS h FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key=$2 ORDER BY chunk_no", [task.job_id, 'dispatch-in:' + key])).map(r => r.h).join('');
  await db.query("UPDATE private.employee_transfer_jobs SET options=jsonb_set(options,$2::text[],to_jsonb($3::text)) WHERE id=$1", [task.job_id,
    ['catalog', 'tables', String(TABLES.dispatch.indexOf(key)), 'row_hashes_sha256'], sha(allHashes)]);
  await denyAll(p);
}));

for (const [label, relation, sql, params] of [
  ['member assigned_at microsecond', 'dispatch_group_members', "UPDATE public.dispatch_group_members SET assigned_at=assigned_at+interval '1 microsecond' WHERE id=$1", () => [S.memberOne]],
  ['member group', 'dispatch_group_members', 'UPDATE public.dispatch_group_members SET group_id=(SELECT group_id FROM public.dispatch_group_members WHERE id=$2) WHERE id=$1', () => [S.memberOne, S.memberTwo]],
  ['member assigner', 'dispatch_group_members', 'UPDATE public.dispatch_group_members SET assigned_by=NULL WHERE id=$1', () => [S.memberOne]],
  ['used owner/order mismatch', 'used_order_data', 'UPDATE public.used_order_data SET user_id=$2 WHERE id=$1', () => [id(202), bindings[S.two].target_id]],
  ['used other order', 'used_order_data', 'UPDATE public.used_order_data SET order_id=$2 WHERE id=$1', () => [id(200), id(102)]],
  ['used valid reference', 'used_order_data', 'UPDATE public.used_order_data SET valid_order_data_id=$2 WHERE id=$1', () => [id(200), S.validNull]],
  ['used timestamp microsecond', 'used_order_data', "UPDATE public.used_order_data SET created_at=created_at+interval '1 microsecond' WHERE id=$1", () => [id(200)]],
  ['valid maximum counter', 'valid_order_data', 'UPDATE public.valid_order_data SET usage_count=usage_count-1 WHERE id=$1', () => [S.validMax]],
  ['valid NULL counter', 'valid_order_data', 'UPDATE public.valid_order_data SET usage_count=0 WHERE id=$1', () => [S.validNull]],
  ['valid last_used_at microsecond', 'valid_order_data', "UPDATE public.valid_order_data SET last_used_at=last_used_at+interval '1 microsecond' WHERE id=$1", () => [S.validMax]],
  ['configuration same-count field', 'dispatch_groups', "UPDATE public.dispatch_groups SET description='negative drift' WHERE id=$1", async () => [(await summary()).dispatch_config_plan.group_map[S.group]]],
  ['mapped identity business field', 'users', "UPDATE public.users SET remarks='negative drift' WHERE id=$1", () => [bindings[S.one].target_id]],
  ['mapped order owner', 'orders', 'UPDATE public.orders SET user_id=$2 WHERE id=$1', () => [id(100), bindings[S.two].target_id]],
]) test(`SQL50 all repeated/verified RPCs reject same-count target drift: ${label}`, () => transaction(async () => {
  const p = await plan(); await finish(p); const counts = (await business()).map(r => [r.name, r.n]);
  await change('public.' + relation, sql, await params());
  assert.deepEqual((await business()).map(r => [r.name, r.n]), counts); await denyAll(p);
}));

for (const [field, value] of [
  ['scope', 'forged'], ['job_id', id(900)], ['site_id', id(901)], ['source_site_id', id(902)], ['package_id', id(903)],
  ['mapping_hash', '0'.repeat(64)], ['plan_hash', '0'.repeat(64)], ['maintenance', false], ['dependencies_pending', false],
  ...GATES.map(key => [key, true]), ['totals', { dispatch_group_members: 0, used_order_data: 4 }],
  ['chunks', { dispatch_group_members: 1, used_order_data: 4 }], ['can_begin', false], ['conflicts', ['unmapped_assigner']],
]) test(`SQL50 corrupted saved plan ${field} cannot confer progress or complete-restore authority`, () => transaction(async () => {
  const p = await plan(); await begin(p);
  await db.query('UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$3::text[],$4::jsonb) WHERE job_id=$1 AND table_key=$2', [task.job_id, STATE, ['plan', field], JSON.stringify(value)]);
  await denyAll(p);
}));

for (const [path, value] of [
  [['counts', 'dispatch_group_members'], 1], [['counts', 'used_order_data'], -1], [['counts', 'used_order_data'], '0'],
  [['next_chunks', 'dispatch_group_members'], 1], [['next_chunks', 'used_order_data'], 1], [['next_chunks', 'used_order_data'], '0'],
  [['verified'], true], [['verified'], 'false'], [['identity_map'], {}], [['admin_map'], {}], [['group_map'], {}],
]) test(`SQL50 saved progress corruption ${path.join('.')}=${JSON.stringify(value)} is never accepted`, () => transaction(async () => {
  const p = await plan(); await begin(p);
  await db.query('UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$3::text[],$4::jsonb) WHERE job_id=$1 AND table_key=$2', [task.job_id, STATE, path, JSON.stringify(value)]);
  await denyAll(p);
}));

for (const [label, sql] of [
  ['wrong employee namespace', `UPDATE private.employee_transfer_staging SET employee_id='${S.one}' WHERE job_id=$1 AND table_key=$2`],
  ['wrong state chunk', 'UPDATE private.employee_transfer_staging SET chunk_no=1 WHERE job_id=$1 AND table_key=$2'],
  ['wrong row_count', 'UPDATE private.employee_transfer_staging SET row_count=0 WHERE job_id=$1 AND table_key=$2'],
  ['duplicate state namespace', `INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    SELECT job_id,'${S.two}',table_key,chunk_no,row_count,payload FROM private.employee_transfer_staging WHERE job_id=$1 AND table_key=$2`],
]) test(`SQL50 ${label} is detected rather than silently choosing one staging row`, () => transaction(async () => {
  const p = await plan(); await begin(p); await db.query(sql, [task.job_id, STATE]); await denyAll(p);
}));

for (const [path, value] of [[['verified'], false], [['counts', 'orders'], 0], [['next_chunk'], 0],
  [['plan', 'target_id'], S.one], [['plan', 'binding_hash'], '0'.repeat(64)]]) test(`SQL50 revalidates SQL49 source two state ${path.join('.')}`, () => transaction(async () => {
  const p = await plan(); await begin(p);
  await db.query("UPDATE private.employee_transfer_staging SET payload=jsonb_set(payload,$3::text[],$4::jsonb) WHERE job_id=$1 AND employee_id=$2 AND table_key='mapped-identity-v1'", [task.job_id, S.two, path, JSON.stringify(value)]);
  await denyAll(p);
}));

for (const [label, sql, params] of [
  ['source group mapping missing', 'UPDATE private.employee_transfer_jobs SET group_map=group_map-$2 WHERE id=$1', () => [task.job_id, S.group]],
  ['second SQL49 identity state missing', "DELETE FROM private.employee_transfer_staging WHERE job_id=$1 AND employee_id=$2 AND table_key='mapped-identity-v1'", () => [task.job_id, S.two]],
  ['second SQL48 reservation missing', "DELETE FROM private.employee_transfer_staging WHERE job_id=$1 AND employee_id=$2 AND table_key='identity-reservation-v1'", () => [task.job_id, S.two]],
  ['source used chunk namespace changed', "UPDATE private.employee_transfer_staging SET employee_id=$2 WHERE job_id=$1 AND table_key='dispatch-in:used_order_data' AND chunk_no=0", () => [task.job_id, S.one]],
]) test(`SQL50 ${label} cannot silently shorten the full-package mapping`, () => transaction(async () => {
  const p = await plan(); await begin(p); await db.query(sql, params()); await denyAll(p);
}));

for (const legacy of ['identity_restore', 'dependency_restore']) test(`SQL50 refuses mixing legacy ${legacy}, including empty forged state`, () => transaction(async () => {
  const p = await plan(); await begin(p);
  await db.query("UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,$2::text[],'{}'::jsonb) WHERE id=$1", [task.job_id, [legacy]]);
  await denyAll(p);
}));

for (const [label, sql] of [
  ['unknown member trigger', 'CREATE TRIGGER aa_mapped_dependency_unknown BEFORE INSERT ON public.dispatch_group_members FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['unknown used trigger', 'CREATE TRIGGER aa_mapped_dependency_unknown BEFORE INSERT ON public.used_order_data FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write()'],
  ['disabled usage trigger', 'ALTER TABLE public.used_order_data DISABLE TRIGGER trigger_update_valid_data_usage'],
  ['replica usage trigger', 'ALTER TABLE public.used_order_data ENABLE REPLICA TRIGGER trigger_update_valid_data_usage'],
  ['changed usage function', 'ALTER FUNCTION public.update_valid_data_usage_stats() SECURITY DEFINER'],
  ['disabled maintenance guard', 'ALTER TABLE public.used_order_data DISABLE TRIGGER zz_employee_transfer_maintenance'],
]) test(`SQL50 rejects ${label} without relaxing the audited trigger policy`, () => transaction(async () => {
  const p = await plan(); await begin(p); await db.exec(sql); await denyAll(p, {}, /Unreviewed|maintenance guard/i);
}));

for (const phase of ['begin', 'member', 'used', 'verify']) test(`SQL50 late ${phase} audit failure rolls back rows/state/event, restores triggers and clears permits`, () => transaction(async () => {
  const p = await plan();
  if (phase !== 'begin') await begin(p);
  if (['used', 'verify'].includes(phase)) await finishMembers(p);
  if (phase === 'verify') for (let no = 0; no < p.chunks.used_order_data; no++) await chunk('used_order_data', no);
  const action = phase === 'begin' ? 'mapped_dependencies_started' : phase === 'verify' ? 'mapped_dependencies_verified' : 'mapped_dependencies_chunk';
  await db.exec(`CREATE FUNCTION public.mapped_dependency_test_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.action='${action}' THEN RAISE EXCEPTION 'mapped dependency final audit failed'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER mapped_dependency_test_late_failure BEFORE INSERT ON private.employee_transfer_events FOR EACH ROW EXECUTE FUNCTION public.mapped_dependency_test_late_failure()`);
  const frozen = await snapshot(), modes = await triggers(), valid = await validSnapshot();
  await assert.rejects(phase === 'begin' ? begin(p) : phase === 'verify' ? verify() : chunk(phase === 'member' ? 'dispatch_group_members' : 'used_order_data', 0), /mapped dependency final audit failed/);
  assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes); assert.deepEqual(await validSnapshot(), valid); assert.equal(await permits(), 0);
  await db.exec('DROP TRIGGER mapped_dependency_test_late_failure ON private.employee_transfer_events; DROP FUNCTION public.mapped_dependency_test_late_failure()');
  const progress = await status(); assert.equal(progress.started, phase !== 'begin'); assert.equal(progress.verified, false);
  // Removing the local fault allows the same explicit request to proceed, not an automatic retry.
  if (phase === 'begin') await begin(p); else if (phase === 'verify') assert.equal((await verify()).verified, true);
  else await chunk(phase === 'member' ? 'dispatch_group_members' : 'used_order_data', 0);
  assert.deepEqual(await validSnapshot(), valid); await noLegacy();
}));

for (const key of DEPENDENCIES) test(`SQL50 mapped-row constraint failure in ${key} rolls back an active permit/usage-trigger bypass`, () => transaction(async () => {
  const p = await plan(); await begin(p);
  if (key === 'used_order_data') await finishMembers(p);
  // Source UUID passes this check, mapped target UUID fails only after issuing the
  // permit (and, for used, actually disabling the audited usage trigger).
  await db.exec(`ALTER TABLE public.${key} ADD CONSTRAINT mapped_dependency_target_failure
    CHECK(user_id<>'${bindings[S.one].target_id}'::uuid) NOT VALID`);
  const frozen = await snapshot(), modes = await triggers(), valid = await validSnapshot();
  await assert.rejects(chunk(key, 0), /violates target constraints|check constraint/i);
  assert.deepEqual(await snapshot(), frozen); assert.deepEqual(await triggers(), modes);
  assert.deepEqual(await validSnapshot(), valid); assert.equal(await permits(), 0);
  await db.exec(`ALTER TABLE public.${key} DROP CONSTRAINT mapped_dependency_target_failure`);
  await chunk(key, 0); assert.equal((await status()).next_chunks[key], 1);
}));

for (const timezone of ['Asia/Taipei', 'America/New_York']) test(`SQL50 UTC raw timestamp comparison is stable in ${timezone} caller session`, () => transaction(async () => {
  const p = await plan(); await db.query("SELECT set_config('TimeZone',$1,true)", [timezone]);
  assert.deepEqual(await plan(), p); await finish(p); assert.equal((await status()).verified, true);
  assert.equal(await scalar(db, "SELECT current_setting('TimeZone')"), timezone);
  await db.exec("SET LOCAL TimeZone='UTC'"); await assertDependencies();
}));

test('SQL50 real COMMIT then dropped chunk response resumes from status on a separately loaded dump without duplicate usage', async () => {
  // Clone genuine committed baseline; no state, plan, mapping or backup is manufactured.
  const dump = await db.dumpDataDir('none'), originalTask = task;
  await withClone(dump, originalTask, async () => {
    let p; const valid = await validSnapshot();
    await transaction(async () => { p = await plan(); await begin(p); await finishMembers(p); }, db, true);
    let writes = 0;
    async function lostResponse() {
      await transaction(async () => { await chunk('used_order_data', 0); writes++; }, db, true);
      throw new Error('local transport lost response AFTER COMMIT');
    }
    await assert.rejects(lostResponse(), /AFTER COMMIT/); assert.equal(writes, 1);
    const committed = await db.dumpDataDir('none');
    await withClone(committed, originalTask, () => transaction(async () => {
      const s = await status(); common(s, p); assert.equal(s.started, true); assert.equal(s.verified, false);
      assert.deepEqual(s.counts, { dispatch_group_members: 2, used_order_data: 1 }); assert.equal(s.next_chunks.used_order_data, 1);
      const frozen = await snapshot(); assert.deepEqual(await chunk('used_order_data', 0), s); assert.deepEqual(await snapshot(), frozen);
      for (let no = s.next_chunks.used_order_data; no < p.chunks.used_order_data; no++) await chunk('used_order_data', no);
      assert.equal((await verify()).verified, true); assert.deepEqual(await validSnapshot(), valid); await assertDependencies(); await noLegacy();
    }, db, true));
  });
});
