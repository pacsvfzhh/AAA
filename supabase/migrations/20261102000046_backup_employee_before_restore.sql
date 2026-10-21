BEGIN;

CREATE OR REPLACE FUNCTION private.employee_transfer_job(p_session uuid,p_job_token uuid,p_kind text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid;v_job private.employee_transfer_jobs%ROWTYPE;v_kind text;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_session) AS admin;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_jobs WHERE token_hash=private.hash_financial_token(p_job_token)
    AND options->>'export_protocol'='employee-safety-records-v1') THEN
    RAISE EXCEPTION 'The independent employee safety task cannot use another transfer protocol.';
  END IF;
  v_kind:=CASE p_kind WHEN 'shared-import' THEN 'import' WHEN 'products-import' THEN 'import'
    WHEN 'dispatch-import' THEN 'import' WHEN 'products-export' THEN 'export' WHEN 'dispatch-export' THEN 'export'
    WHEN 'identity-export' THEN 'export' ELSE p_kind END;
  IF p_job_token IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.';END IF;
  UPDATE private.employee_transfer_jobs SET last_activity_at=now()
    WHERE token_hash=private.hash_financial_token(p_job_token) AND kind=v_kind AND admin_id=v_admin AND status='running'
      AND last_activity_at>now()-interval '3 hours' AND started_at>now()-interval '12 hours' RETURNING * INTO v_job;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.';END IF;
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
REVOKE ALL ON FUNCTION private.employee_transfer_job(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION private.employee_safety_backup_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT private.employee_transfer_replacement_backup_keys()
    || private.employee_transfer_chat_keys() || private.employee_transfer_notifications_keys()
    || ARRAY['dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders',
      'valid_order_data','used_order_data','content_audit_events','content_audit_recipient_versions','orders_history','administrators'];
$$;

CREATE FUNCTION private.employee_safety_backup_query(p_key text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_query text;v_filter text;v_prefix text;
BEGIN
  IF p_key IS NULL OR NOT p_key=ANY(private.employee_safety_backup_keys()) THEN
    RAISE EXCEPTION 'Unsupported employee safety backup table.';
  END IF;
  IF p_key=ANY(private.employee_transfer_replacement_backup_keys()) THEN
    v_query:=private.employee_transfer_replacement_backup_query(p_key);
    RETURN 'SELECT id::text COLLATE "C" AS id,body FROM ('||v_query||') AS scoped';
  END IF;
  v_prefix:=$q$WITH RECURSIVE selected_roles AS (
    SELECT id FROM public.simulated_customers WHERE target_employee_id=$1 OR $1=ANY(target_employee_ids)
    UNION SELECT customer_id FROM public.customer_employee_conversations WHERE employee_id=$1
    UNION SELECT customer_id FROM public.customer_service_sessions WHERE employee_id=$1
    UNION SELECT customer_id FROM public.ccc_conversation_annotations WHERE employee_id=$1
    UNION SELECT customer_id FROM public.customer_auto_message_logs WHERE employee_id=$1
    UNION SELECT customer_id FROM public.rating_requests WHERE employee_id=$1
    UNION SELECT customer_id FROM public.service_ratings WHERE employee_id=$1
  ), selected_templates AS (
    SELECT t.id FROM public.cs_message_templates t JOIN public.simulated_customers r
      ON r.admin_id::text=t.admin_id AND r.source_type=t.source_type WHERE r.id IN (SELECT id FROM selected_roles)
    UNION SELECT source_template_id FROM public.customer_employee_conversations WHERE employee_id=$1 AND source_template_id IS NOT NULL
  ), selected_autos AS (
    SELECT id FROM public.customer_auto_messages WHERE customer_id IN (SELECT id FROM selected_roles)
    UNION SELECT source_auto_message_id FROM public.customer_employee_conversations WHERE employee_id=$1 AND source_auto_message_id IS NOT NULL
    UNION SELECT auto_message_id FROM public.customer_auto_message_logs WHERE employee_id=$1
  ), selected_tasks(id) AS (
    SELECT t.id FROM public.notification_automation_tasks t WHERE
      private.automation_task_applies_to_user(t,$1)
      OR t.plan_id IN (SELECT plan_id FROM public.notification_automation_plan_members WHERE user_id=$1)
      OR t.id IN (SELECT task_id FROM public.notification_automation_task_recipients WHERE user_id=$1
        UNION SELECT task_id FROM public.notification_automation_progress WHERE user_id=$1
        UNION SELECT task_id FROM public.notification_automation_executions WHERE user_id=$1
        UNION SELECT task_id FROM public.notification_automation_failures WHERE user_id=$1)
    UNION SELECT parent.source_task_id FROM public.notification_automation_tasks parent
      JOIN selected_tasks child ON parent.id=child.id WHERE parent.source_task_id IS NOT NULL
  ), selected_plans AS (
    SELECT plan_id AS id FROM public.notification_automation_plan_members WHERE user_id=$1
    UNION SELECT plan_id FROM public.notification_automation_tasks WHERE id IN (SELECT id FROM selected_tasks) AND plan_id IS NOT NULL
    UNION SELECT plan_id FROM public.notification_automation_executions WHERE user_id=$1 AND plan_id IS NOT NULL
  ), selected_messages AS (
    SELECT message_id AS id FROM public.message_recipients WHERE recipient_id=$1
    UNION SELECT message_id FROM public.notification_automation_executions WHERE user_id=$1 AND message_id IS NOT NULL
    UNION SELECT message_id FROM private.content_audit_recipient_versions WHERE recipient_id=$1
  ), selected_groups AS (
    SELECT group_id AS id FROM public.dispatch_group_members WHERE user_id=$1
  ) $q$;
  IF p_key=ANY(private.employee_transfer_chat_keys()) THEN
    v_query:=private.employee_transfer_chat_query(p_key);
    v_filter:=CASE p_key
      WHEN 'simulated_customers' THEN 'r.id IN (SELECT id::text FROM selected_roles)'
      WHEN 'cs_message_templates' THEN 'r.id IN (SELECT id::text FROM selected_templates)'
      WHEN 'customer_auto_messages' THEN 'r.id IN (SELECT id::text FROM selected_autos)'
      WHEN 'rich_card_contents' THEN 'r.id IN (SELECT rich_card_content_id::text FROM public.customer_employee_conversations WHERE employee_id=$1)
        OR r.body->>''source_template_id'' IN (SELECT id::text FROM selected_templates)
        OR r.body->>''source_auto_message_id'' IN (SELECT id::text FROM selected_autos)'
      ELSE 'r.body->>''employee_id''=$1::text' END;
  ELSIF p_key=ANY(private.employee_transfer_notifications_keys()) THEN
    v_query:=private.employee_transfer_notifications_query(p_key);
    v_filter:=CASE p_key
      WHEN 'notification_automation_plans' THEN 'r.id IN (SELECT id::text FROM selected_plans)'
      WHEN 'notification_automation_tasks' THEN 'r.id IN (SELECT id::text FROM selected_tasks)'
      WHEN 'notification_automation_date_runs' THEN 'r.body->>''task_id'' IN (SELECT id::text FROM selected_tasks)'
      WHEN 'messages' THEN 'r.id IN (SELECT id::text FROM selected_messages)'
      WHEN 'message_recipients' THEN 'r.body->>''recipient_id''=$1::text'
      WHEN 'message_templates' THEN 'r.body->>''admin_id'' IN (SELECT sender_id::text FROM public.messages WHERE id IN (SELECT id FROM selected_messages))'
      WHEN 'broadcast_messages' THEN 'r.id IN (SELECT broadcast_id::text FROM public.broadcast_recipients WHERE employee_id=$1)'
      WHEN 'broadcast_recipients' THEN 'r.body->>''employee_id''=$1::text'
      ELSE 'r.body->>''user_id''=$1::text' END;
  ELSIF p_key IN ('dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders','valid_order_data','used_order_data') THEN
    v_query:=private.employee_transfer_dispatch_query(p_key);
    v_filter:=CASE p_key
      WHEN 'dispatch_config' THEN 'true'
      WHEN 'dispatch_groups' THEN 'r.id IN (SELECT id FROM selected_groups)'
      WHEN 'dispatch_order_pools' THEN '(r.body->>''group_id'')::uuid IN (SELECT id FROM selected_groups)'
      WHEN 'dispatch_group_orders' THEN '(r.body->>''group_id'')::uuid IN (SELECT id FROM selected_groups)'
      WHEN 'valid_order_data' THEN 'r.id IN (SELECT valid_order_data_id FROM public.used_order_data WHERE user_id=$1)'
      ELSE 'r.body->>''user_id''=$1::text' END;
  ELSIF p_key IN ('content_audit_events','content_audit_recipient_versions') THEN
    v_query:=private.employee_transfer_archives_query(p_key);
    v_filter:=CASE p_key WHEN 'content_audit_events' THEN 'r.body->>''employee_id''=$1::text'
      ELSE 'r.body->>''recipient_id''=$1::text' END;
  ELSIF p_key='orders_history' THEN
    v_query:='SELECT id,jsonb_build_object(''id'',id,''user_id'',user_id,''status'',status,''commission_amount'',commission_amount,
      ''created_at'',created_at,''completed_at'',completed_at) AS body
      FROM public.orders_history WHERE user_id=$1 AND status IN (''success'',''failure'')';
    v_filter:='true';
  ELSE
    v_query:='SELECT id,jsonb_build_object(''id'',id,''username'',username,''role'',role,''parent_id'',parent_id,
      ''created_at'',created_at,''updated_at'',updated_at) AS body FROM public.admins';
    v_filter:='true';
  END IF;
  RETURN v_prefix||'SELECT r.id::text COLLATE "C" AS id,r.body FROM ('||v_query||') AS r WHERE '||v_filter;
END;
$$;

CREATE FUNCTION private.employee_safety_backup_catalog(p_job_id uuid,p_employee_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_user public.users%ROWTYPE;v_key text;v_query text;v_rows bigint;v_bytes bigint;v_largest bigint;v_hash text;
  v_total bigint:=0;v_tables jsonb:='[]';v_catalog jsonb;v_projection jsonb;v_column text;v_type text;
BEGIN
  SELECT * INTO v_user FROM public.users WHERE id=p_employee_id AND archived_at IS NULL;
  IF p_job_id IS NULL OR v_user.id IS NULL THEN RAISE EXCEPTION 'Employee safety backup requires an unarchived employee.';END IF;
  IF EXISTS(SELECT 1 FROM public.orders WHERE user_id=p_employee_id AND status='processing') THEN
    RAISE EXCEPTION 'Finish processing orders before taking an employee safety backup.';
  END IF;
  IF EXISTS(SELECT 1 FROM private.deleted_employee_accounts WHERE employee_id=p_employee_id AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'Employee safety backup target has unresolved archive evidence.';
  END IF;
  PERFORM private.employee_transfer_identity_schema();
  PERFORM private.employee_transfer_finance_schema();
  PERFORM private.employee_transfer_activity_schema();
  PERFORM private.employee_transfer_verification_schema();
  PERFORM private.employee_transfer_chat_schema();
  PERFORM private.employee_transfer_notifications_schema();
  PERFORM private.employee_transfer_dispatch_schema();
  PERFORM private.employee_transfer_archives_schema();
  PERFORM private.employee_transfer_replacement_device_check(h.device_info)
    FROM public.employee_login_history h WHERE h.user_id=p_employee_id;
  FOREACH v_key IN ARRAY ARRAY['employee_submit_time_settings','orders_history','administrators'] LOOP
    v_projection:=CASE v_key WHEN 'employee_submit_time_settings' THEN private.employee_transfer_replacement_backup_spec()->v_key
      WHEN 'orders_history' THEN '{"id":"uuid!","user_id":"uuid!","status":"text!","commission_amount":"numeric","created_at":"timestamp with time zone","completed_at":"timestamp with time zone"}'::jsonb
      ELSE '{"id":"uuid!","username":"text!","role":"text!","parent_id":"uuid","created_at":"timestamp with time zone","updated_at":"timestamp with time zone"}'::jsonb END;
    FOR v_column,v_type IN SELECT key,value#>>'{}' FROM jsonb_each(v_projection) LOOP
      IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.'||CASE WHEN v_key='administrators' THEN 'admins' ELSE v_key END)
        AND attname=v_column AND attnum>0 AND NOT attisdropped AND format_type(atttypid,atttypmod)=rtrim(v_type,'!')
        AND (right(v_type,1)<>'!' OR attnotnull)) THEN RAISE EXCEPTION 'Unreviewed employee safety dependency projection.';END IF;
    END LOOP;
  END LOOP;
  FOREACH v_key IN ARRAY private.employee_safety_backup_keys() LOOP
    v_query:=private.employee_safety_backup_query(v_key);
    EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),COALESCE(max(octet_length(body::text||E''\n'')),0),
      encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),''''
        ORDER BY '||CASE WHEN v_key IN ('wallet_ledger_entries','wallet_reconciliation_audit') THEN 'id::bigint' ELSE 'id COLLATE "C"' END||'),''''),''UTF8''),''sha256''),''hex'')
      FROM ('||v_query||') AS scoped' INTO v_rows,v_bytes,v_largest,v_hash USING p_employee_id;
    v_total:=v_total+v_bytes;
    IF v_rows>500000 OR v_bytes>268435456 OR v_total>1073741824 OR v_largest>65536 THEN
      RAISE EXCEPTION 'Employee safety records exceed reviewed limits; no records were truncated.';
    END IF;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
  END LOOP;
  v_catalog:=jsonb_build_object('version',1,'protocol','employee-safety-records-v1','scope','employee-safety-records',
    'job_id',p_job_id,'site_id',(SELECT site_id FROM private.employee_transfer_site),'employee_id',p_employee_id,'username',v_user.username,
    'tables',v_tables,'records_only',true,'media_included',false,'complete_employee_backup',false,
    'can_archive',false,'can_replace',false,'full_site_complete',false);
  RETURN v_catalog||jsonb_build_object('fingerprint',encode(extensions.digest(convert_to(v_catalog::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_safety_backup_owner(p_session uuid,p_token uuid)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid;v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  SELECT admin_id INTO v_admin FROM private.employee_transfer_admin(p_session);
  SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE token_hash=private.hash_financial_token(p_token)
    AND admin_id=v_admin AND kind='export' AND status='running' AND options->>'export_protocol'='employee-safety-records-v1'
    AND last_activity_at>now()-interval '3 hours' AND started_at>now()-interval '12 hours';
  IF p_token IS NULL OR v_job.id IS NULL OR v_job.summary->'employee_safety_catalog' IS NULL THEN
    RAISE EXCEPTION 'Employee safety backup owner task is invalid or expired.';
  END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_maintenance) THEN RAISE EXCEPTION 'Employee safety backup must precede restore maintenance.';END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION public.employee_safety_backup_begin(p_admin_session_token uuid,p_admin_password text,p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_start jsonb;v_catalog jsonb;v_id uuid;
BEGIN
  PERFORM private.employee_transfer_admin(p_admin_session_token);
  IF p_username IS NULL OR length(p_username) NOT BETWEEN 1 AND 256 OR btrim(p_username)<>p_username THEN
    RAISE EXCEPTION 'An exact employee username is required.';
  END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_maintenance) OR EXISTS(SELECT 1 FROM private.employee_transfer_jobs WHERE status='running') THEN
    RAISE EXCEPTION 'Reconcile existing transfer tasks and maintenance before an employee safety backup.';
  END IF;
  SELECT id INTO v_id FROM public.users WHERE username=p_username AND archived_at IS NULL;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Employee safety backup target does not exist.';END IF;
  v_start:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'export',
    jsonb_build_object('export_protocol','employee-safety-records-v1','scope','employee-safety-records','employee_id',v_id));
  IF v_start->'success' IS DISTINCT FROM 'true'::jsonb THEN RETURN v_start;END IF;
  v_catalog:=private.employee_safety_backup_catalog((v_start->>'job_id')::uuid,v_id);
  UPDATE private.employee_transfer_jobs SET summary=jsonb_build_object('employee_safety_catalog',v_catalog)
    WHERE id=(v_start->>'job_id')::uuid;
  RETURN (v_start-'server_time')||jsonb_build_object('catalog',v_catalog,'scope','employee-safety-records','full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_safety_backup_catalog(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_catalog jsonb;
BEGIN
  v_job:=private.employee_safety_backup_owner(p_admin_session_token,p_job_token);
  v_catalog:=private.employee_safety_backup_catalog(v_job.id,(v_job.options->>'employee_id')::uuid);
  IF v_catalog IS DISTINCT FROM v_job.summary->'employee_safety_catalog' THEN RAISE EXCEPTION 'Employee safety backup content changed; reconcile before restarting.';END IF;
  RETURN v_catalog;
END;
$$;

CREATE FUNCTION public.get_employee_safety_backup_page(p_admin_session_token uuid,p_job_token uuid,p_catalog_fingerprint text,
  p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_catalog jsonb;v_query text;v_id uuid;v_type text;v_order text;v_cursor text;v_row record;
  v_line text;v_text text:='';v_count integer:=0;v_more boolean:=false;
BEGIN
  v_catalog:=public.get_employee_safety_backup_catalog(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_replacement_backup_check(v_catalog,p_catalog_fingerprint);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 OR (p_after IS NOT NULL AND octet_length(p_after)>512) THEN RAISE EXCEPTION 'Invalid employee safety page bounds.';END IF;
  v_id:=(v_catalog->>'employee_id')::uuid;v_query:=private.employee_safety_backup_query(p_table_key);
  v_type:=CASE WHEN p_table_key IN ('wallet_ledger_entries','wallet_reconciliation_audit') THEN 'bigint' ELSE 'text' END;
  v_order:=CASE WHEN v_type='bigint' THEN 'id::bigint' ELSE 'id COLLATE "C"' END;
  IF p_after IS NOT NULL THEN
    EXECUTE 'SELECT id FROM ('||v_query||') AS scoped WHERE id=$2::text' INTO v_cursor USING v_id,p_after;
    IF v_cursor IS NULL OR v_cursor IS DISTINCT FROM p_after THEN RAISE EXCEPTION 'Employee safety cursor does not belong to this snapshot.';END IF;
  END IF;
  FOR v_row IN EXECUTE 'SELECT id,body::text AS body FROM ('||v_query||') AS scoped WHERE ($2::'||v_type||' IS NULL OR '
    ||v_order||'>$2::'||v_type||CASE WHEN v_type='text' THEN ' COLLATE "C"' ELSE '' END||') ORDER BY '||v_order||' LIMIT $3'
    USING v_id,p_after,p_limit+1 LOOP
    v_line:=v_row.body||E'\n';
    IF octet_length(v_line)>65536 THEN RAISE EXCEPTION 'Employee safety row exceeds reviewed limits.';END IF;
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_line)>262144 THEN v_more:=true;EXIT;END IF;
    v_text:=v_text||v_line;v_cursor:=v_row.id;v_count:=v_count+1;
  END LOOP;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'bytes',octet_length(v_text),'ndjson',v_text,
    'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,'fingerprint',v_catalog->>'fingerprint',
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_safety_backup_verify(p_admin_session_token uuid,p_job_token uuid,p_catalog_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_catalog jsonb;
BEGIN
  v_catalog:=public.get_employee_safety_backup_catalog(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_replacement_backup_check(v_catalog,p_catalog_fingerprint);
  RETURN jsonb_build_object('verified',true,'fingerprint',v_catalog->>'fingerprint','records_only',true,'media_included',false,
    'complete_employee_backup',false,'can_archive',false,'can_replace',false,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_safety_backup_close(p_admin_session_token uuid,p_job_token uuid,p_catalog_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_safety_backup_owner(p_admin_session_token,p_job_token);
  PERFORM public.employee_safety_backup_verify(p_admin_session_token,p_job_token,p_catalog_fingerprint);
  PERFORM private.employee_transfer_end_job(v_job,'finished',v_job.summary);
  RETURN jsonb_build_object('success',true,'scope','employee-safety-records','full_site_complete',false);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_safety_backup_keys(),private.employee_safety_backup_query(text),
  private.employee_safety_backup_catalog(uuid,uuid),private.employee_safety_backup_owner(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.employee_safety_backup_begin(uuid,text,text),public.get_employee_safety_backup_catalog(uuid,uuid),
  public.get_employee_safety_backup_page(uuid,uuid,text,text,text,integer),public.employee_safety_backup_verify(uuid,uuid,text),
  public.employee_safety_backup_close(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_safety_backup_begin(uuid,text,text),public.get_employee_safety_backup_catalog(uuid,uuid),
  public.get_employee_safety_backup_page(uuid,uuid,text,text,text,integer),public.employee_safety_backup_verify(uuid,uuid,text),
  public.employee_safety_backup_close(uuid,uuid,text) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
