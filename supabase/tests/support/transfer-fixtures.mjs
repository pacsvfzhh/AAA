import { one, scalar } from './transfer-harness.mjs';

const uuid = (prefix, number) => `${prefix}0000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
export const OLD = {
  root: uuid('a', 1), branch: uuid('a', 2), emergency: uuid('a', 3),
  e1: uuid('e', 1), e2: uuid('e', 2), e3: uuid('e', 3), e4: uuid('e', 4),
  groupA: uuid('d', 1), groupB: uuid('d', 2), product: uuid('c', 1),
  alpha: uuid('f', 1), beta: uuid('f', 2), gamma: uuid('f', 3),
  template: uuid('1', 1), autoText: uuid('2', 1), autoCard: uuid('2', 2),
  m1: uuid('3', 1), m2: uuid('3', 2),
};
export const NEW = { root: uuid('b', 1), branch: uuid('b', 2), emergency: uuid('b', 3), groupA: uuid('9', 1), product: uuid('8', 1) };
export const PASSWORDS = { root: 'RootPass-123', branch: 'BranchPass-123', emergency: 'EmergencyPass-123', employee: 'EmployeePass-123' };
export const MEDIA = {
  avatar: 'https://old.example.test/storage/v1/object/public/super-customer-avatars/avatars/alpha.png',
  chat: 'https://old.example.test/storage/v1/object/public/chat-images/chat/one.png',
  idFront: 'https://old.example.test/storage/v1/object/public/verification-documents/e1/front.png',
};

async function admins(db, ids, suffix = '') {
  const specs = [
    [ids.root, 'root', 'super_admin', PASSWORDS.root], [ids.branch, 'branch', 'secondary_admin', PASSWORDS.branch],
    [ids.emergency, 'emergency', 'emergency_admin', PASSWORDS.emergency],
  ];
  for (const [id, name, role, password] of specs) {
    await db.query(`INSERT INTO public.admins (id, username, password_hash, role, is_active)
      VALUES ($1, $2, extensions.crypt($3, extensions.gen_salt('bf', 4)), $4, true)`, [id, `${name}${suffix}`, password, role]);
    await db.query(`INSERT INTO public.financial_admin_credentials (admin_id, password_hash)
      VALUES ($1, extensions.crypt($2, extensions.gen_salt('bf', 4)))`, [id, password]);
  }
}

async function employee(db, { id, username, number, admin, active = true, group = null, remarks = '', tags = [] }) {
  await db.query(`INSERT INTO public.users (id, username, password_hash, employee_id, created_by, is_active, remarks, tags, is_verified)
    VALUES ($1, $2, extensions.crypt($3, extensions.gen_salt('bf', 4)), $4, $5, $6, $7, $8::text[], true)`,
  [id, username, PASSWORDS.employee, number, admin, active, remarks, tags]);
  await db.query(`INSERT INTO public.financial_employee_credentials (user_id, password_hash)
    SELECT id, password_hash FROM public.users WHERE id = $1`, [id]);
  if (group) await db.query('INSERT INTO public.dispatch_group_members (group_id, user_id, assigned_by) VALUES ($1, $2, $3)', [group, id, admin]);
}

let orderCounter = 0;
async function order(db, userId, status, { commission = null, at }) {
  const id = uuid('7', ++orderCounter);
  const username = await scalar(db, 'SELECT username FROM public.users WHERE id = $1', [userId]);
  await db.query(`INSERT INTO public.orders (id, user_id, username, product_type_id, product_value, order_number, transaction_id, status, created_at)
    VALUES ($1, $2, $3, $4, 100, $5, $6, 'processing', $7)`, [id, userId, username, OLD.product, `ORD-${orderCounter}`, `TX-${orderCounter}`, at]);
  if (status !== 'processing') {
    await db.query(`UPDATE public.orders SET status = $2, commission_amount = $3, commission_rate = 0.001, processed_at = $4 WHERE id = $1`,
      [id, status, status === 'success' ? commission : null, at]);
  }
  return id;
}

export async function buildOldSite(db) {
  await admins(db, OLD);
  await db.query(`INSERT INTO public.dispatch_groups (id, group_name, created_by) VALUES ($1, 'Group A', $2), ($3, 'Group B', $4)`,
    [OLD.groupA, OLD.root, OLD.groupB, OLD.branch]);
  await db.query(`INSERT INTO public.product_types (id, name, is_active) VALUES ($1, 'Product A', true)`, [OLD.product]);

  await employee(db, { id: OLD.e1, username: 'emp_one', number: 'E-001', admin: OLD.root, group: OLD.groupA, remarks: 'top performer', tags: ['vip', 'north'] });
  await employee(db, { id: OLD.e2, username: 'emp_two', number: 'E-002', admin: OLD.root, group: OLD.groupA });
  await employee(db, { id: OLD.e3, username: 'emp_three', number: 'E-003', admin: OLD.branch, group: OLD.groupB });
  await employee(db, { id: OLD.e4, username: 'emp_four', number: 'E-004', admin: OLD.root, group: OLD.groupA, active: false });

  // emp_one: orders, ledger before and after the baseline cursor, audit row, pending and approved withdrawals.
  const day = n => `2026-09-${String(n).padStart(2, '0')}T10:00:00Z`;
  await order(db, OLD.e1, 'success', { commission: 10.5, at: day(1) });
  await order(db, OLD.e1, 'success', { commission: 4.25, at: day(2) });
  await order(db, OLD.e1, 'failure', { at: day(2) });
  await order(db, OLD.e1, 'success', { commission: 7, at: day(3) });
  await db.query('UPDATE public.wallets SET available_balance = available_balance + 1 WHERE user_id = $1', [OLD.e1]);
  const repaired = await scalar(db, `SELECT public.reconcile_wallet_from_ledger($1) ->> 'repaired'`, [OLD.e1]);
  if (repaired !== 'true') throw new Error('fixture expected a reconciliation repair');
  await order(db, OLD.e1, 'success', { commission: 3, at: day(4) });
  await order(db, OLD.e1, 'success', { commission: 2.5, at: day(5) });
  await order(db, OLD.e1, 'processing', { at: day(6) });
  await db.query(`INSERT INTO public.wallet_transactions (id, user_id, type, amount, balance_before, balance_after, reference_id, remarks, created_by, created_at)
    VALUES ($1, $2, 'tip', 5, 0, 5, $3, 'customer tip', NULL, $4), ($5, $2, 'manual_adjustment', 20, 5, 25, NULL, 'bonus', $6, $4)`,
  [uuid('6', 1), OLD.e1, uuid('6', 9), day(5), uuid('6', 2), OLD.root]);
  await db.query('UPDATE public.wallets SET available_balance = available_balance + 25 WHERE user_id = $1', [OLD.e1]);
  await db.query('UPDATE public.users SET total_income = total_income + 5 WHERE id = $1', [OLD.e1]);
  await db.query(`INSERT INTO public.withdrawals (id, user_id, amount, status, created_at) VALUES ($1, $2, 3, 'pending', $4), ($3, $2, 2, 'pending', $4)`,
    [uuid('5', 1), OLD.e1, uuid('5', 2), day(6)]);
  await db.query(`UPDATE public.withdrawals SET status = 'approved', audited_by = $2, audited_at = $3, audit_remark = 'ok' WHERE id = $1`,
    [uuid('5', 2), OLD.root, day(7)]);
  await db.query('UPDATE public.wallets SET available_balance = available_balance - 5, frozen_balance = frozen_balance + 3 WHERE user_id = $1', [OLD.e1]);

  // emp_two: legacy employee without a baseline or ledger.
  await db.query('DELETE FROM public.wallet_balance_baselines WHERE user_id = $1', [OLD.e2]);
  await db.query('UPDATE public.wallets SET available_balance = 40, frozen_balance = 10 WHERE user_id = $1', [OLD.e2]);
  await db.query(`INSERT INTO public.withdrawals (id, user_id, amount, status, created_at) VALUES ($1, $2, 10, 'pending', $3)`, [uuid('5', 3), OLD.e2, day(8)]);
  await db.query('DELETE FROM public.wallet_ledger_entries WHERE user_id = $1', [OLD.e2]);

  // Notifications: one message shared by two employees.
  await db.query(`INSERT INTO public.messages (id, sender_id, sender_username, title, content, message_type, priority, notification_category, reward_amount, reward_currency, audit_origin, delivery_mode)
    VALUES ($1, $3, 'root', 'Welcome', '<p>Hello team</p>', 'realtime', 'normal', 'standard', NULL, NULL, 'manual_admin', 'realtime_only'),
           ($2, $3, 'root', 'Reward', '<p>Well done</p>', 'login_popup', 'high', 'performance_reward', 12.5, 'USDC', 'manual_admin', 'login_only')`,
  [OLD.m1, OLD.m2, OLD.root]);
  await db.query(`INSERT INTO public.message_recipients (message_id, recipient_id, is_read, read_at, is_shown, shown_at, delivery_channel, delivered_at)
    VALUES ($1, $2, true, '2026-09-02T00:00:00Z', true, '2026-09-01T00:00:00Z', 'realtime', '2026-09-01T00:00:00Z'),
           ($1, $3, false, NULL, false, NULL, NULL, NULL), ($4, $2, false, NULL, true, '2026-09-03T00:00:00Z', 'login_popup', '2026-09-03T00:00:00Z')`,
  [OLD.m1, OLD.e1, OLD.e2, OLD.m2]);

  // Activity logs.
  await db.query(`INSERT INTO public.employee_login_history (id, user_id, username, employee_id, action_type, ip_address, user_agent, session_id, created_at, device_info)
    VALUES ($1, $2, 'emp_one', 'E-001', 'login', '10.0.0.1', 'UA', 's1', '2026-09-01T01:00:00Z', '{"os":"x"}'::jsonb),
           ($3, $2, 'emp_one', 'E-001', 'logout', '10.0.0.1', 'UA', 's1', '2026-09-01T09:00:00Z', NULL)`,
  [uuid('4', 1), OLD.e1, uuid('4', 2)]);
  await db.query(`INSERT INTO public.work_sessions (id, user_id, start_time, end_time, duration_minutes, last_heartbeat_at)
    VALUES ($1, $2, '2026-09-01T01:00:00Z', '2026-09-01T09:00:00Z', 480, '2026-09-01T09:00:00Z')`, [uuid('3', 11), OLD.e1]);
  await db.query(`INSERT INTO public.work_sessions (id, user_id, start_time, end_time, duration_minutes, last_heartbeat_at)
    VALUES ($1, $2, '2026-09-10T01:00:00Z', NULL, NULL, '2026-09-10T03:30:00Z')`, [uuid('3', 12), OLD.e4]);
  await db.query(`INSERT INTO public.verification_requests (id, user_id, real_name, wallet_address, phone, email, status, audited_by, audited_at, id_front_url)
    VALUES ($1, $2, 'One Person', 'ID-1234', '555-0100', 'addr 1', 'approved', $3, '2026-09-02T00:00:00Z', $4)`,
  [uuid('2', 11), OLD.e1, OLD.root, MEDIA.idFront]);

  // Chat roles and conversations.
  await db.query(`INSERT INTO public.simulated_customers (id, admin_id, customer_name, customer_id, source_type, custom_avatar_url, is_pinned, remarks, employee_always_visible, auto_messages_enabled, target_employee_ids)
    VALUES ($1, $4, 'Alpha', 'CUS-1001', 'aaa_service', $7, true, 'vip role', true, true, NULL),
           ($2, $4, 'Beta', 'CUS-1002', 'ccc_service', NULL, false, NULL, false, false, ARRAY[$5, $6]::uuid[]),
           ($3, $8, 'Gamma', 'CUS-1003', 'aaa_service', NULL, false, NULL, false, false, NULL)`,
  [OLD.alpha, OLD.beta, OLD.gamma, OLD.root, OLD.e1, OLD.e2, MEDIA.avatar, OLD.branch]);
  await db.query(`INSERT INTO public.cs_message_templates (id, admin_id, name, content, content_type, source_type)
    VALUES ($1, $2, 'Card template', '<p>Template card</p>', 'rich_card', 'aaa_service')`, [OLD.template, OLD.root]);
  await db.query(`INSERT INTO public.customer_auto_messages (id, customer_id, admin_id, message_type, name, title, subtitle, content, content_type, sort_order, is_enabled)
    VALUES ($1, $3, $5, 'quick_send', 'greeting', NULL, NULL, 'Hello there', 'text', 1, true),
           ($2, $3, $5, 'rich_card', 'promo', 'Promo', 'Today', '<p>Auto card</p>', 'rich_card', 2, true)`,
  [OLD.autoText, OLD.autoCard, OLD.alpha, null, OLD.root]);
  const message = (n, customer, employeeId, sender, type, content, extra = {}) => db.query(
    `INSERT INTO public.customer_employee_conversations (id, customer_id, employee_id, sender_type, message_content, message_type, created_at, image_url, rating_data, title, subtitle, source_template_id, source_auto_message_id, is_read, source_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15)`,
    [uuid('0', n), customer, employeeId, sender, content, type, `2026-09-05T10:${String(n).padStart(2, '0')}:00Z`, extra.image ?? null,
      extra.rating ? JSON.stringify(extra.rating) : null, extra.title ?? null, extra.subtitle ?? null, extra.template ?? null,
      extra.auto ?? null, extra.read ?? false, extra.source ?? 'aaa_service']);
  await message(1, OLD.alpha, OLD.e1, 'customer', 'text', 'Hi there', { read: true });
  await message(2, OLD.alpha, OLD.e1, 'employee', 'text', 'How can I help?', { read: true });
  await message(3, OLD.alpha, OLD.e1, 'customer', 'image', 'photo', { image: MEDIA.chat });
  await message(4, OLD.alpha, OLD.e1, 'customer', 'rich_card', 'Template card', { template: OLD.template, title: 'Card title' });
  await message(5, OLD.alpha, OLD.e1, 'customer', 'rich_card', 'Promo', { auto: OLD.autoCard, title: 'Promo', subtitle: 'Today' });
  await message(6, OLD.alpha, OLD.e1, 'customer', 'rating_request', 'Please rate', { rating: { stars: 5 } });
  await message(7, OLD.beta, OLD.e1, 'customer', 'text', 'Beta says hi', { source: 'ccc_service' });
  await message(8, OLD.beta, OLD.e2, 'customer', 'text', 'Beta to emp_two', { source: 'ccc_service' });
  await message(9, OLD.gamma, OLD.e3, 'customer', 'text', 'Gamma greeting');
  await db.query(`INSERT INTO public.customer_service_sessions (id, customer_id, employee_id, service_ticket_number, status, created_at, closed_at)
    VALUES ($1, $2, $3, 'TKT-0001', 'closed', '2026-09-05T09:00:00Z', '2026-09-05T11:00:00Z'), ($4, $2, $3, 'TKT-0002', 'active', '2026-09-05T12:00:00Z', NULL)`,
  [uuid('0', 101), OLD.alpha, OLD.e1, uuid('0', 102)]);
  await db.query(`INSERT INTO public.ccc_conversation_annotations (customer_id, employee_id, owner_admin_id, is_special, note, updated_by)
    VALUES ($1, $2, $3, true, 'watch this one', $3)`, [OLD.beta, OLD.e1, OLD.root]);
  await db.query(`INSERT INTO public.customer_auto_message_logs (customer_id, employee_id, auto_message_id) VALUES ($1, $2, $3), ($1, $2, $4)`,
    [OLD.alpha, OLD.e1, OLD.autoText, OLD.autoCard]);
  const verify = await one(db, `SELECT count(*)::int AS orders FROM public.orders WHERE user_id = $1`, [OLD.e1]);
  return { orders: verify.orders };
}

// Target site: same administrator names with different ids, one matching group and some existing chat roles.
export async function buildNewSite(db) {
  await admins(db, NEW);
  await db.query(`INSERT INTO public.dispatch_groups (id, group_name, created_by) VALUES ($1, 'Group A', $2)`, [NEW.groupA, NEW.root]);
  return NEW;
}
