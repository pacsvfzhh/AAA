DO $separate_content_audit$
DECLARE
  change record;
  definition text;
  old_scope text := 'WHERE event.action NOT IN (''employee_delete'', ''admin_delete'')';
  independent_scope text := $scope$event.action IN ('edit', 'delete', 'conversation_delete', 'customer_delete', 'source_edit', 'source_delete')
      AND event.actor_admin_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM private.deleted_employee_accounts archive WHERE archive.operation_id = event.operation_id)
      AND NOT EXISTS (SELECT 1 FROM private.content_audit_events account_event
        WHERE account_event.operation_id = event.operation_id AND account_event.action IN ('employee_delete', 'admin_delete'))$scope$;
  maintenance_scope text := $scope$p_action = 'system_maintenance'
        AND event.entity_type = 'notification' AND event.action = 'delete'
        AND event.actor_role = 'system_maintenance'
        AND event.before_data ->> 'legacy_orphan_cleanup' = 'true'$scope$;
  old_action text := 'AND (p_action IS NULL OR event.action = p_action)';
BEGIN
  FOR change IN SELECT * FROM (VALUES
    ('public.get_content_audit_filter_counts(uuid)'::regprocedure, 'counts'),
    ('public.list_content_audit_cards(uuid, text, uuid, uuid, text, text, timestamptz, timestamptz, integer, integer)'::regprocedure, 'cards'),
    ('public.list_content_audit_cards_filtered(uuid, text, uuid, text, text, text, timestamptz, timestamptz, integer, integer)'::regprocedure, 'filtered'),
    ('public.prepare_content_audit_delete(uuid, text, uuid, text, text, text, timestamptz, timestamptz, uuid)'::regprocedure, 'prepare')
  ) AS functions(signature, kind) LOOP
    definition := pg_get_functiondef(change.signature);
    IF length(definition) - length(replace(definition, old_scope, '')) <> length(old_scope) THEN
      RAISE EXCEPTION 'Unexpected audit function definition: %', change.signature;
    END IF;

    definition := replace(definition, old_scope,
      CASE WHEN change.kind IN ('filtered', 'prepare') THEN
        'WHERE ((' || maintenance_scope || ') OR (p_action IS DISTINCT FROM ''system_maintenance'' AND ' || independent_scope || '))'
      ELSE 'WHERE ' || independent_scope END);

    IF change.kind = 'counts' THEN
      IF strpos(definition, 'AND event.action NOT IN (''employee_delete'', ''admin_delete'')') = 0 THEN
        RAISE EXCEPTION 'Unexpected audit owner counts definition.';
      END IF;
      definition := replace(definition,
        'AND event.action NOT IN (''employee_delete'', ''admin_delete'')',
        'AND ' || independent_scope);
    ELSIF change.kind IN ('filtered', 'prepare') THEN
      IF length(definition) - length(replace(definition, old_action, '')) <> length(old_action) THEN
        RAISE EXCEPTION 'Unexpected audit action filter definition: %', change.signature;
      END IF;
      definition := replace(definition, old_action,
        'AND (p_action IS NULL OR p_action = ''system_maintenance'' OR event.action = p_action)');
    END IF;

    IF change.kind = 'prepare' THEN
      IF strpos(definition, '''source_edit'', ''source_delete'') THEN') = 0 THEN
        RAISE EXCEPTION 'Unexpected audit delete validation definition.';
      END IF;
      definition := replace(definition,
        '''employee_delete'', ''admin_delete'', ''source_edit'', ''source_delete'') THEN',
        '''source_edit'', ''source_delete'', ''system_maintenance'') THEN');
    END IF;

    EXECUTE definition;
  END LOOP;
END;
$separate_content_audit$;

NOTIFY pgrst, 'reload schema';
