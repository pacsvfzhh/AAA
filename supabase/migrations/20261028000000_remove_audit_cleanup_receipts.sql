DO $remove_maintenance_scope$
DECLARE
  signature regprocedure;
  definition text;
  independent_scope text := $scope$event.action IN ('edit', 'delete', 'conversation_delete', 'customer_delete', 'source_edit', 'source_delete')
      AND event.actor_admin_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM private.deleted_employee_accounts archive WHERE archive.operation_id = event.operation_id)
      AND NOT EXISTS (SELECT 1 FROM private.content_audit_events account_event
        WHERE account_event.operation_id = event.operation_id AND account_event.action IN ('employee_delete', 'admin_delete'))$scope$;
  maintenance_scope text := $scope$p_action = 'system_maintenance'
        AND event.entity_type = 'notification' AND event.action = 'delete'
        AND event.actor_role = 'system_maintenance'
        AND event.before_data ->> 'legacy_orphan_cleanup' = 'true'$scope$;
  old_scope text;
BEGIN
  old_scope := 'WHERE ((' || maintenance_scope || ') OR (p_action IS DISTINCT FROM ''system_maintenance'' AND ' || independent_scope || '))';
  FOREACH signature IN ARRAY ARRAY[
    'public.list_content_audit_cards_filtered(uuid, text, uuid, text, text, text, timestamptz, timestamptz, integer, integer)'::regprocedure,
    'public.prepare_content_audit_delete(uuid, text, uuid, text, text, text, timestamptz, timestamptz, uuid)'::regprocedure
  ] LOOP
    definition := pg_get_functiondef(signature);
    IF length(definition) - length(replace(definition, old_scope, '')) <> length(old_scope)
      OR strpos(definition, 'AND (p_action IS NULL OR p_action = ''system_maintenance'' OR event.action = p_action)') = 0 THEN
      RAISE EXCEPTION 'Unexpected audit scope definition: %', signature;
    END IF;
    definition := replace(definition, old_scope, 'WHERE ' || independent_scope);
    definition := replace(definition,
      'AND (p_action IS NULL OR p_action = ''system_maintenance'' OR event.action = p_action)',
      'AND (p_action IS NULL OR event.action = p_action)');
    definition := replace(definition,
      '''source_edit'', ''source_delete'', ''system_maintenance'') THEN',
      '''source_edit'', ''source_delete'') THEN');
    EXECUTE definition;
  END LOOP;
END;
$remove_maintenance_scope$;

DO $guard_legacy_clear$
BEGIN
  IF EXISTS (SELECT 1 FROM private.content_audit_events
    WHERE clear_started_at IS NOT NULL AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'A legacy evidence clear must finish before removing its endpoint.';
  END IF;
END;
$guard_legacy_clear$;

DROP FUNCTION public.begin_content_audit_clear(uuid, uuid, text);
DROP FUNCTION public.finish_content_audit_clear(uuid, uuid);

DO $remove_employee_image_receipts$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.recheck_deleted_employee_archive_media(uuid, uuid, text[])'::regprocedure);
  IF strpos(definition, 'v_shared_paths text[];') = 0
    OR strpos(definition, 'INSERT INTO private.retained_employee_chat_images(path)') = 0
    OR strpos(definition, 'claim.job_id <> p_job_id AND claim.deleted_at IS NULL') = 0
    OR strpos(definition, 'AND claim.deleted_at IS NOT NULL') = 0 THEN
    RAISE EXCEPTION 'Unexpected employee media recheck definition.';
  END IF;
  definition := replace(definition, 'v_retained integer; v_shared_paths text[];', 'v_retained integer;');
  definition := replace(definition,
    'WHERE claim.path = ANY(p_paths) AND claim.job_id <> p_job_id)',
    'WHERE claim.path = ANY(p_paths) AND claim.job_id IS DISTINCT FROM p_job_id)');
  definition := replace(definition,
    'claim.job_id <> p_job_id AND claim.deleted_at IS NULL',
    'claim.job_id <> p_job_id');
  definition := replace(definition,
    E'claim.job_id <> p_job_id\n          AND claim.deleted_at IS NOT NULL',
    'claim.job_id IS NULL');
  definition := replace(definition,
    E'    (SELECT count(*) FROM checked WHERE in_use),\n    (SELECT COALESCE(array_agg(path), ''{}''::text[]) FROM checked WHERE in_use)\n  INTO v_paths, v_retained, v_shared_paths',
    E'    (SELECT count(*) FROM checked WHERE in_use)\n  INTO v_paths, v_retained');
  definition := replace(definition,
    E'  INSERT INTO private.retained_employee_chat_images(path)\n  SELECT DISTINCT unnest(v_shared_paths) ON CONFLICT (path) DO NOTHING;\n',
    '');
  IF strpos(definition, 'deleted_at') > 0 OR strpos(definition, 'v_shared_paths') > 0
    OR strpos(definition, 'retained_employee_chat_images') > 0 THEN
    RAISE EXCEPTION 'Employee media receipt references remain.';
  END IF;
  EXECUTE definition;

  definition := pg_get_functiondef('public.complete_deleted_employee_archive_delete(uuid, uuid)'::regprocedure);
  IF strpos(definition, E'SET deleted_at = clock_timestamp()\n    WHERE job_id = p_job_id AND deleted_at IS NULL;') = 0 THEN
    RAISE EXCEPTION 'Unexpected employee media completion definition.';
  END IF;
  definition := replace(definition,
    E'SET deleted_at = clock_timestamp()\n    WHERE job_id = p_job_id AND deleted_at IS NULL;',
    E'SET job_id = NULL\n    WHERE job_id = p_job_id;');
  EXECUTE definition;
END;
$remove_employee_image_receipts$;

ALTER TABLE private.employee_chat_image_deletion_claims ALTER COLUMN job_id DROP NOT NULL;
UPDATE private.employee_chat_image_deletion_claims SET job_id = NULL WHERE deleted_at IS NOT NULL;
ALTER TABLE private.employee_chat_image_deletion_claims
  DROP COLUMN claimed_at,
  DROP COLUMN deleted_at;
DROP TABLE private.retained_employee_chat_images;

NOTIFY pgrst, 'reload schema';
