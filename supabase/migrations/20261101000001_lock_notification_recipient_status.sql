-- Read and shown status may only change through the session-checked RPCs
-- (mark_employee_notification_read, complete_notification_delivery).
REVOKE UPDATE (is_read, is_shown, read_at, shown_at) ON public.message_recipients FROM anon, authenticated;

DROP POLICY IF EXISTS "Allow updating message recipients" ON public.message_recipients;

DO $block$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT procedure.oid::regprocedure
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN ('mark_message_as_read', 'mark_login_popup_as_shown')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_function);
  END LOOP;
END;
$block$;
