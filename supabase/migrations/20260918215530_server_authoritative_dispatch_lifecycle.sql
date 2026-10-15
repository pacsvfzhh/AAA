ALTER TABLE public.dispatch_sessions
  ADD COLUMN IF NOT EXISTS consecutive_unaccepted_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.dispatch_sessions
  DROP CONSTRAINT IF EXISTS dispatch_sessions_consecutive_unaccepted_count_check;

ALTER TABLE public.dispatch_sessions
  ADD CONSTRAINT dispatch_sessions_consecutive_unaccepted_count_check
  CHECK (consecutive_unaccepted_count BETWEEN 0 AND 5);

ALTER TABLE public.dispatch_assignments
  ADD COLUMN IF NOT EXISTS dispatch_session_id uuid,
  ADD COLUMN IF NOT EXISTS accept_deadline_at timestamptz;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'dispatch_assignments_dispatch_session_id_fkey'
      AND conrelid = 'public.dispatch_assignments'::regclass
  ) THEN
    ALTER TABLE public.dispatch_assignments
      ADD CONSTRAINT dispatch_assignments_dispatch_session_id_fkey
      FOREIGN KEY (dispatch_session_id)
      REFERENCES public.dispatch_sessions(id)
      ON DELETE SET NULL;
  END IF;
END;
$block$;

UPDATE public.dispatch_assignments
SET accept_deadline_at = assigned_at + interval '60 seconds'
WHERE accept_deadline_at IS NULL
  AND assigned_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_pending_deadline
  ON public.dispatch_assignments (accept_deadline_at, id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_session_status
  ON public.dispatch_assignments (dispatch_session_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_unique_dispatch_assignment
  ON public.orders (assignment_id)
  WHERE assignment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION private.close_dispatch_session_from_system(
  p_session_id uuid,
  p_stopped_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid;
  v_started_at timestamptz;
  v_last_activity_at timestamptz;
  v_status text;
  v_ended_at timestamptz;
  v_end_time timestamptz;
BEGIN
  SELECT user_id, started_at, last_activity_at, status, ended_at
  INTO v_user_id, v_started_at, v_last_activity_at, v_status, v_ended_at
  FROM public.dispatch_sessions
  WHERE id = p_session_id
  FOR UPDATE;

  IF v_user_id IS NULL OR v_status <> 'online' OR v_ended_at IS NOT NULL THEN
    RETURN;
  END IF;

  v_end_time := GREATEST(
    v_started_at,
    LEAST(
      COALESCE(p_stopped_at, clock_timestamp()),
      COALESCE(v_last_activity_at, v_started_at) + interval '1 minute'
    )
  );

  UPDATE public.dispatch_sessions
  SET status = 'offline',
      ended_at = COALESCE(ended_at, v_end_time)
  WHERE id = p_session_id
    AND status = 'online'
    AND ended_at IS NULL;

  UPDATE public.work_sessions
  SET end_time = GREATEST(v_end_time, start_time),
      duration_minutes = GREATEST(
        round(extract(epoch FROM (GREATEST(v_end_time, start_time) - start_time)) / 60)::integer,
        0
      )
  WHERE id = (
    SELECT work_session.id
    FROM public.work_sessions AS work_session
    WHERE work_session.user_id = v_user_id
      AND work_session.end_time IS NULL
      AND work_session.start_time <= COALESCE(v_last_activity_at, v_started_at) + interval '1 minute'
    ORDER BY work_session.start_time DESC, work_session.id DESC
    LIMIT 1
    FOR UPDATE
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.close_dispatch_session_from_system(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.assign_next_dispatch_order_secure(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_session_id uuid,
  p_group_id uuid,
  p_dispatch_mode text DEFAULT 'random'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_session record;
  v_result jsonb;
  v_assignment_id uuid;
  v_deadline timestamptz;
BEGIN
  SELECT dispatch_session.id,
         dispatch_session.last_activity_at,
         dispatch_session.consecutive_unaccepted_count
  INTO v_session
  FROM public.employee_financial_sessions AS financial_session
  INNER JOIN public.users AS employee
    ON employee.id = financial_session.user_id
  INNER JOIN public.dispatch_sessions AS dispatch_session
    ON dispatch_session.id = p_session_id
   AND dispatch_session.user_id = employee.id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true
    AND dispatch_session.status = 'online'
    AND dispatch_session.ended_at IS NULL
    AND dispatch_session.last_activity_at >= now() - interval '2 minutes'
  FOR UPDATE OF financial_session, employee, dispatch_session;

  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'Employee work session is invalid, offline, or stale.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.dispatch_groups AS dispatch_group
    WHERE dispatch_group.id = p_group_id
      AND dispatch_group.is_active = true
      AND (
        dispatch_group.is_default = true
        OR EXISTS (
          SELECT 1
          FROM public.dispatch_group_members AS membership
          WHERE membership.group_id = dispatch_group.id
            AND membership.user_id = p_user_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'Employee is not assigned to this dispatch group.';
  END IF;

  IF v_session.consecutive_unaccepted_count >= 5 THEN
    PERFORM private.close_dispatch_session_from_system(p_session_id, clock_timestamp());
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Work stopped after five consecutive unaccepted orders.',
      'auto_stopped', true,
      'schedule_next', false,
      'unaccepted_count', v_session.consecutive_unaccepted_count,
      'assignment', NULL
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.dispatch_assignments
    WHERE user_id = p_user_id
      AND status IN ('pending', 'accepted')
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'An active dispatch assignment already exists.',
      'auto_stopped', false,
      'schedule_next', false,
      'unaccepted_count', v_session.consecutive_unaccepted_count,
      'assignment', NULL
    );
  END IF;

  v_result := public.assign_next_dispatch_order(
    p_user_id,
    p_group_id,
    CASE WHEN p_dispatch_mode = 'sequential' THEN 'sequential' ELSE 'random' END
  )::jsonb;

  IF COALESCE((v_result->>'success')::boolean, false) = false THEN
    RETURN v_result || jsonb_build_object(
      'auto_stopped', false,
      'schedule_next', true,
      'unaccepted_count', v_session.consecutive_unaccepted_count
    );
  END IF;

  v_assignment_id := NULLIF(v_result->'assignment'->>'id', '')::uuid;
  v_deadline := clock_timestamp() + interval '60 seconds';

  UPDATE public.dispatch_assignments
  SET dispatch_session_id = p_session_id,
      accept_deadline_at = v_deadline
  WHERE id = v_assignment_id
    AND user_id = p_user_id
    AND status = 'pending';

  RETURN jsonb_set(
    v_result || jsonb_build_object(
      'auto_stopped', false,
      'schedule_next', false,
      'unaccepted_count', v_session.consecutive_unaccepted_count
    ),
    '{assignment}',
    (v_result->'assignment') || jsonb_build_object(
      'dispatch_session_id', p_session_id,
      'accept_deadline_at', v_deadline
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.expire_pending_dispatch_assignment_secure(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_session_id uuid,
  p_assignment_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_session record;
  v_assignment record;
  v_count integer;
  v_now timestamptz := clock_timestamp();
  v_auto_stopped boolean := false;
BEGIN
  SELECT dispatch_session.id,
         dispatch_session.status,
         dispatch_session.ended_at,
         dispatch_session.last_activity_at,
         dispatch_session.consecutive_unaccepted_count
  INTO v_session
  FROM public.employee_financial_sessions AS financial_session
  INNER JOIN public.users AS employee
    ON employee.id = financial_session.user_id
  INNER JOIN public.dispatch_sessions AS dispatch_session
    ON dispatch_session.id = p_session_id
   AND dispatch_session.user_id = employee.id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true
  FOR UPDATE OF financial_session, employee, dispatch_session;

  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  SELECT id, status, accept_deadline_at, dispatch_session_id
  INTO v_assignment
  FROM public.dispatch_assignments
  WHERE id = p_assignment_id
    AND user_id = p_user_id
    AND dispatch_session_id = p_session_id
  FOR UPDATE;

  IF v_assignment.id IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'assignment_not_found',
      'schedule_next', false,
      'auto_stopped', false,
      'unaccepted_count', v_session.consecutive_unaccepted_count
    );
  END IF;

  IF v_assignment.status <> 'pending' THEN
    RETURN jsonb_build_object(
      'success', true,
      'reason', 'already_resolved',
      'assignment_status', v_assignment.status,
      'schedule_next',
        v_assignment.status IN ('cancelled', 'timeout')
        AND v_session.status = 'online'
        AND v_session.ended_at IS NULL
        AND v_session.last_activity_at >= now() - interval '2 minutes'
        AND v_session.consecutive_unaccepted_count < 5,
      'auto_stopped', v_session.consecutive_unaccepted_count >= 5,
      'unaccepted_count', v_session.consecutive_unaccepted_count
    );
  END IF;

  IF COALESCE(v_assignment.accept_deadline_at, v_now) > v_now THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'deadline_not_reached',
      'assignment_status', 'pending',
      'accept_deadline_at', v_assignment.accept_deadline_at,
      'schedule_next', false,
      'auto_stopped', false,
      'unaccepted_count', v_session.consecutive_unaccepted_count
    );
  END IF;

  UPDATE public.dispatch_assignments
  SET status = 'cancelled',
      completed_at = v_now,
      remarks = 'Auto-cancelled: server accept deadline reached'
  WHERE id = v_assignment.id
    AND status = 'pending';

  v_count := LEAST(v_session.consecutive_unaccepted_count + 1, 5);

  UPDATE public.dispatch_sessions
  SET consecutive_unaccepted_count = v_count
  WHERE id = p_session_id;

  IF v_count >= 5 THEN
    PERFORM private.close_dispatch_session_from_system(p_session_id, v_now);
    v_auto_stopped := true;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'reason', 'expired',
    'assignment_status', 'cancelled',
    'schedule_next',
      NOT v_auto_stopped
      AND v_session.last_activity_at >= now() - interval '2 minutes',
    'auto_stopped', v_auto_stopped,
    'unaccepted_count', v_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.accept_dispatch_assignment_secure(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_session_id uuid,
  p_assignment_id uuid,
  p_assignment_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_assignment record;
  v_success_rate integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM 1
  FROM public.employee_financial_sessions AS financial_session
  INNER JOIN public.users AS employee
    ON employee.id = financial_session.user_id
  INNER JOIN public.dispatch_sessions AS dispatch_session
    ON dispatch_session.id = p_session_id
   AND dispatch_session.user_id = employee.id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true
    AND dispatch_session.status = 'online'
    AND dispatch_session.ended_at IS NULL
    AND dispatch_session.last_activity_at >= now() - interval '2 minutes'
  FOR UPDATE OF financial_session, employee, dispatch_session;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee work session is invalid, offline, or stale.';
  END IF;

  SELECT assignment.id,
         assignment.status,
         assignment.accept_deadline_at,
         dispatch_group.dispatch_success_rate
  INTO v_assignment
  FROM public.dispatch_assignments AS assignment
  INNER JOIN public.dispatch_group_orders AS dispatch_order
    ON dispatch_order.id = assignment.dispatch_order_id
  INNER JOIN public.dispatch_groups AS dispatch_group
    ON dispatch_group.id = dispatch_order.group_id
  WHERE assignment.id = p_assignment_id
    AND assignment.user_id = p_user_id
    AND assignment.dispatch_session_id = p_session_id
  FOR UPDATE OF assignment;

  IF v_assignment.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'assignment_not_found');
  END IF;

  IF v_assignment.status <> 'pending' THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'already_resolved',
      'assignment_status', v_assignment.status
    );
  END IF;

  IF COALESCE(v_assignment.accept_deadline_at, v_now) <= v_now THEN
    RETURN jsonb_build_object(
      'success', false,
      'reason', 'accept_deadline_reached',
      'accept_deadline_at', v_assignment.accept_deadline_at
    );
  END IF;

  v_success_rate := LEAST(GREATEST(COALESCE(v_assignment.dispatch_success_rate, 100), 0), 100);
  IF floor(random() * 100 + 1)::integer > v_success_rate THEN
    UPDATE public.dispatch_assignments
    SET status = 'cancelled',
        completed_at = v_now,
        remarks = 'Order grab failed based on dispatch group success rate'
    WHERE id = p_assignment_id
      AND status = 'pending';

    RETURN jsonb_build_object(
      'success', false,
      'reason', 'grab_failed',
      'assignment_status', 'cancelled',
      'unaccepted_count', NULL
    );
  END IF;

  BEGIN
    UPDATE public.dispatch_assignments
    SET status = 'accepted',
        accepted_at = v_now,
        assignment_id = p_assignment_code,
        order_submitted = false
    WHERE id = p_assignment_id
      AND status = 'pending';
  EXCEPTION
    WHEN unique_violation THEN
      RETURN jsonb_build_object('success', false, 'reason', 'assignment_code_conflict');
  END;

  UPDATE public.dispatch_sessions
  SET consecutive_unaccepted_count = 0
  WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'success', true,
    'assignment_id', p_assignment_id,
    'assignment_code', p_assignment_code,
    'accepted_at', v_now,
    'unaccepted_count', 0
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.finish_dispatch_assignment_secure(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_assignment_id uuid,
  p_status text,
  p_remarks text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_updated_id uuid;
BEGIN
  IF p_status NOT IN ('completed', 'error', 'timeout', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid dispatch assignment status.';
  END IF;

  PERFORM 1
  FROM public.employee_financial_sessions AS financial_session
  INNER JOIN public.users AS employee
    ON employee.id = financial_session.user_id
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

  UPDATE public.dispatch_assignments
  SET status = p_status,
      completed_at = clock_timestamp(),
      remarks = COALESCE(p_remarks, remarks)
  WHERE id = p_assignment_id
    AND user_id = p_user_id
    AND (
      (p_status = 'cancelled' AND status IN ('pending', 'accepted'))
      OR (p_status <> 'cancelled' AND status = 'accepted')
    )
  RETURNING id INTO v_updated_id;

  RETURN jsonb_build_object(
    'success', v_updated_id IS NOT NULL,
    'assignment_id', v_updated_id,
    'status', p_status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_dispatch_assignment_submitted_secure(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_assignment_id uuid,
  p_assignment_code text,
  p_order_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  PERFORM 1
  FROM public.employee_financial_sessions AS financial_session
  INNER JOIN public.users AS employee
    ON employee.id = financial_session.user_id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  UPDATE public.dispatch_assignments AS assignment
  SET order_submitted = true
  WHERE assignment.id = p_assignment_id
    AND assignment.user_id = p_user_id
    AND assignment.assignment_id = p_assignment_code
    AND assignment.status = 'accepted'
    AND assignment.order_submitted = false
    AND EXISTS (
      SELECT 1
      FROM public.orders AS submitted_order
      WHERE submitted_order.id = p_order_id
        AND submitted_order.user_id = p_user_id
        AND submitted_order.assignment_id = p_assignment_code
    );

  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resume_employee_dispatch_session_secure(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_previous_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_count integer := 0;
  v_session jsonb;
BEGIN
  SELECT dispatch_session.consecutive_unaccepted_count
  INTO v_count
  FROM public.employee_financial_sessions AS financial_session
  INNER JOIN public.users AS employee
    ON employee.id = financial_session.user_id
  INNER JOIN public.dispatch_sessions AS dispatch_session
    ON dispatch_session.id = p_previous_session_id
   AND dispatch_session.user_id = employee.id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true
  FOR UPDATE OF financial_session, employee, dispatch_session;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Previous employee work session is invalid.';
  END IF;

  v_session := public.start_employee_dispatch_session_secure(
    p_user_id,
    p_session_token,
    p_tab_id
  );

  UPDATE public.dispatch_sessions
  SET consecutive_unaccepted_count = LEAST(GREATEST(COALESCE(v_count, 0), 0), 5)
  WHERE id = NULLIF(v_session->>'session_id', '')::uuid
    AND user_id = p_user_id;

  RETURN v_session || jsonb_build_object(
    'unaccepted_count', LEAST(GREATEST(COALESCE(v_count, 0), 0), 5)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.recover_employee_dispatch_assignment_secure(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text
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
  v_session jsonb;
  v_timeout_minutes integer;
BEGIN
  PERFORM 1
  FROM public.employee_financial_sessions AS financial_session
  INNER JOIN public.users AS employee
    ON employee.id = financial_session.user_id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  SELECT assignment.id,
         assignment.status,
         assignment.accepted_at,
         assignment.accept_deadline_at,
         assignment.dispatch_session_id,
         dispatch_group.session_timeout_minutes
  INTO v_candidate
  FROM public.dispatch_assignments AS assignment
  INNER JOIN public.dispatch_group_orders AS dispatch_order
    ON dispatch_order.id = assignment.dispatch_order_id
  INNER JOIN public.dispatch_groups AS dispatch_group
    ON dispatch_group.id = dispatch_order.group_id
  WHERE assignment.user_id = p_user_id
    AND assignment.status IN ('pending', 'accepted')
  ORDER BY assignment.assigned_at DESC
  LIMIT 1;

  IF v_candidate.id IS NULL THEN
    SELECT dispatch_session.id,
           dispatch_session.started_at,
           dispatch_session.consecutive_unaccepted_count
    INTO v_existing_session
    FROM public.dispatch_sessions AS dispatch_session
    WHERE dispatch_session.user_id = p_user_id
      AND dispatch_session.last_activity_at >= now() - interval '2 minutes'
      AND (
        (
          dispatch_session.status = 'online'
          AND dispatch_session.ended_at IS NULL
        )
        OR (
          dispatch_session.status = 'offline'
          AND dispatch_session.ended_at >= now() - interval '30 seconds'
        )
      )
    ORDER BY dispatch_session.started_at DESC, dispatch_session.id DESC
    LIMIT 1;

    IF v_existing_session.id IS NULL THEN
      PERFORM public.stop_employee_dispatch_session_secure(
        p_user_id,
        p_session_token,
        p_tab_id,
        NULL
      );
      RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
    END IF;

    v_session := public.resume_employee_dispatch_session_secure(
      p_user_id,
      p_session_token,
      p_tab_id,
      v_existing_session.id
    );

    RETURN jsonb_build_object(
      'success', true,
      'recovered', true,
      'session_id', v_session->>'session_id',
      'started_at', v_session->>'started_at',
      'unaccepted_count', COALESCE((v_session->>'unaccepted_count')::integer, 0),
      'assignment', NULL
    );
  END IF;

  IF v_candidate.status = 'pending'
     AND COALESCE(v_candidate.accept_deadline_at, now()) <= now() THEN
    IF v_candidate.dispatch_session_id IS NOT NULL THEN
      PERFORM public.expire_pending_dispatch_assignment_secure(
        p_user_id,
        p_session_token,
        p_tab_id,
        v_candidate.dispatch_session_id,
        v_candidate.id
      );
    ELSE
      UPDATE public.dispatch_assignments
      SET status = 'cancelled',
          completed_at = clock_timestamp(),
          remarks = 'Auto-cancelled: server accept deadline reached before recovery'
      WHERE id = v_candidate.id
        AND user_id = p_user_id
        AND status = 'pending';
    END IF;

    PERFORM public.stop_employee_dispatch_session_secure(
      p_user_id,
      p_session_token,
      p_tab_id,
      NULL
    );
    RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
  END IF;

  v_timeout_minutes := GREATEST(COALESCE(v_candidate.session_timeout_minutes, 10), 1);
  IF v_candidate.status = 'accepted'
     AND (
       v_candidate.accepted_at IS NULL
       OR v_candidate.accepted_at + make_interval(mins => v_timeout_minutes) <= now()
     ) THEN
    UPDATE public.dispatch_assignments
    SET status = 'timeout',
        completed_at = clock_timestamp(),
        remarks = 'Auto-timeout: accepted assignment expired before recovery'
    WHERE id = v_candidate.id
      AND user_id = p_user_id
      AND status = 'accepted';

    PERFORM public.stop_employee_dispatch_session_secure(
      p_user_id,
      p_session_token,
      p_tab_id,
      NULL
    );
    RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
  END IF;

  IF v_candidate.dispatch_session_id IS NOT NULL THEN
    v_session := public.resume_employee_dispatch_session_secure(
      p_user_id,
      p_session_token,
      p_tab_id,
      v_candidate.dispatch_session_id
    );
  ELSE
    v_session := public.start_employee_dispatch_session_secure(
      p_user_id,
      p_session_token,
      p_tab_id
    );
  END IF;

  SELECT assignment.id,
         assignment.dispatch_order_id,
         assignment.user_id,
         assignment.status,
         assignment.assigned_at,
         assignment.accepted_at,
         assignment.completed_at,
         assignment.remarks,
         assignment.assignment_id,
         assignment.order_submitted,
         assignment.accept_deadline_at,
         dispatch_order.order_content,
         dispatch_group.session_timeout_minutes
  INTO v_assignment
  FROM public.dispatch_assignments AS assignment
  INNER JOIN public.dispatch_group_orders AS dispatch_order
    ON dispatch_order.id = assignment.dispatch_order_id
  INNER JOIN public.dispatch_groups AS dispatch_group
    ON dispatch_group.id = dispatch_order.group_id
  WHERE assignment.id = v_candidate.id
    AND assignment.user_id = p_user_id
    AND (
      (
        assignment.status = 'pending'
        AND assignment.accept_deadline_at > now()
      )
      OR (
        assignment.status = 'accepted'
        AND assignment.accepted_at + make_interval(
          mins => GREATEST(COALESCE(dispatch_group.session_timeout_minutes, 10), 1)
        ) > now()
      )
    )
  FOR UPDATE OF assignment;

  IF v_assignment.id IS NULL THEN
    PERFORM public.stop_employee_dispatch_session_secure(
      p_user_id,
      p_session_token,
      p_tab_id,
      NULLIF(v_session->>'session_id', '')::uuid
    );
    RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
  END IF;

  UPDATE public.dispatch_assignments
  SET dispatch_session_id = NULLIF(v_session->>'session_id', '')::uuid
  WHERE id = v_assignment.id;

  RETURN jsonb_build_object(
    'success', true,
    'recovered', true,
    'session_id', v_session->>'session_id',
    'started_at', v_session->>'started_at',
    'unaccepted_count', COALESCE((v_session->>'unaccepted_count')::integer, 0),
    'assignment', jsonb_build_object(
      'id', v_assignment.id,
      'dispatch_order_id', v_assignment.dispatch_order_id,
      'user_id', v_assignment.user_id,
      'status', v_assignment.status,
      'assigned_at', v_assignment.assigned_at,
      'accepted_at', v_assignment.accepted_at,
      'completed_at', v_assignment.completed_at,
      'remarks', v_assignment.remarks,
      'assignment_id', v_assignment.assignment_id,
      'order_submitted', v_assignment.order_submitted,
      'accept_deadline_at', v_assignment.accept_deadline_at,
      'dispatch_session_id', v_session->>'session_id',
      'dispatch_orders', jsonb_build_object('order_content', v_assignment.order_content),
      'session_timeout_minutes', v_assignment.session_timeout_minutes
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_server_dispatch_lifecycle()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_assignment record;
  v_count integer;
  v_expired integer := 0;
  v_auto_stopped integer := 0;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF NOT pg_try_advisory_xact_lock(8675313) THEN
    RETURN jsonb_build_object('skipped', true, 'reason', 'previous lifecycle pass still running');
  END IF;

  FOR v_assignment IN
    SELECT assignment.id,
           assignment.dispatch_session_id
    FROM public.dispatch_assignments AS assignment
    WHERE assignment.status = 'pending'
      AND assignment.accept_deadline_at IS NOT NULL
      AND assignment.accept_deadline_at <= v_now
    ORDER BY assignment.accept_deadline_at, assignment.id
  LOOP
    IF v_assignment.dispatch_session_id IS NOT NULL THEN
      PERFORM id
      FROM public.dispatch_sessions
      WHERE id = v_assignment.dispatch_session_id
      FOR UPDATE;
    END IF;

    UPDATE public.dispatch_assignments
    SET status = 'cancelled',
        completed_at = v_now,
        remarks = 'Auto-cancelled: server accept deadline reached'
    WHERE id = v_assignment.id
      AND status = 'pending';

    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    v_expired := v_expired + 1;

    IF v_assignment.dispatch_session_id IS NOT NULL THEN
      UPDATE public.dispatch_sessions
      SET consecutive_unaccepted_count = LEAST(consecutive_unaccepted_count + 1, 5)
      WHERE id = v_assignment.dispatch_session_id
      RETURNING consecutive_unaccepted_count INTO v_count;

      IF v_count >= 5 THEN
        PERFORM private.close_dispatch_session_from_system(
          v_assignment.dispatch_session_id,
          v_now
        );
        v_auto_stopped := v_auto_stopped + 1;
      END IF;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'expired_pending', v_expired,
    'auto_stopped_sessions', v_auto_stopped,
    'checked_at', v_now
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.auto_cleanup_dispatch_system()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_work_result json;
  v_dispatch_cleaned integer;
  v_assignment_result jsonb;
  v_lifecycle_result jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(8675312) THEN
    RETURN json_build_object('skipped', true, 'reason', 'previous cron still running');
  END IF;

  SELECT public.reconcile_server_dispatch_lifecycle()
  INTO v_lifecycle_result;

  SELECT public.cleanup_stale_work_sessions_optimized()
  INTO v_work_result;

  SELECT COUNT(*)
  INTO v_dispatch_cleaned
  FROM public.cleanup_stale_dispatch_sessions();

  SELECT public.reconcile_stale_dispatch_assignments(10, 30)
  INTO v_assignment_result;

  RETURN json_build_object(
    'dispatch_lifecycle', v_lifecycle_result,
    'work_sessions', v_work_result,
    'dispatch_sessions_cleaned', v_dispatch_cleaned,
    'assignments', v_assignment_result,
    'executed_at', now()
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_next_dispatch_order_secure(uuid, uuid, text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.expire_pending_dispatch_assignment_secure(uuid, uuid, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.accept_dispatch_assignment_secure(uuid, uuid, text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_dispatch_assignment_secure(uuid, uuid, text, uuid, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_dispatch_assignment_submitted_secure(uuid, uuid, text, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resume_employee_dispatch_session_secure(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recover_employee_dispatch_assignment_secure(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_server_dispatch_lifecycle()
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_next_dispatch_order(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_recover_stale_pending_orders(integer)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_cleanup_dispatch_system()
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.assign_next_dispatch_order_secure(uuid, uuid, text, uuid, uuid, text)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_pending_dispatch_assignment_secure(uuid, uuid, text, uuid, uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_dispatch_assignment_secure(uuid, uuid, text, uuid, uuid, text)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_dispatch_assignment_secure(uuid, uuid, text, uuid, text, text)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_dispatch_assignment_submitted_secure(uuid, uuid, text, uuid, text, uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resume_employee_dispatch_session_secure(uuid, uuid, text, uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_employee_dispatch_assignment_secure(uuid, uuid, text)
  TO anon, authenticated;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.dispatch_assignments
  FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS "Anyone can insert dispatch assignments" ON public.dispatch_assignments;
DROP POLICY IF EXISTS "Anyone can update dispatch assignments" ON public.dispatch_assignments;
DROP POLICY IF EXISTS "Anyone can delete dispatch assignments" ON public.dispatch_assignments;

DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(jobid)
    FROM cron.job
    WHERE jobname = 'auto_cleanup_dispatch_every_5min';

    IF NOT EXISTS (
      SELECT 1 FROM cron.job WHERE jobname = 'reconcile_dispatch_lifecycle_every_minute'
    ) THEN
      PERFORM cron.schedule(
        'reconcile_dispatch_lifecycle_every_minute',
        '* * * * *',
        $command$SELECT public.auto_cleanup_dispatch_system();$command$
      );
    END IF;
  END IF;
END;
$block$;
