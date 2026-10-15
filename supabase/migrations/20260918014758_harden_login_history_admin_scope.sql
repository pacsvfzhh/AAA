CREATE INDEX IF NOT EXISTS idx_employee_login_history_user_action_created_at
  ON public.employee_login_history(user_id, action_type, created_at DESC);

DROP FUNCTION IF EXISTS public.get_employee_login_summary(uuid, text);

CREATE OR REPLACE FUNCTION public.get_employee_login_summary(
  p_admin_id uuid,
  p_search_term text DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  username text,
  employee_id text,
  is_active boolean,
  is_pinned boolean,
  created_by uuid,
  latest_login_time timestamptz,
  latest_login_ip text,
  latest_login_device_info jsonb,
  latest_login_user_agent text,
  latest_logout_time timestamptz,
  latest_logout_ip text,
  total_logins bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_id) context;

  IF v_admin_role = 'super_admin' THEN
    RETURN QUERY
    SELECT
      u.id AS user_id,
      u.username,
      u.employee_id,
      u.is_active,
      COALESCE(u.is_pinned, false) AS is_pinned,
      u.created_by,
      login_data.latest_login_time,
      login_data.latest_login_ip,
      login_data.latest_login_device_info,
      login_data.latest_login_user_agent,
      logout_data.latest_logout_time,
      logout_data.latest_logout_ip,
      COALESCE(login_data.total_logins, 0) AS total_logins
    FROM public.users AS u
    LEFT JOIN public.admins AS owner_admin ON owner_admin.id = u.created_by
    LEFT JOIN LATERAL (
      SELECT
        MAX(elh.created_at) AS latest_login_time,
        (
          SELECT login_event.ip_address
          FROM public.employee_login_history AS login_event
          WHERE login_event.user_id = u.id
            AND login_event.action_type = 'login'
          ORDER BY login_event.created_at DESC
          LIMIT 1
        ) AS latest_login_ip,
        (
          SELECT login_event.device_info
          FROM public.employee_login_history AS login_event
          WHERE login_event.user_id = u.id
            AND login_event.action_type = 'login'
          ORDER BY login_event.created_at DESC
          LIMIT 1
        ) AS latest_login_device_info,
        (
          SELECT login_event.user_agent
          FROM public.employee_login_history AS login_event
          WHERE login_event.user_id = u.id
            AND login_event.action_type = 'login'
          ORDER BY login_event.created_at DESC
          LIMIT 1
        ) AS latest_login_user_agent,
        COUNT(*) AS total_logins
      FROM public.employee_login_history AS elh
      WHERE elh.user_id = u.id
        AND elh.action_type = 'login'
    ) AS login_data ON true
    LEFT JOIN LATERAL (
      SELECT
        MAX(elh.created_at) AS latest_logout_time,
        (
          SELECT logout_event.ip_address
          FROM public.employee_login_history AS logout_event
          WHERE logout_event.user_id = u.id
            AND logout_event.action_type = 'logout'
          ORDER BY logout_event.created_at DESC
          LIMIT 1
        ) AS latest_logout_ip
      FROM public.employee_login_history AS elh
      WHERE elh.user_id = u.id
        AND elh.action_type = 'logout'
    ) AS logout_data ON true
    WHERE (p_search_term IS NULL
      OR u.username ILIKE '%' || p_search_term || '%'
      OR u.employee_id ILIKE '%' || p_search_term || '%'
      OR login_data.latest_login_ip ILIKE '%' || p_search_term || '%'
      OR logout_data.latest_logout_ip ILIKE '%' || p_search_term || '%')
      AND (owner_admin.role IS NULL OR owner_admin.role != 'emergency_admin')
    ORDER BY u.is_pinned DESC, u.username;
  ELSE
    RETURN QUERY
    SELECT
      u.id AS user_id,
      u.username,
      u.employee_id,
      u.is_active,
      COALESCE(u.is_pinned, false) AS is_pinned,
      u.created_by,
      login_data.latest_login_time,
      login_data.latest_login_ip,
      login_data.latest_login_device_info,
      login_data.latest_login_user_agent,
      logout_data.latest_logout_time,
      logout_data.latest_logout_ip,
      COALESCE(login_data.total_logins, 0) AS total_logins
    FROM public.users AS u
    LEFT JOIN LATERAL (
      SELECT
        MAX(elh.created_at) AS latest_login_time,
        (
          SELECT login_event.ip_address
          FROM public.employee_login_history AS login_event
          WHERE login_event.user_id = u.id
            AND login_event.action_type = 'login'
          ORDER BY login_event.created_at DESC
          LIMIT 1
        ) AS latest_login_ip,
        (
          SELECT login_event.device_info
          FROM public.employee_login_history AS login_event
          WHERE login_event.user_id = u.id
            AND login_event.action_type = 'login'
          ORDER BY login_event.created_at DESC
          LIMIT 1
        ) AS latest_login_device_info,
        (
          SELECT login_event.user_agent
          FROM public.employee_login_history AS login_event
          WHERE login_event.user_id = u.id
            AND login_event.action_type = 'login'
          ORDER BY login_event.created_at DESC
          LIMIT 1
        ) AS latest_login_user_agent,
        COUNT(*) AS total_logins
      FROM public.employee_login_history AS elh
      WHERE elh.user_id = u.id
        AND elh.action_type = 'login'
    ) AS login_data ON true
    LEFT JOIN LATERAL (
      SELECT
        MAX(elh.created_at) AS latest_logout_time,
        (
          SELECT logout_event.ip_address
          FROM public.employee_login_history AS logout_event
          WHERE logout_event.user_id = u.id
            AND logout_event.action_type = 'logout'
          ORDER BY logout_event.created_at DESC
          LIMIT 1
        ) AS latest_logout_ip
      FROM public.employee_login_history AS elh
      WHERE elh.user_id = u.id
        AND elh.action_type = 'logout'
    ) AS logout_data ON true
    WHERE u.created_by = v_admin_id
      AND (p_search_term IS NULL
        OR u.username ILIKE '%' || p_search_term || '%'
        OR u.employee_id ILIKE '%' || p_search_term || '%'
        OR login_data.latest_login_ip ILIKE '%' || p_search_term || '%'
        OR logout_data.latest_logout_ip ILIKE '%' || p_search_term || '%')
    ORDER BY u.is_pinned DESC, u.username;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_employee_login_history_with_device_info(
  p_admin_id uuid,
  p_user_id uuid,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  action_type text,
  ip_address text,
  user_agent text,
  session_id text,
  created_at timestamptz,
  device_info jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_employee_admin_id uuid;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 10000);
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_id) context;

  SELECT u.created_by
  INTO v_employee_admin_id
  FROM public.users AS u
  WHERE u.id = p_user_id;

  IF v_employee_admin_id IS NULL THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;

  IF v_admin_role != 'super_admin' AND v_employee_admin_id != v_admin_id THEN
    RAISE EXCEPTION 'Permission denied: You can only view login history for your own employees';
  END IF;

  IF v_admin_role = 'super_admin' AND EXISTS (
    SELECT 1
    FROM public.admins AS owner_admin
    WHERE owner_admin.id = v_employee_admin_id
      AND owner_admin.role = 'emergency_admin'
  ) THEN
    RAISE EXCEPTION 'Permission denied: Cannot access emergency admin data';
  END IF;

  RETURN QUERY
  SELECT
    elh.id,
    elh.action_type,
    elh.ip_address,
    elh.user_agent,
    elh.session_id,
    elh.created_at,
    elh.device_info
  FROM public.employee_login_history AS elh
  WHERE elh.user_id = p_user_id
  ORDER BY elh.created_at DESC
  LIMIT v_limit
  OFFSET v_offset;
END;
$function$;

DROP POLICY IF EXISTS "Allow read access for custom auth" ON public.employee_login_history;
DROP POLICY IF EXISTS "Admins can view all login history" ON public.employee_login_history;
REVOKE SELECT ON TABLE public.employee_login_history FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_employee_login_summary(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_login_history(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_login_history_with_device_info(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_login_summary(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_login_history_with_device_info(uuid, uuid, integer, integer) TO anon, authenticated;

COMMENT ON FUNCTION public.get_employee_login_summary(uuid, text) IS
  'Returns login summaries within the administrator scope derived from the financial session token passed through p_admin_id.';
COMMENT ON FUNCTION public.get_employee_login_history_with_device_info(uuid, uuid, integer, integer) IS
  'Returns one employee login history after deriving administrator scope from the financial session token passed through p_admin_id.';
