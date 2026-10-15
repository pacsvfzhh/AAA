CREATE OR REPLACE FUNCTION public.get_employee_detail_summary_for_admin(
  p_admin_session_token uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_result jsonb;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  PERFORM private.assert_admin_can_manage_user(v_admin_id, v_admin_role, p_user_id);

  WITH order_summary AS (
    SELECT
      COUNT(*)::bigint AS total_order_count,
      MIN(o.created_at) AS first_order_date
    FROM public.orders AS o
    WHERE o.user_id = p_user_id
  ),
  daily_stats AS (
    SELECT
      (o.created_at AT TIME ZONE 'UTC')::date AS activity_date,
      COALESCE(SUM(
        CASE
          WHEN o.status = 'success' THEN COALESCE(o.commission_amount, 0)
          ELSE 0
        END
      ), 0) AS total_commission,
      COUNT(*) FILTER (WHERE o.status = 'success')::bigint AS success_count,
      COUNT(*) FILTER (WHERE o.status = 'failure')::bigint AS failure_count,
      COUNT(*)::bigint AS total_orders
    FROM public.orders AS o
    WHERE o.user_id = p_user_id
      AND o.created_at IS NOT NULL
    GROUP BY (o.created_at AT TIME ZONE 'UTC')::date
  ),
  transaction_summary AS (
    SELECT
      COALESCE(SUM(wt.amount) FILTER (WHERE wt.type = 'tip'), 0) AS total_tip_amount,
      COALESCE(SUM(wt.amount) FILTER (
        WHERE wt.type = 'manual_adjustment'
          AND wt.amount > 0
      ), 0) AS total_manual_addition_amount
    FROM public.wallet_transactions AS wt
    WHERE wt.user_id = p_user_id
  )
  SELECT jsonb_build_object(
    'wallet', COALESCE(
      (
        SELECT jsonb_build_object(
          'available', COALESCE(w.available_balance, 0),
          'frozen', COALESCE(w.frozen_balance, 0)
        )
        FROM public.wallets AS w
        WHERE w.user_id = p_user_id
      ),
      jsonb_build_object('available', 0, 'frozen', 0)
    ),
    'dailyStats', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'date', to_char(stats.activity_date, 'YYYY-MM-DD'),
            'totalCommission', stats.total_commission,
            'successCount', stats.success_count,
            'failureCount', stats.failure_count,
            'totalOrders', stats.total_orders
          )
          ORDER BY stats.activity_date DESC
        )
        FROM daily_stats AS stats
      ),
      '[]'::jsonb
    ),
    'totalOrderCount', orders.total_order_count,
    'firstOrderDate', orders.first_order_date,
    'totalTipAmount', transactions.total_tip_amount,
    'totalManualAdditionAmount', transactions.total_manual_addition_amount,
    'verification', (
      SELECT jsonb_build_object(
        'id', verification.id,
        'user_id', verification.user_id,
        'real_name', verification.real_name,
        'wallet_address', verification.wallet_address,
        'phone', verification.phone,
        'email', verification.email,
        'status', verification.status,
        'audit_remark', verification.audit_remark,
        'audited_by', verification.audited_by,
        'audited_at', verification.audited_at,
        'id_front_url', verification.id_front_url,
        'id_back_url', verification.id_back_url,
        'selfie_url', verification.selfie_url,
        'created_at', verification.created_at,
        'updated_at', verification.updated_at
      )
      FROM public.verification_requests AS verification
      WHERE verification.user_id = p_user_id
      ORDER BY verification.created_at DESC, verification.id DESC
      LIMIT 1
    )
  )
  INTO v_result
  FROM order_summary AS orders
  CROSS JOIN transaction_summary AS transactions;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_employee_transaction_page_for_admin(
  p_admin_session_token uuid,
  p_user_id uuid,
  p_page integer,
  p_page_size integer,
  p_activity_date date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_page integer := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 100), 1), 100);
  v_result jsonb;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  PERFORM private.assert_admin_can_manage_user(v_admin_id, v_admin_role, p_user_id);

  WITH activity_transactions AS MATERIALIZED (
    SELECT
      wt.id,
      wt.type,
      wt.amount,
      wt.balance_before,
      wt.balance_after,
      wt.remarks,
      wt.created_at,
      wt.created_by,
      wt.reference_id,
      CASE
        WHEN wt.type = 'commission' AND matching_order.created_at IS NOT NULL
          THEN (matching_order.created_at AT TIME ZONE 'UTC')::date
        ELSE (wt.created_at AT TIME ZONE 'UTC')::date
      END AS activity_date
    FROM public.wallet_transactions AS wt
    LEFT JOIN public.orders AS matching_order
      ON wt.type = 'commission'
      AND matching_order.id = wt.reference_id
      AND matching_order.user_id = wt.user_id
    WHERE wt.user_id = p_user_id
  ),
  filtered_transactions AS MATERIALIZED (
    SELECT activity_tx.*
    FROM activity_transactions AS activity_tx
    WHERE p_activity_date IS NULL
      OR activity_tx.activity_date = p_activity_date
  ),
  page_rows AS (
    SELECT filtered_tx.*
    FROM filtered_transactions AS filtered_tx
    ORDER BY filtered_tx.created_at DESC NULLS LAST, filtered_tx.id DESC
    LIMIT v_page_size
    OFFSET ((v_page - 1)::bigint * v_page_size)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'type', page_row.type,
            'amount', page_row.amount,
            'balance_before', page_row.balance_before,
            'balance_after', page_row.balance_after,
            'remarks', page_row.remarks,
            'created_at', page_row.created_at,
            'created_by', page_row.created_by,
            'reference_id', page_row.reference_id,
            'activity_date', to_char(page_row.activity_date, 'YYYY-MM-DD')
          )
          ORDER BY page_row.created_at DESC NULLS LAST, page_row.id DESC
        )
        FROM page_rows AS page_row
      ),
      '[]'::jsonb
    ),
    'total_count', (SELECT COUNT(*)::bigint FROM filtered_transactions)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_employee_transaction_date_counts_for_admin(
  p_admin_session_token uuid,
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_result jsonb;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  PERFORM private.assert_admin_can_manage_user(v_admin_id, v_admin_role, p_user_id);

  WITH activity_transactions AS (
    SELECT
      CASE
        WHEN wt.type = 'commission' AND matching_order.created_at IS NOT NULL
          THEN (matching_order.created_at AT TIME ZONE 'UTC')::date
        ELSE (wt.created_at AT TIME ZONE 'UTC')::date
      END AS activity_date
    FROM public.wallet_transactions AS wt
    LEFT JOIN public.orders AS matching_order
      ON wt.type = 'commission'
      AND matching_order.id = wt.reference_id
      AND matching_order.user_id = wt.user_id
    WHERE wt.user_id = p_user_id
  ),
  date_counts AS (
    SELECT
      activity_tx.activity_date,
      COUNT(*)::bigint AS transaction_count
    FROM activity_transactions AS activity_tx
    WHERE activity_tx.activity_date IS NOT NULL
    GROUP BY activity_tx.activity_date
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'date', to_char(counts.activity_date, 'YYYY-MM-DD'),
        'count', counts.transaction_count
      )
      ORDER BY counts.activity_date DESC
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM date_counts AS counts;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_employee_withdrawal_page_for_admin(
  p_admin_session_token uuid,
  p_user_id uuid,
  p_page integer,
  p_page_size integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_page integer := GREATEST(COALESCE(p_page, 1), 1);
  v_page_size integer := LEAST(GREATEST(COALESCE(p_page_size, 10), 1), 100);
  v_result jsonb;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  PERFORM private.assert_admin_can_manage_user(v_admin_id, v_admin_role, p_user_id);

  WITH page_rows AS (
    SELECT
      withdrawal.id,
      withdrawal.amount,
      withdrawal.status,
      withdrawal.audit_remark,
      withdrawal.audited_at,
      withdrawal.created_at
    FROM public.withdrawals AS withdrawal
    WHERE withdrawal.user_id = p_user_id
    ORDER BY withdrawal.created_at DESC, withdrawal.id DESC
    LIMIT v_page_size
    OFFSET ((v_page - 1)::bigint * v_page_size)
  )
  SELECT jsonb_build_object(
    'rows', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', page_row.id,
            'amount', page_row.amount,
            'status', page_row.status,
            'audit_remark', page_row.audit_remark,
            'audited_at', page_row.audited_at,
            'created_at', page_row.created_at
          )
          ORDER BY page_row.created_at DESC, page_row.id DESC
        )
        FROM page_rows AS page_row
      ),
      '[]'::jsonb
    ),
    'total_count', (
      SELECT COUNT(*)::bigint
      FROM public.withdrawals AS withdrawal
      WHERE withdrawal.user_id = p_user_id
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_employee_detail_summary_for_admin(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_transaction_page_for_admin(uuid, uuid, integer, integer, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_transaction_date_counts_for_admin(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_withdrawal_page_for_admin(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_employee_detail_summary_for_admin(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_transaction_page_for_admin(uuid, uuid, integer, integer, date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_transaction_date_counts_for_admin(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_withdrawal_page_for_admin(uuid, uuid, integer, integer) TO anon, authenticated;

COMMENT ON FUNCTION public.get_employee_detail_summary_for_admin(uuid, uuid) IS
  'Returns wallet, order, transaction summary, and latest verification data for one employee after financial administrator scope validation.';
COMMENT ON FUNCTION public.get_employee_transaction_page_for_admin(uuid, uuid, integer, integer, date) IS
  'Returns one deterministic employee wallet transaction page, optionally filtered by the transaction activity date, after financial administrator scope validation.';
COMMENT ON FUNCTION public.get_employee_transaction_date_counts_for_admin(uuid, uuid) IS
  'Returns employee wallet transaction counts grouped by activity date after financial administrator scope validation.';
COMMENT ON FUNCTION public.get_employee_withdrawal_page_for_admin(uuid, uuid, integer, integer) IS
  'Returns one deterministic employee withdrawal page after financial administrator scope validation.';
