-- Work-day automation targets count days from work_sessions, so retention must exceed the largest target.
UPDATE public.history_cleanup_config
SET retention_days = 400,
    updated_at = clock_timestamp()
WHERE table_name = 'work_sessions'
  AND retention_days < 400;
