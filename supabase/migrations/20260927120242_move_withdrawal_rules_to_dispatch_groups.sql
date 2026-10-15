ALTER TABLE public.dispatch_groups
  ADD COLUMN withdrawal_amount_threshold numeric(14,2) NOT NULL DEFAULT 100
    CONSTRAINT dispatch_groups_withdrawal_amount_check
      CHECK (withdrawal_amount_threshold BETWEEN 0 AND 999999999999.99),
  ADD COLUMN withdrawal_orders_threshold integer NOT NULL DEFAULT 1000
    CONSTRAINT dispatch_groups_withdrawal_orders_check
      CHECK (withdrawal_orders_threshold BETWEEN 1 AND 1000000),
  ADD COLUMN withdrawal_condition_mode text NOT NULL DEFAULT 'OR'
    CONSTRAINT dispatch_groups_withdrawal_mode_check
      CHECK (withdrawal_condition_mode IN ('OR', 'AND', 'amount_only', 'days_only'));

-- One group cannot retain different admin policies. Keep the most common complete
-- effective policy; empty groups use their creator's policy or global defaults.
WITH effective AS (
  SELECT dispatch_group.id AS group_id,
    COALESCE(
      (SELECT CASE WHEN config_value ~ '^[0-9]{1,12}(\.[0-9]{1,2})?$'
                   THEN config_value::numeric END
       FROM public.admin_configs
       WHERE admin_id = COALESCE(employee.created_by, dispatch_group.created_by)
         AND config_type = 'withdrawal_amount_threshold'
       ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1),
      (SELECT CASE WHEN config_value ~ '^[0-9]{1,12}(\.[0-9]{1,2})?$'
                   THEN config_value::numeric END
       FROM public.admin_configs
       WHERE admin_id IS NULL AND config_type = 'withdrawal_amount_threshold'
       ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1), 100
    ) AS amount,
    COALESCE(
      (SELECT CASE WHEN config_value ~ '^[0-9]{1,7}$' THEN
                 CASE WHEN config_value::integer BETWEEN 1 AND 1000000
                      THEN config_value::integer END END
       FROM public.admin_configs
       WHERE admin_id = COALESCE(employee.created_by, dispatch_group.created_by)
         AND config_type = 'withdrawal_days_threshold'
       ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1),
      (SELECT CASE WHEN config_value ~ '^[0-9]{1,7}$' THEN
                 CASE WHEN config_value::integer BETWEEN 1 AND 1000000
                      THEN config_value::integer END END
       FROM public.admin_configs
       WHERE admin_id IS NULL AND config_type = 'withdrawal_days_threshold'
       ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1), 1000
    ) AS orders,
    COALESCE(
      (SELECT CASE lower(config_value)
                WHEN 'and' THEN 'AND' WHEN 'both' THEN 'AND'
                WHEN 'or' THEN 'OR' WHEN 'either' THEN 'OR'
                WHEN 'amount_only' THEN 'amount_only' WHEN 'days_only' THEN 'days_only'
              END
       FROM public.admin_configs
       WHERE admin_id = COALESCE(employee.created_by, dispatch_group.created_by)
         AND config_type = 'withdrawal_condition_mode'
       ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1),
      (SELECT CASE lower(config_value)
                WHEN 'and' THEN 'AND' WHEN 'both' THEN 'AND'
                WHEN 'or' THEN 'OR' WHEN 'either' THEN 'OR'
                WHEN 'amount_only' THEN 'amount_only' WHEN 'days_only' THEN 'days_only'
              END
       FROM public.admin_configs
       WHERE admin_id IS NULL AND config_type = 'withdrawal_condition_mode'
       ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1), 'OR'
    ) AS mode
  FROM public.dispatch_groups AS dispatch_group
  LEFT JOIN public.dispatch_group_members AS member ON member.group_id = dispatch_group.id
  LEFT JOIN public.users AS employee ON employee.id = member.user_id
), ranked AS (
  SELECT group_id, amount, orders, mode,
    row_number() OVER (PARTITION BY group_id ORDER BY count(*) DESC, amount, orders, mode) AS rank
  FROM effective
  GROUP BY group_id, amount, orders, mode
)
UPDATE public.dispatch_groups AS dispatch_group
SET withdrawal_amount_threshold = ranked.amount,
    withdrawal_orders_threshold = ranked.orders,
    withdrawal_condition_mode = ranked.mode
FROM ranked
WHERE ranked.group_id = dispatch_group.id AND ranked.rank = 1;

-- Extend the existing super-admin-only, session-validated group save RPC.
DO $block$
DECLARE
  v_source text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('public.admin_save_dispatch_group(uuid,uuid,jsonb)'::regprocedure)
  INTO v_source;
  v_old := $anchor$'commission_rate', 'dispatch_success_rate'])$anchor$;
  v_new := $anchor$'commission_rate', 'dispatch_success_rate',
                             'withdrawal_amount_threshold', 'withdrawal_orders_threshold',
                             'withdrawal_condition_mode'])$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Group save whitelist changed.'; END IF;
  v_source := replace(v_source, v_old, v_new);

  v_old := '  IF p_group_id IS NULL THEN';
  v_new := $patch$  FOR v_field IN
    SELECT field.name, field.value FROM jsonb_each(p_changes) AS field(name, value)
    WHERE field.name IN ('withdrawal_amount_threshold', 'withdrawal_orders_threshold')
  LOOP
    IF jsonb_typeof(v_field.value) <> 'number' THEN
      RAISE EXCEPTION 'Invalid withdrawal threshold.';
    END IF;
    IF v_field.name = 'withdrawal_amount_threshold' THEN
      IF v_field.value::text !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$' THEN
        RAISE EXCEPTION 'Invalid withdrawal amount threshold.';
      END IF;
      IF v_field.value::text::numeric NOT BETWEEN 0 AND 999999999999.99 THEN
        RAISE EXCEPTION 'Withdrawal amount threshold is out of range.';
      END IF;
    ELSE
      IF v_field.value::text !~ '^[0-9]{1,7}$' THEN
        RAISE EXCEPTION 'Invalid withdrawal orders threshold.';
      END IF;
      IF v_field.value::text::integer NOT BETWEEN 1 AND 1000000 THEN
        RAISE EXCEPTION 'Withdrawal orders threshold is out of range.';
      END IF;
    END IF;
  END LOOP;
  IF p_changes ? 'withdrawal_condition_mode' AND
     (jsonb_typeof(p_changes->'withdrawal_condition_mode') <> 'string' OR
      p_changes->>'withdrawal_condition_mode' NOT IN ('OR', 'AND', 'amount_only', 'days_only')) THEN
    RAISE EXCEPTION 'Invalid withdrawal condition mode.';
  END IF;
  IF p_group_id IS NULL THEN$patch$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Group save validation changed.'; END IF;
  v_source := replace(v_source, v_old, v_new);

  v_old := 'session_timeout_minutes, submit_wait_min_seconds, submit_wait_max_seconds,
      commission_rate, dispatch_success_rate';
  v_new := 'session_timeout_minutes, submit_wait_min_seconds, submit_wait_max_seconds,
      commission_rate, dispatch_success_rate, withdrawal_amount_threshold,
      withdrawal_orders_threshold, withdrawal_condition_mode';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Group insert columns changed.'; END IF;
  v_source := replace(v_source, v_old, v_new);

  v_old := $anchor$           AND config_value::numeric BETWEEN 0 AND 1 LIMIT 1), 100)
    ) RETURNING$anchor$;
  v_new := $patch$           AND config_value::numeric BETWEEN 0 AND 1 LIMIT 1), 100),
      COALESCE((p_changes->>'withdrawal_amount_threshold')::numeric, 100),
      COALESCE((p_changes->>'withdrawal_orders_threshold')::integer, 1000),
      COALESCE(p_changes->>'withdrawal_condition_mode', 'OR')
    ) RETURNING$patch$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Group insert values changed.'; END IF;
  v_source := replace(v_source, v_old, v_new);

  v_old := $anchor$        dispatch_success_rate = COALESCE((p_changes->>'dispatch_success_rate')::integer, dispatch_success_rate),
        updated_at$anchor$;
  v_new := $patch$        dispatch_success_rate = COALESCE((p_changes->>'dispatch_success_rate')::integer, dispatch_success_rate),
        withdrawal_amount_threshold = COALESCE((p_changes->>'withdrawal_amount_threshold')::numeric, withdrawal_amount_threshold),
        withdrawal_orders_threshold = COALESCE((p_changes->>'withdrawal_orders_threshold')::integer, withdrawal_orders_threshold),
        withdrawal_condition_mode = COALESCE(p_changes->>'withdrawal_condition_mode', withdrawal_condition_mode),
        updated_at$patch$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Group update changed.'; END IF;
  EXECUTE replace(v_source, v_old, v_new);
END;
$block$;

CREATE OR REPLACE FUNCTION public.check_withdrawal_eligibility(check_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_verified boolean;
  v_balance numeric;
  v_group public.dispatch_groups%ROWTYPE;
  v_orders integer;
  v_amount_met boolean;
  v_orders_met boolean;
BEGIN
  SELECT is_verified INTO v_verified FROM public.users WHERE id = check_user_id;
  IF v_verified IS DISTINCT FROM true THEN RETURN false; END IF;
  SELECT available_balance INTO v_balance FROM public.wallets WHERE user_id = check_user_id;
  IF v_balance IS NULL OR v_balance <= 0 THEN RETURN false; END IF;

  SELECT dispatch_group.* INTO v_group
  FROM public.dispatch_group_members AS member
  JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id = member.group_id
  WHERE member.user_id = check_user_id AND dispatch_group.is_active
    AND dispatch_group.archived_at IS NULL
  FOR SHARE OF member, dispatch_group;
  IF v_group.id IS NULL THEN RETURN false; END IF;

  v_orders := public.get_user_completed_orders_count(check_user_id);
  v_amount_met := v_balance >= v_group.withdrawal_amount_threshold;
  v_orders_met := v_orders >= v_group.withdrawal_orders_threshold;
  CASE v_group.withdrawal_condition_mode
    WHEN 'amount_only' THEN RETURN v_amount_met;
    WHEN 'days_only' THEN RETURN v_orders_met;
    WHEN 'AND' THEN RETURN v_amount_met AND v_orders_met;
    ELSE RETURN v_amount_met OR v_orders_met;
  END CASE;
END;
$function$;

CREATE FUNCTION public.get_employee_withdrawal_policy_secure(
  p_user_id uuid, p_session_token uuid, p_tab_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_group public.dispatch_groups%ROWTYPE;
  v_verified boolean;
  v_balance numeric;
  v_orders integer;
BEGIN
  SELECT employee.is_verified INTO v_verified
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee session is invalid or expired.'; END IF;

  SELECT dispatch_group.* INTO v_group
  FROM public.dispatch_group_members AS member
  JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id = member.group_id
  WHERE member.user_id = p_user_id AND dispatch_group.is_active
    AND dispatch_group.archived_at IS NULL
  FOR SHARE OF member, dispatch_group;
  IF v_group.id IS NULL THEN
    RETURN jsonb_build_object('available', false, 'message', 'No active dispatch group assigned.');
  END IF;

  SELECT available_balance INTO v_balance FROM public.wallets WHERE user_id = p_user_id;
  v_orders := public.get_user_completed_orders_count(p_user_id);
  RETURN jsonb_build_object(
    'available', true, 'group_id', v_group.id,
    'amount_threshold', v_group.withdrawal_amount_threshold,
    'orders_threshold', v_group.withdrawal_orders_threshold,
    'condition_mode', v_group.withdrawal_condition_mode,
    'completed_orders_count', v_orders,
    'verified', v_verified,
    'available_balance', COALESCE(v_balance, 0),
    'eligible', public.check_withdrawal_eligibility(p_user_id)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_employee_withdrawal_policy_secure(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_withdrawal_policy_secure(uuid, uuid, text)
  TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_withdrawal_eligibility(uuid)
  FROM PUBLIC, anon, authenticated;
