DROP FUNCTION IF EXISTS public.get_account_locks_for_admin(uuid);

CREATE FUNCTION public.get_account_locks_for_admin(p_admin_id uuid)
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
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_admin_role text;
BEGIN
  SELECT role
  INTO v_admin_role
  FROM public.admins
  WHERE admins.id = p_admin_id;

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
      AND (
        al.identifier_type = 'ip'
        OR (al.identifier_type = 'username' AND u.created_by = p_admin_id)
      )
    ORDER BY al.created_at DESC;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.get_account_locks_for_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_account_locks_for_admin(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.get_account_locks_for_admin IS 'Returns active account lock records with the employee ID and latest failed login IP for username locks.';
