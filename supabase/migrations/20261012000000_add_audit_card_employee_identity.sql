CREATE OR REPLACE FUNCTION public.list_content_audit_cards_filtered(
  p_admin_session_token uuid, p_type text DEFAULT NULL, p_owner uuid DEFAULT NULL,
  p_action text DEFAULT NULL, p_content_search text DEFAULT NULL, p_identity_search text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL,
  p_page integer DEFAULT 0, p_page_size integer DEFAULT 30
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb; v_content text; v_identity text;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF p_page NOT BETWEEN 0 AND 100000 OR p_page_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid page size.'; END IF;
  v_content := lower(NULLIF(btrim(p_content_search), ''));
  v_identity := lower(NULLIF(btrim(p_identity_search), ''));

  WITH matching AS (
    SELECT event.id,
      CASE WHEN event.action = 'conversation_delete' THEN concat(
        'conversation:', event.operation_id, ':', event.entity_type, ':', event.customer_id, ':', event.employee_id)
        ELSE concat('event:', event.id) END AS card_id
    FROM private.content_audit_events event
    WHERE (p_type IS NULL OR event.entity_type = p_type)
      AND (p_owner IS NULL OR event.owner_admin_id = p_owner)
      AND (p_action IS NULL OR event.action = p_action)
      AND (p_from IS NULL OR event.occurred_at >= p_from)
      AND (p_to IS NULL OR event.occurred_at < p_to)
      AND (v_content IS NULL OR strpos(lower(concat_ws(' ',
        event.before_data #>> '{message,title}', event.after_data #>> '{message,title}',
        event.before_data #>> '{message,subtitle}', event.after_data #>> '{message,subtitle}',
        event.before_data #>> '{message,content}', event.after_data #>> '{message,content}',
        event.before_data #>> '{message,message_content}', event.after_data #>> '{message,message_content}',
        event.before_data #>> '{message,rating_data,comment}', event.after_data #>> '{message,rating_data,comment}',
        event.before_data ->> 'rendered_html', event.after_data ->> 'rendered_html'
      )), v_content) > 0)
      AND (v_identity IS NULL OR (event.entity_type IN ('aaa_service', 'ccc_service')
        AND strpos(lower(concat_ws(' ',
          event.before_data ->> 'customer_name', event.employee_account,
          event.before_data ->> 'employee_name',
          CASE WHEN event.before_data IS NOT NULL THEN
            COALESCE(event.before_data ->> 'employee_number',
              (SELECT employee.employee_id FROM public.users employee WHERE employee.id = event.employee_id))
          END
        )), v_identity) > 0))
  ), cards AS (
    SELECT DISTINCT ON (matching.card_id) matching.card_id, event.id, event.operation_id,
      event.entity_type, event.entity_id, event.action, event.owner_admin_id, event.owner_username,
      event.actor_admin_id, event.actor_username, event.actor_role, event.customer_id, event.employee_id,
      event.employee_account, event.occurred_at, event.cleared_at, event.clear_started_at,
      event.before_data
    FROM matching JOIN private.content_audit_events event ON event.id = matching.id
    ORDER BY matching.card_id, event.occurred_at DESC, event.id DESC
  ), page_cards AS MATERIALIZED (
    SELECT cards.*, CASE WHEN entity_type = 'notification' THEN
      jsonb_array_length(COALESCE(before_data -> 'recipients', '[]'::jsonb)) ELSE 0 END AS recipient_count
    FROM cards ORDER BY occurred_at DESC, id DESC
    LIMIT p_page_size OFFSET p_page * p_page_size
  ), page AS (
    SELECT cards.card_id, cards.id, cards.operation_id, cards.entity_type, cards.entity_id,
      cards.action, cards.owner_admin_id, cards.owner_username, cards.actor_admin_id,
      cards.actor_username, cards.actor_role, cards.customer_id, cards.employee_id,
      CASE WHEN cards.cleared_at IS NOT NULL THEN NULL
        WHEN cards.entity_type = 'notification' THEN
          CASE WHEN cards.recipient_count = 1 THEN recipients.account_username
          WHEN cards.recipient_count > 1 THEN '收件員工 ' || cards.recipient_count || ' 位'
          ELSE NULL END
        ELSE COALESCE(cards.employee_account, archived.account_username,
          CASE WHEN employee.archived_at IS NULL THEN employee.username END) END AS employee_account,
      CASE WHEN cards.cleared_at IS NOT NULL THEN NULL
        WHEN cards.entity_type = 'notification' THEN
          CASE WHEN cards.recipient_count = 1 THEN recipients.employee_number END
        ELSE COALESCE(cards.before_data ->> 'employee_number', archived.employee_number,
          CASE WHEN employee.archived_at IS NULL THEN employee.employee_id END) END AS employee_number,
      CASE WHEN cards.cleared_at IS NOT NULL THEN NULL
        WHEN cards.entity_type = 'notification' THEN
          CASE WHEN cards.recipient_count = 1 THEN recipients.employee_number_source END
        WHEN cards.before_data ->> 'employee_number' IS NOT NULL THEN 'event_snapshot'
        WHEN archived.employee_number IS NOT NULL THEN 'archived_account'
        WHEN employee.archived_at IS NULL AND employee.employee_id IS NOT NULL THEN 'current_account'
        ELSE NULL END AS employee_number_source,
      cards.recipient_count,
      cards.occurred_at, cards.cleared_at, cards.clear_started_at,
      CASE WHEN cards.action = 'conversation_delete' THEN NULL
        ELSE left(COALESCE(cards.before_data -> 'message' ->> 'title',
          cards.before_data -> 'message' ->> 'message_content', ''), 160) END AS summary,
      cards.before_data -> 'message' ->> 'audit_origin' AS notification_origin,
      CASE WHEN cards.action = 'conversation_delete' THEN (
        SELECT count(*) FROM private.content_audit_events item
        WHERE item.operation_id = cards.operation_id AND item.entity_type = cards.entity_type
          AND item.customer_id = cards.customer_id AND item.employee_id = cards.employee_id
          AND item.action = 'conversation_delete') ELSE 1 END AS message_count,
      CASE WHEN cards.action = 'conversation_delete' THEN (
        SELECT count(*) FROM private.content_audit_events item
        WHERE item.operation_id = cards.operation_id AND item.entity_type = cards.entity_type
          AND item.customer_id = cards.customer_id AND item.employee_id = cards.employee_id
          AND item.action = 'conversation_delete' AND item.cleared_at IS NOT NULL)
        ELSE CASE WHEN cards.cleared_at IS NULL THEN 0 ELSE 1 END END AS cleared_count
    FROM page_cards cards
    LEFT JOIN public.users employee ON employee.id = cards.employee_id
    LEFT JOIN private.deleted_employee_accounts archived ON archived.employee_id = cards.employee_id
    LEFT JOIN LATERAL (
      SELECT max(COALESCE(record.account_username,
          CASE WHEN recipient_user.archived_at IS NULL THEN recipient_user.username END)) AS account_username,
        max(COALESCE(record.employee_number,
          CASE WHEN recipient_user.archived_at IS NULL THEN recipient_user.employee_id END)) AS employee_number,
        max(CASE WHEN record.employee_number IS NOT NULL THEN 'archived_account'
          WHEN recipient_user.archived_at IS NULL AND recipient_user.employee_id IS NOT NULL THEN 'current_account'
          ELSE NULL END) AS employee_number_source
      FROM jsonb_array_elements(CASE WHEN cards.recipient_count = 1 THEN
        cards.before_data -> 'recipients' ELSE '[]'::jsonb END) recipient(data)
      LEFT JOIN public.users recipient_user ON recipient_user.id = (recipient.data ->> 'recipient_id')::uuid
      LEFT JOIN private.deleted_employee_accounts record ON record.employee_id = (recipient.data ->> 'recipient_id')::uuid
    ) recipients ON cards.entity_type = 'notification'
  )
  SELECT jsonb_build_object('total', (SELECT count(*) FROM cards),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.occurred_at DESC, page.id DESC)
      FROM page), '[]'::jsonb)) INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.list_content_audit_cards_filtered FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_content_audit_cards_filtered TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
