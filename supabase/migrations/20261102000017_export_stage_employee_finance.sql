BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_finance_spec()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT '{
    "wallets":{"id":"uuid!","user_id":"uuid!","available_balance":"numeric","frozen_balance":"numeric","created_at":"timestamp with time zone","updated_at":"timestamp with time zone"},
    "wallet_balance_baselines":{"id":"uuid!","user_id":"uuid!","available_balance":"numeric!","frozen_balance":"numeric!","total_income":"numeric!","last_ledger_id":"bigint-text!","established_at":"timestamp with time zone!"},
    "wallet_ledger_entries":{"id":"bigint-text!","user_id":"uuid!","operation_id":"uuid!","source_type":"text!","source_id":"uuid!","event_type":"text!","available_delta":"numeric!","frozen_delta":"numeric!","income_delta":"numeric!","created_at":"timestamp with time zone!"},
    "wallet_transactions":{"id":"uuid!","user_id":"uuid!","type":"text!","amount":"numeric!","balance_before":"numeric!","balance_after":"numeric!","reference_id":"uuid","remarks":"text","created_by":"uuid","created_at":"timestamp with time zone","operation_id":"uuid"},
    "withdrawals":{"id":"uuid!","user_id":"uuid!","amount":"numeric!","status":"text!","audit_remark":"text","audited_by":"uuid","audited_at":"timestamp with time zone","created_at":"timestamp with time zone","last_operation_id":"uuid"},
    "wallet_reconciliation_audit":{"id":"bigint-text!","user_id":"uuid!","available_before":"numeric!","available_after":"numeric!","frozen_before":"numeric!","frozen_after":"numeric!","income_before":"numeric!","income_after":"numeric!","pending_amount":"numeric!","ledger_total":"numeric!","reason":"text!","repaired_at":"timestamp with time zone!"}
  }'::jsonb;
$$;

CREATE FUNCTION private.employee_transfer_finance_schema()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text; v_spec jsonb; v_actual jsonb;
BEGIN
  FOR v_key,v_spec IN SELECT key,value FROM jsonb_each(private.employee_transfer_finance_spec()) LOOP
    IF v_key IN ('wallets','wallet_balance_baselines') THEN v_spec:=v_spec-'id'; END IF;
    SELECT jsonb_object_agg(key,replace(value#>>'{}','bigint-text','bigint')) INTO v_spec FROM jsonb_each(v_spec);
    SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)||CASE WHEN attnotnull THEN '!' ELSE '' END) INTO v_actual
      FROM pg_attribute WHERE attrelid=to_regclass('public.'||v_key) AND attnum>0 AND NOT attisdropped;
    IF v_actual IS DISTINCT FROM v_spec THEN RAISE EXCEPTION 'Unreviewed employee finance schema.'; END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_cursor_type(p_key text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF NOT private.employee_transfer_finance_spec() ? p_key OR p_key IS NULL THEN RAISE EXCEPTION 'Unsupported employee finance table.'; END IF;
  RETURN CASE WHEN p_key IN ('wallet_ledger_entries','wallet_reconciliation_audit') THEN 'bigint' ELSE 'uuid' END;
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_query(p_key text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_spec jsonb; v_projection text; v_id text;
BEGIN
  PERFORM private.employee_transfer_finance_cursor_type(p_key);
  v_spec:=private.employee_transfer_finance_spec()->p_key;
  v_id:=CASE WHEN p_key IN ('wallets','wallet_balance_baselines') THEN 'user_id' ELSE 'id' END;
  SELECT string_agg(format('%L,src.%I%s',key,CASE WHEN key='id' THEN v_id ELSE key END,
    CASE WHEN value#>>'{}' LIKE 'bigint-text%' THEN '::text' ELSE '' END),',' ORDER BY key COLLATE "C") INTO v_projection FROM jsonb_each(v_spec);
  RETURN format('SELECT src.%I AS id,jsonb_build_object(%s) AS body FROM public.%I AS src JOIN public.users AS owner ON owner.id=src.user_id WHERE owner.archived_at IS NULL',v_id,v_projection,p_key);
END;
$$;

CREATE FUNCTION private.employee_transfer_check_finance_catalog(p_catalog jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text; v_table jsonb; v_index integer:=0; v_bytes bigint:=0;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_catalog,ARRAY['version','scope','site_id','package_id','identity_catalog','tables','full_site_complete'])
    OR p_catalog->'version' IS DISTINCT FROM '1'::jsonb OR p_catalog->>'scope' IS DISTINCT FROM 'employee-finance'
    OR p_catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(p_catalog->'tables') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_catalog->'tables')<>6 THEN RAISE EXCEPTION 'Invalid employee finance catalog.'; END IF;
  PERFORM private.employee_transfer_check_identity_catalog(p_catalog->'identity_catalog');
  IF p_catalog->'site_id' IS DISTINCT FROM p_catalog#>'{identity_catalog,site_id}'
    OR p_catalog->'package_id' IS DISTINCT FROM p_catalog#>'{identity_catalog,package_id}' THEN RAISE EXCEPTION 'Finance and identity source binding differs.'; END IF;
  FOREACH v_key IN ARRAY ARRAY['wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit'] LOOP
    v_table:=p_catalog->'tables'->v_index;v_index:=v_index+1;
    IF NOT private.employee_transfer_exact_object(v_table,ARRAY['key','rows','bytes','row_hashes_sha256'])
      OR v_table->>'key' IS DISTINCT FROM v_key OR jsonb_typeof(v_table->'rows') IS DISTINCT FROM 'number'
      OR (v_table->>'rows') !~ '^(0|[1-9][0-9]{0,5})$' OR (v_table->>'rows')::bigint>500000
      OR jsonb_typeof(v_table->'bytes') IS DISTINCT FROM 'number' OR (v_table->>'bytes') !~ '^(0|[1-9][0-9]{0,8})$'
      OR (v_table->>'bytes')::bigint>268435456 OR ((v_table->>'rows')::bigint=0)<>((v_table->>'bytes')::bigint=0)
      OR jsonb_typeof(v_table->'row_hashes_sha256') IS DISTINCT FROM 'string' OR (v_table->>'row_hashes_sha256') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Invalid employee finance table catalog.';
    END IF;
    v_bytes:=v_bytes+(v_table->>'bytes')::bigint;
  END LOOP;
  IF v_bytes>1073741824 THEN RAISE EXCEPTION 'Employee finance catalog exceeds limits.'; END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_catalog(p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text; v_query text; v_rows bigint; v_bytes bigint; v_largest bigint; v_hash text; v_total bigint:=0; v_tables jsonb:='[]';
BEGIN
  PERFORM private.employee_transfer_finance_schema();
  FOREACH v_key IN ARRAY ARRAY['wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit'] LOOP
    v_query:=private.employee_transfer_finance_query(v_key);
    EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),COALESCE(max(octet_length(body::text||E''\n'')),0) FROM ('||v_query||') AS r'
      INTO v_rows,v_bytes,v_largest;
    v_total:=v_total+v_bytes;
    IF v_rows>500000 OR v_bytes>268435456 OR v_total>1073741824 OR v_largest>65536 THEN RAISE EXCEPTION 'Finance export exceeds limits; no data was truncated.'; END IF;
    EXECUTE 'SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id),''''),''UTF8''),''sha256''),''hex'') FROM ('||v_query||') AS r' INTO v_hash;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
  END LOOP;
  RETURN jsonb_build_object('version',1,'scope','employee-finance','site_id',(SELECT site_id FROM private.employee_transfer_site),
    'package_id',p_package_id,'identity_catalog',private.employee_transfer_identity_catalog(p_package_id),'tables',v_tables,'full_site_complete',false);
END;
$$;

DO $isolate_finance$
DECLARE v_definition text; v_anchor text;
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_job(uuid,uuid,text)'::regprocedure);
  v_anchor:='    OR (v_job.options->>''export_protocol''=''employee-identity-v1'' AND p_kind<>''identity-export'')';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Finance protocol isolation anchor changed.'; END IF;
  v_definition:=replace(v_definition,v_anchor,E'    OR (v_job.options->>''export_protocol''=''employee-finance-v1'' AND p_kind<>''finance-export'')\n    OR (p_kind=''finance-export'' AND v_job.options->>''export_protocol'' IS DISTINCT FROM ''employee-finance-v1'')\n'||v_anchor);
  v_anchor:='WHEN ''identity-export'' THEN ''export''';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Finance task kind anchor changed.'; END IF;
  EXECUTE replace(v_definition,v_anchor,'WHEN ''finance-export'' THEN ''export'' '||v_anchor);
  v_definition:=pg_get_functiondef('public.get_employee_transfer_log(uuid,integer)'::regprocedure);
  v_anchor:='AND options->>''export_protocol'' IS DISTINCT FROM ''employee-identity-v1''';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Finance export log anchor changed.'; END IF;
  EXECUTE replace(v_definition,v_anchor,v_anchor||E'\n      AND options->>''export_protocol'' IS DISTINCT FROM ''employee-finance-v1''');
END;
$isolate_finance$;

CREATE FUNCTION public.employee_export_finance_begin(p_admin_session_token uuid,p_admin_password text,p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_begin jsonb; v_catalog jsonb;
BEGIN
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'A finance package id is required.'; END IF;
  v_begin:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'export',jsonb_build_object('export_protocol','employee-finance-v1','scope','employee-finance','package_id',p_package_id));
  IF NOT COALESCE((v_begin->>'success')::boolean,false) THEN RETURN v_begin; END IF;
  v_catalog:=private.employee_transfer_finance_catalog(p_package_id);
  UPDATE private.employee_transfer_jobs SET summary=jsonb_build_object('finance_catalog',v_catalog) WHERE id=(v_begin->>'job_id')::uuid;
  RETURN (v_begin-'server_time')||jsonb_build_object('catalog',v_catalog,'scope','employee-finance','full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_export_finance_page(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_query text; v_type text; v_line text; v_text text:=''; v_count integer:=0; v_cursor text; v_row record; v_more boolean:=false;
BEGIN
  PERFORM private.employee_transfer_job(p_admin_session_token,p_job_token,'finance-export');
  PERFORM private.employee_transfer_finance_schema();v_type:=private.employee_transfer_finance_cursor_type(p_table_key);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid finance page size.'; END IF;
  v_query:=private.employee_transfer_finance_query(p_table_key);
  IF p_after IS NOT NULL THEN
    EXECUTE 'SELECT id::text FROM ('||v_query||') AS r WHERE id=$1::'||v_type INTO v_cursor USING p_after;
    IF v_cursor IS NULL OR v_cursor IS DISTINCT FROM p_after THEN RAISE EXCEPTION 'Finance cursor disappeared or is not canonical.'; END IF;
  END IF;
  FOR v_row IN EXECUTE 'SELECT id::text AS cursor_id,body FROM ('||v_query||') AS r WHERE ($1::'||v_type||' IS NULL OR id>$1::'||v_type||') ORDER BY id LIMIT $2' USING p_after,p_limit+1 LOOP
    v_line:=v_row.body::text||E'\n';
    IF octet_length(v_line)>65536 THEN RAISE EXCEPTION 'Finance export row exceeds limits.'; END IF;
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_line)>262144 THEN v_more:=true;EXIT;END IF;
    v_text:=v_text||v_line;v_count:=v_count+1;v_cursor:=v_row.cursor_id;
  END LOOP;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_text,'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_export_finance_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'finance-export');
  IF v_job.summary->'finance_catalog' IS DISTINCT FROM private.employee_transfer_finance_catalog((v_job.options->>'package_id')::uuid) THEN
    RAISE EXCEPTION 'Finance or identity source changed; discard the export and restart.';
  END IF;
  UPDATE private.employee_transfer_jobs SET summary=summary||'{"finance_verified":true}'::jsonb WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'export','finance_verified','{"scope":"employee-finance","full_site_complete":false}');
  RETURN '{"verified":true,"scope":"employee-finance","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_export_finance_close(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'finance-export');
  IF v_job.summary->'finance_verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Finance export has not been verified.'; END IF;
  PERFORM private.employee_transfer_end_job(v_job,'finished',v_job.summary||'{"scope":"employee-finance","full_site_complete":false}'::jsonb);
  RETURN '{"success":true,"scope":"employee-finance","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_owner(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;
BEGIN
  v_map:=private.employee_transfer_identity_admin_map(p_job);
  PERFORM private.employee_transfer_finance_schema();
  IF p_job.summary#>'{identity_restore,verified}' IS DISTINCT FROM 'true'::jsonb
    OR p_job.summary#>'{dependency_restore,verified}' IS DISTINCT FROM 'true'::jsonb
    OR p_job.summary#>'{identity_restore,admin_map}' IS DISTINCT FROM v_map THEN RAISE EXCEPTION 'Verified same-package identities and dispatch dependencies are required for finance.'; END IF;
  IF p_job.summary ? 'finance_catalog' AND (p_job.summary#>'{finance_catalog,identity_catalog}' IS DISTINCT FROM p_job.summary->'identity_catalog'
    OR p_job.summary#>'{finance_catalog,package_id}' IS DISTINCT FROM p_job.options->'package_id'
    OR p_job.summary#>'{finance_catalog,site_id}' IS DISTINCT FROM p_job.options#>'{catalog,site_id}') THEN RAISE EXCEPTION 'Finance source binding changed.'; END IF;
  RETURN v_map;
END;
$$;

CREATE FUNCTION public.employee_import_finance_bind(p_admin_session_token uuid,p_job_token uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  PERFORM private.employee_transfer_finance_owner(v_job);PERFORM private.employee_transfer_check_finance_catalog(p_catalog);
  IF p_catalog->'identity_catalog' IS DISTINCT FROM v_job.summary->'identity_catalog' THEN RAISE EXCEPTION 'Finance must match the exact restored identity catalog and source package.'; END IF;
  v_repeated:=v_job.summary ? 'finance_catalog';
  IF v_repeated THEN
    IF p_catalog IS DISTINCT FROM v_job.summary->'finance_catalog' THEN RAISE EXCEPTION 'The finance catalog binding is immutable.'; END IF;
  ELSE UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('finance_catalog',p_catalog) WHERE id=v_job.id; END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-finance','repeated',v_repeated,'full_site_complete',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_check_finance_row(p_key text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_spec jsonb:=private.employee_transfer_finance_spec()->p_key;v_field text;v_type text;v_value jsonb;v_number numeric;v_time timestamptz;v_record jsonb;v_cast jsonb;v_checks text;v_valid boolean;
BEGIN
  IF v_spec IS NULL OR NOT private.employee_transfer_exact_object(p_row,ARRAY(SELECT key FROM jsonb_each(v_spec))) THEN RAISE EXCEPTION 'Unreviewed finance row fields.'; END IF;
  FOR v_field,v_type IN SELECT key,value#>>'{}' FROM jsonb_each(v_spec) LOOP
    v_value:=p_row->v_field;
    IF v_value='null'::jsonb THEN IF right(v_type,1)='!' THEN RAISE EXCEPTION 'Required finance field is null.'; END IF;CONTINUE;END IF;
    v_type:=rtrim(v_type,'!');
    IF v_type='uuid' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid finance identity.'; END IF;
    ELSIF v_type='bigint-text' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^(0|[1-9][0-9]{0,18})$' OR (v_value#>>'{}')::numeric>9223372036854775807
        OR (v_field='id' AND (v_value#>>'{}')::bigint=0) THEN RAISE EXCEPTION 'Invalid finance bigint.'; END IF;
    ELSIF v_type='numeric' THEN
      IF jsonb_typeof(v_value)<>'number' THEN RAISE EXCEPTION 'Invalid finance amount.'; END IF;
      v_number:=(v_value#>>'{}')::numeric;IF v_number::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid finance amount.'; END IF;
    ELSIF v_type='text' THEN IF jsonb_typeof(v_value)<>'string' THEN RAISE EXCEPTION 'Invalid finance text.'; END IF;
    ELSIF v_type='timestamp with time zone' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RAISE EXCEPTION 'Invalid finance timestamp.'; END IF;
      v_time:=(v_value#>>'{}')::timestamptz;
      IF NOT isfinite(v_time) OR substring(v_value#>>'{}' FROM 12 FOR 2)::integer>23 OR substring(v_value#>>'{}' FROM 15 FOR 2)::integer>59 OR substring(v_value#>>'{}' FROM 18 FOR 2)::integer>59 THEN RAISE EXCEPTION 'Invalid finance timestamp.'; END IF;
    ELSE RAISE EXCEPTION 'Unreviewed finance type.';END IF;
  END LOOP;
  IF p_key IN ('wallets','wallet_balance_baselines') AND p_row->'id' IS DISTINCT FROM p_row->'user_id' THEN RAISE EXCEPTION 'Finance wallet identity differs from its owner.'; END IF;
  v_record:=CASE WHEN p_key IN ('wallets','wallet_balance_baselines') THEN p_row-'id' ELSE p_row END;
  EXECUTE format('SELECT to_jsonb(r) FROM jsonb_populate_record(NULL::public.%I,$1) AS r',p_key) INTO v_cast USING v_record;
  FOR v_field,v_type IN SELECT key,value#>>'{}' FROM jsonb_each(v_spec) LOOP
    IF rtrim(v_type,'!')='numeric' AND v_cast->v_field IS DISTINCT FROM p_row->v_field THEN RAISE EXCEPTION 'Finance precision would be lost.'; END IF;
  END LOOP;
  SELECT string_agg('COALESCE(('||pg_get_expr(conbin,conrelid)||'),true)',' AND ') INTO v_checks FROM pg_constraint WHERE conrelid=to_regclass('public.'||p_key) AND contype='c';
  IF v_checks IS NOT NULL THEN
    EXECUTE format('SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) AS r',v_checks,p_key) INTO v_valid USING v_record;
    IF NOT v_valid THEN RAISE EXCEPTION 'Finance row violates target constraints.'; END IF;
  END IF;
END;
$$;

CREATE FUNCTION public.employee_import_finance_stage(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_expected jsonb;v_previous jsonb;v_last jsonb;v_line text;v_json json;v_rows jsonb:='[]';v_hashes text:='';v_count integer:=0;v_first text;v_cursor text;v_type text;v_bad boolean;v_total bigint;v_bytes bigint;v_count_total bigint;v_hash text;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');PERFORM private.employee_transfer_finance_owner(v_job);
  PERFORM private.employee_transfer_check_finance_catalog(v_job.summary->'finance_catalog');v_type:=private.employee_transfer_finance_cursor_type(p_table_key);
  SELECT value INTO v_expected FROM jsonb_array_elements(v_job.summary#>'{finance_catalog,tables}') WHERE value->>'key'=p_table_key;
  IF v_expected IS NULL OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 500000 OR p_ndjson IS NULL OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN RAISE EXCEPTION 'Invalid finance chunk.'; END IF;
  IF p_ndjson<>'' THEN FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS item(line) LOOP
    IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Finance row exceeds limits.'; END IF;
    BEGIN
      v_json:=v_line::json;
      IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN RAISE EXCEPTION 'Invalid JSON'; END IF;
      PERFORM private.employee_transfer_check_finance_row(p_table_key,v_json::jsonb);
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid finance import row.' USING ERRCODE='22023';END;
    EXECUTE 'SELECT $1::'||v_type||'>=$2::'||v_type INTO v_bad USING v_cursor,v_json->>'id';
    IF COALESCE(v_bad,false) THEN RAISE EXCEPTION 'Finance rows must be strictly ordered.'; END IF;
    v_cursor:=v_json->>'id';v_first:=COALESCE(v_first,v_cursor);v_rows:=v_rows||jsonb_build_array(v_json::jsonb);v_count:=v_count+1;
    v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    IF v_count>200 THEN RAISE EXCEPTION 'Finance chunk exceeds row limit.';END IF;
  END LOOP;END IF;
  IF v_count=0 AND (p_chunk_no<>0 OR (v_expected->>'rows')::bigint<>0) THEN RAISE EXCEPTION 'Invalid finance empty chunk.';END IF;
  v_hash:=encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex');
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='finance-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_previous IS NOT NULL THEN
    IF v_previous->>'ndjson' IS DISTINCT FROM p_ndjson THEN RAISE EXCEPTION 'Finance chunk content changed.';END IF;
    RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',true);
  END IF;
  IF v_job.summary ?| ARRAY['finance_plan','finance_restore'] THEN RAISE EXCEPTION 'Finance staging is frozen.';END IF;
  SELECT count(*),COALESCE(sum(row_count),0)+v_count,COALESCE(sum((payload->>'bytes')::bigint),0)+octet_length(p_ndjson) INTO v_total,v_count_total,v_bytes FROM private.employee_transfer_staging
    WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='finance-in:'||p_table_key;
  SELECT payload INTO v_last FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='finance-in:'||p_table_key AND chunk_no=p_chunk_no-1;
  EXECUTE 'SELECT $1::'||v_type||'>=$2::'||v_type INTO v_bad USING v_last->>'last_id',v_first;
  IF v_total<>p_chunk_no OR v_count_total>(v_expected->>'rows')::bigint OR v_bytes>(v_expected->>'bytes')::bigint OR (p_chunk_no>0 AND (v_last IS NULL OR v_bad)) THEN RAISE EXCEPTION 'Finance chunks exceed catalog or cursor order.';END IF;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','finance-in:'||p_table_key,p_chunk_no,v_count,
    jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_cursor));
  RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_finance_input(p_job_id uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT item.value->>'id',item.value FROM private.employee_transfer_staging AS stage CROSS JOIN LATERAL jsonb_array_elements(stage.payload->'rows') AS item(value)
    WHERE stage.job_id=p_job_id AND stage.employee_id='00000000-0000-0000-0000-000000000000' AND stage.table_key='finance-in:'||p_key;
$$;

CREATE FUNCTION private.employee_transfer_check_finance_input(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table jsonb;v_chunks bigint;v_rows bigint;v_bytes bigint;v_min integer;v_max integer;v_hash text;v_counts jsonb:='{}';
BEGIN
  PERFORM private.employee_transfer_finance_owner(p_job);PERFORM private.employee_transfer_check_finance_catalog(p_job.summary->'finance_catalog');
  FOR v_table IN SELECT value FROM jsonb_array_elements(p_job.summary#>'{finance_catalog,tables}') LOOP
    SELECT count(*),COALESCE(sum(row_count),0),COALESCE(sum((payload->>'bytes')::bigint),0),min(chunk_no),max(chunk_no),encode(extensions.digest(convert_to(COALESCE(string_agg(payload->>'row_hashes','' ORDER BY chunk_no),''),'UTF8'),'sha256'),'hex')
      INTO v_chunks,v_rows,v_bytes,v_min,v_max,v_hash FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='finance-in:'||(v_table->>'key');
    IF v_chunks=0 OR v_min<>0 OR v_max<>v_chunks-1 OR (v_rows=0 AND v_chunks<>1) OR v_rows<>(v_table->>'rows')::bigint OR v_bytes<>(v_table->>'bytes')::bigint OR v_hash IS DISTINCT FROM v_table->>'row_hashes_sha256' THEN RAISE EXCEPTION 'Finance staged catalog verification failed.';END IF;
    IF EXISTS(SELECT 1 FROM private.employee_transfer_finance_input(p_job.id,v_table->>'key') GROUP BY id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate finance row identity.';END IF;
    v_counts:=v_counts||jsonb_build_object(v_table->>'key',v_rows);
  END LOOP;
  RETURN v_counts;
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);END LOOP;
  REVOKE ALL ON FUNCTION public.employee_export_finance_begin(uuid,text,uuid),public.get_employee_export_finance_page(uuid,uuid,text,text,integer),public.employee_export_finance_verify(uuid,uuid),public.employee_export_finance_close(uuid,uuid),public.employee_import_finance_bind(uuid,uuid,jsonb),public.employee_import_finance_stage(uuid,uuid,text,integer,text) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.employee_export_finance_begin(uuid,text,uuid),public.get_employee_export_finance_page(uuid,uuid,text,text,integer),public.employee_export_finance_verify(uuid,uuid),public.employee_export_finance_close(uuid,uuid),public.employee_import_finance_bind(uuid,uuid,jsonb),public.employee_import_finance_stage(uuid,uuid,text,integer,text) TO anon,authenticated;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
