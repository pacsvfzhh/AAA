BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- Offline, operator-managed cutover only. This metadata is not a remote signature
-- or proof that the source is still stopped. No cross-site request or handoff lock.
CREATE FUNCTION private.employee_transfer_import_cutoff(p_cutoff jsonb,p_source_site_id uuid)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' AS $$
DECLARE v_frozen timestamptz; v_field text;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_cutoff,
    ARRAY['version','policy','site_id','cutoff_id','frozen_at','cutoff_hash'])
    OR jsonb_typeof(p_cutoff->'version') IS DISTINCT FROM 'number' OR p_cutoff->>'version' IS DISTINCT FROM '1'
    OR p_cutoff->>'policy' IS DISTINCT FROM 'drained-queue-v1' THEN
    RAISE EXCEPTION 'Invalid source cutoff metadata.';
  END IF;
  FOREACH v_field IN ARRAY ARRAY['policy','site_id','cutoff_id','frozen_at','cutoff_hash'] LOOP
    IF jsonb_typeof(p_cutoff->v_field) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Invalid source cutoff field.'; END IF;
  END LOOP;
  IF p_source_site_id IS NULL OR p_cutoff->>'site_id' IS DISTINCT FROM p_source_site_id::text
    OR p_source_site_id IS NOT DISTINCT FROM (SELECT site_id FROM private.employee_transfer_site)
    OR (p_cutoff->>'cutoff_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR (p_cutoff->>'frozen_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{6}Z$'
    OR (p_cutoff->>'cutoff_hash') !~ '^[0-9a-f]{64}$'
    OR p_cutoff->>'cutoff_hash' IS DISTINCT FROM encode(extensions.digest(
      convert_to((p_cutoff-'cutoff_hash')::text,'UTF8'),'sha256'),'hex') THEN
    RAISE EXCEPTION 'Source cutoff identity or digest differs.';
  END IF;
  PERFORM (p_cutoff->>'cutoff_id')::uuid;
  v_frozen := (p_cutoff->>'frozen_at')::timestamptz;
  IF NOT isfinite(v_frozen) OR to_char(v_frozen AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    IS DISTINCT FROM p_cutoff->>'frozen_at' THEN RAISE EXCEPTION 'Invalid source cutoff time.'; END IF;
  RETURN v_frozen;
END;
$$;

-- Preserve SQL45 intact. SQL12 later removes shared staging on cancel/finish, so
-- capture the source booleans NOW, never infer them from the disabled target.
ALTER FUNCTION public.employee_import_shared_replace_apply(uuid,uuid,text) SET SCHEMA private;
ALTER FUNCTION private.employee_import_shared_replace_apply(uuid,uuid,text) RENAME TO employee_import_shared_replace_apply_v45;
CREATE FUNCTION public.employee_import_shared_replace_apply(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' SET lock_timeout = '2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_applied boolean; v_result jsonb; v_data jsonb;
  v_row jsonb; v_target text; v_states jsonb := '{}'; v_bindings jsonb := '{}';
BEGIN
  v_job := private.employee_transfer_shared_replace_job(p_admin_session_token,p_job_token);
  v_applied := COALESCE(v_job.summary->'shared_applied'='true'::jsonb,false);
  IF v_applied AND (NOT (v_job.summary ? 'site_original_admin_states') OR NOT (v_job.summary ? 'site_original_admin_bindings')) THEN
    RAISE EXCEPTION 'Historical shared apply has no source administrator snapshot; restart, do not backfill.';
  END IF;
  IF NOT v_applied AND (v_job.summary ? 'site_original_admin_states' OR v_job.summary ? 'site_original_admin_bindings') THEN
    RAISE EXCEPTION 'Source administrator snapshot already exists before shared apply.';
  END IF;
  v_result := private.employee_import_shared_replace_apply_v45(p_admin_session_token,p_job_token,p_plan_hash);
  IF v_result->'success' IS DISTINCT FROM 'true'::jsonb THEN RETURN v_result; END IF;
  SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE NOWAIT;
  IF v_job.status IS DISTINCT FROM 'running' OR v_job.summary->'shared_applied' IS DISTINCT FROM 'true'::jsonb
    OR v_job.admin_map IS DISTINCT FROM v_job.summary#>'{shared_receipt,admin_map}' THEN
    RAISE EXCEPTION 'Shared apply did not retain its original running task and mapping.';
  END IF;
  v_data := private.employee_transfer_shared_import_data(v_job);
  PERFORM private.employee_transfer_check_shared_input(v_data);
  FOR v_row IN SELECT value FROM jsonb_array_elements(v_data->'admins') WHERE value->>'role'<>'super_admin' LOOP
    v_target := v_job.admin_map->>(v_row->>'id');
    IF v_target IS NULL OR v_states ? v_target OR jsonb_typeof(v_row->'is_active') NOT IN ('boolean','null')
      OR NOT EXISTS(SELECT 1 FROM public.admins WHERE id=v_target::uuid AND role=v_row->>'role' AND role<>'super_admin') THEN
      RAISE EXCEPTION 'Source administrator snapshot has an invalid or ambiguous mapping.';
    END IF;
    v_states := v_states||jsonb_build_object(v_target,v_row->'is_active');
    v_bindings := v_bindings||jsonb_build_object(v_target,jsonb_build_object('source_id',v_row->'id','role',v_row->'role'));
  END LOOP;
  IF v_applied THEN
    IF v_job.summary->'site_original_admin_states' IS DISTINCT FROM v_states
      OR v_job.summary->'site_original_admin_bindings' IS DISTINCT FROM v_bindings THEN
      RAISE EXCEPTION 'Source administrator snapshot changed; repeat apply cannot reset it.';
    END IF;
  ELSE
    UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object(
      'site_original_admin_states',v_states,'site_original_admin_bindings',v_bindings) WHERE id=v_job.id;
  END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.employee_import_site_bind_cutoff(p_admin_session_token uuid,p_job_token uuid,p_cutoff jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' SET lock_timeout = '2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_result jsonb;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  PERFORM private.employee_transfer_import_cutoff(p_cutoff,(v_job.options#>>'{catalog,site_id}')::uuid);
  IF v_job.options->>'package_id' IS NULL THEN RAISE EXCEPTION 'Source package identity is missing.'; END IF;
  PERFORM 1 FROM private.employee_transfer_maintenance WHERE singleton AND dirty AND job_id=v_job.id
    AND admin_id=v_job.admin_id AND plan_hash=v_job.summary->>'dispatch_plan_hash' FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'The original dirty dispatch maintenance task is required.'; END IF;
  IF v_job.summary ? 'source_cutover' AND v_job.summary->'source_cutover' IS DISTINCT FROM p_cutoff THEN
    RAISE EXCEPTION 'The source cutoff is already bound and cannot change.';
  END IF;
  v_result := jsonb_build_object('version',1,'success',true,'scope','site-cutover-binding','job_id',v_job.id,
    'source_site_id',v_job.options#>'{catalog,site_id}','package_id',v_job.options->'package_id',
    'cutoff',p_cutoff,'full_site_complete',false);
  -- Old dates may be bound for inspection. Only release enforces today's UTC date.
  IF NOT (v_job.summary ? 'source_cutover') THEN
    UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('source_cutover',p_cutoff) WHERE id=v_job.id;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','site_cutoff_bound',v_result);
  END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.get_employee_import_site_release_status(p_admin_session_token uuid,p_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' AS $$
DECLARE v_admin uuid; v_job private.employee_transfer_jobs%ROWTYPE; v_cutoff jsonb; v_receipt jsonb;
  v_hash text; v_frozen timestamptz; v_now timestamptz := clock_timestamp(); v_released boolean;
  v_maintenance boolean; v_blockers jsonb := '[]';
BEGIN
  SELECT a.admin_id INTO v_admin FROM private.employee_transfer_admin(p_admin_session_token) a;
  SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE id=p_job_id AND admin_id=v_admin
    AND kind='import' AND options->>'import_protocol'='dispatch-submission-v1';
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'The original site import task is unavailable.'; END IF;
  IF jsonb_typeof(v_job.summary->'source_cutover')='object' THEN v_cutoff := v_job.summary->'source_cutover'; END IF;
  IF jsonb_typeof(v_job.summary->'site_release')='object' THEN v_receipt := v_job.summary->'site_release'; END IF;
  v_released := COALESCE(v_receipt->'released'='true'::jsonb,false);
  v_hash := v_job.summary#>>'{site_verification,verification_hash}';
  IF v_hash !~ '^[0-9a-f]{64}$' THEN v_hash := NULL; END IF;
  SELECT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance) INTO v_maintenance;
  -- A committed receipt is historical evidence, not a promise about today's business.
  IF NOT v_released THEN
    IF v_cutoff IS NULL THEN v_blockers := v_blockers||'"missing_cutoff"'::jsonb;
    ELSE
      v_frozen := private.employee_transfer_import_cutoff(v_cutoff,(v_job.options#>>'{catalog,site_id}')::uuid);
      IF v_now<v_frozen OR (v_now AT TIME ZONE 'UTC')::date<>(v_frozen AT TIME ZONE 'UTC')::date THEN
        v_blockers := v_blockers||'"cutoff_expired"'::jsonb;
      END IF;
    END IF;
    IF v_hash IS NULL OR v_job.summary#>'{site_verification,success}' IS DISTINCT FROM 'true'::jsonb
      OR v_job.summary#>>'{site_verification,scope}' IS DISTINCT FROM 'site-restore-verification'
      OR v_job.summary#>>'{site_verification,job_id}' IS DISTINCT FROM v_job.id::text
      OR v_job.summary#>'{site_verification,source_site_id}' IS DISTINCT FROM v_job.options#>'{catalog,site_id}'
      OR v_job.summary#>'{site_verification,package_id}' IS DISTINCT FROM v_job.options->'package_id' THEN
      v_blockers := v_blockers||'"not_verified"'::jsonb;
    END IF;
    IF v_job.status IS DISTINCT FROM 'running' OR v_job.last_activity_at<=v_now-interval '3 hours'
      OR v_job.started_at<=v_now-interval '12 hours' THEN v_blockers := v_blockers||'"task_not_running"'::jsonb; END IF;
    IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance WHERE singleton AND dirty AND job_id=v_job.id
      AND admin_id=v_admin AND plan_hash=v_job.summary->>'dispatch_plan_hash') THEN
      v_blockers := v_blockers||'"maintenance_mismatch"'::jsonb;
    END IF;
  END IF;
  RETURN jsonb_build_object('version',1,'success',true,'scope','site-release-status','job_id',v_job.id,
    'source_site_id',v_job.options#>'{catalog,site_id}','package_id',v_job.options->'package_id','cutoff',v_cutoff,
    'verification_hash',v_hash,'released',v_released,'receipt',v_receipt,'maintenance',v_maintenance,
    'blockers',v_blockers,'can_release',NOT v_released AND v_blockers='[]'::jsonb,'full_site_complete',false);
END;
$$;

-- Reuse the reviewed SQL07/15/27 inventories without disabling any trigger.
-- Hash EVERY full guarded row, substituting only the four explicitly intended
-- state changes in the before-image. Row hashes bound aggregation memory; duplicate
-- rows remain duplicate hashes. The new queue is checked separately and exactly.
CREATE FUNCTION private.employee_transfer_site_release_fingerprint(p_changes jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' AS $$
DECLARE v_table text; v_field text; v_expression text; v_digest jsonb; v_result jsonb := '{}'; v_schema jsonb;
BEGIN
  PERFORM private.employee_transfer_assert_shared_replace_triggers();
  PERFORM private.employee_transfer_assert_identity_triggers();
  PERFORM private.employee_transfer_notification_restore_assert();
  IF private.employee_transfer_pending_trigger_bypass() IS NOT NULL THEN RAISE EXCEPTION 'A trigger bypass is pending.'; END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN ('public.users'::regclass,'public.admins'::regclass,
      'public.notification_automation_plans'::regclass,'public.notification_automation_tasks'::regclass,'public.notification_automation_queue'::regclass)
      AND t.tgisinternal AND t.tgenabled NOT IN ('O','A'))
    OR EXISTS(SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND (
      (t.tgrelid='public.admins'::regclass AND (t.tgtype::integer & 16)<>0
        AND t.tgname NOT IN ('zz_employee_transfer_maintenance','pause_notification_automation_plans_for_disabled_admin'))
      OR (t.tgrelid='public.notification_automation_queue'::regclass AND t.tgname<>'zz_employee_transfer_maintenance'))) THEN
    RAISE EXCEPTION 'Unreviewed site release triggers or disabled foreign key protection.';
  END IF;
  SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)||CASE WHEN attnotnull THEN '!' ELSE '' END)
    INTO v_schema FROM pg_attribute WHERE attrelid='public.notification_automation_queue'::regclass AND attnum>0 AND NOT attisdropped;
  IF v_schema IS DISTINCT FROM '{"user_id":"uuid!","requested_at":"timestamp with time zone!","next_attempt_at":"timestamp with time zone!","attempts":"integer!","last_error":"text"}'::jsonb THEN
    RAISE EXCEPTION 'Unreviewed automation queue schema.';
  END IF;
  FOR v_table IN SELECT name FROM unnest(private.employee_transfer_guarded_tables()) s(name)
    WHERE name<>'public.notification_automation_queue' ORDER BY name COLLATE "C" LOOP
    v_field := CASE v_table WHEN 'public.users' THEN 'is_active' WHEN 'public.admins' THEN 'is_active'
      WHEN 'public.notification_automation_plans' THEN 'status' WHEN 'public.notification_automation_tasks' THEN 'status' END;
    v_expression := 'to_jsonb(t)';
    IF v_field IS NOT NULL THEN
      v_expression := v_expression||format('||CASE WHEN $1 ? t.id::text THEN jsonb_build_object(%L,$1->t.id::text) ELSE ''{}''::jsonb END',v_field);
    END IF;
    EXECUTE format('SELECT jsonb_build_object(''rows'',count(*),''sha256'',encode(extensions.digest(convert_to(
      COALESCE(string_agg(h,E''\n'' ORDER BY h COLLATE "C"),''''),''UTF8''),''sha256''),''hex'')) FROM
      (SELECT encode(extensions.digest(convert_to((%s)::text,''UTF8''),''sha256''),''hex'') AS h FROM %I.%I t) s',
      v_expression,split_part(v_table,'.',1),split_part(v_table,'.',2)) INTO v_digest USING COALESCE(p_changes->v_table,'{}'::jsonb);
    v_result := v_result||jsonb_build_object(v_table,v_digest);
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.employee_import_site_release(p_admin_session_token uuid,p_job_token uuid,
  p_admin_password text,p_confirmation text,p_verification_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' SET lock_timeout = '2s' AS $$
DECLARE v_admin uuid; v_username text; v_check jsonb; v_verified jsonb; v_job private.employee_transfer_jobs%ROWTYPE;
  v_shared private.employee_transfer_jobs%ROWTYPE; v_cutoff jsonb; v_frozen timestamptz; v_now timestamptz; v_queued_at timestamptz;
  v_states jsonb; v_bindings jsonb; v_binding jsonb; v_map record; v_role text; v_key text; v_body jsonb; v_row jsonb;
  v_statuses jsonb; v_expected_statuses jsonb := '{}'; v_changes jsonb := '{}'; v_before jsonb; v_result jsonb;
  v_count integer; v_total integer; v_employees integer; v_active integer; v_admins integer; v_plans integer; v_tasks integer; v_queued integer;
BEGIN
  SELECT a.admin_id,a.admin_username INTO v_admin,v_username FROM private.employee_transfer_admin(p_admin_session_token) a;
  IF p_confirmation IS DISTINCT FROM '確認啟用新站' THEN RAISE EXCEPTION 'Site release confirmation does not match.'; END IF;
  IF p_verification_hash IS NULL OR p_verification_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'A site verification digest is required.'; END IF;
  v_check := private.employee_transfer_verify_password(v_admin,v_username,p_admin_password);
  IF v_check->'success' IS DISTINCT FROM 'true'::jsonb THEN RETURN v_check; END IF;

  -- FIRST acquire SQL55's job -> queue advisory -> guarded relations -> maintenance
  -- locks. Do not pre-acquire a maintenance/configuration lock in reverse order.
  v_verified := public.employee_import_site_verify(p_admin_session_token,p_job_token);
  IF v_verified->'success' IS DISTINCT FROM 'true'::jsonb OR v_verified->>'verification_hash' IS DISTINCT FROM p_verification_hash THEN
    RAISE EXCEPTION 'The freshly verified site digest differs from the confirmed digest.';
  END IF;
  SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE id=(v_verified->>'job_id')::uuid AND admin_id=v_admin;
  v_cutoff := v_job.summary->'source_cutover';
  v_frozen := private.employee_transfer_import_cutoff(v_cutoff,(v_job.options#>>'{catalog,site_id}')::uuid);
  v_now := clock_timestamp();
  IF v_now<v_frozen OR (v_now AT TIME ZONE 'UTC')::date<>(v_frozen AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'Source freeze and site release must be on the same UTC date (Beijing 08:00 boundary).';
  END IF;
  IF v_job.status IS DISTINCT FROM 'running' OR v_job.started_at<=v_now-interval '12 hours'
    OR v_job.last_activity_at<=v_now-interval '3 hours' OR v_job.summary ? 'site_release' THEN
    RAISE EXCEPTION 'The original effective unreleased import task is required; reconcile with release status.';
  END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(v_job.id,'notification_automation_failures'))
    OR EXISTS(SELECT 1 FROM public.notification_automation_failures)
    OR EXISTS(SELECT 1 FROM public.notification_automation_queue)
    OR EXISTS(SELECT 1 FROM public.orders WHERE status='processing') THEN
    RAISE EXCEPTION 'Release requires drained source failures, an empty target queue and no processing orders.';
  END IF;

  SELECT count(*)::integer INTO v_count FROM private.employee_transfer_jobs j WHERE j.kind='import' AND j.admin_id=v_admin
    AND j.options->>'import_protocol'='shared-import-v1' AND j.options->>'replace_policy'='source-v1'
    AND j.options->'package_id'=v_job.options->'package_id' AND j.options#>'{catalog,site_id}'=v_job.options#>'{catalog,site_id}'
    AND j.summary->'shared_applied'='true'::jsonb;
  IF v_count<>1 THEN RAISE EXCEPTION 'A unique same-package shared administrator snapshot is required.'; END IF;
  SELECT * INTO v_shared FROM private.employee_transfer_jobs j WHERE j.kind='import' AND j.admin_id=v_admin
    AND j.options->>'import_protocol'='shared-import-v1' AND j.options->>'replace_policy'='source-v1'
    AND j.options->'package_id'=v_job.options->'package_id' AND j.options#>'{catalog,site_id}'=v_job.options#>'{catalog,site_id}'
    AND j.summary->'shared_applied'='true'::jsonb FOR SHARE NOWAIT;
  v_states := v_shared.summary->'site_original_admin_states'; v_bindings := v_shared.summary->'site_original_admin_bindings';
  IF jsonb_typeof(v_states) IS DISTINCT FROM 'object' OR jsonb_typeof(v_bindings) IS DISTINCT FROM 'object'
    OR v_shared.admin_map IS DISTINCT FROM v_job.summary#>'{identity_restore,admin_map}'
    OR v_shared.admin_map IS DISTINCT FROM v_shared.summary#>'{shared_receipt,admin_map}'
    OR (SELECT count(*) FROM jsonb_object_keys(v_states))<>(SELECT count(*) FROM jsonb_object_keys(v_bindings)) THEN
    RAISE EXCEPTION 'Source administrator states or server mapping are missing or changed.';
  END IF;
  FOR v_map IN SELECT key,value FROM jsonb_each(v_states) LOOP
    v_binding := v_bindings->v_map.key;
    IF jsonb_typeof(v_map.value) NOT IN ('boolean','null')
      OR NOT private.employee_transfer_exact_object(v_binding,ARRAY['source_id','role'])
      OR jsonb_typeof(v_binding->'source_id') IS DISTINCT FROM 'string'
      OR v_binding->>'role' NOT IN ('secondary_admin','emergency_admin')
      OR v_shared.admin_map->>(v_binding->>'source_id') IS DISTINCT FROM v_map.key
      OR NOT EXISTS(SELECT 1 FROM public.admins WHERE id=v_map.key::uuid AND role=v_binding->>'role' AND role<>'super_admin') THEN
      RAISE EXCEPTION 'Source administrator snapshot binding differs.';
    END IF;
  END LOOP;
  FOR v_map IN SELECT key,value FROM jsonb_each_text(v_shared.admin_map) LOOP
    SELECT role INTO v_role FROM public.admins WHERE id=v_map.value::uuid;
    IF v_role='super_admin' THEN
      IF v_map.value IS DISTINCT FROM v_admin::text OR v_states ? v_map.value THEN RAISE EXCEPTION 'Local super administrator is protected.'; END IF;
    ELSIF v_role IS NULL OR NOT (v_states ? v_map.value)
      OR v_bindings#>>ARRAY[v_map.value,'source_id'] IS DISTINCT FROM v_map.key THEN
      RAISE EXCEPTION 'Source administrator snapshot is incomplete.';
    END IF;
  END LOOP;
  v_changes := jsonb_build_object('public.admins',v_states);
  SELECT COALESCE(jsonb_object_agg(id::text,body->'is_active'),'{}'::jsonb),count(*)::integer,
    count(*) FILTER(WHERE body->'is_active'='true'::jsonb)::integer INTO v_statuses,v_employees,v_active
    FROM private.employee_transfer_identity_input(v_job.id,'accounts');
  v_changes := v_changes||jsonb_build_object('public.users',v_statuses);
  SELECT count(*)::integer INTO v_admins FROM jsonb_each(v_states) WHERE value='true'::jsonb;

  FOREACH v_key IN ARRAY ARRAY['notification_automation_plans','notification_automation_tasks'] LOOP
    v_statuses := '{}'; v_total := 0;
    FOR v_body IN SELECT body FROM private.employee_transfer_notifications_input(v_job.id,v_key) LOOP
      v_row := private.employee_transfer_notification_restore_row(v_job,v_key,v_body);
      IF v_statuses ? (v_row->>'id') THEN RAISE EXCEPTION 'Notification release mapping is ambiguous.'; END IF;
      v_statuses := v_statuses||jsonb_build_object(v_row->>'id',v_body->'status'); v_total := v_total+1;
    END LOOP;
    SELECT count(*)::integer INTO v_count FROM jsonb_array_elements(v_job.summary#>'{notification_restore,plan,records}') r WHERE r->>'table_key'=v_key;
    IF v_count<>v_total THEN RAISE EXCEPTION 'Notification release mapping is incomplete.'; END IF;
    v_expected_statuses := v_expected_statuses||jsonb_build_object(v_key,v_statuses);
    v_changes := v_changes||jsonb_build_object('public.'||v_key,v_statuses);
  END LOOP;
  IF v_expected_statuses IS DISTINCT FROM v_job.summary#>'{notification_restore,original_statuses}' THEN
    RAISE EXCEPTION 'Notification original statuses differ from real source staging and server mapping.';
  END IF;
  SELECT count(*)::integer INTO v_plans FROM jsonb_each(v_expected_statuses->'notification_automation_plans') WHERE value='"active"'::jsonb;
  SELECT count(*)::integer INTO v_tasks FROM jsonb_each(v_expected_statuses->'notification_automation_tasks') WHERE value='"active"'::jsonb;
  v_before := private.employee_transfer_site_release_fingerprint(v_changes);

  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names)
    VALUES(pg_current_xact_id(),v_job.id,ARRAY['public.users','public.admins','public.notification_automation_plans',
      'public.notification_automation_tasks','public.notification_automation_queue']);
  UPDATE public.users u SET is_active=(s.value#>>'{}')::boolean FROM jsonb_each(v_changes->'public.users') s
    WHERE u.id=s.key::uuid AND u.is_active IS DISTINCT FROM (s.value#>>'{}')::boolean;
  UPDATE public.admins a SET is_active=(s.value#>>'{}')::boolean FROM jsonb_each(v_states) s
    WHERE a.id=s.key::uuid AND a.role<>'super_admin' AND a.is_active IS DISTINCT FROM (s.value#>>'{}')::boolean;
  -- Existing paused/archived plans can retain active tasks; evaluators are locked throughout this transaction.
  UPDATE public.notification_automation_plans p SET status='active'
    WHERE p.id::text IN (SELECT key FROM jsonb_each(v_expected_statuses->'notification_automation_plans'))
      AND p.status<>'active' AND EXISTS(SELECT 1 FROM public.notification_automation_tasks t
        JOIN jsonb_each(v_expected_statuses->'notification_automation_tasks') s ON s.key=t.id::text
        WHERE t.plan_id=p.id AND s.value='"active"'::jsonb);
  UPDATE public.notification_automation_tasks t SET status=s.value#>>'{}'
    FROM jsonb_each(v_expected_statuses->'notification_automation_tasks') s WHERE t.id=s.key::uuid AND t.status IS DISTINCT FROM s.value#>>'{}';
  UPDATE public.notification_automation_plans p SET status=s.value#>>'{}'
    FROM jsonb_each(v_expected_statuses->'notification_automation_plans') s WHERE p.id=s.key::uuid AND p.status IS DISTINCT FROM s.value#>>'{}';

  -- This schema calls queue creation time requested_at, NOT created_at. All active
  -- imported employees get exactly one fresh request; no evaluation/send/bonus RPC.
  v_queued_at := clock_timestamp();
  INSERT INTO public.notification_automation_queue(user_id,requested_at,next_attempt_at,attempts,last_error)
    SELECT a.id,v_queued_at,v_queued_at,0,NULL FROM private.employee_transfer_identity_input(v_job.id,'accounts') a
      WHERE a.body->'is_active'='true'::jsonb;
  GET DIAGNOSTICS v_queued=ROW_COUNT;
  PERFORM private.employee_transfer_clear_write_permit();
  IF v_queued<>v_active OR (SELECT count(*) FROM public.notification_automation_queue)<>v_active
    OR EXISTS(SELECT 1 FROM public.notification_automation_queue q LEFT JOIN public.users u ON u.id=q.user_id
      WHERE u.id IS NULL OR u.is_active IS DISTINCT FROM true OR q.requested_at IS DISTINCT FROM v_queued_at
        OR q.next_attempt_at IS DISTINCT FROM v_queued_at OR q.attempts IS DISTINCT FROM 0 OR q.last_error IS NOT NULL) THEN
    RAISE EXCEPTION 'Released employee queue differs from the exact fresh active set.';
  END IF;
  IF v_before IS DISTINCT FROM private.employee_transfer_site_release_fingerprint('{}'::jsonb) THEN
    RAISE EXCEPTION 'Site release changed a full row beyond its intended state; assets, versions and progress must not change.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['notification_automation_plans','notification_automation_tasks'] LOOP
    FOR v_body IN SELECT body FROM private.employee_transfer_notifications_input(v_job.id,v_key) LOOP
      v_row := private.employee_transfer_notification_restore_row(v_job,v_key,v_body)||jsonb_build_object('status',v_body->'status');
      PERFORM private.employee_transfer_notification_restore_check_row(v_key,v_row);
    END LOOP;
  END LOOP;
  -- Includes retired tasks, unimported administrators and every financial/history
  -- row in the full-row fingerprint: no status reset, new baseline or hidden send.
  v_now := clock_timestamp();
  v_result := jsonb_build_object('version',1,'success',true,'scope','site-release','job_id',v_job.id,
    'source_site_id',v_job.options#>'{catalog,site_id}','package_id',v_job.options->'package_id',
    'cutoff_id',v_cutoff->'cutoff_id','cutoff_hash',v_cutoff->'cutoff_hash','verification_hash',p_verification_hash,
    'released_at',to_char(v_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'counts',jsonb_build_object('employees',v_employees,'active_employees',v_active,'active_admins',v_admins,
      'active_plans',v_plans,'active_tasks',v_tasks,'queued_employees',v_queued),
    'released',true,'maintenance',false,'accounts_restored',true,'automation_resumed',true,
    'source_shutdown','operator-managed','full_site_complete',false);
  DELETE FROM private.employee_transfer_maintenance WHERE singleton AND dirty AND job_id=v_job.id AND admin_id=v_admin
    AND plan_hash=v_job.summary->>'dispatch_plan_hash';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 OR EXISTS(SELECT 1 FROM private.employee_transfer_maintenance) THEN RAISE EXCEPTION 'Original release maintenance ownership changed.'; END IF;
  -- Do not call employee_transfer_finish(): all staging and sealed backups survive.
  UPDATE private.employee_transfer_jobs SET status='finished',finished_at=v_now,
    summary=summary||jsonb_build_object('site_release',v_result) WHERE id=v_job.id AND status='running';
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'Original release task state changed.'; END IF;
  PERFORM private.employee_transfer_log(v_job.id,v_admin,v_username,'import','site_released',v_result);
  v_now := clock_timestamp();
  IF v_now<v_frozen OR (v_now AT TIME ZONE 'UTC')::date<>(v_frozen AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'Site release crossed the UTC date boundary; the entire release was rolled back.';
  END IF;
  RETURN v_result;
EXCEPTION WHEN OTHERS THEN
  PERFORM private.employee_transfer_clear_write_permit();
  RAISE;
END;
$$;

-- Keep v3 and the original list/shape. Check the release RPCs AND that the public
-- shared apply really wraps SQL45 with source-state capture before first writes.
ALTER FUNCTION public.get_employee_import_site_preflight(uuid,uuid) SET SCHEMA private;
ALTER FUNCTION private.get_employee_import_site_preflight(uuid,uuid) RENAME TO employee_transfer_site_preflight_v3;
CREATE FUNCTION public.get_employee_import_site_preflight(p_admin_session_token uuid,p_source_site_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_result jsonb; v_rpc text; v_ok boolean;
BEGIN
  v_result := private.employee_transfer_site_preflight_v3(p_admin_session_token,p_source_site_id);
  FOREACH v_rpc IN ARRAY ARRAY['public.employee_import_site_bind_cutoff(uuid,uuid,jsonb)',
    'public.get_employee_import_site_release_status(uuid,uuid)','public.employee_import_site_release(uuid,uuid,text,text,text)',
    'public.employee_import_shared_replace_apply(uuid,uuid,text)'] LOOP
    SELECT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(v_rpc) AND prokind='f' AND prorettype='jsonb'::regtype AND prosecdef) INTO v_ok;
    IF v_rpc='public.employee_import_shared_replace_apply(uuid,uuid,text)' THEN
      v_ok := v_ok AND EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('private.employee_import_shared_replace_apply_v45(uuid,uuid,text)')
        AND prokind='f' AND prorettype='jsonb'::regtype AND prosecdef)
        AND EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(v_rpc)
          AND position('private.employee_import_shared_replace_apply_v45(' IN prosrc)>0
          AND position('site_original_admin_states' IN prosrc)>0 AND position('site_original_admin_bindings' IN prosrc)>0);
    END IF;
    IF NOT v_ok THEN
      IF NOT (v_result->'missing_rpcs' ? v_rpc) THEN
        v_result := jsonb_set(v_result,'{missing_rpcs}',(v_result->'missing_rpcs')||jsonb_build_array(v_rpc));
      END IF;
      IF NOT (v_result->'blockers' ? 'missing_backend_support') THEN
        v_result := jsonb_set(v_result,'{blockers}',(v_result->'blockers')||'["missing_backend_support"]'::jsonb);
      END IF;
      v_result := v_result||'{"can_restore_to_maintenance":false}'::jsonb;
    END IF;
  END LOOP;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_import_cutoff(jsonb,uuid),
  private.employee_import_shared_replace_apply_v45(uuid,uuid,text),
  private.employee_transfer_site_release_fingerprint(jsonb),private.employee_transfer_site_preflight_v3(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.employee_import_shared_replace_apply(uuid,uuid,text),
  public.employee_import_site_bind_cutoff(uuid,uuid,jsonb),public.get_employee_import_site_release_status(uuid,uuid),
  public.employee_import_site_release(uuid,uuid,text,text,text),public.get_employee_import_site_preflight(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_import_shared_replace_apply(uuid,uuid,text),
  public.employee_import_site_bind_cutoff(uuid,uuid,jsonb),public.get_employee_import_site_release_status(uuid,uuid),
  public.employee_import_site_release(uuid,uuid,text,text,text),public.get_employee_import_site_preflight(uuid,uuid)
  TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
