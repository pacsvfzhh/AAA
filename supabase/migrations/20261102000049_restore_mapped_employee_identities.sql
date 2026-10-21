BEGIN;

CREATE FUNCTION private.employee_transfer_mapped_identity_source(p_job private.employee_transfer_jobs,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_status jsonb;v_key text;v_chunk record;v_line text;v_json json;v_rows jsonb;v_hashes text;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['credentials','orders'] LOOP
    FOR v_chunk IN SELECT row_count,payload FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:'||v_key ORDER BY chunk_no LOOP
      v_rows:='[]';v_hashes:='';
      IF jsonb_typeof(v_chunk.payload->'ndjson') IS DISTINCT FROM 'string'
        OR octet_length(v_chunk.payload->>'ndjson')>262144 THEN RAISE EXCEPTION 'Mapped identity source changed.';END IF;
      IF v_chunk.payload->>'ndjson'<>'' THEN
        IF right(v_chunk.payload->>'ndjson',1)<>E'\n' THEN RAISE EXCEPTION 'Mapped identity source changed.';END IF;
        FOR v_line IN SELECT line FROM unnest(string_to_array(left(v_chunk.payload->>'ndjson',length(v_chunk.payload->>'ndjson')-1),E'\n')) AS input(line) LOOP
          v_json:=v_line::json;
          IF NOT private.employee_transfer_unique_json(v_json) THEN RAISE EXCEPTION 'Mapped identity source changed.';END IF;
          PERFORM private.employee_transfer_check_identity_row(v_key,v_json::jsonb);
          v_rows:=v_rows||jsonb_build_array(v_json::jsonb);
          v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
        END LOOP;
      END IF;
      IF v_rows IS DISTINCT FROM v_chunk.payload->'rows' OR v_hashes IS DISTINCT FROM v_chunk.payload->>'row_hashes'
        OR jsonb_array_length(v_rows) IS DISTINCT FROM v_chunk.row_count
        OR octet_length(v_chunk.payload->>'ndjson') IS DISTINCT FROM (v_chunk.payload->>'bytes')::integer THEN
        RAISE EXCEPTION 'Mapped identity source changed.';
      END IF;
    END LOOP;
  END LOOP;
  v_status:=private.employee_transfer_identity_reservation_status(p_job,p_source_id);
  IF v_status->'reservation'='null'::jsonb THEN RAISE EXCEPTION 'A server identity candidate must be reserved first.';END IF;
  RETURN v_status;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_identity_saved(p_job private.employee_transfer_jobs,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_stage record;v_count bigint;
BEGIN
  SELECT count(*) INTO v_count FROM private.employee_transfer_staging
    WHERE job_id=p_job.id AND employee_id=p_source_id AND table_key='mapped-identity-v1';
  IF v_count=0 THEN RETURN NULL;END IF;
  IF v_count<>1 THEN RAISE EXCEPTION 'Mapped identity state changed.';END IF;
  SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging
    WHERE job_id=p_job.id AND employee_id=p_source_id AND table_key='mapped-identity-v1';
  IF v_stage.chunk_no<>0 OR v_stage.row_count<>1 OR NOT private.employee_transfer_exact_object(v_stage.payload,
    ARRAY['plan','admin_map','placeholder_product_id','counts','next_chunk','verified']) THEN
    RAISE EXCEPTION 'Mapped identity state changed.';
  END IF;
  RETURN v_stage.payload;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_identity_check_written(
  p_job private.employee_transfer_jobs,p_source_id uuid,p_state jsonb
) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_status jsonb;v_map jsonb;v_row jsonb;v_rows jsonb;v_plan jsonb;v_target uuid;v_local private.employee_transfer_jobs%ROWTYPE;
  v_count bigint;v_expected bigint;v_chunks bigint;v_next integer;v_chunk record;v_username text;v_number text;
BEGIN
  IF p_state IS NULL THEN RAISE EXCEPTION 'Begin a mapped identity core restore first.';END IF;
  v_status:=private.employee_transfer_mapped_identity_source(p_job,p_source_id);
  v_map:=private.employee_transfer_identity_admin_map(p_job);
  v_plan:=p_state->'plan';v_target:=(v_plan->>'target_id')::uuid;v_next:=(p_state->>'next_chunk')::integer;
  IF v_status->'source_unchanged' IS DISTINCT FROM 'true'::jsonb
    OR p_state->'admin_map' IS DISTINCT FROM v_map
    OR v_plan->'binding_hash' IS DISTINCT FROM v_status#>'{reservation,binding_hash}'
    OR v_plan->'source_id' IS DISTINCT FROM to_jsonb(p_source_id)
    OR v_plan->'target_id' IS DISTINCT FROM v_status#>'{reservation,target_id}'
    OR v_plan->'job_id' IS DISTINCT FROM to_jsonb(p_job.id)
    OR v_plan->'can_begin' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Mapped identity source or binding changed.';
  END IF;
  SELECT count(*) INTO v_chunks FROM private.employee_transfer_staging WHERE job_id=p_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:orders';
  IF v_next IS NULL OR v_next<0 OR v_next>v_chunks OR v_chunks IS DISTINCT FROM (v_plan->>'order_chunks')::bigint
    OR jsonb_typeof(p_state->'verified') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Mapped identity cursor changed.';END IF;
  SELECT body INTO STRICT v_row FROM private.employee_transfer_identity_input(p_job.id,'accounts') WHERE id=p_source_id;
  v_username:=v_row->>'username';v_number:=v_row->>'employee_id';
  PERFORM private.employee_transfer_check_identity_written(p_job,'accounts',jsonb_build_array(v_row||jsonb_build_object('id',v_target)),v_map);
  IF EXISTS(SELECT 1 FROM public.users WHERE id=p_source_id OR (username=v_username AND id<>v_target)
      OR (employee_id=v_number AND id<>v_target))
    OR EXISTS(SELECT 1 FROM public.admins WHERE id=v_target OR username=v_username)
    OR EXISTS(SELECT 1 FROM private.deleted_employee_accounts WHERE cleared_at IS NULL
      AND (account_username=v_username OR employee_id=v_target)) THEN RAISE EXCEPTION 'Mapped identity ownership changed.';END IF;
  SELECT body INTO v_row FROM private.employee_transfer_identity_input(p_job.id,'credentials') WHERE id=p_source_id;
  IF v_row IS NOT NULL THEN
    PERFORM private.employee_transfer_check_identity_written(p_job,'credentials',jsonb_build_array(v_row||jsonb_build_object('id',v_target)),v_map);
  END IF;
  SELECT count(*) INTO v_count FROM public.financial_employee_credentials WHERE user_id=v_target;
  IF v_count IS DISTINCT FROM CASE WHEN v_row IS NULL THEN 0::bigint ELSE 1::bigint END
    OR p_state#>'{counts,accounts}' IS DISTINCT FROM '1'::jsonb
    OR (p_state#>>'{counts,credentials}')::bigint IS DISTINCT FROM v_count
    OR (v_plan#>>'{totals,credentials}')::bigint IS DISTINCT FROM v_count THEN
    RAISE EXCEPTION 'Mapped identity credentials changed.';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.wallets WHERE user_id=v_target AND available_balance=0 AND frozen_balance=0)
    OR EXISTS(SELECT 1 FROM public.wallet_balance_baselines WHERE user_id=v_target)
    OR EXISTS(SELECT 1 FROM public.wallet_ledger_entries WHERE user_id=v_target) THEN
    RAISE EXCEPTION 'Mapped identity pending financial state changed.';
  END IF;
  v_local:=p_job;v_local.placeholder_product_id:=(p_state->>'placeholder_product_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.product_types WHERE id=v_local.placeholder_product_id
    AND name='舊站匯入（精簡訂單）' AND is_active=false) THEN RAISE EXCEPTION 'Mapped identity placeholder changed.';END IF;
  v_expected:=0;
  FOR v_chunk IN SELECT payload FROM private.employee_transfer_staging WHERE job_id=p_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:orders' AND chunk_no<v_next ORDER BY chunk_no LOOP
    SELECT COALESCE(jsonb_agg(body||jsonb_build_object('user_id',v_target)),'[]') INTO v_rows
      FROM jsonb_array_elements(v_chunk.payload->'rows') AS source(body) WHERE body->>'user_id'=p_source_id::text;
    v_expected:=v_expected+jsonb_array_length(v_rows);
    PERFORM private.employee_transfer_check_identity_written(v_local,'orders',v_rows,v_map);
  END LOOP;
  SELECT count(*) INTO v_count FROM public.orders WHERE user_id=v_target;
  IF v_count IS DISTINCT FROM v_expected OR (p_state#>>'{counts,orders}')::bigint IS DISTINCT FROM v_expected
    OR ((p_state->>'verified')::boolean AND (v_next<>v_chunks OR p_state->'counts' IS DISTINCT FROM v_plan->'totals')) THEN
    RAISE EXCEPTION 'Mapped identity committed orders changed.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_identity_plan(p_job private.employee_transfer_jobs,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_status jsonb;v_saved jsonb;v_binding jsonb;v_map jsonb;v_source jsonb;v_target uuid;
  v_conflicts jsonb:='[]';v_totals jsonb;v_chunks bigint;v_plan jsonb;
BEGIN
  v_status:=private.employee_transfer_mapped_identity_source(p_job,p_source_id);
  v_saved:=private.employee_transfer_mapped_identity_saved(p_job,p_source_id);
  IF v_saved IS NOT NULL THEN
    PERFORM private.employee_transfer_mapped_identity_check_written(p_job,p_source_id,v_saved);
    RETURN v_saved->'plan';
  END IF;
  v_binding:=v_status->'reservation';v_target:=(v_binding->>'target_id')::uuid;
  v_map:=private.employee_transfer_identity_admin_map(p_job);
  SELECT body INTO STRICT v_source FROM private.employee_transfer_identity_input(p_job.id,'accounts') WHERE id=p_source_id;
  IF v_status->'source_unchanged' IS DISTINCT FROM 'true'::jsonb OR v_status->'target_unchanged' IS DISTINCT FROM 'true'::jsonb THEN
    v_conflicts:=v_conflicts||'"reservation_drift"'::jsonb;END IF;
  IF v_status->'candidate_available' IS DISTINCT FROM 'true'::jsonb THEN v_conflicts:=v_conflicts||'"candidate_occupied"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM public.users WHERE id=p_source_id) THEN v_conflicts:=v_conflicts||'"source_uuid_occupied"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM public.users WHERE username=v_source->>'username') THEN v_conflicts:=v_conflicts||'"username_requires_archive"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM public.users WHERE employee_id=v_source->>'employee_id') THEN v_conflicts:=v_conflicts||'"employee_number_conflict"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM public.admins WHERE username=v_source->>'username') THEN v_conflicts:=v_conflicts||'"administrator_username_conflict"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.deleted_employee_accounts WHERE account_username=v_source->>'username' AND cleared_at IS NULL) THEN
    v_conflicts:=v_conflicts||'"archive_history_requires_backup"'::jsonb;END IF;
  IF (v_source->>'created_by' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.admins WHERE id=(v_map->>(v_source->>'created_by'))::uuid))
    OR (v_source->>'created_by' IS NULL AND ((SELECT attnotnull FROM pg_attribute WHERE attrelid='public.users'::regclass AND attname='created_by')
      OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.users'::regclass AND conname='users_created_by_required' AND contype='c'))) THEN
    v_conflicts:=v_conflicts||'"unmapped_administrator"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'orders') AS s JOIN public.orders AS o ON o.id=s.id
    WHERE s.body->>'user_id'=p_source_id::text) THEN v_conflicts:=v_conflicts||'"order_id_conflict"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM public.product_types WHERE name='舊站匯入（精簡訂單）' AND is_active IS DISTINCT FROM false) THEN
    v_conflicts:=v_conflicts||'"placeholder_product_active"'::jsonb;END IF;
  SELECT jsonb_build_object('accounts',1,'credentials',(SELECT count(*) FROM private.employee_transfer_identity_input(p_job.id,'credentials') WHERE id=p_source_id),
    'orders',(SELECT count(*) FROM private.employee_transfer_identity_input(p_job.id,'orders') WHERE body->>'user_id'=p_source_id::text)) INTO v_totals;
  SELECT count(*) INTO v_chunks FROM private.employee_transfer_staging WHERE job_id=p_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='identity-in:orders';
  v_plan:=(v_binding-ARRAY['version','target_fingerprint'])||jsonb_build_object('scope','employee-mapped-identity',
    'can_begin',jsonb_array_length(v_conflicts)=0,'conflicts',v_conflicts,'totals',v_totals,'order_chunks',v_chunks,
    'maintenance',true,'dependencies_pending',true,'can_restore',false,'complete_employee_backup',false,
    'can_archive',false,'can_replace',false,'full_site_complete',false);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(
    jsonb_build_object('plan',v_plan,'admin_map',v_map,'observed_source',v_status#>'{observed,source_fingerprint}')::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_identity_receipt(p_state jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT (p_state->'plan'-ARRAY['can_begin','conflicts'])||jsonb_build_object(
    'counts',p_state->'counts','next_chunk',p_state->'next_chunk','verified',p_state->'verified');
$$;

CREATE FUNCTION public.employee_import_mapped_identity_plan(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  RETURN private.employee_transfer_mapped_identity_plan(v_job,p_source_id);
END;
$$;

CREATE FUNCTION public.employee_import_mapped_identity_status(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_state jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_state:=private.employee_transfer_mapped_identity_saved(v_job,p_source_id);
  PERFORM private.employee_transfer_mapped_identity_check_written(v_job,p_source_id,v_state);
  RETURN private.employee_transfer_mapped_identity_receipt(v_state);
END;
$$;

CREATE FUNCTION public.employee_import_mapped_identity_core(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_plan jsonb;v_state jsonb;v_map jsonb;v_row jsonb;
  v_target uuid;v_product uuid;v_disabled jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_plan:=private.employee_transfer_mapped_identity_plan(v_job,p_source_id);
  IF p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$' OR p_plan_hash IS DISTINCT FROM v_plan->>'plan_hash'
    OR v_plan->'can_begin' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Mapped identity plan changed or has conflicts.';END IF;
  v_state:=private.employee_transfer_mapped_identity_saved(v_job,p_source_id);
  IF v_state IS NOT NULL THEN RETURN private.employee_transfer_mapped_identity_receipt(v_state);END IF;
  v_map:=private.employee_transfer_identity_admin_map(v_job);v_target:=(v_plan->>'target_id')::uuid;
  PERFORM private.employee_transfer_allow_identity_write(v_job);
  SELECT id INTO v_product FROM public.product_types WHERE name='舊站匯入（精簡訂單）';
  IF v_product IS NULL THEN INSERT INTO public.product_types(name,is_active) VALUES('舊站匯入（精簡訂單）',false) RETURNING id INTO v_product;END IF;
  v_disabled:=private.employee_transfer_bypass_triggers(ARRAY['wallets']);
  SELECT body INTO STRICT v_row FROM private.employee_transfer_identity_input(v_job.id,'accounts') WHERE id=p_source_id;
  INSERT INTO public.users(id,username,password_hash,employee_id,is_verified,is_active,total_income,first_success_order_date,
    created_by,remarks,created_at,updated_at,tags,is_pinned,current_session_token,session_created_at,last_heartbeat_at,current_tab_id)
    SELECT v_target,r.username,r.password_hash,r.employee_id,r.is_verified,false,r.total_income,r.first_success_order_date,
      (v_map->>r.created_by::text)::uuid,r.remarks,r.created_at,r.updated_at,r.tags,r.is_pinned,NULL,NULL,NULL,NULL
    FROM jsonb_populate_record(NULL::public.users,v_row) AS r;
  SELECT body INTO v_row FROM private.employee_transfer_identity_input(v_job.id,'credentials') WHERE id=p_source_id;
  IF v_row IS NOT NULL THEN
    INSERT INTO public.financial_employee_credentials(user_id,password_hash,created_at,updated_at)
      VALUES(v_target,v_row->>'password_hash',(v_row->>'created_at')::timestamptz,(v_row->>'updated_at')::timestamptz);
  END IF;
  PERFORM private.employee_transfer_restore_triggers(v_disabled);
  PERFORM private.employee_transfer_clear_write_permit();
  v_state:=jsonb_build_object('plan',v_plan,'admin_map',v_map,'placeholder_product_id',v_product,
    'counts',jsonb_build_object('accounts',1,'credentials',v_plan#>'{totals,credentials}','orders',0),'next_chunk',0,'verified',false);
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,p_source_id,'mapped-identity-v1',0,1,v_state);
  PERFORM private.employee_transfer_mapped_identity_check_written(v_job,p_source_id,v_state);
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_identity_core',
    jsonb_build_object('source_id',p_source_id,'target_id',v_target,'binding_hash',v_plan->'binding_hash','full_site_complete',false));
  RETURN private.employee_transfer_mapped_identity_receipt(v_state);
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit();RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_mapped_identity_orders(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_state jsonb;v_rows jsonb;v_target uuid;v_next integer;v_count integer;v_disabled jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_state:=private.employee_transfer_mapped_identity_saved(v_job,p_source_id);
  PERFORM private.employee_transfer_mapped_identity_check_written(v_job,p_source_id,v_state);
  v_target:=(v_state#>>'{plan,target_id}')::uuid;v_next:=(v_state->>'next_chunk')::integer;
  IF p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>v_next OR p_chunk_no>=(v_state#>>'{plan,order_chunks}')::integer THEN
    RAISE EXCEPTION 'Mapped identity order chunks must follow the committed cursor.';END IF;
  IF p_chunk_no<v_next THEN RETURN private.employee_transfer_mapped_identity_receipt(v_state);END IF;
  SELECT COALESCE(jsonb_agg(body),'[]') INTO v_rows FROM private.employee_transfer_staging AS s
    CROSS JOIN LATERAL jsonb_array_elements(s.payload->'rows') AS source(body)
    WHERE s.job_id=v_job.id AND s.employee_id='00000000-0000-0000-0000-000000000000'
      AND s.table_key='identity-in:orders' AND s.chunk_no=p_chunk_no AND body->>'user_id'=p_source_id::text;
  PERFORM private.employee_transfer_allow_identity_write(v_job);
  v_disabled:=private.employee_transfer_bypass_triggers(ARRAY['orders']);
  INSERT INTO public.orders(id,user_id,username,product_type_id,product_value,order_number,transaction_id,status,
    commission_amount,commission_rate,created_at,processed_at,scheduled_process_at,assignment_id,
    dispatch_commission_rate_snapshot,dispatch_success_rate_snapshot)
    SELECT r.id,v_target,u.username,(v_state->>'placeholder_product_id')::uuid,0.01,'IMPORTED-'||r.id::text,'IMPORTED-'||r.id::text,r.status,
      r.commission_amount,r.commission_rate,r.created_at,r.processed_at,NULL,NULL,NULL,NULL
    FROM jsonb_array_elements(v_rows) AS source(body)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::public.orders,source.body) AS r JOIN public.users AS u ON u.id=v_target;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>jsonb_array_length(v_rows) THEN RAISE EXCEPTION 'Mapped order employee is missing.';END IF;
  PERFORM private.employee_transfer_restore_triggers(v_disabled);
  PERFORM private.employee_transfer_clear_write_permit();
  v_state:=jsonb_set(jsonb_set(v_state,'{counts,orders}',to_jsonb((v_state#>>'{counts,orders}')::integer+v_count)),'{next_chunk}',to_jsonb(p_chunk_no+1));
  PERFORM private.employee_transfer_mapped_identity_check_written(v_job,p_source_id,v_state);
  UPDATE private.employee_transfer_staging SET payload=v_state WHERE job_id=v_job.id AND employee_id=p_source_id AND table_key='mapped-identity-v1' AND chunk_no=0;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_identity_orders',
    jsonb_build_object('source_id',p_source_id,'chunk_no',p_chunk_no,'rows',v_count,'full_site_complete',false));
  RETURN private.employee_transfer_mapped_identity_receipt(v_state);
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit();RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_mapped_identity_verify(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_state jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_state:=private.employee_transfer_mapped_identity_saved(v_job,p_source_id);
  PERFORM private.employee_transfer_mapped_identity_check_written(v_job,p_source_id,v_state);
  IF v_state->'next_chunk' IS DISTINCT FROM v_state#>'{plan,order_chunks}' OR v_state->'counts' IS DISTINCT FROM v_state#>'{plan,totals}' THEN
    RAISE EXCEPTION 'Mapped identity orders are incomplete.';END IF;
  IF v_state->'verified' IS DISTINCT FROM 'true'::jsonb THEN
    v_state:=v_state||'{"verified":true}'::jsonb;
    UPDATE private.employee_transfer_staging SET payload=v_state WHERE job_id=v_job.id AND employee_id=p_source_id AND table_key='mapped-identity-v1' AND chunk_no=0;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_identity_verified',
      jsonb_build_object('source_id',p_source_id,'target_id',v_state#>'{plan,target_id}','full_site_complete',false));
  END IF;
  RETURN private.employee_transfer_mapped_identity_receipt(v_state);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_mapped_identity_source(private.employee_transfer_jobs,uuid),
  private.employee_transfer_mapped_identity_saved(private.employee_transfer_jobs,uuid),
  private.employee_transfer_mapped_identity_check_written(private.employee_transfer_jobs,uuid,jsonb),
  private.employee_transfer_mapped_identity_plan(private.employee_transfer_jobs,uuid),
  private.employee_transfer_mapped_identity_receipt(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.employee_import_mapped_identity_plan(uuid,uuid,uuid),
  public.employee_import_mapped_identity_status(uuid,uuid,uuid),public.employee_import_mapped_identity_core(uuid,uuid,uuid,text),
  public.employee_import_mapped_identity_orders(uuid,uuid,uuid,integer),public.employee_import_mapped_identity_verify(uuid,uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_import_mapped_identity_plan(uuid,uuid,uuid),
  public.employee_import_mapped_identity_status(uuid,uuid,uuid),public.employee_import_mapped_identity_core(uuid,uuid,uuid,text),
  public.employee_import_mapped_identity_orders(uuid,uuid,uuid,integer),public.employee_import_mapped_identity_verify(uuid,uuid,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
