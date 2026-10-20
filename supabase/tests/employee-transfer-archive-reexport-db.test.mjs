import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, mock, test } from 'node:test';
import { replayMigrations } from './support/replay-migrations.mjs';
import { adminLogin, rpc, scalar } from './support/transfer-harness.mjs';

// SQL38 local reader layer, following archive-reader-db: synthetic persisted jobs,
// real SQL33/34/35 validators and real session/role checks. NO end-to-end import,
// Storage bytes, Edge, PostgREST or production service is exercised or claimed.
const MIGRATION = '20261102000038_reexport_archive_namespaces.sql';
const PREVIOUS = '20261102000037_plan_employee_replacement.sql';
const TABLES = ['content_audit_events', 'deleted_employee_accounts', 'deleted_employee_notifications',
  'content_audit_recipient_versions', 'deleted_employee_summaries', 'deleted_employee_withdrawals'];
const PREFIX = 'get_employee_archive_reexport_';
const id = n => `38abcdef-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = text => createHash('sha256').update(text).digest('hex');
const PRECISE = '12345678901234567890.12345678901234567890';
const TIME = '2024-02-29T23:34:56.123456Z';
const RECEIPT = { verified: true, scope: 'site-archives', media_pending: true, full_site_complete: false };
const raw = row => JSON.stringify(row).replaceAll('"__PRECISE__"', PRECISE).replace('"id":', '"id" : ') + '\n';
const lines = text => text.match(/[^\n]*\n/g) ?? [];
let db, replay, session, branch, emergency, inside = false, fixtures;

function rawRows({ label = '来源甲', events = 3, padding = '', refs = {} } = {}) {
  return {
    content_audit_events: Array.from({ length: events }, (_, n) => raw({ id: id(1000 + n), operation_id: id(10),
      entity_type: 'notification', entity_id: id(11), action: 'edit', owner_admin_id: id(12), owner_username: 'source-owner',
      actor_admin_id: null, actor_username: 'source-actor', actor_role: 'super_admin', customer_id: null, employee_id: id(13),
      occurred_at: TIME, before_data: null, after_data: { label, amount: '__PRECISE__', html: '<script>not executed</script>', padding },
      media_refs: refs, clear_reason: null, clear_started_at: null, cleared_at: null, cleared_by: null, cleared_username: null,
      employee_account: label, message_created_at: null, before_data_sql_null: n % 2 === 0, after_data_sql_null: false })).join(''),
    deleted_employee_accounts: raw({ id: id(110), operation_id: id(10), employee_id: id(13), account_username: label,
      employee_number: null, account_created_at: TIME, account_remarks: label, owner_admin_id: id(12), owner_username: 'source-owner',
      actor_admin_id: id(12), actor_username: 'source-actor', actor_role: 'super_admin', deletion_source: 'admin', deleted_at: TIME,
      cleared_at: null, cleared_by: null, cleared_username: null, clear_reason: null, account_real_name: null }),
    deleted_employee_notifications: raw({ id: id(112), record_id: id(110), message_id: id(120), message_data: null,
      recipient_data: null, archived_event_id: id(1000), cleared_at: null, cleared_by: null, clear_reason: null,
      message_data_sql_null: true, recipient_data_sql_null: false }),
    content_audit_recipient_versions: raw({ id: `${id(120)}:${id(121)}`, message_id: id(120), recipient_id: id(121),
      recipient_data: { label, amount: '__PRECISE__', session_created_at: TIME, last_heartbeat_at: TIME, optional: null } }),
    deleted_employee_summaries: `{"id" : "${id(110)}","employee_id":"${id(13)}","source_present":false,"is_verified":null,"total_income":${PRECISE},"available_balance":null,"frozen_balance":0.00000000000000000001,"total_orders":"9223372036854775807"}\n`,
    deleted_employee_withdrawals: `{"id":"${id(110)}:${id(111)}","record_id":"${id(110)}","withdrawal_id":"${id(111)}","employee_id":"${id(13)}","amount":${PRECISE},"status":"approved","created_at":"${TIME}"}\n`,
  };
}
function catalogFor(site, pkg, texts) {
  return { version: 1, scope: 'site-archives', site_id: site, package_id: pkg, full_site_complete: false,
    tables: TABLES.map(key => ({ key, rows: lines(texts[key]).length, bytes: Buffer.byteLength(texts[key]),
      row_hashes_sha256: sha(lines(texts[key]).map(sha).join('')) })) };
}
async function sealFixture(job, catalog) {
  const counts = Object.fromEntries(catalog.tables.map(t => [t.key, t.rows]));
  const chunks = Object.fromEntries(catalog.tables.map(t => [t.key, Math.max(1, Math.ceil(t.rows / 200))]));
  const plan = { scope: 'site-archives', checked: true, can_restore: true, counts, conflicts: [], media_pending: true,
    maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
  const namespaceHash = await scalar(db, 'SELECT private.employee_transfer_archives_namespace_hash($1,$2)', [catalog.site_id, catalog.package_id]);
  const state = { catalog, plan_hash: '', plan, initial_namespace_hash: sha(''), namespace_hash: namespaceHash,
    chunks, completed_chunks: chunks, records_verified: true };
  state.plan_hash = await scalar(db, `SELECT encode(extensions.digest(convert_to(jsonb_build_object('job_id',$1::uuid,'catalog',$2::jsonb,
    'namespace_hash',$3::text,'plan',$4::jsonb)::text,'UTF8'),'sha256'),'hex')`, [job, JSON.stringify(catalog), sha(''), JSON.stringify(plan)]);
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('archives_catalog',$2::jsonb,'archives_restore',$3::jsonb) WHERE id=$1`,
    [job, JSON.stringify(catalog), JSON.stringify(state)]);
  await db.query('SELECT private.employee_transfer_archives_persisted(j) FROM private.employee_transfer_jobs j WHERE id=$1', [job]);
  return catalog;
}
async function bindSyntheticSidecar(job) {
  const refs = await scalar(db, 'SELECT private.employee_transfer_archive_media_refs(j,false) FROM private.employee_transfer_jobs j WHERE id=$1', [job]);
  const generation = await scalar(db, 'SELECT private.employee_transfer_archive_media_generation(j,$2::jsonb) FROM private.employee_transfer_jobs j WHERE id=$1', [job, JSON.stringify(refs)]);
  // Synthetic tuples/receipts validate database bindings ONLY, not actual file bytes.
  const files = refs.map(ref => ({ key: ref.key, source_url: ref.source_url, bytes: 8, sha256: sha('synthetic-png'), content_type: 'image/png' }));
  const receipts = Object.fromEntries(refs.map((ref, n) => [ref.key, { file: files[n], path: `transfer-archives/${job}/${ref.key}`,
    generation, checked: true, storage_origin: 'https://fixture.supabase.co' }]));
  const sidecar = { version: 1, refs, files, receipts, verified: true };
  await setSidecar(job, sidecar);
  await db.query('SELECT private.employee_transfer_archive_media_state(j,false) FROM private.employee_transfer_jobs j WHERE id=$1', [job]);
  return sidecar;
}
async function seedNamespace({ site = id(20), pkg = id(30), job = id(40), empty = false, media = true,
  verified = true, started = '2024-01-01T00:00:00Z', ...rowOptions } = {}) {
  const texts = empty ? Object.fromEntries(TABLES.map(key => [key, ''])) : rawRows(rowOptions);
  const catalog = catalogFor(site, pkg, texts);
  await db.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options,summary,started_at,finished_at,last_activity_at)
    VALUES($1,'import',$2,'archive-reexport-root','synthetic-local-token','cancelled',$3::jsonb,'{}',$4,'2024-01-02','2024-01-01')`,
  [job, id(1), JSON.stringify({ import_protocol: 'dispatch-submission-v1', package_id: pkg, catalog: { site_id: site } }), started]);
  for (const key of TABLES) {
    await db.query('SELECT private.employee_transfer_check_archives_row($1,line::jsonb) FROM jsonb_array_elements_text($2::jsonb) AS r(line)', [key, JSON.stringify(lines(texts[key]))]);
    await db.query(`INSERT INTO private.employee_transfer_archive_records(source_site_id,package_id,table_key,source_id,body,source_line,job_id,imported_at)
      SELECT $1,$2,$3,line::jsonb->>'id',line::jsonb,line,$4,'2024-02-29T23:34:56.123456Z'
      FROM jsonb_array_elements_text($5::jsonb) AS r(line)`, [site, pkg, key, job, JSON.stringify(lines(texts[key]))]);
  }
  await sealFixture(job, catalog);
  if (media) await bindSyntheticSidecar(job);
  if (!verified) await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_restore,records_verified}','false') WHERE id=$1`, [job]);
  return { site, pkg, job, texts, catalog };
}
const setSidecar = (job, sidecar) => db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_media}',$2::jsonb) WHERE id=$1`, [job, JSON.stringify(sidecar)]);
const sidecarFor = job => scalar(db, `SELECT summary->'archives_media' FROM private.employee_transfer_jobs WHERE id=$1`, [job]);
async function refreshFixture(fixture) {
  const texts = {};
  for (const key of TABLES) texts[key] = await scalar(db, `SELECT COALESCE(string_agg(source_line,'' ORDER BY source_id COLLATE "C"),'')
    FROM private.employee_transfer_archive_records WHERE source_site_id=$1 AND package_id=$2 AND table_key=$3`, [fixture.site, fixture.pkg, key]);
  return sealFixture(fixture.job, catalogFor(fixture.site, fixture.pkg, texts));
}
async function cloneJob(fixture, job, started) {
  await db.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options,summary,started_at,last_activity_at)
    SELECT $1,kind,admin_id,admin_username,'synthetic-copy','abandoned',options,summary,$2,'2024-01-01'
    FROM private.employee_transfer_jobs WHERE id=$3`, [job, started, fixture.job]);
  await sealFixture(job, fixture.catalog);
  await bindSyntheticSidecar(job);
}
async function seedEmptyInventoryNamespaces(count, start = 2000, versionScale = 0) {
  // Local persisted fixtures only, no verifier stubs. A high-scale numeric 1 is
  // equal to catalog version 1 in SQL33, but expands real JSONB response bytes.
  await db.query(`WITH generated AS (
      SELECT ('38abcdef-0000-4000-8000-'||lpad(($2::integer+n)::text,12,'0'))::uuid AS new_id
      FROM generate_series(1,$1::integer) n
    ), catalogs AS (
      SELECT g.new_id,t.*,jsonb_set(jsonb_set(t.summary->'archives_catalog','{site_id}',to_jsonb(g.new_id::text)),
        '{version}',CASE WHEN $4::integer=0 THEN '1'::jsonb ELSE ('1.'||repeat('0',$4::integer))::jsonb END) AS catalog
      FROM generated g CROSS JOIN private.employee_transfer_jobs t WHERE t.id=$3
    )
    INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options,summary,started_at,last_activity_at)
    SELECT c.new_id,'import',c.admin_id,c.admin_username,'synthetic-inventory','cancelled',
      jsonb_set(c.options,'{catalog,site_id}',to_jsonb(c.new_id::text)),
      jsonb_build_object('archives_catalog',c.catalog,'archives_media',c.summary->'archives_media',
        'archives_restore',(c.summary->'archives_restore')||jsonb_build_object('catalog',c.catalog,
          'plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('job_id',c.new_id,'catalog',c.catalog,
            'namespace_hash',c.summary#>>'{archives_restore,initial_namespace_hash}','plan',c.summary#>'{archives_restore,plan}')::text,'UTF8'),'sha256'),'hex'))),
      '2024-01-01','2024-01-01' FROM catalogs c`, [count, start, fixtures.c.job, versionScale]);
}
async function readRpc(name, args, role = 'anon') {
  const owned = !inside;
  if (owned) await db.exec('BEGIN');
  await db.exec('SAVEPOINT reexport_call');
  try {
    assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
    await db.exec(`SET LOCAL ROLE ${role}`);
    const result = await rpc(db, name, args, { role: null });
    // Successful reads COMMIT rather than rolling away hypothetical write effects.
    await db.exec('RESET ROLE; RELEASE SAVEPOINT reexport_call');
    if (owned) await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT reexport_call; RELEASE SAVEPOINT reexport_call');
    if (owned) await db.exec('ROLLBACK');
    throw error;
  }
}
const argsFor = fixture => ({ p_admin_session_token: session, p_source_site_id: fixture.site, p_package_id: fixture.pkg });
const catalog = (fixture = fixtures.a, args = {}, role) => readRpc(`${PREFIX}catalog`, { ...argsFor(fixture), ...args }, role);
const page = (hash, key = TABLES[0], fixture = fixtures.a, args = {}, role) => readRpc(`${PREFIX}page`,
  { ...argsFor(fixture), p_snapshot_hash: hash, p_table_key: key, ...args }, role);
const verify = (hash, fixture = fixtures.a, args = {}, role) => readRpc(`${PREFIX}verify`, { ...argsFor(fixture), p_snapshot_hash: hash, ...args }, role);
const media = (hash, fixture = fixtures.a, args = {}, role) => readRpc(`${PREFIX}media`, { ...argsFor(fixture), p_snapshot_hash: hash, ...args }, role);
const inventory = (args = {}, role) => readRpc(`${PREFIX}inventory`, { p_admin_session_token: session, ...args }, role);
async function isolated(fn) {
  await db.exec('BEGIN'); inside = true;
  try { await fn(); } finally { inside = false; await db.exec('ROLLBACK'); }
}
async function rejectsAll(fixture, hash, pattern, args = {}) {
  await assert.rejects(catalog(fixture, args), pattern);
  await assert.rejects(page(hash, TABLES[0], fixture, args), pattern);
  await assert.rejects(verify(hash, fixture, args), pattern);
  await assert.rejects(media(hash, fixture, args), pattern);
}
async function rejectsSnapshot(hash, fixture = fixtures.a) {
  await assert.rejects(page(hash, TABLES[0], fixture), /snapshot changed or is invalid/);
  await assert.rejects(verify(hash, fixture), /snapshot changed or is invalid/);
  await assert.rejects(media(hash, fixture), /snapshot changed or is invalid/);
}
before(async () => {
  mock.method(globalThis, 'fetch', () => assert.fail('All network/production/Storage requests are forbidden'));
  replay = await replayMigrations({ upTo: PREVIOUS, strict: true }); db = replay.db;
  await db.exec(await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8'));
  const tokens = [];
  for (const [n, name, role] of [[1, 'archive-reexport-root', 'super_admin'], [2, 'archive-reexport-branch', 'secondary_admin'], [3, 'archive-reexport-emergency', 'emergency_admin']]) {
    await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,$2,extensions.crypt('Synthetic-123',extensions.gen_salt('bf',4)),$3,true)`, [id(n), name, role]);
    await db.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash) VALUES($1,extensions.crypt('Synthetic-123',extensions.gen_salt('bf',4)))`, [id(n)]);
    tokens.push(await adminLogin(db, name, 'Synthetic-123'));
  }
  [session, branch, emergency] = tokens;
  fixtures = { a: await seedNamespace(),
    b: await seedNamespace({ site: id(21), job: id(41), label: '来源乙', refs: { 'https://old.invalid/original.png': 'synthetic/private-evidence.png' } }),
    c: await seedNamespace({ pkg: id(31), job: id(42), empty: true }),
    unverified: await seedNamespace({ site: id(22), job: id(43), verified: false, empty: true }) };
}, { timeout: 120000 });
after(async () => { await db?.close(); mock.restoreAll(); });

test('SQL38 installs after strict SQL37 replay, with exactly the 12 known historical failures', () => {
  assert.equal(replay.failures.length, 12); assert.equal(replay.files.at(-1), PREVIOUS);
  assert.equal(replay.validation.freshDatabaseVerified, false);
});
for (const [name, types, defaults] of [
  ['catalog', 'uuid,uuid,uuid', 0], ['page', 'uuid,uuid,uuid,text,text,text,integer', 2], ['verify', 'uuid,uuid,uuid,text', 0],
  ['media', 'uuid,uuid,uuid,text', 0], ['inventory', 'uuid', 0],
]) test(`${name} is STABLE SECURITY DEFINER, fixed search_path, anon/authenticated only`, async () => {
  const signature = `public.${PREFIX}${name}(${types})`;
  const p = (await db.query(`SELECT provolatile,prosecdef,proconfig,proacl::text,pronargdefaults,pg_get_expr(proargdefaults,0) AS defaults FROM pg_proc WHERE oid=$1::regprocedure`, [signature])).rows[0];
  assert.equal(p.provolatile, 's'); assert.equal(p.prosecdef, true);
  assert.ok(p.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
  assert.equal(p.pronargdefaults, defaults);
  if (name === 'page') assert.equal(p.defaults, 'NULL::text, 200');
  assert.doesNotMatch(p.proacl, /(?:^|,)=[^,]*X/);
  for (const [role, allowed] of [['anon', true], ['authenticated', true], ['service_role', false]])
    assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [role, signature]), allowed);
});
test('private snapshot helper and persisted tables cannot be called or read by browser/service roles', async () => {
  const signature = 'private.employee_transfer_archive_reexport_snapshot(uuid,uuid,uuid)';
  const p = (await db.query('SELECT provolatile,prosecdef,proconfig,proacl::text FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0];
  assert.equal(p.provolatile, 's'); assert.equal(p.prosecdef, true);
  assert.ok(p.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
  assert.doesNotMatch(p.proacl, /(?:^|,)=[^,]*X/);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal(await scalar(db, 'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [role, signature]), false);
    for (const table of ['private.employee_transfer_archive_records', 'private.employee_transfer_jobs'])
      assert.equal(await scalar(db, 'SELECT has_table_privilege($1,$2,\'SELECT\')', [role, table]), false);
  }
});
for (const name of ['missing', 'random', 'secondary', 'emergency', 'revoked', 'expired', 'inactive', 'demoted'])
  test(`all five RPCs reject ${name} administrator session`, async () => isolated(async () => {
    const token = ({ missing: null, random: id(999), secondary: branch, emergency })[name];
    if (name === 'revoked') await db.query('UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE admin_id=$1', [id(1)]);
    if (name === 'expired') await db.query(`UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 day' WHERE admin_id=$1`, [id(1)]);
    if (name === 'inactive') await db.query('UPDATE public.admins SET is_active=false WHERE id=$1', [id(1)]);
    if (name === 'demoted') await db.query(`UPDATE public.admins SET role='secondary_admin' WHERE id=$1`, [id(1)]);
    await rejectsAll(fixtures.a, 'a'.repeat(64), /session|permission|administrator/i,
      { p_admin_session_token: token === undefined ? session : token });
    await assert.rejects(inventory({ p_admin_session_token: token === undefined ? session : token }), /session|permission|administrator/i);
  }));
test('service_role cannot call any of the five public RPCs even with a valid super-admin token', async () => {
  const hash = (await catalog()).snapshot_hash;
  await assert.rejects(catalog(fixtures.a, {}, 'service_role'), /permission denied/);
  await assert.rejects(page(hash, TABLES[0], fixtures.a, {}, 'service_role'), /permission denied/);
  await assert.rejects(verify(hash, fixtures.a, {}, 'service_role'), /permission denied/);
  await assert.rejects(media(hash, fixtures.a, {}, 'service_role'), /permission denied/);
  await assert.rejects(inventory({}, 'service_role'), /permission denied/);
});
test('catalog strictly returns the original SQL34 catalog and complete SHA256 snapshot binding', async () => {
  const result = await catalog(); assert.deepEqual(Object.keys(result).sort(), ['catalog', 'snapshot_hash']);
  assert.deepEqual(result.catalog, fixtures.a.catalog); assert.match(result.snapshot_hash, /^[0-9a-f]{64}$/);
  const input = await scalar(db, `SELECT jsonb_build_object('job_id',id,'catalog',summary->'archives_catalog',
    'namespace_hash',summary#>>'{archives_restore,namespace_hash}','archives_media',summary->'archives_media')::text
    FROM private.employee_transfer_jobs WHERE id=$1`, [fixtures.a.job]);
  assert.equal(result.snapshot_hash, sha(input));
  assert.deepEqual(await catalog(), result); assert.deepEqual(await catalog(fixtures.a, {}, 'authenticated'), result);
  assert.deepEqual(await verify(result.snapshot_hash, fixtures.a, {}, 'authenticated'), RECEIPT);
});
test('media returns the exact export inventory with original refs and bound tuples, never target Storage paths', async () => {
  const { snapshot_hash: hash } = await catalog(fixtures.b);
  const state = await sidecarFor(fixtures.b.job);
  const keys = state.refs.map(ref => ref.key);
  const expected = { version: 1, scope: 'site-archives-media', direction: 'export', archives_catalog: fixtures.b.catalog,
    files: state.refs.map((ref, n) => ({ ...ref, file: state.files[n] })), bound: true, verified: true,
    transferred: keys, checked: keys, full_site_complete: false };
  const inventory = await media(hash, fixtures.b);
  assert.equal(inventory.files.length, 3); assert.deepEqual(inventory, expected);
  assert.deepEqual(await media(hash, fixtures.b, {}, 'authenticated'), expected);
  assert.deepEqual(await catalog(fixtures.b), { catalog: fixtures.b.catalog, snapshot_hash: hash });
  for (const ref of inventory.files) {
    assert.equal(ref.path, ref.ref_value); assert.equal(ref.bucket, 'content-audit-evidence');
    assert.deepEqual(ref.file, state.receipts[ref.key].file);
    assert.notEqual(ref.path, state.receipts[ref.key].path);
    assert.equal(ref.source_line_sha256, sha(lines(fixtures.b.texts[TABLES[0]]).find(line => JSON.parse(line).id === ref.event_id)));
  }
  assert.doesNotMatch(JSON.stringify(inventory), /transfer-archives\/|fixture\.supabase\.co|"receipts"|"generation"|"storage_origin"/);
});
test('verified empty media inventories are explicit export inventories for both empty and nonempty records', async () => {
  for (const fixture of [fixtures.a, fixtures.c]) {
    const hash = (await catalog(fixture)).snapshot_hash;
    assert.deepEqual(await media(hash, fixture), { version: 1, scope: 'site-archives-media', direction: 'export',
      archives_catalog: fixture.catalog, files: [], bound: true, verified: true, transferred: [], checked: [], full_site_complete: false });
  }
});
test('media never promotes an unverified nonempty sidecar even if all individual receipts are checked', async () => isolated(async () => {
  const hash = (await catalog(fixtures.b)).snapshot_hash;
  const state = await sidecarFor(fixtures.b.job);
  assert.ok(Object.values(state.receipts).every(receipt => receipt.checked === true));
  state.verified = false; await setSidecar(fixtures.b.job, state);
  await rejectsAll(fixtures.b, hash, /Verified archive media sidecar is required/);
}));
test('media tuples match existing namespace/event/ref-key read authorization, with no actual Storage access', async () => {
  const hash = (await catalog(fixtures.b)).snapshot_hash;
  const inventory = await media(hash, fixtures.b);
  for (const ref of inventory.files) {
    const authorized = await readRpc('employee_transfer_archive_media_read_authorize', { ...argsFor(fixtures.b),
      p_event_id: ref.event_id, p_ref_key: ref.ref_key }, 'service_role');
    assert.deepEqual(authorized.file, ref.file); assert.equal(authorized.key, ref.key);
    assert.equal(authorized.source_url, ref.source_url); assert.equal(authorized.bucket, ref.bucket);
    assert.equal(authorized.path, `transfer-archives/${fixtures.b.job}/${ref.key}`);
    assert.notEqual(ref.path, authorized.path);
  }
});
test('media requires all four exact binding arguments and accepts no caller-supplied Storage path', async () => {
  const signature = `public.${PREFIX}media(uuid,uuid,uuid,text)`;
  const p = (await db.query('SELECT proargnames,pronargs,pronargdefaults FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0];
  assert.deepEqual(p.proargnames, ['p_admin_session_token', 'p_source_site_id', 'p_package_id', 'p_snapshot_hash']);
  assert.equal(p.pronargs, 4); assert.equal(p.pronargdefaults, 0);
  await assert.rejects(readRpc(`${PREFIX}media`, argsFor(fixtures.b)), /does not exist/);
  await assert.rejects(db.query(`SELECT public.get_employee_archive_reexport_media(p_admin_session_token=>$1::uuid,
    p_source_site_id=>$2::uuid,p_package_id=>$3::uuid,p_snapshot_hash=>$4::text,p_path=>$5::text)`,
  [session, fixtures.b.site, fixtures.b.pkg, (await catalog(fixtures.b)).snapshot_hash, 'untrusted/target/path']), /does not exist/);
});
test('media resolves the same latest job and id tie-break as its snapshot, not an older sidecar', async () => isolated(async () => {
  const before = await catalog(fixtures.b);
  await cloneJob(fixtures.b, id(50), '2024-01-03');
  const state = await sidecarFor(id(50));
  state.files[0].sha256 = sha('newer-job-tuple'); state.receipts[state.refs[0].key].file = state.files[0];
  await setSidecar(id(50), state);
  const newer = await catalog(fixtures.b); await rejectsSnapshot(before.snapshot_hash, fixtures.b);
  assert.equal((await media(newer.snapshot_hash, fixtures.b)).files[0].file.sha256, sha('newer-job-tuple'));
  await cloneJob(fixtures.b, id(51), '2024-01-03');
  assert.deepEqual(await catalog(fixtures.b), newer);
  assert.equal((await media(newer.snapshot_hash, fixtures.b)).files[0].file.sha256, sha('newer-job-tuple'));
  await cloneJob(fixtures.b, id(49), '2024-01-03');
  const smallerId = await catalog(fixtures.b); await rejectsSnapshot(newer.snapshot_hash, fixtures.b);
  assert.equal((await media(smallerId.snapshot_hash, fixtures.b)).files[0].file.sha256, sha('synthetic-png'));
  await cloneJob(fixtures.b, id(52), '2024-01-04');
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_restore,records_verified}','false') WHERE id=$1`, [id(52)]);
  assert.deepEqual(await catalog(fixtures.b), smallerId);
  assert.equal((await media(smallerId.snapshot_hash, fixtures.b)).files[0].file.sha256, sha('synthetic-png'));
}));
test('all six original source_line tables survive byte-exact numeric/microsecond/null NDJSON export', async () => {
  const { snapshot_hash: hash } = await catalog();
  for (const key of TABLES) {
    const result = await page(hash, key);
    assert.deepEqual(Object.keys(result).sort(), ['count', 'ndjson', 'next_after', 'sha256', 'table_key']);
    assert.equal(result.table_key, key); assert.equal(result.ndjson, fixtures.a.texts[key]);
    assert.equal(result.count, lines(fixtures.a.texts[key]).length); assert.equal(result.sha256, sha(result.ndjson));
    assert.equal(result.next_after, null);
  }
  const events = (await page(hash)).ndjson;
  assert.ok(events.includes(PRECISE)); assert.ok(events.includes(TIME)); assert.ok(events.includes('来源甲'));
  assert.ok(events.includes('"before_data_sql_null":true')); assert.ok(events.includes('"before_data_sql_null":false'));
  assert.ok(events.includes('"before_data":null')); assert.ok(events.includes('"id" : '));
  assert.ok((await page(hash, TABLES[4])).ndjson.includes('0.00000000000000000001'));
  assert.ok((await page(hash, TABLES[4])).ndjson.includes('"9223372036854775807"'));
  assert.deepEqual(await verify(hash), RECEIPT, 'media_pending=true is only the SQL33 record receipt');
});
test('multiple sites/packages and identical UUIDs remain isolated without any namespace being skipped', async () => {
  const listed = await readRpc('get_employee_transferred_archive_namespaces', { p_admin_session_token: session });
  assert.equal(listed.items.length, 3);
  const hashes = new Set();
  for (const fixture of [fixtures.a, fixtures.b, fixtures.c]) {
    assert.ok(listed.items.some(n => n.source_site_id === fixture.site && n.package_id === fixture.pkg));
    const result = await catalog(fixture); hashes.add(result.snapshot_hash); assert.deepEqual(result.catalog, fixture.catalog);
    for (const key of TABLES) assert.equal((await page(result.snapshot_hash, key, fixture)).ndjson, fixture.texts[key]);
    assert.deepEqual(await verify(result.snapshot_hash, fixture), RECEIPT);
  }
  assert.equal(hashes.size, 3);
  await rejectsSnapshot((await catalog()).snapshot_hash, fixtures.b);
  await rejectsSnapshot((await catalog()).snapshot_hash, fixtures.c);
  assert.equal(await scalar(db, 'SELECT count(*)::integer FROM public.users WHERE id=$1', [id(13)]), 0);
});
test('empty namespace requires a verified empty sidecar and returns all six empty pages', async () => {
  const { snapshot_hash: hash } = await catalog(fixtures.c);
  assert.deepEqual(await sidecarFor(fixtures.c.job), { version: 1, refs: [], files: [], receipts: {}, verified: true });
  for (const key of TABLES) assert.deepEqual(await page(hash, key, fixtures.c), { table_key: key, count: 0, ndjson: '', next_after: null, sha256: sha('') });
  assert.deepEqual(await verify(hash, fixtures.c), RECEIPT);
  await assert.rejects(page(hash, TABLES[0], fixtures.c, { p_after: id(1000) }), /cursor is not canonical/);
});
for (const [name, args] of [['missing site', { p_source_site_id: null }], ['missing package', { p_package_id: null }],
  ['unknown site', { p_source_site_id: id(999) }], ['unknown package', { p_package_id: id(999) }]])
  test(`all RPCs reject ${name}`, async () => rejectsAll(fixtures.a, 'a'.repeat(64), /namespace/, args));
for (const flag of [false, null, 'true']) test(`records_verified=${JSON.stringify(flag)} cannot authorize a namespace`, async () => isolated(async () => {
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_restore,records_verified}',$2::jsonb) WHERE id=$1`, [fixtures.a.job, JSON.stringify(flag)]);
  await rejectsAll(fixtures.a, 'a'.repeat(64), /Verified archive namespace is required/);
}));
for (const [name, value] of [['absent', undefined], ['null', null], ['false', false], ['string', 'true'], ['bare true', true]])
  test(`even zero files reject ${name} media sidecar verification`, async () => isolated(async () => {
    const hash = (await catalog(fixtures.c)).snapshot_hash;
    if (value === undefined) await db.query(`UPDATE private.employee_transfer_jobs SET summary=summary-'archives_media' WHERE id=$1`, [fixtures.c.job]);
    else if (value === true) await setSidecar(fixtures.c.job, { verified: true });
    else { const state = await sidecarFor(fixtures.c.job); state.verified = value; await setSidecar(fixtures.c.job, state); }
    await rejectsAll(fixtures.c, hash, /sidecar|required|binding changed/);
  }));
for (const [name, mutate] of [
  ['version', s => { s.version = 2; }], ['missing refs', s => { delete s.refs; }],
  ['extra refs', s => { s.refs.push({ key: 'unbound' }); }], ['missing files', s => { s.files = null; }],
  ['extra files', s => { s.files.push({ key: 'unbound' }); }], ['extra receipt', s => { s.receipts.unbound = {}; }],
  ['missing receipt', s => { delete s.receipts[s.refs[0].key]; }],
  ['unchecked receipt', s => { Object.values(s.receipts)[0].checked = false; }],
  ['generation', s => { Object.values(s.receipts)[0].generation = 'a'.repeat(64); }],
  ['cross-job path', s => { Object.values(s.receipts)[0].path = `transfer-archives/${id(999)}/${s.refs[0].key}`; }],
  ['receipt tuple', s => { Object.values(s.receipts)[0].file.sha256 = 'b'.repeat(64); }],
  ['reference event', s => { s.refs[0].event_id = id(999); }],
  ['origin', s => { Object.values(s.receipts)[0].storage_origin = 'https://outside.invalid'; }],
  ['file bytes limit', s => { s.files[0].bytes = 52428801; }],
  ['unreviewed field', s => { s.unreviewed = true; }],
]) test(`all RPCs revalidate full nonempty sidecar: ${name}`, async () => isolated(async () => {
  const hash = (await catalog(fixtures.b)).snapshot_hash;
  const state = await sidecarFor(fixtures.b.job); mutate(state); await setSidecar(fixtures.b.job, state);
  await rejectsAll(fixtures.b, hash, /Archive|archive/);
}));
for (const [name, mutate] of [
  ['Storage origin', s => { for (const r of Object.values(s.receipts)) r.storage_origin = 'https://other-fixture.supabase.co'; }],
  ['file hash', s => { s.files[0].sha256 = sha('other-file'); s.receipts[s.refs[0].key].file = s.files[0]; }],
  ['file size', s => { s.files[0].bytes++; s.receipts[s.refs[0].key].file = s.files[0]; }],
  ['content type', s => { s.files[0].content_type = 'image/jpeg'; s.receipts[s.refs[0].key].file = s.files[0]; }],
]) test(`snapshot binds valid but changed full sidecar ${name}`, async () => isolated(async () => {
  const before = await catalog(fixtures.b);
  const state = await sidecarFor(fixtures.b.job); mutate(state); await setSidecar(fixtures.b.job, state);
  const changed = await catalog(fixtures.b);
  assert.deepEqual(changed.catalog, before.catalog); assert.notEqual(changed.snapshot_hash, before.snapshot_hash);
  await rejectsSnapshot(before.snapshot_hash, fixtures.b); assert.deepEqual(await verify(changed.snapshot_hash, fixtures.b), RECEIPT);
}));
for (const [name, sql] of [
  ['raw line only', `source_line=replace(source_line,'来源甲','漂移甲')`],
  ['body only', `body=jsonb_set(body,'{employee_account}','"changed"')`],
  ['same-count body and line', `source_line=replace(source_line,'来源甲','漂移甲'),body=replace(source_line,'来源甲','漂移甲')::jsonb`],
]) test(`stale verified records fail closed on ${name} drift`, async () => isolated(async () => {
  const hash = (await catalog()).snapshot_hash;
  await db.query(`UPDATE private.employee_transfer_archive_records SET ${sql} WHERE source_site_id=$1 AND package_id=$2 AND table_key=$3`, [fixtures.a.site, fixtures.a.pkg, TABLES[0]]);
  await rejectsAll(fixtures.a, hash, /namespace changed|records differ|raw lines differ/);
}));
for (const name of ['missing row', 'extra row']) test(`persisted verification rejects ${name}`, async () => isolated(async () => {
  const hash = (await catalog()).snapshot_hash;
  if (name === 'missing row') await db.query('DELETE FROM private.employee_transfer_archive_records WHERE source_site_id=$1 AND package_id=$2 AND table_key=$3', [fixtures.a.site, fixtures.a.pkg, TABLES[5]]);
  else await db.query(`INSERT INTO private.employee_transfer_archive_records SELECT source_site_id,package_id,table_key,$3,
    jsonb_set(body,'{id}',to_jsonb($3::text)),replace(source_line,source_id,$3),job_id,imported_at FROM private.employee_transfer_archive_records
    WHERE source_site_id=$1 AND package_id=$2 AND table_key='content_audit_events' LIMIT 1`, [fixtures.a.site, fixtures.a.pkg, id(999)]);
  await rejectsAll(fixtures.a, hash, /namespace changed|records differ/);
}));
test('reverified raw whitespace drift changes namespace/catalog fingerprint without JSON reserialization', async () => isolated(async () => {
  const before = await catalog();
  await db.query(`UPDATE private.employee_transfer_archive_records SET source_line=replace(source_line,'"id" : ','"id"  : ')
    WHERE source_site_id=$1 AND package_id=$2 AND table_key=$3`, [fixtures.a.site, fixtures.a.pkg, TABLES[0]]);
  const updatedCatalog = await refreshFixture(fixtures.a);
  const changed = await catalog(); assert.deepEqual(changed.catalog, updatedCatalog); assert.notEqual(changed.snapshot_hash, before.snapshot_hash);
  await rejectsSnapshot(before.snapshot_hash);
  assert.equal((await page(changed.snapshot_hash)).ndjson, fixtures.a.texts[TABLES[0]].replaceAll('"id" : ', '"id"  : '));
}));
test('a newly selected verified job changes snapshot even for identical original catalog/records/empty media', async () => isolated(async () => {
  const before = await catalog(); await cloneJob(fixtures.a, id(50), '2024-01-03');
  const changed = await catalog(); assert.deepEqual(changed.catalog, before.catalog); assert.notEqual(changed.snapshot_hash, before.snapshot_hash);
  await rejectsSnapshot(before.snapshot_hash); assert.deepEqual(await verify(changed.snapshot_hash), RECEIPT);
}));
test('latest-job selection uses SQL34/36 start time DESC and id ASC tie-break, ignores newer unverified jobs', async () => isolated(async () => {
  await cloneJob(fixtures.a, id(50), '2024-01-03'); const newer = await catalog();
  await cloneJob(fixtures.a, id(51), '2024-01-03'); assert.deepEqual(await catalog(), newer);
  await cloneJob(fixtures.a, id(49), '2024-01-03'); const smallerId = await catalog(); assert.notEqual(smallerId.snapshot_hash, newer.snapshot_hash);
  await cloneJob(fixtures.a, id(52), '2024-01-04');
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_restore,records_verified}','false') WHERE id=$1`, [id(52)]);
  assert.deepEqual(await catalog(), smallerId);
}));
test('latest records-verified job with missing media must block, never fall back to older verified media', async () => isolated(async () => {
  const hash = (await catalog()).snapshot_hash; await cloneJob(fixtures.a, id(50), '2024-01-03');
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=summary-'archives_media' WHERE id=$1`, [id(50)]);
  await rejectsAll(fixtures.a, hash, /Verified archive media sidecar is required/);
}));
test('copied job receipt without job-bound plan revalidation is never trusted', async () => isolated(async () => {
  const hash = (await catalog()).snapshot_hash;
  await db.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options,summary,started_at)
    SELECT $1,kind,admin_id,admin_username,'synthetic-copy','cancelled',options,summary,started_at+interval '1 day'
    FROM private.employee_transfer_jobs WHERE id=$2`, [id(50), fixtures.a.job]);
  await rejectsAll(fixtures.a, hash, /Verified archive plan differs/);
}));
for (const hash of [null, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(64), `${'a'.repeat(64)}\n`])
  test(`page, verify and media reject invalid/stale snapshot ${JSON.stringify(hash)}`, async () => rejectsSnapshot(hash));
for (const key of [null, '', 'users', 'content_audit_events; SELECT 1', 'Content_Audit_Events'])
  test(`page rejects unknown table ${JSON.stringify(key)}`, async () => assert.rejects(page((await catalog()).snapshot_hash, key), /Invalid archive re-export page/));
for (const limit of [null, 0, -1, 201, 2147483647])
  test(`page rejects limit ${limit}, never silently clamps`, async () => assert.rejects(page((await catalog()).snapshot_hash, TABLES[0], fixtures.a, { p_limit: limit }), /Invalid archive re-export page/));
for (const cursor of ['', id(999), id(110), id(1000).toUpperCase(), `${id(1000)}\n`, 'x'.repeat(74), `${id(120)}:${id(121)}`])
  test(`page rejects noncanonical/wrong-table cursor ${JSON.stringify(cursor)}`, async () => assert.rejects(page((await catalog()).snapshot_hash, TABLES[0], fixtures.a, { p_after: cursor }), /cursor is not canonical|Invalid archive re-export page/));
test('keyset pages preserve full source lines, canonical last cursor and empty terminal page', async () => {
  const hash = (await catalog()).snapshot_hash;
  const first = await page(hash, TABLES[0], fixtures.a, { p_limit: 2 });
  assert.equal(first.count, 2); assert.equal(first.next_after, id(1001));
  const last = await page(hash, TABLES[0], fixtures.a, { p_limit: 2, p_after: first.next_after });
  assert.equal(last.count, 1); assert.equal(last.next_after, null); assert.equal(first.ndjson + last.ndjson, fixtures.a.texts[TABLES[0]]);
  assert.equal(first.sha256, sha(first.ndjson)); assert.equal(last.sha256, sha(last.ndjson));
  const end = await page(hash, TABLES[0], fixtures.a, { p_after: id(1002) });
  assert.deepEqual(end, { table_key: TABLES[0], count: 0, ndjson: '', next_after: null, sha256: sha('') });
  for (const [key, cursor] of [[TABLES[3], `${id(120)}:${id(121)}`], [TABLES[5], `${id(110)}:${id(111)}`]])
    assert.equal((await page(hash, key, fixtures.a, { p_after: cursor })).count, 0);
});
test('default pages cap at 200 rows and resume without loss or duplication', async () => isolated(async () => {
  const fixture = await seedNamespace({ site: id(23), job: id(60), events: 205 });
  const hash = (await catalog(fixture)).snapshot_hash;
  const first = await page(hash, TABLES[0], fixture); assert.equal(first.count, 200); assert.equal(first.next_after, id(1199));
  assert.ok(Buffer.byteLength(first.ndjson) <= 262144);
  const last = await page(hash, TABLES[0], fixture, { p_after: first.next_after }); assert.equal(last.count, 5); assert.equal(last.next_after, null);
  assert.equal(first.ndjson + last.ndjson, fixture.texts[TABLES[0]]); assert.deepEqual(await verify(hash, fixture), RECEIPT);
}));
test('UTF8 byte-limited pages stop at 256KiB, not character counts, and keep all records', async () => isolated(async () => {
  const fixture = await seedNamespace({ site: id(23), job: id(60), events: 9, padding: '界'.repeat(15000) });
  const hash = (await catalog(fixture)).snapshot_hash; let after = null, combined = '', total = 0, pages = 0;
  do {
    const result = await page(hash, TABLES[0], fixture, { p_after: after }); pages++;
    assert.ok(result.count > 0 && result.count <= 200); assert.ok(Buffer.byteLength(result.ndjson) <= 262144);
    assert.equal(result.sha256, sha(result.ndjson)); total += result.count; combined += result.ndjson; after = result.next_after;
  } while (after !== null);
  assert.ok(pages > 1); assert.equal(total, 9); assert.equal(combined, fixture.texts[TABLES[0]]);
}));
for (const [name, mutate] of [
  ['missing table', c => { c.tables.pop(); }], ['reordered tables', c => { c.tables.reverse(); }],
  ['extra table', c => { c.tables.push(c.tables[0]); }], ['row limit', c => { c.tables[0].rows = 500001; }],
  ['table bytes limit', c => { c.tables[0].bytes = 268435457; }],
  ['total byte limit', c => { for (const t of c.tables) { t.rows = 1; t.bytes = 268435456; } }],
]) test(`no catalog omission or overlimit accepted: ${name}`, async () => isolated(async () => {
  const hash = (await catalog()).snapshot_hash; const c = structuredClone(fixtures.a.catalog); mutate(c);
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(jsonb_set(summary,'{archives_catalog}',$2::jsonb),'{archives_restore,catalog}',$2::jsonb) WHERE id=$1`, [fixtures.a.job, JSON.stringify(c)]);
  await rejectsAll(fixtures.a, hash, /catalog/);
}));
test('inventory contains every verified source/package once, including empty namespaces, in C order with exact JSONB fingerprint', async () => {
  const expected = [];
  for (const fixture of [fixtures.a, fixtures.c, fixtures.b]) expected.push(await catalog(fixture));
  const result = await inventory();
  const namespacesText = await scalar(db, 'SELECT $1::jsonb::text', [JSON.stringify(expected)]);
  assert.deepEqual(result, { scope: 'transferred-archives', namespaces: expected, fingerprint: sha(namespacesText), full_site_complete: false });
  assert.equal(result.namespaces.length, 3); assert.deepEqual(result.namespaces[1].catalog, fixtures.c.catalog);
  assert.deepEqual(await inventory(), result); assert.deepEqual(await inventory({}, 'authenticated'), result);
  assert.equal(await scalar(db, 'SELECT count(*)::integer FROM private.employee_transfer_archive_records WHERE source_site_id=$1 AND package_id=$2', [fixtures.c.site, fixtures.c.pkg]), 0);
});
for (const name of ['no matching verified job', 'only an unverified job'])
  test(`inventory rejects physical archive records with ${name}, rather than returning a partial verified-only list`, async () => isolated(async () => {
    if (name === 'only an unverified job') await seedNamespace({ site: id(23), job: id(60), verified: false });
    else await db.query(`INSERT INTO private.employee_transfer_archive_records
      SELECT $1,$2,table_key,source_id,body,source_line,job_id,imported_at FROM private.employee_transfer_archive_records
      WHERE source_site_id=$3 AND package_id=$4 AND table_key=$5 LIMIT 1`, [id(23), id(32), fixtures.a.site, fixtures.a.pkg, TABLES[0]]);
    assert.equal((await readRpc('get_employee_transferred_archive_namespaces', { p_admin_session_token: session })).items.length, 3,
      'SQL36 reader still omits pending records, but the complete re-export inventory must not');
    await assert.rejects(inventory(), /Verified archive namespace is required/);
  }));
for (const name of ['nonempty records', 'all-empty catalog'])
  test(`inventory rejects the entire response for pending media in ${name}`, async () => isolated(async () => {
    const fixture = name === 'all-empty catalog' ? fixtures.c : fixtures.b;
    const state = await sidecarFor(fixture.job); state.verified = false; await setSidecar(fixture.job, state);
    await assert.rejects(inventory(), /Verified archive media sidecar is required/);
  }));
test('inventory rejects a missing empty sidecar, not just missing attachments on nonempty records', async () => isolated(async () => {
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=summary-'archives_media' WHERE id=$1`, [fixtures.c.job]);
  await assert.rejects(inventory(), /Verified archive media sidecar is required/);
}));
test('inventory returns an authenticated empty imported-only list and never claims native tables are included', async () => isolated(async () => {
  await db.query('DELETE FROM private.employee_transfer_archive_records');
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=summary-'archives_restore' WHERE summary ? 'archives_restore'`);
  // Real local native audit fixture must NOT create an imported namespace.
  await db.query(`INSERT INTO private.content_audit_events(id,operation_id,entity_type,entity_id,action,owner_admin_id,
    actor_admin_id,actor_username,actor_role,media_refs) VALUES($1,$2,'notification',$3,'edit',$4,$4,'archive-reexport-root','super_admin','{}')`,
  [id(900), id(901), id(902), id(1)]);
  const expected = { scope: 'transferred-archives', namespaces: [], fingerprint: sha('[]'), full_site_complete: false };
  assert.deepEqual(await inventory(), expected); assert.deepEqual(await inventory({}, 'authenticated'), expected);
  await assert.rejects(inventory({ p_admin_session_token: null }), /session|permission|administrator/i);
}));
test('inventory fails closed on a verified empty job with an incomplete catalog instead of skipping it', async () => isolated(async () => {
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_restore,catalog,site_id}','null') WHERE id=$1`, [fixtures.c.job]);
  await assert.rejects(inventory(), /namespace/);
}));
test('inventory revalidates record drift in every source, not only the first returned namespace', async () => isolated(async () => {
  await db.query(`UPDATE private.employee_transfer_archive_records SET source_line=replace(source_line,'来源乙','漂移乙')
    WHERE source_site_id=$1 AND package_id=$2 AND table_key=$3`, [fixtures.b.site, fixtures.b.pkg, TABLES[0]]);
  await assert.rejects(inventory(), /namespace changed|records differ|raw lines differ/);
}));
test('inventory fingerprint changes on reverified raw/catalog drift without changing the namespace set', async () => isolated(async () => {
  const before = await inventory();
  await db.query(`UPDATE private.employee_transfer_archive_records SET source_line=replace(source_line,'"id" : ','"id"  : ')
    WHERE source_site_id=$1 AND package_id=$2 AND table_key=$3`, [fixtures.a.site, fixtures.a.pkg, TABLES[0]]);
  await refreshFixture(fixtures.a);
  const changed = await inventory(); assert.equal(changed.namespaces.length, before.namespaces.length);
  assert.notEqual(changed.fingerprint, before.fingerprint); assert.notEqual(changed.namespaces[0].snapshot_hash, before.namespaces[0].snapshot_hash);
  assert.deepEqual(changed.namespaces.slice(1), before.namespaces.slice(1));
}));
test('inventory fingerprint binds complete sidecar drift even when all catalogs and counts are unchanged', async () => isolated(async () => {
  const before = await inventory(); const state = await sidecarFor(fixtures.b.job);
  for (const receipt of Object.values(state.receipts)) receipt.storage_origin = 'https://other-fixture.supabase.co';
  await setSidecar(fixtures.b.job, state);
  const changed = await inventory(); assert.notEqual(changed.fingerprint, before.fingerprint);
  assert.deepEqual(changed.namespaces.map(n => n.catalog), before.namespaces.map(n => n.catalog));
  state.receipts[state.refs[0].key].checked = false; await setSidecar(fixtures.b.job, state);
  await assert.rejects(inventory(), /Verified archive media is incomplete/);
}));
test('inventory deduplicates physical/job namespaces and binds latest-job changes in its whole-list fingerprint', async () => isolated(async () => {
  const before = await inventory(); await cloneJob(fixtures.a, id(50), '2024-01-03');
  const changed = await inventory(); assert.equal(changed.namespaces.length, 3); assert.notEqual(changed.fingerprint, before.fingerprint);
  assert.deepEqual(changed.namespaces[0], await catalog());
  await cloneJob(fixtures.a, id(51), '2024-01-03'); assert.deepEqual(await inventory(), changed);
}));
test('inventory fingerprint detects addition and removal of an all-empty namespace between export passes', async () => isolated(async () => {
  const before = await inventory();
  const added = await seedNamespace({ site: id(19), pkg: id(32), job: id(60), empty: true });
  const changed = await inventory(); assert.equal(changed.namespaces.length, 4); assert.notEqual(changed.fingerprint, before.fingerprint);
  assert.deepEqual(changed.namespaces[0], await catalog(added));
  await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_restore,records_verified}','false') WHERE id=$1`, [added.job]);
  assert.deepEqual(await inventory(), before);
}));
test('inventory accepts exactly 1000 distinct namespaces but explicitly rejects 1001 instead of truncating', async () => isolated(async () => {
  await seedEmptyInventoryNamespaces(997);
  const result = await inventory(); assert.equal(result.namespaces.length, 1000);
  assert.deepEqual(result.namespaces[0], await catalog());
  await seedEmptyInventoryNamespaces(1, 4000);
  await assert.rejects(inventory(), /inventory exceeds 1000 namespaces; no namespace was omitted/);
}));
test('inventory enforces the full 2MiB JSONB response bound without bypassing real SQL33/34/35 validators', async () => isolated(async () => {
  await seedEmptyInventoryNamespaces(200, 2000, 6000);
  const wireText = await scalar(db, 'SELECT public.get_employee_archive_reexport_inventory($1)::text', [session]);
  assert.ok(Buffer.byteLength(wireText) > 1048576); assert.ok(Buffer.byteLength(wireText) <= 2097152);
  assert.equal(JSON.parse(wireText).namespaces.length, 203);
  await seedEmptyInventoryNamespaces(150, 3000, 6000);
  await assert.rejects(inventory(), /inventory exceeds 2 MiB; no namespace was omitted/);
}));
test('SQL33 native-export migration body and previously-transferred-record blocker remain unchanged', async () => {
  await assert.rejects(db.query('SELECT private.employee_transfer_archives_catalog($1)', [id(999)]), /Previously transferred archive snapshots require a namespace-preserving re-export protocol/);
  const sql38 = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8');
  assert.doesNotMatch(sql38, /CREATE\s+OR\s+REPLACE|ALTER\s+TABLE|UPDATE\s+private\.|INSERT\s+INTO|DELETE\s+FROM/i);
});
async function databaseState() {
  // Compare all ordinary public/private tables, not only records/jobs: catch session,
  // heartbeat, audit, permits, financial/queue or maintenance writes from any RPC.
  const { rows } = await db.query(`SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind='r' ORDER BY n.nspname,c.relname`);
  const state = {};
  for (const row of rows) {
    const relation = `"${row.schema.replaceAll('"', '""')}"."${row.name.replaceAll('"', '""')}"`;
    state[relation] = await scalar(db, `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),'[]') FROM ${relation} t`);
  }
  state.sequences = await scalar(db, `SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY schemaname,sequencename),'[]') FROM pg_sequences s WHERE schemaname IN ('public','private')`);
  return state;
}
test('expired/cancelled/abandoned historical jobs read in READ ONLY, no staging/live accounts or write side effects', async () => {
  const before = await databaseState();
  assert.equal(await scalar(db, 'SELECT count(*)::integer FROM private.employee_transfer_staging'), 0);
  const hash = (await catalog()).snapshot_hash;
  // Successful default calls commit, so a before/after comparison can see effects.
  await page(hash); await verify(hash); await media(hash);
  const wholeInventory = await inventory();
  const nonemptyHash = (await catalog(fixtures.b)).snapshot_hash;
  await media(nonemptyHash, fixtures.b);
  await db.exec('BEGIN READ ONLY'); inside = true;
  try {
    assert.deepEqual(await inventory(), wholeInventory);
    for (const fixture of [fixtures.a, fixtures.b, fixtures.c]) {
      const result = await catalog(fixture);
      for (const key of TABLES) assert.equal((await page(result.snapshot_hash, key, fixture)).ndjson, fixture.texts[key]);
      assert.deepEqual(await verify(result.snapshot_hash, fixture), RECEIPT);
      const inventory = await media(result.snapshot_hash, fixture);
      assert.equal(inventory.verified, true); assert.deepEqual(inventory.archives_catalog, fixture.catalog);
    }
  } finally { inside = false; await db.exec('ROLLBACK'); }
  assert.deepEqual(await databaseState(), before);
});
test('historical job lifecycle/owner metadata changes do not expire or mutate a stable archive snapshot', async () => isolated(async () => {
  const before = await catalog(fixtures.b);
  const mediaInventory = await media(before.snapshot_hash, fixtures.b);
  const wholeInventory = await inventory();
  for (const status of ['abandoned', 'cancelled', 'finished']) {
    await db.query(`UPDATE private.employee_transfer_jobs SET status=$2,admin_id=$3,last_activity_at='2020-01-01',finished_at='2020-01-02' WHERE id=$1`, [fixtures.b.job, status, id(2)]);
    assert.deepEqual(await catalog(fixtures.b), before); assert.deepEqual(await verify(before.snapshot_hash, fixtures.b), RECEIPT);
    assert.deepEqual(await media(before.snapshot_hash, fixtures.b), mediaInventory);
    assert.deepEqual(await inventory(), wholeInventory);
  }
}));
