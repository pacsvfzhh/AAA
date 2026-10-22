BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_mapped_verification_input(p_job_id uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
BEGIN
  IF p_key IS DISTINCT FROM 'verification_requests' THEN RAISE EXCEPTION 'Invalid mapped verification table.';END IF;
  RETURN QUERY SELECT r.value->>'id',r.value FROM private.employee_transfer_staging AS s
    CROSS JOIN LATERAL jsonb_array_elements(s.payload->'rows') AS r(value)
    WHERE s.job_id=p_job_id AND s.employee_id='00000000-0000-0000-0000-000000000000'
      AND s.table_key='mapped-verification-in:'||p_key;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_catalog(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_n bigint;v_stage record;
BEGIN
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-verification-catalog-v1';
  IF v_n=0 THEN RETURN NULL;END IF;
  IF v_n<>1 THEN RAISE EXCEPTION 'Mapped verification catalog state changed.';END IF;
  SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-verification-catalog-v1';
  IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>0 OR v_stage.row_count<>1 THEN
    RAISE EXCEPTION 'Mapped verification catalog namespace changed.';
  END IF;
  PERFORM private.employee_transfer_check_verification_catalog(v_stage.payload);
  IF v_stage.payload->'identity_catalog' IS DISTINCT FROM p_job.summary->'identity_catalog'
    OR v_stage.payload->'site_id' IS DISTINCT FROM p_job.options#>'{catalog,site_id}'
    OR v_stage.payload->'package_id' IS DISTINCT FROM p_job.options->'package_id' THEN
    RAISE EXCEPTION 'Mapped verification source binding changed.';
  END IF;
  RETURN v_stage.payload;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_parse(p_key text,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_line text;v_json json;v_rows jsonb:='[]';v_hashes text:='';v_last text;v_bad boolean;v_type text;
BEGIN
  IF p_key IS DISTINCT FROM 'verification_requests' THEN RAISE EXCEPTION 'Invalid mapped verification table.';END IF;v_type:='uuid';
  IF p_ndjson IS NULL OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN
    RAISE EXCEPTION 'Invalid mapped verification chunk.';
  END IF;
  IF p_ndjson<>'' THEN
    FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS r(line) LOOP
      IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Mapped verification row exceeds limits.';END IF;
      v_json:=v_line::json;
      IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN
        RAISE EXCEPTION 'Invalid mapped verification JSON.';
      END IF;
      PERFORM private.employee_transfer_check_verification_row(p_key,v_json::jsonb);
      EXECUTE 'SELECT $1::'||v_type||'>=$2::'||v_type INTO v_bad USING v_last,v_json->>'id';
      IF COALESCE(v_bad,false) THEN RAISE EXCEPTION 'Mapped verification row order changed.';END IF;
      v_last:=v_json->>'id';v_rows:=v_rows||jsonb_build_array(v_json::jsonb);
      IF jsonb_array_length(v_rows)>200 THEN RAISE EXCEPTION 'Mapped verification chunk exceeds limits.';END IF;
      v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_last);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_source(p_job private.employee_transfer_jobs,p_complete boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_catalog jsonb;v_table jsonb;v_key text;v_stage record;v_payload jsonb;v_chunks integer;v_rows bigint;v_bytes bigint;
  v_hashes text;v_last text;v_first text;v_bad boolean;v_type text;v_total bigint:=0;v_counts jsonb:='{}';
BEGIN
  v_catalog:=private.employee_transfer_mapped_verification_catalog(p_job);
  IF v_catalog IS NULL THEN RAISE EXCEPTION 'Bind a mapped verification catalog first.';END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(v_catalog->'tables') LOOP
    v_key:=v_table->>'key';v_type:='uuid';
    v_chunks:=0;v_rows:=0;v_bytes:=0;v_hashes:='';v_last:=NULL;
    FOR v_stage IN SELECT * FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND table_key='mapped-verification-in:'||v_key ORDER BY chunk_no LOOP
      IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>v_chunks
        OR v_stage.row_count NOT BETWEEN 0 AND 200 OR NOT private.employee_transfer_exact_object(v_stage.payload,
          ARRAY['ndjson','rows','bytes','row_hashes','last_id']) OR jsonb_typeof(v_stage.payload->'ndjson') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_stage.payload->'bytes') IS DISTINCT FROM 'number'
        OR (v_stage.payload->>'bytes') !~ '^(0|[1-9][0-9]{0,5})$' THEN
        RAISE EXCEPTION 'Mapped verification source namespace changed.';
      END IF;
      v_payload:=private.employee_transfer_mapped_verification_parse(v_key,v_stage.payload->>'ndjson');
      IF v_payload IS DISTINCT FROM v_stage.payload OR jsonb_array_length(v_payload->'rows')<>v_stage.row_count
        OR (v_stage.row_count=0 AND (v_chunks<>0 OR v_table->'rows' IS DISTINCT FROM '0'::jsonb)) THEN
        RAISE EXCEPTION 'Mapped verification source raw rows or hashes changed.';
      END IF;
      v_first:=v_payload#>>'{rows,0,id}';
      EXECUTE 'SELECT $1::'||v_type||'>=$2::'||v_type INTO v_bad USING v_last,v_first;
      IF COALESCE(v_bad,false) THEN RAISE EXCEPTION 'Mapped verification source chunk order changed.';END IF;
      v_last:=v_payload->>'last_id';v_chunks:=v_chunks+1;v_rows:=v_rows+v_stage.row_count;
      v_bytes:=v_bytes+(v_payload->>'bytes')::bigint;v_hashes:=v_hashes||(v_payload->>'row_hashes');
    END LOOP;
    v_total:=v_total+v_bytes;
    IF v_rows>(v_table->>'rows')::bigint OR v_bytes>(v_table->>'bytes')::bigint OR v_rows>500000 OR v_bytes>268435456
      OR v_total>1073741824 OR (v_rows=0 AND v_chunks>1) THEN RAISE EXCEPTION 'Mapped verification source exceeds catalog.';END IF;
    IF p_complete AND (v_chunks=0 OR v_rows<>(v_table->>'rows')::bigint OR v_bytes<>(v_table->>'bytes')::bigint
      OR encode(extensions.digest(convert_to(v_hashes,'UTF8'),'sha256'),'hex') IS DISTINCT FROM v_table->>'row_hashes_sha256') THEN
      RAISE EXCEPTION 'Mapped verification source directory is incomplete or changed.';
    END IF;
    v_counts:=v_counts||jsonb_build_object(v_key,v_rows);
  END LOOP;
  RETURN v_counts;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_check_counts(p_counts jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_value jsonb;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_counts,ARRAY['verification_requests']) THEN RAISE EXCEPTION 'Mapped verification count keys changed.';END IF;
  FOR v_value IN SELECT value FROM jsonb_each(p_counts) LOOP
    IF jsonb_typeof(v_value) IS DISTINCT FROM 'number' OR (v_value#>>'{}') !~ '^(0|[1-9][0-9]{0,5})$'
      OR (v_value#>>'{}')::bigint>500000 THEN RAISE EXCEPTION 'Mapped verification count type changed.';END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_saved(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_n bigint;v_stage record;
BEGIN
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-verification-v1';
  IF v_n=0 THEN RETURN NULL;END IF;
  IF v_n<>1 THEN RAISE EXCEPTION 'Mapped verification state set changed.';END IF;
  SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-verification-v1';
  IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>0 OR v_stage.row_count<>1
    OR NOT private.employee_transfer_exact_object(v_stage.payload,ARRAY['plan','identity_map','admin_map','completed_employees','verified'])
    OR jsonb_typeof(v_stage.payload->'completed_employees') IS DISTINCT FROM 'number'
    OR (v_stage.payload->>'completed_employees') !~ '^(0|[1-9][0-9]{0,5})$'
    OR jsonb_typeof(v_stage.payload->'verified') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Mapped verification saved state changed.';
  END IF;
  IF NOT private.employee_transfer_exact_object(v_stage.payload->'plan',ARRAY['scope','job_id','site_id','source_site_id','package_id',
    'catalog_hash','mapping_hash','plan_hash','totals','employees','maintenance','dependencies_pending',
    'financial_data_pending','can_restore','complete_employee_backup','can_archive','can_replace','full_site_complete','can_begin','conflicts'])
    OR jsonb_typeof(v_stage.payload#>'{plan,employees}') IS DISTINCT FROM 'number'
    OR (v_stage.payload#>>'{plan,employees}') !~ '^(0|[1-9][0-9]{0,5})$'
 THEN
    RAISE EXCEPTION 'Mapped verification plan fields changed.';
  END IF;
  PERFORM private.employee_transfer_mapped_verification_check_counts(v_stage.payload#>'{plan,totals}');
  RETURN v_stage.payload;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_empty(p_target uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
BEGIN
  RETURN NOT EXISTS(SELECT 1 FROM public.verification_requests WHERE user_id=p_target);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_expected(p_job private.employee_transfer_jobs,p_source uuid,p_target uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_row record;v_body jsonb;v_field text;v_url text;v_ref jsonb;v_receipt jsonb;
BEGIN
  IF p_key IS DISTINCT FROM 'verification_requests' THEN RAISE EXCEPTION 'Invalid mapped verification table.';END IF;
  FOR v_row IN SELECT h.id,h.body FROM private.employee_transfer_mapped_verification_input(p_job.id,p_key) h WHERE h.body->>'user_id'=p_source::text LOOP
    v_body:=v_row.body||jsonb_build_object('user_id',p_target,'audited_by',private.employee_transfer_mapped_activity_saved(p_job)#>>ARRAY['admin_map',v_row.body->>'audited_by']);
    FOREACH v_field IN ARRAY ARRAY['id_front_url','id_back_url','selfie_url'] LOOP
      v_url:=v_row.body->>v_field;IF v_url IS NULL THEN CONTINUE;END IF;
      SELECT value INTO STRICT v_ref FROM jsonb_array_elements(private.employee_transfer_mapped_verification_media_refs(p_job)) WHERE value->>'source_url'=v_url;
      SELECT payload INTO STRICT v_receipt FROM private.employee_transfer_staging WHERE job_id=p_job.id
        AND table_key='mapped-verification-media-import' AND payload#>>'{file,key}'=v_ref->>'key';
      v_body:=v_body||jsonb_build_object(v_field,(v_receipt->>'storage_origin')||'/storage/v1/object/public/verification-documents/'||private.employee_transfer_mapped_verification_media_path(p_job,v_ref,p_target));
    END LOOP;
    id:=v_row.id;body:=v_body;RETURN NEXT;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_check_written(p_job private.employee_transfer_jobs,p_source uuid,p_target uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_expected bigint;v_actual bigint;
BEGIN
  SELECT count(*) INTO v_expected FROM private.employee_transfer_mapped_verification_input(p_job.id,'verification_requests') WHERE body->>'user_id'=p_source::text;
  SELECT count(*) INTO v_actual FROM public.verification_requests WHERE user_id=p_target;
  IF v_actual IS DISTINCT FROM v_expected OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_verification_expected(p_job,p_source,p_target,'verification_requests') e
    LEFT JOIN public.verification_requests t ON t.id=e.id::uuid AND to_jsonb(t)=e.body WHERE t.id IS NULL) THEN
    RAISE EXCEPTION 'Mapped verification committed content changed.';
  END IF;
  RETURN jsonb_build_object('verification_requests',v_actual);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_phase(
  p_job private.employee_transfer_jobs,p_owner jsonb,p_state jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_pair record;v_done record;v_n bigint;v_count bigint:=0;v_counts jsonb;v_empty boolean:=true;
BEGIN
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging AS s WHERE s.job_id=p_job.id AND s.table_key='mapped-verification-done-v1'
      AND (NOT ((p_owner->'identity_map') ? s.employee_id::text) OR s.chunk_no<>0 OR s.row_count<>1))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-verification-done-v1'
      GROUP BY employee_id HAVING count(*)<>1) THEN RAISE EXCEPTION 'Mapped verification completion set changed.';END IF;
  FOR v_pair IN SELECT key::uuid AS source,value::uuid AS target FROM jsonb_each_text(p_owner->'identity_map') ORDER BY key COLLATE "C" LOOP
    SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id=v_pair.source AND table_key='mapped-verification-done-v1';
    IF v_n=0 THEN
      v_empty:=private.employee_transfer_mapped_verification_empty(v_pair.target) AND v_empty;
    ELSE
      IF p_state IS NULL THEN RAISE EXCEPTION 'Mapped verification completion lacks a started plan.';END IF;
      SELECT * INTO STRICT v_done FROM private.employee_transfer_staging WHERE job_id=p_job.id
        AND employee_id=v_pair.source AND table_key='mapped-verification-done-v1';
      IF NOT private.employee_transfer_exact_object(v_done.payload,ARRAY['source_id','target_id','plan_hash','counts'])
        OR v_done.payload->'source_id' IS DISTINCT FROM to_jsonb(v_pair.source)
        OR v_done.payload->'target_id' IS DISTINCT FROM to_jsonb(v_pair.target)
        OR v_done.payload->'plan_hash' IS DISTINCT FROM p_state#>'{plan,plan_hash}' THEN
        RAISE EXCEPTION 'Mapped verification completion binding changed.';
      END IF;
      PERFORM private.employee_transfer_mapped_verification_check_counts(v_done.payload->'counts');
      v_counts:=private.employee_transfer_mapped_verification_check_written(p_job,v_pair.source,v_pair.target);
      IF v_done.payload->'counts' IS DISTINCT FROM v_counts THEN RAISE EXCEPTION 'Mapped verification completion counts changed.';END IF;
      v_count:=v_count+1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('completed_employees',v_count,'target_empty',v_empty);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_conflicts(p_job private.employee_transfer_jobs,p_owner jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_issues jsonb:='[]';
BEGIN
  IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_verification_input(p_job.id,'verification_requests') s
    WHERE NOT ((p_owner->'identity_map') ? (s.body->>'user_id'))) THEN v_issues:=v_issues||'"source_employee_missing"'::jsonb;END IF;
  IF p_owner->'target_empty' IS DISTINCT FROM 'true'::jsonb THEN v_issues:=v_issues||'"verification_target_not_empty"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_verification_input(p_job.id,'verification_requests') s JOIN public.verification_requests t ON t.id=s.id::uuid
    WHERE NOT EXISTS(SELECT 1 FROM private.employee_transfer_staging d WHERE d.job_id=p_job.id AND d.employee_id=(s.body->>'user_id')::uuid AND d.table_key='mapped-verification-done-v1')
      OR t.user_id IS DISTINCT FROM (p_owner#>>ARRAY['identity_map',s.body->>'user_id'])::uuid) THEN v_issues:=v_issues||'"verification_uuid_collision"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_verification_input(p_job.id,'verification_requests') s
    WHERE s.body->>'audited_by' IS NOT NULL AND NOT ((p_owner->'admin_map') ? (s.body->>'audited_by'))) THEN v_issues:=v_issues||'"verification_admin_unmapped"'::jsonb;END IF;
  IF NOT private.employee_transfer_mapped_verification_media_ready(p_job,false) THEN v_issues:=v_issues||'"media_incomplete"'::jsonb;END IF;
  RETURN (SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value COLLATE "C"),'[]') FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(v_issues)) issues);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_plan(p_job private.employee_transfer_jobs,p_owner jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_plan jsonb;v_site uuid;v_conflicts jsonb;v_hash text;
BEGIN
  IF p_owner->'catalog' IS NULL OR p_owner->'catalog'='null'::jsonb THEN RAISE EXCEPTION 'Mapped verification catalog is required.';END IF;
  SELECT site_id INTO STRICT v_site FROM private.employee_transfer_site;
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('activity_plan',p_owner->'activity_plan',
    'identity_map',p_owner->'identity_map','admin_map',p_owner->'admin_map')::text,'UTF8'),'sha256'),'hex');
  v_plan:=jsonb_build_object('scope','employee-mapped-verification','job_id',p_job.id,'site_id',v_site,
    'source_site_id',(p_job.summary#>>'{identity_catalog,site_id}')::uuid,'package_id',(p_job.options->>'package_id')::uuid,
    'catalog_hash',encode(extensions.digest(convert_to((p_owner->'catalog')::text,'UTF8'),'sha256'),'hex'),
    'mapping_hash',v_hash,'totals',p_owner->'totals','employees',(SELECT count(*) FROM jsonb_each(p_owner->'identity_map')),
    'maintenance',true,
    'dependencies_pending',true,'financial_data_pending',true,'can_restore',false,'complete_employee_backup',false,
    'can_archive',false,'can_replace',false,'full_site_complete',false);
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,'catalog',p_owner->'catalog',
    'identity_catalog',p_job.summary->'identity_catalog','dispatch_catalog',p_job.options->'catalog',
    'configuration_plan',p_job.summary->'dispatch_config_plan','activity_plan',p_owner->'activity_plan',
    'media_files',private.employee_transfer_mapped_verification_media_files(p_job),
    'identity_map',p_owner->'identity_map','admin_map',p_owner->'admin_map')::text,'UTF8'),'sha256'),'hex');
  v_conflicts:=private.employee_transfer_mapped_verification_conflicts(p_job,p_owner);
  RETURN v_plan||jsonb_build_object('plan_hash',v_hash,'can_begin',jsonb_array_length(v_conflicts)=0,'conflicts',v_conflicts);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_context(p_job private.employee_transfer_jobs,p_complete boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_owner jsonb;v_activity jsonb;v_catalog jsonb;v_totals jsonb:='{}';v_state jsonb;v_phase jsonb;v_plan jsonb;
BEGIN
  v_owner:=private.employee_transfer_mapped_activity_context(p_job,true);v_activity:=v_owner->'state';
  IF v_activity IS NULL OR v_activity->'verified' IS DISTINCT FROM 'true'::jsonb
    OR v_activity->'completed_employees' IS DISTINCT FROM v_activity#>'{plan,employees}' THEN
    RAISE EXCEPTION 'Complete verified mapped activity is required for verification.';
  END IF;
  IF p_job.summary ?| ARRAY['verification_catalog','verification_plan','verification_restore','verification_media_files','verification_storage_origin']
    OR EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key IN (
      'verification-in:verification_requests','verification-done','verification-media-import')) THEN
    RAISE EXCEPTION 'Legacy verification restore cannot be mixed with mapped verification.';
  END IF;
  PERFORM private.employee_transfer_verification_schema();
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key LIKE 'mapped-verification%'
    AND table_key NOT IN ('mapped-verification-catalog-v1','mapped-verification-v1','mapped-verification-done-v1',
      'mapped-verification-in:verification_requests','mapped-verification-media-files-v1','mapped-verification-media-import')) THEN
    RAISE EXCEPTION 'Mapped verification namespace changed.';
  END IF;
  v_state:=private.employee_transfer_mapped_verification_saved(p_job);v_catalog:=private.employee_transfer_mapped_verification_catalog(p_job);
  IF v_catalog IS NOT NULL THEN v_totals:=private.employee_transfer_mapped_verification_source(p_job,p_complete OR v_state IS NOT NULL);
  ELSIF p_complete OR v_state IS NOT NULL OR EXISTS(SELECT 1 FROM private.employee_transfer_staging
    WHERE job_id=p_job.id AND table_key LIKE 'mapped-verification-in:%') THEN RAISE EXCEPTION 'Bind a mapped verification catalog first.';END IF;
  IF v_catalog IS NOT NULL THEN PERFORM private.employee_transfer_mapped_verification_media_refs(p_job);END IF;
  PERFORM private.employee_transfer_mapped_verification_media_files(p_job);
  v_phase:=private.employee_transfer_mapped_verification_phase(p_job,v_owner,v_state);
  v_owner:=v_owner||v_phase||jsonb_build_object('catalog',v_catalog,'totals',v_totals,'activity_plan',v_activity->'plan','state',v_state);
  IF v_state IS NOT NULL THEN
    v_plan:=private.employee_transfer_mapped_verification_plan(p_job,v_owner);
    IF v_state->'plan' IS DISTINCT FROM v_plan OR v_plan->'can_begin' IS DISTINCT FROM 'true'::jsonb
      OR v_state->'identity_map' IS DISTINCT FROM v_owner->'identity_map' OR v_state->'admin_map' IS DISTINCT FROM v_owner->'admin_map'
      OR v_state->'completed_employees' IS DISTINCT FROM v_phase->'completed_employees'
      OR (v_state->'verified'='true'::jsonb AND v_state->'completed_employees' IS DISTINCT FROM v_plan->'employees') THEN
      RAISE EXCEPTION 'Mapped verification saved plan, mappings or progress changed.';
    END IF;
  END IF;
  RETURN v_owner;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_receipt(p_job private.employee_transfer_jobs,p_owner jsonb,p_source uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_plan jsonb;v_state jsonb:=NULLIF(p_owner->'state','null'::jsonb);v_counts jsonb:='{}';v_key text;v_employee jsonb:='null';v_applied boolean;
BEGIN
  IF v_state IS NULL THEN v_plan:=private.employee_transfer_mapped_verification_plan(p_job,p_owner);ELSE v_plan:=v_state->'plan';END IF;
  IF p_source IS NOT NULL THEN
    IF NOT ((p_owner->'identity_map') ? p_source::text) THEN RAISE EXCEPTION 'Mapped verification employee is not in this package.';END IF;
    SELECT EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id=p_source
      AND table_key='mapped-verification-done-v1') INTO v_applied;
    FOREACH v_key IN ARRAY ARRAY['verification_requests'] LOOP
      v_counts:=v_counts||jsonb_build_object(v_key,CASE WHEN v_applied THEN (SELECT count(*)
        FROM private.employee_transfer_mapped_verification_input(p_job.id,v_key) WHERE body->>'user_id'=p_source::text) ELSE 0 END);
    END LOOP;
    v_employee:=jsonb_build_object('source_id',p_source,'target_id',p_owner#>ARRAY['identity_map',p_source::text],'applied',v_applied,'counts',v_counts);
  END IF;
  RETURN (v_plan-ARRAY['can_begin','conflicts'])||jsonb_build_object('started',v_state IS NOT NULL,
    'completed_employees',p_owner->'completed_employees','verified',COALESCE(v_state->'verified','false'::jsonb),'employee',v_employee);
END;
$$;

CREATE FUNCTION public.employee_import_mapped_verification_bind(p_admin_session_token uuid,p_job_token uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_catalog jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,false);
  IF v_owner->'target_empty' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Mapped verification targets are not empty.';END IF;
  PERFORM private.employee_transfer_check_verification_catalog(p_catalog);
  IF p_catalog->'identity_catalog' IS DISTINCT FROM v_job.summary->'identity_catalog'
    OR p_catalog->'site_id' IS DISTINCT FROM v_job.options#>'{catalog,site_id}'
    OR p_catalog->'package_id' IS DISTINCT FROM v_job.options->'package_id' THEN RAISE EXCEPTION 'Mapped verification catalog binding differs.';END IF;
  v_catalog:=private.employee_transfer_mapped_verification_catalog(v_job);
  IF v_catalog IS NOT NULL THEN
    IF v_catalog IS DISTINCT FROM p_catalog THEN RAISE EXCEPTION 'Mapped verification catalog is immutable.';END IF;
  ELSE
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-verification-catalog-v1',0,1,p_catalog);
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-mapped-verification',
    'catalog_hash',encode(extensions.digest(convert_to(p_catalog::text,'UTF8'),'sha256'),'hex'),'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped verification catalog request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_verification_stage(
  p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_payload jsonb;v_previous record;v_n bigint;v_rows integer;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,false);
  IF v_owner->'catalog'='null'::jsonb OR v_owner->'target_empty' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Mapped verification requires a catalog and clean targets.';
  END IF;
  IF p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 500000 THEN RAISE EXCEPTION 'Invalid mapped verification chunk number.';END IF;
  v_payload:=private.employee_transfer_mapped_verification_parse(p_table_key,p_ndjson);v_rows:=jsonb_array_length(v_payload->'rows');
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND table_key='mapped-verification-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_n>0 THEN
    SELECT * INTO STRICT v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id
      AND table_key='mapped-verification-in:'||p_table_key AND chunk_no=p_chunk_no;
    IF v_previous.payload IS DISTINCT FROM v_payload OR v_previous.row_count<>v_rows
      OR v_previous.employee_id<>'00000000-0000-0000-0000-000000000000' THEN
      RAISE EXCEPTION 'Mapped verification repeated chunk changed.';
    END IF;
  ELSE
    IF v_owner->'state'<>'null'::jsonb THEN RAISE EXCEPTION 'Mapped verification staging is frozen.';END IF;
    SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=v_job.id AND table_key='mapped-verification-in:'||p_table_key;
    IF v_n<>p_chunk_no THEN RAISE EXCEPTION 'Mapped verification chunks must be consecutive.';END IF;
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-verification-in:'||p_table_key,p_chunk_no,v_rows,v_payload);
    PERFORM private.employee_transfer_mapped_verification_source(v_job,false);
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-mapped-verification','table_key',p_table_key,'chunk_no',p_chunk_no,
    'rows',v_rows,'bytes',octet_length(p_ndjson),'sha256',encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex'),'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped verification staging request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_verification_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,true);
  RETURN private.employee_transfer_mapped_verification_plan(v_job,v_owner);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped verification plan request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_verification_begin(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_plan jsonb;v_state jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,true);v_plan:=private.employee_transfer_mapped_verification_plan(v_job,v_owner);
  IF p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$' OR p_plan_hash IS DISTINCT FROM v_plan->>'plan_hash'
    OR v_plan->'can_begin' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Mapped verification plan changed or has conflicts.';END IF;
  IF v_owner->'state'<>'null'::jsonb THEN RETURN private.employee_transfer_mapped_verification_receipt(v_job,v_owner,NULL);END IF;
  v_state:=jsonb_build_object('plan',v_plan,'identity_map',v_owner->'identity_map','admin_map',v_owner->'admin_map','completed_employees',0,'verified',false);
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-verification-v1',0,1,v_state);
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,true);
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_verification_started',
    jsonb_build_object('plan_hash',p_plan_hash,'mapping_hash',v_plan->'mapping_hash','full_site_complete',false));
  RETURN private.employee_transfer_mapped_verification_receipt(v_job,v_owner,NULL);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped verification begin request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_verification_apply(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;v_target uuid;
  v_row jsonb;v_counts jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,true);v_state:=NULLIF(v_owner->'state','null'::jsonb);
  IF v_state IS NULL OR p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$'
    OR v_state#>>'{plan,plan_hash}' IS DISTINCT FROM p_plan_hash OR p_source_id IS NULL
    OR NOT ((v_owner->'identity_map') ? p_source_id::text) THEN RAISE EXCEPTION 'Mapped verification apply binding is invalid.';END IF;
  v_target:=(v_owner#>>ARRAY['identity_map',p_source_id::text])::uuid;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id=p_source_id
    AND table_key='mapped-verification-done-v1') THEN RETURN private.employee_transfer_mapped_verification_receipt(v_job,v_owner,p_source_id);END IF;
  IF NOT private.employee_transfer_mapped_verification_empty(v_target)
    OR private.employee_transfer_mapped_verification_conflicts(v_job,v_owner)<>'[]'::jsonb THEN RAISE EXCEPTION 'Mapped verification target or source changed.';END IF;
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names) VALUES(pg_current_xact_id(),v_job.id,ARRAY['public.verification_requests']);
  FOR v_row IN SELECT body FROM private.employee_transfer_mapped_verification_expected(v_job,p_source_id,v_target,'verification_requests') ORDER BY id::uuid LOOP
    PERFORM private.employee_transfer_check_verification_row('verification_requests',v_row);
    INSERT INTO public.verification_requests(id,user_id,real_name,wallet_address,phone,email,status,audit_remark,audited_by,audited_at,created_at,updated_at,id_front_url,id_back_url,selfie_url)
      SELECT r.id,r.user_id,r.real_name,r.wallet_address,r.phone,r.email,r.status,r.audit_remark,r.audited_by,r.audited_at,r.created_at,r.updated_at,r.id_front_url,r.id_back_url,r.selfie_url
      FROM jsonb_populate_record(NULL::public.verification_requests,v_row) r;
  END LOOP;
  PERFORM private.employee_transfer_clear_write_permit();
  PERFORM private.employee_transfer_verification_schema();
  v_counts:=private.employee_transfer_mapped_verification_check_written(v_job,p_source_id,v_target);
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,p_source_id,'mapped-verification-done-v1',0,1,jsonb_build_object('source_id',p_source_id,'target_id',v_target,'plan_hash',p_plan_hash,'counts',v_counts));
  v_state:=jsonb_set(v_state,'{completed_employees}',to_jsonb((v_state->>'completed_employees')::bigint+1));
  UPDATE private.employee_transfer_staging SET payload=v_state WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='mapped-verification-v1' AND chunk_no=0;
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,true);
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_verification_employee',
    jsonb_build_object('source_id',p_source_id,'target_id',v_target,'counts',v_counts,'plan_hash',p_plan_hash,'full_site_complete',false));
  RETURN private.employee_transfer_mapped_verification_receipt(v_job,v_owner,p_source_id);
EXCEPTION WHEN OTHERS THEN
  PERFORM private.employee_transfer_clear_write_permit();
  RAISE EXCEPTION 'Mapped verification employee request rejected; this request was not committed.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_verification_status(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,true);
  RETURN private.employee_transfer_mapped_verification_receipt(v_job,v_owner,p_source_id);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped verification status request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_verification_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,true);v_state:=NULLIF(v_owner->'state','null'::jsonb);
  IF v_state IS NULL OR v_state->'completed_employees' IS DISTINCT FROM v_state#>'{plan,employees}' THEN
    RAISE EXCEPTION 'Mapped verification employees are incomplete.';
  END IF;
  IF NOT private.employee_transfer_mapped_verification_media_ready(v_job,true) THEN RAISE EXCEPTION 'Final mapped verification media recheck is required.';END IF;
  IF v_state->'verified' IS DISTINCT FROM 'true'::jsonb THEN
    v_state:=jsonb_set(v_state,'{verified}','true'::jsonb);
    UPDATE private.employee_transfer_staging SET payload=v_state WHERE job_id=v_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='mapped-verification-v1' AND chunk_no=0;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_verification_verified',
      jsonb_build_object('plan_hash',v_state#>'{plan,plan_hash}','employees',v_state->'completed_employees','full_site_complete',false));
  END IF;
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,true);
  RETURN private.employee_transfer_mapped_verification_receipt(v_job,v_owner,NULL);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped verification verification request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_media_refs(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_row record;v_field text;v_url text;v_path text;v_key text;v_refs jsonb:='{}';
BEGIN
  FOR v_row IN SELECT body FROM private.employee_transfer_mapped_verification_input(p_job.id,'verification_requests') LOOP
    FOREACH v_field IN ARRAY ARRAY['id_front_url','id_back_url','selfie_url'] LOOP
      v_url:=v_row.body->>v_field;IF v_url IS NULL THEN CONTINUE;END IF;
      IF length(v_url)>512 OR v_url !~ '^https://[a-z0-9-]+[.]supabase[.]co/storage/v1/object/public/verification-documents/(id-front|id-back|selfie)/[0-9a-f-]{36}-[A-Za-z0-9._-]+[.][A-Za-z0-9]{1,8}$' THEN
        RAISE EXCEPTION 'Unmanaged mapped verification document; no file was omitted.';
      END IF;
      v_path:=split_part(v_url,'/verification-documents/',2);
      IF split_part(v_path,'/',2) NOT LIKE (v_row.body->>'user_id')||'-%' OR length(split_part(v_path,'/',2))>128 OR v_path ~ '[.][.]' THEN
        RAISE EXCEPTION 'Mapped verification document owner changed.';
      END IF;
      v_key:=encode(extensions.digest(convert_to(v_url,'UTF8'),'sha256'),'hex');
      v_refs:=v_refs||jsonb_build_object(v_key,jsonb_build_object('key',v_key,'source_url',v_url,'bucket','verification-documents','path',v_path));
      IF (SELECT count(*) FROM jsonb_object_keys(v_refs))>3000 THEN RAISE EXCEPTION 'Mapped verification media exceeds limits.';END IF;
    END LOOP;
  END LOOP;
  RETURN COALESCE((SELECT jsonb_agg(value ORDER BY key COLLATE "C") FROM jsonb_each(v_refs)),'[]'::jsonb);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_check_files(p_job private.employee_transfer_jobs,p_files jsonb)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_refs jsonb;v_ref jsonb;v_file jsonb;v_n integer:=0;v_total bigint:=0;
BEGIN
  v_refs:=private.employee_transfer_mapped_verification_media_refs(p_job);
  IF jsonb_typeof(p_files) IS DISTINCT FROM 'array' OR jsonb_array_length(p_files)<>jsonb_array_length(v_refs)
    OR octet_length(p_files::text)>2097152 THEN RAISE EXCEPTION 'Invalid mapped verification media catalog.';END IF;
  FOR v_ref IN SELECT value FROM jsonb_array_elements(v_refs) LOOP
    v_file:=p_files->v_n;v_n:=v_n+1;
    IF NOT private.employee_transfer_exact_object(v_file,ARRAY['key','source_url','bytes','sha256','content_type'])
      OR v_file->'key' IS DISTINCT FROM v_ref->'key' OR v_file->'source_url' IS DISTINCT FROM v_ref->'source_url'
      OR jsonb_typeof(v_file->'bytes') IS DISTINCT FROM 'number' OR (v_file->>'bytes') !~ '^[1-9][0-9]{0,7}$'
      OR (v_file->>'bytes')::bigint>52428800 OR jsonb_typeof(v_file->'sha256') IS DISTINCT FROM 'string' OR (v_file->>'sha256') !~ '^[0-9a-f]{64}$'
      OR v_file->>'content_type' IS NULL OR v_file->>'content_type' NOT IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf') THEN
      RAISE EXCEPTION 'Invalid mapped verification media tuple.';
    END IF;
    v_total:=v_total+(v_file->>'bytes')::bigint;
  END LOOP;
  IF v_total+COALESCE((private.employee_transfer_mapped_verification_catalog(p_job)#>>'{tables,0,bytes}')::bigint,0)>1073741824 THEN
    RAISE EXCEPTION 'Mapped verification records and files exceed limits.';
  END IF;
  RETURN v_total;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_media_files(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_n bigint;v_stage record;
BEGIN
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-verification-media-files-v1';
  IF v_n=0 THEN RETURN NULL;END IF;
  IF v_n<>1 THEN RAISE EXCEPTION 'Mapped verification media catalog set changed.';END IF;
  SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-verification-media-files-v1';
  IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>0 OR v_stage.row_count<>1 THEN RAISE EXCEPTION 'Mapped verification media namespace changed.';END IF;
  PERFORM private.employee_transfer_mapped_verification_source(p_job,true);
  PERFORM private.employee_transfer_mapped_verification_check_files(p_job,v_stage.payload);
  RETURN v_stage.payload;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_media_path(p_job private.employee_transfer_jobs,p_ref jsonb,p_target uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
BEGIN
  RETURN split_part(p_ref->>'path','/',1)||'/'||p_target::text||'-transfer-'||
    left(encode(extensions.digest(convert_to(p_job.id::text||':'||(p_ref->>'key'),'UTF8'),'sha256'),'hex'),32)||'.'||
    lower(substring(p_ref->>'path' FROM '[.]([A-Za-z0-9]{1,8})$'));
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_verification_media_ready(p_job private.employee_transfer_jobs,p_final boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_files jsonb;v_refs jsonb;v_ref record;v_stage record;v_n bigint;v_receipt jsonb;v_state jsonb;v_map jsonb;v_target uuid;v_origin text;
BEGIN
  v_files:=private.employee_transfer_mapped_verification_media_files(p_job);
  IF v_files IS NULL THEN RETURN false;END IF;
  v_refs:=private.employee_transfer_mapped_verification_media_refs(p_job);
  v_state:=private.employee_transfer_mapped_verification_saved(p_job);v_map:=private.employee_transfer_mapped_activity_saved(p_job)->'identity_map';
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-verification-media-import'
    AND (employee_id<>'00000000-0000-0000-0000-000000000000' OR row_count<>1 OR chunk_no<0 OR chunk_no>=jsonb_array_length(v_refs))) THEN
    RAISE EXCEPTION 'Mapped verification media receipt namespace changed.';
  END IF;
  FOR v_ref IN SELECT value,n-1 AS no FROM jsonb_array_elements(v_refs) WITH ORDINALITY ref(value,n) LOOP
    SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-verification-media-import' AND chunk_no=v_ref.no;
    IF v_n=0 THEN RETURN false;END IF;
    IF v_n<>1 THEN RAISE EXCEPTION 'Mapped verification media receipt set changed.';END IF;
    SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-verification-media-import' AND chunk_no=v_ref.no;
    v_receipt:=v_stage.payload;v_target:=(v_map->>left(split_part(v_ref.value->>'path','/',2),36))::uuid;
    IF v_target IS NULL THEN RETURN false;END IF;
    IF NOT private.employee_transfer_exact_object(v_receipt,ARRAY['file','path','storage_origin','generation','checked'])
      OR v_receipt->'file' IS DISTINCT FROM v_files->(v_ref.no::integer)
      OR v_receipt->>'path' IS DISTINCT FROM private.employee_transfer_mapped_verification_media_path(p_job,v_ref.value,v_target)
      OR jsonb_typeof(v_receipt->'storage_origin') IS DISTINCT FROM 'string' OR (v_receipt->>'storage_origin') !~ '^https://[a-z0-9-]+[.]supabase[.]co$'
      OR jsonb_typeof(v_receipt->'checked') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_receipt->'generation') IS DISTINCT FROM 'string'
      OR (v_receipt->>'generation') !~ '^(0|[1-9][0-9]{0,5})$' OR (v_receipt->>'generation')::bigint>COALESCE((v_state->>'completed_employees')::bigint,0)
      OR (v_origin IS NOT NULL AND v_receipt->>'storage_origin' IS DISTINCT FROM v_origin) THEN RAISE EXCEPTION 'Mapped verification media receipt changed.';END IF;
    v_origin:=v_receipt->>'storage_origin';
    IF p_final AND (v_receipt->'checked' IS DISTINCT FROM 'true'::jsonb OR v_receipt->>'generation' IS DISTINCT FROM v_state->>'completed_employees') THEN RETURN false;END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION public.get_employee_transfer_mapped_verification_media(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_files jsonb;v_refs jsonb;v_result jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_mapped_verification_context(v_job,true);
  v_refs:=private.employee_transfer_mapped_verification_media_refs(v_job);v_files:=private.employee_transfer_mapped_verification_media_files(v_job);
  SELECT COALESCE(jsonb_agg(ref.value||jsonb_build_object('file',v_files->((ref.n-1)::integer)) ORDER BY ref.n),'[]'::jsonb) INTO v_result
    FROM jsonb_array_elements(v_refs) WITH ORDINALITY ref(value,n);
  RETURN jsonb_build_object('scope','employee-mapped-verification-media','direction','import','files',v_result,'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped verification media inventory rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_verification_media_bind(p_admin_session_token uuid,p_job_token uuid,p_files jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_files jsonb;v_total bigint;v_repeated boolean;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,true);
  v_total:=private.employee_transfer_mapped_verification_check_files(v_job,p_files);
  v_files:=private.employee_transfer_mapped_verification_media_files(v_job);v_repeated:=v_files IS NOT NULL;
  IF v_repeated THEN
    IF v_files IS DISTINCT FROM p_files THEN RAISE EXCEPTION 'Mapped verification media catalog is immutable.';END IF;
  ELSE
    IF v_owner->'state'<>'null'::jsonb THEN RAISE EXCEPTION 'Mapped verification media catalog is frozen.';END IF;
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-verification-media-files-v1',0,1,p_files);
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-mapped-verification-media','files',jsonb_array_length(p_files),'bytes',v_total,'repeated',v_repeated,'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped verification media catalog rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_transfer_mapped_verification_media_authorize(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_refs jsonb;v_files jsonb;v_ref jsonb;v_no integer;v_source uuid;v_target uuid;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('upload','recheck-import') OR p_object_key IS NULL OR p_object_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid mapped verification media action.';END IF;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_verification_context(v_job,true);
  v_refs:=private.employee_transfer_mapped_verification_media_refs(v_job);v_files:=private.employee_transfer_mapped_verification_media_files(v_job);
  IF v_files IS NULL THEN RAISE EXCEPTION 'Bind mapped verification media first.';END IF;
  SELECT value,(n-1)::integer INTO STRICT v_ref,v_no FROM jsonb_array_elements(v_refs) WITH ORDINALITY ref(value,n) WHERE value->>'key'=p_object_key;
  v_source:=left(split_part(v_ref->>'path','/',2),36)::uuid;v_target:=(v_owner#>>ARRAY['identity_map',v_source::text])::uuid;
  IF v_target IS NULL OR v_target=v_source THEN RAISE EXCEPTION 'Mapped verification media owner is missing.';END IF;
  RETURN jsonb_build_object('direction','import','key',p_object_key,'bucket','verification-documents','path',private.employee_transfer_mapped_verification_media_path(v_job,v_ref,v_target),
    'source_url',v_ref->>'source_url','file',v_files->v_no,'generation',COALESCE(v_owner#>>'{state,completed_employees}','0'),'source_id',v_source,'target_id',v_target);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped verification media authorization rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_transfer_mapped_verification_media_commit(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text,p_bytes integer,p_sha256 text,p_content_type text,p_storage_origin text,p_generation text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_context jsonb;v_file jsonb;v_no integer;v_origin text;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_context:=public.employee_transfer_mapped_verification_media_authorize(p_admin_session_token,p_job_token,p_action,p_object_key);
  IF p_generation IS NULL OR p_generation IS DISTINCT FROM v_context->>'generation' THEN RAISE EXCEPTION 'Mapped verification media read generation changed.';END IF;
  IF p_storage_origin IS NULL OR p_storage_origin !~ '^https://[a-z0-9-]+[.]supabase[.]co$' THEN RAISE EXCEPTION 'Invalid mapped verification storage origin.';END IF;
  v_file:=jsonb_build_object('key',p_object_key,'source_url',v_context->>'source_url','bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type);
  IF v_file IS DISTINCT FROM v_context->'file' THEN RAISE EXCEPTION 'Mapped verification file content changed.';END IF;
  SELECT payload->>'storage_origin' INTO v_origin FROM private.employee_transfer_staging WHERE job_id=v_job.id AND table_key='mapped-verification-media-import' LIMIT 1;
  IF v_origin IS NOT NULL AND v_origin IS DISTINCT FROM p_storage_origin THEN RAISE EXCEPTION 'Mapped verification target origin changed.';END IF;
  IF p_action='upload' AND private.employee_transfer_mapped_verification_saved(v_job)->'verified'='true'::jsonb THEN RAISE EXCEPTION 'Verified mapped verification files are frozen.';END IF;
  SELECT (n-1)::integer INTO STRICT v_no FROM jsonb_array_elements(private.employee_transfer_mapped_verification_media_refs(v_job)) WITH ORDINALITY ref(value,n) WHERE value->>'key'=p_object_key;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-verification-media-import',v_no,1,
      jsonb_build_object('file',v_file,'path',v_context->>'path','storage_origin',p_storage_origin,'generation',p_generation,'checked',p_action='recheck-import'))
    ON CONFLICT(job_id,employee_id,table_key,chunk_no) DO UPDATE SET payload=EXCLUDED.payload;
  PERFORM private.employee_transfer_mapped_verification_context(v_job,true);
  RETURN jsonb_build_object('success',true,'key',p_object_key,'bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type,'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped verification media commit rejected.' USING ERRCODE='22023';
END;
$$;

DO $permissions$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace
    AND proname LIKE 'employee_transfer_mapped_verification_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
END;
$permissions$;
REVOKE ALL ON FUNCTION public.employee_import_mapped_verification_bind(uuid,uuid,jsonb),
  public.employee_import_mapped_verification_stage(uuid,uuid,text,integer,text),
  public.employee_import_mapped_verification_plan(uuid,uuid),public.employee_import_mapped_verification_begin(uuid,uuid,text),
  public.employee_import_mapped_verification_apply(uuid,uuid,uuid,text),public.employee_import_mapped_verification_status(uuid,uuid,uuid),
  public.employee_import_mapped_verification_verify(uuid,uuid),public.get_employee_transfer_mapped_verification_media(uuid,uuid),
  public.employee_import_mapped_verification_media_bind(uuid,uuid,jsonb),public.employee_transfer_mapped_verification_media_authorize(uuid,uuid,text,text),
  public.employee_transfer_mapped_verification_media_commit(uuid,uuid,text,text,integer,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_import_mapped_verification_bind(uuid,uuid,jsonb),
  public.employee_import_mapped_verification_stage(uuid,uuid,text,integer,text),
  public.employee_import_mapped_verification_plan(uuid,uuid),public.employee_import_mapped_verification_begin(uuid,uuid,text),
  public.employee_import_mapped_verification_apply(uuid,uuid,uuid,text),public.employee_import_mapped_verification_status(uuid,uuid,uuid),
  public.employee_import_mapped_verification_verify(uuid,uuid),public.get_employee_transfer_mapped_verification_media(uuid,uuid),
  public.employee_import_mapped_verification_media_bind(uuid,uuid,jsonb) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.employee_transfer_mapped_verification_media_authorize(uuid,uuid,text,text),
  public.employee_transfer_mapped_verification_media_commit(uuid,uuid,text,text,integer,text,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
