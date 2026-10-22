BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION private.employee_transfer_mapped_notifications_input(p_job_id uuid,p_key text)
RETURNS TABLE(id text,body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
BEGIN
  PERFORM private.employee_transfer_notifications_relation(p_key);
  RETURN QUERY SELECT r.value->>'id',r.value FROM private.employee_transfer_staging s
    CROSS JOIN LATERAL jsonb_array_elements(s.payload->'rows') r(value)
    WHERE s.job_id=p_job_id AND s.employee_id='00000000-0000-0000-0000-000000000000'
      AND s.table_key='mapped-notifications-in:'||p_key;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_notifications_catalog(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_n bigint;v_stage record;
BEGIN
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-notifications-catalog-v1';
  IF v_n=0 THEN RETURN NULL;END IF;
  IF v_n<>1 THEN RAISE EXCEPTION 'Mapped notifications catalog state changed.';END IF;
  SELECT * INTO STRICT v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='mapped-notifications-catalog-v1';
  IF v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>0 OR v_stage.row_count<>1 THEN
    RAISE EXCEPTION 'Mapped notifications catalog namespace changed.';
  END IF;
  PERFORM private.employee_transfer_check_notifications_catalog(v_stage.payload);
  IF v_stage.payload->'identity_catalog' IS DISTINCT FROM p_job.summary->'identity_catalog'
    OR v_stage.payload->'finance_catalog' IS DISTINCT FROM private.employee_transfer_mapped_finance_catalog(p_job)
    OR v_stage.payload->'site_id' IS DISTINCT FROM p_job.options#>'{catalog,site_id}'
    OR v_stage.payload->'package_id' IS DISTINCT FROM p_job.options->'package_id' THEN
    RAISE EXCEPTION 'Mapped notifications source binding changed.';
  END IF;
  RETURN v_stage.payload;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_notifications_parse(p_key text,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_line text;v_json json;v_rows jsonb:='[]';v_hashes text:='';v_last text;
BEGIN
  PERFORM private.employee_transfer_notifications_relation(p_key);
  IF p_ndjson IS NULL OR octet_length(p_ndjson)>262144 OR (p_ndjson<>'' AND right(p_ndjson,1)<>E'\n') THEN
    RAISE EXCEPTION 'Invalid mapped notifications chunk.';
  END IF;
  IF p_ndjson<>'' THEN
    FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson,length(p_ndjson)-1),E'\n')) r(line) LOOP
      IF octet_length(v_line)+1>65536 THEN RAISE EXCEPTION 'Mapped notifications row exceeds limits.';END IF;
      v_json:=v_line::json;
      IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN
        RAISE EXCEPTION 'Invalid mapped notifications JSON.';
      END IF;
      PERFORM private.employee_transfer_check_notifications_row(p_key,v_json::jsonb);
      IF v_last COLLATE "C">=(v_json->>'id') COLLATE "C" THEN RAISE EXCEPTION 'Mapped notifications row order changed.';END IF;
      v_last:=v_json->>'id';v_rows:=v_rows||jsonb_build_array(v_json::jsonb);
      IF jsonb_array_length(v_rows)>200 THEN RAISE EXCEPTION 'Mapped notifications chunk exceeds limits.';END IF;
      v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ndjson',p_ndjson,'rows',v_rows,'bytes',octet_length(p_ndjson),'row_hashes',v_hashes,'last_id',v_last);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_notifications_source(p_job private.employee_transfer_jobs,p_complete boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_catalog jsonb;v_table jsonb;v_key text;v_stage record;v_payload jsonb;v_chunks integer;v_rows bigint;v_bytes bigint;
  v_hashes text;v_hash text;v_last text;v_first text;v_total bigint:=0;v_tables jsonb:='[]';v_complete boolean:=true;v_done boolean;
BEGIN
  v_catalog:=private.employee_transfer_mapped_notifications_catalog(p_job);
  IF v_catalog IS NULL AND p_complete THEN RAISE EXCEPTION 'Bind a mapped notifications catalog first.';END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP
    SELECT value INTO v_table FROM jsonb_array_elements(v_catalog->'tables') WHERE value->>'key'=v_key;
    v_chunks:=0;v_rows:=0;v_bytes:=0;v_hashes:='';v_last:=NULL;
    FOR v_stage IN SELECT * FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND table_key='mapped-notifications-in:'||v_key ORDER BY chunk_no LOOP
      IF v_catalog IS NULL OR v_stage.employee_id<>'00000000-0000-0000-0000-000000000000' OR v_stage.chunk_no<>v_chunks
        OR v_stage.row_count NOT BETWEEN 0 AND 200 OR NOT private.employee_transfer_exact_object(v_stage.payload,
          ARRAY['ndjson','rows','bytes','row_hashes','last_id']) OR jsonb_typeof(v_stage.payload->'ndjson') IS DISTINCT FROM 'string'
        OR jsonb_typeof(v_stage.payload->'bytes') IS DISTINCT FROM 'number'
        OR (v_stage.payload->>'bytes') !~ '^(0|[1-9][0-9]{0,5})$' THEN
        RAISE EXCEPTION 'Mapped notifications source namespace changed.';
      END IF;
      v_payload:=private.employee_transfer_mapped_notifications_parse(v_key,v_stage.payload->>'ndjson');
      IF v_payload IS DISTINCT FROM v_stage.payload OR jsonb_array_length(v_payload->'rows')<>v_stage.row_count
        OR (v_stage.row_count=0 AND (v_chunks<>0 OR v_table->'rows' IS DISTINCT FROM '0'::jsonb)) THEN
        RAISE EXCEPTION 'Mapped notifications source raw rows or hashes changed.';
      END IF;
      v_first:=v_payload#>>'{rows,0,id}';
      IF v_last COLLATE "C">=v_first COLLATE "C" THEN RAISE EXCEPTION 'Mapped notifications source chunk order changed.';END IF;
      v_last:=v_payload->>'last_id';v_chunks:=v_chunks+1;v_rows:=v_rows+v_stage.row_count;
      v_bytes:=v_bytes+(v_payload->>'bytes')::bigint;v_hashes:=v_hashes||(v_payload->>'row_hashes');
    END LOOP;
    v_total:=v_total+v_bytes;v_hash:=encode(extensions.digest(convert_to(v_hashes,'UTF8'),'sha256'),'hex');
    IF v_rows>COALESCE((v_table->>'rows')::bigint,0) OR v_bytes>COALESCE((v_table->>'bytes')::bigint,0)
      OR v_rows>500000 OR v_bytes>268435456 OR v_total>1073741824 OR (v_rows=0 AND v_chunks>1)
      OR (v_catalog IS NOT NULL AND v_chunks>0 AND v_rows=(v_table->>'rows')::bigint
        AND (v_bytes<>(v_table->>'bytes')::bigint OR v_hash IS DISTINCT FROM v_table->>'row_hashes_sha256'))
      OR (v_catalog IS NOT NULL AND v_rows<(v_table->>'rows')::bigint AND v_bytes>=(v_table->>'bytes')::bigint) THEN
      RAISE EXCEPTION 'Mapped notifications source exceeds or differs from catalog.';
    END IF;
    v_done:=v_catalog IS NOT NULL AND v_chunks>0 AND v_rows=(v_table->>'rows')::bigint
      AND v_bytes=(v_table->>'bytes')::bigint AND v_hash=v_table->>'row_hashes_sha256';
    v_complete:=v_complete AND v_done;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'chunks',v_chunks,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
  END LOOP;
  IF p_complete AND NOT v_complete THEN RAISE EXCEPTION 'Mapped notifications source directory is incomplete.';END IF;
  RETURN jsonb_build_object('tables',v_tables,'complete',v_complete);
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_notifications_context(p_job private.employee_transfer_jobs,p_complete boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_owner jsonb;v_verification jsonb;v_catalog jsonb;v_source jsonb;
BEGIN
  v_owner:=private.employee_transfer_mapped_verification_context(p_job,true);v_verification:=v_owner->'state';
  IF v_verification IS NULL OR v_verification->'verified' IS DISTINCT FROM 'true'::jsonb
    OR v_verification->'completed_employees' IS DISTINCT FROM v_verification#>'{plan,employees}' THEN
    RAISE EXCEPTION 'Complete verified mapped verification is required for notifications.';
  END IF;
  PERFORM private.employee_transfer_notification_restore_assert();
  IF p_job.summary ?| ARRAY['notifications_catalog','notifications_plan','notification_restore','notification_media_files','notification_storage_origin']
    OR EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND (table_key LIKE 'notifications-%' OR table_key LIKE 'notification-%'))
    OR EXISTS(SELECT 1 FROM private.employee_transfer_notification_backups WHERE job_id=p_job.id) THEN
    RAISE EXCEPTION 'Legacy notification restore cannot be mixed with mapped notifications.';
  END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key LIKE 'mapped-notifications%'
    AND table_key<>'mapped-notifications-catalog-v1' AND table_key<>ALL(ARRAY(SELECT 'mapped-notifications-in:'||k
      FROM unnest(private.employee_transfer_notifications_keys()) k))) THEN
    RAISE EXCEPTION 'Mapped notifications namespace changed.';
  END IF;
  v_catalog:=private.employee_transfer_mapped_notifications_catalog(p_job);
  v_source:=private.employee_transfer_mapped_notifications_source(p_job,p_complete);
  RETURN v_owner||jsonb_build_object('catalog',v_catalog,'source',v_source,'verification_plan',v_verification->'plan',
    'mapping_hash',encode(extensions.digest(convert_to(jsonb_build_object('verification_plan',v_verification->'plan',
      'identity_map',v_owner->'identity_map','admin_map',v_owner->'admin_map')::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_notifications_source_issues(p_job private.employee_transfer_jobs,p_map jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_issues jsonb:='[]';v_key text;v_field text;v_edge jsonb;v_bad boolean;
BEGIN
  FOR v_key,v_field IN SELECT * FROM (VALUES
    ('notification_automation_plan_members','user_id'),('notification_automation_task_recipients','user_id'),
    ('notification_automation_progress','user_id'),('notification_automation_executions','user_id'),
    ('notification_automation_failures','user_id'),('message_recipients','recipient_id'),('broadcast_recipients','employee_id')) f(k,c) LOOP
    IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,v_key) n
      LEFT JOIN private.employee_transfer_identity_input(p_job.id,'accounts') a ON a.id::text=n.body->>v_field
      WHERE n.body->>v_field IS NOT NULL AND a.id IS NULL) THEN v_issues:=v_issues||'"source_employee_missing"'::jsonb;EXIT;END IF;
  END LOOP;
  FOR v_key,v_field IN SELECT * FROM (VALUES
    ('notification_automation_plans','owner_admin_id'),('notification_automation_tasks','owner_admin_id'),
    ('notification_automation_executions','owner_admin_id'),('notification_automation_failures','owner_admin_id'),
    ('messages','sender_id'),('message_templates','admin_id'),('broadcast_messages','admin_id'),('broadcast_messages','target_admin_id')) f(k,c) LOOP
    IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,v_key)
      WHERE body->>v_field IS NOT NULL AND p_map->>(body->>v_field) IS NULL) THEN v_issues:=v_issues||'"source_admin_unmapped"'::jsonb;EXIT;END IF;
  END LOOP;
  FOR v_edge IN SELECT value FROM jsonb_array_elements('[
    ["notification_automation_tasks","plan_id","notification_automation_plans"],
    ["notification_automation_tasks","source_task_id","notification_automation_tasks"],
    ["notification_automation_plan_members","plan_id","notification_automation_plans"],
    ["notification_automation_task_recipients","task_id","notification_automation_tasks"],
    ["notification_automation_progress","task_id","notification_automation_tasks"],
    ["notification_automation_executions","task_id","notification_automation_tasks"],
    ["notification_automation_executions","plan_id","notification_automation_plans"],
    ["notification_automation_executions","message_id","messages"],
    ["notification_automation_failures","task_id","notification_automation_tasks"],
    ["notification_automation_date_runs","task_id","notification_automation_tasks"],
    ["messages","automation_execution_id","notification_automation_executions"],
    ["message_recipients","message_id","messages"],
    ["broadcast_recipients","broadcast_id","broadcast_messages"]
  ]'::jsonb) LOOP
    IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,v_edge->>0) n
      LEFT JOIN private.employee_transfer_mapped_notifications_input(p_job.id,v_edge->>2) parent ON parent.id=n.body->>(v_edge->>1)
      WHERE n.body->>(v_edge->>1) IS NOT NULL AND parent.id IS NULL) THEN v_issues:=v_issues||'"source_reference_missing"'::jsonb;EXIT;END IF;
  END LOOP;
  IF EXISTS(WITH tasks AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_tasks')),
      plans AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_plans')),
      accounts AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_identity_input(p_job.id,'accounts'))
    SELECT 1 FROM tasks t JOIN plans p ON p.id=t.body->>'plan_id' WHERE t.body->'owner_admin_id' IS DISTINCT FROM p.body->'owner_admin_id'
    UNION ALL SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_plan_members') m
      JOIN plans p ON p.id=m.body->>'plan_id' JOIN accounts a ON a.id::text=m.body->>'user_id'
      WHERE p_map->>(p.body->>'owner_admin_id') IS DISTINCT FROM p_map->>(a.body->>'created_by')
    UNION ALL SELECT 1 FROM (
      SELECT body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_task_recipients')
      UNION ALL SELECT body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_progress')
      UNION ALL SELECT body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_failures')
    ) r JOIN tasks t ON t.id=r.body->>'task_id' JOIN accounts a ON a.id::text=r.body->>'user_id'
      WHERE p_map->>(t.body->>'owner_admin_id') IS DISTINCT FROM p_map->>(a.body->>'created_by')
        OR (r.body ? 'owner_admin_id' AND r.body->'owner_admin_id' IS DISTINCT FROM t.body->'owner_admin_id')) THEN
    v_issues:=v_issues||'"source_scope_mismatch"'::jsonb;
  END IF;
  IF EXISTS(WITH executions AS MATERIALIZED(SELECT body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_executions')),
      tasks AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_tasks')),
      plans AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_plans')),
      accounts AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_identity_input(p_job.id,'accounts'))
    SELECT 1 FROM executions e JOIN tasks t ON t.id=e.body->>'task_id'
      WHERE e.body->>'owner_admin_id' IS NOT NULL AND e.body->'owner_admin_id' IS DISTINCT FROM t.body->'owner_admin_id'
    UNION ALL SELECT 1 FROM executions e JOIN plans p ON p.id=e.body->>'plan_id'
      WHERE e.body->>'owner_admin_id' IS NOT NULL AND e.body->'owner_admin_id' IS DISTINCT FROM p.body->'owner_admin_id'
    UNION ALL SELECT 1 FROM executions e JOIN accounts a ON a.id::text=e.body->>'user_id'
      WHERE e.body->>'owner_admin_id' IS NOT NULL AND p_map->>(e.body->>'owner_admin_id') IS DISTINCT FROM p_map->>(a.body->>'created_by')) THEN
    v_issues:=v_issues||'"source_scope_mismatch"'::jsonb;
  END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_plans') GROUP BY p_map->>(body->>'owner_admin_id'),lower(body->>'name') HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_tasks') GROUP BY p_map->>(body->>'owner_admin_id'),body->>'plan_id',body->>'name',body->>'is_shared_template' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,'message_templates') GROUP BY p_map->>(body->>'admin_id'),body->>'name' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,'message_recipients') GROUP BY body->>'message_id',body->>'recipient_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,'broadcast_recipients') GROUP BY body->>'broadcast_id',body->>'employee_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_executions') WHERE body->>'task_id' IS NOT NULL AND body->>'user_id' IS NOT NULL
      GROUP BY body->>'task_id',body->>'task_version',body->>'user_id',body->>'period_key',body->>'stage' HAVING count(*)>1) THEN
    v_issues:=v_issues||'"source_unique_collision"'::jsonb;
  END IF;
  WITH messages AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'messages')),
    recipients AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'message_recipients')),
    executions AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_executions')),
    bonuses AS MATERIALIZED(SELECT id,body FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_transactions') WHERE body->>'type'='performance_bonus')
  SELECT EXISTS(
    SELECT 1 FROM bonuses b LEFT JOIN recipients r ON r.id=b.body->>'reference_id' LEFT JOIN messages m ON m.id=r.body->>'message_id'
      WHERE r.id IS NULL OR m.id IS NULL OR b.body->'user_id' IS DISTINCT FROM r.body->'recipient_id'
        OR m.body->>'notification_category' IS DISTINCT FROM 'performance_reward' OR b.body->'amount' IS DISTINCT FROM m.body->'reward_amount'
    UNION ALL SELECT 1 FROM messages m JOIN recipients r ON r.body->>'message_id'=m.id LEFT JOIN bonuses b ON b.body->>'reference_id'=r.id
      WHERE m.body->>'notification_category'='performance_reward' AND (b.id IS NULL OR b.body->'user_id' IS DISTINCT FROM r.body->'recipient_id' OR b.body->'amount' IS DISTINCT FROM m.body->'reward_amount')
    UNION ALL SELECT 1 FROM messages m LEFT JOIN executions e ON e.id=m.body->>'automation_execution_id'
      WHERE (m.body->>'audit_origin'='automation' AND m.body->>'automation_execution_id' IS NULL)
        OR (m.body->>'automation_execution_id' IS NOT NULL AND (e.id IS NULL OR m.body->>'audit_origin'<>'automation' OR e.body->>'message_id' IS DISTINCT FROM m.id))
        OR (m.body->>'notification_category'='performance_reward' AND ((m.body->>'reward_amount')::numeric IS NULL OR (m.body->>'reward_amount')::numeric<=0 OR m.body->>'reward_currency' IS NULL
          OR NOT EXISTS(SELECT 1 FROM recipients r WHERE r.body->>'message_id'=m.id)))
    UNION ALL SELECT 1 FROM executions e LEFT JOIN messages m ON m.id=e.body->>'message_id'
      LEFT JOIN recipients r ON r.body->>'message_id'=m.id AND r.body->'recipient_id'=e.body->'user_id'
      LEFT JOIN bonuses b ON b.id=e.body->>'wallet_transaction_id'
      WHERE (e.body->>'wallet_transaction_id' IS NOT NULL AND (b.id IS NULL OR b.body->'user_id' IS DISTINCT FROM e.body->'user_id'
          OR b.body->'amount' IS DISTINCT FROM e.body->'reward_amount' OR b.body->>'reference_id' IS DISTINCT FROM r.id OR b.body->>'operation_id' IS DISTINCT FROM e.id))
        OR (e.body->>'status'='succeeded' AND (m.id IS NULL OR r.id IS NULL OR m.body->>'automation_execution_id' IS DISTINCT FROM e.id
          OR m.body->'sender_id' IS DISTINCT FROM e.body->'owner_admin_id' OR m.body->'reward_amount' IS DISTINCT FROM e.body->'reward_amount'
          OR m.body->'reward_currency' IS DISTINCT FROM e.body->'reward_currency'
          OR (e.body->>'reward_amount' IS NOT NULL AND b.id IS NULL)
          OR (SELECT count(*) FROM recipients x WHERE x.body->>'message_id'=m.id)<>1))
  ) INTO v_bad;
  IF v_bad THEN v_issues:=v_issues||'"reward_link_mismatch"'::jsonb;END IF;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_executions') WHERE body->>'status'='processing') THEN
    v_issues:=v_issues||'"unfinished_execution"'::jsonb;
  END IF;
  IF to_regclass('public.notification_automation_date_runs') IS NULL AND EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input(p_job.id,'notification_automation_date_runs')) THEN
    v_issues:=v_issues||'"unsupported_date_runs"'::jsonb;
  END IF;
  RETURN v_issues;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_notifications_target_issues(p_job private.employee_transfer_jobs,p_owner jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_issues jsonb:='[]';v_key text;v_field text;v_bad boolean;
BEGIN
  FOR v_key,v_field IN SELECT * FROM (VALUES
    ('notification_automation_plan_members','user_id'),('notification_automation_task_recipients','user_id'),
    ('notification_automation_progress','user_id'),('notification_automation_executions','user_id'),
    ('notification_automation_failures','user_id'),('message_recipients','recipient_id'),('broadcast_recipients','employee_id')) f(k,c) LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I::text IN (SELECT value FROM jsonb_each_text($1)))',v_key,v_field)
      INTO v_bad USING p_owner->'identity_map';
    IF v_bad THEN v_issues:=v_issues||'"notification_target_not_empty"'::jsonb;EXIT;END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['notification_automation_executions','messages','message_recipients','broadcast_messages','broadcast_recipients',
    'notification_automation_plans','notification_automation_tasks','message_templates'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM private.employee_transfer_mapped_notifications_input($1,$2) s JOIN public.%I t ON t.id=s.id::uuid
      WHERE NOT CASE $2 WHEN ''notification_automation_plans'' THEN
        to_jsonb(t)->>''owner_admin_id'' IS NOT DISTINCT FROM $3->>(s.body->>''owner_admin_id'')
          AND lower(to_jsonb(t)->>''name'') IS NOT DISTINCT FROM lower(s.body->>''name'')
        WHEN ''message_templates'' THEN to_jsonb(t)->>''admin_id'' IS NOT DISTINCT FROM $3->>(s.body->>''admin_id'')
          AND to_jsonb(t)->''name'' IS NOT DISTINCT FROM s.body->''name''
        WHEN ''notification_automation_tasks'' THEN to_jsonb(t)->>''owner_admin_id'' IS NOT DISTINCT FROM $3->>(s.body->>''owner_admin_id'')
          AND to_jsonb(t)->''name'' IS NOT DISTINCT FROM s.body->''name'' AND to_jsonb(t)->''is_shared_template'' IS NOT DISTINCT FROM s.body->''is_shared_template''
          AND ((to_jsonb(t)->>''plan_id'' IS NULL AND s.body->>''plan_id'' IS NULL) OR EXISTS(
            SELECT 1 FROM private.employee_transfer_mapped_notifications_input($1,''notification_automation_plans'') sp
              JOIN public.notification_automation_plans tp ON tp.id=(to_jsonb(t)->>''plan_id'')::uuid
              WHERE sp.id=s.body->>''plan_id'' AND tp.owner_admin_id::text=$3->>(sp.body->>''owner_admin_id'') AND lower(tp.name)=lower(sp.body->>''name'')))
        ELSE false END)',v_key) INTO v_bad USING p_job.id,v_key,p_owner->'admin_map';
    IF v_bad THEN v_issues:=v_issues||'"notification_uuid_collision"'::jsonb;EXIT;END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_transactions') s
    LEFT JOIN public.wallet_transactions t ON t.id=s.id::uuid
    WHERE s.body->>'type'='performance_bonus' AND (t.id IS NULL OR t.type IS DISTINCT FROM 'performance_bonus'
      OR t.user_id IS DISTINCT FROM (p_owner#>>ARRAY['identity_map',s.body->>'user_id'])::uuid
      OR t.amount IS DISTINCT FROM (s.body->>'amount')::numeric OR t.reference_id IS DISTINCT FROM (s.body->>'reference_id')::uuid
      OR t.operation_id IS DISTINCT FROM (s.body->>'operation_id')::uuid)) THEN
    v_issues:=v_issues||'"mapped_reward_mismatch"'::jsonb;
  END IF;
  RETURN v_issues;
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_notifications_common(p_job private.employee_transfer_jobs,p_owner jsonb)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object('scope','employee-mapped-notifications','job_id',p_job.id,'site_id',(SELECT site_id FROM private.employee_transfer_site),
    'source_site_id',(p_job.summary#>>'{identity_catalog,site_id}')::uuid,'package_id',(p_job.options->>'package_id')::uuid,
    'mapping_hash',p_owner->'mapping_hash','maintenance',true,'dependencies_pending',true,'financial_data_pending',true,
    'can_restore',false,'complete_employee_backup',false,'can_archive',false,'can_replace',false,'full_site_complete',false,
    'configuration_pending',true,'records_pending',true,'media_pending',true,'automation_pending',true);
$$;

CREATE FUNCTION private.employee_transfer_mapped_notifications_plan(p_job private.employee_transfer_jobs,p_owner jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_plan jsonb;v_issues jsonb;v_counts jsonb;v_rewards bigint;
BEGIN
  IF p_owner#>'{source,complete}' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Mapped notifications source is incomplete.';END IF;
  v_issues:=private.employee_transfer_mapped_notifications_source_issues(p_job,p_owner->'admin_map')
    ||private.employee_transfer_mapped_notifications_target_issues(p_job,p_owner);
  SELECT COALESCE(jsonb_agg(to_jsonb(value) ORDER BY value COLLATE "C"),'[]') INTO v_issues
    FROM (SELECT DISTINCT value FROM jsonb_array_elements_text(v_issues)) r;
  SELECT jsonb_object_agg(value->>'key',value->'rows') INTO v_counts FROM jsonb_array_elements(p_owner#>'{source,tables}');
  SELECT count(*) INTO v_rewards FROM private.employee_transfer_mapped_finance_input(p_job.id,'wallet_transactions') WHERE body->>'type'='performance_bonus';
  v_plan:=private.employee_transfer_mapped_notifications_common(p_job,p_owner)||jsonb_build_object('catalog_hash',
    encode(extensions.digest(convert_to((p_owner->'catalog')::text,'UTF8'),'sha256'),'hex'),'checked',true,
    'counts',v_counts,'employees',(SELECT count(*) FROM jsonb_each(p_owner->'identity_map')),'rewards',v_rewards,'conflicts',v_issues);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,
    'catalog',p_owner->'catalog','verification_plan',p_owner->'verification_plan')::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_notifications_status(p_job private.employee_transfer_jobs,p_owner jsonb,p_key text,p_chunk integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_catalog jsonb:=NULLIF(p_owner->'catalog','null'::jsonb);v_plan jsonb:='null';v_chunk jsonb:='null';v_stage record;
BEGIN
  IF (p_key IS NULL) IS DISTINCT FROM (p_chunk IS NULL) THEN RAISE EXCEPTION 'Mapped notifications status chunk binding is incomplete.';END IF;
  IF p_key IS NOT NULL THEN
    PERFORM private.employee_transfer_notifications_relation(p_key);
    IF p_chunk NOT BETWEEN 0 AND 500000 THEN RAISE EXCEPTION 'Mapped notifications status chunk number is invalid.';END IF;
    SELECT * INTO v_stage FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='mapped-notifications-in:'||p_key AND chunk_no=p_chunk;
    IF FOUND THEN
      v_chunk:=jsonb_build_object('table_key',p_key,'chunk_no',p_chunk,'rows',v_stage.row_count,'bytes',v_stage.payload->'bytes',
        'sha256',encode(extensions.digest(convert_to(v_stage.payload->>'ndjson','UTF8'),'sha256'),'hex'));
    END IF;
  END IF;
  IF p_owner#>'{source,complete}'='true'::jsonb THEN v_plan:=private.employee_transfer_mapped_notifications_plan(p_job,p_owner);END IF;
  RETURN private.employee_transfer_mapped_notifications_common(p_job,p_owner)||jsonb_build_object('bound',v_catalog IS NOT NULL,
    'catalog_hash',CASE WHEN v_catalog IS NULL THEN NULL ELSE encode(extensions.digest(convert_to(v_catalog::text,'UTF8'),'sha256'),'hex') END,
    'catalog',v_catalog,'tables',p_owner#>'{source,tables}','complete',p_owner#>'{source,complete}','plan',v_plan,'chunk',v_chunk);
END;
$$;

CREATE FUNCTION public.employee_import_mapped_notifications_bind(p_admin_session_token uuid,p_job_token uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_catalog jsonb;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_notifications_context(v_job,false);
  PERFORM private.employee_transfer_check_notifications_catalog(p_catalog);
  IF p_catalog->'identity_catalog' IS DISTINCT FROM v_job.summary->'identity_catalog'
    OR p_catalog->'finance_catalog' IS DISTINCT FROM private.employee_transfer_mapped_finance_catalog(v_job)
    OR p_catalog->'site_id' IS DISTINCT FROM v_job.options#>'{catalog,site_id}'
    OR p_catalog->'package_id' IS DISTINCT FROM v_job.options->'package_id' THEN RAISE EXCEPTION 'Mapped notifications catalog binding differs.';END IF;
  v_catalog:=private.employee_transfer_mapped_notifications_catalog(v_job);
  IF v_catalog IS NOT NULL THEN
    IF v_catalog IS DISTINCT FROM p_catalog THEN RAISE EXCEPTION 'Mapped notifications catalog is immutable.';END IF;
  ELSE
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-notifications-catalog-v1',0,1,p_catalog);
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-mapped-notifications',
    'catalog_hash',encode(extensions.digest(convert_to(p_catalog::text,'UTF8'),'sha256'),'hex'),'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped notifications catalog request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_notifications_stage(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer,p_ndjson text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;v_payload jsonb;v_previous record;v_n bigint;v_rows integer;
BEGIN
  PERFORM private.employee_transfer_lock_maintenance_tables();
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_notifications_context(v_job,false);
  IF v_owner->'catalog'='null'::jsonb THEN RAISE EXCEPTION 'Mapped notifications requires a catalog.';END IF;
  IF p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 500000 THEN RAISE EXCEPTION 'Invalid mapped notifications chunk number.';END IF;
  v_payload:=private.employee_transfer_mapped_notifications_parse(p_table_key,p_ndjson);v_rows:=jsonb_array_length(v_payload->'rows');
  SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND table_key='mapped-notifications-in:'||p_table_key AND chunk_no=p_chunk_no;
  IF v_n>0 THEN
    SELECT * INTO STRICT v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id
      AND table_key='mapped-notifications-in:'||p_table_key AND chunk_no=p_chunk_no;
    IF v_previous.payload IS DISTINCT FROM v_payload OR v_previous.row_count<>v_rows
      OR v_previous.employee_id<>'00000000-0000-0000-0000-000000000000' THEN RAISE EXCEPTION 'Mapped notifications repeated chunk changed.';END IF;
  ELSE
    SELECT count(*) INTO v_n FROM private.employee_transfer_staging WHERE job_id=v_job.id AND table_key='mapped-notifications-in:'||p_table_key;
    IF v_n<>p_chunk_no THEN RAISE EXCEPTION 'Mapped notifications chunks must be consecutive.';END IF;
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','mapped-notifications-in:'||p_table_key,p_chunk_no,v_rows,v_payload);
    PERFORM private.employee_transfer_mapped_notifications_source(v_job,false);
  END IF;
  RETURN jsonb_build_object('success',true,'scope','employee-mapped-notifications','table_key',p_table_key,'chunk_no',p_chunk_no,
    'rows',v_rows,'bytes',octet_length(p_ndjson),'sha256',encode(extensions.digest(convert_to(p_ndjson,'UTF8'),'sha256'),'hex'),'full_site_complete',false);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped notifications staging request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_notifications_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_notifications_context(v_job,true);
  RETURN private.employee_transfer_mapped_notifications_plan(v_job,v_owner);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped notifications plan request rejected.' USING ERRCODE='22023';
END;
$$;

CREATE FUNCTION public.employee_import_mapped_notifications_status(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_owner jsonb;
BEGIN
  v_job:=private.employee_transfer_replacement_owner(p_admin_session_token,p_job_token);
  v_owner:=private.employee_transfer_mapped_notifications_context(v_job,false);
  RETURN private.employee_transfer_mapped_notifications_status(v_job,v_owner,p_table_key,p_chunk_no);
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Mapped notifications status request rejected.' USING ERRCODE='22023';
END;
$$;

DO $permissions$
DECLARE v_fn regprocedure;
BEGIN
  FOR v_fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace
    AND proname LIKE 'employee_transfer_mapped_notifications_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_fn);
  END LOOP;
  FOR v_fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'employee_import_mapped_notifications_bind','employee_import_mapped_notifications_stage',
    'employee_import_mapped_notifications_plan','employee_import_mapped_notifications_status') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon,authenticated',v_fn);
  END LOOP;
END;
$permissions$;
NOTIFY pgrst,'reload schema';
COMMIT;
