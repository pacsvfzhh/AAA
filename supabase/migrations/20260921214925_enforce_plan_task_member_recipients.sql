CREATE OR REPLACE FUNCTION public.save_notification_automation_task_v2(
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
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_owner_admin_id uuid;
  v_owner_role text;
  v_message_type text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
  v_recipient_ids uuid[] := COALESCE(p_recipient_ids, ARRAY[]::uuid[]);
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
    OR (p_trigger_type <> 'commission_amount' AND p_threshold_value <> trunc(p_threshold_value))
    OR (p_trigger_type = 'commission_amount' AND p_threshold_value < 0.01) THEN
    RAISE EXCEPTION 'Trigger threshold is outside the supported range.';
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
      p_threshold_value,
      p_minimum_daily_orders,
      p_minimum_daily_work_minutes,
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
        threshold_value = p_threshold_value,
        minimum_daily_orders = p_minimum_daily_orders,
        minimum_daily_work_minutes = p_minimum_daily_work_minutes,
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
$$;
