ALTER TABLE private.content_audit_events
  ADD COLUMN employee_account text,
  ADD COLUMN message_created_at timestamptz;

UPDATE private.content_audit_events event
SET employee_account = COALESCE(event.before_data ->> 'employee_name',
      (SELECT username FROM public.users WHERE id = event.employee_id)),
    message_created_at = (event.before_data -> 'message' ->> 'created_at')::timestamptz
WHERE event.entity_type IN ('aaa_service', 'ccc_service') AND event.before_data IS NOT NULL;

CREATE FUNCTION private.capture_content_audit_display_metadata()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF NEW.entity_type IN ('aaa_service', 'ccc_service') THEN
    NEW.employee_account := COALESCE(NEW.before_data ->> 'employee_name',
      (SELECT username FROM public.users WHERE id = NEW.employee_id));
    NEW.message_created_at := (NEW.before_data -> 'message' ->> 'created_at')::timestamptz;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER capture_content_audit_display_metadata
BEFORE INSERT ON private.content_audit_events
FOR EACH ROW EXECUTE FUNCTION private.capture_content_audit_display_metadata();

CREATE INDEX content_audit_conversation_order_idx
ON private.content_audit_events (operation_id, entity_type, customer_id, employee_id, message_created_at, id)
WHERE action = 'conversation_delete';

CREATE FUNCTION public.list_content_audit_cards(
  p_admin_session_token uuid, p_type text DEFAULT NULL, p_owner uuid DEFAULT NULL, p_actor uuid DEFAULT NULL,
  p_action text DEFAULT NULL, p_search text DEFAULT NULL, p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL, p_page integer DEFAULT 0, p_page_size integer DEFAULT 30
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF p_page NOT BETWEEN 0 AND 100000 OR p_page_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid page size.'; END IF;

  WITH matching AS (
    SELECT event.id,
      CASE WHEN event.action = 'conversation_delete' THEN concat(
        'conversation:', event.operation_id, ':', event.entity_type, ':', event.customer_id, ':', event.employee_id)
        ELSE concat('event:', event.id) END AS card_id
    FROM private.content_audit_events event
    WHERE (p_type IS NULL OR event.entity_type = p_type)
      AND (p_owner IS NULL OR event.owner_admin_id = p_owner)
      AND (p_actor IS NULL OR event.actor_admin_id = p_actor)
      AND (p_action IS NULL OR event.action = p_action)
      AND (p_from IS NULL OR event.occurred_at >= p_from)
      AND (p_to IS NULL OR event.occurred_at < p_to)
      AND (p_search IS NULL OR event.actor_username ILIKE '%' || p_search || '%'
        OR event.entity_id::text = p_search OR event.customer_id::text = p_search
        OR event.employee_id::text = p_search OR event.before_data::text ILIKE '%' || p_search || '%')
  ), cards AS (
    SELECT DISTINCT ON (matching.card_id) matching.card_id, event.id, event.operation_id,
      event.entity_type, event.entity_id, event.action, event.owner_admin_id, event.owner_username,
      event.actor_admin_id, event.actor_username, event.actor_role, event.customer_id, event.employee_id,
      event.employee_account, event.occurred_at, event.cleared_at, event.clear_started_at,
      event.before_data
    FROM matching JOIN private.content_audit_events event ON event.id = matching.id
    ORDER BY matching.card_id, event.occurred_at DESC, event.id DESC
  ), page AS (
    SELECT cards.card_id, cards.id, cards.operation_id, cards.entity_type, cards.entity_id,
      cards.action, cards.owner_admin_id, cards.owner_username, cards.actor_admin_id,
      cards.actor_username, cards.actor_role, cards.customer_id, cards.employee_id,
      cards.employee_account, cards.occurred_at, cards.cleared_at, cards.clear_started_at,
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
    FROM cards ORDER BY cards.occurred_at DESC, cards.id DESC
    LIMIT p_page_size OFFSET p_page * p_page_size
  )
  SELECT jsonb_build_object('total', (SELECT count(*) FROM cards),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.occurred_at DESC, page.id DESC)
      FROM page), '[]'::jsonb)) INTO v_result;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.get_content_audit_conversation(
  p_admin_session_token uuid, p_operation_id uuid, p_type text,
  p_customer_id uuid, p_employee_id uuid, p_page integer DEFAULT 0, p_page_size integer DEFAULT 100
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF p_type NOT IN ('aaa_service', 'ccc_service') OR p_page NOT BETWEEN 0 AND 100000
    OR p_page_size NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid conversation request.'; END IF;

  WITH thread AS MATERIALIZED (
    SELECT event.id, event.occurred_at, event.message_created_at, event.employee_account
    FROM private.content_audit_events event
    WHERE event.operation_id = p_operation_id AND event.entity_type = p_type
      AND event.customer_id = p_customer_id AND event.employee_id = p_employee_id
      AND event.action = 'conversation_delete'
  ), page AS (
    SELECT event.id, event.occurred_at, event.message_created_at, event.before_data,
      event.media_refs, event.cleared_at, event.clear_started_at
    FROM (SELECT * FROM thread ORDER BY message_created_at NULLS LAST, occurred_at, id
      LIMIT p_page_size OFFSET p_page * p_page_size) selected
    JOIN private.content_audit_events event ON event.id = selected.id
  )
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM thread) THEN NULL ELSE jsonb_build_object(
    'operation_id', p_operation_id, 'entity_type', p_type,
    'occurred_at', (SELECT max(occurred_at) FROM thread),
    'employee_id', p_employee_id,
    'employee_account', COALESCE((SELECT employee_account FROM thread
      WHERE employee_account IS NOT NULL LIMIT 1),
      (SELECT username FROM public.users WHERE id = p_employee_id), p_employee_id::text),
    'total', (SELECT count(*) FROM thread),
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', item.id, 'occurred_at', item.occurred_at, 'created_at', item.message_created_at,
      'sender_type', item.before_data -> 'message' ->> 'sender_type',
      'message_type', item.before_data -> 'message' ->> 'message_type',
      'message_content', item.before_data -> 'message' ->> 'message_content',
      'image_url', item.before_data -> 'message' ->> 'image_url',
      'title', item.before_data -> 'message' ->> 'title',
      'subtitle', item.before_data -> 'message' ->> 'subtitle',
      'rating_data', item.before_data -> 'message' -> 'rating_data',
      'rendered_html', item.before_data ->> 'rendered_html',
      'media_refs', item.media_refs,
      'cleared_at', item.cleared_at, 'clear_started_at', item.clear_started_at
    ) ORDER BY item.message_created_at NULLS LAST, item.occurred_at, item.id)
    FROM page item), '[]'::jsonb)
  ) END INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION private.capture_content_audit_display_metadata() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_content_audit_cards(uuid, text, uuid, uuid, text, text, timestamptz, timestamptz, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_content_audit_conversation(uuid, uuid, text, uuid, uuid, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_content_audit_cards(uuid, text, uuid, uuid, text, text, timestamptz, timestamptz, integer, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_content_audit_conversation(uuid, uuid, text, uuid, uuid, integer, integer) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
