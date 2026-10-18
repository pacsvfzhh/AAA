BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE OR REPLACE FUNCTION private.employee_transfer_trigger_tables()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT ARRAY[
    'users', 'financial_employee_credentials', 'wallets', 'wallet_balance_baselines',
    'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit',
    'orders', 'product_types', 'dispatch_group_members', 'verification_requests',
    'employee_login_history', 'work_sessions', 'messages', 'message_recipients',
    'customer_employee_conversations', 'customer_service_sessions', 'ccc_conversation_annotations',
    'customer_auto_message_logs', 'simulated_customers', 'rich_card_contents', 'used_order_data'
  ]::text[];
$$;

DO $extend_policy$
DECLARE v_definition text; v_anchor constant text := '    (''product_types'', ''assign_product_type_sort_order'', ''keep'')';
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_fixed_trigger_policy()'::regprocedure);
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'The reviewed trigger policy extension anchor changed.';
  END IF;
  EXECUTE replace(v_definition,v_anchor,
    E'    (''used_order_data'', ''trigger_update_valid_data_usage'', ''bypass''),\n'||v_anchor);
END;
$extend_policy$;

CREATE FUNCTION private.employee_transfer_dependency_owner(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_map jsonb; v_key text; v_row record; v_body jsonb; v_bad boolean; v_rows jsonb;
BEGIN
  v_map:=private.employee_transfer_identity_admin_map(p_job);
  PERFORM private.employee_transfer_dispatch_schema();
  PERFORM private.employee_transfer_assert_dispatch_config_triggers();
  PERFORM private.employee_transfer_assert_valid_triggers();
  PERFORM private.employee_transfer_dispatch_check_input(p_job);
  PERFORM count(*) FROM private.employee_transfer_verified_identity_map(p_job,'accounts');
  IF p_job.summary#>'{valid_restore,verified}' IS DISTINCT FROM 'true'::jsonb
    OR p_job.summary#>'{valid_restore,admin_map}' IS DISTINCT FROM v_map
    OR p_job.group_map IS DISTINCT FROM p_job.summary#>'{dispatch_config_plan,group_map}'
    OR p_job.group_map IS DISTINCT FROM p_job.summary#>'{dispatch_configuration_receipt,group_map}'
    OR p_job.summary#>'{dispatch_config_plan,admin_map}' IS DISTINCT FROM v_map
    OR p_job.summary#>'{dispatch_config_plan,pool_map}' IS DISTINCT FROM p_job.summary#>'{dispatch_configuration_receipt,pool_map}' THEN
    RAISE EXCEPTION 'Verified same-package configuration, identities and valid submission data are required.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders'] LOOP
    FOR v_row IN SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,v_key) LOOP
      v_body:=v_row.body;
      IF v_key='dispatch_groups' THEN v_body:=v_body||jsonb_build_object('id',p_job.group_map->v_row.id::text);
      ELSIF v_key='dispatch_order_pools' THEN v_body:=v_body||jsonb_build_object('id',p_job.summary#>ARRAY['dispatch_config_plan','pool_map',v_row.id::text],
        'group_id',p_job.group_map->(v_body->>'group_id'));
      ELSIF v_key='dispatch_group_orders' THEN v_body:=v_body||jsonb_build_object('group_id',p_job.group_map->(v_body->>'group_id'),
        'pool_id',p_job.summary#>ARRAY['dispatch_config_plan','pool_map',v_body->>'pool_id']);
      END IF;
      IF v_key<>'dispatch_config' THEN v_body:=v_body||jsonb_build_object('created_by',v_map->(v_body->>'created_by')); END IF;
      EXECUTE 'SELECT NOT EXISTS(SELECT 1 FROM ('||private.employee_transfer_dispatch_query(v_key)||') AS actual WHERE id=$1 AND body=$2)'
        INTO v_bad USING (v_body->>'id')::uuid,v_body;
      IF v_bad THEN RAISE EXCEPTION 'Verified dispatch configuration contents changed.'; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.dispatch_groups WHERE (is_default OR is_active OR archived_at IS NULL)
      AND id::text NOT IN(SELECT value FROM jsonb_each_text(p_job.group_map)))
    OR EXISTS(SELECT 1 FROM public.dispatch_order_pools WHERE is_active AND archived_at IS NULL
      AND id::text NOT IN(SELECT value FROM jsonb_each_text(p_job.summary#>'{dispatch_config_plan,pool_map}')))
    OR (SELECT count(*) FROM public.dispatch_config)<>(p_job.options#>>'{catalog,tables,0,rows}')::bigint
    OR (SELECT count(*) FROM public.dispatch_group_orders)<>(p_job.options#>>'{catalog,tables,3,rows}')::bigint
    OR (SELECT count(*) FROM public.valid_order_data)<>(p_job.options#>>'{catalog,tables,5,rows}')::bigint THEN
    RAISE EXCEPTION 'Verified dispatch or submission counts/residuals changed.';
  END IF;
  FOR v_rows IN SELECT payload->'rows' FROM private.employee_transfer_staging WHERE job_id=p_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:valid_order_data' ORDER BY chunk_no LOOP
    PERFORM private.employee_transfer_check_valid_rows(v_rows,v_map);
  END LOOP;
  RETURN v_map;
END;
$$;

CREATE FUNCTION private.employee_transfer_dependency_rows(p_job private.employee_transfer_jobs,p_key text,p_rows jsonb,p_admin_map jsonb)
RETURNS TABLE(id uuid,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF p_job.summary#>'{identity_restore,verified}' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Server-verified employee/order identities are required.';
  END IF;
  -- The owner revalidates complete identities before each request; identity-v1 preserves their UUIDs.
  IF p_key='dispatch_group_members' THEN
    RETURN QUERY WITH employees AS MATERIALIZED(SELECT i.id AS source_id,i.id AS target_id FROM private.employee_transfer_identity_input(p_job.id,'accounts') AS i)
      SELECT (s.body->>'id')::uuid,s.body||jsonb_build_object('user_id',u.target_id,
        'group_id',p_job.group_map->(s.body->>'group_id'),'assigned_by',p_admin_map->(s.body->>'assigned_by'))
      FROM jsonb_array_elements(p_rows) AS s(body) JOIN employees AS u ON u.source_id=(s.body->>'user_id')::uuid;
  ELSIF p_key='used_order_data' THEN
    RETURN QUERY WITH employees AS MATERIALIZED(SELECT i.id AS source_id,i.id AS target_id FROM private.employee_transfer_identity_input(p_job.id,'accounts') AS i),
      orders AS MATERIALIZED(SELECT i.id AS source_id,i.id AS target_id FROM private.employee_transfer_identity_input(p_job.id,'orders') AS i)
      SELECT (s.body->>'id')::uuid,s.body||jsonb_build_object('user_id',u.target_id,'order_id',o.target_id)
      FROM jsonb_array_elements(p_rows) AS s(body)
      JOIN employees AS u ON u.source_id=(s.body->>'user_id')::uuid
      JOIN orders AS o ON o.source_id=(s.body->>'order_id')::uuid
      JOIN public.orders AS actual ON actual.id=o.target_id AND actual.user_id=u.target_id AND actual.status IN ('success','failure');
  ELSE RAISE EXCEPTION 'Unsupported dispatch dependency table.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_dependency_rows(p_job private.employee_transfer_jobs,p_key text,p_rows jsonb,p_map jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_bad boolean; v_expected jsonb;
BEGIN
  SELECT COALESCE(jsonb_agg(body),'[]') INTO v_expected FROM private.employee_transfer_dependency_rows(p_job,p_key,p_rows,p_map);
  IF jsonb_array_length(v_expected)<>jsonb_array_length(p_rows) THEN RAISE EXCEPTION 'Verified employee/order dependency mapping is incomplete.'; END IF;
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM jsonb_array_elements($1) AS expected(body) LEFT JOIN ('||
    private.employee_transfer_dispatch_query(p_key)||') AS actual ON actual.id=(expected.body->>''id'')::uuid AND actual.body=expected.body WHERE actual.id IS NULL)'
    INTO v_bad USING v_expected;
  IF v_bad THEN RAISE EXCEPTION 'Dispatch dependency post-write verification failed.'; END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_dependency_progress(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_state jsonb:=p_job.summary->'dependency_restore'; v_key text; v_count bigint; v_rows jsonb;
BEGIN
  IF v_state IS NULL OR v_state->'admin_map' IS DISTINCT FROM p_map OR v_state->'group_map' IS DISTINCT FROM p_job.group_map THEN
    RAISE EXCEPTION 'Begin a bound dispatch dependency restore first.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['dispatch_group_members','used_order_data'] LOOP
    IF v_key='dispatch_group_members' THEN SELECT count(*) INTO v_count FROM public.dispatch_group_members;
    ELSE SELECT count(*) INTO v_count FROM public.used_order_data; END IF;
    IF v_count IS DISTINCT FROM (v_state#>>ARRAY['counts',v_key])::bigint THEN RAISE EXCEPTION 'Dispatch dependency committed count changed.'; END IF;
    FOR v_rows IN SELECT payload->'rows' FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:'||v_key
      AND chunk_no<(v_state#>>ARRAY['next_chunks',v_key])::integer ORDER BY chunk_no LOOP
      PERFORM private.employee_transfer_check_dependency_rows(p_job,v_key,v_rows,p_map);
    END LOOP;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_dependency_plan(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_conflicts jsonb:='[]'; v_plan jsonb;
BEGIN
  IF EXISTS(SELECT 1 FROM public.dispatch_group_members) THEN v_conflicts:=v_conflicts||'"target_members_not_empty"'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM public.used_order_data) THEN v_conflicts:=v_conflicts||'"target_used_not_empty"'::jsonb; END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_group_members') AS m
    LEFT JOIN public.admins AS a ON a.id=(p_map->>(m.body->>'assigned_by'))::uuid
    WHERE m.body->>'assigned_by' IS NOT NULL AND a.id IS NULL) THEN v_conflicts:=v_conflicts||'"unmapped_assigner"'::jsonb; END IF;
  v_plan:=jsonb_build_object('scope','dispatch-dependencies','can_restore',jsonb_array_length(v_conflicts)=0,'conflicts',v_conflicts,
    'counts',jsonb_build_object('dispatch_group_members',p_job.options#>'{catalog,tables,4,rows}','used_order_data',p_job.options#>'{catalog,tables,6,rows}'),
    'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,
    'job_id',p_job.id,'catalog',p_job.options->'catalog','identity_catalog',p_job.summary->'identity_catalog',
    'configuration_plan',p_job.summary->'dispatch_config_plan','admin_map',p_map)::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.get_employee_import_dispatch_dependency_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_map jsonb; v_plan jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_dependency_owner(v_job);
  IF v_job.summary ? 'dependency_restore' THEN
    PERFORM private.employee_transfer_check_dependency_progress(v_job,v_map);
    RETURN v_job.summary->'dependency_plan';
  END IF;
  v_plan:=private.employee_transfer_dependency_plan(v_job,v_map);
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('dependency_plan',v_plan) WHERE id=v_job.id;
  RETURN v_plan;
END;
$$;

CREATE FUNCTION private.employee_transfer_dependency_receipt(p_state jsonb,p_repeated boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object('success',true,'scope','dispatch-dependencies','counts',p_state->'counts','next_chunks',p_state->'next_chunks',
    'chunks',p_state->'chunks','totals',p_state->'totals','verified',p_state->'verified','repeated',p_repeated,
    'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false);
$$;

CREATE FUNCTION public.employee_import_dispatch_dependency_begin(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_map jsonb; v_plan jsonb; v_state jsonb; v_chunks jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_dependency_owner(v_job);
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_job.summary#>>'{dependency_plan,plan_hash}' THEN
    RAISE EXCEPTION 'A matching dispatch dependency plan must be confirmed.';
  END IF;
  v_state:=v_job.summary->'dependency_restore';
  IF v_state IS NOT NULL THEN
    PERFORM private.employee_transfer_check_dependency_progress(v_job,v_map);
    RETURN private.employee_transfer_dependency_receipt(v_state,true);
  END IF;
  v_plan:=private.employee_transfer_dependency_plan(v_job,v_map);
  IF v_plan IS DISTINCT FROM v_job.summary->'dependency_plan' OR NOT (v_plan->>'can_restore')::boolean THEN
    RAISE EXCEPTION 'Dispatch dependency plan changed or has unresolved conflicts.';
  END IF;
  SELECT jsonb_object_agg(key,n) INTO v_chunks FROM (SELECT key,count(*)::integer AS n FROM
    (VALUES('dispatch_group_members'),('used_order_data')) AS keys(key) JOIN private.employee_transfer_staging AS s
      ON s.job_id=v_job.id AND s.employee_id='00000000-0000-0000-0000-000000000000' AND s.table_key='dispatch-in:'||key GROUP BY key) AS totals;
  v_state:=jsonb_build_object('counts','{"dispatch_group_members":0,"used_order_data":0}'::jsonb,
    'next_chunks','{"dispatch_group_members":0,"used_order_data":0}'::jsonb,'chunks',v_chunks,'totals',v_plan->'counts',
    'verified',false,'admin_map',v_map,'group_map',v_job.group_map);
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('dependency_restore',v_state) WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','dispatch_dependencies_started',
    jsonb_build_object('counts',v_plan->'counts','full_site_complete',false));
  RETURN private.employee_transfer_dependency_receipt(v_state,false);
END;
$$;

CREATE FUNCTION private.employee_transfer_allow_dependency_write(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  PERFORM private.employee_transfer_identity_owner(p_job);
  IF p_job.summary#>'{identity_restore,verified}' IS DISTINCT FROM 'true'::jsonb
    OR p_job.summary#>'{valid_restore,verified}' IS DISTINCT FROM 'true'::jsonb OR NOT p_job.summary ? 'dependency_restore' THEN
    RAISE EXCEPTION 'A bound dependency restore owner is required.';
  END IF;
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names)
    VALUES(pg_current_xact_id(),p_job.id,ARRAY['public.dispatch_group_members','public.used_order_data']);
END;
$$;

CREATE FUNCTION public.employee_import_dispatch_dependency_chunk(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_map jsonb; v_state jsonb; v_rows jsonb; v_row jsonb;
  v_count integer; v_next integer; v_repeated boolean; v_disabled jsonb; v_written integer:=0;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_dependency_owner(v_job);
  PERFORM private.employee_transfer_check_dependency_progress(v_job,v_map);
  v_state:=v_job.summary->'dependency_restore';
  IF p_table_key IS NULL OR p_table_key NOT IN ('dispatch_group_members','used_order_data') THEN RAISE EXCEPTION 'Unsupported dispatch dependency table.'; END IF;
  v_next:=(v_state#>>ARRAY['next_chunks',p_table_key])::integer;
  IF p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>v_next OR p_chunk_no>=(v_state#>>ARRAY['chunks',p_table_key])::integer THEN
    RAISE EXCEPTION 'Dispatch dependency chunks must follow the committed cursor.';
  END IF;
  IF p_table_key='used_order_data' AND v_state#>'{next_chunks,dispatch_group_members}' IS DISTINCT FROM v_state#>'{chunks,dispatch_group_members}' THEN
    RAISE EXCEPTION 'Restore source members before used submission records.';
  END IF;
  SELECT payload->'rows',row_count INTO v_rows,v_count FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_rows IS NULL OR jsonb_array_length(v_rows)<>v_count OR v_count>200 THEN RAISE EXCEPTION 'Dispatch dependency staging changed.'; END IF;
  v_repeated:=p_chunk_no<v_next;
  IF NOT v_repeated THEN
    IF (v_state#>>ARRAY['counts',p_table_key])::integer+v_count>(v_state#>>ARRAY['totals',p_table_key])::integer THEN
      RAISE EXCEPTION 'Dispatch dependency rows exceed the bound catalog.';
    END IF;
    PERFORM private.employee_transfer_allow_dependency_write(v_job);
    IF p_table_key='used_order_data' THEN v_disabled:=private.employee_transfer_bypass_triggers(ARRAY['used_order_data']); END IF;
    FOR v_row IN SELECT body FROM private.employee_transfer_dependency_rows(v_job,p_table_key,v_rows,v_map) LOOP
      PERFORM private.employee_transfer_check_dispatch_row(p_table_key,v_row);
      IF p_table_key='dispatch_group_members' THEN
        INSERT INTO public.dispatch_group_members(id,group_id,user_id,assigned_by,assigned_at)
          SELECT r.id,r.group_id,r.user_id,r.assigned_by,r.assigned_at FROM jsonb_populate_record(NULL::public.dispatch_group_members,v_row) AS r;
      ELSE
        INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at)
          SELECT r.id,r.user_id,r.valid_order_data_id,r.order_id,r.created_at FROM jsonb_populate_record(NULL::public.used_order_data,v_row) AS r;
      END IF;
      v_written:=v_written+1;
    END LOOP;
    IF v_written<>v_count THEN RAISE EXCEPTION 'Verified employee/order dependency mapping is incomplete.'; END IF;
    IF v_disabled IS NOT NULL THEN PERFORM private.employee_transfer_restore_triggers(v_disabled); END IF;
    PERFORM private.employee_transfer_clear_write_permit();
    v_state:=jsonb_set(jsonb_set(v_state,ARRAY['counts',p_table_key],to_jsonb((v_state#>>ARRAY['counts',p_table_key])::integer+v_count)),
      ARRAY['next_chunks',p_table_key],to_jsonb(p_chunk_no+1));
    UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('dependency_restore',v_state) WHERE id=v_job.id RETURNING * INTO v_job;
  END IF;
  PERFORM private.employee_transfer_dependency_owner(v_job);
  PERFORM private.employee_transfer_check_dependency_progress(v_job,v_map);
  IF NOT v_repeated THEN PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','dispatch_dependencies_chunk',
    jsonb_build_object('table_key',p_table_key,'chunk_no',p_chunk_no,'rows',v_count,'full_site_complete',false)); END IF;
  RETURN private.employee_transfer_dependency_receipt(v_state,v_repeated);
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit(); RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_dispatch_dependency_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_map jsonb; v_state jsonb; v_key text; v_repeat boolean;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_dependency_owner(v_job);
  PERFORM private.employee_transfer_check_dependency_progress(v_job,v_map);
  v_state:=v_job.summary->'dependency_restore';
  FOREACH v_key IN ARRAY ARRAY['dispatch_group_members','used_order_data'] LOOP
    IF v_state#>ARRAY['counts',v_key] IS DISTINCT FROM v_state#>ARRAY['totals',v_key]
      OR v_state#>ARRAY['next_chunks',v_key] IS DISTINCT FROM v_state#>ARRAY['chunks',v_key] THEN
      RAISE EXCEPTION 'Dispatch dependency restore is incomplete.';
    END IF;
  END LOOP;
  PERFORM private.employee_transfer_dispatch_source_check();
  v_repeat:=(v_state->>'verified')::boolean; v_state:=v_state||'{"verified":true}'::jsonb;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('dependency_restore',v_state) WHERE id=v_job.id;
  IF NOT v_repeat THEN PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','dispatch_dependencies_verified',
    jsonb_build_object('counts',v_state->'counts','financial_data_pending',true,'full_site_complete',false)); END IF;
  RETURN private.employee_transfer_dependency_receipt(v_state,v_repeat);
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
  REVOKE ALL ON FUNCTION public.get_employee_import_dispatch_dependency_plan(uuid,uuid),public.employee_import_dispatch_dependency_begin(uuid,uuid,text),
    public.employee_import_dispatch_dependency_chunk(uuid,uuid,text,integer),public.employee_import_dispatch_dependency_verify(uuid,uuid) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.get_employee_import_dispatch_dependency_plan(uuid,uuid),public.employee_import_dispatch_dependency_begin(uuid,uuid,text),
    public.employee_import_dispatch_dependency_chunk(uuid,uuid,text,integer),public.employee_import_dispatch_dependency_verify(uuid,uuid) TO anon,authenticated;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
