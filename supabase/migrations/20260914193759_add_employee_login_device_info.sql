/*
  Store structured, non-identifying device information alongside login history.
  Existing RPC signatures remain unchanged for older clients.
*/

ALTER TABLE public.employee_login_history
  ADD COLUMN IF NOT EXISTS device_info jsonb;

CREATE OR REPLACE FUNCTION public.log_employee_login_with_device_info(
  p_user_id uuid,
  p_username text,
  p_employee_id text,
  p_ip_address text,
  p_user_agent text DEFAULT NULL::text,
  p_session_id text DEFAULT NULL::text,
  p_device_info jsonb DEFAULT NULL::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_log_id uuid;
  v_headers jsonb;
  v_server_ip text;
  v_final_ip text;
BEGIN
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;

  IF v_headers IS NOT NULL THEN
    v_server_ip := split_part(COALESCE(v_headers ->> 'x-forwarded-for', ''), ',', 1);
    v_server_ip := NULLIF(trim(v_server_ip), '');
    IF v_server_ip IS NULL THEN
      v_server_ip := NULLIF(trim(COALESCE(v_headers ->> 'x-real-ip', '')), '');
    END IF;
  END IF;

  v_final_ip := COALESCE(
    v_server_ip,
    NULLIF(trim(COALESCE(p_ip_address, '')), ''),
    'Unknown'
  );

  INSERT INTO public.employee_login_history (
    user_id,
    username,
    employee_id,
    action_type,
    ip_address,
    user_agent,
    session_id,
    device_info
  ) VALUES (
    p_user_id,
    p_username,
    p_employee_id,
    'login',
    v_final_ip,
    p_user_agent,
    p_session_id,
    p_device_info
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.log_employee_logout_with_device_info(
  p_user_id uuid,
  p_username text,
  p_employee_id text,
  p_ip_address text,
  p_user_agent text DEFAULT NULL::text,
  p_session_id text DEFAULT NULL::text,
  p_device_info jsonb DEFAULT NULL::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_log_id uuid;
  v_headers jsonb;
  v_server_ip text;
  v_final_ip text;
BEGIN
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;

  IF v_headers IS NOT NULL THEN
    v_server_ip := split_part(COALESCE(v_headers ->> 'x-forwarded-for', ''), ',', 1);
    v_server_ip := NULLIF(trim(v_server_ip), '');
    IF v_server_ip IS NULL THEN
      v_server_ip := NULLIF(trim(COALESCE(v_headers ->> 'x-real-ip', '')), '');
    END IF;
  END IF;

  v_final_ip := COALESCE(
    v_server_ip,
    NULLIF(trim(COALESCE(p_ip_address, '')), ''),
    'Unknown'
  );

  INSERT INTO public.employee_login_history (
    user_id,
    username,
    employee_id,
    action_type,
    ip_address,
    user_agent,
    session_id,
    device_info
  ) VALUES (
    p_user_id,
    p_username,
    p_employee_id,
    'logout',
    v_final_ip,
    p_user_agent,
    p_session_id,
    p_device_info
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
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
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin_role text;
  v_employee_admin_id uuid;
BEGIN
  SELECT a.role INTO v_admin_role
  FROM public.admins AS a
  WHERE a.id = p_admin_id
    AND a.is_active = true;

  IF v_admin_role IS NULL THEN
    RAISE EXCEPTION 'Admin not found or inactive';
  END IF;

  SELECT u.created_by INTO v_employee_admin_id
  FROM public.users AS u
  WHERE u.id = p_user_id;

  IF v_employee_admin_id IS NULL THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;

  IF v_admin_role != 'super_admin' AND v_employee_admin_id != p_admin_id THEN
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
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.log_employee_login_with_device_info(uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_employee_logout_with_device_info(uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_employee_login_history_with_device_info(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.log_employee_login_with_device_info(uuid, text, text, text, text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_employee_logout_with_device_info(uuid, text, text, text, text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_login_history_with_device_info(uuid, uuid, integer, integer) TO anon, authenticated;

COMMENT ON COLUMN public.employee_login_history.device_info IS
  'Best-effort browser-reported OS, device type/model, and browser metadata; not an identity or authentication signal.';
