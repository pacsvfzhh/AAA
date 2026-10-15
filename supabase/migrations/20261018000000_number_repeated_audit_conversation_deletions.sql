CREATE INDEX content_audit_conversation_sequence_idx
ON private.content_audit_events (entity_type, customer_id, employee_id, operation_id, occurred_at)
WHERE action = 'conversation_delete';

DO $number_conversation_deletions$
DECLARE
  definition text;
  original text := 'cards.before_data -> ''message'' ->> ''audit_origin'' AS notification_origin,';
  replacement text := $fragment$cards.before_data -> 'message' ->> 'audit_origin' AS notification_origin,
      CASE WHEN cards.action = 'conversation_delete' THEN (
        SELECT ordered.delete_number FROM (
          SELECT prior.operation_id,
            row_number() OVER (ORDER BY min(prior.occurred_at), prior.operation_id) AS delete_number
          FROM private.content_audit_events prior
          WHERE prior.action = 'conversation_delete'
            AND prior.entity_type = cards.entity_type
            AND prior.customer_id = cards.customer_id
            AND prior.employee_id = cards.employee_id
          GROUP BY prior.operation_id
        ) ordered WHERE ordered.operation_id = cards.operation_id
      ) ELSE NULL END AS conversation_delete_number,$fragment$;
BEGIN
  definition := pg_get_functiondef('public.list_content_audit_cards_filtered(uuid, text, uuid, text, text, text, timestamptz, timestamptz, integer, integer)'::regprocedure);
  IF length(definition) - length(replace(definition, original, '')) <> length(original) THEN
    RAISE EXCEPTION 'Unexpected content audit listing definition.';
  END IF;
  EXECUTE replace(definition, original, replacement);
END;
$number_conversation_deletions$;

REVOKE ALL ON FUNCTION public.list_content_audit_cards_filtered(uuid, text, uuid, text, text, text, timestamptz, timestamptz, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_content_audit_cards_filtered(uuid, text, uuid, text, text, text, timestamptz, timestamptz, integer, integer) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
