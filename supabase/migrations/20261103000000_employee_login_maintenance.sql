CREATE TABLE private.employee_login_maintenance (
  owner_admin_id uuid PRIMARY KEY REFERENCES public.admins(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE private.employee_login_maintenance_confirmations (
  admin_id uuid PRIMARY KEY REFERENCES public.admins(id) ON DELETE CASCADE,
  failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until timestamptz
);

CREATE TABLE private.employee_login_maintenance_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_admin_id uuid NOT NULL,
  actor_admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE private.employee_login_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.employee_login_maintenance_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.employee_login_maintenance_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.employee_login_maintenance, private.employee_login_maintenance_confirmations,
  private.employee_login_maintenance_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE private.employee_login_maintenance_events_id_seq FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.get_employee_login_maintenance(
  p_admin_session_token uuid,
  p_owner_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_setting private.employee_login_maintenance%ROWTYPE;
BEGIN
  SELECT context.admin_id, context.admin_role INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF p_owner_admin_id IS NULL OR (v_admin_role <> 'super_admin' AND p_owner_admin_id <> v_admin_id) THEN
    RAISE EXCEPTION 'Permission denied for this administrator group.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_owner_admin_id AND role IN ('super_admin', 'secondary_admin')) THEN
    RAISE EXCEPTION 'Administrator group is not available.';
  END IF;

  SELECT * INTO v_setting FROM private.employee_login_maintenance WHERE owner_admin_id = p_owner_admin_id;
  RETURN jsonb_build_object('owner_admin_id', p_owner_admin_id, 'enabled', coalesce(v_setting.enabled, false),
    'updated_at', v_setting.updated_at);
END;
$$;

CREATE FUNCTION public.set_employee_login_maintenance(
  p_admin_session_token uuid,
  p_owner_admin_id uuid,
  p_admin_password text,
  p_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_hash text;
  v_attempt private.employee_login_maintenance_confirmations%ROWTYPE;
  v_failures integer;
  v_until timestamptz;
  v_setting private.employee_login_maintenance%ROWTYPE;
BEGIN
  SELECT context.admin_id, context.admin_role INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF p_owner_admin_id IS NULL OR (v_admin_role <> 'super_admin' AND p_owner_admin_id <> v_admin_id) THEN
    RAISE EXCEPTION 'Permission denied for this administrator group.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.admins WHERE id = p_owner_admin_id AND role IN ('super_admin', 'secondary_admin')) THEN
    RAISE EXCEPTION 'Administrator group is not available.';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'Maintenance state must not be null.';
  END IF;

  INSERT INTO private.employee_login_maintenance_confirmations(admin_id) VALUES (v_admin_id)
  ON CONFLICT (admin_id) DO NOTHING;
  SELECT * INTO v_attempt FROM private.employee_login_maintenance_confirmations
  WHERE admin_id = v_admin_id FOR UPDATE;
  IF v_attempt.locked_until > now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'confirmation_locked', 'locked_until', v_attempt.locked_until);
  END IF;

  SELECT password_hash INTO v_hash FROM public.financial_admin_credentials WHERE admin_id = v_admin_id;
  IF NOT private.verify_bcrypt_password(p_admin_password, v_hash) THEN
    v_failures := CASE WHEN v_attempt.locked_until IS NOT NULL THEN 0 ELSE v_attempt.failed_attempts END + 1;
    v_until := CASE WHEN v_failures >= 5 THEN now() + interval '15 minutes' ELSE NULL END;
    UPDATE private.employee_login_maintenance_confirmations
    SET failed_attempts = v_failures, locked_until = v_until WHERE admin_id = v_admin_id;
    RETURN jsonb_build_object('success', false, 'error', CASE WHEN v_until IS NULL THEN 'invalid_password' ELSE 'confirmation_locked' END,
      'locked_until', v_until);
  END IF;

  UPDATE private.employee_login_maintenance_confirmations SET failed_attempts = 0, locked_until = NULL WHERE admin_id = v_admin_id;
  INSERT INTO private.employee_login_maintenance(owner_admin_id, enabled, updated_by)
  VALUES (p_owner_admin_id, p_enabled, v_admin_id)
  ON CONFLICT (owner_admin_id) DO UPDATE
  SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()
  RETURNING * INTO v_setting;
  INSERT INTO private.employee_login_maintenance_events(owner_admin_id, actor_admin_id, enabled)
  VALUES (p_owner_admin_id, v_admin_id, p_enabled);

  RETURN jsonb_build_object('success', true, 'owner_admin_id', p_owner_admin_id, 'enabled', v_setting.enabled,
    'updated_at', v_setting.updated_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.create_employee_financial_session(
  p_username text,
  p_password text,
  p_tab_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
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

  IF EXISTS (
    SELECT 1 FROM private.employee_login_maintenance
    WHERE owner_admin_id = v_user.created_by AND enabled
  ) THEN
    RETURN jsonb_build_object('success', false, 'code', 'employee_login_maintenance');
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

REVOKE ALL ON FUNCTION public.get_employee_login_maintenance(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_employee_login_maintenance(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_employee_financial_session(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_login_maintenance(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_employee_login_maintenance(uuid, uuid, text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_employee_financial_session(text, text, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
