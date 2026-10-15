CREATE INDEX content_audit_events_employee_id_idx ON private.content_audit_events(employee_id)
WHERE employee_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.list_unpurged_archived_employees(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'employee_id', employee.id,
    'original_username', identity.original_username,
    'archived_alias', employee.username,
    'owner_username', owner.username,
    'archived_at', employee.archived_at,
    'order_count', (SELECT count(*) FROM public.orders item WHERE item.user_id = employee.id),
    'processing_order_count', (SELECT count(*) FROM public.orders item WHERE item.user_id = employee.id AND item.status = 'processing'),
    'historical_order_count',
      (SELECT count(*) FROM public.orders_history item WHERE item.user_id = employee.id)
      + (SELECT count(*) FROM public.orders_history_2025 item WHERE item.user_id = employee.id)
      + (SELECT count(*) FROM public.orders_history_2026 item WHERE item.user_id = employee.id),
    'withdrawal_count', (SELECT count(*) FROM public.withdrawals item WHERE item.user_id = employee.id),
    'pending_withdrawal_count', (SELECT count(*) FROM public.withdrawals item WHERE item.user_id = employee.id AND item.status = 'pending'),
    'available_balance', (SELECT available_balance FROM public.wallets wallet WHERE wallet.user_id = employee.id),
    'frozen_balance', (SELECT frozen_balance FROM public.wallets wallet WHERE wallet.user_id = employee.id),
    'audit_count', (SELECT count(*) FROM private.content_audit_events event WHERE event.employee_id = employee.id),
    'active_chat_count', (SELECT count(*) FROM public.customer_employee_conversations chat WHERE chat.employee_id = employee.id),
    'candidate_image_count', media.candidate_count,
    'quick_send_image_count', media.quick_send_count
  ) ORDER BY employee.archived_at DESC, employee.id), '[]'::jsonb) INTO v_result
  FROM public.users employee
  LEFT JOIN public.admins owner ON owner.id = employee.created_by
  LEFT JOIN LATERAL (
    SELECT CASE WHEN count(DISTINCT history.username) = 1 THEN min(history.username) ELSE NULL END AS original_username
    FROM public.employee_login_history history
    WHERE history.user_id = employee.id AND history.username <> employee.username
      AND history.username NOT LIKE 'archived-%'
  ) identity ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS candidate_count,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.cs_message_templates template
        WHERE strpos(COALESCE(template.content, ''), image.path) > 0
      )) AS quick_send_count
    FROM (
      SELECT DISTINCT substring(ref.url FROM '/storage/v1/object/public/chat-images/([^?#]+)$') AS path
      FROM private.content_audit_events event
      CROSS JOIN LATERAL jsonb_object_keys(COALESCE(event.media_refs, '{}'::jsonb)) ref(url)
      WHERE event.employee_id = employee.id
    ) image
    JOIN storage.objects object ON object.bucket_id = 'chat-images' AND object.name = image.path
  ) media ON true
  WHERE employee.archived_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM private.deleted_employee_accounts record WHERE record.employee_id = employee.id);
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.prepare_unpurged_archived_employee_delete(
  p_admin_session_token uuid, p_employee_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_employee public.users%ROWTYPE;
  v_original_username text; v_job uuid;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT * INTO v_employee FROM public.users WHERE id = p_employee_id AND archived_at IS NOT NULL FOR UPDATE;
  IF v_employee.id IS NULL OR EXISTS (
    SELECT 1 FROM private.deleted_employee_accounts WHERE employee_id = p_employee_id
  ) THEN RAISE EXCEPTION 'Archived employee without a private record is not available.'; END IF;
  SELECT CASE WHEN count(DISTINCT history.username) = 1 THEN min(history.username) ELSE NULL END
  INTO v_original_username
  FROM public.employee_login_history history
  WHERE history.user_id = v_employee.id AND history.username <> v_employee.username
    AND history.username NOT LIKE 'archived-%';
  IF v_original_username IS NULL THEN RAISE EXCEPTION 'Archived employee identity cannot be uniquely verified.'; END IF;
  INSERT INTO private.deleted_employee_delete_jobs(
    admin_id, token_hash, account_ids, notification_ids, notification_count,
    account_fingerprint, notification_fingerprint, orphan_employee_ids, orphan_fingerprint
  ) VALUES (v_admin, private.hash_financial_token(p_admin_session_token), '{}'::uuid[], '{}'::uuid[], 0,
    md5('[]'), md5('[]'), ARRAY[p_employee_id], md5(to_jsonb(v_employee)::text))
  RETURNING id INTO v_job;
  RETURN jsonb_build_object('job_id', v_job, 'account_count', 1, 'notification_count', 0,
    'original_username', v_original_username);
END;
$$;
