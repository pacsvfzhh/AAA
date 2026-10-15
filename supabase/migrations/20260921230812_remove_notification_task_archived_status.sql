UPDATE public.notification_automation_tasks
SET status = 'paused',
    updated_at = clock_timestamp()
WHERE status = 'archived';

ALTER TABLE public.notification_automation_tasks
  DROP CONSTRAINT IF EXISTS notification_automation_tasks_status_check;

ALTER TABLE public.notification_automation_tasks
  ADD CONSTRAINT notification_automation_tasks_status_check
  CHECK (status IN ('draft', 'active', 'paused'));

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

  IF p_status NOT IN ('draft', 'active', 'paused') THEN
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
