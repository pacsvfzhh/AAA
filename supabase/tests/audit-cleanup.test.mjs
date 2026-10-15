import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// Reduced local schema; physical Storage, full RLS, and concurrent sessions are not exercised.
const migrationDir = new URL('../migrations/', import.meta.url);
const files = {
  financial: '20260914220000_add_atomic_wallet_financial_system.sql',
  audit: '20261002000000_protect_manual_notifications_and_service_chats.sql',
  archive: '20261008000000_audit_deleted_employee_accounts.sql',
  content: '20261014000000_bulk_delete_content_audit_evidence.sql',
  conversation: '20261015000000_delete_entire_audit_conversation_card.sql',
  employee: '20261016000000_delete_archived_employee_records.sql',
  purge: '20261023000000_purge_deleted_employee_data.sql',
  harden: '20261024000000_harden_deleted_employee_purge.sql',
  shared: '20261025000001_remove_deleted_employee_notifications.sql',
  receipts: '20261028000000_remove_audit_cleanup_receipts.sql',
  current: '20261029000000_reclaim_deleted_notification_content_and_media.sql',
  confirmations: '20261030000000_reclaim_audit_deletion_confirmations.sql',
};
const sql = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, name]) =>
  [key, await readFile(new URL(name, migrationDir), 'utf8')])));

test('retired residual cleanup cannot run from the dashboard, audit panel or Edge Function', async () => {
  for (const file of [
    'src/components/admin/AdminDashboard.tsx',
    'src/components/admin/ContentAuditPanel.tsx',
    'supabase/functions/content-audit/index.ts',
  ]) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source,
      /executeApprovedCleanup|prepare_approved_residual_cleanup|Approved residual cleanup was not completed/,
      `${file} must not contain the retired one-time cleanup workflow`);
  }
});

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `Fixture SQL start not found: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `Fixture SQL end not found: ${endMarker}`);
  return source.slice(start, end + endMarker.length);
}
function functionSQL(source, name) {
  const position = source.indexOf(`FUNCTION ${name}(`);
  assert.notEqual(position, -1, `Fixture function not found: ${name}`);
  return section(source.slice(source.lastIndexOf('CREATE', position)), 'CREATE', '$$;');
}
function blockSQL(source, tag) {
  return section(source, `DO $${tag}$`, `$${tag}$;`);
}
function tableSQL(source, marker) {
  return section(source, marker, '\n);');
}

const ADMIN = '00000000-0000-4000-8000-000000000001';
const SECONDARY = '00000000-0000-4000-8000-000000000002';
const OTHER_ADMIN = '00000000-0000-4000-8000-000000000003';
const SESSION = '10000000-0000-4000-8000-000000000001';
const SECONDARY_SESSION = '10000000-0000-4000-8000-000000000002';
const OTHER_SESSION = '10000000-0000-4000-8000-000000000003';
const EXPIRED_SESSION = '10000000-0000-4000-8000-000000000004';
const REVOKED_SESSION = '10000000-0000-4000-8000-000000000005';
const mediaURL = (bucket, path) => `https://fixture.invalid/storage/v1/object/public/${bucket}/${path}`;
const media = (bucket, path) => ({ bucket, path });
let db;

async function value(query, params = []) {
  const { rows } = await db.query(query, params);
  return rows[0]?.value;
}
async function rpc(name, params) {
  return value(`SELECT ${name}(${params.map((_, i) => `$${i + 1}`).join(', ')}) AS value`, params);
}
async function expectSQLFailure(query, params, pattern) {
  // PostgreSQL exceptions abort the transaction unless isolated by a savepoint.
  await db.exec('SAVEPOINT expected_failure');
  try {
    await assert.rejects(db.query(query, params), pattern);
  } finally {
    await db.exec('ROLLBACK TO SAVEPOINT expected_failure; RELEASE SAVEPOINT expected_failure');
  }
}
async function object(bucket, path) {
  await db.query('INSERT INTO storage.objects(bucket_id, name) VALUES ($1, $2)', [bucket, path]);
}
async function removeMetadata(bucket, path) {
  await db.query('DELETE FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, path]);
}
async function addEvent({ id = randomUUID(), messageId = randomUUID(), employeeId = null,
  operationId = randomUUID(), refs = {}, action = 'delete', entityType = 'notification',
  cleared = false, beforeData = { message: { title: 'old title', content: 'old body' } } } = {}) {
  await db.query(`INSERT INTO private.content_audit_events
    (id, operation_id, entity_type, entity_id, action, owner_admin_id, actor_admin_id,
     actor_username, actor_role, employee_id, before_data, media_refs, cleared_at)
    VALUES ($1, $2, $3, $4, $5, $6, $6, 'fixture-admin', 'super_admin', $7, $8, $9,
      CASE WHEN $10 THEN now() ELSE NULL END)`,
  [id, operationId, entityType, messageId, action, ADMIN, employeeId, beforeData, refs, cleared]);
  return { id, messageId, operationId };
}
async function addOperation(messageId, request = {}, operationType = 'admin_message_send') {
  const operationId = randomUUID();
  const requestData = { title: 'secret title', content: '<p>secret body</p>',
    recipient_ids: [], bonus_amount: 120.5, fee_amount: 3, ...request };
  const result = { success: true, message_id: messageId, total_bonus: 120.5, total_fee: 3 };
  await db.query(`INSERT INTO public.financial_operations
    (operation_id, operation_type, actor_type, actor_id, request_data, result)
    VALUES ($1, $2, 'admin', $3, $4, $5)`, [operationId, operationType, ADMIN, requestData, result]);
  const canonical = await value('SELECT request_data::text AS value FROM public.financial_operations WHERE operation_id = $1', [operationId]);
  return { operationId, requestData, result, digest: createHash('sha256').update(canonical).digest('hex') };
}
async function operationRow(id) {
  return value('SELECT to_jsonb(operation) AS value FROM public.financial_operations operation WHERE operation_id = $1', [id]);
}
async function prepareContent(eventId) {
  return value('SELECT public.prepare_content_audit_delete($1::uuid, p_event_id => $2::uuid) AS value', [SESSION, eventId]);
}
async function finishContent(eventId) {
  const { job_id: jobId } = await prepareContent(eventId);
  const result = await rpc('public.finish_content_audit_delete', [SESSION, jobId]);
  return { jobId, ...result };
}
async function addArchive({ employeeId = randomUUID(), username = `employee-${randomUUID()}` } = {}) {
  const recordId = randomUUID();
  await db.query(`INSERT INTO public.users(id, username, employee_id, archived_at)
    VALUES ($1, $2, $2, now())`, [employeeId, username]);
  await db.query(`INSERT INTO private.deleted_employee_accounts
    (id, operation_id, employee_id, account_username, owner_admin_id, actor_admin_id,
     actor_username, actor_role, deletion_source)
    VALUES ($1, $2, $3, $4, $5, $5, 'fixture-admin', 'super_admin', 'employee_delete')`,
  [recordId, randomUUID(), employeeId, username, ADMIN]);
  return { recordId, employeeId, username };
}
async function addNotification(recordId, messageId, messageData = { title: 'archived', content: 'body' }, cleared = false) {
  const id = randomUUID();
  await db.query(`INSERT INTO private.deleted_employee_notifications
    (id, record_id, message_id, message_data, recipient_data, cleared_at)
    VALUES ($1, $2, $3, $4, '{}', CASE WHEN $5 THEN now() ELSE NULL END)`,
  [id, recordId, messageId, messageData, cleared]);
  return id;
}
async function prepareEmployee(recordId, notificationId = null) {
  return rpc('public.prepare_deleted_employee_archive_delete', [SESSION, null, null, recordId, notificationId]);
}
async function finishEmployee(recordId, notificationId = null) {
  const { job_id: jobId } = await prepareEmployee(recordId, notificationId);
  return { jobId, ...await rpc('public.finish_deleted_employee_archive_delete', [SESSION, jobId]) };
}
async function finishedJob(kind, paths) {
  const table = kind === 'content' ? 'content_audit_delete_jobs' : 'deleted_employee_delete_jobs';
  const id = randomUUID();
  if (kind === 'content') {
    await db.query(`INSERT INTO private.${table}
      (id, admin_id, token_hash, target_ids, card_count, finished_at, public_media_to_remove)
      VALUES ($1, $2, private.hash_financial_token($3), '{}', 0, now(), $4)`, [id, ADMIN, SESSION, paths]);
  } else {
    await db.query(`INSERT INTO private.${table}
      (id, admin_id, token_hash, account_ids, notification_ids, notification_count,
       account_fingerprint, notification_fingerprint, finished_at, paths_to_remove)
      VALUES ($1, $2, private.hash_financial_token($3), '{}', '{}', 0, md5('[]'), md5('[]'), now(), $4)`,
    [id, ADMIN, SESSION, paths]);
  }
  return id;
}
async function recheck(kind, jobId, paths, session = SESSION) {
  return rpc('public.recheck_content_audit_public_media', [session, jobId, kind, paths]);
}
async function claimRow(bucket, path) {
  return value('SELECT to_jsonb(claim) AS value FROM private.content_audit_public_media_claims claim WHERE bucket_id = $1 AND path = $2', [bucket, path]);
}
async function reference(table, column, content) {
  await db.query(`INSERT INTO ${table}(${column}) VALUES ($1)`, [content]);
}

async function installFixture() {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA private; CREATE SCHEMA storage; CREATE SCHEMA extensions;
    CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
    CREATE TABLE storage.objects(bucket_id text NOT NULL, name text NOT NULL, PRIMARY KEY(bucket_id, name));
    CREATE POLICY "Anyone can upload chat images" ON storage.objects FOR INSERT WITH CHECK (true);
    CREATE TABLE public.admins(id uuid PRIMARY KEY, role text, is_active boolean DEFAULT true);
    CREATE TABLE public.admin_financial_sessions(token_hash text PRIMARY KEY, admin_id uuid REFERENCES public.admins(id),
      expires_at timestamptz, revoked_at timestamptz);
    CREATE TABLE public.users(id uuid PRIMARY KEY, username text, employee_id text, archived_at timestamptz, created_by uuid);
    CREATE TABLE public.messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text, content text,
      automation_execution_id uuid, sender_id uuid);
    CREATE TABLE public.message_recipients(message_id uuid, recipient_id uuid);
    CREATE TABLE public.cs_message_templates(id uuid DEFAULT gen_random_uuid(), content text, title text);
    CREATE TABLE public.customer_employee_conversations(id uuid DEFAULT gen_random_uuid(), employee_id uuid,
      customer_id uuid, image_url text, message_content text, rating_data jsonb, title text,
      message_type text, content_frozen boolean, source_template_id uuid, rich_card_content_id uuid);
    CREATE TABLE public.broadcast_messages(image_url text, message_content text, title text);
    CREATE TABLE public.announcements(content text, title text);
    CREATE TABLE public.customer_auto_messages(content text);
    CREATE TABLE public.rich_card_contents(id uuid DEFAULT gen_random_uuid(), html_content text);
    CREATE TABLE public.message_templates(content text);
    CREATE TABLE public.notification_automation_tasks(content_template text, title_template text);
    CREATE TABLE public.notification_automation_executions(user_id uuid, title_snapshot text, content_snapshot text);
    CREATE TABLE public.simulated_customers(id uuid DEFAULT gen_random_uuid(), custom_avatar_url text, customer_avatar text,
      target_employee_id uuid, target_employee_ids uuid[] DEFAULT '{}');
    CREATE TABLE public.admin_configs(icon_custom_url text, config_value text);
    CREATE TABLE public.system_configs(value jsonb);
    CREATE TABLE public.employee_login_history(user_id uuid REFERENCES public.users(id) ON DELETE CASCADE, username text);
    CREATE TABLE public.login_attempts(identifier text, attempt_time timestamptz);
    CREATE TABLE public.financial_login_attempts(account_type text, username text, last_attempt_at timestamptz);
    CREATE TABLE public.withdrawals(id uuid DEFAULT gen_random_uuid(), user_id uuid REFERENCES public.users(id) ON DELETE CASCADE);
    CREATE TABLE public.dispatch_performance_metrics(metadata jsonb);
    CREATE TABLE public.dispatch_system_logs(user_id uuid REFERENCES public.users(id) ON DELETE CASCADE);
  `);
  await db.exec(tableSQL(sql.financial, 'CREATE TABLE IF NOT EXISTS financial_operations ('));
  await db.exec(tableSQL(sql.audit, 'CREATE TABLE private.content_audit_events ('));
  await db.exec('ALTER TABLE private.content_audit_events ADD COLUMN employee_account text');
  await db.exec(tableSQL(sql.audit, 'CREATE TABLE private.content_audit_recipient_versions ('));
  await db.exec(tableSQL(sql.archive, 'CREATE TABLE private.deleted_employee_accounts ('));
  await db.exec('ALTER TABLE private.deleted_employee_accounts ADD COLUMN account_real_name text');
  await db.exec(tableSQL(sql.archive, 'CREATE TABLE private.deleted_employee_notifications ('));
  await db.exec(tableSQL(sql.employee, 'CREATE TABLE private.deleted_employee_delete_jobs ('));
  for (const table of ['orders', 'wallets', 'wallet_balance_baselines', 'wallet_reconciliation_audit',
    'wallet_ledger_entries', 'orders_history', 'orders_history_2025', 'orders_history_2026']) {
    await db.exec(`CREATE TABLE public.${table}(user_id uuid REFERENCES public.users(id) ON DELETE CASCADE)`);
  }
  for (const name of ['private.hash_financial_token', 'private.get_financial_admin_context', 'private.begin_financial_operation']) {
    await db.exec(functionSQL(sql.financial, name));
  }
  await db.exec(functionSQL(sql.audit, 'private.content_audit_storage_urls'));
  await db.exec(functionSQL(sql.employee, 'public.prepare_deleted_employee_archive_delete'));
  await db.exec(sql.content);
  await db.exec(sql.conversation);
  await db.exec(sql.purge);
  await db.exec(`CREATE TRIGGER archive_employee_before_delete BEFORE DELETE ON public.users
    FOR EACH ROW EXECUTE FUNCTION private.archive_employee_before_delete()`);
  await db.exec(sql.harden);
  await db.exec(blockSQL(sql.shared, 'retain_shared_notification_evidence'));
  await db.exec(blockSQL(sql.receipts, 'remove_employee_image_receipts'));
  await db.exec(sql.receipts.slice(sql.receipts.indexOf('ALTER TABLE private.employee_chat_image_deletion_claims ALTER COLUMN')));
  await db.exec(sql.current);
  await db.exec(`CREATE SCHEMA cron;
    CREATE TABLE cron.job(jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text);
    CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE sql AS $$
      INSERT INTO cron.job(jobname, schedule, command) VALUES ($1, $2, $3)
      ON CONFLICT (jobname) DO UPDATE SET schedule = excluded.schedule, command = excluded.command
      RETURNING jobid;
    $$;`);
  await db.exec(sql.confirmations.replace('CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;', ''));
  await db.query('INSERT INTO private.content_audit_storage_origins(origin) VALUES ($1)', ['https://fixture.invalid']);
  await db.query('INSERT INTO public.admins(id, role) VALUES ($1, $4), ($2, $5), ($3, $4)',
    [ADMIN, SECONDARY, OTHER_ADMIN, 'super_admin', 'secondary_admin']);
  for (const [token, admin, expired, revoked] of [
    [SESSION, ADMIN, false, false], [SECONDARY_SESSION, SECONDARY, false, false],
    [OTHER_SESSION, OTHER_ADMIN, false, false], [EXPIRED_SESSION, ADMIN, true, false],
    [REVOKED_SESSION, ADMIN, false, true],
  ]) {
    await db.query(`INSERT INTO public.admin_financial_sessions(token_hash, admin_id, expires_at, revoked_at)
      VALUES (private.hash_financial_token($1), $2, now() + CASE WHEN $3 THEN interval '-1 hour' ELSE interval '1 hour' END,
        CASE WHEN $4 THEN now() ELSE NULL END)`, [token, admin, expired, revoked]);
  }
}

describe('audit cleanup: real PostgreSQL migration regressions', { concurrency: false }, () => {
  before(async () => {
    db = new PGlite({ extensions: { pgcrypto } });
    await installFixture();
  });
  after(async () => { await db?.close(); });
  beforeEach(async () => { await db.exec('BEGIN'); });
  afterEach(async () => { await db.exec('ROLLBACK'); });

  test('migration installs protected helpers and exposes recheck only to service_role', async () => {
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await value(`SELECT has_function_privilege($1,
        'private.redact_deleted_notification_send_content(uuid[])', 'EXECUTE') AS value`, [role]), false);
      assert.equal(await value(`SELECT has_function_privilege($1,
        'public.recheck_content_audit_public_media(uuid,uuid,text,jsonb)', 'EXECUTE') AS value`, [role]), false);
    }
    assert.equal(await value(`SELECT has_function_privilege('service_role',
      'public.recheck_content_audit_public_media(uuid,uuid,text,jsonb)', 'EXECUTE') AS value`), true);
  });

  test('redaction deletes title/content, preserves original SHA256, amounts, result and unrelated rows', async () => {
    const messageId = randomUUID();
    const original = await addOperation(messageId, { extra_amount: 88, recipient_ids: [randomUUID()] });
    const unrelated = await addOperation(randomUUID());
    const nonSend = await addOperation(messageId, {}, 'admin_adjust_wallet');
    const untouched = await Promise.all([operationRow(unrelated.operationId), operationRow(nonSend.operationId)]);
    assert.equal(await rpc('private.redact_deleted_notification_send_content', [[messageId]]), 1);
    const row = await operationRow(original.operationId);
    const { title: _title, content: _content, ...retained } = original.requestData;
    assert.deepEqual(row.request_data, { ...retained, _original_request_sha256: original.digest });
    assert.deepEqual(row.result, original.result);
    assert.equal(row.actor_id, ADMIN);
    assert.deepEqual(await Promise.all([operationRow(unrelated.operationId), operationRow(nonSend.operationId)]), untouched);
    assert.equal(await rpc('private.redact_deleted_notification_send_content', [[messageId]]), 0);
    assert.equal(await rpc('private.redact_deleted_notification_send_content', [[]]), 0);
    assert.equal(await rpc('private.redact_deleted_notification_send_content', [null]), 0);
  });

  test('live messages, remaining audit evidence and another employee archive prevent redaction', async () => {
    const live = randomUUID();
    const archivedEvent = randomUUID();
    const privateNotification = randomUUID();
    const ids = [live, archivedEvent, privateNotification];
    const operations = await Promise.all(ids.map(id => addOperation(id)));
    const beforeRows = await Promise.all(operations.map(op => operationRow(op.operationId)));
    await db.query('INSERT INTO public.messages(id, title, content) VALUES ($1, $2, $3)', [live, 'live', 'still visible']);
    await addEvent({ messageId: archivedEvent });
    const archive = await addArchive();
    await addNotification(archive.recordId, privateNotification);
    assert.equal(await rpc('private.redact_deleted_notification_send_content', [ids]), 0);
    assert.deepEqual(await Promise.all(operations.map(op => operationRow(op.operationId))), beforeRows);
  });

  test('cleared evidence does not retain deleted notification content', async () => {
    const messageId = randomUUID();
    const op = await addOperation(messageId);
    await addEvent({ messageId, cleared: true });
    const archive = await addArchive();
    await addNotification(archive.recordId, messageId, { title: 'cleared' }, true);
    assert.equal(await rpc('private.redact_deleted_notification_send_content', [[messageId]]), 1);
    assert.equal((await operationRow(op.operationId)).request_data._original_request_sha256, op.digest);
  });

  test('existing digest is not overwritten and real begin_financial_operation replays only the original request', async () => {
    const messageId = randomUUID();
    const op = await addOperation(messageId);
    await db.query(`UPDATE public.financial_operations SET request_data =
      jsonb_set(request_data, '{recipient_ids}', '["00000000-0000-4000-8000-000000000099"]') ||
      jsonb_build_object('_original_request_sha256', $2::text) WHERE operation_id = $1`, [op.operationId, op.digest]);
    assert.equal(await rpc('private.redact_deleted_notification_send_content', [[messageId]]), 1);
    assert.equal((await operationRow(op.operationId)).request_data._original_request_sha256, op.digest);
    assert.deepEqual(await rpc('private.begin_financial_operation',
      [op.operationId, 'admin_message_send', 'admin', ADMIN, op.requestData]), op.result);
    for (const changed of [{ ...op.requestData, content: 'changed body' },
      { ...op.requestData, title: 'changed title' }, { ...op.requestData, bonus_amount: 999 }]) {
      await expectSQLFailure('SELECT private.begin_financial_operation($1,$2,$3,$4,$5)',
        [op.operationId, 'admin_message_send', 'admin', ADMIN, changed], /already in use/);
    }
    await expectSQLFailure('SELECT private.begin_financial_operation($1,$2,$3,$4,$5)',
      [op.operationId, 'admin_message_send', 'admin', SECONDARY, op.requestData], /already in use/);
  });

  test('public candidates use bucket+decoded path, deduplicate and ignore unsupported/missing/malformed URLs', async () => {
    await object('chat-images', 'folder/照片 one.png');
    await object('template-images', 'same.png');
    await object('chat-images', 'same.png');
    await object('verification-documents', 'private.png');
    const encoded = mediaURL('chat-images', `folder/${encodeURIComponent('照片 one.png')}`);
    assert.deepEqual(await rpc('private.content_audit_public_media_candidates', [[
      encoded, encoded, mediaURL('template-images', 'same.png'), mediaURL('announcement-images', 'same.png'),
      mediaURL('verification-documents', 'private.png'), mediaURL('chat-images', 'missing.png'),
      mediaURL('chat-images', 'bad%ZZ.png'), mediaURL('chat-images', '%FF.png'),
    ]]), [media('chat-images', 'folder/照片 one.png'), media('template-images', 'same.png')]);
    assert.deepEqual(await rpc('private.content_audit_public_media_candidates', [null]), []);
    assert.equal(await rpc('private.content_audit_decode_uri_path', ['bad%']), null);
    assert.equal(await rpc('private.content_audit_decode_uri_path', ['folder/a%2Bb.png']), 'folder/a+b.png');
  });

  test('foreign Storage origin cannot select or retain a same-named local file', async () => {
    await object('template-images', 'local.png');
    const foreign = 'https://foreign.invalid/storage/v1/object/public/template-images/local.png';
    assert.deepEqual(await rpc('private.content_audit_public_media_candidates', [[foreign]]), []);
    await reference('public.cs_message_templates', 'content', `<img src="${foreign}">`);
    assert.equal(await rpc('private.content_audit_public_media_in_use', ['template-images', 'local.png']), false);
    const event = await addEvent();
    await addOperation(event.messageId, { title: foreign });
    assert.deepEqual((await finishContent(event.id)).public_media_to_remove, []);
  });

  for (const kind of ['content', 'employee']) {
    test(`upgrade rejects unfinished ${kind} media cleanup before changing schema`, async () => {
      await finishedJob(kind, []);
      await expectSQLFailure(blockSQL(sql.current, 'pending_cleanup'), [], /Finish pending media cleanup/);
    });
  }

  test('same-named file in a different bucket is not a reference', async () => {
    await reference('public.cs_message_templates', 'content', `<img src="${mediaURL('template-images', 'same.png')}">`);
    assert.equal(await rpc('private.content_audit_public_media_in_use', ['chat-images', 'same.png']), false);
    assert.equal(await rpc('private.content_audit_public_media_in_use', ['template-images', 'same.png']), true);
    await object('chat-images', 'same.png');
    const paths = [media('chat-images', 'same.png')];
    const jobId = await finishedJob('content', paths);
    assert.deepEqual((await recheck('content', jobId, paths)).paths_to_remove, paths);
    assert.equal((await claimRow('chat-images', 'same.png')).job_id, jobId);
  });

  const protectedReferences = [
    ['shortcut template', 'public.cs_message_templates', 'content', false],
    ['frozen rich card', 'public.rich_card_contents', 'html_content', false],
    ['message title', 'public.messages', 'title', false],
    ['conversation rating_data', 'public.customer_employee_conversations', 'rating_data', true],
    ['automation title', 'public.notification_automation_tasks', 'title_template', false],
    ['config JSON', 'public.system_configs', 'value', true],
  ];
  for (const [label, table, column, isJSON] of protectedReferences) {
    for (const encoded of [false, true]) {
      test(`${encoded ? 'encoded' : 'plain'} ${label} reference protects media at recheck`, async () => {
        const path = 'folder/照片 one.png';
        const url = mediaURL('announcement-images', encoded ? `folder/${encodeURIComponent('照片 one.png')}` : path);
        await object('announcement-images', path);
        if (label === 'frozen rich card') {
          const { rows: [card] } = await db.query(`INSERT INTO public.rich_card_contents(html_content)
            VALUES ($1) RETURNING id`, [`<img src="${url}">`]);
          await db.query(`INSERT INTO public.customer_employee_conversations(message_type, content_frozen, rich_card_content_id)
            VALUES ('rich_card', true, $1)`, [card.id]);
        } else {
          await reference(table, column, isJSON ? { comment: `<img src="${url}">` } : `<img src="${url}">`);
        }
        const paths = [media('announcement-images', path)];
        const jobId = await finishedJob('content', paths);
        assert.deepEqual(await recheck('content', jobId, paths), { paths_to_remove: [], retained_shared_images: 1 });
        assert.equal(await rpc('private.content_audit_public_media_in_use', ['announcement-images', path]), true);
        assert.equal(await claimRow('announcement-images', path), undefined);
        assert.equal(await value('SELECT count(*)::int AS value FROM storage.objects WHERE bucket_id = $1 AND name = $2',
          ['announcement-images', path]), 1);
      });
    }
  }

  test('real content finish captures audit and financial URLs before redaction; repeat finish is idempotent', async () => {
    const event = await addEvent({ refs: { [mediaURL('template-images', 'archive.png')]: 'evidence/path.png' } });
    await object('template-images', 'archive.png');
    await object('super-customer-avatars', 'avatar.png');
    await object('content-audit-evidence', `${event.operationId}/evidence.png`);
    const op = await addOperation(event.messageId, { content: `<img src="${mediaURL('super-customer-avatars', 'avatar.png')}">` });
    await db.query(`INSERT INTO private.content_audit_recipient_versions(message_id, recipient_id, recipient_data)
      VALUES ($1,$2,'{}')`, [event.messageId, randomUUID()]);
    const result = await finishContent(event.id);
    assert.equal(result.success, true);
    assert.equal(result.deleted_events, 1);
    assert.deepEqual(result.paths_to_remove, [`${event.operationId}/evidence.png`]);
    assert.deepEqual(result.public_media_to_remove, [media('super-customer-avatars', 'avatar.png'), media('template-images', 'archive.png')]);
    assert.equal((await operationRow(op.operationId)).request_data._original_request_sha256, op.digest);
    assert.equal('content' in (await operationRow(op.operationId)).request_data, false);
    assert.equal(await value('SELECT count(*)::int AS value FROM private.content_audit_recipient_versions WHERE message_id = $1', [event.messageId]), 0);
    assert.deepEqual(await rpc('public.finish_content_audit_delete', [SESSION, result.jobId]),
      { success: true, deleted_events: 1, paths_to_remove: result.paths_to_remove,
        public_media_to_remove: result.public_media_to_remove, retained_shared_images: 0 });
  });

  test('a source still live is not deleted and its public image remains shared', async () => {
    const messageId = randomUUID();
    const url = mediaURL('chat-images', 'live.png');
    await object('chat-images', 'live.png');
    await db.query('INSERT INTO public.messages(id,title,content) VALUES ($1,$2,$3)', [messageId, 'live', `<img src="${url}">`]);
    const op = await addOperation(messageId, { content: `<img src="${url}">` });
    const oldOperation = await operationRow(op.operationId);
    const event = await addEvent({ messageId, action: 'edit', refs: { [url]: 'old/evidence.png' } });
    const result = await finishContent(event.id);
    assert.equal(await value('SELECT content AS value FROM public.messages WHERE id = $1', [messageId]), `<img src="${url}">`);
    assert.deepEqual(await operationRow(op.operationId), oldOperation);
    assert.deepEqual(await recheck('content', result.jobId, result.public_media_to_remove),
      { paths_to_remove: [], retained_shared_images: 1 });
  });

  for (const kind of ['content', 'employee']) {
    test(`${kind} recheck rejects paths outside the job, invalid batches, secondary/invalid sessions`, async () => {
      const paths = [media('template-images', 'allowed.png')];
      const jobId = await finishedJob(kind, paths);
      const beforeJob = await value(`SELECT to_jsonb(job) AS value FROM private.${kind === 'content' ? 'content_audit_delete_jobs' : 'deleted_employee_delete_jobs'} job WHERE id = $1`, [jobId]);
      for (const batch of [[media('template-images', 'outside.png')], [media('chat-images', 'allowed.png')],
        [media('verification-documents', 'allowed.png')], [{ bucket: 'template-images' }], [null]]) {
        await expectSQLFailure('SELECT public.recheck_content_audit_public_media($1,$2,$3,$4)',
          [SESSION, jobId, kind, batch], /outside this deletion confirmation/);
      }
      for (const batch of [[], {}, null, Array.from({ length: 6 }, () => paths[0])]) {
        await expectSQLFailure('SELECT public.recheck_content_audit_public_media($1,$2,$3,$4)',
          [SESSION, jobId, kind, batch], /Invalid media batch/);
      }
      for (const session of [SECONDARY_SESSION, EXPIRED_SESSION, REVOKED_SESSION, randomUUID()]) {
        await expectSQLFailure('SELECT public.recheck_content_audit_public_media($1,$2,$3,$4)',
          [session, jobId, kind, paths], /Super administrator|invalid or expired/);
      }
      await expectSQLFailure('SELECT public.recheck_content_audit_public_media($1,$2,$3,$4)',
        [SESSION, jobId, 'wrong-kind', paths], /Invalid media deletion scope/);
      await expectSQLFailure('SELECT public.recheck_content_audit_public_media($1,$2,$3,$4)',
        [SESSION, randomUUID(), kind, paths], /has not finished/);
      assert.deepEqual(await value(`SELECT to_jsonb(job) AS value FROM private.${kind === 'content' ? 'content_audit_delete_jobs' : 'deleted_employee_delete_jobs'} job WHERE id = $1`, [jobId]), beforeJob);
      assert.equal(await value('SELECT count(*)::int AS value FROM private.content_audit_public_media_claims'), 0);
    });
  }

  test('content recheck enforces job owner and rejects unfinished jobs', async () => {
    const paths = [media('chat-images', 'image.png')];
    const jobId = await finishedJob('content', paths);
    await expectSQLFailure('SELECT public.recheck_content_audit_public_media($1,$2,$3,$4)',
      [OTHER_SESSION, jobId, 'content', paths], /has not finished/);
    await db.query('UPDATE private.content_audit_delete_jobs SET finished_at = NULL WHERE id = $1', [jobId]);
    await expectSQLFailure('SELECT public.recheck_content_audit_public_media($1,$2,$3,$4)',
      [SESSION, jobId, 'content', paths], /has not finished/);
  });

  test('claim blocks new and updated references, encoded references and Storage reuploads, without cross-bucket collisions', async () => {
    const path = 'folder/照片 one.png';
    await object('template-images', path);
    const paths = [media('template-images', path)];
    const jobId = await finishedJob('content', paths);
    await recheck('content', jobId, paths);
    await recheck('content', jobId, paths);
    assert.equal(await value('SELECT count(*)::int AS value FROM private.content_audit_public_media_claims'), 1);
    for (const url of [mediaURL('template-images', path), mediaURL('template-images', `folder/${encodeURIComponent('照片 one.png')}`)]) {
      await expectSQLFailure('INSERT INTO public.messages(title) VALUES ($1)', [url], /reserved for permanent deletion/);
      await expectSQLFailure('INSERT INTO public.rich_card_contents(html_content) VALUES ($1)', [url], /reserved for permanent deletion/);
      await expectSQLFailure('INSERT INTO public.customer_employee_conversations(rating_data) VALUES ($1)',
        [{ comment: url }], /reserved for permanent deletion/);
    }
    const messageId = randomUUID();
    await db.query('INSERT INTO public.messages(id,title) VALUES ($1,$2)', [messageId, 'unrelated']);
    await expectSQLFailure('UPDATE public.messages SET title = $1 WHERE id = $2',
      [mediaURL('template-images', path), messageId], /reserved for permanent deletion/);
    await removeMetadata('template-images', path);
    await expectSQLFailure('INSERT INTO storage.objects(bucket_id,name) VALUES ($1,$2)',
      ['template-images', path], /reserved for permanent deletion/);
    await object('template-images', 'different.png');
    await expectSQLFailure('UPDATE storage.objects SET name = $1 WHERE bucket_id = $2 AND name = $3',
      [path, 'template-images', 'different.png'], /reserved for permanent deletion/);
    await object('chat-images', path);
    await reference('public.messages', 'title', mediaURL('chat-images', path));
    assert.equal(await value('SELECT title AS value FROM public.messages WHERE id = $1', [messageId]), 'unrelated');
  });

  test('claimed percent-encoded HTML references cannot bypass the new reference trigger', async () => {
    const path = 'folder/photo one.png';
    const paths = [media('template-images', path)];
    await object('template-images', path);
    const jobId = await finishedJob('content', paths);
    await recheck('content', jobId, paths);
    await expectSQLFailure('INSERT INTO public.rich_card_contents(html_content) VALUES ($1)',
      [`<img src="${mediaURL('template-images', 'folder/photo%20one.png')}">`], /reserved for permanent deletion/);
  });

  for (const table of ['public.cs_message_templates', 'public.rich_card_contents']) {
    test(`single-quoted encoded HTML protects existing ${table} media`, async () => {
      const path = 'folder/photo one.png';
      await object('template-images', path);
      const html = `<img src='${mediaURL('template-images', 'folder/photo%20one.png')}'>`;
      await reference(table, table.endsWith('contents') ? 'html_content' : 'content', html);
      const paths = [media('template-images', path)];
      const jobId = await finishedJob('content', paths);
      assert.deepEqual(await recheck('content', jobId, paths), { paths_to_remove: [], retained_shared_images: 1 });
      assert.equal(await claimRow('template-images', path), undefined);
    });
  }

  test('single-quoted encoded HTML cannot bypass a claimed media reference', async () => {
    const path = 'folder/photo one.png';
    await object('template-images', path);
    const paths = [media('template-images', path)];
    const jobId = await finishedJob('content', paths);
    await recheck('content', jobId, paths);
    await expectSQLFailure('INSERT INTO public.rich_card_contents(html_content) VALUES ($1)',
      [`<img src='${mediaURL('template-images', 'folder/photo%20one.png')}'>`], /reserved for permanent deletion/);
  });

  test('conflicting jobs fail atomically and recheck can be retried after the prior cleanup', async () => {
    const paths = [media('announcement-images', 'shared-name.png')];
    await object('announcement-images', 'shared-name.png');
    const first = await finishedJob('content', paths);
    const second = await finishedJob('employee', paths);
    await recheck('content', first, paths);
    await expectSQLFailure('SELECT public.recheck_content_audit_public_media($1,$2,$3,$4)',
      [SESSION, second, 'employee', paths], /reserved by another deletion/);
    assert.equal((await claimRow('announcement-images', 'shared-name.png')).job_id, first);
    await removeMetadata('announcement-images', 'shared-name.png');
    assert.deepEqual(await rpc('public.complete_content_audit_delete', [SESSION, first]), { success: true });
    assert.deepEqual((await recheck('employee', second, paths)).paths_to_remove, paths);
    assert.deepEqual(await rpc('public.complete_deleted_employee_archive_delete', [SESSION, second]), { success: true });
    assert.deepEqual(await claimRow('announcement-images', 'shared-name.png'),
      { bucket_id: 'announcement-images', path: 'shared-name.png', job_id: null, job_kind: null });
  });

  for (const kind of ['content', 'employee']) {
    test(`${kind} complete requires both private/public metadata gone, retains retry job, then clears claim job refs`, async () => {
      const paths = [media('template-images', 'original.png')];
      const jobId = await finishedJob(kind, paths);
      const table = kind === 'content' ? 'content_audit_delete_jobs' : 'deleted_employee_delete_jobs';
      const complete = kind === 'content' ? 'public.complete_content_audit_delete' : 'public.complete_deleted_employee_archive_delete';
      const privatePath = 'operation/evidence.png';
      const privatePaths = kind === 'content' ? [privatePath] : [media('content-audit-evidence', privatePath), ...paths];
      await db.query(`UPDATE private.${table} SET paths_to_remove = $2 WHERE id = $1`, [jobId, privatePaths]);
      await object('content-audit-evidence', privatePath);
      await object('template-images', 'original.png');
      await object('announcement-images', 'unrelated.png');
      await recheck(kind, jobId, paths);
      if (kind === 'employee') {
        await db.query('INSERT INTO private.employee_chat_image_deletion_claims(path,job_id) VALUES ($1,$2)',
          ['legacy-claim.png', jobId]);
      }
      await expectSQLFailure(`SELECT ${complete}($1,$2)`, [SESSION, jobId], /media cleanup is incomplete/);
      await removeMetadata('content-audit-evidence', privatePath);
      await expectSQLFailure(`SELECT ${complete}($1,$2)`, [SESSION, jobId], /media cleanup is incomplete/);
      assert.equal((await claimRow('template-images', 'original.png')).job_id, jobId);
      assert.equal(await value(`SELECT count(*)::int AS value FROM private.${table} WHERE id = $1`, [jobId]), 1);
      await removeMetadata('template-images', 'original.png');
      assert.deepEqual(await rpc(complete, [SESSION, jobId]), { success: true });
      assert.equal(await value(`SELECT count(*)::int AS value FROM private.${table} WHERE id = $1`, [jobId]), 0);
      if (kind === 'employee') {
        assert.equal(await value('SELECT job_id AS value FROM private.employee_chat_image_deletion_claims WHERE path = $1',
          ['legacy-claim.png']), null);
      }
      assert.deepEqual(await claimRow('template-images', 'original.png'),
        { bucket_id: 'template-images', path: 'original.png', job_id: null, job_kind: null });
      await expectSQLFailure('INSERT INTO storage.objects(bucket_id,name) VALUES ($1,$2)',
        ['template-images', 'original.png'], /reserved for permanent deletion/);
      assert.equal(await value('SELECT count(*)::int AS value FROM storage.objects WHERE name = $1', ['unrelated.png']), 1);
    });
  }

  test('real employee finish purges linked records, captures public/private media and preserves original replay digest', async () => {
    const archive = await addArchive();
    const other = await addArchive();
    const event = await addEvent({ employeeId: archive.employeeId, action: 'employee_delete',
      refs: { [mediaURL('chat-images', 'employee.png')]: 'private/evidence.png' } });
    const notification = await addNotification(archive.recordId, event.messageId,
      { title: 'notification', content: `<img src="${mediaURL('announcement-images', 'notification.png')}">` });
    const op = await addOperation(event.messageId, { recipient_ids: [archive.employeeId, other.employeeId],
      content: `<img src="${mediaURL('template-images', 'financial.png')}">` });
    const unrelated = await addOperation(randomUUID());
    const unrelatedRow = await operationRow(unrelated.operationId);
    const otherRow = await value('SELECT to_jsonb(record) AS value FROM private.deleted_employee_accounts record WHERE id = $1', [other.recordId]);
    const evidencePath = `${event.operationId}/evidence.png`;
    const verificationPath = `id-front/${archive.employeeId}-id.png`;
    for (const [bucket, path] of [['chat-images', 'employee.png'], ['announcement-images', 'notification.png'],
      ['template-images', 'financial.png'], ['content-audit-evidence', evidencePath], ['verification-documents', verificationPath]]) {
      await object(bucket, path);
    }
    await db.query(`INSERT INTO private.content_audit_recipient_versions(message_id, recipient_id, recipient_data)
      VALUES ($1,$2,'{}')`, [event.messageId, archive.employeeId]);
    await db.query('INSERT INTO public.dispatch_system_logs(user_id) VALUES ($1)', [archive.employeeId]);
    const result = await finishEmployee(archive.recordId);
    assert.equal(result.success, true);
    assert.equal(result.deleted_accounts, 1);
    assert.equal(result.deleted_notifications, 1);
    assert.equal(result.deleted_audit_events, 1);
    const identity = item => JSON.stringify([item.bucket, item.path]);
    assert.equal(result.paths_to_remove.length, 5, 'No duplicate public/private paths');
    assert.deepEqual(new Set(result.paths_to_remove.map(identity)), new Set([
      media('chat-images', 'employee.png'), media('announcement-images', 'notification.png'),
      media('template-images', 'financial.png'), media('content-audit-evidence', evidencePath),
      media('verification-documents', verificationPath),
    ].map(identity)));
    const row = await operationRow(op.operationId);
    assert.deepEqual(row.request_data.recipient_ids, [other.employeeId]);
    assert.equal(row.request_data._original_request_sha256, op.digest);
    assert.equal('title' in row.request_data, false);
    assert.equal('content' in row.request_data, false);
    assert.equal(row.request_data.bonus_amount, 120.5);
    assert.deepEqual(row.result, op.result);
    assert.deepEqual(await rpc('private.begin_financial_operation',
      [op.operationId, 'admin_message_send', 'admin', ADMIN, op.requestData]), op.result);
    await expectSQLFailure('SELECT private.begin_financial_operation($1,$2,$3,$4,$5)',
      [op.operationId, 'admin_message_send', 'admin', ADMIN, { ...op.requestData, content: 'changed body' }], /already in use/);
    assert.equal(await value('SELECT count(*)::int AS value FROM public.users WHERE id = $1', [archive.employeeId]), 0);
    assert.equal(await value('SELECT count(*)::int AS value FROM private.deleted_employee_notifications WHERE id = $1', [notification]), 0);
    assert.deepEqual(await operationRow(unrelated.operationId), unrelatedRow);
    assert.deepEqual(await value('SELECT to_jsonb(record) AS value FROM private.deleted_employee_accounts record WHERE id = $1', [other.recordId]), otherRow);
    const retry = await rpc('public.finish_deleted_employee_archive_delete', [SESSION, result.jobId]);
    assert.deepEqual(retry.paths_to_remove, result.paths_to_remove);
    const publicPaths = result.paths_to_remove.filter(item => !['content-audit-evidence', 'verification-documents'].includes(item.bucket));
    await recheck('employee', result.jobId, publicPaths);
    await expectSQLFailure('SELECT public.complete_deleted_employee_archive_delete($1,$2)', [SESSION, result.jobId], /media cleanup is incomplete/);
    for (const item of result.paths_to_remove) await removeMetadata(item.bucket, item.path);
    assert.deepEqual(await rpc('public.complete_deleted_employee_archive_delete', [SESSION, result.jobId]), { success: true });
    assert.equal(await value('SELECT count(*)::int AS value FROM private.content_audit_public_media_claims WHERE job_id IS NOT NULL'), 0);
  });

  test('employee purge preserves shared notification evidence/archive and does not redact its operation', async () => {
    const target = await addArchive();
    const other = await addArchive();
    const url = mediaURL('announcement-images', 'shared.png');
    const event = await addEvent({ employeeId: target.employeeId, action: 'employee_delete', refs: { [url]: 'evidence.png' } });
    await addNotification(target.recordId, event.messageId, { content: `<img src="${url}">` });
    const otherNotificationId = await addNotification(other.recordId, event.messageId, { content: `<img src="${url}">` });
    const op = await addOperation(event.messageId);
    const beforeRow = await operationRow(op.operationId);
    await object('announcement-images', 'shared.png');
    const result = await finishEmployee(target.recordId);
    assert.deepEqual(await operationRow(op.operationId), beforeRow);
    assert.equal(await value('SELECT employee_id AS value FROM private.content_audit_events WHERE id = $1', [event.id]), other.employeeId);
    assert.equal(await value('SELECT count(*)::int AS value FROM private.deleted_employee_notifications WHERE id = $1', [otherNotificationId]), 1);
    assert.deepEqual(await recheck('employee', result.jobId, [media('announcement-images', 'shared.png')]),
      { paths_to_remove: [], retained_shared_images: 1 });
  });

  test('notification-only employee cleanup redacts content but keeps the account and archived user', async () => {
    const archive = await addArchive();
    const messageId = randomUUID();
    const url = mediaURL('super-customer-avatars', 'only-notification.png');
    await object('super-customer-avatars', 'only-notification.png');
    const notificationId = await addNotification(archive.recordId, messageId, { content: `<img src="${url}">` });
    const op = await addOperation(messageId);
    const result = await finishEmployee(null, notificationId);
    assert.equal(result.deleted_accounts, 0);
    assert.equal(result.deleted_notifications, 1);
    assert.deepEqual(result.paths_to_remove, [media('super-customer-avatars', 'only-notification.png')]);
    assert.equal('content' in (await operationRow(op.operationId)).request_data, false);
    assert.equal(await value('SELECT count(*)::int AS value FROM private.deleted_employee_accounts WHERE id = $1', [archive.recordId]), 1);
    assert.equal(await value('SELECT count(*)::int AS value FROM public.users WHERE id = $1', [archive.employeeId]), 1);
  });

  test('confirmation cancellation removes only its preview and is idempotent for both panels', async () => {
    const event = await addEvent();
    const content = await prepareContent(event.id);
    const archive = await addArchive();
    const employee = await prepareEmployee(archive.recordId);
    for (const [kind, jobId] of [['content', content.job_id], ['employee', employee.job_id]]) {
      assert.deepEqual(await rpc('public.cancel_audit_deletion_confirmation', [SESSION, kind, jobId]),
        { success: true, cancelled: true });
      assert.deepEqual(await rpc('public.cancel_audit_deletion_confirmation', [SESSION, kind, jobId]),
        { success: true, cancelled: false });
    }
    assert.equal(await value('SELECT count(*)::int AS value FROM private.content_audit_events WHERE id = $1', [event.id]), 1);
    assert.equal(await value('SELECT count(*)::int AS value FROM private.deleted_employee_accounts WHERE id = $1', [archive.recordId]), 1);
    assert.equal(await value('SELECT count(*)::int AS value FROM public.users WHERE id = $1', [archive.employeeId]), 1);
  });

  test('cancellation checks super-admin identity, owner and session without deleting evidence', async () => {
    const event = await addEvent();
    const { job_id: jobId } = await prepareContent(event.id);
    await expectSQLFailure('SELECT public.cancel_audit_deletion_confirmation($1,$2,$3)',
      [SECONDARY_SESSION, 'content', jobId], /Super administrator/);
    for (const session of [EXPIRED_SESSION, REVOKED_SESSION]) {
      await expectSQLFailure('SELECT public.cancel_audit_deletion_confirmation($1,$2,$3)',
        [session, 'content', jobId], /session/i);
    }
    assert.deepEqual(await rpc('public.cancel_audit_deletion_confirmation', [OTHER_SESSION, 'content', jobId]),
      { success: true, cancelled: false });
    const otherToken = randomUUID();
    await db.query(`INSERT INTO public.admin_financial_sessions(token_hash, admin_id, expires_at)
      VALUES (private.hash_financial_token($1), $2, now() + interval '1 hour')`, [otherToken, ADMIN]);
    assert.deepEqual(await rpc('public.cancel_audit_deletion_confirmation', [otherToken, 'content', jobId]),
      { success: true, cancelled: false });
    await expectSQLFailure('SELECT public.cancel_audit_deletion_confirmation($1,$2,$3)',
      [SESSION, 'unsupported', jobId], /Invalid deletion confirmation kind/);
    assert.equal(await value('SELECT count(*)::int AS value FROM private.content_audit_delete_jobs WHERE id = $1', [jobId]), 1);
    for (const role of ['anon', 'authenticated']) {
      assert.equal(await value("SELECT has_function_privilege($1, 'public.cancel_audit_deletion_confirmation(uuid,text,uuid)', 'EXECUTE') AS value", [role]), false);
      assert.equal(await value("SELECT has_function_privilege($1, 'private.collect_audit_deletion_confirmations()', 'EXECUTE') AS value", [role]), false);
    }
    assert.equal(await value("SELECT has_function_privilege('service_role', 'public.cancel_audit_deletion_confirmation(uuid,text,uuid)', 'EXECUTE') AS value"), true);
  });

  test('scheduled collector removes expired confirmations but preserves valid previews and every finished job', async () => {
    const event = await addEvent();
    const expiredContent = await prepareContent(event.id);
    const liveContent = await prepareContent(event.id);
    const archive = await addArchive();
    const expiredEmployee = await prepareEmployee(archive.recordId);
    const liveEmployee = await prepareEmployee(archive.recordId);
    const pendingContent = await finishedJob('content', [media('chat-images', 'pending-content.png')]);
    const pendingEmployee = await finishedJob('employee', [media('chat-images', 'pending-employee.png')]);
    await object('chat-images', 'pending-content.png');
    await object('chat-images', 'pending-employee.png');
    await recheck('content', pendingContent, [media('chat-images', 'pending-content.png')]);
    await recheck('employee', pendingEmployee, [media('chat-images', 'pending-employee.png')]);
    await db.query('UPDATE private.content_audit_delete_jobs SET expires_at = now() - interval \'1 hour\' WHERE id = ANY($1)', [[expiredContent.job_id, pendingContent]]);
    await db.query('UPDATE private.deleted_employee_delete_jobs SET expires_at = now() - interval \'1 hour\' WHERE id = ANY($1)', [[expiredEmployee.job_id, pendingEmployee]]);
    assert.deepEqual(await rpc('private.collect_audit_deletion_confirmations', []),
      { content_confirmations: 1, employee_confirmations: 1 });
    for (const [table, ids] of [['content_audit_delete_jobs', [liveContent.job_id, pendingContent]],
      ['deleted_employee_delete_jobs', [liveEmployee.job_id, pendingEmployee]]]) {
      assert.equal(await value(`SELECT count(*)::int AS value FROM private.${table} WHERE id = ANY($1)`, [ids]), 2);
    }
    for (const [kind, jobId] of [['content', pendingContent], ['employee', pendingEmployee]]) {
      assert.deepEqual(await rpc('public.cancel_audit_deletion_confirmation', [SESSION, kind, jobId]),
        { success: true, cancelled: false });
    }
    assert.equal(await value('SELECT count(*)::int AS value FROM private.content_audit_public_media_claims WHERE job_id IS NOT NULL'), 2);
    assert.equal(await value('SELECT count(*)::int AS value FROM storage.objects'), 2);
    assert.deepEqual(await value("SELECT jsonb_build_object('schedule', schedule, 'command', command) AS value FROM cron.job WHERE jobname = 'collect-audit-deletion-confirmations'"),
      { schedule: '* * * * *', command: 'SELECT private.collect_audit_deletion_confirmations();' });
  });

  test('collector treats partially missing selections as invalid without touching remaining evidence', async () => {
    const first = await addEvent();
    const second = await addEvent();
    const { job_id: jobId } = await prepareContent(first.id);
    await db.query('UPDATE private.content_audit_delete_jobs SET target_ids = $2 WHERE id = $1', [jobId, [first.id, second.id]]);
    await db.query('DELETE FROM private.content_audit_events WHERE id = $1', [first.id]);
    assert.deepEqual(await rpc('private.collect_audit_deletion_confirmations', []),
      { content_confirmations: 1, employee_confirmations: 0 });
    assert.equal(await value('SELECT count(*)::int AS value FROM private.content_audit_events WHERE id = $1', [second.id]), 1);
  });

  test('collector reclaims stale notification-only and legacy archived-employee confirmations', async () => {
    const archive = await addArchive();
    const notification = await addNotification(archive.recordId, randomUUID());
    const notificationJob = await prepareEmployee(null, notification);
    await db.query('DELETE FROM private.deleted_employee_notifications WHERE id = $1', [notification]);
    const orphanJob = randomUUID();
    await db.query(`INSERT INTO private.deleted_employee_delete_jobs
      (id, admin_id, token_hash, account_ids, notification_ids, notification_count, account_fingerprint,
       notification_fingerprint, orphan_employee_ids)
      VALUES ($1, $2, private.hash_financial_token($3), '{}', '{}', 0, md5('[]'), md5('[]'), $4)`,
      [orphanJob, ADMIN, SESSION, [randomUUID()]]);
    assert.deepEqual(await rpc('private.collect_audit_deletion_confirmations', []),
      { content_confirmations: 0, employee_confirmations: 2 });
    assert.equal(await value('SELECT count(*)::int AS value FROM private.deleted_employee_delete_jobs WHERE id = ANY($1)', [[notificationJob.job_id, orphanJob]]), 0);
    assert.equal(await value('SELECT count(*)::int AS value FROM private.deleted_employee_accounts WHERE id = $1', [archive.recordId]), 1);
  });

  test('content finish immediately reclaims duplicate previews and keeps the active attachment retry', async () => {
    const event = await addEvent();
    const first = await prepareContent(event.id);
    await prepareContent(event.id);
    await rpc('public.finish_content_audit_delete', [SESSION, first.job_id]);
    assert.equal(await value('SELECT count(*)::int AS value FROM private.content_audit_delete_jobs'), 1);
    assert.equal(await value('SELECT finished_at IS NOT NULL AS value FROM private.content_audit_delete_jobs WHERE id = $1', [first.job_id]), true);
    assert.deepEqual(await rpc('public.complete_content_audit_delete', [SESSION, first.job_id]), { success: true });
    assert.equal(await value('SELECT count(*)::int AS value FROM private.content_audit_delete_jobs'), 0);
  });

  test('employee finish reclaims duplicate account and notification previews without losing media retries', async () => {
    const archive = await addArchive();
    const notification = await addNotification(archive.recordId, randomUUID());
    const first = await prepareEmployee(archive.recordId);
    await prepareEmployee(archive.recordId);
    await prepareEmployee(null, notification);
    await rpc('public.finish_deleted_employee_archive_delete', [SESSION, first.job_id]);
    assert.equal(await value('SELECT count(*)::int AS value FROM private.deleted_employee_delete_jobs'), 1);
    assert.equal(await value('SELECT finished_at IS NOT NULL AS value FROM private.deleted_employee_delete_jobs WHERE id = $1', [first.job_id]), true);
    assert.deepEqual(await rpc('public.complete_deleted_employee_archive_delete', [SESSION, first.job_id]), { success: true });
    assert.equal(await value('SELECT count(*)::int AS value FROM private.deleted_employee_delete_jobs'), 0);
  });

  test('all preparation paths collect safely before creating a new preview', async () => {
    for (const name of ['public.prepare_content_audit_delete', 'public.prepare_content_audit_conversation_delete',
      'public.prepare_deleted_employee_archive_delete', 'public.prepare_unpurged_archived_employee_delete']) {
      const definition = await value(`SELECT pg_get_functiondef(oid) AS value FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace AND proname = $1`, [name.split('.')[1]]);
      assert.match(definition, /PERFORM private\.collect_audit_deletion_confirmations\(\);/);
      assert.doesNotMatch(definition, /DELETE FROM private\.(content_audit|deleted_employee)_delete_jobs WHERE expires_at/);
    }
  });

  test('employee finish accepts valid percent-encoded chat image paths through the actual old-function patch chain', async () => {
    const archive = await addArchive();
    const path = 'folder/photo one.png';
    await object('chat-images', path);
    await addEvent({ employeeId: archive.employeeId, entityType: 'aaa_service', action: 'employee_delete',
      refs: { [mediaURL('chat-images', 'folder/photo%20one.png')]: 'private/evidence.png' } });
    const result = await finishEmployee(archive.recordId);
    assert.equal(result.success, true);
    assert.deepEqual(result.paths_to_remove, [media('chat-images', path)]);
  });
});
