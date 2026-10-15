CREATE OR REPLACE FUNCTION public.unlock_account_with_permission_check(
  p_identifier text,
  p_identifier_type text,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_admin_role text;
  v_lock_user_id uuid;
  v_user_created_by uuid;
  v_updated_count integer;
BEGIN
  SELECT role
  INTO v_admin_role
  FROM public.admins
  WHERE id = p_admin_id;

  IF v_admin_role IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Admin not found'
    );
  END IF;

  SELECT user_id
  INTO v_lock_user_id
  FROM public.account_locks
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL
  ORDER BY lock_until DESC
  LIMIT 1;

  IF v_admin_role = 'secondary_admin' THEN
    IF v_lock_user_id IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'message', 'You do not have permission to unlock this account'
      );
    END IF;

    SELECT created_by
    INTO v_user_created_by
    FROM public.users
    WHERE id = v_lock_user_id;

    IF v_user_created_by IS NULL OR v_user_created_by <> p_admin_id THEN
      RETURN jsonb_build_object(
        'success', false,
        'message', 'You do not have permission to unlock this account'
      );
    END IF;
  ELSIF v_admin_role NOT IN ('super_admin', 'emergency_admin') THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'You do not have permission to unlock this account'
    );
  END IF;

  UPDATE public.account_locks
  SET unlocked_at = now(),
      unlocked_by = p_admin_id
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL
    AND (
      v_admin_role IN ('super_admin', 'emergency_admin')
      OR user_id = v_lock_user_id
    );

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count > 0 THEN
    INSERT INTO public.login_attempts (
      identifier,
      identifier_type,
      success,
      ip_address,
      user_agent
    ) VALUES (
      p_identifier,
      p_identifier_type,
      true,
      'admin-unlock',
      'Admin manual unlock'
    );

    RETURN jsonb_build_object(
      'success', true,
      'message', 'Account unlocked successfully',
      'unlocked_count', v_updated_count
    );
  END IF;

  RETURN jsonb_build_object(
    'success', false,
    'message', 'No locked account found'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.unlock_account_with_permission_check(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.unlock_account_with_permission_check(text, text, uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.unlock_account_with_permission_check IS 'Unlocks an account within the requesting administrator scope.';
