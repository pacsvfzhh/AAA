import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { build } from 'esbuild';
import { replayMigrations, EXPECTED_REPLAY_FAILURES } from './support/replay-migrations.mjs';
import { adminLogin, rpc as baseRpc, rows, scalar } from './support/transfer-harness.mjs';
import { buildNewSite, NEW, PASSWORDS } from './support/transfer-fixtures.mjs';

// Local historical replay + actual anon RPCs, never synthesized jobs/credentials/maintenance.
// Privileged fixture edits below restore every original trigger mode. No Storage/media success
// is simulated: this contract is records_only, NOT an archive/replacement/full employee backup.
const MIGRATION = '20261102000046_backup_employee_before_restore.sql';
const BEGIN = 'employee_safety_backup_begin', CATALOG = 'get_employee_safety_backup_catalog';
const PAGE = 'get_employee_safety_backup_page', VERIFY = 'employee_safety_backup_verify', CLOSE = 'employee_safety_backup_close';
const CORE = ['accounts', 'credentials', 'orders', 'wallets', 'wallet_balance_baselines', 'wallet_ledger_entries',
  'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit', 'employee_login_history', 'work_sessions',
  'work_stop_markers', 'verification_requests', 'dispatch_group_members', 'employee_submit_time_settings'];
const CHAT = ['simulated_customers', 'cs_message_templates', 'customer_auto_messages', 'rich_card_contents',
  'customer_employee_conversations', 'customer_service_sessions', 'ccc_conversation_annotations', 'customer_auto_message_logs', 'rating_requests', 'service_ratings'];
const NOTIFICATIONS = ['notification_automation_plans', 'notification_automation_tasks', 'notification_automation_plan_members',
  'notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_executions',
  'notification_automation_date_runs', 'notification_automation_failures', 'messages', 'message_recipients', 'message_templates', 'broadcast_messages', 'broadcast_recipients'];
const DISPATCH = ['dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'valid_order_data', 'used_order_data'];
const ARCHIVES = ['content_audit_events', 'content_audit_recipient_versions'];
const TABLES = [...CORE, ...CHAT, ...NOTIFICATIONS, ...DISPATCH, ...ARCHIVES, 'orders_history', 'administrators'];
const id = n => `46000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TARGET = id(1), FOREIGN = id(2), OTHER_ROOT = id(3);
const PRECISE = '12345678901234567890.12345678901234567890', TINY = '0.00000000000000000001';
const TIME = '2024-02-29T03:04:05.123456+00:00', BIG = '9007199254740993';
const PASSPHRASE = 'local-only-independent-records-AES-passphrase';
const HTML = '<p>原文𠮷 é é &amp; &#65;</p>\n第二行';
const MEDIA_REFERENCE = 'https://never-fetch.invalid/records-only.png';
const sha = value => createHash('sha256').update(value).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
const flags = value => {
  for (const [key, expected] of Object.entries({ records_only: true, media_included: false, complete_employee_backup: false,
    can_archive: false, can_replace: false, full_site_complete: false })) assert.equal(value[key], expected, key);
};
let db, replay, modules, session, secondary, emergency, otherRoot, employeeToken;
let sequence = 0, forbiddenNetworkCalls = 0;
const expected = new Map();
const selected = new Map();
const auth = (job, token = session) => ({ p_admin_session_token: token, p_job_token: job.job_token });
const fingerprintArgs = (job, token = session) => ({ ...auth(job, token), p_catalog_fingerprint: job.catalog.fingerprint });
async function transaction(fn, readOnly = false) {
  await db.exec(readOnly ? 'BEGIN; SET TRANSACTION READ ONLY' : 'BEGIN');
  try { return await fn(); } finally { await db.exec('ROLLBACK'); }
}
async function rpc(name, args, role = 'anon') {
  const savepoint = `safety_rpc_${++sequence}`;
  await db.exec(`SAVEPOINT ${savepoint}`);
  try {
    assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
    await db.exec(`SET LOCAL ROLE ${role}`);
    const result = await baseRpc(db, name, args, { role: null });
    await db.exec(`RESET ROLE; RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
    throw error;
  }
}
const begin = (extra = {}) => rpc(BEGIN, { p_admin_session_token: session, p_admin_password: PASSWORDS.root, p_username: 'safety-target', ...extra });
const catalog = (job, token) => rpc(CATALOG, auth(job, token));
const page = (job, key, extra = {}) => rpc(PAGE, { ...fingerprintArgs(job), p_table_key: key, p_after: null, p_limit: 200, ...extra });
const verify = job => rpc(VERIFY, fingerprintArgs(job));
const close = job => rpc(CLOSE, fingerprintArgs(job));
const jobRow = job => scalar(db, 'SELECT to_jsonb(j)::text FROM private.employee_transfer_jobs j WHERE id=$1', [job.job_id]);

// Only for initial local records and rollback-only source drift / clock simulation, never used
// to create or alter task tokens, ownership, protocol, summary, password hashes, or maintenance.
async function change(relation, sql, args = []) {
  const point = `safety_fixture_${++sequence}`;
  await db.exec(`SAVEPOINT ${point}`);
  try {
    const triggers = await rows(db, 'SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [relation]);
    for (const t of triggers) await db.exec(`ALTER TABLE ${relation} DISABLE TRIGGER "${t.tgname}"`);
    await db.query(sql, args);
    for (const t of triggers) await db.exec(`ALTER TABLE ${relation} ${t.tgenabled === 'A' ? 'ENABLE ALWAYS' : t.tgenabled === 'R' ? 'ENABLE REPLICA' : t.tgenabled === 'D' ? 'DISABLE' : 'ENABLE'} TRIGGER "${t.tgname}"`);
    await db.exec(`RELEASE SAVEPOINT ${point}`);
  } catch (error) {
    await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
    throw error;
  }
}
async function snapshot() {
  const names = (await rows(db, `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('public','private') AND c.relkind IN ('r','p') ORDER BY 1`)).map(r => r.name);
  return rows(db, names.map(name => `SELECT '${name}' AS name,count(*)::int AS n,
    md5(COALESCE(string_agg(to_jsonb(r)::text,'' ORDER BY to_jsonb(r)::text),'')) AS digest FROM ${name} r`).join(' UNION ALL '));
}
const triggerModes = () => rows(db, 'SELECT tgrelid::regclass::text AS relation,tgname,tgenabled FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2');
async function seedCore(user, base) {
  const marker = user === TARGET ? HTML : 'FOREIGN-PRIVATE-RECORD';
  await db.query(`INSERT INTO public.users(id,username,employee_id,password_hash,created_by)
    VALUES($1,$2,$3,extensions.crypt($4,extensions.gen_salt('bf',4)),$5)`,
  [user, user === TARGET ? 'safety-target' : 'safety-foreign', `LOCAL-${base}`, PASSWORDS.employee, NEW.root]);
  await db.query('INSERT INTO public.financial_employee_credentials(user_id,password_hash) SELECT id,password_hash FROM public.users WHERE id=$1', [user]);
  await change('public.users', `UPDATE public.users SET remarks=$2,total_income=$3::numeric,tags=ARRAY['原文',NULL],created_at=$4,updated_at=NULL WHERE id=$1`, [user, marker, PRECISE, TIME]);
  await change('public.wallets', 'UPDATE public.wallets SET available_balance=$2::numeric,frozen_balance=$3::numeric,created_at=$4,updated_at=NULL WHERE user_id=$1', [user, PRECISE, TINY, TIME]);
  await change('public.wallet_balance_baselines', `INSERT INTO public.wallet_balance_baselines(user_id,available_balance,frozen_balance,total_income,last_ledger_id,established_at)
    VALUES($1,$2::numeric,$3::numeric,$2::numeric,0,$4) ON CONFLICT(user_id) DO UPDATE SET available_balance=EXCLUDED.available_balance,
    frozen_balance=EXCLUDED.frozen_balance,total_income=EXCLUDED.total_income,established_at=EXCLUDED.established_at`, [user, PRECISE, TINY, TIME]);
  for (const [i, ledger] of (user === TARGET ? ['2', '10', BIG] : ['9007199254741993']).entries()) {
    await change('public.wallet_ledger_entries', `INSERT INTO public.wallet_ledger_entries(id,user_id,operation_id,source_type,source_id,event_type,available_delta,frozen_delta,income_delta,created_at)
      VALUES($1::bigint,$2,$3,'wallet_transaction',$4,'local-fixture',$5::numeric,$6::numeric,0,$7)`, [ledger, user, id(base + 10 + i), id(base + 20), PRECISE, TINY, TIME]);
  }
  await change('public.wallet_transactions', `INSERT INTO public.wallet_transactions(id,user_id,type,amount,balance_before,balance_after,remarks,created_by,created_at)
    VALUES($1,$2,'manual_adjustment',$3::numeric,0,$3::numeric,$4,$5,$6)`, [id(base + 20), user, PRECISE, marker, NEW.root, TIME]);
  await change('public.withdrawals', `INSERT INTO public.withdrawals(id,user_id,amount,status,audit_remark,created_at)
    VALUES($1,$2,$3::numeric,'pending',$4,$5)`, [id(base + 21), user, TINY, marker, TIME]);
  await change('public.wallet_reconciliation_audit', `INSERT INTO public.wallet_reconciliation_audit(id,user_id,available_before,available_after,frozen_before,frozen_after,income_before,income_after,pending_amount,ledger_total,reason,repaired_at)
    VALUES($1::bigint,$2,0,$3::numeric,0,$4::numeric,0,0,$4::numeric,$3::numeric,$5,$6)`, [String(base), user, PRECISE, TINY, marker, TIME]);
  await change('public.orders', `INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status,commission_amount,commission_rate,created_at,processed_at)
    SELECT $1,id,username,$3,42,'EXCLUDED-DETAILED-ORDER-'||$4::text,'EXCLUDED-DETAILED-TX-'||$4::text,'success',$5::numeric,0.01234567890123456789,$6,$6 FROM public.users WHERE id=$2`,
  [id(base + 30), user, NEW.product, base, PRECISE, TIME]);
  await change('public.orders_history', `INSERT INTO public.orders_history(id,user_id,product_type_id,product_value,transaction_id,status,commission_amount,created_at,updated_at,completed_at)
    VALUES($1,$2,$3,42,'EXCLUDED-HISTORY-TX-'||$4::text,'failure',$5::numeric,$6,$6,$6)`, [id(base + 31), user, NEW.product, base, PRECISE, '2026-02-28T03:04:05.123456+00:00']);
  for (const [i, device] of ['NULL', "'null'::jsonb", `'{"browser":"Chromium","amount":${PRECISE}}'::jsonb`].entries()) {
    await change('public.employee_login_history', `INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type,session_id,device_info,created_at)
      SELECT $1,id,username,employee_id,'login','EXCLUDED-LIVE-SESSION',${device},$3 FROM public.users WHERE id=$2`, [id(base + 40 + i), user, TIME]);
  }
  await change('public.work_sessions', `INSERT INTO public.work_sessions(id,user_id,start_time,end_time,duration_minutes,last_heartbeat_at,created_at)
    VALUES($1,$2,$3,$3,321,$3,$3)`, [id(base + 50), user, TIME]);
  await change('private.employee_work_stop_markers', 'INSERT INTO private.employee_work_stop_markers(user_id,stopped_at) VALUES($1,$2)', [user, TIME]);
  await change('public.verification_requests', `INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status,id_front_url,created_at,updated_at)
    VALUES($1,$2,$3,'LOCAL-ID','555','原地址','approved',$4,$5,NULL)`, [id(base + 60), user, marker, MEDIA_REFERENCE, TIME]);
  await db.query('INSERT INTO public.dispatch_group_members(id,group_id,user_id,assigned_by,assigned_at) VALUES($1,$2,$3,$4,$5)',
    [id(base + 70), NEW.groupA, user, NEW.root, TIME]);
  await db.query('INSERT INTO public.employee_submit_time_settings(id,user_id,min_seconds,max_seconds,created_at) VALUES($1,$2,3,299,$3)', [id(base + 80), user, TIME]);
  await change('public.valid_order_data', `INSERT INTO public.valid_order_data(id,product_value,transaction_id,created_by,usage_count,created_at)
    VALUES($1,$2::numeric,$3,$4,8,$5)`, [id(base + 90), PRECISE, `local-valid-${base}`, NEW.root, TIME]);
  await change('public.used_order_data', 'INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at) VALUES($1,$2,$3,$4,$5)',
    [id(base + 91), user, id(base + 90), id(base + 30), TIME]);
}
async function seedChat() {
  await db.query(`INSERT INTO public.simulated_customers(id,admin_id,customer_name,customer_id,source_type,target_employee_ids,custom_avatar_url)
    VALUES($1,$3,'Shared role','LOCAL-SHARED','ccc_service',ARRAY[$4,$5]::uuid[],$6),
      ($2,$3,'Foreign only','LOCAL-FOREIGN','aaa_service',ARRAY[$5]::uuid[],NULL)`, [id(300), id(301), NEW.root, TARGET, FOREIGN, MEDIA_REFERENCE]);
  await db.query(`INSERT INTO public.cs_message_templates(id,admin_id,name,content,content_type,source_type,created_at)
    VALUES($1,$3::text,'Selected template',$4,'rich_card','ccc_service',$5),($2,$3::text,'Unrelated template','FOREIGN-LIBRARY','richtext','aaa_service',$5)`, [id(310), id(311), NEW.root, HTML, TIME]);
  await db.query(`INSERT INTO public.customer_auto_messages(id,customer_id,admin_id,message_type,name,content,content_type)
    VALUES($1,$3,$5::text,'quick_send','Selected auto','original auto','text'),($2,$4,$5::text,'quick_send','Foreign auto','FOREIGN-AUTO','text')`, [id(320), id(321), id(300), id(301), NEW.root]);
  await db.query(`INSERT INTO public.rich_card_contents(id,html_content,source_template_id,content_hash,created_at)
    VALUES($1,$3,$4,md5($3),$5),($2,'FOREIGN-CARD',NULL,md5('FOREIGN-CARD'),$5)`, [id(330), id(331), HTML, id(310), TIME]);
  for (const [user, base] of [[TARGET, 340], [FOREIGN, 350]]) {
    await change('public.customer_employee_conversations', `INSERT INTO public.customer_employee_conversations(id,customer_id,employee_id,sender_type,message_content,message_type,source_type,rating_data,rich_card_content_id,source_template_id,created_at)
      VALUES($1,$2,$3,'customer',$4,'rich_card','ccc_service',('{"amount":'||$5::text||'}')::jsonb,$6,$7,$8)`, [id(base), id(300), user, user === TARGET ? HTML : 'FOREIGN-CHAT', PRECISE, id(330), id(310), TIME]);
    await db.query(`INSERT INTO public.customer_service_sessions(id,customer_id,employee_id,service_ticket_number,status,created_at,closed_at)
      VALUES($1,$2,$3,$4,'closed',$5,$5)`, [id(base + 1), id(300), user, `LOCAL-TICKET-${base}`, TIME]);
    await db.query(`INSERT INTO public.ccc_conversation_annotations(customer_id,employee_id,owner_admin_id,note,updated_by,updated_at)
      VALUES($1,$2,$3,$4,$3,$5)`, [id(300), user, NEW.root, user === TARGET ? HTML : 'FOREIGN-NOTE', TIME]);
    await db.query('INSERT INTO public.customer_auto_message_logs(id,customer_id,employee_id,auto_message_id,sent_at) VALUES($1,$2,$3,$4,$5)', [id(base + 2), id(300), user, id(320), TIME]);
    await db.query(`INSERT INTO public.rating_requests(id,customer_id,employee_id,session_id,status,requested_at) VALUES($1,$2,$3,$4,'pending',$5)`, [id(base + 3), id(300), user, id(base + 1), TIME]);
    await db.query('INSERT INTO public.service_ratings(id,customer_id,employee_id,session_id,rating,comment,created_at) VALUES($1,$2,$3,$4,5,$5,$6)', [id(base + 4), id(300), user, id(base + 1), HTML, TIME]);
  }
}
async function seedNotifications() {
  await db.query(`INSERT INTO public.notification_automation_plans(id,owner_admin_id,name,status,created_at) VALUES($1,$2,'Shared plan','paused',$3)`, [id(400), NEW.root, TIME]);
  for (const [task, name, plan] of [[401, 'Selected child', 400], [402, 'Parent template', null], [403, 'Ancestor template', null], [404, 'Foreign task', null]]) {
    await db.query(`INSERT INTO public.notification_automation_tasks(id,owner_admin_id,name,trigger_type,trigger_mode,threshold_value,
      title_template,content_template,recipient_scope,status,source_task_id,plan_id,is_shared_template)
      VALUES($1,$2,$3,'total_orders','reach_once',2,'Original title',$4,'selected','paused',$5,$6,$7)`,
    [id(task), NEW.root, name, HTML, null, plan ? id(plan) : null, task === 402 || task === 403]);
  }
  // Parents are inserted after the child; assign their real FK links only once all exist.
  await change('public.notification_automation_tasks', 'UPDATE public.notification_automation_tasks SET source_task_id=$2 WHERE id=$1', [id(401), id(402)]);
  await change('public.notification_automation_tasks', 'UPDATE public.notification_automation_tasks SET source_task_id=$2 WHERE id=$1', [id(402), id(403)]);
  for (const [user, base] of [[TARGET, 420], [FOREIGN, 430]]) {
    await db.query('INSERT INTO public.notification_automation_plan_members(plan_id,user_id,created_at) VALUES($1,$2,$3)', [id(400), user, TIME]);
    await db.query('INSERT INTO public.notification_automation_task_recipients(task_id,user_id,created_at) VALUES($1,$2,$3)', [id(401), user, TIME]);
    await change('public.notification_automation_progress', `INSERT INTO public.notification_automation_progress(task_id,user_id,last_metric,last_stage,last_period_key,updated_at)
      VALUES($1,$2,$3::numeric,$4::bigint,'all_time',$5)`, [id(401), user, PRECISE, BIG, TIME]);
    await db.query(`INSERT INTO public.notification_automation_executions(id,task_id,task_version,owner_admin_id,user_id,employee_username,period_key,stage,actual_value,
      trigger_snapshot,title_snapshot,content_snapshot,status,error_message,executed_at,completed_at,plan_id)
      VALUES($1,$2,1,$3,$4,'Historical username','all_time',$5::bigint,$6::numeric,
      '{"trigger_type":"total_orders","trigger_mode":"reach_once","threshold_value":2,"minimum_daily_orders":null,"minimum_daily_work_minutes":null}',
      'original title',$7,'failed','EXCLUDED-RAW-DIAGNOSTIC',$8,$8,$9)`, [id(base), id(401), NEW.root, user, BIG, PRECISE, HTML, TIME, id(400)]);
    await db.query(`INSERT INTO public.notification_automation_failures(task_id,user_id,owner_admin_id,attempts,last_error,first_failed_at,last_failed_at)
      VALUES($1,$2,$3,3,'EXCLUDED-RAW-DIAGNOSTIC',$4,$4)`, [id(401), user, NEW.root, TIME]);
  }
  await db.query('INSERT INTO public.notification_automation_task_recipients(task_id,user_id) VALUES($1,$2)', [id(404), FOREIGN]);
  for (const period of ['a', 'Z', 'a:1', '_']) await db.query(`INSERT INTO public.notification_automation_date_runs(task_id,task_version,period_key,created_at) VALUES($1,7,$2,$3)`, [id(401), period, TIME]);
  await db.query(`INSERT INTO public.messages(id,sender_id,sender_username,title,content,message_type,priority,audit_origin,delivery_mode,created_at)
    VALUES($1,$3,'root','Shared notification',$4,'realtime','normal','manual_admin','realtime_only',$5),
      ($2,$3,'root','Foreign only notification','FOREIGN-NOTIFICATION','realtime','normal','manual_admin','realtime_only',$5)`, [id(440), id(441), NEW.root, HTML, TIME]);
  for (const [recipient, message, user] of [[450, 440, TARGET], [451, 440, FOREIGN], [452, 441, FOREIGN]]) {
    await db.query(`INSERT INTO public.message_recipients(id,message_id,recipient_id,created_at) VALUES($1,$2,$3,$4)`, [id(recipient), id(message), user, TIME]);
  }
  await db.query(`INSERT INTO public.message_templates(id,admin_id,name,title,content,message_type,priority,delivery_mode)
    VALUES($1,$2,'Selected notification template','Original',$3,'realtime','normal','realtime_only')`, [id(460), NEW.root, HTML]);
  await db.query(`INSERT INTO public.broadcast_messages(id,admin_id,message_content,message_type,target_type,created_at)
    VALUES($1,$2,$3,'text','all',$4)`, [id(470), NEW.root, HTML, TIME]);
  for (const [recipient, user] of [[471, TARGET], [472, FOREIGN]]) await db.query('INSERT INTO public.broadcast_recipients(id,broadcast_id,employee_id,created_at) VALUES($1,$2,$3,$4)', [id(recipient), id(470), user, TIME]);
}
async function oracle() {
  if (expected.size === TABLES.length) return;
  // Independent scope oracle: use reviewed domain projections (not SQL46's selection/query),
  // exact explicit fixture IDs for shared dependencies, and direct employee predicates.
  for (const [key, ids] of Object.entries({ simulated_customers: [id(300)], cs_message_templates: [id(310)], customer_auto_messages: [id(320)],
    rich_card_contents: [id(330)], notification_automation_plans: [id(400)], notification_automation_tasks: [id(401), id(402), id(403)],
    messages: [id(440)], message_templates: [id(460)], broadcast_messages: [id(470)], dispatch_groups: [NEW.groupA],
    valid_order_data: [id(1090)] })) selected.set(key, ids);
  for (const key of TABLES) {
    let query, filter, params = [TARGET];
    if (CORE.includes(key)) {
      query = await scalar(db, 'SELECT private.employee_transfer_replacement_backup_query($1)', [key]); filter = 'true';
    } else if (key === 'orders_history') {
      query = `SELECT id,jsonb_build_object('id',id,'user_id',user_id,'status',status,'commission_amount',commission_amount,
        'created_at',created_at,'completed_at',completed_at) AS body FROM public.orders_history WHERE user_id=$1 AND status IN ('success','failure')`; filter = 'true';
    } else if (key === 'administrators') {
      query = `SELECT id,jsonb_build_object('id',id,'username',username,'role',role,'parent_id',parent_id,'created_at',created_at,'updated_at',updated_at) AS body FROM public.admins WHERE $1::uuid IS NOT NULL`; filter = 'true';
    } else {
      const domain = CHAT.includes(key) ? 'chat' : NOTIFICATIONS.includes(key) ? 'notifications' : DISPATCH.includes(key) ? 'dispatch' : 'archives';
      query = await scalar(db, `SELECT private.employee_transfer_${domain}_query($1)`, [key]);
      if (selected.has(key)) { filter = 'id::text=ANY($2::text[])'; params.push(selected.get(key)); }
      else if (['dispatch_order_pools', 'dispatch_group_orders'].includes(key)) { filter = "body->>'group_id'=$2::text"; params.push(NEW.groupA); }
      else if (key === 'dispatch_config') filter = 'true';
      else if (key === 'notification_automation_date_runs') { filter = "body->>'task_id'=$2::text"; params.push(id(401)); }
      else filter = `body->>'${CHAT.includes(key) || key === 'content_audit_events' || key === 'broadcast_recipients' ? 'employee_id'
        : key === 'message_recipients' || key === 'content_audit_recipient_versions' ? 'recipient_id' : 'user_id'}'=$1::text`;
    }
    const order = ['wallet_ledger_entries', 'wallet_reconciliation_audit'].includes(key) ? 'id::bigint' : 'id::text COLLATE "C"';
    expected.set(key, (await rows(db, `SELECT body::text||E'\n' AS line FROM (${query}) r WHERE $1::uuid IS NOT NULL AND (${filter}) ORDER BY ${order}`, params)).map(r => r.line).join(''));
    assert.ok(expected.get(key).length, `fixture must exercise nonempty ${key}`);
  }
}
async function collect(job, key, limit = 2) {
  let after = null, text = '', previous = null;
  do {
    const p = await page(job, key, { p_after: after, p_limit: limit });
    assert.equal(p.sha256, sha(p.ndjson)); assert.equal(p.bytes, Buffer.byteLength(p.ndjson)); assert.equal(p.count, lines(p.ndjson).length);
    assert.equal(p.fingerprint, job.catalog.fingerprint); assert.equal(p.table_key, key); assert.ok(p.count <= limit);
    for (const line of lines(p.ndjson)) {
      const current = JSON.parse(line).id;
      if (previous !== null) assert.ok(['wallet_ledger_entries', 'wallet_reconciliation_audit'].includes(key) ? BigInt(current) > BigInt(previous) : current > previous);
      previous = current;
    }
    if (p.next_after !== null) { assert.equal(p.next_after, previous); assert.notEqual(p.next_after, after); }
    text += p.ndjson; after = p.next_after;
  } while (after !== null);
  const table = job.catalog.tables.find(t => t.key === key);
  assert.equal(table.rows, lines(text).length); assert.equal(table.bytes, Buffer.byteLength(text));
  assert.equal(table.row_hashes_sha256, sha(lines(text).map(sha).join('')));
  return text;
}
async function rejectAccess(job, token, pattern = /session|permission|invalid|expired/i) {
  for (const [name, args] of [[CATALOG, auth(job, token)], [PAGE, { ...fingerprintArgs(job, token), p_table_key: 'accounts' }],
    [VERIFY, fingerprintArgs(job, token)], [CLOSE, fingerprintArgs(job, token)]]) await assert.rejects(rpc(name, args), pattern, name);
}
async function* disk(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(65521);
    for (;;) { const read = await handle.read(buffer); if (!read.bytesRead) return; yield Buffer.from(buffer.subarray(0, read.bytesRead)); }
  } finally { await handle.close(); }
}
async function bytes(stream) { const parts = []; for await (const raw of stream) parts.push(Buffer.from(raw)); return Buffer.concat(parts); }
async function clientDisk(t) {
  const dir = await mkdtemp(join(tmpdir(), 'employee-safety-real-sql46-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const h = { token: session, calls: [], workspaces: [], events: [], writes: 0, opens: 0, path: join(dir, 'independent.edx') };
  h.rpc = (name, args) => {
    assert.ok([BEGIN, CATALOG, PAGE, VERIFY, CLOSE].includes(name), `no cancel/delete/maintenance RPC: ${name}`);
    const query = { signal: null, abortSignal(signal) { query.signal = signal; return query; }, then(resolve, reject) {
      return Promise.resolve().then(async () => {
        assert.notEqual(query.signal?.aborted, true); h.calls.push(name); h.events.push(name);
        // A real anon database call, never a synthesized RPC response or owner receipt.
        return { data: await rpc(name, args), error: null };
      }).then(resolve, reject);
    } }; return query;
  };
  h.workspace = () => {
    const base = join(dir, `plaintext-${h.workspaces.length}`);
    const w = { base, cleaned: false, cleanups: 0,
      async append(path, raw, signal) {
        assert.equal(w.cleaned, false); assert.notEqual(signal?.aborted, true);
        assert.ok(path === modules.EMPLOYEE_SAFETY_BACKUP_CATALOG_PATH || TABLES.some(key => path === modules.employeeSafetyBackupEntryPath(key)));
        await mkdir(dirname(join(base, path)), { recursive: true }); await appendFile(join(base, path), raw);
      },
      open(path) { assert.equal(w.cleaned, false); return disk(join(base, path)); },
      async abort() { w.cleaned = true; w.cleanups++; h.events.push('plaintext-cleanup'); await rm(base, { recursive: true, force: true }); },
    }; h.workspaces.push(w); return w;
  };
  h.file = {
    async write(stream, signal) {
      h.writes++; h.events.push('write'); const handle = await open(h.path, 'wx');
      try { for await (const raw of stream) { assert.equal(signal.aborted, false); await handle.writeFile(raw); } await handle.sync(); }
      finally { await handle.close(); }
      h.events.push('saved'); if (h.afterWrite) await h.afterWrite();
    },
    open() { h.opens++; h.events.push('open'); return disk(h.path); },
  };
  modules.setHarness(h); h.session = modules.createEmployeeSafetyBackupSession('safety-target', PASSWORDS.root);
  h.begin = await h.session.begin();
  await oracle();
  h.info = { scope: 'replacement-backup', sourceSiteId: h.begin.site_id, exportId: randomUUID(), volumeId: randomUUID(),
    volumeIndex: 1, volumeCount: 1, createdAt: new Date(TIME).toISOString() };
  h.export = options => modules.exportEmployeeSafetyBackup(h.session, h.file, h.workspace, PASSPHRASE, h.info, options);
  return h;
}
function assertClean(h) {
  for (const w of h.workspaces) { assert.equal(w.cleaned, true); assert.equal(w.cleanups, 1); }
}

before(async () => {
  for (const [module, name] of [[globalThis, 'fetch'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net, 'connect'], [net, 'createConnection'], [net.Socket.prototype, 'connect'], [tls, 'connect'], [dgram, 'createSocket']]) {
    mock.method(module, name, () => { forbiddenNetworkCalls++; assert.fail('All network and production services are forbidden'); });
  }
  replay = await replayMigrations({ upTo: MIGRATION, strict: true }); db = replay.db;
  await db.exec('BEGIN');
  try {
    await buildNewSite(db);
    await db.query(`INSERT INTO public.admins(id,username,password_hash,role,is_active)
      VALUES($1,'safety-other-root',extensions.crypt($2,extensions.gen_salt('bf',4)),'super_admin',true)`, [OTHER_ROOT, PASSWORDS.root]);
    await db.query('INSERT INTO public.financial_admin_credentials(admin_id,password_hash) SELECT id,password_hash FROM public.admins WHERE id=$1', [OTHER_ROOT]);
    await db.query("INSERT INTO public.product_types(id,name) VALUES($1,'Local-only safety fixture')", [NEW.product]);
    await seedCore(TARGET, 1000); await seedCore(FOREIGN, 2000);
    await seedChat(); await seedNotifications();
    await db.query(`INSERT INTO public.dispatch_group_orders(id,group_id,pool_id,order_content,created_by)
      SELECT $1,group_id,id,$2,$3 FROM public.dispatch_order_pools WHERE group_id=$4 AND is_base`, [id(500), HTML, NEW.root, NEW.groupA]);
    for (const user of [TARGET, FOREIGN]) await db.query(`INSERT INTO private.content_audit_events(id,operation_id,entity_type,entity_id,action,owner_admin_id,
      actor_admin_id,actor_username,actor_role,employee_id,before_data,occurred_at)
      VALUES($1,$2,'ccc_service',$3,'edit',$4,$4,'root','super_admin',$5,('{"amount":'||$6::text||'}')::jsonb,$7)`,
    [id(user === TARGET ? 510 : 511), randomUUID(), id(340), NEW.root, user, PRECISE, TIME]);
    session = await adminLogin(db, 'root', PASSWORDS.root); secondary = await adminLogin(db, 'branch', PASSWORDS.branch);
    emergency = await adminLogin(db, 'emergency', PASSWORDS.emergency); otherRoot = await adminLogin(db, 'safety-other-root', PASSWORDS.root);
    const login = await baseRpc(db, 'create_employee_financial_session', { p_username: 'safety-foreign', p_password: PASSWORDS.employee, p_tab_id: 'local-only-tab' });
    assert.equal(login.success, true); employeeToken = login.session_token;
    await db.exec('COMMIT');
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
  const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/employeeSafetyBackup.ts';
      export {readTransferMetadata} from './src/lib/employeeTransfer/crypto.ts'; export {setHarness} from 'safety-db:state';`,
    resolveDir: fileURLToPath(new URL('../../', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', metafile: true,
  plugins: [{ name: 'only-local-anon-pglite', setup(builder) {
    builder.onResolve({ filter: /^(?:safety-db:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'safety-db' }));
    builder.onLoad({ filter: /.*/, namespace: 'safety-db' }, ({ path }) => ({ contents: path === 'safety-db:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth' ? 'import{current}from"safety-db:state";export const getAdminFinancialSessionToken=()=>current().token;'
        : 'import{current}from"safety-db:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' }));
  } }] });
  assert.ok(!Object.keys(compiled.metafile.inputs).some(path => /node_modules\/@supabase|src\/lib\/(?:supabase|auth)\.ts/.test(path)));
  modules = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
}, { timeout: 600000 });
after(async () => { try { if (db) await db.close(); } finally { mock.restoreAll(); } });

test('all historical migrations through SQL46 replay with exactly the twelve known failures', () => {
  assert.equal(replay.files.at(-1), MIGRATION); assert.equal(replay.failures.length, 12);
  assert.deepEqual(replay.failures, EXPECTED_REPLAY_FAILURES.map(({ file, message }) => ({ file, message })));
  assert.equal(replay.validation.freshDatabaseVerified, false); assert.equal(TABLES.length, 48);
});
test('SQL46 physical dependencies exist in the strict historical replay, without adding synthetic columns', () => transaction(async () => {
  const actual = await scalar(db, `SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)) FROM pg_attribute
    WHERE attrelid='public.orders_history'::regclass AND attnum>0 AND NOT attisdropped`);
  const spec = { id: 'uuid!', user_id: 'uuid!', status: 'text!', commission_amount: 'numeric',
    created_at: 'timestamp with time zone', completed_at: 'timestamp with time zone' };
  const mismatches = Object.entries(spec).filter(([column, type]) => actual[column] !== type.replace(/!$/, ''))
    .map(([column, type]) => `${column}: expected ${type}, actual ${actual[column] ?? 'MISSING'}`);
  assert.deepEqual(mismatches, [], `SQL46 orders_history schema guard rejects real begin: ${mismatches.join('; ')}`);
}));
test('all 48 SQL46 raw projection queries execute on real fixtures without a fabricated owner task', () => transaction(async () => {
  const errors = [];
  for (const key of TABLES) {
    const point = `projection_${++sequence}`; await db.exec(`SAVEPOINT ${point}`);
    try {
      const query = await scalar(db, 'SELECT private.employee_safety_backup_query($1)', [key]);
      await rows(db, `SELECT body::text FROM (${query}) projected`, [TARGET]);
      await db.exec(`RELEASE SAVEPOINT ${point}`);
    } catch (error) {
      await db.exec(`ROLLBACK TO SAVEPOINT ${point}; RELEASE SAVEPOINT ${point}`);
      errors.push({ key, code: error.code, message: error.message });
    }
  }
  assert.deepEqual(errors, [], 'SQL46 projection contract errors (no jobs/credentials/maintenance were forged)');
}));
test('real begin succeeds before any maintenance/configuration mutation; old backup owner cannot consume its token', () => transaction(async () => {
  const before = await snapshot(), job = await begin(); assert.equal(job.success, true); flags(job.catalog);
  assert.equal(job.catalog.employee_id, TARGET); assert.equal(job.catalog.username, 'safety-target');
  const record = JSON.parse(await jobRow(job)); assert.equal(record.kind, 'export'); assert.equal(record.status, 'running');
  assert.equal(record.options.export_protocol, 'employee-safety-records-v1'); assert.equal(record.options.employee_id, TARGET);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_maintenance'), 0);
  await assert.rejects(rpc('get_employee_import_replacement_backup', { ...auth(job), p_source_employee_id: TARGET }), /invalid|protocol|expired|maintenance|import/i);
  const after = await snapshot(), changed = after.filter((r, i) => r.digest !== before[i].digest || r.n !== before[i].n).map(r => r.name);
  assert.deepEqual(changed.sort(), ['private.employee_transfer_events', 'private.employee_transfer_jobs']);
}));
test('all 48 exact keys return original SQL text, byte counts, row hashes and ordered multi-page cursors', { timeout: 180000 }, () => transaction(async () => {
  const job = await begin(); await oracle(); assert.deepEqual(job.catalog.tables.map(t => t.key), TABLES);
  assert.deepEqual(modules.EMPLOYEE_SAFETY_BACKUP_TABLE_KEYS, TABLES);
  assert.deepEqual(modules.validateEmployeeSafetyBackupCatalog(job.catalog), job.catalog);
  const clientErrors = [];
  for (const key of TABLES) {
    const text = await collect(job, key); assert.equal(text, expected.get(key), key);
    for (const line of lines(text)) {
      try { modules.validateEmployeeSafetyBackupRow(line, key, job.catalog); }
      catch (error) { clientErrors.push({ key, error: error.message }); break; }
    }
  }
  const raw = await scalar(db, "SELECT ($1::jsonb-'fingerprint')::text", [JSON.stringify(job.catalog)]);
  assert.equal(job.catalog.fingerprint, sha(raw)); flags(await verify(job));
  assert.deepEqual(clientErrors, [], 'Client must accept original SQL46 records from all 48 tables');
}));
test('shared role/template/task ancestors/group dependencies are selected without other employee chat, recipients or progress', () => transaction(async () => {
  const job = await begin(); await oracle();
  for (const key of ['simulated_customers', 'cs_message_templates', 'customer_auto_messages', 'rich_card_contents', 'notification_automation_tasks',
    'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders', 'customer_employee_conversations', 'message_recipients',
    'notification_automation_progress', 'broadcast_recipients', 'content_audit_recipient_versions']) assert.equal(await collect(job, key), expected.get(key), key);
  const tasks = JSON.parse((await page(job, 'notification_automation_tasks')).ndjson.split('\n')[0]); assert.ok([id(401), id(402), id(403)].includes(tasks.id));
  const all = [...expected.values()].join(''); assert.ok(all.includes(MEDIA_REFERENCE));
  assert.doesNotMatch(all, /FOREIGN-CHAT|FOREIGN-PRIVATE-RECORD|FOREIGN-NOTIFICATION|FOREIGN-NOTE|FOREIGN-CARD|FOREIGN-LIBRARY/);
}));
test('precision/microseconds/SQL-null and JSON-null survive; administrator passwords, live sessions and detailed orders are excluded', () => transaction(async () => {
  const job = await begin(), wallet = await collect(job, 'wallets'), login = await collect(job, 'employee_login_history');
  assert.ok(wallet.includes(PRECISE)); assert.ok(wallet.includes(TINY)); assert.ok(wallet.includes(TIME));
  const devices = lines(login).map(line => JSON.parse(line));
  assert.deepEqual(devices.map(r => r.device_info_is_sql_null), [true, false, false]); assert.equal(devices[1].device_info, null);
  assert.doesNotMatch(login, /EXCLUDED-LIVE-SESSION/);
  for (const key of ['orders', 'orders_history']) {
    const text = await collect(job, key); assert.doesNotMatch(text, /EXCLUDED-|product_value|order_number|transaction_id|product_type_id/);
    const fields = key === 'orders_history'
      ? ['id', 'user_id', 'status', 'commission_amount', 'created_at', 'completed_at']
      : ['id', 'user_id', 'status', 'commission_amount', 'commission_rate', 'created_at', 'processed_at'];
    assert.deepEqual(Object.keys(JSON.parse(lines(text)[0])).sort(), fields.sort());
  }
  const admins = await collect(job, 'administrators'); assert.doesNotMatch(admins, /password|token|\$2[aby]\$/i);
  for (const row of lines(admins).map(JSON.parse)) assert.deepEqual(Object.keys(row).sort(), ['id', 'username', 'role', 'parent_id', 'created_at', 'updated_at'].sort());
}));

for (const [name, relation, sql, args] of [
  ['same-count chat text', 'public.customer_employee_conversations', "UPDATE public.customer_employee_conversations SET message_content='changed but same count' WHERE id=$1", [id(340)]],
  ['added personal row', 'public.employee_login_history', "INSERT INTO public.employee_login_history(id,user_id,username,employee_id,action_type) VALUES($1,$2,'safety-target','LOCAL-1000','login')", [id(9991), TARGET]],
  ['deleted personal row', 'public.employee_login_history', 'DELETE FROM public.employee_login_history WHERE id=$1', [id(1040)]],
  ['shared role setting', 'public.simulated_customers', "UPDATE public.simulated_customers SET remarks='same-count dependency change' WHERE id=$1", [id(300)]],
  ['ancestor task setting', 'public.notification_automation_tasks', "UPDATE public.notification_automation_tasks SET title_template='parent drift' WHERE id=$1", [id(403)]],
  ['dispatch group setting', 'public.dispatch_groups', 'UPDATE public.dispatch_groups SET dispatch_success_rate=dispatch_success_rate-1 WHERE id=$1', [NEW.groupA]],
]) test(`source drift (${name}) blocks catalog, EVERY table page, verify and close without ending job`, { timeout: 180000 }, () => transaction(async () => {
  const job = await begin(); await change(relation, sql, args); const before = await jobRow(job);
  await assert.rejects(catalog(job), /content changed/i);
  for (const key of TABLES) await assert.rejects(page(job, key), /content changed/i, key);
  await assert.rejects(verify(job), /content changed/i); await assert.rejects(close(job), /content changed/i);
  assert.equal(await jobRow(job), before);
}));
test('foreign private text changes do not invalidate this employee snapshot', () => transaction(async () => {
  const job = await begin(); await change('public.customer_employee_conversations', "UPDATE public.customer_employee_conversations SET message_content='foreign changed' WHERE id=$1", [id(350)]);
  assert.deepEqual(await catalog(job), job.catalog); assert.equal((await verify(job)).verified, true);
}));
test('a processing order rejects real begin atomically, with no task/event residue', () => transaction(async () => {
  await change('public.orders', "UPDATE public.orders SET status='processing',commission_amount=NULL,processed_at=NULL WHERE id=$1", [id(1030)]);
  const before = await snapshot(); await assert.rejects(begin(), /processing orders/i); assert.deepEqual(await snapshot(), before);
}));
test('wrong second password creates no task and records only a real failed authentication attempt', () => transaction(async () => {
  const before = await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_jobs');
  assert.equal((await begin({ p_admin_password: 'wrong-local-password' })).success, false);
  assert.equal(await scalar(db, 'SELECT count(*)::int FROM private.employee_transfer_jobs'), before);
  assert.equal(await scalar(db, "SELECT failed_attempts FROM public.financial_login_attempts WHERE username='root' AND account_type='admin'"), 1);
}));
for (const [name, token] of [['secondary', () => secondary], ['emergency', () => emergency], ['employee', () => employeeToken], ['random session', () => randomUUID()]]) {
  test(`${name} cannot begin or use a super-admin safety task`, () => transaction(async () => {
    await assert.rejects(begin({ p_admin_session_token: token() }), /permission|session|invalid|expired/i);
    const job = await begin(), before = await jobRow(job); await rejectAccess(job, token()); assert.equal(await jobRow(job), before);
  }));
}
test('expired real administrator session is rejected by begin and every reader/close', () => transaction(async () => {
  const job = await begin(); await db.query("UPDATE public.admin_financial_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=private.hash_financial_token($1)", [session]);
  await assert.rejects(begin(), /session|expired|invalid/i); await rejectAccess(job, session);
}));
test('another valid super-admin cannot read, verify or close the owner task', () => transaction(async () => {
  const job = await begin(); await rejectAccess(job, otherRoot, /owner task.*invalid|expired/i);
}));
test('another real export protocol token cannot be used as a safety token', () => transaction(async () => {
  const job = await rpc('employee_export_shared_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  assert.equal(job.success, true); await rejectAccess({ ...job, catalog: { fingerprint: 'a'.repeat(64) } }, session, /owner task.*invalid|expired/i);
}));
for (const [name, sql] of [
  ['idle expiry', "last_activity_at=now()-interval '3 hours 1 second'"], ['absolute expiry', "started_at=now()-interval '12 hours 1 second'"],
]) test(`real task ${name} rejects every reader/close without cleanup`, () => transaction(async () => {
  const job = await begin(); await db.query(`UPDATE private.employee_transfer_jobs SET ${sql} WHERE id=$1`, [job.job_id]);
  const before = await jobRow(job); await rejectAccess(job, session, /owner task.*invalid|expired/i); assert.equal(await jobRow(job), before);
}));
test('a real running task older than two minutes is NOT silently abandoned by safety begin', () => transaction(async () => {
  const job = await rpc('employee_export_shared_begin', { p_admin_session_token: session, p_admin_password: PASSWORDS.root });
  await db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '3 minutes' WHERE id=$1", [job.job_id]);
  const before = await snapshot(); await assert.rejects(begin(), /existing transfer tasks/i); assert.deepEqual(await snapshot(), before);
}));
test('username binding is exact; absent, whitespace and case variants leave no technical task', () => transaction(async () => {
  const before = await snapshot();
  for (const p_username of [null, '', ' safety-target', 'safety-target ', 'SAFETY-TARGET', 'absent']) await assert.rejects(begin({ p_username }), /exact employee username|does not exist/i);
  assert.deepEqual(await snapshot(), before);
}));
test('fingerprint, table-key, page-limit and foreign/noncanonical cursors are fail-closed', () => transaction(async () => {
  const job = await begin();
  for (const p_catalog_fingerprint of [null, '', 'a'.repeat(64)]) {
    await assert.rejects(page(job, 'accounts', { p_catalog_fingerprint }), /fingerprint|changed/i);
    await assert.rejects(rpc(VERIFY, { ...fingerprintArgs(job), p_catalog_fingerprint }), /fingerprint|changed/i);
    await assert.rejects(rpc(CLOSE, { ...fingerprintArgs(job), p_catalog_fingerprint }), /fingerprint|changed/i);
  }
  for (const p_limit of [null, 0, 201]) await assert.rejects(page(job, 'accounts', { p_limit }), /bounds/i);
  await assert.rejects(page(job, 'financial_operations'), /unsupported/i);
  for (const p_after of [FOREIGN, `{${TARGET}}`, 'x'.repeat(513)]) await assert.rejects(page(job, 'accounts', { p_after }), /cursor|bounds/i);
  await assert.rejects(page(job, 'wallet_ledger_entries', { p_after: '02' }), /cursor/i);
}));
test('catalog/page/verify are real READ ONLY calls and do not renew heartbeat', { timeout: 180000 }, () => transaction(async () => {
  const job = await begin(); await db.query("UPDATE private.employee_transfer_jobs SET last_activity_at=now()-interval '10 minutes' WHERE id=$1", [job.job_id]);
  await oracle(); const before = await snapshot(); await db.exec('SET TRANSACTION READ ONLY');
  assert.equal(await scalar(db, "SELECT current_setting('transaction_read_only')"), 'on');
  assert.deepEqual(await catalog(job), job.catalog);
  for (const key of TABLES) assert.equal((await page(job, key)).ndjson, expected.get(key), key);
  assert.equal((await verify(job)).verified, true); assert.deepEqual(await snapshot(), before);
}));
test('only technical jobs/audit change through explicit close; replay after close is rejected', () => transaction(async () => {
  const before = await snapshot(), modes = await triggerModes(), job = await begin();
  await page(job, 'accounts'); await verify(job); assert.equal((await close(job)).success, true);
  assert.equal(JSON.parse(await jobRow(job)).status, 'finished'); await rejectAccess(job, session, /owner task.*invalid|expired/i);
  const after = await snapshot(); assert.deepEqual(after.filter((r, i) => r.digest !== before[i].digest || r.n !== before[i].n).map(r => r.name).sort(),
    ['private.employee_transfer_events', 'private.employee_transfer_jobs']);
  assert.deepEqual(await triggerModes(), modes);
}));

test('real SQL46 client independently saves AES to disk, authenticates/reopens all 48 tables locally and closes only explicitly', { timeout: 180000 }, t => transaction(async () => {
  const before = await snapshot(), h = await clientDisk(t);
  await assert.rejects(h.session.close(h.begin.catalog), modules.EmployeeSafetyBackupError); assert.ok(!h.calls.includes(CLOSE));
  const result = await h.export(); flags(result); assert.equal(result.recordsVerified, true); assert.equal(result.manifest.entries.length, 49);
  const cipher = await readFile(h.path); assert.equal(cipher.length, result.cipherBytes); assert.equal(sha(cipher), result.cipherSha256);
  assert.ok(!cipher.includes(Buffer.from(HTML))); assert.ok(!cipher.includes(Buffer.from(PASSWORDS.employee)));
  assert.ok(h.opens >= 1); assert.equal(h.writes, 1); assert.equal(JSON.parse(await jobRow(h.begin)).status, 'running');
  assert.equal(h.calls.filter(n => n === PAGE).length, 48); assert.equal(h.calls.filter(n => n === VERIFY).length, 2);
  let savedReader, escapedStream; const calls = h.calls.length;
  await modules.withAuthenticatedEmployeeSafetyBackup(h.file, PASSPHRASE, h.workspace, async reader => {
    savedReader = reader; escapedStream = reader.open(modules.employeeSafetyBackupEntryPath('accounts'));
    assert.deepEqual(reader.catalog, result.catalog); assert.equal(reader.manifest.entries.length, 49);
    for (const key of TABLES) assert.equal((await bytes(reader.open(modules.employeeSafetyBackupEntryPath(key)))).toString('utf8'), expected.get(key), key);
    const raw = (await bytes(reader.open(modules.employeeSafetyBackupEntryPath('wallets')))).toString('utf8');
    assert.ok(raw.includes(PRECISE)); assert.ok(raw.includes(TINY)); assert.ok(raw.includes(TIME));
    assert.throws(() => reader.open('../../credentials')); assert.equal(reader.append, undefined);
  });
  assert.equal(h.calls.length, calls, 'authenticated callback is local and issues no RPC');
  assert.throws(() => savedReader.catalog); await assert.rejects(bytes(escapedStream)); assertClean(h);
  const closed = await h.session.close(result.catalog); assert.equal(closed.success, true); assert.equal(h.calls.at(-1), CLOSE);
  assert.equal(JSON.parse(await jobRow(h.begin)).status, 'finished');
  await assert.rejects(h.session.close(result.catalog)); assert.equal(h.calls.filter(n => n === CLOSE).length, 1);
  assert.equal((await stat(h.path)).size, cipher.length, 'no automatic ciphertext deletion');
  const after = await snapshot(); assert.deepEqual(after.filter((r, i) => r.digest !== before[i].digest || r.n !== before[i].n).map(r => r.name).sort(), ['private.employee_transfer_events', 'private.employee_transfer_jobs']);
}));
test('wrong passphrase and tampered disk ciphertext never enter authenticated callback or close/delete the real task/file', { timeout: 180000 }, t => transaction(async () => {
  const h = await clientDisk(t); await h.export(); let consumed = 0;
  await assert.rejects(modules.withAuthenticatedEmployeeSafetyBackup(h.file, 'incorrect-local-passphrase', h.workspace, async () => { consumed++; }));
  const handle = await open(h.path, 'r+'); try { const position = (await handle.stat()).size - 1; const b = Buffer.alloc(1); await handle.read(b, 0, 1, position); b[0] ^= 1; await handle.write(b, 0, 1, position); } finally { await handle.close(); }
  await assert.rejects(modules.withAuthenticatedEmployeeSafetyBackup(h.file, PASSPHRASE, h.workspace, async () => { consumed++; }));
  assert.equal(consumed, 0); assertClean(h); assert.equal(JSON.parse(await jobRow(h.begin)).status, 'running');
  assert.ok(!h.calls.includes(CLOSE)); assert.ok((await stat(h.path)).size > 0);
}));
test('source drift after physical save preserves the independent cipher and running task; no implicit retry/cancel/close/delete', { timeout: 180000 }, t => transaction(async () => {
  const h = await clientDisk(t); h.afterWrite = () => change('public.customer_employee_conversations', "UPDATE public.customer_employee_conversations SET message_content='changed after save' WHERE id=$1", [id(340)]);
  await assert.rejects(h.export(), error => error instanceof modules.EmployeeSafetyBackupError && error.phase === 'target-recheck' && error.encryptedFileState === 'verified');
  assert.equal(h.writes, 1); assertClean(h); assert.equal(JSON.parse(await jobRow(h.begin)).status, 'running');
  assert.ok((await stat(h.path)).size > 0); assert.ok(!h.calls.includes(CLOSE));
  await assert.rejects(h.session.close(h.begin.catalog)); assert.ok(!h.calls.includes(CLOSE));
}));
test('pre-save client cancellation leaves a real task running, cleans plaintext, and never writes/deletes/cancels remotely', { timeout: 180000 }, t => transaction(async () => {
  const h = await clientDisk(t), controller = new AbortController();
  await assert.rejects(h.export({ signal: controller.signal, onProgress() { controller.abort(); } }), error => error instanceof modules.EmployeeSafetyBackupError && error.cancelled);
  assertClean(h); assert.equal(h.writes, 0); assert.equal(JSON.parse(await jobRow(h.begin)).status, 'running');
  assert.ok(!h.calls.includes(CLOSE));
}));
test('all database and encryption cases made zero network/production calls', () => { assert.equal(forbiddenNetworkCalls, 0); });
