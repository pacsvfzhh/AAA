DROP FUNCTION IF EXISTS public.get_employee_login_summary(uuid, text);

CREATE FUNCTION public.get_employee_login_summary(
  p_admin_id uuid,
  p_search_term text DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  username text,
  employee_id text,
  is_active boolean,
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
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_role text;
BEGIN
  SELECT a.role
  INTO v_admin_role
  FROM public.admins AS a
  WHERE a.id = p_admin_id
    AND a.is_active = true;

  IF v_admin_role IS NULL THEN
    RAISE EXCEPTION 'Admin not found or inactive';
  END IF;

  IF v_admin_role = 'super_admin' THEN
    RETURN QUERY
    SELECT
      u.id AS user_id,
      u.username,
      u.employee_id,
      u.is_active,
      u.created_by,
      login_data.latest_login_time,
      login_data.latest_login_ip,
      login_data.latest_login_device_info,
      login_data.latest_login_user_agent,
      logout_data.latest_logout_time,
      logout_data.latest_logout_ip,
      COALESCE(login_data.total_logins, 0) AS total_logins
    FROM public.users AS u
    LEFT JOIN public.admins AS a ON a.id = u.created_by
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
      OR u.employee_id ILIKE '%' || p_search_term || '%')
      AND (a.role IS NULL OR a.role != 'emergency_admin')
    ORDER BY u.username;
  ELSE
    RETURN QUERY
    SELECT
      u.id AS user_id,
      u.username,
      u.employee_id,
      u.is_active,
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
    WHERE u.created_by = p_admin_id
      AND (p_search_term IS NULL
        OR u.username ILIKE '%' || p_search_term || '%'
        OR u.employee_id ILIKE '%' || p_search_term || '%')
    ORDER BY u.username;
  END IF;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_employee_login_summary(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_login_summary(uuid, text) TO anon, authenticated;

COMMENT ON FUNCTION public.get_employee_login_summary(uuid, text) IS
  'Returns employee login summary with latest login IP, timestamp, structured device information, and User-Agent fallback evidence.';
