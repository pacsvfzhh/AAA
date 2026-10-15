ALTER TABLE private.deleted_employee_delete_jobs
  ADD COLUMN finished_at timestamptz,
  ADD COLUMN paths_to_remove jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN orphan_employee_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN orphan_fingerprint text;

DO $update_expired_jobs$
DECLARE definition text;
BEGIN
  definition := pg_get_functiondef('public.prepare_deleted_employee_archive_delete(uuid, uuid, text, uuid, uuid)'::regprocedure);
  IF strpos(definition, 'DELETE FROM private.deleted_employee_delete_jobs WHERE expires_at <= clock_timestamp();') = 0 THEN
    RAISE EXCEPTION 'Unexpected employee delete preparation definition.';
  END IF;
  EXECUTE replace(definition,
    'DELETE FROM private.deleted_employee_delete_jobs WHERE expires_at <= clock_timestamp();',
    'DELETE FROM private.deleted_employee_delete_jobs WHERE expires_at <= clock_timestamp() AND finished_at IS NULL;');
END;
$update_expired_jobs$;

CREATE OR REPLACE FUNCTION private.archive_employee_before_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM private.deleted_employee_delete_jobs job
    LEFT JOIN private.deleted_employee_accounts record ON record.id = ANY(job.account_ids)
    WHERE job.id = NULLIF(current_setting('employee_purge.job_id', true), '')::uuid
      AND (record.employee_id = OLD.id OR OLD.id = ANY(job.orphan_employee_ids))
      AND job.finished_at IS NULL
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Employee accounts must be archived, not physically deleted.';
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_user_storage_files()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM private.deleted_employee_delete_jobs job
    LEFT JOIN private.deleted_employee_accounts record ON record.id = ANY(job.account_ids)
    WHERE job.id = NULLIF(current_setting('employee_purge.job_id', true), '')::uuid
      AND (record.employee_id = OLD.id OR OLD.id = ANY(job.orphan_employee_ids))
      AND job.finished_at IS NULL
  ) THEN
    RETURN OLD;
  END IF;

  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.objects object
  WHERE object.bucket_id = 'verification-documents'
    AND (object.name LIKE 'id-front/' || OLD.id::text || '-%'
      OR object.name LIKE 'id-back/' || OLD.id::text || '-%'
      OR object.name LIKE 'selfie/' || OLD.id::text || '-%');
  RETURN OLD;
END;
$$;

CREATE FUNCTION public.list_unpurged_archived_employees(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  SELECT admin_role INTO v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'employee_id', employee.id, 'archived_at', employee.archived_at,
    'order_count', (SELECT count(*) FROM public.orders order_row WHERE order_row.user_id = employee.id),
    'audit_count', (SELECT count(*) FROM private.content_audit_events event WHERE event.employee_id = employee.id)
  ) ORDER BY employee.archived_at DESC), '[]'::jsonb) INTO v_result
  FROM public.users employee
  WHERE employee.archived_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM private.deleted_employee_accounts record WHERE record.employee_id = employee.id);
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.prepare_unpurged_archived_employee_delete(
  p_admin_session_token uuid, p_employee_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_employee public.users%ROWTYPE; v_job uuid;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT * INTO v_employee FROM public.users WHERE id = p_employee_id AND archived_at IS NOT NULL FOR UPDATE;
  IF v_employee.id IS NULL OR EXISTS (
    SELECT 1 FROM private.deleted_employee_accounts WHERE employee_id = p_employee_id
  ) THEN RAISE EXCEPTION 'Archived employee without a private record is not available.'; END IF;
  INSERT INTO private.deleted_employee_delete_jobs(
    admin_id, token_hash, account_ids, notification_ids, notification_count,
    account_fingerprint, notification_fingerprint, orphan_employee_ids, orphan_fingerprint
  ) VALUES (v_admin, private.hash_financial_token(p_admin_session_token), '{}'::uuid[], '{}'::uuid[], 0,
    md5('[]'), md5('[]'), ARRAY[p_employee_id], md5(to_jsonb(v_employee)::text))
  RETURNING id INTO v_job;
  RETURN jsonb_build_object('job_id', v_job, 'account_count', 1, 'notification_count', 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_deleted_employee_archive_delete(
  p_admin_session_token uuid, p_job_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_admin uuid;
  v_role text;
  v_job private.deleted_employee_delete_jobs%ROWTYPE;
  v_employee_ids uuid[];
  v_operation_ids text[];
  v_notification_count integer;
  v_event_count integer;
  v_paths jsonb;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Super administrator permission is required.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('content-audit-purge-media'));
  SELECT * INTO v_job FROM private.deleted_employee_delete_jobs WHERE id = p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR (v_job.finished_at IS NULL AND (
    v_job.admin_id IS DISTINCT FROM v_admin
    OR v_job.token_hash IS DISTINCT FROM private.hash_financial_token(p_admin_session_token)
    OR v_job.expires_at <= clock_timestamp())) THEN
    RAISE EXCEPTION 'Deletion confirmation has expired. Preview the records again.';
  END IF;
  IF v_job.finished_at IS NOT NULL THEN
    RETURN jsonb_build_object('success', true, 'deleted_accounts', cardinality(v_job.account_ids) + cardinality(v_job.orphan_employee_ids),
      'deleted_notifications', v_job.notification_count, 'paths_to_remove', v_job.paths_to_remove);
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
      FROM private.deleted_employee_notifications n WHERE n.id = ANY(v_job.notification_ids)) <> v_job.notification_fingerprint THEN
    RAISE EXCEPTION 'Private notifications changed. Preview the records again.';
  END IF;

  SELECT array_agg(employee_id ORDER BY employee_id) INTO v_employee_ids
  FROM private.deleted_employee_accounts WHERE id = ANY(v_job.account_ids);
  v_employee_ids := COALESCE(v_employee_ids, '{}'::uuid[]) || v_job.orphan_employee_ids;
  PERFORM 1 FROM public.users WHERE id = ANY(v_employee_ids) ORDER BY id FOR UPDATE;
  IF v_job.orphan_fingerprint IS NOT NULL AND (
    cardinality(v_job.orphan_employee_ids) <> 1 OR
    (SELECT md5(to_jsonb(employee)::text) FROM public.users employee
      WHERE employee.id = v_job.orphan_employee_ids[1] AND employee.archived_at IS NOT NULL)
      IS DISTINCT FROM v_job.orphan_fingerprint OR
    EXISTS (SELECT 1 FROM private.deleted_employee_accounts
      WHERE employee_id = v_job.orphan_employee_ids[1])
  ) THEN RAISE EXCEPTION 'Archived employee changed. Preview the deletion again.'; END IF;
  IF cardinality(v_employee_ids) > 0 AND (
    (SELECT count(*) FROM public.users WHERE id = ANY(v_employee_ids) AND archived_at IS NOT NULL)
      <> cardinality(v_employee_ids)
    OR EXISTS (SELECT 1 FROM public.customer_employee_conversations WHERE employee_id = ANY(v_employee_ids))
  ) THEN
    RAISE EXCEPTION 'Employee data changed or still has active chat. Deletion stopped.';
  END IF;

  WITH identities AS (
    SELECT record.account_username AS username, record.deleted_at AS cutoff
      FROM private.deleted_employee_accounts record WHERE record.id = ANY(v_job.account_ids)
    UNION
    SELECT history.username, employee.archived_at
      FROM public.employee_login_history history
      JOIN public.users employee ON employee.id = history.user_id
      WHERE employee.id = ANY(v_employee_ids)
    UNION
    SELECT event.employee_account, employee.archived_at
      FROM private.content_audit_events event
      JOIN public.users employee ON employee.id = event.employee_id
      WHERE employee.id = ANY(v_employee_ids)
  )
  DELETE FROM public.login_attempts attempts USING identities source_account
  WHERE source_account.username IS NOT NULL AND attempts.identifier = source_account.username
    AND attempts.attempt_time <= source_account.cutoff;
  WITH identities AS (
    SELECT record.account_username AS username, record.deleted_at AS cutoff
      FROM private.deleted_employee_accounts record WHERE record.id = ANY(v_job.account_ids)
    UNION
    SELECT history.username, employee.archived_at
      FROM public.employee_login_history history
      JOIN public.users employee ON employee.id = history.user_id
      WHERE employee.id = ANY(v_employee_ids)
    UNION
    SELECT event.employee_account, employee.archived_at
      FROM private.content_audit_events event
      JOIN public.users employee ON employee.id = event.employee_id
      WHERE employee.id = ANY(v_employee_ids)
  )
  DELETE FROM public.financial_login_attempts attempts USING identities source_account
  WHERE source_account.username IS NOT NULL AND attempts.account_type = 'employee'
    AND attempts.username = source_account.username AND attempts.last_attempt_at <= source_account.cutoff;

  SELECT array_agg(DISTINCT operation_id::text) INTO v_operation_ids
  FROM private.content_audit_events WHERE employee_id = ANY(v_employee_ids);
  DELETE FROM private.content_audit_events WHERE employee_id = ANY(v_employee_ids);
  GET DIAGNOSTICS v_event_count = ROW_COUNT;
  DELETE FROM private.content_audit_recipient_versions WHERE recipient_id = ANY(v_employee_ids);
  UPDATE private.content_audit_events event
  SET before_data = CASE WHEN jsonb_typeof(event.before_data -> 'recipients') = 'array'
    THEN jsonb_set(event.before_data, '{recipients}', (
      SELECT COALESCE(jsonb_agg(recipient.data ORDER BY recipient.position), '[]'::jsonb)
      FROM jsonb_array_elements(event.before_data -> 'recipients') WITH ORDINALITY recipient(data, position)
      WHERE recipient.data ->> 'recipient_id' IS NULL
        OR recipient.data ->> 'recipient_id' <> ALL(v_employee_ids::text[])
    )) ELSE event.before_data END,
    after_data = CASE WHEN jsonb_typeof(event.after_data -> 'recipients') = 'array'
    THEN jsonb_set(event.after_data, '{recipients}', (
      SELECT COALESCE(jsonb_agg(recipient.data ORDER BY recipient.position), '[]'::jsonb)
      FROM jsonb_array_elements(event.after_data -> 'recipients') WITH ORDINALITY recipient(data, position)
      WHERE recipient.data ->> 'recipient_id' IS NULL
        OR recipient.data ->> 'recipient_id' <> ALL(v_employee_ids::text[])
    )) ELSE event.after_data END
  WHERE cardinality(v_employee_ids) > 0 AND event.entity_type = 'notification'
    AND (event.before_data -> 'recipients' IS NOT NULL OR event.after_data -> 'recipients' IS NOT NULL);
  DELETE FROM private.deleted_employee_notifications
  WHERE record_id = ANY(v_job.account_ids) OR id = ANY(v_job.notification_ids);

  SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', files.bucket_id, 'path', files.name)), '[]'::jsonb)
    INTO v_paths
  FROM storage.objects files
  WHERE (files.bucket_id = 'content-audit-evidence'
    AND split_part(files.name, '/', 1) = ANY(COALESCE(v_operation_ids, ARRAY[]::text[]))
    AND NOT EXISTS (
      SELECT 1 FROM private.content_audit_events event
      CROSS JOIN LATERAL jsonb_each_text(COALESCE(event.media_refs, '{}'::jsonb)) ref
      WHERE event.cleared_at IS NULL AND ref.value = files.name
    ))
    OR (files.bucket_id = 'verification-documents' AND EXISTS (
      SELECT 1 FROM unnest(v_employee_ids) id
      WHERE files.name LIKE 'id-front/' || id::text || '-%'
        OR files.name LIKE 'id-back/' || id::text || '-%'
        OR files.name LIKE 'selfie/' || id::text || '-%'
    ));

  IF cardinality(v_employee_ids) > 0 THEN
    PERFORM set_config('employee_purge.job_id', p_job_id::text, true);
    DELETE FROM public.notification_automation_executions WHERE user_id = ANY(v_employee_ids);
    DELETE FROM public.financial_operations WHERE actor_id = ANY(v_employee_ids);
    DELETE FROM public.wallet_balance_baselines WHERE user_id = ANY(v_employee_ids);
    DELETE FROM public.wallet_reconciliation_audit WHERE user_id = ANY(v_employee_ids);
    DELETE FROM public.wallet_ledger_entries WHERE user_id = ANY(v_employee_ids);
    DELETE FROM public.orders_history WHERE user_id = ANY(v_employee_ids);
    DELETE FROM public.orders_history_2025 WHERE user_id = ANY(v_employee_ids);
    DELETE FROM public.orders_history_2026 WHERE user_id = ANY(v_employee_ids);
    DELETE FROM public.users WHERE id = ANY(v_employee_ids);
    DELETE FROM public.wallet_ledger_entries WHERE user_id = ANY(v_employee_ids);
    DELETE FROM public.wallet_reconciliation_audit WHERE user_id = ANY(v_employee_ids);
    DELETE FROM public.wallet_balance_baselines WHERE user_id = ANY(v_employee_ids);
    PERFORM set_config('employee_purge.job_id', '', true);
    IF EXISTS (SELECT 1 FROM public.users WHERE id = ANY(v_employee_ids)) THEN
      RAISE EXCEPTION 'Employee cleanup was incomplete.';
    END IF;
  END IF;

  DELETE FROM private.deleted_employee_accounts WHERE id = ANY(v_job.account_ids);
  UPDATE private.deleted_employee_delete_jobs
  SET finished_at = clock_timestamp(), paths_to_remove = v_paths WHERE id = p_job_id;
  RETURN jsonb_build_object('success', true, 'deleted_accounts', cardinality(v_job.account_ids) + cardinality(v_job.orphan_employee_ids),
    'deleted_notifications', v_notification_count, 'deleted_audit_events', v_event_count,
    'paths_to_remove', v_paths);
END;
$$;

CREATE FUNCTION public.complete_deleted_employee_archive_delete(
  p_admin_session_token uuid, p_job_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_job private.deleted_employee_delete_jobs%ROWTYPE;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT * INTO v_job FROM private.deleted_employee_delete_jobs WHERE id = p_job_id FOR UPDATE;
  IF v_job.id IS NULL OR v_job.finished_at IS NULL THEN
    RAISE EXCEPTION 'Employee deletion has not finished.';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.objects object
    WHERE (object.bucket_id, object.name) IN (
      SELECT item ->> 'bucket', item ->> 'path'
      FROM jsonb_array_elements(v_job.paths_to_remove) item
    )) THEN RAISE EXCEPTION 'Employee media cleanup is incomplete.'; END IF;
  DELETE FROM private.deleted_employee_delete_jobs WHERE id = p_job_id;
  RETURN jsonb_build_object('success', true);
END;
$$;

CREATE FUNCTION public.list_pending_deleted_employee_archive_deletes(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_jobs jsonb;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('job_id', id, 'file_count', jsonb_array_length(paths_to_remove))
    ORDER BY finished_at), '[]'::jsonb) INTO v_jobs
  FROM private.deleted_employee_delete_jobs
  WHERE finished_at IS NOT NULL;
  RETURN v_jobs;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_deleted_employee_archive_delete(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_deleted_employee_archive_delete(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_pending_deleted_employee_archive_deletes(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_unpurged_archived_employees(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_unpurged_archived_employee_delete(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_unpurged_archived_employees(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_unpurged_archived_employee_delete(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_deleted_employee_archive_delete(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_deleted_employee_archive_delete(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_pending_deleted_employee_archive_deletes(uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
