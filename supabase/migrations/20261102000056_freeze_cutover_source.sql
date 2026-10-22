BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_cutover_lock()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Source cutover requires read committed isolation.';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('employee-transfer-source-cutover',0)) THEN
    RAISE EXCEPTION 'Source cutover is busy; refresh its state before explicitly retrying.' USING ERRCODE='55P03';
  END IF;
  LOCK TABLE private.employee_transfer_jobs IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('notification_automation_queue',0)) THEN
    RAISE EXCEPTION 'Source cutover is busy; refresh its state before explicitly retrying.' USING ERRCODE='55P03';
  END IF;
  FOR v_table IN SELECT name FROM unnest(private.employee_transfer_guarded_tables()) item(name) ORDER BY name COLLATE "C" LOOP
    EXECUTE format('LOCK TABLE %I.%I IN ACCESS EXCLUSIVE MODE NOWAIT',split_part(v_table,'.',1),split_part(v_table,'.',2));
  END LOOP;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('employee-transfer-maintenance',0)) THEN
    RAISE EXCEPTION 'Source cutover is busy; refresh its state before explicitly retrying.' USING ERRCODE='55P03';
  END IF;
  PERFORM private.employee_transfer_assert_maintenance_guards();
END;
$$;

CREATE FUNCTION private.employee_transfer_source_cutoff()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_maintenance private.employee_transfer_maintenance%ROWTYPE;
  v_job private.employee_transfer_jobs%ROWTYPE; v_cutoff jsonb; v_hash text;
BEGIN
  SELECT * INTO v_maintenance FROM private.employee_transfer_maintenance WHERE singleton;
  IF v_maintenance.job_id IS NULL THEN RETURN NULL; END IF;
  SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE id=v_maintenance.job_id;
  IF v_job.options->>'export_protocol' IS DISTINCT FROM 'source-cutover-v1' THEN RETURN NULL; END IF;
  v_cutoff := v_job.summary->'source_cutover';
  v_hash := encode(extensions.digest(convert_to((v_cutoff-'cutoff_hash')::text,'UTF8'),'sha256'),'hex');
  IF v_job.status IS DISTINCT FROM 'finished' OR v_job.kind IS DISTINCT FROM 'export'
    OR v_job.summary ? 'source_resumed_at' OR v_maintenance.dirty
    OR v_job.admin_id IS DISTINCT FROM v_maintenance.admin_id
    OR v_maintenance.plan_hash IS DISTINCT FROM v_hash OR v_maintenance.target_hash IS DISTINCT FROM v_hash
    OR v_cutoff->>'cutoff_hash' IS DISTINCT FROM v_hash
    OR v_cutoff->>'cutoff_id' IS DISTINCT FROM v_job.id::text
    OR v_cutoff->>'site_id' IS DISTINCT FROM (SELECT site_id::text FROM private.employee_transfer_site)
    OR v_cutoff->>'policy' IS DISTINCT FROM 'drained-queue-v1' THEN
    RAISE EXCEPTION 'Source cutoff state is missing or changed.';
  END IF;
  RETURN v_cutoff;
END;
$$;

CREATE FUNCTION public.get_employee_export_cutover_status(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_cutoff jsonb; v_queue integer; v_failed integer; v_orders integer; v_blockers jsonb := '[]';
BEGIN
  PERFORM private.employee_transfer_admin(p_admin_session_token);
  IF current_setting('transaction_isolation') <> 'read committed'
    OR NOT pg_try_advisory_xact_lock(hashtextextended('employee-transfer-source-cutover',0)) THEN
    RAISE EXCEPTION 'Source status is busy; refresh after the original operation settles.' USING ERRCODE='55P03';
  END IF;
  PERFORM private.employee_transfer_assert_maintenance_guards();
  v_cutoff := private.employee_transfer_source_cutoff();
  SELECT count(*)::integer INTO v_queue FROM public.notification_automation_queue;
  SELECT count(*)::integer INTO v_failed FROM public.notification_automation_failures;
  SELECT count(*)::integer INTO v_orders FROM public.orders WHERE status='processing';
  IF v_queue>0 THEN v_blockers := v_blockers||'"pending_automation"'::jsonb; END IF;
  IF v_failed>0 THEN v_blockers := v_blockers||'"failed_automation"'::jsonb; END IF;
  IF v_orders>0 THEN v_blockers := v_blockers||'"processing_orders"'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_jobs WHERE status='running') THEN
    v_blockers := v_blockers||'"transfer_running"'::jsonb;
  END IF;
  IF v_cutoff IS NULL AND EXISTS(SELECT 1 FROM private.employee_transfer_maintenance) THEN
    v_blockers := v_blockers||'"other_maintenance"'::jsonb;
  END IF;
  RETURN jsonb_build_object('version',1,'success',true,'scope','source-cutover',
    'site_id',(SELECT site_id FROM private.employee_transfer_site),'frozen',v_cutoff IS NOT NULL,'cutoff',v_cutoff,
    'counts',jsonb_build_object('pending_automation',v_queue,'failed_automation',v_failed,'processing_orders',v_orders),
    'blockers',v_blockers,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_export_cutover_freeze(p_admin_session_token uuid,p_admin_password text,p_confirmation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_admin uuid; v_username text; v_check jsonb; v_status jsonb;
  v_id uuid := gen_random_uuid(); v_cutoff jsonb; v_hash text; v_now timestamptz;
BEGIN
  SELECT a.admin_id,a.admin_username INTO v_admin,v_username FROM private.employee_transfer_admin(p_admin_session_token) a;
  IF p_confirmation IS DISTINCT FROM '確認暫停舊站業務並導出' THEN RAISE EXCEPTION 'Source freeze confirmation does not match.'; END IF;
  v_check := private.employee_transfer_verify_password(v_admin,v_username,p_admin_password);
  IF NOT COALESCE((v_check->>'success')::boolean,false) THEN RETURN v_check; END IF;
  PERFORM private.employee_transfer_cutover_lock();
  v_status := public.get_employee_export_cutover_status(p_admin_session_token);
  IF v_status->'frozen'='true'::jsonb THEN RETURN v_status; END IF;
  IF jsonb_array_length(v_status->'blockers')>0 THEN RETURN v_status; END IF;
  v_now := clock_timestamp();
  v_cutoff := jsonb_build_object('version',1,'policy','drained-queue-v1','cutoff_id',v_id,
    'site_id',v_status->'site_id','frozen_at',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  v_hash := encode(extensions.digest(convert_to(v_cutoff::text,'UTF8'),'sha256'),'hex');
  v_cutoff := v_cutoff||jsonb_build_object('cutoff_hash',v_hash);
  INSERT INTO private.employee_transfer_jobs(id,kind,admin_id,admin_username,token_hash,status,options,summary,finished_at)
    VALUES(v_id,'export',v_admin,v_username,private.hash_financial_token(gen_random_uuid()),'finished',
      '{"export_protocol":"source-cutover-v1","scope":"source-cutover"}',jsonb_build_object('source_cutover',v_cutoff),v_now);
  INSERT INTO private.employee_transfer_maintenance(singleton,job_id,admin_id,plan_hash,target_hash,entered_at,dirty)
    VALUES(true,v_id,v_admin,v_hash,v_hash,v_now,false);
  PERFORM private.employee_transfer_log(v_id,v_admin,v_username,'export','source_cutover_frozen',v_cutoff);
  RETURN public.get_employee_export_cutover_status(p_admin_session_token);
END;
$$;

CREATE FUNCTION public.employee_export_cutover_resume(p_admin_session_token uuid,p_admin_password text,p_confirmation text,p_cutoff_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_admin uuid; v_username text; v_check jsonb; v_cutoff jsonb;
BEGIN
  SELECT a.admin_id,a.admin_username INTO v_admin,v_username FROM private.employee_transfer_admin(p_admin_session_token) a;
  IF p_confirmation IS DISTINCT FROM '確認恢復舊站業務並放棄切站' THEN RAISE EXCEPTION 'Source resume confirmation does not match.'; END IF;
  v_check := private.employee_transfer_verify_password(v_admin,v_username,p_admin_password);
  IF NOT COALESCE((v_check->>'success')::boolean,false) THEN RETURN v_check; END IF;
  PERFORM private.employee_transfer_cutover_lock();
  v_cutoff := private.employee_transfer_source_cutoff();
  IF v_cutoff IS NULL OR p_cutoff_id IS NULL OR v_cutoff->>'cutoff_id' IS DISTINCT FROM p_cutoff_id::text THEN
    RAISE EXCEPTION 'The original frozen source cutoff is required.';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance WHERE singleton AND job_id=p_cutoff_id AND admin_id=v_admin)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_jobs WHERE status='running') THEN
    RAISE EXCEPTION 'Only the original source owner can resume after ending its export task.';
  END IF;
  DELETE FROM private.employee_transfer_maintenance WHERE singleton AND job_id=p_cutoff_id AND admin_id=v_admin AND NOT dirty;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('source_resumed_at',clock_timestamp()) WHERE id=p_cutoff_id;
  PERFORM private.employee_transfer_log(p_cutoff_id,v_admin,v_username,'export','source_cutover_resumed',
    jsonb_build_object('cutoff_id',p_cutoff_id,'cutover_abandoned',true,'full_site_complete',false));
  RETURN public.get_employee_export_cutover_status(p_admin_session_token);
END;
$$;

ALTER FUNCTION public.get_employee_export_site_snapshot(uuid,uuid) SET SCHEMA private;
ALTER FUNCTION private.get_employee_export_site_snapshot(uuid,uuid) RENAME TO employee_transfer_site_snapshot_v1;
CREATE FUNCTION public.get_employee_export_site_snapshot(p_admin_session_token uuid,p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_result jsonb; v_cutoff jsonb;
BEGIN
  v_result := private.employee_transfer_site_snapshot_v1(p_admin_session_token,p_package_id);
  v_cutoff := private.employee_transfer_source_cutoff();
  IF v_cutoff IS NOT NULL THEN
    PERFORM private.employee_transfer_assert_maintenance_guards();
    IF EXISTS(SELECT 1 FROM public.notification_automation_queue)
      OR EXISTS(SELECT 1 FROM public.notification_automation_failures)
      OR EXISTS(SELECT 1 FROM public.orders WHERE status='processing') THEN
      RAISE EXCEPTION 'Frozen source automation or orders changed.';
    END IF;
    v_result := v_result||jsonb_build_object('source_cutover',v_cutoff);
  END IF;
  RETURN v_result;
END;
$$;

ALTER FUNCTION public.get_employee_transfer_log(uuid,integer) SET SCHEMA private;
ALTER FUNCTION private.get_employee_transfer_log(uuid,integer) RENAME TO employee_transfer_log_before_cutover;
CREATE FUNCTION public.get_employee_transfer_log(p_admin_session_token uuid,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  v_result := private.employee_transfer_log_before_cutover(p_admin_session_token,p_limit);
  RETURN v_result||jsonb_build_object('last_export_at',(SELECT max(finished_at) FROM private.employee_transfer_jobs
    WHERE kind='export' AND status='finished' AND options->>'export_protocol' IS DISTINCT FROM 'source-cutover-v1'));
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_cutover_lock(),private.employee_transfer_source_cutoff(),
  private.employee_transfer_site_snapshot_v1(uuid,uuid),private.employee_transfer_log_before_cutover(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_employee_export_cutover_status(uuid),public.employee_export_cutover_freeze(uuid,text,text),
  public.employee_export_cutover_resume(uuid,text,text,uuid),public.get_employee_export_site_snapshot(uuid,uuid),public.get_employee_transfer_log(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_export_cutover_status(uuid),public.employee_export_cutover_freeze(uuid,text,text),
  public.employee_export_cutover_resume(uuid,text,text,uuid),public.get_employee_export_site_snapshot(uuid,uuid),public.get_employee_transfer_log(uuid,integer) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
