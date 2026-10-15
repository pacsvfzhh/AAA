-- Tasks created before automation plans have no plan and are not listed in the desktop dashboard.
SELECT private.acquire_notification_automation_configuration_lock();

DELETE FROM public.notification_automation_tasks
WHERE plan_id IS NULL
  AND is_shared_template = false;
