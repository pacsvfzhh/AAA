CREATE OR REPLACE FUNCTION private.employee_transfer_job(p_session uuid, p_job_token uuid, p_kind text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_job private.employee_transfer_jobs%ROWTYPE; v_kind text;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_session) AS admin;
  v_kind := CASE p_kind WHEN 'shared-import' THEN 'import' WHEN 'products-import' THEN 'import'
    WHEN 'products-export' THEN 'export' ELSE p_kind END;
  IF p_job_token IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.'; END IF;
  UPDATE private.employee_transfer_jobs SET last_activity_at = now()
  WHERE token_hash = private.hash_financial_token(p_job_token) AND kind = v_kind
    AND admin_id = v_admin AND status = 'running'
    AND last_activity_at > now() - interval '3 hours' AND started_at > now() - interval '12 hours'
  RETURNING * INTO v_job;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.'; END IF;
  IF (v_job.options->>'import_protocol' = 'shared-import-v1' AND p_kind <> 'shared-import')
    OR (p_kind = 'shared-import' AND v_job.options->>'import_protocol' IS DISTINCT FROM 'shared-import-v1')
    OR (v_job.options->>'import_protocol' = 'products-v1' AND p_kind <> 'products-import')
    OR (p_kind = 'products-import' AND v_job.options->>'import_protocol' IS DISTINCT FROM 'products-v1')
    OR (v_job.options->>'export_protocol' = 'products-v1' AND p_kind <> 'products-export')
    OR (p_kind = 'products-export' AND v_job.options->>'export_protocol' IS DISTINCT FROM 'products-v1') THEN
    RAISE EXCEPTION 'The task protocol does not permit this operation.';
  END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION private.employee_transfer_product_schema()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_columns jsonb;
BEGIN
  SELECT jsonb_object_agg(attname, format_type(atttypid, atttypmod)) INTO v_columns
  FROM pg_attribute WHERE attrelid = 'public.product_types'::regclass AND attnum > 0 AND NOT attisdropped;
  IF v_columns IS DISTINCT FROM '{"id":"uuid","name":"text","is_active":"boolean","sort_order":"integer","created_at":"timestamp with time zone","updated_at":"timestamp with time zone"}'::jsonb THEN
    RAISE EXCEPTION 'Unreviewed product catalog schema; transfer blocked.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_product_rows(p_rows jsonb)
RETURNS void LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, public, private, pg_temp SET timezone = 'UTC' SET datestyle = 'ISO, YMD' AS $$
DECLARE v_row jsonb; v_key text; v_timestamp timestamptz;
BEGIN
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) > 10000 THEN
    RAISE EXCEPTION 'Invalid product catalog rows.';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF NOT private.employee_transfer_exact_object(v_row, ARRAY['id','name','is_active','sort_order','created_at','updated_at'])
      OR jsonb_typeof(v_row->'id') IS DISTINCT FROM 'string'
      OR (v_row->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR jsonb_typeof(v_row->'name') IS DISTINCT FROM 'string'
      OR nullif(btrim(v_row->>'name'), '') IS NULL
      OR jsonb_typeof(v_row->'is_active') NOT IN ('boolean','null')
      OR jsonb_typeof(v_row->'sort_order') IS DISTINCT FROM 'number'
      OR (v_row->>'sort_order') !~ '^-?(0|[1-9][0-9]{0,9})$'
      OR (v_row->>'sort_order')::numeric NOT BETWEEN -2147483648 AND 2147483647
      OR octet_length(v_row::text || E'\n') > 65536 THEN
      RAISE EXCEPTION 'Invalid product catalog row.';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['created_at','updated_at'] LOOP
      IF v_row->v_key <> 'null'::jsonb THEN
        IF jsonb_typeof(v_row->v_key) IS DISTINCT FROM 'string'
          OR (v_row->>v_key) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
          RAISE EXCEPTION 'Invalid product catalog timestamp.';
        END IF;
        BEGIN
          v_timestamp := (v_row->>v_key)::timestamptz;
          IF NOT isfinite(v_timestamp) THEN RAISE EXCEPTION 'Invalid timestamp'; END IF;
        EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid product catalog timestamp.' USING ERRCODE = '22023';
        END;
      END IF;
    END LOOP;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) GROUP BY value->>'id' HAVING count(*) > 1)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) GROUP BY (value->>'name') COLLATE "C" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate product catalog identity.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_product_snapshot()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone = 'UTC' SET datestyle = 'ISO, YMD' AS $$
DECLARE v_rows jsonb; v_text text; v_count integer; v_bytes bigint;
BEGIN
  PERFORM private.employee_transfer_product_schema();
  SELECT count(*)::integer, COALESCE(sum(octet_length(body::text || E'\n')),0) INTO v_count,v_bytes
  FROM (SELECT jsonb_build_object('id',id,'name',name,'is_active',is_active,'sort_order',sort_order,
    'created_at',created_at,'updated_at',updated_at) AS body FROM public.product_types) AS products;
  IF v_count > 10000 OR v_bytes > 8388608 THEN RAISE EXCEPTION 'Product catalog exceeds transfer limits.'; END IF;
  SELECT COALESCE(jsonb_agg(body ORDER BY body->>'id' COLLATE "C"),'[]'::jsonb),
    COALESCE(string_agg(body::text || E'\n','' ORDER BY body->>'id' COLLATE "C"),'') INTO v_rows,v_text
  FROM (SELECT jsonb_build_object('id',id,'name',name,'is_active',is_active,'sort_order',sort_order,
    'created_at',created_at,'updated_at',updated_at) AS body FROM public.product_types) AS products;
  PERFORM private.employee_transfer_check_product_rows(v_rows);
  RETURN jsonb_build_object('rows',v_rows,'count',v_count,'bytes',octet_length(v_text),'ndjson',v_text,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_transfer_product_catalog(p_snapshot jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object('version',1,'scope','product-catalog','site_id',site_id,'full_site_complete',false,
    'tables',jsonb_build_array(jsonb_build_object('key','product_types','rows',p_snapshot->'count',
      'bytes',p_snapshot->'bytes','sha256',p_snapshot->'sha256'))) FROM private.employee_transfer_site;
$$;

CREATE FUNCTION private.employee_transfer_check_product_catalog(p_catalog jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table jsonb;
BEGIN
  IF p_catalog IS NULL OR octet_length(p_catalog::text)>4096
    OR NOT private.employee_transfer_exact_object(p_catalog,ARRAY['version','scope','site_id','tables','full_site_complete'])
    OR p_catalog->'version' IS DISTINCT FROM '1'::jsonb OR p_catalog->>'scope' IS DISTINCT FROM 'product-catalog'
    OR p_catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(p_catalog->'site_id') IS DISTINCT FROM 'string'
    OR (p_catalog->>'site_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_catalog->'tables') IS DISTINCT FROM 'array' OR jsonb_array_length(p_catalog->'tables') <> 1 THEN
    RAISE EXCEPTION 'Invalid product catalog descriptor.';
  END IF;
  v_table:=p_catalog->'tables'->0;
  IF NOT private.employee_transfer_exact_object(v_table,ARRAY['key','rows','bytes','sha256'])
    OR v_table->>'key' IS DISTINCT FROM 'product_types'
    OR jsonb_typeof(v_table->'rows') IS DISTINCT FROM 'number' OR (v_table->>'rows') !~ '^(0|[1-9][0-9]{0,4})$'
    OR jsonb_typeof(v_table->'bytes') IS DISTINCT FROM 'number' OR (v_table->>'bytes') !~ '^(0|[1-9][0-9]{0,6})$'
    OR (v_table->>'rows')::integer > 10000 OR (v_table->>'bytes')::integer > 8388608
    OR jsonb_typeof(v_table->'sha256') IS DISTINCT FROM 'string' OR (v_table->>'sha256') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid product catalog table descriptor.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_product_page(p_snapshot jsonb,p_after text,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_row jsonb; v_line text; v_text text:=''; v_count integer:=0; v_cursor text; v_more boolean:=false;
BEGIN
  IF p_snapshot IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid product page request.'; END IF;
  IF p_after IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_snapshot->'rows') WHERE value->>'id'=p_after) THEN
    RAISE EXCEPTION 'Invalid product page cursor.';
  END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_snapshot->'rows')
    WHERE p_after IS NULL OR (value->>'id') COLLATE "C">p_after COLLATE "C" ORDER BY value->>'id' COLLATE "C" LOOP
    v_line:=v_row::text||E'\n';
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_line)>262144 THEN v_more:=true; EXIT; END IF;
    v_text:=v_text||v_line; v_count:=v_count+1; v_cursor:=v_row->>'id';
  END LOOP;
  RETURN jsonb_build_object('table_key','product_types','count',v_count,'ndjson',v_text,'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_export_products_begin(p_admin_session_token uuid,p_admin_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_begin jsonb; v_snapshot jsonb; v_catalog jsonb;
BEGIN
  v_begin:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'export','{"export_protocol":"products-v1","scope":"product-catalog"}');
  IF NOT COALESCE((v_begin->>'success')::boolean,false) THEN RETURN v_begin; END IF;
  v_snapshot:=private.employee_transfer_product_snapshot(); v_catalog:=private.employee_transfer_product_catalog(v_snapshot);
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
  VALUES((v_begin->>'job_id')::uuid,'00000000-0000-0000-0000-000000000000','products-export',0,(v_snapshot->>'count')::integer,v_snapshot);
  UPDATE private.employee_transfer_jobs SET summary=jsonb_build_object('product_catalog',v_catalog) WHERE id=(v_begin->>'job_id')::uuid;
  RETURN (v_begin-'server_time')||jsonb_build_object('catalog',v_catalog,'scope','product-catalog','full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_export_products_page(p_admin_session_token uuid,p_job_token uuid,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_snapshot jsonb;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'products-export');
  SELECT payload INTO v_snapshot FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='products-export' AND chunk_no=0;
  RETURN private.employee_transfer_product_page(v_snapshot,p_after,p_limit);
END;
$$;

CREATE FUNCTION public.employee_export_products_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_expected jsonb; v_actual jsonb;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'products-export');
  SELECT payload INTO v_expected FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='products-export' AND chunk_no=0;
  v_actual:=private.employee_transfer_product_snapshot();
  IF v_expected IS NULL OR v_expected IS DISTINCT FROM v_actual THEN RAISE EXCEPTION 'Product source changed; restart the export.'; END IF;
  UPDATE private.employee_transfer_jobs SET summary=COALESCE(summary,'{}')||'{"products_verified":true}'::jsonb WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'export','products_verified','{"scope":"product-catalog","full_site_complete":false}');
  RETURN '{"verified":true,"scope":"product-catalog","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_import_products_begin(p_admin_session_token uuid,p_admin_password text,p_package_id uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  PERFORM private.employee_transfer_check_product_catalog(p_catalog);
  IF p_package_id IS NULL OR (p_catalog->>'site_id')::uuid=(SELECT site_id FROM private.employee_transfer_site) THEN RAISE EXCEPTION 'Invalid product import source identity.'; END IF;
  v_result:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'import',jsonb_build_object(
    'import_protocol','products-v1','scope','product-catalog','package_id',p_package_id,'catalog',p_catalog));
  RETURN (v_result-ARRAY['site_id','server_time'])||'{"scope":"product-catalog","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_import_products_stage(p_admin_session_token uuid,p_job_token uuid,p_chunk_no integer,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_line text; v_json json; v_rows jsonb:='[]'; v_count integer:=0;
  v_previous jsonb; v_bytes bigint; v_total bigint; v_count_total bigint; v_hash text;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'products-import');
  IF COALESCE((v_job.summary->>'products_applied')::boolean,false) OR EXISTS(SELECT 1 FROM private.employee_transfer_shared_backups WHERE id=v_job.id) THEN
    RAISE EXCEPTION 'The frozen product import no longer accepts chunks.';
  END IF;
  IF p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 10000 OR p_ndjson IS NULL OR octet_length(p_ndjson)>262144
    OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN RAISE EXCEPTION 'Invalid product import chunk.'; END IF;
  IF p_ndjson<>'' THEN
    FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS item(line) LOOP
      IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Product row exceeds the limit.'; END IF;
      BEGIN
        v_json:=v_line::json;
        IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN RAISE EXCEPTION 'Invalid row'; END IF;
        v_rows:=v_rows||jsonb_build_array(v_json::jsonb);
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid product import JSON row.' USING ERRCODE='22023';
      END;
      v_count:=v_count+1;
    END LOOP;
  END IF;
  IF v_count>200 OR (v_count=0 AND p_chunk_no<>0) THEN RAISE EXCEPTION 'Invalid product chunk row count.'; END IF;
  PERFORM private.employee_transfer_check_product_rows(v_rows);
  v_bytes:=octet_length(p_ndjson); v_hash:=encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex');
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='products-import' AND chunk_no=p_chunk_no;
  IF v_previous IS NOT NULL THEN
    IF v_previous->>'ndjson' IS DISTINCT FROM p_ndjson THEN RAISE EXCEPTION 'Product chunk identity has different contents.'; END IF;
    RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',v_bytes,'sha256',v_hash,'repeated',true);
  END IF;
  SELECT count(*),COALESCE(sum(row_count),0)+v_count,COALESCE(sum((payload->>'bytes')::integer),0)+v_bytes
    INTO v_total,v_count_total,v_bytes FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='products-import';
  IF v_total<>p_chunk_no OR v_count_total>(v_job.options#>>'{catalog,tables,0,rows}')::integer OR v_bytes>(v_job.options#>>'{catalog,tables,0,bytes}')::integer THEN
    RAISE EXCEPTION 'Product chunk exceeds its bound catalog or is not contiguous.';
  END IF;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','products-import',p_chunk_no,v_count,jsonb_build_object('ndjson',p_ndjson,'bytes',octet_length(p_ndjson),'sha256',v_hash));
  RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_product_input(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_text text; v_rows jsonb; v_table jsonb; v_previous text; v_row jsonb;
BEGIN
  PERFORM private.employee_transfer_check_product_catalog(p_job.options->'catalog');
  SELECT string_agg(payload->>'ndjson','' ORDER BY chunk_no) INTO v_text FROM private.employee_transfer_staging
    WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='products-import';
  IF v_text IS NULL THEN RAISE EXCEPTION 'Product import chunks are missing.'; END IF;
  v_table:=p_job.options#>'{catalog,tables,0}';
  IF octet_length(v_text)<>(v_table->>'bytes')::integer OR encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM v_table->>'sha256' THEN
    RAISE EXCEPTION 'Product import catalog hash or size mismatch.';
  END IF;
  SELECT COALESCE(jsonb_agg(line::jsonb ORDER BY ordinal),'[]'::jsonb) INTO v_rows
    FROM unnest(string_to_array(CASE WHEN v_text='' THEN NULL ELSE left(v_text,length(v_text)-1) END,E'\n')) WITH ORDINALITY AS item(line,ordinal);
  IF jsonb_array_length(v_rows)<>(v_table->>'rows')::integer THEN RAISE EXCEPTION 'Product import row count mismatch.'; END IF;
  PERFORM private.employee_transfer_check_product_rows(v_rows);
  FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
    IF v_previous IS NOT NULL AND v_previous COLLATE "C">=(v_row->>'id') COLLATE "C" THEN RAISE EXCEPTION 'Product rows must be strictly ordered by identity.'; END IF;
    v_previous:=v_row->>'id';
  END LOOP;
  RETURN v_rows;
END;
$$;

CREATE FUNCTION private.employee_transfer_product_plan(p_job private.employee_transfer_jobs,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_source jsonb; v_target public.product_types%ROWTYPE; v_id uuid; v_map jsonb:='{}';
  v_conflicts jsonb:='[]'; v_records jsonb:='[]'; v_plan jsonb; v_snapshot jsonb;
BEGIN
  v_snapshot:=private.employee_transfer_product_snapshot();
  FOR v_source IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    SELECT * INTO v_target FROM public.product_types WHERE name=v_source->>'name';
    v_id:=COALESCE(v_target.id,(v_source->>'id')::uuid);
    IF EXISTS(SELECT 1 FROM public.product_types WHERE id=(v_source->>'id')::uuid AND (v_target.id IS NULL OR id<>v_target.id)) THEN
      v_conflicts:=v_conflicts||jsonb_build_array(jsonb_build_object('source_id',v_source->'id','reason','product_id_conflict'));
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_each_text(v_map) WHERE value=v_id::text) THEN
      v_conflicts:=v_conflicts||jsonb_build_array(jsonb_build_object('source_id',v_source->'id','reason','mapped_product_collision'));
    END IF;
    v_map:=v_map||jsonb_build_object(v_source->>'id',v_id);
    v_records:=v_records||jsonb_build_array(jsonb_build_object('source_id',v_source->'id','target_id',v_id,'action',CASE WHEN v_target.id IS NULL THEN 'create' ELSE 'replace' END));
  END LOOP;
  v_plan:=jsonb_build_object('scope','product-catalog','full_site_complete',false,'can_apply',jsonb_array_length(v_conflicts)=0,
    'records',v_records,'conflicts',v_conflicts,'product_map',v_map,'catalog',p_job.options->'catalog','package_id',p_job.options->'package_id',
    'target_hash',encode(extensions.digest(convert_to(v_snapshot::text,'UTF8'),'sha256'),'hex'));
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(v_plan::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.get_employee_import_products_dry_run(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_plan jsonb; v_snapshot jsonb; v_backup private.employee_transfer_shared_backups%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'products-import');
  IF COALESCE((v_job.summary->>'products_applied')::boolean,false) THEN RAISE EXCEPTION 'Product import already applied.'; END IF;
  LOCK TABLE public.product_types IN SHARE MODE;
  v_plan:=private.employee_transfer_product_plan(v_job,private.employee_transfer_product_input(v_job));
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id;
  IF v_backup.id IS NOT NULL AND v_backup.plan_hash IS DISTINCT FROM v_plan->>'plan_hash' THEN RAISE EXCEPTION 'Product target changed after backup preparation; restart the task.'; END IF;
  IF (v_plan->>'can_apply')::boolean AND v_backup.id IS NULL THEN
    v_snapshot:=private.employee_transfer_product_snapshot();
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','products-backup',0,(v_snapshot->>'count')::integer,v_snapshot);
    INSERT INTO private.employee_transfer_shared_backups(id,admin_id,plan_hash,target_hash,catalog)
      VALUES(v_job.id,v_job.admin_id,v_plan->>'plan_hash',v_plan->>'target_hash',private.employee_transfer_product_catalog(v_snapshot));
  END IF;
  UPDATE private.employee_transfer_jobs SET summary=COALESCE(summary,'{}')||jsonb_build_object('products_plan_hash',v_plan->'plan_hash') WHERE id=v_job.id;
  RETURN v_plan-ARRAY['product_map','catalog','package_id','target_hash'];
END;
$$;

CREATE FUNCTION public.get_employee_import_products_backup(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'products-import');
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id;
  IF v_backup.id IS NULL THEN RAISE EXCEPTION 'A conflict-free product dry run is required.'; END IF;
  RETURN jsonb_build_object('backup_id',v_backup.id,'plan_hash',v_backup.plan_hash,'target_hash',v_backup.target_hash,'catalog',v_backup.catalog);
END;
$$;

CREATE FUNCTION public.get_employee_import_products_backup_page(p_admin_session_token uuid,p_job_token uuid,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_snapshot jsonb;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'products-import');
  SELECT payload INTO v_snapshot FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='products-backup' AND chunk_no=0;
  RETURN private.employee_transfer_product_page(v_snapshot,p_after,p_limit);
END;
$$;

CREATE FUNCTION public.employee_import_products_backup_append(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text,p_chunk_no integer,p_hex text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE; v_chunk bytea; v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'products-import');
  IF p_hex IS NULL OR length(p_hex) NOT BETWEEN 2 AND 262144 OR length(p_hex)%2<>0 OR p_hex!~'^[0-9a-f]+$'
    OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 1023 THEN RAISE EXCEPTION 'Invalid encrypted product backup chunk.'; END IF;
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id FOR UPDATE;
  IF v_backup.id IS NULL OR p_plan_hash IS DISTINCT FROM v_backup.plan_hash OR v_backup.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'The product backup does not accept encrypted chunks.'; END IF;
  v_chunk:=decode(p_hex,'hex');
  IF p_chunk_no>cardinality(v_backup.chunks) THEN RAISE EXCEPTION 'Backup chunks must be contiguous.'; END IF;
  v_repeated:=p_chunk_no<cardinality(v_backup.chunks);
  IF v_repeated THEN
    IF v_backup.chunks[p_chunk_no+1] IS DISTINCT FROM v_chunk THEN RAISE EXCEPTION 'Encrypted backup chunk identity has different contents.'; END IF;
  ELSE
    IF v_backup.byte_count+octet_length(v_chunk)>9437184 THEN RAISE EXCEPTION 'Encrypted backup exceeds the limit.'; END IF;
    UPDATE private.employee_transfer_shared_backups SET chunks=array_append(chunks,v_chunk),byte_count=byte_count+octet_length(v_chunk) WHERE id=v_job.id;
  END IF;
  RETURN jsonb_build_object('success',true,'bytes',octet_length(v_chunk),'sha256',encode(extensions.digest(v_chunk,'sha256'),'hex'),'repeated',v_repeated);
END;
$$;

CREATE FUNCTION public.employee_import_products_backup_seal(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text,p_sha256 text,p_bytes integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE; v_cipher bytea; v_hash text; v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'products-import');
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id FOR UPDATE;
  IF v_backup.id IS NULL OR p_plan_hash IS DISTINCT FROM v_backup.plan_hash OR p_bytes IS NULL OR p_sha256 IS NULL OR p_sha256!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid product backup seal request.'; END IF;
  SELECT string_agg(chunk,''::bytea ORDER BY ordinal) INTO v_cipher FROM unnest(v_backup.chunks) WITH ORDINALITY AS item(chunk,ordinal);
  v_hash:=encode(extensions.digest(v_cipher,'sha256'),'hex');
  IF v_backup.byte_count<>p_bytes OR p_bytes<64 OR substring(v_cipher FROM 1 FOR 8) IS DISTINCT FROM convert_to('EDXSTRM1','UTF8') OR v_hash IS DISTINCT FROM p_sha256 THEN
    RAISE EXCEPTION 'The encrypted product backup does not match its seal.';
  END IF;
  v_repeated:=v_backup.sealed_at IS NOT NULL;
  UPDATE private.employee_transfer_shared_backups SET sealed_sha256=v_hash,sealed_at=COALESCE(sealed_at,clock_timestamp()) WHERE id=v_job.id;
  RETURN jsonb_build_object('success',true,'backup_id',v_backup.id,'sha256',v_hash,'bytes',p_bytes,'repeated',v_repeated,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_products_saved_backup_chunk(p_admin_session_token uuid,p_backup_id uuid,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_backup private.employee_transfer_shared_backups%ROWTYPE; v_chunk bytea;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_admin_session_token) AS admin;
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=p_backup_id AND admin_id=v_admin AND sealed_at IS NOT NULL AND catalog->>'scope'='product-catalog';
  IF v_backup.id IS NULL OR p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>=cardinality(v_backup.chunks) THEN RAISE EXCEPTION 'The saved product backup or chunk is unavailable.'; END IF;
  v_chunk:=v_backup.chunks[p_chunk_no+1];
  RETURN jsonb_build_object('backup_id',v_backup.id,'chunk_no',p_chunk_no,'hex',encode(v_chunk,'hex'),'sha256',v_backup.sealed_sha256,'bytes',v_backup.byte_count,'chunks',cardinality(v_backup.chunks));
END;
$$;

CREATE FUNCTION private.employee_transfer_assert_product_triggers()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_count integer; v_invalid boolean;
BEGIN
  SELECT count(*)::integer,COALESCE(bool_or(trigger.tgname<>'assign_product_type_sort_order' OR trigger.tgenabled NOT IN ('O','A')
    OR pg_get_triggerdef(trigger.oid) IS DISTINCT FROM 'CREATE TRIGGER assign_product_type_sort_order BEFORE INSERT ON public.product_types FOR EACH ROW EXECUTE FUNCTION assign_product_type_sort_order()'
    OR procedure.pronamespace<>'private'::regnamespace OR pg_get_userbyid(procedure.proowner)<>'postgres'
    OR procedure.prosecdef IS DISTINCT FROM true OR procedure.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
    OR procedure.proconfig IS DISTINCT FROM ARRAY['search_path=public, private, pg_temp']::text[]
    OR procedure.prosrc IS DISTINCT FROM E'\nBEGIN\n  IF NEW.sort_order <= 0 THEN\n    PERFORM pg_advisory_xact_lock(hashtext(\'public.product_types.sort_order\'));\n\n    SELECT COALESCE(MAX(product_type.sort_order), 0) + 1\n    INTO NEW.sort_order\n    FROM public.product_types AS product_type;\n  END IF;\n\n  RETURN NEW;\nEND;\n'),false) INTO v_count,v_invalid
  FROM pg_trigger AS trigger JOIN pg_proc AS procedure ON procedure.oid=trigger.tgfoid WHERE trigger.tgrelid='public.product_types'::regclass AND NOT trigger.tgisinternal;
  IF v_count<>1 OR v_invalid THEN RAISE EXCEPTION 'An unreviewed product write trigger prevents import.'; END IF;
END;
$$;

CREATE FUNCTION public.employee_import_products_apply(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone = 'UTC' SET datestyle = 'ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE;
  v_rows jsonb; v_plan jsonb; v_row jsonb; v_id uuid; v_receipt jsonb;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'products-import');
  IF COALESCE((v_job.summary->>'products_applied')::boolean,false) THEN
    IF p_plan_hash IS DISTINCT FROM v_job.summary->>'products_plan_hash' THEN RAISE EXCEPTION 'Product confirmation does not match.'; END IF;
    RETURN v_job.summary->'products_receipt'||'{"repeated":true}'::jsonb;
  END IF;
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_job.summary->>'products_plan_hash' THEN RAISE EXCEPTION 'A product dry run must be confirmed first.'; END IF;
  LOCK TABLE public.product_types IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id FOR UPDATE;
  IF v_backup.id IS NULL OR v_backup.sealed_at IS NULL OR v_backup.plan_hash IS DISTINCT FROM p_plan_hash THEN RAISE EXCEPTION 'A saved and sealed product backup is required.'; END IF;
  PERFORM private.employee_transfer_product_schema();
  PERFORM private.employee_transfer_assert_product_triggers();
  v_rows:=private.employee_transfer_product_input(v_job); v_plan:=private.employee_transfer_product_plan(v_job,v_rows);
  IF v_plan->>'plan_hash' IS DISTINCT FROM p_plan_hash OR v_plan->>'target_hash' IS DISTINCT FROM v_backup.target_hash THEN RAISE EXCEPTION 'Product target changed after backup; restart the task.'; END IF;
  IF NOT (v_plan->>'can_apply')::boolean THEN RAISE EXCEPTION 'Product conflicts must be resolved first.'; END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
    v_id:=(v_plan->'product_map'->>(v_row->>'id'))::uuid;
    IF EXISTS(SELECT 1 FROM public.product_types WHERE id=v_id) THEN
      UPDATE public.product_types SET name=v_row->>'name',is_active=(v_row->>'is_active')::boolean,sort_order=(v_row->>'sort_order')::integer,
        created_at=(v_row->>'created_at')::timestamptz,updated_at=(v_row->>'updated_at')::timestamptz WHERE id=v_id;
    ELSE
      -- Nonpositive legacy sort values must survive the insert-only auto-order trigger.
      INSERT INTO public.product_types(id,name,is_active,sort_order,created_at,updated_at)
      VALUES(v_id,v_row->>'name',(v_row->>'is_active')::boolean,GREATEST((v_row->>'sort_order')::integer,1),(v_row->>'created_at')::timestamptz,(v_row->>'updated_at')::timestamptz);
      IF (v_row->>'sort_order')::integer<=0 THEN UPDATE public.product_types SET sort_order=(v_row->>'sort_order')::integer WHERE id=v_id; END IF;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.product_types WHERE id=v_id AND name IS NOT DISTINCT FROM v_row->>'name'
      AND is_active IS NOT DISTINCT FROM (v_row->>'is_active')::boolean AND sort_order=(v_row->>'sort_order')::integer
      AND created_at IS NOT DISTINCT FROM (v_row->>'created_at')::timestamptz AND updated_at IS NOT DISTINCT FROM (v_row->>'updated_at')::timestamptz) THEN
      RAISE EXCEPTION 'Product post-write verification failed.';
    END IF;
  END LOOP;
  v_receipt:=jsonb_build_object('success',true,'scope','product-catalog','full_site_complete',false,'product_map',v_plan->'product_map','repeated',false);
  UPDATE private.employee_transfer_jobs SET summary=COALESCE(summary,'{}')||jsonb_build_object('products_applied',true,'products_receipt',v_receipt) WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','products_applied',jsonb_build_object('scope','product-catalog','full_site_complete',false,'rows',jsonb_array_length(v_rows),'backup_id',v_backup.id,'backup_sha256',v_backup.sealed_sha256));
  RETURN v_receipt;
END;
$$;

CREATE FUNCTION public.employee_products_close(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_kind text;
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  SELECT kind INTO v_kind FROM private.employee_transfer_jobs WHERE token_hash=private.hash_financial_token(p_job_token);
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,CASE WHEN v_kind='export' THEN 'products-export' ELSE 'products-import' END);
  IF (v_job.kind='export' AND NOT COALESCE((v_job.summary->>'products_verified')::boolean,false))
    OR (v_job.kind='import' AND NOT COALESCE((v_job.summary->>'products_applied')::boolean,false)) THEN RAISE EXCEPTION 'The product stage has not been verified.'; END IF;
  PERFORM private.employee_transfer_end_job(v_job,'finished',COALESCE(v_job.summary,'{}')||'{"scope":"product-catalog","full_site_complete":false}'::jsonb);
  RETURN '{"success":true,"scope":"product-catalog","full_site_complete":false}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_employee_transfer_log(p_admin_session_token uuid, p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_limit integer := LEAST(GREATEST(COALESCE(p_limit,100),1),500);
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  RETURN jsonb_build_object(
    'site_id',(SELECT site_id FROM private.employee_transfer_site),
    'last_export_at',(SELECT max(finished_at) FROM private.employee_transfer_jobs WHERE kind='export' AND status='finished'
      AND options->>'export_protocol' IS DISTINCT FROM 'products-v1'),
    'running',(SELECT to_jsonb(running) FROM (SELECT job.id,job.kind,job.admin_username,job.started_at,job.last_activity_at
      FROM private.employee_transfer_jobs AS job WHERE job.status='running' LIMIT 1) AS running),
    'events',COALESCE((SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id DESC) FROM (
      SELECT item.id,item.job_id,item.occurred_at,item.admin_username,item.kind,item.action,item.details
      FROM private.employee_transfer_events AS item ORDER BY item.id DESC LIMIT v_limit) AS event),'[]'::jsonb));
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',v_function);
  END LOOP;
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'employee_export_products_begin','get_employee_export_products_page','employee_export_products_verify',
    'employee_import_products_begin','employee_import_products_stage','get_employee_import_products_dry_run',
    'get_employee_import_products_backup','get_employee_import_products_backup_page','employee_import_products_backup_append',
    'employee_import_products_backup_seal','get_employee_products_saved_backup_chunk','employee_import_products_apply','employee_products_close') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',v_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated',v_function);
  END LOOP;
END;
$$;
NOTIFY pgrst, 'reload schema';
