ALTER TABLE public.notification_automation_tasks
  ADD COLUMN annual_month smallint,
  ADD COLUMN annual_day smallint;

ALTER TABLE public.notification_automation_tasks
  DROP CONSTRAINT notification_automation_tasks_trigger_type_check;
ALTER TABLE public.notification_automation_tasks
  ADD CONSTRAINT notification_automation_tasks_trigger_type_check
  CHECK (trigger_type IN (
    'total_orders',
    'daily_orders',
    'work_days',
    'commission_amount',
    'consecutive_work_days',
    'annual_date'
  ));

ALTER TABLE public.notification_automation_tasks
  ADD CONSTRAINT notification_automation_tasks_annual_date_check
  CHECK (
    (trigger_type <> 'annual_date' AND annual_month IS NULL AND annual_day IS NULL)
    OR (
      trigger_type = 'annual_date'
      AND trigger_mode = 'reach_once'
      AND threshold_value = 1
      AND annual_month IS NOT NULL
      AND annual_day IS NOT NULL
      AND CASE
        WHEN annual_month BETWEEN 1 AND 12 THEN
          annual_day BETWEEN 1 AND extract(
            day FROM make_date(2000, annual_month, 1) + interval '1 month - 1 day'
          )::integer
        ELSE false
      END
    )
  );

CREATE TABLE public.notification_automation_date_runs (
  task_id uuid NOT NULL REFERENCES public.notification_automation_tasks(id) ON DELETE CASCADE,
  task_version integer NOT NULL,
  period_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, task_version, period_key)
);

ALTER TABLE public.notification_automation_date_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_automation_date_runs FROM PUBLIC, anon, authenticated;

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
    WHEN p_task.trigger_type = 'annual_date' THEN 0
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

CREATE OR REPLACE FUNCTION private.render_automation_template(
  p_template text,
  p_username text,
  p_actual_value numeric,
  p_task public.notification_automation_tasks,
  p_currency text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT replace(
    replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(
                  p_template,
                  '{{employee_name}}', COALESCE(p_username, 'Employee')
                ),
                '{{actual_value}}', trim(to_char(p_actual_value, 'FM999999999999990.##'))
              ),
              '{{threshold_value}}', trim(to_char(p_task.threshold_value, 'FM999999999999990.##'))
            ),
            '{{minimum_daily_orders}}', COALESCE(p_task.minimum_daily_orders::text, '')
          ),
          '{{bonus_amount}}', COALESCE(trim(to_char(p_task.reward_amount, 'FM999999999999990.00')), '')
        ),
        '{{currency}}', p_currency
      ),
      '{{annual_month}}', COALESCE(p_task.annual_month::text, '')
    ),
    '{{annual_day}}', COALESCE(p_task.annual_day::text, '')
  );
$$;

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
  IF p_trigger_type NOT IN ('total_orders', 'daily_orders', 'work_days', 'commission_amount', 'consecutive_work_days', 'annual_date') THEN
    RAISE EXCEPTION 'Unsupported automation trigger.';
  END IF;
  IF p_trigger_mode NOT IN ('reach_once', 'recurring') THEN
    RAISE EXCEPTION 'Unsupported automation trigger mode.';
  END IF;

  IF p_trigger_type = 'annual_date' THEN
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

CREATE OR REPLACE FUNCTION public.copy_shared_notification_automation_task(
  p_admin_session_token uuid,
  p_source_task_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_source public.notification_automation_tasks%ROWTYPE;
  v_task_id uuid;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  IF v_admin_role <> 'secondary_admin' THEN
    RAISE EXCEPTION 'Only a secondary administrator can copy a shared template.';
  END IF;

  SELECT task.* INTO v_source
  FROM public.notification_automation_tasks AS task
  JOIN public.admins AS owner ON owner.id = task.owner_admin_id
  WHERE task.id = p_source_task_id
    AND task.is_shared_template = true
    AND owner.role = 'super_admin';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared automation template was not found.';
  END IF;

  INSERT INTO public.notification_automation_tasks (
    owner_admin_id,
    source_task_id,
    source_version,
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
    starts_at,
    ends_at
  ) VALUES (
    v_admin_id,
    v_source.id,
    v_source.version,
    v_source.name,
    v_source.description,
    v_source.trigger_type,
    v_source.trigger_mode,
    v_source.threshold_value,
    v_source.minimum_daily_orders,
    v_source.minimum_daily_work_minutes,
    v_source.annual_month,
    v_source.annual_day,
    'all_managed',
    v_source.title_template,
    v_source.content_template,
    v_source.message_type,
    v_source.priority,
    v_source.reward_enabled,
    v_source.reward_amount,
    v_source.starts_at,
    v_source.ends_at
  )
  RETURNING id INTO v_task_id;

  RETURN jsonb_build_object(
    'success', true,
    'task_id', v_task_id,
    'status', 'draft'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION private.queue_annual_date_automation_users(
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
  v_period_key text := 'annual-' || to_char(p_now AT TIME ZONE 'UTC', 'YYYY');
  v_claimed boolean;
  v_queued integer := 0;
BEGIN
  FOR v_task IN
    SELECT task.*
    FROM public.notification_automation_tasks AS task
    WHERE task.status = 'active'
      AND task.is_shared_template = false
      AND task.trigger_type = 'annual_date'
      AND task.annual_month = extract(month FROM p_now AT TIME ZONE 'UTC')::integer
      AND task.annual_day = extract(day FROM p_now AT TIME ZONE 'UTC')::integer
      AND COALESCE(task.starts_at, '-infinity'::timestamptz) <= p_now
      AND COALESCE(task.ends_at, 'infinity'::timestamptz) > p_now
    ORDER BY task.id
  LOOP
    v_claimed := false;
    INSERT INTO public.notification_automation_date_runs (
      task_id,
      task_version,
      period_key,
      created_at
    ) VALUES (
      v_task.id,
      v_task.version,
      v_period_key,
      p_now
    )
    ON CONFLICT (task_id, task_version, period_key) DO NOTHING
    RETURNING true INTO v_claimed;

    CONTINUE WHEN NOT COALESCE(v_claimed, false);

    FOR v_user_id IN
      SELECT employee.id
      FROM public.users AS employee
      WHERE employee.is_active = true
        AND private.automation_task_applies_to_user(v_task, employee.id)
      ORDER BY employee.id
    LOOP
      INSERT INTO public.notification_automation_progress (
        task_id,
        user_id,
        last_metric,
        last_stage,
        last_period_key,
        updated_at
      ) VALUES (
        v_task.id,
        v_user_id,
        0,
        0,
        v_period_key,
        p_now
      )
      ON CONFLICT (task_id, user_id) DO UPDATE
      SET last_metric = 0,
          last_stage = 0,
          last_period_key = EXCLUDED.last_period_key,
          updated_at = EXCLUDED.updated_at;

      PERFORM private.queue_notification_automation_user(v_user_id);
      v_queued := v_queued + 1;
    END LOOP;
  END LOOP;

  RETURN v_queued;
END;
$function$;

CREATE OR REPLACE FUNCTION private.evaluate_notification_automation_for_user(
  p_user_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_task public.notification_automation_tasks%ROWTYPE;
  v_progress public.notification_automation_progress%ROWTYPE;
  v_metric_result jsonb;
  v_metric numeric;
  v_period_key text;
  v_previous_stage bigint;
  v_stage bigint;
  v_target_stage bigint;
  v_execution_id uuid;
  v_message_id uuid;
  v_recipient_id uuid;
  v_transaction_id uuid;
  v_username text;
  v_currency text;
  v_title text;
  v_content text;
  v_processed integer := 0;
  v_operation_result jsonb;
BEGIN
  SELECT username INTO v_username
  FROM public.users
  WHERE id = p_user_id
    AND is_active = true;

  IF v_username IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_task IN
    SELECT task.*
    FROM public.notification_automation_tasks AS task
    WHERE task.status = 'active'
      AND task.is_shared_template = false
      AND COALESCE(task.starts_at, '-infinity'::timestamptz) <= p_now
      AND COALESCE(task.ends_at, 'infinity'::timestamptz) > p_now
    ORDER BY task.id
  LOOP
    CONTINUE WHEN NOT private.automation_task_applies_to_user(v_task, p_user_id);

    SELECT * INTO v_progress
    FROM public.notification_automation_progress
    WHERE task_id = v_task.id
      AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      PERFORM private.capture_automation_baseline(
        v_task,
        p_user_id,
        LEAST(
          p_now,
          COALESCE(v_task.starts_at, v_task.activated_at, p_now)
        )
      );
      SELECT * INTO v_progress
      FROM public.notification_automation_progress
      WHERE task_id = v_task.id
        AND user_id = p_user_id
      FOR UPDATE;
      CONTINUE WHEN NOT FOUND;
    END IF;

    v_metric_result := private.calculate_automation_metric(v_task, p_user_id, p_now);
    v_metric := COALESCE((v_metric_result->>'metric')::numeric, 0);
    v_period_key := COALESCE(v_metric_result->>'period_key', 'all_time');
    IF v_task.trigger_type = 'consecutive_work_days'
      AND v_task.trigger_mode = 'reach_once' THEN
      v_period_key := 'all_time';
    END IF;
    v_previous_stage := CASE
      WHEN (
        v_task.trigger_type IN ('daily_orders', 'annual_date')
        OR (
          v_task.trigger_type = 'consecutive_work_days'
          AND v_task.trigger_mode = 'recurring'
        )
      ) AND v_progress.last_period_key <> v_period_key THEN 0
      ELSE v_progress.last_stage
    END;
    v_stage := CASE
      WHEN v_task.trigger_mode = 'reach_once' AND v_metric >= v_task.threshold_value THEN 1
      WHEN v_task.trigger_mode = 'recurring' THEN floor(v_metric / v_task.threshold_value)::bigint
      ELSE 0
    END;

    UPDATE public.notification_automation_progress
    SET last_metric = v_metric,
        last_stage = v_stage,
        last_period_key = v_period_key,
        updated_at = p_now
    WHERE task_id = v_task.id
      AND user_id = p_user_id;

    CONTINUE WHEN v_stage <= 0 OR v_stage <= v_previous_stage;

    FOR v_target_stage IN v_previous_stage + 1..v_stage
    LOOP
      v_execution_id := NULL;
      v_message_id := NULL;
      v_recipient_id := NULL;
      v_transaction_id := NULL;
      v_currency := private.resolve_admin_currency(v_task.owner_admin_id);
      v_title := private.render_automation_template(
        v_task.title_template,
        v_username,
        v_metric,
        v_task,
        v_currency
      );
      v_content := private.render_automation_template(
        v_task.content_template,
        v_username,
        v_metric,
        v_task,
        v_currency
      );

      INSERT INTO public.notification_automation_executions (
        task_id,
        task_version,
        owner_admin_id,
        user_id,
        employee_username,
        period_key,
        stage,
        actual_value,
        trigger_snapshot,
        title_snapshot,
        content_snapshot,
        reward_amount,
        reward_currency
      ) VALUES (
        v_task.id,
        v_task.version,
        v_task.owner_admin_id,
        p_user_id,
        v_username,
        v_period_key,
        v_target_stage,
        v_metric,
        jsonb_build_object(
          'trigger_type', v_task.trigger_type,
          'trigger_mode', v_task.trigger_mode,
          'threshold_value', v_task.threshold_value,
          'minimum_daily_orders', v_task.minimum_daily_orders,
          'minimum_daily_work_minutes', v_task.minimum_daily_work_minutes,
          'annual_month', v_task.annual_month,
          'annual_day', v_task.annual_day
        ),
        v_title,
        v_content,
        CASE WHEN v_task.reward_enabled THEN v_task.reward_amount ELSE NULL END,
        CASE WHEN v_task.reward_enabled THEN v_currency ELSE NULL END
      )
      ON CONFLICT (task_id, task_version, user_id, period_key, stage) DO NOTHING
      RETURNING id INTO v_execution_id;

      CONTINUE WHEN v_execution_id IS NULL;

      INSERT INTO public.messages (
        sender_id,
        sender_username,
        title,
        content,
        message_type,
        priority,
        notification_category,
        reward_amount,
        reward_currency,
        automation_execution_id
      )
      SELECT
        admin.id,
        admin.username,
        v_title,
        v_content,
        v_task.message_type,
        v_task.priority,
        CASE WHEN v_task.reward_enabled THEN 'performance_reward' ELSE 'standard' END,
        CASE WHEN v_task.reward_enabled THEN v_task.reward_amount ELSE NULL END,
        CASE WHEN v_task.reward_enabled THEN v_currency ELSE NULL END,
        v_execution_id
      FROM public.admins AS admin
      WHERE admin.id = v_task.owner_admin_id
      RETURNING id INTO v_message_id;

      INSERT INTO public.message_recipients(message_id, recipient_id)
      VALUES (v_message_id, p_user_id)
      RETURNING id INTO v_recipient_id;

      IF v_task.reward_enabled THEN
        v_transaction_id := private.credit_performance_bonus(
          p_user_id,
          v_task.owner_admin_id,
          v_task.reward_amount,
          v_currency,
          v_recipient_id,
          v_execution_id,
          'Performance Bonus / 業績獎金'
        );

        v_operation_result := jsonb_build_object(
          'success', true,
          'execution_id', v_execution_id,
          'message_id', v_message_id,
          'transaction_id', v_transaction_id,
          'user_id', p_user_id,
          'amount', v_task.reward_amount,
          'currency', v_currency
        );
        PERFORM private.save_financial_operation(
          v_execution_id,
          'notification_automation_bonus',
          'system',
          v_task.owner_admin_id,
          jsonb_build_object(
            'task_id', v_task.id,
            'task_version', v_task.version,
            'user_id', p_user_id,
            'period_key', v_period_key,
            'stage', v_target_stage
          ),
          v_operation_result
        );
      END IF;

      UPDATE public.notification_automation_executions
      SET status = 'succeeded',
          message_id = v_message_id,
          wallet_transaction_id = v_transaction_id,
          completed_at = clock_timestamp()
      WHERE id = v_execution_id;

      v_processed := v_processed + 1;
    END LOOP;
  END LOOP;

  RETURN v_processed;
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_notification_automation_queue(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_item record;
  v_processed integer := 0;
  v_notifications integer := 0;
  v_scheduled_users integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('notification_automation_queue', 0)) THEN
    RETURN jsonb_build_object('success', true, 'skipped', true, 'scheduled_users', 0);
  END IF;

  v_scheduled_users := private.queue_annual_date_automation_users();

  FOR v_item IN
    SELECT queue.user_id
    FROM public.notification_automation_queue AS queue
    WHERE queue.next_attempt_at <= clock_timestamp()
    ORDER BY queue.requested_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  LOOP
    BEGIN
      v_notifications := v_notifications
        + private.evaluate_notification_automation_for_user(v_item.user_id);
      DELETE FROM public.notification_automation_queue
      WHERE user_id = v_item.user_id;
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.notification_automation_queue
      SET attempts = attempts + 1,
          next_attempt_at = clock_timestamp() + make_interval(
            secs => LEAST(300, 5 * (attempts + 1))
          ),
          last_error = left(SQLERRM, 500)
      WHERE user_id = v_item.user_id;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'scheduled_users', v_scheduled_users,
    'processed_users', v_processed,
    'created_notifications', v_notifications
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_notification_automation_task(uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_notification_automation_task(uuid, uuid, text, text, text, text, numeric, integer, integer, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_notification_automation_task(uuid, uuid, text, text, text, text, numeric, integer, integer, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
