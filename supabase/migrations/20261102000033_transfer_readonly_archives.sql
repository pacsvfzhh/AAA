BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

SELECT private.employee_transfer_assert_maintenance_guards();
CREATE TABLE private.employee_transfer_archive_records (
  source_site_id uuid NOT NULL,
  package_id uuid NOT NULL,
  table_key text NOT NULL CHECK (table_key IN ('content_audit_events','deleted_employee_accounts','deleted_employee_notifications','content_audit_recipient_versions','deleted_employee_summaries','deleted_employee_withdrawals')),
  source_id text NOT NULL,
  body jsonb NOT NULL,
  source_line text NOT NULL CHECK (octet_length(source_line) BETWEEN 1 AND 65536),
  job_id uuid NOT NULL REFERENCES private.employee_transfer_jobs(id),
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (source_site_id,package_id,table_key,source_id)
);
ALTER TABLE private.employee_transfer_archive_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.employee_transfer_archive_records FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zz_employee_transfer_maintenance BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON private.employee_transfer_archive_records FOR EACH STATEMENT EXECUTE FUNCTION private.employee_transfer_guard_write();
ALTER TABLE private.employee_transfer_archive_records ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance;

CREATE FUNCTION private.employee_transfer_archives_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT ARRAY['content_audit_events','deleted_employee_accounts','deleted_employee_notifications',
    'content_audit_recipient_versions','deleted_employee_summaries','deleted_employee_withdrawals']::text[];
$$;

CREATE FUNCTION private.employee_transfer_archives_spec()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT '{
    "content_audit_events":{"id":"uuid!","operation_id":"uuid!","entity_type":"text!","entity_id":"uuid!","action":"text!","owner_admin_id":"uuid!","owner_username":"text","actor_admin_id":"uuid","actor_username":"text!","actor_role":"text!","customer_id":"uuid","employee_id":"uuid","occurred_at":"timestamp with time zone!","before_data":"jsonb","after_data":"jsonb","media_refs":"jsonb!","clear_reason":"text","clear_started_at":"timestamp with time zone","cleared_at":"timestamp with time zone","cleared_by":"uuid","cleared_username":"text","employee_account":"text","message_created_at":"timestamp with time zone","before_data_sql_null":"boolean!","after_data_sql_null":"boolean!"},
    "deleted_employee_accounts":{"id":"uuid!","operation_id":"uuid!","employee_id":"uuid!","account_username":"text","employee_number":"text","account_created_at":"timestamp with time zone","account_remarks":"text","owner_admin_id":"uuid!","owner_username":"text","actor_admin_id":"uuid!","actor_username":"text!","actor_role":"text!","deletion_source":"text!","deleted_at":"timestamp with time zone!","cleared_at":"timestamp with time zone","cleared_by":"uuid","cleared_username":"text","clear_reason":"text","account_real_name":"text"},
    "deleted_employee_notifications":{"id":"uuid!","record_id":"uuid!","message_id":"uuid!","message_data":"jsonb","recipient_data":"jsonb","archived_event_id":"uuid","cleared_at":"timestamp with time zone","cleared_by":"uuid","clear_reason":"text","message_data_sql_null":"boolean!","recipient_data_sql_null":"boolean!"},
    "content_audit_recipient_versions":{"id":"text!","message_id":"uuid!","recipient_id":"uuid!","recipient_data":"jsonb!"},
    "deleted_employee_summaries":{"id":"uuid!","employee_id":"uuid!","source_present":"boolean!","is_verified":"boolean","total_income":"numeric","available_balance":"numeric","frozen_balance":"numeric","total_orders":"bigint!"},
    "deleted_employee_withdrawals":{"id":"text!","record_id":"uuid!","withdrawal_id":"uuid!","employee_id":"uuid!","amount":"numeric!","status":"text!","created_at":"timestamp with time zone"}
  }'::jsonb;
$$;

CREATE FUNCTION private.employee_transfer_archives_relation(p_key text)
RETURNS regclass LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF p_key IS NULL OR NOT p_key=ANY(private.employee_transfer_archives_keys()) THEN RAISE EXCEPTION 'Unsupported archive table.';END IF;
  IF p_key IN ('deleted_employee_summaries','deleted_employee_withdrawals') THEN RETURN 'private.deleted_employee_accounts'::regclass;END IF;
  RETURN to_regclass('private.'||p_key);
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_schema()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_spec jsonb;v_actual jsonb;
BEGIN
  PERFORM private.employee_transfer_assert_maintenance_guards();
  FOREACH v_key IN ARRAY (private.employee_transfer_archives_keys())[1:4] LOOP
    v_spec:=private.employee_transfer_archives_spec()->v_key;
    IF v_key='content_audit_recipient_versions' THEN v_spec:=v_spec-'id';END IF;
    IF v_key='content_audit_events' THEN v_spec:=v_spec-'before_data_sql_null'-'after_data_sql_null';END IF;
    IF v_key='deleted_employee_notifications' THEN v_spec:=v_spec-'message_data_sql_null'-'recipient_data_sql_null';END IF;
    SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)||CASE WHEN attnotnull THEN '!' ELSE '' END) INTO v_actual
      FROM pg_attribute WHERE attrelid=private.employee_transfer_archives_relation(v_key) AND attnum>0 AND NOT attisdropped;
    IF v_key='content_audit_events' AND v_actual->>'actor_admin_id'='uuid!' THEN
      v_actual:=jsonb_set(v_actual,'{actor_admin_id}','"uuid"'::jsonb);
    END IF;
    IF v_actual IS DISTINCT FROM v_spec THEN RAISE EXCEPTION 'Unreviewed archive schema.';END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_redact(p_value jsonb,p_depth integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_result jsonb;v_item record;
BEGIN
  IF p_depth>32 AND jsonb_typeof(p_value) IN ('object','array') THEN RAISE EXCEPTION 'Archive snapshot depth exceeds limits.';END IF;
  IF jsonb_typeof(p_value)='object' THEN
    v_result:='{}';
    FOR v_item IN SELECT key,value FROM jsonb_each(p_value) LOOP
      IF v_item.key=ANY(ARRAY['delivery_claim_token','delivery_claim_channel','delivery_claim_until','delivery_completed_claim_token',
        'password','password_hash','current_session_token','current_tab_id',
        'session_token','token_hash','access_token','refresh_token','service_role_key','anon_key']) THEN CONTINUE;END IF;
      v_result:=v_result||jsonb_build_object(v_item.key,private.employee_transfer_archives_redact(v_item.value,p_depth+1));
    END LOOP;
    RETURN v_result;
  ELSIF jsonb_typeof(p_value)='array' THEN
    SELECT COALESCE(jsonb_agg(private.employee_transfer_archives_redact(value,p_depth+1) ORDER BY n),'[]') INTO v_result
      FROM jsonb_array_elements(p_value) WITH ORDINALITY AS a(value,n);
    RETURN v_result;
  END IF;
  RETURN p_value;
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_cursor(p_key text,p_row jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF p_key='content_audit_recipient_versions' THEN RETURN (p_row->>'message_id')||':'||(p_row->>'recipient_id');END IF;
  IF p_key='deleted_employee_withdrawals' THEN RETURN (p_row->>'record_id')||':'||(p_row->>'withdrawal_id');END IF;
  RETURN p_row->>'id';
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_query(p_key text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_projection text;v_id text;
BEGIN
  PERFORM private.employee_transfer_archives_relation(p_key);
  IF p_key='deleted_employee_summaries' THEN
    RETURN 'SELECT r.id::text COLLATE "C" AS id,jsonb_build_object(''id'',r.id,''employee_id'',r.employee_id,
      ''source_present'',u.id IS NOT NULL,''is_verified'',u.is_verified,''total_income'',u.total_income,
      ''available_balance'',w.available_balance,''frozen_balance'',w.frozen_balance,
      ''total_orders'',(SELECT count(*)::text FROM public.orders o WHERE o.user_id=r.employee_id)) AS body
      FROM private.deleted_employee_accounts r LEFT JOIN public.users u ON u.id=r.employee_id LEFT JOIN public.wallets w ON w.user_id=r.employee_id';
  ELSIF p_key='deleted_employee_withdrawals' THEN
    RETURN 'SELECT (r.id::text||'':''||w.id::text) COLLATE "C" AS id,jsonb_build_object(''id'',r.id::text||'':''||w.id::text,
      ''record_id'',r.id,''withdrawal_id'',w.id,''employee_id'',r.employee_id,''amount'',w.amount,''status'',w.status,''created_at'',w.created_at) AS body
      FROM private.deleted_employee_accounts r JOIN public.withdrawals w ON w.user_id=r.employee_id';
  END IF;
  v_id:=CASE WHEN p_key='content_audit_recipient_versions' THEN 'src.message_id::text||'':''||src.recipient_id::text' ELSE 'src.id::text' END;
  SELECT string_agg(format('%L,%s',key,CASE WHEN key='id' THEN v_id
    WHEN key LIKE '%\_sql\_null' ESCAPE '\' THEN format('src.%I IS NULL',replace(key,'_sql_null',''))
    WHEN key IN ('before_data','after_data','message_data','recipient_data') THEN format('private.employee_transfer_archives_redact(src.%I)',key)
    ELSE format('src.%I',key) END),',' ORDER BY key COLLATE "C") INTO v_projection FROM jsonb_each(private.employee_transfer_archives_spec()->p_key);
  RETURN format('SELECT (%s) COLLATE "C" AS id,jsonb_build_object(%s) AS body FROM private.%I src',v_id,v_projection,p_key);
END;
$$;

CREATE FUNCTION private.employee_transfer_check_archives_row(p_key text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_spec jsonb:=private.employee_transfer_archives_spec()->p_key;v_field text;v_type text;v_value jsonb;v_time timestamptz;
BEGIN
  IF v_spec IS NULL OR NOT private.employee_transfer_exact_object(p_row,ARRAY(SELECT key FROM jsonb_each(v_spec))) THEN RAISE EXCEPTION 'Unreviewed archive fields.';END IF;
  IF p_row IS DISTINCT FROM private.employee_transfer_archives_redact(p_row) THEN RAISE EXCEPTION 'Archive contains excluded credentials or delivery claims.';END IF;
  FOR v_field,v_type IN SELECT key,value#>>'{}' FROM jsonb_each(v_spec) LOOP
    v_value:=p_row->v_field;
    IF v_value='null'::jsonb THEN IF right(v_type,1)='!' AND v_type<>'jsonb!' THEN RAISE EXCEPTION 'Required archive field is null.';END IF;CONTINUE;END IF;
    v_type:=rtrim(v_type,'!');
    IF v_type='uuid' THEN
      IF jsonb_typeof(v_value)<>'string' OR length(v_value#>>'{}')<>36 OR (v_value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid archive identity.';END IF;
    ELSIF v_type='boolean' THEN IF jsonb_typeof(v_value)<>'boolean' THEN RAISE EXCEPTION 'Invalid archive boolean.';END IF;
    ELSIF v_type='text' THEN IF jsonb_typeof(v_value)<>'string' THEN RAISE EXCEPTION 'Invalid archive text.';END IF;
    ELSIF v_type='numeric' THEN IF jsonb_typeof(v_value)<>'number' THEN RAISE EXCEPTION 'Invalid archive amount.';END IF;
    ELSIF v_type='bigint' THEN
      IF jsonb_typeof(v_value)<>'string' OR length(v_value#>>'{}')>19 OR (v_value#>>'{}') !~ '^(0|[1-9][0-9]*)$' OR (v_value#>>'{}')::bigint<0 THEN RAISE EXCEPTION 'Invalid archive count.';END IF;
    ELSIF v_type='timestamp with time zone' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|\+00:00)$' THEN RAISE EXCEPTION 'Invalid archive time.';END IF;
      v_time:=(v_value#>>'{}')::timestamptz;
      IF NOT isfinite(v_time) OR substring(v_value#>>'{}' FROM 12 FOR 2)::integer>23 OR substring(v_value#>>'{}' FROM 15 FOR 2)::integer>59 OR substring(v_value#>>'{}' FROM 18 FOR 2)::integer>59 THEN RAISE EXCEPTION 'Invalid archive time.';END IF;
    ELSIF v_type<>'jsonb' THEN RAISE EXCEPTION 'Unreviewed archive type.';END IF;
  END LOOP;
  IF p_row->>'id' IS DISTINCT FROM private.employee_transfer_archives_cursor(p_key,p_row) THEN RAISE EXCEPTION 'Archive composite identity differs.';END IF;
  IF p_key IN ('content_audit_recipient_versions','deleted_employee_withdrawals') THEN
    IF length(p_row->>'id')<>73 THEN RAISE EXCEPTION 'Invalid archive composite identity.';END IF;
  END IF;
  FOREACH v_field IN ARRAY CASE WHEN p_key='content_audit_events' THEN ARRAY['before_data','after_data']
    WHEN p_key='deleted_employee_notifications' THEN ARRAY['message_data','recipient_data'] ELSE ARRAY[]::text[] END LOOP
    IF p_row->(v_field||'_sql_null')='true'::jsonb AND p_row->v_field IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Archive SQL null marker differs.';END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_archives_catalog(p_catalog jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_table jsonb;v_index integer:=0;v_bytes bigint:=0;v_empty text:=encode(extensions.digest(''::bytea,'sha256'),'hex');
BEGIN
  IF NOT private.employee_transfer_exact_object(p_catalog,ARRAY['version','scope','site_id','package_id','tables','full_site_complete'])
    OR p_catalog->'version' IS DISTINCT FROM '1'::jsonb OR p_catalog->>'scope' IS DISTINCT FROM 'site-archives'
    OR p_catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(p_catalog->'tables') IS DISTINCT FROM 'array' OR jsonb_array_length(p_catalog->'tables')<>6 THEN RAISE EXCEPTION 'Invalid archives catalog.';END IF;
  IF jsonb_typeof(p_catalog->'site_id') IS DISTINCT FROM 'string' OR length(p_catalog->>'site_id')<>36 OR (p_catalog->>'site_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_catalog->'package_id') IS DISTINCT FROM 'string' OR length(p_catalog->>'package_id')<>36 OR (p_catalog->>'package_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid archive source binding.';END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_archives_keys() LOOP
    v_table:=p_catalog->'tables'->v_index;v_index:=v_index+1;
    IF NOT private.employee_transfer_exact_object(v_table,ARRAY['key','rows','bytes','row_hashes_sha256']) OR v_table->>'key' IS DISTINCT FROM v_key
      OR jsonb_typeof(v_table->'rows') IS DISTINCT FROM 'number' OR (v_table->>'rows') !~ '^(0|[1-9][0-9]{0,6})$' OR (v_table->>'rows')::bigint>500000
      OR jsonb_typeof(v_table->'bytes') IS DISTINCT FROM 'number' OR (v_table->>'bytes') !~ '^(0|[1-9][0-9]{0,8})$' OR (v_table->>'bytes')::bigint>268435456
      OR ((v_table->>'rows')::bigint=0)<>((v_table->>'bytes')::bigint=0)
      OR jsonb_typeof(v_table->'row_hashes_sha256') IS DISTINCT FROM 'string' OR length(v_table->>'row_hashes_sha256')<>64 OR (v_table->>'row_hashes_sha256') !~ '^[0-9a-f]{64}$'
      OR ((v_table->>'rows')::bigint=0 AND v_table->>'row_hashes_sha256' IS DISTINCT FROM v_empty) THEN RAISE EXCEPTION 'Invalid archives table catalog.';END IF;
    v_bytes:=v_bytes+(v_table->>'bytes')::bigint;
  END LOOP;
  IF v_bytes>1073741824 THEN RAISE EXCEPTION 'Archives catalog exceeds limits.';END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_catalog(p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_query text;v_rows bigint;v_bytes bigint;v_largest bigint;v_hash text;v_total bigint:=0;v_tables jsonb:='[]';v_row record;
BEGIN
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'An archives package id is required.';END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_archive_records) THEN
    RAISE EXCEPTION 'Previously transferred archive snapshots require a namespace-preserving re-export protocol; this export cannot omit them.';
  END IF;
  PERFORM private.employee_transfer_archives_schema();
  FOREACH v_key IN ARRAY private.employee_transfer_archives_keys() LOOP
    v_query:=private.employee_transfer_archives_query(v_key);
    EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),COALESCE(max(octet_length(body::text||E''\n'')),0) FROM ('||v_query||') AS r' INTO v_rows,v_bytes,v_largest;
    v_total:=v_total+v_bytes;
    IF v_rows>500000 OR v_bytes>268435456 OR v_total>1073741824 OR v_largest>65536
      THEN RAISE EXCEPTION 'Archives export exceeds limits; no data was truncated.';END IF;
    FOR v_row IN EXECUTE v_query LOOP PERFORM private.employee_transfer_check_archives_row(v_key,v_row.body);END LOOP;
    EXECUTE 'SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id COLLATE "C"),''''),''UTF8''),''sha256''),''hex'') FROM ('||v_query||') AS r' INTO v_hash;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
  END LOOP;
  RETURN jsonb_build_object('version',1,'scope','site-archives','site_id',(SELECT site_id FROM private.employee_transfer_site),
    'package_id',p_package_id,
    'tables',v_tables,'full_site_complete',false);
END;
$$;

DO $isolate_archives$
DECLARE v_definition text;v_anchor text;
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_job(uuid,uuid,text)'::regprocedure);
  v_anchor:='    OR (v_job.options->>''export_protocol''=''site-chat-v1'' AND p_kind<>''chat-export'')';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Archives protocol isolation anchor changed.';END IF;
  v_definition:=replace(v_definition,v_anchor,E'    OR (v_job.options->>''export_protocol''=''site-archives-v1'' AND p_kind<>''archives-export'')\n    OR (p_kind=''archives-export'' AND v_job.options->>''export_protocol'' IS DISTINCT FROM ''site-archives-v1'')\n'||v_anchor);
  v_anchor:='WHEN ''chat-export'' THEN ''export''';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Archives kind anchor changed.';END IF;
  EXECUTE replace(v_definition,v_anchor,'WHEN ''archives-export'' THEN ''export'' '||v_anchor);
  v_definition:=pg_get_functiondef('public.get_employee_transfer_log(uuid,integer)'::regprocedure);
  v_anchor:='AND options->>''export_protocol'' IS DISTINCT FROM ''site-chat-v1''';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Archives log anchor changed.';END IF;
  EXECUTE replace(v_definition,v_anchor,v_anchor||E'\n      AND options->>''export_protocol'' IS DISTINCT FROM ''site-archives-v1''');
END;
$isolate_archives$;

CREATE FUNCTION public.employee_export_archives_begin(p_admin_session_token uuid,p_admin_password text,p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_begin jsonb;v_catalog jsonb;
BEGIN
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'An archives package id is required.';END IF;
  v_begin:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'export',jsonb_build_object('export_protocol','site-archives-v1','scope','site-archives','package_id',p_package_id));
  IF NOT COALESCE((v_begin->>'success')::boolean,false) THEN RETURN v_begin;END IF;
  v_catalog:=private.employee_transfer_archives_catalog(p_package_id);
  UPDATE private.employee_transfer_jobs SET summary=jsonb_build_object('archives_catalog',v_catalog) WHERE id=(v_begin->>'job_id')::uuid;
  RETURN (v_begin-'server_time')||jsonb_build_object('catalog',v_catalog,'scope','site-archives','media_pending',true,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_export_archives_page(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_query text;v_line text;v_text text:='';v_count integer:=0;v_cursor text;v_row record;v_more boolean:=false;
BEGIN
  PERFORM private.employee_transfer_job(p_admin_session_token,p_job_token,'archives-export');PERFORM private.employee_transfer_archives_schema();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_after IS NOT NULL AND length(p_after)>256) THEN RAISE EXCEPTION 'Invalid archives page size or cursor.';END IF;
  v_query:=private.employee_transfer_archives_query(p_table_key);
  IF p_after IS NOT NULL THEN
    EXECUTE 'SELECT id FROM ('||v_query||') AS r WHERE id=$1 COLLATE "C"' INTO v_cursor USING p_after;
    IF v_cursor IS NULL THEN RAISE EXCEPTION 'Archives cursor disappeared or is not canonical.';END IF;
  END IF;
  FOR v_row IN EXECUTE 'SELECT id,body FROM ('||v_query||') AS r WHERE ($1::text IS NULL OR id>$1 COLLATE "C") ORDER BY id COLLATE "C" LIMIT $2' USING p_after,p_limit+1 LOOP
    PERFORM private.employee_transfer_check_archives_row(p_table_key,v_row.body);
    v_line:=v_row.body::text||E'\n';
    IF octet_length(v_line)>65536 THEN RAISE EXCEPTION 'Archives row exceeds limits.';END IF;
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_line)>262144 THEN v_more:=true;EXIT;END IF;
    v_text:=v_text||v_line;v_count:=v_count+1;v_cursor:=v_row.id;
  END LOOP;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_text,'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_export_archives_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'archives-export');
  IF v_job.summary->'archives_catalog' IS DISTINCT FROM private.employee_transfer_archives_catalog((v_job.options->>'package_id')::uuid) THEN RAISE EXCEPTION 'Archive source changed; discard the export and restart.';END IF;
  UPDATE private.employee_transfer_jobs SET summary=summary||'{"archives_verified":true}'::jsonb WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'export','archives_records_verified','{"scope":"site-archives","media_pending":true,"full_site_complete":false}');
  RETURN '{"verified":true,"scope":"site-archives","media_pending":true,"full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_export_archives_close(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'archives-export');
  IF v_job.summary->'archives_verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Archives records have not been verified.';END IF;
  PERFORM public.employee_export_archives_verify(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_end_job(v_job,'finished',v_job.summary||'{"scope":"site-archives","media_pending":true,"full_site_complete":false}'::jsonb);
  RETURN '{"success":true,"scope":"site-archives","media_pending":true,"full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_owner(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  PERFORM private.employee_transfer_archives_schema();
  IF p_job.options->>'import_protocol' IS DISTINCT FROM 'dispatch-submission-v1'
    OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance m WHERE m.singleton AND m.dirty AND m.job_id=p_job.id
      AND m.admin_id=p_job.admin_id AND m.plan_hash=p_job.summary->>'dispatch_plan_hash') THEN RAISE EXCEPTION 'The original dirty maintenance owner is required for archives.';END IF;
  IF p_job.summary ? 'archives_catalog' THEN
    PERFORM private.employee_transfer_check_archives_catalog(p_job.summary->'archives_catalog');
    IF p_job.summary#>'{archives_catalog,package_id}' IS DISTINCT FROM p_job.options->'package_id'
      OR p_job.summary#>'{archives_catalog,site_id}' IS DISTINCT FROM p_job.options#>'{catalog,site_id}'
      OR p_job.summary#>'{archives_catalog,site_id}' IS NOT DISTINCT FROM to_jsonb((SELECT site_id FROM private.employee_transfer_site)) THEN RAISE EXCEPTION 'Archive source binding differs from the original package.';END IF;
  END IF;
END;
$$;

CREATE FUNCTION public.employee_import_archives_bind(p_admin_session_token uuid,p_job_token uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');PERFORM private.employee_transfer_archives_owner(v_job);PERFORM private.employee_transfer_check_archives_catalog(p_catalog);
  IF p_catalog->'package_id' IS DISTINCT FROM v_job.options->'package_id' OR p_catalog->'site_id' IS DISTINCT FROM v_job.options#>'{catalog,site_id}'
    OR p_catalog->'site_id' IS NOT DISTINCT FROM to_jsonb((SELECT site_id FROM private.employee_transfer_site)) THEN RAISE EXCEPTION 'Archives must bind to the original package from a different site.';END IF;
  v_repeated:=v_job.summary ? 'archives_catalog';
  IF v_repeated THEN
    IF p_catalog IS DISTINCT FROM v_job.summary->'archives_catalog' THEN RAISE EXCEPTION 'The archives catalog binding is immutable.';END IF;
  ELSE UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('archives_catalog',p_catalog) WHERE id=v_job.id;END IF;
  RETURN jsonb_build_object('success',true,'scope','site-archives','repeated',v_repeated,'media_pending',true,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_archives_stage(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_expected jsonb;v_previous jsonb;v_last jsonb;v_line text;v_json json;v_rows jsonb:='[]';v_hashes text:='';v_count integer:=0;v_first text;v_cursor text;v_total bigint;v_bytes bigint;v_count_total bigint;v_hash text;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');PERFORM private.employee_transfer_archives_owner(v_job);
  PERFORM private.employee_transfer_check_archives_catalog(v_job.summary->'archives_catalog');PERFORM private.employee_transfer_archives_relation(p_table_key);
  SELECT value INTO v_expected FROM jsonb_array_elements(v_job.summary#>'{archives_catalog,tables}') WHERE value->>'key'=p_table_key;
  IF v_expected IS NULL OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 500000 OR p_ndjson IS NULL OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN RAISE EXCEPTION 'Invalid archives chunk.';END IF;
  IF p_ndjson<>'' THEN FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS item(line) LOOP
    IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Archives row exceeds limits.';END IF;
    BEGIN
      v_json:=v_line::json;
      IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_chat_unique_json(v_json) THEN RAISE EXCEPTION 'Invalid JSON';END IF;
      PERFORM private.employee_transfer_check_archives_row(p_table_key,v_json::jsonb);
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid archives import row.' USING ERRCODE='22023';END;
    IF v_cursor IS NOT NULL AND v_cursor COLLATE "C">=(v_json->>'id') COLLATE "C" THEN RAISE EXCEPTION 'Archives rows must be strictly ordered.';END IF;
    v_cursor:=v_json->>'id';v_first:=COALESCE(v_first,v_cursor);v_rows:=v_rows||jsonb_build_array(v_json::jsonb);v_count:=v_count+1;
    v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    IF v_count>200 THEN RAISE EXCEPTION 'Archives chunk exceeds row limit.';END IF;
  END LOOP;END IF;
  IF v_count=0 AND (p_chunk_no<>0 OR (v_expected->>'rows')::bigint<>0) THEN RAISE EXCEPTION 'Invalid archives empty chunk.';END IF;
  v_hash:=encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex');
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='archives-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_previous IS NOT NULL THEN
    IF v_previous->>'ndjson' IS DISTINCT FROM p_ndjson THEN RAISE EXCEPTION 'Archives chunk content changed.';END IF;
    RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',true);
  END IF;
  SELECT count(*),COALESCE(sum(row_count),0)+v_count,COALESCE(sum((payload->>'bytes')::bigint),0)+octet_length(p_ndjson) INTO v_total,v_count_total,v_bytes FROM private.employee_transfer_staging
    WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='archives-in:'||p_table_key;
  SELECT payload INTO v_last FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='archives-in:'||p_table_key AND chunk_no=p_chunk_no-1;
  IF v_total<>p_chunk_no OR v_count_total>(v_expected->>'rows')::bigint OR v_bytes>(v_expected->>'bytes')::bigint
    OR (p_chunk_no>0 AND (v_last IS NULL OR (v_last->>'last_id') COLLATE "C">=v_first COLLATE "C")) THEN RAISE EXCEPTION 'Archives chunks exceed catalog or cursor order.';END IF;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','archives-in:'||p_table_key,p_chunk_no,v_count,
    jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_cursor));
  RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_archives_input(p_job_id uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT item.value->>'id',item.value FROM private.employee_transfer_staging AS stage CROSS JOIN LATERAL jsonb_array_elements(stage.payload->'rows') AS item(value)
    WHERE stage.job_id=p_job_id AND stage.employee_id='00000000-0000-0000-0000-000000000000' AND stage.table_key='archives-in:'||p_key;
$$;

CREATE FUNCTION private.employee_transfer_check_archives_input(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table jsonb;v_chunks bigint;v_rows bigint;v_bytes bigint;v_min integer;v_max integer;v_hash text;v_counts jsonb:='{}';
BEGIN
  PERFORM private.employee_transfer_check_archives_catalog(p_job.summary->'archives_catalog');
  FOR v_table IN SELECT value FROM jsonb_array_elements(p_job.summary#>'{archives_catalog,tables}') LOOP
    SELECT count(*),COALESCE(sum(row_count),0),COALESCE(sum((payload->>'bytes')::bigint),0),min(chunk_no),max(chunk_no),encode(extensions.digest(convert_to(COALESCE(string_agg(payload->>'row_hashes','' ORDER BY chunk_no),''),'UTF8'),'sha256'),'hex')
      INTO v_chunks,v_rows,v_bytes,v_min,v_max,v_hash FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='archives-in:'||(v_table->>'key');
    IF v_chunks=0 OR v_min<>0 OR v_max<>v_chunks-1 OR (v_rows=0 AND v_chunks<>1) OR v_rows<>(v_table->>'rows')::bigint OR v_bytes<>(v_table->>'bytes')::bigint OR v_hash IS DISTINCT FROM v_table->>'row_hashes_sha256' THEN RAISE EXCEPTION 'Archives staged catalog verification failed.';END IF;
    IF EXISTS(SELECT 1 FROM private.employee_transfer_archives_input(p_job.id,v_table->>'key') GROUP BY id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate archives row identity.';END IF;
    v_counts:=v_counts||jsonb_build_object(v_table->>'key',v_rows);
  END LOOP;
  RETURN v_counts;
END;
$$;


DO $archive_guard_inventory$
DECLARE v_definition text;v_anchor constant text:='    ''private.content_audit_delete_jobs'',';
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_guarded_tables()'::regprocedure);
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Archive inventory anchor changed.';END IF;
  EXECUTE replace(v_definition,v_anchor,'    ''private.employee_transfer_archive_records'','||E'\n'||v_anchor);
END;
$archive_guard_inventory$;

DO $install_assert$
DECLARE v_manifest jsonb; v_functions jsonb;
BEGIN
  SELECT jsonb_object_agg(name, jsonb_build_object('oid', relation.oid, 'owner', relation.relowner,
    'kind', relation.relkind, 'partition', relation.relispartition,
    'parents', (SELECT COALESCE(jsonb_agg(inhparent ORDER BY inhparent),'[]') FROM pg_inherits WHERE inhrelid = relation.oid),
    'definition', pg_get_triggerdef(trigger.oid, false))) INTO v_manifest
    FROM unnest(private.employee_transfer_guarded_tables()) AS item(name)
    JOIN pg_class AS relation ON relation.oid = to_regclass(name)
    JOIN pg_trigger AS trigger ON trigger.tgrelid = relation.oid AND trigger.tgname = 'zz_employee_transfer_maintenance';
  SELECT jsonb_object_agg(procedure.oid::regprocedure::text, jsonb_build_object(
    'oid', procedure.oid, 'definition', pg_get_functiondef(procedure.oid), 'owner', procedure.proowner,
    'acl', procedure.proacl::text, 'super', role.rolsuper, 'bypassrls', role.rolbypassrls)) INTO v_functions
    FROM pg_proc AS procedure JOIN pg_roles AS role ON role.oid = procedure.proowner
    WHERE procedure.oid = ANY(ARRAY['private.employee_transfer_guarded_tables()'::regprocedure,
      'private.employee_transfer_guard_write()'::regprocedure,'private.employee_transfer_lock_maintenance_tables()'::regprocedure,
      'private.employee_transfer_allow_config_write(uuid)'::regprocedure,'private.employee_transfer_clear_write_permit()'::regprocedure]::oid[]);
  EXECUTE format($definition$
CREATE OR REPLACE FUNCTION private.employee_transfer_assert_maintenance_guards()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $body$
DECLARE v_tables constant jsonb := %L::jsonb; v_functions constant jsonb := %L::jsonb;
  v_actual text[]; v_item record; v_metadata jsonb; v_function jsonb;
BEGIN
  -- Explicit reviewed exclusions; a new table (even named employee_transfer_*) is rejected.
  SELECT array_agg(namespace.nspname||'.'||relation.relname ORDER BY (namespace.nspname||'.'||relation.relname) COLLATE "C")
    INTO v_actual FROM pg_class AS relation JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public','private') AND relation.relkind IN ('r','p','f')
      AND (namespace.nspname||'.'||relation.relname) <> ALL(ARRAY[
        'private.employee_transfer_events','private.employee_transfer_excluded_columns','private.employee_transfer_jobs',
        'private.employee_transfer_chat_backups','private.employee_transfer_notification_backups','private.employee_transfer_shared_backups','private.employee_transfer_site','private.employee_transfer_staging',
        'private.employee_transfer_trigger_policy','private.employee_transfer_maintenance','private.employee_transfer_write_permits',
        'public.admin_financial_sessions','public.financial_login_attempts','public.account_locks','public.account_lock_events','public.login_attempts']);
  IF v_actual IS DISTINCT FROM ARRAY(SELECT key FROM jsonb_each(v_tables) ORDER BY key COLLATE "C") THEN
    RAISE EXCEPTION 'Unreviewed employee transfer maintenance inventory or guards.';
  END IF;
  FOR v_item IN SELECT key, value FROM jsonb_each(v_functions) LOOP
    SELECT jsonb_build_object('oid', procedure.oid, 'definition', pg_get_functiondef(procedure.oid),
      'owner', procedure.proowner, 'acl', procedure.proacl::text, 'super', role.rolsuper, 'bypassrls', role.rolbypassrls)
      INTO v_function FROM pg_proc AS procedure JOIN pg_roles AS role ON role.oid = procedure.proowner
      WHERE procedure.oid = to_regprocedure(v_item.key);
    IF v_function IS DISTINCT FROM v_item.value THEN
      RAISE EXCEPTION 'Unreviewed employee transfer maintenance inventory or guards.';
    END IF;
  END LOOP;
  FOR v_item IN SELECT key, value FROM jsonb_each(v_tables) LOOP
    SELECT jsonb_build_object('oid', relation.oid, 'owner', relation.relowner, 'kind', relation.relkind,
      'partition', relation.relispartition,
      'parents', (SELECT COALESCE(jsonb_agg(inhparent ORDER BY inhparent),'[]') FROM pg_inherits WHERE inhrelid = relation.oid),
      'definition', pg_get_triggerdef(trigger.oid, false)) INTO v_metadata
      FROM pg_class AS relation JOIN pg_trigger AS trigger ON trigger.tgrelid = relation.oid
      WHERE relation.oid = to_regclass(v_item.key) AND NOT trigger.tgisinternal
        AND trigger.tgname = 'zz_employee_transfer_maintenance' AND trigger.tgenabled = 'A'
        AND trigger.tgfoid = 'private.employee_transfer_guard_write()'::regprocedure AND trigger.tgtype = 62;
    IF v_metadata IS DISTINCT FROM v_item.value THEN
      RAISE EXCEPTION 'Unreviewed employee transfer maintenance inventory or guards.';
    END IF;
  END LOOP;
END;
$body$;
$definition$, v_manifest::text, v_functions::text);
END;
$install_assert$;
REVOKE ALL ON FUNCTION private.employee_transfer_assert_maintenance_guards() FROM PUBLIC, anon, authenticated, service_role;
SELECT private.employee_transfer_assert_maintenance_guards();

DO $archive_permissions$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace
    AND (proname LIKE 'employee_transfer_archives_%' OR proname LIKE 'employee_transfer_check_archives_%') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
END;
$archive_permissions$;
REVOKE ALL ON FUNCTION public.employee_export_archives_begin(uuid,text,uuid),public.get_employee_export_archives_page(uuid,uuid,text,text,integer),
  public.employee_export_archives_verify(uuid,uuid),public.employee_export_archives_close(uuid,uuid),
  public.employee_import_archives_bind(uuid,uuid,jsonb),public.employee_import_archives_stage(uuid,uuid,text,integer,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_export_archives_begin(uuid,text,uuid),public.get_employee_export_archives_page(uuid,uuid,text,text,integer),
  public.employee_export_archives_verify(uuid,uuid),public.employee_export_archives_close(uuid,uuid),
  public.employee_import_archives_bind(uuid,uuid,jsonb),public.employee_import_archives_stage(uuid,uuid,text,integer,text)
  TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
