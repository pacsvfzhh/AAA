BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- Finance moves only the zero-state check to a phase guard; identity and dispatch checks stay intact.
CREATE FUNCTION private.employee_transfer_mapped_finance_identity_guard(
  p_job private.employee_transfer_jobs,p_source_id uuid,p_state jsonb
) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_status jsonb;v_map jsonb;v_row jsonb;v_rows jsonb;v_plan jsonb;v_target uuid;v_local private.employee_transfer_jobs%ROWTYPE;
  v_count bigint;v_expected bigint;v_chunks bigint;v_next integer;v_chunk record;v_username text;v_number text;
BEGIN
  IF p_state IS NULL THEN RAISE EXCEPTION 'Begin a mapped identity core restore first.';END IF;
  v_status:=private.employee_transfer_mapped_identity_source(p_job,p_source_id);
  v_map:=private.employee_transfer_identity_admin_map(p_job);
  v_plan:=p_state->'plan';v_target:=(v_plan->>'target_id')::uuid;v_next:=(p_state->>'next_chunk')::integer;
  IF NOT private.employee_transfer_exact_object(v_plan,ARRAY['scope','job_id','site_id','source_site_id','package_id',
      'source_id','target_id','source_fingerprint','binding_hash','plan_hash','can_begin','conflicts','totals','order_chunks',
      'maintenance','dependencies_pending','can_restore','complete_employee_backup','can_archive','can_replace','full_site_complete'])
    OR NOT private.employee_transfer_exact_object(p_state->'counts',ARRAY['accounts','credentials','orders'])
    OR v_plan->'scope' IS DISTINCT FROM '"employee-mapped-identity"'::jsonb
    OR v_plan->'conflicts' IS DISTINCT FROM '[]'::jsonb
    OR v_plan->'maintenance' IS DISTINCT FROM 'true'::jsonb OR v_plan->'dependencies_pending' IS DISTINCT FROM 'true'::jsonb
    OR v_plan->'can_restore' IS DISTINCT FROM 'false'::jsonb OR v_plan->'complete_employee_backup' IS DISTINCT FROM 'false'::jsonb
    OR v_plan->'can_archive' IS DISTINCT FROM 'false'::jsonb OR v_plan->'can_replace' IS DISTINCT FROM 'false'::jsonb
    OR v_plan->'full_site_complete' IS DISTINCT FROM 'false'::jsonb
    OR v_plan->'site_id' IS DISTINCT FROM v_status->'site_id'
    OR v_plan->'source_site_id' IS DISTINCT FROM v_status->'source_site_id'
    OR v_plan->'package_id' IS DISTINCT FROM v_status->'package_id'
    OR v_plan->'source_fingerprint' IS DISTINCT FROM v_status#>'{reservation,source_fingerprint}'
    OR v_plan->'plan_hash' IS DISTINCT FROM to_jsonb(encode(extensions.digest(convert_to(jsonb_build_object(
      'plan',v_plan-'plan_hash','admin_map',v_map,'observed_source',v_status#>'{observed,source_fingerprint}')::text,'UTF8'),'sha256'),'hex'))
    OR v_status->'source_unchanged' IS DISTINCT FROM 'true'::jsonb
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
  IF v_count IS DISTINCT FROM (CASE WHEN v_row IS NULL THEN 0::bigint ELSE 1::bigint END)
    OR p_state#>'{counts,accounts}' IS DISTINCT FROM '1'::jsonb
    OR (p_state#>>'{counts,credentials}')::bigint IS DISTINCT FROM v_count
    OR (v_plan#>>'{totals,credentials}')::bigint IS DISTINCT FROM v_count THEN
    RAISE EXCEPTION 'Mapped identity credentials changed.';
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

CREATE FUNCTION private.employee_transfer_mapped_finance_map(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_source record;v_state jsonb;v_target uuid;v_map jsonb:='{}';v_plans jsonb:='[]';v_site uuid;v_key text;
BEGIN
  IF p_job.summary ?| ARRAY['identity_restore','dependency_restore'] THEN
    RAISE EXCEPTION 'Legacy identity or dependency restore cannot be mixed with mapped dependencies.';
  END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging AS s
    LEFT JOIN private.employee_transfer_identity_input(p_job.id,'accounts') AS a ON a.id=s.employee_id
    WHERE s.job_id=p_job.id AND s.table_key='mapped-identity-v1' AND (a.id IS NULL OR s.chunk_no<>0 OR s.row_count<>1))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-identity-v1'
      GROUP BY employee_id HAVING count(*)<>1) THEN
    RAISE EXCEPTION 'Mapped dependency identity state set changed.';
  END IF;
  SELECT site_id INTO STRICT v_site FROM private.employee_transfer_site;
  FOR v_source IN SELECT * FROM private.employee_transfer_identity_input(p_job.id,'accounts') ORDER BY id LOOP
    v_state:=private.employee_transfer_mapped_identity_saved(p_job,v_source.id);
    IF v_state IS NULL OR v_state->'verified' IS DISTINCT FROM 'true'::jsonb
      OR jsonb_typeof(v_state->'next_chunk') IS DISTINCT FROM 'number'
      OR (v_state->>'next_chunk') !~ '^(0|[1-9][0-9]{0,5})$'
      OR v_state->'next_chunk' IS DISTINCT FROM v_state#>'{plan,order_chunks}'
      OR v_state->'counts' IS DISTINCT FROM v_state#>'{plan,totals}' THEN
      RAISE EXCEPTION 'Every source employee requires a fully verified mapped identity restore.';
    END IF;
    IF NOT private.employee_transfer_exact_object(v_state->'counts',ARRAY['accounts','credentials','orders']) THEN
      RAISE EXCEPTION 'Mapped dependency identity counts changed.';
    END IF;
    FOREACH v_key IN ARRAY ARRAY['accounts','credentials','orders'] LOOP
      IF jsonb_typeof(v_state#>ARRAY['counts',v_key]) IS DISTINCT FROM 'number'
        OR (v_state#>>ARRAY['counts',v_key]) !~ '^(0|[1-9][0-9]{0,5})$' THEN
        RAISE EXCEPTION 'Mapped dependency identity counts changed.';
      END IF;
    END LOOP;
    IF jsonb_typeof(v_state#>'{plan,target_id}') IS DISTINCT FROM 'string'
      OR (v_state#>>'{plan,target_id}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'Mapped dependency employee candidate changed.';
    END IF;
    PERFORM private.employee_transfer_mapped_finance_identity_guard(p_job,v_source.id,v_state);
    v_target:=(v_state#>>'{plan,target_id}')::uuid;
    IF v_map ? v_source.id::text OR v_target=v_source.id OR v_target='00000000-0000-0000-0000-000000000000'
      OR EXISTS(SELECT 1 FROM jsonb_each_text(v_map) WHERE value=v_target::text)
      OR EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') WHERE id=v_target) THEN
      RAISE EXCEPTION 'Mapped dependency employee mapping is not one-to-one.';
    END IF;
    v_map:=v_map||jsonb_build_object(v_source.id::text,v_target);
    v_plans:=v_plans||jsonb_build_array(v_state->'plan');
  END LOOP;
  RETURN jsonb_build_object('identity_map',v_map,'mapping_hash',encode(extensions.digest(convert_to(jsonb_build_object(
    'job_id',p_job.id,'site_id',v_site,'source_site_id',p_job.summary#>'{identity_catalog,site_id}',
    'package_id',p_job.options->'package_id','identity_catalog',p_job.summary->'identity_catalog',
    'identity_map',v_map,'identity_plans',v_plans)::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_owner(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_admin jsonb;v_identity jsonb;v_chunks jsonb;v_key text;v_row record;v_body jsonb;v_bad boolean;
  v_rows jsonb;v_config jsonb:=p_job.summary->'dispatch_config_plan';v_valid jsonb:=p_job.summary->'valid_restore';v_n bigint;
BEGIN
  IF p_job.summary ?| ARRAY['identity_restore','dependency_restore'] THEN
    RAISE EXCEPTION 'Legacy identity or dependency restore cannot be mixed with mapped dependencies.';
  END IF;
  v_admin:=private.employee_transfer_identity_admin_map(p_job);
  PERFORM private.employee_transfer_dispatch_schema();
  PERFORM private.employee_transfer_assert_dispatch_config_triggers();
  PERFORM private.employee_transfer_assert_valid_triggers();
  v_chunks:=private.employee_transfer_mapped_dependency_source(p_job);
  IF jsonb_typeof(v_admin) IS DISTINCT FROM 'object'
    OR NOT private.employee_transfer_exact_object(v_config,ARRAY['scope','can_apply_configuration','full_site_complete',
      'replacement_ready','conflicts','group_map','pool_map','admin_map','package_id','catalog','preparation_plan_hash','plan_hash'])
    OR v_config->'scope' IS DISTINCT FROM '"dispatch-configuration"'::jsonb
    OR v_config->'can_apply_configuration' IS DISTINCT FROM 'true'::jsonb OR v_config->'conflicts' IS DISTINCT FROM '[]'::jsonb
    OR v_config->'full_site_complete' IS DISTINCT FROM 'false'::jsonb OR v_config->'replacement_ready' IS DISTINCT FROM 'false'::jsonb
    OR v_config->'package_id' IS DISTINCT FROM p_job.options->'package_id'
    OR v_config->'catalog' IS DISTINCT FROM p_job.options->'catalog'
    OR v_config->'preparation_plan_hash' IS DISTINCT FROM p_job.summary->'dispatch_plan_hash'
    OR v_config->'plan_hash' IS DISTINCT FROM to_jsonb(encode(extensions.digest(convert_to((v_config-'plan_hash')::text,'UTF8'),'sha256'),'hex'))
    OR v_config->'admin_map' IS DISTINCT FROM v_admin
    OR p_job.group_map IS DISTINCT FROM v_config->'group_map'
    OR p_job.group_map IS DISTINCT FROM p_job.summary#>'{dispatch_configuration_receipt,group_map}'
    OR v_config->'pool_map' IS DISTINCT FROM p_job.summary#>'{dispatch_configuration_receipt,pool_map}'
    OR NOT private.employee_transfer_exact_object(v_valid,ARRAY['rows','total_rows','next_chunk','chunks','verified','admin_map'])
    OR v_valid->'verified' IS DISTINCT FROM 'true'::jsonb OR v_valid->'admin_map' IS DISTINCT FROM v_admin
    OR v_valid->'rows' IS DISTINCT FROM p_job.options#>'{catalog,tables,5,rows}'
    OR v_valid->'total_rows' IS DISTINCT FROM v_valid->'rows' THEN
    RAISE EXCEPTION 'Verified same-package configuration and valid submission data are required.';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_each(v_admin) WHERE jsonb_typeof(value)<>'string'
      OR (value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    OR NOT private.employee_transfer_exact_object(p_job.group_map,
      ARRAY(SELECT id::text FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups')))
    OR NOT private.employee_transfer_exact_object(v_config->'pool_map',
      ARRAY(SELECT id::text FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_order_pools'))) THEN
    RAISE EXCEPTION 'Mapped dependency configuration maps changed.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['group_map','pool_map'] LOOP
    IF EXISTS(SELECT 1 FROM jsonb_each(v_config->v_key) WHERE jsonb_typeof(value)<>'string'
        OR (value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR EXISTS(SELECT 1 FROM jsonb_each_text(v_config->v_key) GROUP BY value HAVING count(*)>1) THEN
      RAISE EXCEPTION 'Mapped dependency configuration map is not one-to-one.';
    END IF;
  END LOOP;
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:valid_order_data';
  IF v_valid->'chunks' IS DISTINCT FROM to_jsonb(v_n) OR v_valid->'next_chunk' IS DISTINCT FROM to_jsonb(v_n) THEN
    RAISE EXCEPTION 'Mapped dependency valid submission cursor changed.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders'] LOOP
    FOR v_row IN SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,v_key) LOOP
      v_body:=v_row.body;
      IF v_key='dispatch_groups' THEN v_body:=v_body||jsonb_build_object('id',p_job.group_map->v_row.id::text);
      ELSIF v_key='dispatch_order_pools' THEN v_body:=v_body||jsonb_build_object('id',v_config#>ARRAY['pool_map',v_row.id::text],
        'group_id',p_job.group_map->(v_body->>'group_id'));
      ELSIF v_key='dispatch_group_orders' THEN v_body:=v_body||jsonb_build_object('group_id',p_job.group_map->(v_body->>'group_id'),
        'pool_id',v_config#>ARRAY['pool_map',v_body->>'pool_id']);
      END IF;
      IF v_key<>'dispatch_config' THEN v_body:=v_body||jsonb_build_object('created_by',v_admin->(v_body->>'created_by'));END IF;
      EXECUTE 'SELECT NOT EXISTS(SELECT 1 FROM ('||private.employee_transfer_dispatch_query(v_key)||') AS actual WHERE id=$1 AND body=$2)'
        INTO v_bad USING (v_body->>'id')::uuid,v_body;
      IF v_bad THEN RAISE EXCEPTION 'Mapped dependency dispatch configuration contents changed.';END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.dispatch_groups WHERE (is_default OR is_active OR archived_at IS NULL)
      AND id::text NOT IN(SELECT value FROM jsonb_each_text(p_job.group_map)))
    OR EXISTS(SELECT 1 FROM public.dispatch_order_pools WHERE is_active AND archived_at IS NULL
      AND id::text NOT IN(SELECT value FROM jsonb_each_text(v_config->'pool_map')))
    OR (SELECT count(*) FROM public.dispatch_config)<>(p_job.options#>>'{catalog,tables,0,rows}')::bigint
    OR (SELECT count(*) FROM public.dispatch_group_orders)<>(p_job.options#>>'{catalog,tables,3,rows}')::bigint
    OR (SELECT count(*) FROM public.valid_order_data)<>(p_job.options#>>'{catalog,tables,5,rows}')::bigint THEN
    RAISE EXCEPTION 'Mapped dependency configuration or valid submission counts/residuals changed.';
  END IF;
  FOR v_rows IN SELECT payload->'rows' FROM private.employee_transfer_staging WHERE job_id=p_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:valid_order_data' ORDER BY chunk_no LOOP
    PERFORM private.employee_transfer_check_valid_rows(v_rows,v_admin);
  END LOOP;
  v_identity:=private.employee_transfer_mapped_finance_map(p_job);
  IF EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_group_members') AS m
      WHERE NOT ((v_identity->'identity_map') ? (m.body->>'user_id')))
    OR EXISTS(WITH orders AS MATERIALIZED(SELECT * FROM private.employee_transfer_identity_input(p_job.id,'orders'))
      SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'used_order_data') AS u
      LEFT JOIN orders AS o ON o.id=(u.body->>'order_id')::uuid AND o.body->>'user_id'=u.body->>'user_id'
      LEFT JOIN public.orders AS actual ON actual.id=o.id
        AND actual.user_id=(v_identity#>>ARRAY['identity_map',u.body->>'user_id'])::uuid AND actual.status IN ('success','failure')
      LEFT JOIN public.valid_order_data AS valid ON valid.id=(u.body->>'valid_order_data_id')::uuid
      WHERE o.id IS NULL OR actual.id IS NULL OR valid.id IS NULL
        OR NOT ((v_identity->'identity_map') ? (u.body->>'user_id'))) THEN
    RAISE EXCEPTION 'Mapped dependency source employee/order references are incomplete.';
  END IF;
  RETURN v_identity||jsonb_build_object('admin_map',v_admin,'group_map',p_job.group_map,'chunks',v_chunks);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_input(p_job_id uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
BEGIN
  PERFORM private.employee_transfer_finance_cursor_type(p_key);
  RETURN QUERY SELECT r.value->>'id',r.value FROM private.employee_transfer_staging AS s
    CROSS JOIN LATERAL jsonb_array_elements(s.payload->'rows') AS r(value)
    WHERE s.job_id=p_job_id AND s.employee_id='00000000-0000-0000-0000-000000000000'
      AND s.table_key='mapped-finance-in:'||p_key;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_catalog(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_n bigint;v_stage record;
BEGIN
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-finance-catalog-v1';
  IF v_n=0 THEN RETURN NULL;END IF;
  IF v_n<>1 THEN RAISE EXCEPTION 'Mapped finance catalog state changed.';END IF;
  SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-finance-catalog-v1';
  IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>0 OR v_stage.row_count<>1 THEN
    RAISE EXCEPTION 'Mapped finance catalog namespace changed.';
  END IF;
  PERFORM private.employee_transfer_check_finance_catalog(v_stage.payload);
  IF v_stage.payload->'identity_catalog' IS DISTINCT FROM p_job.summary->'identity_catalog'
    OR v_stage.payload->'site_id' IS DISTINCT FROM p_job.options#>'{catalog,site_id}'
    OR v_stage.payload->'package_id' IS DISTINCT FROM p_job.options->'package_id' THEN
    RAISE EXCEPTION 'Mapped finance source binding changed.';
  END IF;
  RETURN v_stage.payload;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_parse(p_key text,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_line text;v_json json;v_rows jsonb:='[]';v_hashes text:='';v_last text;v_bad boolean;v_type text;
BEGIN
  v_type:=private.employee_transfer_finance_cursor_type(p_key);
  IF p_ndjson IS NULL OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN
    RAISE EXCEPTION 'Invalid mapped finance chunk.';
  END IF;
  IF p_ndjson<>'' THEN
    FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) AS r(line) LOOP
      IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Mapped finance row exceeds limits.';END IF;
      v_json:=v_line::json;
      IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN
        RAISE EXCEPTION 'Invalid mapped finance JSON.';
      END IF;
      PERFORM private.employee_transfer_check_finance_row(p_key,v_json::jsonb);
      EXECUTE 'SELECT $1::'||v_type||'>=$2::'||v_type INTO v_bad USING v_last,v_json->>'id';
      IF COALESCE(v_bad,false) THEN RAISE EXCEPTION 'Mapped finance row order changed.';END IF;
      v_last:=v_json->>'id';v_rows:=v_rows||jsonb_build_array(v_json::jsonb);
      IF jsonb_array_length(v_rows)>200 THEN RAISE EXCEPTION 'Mapped finance chunk exceeds limits.';END IF;
      v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_last);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_source(p_job private.employee_transfer_jobs,p_complete boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_catalog jsonb;v_table jsonb;v_key text;v_stage record;v_payload jsonb;v_chunks integer;v_rows bigint;v_bytes bigint;
  v_hashes text;v_last text;v_first text;v_bad boolean;v_type text;v_total bigint:=0;v_counts jsonb:='{}';
BEGIN
  v_catalog:=private.employee_transfer_mapped_finance_catalog(p_job);
  IF v_catalog IS NULL THEN RAISE EXCEPTION 'Bind a mapped finance catalog first.';END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(v_catalog->'tables') LOOP
    v_key:=v_table->>'key';v_type:=private.employee_transfer_finance_cursor_type(v_key);
    v_chunks:=0;v_rows:=0;v_bytes:=0;v_hashes:='';v_last:=NULL;
    FOR v_stage IN SELECT * FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND table_key='mapped-finance-in:'||v_key ORDER BY chunk_no LOOP
      IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>v_chunks
        OR v_stage.row_count NOT BETWEEN 0 AND 200 OR NOT private.employee_transfer_exact_object(v_stage.payload,
          ARRAY['ndjson','rows','bytes','row_hashes','last_id']) OR jsonb_typeof(v_stage.payload->'ndjson') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_stage.payload->'bytes') IS DISTINCT FROM 'number'
        OR (v_stage.payload->>'bytes') !~ '^(0|[1-9][0-9]{0,5})$' THEN
        RAISE EXCEPTION 'Mapped finance source namespace changed.';
      END IF;
      v_payload:=private.employee_transfer_mapped_finance_parse(v_key,v_stage.payload->>'ndjson');
      IF v_payload IS DISTINCT FROM v_stage.payload OR jsonb_array_length(v_payload->'rows')<>v_stage.row_count
        OR (v_stage.row_count=0 AND (v_chunks<>0 OR v_table->'rows' IS DISTINCT FROM '0'::jsonb)) THEN
        RAISE EXCEPTION 'Mapped finance source raw rows or hashes changed.';
      END IF;
      v_first:=v_payload#>>'{rows,0,id}';
      EXECUTE 'SELECT $1::'||v_type||'>=$2::'||v_type INTO v_bad USING v_last,v_first;
      IF COALESCE(v_bad,false) THEN RAISE EXCEPTION 'Mapped finance source chunk order changed.';END IF;
      v_last:=v_payload->>'last_id';v_chunks:=v_chunks+1;v_rows:=v_rows+v_stage.row_count;
      v_bytes:=v_bytes+(v_payload->>'bytes')::bigint;v_hashes:=v_hashes||(v_payload->>'row_hashes');
    END LOOP;
    v_total:=v_total+v_bytes;
    IF v_rows>(v_table->>'rows')::bigint OR v_bytes>(v_table->>'bytes')::bigint OR v_rows>500000 OR v_bytes>268435456
      OR v_total>1073741824 OR (v_rows=0 AND v_chunks>1) THEN RAISE EXCEPTION 'Mapped finance source exceeds catalog.';END IF;
    IF p_complete AND (v_chunks=0 OR v_rows<>(v_table->>'rows')::bigint OR v_bytes<>(v_table->>'bytes')::bigint
      OR encode(extensions.digest(convert_to(v_hashes,'UTF8'),'sha256'),'hex') IS DISTINCT FROM v_table->>'row_hashes_sha256') THEN
      RAISE EXCEPTION 'Mapped finance source directory is incomplete or changed.';
    END IF;
    v_counts:=v_counts||jsonb_build_object(v_key,v_rows);
  END LOOP;
  RETURN v_counts;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_source_issues(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_issues jsonb:='[]';v_key text;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit'] LOOP
    IF EXISTS(WITH accounts AS MATERIALIZED(SELECT id FROM private.employee_transfer_identity_input(p_job.id,'accounts'))
      SELECT 1 FROM private.employee_transfer_mapped_finance_input(p_job.id,v_key) AS f LEFT JOIN accounts AS a ON a.id=(f.body->>'user_id')::uuid WHERE a.id IS NULL) THEN
      RETURN '["source_employee_missing"]'::jsonb;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_identity_input(p_job.id,'accounts') AS a
    LEFT JOIN private.employee_transfer_mapped_finance_input(p_job.id,'wallets') AS w ON w.id=a.id::text WHERE w.id IS NULL) THEN
    v_issues:=v_issues||'"source_employee_missing"'::jsonb;
  END IF;
  IF EXISTS(WITH accounts AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_identity_input(p_job.id,'accounts')),
    wallets AS MATERIALIZED(SELECT body FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallets')),
    baselines AS MATERIALIZED(SELECT body FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_balance_baselines')),
    ledger AS MATERIALIZED(SELECT body FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_ledger_entries')),
    pending AS (SELECT body->>'user_id' AS owner,sum((body->>'amount')::numeric) AS amount FROM private.employee_transfer_mapped_finance_input(p_job.id,'withdrawals') WHERE body->>'status'='pending' GROUP BY body->>'user_id')
    SELECT 1 FROM accounts AS a JOIN wallets AS w ON w.body->>'user_id'=a.id::text LEFT JOIN baselines AS b ON b.body->>'user_id'=a.id::text
      LEFT JOIN pending AS p ON p.owner=a.id::text LEFT JOIN LATERAL(
        SELECT COALESCE(sum((body->>'available_delta')::numeric+(body->>'frozen_delta')::numeric),0) AS total,
          COALESCE(sum((body->>'income_delta')::numeric),0) AS income FROM ledger WHERE body->>'user_id'=a.id::text AND (body->>'id')::bigint>(b.body->>'last_ledger_id')::bigint
      ) AS d ON true
    WHERE w.body->>'available_balance' IS NULL OR w.body->>'frozen_balance' IS NULL
      OR (w.body->>'frozen_balance')::numeric IS DISTINCT FROM COALESCE(p.amount,0)
      OR (b.body IS NOT NULL AND ((w.body->>'available_balance')::numeric+(w.body->>'frozen_balance')::numeric IS DISTINCT FROM
        (b.body->>'available_balance')::numeric+(b.body->>'frozen_balance')::numeric+d.total
        OR COALESCE((a.body->>'total_income')::numeric,0) IS DISTINCT FROM (b.body->>'total_income')::numeric+d.income))) THEN
    v_issues:=v_issues||'"inconsistent_source_finance"'::jsonb;
  END IF;
  RETURN v_issues;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_check_counts(p_counts jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_value jsonb;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_counts,ARRAY['wallets','wallet_balance_baselines','wallet_ledger_entries',
    'wallet_transactions','withdrawals','wallet_reconciliation_audit']) THEN RAISE EXCEPTION 'Mapped finance count keys changed.';END IF;
  FOR v_value IN SELECT value FROM jsonb_each(p_counts) LOOP
    IF jsonb_typeof(v_value) IS DISTINCT FROM 'number' OR (v_value#>>'{}') !~ '^(0|[1-9][0-9]{0,5})$'
      OR (v_value#>>'{}')::bigint>500000 THEN RAISE EXCEPTION 'Mapped finance count type changed.';END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_saved(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_n bigint;v_stage record;
BEGIN
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-finance-v1';
  IF v_n=0 THEN RETURN NULL;END IF;
  IF v_n<>1 THEN RAISE EXCEPTION 'Mapped finance state set changed.';END IF;
  SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-finance-v1';
  IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>0 OR v_stage.row_count<>1
    OR NOT private.employee_transfer_exact_object(v_stage.payload,ARRAY['plan','identity_map','admin_map','completed_employees','verified'])
    OR jsonb_typeof(v_stage.payload->'completed_employees') IS DISTINCT FROM 'number'
    OR (v_stage.payload->>'completed_employees') !~ '^(0|[1-9][0-9]{0,5})$'
    OR jsonb_typeof(v_stage.payload->'verified') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Mapped finance saved state changed.';
  END IF;
  IF NOT private.employee_transfer_exact_object(v_stage.payload->'plan',ARRAY['scope','job_id','site_id','source_site_id','package_id',
    'catalog_hash','mapping_hash','plan_hash','totals','employees','pending_withdrawals','maintenance','dependencies_pending',
    'financial_data_pending','can_restore','complete_employee_backup','can_archive','can_replace','full_site_complete','can_begin','conflicts'])
    OR jsonb_typeof(v_stage.payload#>'{plan,employees}') IS DISTINCT FROM 'number'
    OR (v_stage.payload#>>'{plan,employees}') !~ '^(0|[1-9][0-9]{0,5})$'
    OR NOT private.employee_transfer_exact_object(v_stage.payload#>'{plan,pending_withdrawals}',ARRAY['count','amount'])
    OR jsonb_typeof(v_stage.payload#>'{plan,pending_withdrawals,count}') IS DISTINCT FROM 'number'
    OR (v_stage.payload#>>'{plan,pending_withdrawals,count}') !~ '^(0|[1-9][0-9]{0,5})$'
    OR jsonb_typeof(v_stage.payload#>'{plan,pending_withdrawals,amount}') IS DISTINCT FROM 'string'
    OR (v_stage.payload#>>'{plan,pending_withdrawals,amount}') !~ '^(0|[1-9][0-9]*)([.][0-9]+)?$' THEN
    RAISE EXCEPTION 'Mapped finance plan fields changed.';
  END IF;
  PERFORM private.employee_transfer_mapped_finance_check_counts(v_stage.payload#>'{plan,totals}');
  RETURN v_stage.payload;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_empty(p_target uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_bad boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.wallets WHERE user_id=p_target AND available_balance=0 AND frozen_balance=0) THEN RETURN false;END IF;
  FOREACH v_key IN ARRAY ARRAY['wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE user_id=$1)',v_key) INTO v_bad USING p_target;
    IF v_bad THEN RETURN false;END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_expected(
  p_job private.employee_transfer_jobs,p_source uuid,p_target uuid,p_key text,p_admin jsonb
) RETURNS TABLE(id text,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
BEGIN
  PERFORM private.employee_transfer_finance_cursor_type(p_key);
  RETURN QUERY WITH mappings AS MATERIALIZED(
    SELECT r.value->>'old_id' AS old_id,r.value->>'new_id' AS new_id FROM private.employee_transfer_staging AS s
      CROSS JOIN LATERAL jsonb_array_elements(s.payload) AS r(value) WHERE s.job_id=p_job.id AND s.employee_id=p_source
        AND s.table_key='mapped-finance-map:'||CASE p_key WHEN 'wallet_ledger_entries' THEN 'ledger' WHEN 'wallet_reconciliation_audit' THEN 'audit' ELSE '' END
  ), cursor_map AS (
    SELECT COALESCE((SELECT r.value->>'new_id' FROM private.employee_transfer_staging AS s
      CROSS JOIN LATERAL jsonb_array_elements(s.payload) AS r(value)
      WHERE s.job_id=p_job.id AND s.employee_id=p_source AND s.table_key='mapped-finance-map:ledger'
        AND (r.value->>'old_id')::bigint<=(SELECT (b.body->>'last_ledger_id')::bigint
          FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_balance_baselines') AS b WHERE b.id=p_source::text)
      ORDER BY (r.value->>'old_id')::bigint DESC LIMIT 1),'0') AS cursor
  ) SELECT CASE WHEN p_key IN ('wallets','wallet_balance_baselines') THEN p_target::text
      WHEN p_key IN ('wallet_ledger_entries','wallet_reconciliation_audit') THEN m.new_id ELSE f.id END,
    f.body||jsonb_build_object('user_id',p_target)||CASE p_key
      WHEN 'wallets' THEN jsonb_build_object('id',p_target)
      WHEN 'wallet_balance_baselines' THEN jsonb_build_object('id',p_target,'last_ledger_id',(SELECT cursor FROM cursor_map))
      WHEN 'wallet_ledger_entries' THEN jsonb_build_object('id',m.new_id)
      WHEN 'wallet_reconciliation_audit' THEN jsonb_build_object('id',m.new_id)
      WHEN 'wallet_transactions' THEN jsonb_build_object('created_by',p_admin->(f.body->>'created_by'))
      WHEN 'withdrawals' THEN jsonb_build_object('audited_by',p_admin->(f.body->>'audited_by')) ELSE '{}'::jsonb END
    FROM private.employee_transfer_mapped_finance_input(p_job.id,p_key) AS f LEFT JOIN mappings AS m ON m.old_id=f.id
    WHERE f.body->>'user_id'=p_source::text;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_check_written(
  p_job private.employee_transfer_jobs,p_source uuid,p_target uuid,p_admin jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_alias text;v_stage record;v_pair jsonb;v_old bigint;v_new bigint;v_last_old bigint;v_last_new bigint;
  v_n bigint;v_chunks integer;v_expected bigint;v_actual bigint;v_bad boolean;v_counts jsonb:='{}';v_wallet public.wallets%ROWTYPE;
  v_baseline public.wallet_balance_baselines%ROWTYPE;v_pending numeric;v_total numeric;v_income numeric;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['wallet_ledger_entries','wallet_reconciliation_audit'] LOOP
    v_alias:=CASE v_key WHEN 'wallet_ledger_entries' THEN 'ledger' ELSE 'audit' END;
    v_last_old:=0;v_last_new:=0;v_n:=0;v_chunks:=0;
    FOR v_stage IN SELECT * FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id=p_source
      AND table_key='mapped-finance-map:'||v_alias ORDER BY chunk_no LOOP
      IF v_stage.chunk_no<>v_chunks OR v_stage.row_count NOT BETWEEN 1 AND 200 OR jsonb_typeof(v_stage.payload) IS DISTINCT FROM 'array'
        OR jsonb_array_length(v_stage.payload)<>v_stage.row_count THEN RAISE EXCEPTION 'Mapped finance row mapping changed.';END IF;
      FOR v_pair IN SELECT value FROM jsonb_array_elements(v_stage.payload) LOOP
        IF NOT private.employee_transfer_exact_object(v_pair,ARRAY['old_id','new_id'])
          OR jsonb_typeof(v_pair->'old_id') IS DISTINCT FROM 'string' OR jsonb_typeof(v_pair->'new_id') IS DISTINCT FROM 'string'
          OR (v_pair->>'old_id') !~ '^[1-9][0-9]{0,18}$' OR (v_pair->>'new_id') !~ '^[1-9][0-9]{0,18}$'
          OR (v_pair->>'old_id')::numeric>9223372036854775807 OR (v_pair->>'new_id')::numeric>9223372036854775807 THEN
          RAISE EXCEPTION 'Mapped finance row mapping type changed.';
        END IF;
        v_old:=(v_pair->>'old_id')::bigint;v_new:=(v_pair->>'new_id')::bigint;
        IF v_old<=v_last_old OR v_new<=v_last_new THEN
          RAISE EXCEPTION 'Mapped finance row mapping order or source changed.';
        END IF;
        v_last_old:=v_old;v_last_new:=v_new;v_n:=v_n+1;
      END LOOP;
      v_chunks:=v_chunks+1;
    END LOOP;
    SELECT count(*) INTO v_expected FROM private.employee_transfer_mapped_finance_input(p_job.id,v_key) WHERE body->>'user_id'=p_source::text;
    IF v_n<>v_expected OR EXISTS(WITH source AS MATERIALIZED(
      SELECT id FROM private.employee_transfer_mapped_finance_input(p_job.id,v_key) WHERE body->>'user_id'=p_source::text
    ) SELECT 1 FROM private.employee_transfer_staging AS s CROSS JOIN LATERAL jsonb_array_elements(s.payload) AS r(value)
      LEFT JOIN source ON source.id=r.value->>'old_id' WHERE s.job_id=p_job.id AND s.employee_id=p_source
        AND s.table_key='mapped-finance-map:'||v_alias AND source.id IS NULL) THEN
      RAISE EXCEPTION 'Mapped finance row mapping is incomplete or differs from the source.';
    END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit'] LOOP
    SELECT count(*) INTO v_expected FROM private.employee_transfer_mapped_finance_input(p_job.id,v_key) WHERE body->>'user_id'=p_source::text;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE user_id=$1',v_key) INTO v_actual USING p_target;
    IF v_actual<>v_expected THEN RAISE EXCEPTION 'Mapped finance committed count changed.';END IF;
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM private.employee_transfer_mapped_finance_expected($1,$2,$3,$4,$5) AS e LEFT JOIN ('||
      private.employee_transfer_finance_query(v_key)||') AS a ON a.id::text=e.id AND a.body=e.body WHERE a.id IS NULL)'
      INTO v_bad USING p_job,p_source,p_target,v_key,p_admin;
    IF v_bad THEN RAISE EXCEPTION 'Mapped finance committed contents changed.';END IF;
    v_counts:=v_counts||jsonb_build_object(v_key,v_actual);
  END LOOP;
  SELECT * INTO STRICT v_wallet FROM public.wallets WHERE user_id=p_target;
  SELECT * INTO v_baseline FROM public.wallet_balance_baselines WHERE user_id=p_target;
  SELECT COALESCE(sum(amount),0) INTO v_pending FROM public.withdrawals WHERE user_id=p_target AND status='pending';
  IF v_wallet.available_balance IS NULL OR v_wallet.frozen_balance IS DISTINCT FROM v_pending THEN
    RAISE EXCEPTION 'Mapped finance frozen balance and pending withdrawals differ.';
  END IF;
  IF v_baseline.user_id IS NOT NULL THEN
    SELECT v_baseline.available_balance+v_baseline.frozen_balance+COALESCE(sum(available_delta+frozen_delta),0),
      v_baseline.total_income+COALESCE(sum(income_delta),0) INTO v_total,v_income FROM public.wallet_ledger_entries
      WHERE user_id=p_target AND id>v_baseline.last_ledger_id;
    IF v_total IS DISTINCT FROM v_wallet.available_balance+v_wallet.frozen_balance
      OR v_income IS DISTINCT FROM (SELECT COALESCE(total_income,0) FROM public.users WHERE id=p_target) THEN
      RAISE EXCEPTION 'Mapped finance wallet ledger reconciliation failed.';
    END IF;
  END IF;
  RETURN v_counts;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_phase(
  p_job private.employee_transfer_jobs,p_owner jsonb,p_state jsonb
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_pair record;v_done record;v_n bigint;v_count bigint:=0;v_counts jsonb;v_empty boolean:=true;
BEGIN
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging AS s WHERE s.job_id=p_job.id AND s.table_key='mapped-finance-done-v1'
      AND (NOT ((p_owner->'identity_map') ? s.employee_id::text) OR s.chunk_no<>0 OR s.row_count<>1))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-finance-done-v1'
      GROUP BY employee_id HAVING count(*)<>1) THEN RAISE EXCEPTION 'Mapped finance completion set changed.';END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging AS s WHERE s.job_id=p_job.id AND s.table_key IN ('mapped-finance-map:ledger','mapped-finance-map:audit')
    AND NOT EXISTS(SELECT 1 FROM private.employee_transfer_staging AS d WHERE d.job_id=p_job.id
      AND d.employee_id=s.employee_id AND d.table_key='mapped-finance-done-v1')) THEN
    RAISE EXCEPTION 'Mapped finance orphan row mapping changed.';
  END IF;
  FOR v_pair IN SELECT key::uuid AS source,value::uuid AS target FROM jsonb_each_text(p_owner->'identity_map') ORDER BY key COLLATE "C" LOOP
    SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id=v_pair.source AND table_key='mapped-finance-done-v1';
    IF v_n=0 THEN
      v_empty:=private.employee_transfer_mapped_finance_empty(v_pair.target) AND v_empty;
    ELSE
      IF p_state IS NULL THEN RAISE EXCEPTION 'Mapped finance completion lacks a started plan.';END IF;
      SELECT * INTO STRICT v_done FROM private.employee_transfer_staging WHERE job_id=p_job.id
        AND employee_id=v_pair.source AND table_key='mapped-finance-done-v1';
      IF NOT private.employee_transfer_exact_object(v_done.payload,ARRAY['source_id','target_id','plan_hash','counts'])
        OR v_done.payload->'source_id' IS DISTINCT FROM to_jsonb(v_pair.source)
        OR v_done.payload->'target_id' IS DISTINCT FROM to_jsonb(v_pair.target)
        OR v_done.payload->'plan_hash' IS DISTINCT FROM p_state#>'{plan,plan_hash}' THEN
        RAISE EXCEPTION 'Mapped finance completion binding changed.';
      END IF;
      PERFORM private.employee_transfer_mapped_finance_check_counts(v_done.payload->'counts');
      v_counts:=private.employee_transfer_mapped_finance_check_written(p_job,v_pair.source,v_pair.target,p_owner->'admin_map');
      IF v_done.payload->'counts' IS DISTINCT FROM v_counts THEN RAISE EXCEPTION 'Mapped finance completion counts changed.';END IF;
      v_count:=v_count+1;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging AS s CROSS JOIN LATERAL jsonb_array_elements(s.payload) AS r(value)
    WHERE s.job_id=p_job.id AND s.table_key IN ('mapped-finance-map:ledger','mapped-finance-map:audit')
    GROUP BY s.table_key,r.value->>'new_id' HAVING count(*)>1) THEN RAISE EXCEPTION 'Mapped finance row mappings are not unique.';END IF;
  RETURN jsonb_build_object('completed_employees',v_count,'target_empty',v_empty);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_conflicts(p_job private.employee_transfer_jobs,p_owner jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_issues jsonb;
BEGIN
  v_issues:=private.employee_transfer_mapped_finance_source_issues(p_job);
  IF p_owner->'target_empty' IS DISTINCT FROM 'true'::jsonb THEN v_issues:=v_issues||'"financial_target_not_empty"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_transactions') AS s JOIN public.wallet_transactions AS t ON t.id=s.id::uuid
      WHERE NOT EXISTS(SELECT 1 FROM private.employee_transfer_staging AS d WHERE d.job_id=p_job.id
        AND d.employee_id=(s.body->>'user_id')::uuid AND d.table_key='mapped-finance-done-v1')
        OR t.user_id IS DISTINCT FROM (p_owner#>>ARRAY['identity_map',s.body->>'user_id'])::uuid)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_finance_input(p_job.id,'withdrawals') AS s JOIN public.withdrawals AS t ON t.id=s.id::uuid
      WHERE NOT EXISTS(SELECT 1 FROM private.employee_transfer_staging AS d WHERE d.job_id=p_job.id
        AND d.employee_id=(s.body->>'user_id')::uuid AND d.table_key='mapped-finance-done-v1')
        OR t.user_id IS DISTINCT FROM (p_owner#>>ARRAY['identity_map',s.body->>'user_id'])::uuid) THEN
    v_issues:=v_issues||'"financial_uuid_collision"'::jsonb;
  END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_transactions') AS s JOIN public.wallet_transactions AS t
      ON ((s.body->>'operation_id')::uuid=t.operation_id AND s.body->>'type'=t.type)
        OR (s.body->>'type'=t.type AND t.type IN ('tip','performance_bonus') AND (s.body->>'reference_id')::uuid=t.reference_id)
        OR (s.body->>'type'='commission' AND t.type='commission' AND (s.body->>'reference_id')::uuid=t.reference_id
          AND t.user_id=(p_owner#>>ARRAY['identity_map',s.body->>'user_id'])::uuid)
      WHERE t.id<>s.id::uuid OR t.user_id IS DISTINCT FROM (p_owner#>>ARRAY['identity_map',s.body->>'user_id'])::uuid
        OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_staging AS d WHERE d.job_id=p_job.id
          AND d.employee_id=(s.body->>'user_id')::uuid AND d.table_key='mapped-finance-done-v1'))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_ledger_entries') AS s JOIN public.wallet_ledger_entries AS t
      ON (s.body->>'operation_id')::uuid=t.operation_id AND s.body->>'source_type'=t.source_type
        AND (s.body->>'source_id')::uuid=t.source_id AND s.body->>'event_type'=t.event_type
      WHERE t.user_id IS DISTINCT FROM (p_owner#>>ARRAY['identity_map',s.body->>'user_id'])::uuid
        OR NOT EXISTS(SELECT 1 FROM private.employee_transfer_staging AS d WHERE d.job_id=p_job.id
          AND d.employee_id=(s.body->>'user_id')::uuid AND d.table_key='mapped-finance-done-v1'))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_transactions') WHERE body->>'operation_id' IS NOT NULL
      GROUP BY body->>'operation_id',body->>'type' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_transactions')
      WHERE body->>'type' IN ('tip','performance_bonus') AND body->>'reference_id' IS NOT NULL
      GROUP BY body->>'type',body->>'reference_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_transactions')
      WHERE body->>'type'='commission' AND body->>'reference_id' IS NOT NULL
      GROUP BY body->>'user_id',body->>'reference_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_ledger_entries')
      GROUP BY body->>'operation_id',body->>'source_type',body->>'source_id',body->>'event_type' HAVING count(*)>1) THEN
    v_issues:=v_issues||'"financial_unique_collision"'::jsonb;
  END IF;
  IF EXISTS(SELECT 1 FROM (SELECT body->>'created_by' AS actor FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_transactions')
      UNION SELECT body->>'audited_by' FROM private.employee_transfer_mapped_finance_input(p_job.id,'withdrawals')) AS s
    LEFT JOIN public.admins AS a ON a.id=(p_owner#>>ARRAY['admin_map',s.actor])::uuid WHERE s.actor IS NOT NULL AND a.id IS NULL) THEN
    v_issues:=v_issues||'"unmapped_administrator"'::jsonb;
  END IF;
  -- Deleted source rows intentionally leave ledger events; only surviving cross-owner references are invalid.
  IF EXISTS(WITH ledger AS MATERIALIZED(SELECT body FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_ledger_entries')),
    transactions AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_transactions')),
    withdrawals AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_mapped_finance_input(p_job.id,'withdrawals'))
    SELECT 1 FROM ledger AS l JOIN transactions AS t ON l.body->>'source_type'='wallet_transaction' AND t.id=l.body->>'source_id'
      WHERE t.body->'user_id' IS DISTINCT FROM l.body->'user_id'
    UNION ALL SELECT 1 FROM ledger AS l JOIN withdrawals AS w ON l.body->>'source_type'='withdrawal' AND w.id=l.body->>'source_id'
      WHERE w.body->'user_id' IS DISTINCT FROM l.body->'user_id'
    UNION ALL SELECT 1 FROM ledger AS l JOIN public.wallet_transactions AS t
      ON l.body->>'source_type'='wallet_transaction' AND t.id=(l.body->>'source_id')::uuid
      WHERE t.user_id IS DISTINCT FROM (p_owner#>>ARRAY['identity_map',l.body->>'user_id'])::uuid
    UNION ALL SELECT 1 FROM ledger AS l JOIN public.withdrawals AS w
      ON l.body->>'source_type'='withdrawal' AND w.id=(l.body->>'source_id')::uuid
      WHERE w.user_id IS DISTINCT FROM (p_owner#>>ARRAY['identity_map',l.body->>'user_id'])::uuid) THEN
    v_issues:=v_issues||'"inconsistent_source_finance"'::jsonb;
  END IF;
  RETURN (SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value COLLATE "C"),'[]') FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(v_issues)) AS issues);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_plan(p_job private.employee_transfer_jobs,p_owner jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_plan jsonb;v_site uuid;v_n bigint;v_amount numeric;v_conflicts jsonb;v_hash text;
BEGIN
  IF p_owner->'catalog' IS NULL OR p_owner->'catalog'='null'::jsonb THEN RAISE EXCEPTION 'Mapped finance catalog is required.';END IF;
  SELECT site_id INTO STRICT v_site FROM private.employee_transfer_site;
  SELECT count(*),COALESCE(sum((body->>'amount')::numeric),0) INTO v_n,v_amount
    FROM private.employee_transfer_mapped_finance_input(p_job.id,'withdrawals') WHERE body->>'status'='pending';
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('dependency_mapping_hash',p_owner->'mapping_hash',
    'dependency_plan',p_owner->'dependency_plan','identity_map',p_owner->'identity_map','admin_map',p_owner->'admin_map')::text,'UTF8'),'sha256'),'hex');
  v_plan:=jsonb_build_object('scope','employee-mapped-finance','job_id',p_job.id,'site_id',v_site,
    'source_site_id',(p_job.summary#>>'{identity_catalog,site_id}')::uuid,'package_id',(p_job.options->>'package_id')::uuid,
    'catalog_hash',encode(extensions.digest(convert_to((p_owner->'catalog')::text,'UTF8'),'sha256'),'hex'),
    'mapping_hash',v_hash,'totals',p_owner->'totals','employees',(SELECT count(*) FROM jsonb_each(p_owner->'identity_map')),
    'pending_withdrawals',jsonb_build_object('count',v_n,'amount',v_amount::text),'maintenance',true,
    'dependencies_pending',true,'financial_data_pending',true,'can_restore',false,'complete_employee_backup',false,
    'can_archive',false,'can_replace',false,'full_site_complete',false);
  v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,'catalog',p_owner->'catalog',
    'identity_catalog',p_job.summary->'identity_catalog','dispatch_catalog',p_job.options->'catalog',
    'configuration_plan',p_job.summary->'dispatch_config_plan','dependency_plan',p_owner->'dependency_plan',
    'identity_map',p_owner->'identity_map','admin_map',p_owner->'admin_map')::text,'UTF8'),'sha256'),'hex');
  v_conflicts:=private.employee_transfer_mapped_finance_conflicts(p_job,p_owner);
  RETURN v_plan||jsonb_build_object('plan_hash',v_hash,'can_begin',jsonb_array_length(v_conflicts)=0,'conflicts',v_conflicts);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_context(p_job private.employee_transfer_jobs,p_complete boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_owner jsonb;v_dependency jsonb;v_catalog jsonb;v_totals jsonb:='{}';v_state jsonb;v_phase jsonb;v_plan jsonb;
BEGIN
  PERFORM private.employee_transfer_identity_owner(p_job);
  IF p_job.summary ?| ARRAY['identity_restore','dependency_restore','finance_restore','finance_plan','finance_catalog','verified_identity_map'] THEN
    RAISE EXCEPTION 'Legacy restore state cannot be mixed with mapped finance.';
  END IF;
  v_owner:=private.employee_transfer_mapped_finance_owner(p_job);
  v_dependency:=private.employee_transfer_mapped_dependency_saved(p_job);
  IF v_dependency IS NULL OR v_dependency->'verified' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Verified mapped dispatch dependencies are required.';
  END IF;
  PERFORM private.employee_transfer_mapped_dependency_progress(p_job,v_owner,v_dependency);
  PERFORM private.employee_transfer_finance_schema();PERFORM private.employee_transfer_assert_finance_triggers();
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key LIKE 'mapped-finance%'
    AND table_key NOT IN ('mapped-finance-catalog-v1','mapped-finance-v1','mapped-finance-done-v1','mapped-finance-map:ledger','mapped-finance-map:audit',
      'mapped-finance-in:wallets','mapped-finance-in:wallet_balance_baselines','mapped-finance-in:wallet_ledger_entries',
      'mapped-finance-in:wallet_transactions','mapped-finance-in:withdrawals','mapped-finance-in:wallet_reconciliation_audit')) THEN
    RAISE EXCEPTION 'Mapped finance namespace changed.';
  END IF;
  v_state:=private.employee_transfer_mapped_finance_saved(p_job);v_catalog:=private.employee_transfer_mapped_finance_catalog(p_job);
  IF v_catalog IS NOT NULL THEN v_totals:=private.employee_transfer_mapped_finance_source(p_job,p_complete OR v_state IS NOT NULL);
  ELSIF p_complete OR v_state IS NOT NULL OR EXISTS(SELECT 1 FROM private.employee_transfer_staging
    WHERE job_id=p_job.id AND table_key LIKE 'mapped-finance-in:%') THEN RAISE EXCEPTION 'Bind a mapped finance catalog first.';END IF;
  v_phase:=private.employee_transfer_mapped_finance_phase(p_job,v_owner,v_state);
  v_owner:=v_owner||v_phase||jsonb_build_object('catalog',v_catalog,'totals',v_totals,'dependency_plan',v_dependency->'plan','state',v_state);
  IF v_state IS NOT NULL THEN
    v_plan:=private.employee_transfer_mapped_finance_plan(p_job,v_owner);
    IF v_state->'plan' IS DISTINCT FROM v_plan OR v_plan->'can_begin' IS DISTINCT FROM 'true'::jsonb
      OR v_state->'identity_map' IS DISTINCT FROM v_owner->'identity_map' OR v_state->'admin_map' IS DISTINCT FROM v_owner->'admin_map'
      OR v_state->'completed_employees' IS DISTINCT FROM v_phase->'completed_employees'
      OR (v_state->'verified'='true'::jsonb AND v_state->'completed_employees' IS DISTINCT FROM v_plan->'employees') THEN
      RAISE EXCEPTION 'Mapped finance saved plan, mappings or progress changed.';
    END IF;
  END IF;
  RETURN v_owner;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_finance_receipt(p_job private.employee_transfer_jobs,p_owner jsonb,p_source uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_plan jsonb;v_state jsonb:=NULLIF(p_owner->'state','null'::jsonb);v_counts jsonb:='{}';v_key text;v_employee jsonb:='null';v_applied boolean;
BEGIN
  IF v_state IS NULL THEN v_plan:=private.employee_transfer_mapped_finance_plan(p_job,p_owner);ELSE v_plan:=v_state->'plan';END IF;
  IF p_source IS NOT NULL THEN
    IF NOT ((p_owner->'identity_map') ? p_source::text) THEN RAISE EXCEPTION 'Mapped finance employee is not in this package.';END IF;
    SELECT EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id=p_source
      AND table_key='mapped-finance-done-v1') INTO v_applied;
    FOREACH v_key IN ARRAY ARRAY['wallets','wallet_balance_baselines','wallet_ledger_entries','wallet_transactions','withdrawals','wallet_reconciliation_audit'] LOOP
      v_counts:=v_counts||jsonb_build_object(v_key,CASE WHEN v_applied THEN (SELECT count(*)
        FROM private.employee_transfer_mapped_finance_input(p_job.id,v_key) WHERE body->>'user_id'=p_source::text) ELSE 0 END);
    END LOOP;
    v_employee:=jsonb_build_object('source_id',p_source,'target_id',p_owner#>ARRAY['identity_map',p_source::text],'applied',v_applied,'counts',v_counts);
  END IF;
  RETURN (v_plan-ARRAY['can_begin','conflicts'])||jsonb_build_object('started',v_state IS NOT NULL,
    'completed_employees',p_owner->'completed_employees','verified',COALESCE(v_state->'verified','false'::jsonb),'employee',v_employee);
END;
$$;

CREATE FUNCTION public.employee_import_mapped_finance_bind(p_admin_session_token uuid,p_job_token uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_catalog jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_finance_context(v_job,false);
  IF v_owner->'target_empty' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Mapped finance targets are not empty.';END IF;
  PERFORM private.employee_transfer_check_finance_catalog(p_catalog);
  IF p_catalog->'identity_catalog' IS DISTINCT FROM v_job.summary->'identity_catalog'
    OR p_catalog->'site_id' IS DISTINCT FROM v_job.options#>'{catalog,site_id}'
    OR p_catalog->'package_id' IS DISTINCT FROM v_job.options->'package_id' THEN RAISE EXCEPTION 'Mapped finance catalog binding differs.';END IF;
  v_catalog:=private.employee_transfer_mapped_finance_catalog(v_job);
  IF v_catalog IS NOT NULL THEN
    IF v_catalog IS DISTINCT FROM p_catalog THEN RAISE EXCEPTION 'Mapped finance catalog is immutable.';END IF;
  ELSE
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-finance-catalog-v1',0,1,p_catalog);
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-mapped-finance',
    'catalog_hash',encode(extensions.digest(convert_to(p_catalog::text,'UTF8'),'sha256'),'hex'),'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped finance catalog request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_finance_stage(
  p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_payload jsonb;v_previous record;v_n bigint;v_rows integer;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_finance_context(v_job,false);
  IF v_owner->'catalog'='null'::jsonb OR v_owner->'target_empty' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Mapped finance requires a catalog and clean targets.';
  END IF;
  IF p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 500000 THEN RAISE EXCEPTION 'Invalid mapped finance chunk number.';END IF;
  v_payload:=private.employee_transfer_mapped_finance_parse(p_table_key,p_ndjson);v_rows:=jsonb_array_length(v_payload->'rows');
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND table_key='mapped-finance-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_n>0 THEN
    SELECT * INTO STRICT v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id
      AND table_key='mapped-finance-in:'||p_table_key AND chunk_no=p_chunk_no;
    IF v_previous.payload IS DISTINCT FROM v_payload OR v_previous.row_count<>v_rows
      OR v_previous.employee_id<>'00000000-0000-0000-0000-000000000000' THEN
      RAISE EXCEPTION 'Mapped finance repeated chunk changed.';
    END IF;
  ELSE
    IF v_owner->'state'<>'null'::jsonb THEN RAISE EXCEPTION 'Mapped finance staging is frozen.';END IF;
    SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=v_job.id AND table_key='mapped-finance-in:'||p_table_key;
    IF v_n<>p_chunk_no THEN RAISE EXCEPTION 'Mapped finance chunks must be consecutive.';END IF;
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-finance-in:'||p_table_key,p_chunk_no,v_rows,v_payload);
    PERFORM private.employee_transfer_mapped_finance_source(v_job,false);
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-mapped-finance','table_key',p_table_key,'chunk_no',p_chunk_no,
    'rows',v_rows,'bytes',octet_length(p_ndjson),'sha256',encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex'),'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped finance staging request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_finance_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_finance_context(v_job,true);
  RETURN private.employee_transfer_mapped_finance_plan(v_job,v_owner);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped finance plan request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_finance_begin(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_plan jsonb;v_state jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_finance_context(v_job,true);v_plan:=private.employee_transfer_mapped_finance_plan(v_job,v_owner);
  IF p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$' OR p_plan_hash IS DISTINCT FROM v_plan->>'plan_hash'
    OR v_plan->'can_begin' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Mapped finance plan changed or has conflicts.';END IF;
  IF v_owner->'state'<>'null'::jsonb THEN RETURN private.employee_transfer_mapped_finance_receipt(v_job,v_owner,NULL);END IF;
  v_state:=jsonb_build_object('plan',v_plan,'identity_map',v_owner->'identity_map','admin_map',v_owner->'admin_map','completed_employees',0,'verified',false);
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-finance-v1',0,1,v_state);
  v_owner:=private.employee_transfer_mapped_finance_context(v_job,true);
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_finance_started',
    jsonb_build_object('plan_hash',p_plan_hash,'mapping_hash',v_plan->'mapping_hash','full_site_complete',false));
  RETURN private.employee_transfer_mapped_finance_receipt(v_job,v_owner,NULL);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped finance begin request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_finance_apply(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;v_target uuid;v_key text;v_alias text;
  v_row jsonb;v_old text;v_new bigint;v_columns text;v_mapping jsonb;v_chunk integer;v_disabled jsonb;v_counts jsonb;v_n bigint;v_bypassed text[];
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_finance_context(v_job,true);v_state:=NULLIF(v_owner->'state','null'::jsonb);
  IF v_state IS NULL OR p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$'
    OR v_state#>>'{plan,plan_hash}' IS DISTINCT FROM p_plan_hash OR p_source_id IS NULL
    OR NOT ((v_owner->'identity_map') ? p_source_id::text) THEN RAISE EXCEPTION 'Mapped finance apply binding is invalid.';END IF;
  v_target:=(v_owner#>>ARRAY['identity_map',p_source_id::text])::uuid;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id=p_source_id
    AND table_key='mapped-finance-done-v1') THEN RETURN private.employee_transfer_mapped_finance_receipt(v_job,v_owner,p_source_id);END IF;
  IF NOT private.employee_transfer_mapped_finance_empty(v_target) THEN RAISE EXCEPTION 'Mapped finance target changed.';END IF;
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names) VALUES(pg_current_xact_id(),v_job.id,
    ARRAY['public.wallets','public.wallet_balance_baselines','public.wallet_ledger_entries','public.wallet_transactions','public.withdrawals','public.wallet_reconciliation_audit']);
  v_disabled:=private.employee_transfer_bypass_triggers(ARRAY['wallets','wallet_transactions','withdrawals']);
  SELECT array_agg((value->>'table')||'.'||(value->>'trigger') ORDER BY ((value->>'table')||'.'||(value->>'trigger')) COLLATE "C")
    INTO v_bypassed FROM jsonb_array_elements(v_disabled);
  IF v_bypassed IS DISTINCT FROM ARRAY['wallet_transactions.queue_notification_automation_from_wallet_transaction',
    'wallet_transactions.trigger_audit_commission_transaction','wallet_transactions.trigger_track_wallet_transaction_ledger',
    'wallets.trigger_enqueue_changed_wallet','withdrawals.trigger_track_withdrawal_ledger','withdrawals.withdrawals_emit_event'] THEN
    RAISE EXCEPTION 'Unreviewed mapped finance trigger bypass.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['wallet_ledger_entries','wallet_reconciliation_audit'] LOOP
    v_alias:=CASE v_key WHEN 'wallet_ledger_entries' THEN 'ledger' ELSE 'audit' END;v_mapping:='[]';v_chunk:=0;
    SELECT string_agg(format('%I',key),',' ORDER BY key COLLATE "C") INTO v_columns FROM jsonb_each(private.employee_transfer_finance_spec()->v_key);
    FOR v_row IN SELECT body FROM private.employee_transfer_mapped_finance_input(v_job.id,v_key)
      WHERE body->>'user_id'=p_source_id::text ORDER BY id::bigint LOOP
      v_old:=v_row->>'id';SELECT nextval(pg_get_serial_sequence('public.'||v_key,'id')::regclass) INTO v_new;
      v_mapping:=v_mapping||jsonb_build_array(jsonb_build_object('old_id',v_old,'new_id',v_new::text));
      v_row:=v_row||jsonb_build_object('id',v_new::text,'user_id',v_target);
      PERFORM private.employee_transfer_check_finance_row(v_key,v_row);
      EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) AS r',v_key,v_columns,v_columns,v_key) USING v_row;
      IF jsonb_array_length(v_mapping)=200 THEN
        INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
          VALUES(v_job.id,p_source_id,'mapped-finance-map:'||v_alias,v_chunk,200,v_mapping);
        v_mapping:='[]';v_chunk:=v_chunk+1;
      END IF;
    END LOOP;
    IF jsonb_array_length(v_mapping)>0 THEN
      INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
        VALUES(v_job.id,p_source_id,'mapped-finance-map:'||v_alias,v_chunk,jsonb_array_length(v_mapping),v_mapping);
    END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['wallets','wallet_balance_baselines','wallet_transactions','withdrawals'] LOOP
    FOR v_row IN SELECT body FROM private.employee_transfer_mapped_finance_expected(v_job,p_source_id,v_target,v_key,v_owner->'admin_map') LOOP
      PERFORM private.employee_transfer_check_finance_row(v_key,v_row);
      IF v_key='wallets' THEN
        UPDATE public.wallets SET available_balance=(v_row->>'available_balance')::numeric,frozen_balance=(v_row->>'frozen_balance')::numeric,
          created_at=(v_row->>'created_at')::timestamptz,updated_at=(v_row->>'updated_at')::timestamptz WHERE user_id=v_target;
        GET DIAGNOSTICS v_n=ROW_COUNT;
        IF v_n<>1 THEN RAISE EXCEPTION 'Mapped finance existing wallet is missing.';END IF;
      ELSE
        SELECT string_agg(format('%I',key),',' ORDER BY key COLLATE "C") INTO v_columns
          FROM jsonb_each(private.employee_transfer_finance_spec()->v_key) WHERE NOT(v_key='wallet_balance_baselines' AND key='id');
        EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) AS r',v_key,v_columns,v_columns,v_key) USING v_row;
      END IF;
    END LOOP;
  END LOOP;
  PERFORM private.employee_transfer_restore_triggers(v_disabled);PERFORM private.employee_transfer_clear_write_permit();
  PERFORM private.employee_transfer_assert_finance_triggers();
  v_counts:=private.employee_transfer_mapped_finance_check_written(v_job,p_source_id,v_target,v_owner->'admin_map');
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,p_source_id,'mapped-finance-done-v1',0,1,jsonb_build_object('source_id',p_source_id,'target_id',v_target,'plan_hash',p_plan_hash,'counts',v_counts));
  v_state:=jsonb_set(v_state,'{completed_employees}',to_jsonb((v_state->>'completed_employees')::bigint+1));
  UPDATE private.employee_transfer_staging SET payload=v_state WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='mapped-finance-v1' AND chunk_no=0;
  v_owner:=private.employee_transfer_mapped_finance_context(v_job,true);
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_finance_employee',
    jsonb_build_object('source_id',p_source_id,'target_id',v_target,'counts',v_counts,'plan_hash',p_plan_hash,'full_site_complete',false));
  RETURN private.employee_transfer_mapped_finance_receipt(v_job,v_owner,p_source_id);
EXCEPTION WHEN OTHERS THEN
  PERFORM private.employee_transfer_clear_write_permit();
  RAISE EXCEPTION 'Mapped finance employee request rejected; this request was not committed.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_finance_status(p_admin_session_token uuid,p_job_token uuid,p_source_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_finance_context(v_job,true);
  RETURN private.employee_transfer_mapped_finance_receipt(v_job,v_owner,p_source_id);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped finance status request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_finance_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_finance_context(v_job,true);v_state:=NULLIF(v_owner->'state','null'::jsonb);
  IF v_state IS NULL OR v_state->'completed_employees' IS DISTINCT FROM v_state#>'{plan,employees}' THEN
    RAISE EXCEPTION 'Mapped finance employees are incomplete.';
  END IF;
  IF v_state->'verified' IS DISTINCT FROM 'true'::jsonb THEN
    v_state:=jsonb_set(v_state,'{verified}','true'::jsonb);
    UPDATE private.employee_transfer_staging SET payload=v_state WHERE job_id=v_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='mapped-finance-v1' AND chunk_no=0;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_finance_verified',
      jsonb_build_object('plan_hash',v_state#>'{plan,plan_hash}','employees',v_state->'completed_employees','full_site_complete',false));
  END IF;
  v_owner:=private.employee_transfer_mapped_finance_context(v_job,true);
  RETURN private.employee_transfer_mapped_finance_receipt(v_job,v_owner,NULL);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped finance verification request rejected.' USING ERRCODE='22023';
END;
$$;

DO $permissions$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace
    AND proname IN ('employee_transfer_mapped_finance_identity_guard','employee_transfer_mapped_finance_map','employee_transfer_mapped_finance_owner',
      'employee_transfer_mapped_finance_input','employee_transfer_mapped_finance_catalog','employee_transfer_mapped_finance_parse',
      'employee_transfer_mapped_finance_source','employee_transfer_mapped_finance_source_issues','employee_transfer_mapped_finance_check_counts','employee_transfer_mapped_finance_saved',
      'employee_transfer_mapped_finance_empty','employee_transfer_mapped_finance_expected','employee_transfer_mapped_finance_check_written',
      'employee_transfer_mapped_finance_phase','employee_transfer_mapped_finance_conflicts','employee_transfer_mapped_finance_plan',
      'employee_transfer_mapped_finance_context','employee_transfer_mapped_finance_receipt') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
END;
$permissions$;
REVOKE ALL ON FUNCTION public.employee_import_mapped_finance_bind(uuid,uuid,jsonb),
  public.employee_import_mapped_finance_stage(uuid,uuid,text,integer,text),public.employee_import_mapped_finance_plan(uuid,uuid),
  public.employee_import_mapped_finance_begin(uuid,uuid,text),public.employee_import_mapped_finance_apply(uuid,uuid,uuid,text),
  public.employee_import_mapped_finance_status(uuid,uuid,uuid),public.employee_import_mapped_finance_verify(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_import_mapped_finance_bind(uuid,uuid,jsonb),
  public.employee_import_mapped_finance_stage(uuid,uuid,text,integer,text),public.employee_import_mapped_finance_plan(uuid,uuid),
  public.employee_import_mapped_finance_begin(uuid,uuid,text),public.employee_import_mapped_finance_apply(uuid,uuid,uuid,text),
  public.employee_import_mapped_finance_status(uuid,uuid,uuid),public.employee_import_mapped_finance_verify(uuid,uuid) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;

-- Unexecuted rollback removes only new functions, not committed funds or dirty maintenance.
-- DROP FUNCTION public.employee_import_mapped_finance_verify(uuid,uuid);
-- DROP FUNCTION public.employee_import_mapped_finance_status(uuid,uuid,uuid);
-- DROP FUNCTION public.employee_import_mapped_finance_apply(uuid,uuid,uuid,text);
-- DROP FUNCTION public.employee_import_mapped_finance_begin(uuid,uuid,text);
-- DROP FUNCTION public.employee_import_mapped_finance_plan(uuid,uuid);
-- DROP FUNCTION public.employee_import_mapped_finance_stage(uuid,uuid,text,integer,text);
-- DROP FUNCTION public.employee_import_mapped_finance_bind(uuid,uuid,jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_finance_receipt(private.employee_transfer_jobs,jsonb,uuid);
-- DROP FUNCTION private.employee_transfer_mapped_finance_context(private.employee_transfer_jobs,boolean);
-- DROP FUNCTION private.employee_transfer_mapped_finance_plan(private.employee_transfer_jobs,jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_finance_conflicts(private.employee_transfer_jobs,jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_finance_phase(private.employee_transfer_jobs,jsonb,jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_finance_check_written(private.employee_transfer_jobs,uuid,uuid,jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_finance_expected(private.employee_transfer_jobs,uuid,uuid,text,jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_finance_empty(uuid);
-- DROP FUNCTION private.employee_transfer_mapped_finance_saved(private.employee_transfer_jobs);
-- DROP FUNCTION private.employee_transfer_mapped_finance_check_counts(jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_finance_source_issues(private.employee_transfer_jobs);
-- DROP FUNCTION private.employee_transfer_mapped_finance_source(private.employee_transfer_jobs,boolean);
-- DROP FUNCTION private.employee_transfer_mapped_finance_parse(text,text);
-- DROP FUNCTION private.employee_transfer_mapped_finance_catalog(private.employee_transfer_jobs);
-- DROP FUNCTION private.employee_transfer_mapped_finance_input(uuid,text);
-- DROP FUNCTION private.employee_transfer_mapped_finance_owner(private.employee_transfer_jobs);
-- DROP FUNCTION private.employee_transfer_mapped_finance_map(private.employee_transfer_jobs);
-- DROP FUNCTION private.employee_transfer_mapped_finance_identity_guard(private.employee_transfer_jobs,uuid,jsonb);
