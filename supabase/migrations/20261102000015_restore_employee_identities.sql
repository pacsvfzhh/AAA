BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

DO $install_identity_audit$
DECLARE v_expected constant jsonb := '{
 "orders.prevent_delete_orders": "c7dbdc534d81bad6c3a8194b8ca9931a5f49b9fd8514b360aedc0c521f09eaea",
 "orders.protect_order_dispatch_rate_snapshots": "735e401b1a5a08569d42830a6287ab3a5d7489bcf36e8ad82145e5036e8a3098",
 "orders.queue_notification_automation_from_order": "4ad467b9c996a61ab9775e867c84c519d105fb451b33c8b73d91d7f613d1259d",
 "orders.snapshot_order_dispatch_rates": "c81ed0c91df581498abea3ef4df3b195a48b754491efa3e0e7ff0af5a081eac0",
 "orders.trg_set_order_scheduled_process_at": "995f457e8beca3c694e4727444f99447a3e18da0fee7fa71fb718a3b119f4fb6",
 "orders.trigger_audit_order_status": "220379724f642be8b79275ef5f6b198341c2cffbe261b99c0fc64035b487eccc",
 "orders.trigger_sync_order_to_wallet": "8f36c09a1075c289e390e627b2c1132f22e1aa8bdab0e166f9305915ddf1c7c3",
 "orders.trigger_update_total_income": "4fccb3a702490360eb4157d3ef3c99648a12ce07905faccc44900b09aeed3676",
 "product_types.assign_product_type_sort_order": "fdc7b99ed529c8ce3d8625ff7cb8831116594ab4131fd2ba5129e107c8fee8e3",
 "users.archive_employee_before_delete": "4ce0bf551fa8f0914dd942da845e99216af2b94c5b9565e83be753d3b29746fe",
 "users.cleanup_user_data_trigger": "086ec06b1fcd9e05c26c98d121f6eeaf846b53771ceb6911d00b0e37c8a58d5c",
 "users.cleanup_user_storage_trigger": "9a22da546010b5941f9eaabcef3c9427b2d88341f703a06b5c4e5938e570002e",
 "users.create_wallet_trigger": "08aa2dd3d5c983f536de4fdfc2a9b15e7f17613f7982b093f66deeccdd91f943",
 "users.guard_employee_archive": "944e975586bbfcbf828f6b1443fc2f95589a8fc1b3e976e4d006e50935977bd0",
 "users.trigger_cleanup_user_data": "489017d87a5adb4215218e8a536071690534592f5d35de1d321ca9071816309d",
 "wallets.prevent_delete_wallets": "d592e4870cadcfaae56331a7ac970d54c6c4762566b8745e25f4aca2ece75d6f",
 "wallets.trigger_enqueue_changed_wallet": "e08a1c5297af0f42114e8891513b03d5b3c17a896c4d98da47da6a88f4c6e784"
}'; v_native jsonb; v_actual jsonb; v_modes jsonb;
BEGIN
  SELECT jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_install_trigger_digest(t.oid)),
    jsonb_object_agg(c.relname||'.'||t.tgname,t.tgenabled::text),
    jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_trigger_digest(t.oid)) INTO v_actual,v_modes,v_native
    FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid
    WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('users','financial_employee_credentials','wallets','orders','product_types')
      AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance';
  IF v_actual IS DISTINCT FROM v_expected OR EXISTS(SELECT 1 FROM jsonb_each_text(v_modes) WHERE value NOT IN ('O','A')) THEN
    RAISE EXCEPTION 'Unreviewed employee identity write triggers.';
  END IF;
  EXECUTE format($definition$
    CREATE FUNCTION private.employee_transfer_assert_identity_triggers()
    RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, private, pg_temp AS $body$
    DECLARE v_expected constant jsonb:=%L::jsonb; v_modes constant jsonb:=%L::jsonb; v_actual jsonb; v_actual_modes jsonb;
    BEGIN
      PERFORM private.employee_transfer_assert_maintenance_guards();
      SELECT jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_trigger_digest(t.oid)),
        jsonb_object_agg(c.relname||'.'||t.tgname,t.tgenabled::text) INTO v_actual,v_actual_modes
        FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid
        WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('users','financial_employee_credentials','wallets','orders','product_types')
          AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance';
      IF v_actual IS DISTINCT FROM v_expected OR v_actual_modes IS DISTINCT FROM v_modes THEN
        RAISE EXCEPTION 'Unreviewed employee identity write triggers.';
      END IF;
    END;
    $body$;
  $definition$,v_native::text,v_modes::text);
END;
$install_identity_audit$;

CREATE FUNCTION private.employee_transfer_identity_admin_map(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  PERFORM private.employee_transfer_identity_owner(p_job);
  PERFORM private.employee_transfer_assert_identity_triggers();
  RETURN private.employee_transfer_dispatch_admin_map(p_job);
END;
$$;

CREATE FUNCTION private.employee_transfer_identity_plan(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb; v_counts jsonb; v_conflicts jsonb; v_plan jsonb; v_product uuid;
BEGIN
  v_map:=private.employee_transfer_identity_admin_map(p_job);
  v_counts:=private.employee_transfer_check_identity_input(p_job);
  SELECT id INTO v_product FROM public.product_types WHERE name='舊站匯入（精簡訂單）';
  WITH accounts AS MATERIALIZED(SELECT * FROM private.employee_transfer_identity_input(p_job.id,'accounts')),
  orders AS MATERIALIZED(SELECT * FROM private.employee_transfer_identity_input(p_job.id,'orders')),
  issues AS (
    SELECT a.id AS source_id,'employee_id_conflict' AS reason FROM accounts AS a JOIN public.users AS u ON u.id=a.id
    UNION ALL SELECT a.id,'username_requires_archive' FROM accounts AS a JOIN public.users AS u ON u.username=a.body->>'username' AND u.id<>a.id
    UNION ALL SELECT a.id,'employee_number_conflict' FROM accounts AS a JOIN public.users AS u ON u.employee_id=a.body->>'employee_id' AND u.id<>a.id
    UNION ALL SELECT a.id,'administrator_username_conflict' FROM accounts AS a JOIN public.admins AS u ON u.username=a.body->>'username'
    UNION ALL SELECT a.id,'unmapped_administrator' FROM accounts AS a LEFT JOIN public.admins AS u ON u.id=(v_map->>(a.body->>'created_by'))::uuid
      WHERE (a.body->>'created_by' IS NOT NULL AND u.id IS NULL) OR (a.body->>'created_by' IS NULL AND
        ((SELECT attnotnull FROM pg_attribute WHERE attrelid='public.users'::regclass AND attname='created_by') OR EXISTS(
          SELECT 1 FROM pg_constraint WHERE conrelid='public.users'::regclass AND conname='users_created_by_required' AND contype='c')))
    UNION ALL SELECT o.id,'order_id_conflict' FROM orders AS o JOIN public.orders AS target ON target.id=o.id
    UNION ALL SELECT v_product,'placeholder_product_active' WHERE EXISTS(SELECT 1 FROM public.product_types WHERE id=v_product AND is_active IS DISTINCT FROM false)
    UNION ALL SELECT m.id,'dispatch_employee_missing' FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_group_members') AS m
      LEFT JOIN accounts AS a ON a.id=(m.body->>'user_id')::uuid WHERE a.id IS NULL
    UNION ALL SELECT u.id,'used_order_missing_or_mismatched' FROM private.employee_transfer_dispatch_input(p_job.id,'used_order_data') AS u
      LEFT JOIN orders AS o ON o.id=(u.body->>'order_id')::uuid AND o.body->>'user_id'=u.body->>'user_id' WHERE o.id IS NULL
  ) SELECT COALESCE(jsonb_agg(to_jsonb(issue) ORDER BY source_id,reason),'[]') INTO v_conflicts
    FROM (SELECT * FROM issues ORDER BY source_id,reason LIMIT 200) AS issue;
  v_plan:=jsonb_build_object('scope','employee-identity','can_restore',jsonb_array_length(v_conflicts)=0,'counts',v_counts,
    'conflicts',v_conflicts,'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,
    'replacement_ready',false,'full_site_complete',false);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,
    'catalog',p_job.summary->'identity_catalog','admin_map',v_map,'job_id',p_job.id,'placeholder_product_id',v_product)::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.get_employee_import_identity_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_plan jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  IF v_job.summary ? 'identity_restore' THEN RAISE EXCEPTION 'Identity restore already started; use its committed progress.'; END IF;
  v_plan:=private.employee_transfer_identity_plan(v_job);
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('identity_plan',v_plan) WHERE id=v_job.id;
  RETURN v_plan;
END;
$$;

CREATE FUNCTION private.employee_transfer_allow_identity_write(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  PERFORM private.employee_transfer_identity_owner(p_job);
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names)
    VALUES(pg_current_xact_id(),p_job.id,ARRAY['public.users','public.financial_employee_credentials','public.wallets','public.orders','public.product_types']);
END;
$$;

CREATE FUNCTION private.employee_transfer_identity_receipt(p_state jsonb,p_repeated boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object('success',true,'scope','employee-identity','counts',p_state->'counts',
    'next_chunks',p_state->'next_chunks','chunks',p_state->'chunks','totals',p_state->'totals','verified',p_state->'verified',
    'repeated',p_repeated,'maintenance',true,'financial_data_pending',true,'dependencies_pending',true,
    'replacement_ready',false,'full_site_complete',false);
$$;

CREATE FUNCTION private.employee_transfer_check_identity_written(p_job private.employee_transfer_jobs,p_key text,p_rows jsonb,p_map jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_query text; v_bad boolean;
BEGIN
  v_query:=private.employee_transfer_identity_query(p_key);
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM jsonb_array_elements($1) AS source(body) LEFT JOIN ('||v_query||') AS actual
    ON actual.id=(source.body->>''id'')::uuid AND actual.body=CASE $3
      WHEN ''accounts'' THEN source.body||jsonb_build_object(''created_by'',$2->(source.body->>''created_by''),''is_active'',false)
      ELSE source.body END WHERE actual.id IS NULL)' INTO v_bad USING p_rows,p_map,p_key;
  IF v_bad THEN RAISE EXCEPTION 'Employee identity post-write verification failed.'; END IF;
  IF p_key='accounts' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) AS source(body)
    JOIN public.users AS u ON u.id=(source.body->>'id')::uuid WHERE u.is_active IS DISTINCT FROM false OR u.archived_at IS NOT NULL
      OR u.current_session_token IS NOT NULL OR u.session_created_at IS NOT NULL OR u.last_heartbeat_at IS NOT NULL OR u.current_tab_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Imported employee must remain disabled with no login session.';
  END IF;
  IF p_key='orders' AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_rows) AS source(body)
    JOIN public.orders AS o ON o.id=(source.body->>'id')::uuid JOIN public.users AS u ON u.id=o.user_id
    WHERE o.username IS DISTINCT FROM u.username OR o.product_type_id IS DISTINCT FROM p_job.placeholder_product_id
      OR o.product_value IS DISTINCT FROM 0.01::numeric OR o.order_number IS DISTINCT FROM 'IMPORTED-'||o.id::text
      OR o.transaction_id IS DISTINCT FROM 'IMPORTED-'||o.id::text OR o.assignment_id IS NOT NULL OR o.scheduled_process_at IS NOT NULL
      OR o.dispatch_commission_rate_snapshot IS NOT NULL OR o.dispatch_success_rate_snapshot IS NOT NULL) THEN
    RAISE EXCEPTION 'Imported order contains unapproved historical details or live dispatch references.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_verify_identity_contents(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text; v_rows jsonb; v_actual bigint; v_expected bigint;
BEGIN
  PERFORM private.employee_transfer_check_identity_input(p_job);
  FOREACH v_key IN ARRAY ARRAY['accounts','credentials','orders'] LOOP
    v_expected:=(p_job.summary#>>ARRAY['identity_restore','totals',v_key])::bigint;
    IF v_key='orders' THEN
      SELECT count(*) INTO v_actual FROM public.orders AS o WHERE o.user_id IN(SELECT id FROM private.employee_transfer_identity_input(p_job.id,'accounts'));
    ELSIF v_key='credentials' THEN
      SELECT count(*) INTO v_actual FROM public.financial_employee_credentials AS c WHERE c.user_id IN(SELECT id FROM private.employee_transfer_identity_input(p_job.id,'accounts'));
    ELSE
      SELECT count(*) INTO v_actual FROM public.users AS u WHERE u.id IN(SELECT id FROM private.employee_transfer_identity_input(p_job.id,'accounts'));
    END IF;
    IF v_actual IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Employee identity committed count changed.'; END IF;
    FOR v_rows IN SELECT payload->'rows' FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:'||v_key ORDER BY chunk_no LOOP
      PERFORM private.employee_transfer_check_identity_written(p_job,v_key,v_rows,p_map);
    END LOOP;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM public.product_types WHERE id=p_job.placeholder_product_id AND name='舊站匯入（精簡訂單）' AND is_active=false) THEN
    RAISE EXCEPTION 'The historical order placeholder is missing or active.';
  END IF;
END;
$$;

CREATE FUNCTION public.employee_import_identity_begin(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_map jsonb; v_plan jsonb; v_state jsonb; v_chunks jsonb; v_product uuid;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_identity_admin_map(v_job);
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_job.summary#>>'{identity_plan,plan_hash}' THEN
    RAISE EXCEPTION 'A matching employee identity plan must be confirmed.';
  END IF;
  v_state:=v_job.summary->'identity_restore';
  IF v_state IS NOT NULL THEN
    IF v_state->'admin_map' IS DISTINCT FROM v_map THEN RAISE EXCEPTION 'Employee identity administrator mapping changed.'; END IF;
    IF (v_state->>'verified')::boolean THEN PERFORM private.employee_transfer_verify_identity_contents(v_job,v_map); END IF;
    RETURN private.employee_transfer_identity_receipt(v_state,true);
  END IF;
  v_plan:=private.employee_transfer_identity_plan(v_job);
  IF v_plan IS DISTINCT FROM v_job.summary->'identity_plan' OR NOT (v_plan->>'can_restore')::boolean THEN
    RAISE EXCEPTION 'Employee identity plan changed or has unresolved conflicts.';
  END IF;
  SELECT jsonb_object_agg(key,n) INTO v_chunks FROM (SELECT key,count(*)::integer AS n FROM
    (VALUES('accounts'),('credentials'),('orders')) AS keys(key) JOIN private.employee_transfer_staging AS s
      ON s.job_id=v_job.id AND s.employee_id='00000000-0000-0000-0000-000000000000' AND s.table_key='identity-in:'||key GROUP BY key) AS counts;
  PERFORM private.employee_transfer_allow_identity_write(v_job);
  SELECT id INTO v_product FROM public.product_types WHERE name='舊站匯入（精簡訂單）';
  IF v_product IS NULL THEN INSERT INTO public.product_types(name,is_active) VALUES('舊站匯入（精簡訂單）',false) RETURNING id INTO v_product; END IF;
  PERFORM private.employee_transfer_clear_write_permit();
  v_state:=jsonb_build_object('counts','{"accounts":0,"credentials":0,"orders":0}'::jsonb,
    'next_chunks','{"accounts":0,"credentials":0,"orders":0}'::jsonb,'chunks',v_chunks,'totals',v_plan->'counts','verified',false,'admin_map',v_map);
  UPDATE private.employee_transfer_jobs SET placeholder_product_id=v_product,summary=summary||jsonb_build_object('identity_restore',v_state) WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','identity_restore_started',
    jsonb_build_object('counts',v_plan->'counts','financial_data_pending',true,'full_site_complete',false));
  RETURN private.employee_transfer_identity_receipt(v_state,false);
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit(); RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_identity_chunk(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_map jsonb; v_state jsonb; v_rows jsonb; v_count integer;
  v_next integer; v_repeated boolean; v_row jsonb; v_disabled jsonb; v_previous text;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_identity_admin_map(v_job);
  v_state:=v_job.summary->'identity_restore';
  IF v_state IS NULL OR v_state->'admin_map' IS DISTINCT FROM v_map THEN RAISE EXCEPTION 'Begin a bound employee identity restore first.'; END IF;
  IF p_table_key IS NULL OR p_table_key NOT IN ('accounts','credentials','orders') THEN RAISE EXCEPTION 'Unknown employee identity table.'; END IF;
  v_next:=(v_state#>>ARRAY['next_chunks',p_table_key])::integer;
  IF p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>v_next OR p_chunk_no>=(v_state#>>ARRAY['chunks',p_table_key])::integer THEN
    RAISE EXCEPTION 'Employee identity chunks must follow the committed cursor.';
  END IF;
  v_previous:=CASE p_table_key WHEN 'credentials' THEN 'accounts' WHEN 'orders' THEN 'credentials' END;
  IF v_previous IS NOT NULL AND v_state#>ARRAY['next_chunks',v_previous] IS DISTINCT FROM v_state#>ARRAY['chunks',v_previous] THEN
    RAISE EXCEPTION 'Restore employee identities and credentials before dependent orders.';
  END IF;
  SELECT payload->'rows',row_count INTO v_rows,v_count FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_rows IS NULL OR jsonb_array_length(v_rows)<>v_count OR v_count>200 THEN RAISE EXCEPTION 'Employee identity staging changed.'; END IF;
  v_repeated:=p_chunk_no<v_next;
  IF NOT v_repeated THEN
    IF (v_state#>>ARRAY['counts',p_table_key])::integer+v_count>(v_state#>>ARRAY['totals',p_table_key])::integer THEN
      RAISE EXCEPTION 'Employee identity rows exceed the bound catalog.';
    END IF;
    PERFORM private.employee_transfer_allow_identity_write(v_job);
    IF p_table_key IN ('accounts','orders') THEN
      v_disabled:=private.employee_transfer_bypass_triggers(CASE WHEN p_table_key='accounts' THEN ARRAY['wallets'] ELSE ARRAY['orders'] END);
    END IF;
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
      PERFORM private.employee_transfer_check_identity_row(p_table_key,v_row);
      IF p_table_key='accounts' THEN
        INSERT INTO public.users(id,username,password_hash,employee_id,is_verified,is_active,total_income,first_success_order_date,
          created_by,remarks,created_at,updated_at,tags,is_pinned,current_session_token,session_created_at,last_heartbeat_at,current_tab_id)
          SELECT r.id,r.username,r.password_hash,r.employee_id,r.is_verified,false,r.total_income,r.first_success_order_date,
            (v_map->>r.created_by::text)::uuid,r.remarks,r.created_at,r.updated_at,r.tags,r.is_pinned,NULL,NULL,NULL,NULL
          FROM jsonb_populate_record(NULL::public.users,v_row) AS r;
      ELSIF p_table_key='credentials' THEN
        INSERT INTO public.financial_employee_credentials(user_id,password_hash,created_at,updated_at)
          VALUES((v_row->>'id')::uuid,v_row->>'password_hash',(v_row->>'created_at')::timestamptz,(v_row->>'updated_at')::timestamptz);
      ELSE
        INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status,
          commission_amount,commission_rate,created_at,processed_at,scheduled_process_at,assignment_id,
          dispatch_commission_rate_snapshot,dispatch_success_rate_snapshot)
          SELECT r.id,r.user_id,u.username,v_job.placeholder_product_id,0.01,'IMPORTED-'||r.id::text,'IMPORTED-'||r.id::text,r.status,
            r.commission_amount,r.commission_rate,r.created_at,r.processed_at,NULL,NULL,NULL,NULL
          FROM jsonb_populate_record(NULL::public.orders,v_row) AS r JOIN public.users AS u ON u.id=r.user_id;
        GET DIAGNOSTICS v_count=ROW_COUNT;
        IF v_count<>1 THEN RAISE EXCEPTION 'The order employee identity is missing.'; END IF;
      END IF;
    END LOOP;
    IF v_disabled IS NOT NULL THEN PERFORM private.employee_transfer_restore_triggers(v_disabled); END IF;
    PERFORM private.employee_transfer_clear_write_permit();
    v_count:=jsonb_array_length(v_rows);
    v_state:=jsonb_set(jsonb_set(v_state,ARRAY['counts',p_table_key],to_jsonb((v_state#>>ARRAY['counts',p_table_key])::integer+v_count)),
      ARRAY['next_chunks',p_table_key],to_jsonb(p_chunk_no+1));
  END IF;
  PERFORM private.employee_transfer_check_identity_written(v_job,p_table_key,v_rows,v_map);
  IF (v_state->>'verified')::boolean THEN PERFORM private.employee_transfer_verify_identity_contents(v_job,v_map); END IF;
  PERFORM private.employee_transfer_assert_identity_triggers();
  IF NOT v_repeated THEN
    UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('identity_restore',v_state) WHERE id=v_job.id;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','identity_restore_chunk',
      jsonb_build_object('table_key',p_table_key,'chunk_no',p_chunk_no,'rows',v_count,'full_site_complete',false));
  END IF;
  RETURN private.employee_transfer_identity_receipt(v_state,v_repeated);
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit(); RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_identity_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_map jsonb; v_state jsonb; v_key text; v_repeat boolean;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_identity_admin_map(v_job);
  v_state:=v_job.summary->'identity_restore';
  IF v_state IS NULL OR v_state->'admin_map' IS DISTINCT FROM v_map THEN RAISE EXCEPTION 'Begin a bound employee identity restore first.'; END IF;
  FOREACH v_key IN ARRAY ARRAY['accounts','credentials','orders'] LOOP
    IF v_state#>ARRAY['counts',v_key] IS DISTINCT FROM v_state#>ARRAY['totals',v_key]
      OR v_state#>ARRAY['next_chunks',v_key] IS DISTINCT FROM v_state#>ARRAY['chunks',v_key] THEN
      RAISE EXCEPTION 'Employee identity restore is incomplete.';
    END IF;
  END LOOP;
  PERFORM private.employee_transfer_verify_identity_contents(v_job,v_map);
  v_repeat:=(v_state->>'verified')::boolean;
  v_state:=v_state||'{"verified":true}'::jsonb;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('identity_restore',v_state) WHERE id=v_job.id;
  IF NOT v_repeat THEN PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','identity_restore_verified',
    jsonb_build_object('counts',v_state->'counts','package_id',v_job.options->'package_id','financial_data_pending',true,'full_site_complete',false)); END IF;
  RETURN private.employee_transfer_identity_receipt(v_state,v_repeat);
END;
$$;

CREATE FUNCTION private.employee_transfer_verified_identity_map(p_job private.employee_transfer_jobs,p_key text)
RETURNS TABLE(source_id uuid,target_id uuid) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;
BEGIN
  IF p_key NOT IN ('accounts','orders') OR p_key IS NULL THEN RAISE EXCEPTION 'Unsupported verified identity map.'; END IF;
  v_map:=private.employee_transfer_identity_admin_map(p_job);
  IF p_job.summary#>'{identity_restore,verified}' IS DISTINCT FROM 'true'::jsonb
    OR p_job.summary#>'{identity_restore,admin_map}' IS DISTINCT FROM v_map THEN RAISE EXCEPTION 'A matching server-verified employee identity receipt is required.'; END IF;
  PERFORM private.employee_transfer_verify_identity_contents(p_job,v_map);
  RETURN QUERY SELECT id,id FROM private.employee_transfer_identity_input(p_job.id,p_key);
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
  REVOKE ALL ON FUNCTION public.get_employee_import_identity_plan(uuid,uuid),public.employee_import_identity_begin(uuid,uuid,text),
    public.employee_import_identity_chunk(uuid,uuid,text,integer),public.employee_import_identity_verify(uuid,uuid) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.get_employee_import_identity_plan(uuid,uuid),public.employee_import_identity_begin(uuid,uuid,text),
    public.employee_import_identity_chunk(uuid,uuid,text,integer),public.employee_import_identity_verify(uuid,uuid) TO anon,authenticated;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
