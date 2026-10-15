DO $scope_content_audit$
DECLARE
  change record;
  definition text;
BEGIN
  FOR change IN
    SELECT * FROM (VALUES
      (
        'public.get_content_audit_filter_counts(uuid)'::regprocedure,
        E'FROM private.content_audit_events event\n  ), owner_counts AS (',
        E'FROM private.content_audit_events event\n    WHERE event.action NOT IN (''employee_delete'', ''admin_delete'')\n  ), owner_counts AS ('
      ),
      (
        'public.get_content_audit_filter_counts(uuid)'::regprocedure,
        E'WHERE event.owner_admin_id = counts.owner_admin_id\n',
        E'WHERE event.owner_admin_id = counts.owner_admin_id\n        AND event.action NOT IN (''employee_delete'', ''admin_delete'')\n'
      ),
      (
        'public.list_content_audit_cards(uuid, text, uuid, uuid, text, text, timestamptz, timestamptz, integer, integer)'::regprocedure,
        E'FROM private.content_audit_events event\n    WHERE (p_type IS NULL OR event.entity_type = p_type)',
        E'FROM private.content_audit_events event\n    WHERE event.action NOT IN (''employee_delete'', ''admin_delete'')\n      AND (p_type IS NULL OR event.entity_type = p_type)'
      ),
      (
        'public.list_content_audit_cards_filtered(uuid, text, uuid, text, text, text, timestamptz, timestamptz, integer, integer)'::regprocedure,
        E'FROM private.content_audit_events event\n    WHERE (p_type IS NULL OR event.entity_type = p_type)',
        E'FROM private.content_audit_events event\n    WHERE event.action NOT IN (''employee_delete'', ''admin_delete'')\n      AND (p_type IS NULL OR event.entity_type = p_type)'
      ),
      (
        'public.prepare_content_audit_delete(uuid, text, uuid, text, text, text, timestamptz, timestamptz, uuid)'::regprocedure,
        E'FROM private.content_audit_events event\n    WHERE (p_event_id IS NULL OR event.id = p_event_id)',
        E'FROM private.content_audit_events event\n    WHERE event.action NOT IN (''employee_delete'', ''admin_delete'')\n      AND (p_event_id IS NULL OR event.id = p_event_id)'
      )
    ) AS replacements(function_oid, old_text, new_text)
  LOOP
    definition := pg_get_functiondef(change.function_oid);
    IF length(definition) - length(replace(definition, change.old_text, '')) <> length(change.old_text) THEN
      RAISE EXCEPTION 'Unexpected audit function definition: %', change.function_oid;
    END IF;
    EXECUTE replace(definition, change.old_text, change.new_text);
  END LOOP;
END;
$scope_content_audit$;

REVOKE ALL ON FUNCTION public.get_content_audit_filter_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_content_audit_filter_counts(uuid) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.list_content_audit_cards(uuid, text, uuid, uuid, text, text, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_content_audit_cards(uuid, text, uuid, uuid, text, text, timestamptz, timestamptz, integer, integer) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.list_content_audit_cards_filtered(uuid, text, uuid, text, text, text, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_content_audit_cards_filtered(uuid, text, uuid, text, text, text, timestamptz, timestamptz, integer, integer) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_content_audit_delete(uuid, text, uuid, text, text, text, timestamptz, timestamptz, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_content_audit_delete(uuid, text, uuid, text, text, text, timestamptz, timestamptz, uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
