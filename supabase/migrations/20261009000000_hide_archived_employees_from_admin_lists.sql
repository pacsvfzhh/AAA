CREATE OR REPLACE FUNCTION public.get_employee_management_snapshot(
  p_admin_session_token uuid
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

  WITH scoped_admins AS (
    SELECT
      a.id,
      a.username,
      a.role,
      COALESCE(a.is_pinned, false) AS is_pinned
    FROM public.admins AS a
    WHERE (v_admin_role = 'super_admin' AND a.role <> 'emergency_admin')
      OR (v_admin_role = 'secondary_admin' AND a.id = v_admin_id)
  ),
  scoped_users AS (
    SELECT u.*
    FROM public.users AS u
    INNER JOIN scoped_admins AS a ON a.id = u.created_by
    WHERE u.archived_at IS NULL
  ),
  wallet_stats AS (
    SELECT
      w.user_id,
      COALESCE(w.available_balance, 0) AS available_balance,
      COALESCE(w.frozen_balance, 0) AS frozen_balance
    FROM public.wallets AS w
    INNER JOIN scoped_users AS u ON u.id = w.user_id
  ),
  latest_verifications AS (
    SELECT DISTINCT ON (vr.user_id)
      vr.user_id,
      vr.real_name,
      vr.wallet_address,
      vr.phone,
      vr.email
    FROM public.verification_requests AS vr
    INNER JOIN scoped_users AS u ON u.id = vr.user_id
    WHERE vr.status = 'approved'
    ORDER BY vr.user_id, vr.created_at DESC NULLS LAST, vr.id DESC
  ),
  order_stats AS (
    SELECT
      o.user_id,
      COUNT(*)::bigint AS total_orders,
      COUNT(*) FILTER (
        WHERE o.created_at >= date_trunc('day', now())
      )::bigint AS today_orders,
      COUNT(*) FILTER (
        WHERE o.status = 'success'
          AND o.created_at >= date_trunc('day', now())
      )::bigint AS today_completed_orders,
      COUNT(*) FILTER (
        WHERE o.status = 'failure'
          AND o.created_at >= date_trunc('day', now())
      )::bigint AS failed_orders,
      COUNT(DISTINCT (o.created_at AT TIME ZONE 'UTC')::date)::bigint AS work_days
    FROM public.orders AS o
    INNER JOIN scoped_users AS u ON u.id = o.user_id
    GROUP BY o.user_id
  ),
  commission_stats AS (
    SELECT
      wt.user_id,
      COALESCE(SUM(wt.amount), 0) AS today_commission
    FROM public.wallet_transactions AS wt
    INNER JOIN scoped_users AS u ON u.id = wt.user_id
    WHERE wt.type = 'commission'
      AND wt.created_at >= date_trunc('day', now())
    GROUP BY wt.user_id
  ),
  pending_withdrawal_stats AS (
    SELECT
      w.user_id,
      SUM(w.amount) AS pending_amount,
      MAX(w.created_at) AS pending_date,
      jsonb_agg(
        jsonb_build_object(
          'id', w.id,
          'amount', w.amount,
          'created_at', w.created_at
        )
        ORDER BY w.created_at DESC NULLS LAST, w.id DESC
      ) AS pending_withdrawals
    FROM public.withdrawals AS w
    INNER JOIN scoped_users AS u ON u.id = w.user_id
    WHERE w.status = 'pending'
    GROUP BY w.user_id
  ),
  latest_dispatch_sessions AS (
    SELECT DISTINCT ON (ds.user_id)
      ds.user_id,
      ds.status,
      ds.ended_at,
      ds.last_activity_at
    FROM public.dispatch_sessions AS ds
    INNER JOIN scoped_users AS u ON u.id = ds.user_id
    ORDER BY ds.user_id, ds.started_at DESC NULLS LAST, ds.id DESC
  ),
  work_intervals AS (
    SELECT
      ws.id,
      ws.user_id,
      ws.start_time,
      CASE
        WHEN ws.end_time IS NOT NULL THEN ws.end_time
        WHEN ws.last_heartbeat_at IS NOT NULL
          THEN LEAST(now(), ws.last_heartbeat_at + interval '1 minute')
        ELSE LEAST(now(), ws.start_time + interval '1 minute')
      END AS effective_end
    FROM public.work_sessions AS ws
    INNER JOIN scoped_users AS u ON u.id = ws.user_id
  ),
  valid_work_intervals AS (
    SELECT
      wi.id,
      wi.user_id,
      wi.start_time,
      wi.effective_end,
      MAX(wi.effective_end) OVER (
        PARTITION BY wi.user_id
        ORDER BY wi.start_time, wi.effective_end, wi.id
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS previous_max_end
    FROM work_intervals AS wi
    WHERE wi.effective_end > wi.start_time
  ),
  marked_work_intervals AS (
    SELECT
      vwi.*,
      CASE
        WHEN vwi.previous_max_end IS NULL OR vwi.start_time > vwi.previous_max_end THEN 1
        ELSE 0
      END AS starts_group
    FROM valid_work_intervals AS vwi
  ),
  grouped_work_intervals AS (
    SELECT
      mwi.*,
      SUM(mwi.starts_group) OVER (
        PARTITION BY mwi.user_id
        ORDER BY mwi.start_time, mwi.effective_end, mwi.id
        ROWS UNBOUNDED PRECEDING
      ) AS group_id
    FROM marked_work_intervals AS mwi
  ),
  merged_work_intervals AS (
    SELECT
      gwi.user_id,
      MIN(gwi.start_time) AS start_time,
      MAX(gwi.effective_end) AS end_time
    FROM grouped_work_intervals AS gwi
    GROUP BY gwi.user_id, gwi.group_id
  ),
  work_time_stats AS (
    SELECT
      mwi.user_id,
      ROUND(SUM(EXTRACT(epoch FROM (mwi.end_time - mwi.start_time))) / 60)::integer AS total_work_minutes,
      ROUND(SUM(
        CASE
          WHEN mwi.end_time > date_trunc('day', now())
            AND mwi.start_time < date_trunc('day', now()) + interval '1 day'
          THEN EXTRACT(epoch FROM (
            LEAST(mwi.end_time, date_trunc('day', now()) + interval '1 day')
            - GREATEST(mwi.start_time, date_trunc('day', now()))
          ))
          ELSE 0
        END
      ) / 60)::integer AS today_work_minutes
    FROM merged_work_intervals AS mwi
    GROUP BY mwi.user_id
  )
  SELECT jsonb_build_object(
    'admins', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'username', a.username,
          'role', a.role,
          'is_pinned', a.is_pinned
        )
        ORDER BY
          CASE WHEN a.role = 'super_admin' THEN 0 ELSE 1 END,
          a.is_pinned DESC,
          a.username,
          a.id
      )
      FROM scoped_admins AS a
    ), '[]'::jsonb),
    'employees', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', u.id,
          'username', u.username,
          'employee_id', u.employee_id,
          'is_verified', u.is_verified,
          'is_active', u.is_active,
          'total_income', u.total_income,
          'first_success_order_date', u.first_success_order_date,
          'created_by', u.created_by,
          'remarks', u.remarks,
          'tags', COALESCE(to_jsonb(u.tags), '[]'::jsonb),
          'is_pinned', COALESCE(u.is_pinned, false),
          'created_at', u.created_at,
          'updated_at', u.updated_at,
          'walletBalance', COALESCE(wallet.available_balance, 0) + COALESCE(wallet.frozen_balance, 0),
          'verification', CASE
            WHEN verification.user_id IS NULL THEN NULL
            ELSE jsonb_build_object(
              'real_name', verification.real_name,
              'wallet_address', verification.wallet_address,
              'phone', verification.phone,
              'email', verification.email
            )
          END,
          'todayOrders', COALESCE(orders.today_orders, 0),
          'todayCompletedOrders', COALESCE(orders.today_completed_orders, 0),
          'failedOrders', COALESCE(orders.failed_orders, 0),
          'todayCommission', COALESCE(commission.today_commission, 0),
          'totalWorkMinutes', COALESCE(work_time.total_work_minutes, 0),
          'todayWorkMinutes', COALESCE(work_time.today_work_minutes, 0),
          'workDays', COALESCE(orders.work_days, 0),
          'workStatus', CASE
            WHEN dispatch.user_id IS NULL THEN 'never_started'
            WHEN dispatch.status = 'online'
              AND dispatch.ended_at IS NULL
              AND dispatch.last_activity_at >= now() - interval '3 minutes'
            THEN 'online'
            ELSE 'offline'
          END,
          'totalOrders', COALESCE(orders.total_orders, 0),
          'accountBalance', COALESCE(wallet.available_balance, 0),
          'hasPendingWithdrawal', withdrawals.user_id IS NOT NULL,
          'pendingWithdrawalAmount', COALESCE(withdrawals.pending_amount, 0),
          'pendingWithdrawalDate', withdrawals.pending_date,
          'pendingWithdrawals', COALESCE(withdrawals.pending_withdrawals, '[]'::jsonb),
          'statsLoaded', true
        )
        ORDER BY u.created_at DESC, u.id DESC
      )
      FROM scoped_users AS u
      LEFT JOIN wallet_stats AS wallet ON wallet.user_id = u.id
      LEFT JOIN latest_verifications AS verification ON verification.user_id = u.id
      LEFT JOIN order_stats AS orders ON orders.user_id = u.id
      LEFT JOIN commission_stats AS commission ON commission.user_id = u.id
      LEFT JOIN pending_withdrawal_stats AS withdrawals ON withdrawals.user_id = u.id
      LEFT JOIN latest_dispatch_sessions AS dispatch ON dispatch.user_id = u.id
      LEFT JOIN work_time_stats AS work_time ON work_time.user_id = u.id
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.search_all_employees_for_admin(
  p_admin_session_token uuid,
  p_search_term text,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_search_term text := btrim(COALESCE(p_search_term, ''));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
  v_result jsonb;
BEGIN
  PERFORM context.admin_id
  FROM private.get_financial_admin_context(p_admin_session_token) context;

  IF v_search_term = '' THEN
    RETURN '[]'::jsonb;
  END IF;

  WITH candidate_user_ids AS (
    SELECT u.id AS user_id
    FROM public.users AS u
    LEFT JOIN public.admins AS owner_admin ON owner_admin.id = u.created_by
    WHERE u.archived_at IS NULL AND owner_admin.role IS DISTINCT FROM 'emergency_admin'
      AND (u.username = v_search_term OR u.employee_id = v_search_term)

    UNION

    SELECT search_verification.user_id
    FROM public.verification_requests AS search_verification
    JOIN public.users AS search_user ON search_user.id = search_verification.user_id
    LEFT JOIN public.admins AS search_owner_admin ON search_owner_admin.id = search_user.created_by
    WHERE search_user.archived_at IS NULL AND search_owner_admin.role IS DISTINCT FROM 'emergency_admin'
      AND search_verification.status = 'approved'
      AND (
        search_verification.real_name = v_search_term
        OR search_verification.email = v_search_term
        OR search_verification.phone = v_search_term
        OR search_verification.wallet_address = v_search_term
      )
  )
  SELECT COALESCE(
    jsonb_agg(matched.payload ORDER BY matched.is_pinned DESC, matched.username),
    '[]'::jsonb
  )
  INTO v_result
  FROM (
    SELECT
      u.username,
      COALESCE(u.is_pinned, false) AS is_pinned,
      jsonb_build_object(
        'id', u.id,
        'username', u.username,
        'employee_id', u.employee_id,
        'created_at', u.created_at,
        'is_active', u.is_active,
        'is_verified', u.is_verified,
        'remarks', u.remarks,
        'tags', COALESCE(to_jsonb(u.tags), '[]'::jsonb),
        'total_income', COALESCE(w.available_balance, 0) + COALESCE(w.frozen_balance, 0),
        'first_success_order_date', u.first_success_order_date,
        'admin_info', CASE
          WHEN owner_admin.id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'username', owner_admin.username,
            'role', owner_admin.role
          )
        END,
        'verification_info', CASE
          WHEN verification.id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'real_name', verification.real_name,
            'email', verification.email,
            'phone', verification.phone,
            'wallet_address', verification.wallet_address,
            'created_at', verification.created_at
          )
        END
      ) AS payload
    FROM candidate_user_ids AS candidate
    JOIN public.users AS u ON u.id = candidate.user_id
    LEFT JOIN public.admins AS owner_admin ON owner_admin.id = u.created_by
    LEFT JOIN public.wallets AS w ON w.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT
        vr.id,
        vr.real_name,
        vr.email,
        vr.phone,
        vr.wallet_address,
        vr.created_at
      FROM public.verification_requests AS vr
      WHERE vr.user_id = u.id
        AND vr.status = 'approved'
      ORDER BY vr.created_at DESC
      LIMIT 1
    ) AS verification ON true
    WHERE u.archived_at IS NULL AND owner_admin.role IS DISTINCT FROM 'emergency_admin'
    ORDER BY COALESCE(u.is_pinned, false) DESC, u.username
    LIMIT v_limit
  ) AS matched;

  RETURN v_result;
END;
$function$;

NOTIFY pgrst, 'reload schema';
