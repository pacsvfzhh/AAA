-- 独立全包映射路径：只恢复成员/已用交单，不写旧身份或依赖回执，不开放完整恢复。
-- 仅本地新增，未部署；不续 heartbeat、不启用账号、不封存、不结束维护。
BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- SQL10 的目录检查不足以证明 parsed rows 对应原文；重新解析全部派单原文，
-- 包括配置/valid，避免通过只修改 parsed rows 而继续沿用旧摘要。
CREATE FUNCTION private.employee_transfer_mapped_dependency_source(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_table jsonb;v_key text;v_stage record;v_line text;v_json json;v_rows jsonb;v_hashes text;
  v_all_hashes text;v_last text;v_cursor text;v_chunks integer;v_count bigint;v_bytes bigint;v_result jsonb:='{}';
BEGIN
  PERFORM private.employee_transfer_check_dispatch_catalog(p_job.options->'catalog');
  FOR v_table IN SELECT value FROM jsonb_array_elements(p_job.options#>'{catalog,tables}') LOOP
    v_key:=v_table->>'key';v_cursor:=NULL;v_chunks:=0;v_count:=0;v_bytes:=0;v_all_hashes:='';
    IF EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='dispatch-in:'||v_key
      AND employee_id<>'00000000-0000-0000-0000-000000000000') THEN
      RAISE EXCEPTION 'Mapped dependency source namespace changed.';
    END IF;
    FOR v_stage IN SELECT * FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:'||v_key ORDER BY chunk_no LOOP
      IF v_stage.chunk_no<>v_chunks OR v_stage.row_count NOT BETWEEN 0 AND 200
        OR NOT private.employee_transfer_exact_object(v_stage.payload,ARRAY['ndjson','rows','bytes','row_hashes','last_id'])
        OR jsonb_typeof(v_stage.payload->'ndjson') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_stage.payload->'rows') IS DISTINCT FROM 'array'
        OR jsonb_typeof(v_stage.payload->'bytes') IS DISTINCT FROM 'number'
        OR (v_stage.payload->>'bytes') !~ '^(0|[1-9][0-9]{0,5})$'
        OR jsonb_typeof(v_stage.payload->'row_hashes') IS DISTINCT FROM 'string'
        OR octet_length(v_stage.payload->>'ndjson')>262144 THEN
        RAISE EXCEPTION 'Mapped dependency source chunk changed.';
      END IF;
      v_rows:='[]';v_hashes:='';v_last:=NULL;
      IF v_stage.payload->>'ndjson'<>'' THEN
        IF right(v_stage.payload->>'ndjson',1)<>E'\n' THEN RAISE EXCEPTION 'Mapped dependency source framing changed.';END IF;
        FOR v_line IN SELECT line FROM unnest(string_to_array(left(v_stage.payload->>'ndjson',length(v_stage.payload->>'ndjson')-1),E'\n')) AS input(line) LOOP
          IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Mapped dependency source row exceeds limits.';END IF;
          v_json:=v_line::json;
          IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN
            RAISE EXCEPTION 'Mapped dependency source JSON changed.';
          END IF;
          PERFORM private.employee_transfer_check_dispatch_row(v_key,v_json::jsonb);
          IF v_cursor IS NOT NULL AND v_cursor COLLATE "C">=(v_json->>'id') COLLATE "C" THEN
            RAISE EXCEPTION 'Mapped dependency source row order changed.';
          END IF;
          v_cursor:=v_json->>'id';v_last:=v_cursor;
          v_rows:=v_rows||jsonb_build_array(v_json::jsonb);
          IF jsonb_array_length(v_rows)>200 THEN RAISE EXCEPTION 'Mapped dependency source chunk exceeds limits.';END IF;
          v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
        END LOOP;
      END IF;
      IF v_rows IS DISTINCT FROM v_stage.payload->'rows' OR v_hashes IS DISTINCT FROM v_stage.payload->>'row_hashes'
        OR jsonb_array_length(v_rows) IS DISTINCT FROM v_stage.row_count
        OR octet_length(v_stage.payload->>'ndjson') IS DISTINCT FROM (v_stage.payload->>'bytes')::integer
        OR v_stage.payload->'last_id' IS DISTINCT FROM COALESCE(to_jsonb(v_last),'null'::jsonb)
        OR (v_stage.row_count=0 AND (v_stage.chunk_no<>0 OR v_table->'rows' IS DISTINCT FROM '0'::jsonb)) THEN
        RAISE EXCEPTION 'Mapped dependency source raw rows or hashes changed.';
      END IF;
      v_chunks:=v_chunks+1;v_count:=v_count+v_stage.row_count;
      v_bytes:=v_bytes+octet_length(v_stage.payload->>'ndjson');v_all_hashes:=v_all_hashes||v_hashes;
    END LOOP;
    IF v_chunks<1 OR v_count IS DISTINCT FROM (v_table->>'rows')::bigint
      OR v_bytes IS DISTINCT FROM (v_table->>'bytes')::bigint OR (v_count=0 AND v_chunks<>1)
      OR encode(extensions.digest(convert_to(v_all_hashes,'UTF8'),'sha256'),'hex') IS DISTINCT FROM v_table->>'row_hashes_sha256' THEN
      RAISE EXCEPTION 'Mapped dependency source directory changed.';
    END IF;
    IF v_key IN ('dispatch_group_members','used_order_data') THEN v_result:=v_result||jsonb_build_object(v_key,v_chunks);END IF;
  END LOOP;
  PERFORM private.employee_transfer_dispatch_check_input(p_job);
  RETURN v_result;
END;
$$;

-- 只接受每一个来源账户的 SQL49 完整 verified 状态；不是旧 id=id map。
-- 哈希绑定完整 SQL49 计划及来源目录，不接受任何客户端映射。
CREATE FUNCTION private.employee_transfer_mapped_dependency_map(p_job private.employee_transfer_jobs)
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
    -- SQL49 重扫 credentials/orders 原文及绑定，并实际重验账户、凭据和全部已提交订单。
    PERFORM private.employee_transfer_mapped_identity_check_written(p_job,v_source.id,v_state);
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

-- 基础任务/超管/已封存备份/dirty 维护由 SQL37 owner 核对；这里独立复核
-- SQL16 的配置及 valid 实物部分，绝不调用旧 verified_identity_map。
CREATE FUNCTION private.employee_transfer_mapped_dependency_owner(p_job private.employee_transfer_jobs)
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
  v_identity:=private.employee_transfer_mapped_dependency_map(p_job);
  -- 完整来源引用检查不使用过滤 JOIN 后的行数来冒充成功。
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

CREATE FUNCTION private.employee_transfer_mapped_dependency_rows(
  p_job private.employee_transfer_jobs,p_key text,p_rows jsonb,p_owner jsonb
) RETURNS TABLE(id uuid,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_source jsonb;v_target uuid;v_group uuid;v_assigner uuid;v_n bigint;
BEGIN
  IF p_key IS NULL OR p_key NOT IN ('dispatch_group_members','used_order_data')
    OR jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows)>200 THEN
    RAISE EXCEPTION 'Unsupported mapped dependency rows.';
  END IF;
  FOR v_source IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    PERFORM private.employee_transfer_check_dispatch_row(p_key,v_source);
    v_target:=(p_owner#>>ARRAY['identity_map',v_source->>'user_id'])::uuid;
    IF v_target IS NULL OR v_target=(v_source->>'user_id')::uuid OR NOT EXISTS(
      SELECT 1 FROM public.users AS u WHERE u.id=v_target AND u.is_active=false AND u.archived_at IS NULL
    ) THEN RAISE EXCEPTION 'Mapped dependency employee is missing or active.';END IF;
    IF p_key='dispatch_group_members' THEN
      v_group:=(p_owner#>>ARRAY['group_map',v_source->>'group_id'])::uuid;
      v_assigner:=(p_owner#>>ARRAY['admin_map',v_source->>'assigned_by'])::uuid;
      IF v_group IS NULL OR NOT EXISTS(SELECT 1 FROM public.dispatch_groups AS g WHERE g.id=v_group)
        OR (v_source->>'assigned_by' IS NOT NULL AND (v_assigner IS NULL OR NOT EXISTS(
          SELECT 1 FROM public.admins AS a WHERE a.id=v_assigner))) THEN
        RAISE EXCEPTION 'Mapped dependency group or assigner is missing.';
      END IF;
      body:=jsonb_build_object('id',v_source->'id','group_id',v_group,'user_id',v_target,
        'assigned_by',v_assigner,'assigned_at',v_source->'assigned_at');
    ELSE
      SELECT count(*) INTO v_n FROM private.employee_transfer_identity_input(p_job.id,'orders') AS o
        WHERE o.id=(v_source->>'order_id')::uuid AND o.body->>'user_id'=v_source->>'user_id';
      IF v_n<>1 OR NOT EXISTS(SELECT 1 FROM public.orders AS o WHERE o.id=(v_source->>'order_id')::uuid
          AND o.user_id=v_target AND o.status IN ('success','failure'))
        OR NOT EXISTS(SELECT 1 FROM public.valid_order_data AS v WHERE v.id=(v_source->>'valid_order_data_id')::uuid) THEN
        RAISE EXCEPTION 'Mapped dependency completed order or valid submission is missing or mismatched.';
      END IF;
      body:=jsonb_build_object('id',v_source->'id','user_id',v_target,'valid_order_data_id',v_source->'valid_order_data_id',
        'order_id',v_source->'order_id','created_at',v_source->'created_at');
    END IF;
    PERFORM private.employee_transfer_check_dispatch_row(p_key,body);
    id:=(v_source->>'id')::uuid;
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_dependency_check(
  p_job private.employee_transfer_jobs,p_key text,p_rows jsonb,p_owner jsonb
) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_expected jsonb;v_bad boolean;
BEGIN
  SELECT COALESCE(jsonb_agg(r.body),'[]') INTO v_expected
    FROM private.employee_transfer_mapped_dependency_rows(p_job,p_key,p_rows,p_owner) AS r;
  IF jsonb_array_length(v_expected)<>jsonb_array_length(p_rows) THEN
    RAISE EXCEPTION 'Mapped dependency row mapping is incomplete.';
  END IF;
  EXECUTE 'SELECT EXISTS(SELECT 1 FROM jsonb_array_elements($1) AS expected(body) LEFT JOIN ('||
    private.employee_transfer_dispatch_query(p_key)||') AS actual ON actual.id=(expected.body->>''id'')::uuid
      AND actual.body=expected.body WHERE actual.id IS NULL)' INTO v_bad USING v_expected;
  IF v_bad THEN RAISE EXCEPTION 'Mapped dependency committed contents changed.';END IF;
END;
$$;

-- p_started 只影响初次残留检查；plan_hash 不含可变目标残留数量或 conflicts。
-- 因此已开始后可独立重算原计划，同时由 progress 验证全部实物/提交计数。
CREATE FUNCTION private.employee_transfer_mapped_dependency_plan(
  p_job private.employee_transfer_jobs,p_owner jsonb,p_started boolean
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_plan jsonb;v_conflicts jsonb:='[]';v_site uuid;
BEGIN
  SELECT site_id INTO STRICT v_site FROM private.employee_transfer_site;
  v_plan:=jsonb_build_object('scope','employee-mapped-dependencies','job_id',p_job.id,'site_id',v_site,
    'source_site_id',(p_job.summary#>>'{identity_catalog,site_id}')::uuid,'package_id',(p_job.options->>'package_id')::uuid,
    'mapping_hash',p_owner->'mapping_hash','totals',jsonb_build_object(
      'dispatch_group_members',p_job.options#>'{catalog,tables,4,rows}','used_order_data',p_job.options#>'{catalog,tables,6,rows}'),
    'chunks',p_owner->'chunks','maintenance',true,'dependencies_pending',true,'can_restore',false,
    'complete_employee_backup',false,'can_archive',false,'can_replace',false,'full_site_complete',false);
  v_plan:=v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object(
    'plan',v_plan,'identity_catalog',p_job.summary->'identity_catalog','dispatch_catalog',p_job.options->'catalog',
    'configuration_plan',p_job.summary->'dispatch_config_plan','admin_map',p_owner->'admin_map',
    'group_map',p_owner->'group_map','identity_map',p_owner->'identity_map')::text,'UTF8'),'sha256'),'hex'));
  IF NOT p_started THEN
    IF EXISTS(SELECT 1 FROM public.dispatch_group_members) THEN v_conflicts:=v_conflicts||'"target_members_not_empty"'::jsonb;END IF;
    IF EXISTS(SELECT 1 FROM public.used_order_data) THEN v_conflicts:=v_conflicts||'"target_used_not_empty"'::jsonb;END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_group_members') AS m
    LEFT JOIN public.admins AS a ON a.id=(p_owner#>>ARRAY['admin_map',m.body->>'assigned_by'])::uuid
    WHERE m.body->>'assigned_by' IS NOT NULL AND a.id IS NULL) THEN
    v_conflicts:=v_conflicts||'"unmapped_assigner"'::jsonb;
  END IF;
  RETURN v_plan||jsonb_build_object('can_begin',jsonb_array_length(v_conflicts)=0,'conflicts',v_conflicts);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_dependency_saved(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_n bigint;v_stage record;
BEGIN
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-dependencies-v1';
  IF v_n=0 THEN RETURN NULL;END IF;
  IF v_n<>1 THEN RAISE EXCEPTION 'Mapped dependency state set changed.';END IF;
  SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-dependencies-v1';
  IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>0 OR v_stage.row_count<>1
    OR NOT private.employee_transfer_exact_object(v_stage.payload,ARRAY['plan','admin_map','group_map','identity_map','counts','next_chunks','verified']) THEN
    RAISE EXCEPTION 'Mapped dependency saved state changed.';
  END IF;
  RETURN v_stage.payload;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_dependency_progress(
  p_job private.employee_transfer_jobs,p_owner jsonb,p_state jsonb
) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_plan jsonb;v_key text;v_next integer;v_expected bigint;v_actual bigint;v_rows jsonb;
BEGIN
  IF p_state IS NULL OR NOT private.employee_transfer_exact_object(p_state,
      ARRAY['plan','admin_map','group_map','identity_map','counts','next_chunks','verified'])
    OR NOT private.employee_transfer_exact_object(p_state->'counts',ARRAY['dispatch_group_members','used_order_data'])
    OR NOT private.employee_transfer_exact_object(p_state->'next_chunks',ARRAY['dispatch_group_members','used_order_data'])
    OR jsonb_typeof(p_state->'verified') IS DISTINCT FROM 'boolean'
    OR p_state->'admin_map' IS DISTINCT FROM p_owner->'admin_map'
    OR p_state->'group_map' IS DISTINCT FROM p_owner->'group_map'
    OR p_state->'identity_map' IS DISTINCT FROM p_owner->'identity_map' THEN
    RAISE EXCEPTION 'Begin a bound mapped dependency restore first or inspect changed state.';
  END IF;
  v_plan:=private.employee_transfer_mapped_dependency_plan(p_job,p_owner,true);
  IF v_plan->'can_begin' IS DISTINCT FROM 'true'::jsonb OR p_state->'plan' IS DISTINCT FROM v_plan THEN
    RAISE EXCEPTION 'Mapped dependency saved plan or mapping changed.';
  END IF;
  FOREACH v_key IN ARRAY ARRAY['dispatch_group_members','used_order_data'] LOOP
    IF jsonb_typeof(p_state#>ARRAY['counts',v_key]) IS DISTINCT FROM 'number'
      OR (p_state#>>ARRAY['counts',v_key]) !~ '^(0|[1-9][0-9]{0,5})$'
      OR jsonb_typeof(p_state#>ARRAY['next_chunks',v_key]) IS DISTINCT FROM 'number'
      OR (p_state#>>ARRAY['next_chunks',v_key]) !~ '^(0|[1-9][0-9]{0,5})$' THEN
      RAISE EXCEPTION 'Mapped dependency count or cursor type changed.';
    END IF;
    v_next:=(p_state#>>ARRAY['next_chunks',v_key])::integer;
    IF v_next>(v_plan#>>ARRAY['chunks',v_key])::integer THEN RAISE EXCEPTION 'Mapped dependency cursor exceeds source chunks.';END IF;
    SELECT COALESCE(sum(row_count),0) INTO v_expected FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:'||v_key AND chunk_no<v_next;
    IF v_key='dispatch_group_members' THEN SELECT count(*) INTO v_actual FROM public.dispatch_group_members;
    ELSE SELECT count(*) INTO v_actual FROM public.used_order_data;END IF;
    IF v_expected IS DISTINCT FROM (p_state#>>ARRAY['counts',v_key])::bigint OR v_actual IS DISTINCT FROM v_expected
      OR v_expected>(v_plan#>>ARRAY['totals',v_key])::bigint THEN
      RAISE EXCEPTION 'Mapped dependency committed count changed.';
    END IF;
    FOR v_rows IN SELECT payload->'rows' FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:'||v_key AND chunk_no<v_next ORDER BY chunk_no LOOP
      PERFORM private.employee_transfer_mapped_dependency_check(p_job,v_key,v_rows,p_owner);
    END LOOP;
  END LOOP;
  IF (p_state#>>'{next_chunks,used_order_data}')::integer>0
      AND p_state#>'{next_chunks,dispatch_group_members}' IS DISTINCT FROM v_plan#>'{chunks,dispatch_group_members}' THEN
    RAISE EXCEPTION 'Mapped dependency members must finish before used submission records.';
  END IF;
  IF p_state->'verified'='true'::jsonb AND (p_state->'counts' IS DISTINCT FROM v_plan->'totals'
      OR p_state->'next_chunks' IS DISTINCT FROM v_plan->'chunks') THEN
    RAISE EXCEPTION 'Mapped dependency verified state is incomplete.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_dependency_receipt(p_plan jsonb,p_state jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
  SELECT (p_plan-ARRAY['can_begin','conflicts'])||jsonb_build_object('started',p_state IS NOT NULL,
    'counts',CASE WHEN p_state IS NULL THEN '{"dispatch_group_members":0,"used_order_data":0}'::jsonb ELSE p_state->'counts' END,
    'next_chunks',CASE WHEN p_state IS NULL THEN '{"dispatch_group_members":0,"used_order_data":0}'::jsonb ELSE p_state->'next_chunks' END,
    'verified',CASE WHEN p_state IS NULL THEN 'false'::jsonb ELSE p_state->'verified' END);
$$;

CREATE FUNCTION public.employee_import_mapped_dependency_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_dependency_owner(v_job);
  v_state:=private.employee_transfer_mapped_dependency_saved(v_job);
  IF v_state IS NOT NULL THEN
    PERFORM private.employee_transfer_mapped_dependency_progress(v_job,v_owner,v_state);
    RETURN v_state->'plan';
  END IF;
  RETURN private.employee_transfer_mapped_dependency_plan(v_job,v_owner,false);
END;
$$;

CREATE FUNCTION public.employee_import_mapped_dependency_status(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;v_plan jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_dependency_owner(v_job);
  v_state:=private.employee_transfer_mapped_dependency_saved(v_job);
  IF v_state IS NULL THEN v_plan:=private.employee_transfer_mapped_dependency_plan(v_job,v_owner,false);
  ELSE
    PERFORM private.employee_transfer_mapped_dependency_progress(v_job,v_owner,v_state);
    v_plan:=v_state->'plan';
  END IF;
  RETURN private.employee_transfer_mapped_dependency_receipt(v_plan,v_state);
END;
$$;

CREATE FUNCTION public.employee_import_mapped_dependency_begin(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;v_plan jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_dependency_owner(v_job);
  v_state:=private.employee_transfer_mapped_dependency_saved(v_job);
  IF v_state IS NOT NULL THEN
    PERFORM private.employee_transfer_mapped_dependency_progress(v_job,v_owner,v_state);
    v_plan:=v_state->'plan';
  ELSE v_plan:=private.employee_transfer_mapped_dependency_plan(v_job,v_owner,false);END IF;
  IF p_plan_hash IS NULL OR p_plan_hash !~ '^[0-9a-f]{64}$' OR p_plan_hash IS DISTINCT FROM v_plan->>'plan_hash'
    OR v_plan->'can_begin' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Mapped dependency plan changed or has unresolved conflicts.';
  END IF;
  IF v_state IS NOT NULL THEN RETURN private.employee_transfer_mapped_dependency_receipt(v_plan,v_state);END IF;
  v_state:=jsonb_build_object('plan',v_plan,'admin_map',v_owner->'admin_map','group_map',v_owner->'group_map',
    'identity_map',v_owner->'identity_map','counts','{"dispatch_group_members":0,"used_order_data":0}'::jsonb,
    'next_chunks','{"dispatch_group_members":0,"used_order_data":0}'::jsonb,'verified',false);
  -- begin 只建立技术状态，无业务清空/插入，也不修改旧 summary。
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-dependencies-v1',0,1,v_state);
  PERFORM private.employee_transfer_mapped_dependency_progress(v_job,v_owner,v_state);
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_dependencies_started',
    jsonb_build_object('plan_hash',v_plan->'plan_hash','mapping_hash',v_plan->'mapping_hash','totals',v_plan->'totals','full_site_complete',false));
  RETURN private.employee_transfer_mapped_dependency_receipt(v_plan,v_state);
END;
$$;

CREATE FUNCTION public.employee_import_mapped_dependency_chunk(
  p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;v_rows jsonb;v_row record;
  v_count integer;v_next integer;v_disabled jsonb;v_written integer:=0;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_dependency_owner(v_job);
  v_state:=private.employee_transfer_mapped_dependency_saved(v_job);
  PERFORM private.employee_transfer_mapped_dependency_progress(v_job,v_owner,v_state);
  IF p_table_key IS NULL OR p_table_key NOT IN ('dispatch_group_members','used_order_data') THEN
    RAISE EXCEPTION 'Unsupported mapped dependency table.';
  END IF;
  v_next:=(v_state#>>ARRAY['next_chunks',p_table_key])::integer;
  IF p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>v_next OR p_chunk_no>=(v_state#>>ARRAY['plan','chunks',p_table_key])::integer THEN
    RAISE EXCEPTION 'Mapped dependency chunks must follow the committed cursor.';
  END IF;
  IF p_table_key='used_order_data'
    AND v_state#>'{next_chunks,dispatch_group_members}' IS DISTINCT FROM v_state#>'{plan,chunks,dispatch_group_members}' THEN
    RAISE EXCEPTION 'Restore all mapped members before used submission records.';
  END IF;
  -- 显式重复只在全进度/全部实物核对后返回；不 skip 新冲突，不自动重发。
  IF p_chunk_no<v_next THEN RETURN private.employee_transfer_mapped_dependency_receipt(v_state->'plan',v_state);END IF;
  SELECT payload->'rows',row_count INTO STRICT v_rows,v_count FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='dispatch-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_count NOT BETWEEN 0 AND 200 OR jsonb_array_length(v_rows) IS DISTINCT FROM v_count
    OR (v_state#>>ARRAY['counts',p_table_key])::bigint+v_count>(v_state#>>ARRAY['plan','totals',p_table_key])::bigint THEN
    RAISE EXCEPTION 'Mapped dependency chunk exceeds the bound source.';
  END IF;
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names)
    VALUES(pg_current_xact_id(),v_job.id,ARRAY['public.'||p_table_key]);
  IF p_table_key='used_order_data' THEN
    v_disabled:=private.employee_transfer_bypass_triggers(ARRAY['used_order_data']);
    IF jsonb_array_length(v_disabled)<>1 OR v_disabled#>>'{0,table}' IS DISTINCT FROM 'used_order_data'
      OR v_disabled#>>'{0,trigger}' IS DISTINCT FROM 'trigger_update_valid_data_usage' THEN
      RAISE EXCEPTION 'Unreviewed mapped dependency trigger bypass.';
    END IF;
  END IF;
  FOR v_row IN SELECT * FROM private.employee_transfer_mapped_dependency_rows(v_job,p_table_key,v_rows,v_owner) LOOP
    IF p_table_key='dispatch_group_members' THEN
      INSERT INTO public.dispatch_group_members(id,group_id,user_id,assigned_by,assigned_at)
        SELECT r.id,r.group_id,r.user_id,r.assigned_by,r.assigned_at
        FROM jsonb_populate_record(NULL::public.dispatch_group_members,v_row.body) AS r;
    ELSE
      INSERT INTO public.used_order_data(id,user_id,valid_order_data_id,order_id,created_at)
        SELECT r.id,r.user_id,r.valid_order_data_id,r.order_id,r.created_at
        FROM jsonb_populate_record(NULL::public.used_order_data,v_row.body) AS r;
    END IF;
    v_written:=v_written+1;
  END LOOP;
  IF v_written<>v_count THEN RAISE EXCEPTION 'Mapped dependency row mapping is incomplete.';END IF;
  IF v_disabled IS NOT NULL THEN PERFORM private.employee_transfer_restore_triggers(v_disabled);END IF;
  PERFORM private.employee_transfer_clear_write_permit();
  v_state:=jsonb_set(jsonb_set(v_state,ARRAY['counts',p_table_key],to_jsonb((v_state#>>ARRAY['counts',p_table_key])::integer+v_count)),
    ARRAY['next_chunks',p_table_key],to_jsonb(p_chunk_no+1));
  -- 恢复触发器后再重验配置/valid 计数与时间、全部 SQL49 实物及已提交行。
  v_owner:=private.employee_transfer_mapped_dependency_owner(v_job);
  PERFORM private.employee_transfer_mapped_dependency_progress(v_job,v_owner,v_state);
  UPDATE private.employee_transfer_staging SET payload=v_state WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='mapped-dependencies-v1' AND chunk_no=0;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_dependencies_chunk',
    jsonb_build_object('table_key',p_table_key,'chunk_no',p_chunk_no,'rows',v_count,'full_site_complete',false));
  RETURN private.employee_transfer_mapped_dependency_receipt(v_state->'plan',v_state);
EXCEPTION WHEN OTHERS THEN
  -- PL/pgSQL 子事务先回滚本块 DDL/DML（包含原触发器模式），不假回滚旧块。
  PERFORM private.employee_transfer_clear_write_permit();RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_mapped_dependency_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_state jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_dependency_owner(v_job);
  v_state:=private.employee_transfer_mapped_dependency_saved(v_job);
  PERFORM private.employee_transfer_mapped_dependency_progress(v_job,v_owner,v_state);
  IF v_state->'counts' IS DISTINCT FROM v_state#>'{plan,totals}' OR v_state->'next_chunks' IS DISTINCT FROM v_state#>'{plan,chunks}' THEN
    RAISE EXCEPTION 'Mapped dependency restore is incomplete; empty chunks must also be executed.';
  END IF;
  PERFORM private.employee_transfer_dispatch_source_check();
  IF v_state->'verified' IS DISTINCT FROM 'true'::jsonb THEN
    v_state:=v_state||'{"verified":true}'::jsonb;
    UPDATE private.employee_transfer_staging SET payload=v_state WHERE job_id=v_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='mapped-dependencies-v1' AND chunk_no=0;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','mapped_dependencies_verified',
      jsonb_build_object('plan_hash',v_state#>'{plan,plan_hash}','counts',v_state->'counts','full_site_complete',false));
  END IF;
  RETURN private.employee_transfer_mapped_dependency_receipt(v_state->'plan',v_state);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_mapped_dependency_source(private.employee_transfer_jobs),
  private.employee_transfer_mapped_dependency_map(private.employee_transfer_jobs),
  private.employee_transfer_mapped_dependency_owner(private.employee_transfer_jobs),
  private.employee_transfer_mapped_dependency_rows(private.employee_transfer_jobs,text,jsonb,jsonb),
  private.employee_transfer_mapped_dependency_check(private.employee_transfer_jobs,text,jsonb,jsonb),
  private.employee_transfer_mapped_dependency_plan(private.employee_transfer_jobs,jsonb,boolean),
  private.employee_transfer_mapped_dependency_saved(private.employee_transfer_jobs),
  private.employee_transfer_mapped_dependency_progress(private.employee_transfer_jobs,jsonb,jsonb),
  private.employee_transfer_mapped_dependency_receipt(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.employee_import_mapped_dependency_plan(uuid,uuid),
  public.employee_import_mapped_dependency_status(uuid,uuid),public.employee_import_mapped_dependency_begin(uuid,uuid,text),
  public.employee_import_mapped_dependency_chunk(uuid,uuid,text,integer),public.employee_import_mapped_dependency_verify(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_import_mapped_dependency_plan(uuid,uuid),
  public.employee_import_mapped_dependency_status(uuid,uuid),public.employee_import_mapped_dependency_begin(uuid,uuid,text),
  public.employee_import_mapped_dependency_chunk(uuid,uuid,text,integer),public.employee_import_mapped_dependency_verify(uuid,uuid)
  TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;

-- 未执行 DROP 参考：只移除本阶段接口，不撤销已提交成员/used，不删任务/审计，
-- 不恢复营业；移除 SQL49/48 前须先移除此依赖路径。不要使用 CASCADE。
-- DROP FUNCTION public.employee_import_mapped_dependency_plan(uuid,uuid);
-- DROP FUNCTION public.employee_import_mapped_dependency_status(uuid,uuid);
-- DROP FUNCTION public.employee_import_mapped_dependency_begin(uuid,uuid,text);
-- DROP FUNCTION public.employee_import_mapped_dependency_chunk(uuid,uuid,text,integer);
-- DROP FUNCTION public.employee_import_mapped_dependency_verify(uuid,uuid);
-- DROP FUNCTION private.employee_transfer_mapped_dependency_receipt(jsonb,jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_dependency_progress(private.employee_transfer_jobs,jsonb,jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_dependency_saved(private.employee_transfer_jobs);
-- DROP FUNCTION private.employee_transfer_mapped_dependency_plan(private.employee_transfer_jobs,jsonb,boolean);
-- DROP FUNCTION private.employee_transfer_mapped_dependency_check(private.employee_transfer_jobs,text,jsonb,jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_dependency_rows(private.employee_transfer_jobs,text,jsonb,jsonb);
-- DROP FUNCTION private.employee_transfer_mapped_dependency_owner(private.employee_transfer_jobs);
-- DROP FUNCTION private.employee_transfer_mapped_dependency_map(private.employee_transfer_jobs);
-- DROP FUNCTION private.employee_transfer_mapped_dependency_source(private.employee_transfer_jobs);
