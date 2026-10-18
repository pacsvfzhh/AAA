-- employee-identity-v1: source export and dispatch-owned staging only.
-- No business rows, tables, triggers, write permits or maintenance state are changed.
BEGIN;

CREATE FUNCTION private.employee_transfer_identity_spec()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT '{
    "accounts":{"id":"uuid!","username":"text!","password_hash":"text!","employee_id":"text!","is_verified":"boolean","is_active":"boolean","total_income":"numeric","first_success_order_date":"timestamp with time zone","created_by":"uuid","remarks":"text","created_at":"timestamp with time zone","updated_at":"timestamp with time zone","tags":"text[]","is_pinned":"boolean"},
    "credentials":{"id":"uuid!","password_hash":"text!","created_at":"timestamp with time zone!","updated_at":"timestamp with time zone!"},
    "orders":{"id":"uuid!","user_id":"uuid!","status":"text!","commission_amount":"numeric","commission_rate":"numeric","created_at":"timestamp with time zone","processed_at":"timestamp with time zone"}
  }'::jsonb;
$$;

CREATE FUNCTION private.employee_transfer_identity_schema()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_expected constant jsonb := '{
    "users":{"id":"uuid!","username":"text!","password_hash":"text!","employee_id":"text!","is_verified":"boolean","is_active":"boolean","total_income":"numeric","first_success_order_date":"timestamp with time zone","created_by":"uuid","remarks":"text","created_at":"timestamp with time zone","updated_at":"timestamp with time zone","current_session_token":"uuid","session_created_at":"timestamp with time zone","last_heartbeat_at":"timestamp with time zone","current_tab_id":"text","tags":"text[]","is_pinned":"boolean","archived_at":"timestamp with time zone"},
    "financial_employee_credentials":{"user_id":"uuid!","password_hash":"text!","created_at":"timestamp with time zone!","updated_at":"timestamp with time zone!"},
    "orders":{"id":"uuid!","user_id":"uuid!","username":"text!","product_type_id":"uuid!","product_value":"numeric!","order_number":"text!","transaction_id":"text!","status":"text!","commission_amount":"numeric","commission_rate":"numeric","created_at":"timestamp with time zone","processed_at":"timestamp with time zone","scheduled_process_at":"timestamp with time zone","assignment_id":"text","dispatch_commission_rate_snapshot":"numeric(12,8)","dispatch_success_rate_snapshot":"integer"}
  }'::jsonb;
  v_table text; v_spec jsonb; v_actual jsonb;
BEGIN
  FOR v_table,v_spec IN SELECT key,value FROM jsonb_each(v_expected) LOOP
    SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)||CASE WHEN attnotnull THEN '!' ELSE '' END)
      INTO v_actual FROM pg_attribute
      WHERE attrelid=to_regclass('public.'||v_table) AND attnum>0 AND NOT attisdropped;
    -- The reviewed production baseline permits NULL created_by; strict local replay does not.
    -- These are the only two accepted complete users schemas, not a live-schema projection.
    IF v_actual IS DISTINCT FROM v_spec AND (v_table<>'users' OR
      v_actual IS DISTINCT FROM jsonb_set(v_spec,'{created_by}','"uuid!"'::jsonb)) THEN
      RAISE EXCEPTION 'Unreviewed employee identity schema; transfer blocked.';
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_identity_query(p_key text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_spec jsonb; v_projection text; v_source text;
BEGIN
  v_spec:=private.employee_transfer_identity_spec()->p_key;
  IF v_spec IS NULL THEN RAISE EXCEPTION 'Unknown employee identity table key.'; END IF;
  SELECT string_agg(format('%L,src.%I',key,CASE WHEN p_key='credentials' AND key='id' THEN 'user_id' ELSE key END),',' ORDER BY key COLLATE "C")
    INTO v_projection FROM jsonb_each(v_spec);
  v_source:=CASE p_key
    WHEN 'accounts' THEN 'public.users AS src WHERE src.archived_at IS NULL'
    WHEN 'credentials' THEN 'public.financial_employee_credentials AS src JOIN public.users AS u ON u.id=src.user_id WHERE u.archived_at IS NULL'
    WHEN 'orders' THEN 'public.orders AS src JOIN public.users AS u ON u.id=src.user_id WHERE u.archived_at IS NULL AND src.status IN (''success'',''failure'')'
  END;
  RETURN format('SELECT src.%I AS id,jsonb_build_object(%s) AS body FROM %s',
    CASE WHEN p_key='credentials' THEN 'user_id' ELSE 'id' END,v_projection,v_source);
END;
$$;

CREATE FUNCTION private.employee_transfer_check_identity_catalog(p_catalog jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text; v_table jsonb; v_index integer:=0; v_total bigint:=0;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_catalog,
      ARRAY['version','scope','site_id','package_id','tables','processing_orders','full_site_complete'])
    OR p_catalog->'version' IS DISTINCT FROM '1'::jsonb OR p_catalog->>'scope' IS DISTINCT FROM 'employee-identity'
    OR p_catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(p_catalog->'site_id') IS DISTINCT FROM 'string'
    OR (p_catalog->>'site_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_catalog->'package_id') IS DISTINCT FROM 'string'
    OR (p_catalog->>'package_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_catalog->'processing_orders') IS DISTINCT FROM 'number'
    OR (p_catalog->>'processing_orders') !~ '^(0|[1-9][0-9]{0,14})$'
    OR jsonb_typeof(p_catalog->'tables') IS DISTINCT FROM 'array' OR jsonb_array_length(p_catalog->'tables')<>3 THEN
    RAISE EXCEPTION 'Invalid employee identity catalog.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['accounts','credentials','orders'] LOOP
    v_table:=p_catalog->'tables'->v_index; v_index:=v_index+1;
    IF NOT private.employee_transfer_exact_object(v_table,ARRAY['key','rows','bytes','row_hashes_sha256'])
      OR v_table->>'key' IS DISTINCT FROM v_key OR jsonb_typeof(v_table->'rows') IS DISTINCT FROM 'number'
      OR (v_table->>'rows') !~ '^(0|[1-9][0-9]{0,5})$' OR (v_table->>'rows')::integer>500000
      OR jsonb_typeof(v_table->'bytes') IS DISTINCT FROM 'number' OR (v_table->>'bytes') !~ '^(0|[1-9][0-9]{0,8})$'
      OR (v_table->>'bytes')::bigint>268435456 OR ((v_table->>'rows')::integer=0)<>((v_table->>'bytes')::bigint=0)
      OR jsonb_typeof(v_table->'row_hashes_sha256') IS DISTINCT FROM 'string'
      OR (v_table->>'row_hashes_sha256') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Invalid employee identity table catalog.';
    END IF;
    v_total:=v_total+(v_table->>'bytes')::bigint;
  END LOOP;
  IF v_total>805306368 THEN RAISE EXCEPTION 'Employee identity catalog exceeds limits.'; END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_identity_catalog(p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text; v_query text; v_rows bigint; v_bytes bigint; v_largest bigint; v_hash text;
  v_total bigint:=0; v_tables jsonb:='[]';
BEGIN
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'An employee identity package id is required.'; END IF;
  PERFORM private.employee_transfer_identity_schema();
  FOREACH v_key IN ARRAY ARRAY['accounts','credentials','orders'] LOOP
    v_query:=private.employee_transfer_identity_query(v_key);
    EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),COALESCE(max(octet_length(body::text||E''\n'')),0) FROM ('||v_query||') AS r'
      INTO v_rows,v_bytes,v_largest;
    v_total:=v_total+v_bytes;
    IF v_rows>500000 OR v_bytes>268435456 OR v_total>805306368 OR v_largest>65536 THEN
      RAISE EXCEPTION 'Employee identity export exceeds reviewed limits; no rows were truncated.';
    END IF;
    EXECUTE 'SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id),''''),''UTF8''),''sha256''),''hex'') FROM ('||v_query||') AS r'
      INTO v_hash;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
  END LOOP;
  RETURN jsonb_build_object('version',1,'scope','employee-identity','site_id',(SELECT site_id FROM private.employee_transfer_site),
    'package_id',p_package_id,'tables',v_tables,
    'processing_orders',(SELECT count(*) FROM public.orders AS o JOIN public.users AS u ON u.id=o.user_id
      WHERE u.archived_at IS NULL AND o.status='processing'),'full_site_complete',false);
END;
$$;

-- Keep every 00010 mapping and its two-way isolation; identity import never starts a new job.
CREATE OR REPLACE FUNCTION private.employee_transfer_job(p_session uuid,p_job_token uuid,p_kind text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_job private.employee_transfer_jobs%ROWTYPE; v_kind text;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_session) AS admin;
  v_kind:=CASE p_kind WHEN 'shared-import' THEN 'import' WHEN 'products-import' THEN 'import'
    WHEN 'dispatch-import' THEN 'import' WHEN 'products-export' THEN 'export' WHEN 'dispatch-export' THEN 'export'
    WHEN 'identity-export' THEN 'export' ELSE p_kind END;
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
    OR (p_kind='dispatch-export' AND v_job.options->>'export_protocol' IS DISTINCT FROM 'dispatch-submission-v1')
    OR (v_job.options->>'export_protocol'='employee-identity-v1' AND p_kind<>'identity-export')
    OR (p_kind='identity-export' AND v_job.options->>'export_protocol' IS DISTINCT FROM 'employee-identity-v1') THEN
    RAISE EXCEPTION 'The task protocol does not permit this operation.';
  END IF;
  RETURN v_job;
END;
$$;

-- employee_export_begin's reserved-field rejection from 00009 is deliberately unchanged.
CREATE FUNCTION public.employee_export_identity_begin(p_admin_session_token uuid,p_admin_password text,p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_begin jsonb; v_catalog jsonb;
BEGIN
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'An employee identity package id is required.'; END IF;
  v_begin:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'export',jsonb_build_object(
    'export_protocol','employee-identity-v1','scope','employee-identity','package_id',p_package_id));
  IF NOT COALESCE((v_begin->>'success')::boolean,false) THEN RETURN v_begin; END IF;
  v_catalog:=private.employee_transfer_identity_catalog(p_package_id);
  UPDATE private.employee_transfer_jobs SET summary=jsonb_build_object('identity_catalog',v_catalog)
    WHERE id=(v_begin->>'job_id')::uuid;
  RETURN (v_begin-'server_time')||jsonb_build_object('catalog',v_catalog,'scope','employee-identity','full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_export_identity_page(
  p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 200
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_query text; v_row record; v_line text;
  v_text text:=''; v_count integer:=0; v_cursor uuid; v_more boolean:=false;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'identity-export');
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid employee identity export page size.'; END IF;
  PERFORM private.employee_transfer_identity_schema();
  v_query:=private.employee_transfer_identity_query(p_table_key);
  IF p_after IS NOT NULL THEN
    EXECUTE 'SELECT id FROM ('||v_query||') AS r WHERE id=$1' INTO v_cursor USING p_after;
    IF v_cursor IS NULL THEN RAISE EXCEPTION 'Employee identity export cursor disappeared; restart export.'; END IF;
  END IF;
  FOR v_row IN EXECUTE 'SELECT id,body FROM ('||v_query||') AS r WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2'
      USING p_after,p_limit+1 LOOP
    v_line:=v_row.body::text||E'\n';
    IF octet_length(v_line)>65536 THEN RAISE EXCEPTION 'Employee identity export row exceeds the reviewed limit.'; END IF;
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_line)>262144 THEN v_more:=true; EXIT; END IF;
    v_text:=v_text||v_line; v_count:=v_count+1; v_cursor:=v_row.id;
  END LOOP;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_text,
    'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_export_identity_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_actual jsonb;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'identity-export');
  v_actual:=private.employee_transfer_identity_catalog((v_job.options->>'package_id')::uuid);
  IF v_job.summary->'identity_catalog' IS DISTINCT FROM v_actual THEN
    RAISE EXCEPTION 'Employee identity source changed; discard this export and restart.';
  END IF;
  UPDATE private.employee_transfer_jobs SET summary=summary||'{"identity_verified":true}'::jsonb WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'export','identity_verified',
    '{"scope":"employee-identity","full_site_complete":false}');
  RETURN '{"verified":true,"scope":"employee-identity","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_export_identity_close(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'identity-export');
  IF v_job.summary->'identity_verified' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Employee identity export has not been verified.';
  END IF;
  PERFORM private.employee_transfer_end_job(v_job,'finished',COALESCE(v_job.summary,'{}')||
    '{"scope":"employee-identity","full_site_complete":false}'::jsonb);
  RETURN '{"success":true,"scope":"employee-identity","full_site_complete":false}'::jsonb;
END;
$$;

-- This is the existing transfer-tool log, not a business RPC. Substage close must not advance it.
CREATE OR REPLACE FUNCTION public.get_employee_transfer_log(p_admin_session_token uuid,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_limit integer:=LEAST(GREATEST(COALESCE(p_limit,100),1),500);
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  RETURN jsonb_build_object('site_id',(SELECT site_id FROM private.employee_transfer_site),
    'last_export_at',(SELECT max(finished_at) FROM private.employee_transfer_jobs WHERE kind='export' AND status='finished'
      AND options->>'export_protocol' IS DISTINCT FROM 'products-v1'
      AND options->>'export_protocol' IS DISTINCT FROM 'dispatch-submission-v1'
      AND options->>'export_protocol' IS DISTINCT FROM 'employee-identity-v1'),
    'running',(SELECT to_jsonb(running) FROM (SELECT job.id,job.kind,job.admin_username,job.started_at,job.last_activity_at
      FROM private.employee_transfer_jobs AS job WHERE job.status='running' LIMIT 1) AS running),
    'events',COALESCE((SELECT jsonb_agg(to_jsonb(event) ORDER BY event.id DESC) FROM (
      SELECT item.id,item.job_id,item.occurred_at,item.admin_username,item.kind,item.action,item.details
      FROM private.employee_transfer_events AS item ORDER BY item.id DESC LIMIT v_limit) AS event),'[]'::jsonb));
END;
$$;

CREATE FUNCTION private.employee_transfer_identity_owner(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  PERFORM private.employee_transfer_identity_schema();
  PERFORM private.employee_transfer_assert_maintenance_guards();
  IF p_job.id IS NULL OR p_job.kind IS DISTINCT FROM 'import' OR p_job.status IS DISTINCT FROM 'running'
    OR p_job.options->>'import_protocol' IS DISTINCT FROM 'dispatch-submission-v1'
    OR p_job.last_activity_at<=now()-interval '3 hours' OR p_job.started_at<=now()-interval '12 hours'
    OR p_job.summary->'dispatch_configuration_applied' IS DISTINCT FROM 'true'::jsonb
    OR p_job.summary#>'{dispatch_configuration_receipt,configuration_applied}' IS DISTINCT FROM 'true'::jsonb
    OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance AS m
      JOIN private.employee_transfer_shared_backups AS b ON b.id=m.job_id AND b.admin_id=m.admin_id
        AND b.sealed_at IS NOT NULL AND b.sealed_sha256 IS NOT NULL AND b.catalog->>'scope'='dispatch-submission'
        AND b.plan_hash=m.plan_hash AND b.target_hash=m.target_hash
      WHERE m.job_id=p_job.id AND m.admin_id=p_job.admin_id AND m.dirty
        AND m.plan_hash=p_job.summary->>'dispatch_plan_hash') THEN
    RAISE EXCEPTION 'Employee identities require a running dispatch owner, restored configuration and sealed dirty maintenance.';
  END IF;
END;
$$;

CREATE FUNCTION public.employee_import_identity_bind(p_admin_session_token uuid,p_job_token uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  PERFORM private.employee_transfer_identity_owner(v_job);
  PERFORM private.employee_transfer_check_identity_catalog(p_catalog);
  -- 00010 stores source site in options.catalog.site_id and package alongside that catalog.
  IF p_catalog->'site_id' IS DISTINCT FROM v_job.options#>'{catalog,site_id}'
    OR p_catalog->'package_id' IS DISTINCT FROM v_job.options->'package_id' THEN
    RAISE EXCEPTION 'Employee identity source must match the dispatch site and package.';
  END IF;
  v_repeated:=v_job.summary ? 'identity_catalog';
  IF v_repeated THEN
    IF v_job.summary->'identity_catalog' IS DISTINCT FROM p_catalog THEN
      RAISE EXCEPTION 'The bound employee identity catalog is immutable.';
    END IF;
  ELSE
    IF v_job.summary ?| ARRAY['identity_plan','identity_restore'] THEN
      RAISE EXCEPTION 'The frozen employee identity preparation cannot bind another catalog.';
    END IF;
    UPDATE private.employee_transfer_jobs SET summary=COALESCE(summary,'{}')||jsonb_build_object('identity_catalog',p_catalog)
      WHERE id=v_job.id;
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-identity','full_site_complete',false,'repeated',v_repeated);
END;
$$;

CREATE FUNCTION private.employee_transfer_check_identity_row(p_key text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_spec jsonb; v_field text; v_type text; v_value jsonb; v_time timestamptz; v_number numeric;
  v_cast jsonb; v_table text; v_record jsonb; v_checks text; v_valid boolean;
BEGIN
  v_spec:=private.employee_transfer_identity_spec()->p_key;
  IF v_spec IS NULL OR NOT private.employee_transfer_exact_object(p_row,ARRAY(SELECT key FROM jsonb_each(v_spec))) THEN
    RAISE EXCEPTION 'Unreviewed employee identity fields.';
  END IF;
  FOR v_field,v_type IN SELECT key,value #>> '{}' FROM jsonb_each(v_spec) LOOP
    v_value:=p_row->v_field;
    IF v_value='null'::jsonb THEN
      IF right(v_type,1)='!' THEN RAISE EXCEPTION 'Required employee identity field is null.'; END IF;
      CONTINUE;
    END IF;
    v_type:=rtrim(v_type,'!');
    IF v_type='uuid' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'Invalid employee identity.';
      END IF;
      PERFORM (v_value #>> '{}')::uuid;
    ELSIF v_type='boolean' THEN
      IF jsonb_typeof(v_value)<>'boolean' THEN RAISE EXCEPTION 'Invalid employee identity boolean.'; END IF;
    ELSIF v_type='numeric' THEN
      IF jsonb_typeof(v_value)<>'number' THEN RAISE EXCEPTION 'Invalid employee identity numeric.'; END IF;
      v_number:=(v_value #>> '{}')::numeric;
      IF v_number::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Invalid employee identity numeric.'; END IF;
    ELSIF v_type='timestamp with time zone' THEN
      IF jsonb_typeof(v_value)<>'string' OR (v_value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
        RAISE EXCEPTION 'Invalid employee identity timestamp.';
      END IF;
      v_time:=(v_value #>> '{}')::timestamptz;
      IF NOT isfinite(v_time) OR substring(v_value #>> '{}' FROM 12 FOR 2)::integer>23
        OR substring(v_value #>> '{}' FROM 15 FOR 2)::integer>59 OR substring(v_value #>> '{}' FROM 18 FOR 2)::integer>59 THEN
        RAISE EXCEPTION 'Invalid employee identity timestamp.';
      END IF;
    ELSIF v_type='text[]' THEN
      IF jsonb_typeof(v_value)<>'array' THEN RAISE EXCEPTION 'Invalid employee identity tags.'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_value) WHERE jsonb_typeof(value) NOT IN ('string','null')) THEN
        RAISE EXCEPTION 'Invalid employee identity tags.';
      END IF;
    ELSIF v_type='text' THEN
      IF jsonb_typeof(v_value)<>'string' THEN RAISE EXCEPTION 'Invalid employee identity text.'; END IF;
    ELSE RAISE EXCEPTION 'Unreviewed employee identity field type.';
    END IF;
    -- Same bcrypt variants/cost bounds as the shared administrator protocol, at both locations.
    IF v_field='password_hash' AND (v_value #>> '{}') !~ '^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$' THEN
      RAISE EXCEPTION 'Invalid employee credential.';
    END IF;
  END LOOP;
  v_table:=CASE p_key WHEN 'accounts' THEN 'users' WHEN 'credentials' THEN 'financial_employee_credentials' ELSE 'orders' END;
  v_record:=CASE WHEN p_key='credentials' THEN (p_row-'id')||jsonb_build_object('user_id',p_row->'id') ELSE p_row END;
  EXECUTE format('SELECT to_jsonb(r) FROM jsonb_populate_record(NULL::public.%I,$1) AS r',v_table) INTO v_cast USING v_record;
  FOR v_field,v_type IN SELECT key,value #>> '{}' FROM jsonb_each(v_spec) LOOP
    IF v_type='numeric' AND v_cast->v_field IS DISTINCT FROM p_row->v_field THEN
      RAISE EXCEPTION 'Employee identity numeric precision would be lost.';
    END IF;
  END LOOP;
  IF p_key='orders' THEN
    IF p_row->>'status' NOT IN ('success','failure') THEN RAISE EXCEPTION 'Only completed employee orders may be staged.'; END IF;
    -- Evaluate the actual CHECK, including NULL commission for failure, without inserting a row.
    SELECT string_agg('COALESCE(('||pg_get_expr(conbin,conrelid)||'),true)',' AND ') INTO v_checks
      FROM pg_constraint WHERE conrelid='public.orders'::regclass AND contype='c';
    IF v_checks IS NOT NULL THEN
      EXECUTE 'SELECT '||v_checks||' FROM jsonb_populate_record(NULL::public.orders,$1) AS r' INTO v_valid USING p_row;
      IF NOT v_valid THEN RAISE EXCEPTION 'Employee order violates target constraints.'; END IF;
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION public.employee_import_identity_stage(
  p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_expected jsonb; v_previous jsonb; v_last jsonb;
  v_line text; v_json json; v_rows jsonb:='[]'; v_hashes text:=''; v_count integer:=0; v_first text; v_cursor text;
  v_total bigint; v_bytes bigint; v_count_total bigint; v_hash text;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  PERFORM private.employee_transfer_identity_owner(v_job);
  PERFORM private.employee_transfer_check_identity_catalog(v_job.summary->'identity_catalog');
  SELECT value INTO v_expected FROM jsonb_array_elements(v_job.summary#>'{identity_catalog,tables}') WHERE value->>'key'=p_table_key;
  IF v_expected IS NULL OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 500000 OR p_ndjson IS NULL
    OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN
    RAISE EXCEPTION 'Invalid employee identity import chunk.';
  END IF;
  IF p_ndjson<>'' THEN
    FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS item(line) LOOP
      IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Employee identity import row exceeds limits.'; END IF;
      BEGIN
        v_json:=v_line::json;
        IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN RAISE EXCEPTION 'Invalid JSON'; END IF;
        PERFORM private.employee_transfer_check_identity_row(p_table_key,v_json::jsonb);
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid employee identity import row.' USING ERRCODE='22023'; END;
      IF v_cursor IS NOT NULL AND v_cursor COLLATE "C">=(v_json->>'id') COLLATE "C" THEN
        RAISE EXCEPTION 'Employee identity rows must be strictly ordered.';
      END IF;
      v_cursor:=v_json->>'id'; v_first:=COALESCE(v_first,v_cursor);
      v_rows:=v_rows||jsonb_build_array(v_json::jsonb); v_count:=v_count+1;
      v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
      IF v_count>200 THEN RAISE EXCEPTION 'Invalid employee identity chunk row count.'; END IF;
    END LOOP;
  END IF;
  IF v_count=0 AND (p_chunk_no<>0 OR (v_expected->>'rows')::integer<>0) THEN
    RAISE EXCEPTION 'Invalid employee identity empty chunk.';
  END IF;
  v_hash:=encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex');
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_previous IS NOT NULL THEN
    IF v_previous->>'ndjson' IS DISTINCT FROM p_ndjson THEN RAISE EXCEPTION 'Employee identity chunk has different contents.'; END IF;
    -- Identical retries are permitted even after the downstream plan/restore freezes new chunks.
    RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',true);
  END IF;
  IF v_job.summary ?| ARRAY['identity_plan','identity_restore'] THEN
    RAISE EXCEPTION 'The frozen employee identity preparation no longer accepts new chunks.';
  END IF;
  SELECT count(*),COALESCE(sum(row_count),0)+v_count,COALESCE(sum((payload->>'bytes')::bigint),0)+octet_length(p_ndjson)
    INTO v_total,v_count_total,v_bytes FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:'||p_table_key;
  SELECT payload INTO v_last FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:'||p_table_key AND chunk_no=p_chunk_no-1;
  IF v_total<>p_chunk_no OR v_count_total>(v_expected->>'rows')::bigint OR v_bytes>(v_expected->>'bytes')::bigint
    OR (p_chunk_no>0 AND (v_last IS NULL OR (v_last->>'last_id') COLLATE "C">=v_first COLLATE "C")) THEN
    RAISE EXCEPTION 'Employee identity chunks exceed the catalog or cursor order.';
  END IF;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','identity-in:'||p_table_key,p_chunk_no,v_count,
      jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_cursor));
  RETURN jsonb_build_object('success',true,'rows',v_count,'bytes',octet_length(p_ndjson),'sha256',v_hash,'repeated',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_identity_input(p_job_id uuid,p_key text)
RETURNS TABLE(id uuid,body jsonb) LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT (item.value->>'id')::uuid,item.value FROM private.employee_transfer_staging AS stage
  CROSS JOIN LATERAL jsonb_array_elements(stage.payload->'rows') AS item(value)
  WHERE stage.job_id=p_job_id AND stage.employee_id='00000000-0000-0000-0000-000000000000' AND stage.table_key='identity-in:'||p_key;
$$;

CREATE FUNCTION private.employee_transfer_check_identity_input(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table jsonb; v_rows bigint; v_bytes bigint; v_hash text; v_chunks bigint; v_min integer; v_max integer; v_counts jsonb:='{}';
BEGIN
  PERFORM private.employee_transfer_identity_owner(p_job);
  PERFORM private.employee_transfer_check_identity_catalog(p_job.summary->'identity_catalog');
  IF p_job.summary#>'{identity_catalog,site_id}' IS DISTINCT FROM p_job.options#>'{catalog,site_id}'
    OR p_job.summary#>'{identity_catalog,package_id}' IS DISTINCT FROM p_job.options->'package_id' THEN
    RAISE EXCEPTION 'Employee identity source binding changed.';
  END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(p_job.summary#>'{identity_catalog,tables}') LOOP
    SELECT count(*),COALESCE(sum(row_count),0),COALESCE(sum((payload->>'bytes')::bigint),0),min(chunk_no),max(chunk_no),
      encode(extensions.digest(convert_to(COALESCE(string_agg(payload->>'row_hashes','' ORDER BY chunk_no),''),'UTF8'),'sha256'),'hex')
      INTO v_chunks,v_rows,v_bytes,v_min,v_max,v_hash FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:'||(v_table->>'key');
    IF v_chunks=0 OR v_min<>0 OR v_max<>v_chunks-1
      OR (v_rows=0 AND v_chunks<>1) OR v_rows<>(v_table->>'rows')::bigint OR v_bytes<>(v_table->>'bytes')::bigint
      OR v_hash IS DISTINCT FROM v_table->>'row_hashes_sha256' THEN
      RAISE EXCEPTION 'Employee identity staged catalog verification failed.';
    END IF;
    IF EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,v_table->>'key') GROUP BY id HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Duplicate staged employee identity.';
    END IF;
    v_counts:=v_counts||jsonb_build_object(v_table->>'key',v_rows);
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') GROUP BY (body->>'username') COLLATE "C" HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') GROUP BY (body->>'employee_id') COLLATE "C" HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Duplicate employee username or employee number.';
  END IF;
  IF EXISTS(WITH accounts AS MATERIALIZED(SELECT id FROM private.employee_transfer_identity_input(p_job.id,'accounts'))
    SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'credentials') AS c LEFT JOIN accounts AS a ON a.id=c.id WHERE a.id IS NULL)
    OR EXISTS(WITH accounts AS MATERIALIZED(SELECT id FROM private.employee_transfer_identity_input(p_job.id,'accounts'))
    SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'orders') AS o LEFT JOIN accounts AS a ON a.id=(o.body->>'user_id')::uuid WHERE a.id IS NULL) THEN
    RAISE EXCEPTION 'Employee credential or order references a missing source account.';
  END IF;
  -- An account without a financial credential remains absent; do not synthesize one or compare hashes.
  RETURN v_counts;
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname IN (
    'employee_transfer_identity_spec','employee_transfer_identity_schema','employee_transfer_identity_query',
    'employee_transfer_check_identity_catalog','employee_transfer_identity_catalog','employee_transfer_identity_owner',
    'employee_transfer_check_identity_row','employee_transfer_identity_input','employee_transfer_check_identity_input','employee_transfer_job') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',v_function);
  END LOOP;
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'employee_export_identity_begin','get_employee_export_identity_page','employee_export_identity_verify',
    'employee_export_identity_close','employee_import_identity_bind','employee_import_identity_stage','get_employee_transfer_log') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',v_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated',v_function);
  END LOOP;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
