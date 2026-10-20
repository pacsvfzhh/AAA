import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, before, mock, test } from 'node:test';
import { replayMigrations } from './support/replay-migrations.mjs';
import { adminLogin, rpc, scalar } from './support/transfer-harness.mjs';

// Independent local SQL36 reader layer. Synthetic persisted job/catalog fixtures,
// real SQL33/34 validator and auth, no stubbed verifier and no claim of an end-to-end import.
const TABLES = ['content_audit_events', 'deleted_employee_accounts', 'deleted_employee_notifications',
  'content_audit_recipient_versions', 'deleted_employee_summaries', 'deleted_employee_withdrawals'];
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = text => createHash('sha256').update(text).digest('hex');
const PRECISE = '12345678901234567890.12345678901234567890';
const MIGRATION = '20261102000036_list_transferred_archives.sql';
let db, session, branch, emergency, replay;
const tokens = {};
function rawRows() {
  return {
    content_audit_events: [1, 2, 3].map(n => JSON.stringify({ id: id(100 + n), operation_id: id(10), entity_type: 'notification', entity_id: id(11),
      action: 'edit', owner_admin_id: id(12), owner_username: 'source-owner', actor_admin_id: null, actor_username: 'source-actor', actor_role: 'super_admin',
      customer_id: null, employee_id: id(13), occurred_at: '2024-02-29T23:34:56.123456Z', before_data: null, after_data: { old: '<script>not executable</script>' },
      media_refs: {}, clear_reason: null, clear_started_at: null, cleared_at: null, cleared_by: null, cleared_username: null, employee_account: 'source-only',
      message_created_at: null, before_data_sql_null: true, after_data_sql_null: false }) + '\n').join(''),
    deleted_employee_accounts: '', deleted_employee_notifications: '', content_audit_recipient_versions: '',
    deleted_employee_summaries: `{"id":"${id(110)}","employee_id":"${id(13)}","source_present":false,"is_verified":null,"total_income":${PRECISE},"available_balance":null,"frozen_balance":0.00000000000000000001,"total_orders":"9223372036854775807"}\n`,
    deleted_employee_withdrawals: `{"id":"${id(110)}:${id(111)}","record_id":"${id(110)}","withdrawal_id":"${id(111)}","employee_id":"${id(13)}","amount":${PRECISE},"status":"approved","created_at":"2024-02-29T23:34:56.123456Z"}\n`,
  };
}
async function seedNamespace({ site = id(20), pkg = id(30), job = id(40), media, verified = true, started = '2024-01-01T00:00:00Z', empty = false } = {}) {
  const texts = empty ? Object.fromEntries(TABLES.map(key => [key, ''])) : rawRows();
  const catalog = { version: 1, scope: 'site-archives', site_id: site, package_id: pkg, full_site_complete: false,
    tables: TABLES.map(key => ({ key, rows: texts[key] ? texts[key].split('\n').length - 1 : 0,
      bytes: Buffer.byteLength(texts[key]), row_hashes_sha256: sha((texts[key].match(/[^\n]*\n/g) ?? []).map(sha).join('')) })) };
  const counts = Object.fromEntries(catalog.tables.map(t => [t.key, t.rows]));
  const plan = { scope: 'site-archives', checked: true, can_restore: true, counts, conflicts: [], media_pending: true,
    maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
  await db.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options,summary,started_at,finished_at)
    VALUES($1,'import',$2,'archive-reader-root','synthetic-local-token-hash','cancelled',$3::jsonb,'{}',$4,'2024-01-02T00:00:00Z')`,
  [job, id(1), JSON.stringify({ import_protocol: 'dispatch-submission-v1', package_id: pkg, catalog: { site_id: site } }), started]);
  for (const key of TABLES) for (const sourceLine of texts[key].match(/[^\n]*\n/g) ?? []) {
    await db.query(`INSERT INTO private.employee_transfer_archive_records(source_site_id,package_id,table_key,source_id,body,source_line,job_id,imported_at)
      VALUES($1,$2,$3,$4,$5::text::jsonb,$5::text,$6,'2024-02-29T23:34:56.123456Z')`, [site, pkg, key, JSON.parse(sourceLine).id, sourceLine, job]);
  }
  const namespaceHash = await scalar(db, 'SELECT private.employee_transfer_archives_namespace_hash($1,$2)', [site, pkg]);
  const chunks = Object.fromEntries(TABLES.map(key => [key, 1]));
  const state = { catalog, plan_hash: '', plan, initial_namespace_hash: sha(''), namespace_hash: namespaceHash,
    chunks, completed_chunks: chunks, records_verified: verified };
  state.plan_hash = await scalar(db, `SELECT encode(extensions.digest(convert_to(jsonb_build_object('job_id',$1::uuid,'catalog',$2::jsonb,
    'namespace_hash',$3::text,'plan',$4::jsonb)::text,'UTF8'),'sha256'),'hex')`, [job, JSON.stringify(catalog), sha(''), JSON.stringify(plan)]);
  const summary = { archives_catalog: catalog, archives_restore: state, ...(media === undefined ? {} : { archives_media: { verified: media } }) };
  await db.query('UPDATE private.employee_transfer_jobs SET summary=$2::jsonb WHERE id=$1', [job, JSON.stringify(summary)]);
  if (verified) await db.query('SELECT private.employee_transfer_archives_persisted(j) FROM private.employee_transfer_jobs j WHERE j.id=$1', [job]);
  return { site, pkg, job, texts, counts };
}
let inside = false;
async function readRpc(name, args, role = 'anon') {
  // The shared helper's RESET ROLE in finally masks errors in an aborted transaction.
  // A local savepoint restores both role and transaction without masking the RPC error.
  const owned = !inside;
  if (owned) await db.exec('BEGIN');
  await db.exec('SAVEPOINT reader_call');
  try {
    assert.ok(['anon', 'authenticated'].includes(role));
    await db.exec(`SET LOCAL ROLE ${role}`);
    return await rpc(db, name, args, { role: null });
  } finally {
    await db.exec('ROLLBACK TO reader_call; RELEASE reader_call');
    if (owned) await db.exec('ROLLBACK');
  }
}
const list = (args = {}, role = 'anon') => readRpc('get_employee_transferred_archive_namespaces', { p_admin_session_token: session, ...args }, role);
const page = (key, args = {}) => readRpc('get_employee_transferred_archive_page', { p_admin_session_token: session,
  p_source_site_id: id(20), p_package_id: id(30), p_table_key: key, ...args });
async function isolated(fn) {
  await db.exec('BEGIN'); inside = true;
  try { await fn(); } finally { inside = false; await db.exec('ROLLBACK'); }
}
before(async () => {
  mock.method(globalThis, 'fetch', () => assert.fail('All production/network/Storage requests forbidden'));
  replay = await replayMigrations({ upTo: '20261102000034_restore_readonly_archives.sql', strict: true }); db = replay.db;
  await db.exec(await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8'));
  for (const [n, name, role] of [[1, 'archive-reader-root', 'super_admin'], [2, 'archive-reader-branch', 'secondary_admin'], [3, 'archive-reader-emergency', 'emergency_admin']]) {
    await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active) VALUES($1,$2,extensions.crypt('Synthetic-123',extensions.gen_salt('bf',4)),$3,true)`, [id(n), name, role]);
    await db.query(`INSERT INTO public.financial_admin_credentials(admin_id,password_hash) VALUES($1,extensions.crypt('Synthetic-123',extensions.gen_salt('bf',4)))`, [id(n)]);
    tokens[name] = await adminLogin(db, name, 'Synthetic-123');
  }
  session = tokens['archive-reader-root']; branch = tokens['archive-reader-branch']; emergency = tokens['archive-reader-emergency'];
  await seedNamespace();
  await seedNamespace({ site: id(20), pkg: id(31), job: id(41), media: true });
  await seedNamespace({ site: id(21), pkg: id(1), job: id(42), empty: true });
  await seedNamespace({ site: id(19), pkg: id(1), job: id(43), verified: false });
  await db.query(`UPDATE private.employee_transfer_jobs SET status='abandoned',last_activity_at='2024-01-01' WHERE id=$1`, [id(41)]);
}, { timeout: 120000 });
after(async () => { await db?.close(); mock.restoreAll(); });

test('SQL36 installs over strict historical replay with the known 12 old failures unchanged', () => {
  assert.equal(replay.failures.length, 12); assert.equal(replay.files.at(-1), '20261102000034_restore_readonly_archives.sql');
});
test('RPC is STABLE SECURITY DEFINER with fixed search_path, explicit anon/authenticated-only privileges', async () => {
  const { rows: [p] } = await db.query(`SELECT provolatile,prosecdef,proconfig,proacl::text FROM pg_proc WHERE oid='public.get_employee_transferred_archive_namespaces(uuid,text,integer)'::regprocedure`);
  assert.equal(p.provolatile, 's'); assert.equal(p.prosecdef, true); assert.ok(p.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
  for (const [role, allowed] of [['anon', true], ['authenticated', true], ['service_role', false]]) assert.equal(await scalar(db,
    `SELECT has_function_privilege($1,'public.get_employee_transferred_archive_namespaces(uuid,text,integer)','EXECUTE')`, [role]), allowed);
  assert.doesNotMatch(p.proacl, /(?:^|,)=[^,]*X/);
  assert.equal(await scalar(db, `SELECT has_table_privilege('anon','private.employee_transfer_archive_records','SELECT')`), false);
  assert.equal(await scalar(db, `SELECT has_function_privilege('anon','private.employee_transfer_archives_persisted(private.employee_transfer_jobs)','EXECUTE')`), false);
});
for (const tokenName of ['missing', 'random', 'branch', 'emergency', 'revoked', 'expired']) test(`namespace and raw-page RPC deny ${tokenName} session`, async () => {
  let token = ({ missing: null, random: id(999), branch, emergency })[tokenName] ?? session;
  if (tokenName === 'missing') token = null;
  await isolated(async () => {
    if (tokenName === 'revoked') await db.query('UPDATE public.admin_financial_sessions SET revoked_at=now() WHERE admin_id=$1', [id(1)]);
    if (tokenName === 'expired') await db.query(`UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 day' WHERE admin_id=$1`, [id(1)]);
    await db.exec('SAVEPOINT deny_list');
    await assert.rejects(list({ p_admin_session_token: token }), /session|permission|administrator/i); await db.exec('ROLLBACK TO deny_list');
    await assert.rejects(page(TABLES[0], { p_admin_session_token: token }), /session|permission|administrator/i);
  });
});
test('namespace list uses C site:package keyset ordering, complete six-count inventory, real import time and strict media boolean', async () => {
  const first = await list({ p_limit: 1 }); assert.equal(first.items.length, 1);
  assert.equal(first.next_after, `${id(20)}:${id(30)}`); assert.equal(first.items[0].media_pending, true);
  assert.match(first.items[0].imported_at, /^2024-02-29T23:34:56\.123456/);
  assert.deepEqual(first.items[0].counts, { content_audit_events: 3, deleted_employee_accounts: 0, deleted_employee_notifications: 0,
    content_audit_recipient_versions: 0, deleted_employee_summaries: 1, deleted_employee_withdrawals: 1 });
  const second = await list({ p_after: first.next_after, p_limit: 1 }); assert.equal(second.items[0].package_id, id(31)); assert.equal(second.items[0].media_pending, false);
  const third = await list({ p_after: second.next_after, p_limit: 1 }); assert.equal(third.items[0].source_site_id, id(21)); assert.equal(third.next_after, null);
  const end = await list({ p_after: `${id(21)}:${id(1)}` }); assert.deepEqual(end, { items: [], next_after: null });
  assert.equal((await list({}, 'authenticated')).items.length, 3);
});
for (const args of [{ p_limit: 0 }, { p_limit: 101 }, { p_limit: null }, { p_after: '' }, { p_after: `${id(20)}:${id(30)}\n` }, { p_after: 'x'.repeat(1000) }]) {
  test(`namespace pagination rejects ${JSON.stringify(args)}`, async () => { await assert.rejects(list(args), /Invalid transferred archive namespace page/); });
}
test('unverified namespaces are excluded, latest verified matching job is deduplicated, malformed media flag remains pending', async () => {
  assert.equal((await list()).items.some(item => item.source_site_id === id(19)), false);
  await isolated(async () => {
    await db.query(`INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options,summary,started_at)
      SELECT $1,kind,admin_id,admin_username,'synthetic-duplicate','abandoned',options,
        jsonb_set(summary,'{archives_media}','{"verified":"true"}'::jsonb),started_at+interval '1 day'
      FROM private.employee_transfer_jobs WHERE id=$2`, [id(50), id(41)]);
    // SQL34's plan hash is job-bound; an identical copied receipt must NOT become trusted.
    await assert.rejects(list(), /Verified archive plan differs/);
    await db.query(`UPDATE private.employee_transfer_jobs j SET summary=jsonb_set(summary,'{archives_restore,plan_hash}',
      to_jsonb(encode(extensions.digest(convert_to(jsonb_build_object('job_id',j.id,'catalog',summary#>'{archives_restore,catalog}',
        'namespace_hash',summary#>>'{archives_restore,initial_namespace_hash}','plan',summary#>'{archives_restore,plan}')::text,'UTF8'),'sha256'),'hex')))
      WHERE id=$1`, [id(50)]);
    const items = (await list()).items; assert.equal(items.length, 3);
    assert.equal(items[1].media_pending, true, 'latest verified job wins, with a strict boolean media gate');
  });
  await isolated(async () => {
    await db.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_media}','{"verified":"true"}'::jsonb) WHERE id=$1`, [id(41)]);
    const items = (await list()).items; assert.equal(items.length, 3); assert.equal(items[1].media_pending, true);
  });
});
test('namespace and page fail closed when raw records drift despite a stale verified flag', async () => {
  await isolated(async () => {
    await db.query(`UPDATE private.employee_transfer_archive_records SET source_line=replace(source_line,'source-only','changed') WHERE source_site_id=$1 AND package_id=$2 AND table_key=$3`, [id(20), id(30), TABLES[0]]);
    await db.exec('SAVEPOINT drift'); await assert.rejects(list(), /namespace changed|records differ|raw lines differ/); await db.exec('ROLLBACK TO drift');
    await assert.rejects(page(TABLES[0]), /namespace changed|records differ|raw lines differ/);
  });
});
test('raw pages preserve numeric precision, bigint strings, microseconds and SQL-null markers across keyset pagination', async () => {
  const first = await page(TABLES[0], { p_limit: 2 }); assert.equal(first.count, 2); assert.equal(first.next_after, id(102)); assert.equal(first.sha256, sha(first.ndjson));
  assert.ok(first.ndjson.includes('"before_data_sql_null":true')); assert.ok(first.ndjson.includes('23:34:56.123456Z'));
  const last = await page(TABLES[0], { p_limit: 2, p_after: first.next_after }); assert.equal(last.count, 1); assert.equal(last.next_after, null);
  assert.equal(first.ndjson + last.ndjson, rawRows().content_audit_events);
  for (const key of [TABLES[4], TABLES[5]]) { const result = await page(key); assert.ok(result.ndjson.includes(PRECISE)); assert.equal(result.ndjson, rawRows()[key]); }
  await assert.rejects(page(TABLES[0], { p_after: id(999) }), /cursor is not canonical/);
});
test('verified namespaces and all six raw tables remain readable in READ ONLY after cancellation, expiry and removal of staging', async () => {
  const before = await scalar(db, `SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM private.employee_transfer_jobs j`);
  await db.exec('BEGIN READ ONLY'); inside = true;
  try {
    assert.equal((await list()).items.length, 3);
    for (const key of TABLES) assert.equal((await page(key)).ndjson, rawRows()[key]);
  } finally { inside = false; await db.exec('ROLLBACK'); }
  assert.equal(await scalar(db, 'SELECT count(*)::integer FROM private.employee_transfer_staging'), 0);
  assert.deepEqual(await scalar(db, `SELECT jsonb_agg(to_jsonb(j) ORDER BY j.id) FROM private.employee_transfer_jobs j`), before);
  assert.equal(await scalar(db, `SELECT count(*)::integer FROM public.users WHERE id=$1`, [id(13)]), 0, 'source identities need no target live user');
});
