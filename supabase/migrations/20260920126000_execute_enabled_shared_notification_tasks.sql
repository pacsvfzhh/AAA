DO $migration$
DECLARE
  v_function_definition text;
  v_updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'private.evaluate_notification_automation_for_user(uuid, timestamptz)'::regprocedure
  )
  INTO v_function_definition;

  v_updated_definition := replace(
    v_function_definition,
    E'\n      AND task.is_shared_template = false',
    ''
  );

  IF v_updated_definition = v_function_definition THEN
    RAISE EXCEPTION 'Shared task execution filter was not found.';
  END IF;

  EXECUTE v_updated_definition;
END;
$migration$;
