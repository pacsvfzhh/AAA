CREATE OR REPLACE FUNCTION private.queue_automation_from_employee_login()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  IF NEW.action_type = 'login' THEN
    PERFORM private.queue_notification_automation_user(NEW.user_id);

    BEGIN
      IF pg_try_advisory_xact_lock(hashtextextended('notification_automation_queue', 0)) THEN
        PERFORM private.evaluate_notification_automation_for_user(NEW.user_id);

        DELETE FROM public.notification_automation_queue
        WHERE user_id = NEW.user_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN NEW;
END;
$function$;
