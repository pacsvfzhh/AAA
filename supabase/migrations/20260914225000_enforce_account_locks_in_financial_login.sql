CREATE OR REPLACE FUNCTION create_admin_financial_session(
  p_username text,
  p_password text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_admin admins%ROWTYPE;
  v_attempt financial_login_attempts%ROWTYPE;
  v_password_hash text;
  v_external_lock_until timestamptz;
  v_token uuid;
BEGIN
  IF p_username IS NULL OR length(trim(p_username)) = 0 OR p_password IS NULL OR length(p_password) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid credentials');
  END IF;

  SELECT lock_until
  INTO v_external_lock_until
  FROM account_locks
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
  FROM financial_login_attempts
  WHERE account_type = 'admin'
    AND username = trim(p_username)
  FOR UPDATE;

  IF FOUND AND v_attempt.locked_until IS NOT NULL AND v_attempt.locked_until > now() THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Account is temporarily locked.',
      'locked_until', v_attempt.locked_until
    );
  END IF;

  SELECT a.*
  INTO v_admin
  FROM admins a
  JOIN financial_admin_credentials credentials ON credentials.admin_id = a.id
  WHERE a.username = trim(p_username)
    AND a.is_active = true
    AND a.role IN ('super_admin', 'secondary_admin', 'emergency_admin')
  LIMIT 1;

  IF FOUND THEN
    SELECT password_hash
    INTO v_password_hash
    FROM financial_admin_credentials
    WHERE admin_id = v_admin.id;
  END IF;

  IF v_admin.id IS NULL OR NOT private.verify_bcrypt_password(p_password, v_password_hash) THEN
    INSERT INTO financial_login_attempts AS attempts (
      account_type,
      username,
      failed_attempts,
      locked_until,
      last_attempt_at
    ) VALUES (
      'admin',
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

  DELETE FROM financial_login_attempts
  WHERE account_type = 'admin'
    AND username = trim(p_username);

  v_token := gen_random_uuid();

  INSERT INTO admin_financial_sessions (admin_id, token_hash, expires_at)
  VALUES (
    v_admin.id,
    private.hash_financial_token(v_token),
    now() + interval '12 hours'
  );

  RETURN jsonb_build_object(
    'success', true,
    'session_token', v_token,
    'user', to_jsonb(v_admin) - 'password_hash'
  );
END;
$$;

CREATE OR REPLACE FUNCTION create_employee_financial_session(
  p_username text,
  p_password text,
  p_tab_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_user users%ROWTYPE;
  v_attempt financial_login_attempts%ROWTYPE;
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
  FROM account_locks
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
  FROM financial_login_attempts
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

  SELECT u.*
  INTO v_user
  FROM users u
  JOIN financial_employee_credentials credentials ON credentials.user_id = u.id
  WHERE u.username = trim(p_username)
    AND u.is_active = true
  LIMIT 1;

  IF FOUND THEN
    SELECT password_hash
    INTO v_password_hash
    FROM financial_employee_credentials
    WHERE user_id = v_user.id;
  END IF;

  IF v_user.id IS NULL OR NOT private.verify_bcrypt_password(p_password, v_password_hash) THEN
    INSERT INTO financial_login_attempts AS attempts (
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

  DELETE FROM financial_login_attempts
  WHERE account_type = 'employee'
    AND username = trim(p_username);

  v_token := gen_random_uuid();
  v_session_marker := gen_random_uuid();

  UPDATE employee_financial_sessions
  SET revoked_at = now()
  WHERE user_id = v_user.id
    AND revoked_at IS NULL;

  INSERT INTO employee_financial_sessions (
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

  UPDATE users
  SET current_session_token = v_session_marker,
      current_tab_id = p_tab_id,
      session_created_at = now()
  WHERE id = v_user.id
  RETURNING * INTO v_user;

  RETURN jsonb_build_object(
    'success', true,
    'session_token', v_token,
    'session_marker', v_session_marker,
    'user', to_jsonb(v_user) - 'password_hash'
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION create_admin_financial_session(text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION create_employee_financial_session(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_admin_financial_session(text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION create_employee_financial_session(text, text, text) TO anon, authenticated;
