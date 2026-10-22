BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_mapped_activity_input(p_job_id uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
BEGIN
  PERFORM private.employee_transfer_activity_cursor_type(p_key);
  RETURN QUERY SELECT r.value->>'id',r.value FROM private.employee_transfer_staging AS s
    CROSS JOIN LATERAL jsonb_array_elements(s.payload->'rows') AS r(value)
    WHERE s.job_id=p_job_id AND s.employee_id='00000000-0000-0000-0000-000000000000'
      AND s.table_key='mapped-activity-in:'||p_key;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_catalog(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_n bigint;v_stage record;
BEGIN
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-activity-catalog-v1';
  IF v_n=0 THEN RETURN NULL;END IF;
  IF v_n<>1 THEN RAISE EXCEPTION 'Mapped activity catalog state changed.';END IF;
  SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-activity-catalog-v1';
  IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>0 OR v_stage.row_count<>1 THEN
    RAISE EXCEPTION 'Mapped activity catalog namespace changed.';
  END IF;
  PERFORM private.employee_transfer_check_activity_catalog(v_stage.payload);
  IF v_stage.payload->'identity_catalog' IS DISTINCT FROM p_job.summary->'identity_catalog'
    OR v_stage.payload->'site_id' IS DISTINCT FROM p_job.options#>'{catalog,site_id}'
    OR v_stage.payload->'package_id' IS DISTINCT FROM p_job.options->'package_id' THEN
    RAISE EXCEPTION 'Mapped activity source binding changed.';
  END IF;
  RETURN v_stage.payload;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_parse(p_key text,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_line text;v_json json;v_rows jsonb:='[]';v_hashes text:='';v_last text;v_bad boolean;v_type text;
BEGIN
  v_type:=private.employee_transfer_activity_cursor_type(p_key);
  IF p_ndjson IS NULL OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN
    RAISE EXCEPTION 'Invalid mapped activity chunk.';
  END IF;
  IF p_ndjson<>'' THEN
    FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS r(line) LOOP
      IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Mapped activity row exceeds limits.';END IF;
      v_json:=v_line::json;
      IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN
        RAISE EXCEPTION 'Invalid mapped activity JSON.';
      END IF;
      PERFORM private.employee_transfer_check_activity_row(p_key,v_json::jsonb);
      IF p_key='employee_login_history' THEN PERFORM private.employee_transfer_replacement_device_check(v_json::jsonb->'device_info');END IF;
      EXECUTE 'SELECT $1::'||v_type||'>=$2::'||v_type INTO v_bad USING v_last,v_json->>'id';
      IF COALESCE(v_bad,false) THEN RAISE EXCEPTION 'Mapped activity row order changed.';END IF;
      v_last:=v_json->>'id';v_rows:=v_rows||jsonb_build_array(v_json::jsonb);
      IF jsonb_array_length(v_rows)>200 THEN RAISE EXCEPTION 'Mapped activity chunk exceeds limits.';END IF;
      v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_last);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_source(p_job private.employee_transfer_jobs,p_complete boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_catalog jsonb;v_table jsonb;v_key text;v_stage record;v_payload jsonb;v_chunks integer;v_rows bigint;v_bytes bigint;
  v_hashes text;v_last text;v_first text;v_bad boolean;v_type text;v_total bigint:=0;v_counts jsonb:='{}';
BEGIN
  v_catalog:=private.employee_transfer_mapped_activity_catalog(p_job);
  IF v_catalog IS NULL THEN RAISE EXCEPTION 'Bind a mapped activity catalog first.';END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(v_catalog->'tables') LOOP
    v_key:=v_table->>'key';v_type:=private.employee_transfer_activity_cursor_type(v_key);
    v_chunks:=0;v_rows:=0;v_bytes:=0;v_hashes:='';v_last:=NULL;
    FOR v_stage IN SELECT * FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND table_key='mapped-activity-in:'||v_key ORDER BY chunk_no LOOP
      IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>v_chunks
        OR v_stage.row_count NOT BETWEEN 0 AND 200 OR NOT private.employee_transfer_exact_object(v_stage.payload,
          ARRAY['ndjson','rows','bytes','row_hashes','last_id']) OR jsonb_typeof(v_stage.payload->'ndjson') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_stage.payload->'bytes') IS DISTINCT FROM 'number'
        OR (v_stage.payload->>'bytes') !~ '^(0|[1-9][0-9]{0,5})$' THEN
        RAISE EXCEPTION 'Mapped activity source namespace changed.';
      END IF;
      v_payload:=private.employee_transfer_mapped_activity_parse(v_key,v_stage.payload->>'ndjson');
      IF v_payload IS DISTINCT FROM v_stage.payload OR jsonb_array_length(v_payload->'rows')<>v_stage.row_count
        OR (v_stage.row_count=0 AND (v_chunks<>0 OR v_table->'rows' IS DISTINCT FROM '0'::jsonb)) THEN
        RAISE EXCEPTION 'Mapped activity source raw rows or hashes changed.';
      END IF;
      v_first:=v_payload#>>'{rows,0,id}';
      EXECUTE 'SELECT $1::'||v_type||'>=$2::'||v_type INTO v_bad USING v_last,v_first;
      IF COALESCE(v_bad,false) THEN RAISE EXCEPTION 'Mapped activity source chunk order changed.';END IF;
      v_last:=v_payload->>'last_id';v_chunks:=v_chunks+1;v_rows:=v_rows+v_stage.row_count;
      v_bytes:=v_bytes+(v_payload->>'bytes')::bigint;v_hashes:=v_hashes||(v_payload->>'row_hashes');
    END LOOP;
    v_total:=v_total+v_bytes;
    IF v_rows>(v_table->>'rows')::bigint OR v_bytes>(v_table->>'bytes')::bigint OR v_rows>500000 OR v_bytes>268435456
      OR v_total>1073741824 OR (v_rows=0 AND v_chunks>1) THEN RAISE EXCEPTION 'Mapped activity source exceeds catalog.';END IF;
    IF p_complete AND (v_chunks=0 OR v_rows<>(v_table->>'rows')::bigint OR v_bytes<>(v_table->>'bytes')::bigint
      OR encode(extensions.digest(convert_to(v_hashes,'UTF8'),'sha256'),'hex') IS DISTINCT FROM v_table->>'row_hashes_sha256') THEN
      RAISE EXCEPTION 'Mapped activity source directory is incomplete or changed.';
    END IF;
    v_counts:=v_counts||jsonb_build_object(v_key,v_rows);
  END LOOP;
  RETURN v_counts;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_check_counts(p_counts jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_value jsonb;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_counts,ARRAY['employee_login_history','work_sessions','work_stop_markers']) THEN RAISE EXCEPTION 'Mapped activity count keys changed.';END IF;
  FOR v_value IN SELECT value FROM jsonb_each(p_counts) LOOP
    IF jsonb_typeof(v_value) IS DISTINCT FROM 'number' OR (v_value#>>'{}') !~ '^(0|[1-9][0-9]{0,5})$'
      OR (v_value#>>'{}')::bigint>500000 THEN RAISE EXCEPTION 'Mapped activity count type changed.';END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_saved(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_n bigint;v_stage record;
BEGIN
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-activity-v1';
  IF v_n=0 THEN RETURN NULL;END IF;
  IF v_n<>1 THEN RAISE EXCEPTION 'Mapped activity state set changed.';END IF;
  SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-activity-v1';
  IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>0 OR v_stage.row_count<>1
    OR NOT private.employee_transfer_exact_object(v_stage.payload,ARRAY['plan','identity_map','admin_map','completed_employees','verified'])
    OR jsonb_typeof(v_stage.payload->'completed_employees') IS DISTINCT FROM 'number'
    OR (v_stage.payload->>'completed_employees') !~ '^(0|[1-9][0-9]{0,5})$'
    OR jsonb_typeof(v_stage.payload->'verified') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Mapped activity saved state changed.';
  END IF;
  IF NOT private.employee_transfer_exact_object(v_stage.payload->'plan',ARRAY['scope','job_id','site_id','source_site_id','package_id',
    'catalog_hash','mapping_hash','plan_hash','totals','employees','running_work_sessions','maintenance','dependencies_pending',
    'financial_data_pending','can_restore','complete_employee_backup','can_archive','can_replace','full_site_complete','can_begin','conflicts'])
    OR jsonb_typeof(v_stage.payload#>'{plan,employees}') IS DISTINCT FROM 'number'
    OR (v_stage.payload#>>'{plan,employees}') !~ '^(0|[1-9][0-9]{0,5})$'
    OR jsonb_typeof(v_stage.payload#>'{plan,running_work_sessions}') IS DISTINCT FROM 'number'
    OR (v_stage.payload#>>'{plan,running_work_sessions}') !~ '^(0|[1-9][0-9]{0,5})$' THEN
    RAISE EXCEPTION 'Mapped activity plan fields changed.';
  END IF;
  PERFORM private.employee_transfer_mapped_activity_check_counts(v_stage.payload#>'{plan,totals}');
  RETURN v_stage.payload;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_empty(p_target uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
BEGIN
  RETURN NOT EXISTS(SELECT 1 FROM public.employee_login_history WHERE user_id=p_target)
    AND NOT EXISTS(SELECT 1 FROM public.work_sessions WHERE user_id=p_target)
    AND NOT EXISTS(SELECT 1 FROM private.employee_work_stop_markers WHERE user_id=p_target);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_expected(p_job private.employee_transfer_jobs,p_source uuid,p_target uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
BEGIN
  PERFORM private.employee_transfer_activity_relation(p_key);
  RETURN QUERY SELECT CASE WHEN p_key='work_stop_markers' THEN p_target::text ELSE h.id END,
    h.body||jsonb_build_object('user_id',p_target)||CASE WHEN p_key='work_stop_markers' THEN jsonb_build_object('id',p_target) ELSE '{}'::jsonb END||CASE WHEN p_key='work_sessions' AND h.body->>'end_time' IS NULL THEN jsonb_build_object(
    'end_time',GREATEST((h.body->>'start_time')::timestamptz,COALESCE((h.body->>'last_heartbeat_at')::timestamptz,(h.body->>'start_time')::timestamptz)),
    'duration_minutes',GREATEST(round(extract(epoch FROM (GREATEST((h.body->>'start_time')::timestamptz,
      COALESCE((h.body->>'last_heartbeat_at')::timestamptz,(h.body->>'start_time')::timestamptz))-(h.body->>'start_time')::timestamptz))/60)::integer,0)) ELSE '{}'::jsonb END
    FROM private.employee_transfer_mapped_activity_input(p_job.id,p_key) AS h WHERE h.body->>'user_id'=p_source::text;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_check_written(p_job private.employee_transfer_jobs,p_source uuid,p_target uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_expected bigint;v_actual bigint;v_bad boolean;v_counts jsonb:='{}';
BEGIN
  FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions','work_stop_markers'] LOOP
    SELECT count(*) INTO v_expected FROM private.employee_transfer_mapped_activity_input(p_job.id,v_key) WHERE body->>'user_id'=p_source::text;
    EXECUTE format('SELECT count(*) FROM %s WHERE user_id=$1',private.employee_transfer_activity_relation(v_key)) INTO v_actual USING p_target;
    IF v_actual IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Activity committed count changed.';END IF;
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM private.employee_transfer_mapped_activity_expected($1,$2,$3,$4) AS expected LEFT JOIN ('||private.employee_transfer_activity_query(v_key,false)||') AS actual
      ON actual.id::text=expected.id AND actual.body=expected.body WHERE actual.id IS NULL)' INTO v_bad USING p_job,p_source,p_target,v_key;
    IF v_bad THEN RAISE EXCEPTION 'Activity post-write content verification failed.';END IF;
    v_counts:=v_counts||jsonb_build_object(v_key,v_actual);
  END LOOP;
  RETURN v_counts;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_phase(
  p_job private.employee_transfer_jobs,p_owner jsonb,p_state jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_pair record;v_done record;v_n bigint;v_count bigint:=0;v_counts jsonb;v_empty boolean:=true;
BEGIN
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging AS s WHERE s.job_id=p_job.id AND s.table_key='mapped-activity-done-v1'
      AND (NOT ((p_owner->'identity_map') ? s.employee_id::text) OR s.chunk_no<>0 OR s.row_count<>1))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-activity-done-v1'
      GROUP BY employee_id HAVING count(*)<>1) THEN RAISE EXCEPTION 'Mapped activity completion set changed.';END IF;
  FOR v_pair IN SELECT key::uuid AS source,value::uuid AS target FROM jsonb_each_text(p_owner->'identity_map') ORDER BY key COLLATE "C" LOOP
    SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id=v_pair.source AND table_key='mapped-activity-done-v1';
    IF v_n=0 THEN
      v_empty:=private.employee_transfer_mapped_activity_empty(v_pair.target) AND v_empty;
    ELSE
      IF p_state IS NULL THEN RAISE EXCEPTION 'Mapped activity completion lacks a started plan.';END IF;
      SELECT * INTO STRICT v_done FROM private.employee_transfer_staging WHERE job_id=p_job.id
        AND employee_id=v_pair.source AND table_key='mapped-activity-done-v1';
      IF NOT private.employee_transfer_exact_object(v_done.payload,ARRAY['source_id','target_id','plan_hash','counts'])
        OR v_done.payload->'source_id' IS DISTINCT FROM to_jsonb(v_pair.source)
        OR v_done.payload->'target_id' IS DISTINCT FROM to_jsonb(v_pair.target)
        OR v_done.payload->'plan_hash' IS DISTINCT FROM p_state#>'{plan,plan_hash}' THEN
        RAISE EXCEPTION 'Mapped activity completion binding changed.';
      END IF;
      PERFORM private.employee_transfer_mapped_activity_check_counts(v_done.payload->'counts');
      v_counts:=private.employee_transfer_mapped_activity_check_written(p_job,v_pair.source,v_pair.target);
      IF v_done.payload->'counts' IS DISTINCT FROM v_counts THEN RAISE EXCEPTION 'Mapped activity completion counts changed.';END IF;
      v_count:=v_count+1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('completed_employees',v_count,'target_empty',v_empty);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_conflicts(p_job private.employee_transfer_jobs,p_owner jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_issues jsonb:='[]';v_key text;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions','work_stop_markers'] LOOP
    IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_activity_input(p_job.id,v_key) AS s
      WHERE NOT ((p_owner->'identity_map') ? (s.body->>'user_id'))) THEN
      v_issues:=v_issues||'"source_employee_missing"'::jsonb;EXIT;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_activity_input(p_job.id,'work_sessions')
    WHERE body->>'end_time' IS NULL AND round(extract(epoch FROM (
      GREATEST((body->>'start_time')::timestamptz,COALESCE((body->>'last_heartbeat_at')::timestamptz,(body->>'start_time')::timestamptz))
      -(body->>'start_time')::timestamptz))/60)>2147483647) THEN
    v_issues:=v_issues||'"work_duration_out_of_range"'::jsonb;
  END IF;
  IF p_owner->'target_empty' IS DISTINCT FROM 'true'::jsonb THEN v_issues:=v_issues||'"activity_target_not_empty"'::jsonb;END IF;
  FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions'] LOOP
    IF v_key='employee_login_history' THEN
      IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_activity_input(p_job.id,v_key) AS s
        JOIN public.employee_login_history AS t ON t.id=s.id::uuid
        WHERE NOT EXISTS(SELECT 1 FROM private.employee_transfer_staging AS d WHERE d.job_id=p_job.id
          AND d.employee_id=(s.body->>'user_id')::uuid AND d.table_key='mapped-activity-done-v1')
          OR t.user_id IS DISTINCT FROM (p_owner#>>ARRAY['identity_map',s.body->>'user_id'])::uuid) THEN
        v_issues:=v_issues||'"activity_uuid_collision"'::jsonb;
      END IF;
    ELSE
      IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_activity_input(p_job.id,v_key) AS s
        JOIN public.work_sessions AS t ON t.id=s.id::uuid
        WHERE NOT EXISTS(SELECT 1 FROM private.employee_transfer_staging AS d WHERE d.job_id=p_job.id
          AND d.employee_id=(s.body->>'user_id')::uuid AND d.table_key='mapped-activity-done-v1')
          OR t.user_id IS DISTINCT FROM (p_owner#>>ARRAY['identity_map',s.body->>'user_id'])::uuid) THEN
        v_issues:=v_issues||'"activity_uuid_collision"'::jsonb;
      END IF;
    END IF;
  END LOOP;
  RETURN (SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value COLLATE "C"),'[]')
    FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(v_issues)) AS issues);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_plan(p_job private.employee_transfer_jobs,p_owner jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_plan jsonb;v_site uuid;v_running bigint;v_conflicts jsonb;v_hash text;
BEGIN
  IF p_owner->'catalog' IS NULL OR p_owner->'catalog'='null'::jsonb THEN RAISE EXCEPTION 'Mapped activity catalog is required.';END IF;
  SELECT site_id INTO STRICT v_site FROM private.employee_transfer_site;
  SELECT count(*) INTO v_running FROM private.employee_transfer_mapped_activity_input(p_job.id,'work_sessions') WHERE body->>'end_time' IS NULL;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('finance_plan',p_owner->'finance_plan',
    'identity_map',p_owner->'identity_map','admin_map',p_owner->'admin_map')::text,'UTF8'),'sha256'),'hex');
  v_plan:=jsonb_build_object('scope','employee-mapped-activity','job_id',p_job.id,'site_id',v_site,
    'source_site_id',(p_job.summary#>>'{identity_catalog,site_id}')::uuid,'package_id',(p_job.options->>'package_id')::uuid,
    'catalog_hash',encode(extensions.digest(convert_to((p_owner->'catalog')::text,'UTF8'),'sha256'),'hex'),
    'mapping_hash',v_hash,'totals',p_owner->'totals','employees',(SELECT count(*) FROM jsonb_each(p_owner->'identity_map')),
    'running_work_sessions',v_running,'maintenance',true,
    'dependencies_pending',true,'financial_data_pending',true,'can_restore',false,'complete_employee_backup',false,
    'can_archive',false,'can_replace',false,'full_site_complete',false);
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,'catalog',p_owner->'catalog',
    'identity_catalog',p_job.summary->'identity_catalog','dispatch_catalog',p_job.options->'catalog',
    'configuration_plan',p_job.summary->'dispatch_config_plan','finance_plan',p_owner->'finance_plan',
    'identity_map',p_owner->'identity_map','admin_map',p_owner->'admin_map')::text,'UTF8'),'sha256'),'hex');
  v_conflicts:=private.employee_transfer_mapped_activity_conflicts(p_job,p_owner);
  RETURN v_plan||jsonb_build_object('plan_hash',v_hash,'can_begin',jsonb_array_length(v_conflicts)=0,'conflicts',v_conflicts);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_context(p_job private.employee_transfer_jobs,p_complete boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_owner jsonb;v_finance jsonb;v_catalog jsonb;v_totals jsonb:='{}';v_state jsonb;v_phase jsonb;v_plan jsonb;
BEGIN
  v_owner:=private.employee_transfer_mapped_finance_context(p_job,true);v_finance:=v_owner->'state';
  IF v_finance IS NULL OR v_finance->'verified' IS DISTINCT FROM 'true'::jsonb
    OR v_finance->'completed_employees' IS DISTINCT FROM v_finance#>'{plan,employees}' THEN
    RAISE EXCEPTION 'Complete verified mapped finance is required for activity.';
  END IF;
  IF p_job.summary ?| ARRAY['activity_catalog','activity_plan','activity_restore']
    OR EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key IN (
      'activity-in:employee_login_history','activity-in:work_sessions','activity-in:work_stop_markers','activity-done')) THEN
    RAISE EXCEPTION 'Legacy activity restore cannot be mixed with mapped activity.';
  END IF;
  PERFORM private.employee_transfer_activity_schema();PERFORM private.employee_transfer_assert_activity_triggers();
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key LIKE 'mapped-activity%'
    AND table_key NOT IN ('mapped-activity-catalog-v1','mapped-activity-v1','mapped-activity-done-v1',
      'mapped-activity-in:employee_login_history','mapped-activity-in:work_sessions','mapped-activity-in:work_stop_markers')) THEN
    RAISE EXCEPTION 'Mapped activity namespace changed.';
  END IF;
  v_state:=private.employee_transfer_mapped_activity_saved(p_job);v_catalog:=private.employee_transfer_mapped_activity_catalog(p_job);
  IF v_catalog IS NOT NULL THEN v_totals:=private.employee_transfer_mapped_activity_source(p_job,p_complete OR v_state IS NOT NULL);
  ELSIF p_complete OR v_state IS NOT NULL OR EXISTS(SELECT 1 FROM private.employee_transfer_staging
    WHERE job_id=p_job.id AND table_key LIKE 'mapped-activity-in:%') THEN RAISE EXCEPTION 'Bind a mapped activity catalog first.';END IF;
  v_phase:=private.employee_transfer_mapped_activity_phase(p_job,v_owner,v_state);
  v_owner:=v_owner||v_phase||jsonb_build_object('catalog',v_catalog,'totals',v_totals,'finance_plan',v_finance->'plan','state',v_state);
  IF v_state IS NOT NULL THEN
    v_plan:=private.employee_transfer_mapped_activity_plan(p_job,v_owner);
    IF v_state->'plan' IS DISTINCT FROM v_plan OR v_plan->'can_begin' IS DISTINCT FROM 'true'::jsonb
      OR v_state->'identity_map' IS DISTINCT FROM v_owner->'identity_map' OR v_state->'admin_map' IS DISTINCT FROM v_owner->'admin_map'
      OR v_state->'completed_employees' IS DISTINCT FROM v_phase->'completed_employees'
      OR (v_state->'verified'='true'::jsonb AND v_state->'completed_employees' IS DISTINCT FROM v_plan->'employees') THEN
      RAISE EXCEPTION 'Mapped activity saved plan, mappings or progress changed.';
    END IF;
  END IF;
  RETURN v_owner;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_activity_receipt(p_job private.employee_transfer_jobs,p_owner jsonb,p_source uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_plan jsonb;v_state jsonb:=NULLIF(p_owner->'state','null'::jsonb);v_counts jsonb:='{}';v_key text;v_employee jsonb:='null';v_applied boolean;
BEGIN
  IF v_state IS NULL THEN v_plan:=private.employee_transfer_mapped_activity_plan(p_job,p_owner);ELSE v_plan:=v_state->'plan';END IF;
  IF p_source IS NOT NULL THEN
    IF NOT ((p_owner->'identity_map') ? p_source::text) THEN RAISE EXCEPTION 'Mapped activity employee is not in this package.';END IF;
    SELECT EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id=p_source
      AND table_key='mapped-activity-done-v1') INTO v_applied;
    FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions','work_stop_markers'] LOOP
      v_counts:=v_counts||jsonb_build_object(v_key,CASE WHEN v_applied THEN (SELECT count(*)
        FROM private.employee_transfer_mapped_activity_input(p_job.id,v_key) WHERE body->>'user_id'=p_source::text) ELSE 0 END);
    END LOOP;
    v_employee:=jsonb_build_object('source_id',p_source,'target_id',p_owner#>ARRAY['identity_map',p_source::text],'applied',v_applied,'counts',v_counts);
  END IF;
  RETURN (v_plan-ARRAY['can_begin','conflicts'])||jsonb_build_object('started',v_state IS NOT NULL,
    'completed_employees',p_owner->'completed_employees','verified',COALESCE(v_state->'verified','false'::jsonb),'employee',v_employee);
END;
$$;

CREATE FUNCTION public.employee_import_mapped_activity_bind(p_admin_session_token uuid,p_job_token uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_catalog jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_activity_context(v_job,false);
  IF v_owner->'target_empty' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Mapped activity targets are not empty.';END IF;
  PERFORM private.employee_transfer_check_activity_catalog(p_catalog);
  IF p_catalog->'identity_catalog' IS DISTINCT FROM v_job.summary->'identity_catalog'
    OR p_catalog->'site_id' IS DISTINCT FROM v_job.options#>'{catalog,site_id}'
    OR p_catalog->'package_id' IS DISTINCT FROM v_job.options->'package_id' THEN RAISE EXCEPTION 'Mapped activity catalog binding differs.';END IF;
  v_catalog:=private.employee_transfer_mapped_activity_catalog(v_job);
  IF v_catalog IS NOT NULL THEN
    IF v_catalog IS DISTINCT FROM p_catalog THEN RAISE EXCEPTION 'Mapped activity catalog is immutable.';END IF;
  ELSE
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-activity-catalog-v1',0,1,p_catalog);
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-mapped-activity',
    'catalog_hash',encode(extensions.digest(convert_to(p_catalog::text,'UTF8'),'sha256'),'hex'),'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped activity catalog request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_activity_stage(
  p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_payload jsonb;v_previous record;v_n bigint;v_rows integer;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_activity_context(v_job,false);
  IF v_owner->'catalog'='null'::jsonb OR v_owner->'target_empty' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Mapped activity requires a catalog and clean targets.';
  END IF;
  IF p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 500000 THEN RAISE EXCEPTION 'Invalid mapped activity chunk number.';END IF;
  v_payload:=private.employee_transfer_mapped_activity_parse(p_table_key,p_ndjson);v_rows:=jsonb_array_length(v_payload->'rows');
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND table_key='mapped-activity-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_n>0 THEN
    SELECT * INTO STRICT v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id
      AND table_key='mapped-activity-in:'||p_table_key AND chunk_no=p_chunk_no;
    IF v_previous.payload IS DISTINCT FROM v_payload OR v_previous.row_count<>v_rows
      OR v_previous.employee_id<>'00000000-0000-0000-0000-000000000000' THEN
      RAISE EXCEPTION 'Mapped activity repeated chunk changed.';
    END IF;
  ELSE
    IF v_owner->'state'<>'null'::jsonb THEN RAISE EXCEPTION 'Mapped activity staging is frozen.';END IF;
    SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=v_job.id AND table_key='mapped-activity-in:'||p_table_key;
    IF v_n<>p_chunk_no THEN RAISE EXCEPTION 'Mapped activity chunks must be consecutive.';END IF;
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-activity-in:'||p_table_key,p_chunk_no,v_rows,v_payload);
    PERFORM private.employee_transfer_mapped_activity_source(v_job,false);
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-mapped-activity','table_key',p_table_key,'chunk_no',p_chunk_no,
    'rows',v_rows,'bytes',octet_length(p_ndjson),'sha256',encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex'),'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped activity staging request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_activity_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_activity_context(v_job,true);
  RETURN private.employee_transfer_mapped_activity_plan(v_job,v_owner);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped activity plan request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_activity_begin(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_plan jsonb;v_state jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_activity_context(v_job,true);v_plan:=private.employee_transfer_mapped_activity_plan(v_job,v_owner);
  IF p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$' OR p_plan_hash IS DISTINCT FROM v_plan->>'plan_hash'
    OR v_plan->'can_begin' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Mapped activity plan changed or has conflicts.';END IF;
  IF v_owner->'state'<>'null'::jsonb THEN RETURN private.employee_transfer_mapped_activity_receipt(v_job,v_owner,NULL);END IF;
  v_state:=jsonb_build_object('plan',v_plan,'identity_map',v_owner->'identity_map','admin_map',v_owner->'admin_map','completed_employees',0,'verified',false);
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-activity-v1',0,1,v_state);
  v_owner:=private.employee_transfer_mapped_activity_context(v_job,true);
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_activity_started',
    jsonb_build_object('plan_hash',p_plan_hash,'mapping_hash',v_plan->'mapping_hash','full_site_complete',false));
  RETURN private.employee_transfer_mapped_activity_receipt(v_job,v_owner,NULL);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped activity begin request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_activity_apply(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;v_target uuid;v_key text;
  v_row jsonb;v_columns text;v_projection text;v_relation regclass;v_disabled jsonb;v_counts jsonb;v_bypassed text[];
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_activity_context(v_job,true);v_state:=NULLIF(v_owner->'state','null'::jsonb);
  IF v_state IS NULL OR p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$'
    OR v_state#>>'{plan,plan_hash}' IS DISTINCT FROM p_plan_hash OR p_source_id IS NULL
    OR NOT ((v_owner->'identity_map') ? p_source_id::text) THEN RAISE EXCEPTION 'Mapped activity apply binding is invalid.';END IF;
  v_target:=(v_owner#>>ARRAY['identity_map',p_source_id::text])::uuid;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id=p_source_id
    AND table_key='mapped-activity-done-v1') THEN RETURN private.employee_transfer_mapped_activity_receipt(v_job,v_owner,p_source_id);END IF;
  IF NOT private.employee_transfer_mapped_activity_empty(v_target)
    OR private.employee_transfer_mapped_activity_conflicts(v_job,v_owner)<>'[]'::jsonb THEN RAISE EXCEPTION 'Mapped activity target or source changed.';END IF;
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names) VALUES(pg_current_xact_id(),v_job.id,
    ARRAY['public.employee_login_history','public.work_sessions','private.employee_work_stop_markers']);
  v_disabled:=private.employee_transfer_bypass_triggers(ARRAY['employee_login_history','work_sessions']);
  SELECT array_agg((value->>'table')||'.'||(value->>'trigger') ORDER BY ((value->>'table')||'.'||(value->>'trigger')) COLLATE "C")
    INTO v_bypassed FROM jsonb_array_elements(v_disabled);
  IF v_bypassed IS DISTINCT FROM ARRAY['employee_login_history.employee_login_history_emit_event',
    'employee_login_history.queue_notification_automation_from_employee_login','work_sessions.queue_notification_automation_from_work_session',
    'work_sessions.trigger_check_overlapping','work_sessions.trigger_cleanup_duplicate_sessions',
    'work_sessions.trigger_prevent_multiple_active_sessions','work_sessions.trigger_validate_work_session'] THEN
    RAISE EXCEPTION 'Unreviewed mapped activity trigger bypass.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions','work_stop_markers'] LOOP
    v_relation:=private.employee_transfer_activity_relation(v_key);
    SELECT string_agg(format('%I',key),',' ORDER BY key COLLATE "C"),string_agg(CASE WHEN v_key='employee_login_history' AND key='device_info' THEN
      'CASE WHEN ($1->>''device_info_is_sql_null'')::boolean THEN NULL::jsonb ELSE $1->''device_info'' END' ELSE format('r.%I',key) END,',' ORDER BY key COLLATE "C")
      INTO v_columns,v_projection FROM jsonb_each(private.employee_transfer_activity_spec()->v_key)
      WHERE key<>'device_info_is_sql_null' AND NOT(v_key='work_stop_markers' AND key='id');
    FOR v_row IN SELECT body FROM private.employee_transfer_mapped_activity_expected(v_job,p_source_id,v_target,v_key) ORDER BY id::uuid LOOP
      PERFORM private.employee_transfer_check_activity_row(v_key,v_row);
      EXECUTE format('INSERT INTO %s(%s) SELECT %s FROM jsonb_populate_record(NULL::%s,$1) AS r',v_relation,v_columns,v_projection,v_relation) USING v_row;
    END LOOP;
  END LOOP;
  PERFORM private.employee_transfer_restore_triggers(v_disabled);PERFORM private.employee_transfer_clear_write_permit();
  PERFORM private.employee_transfer_assert_activity_triggers();
  v_counts:=private.employee_transfer_mapped_activity_check_written(v_job,p_source_id,v_target);
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,p_source_id,'mapped-activity-done-v1',0,1,jsonb_build_object('source_id',p_source_id,'target_id',v_target,'plan_hash',p_plan_hash,'counts',v_counts));
  v_state:=jsonb_set(v_state,'{completed_employees}',to_jsonb((v_state->>'completed_employees')::bigint+1));
  UPDATE private.employee_transfer_staging SET payload=v_state WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='mapped-activity-v1' AND chunk_no=0;
  v_owner:=private.employee_transfer_mapped_activity_context(v_job,true);
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_activity_employee',
    jsonb_build_object('source_id',p_source_id,'target_id',v_target,'counts',v_counts,'plan_hash',p_plan_hash,'full_site_complete',false));
  RETURN private.employee_transfer_mapped_activity_receipt(v_job,v_owner,p_source_id);
EXCEPTION WHEN OTHERS THEN
  PERFORM private.employee_transfer_clear_write_permit();
  RAISE EXCEPTION 'Mapped activity employee request rejected; this request was not committed.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_activity_status(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_activity_context(v_job,true);
  RETURN private.employee_transfer_mapped_activity_receipt(v_job,v_owner,p_source_id);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped activity status request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_activity_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_activity_context(v_job,true);v_state:=NULLIF(v_owner->'state','null'::jsonb);
  IF v_state IS NULL OR v_state->'completed_employees' IS DISTINCT FROM v_state#>'{plan,employees}' THEN
    RAISE EXCEPTION 'Mapped activity employees are incomplete.';
  END IF;
  IF v_state->'verified' IS DISTINCT FROM 'true'::jsonb THEN
    v_state:=jsonb_set(v_state,'{verified}','true'::jsonb);
    UPDATE private.employee_transfer_staging SET payload=v_state WHERE job_id=v_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='mapped-activity-v1' AND chunk_no=0;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_activity_verified',
      jsonb_build_object('plan_hash',v_state#>'{plan,plan_hash}','employees',v_state->'completed_employees','full_site_complete',false));
  END IF;
  v_owner:=private.employee_transfer_mapped_activity_context(v_job,true);
  RETURN private.employee_transfer_mapped_activity_receipt(v_job,v_owner,NULL);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped activity verification request rejected.' USING ERRCODE='22023';
END;
$$;

DO $permissions$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace
    AND proname IN ('employee_transfer_mapped_activity_input','employee_transfer_mapped_activity_catalog','employee_transfer_mapped_activity_parse','employee_transfer_mapped_activity_source','employee_transfer_mapped_activity_check_counts','employee_transfer_mapped_activity_saved','employee_transfer_mapped_activity_empty','employee_transfer_mapped_activity_expected','employee_transfer_mapped_activity_check_written','employee_transfer_mapped_activity_phase','employee_transfer_mapped_activity_conflicts','employee_transfer_mapped_activity_plan','employee_transfer_mapped_activity_context','employee_transfer_mapped_activity_receipt') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
END;
$permissions$;
REVOKE ALL ON FUNCTION public.employee_import_mapped_activity_bind(uuid,uuid,jsonb),
  public.employee_import_mapped_activity_stage(uuid,uuid,text,integer,text),
  public.employee_import_mapped_activity_plan(uuid,uuid),
  public.employee_import_mapped_activity_begin(uuid,uuid,text),
  public.employee_import_mapped_activity_apply(uuid,uuid,uuid,text),
  public.employee_import_mapped_activity_status(uuid,uuid,uuid),
  public.employee_import_mapped_activity_verify(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_import_mapped_activity_bind(uuid,uuid,jsonb),
  public.employee_import_mapped_activity_stage(uuid,uuid,text,integer,text),
  public.employee_import_mapped_activity_plan(uuid,uuid),
  public.employee_import_mapped_activity_begin(uuid,uuid,text),
  public.employee_import_mapped_activity_apply(uuid,uuid,uuid,text),
  public.employee_import_mapped_activity_status(uuid,uuid,uuid),
  public.employee_import_mapped_activity_verify(uuid,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
