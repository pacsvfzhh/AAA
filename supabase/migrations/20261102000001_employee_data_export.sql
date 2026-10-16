/*
  Employee data export RPCs (super administrator only). Read-only apart from job bookkeeping.
  Column lists are explicit on purpose: a new column is not exported until it has been reviewed
  (supabase/tests/employee-data-transfer.test.mjs fails when a table gains an unreviewed column).
*/

CREATE FUNCTION public.employee_export_begin(p_admin_session_token uuid, p_admin_password text, p_options jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  RETURN private.employee_transfer_start_job(p_admin_session_token, p_admin_password, 'export', p_options);
END;
$$;

CREATE FUNCTION private.employee_transfer_scope(p_admin_ids uuid[], p_employee_ids uuid[])
RETURNS TABLE(id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT employee.id FROM public.users AS employee
  WHERE employee.archived_at IS NULL
    AND (p_admin_ids IS NULL OR employee.created_by = ANY (p_admin_ids))
    AND (p_employee_ids IS NULL OR employee.id = ANY (p_employee_ids));
$$;

CREATE FUNCTION private.employee_transfer_retention()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT COALESCE(jsonb_object_agg(config.table_name,
    to_jsonb(config) - 'id' - 'description' - 'display_name' - 'category'), '{}'::jsonb)
  FROM public.history_cleanup_config AS config
  WHERE config.table_name IN ('work_sessions', 'customer_service_sessions');
$$;

CREATE FUNCTION private.employee_transfer_trim_page(p_cursors text[], p_items jsonb[], p_limit integer, p_max_bytes integer)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_fetched integer := COALESCE(cardinality(p_items), 0);
  v_kept integer := 0; v_total integer := 0; v_size integer; v_index integer;
BEGIN
  FOR v_index IN 1..LEAST(v_fetched, p_limit) LOOP
    v_size := octet_length(p_items[v_index]::text);
    IF v_kept > 0 AND v_total + v_size > p_max_bytes THEN EXIT; END IF;
    v_total := v_total + v_size;
    v_kept := v_index;
  END LOOP;
  RETURN jsonb_build_object(
    'rows', CASE WHEN v_kept = 0 THEN '[]'::jsonb ELSE to_jsonb(p_items[1:v_kept]) END,
    'count', v_kept,
    'next_after', CASE WHEN v_kept < v_fetched THEN to_jsonb(p_cursors[v_kept]) ELSE 'null'::jsonb END);
END;
$$;

CREATE FUNCTION public.get_employee_export_directory(p_admin_session_token uuid, p_job_token uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  RETURN jsonb_build_object(
    'site_id', (SELECT site_id FROM private.employee_transfer_site),
    'server_time', now(),
    'schema_fingerprint', private.employee_transfer_schema_fingerprint(),
    'retention', private.employee_transfer_retention(),
    'admins', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', admin.id, 'username', admin.username,
      'role', admin.role, 'parent_id', admin.parent_id, 'is_active', admin.is_active) ORDER BY admin.username)
      FROM public.admins AS admin), '[]'::jsonb),
    'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', dispatch_group.id, 'name', dispatch_group.group_name,
      'is_active', dispatch_group.is_active, 'archived', dispatch_group.archived_at IS NOT NULL)
      ORDER BY dispatch_group.group_name) FROM public.dispatch_groups AS dispatch_group), '[]'::jsonb));
END;
$$;

CREATE FUNCTION public.get_employee_export_preflight(
  p_admin_session_token uuid, p_job_token uuid,
  p_admin_ids uuid[] DEFAULT NULL, p_employee_ids uuid[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_ids uuid[];
  v_result jsonb;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  SELECT COALESCE(array_agg(scope.id), '{}') INTO v_ids
  FROM private.employee_transfer_scope(p_admin_ids, p_employee_ids) AS scope;

  SELECT jsonb_build_object(
    'site_id', (SELECT site_id FROM private.employee_transfer_site),
    'employees', cardinality(v_ids),
    'active_employees', (SELECT count(*) FROM public.users WHERE id = ANY (v_ids) AND is_active),
    'counts', jsonb_build_object(
      'wallet_transactions', (SELECT count(*) FROM public.wallet_transactions WHERE user_id = ANY (v_ids)),
      'wallet_ledger_entries', (SELECT count(*) FROM public.wallet_ledger_entries WHERE user_id = ANY (v_ids)),
      'withdrawals', (SELECT count(*) FROM public.withdrawals WHERE user_id = ANY (v_ids)),
      'orders_completed', (SELECT count(*) FROM public.orders WHERE user_id = ANY (v_ids) AND status IN ('success', 'failure')),
      'notifications', (SELECT count(*) FROM public.message_recipients WHERE recipient_id = ANY (v_ids)),
      'employee_login_history', (SELECT count(*) FROM public.employee_login_history WHERE user_id = ANY (v_ids)),
      'work_sessions', (SELECT count(*) FROM public.work_sessions WHERE user_id = ANY (v_ids)),
      'chat_messages', (SELECT count(*) FROM public.customer_employee_conversations WHERE employee_id = ANY (v_ids)),
      'chat_images', (SELECT count(*) FROM public.customer_employee_conversations
        WHERE employee_id = ANY (v_ids) AND COALESCE(image_url, '') <> ''),
      'verification_requests', (SELECT count(*) FROM public.verification_requests WHERE user_id = ANY (v_ids))),
    'processing_orders', jsonb_build_object(
      'count', (SELECT count(*) FROM public.orders WHERE user_id = ANY (v_ids) AND status = 'processing'),
      'employees', COALESCE((SELECT jsonb_agg(to_jsonb(item) ORDER BY item.processing DESC) FROM (
        SELECT employee.id, employee.username, count(*) AS processing
        FROM public.orders AS item_order JOIN public.users AS employee ON employee.id = item_order.user_id
        WHERE item_order.user_id = ANY (v_ids) AND item_order.status = 'processing'
        GROUP BY employee.id, employee.username ORDER BY count(*) DESC LIMIT 200) AS item), '[]'::jsonb)),
    'pending_withdrawals', jsonb_build_object(
      'count', (SELECT count(*) FROM public.withdrawals WHERE user_id = ANY (v_ids) AND status = 'pending'),
      'amount', (SELECT COALESCE(sum(amount), 0) FROM public.withdrawals WHERE user_id = ANY (v_ids) AND status = 'pending'),
      'employees', COALESCE((SELECT jsonb_agg(to_jsonb(item) ORDER BY item.amount DESC) FROM (
        SELECT employee.id, employee.username, count(*) AS count, sum(withdrawal.amount) AS amount
        FROM public.withdrawals AS withdrawal JOIN public.users AS employee ON employee.id = withdrawal.user_id
        WHERE withdrawal.user_id = ANY (v_ids) AND withdrawal.status = 'pending'
        GROUP BY employee.id, employee.username ORDER BY sum(withdrawal.amount) DESC LIMIT 200) AS item), '[]'::jsonb)),
    'online_employees', (SELECT count(*) FROM public.users
      WHERE id = ANY (v_ids) AND is_active AND last_heartbeat_at > now() - interval '3 minutes'),
    'active_work_sessions', (SELECT count(*) FROM public.work_sessions WHERE user_id = ANY (v_ids) AND end_time IS NULL),
    'wallet_mismatches', COALESCE((SELECT jsonb_agg(to_jsonb(item)) FROM (
      SELECT employee.id, employee.username, wallet.available_balance, wallet.frozen_balance,
        baseline.available_balance + baseline.frozen_balance + COALESCE(ledger.available_delta, 0)
          + COALESCE(ledger.frozen_delta, 0) AS expected_total,
        COALESCE(pending.amount, 0) AS pending_amount
      FROM public.users AS employee
      JOIN public.wallets AS wallet ON wallet.user_id = employee.id
      JOIN public.wallet_balance_baselines AS baseline ON baseline.user_id = employee.id
      LEFT JOIN LATERAL (SELECT sum(entry.available_delta) AS available_delta, sum(entry.frozen_delta) AS frozen_delta,
          sum(entry.income_delta) AS income_delta
        FROM public.wallet_ledger_entries AS entry
        WHERE entry.user_id = employee.id AND entry.id > baseline.last_ledger_id) AS ledger ON true
      LEFT JOIN LATERAL (SELECT sum(withdrawal.amount) AS amount FROM public.withdrawals AS withdrawal
        WHERE withdrawal.user_id = employee.id AND withdrawal.status = 'pending') AS pending ON true
      WHERE employee.id = ANY (v_ids)
        AND (wallet.available_balance + wallet.frozen_balance
          IS DISTINCT FROM baseline.available_balance + baseline.frozen_balance
            + COALESCE(ledger.available_delta, 0) + COALESCE(ledger.frozen_delta, 0)
          OR wallet.frozen_balance IS DISTINCT FROM COALESCE(pending.amount, 0)
          OR COALESCE(employee.total_income, 0) IS DISTINCT FROM baseline.total_income + COALESCE(ledger.income_delta, 0))
      LIMIT 200) AS item), '[]'::jsonb),
    'retention', private.employee_transfer_retention(),
    'schema_fingerprint', private.employee_transfer_schema_fingerprint(),
    'server_time', now()
  ) INTO v_result;

  PERFORM private.employee_transfer_log(v_job.id, v_job.admin_id, v_job.admin_username, 'export', 'export_preflight',
    jsonb_build_object('employees', cardinality(v_ids)));
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.get_employee_export_employee_list(
  p_admin_session_token uuid, p_job_token uuid, p_after uuid DEFAULT NULL, p_limit integer DEFAULT 200,
  p_admin_ids uuid[] DEFAULT NULL, p_employee_ids uuid[] DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  v_rows jsonb;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  SELECT COALESCE(jsonb_agg(to_jsonb(page) ORDER BY page.id), '[]'::jsonb) INTO v_rows
  FROM (
    SELECT employee.id, employee.username, employee.employee_id, employee.created_by,
      admin.username AS created_by_username, employee.is_active, employee.created_at
    FROM private.employee_transfer_scope(p_admin_ids, p_employee_ids) AS scope
    JOIN public.users AS employee ON employee.id = scope.id
    LEFT JOIN public.admins AS admin ON admin.id = employee.created_by
    WHERE p_after IS NULL OR employee.id > p_after
    ORDER BY employee.id LIMIT v_limit + 1) AS page;
  RETURN jsonb_build_object(
    'employees', COALESCE((SELECT jsonb_agg(entry.item ORDER BY entry.ord)
      FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS entry(item, ord) WHERE entry.ord <= v_limit), '[]'::jsonb),
    'next_after', CASE WHEN jsonb_array_length(v_rows) > v_limit THEN v_rows -> (v_limit - 1) -> 'id' ELSE 'null'::jsonb END);
END;
$$;

CREATE FUNCTION public.get_employee_export_core(p_admin_session_token uuid, p_job_token uuid, p_employee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_user public.users%ROWTYPE;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  SELECT * INTO v_user FROM public.users WHERE id = p_employee_id AND archived_at IS NULL;
  IF v_user.id IS NULL THEN RAISE EXCEPTION 'Employee account was not found.'; END IF;

  RETURN jsonb_build_object(
    'account', jsonb_build_object(
      'id', v_user.id, 'username', v_user.username, 'password_hash', v_user.password_hash,
      'employee_id', v_user.employee_id, 'is_verified', v_user.is_verified, 'is_active', v_user.is_active,
      'total_income', v_user.total_income, 'first_success_order_date', v_user.first_success_order_date,
      'created_by', v_user.created_by,
      'created_by_username', (SELECT username FROM public.admins WHERE id = v_user.created_by),
      'remarks', v_user.remarks, 'created_at', v_user.created_at, 'updated_at', v_user.updated_at,
      'tags', to_jsonb(v_user.tags), 'is_pinned', v_user.is_pinned),
    'credential', (SELECT jsonb_build_object('user_id', credential.user_id, 'password_hash', credential.password_hash,
        'created_at', credential.created_at, 'updated_at', credential.updated_at)
      FROM public.financial_employee_credentials AS credential WHERE credential.user_id = v_user.id),
    'group', (SELECT jsonb_build_object('id', dispatch_group.id, 'name', dispatch_group.group_name)
      FROM public.dispatch_group_members AS member
      JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id = member.group_id
      WHERE member.user_id = v_user.id),
    'wallet', (SELECT jsonb_build_object('user_id', wallet.user_id, 'available_balance', wallet.available_balance,
        'frozen_balance', wallet.frozen_balance, 'created_at', wallet.created_at, 'updated_at', wallet.updated_at)
      FROM public.wallets AS wallet WHERE wallet.user_id = v_user.id),
    'baseline', (SELECT jsonb_build_object('user_id', baseline.user_id, 'available_balance', baseline.available_balance,
        'frozen_balance', baseline.frozen_balance, 'total_income', baseline.total_income,
        'last_ledger_id', baseline.last_ledger_id, 'established_at', baseline.established_at)
      FROM public.wallet_balance_baselines AS baseline WHERE baseline.user_id = v_user.id),
    'withdrawals', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', withdrawal.id, 'user_id', withdrawal.user_id, 'amount', withdrawal.amount, 'status', withdrawal.status,
        'audit_remark', withdrawal.audit_remark, 'audited_by', withdrawal.audited_by,
        'audited_by_username', (SELECT username FROM public.admins WHERE id = withdrawal.audited_by),
        'audited_at', withdrawal.audited_at, 'created_at', withdrawal.created_at,
        'last_operation_id', withdrawal.last_operation_id) ORDER BY withdrawal.id)
      FROM public.withdrawals AS withdrawal WHERE withdrawal.user_id = v_user.id), '[]'::jsonb),
    'verification', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', request.id, 'user_id', request.user_id, 'real_name', request.real_name,
        'wallet_address', request.wallet_address, 'phone', request.phone, 'email', request.email,
        'status', request.status, 'audit_remark', request.audit_remark, 'audited_by', request.audited_by,
        'audited_by_username', (SELECT username FROM public.admins WHERE id = request.audited_by),
        'audited_at', request.audited_at, 'created_at', request.created_at, 'updated_at', request.updated_at,
        'id_front_url', request.id_front_url, 'id_back_url', request.id_back_url, 'selfie_url', request.selfie_url)
        ORDER BY request.id)
      FROM public.verification_requests AS request WHERE request.user_id = v_user.id), '[]'::jsonb));
END;
$$;

CREATE FUNCTION public.get_employee_export_rows(
  p_admin_session_token uuid, p_job_token uuid, p_employee_id uuid, p_table_key text,
  p_after text DEFAULT NULL, p_limit integer DEFAULT 2000
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 2000), 1), 5000);
  v_cursors text[]; v_items jsonb[];
  v_max_bytes constant integer := 3000000;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  PERFORM 1 FROM public.users WHERE id = p_employee_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee account was not found.'; END IF;

  IF p_table_key = 'wallet_transactions' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'user_id', row.user_id, 'type', row.type, 'amount', row.amount,
        'balance_before', row.balance_before, 'balance_after', row.balance_after, 'reference_id', row.reference_id,
        'remarks', row.remarks, 'created_by', row.created_by,
        'created_by_username', (SELECT username FROM public.admins WHERE id = row.created_by),
        'created_at', row.created_at, 'operation_id', row.operation_id) AS item
      FROM public.wallet_transactions AS row
      WHERE row.user_id = p_employee_id AND (p_after IS NULL OR row.id > p_after::uuid)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'wallet_ledger_entries' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'user_id', row.user_id, 'operation_id', row.operation_id, 'source_type', row.source_type,
        'source_id', row.source_id, 'event_type', row.event_type, 'available_delta', row.available_delta,
        'frozen_delta', row.frozen_delta, 'income_delta', row.income_delta, 'created_at', row.created_at) AS item
      FROM public.wallet_ledger_entries AS row
      WHERE row.user_id = p_employee_id AND (p_after IS NULL OR row.id > p_after::bigint)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'wallet_reconciliation_audit' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'user_id', row.user_id, 'available_before', row.available_before,
        'available_after', row.available_after, 'frozen_before', row.frozen_before, 'frozen_after', row.frozen_after,
        'income_before', row.income_before, 'income_after', row.income_after, 'pending_amount', row.pending_amount,
        'ledger_total', row.ledger_total, 'reason', row.reason, 'repaired_at', row.repaired_at) AS item
      FROM public.wallet_reconciliation_audit AS row
      WHERE row.user_id = p_employee_id AND (p_after IS NULL OR row.id > p_after::bigint)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'orders' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'user_id', row.user_id, 'status', row.status, 'commission_amount', row.commission_amount,
        'commission_rate', row.commission_rate, 'created_at', row.created_at, 'processed_at', row.processed_at) AS item
      FROM public.orders AS row
      WHERE row.user_id = p_employee_id AND row.status IN ('success', 'failure')
        AND (p_after IS NULL OR row.id > p_after::uuid)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'messages' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'sender_id', row.sender_id, 'sender_username', row.sender_username, 'title', row.title,
        'content', row.content, 'message_type', row.message_type, 'priority', row.priority,
        'expires_at', row.expires_at, 'created_at', row.created_at, 'notification_category', row.notification_category,
        'reward_amount', row.reward_amount, 'reward_currency', row.reward_currency,
        'audit_origin', row.audit_origin, 'delivery_mode', row.delivery_mode) AS item
      FROM public.messages AS row
      WHERE EXISTS (SELECT 1 FROM public.message_recipients AS recipient
          WHERE recipient.message_id = row.id AND recipient.recipient_id = p_employee_id)
        AND (p_after IS NULL OR row.id > p_after::uuid)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'message_recipients' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'message_id', row.message_id, 'recipient_id', row.recipient_id, 'is_read', row.is_read,
        'read_at', row.read_at, 'is_shown', row.is_shown, 'shown_at', row.shown_at, 'created_at', row.created_at,
        'delivery_channel', row.delivery_channel, 'delivered_at', row.delivered_at) AS item
      FROM public.message_recipients AS row
      WHERE row.recipient_id = p_employee_id AND (p_after IS NULL OR row.id > p_after::uuid)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'employee_login_history' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'user_id', row.user_id, 'username', row.username, 'employee_id', row.employee_id,
        'action_type', row.action_type, 'ip_address', row.ip_address, 'user_agent', row.user_agent,
        'session_id', row.session_id, 'created_at', row.created_at, 'device_info', row.device_info) AS item
      FROM public.employee_login_history AS row
      WHERE row.user_id = p_employee_id AND (p_after IS NULL OR row.id > p_after::uuid)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'work_sessions' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'user_id', row.user_id, 'start_time', row.start_time, 'end_time', row.end_time,
        'duration_minutes', row.duration_minutes, 'created_at', row.created_at,
        'last_heartbeat_at', row.last_heartbeat_at) AS item
      FROM public.work_sessions AS row
      WHERE row.user_id = p_employee_id AND (p_after IS NULL OR row.id > p_after::uuid)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'chat_messages' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'customer_id', row.customer_id, 'employee_id', row.employee_id, 'sender_type', row.sender_type,
        'message_content', row.message_content, 'is_read', row.is_read, 'created_at', row.created_at,
        'message_type', row.message_type, 'image_url', row.image_url, 'rating_data', row.rating_data,
        'read_at', row.read_at, 'source_type', row.source_type, 'title', row.title, 'subtitle', row.subtitle,
        'rich_card_hash', CASE WHEN row.message_type = 'rich_card' THEN md5(COALESCE(
          (SELECT card.html_content FROM public.rich_card_contents AS card WHERE card.id = row.rich_card_content_id),
          (SELECT template.content FROM public.cs_message_templates AS template WHERE template.id = row.source_template_id),
          (SELECT auto_message.content FROM public.customer_auto_messages AS auto_message WHERE auto_message.id = row.source_auto_message_id),
          row.message_content)) END) AS item
      FROM public.customer_employee_conversations AS row
      WHERE row.employee_id = p_employee_id AND (p_after IS NULL OR row.id > p_after::uuid)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'chat_rich_cards' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT card.hash AS cursor, row_number() OVER (ORDER BY card.hash) AS ord,
        jsonb_build_object('content_hash', card.hash, 'html_content', card.html) AS item
      FROM (
        SELECT DISTINCT md5(resolved.html) AS hash, resolved.html
        FROM (
          SELECT COALESCE(
            (SELECT card.html_content FROM public.rich_card_contents AS card WHERE card.id = message.rich_card_content_id),
            (SELECT template.content FROM public.cs_message_templates AS template WHERE template.id = message.source_template_id),
            (SELECT auto_message.content FROM public.customer_auto_messages AS auto_message WHERE auto_message.id = message.source_auto_message_id),
            message.message_content) AS html
          FROM public.customer_employee_conversations AS message
          WHERE message.employee_id = p_employee_id AND message.message_type = 'rich_card') AS resolved
        WHERE resolved.html IS NOT NULL) AS card
      WHERE p_after IS NULL OR card.hash > p_after
      ORDER BY card.hash LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'chat_sessions' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'customer_id', row.customer_id, 'employee_id', row.employee_id,
        'service_ticket_number', row.service_ticket_number, 'status', row.status,
        'created_at', row.created_at, 'closed_at', row.closed_at) AS item
      FROM public.customer_service_sessions AS row
      WHERE row.employee_id = p_employee_id AND (p_after IS NULL OR row.id > p_after::uuid)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'chat_annotations' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.customer_id::text AS cursor, row_number() OVER (ORDER BY row.customer_id) AS ord, jsonb_build_object(
        'customer_id', row.customer_id, 'employee_id', row.employee_id, 'owner_admin_id', row.owner_admin_id,
        'owner_admin_username', (SELECT username FROM public.admins WHERE id = row.owner_admin_id),
        'is_special', row.is_special, 'note', row.note, 'updated_by', row.updated_by,
        'updated_by_username', (SELECT username FROM public.admins WHERE id = row.updated_by),
        'updated_at', row.updated_at) AS item
      FROM public.ccc_conversation_annotations AS row
      WHERE row.employee_id = p_employee_id AND (p_after IS NULL OR row.customer_id > p_after::uuid)
      ORDER BY row.customer_id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'chat_auto_logs' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'customer_id', row.customer_id, 'employee_id', row.employee_id,
        'auto_message_id', row.auto_message_id, 'sent_at', row.sent_at,
        'message_type', auto_message.message_type, 'title', auto_message.title, 'subtitle', auto_message.subtitle,
        'content_md5', md5(auto_message.content)) AS item
      FROM public.customer_auto_message_logs AS row
      JOIN public.customer_auto_messages AS auto_message ON auto_message.id = row.auto_message_id
      WHERE row.employee_id = p_employee_id AND (p_after IS NULL OR row.id > p_after::uuid)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSIF p_table_key = 'chat_customers' THEN
    SELECT COALESCE(array_agg(page.cursor ORDER BY page.ord), '{}'), COALESCE(array_agg(page.item ORDER BY page.ord), '{}')
    INTO v_cursors, v_items FROM (
      SELECT row.id::text AS cursor, row_number() OVER (ORDER BY row.id) AS ord, jsonb_build_object(
        'id', row.id, 'admin_id', row.admin_id,
        'admin_username', (SELECT username FROM public.admins WHERE id = row.admin_id),
        'customer_name', row.customer_name, 'customer_avatar', row.customer_avatar, 'is_active', row.is_active,
        'created_at', row.created_at, 'updated_at', row.updated_at, 'customer_id', row.customer_id,
        'is_super', row.is_super, 'super_customer_title', row.super_customer_title, 'badge_type', row.badge_type,
        'custom_avatar_url', row.custom_avatar_url, 'is_pinned', row.is_pinned, 'vip_label', row.vip_label,
        'remarks', row.remarks, 'source_type', row.source_type, 'employee_pin_top', row.employee_pin_top,
        'employee_always_visible', row.employee_always_visible, 'target_employee_id', row.target_employee_id,
        'target_employee_ids', to_jsonb(row.target_employee_ids),
        'auto_messages_enabled', row.auto_messages_enabled) AS item
      FROM public.simulated_customers AS row
      WHERE row.id IN (
          SELECT conversation.customer_id FROM public.customer_employee_conversations AS conversation
            WHERE conversation.employee_id = p_employee_id
          UNION SELECT session.customer_id FROM public.customer_service_sessions AS session
            WHERE session.employee_id = p_employee_id
          UNION SELECT annotation.customer_id FROM public.ccc_conversation_annotations AS annotation
            WHERE annotation.employee_id = p_employee_id
          UNION SELECT log.customer_id FROM public.customer_auto_message_logs AS log
            WHERE log.employee_id = p_employee_id)
        AND (p_after IS NULL OR row.id > p_after::uuid)
      ORDER BY row.id LIMIT v_limit + 1) AS page;

  ELSE
    RAISE EXCEPTION 'Unsupported employee export table: %', p_table_key;
  END IF;

  RETURN private.employee_transfer_trim_page(v_cursors, v_items, v_limit, v_max_bytes);
END;
$$;

CREATE FUNCTION public.get_employee_export_fingerprint(p_admin_session_token uuid, p_job_token uuid, p_employee_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  RETURN jsonb_build_object(
    'wallet', (SELECT jsonb_build_object('available', wallet.available_balance, 'frozen', wallet.frozen_balance)
      FROM public.wallets AS wallet WHERE wallet.user_id = p_employee_id),
    'total_income', (SELECT COALESCE(total_income, 0) FROM public.users WHERE id = p_employee_id),
    'baseline', (SELECT jsonb_build_object('available', baseline.available_balance, 'frozen', baseline.frozen_balance,
        'income', baseline.total_income, 'last_ledger_id', baseline.last_ledger_id)
      FROM public.wallet_balance_baselines AS baseline WHERE baseline.user_id = p_employee_id),
    'ledger', (SELECT jsonb_build_object('count', count(*), 'max_id', COALESCE(max(id), 0),
        'available', COALESCE(sum(available_delta), 0), 'frozen', COALESCE(sum(frozen_delta), 0),
        'income', COALESCE(sum(income_delta), 0)) FROM public.wallet_ledger_entries WHERE user_id = p_employee_id),
    'wallet_transactions', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0))
      FROM public.wallet_transactions WHERE user_id = p_employee_id),
    'withdrawals', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0),
        'pending_count', count(*) FILTER (WHERE status = 'pending'),
        'pending_amount', COALESCE(sum(amount) FILTER (WHERE status = 'pending'), 0))
      FROM public.withdrawals WHERE user_id = p_employee_id),
    'wallet_reconciliation_audit', (SELECT count(*) FROM public.wallet_reconciliation_audit WHERE user_id = p_employee_id),
    'orders', (SELECT jsonb_build_object('count', count(*) FILTER (WHERE status IN ('success', 'failure')),
        'success', count(*) FILTER (WHERE status = 'success'), 'failure', count(*) FILTER (WHERE status = 'failure'),
        'success_commission', COALESCE(sum(commission_amount) FILTER (WHERE status = 'success'), 0),
        'processing', count(*) FILTER (WHERE status = 'processing'))
      FROM public.orders WHERE user_id = p_employee_id),
    'message_recipients', (SELECT count(*) FROM public.message_recipients WHERE recipient_id = p_employee_id),
    'employee_login_history', (SELECT count(*) FROM public.employee_login_history WHERE user_id = p_employee_id),
    'work_sessions', (SELECT jsonb_build_object('count', count(*), 'active', count(*) FILTER (WHERE end_time IS NULL))
      FROM public.work_sessions WHERE user_id = p_employee_id),
    'chat_messages', (SELECT count(*) FROM public.customer_employee_conversations WHERE employee_id = p_employee_id),
    'chat_sessions', (SELECT count(*) FROM public.customer_service_sessions WHERE employee_id = p_employee_id),
    'chat_annotations', (SELECT count(*) FROM public.ccc_conversation_annotations WHERE employee_id = p_employee_id),
    'chat_auto_logs', (SELECT count(*) FROM public.customer_auto_message_logs WHERE employee_id = p_employee_id),
    'verification_requests', (SELECT count(*) FROM public.verification_requests WHERE user_id = p_employee_id));
END;
$$;

CREATE FUNCTION public.employee_export_finish(p_admin_session_token uuid, p_job_token uuid, p_summary jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  PERFORM private.employee_transfer_end_job(v_job, 'finished', COALESCE(p_summary, '{}'::jsonb));
  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_scope(uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_retention() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_trim_page(text[], jsonb[], integer, integer) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.employee_export_begin(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_export_directory(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_export_preflight(uuid, uuid, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_export_employee_list(uuid, uuid, uuid, integer, uuid[], uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_export_core(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_export_rows(uuid, uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_export_fingerprint(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_export_finish(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_export_begin(uuid, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_export_directory(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_export_preflight(uuid, uuid, uuid[], uuid[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_export_employee_list(uuid, uuid, uuid, integer, uuid[], uuid[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_export_core(uuid, uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_export_rows(uuid, uuid, uuid, text, text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_export_fingerprint(uuid, uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_export_finish(uuid, uuid, jsonb) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
