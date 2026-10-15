DO $migration$
DECLARE
  v_function_definition text;
  v_updated_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.copy_shared_notification_automation_task(uuid, uuid)'::regprocedure
  )
  INTO v_function_definition;

  v_updated_definition := replace(
    v_function_definition,
    E'\n  IF v_admin_role <> ''secondary_admin'' THEN',
    E'\n  IF v_admin_role NOT IN (''secondary_admin'', ''super_admin'') THEN'
  );

  IF v_updated_definition = v_function_definition THEN
    RAISE EXCEPTION 'Copy template role restriction was not found.';
  END IF;

  EXECUTE v_updated_definition;
END;
$migration$;
