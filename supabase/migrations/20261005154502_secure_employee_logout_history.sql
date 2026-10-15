CREATE OR REPLACE FUNCTION public.log_employee_logout_secure(
  p_user_id uuid,
  p_financial_token uuid,
  p_tab_id text,
  p_session_id text,
  p_user_agent text,
  p_device_info jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_username text;
  v_employee_id text;
  v_log_id uuid;
  v_headers jsonb;
  v_server_ip text;
  v_final_ip text;
BEGIN
  IF p_financial_token IS NULL OR p_user_id IS NULL OR p_tab_id IS NULL
    OR p_session_id IS NULL OR btrim(p_session_id) = '' THEN
    RAISE EXCEPTION 'Invalid employee logout session.' USING ERRCODE = '28000';
  END IF;

  SELECT employee.username, employee.employee_id
  INTO v_username, v_employee_id
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_financial_token)
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker::text = p_session_id
    AND (
      (financial_session.revoked_at IS NULL AND financial_session.expires_at > now()
        AND employee.current_session_token = financial_session.session_marker
        AND employee.current_tab_id = p_tab_id AND employee.is_active = true)
      OR (financial_session.revoked_at BETWEEN now() - interval '2 minutes' AND now()
        AND financial_session.expires_at >= financial_session.revoked_at)
    )
  LIMIT 1;

  IF v_username IS NULL THEN
    RAISE EXCEPTION 'Invalid employee logout session.' USING ERRCODE = '28000';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_session_id, 0));

  SELECT history.id INTO v_log_id
  FROM public.employee_login_history AS history
  WHERE history.user_id = p_user_id
    AND history.action_type = 'logout'
    AND history.session_id = p_session_id
  ORDER BY history.created_at DESC
  LIMIT 1;

  IF v_log_id IS NOT NULL THEN
    RETURN v_log_id;
  END IF;

  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;

  IF v_headers IS NOT NULL THEN
    v_server_ip := NULLIF(trim(split_part(COALESCE(v_headers ->> 'x-forwarded-for', ''), ',', 1)), '');
    IF v_server_ip IS NULL THEN
      v_server_ip := NULLIF(trim(COALESCE(v_headers ->> 'x-real-ip', '')), '');
    END IF;
  END IF;

  v_final_ip := COALESCE(v_server_ip, 'Unknown');

  INSERT INTO public.employee_login_history (
    user_id, username, employee_id, action_type, ip_address,
    user_agent, session_id, device_info
  ) VALUES (
    p_user_id, v_username, v_employee_id, 'logout', v_final_ip,
    p_user_agent, p_session_id, p_device_info
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.log_employee_logout_secure(uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_employee_logout_secure(uuid, uuid, text, text, text, jsonb) TO anon, authenticated;

REVOKE ALL ON FUNCTION public.log_employee_logout(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_employee_logout_with_device_info(uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.employee_login_history FROM PUBLIC, anon, authenticated;
