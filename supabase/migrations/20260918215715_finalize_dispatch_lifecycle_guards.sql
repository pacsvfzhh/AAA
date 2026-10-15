CREATE OR REPLACE FUNCTION public.reconcile_stale_dispatch_assignments(
  p_unsubmitted_timeout_minutes integer DEFAULT 10,
  p_submitted_timeout_minutes integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_default_unsubmitted_timeout integer := GREATEST(COALESCE(p_unsubmitted_timeout_minutes, 10), 1);
  v_submitted_timeout integer := GREATEST(COALESCE(p_submitted_timeout_minutes, 30), 1);
  v_auto_completed integer := 0;
  v_auto_failed integer := 0;
  v_unsubmitted_timed_out integer := 0;
  v_submitted_timed_out integer := 0;
BEGIN
  WITH finalized AS (
    UPDATE public.dispatch_assignments AS assignment
    SET status = CASE WHEN submitted_order.status = 'success' THEN 'completed' ELSE 'error' END,
        completed_at = COALESCE(submitted_order.processed_at, now()),
        remarks = CASE
          WHEN submitted_order.status = 'success' THEN 'Auto-completed from processed order result'
          ELSE 'Auto-marked error from processed order result'
        END
    FROM public.orders AS submitted_order
    WHERE assignment.status = 'accepted'
      AND submitted_order.assignment_id = assignment.assignment_id
      AND submitted_order.status IN ('success', 'failure', 'error')
    RETURNING assignment.status
  )
  SELECT COUNT(*) FILTER (WHERE status = 'completed'),
         COUNT(*) FILTER (WHERE status = 'error')
  INTO v_auto_completed, v_auto_failed
  FROM finalized;

  WITH timed_out AS (
    UPDATE public.dispatch_assignments AS assignment
    SET status = 'timeout',
        completed_at = now(),
        remarks = 'Auto-timeout: accepted order was not submitted within configured group time'
    FROM public.dispatch_group_orders AS dispatch_order
    LEFT JOIN public.dispatch_groups AS dispatch_group
      ON dispatch_group.id = dispatch_order.group_id
    WHERE assignment.dispatch_order_id = dispatch_order.id
      AND assignment.status = 'accepted'
      AND assignment.order_submitted = false
      AND assignment.accepted_at IS NOT NULL
      AND assignment.accepted_at < now() - make_interval(
        mins => GREATEST(
          COALESCE(dispatch_group.session_timeout_minutes, v_default_unsubmitted_timeout),
          1
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.orders AS submitted_order
        WHERE submitted_order.assignment_id = assignment.assignment_id
      )
    RETURNING assignment.id
  )
  SELECT COUNT(*) INTO v_unsubmitted_timed_out FROM timed_out;

  WITH stale_submissions AS (
    SELECT assignment.id,
           COALESCE(MAX(submitted_order.created_at), assignment.accepted_at) AS last_submission_time
    FROM public.dispatch_assignments AS assignment
    LEFT JOIN public.orders AS submitted_order
      ON submitted_order.assignment_id = assignment.assignment_id
    WHERE assignment.status = 'accepted'
      AND (
        assignment.order_submitted = true
        OR EXISTS (
          SELECT 1
          FROM public.orders AS existing_order
          WHERE existing_order.assignment_id = assignment.assignment_id
        )
      )
    GROUP BY assignment.id, assignment.accepted_at
  ),
  timed_out AS (
    UPDATE public.dispatch_assignments AS assignment
    SET status = 'timeout',
        completed_at = now(),
        remarks = 'Auto-timeout: submitted order did not produce a final result within '
          || v_submitted_timeout || ' minutes'
    FROM stale_submissions AS stale
    WHERE assignment.id = stale.id
      AND stale.last_submission_time IS NOT NULL
      AND stale.last_submission_time < now() - make_interval(mins => v_submitted_timeout)
    RETURNING assignment.id
  )
  SELECT COUNT(*) INTO v_submitted_timed_out FROM timed_out;

  RETURN jsonb_build_object(
    'success', true,
    'auto_completed', v_auto_completed,
    'auto_failed', v_auto_failed,
    'unsubmitted_timed_out', v_unsubmitted_timed_out,
    'submitted_timed_out', v_submitted_timed_out,
    'checked_at', now()
  );
END;
$function$;

REVOKE ALL ON TABLE public.dispatch_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.dispatch_assignments TO anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reconcile_stale_dispatch_assignments(integer, integer)
  FROM PUBLIC, anon, authenticated;
