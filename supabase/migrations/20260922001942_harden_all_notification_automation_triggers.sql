ALTER TABLE public.notification_automation_tasks
  ADD COLUMN IF NOT EXISTS annual_month smallint,
  ADD COLUMN IF NOT EXISTS annual_day smallint;

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

ALTER TABLE public.notification_automation_tasks
  DROP CONSTRAINT IF EXISTS notification_automation_tasks_annual_date_check;

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
  v_queued integer := 0;
BEGIN
  FOR v_task IN
    SELECT task.*
    FROM public.notification_automation_tasks AS task
    WHERE task.status = 'active'
      AND task.trigger_type = 'annual_date'
      AND task.annual_month = extract(month FROM p_now AT TIME ZONE 'UTC')::integer
      AND task.annual_day = extract(day FROM p_now AT TIME ZONE 'UTC')::integer
      AND COALESCE(task.starts_at, '-infinity'::timestamptz) <= p_now
      AND COALESCE(task.ends_at, 'infinity'::timestamptz) > p_now
    ORDER BY task.id
  LOOP
    FOR v_user_id IN
      SELECT employee.id
      FROM public.users AS employee
      WHERE employee.is_active = true
        AND private.automation_task_applies_to_user(v_task, employee.id)
        AND NOT EXISTS (
          SELECT 1
          FROM public.notification_automation_executions AS execution
          WHERE execution.task_id = v_task.id
            AND execution.task_version = v_task.version
            AND execution.user_id = employee.id
            AND execution.period_key = v_period_key
            AND execution.stage = 1
            AND execution.status = 'succeeded'
        )
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
    RETURN jsonb_build_object(
      'success', true,
      'skipped', true,
      'scheduled_users', 0
    );
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
    'processed_users', v_processed,
    'created_notifications', v_notifications,
    'scheduled_users', v_scheduled_users
  );
END;
$function$;

DROP FUNCTION public.save_notification_automation_task_v2(
  uuid, uuid, uuid, uuid, text, text, text, text, numeric, integer, integer,
  text, uuid[], text, text, text, text, boolean, numeric, timestamptz, timestamptz
);

CREATE FUNCTION public.save_notification_automation_task_v2(
  p_admin_session_token uuid,
  p_owner_admin_id uuid,
  p_plan_id uuid,
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
  p_delivery_mode text,
  p_priority text,
  p_reward_enabled boolean,
  p_reward_amount numeric,
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
  v_owner_admin_id uuid;
  v_owner_role text;
  v_message_type text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
  v_recipient_ids uuid[] := COALESCE(p_recipient_ids, ARRAY[]::uuid[]);
  v_threshold_value numeric;
  v_annual_month smallint;
  v_annual_day smallint;
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();

  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  v_owner_admin_id := private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    p_owner_admin_id
  );

  SELECT owner.role
  INTO v_owner_role
  FROM public.admins AS owner
  WHERE owner.id = v_owner_admin_id;

  IF p_trigger_type NOT IN (
    'total_orders',
    'daily_orders',
    'work_days',
    'commission_amount',
    'consecutive_work_days',
    'annual_date',
    'first_login'
  ) THEN
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
      OR (p_trigger_type <> 'commission_amount' AND p_threshold_value <> trunc(p_threshold_value))
      OR (p_trigger_type = 'commission_amount' AND p_threshold_value < 0.01) THEN
      RAISE EXCEPTION 'Trigger threshold is outside the supported range.';
    END IF;
    v_threshold_value := p_threshold_value;
    v_annual_month := NULL;
    v_annual_day := NULL;
  END IF;

  IF p_trigger_type IN ('work_days', 'consecutive_work_days')
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
  IF p_delivery_mode NOT IN ('realtime_only', 'login_only', 'realtime_with_login_fallback') THEN
    RAISE EXCEPTION 'Unsupported notification delivery mode.';
  END IF;
  IF p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'Unsupported notification priority.';
  END IF;
  IF p_plan_id IS NOT NULL AND p_recipient_scope <> 'selected' THEN
    RAISE EXCEPTION 'Plan tasks must use automation plan membership.';
  END IF;
  IF p_plan_id IS NOT NULL AND cardinality(v_recipient_ids) <> 0 THEN
    RAISE EXCEPTION 'Plan tasks must use automation plan membership; per-task recipients are not supported.';
  END IF;

  v_message_type := CASE p_delivery_mode
    WHEN 'realtime_only' THEN 'realtime'
    ELSE 'login_popup'
  END;

  IF p_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.notification_automation_plans AS plan
    WHERE plan.id = p_plan_id
      AND plan.owner_admin_id = v_owner_admin_id
      AND plan.status <> 'archived'
  ) THEN
    RAISE EXCEPTION 'The selected automation plan is not available.';
  END IF;

  IF p_task_id IS NULL AND p_plan_id IS NULL THEN
    RAISE EXCEPTION 'New automation tasks must belong to a plan.';
  END IF;

  IF p_task_id IS NOT NULL THEN
    SELECT task.*
    INTO v_task
    FROM public.notification_automation_tasks AS task
    WHERE task.id = p_task_id
      AND task.owner_admin_id = v_owner_admin_id
      AND task.is_shared_template = false
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Automation task was not found or cannot be edited.';
    END IF;

    IF v_task.plan_id IS NULL AND p_plan_id IS NOT NULL THEN
      RAISE EXCEPTION 'Legacy ungrouped tasks cannot be moved into a plan automatically.';
    END IF;
    IF v_task.plan_id IS NOT NULL AND p_plan_id IS DISTINCT FROM v_task.plan_id THEN
      RAISE EXCEPTION 'Move tasks between plans with an explicit migration workflow.';
    END IF;
  END IF;

  IF p_plan_id IS NULL
    AND p_recipient_scope = 'selected'
    AND cardinality(v_recipient_ids) = 0 THEN
    RAISE EXCEPTION 'Select at least one employee for the legacy task.';
  END IF;

  IF p_task_id IS NULL THEN
    INSERT INTO public.notification_automation_tasks (
      owner_admin_id,
      plan_id,
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
      delivery_mode,
      priority,
      reward_enabled,
      reward_amount,
      is_shared_template,
      starts_at,
      ends_at
    ) VALUES (
      v_owner_admin_id,
      p_plan_id,
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
      v_message_type,
      p_delivery_mode,
      p_priority,
      COALESCE(p_reward_enabled, false),
      CASE WHEN p_reward_enabled THEN p_reward_amount ELSE NULL END,
      false,
      p_starts_at,
      p_ends_at
    )
    RETURNING * INTO v_task;
  ELSE
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
        message_type = v_message_type,
        delivery_mode = p_delivery_mode,
        priority = p_priority,
        reward_enabled = COALESCE(p_reward_enabled, false),
        reward_amount = CASE WHEN p_reward_enabled THEN p_reward_amount ELSE NULL END,
        starts_at = p_starts_at,
        ends_at = p_ends_at,
        status = 'draft',
        activated_at = NULL,
        version = version + 1,
        updated_at = clock_timestamp()
    WHERE id = v_task.id
    RETURNING * INTO v_task;

    DELETE FROM public.notification_automation_task_recipients
    WHERE task_id = v_task.id;

    DELETE FROM public.notification_automation_progress
    WHERE task_id = v_task.id;
  END IF;

  IF v_task.plan_id IS NULL AND p_recipient_scope = 'selected' THEN
    FOREACH v_user_id IN ARRAY v_recipient_ids
    LOOP
      IF NOT private.admin_can_manage_automation_user(
        v_owner_admin_id,
        v_owner_role,
        v_user_id
      ) THEN
        RAISE EXCEPTION 'An employee is outside the task administrator scope.';
      END IF;

      INSERT INTO public.notification_automation_task_recipients(task_id, user_id)
      VALUES (v_task.id, v_user_id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'task_id', v_task.id,
    'plan_id', v_task.plan_id,
    'version', v_task.version,
    'status', v_task.status,
    'delivery_mode', v_task.delivery_mode
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_notification_automation_task_v2(
  uuid, uuid, uuid, uuid, text, text, text, text, numeric, integer, integer,
  integer, integer, text, uuid[], text, text, text, text, boolean, numeric,
  timestamptz, timestamptz
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.save_notification_automation_task_v2(
  uuid, uuid, uuid, uuid, text, text, text, text, numeric, integer, integer,
  integer, integer, text, uuid[], text, text, text, text, boolean, numeric,
  timestamptz, timestamptz
) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.process_notification_automation_queue(integer)
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
