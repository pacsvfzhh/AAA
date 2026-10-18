BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_verification_media_refs(p_job private.employee_transfer_jobs,p_export boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_query text;v_rows jsonb;v_row jsonb;v_field text;v_url text;v_path text;v_key text;v_refs jsonb:='{}';
BEGIN
  IF p_export IS NULL THEN RAISE EXCEPTION 'An explicit verification media mode is required.';END IF;
  IF p_export THEN
    v_query:=private.employee_transfer_verification_query('verification_requests');
    EXECUTE 'SELECT COALESCE(jsonb_agg(body),''[]''::jsonb) FROM ('||v_query||') AS r' INTO v_rows;
  ELSE
    SELECT COALESCE(jsonb_agg(body),'[]'::jsonb) INTO v_rows FROM private.employee_transfer_verification_input(p_job.id,'verification_requests');
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
    FOREACH v_field IN ARRAY ARRAY['id_front_url','id_back_url','selfie_url'] LOOP
      v_url:=v_row->>v_field;
      IF v_url IS NULL THEN CONTINUE;END IF;
      IF length(v_url)>512 OR v_url !~ '^https://[a-z0-9-]+[.]supabase[.]co/storage/v1/object/public/verification-documents/(id-front|id-back|selfie)/[0-9a-f-]{36}-[A-Za-z0-9._-]+[.][A-Za-z0-9]{1,8}$' THEN
        RAISE EXCEPTION 'Unmanaged verification document URL; no file was omitted.';
      END IF;
      v_path:=split_part(v_url,'/verification-documents/',2);
      IF split_part(v_path,'/',2) NOT LIKE (v_row->>'user_id')||'-%' OR length(split_part(v_path,'/',2))>128
        OR v_path ~ '[.][.]' THEN RAISE EXCEPTION 'Verification document path does not belong to its employee.';END IF;
      v_key:=encode(extensions.digest(convert_to(v_url,'UTF8'),'sha256'),'hex');
      v_refs:=v_refs||jsonb_build_object(v_key,jsonb_build_object('key',v_key,'source_url',v_url,'bucket','verification-documents','path',v_path));
      IF (SELECT count(*) FROM jsonb_object_keys(v_refs))>3000 THEN RAISE EXCEPTION 'Verification media exceeds this substage limit; no files were truncated.';END IF;
    END LOOP;
  END LOOP;
  RETURN COALESCE((SELECT jsonb_agg(value ORDER BY key COLLATE "C") FROM jsonb_each(v_refs)),'[]'::jsonb);
END;
$$;

CREATE FUNCTION private.employee_transfer_verification_media_job(p_admin uuid,p_token uuid,p_direction text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  IF p_direction='export' THEN
    v_job:=private.employee_transfer_job(p_admin,p_token,'verification-export');
    PERFORM private.employee_transfer_verification_schema();
  ELSIF p_direction='import' THEN
    v_job:=private.employee_transfer_job(p_admin,p_token,'dispatch-import');
    PERFORM private.employee_transfer_verification_owner(v_job);
    PERFORM private.employee_transfer_check_verification_input(v_job);
  ELSE RAISE EXCEPTION 'Unsupported verification media direction.';END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION public.get_employee_transfer_verification_media(p_admin_session_token uuid,p_job_token uuid,p_direction text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_refs jsonb;v_files jsonb;
BEGIN
  v_job:=private.employee_transfer_verification_media_job(p_admin_session_token,p_job_token,p_direction);
  v_refs:=private.employee_transfer_verification_media_refs(v_job,p_direction='export');
  IF p_direction='export' THEN
    SELECT COALESCE(jsonb_agg(ref.value||jsonb_build_object('file',s.payload->'file') ORDER BY ref.value->>'key'),'[]'::jsonb) INTO v_files
      FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n)
      LEFT JOIN private.employee_transfer_staging AS s ON s.job_id=v_job.id AND s.employee_id='00000000-0000-0000-0000-000000000000'
        AND s.table_key='verification-media-export' AND s.chunk_no=ref.n-1;
  ELSE
    SELECT COALESCE(jsonb_agg(ref.value||jsonb_build_object('file',f.value) ORDER BY ref.value->>'key'),'[]'::jsonb) INTO v_files
      FROM jsonb_array_elements(v_refs) AS ref(value) LEFT JOIN LATERAL
      (SELECT value FROM jsonb_array_elements(v_job.summary->'verification_media_files') WHERE value->>'key'=ref.value->>'key') AS f ON true;
  END IF;
  RETURN jsonb_build_object('scope','employee-verification-media','direction',p_direction,'files',v_files,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_verification_media_bind(p_admin_session_token uuid,p_job_token uuid,p_files jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_refs jsonb;v_ref jsonb;v_file jsonb;v_n integer:=0;v_total bigint:=0;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_verification_media_job(p_admin_session_token,p_job_token,'import');
  v_refs:=private.employee_transfer_verification_media_refs(v_job,false);
  IF jsonb_typeof(p_files) IS DISTINCT FROM 'array' OR jsonb_array_length(p_files)<>jsonb_array_length(v_refs)
    OR octet_length(p_files::text)>2097152 THEN RAISE EXCEPTION 'Invalid verification media catalog.';END IF;
  FOR v_ref IN SELECT value FROM jsonb_array_elements(v_refs) LOOP
    v_file:=p_files->v_n;v_n:=v_n+1;
    IF NOT private.employee_transfer_exact_object(v_file,ARRAY['key','source_url','bytes','sha256','content_type'])
      OR v_file->'key' IS DISTINCT FROM v_ref->'key' OR v_file->'source_url' IS DISTINCT FROM v_ref->'source_url'
      OR jsonb_typeof(v_file->'bytes') IS DISTINCT FROM 'number' OR (v_file->>'bytes') !~ '^[1-9][0-9]{0,7}$'
      OR (v_file->>'bytes')::bigint>52428800 OR jsonb_typeof(v_file->'sha256') IS DISTINCT FROM 'string' OR (v_file->>'sha256') !~ '^[0-9a-f]{64}$'
      OR v_file->>'content_type' NOT IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf') OR v_file->>'content_type' IS NULL THEN
      RAISE EXCEPTION 'Invalid or mismatched verification file.';
    END IF;
    v_total:=v_total+(v_file->>'bytes')::bigint;
  END LOOP;
  IF v_total>1073741824 THEN RAISE EXCEPTION 'Verification media exceeds limits; no files were truncated.';END IF;
  v_repeated:=v_job.summary ? 'verification_media_files';
  IF v_repeated THEN
    IF p_files IS DISTINCT FROM v_job.summary->'verification_media_files' THEN RAISE EXCEPTION 'Verification media binding is immutable.';END IF;
  ELSE
    IF v_job.summary ? 'verification_restore' THEN RAISE EXCEPTION 'Verification media binding is frozen.';END IF;
    UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('verification_media_files',p_files) WHERE id=v_job.id;
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-verification-media','files',v_n,'bytes',v_total,'repeated',v_repeated,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_transfer_verification_media_authorize(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_direction text;v_ref jsonb;v_file jsonb;v_path text;v_n integer;v_receipt jsonb;
BEGIN
  IF p_action IN ('download','recheck-export') THEN v_direction:='export';
  ELSIF p_action IN ('upload','recheck-import') THEN v_direction:='import';
  ELSE RAISE EXCEPTION 'Unsupported verification media action.';END IF;
  IF p_object_key IS NULL OR p_object_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid verification object key.';END IF;
  v_job:=private.employee_transfer_verification_media_job(p_admin_session_token,p_job_token,v_direction);
  SELECT value,n-1 INTO v_ref,v_n FROM jsonb_array_elements(private.employee_transfer_verification_media_refs(v_job,v_direction='export')) WITH ORDINALITY AS ref(value,n)
    WHERE value->>'key'=p_object_key;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Verification document is outside this task.';END IF;
  IF v_direction='export' THEN
    SELECT payload INTO v_receipt FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='verification-media-export' AND chunk_no=v_n;
    IF p_action='recheck-export' AND v_receipt IS NULL THEN RAISE EXCEPTION 'Verification media must first be downloaded.';END IF;
    v_file:=v_receipt->'file';v_path:=v_ref->>'path';
  ELSE
    SELECT value INTO v_file FROM jsonb_array_elements(v_job.summary->'verification_media_files') WHERE value->>'key'=p_object_key;
    IF v_file IS NULL THEN RAISE EXCEPTION 'Verification media has not been bound.';END IF;
    v_path:=split_part(v_ref->>'path','/',1)||'/'||left(split_part(v_ref->>'path','/',2),36)||'-transfer-'||
      left(encode(extensions.digest(convert_to(v_job.id::text||':'||p_object_key,'UTF8'),'sha256'),'hex'),32)||'.'||lower(substring(v_ref->>'path' FROM '[.]([A-Za-z0-9]{1,8})$'));
  END IF;
  RETURN jsonb_build_object('direction',v_direction,'key',p_object_key,'bucket','verification-documents','path',v_path,'source_url',v_ref->>'source_url','file',v_file);
END;
$$;

CREATE FUNCTION public.employee_transfer_verification_media_commit(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text,p_bytes integer,p_sha256 text,p_content_type text,p_storage_origin text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_context jsonb;v_job private.employee_transfer_jobs%ROWTYPE;v_direction text;v_file jsonb;v_n integer;v_previous jsonb;v_table text;v_origin text;
BEGIN
  v_context:=public.employee_transfer_verification_media_authorize(p_admin_session_token,p_job_token,p_action,p_object_key);v_direction:=v_context->>'direction';
  IF p_storage_origin IS NULL OR p_storage_origin !~ '^https://[a-z0-9-]+[.]supabase[.]co$'
    OR p_bytes IS NULL OR p_bytes NOT BETWEEN 1 AND 52428800 OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
    OR p_content_type IS NULL OR p_content_type NOT IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf') THEN RAISE EXCEPTION 'Invalid verified document receipt.';END IF;
  v_job:=private.employee_transfer_verification_media_job(p_admin_session_token,p_job_token,v_direction);
  IF v_direction='export' AND split_part(v_context->>'source_url','/storage/',1) IS DISTINCT FROM p_storage_origin THEN RAISE EXCEPTION 'Source document is not stored on this site.';END IF;
  v_file:=jsonb_build_object('key',p_object_key,'source_url',v_context->>'source_url','bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type);
  IF v_context->'file'<>'null'::jsonb AND v_file IS DISTINCT FROM v_context->'file' THEN RAISE EXCEPTION 'Verification document content changed.';END IF;
  v_origin:=v_job.summary->>'verification_storage_origin';
  IF v_direction='import' AND v_origin IS NOT NULL AND v_origin IS DISTINCT FROM p_storage_origin THEN RAISE EXCEPTION 'Target storage origin changed.';END IF;
  SELECT (n-1)::integer INTO v_n FROM jsonb_array_elements(private.employee_transfer_verification_media_refs(v_job,v_direction='export')) WITH ORDINALITY AS ref(value,n) WHERE value->>'key'=p_object_key;
  v_table:='verification-media-'||v_direction;
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key=v_table AND chunk_no=v_n;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,'00000000-0000-0000-0000-000000000000',v_table,v_n,1,
    jsonb_build_object('file',v_file,'path',v_context->>'path','storage_origin',p_storage_origin,'checked',p_action IN ('recheck-export','recheck-import') OR COALESCE((v_previous->>'checked')::boolean,false),'checked_at',clock_timestamp()))
    ON CONFLICT(job_id,employee_id,table_key,chunk_no) DO UPDATE SET payload=EXCLUDED.payload;
  IF v_direction='import' THEN UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('verification_storage_origin',p_storage_origin) WHERE id=v_job.id;END IF;
  RETURN jsonb_build_object('success',true,'key',p_object_key,'bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type,'full_site_complete',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_check_verification_media_export(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_ref record;v_payload jsonb;v_total bigint:=0;
BEGIN
  FOR v_ref IN SELECT value,n-1 AS no FROM jsonb_array_elements(private.employee_transfer_verification_media_refs(p_job,true)) WITH ORDINALITY AS ref(value,n) LOOP
    SELECT payload INTO v_payload FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='verification-media-export' AND chunk_no=v_ref.no;
    IF v_payload IS NULL OR v_payload->>'checked' IS DISTINCT FROM 'true' OR v_payload#>'{file,key}' IS DISTINCT FROM v_ref.value->'key'
      OR v_payload#>'{file,source_url}' IS DISTINCT FROM v_ref.value->'source_url' THEN RAISE EXCEPTION 'Verification media export is incomplete.';END IF;
    v_total:=v_total+(v_payload#>>'{file,bytes}')::bigint;
  END LOOP;
  IF v_total>1073741824 THEN RAISE EXCEPTION 'Verification media exceeds limits.';END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_verification_media_ready(p_job private.employee_transfer_jobs,p_final boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_ref record;v_file jsonb;v_receipt jsonb;
BEGIN
  IF p_job.summary->'verification_media_files' IS NULL THEN RETURN false;END IF;
  FOR v_ref IN SELECT value,n-1 AS no FROM jsonb_array_elements(private.employee_transfer_verification_media_refs(p_job,false)) WITH ORDINALITY AS ref(value,n) LOOP
    v_file:=p_job.summary->'verification_media_files'->v_ref.no;
    SELECT payload INTO v_receipt FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='verification-media-import' AND chunk_no=v_ref.no;
    IF v_receipt IS NULL OR v_receipt->'file' IS DISTINCT FROM v_file OR v_file->'source_url' IS DISTINCT FROM v_ref.value->'source_url' THEN RETURN false;END IF;
    IF p_final AND (v_receipt->>'checked' IS DISTINCT FROM 'true' OR (v_receipt->>'checked_at')::timestamptz<(p_job.summary#>>'{verification_restore,last_applied_at}')::timestamptz) THEN RETURN false;END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION private.employee_transfer_verification_context(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;v_done bigint;
BEGIN
  v_map:=private.employee_transfer_verification_owner(p_job);
  PERFORM private.employee_transfer_activity_context(p_job);PERFORM private.employee_transfer_check_activity_input(p_job);
  v_done:=private.employee_transfer_activity_progress(p_job,v_map);
  IF v_done IS DISTINCT FROM (p_job.summary#>>'{identity_catalog,tables,0,rows}')::bigint THEN RAISE EXCEPTION 'Complete verified activity is required for verification.';END IF;
  RETURN v_map;
END;
$$;

CREATE FUNCTION private.employee_transfer_verification_plan(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_counts jsonb;v_issues jsonb:='[]';v_plan jsonb;
BEGIN
  v_counts:=private.employee_transfer_check_verification_input(p_job);
  IF EXISTS(SELECT 1 FROM public.verification_requests AS t JOIN private.employee_transfer_identity_input(p_job.id,'accounts') AS a ON a.id=t.user_id) THEN v_issues:=v_issues||'"verification_target_not_empty"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_verification_input(p_job.id,'verification_requests') AS h JOIN public.verification_requests AS t ON t.id=h.id::uuid) THEN v_issues:=v_issues||'"verification_uuid_collision"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_verification_input(p_job.id,'verification_requests') AS h WHERE NOT EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') AS a WHERE a.id=(h.body->>'user_id')::uuid)) THEN v_issues:=v_issues||'"source_employee_missing"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_verification_input(p_job.id,'verification_requests') AS h WHERE h.body->>'audited_by' IS NOT NULL AND NOT p_map ? (h.body->>'audited_by')) THEN v_issues:=v_issues||'"verification_admin_unmapped"'::jsonb;END IF;
  IF NOT private.employee_transfer_verification_media_ready(p_job) THEN v_issues:=v_issues||'"media_incomplete"'::jsonb;END IF;
  v_plan:=jsonb_build_object('scope','employee-verification','can_restore',jsonb_array_length(v_issues)=0,'counts',v_counts,'employees',(p_job.summary#>>'{identity_catalog,tables,0,rows}')::bigint,
    'conflicts',v_issues,'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,'job_id',p_job.id,'catalog',p_job.summary->'verification_catalog','media',p_job.summary->'verification_media_files','admin_map',p_map)::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_transfer_verification_expected(p_job private.employee_transfer_jobs,p_employee uuid,p_map jsonb)
RETURNS TABLE(id uuid,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_row record;v_body jsonb;v_field text;v_url text;v_key text;v_receipt jsonb;
BEGIN
  FOR v_row IN SELECT h.id,h.body FROM private.employee_transfer_verification_input(p_job.id,'verification_requests') AS h WHERE h.body->>'user_id'=p_employee::text LOOP
    v_body:=v_row.body||jsonb_build_object('audited_by',p_map->>(v_row.body->>'audited_by'));
    FOREACH v_field IN ARRAY ARRAY['id_front_url','id_back_url','selfie_url'] LOOP
      v_url:=v_row.body->>v_field;IF v_url IS NULL THEN CONTINUE;END IF;
      v_key:=encode(extensions.digest(convert_to(v_url,'UTF8'),'sha256'),'hex');
      SELECT payload INTO v_receipt FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='verification-media-import' AND payload#>>'{file,key}'=v_key;
      IF v_receipt IS NULL THEN RAISE EXCEPTION 'Verification document has not been verified on target storage.';END IF;
      v_body:=v_body||jsonb_build_object(v_field,(v_receipt->>'storage_origin')||'/storage/v1/object/public/verification-documents/'||(v_receipt->>'path'));
    END LOOP;
    id:=v_row.id::uuid;body:=v_body;RETURN NEXT;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_verification_written(p_job private.employee_transfer_jobs,p_employee uuid,p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_expected bigint;v_actual bigint;
BEGIN
  SELECT count(*) INTO v_expected FROM private.employee_transfer_verification_input(p_job.id,'verification_requests') WHERE body->>'user_id'=p_employee::text;
  SELECT count(*) INTO v_actual FROM public.verification_requests WHERE user_id=p_employee;
  IF v_actual IS DISTINCT FROM v_expected OR EXISTS(SELECT 1 FROM private.employee_transfer_verification_expected(p_job,p_employee,p_map) AS e LEFT JOIN public.verification_requests AS t ON t.id=e.id AND to_jsonb(t)=e.body WHERE t.id IS NULL) THEN RAISE EXCEPTION 'Verification committed content changed.';END IF;
  RETURN jsonb_build_object('verification_requests',v_actual);
END;
$$;

CREATE FUNCTION private.employee_transfer_verification_progress(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS bigint LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_count bigint:=0;v_done record;v_actual jsonb;
BEGIN
  IF p_job.summary ? 'verification_restore' AND p_job.summary#>'{verification_restore,admin_map}' IS DISTINCT FROM p_map THEN RAISE EXCEPTION 'Verification administrator mapping changed.';END IF;
  FOR v_done IN SELECT employee_id,payload FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='verification-done' LOOP
    IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') WHERE id=v_done.employee_id)
      OR v_done.payload->>'plan_hash' IS DISTINCT FROM p_job.summary#>>'{verification_plan,plan_hash}' THEN RAISE EXCEPTION 'Verification completion binding changed.';END IF;
    v_actual:=private.employee_transfer_check_verification_written(p_job,v_done.employee_id,p_map);
    IF v_actual IS DISTINCT FROM v_done.payload->'counts' THEN RAISE EXCEPTION 'Verification completion count changed.';END IF;
    v_count:=v_count+1;
  END LOOP;
  IF v_count IS DISTINCT FROM COALESCE((p_job.summary#>>'{verification_restore,completed_employees}')::bigint,0) THEN RAISE EXCEPTION 'Verification committed progress changed.';END IF;
  RETURN v_count;
END;
$$;

CREATE FUNCTION public.get_employee_import_verification_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_map jsonb;v_plan jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_verification_context(v_job);
  IF v_job.summary ? 'verification_restore' THEN
    PERFORM private.employee_transfer_check_verification_input(v_job);PERFORM private.employee_transfer_verification_progress(v_job,v_map);
    IF NOT private.employee_transfer_verification_media_ready(v_job) THEN RAISE EXCEPTION 'Verified target documents are required.';END IF;
    RETURN v_job.summary->'verification_plan';
  END IF;
  v_plan:=private.employee_transfer_verification_plan(v_job,v_map);
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('verification_plan',v_plan) WHERE id=v_job.id;
  RETURN v_plan;
END;
$$;

CREATE FUNCTION public.employee_import_verification_apply(p_admin_session_token uuid,p_job_token uuid,p_employee_id uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_map jsonb;v_completed bigint;v_total bigint;v_counts jsonb;v_done jsonb;v_row record;v_columns text;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');v_map:=private.employee_transfer_verification_context(v_job);
  PERFORM private.employee_transfer_check_verification_input(v_job);
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_job.summary#>>'{verification_plan,plan_hash}' OR v_job.summary#>'{verification_plan,can_restore}' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'A matching conflict-free verification plan must be confirmed.';END IF;
  IF p_employee_id IS NULL OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(v_job.id,'accounts') WHERE id=p_employee_id) THEN RAISE EXCEPTION 'Verification employee is outside this package.';END IF;
  IF NOT private.employee_transfer_verification_media_ready(v_job) THEN RAISE EXCEPTION 'Verified target documents are required.';END IF;
  v_total:=(v_job.summary#>>'{verification_plan,employees}')::bigint;v_completed:=private.employee_transfer_verification_progress(v_job,v_map);
  SELECT payload INTO v_done FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id=p_employee_id AND table_key='verification-done' AND chunk_no=0;
  IF v_done IS NOT NULL THEN RETURN private.employee_transfer_activity_receipt(p_employee_id,v_done->'counts',v_completed,v_total,true)||'{"scope":"employee-verification"}'::jsonb;END IF;
  IF NOT v_job.summary ? 'verification_restore' THEN
    IF private.employee_transfer_verification_plan(v_job,v_map) IS DISTINCT FROM v_job.summary->'verification_plan' THEN RAISE EXCEPTION 'Verification plan or target changed.';END IF;
  ELSIF EXISTS(SELECT 1 FROM public.verification_requests WHERE user_id=p_employee_id) THEN RAISE EXCEPTION 'Employee verification target changed.';END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_verification_input(v_job.id,'verification_requests') AS h JOIN public.verification_requests AS t ON t.id=h.id::uuid WHERE h.body->>'user_id'=p_employee_id::text) THEN RAISE EXCEPTION 'Verification UUID collision changed after planning.';END IF;
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names) VALUES(pg_current_xact_id(),v_job.id,ARRAY['public.verification_requests']);
  SELECT string_agg(format('%I',key),',' ORDER BY key COLLATE "C") INTO v_columns FROM jsonb_each(private.employee_transfer_verification_spec()->'verification_requests');
  FOR v_row IN SELECT body FROM private.employee_transfer_verification_expected(v_job,p_employee_id,v_map) ORDER BY id LOOP
    PERFORM private.employee_transfer_check_verification_row('verification_requests',v_row.body);
    EXECUTE format('INSERT INTO public.verification_requests(%s) SELECT %s FROM jsonb_populate_record(NULL::public.verification_requests,$1) AS r',v_columns,v_columns) USING v_row.body;
  END LOOP;
  PERFORM private.employee_transfer_clear_write_permit();PERFORM private.employee_transfer_verification_schema();
  v_counts:=private.employee_transfer_check_verification_written(v_job,p_employee_id,v_map);v_completed:=v_completed+1;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('verification_restore',jsonb_build_object('completed_employees',v_completed,'admin_map',v_map,'last_applied_at',clock_timestamp(),'verified',false)) WHERE id=v_job.id;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,p_employee_id,'verification-done',0,1,jsonb_build_object('plan_hash',p_plan_hash,'counts',v_counts));
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','verification_employee_restored',jsonb_build_object('employee_id',p_employee_id,'counts',v_counts,'full_site_complete',false));
  RETURN private.employee_transfer_activity_receipt(p_employee_id,v_counts,v_completed,v_total,false)||'{"scope":"employee-verification"}'::jsonb;
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit();RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_verification_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_map jsonb;v_counts jsonb;v_completed bigint;v_total bigint;v_repeated boolean;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');v_map:=private.employee_transfer_verification_context(v_job);
  v_counts:=private.employee_transfer_check_verification_input(v_job);v_completed:=private.employee_transfer_verification_progress(v_job,v_map);v_total:=(v_job.summary#>>'{verification_plan,employees}')::bigint;
  IF v_total IS NULL OR v_job.summary#>'{verification_plan,can_restore}' IS DISTINCT FROM 'true'::jsonb OR v_completed<>v_total OR NOT private.employee_transfer_verification_media_ready(v_job,true) THEN RAISE EXCEPTION 'Verification restore or final document readback is incomplete.';END IF;
  v_repeated:=COALESCE((v_job.summary#>>'{verification_restore,verified}')::boolean,false);
  UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{verification_restore,verified}','true'::jsonb) WHERE id=v_job.id;
  IF NOT v_repeated THEN PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','verification_verified',jsonb_build_object('counts',v_counts,'full_site_complete',false));END IF;
  RETURN private.employee_transfer_activity_receipt(NULL,v_counts,v_completed,v_total,v_repeated)||'{"scope":"employee-verification"}'::jsonb;
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);END LOOP;
  REVOKE ALL ON FUNCTION public.get_employee_transfer_verification_media(uuid,uuid,text),public.employee_import_verification_media_bind(uuid,uuid,jsonb),public.get_employee_import_verification_plan(uuid,uuid),public.employee_import_verification_apply(uuid,uuid,uuid,text),public.employee_import_verification_verify(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
  GRANT EXECUTE ON FUNCTION public.get_employee_transfer_verification_media(uuid,uuid,text),public.employee_import_verification_media_bind(uuid,uuid,jsonb),public.get_employee_import_verification_plan(uuid,uuid),public.employee_import_verification_apply(uuid,uuid,uuid,text),public.employee_import_verification_verify(uuid,uuid) TO anon,authenticated;
  REVOKE ALL ON FUNCTION public.employee_transfer_verification_media_authorize(uuid,uuid,text,text),public.employee_transfer_verification_media_commit(uuid,uuid,text,text,integer,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
  GRANT EXECUTE ON FUNCTION public.employee_transfer_verification_media_authorize(uuid,uuid,text,text),public.employee_transfer_verification_media_commit(uuid,uuid,text,text,integer,text,text,text) TO service_role;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
