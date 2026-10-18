SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_valid_catalog()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_result jsonb;
BEGIN
  EXECUTE 'SELECT jsonb_build_object(''key'',''valid_order_data'',''rows'',count(*),
    ''bytes'',COALESCE(sum(octet_length(body::text||E''\n'')),0),
    ''row_hashes_sha256'',encode(extensions.digest(convert_to(COALESCE(string_agg(
      encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id),''''),''UTF8''),''sha256''),''hex''))
    FROM ('||private.employee_transfer_dispatch_query('valid_order_data')||') AS r' INTO v_result;
  RETURN v_result;
END;
$$;

DO $install_valid_audit$
DECLARE v_expected jsonb; v_names jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname) ORDER BY c.relname,t.tgname) INTO v_names
    FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid
    WHERE c.oid IN ('public.valid_order_data'::regclass,'public.used_order_data'::regclass) AND NOT t.tgisinternal;
  IF v_names IS DISTINCT FROM '[
    ["used_order_data","trigger_update_valid_data_usage"],
    ["used_order_data","zz_employee_transfer_maintenance"],
    ["valid_order_data","mark_manual_valid_order_deactivation"],
    ["valid_order_data","zz_employee_transfer_maintenance"]]'::jsonb OR EXISTS(
    SELECT 1 FROM (VALUES
      ('used_order_data','trigger_update_valid_data_usage','beb800128146c743e33dda35751fd9fdd5841e4630d1c3de5cbb967b19635480',
        'CREATE TRIGGER trigger_update_valid_data_usage AFTER INSERT ON public.used_order_data FOR EACH ROW EXECUTE FUNCTION update_valid_data_usage_stats()'),
      ('valid_order_data','mark_manual_valid_order_deactivation','6b190fd9ef5e55a78415ec8a04ee37a301c2115cc14cf354594b7de5a14e7b6b',
        'CREATE TRIGGER mark_manual_valid_order_deactivation BEFORE UPDATE OF is_active ON public.valid_order_data FOR EACH ROW EXECUTE FUNCTION mark_manual_valid_order_deactivation()')
    ) AS expected(table_name,trigger_name,function_hash,definition)
    LEFT JOIN pg_class AS c ON c.relnamespace='public'::regnamespace AND c.relname=expected.table_name
    LEFT JOIN pg_trigger AS t ON t.tgrelid=c.oid AND t.tgname=expected.trigger_name
    LEFT JOIN pg_proc AS p ON p.oid=t.tgfoid
    WHERE t.oid IS NULL OR t.tgenabled NOT IN ('O','A') OR p.prosecdef OR pg_get_userbyid(p.proowner)<>'postgres'
      OR pg_get_triggerdef(t.oid) IS DISTINCT FROM expected.definition
      OR encode(extensions.digest(convert_to(pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') IS DISTINCT FROM expected.function_hash
  ) THEN RAISE EXCEPTION 'Unreviewed submission data triggers.'; END IF;
  SELECT jsonb_object_agg(c.relname||'.'||t.tgname,jsonb_build_object('mode',t.tgenabled::text,'digest',private.employee_transfer_trigger_digest(t.oid)))
    INTO v_expected FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid
    WHERE c.oid IN ('public.valid_order_data'::regclass,'public.used_order_data'::regclass) AND NOT t.tgisinternal;
  EXECUTE format($definition$
    CREATE FUNCTION private.employee_transfer_assert_valid_triggers()
    RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, private, pg_temp AS $body$
    DECLARE v_expected constant jsonb:=%L::jsonb; v_actual jsonb;
    BEGIN
      PERFORM private.employee_transfer_assert_maintenance_guards();
      SELECT jsonb_object_agg(c.relname||'.'||t.tgname,jsonb_build_object('mode',t.tgenabled::text,'digest',private.employee_transfer_trigger_digest(t.oid)))
        INTO v_actual FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid
        WHERE c.oid IN ('public.valid_order_data'::regclass,'public.used_order_data'::regclass) AND NOT t.tgisinternal;
      IF v_actual IS DISTINCT FROM v_expected THEN RAISE EXCEPTION 'Unreviewed submission data triggers.'; END IF;
    END;
    $body$;
  $definition$,v_expected::text);
END;
$install_valid_audit$;

CREATE FUNCTION private.employee_transfer_assert_valid_owner(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;
BEGIN
  PERFORM private.employee_transfer_dispatch_schema();
  PERFORM private.employee_transfer_assert_valid_triggers();
  IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance AS m
      JOIN private.employee_transfer_shared_backups AS b ON b.id=m.job_id AND b.sealed_at IS NOT NULL
        AND b.plan_hash=m.plan_hash AND b.target_hash=m.target_hash
      WHERE m.job_id=p_job.id AND m.admin_id=p_job.admin_id AND m.dirty
        AND m.plan_hash=p_job.summary->>'dispatch_plan_hash')
    OR p_job.summary->'dispatch_configuration_applied' IS DISTINCT FROM 'true'::jsonb
    OR p_job.summary#>'{dispatch_configuration_receipt,configuration_applied}' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Verified configuration restore and sealed owner maintenance are required.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.used_order_data) THEN
    RAISE EXCEPTION 'Target used submission records require employee/order dependency verification first.';
  END IF;
  v_map:=private.employee_transfer_dispatch_admin_map(p_job);
  IF EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'valid_order_data') AS v
      LEFT JOIN public.admins AS a ON a.id=(v_map->>(v.body->>'created_by'))::uuid
      WHERE a.id IS NULL) THEN
    RAISE EXCEPTION 'A server-verified submission administrator mapping is required.';
  END IF;
  RETURN v_map;
END;
$$;

CREATE FUNCTION private.employee_transfer_allow_valid_write(p_job_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_jobs AS j
    JOIN private.employee_transfer_maintenance AS m ON m.job_id=j.id AND m.admin_id=j.admin_id
      AND m.plan_hash=j.summary->>'dispatch_plan_hash' AND m.dirty
    WHERE j.id=p_job_id AND j.kind='import' AND j.status='running'
      AND j.options->>'import_protocol'='dispatch-submission-v1'
      AND j.summary->'dispatch_configuration_applied'='true'::jsonb
      AND j.last_activity_at>now()-interval '3 hours' AND j.started_at>now()-interval '12 hours')
    OR EXISTS(SELECT 1 FROM public.used_order_data) THEN
    RAISE EXCEPTION 'A running submission restore owner with no target used records is required.';
  END IF;
  -- The empty used table receives a zero-row DELETE from its ON DELETE CASCADE foreign key.
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names)
    VALUES(pg_current_xact_id(),p_job_id,ARRAY['public.valid_order_data','public.used_order_data']);
END;
$$;

CREATE FUNCTION private.employee_transfer_valid_receipt(p_state jsonb,p_repeated boolean)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object('success',true,'scope','dispatch-valid-data','rows',p_state->'rows',
    'total_rows',p_state->'total_rows','next_chunk',p_state->'next_chunk','chunks',p_state->'chunks',
    'verified',p_state->'verified','repeated',p_repeated,'maintenance',true,'dependencies_pending',true,
    'replacement_ready',false,'full_site_complete',false);
$$;

CREATE FUNCTION public.employee_import_dispatch_valid_begin(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_map jsonb; v_expected jsonb; v_state jsonb; v_chunks integer; v_rows jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_assert_valid_owner(v_job);
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_job.summary#>>'{dispatch_config_plan,plan_hash}' THEN
    RAISE EXCEPTION 'The submission restore configuration confirmation does not match.';
  END IF;
  v_state:=v_job.summary->'valid_restore';
  IF v_state IS NOT NULL THEN
    IF v_state->'admin_map' IS DISTINCT FROM v_map THEN RAISE EXCEPTION 'Submission administrator mapping changed.'; END IF;
    IF (SELECT count(*) FROM public.valid_order_data)<>(v_state->>'rows')::integer THEN
      RAISE EXCEPTION 'Submission committed progress changed.';
    END IF;
    IF (v_state->>'verified')::boolean THEN
      PERFORM private.employee_transfer_dispatch_check_input(v_job);
      FOR v_rows IN SELECT payload->'rows' FROM private.employee_transfer_staging WHERE job_id=v_job.id
        AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:valid_order_data' ORDER BY chunk_no LOOP
        PERFORM private.employee_transfer_check_valid_rows(v_rows,v_map);
      END LOOP;
    END IF;
    RETURN private.employee_transfer_valid_receipt(v_state,true);
  END IF;
  PERFORM private.employee_transfer_dispatch_check_input(v_job);
  SELECT value INTO v_expected FROM private.employee_transfer_shared_backups AS b
    CROSS JOIN LATERAL jsonb_array_elements(b.catalog->'tables') WHERE b.id=v_job.id AND value->>'key'='valid_order_data';
  IF v_expected IS NULL OR private.employee_transfer_valid_catalog() IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'Submission target changed after its independent backup.';
  END IF;
  SELECT count(*)::integer INTO v_chunks FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:valid_order_data';
  v_state:=jsonb_build_object('rows',0,'total_rows',v_job.options#>'{catalog,tables,5,rows}',
    'next_chunk',0,'chunks',v_chunks,'verified',false,'admin_map',v_map);
  PERFORM private.employee_transfer_allow_valid_write(v_job.id);
  DELETE FROM public.valid_order_data;
  PERFORM private.employee_transfer_clear_write_permit();
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('valid_restore',v_state) WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','valid_restore_started',
    jsonb_build_object('total_rows',v_state->'total_rows','full_site_complete',false));
  RETURN private.employee_transfer_valid_receipt(v_state,false);
EXCEPTION WHEN OTHERS THEN
  PERFORM private.employee_transfer_clear_write_permit();
  RAISE;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_valid_rows(p_rows jsonb,p_map jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_bad boolean;
BEGIN
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM jsonb_array_elements($1) AS src(body)
    LEFT JOIN ('||private.employee_transfer_dispatch_query('valid_order_data')||') AS actual
      ON actual.id=(src.body->>''id'')::uuid AND actual.body=src.body||jsonb_build_object(''created_by'',$2->(src.body->>''created_by''))
    WHERE actual.id IS NULL)' INTO v_bad USING p_rows,p_map;
  IF v_bad THEN RAISE EXCEPTION 'Submission post-write verification failed.'; END IF;
END;
$$;

CREATE FUNCTION public.employee_import_dispatch_valid_chunk(p_admin_session_token uuid,p_job_token uuid,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_map jsonb; v_state jsonb; v_rows jsonb; v_row jsonb;
  v_count integer; v_repeated boolean;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_assert_valid_owner(v_job);
  v_state:=v_job.summary->'valid_restore';
  IF v_state IS NULL OR v_state->'admin_map' IS DISTINCT FROM v_map THEN RAISE EXCEPTION 'Begin a bound submission restore first.'; END IF;
  IF p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>=(v_state->>'chunks')::integer
    OR p_chunk_no>(v_state->>'next_chunk')::integer THEN RAISE EXCEPTION 'Submission chunks must follow the confirmed cursor.'; END IF;
  SELECT payload->'rows',row_count INTO v_rows,v_count FROM private.employee_transfer_staging
    WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000'
      AND table_key='dispatch-in:valid_order_data' AND chunk_no=p_chunk_no;
  IF v_rows IS NULL OR jsonb_array_length(v_rows)<>v_count OR v_count>200
    OR (SELECT count(*) FROM public.valid_order_data)<>(v_state->>'rows')::integer THEN
    RAISE EXCEPTION 'Submission staging or committed progress changed.';
  END IF;
  v_repeated:=p_chunk_no<(v_state->>'next_chunk')::integer;
  IF NOT v_repeated THEN
    IF (v_state->>'rows')::integer+v_count>(v_state->>'total_rows')::integer THEN RAISE EXCEPTION 'Submission rows exceed the bound catalog.'; END IF;
    PERFORM private.employee_transfer_allow_valid_write(v_job.id);
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_rows) LOOP
      PERFORM private.employee_transfer_check_dispatch_row('valid_order_data',v_row);
      INSERT INTO public.valid_order_data(id,product_value,transaction_id,is_active,created_by,created_at,updated_at,
        usage_count,last_used_at,deactivated_at,deactivation_reason,priority,tags)
        SELECT r.id,r.product_value,r.transaction_id,r.is_active,(v_map->>r.created_by::text)::uuid,r.created_at,r.updated_at,
          r.usage_count,r.last_used_at,r.deactivated_at,r.deactivation_reason,r.priority,r.tags
        FROM jsonb_populate_record(NULL::public.valid_order_data,v_row) AS r;
    END LOOP;
    PERFORM private.employee_transfer_clear_write_permit();
    v_state:=v_state||jsonb_build_object('rows',(v_state->>'rows')::integer+v_count,'next_chunk',p_chunk_no+1);
  END IF;
  PERFORM private.employee_transfer_check_valid_rows(v_rows,v_map);
  IF (v_state->>'verified')::boolean THEN
    PERFORM private.employee_transfer_dispatch_check_input(v_job);
    FOR v_rows IN SELECT payload->'rows' FROM private.employee_transfer_staging WHERE job_id=v_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:valid_order_data' ORDER BY chunk_no LOOP
      PERFORM private.employee_transfer_check_valid_rows(v_rows,v_map);
    END LOOP;
  END IF;
  IF NOT v_repeated THEN
    UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('valid_restore',v_state) WHERE id=v_job.id;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','valid_restore_chunk',
      jsonb_build_object('chunk_no',p_chunk_no,'rows',v_count,'full_site_complete',false));
  END IF;
  RETURN private.employee_transfer_valid_receipt(v_state,v_repeated);
EXCEPTION WHEN OTHERS THEN
  PERFORM private.employee_transfer_clear_write_permit();
  RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_dispatch_valid_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_map jsonb; v_state jsonb; v_rows jsonb; v_repeat boolean;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_assert_valid_owner(v_job);
  v_state:=v_job.summary->'valid_restore';
  IF v_state IS NULL OR v_state->'admin_map' IS DISTINCT FROM v_map
    OR v_state->'rows' IS DISTINCT FROM v_state->'total_rows' OR v_state->'next_chunk' IS DISTINCT FROM v_state->'chunks' THEN
    RAISE EXCEPTION 'Submission restore is incomplete or its mapping changed.';
  END IF;
  PERFORM private.employee_transfer_dispatch_check_input(v_job);
  IF (SELECT count(*) FROM public.valid_order_data)<>(v_state->>'total_rows')::integer THEN
    RAISE EXCEPTION 'Submission target count changed.';
  END IF;
  FOR v_rows IN SELECT payload->'rows' FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:valid_order_data' ORDER BY chunk_no LOOP
    PERFORM private.employee_transfer_check_valid_rows(v_rows,v_map);
  END LOOP;
  v_repeat:=(v_state->>'verified')::boolean;
  v_state:=v_state||'{"verified":true}'::jsonb;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('valid_restore',v_state) WHERE id=v_job.id;
  IF NOT v_repeat THEN
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','valid_restore_verified',
      jsonb_build_object('rows',v_state->'rows','employee_order_dependencies_pending',true,'full_site_complete',false));
  END IF;
  RETURN private.employee_transfer_valid_receipt(v_state,v_repeat);
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',v_function);
  END LOOP;
  REVOKE ALL ON FUNCTION public.employee_import_dispatch_valid_begin(uuid,uuid,text),public.employee_import_dispatch_valid_chunk(uuid,uuid,integer),public.employee_import_dispatch_valid_verify(uuid,uuid) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.employee_import_dispatch_valid_begin(uuid,uuid,text),public.employee_import_dispatch_valid_chunk(uuid,uuid,integer),public.employee_import_dispatch_valid_verify(uuid,uuid) TO anon,authenticated;
END;
$$;
NOTIFY pgrst,'reload schema';
