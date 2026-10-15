ALTER TABLE public.notification_automation_executions
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES public.notification_automation_plans(id) ON DELETE SET NULL;

UPDATE public.notification_automation_executions AS execution
SET plan_id = task.plan_id
FROM public.notification_automation_tasks AS task
WHERE execution.task_id = task.id
  AND execution.plan_id IS NULL
  AND task.plan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_automation_executions_plan_idx
  ON public.notification_automation_executions(owner_admin_id, plan_id, executed_at DESC);

CREATE OR REPLACE FUNCTION private.acquire_notification_automation_configuration_lock()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('notification_automation_queue', 0));
$$;

CREATE OR REPLACE FUNCTION private.snapshot_notification_automation_execution_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.task_id IS NOT NULL THEN
    SELECT task.plan_id
    INTO NEW.plan_id
    FROM public.notification_automation_tasks AS task
    WHERE task.id = NEW.task_id;
  ELSIF TG_OP = 'INSERT' THEN
    NEW.plan_id := NULL;
  ELSIF OLD.task_id IS NOT NULL AND NEW.task_id IS NULL THEN
    NEW.plan_id := OLD.plan_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS snapshot_notification_automation_execution_plan
  ON public.notification_automation_executions;
CREATE TRIGGER snapshot_notification_automation_execution_plan
  BEFORE INSERT OR UPDATE OF task_id
  ON public.notification_automation_executions
  FOR EACH ROW
  EXECUTE FUNCTION private.snapshot_notification_automation_execution_plan();

CREATE OR REPLACE FUNCTION private.capture_notification_automation_assignment_baseline(
  p_task public.notification_automation_tasks,
  p_user_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_metric_result jsonb;
  v_metric numeric;
  v_period_key text;
  v_stage bigint;
BEGIN
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
$$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_plan_members(
  p_admin_session_token uuid,
  p_plan_id uuid,
  p_user_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_plan public.notification_automation_plans%ROWTYPE;
  v_user_id uuid;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_ids uuid[] := COALESCE(p_user_ids, ARRAY[]::uuid[]);
  v_added_user_ids uuid[];
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();

  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF cardinality(v_user_ids) <> (
    SELECT count(DISTINCT requested_user_id)
    FROM unnest(v_user_ids) AS requested_user_id
  ) THEN
    RAISE EXCEPTION 'The employee selection contains duplicate accounts.';
  END IF;

  SELECT plan.*
  INTO v_plan
  FROM public.notification_automation_plans AS plan
  WHERE plan.id = p_plan_id
    AND plan.status <> 'archived'
    AND (
      plan.owner_admin_id = v_admin_id
      OR v_admin_role = 'super_admin'
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automation plan was not found or cannot manage employees.';
  END IF;

  PERFORM private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    v_plan.owner_admin_id
  );

  IF EXISTS (
    SELECT 1
    FROM unnest(v_user_ids) AS requested_user_id
    LEFT JOIN public.users AS employee ON employee.id = requested_user_id
    WHERE employee.id IS NULL
       OR employee.created_by <> v_plan.owner_admin_id
  ) THEN
    RAISE EXCEPTION 'An employee is outside the automation plan administrator group.';
  END IF;

  PERFORM employee.id
  FROM public.users AS employee
  WHERE employee.id = ANY(v_user_ids)
     OR EXISTS (
       SELECT 1
       FROM public.notification_automation_plan_members AS current_member
       WHERE current_member.plan_id = v_plan.id
         AND current_member.user_id = employee.id
     )
  ORDER BY employee.id
  FOR UPDATE;

  SELECT COALESCE(array_agg(requested_user_id), ARRAY[]::uuid[])
  INTO v_added_user_ids
  FROM unnest(v_user_ids) AS requested_user_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.notification_automation_plan_members AS existing_member
    WHERE existing_member.plan_id = v_plan.id
      AND existing_member.user_id = requested_user_id
  );

  DELETE FROM public.notification_automation_plan_members AS member
  WHERE member.plan_id = v_plan.id
    AND NOT (member.user_id = ANY(v_user_ids));

  DELETE FROM public.notification_automation_plan_members AS member
  WHERE member.plan_id <> v_plan.id
    AND member.user_id = ANY(v_user_ids);

  FOREACH v_user_id IN ARRAY v_added_user_ids
  LOOP
    INSERT INTO public.notification_automation_plan_members(plan_id, user_id)
    VALUES (v_plan.id, v_user_id);

    FOR v_task IN
      SELECT task.*
      FROM public.notification_automation_tasks AS task
      WHERE task.plan_id = v_plan.id
        AND task.status = 'active'
        AND task.recipient_scope = 'selected'
        AND (task.starts_at IS NULL OR task.starts_at <= clock_timestamp())
    LOOP
      PERFORM private.capture_notification_automation_assignment_baseline(v_task, v_user_id);
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'plan_id', v_plan.id,
    'member_count', (
      SELECT count(*)
      FROM public.notification_automation_plan_members AS member
      WHERE member.plan_id = v_plan.id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_plan_for_employee(
  p_admin_session_token uuid,
  p_user_id uuid,
  p_plan_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_employee public.users%ROWTYPE;
  v_plan public.notification_automation_plans%ROWTYPE;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_current_plan_id uuid;
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();

  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  PERFORM private.assert_admin_can_manage_user(v_admin_id, v_admin_role, p_user_id);

  SELECT employee.*
  INTO v_employee
  FROM public.users AS employee
  WHERE employee.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee account was not found.';
  END IF;

  SELECT member.plan_id
  INTO v_current_plan_id
  FROM public.notification_automation_plan_members AS member
  WHERE member.user_id = v_employee.id;

  IF p_plan_id IS NOT NULL THEN
    SELECT plan.*
    INTO v_plan
    FROM public.notification_automation_plans AS plan
    JOIN public.admins AS owner ON owner.id = plan.owner_admin_id
    WHERE plan.id = p_plan_id
      AND plan.owner_admin_id = v_employee.created_by
      AND plan.status = 'active'
      AND owner.is_active = true;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'The selected automation plan is not available for this employee.';
    END IF;
  END IF;

  IF p_plan_id IS NOT DISTINCT FROM v_current_plan_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'user_id', v_employee.id,
      'plan_id', p_plan_id
    );
  END IF;

  DELETE FROM public.notification_automation_plan_members
  WHERE user_id = v_employee.id;

  IF p_plan_id IS NOT NULL THEN
    INSERT INTO public.notification_automation_plan_members(plan_id, user_id)
    VALUES (v_plan.id, v_employee.id);

    FOR v_task IN
      SELECT task.*
      FROM public.notification_automation_tasks AS task
      WHERE task.plan_id = v_plan.id
        AND task.status = 'active'
        AND task.recipient_scope = 'selected'
        AND (task.starts_at IS NULL OR task.starts_at <= clock_timestamp())
    LOOP
      PERFORM private.capture_notification_automation_assignment_baseline(v_task, v_employee.id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_employee.id,
    'plan_id', p_plan_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_employee_account_with_automation_plan(
  p_admin_session_token uuid,
  p_username text,
  p_password text,
  p_employee_id text,
  p_created_by uuid,
  p_remarks text,
  p_automation_plan_id uuid DEFAULT NULL
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
    remarks
  ) VALUES (
    trim(p_username),
    v_password_hash,
    trim(p_employee_id),
    v_owner_admin_id,
    trim(COALESCE(p_remarks, ''))
  )
  RETURNING * INTO v_user;

  INSERT INTO public.financial_employee_credentials(user_id, password_hash)
  VALUES (v_user.id, v_password_hash);

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

CREATE OR REPLACE FUNCTION public.get_notification_automation_executions_v2(
  p_admin_session_token uuid,
  p_owner_admin_id uuid,
  p_plan_id uuid DEFAULT NULL,
  p_all_plans boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_owner_admin_id uuid;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  v_owner_admin_id := private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    p_owner_admin_id
  );

  IF NOT p_all_plans AND p_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.notification_automation_plans AS plan
    WHERE plan.id = p_plan_id
      AND plan.owner_admin_id = v_owner_admin_id
  ) THEN
    RAISE EXCEPTION 'The selected automation plan is not available.';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(execution_data ORDER BY (execution_data->>'executed_at') DESC)
    FROM (
      SELECT to_jsonb(execution.*)
        || jsonb_build_object(
          'task_name', COALESCE(task.name, execution.trigger_snapshot->>'task_name', '已移除任務'),
          'plan_id', execution.plan_id,
          'employee_username', COALESCE(employee.username, execution.employee_username),
          'owner_username', owner.username
        ) AS execution_data
      FROM public.notification_automation_executions AS execution
      LEFT JOIN public.notification_automation_tasks AS task ON task.id = execution.task_id
      LEFT JOIN public.users AS employee ON employee.id = execution.user_id
      LEFT JOIN public.admins AS owner ON owner.id = execution.owner_admin_id
      WHERE execution.owner_admin_id = v_owner_admin_id
        AND (
          p_all_plans
          OR execution.plan_id IS NOT DISTINCT FROM p_plan_id
        )
      ORDER BY execution.executed_at DESC
      LIMIT 200
    ) AS visible_executions
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.save_notification_automation_plan(
  p_admin_session_token uuid,
  p_owner_admin_id uuid,
  p_plan_id uuid,
  p_name text,
  p_description text
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
  v_plan public.notification_automation_plans%ROWTYPE;
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

  IF char_length(trim(COALESCE(p_name, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Plan name must contain between 1 and 120 characters.';
  END IF;

  IF p_plan_id IS NULL THEN
    INSERT INTO public.notification_automation_plans (
      owner_admin_id,
      name,
      description
    ) VALUES (
      v_owner_admin_id,
      trim(p_name),
      COALESCE(trim(p_description), '')
    )
    RETURNING * INTO v_plan;
  ELSE
    UPDATE public.notification_automation_plans
    SET name = trim(p_name),
        description = COALESCE(trim(p_description), ''),
        updated_at = clock_timestamp()
    WHERE id = p_plan_id
      AND owner_admin_id = v_owner_admin_id
    RETURNING * INTO v_plan;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Automation plan was not found or cannot be edited.';
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'plan', to_jsonb(v_plan));
END;
$$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_plan_status(
  p_admin_session_token uuid,
  p_plan_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_plan public.notification_automation_plans%ROWTYPE;
  v_previous_status text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();

  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF p_status NOT IN ('active', 'paused', 'archived') THEN
    RAISE EXCEPTION 'Unsupported automation plan status.';
  END IF;

  SELECT plan.*
  INTO v_plan
  FROM public.notification_automation_plans AS plan
  WHERE plan.id = p_plan_id
    AND (
      plan.owner_admin_id = v_admin_id
      OR v_admin_role = 'super_admin'
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automation plan was not found or cannot be changed.';
  END IF;

  PERFORM private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    v_plan.owner_admin_id
  );

  v_previous_status := v_plan.status;

  UPDATE public.notification_automation_plans
  SET status = p_status,
      updated_at = clock_timestamp()
  WHERE id = v_plan.id
  RETURNING * INTO v_plan;

  IF p_status = 'active' AND v_previous_status <> 'active' THEN
    FOR v_task IN
      SELECT task.*
      FROM public.notification_automation_tasks AS task
      WHERE task.plan_id = v_plan.id
        AND task.status = 'active'
        AND (task.starts_at IS NULL OR task.starts_at <= clock_timestamp())
    LOOP
      FOR v_user_id IN
        SELECT employee.id
        FROM public.users AS employee
        WHERE employee.is_active = true
          AND private.automation_task_applies_to_user(v_task, employee.id)
      LOOP
        PERFORM private.capture_automation_baseline(v_task, v_user_id);
      END LOOP;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('success', true, 'plan', to_jsonb(v_plan));
END;
$$;

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

CREATE OR REPLACE FUNCTION public.set_notification_automation_task_status_v2(
  p_admin_session_token uuid,
  p_task_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();

  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF p_status NOT IN ('draft', 'active', 'paused', 'archived') THEN
    RAISE EXCEPTION 'Unsupported task status.';
  END IF;

  SELECT task.*
  INTO v_task
  FROM public.notification_automation_tasks AS task
  WHERE task.id = p_task_id
    AND task.is_shared_template = false
    AND (
      task.owner_admin_id = v_admin_id
      OR v_admin_role = 'super_admin'
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automation task was not found or cannot be changed.';
  END IF;

  PERFORM private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    v_task.owner_admin_id
  );

  IF p_status = 'active'
    AND v_task.plan_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.notification_automation_plans AS plan
      WHERE plan.id = v_task.plan_id
        AND plan.status = 'active'
    ) THEN
    RAISE EXCEPTION 'Activate the automation plan before activating this task.';
  END IF;

  IF p_status = 'active' AND v_task.status <> 'active' THEN
    UPDATE public.notification_automation_tasks
    SET status = 'active',
        activated_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = v_task.id
    RETURNING * INTO v_task;

    IF v_task.starts_at IS NULL OR v_task.starts_at <= clock_timestamp() THEN
      FOR v_user_id IN
        SELECT employee.id
        FROM public.users AS employee
        WHERE employee.is_active = true
          AND private.automation_task_applies_to_user(v_task, employee.id)
      LOOP
        PERFORM private.capture_automation_baseline(v_task, v_user_id);
      END LOOP;
    END IF;
  ELSE
    UPDATE public.notification_automation_tasks
    SET status = p_status,
        updated_at = clock_timestamp()
    WHERE id = v_task.id
    RETURNING * INTO v_task;
  END IF;

  RETURN jsonb_build_object('success', true, 'status', v_task.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_notification_automation_task(
  p_admin_session_token uuid,
  p_task_id uuid
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
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();

  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  SELECT task.owner_admin_id, owner.role
  INTO v_owner_admin_id, v_owner_role
  FROM public.notification_automation_tasks AS task
  JOIN public.admins AS owner ON owner.id = task.owner_admin_id
  WHERE task.id = p_task_id
    AND (
      task.owner_admin_id = v_admin_id
      OR v_admin_role = 'super_admin'
    )
  FOR UPDATE OF task;

  IF NOT FOUND OR v_owner_role = 'emergency_admin' THEN
    RAISE EXCEPTION 'Automation task was not found or cannot be deleted.';
  END IF;

  DELETE FROM public.notification_automation_tasks
  WHERE id = p_task_id;

  RETURN jsonb_build_object('success', true, 'task_id', p_task_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_admin_account(
  p_admin_session_token uuid,
  p_target_admin_id uuid,
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
  v_target_role text;
  v_admin public.admins%ROWTYPE;
BEGIN
  IF p_updates ? 'is_active' THEN
    PERFORM private.acquire_notification_automation_configuration_lock();
  END IF;

  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  SELECT role INTO v_target_role
  FROM public.admins
  WHERE id = p_target_admin_id;

  IF v_target_role IS NULL OR (
    p_target_admin_id <> v_admin_id
    AND NOT (v_admin_role = 'super_admin' AND v_target_role = 'secondary_admin')
  ) THEN
    RAISE EXCEPTION 'You do not have permission to update this administrator.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_updates) AS key
    WHERE key NOT IN ('username', 'is_active', 'is_pinned')
  ) THEN
    RAISE EXCEPTION 'The administrator update contains a protected field.';
  END IF;
  IF p_updates ? 'is_active' AND p_target_admin_id = v_admin_id THEN
    RAISE EXCEPTION 'Administrators cannot deactivate their own account.';
  END IF;

  UPDATE public.admins
  SET username = CASE WHEN p_updates ? 'username' THEN trim(p_updates->>'username') ELSE username END,
      is_active = CASE WHEN p_updates ? 'is_active' THEN (p_updates->>'is_active')::boolean ELSE is_active END,
      is_pinned = CASE WHEN p_updates ? 'is_pinned' THEN (p_updates->>'is_pinned')::boolean ELSE is_pinned END,
      updated_at = now()
  WHERE id = p_target_admin_id
  RETURNING * INTO v_admin;

  RETURN to_jsonb(v_admin) - 'password_hash';
END;
$$;

ALTER FUNCTION public.save_notification_automation_task(uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz)
  RENAME TO save_notification_automation_task_unlocked;
ALTER FUNCTION public.save_notification_automation_task_copy(uuid, uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz)
  RENAME TO save_notification_automation_task_copy_unlocked;
ALTER FUNCTION public.copy_shared_notification_automation_task(uuid, uuid)
  RENAME TO copy_shared_notification_automation_task_unlocked;
ALTER FUNCTION public.copy_shared_notification_automation_task_with_delivery(uuid, uuid)
  RENAME TO copy_shared_notification_automation_task_with_delivery_unlocked;
ALTER FUNCTION public.set_notification_automation_task_status(uuid, uuid, text)
  RENAME TO set_notification_automation_task_status_unlocked;
ALTER FUNCTION public.admin_create_employee_account(uuid, text, text, text, uuid, text)
  RENAME TO admin_create_employee_account_unlocked;
ALTER FUNCTION public.admin_update_employee_account(uuid, uuid, jsonb)
  RENAME TO admin_update_employee_account_unlocked;
ALTER FUNCTION public.admin_delete_employee_account(uuid, uuid)
  RENAME TO admin_delete_employee_account_unlocked;
ALTER FUNCTION public.admin_delete_secondary_account(uuid, uuid)
  RENAME TO admin_delete_secondary_account_unlocked;

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
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();
  RETURN public.save_notification_automation_task_unlocked(
    p_admin_session_token,
    p_task_id,
    p_name,
    p_description,
    p_trigger_type,
    p_trigger_mode,
    p_threshold_value,
    p_minimum_daily_orders,
    p_minimum_daily_work_minutes,
    p_recipient_scope,
    p_recipient_ids,
    p_title_template,
    p_content_template,
    p_message_type,
    p_priority,
    p_reward_enabled,
    p_reward_amount,
    p_is_shared_template,
    p_starts_at,
    p_ends_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_notification_automation_task_copy(
  p_admin_session_token uuid,
  p_source_task_id uuid,
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
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();
  RETURN public.save_notification_automation_task_copy_unlocked(
    p_admin_session_token,
    p_source_task_id,
    p_task_id,
    p_name,
    p_description,
    p_trigger_type,
    p_trigger_mode,
    p_threshold_value,
    p_minimum_daily_orders,
    p_minimum_daily_work_minutes,
    p_recipient_scope,
    p_recipient_ids,
    p_title_template,
    p_content_template,
    p_message_type,
    p_priority,
    p_reward_enabled,
    p_reward_amount,
    p_is_shared_template,
    p_starts_at,
    p_ends_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.copy_shared_notification_automation_task(
  p_admin_session_token uuid,
  p_source_task_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();
  RETURN public.copy_shared_notification_automation_task_unlocked(
    p_admin_session_token,
    p_source_task_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.copy_shared_notification_automation_task_with_delivery(
  p_admin_session_token uuid,
  p_source_task_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();
  RETURN public.copy_shared_notification_automation_task_with_delivery_unlocked(
    p_admin_session_token,
    p_source_task_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_task_status(
  p_admin_session_token uuid,
  p_task_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();
  RETURN public.set_notification_automation_task_status_unlocked(
    p_admin_session_token,
    p_task_id,
    p_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_employee_account(
  p_admin_session_token uuid,
  p_username text,
  p_password text,
  p_employee_id text,
  p_created_by uuid,
  p_remarks text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
  SELECT public.admin_create_employee_account_with_automation_plan(
    p_admin_session_token,
    p_username,
    p_password,
    p_employee_id,
    p_created_by,
    p_remarks,
    NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.admin_update_employee_account(
  p_admin_session_token uuid,
  p_user_id uuid,
  p_updates jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  IF p_updates ? 'is_active' THEN
    PERFORM private.acquire_notification_automation_configuration_lock();
  END IF;
  RETURN public.admin_update_employee_account_unlocked(
    p_admin_session_token,
    p_user_id,
    p_updates
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_employee_account(
  p_admin_session_token uuid,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();
  RETURN public.admin_delete_employee_account_unlocked(
    p_admin_session_token,
    p_user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_secondary_account(
  p_admin_session_token uuid,
  p_target_admin_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();
  RETURN public.admin_delete_secondary_account_unlocked(
    p_admin_session_token,
    p_target_admin_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.save_notification_automation_task_unlocked(uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.save_notification_automation_task_copy_unlocked(uuid, uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.copy_shared_notification_automation_task_unlocked(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.copy_shared_notification_automation_task_with_delivery_unlocked(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_notification_automation_task_status_unlocked(uuid, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_create_employee_account_unlocked(uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_update_employee_account_unlocked(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_employee_account_unlocked(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_secondary_account_unlocked(uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.save_notification_automation_task(uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_notification_automation_task_copy(uuid, uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copy_shared_notification_automation_task(uuid, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.copy_shared_notification_automation_task_with_delivery(uuid, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_notification_automation_task_status(uuid, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_employee_account(uuid, text, text, text, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_employee_account(uuid, uuid, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_employee_account(uuid, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_secondary_account(uuid, uuid) TO anon, authenticated, service_role;

DO $$
BEGIN
  IF to_regprocedure('public.save_notification_automation_task(uuid,uuid,text,text,text,text,numeric,integer,integer,integer,integer,text,uuid[],text,text,text,text,boolean,numeric,boolean,timestamptz,timestamptz)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.save_notification_automation_task(uuid, uuid, text, text, text, text, numeric, integer, integer, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.acquire_notification_automation_configuration_lock() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.snapshot_notification_automation_execution_plan() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.capture_notification_automation_assignment_baseline(public.notification_automation_tasks, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_notification_automation_executions_v2(uuid, uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_notification_automation_executions_v2(uuid, uuid, uuid, boolean) TO anon, authenticated, service_role;
