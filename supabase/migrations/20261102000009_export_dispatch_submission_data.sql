CREATE FUNCTION private.employee_transfer_dispatch_spec()
RETURNS jsonb LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT '{
    "dispatch_config":{"id":"uuid!","config_key":"text!","config_value":"text!","description":"text","updated_at":"timestamp with time zone"},
    "dispatch_groups":{"id":"uuid!","group_name":"text!","description":"text","dispatch_interval_min":"integer","dispatch_interval_max":"integer","session_timeout_minutes":"integer!","dispatch_order_mode":"text","is_default":"boolean","is_active":"boolean","created_by":"uuid","created_at":"timestamp with time zone","updated_at":"timestamp with time zone","dispatch_success_rate":"integer!","pool_selection_mode":"text!","archived_at":"timestamp with time zone","submit_wait_min_seconds":"integer!","submit_wait_max_seconds":"integer!","commission_rate":"numeric(12,8)!","withdrawal_amount_threshold":"numeric(14,2)!","withdrawal_orders_threshold":"integer!","withdrawal_condition_mode":"text!","grab_success_rate":"integer!"},
    "dispatch_order_pools":{"id":"uuid!","group_id":"uuid!","pool_name":"text!","is_base":"boolean!","is_active":"boolean!","dispatch_interval_min":"integer!","dispatch_interval_max":"integer!","session_timeout_minutes":"integer!","dispatch_order_mode":"text!","dispatch_success_rate":"integer!","archived_at":"timestamp with time zone","created_by":"uuid","created_at":"timestamp with time zone!","updated_at":"timestamp with time zone!","trigger_probability":"integer!"},
    "dispatch_group_orders":{"id":"uuid!","group_id":"uuid!","order_content":"text!","is_active":"boolean","created_by":"uuid","created_at":"timestamp with time zone","updated_at":"timestamp with time zone","pool_id":"uuid!","archived_at":"timestamp with time zone"},
    "dispatch_group_members":{"id":"uuid!","group_id":"uuid!","user_id":"uuid!","assigned_by":"uuid","assigned_at":"timestamp with time zone"},
    "valid_order_data":{"id":"uuid!","product_value":"numeric!","transaction_id":"text!","is_active":"boolean","created_by":"uuid!","created_at":"timestamp with time zone","updated_at":"timestamp with time zone","usage_count":"integer","last_used_at":"timestamp with time zone","deactivated_at":"timestamp with time zone","deactivation_reason":"text","priority":"integer","tags":"text[]"},
    "used_order_data":{"id":"uuid!","user_id":"uuid!","valid_order_data_id":"uuid!","order_id":"uuid!","created_at":"timestamp with time zone"}
  }'::jsonb;
$$;

CREATE FUNCTION private.employee_transfer_dispatch_schema()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table text; v_expected jsonb; v_actual jsonb;
BEGIN
  FOR v_table,v_expected IN SELECT key,value FROM jsonb_each(private.employee_transfer_dispatch_spec()) LOOP
    SELECT jsonb_object_agg(attname,format_type(atttypid,atttypmod)||CASE WHEN attnotnull THEN '!' ELSE '' END)
      INTO v_actual FROM pg_attribute
      WHERE attrelid=to_regclass('public.'||v_table) AND attnum>0 AND NOT attisdropped;
    IF v_actual IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Unreviewed dispatch/submission schema; export blocked.';
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_dispatch_query(p_key text)
RETURNS text LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_spec jsonb; v_projection text;
BEGIN
  v_spec:=private.employee_transfer_dispatch_spec()->p_key;
  IF v_spec IS NULL THEN RAISE EXCEPTION 'Unknown dispatch/submission table key.'; END IF;
  SELECT string_agg(format('%L,%I',key,key),',' ORDER BY key COLLATE "C") INTO v_projection FROM jsonb_each(v_spec);
  RETURN format('SELECT id,jsonb_build_object(%s) AS body FROM public.%I',v_projection,p_key);
END;
$$;

CREATE FUNCTION private.employee_transfer_dispatch_source_check()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM public.dispatch_groups WHERE is_default)<>1
    OR EXISTS(SELECT 1 FROM public.dispatch_groups WHERE is_default AND archived_at IS NOT NULL)
    OR EXISTS(SELECT 1 FROM public.dispatch_groups AS g LEFT JOIN public.dispatch_order_pools AS p
      ON p.group_id=g.id AND p.is_base GROUP BY g.id HAVING count(p.id)<>1) THEN
    RAISE EXCEPTION 'Source default dispatch group or base pool is ambiguous or missing.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.dispatch_groups AS g LEFT JOIN public.dispatch_order_pools AS p
    ON p.group_id=g.id AND p.archived_at IS NULL WHERE g.pool_selection_mode='weighted' AND g.archived_at IS NULL
    GROUP BY g.id HAVING COALESCE(sum(p.trigger_probability),0)<>100) THEN
    RAISE EXCEPTION 'Source weighted dispatch pool probabilities are invalid.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.dispatch_orders) THEN
    RAISE EXCEPTION 'Legacy dispatch content requires review before export.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.dispatch_config WHERE config_key NOT IN
      ('dispatch_interval_min','dispatch_interval_max','session_timeout_minutes','dispatch_order_mode','dispatch_mode'))
    OR EXISTS(SELECT 1 FROM public.dispatch_config WHERE
      (config_key IN ('dispatch_interval_min','dispatch_interval_max') AND
        (config_value !~ '^[0-9]{1,4}$' OR CASE WHEN config_value ~ '^[0-9]{1,4}$' THEN config_value::integer NOT BETWEEN 1 AND 3000 ELSE true END))
      OR (config_key='session_timeout_minutes' AND
        (config_value !~ '^[0-9]{1,2}$' OR CASE WHEN config_value ~ '^[0-9]{1,2}$' THEN config_value::integer NOT BETWEEN 1 AND 60 ELSE true END))
      OR (config_key IN ('dispatch_order_mode','dispatch_mode') AND config_value NOT IN ('random','sequential'))) THEN
    RAISE EXCEPTION 'Unreviewed or invalid dispatch configuration.';
  END IF;
  IF (SELECT config_value::integer FROM public.dispatch_config WHERE config_key='dispatch_interval_min')>
       (SELECT config_value::integer FROM public.dispatch_config WHERE config_key='dispatch_interval_max') THEN
    RAISE EXCEPTION 'Invalid dispatch interval bounds.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.used_order_data AS u JOIN public.orders AS o ON o.id=u.order_id
      WHERE o.status IS NULL OR o.status NOT IN ('success','failure') OR o.user_id IS DISTINCT FROM u.user_id) THEN
    RAISE EXCEPTION 'Used submission data depends on an unfinished or mismatched order; finish source orders first.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.valid_order_data WHERE usage_count<0 OR product_value::text IN ('NaN','Infinity','-Infinity')) THEN
    RAISE EXCEPTION 'Invalid source submission usage or amount.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_dispatch_catalog()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text; v_query text; v_rows bigint; v_bytes bigint; v_largest bigint; v_hash text;
  v_total bigint:=0; v_tables jsonb:='[]';
BEGIN
  PERFORM private.employee_transfer_dispatch_schema();
  PERFORM private.employee_transfer_dispatch_source_check();
  FOREACH v_key IN ARRAY ARRAY['dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders',
    'dispatch_group_members','valid_order_data','used_order_data'] LOOP
    v_query:=private.employee_transfer_dispatch_query(v_key);
    EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),COALESCE(max(octet_length(body::text||E''\n'')),0) FROM ('||v_query||') AS r'
      INTO v_rows,v_bytes,v_largest;
    v_total:=v_total+v_bytes;
    IF v_rows>500000 OR v_bytes>268435456 OR v_total>1073741824 OR v_largest>65536 THEN
      RAISE EXCEPTION 'Dispatch/submission export exceeds reviewed limits; no rows were truncated.';
    END IF;
    EXECUTE 'SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id),''''),''UTF8''),''sha256''),''hex'') FROM ('||v_query||') AS r'
      INTO v_hash;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
  END LOOP;
  RETURN jsonb_build_object('version',1,'scope','dispatch-submission','site_id',(SELECT site_id FROM private.employee_transfer_site),
    'tables',v_tables,'processing_orders',(SELECT count(*) FROM public.orders WHERE status='processing'),
    'full_site_complete',false);
END;
$$;

CREATE OR REPLACE FUNCTION private.employee_transfer_job(p_session uuid,p_job_token uuid,p_kind text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_job private.employee_transfer_jobs%ROWTYPE; v_kind text;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_session) AS admin;
  v_kind:=CASE p_kind WHEN 'shared-import' THEN 'import' WHEN 'products-import' THEN 'import'
    WHEN 'products-export' THEN 'export' WHEN 'dispatch-export' THEN 'export' ELSE p_kind END;
  IF p_job_token IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.'; END IF;
  UPDATE private.employee_transfer_jobs SET last_activity_at=now()
    WHERE token_hash=private.hash_financial_token(p_job_token) AND kind=v_kind AND admin_id=v_admin AND status='running'
      AND last_activity_at>now()-interval '3 hours' AND started_at>now()-interval '12 hours' RETURNING * INTO v_job;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.'; END IF;
  IF (v_job.options->>'import_protocol'='shared-import-v1' AND p_kind<>'shared-import')
    OR (p_kind='shared-import' AND v_job.options->>'import_protocol' IS DISTINCT FROM 'shared-import-v1')
    OR (v_job.options->>'import_protocol'='products-v1' AND p_kind<>'products-import')
    OR (p_kind='products-import' AND v_job.options->>'import_protocol' IS DISTINCT FROM 'products-v1')
    OR (v_job.options->>'export_protocol'='products-v1' AND p_kind<>'products-export')
    OR (p_kind='products-export' AND v_job.options->>'export_protocol' IS DISTINCT FROM 'products-v1')
    OR (v_job.options->>'export_protocol'='dispatch-submission-v1' AND p_kind<>'dispatch-export')
    OR (p_kind='dispatch-export' AND v_job.options->>'export_protocol' IS DISTINCT FROM 'dispatch-submission-v1') THEN
    RAISE EXCEPTION 'The task protocol does not permit this operation.';
  END IF;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.employee_export_begin(p_admin_session_token uuid,p_admin_password text,p_options jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  IF p_options ?| ARRAY['import_protocol','export_protocol','catalog','package_id'] THEN
    RAISE EXCEPTION 'Reserved transfer protocol fields require the dedicated task initializer.';
  END IF;
  RETURN private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'export',p_options);
END;
$$;

CREATE FUNCTION public.employee_export_dispatch_begin(p_admin_session_token uuid,p_admin_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_begin jsonb; v_catalog jsonb;
BEGIN
  v_begin:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'export',
    '{"export_protocol":"dispatch-submission-v1","scope":"dispatch-submission"}');
  IF NOT COALESCE((v_begin->>'success')::boolean,false) THEN RETURN v_begin; END IF;
  v_catalog:=private.employee_transfer_dispatch_catalog();
  UPDATE private.employee_transfer_jobs SET summary=jsonb_build_object('dispatch_catalog',v_catalog)
    WHERE id=(v_begin->>'job_id')::uuid;
  RETURN (v_begin-'server_time')||jsonb_build_object('catalog',v_catalog,'scope','dispatch-submission','full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_export_dispatch_page(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_query text; v_row record; v_line text;
  v_text text:=''; v_count integer:=0; v_cursor uuid; v_more boolean:=false;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-export');
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid dispatch export page size.'; END IF;
  PERFORM private.employee_transfer_dispatch_schema();
  v_query:=private.employee_transfer_dispatch_query(p_table_key);
  IF p_after IS NOT NULL THEN
    EXECUTE 'SELECT id FROM ('||v_query||') AS r WHERE id=$1' INTO v_cursor USING p_after;
    IF v_cursor IS NULL THEN RAISE EXCEPTION 'Dispatch export cursor disappeared; restart export.'; END IF;
  END IF;
  FOR v_row IN EXECUTE v_query||' WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2'
      USING p_after,p_limit+1 LOOP
    v_line:=v_row.body::text||E'\n';
    IF octet_length(v_line)>65536 THEN RAISE EXCEPTION 'Dispatch export row exceeds the reviewed limit.'; END IF;
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_line)>262144 THEN v_more:=true; EXIT; END IF;
    v_text:=v_text||v_line; v_count:=v_count+1; v_cursor:=v_row.id;
  END LOOP;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_text,
    'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_export_dispatch_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_actual jsonb;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-export');
  v_actual:=private.employee_transfer_dispatch_catalog();
  IF v_job.summary->'dispatch_catalog' IS DISTINCT FROM v_actual THEN
    RAISE EXCEPTION 'Dispatch/submission source changed; discard this export and restart.';
  END IF;
  UPDATE private.employee_transfer_jobs SET summary=summary||'{"dispatch_verified":true}'::jsonb WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'export','dispatch_verified',
    '{"scope":"dispatch-submission","full_site_complete":false}');
  RETURN '{"verified":true,"scope":"dispatch-submission","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_export_dispatch_close(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-export');
  IF NOT COALESCE((v_job.summary->>'dispatch_verified')::boolean,false) THEN RAISE EXCEPTION 'Dispatch export has not been verified.'; END IF;
  PERFORM private.employee_transfer_end_job(v_job,'finished',COALESCE(v_job.summary,'{}')||'{"scope":"dispatch-submission","full_site_complete":false}'::jsonb);
  RETURN '{"success":true,"scope":"dispatch-submission","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.get_employee_import_dispatch_preflight(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_counts jsonb; v_blockers jsonb:='[]'; v_key text; v_count bigint;
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  PERFORM private.employee_transfer_dispatch_schema();
  SELECT jsonb_build_object(
    'orders',(SELECT count(*) FROM public.orders),
    'orders_history',(SELECT count(*) FROM public.orders_history),
    'used_submissions',(SELECT count(*) FROM public.used_order_data),
    'submission_usage',(SELECT count(*) FROM public.valid_order_data WHERE COALESCE(usage_count,0)<>0 OR last_used_at IS NOT NULL),
    'assignments',(SELECT count(*) FROM public.dispatch_assignments),
    'pool_selections',(SELECT count(*) FROM public.dispatch_pool_selections),
    'dispatch_sessions',(SELECT count(*) FROM public.dispatch_sessions),
    'wallet_transactions',(SELECT count(*) FROM public.wallet_transactions),
    'ledger_entries',(SELECT count(*) FROM public.wallet_ledger_entries),
    'reconciliation_audit',(SELECT count(*) FROM public.wallet_reconciliation_audit),
    'withdrawals',(SELECT count(*) FROM public.withdrawals),
    'wallet_funds',(SELECT count(*) FROM public.wallets WHERE COALESCE(available_balance,0)<>0 OR COALESCE(frozen_balance,0)<>0),
    'income',(SELECT count(*) FROM public.users WHERE COALESCE(total_income,0)<>0),
    'baseline_funds',(SELECT count(*) FROM public.wallet_balance_baselines WHERE available_balance<>0 OR frozen_balance<>0 OR total_income<>0),
    'work_sessions',(SELECT count(*) FROM public.work_sessions),
    'legacy_dispatch_content',(SELECT count(*) FROM public.dispatch_orders)
  ) INTO v_counts;
  FOR v_key,v_count IN SELECT key,value::text::bigint FROM jsonb_each(v_counts) LOOP
    IF v_count>0 THEN v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object('code',v_key,'count',v_count)); END IF;
  END LOOP;
  RETURN jsonb_build_object('scope','dispatch-submission','site_id',(SELECT site_id FROM private.employee_transfer_site),
    'counts',v_counts,'blockers',v_blockers,'eligible_for_empty_target_mode',jsonb_array_length(v_blockers)=0,
    'replacement_ready',false,'full_site_complete',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_employee_transfer_log(p_admin_session_token uuid,p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_limit integer:=LEAST(GREATEST(COALESCE(p_limit,100),1),500);
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  RETURN jsonb_build_object('site_id',(SELECT site_id FROM private.employee_transfer_site),
    'last_export_at',(SELECT max(finished_at) FROM private.employee_transfer_jobs WHERE kind='export' AND status='finished'
      AND options->>'export_protocol' IS DISTINCT FROM 'products-v1'
      AND options->>'export_protocol' IS DISTINCT FROM 'dispatch-submission-v1'),
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
    'employee_export_dispatch_begin','get_employee_export_dispatch_page','employee_export_dispatch_verify',
    'employee_export_dispatch_close','get_employee_import_dispatch_preflight') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',v_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated',v_function);
  END LOOP;
END;
$$;
NOTIFY pgrst,'reload schema';
