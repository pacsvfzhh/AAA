import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

// In-memory database only: never read a Supabase URL, key, account or connection string.
// Keep the real history, business functions, RLS and triggers; do not repair replay gaps here.
const migration = '20261103000003_remove_rich_content_length_limits.sql';
const migrationDir = new URL('../migrations/', import.meta.url);
const supportDir = new URL('./support/', import.meta.url);
const historicalFailures = [
  '20251031230000_add_admins_update_policy.sql',
  '20251114230000_add_admin_scope_to_account_locks.sql',
  '20251114235000_fix_account_locks_rls_policies.sql',
  '20251129073341_fix_all_function_search_paths.sql',
  '20260411213553_insert_bart_members_simulation_data.sql',
  '20260411213832_fix_bart_commission_amounts_and_wallet_balances.sql',
  '20260706000801_revoke_unused_security_definer_functions.sql',
  '20260706001347_fix_security_definer_revoke_from_public.sql',
  '20260706002034_convert_client_functions_to_security_invoker.sql',
  '20260706002123_convert_internal_functions_to_security_invoker.sql',
  '20260928080144_align_weighted_dispatch_assignment.sql',
  '20261026000000_archive_legacy_empty_notifications.sql',
];
const sendSignature = 'public.send_admin_message_secure(uuid,uuid[],text,text,text,text,numeric,uuid)';
const auditSignature = 'public.commit_content_audit_change(uuid,text,uuid[],uuid,text,jsonb,uuid,jsonb)';
const patches = [
  {
    signature: sendSignature,
    old: "IF char_length(trim(COALESCE(p_content, ''))) NOT BETWEEN 1 AND 5000 THEN\n    RAISE EXCEPTION 'Message content must contain between 1 and 5000 characters.';",
    replacement: "IF char_length(trim(COALESCE(p_content, ''))) = 0 THEN\n    RAISE EXCEPTION 'Message content must not be empty.';",
  },
  {
    signature: auditSignature,
    old: "char_length(trim(COALESCE(p_payload ->> 'content', ''))) NOT BETWEEN 1 AND 100000",
    replacement: "char_length(trim(COALESCE(p_payload ->> 'content', ''))) = 0",
  },
];
const constraintKeys = [
  'public.messages.messages_content_length',
  'public.notification_automation_tasks.notification_automation_tasks_content_template_check',
];
const SUPER = '00000000-0000-4000-8000-000000000101';
const TEAM = '00000000-0000-4000-8000-000000000102';
const OTHER = '00000000-0000-4000-8000-000000000103';
const EMERGENCY = '00000000-0000-4000-8000-000000000104';
const TAB = 'rich-content-local-tab';
const PASSWORD = 'local-rich-content-password';
const actors = [
  [SUPER, 'rich-content-root', 'super_admin'],
  [TEAM, 'rich-content-team', 'secondary_admin'],
  [OTHER, 'rich-content-other', 'secondary_admin'],
  [EMERGENCY, 'rich-content-emergency', 'emergency_admin'],
];
const tokens = {};
const employees = {};
const failures = [];
let db;
let replayedFiles;
let previousCatalog;
let nextCatalog;
let sequence = 0;
// Both bytes and characters exceed the old ceilings. Distinct ends detect truncation.
const largeHTML = `<article><h2>完整中文富文本开始</h2>${'<p><strong>中文正文与奖励核对</strong> — HTML &amp; 往返测试。</p>'.repeat(12000)}<p>完整中文富文本结束</p></article>`;
const editedHTML = `<section>修改后的完整正文${largeHTML}<p>新版本结束</p></section>`;
const digest = value => createHash('sha256').update(value).digest('hex');
function fullText(actual, expected) {
  assert.equal(typeof actual, 'string');
  assert(actual === expected, `Full content differs (expected ${Buffer.byteLength(expected)} bytes, SHA256 ${digest(expected)}; got ${Buffer.byteLength(actual)} bytes, SHA256 ${digest(actual)}).`);
}
async function asRole(sql, params = [], role = 'anon') {
  assert(['anon', 'authenticated', 'service_role'].includes(role));
  await db.exec(`SET ROLE ${role}`);
  try { return await db.query(sql, params); }
  finally { await db.exec('RESET ROLE'); }
}
async function call(name, args, role = 'anon') {
  assert.match(name, /^[a-z_][a-z_0-9]*$/);
  const keys = Object.keys(args);
  assert(keys.every(key => /^p_[a-z_]+$/.test(key)));
  return (await asRole(`SELECT public.${name}(${keys.map((key, i) => `${key} => $${i + 1}`).join(', ')}) AS result`, keys.map(key => args[key]), role)).rows[0].result;
}
function sendArgs(overrides = {}) {
  return {
    p_admin_session_token: tokens[TEAM], p_recipient_ids: [employees[TEAM].user.id],
    p_title: '本地長正文通知', p_content: largeHTML,
    p_delivery_mode: 'realtime_with_login_fallback', p_priority: 'normal',
    p_reward_amount: null, p_operation_id: randomUUID(), ...overrides,
  };
}
const send = args => call('send_admin_message_with_delivery', args);
const prepare = (action, id, token = tokens[TEAM]) => call('prepare_content_audit_change', {
  p_admin_session_token: token, p_action: action, p_target_ids: [id], p_employee_id: null,
}, 'service_role');
const commit = (action, id, hash, payload, overrides = {}, role = 'service_role') => call('commit_content_audit_change', {
  p_admin_session_token: tokens[TEAM], p_action: action, p_target_ids: [id], p_employee_id: null,
  p_expected_hash: hash, p_payload: payload, p_operation_id: randomUUID(), p_media: { [id]: {} }, ...overrides,
}, role);
async function employeeMessages(employee, overrides = {}) {
  return call('get_employee_notification_messages', {
    p_user_id: employee.user.id, p_session_token: employee.session_token, p_tab_id: TAB,
    p_filter: 'all', p_limit: 300, ...overrides,
  });
}
async function roundTripMessage(id, expected, recipients = [employees[TEAM]]) {
  const row = (await db.query('SELECT content, char_length(content) AS characters, octet_length(content) AS bytes FROM public.messages WHERE id = $1', [id])).rows[0];
  fullText(row.content, expected);
  assert.equal(row.characters, [...expected].length);
  assert.equal(row.bytes, Buffer.byteLength(expected));
  for (const employee of recipients) {
    const received = (await employeeMessages(employee)).find(item => item.message_id === id);
    assert(received, 'The real employee-session RPC must return the notification.');
    fullText(received.messages.content, expected);
  }
}
async function catalog() {
  return {
    functions: (await db.query(`SELECT p.oid::text AS oid, n.nspname AS schema, p.proname AS name,
      pg_get_functiondef(p.oid) AS definition,
      (to_jsonb(p) - 'prosrc' - 'prosqlbody') AS metadata
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('public', 'private') AND p.prokind IN ('f', 'p') ORDER BY p.oid`)).rows,
    constraints: (await db.query(`SELECT n.nspname || '.' || c.relname || '.' || k.conname AS key,
      pg_get_constraintdef(k.oid) AS definition, to_jsonb(k) AS metadata
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'private') ORDER BY 1`)).rows,
    tables: (await db.query(`SELECT c.oid::text, c.relowner, c.relacl::text, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'private') AND c.relkind IN ('r', 'p', 'S') ORDER BY c.oid`)).rows,
    columns: (await db.query(`SELECT a.attrelid::text, a.attnum, a.attname, a.atttypid, a.atttypmod,
      a.attnotnull, a.attacl::text, pg_get_expr(d.adbin, d.adrelid) AS default_value
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname IN ('public', 'private') AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum`)).rows,
    policies: (await db.query(`SELECT to_jsonb(p) AS policy FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'private') ORDER BY p.oid`)).rows,
    triggers: (await db.query(`SELECT to_jsonb(t) AS trigger, pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('public', 'private') ORDER BY t.oid`)).rows,
  };
}
async function effects() {
  const tables = ['public.messages', 'public.message_recipients', 'public.financial_operations',
    'public.wallet_transactions', 'public.wallet_ledger_entries', 'private.notification_delivery_operations', 'private.content_audit_events'];
  const counts = {};
  for (const table of tables) counts[table] = Number((await db.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
  return {
    counts,
    balances: (await db.query(`SELECT u.id, u.total_income, w.available_balance, w.frozen_balance FROM public.users u
      JOIN public.wallets w ON w.user_id = u.id WHERE u.id = ANY($1::uuid[]) ORDER BY u.id`, [Object.values(employees).map(employee => employee.user.id)])).rows,
  };
}
async function rejectWithoutEffects(action, expected) {
  const previous = await effects();
  await assert.rejects(action, expected);
  assert.deepEqual(await effects(), previous, 'Rejected writes must not send, credit, register operations or create audit events.');
}
async function newCustomer(source) {
  return (await db.query(`INSERT INTO public.simulated_customers(admin_id, customer_name, source_type)
    VALUES ($1, $2, $3) RETURNING id`, [TEAM, `Rich QA ${source} ${++sequence}`, source])).rows[0].id;
}
async function chat(customerId, source, extra = {}) {
  const columns = { customer_id: customerId, employee_id: employees[TEAM].user.id, sender_type: 'customer',
    message_content: '本地聊天內容', message_type: 'text', source_type: source, ...extra };
  const keys = Object.keys(columns);
  return (await db.query(`INSERT INTO public.customer_employee_conversations(${keys.join(', ')})
    VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(columns))).rows[0];
}
async function frozenHTML(messageId) {
  return (await db.query(`SELECT c.content_frozen, c.source_type, r.html_content, r.content_hash FROM public.customer_employee_conversations c
    JOIN public.rich_card_contents r ON r.id = c.rich_card_content_id WHERE c.id = $1`, [messageId])).rows[0];
}
async function saveTask(planId, content, overrides = {}) {
  return call('save_notification_automation_task_v2', {
    p_admin_session_token: tokens[TEAM], p_owner_admin_id: TEAM, p_plan_id: planId, p_task_id: null,
    p_name: `Rich QA task ${++sequence}`, p_description: '', p_trigger_type: 'total_orders', p_trigger_mode: 'reach_once',
    p_threshold_value: 100, p_minimum_daily_orders: null, p_minimum_daily_work_minutes: null,
    p_annual_month: null, p_annual_day: null, p_recipient_scope: 'selected', p_recipient_ids: [],
    p_title_template: '自動通知正文測試', p_content_template: content, p_delivery_mode: 'realtime_only',
    p_priority: 'normal', p_reward_enabled: false, p_reward_amount: null, p_starts_at: null, p_ends_at: null, ...overrides,
  });
}

before(async () => {
  assert(Buffer.byteLength(largeHTML) > 500 * 1024);
  assert(largeHTML.length > 100000);
  const segments = [{ before: null, sql: '' }];
  for (const line of (await readFile(new URL('baseline.sql', supportDir), 'utf8')).split('\n')) {
    const marker = line.match(/^-- @before (\S+)/);
    if (marker) segments.push({ before: marker[1], sql: '' });
    else segments.at(-1).sql += `${line}\n`;
  }
  db = new PGlite({ extensions: { pgcrypto, pg_trgm, uuid_ossp } });
  await db.exec(await readFile(new URL('platform.sql', supportDir), 'utf8'));
  const files = (await readdir(migrationDir)).filter(file => file.endsWith('.sql')).sort();
  assert(files.includes(migration), `Required migration is not present yet: ${migration}`);
  replayedFiles = files.length;
  for (const [index, file] of files.entries()) {
    for (const segment of segments) if (segment.before && file.startsWith(segment.before)) await db.exec(segment.sql);
    if (file === migration) previousCatalog = await catalog();
    // PGlite supplies pg_trgm; pg_cron is the existing platform support fixture, not a business-function substitute.
    const sql = (await readFile(new URL(file, migrationDir), 'utf8'))
      .replace(/CREATE EXTENSION IF NOT EXISTS pg_cron[^;]*;/gi, '')
      .replace(/CREATE EXTENSION IF NOT EXISTS pg_trgm;/gi, '');
    try { await db.exec(sql); }
    catch (error) {
      failures.push({ file, message: String(error.message).split('\n')[0] });
      try { await db.exec('ROLLBACK'); } catch { /* Some historical files do not open transactions. */ }
      assert(historicalFailures.includes(file), `NEW migration replay failure in ${file}: ${error.message}`);
    }
    if (file === migration) nextCatalog = await catalog();
    if (index === 0) await db.exec(segments[0].sql);
  }
  assert.deepEqual(failures.map(failure => failure.file), historicalFailures, 'Do not silently accept new failures or a changed historical allowlist.');
  for (const [id, username, role] of actors) {
    await db.query(`INSERT INTO public.admins(id, username, password_hash, role, parent_id)
      VALUES ($1, $2, extensions.crypt($3, extensions.gen_salt('bf', 4)), $4, $5)`, [id, username, PASSWORD, role, id === SUPER ? null : SUPER]);
    await db.query(`INSERT INTO public.financial_admin_credentials(admin_id, password_hash)
      SELECT id, password_hash FROM public.admins WHERE id = $1
      ON CONFLICT (admin_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [id]);
    // Use the real login RPC, including for the emergency administrator (whose session cannot send).
    const session = await call('create_admin_financial_session', { p_username: username, p_password: PASSWORD });
    assert.equal(session.success, true, `Local ${role} financial login must succeed.`);
    tokens[id] = session.session_token;
  }
  for (const owner of [SUPER, TEAM, OTHER]) {
    const username = `rich-content-employee-${++sequence}`;
    await db.query(`INSERT INTO public.users(username, employee_id, password_hash, created_by, is_verified)
      VALUES ($1, $1, extensions.crypt($2, extensions.gen_salt('bf', 4)), $3, true)`, [username, PASSWORD, owner]);
    await db.query(`INSERT INTO public.financial_employee_credentials(user_id, password_hash)
      SELECT id, password_hash FROM public.users WHERE username = $1
      ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`, [username]);
    const session = await call('create_employee_financial_session', { p_username: username, p_password: PASSWORD, p_tab_id: TAB });
    assert.equal(session.success, true, 'Local employee financial login must succeed.');
    employees[owner] = session;
  }
}, { timeout: 600000 });
after(async () => { await db?.close(); });

test('real migration history has exactly the twelve known failures, with no new failure', t => {
  t.diagnostic(`Replayed ${replayedFiles} real migrations in an in-memory PGlite database; ${failures.length} known historical failures. This is not a clean-database or production-deployment proof.`);
  for (const failure of failures) t.diagnostic(`${failure.file}: ${failure.message}`);
  t.diagnostic('No remote database, real accounts, trigger overrides or replacement business functions. Storage/Edge HTTP and native multi-connection concurrency are not exercised.');
  assert.deepEqual(failures.map(failure => failure.file), historicalFailures);
  assert(!failures.some(failure => failure.file >= migration));
});

test('complete function definitions differ only by the two exact intended replacements; every function ACL/signature/owner/config stays unchanged', () => {
  const changes = new Map();
  for (const patch of patches) {
    const oldFunction = previousCatalog.functions.find(fn => fn.name === patch.signature.split('.')[1].split('(')[0]);
    assert(oldFunction, patch.signature);
    assert.equal(oldFunction.definition.split(patch.old).length - 1, 1, `Expected exactly one old validation anchor in ${patch.signature}.`);
    changes.set(oldFunction.oid, oldFunction.definition.replace(patch.old, patch.replacement));
  }
  assert.equal(nextCatalog.functions.length, previousCatalog.functions.length);
  for (let i = 0; i < previousCatalog.functions.length; i++) {
    const original = previousCatalog.functions[i];
    const current = nextCatalog.functions[i];
    assert.equal(current.oid, original.oid);
    assert.deepEqual(current.metadata, original.metadata, `${original.schema}.${original.name}: signature, ACL, owner and security settings`);
    assert.equal(current.definition, changes.get(original.oid) ?? original.definition, `${original.schema}.${original.name}: unexpected definition change`);
  }
  // In particular, chat_edit's 100000-character/image safeguards and the retired RPC were not patched.
  assert(previousCatalog.functions.some(fn => fn.name === 'update_admin_message_content_with_session'));
  assert(nextCatalog.functions.find(fn => fn.name === 'commit_content_audit_change').definition.includes("char_length(COALESCE(p_payload ->> 'message_content', '')) NOT BETWEEN 1 AND 100000"));
});

test('only the two body constraints change; all other constraints, NOT NULLs, table/column ACLs, RLS policies and triggers stay identical', () => {
  const unchanged = snapshot => snapshot.constraints.filter(item => !constraintKeys.includes(item.key));
  assert.deepEqual(unchanged(nextCatalog), unchanged(previousCatalog));
  assert.equal(nextCatalog.constraints.length, previousCatalog.constraints.length);
  const expected = [
    ['CHECK (((char_length(content) > 0) AND (char_length(content) <= 100000)))', 'CHECK ((char_length(content) > 0))'],
    ['CHECK (((char_length(TRIM(BOTH FROM content_template)) >= 1) AND (char_length(TRIM(BOTH FROM content_template)) <= 5000)))', 'CHECK ((char_length(TRIM(BOTH FROM content_template)) >= 1))'],
  ];
  for (let i = 0; i < constraintKeys.length; i++) {
    assert.equal(previousCatalog.constraints.find(item => item.key === constraintKeys[i]).definition, expected[i][0]);
    const current = nextCatalog.constraints.find(item => item.key === constraintKeys[i]);
    assert.equal(current.definition, expected[i][1]);
    assert.equal(current.metadata.convalidated, true);
  }
  for (const key of ['tables', 'columns', 'policies', 'triggers']) assert.deepEqual(nextCatalog[key], previousCatalog[key], key);
});

test('browser still uses the delivery wrapper; secure sender, retired updater and both audit RPCs are not exposed', async () => {
  for (const signature of [sendSignature, auditSignature, 'public.prepare_content_audit_change(uuid,text,uuid[],uuid)',
    'public.update_admin_message_content_with_session(uuid,uuid,text,text)']) {
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query('SELECT has_function_privilege($1, to_regprocedure($2), $3) AS allowed', [role, signature, 'EXECUTE'])).rows[0].allowed, false);
    }
    const publicGrant = (await db.query(`SELECT EXISTS(SELECT 1 FROM aclexplode(COALESCE(proacl, acldefault('f', proowner))) WHERE grantee = 0 AND privilege_type = 'EXECUTE') AS allowed FROM pg_proc WHERE oid = to_regprocedure($1)`, [signature])).rows[0].allowed;
    assert.equal(publicGrant, false);
  }
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query(`SELECT has_function_privilege($1, 'public.send_admin_message_with_delivery(uuid,uuid[],text,text,text,text,numeric,uuid)', 'EXECUTE') AS allowed`, [role])).rows[0].allowed, true);
  }
  for (const signature of [auditSignature, 'public.prepare_content_audit_change(uuid,text,uuid[],uuid)']) {
    assert.equal((await db.query('SELECT has_function_privilege($1, to_regprocedure($2), $3) AS allowed', ['service_role', signature, 'EXECUTE'])).rows[0].allowed, true);
  }
  await assert.rejects(asRole('SELECT public.send_admin_message_secure($1,$2,$3,$4,$5,$6,$7,$8)', [tokens[TEAM], [employees[TEAM].user.id], 'Title', 'Body', 'realtime', 'normal', null, randomUUID()]), /permission denied for function/);
});

for (const [name, body] of [['5001 characters', 'a'.repeat(5001)], ['100001 characters', 'b'.repeat(100001)], ['Chinese HTML over 500KB', largeHTML]]) {
  test(`secondary administrator sends ${name} through the real wrapper and employee RPC without truncation`, async () => {
    const result = await send(sendArgs({ p_content: body }));
    assert.equal(result.success, true);
    assert.equal(result.sent_count, 1);
    await roundTripMessage(result.message_id, body);
    const message = (await db.query('SELECT audit_origin, delivery_mode FROM public.messages WHERE id = $1', [result.message_id])).rows[0];
    assert.deepEqual(message, { audit_origin: 'manual_admin', delivery_mode: 'realtime_with_login_fallback' });
  });
}

test('super administrator can send a long reward notification across groups; exact operation retry credits each recipient only once', async () => {
  const recipients = [employees[TEAM], employees[OTHER], employees[SUPER]];
  const args = sendArgs({ p_admin_session_token: tokens[SUPER], p_recipient_ids: recipients.map(employee => employee.user.id), p_reward_amount: 12.34 });
  const previous = await effects();
  const result = await send(args);
  assert.equal(result.success, true);
  assert.equal(result.sent_count, recipients.length);
  assert.equal(result.total_reward, 37.02);
  await roundTripMessage(result.message_id, largeHTML, recipients);
  const credited = await effects();
  for (const balance of credited.balances) {
    const old = previous.balances.find(item => item.id === balance.id);
    assert.equal(Number(balance.available_balance) - Number(old.available_balance), 12.34);
    assert.equal(Number(balance.total_income) - Number(old.total_income), 12.34);
    assert.equal(balance.frozen_balance, old.frozen_balance);
  }
  assert.equal(credited.counts['public.messages'] - previous.counts['public.messages'], 1);
  assert.equal(credited.counts['public.message_recipients'] - previous.counts['public.message_recipients'], 3);
  assert.equal(credited.counts['public.wallet_transactions'] - previous.counts['public.wallet_transactions'], 3);
  assert.equal(credited.counts['public.wallet_ledger_entries'] - previous.counts['public.wallet_ledger_entries'], 3);
  assert.equal(credited.counts['public.financial_operations'] - previous.counts['public.financial_operations'], 1);
  const bonusRows = (await db.query(`SELECT t.user_id, t.type, t.amount, l.available_delta, l.income_delta, l.frozen_delta
    FROM public.wallet_transactions t JOIN public.message_recipients r ON r.id = t.reference_id
    JOIN public.wallet_ledger_entries l ON l.source_id = t.id AND l.source_type = 'wallet_transaction'
    WHERE r.message_id = $1 ORDER BY t.user_id`, [result.message_id])).rows;
  assert.equal(bonusRows.length, 3);
  for (const bonus of bonusRows) {
    assert.equal(bonus.type, 'performance_bonus');
    for (const key of ['amount', 'available_delta', 'income_delta']) assert.equal(Number(bonus[key]), 12.34);
    assert.equal(Number(bonus.frozen_delta), 0);
  }
  assert.deepEqual(await send(args), result);
  assert.deepEqual(await effects(), credited);
  await rejectWithoutEffects(() => send({ ...args, p_content: `${largeHTML}changed` }), /financial operation ID is already in use/);
  await rejectWithoutEffects(() => send({ ...args, p_delivery_mode: 'login_only' }), /different delivery mode/);
});

for (const [name, overrides, error] of [
  ['empty body', { p_content: '' }, /Message content must not be empty/],
  ['spaces-only body', { p_content: '   ' }, /Message content must not be empty/],
  ['NULL body', { p_content: null }, /Message content must not be empty/],
  ['no recipients', { p_recipient_ids: [] }, /Select at least one employee/],
  ['NULL recipients', { p_recipient_ids: null }, /Select at least one employee/],
  ['201-character title', { p_title: '題'.repeat(201) }, /between 1 and 200/],
  ['blank title', { p_title: '  ' }, /between 1 and 200/],
  ['NULL title', { p_title: null }, /between 1 and 200/],
  ['zero reward', { p_reward_amount: 0 }, /finite positive amount/],
  ['negative reward', { p_reward_amount: -1 }, /finite positive amount/],
  ['NaN reward', { p_reward_amount: 'NaN' }, /finite positive amount/],
  ['unsupported priority', { p_priority: 'not-a-priority' }, /Unsupported message priority/],
  ['unsupported delivery mode', { p_delivery_mode: 'not-a-mode' }, /Unsupported notification delivery mode/],
  ['NULL operation', { p_operation_id: null }, /null value|operation ID is required/],
]) {
  test(`sender still rejects ${name} without side effects`, () => rejectWithoutEffects(() => send(sendArgs(overrides)), error));
}

test('the 200-character title boundary still succeeds', async () => {
  const result = await send(sendArgs({ p_title: '題'.repeat(200) }));
  assert.equal(result.success, true);
  assert.equal((await db.query('SELECT char_length(title) AS length FROM public.messages WHERE id = $1', [result.message_id])).rows[0].length, 200);
});

test('secondary cross-group recipients, invalid/emergency/employee tokens are rejected atomically even with a long body and bonus', async () => {
  await rejectWithoutEffects(() => send(sendArgs({ p_recipient_ids: [employees[TEAM].user.id, employees[OTHER].user.id], p_reward_amount: 8 })), /outside your management scope/);
  for (const token of [randomUUID(), null, tokens[EMERGENCY], employees[TEAM].session_token]) {
    await rejectWithoutEffects(() => send(sendArgs({ p_admin_session_token: token, p_reward_amount: 8 })), /administrator session is invalid or expired/);
  }
  const temporary = await call('create_admin_financial_session', { p_username: 'rich-content-team', p_password: PASSWORD });
  await db.query(`UPDATE public.admin_financial_sessions SET expires_at = now() - interval '1 second' WHERE token_hash = private.hash_financial_token($1)`, [temporary.session_token]);
  await rejectWithoutEffects(() => send(sendArgs({ p_admin_session_token: temporary.session_token })), /invalid or expired/);
  const revoked = await call('create_admin_financial_session', { p_username: 'rich-content-team', p_password: PASSWORD });
  await db.query('UPDATE public.admin_financial_sessions SET revoked_at = now() WHERE token_hash = private.hash_financial_token($1)', [revoked.session_token]);
  await rejectWithoutEffects(() => send(sendArgs({ p_admin_session_token: revoked.session_token })), /invalid or expired/);
});

test('employee notification reader still validates the real token, user and tab binding', async () => {
  await assert.rejects(employeeMessages(employees[TEAM], { p_session_token: randomUUID() }), /invalid or expired/);
  await assert.rejects(employeeMessages(employees[TEAM], { p_user_id: employees[OTHER].user.id }), /invalid or expired/);
  await assert.rejects(employeeMessages(employees[TEAM], { p_tab_id: 'wrong-local-tab' }), /invalid or expired/);
});

test('notification_edit saves a body over 500KB, preserves complete before/after evidence and rejects a stale hash', async () => {
  const sent = await send(sendArgs());
  const prepared = await prepare('notification_edit', sent.message_id);
  fullText(prepared.snapshots[0].message.content, largeHTML);
  const operation = randomUUID();
  assert.equal((await commit('notification_edit', sent.message_id, prepared.hash, { title: '修改後標題', content: editedHTML }, { p_operation_id: operation })).success, true);
  await roundTripMessage(sent.message_id, editedHTML);
  const evidence = (await db.query('SELECT * FROM private.content_audit_events WHERE operation_id = $1', [operation])).rows;
  assert.equal(evidence.length, 1);
  const event = evidence[0];
  assert.equal(event.entity_type, 'notification'); assert.equal(event.entity_id, sent.message_id);
  assert.equal(event.action, 'edit'); assert.equal(event.actor_admin_id, TEAM); assert.equal(event.owner_admin_id, TEAM);
  fullText(event.before_data.message.content, largeHTML);
  fullText(event.after_data.message.content, editedHTML);
  assert.equal(event.before_data.recipients.length, 1);
  assert.equal(event.before_data.recipients[0].recipient_id, employees[TEAM].user.id);
  await rejectWithoutEffects(() => commit('notification_edit', sent.message_id, prepared.hash, { title: '過期修改', content: largeHTML }), /Content changed; refresh/);
  await roundTripMessage(sent.message_id, editedHTML);
});

test('notification_edit retains nonempty/title checks, ownership, admin-session validation, service-only ACL and evidence manifest enforcement', async () => {
  const sent = await send(sendArgs({ p_content: 'Before audited edit' }));
  const prepared = await prepare('notification_edit', sent.message_id);
  for (const content of ['', '   ', null]) {
    await rejectWithoutEffects(() => commit('notification_edit', sent.message_id, prepared.hash, { title: 'Valid title', content }), /Notification title or content is invalid/);
  }
  await rejectWithoutEffects(() => commit('notification_edit', sent.message_id, prepared.hash, { title: '題'.repeat(201), content: largeHTML }), /Notification title or content is invalid/);
  await rejectWithoutEffects(() => commit('notification_edit', sent.message_id, prepared.hash, { title: 'Valid', content: largeHTML }, { p_admin_session_token: tokens[OTHER] }), /not accessible or has changed/);
  for (const token of [randomUUID(), tokens[EMERGENCY], employees[TEAM].session_token]) {
    await rejectWithoutEffects(() => commit('notification_edit', sent.message_id, prepared.hash, { title: 'Valid', content: largeHTML }, { p_admin_session_token: token }), /invalid or expired/);
  }
  await rejectWithoutEffects(() => commit('notification_edit', sent.message_id, prepared.hash, { title: 'Valid', content: largeHTML }, {}, 'anon'), /permission denied for function/);
  await rejectWithoutEffects(() => commit('notification_edit', sent.message_id, prepared.hash, { title: 'Valid', content: largeHTML }, { p_media: {} }), /missing from the evidence attachment manifest/);
  fullText((await db.query('SELECT content FROM public.messages WHERE id = $1', [sent.message_id])).rows[0].content, 'Before audited edit');
});

test('notification_edit does not weaken image evidence safeguards when the body is long', async () => {
  const sent = await send(sendArgs({ p_content: 'No old images' }));
  const prepared = await prepare('notification_edit', sent.message_id);
  const image = 'https://hxpbpqoqkoiiplvdwmld.supabase.co/storage/v1/object/public/template-images/local-rich-content-only.png';
  await rejectWithoutEffects(() => commit('notification_edit', sent.message_id, prepared.hash, { title: 'Image evidence', content: `${largeHTML}<img src="${image}">` }), /new attachment was not preserved/);
});

test('automation task RPC accepts long HTML unchanged while preserving nonempty/NULL/title constraints and group isolation', async () => {
  const plan = await call('save_notification_automation_plan', { p_admin_session_token: tokens[TEAM], p_owner_admin_id: TEAM, p_plan_id: null, p_name: 'Local long-content plan', p_description: '' });
  assert.equal(plan.success, true);
  const saved = await saveTask(plan.plan.id, largeHTML);
  assert.equal(saved.success, true);
  const taskId = saved.task?.id ?? saved.task_id;
  assert(taskId, 'The real task RPC must return the saved task.');
  fullText((await db.query('SELECT content_template FROM public.notification_automation_tasks WHERE id = $1', [taskId])).rows[0].content_template, largeHTML);
  for (const body of ['', '   ', null]) {
    await assert.rejects(saveTask(plan.plan.id, body), /content_template_check|not-null constraint/);
  }
  await assert.rejects(saveTask(plan.plan.id, largeHTML, { p_title_template: '題'.repeat(201) }), /title_template_check/);
  await assert.rejects(saveTask(plan.plan.id, largeHTML, { p_admin_session_token: tokens[OTHER] }), /You cannot manage another administrator group/);
  // Exercise the table CHECK itself too, rather than relying only on RPC validation.
  for (const body of ['', '   ', null]) {
    await assert.rejects(db.query('UPDATE public.notification_automation_tasks SET content_template = $1 WHERE id = $2', [body, taskId]), /content_template_check|not-null constraint/);
  }
  fullText((await db.query('SELECT content_template FROM public.notification_automation_tasks WHERE id = $1', [taskId])).rows[0].content_template, largeHTML);
});

for (const source of ['aaa_service', 'ccc_service']) {
  test(`${source} rich-card template and auto-message bodies over 500KB create and freeze fully; audited source edits do not alter delivered cards`, async () => {
    const customerId = await newCustomer(source);
    const templateId = (await db.query(`INSERT INTO public.cs_message_templates(admin_id, name, content, content_type, source_type)
      VALUES ($1, 'Local long-content template', $2, 'rich_card', $3) RETURNING id`, [TEAM, largeHTML, source])).rows[0].id;
    const autoId = (await db.query(`INSERT INTO public.customer_auto_messages(customer_id, admin_id, message_type, name, content)
      VALUES ($1, $2, 'rich_card', 'Local long-content auto', $3) RETURNING id`, [customerId, TEAM, largeHTML])).rows[0].id;
    const templateCard = await chat(customerId, source, { message_type: 'rich_card', source_template_id: templateId });
    const autoCard = await chat(customerId, source, { message_type: 'rich_card', source_auto_message_id: autoId });
    const inlineCard = await chat(customerId, source, { message_type: 'rich_card', message_content: largeHTML });
    for (const message of [templateCard, autoCard, inlineCard]) {
      const frozen = await frozenHTML(message.id);
      assert.equal(frozen.content_frozen, true); assert.equal(frozen.source_type, source);
      fullText(frozen.html_content, largeHTML);
      assert.equal(frozen.content_hash, createHash('md5').update(largeHTML).digest('hex'));
    }
    for (const [action, id] of [['template_edit', templateId], ['auto_edit', autoId]]) {
      const prepared = await prepare(action, id);
      fullText(prepared.snapshots.source.content, largeHTML);
      const edited = await commit(action, id, prepared.hash, { content: editedHTML }, { p_media: {} });
      assert.equal(edited.success, true);
      const table = action === 'template_edit' ? 'public.cs_message_templates' : 'public.customer_auto_messages';
      fullText((await db.query(`SELECT content FROM ${table} WHERE id = $1`, [id])).rows[0].content, editedHTML);
      await rejectWithoutEffects(() => commit(action, id, prepared.hash, { content: largeHTML }, { p_media: {} }), /Content changed; refresh/);
    }
    for (const message of [templateCard, autoCard, inlineCard]) fullText((await frozenHTML(message.id)).html_content, largeHTML);
    for (const extra of [{ source_template_id: templateId }, { source_auto_message_id: autoId }]) {
      const message = await chat(customerId, source, { message_type: 'rich_card', ...extra });
      fullText((await frozenHTML(message.id)).html_content, editedHTML);
    }
  });

  test(`${source} ordinary chat_edit still rejects 100001 characters and oversized image URLs; accepts exactly 100000`, async () => {
    const customerId = await newCustomer(source);
    const message = await chat(customerId, source);
    const prepared = await prepare('chat_edit', message.id);
    await rejectWithoutEffects(() => commit('chat_edit', message.id, prepared.hash, { message_content: 'a'.repeat(100001) }), /Chat content is invalid/);
    await rejectWithoutEffects(() => commit('chat_edit', message.id, prepared.hash, { image_url: 'x'.repeat(2049) }), /Chat content is invalid/);
    const exact = '字'.repeat(100000);
    assert.equal((await commit('chat_edit', message.id, prepared.hash, { message_content: exact })).success, true);
    fullText((await db.query('SELECT message_content FROM public.customer_employee_conversations WHERE id = $1', [message.id])).rows[0].message_content, exact);
  });
}

test('announcements already accept Chinese HTML over 500KB, including an update, without truncation', async () => {
  const created = (await db.query(`INSERT INTO public.announcements(title, content, created_by)
    VALUES ('Local long announcement', $1, $2) RETURNING id, content`, [largeHTML, TEAM])).rows[0];
  fullText(created.content, largeHTML);
  const updated = (await db.query('UPDATE public.announcements SET content = $1 WHERE id = $2 RETURNING content, octet_length(content) AS bytes', [editedHTML, created.id])).rows[0];
  fullText(updated.content, editedHTML);
  assert.equal(updated.bytes, Buffer.byteLength(editedHTML));
});
