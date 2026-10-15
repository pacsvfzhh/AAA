-- Refresh recovery resumes a session that ended in the last 30 seconds, because a page refresh ends it
-- through the unload beacon. A session the employee ended on purpose (End Session, auto-stop, logout) must
-- stay ended, so those stops record a marker and recovery skips any session that ended at or before it.

CREATE TABLE IF NOT EXISTS private.employee_work_stop_markers (
  user_id uuid PRIMARY KEY,
  stopped_at timestamptz NOT NULL
);

REVOKE ALL ON TABLE private.employee_work_stop_markers FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.end_employee_dispatch_session_secure(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_session_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  -- Validates the employee session and raises before any marker is written.
  v_result := public.stop_employee_dispatch_session_secure(
    p_user_id, p_session_token, p_tab_id, p_session_id);

  INSERT INTO private.employee_work_stop_markers (user_id, stopped_at)
  VALUES (p_user_id, clock_timestamp())
  ON CONFLICT (user_id) DO UPDATE SET stopped_at = EXCLUDED.stopped_at;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.end_employee_dispatch_session_secure(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.end_employee_dispatch_session_secure(uuid, uuid, text, uuid)
  TO anon, authenticated;

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
    AND employee.current_tab_id = p_tab_id AND employee.is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  SELECT assignment.id, assignment.status, assignment.accepted_at,
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
