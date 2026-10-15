CREATE FUNCTION public.prepare_content_audit_conversation_delete(
  p_admin_session_token uuid, p_event_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_event private.content_audit_events%ROWTYPE;
  v_ids uuid[]; v_job uuid;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;

  SELECT * INTO v_event FROM private.content_audit_events WHERE id = p_event_id;
  IF v_event.id IS NULL OR v_event.action IS DISTINCT FROM 'conversation_delete'
    OR v_event.customer_id IS NULL OR v_event.employee_id IS NULL THEN
    RAISE EXCEPTION 'The selected record is not an entire conversation.';
  END IF;

  SELECT array_agg(id ORDER BY id) INTO v_ids FROM private.content_audit_events
  WHERE operation_id = v_event.operation_id AND entity_type = v_event.entity_type
    AND customer_id = v_event.customer_id AND employee_id = v_event.employee_id
    AND action = 'conversation_delete';
  IF v_ids IS NULL THEN RAISE EXCEPTION 'No matching audit records remain.'; END IF;

  DELETE FROM private.content_audit_delete_jobs WHERE expires_at < clock_timestamp() AND finished_at IS NULL;
  INSERT INTO private.content_audit_delete_jobs(admin_id, token_hash, target_ids, card_count)
  VALUES (v_admin, private.hash_financial_token(p_admin_session_token), v_ids, 1)
  RETURNING id INTO v_job;
  RETURN jsonb_build_object('job_id', v_job, 'card_count', 1, 'event_count', cardinality(v_ids));
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_content_audit_conversation_delete(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_content_audit_conversation_delete(uuid, uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
