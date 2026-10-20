BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_archives_lines(p_job_id uuid,p_key text)
RETURNS TABLE(id text,body jsonb,source_line text,chunk_no integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_stage record;v_raw text;v_line text;v_json json;v_body jsonb;v_last text;v_chunk_last text;
  v_rows integer;v_next integer:=0;v_hashes text;
BEGIN
  IF p_key IS NULL OR NOT p_key=ANY(private.employee_transfer_archives_keys()) THEN RAISE EXCEPTION 'Unsupported archive table.';END IF;
  FOR v_stage IN SELECT s.chunk_no,s.row_count,s.payload FROM private.employee_transfer_staging s
    WHERE s.job_id=p_job_id AND s.employee_id='00000000-0000-0000-0000-000000000000'
      AND s.table_key='archives-in:'||p_key ORDER BY s.chunk_no LOOP
    IF v_stage.chunk_no<>v_next OR v_stage.chunk_no>500000
      OR NOT private.employee_transfer_exact_object(v_stage.payload,ARRAY['ndjson','rows','bytes','row_hashes','last_id'])
      OR jsonb_typeof(v_stage.payload->'ndjson') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_stage.payload->'rows') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Archive staged raw lines differ.';END IF;
    v_raw:=v_stage.payload->>'ndjson';v_rows:=0;v_hashes:='';v_chunk_last:=NULL;
    IF octet_length(v_raw)>262144 OR (v_raw<>'' AND right(v_raw,1)<>E'\n') THEN RAISE EXCEPTION 'Archive staged raw lines differ.';END IF;
    IF v_raw<>'' THEN
      FOR v_line IN SELECT item.line FROM unnest(string_to_array(left(v_raw,length(v_raw)-1),E'\n')) AS item(line) LOOP
        IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Archive staged raw lines differ.';END IF;
        v_json:=v_line::json;v_body:=v_json::jsonb;
        IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_chat_unique_json(v_json) THEN
          RAISE EXCEPTION 'Archive staged raw lines differ.';
        END IF;
        PERFORM private.employee_transfer_check_archives_row(p_key,v_body);
        IF v_body IS DISTINCT FROM v_stage.payload->'rows'->v_rows
          OR (v_last IS NOT NULL AND v_last COLLATE "C">=(v_body->>'id') COLLATE "C") THEN
          RAISE EXCEPTION 'Archive staged raw lines differ.';
        END IF;
        v_last:=v_body->>'id';v_chunk_last:=v_last;v_rows:=v_rows+1;
        IF v_rows>200 THEN RAISE EXCEPTION 'Archive staged raw lines differ.';END IF;
        v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
        id:=v_last;body:=v_body;source_line:=v_line||E'\n';chunk_no:=v_stage.chunk_no;
        RETURN NEXT;
      END LOOP;
    END IF;
    IF v_stage.row_count<>v_rows OR jsonb_array_length(v_stage.payload->'rows')<>v_rows
      OR v_stage.payload->'bytes' IS DISTINCT FROM to_jsonb(octet_length(v_raw))
      OR v_stage.payload->'row_hashes' IS DISTINCT FROM to_jsonb(v_hashes)
      OR v_stage.payload->'last_id' IS DISTINCT FROM COALESCE(to_jsonb(v_chunk_last),'null'::jsonb)
      OR (v_rows=0 AND v_stage.chunk_no<>0) THEN RAISE EXCEPTION 'Archive staged raw lines differ.';END IF;
    v_next:=v_next+1;
  END LOOP;
  IF v_next=0 THEN RAISE EXCEPTION 'Archive staged raw lines are incomplete.';END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_namespace_hash(p_site uuid,p_package uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(
    encode(extensions.digest(convert_to(jsonb_build_array(r.table_key,r.source_id,
      encode(extensions.digest(convert_to(r.source_line,'UTF8'),'sha256'),'hex'),r.body)::text,'UTF8'),'sha256'),'hex'),
    '' ORDER BY r.table_key COLLATE "C",r.source_id COLLATE "C"),''),'UTF8'),'sha256'),'hex')
  FROM private.employee_transfer_archive_records r WHERE r.source_site_id=p_site AND r.package_id=p_package;
$$;

CREATE FUNCTION private.employee_transfer_archives_conflicts(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_conflicts jsonb:='[]';v_key text;v_site uuid:=(p_job.summary#>>'{archives_catalog,site_id}')::uuid;
  v_package uuid:=(p_job.summary#>>'{archives_catalog,package_id}')::uuid;v_rows bigint;v_bad bigint;v_record_conflict boolean:=false;
BEGIN
  FOREACH v_key IN ARRAY private.employee_transfer_archives_keys() LOOP
    SELECT count(s.id),count(*) FILTER(WHERE r.source_id IS NOT NULL AND (s.id IS NULL OR r.body IS DISTINCT FROM s.body
      OR convert_to(r.source_line,'UTF8') IS DISTINCT FROM convert_to(s.source_line,'UTF8')))
      INTO v_rows,v_bad FROM private.employee_transfer_archives_lines(p_job.id,v_key) s
      FULL JOIN (SELECT a.source_id,a.body,a.source_line FROM private.employee_transfer_archive_records a
        WHERE a.source_site_id=v_site AND a.package_id=v_package AND a.table_key=v_key) r ON r.source_id=s.id;
    IF v_bad<>0 THEN v_record_conflict:=true;END IF;
  END LOOP;
  IF EXISTS(
    WITH accounts AS MATERIALIZED (SELECT * FROM private.employee_transfer_archives_input(p_job.id,'deleted_employee_accounts')),
      summaries AS MATERIALIZED (SELECT * FROM private.employee_transfer_archives_input(p_job.id,'deleted_employee_summaries'))
    SELECT 1 FROM private.employee_transfer_archives_input(p_job.id,'deleted_employee_notifications') n
      WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=n.body->>'record_id')
    UNION ALL
    SELECT 1 FROM summaries s FULL JOIN accounts a ON a.id=s.id
      WHERE s.id IS NULL OR a.id IS NULL OR s.body->'employee_id' IS DISTINCT FROM a.body->'employee_id'
    UNION ALL
    SELECT 1 FROM private.employee_transfer_archives_input(p_job.id,'deleted_employee_withdrawals') w
      WHERE NOT EXISTS(SELECT 1 FROM accounts a WHERE a.id=w.body->>'record_id' AND a.body->'employee_id'=w.body->'employee_id')
  ) THEN v_conflicts:=v_conflicts||'"archive_reference_missing"'::jsonb;END IF;
  IF v_record_conflict THEN v_conflicts:=v_conflicts||'"archive_record_conflict"'::jsonb;END IF;
  RETURN v_conflicts;
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_plan(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_counts jsonb;v_conflicts jsonb;v_plan jsonb;v_hash text;
BEGIN
  PERFORM private.employee_transfer_archives_owner(p_job);
  v_counts:=private.employee_transfer_check_archives_input(p_job);
  v_conflicts:=private.employee_transfer_archives_conflicts(p_job);
  v_plan:=jsonb_build_object('scope','site-archives','checked',true,'can_restore',jsonb_array_length(v_conflicts)=0,
    'counts',v_counts,'conflicts',v_conflicts,'media_pending',true,'maintenance',true,'financial_data_pending',true,
    'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('job_id',p_job.id,'catalog',p_job.summary->'archives_catalog',
    'namespace_hash',private.employee_transfer_archives_namespace_hash((p_job.summary#>>'{archives_catalog,site_id}')::uuid,
      (p_job.summary#>>'{archives_catalog,package_id}')::uuid),'plan',v_plan)::text,'UTF8'),'sha256'),'hex');
  RETURN v_plan||jsonb_build_object('plan_hash',v_hash);
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_status(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_counts jsonb;v_chunks jsonb:='{}';v_completed jsonb:='{}';v_state jsonb;v_key text;v_plan jsonb;v_hash text;v_conflicts jsonb;
  v_total integer;v_done integer;v_expected bigint;v_actual bigint;v_started boolean;v_verified boolean:=false;
  v_incomplete boolean:=false;v_all boolean:=true;
  v_site uuid;v_package uuid;
BEGIN
  PERFORM private.employee_transfer_archives_owner(p_job);
  PERFORM private.employee_transfer_check_archives_catalog(p_job.summary->'archives_catalog');
  IF NOT p_job.summary ? 'archives_restore' THEN
    SELECT jsonb_object_agg(t->>'key',t->'rows'),jsonb_object_agg(t->>'key',0) INTO v_counts,v_chunks
      FROM jsonb_array_elements(p_job.summary#>'{archives_catalog,tables}') t;
    RETURN jsonb_build_object('scope','site-archives','started',false,'records_verified',false,'counts',v_counts,
      'chunks',v_chunks,'completed_chunks',v_chunks,'media_pending',true,'maintenance',true,'financial_data_pending',true,
      'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
  END IF;
  v_counts:=private.employee_transfer_check_archives_input(p_job);
  v_conflicts:=private.employee_transfer_archives_conflicts(p_job);
  v_site:=(p_job.summary#>>'{archives_catalog,site_id}')::uuid;v_package:=(p_job.summary#>>'{archives_catalog,package_id}')::uuid;
  v_started:=p_job.summary ? 'archives_restore';v_state:=p_job.summary->'archives_restore';
  IF v_started THEN
    IF v_conflicts<>'[]'::jsonb THEN RAISE EXCEPTION 'Archive references or namespace records differ.';END IF;
    IF NOT private.employee_transfer_exact_object(v_state,ARRAY['catalog','plan_hash','plan','initial_namespace_hash','namespace_hash','chunks','completed_chunks','records_verified'])
      OR v_state->'catalog' IS DISTINCT FROM p_job.summary->'archives_catalog'
      OR NOT private.employee_transfer_exact_object(v_state->'chunks',private.employee_transfer_archives_keys())
      OR NOT private.employee_transfer_exact_object(v_state->'completed_chunks',private.employee_transfer_archives_keys())
      OR jsonb_typeof(v_state->'records_verified') IS DISTINCT FROM 'boolean'
      OR jsonb_typeof(v_state->'plan_hash') IS DISTINCT FROM 'string' OR (v_state->>'plan_hash') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(v_state->'initial_namespace_hash') IS DISTINCT FROM 'string' OR (v_state->>'initial_namespace_hash') !~ '^[0-9a-f]{64}$'
      OR v_state->>'namespace_hash' IS DISTINCT FROM private.employee_transfer_archives_namespace_hash(v_site,v_package) THEN
      RAISE EXCEPTION 'Archive restore binding or namespace changed.';
    END IF;
    v_plan:=jsonb_build_object('scope','site-archives','checked',true,'can_restore',true,'counts',v_counts,'conflicts','[]'::jsonb,
      'media_pending',true,'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
    v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('job_id',p_job.id,'catalog',v_state->'catalog',
      'namespace_hash',v_state->>'initial_namespace_hash','plan',v_plan)::text,'UTF8'),'sha256'),'hex');
    IF v_state->'plan' IS DISTINCT FROM v_plan OR v_state->>'plan_hash' IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'Archive restore plan changed.';END IF;
    v_verified:=(v_state->>'records_verified')::boolean;
  END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_archives_keys() LOOP
    IF NOT v_started THEN
      v_chunks:=v_chunks||jsonb_build_object(v_key,0);v_completed:=v_completed||jsonb_build_object(v_key,0);CONTINUE;
    END IF;
    SELECT count(*) INTO v_total FROM private.employee_transfer_staging s WHERE s.job_id=p_job.id
      AND s.employee_id='00000000-0000-0000-0000-000000000000' AND s.table_key='archives-in:'||v_key;
    IF v_state#>ARRAY['chunks',v_key] IS DISTINCT FROM to_jsonb(v_total)
      OR jsonb_typeof(v_state#>ARRAY['completed_chunks',v_key]) IS DISTINCT FROM 'number'
      OR (v_state#>>ARRAY['completed_chunks',v_key]) !~ '^(0|[1-9][0-9]{0,5})$' THEN RAISE EXCEPTION 'Archive chunk progress changed.';END IF;
    v_done:=(v_state#>>ARRAY['completed_chunks',v_key])::integer;
    IF v_done>v_total OR (v_incomplete AND v_done<>0) THEN RAISE EXCEPTION 'Archive chunk progress is not a committed prefix.';END IF;
    IF v_done<>v_total THEN v_incomplete:=true;v_all:=false;END IF;
    SELECT COALESCE(sum(s.row_count),0) INTO v_expected FROM private.employee_transfer_staging s WHERE s.job_id=p_job.id
      AND s.employee_id='00000000-0000-0000-0000-000000000000' AND s.table_key='archives-in:'||v_key AND s.chunk_no<v_done;
    SELECT count(*) INTO v_actual FROM private.employee_transfer_archives_lines(p_job.id,v_key) s
      JOIN private.employee_transfer_archive_records r ON r.source_site_id=v_site AND r.package_id=v_package
        AND r.table_key=v_key AND r.source_id=s.id AND r.body=s.body
        AND convert_to(r.source_line,'UTF8')=convert_to(s.source_line,'UTF8') WHERE s.chunk_no<v_done;
    IF v_actual<>v_expected THEN RAISE EXCEPTION 'Committed archive chunk records differ.';END IF;
    IF v_done=v_total THEN
      SELECT count(*) INTO v_actual FROM private.employee_transfer_archive_records r
        WHERE r.source_site_id=v_site AND r.package_id=v_package AND r.table_key=v_key;
      IF to_jsonb(v_actual) IS DISTINCT FROM v_counts->v_key THEN RAISE EXCEPTION 'Completed archive record total differs.';END IF;
    END IF;
    v_chunks:=v_chunks||jsonb_build_object(v_key,v_total);v_completed:=v_completed||jsonb_build_object(v_key,v_done);
  END LOOP;
  IF v_verified AND NOT v_all THEN RAISE EXCEPTION 'Verified archive chunks are incomplete.';END IF;
  RETURN jsonb_build_object('scope','site-archives','started',v_started,'records_verified',v_verified,'counts',v_counts,
    'chunks',v_chunks,'completed_chunks',v_completed,'media_pending',true,'maintenance',true,'financial_data_pending',true,
    'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_persisted(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_state jsonb:=p_job.summary->'archives_restore';v_catalog jsonb;v_plan jsonb;v_counts jsonb:='{}';
  v_site uuid;v_package uuid;v_table jsonb;v_key text;v_rows bigint;v_bytes bigint;v_hash text;v_chunks integer;
BEGIN
  IF p_job.kind IS DISTINCT FROM 'import' OR p_job.options->>'import_protocol' IS DISTINCT FROM 'dispatch-submission-v1'
    OR NOT private.employee_transfer_exact_object(v_state,ARRAY['catalog','plan_hash','plan','initial_namespace_hash','namespace_hash','chunks','completed_chunks','records_verified'])
    OR v_state->'records_verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Verified archive namespace is required.';END IF;
  v_catalog:=v_state->'catalog';PERFORM private.employee_transfer_check_archives_catalog(v_catalog);
  IF v_catalog IS DISTINCT FROM p_job.summary->'archives_catalog' OR v_catalog->'site_id' IS DISTINCT FROM p_job.options#>'{catalog,site_id}'
    OR v_catalog->'package_id' IS DISTINCT FROM p_job.options->'package_id'
    OR NOT private.employee_transfer_exact_object(v_state->'chunks',private.employee_transfer_archives_keys())
    OR v_state->'completed_chunks' IS DISTINCT FROM v_state->'chunks'
    OR jsonb_typeof(v_state->'initial_namespace_hash') IS DISTINCT FROM 'string'
    OR (v_state->>'initial_namespace_hash') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Verified archive binding differs.';END IF;
  v_site:=(v_catalog->>'site_id')::uuid;v_package:=(v_catalog->>'package_id')::uuid;
  IF v_state->>'namespace_hash' IS DISTINCT FROM private.employee_transfer_archives_namespace_hash(v_site,v_package) THEN
    RAISE EXCEPTION 'Verified archive namespace changed.';
  END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(v_catalog->'tables') LOOP
    v_key:=v_table->>'key';
    IF jsonb_typeof(v_state#>ARRAY['chunks',v_key]) IS DISTINCT FROM 'number'
      OR (v_state#>>ARRAY['chunks',v_key]) !~ '^[1-9][0-9]{0,5}$' THEN RAISE EXCEPTION 'Verified archive chunk totals differ.';END IF;
    v_chunks:=(v_state#>>ARRAY['chunks',v_key])::integer;
    IF v_chunks>greatest(1,(v_table->>'rows')::integer) OR v_chunks<ceil((v_table->>'rows')::numeric/200) THEN
      RAISE EXCEPTION 'Verified archive chunk totals differ.';
    END IF;
    SELECT count(*),COALESCE(sum(octet_length(r.source_line)),0),
      encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(r.source_line,'UTF8'),'sha256'),'hex'),
        '' ORDER BY r.source_id COLLATE "C"),''),'UTF8'),'sha256'),'hex')
      INTO v_rows,v_bytes,v_hash FROM private.employee_transfer_archive_records r
      WHERE r.source_site_id=v_site AND r.package_id=v_package AND r.table_key=v_key;
    IF v_table->'rows' IS DISTINCT FROM to_jsonb(v_rows) OR v_table->'bytes' IS DISTINCT FROM to_jsonb(v_bytes)
      OR v_table->>'row_hashes_sha256' IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'Verified archive records differ.';END IF;
    IF EXISTS(SELECT 1 FROM private.employee_transfer_archive_records r WHERE r.source_site_id=v_site AND r.package_id=v_package
      AND r.table_key=v_key AND (right(r.source_line,1)<>E'\n' OR r.body IS DISTINCT FROM r.source_line::jsonb
        OR r.source_id IS DISTINCT FROM r.body->>'id')) THEN RAISE EXCEPTION 'Verified archive raw lines differ.';END IF;
    v_counts:=v_counts||jsonb_build_object(v_key,v_rows);
  END LOOP;
  v_plan:=jsonb_build_object('scope','site-archives','checked',true,'can_restore',true,'counts',v_counts,'conflicts','[]'::jsonb,
    'media_pending',true,'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('job_id',p_job.id,'catalog',v_catalog,
    'namespace_hash',v_state->>'initial_namespace_hash','plan',v_plan)::text,'UTF8'),'sha256'),'hex');
  IF v_state->'plan' IS DISTINCT FROM v_plan OR v_state->>'plan_hash' IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'Verified archive plan differs.';END IF;
END;
$$;

CREATE FUNCTION public.get_employee_import_archives_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  RETURN private.employee_transfer_archives_plan(private.employee_transfer_notification_job(p_admin_session_token,p_job_token));
END;
$$;

CREATE FUNCTION public.employee_import_archives_begin(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_plan jsonb;v_status jsonb;v_chunks jsonb:='{}';v_completed jsonb:='{}';
  v_key text;v_total integer;v_namespace text;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  LOCK TABLE private.employee_transfer_archive_records IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance',0));
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_maintenance WHERE singleton AND job_id=v_job.id FOR UPDATE;
  v_status:=private.employee_transfer_archives_status(v_job);
  IF v_job.summary ? 'archives_restore' THEN
    IF p_plan_hash IS DISTINCT FROM v_job.summary#>>'{archives_restore,plan_hash}' THEN RAISE EXCEPTION 'Archive restore plan differs.';END IF;
    RETURN v_status;
  END IF;
  v_plan:=private.employee_transfer_archives_plan(v_job);
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_plan->>'plan_hash' OR v_plan->'can_restore' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'A current conflict-free archive plan is required.';
  END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_archives_keys() LOOP
    SELECT count(*) INTO v_total FROM private.employee_transfer_staging s WHERE s.job_id=v_job.id
      AND s.employee_id='00000000-0000-0000-0000-000000000000' AND s.table_key='archives-in:'||v_key;
    v_chunks:=v_chunks||jsonb_build_object(v_key,v_total);v_completed:=v_completed||jsonb_build_object(v_key,0);
  END LOOP;
  v_namespace:=private.employee_transfer_archives_namespace_hash((v_job.summary#>>'{archives_catalog,site_id}')::uuid,
    (v_job.summary#>>'{archives_catalog,package_id}')::uuid);
  v_job.summary:=v_job.summary||jsonb_build_object('archives_restore',jsonb_build_object('catalog',v_job.summary->'archives_catalog',
    'plan_hash',p_plan_hash,'plan',v_plan-'plan_hash','initial_namespace_hash',v_namespace,'namespace_hash',v_namespace,
    'chunks',v_chunks,'completed_chunks',v_completed,'records_verified',false));
  v_status:=private.employee_transfer_archives_status(v_job);
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary,last_activity_at=now() WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','archives_restore_started',
    jsonb_build_object('counts',v_status->'counts','media_pending',true,'full_site_complete',false));
  RETURN v_status;
END;
$$;

CREATE FUNCTION public.employee_import_archives_chunk(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_status jsonb;v_state jsonb;v_key text;v_site uuid;v_package uuid;v_done integer;v_total integer;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  LOCK TABLE private.employee_transfer_archive_records IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance',0));
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_maintenance WHERE singleton AND job_id=v_job.id FOR UPDATE;
  v_status:=private.employee_transfer_archives_status(v_job);
  IF v_status->'started' IS DISTINCT FROM 'true'::jsonb OR p_table_key IS NULL
    OR NOT p_table_key=ANY(private.employee_transfer_archives_keys()) OR p_chunk_no IS NULL OR p_chunk_no<0 THEN
    RAISE EXCEPTION 'Invalid archive restore chunk.';
  END IF;
  v_state:=v_job.summary->'archives_restore';v_done:=(v_state#>>ARRAY['completed_chunks',p_table_key])::integer;
  v_total:=(v_state#>>ARRAY['chunks',p_table_key])::integer;
  IF p_chunk_no>=v_total THEN RAISE EXCEPTION 'Invalid archive restore chunk.';END IF;
  IF p_chunk_no<v_done THEN RETURN v_status;END IF;
  IF p_chunk_no<>v_done THEN RAISE EXCEPTION 'Archive chunks must be restored in order.';END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_archives_keys() LOOP
    EXIT WHEN v_key=p_table_key;
    IF v_state#>ARRAY['completed_chunks',v_key] IS DISTINCT FROM v_state#>ARRAY['chunks',v_key] THEN
      RAISE EXCEPTION 'Archive tables must be restored in order.';
    END IF;
  END LOOP;
  v_site:=(v_state#>>'{catalog,site_id}')::uuid;v_package:=(v_state#>>'{catalog,package_id}')::uuid;
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names)
    VALUES(pg_current_xact_id(),v_job.id,ARRAY['private.employee_transfer_archive_records']);
  INSERT INTO private.employee_transfer_archive_records(source_site_id,package_id,table_key,source_id,body,source_line,job_id)
    SELECT v_site,v_package,p_table_key,s.id,s.body,s.source_line,v_job.id FROM private.employee_transfer_archives_lines(v_job.id,p_table_key) s
    WHERE s.chunk_no=p_chunk_no AND NOT EXISTS(SELECT 1 FROM private.employee_transfer_archive_records r
      WHERE r.source_site_id=v_site AND r.package_id=v_package AND r.table_key=p_table_key AND r.source_id=s.id)
    ORDER BY s.id COLLATE "C";
  PERFORM private.employee_transfer_clear_write_permit();
  v_state:=jsonb_set(v_state,ARRAY['completed_chunks',p_table_key],to_jsonb(v_done+1));
  v_state:=jsonb_set(v_state,'{namespace_hash}',to_jsonb(private.employee_transfer_archives_namespace_hash(v_site,v_package)));
  v_job.summary:=jsonb_set(v_job.summary,'{archives_restore}',v_state);
  v_status:=private.employee_transfer_archives_status(v_job);
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary,last_activity_at=now() WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','archives_chunk_restored',
    jsonb_build_object('table_key',p_table_key,'chunk_no',p_chunk_no,'media_pending',true,'full_site_complete',false));
  RETURN v_status;
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit();RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_archives_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_status jsonb;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  LOCK TABLE private.employee_transfer_archive_records IN SHARE ROW EXCLUSIVE MODE;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance',0));
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_maintenance WHERE singleton AND job_id=v_job.id FOR UPDATE;
  v_status:=private.employee_transfer_archives_status(v_job);
  IF v_status->'started' IS DISTINCT FROM 'true'::jsonb OR v_status->'chunks' IS DISTINCT FROM v_status->'completed_chunks' THEN
    RAISE EXCEPTION 'Archive restore chunks are incomplete.';
  END IF;
  IF v_status->'records_verified'='true'::jsonb THEN
    PERFORM private.employee_transfer_archives_persisted(v_job);RETURN v_status;
  END IF;
  v_job.summary:=jsonb_set(v_job.summary,'{archives_restore,records_verified}','true'::jsonb);
  v_status:=private.employee_transfer_archives_status(v_job);PERFORM private.employee_transfer_archives_persisted(v_job);
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary,last_activity_at=now() WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','archives_records_verified',
    jsonb_build_object('counts',v_status->'counts','media_pending',true,'full_site_complete',false));
  RETURN v_status;
END;
$$;

CREATE FUNCTION public.get_employee_import_archives_status(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  RETURN private.employee_transfer_archives_status(private.employee_transfer_notification_job(p_admin_session_token,p_job_token));
END;
$$;

CREATE FUNCTION public.get_employee_transferred_archive_page(p_admin_session_token uuid,p_source_site_id uuid,p_package_id uuid,
  p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_row record;v_text text:='';v_count integer:=0;v_cursor text;v_more boolean:=false;
BEGIN
  PERFORM private.employee_transfer_admin(p_admin_session_token);
  IF p_source_site_id IS NULL OR p_package_id IS NULL OR p_table_key IS NULL
    OR NOT p_table_key=ANY(private.employee_transfer_archives_keys()) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
    OR (p_after IS NOT NULL AND length(p_after)>73) THEN RAISE EXCEPTION 'Invalid transferred archive page.';END IF;
  SELECT * INTO v_job FROM private.employee_transfer_jobs j WHERE j.kind='import'
    AND j.options->>'import_protocol'='dispatch-submission-v1' AND j.summary#>'{archives_restore,records_verified}'='true'::jsonb
    AND j.summary#>'{archives_restore,catalog,site_id}'=to_jsonb(p_source_site_id)
    AND j.summary#>'{archives_restore,catalog,package_id}'=to_jsonb(p_package_id)
    ORDER BY j.started_at DESC,j.id LIMIT 1;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Verified archive namespace is required.';END IF;
  PERFORM private.employee_transfer_archives_persisted(v_job);
  IF p_after IS NOT NULL AND NOT EXISTS(SELECT 1 FROM private.employee_transfer_archive_records r
    WHERE r.source_site_id=p_source_site_id AND r.package_id=p_package_id AND r.table_key=p_table_key
      AND r.source_id COLLATE "C"=p_after COLLATE "C") THEN RAISE EXCEPTION 'Transferred archive cursor is not canonical.';END IF;
  FOR v_row IN SELECT r.source_id,r.source_line FROM private.employee_transfer_archive_records r
    WHERE r.source_site_id=p_source_site_id AND r.package_id=p_package_id AND r.table_key=p_table_key
      AND (p_after IS NULL OR r.source_id COLLATE "C">p_after COLLATE "C")
    ORDER BY r.source_id COLLATE "C" LIMIT p_limit+1 LOOP
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_row.source_line)>262144 THEN v_more:=true;EXIT;END IF;
    v_text:=v_text||v_row.source_line;v_count:=v_count+1;v_cursor:=v_row.source_id;
  END LOOP;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_text,
    'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_archives_lines(uuid,text),
  private.employee_transfer_archives_namespace_hash(uuid,uuid),
  private.employee_transfer_archives_conflicts(private.employee_transfer_jobs),
  private.employee_transfer_archives_plan(private.employee_transfer_jobs),
  private.employee_transfer_archives_status(private.employee_transfer_jobs),
  private.employee_transfer_archives_persisted(private.employee_transfer_jobs)
  FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION public.get_employee_import_archives_plan(uuid,uuid),
  public.employee_import_archives_begin(uuid,uuid,text),public.employee_import_archives_chunk(uuid,uuid,text,integer),
  public.employee_import_archives_verify(uuid,uuid),public.get_employee_import_archives_status(uuid,uuid),
  public.get_employee_transferred_archive_page(uuid,uuid,uuid,text,text,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_import_archives_plan(uuid,uuid),
  public.employee_import_archives_begin(uuid,uuid,text),public.employee_import_archives_chunk(uuid,uuid,text,integer),
  public.employee_import_archives_verify(uuid,uuid),public.get_employee_import_archives_status(uuid,uuid),
  public.get_employee_transferred_archive_page(uuid,uuid,uuid,text,text,integer)
  TO anon,authenticated;

NOTIFY pgrst,'reload schema';
COMMIT;
