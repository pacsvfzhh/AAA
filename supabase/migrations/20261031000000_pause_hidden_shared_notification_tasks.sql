-- The v2 automation dashboard cannot list or pause shared templates, yet the evaluator still runs active ones.
SELECT private.acquire_notification_automation_configuration_lock();

UPDATE public.notification_automation_tasks
SET status = 'paused',
    updated_at = clock_timestamp()
WHERE is_shared_template = true
  AND status = 'active';
