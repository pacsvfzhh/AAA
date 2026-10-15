-- Keep the existing PostgREST function names and wire parameter names for rollout compatibility.
-- The p_admin_id wire value is now the administrator financial session token.

CREATE OR REPLACE FUNCTION private.get_account_lock_admin_context(p_token uuid)
RETURNS TABLE(admin_id uuid, admin_role text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $$
BEGIN
  RETURN QUERY
  SELECT a.id, a.role
  FROM public.admin_financial_sessions s
  JOIN public.admins a ON a.id = s.admin_id
  WHERE s.token_hash = private.hash_financial_token(p_token)
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND a.is_active = true
    AND a.role IN ('super_admin', 'secondary_admin', 'emergency_admin')
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Financial administrator session is invalid or expired.';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.get_account_lock_admin_context(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.get_account_locks_for_admin(p_admin_id uuid)
RETURNS TABLE (
  id uuid,
  identifier text,
  identifier_type text,
  lock_until timestamptz,
  lock_reason text,
  failed_attempts integer,
  created_at timestamptz,
  unlocked_at timestamptz,
  unlocked_by uuid,
  user_id uuid,
  username text,
  employee_id text,
  lock_ip text,
  admin_username text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_account_lock_admin_context(p_admin_id) context;

  IF v_admin_role IN ('super_admin', 'emergency_admin') THEN
    RETURN QUERY
    SELECT
      al.id,
      al.identifier,
      al.identifier_type,
      al.lock_until,
      al.lock_reason,
      al.failed_attempts,
      al.created_at,
      al.unlocked_at,
      al.unlocked_by,
      al.user_id,
      u.username,
      u.employee_id,
      latest_attempt.ip_address,
      a.username AS admin_username
    FROM public.account_locks al
    LEFT JOIN public.users u ON al.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT la.ip_address
      FROM public.login_attempts la
      WHERE la.identifier = al.identifier
        AND la.identifier_type = al.identifier_type
        AND la.success = false
        AND la.attempt_time <= al.created_at
      ORDER BY la.attempt_time DESC
      LIMIT 1
    ) latest_attempt ON true
    LEFT JOIN public.admins a ON u.created_by = a.id
    WHERE al.unlocked_at IS NULL
      AND al.lock_until > now()
    ORDER BY al.created_at DESC;
  ELSE
    RETURN QUERY
    SELECT
      al.id,
      al.identifier,
      al.identifier_type,
      al.lock_until,
      al.lock_reason,
      al.failed_attempts,
      al.created_at,
      al.unlocked_at,
      al.unlocked_by,
      al.user_id,
      u.username,
      u.employee_id,
      latest_attempt.ip_address,
      a.username AS admin_username
    FROM public.account_locks al
    LEFT JOIN public.users u ON al.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT la.ip_address
      FROM public.login_attempts la
      WHERE la.identifier = al.identifier
        AND la.identifier_type = al.identifier_type
        AND la.success = false
        AND la.attempt_time <= al.created_at
      ORDER BY la.attempt_time DESC
      LIMIT 1
    ) latest_attempt ON true
    LEFT JOIN public.admins a ON u.created_by = a.id
    WHERE al.unlocked_at IS NULL
      AND al.lock_until > now()
      AND al.identifier_type = 'username'
      AND u.created_by = v_admin_id
    ORDER BY al.created_at DESC;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_account_lock_history_for_admin(
  p_admin_id uuid,
  p_limit integer DEFAULT 200
)
RETURNS TABLE (
  id uuid,
  identifier text,
  identifier_type text,
  lock_until timestamptz,
  lock_reason text,
  failed_attempts integer,
  created_at timestamptz,
  unlocked_at timestamptz,
  unlocked_by uuid,
  user_id uuid,
  username text,
  employee_id text,
  lock_ip text,
  admin_username text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_account_lock_admin_context(p_admin_id) context;

  IF v_admin_role IN ('super_admin', 'emergency_admin') THEN
    RETURN QUERY
    SELECT
      al.id,
      al.identifier,
      al.identifier_type,
      al.lock_until,
      al.lock_reason,
      al.failed_attempts,
      al.created_at,
      al.unlocked_at,
      al.unlocked_by,
      al.user_id,
      u.username,
      u.employee_id,
      latest_attempt.ip_address,
      a.username AS admin_username
    FROM public.account_locks al
    LEFT JOIN public.users u ON al.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT la.ip_address
      FROM public.login_attempts la
      WHERE la.identifier = al.identifier
        AND la.identifier_type = al.identifier_type
        AND la.success = false
        AND la.attempt_time <= al.created_at
      ORDER BY la.attempt_time DESC
      LIMIT 1
    ) latest_attempt ON true
    LEFT JOIN public.admins a ON al.unlocked_by = a.id
    WHERE al.identifier_type = 'username'
    ORDER BY al.created_at DESC
    LIMIT v_limit;
  ELSE
    RETURN QUERY
    SELECT
      al.id,
      al.identifier,
      al.identifier_type,
      al.lock_until,
      al.lock_reason,
      al.failed_attempts,
      al.created_at,
      al.unlocked_at,
      al.unlocked_by,
      al.user_id,
      u.username,
      u.employee_id,
      latest_attempt.ip_address,
      a.username AS admin_username
    FROM public.account_locks al
    LEFT JOIN public.users u ON al.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT la.ip_address
      FROM public.login_attempts la
      WHERE la.identifier = al.identifier
        AND la.identifier_type = al.identifier_type
        AND la.success = false
        AND la.attempt_time <= al.created_at
      ORDER BY la.attempt_time DESC
      LIMIT 1
    ) latest_attempt ON true
    LEFT JOIN public.admins a ON al.unlocked_by = a.id
    WHERE al.identifier_type = 'username'
      AND u.created_by = v_admin_id
    ORDER BY al.created_at DESC
    LIMIT v_limit;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.unlock_account_with_permission_check(
  p_identifier text,
  p_identifier_type text,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_lock_user_id uuid;
  v_user_created_by uuid;
  v_updated_count integer;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_account_lock_admin_context(p_admin_id) context;

  SELECT al.user_id
  INTO v_lock_user_id
  FROM public.account_locks al
  WHERE al.identifier = p_identifier
    AND al.identifier_type = p_identifier_type
    AND al.lock_until > now()
    AND al.unlocked_at IS NULL
  ORDER BY al.lock_until DESC
  LIMIT 1;

  IF v_admin_role = 'secondary_admin' THEN
    IF v_lock_user_id IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'message', 'You do not have permission to unlock this account'
      );
    END IF;

    SELECT u.created_by
    INTO v_user_created_by
    FROM public.users u
    WHERE u.id = v_lock_user_id;

    IF v_user_created_by IS NULL OR v_user_created_by <> v_admin_id THEN
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

  UPDATE public.account_locks al
  SET unlocked_at = now(),
      unlocked_by = v_admin_id
  WHERE al.identifier = p_identifier
    AND al.identifier_type = p_identifier_type
    AND al.lock_until > now()
    AND al.unlocked_at IS NULL
    AND (
      v_admin_role IN ('super_admin', 'emergency_admin')
      OR al.user_id = v_lock_user_id
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

ALTER FUNCTION public.check_login_rate_limit(text, text) SECURITY DEFINER;
ALTER FUNCTION public.check_login_rate_limit(text, text) SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp';
ALTER FUNCTION public.record_login_attempt(text, text, boolean, text, text) SECURITY DEFINER;
ALTER FUNCTION public.record_login_attempt(text, text, boolean, text, text) SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp';

DROP POLICY IF EXISTS "Admins can view all login attempts" ON public.login_attempts;
DROP POLICY IF EXISTS "System can insert login attempts" ON public.login_attempts;
DROP POLICY IF EXISTS "Allow read for rate limit checks" ON public.login_attempts;
DROP POLICY IF EXISTS "Admins can view all account locks" ON public.account_locks;
DROP POLICY IF EXISTS "System can insert account locks" ON public.account_locks;
DROP POLICY IF EXISTS "System can update account locks" ON public.account_locks;
DROP POLICY IF EXISTS "Allow read for rate limit checks" ON public.account_locks;
DROP POLICY IF EXISTS "Allow update for rate limit system" ON public.account_locks;
DROP POLICY IF EXISTS "Allow function access to account locks" ON public.account_locks;
DROP POLICY IF EXISTS "Super admin can view all account locks" ON public.account_locks;
DROP POLICY IF EXISTS "Secondary admin can view own employees account locks" ON public.account_locks;
DROP POLICY IF EXISTS "Emergency admin can view account locks" ON public.account_locks;
DROP POLICY IF EXISTS "Emergency admin can unlock accounts" ON public.account_locks;
DROP POLICY IF EXISTS "Emergency admin can view login attempts" ON public.login_attempts;

REVOKE ALL ON TABLE public.account_locks, public.login_attempts FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_account_locks_for_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_account_locks_for_admin(uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.get_account_lock_history_for_admin(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_account_lock_history_for_admin(uuid, integer) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.unlock_account_with_permission_check(text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unlock_account_with_permission_check(text, text, uuid) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.check_login_rate_limit(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_login_rate_limit(text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.record_login_attempt(text, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_login_attempt(text, text, boolean, text, text) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.unlock_account(text, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_old_login_attempts() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.get_account_locks_for_admin(uuid) IS 'Returns active account locks after validating the administrator financial session token supplied through the legacy p_admin_id wire parameter.';
COMMENT ON FUNCTION public.get_account_lock_history_for_admin(uuid, integer) IS 'Returns historical account locks after validating the administrator financial session token supplied through the legacy p_admin_id wire parameter.';
COMMENT ON FUNCTION public.unlock_account_with_permission_check(text, text, uuid) IS 'Unlocks an account after validating the administrator financial session token supplied through the legacy p_admin_id wire parameter.';
