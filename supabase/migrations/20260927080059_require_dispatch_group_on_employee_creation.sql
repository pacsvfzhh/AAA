-- Drop the old wrapper first: it depends on the old seven-argument canonical function.
-- No CASCADE: fail the migration if any other database objects depend on either signature.
DROP FUNCTION public.admin_create_employee_account(uuid, text, text, text, uuid, text);
DROP FUNCTION public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid);

-- The legacy unlocked RPC has no dispatch-group requirement and must not be callable by API roles.
REVOKE ALL ON FUNCTION public.admin_create_employee_account_unlocked(uuid, text, text, text, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.admin_create_employee_account_with_automation_plan(
  p_admin_session_token uuid,
  p_username text,
  p_password text,
  p_employee_id text,
  p_created_by uuid,
  p_remarks text,
  p_automation_plan_id uuid,
  p_dispatch_group_id uuid
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

  IF p_dispatch_group_id IS NULL THEN
    RAISE EXCEPTION 'A dispatch group must be selected.';
  END IF;

  -- Keep the group active and unarchived through the transaction, including the membership insert.
  PERFORM 1
  FROM public.dispatch_groups AS dispatch_group
  WHERE dispatch_group.id = p_dispatch_group_id
    AND dispatch_group.is_active = true
    AND dispatch_group.archived_at IS NULL
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'The selected dispatch group is not available.';
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

  INSERT INTO public.dispatch_group_members(group_id, user_id, assigned_by)
  VALUES (p_dispatch_group_id, v_user.id, v_admin_id);

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

CREATE FUNCTION public.admin_create_employee_account(
  p_admin_session_token uuid,
  p_username text,
  p_password text,
  p_employee_id text,
  p_created_by uuid,
  p_remarks text,
  p_dispatch_group_id uuid
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
    NULL,
    p_dispatch_group_id
  );
$$;

REVOKE ALL ON FUNCTION public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_employee_account(uuid, text, text, text, uuid, text, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid, uuid)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_employee_account(uuid, text, text, text, uuid, text, uuid)
  TO anon, authenticated, service_role;
