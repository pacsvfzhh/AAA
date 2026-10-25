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

  -- Keep the team lock before financial/user locks to avoid lock inversion.
  PERFORM pg_advisory_xact_lock(hashtextextended('employee-maintenance:' || p_owner_admin_id::text, 0));

  UPDATE private.employee_login_maintenance_confirmations SET failed_attempts = 0, locked_until = NULL WHERE admin_id = v_admin_id;
  INSERT INTO private.employee_login_maintenance(owner_admin_id, enabled, updated_by)
  VALUES (p_owner_admin_id, p_enabled, v_admin_id)
  ON CONFLICT (owner_admin_id) DO UPDATE
  SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()
  RETURNING * INTO v_setting;

  IF p_enabled THEN
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

CREATE OR REPLACE FUNCTION public.recover_employee_dispatch_assignment_secure(
  p_user_id uuid, p_session_token uuid, p_tab_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_candidate record;
  v_assignment record;
  v_existing_session record;
  v_submitted_order record;
  v_session jsonb;
  v_timeout_minutes integer;
BEGIN
  PERFORM 1
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id AND employee.is_active = true
  FOR UPDATE OF financial_session, employee;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  SELECT assignment.id, assignment.status, assignment.accepted_at, assignment.assigned_at,
         assignment.accept_deadline_at, assignment.dispatch_session_id,
         assignment.assignment_id, assignment.order_submitted,
         COALESCE(assignment.session_timeout_minutes_snapshot,
                  dispatch_group.session_timeout_minutes, 10) AS session_timeout_minutes
  INTO v_candidate
  FROM public.dispatch_assignments AS assignment
  LEFT JOIN public.dispatch_group_orders AS dispatch_order
    ON dispatch_order.id = assignment.dispatch_order_id
  LEFT JOIN public.dispatch_groups AS dispatch_group
    ON dispatch_group.id = COALESCE(assignment.group_id, dispatch_order.group_id)
  WHERE assignment.user_id = p_user_id AND assignment.status IN ('pending', 'accepted')
  ORDER BY assignment.assigned_at DESC LIMIT 1;

  IF v_candidate.id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.employee_financial_sessions AS maintenance_session
    JOIN private.employee_work_stop_markers AS stop_marker
      ON stop_marker.user_id = maintenance_session.user_id
    WHERE maintenance_session.user_id = p_user_id
      AND maintenance_session.revoked_at IS NOT NULL
      AND maintenance_session.maintenance_revoked_at IS NOT NULL
      AND v_candidate.assigned_at <= maintenance_session.maintenance_revoked_at
      AND stop_marker.stopped_at >= maintenance_session.maintenance_revoked_at
  ) THEN
    RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
  END IF;

  IF v_candidate.id IS NULL THEN
    SELECT dispatch_session.id, dispatch_session.started_at,
           dispatch_session.consecutive_unaccepted_count
    INTO v_existing_session
    FROM public.dispatch_sessions AS dispatch_session
    WHERE dispatch_session.user_id = p_user_id
      AND dispatch_session.last_activity_at >= now() - interval '2 minutes'
      AND ((dispatch_session.status = 'online' AND dispatch_session.ended_at IS NULL)
           OR (dispatch_session.status = 'offline'
               AND dispatch_session.ended_at >= now() - interval '30 seconds'
               AND NOT EXISTS (
                 SELECT 1 FROM private.employee_work_stop_markers AS stop_marker
                 WHERE stop_marker.user_id = dispatch_session.user_id
                   AND stop_marker.stopped_at >= dispatch_session.ended_at)))
    ORDER BY dispatch_session.started_at DESC, dispatch_session.id DESC LIMIT 1;
    IF v_existing_session.id IS NULL THEN
      PERFORM public.stop_employee_dispatch_session_secure(
        p_user_id, p_session_token, p_tab_id, NULL);
      RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
    END IF;
    v_session := public.resume_employee_dispatch_session_secure(
      p_user_id, p_session_token, p_tab_id, v_existing_session.id);
    RETURN jsonb_build_object(
      'success', true, 'recovered', true, 'session_id', v_session->>'session_id',
      'started_at', v_session->>'started_at',
      'unaccepted_count', COALESCE((v_session->>'unaccepted_count')::integer, 0),
      'assignment', NULL);
  END IF;

  IF v_candidate.status = 'pending'
     AND COALESCE(v_candidate.accept_deadline_at, now()) <= now() THEN
    IF v_candidate.dispatch_session_id IS NOT NULL THEN
      PERFORM public.expire_pending_dispatch_assignment_secure(
        p_user_id, p_session_token, p_tab_id,
        v_candidate.dispatch_session_id, v_candidate.id);
    ELSE
      UPDATE public.dispatch_assignments
      SET status = 'cancelled', completed_at = clock_timestamp(),
          remarks = 'Auto-cancelled: server accept deadline reached before recovery'
      WHERE id = v_candidate.id AND user_id = p_user_id AND status = 'pending';
    END IF;
    PERFORM public.stop_employee_dispatch_session_secure(
      p_user_id, p_session_token, p_tab_id, NULL);
    RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
  END IF;

  v_timeout_minutes := GREATEST(COALESCE(v_candidate.session_timeout_minutes, 10), 1);
  IF v_candidate.status = 'accepted' THEN
    SELECT submitted_order.id, submitted_order.status,
           submitted_order.created_at, submitted_order.processed_at
    INTO v_submitted_order
    FROM public.orders AS submitted_order
    WHERE submitted_order.assignment_id = v_candidate.assignment_id
    ORDER BY CASE WHEN submitted_order.status IN ('success', 'failure', 'error') THEN 0 ELSE 1 END,
             submitted_order.created_at DESC NULLS LAST, submitted_order.id DESC
    LIMIT 1;

    IF v_submitted_order.status IN ('success', 'failure', 'error') THEN
      UPDATE public.dispatch_assignments
      SET status = CASE WHEN v_submitted_order.status = 'success' THEN 'completed' ELSE 'error' END,
          completed_at = COALESCE(v_submitted_order.processed_at, now()),
          remarks = CASE WHEN v_submitted_order.status = 'success'
                         THEN 'Auto-completed from processed order result'
                         ELSE 'Auto-marked error from processed order result' END
      WHERE id = v_candidate.id AND user_id = p_user_id AND status = 'accepted';
      PERFORM public.stop_employee_dispatch_session_secure(
        p_user_id, p_session_token, p_tab_id, NULL);
      RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
    ELSIF v_candidate.order_submitted = true OR v_submitted_order.id IS NOT NULL THEN
      IF COALESCE(v_submitted_order.created_at, v_candidate.accepted_at)
         < now() - interval '30 minutes' THEN
        UPDATE public.dispatch_assignments
        SET status = 'timeout', completed_at = clock_timestamp(),
            remarks = 'Auto-timeout: submitted order did not produce a final result within 30 minutes'
        WHERE id = v_candidate.id AND user_id = p_user_id AND status = 'accepted'
          AND (order_submitted = true OR EXISTS (
            SELECT 1 FROM public.orders AS submitted_order
            WHERE submitted_order.assignment_id = v_candidate.assignment_id
          ))
          AND NOT EXISTS (
            SELECT 1 FROM public.orders AS submitted_order
            WHERE submitted_order.assignment_id = v_candidate.assignment_id
              AND submitted_order.status IN ('success', 'failure', 'error')
          );
        IF FOUND THEN
          PERFORM public.stop_employee_dispatch_session_secure(
            p_user_id, p_session_token, p_tab_id, NULL);
          RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
        END IF;
      END IF;
    ELSIF v_candidate.accepted_at IS NULL OR
          v_candidate.accepted_at + make_interval(mins => v_timeout_minutes) <= now() THEN
      UPDATE public.dispatch_assignments
      SET status = 'timeout', completed_at = clock_timestamp(),
          remarks = 'Auto-timeout: accepted assignment expired before recovery'
      WHERE id = v_candidate.id AND user_id = p_user_id AND status = 'accepted'
        AND order_submitted = false
        AND NOT EXISTS (
          SELECT 1 FROM public.orders AS submitted_order
          WHERE submitted_order.assignment_id = v_candidate.assignment_id
        );
      IF FOUND THEN
        PERFORM public.stop_employee_dispatch_session_secure(
          p_user_id, p_session_token, p_tab_id, NULL);
        RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
      END IF;
    END IF;
  END IF;

  IF v_candidate.dispatch_session_id IS NOT NULL THEN
    v_session := public.resume_employee_dispatch_session_secure(
      p_user_id, p_session_token, p_tab_id, v_candidate.dispatch_session_id);
  ELSE
    v_session := public.start_employee_dispatch_session_secure(
      p_user_id, p_session_token, p_tab_id);
  END IF;
  SELECT assignment.id, assignment.dispatch_order_id, assignment.user_id,
         assignment.status, assignment.assigned_at, assignment.accepted_at,
         assignment.completed_at, assignment.remarks, assignment.assignment_id,
         assignment.order_submitted, assignment.accept_deadline_at,
         COALESCE(assignment.order_content_snapshot, dispatch_order.order_content) AS order_content,
         COALESCE(assignment.session_timeout_minutes_snapshot,
                  dispatch_group.session_timeout_minutes, 10) AS session_timeout_minutes
  INTO v_assignment
  FROM public.dispatch_assignments AS assignment
  LEFT JOIN public.dispatch_group_orders AS dispatch_order
    ON dispatch_order.id = assignment.dispatch_order_id
  LEFT JOIN public.dispatch_groups AS dispatch_group
    ON dispatch_group.id = COALESCE(assignment.group_id, dispatch_order.group_id)
  WHERE assignment.id = v_candidate.id AND assignment.user_id = p_user_id
    AND ((assignment.status = 'pending' AND assignment.accept_deadline_at > now())
         OR (assignment.status = 'accepted'
             AND NOT EXISTS (
               SELECT 1 FROM public.orders AS submitted_order
               WHERE submitted_order.assignment_id = assignment.assignment_id
                 AND submitted_order.status IN ('success', 'failure', 'error')
             )
             AND (
               (assignment.order_submitted = false
                AND NOT EXISTS (
                  SELECT 1 FROM public.orders AS submitted_order
                  WHERE submitted_order.assignment_id = assignment.assignment_id
                )
                AND assignment.accepted_at + make_interval(mins => GREATEST(
                  COALESCE(assignment.session_timeout_minutes_snapshot,
                           dispatch_group.session_timeout_minutes, 10), 1)) > now())
               OR ((assignment.order_submitted = true OR EXISTS (
                      SELECT 1 FROM public.orders AS submitted_order
                      WHERE submitted_order.assignment_id = assignment.assignment_id
                    ))
                   AND COALESCE((
                     SELECT MAX(submitted_order.created_at)
                     FROM public.orders AS submitted_order
                     WHERE submitted_order.assignment_id = assignment.assignment_id
                   ), assignment.accepted_at) >= now() - interval '30 minutes')
             )))
  FOR UPDATE OF assignment;
  IF v_assignment.id IS NULL THEN
    PERFORM public.stop_employee_dispatch_session_secure(
      p_user_id, p_session_token, p_tab_id, NULLIF(v_session->>'session_id', '')::uuid);
    RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
  END IF;
  UPDATE public.dispatch_assignments
  SET dispatch_session_id = NULLIF(v_session->>'session_id', '')::uuid
  WHERE id = v_assignment.id;
  RETURN jsonb_build_object(
    'success', true, 'recovered', true,
    'session_id', v_session->>'session_id', 'started_at', v_session->>'started_at',
    'unaccepted_count', COALESCE((v_session->>'unaccepted_count')::integer, 0),
    'assignment', jsonb_build_object(
      'id', v_assignment.id, 'dispatch_order_id', v_assignment.dispatch_order_id,
      'user_id', v_assignment.user_id, 'status', v_assignment.status,
      'assigned_at', v_assignment.assigned_at, 'accepted_at', v_assignment.accepted_at,
      'completed_at', v_assignment.completed_at, 'remarks', v_assignment.remarks,
      'assignment_id', v_assignment.assignment_id, 'order_submitted', v_assignment.order_submitted,
      'accept_deadline_at', v_assignment.accept_deadline_at,
      'dispatch_session_id', v_session->>'session_id',
      'dispatch_orders', jsonb_build_object('order_content', v_assignment.order_content),
      'session_timeout_minutes', v_assignment.session_timeout_minutes));
END;
$function$;

REVOKE ALL ON FUNCTION public.recover_employee_dispatch_assignment_secure(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_employee_dispatch_assignment_secure(uuid, uuid, text)
  TO anon, authenticated;

CREATE FUNCTION private.guard_employee_maintenance_submission()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_owner_admin_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'used_order_data' THEN
    IF EXISTS (
      SELECT 1 FROM public.orders AS accepted_order
      WHERE accepted_order.id = NEW.order_id AND accepted_order.user_id = NEW.user_id
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

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
