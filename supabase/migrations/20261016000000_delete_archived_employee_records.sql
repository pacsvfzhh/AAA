CREATE TABLE private.deleted_employee_delete_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL,
  token_hash text NOT NULL,
  account_ids uuid[] NOT NULL,
  notification_ids uuid[] NOT NULL,
  notification_count integer NOT NULL,
  account_fingerprint text NOT NULL,
  notification_fingerprint text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '5 minutes'
);
REVOKE ALL ON private.deleted_employee_delete_jobs FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.prepare_deleted_employee_archive_delete(
  p_admin_session_token uuid, p_owner uuid, p_search text,
  p_record_id uuid, p_notification_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_search text; v_accounts uuid[]; v_notifications uuid[];
  v_notification_count integer; v_job uuid; v_account_fingerprint text; v_notification_fingerprint text;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  IF length(COALESCE(p_search, '')) > 100 OR (p_record_id IS NOT NULL AND p_notification_id IS NOT NULL)
    OR (p_notification_id IS NOT NULL AND (p_owner IS NOT NULL OR p_search IS NOT NULL))
    OR (p_record_id IS NOT NULL AND (p_owner IS NOT NULL OR p_search IS NOT NULL)) THEN
    RAISE EXCEPTION 'Invalid archive selection.';
  END IF;
  v_search := NULLIF(btrim(p_search), '');
  IF p_notification_id IS NOT NULL THEN
    SELECT ARRAY[]::uuid[], array_agg(n.id) INTO v_accounts, v_notifications
    FROM private.deleted_employee_notifications n
    JOIN private.deleted_employee_accounts record ON record.id = n.record_id
    WHERE n.id = p_notification_id;
  ELSE
    SELECT array_agg(record.id ORDER BY record.id) INTO v_accounts
    FROM private.deleted_employee_accounts record
    WHERE (p_record_id IS NULL OR record.id = p_record_id)
      AND (p_owner IS NULL OR record.owner_admin_id = p_owner)
      AND (v_search IS NULL OR record.account_username ILIKE '%' || v_search || '%'
        OR record.account_real_name ILIKE '%' || v_search || '%'
        OR record.employee_number ILIKE '%' || v_search || '%');
    SELECT array_agg(n.id ORDER BY n.id) INTO v_notifications
    FROM private.deleted_employee_notifications n WHERE n.record_id = ANY(v_accounts);
  END IF;
  v_accounts := COALESCE(v_accounts, ARRAY[]::uuid[]);
  v_notifications := COALESCE(v_notifications, ARRAY[]::uuid[]);
  IF cardinality(v_accounts) = 0 AND cardinality(v_notifications) = 0 THEN
    RAISE EXCEPTION 'No matching employee archive records remain.';
  END IF;
  v_notification_count := cardinality(v_notifications);
  SELECT md5(COALESCE(jsonb_agg(to_jsonb(record) ORDER BY record.id)::text, '[]')) INTO v_account_fingerprint
  FROM private.deleted_employee_accounts record WHERE record.id = ANY(v_accounts);
  SELECT md5(COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.id)::text, '[]')) INTO v_notification_fingerprint
  FROM private.deleted_employee_notifications n WHERE n.id = ANY(v_notifications);
  DELETE FROM private.deleted_employee_delete_jobs WHERE expires_at <= clock_timestamp();
  INSERT INTO private.deleted_employee_delete_jobs(
    admin_id, token_hash, account_ids, notification_ids, notification_count, account_fingerprint, notification_fingerprint
  ) VALUES (
    v_admin, private.hash_financial_token(p_admin_session_token), v_accounts, v_notifications,
    v_notification_count, v_account_fingerprint, v_notification_fingerprint
  )
  RETURNING id INTO v_job;
  RETURN jsonb_build_object('job_id', v_job, 'account_count', cardinality(v_accounts),
    'notification_count', v_notification_count);
END;
$$;

CREATE FUNCTION public.finish_deleted_employee_archive_delete(p_admin_session_token uuid, p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_job private.deleted_employee_delete_jobs%ROWTYPE;
  v_notification_count integer;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT * INTO v_job FROM private.deleted_employee_delete_jobs WHERE id = p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.admin_id IS DISTINCT FROM v_admin
    OR v_job.token_hash IS DISTINCT FROM private.hash_financial_token(p_admin_session_token)
    OR v_job.expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'Deletion confirmation has expired. Preview the records again.';
  END IF;
  PERFORM 1 FROM private.deleted_employee_accounts WHERE id = ANY(v_job.account_ids) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM private.deleted_employee_accounts WHERE id = ANY(v_job.account_ids)) <> cardinality(v_job.account_ids)
    OR (SELECT md5(COALESCE(jsonb_agg(to_jsonb(record) ORDER BY record.id)::text, '[]'))
        FROM private.deleted_employee_accounts record WHERE record.id = ANY(v_job.account_ids)) <> v_job.account_fingerprint THEN
    RAISE EXCEPTION 'Employee archive records changed. Preview the records again.';
  END IF;
  PERFORM 1 FROM private.deleted_employee_notifications
  WHERE record_id = ANY(v_job.account_ids) OR id = ANY(v_job.notification_ids) ORDER BY id FOR UPDATE;
  SELECT count(*) INTO v_notification_count FROM private.deleted_employee_notifications
  WHERE record_id = ANY(v_job.account_ids) OR id = ANY(v_job.notification_ids);
  IF v_notification_count <> v_job.notification_count OR EXISTS (
    SELECT 1 FROM unnest(v_job.notification_ids) target(id)
    WHERE NOT EXISTS (SELECT 1 FROM private.deleted_employee_notifications n WHERE n.id = target.id)
  ) OR (SELECT md5(COALESCE(jsonb_agg(to_jsonb(n) ORDER BY n.id)::text, '[]'))
      FROM private.deleted_employee_notifications n WHERE n.id = ANY(v_job.notification_ids)) <> v_job.notification_fingerprint
    THEN RAISE EXCEPTION 'Private notifications changed. Preview the records again.'; END IF;

  DELETE FROM private.deleted_employee_notifications
  WHERE record_id = ANY(v_job.account_ids) OR id = ANY(v_job.notification_ids);
  DELETE FROM private.deleted_employee_accounts WHERE id = ANY(v_job.account_ids);
  DELETE FROM private.deleted_employee_delete_jobs WHERE id = p_job_id;
  RETURN jsonb_build_object('success', true, 'deleted_accounts', cardinality(v_job.account_ids),
    'deleted_notifications', v_notification_count);
END;
$$;

REVOKE ALL ON FUNCTION public.clear_deleted_employee_account(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_deleted_employee_notification(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_deleted_employee_archive_delete(uuid, uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_deleted_employee_archive_delete(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_deleted_employee_archive_delete(uuid, uuid, text, uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_deleted_employee_archive_delete(uuid, uuid) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
