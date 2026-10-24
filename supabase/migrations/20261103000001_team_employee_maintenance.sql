-- Extends the preceding, undeployed login-maintenance migration without changing it.
ALTER TABLE public.employee_financial_sessions
  ADD COLUMN maintenance_revoked_at timestamptz;
REVOKE ALL (maintenance_revoked_at) ON public.employee_financial_sessions
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_employee_login_maintenance(
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
  v_stopped_at timestamptz;
  v_user record;
  v_dispatch_session record;
  v_work_session record;
  v_work_session_id uuid;
  v_work_start timestamptz;
  v_work_heartbeat timestamptz;
  v_end_time timestamptz;
  v_affected_employees integer := 0;
  v_stopped_sessions integer := 0;
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

  -- Login and direct submissions take this team's shared lock before touching
  -- employee/financial rows. Work RPCs already lock those rows and must NOT take
  -- the shared lock afterwards (that would invert this lock order).
  PERFORM pg_advisory_xact_lock(hashtextextended('employee-maintenance:' || p_owner_admin_id::text, 0));

  UPDATE private.employee_login_maintenance_confirmations SET failed_attempts = 0, locked_until = NULL WHERE admin_id = v_admin_id;
  INSERT INTO private.employee_login_maintenance(owner_admin_id, enabled, updated_by)
  VALUES (p_owner_admin_id, p_enabled, v_admin_id)
  ON CONFLICT (owner_admin_id) DO UPDATE
  SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()
  RETURNING * INTO v_setting;

  IF p_enabled THEN
    -- Wait for in-flight secure work RPCs before stopping work. A subsequent RPC
    -- cannot authenticate these sessions, even after maintenance is disabled.
    UPDATE public.employee_financial_sessions AS financial_session
    SET revoked_at = clock_timestamp(), maintenance_revoked_at = clock_timestamp()
    FROM public.users AS employee
    WHERE financial_session.user_id = employee.id
      AND employee.created_by = p_owner_admin_id
      AND financial_session.revoked_at IS NULL;

    v_stopped_at := clock_timestamp();
    FOR v_user IN
      SELECT id FROM public.users
      WHERE created_by = p_owner_admin_id
      ORDER BY id FOR UPDATE
    LOOP
      v_affected_employees := v_affected_employees + 1;
      UPDATE public.users SET current_session_token = NULL, current_tab_id = NULL
      WHERE id = v_user.id;

      -- Same heartbeat cutoff as stop_employee_dispatch_session_secure: stale
      -- work ends at heartbeat + 1 minute, otherwise at the server stop time.
      FOR v_dispatch_session IN
        SELECT id, started_at, last_activity_at FROM public.dispatch_sessions
        WHERE user_id = v_user.id AND status = 'online' AND ended_at IS NULL
        ORDER BY started_at, id FOR UPDATE
      LOOP
        SELECT id, start_time, last_heartbeat_at
        INTO v_work_session_id, v_work_start, v_work_heartbeat
        FROM public.work_sessions
        WHERE user_id = v_user.id AND end_time IS NULL
        ORDER BY start_time DESC, id DESC LIMIT 1 FOR UPDATE;

        IF v_work_session_id IS NOT NULL THEN
          v_end_time := CASE
            WHEN v_work_heartbeat IS NOT NULL AND v_work_heartbeat < v_stopped_at - interval '2 minutes'
            THEN GREATEST(v_work_heartbeat + interval '1 minute', v_work_start)
            ELSE GREATEST(v_stopped_at, v_work_start)
          END;
        ELSE
          v_end_time := CASE
            WHEN v_dispatch_session.last_activity_at IS NOT NULL
              AND v_dispatch_session.last_activity_at < v_stopped_at - interval '2 minutes'
            THEN GREATEST(v_dispatch_session.last_activity_at + interval '1 minute', v_dispatch_session.started_at)
            ELSE GREATEST(v_stopped_at, v_dispatch_session.started_at)
          END;
        END IF;

        UPDATE public.dispatch_sessions SET status = 'offline', ended_at = v_end_time
        WHERE id = v_dispatch_session.id AND status = 'online' AND ended_at IS NULL;
        IF FOUND THEN
          v_stopped_sessions := v_stopped_sessions + 1;
        END IF;
        IF v_work_session_id IS NOT NULL THEN
          -- Also set the duration explicitly: the legacy dispatch sync trigger
          -- may already have ended this work row using approximate start times.
          UPDATE public.work_sessions
          SET end_time = v_end_time,
              duration_minutes = GREATEST(round(extract(epoch FROM (v_end_time - v_work_start)) / 60)::integer, 0)
          WHERE id = v_work_session_id;
        END IF;
      END LOOP;

      FOR v_work_session IN
        SELECT id, start_time, last_heartbeat_at FROM public.work_sessions
        WHERE user_id = v_user.id AND end_time IS NULL
        ORDER BY start_time, id FOR UPDATE
      LOOP
        v_end_time := CASE
          WHEN v_work_session.last_heartbeat_at IS NOT NULL
            AND v_work_session.last_heartbeat_at < v_stopped_at - interval '2 minutes'
          THEN GREATEST(v_work_session.last_heartbeat_at + interval '1 minute', v_work_session.start_time)
          ELSE GREATEST(v_stopped_at, v_work_session.start_time)
        END;
        UPDATE public.work_sessions
        SET end_time = v_end_time,
            duration_minutes = GREATEST(round(extract(epoch FROM (v_end_time - v_work_session.start_time)) / 60)::integer, 0)
        WHERE id = v_work_session.id;
      END LOOP;

      INSERT INTO private.employee_work_stop_markers(user_id, stopped_at)
      VALUES (v_user.id, clock_timestamp())
      ON CONFLICT (user_id) DO UPDATE
      SET stopped_at = GREATEST(private.employee_work_stop_markers.stopped_at, EXCLUDED.stopped_at);

      -- Actual orders are authoritative even if the follow-up submitted RPC did
      -- not run. Leave both submitted forms to the existing system settlement.
      UPDATE public.dispatch_assignments AS assignment
      SET status = 'cancelled', completed_at = v_stopped_at,
          remarks = 'Cancelled: employee team maintenance'
      WHERE assignment.user_id = v_user.id
        AND assignment.status IN ('pending', 'accepted')
        AND assignment.order_submitted = false
        AND NOT EXISTS (
          SELECT 1 FROM public.orders AS submitted_order
          WHERE submitted_order.assignment_id = assignment.assignment_id
        );
    END LOOP;
  END IF;

  INSERT INTO private.employee_login_maintenance_events(owner_admin_id, actor_admin_id, enabled)
  VALUES (p_owner_admin_id, v_admin_id, p_enabled);

  RETURN jsonb_build_object('success', true, 'owner_admin_id', p_owner_admin_id, 'enabled', v_setting.enabled,
    'updated_at', v_setting.updated_at, 'affected_employees', v_affected_employees, 'stopped_sessions', v_stopped_sessions);
END;
$$;

CREATE FUNCTION public.get_employee_maintenance_status(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_session record;
  v_maintenance boolean;
BEGIN
  IF p_user_id IS NULL OR p_session_token IS NULL OR p_tab_id IS NULL OR btrim(p_tab_id) = '' THEN
    RETURN jsonb_build_object('maintenance', false, 'session_valid', false);
  END IF;

  SELECT financial_session.revoked_at, financial_session.maintenance_revoked_at,
         financial_session.session_marker, employee.current_session_token,
         employee.current_tab_id, employee.is_active, employee.created_by
  INTO v_session
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.tab_id = p_tab_id
    AND financial_session.expires_at > now();

  IF NOT FOUND THEN
    RETURN jsonb_build_object('maintenance', false, 'session_valid', false);
  END IF;
  -- Only a genuine, unexpired maintenance-revoked token may bypass the current
  -- user marker check, and only here: this grants no business capabilities.
  IF v_session.maintenance_revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('maintenance', true, 'session_valid', false);
  END IF;
  IF v_session.revoked_at IS NOT NULL OR v_session.is_active IS DISTINCT FROM true
    OR v_session.session_marker IS DISTINCT FROM v_session.current_session_token
    OR v_session.current_tab_id IS DISTINCT FROM p_tab_id THEN
    RETURN jsonb_build_object('maintenance', false, 'session_valid', false);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM private.employee_login_maintenance
    WHERE owner_admin_id = v_session.created_by AND enabled
  ) INTO v_maintenance;
  RETURN jsonb_build_object('maintenance', v_maintenance, 'session_valid', NOT v_maintenance);
END;
$$;

-- Copy of the previous login definition; only the shared team lock is added
-- after password verification and before the existing maintenance check.
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

  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-maintenance:' || v_user.created_by::text, 0));

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

-- Both direct-insert tables have a real user_id FK to users. Run before the
-- order-rate snapshot trigger, which locks user/assignment rows. INSERT only:
-- existing orders must still settle during maintenance, without replaying pay.
CREATE FUNCTION private.guard_employee_maintenance_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_owner_admin_id uuid;
BEGIN
  SELECT created_by INTO v_owner_admin_id FROM public.users WHERE id = NEW.user_id;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-maintenance:' || v_owner_admin_id::text, 0));
  IF EXISTS (
    SELECT 1 FROM private.employee_login_maintenance
    WHERE owner_admin_id = v_owner_admin_id AND enabled
  ) THEN
    RAISE EXCEPTION 'employee_login_maintenance';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER employee_maintenance_submission_guard
BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION private.guard_employee_maintenance_submission();
CREATE TRIGGER employee_maintenance_submission_guard
BEFORE INSERT ON public.used_order_data
FOR EACH ROW EXECUTE FUNCTION private.guard_employee_maintenance_submission();

REVOKE ALL ON FUNCTION private.guard_employee_maintenance_submission() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_maintenance_status(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_employee_login_maintenance(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_employee_financial_session(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_maintenance_status(uuid, uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_employee_login_maintenance(uuid, uuid, text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_employee_financial_session(text, text, text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
