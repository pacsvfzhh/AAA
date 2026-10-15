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

CREATE OR REPLACE FUNCTION public.get_notification_automation_dashboard(
  p_admin_session_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_result jsonb;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  SELECT jsonb_build_object(
    'currency', private.resolve_admin_currency(v_admin_id),
    'tasks', COALESCE((
      SELECT jsonb_agg(task_data ORDER BY (task_data->>'updated_at') DESC)
      FROM (
        SELECT to_jsonb(task.*)
          || jsonb_build_object(
            'owner_username', owner.username,
            'recipient_ids', COALESCE((
              SELECT jsonb_agg(recipient.user_id)
              FROM public.notification_automation_task_recipients AS recipient
              WHERE recipient.task_id = task.id
            ), '[]'::jsonb),
            'execution_count', (
              SELECT count(*)
              FROM public.notification_automation_executions AS execution
              WHERE execution.task_id = task.id
                AND execution.status = 'succeeded'
            ),
            'total_rewards', (
              SELECT COALESCE(sum(execution.reward_amount), 0)
              FROM public.notification_automation_executions AS execution
              WHERE execution.task_id = task.id
                AND execution.status = 'succeeded'
            )
          ) AS task_data
        FROM public.notification_automation_tasks AS task
        JOIN public.admins AS owner ON owner.id = task.owner_admin_id
        WHERE task.owner_admin_id = v_admin_id
          OR v_admin_role = 'super_admin'
      ) AS visible_tasks
    ), '[]'::jsonb),
    'shared_templates', COALESCE((
      SELECT jsonb_agg(template_data ORDER BY (template_data->>'updated_at') DESC)
      FROM (
        SELECT to_jsonb(task.*)
          || jsonb_build_object(
            'owner_username', owner.username,
            'recipient_ids', '[]'::jsonb
          ) AS template_data
        FROM public.notification_automation_tasks AS task
        JOIN public.admins AS owner ON owner.id = task.owner_admin_id
        WHERE task.is_shared_template = true
          AND task.status IN ('active', 'paused')
      ) AS available_templates
    ), '[]'::jsonb),
    'executions', COALESCE((
      SELECT jsonb_agg(execution_data ORDER BY (execution_data->>'executed_at') DESC)
      FROM (
        SELECT to_jsonb(execution.*)
          || jsonb_build_object(
            'task_name', task.name,
            'employee_username', COALESCE(employee.username, execution.employee_username),
            'owner_username', owner.username
          ) AS execution_data
        FROM public.notification_automation_executions AS execution
        JOIN public.notification_automation_tasks AS task ON task.id = execution.task_id
        LEFT JOIN public.users AS employee ON employee.id = execution.user_id
        LEFT JOIN public.admins AS owner ON owner.id = execution.owner_admin_id
        WHERE execution.owner_admin_id = v_admin_id
          OR v_admin_role = 'super_admin'
        ORDER BY execution.executed_at DESC
        LIMIT 200
      ) AS visible_executions
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
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
  WHERE task.id = p_source_task_id
    AND task.is_shared_template = true
    AND task.status IN ('active', 'paused');

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
    status,
    is_shared_template,
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
    'draft',
    false,
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

REVOKE ALL ON FUNCTION public.get_notification_automation_dashboard(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_notification_automation_task(uuid, uuid, text, text, text, text, numeric, integer, integer, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.copy_shared_notification_automation_task(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_notification_automation_dashboard(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_notification_automation_task(uuid, uuid, text, text, text, text, numeric, integer, integer, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.copy_shared_notification_automation_task(uuid, uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
