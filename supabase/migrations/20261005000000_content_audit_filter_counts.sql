CREATE FUNCTION public.get_content_audit_filter_counts(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role <> 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;

  WITH cards AS MATERIALIZED (
    SELECT DISTINCT event.owner_admin_id, event.entity_type,
      CASE WHEN event.action = 'conversation_delete' THEN concat(
        'conversation:', event.operation_id, ':', event.entity_type, ':', event.customer_id, ':', event.employee_id)
        ELSE concat('event:', event.id) END AS card_id
    FROM private.content_audit_events event
  ), owner_counts AS (
    SELECT owner_admin_id, count(*) AS event_count FROM cards GROUP BY owner_admin_id
  ), owners AS (
    SELECT admin.id, admin.username, COALESCE(counts.event_count, 0) AS event_count
    FROM public.admins admin LEFT JOIN owner_counts counts ON counts.owner_admin_id = admin.id
    UNION ALL
    SELECT counts.owner_admin_id, COALESCE(latest.owner_username, counts.owner_admin_id::text), counts.event_count
    FROM owner_counts counts
    LEFT JOIN public.admins admin ON admin.id = counts.owner_admin_id
    LEFT JOIN LATERAL (
      SELECT event.owner_username FROM private.content_audit_events event
      WHERE event.owner_admin_id = counts.owner_admin_id
      ORDER BY event.occurred_at DESC, event.id DESC LIMIT 1
    ) latest ON true
    WHERE admin.id IS NULL
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM cards),
    'types', (SELECT jsonb_build_object(
      'notification', count(*) FILTER (WHERE entity_type = 'notification'),
      'aaa_service', count(*) FILTER (WHERE entity_type = 'aaa_service'),
      'ccc_service', count(*) FILTER (WHERE entity_type = 'ccc_service')
    ) FROM cards),
    'owners', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', id, 'username', username, 'event_count', event_count)
      ORDER BY username, id) FROM owners), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_content_audit_filter_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_content_audit_filter_counts(uuid) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
