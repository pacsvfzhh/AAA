CREATE OR REPLACE FUNCTION public.process_notification_automation_queue_fast(
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_item record;
  v_processed integer := 0;
  v_notifications integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('notification_automation_queue', 0)) THEN
    RETURN jsonb_build_object(
      'success', true,
      'skipped', true,
      'processed_users', 0,
      'created_notifications', 0
    );
  END IF;

  FOR v_item IN
    SELECT queue.user_id
    FROM public.notification_automation_queue AS queue
    WHERE queue.next_attempt_at <= clock_timestamp()
    ORDER BY queue.requested_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  LOOP
    BEGIN
      v_notifications := v_notifications
        + private.evaluate_notification_automation_for_user(v_item.user_id);

      DELETE FROM public.notification_automation_queue
      WHERE user_id = v_item.user_id;

      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.notification_automation_queue
      SET attempts = attempts + 1,
          next_attempt_at = clock_timestamp() + make_interval(
            secs => LEAST(300, 5 * (attempts + 1))
          ),
          last_error = left(SQLERRM, 500)
      WHERE user_id = v_item.user_id;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'processed_users', v_processed,
    'created_notifications', v_notifications
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.process_notification_automation_queue_fast(integer)
FROM PUBLIC, anon, authenticated;

DO $block$
BEGIN
  PERFORM cron.unschedule(job.jobid)
  FROM cron.job AS job
  WHERE job.jobname = 'process_notification_automation_queue_every_five_seconds';

  PERFORM cron.schedule(
    'process_notification_automation_queue_every_five_seconds',
    '5 seconds',
    'SELECT public.process_notification_automation_queue_fast(200);'
  );
END;
$block$;
