import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { replayMigrations, EXPECTED_REPLAY_FAILURES } from './support/replay-migrations.mjs';
import { adminLogin, rpc as baseRpc, rows, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Synthetic receipts cannot prove Storage/native PostgreSQL acceptance.
const PREVIOUS = '20261102000046_backup_employee_before_restore.sql';
const MIGRATION = '20261102000047_backup_employee_media.sql';
const INVENTORY = 'get_employee_safety_backup_media', VERIFY = 'employee_safety_backup_media_verify';
const AUTHORIZE = 'employee_safety_backup_media_authorize', COMMIT = 'employee_safety_backup_media_commit';
const id = n => `47000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TARGET = id(1), FOREIGN = id(2), OTHER_ROOT = id(3);
const ORIGIN = 'https://local-safety.supabase.co', OTHER_ORIGIN = 'https://other-safety.supabase.co';
const url = (bucket, path, origin = ORIGIN) => `${origin}/storage/v1/object/public/${bucket}/${path}`;
const CHAT_URL = url('chat-images', 'shared/photo.png');
const AVATAR = url('super-customer-avatars', 'avatars/role.png');
const DOC = url('verification-documents', `id-front/${TARGET}-front.png`);
const EVIDENCE_KEY = 'https://foreign.invalid/opaque?not=a-fetch-destination%2F';
const sha = value => createHash('sha256').update(value).digest('hex');
const html = value => `<p>原文</p><img src="${value}">`;
const auth = (job, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
const bound = (job, token) => ({ ...auth(job, token), p_catalog_fingerprint: job.catalog.fingerprint });
const flags = result => {
  for (const key of ['complete_employee_backup', 'can_archive', 'can_replace', 'full_site_complete']) assert.equal(result[key], false, key);
};
let db, replay, session, secondary, otherRoot, employeeToken, beforeDefinitions, beforeTables;
let sequence = 0, networkCalls = 0;
async function transaction(fn, readOnly = false) {
  await db.exec(readOnly ? 'BEGIN; SET TRANSACTION READ ONLY' : 'BEGIN');
  try { return await fn(); } finally { await db.exec('ROLLBACK'); }
}
async function isolated(fn) {
  const point = `media_isolated_${++sequence}`; await db.exec(`SAVEPOINT ${point}`);
  try { return await fn(); } finally { await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); }
}
async function rpc(name, args, role = 'anon') {
  const point = `media_rpc_${++sequence}`; await db.exec(`SAVEPOINT ${point}`);
  try {
    assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
    await db.exec(`SET LOCAL ROLE ${role}`);
    const result = await baseRpc(db, name, args, { role: null });
    await db.exec(`RESET ROLE; RELEASE SAVEPOINT ${point}`); return result;
  } catch (error) {
    await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); throw error;
  }
}
// Restore trigger modes so fixtures cannot weaken the guards.
async function change(relation, sql, params = []) {
  const point = `media_fixture_${++sequence}`; await db.exec(`SAVEPOINT ${point}`);
  try {
    const modes = await rows(db, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
    for (const t of modes) await db.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
    await db.query(sql, params);
    for (const t of modes) await db.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`);
    await db.exec(`RELEASE SAVEPOINT ${point}`);
  } catch (error) {
    await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`); throw error;
  }
}
const begin = () => rpc('employee_safety_backup_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_username: 'media-target' });
const inventory = job => rpc(INVENTORY, bound(job));
const verify = job => rpc(VERIFY, bound(job));
const authorize = (job, ref, action = 'download', token = session) => rpc(AUTHORIZE, { ...auth(job, token), p_action: action, p_object_key: ref.key }, 'service_role');
const commitArgs = (job, ref, action = 'download', extra = {}) => ({ ...auth(job), p_action: action, p_object_key: ref.key,
  p_bytes: 128, p_sha256: sha(ref.key), p_content_type: 'image/png', p_storage_origin: ORIGIN, p_generation: job.catalog.fingerprint, ...extra });
const commit = (job, ref, action = 'download', extra = {}) => rpc(COMMIT, commitArgs(job, ref, action, extra), 'service_role');
const jobRow = job => scalar(db, 'SELECT to_jsonb(j) FROM private.employee_transfer_jobs j WHERE id=$1', [job.job_id]);
const rawSidecar = job => scalar(db, "SELECT summary->'employee_safety_media' FROM private.employee_transfer_jobs WHERE id=$1", [job.job_id]);
const definitions = () => rows(db, `SELECT p.oid::text AS oid,pg_get_functiondef(p.oid) AS definition,p.proacl::text AS acl
  FROM pg_proc p WHERE p.pronamespace IN ('public'::regnamespace,'private'::regnamespace) ORDER BY p.oid`);
const tables = () => rows(db, `SELECT c.oid::text AS oid,c.relname,c.relacl::text AS acl FROM pg_class c
  WHERE c.relnamespace IN ('public'::regnamespace,'private'::regnamespace) AND c.relkind IN ('r','p') ORDER BY c.oid`);
async function evidenceEdit(sql, params) { return change('private.content_audit_events', sql, params); }
async function tamper(job, value) {
  // Privileged corruption tests the read-side trust boundary.
  await db.query("UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{employee_safety_media}',$2::jsonb) WHERE id=$1", [job.job_id, JSON.stringify(value)]);
}
async function assertBadSidecar(job, value) {
  await isolated(async () => {
    await tamper(job, value);
    await assert.rejects(inventory(job), /employee safety/i);
    await assert.rejects(verify(job), /employee safety/i);
  });
}

before(async () => {
  for (const [module, name] of [[globalThis, 'fetch'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect'], [dgram, 'createSocket']]) {
    mock.method(module, name, () => { networkCalls++; assert.fail('All network/production calls are forbidden'); });
  }
  replay = await replayMigrations({ upTo: PREVIOUS, strict: true }); db = replay.db;
  beforeDefinitions = await definitions(); beforeTables = await tables();
  await db.exec(await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), 'utf8'));
  await db.exec('BEGIN');
  try {
    await buildNewSite(db);
    await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      VALUES($1,'media-other-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [OTHER_ROOT, PASSWORDS.root]);
    await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [OTHER_ROOT]);
    for (const [user, name] of [[TARGET, 'media-target'], [FOREIGN, 'media-foreign']]) {
      await db.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
        VALUES($1,$2,$2,extensions.crypt($3,extensions.gen_salt('bf',4)),$4)`, [user, name, PASSWORDS.employee, NEW.root]);
      await db.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [user]);
      await db.query(`INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status,id_front_url,id_back_url,selfie_url)
        VALUES($1,$2,'Local person','LOCAL-ID','555','Local address','pending',$3,$4,$5)`, [id(user === TARGET ? 10 : 11), user,
        user === TARGET ? DOC : url('verification-documents', `id-front/${FOREIGN}-front.png`, OTHER_ORIGIN),
        user === TARGET ? url('verification-documents', `id-back/${TARGET}-back.pdf`) : null,
        user === TARGET ? url('verification-documents', `selfie/${TARGET}-selfie.png`) : null]);
    }
    await db.query(`INSERT INTO public.simulated_customers(id,admin_id,customer_name,customer_id,source_type,target_employee_ids,custom_avatar_url,customer_avatar)
      VALUES($1,$3,'Shared dependency','LOCAL-SHARED','ccc_service',ARRAY[$4,$5]::uuid[],$6,'customer-avatar:vip:1'),
        ($2,$3,'Foreign role','LOCAL-FOREIGN','aaa_service',ARRAY[$5]::uuid[],$7,NULL)`,
    [id(20), id(21), NEW.root, TARGET, FOREIGN, AVATAR, url('super-customer-avatars', 'avatars/foreign.png', OTHER_ORIGIN)]);
    await db.query(`INSERT INTO public.cs_message_templates(id,admin_id,name,content,content_type,source_type)
      VALUES($1,$2::text,'Selected library',$3,'rich_card','ccc_service')`, [id(22), NEW.root, html(CHAT_URL)]);
    await db.query(`INSERT INTO public.customer_auto_messages(id,customer_id,admin_id,message_type,name,content,content_type)
      VALUES($1,$2,$3::text,'quick_send','Selected auto',$4,'text')`, [id(23), id(20), NEW.root, html(CHAT_URL)]);
    await db.query(`INSERT INTO public.rich_card_contents(id,html_content,source_template_id,content_hash)
      VALUES($1,$2,$3,md5($2))`, [id(24), html(CHAT_URL), id(22)]);
    for (const [user, row, content] of [[TARGET, 25, html(CHAT_URL)], [FOREIGN, 26, html(url('chat-images', 'foreign/private.png', OTHER_ORIGIN))],
      [TARGET, 27, html(CHAT_URL) + html(CHAT_URL)]]) {
      await change('public.customer_employee_conversations', `INSERT INTO public.customer_employee_conversations
        (id,customer_id,employee_id,sender_type,message_content,message_type,source_type,image_url,rich_card_content_id,rating_data)
        VALUES($1,$2,$3,'customer',$4,'image','ccc_service',$5,$6,'{"stars":5,"comment":"ordinary punctuation: https://example.test"}')`,
      [id(row), id(20), user, content, user === TARGET ? CHAT_URL : null, user === TARGET ? id(24) : null]);
    }
    await db.query(`INSERT INTO public.notification_automation_tasks(id,owner_admin_id,name,trigger_type,trigger_mode,threshold_value,
      title_template,content_template,recipient_scope,status)
      VALUES($1,$2,'Local task','total_orders','reach_once',2,'Plain title',$3,'selected','paused')`, [id(30), NEW.root, html(CHAT_URL)]);
    await db.query('INSERT INTO public.notification_automation_task_recipients(task_id,user_id) VALUES($1,$2)', [id(30), TARGET]);
    await db.query(`INSERT INTO public.notification_automation_executions(id,task_id,task_version,owner_admin_id,user_id,employee_username,period_key,stage,
      actual_value,trigger_snapshot,title_snapshot,content_snapshot,status)
      VALUES($1,$2,1,$3,$4,'media-target','all_time',1,2,
      '{"trigger_type":"total_orders","trigger_mode":"reach_once","threshold_value":2,"minimum_daily_orders":null,"minimum_daily_work_minutes":null}',
      'Plain title',$5,'failed')`, [id(31), id(30), NEW.root, TARGET, html(CHAT_URL)]);
    await db.query(`INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority,audit_origin,delivery_mode)
      VALUES($1,$3,'root','Shared message',$4,'realtime','normal','manual_admin','realtime_only'),
        ($2,$3,'root','Foreign message',$5,'realtime','normal','manual_admin','realtime_only')`,
    [id(32), id(33), NEW.root, html(CHAT_URL), html(url('chat-images', 'foreign/notification.png', OTHER_ORIGIN))]);
    await db.query('INSERT INTO public.message_recipients(message_id,recipient_id) VALUES($1,$2),($3,$4)', [id(32), TARGET, id(33), FOREIGN]);
    await db.query(`INSERT INTO public.message_templates(id,admin_id,name,title,content,message_type,priority,delivery_mode)
      VALUES($1,$2,'Library','Plain title',$3,'realtime','normal','realtime_only')`, [id(34), NEW.root, html(CHAT_URL)]);
    await db.query(`INSERT INTO public.broadcast_messages(id,admin_id,message_content,image_url,message_type,target_type)
      VALUES($1,$2,$3,$4,'image','all')`, [id(35), NEW.root, html(CHAT_URL), url('announcement-images', 'broadcast/video.mp4')]);
    await db.query('INSERT INTO public.broadcast_recipients(broadcast_id,employee_id) VALUES($1,$2)', [id(35), TARGET]);
    for (const [user, event] of [[TARGET, 40], [FOREIGN, 41]]) {
      await db.query(`INSERT INTO private.content_audit_events(id,operation_id,entity_type,entity_id,action,owner_admin_id,
        actor_admin_id,actor_username,actor_role,employee_id,before_data,media_refs)
        VALUES($1,$2,'ccc_service',$3,'edit',$4,$4,'root','super_admin',$5,$6::jsonb,$7::jsonb)`,
      [id(event), randomUUID(), id(25), NEW.root, user, JSON.stringify({ original: 'https://historical.invalid/image.png', src: 'data:old-snapshot' }),
        JSON.stringify({ [EVIDENCE_KEY]: `events/${id(event)}/proof.png`, 'opaque-other': `events/${id(event)}/proof.png` })]);
    }
    session = await adminLogin(db, 'root', PASSWORDS.root); secondary = await adminLogin(db, 'branch', PASSWORDS.branch);
    otherRoot = await adminLogin(db, 'media-other-root', PASSWORDS.root);
    employeeToken = (await baseRpc(db, 'create_employee_financial_session', { p_username: 'media-target', p_password: PASSWORDS.employee, p_tab_id: 'local-media-tab' })).session_token;
    await db.exec('COMMIT');
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
});
after(async () => { try { await db?.close(); } finally { mock.restoreAll(); } });

test('SQL47: strict replay preserves historical failures, old functions/ACL and all tables', async () => {
  assert.deepEqual(replay.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
  const oldIds = new Set(beforeDefinitions.map(d => d.oid));
  assert.deepEqual((await definitions()).filter(d => oldIds.has(d.oid)), beforeDefinitions);
  assert.deepEqual(await tables(), beforeTables);
});

test('SQL47: scoped inventory has exact public contract, four kinds and no foreign refs', () => transaction(async () => {
  const job = await begin(), result = await inventory(job);
  assert.deepEqual(Object.keys(result).sort(), ['version','scope','records_catalog','files','verified','complete_employee_backup','can_archive','can_replace','full_site_complete'].sort());
  assert.deepEqual(result.records_catalog, job.catalog); flags(result); assert.equal(result.verified, false);
  assert.deepEqual([...new Set(result.files.map(f => f.kind))].sort(), ['archives', 'chat', 'notifications', 'verification']);
  for (const f of result.files) assert.deepEqual(Object.keys(f).sort(), ['key','source_url','bucket','path','kind','avatar','file'].sort());
  assert.ok(result.files.every(f => f.file === null)); assert.deepEqual(result.files.map(f => f.key), result.files.map(f => f.key).sort());
  assert.doesNotMatch(JSON.stringify(result.files), /https?:|other-safety|foreign\/|foreign\.invalid|customer-avatar:|origin/);
  assert.equal(result.files.filter(f => f.kind === 'archives').length, 2);
}));

test('SQL47: opaque per-row identity follows exact line/ref/bucket hash contract', () => transaction(async () => {
  const job = await begin(), result = await inventory(job);
  for (const [table, rowId, field, original, bucket, path, kind, avatar] of [
    ['verification_requests', id(10), 'id_front_url', DOC, 'verification-documents', `id-front/${TARGET}-front.png`, 'verification', false],
    ['simulated_customers', id(20), 'custom_avatar_url', AVATAR, 'super-customer-avatars', 'avatars/role.png', 'chat', true],
    ['customer_employee_conversations', id(25), 'message_content', CHAT_URL, 'chat-images', 'shared/photo.png', 'chat', false],
    ['messages', id(32), 'content', CHAT_URL, 'chat-images', 'shared/photo.png', 'notifications', false],
    ['content_audit_events', id(40), 'media_refs', EVIDENCE_KEY, 'content-audit-evidence', `events/${id(40)}/proof.png`, 'archives', false],
  ]) {
    const query = await scalar(db, 'SELECT private.employee_safety_backup_query($1)', [table]);
    const row = (await rows(db, `SELECT id,body::text||E'\n' AS line FROM (${query}) r WHERE id=$2`, [TARGET, rowId]))[0];
    const identity = `employee-safety-media-v1:${job.catalog.site_id}:${job.job_id}:${TARGET}:${job.catalog.fingerprint}:${sha(row.line)}:${sha(`${table}:${row.id}:${field}:${original}`)}:${sha(`${bucket}/${path}`)}`;
    assert.deepEqual(result.files.find(f => f.key === sha(identity)), { key: sha(identity), source_url: identity, bucket, path, kind, avatar, file: null });
  }
  for (const ref of result.files) {
    const identity = ref.source_url.split(':');
    assert.equal(identity.length, 8);
    assert.deepEqual(identity.slice(0, 5), ['employee-safety-media-v1', job.catalog.site_id, job.job_id, TARGET, job.catalog.fingerprint]);
    assert.match(identity[5], /^[0-9a-f]{64}$/); assert.match(identity[6], /^[0-9a-f]{64}$/);
    assert.equal(identity[7], sha(`${ref.bucket}/${ref.path}`)); assert.equal(sha(ref.source_url), ref.key);
  }
  const shared = result.files.filter(f => f.bucket === 'chat-images' && f.path === 'shared/photo.png');
  assert.equal(shared.length, 12); assert.equal(new Set(shared.map(f => f.source_url)).size, 12);
  assert.ok(!result.files.some(f => f.key === sha(CHAT_URL)));
}));

test('SQL47: inventory/verify are STABLE READ ONLY and do not refresh task or infer records success', () => transaction(async () => {
  const job = await begin(), before = await jobRow(job);
  await db.exec('SET TRANSACTION READ ONLY');
  await inventory(job); await rpc('employee_safety_backup_verify', bound(job));
  await assert.rejects(verify(job), /complete export readback/);
  assert.deepEqual(await jobRow(job), before);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_maintenance'), 0);
}));

test('SQL47: SQL ACL/security mode isolates browser, service and private helpers', () => transaction(async () => {
  const funcs = await rows(db, `SELECT n.nspname AS schema,p.proname,p.oid,p.provolatile,p.prosecdef,p.proconfig,
    has_function_privilege('anon',p.oid,'EXECUTE') AS anon,has_function_privilege('authenticated',p.oid,'EXECUTE') AS authenticated,
    has_function_privilege('service_role',p.oid,'EXECUTE') AS service,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS everyone
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='private' AND p.proname LIKE 'employee_safety_media_%')
      OR (n.nspname='public' AND p.proname IN ($1,$2,$3,$4))`, [INVENTORY, VERIFY, AUTHORIZE, COMMIT]);
  assert.equal(funcs.length, 12);
  for (const f of funcs) {
    const browser = [INVENTORY, VERIFY].includes(f.proname), service = [AUTHORIZE, COMMIT].includes(f.proname);
    assert.equal(f.prosecdef, true); assert.ok(f.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    assert.equal(f.everyone, false); assert.equal(f.anon, browser); assert.equal(f.authenticated, browser); assert.equal(f.service, service);
    if (browser || f.proname === AUTHORIZE) assert.equal(f.provolatile, 's');
  }
  const job = await begin(), ref = (await inventory(job)).files[0];
  await assert.rejects(rpc(AUTHORIZE, { ...auth(job), p_action: 'download', p_object_key: ref.key }), /permission denied/);
  await assert.rejects(rpc(COMMIT, commitArgs(job, ref)), /permission denied/);
}));

test('SQL47: invalid/employee/secondary/other-superadmin sessions cannot read or attest', () => transaction(async () => {
  const job = await begin(), ref = (await inventory(job)).files[0];
  for (const token of [null, randomUUID(), secondary, otherRoot, employeeToken]) {
    await assert.rejects(rpc(INVENTORY, bound(job, token)), /session|permission|invalid|expired/i);
    await assert.rejects(authorize(job, ref, 'download', token), /session|permission|invalid|expired/i);
    await assert.rejects(rpc(COMMIT, commitArgs(job, ref, 'download', { p_admin_session_token: token }), 'service_role'), /session|permission|invalid|expired/i);
  }
  await assert.rejects(rpc(INVENTORY, { ...bound(job), p_catalog_fingerprint: '0'.repeat(64) }), /catalog binding/);
}));

test('SQL47: protocols cannot cross into old media, transfer finish or import', () => transaction(async () => {
  const job = await begin(), ref = (await inventory(job)).files[0];
  for (const action of [null, 'upload', 'recheck-import', 'delete', 'finish']) await assert.rejects(authorize(job, ref, action), /Unsupported/);
  for (const name of ['employee_transfer_chat_media_authorize', 'employee_transfer_notification_media_authorize', 'employee_transfer_verification_media_authorize', 'employee_transfer_archive_media_authorize']) {
    await assert.rejects(rpc(name, { ...auth(job), p_action: 'download', p_object_key: ref.key }, 'service_role'), /task|job/i);
  }
  await assert.rejects(rpc('employee_export_finish', { ...auth(job), p_summary: {} }), /independent|protocol/i);
  await rpc('employee_safety_backup_close', bound(job));
  const old = await rpc('employee_export_shared_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  await assert.rejects(rpc(INVENTORY, { ...auth(old), p_catalog_fingerprint: job.catalog.fingerprint }), /invalid|expired/i);
}));

test('SQL47: service context is exact and recheck refuses before download', () => transaction(async () => {
  const job = await begin(), refs = (await inventory(job)).files;
  for (const kind of ['verification', 'chat', 'notifications', 'archives']) {
    const ref = refs.find(f => f.kind === kind), context = await authorize(job, ref);
    assert.deepEqual(context, { direction: 'export', ...ref, generation: job.catalog.fingerprint });
    assert.equal(sha(context.source_url), context.key); assert.equal(context.generation, context.source_url.split(':')[4]);
    assert.equal(sha(`${context.bucket}/${context.path}`), context.source_url.split(':')[7]);
  }
  const ref = refs.find(f => f.kind === 'archives');
  await assert.rejects(authorize(job, ref, 'recheck-export'), /before rechecking/);
  await assert.rejects(commit(job, ref, 'recheck-export'), /before rechecking/);
  for (const key of [null, 'x'.repeat(64), ref.path, '0'.repeat(64)]) await assert.rejects(authorize(job, { key }), /key|outside/);
}));

test('SQL47: real service SQL download/recheck merges all receipts and keeps records flags', () => transaction(async () => {
  const job = await begin(), original = await jobRow(job), refs = (await inventory(job)).files;
  for (const ref of refs) { flags(await commit(job, ref)); await commit(job, ref, 'recheck-export'); }
  const result = await verify(job); assert.equal(result.verified, true); flags(result);
  assert.ok(result.files.every(f => f.file.bytes === 128 && f.file.sha256 === sha(f.key)));
  const row = await jobRow(job), state = await rawSidecar(job);
  assert.equal(Object.keys(state.receipts).length, refs.length); assert.equal(state.protocol, 'employee-safety-media-v1');
  assert.deepEqual(row.summary.employee_safety_catalog, original.summary.employee_safety_catalog);
  assert.deepEqual(row.options, original.options); assert.equal(row.last_activity_at, original.last_activity_at);
  assert.ok(state.refs.every(f => f.origin === ORIGIN));
  await commit(job, refs[0]); assert.equal((await verify(job)).verified, true);
  const after = await jobRow(job); await db.exec('SET TRANSACTION READ ONLY');
  assert.deepEqual(await verify(job), await inventory(job)); assert.deepEqual(await jobRow(job), after);
}));

test('SQL47: unchecked download is pending, repeated tuple is immutable, generation/origin rejects', () => transaction(async () => {
  const job = await begin(), ref = (await inventory(job)).files.find(f => f.kind === 'verification');
  await commit(job, ref); const before = await jobRow(job);
  assert.equal((await inventory(job)).verified, false); await assert.rejects(verify(job), /readback/);
  for (const extra of [{ p_sha256: 'f'.repeat(64) }, { p_bytes: 129 }, { p_content_type: 'image/jpeg' },
    { p_generation: '0'.repeat(64) }, { p_storage_origin: OTHER_ORIGIN }, { p_storage_origin: `${ORIGIN}/` }]) {
    await assert.rejects(commit(job, ref, 'recheck-export', extra), /changed|origin|file/i);
  }
  assert.deepEqual(await jobRow(job), before);
}));

test('SQL47: private-only evidence acquires origin once and never exposes opaque original keys', () => transaction(async () => {
  for (const [relation, field, condition] of [
    ['public.verification_requests', 'id_front_url=NULL,id_back_url=NULL,selfie_url=NULL', 'true'],
    ['public.simulated_customers', 'custom_avatar_url=NULL', 'true'],
    ['public.customer_employee_conversations', "message_content='plain',image_url=NULL", 'true'],
    ['public.cs_message_templates', "content='plain'", 'true'], ['public.customer_auto_messages', "content='plain'", 'true'],
    ['public.rich_card_contents', "html_content='plain'", 'true'], ['public.notification_automation_tasks', "content_template='plain'", 'true'],
    ['public.notification_automation_executions', "content_snapshot='plain'", 'true'], ['public.messages', "content='plain'", 'true'],
    ['public.message_templates', "content='plain'", 'true'], ['public.broadcast_messages', "message_content='plain',image_url=NULL", 'true'],
  ]) await change(relation, `UPDATE ${relation} SET ${field} WHERE ${condition}`);
  const job = await begin(), refs = (await inventory(job)).files;
  assert.equal(refs.length, 2); const ref = refs[0];
  await commit(job, ref); assert.equal((await rawSidecar(job)).storage_origin, ORIGIN);
  await assert.rejects(commit(job, refs[1], 'download', { p_storage_origin: OTHER_ORIGIN }), /origin changed/);
  assert.doesNotMatch(JSON.stringify(await authorize(job, ref)), /foreign\.invalid|origin/);
}));

test('SQL47: strict size/MIME contracts by verification/chat/notifications/archive/avatar kind', () => transaction(async () => {
  const job = await begin(), refs = (await inventory(job)).files;
  for (const extra of [{ p_bytes: 0 }, { p_bytes: -1 }, { p_bytes: 52428801 }, { p_bytes: null }, { p_sha256: null },
    { p_sha256: 'f'.repeat(65) }, { p_content_type: null }, { p_content_type: 'image/svg+xml' }]) {
    await assert.rejects(commit(job, refs[0], 'download', extra), /tuple|size|type/);
  }
  for (const [kind, mime, ok] of [['verification','application/pdf',true],['verification','video/mp4',false],
    ['chat','video/webm',true],['notifications','application/pdf',true],['archives','video/mp4',true],['archives','application/pdf',false]]) {
    const ref = refs.find(f => f.kind === kind && !f.avatar);
    await isolated(async () => {
      if (ok) await commit(job, ref, 'download', { p_bytes: 52428800, p_content_type: mime });
      else await assert.rejects(commit(job, ref, 'download', { p_content_type: mime }), /type|size/);
    });
  }
  const avatar = refs.find(f => f.avatar);
  await isolated(() => commit(job, avatar, 'download', { p_bytes: 5242880 }));
  await assert.rejects(commit(job, avatar, 'download', { p_bytes: 5242881 }), /size/);
  await assert.rejects(commit(job, avatar, 'download', { p_content_type: 'application/pdf' }), /type/);
}));

test('SQL47: unexpected receipt keys, fields, file tuples, checked types and bindings fail on read', () => transaction(async () => {
  const job = await begin(), ref = (await inventory(job)).files[0]; await commit(job, ref);
  const state = await rawSidecar(job), receipt = state.receipts[ref.key];
  for (const patch of [{ path: 'wrong/path.png' }, { storage_origin: OTHER_ORIGIN }, { generation: '0'.repeat(64) },
    { checked: 'true' }, { checked: null }, { file: { ...receipt.file, sha256: null } },
    { file: { ...receipt.file, source_url: 'wrong' } }, { file: { ...receipt.file, extra: true } }, { extra: true }]) {
    await assertBadSidecar(job, { ...state, receipts: { [ref.key]: { ...receipt, ...patch } } });
  }
  await assertBadSidecar(job, { ...state, receipts: { ...state.receipts, ['0'.repeat(64)]: receipt } });
  await assertBadSidecar(job, { ...state, protocol: 'site-chat-media' });
  await assertBadSidecar(job, { ...state, refs: state.refs.slice(1) });
}));

test('SQL47: wrong public URL origin cannot be forged on first commit', () => transaction(async () => {
  const job = await begin(), ref = (await inventory(job)).files.find(f => f.kind === 'chat');
  await assert.rejects(commit(job, ref, 'download', { p_storage_origin: OTHER_ORIGIN }), /origin changed/);
  assert.equal(await rawSidecar(job), null);
}));

test('SQL47: row/content drift after authorization invalidates original generation at commit', () => transaction(async () => {
  const job = await begin(), ref = (await inventory(job)).files.find(f => f.kind === 'verification'); await authorize(job, ref);
  for (const [relation, sql, params] of [
    ['public.users', "UPDATE public.users SET remarks='same-count drift' WHERE id=$1", [TARGET]],
    ['public.cs_message_templates', "UPDATE public.cs_message_templates SET title='dependency drift' WHERE id=$1", [id(22)]],
  ]) await isolated(async () => {
    await change(relation, sql, params);
    await assert.rejects(commit(job, ref), /content changed/);
    await assert.rejects(inventory(job), /content changed/);
    assert.equal(await rawSidecar(job), null);
  });
}));

test('SQL47: media path/ref/source row drift invalidates existing receipts', () => transaction(async () => {
  const job = await begin(), ref = (await inventory(job)).files.find(f => f.kind === 'archives'); await commit(job, ref);
  await evidenceEdit("UPDATE private.content_audit_events SET media_refs=jsonb_build_object('new-key','events/new.png') WHERE id=$1", [id(40)]);
  await assert.rejects(inventory(job), /content changed/); await assert.rejects(commit(job, ref, 'recheck-export'), /content changed/);
}));

test('SQL47: verification rejects foreign UUID, traversal, encoded/query/signed and foreign bucket URLs', () => transaction(async () => {
  for (const bad of [url('verification-documents', `id-front/${FOREIGN}-front.png`), DOC + '?token=secret', DOC.replace('/public/', '/sign/'),
    DOC.replace('-front.png', '-%66ront.png'), DOC.replace('-front.png', '-../front.png'), CHAT_URL, 'https://external.invalid/a.png', DOC + '\n']) {
    await isolated(async () => {
      await change('public.verification_requests', 'UPDATE public.verification_requests SET id_front_url=$2 WHERE id=$1', [id(10), bad]);
      const job = await begin(); await assert.rejects(inventory(job), /media|document|path|URL/i);
    });
  }
}));

test('SQL47: selected public refs must share one origin; unrelated foreign media never scanned', () => transaction(async () => {
  const own = await begin(), original = await inventory(own);
  await change('public.customer_employee_conversations', 'UPDATE public.customer_employee_conversations SET image_url=$2 WHERE id=$1',
    [id(26), 'https://foreign.invalid/never-fetched?token=secret']);
  assert.deepEqual(await inventory(own), original);
  await rpc('employee_safety_backup_close', bound(own));
  await change('public.cs_message_templates', 'UPDATE public.cs_message_templates SET content=$2 WHERE id=$1', [id(22), html(url('chat-images', 'other.png', OTHER_ORIGIN))]);
  const job = await begin(); await assert.rejects(inventory(job), /different Storage origins/);
}));

test('SQL47: chat rating JSON and unsupported/encoded HTML media fail closed', () => transaction(async () => {
  for (const [field, value] of [['rating_data', JSON.stringify({ nested: { image_url: CHAT_URL } })], ['message_content', `<img src="${CHAT_URL.replace('photo', '%70hoto')}">`],
    ['message_content', `<img srcset="${CHAT_URL} 2x">`], ['message_content', `<a href="${CHAT_URL}?download=1">file</a>`],
    ['message_content', '<img src="data:image/png;base64,AAAA">'], ['message_content', '<p style="background:url(x)">x</p>'],
    ['message_content', '<p>https://external.invalid/unmanaged.png</p>'], ['message_content', '<img src="https://bad.invalid/x.png">']]) {
    await isolated(async () => {
      await change('public.customer_employee_conversations', `UPDATE public.customer_employee_conversations SET ${field}=$2${field === 'rating_data' ? '::jsonb' : ''} WHERE id=$1`, [id(25), value]);
      const job = await begin(); await assert.rejects(inventory(job), /media|srcset|URL|rating/i);
    });
  }
}));

test('SQL47: recursively rejects unknown media fields but audit snapshots/opaque keys remain historical', () => transaction(async () => {
  for (const [relation, sql, params] of [
    ['public.users', 'UPDATE public.users SET remarks=$2 WHERE id=$1', [TARGET, `nested ${CHAT_URL}`]],
    ['public.employee_login_history', `INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,device_info)
      VALUES($1,$2,'media-target','media-target','login',$3::jsonb)`, [id(50), TARGET, JSON.stringify({ nested: [{ arbitrary: CHAT_URL }] })]],
    ['public.messages', 'UPDATE public.messages SET title=$2 WHERE id=$1', [id(32), CHAT_URL]],
    ['public.customer_employee_conversations', 'UPDATE public.customer_employee_conversations SET title=$2 WHERE id=$1', [id(25), html(CHAT_URL)]],
  ]) await isolated(async () => {
    await change(relation, sql, params); const job = await begin();
    await assert.rejects(inventory(job), /Unsupported employee safety media reference/);
  });
  const job = await begin(); assert.equal((await inventory(job)).files.filter(f => f.kind === 'archives').length, 2);
}));

test('SQL47: archive manifests require object, safe private path and uncleared evidence', () => transaction(async () => {
  for (const refs of [[], null, { opaque: 'events/../proof.png' }, { opaque: 'https://bad.invalid/a.png' }, { opaque: 'events/%2fproof.png' }, { opaque: 12 }]) {
    await isolated(async () => {
      await evidenceEdit('UPDATE private.content_audit_events SET media_refs=$2::jsonb WHERE id=$1', [id(40), JSON.stringify(refs)]);
      const job = await begin(); await assert.rejects(inventory(job), /evidence|references/);
    });
  }
  await evidenceEdit('UPDATE private.content_audit_events SET cleared_at=now() WHERE id=$1', [id(40)]);
  const job = await begin(); await assert.rejects(inventory(job), /Cleared/);
}));

test('SQL47: 3000 per-row references is a hard cap, without truncation or task writes', () => transaction(async () => {
  const refs = Object.fromEntries(Array.from({ length: 3001 }, (_, n) => [`opaque-${n}`, `proof/${n}.png`]));
  // Keep rows below 64KiB so this reaches the reference-count limit.
  await evidenceEdit("UPDATE private.content_audit_events SET media_refs='{}' WHERE id=$1", [id(40)]);
  for (let offset = 0; offset < 3001; offset += 300) {
    await db.query(`INSERT INTO private.content_audit_events(id,operation_id,entity_type,entity_id,action,owner_admin_id,
      actor_admin_id,actor_username,actor_role,employee_id,media_refs)
      VALUES($1,$2,'ccc_service',$3,'edit',$4,$4,'root','super_admin',$5,$6::jsonb)`,
    [id(100 + offset), randomUUID(), id(25), NEW.root, TARGET, JSON.stringify(Object.fromEntries(Object.entries(refs).slice(offset, offset + 300)))]);
  }
  const job = await begin(); await assert.rejects(inventory(job), /3000 references/); assert.equal(await rawSidecar(job), null);
}));

test('SQL47: record+media 1GiB limit counts repeated object refs separately and rolls back overflow', () => transaction(async () => {
  for (let n = 0; n < 22; n++) await db.query(`INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status,id_front_url)
    VALUES($1,$2,'Local person','LOCAL-ID','555','Local address','pending',$3)`, [id(500 + n), TARGET, DOC]);
  const job = await begin(), refs = (await inventory(job)).files.filter(f => f.kind === 'verification');
  for (const ref of refs.slice(0, 20)) await commit(job, ref, 'download', { p_bytes: 52428800 });
  const before = await jobRow(job);
  await assert.rejects(commit(job, refs[20], 'download', { p_bytes: 52428800 }), /1 GiB/);
  assert.deepEqual(await jobRow(job), before);
}));

test('SQL47: closed/stopped/expired own tasks cannot attest or reuse previous opaque identities', () => transaction(async () => {
  const job = await begin(), ref = (await inventory(job)).files[0]; await commit(job, ref);
  await rpc('employee_safety_backup_close', bound(job));
  await assert.rejects(authorize(job, ref), /invalid|expired/);
  const next = await begin(); assert.ok(!(await inventory(next)).files.some(f => f.key === ref.key));
  await assert.rejects(authorize(next, ref), /outside/);
  await isolated(async () => {
    await db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '4 hours' WHERE id=$1", [next.job_id]);
    await assert.rejects(inventory(next), /invalid|expired/);
  });
  await rpc('employee_safety_backup_stop_owned', { p_admin_session_token: session, p_admin_password: PASSWORDS.root,
    p_confirmation: '確認停止員工備份任務', p_job_id: next.job_id });
  await assert.rejects(inventory(next), /invalid|expired/);
  assert.equal(networkCalls, 0);
}));
