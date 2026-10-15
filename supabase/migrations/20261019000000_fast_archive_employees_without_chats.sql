CREATE FUNCTION public.archive_employee_without_chats(
  p_admin_session_token uuid, p_user_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_admin uuid;
  v_role text;
  v_prepared jsonb;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'Employee account is required.'; END IF;
  PERFORM private.assert_admin_can_manage_user(v_admin, v_role, p_user_id);
  PERFORM pg_advisory_xact_lock(hashtext('employee_delete' || p_user_id::text));
  PERFORM 1 FROM public.users WHERE id = p_user_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee account was not found.'; END IF;

  IF EXISTS (SELECT 1 FROM public.customer_employee_conversations WHERE employee_id = p_user_id) THEN
    RETURN jsonb_build_object('requires_audit_service', true);
  END IF;

  v_prepared := public.prepare_content_audit_change(
    p_admin_session_token, 'employee_delete', ARRAY[p_user_id], NULL
  );
  IF jsonb_array_length(v_prepared -> 'snapshots' -> 'messages') <> 0 THEN
    RETURN jsonb_build_object('requires_audit_service', true);
  END IF;

  RETURN public.commit_content_audit_change(
    p_admin_session_token, 'employee_delete', ARRAY[p_user_id], NULL,
    v_prepared ->> 'hash', '{}'::jsonb, gen_random_uuid(), '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION public.archive_employee_without_chats(uuid, uuid)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.archive_employee_without_chats(uuid, uuid) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
