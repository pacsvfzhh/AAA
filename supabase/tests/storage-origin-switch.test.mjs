import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

// In-memory database only: replays the real migrations and triggers; never connects to Supabase.
const migrationDir = new URL('../migrations/', import.meta.url);
const supportDir = new URL('./support/', import.meta.url);
const scriptPath = new URL('../migration-check/04_switch_storage_origin.sql', import.meta.url);
const OLD = 'https://hxpbpqoqkoiiplvdwmld.supabase.co';
const NEW = 'https://ashxnuadjvhqucoobmyp.supabase.co';
const pub = (origin, bucket, path) => `${origin}/storage/v1/object/public/${bucket}/${path}`;
const SUPER = '00000000-0000-4000-8000-000000000201';
const AUDITED = [
  ['messages', 'audit_notification_change'],
  ['customer_employee_conversations', 'audit_chat_change'],
  ['cs_message_templates', 'audit_template_source'],
  ['customer_auto_messages', 'audit_auto_source'],
  ['rich_card_contents', 'audit_card_source'],
];
const FILES = [
  ['announcement-images', 'e169/1762295493781-4ztmgh.jpg'],
  ['announcement-images', 'e169/1792964318818-dbfgv5.mp4'],
  ['announcement-images', 'e169/1792964318818-dbfgv5-poster.jpg'],
  ['announcement-images', 'messages/1779908325116_53t3ky6xez6.jpg'],
  ['announcement-images', '1792956571795-hbr2ap.jpg'],
  ['chat-images', 'chat-images/template_1788901175424.jpg'],
  ['chat-images', '1789763748573-x4xmn1.jpg'],
  ['super-customer-avatars', 'avatars/1788824615540-zi3xnh.jpg'],
  ['template-images', 'rich-cards/948aa017-e8ce-4892-8130-5eae7ee325b6.png'],
  ['template-images', 'templates/f9035d64-a557-4c3e-a6b6-4a0f0f440686.png'],
];
const DANGLING = ['chat-images', '13855fbd-c4f0-48e5-9a7f-194e327a7dda/1788225318998-uksl7k.jpg'];
const PLACEHOLDER = 'https://在这里填新项目地址.supabase.co';
let db;
let template;
let script;
let ids;
let originalOccurrences;

async function oldAddressLocations(ref = 'hxpbpqoqkoiiplvdwmld') {
  const cols = (await db.query(`SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private') AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      AND a.atttypid IN ('text'::regtype, 'varchar'::regtype, 'json'::regtype, 'jsonb'::regtype, 'text[]'::regtype)`)).rows;
  const hits = {};
  for (const { sch, tbl, col } of cols) {
    const sql = `SELECT coalesce(sum((length("${col}"::text) - length(replace("${col}"::text, $1, ''))) / length($1)), 0)::int AS n
      FROM "${sch}"."${tbl}" WHERE "${col}"::text LIKE '%' || $1 || '%'`;
    const n = (await db.query(sql, [ref])).rows[0].n;
    if (n > 0) hits[`${sch}.${tbl}.${col}`] = n;
  }
  return hits;
}
async function triggerStates() {
  return (await db.query(`SELECT c.relname || '.' || t.tgname AS name, t.tgenabled
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('public', 'private', 'storage') AND NOT t.tgisinternal ORDER BY 1`)).rows;
}
async function snapshot() {
  const others = {};
  for (const table of [
    'messages', 'rich_card_contents', 'message_templates', 'customer_employee_conversations',
    'cs_message_templates', 'simulated_customers', 'customer_auto_messages', 'financial_operations',
    'verification_requests', 'notification_automation_tasks', 'notification_automation_executions',
    'admin_configs', 'system_configs', 'broadcast_messages',
  ]) {
    others[table] = (await db.query(`SELECT * FROM public.${table} row ORDER BY to_jsonb(row)::text`)).rows;
  }
  for (const table of ['content_audit_events', 'deleted_employee_notifications']) {
    others[table] = (await db.query(`SELECT * FROM private.${table} ORDER BY id`)).rows;
  }
  others.objects = (await db.query('SELECT * FROM storage.objects ORDER BY id')).rows;
  return {
    announcements: (await db.query('SELECT * FROM public.announcements ORDER BY id')).rows,
    others,
    origins: (await db.query('SELECT origin FROM private.content_audit_storage_origins ORDER BY 1')).rows.map(r => r.origin),
  };
}
const withNew = origin => template.replace(`'${PLACEHOLDER}'`, `'${origin}'`);
const allowMissing = (sql, paths) => sql.replace("v_allow_missing text[] := '{}';",
  `v_allow_missing text[] := ARRAY[${paths.map(path => `'${path.replaceAll("'", "''")}'`).join(',')}];`);
async function rolledBack(fn) {
  await db.exec('BEGIN');
  try { return await fn(); } finally { await db.exec('ROLLBACK'); }
}
function assertOnlyAnnouncementsChanged(before, after) {
  assert.deepEqual(after.others, before.others, 'non-announcement rows, hashes, evidence and Storage records must stay unchanged');
  assert.deepEqual(after.origins, [...new Set([...before.origins, NEW])].sort(), 'all old trusted origins must be retained');
}
async function runScript(sql = script) {
  const results = await db.exec(sql);
  return results.at(-1).rows;
}
async function expectBlocked(sql, pattern, stage) {
  const report = await runScript(sql);
  assert.equal(report[0].项目, '总结');
  assert.equal(report[0].结果, '未通过（已撤销）');
  assert.match(report.find(row => row.项目 === '具体原因').说明, pattern);
  assert(report.some(row => row.项目 === '后续处理'));
  assert(!report.some(row => row.结果 === '已修改'), 'rolled-back changes must not be reported as saved');
  if (stage) assert.equal(report.find(row => row.项目 === '中止阶段').说明, stage);
  return report;
}

before(async () => {
  template = await readFile(scriptPath, 'utf8');
  assert(template.includes(`'${PLACEHOLDER}'`), 'script must ship with the placeholder');
  assert(!template.includes('hxpbpqoqkoiiplvdwmld') && !template.includes('ashxnuadjvhqucoobmyp'), 'script must not hard-code projects');
  script = withNew(` ${NEW}/ `.toUpperCase());
  const segments = [{ before: null, sql: '' }];
  for (const line of (await readFile(new URL('baseline.sql', supportDir), 'utf8')).split('\n')) {
    const marker = line.match(/^-- @before (\S+)/);
    if (marker) segments.push({ before: marker[1], sql: '' });
    else segments.at(-1).sql += `${line}\n`;
  }
  db = new PGlite({ extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await db.exec(await readFile(new URL('platform.sql', supportDir), 'utf8'));
  await db.exec('ALTER TABLE storage.objects ADD COLUMN user_metadata jsonb');
  const files = (await readdir(migrationDir)).filter(file => file.endsWith('.sql')).sort();
  for (const [index, file] of files.entries()) {
    for (const segment of segments) if (segment.before && file.startsWith(segment.before)) await db.exec(segment.sql);
    const sql = (await readFile(new URL(file, migrationDir), 'utf8'))
      .replace(/CREATE EXTENSION IF NOT EXISTS pg_cron[^;]*;/gi, '')
      .replace(/CREATE EXTENSION IF NOT EXISTS pg_trgm;/gi, '');
    try { await db.exec(sql); } catch { try { await db.exec('ROLLBACK'); } catch { /* not in a transaction */ } }
    if (index === 0) await db.exec(segments[0].sql);
  }
  for (const name of AUDITED.map(([, trigger]) => trigger)) {
    assert((await triggerStates()).some(t => t.name.endsWith(`.${name}`)), `replayed schema must contain ${name}`);
  }
  assert.deepEqual((await db.query('SELECT origin FROM private.content_audit_storage_origins')).rows.map(r => r.origin), [OLD]);

  await db.query(`INSERT INTO public.admins(id, username, password_hash, role)
    VALUES ($1, 'origin-switch-root', extensions.crypt('x', extensions.gen_salt('bf', 4)), 'super_admin')`, [SUPER]);
  const employee = (await db.query(`INSERT INTO public.users(username, employee_id, password_hash, created_by, is_verified)
    VALUES ('origin-switch-employee', 'origin-switch-employee', extensions.crypt('x', extensions.gen_salt('bf', 4)), $1, true)
    RETURNING id`, [SUPER])).rows[0].id;
  for (const bucket of new Set(FILES.map(([b]) => b))) {
    await db.query('INSERT INTO storage.buckets(id, name, public) VALUES ($1, $1, true) ON CONFLICT (id) DO NOTHING', [bucket]);
  }
  for (const [bucket, path] of FILES) {
    await db.query(`INSERT INTO storage.objects(bucket_id, name, created_at, updated_at, metadata)
      VALUES ($1, $2, '2026-10-25 22:00+00', '2026-10-25 22:00+00', '{"size": 1}')`, [bucket, path]);
  }
  const u = (bucket, path) => pub(OLD, bucket, path);
  const announcement = `<p>公告</p><img src="${u(...FILES[0])}"><video src="${u(...FILES[1])}" poster="${u(...FILES[2])}"></video>`;
  const message = `<p>通知</p><img src="${u(...FILES[3])}"><img src="${u(...FILES[0])}">`;
  const cardHtml = `<div class="card"><img src="${u(...FILES[8])}"></div>`;
  const legacyCardHtml = `<div><img src="${u(...FILES[9])}"></div>`;
  ids = {};
  ids.announcement = (await db.query(`INSERT INTO public.announcements(title, content, created_by) VALUES ('公告', $1, $2) RETURNING id`, [announcement, SUPER])).rows[0].id;
  ids.message = (await db.query(`INSERT INTO public.messages(sender_id, sender_username, title, content, message_type)
    VALUES ($1, 'origin-switch-root', '通知', $2, 'realtime') RETURNING id`, [SUPER, message])).rows[0].id;
  await db.query(`INSERT INTO public.message_templates(admin_id, name, content) VALUES ($1, '模板', $2)`, [SUPER, `<img src="${u(...FILES[4])}">`]);
  ids.card = (await db.query(`INSERT INTO public.rich_card_contents(html_content, content_hash) VALUES ($1, md5($1)) RETURNING id`, [cardHtml])).rows[0].id;
  ids.legacyCard = (await db.query(`INSERT INTO public.rich_card_contents(html_content) VALUES ($1) RETURNING id`, [legacyCardHtml])).rows[0].id;
  ids.danglingCard = (await db.query(`INSERT INTO public.rich_card_contents(html_content, content_hash) VALUES ($1, md5($1)) RETURNING id`,
    [`<img src="${u(...DANGLING)}"><img src="${OLD}/storage/v1/object/sign/chat-images/bad-card.jpg?token=expired">`])).rows[0].id;
  await db.query(`INSERT INTO public.cs_message_templates(admin_id, name, content) VALUES ($1, '快捷回复', $2)`, [SUPER, `<img src="${u(...FILES[5])}">`]);
  ids.customer = (await db.query(`INSERT INTO public.simulated_customers(admin_id, customer_name, customer_id, custom_avatar_url)
    VALUES ($1, '客户', 'CUS-ORIGIN-1', $2) RETURNING id`, [SUPER, u(...FILES[7])])).rows[0].id;
  await db.query(`INSERT INTO public.customer_auto_messages(customer_id, admin_id, message_type, content)
    VALUES ($1, $2, 'quick_send', $3)`, [ids.customer, SUPER, `<img src="${u(...FILES[6])}">`]);
  ids.chat = (await db.query(`INSERT INTO public.customer_employee_conversations(customer_id, employee_id, sender_type, message_type, message_content, image_url)
    VALUES ($1, $2, 'customer', 'image', $3, $3) RETURNING id`, [ids.customer, employee, u(...FILES[6])])).rows[0].id;
  await db.query(`INSERT INTO public.customer_employee_conversations(customer_id, employee_id, sender_type, message_type, message_content, image_url)
    VALUES ($1, $2, 'customer', 'image', $3, $3)`, [ids.customer, employee, u(...DANGLING)]);
  await db.query(`INSERT INTO public.financial_operations(operation_id, operation_type, actor_type, request_data, result)
    VALUES ($1, 'origin_switch_fixture', 'admin', $2, $2)`, [randomUUID(), JSON.stringify({ payload: { content: `<img src="${u(...FILES[4])}">` } })]);
  await db.query(`INSERT INTO public.admin_configs(admin_id, config_type, config_value, icon_custom_url)
    VALUES ($1, 'commission_rate', $2, $2)`, [SUPER, u(...FILES[7])]);
  await db.query(`INSERT INTO public.system_configs(key, value) VALUES ('origin_switch_fixture', $1)`,
    [JSON.stringify({ icon: u(...FILES[7]) })]);
  await db.query(`INSERT INTO public.verification_requests(user_id, real_name, wallet_address, phone, email, id_front_url, id_back_url, selfie_url)
    VALUES ($1, 'Fixture', 'fixture-id', 'fixture-phone', 'fixture-address', $2, $2, $2)`, [employee, u(...FILES[7])]);
  const task = (await db.query(`INSERT INTO public.notification_automation_tasks(owner_admin_id, name, trigger_type, trigger_mode, threshold_value, title_template, content_template)
    VALUES ($1, 'Origin fixture', 'total_orders', 'reach_once', 1, 'Fixture', $2) RETURNING id`, [SUPER, `<img src="${u(...FILES[4])}">`])).rows[0].id;
  await db.query(`INSERT INTO public.notification_automation_executions(task_id, task_version, owner_admin_id, user_id, employee_username, period_key, stage, actual_value, trigger_snapshot, title_snapshot, content_snapshot)
    VALUES ($1, 1, $2, $3, 'fixture', 'all_time', 1, 1, '{}', 'Fixture', $4)`, [task, SUPER, employee, `<img src="${u(...FILES[4])}">`]);
  await db.query(`INSERT INTO public.broadcast_messages(admin_id, message_type, message_content, image_url)
    VALUES ($1, 'image', $2, $2)`, [SUPER, u(...FILES[6])]);
  originalOccurrences = await oldAddressLocations();
}, { timeout: 900000 });
after(async () => { await db?.close(); });

test('fixture holds old addresses in every reviewed column', () => {
  for (const key of ['public.announcements.content', 'public.messages.content', 'public.rich_card_contents.html_content',
    'public.message_templates.content', 'public.customer_employee_conversations.image_url',
    'public.customer_employee_conversations.message_content', 'public.cs_message_templates.content',
    'public.simulated_customers.custom_avatar_url', 'public.customer_auto_messages.content',
    'public.financial_operations.request_data', 'public.financial_operations.result',
    'public.admin_configs.config_value', 'public.admin_configs.icon_custom_url', 'public.system_configs.value',
    'public.verification_requests.id_front_url', 'public.verification_requests.id_back_url', 'public.verification_requests.selfie_url',
    'public.notification_automation_tasks.content_template', 'public.notification_automation_executions.content_snapshot',
    'public.broadcast_messages.image_url', 'public.broadcast_messages.message_content',
    'private.content_audit_storage_origins.origin']) {
    assert(originalOccurrences[key] > 0, `missing fixture for ${key}`);
  }
});

test('the SQL target list is announcement content only and contains no trigger toggles, origin deletes or rich-card rewrites', () => {
  const targets = /create temp table storage_origin_switch_targets[\s\S]*?\) t\(sch, tbl, col\);/.exec(template)?.[0];
  assert(targets);
  assert.deepEqual([...targets.matchAll(/\('([^']+)', '([^']+)', '([^']+)'\)/g)].map(match => match.slice(1)),
    [['public', 'announcements', 'content']]);
  assert.doesNotMatch(template, /\b(?:disable|enable)\s+trigger\b|\bdelete\s+from\s+private\.content_audit_storage_origins\b|\bcontent_hash\b|\bpg_attribute\b|\bfrom\s+private\.(?:content_audit_events|deleted_employee_notifications)\b/i);
});

test('refuses to run until the new project address is filled in', async () => {
  const before = await snapshot();
  await expectBlocked(template, /【填写这里】/, '输入检查');
  await expectBlocked(withNew('https://example.com'), /【填写这里】/, '输入检查');
  assert.deepEqual(await snapshot(), before);
});

test('multiple source origins cannot bypass file verification', async () => {
  const other = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
  await db.query('INSERT INTO private.content_audit_storage_origins(origin) VALUES ($1)', [other]);
  try {
    const before = await snapshot();
    await expectBlocked(script, /没有复制到这个项目/, '文件迁移核对');
    assert.deepEqual(await snapshot(), before);
  } finally {
    await db.query('DELETE FROM private.content_audit_storage_origins WHERE origin = $1', [other]);
  }
});

test('refuses to run before the referenced files are re-uploaded (also blocks running on the old project)', async () => {
  const before = await snapshot();
  const triggers = await triggerStates();
  await expectBlocked(script, /没有复制到这个项目/, '文件迁移核对');
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await triggerStates(), triggers);
  assert.deepEqual(await oldAddressLocations(), originalOccurrences);
});

test('a copied database timestamp is not proof that an object was transferred', async () => {
  await db.query(`UPDATE storage.objects SET updated_at = created_at + interval '1 hour'`);
  const before = await snapshot();
  await expectBlocked(script, /没有复制到这个项目/, '文件迁移核对');
  assert.deepEqual(await snapshot(), before);
});

test('one file without a v3 SHA-256 receipt blocks the whole switch', async () => {
  await db.query(`UPDATE storage.objects SET user_metadata = jsonb_build_object('storageMigration', jsonb_build_object('target', $1::text, 'bytes', 1, 'sha256', repeat('a', 64), 'version', 3))`, [NEW]);
  await db.query(`UPDATE storage.objects SET user_metadata = null WHERE name = $1`, [FILES[0][1]]);
  const before = await snapshot();
  await expectBlocked(script, new RegExp(`还有 1 个.*${FILES[0][1]}`), '文件迁移核对');
  await expectBlocked(allowMissing(script, [FILES[0].join('/')]), /没有复制到这个项目/, '文件迁移核对');
  assert.deepEqual(await snapshot(), before);
  await db.query(`UPDATE storage.objects SET user_metadata = jsonb_build_object('storageMigration', jsonb_build_object('target', $1::text, 'bytes', 1, 'sha256', repeat('a', 64), 'version', 3)) WHERE name = $2`, [NEW, FILES[0][1]]);
});

test('a receipt from another destination cannot be accepted using the old upload timestamp', async () => {
  await db.query(`UPDATE storage.objects SET user_metadata = $1 WHERE name = $2`,
    [JSON.stringify({ storageMigration: { target: OLD, bytes: 1, version: 2 } }), FILES[0][1]]);
  try {
    const before = await snapshot();
    await expectBlocked(script, /没有复制到这个项目/, '文件迁移核对');
    assert.deepEqual(await snapshot(), before);
  } finally { await db.query('UPDATE storage.objects SET user_metadata = $1 WHERE name = $2', [JSON.stringify({ storageMigration: { target: NEW, bytes: 1, sha256: 'a'.repeat(64), version: 3 } }), FILES[0][1]]); }
});

test('new referenced files with no Storage record are rejected unless explicitly confirmed missing', async () => {
  const id = randomUUID();
  await db.query('INSERT INTO public.announcements(id, title, content, created_by) VALUES ($1, $2, $3, $4)',
    [id, 'new missing media', `<img src="${pub(OLD, 'announcement-images', 'later-not-uploaded.jpg')}">`, SUPER]);
  try {
    const before = await snapshot();
    await expectBlocked(script, /在目标 Storage 没有记录/, '文件迁移核对');
    assert.deepEqual(await snapshot(), before);
  } finally { await db.query('DELETE FROM public.announcements WHERE id = $1', [id]); }
});

test('a genuinely missing Markdown image still blocks the entire switch using its real path', async () => {
  const id = randomUUID();
  const path = 'missing-markdown(1).jpg';
  await db.query('INSERT INTO public.announcements(id, title, content, created_by) VALUES ($1, $2, $3, $4)',
    [id, 'Markdown missing media', `![Image](${pub(OLD, 'announcement-images', path)})`, SUPER]);
  try {
    const before = await snapshot();
    await expectBlocked(script, /在目标 Storage 没有记录.*missing-markdown\(1\)\.jpg/, '文件迁移核对');
    assert.deepEqual(await snapshot(), before);
  } finally { await db.query('DELETE FROM public.announcements WHERE id = $1', [id]); }
});

test('an old Storage URL in the announcement title stays unchanged without blocking the body switch', async () => {
  await rolledBack(async () => {
    const title = `标题 ${pub(OLD, 'announcement-images', 'title-only-missing.jpg')}`;
    await db.query('UPDATE public.announcements SET title = $1 WHERE id = $2', [title, ids.announcement]);
    const before = await snapshot();
    const triggers = await triggerStates();
    const report = await runScript();
    assert.equal(report[0].结果, '完成');
    const after = await snapshot();
    assert.equal(after.announcements.find(row => row.id === ids.announcement).title, title);
    assert.equal(after.announcements.find(row => row.id === ids.announcement).content,
      before.announcements.find(row => row.id === ids.announcement).content.replaceAll(OLD, NEW));
    assertOnlyAnnouncementsChanged(before, after);
    assert.deepEqual(await triggerStates(), triggers);
  });
});

test('only an explicit allow_missing entry permits a genuinely missing announcement file', async () => {
  await rolledBack(async () => {
    const path = 'confirmed-missing.jpg';
    const content = `<img src="${pub(OLD, 'announcement-images', path)}">`;
    const id = (await db.query('INSERT INTO public.announcements(title, content, created_by) VALUES ($1, $2, $3) RETURNING id',
      ['Confirmed missing', content, SUPER])).rows[0].id;
    const before = await snapshot();
    await expectBlocked(script, /在目标 Storage 没有记录.*confirmed-missing\.jpg/, '文件迁移核对');
    assert.deepEqual(await snapshot(), before);
    const report = await runScript(allowMissing(script, [`announcement-images/${path}`]));
    assert.equal(report[0].结果, '完成（有警告）');
    assert.match(report.find(row => row.项目 === '已确认原站缺失的文件').说明, /^1 个/);
    assert.equal(report.find(row => row.项目 === '后续处理').结果, '有缺失警告');
    const after = await snapshot();
    assert.equal(after.announcements.find(row => row.id === id).content, content.replaceAll(OLD, NEW));
    assertOnlyAnnouncementsChanged(before, after);
  });
});

test('broken cards, signed non-announcement URLs and unverified non-announcement files do not block or get rewritten', async () => {
  await rolledBack(async () => {
    await db.query('UPDATE storage.objects SET user_metadata = null WHERE name <> ALL($1::text[])', [FILES.slice(0, 3).map(([, path]) => path)]);
    const before = await snapshot();
    const triggers = await triggerStates();
    const report = await runScript();
    assert.equal(report[0].结果, '完成');
    assert.match(report.find(row => row.项目 === '被引用的文件').说明, /^3 个唯一桶／路径/);
    assert.match(report.find(row => row.项目 === '已确认原站缺失的文件').说明, /^0 个/);
    assertOnlyAnnouncementsChanged(before, await snapshot());
    assert.deepEqual(await triggerStates(), triggers);
  });
});

test('permission failures roll back and a body-only operator needs no access to other content or trigger ownership', async () => {
  await rolledBack(async () => {
    const unused = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
    await db.query('INSERT INTO private.content_audit_storage_origins(origin) VALUES ($1)', [unused]);
    await db.exec(`CREATE ROLE storage_origin_switch_operator BYPASSRLS;
      GRANT USAGE ON SCHEMA public, private, storage TO storage_origin_switch_operator;
      GRANT SELECT ON public.announcements, storage.objects TO storage_origin_switch_operator;
      GRANT INSERT ON private.content_audit_storage_origins TO storage_origin_switch_operator`);
    const before = await snapshot();
    const triggers = await triggerStates();
    await db.exec('DROP TABLE IF EXISTS pg_temp.storage_origin_switch_report');
    try {
      await db.exec('SET LOCAL ROLE storage_origin_switch_operator');
      await expectBlocked(script, /permission denied for table announcements.*SQLSTATE 42501/, '切换地址');
    } finally { await db.exec('RESET ROLE'); }
    assert.deepEqual(await snapshot(), before, 'permission failure must also roll back the new trusted origin');
    await db.exec('GRANT UPDATE (content) ON public.announcements TO storage_origin_switch_operator');
    let report;
    try {
      await db.exec('SET LOCAL ROLE storage_origin_switch_operator');
      report = await runScript();
    } finally { await db.exec('RESET ROLE'); }
    assert.equal(report[0].结果, '完成', JSON.stringify(report));
    assert(!report[0].说明.includes(unused), 'trusted origins absent from announcement bodies must not become switch sources');
    assertOnlyAnnouncementsChanged(before, await snapshot());
    assert.deepEqual(await triggerStates(), triggers);
  });
});

test('non-public URLs in announcement bodies still block the switch', async () => {
  await rolledBack(async () => {
    await db.query('INSERT INTO public.announcements(title, content, created_by) VALUES ($1, $2, $3)',
      ['Signed URL', `${OLD}/storage/v1/object/sign/announcement-images/private.jpg?token=expired`, SUPER]);
    const before = await snapshot();
    await expectBlocked(script, /发现非公开 Storage 地址/, '扫描当前公告媒体');
    assert.deepEqual(await snapshot(), before);
  });
});

test('multiple announcement origins for one file switch after a v3 file receipt is verified', async () => {
  await rolledBack(async () => {
    const other = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
    await db.query(`UPDATE storage.objects SET user_metadata = jsonb_build_object('storageMigration', jsonb_build_object('target', $1::text, 'bytes', 1, 'sha256', repeat('a', 64), 'version', 3))`, [NEW]);
    await db.query('UPDATE public.announcements SET content = content || $1 WHERE id = $2',
      [`<img src="${pub(other, ...FILES[0])}">`, ids.announcement]);
    const before = await snapshot();
    const report = await runScript();
    assert.equal(report[0].结果, '完成', JSON.stringify(report));
    assert.match(report.find(row => row.项目 === '被引用的文件').说明, /唯一桶／路径/);
    const after = await snapshot();
    const announcement = after.announcements.find(row => row.id === ids.announcement);
    assert(!announcement.content.includes(OLD));
    assert(!announcement.content.includes(other));
    assertOnlyAnnouncementsChanged(before, after);
  });
});

test('a file reserved for permanent deletion still blocks the switch', async () => {
  const before = await snapshot();
  await db.exec('ALTER TABLE private.content_audit_public_media_claims DISABLE TRIGGER ALL');
  await db.query(`INSERT INTO private.content_audit_public_media_claims(bucket_id, path, job_id, job_kind)
    VALUES ($1, $2, $3, 'content')`, [FILES[0][0], FILES[0][1], randomUUID()]);
  await db.exec('ALTER TABLE private.content_audit_public_media_claims ENABLE TRIGGER ALL');
  try {
    await expectBlocked(script, /reserved for permanent deletion/, '切换地址');
    assert.deepEqual(await snapshot(), before);
  } finally {
    await db.query('DELETE FROM private.content_audit_public_media_claims WHERE path = $1', [FILES[0][1]]);
  }
});

test('a silently skipped update returns a failed count check and rolls back the entire switch', async () => {
  await db.exec(`CREATE FUNCTION pg_temp.skip_origin_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER skip_origin_update BEFORE UPDATE ON public.announcements FOR EACH ROW EXECUTE FUNCTION pg_temp.skip_origin_update()`);
  try {
    const before = await snapshot();
    const triggers = await triggerStates();
    const report = await expectBlocked(script, /目标地址数量核对未通过：public\.announcements\.content.*预期.*实际/, '切换后核对');
    assert.match(report[0].说明, /均未保留/);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await triggerStates(), triggers);
  } finally {
    await db.exec('DROP TRIGGER skip_origin_update ON public.announcements; DROP FUNCTION pg_temp.skip_origin_update()');
  }
});

test('an old Storage URL introduced into announcement content during update rolls back all changes', async () => {
  await rolledBack(async () => {
    await db.exec(`CREATE FUNCTION pg_temp.inject_old_origin() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.content := NEW.content || ' ${pub('https://yyyyyyyyyyyyyyyyyyyy.supabase.co', 'announcement-images', 'injected.jpg')}'; RETURN NEW; END $$;
      CREATE TRIGGER inject_old_origin BEFORE UPDATE ON public.announcements FOR EACH ROW EXECUTE FUNCTION pg_temp.inject_old_origin()`);
    const before = await snapshot();
    const triggers = await triggerStates();
    await expectBlocked(script, /仍有旧项目地址残留在：public\.announcements\.content/, '切换后核对');
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await triggerStates(), triggers);
  });
});

test('pre-existing disabled audit triggers and unused trusted origins keep their exact state', async () => {
  await rolledBack(async () => {
    const unused = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
    await db.query('INSERT INTO private.content_audit_storage_origins(origin) VALUES ($1)', [unused]);
    await db.exec('ALTER TABLE public.rich_card_contents DISABLE TRIGGER audit_card_source');
    const before = await snapshot();
    const triggers = await triggerStates();
    const report = await runScript();
    assert.equal(report[0].结果, '完成');
    assert(!report[0].说明.includes(unused));
    assertOnlyAnnouncementsChanged(before, await snapshot());
    assert.deepEqual(await triggerStates(), triggers, '04 must not enable a trigger that was already disabled');
  });
});

test('switches only announcement bodies without allowing missing cards or changing other content, hashes, origins or triggers', async () => {
  const before = await snapshot();
  const triggers = await triggerStates();
  assert.equal((await db.query('SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = $1 AND name = $2', DANGLING)).rows[0].n, 0);
  const report = await runScript();
  const summary = Object.fromEntries(report.map(r => [r.项目, r]));
  assert.equal(summary['总结'].结果, '完成');
  assert.match(summary['总结'].说明, new RegExp(`共改 ${originalOccurrences['public.announcements.content']} 处`));
  assert.match(summary['已确认原站缺失的文件'].说明, /^0 个/);
  assert.equal(summary['被引用的文件'].结果, '凭据通过');
  assert.match(summary['被引用的文件'].说明, /^3 个唯一桶／路径/);
  assert.equal(summary['地址数量核对'].结果, '通过');
  assert.match(summary['地址数量核对'].说明, /1 个媒体字段 public\.announcements\.content/);
  assert.match(summary['旧地址残留'].说明, /公告正文.*残留0个/);
  assert.equal(summary['触发器'].结果, '未改动');
  assert.match(summary['处理范围'].说明, /富卡及哈希.*均未改动/);
  assert.match(summary['内容稽核可信地址'].说明, /全部旧可信来源均保留/);
  assert.equal(summary['实际文件可读性'].结果, '需03复检');
  assert.equal(summary['后续处理'].结果, '请复检');
  assert.deepEqual(report.filter(row => row.结果 === '已修改').map(row => row.项目), ['announcements.content']);

  const expectedOld = { ...originalOccurrences };
  delete expectedOld['public.announcements.content'];
  assert.deepEqual(await oldAddressLocations(), expectedOld, 'all non-announcement old links must remain');
  assert.deepEqual(await oldAddressLocations('ashxnuadjvhqucoobmyp'), {
    'public.announcements.content': originalOccurrences['public.announcements.content'],
    'private.content_audit_storage_origins.origin': 1,
  });
  const after = await snapshot();
  assert.deepEqual(after.announcements, before.announcements.map(row => ({ ...row, content: row.content.replaceAll(OLD, NEW) })));
  assertOnlyAnnouncementsChanged(before, after);
  assert.deepEqual(after.origins, [NEW, OLD].sort());
  assert.deepEqual(await triggerStates(), triggers, 'every trigger must keep its original state');
  await assert.rejects(db.query(`UPDATE public.messages SET content = content || ' ' WHERE id = $1`, [ids.message]),
    /verified administrator session/, 'the notification audit trigger must still be enforcing');
  assert.equal(after.others.rich_card_contents.find(c => c.id === ids.legacyCard).content_hash, null);
  assert.match(after.others.rich_card_contents.find(c => c.id === ids.danglingCard).html_content, /bad-card\.jpg\?token=expired/);
});

test('announcement references in all six known public buckets switch by body usage, not by bucket name', async () => {
  await rolledBack(async () => {
    const media = [FILES[0], FILES[5], FILES[7], FILES[8],
      ['verification-documents', 'announcement-pasted-id.jpg'], ['website-icons', 'announcement-pasted-icon.png']];
    for (const [bucket, path] of media.slice(4)) {
      await db.query('INSERT INTO storage.buckets(id, name, public) VALUES ($1, $1, true) ON CONFLICT DO NOTHING', [bucket]);
      await db.query(`INSERT INTO storage.objects(bucket_id, name, metadata, user_metadata) VALUES ($1, $2, '{"size":1}', $3)`,
        [bucket, path, JSON.stringify({ storageMigration: { target: NEW, bytes: 1, sha256: 'a'.repeat(64), version: 3 } })]);
    }
    const content = media.map(file => `<img src="${pub(OLD, ...file)}">`).join('');
    const id = (await db.query('INSERT INTO public.announcements(title, content, created_by) VALUES ($1, $2, $3) RETURNING id',
      ['Other buckets', content, SUPER])).rows[0].id;
    const before = await snapshot();
    const triggers = await triggerStates();
    const report = await runScript();
    assert.equal(report[0].结果, '完成');
    assert.match(report.find(row => row.项目 === '地址数量核对').说明, /本次切换 6 处/);
    assert.match(report.find(row => row.项目 === '被引用的文件').说明, /^6 个唯一桶／路径/);
    const after = await snapshot();
    assert.equal(after.announcements.find(row => row.id === id).content, content.replaceAll(OLD, NEW));
    assertOnlyAnnouncementsChanged(before, after);
    assert.deepEqual(await triggerStates(), triggers);
  });
});

test('SQL and browser scanning agree on Markdown, CSS and actual parentheses in paths', async () => {
  const html = await readFile(new URL('../migration-check/03_copy_storage_files.html', import.meta.url), 'utf8');
  const core = /<script id="core">([\s\S]*?)<\/script>/.exec(html)[1];
  const extractStorageUrls = new Function(`${core}\nreturn extractStorageUrls;`)();
  const base = `${OLD}/storage/v1/object/public/announcement-images/`;
  const cases = [
    `![Image](${base}image.jpg)`, `[photo](${base}photo(1).jpg)`,
    `![photo]( ${base}nested(a(b)).jpg "title")`, `background:url(${base}bg.jpg)no-repeat`,
    `url(${base}a.jpg),url(${base}b.jpg)`, `<img src="${base}literal).jpg">`,
    `url('${base}trailing.jpg)')`, `![x](<${base}angle.jpg>)`,
    JSON.stringify({ content: `![x](${base}json.jpg)` }), `${base}literal.jpg)`, `![x](${base}encoded%29.jpg)`,
  ];
  for (const content of cases) {
    const rows = (await db.query('SELECT pg_temp.storage_media_urls($1) AS url', [content])).rows;
    assert.deepEqual(rows.map(row => row.url), extractStorageUrls(content), content);
  }
});

test('a mistyped target is rejected because the verified receipts belong to a different project', async () => {
  const typo = 'https://ashxnuadjvhqucoobmyx.supabase.co';
  const before = await snapshot();
  await expectBlocked(withNew(typo), /没有复制到这个项目/, '文件迁移核对');
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual(await oldAddressLocations('ashxnuadjvhqucoobmyx'), {});
  assert.equal((await runScript()).find(r => r['项目'] === '无需切换').结果, '通过');
});

test('later publications with several source projects and URL-encoded filenames switch on the next run', async () => {
  const other = 'https://zzzzzzzzzzzzzzzzzzzz.supabase.co';
  const paths = ['later/image.jpg', 'later/图片 1.jpg', 'later/photo(1).jpg', 'later/a&b.jpg', 'later/markdown(1).jpg', 'later/background.jpg', 'later/literal).jpg'];
  for (const path of paths) {
    await db.query(`INSERT INTO storage.objects(bucket_id, name, metadata, user_metadata)
      VALUES ('announcement-images', $1, '{"size":42}', $2)`,
    [path, JSON.stringify({ storageMigration: { target: NEW, bytes: 42, sha256: 'a'.repeat(64), version: 3 } })]);
  }
  const content = `<img src="${pub(NEW, 'announcement-images', paths[0])}"><img src="${pub(OLD, 'announcement-images', paths[0])}"><img src="${pub(other, 'announcement-images', 'later/%E5%9B%BE%E7%89%87%201.jpg')}"><img src="${pub(OLD, 'announcement-images', paths[2])}"><img src="${pub(OLD, 'announcement-images', 'later/a&amp;b.jpg')}">![Image](${pub(OLD, 'announcement-images', paths[4])})<div style="background:url(${pub(other, 'announcement-images', paths[5])})"></div><img src="${pub(OLD, 'announcement-images', paths[6])}">`;
  const id = (await db.query('INSERT INTO public.announcements(title, content, created_by) VALUES ($1, $2, $3) RETURNING id', ['Later publication', content, SUPER])).rows[0].id;
  const report = await runScript();
  assert.equal(report.find(row => row['项目'] === '总结').结果, '完成');
  assert.match(report.find(row => row.项目 === '地址数量核对').说明, /本次切换 7 处/);
  const saved = (await db.query('SELECT content FROM public.announcements WHERE id = $1', [id])).rows[0].content;
  assert.equal(saved, content.replaceAll(OLD, NEW).replaceAll(other, NEW));
  assert.equal((await runScript()).find(row => row['项目'] === '无需切换').结果, '通过');
});

test('running again with old links only in non-announcement content needs no switch and changes nothing', async () => {
  const oldHits = await oldAddressLocations();
  assert(oldHits['public.messages.content'] > 0);
  assert(oldHits['public.rich_card_contents.html_content'] > 0);
  assert.equal(oldHits['public.announcements.content'], undefined);
  const before = await snapshot();
  const report = await runScript();
  assert.equal(report[0].项目, '无需切换');
  assert.equal(report[0].结果, '通过');
  assert.equal(report.find(row => row.项目 === '地址数量核对').结果, '通过');
  assert.equal(report.find(row => row.项目 === '实际文件可读性').结果, '需03复检');
  assert(!report.some(row => row.结果 === '已修改'));
  assert.deepEqual(await snapshot(), before);
});

test('an unknown source in the title stays unchanged and does not block a nothing-to-switch result', async () => {
  const other = 'https://yyyyyyyyyyyyyyyyyyyy.supabase.co';
  const title = (await db.query('SELECT title FROM public.announcements WHERE id = $1', [ids.announcement])).rows[0].title;
  await db.query('UPDATE public.announcements SET title = $1 WHERE id = $2', [pub(other, 'announcement-images', 'unreviewed.jpg'), ids.announcement]);
  try {
    const before = await snapshot();
    const triggers = await triggerStates();
    const report = await runScript();
    assert.equal(report[0].项目, '无需切换');
    assert.equal(report[0].结果, '通过');
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await triggerStates(), triggers);
  } finally {
    await db.query('UPDATE public.announcements SET title = $1 WHERE id = $2', [title, ids.announcement]);
  }
});

test('preserved historical evidence keeps its media-in-use protection', async () => {
  const path = 'history-only.jpg';
  await db.query(`INSERT INTO storage.objects(bucket_id, name, metadata) VALUES ('announcement-images', $1, '{"size":1}')`, [path]);
  await db.query('INSERT INTO private.content_audit_storage_origins(origin) VALUES ($1) ON CONFLICT DO NOTHING', [OLD]);
  const beforeData = { content: `<img src="${pub(OLD, 'announcement-images', path)}">` };
  const event = (await db.query(`INSERT INTO private.content_audit_events(operation_id, entity_type, entity_id, action, owner_admin_id, actor_admin_id, actor_username, actor_role, before_data)
    VALUES ($1, 'notification', $2, 'edit', $3, $3, 'root', 'super_admin', $4) RETURNING id`,
  [randomUUID(), ids.message, SUPER, JSON.stringify(beforeData)])).rows[0].id;
  const inUse = async () => (await db.query(`SELECT private.content_audit_public_media_in_use('announcement-images', $1) AS yes`, [path])).rows[0].yes;
  assert.equal(await inUse(), true);
  const before = await snapshot();
  const report = await runScript();
  assert.match(report.find(row => row.项目 === '内容稽核可信地址').说明, /全部旧可信来源均保留，未扫描历史用途/);
  assert.equal(await inUse(), true, 'history-only media must still be protected after origin switching');
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual((await db.query('SELECT before_data FROM private.content_audit_events WHERE id = $1', [event])).rows[0].before_data, beforeData);
  assert((await snapshot()).origins.includes(OLD));
});
