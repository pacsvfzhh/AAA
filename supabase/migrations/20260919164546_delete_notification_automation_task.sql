CREATE OR REPLACE FUNCTION public.delete_notification_automation_task(
  p_admin_session_token uuid,
  p_task_id uuid
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
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

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

  RETURN jsonb_build_object(
    'success', true,
    'task_id', p_task_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_notification_automation_task(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_notification_automation_task(uuid, uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
