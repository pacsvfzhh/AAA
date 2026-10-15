/*
  # Ensure all required cron jobs on fresh deploys

  1. Purpose
    - Guarantee that cloning this database to a new Supabase project yields
      a fully working system with zero manual dashboard steps.
    - Enables the pg_cron extension and (re)schedules every cron job the app
      depends on. Safe to run repeatedly.

  2. Extensions enabled
    - `pg_cron` in schema `pg_catalog` (standard for Supabase).

  3. Cron jobs registered (idempotent via unschedule-then-schedule)
    - `process_pending_orders_every_minute`  -> SELECT process_pending_orders()
        every minute. Resolves orders to success/failure.
    - `auto_cleanup_dispatch_every_5min`     -> SELECT auto_cleanup_dispatch_system()
        every 5 minutes. Closes stale sessions, recovers stuck pending orders.
    - `daily_auto_cleanup_history_data`      -> SELECT auto_cleanup_all_tables()
        daily at 02:00. History retention cleanup.
    - `weekly_cleanup_practice_data`         -> SELECT cleanup_all_practice_data()
        weekly Sunday 02:00. Deep cleanup of practice/test data.

  4. Safety
    - Does not create or alter any table, policy, or application function.
    - If pg_cron is already present the CREATE EXTENSION is a no-op.
    - Each job is first unscheduled (ignoring "not found") then rescheduled,
      so repeated runs never duplicate jobs.
    - Each target function is checked with `to_regproc`; if a function is
      missing, we skip that specific job and RAISE NOTICE instead of failing.
*/

-- Enable pg_cron (no-op if already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Helper: unschedule a job by name, ignoring "not found"
DO $$
DECLARE
  v_names text[] := ARRAY[
    'process_pending_orders_every_minute',
    'auto_cleanup_dispatch_every_5min',
    'daily_auto_cleanup_history_data',
    'weekly_cleanup_practice_data'
  ];
  v_name text;
BEGIN
  FOREACH v_name IN ARRAY v_names LOOP
    BEGIN
      PERFORM cron.unschedule(v_name);
    EXCEPTION WHEN OTHERS THEN
      -- Job did not exist; that's fine.
      NULL;
    END;
  END LOOP;
END $$;

-- Schedule: process pending orders every minute
DO $$
BEGIN
  IF to_regproc('public.process_pending_orders()') IS NOT NULL THEN
    PERFORM cron.schedule(
      'process_pending_orders_every_minute',
      '* * * * *',
      $cmd$SELECT public.process_pending_orders();$cmd$
    );
  ELSE
    RAISE NOTICE 'Skipping process_pending_orders_every_minute: function missing';
  END IF;
END $$;

-- Schedule: dispatch session cleanup every 5 minutes
DO $$
BEGIN
  IF to_regproc('public.auto_cleanup_dispatch_system()') IS NOT NULL THEN
    PERFORM cron.schedule(
      'auto_cleanup_dispatch_every_5min',
      '*/5 * * * *',
      $cmd$SELECT public.auto_cleanup_dispatch_system();$cmd$
    );
  ELSE
    RAISE NOTICE 'Skipping auto_cleanup_dispatch_every_5min: function missing';
  END IF;
END $$;

-- Schedule: daily history data cleanup at 02:00
DO $$
BEGIN
  IF to_regproc('public.auto_cleanup_all_tables()') IS NOT NULL THEN
    PERFORM cron.schedule(
      'daily_auto_cleanup_history_data',
      '0 2 * * *',
      $cmd$SELECT public.auto_cleanup_all_tables();$cmd$
    );
  ELSE
    RAISE NOTICE 'Skipping daily_auto_cleanup_history_data: function missing';
  END IF;
END $$;

-- Schedule: weekly practice data cleanup (Sunday 02:00)
DO $$
BEGIN
  IF to_regproc('public.cleanup_all_practice_data()') IS NOT NULL THEN
    PERFORM cron.schedule(
      'weekly_cleanup_practice_data',
      '0 2 * * 0',
      $cmd$SELECT public.cleanup_all_practice_data();$cmd$
    );
  ELSE
    RAISE NOTICE 'Skipping weekly_cleanup_practice_data: function missing';
  END IF;
END $$;

-- Report: list all cron jobs now registered
DO $$
DECLARE
  v_row RECORD;
BEGIN
  RAISE NOTICE 'Cron jobs after migration:';
  FOR v_row IN SELECT jobname, schedule, active FROM cron.job ORDER BY jobname LOOP
    RAISE NOTICE '  % | % | active=%', v_row.jobname, v_row.schedule, v_row.active;
  END LOOP;
END $$;
