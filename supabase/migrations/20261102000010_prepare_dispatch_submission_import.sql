CREATE OR REPLACE FUNCTION private.employee_transfer_job(p_session uuid,p_job_token uuid,p_kind text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_job private.employee_transfer_jobs%ROWTYPE; v_kind text;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_session) AS admin;
  v_kind:=CASE p_kind WHEN 'shared-import' THEN 'import' WHEN 'products-import' THEN 'import'
    WHEN 'dispatch-import' THEN 'import' WHEN 'products-export' THEN 'export' WHEN 'dispatch-export' THEN 'export' ELSE p_kind END;
  IF p_job_token IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.'; END IF;
  UPDATE private.employee_transfer_jobs SET last_activity_at=now()
    WHERE token_hash=private.hash_financial_token(p_job_token) AND kind=v_kind AND admin_id=v_admin AND status='running'
      AND last_activity_at>now()-interval '3 hours' AND started_at>now()-interval '12 hours' RETURNING * INTO v_job;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.'; END IF;
  IF (v_job.options->>'import_protocol'='shared-import-v1' AND p_kind<>'shared-import')
    OR (p_kind='shared-import' AND v_job.options->>'import_protocol' IS DISTINCT FROM 'shared-import-v1')
    OR (v_job.options->>'import_protocol'='products-v1' AND p_kind<>'products-import')
    OR (p_kind='products-import' AND v_job.options->>'import_protocol' IS DISTINCT FROM 'products-v1')
    OR (v_job.options->>'import_protocol'='dispatch-submission-v1' AND p_kind<>'dispatch-import')
    OR (p_kind='dispatch-import' AND v_job.options->>'import_protocol' IS DISTINCT FROM 'dispatch-submission-v1')
    OR (v_job.options->>'export_protocol'='products-v1' AND p_kind<>'products-export')
    OR (p_kind='products-export' AND v_job.options->>'export_protocol' IS DISTINCT FROM 'products-v1')
    OR (v_job.options->>'export_protocol'='dispatch-submission-v1' AND p_kind<>'dispatch-export')
    OR (p_kind='dispatch-export' AND v_job.options->>'export_protocol' IS DISTINCT FROM 'dispatch-submission-v1') THEN
    RAISE EXCEPTION 'The task protocol does not permit this operation.';
  END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_dispatch_catalog(p_catalog jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text; v_table jsonb; v_index integer:=0; v_total bigint:=0;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_catalog,ARRAY['version','scope','site_id','tables','processing_orders','full_site_complete'])
    OR p_catalog->'version' IS DISTINCT FROM '1'::jsonb OR p_catalog->>'scope' IS DISTINCT FROM 'dispatch-submission'
    OR p_catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(p_catalog->'site_id') IS DISTINCT FROM 'string'
    OR (p_catalog->>'site_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_catalog->'processing_orders') IS DISTINCT FROM 'number'
    OR (p_catalog->>'processing_orders') !~ '^(0|[1-9][0-9]{0,14})$'
    OR jsonb_typeof(p_catalog->'tables') IS DISTINCT FROM 'array' OR jsonb_array_length(p_catalog->'tables')<>7 THEN
    RAISE EXCEPTION 'Invalid dispatch import catalog.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders',
    'dispatch_group_members','valid_order_data','used_order_data'] LOOP
    v_table:=p_catalog->'tables'->v_index; v_index:=v_index+1;
    IF NOT private.employee_transfer_exact_object(v_table,ARRAY['key','rows','bytes','row_hashes_sha256'])
      OR v_table->>'key' IS DISTINCT FROM v_key OR jsonb_typeof(v_table->'rows') IS DISTINCT FROM 'number'
      OR (v_table->>'rows') !~ '^(0|[1-9][0-9]{0,5})$' OR (v_table->>'rows')::integer>500000
      OR jsonb_typeof(v_table->'bytes') IS DISTINCT FROM 'number' OR (v_table->>'bytes') !~ '^(0|[1-9][0-9]{0,8})$'
      OR (v_table->>'bytes')::bigint>268435456 OR ((v_table->>'rows')::integer=0)<>((v_table->>'bytes')::bigint=0)
      OR jsonb_typeof(v_table->'row_hashes_sha256') IS DISTINCT FROM 'string'
      OR (v_table->>'row_hashes_sha256') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid dispatch table catalog.'; END IF;
    v_total:=v_total+(v_table->>'bytes')::bigint;
  END LOOP;
  IF v_total>1073741824 THEN RAISE EXCEPTION 'Dispatch import catalog exceeds limits.'; END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_dispatch_row(p_key text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_spec jsonb; v_field text; v_type text; v_value jsonb; v_time timestamptz; v_cast jsonb; v_checks text; v_valid boolean;
BEGIN
  v_spec:=private.employee_transfer_dispatch_spec()->p_key;
  IF v_spec IS NULL OR NOT private.employee_transfer_exact_object(p_row,ARRAY(SELECT key FROM jsonb_each(v_spec))) THEN
    RAISE EXCEPTION 'Unreviewed dispatch import fields.';
  END IF;
  FOR v_field,v_type IN SELECT key,value #>> '{}' FROM jsonb_each(v_spec) LOOP
    v_value:=p_row->v_field;
    IF v_value='null'::jsonb THEN
      IF right(v_type,1)='!' THEN RAISE EXCEPTION 'Required dispatch import field is null.'; END IF;
      CONTINUE;
    END IF;
    v_type:=rtrim(v_type,'!');
    IF v_type='uuid' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid dispatch identity.'; END IF;
    ELSIF v_type='boolean' THEN
      IF jsonb_typeof(v_value)<>'boolean' THEN RAISE EXCEPTION 'Invalid dispatch boolean.'; END IF;
    ELSIF v_type='integer' THEN
      IF jsonb_typeof(v_value)<>'number' OR (v_value #>> '{}') !~ '^-?(0|[1-9][0-9]{0,9})$'
        OR (v_value #>> '{}')::numeric NOT BETWEEN -2147483648 AND 2147483647 THEN RAISE EXCEPTION 'Invalid dispatch integer.'; END IF;
    ELSIF v_type LIKE 'numeric%' THEN
      IF jsonb_typeof(v_value)<>'number' THEN RAISE EXCEPTION 'Invalid dispatch numeric.'; END IF;
    ELSIF v_type='timestamp with time zone' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RAISE EXCEPTION 'Invalid dispatch timestamp.'; END IF;
      v_time:=(v_value #>> '{}')::timestamptz;
      IF NOT isfinite(v_time) OR substring(v_value #>> '{}' FROM 12 FOR 2)::integer>23
        OR substring(v_value #>> '{}' FROM 15 FOR 2)::integer>59 OR substring(v_value #>> '{}' FROM 18 FOR 2)::integer>59 THEN RAISE EXCEPTION 'Invalid dispatch timestamp.'; END IF;
    ELSIF v_type='text[]' THEN
      IF jsonb_typeof(v_value)<>'array' THEN RAISE EXCEPTION 'Invalid dispatch tags.'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_value) WHERE jsonb_typeof(value) NOT IN ('string','null')) THEN RAISE EXCEPTION 'Invalid dispatch tags.'; END IF;
    ELSIF v_type='text' THEN
      IF jsonb_typeof(v_value)<>'string' THEN RAISE EXCEPTION 'Invalid dispatch text.'; END IF;
    ELSE RAISE EXCEPTION 'Unreviewed dispatch field type.';
    END IF;
  END LOOP;
  EXECUTE format('SELECT to_jsonb(r) FROM jsonb_populate_record(NULL::public.%I,$1) AS r',p_key) INTO v_cast USING p_row;
  FOR v_field,v_type IN SELECT key,value #>> '{}' FROM jsonb_each(v_spec) LOOP
    IF v_type LIKE 'numeric%' AND v_cast->v_field IS DISTINCT FROM p_row->v_field THEN RAISE EXCEPTION 'Dispatch numeric precision would be lost.'; END IF;
  END LOOP;
  SELECT string_agg('COALESCE(('||pg_get_expr(conbin,conrelid)||'),true)',' AND ') INTO v_checks
    FROM pg_constraint WHERE conrelid=to_regclass('public.'||p_key) AND contype='c';
  IF v_checks IS NOT NULL THEN
    EXECUTE format('SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) AS r',v_checks,p_key) INTO v_valid USING p_row;
    IF NOT v_valid THEN RAISE EXCEPTION 'Dispatch source row violates target constraints.'; END IF;
  END IF;
END;
$$;

CREATE FUNCTION public.employee_import_dispatch_begin(p_admin_session_token uuid,p_admin_password text,p_package_id uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_begin jsonb;
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  PERFORM private.employee_transfer_check_dispatch_catalog(p_catalog);
  PERFORM private.employee_transfer_dispatch_schema();
  IF p_package_id IS NULL OR (p_catalog->>'site_id')::uuid=(SELECT site_id FROM private.employee_transfer_site) THEN RAISE EXCEPTION 'Invalid dispatch import source identity.'; END IF;
  v_begin:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'import',jsonb_build_object(
    'import_protocol','dispatch-submission-v1','scope','dispatch-submission','package_id',p_package_id,'catalog',p_catalog));
  RETURN (v_begin-ARRAY['site_id','server_time'])||'{"scope":"dispatch-submission","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_import_dispatch_stage(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_expected jsonb; v_previous jsonb; v_last jsonb;
  v_line text; v_json json; v_rows jsonb:='[]'; v_hashes text:=''; v_count integer:=0; v_first text; v_cursor text;
  v_total bigint; v_bytes bigint; v_count_total bigint; v_hash text;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  IF EXISTS(SELECT 1 FROM private.employee_transfer_shared_backups WHERE id=v_job.id) THEN RAISE EXCEPTION 'The frozen dispatch preparation no longer accepts chunks.'; END IF;
  PERFORM private.employee_transfer_dispatch_schema();
  SELECT value INTO v_expected FROM jsonb_array_elements(v_job.options#>'{catalog,tables}') WHERE value->>'key'=p_table_key;
  IF v_expected IS NULL OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 500000 OR p_ndjson IS NULL
    OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN RAISE EXCEPTION 'Invalid dispatch import chunk.'; END IF;
  IF p_ndjson<>'' THEN
    FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS item(line) LOOP
      IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Dispatch import row exceeds limits.'; END IF;
      BEGIN
        v_json:=v_line::json;
        IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN RAISE EXCEPTION 'Invalid JSON'; END IF;
        PERFORM private.employee_transfer_check_dispatch_row(p_table_key,v_json::jsonb);
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid dispatch import row.' USING ERRCODE='22023'; END;
      IF v_cursor IS NOT NULL AND v_cursor COLLATE "C">=(v_json->>'id') COLLATE "C" THEN RAISE EXCEPTION 'Dispatch rows must be strictly ordered.'; END IF;
      v_cursor:=v_json->>'id'; v_first:=COALESCE(v_first,v_cursor);
      v_rows:=v_rows||jsonb_build_array(v_json::jsonb); v_count:=v_count+1;
      v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    END LOOP;
  END IF;
  IF v_count>200 OR (v_count=0 AND (p_chunk_no<>0 OR (v_expected->>'rows')::integer<>0)) THEN RAISE EXCEPTION 'Invalid dispatch chunk row count.'; END IF;
  v_hash:=encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex');
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_previous IS NOT NULL THEN
    IF v_previous->>'ndjson' IS DISTINCT FROM p_ndjson THEN RAISE EXCEPTION 'Dispatch chunk identity has different contents.'; END IF;
    RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',true);
  END IF;
  SELECT count(*),COALESCE(sum(row_count),0)+v_count,COALESCE(sum((payload->>'bytes')::integer),0)+octet_length(p_ndjson)
    INTO v_total,v_count_total,v_bytes FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:'||p_table_key;
  SELECT payload INTO v_last FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:'||p_table_key AND chunk_no=p_chunk_no-1;
  IF v_total<>p_chunk_no OR v_count_total>(v_expected->>'rows')::bigint OR v_bytes>(v_expected->>'bytes')::bigint
    OR (p_chunk_no>0 AND (v_last->>'last_id') COLLATE "C">=v_first COLLATE "C") THEN RAISE EXCEPTION 'Dispatch chunks exceed the catalog or cursor order.'; END IF;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','dispatch-in:'||p_table_key,p_chunk_no,v_count,
      jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_cursor));
  RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_dispatch_input(p_job_id uuid,p_key text)
RETURNS TABLE(id uuid,body jsonb) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT (item.value->>'id')::uuid,item.value FROM private.employee_transfer_staging AS stage
  CROSS JOIN LATERAL jsonb_array_elements(stage.payload->'rows') AS item(value)
  WHERE stage.job_id=p_job_id AND stage.employee_id='00000000-0000-0000-0000-000000000000' AND stage.table_key='dispatch-in:'||p_key;
$$;

CREATE FUNCTION private.employee_transfer_dispatch_check_input(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table jsonb; v_rows bigint; v_bytes bigint; v_hash text; v_chunks bigint; v_counts jsonb:='{}';
BEGIN
  PERFORM private.employee_transfer_check_dispatch_catalog(p_job.options->'catalog');
  FOR v_table IN SELECT value FROM jsonb_array_elements(p_job.options#>'{catalog,tables}') LOOP
    SELECT count(*),COALESCE(sum(row_count),0),COALESCE(sum((payload->>'bytes')::bigint),0),
      encode(extensions.digest(convert_to(COALESCE(string_agg(payload->>'row_hashes','' ORDER BY chunk_no),''),'UTF8'),'sha256'),'hex')
      INTO v_chunks,v_rows,v_bytes,v_hash FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:'||(v_table->>'key');
    IF v_chunks=0 OR v_rows<>(v_table->>'rows')::bigint OR v_bytes<>(v_table->>'bytes')::bigint
      OR v_hash IS DISTINCT FROM v_table->>'row_hashes_sha256' THEN RAISE EXCEPTION 'Dispatch staged catalog verification failed.'; END IF;
    v_counts:=v_counts||jsonb_build_object(v_table->>'key',v_rows);
  END LOOP;
  IF (SELECT count(*) FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups') WHERE (body->>'is_default')::boolean)<>1
    OR EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups') WHERE (body->>'is_default')::boolean AND body->>'archived_at' IS NOT NULL) THEN
    RAISE EXCEPTION 'Source default dispatch group is ambiguous or missing.';
  END IF;
  IF EXISTS(WITH groups AS MATERIALIZED(SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups')),
    pools AS MATERIALIZED(SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_order_pools'))
    SELECT 1 FROM groups AS g LEFT JOIN pools AS p ON (p.body->>'group_id')::uuid=g.id AND (p.body->>'is_base')::boolean
    GROUP BY g.id HAVING count(p.id)<>1) THEN RAISE EXCEPTION 'Source base pool is ambiguous or missing.'; END IF;
  IF EXISTS(WITH groups AS MATERIALIZED(SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups')),
    pools AS MATERIALIZED(SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_order_pools'))
    SELECT 1 FROM groups AS g LEFT JOIN pools AS p ON (p.body->>'group_id')::uuid=g.id AND p.body->>'archived_at' IS NULL
    WHERE g.body->>'pool_selection_mode'='weighted' AND g.body->>'archived_at' IS NULL GROUP BY g.id
    HAVING COALESCE(sum((p.body->>'trigger_probability')::integer),0)<>100) THEN RAISE EXCEPTION 'Source weighted probabilities are invalid.'; END IF;
  IF EXISTS(WITH groups AS MATERIALIZED(SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups')),
    pools AS MATERIALIZED(SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_order_pools'))
    SELECT 1 FROM pools AS p LEFT JOIN groups AS g ON g.id=(p.body->>'group_id')::uuid WHERE g.id IS NULL)
    OR EXISTS(WITH groups AS MATERIALIZED(SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups')),
    pools AS MATERIALIZED(SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_order_pools'))
    SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_group_orders') AS o
    LEFT JOIN pools AS p ON p.id=(o.body->>'pool_id')::uuid AND p.body->>'group_id'=o.body->>'group_id' WHERE p.id IS NULL)
    OR EXISTS(WITH groups AS MATERIALIZED(SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups'))
    SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_group_members') AS m LEFT JOIN groups AS g
    ON g.id=(m.body->>'group_id')::uuid WHERE g.id IS NULL)
    OR EXISTS(WITH valid AS MATERIALIZED(SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'valid_order_data'))
    SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'used_order_data') AS u LEFT JOIN valid AS v
    ON v.id=(u.body->>'valid_order_data_id')::uuid WHERE v.id IS NULL) THEN RAISE EXCEPTION 'Source dispatch/submission references are incomplete.'; END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups') GROUP BY body->>'group_name' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_order_pools') GROUP BY body->>'group_id',body->>'pool_name' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_group_members') GROUP BY body->>'user_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'used_order_data') GROUP BY body->>'user_id',body->>'valid_order_data_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_config') GROUP BY body->>'config_key' HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate source dispatch business identity.'; END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_config') WHERE body->>'config_key' NOT IN
      ('dispatch_interval_min','dispatch_interval_max','session_timeout_minutes','dispatch_order_mode','dispatch_mode')
    OR CASE WHEN body->>'config_key' IN ('dispatch_interval_min','dispatch_interval_max') THEN
      CASE WHEN body->>'config_value' ~ '^[0-9]{1,4}$' THEN (body->>'config_value')::integer NOT BETWEEN 1 AND 3000 ELSE true END
    WHEN body->>'config_key'='session_timeout_minutes' THEN
      CASE WHEN body->>'config_value' ~ '^[0-9]{1,2}$' THEN (body->>'config_value')::integer NOT BETWEEN 1 AND 60 ELSE true END
    ELSE body->>'config_value' NOT IN ('random','sequential') END) THEN RAISE EXCEPTION 'Unreviewed source dispatch configuration.'; END IF;
  IF (SELECT (body->>'config_value')::integer FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_config') WHERE body->>'config_key'='dispatch_interval_min')>
    (SELECT (body->>'config_value')::integer FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_config') WHERE body->>'config_key'='dispatch_interval_max') THEN RAISE EXCEPTION 'Invalid source dispatch interval bounds.'; END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'valid_order_data') WHERE (body->>'usage_count')::integer<0) THEN RAISE EXCEPTION 'Invalid source submission usage.'; END IF;
  RETURN v_counts;
END;
$$;

CREATE FUNCTION private.employee_transfer_dispatch_target(p_session uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_catalog jsonb; v_preflight jsonb; v_identities jsonb; v_retention jsonb;
BEGIN
  v_preflight:=public.get_employee_import_dispatch_preflight(p_session);
  IF NOT (v_preflight->>'eligible_for_empty_target_mode')::boolean THEN RAISE EXCEPTION 'Target contains business history; empty-target dispatch replacement is blocked.'; END IF;
  v_catalog:=private.employee_transfer_dispatch_catalog();
  IF (SELECT sum((value->>'bytes')::bigint) FROM jsonb_array_elements(v_catalog->'tables'))>8388608 THEN RAISE EXCEPTION 'Target dispatch backup requires multi-volume support; preparation blocked without truncation.'; END IF;
  SELECT jsonb_build_object('admins',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'username',username,'role',role,'parent_id',parent_id,'is_active',is_active) ORDER BY id),'[]') FROM public.admins),
    'users',(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'username',username,'employee_id',employee_id,'created_by',created_by,'is_active',is_active,'archived_at',archived_at) ORDER BY id),'[]') FROM public.users)) INTO v_identities;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.table_name),'[]') INTO v_retention FROM public.history_cleanup_config AS r;
  RETURN jsonb_build_object('catalog',v_catalog,'preflight',v_preflight,'identities',v_identities,'retention',v_retention);
END;
$$;

CREATE FUNCTION public.get_employee_import_dispatch_dry_run(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_counts jsonb; v_target jsonb; v_target_hash text; v_plan_hash text;
  v_backup private.employee_transfer_shared_backups%ROWTYPE; v_key text; v_query text; v_snapshot jsonb; v_dependencies jsonb; v_default uuid; v_plan jsonb;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  LOCK TABLE public.dispatch_config,public.dispatch_groups,public.dispatch_order_pools,public.dispatch_group_orders,
    public.dispatch_group_members,public.valid_order_data,public.used_order_data,public.orders,public.orders_history,
    public.dispatch_assignments,public.dispatch_pool_selections,public.dispatch_sessions,public.wallet_transactions,
    public.wallet_ledger_entries,public.wallet_reconciliation_audit,public.withdrawals,public.wallets,public.users,
    public.wallet_balance_baselines,public.work_sessions,public.dispatch_orders,public.admins,public.history_cleanup_config IN SHARE MODE;
  v_counts:=private.employee_transfer_dispatch_check_input(v_job);
  v_target:=private.employee_transfer_dispatch_target(p_admin_session_token);
  v_target_hash:=encode(extensions.digest(convert_to(v_target::text,'UTF8'),'sha256'),'hex');
  SELECT jsonb_build_object('administrators',count(DISTINCT admin_id)) INTO v_dependencies FROM (
    SELECT body->>'created_by' AS admin_id FROM private.employee_transfer_dispatch_input(v_job.id,'dispatch_groups') UNION ALL
    SELECT body->>'created_by' FROM private.employee_transfer_dispatch_input(v_job.id,'dispatch_order_pools') UNION ALL
    SELECT body->>'created_by' FROM private.employee_transfer_dispatch_input(v_job.id,'dispatch_group_orders') UNION ALL
    SELECT body->>'assigned_by' FROM private.employee_transfer_dispatch_input(v_job.id,'dispatch_group_members') UNION ALL
    SELECT body->>'created_by' FROM private.employee_transfer_dispatch_input(v_job.id,'valid_order_data')) AS refs;
  v_dependencies:=v_dependencies||jsonb_build_object('employees',(SELECT count(DISTINCT employee_id) FROM (
    SELECT body->>'user_id' AS employee_id FROM private.employee_transfer_dispatch_input(v_job.id,'dispatch_group_members') UNION ALL
    SELECT body->>'user_id' FROM private.employee_transfer_dispatch_input(v_job.id,'used_order_data')) AS refs),
    'orders',(SELECT count(DISTINCT body->>'order_id') FROM private.employee_transfer_dispatch_input(v_job.id,'used_order_data')));
  SELECT id INTO v_default FROM private.employee_transfer_dispatch_input(v_job.id,'dispatch_groups') WHERE (body->>'is_default')::boolean;
  v_plan:=jsonb_build_object('scope','dispatch-submission','full_site_complete',false,'preparation_ready',true,
    'replacement_ready',false,'can_apply',false,'source_default_group_id',v_default,'counts',v_counts,'dependencies',v_dependencies);
  v_plan_hash:=encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,'package_id',v_job.options->'package_id',
    'catalog',v_job.options->'catalog','target_hash',v_target_hash)::text,'UTF8'),'sha256'),'hex');
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id;
  IF v_backup.id IS NOT NULL AND (v_backup.plan_hash IS DISTINCT FROM v_plan_hash OR v_backup.target_hash IS DISTINCT FROM v_target_hash) THEN RAISE EXCEPTION 'Dispatch target changed after backup preparation; restart the task.'; END IF;
  IF v_backup.id IS NULL THEN
    FOREACH v_key IN ARRAY ARRAY['dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders','dispatch_group_members','valid_order_data','used_order_data'] LOOP
      v_query:=private.employee_transfer_dispatch_query(v_key);
      EXECUTE 'SELECT jsonb_build_object(''rows'',COALESCE(jsonb_agg(body ORDER BY id),''[]''::jsonb)) FROM ('||v_query||') AS r' INTO v_snapshot;
      INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
        VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','dispatch-backup:'||v_key,0,jsonb_array_length(v_snapshot->'rows'),v_snapshot);
    END LOOP;
    INSERT INTO private.employee_transfer_shared_backups(id,admin_id,plan_hash,target_hash,catalog)
      VALUES(v_job.id,v_job.admin_id,v_plan_hash,v_target_hash,v_target->'catalog');
  END IF;
  UPDATE private.employee_transfer_jobs SET summary=COALESCE(summary,'{}')||jsonb_build_object('dispatch_plan_hash',v_plan_hash,'dispatch_preparation',v_plan) WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','dispatch_prepared',jsonb_build_object('scope','dispatch-submission','full_site_complete',false,'counts',v_counts));
  RETURN v_plan||jsonb_build_object('plan_hash',v_plan_hash);
END;
$$;

CREATE FUNCTION public.get_employee_import_dispatch_backup(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id;
  IF v_backup.id IS NULL THEN RAISE EXCEPTION 'A verified dispatch preparation is required.'; END IF;
  RETURN jsonb_build_object('backup_id',v_backup.id,'plan_hash',v_backup.plan_hash,'target_hash',v_backup.target_hash,'catalog',v_backup.catalog);
END;
$$;

CREATE FUNCTION public.get_employee_import_dispatch_backup_page(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_snapshot jsonb; v_page jsonb;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  IF NOT private.employee_transfer_dispatch_spec() ? p_table_key THEN RAISE EXCEPTION 'Unknown dispatch backup table.'; END IF;
  SELECT payload INTO v_snapshot FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-backup:'||p_table_key AND chunk_no=0;
  v_page:=private.employee_transfer_product_page(v_snapshot,p_after,p_limit);
  RETURN jsonb_set(v_page,'{table_key}',to_jsonb(p_table_key));
END;
$$;

CREATE FUNCTION public.employee_import_dispatch_backup_append(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text,p_chunk_no integer,p_hex text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE; v_chunk bytea; v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  IF p_hex IS NULL OR length(p_hex) NOT BETWEEN 2 AND 262144 OR length(p_hex)%2<>0 OR p_hex!~'^[0-9a-f]+$'
    OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 1023 THEN RAISE EXCEPTION 'Invalid encrypted dispatch backup chunk.'; END IF;
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id FOR UPDATE;
  IF v_backup.id IS NULL OR p_plan_hash IS DISTINCT FROM v_backup.plan_hash OR v_backup.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'The dispatch backup does not accept encrypted chunks.'; END IF;
  v_chunk:=decode(p_hex,'hex');
  IF p_chunk_no>cardinality(v_backup.chunks) THEN RAISE EXCEPTION 'Backup chunks must be contiguous.'; END IF;
  v_repeated:=p_chunk_no<cardinality(v_backup.chunks);
  IF v_repeated THEN
    IF v_backup.chunks[p_chunk_no+1] IS DISTINCT FROM v_chunk THEN RAISE EXCEPTION 'Encrypted backup chunk identity has different contents.'; END IF;
  ELSE
    IF v_backup.byte_count+octet_length(v_chunk)>9437184 THEN RAISE EXCEPTION 'Encrypted dispatch backup exceeds the limit.'; END IF;
    UPDATE private.employee_transfer_shared_backups SET chunks=array_append(chunks,v_chunk),byte_count=byte_count+octet_length(v_chunk) WHERE id=v_job.id;
  END IF;
  RETURN jsonb_build_object('success',true,'bytes',octet_length(v_chunk),'sha256',encode(extensions.digest(v_chunk,'sha256'),'hex'),'repeated',v_repeated);
END;
$$;

CREATE FUNCTION public.employee_import_dispatch_backup_seal(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text,p_sha256 text,p_bytes integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE; v_cipher bytea; v_hash text; v_repeated boolean; v_target jsonb;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  LOCK TABLE public.dispatch_config,public.dispatch_groups,public.dispatch_order_pools,public.dispatch_group_orders,
    public.dispatch_group_members,public.valid_order_data,public.used_order_data,public.orders,public.orders_history,
    public.dispatch_assignments,public.dispatch_pool_selections,public.dispatch_sessions,public.wallet_transactions,
    public.wallet_ledger_entries,public.wallet_reconciliation_audit,public.withdrawals,public.wallets,public.users,
    public.wallet_balance_baselines,public.work_sessions,public.dispatch_orders,public.admins,public.history_cleanup_config IN SHARE MODE;
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id FOR UPDATE;
  IF v_backup.id IS NULL OR p_plan_hash IS DISTINCT FROM v_backup.plan_hash OR p_bytes IS NULL OR p_sha256 IS NULL OR p_sha256!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid dispatch backup seal request.'; END IF;
  v_target:=private.employee_transfer_dispatch_target(p_admin_session_token);
  IF encode(extensions.digest(convert_to(v_target::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM v_backup.target_hash THEN RAISE EXCEPTION 'Dispatch target changed after backup preparation; restart the task.'; END IF;
  SELECT string_agg(chunk,''::bytea ORDER BY ordinal) INTO v_cipher FROM unnest(v_backup.chunks) WITH ORDINALITY AS item(chunk,ordinal);
  v_hash:=encode(extensions.digest(v_cipher,'sha256'),'hex');
  IF v_backup.byte_count<>p_bytes OR p_bytes<64 OR substring(v_cipher FROM 1 FOR 8) IS DISTINCT FROM convert_to('EDXSTRM1','UTF8') OR v_hash IS DISTINCT FROM p_sha256 THEN RAISE EXCEPTION 'The encrypted dispatch backup does not match its seal.'; END IF;
  v_repeated:=v_backup.sealed_at IS NOT NULL;
  UPDATE private.employee_transfer_shared_backups SET sealed_sha256=v_hash,sealed_at=COALESCE(sealed_at,clock_timestamp()) WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','dispatch_backup_sealed',jsonb_build_object('backup_id',v_backup.id,'sha256',v_hash,'bytes',p_bytes,'full_site_complete',false));
  RETURN jsonb_build_object('success',true,'backup_id',v_backup.id,'sha256',v_hash,'bytes',p_bytes,'repeated',v_repeated,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_dispatch_saved_backup_chunk(p_admin_session_token uuid,p_backup_id uuid,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_backup private.employee_transfer_shared_backups%ROWTYPE; v_chunk bytea;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_admin_session_token) AS admin;
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=p_backup_id AND admin_id=v_admin AND sealed_at IS NOT NULL AND catalog->>'scope'='dispatch-submission';
  IF v_backup.id IS NULL OR p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>=cardinality(v_backup.chunks) THEN RAISE EXCEPTION 'The saved dispatch backup or chunk is unavailable.'; END IF;
  v_chunk:=v_backup.chunks[p_chunk_no+1];
  RETURN jsonb_build_object('backup_id',v_backup.id,'chunk_no',p_chunk_no,'hex',encode(v_chunk,'hex'),'sha256',v_backup.sealed_sha256,'bytes',v_backup.byte_count,'chunks',cardinality(v_backup.chunks));
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',v_function);
  END LOOP;
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'employee_import_dispatch_begin','employee_import_dispatch_stage','get_employee_import_dispatch_dry_run',
    'get_employee_import_dispatch_backup','get_employee_import_dispatch_backup_page','employee_import_dispatch_backup_append',
    'employee_import_dispatch_backup_seal','get_employee_dispatch_saved_backup_chunk') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',v_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated',v_function);
  END LOOP;
END;
$$;
NOTIFY pgrst,'reload schema';
