CREATE OR REPLACE FUNCTION public.log_employee_login(
  p_user_id uuid,
  p_username text,
  p_employee_id text,
  p_ip_address text,
  p_user_agent text DEFAULT NULL,
  p_session_id text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_log_id uuid;
  v_headers jsonb;
  v_server_ip text;
  v_final_ip text;
BEGIN
  IF p_session_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.users AS employee
    WHERE employee.id = p_user_id
      AND employee.username = p_username
      AND employee.employee_id = p_employee_id
      AND employee.current_session_token::text = p_session_id
      AND employee.is_active = true
  ) THEN
    RAISE EXCEPTION 'Invalid employee login session.';
  END IF;

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

  UPDATE public.employee_login_history
  SET username = p_username,
      employee_id = p_employee_id,
      ip_address = CASE
        WHEN v_final_ip = 'Unknown' THEN ip_address
        ELSE v_final_ip
      END,
      user_agent = COALESCE(p_user_agent, user_agent)
  WHERE user_id = p_user_id
    AND action_type = 'login'
    AND session_id = p_session_id
  RETURNING id INTO v_log_id;

  IF v_log_id IS NOT NULL THEN
    RETURN v_log_id;
  END IF;

  INSERT INTO public.employee_login_history (
    user_id,
    username,
    employee_id,
    action_type,
    ip_address,
    user_agent,
    session_id
  ) VALUES (
    p_user_id,
    p_username,
    p_employee_id,
    'login',
    v_final_ip,
    p_user_agent,
    p_session_id
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.log_employee_login_with_device_info(
  p_user_id uuid,
  p_username text,
  p_employee_id text,
  p_ip_address text,
  p_user_agent text DEFAULT NULL,
  p_session_id text DEFAULT NULL,
  p_device_info jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_log_id uuid;
  v_headers jsonb;
  v_server_ip text;
  v_final_ip text;
BEGIN
  IF p_session_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.users AS employee
    WHERE employee.id = p_user_id
      AND employee.username = p_username
      AND employee.employee_id = p_employee_id
      AND employee.current_session_token::text = p_session_id
      AND employee.is_active = true
  ) THEN
    RAISE EXCEPTION 'Invalid employee login session.';
  END IF;

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

  UPDATE public.employee_login_history
  SET username = p_username,
      employee_id = p_employee_id,
      ip_address = CASE
        WHEN v_final_ip = 'Unknown' THEN ip_address
        ELSE v_final_ip
      END,
      user_agent = COALESCE(p_user_agent, user_agent),
      device_info = COALESCE(p_device_info, device_info)
  WHERE user_id = p_user_id
    AND action_type = 'login'
    AND session_id = p_session_id
  RETURNING id INTO v_log_id;

  IF v_log_id IS NOT NULL THEN
    RETURN v_log_id;
  END IF;

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

CREATE OR REPLACE FUNCTION public.create_employee_financial_session(
  p_username text,
  p_password text,
  p_tab_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_user public.users%ROWTYPE;
  v_attempt public.financial_login_attempts%ROWTYPE;
  v_password_hash text;
  v_external_lock_until timestamptz;
  v_token uuid;
  v_session_marker uuid;
BEGIN
  IF p_username IS NULL OR length(trim(p_username)) = 0 OR p_password IS NULL OR length(p_password) = 0
    OR p_tab_id IS NULL OR length(trim(p_tab_id)) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid credentials');
  END IF;

  SELECT lock_until
  INTO v_external_lock_until
  FROM public.account_locks
  WHERE identifier = trim(p_username)
    AND identifier_type = 'username'
    AND lock_until > now()
    AND unlocked_at IS NULL
  ORDER BY lock_until DESC
  LIMIT 1
  FOR UPDATE;

  IF v_external_lock_until IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Account is temporarily locked.',
      'locked_until', v_external_lock_until
    );
  END IF;

  SELECT *
  INTO v_attempt
  FROM public.financial_login_attempts
  WHERE account_type = 'employee'
    AND username = trim(p_username)
  FOR UPDATE;

  IF FOUND AND v_attempt.locked_until IS NOT NULL AND v_attempt.locked_until > now() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Account is temporarily locked.',
      'locked_until', v_attempt.locked_until
    );
  END IF;

  SELECT employee.*
  INTO v_user
  FROM public.users AS employee
  JOIN public.financial_employee_credentials AS credentials
    ON credentials.user_id = employee.id
  WHERE employee.username = trim(p_username)
    AND employee.is_active = true
  LIMIT 1;

  IF FOUND THEN
    SELECT password_hash
    INTO v_password_hash
    FROM public.financial_employee_credentials
    WHERE user_id = v_user.id;
  END IF;

  IF v_user.id IS NULL OR NOT private.verify_bcrypt_password(p_password, v_password_hash) THEN
    INSERT INTO public.financial_login_attempts AS attempts (
      account_type,
      username,
      failed_attempts,
      locked_until,
      last_attempt_at
    ) VALUES (
      'employee',
      trim(p_username),
      1,
      NULL,
      now()
    )
    ON CONFLICT (account_type, username) DO UPDATE
    SET failed_attempts = attempts.failed_attempts + 1,
        locked_until = CASE
          WHEN attempts.failed_attempts + 1 >= 5 THEN now() + interval '15 minutes'
          ELSE NULL
        END,
        last_attempt_at = now();

    RETURN jsonb_build_object('success', false, 'error', 'Invalid credentials');
  END IF;

  DELETE FROM public.financial_login_attempts
  WHERE account_type = 'employee'
    AND username = trim(p_username);

  v_token := gen_random_uuid();
  v_session_marker := gen_random_uuid();

  UPDATE public.employee_financial_sessions
  SET revoked_at = now()
  WHERE user_id = v_user.id
    AND revoked_at IS NULL;

  INSERT INTO public.employee_financial_sessions (
    user_id,
    token_hash,
    tab_id,
    session_marker,
    expires_at
  ) VALUES (
    v_user.id,
    private.hash_financial_token(v_token),
    p_tab_id,
    v_session_marker,
    now() + interval '24 hours'
  );

  UPDATE public.users
  SET current_session_token = v_session_marker,
      current_tab_id = p_tab_id,
      session_created_at = now()
  WHERE id = v_user.id
  RETURNING * INTO v_user;

  PERFORM public.log_employee_login(
    v_user.id,
    v_user.username,
    v_user.employee_id,
    'Unknown',
    NULL,
    v_session_marker::text
  );

  RETURN jsonb_build_object(
    'success', true,
    'session_token', v_token,
    'session_marker', v_session_marker,
    'user', to_jsonb(v_user) - 'password_hash'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.log_employee_login(uuid, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_employee_login_with_device_info(uuid, text, text, text, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_employee_financial_session(text, text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.log_employee_login(uuid, text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_employee_login_with_device_info(uuid, text, text, text, text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_employee_financial_session(text, text, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
