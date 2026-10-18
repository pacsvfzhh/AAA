BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_activity_spec()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT '{
    "employee_login_history":{"id":"uuid!","user_id":"uuid!","username":"text!","employee_id":"text!","action_type":"text!","ip_address":"text","user_agent":"text","session_id":"text","created_at":"timestamp with time zone","device_info":"jsonb","device_info_is_sql_null":"boolean!"},
    "work_sessions":{"id":"uuid!","user_id":"uuid!","start_time":"timestamp with time zone!","end_time":"timestamp with time zone","duration_minutes":"integer","created_at":"timestamp with time zone","last_heartbeat_at":"timestamp with time zone"},
    "work_stop_markers":{"id":"uuid!","user_id":"uuid!","stopped_at":"timestamp with time zone!"}
  }'::jsonb;
$$;

CREATE FUNCTION private.employee_transfer_activity_relation(p_key text)
RETURNS regclass LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  CASE p_key
    WHEN 'employee_login_history' THEN RETURN 'public.employee_login_history'::regclass;
    WHEN 'work_sessions' THEN RETURN 'public.work_sessions'::regclass;
    WHEN 'work_stop_markers' THEN RETURN 'private.employee_work_stop_markers'::regclass;
    ELSE RAISE EXCEPTION 'Unsupported employee activity table.';
  END CASE;
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_schema()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text; v_spec jsonb; v_actual jsonb;
BEGIN
  FOR v_key,v_spec IN SELECT key,value FROM jsonb_each(private.employee_transfer_activity_spec()) LOOP
    IF v_key='work_stop_markers' THEN v_spec:=v_spec-'id'; END IF;
    IF v_key='employee_login_history' THEN v_spec:=v_spec-'device_info_is_sql_null'; END IF;
    SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)||CASE WHEN attnotnull THEN '!' ELSE '' END) INTO v_actual
      FROM pg_attribute WHERE attrelid=private.employee_transfer_activity_relation(v_key) AND attnum>0 AND NOT attisdropped;
    IF v_actual IS DISTINCT FROM v_spec THEN RAISE EXCEPTION 'Unreviewed employee activity schema.'; END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_cursor_type(p_key text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF NOT private.employee_transfer_activity_spec() ? p_key OR p_key IS NULL THEN RAISE EXCEPTION 'Unsupported employee activity table.'; END IF;
  RETURN 'uuid';
END;
$$;

-- Export hashes every non-NULL session; only explicit target verification preserves the stored hash.
CREATE FUNCTION private.employee_transfer_activity_query(p_key text,p_export boolean DEFAULT true)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_spec jsonb; v_projection text; v_id text; v_relation regclass; v_table text;
BEGIN
  v_relation:=private.employee_transfer_activity_relation(p_key);
  IF p_export IS NULL THEN RAISE EXCEPTION 'An explicit activity query mode is required.'; END IF;
  SELECT format('%I.%I',n.nspname,c.relname) INTO v_table FROM pg_class AS c JOIN pg_namespace AS n ON n.oid=c.relnamespace WHERE c.oid=v_relation;
  v_spec:=private.employee_transfer_activity_spec()->p_key;
  v_id:=CASE WHEN p_key='work_stop_markers' THEN 'user_id' ELSE 'id' END;
  SELECT string_agg(format('%L,%s',key,CASE
    WHEN p_key='employee_login_history' AND key='device_info_is_sql_null' THEN 'src.device_info IS NULL'
    WHEN p_key='employee_login_history' AND key='session_id' AND p_export THEN
      'CASE WHEN src.session_id IS NULL THEN NULL ELSE ''history-''||encode(extensions.digest(convert_to((SELECT site_id::text FROM private.employee_transfer_site)||'':''||src.user_id::text||'':''||src.session_id,''UTF8''),''sha256''),''hex'') END'
    ELSE format('src.%I',CASE WHEN key='id' THEN v_id ELSE key END) END),',' ORDER BY key COLLATE "C") INTO v_projection FROM jsonb_each(v_spec);
  RETURN format('SELECT src.%I AS id,jsonb_build_object(%s) AS body FROM %s AS src JOIN public.users AS owner ON owner.id=src.user_id WHERE owner.archived_at IS NULL',v_id,v_projection,v_table);
END;
$$;

CREATE FUNCTION private.employee_transfer_check_activity_catalog(p_catalog jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text; v_table jsonb; v_index integer:=0; v_bytes bigint:=0;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_catalog,ARRAY['version','scope','site_id','package_id','identity_catalog','tables','full_site_complete'])
    OR p_catalog->'version' IS DISTINCT FROM '1'::jsonb OR p_catalog->>'scope' IS DISTINCT FROM 'employee-activity'
    OR p_catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(p_catalog->'tables') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_catalog->'tables')<>3 THEN RAISE EXCEPTION 'Invalid employee activity catalog.'; END IF;
  PERFORM private.employee_transfer_check_identity_catalog(p_catalog->'identity_catalog');
  IF p_catalog->'site_id' IS DISTINCT FROM p_catalog#>'{identity_catalog,site_id}'
    OR p_catalog->'package_id' IS DISTINCT FROM p_catalog#>'{identity_catalog,package_id}' THEN RAISE EXCEPTION 'Activity and identity source binding differs.'; END IF;
  FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions','work_stop_markers'] LOOP
    v_table:=p_catalog->'tables'->v_index;v_index:=v_index+1;
    IF NOT private.employee_transfer_exact_object(v_table,ARRAY['key','rows','bytes','row_hashes_sha256'])
      OR v_table->>'key' IS DISTINCT FROM v_key OR jsonb_typeof(v_table->'rows') IS DISTINCT FROM 'number'
      OR (v_table->>'rows') !~ '^(0|[1-9][0-9]{0,5})$' OR (v_table->>'rows')::bigint>500000
      OR jsonb_typeof(v_table->'bytes') IS DISTINCT FROM 'number' OR (v_table->>'bytes') !~ '^(0|[1-9][0-9]{0,8})$'
      OR (v_table->>'bytes')::bigint>268435456 OR ((v_table->>'rows')::bigint=0)<>((v_table->>'bytes')::bigint=0)
      OR jsonb_typeof(v_table->'row_hashes_sha256') IS DISTINCT FROM 'string' OR (v_table->>'row_hashes_sha256') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Invalid employee activity table catalog.';
    END IF;
    v_bytes:=v_bytes+(v_table->>'bytes')::bigint;
  END LOOP;
  IF v_bytes>1073741824 THEN RAISE EXCEPTION 'Employee activity catalog exceeds limits.'; END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_catalog(p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text; v_query text; v_rows bigint; v_bytes bigint; v_largest bigint; v_hash text; v_total bigint:=0; v_tables jsonb:='[]';
BEGIN
  PERFORM private.employee_transfer_activity_schema();
  FOREACH v_key IN ARRAY ARRAY['employee_login_history','work_sessions','work_stop_markers'] LOOP
    v_query:=private.employee_transfer_activity_query(v_key);
    EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),COALESCE(max(octet_length(body::text||E''\n'')),0) FROM ('||v_query||') AS r'
      INTO v_rows,v_bytes,v_largest;
    v_total:=v_total+v_bytes;
    IF v_rows>500000 OR v_bytes>268435456 OR v_total>1073741824 OR v_largest>65536 THEN RAISE EXCEPTION 'Activity export exceeds limits; no data was truncated.'; END IF;
    EXECUTE 'SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id),''''),''UTF8''),''sha256''),''hex'') FROM ('||v_query||') AS r' INTO v_hash;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
  END LOOP;
  RETURN jsonb_build_object('version',1,'scope','employee-activity','site_id',(SELECT site_id FROM private.employee_transfer_site),
    'package_id',p_package_id,'identity_catalog',private.employee_transfer_identity_catalog(p_package_id),'tables',v_tables,'full_site_complete',false);
END;
$$;

DO $isolate_activity$
DECLARE v_definition text; v_anchor text;
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_job(uuid,uuid,text)'::regprocedure);
  v_anchor:='    OR (v_job.options->>''export_protocol''=''employee-finance-v1'' AND p_kind<>''finance-export'')';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Activity protocol isolation anchor changed.'; END IF;
  v_definition:=replace(v_definition,v_anchor,E'    OR (v_job.options->>''export_protocol''=''employee-activity-v1'' AND p_kind<>''activity-export'')\n    OR (p_kind=''activity-export'' AND v_job.options->>''export_protocol'' IS DISTINCT FROM ''employee-activity-v1'')\n'||v_anchor);
  v_anchor:='WHEN ''finance-export'' THEN ''export''';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Activity task kind anchor changed.'; END IF;
  EXECUTE replace(v_definition,v_anchor,'WHEN ''activity-export'' THEN ''export'' '||v_anchor);
  v_definition:=pg_get_functiondef('public.get_employee_transfer_log(uuid,integer)'::regprocedure);
  v_anchor:='AND options->>''export_protocol'' IS DISTINCT FROM ''employee-finance-v1''';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Activity export log anchor changed.'; END IF;
  EXECUTE replace(v_definition,v_anchor,v_anchor||E'\n      AND options->>''export_protocol'' IS DISTINCT FROM ''employee-activity-v1''');
END;
$isolate_activity$;

CREATE FUNCTION public.employee_export_activity_begin(p_admin_session_token uuid,p_admin_password text,p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_begin jsonb; v_catalog jsonb;
BEGIN
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'An activity package id is required.'; END IF;
  v_begin:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'export',jsonb_build_object('export_protocol','employee-activity-v1','scope','employee-activity','package_id',p_package_id));
  IF NOT COALESCE((v_begin->>'success')::boolean,false) THEN RETURN v_begin; END IF;
  v_catalog:=private.employee_transfer_activity_catalog(p_package_id);
  UPDATE private.employee_transfer_jobs SET summary=jsonb_build_object('activity_catalog',v_catalog) WHERE id=(v_begin->>'job_id')::uuid;
  RETURN (v_begin-'server_time')||jsonb_build_object('catalog',v_catalog,'scope','employee-activity','full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_export_activity_page(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_query text; v_line text; v_text text:=''; v_count integer:=0; v_cursor text; v_row record; v_more boolean:=false;
BEGIN
  PERFORM private.employee_transfer_job(p_admin_session_token,p_job_token,'activity-export');
  PERFORM private.employee_transfer_activity_schema();PERFORM private.employee_transfer_activity_cursor_type(p_table_key);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid activity page size.'; END IF;
  v_query:=private.employee_transfer_activity_query(p_table_key);
  IF p_after IS NOT NULL THEN
    EXECUTE 'SELECT id::text FROM ('||v_query||') AS r WHERE id=$1::uuid' INTO v_cursor USING p_after;
    IF v_cursor IS NULL OR v_cursor IS DISTINCT FROM p_after THEN RAISE EXCEPTION 'Activity cursor disappeared or is not canonical.'; END IF;
  END IF;
  FOR v_row IN EXECUTE 'SELECT id::text AS cursor_id,body FROM ('||v_query||') AS r WHERE ($1::uuid IS NULL OR id>$1::uuid) ORDER BY id LIMIT $2' USING p_after,p_limit+1 LOOP
    v_line:=v_row.body::text||E'\n';
    IF octet_length(v_line)>65536 THEN RAISE EXCEPTION 'Activity export row exceeds limits.'; END IF;
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_line)>262144 THEN v_more:=true;EXIT;END IF;
    v_text:=v_text||v_line;v_count:=v_count+1;v_cursor:=v_row.cursor_id;
  END LOOP;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_text,'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_export_activity_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'activity-export');
  IF v_job.summary->'activity_catalog' IS DISTINCT FROM private.employee_transfer_activity_catalog((v_job.options->>'package_id')::uuid) THEN
    RAISE EXCEPTION 'Activity or identity source changed; discard the export and restart.';
  END IF;
  UPDATE private.employee_transfer_jobs SET summary=summary||'{"activity_verified":true}'::jsonb WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'export','activity_verified','{"scope":"employee-activity","full_site_complete":false}');
  RETURN '{"verified":true,"scope":"employee-activity","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_export_activity_close(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'activity-export');
  IF v_job.summary->'activity_verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Activity export has not been verified.'; END IF;
  PERFORM private.employee_transfer_end_job(v_job,'finished',v_job.summary||'{"scope":"employee-activity","full_site_complete":false}'::jsonb);
  RETURN '{"success":true,"scope":"employee-activity","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_owner(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;
BEGIN
  v_map:=private.employee_transfer_identity_admin_map(p_job);
  PERFORM private.employee_transfer_activity_schema();
  PERFORM private.employee_transfer_check_identity_catalog(p_job.summary->'identity_catalog');
  PERFORM private.employee_transfer_check_finance_catalog(p_job.summary->'finance_catalog');
  IF p_job.summary#>'{identity_restore,verified}' IS DISTINCT FROM 'true'::jsonb
    OR p_job.summary#>'{dependency_restore,verified}' IS DISTINCT FROM 'true'::jsonb
    OR p_job.summary#>'{finance_restore,verified}' IS DISTINCT FROM 'true'::jsonb
    OR p_job.summary#>'{identity_restore,admin_map}' IS DISTINCT FROM v_map
    OR p_job.summary#>'{dependency_restore,admin_map}' IS DISTINCT FROM v_map
    OR p_job.summary#>'{finance_restore,admin_map}' IS DISTINCT FROM v_map THEN
    RAISE EXCEPTION 'Verified same-package identities, dispatch dependencies and finance are required for activity.';
  END IF;
  IF p_job.summary#>'{identity_catalog,package_id}' IS DISTINCT FROM p_job.options->'package_id'
    OR p_job.summary#>'{identity_catalog,site_id}' IS DISTINCT FROM p_job.options#>'{catalog,site_id}'
    OR p_job.summary#>'{finance_catalog,identity_catalog}' IS DISTINCT FROM p_job.summary->'identity_catalog'
    OR p_job.summary#>'{finance_catalog,package_id}' IS DISTINCT FROM p_job.options->'package_id'
    OR p_job.summary#>'{finance_catalog,site_id}' IS DISTINCT FROM p_job.options#>'{catalog,site_id}' THEN RAISE EXCEPTION 'Activity prerequisite source binding changed.'; END IF;
  IF p_job.summary ? 'activity_catalog' AND (p_job.summary#>'{activity_catalog,identity_catalog}' IS DISTINCT FROM p_job.summary->'identity_catalog'
    OR p_job.summary#>'{activity_catalog,package_id}' IS DISTINCT FROM p_job.options->'package_id'
    OR p_job.summary#>'{activity_catalog,site_id}' IS DISTINCT FROM p_job.options#>'{catalog,site_id}') THEN RAISE EXCEPTION 'Activity source binding changed.'; END IF;
  RETURN v_map;
END;
$$;

CREATE FUNCTION public.employee_import_activity_bind(p_admin_session_token uuid,p_job_token uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  PERFORM private.employee_transfer_activity_owner(v_job);PERFORM private.employee_transfer_check_activity_catalog(p_catalog);
  IF p_catalog->'identity_catalog' IS DISTINCT FROM v_job.summary->'identity_catalog' THEN RAISE EXCEPTION 'Activity must match the exact restored identity catalog and source package.'; END IF;
  v_repeated:=v_job.summary ? 'activity_catalog';
  IF v_repeated THEN
    IF p_catalog IS DISTINCT FROM v_job.summary->'activity_catalog' THEN RAISE EXCEPTION 'The activity catalog binding is immutable.'; END IF;
  ELSE
    IF v_job.summary ?| ARRAY['activity_plan','activity_restore'] THEN RAISE EXCEPTION 'Activity binding is frozen.'; END IF;
    UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('activity_catalog',p_catalog) WHERE id=v_job.id;
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-activity','repeated',v_repeated,'full_site_complete',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_check_activity_row(p_key text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_spec jsonb:=private.employee_transfer_activity_spec()->p_key;v_field text;v_type text;v_value jsonb;v_time timestamptz;v_record jsonb;v_cast jsonb;v_checks text;v_valid boolean;v_relation regclass;v_table text;
BEGIN
  v_relation:=private.employee_transfer_activity_relation(p_key);
  IF v_spec IS NULL OR NOT private.employee_transfer_exact_object(p_row,ARRAY(SELECT key FROM jsonb_each(v_spec))) THEN RAISE EXCEPTION 'Unreviewed activity row fields.'; END IF;
  FOR v_field,v_type IN SELECT key,value#>>'{}' FROM jsonb_each(v_spec) LOOP
    v_value:=p_row->v_field;
    IF v_value='null'::jsonb THEN IF right(v_type,1)='!' THEN RAISE EXCEPTION 'Required activity field is null.'; END IF;CONTINUE;END IF;
    v_type:=rtrim(v_type,'!');
    IF v_type='uuid' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid activity identity.'; END IF;
      PERFORM (v_value#>>'{}')::uuid;
    ELSIF v_type='integer' THEN
      IF jsonb_typeof(v_value)<>'number' OR (v_value#>>'{}') !~ '^-?(0|[1-9][0-9]*)$'
        OR (v_value#>>'{}')::numeric NOT BETWEEN -2147483648 AND 2147483647 THEN RAISE EXCEPTION 'Invalid activity integer.'; END IF;
    ELSIF v_type='boolean' THEN IF jsonb_typeof(v_value)<>'boolean' THEN RAISE EXCEPTION 'Invalid activity boolean.'; END IF;
    ELSIF v_type='text' THEN IF jsonb_typeof(v_value)<>'string' THEN RAISE EXCEPTION 'Invalid activity text.'; END IF;
    ELSIF v_type='jsonb' THEN
      CONTINUE;
    ELSIF v_type='timestamp with time zone' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RAISE EXCEPTION 'Invalid activity timestamp.'; END IF;
      v_time:=(v_value#>>'{}')::timestamptz;
      IF NOT isfinite(v_time) OR substring(v_value#>>'{}' FROM 12 FOR 2)::integer>23 OR substring(v_value#>>'{}' FROM 15 FOR 2)::integer>59 OR substring(v_value#>>'{}' FROM 18 FOR 2)::integer>59 THEN RAISE EXCEPTION 'Invalid activity timestamp.'; END IF;
    ELSE RAISE EXCEPTION 'Unreviewed activity type.';END IF;
  END LOOP;
  IF p_key='employee_login_history' AND (p_row->>'action_type' NOT IN ('login','logout')
    OR (p_row->'session_id'<>'null'::jsonb AND (p_row->>'session_id') !~ '^history-[0-9a-f]{64}$')) THEN RAISE EXCEPTION 'Invalid activity login action or redacted session.'; END IF;
  IF p_key='work_stop_markers' AND p_row->'id' IS DISTINCT FROM p_row->'user_id' THEN RAISE EXCEPTION 'Activity stop marker identity differs from its owner.'; END IF;
  IF p_key='employee_login_history' AND p_row->'device_info_is_sql_null'='true'::jsonb AND p_row->'device_info' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Activity device SQL null marker differs from its value.';END IF;
  v_record:=CASE WHEN p_key='work_stop_markers' THEN p_row-'id' ELSE p_row-'device_info_is_sql_null' END;
  SELECT format('%I.%I',n.nspname,c.relname) INTO v_table FROM pg_class AS c JOIN pg_namespace AS n ON n.oid=c.relnamespace WHERE c.oid=v_relation;
  EXECUTE format('SELECT to_jsonb(r) FROM jsonb_populate_record(NULL::%s,$1) AS r',v_table) INTO v_cast USING v_record;
  IF p_key='employee_login_history' AND v_cast->'device_info' IS DISTINCT FROM p_row->'device_info' THEN RAISE EXCEPTION 'Activity JSON precision would be lost.'; END IF;
  SELECT string_agg('COALESCE(('||pg_get_expr(conbin,conrelid)||'),true)',' AND ') INTO v_checks FROM pg_constraint WHERE conrelid=v_relation AND contype='c';
  IF v_checks IS NOT NULL THEN
    EXECUTE format('SELECT %s FROM jsonb_populate_record(NULL::%s,$1) AS r',v_checks,v_table) INTO v_valid USING v_record;
    IF NOT v_valid THEN RAISE EXCEPTION 'Activity row violates target constraints.'; END IF;
  END IF;
END;
$$;

CREATE FUNCTION public.employee_import_activity_stage(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_expected jsonb;v_previous jsonb;v_last jsonb;v_line text;v_json json;v_rows jsonb:='[]';v_hashes text:='';v_count integer:=0;v_first text;v_cursor text;v_bad boolean;v_total bigint;v_bytes bigint;v_count_total bigint;v_hash text;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');PERFORM private.employee_transfer_activity_owner(v_job);
  PERFORM private.employee_transfer_check_activity_catalog(v_job.summary->'activity_catalog');PERFORM private.employee_transfer_activity_cursor_type(p_table_key);
  SELECT value INTO v_expected FROM jsonb_array_elements(v_job.summary#>'{activity_catalog,tables}') WHERE value->>'key'=p_table_key;
  IF v_expected IS NULL OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 500000 OR p_ndjson IS NULL OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN RAISE EXCEPTION 'Invalid activity chunk.'; END IF;
  IF p_ndjson<>'' THEN FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS item(line) LOOP
    IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Activity row exceeds limits.'; END IF;
    BEGIN
      v_json:=v_line::json;
      IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN RAISE EXCEPTION 'Invalid JSON'; END IF;
      PERFORM private.employee_transfer_check_activity_row(p_table_key,v_json::jsonb);
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid activity import row.' USING ERRCODE='22023';END;
    SELECT v_cursor::uuid>=(v_json->>'id')::uuid INTO v_bad;
    IF COALESCE(v_bad,false) THEN RAISE EXCEPTION 'Activity rows must be strictly ordered.'; END IF;
    v_cursor:=v_json->>'id';v_first:=COALESCE(v_first,v_cursor);v_rows:=v_rows||jsonb_build_array(v_json::jsonb);v_count:=v_count+1;
    v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    IF v_count>200 THEN RAISE EXCEPTION 'Activity chunk exceeds row limit.';END IF;
  END LOOP;END IF;
  IF v_count=0 AND (p_chunk_no<>0 OR (v_expected->>'rows')::bigint<>0) THEN RAISE EXCEPTION 'Invalid activity empty chunk.';END IF;
  v_hash:=encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex');
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='activity-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_previous IS NOT NULL THEN
    IF v_previous->>'ndjson' IS DISTINCT FROM p_ndjson THEN RAISE EXCEPTION 'Activity chunk content changed.';END IF;
    RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',true);
  END IF;
  IF v_job.summary ?| ARRAY['activity_plan','activity_restore'] THEN RAISE EXCEPTION 'Activity staging is frozen.';END IF;
  SELECT count(*),COALESCE(sum(row_count),0)+v_count,COALESCE(sum((payload->>'bytes')::bigint),0)+octet_length(p_ndjson) INTO v_total,v_count_total,v_bytes FROM private.employee_transfer_staging
    WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='activity-in:'||p_table_key;
  SELECT payload INTO v_last FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='activity-in:'||p_table_key AND chunk_no=p_chunk_no-1;
  SELECT (v_last->>'last_id')::uuid>=v_first::uuid INTO v_bad;
  IF v_total<>p_chunk_no OR v_count_total>(v_expected->>'rows')::bigint OR v_bytes>(v_expected->>'bytes')::bigint OR (p_chunk_no>0 AND (v_last IS NULL OR v_bad)) THEN RAISE EXCEPTION 'Activity chunks exceed catalog or cursor order.';END IF;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','activity-in:'||p_table_key,p_chunk_no,v_count,
    jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_cursor));
  RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_activity_input(p_job_id uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT item.value->>'id',item.value FROM private.employee_transfer_staging AS stage CROSS JOIN LATERAL jsonb_array_elements(stage.payload->'rows') AS item(value)
    WHERE stage.job_id=p_job_id AND stage.employee_id='00000000-0000-0000-0000-000000000000' AND stage.table_key='activity-in:'||p_key;
$$;

CREATE FUNCTION private.employee_transfer_check_activity_input(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table jsonb;v_chunks bigint;v_rows bigint;v_bytes bigint;v_min integer;v_max integer;v_hash text;v_counts jsonb:='{}';
BEGIN
  PERFORM private.employee_transfer_activity_owner(p_job);PERFORM private.employee_transfer_check_activity_catalog(p_job.summary->'activity_catalog');
  FOR v_table IN SELECT value FROM jsonb_array_elements(p_job.summary#>'{activity_catalog,tables}') LOOP
    SELECT count(*),COALESCE(sum(row_count),0),COALESCE(sum((payload->>'bytes')::bigint),0),min(chunk_no),max(chunk_no),encode(extensions.digest(convert_to(COALESCE(string_agg(payload->>'row_hashes','' ORDER BY chunk_no),''),'UTF8'),'sha256'),'hex')
      INTO v_chunks,v_rows,v_bytes,v_min,v_max,v_hash FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='activity-in:'||(v_table->>'key');
    IF v_chunks=0 OR v_min<>0 OR v_max<>v_chunks-1 OR (v_rows=0 AND v_chunks<>1) OR v_rows<>(v_table->>'rows')::bigint OR v_bytes<>(v_table->>'bytes')::bigint OR v_hash IS DISTINCT FROM v_table->>'row_hashes_sha256' THEN RAISE EXCEPTION 'Activity staged catalog verification failed.';END IF;
    IF EXISTS(SELECT 1 FROM private.employee_transfer_activity_input(p_job.id,v_table->>'key') GROUP BY id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate activity row identity.';END IF;
    v_counts:=v_counts||jsonb_build_object(v_table->>'key',v_rows);
  END LOOP;
  RETURN v_counts;
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);END LOOP;
  REVOKE ALL ON FUNCTION public.employee_export_activity_begin(uuid,text,uuid),public.get_employee_export_activity_page(uuid,uuid,text,text,integer),public.employee_export_activity_verify(uuid,uuid),public.employee_export_activity_close(uuid,uuid),public.employee_import_activity_bind(uuid,uuid,jsonb),public.employee_import_activity_stage(uuid,uuid,text,integer,text) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.employee_export_activity_begin(uuid,text,uuid),public.get_employee_export_activity_page(uuid,uuid,text,text,integer),public.employee_export_activity_verify(uuid,uuid),public.employee_export_activity_close(uuid,uuid),public.employee_import_activity_bind(uuid,uuid,jsonb),public.employee_import_activity_stage(uuid,uuid,text,integer,text) TO anon,authenticated;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
