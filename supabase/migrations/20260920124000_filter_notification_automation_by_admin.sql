DROP FUNCTION IF EXISTS public.get_notification_automation_dashboard(uuid);

CREATE OR REPLACE FUNCTION public.get_notification_automation_dashboard(
  p_admin_session_token uuid,
  p_owner_admin_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_selected_admin_id uuid;
  v_result jsonb;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  IF v_admin_role = 'super_admin' THEN
    v_selected_admin_id := p_owner_admin_id;

    IF v_selected_admin_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM public.admins AS selected_admin
      WHERE selected_admin.id = v_selected_admin_id
        AND selected_admin.is_active = true
        AND selected_admin.role <> 'emergency_admin'
    ) THEN
      RAISE EXCEPTION 'The selected administrator group is not available.';
    END IF;
  ELSE
    v_selected_admin_id := v_admin_id;
  END IF;

  SELECT jsonb_build_object(
    'currency', private.resolve_admin_currency(COALESCE(v_selected_admin_id, v_admin_id)),
    'admin_groups', CASE
      WHEN v_admin_role = 'super_admin' THEN COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', visible_admin.id,
            'username', visible_admin.username,
            'role', visible_admin.role
          )
          ORDER BY
            CASE WHEN visible_admin.id = v_admin_id THEN 0 ELSE 1 END,
            visible_admin.username
        )
        FROM public.admins AS visible_admin
        WHERE visible_admin.is_active = true
          AND visible_admin.role <> 'emergency_admin'
      ), '[]'::jsonb)
      ELSE '[]'::jsonb
    END,
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
        WHERE task.owner_admin_id = v_selected_admin_id
          OR (v_admin_role = 'super_admin' AND v_selected_admin_id IS NULL)
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
          AND (
            task.owner_admin_id = v_selected_admin_id
            OR (v_admin_role = 'super_admin' AND v_selected_admin_id IS NULL)
            OR v_admin_role <> 'super_admin'
          )
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
        WHERE execution.owner_admin_id = v_selected_admin_id
          OR (v_admin_role = 'super_admin' AND v_selected_admin_id IS NULL)
        ORDER BY execution.executed_at DESC
        LIMIT 200
      ) AS visible_executions
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_notification_automation_dashboard(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_notification_automation_dashboard(uuid, uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
