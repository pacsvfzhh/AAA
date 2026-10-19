BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_notifications_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT ARRAY['notification_automation_plans','notification_automation_tasks','notification_automation_plan_members',
    'notification_automation_task_recipients','notification_automation_progress','notification_automation_executions',
    'notification_automation_date_runs','notification_automation_failures','messages','message_recipients',
    'message_templates','broadcast_messages','broadcast_recipients']::text[];
$$;

CREATE FUNCTION private.employee_transfer_notifications_spec()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT '{
    "notification_automation_plans":{"id":"uuid!","owner_admin_id":"uuid!","name":"text!","description":"text!","status":"text!","created_at":"timestamp with time zone!","updated_at":"timestamp with time zone!","activated_at":"timestamp with time zone"},
    "notification_automation_tasks":{"id":"uuid!","owner_admin_id":"uuid!","source_task_id":"uuid","source_version":"integer","name":"text!","description":"text!","status":"text!","is_shared_template":"boolean!","trigger_type":"text!","trigger_mode":"text!","threshold_value":"numeric!","minimum_daily_orders":"integer","minimum_daily_work_minutes":"integer","recipient_scope":"text!","title_template":"text!","content_template":"text!","message_type":"text!","priority":"text!","reward_enabled":"boolean!","reward_amount":"numeric","starts_at":"timestamp with time zone","ends_at":"timestamp with time zone","version":"integer!","activated_at":"timestamp with time zone","created_at":"timestamp with time zone!","updated_at":"timestamp with time zone!","annual_month":"smallint","annual_day":"smallint","delivery_mode":"text!","plan_id":"uuid"},
    "notification_automation_plan_members":{"id":"text!","plan_id":"uuid!","user_id":"uuid!","created_at":"timestamp with time zone!"},
    "notification_automation_task_recipients":{"id":"text!","task_id":"uuid!","user_id":"uuid!","created_at":"timestamp with time zone!"},
    "notification_automation_progress":{"id":"text!","task_id":"uuid!","user_id":"uuid!","last_metric":"numeric!","last_stage":"bigint-text!","last_period_key":"text!","updated_at":"timestamp with time zone!"},
    "notification_automation_executions":{"id":"uuid!","task_id":"uuid","task_version":"integer!","owner_admin_id":"uuid","user_id":"uuid","employee_username":"text!","period_key":"text!","stage":"bigint-text!","actual_value":"numeric!","trigger_snapshot":"jsonb!","title_snapshot":"text!","content_snapshot":"text!","reward_amount":"numeric","reward_currency":"text","message_id":"uuid","wallet_transaction_id":"uuid","status":"text!","error_message":"text","executed_at":"timestamp with time zone!","completed_at":"timestamp with time zone","plan_id":"uuid"},
    "notification_automation_date_runs":{"id":"text!","task_id":"uuid!","task_version":"integer!","period_key":"text!","created_at":"timestamp with time zone!"},
    "notification_automation_failures":{"id":"text!","task_id":"uuid!","user_id":"uuid!","owner_admin_id":"uuid!","attempts":"integer!","last_error":"text!","first_failed_at":"timestamp with time zone!","last_failed_at":"timestamp with time zone!"},
    "messages":{"id":"uuid!","sender_id":"uuid!","sender_username":"text!","title":"text!","content":"text!","message_type":"text!","priority":"text!","expires_at":"timestamp with time zone","created_at":"timestamp with time zone","notification_category":"text!","reward_amount":"numeric","reward_currency":"text","automation_execution_id":"uuid","delivery_mode":"text!","audit_origin":"text!"},
    "message_recipients":{"id":"uuid!","message_id":"uuid!","recipient_id":"uuid!","is_read":"boolean","read_at":"timestamp with time zone","is_shown":"boolean","shown_at":"timestamp with time zone","created_at":"timestamp with time zone","delivery_channel":"text","delivered_at":"timestamp with time zone","delivery_sequence":"bigint-text!"},
    "message_templates":{"id":"uuid!","admin_id":"uuid!","name":"text!","title":"text!","content":"text!","message_type":"text!","priority":"text!","sort_order":"integer!","created_at":"timestamp with time zone!","updated_at":"timestamp with time zone!","delivery_mode":"text!"},
    "broadcast_messages":{"id":"uuid!","admin_id":"uuid","message_content":"text!","message_type":"text!","image_url":"text","target_type":"text!","target_admin_id":"uuid","sent_count":"integer","created_at":"timestamp with time zone"},
    "broadcast_recipients":{"id":"uuid!","broadcast_id":"uuid!","employee_id":"uuid!","is_read":"boolean","read_at":"timestamp with time zone","created_at":"timestamp with time zone"}
  }'::jsonb;
$$;

CREATE FUNCTION private.employee_transfer_notifications_relation(p_key text)
RETURNS regclass LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF p_key IS NULL OR NOT p_key=ANY(private.employee_transfer_notifications_keys()) THEN RAISE EXCEPTION 'Unsupported notifications table.';END IF;
  RETURN to_regclass('public.'||p_key);
END;
$$;

CREATE FUNCTION private.employee_transfer_notifications_schema()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_spec jsonb;v_actual jsonb;v_relation regclass;
BEGIN
  FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP
    v_relation:=private.employee_transfer_notifications_relation(v_key);
    IF v_relation IS NULL AND v_key='notification_automation_date_runs' THEN CONTINUE;END IF;
    v_spec:=private.employee_transfer_notifications_spec()->v_key;
    IF v_key IN ('notification_automation_plan_members','notification_automation_task_recipients','notification_automation_progress','notification_automation_date_runs','notification_automation_failures') THEN v_spec:=v_spec-'id';END IF;
    SELECT jsonb_object_agg(key,replace(value#>>'{}','bigint-text','bigint')) INTO v_spec FROM jsonb_each(v_spec);
    IF v_key='message_recipients' THEN
      v_spec:=v_spec||'{"delivery_claim_token":"uuid","delivery_claim_channel":"text","delivery_claim_until":"timestamp with time zone","delivery_completed_claim_token":"uuid"}'::jsonb;
    END IF;
    SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)||CASE WHEN attnotnull THEN '!' ELSE '' END) INTO v_actual
      FROM pg_attribute WHERE attrelid=v_relation AND attnum>0 AND NOT attisdropped;
    IF v_relation IS NULL OR v_actual IS DISTINCT FROM v_spec THEN RAISE EXCEPTION 'Unreviewed notifications schema.';END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_notifications_cursor(p_key text,p_row jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  CASE p_key
    WHEN 'notification_automation_plan_members' THEN RETURN p_row->>'user_id';
    WHEN 'notification_automation_task_recipients','notification_automation_progress','notification_automation_failures' THEN RETURN (p_row->>'task_id')||':'||(p_row->>'user_id');
    WHEN 'notification_automation_date_runs' THEN RETURN (p_row->>'task_id')||':'||lpad(p_row->>'task_version',10,'0')||':'||(p_row->>'period_key');
    ELSE RETURN p_row->>'id';
  END CASE;
END;
$$;

CREATE FUNCTION private.employee_transfer_notifications_query(p_key text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_relation regclass;v_projection text;v_id text;
BEGIN
  v_relation:=private.employee_transfer_notifications_relation(p_key);
  IF v_relation IS NULL AND p_key='notification_automation_date_runs' THEN RETURN 'SELECT NULL::text AS id,NULL::jsonb AS body WHERE false';END IF;
  v_id:=CASE p_key WHEN 'notification_automation_plan_members' THEN 'src.user_id::text'
    WHEN 'notification_automation_task_recipients' THEN 'src.task_id::text||'':''||src.user_id::text'
    WHEN 'notification_automation_progress' THEN 'src.task_id::text||'':''||src.user_id::text'
    WHEN 'notification_automation_failures' THEN 'src.task_id::text||'':''||src.user_id::text'
    WHEN 'notification_automation_date_runs' THEN 'src.task_id::text||'':''||lpad(src.task_version::text,10,''0'')||'':''||src.period_key'
    ELSE 'src.id::text' END;
  SELECT string_agg(format('%L,%s',key,CASE
    WHEN key='id' THEN v_id
    WHEN p_key='notification_automation_executions' AND key='error_message' THEN 'CASE WHEN src.error_message IS NULL THEN NULL ELSE ''redacted migration error'' END'
    WHEN p_key='notification_automation_failures' AND key='last_error' THEN '''redacted migration error'''
    ELSE format('src.%I%s',key,CASE WHEN value#>>'{}' LIKE 'bigint-text%' THEN '::text' ELSE '' END) END),',' ORDER BY key COLLATE "C")
    INTO v_projection FROM jsonb_each(private.employee_transfer_notifications_spec()->p_key);
  RETURN format('SELECT (%s) COLLATE "C" AS id,jsonb_build_object(%s) AS body FROM public.%I AS src',v_id,v_projection,p_key);
END;
$$;

CREATE FUNCTION private.employee_transfer_check_notifications_row(p_key text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_spec jsonb:=private.employee_transfer_notifications_spec()->p_key;v_field text;v_type text;v_value jsonb;v_time timestamptz;v_checks text;v_valid boolean;v_relation regclass;v_row jsonb;v_snapshot jsonb;
BEGIN
  v_relation:=private.employee_transfer_notifications_relation(p_key);
  IF v_spec IS NULL OR NOT private.employee_transfer_exact_object(p_row,ARRAY(SELECT key FROM jsonb_each(v_spec))) THEN RAISE EXCEPTION 'Unreviewed notifications fields.';END IF;
  FOR v_field,v_type IN SELECT key,value#>>'{}' FROM jsonb_each(v_spec) LOOP
    v_value:=p_row->v_field;
    IF v_value='null'::jsonb THEN IF right(v_type,1)='!' THEN RAISE EXCEPTION 'Required notifications field is null.';END IF;CONTINUE;END IF;
    v_type:=rtrim(v_type,'!');
    IF v_type='uuid' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid notifications identity.';END IF;
      PERFORM (v_value#>>'{}')::uuid;
    ELSIF v_type IN ('integer','smallint') THEN
      IF jsonb_typeof(v_value)<>'number' OR (v_value#>>'{}') !~ '^-?(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION 'Invalid notifications integer.';END IF;
      IF v_type='integer' THEN PERFORM (v_value#>>'{}')::integer;ELSE PERFORM (v_value#>>'{}')::smallint;END IF;
    ELSIF v_type='bigint-text' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^(0|-?[1-9][0-9]{0,18})$' THEN RAISE EXCEPTION 'Invalid notifications bigint.';END IF;
      PERFORM (v_value#>>'{}')::bigint;
    ELSIF v_type='numeric' THEN
      IF jsonb_typeof(v_value)<>'number' THEN RAISE EXCEPTION 'Invalid notifications amount.';END IF;
    ELSIF v_type='boolean' THEN IF jsonb_typeof(v_value)<>'boolean' THEN RAISE EXCEPTION 'Invalid notifications boolean.';END IF;
    ELSIF v_type='text' THEN IF jsonb_typeof(v_value)<>'string' THEN RAISE EXCEPTION 'Invalid notifications text.';END IF;
    ELSIF v_type='jsonb' THEN
      v_snapshot:=v_value;
      IF jsonb_typeof(v_snapshot) IS DISTINCT FROM 'object' OR NOT v_snapshot ?& ARRAY['trigger_type','trigger_mode','threshold_value','minimum_daily_orders','minimum_daily_work_minutes']
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(v_snapshot) AS f(key) WHERE key<>ALL(ARRAY['trigger_type','trigger_mode','threshold_value','minimum_daily_orders','minimum_daily_work_minutes','annual_month','annual_day']))
        OR jsonb_typeof(v_snapshot->'trigger_type') IS DISTINCT FROM 'string' OR jsonb_typeof(v_snapshot->'trigger_mode') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_snapshot->'threshold_value') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Unreviewed notification trigger snapshot.';END IF;
      FOR v_field IN SELECT key FROM jsonb_each(v_snapshot) WHERE key IN ('minimum_daily_orders','minimum_daily_work_minutes','annual_month','annual_day') LOOP
        IF v_snapshot->v_field<>'null'::jsonb THEN
          IF jsonb_typeof(v_snapshot->v_field)<>'number' OR (v_snapshot->>v_field) !~ '^-?(0|[1-9][0-9]*)$' THEN RAISE EXCEPTION 'Invalid notification snapshot integer.';END IF;
          PERFORM (v_snapshot->>v_field)::integer;
        END IF;
      END LOOP;
    ELSIF v_type='timestamp with time zone' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value#>>'{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|\+00:00)$' THEN RAISE EXCEPTION 'Invalid notifications timestamp.';END IF;
      v_time:=(v_value#>>'{}')::timestamptz;
      IF NOT isfinite(v_time) OR substring(v_value#>>'{}' FROM 12 FOR 2)::integer>23 OR substring(v_value#>>'{}' FROM 15 FOR 2)::integer>59 OR substring(v_value#>>'{}' FROM 18 FOR 2)::integer>59 THEN RAISE EXCEPTION 'Invalid notifications timestamp.';END IF;
    ELSE RAISE EXCEPTION 'Unreviewed notifications type.';END IF;
  END LOOP;
  IF p_row->>'id' IS DISTINCT FROM private.employee_transfer_notifications_cursor(p_key,p_row) THEN RAISE EXCEPTION 'Notifications composite identity differs.';END IF;
  IF p_key IN ('notification_automation_executions','notification_automation_date_runs') AND (p_row->>'period_key') !~ '^[A-Za-z0-9:._-]{1,128}$'
    OR p_key='notification_automation_progress' AND (p_row->>'last_period_key') !~ '^[A-Za-z0-9:._-]{1,128}$' THEN RAISE EXCEPTION 'Unreviewed notifications period.';END IF;
  IF p_key='notification_automation_executions' AND ((p_row->>'stage')::bigint<=0 OR (p_row->>'error_message' IS NOT NULL AND p_row->>'error_message'<>'redacted migration error'))
    OR p_key='notification_automation_progress' AND (p_row->>'last_stage')::bigint<0
    OR p_key='message_recipients' AND (p_row->>'delivery_sequence')::bigint<=0
    OR p_key='notification_automation_failures' AND p_row->>'last_error' IS DISTINCT FROM 'redacted migration error' THEN RAISE EXCEPTION 'Invalid notifications state or unsanitized error.';END IF;
  v_row:=CASE WHEN v_spec->>'id'='text!' THEN p_row-'id' ELSE p_row END;
  SELECT string_agg('COALESCE(('||pg_get_expr(conbin,conrelid)||'),true)',' AND ') INTO v_checks FROM pg_constraint WHERE conrelid=v_relation AND contype='c';
  IF v_checks IS NOT NULL THEN
    EXECUTE format('SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) AS r',v_checks,p_key) INTO v_valid USING v_row;
    IF NOT v_valid THEN RAISE EXCEPTION 'Notifications row violates target constraints.';END IF;
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_notifications_catalog(p_catalog jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_table jsonb;v_index integer:=0;v_bytes bigint:=0;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_catalog,ARRAY['version','scope','site_id','package_id','identity_catalog','finance_catalog','date_runs_supported','tables','full_site_complete'])
    OR p_catalog->'version' IS DISTINCT FROM '1'::jsonb OR p_catalog->>'scope' IS DISTINCT FROM 'site-notifications'
    OR p_catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb OR jsonb_typeof(p_catalog->'date_runs_supported') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_catalog->'tables') IS DISTINCT FROM 'array' OR jsonb_array_length(p_catalog->'tables')<>13 THEN RAISE EXCEPTION 'Invalid notifications catalog.';END IF;
  PERFORM private.employee_transfer_check_identity_catalog(p_catalog->'identity_catalog');PERFORM private.employee_transfer_check_finance_catalog(p_catalog->'finance_catalog');
  IF p_catalog->'identity_catalog' IS DISTINCT FROM p_catalog#>'{finance_catalog,identity_catalog}'
    OR p_catalog->'site_id' IS DISTINCT FROM p_catalog#>'{identity_catalog,site_id}' OR p_catalog->'package_id' IS DISTINCT FROM p_catalog#>'{identity_catalog,package_id}' THEN RAISE EXCEPTION 'Notifications, finance and identity source binding differs.';END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP
    v_table:=p_catalog->'tables'->v_index;v_index:=v_index+1;
    IF NOT private.employee_transfer_exact_object(v_table,ARRAY['key','rows','bytes','row_hashes_sha256']) OR v_table->>'key' IS DISTINCT FROM v_key
      OR jsonb_typeof(v_table->'rows') IS DISTINCT FROM 'number' OR (v_table->>'rows') !~ '^(0|[1-9][0-9]{0,5})$' OR (v_table->>'rows')::bigint>500000
      OR jsonb_typeof(v_table->'bytes') IS DISTINCT FROM 'number' OR (v_table->>'bytes') !~ '^(0|[1-9][0-9]{0,8})$' OR (v_table->>'bytes')::bigint>268435456
      OR ((v_table->>'rows')::bigint=0)<>((v_table->>'bytes')::bigint=0)
      OR jsonb_typeof(v_table->'row_hashes_sha256') IS DISTINCT FROM 'string' OR (v_table->>'row_hashes_sha256') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid notifications table catalog.';END IF;
    IF v_key='notification_automation_date_runs' AND p_catalog->'date_runs_supported'='false'::jsonb
      AND ((v_table->>'rows')::bigint<>0 OR v_table->>'row_hashes_sha256'<>'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') THEN RAISE EXCEPTION 'Unsupported date runs must be empty.';END IF;
    v_bytes:=v_bytes+(v_table->>'bytes')::bigint;
  END LOOP;
  IF v_bytes>1073741824 THEN RAISE EXCEPTION 'Notifications catalog exceeds limits.';END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_notifications_catalog(p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_query text;v_rows bigint;v_bytes bigint;v_largest bigint;v_hash text;v_total bigint:=0;v_tables jsonb:='[]';v_row record;v_finance jsonb;
BEGIN
  PERFORM private.employee_transfer_notifications_schema();
  v_finance:=private.employee_transfer_finance_catalog(p_package_id);
  FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP
    v_query:=private.employee_transfer_notifications_query(v_key);
    EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),COALESCE(max(octet_length(body::text||E''\n'')),0) FROM ('||v_query||') AS r' INTO v_rows,v_bytes,v_largest;
    v_total:=v_total+v_bytes;
    IF v_rows>500000 OR v_bytes>268435456 OR v_total>1073741824 OR v_largest>65536 THEN RAISE EXCEPTION 'Notifications export exceeds limits; no data was truncated.';END IF;
    FOR v_row IN EXECUTE v_query LOOP PERFORM private.employee_transfer_check_notifications_row(v_key,v_row.body);END LOOP;
    EXECUTE 'SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id COLLATE "C"),''''),''UTF8''),''sha256''),''hex'') FROM ('||v_query||') AS r' INTO v_hash;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
  END LOOP;
  RETURN jsonb_build_object('version',1,'scope','site-notifications','site_id',(SELECT site_id FROM private.employee_transfer_site),
    'package_id',p_package_id,'identity_catalog',v_finance->'identity_catalog','finance_catalog',v_finance,
    'date_runs_supported',to_regclass('public.notification_automation_date_runs') IS NOT NULL,'tables',v_tables,'full_site_complete',false);
END;
$$;

DO $isolate_notifications$
DECLARE v_definition text;v_anchor text;
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_job(uuid,uuid,text)'::regprocedure);
  v_anchor:='    OR (v_job.options->>''export_protocol''=''employee-verification-v1'' AND p_kind<>''verification-export'')';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Notifications protocol isolation anchor changed.';END IF;
  v_definition:=replace(v_definition,v_anchor,E'    OR (v_job.options->>''export_protocol''=''site-notifications-v1'' AND p_kind<>''notifications-export'')\n    OR (p_kind=''notifications-export'' AND v_job.options->>''export_protocol'' IS DISTINCT FROM ''site-notifications-v1'')\n'||v_anchor);
  v_anchor:='WHEN ''verification-export'' THEN ''export''';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Notifications kind anchor changed.';END IF;
  EXECUTE replace(v_definition,v_anchor,'WHEN ''notifications-export'' THEN ''export'' '||v_anchor);
  v_definition:=pg_get_functiondef('public.get_employee_transfer_log(uuid,integer)'::regprocedure);
  v_anchor:='AND options->>''export_protocol'' IS DISTINCT FROM ''employee-verification-v1''';
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN RAISE EXCEPTION 'Notifications log anchor changed.';END IF;
  EXECUTE replace(v_definition,v_anchor,v_anchor||E'\n      AND options->>''export_protocol'' IS DISTINCT FROM ''site-notifications-v1''');
END;
$isolate_notifications$;

CREATE FUNCTION public.employee_export_notifications_begin(p_admin_session_token uuid,p_admin_password text,p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_begin jsonb;v_catalog jsonb;
BEGIN
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'A notifications package id is required.';END IF;
  v_begin:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'export',jsonb_build_object('export_protocol','site-notifications-v1','scope','site-notifications','package_id',p_package_id));
  IF NOT COALESCE((v_begin->>'success')::boolean,false) THEN RETURN v_begin;END IF;
  v_catalog:=private.employee_transfer_notifications_catalog(p_package_id);
  UPDATE private.employee_transfer_jobs SET summary=jsonb_build_object('notifications_catalog',v_catalog) WHERE id=(v_begin->>'job_id')::uuid;
  RETURN (v_begin-'server_time')||jsonb_build_object('catalog',v_catalog,'scope','site-notifications','full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_export_notifications_page(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_query text;v_line text;v_text text:='';v_count integer:=0;v_cursor text;v_row record;v_more boolean:=false;
BEGIN
  PERFORM private.employee_transfer_job(p_admin_session_token,p_job_token,'notifications-export');PERFORM private.employee_transfer_notifications_schema();
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_after IS NOT NULL AND length(p_after)>256) THEN RAISE EXCEPTION 'Invalid notifications page size or cursor.';END IF;
  v_query:=private.employee_transfer_notifications_query(p_table_key);
  IF p_after IS NOT NULL THEN
    EXECUTE 'SELECT id FROM ('||v_query||') AS r WHERE id=$1 COLLATE "C"' INTO v_cursor USING p_after;
    IF v_cursor IS NULL THEN RAISE EXCEPTION 'Notifications cursor disappeared or is not canonical.';END IF;
  END IF;
  FOR v_row IN EXECUTE 'SELECT id,body FROM ('||v_query||') AS r WHERE ($1::text IS NULL OR id>$1 COLLATE "C") ORDER BY id COLLATE "C" LIMIT $2' USING p_after,p_limit+1 LOOP
    PERFORM private.employee_transfer_check_notifications_row(p_table_key,v_row.body);
    v_line:=v_row.body::text||E'\n';
    IF octet_length(v_line)>65536 THEN RAISE EXCEPTION 'Notifications row exceeds limits.';END IF;
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_line)>262144 THEN v_more:=true;EXIT;END IF;
    v_text:=v_text||v_line;v_count:=v_count+1;v_cursor:=v_row.id;
  END LOOP;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_text,'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_export_notifications_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'notifications-export');
  IF v_job.summary->'notifications_catalog' IS DISTINCT FROM private.employee_transfer_notifications_catalog((v_job.options->>'package_id')::uuid) THEN RAISE EXCEPTION 'Notifications, finance or identity source changed; discard the export and restart.';END IF;
  UPDATE private.employee_transfer_jobs SET summary=summary||'{"notifications_verified":true}'::jsonb WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'export','notifications_records_verified','{"scope":"site-notifications","media_pending":true,"full_site_complete":false}');
  RETURN '{"verified":true,"scope":"site-notifications","media_pending":true,"full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_export_notifications_close(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'notifications-export');
  IF v_job.summary->'notifications_verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Notifications records have not been verified.';END IF;
  PERFORM public.employee_export_notifications_verify(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_end_job(v_job,'finished',v_job.summary||'{"scope":"site-notifications","media_pending":true,"full_site_complete":false}'::jsonb);
  RETURN '{"success":true,"scope":"site-notifications","media_pending":true,"full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION private.employee_transfer_notifications_owner(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;v_completed bigint;
BEGIN
  v_map:=private.employee_transfer_finance_context(p_job);PERFORM private.employee_transfer_notifications_schema();
  PERFORM private.employee_transfer_check_finance_catalog(p_job.summary->'finance_catalog');PERFORM private.employee_transfer_check_finance_input(p_job);
  IF p_job.summary#>'{finance_restore,verified}' IS DISTINCT FROM 'true'::jsonb OR p_job.summary#>'{finance_restore,admin_map}' IS DISTINCT FROM v_map THEN RAISE EXCEPTION 'Verified same-package finance is required for notifications.';END IF;
  v_completed:=private.employee_transfer_finance_progress(p_job,v_map);
  IF v_completed IS DISTINCT FROM (p_job.summary#>>'{identity_catalog,tables,0,rows}')::bigint THEN RAISE EXCEPTION 'Notifications finance prerequisite is incomplete.';END IF;
  RETURN v_map;
END;
$$;

CREATE FUNCTION public.employee_import_notifications_bind(p_admin_session_token uuid,p_job_token uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');PERFORM private.employee_transfer_notifications_owner(v_job);PERFORM private.employee_transfer_check_notifications_catalog(p_catalog);
  IF p_catalog->'identity_catalog' IS DISTINCT FROM v_job.summary->'identity_catalog' OR p_catalog->'finance_catalog' IS DISTINCT FROM v_job.summary->'finance_catalog' THEN RAISE EXCEPTION 'Notifications must match the exact restored identity and finance catalogs.';END IF;
  v_repeated:=v_job.summary ? 'notifications_catalog';
  IF v_repeated THEN
    IF p_catalog IS DISTINCT FROM v_job.summary->'notifications_catalog' THEN RAISE EXCEPTION 'The notifications catalog binding is immutable.';END IF;
  ELSE UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('notifications_catalog',p_catalog) WHERE id=v_job.id;END IF;
  RETURN jsonb_build_object('success',true,'scope','site-notifications','repeated',v_repeated,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_notifications_stage(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_expected jsonb;v_previous jsonb;v_last jsonb;v_line text;v_json json;v_rows jsonb:='[]';v_hashes text:='';v_count integer:=0;v_first text;v_cursor text;v_total bigint;v_bytes bigint;v_count_total bigint;v_hash text;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');PERFORM private.employee_transfer_notifications_owner(v_job);
  PERFORM private.employee_transfer_check_notifications_catalog(v_job.summary->'notifications_catalog');PERFORM private.employee_transfer_notifications_relation(p_table_key);
  SELECT value INTO v_expected FROM jsonb_array_elements(v_job.summary#>'{notifications_catalog,tables}') WHERE value->>'key'=p_table_key;
  IF v_expected IS NULL OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 500000 OR p_ndjson IS NULL OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN RAISE EXCEPTION 'Invalid notifications chunk.';END IF;
  IF p_ndjson<>'' THEN FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS item(line) LOOP
    IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Notifications row exceeds limits.';END IF;
    BEGIN
      v_json:=v_line::json;
      IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN RAISE EXCEPTION 'Invalid JSON';END IF;
      PERFORM private.employee_transfer_check_notifications_row(p_table_key,v_json::jsonb);
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid notifications import row.' USING ERRCODE='22023';END;
    IF v_cursor IS NOT NULL AND v_cursor COLLATE "C">=(v_json->>'id') COLLATE "C" THEN RAISE EXCEPTION 'Notifications rows must be strictly ordered.';END IF;
    v_cursor:=v_json->>'id';v_first:=COALESCE(v_first,v_cursor);v_rows:=v_rows||jsonb_build_array(v_json::jsonb);v_count:=v_count+1;
    v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    IF v_count>200 THEN RAISE EXCEPTION 'Notifications chunk exceeds row limit.';END IF;
  END LOOP;END IF;
  IF v_count=0 AND (p_chunk_no<>0 OR (v_expected->>'rows')::bigint<>0) THEN RAISE EXCEPTION 'Invalid notifications empty chunk.';END IF;
  v_hash:=encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex');
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='notifications-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_previous IS NOT NULL THEN
    IF v_previous->>'ndjson' IS DISTINCT FROM p_ndjson THEN RAISE EXCEPTION 'Notifications chunk content changed.';END IF;
    RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',true);
  END IF;
  SELECT count(*),COALESCE(sum(row_count),0)+v_count,COALESCE(sum((payload->>'bytes')::bigint),0)+octet_length(p_ndjson) INTO v_total,v_count_total,v_bytes FROM private.employee_transfer_staging
    WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='notifications-in:'||p_table_key;
  SELECT payload INTO v_last FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='notifications-in:'||p_table_key AND chunk_no=p_chunk_no-1;
  IF v_total<>p_chunk_no OR v_count_total>(v_expected->>'rows')::bigint OR v_bytes>(v_expected->>'bytes')::bigint
    OR (p_chunk_no>0 AND (v_last IS NULL OR (v_last->>'last_id') COLLATE "C">=v_first COLLATE "C")) THEN RAISE EXCEPTION 'Notifications chunks exceed catalog or cursor order.';END IF;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','notifications-in:'||p_table_key,p_chunk_no,v_count,
    jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_cursor));
  RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_notifications_input(p_job_id uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT item.value->>'id',item.value FROM private.employee_transfer_staging AS stage CROSS JOIN LATERAL jsonb_array_elements(stage.payload->'rows') AS item(value)
    WHERE stage.job_id=p_job_id AND stage.employee_id='00000000-0000-0000-0000-000000000000' AND stage.table_key='notifications-in:'||p_key;
$$;

CREATE FUNCTION private.employee_transfer_check_notifications_input(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table jsonb;v_chunks bigint;v_rows bigint;v_bytes bigint;v_min integer;v_max integer;v_hash text;v_counts jsonb:='{}';
BEGIN
  PERFORM private.employee_transfer_check_notifications_catalog(p_job.summary->'notifications_catalog');
  IF p_job.summary#>'{notifications_catalog,identity_catalog}' IS DISTINCT FROM p_job.summary->'identity_catalog'
    OR p_job.summary#>'{notifications_catalog,finance_catalog}' IS DISTINCT FROM p_job.summary->'finance_catalog' THEN RAISE EXCEPTION 'Notifications source binding changed.';END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(p_job.summary#>'{notifications_catalog,tables}') LOOP
    SELECT count(*),COALESCE(sum(row_count),0),COALESCE(sum((payload->>'bytes')::bigint),0),min(chunk_no),max(chunk_no),encode(extensions.digest(convert_to(COALESCE(string_agg(payload->>'row_hashes','' ORDER BY chunk_no),''),'UTF8'),'sha256'),'hex')
      INTO v_chunks,v_rows,v_bytes,v_min,v_max,v_hash FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='notifications-in:'||(v_table->>'key');
    IF v_chunks=0 OR v_min<>0 OR v_max<>v_chunks-1 OR (v_rows=0 AND v_chunks<>1) OR v_rows<>(v_table->>'rows')::bigint OR v_bytes<>(v_table->>'bytes')::bigint OR v_hash IS DISTINCT FROM v_table->>'row_hashes_sha256' THEN RAISE EXCEPTION 'Notifications staged catalog verification failed.';END IF;
    IF EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,v_table->>'key') GROUP BY id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate notifications row identity.';END IF;
    v_counts:=v_counts||jsonb_build_object(v_table->>'key',v_rows);
  END LOOP;
  RETURN v_counts;
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);END LOOP;
  REVOKE ALL ON FUNCTION public.employee_export_notifications_begin(uuid,text,uuid),public.get_employee_export_notifications_page(uuid,uuid,text,text,integer),public.employee_export_notifications_verify(uuid,uuid),public.employee_export_notifications_close(uuid,uuid),public.employee_import_notifications_bind(uuid,uuid,jsonb),public.employee_import_notifications_stage(uuid,uuid,text,integer,text) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.employee_export_notifications_begin(uuid,text,uuid),public.get_employee_export_notifications_page(uuid,uuid,text,text,integer),public.employee_export_notifications_verify(uuid,uuid),public.employee_export_notifications_close(uuid,uuid),public.employee_import_notifications_bind(uuid,uuid,jsonb),public.employee_import_notifications_stage(uuid,uuid,text,integer,text) TO anon,authenticated;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
