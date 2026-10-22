BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION public.employee_import_site_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' SET lock_timeout = '2s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_prior private.employee_transfer_jobs%ROWTYPE;
  v_receipt jsonb; v_key text; v_expected integer; v_count integer;
  v_pending integer; v_amount numeric; v_backups jsonb := '[]'; v_backup record; v_prerequisites jsonb := '{}';
  v_binding jsonb; v_result jsonb;
  v_domains constant jsonb := '["shared","products","dispatch","identity","finance","activity","verification","notifications","chat","archives"]';
BEGIN
  PERFORM private.employee_transfer_admin(p_admin_session_token);
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job := private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  PERFORM private.employee_transfer_assert_maintenance_guards();
  IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance m WHERE m.singleton AND m.dirty
    AND m.job_id=v_job.id AND m.admin_id=v_job.admin_id AND m.plan_hash=v_job.summary->>'dispatch_plan_hash') THEN
    RAISE EXCEPTION 'Site verification requires the original dirty maintenance task.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['identity_restore','dependency_restore','finance_restore','activity_restore',
    'verification_restore','notification_restore','chat_restore'] LOOP
    IF v_job.summary#>ARRAY[v_key,'verified'] IS DISTINCT FROM 'true'::jsonb THEN
      RAISE EXCEPTION 'Site verification requires every restored domain to be verified (%).',v_key;
    END IF;
  END LOOP;
  IF v_job.summary#>'{archives_restore,records_verified}' IS DISTINCT FROM 'true'::jsonb
    OR v_job.summary#>'{archives_media,verified}' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Site verification requires verified archive records and media.';
  END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND (table_key='identity-reservation-v1' OR table_key LIKE 'mapped-%')) THEN
    RAISE EXCEPTION 'Mapped identity restoration is not supported by the empty-site verifier.';
  END IF;

  v_receipt := public.employee_import_site_verify_prerequisites(p_admin_session_token,p_job_token);
  IF v_receipt->'verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Site prerequisites are incomplete.'; END IF;
  v_receipt := public.employee_import_identity_verify(p_admin_session_token,p_job_token);
  IF v_receipt->'verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Site identity verification failed.'; END IF;
  v_receipt := public.employee_import_dispatch_dependency_verify(p_admin_session_token,p_job_token);
  IF v_receipt->'verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Site dispatch verification failed.'; END IF;
  v_receipt := public.employee_import_finance_verify(p_admin_session_token,p_job_token);
  IF v_receipt->'verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Site finance verification failed.'; END IF;
  v_receipt := public.employee_import_activity_verify(p_admin_session_token,p_job_token);
  IF v_receipt->'verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Site activity verification failed.'; END IF;
  v_receipt := public.employee_import_verification_verify(p_admin_session_token,p_job_token);
  IF v_receipt->'verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Site document verification failed.'; END IF;
  v_receipt := public.employee_import_notifications_verify(p_admin_session_token,p_job_token);
  IF v_receipt->'verified' IS DISTINCT FROM 'true'::jsonb OR v_receipt->>'stage' IS DISTINCT FROM 'done' THEN
    RAISE EXCEPTION 'Site notification verification failed.';
  END IF;
  v_receipt := public.employee_import_chat_verify(p_admin_session_token,p_job_token);
  IF v_receipt->'verified' IS DISTINCT FROM 'true'::jsonb OR v_receipt->>'stage' IS DISTINCT FROM 'done' THEN
    RAISE EXCEPTION 'Site chat verification failed.';
  END IF;
  v_receipt := public.employee_import_archives_verify(p_admin_session_token,p_job_token);
  IF v_receipt->'records_verified' IS DISTINCT FROM 'true'::jsonb
    OR v_receipt->'chunks' IS DISTINCT FROM v_receipt->'completed_chunks' THEN
    RAISE EXCEPTION 'Site archive verification failed.';
  END IF;
  SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE id=v_job.id;
  v_receipt := private.employee_transfer_archive_media_state(v_job,false);
  IF v_receipt->'verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Site archive media verification failed.'; END IF;

  SELECT count(*)::integer INTO v_expected FROM private.employee_transfer_identity_input(v_job.id,'accounts');
  SELECT count(*)::integer INTO v_count FROM public.users;
  IF v_count<>v_expected OR EXISTS(SELECT 1 FROM public.users WHERE is_active IS DISTINCT FROM false
    OR archived_at IS NOT NULL OR current_session_token IS NOT NULL OR current_tab_id IS NOT NULL
    OR session_created_at IS NOT NULL OR last_heartbeat_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.admins WHERE role<>'super_admin' AND is_active IS DISTINCT FROM false)
    OR EXISTS(SELECT 1 FROM public.orders WHERE status='processing')
    OR EXISTS(SELECT 1 FROM public.work_sessions WHERE end_time IS NULL)
    OR EXISTS(SELECT 1 FROM public.notification_automation_plans WHERE status='active')
    OR EXISTS(SELECT 1 FROM public.notification_automation_tasks WHERE status='active') THEN
    RAISE EXCEPTION 'Site safety state changed; accounts and automation must remain paused.';
  END IF;

  FOR v_prior IN SELECT j.* FROM private.employee_transfer_jobs j WHERE j.kind='import' AND j.admin_id=v_job.admin_id
    AND j.options->'package_id'=v_job.options->'package_id'
    AND j.options#>'{catalog,site_id}'=v_job.options#>'{catalog,site_id}'
    AND ((j.options->>'import_protocol'='shared-import-v1' AND j.options->>'replace_policy'='source-v1' AND j.summary->'shared_applied'='true'::jsonb)
      OR (j.options->>'import_protocol'='products-v1' AND j.summary->'products_applied'='true'::jsonb)) LOOP
    v_backups := v_backups||jsonb_build_array(v_prior.id);
    v_prerequisites := v_prerequisites||jsonb_build_object(v_prior.options->>'import_protocol',v_prior.summary->'site_prerequisite_checkpoint');
  END LOOP;
  IF jsonb_array_length(v_backups)<>2 THEN RAISE EXCEPTION 'Site prerequisite backups are ambiguous.'; END IF;
  v_backups := v_backups||jsonb_build_array(v_job.id);
  v_count := 0; v_binding := '[]';
  FOR v_backup IN
    SELECT 'shared' AS kind,b.id,b.sealed_sha256,b.sealed_at,b.byte_count,b.chunks
      FROM private.employee_transfer_shared_backups b WHERE b.id IN (SELECT value::uuid FROM jsonb_array_elements_text(v_backups))
        AND b.admin_id=v_job.admin_id
    UNION ALL
    SELECT 'notifications',b.id,b.sealed_sha256,b.sealed_at,b.byte_count,b.chunks
      FROM private.employee_transfer_notification_backups b WHERE b.job_id=v_job.id AND b.admin_id=v_job.admin_id
    UNION ALL
    SELECT 'chat',b.id,b.sealed_sha256,b.sealed_at,b.byte_count,b.chunks
      FROM private.employee_transfer_chat_backups b WHERE b.job_id=v_job.id AND b.admin_id=v_job.admin_id
    ORDER BY kind,id
  LOOP
    IF v_backup.sealed_at IS NULL OR v_backup.sealed_sha256 IS NULL OR v_backup.byte_count<=0
      OR v_backup.byte_count IS DISTINCT FROM (SELECT COALESCE(sum(octet_length(c.raw)),0) FROM unnest(v_backup.chunks) c(raw))
      OR v_backup.sealed_sha256 IS DISTINCT FROM (SELECT encode(extensions.digest(COALESCE(string_agg(c.raw,''::bytea ORDER BY c.n),''::bytea),'sha256'),'hex')
        FROM unnest(v_backup.chunks) WITH ORDINALITY c(raw,n)) THEN
      RAISE EXCEPTION 'Site independent backup is missing or changed.';
    END IF;
    v_count := v_count+1;
    v_binding := v_binding||jsonb_build_array(jsonb_build_object('kind',v_backup.kind,'id',v_backup.id,'sha256',v_backup.sealed_sha256));
  END LOOP;
  IF v_count<>5 THEN RAISE EXCEPTION 'Five sealed independent site backups are required.'; END IF;

  SELECT count(*)::integer,COALESCE(sum(w.amount),0) INTO v_pending,v_amount FROM public.withdrawals w WHERE w.status='pending';
  v_binding := jsonb_build_object('job_id',v_job.id,'source_site_id',v_job.options#>'{catalog,site_id}',
    'package_id',v_job.options->'package_id','prerequisites',v_prerequisites,'admin_map',v_job.summary#>'{identity_restore,admin_map}',
    'catalogs',jsonb_build_object('dispatch',v_job.options->'catalog','identity',v_job.summary->'identity_catalog',
      'finance',v_job.summary->'finance_catalog','activity',v_job.summary->'activity_catalog',
      'verification',v_job.summary->'verification_catalog','notifications',v_job.summary->'notifications_catalog',
      'chat',v_job.summary->'chat_catalog','archives',v_job.summary->'archives_catalog'),
    'notification_target',v_job.summary#>'{notification_restore,target_hash}',
    'chat_target',v_job.summary#>'{chat_restore,target_hash}',
    'archive_namespace',v_job.summary#>'{archives_restore,namespace_hash}','backups',v_binding);
  v_result := jsonb_build_object('version',1,'success',true,'scope','site-restore-verification',
    'job_id',v_job.id,'source_site_id',v_job.options#>'{catalog,site_id}','package_id',v_job.options->'package_id',
    'verification_hash',encode(extensions.digest(convert_to(v_binding::text,'UTF8'),'sha256'),'hex'),
    'verified_domains',v_domains,'counts',jsonb_build_object('employees',v_expected,
      'pending_withdrawals',v_pending,'pending_withdrawal_amount',v_amount::text),
    'maintenance',true,'accounts_active',false,'automation_resumed',false,'can_release',false,'full_site_complete',false);
  IF v_job.summary->'site_verification' IS DISTINCT FROM v_result THEN
    UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('site_verification',v_result) WHERE id=v_job.id;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','site_restore_verified',v_result);
  END IF;
  RETURN v_result;
END;
$$;

ALTER FUNCTION public.get_employee_import_site_preflight(uuid,uuid) SET SCHEMA private;
ALTER FUNCTION private.get_employee_import_site_preflight(uuid,uuid) RENAME TO employee_transfer_site_preflight_v2;
CREATE FUNCTION public.get_employee_import_site_preflight(p_admin_session_token uuid,p_source_site_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_result jsonb; v_rpc constant text := 'public.employee_import_site_verify(uuid,uuid)';
BEGIN
  v_result := private.employee_transfer_site_preflight_v2(p_admin_session_token,p_source_site_id);
  v_result := v_result||jsonb_build_object('protocol','site-maintenance-restore-v3');
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(v_rpc) AND prokind='f' AND prorettype='jsonb'::regtype) THEN
    v_result := jsonb_set(v_result,'{missing_rpcs}',(v_result->'missing_rpcs')||jsonb_build_array(v_rpc));
    IF NOT (v_result->'blockers' ? 'missing_backend_support') THEN
      v_result := jsonb_set(v_result,'{blockers}',(v_result->'blockers')||'["missing_backend_support"]'::jsonb);
    END IF;
    v_result := v_result||'{"can_restore_to_maintenance":false}'::jsonb;
  END IF;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION private.employee_transfer_site_preflight_v2(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.employee_import_site_verify(uuid,uuid),public.get_employee_import_site_preflight(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_import_site_verify(uuid,uuid),public.get_employee_import_site_preflight(uuid,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
