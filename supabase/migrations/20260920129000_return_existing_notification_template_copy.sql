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
  v_existing_task_id uuid;
  v_task_id uuid;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  IF v_admin_role NOT IN ('secondary_admin', 'super_admin') THEN
    RAISE EXCEPTION 'Only a secondary administrator can copy a shared template.';
  END IF;

  SELECT task.* INTO v_source
  FROM public.notification_automation_tasks AS task
  JOIN public.admins AS owner ON owner.id = task.owner_admin_id
  WHERE task.id = p_source_task_id
    AND task.is_shared_template = true
    AND owner.role = 'super_admin';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared automation template was not found.';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_admin_id::text || ':' || v_source.id::text, 0)
  );

  SELECT existing.id
  INTO v_existing_task_id
  FROM public.notification_automation_tasks AS existing
  WHERE existing.owner_admin_id = v_admin_id
    AND existing.source_task_id = v_source.id
    AND existing.name = v_source.name
    AND existing.description = v_source.description
    AND existing.trigger_type = v_source.trigger_type
    AND existing.trigger_mode = v_source.trigger_mode
    AND existing.threshold_value = v_source.threshold_value
    AND existing.minimum_daily_orders IS NOT DISTINCT FROM v_source.minimum_daily_orders
    AND existing.minimum_daily_work_minutes IS NOT DISTINCT FROM v_source.minimum_daily_work_minutes
    AND existing.recipient_scope = 'all_managed'
    AND existing.title_template = v_source.title_template
    AND existing.content_template = v_source.content_template
    AND existing.message_type = v_source.message_type
    AND existing.priority = v_source.priority
    AND existing.reward_enabled = v_source.reward_enabled
    AND existing.reward_amount IS NOT DISTINCT FROM v_source.reward_amount
    AND existing.starts_at IS NOT DISTINCT FROM v_source.starts_at
    AND existing.ends_at IS NOT DISTINCT FROM v_source.ends_at
  LIMIT 1;

  IF v_existing_task_id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'duplicate', true,
      'task_id', v_existing_task_id,
      'status', 'existing'
    );
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

REVOKE ALL ON FUNCTION public.copy_shared_notification_automation_task(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.copy_shared_notification_automation_task(uuid, uuid) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
