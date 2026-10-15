/*
  # Schedule process_pending_orders as a pg_cron job

  1. Purpose
     - Guarantee pending orders resolve even when no user sessions are open.
     - Complements the in-app triggers (every 30s / 2min / post-submit) so that
       a freshly cloned database runs without any manual setup or Edge Function.

  2. Cron Job
     - Job name: process_pending_orders_every_minute
     - Schedule: every minute
     - Action: SELECT public.process_pending_orders();

  3. Notes
     - Uses cron.unschedule to remove any pre-existing job with the same name,
       making this migration safe to re-run.
     - pg_cron is already enabled in this project (see existing cleanup cron).
*/

DO $$
BEGIN
  PERFORM cron.unschedule('process_pending_orders_every_minute');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'process_pending_orders_every_minute',
  '* * * * *',
  $$SELECT public.process_pending_orders();$$
);

DO $$
DECLARE
  v_job_count int;
BEGIN
  SELECT COUNT(*) INTO v_job_count
  FROM cron.job
  WHERE jobname = 'process_pending_orders_every_minute';

  IF v_job_count = 0 THEN
    RAISE EXCEPTION 'Failed to create process_pending_orders cron job';
  END IF;

  RAISE NOTICE 'process_pending_orders cron job scheduled (every minute)';
END $$;
