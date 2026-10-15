-- Shared templates can no longer be shown, copied or managed from the v2 automation dashboard.
SELECT private.acquire_notification_automation_configuration_lock();

DELETE FROM public.notification_automation_tasks
WHERE is_shared_template = true;
