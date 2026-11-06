BEGIN;

CREATE FUNCTION private.get_employee_dispatch_call_status(
  p_user_id uuid, p_session_token uuid, p_tab_id text, p_session_id uuid,
  p_require_fresh_activity boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $function$
DECLARE
  v_session record;
BEGIN
  IF p_tab_id IS NULL OR btrim(p_tab_id) = '' THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;
  PERFORM 1
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true
  FOR UPDATE OF financial_session, employee;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  SELECT session.status, session.ended_at, session.last_activity_at
  INTO v_session
  FROM public.dispatch_sessions AS session
  WHERE session.id = p_session_id AND session.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee work session is invalid, offline, or stale.';
  END IF;
  IF v_session.status <> 'online' OR v_session.ended_at IS NOT NULL THEN
    RETURN 'ended';
  END IF;
  IF p_require_fresh_activity AND
     (v_session.last_activity_at IS NULL OR v_session.last_activity_at < now() - interval '2 minutes') THEN
    RETURN 'stale';
  END IF;
  RETURN 'active';
END;
$function$;

REVOKE ALL ON FUNCTION private.get_employee_dispatch_call_status(uuid,uuid,text,uuid,boolean)
  FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.update_session_heartbeat_status_secure(
  p_user_id uuid, p_session_token uuid, p_tab_id text, p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $function$
DECLARE
  v_status text;
BEGIN
  v_status := private.get_employee_dispatch_call_status(
    p_user_id, p_session_token, p_tab_id, p_session_id, false);
  IF v_status <> 'active' THEN
    RETURN jsonb_build_object(
      'success', false, 'session_status', v_status, 'reason', 'work_session_ended',
      'session_id', p_session_id, 'user_id', p_user_id,
      'heartbeat_at', NULL, 'work_sessions_updated', 0);
  END IF;
  RETURN public.update_session_heartbeat_secure(p_user_id, p_session_token, p_tab_id, p_session_id);
END;
$function$;

CREATE FUNCTION public.prepare_next_dispatch_order_status_secure(
  p_user_id uuid, p_session_token uuid, p_tab_id text, p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $function$
DECLARE
  v_status text;
BEGIN
  v_status := private.get_employee_dispatch_call_status(
    p_user_id, p_session_token, p_tab_id, p_session_id, true);
  IF v_status <> 'active' THEN
    RETURN jsonb_build_object(
      'success', false, 'available', false, 'session_status', v_status,
      'server_now', clock_timestamp());
  END IF;
  RETURN public.prepare_next_dispatch_order_secure(p_user_id, p_session_token, p_tab_id, p_session_id);
END;
$function$;

CREATE FUNCTION public.assign_next_dispatch_order_status_secure(
  p_user_id uuid, p_session_token uuid, p_tab_id text, p_session_id uuid,
  p_group_id uuid, p_dispatch_mode text DEFAULT 'random'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $function$
DECLARE
  v_status text;
BEGIN
  v_status := private.get_employee_dispatch_call_status(
    p_user_id, p_session_token, p_tab_id, p_session_id, true);
  IF v_status <> 'active' THEN
    RETURN jsonb_build_object(
      'success', false, 'assignment', NULL, 'session_status', v_status,
      'server_now', clock_timestamp());
  END IF;
  RETURN public.assign_next_dispatch_order_secure(
    p_user_id, p_session_token, p_tab_id, p_session_id, p_group_id, p_dispatch_mode);
END;
$function$;

REVOKE ALL ON FUNCTION public.update_session_heartbeat_status_secure(uuid,uuid,text,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_next_dispatch_order_status_secure(uuid,uuid,text,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_next_dispatch_order_status_secure(uuid,uuid,text,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_session_heartbeat_status_secure(uuid,uuid,text,uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_next_dispatch_order_status_secure(uuid,uuid,text,uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_next_dispatch_order_status_secure(uuid,uuid,text,uuid,uuid,text)
  TO anon, authenticated;

COMMIT;
