BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- A shared-settings stage can finish normally, but never finishes a whole site.
-- Reuse the existing owner/session/expiry guard and source snapshot verification.
CREATE FUNCTION public.employee_export_shared_close(p_admin_session_token uuid, p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  IF v_job.options->>'export_protocol' IS DISTINCT FROM 'shared-settings-v1' THEN
    RAISE EXCEPTION 'The task is not a shared settings export.';
  END IF;
  IF v_job.summary->'shared_verified' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Shared settings export has not been verified.';
  END IF;
  PERFORM public.employee_export_shared_verify(p_admin_session_token, p_job_token);
  -- Verification writes summary. Do not overwrite its current receipt with a stale row.
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  -- end_job clears sensitive staging and appends the standard export_finished audit.
  PERFORM private.employee_transfer_end_job(v_job, 'finished', v_job.summary ||
    '{"scope":"shared-settings","full_site_complete":false}'::jsonb);
  RETURN '{"success":true,"scope":"shared-settings","full_site_complete":false}'::jsonb;
END;
$$;

-- Code/protocol availability only: NOT a data preflight, completed backup, media
-- deployment check, import permission, or final site verification/release receipt.
-- The fixed set covers serial export stages, media RPC dependencies and imported
-- archive namespace readers; legacy employee-only export is not a substitute.
CREATE FUNCTION public.get_employee_transfer_capabilities(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_rpc text;
  v_missing jsonb := '[]'::jsonb;
BEGIN
  PERFORM private.employee_transfer_admin(p_admin_session_token);
  FOREACH v_rpc IN ARRAY ARRAY[
    'public.employee_transfer_cancel(uuid,uuid)',
    'public.get_employee_transfer_log(uuid,integer)',
    'public.employee_export_shared_begin(uuid,text)',
    'public.get_employee_export_shared_catalog(uuid,uuid)',
    'public.get_employee_export_shared_page(uuid,uuid,text,text,integer)',
    'public.employee_export_shared_verify(uuid,uuid)',
    'public.employee_export_shared_close(uuid,uuid)',
    'public.employee_export_products_begin(uuid,text)',
    'public.get_employee_export_products_page(uuid,uuid,text,integer)',
    'public.employee_export_products_verify(uuid,uuid)',
    'public.employee_products_close(uuid,uuid)',
    'public.employee_export_dispatch_begin(uuid,text)',
    'public.get_employee_export_dispatch_page(uuid,uuid,text,uuid,integer)',
    'public.employee_export_dispatch_verify(uuid,uuid)',
    'public.employee_export_dispatch_close(uuid,uuid)',
    'public.employee_export_identity_begin(uuid,text,uuid)',
    'public.get_employee_export_identity_page(uuid,uuid,text,uuid,integer)',
    'public.employee_export_identity_verify(uuid,uuid)',
    'public.employee_export_identity_close(uuid,uuid)',
    'public.employee_export_finance_begin(uuid,text,uuid)',
    'public.get_employee_export_finance_page(uuid,uuid,text,text,integer)',
    'public.employee_export_finance_verify(uuid,uuid)',
    'public.employee_export_finance_close(uuid,uuid)',
    'public.employee_export_activity_begin(uuid,text,uuid)',
    'public.get_employee_export_activity_page(uuid,uuid,text,text,integer)',
    'public.employee_export_activity_verify(uuid,uuid)',
    'public.employee_export_activity_close(uuid,uuid)',
    'public.employee_export_verification_begin(uuid,text,uuid)',
    'public.get_employee_export_verification_page(uuid,uuid,text,text,integer)',
    'public.employee_export_verification_verify(uuid,uuid)',
    'public.employee_export_verification_close(uuid,uuid)',
    'public.get_employee_transfer_verification_media(uuid,uuid,text)',
    'public.employee_transfer_verification_media_authorize(uuid,uuid,text,text)',
    'public.employee_transfer_verification_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
    'public.employee_export_notifications_begin(uuid,text,uuid)',
    'public.get_employee_export_notifications_page(uuid,uuid,text,text,integer)',
    'public.employee_export_notifications_verify(uuid,uuid)',
    'public.employee_export_notifications_close(uuid,uuid)',
    'public.get_employee_transfer_notification_media(uuid,uuid,text)',
    'public.employee_transfer_notification_media_authorize(uuid,uuid,text,text)',
    'public.employee_transfer_notification_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
    'public.employee_export_chat_begin(uuid,text,uuid)',
    'public.get_employee_export_chat_page(uuid,uuid,text,text,integer)',
    'public.employee_export_chat_verify(uuid,uuid)',
    'public.employee_export_chat_close(uuid,uuid)',
    'public.get_employee_transfer_chat_media(uuid,uuid,text)',
    'public.employee_transfer_chat_media_authorize(uuid,uuid,text,text)',
    'public.employee_transfer_chat_media_commit(uuid,uuid,text,text,integer,text,text,text,bigint)',
    'public.employee_export_archives_begin(uuid,text,uuid)',
    'public.get_employee_export_archives_page(uuid,uuid,text,text,integer)',
    'public.employee_export_archives_verify(uuid,uuid)',
    'public.employee_export_archives_close(uuid,uuid)',
    'public.employee_transfer_archive_media_inventory(uuid,uuid,text)',
    'public.employee_transfer_archive_media_status(uuid,uuid,text)',
    'public.employee_transfer_archive_media_authorize(uuid,uuid,text,text)',
    'public.employee_transfer_archive_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
    'public.employee_transfer_archive_media_verify(uuid,uuid,text)',
    'public.get_employee_archive_reexport_inventory(uuid)',
    'public.get_employee_archive_reexport_catalog(uuid,uuid,uuid)',
    'public.get_employee_archive_reexport_page(uuid,uuid,uuid,text,text,text,integer)',
    'public.get_employee_archive_reexport_verify(uuid,uuid,uuid,text)',
    'public.get_employee_archive_reexport_media(uuid,uuid,uuid,text)',
    'public.employee_transfer_archive_media_read_authorize(uuid,uuid,uuid,uuid,text)'
  ]::text[] LOOP
    IF to_regprocedure(v_rpc) IS NULL THEN
      v_missing := v_missing || jsonb_build_array(v_rpc);
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'version', 1,
    'site_id', (SELECT site_id FROM private.employee_transfer_site),
    'export_protocol', 'site-bundle-set-v1',
    'can_export', jsonb_array_length(v_missing) = 0,
    'can_import', false,
    'import_blockers', jsonb_build_array('complete_employee_backup_missing',
      'unified_uuid_mapping_missing', 'full_site_release_missing'),
    'missing_rpcs', v_missing);
END;
$$;

REVOKE ALL ON FUNCTION public.employee_export_shared_close(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_transfer_capabilities(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_export_shared_close(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_transfer_capabilities(uuid) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
