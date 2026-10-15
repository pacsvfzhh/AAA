CREATE FUNCTION public.list_deleted_employee_withdrawals(
  p_admin_session_token uuid, p_record_id uuid, p_page integer DEFAULT 0, p_page_size integer DEFAULT 30
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_role text;
  v_employee_id uuid;
  v_cleared_at timestamptz;
  v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF p_page NOT BETWEEN 0 AND 100000 OR p_page_size NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid withdrawal page.';
  END IF;
  SELECT employee_id, cleared_at INTO v_employee_id, v_cleared_at
  FROM private.deleted_employee_accounts WHERE id = p_record_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Employee archive is not available.'; END IF;
  IF v_cleared_at IS NOT NULL THEN
    RETURN jsonb_build_object('items', '[]'::jsonb, 'total', 0);
  END IF;

  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM public.withdrawals WHERE user_id = v_employee_id),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY page.created_at DESC NULLS LAST, page.id DESC)
      FROM (SELECT id, amount, status, created_at FROM public.withdrawals
        WHERE user_id = v_employee_id
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT p_page_size OFFSET p_page::bigint * p_page_size) page), '[]'::jsonb)
  ) INTO v_result;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.list_deleted_employee_withdrawals(uuid, uuid, integer, integer)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_deleted_employee_withdrawals(uuid, uuid, integer, integer)
TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
