BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

DO $install_activity_audit$
DECLARE v_expected constant jsonb:='{
 "employee_login_history.employee_login_history_emit_event": "851159bd703c8a5825feb88ad6cd0144722f32b53cdc07773fabd5a43077c6b5",
 "employee_login_history.queue_notification_automation_from_employee_login": "29b9fc0cbcd22498e4af0cb161ce3dbc1c30f775e364fb1181be00e81e4b002c",
 "work_sessions.queue_notification_automation_from_work_session": "7e55a0dea7e7301f741350e1cacd8bf9b6c78abc458f634dd5dfeb059f510ea5",
 "work_sessions.trigger_check_overlapping": "e8bd082ce3faab4502d7e64b93e5bd9aebc04e3bdd20b372378ef766d784dfca",
 "work_sessions.trigger_cleanup_duplicate_sessions": "7caa7848ebeed0617b0ea097a1492f0be5e7efcf757fa1a3a0ff68830f38b184",
 "work_sessions.trigger_prevent_multiple_active_sessions": "0693efe8c7049f0e583a6ded11f8a7811dba1a76fb131eb803c59882e6a7a679",
 "work_sessions.trigger_validate_work_session": "a4a555eb0c82b739e753718ecef8b8121acf3f50d2cc76ed789288ddecffd5e5"
}';v_native jsonb; v_actual jsonb;v_modes jsonb;
BEGIN
  SELECT jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_install_trigger_digest(t.oid)),jsonb_object_agg(c.relname||'.'||t.tgname,t.tgenabled::text),
    jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_trigger_digest(t.oid))
    INTO v_actual,v_modes,v_native FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid
    WHERE t.tgrelid IN ('public.employee_login_history'::regclass,'public.work_sessions'::regclass,'private.employee_work_stop_markers'::regclass)
      AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance';
  IF v_actual IS DISTINCT FROM v_expected OR EXISTS(SELECT 1 FROM jsonb_each_text(v_modes) WHERE value NOT IN ('O','A')) THEN RAISE EXCEPTION 'Unreviewed employee activity triggers.';END IF;
  EXECUTE format($definition$
    CREATE FUNCTION private.employee_transfer_assert_activity_triggers()
    RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, private, pg_temp AS $body$
    DECLARE v_expected constant jsonb:=%L::jsonb;v_modes constant jsonb:=%L::jsonb;v_actual jsonb;v_actual_modes jsonb;
    BEGIN
      PERFORM private.employee_transfer_assert_maintenance_guards();
      SELECT jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_trigger_digest(t.oid)),jsonb_object_agg(c.relname||'.'||t.tgname,t.tgenabled::text)
        INTO v_actual,v_actual_modes FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid
        WHERE t.tgrelid IN ('public.employee_login_history'::regclass,'public.work_sessions'::regclass,'private.employee_work_stop_markers'::regclass)
          AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance';
      IF v_actual IS DISTINCT FROM v_expected OR v_actual_modes IS DISTINCT FROM v_modes THEN RAISE EXCEPTION 'Unreviewed employee activity triggers.';END IF;
    END;
    $body$;
  $definition$,v_native::text,v_modes::text);
END;
$install_activity_audit$;

CREATE FUNCTION private.employee_transfer_activity_context(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;v_completed bigint;
BEGIN
  v_map:=private.employee_transfer_activity_owner(p_job);
  PERFORM private.employee_transfer_assert_activity_triggers();
  PERFORM private.employee_transfer_finance_context(p_job);
  PERFORM private.employee_transfer_check_finance_input(p_job);
  v_completed:=private.employee_transfer_finance_progress(p_job,v_map);
  IF v_completed IS DISTINCT FROM (p_job.summary#>>'{identity_catalog,tables,0,rows}')::bigint THEN RAISE EXCEPTION 'Complete verified finance is required for activity.';END IF;
  RETURN v_map;
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_source_issues(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_issues jsonb:='[]';
BEGIN
  FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions','work_stop_markers'] LOOP
    IF EXISTS(WITH accounts AS MATERIALIZED(SELECT id FROM private.employee_transfer_identity_input(p_job.id,'accounts'))
      SELECT 1 FROM private.employee_transfer_activity_input(p_job.id,v_key) AS h LEFT JOIN accounts AS a ON a.id=(h.body->>'user_id')::uuid WHERE a.id IS NULL) THEN
      v_issues:=v_issues||'"source_employee_missing"'::jsonb;EXIT;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_activity_input(p_job.id,'work_sessions')
    WHERE body->>'end_time' IS NULL AND round(extract(epoch FROM (
      GREATEST((body->>'start_time')::timestamptz,COALESCE((body->>'last_heartbeat_at')::timestamptz,(body->>'start_time')::timestamptz))
      -(body->>'start_time')::timestamptz))/60)>2147483647) THEN
    v_issues:=v_issues||'"work_duration_out_of_range"'::jsonb;
  END IF;
  RETURN v_issues;
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_target_issues(p_job private.employee_transfer_jobs,p_employee uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_bad boolean;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions','work_stop_markers'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s AS t JOIN private.employee_transfer_identity_input($1,''accounts'') AS a ON a.id=t.user_id WHERE ($2::uuid IS NULL OR a.id=$2))',private.employee_transfer_activity_relation(v_key)) INTO v_bad USING p_job.id,p_employee;
    IF v_bad THEN RETURN '["activity_target_not_empty"]'::jsonb;END IF;
  END LOOP;
  RETURN '[]'::jsonb;
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_plan(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_counts jsonb;v_issues jsonb;v_running bigint;v_plan jsonb;
BEGIN
  v_counts:=private.employee_transfer_check_activity_input(p_job);
  v_issues:=private.employee_transfer_activity_source_issues(p_job)||private.employee_transfer_activity_target_issues(p_job);
  IF EXISTS(SELECT 1 FROM private.employee_transfer_activity_input(p_job.id,'employee_login_history') AS h JOIN public.employee_login_history AS t ON t.id=h.id::uuid)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_activity_input(p_job.id,'work_sessions') AS h JOIN public.work_sessions AS t ON t.id=h.id::uuid) THEN
    v_issues:=v_issues||'"activity_uuid_collision"'::jsonb;
  END IF;
  SELECT count(*) INTO v_running FROM private.employee_transfer_activity_input(p_job.id,'work_sessions') WHERE body->>'end_time' IS NULL;
  v_plan:=jsonb_build_object('scope','employee-activity','can_restore',jsonb_array_length(v_issues)=0,'counts',v_counts,
    'employees',(p_job.summary#>>'{identity_catalog,tables,0,rows}')::bigint,'running_work_sessions',v_running,
    'conflicts',v_issues,'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,'job_id',p_job.id,
    'catalog',p_job.summary->'activity_catalog','admin_map',p_map)::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_expected(p_job private.employee_transfer_jobs,p_employee uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  PERFORM private.employee_transfer_activity_relation(p_key);
  RETURN QUERY SELECT h.id,h.body||CASE WHEN p_key='work_sessions' AND h.body->>'end_time' IS NULL THEN jsonb_build_object(
    'end_time',GREATEST((h.body->>'start_time')::timestamptz,COALESCE((h.body->>'last_heartbeat_at')::timestamptz,(h.body->>'start_time')::timestamptz)),
    'duration_minutes',GREATEST(round(extract(epoch FROM (GREATEST((h.body->>'start_time')::timestamptz,
      COALESCE((h.body->>'last_heartbeat_at')::timestamptz,(h.body->>'start_time')::timestamptz))-(h.body->>'start_time')::timestamptz))/60)::integer,0)) ELSE '{}'::jsonb END
    FROM private.employee_transfer_activity_input(p_job.id,p_key) AS h WHERE h.body->>'user_id'=p_employee::text;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_activity_written(p_job private.employee_transfer_jobs,p_employee uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_expected bigint;v_actual bigint;v_bad boolean;v_counts jsonb:='{}';
BEGIN
  FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions','work_stop_markers'] LOOP
    SELECT count(*) INTO v_expected FROM private.employee_transfer_activity_input(p_job.id,v_key) WHERE body->>'user_id'=p_employee::text;
    EXECUTE format('SELECT count(*) FROM %s WHERE user_id=$1',private.employee_transfer_activity_relation(v_key)) INTO v_actual USING p_employee;
    IF v_actual IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Activity committed count changed.';END IF;
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM private.employee_transfer_activity_expected($1,$2,$3) AS expected LEFT JOIN ('||private.employee_transfer_activity_query(v_key,false)||') AS actual
      ON actual.id::text=expected.id AND actual.body=expected.body WHERE actual.id IS NULL)' INTO v_bad USING p_job,p_employee,v_key;
    IF v_bad THEN RAISE EXCEPTION 'Activity post-write content verification failed.';END IF;
    v_counts:=v_counts||jsonb_build_object(v_key,v_actual);
  END LOOP;
  RETURN v_counts;
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_progress(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_count bigint:=0;v_done record;v_actual jsonb;
BEGIN
  IF p_job.summary ? 'activity_restore' AND p_job.summary#>'{activity_restore,admin_map}' IS DISTINCT FROM p_map THEN RAISE EXCEPTION 'Activity administrator mapping changed.';END IF;
  FOR v_done IN SELECT employee_id,payload FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='activity-done' LOOP
    IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') WHERE id=v_done.employee_id)
      OR v_done.payload->>'plan_hash' IS DISTINCT FROM p_job.summary#>>'{activity_plan,plan_hash}' THEN RAISE EXCEPTION 'Activity completion binding changed.';END IF;
    v_actual:=private.employee_transfer_check_activity_written(p_job,v_done.employee_id);
    IF v_done.payload->'counts' IS DISTINCT FROM v_actual THEN RAISE EXCEPTION 'Activity completion counts changed.';END IF;
    v_count:=v_count+1;
  END LOOP;
  IF v_count IS DISTINCT FROM COALESCE((p_job.summary#>>'{activity_restore,completed_employees}')::bigint,0) THEN RAISE EXCEPTION 'Activity committed progress changed.';END IF;
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.get_employee_import_activity_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_map jsonb;v_plan jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_activity_context(v_job);
  IF v_job.summary ? 'activity_restore' THEN PERFORM private.employee_transfer_check_activity_input(v_job);PERFORM private.employee_transfer_activity_progress(v_job,v_map);RETURN v_job.summary->'activity_plan';END IF;
  v_plan:=private.employee_transfer_activity_plan(v_job,v_map);
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('activity_plan',v_plan) WHERE id=v_job.id;RETURN v_plan;
END;
$$;

CREATE FUNCTION private.employee_transfer_allow_activity_write(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  PERFORM private.employee_transfer_activity_owner(p_job);
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names) VALUES(pg_current_xact_id(),p_job.id,
    ARRAY['public.employee_login_history','public.work_sessions','private.employee_work_stop_markers']);
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_receipt(p_employee uuid,p_counts jsonb,p_completed bigint,p_total bigint,p_repeated boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object('success',true,'scope','employee-activity','counts',p_counts,'completed_employees',p_completed,'total_employees',p_total,
    'verified',true,'repeated',p_repeated,'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false)
    ||CASE WHEN p_employee IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('employee_id',p_employee) END;
$$;

CREATE FUNCTION public.employee_import_activity_apply(p_admin_session_token uuid,p_job_token uuid,p_employee_id uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_map jsonb;v_plan jsonb;v_completed bigint;v_total bigint;v_counts jsonb;v_done jsonb;v_disabled jsonb;
  v_key text;v_row jsonb;v_columns text;v_projection text;v_relation regclass;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_activity_context(v_job);PERFORM private.employee_transfer_check_activity_input(v_job);
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_job.summary#>>'{activity_plan,plan_hash}' OR v_job.summary#>'{activity_plan,can_restore}' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'A matching conflict-free activity plan must be confirmed.';END IF;
  IF p_employee_id IS NULL OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(v_job.id,'accounts') WHERE id=p_employee_id) THEN RAISE EXCEPTION 'Activity employee is not a verified member of this source package.';END IF;
  v_total:=(v_job.summary#>>'{activity_plan,employees}')::bigint;v_completed:=private.employee_transfer_activity_progress(v_job,v_map);
  SELECT payload INTO v_done FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id=p_employee_id AND table_key='activity-done' AND chunk_no=0;
  IF v_done IS NOT NULL THEN RETURN private.employee_transfer_activity_receipt(p_employee_id,v_done->'counts',v_completed,v_total,true);END IF;
  IF NOT v_job.summary ? 'activity_restore' THEN
    v_plan:=private.employee_transfer_activity_plan(v_job,v_map);
    IF v_plan IS DISTINCT FROM v_job.summary->'activity_plan' THEN RAISE EXCEPTION 'Activity plan or target changed.';END IF;
  ELSIF private.employee_transfer_activity_target_issues(v_job,p_employee_id)<>'[]'::jsonb THEN RAISE EXCEPTION 'Employee activity target changed or is no longer empty.';END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_activity_input(v_job.id,'employee_login_history') AS h JOIN public.employee_login_history AS t ON t.id=h.id::uuid WHERE h.body->>'user_id'=p_employee_id::text)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_activity_input(v_job.id,'work_sessions') AS h JOIN public.work_sessions AS t ON t.id=h.id::uuid WHERE h.body->>'user_id'=p_employee_id::text) THEN
    RAISE EXCEPTION 'Activity UUID collision changed after planning.';
  END IF;
  PERFORM private.employee_transfer_allow_activity_write(v_job);
  v_disabled:=private.employee_transfer_bypass_triggers(ARRAY['employee_login_history','work_sessions']);
  FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions','work_stop_markers'] LOOP
    v_relation:=private.employee_transfer_activity_relation(v_key);
    SELECT string_agg(format('%I',key),',' ORDER BY key COLLATE "C"),string_agg(CASE WHEN v_key='employee_login_history' AND key='device_info' THEN
      'CASE WHEN ($1->>''device_info_is_sql_null'')::boolean THEN NULL::jsonb ELSE $1->''device_info'' END' ELSE format('r.%I',key) END,',' ORDER BY key COLLATE "C")
      INTO v_columns,v_projection FROM jsonb_each(private.employee_transfer_activity_spec()->v_key) WHERE key<>'device_info_is_sql_null' AND NOT(v_key='work_stop_markers' AND key='id');
    FOR v_row IN SELECT body FROM private.employee_transfer_activity_expected(v_job,p_employee_id,v_key) ORDER BY id::uuid LOOP
      PERFORM private.employee_transfer_check_activity_row(v_key,v_row);
      EXECUTE format('INSERT INTO %s(%s) SELECT %s FROM jsonb_populate_record(NULL::%s,$1) AS r',v_relation,v_columns,v_projection,v_relation) USING v_row;
    END LOOP;
  END LOOP;
  PERFORM private.employee_transfer_restore_triggers(v_disabled);PERFORM private.employee_transfer_clear_write_permit();PERFORM private.employee_transfer_assert_activity_triggers();
  v_counts:=private.employee_transfer_check_activity_written(v_job,p_employee_id);v_completed:=v_completed+1;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('activity_restore',jsonb_build_object('completed_employees',v_completed,'admin_map',v_map,'verified',false)) WHERE id=v_job.id;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,p_employee_id,'activity-done',0,1,jsonb_build_object('plan_hash',p_plan_hash,'counts',v_counts));
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','activity_employee_restored',jsonb_build_object('employee_id',p_employee_id,'counts',v_counts,'full_site_complete',false));
  RETURN private.employee_transfer_activity_receipt(p_employee_id,v_counts,v_completed,v_total,false);
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit();RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_activity_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_map jsonb;v_counts jsonb;v_completed bigint;v_total bigint;v_repeated boolean;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');v_map:=private.employee_transfer_activity_context(v_job);
  v_counts:=private.employee_transfer_check_activity_input(v_job);v_completed:=private.employee_transfer_activity_progress(v_job,v_map);v_total:=(v_job.summary#>>'{activity_plan,employees}')::bigint;
  IF v_total IS NULL OR v_job.summary#>'{activity_plan,can_restore}' IS DISTINCT FROM 'true'::jsonb OR v_completed<>v_total THEN RAISE EXCEPTION 'Activity restore is incomplete.';END IF;
  v_repeated:=COALESCE((v_job.summary#>>'{activity_restore,verified}')::boolean,false);
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('activity_restore',jsonb_build_object('completed_employees',v_completed,'admin_map',v_map,'verified',true)) WHERE id=v_job.id;
  IF NOT v_repeated THEN PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','activity_verified',jsonb_build_object('counts',v_counts,'full_site_complete',false));END IF;
  RETURN private.employee_transfer_activity_receipt(NULL,v_counts,v_completed,v_total,v_repeated);
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);END LOOP;
  REVOKE ALL ON FUNCTION public.get_employee_import_activity_plan(uuid,uuid),public.employee_import_activity_apply(uuid,uuid,uuid,text),public.employee_import_activity_verify(uuid,uuid) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.get_employee_import_activity_plan(uuid,uuid),public.employee_import_activity_apply(uuid,uuid,uuid,text),public.employee_import_activity_verify(uuid,uuid) TO anon,authenticated;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
