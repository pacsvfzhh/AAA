BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- 仅传输聊天记录原文及暂存目录，不写业务表、不解冻富卡、不搬迁媒体，亦不解除维护。
-- 全量读取十表（包括无聊天角色、未引用库和档案关联）；员工引用由后续计划报告，不能在此静默过滤。
CREATE FUNCTION private.employee_transfer_chat_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT ARRAY['simulated_customers','cs_message_templates','customer_auto_messages','rich_card_contents',
    'customer_employee_conversations','customer_service_sessions','ccc_conversation_annotations',
    'customer_auto_message_logs','rating_requests','service_ratings']::text[];
$$;

-- 固定列/类型来自 transfer-scope.mjs inventory；id 与 rating_data_sql_null 仅为下述两表的虚拟字段。
CREATE FUNCTION private.employee_transfer_chat_spec()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT '{
    "simulated_customers":{"id":"uuid!","admin_id":"uuid!","customer_name":"text!","customer_avatar":"text","is_active":"boolean","created_at":"timestamp with time zone","updated_at":"timestamp with time zone","customer_id":"text!","is_super":"boolean!","super_customer_title":"text","badge_type":"text","custom_avatar_url":"text","is_pinned":"boolean!","vip_label":"text","remarks":"text","source_type":"text!","employee_pin_top":"boolean!","employee_always_visible":"boolean!","target_employee_id":"uuid","target_employee_ids":"uuid[]","auto_messages_enabled":"boolean!"},
    "cs_message_templates":{"id":"uuid!","admin_id":"text!","name":"text!","content":"text!","content_type":"text!","sort_order":"integer!","created_at":"timestamp with time zone!","updated_at":"timestamp with time zone!","is_pinned":"boolean!","source_type":"text!","title":"text","subtitle":"text"},
    "customer_auto_messages":{"id":"uuid!","customer_id":"uuid!","admin_id":"text!","message_type":"text!","name":"text!","title":"text","subtitle":"text","content":"text!","content_type":"text!","sort_order":"integer!","is_enabled":"boolean!","created_at":"timestamp with time zone!","updated_at":"timestamp with time zone!"},
    "rich_card_contents":{"id":"uuid!","html_content":"text!","created_at":"timestamp with time zone!","source_template_id":"uuid","source_auto_message_id":"uuid","content_hash":"text"},
    "customer_employee_conversations":{"id":"uuid!","customer_id":"uuid!","employee_id":"uuid!","sender_type":"text!","message_content":"text!","is_read":"boolean","created_at":"timestamp with time zone","message_type":"text","image_url":"text","rating_data":"jsonb","read_at":"timestamp with time zone","source_type":"text!","title":"text","rich_card_content_id":"uuid","subtitle":"text","source_template_id":"uuid","source_auto_message_id":"uuid","content_frozen":"boolean!","rating_data_sql_null":"boolean!"},
    "customer_service_sessions":{"id":"uuid!","customer_id":"uuid!","employee_id":"uuid!","service_ticket_number":"text!","status":"text!","created_at":"timestamp with time zone","closed_at":"timestamp with time zone"},
    "ccc_conversation_annotations":{"id":"text!","customer_id":"uuid!","employee_id":"uuid!","owner_admin_id":"uuid!","is_special":"boolean!","note":"text","updated_by":"uuid","updated_at":"timestamp with time zone!"},
    "customer_auto_message_logs":{"id":"uuid!","customer_id":"uuid!","employee_id":"uuid!","auto_message_id":"uuid!","sent_at":"timestamp with time zone!"},
    "rating_requests":{"id":"uuid!","customer_id":"uuid!","employee_id":"uuid!","session_id":"uuid","status":"text","requested_at":"timestamp with time zone","completed_at":"timestamp with time zone"},
    "service_ratings":{"id":"uuid!","customer_id":"uuid!","employee_id":"uuid!","session_id":"uuid","rating":"integer!","comment":"text","created_at":"timestamp with time zone"}
  }'::jsonb;
$$;

CREATE FUNCTION private.employee_transfer_chat_relation(p_key text)
RETURNS regclass LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF p_key IS NULL OR NOT p_key=ANY(private.employee_transfer_chat_keys()) THEN RAISE EXCEPTION 'Unsupported chat table.';END IF;
  RETURN to_regclass('public.'||p_key);
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_schema()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_spec jsonb;v_actual jsonb;v_relation regclass;
BEGIN
  FOREACH v_key IN ARRAY private.employee_transfer_chat_keys() LOOP
    v_relation:=private.employee_transfer_chat_relation(v_key);
    v_spec:=private.employee_transfer_chat_spec()->v_key;
    IF v_key='ccc_conversation_annotations' THEN v_spec:=v_spec-'id';END IF;
    IF v_key='customer_employee_conversations' THEN v_spec:=v_spec-'rating_data_sql_null';END IF;
    SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)||CASE WHEN attnotnull THEN '!' ELSE '' END) INTO v_actual
      FROM pg_attribute WHERE attrelid=v_relation AND attnum>0 AND NOT attisdropped;
    IF v_relation IS NULL OR v_actual IS DISTINCT FROM v_spec THEN RAISE EXCEPTION 'Unreviewed chat schema.';END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_cursor(p_key text,p_row jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF p_key IS NULL OR NOT p_key=ANY(private.employee_transfer_chat_keys()) THEN RAISE EXCEPTION 'Unsupported chat table.';END IF;
  IF p_key='ccc_conversation_annotations' THEN RETURN (p_row->>'customer_id')||':'||(p_row->>'employee_id');END IF;
  RETURN p_row->>'id';
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_query(p_key text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_relation regclass;v_projection text;v_id text;
BEGIN
  v_relation:=private.employee_transfer_chat_relation(p_key);
  IF v_relation IS NULL THEN RAISE EXCEPTION 'Chat table is missing.';END IF;
  v_id:=CASE WHEN p_key='ccc_conversation_annotations' THEN 'src.customer_id::text||'':''||src.employee_id::text' ELSE 'src.id::text' END;
  SELECT string_agg(format('%L,%s',key,CASE
    WHEN key='id' THEN v_id
    WHEN p_key='customer_employee_conversations' AND key='rating_data_sql_null' THEN 'src.rating_data IS NULL'
    ELSE format('src.%I',key) END),',' ORDER BY key COLLATE "C")
    INTO v_projection FROM jsonb_each(private.employee_transfer_chat_spec()->p_key);
  RETURN format('SELECT (%s) COLLATE "C" AS id,jsonb_build_object(%s) AS body FROM public.%I AS src',v_id,v_projection,p_key);
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_unique_json(p_value json,p_depth integer DEFAULT 0)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_item json;
BEGIN
  IF json_typeof(p_value) IN ('object','array') AND p_depth>32 THEN RETURN false;END IF;
  IF json_typeof(p_value)='object' THEN
    IF (SELECT count(*)<>count(DISTINCT key) FROM json_each(p_value)) THEN RETURN false;END IF;
    FOR v_item IN SELECT value FROM json_each(p_value) LOOP
      IF NOT private.employee_transfer_chat_unique_json(v_item,p_depth+1) THEN RETURN false;END IF;
    END LOOP;
  ELSIF json_typeof(p_value)='array' THEN
    FOR v_item IN SELECT value FROM json_array_elements(p_value) LOOP
      IF NOT private.employee_transfer_chat_unique_json(v_item,p_depth+1) THEN RETURN false;END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_chat_row(p_key text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_spec jsonb:=private.employee_transfer_chat_spec()->p_key;v_field text;v_type text;v_value jsonb;v_item jsonb;
  v_time timestamptz;v_checks text;v_valid boolean;v_relation regclass;v_row jsonb;v_message public.customer_employee_conversations%ROWTYPE;
BEGIN
  v_relation:=private.employee_transfer_chat_relation(p_key);
  IF v_relation IS NULL OR v_spec IS NULL OR NOT private.employee_transfer_exact_object(p_row,ARRAY(SELECT key FROM jsonb_each(v_spec))) THEN RAISE EXCEPTION 'Unreviewed chat fields.';END IF;
  FOR v_field,v_type IN SELECT key,value#>>'{}' FROM jsonb_each(v_spec) LOOP
    v_value:=p_row->v_field;
    IF v_value='null'::jsonb THEN IF right(v_type,1)='!' THEN RAISE EXCEPTION 'Required chat field is null.';END IF;CONTINUE;END IF;
    v_type:=rtrim(v_type,'!');
    IF v_type='uuid' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid chat identity.';END IF;
      PERFORM (v_value#>>'{}')::uuid;
    ELSIF v_type='uuid[]' THEN
      IF jsonb_typeof(v_value)<>'array' THEN RAISE EXCEPTION 'Invalid chat identity array.';END IF;
      FOR v_item IN SELECT value FROM jsonb_array_elements(v_value) LOOP
        IF jsonb_typeof(v_item)<>'string' OR (v_item#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid chat array identity.';END IF;
        PERFORM (v_item#>>'{}')::uuid;
      END LOOP;
    ELSIF v_type='integer' THEN
      IF jsonb_typeof(v_value)<>'number' OR (v_value#>>'{}') !~ '^-?(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION 'Invalid chat integer.';END IF;
      PERFORM (v_value#>>'{}')::integer;
    ELSIF v_type='boolean' THEN IF jsonb_typeof(v_value)<>'boolean' THEN RAISE EXCEPTION 'Invalid chat boolean.';END IF;
    ELSIF v_type='text' THEN IF jsonb_typeof(v_value)<>'string' THEN RAISE EXCEPTION 'Invalid chat text.';END IF;
    ELSIF v_type='jsonb' THEN NULL;
    ELSIF v_type='timestamp with time zone' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|\+00:00)$' THEN RAISE EXCEPTION 'Invalid chat timestamp.';END IF;
      v_time:=(v_value#>>'{}')::timestamptz;
      IF NOT isfinite(v_time) OR substring(v_value#>>'{}' FROM 12 FOR 2)::integer>23 OR substring(v_value#>>'{}' FROM 15 FOR 2)::integer>59 OR substring(v_value#>>'{}' FROM 18 FOR 2)::integer>59 THEN RAISE EXCEPTION 'Invalid chat timestamp.';END IF;
    ELSE RAISE EXCEPTION 'Unreviewed chat type.';END IF;
  END LOOP;
  IF p_row->>'id' IS DISTINCT FROM private.employee_transfer_chat_cursor(p_key,p_row) THEN RAISE EXCEPTION 'Chat composite identity differs.';END IF;
  IF p_key='customer_employee_conversations' AND p_row->'rating_data_sql_null'='true'::jsonb
    AND p_row->'rating_data' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'Chat rating SQL null marker differs from its value.';END IF;
  v_row:=CASE WHEN p_key='ccc_conversation_annotations' THEN p_row-'id' ELSE p_row END;
  v_row:=v_row-'rating_data_sql_null';
  -- 所有 CHECK 均在剔除虚拟字段后的真实复合类型上执行，包括后续新增的 CHECK。
  SELECT string_agg('COALESCE(('||pg_get_expr(conbin,conrelid)||'),true)',' AND ') INTO v_checks
    FROM pg_constraint WHERE conrelid=v_relation AND contype='c';
  IF p_key='customer_employee_conversations' THEN
    SELECT * INTO v_message FROM jsonb_populate_record(NULL::public.customer_employee_conversations,v_row);
    IF to_jsonb(v_message)->'rating_data' IS DISTINCT FROM p_row->'rating_data' THEN RAISE EXCEPTION 'Chat JSON precision would be lost.';END IF;
    -- populate_record 把 JSON null 转为 SQL NULL；类型化基底恢复两者差别，空对象不再改写该列。
    v_message.rating_data:=CASE WHEN p_row->'rating_data_sql_null'='true'::jsonb THEN NULL ELSE p_row->'rating_data' END;
    IF v_checks IS NOT NULL THEN
      EXECUTE format('SELECT %s FROM jsonb_populate_record($1::public.customer_employee_conversations,''{}''::jsonb) AS r',v_checks)
        INTO v_valid USING v_message;
      IF NOT v_valid THEN RAISE EXCEPTION 'Chat row violates target constraints.';END IF;
    END IF;
  ELSIF v_checks IS NOT NULL THEN
    EXECUTE format('SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) AS r',v_checks,p_key) INTO v_valid USING v_row;
    IF NOT v_valid THEN RAISE EXCEPTION 'Chat row violates target constraints.';END IF;
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_chat_catalog(p_catalog jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_table jsonb;v_index integer:=0;v_bytes bigint:=0;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_catalog,ARRAY['version','scope','site_id','package_id','identity_catalog','finance_catalog','tables','full_site_complete'])
    OR p_catalog->'version' IS DISTINCT FROM '1'::jsonb OR p_catalog->>'scope' IS DISTINCT FROM 'site-chat'
    OR p_catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(p_catalog->'tables') IS DISTINCT FROM 'array' OR jsonb_array_length(p_catalog->'tables')<>10 THEN RAISE EXCEPTION 'Invalid chat catalog.';END IF;
  PERFORM private.employee_transfer_check_identity_catalog(p_catalog->'identity_catalog');PERFORM private.employee_transfer_check_finance_catalog(p_catalog->'finance_catalog');
  IF p_catalog->'identity_catalog' IS DISTINCT FROM p_catalog#>'{finance_catalog,identity_catalog}'
    OR p_catalog->'site_id' IS DISTINCT FROM p_catalog#>'{identity_catalog,site_id}' OR p_catalog->'package_id' IS DISTINCT FROM p_catalog#>'{identity_catalog,package_id}' THEN RAISE EXCEPTION 'Chat, finance and identity source binding differs.';END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_chat_keys() LOOP
    v_table:=p_catalog->'tables'->v_index;v_index:=v_index+1;
    IF NOT private.employee_transfer_exact_object(v_table,ARRAY['key','rows','bytes','row_hashes_sha256']) OR v_table->>'key' IS DISTINCT FROM v_key
      OR jsonb_typeof(v_table->'rows') IS DISTINCT FROM 'number' OR (v_table->>'rows') !~ '^(0|[1-9][0-9]{0,6})$' OR (v_table->>'rows')::bigint>1000000
      OR jsonb_typeof(v_table->'bytes') IS DISTINCT FROM 'number' OR (v_table->>'bytes') !~ '^(0|[1-9][0-9]{0,8})$' OR (v_table->>'bytes')::bigint>536870912
      OR ((v_table->>'rows')::bigint=0)<>((v_table->>'bytes')::bigint=0)
      OR jsonb_typeof(v_table->'row_hashes_sha256') IS DISTINCT FROM 'string' OR (v_table->>'row_hashes_sha256') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid chat table catalog.';END IF;
    IF v_key='simulated_customers' AND (v_table->>'rows')::bigint>2000 THEN RAISE EXCEPTION 'Chat role catalog exceeds limits.';END IF;
    v_bytes:=v_bytes+(v_table->>'bytes')::bigint;
  END LOOP;
  IF v_bytes>1073741824 THEN RAISE EXCEPTION 'Chat catalog exceeds limits.';END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_catalog(p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_query text;v_rows bigint;v_bytes bigint;v_largest bigint;v_hash text;v_total bigint:=0;v_tables jsonb:='[]';v_row record;v_finance jsonb;
BEGIN
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'A chat package id is required.';END IF;
  PERFORM private.employee_transfer_chat_schema();
  v_finance:=private.employee_transfer_finance_catalog(p_package_id);
  FOREACH v_key IN ARRAY private.employee_transfer_chat_keys() LOOP
    v_query:=private.employee_transfer_chat_query(v_key);
    EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),COALESCE(max(octet_length(body::text||E''\n'')),0) FROM ('||v_query||') AS r' INTO v_rows,v_bytes,v_largest;
    v_total:=v_total+v_bytes;
    IF v_rows>1000000 OR v_bytes>536870912 OR v_total>1073741824 OR v_largest>65536
      OR (v_key='simulated_customers' AND v_rows>2000) THEN RAISE EXCEPTION 'Chat export exceeds limits; no data was truncated.';END IF;
    FOR v_row IN EXECUTE v_query LOOP PERFORM private.employee_transfer_check_chat_row(v_key,v_row.body);END LOOP;
    EXECUTE 'SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id COLLATE "C"),''''),''UTF8''),''sha256''),''hex'') FROM ('||v_query||') AS r' INTO v_hash;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
  END LOOP;
  RETURN jsonb_build_object('version',1,'scope','site-chat','site_id',(SELECT site_id FROM private.employee_transfer_site),
    'package_id',p_package_id,'identity_catalog',v_finance->'identity_catalog','finance_catalog',v_finance,
    'tables',v_tables,'full_site_complete',false);
END;
$$;

DO $isolate_chat$
DECLARE v_definition text;v_anchor text;
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_job(uuid,uuid,text)'::regprocedure);
  v_anchor:='    OR (v_job.options->>''export_protocol''=''site-notifications-v1'' AND p_kind<>''notifications-export'')';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Chat protocol isolation anchor changed.';END IF;
  v_definition:=replace(v_definition,v_anchor,E'    OR (v_job.options->>''export_protocol''=''site-chat-v1'' AND p_kind<>''chat-export'')\n    OR (p_kind=''chat-export'' AND v_job.options->>''export_protocol'' IS DISTINCT FROM ''site-chat-v1'')\n'||v_anchor);
  v_anchor:='WHEN ''notifications-export'' THEN ''export''';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Chat kind anchor changed.';END IF;
  EXECUTE replace(v_definition,v_anchor,'WHEN ''chat-export'' THEN ''export'' '||v_anchor);
  v_definition:=pg_get_functiondef('public.get_employee_transfer_log(uuid,integer)'::regprocedure);
  v_anchor:='AND options->>''export_protocol'' IS DISTINCT FROM ''site-notifications-v1''';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Chat log anchor changed.';END IF;
  EXECUTE replace(v_definition,v_anchor,v_anchor||E'\n      AND options->>''export_protocol'' IS DISTINCT FROM ''site-chat-v1''');
END;
$isolate_chat$;

CREATE FUNCTION public.employee_export_chat_begin(p_admin_session_token uuid,p_admin_password text,p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_begin jsonb;v_catalog jsonb;
BEGIN
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'A chat package id is required.';END IF;
  v_begin:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'export',jsonb_build_object('export_protocol','site-chat-v1','scope','site-chat','package_id',p_package_id));
  IF NOT COALESCE((v_begin->>'success')::boolean,false) THEN RETURN v_begin;END IF;
  v_catalog:=private.employee_transfer_chat_catalog(p_package_id);
  UPDATE private.employee_transfer_jobs SET summary=jsonb_build_object('chat_catalog',v_catalog) WHERE id=(v_begin->>'job_id')::uuid;
  RETURN (v_begin-'server_time')||jsonb_build_object('catalog',v_catalog,'scope','site-chat','media_pending',true,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_export_chat_page(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_query text;v_line text;v_text text:='';v_count integer:=0;v_cursor text;v_row record;v_more boolean:=false;
BEGIN
  PERFORM private.employee_transfer_job(p_admin_session_token,p_job_token,'chat-export');PERFORM private.employee_transfer_chat_schema();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_after IS NOT NULL AND length(p_after)>256) THEN RAISE EXCEPTION 'Invalid chat page size or cursor.';END IF;
  v_query:=private.employee_transfer_chat_query(p_table_key);
  IF p_after IS NOT NULL THEN
    EXECUTE 'SELECT id FROM ('||v_query||') AS r WHERE id=$1 COLLATE "C"' INTO v_cursor USING p_after;
    IF v_cursor IS NULL THEN RAISE EXCEPTION 'Chat cursor disappeared or is not canonical.';END IF;
  END IF;
  FOR v_row IN EXECUTE 'SELECT id,body FROM ('||v_query||') AS r WHERE ($1::text IS NULL OR id>$1 COLLATE "C") ORDER BY id COLLATE "C" LIMIT $2' USING p_after,p_limit+1 LOOP
    PERFORM private.employee_transfer_check_chat_row(p_table_key,v_row.body);
    v_line:=v_row.body::text||E'\n';
    IF octet_length(v_line)>65536 THEN RAISE EXCEPTION 'Chat row exceeds limits.';END IF;
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_line)>262144 THEN v_more:=true;EXIT;END IF;
    v_text:=v_text||v_line;v_count:=v_count+1;v_cursor:=v_row.id;
  END LOOP;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_text,'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_export_chat_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'chat-export');
  IF v_job.summary->'chat_catalog' IS DISTINCT FROM private.employee_transfer_chat_catalog((v_job.options->>'package_id')::uuid) THEN RAISE EXCEPTION 'Chat, finance or identity source changed; discard the export and restart.';END IF;
  UPDATE private.employee_transfer_jobs SET summary=summary||'{"chat_verified":true}'::jsonb WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'export','chat_records_verified','{"scope":"site-chat","media_pending":true,"full_site_complete":false}');
  RETURN '{"verified":true,"scope":"site-chat","media_pending":true,"full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_export_chat_close(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'chat-export');
  IF v_job.summary->'chat_verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Chat records have not been verified.';END IF;
  PERFORM public.employee_export_chat_verify(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_end_job(v_job,'finished',v_job.summary||'{"scope":"site-chat","media_pending":true,"full_site_complete":false}'::jsonb);
  RETURN '{"success":true,"scope":"site-chat","media_pending":true,"full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_owner(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;
BEGIN
  -- 只复用已验证的同包身份/资金/管理员前置；不要求 notifications_catalog 已绑定。
  v_map:=private.employee_transfer_notifications_owner(p_job);PERFORM private.employee_transfer_chat_schema();
  IF p_job.summary ? 'chat_catalog' THEN
    PERFORM private.employee_transfer_check_chat_catalog(p_job.summary->'chat_catalog');
    IF p_job.summary#>'{chat_catalog,identity_catalog}' IS DISTINCT FROM p_job.summary->'identity_catalog'
      OR p_job.summary#>'{chat_catalog,finance_catalog}' IS DISTINCT FROM p_job.summary->'finance_catalog'
      OR p_job.summary#>'{chat_catalog,site_id}' IS NOT DISTINCT FROM to_jsonb((SELECT site_id FROM private.employee_transfer_site)) THEN RAISE EXCEPTION 'Chat source binding changed or is this same site.';END IF;
  END IF;
  RETURN v_map;
END;
$$;

CREATE FUNCTION public.employee_import_chat_bind(p_admin_session_token uuid,p_job_token uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');PERFORM private.employee_transfer_chat_owner(v_job);PERFORM private.employee_transfer_check_chat_catalog(p_catalog);
  IF p_catalog->'identity_catalog' IS DISTINCT FROM v_job.summary->'identity_catalog' OR p_catalog->'finance_catalog' IS DISTINCT FROM v_job.summary->'finance_catalog'
    OR p_catalog->'site_id' IS NOT DISTINCT FROM to_jsonb((SELECT site_id FROM private.employee_transfer_site)) THEN RAISE EXCEPTION 'Chat must match the exact restored identity and finance catalogs from a different site.';END IF;
  v_repeated:=v_job.summary ? 'chat_catalog';
  IF v_repeated THEN
    IF p_catalog IS DISTINCT FROM v_job.summary->'chat_catalog' THEN RAISE EXCEPTION 'The chat catalog binding is immutable.';END IF;
  ELSE UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('chat_catalog',p_catalog) WHERE id=v_job.id;END IF;
  RETURN jsonb_build_object('success',true,'scope','site-chat','repeated',v_repeated,'media_pending',true,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_chat_stage(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_expected jsonb;v_previous jsonb;v_last jsonb;v_line text;v_json json;v_rows jsonb:='[]';v_hashes text:='';v_count integer:=0;v_first text;v_cursor text;v_total bigint;v_bytes bigint;v_count_total bigint;v_hash text;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');PERFORM private.employee_transfer_chat_owner(v_job);
  PERFORM private.employee_transfer_check_chat_catalog(v_job.summary->'chat_catalog');PERFORM private.employee_transfer_chat_relation(p_table_key);
  SELECT value INTO v_expected FROM jsonb_array_elements(v_job.summary#>'{chat_catalog,tables}') WHERE value->>'key'=p_table_key;
  IF v_expected IS NULL OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 1000000 OR p_ndjson IS NULL OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN RAISE EXCEPTION 'Invalid chat chunk.';END IF;
  IF p_ndjson<>'' THEN FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS item(line) LOOP
    IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Chat row exceeds limits.';END IF;
    BEGIN
      v_json:=v_line::json;
      IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_chat_unique_json(v_json) THEN RAISE EXCEPTION 'Invalid JSON';END IF;
      PERFORM private.employee_transfer_check_chat_row(p_table_key,v_json::jsonb);
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid chat import row.' USING ERRCODE='22023';END;
    IF v_cursor IS NOT NULL AND v_cursor COLLATE "C">=(v_json->>'id') COLLATE "C" THEN RAISE EXCEPTION 'Chat rows must be strictly ordered.';END IF;
    v_cursor:=v_json->>'id';v_first:=COALESCE(v_first,v_cursor);v_rows:=v_rows||jsonb_build_array(v_json::jsonb);v_count:=v_count+1;
    v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    IF v_count>200 THEN RAISE EXCEPTION 'Chat chunk exceeds row limit.';END IF;
  END LOOP;END IF;
  IF v_count=0 AND (p_chunk_no<>0 OR (v_expected->>'rows')::bigint<>0) THEN RAISE EXCEPTION 'Invalid chat empty chunk.';END IF;
  v_hash:=encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex');
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='chat-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_previous IS NOT NULL THEN
    IF v_previous->>'ndjson' IS DISTINCT FROM p_ndjson THEN RAISE EXCEPTION 'Chat chunk content changed.';END IF;
    RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',true);
  END IF;
  SELECT count(*),COALESCE(sum(row_count),0)+v_count,COALESCE(sum((payload->>'bytes')::bigint),0)+octet_length(p_ndjson) INTO v_total,v_count_total,v_bytes FROM private.employee_transfer_staging
    WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='chat-in:'||p_table_key;
  SELECT payload INTO v_last FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='chat-in:'||p_table_key AND chunk_no=p_chunk_no-1;
  IF v_total<>p_chunk_no OR v_count_total>(v_expected->>'rows')::bigint OR v_bytes>(v_expected->>'bytes')::bigint
    OR (p_chunk_no>0 AND (v_last IS NULL OR (v_last->>'last_id') COLLATE "C">=v_first COLLATE "C")) THEN RAISE EXCEPTION 'Chat chunks exceed catalog or cursor order.';END IF;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','chat-in:'||p_table_key,p_chunk_no,v_count,
    jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_cursor));
  RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_input(p_job_id uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT item.value->>'id',item.value FROM private.employee_transfer_staging AS stage CROSS JOIN LATERAL jsonb_array_elements(stage.payload->'rows') AS item(value)
    WHERE stage.job_id=p_job_id AND stage.employee_id='00000000-0000-0000-0000-000000000000' AND stage.table_key='chat-in:'||p_key;
$$;

CREATE FUNCTION private.employee_transfer_check_chat_input(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table jsonb;v_chunks bigint;v_rows bigint;v_bytes bigint;v_min integer;v_max integer;v_hash text;v_counts jsonb:='{}';
BEGIN
  PERFORM private.employee_transfer_check_chat_catalog(p_job.summary->'chat_catalog');
  IF p_job.summary#>'{chat_catalog,identity_catalog}' IS DISTINCT FROM p_job.summary->'identity_catalog'
    OR p_job.summary#>'{chat_catalog,finance_catalog}' IS DISTINCT FROM p_job.summary->'finance_catalog'
    OR p_job.summary#>'{chat_catalog,site_id}' IS NOT DISTINCT FROM to_jsonb((SELECT site_id FROM private.employee_transfer_site)) THEN RAISE EXCEPTION 'Chat source binding changed or is this same site.';END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(p_job.summary#>'{chat_catalog,tables}') LOOP
    SELECT count(*),COALESCE(sum(row_count),0),COALESCE(sum((payload->>'bytes')::bigint),0),min(chunk_no),max(chunk_no),encode(extensions.digest(convert_to(COALESCE(string_agg(payload->>'row_hashes','' ORDER BY chunk_no),''),'UTF8'),'sha256'),'hex')
      INTO v_chunks,v_rows,v_bytes,v_min,v_max,v_hash FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='chat-in:'||(v_table->>'key');
    IF v_chunks=0 OR v_min<>0 OR v_max<>v_chunks-1 OR (v_rows=0 AND v_chunks<>1) OR v_rows<>(v_table->>'rows')::bigint OR v_bytes<>(v_table->>'bytes')::bigint OR v_hash IS DISTINCT FROM v_table->>'row_hashes_sha256' THEN RAISE EXCEPTION 'Chat staged catalog verification failed.';END IF;
    IF EXISTS(SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,v_table->>'key') GROUP BY id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate chat row identity.';END IF;
    v_counts:=v_counts||jsonb_build_object(v_table->>'key',v_rows);
  END LOOP;
  RETURN v_counts;
END;
$$;

-- 只撤销本文件新增函数的权限，保持既有媒体 service_role RPC 授权及旧函数 ACL 不变。
REVOKE ALL ON FUNCTION private.employee_transfer_chat_keys(),private.employee_transfer_chat_spec(),
  private.employee_transfer_chat_relation(text),private.employee_transfer_chat_schema(),
  private.employee_transfer_chat_cursor(text,jsonb),private.employee_transfer_chat_query(text),private.employee_transfer_chat_unique_json(json,integer),
  private.employee_transfer_check_chat_row(text,jsonb),private.employee_transfer_check_chat_catalog(jsonb),
  private.employee_transfer_chat_catalog(uuid),private.employee_transfer_chat_owner(private.employee_transfer_jobs),
  private.employee_transfer_chat_input(uuid,text),private.employee_transfer_check_chat_input(private.employee_transfer_jobs)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.employee_export_chat_begin(uuid,text,uuid),public.get_employee_export_chat_page(uuid,uuid,text,text,integer),
  public.employee_export_chat_verify(uuid,uuid),public.employee_export_chat_close(uuid,uuid),
  public.employee_import_chat_bind(uuid,uuid,jsonb),public.employee_import_chat_stage(uuid,uuid,text,integer,text)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_export_chat_begin(uuid,text,uuid),public.get_employee_export_chat_page(uuid,uuid,text,text,integer),
  public.employee_export_chat_verify(uuid,uuid),public.employee_export_chat_close(uuid,uuid),
  public.employee_import_chat_bind(uuid,uuid,jsonb),public.employee_import_chat_stage(uuid,uuid,text,integer,text) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
