ALTER TABLE public.notification_automation_tasks
  DROP CONSTRAINT IF EXISTS notification_automation_tasks_trigger_type_check;

ALTER TABLE public.notification_automation_tasks
  ADD CONSTRAINT notification_automation_tasks_trigger_type_check
  CHECK (trigger_type IN (
    'total_orders',
    'daily_orders',
    'work_days',
    'commission_amount',
    'consecutive_work_days',
    'annual_date',
    'first_login'
  ));

CREATE OR REPLACE FUNCTION private.calculate_automation_metric(
  p_task public.notification_automation_tasks,
  p_user_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_metric numeric := 0;
  v_period_key text := 'all_time';
  v_latest_day date;
  v_cursor_day date;
  v_streak integer := 0;
BEGIN
  IF p_task.trigger_type = 'total_orders' THEN
    SELECT count(*)::numeric
    INTO v_metric
    FROM public.orders
    WHERE user_id = p_user_id
      AND status IN ('success', 'failure')
      AND processed_at < p_now;
  ELSIF p_task.trigger_type = 'daily_orders' THEN
    v_period_key := to_char(p_now AT TIME ZONE 'UTC', 'YYYY-MM-DD');
    SELECT count(*)::numeric
    INTO v_metric
    FROM public.orders
    WHERE user_id = p_user_id
      AND status IN ('success', 'failure')
      AND processed_at >= date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND processed_at < LEAST(
        (date_trunc('day', p_now AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC',
        p_now
      );
  ELSIF p_task.trigger_type = 'work_days' THEN
    SELECT count(*)::numeric
    INTO v_metric
    FROM (
      SELECT (start_time AT TIME ZONE 'UTC')::date AS day_date
      FROM public.work_sessions
      WHERE user_id = p_user_id
        AND end_time IS NOT NULL
        AND end_time <= p_now
      GROUP BY (start_time AT TIME ZONE 'UTC')::date
      HAVING sum(COALESCE(
        duration_minutes,
        floor(extract(epoch FROM (COALESCE(end_time, p_now) - start_time)) / 60)::integer,
        0
      )) >= COALESCE(p_task.minimum_daily_work_minutes, 1)
    ) AS qualifying_work_days;
  ELSIF p_task.trigger_type = 'commission_amount' THEN
    SELECT COALESCE(sum(amount), 0)
    INTO v_metric
    FROM public.wallet_transactions
    WHERE user_id = p_user_id
      AND type = 'commission'
      AND created_at < p_now;
  ELSIF p_task.trigger_type = 'annual_date' THEN
    v_period_key := 'annual-' || to_char(p_now AT TIME ZONE 'UTC', 'YYYY');
    IF extract(month FROM p_now AT TIME ZONE 'UTC')::integer = p_task.annual_month
      AND extract(day FROM p_now AT TIME ZONE 'UTC')::integer = p_task.annual_day THEN
      v_metric := 1;
    ELSE
      v_metric := 0;
    END IF;
  ELSIF p_task.trigger_type = 'first_login' THEN
    v_period_key := 'first-login';
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM public.employee_login_history
      WHERE user_id = p_user_id
        AND action_type = 'login'
        AND created_at < p_now
    ) THEN 1 ELSE 0 END
    INTO v_metric;
  ELSE
    CREATE TEMP TABLE IF NOT EXISTS pg_temp.qualified_automation_days (
      day_date date PRIMARY KEY
    ) ON COMMIT DROP;
    TRUNCATE pg_temp.qualified_automation_days;

    INSERT INTO pg_temp.qualified_automation_days(day_date)
    SELECT order_day.day_date
    FROM (
      SELECT (processed_at AT TIME ZONE 'UTC')::date AS day_date,
             count(*) AS completed_orders
      FROM public.orders
      WHERE user_id = p_user_id
        AND status IN ('success', 'failure')
        AND processed_at < p_now
      GROUP BY (processed_at AT TIME ZONE 'UTC')::date
    ) AS order_day
    WHERE order_day.completed_orders >= p_task.minimum_daily_orders
      AND EXISTS (
        SELECT 1
        FROM public.work_sessions AS work_session
        WHERE work_session.user_id = p_user_id
          AND work_session.end_time IS NOT NULL
          AND work_session.end_time <= p_now
          AND (work_session.start_time AT TIME ZONE 'UTC')::date = order_day.day_date
        GROUP BY (work_session.start_time AT TIME ZONE 'UTC')::date
        HAVING sum(COALESCE(work_session.duration_minutes, 0))
          >= COALESCE(p_task.minimum_daily_work_minutes, 1)
      );

    SELECT max(day_date) INTO v_latest_day
    FROM pg_temp.qualified_automation_days;

    IF v_latest_day IS NOT NULL
      AND v_latest_day >= (p_now AT TIME ZONE 'UTC')::date - 1 THEN
      v_cursor_day := v_latest_day;
      LOOP
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM pg_temp.qualified_automation_days WHERE day_date = v_cursor_day
        );
        v_streak := v_streak + 1;
        v_cursor_day := v_cursor_day - 1;
      END LOOP;
      v_metric := v_streak;
      v_period_key := to_char(v_cursor_day + 1, 'YYYY-MM-DD');
    ELSE
      v_metric := 0;
      v_period_key := 'no_active_streak';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'metric', COALESCE(v_metric, 0),
    'period_key', v_period_key
  );
END;
$function$;

CREATE OR REPLACE FUNCTION private.capture_automation_baseline(
  p_task public.notification_automation_tasks,
  p_user_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_metric_result jsonb;
  v_metric numeric;
  v_period_key text;
  v_stage bigint;
BEGIN
  IF NOT private.automation_task_applies_to_user(p_task, p_user_id) THEN
    RETURN;
  END IF;

  v_metric_result := private.calculate_automation_metric(p_task, p_user_id, p_now);
  v_metric := COALESCE((v_metric_result->>'metric')::numeric, 0);
  v_period_key := COALESCE(v_metric_result->>'period_key', 'all_time');
  v_stage := CASE
    WHEN p_task.trigger_type IN ('annual_date') THEN 0
    WHEN p_task.trigger_mode = 'reach_once' AND v_metric >= p_task.threshold_value THEN 1
    WHEN p_task.trigger_mode = 'recurring' THEN floor(v_metric / p_task.threshold_value)::bigint
    ELSE 0
  END;

  INSERT INTO public.notification_automation_progress (
    task_id,
    user_id,
    last_metric,
    last_stage,
    last_period_key
  ) VALUES (
    p_task.id,
    p_user_id,
    v_metric,
    v_stage,
    v_period_key
  )
  ON CONFLICT (task_id, user_id) DO UPDATE
  SET last_metric = EXCLUDED.last_metric,
      last_stage = EXCLUDED.last_stage,
      last_period_key = EXCLUDED.last_period_key,
      updated_at = p_now;
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_notification_automation_task(
  p_admin_session_token uuid,
  p_task_id uuid,
  p_name text,
  p_description text,
  p_trigger_type text,
  p_trigger_mode text,
  p_threshold_value numeric,
  p_minimum_daily_orders integer,
  p_minimum_daily_work_minutes integer,
  p_recipient_scope text,
  p_recipient_ids uuid[],
  p_title_template text,
  p_content_template text,
  p_message_type text,
  p_priority text,
  p_reward_enabled boolean,
  p_reward_amount numeric,
  p_is_shared_template boolean,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  IF p_is_shared_template AND v_admin_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can share automation templates.';
  END IF;
  IF p_trigger_type NOT IN ('total_orders', 'daily_orders', 'work_days', 'commission_amount', 'consecutive_work_days', 'first_login') THEN
    RAISE EXCEPTION 'Unsupported automation trigger.';
  END IF;
  IF p_trigger_mode NOT IN ('reach_once', 'recurring') THEN
    RAISE EXCEPTION 'Unsupported automation trigger mode.';
  END IF;
  IF p_trigger_type = 'first_login'
    AND (p_trigger_mode <> 'reach_once' OR p_threshold_value IS DISTINCT FROM 1) THEN
    RAISE EXCEPTION 'First-login automation only supports a single reach-once threshold.';
  END IF;
  IF p_threshold_value IS NULL
    OR p_threshold_value <= 0
    OR p_threshold_value > 1000000000000
    OR p_threshold_value::text IN ('NaN', 'Infinity', '-Infinity')
    OR (
      p_trigger_type <> 'commission_amount'
      AND p_threshold_value <> trunc(p_threshold_value)
    )
    OR (
      p_trigger_type = 'commission_amount'
      AND p_threshold_value < 0.01
    ) THEN
    RAISE EXCEPTION 'Trigger threshold is outside the supported range.';
  END IF;
  IF p_trigger_type = 'consecutive_work_days'
    AND COALESCE(p_minimum_daily_orders, 0) <= 0 THEN
    RAISE EXCEPTION 'A minimum daily order count is required.';
  END IF;
  IF COALESCE(p_reward_enabled, false)
    AND (
      p_reward_amount IS NULL
      OR p_reward_amount <= 0
      OR p_reward_amount::text IN ('NaN', 'Infinity', '-Infinity')
    ) THEN
    RAISE EXCEPTION 'Reward amount must be a finite positive number.';
  END IF;
  IF p_recipient_scope NOT IN ('all_managed', 'selected') THEN
    RAISE EXCEPTION 'Unsupported recipient scope.';
  END IF;
  IF p_recipient_scope = 'selected' AND COALESCE(cardinality(p_recipient_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one employee.';
  END IF;

  IF p_task_id IS NULL THEN
    INSERT INTO public.notification_automation_tasks (
      owner_admin_id,
      name,
      description,
      trigger_type,
      trigger_mode,
      threshold_value,
      minimum_daily_orders,
      minimum_daily_work_minutes,
      recipient_scope,
      title_template,
      content_template,
      message_type,
      priority,
      reward_enabled,
      reward_amount,
      is_shared_template,
      starts_at,
      ends_at
    ) VALUES (
      v_admin_id,
      trim(p_name),
      COALESCE(trim(p_description), ''),
      p_trigger_type,
      p_trigger_mode,
      p_threshold_value,
      p_minimum_daily_orders,
      p_minimum_daily_work_minutes,
      p_recipient_scope,
      trim(p_title_template),
      p_content_template,
      p_message_type,
      p_priority,
      COALESCE(p_reward_enabled, false),
      CASE WHEN p_reward_enabled THEN p_reward_amount ELSE NULL END,
      COALESCE(p_is_shared_template, false),
      p_starts_at,
      p_ends_at
    )
    RETURNING * INTO v_task;
  ELSE
    SELECT * INTO v_task
    FROM public.notification_automation_tasks
    WHERE id = p_task_id
      AND owner_admin_id = v_admin_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Automation task was not found or cannot be edited.';
    END IF;

    UPDATE public.notification_automation_tasks
    SET name = trim(p_name),
        description = COALESCE(trim(p_description), ''),
        trigger_type = p_trigger_type,
        trigger_mode = p_trigger_mode,
        threshold_value = p_threshold_value,
        minimum_daily_orders = p_minimum_daily_orders,
        minimum_daily_work_minutes = p_minimum_daily_work_minutes,
        recipient_scope = p_recipient_scope,
        title_template = trim(p_title_template),
        content_template = p_content_template,
        message_type = p_message_type,
        priority = p_priority,
        reward_enabled = COALESCE(p_reward_enabled, false),
        reward_amount = CASE WHEN p_reward_enabled THEN p_reward_amount ELSE NULL END,
        is_shared_template = COALESCE(p_is_shared_template, false),
        starts_at = p_starts_at,
        ends_at = p_ends_at,
        status = 'draft',
        activated_at = NULL,
        version = version + 1,
        updated_at = now()
    WHERE id = p_task_id
    RETURNING * INTO v_task;

    DELETE FROM public.notification_automation_task_recipients
    WHERE task_id = v_task.id;

    DELETE FROM public.notification_automation_progress
    WHERE task_id = v_task.id;
  END IF;

  IF p_recipient_scope = 'selected' THEN
    FOREACH v_user_id IN ARRAY p_recipient_ids
    LOOP
      IF NOT private.admin_can_manage_automation_user(
        v_admin_id,
        v_admin_role,
        v_user_id
      ) THEN
        RAISE EXCEPTION 'An employee is outside your management scope.';
      END IF;
      INSERT INTO public.notification_automation_task_recipients(task_id, user_id)
      VALUES (v_task.id, v_user_id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'task_id', v_task.id,
    'version', v_task.version,
    'status', v_task.status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_notification_automation_task(
  p_admin_session_token uuid,
  p_task_id uuid,
  p_name text,
  p_description text,
  p_trigger_type text,
  p_trigger_mode text,
  p_threshold_value numeric,
  p_minimum_daily_orders integer,
  p_minimum_daily_work_minutes integer,
  p_annual_month integer,
  p_annual_day integer,
  p_recipient_scope text,
  p_recipient_ids uuid[],
  p_title_template text,
  p_content_template text,
  p_message_type text,
  p_priority text,
  p_reward_enabled boolean,
  p_reward_amount numeric,
  p_is_shared_template boolean,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
  v_threshold_value numeric;
  v_annual_month smallint;
  v_annual_day smallint;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  IF p_is_shared_template AND v_admin_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can share automation templates.';
  END IF;
  IF p_trigger_type NOT IN ('total_orders', 'daily_orders', 'work_days', 'commission_amount', 'consecutive_work_days', 'annual_date', 'first_login') THEN
    RAISE EXCEPTION 'Unsupported automation trigger.';
  END IF;
  IF p_trigger_mode NOT IN ('reach_once', 'recurring') THEN
    RAISE EXCEPTION 'Unsupported automation trigger mode.';
  END IF;

  IF p_trigger_type = 'first_login' THEN
    IF p_trigger_mode <> 'reach_once' THEN
      RAISE EXCEPTION 'First-login automation only supports reach-once mode.';
    END IF;
    v_threshold_value := 1;
    v_annual_month := NULL;
    v_annual_day := NULL;
  ELSIF p_trigger_type = 'annual_date' THEN
    IF p_trigger_mode <> 'reach_once' THEN
      RAISE EXCEPTION 'Annual date automation only supports reach-once mode.';
    END IF;
    IF p_annual_month IS NULL OR p_annual_month NOT BETWEEN 1 AND 12 THEN
      RAISE EXCEPTION 'Annual month must be between 1 and 12.';
    END IF;
    IF p_annual_day IS NULL
      OR p_annual_day < 1
      OR p_annual_day > extract(
        day FROM make_date(2000, p_annual_month, 1) + interval '1 month - 1 day'
      )::integer THEN
      RAISE EXCEPTION 'Annual day is not valid for the selected month.';
    END IF;
    v_threshold_value := 1;
    v_annual_month := p_annual_month::smallint;
    v_annual_day := p_annual_day::smallint;
  ELSE
    IF p_threshold_value IS NULL
      OR p_threshold_value <= 0
      OR p_threshold_value > 1000000000000
      OR p_threshold_value::text IN ('NaN', 'Infinity', '-Infinity')
      OR (
        p_trigger_type <> 'commission_amount'
        AND p_threshold_value <> trunc(p_threshold_value)
      )
      OR (
        p_trigger_type = 'commission_amount'
        AND p_threshold_value < 0.01
      ) THEN
      RAISE EXCEPTION 'Trigger threshold is outside the supported range.';
    END IF;
    v_threshold_value := p_threshold_value;
    v_annual_month := NULL;
    v_annual_day := NULL;
  END IF;

  IF p_trigger_type = 'consecutive_work_days'
    AND COALESCE(p_minimum_daily_orders, 0) <= 0 THEN
    RAISE EXCEPTION 'A minimum daily order count is required.';
  END IF;
  IF COALESCE(p_reward_enabled, false)
    AND (
      p_reward_amount IS NULL
      OR p_reward_amount <= 0
      OR p_reward_amount::text IN ('NaN', 'Infinity', '-Infinity')
    ) THEN
    RAISE EXCEPTION 'Reward amount must be a finite positive number.';
  END IF;
  IF p_recipient_scope NOT IN ('all_managed', 'selected') THEN
    RAISE EXCEPTION 'Unsupported recipient scope.';
  END IF;
  IF p_recipient_scope = 'selected' AND COALESCE(cardinality(p_recipient_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one employee.';
  END IF;

  IF p_task_id IS NULL THEN
    INSERT INTO public.notification_automation_tasks (
      owner_admin_id,
      name,
      description,
      trigger_type,
      trigger_mode,
      threshold_value,
      minimum_daily_orders,
      minimum_daily_work_minutes,
      annual_month,
      annual_day,
      recipient_scope,
      title_template,
      content_template,
      message_type,
      priority,
      reward_enabled,
      reward_amount,
      is_shared_template,
      starts_at,
      ends_at
    ) VALUES (
      v_admin_id,
      trim(p_name),
      COALESCE(trim(p_description), ''),
      p_trigger_type,
      p_trigger_mode,
      v_threshold_value,
      p_minimum_daily_orders,
      p_minimum_daily_work_minutes,
      v_annual_month,
      v_annual_day,
      p_recipient_scope,
      trim(p_title_template),
      p_content_template,
      p_message_type,
      p_priority,
      COALESCE(p_reward_enabled, false),
      CASE WHEN p_reward_enabled THEN p_reward_amount ELSE NULL END,
      COALESCE(p_is_shared_template, false),
      p_starts_at,
      p_ends_at
    )
    RETURNING * INTO v_task;
  ELSE
    SELECT * INTO v_task
    FROM public.notification_automation_tasks
    WHERE id = p_task_id
      AND owner_admin_id = v_admin_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Automation task was not found or cannot be edited.';
    END IF;

    UPDATE public.notification_automation_tasks
    SET name = trim(p_name),
        description = COALESCE(trim(p_description), ''),
        trigger_type = p_trigger_type,
        trigger_mode = p_trigger_mode,
        threshold_value = v_threshold_value,
        minimum_daily_orders = p_minimum_daily_orders,
        minimum_daily_work_minutes = p_minimum_daily_work_minutes,
        annual_month = v_annual_month,
        annual_day = v_annual_day,
        recipient_scope = p_recipient_scope,
        title_template = trim(p_title_template),
        content_template = p_content_template,
        message_type = p_message_type,
        priority = p_priority,
        reward_enabled = COALESCE(p_reward_enabled, false),
        reward_amount = CASE WHEN p_reward_enabled THEN p_reward_amount ELSE NULL END,
        is_shared_template = COALESCE(p_is_shared_template, false),
        starts_at = p_starts_at,
        ends_at = p_ends_at,
        status = 'draft',
        activated_at = NULL,
        version = version + 1,
        updated_at = now()
    WHERE id = p_task_id
    RETURNING * INTO v_task;

    DELETE FROM public.notification_automation_task_recipients
    WHERE task_id = v_task.id;

    DELETE FROM public.notification_automation_progress
    WHERE task_id = v_task.id;
  END IF;

  IF p_recipient_scope = 'selected' THEN
    FOREACH v_user_id IN ARRAY p_recipient_ids
    LOOP
      IF NOT private.admin_can_manage_automation_user(
        v_admin_id,
        v_admin_role,
        v_user_id
      ) THEN
        RAISE EXCEPTION 'An employee is outside your management scope.';
      END IF;
      INSERT INTO public.notification_automation_task_recipients(task_id, user_id)
      VALUES (v_task.id, v_user_id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'task_id', v_task.id,
    'version', v_task.version,
    'status', v_task.status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION private.queue_automation_from_employee_login()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  IF NEW.action_type = 'login' THEN
    PERFORM private.queue_notification_automation_user(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS queue_notification_automation_from_employee_login
  ON public.employee_login_history;

CREATE TRIGGER queue_notification_automation_from_employee_login
AFTER INSERT ON public.employee_login_history
FOR EACH ROW
EXECUTE FUNCTION private.queue_automation_from_employee_login();

GRANT EXECUTE ON FUNCTION public.save_notification_automation_task(
  uuid, uuid, text, text, text, text, numeric, integer, integer,
  text, uuid[], text, text, text, text, boolean, numeric, boolean,
  timestamptz, timestamptz
) TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_notification_automation_task(
  uuid, uuid, text, text, text, text, numeric, integer, integer, integer,
  integer, text, uuid[], text, text, text, text, boolean, numeric,
  boolean, timestamptz, timestamptz
) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
