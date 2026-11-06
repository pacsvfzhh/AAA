DO $preflight$
BEGIN
  IF to_regprocedure('public.recover_employee_dispatch_guarded(uuid,uuid,text,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'Guarded dispatch recovery function is missing.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc AS p
    JOIN pg_roles AS owner_role ON owner_role.oid=p.proowner
    WHERE p.oid='public.recover_employee_dispatch_guarded(uuid,uuid,text,uuid,uuid)'::regprocedure
      AND md5(p.prosrc)='4ebfc84d2053692ca7fc2233f8c4abce'
      AND owner_role.rolname='postgres'
      AND p.prosecdef
      AND p.proconfig @> ARRAY['search_path=pg_catalog, public, private, pg_temp']
      AND NOT EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS privilege
        WHERE privilege.grantee=0 AND privilege.privilege_type='EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION 'Guarded dispatch recovery definition or security metadata has drifted; refusing to replace it.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='private' AND table_name='employee_dispatch_recovery_operations'
      AND column_name='replay_order_snapshot'
  ) THEN
    RAISE EXCEPTION 'Recovery replay snapshot column already exists.';
  END IF;
END;
$preflight$;

ALTER TABLE private.employee_dispatch_recovery_operations
  ADD COLUMN replay_order_snapshot jsonb;

CREATE OR REPLACE FUNCTION public.recover_employee_dispatch_guarded(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_expected_session_id uuid,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $function$
DECLARE
  v_hash text;
  v_operation private.employee_dispatch_recovery_operations%ROWTYPE;
  v_expected record;
  v_candidate record;
  v_latest record;
  v_target record;
  v_stop timestamptz;
  v_result jsonb;
  v_replay_order_snapshot jsonb;
  v_replay_order record;
  v_replay_order_count integer;
  v_false constant jsonb := jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
BEGIN
  IF p_operation_id IS NULL OR p_tab_id IS NULL OR btrim(p_tab_id) = '' THEN
    RAISE EXCEPTION 'Invalid recovery operation.';
  END IF;
  v_hash := private.hash_financial_token(p_session_token);

  PERFORM 1
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = v_hash
    AND financial_session.revoked_at IS NULL AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id AND employee.is_active = true
  FOR UPDATE OF financial_session, employee;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  DELETE FROM private.employee_dispatch_recovery_operations AS expired_operation
  WHERE expired_operation.user_id = p_user_id
    AND expired_operation.created_at < clock_timestamp() - interval '48 hours'
    AND NOT EXISTS (
      SELECT 1 FROM public.employee_financial_sessions AS original_session
      WHERE original_session.user_id = expired_operation.user_id
        AND original_session.token_hash = expired_operation.token_hash
        AND original_session.revoked_at IS NULL
        AND original_session.expires_at > clock_timestamp()
    );

  SELECT * INTO v_operation FROM private.employee_dispatch_recovery_operations
  WHERE operation_id = p_operation_id FOR UPDATE;
  IF FOUND THEN
    IF v_operation.user_id IS DISTINCT FROM p_user_id
       OR v_operation.token_hash IS DISTINCT FROM v_hash
       OR v_operation.tab_id IS DISTINCT FROM p_tab_id
       OR v_operation.expected_session_id IS DISTINCT FROM p_expected_session_id THEN
      RAISE EXCEPTION 'Recovery operation does not match its original request.';
    END IF;
    IF COALESCE((v_operation.result->>'recovered')::boolean, false) AND NOT EXISTS (
      SELECT 1 FROM public.dispatch_sessions AS session
      WHERE session.id = NULLIF(v_operation.result->>'session_id', '')::uuid
        AND session.user_id = p_user_id AND session.status = 'online' AND session.ended_at IS NULL
        AND session.started_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM private.employee_work_stop_markers AS marker
          WHERE marker.user_id = p_user_id AND marker.stopped_at >= session.started_at)
        AND session.id = (
          SELECT latest.id FROM public.dispatch_sessions AS latest
          WHERE latest.user_id = p_user_id
          ORDER BY latest.started_at DESC, latest.id DESC LIMIT 1)
    ) THEN
      RETURN v_false;
    END IF;
    IF COALESCE((v_operation.result->>'recovered')::boolean, false) THEN
      IF v_operation.result->'assignment' = 'null'::jsonb THEN
        IF EXISTS (
          SELECT 1 FROM public.dispatch_assignments AS assignment
          WHERE assignment.user_id = p_user_id AND assignment.status IN ('pending', 'accepted')
        ) THEN
          RETURN v_false;
        END IF;
      ELSIF jsonb_typeof(v_operation.result->'assignment') = 'object' THEN
        IF NOT EXISTS (
          SELECT 1
          FROM public.dispatch_assignments AS assignment
          LEFT JOIN public.dispatch_group_orders AS dispatch_order
            ON dispatch_order.id = assignment.dispatch_order_id
          LEFT JOIN public.dispatch_groups AS dispatch_group
            ON dispatch_group.id = COALESCE(assignment.group_id, dispatch_order.group_id)
          WHERE assignment.id::text = v_operation.result->'assignment'->>'id'
            AND assignment.user_id = p_user_id
            AND assignment.dispatch_session_id::text = v_operation.result->>'session_id'
            AND assignment.assigned_at IS NOT DISTINCT FROM (v_operation.result->'assignment'->>'assigned_at')::timestamptz
            AND assignment.accepted_at IS NOT DISTINCT FROM (v_operation.result->'assignment'->>'accepted_at')::timestamptz
            AND assignment.completed_at IS NOT DISTINCT FROM (v_operation.result->'assignment'->>'completed_at')::timestamptz
            AND assignment.accept_deadline_at IS NOT DISTINCT FROM (v_operation.result->'assignment'->>'accept_deadline_at')::timestamptz
            AND jsonb_build_object(
              'id', assignment.id, 'dispatch_order_id', assignment.dispatch_order_id,
              'user_id', assignment.user_id, 'status', assignment.status,
              'remarks', assignment.remarks, 'assignment_id', assignment.assignment_id,
              'order_submitted', assignment.order_submitted,
              'dispatch_session_id', assignment.dispatch_session_id,
              'dispatch_orders', jsonb_build_object('order_content', COALESCE(assignment.order_content_snapshot, dispatch_order.order_content)),
              'session_timeout_minutes', COALESCE(assignment.session_timeout_minutes_snapshot, dispatch_group.session_timeout_minutes, 10)
            ) = ((v_operation.result->'assignment') - ARRAY['assigned_at', 'accepted_at', 'completed_at', 'accept_deadline_at']::text[])
            AND NOT EXISTS (
              SELECT 1 FROM public.dispatch_assignments AS other_assignment
              WHERE other_assignment.user_id = p_user_id
                AND other_assignment.status IN ('pending', 'accepted') AND other_assignment.id <> assignment.id)
            AND (
              (assignment.status = 'pending' AND assignment.accept_deadline_at > clock_timestamp())
              OR (assignment.status = 'accepted' AND assignment.accepted_at IS NOT NULL
                AND ((assignment.order_submitted = false
                      AND NOT EXISTS (SELECT 1 FROM public.orders AS submitted_order
                        WHERE submitted_order.assignment_id = assignment.assignment_id)
                      AND assignment.accepted_at + make_interval(mins => GREATEST(
                        COALESCE(assignment.session_timeout_minutes_snapshot, dispatch_group.session_timeout_minutes, 10), 1)) > clock_timestamp())
                  OR (assignment.order_submitted = true AND (
                        assignment.accepted_at >= clock_timestamp() - interval '30 minutes'
                        OR v_operation.replay_order_snapshot IS NOT NULL
                        OR EXISTS (SELECT 1 FROM public.orders AS submitted_order
                          WHERE submitted_order.assignment_id = assignment.assignment_id
                            AND submitted_order.user_id = p_user_id)))
                  OR EXISTS (SELECT 1 FROM public.orders AS submitted_order
                    WHERE submitted_order.assignment_id = assignment.assignment_id
                      AND submitted_order.user_id = p_user_id)))
            )
        ) THEN
          RETURN v_false;
        END IF;

        SELECT count(*)::integer INTO v_replay_order_count
        FROM public.orders AS submitted_order
        WHERE submitted_order.assignment_id = v_operation.result->'assignment'->>'assignment_id';
        IF v_replay_order_count > 1 THEN
          RETURN v_false;
        ELSIF v_replay_order_count = 1 THEN
          SELECT submitted_order.id, submitted_order.user_id, submitted_order.assignment_id,
                 submitted_order.status, submitted_order.created_at, submitted_order.processed_at
          INTO v_replay_order
          FROM public.orders AS submitted_order
          WHERE submitted_order.assignment_id = v_operation.result->'assignment'->>'assignment_id'
          LIMIT 1;
          IF v_replay_order.user_id IS DISTINCT FROM p_user_id THEN
            RETURN v_false;
          END IF;
          IF v_operation.replay_order_snapshot IS NULL THEN
            IF v_replay_order.status = 'processing' AND v_replay_order.processed_at IS NULL
               AND v_replay_order.created_at >= clock_timestamp() - interval '30 minutes' THEN
              v_operation.replay_order_snapshot := jsonb_build_object(
                'id', v_replay_order.id, 'user_id', v_replay_order.user_id,
                'assignment_id', v_replay_order.assignment_id, 'status', v_replay_order.status,
                'created_at', v_replay_order.created_at, 'processed_at', v_replay_order.processed_at);
              UPDATE private.employee_dispatch_recovery_operations
              SET replay_order_snapshot = v_operation.replay_order_snapshot
              WHERE operation_id = p_operation_id;
            ELSIF (v_replay_order.status IN ('success', 'failure', 'error') AND v_replay_order.processed_at IS NOT NULL)
               OR (v_replay_order.status = 'processing'
                 AND v_replay_order.created_at < clock_timestamp() - interval '30 minutes') THEN
              v_result := public.recover_employee_dispatch_assignment_secure(p_user_id, p_session_token, p_tab_id);
              UPDATE private.employee_dispatch_recovery_operations
              SET result = v_result, replay_order_snapshot = NULL
              WHERE operation_id = p_operation_id;
              RETURN v_result;
            ELSE
              RETURN v_false;
            END IF;
          ELSIF v_replay_order.id IS DISTINCT FROM (v_operation.replay_order_snapshot->>'id')::uuid
             OR v_replay_order.user_id IS DISTINCT FROM (v_operation.replay_order_snapshot->>'user_id')::uuid
             OR v_replay_order.assignment_id IS DISTINCT FROM v_operation.replay_order_snapshot->>'assignment_id'
             OR v_replay_order.created_at IS DISTINCT FROM (v_operation.replay_order_snapshot->>'created_at')::timestamptz THEN
            RETURN v_false;
          END IF;
          IF (v_replay_order.status IN ('success', 'failure', 'error') AND v_replay_order.processed_at IS NOT NULL)
             OR (v_replay_order.status = 'processing'
               AND v_replay_order.created_at < clock_timestamp() - interval '30 minutes') THEN
            v_result := public.recover_employee_dispatch_assignment_secure(p_user_id, p_session_token, p_tab_id);
            UPDATE private.employee_dispatch_recovery_operations
            SET result = v_result, replay_order_snapshot = NULL
            WHERE operation_id = p_operation_id;
            RETURN v_result;
          END IF;
          IF v_replay_order.status IS DISTINCT FROM 'processing'
             OR v_replay_order.processed_at IS NOT NULL
             OR v_operation.replay_order_snapshot->>'status' IS DISTINCT FROM 'processing'
             OR NULLIF(v_operation.replay_order_snapshot->>'processed_at', '') IS NOT NULL THEN
            RETURN v_false;
          END IF;
        ELSIF v_operation.replay_order_snapshot IS NOT NULL THEN
          RETURN v_false;
        END IF;
      ELSE
        RETURN v_false;
      END IF;
    END IF;
    RETURN v_operation.result;
  END IF;

  SELECT id, started_at INTO v_expected FROM public.dispatch_sessions
  WHERE id = p_expected_session_id AND user_id = p_user_id;
  IF p_expected_session_id IS NOT NULL AND NOT FOUND THEN
    RAISE EXCEPTION 'Previous employee work session is invalid.';
  END IF;

  SELECT stopped_at INTO v_stop FROM private.employee_work_stop_markers WHERE user_id = p_user_id;
  IF p_expected_session_id IS NULL AND v_stop IS NOT NULL THEN
    v_result := v_false;
  END IF;
  SELECT id, started_at INTO v_latest FROM public.dispatch_sessions
  WHERE user_id = p_user_id ORDER BY started_at DESC, id DESC LIMIT 1 FOR UPDATE;

  SELECT id, dispatch_session_id, assigned_at INTO v_candidate
  FROM public.dispatch_assignments
  WHERE user_id = p_user_id AND status IN ('pending', 'accepted')
  ORDER BY assigned_at DESC LIMIT 1 FOR UPDATE;

  IF v_candidate.id IS NOT NULL THEN
    IF v_candidate.assigned_at IS NULL OR EXISTS (
      SELECT 1 FROM public.dispatch_assignments AS tied
      WHERE tied.user_id = p_user_id AND tied.status IN ('pending', 'accepted')
        AND tied.id <> v_candidate.id AND tied.assigned_at = v_candidate.assigned_at
    ) THEN
      v_result := v_false;
    END IF;
    IF v_candidate.dispatch_session_id IS NOT NULL THEN
      SELECT id, started_at INTO v_target FROM public.dispatch_sessions
      WHERE id = v_candidate.dispatch_session_id AND user_id = p_user_id;
      IF NOT FOUND THEN
        v_result := v_false;
      END IF;
    ELSE
      SELECT id, started_at INTO v_target FROM public.dispatch_sessions
      WHERE id = v_latest.id AND user_id = p_user_id;
    END IF;
    IF v_stop IS NOT NULL AND (v_candidate.assigned_at IS NULL OR v_stop >= v_candidate.assigned_at) THEN
      v_result := v_false;
    END IF;
  ELSE
    SELECT session.id, session.started_at INTO v_target
    FROM public.dispatch_sessions AS session
    WHERE session.user_id = p_user_id
      AND session.last_activity_at >= now() - interval '2 minutes'
      AND ((session.status = 'online' AND session.ended_at IS NULL)
        OR (session.status = 'offline' AND session.ended_at >= now() - interval '30 seconds'
          AND NOT EXISTS (SELECT 1 FROM private.employee_work_stop_markers AS marker
            WHERE marker.user_id = p_user_id AND marker.stopped_at >= session.ended_at)))
    ORDER BY session.started_at DESC, session.id DESC LIMIT 1;
    IF v_target.id IS NULL THEN
      v_result := v_false;
    END IF;
  END IF;

  IF (p_expected_session_id IS NOT NULL AND
        (v_expected.started_at IS NULL OR v_stop >= v_expected.started_at OR v_target.id IS DISTINCT FROM p_expected_session_id))
     OR (v_target.id IS NOT NULL AND (v_target.started_at IS NULL OR v_stop >= v_target.started_at OR v_target.id IS DISTINCT FROM v_latest.id))
     OR (v_candidate.id IS NOT NULL AND v_candidate.dispatch_session_id IS NULL
         AND v_target.id IS NULL AND v_stop IS NOT NULL) THEN
    v_result := v_false;
  END IF;

  IF v_result IS NULL THEN
    v_result := public.recover_employee_dispatch_assignment_secure(p_user_id, p_session_token, p_tab_id);
  END IF;

  IF COALESCE((v_result->>'recovered')::boolean, false)
     AND jsonb_typeof(v_result->'assignment') = 'object' THEN
    SELECT count(*)::integer INTO v_replay_order_count
    FROM public.orders AS submitted_order
    WHERE submitted_order.assignment_id = v_result->'assignment'->>'assignment_id';
    IF v_replay_order_count = 1 THEN
      SELECT jsonb_build_object(
        'id', submitted_order.id,
        'user_id', submitted_order.user_id,
        'assignment_id', submitted_order.assignment_id,
        'status', submitted_order.status,
        'created_at', submitted_order.created_at,
        'processed_at', submitted_order.processed_at
      ) INTO v_replay_order_snapshot
      FROM public.orders AS submitted_order
      WHERE submitted_order.assignment_id = v_result->'assignment'->>'assignment_id'
        AND submitted_order.user_id = p_user_id
      LIMIT 1;
      IF FOUND THEN
        IF v_replay_order_snapshot->>'status' IN ('success', 'failure', 'error')
           AND v_replay_order_snapshot->>'processed_at' IS NOT NULL THEN
          v_result := public.recover_employee_dispatch_assignment_secure(p_user_id, p_session_token, p_tab_id);
          v_replay_order_snapshot := NULL;
        ELSIF v_replay_order_snapshot->>'status' <> 'processing'
           OR v_replay_order_snapshot->>'processed_at' IS NOT NULL
           OR (v_replay_order_snapshot->>'created_at')::timestamptz < clock_timestamp() - interval '30 minutes' THEN
          v_replay_order_snapshot := NULL;
        END IF;
      END IF;
    END IF;
  END IF;

  INSERT INTO private.employee_dispatch_recovery_operations
    (operation_id, user_id, token_hash, tab_id, expected_session_id, result, replay_order_snapshot)
  VALUES (p_operation_id, p_user_id, v_hash, p_tab_id, p_expected_session_id, v_result, v_replay_order_snapshot);
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.recover_employee_dispatch_guarded(uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_employee_dispatch_guarded(uuid, uuid, text, uuid, uuid)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
