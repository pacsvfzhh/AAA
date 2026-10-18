CREATE FUNCTION private.employee_transfer_dispatch_admin_map(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb; v_count integer;
BEGIN
  SELECT count(DISTINCT admin_map),min(admin_map::text)::jsonb INTO v_count,v_map
    FROM private.employee_transfer_jobs WHERE admin_id=p_job.admin_id AND kind='import'
      AND options->>'import_protocol'='shared-import-v1' AND options->>'replace_policy'='source-v1'
      AND options->'package_id'=p_job.options->'package_id'
      AND options#>>'{catalog,site_id}'=p_job.options#>>'{catalog,site_id}'
      AND summary->'shared_applied'='true'::jsonb AND summary->'shared_receipt'->'admin_map'=admin_map;
  IF v_count<>1 OR v_map IS NULL OR EXISTS(
    SELECT 1 FROM (
      SELECT body->>'created_by' AS source_id FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups') UNION
      SELECT body->>'created_by' FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_order_pools') UNION
      SELECT body->>'created_by' FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_group_orders')
    ) AS refs LEFT JOIN public.admins AS admin ON admin.id=(v_map->>refs.source_id)::uuid
    WHERE refs.source_id IS NOT NULL AND admin.id IS NULL
  ) THEN RAISE EXCEPTION 'A matching server-verified shared administrator import receipt is required.'; END IF;
  RETURN v_map;
END;
$$;

CREATE FUNCTION private.employee_transfer_dispatch_config_plan(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb; v_groups jsonb:='{}'; v_pools jsonb:='{}'; v_row record; v_id uuid; v_default uuid;
  v_group uuid; v_plan jsonb; v_conflicts jsonb:='[]';
BEGIN
  PERFORM private.employee_transfer_dispatch_schema();
  PERFORM private.employee_transfer_dispatch_check_input(p_job);
  v_map:=private.employee_transfer_dispatch_admin_map(p_job);
  SELECT id INTO v_default FROM public.dispatch_groups WHERE is_default;
  FOR v_row IN SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups')
    ORDER BY COALESCE((body->>'is_default')::boolean,false) DESC,id LOOP
    v_id:=NULL;
    IF (v_row.body->>'is_default')::boolean THEN v_id:=v_default;
    ELSE
      SELECT id INTO v_id FROM public.dispatch_groups WHERE id=v_row.id
        AND id::text NOT IN(SELECT value FROM jsonb_each_text(v_groups));
      IF v_id IS NULL THEN
        SELECT id INTO v_id FROM public.dispatch_groups WHERE group_name=v_row.body->>'group_name'
          AND id::text NOT IN(SELECT value FROM jsonb_each_text(v_groups));
      END IF;
    END IF;
    v_id:=COALESCE(v_id,v_row.id);
    IF v_id::text IN(SELECT value FROM jsonb_each_text(v_groups)) THEN
      v_conflicts:=v_conflicts||jsonb_build_array('group_mapping_collision');
    END IF;
    v_groups:=v_groups||jsonb_build_object(v_row.id::text,v_id);
  END LOOP;
  FOR v_row IN SELECT * FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_order_pools') ORDER BY id LOOP
    v_group:=(v_groups->>(v_row.body->>'group_id'))::uuid; v_id:=NULL;
    IF (v_row.body->>'is_base')::boolean THEN
      SELECT id INTO v_id FROM public.dispatch_order_pools WHERE group_id=v_group AND is_base;
    ELSIF EXISTS(SELECT 1 FROM public.dispatch_order_pools WHERE id=v_row.id AND group_id=v_group AND NOT is_base) THEN
      v_id:=v_row.id;
    END IF;
    v_id:=COALESCE(v_id,v_row.id);
    IF EXISTS(SELECT 1 FROM public.dispatch_order_pools WHERE id=v_id
      AND (group_id<>v_group OR is_base IS DISTINCT FROM (v_row.body->>'is_base')::boolean))
      OR v_id::text IN(SELECT value FROM jsonb_each_text(v_pools)) THEN
      v_conflicts:=v_conflicts||jsonb_build_array('pool_mapping_collision');
    END IF;
    v_pools:=v_pools||jsonb_build_object(v_row.id::text,v_id);
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_groups')
    WHERE body->>'group_name' LIKE 'transfer-retired-%') OR EXISTS(
    SELECT 1 FROM private.employee_transfer_dispatch_input(p_job.id,'dispatch_order_pools')
    WHERE body->>'pool_name' LIKE 'transfer-retired-%') THEN
    v_conflicts:=v_conflicts||jsonb_build_array('reserved_retirement_name');
  END IF;
  v_plan:=jsonb_build_object('scope','dispatch-configuration','can_apply_configuration',jsonb_array_length(v_conflicts)=0,
    'full_site_complete',false,'replacement_ready',false,'conflicts',v_conflicts,'group_map',v_groups,'pool_map',v_pools,
    'admin_map',v_map,'package_id',p_job.options->'package_id','catalog',p_job.options->'catalog',
    'preparation_plan_hash',p_job.summary->'dispatch_plan_hash');
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(v_plan::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_transfer_write_dispatch_config_row(p_key text,p_row jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_columns text; v_updates text;
BEGIN
  IF p_key NOT IN ('dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders') THEN
    RAISE EXCEPTION 'Unsupported dispatch configuration table.';
  END IF;
  PERFORM private.employee_transfer_check_dispatch_row(p_key,p_row);
  SELECT string_agg(format('%I',key),',' ORDER BY key COLLATE "C"),
    string_agg(format('%I=EXCLUDED.%I',key,key),',' ORDER BY key COLLATE "C") FILTER(WHERE key<>'id')
    INTO v_columns,v_updates FROM jsonb_each(private.employee_transfer_dispatch_spec()->p_key);
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) AS r ON CONFLICT(id) DO UPDATE SET %s',
    p_key,v_columns,v_columns,p_key,v_updates) USING p_row;
END;
$$;

DO $install_config_audit$
DECLARE v_expected jsonb; v_names jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname) ORDER BY c.relname,t.tgname) INTO v_names
    FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid
    WHERE c.relnamespace='public'::regnamespace AND c.relname IN
      ('dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders','dispatch_group_members') AND NOT t.tgisinternal;
  IF v_names IS DISTINCT FROM '[
    ["dispatch_config","zz_employee_transfer_maintenance"],
    ["dispatch_group_members","zz_employee_transfer_maintenance"],
    ["dispatch_group_orders","trigger_check_pool_health_on_deactivate"],
    ["dispatch_group_orders","zz_employee_transfer_maintenance"],
    ["dispatch_groups","create_dispatch_base_pool"],
    ["dispatch_groups","zz_employee_transfer_maintenance"],
    ["dispatch_order_pools","guard_dispatch_pool_base"],
    ["dispatch_order_pools","guard_weighted_dispatch_pool_archive"],
    ["dispatch_order_pools","zz_employee_transfer_maintenance"]]'::jsonb THEN RAISE EXCEPTION 'Unreviewed dispatch configuration triggers.'; END IF;
  SELECT jsonb_object_agg(c.relname||'.'||t.tgname,jsonb_build_object('mode',t.tgenabled::text,'digest',private.employee_transfer_trigger_digest(t.oid)))
    INTO v_expected FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid
    WHERE c.relnamespace='public'::regnamespace AND c.relname IN
      ('dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders','dispatch_group_members') AND NOT t.tgisinternal;
  EXECUTE format($definition$
    CREATE FUNCTION private.employee_transfer_assert_dispatch_config_triggers()
    RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, private, pg_temp AS $body$
    DECLARE v_expected constant jsonb:=%L::jsonb; v_actual jsonb;
    BEGIN
      PERFORM private.employee_transfer_assert_maintenance_guards();
      SELECT jsonb_object_agg(c.relname||'.'||t.tgname,jsonb_build_object('mode',t.tgenabled::text,'digest',private.employee_transfer_trigger_digest(t.oid)))
        INTO v_actual FROM pg_trigger AS t JOIN pg_class AS c ON c.oid=t.tgrelid
        WHERE c.relnamespace='public'::regnamespace AND c.relname IN
          ('dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders','dispatch_group_members') AND NOT t.tgisinternal;
      IF v_actual IS DISTINCT FROM v_expected OR EXISTS(SELECT 1 FROM jsonb_each(v_actual) WHERE value->>'mode' NOT IN ('O','A')) THEN
        RAISE EXCEPTION 'Unreviewed dispatch configuration triggers.';
      END IF;
    END;
    $body$;
  $definition$,v_expected::text);
END;
$install_config_audit$;

CREATE FUNCTION public.get_employee_import_dispatch_configuration_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_plan jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  PERFORM private.employee_transfer_assert_dispatch_config_triggers();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance WHERE job_id=v_job.id AND NOT dirty) THEN
    RAISE EXCEPTION 'Clean owner maintenance is required before planning configuration restore.';
  END IF;
  v_plan:=private.employee_transfer_dispatch_config_plan(v_job);
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('dispatch_config_plan',v_plan) WHERE id=v_job.id;
  RETURN v_plan-ARRAY['admin_map','catalog','package_id'];
END;
$$;

CREATE FUNCTION public.employee_import_dispatch_apply_configuration(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_plan jsonb; v_row record; v_body jsonb;
  v_key text; v_id uuid; v_group uuid; v_auto_base uuid; v_receipt jsonb; v_query text; v_bad boolean;
  v_maintenance private.employee_transfer_maintenance%ROWTYPE;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  PERFORM private.employee_transfer_assert_dispatch_config_triggers();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  SELECT * INTO v_maintenance FROM private.employee_transfer_maintenance WHERE job_id=v_job.id AND admin_id=v_job.admin_id;
  IF v_maintenance.singleton IS NULL THEN RAISE EXCEPTION 'Owner maintenance is required for configuration restore.'; END IF;
  IF COALESCE((v_job.summary->>'dispatch_configuration_applied')::boolean,false) THEN
    IF p_plan_hash IS DISTINCT FROM v_job.summary#>>'{dispatch_config_plan,plan_hash}' THEN RAISE EXCEPTION 'Configuration confirmation does not match.'; END IF;
    RETURN v_job.summary->'dispatch_configuration_receipt'||'{"repeated":true}'::jsonb;
  END IF;
  IF v_maintenance.dirty OR p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_job.summary#>>'{dispatch_config_plan,plan_hash}' THEN
    RAISE EXCEPTION 'A clean maintenance configuration plan must be confirmed first.';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_shared_backups WHERE id=v_job.id AND sealed_at IS NOT NULL
    AND plan_hash=v_maintenance.plan_hash AND target_hash=v_maintenance.target_hash) OR
    encode(extensions.digest(convert_to(private.employee_transfer_dispatch_target(p_admin_session_token)::text,'UTF8'),'sha256'),'hex') IS DISTINCT FROM v_maintenance.target_hash THEN
    RAISE EXCEPTION 'The sealed configuration target changed.';
  END IF;
  v_plan:=private.employee_transfer_dispatch_config_plan(v_job);
  IF v_plan IS DISTINCT FROM v_job.summary->'dispatch_config_plan' OR NOT (v_plan->>'can_apply_configuration')::boolean THEN
    RAISE EXCEPTION 'The configuration plan changed or contains conflicts.';
  END IF;
  PERFORM private.employee_transfer_allow_config_write(v_job.id);
  DELETE FROM public.dispatch_group_members;
  DELETE FROM public.dispatch_group_orders;
  UPDATE public.dispatch_groups SET group_name='transfer-retired-'||id::text,is_default=false,is_active=false,
    archived_at=COALESCE(archived_at,clock_timestamp()),pool_selection_mode='base';
  UPDATE public.dispatch_order_pools SET pool_name='transfer-retired-'||id::text,is_active=false,trigger_probability=0;
  UPDATE public.dispatch_order_pools SET archived_at=COALESCE(archived_at,clock_timestamp()) WHERE NOT is_base;
  DELETE FROM public.dispatch_config;
  FOR v_row IN SELECT * FROM private.employee_transfer_dispatch_input(v_job.id,'dispatch_groups') ORDER BY id LOOP
    v_body:=v_row.body||jsonb_build_object('id',v_plan->'group_map'->v_row.id::text,
      'created_by',v_plan->'admin_map'->(v_row.body->>'created_by'));
    PERFORM private.employee_transfer_write_dispatch_config_row('dispatch_groups',v_body);
  END LOOP;
  FOR v_row IN SELECT * FROM private.employee_transfer_dispatch_input(v_job.id,'dispatch_order_pools')
    ORDER BY (body->>'is_base')::boolean DESC,id LOOP
    v_id:=(v_plan->'pool_map'->>v_row.id::text)::uuid; v_group:=(v_plan->'group_map'->>(v_row.body->>'group_id'))::uuid;
    IF (v_row.body->>'is_base')::boolean THEN
      SELECT id INTO v_auto_base FROM public.dispatch_order_pools WHERE group_id=v_group AND is_base;
      IF v_auto_base IS NULL THEN RAISE EXCEPTION 'The source base pool has no target placeholder.'; END IF;
      IF v_auto_base<>v_id THEN UPDATE public.dispatch_order_pools SET id=v_id WHERE id=v_auto_base; END IF;
    END IF;
    v_body:=v_row.body||jsonb_build_object('id',v_id,'group_id',v_group,'created_by',v_plan->'admin_map'->(v_row.body->>'created_by'));
    PERFORM private.employee_transfer_write_dispatch_config_row('dispatch_order_pools',v_body);
  END LOOP;
  FOR v_row IN SELECT * FROM private.employee_transfer_dispatch_input(v_job.id,'dispatch_group_orders') ORDER BY id LOOP
    v_body:=v_row.body||jsonb_build_object('group_id',v_plan->'group_map'->(v_row.body->>'group_id'),
      'pool_id',v_plan->'pool_map'->(v_row.body->>'pool_id'),'created_by',v_plan->'admin_map'->(v_row.body->>'created_by'));
    PERFORM private.employee_transfer_write_dispatch_config_row('dispatch_group_orders',v_body);
  END LOOP;
  FOR v_row IN SELECT * FROM private.employee_transfer_dispatch_input(v_job.id,'dispatch_config') ORDER BY id LOOP
    PERFORM private.employee_transfer_write_dispatch_config_row('dispatch_config',v_row.body);
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['dispatch_config','dispatch_groups','dispatch_order_pools','dispatch_group_orders'] LOOP
    v_query:=private.employee_transfer_dispatch_query(v_key);
    FOR v_row IN SELECT * FROM private.employee_transfer_dispatch_input(v_job.id,v_key) LOOP
      v_body:=v_row.body;
      IF v_key='dispatch_groups' THEN v_body:=v_body||jsonb_build_object('id',v_plan->'group_map'->v_row.id::text);
      ELSIF v_key='dispatch_order_pools' THEN v_body:=v_body||jsonb_build_object('id',v_plan->'pool_map'->v_row.id::text,'group_id',v_plan->'group_map'->(v_body->>'group_id'));
      ELSIF v_key='dispatch_group_orders' THEN v_body:=v_body||jsonb_build_object('group_id',v_plan->'group_map'->(v_body->>'group_id'),'pool_id',v_plan->'pool_map'->(v_body->>'pool_id'));
      END IF;
      IF v_key<>'dispatch_config' THEN v_body:=v_body||jsonb_build_object('created_by',v_plan->'admin_map'->(v_body->>'created_by')); END IF;
      EXECUTE 'SELECT NOT EXISTS(SELECT 1 FROM ('||v_query||') AS r WHERE id=$1 AND body=$2)' INTO v_bad USING (v_body->>'id')::uuid,v_body;
      IF v_bad THEN RAISE EXCEPTION 'Source dispatch configuration post-write verification failed.'; END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM public.dispatch_groups WHERE (is_default OR is_active OR archived_at IS NULL)
      AND id::text NOT IN(SELECT value FROM jsonb_each_text(v_plan->'group_map')))
    OR EXISTS(SELECT 1 FROM public.dispatch_order_pools WHERE is_active AND archived_at IS NULL
      AND id::text NOT IN(SELECT value FROM jsonb_each_text(v_plan->'pool_map')))
    OR (SELECT count(*) FROM public.dispatch_group_orders)<>(v_job.options#>>'{catalog,tables,3,rows}')::bigint
    OR EXISTS(SELECT 1 FROM public.dispatch_group_members) THEN RAISE EXCEPTION 'Target dispatch residuals remain available.'; END IF;
  PERFORM private.employee_transfer_dispatch_source_check();
  PERFORM private.employee_transfer_clear_write_permit();
  v_receipt:=jsonb_build_object('success',true,'scope','dispatch-configuration','configuration_applied',true,
    'maintenance',true,'dependencies_pending',true,'replacement_ready',false,'full_site_complete',false,'repeated',false,
    'group_map',v_plan->'group_map','pool_map',v_plan->'pool_map');
  UPDATE private.employee_transfer_jobs SET group_map=v_plan->'group_map',summary=summary||jsonb_build_object(
    'dispatch_configuration_applied',true,'dispatch_configuration_receipt',v_receipt) WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','dispatch_configuration_applied',
    jsonb_build_object('backup_id',v_job.id,'groups',(SELECT count(*) FROM jsonb_each(v_plan->'group_map')),'full_site_complete',false));
  RETURN v_receipt;
EXCEPTION WHEN OTHERS THEN
  PERFORM private.employee_transfer_clear_write_permit();
  RAISE;
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',v_function);
  END LOOP;
  REVOKE ALL ON FUNCTION public.get_employee_import_dispatch_configuration_plan(uuid,uuid),public.employee_import_dispatch_apply_configuration(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
  GRANT EXECUTE ON FUNCTION public.get_employee_import_dispatch_configuration_plan(uuid,uuid),public.employee_import_dispatch_apply_configuration(uuid,uuid,text) TO anon,authenticated;
END;
$$;
NOTIFY pgrst,'reload schema';
