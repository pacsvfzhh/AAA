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
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_source public.notification_automation_tasks%ROWTYPE;
  v_result jsonb;
  v_task_id uuid;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF v_admin_role NOT IN ('secondary_admin', 'super_admin') THEN
    RAISE EXCEPTION 'Only an administrator can customize a shared template.';
  END IF;

  IF p_task_id IS NOT NULL OR COALESCE(p_is_shared_template, false) THEN
    RAISE EXCEPTION 'A customized template must be saved as a new private task.';
  END IF;

  SELECT task.*
  INTO v_source
  FROM public.notification_automation_tasks AS task
  JOIN public.admins AS owner ON owner.id = task.owner_admin_id
  WHERE task.id = p_source_task_id
    AND task.is_shared_template = true
    AND owner.role = 'super_admin';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared automation template was not found.';
  END IF;

  v_result := public.save_notification_automation_task(
    p_admin_session_token,
    NULL,
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
    false,
    p_starts_at,
    p_ends_at
  );

  v_task_id := (v_result ->> 'task_id')::uuid;

  UPDATE public.notification_automation_tasks
  SET source_task_id = v_source.id,
      source_version = v_source.version,
      updated_at = clock_timestamp()
  WHERE id = v_task_id
    AND owner_admin_id = v_admin_id;

  RETURN v_result || jsonb_build_object(
    'source_task_id', v_source.id,
    'source_version', v_source.version
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.save_notification_automation_task_copy(
  uuid, uuid, uuid, text, text, text, text, numeric, integer, integer,
  text, uuid[], text, text, text, text, boolean, numeric, boolean,
  timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_notification_automation_task_copy(
  uuid, uuid, uuid, text, text, text, text, numeric, integer, integer,
  text, uuid[], text, text, text, text, boolean, numeric, boolean,
  timestamptz, timestamptz
) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
