-- Region options are shared by every administrator; each employee references at most one region.
CREATE TABLE IF NOT EXISTS public.employee_regions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 30),
  created_by uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS employee_regions_name_key
  ON public.employee_regions (lower(name));

ALTER TABLE public.employee_regions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.employee_regions FROM PUBLIC, anon, authenticated;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS region_id uuid REFERENCES public.employee_regions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_region_id_idx
  ON public.users (region_id)
  WHERE region_id IS NOT NULL;

-- Same exposure as the other admin-facing users columns, so Realtime payloads include region changes.
GRANT SELECT (region_id) ON public.users TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_create_employee_region(
  p_admin_session_token uuid,
  p_name text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_name text := btrim(COALESCE(p_name, ''), E' \t\r\n\u3000');
  v_region public.employee_regions%ROWTYPE;
  v_created boolean := true;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF char_length(v_name) NOT BETWEEN 1 AND 30 THEN
    RAISE EXCEPTION 'Region name must be 1 to 30 characters.';
  END IF;

  INSERT INTO public.employee_regions (name, created_by)
  VALUES (v_name, v_admin_id)
  ON CONFLICT ((lower(name))) DO NOTHING
  RETURNING * INTO v_region;

  IF v_region.id IS NULL THEN
    v_created := false;
    SELECT region.*
    INTO v_region
    FROM public.employee_regions AS region
    WHERE lower(region.name) = lower(v_name);
  END IF;

  RETURN jsonb_build_object(
    'id', v_region.id,
    'name', v_region.name,
    'created_at', v_region.created_at,
    'created', v_created
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_employee_region(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_employee_region(uuid, text)
  TO anon, authenticated, service_role;

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
    'regions', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('id', region.id, 'name', region.name)
        ORDER BY region.created_at, region.name, region.id
      )
      FROM public.employee_regions AS region
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
          'region_id', u.region_id,
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

-- A trailing defaulted parameter would be ambiguous next to the old signature, so replace it.
-- No CASCADE: fail the migration if any other database object depends on the old signature.
DROP FUNCTION public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid, uuid);

CREATE FUNCTION public.admin_create_employee_account_with_automation_plan(
  p_admin_session_token uuid,
  p_username text,
  p_password text,
  p_employee_id text,
  p_created_by uuid,
  p_remarks text,
  p_automation_plan_id uuid,
  p_dispatch_group_id uuid,
  p_region_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_owner_admin_id uuid;
  v_user public.users%ROWTYPE;
  v_plan public.notification_automation_plans%ROWTYPE;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_password_hash text;
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();

  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  v_owner_admin_id := private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    p_created_by
  );

  IF length(trim(COALESCE(p_username, ''))) = 0
    OR length(p_password) < 6
    OR length(trim(COALESCE(p_employee_id, ''))) = 0 THEN
    RAISE EXCEPTION 'Invalid employee account details.';
  END IF;

  IF p_dispatch_group_id IS NULL THEN
    RAISE EXCEPTION 'A dispatch group must be selected.';
  END IF;

  -- Keep the group active and unarchived through the transaction, including the membership insert.
  PERFORM 1
  FROM public.dispatch_groups AS dispatch_group
  WHERE dispatch_group.id = p_dispatch_group_id
    AND dispatch_group.is_active = true
    AND dispatch_group.archived_at IS NULL
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The selected dispatch group is not available.';
  END IF;

  IF p_region_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.employee_regions AS region WHERE region.id = p_region_id
  ) THEN
    RAISE EXCEPTION 'The selected region is not available.';
  END IF;

  IF p_automation_plan_id IS NOT NULL THEN
    SELECT plan.*
    INTO v_plan
    FROM public.notification_automation_plans AS plan
    WHERE plan.id = p_automation_plan_id
      AND plan.owner_admin_id = v_owner_admin_id
      AND plan.status = 'active';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'The selected automation plan is not available.';
    END IF;
  END IF;

  v_password_hash := extensions.crypt(p_password, extensions.gen_salt('bf', 10));

  INSERT INTO public.users (
    username,
    password_hash,
    employee_id,
    created_by,
    remarks,
    region_id
  ) VALUES (
    trim(p_username),
    v_password_hash,
    trim(p_employee_id),
    v_owner_admin_id,
    trim(COALESCE(p_remarks, '')),
    p_region_id
  )
  RETURNING * INTO v_user;

  INSERT INTO public.financial_employee_credentials(user_id, password_hash)
  VALUES (v_user.id, v_password_hash);

  INSERT INTO public.dispatch_group_members(group_id, user_id, assigned_by)
  VALUES (p_dispatch_group_id, v_user.id, v_admin_id);

  IF p_automation_plan_id IS NOT NULL THEN
    INSERT INTO public.notification_automation_plan_members(plan_id, user_id)
    VALUES (v_plan.id, v_user.id);
  END IF;

  FOR v_task IN
    SELECT task.*
    FROM public.notification_automation_tasks AS task
    WHERE task.status = 'active'
      AND (task.starts_at IS NULL OR task.starts_at <= clock_timestamp())
      AND (task.ends_at IS NULL OR task.ends_at > clock_timestamp())
      AND private.automation_task_applies_to_user(task, v_user.id)
  LOOP
    PERFORM private.capture_automation_baseline(v_task, v_user.id);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'user', to_jsonb(v_user) - 'password_hash',
    'automation_plan_id', p_automation_plan_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid, uuid, uuid)
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_update_employee_account_unlocked(
  p_admin_session_token uuid,
  p_user_id uuid,
  p_updates jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_user users%ROWTYPE;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  PERFORM private.assert_admin_can_manage_user(v_admin_id, v_admin_role, p_user_id);

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_updates) AS key
    WHERE key NOT IN (
      'username',
      'employee_id',
      'is_verified',
      'is_active',
      'remarks',
      'tags',
      'is_pinned',
      'created_at',
      'region_id'
    )
  ) THEN
    RAISE EXCEPTION 'The employee update contains a protected field.';
  END IF;

  IF NULLIF(p_updates->>'region_id', '') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM employee_regions AS region WHERE region.id = (p_updates->>'region_id')::uuid
  ) THEN
    RAISE EXCEPTION 'The selected region is not available.';
  END IF;

  UPDATE users
  SET username = CASE WHEN p_updates ? 'username' THEN trim(p_updates->>'username') ELSE username END,
      employee_id = CASE WHEN p_updates ? 'employee_id' THEN trim(p_updates->>'employee_id') ELSE employee_id END,
      is_verified = CASE WHEN p_updates ? 'is_verified' THEN (p_updates->>'is_verified')::boolean ELSE is_verified END,
      is_active = CASE WHEN p_updates ? 'is_active' THEN (p_updates->>'is_active')::boolean ELSE is_active END,
      remarks = CASE WHEN p_updates ? 'remarks' THEN COALESCE(p_updates->>'remarks', '') ELSE remarks END,
      tags = CASE
        WHEN p_updates ? 'tags' THEN ARRAY(SELECT jsonb_array_elements_text(p_updates->'tags'))
        ELSE tags
      END,
      is_pinned = CASE WHEN p_updates ? 'is_pinned' THEN (p_updates->>'is_pinned')::boolean ELSE is_pinned END,
      created_at = CASE WHEN p_updates ? 'created_at' THEN (p_updates->>'created_at')::timestamptz ELSE created_at END,
      region_id = CASE WHEN p_updates ? 'region_id' THEN NULLIF(p_updates->>'region_id', '')::uuid ELSE region_id END,
      updated_at = now()
  WHERE id = p_user_id
  RETURNING * INTO v_user;

  RETURN to_jsonb(v_user) - 'password_hash';
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_employee_account_unlocked(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
