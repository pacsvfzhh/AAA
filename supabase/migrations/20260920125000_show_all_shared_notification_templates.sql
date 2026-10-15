DO $migration$
DECLARE
  v_function_definition text;
  v_updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.get_notification_automation_dashboard(uuid, uuid)'::regprocedure
  )
  INTO v_function_definition;

  v_updated_definition := replace(
    v_function_definition,
    E'\n          AND task.status IN (''active'', ''paused'')',
    ''
  );

  IF v_updated_definition = v_function_definition THEN
    RAISE EXCEPTION 'Shared template status filter was not found.';
  END IF;

  EXECUTE v_updated_definition;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
