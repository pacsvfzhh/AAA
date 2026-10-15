CREATE OR REPLACE FUNCTION public.delete_archived_notification_automation_plan(
  p_admin_session_token uuid,
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
  v_plan public.notification_automation_plans%ROWTYPE;
  v_task_count integer;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  PERFORM private.acquire_notification_automation_configuration_lock();

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
    RAISE EXCEPTION 'Automation plan was not found or cannot be deleted.';
  END IF;

  PERFORM private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    v_plan.owner_admin_id
  );

  IF v_plan.status <> 'archived' THEN
    RAISE EXCEPTION 'Only archived automation plans can be deleted.';
  END IF;

  SELECT count(*)::integer
  INTO v_task_count
  FROM public.notification_automation_tasks AS task
  WHERE task.plan_id = v_plan.id;

  DELETE FROM public.notification_automation_tasks
  WHERE plan_id = v_plan.id;

  DELETE FROM public.notification_automation_plans
  WHERE id = v_plan.id;

  RETURN jsonb_build_object(
    'success', true,
    'plan_id', v_plan.id,
    'task_count', v_task_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_archived_notification_automation_plan(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_archived_notification_automation_plan(uuid, uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
