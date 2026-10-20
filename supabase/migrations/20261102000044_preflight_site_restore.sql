BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- A read-only admission snapshot for a NEW site-maintenance restore, not a
-- resumption/release permit. The caller must authenticate all eleven files first.
-- Catalog existence does NOT attest Edge deployment, Storage access, file bytes,
-- race-free admission, complete employee backups or a completed site cutover.
CREATE FUNCTION public.get_employee_import_site_preflight(
  p_admin_session_token uuid, p_source_site_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_site uuid;
  v_rpc text;
  v_blockers jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  IF p_source_site_id IS NULL THEN
    RAISE EXCEPTION 'A source site id is required.';
  END IF;
  SELECT site_id INTO v_site FROM private.employee_transfer_site;

  -- This reviewed, signature-qualified list follows siteRestoreApi and its
  -- import/independent-backup/media clients only. Never accept caller-supplied
  -- names, invoke these writes, or substitute legacy employee_import_finish.
  FOREACH v_rpc IN ARRAY ARRAY[
    'public.get_employee_import_dispatch_preflight(uuid)',
    'public.get_employee_transfer_maintenance(uuid)',
    'public.employee_transfer_cancel(uuid,uuid)',
    -- shared replacement and its independent encrypted backup
    'public.employee_import_shared_replace_begin(uuid,text,uuid,jsonb)',
    'public.employee_import_shared_stage(uuid,uuid,text,integer,text)',
    'public.get_employee_import_shared_replace_dry_run(uuid,uuid)',
    'public.get_employee_import_shared_backup(uuid,uuid)',
    'public.get_employee_import_shared_backup_page(uuid,uuid,text,text,integer)',
    'public.employee_import_shared_backup_append(uuid,uuid,text,integer,text)',
    'public.employee_import_shared_backup_seal(uuid,uuid,text,text,integer)',
    'public.employee_import_shared_replace_apply(uuid,uuid,text)',
    -- products and their independent encrypted backup
    'public.employee_import_products_begin(uuid,text,uuid,jsonb)',
    'public.employee_import_products_stage(uuid,uuid,integer,text)',
    'public.get_employee_import_products_dry_run(uuid,uuid)',
    'public.get_employee_import_products_backup(uuid,uuid)',
    'public.get_employee_import_products_backup_page(uuid,uuid,text,integer)',
    'public.employee_import_products_backup_append(uuid,uuid,text,integer,text)',
    'public.employee_import_products_backup_seal(uuid,uuid,text,text,integer)',
    'public.employee_import_products_apply(uuid,uuid,text)',
    'public.employee_products_close(uuid,uuid)',
    -- dispatch, independent backup, persistent maintenance and valid submissions
    'public.employee_import_dispatch_begin(uuid,text,uuid,jsonb)',
    'public.employee_import_dispatch_stage(uuid,uuid,text,integer,text)',
    'public.get_employee_import_dispatch_dry_run(uuid,uuid)',
    'public.get_employee_import_dispatch_backup(uuid,uuid)',
    'public.get_employee_import_dispatch_backup_page(uuid,uuid,text,text,integer)',
    'public.employee_import_dispatch_backup_append(uuid,uuid,text,integer,text)',
    'public.employee_import_dispatch_backup_seal(uuid,uuid,text,text,integer)',
    'public.employee_import_dispatch_enter_maintenance(uuid,uuid,text,text,text)',
    'public.get_employee_import_dispatch_configuration_plan(uuid,uuid)',
    'public.employee_import_dispatch_apply_configuration(uuid,uuid,text)',
    'public.employee_import_dispatch_valid_begin(uuid,uuid,text)',
    'public.employee_import_dispatch_valid_chunk(uuid,uuid,integer)',
    'public.employee_import_dispatch_valid_verify(uuid,uuid)',
    -- identity and exact dispatch member/used-submission dependencies
    'public.employee_import_identity_bind(uuid,uuid,jsonb)',
    'public.employee_import_identity_stage(uuid,uuid,text,integer,text)',
    'public.get_employee_import_identity_plan(uuid,uuid)',
    'public.employee_import_identity_begin(uuid,uuid,text)',
    'public.employee_import_identity_chunk(uuid,uuid,text,integer)',
    'public.employee_import_identity_verify(uuid,uuid)',
    'public.get_employee_import_dispatch_dependency_plan(uuid,uuid)',
    'public.employee_import_dispatch_dependency_begin(uuid,uuid,text)',
    'public.employee_import_dispatch_dependency_chunk(uuid,uuid,text,integer)',
    'public.employee_import_dispatch_dependency_verify(uuid,uuid)',
    -- finance, activity and verification records
    'public.employee_import_finance_bind(uuid,uuid,jsonb)',
    'public.employee_import_finance_stage(uuid,uuid,text,integer,text)',
    'public.get_employee_import_finance_plan(uuid,uuid)',
    'public.employee_import_finance_apply(uuid,uuid,uuid,text)',
    'public.employee_import_finance_verify(uuid,uuid)',
    'public.employee_import_activity_bind(uuid,uuid,jsonb)',
    'public.employee_import_activity_stage(uuid,uuid,text,integer,text)',
    'public.get_employee_import_activity_plan(uuid,uuid)',
    'public.employee_import_activity_apply(uuid,uuid,uuid,text)',
    'public.employee_import_activity_verify(uuid,uuid)',
    'public.employee_import_verification_bind(uuid,uuid,jsonb)',
    'public.employee_import_verification_stage(uuid,uuid,text,integer,text)',
    'public.get_employee_import_verification_plan(uuid,uuid)',
    'public.employee_import_verification_apply(uuid,uuid,uuid,text)',
    'public.employee_import_verification_verify(uuid,uuid)',
    'public.get_employee_transfer_verification_media(uuid,uuid,text)',
    'public.employee_import_verification_media_bind(uuid,uuid,jsonb)',
    'public.employee_transfer_verification_media_authorize(uuid,uuid,text,text)',
    'public.employee_transfer_verification_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
    -- notifications, configuration/record backup, controlled media and restore
    'public.employee_import_notifications_bind(uuid,uuid,jsonb)',
    'public.employee_import_notifications_stage(uuid,uuid,text,integer,text)',
    'public.get_employee_import_notifications_plan(uuid,uuid)',
    'public.get_employee_import_notification_configuration_plan(uuid,uuid)',
    'public.employee_import_notification_backup_prepare(uuid,uuid,text)',
    'public.get_employee_import_notification_backup_page(uuid,uuid,uuid,text,text,integer)',
    'public.employee_import_notification_backup_verify(uuid,uuid,uuid)',
    'public.employee_import_notification_backup_append(uuid,uuid,uuid,integer,text)',
    'public.employee_import_notification_backup_seal(uuid,uuid,uuid,text,integer)',
    'public.get_employee_transfer_notification_media(uuid,uuid,text)',
    'public.employee_import_notification_media_bind(uuid,uuid,jsonb)',
    'public.employee_transfer_notification_media_authorize(uuid,uuid,text,text)',
    'public.employee_transfer_notification_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
    'public.employee_import_notifications_begin(uuid,uuid,text)',
    'public.employee_import_notifications_chunk(uuid,uuid,integer)',
    'public.employee_import_notifications_verify(uuid,uuid)',
    'public.get_employee_import_notifications_restore_status(uuid,uuid)',
    -- chat, explicitly decided merge, independent record backup and media
    'public.employee_import_chat_bind(uuid,uuid,jsonb)',
    'public.employee_import_chat_stage(uuid,uuid,text,integer,text)',
    'public.get_employee_import_chat_plan(uuid,uuid)',
    'public.get_employee_import_chat_merge_plan(uuid,uuid,jsonb)',
    'public.employee_import_chat_backup_prepare(uuid,uuid,text,jsonb)',
    'public.get_employee_import_chat_backup_page(uuid,uuid,uuid,text,text,integer)',
    'public.employee_import_chat_backup_verify(uuid,uuid,uuid)',
    'public.employee_import_chat_backup_append(uuid,uuid,uuid,integer,text)',
    'public.employee_import_chat_backup_seal(uuid,uuid,uuid,text,integer)',
    'public.get_employee_transfer_chat_media(uuid,uuid,text)',
    'public.employee_import_chat_media_bind(uuid,uuid,jsonb)',
    'public.employee_transfer_chat_media_authorize(uuid,uuid,text,text)',
    'public.employee_transfer_chat_media_commit(uuid,uuid,text,text,integer,text,text,text,bigint)',
    'public.employee_import_chat_begin(uuid,uuid,text)',
    'public.employee_import_chat_chunk(uuid,uuid,integer)',
    'public.employee_import_chat_verify(uuid,uuid)',
    'public.get_employee_import_chat_restore_status(uuid,uuid)',
    -- source-isolated read-only archives and their private evidence media
    'public.employee_import_archives_bind(uuid,uuid,jsonb)',
    'public.employee_import_archives_stage(uuid,uuid,text,integer,text)',
    'public.get_employee_import_archives_plan(uuid,uuid)',
    'public.employee_import_archives_begin(uuid,uuid,text)',
    'public.employee_import_archives_chunk(uuid,uuid,text,integer)',
    'public.employee_import_archives_verify(uuid,uuid)',
    'public.get_employee_import_archives_status(uuid,uuid)',
    'public.employee_transfer_archive_media_inventory(uuid,uuid,text)',
    'public.employee_transfer_archive_media_bind(uuid,uuid,jsonb)',
    'public.employee_transfer_archive_media_status(uuid,uuid,text)',
    'public.employee_transfer_archive_media_verify(uuid,uuid,text)',
    'public.employee_transfer_archive_media_authorize(uuid,uuid,text,text)',
    'public.employee_transfer_archive_media_commit(uuid,uuid,text,text,integer,text,text,text,text)',
    'public.employee_transfer_archive_media_read_authorize(uuid,uuid,uuid,uuid,text)'
  ]::text[] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc
      WHERE oid = pg_catalog.to_regprocedure(v_rpc) AND prokind = 'f'
        AND prorettype = 'pg_catalog.jsonb'::regtype) THEN
      v_missing := v_missing || jsonb_build_array(v_rpc);
    END IF;
  END LOOP;

  -- Unique, fixed-order blockers. A running row holds the existing global
  -- single-running-job index irrespective of owner/kind/protocol/age. This
  -- STABLE probe must not run start_job's automatic abandonment/cleanup.
  IF p_source_site_id = v_site THEN
    v_blockers := v_blockers || jsonb_build_array('same_site');
  END IF;
  -- Maintenance outlives its task, including expired/cancelled/dirty tasks.
  IF EXISTS (SELECT 1 FROM private.employee_transfer_maintenance) THEN
    v_blockers := v_blockers || jsonb_build_array('active_maintenance');
  END IF;
  IF EXISTS (SELECT 1 FROM private.employee_transfer_jobs WHERE status = 'running') THEN
    v_blockers := v_blockers || jsonb_build_array('active_transfer_task');
  END IF;
  -- The only invoked public dependency is the reviewed STABLE read-only gate.
  -- If absent, report missing_backend_support rather than executing a fallback
  -- or failing resolution before returning the fixed missing-signature list.
  IF NOT (v_missing ? 'public.get_employee_import_dispatch_preflight(uuid)') THEN
    IF (public.get_employee_import_dispatch_preflight(p_admin_session_token)
      -> 'eligible_for_empty_target_mode') IS DISTINCT FROM 'true'::jsonb THEN
      v_blockers := v_blockers || jsonb_build_array('target_has_business');
    END IF;
  END IF;
  IF jsonb_array_length(v_missing) > 0 THEN
    v_blockers := v_blockers || jsonb_build_array('missing_backend_support');
  END IF;
  RETURN jsonb_build_object(
    'version', 1,
    'protocol', 'site-maintenance-restore-v1',
    'site_id', v_site,
    'source_site_id', p_source_site_id,
    'can_restore_to_maintenance', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers,
    'missing_rpcs', v_missing,
    'full_site_complete', false,
    'can_release', false);
END;
$$;

REVOKE ALL ON FUNCTION public.get_employee_import_site_preflight(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_import_site_preflight(uuid, uuid) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
