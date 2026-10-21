import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { replayMigrations, EXPECTED_REPLAY_FAILURES } from './support/replay-migrations.mjs';
import { adminLogin, rpc as baseRpc, rows, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// The original SQL contracts use synthetic receipts. The LOCAL bridge below runs actual
// SQL46/47 + clients + Edge + filesystem crypto, with only transport/Storage bytes adapted.
// Neither proves real Supabase Storage, native PostgreSQL/PostgREST or full restore acceptance.
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
let db, replay, session, secondary, otherRoot, employeeToken, beforeDefinitions, beforeTables, api, createMediaHandler;
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
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const compiled = await build({ stdin: { resolveDir: root, contents: `export * from './src/lib/employeeTransfer/employeeSafetyBackup.ts';
    export * from './src/lib/employeeTransfer/employeeSafetyMedia.ts'; export {setHarness} from 'safety-media-db:state';` },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', metafile: true,
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(ORIGIN), 'import.meta.env.VITE_SUPABASE_ANON_KEY': '"local-only-anon-key"' },
    plugins: [{ name: 'local-sql-transport-only', setup(builder) {
      builder.onResolve({ filter: /^(?:safety-media-db:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'local-sql' }));
      builder.onLoad({ filter: /.*/, namespace: 'local-sql' }, ({ path }) => ({ contents: path === 'safety-media-db:state'
        ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
        : path === '../auth' ? 'import{current}from"safety-media-db:state";export const getAdminFinancialSessionToken=()=>current().token;'
          : 'import{current}from"safety-media-db:state";export const supabase={rpc(...args){if(this!==supabase)throw new Error("Unbound RPC");return current().rpc(...args)}};' }));
    } }],
  });
  assert.ok(!Object.keys(compiled.metafile.inputs).some(path => /node_modules\/@supabase|src\/lib\/(?:auth|supabase)\.ts|functions\//.test(path)),
    'Client bundle excludes live auth/Supabase and server modules');
  api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  const edge = await build({ entryPoints: [join(root, 'supabase/functions/employee-transfer-media/handler.ts')],
    bundle: true, write: false, format: 'esm', platform: 'browser' });
  ({ createEmployeeTransferMediaHandler: createMediaHandler } = await import(`data:text/javascript;base64,${Buffer.from(edge.outputFiles[0].text).toString('base64')}`));
}, { timeout: 600000 });
after(async () => { try { await db?.close(); assert.equal(networkCalls, 0); } finally { mock.restoreAll(); } });

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

const LOCAL_PASSPHRASE = 'independent-local-sql47-records-and-media-passphrase';
const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...Buffer.from('local SQL47 synthetic image bytes')]);
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\nlocal SQL47 synthetic document\n%%EOF\n');
const clientFlags = result => {
  for (const key of ['completeEmployeeBackup', 'canArchive', 'canReplace', 'fullSiteComplete']) assert.equal(result[key], false, key);
};
const volume = site => ({ exportId: randomUUID(), volumeId: randomUUID(), sourceSiteId: site, scope: 'replacement-backup',
  volumeIndex: 1, volumeCount: 1, createdAt: '2026-10-22T00:00:00.000Z' });
async function collectBytes(source) {
  const chunks = []; for await (const raw of source) chunks.push(Buffer.from(raw)); return Buffer.concat(chunks);
}
async function assertWorkspacesClean(h) {
  for (const w of h.spaces) {
    assert.equal(w.cleaned, true); assert.equal(w.cleanups, 1);
    await assert.rejects(stat(w.base), { code: 'ENOENT' });
  }
}
async function localMediaBridge(t) {
  const directory = await mkdtemp(join(tmpdir(), 'safety-media-real-sql47-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = { token: session, directory, calls: [], events: [], spaces: [], storageReads: [], responses: [], beforeServiceCommit: null };
  const browserRPCs = ['employee_safety_backup_begin', 'get_employee_safety_backup_catalog', 'get_employee_safety_backup_page',
    'employee_safety_backup_verify', 'employee_safety_backup_close', INVENTORY, VERIFY];
  h.invoke = async (name, args, role, signal) => {
    assert.ok((role === 'anon' ? browserRPCs : [AUTHORIZE, COMMIT]).includes(name), 'No stop/import/archive/maintenance/fallback RPC');
    assert.equal(args.p_admin_session_token, session); assert.notEqual(signal?.aborted, true);
    const call = { name, args: structuredClone(args), role }; h.calls.push(call); h.events.push(name);
    if (name === 'employee_safety_backup_begin') {
      assert.deepEqual(args, { p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_username: 'media-target' });
    } else assert.equal(args.p_job_token, h.job.job_token);
    if (name === COMMIT && h.beforeServiceCommit) await h.beforeServiceCommit(args);
    // Only adapt the transport envelope. Credentials, tasks, catalog, receipts and errors all come from real SQL.
    try { const data = await rpc(name, args, role); call.result = structuredClone(data); return { data, error: null }; }
    catch (error) { call.error = error; return { data: null, error }; }
  };
  h.rpc = (name, args) => {
    let pending;
    const query = { signal: undefined, abortSignal(signal) { query.signal = signal; return query; },
      then(resolve, reject) { return (pending ??= Promise.resolve().then(() => h.invoke(name, args, 'anon', query.signal))).then(resolve, reject); } };
    return query;
  };
  // Explicit scoped objects, not invented from returned receipts. Foreign bytes exist but must never be read.
  h.objects = new Map([
    [`verification-documents/id-front/${TARGET}-front.png`, PNG_BYTES],
    [`verification-documents/id-back/${TARGET}-back.pdf`, PDF_BYTES],
    [`verification-documents/selfie/${TARGET}-selfie.png`, PNG_BYTES],
    ['super-customer-avatars/avatars/role.png', PNG_BYTES],
    ['chat-images/shared/photo.png', PNG_BYTES],
    ['announcement-images/broadcast/video.mp4', PNG_BYTES],
    [`content-audit-evidence/events/${id(40)}/proof.png`, PNG_BYTES],
  ]);
  const permittedObjects = new Set(h.objects.keys());
  for (const path of [`verification-documents/id-front/${FOREIGN}-front.png`, 'chat-images/foreign/private.png',
    'chat-images/foreign/notification.png', 'super-customer-avatars/avatars/foreign.png', `content-audit-evidence/events/${id(41)}/proof.png`]) {
    h.objects.set(path, Uint8Array.from([1, 2, 3]));
  }
  h.storageBefore = structuredClone([...h.objects]);
  const handler = createMediaHandler({ supabaseUrl: ORIGIN, crypto: webcrypto,
    rpc: (name, args) => h.invoke(name, args, 'service_role'), store: {
      async download(bucket, path, signal) {
        assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false);
        const key = bucket + '/' + path; assert.ok(permittedObjects.has(key), 'Storage must not read foreign/unselected objects');
        h.storageReads.push(key); h.events.push('storage-download');
        // Wrong Storage header deliberately proves magic-byte/MIME/hash detection runs in the actual handler.
        return { data: new Response(h.objects.get(key).slice(), { headers: { 'content-type': 'text/html' } }) };
      },
      upload() { assert.fail('Export cannot upload'); }, remove() { assert.fail('Export cannot delete'); },
    } });
  h.transport = async (endpoint, init) => {
    assert.equal(endpoint, ORIGIN + '/functions/v1/employee-transfer-media'); assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store'); assert.equal(init.body, undefined);
    assert.equal(init.headers.apikey, 'local-only-anon-key'); assert.equal(init.headers['x-transfer-scope'], 'employee-safety');
    assert.equal(init.headers['x-admin-session-token'], session); assert.equal(init.headers['x-transfer-job-token'], h.job.job_token);
    assert.ok(['download', 'recheck-export'].includes(init.headers['x-transfer-action']));
    assert.ok(h.refs.some(ref => ref.key === init.headers['x-transfer-object-key']));
    const response = await handler(new Request(endpoint, init)); h.responses.push(response.status); return response;
  };
  h.workspace = () => {
    const w = { base: join(directory, `plaintext-${h.spaces.length}`), cleaned: false, cleanups: 0,
      async append(path, raw, signal) {
        assert.equal(w.cleaned, false); assert.equal(signal.aborted, false); assert.ok(raw.length <= 1024 * 1024);
        assert.ok(!path.startsWith('/') && !path.includes('..') && !path.includes('\\'));
        await mkdir(dirname(join(w.base, path)), { recursive: true }); await appendFile(join(w.base, path), raw);
      },
      open(path) { return { async *[Symbol.asyncIterator]() {
        assert.equal(w.cleaned, false);
        for await (const chunk of createReadStream(join(w.base, path), { highWaterMark: 4096 })) { assert.equal(w.cleaned, false); yield chunk; }
      } }; },
      async abort() { w.cleaned = true; w.cleanups++; h.events.push('plaintext-cleanup'); await rm(w.base, { recursive: true, force: true }); },
    }; h.spaces.push(w); return w;
  };
  h.diskFile = name => {
    const file = { path: join(directory, name), writes: 0,
      async write(source, signal) {
        file.writes++; h.events.push('write-' + name); const fd = await open(file.path, 'wx');
        try { for await (const raw of source) { assert.equal(signal.aborted, false); await fd.writeFile(raw); } await fd.sync(); }
        finally { await fd.close(); }
        h.events.push('saved-' + name);
      },
      open() { return { async *[Symbol.asyncIterator]() {
        for await (const raw of createReadStream(file.path, { highWaterMark: 4096 })) yield raw;
        h.events.push('eof-' + name);
      } }; },
    }; return file;
  };
  h.records = h.diskFile('records.edx'); h.media = h.diskFile('attachments.edx');
  api.setHarness(h);
  // Supply the actual local fixture username AND real root password to the production source factory.
  h.recordSession = api.createEmployeeSafetyBackupSession('media-target', PASSWORDS.root);
  h.job = await h.recordSession.begin(); assert.equal(h.job.catalog.employee_id, TARGET);
  h.recordInfo = volume(h.job.site_id); h.mediaInfo = volume(h.job.site_id);
  h.recordsResult = await api.exportEmployeeSafetyBackup(h.recordSession, h.records, h.workspace, LOCAL_PASSPHRASE, h.recordInfo);
  h.source = api.createEmployeeSafetyMediaSource(h.recordSession.identity(), h.recordsResult.catalog, h.transport);
  h.refs = (await h.source.inventory()).files;
  assert.ok(h.refs.every(ref => permittedObjects.has(ref.bucket + '/' + ref.path)));
  assert.deepEqual([...new Set(h.refs.map(ref => ref.bucket + '/' + ref.path))].sort(), [...permittedObjects].sort());
  assert.ok(h.refs.every(ref => ref.file === null)); assert.equal(await rawSidecar(h.job), null);
  h.exportMedia = options => api.exportEmployeeSafetyMediaBackup(h.source, h.records, h.media, h.workspace, LOCAL_PASSPHRASE, h.mediaInfo, options);
  return h;
}

test('SQL47 LOCAL integration: real SQL46 begin/records disk -> anon SQL47 + service-role Edge -> independent media disk -> paired authenticated reader -> explicit close',
  { timeout: 240000 }, t => transaction(async () => {
    const h = await localMediaBridge(t), recordCipher = await readFile(h.records.path), recordResult = h.recordsResult;
    flags(recordResult); clientFlags(recordResult); assert.equal(recordResult.recordsVerified, true); assert.equal(recordResult.manifest.entries.length, 49);
    assert.equal(recordResult.cipherBytes, recordCipher.length); assert.equal(recordResult.cipherSha256, sha(recordCipher));
    assert.equal((await jobRow(h.job)).status, 'running'); assert.ok(!h.calls.some(c => c.name === 'employee_safety_backup_close'));
    const result = await h.exportMedia(), mediaCipher = await readFile(h.media.path);
    assert.equal(result.files, h.refs.length); assert.ok(result.files > h.objects.size - 5, 'Repeated per-row refs are kept, not deduplicated');
    assert.equal(result.mediaVerified, true); clientFlags(result); flags(result.catalog.inventory); flags(result.catalog.inventory.records_catalog);
    assert.equal(result.catalog.inventory.records_catalog.records_only, true); assert.equal(result.catalog.inventory.records_catalog.media_included, false);
    assert.equal(result.cipherBytes, mediaCipher.length); assert.equal(result.cipherSha256, sha(mediaCipher));
    assert.deepEqual(result.catalog.records_file, { export_id: h.recordInfo.exportId, volume_id: h.recordInfo.volumeId,
      cipher_bytes: recordCipher.length, cipher_sha256: sha(recordCipher) });
    assert.deepEqual(await readFile(h.records.path), recordCipher); assert.notEqual(h.records.path, h.media.path);
    assert.equal(h.records.writes, 1); assert.equal(h.media.writes, 1);
    assert.deepEqual([...new Set(result.catalog.inventory.files.map(ref => ref.kind))].sort(), ['archives', 'chat', 'notifications', 'verification']);
    assert.doesNotMatch(JSON.stringify(result.catalog.inventory.files), /https?:|other-safety|foreign\/|foreign\.invalid/);
    assert.equal(h.calls.filter(c => c.name === AUTHORIZE).length, h.refs.length * 3);
    assert.equal(h.calls.filter(c => c.name === COMMIT).length, h.refs.length * 3);
    assert.equal(h.calls.filter(c => c.name === VERIFY).length, 2); assert.equal(h.storageReads.length, h.refs.length * 3);
    assert.equal(h.calls.filter(c => c.name === 'get_employee_safety_backup_page').length, 48);
    assert.equal(h.calls.filter(c => c.name === 'employee_safety_backup_begin').length, 1);
    assert.ok(h.calls.every(c => !c.error), h.calls.filter(c => c.error).map(c => `${c.name}: ${c.error.message}`).join('\n'));
    const state = await rawSidecar(h.job); assert.equal(Object.keys(state.receipts).length, h.refs.length);
    for (const ref of result.catalog.inventory.files) {
      const bytes = h.objects.get(ref.bucket + '/' + ref.path), mime = ref.path.endsWith('.pdf') ? 'application/pdf' : 'image/png';
      const file = { key: ref.key, source_url: ref.source_url, bytes: bytes.length, sha256: sha(bytes), content_type: mime };
      assert.deepEqual(ref.file, file); assert.deepEqual(state.receipts[ref.key].file, file); assert.equal(state.receipts[ref.key].checked, true);
      assert.notEqual(file.bytes, 128); assert.notEqual(file.sha256, sha(ref.key));
      const commits = h.calls.filter(c => c.name === COMMIT && c.args.p_object_key === ref.key);
      assert.deepEqual(commits.map(c => c.args.p_action), ['download', 'recheck-export', 'recheck-export']);
      for (const call of commits) {
        assert.equal(call.role, 'service_role'); flags(call.result);
        assert.equal(call.args.p_bytes, bytes.length); assert.equal(call.args.p_sha256, sha(bytes)); assert.equal(call.args.p_content_type, mime);
        assert.equal(call.args.p_generation, h.job.catalog.fingerprint); assert.equal(call.args.p_storage_origin, ORIGIN);
      }
    }
    await assertWorkspacesClean(h);
    assert.equal((await jobRow(h.job)).status, 'running'); assert.ok(!h.calls.some(c => c.name === 'employee_safety_backup_close'));
    const calls = h.calls.length, storageReads = h.storageReads.length; let escaped, deferred; let readCount = 0;
    await api.withAuthenticatedEmployeeSafetyMediaBackup(h.records, h.media, LOCAL_PASSPHRASE, h.workspace, async reader => {
      escaped = reader; clientFlags(reader); assert.deepEqual(reader.inventory, result.catalog.inventory);
      assert.equal(reader.manifest.entries.length, h.refs.length + 1);
      for (const ref of reader.inventory.files) {
        const path = api.employeeSafetyMediaEntryPath(ref);
        assert.deepEqual(await collectBytes(reader.open(path)), Buffer.from(h.objects.get(ref.bucket + '/' + ref.path)));
        readCount++; deferred = reader.open(path);
      }
      for (const path of [api.EMPLOYEE_SAFETY_MEDIA_CATALOG_PATH, api.employeeSafetyBackupEntryPath('accounts'), '../../credentials',
        'media/chat-images/' + sha('foreign-unselected'), h.refs[0].path]) assert.throws(() => reader.open(path));
    });
    assert.equal(readCount, h.refs.length); assert.equal(h.calls.length, calls); assert.equal(h.storageReads.length, storageReads, 'Paired reader is offline');
    assert.throws(() => escaped.inventory); await assert.rejects(collectBytes(deferred)); await assertWorkspacesClean(h);
    assert.deepEqual([...h.objects], h.storageBefore); assert.ok(h.responses.every(status => status === 200));
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_maintenance'), 0);
    h.events.push('paired-reader-finished');
    const closed = await h.recordSession.close(recordResult.catalog); assert.equal(closed.success, true); assert.equal(closed.full_site_complete, false);
    assert.equal(h.calls.at(-1).name, 'employee_safety_backup_close'); assert.equal(h.calls.filter(c => c.name === 'employee_safety_backup_close').length, 1);
    assert.ok(h.events.indexOf('paired-reader-finished') < h.events.indexOf('employee_safety_backup_close'));
    assert.equal((await jobRow(h.job)).status, 'finished');
    await assert.rejects(h.source.inventory(), api.EmployeeSafetyMediaError);
    assert.deepEqual(await readFile(h.records.path), recordCipher); assert.deepEqual(await readFile(h.media.path), mediaCipher);
    assert.equal(networkCalls, 0);
  }));

test('SQL47 LOCAL integration: source drift at the last final-recheck Edge service commit rejects without close/retry or media permission escalation',
  { timeout: 240000 }, t => transaction(async () => {
    const h = await localMediaBridge(t), originalRecordCipher = await readFile(h.records.path); let rechecks = 0, drifted = false, beforeReceipt;
    h.beforeServiceCommit = async args => {
      if (args.p_action !== 'recheck-export' || ++rechecks !== h.refs.length * 2) return;
      assert.equal(h.media.writes, 1); assert.ok(h.events.includes('eof-attachments.edx')); await assertWorkspacesClean(h);
      beforeReceipt = await rawSidecar(h.job);
      assert.ok(Object.values(beforeReceipt.receipts).every(receipt => receipt.checked === true));
      // Real same-count source mutation AFTER Edge read/authorization, immediately before actual service-role COMMIT.
      await change('public.users', "UPDATE public.users SET remarks='local final service commit drift' WHERE id=$1", [TARGET]); drifted = true;
    };
    await assert.rejects(h.exportMedia(), error => {
      assert.ok(error instanceof api.EmployeeSafetyMediaError); assert.equal(error.phase, 'final-recheck');
      assert.equal(error.outcomeUnknown, true); assert.equal(error.encryptedFileState, 'verified'); assert.equal(error.cleanupRequired, false); return true;
    });
    assert.equal(drifted, true); assert.equal(rechecks, h.refs.length * 2);
    const failed = h.calls.filter(c => c.error); assert.equal(failed.length, 1); assert.equal(failed[0].name, COMMIT);
    assert.equal(failed[0].role, 'service_role'); assert.equal(failed[0].args.p_action, 'recheck-export'); assert.match(failed[0].error.message, /content changed/i);
    assert.equal(h.calls.at(-1), failed[0]); assert.equal(h.calls.filter(c => c.name === COMMIT).length, h.refs.length * 3, 'No retry');
    assert.equal(h.calls.filter(c => c.name === VERIFY).length, 1, 'Final verify never runs after rejected commit');
    assert.equal(h.responses.at(-1), 502); assert.equal(h.responses.filter(status => status !== 200).length, 1);
    assert.equal((await jobRow(h.job)).status, 'running'); assert.deepEqual(await rawSidecar(h.job), beforeReceipt, 'Rejected commit cannot refresh/replace a receipt');
    assert.ok(!h.calls.some(c => c.name === 'employee_safety_backup_close')); await assert.rejects(inventory(h.job), /content changed/);
    await assertWorkspacesClean(h); assert.deepEqual([...h.objects], h.storageBefore);
    assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_maintenance'), 0);
    assert.deepEqual(await readFile(h.records.path), originalRecordCipher); assert.equal(h.records.writes, 1); assert.equal(h.media.writes, 1);
    // Retained encrypted files are authenticated evidence of the old snapshot, NOT permission to archive/replace it.
    const calls = h.calls.length;
    await api.withAuthenticatedEmployeeSafetyMediaBackup(h.records, h.media, LOCAL_PASSPHRASE, h.workspace, async reader => {
      clientFlags(reader); flags(reader.inventory); flags(reader.inventory.records_catalog);
      for (const ref of reader.inventory.files) assert.deepEqual(await collectBytes(reader.open(api.employeeSafetyMediaEntryPath(ref))),
        Buffer.from(h.objects.get(ref.bucket + '/' + ref.path)));
    });
    assert.equal(h.calls.length, calls); await assertWorkspacesClean(h); assert.equal(networkCalls, 0);
  }));
