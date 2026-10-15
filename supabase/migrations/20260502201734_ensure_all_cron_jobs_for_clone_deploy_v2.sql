-- Ensure all required cron jobs on fresh deploys (v2).
-- Supersedes the earlier attempt where to_regproc returned NULL because it
-- was called with a signature instead of a bare name. This version uses the
-- bare name and is idempotent. Safe to run repeatedly.

CREATE EXTENSION IF NOT EXISTS pg_cron;

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
      NULL;
    END;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regproc('public.process_pending_orders') IS NOT NULL THEN
    PERFORM cron.schedule(
      'process_pending_orders_every_minute',
      '* * * * *',
      $cmd$SELECT public.process_pending_orders();$cmd$
    );
  ELSE
    RAISE NOTICE 'Skip: process_pending_orders missing';
  END IF;

  IF to_regproc('public.auto_cleanup_dispatch_system') IS NOT NULL THEN
    PERFORM cron.schedule(
      'auto_cleanup_dispatch_every_5min',
      '*/5 * * * *',
      $cmd$SELECT public.auto_cleanup_dispatch_system();$cmd$
    );
  ELSE
    RAISE NOTICE 'Skip: auto_cleanup_dispatch_system missing';
  END IF;

  IF to_regproc('public.auto_cleanup_all_tables') IS NOT NULL THEN
    PERFORM cron.schedule(
      'daily_auto_cleanup_history_data',
      '0 2 * * *',
      $cmd$SELECT public.auto_cleanup_all_tables();$cmd$
    );
  ELSE
    RAISE NOTICE 'Skip: auto_cleanup_all_tables missing';
  END IF;

  IF to_regproc('public.cleanup_all_practice_data') IS NOT NULL THEN
    PERFORM cron.schedule(
      'weekly_cleanup_practice_data',
      '0 2 * * 0',
      $cmd$SELECT public.cleanup_all_practice_data();$cmd$
    );
  ELSE
    RAISE NOTICE 'Skip: cleanup_all_practice_data missing';
  END IF;
END $$;
