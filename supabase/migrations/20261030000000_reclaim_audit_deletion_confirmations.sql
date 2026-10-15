CREATE FUNCTION private.collect_audit_deletion_confirmations()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_content integer; v_employee integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('content-audit-purge-media'));
  DELETE FROM private.content_audit_delete_jobs job
  WHERE job.finished_at IS NULL AND (
    job.expires_at <= clock_timestamp()
    OR EXISTS (SELECT 1 FROM unnest(job.target_ids) target(id)
      WHERE NOT EXISTS (SELECT 1 FROM private.content_audit_events event WHERE event.id = target.id))
  );
  GET DIAGNOSTICS v_content = ROW_COUNT;
  DELETE FROM private.deleted_employee_delete_jobs job
  WHERE job.finished_at IS NULL AND (
    job.expires_at <= clock_timestamp()
    OR EXISTS (SELECT 1 FROM unnest(job.account_ids) target(id)
      WHERE NOT EXISTS (SELECT 1 FROM private.deleted_employee_accounts account WHERE account.id = target.id))
    OR EXISTS (SELECT 1 FROM unnest(job.notification_ids) target(id)
      WHERE NOT EXISTS (SELECT 1 FROM private.deleted_employee_notifications notification WHERE notification.id = target.id))
    OR EXISTS (SELECT 1 FROM unnest(job.orphan_employee_ids) target(id)
      WHERE NOT EXISTS (SELECT 1 FROM public.users employee WHERE employee.id = target.id AND employee.archived_at IS NOT NULL))
  );
  GET DIAGNOSTICS v_employee = ROW_COUNT;
  RETURN jsonb_build_object('content_confirmations', v_content, 'employee_confirmations', v_employee);
END;
$$;
REVOKE ALL ON FUNCTION private.collect_audit_deletion_confirmations() FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.cancel_audit_deletion_confirmation(
  p_admin_session_token uuid, p_job_kind text, p_job_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_cancelled integer;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('content-audit-purge-media'));
  IF p_job_kind = 'content' THEN
    DELETE FROM private.content_audit_delete_jobs
    WHERE id = p_job_id AND admin_id = v_admin
      AND token_hash = private.hash_financial_token(p_admin_session_token) AND finished_at IS NULL;
  ELSIF p_job_kind = 'employee' THEN
    DELETE FROM private.deleted_employee_delete_jobs
    WHERE id = p_job_id AND admin_id = v_admin
      AND token_hash = private.hash_financial_token(p_admin_session_token) AND finished_at IS NULL;
  ELSE RAISE EXCEPTION 'Invalid deletion confirmation kind.'; END IF;
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'cancelled', v_cancelled > 0);
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_audit_deletion_confirmation(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_audit_deletion_confirmation(uuid, text, uuid) TO service_role;

DO $collect_before_prepare$
DECLARE v_signature regprocedure; v_definition text;
  v_anchor text := 'IF v_role IS DISTINCT FROM ''super_admin'' THEN RAISE EXCEPTION ''Super administrator permission is required.''; END IF;';
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.prepare_content_audit_delete(uuid, text, uuid, text, text, text, timestamptz, timestamptz, uuid)'::regprocedure,
    'public.prepare_content_audit_conversation_delete(uuid, uuid)'::regprocedure,
    'public.prepare_deleted_employee_archive_delete(uuid, uuid, text, uuid, uuid)'::regprocedure,
    'public.prepare_unpurged_archived_employee_delete(uuid, uuid)'::regprocedure
  ] LOOP
    v_definition := pg_get_functiondef(v_signature);
    IF strpos(v_definition, v_anchor) = 0 THEN RAISE EXCEPTION 'Unexpected deletion preparation definition: %', v_signature; END IF;
    v_definition := replace(v_definition,
      'DELETE FROM private.content_audit_delete_jobs WHERE expires_at < clock_timestamp() AND finished_at IS NULL;', '');
    v_definition := replace(v_definition,
      'DELETE FROM private.deleted_employee_delete_jobs WHERE expires_at <= clock_timestamp() AND finished_at IS NULL;', '');
    EXECUTE replace(v_definition, v_anchor,
      v_anchor || E'\n  PERFORM private.collect_audit_deletion_confirmations();');
  END LOOP;
END;
$collect_before_prepare$;

DO $collect_after_finish$
DECLARE v_signature regprocedure; v_definition text; v_anchor text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.finish_content_audit_delete(uuid, uuid)'::regprocedure,
    'public.finish_deleted_employee_archive_delete(uuid, uuid)'::regprocedure
  ] LOOP
    v_definition := pg_get_functiondef(v_signature);
    v_anchor := CASE WHEN v_signature = 'public.finish_content_audit_delete(uuid, uuid)'::regprocedure
      THEN 'UPDATE private.content_audit_delete_jobs SET finished_at = clock_timestamp(), paths_to_remove = v_paths, public_media_to_remove = v_public_paths WHERE id = p_job_id;'
      ELSE E'UPDATE private.deleted_employee_delete_jobs\n  SET finished_at = clock_timestamp(), paths_to_remove = v_paths WHERE id = p_job_id;' END;
    IF strpos(v_definition, v_anchor) = 0 THEN RAISE EXCEPTION 'Unexpected deletion finish definition: %', v_signature; END IF;
    EXECUTE replace(v_definition, v_anchor,
      v_anchor || E'\n  PERFORM private.collect_audit_deletion_confirmations();');
  END LOOP;
END;
$collect_after_finish$;

CREATE INDEX content_audit_delete_jobs_unfinished_expiry_idx
  ON private.content_audit_delete_jobs(expires_at) WHERE finished_at IS NULL;
CREATE INDEX deleted_employee_delete_jobs_unfinished_expiry_idx
  ON private.deleted_employee_delete_jobs(expires_at) WHERE finished_at IS NULL;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
SELECT cron.schedule('collect-audit-deletion-confirmations', '* * * * *',
  'SELECT private.collect_audit_deletion_confirmations();');
SELECT private.collect_audit_deletion_confirmations();
NOTIFY pgrst, 'reload schema';
