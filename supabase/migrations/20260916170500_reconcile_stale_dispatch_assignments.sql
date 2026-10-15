/*
  Reconcile assignments that outlive the employee page.
  This covers browser crashes, abandoned accepted orders, and submitted orders
  whose final feedback was not recorded from the dispatch page.
*/

CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_stale_accepted
  ON public.dispatch_assignments (accepted_at)
  WHERE status = 'accepted';

CREATE OR REPLACE FUNCTION public.reconcile_stale_dispatch_assignments(
  p_unsubmitted_timeout_minutes integer DEFAULT 10,
  p_submitted_timeout_minutes integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_unsubmitted_timeout integer := GREATEST(COALESCE(p_unsubmitted_timeout_minutes, 10), 1);
  v_submitted_timeout integer := GREATEST(COALESCE(p_submitted_timeout_minutes, 30), 1);
  v_auto_completed integer := 0;
  v_auto_failed integer := 0;
  v_unsubmitted_timed_out integer := 0;
  v_submitted_timed_out integer := 0;
BEGIN
  WITH finalized AS (
    UPDATE public.dispatch_assignments AS da
    SET
      status = CASE WHEN o.status = 'success' THEN 'completed' ELSE 'error' END,
      completed_at = COALESCE(o.processed_at, now()),
      remarks = CASE
        WHEN o.status = 'success' THEN 'Auto-completed from processed order result'
        ELSE 'Auto-marked error from processed order result'
      END
    FROM public.orders AS o
    WHERE da.status = 'accepted'
      AND o.assignment_id = da.assignment_id
      AND o.status IN ('success', 'failure', 'error')
    RETURNING da.status
  )
  SELECT
    COUNT(*) FILTER (WHERE status = 'completed'),
    COUNT(*) FILTER (WHERE status = 'error')
  INTO v_auto_completed, v_auto_failed
  FROM finalized;

  WITH timed_out AS (
    UPDATE public.dispatch_assignments AS da
    SET
      status = 'timeout',
      completed_at = now(),
      remarks = 'Auto-timeout: accepted order was not submitted within '
        || v_unsubmitted_timeout || ' minutes'
    WHERE da.status = 'accepted'
      AND da.order_submitted = false
      AND da.accepted_at IS NOT NULL
      AND da.accepted_at < now() - make_interval(mins => v_unsubmitted_timeout)
      AND NOT EXISTS (
        SELECT 1
        FROM public.orders AS submitted_order
        WHERE submitted_order.assignment_id = da.assignment_id
      )
    RETURNING da.id
  )
  SELECT COUNT(*) INTO v_unsubmitted_timed_out FROM timed_out;

  WITH stale_submissions AS (
    SELECT
      da.id,
      COALESCE(MAX(o.created_at), da.accepted_at) AS last_submission_time
    FROM public.dispatch_assignments AS da
    LEFT JOIN public.orders AS o
      ON o.assignment_id = da.assignment_id
    WHERE da.status = 'accepted'
      AND (
        da.order_submitted = true
        OR EXISTS (
          SELECT 1
          FROM public.orders AS submitted_order
          WHERE submitted_order.assignment_id = da.assignment_id
        )
      )
    GROUP BY da.id, da.accepted_at
  ),
  timed_out AS (
    UPDATE public.dispatch_assignments AS da
    SET
      status = 'timeout',
      completed_at = now(),
      remarks = 'Auto-timeout: submitted order did not produce a final result within '
        || v_submitted_timeout || ' minutes'
    FROM stale_submissions AS stale
    WHERE da.id = stale.id
      AND stale.last_submission_time IS NOT NULL
      AND stale.last_submission_time < now() - make_interval(mins => v_submitted_timeout)
    RETURNING da.id
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

CREATE OR REPLACE FUNCTION public.auto_cleanup_dispatch_system()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_recovered_orders integer;
  v_work_result json;
  v_dispatch_cleaned integer;
  v_assignment_result jsonb;
BEGIN
  IF NOT pg_try_advisory_xact_lock(8675312) THEN
    RETURN json_build_object(
      'skipped', true,
      'reason', 'previous cron still running'
    );
  END IF;

  SELECT COALESCE((public.auto_recover_stale_pending_orders(5)->>'recovered_count')::integer, 0)
  INTO v_recovered_orders;

  SELECT public.cleanup_stale_work_sessions_optimized() INTO v_work_result;

  SELECT COUNT(*) INTO v_dispatch_cleaned
  FROM public.cleanup_stale_dispatch_sessions();

  SELECT public.reconcile_stale_dispatch_assignments(10, 30)
  INTO v_assignment_result;

  RETURN json_build_object(
    'recovered_orders', v_recovered_orders,
    'work_sessions', v_work_result,
    'dispatch_sessions_cleaned', v_dispatch_cleaned,
    'assignments', v_assignment_result,
    'executed_at', now()
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reconcile_stale_dispatch_assignments(integer, integer)
  TO anon, authenticated;
