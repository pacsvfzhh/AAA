DROP FUNCTION IF EXISTS public.get_notification_automation_executions_v2(uuid, uuid, uuid, boolean);

CREATE FUNCTION public.get_notification_automation_executions_v2(
  p_admin_session_token uuid,
  p_owner_admin_id uuid,
  p_plan_id uuid DEFAULT NULL,
  p_all_plans boolean DEFAULT false,
  p_search_query text DEFAULT NULL
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
  v_search_query text := lower(trim(COALESCE(p_search_query, '')));
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
          'employee_id', employee.employee_id,
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
        AND (
          v_search_query = ''
          OR strpos(lower(COALESCE(employee.username, execution.employee_username, '')), v_search_query) > 0
          OR strpos(lower(COALESCE(employee.employee_id, '')), v_search_query) > 0
        )
      ORDER BY execution.executed_at DESC
      LIMIT 200
    ) AS visible_executions
  ), '[]'::jsonb);
END;
$$;
