BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- Independent of the dispatch backup occupying shared_backups(job.id). No business apply.
CREATE TABLE private.employee_transfer_notification_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL UNIQUE REFERENCES private.employee_transfer_jobs(id),
  admin_id uuid NOT NULL REFERENCES public.admins(id),
  plan_hash text NOT NULL,
  target_hash text NOT NULL,
  catalog jsonb NOT NULL,
  chunks bytea[] NOT NULL DEFAULT '{}',
  byte_count integer NOT NULL DEFAULT 0 CHECK (byte_count BETWEEN 0 AND 9437184),
  sealed_sha256 text,
  sealed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE private.employee_transfer_notification_backups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.employee_transfer_notification_backups FROM PUBLIC, anon, authenticated, service_role;

-- The pinned inventory rejects EVERY new relation, including private transfer metadata.
-- Add only this reviewed RLS/no-grants table to its exact exclusions; do not weaken guards,
-- change the guarded business-table manifest, or replace any existing backup/cleanup function.
DO $notification_inventory$
DECLARE v_definition text;v_anchor constant text:='''private.employee_transfer_shared_backups'',''private.employee_transfer_site''';
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_assert_maintenance_guards()'::regprocedure);
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'Notification backup maintenance inventory anchor changed.';
  END IF;
  EXECUTE replace(v_definition,v_anchor,'''private.employee_transfer_notification_backups'','||v_anchor);
  PERFORM private.employee_transfer_assert_maintenance_guards();
END;
$notification_inventory$;

CREATE FUNCTION private.employee_transfer_notification_discard_unsealed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  DELETE FROM private.employee_transfer_notification_backups WHERE job_id=NEW.id AND sealed_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER discard_unsealed_notification_backup AFTER UPDATE OF status ON private.employee_transfer_jobs
FOR EACH ROW WHEN (NEW.status <> 'running') EXECUTE FUNCTION private.employee_transfer_notification_discard_unsealed();

-- Unlike employee_transfer_job(), this never refreshes the heartbeat, including in READ ONLY.
CREATE FUNCTION private.employee_transfer_notification_job(p_session uuid,p_token uuid)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid;v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  SELECT admin_id INTO v_admin FROM private.employee_transfer_admin(p_session);
  SELECT * INTO v_job FROM private.employee_transfer_jobs
    WHERE token_hash=private.hash_financial_token(p_token) AND admin_id=v_admin AND kind='import' AND status='running'
      AND options->>'import_protocol'='dispatch-submission-v1'
      AND last_activity_at>now()-interval '3 hours' AND started_at>now()-interval '12 hours';
  IF p_token IS NULL OR v_job.id IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.';END IF;
  RETURN v_job;
END;
$$;

-- Full physical rows, not the export projection: leases and raw diagnostic drift are binding.
CREATE FUNCTION private.employee_transfer_notification_target_hash()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_hash text;v_tables jsonb:='[]';
BEGIN
  PERFORM private.employee_transfer_notifications_schema();
  FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP
    v_hash:=NULL;
    IF private.employee_transfer_notifications_relation(v_key) IS NOT NULL THEN
      EXECUTE format('SELECT encode(extensions.digest(convert_to(COALESCE(string_agg(h,'''' ORDER BY h COLLATE "C"),''''),''UTF8''),''sha256''),''hex'')
        FROM (SELECT encode(extensions.digest(convert_to(to_jsonb(r)::text,''UTF8''),''sha256''),''hex'') AS h FROM public.%I AS r) AS s',v_key) INTO v_hash;
    END IF;
    v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'sha256',v_hash));
  END LOOP;
  RETURN encode(extensions.digest(convert_to(v_tables::text,'UTF8'),'sha256'),'hex');
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_configuration_plan(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_map jsonb;v_counts jsonb;v_conflicts jsonb;v_records jsonb:='[]';v_plans jsonb:='{}';v_tasks jsonb:='{}';
  v_key text;v_source record;v_target uuid;v_owner uuid;v_parent uuid;v_candidates integer;v_duplicates integer;
  v_action text;v_bad boolean;v_occupied boolean;v_reason text;v_retire uuid[]:='{}';v_affected uuid[]:='{}';v_matched uuid[]:='{}';
  v_members bigint;v_history boolean;v_plan jsonb;v_target_hash text;
BEGIN
  v_map:=private.employee_transfer_notifications_owner(p_job);
  v_counts:=private.employee_transfer_check_notifications_input(p_job);
  v_conflicts:=private.employee_transfer_notifications_source_issues(p_job,v_map);
  FOREACH v_key IN ARRAY ARRAY['notification_automation_plans','notification_automation_tasks','message_templates'] LOOP
    FOR v_source IN SELECT * FROM private.employee_transfer_notifications_input(p_job.id,v_key) ORDER BY id COLLATE "C" LOOP
      v_target:=NULL;v_parent:=NULL;v_reason:=NULL;v_action:='create';v_candidates:=0;v_duplicates:=0;
      v_owner:=(v_map->>(v_source.body->>CASE WHEN v_key='message_templates' THEN 'admin_id' ELSE 'owner_admin_id' END))::uuid;
      IF v_key='notification_automation_plans' THEN
        SELECT count(*),(array_agg(id ORDER BY id))[1] INTO v_candidates,v_target FROM public.notification_automation_plans
          WHERE owner_admin_id=v_owner AND lower(name)=lower(v_source.body->>'name');
        SELECT count(*) INTO v_duplicates FROM private.employee_transfer_notifications_input(p_job.id,v_key)
          WHERE v_map->>(body->>'owner_admin_id')=v_owner::text AND lower(body->>'name')=lower(v_source.body->>'name');
      ELSIF v_key='notification_automation_tasks' THEN
        v_parent:=(v_plans->>(v_source.body->>'plan_id'))::uuid;
        SELECT count(*),(array_agg(id ORDER BY id))[1] INTO v_candidates,v_target FROM public.notification_automation_tasks
          WHERE owner_admin_id=v_owner AND plan_id IS NOT DISTINCT FROM v_parent
            AND name=v_source.body->>'name' AND is_shared_template=(v_source.body->>'is_shared_template')::boolean;
        SELECT count(*) INTO v_duplicates FROM private.employee_transfer_notifications_input(p_job.id,v_key)
          WHERE v_map->>(body->>'owner_admin_id')=v_owner::text AND (v_plans->>(body->>'plan_id'))::uuid IS NOT DISTINCT FROM v_parent
            AND body->>'name'=v_source.body->>'name' AND body->'is_shared_template'=v_source.body->'is_shared_template';
        IF v_source.body->>'plan_id' IS NOT NULL AND v_parent IS NULL THEN v_reason:='source_plan_unmapped';END IF;
      ELSE
        SELECT count(*),(array_agg(id ORDER BY id))[1] INTO v_candidates,v_target FROM public.message_templates
          WHERE admin_id=v_owner AND name=v_source.body->>'name';
        SELECT count(*) INTO v_duplicates FROM private.employee_transfer_notifications_input(p_job.id,v_key)
          WHERE v_map->>(body->>'admin_id')=v_owner::text AND body->>'name'=v_source.body->>'name';
      END IF;
      IF v_candidates>0 THEN v_action:='replace';END IF;
      v_target:=COALESCE(v_target,v_source.id::uuid);
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1 AND ($2=0 OR id<>$3))',v_key)
        INTO v_occupied USING v_source.id::uuid,v_candidates,v_target;
      IF v_owner IS NULL THEN v_reason:='source_admin_unmapped';
      ELSIF v_candidates>1 THEN v_reason:='ambiguous_notification_configuration';
      ELSIF v_duplicates>1 THEN v_reason:='source_configuration_collision';
      ELSIF v_occupied THEN v_reason:='notification_configuration_id_collision';END IF;
      IF v_reason IS NOT NULL THEN v_action:='conflict';v_conflicts:=v_conflicts||jsonb_build_array(v_reason);END IF;
      v_records:=v_records||jsonb_build_array(jsonb_build_object('table_key',v_key,'source_id',v_source.id,'target_id',v_target,'action',v_action));
      IF v_key='notification_automation_plans' THEN
        v_plans:=v_plans||jsonb_build_object(v_source.id,v_target);
        IF v_candidates>0 THEN v_matched:=array_append(v_matched,v_target);END IF;
      ELSIF v_key='notification_automation_tasks' THEN
        v_tasks:=v_tasks||jsonb_build_object(v_source.id,v_target);
        IF v_candidates>0 THEN v_affected:=array_append(v_affected,v_target);END IF;
      END IF;
    END LOOP;
  END LOOP;
  SELECT EXISTS(SELECT 1 FROM jsonb_array_elements(v_records) AS r GROUP BY r->>'table_key',r->>'target_id' HAVING count(*)>1) INTO v_bad;
  IF v_bad THEN
    v_conflicts:=v_conflicts||'"notification_many_to_one"'::jsonb;
    SELECT COALESCE(jsonb_agg(CASE WHEN (r->>'table_key',r->>'target_id') IN
      (SELECT x->>'table_key',x->>'target_id' FROM jsonb_array_elements(v_records) AS x GROUP BY x->>'table_key',x->>'target_id' HAVING count(*)>1)
      THEN jsonb_set(r,'{action}','"conflict"') ELSE r END ORDER BY ordinal),'[]') INTO v_records
      FROM jsonb_array_elements(v_records) WITH ORDINALITY AS s(r,ordinal);
  END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}') INTO v_retire FROM public.notification_automation_tasks
    WHERE plan_id=ANY(v_matched) AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(v_tasks) WHERE value=id::text);
  v_affected:=v_affected||v_retire;
  SELECT count(*) INTO v_members FROM public.notification_automation_plan_members AS m
    WHERE m.plan_id=ANY(v_matched) AND NOT EXISTS(
      SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_plan_members') AS s
      WHERE s.body->>'user_id'=m.user_id::text AND v_plans->>(s.body->>'plan_id')=m.plan_id::text);
  -- No implicit detach, even when another replaced plan happens to be in this package.
  IF EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_plan_members') AS s
    JOIN public.notification_automation_plan_members AS m ON m.user_id=(s.body->>'user_id')::uuid
    WHERE m.plan_id::text IS DISTINCT FROM v_plans->>(s.body->>'plan_id')) THEN
    v_conflicts:=v_conflicts||'"target_member_outside_plan"'::jsonb;
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.notification_automation_executions WHERE task_id=ANY(v_affected) OR plan_id=ANY(v_matched)
    UNION ALL SELECT 1 FROM public.notification_automation_progress WHERE task_id=ANY(v_affected)
    UNION ALL SELECT 1 FROM public.notification_automation_failures WHERE task_id=ANY(v_affected)
    UNION ALL SELECT 1 FROM public.notification_automation_queue AS q WHERE EXISTS(
      SELECT 1 FROM public.notification_automation_plan_members AS m WHERE m.user_id=q.user_id AND m.plan_id=ANY(v_matched))
      OR EXISTS(SELECT 1 FROM public.notification_automation_task_recipients AS r WHERE r.user_id=q.user_id AND r.task_id=ANY(v_affected))) INTO v_history;
  IF to_regclass('public.notification_automation_date_runs') IS NOT NULL THEN
    EXECUTE 'SELECT $1 OR EXISTS(SELECT 1 FROM public.notification_automation_date_runs WHERE task_id=ANY($2))' INTO v_history USING v_history,v_affected;
  END IF;
  -- Conservatively include sent messages/rewards to any affected member/explicit recipient.
  IF v_history OR EXISTS(WITH people AS (
    SELECT user_id FROM public.notification_automation_plan_members WHERE plan_id=ANY(v_matched)
    UNION SELECT user_id FROM public.notification_automation_task_recipients WHERE task_id=ANY(v_affected))
    SELECT 1 FROM public.message_recipients AS r JOIN people AS p ON p.user_id=r.recipient_id
    UNION ALL SELECT 1 FROM public.broadcast_recipients AS r JOIN people AS p ON p.user_id=r.employee_id
    UNION ALL SELECT 1 FROM public.wallet_transactions AS w JOIN public.message_recipients AS r ON w.reference_id=r.id
      JOIN people AS p ON p.user_id=r.recipient_id WHERE w.type='performance_bonus') THEN
    v_conflicts:=v_conflicts||'"target_notification_history"'::jsonb;
  END IF;
  FOREACH v_key IN ARRAY ARRAY['messages','message_recipients','broadcast_messages','broadcast_recipients','notification_automation_executions'] LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input($1,$2) AS s JOIN public.%I AS t ON t.id::text=s.id)',v_key)
      INTO v_bad USING p_job.id,v_key;
    IF v_bad THEN v_conflicts:=v_conflicts||'"target_notification_uuid_collision"'::jsonb;END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_executions') AS s
    JOIN public.notification_automation_executions AS t ON t.task_id=(v_tasks->>(s.body->>'task_id'))::uuid
      AND t.task_version=(s.body->>'task_version')::integer AND t.user_id=(s.body->>'user_id')::uuid
      AND t.period_key=s.body->>'period_key' AND t.stage=(s.body->>'stage')::bigint) THEN
    v_conflicts:=v_conflicts||'"target_execution_unique_collision"'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY value#>>'{}' COLLATE "C"),'[]') INTO v_conflicts FROM (SELECT DISTINCT value FROM jsonb_array_elements(v_conflicts)) AS s;
  v_target_hash:=private.employee_transfer_notification_target_hash();
  v_plan:=jsonb_build_object('scope','notification-configuration','records',v_records,'retire_tasks',to_jsonb(v_retire),'members_removed',v_members,
    'conflicts',v_conflicts,'counts',v_counts,'checked',true,'backup_required',true,'can_prepare_backup',jsonb_array_length(v_conflicts)=0,
    'can_apply_configuration',false,'media_pending',true,'automation_pending',true,'maintenance',true,'replacement_ready',false,'full_site_complete',false,
    'target_hash',v_target_hash);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,'admin_map',v_map,
    'catalog',p_job.summary->'notifications_catalog','job_id',p_job.id,'package_id',p_job.options->'package_id')::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.get_employee_import_notification_configuration_plan(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  RETURN private.employee_transfer_notification_configuration_plan(private.employee_transfer_notification_job(p_admin_session_token,p_job_token));
END;
$$;

-- Lock order: configuration advisory lock -> 13 relations (fixed protocol order) -> queue -> job -> backup.
-- Missing date_runs is a capability, never an instruction to create a table.
CREATE FUNCTION private.employee_transfer_notification_lock()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();
  FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP
    IF private.employee_transfer_notifications_relation(v_key) IS NOT NULL THEN EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',v_key);END IF;
  END LOOP;
  LOCK TABLE public.notification_automation_queue IN SHARE MODE;
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_check_snapshot(p_backup private.employee_transfer_notification_backups)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_table jsonb;v_payload jsonb;v_row_count integer;v_text text;v_line text;v_json json;v_cursor text;v_last text;
  v_count bigint;v_hashes text;v_total bigint:=0;v_index integer:=0;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_backup.catalog,ARRAY['version','scope','site_id','package_id','date_runs_supported','tables','media_included','full_site_complete'])
    OR p_backup.catalog->'version' IS DISTINCT FROM '1'::jsonb OR p_backup.catalog->>'scope' IS DISTINCT FROM 'notification-backup'
    OR p_backup.catalog->'media_included' IS DISTINCT FROM 'false'::jsonb OR p_backup.catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb
    OR p_backup.catalog->'site_id' IS DISTINCT FROM to_jsonb((SELECT site_id FROM private.employee_transfer_site))
    OR p_backup.catalog->'package_id' IS DISTINCT FROM (SELECT options->'package_id' FROM private.employee_transfer_jobs WHERE id=p_backup.job_id)
    OR p_backup.catalog->'date_runs_supported' IS DISTINCT FROM to_jsonb(to_regclass('public.notification_automation_date_runs') IS NOT NULL)
    OR jsonb_typeof(p_backup.catalog->'tables') IS DISTINCT FROM 'array' OR jsonb_array_length(p_backup.catalog->'tables')<>13 THEN
    RAISE EXCEPTION 'Invalid notification backup catalog.';
  END IF;
  IF (SELECT count(*) FROM private.employee_transfer_staging WHERE job_id=p_backup.job_id AND table_key LIKE 'notifications-backup:%')<>13 THEN
    RAISE EXCEPTION 'Notification backup snapshot is incomplete.';
  END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP
    v_table:=p_backup.catalog->'tables'->v_index;v_index:=v_index+1;
    SELECT payload,row_count INTO v_payload,v_row_count FROM private.employee_transfer_staging WHERE job_id=p_backup.job_id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='notifications-backup:'||v_key AND chunk_no=0;
    v_text:=v_payload->>'ndjson';v_count:=0;v_hashes:='';v_last:=NULL;
    IF v_text IS NULL OR (v_text<>'' AND right(v_text,1)<>E'\n') THEN RAISE EXCEPTION 'Invalid notification backup snapshot.';END IF;
    IF v_text<>'' THEN FOR v_line IN SELECT line FROM unnest(string_to_array(left(v_text,length(v_text)-1),E'\n')) AS s(line) LOOP
      v_json:=v_line::json;
      IF octet_length(v_line)+1>65536 OR NOT private.employee_transfer_unique_json(v_json) THEN RAISE EXCEPTION 'Invalid notification backup row.';END IF;
      PERFORM private.employee_transfer_check_notifications_row(v_key,v_json::jsonb);
      v_cursor:=v_json->>'id';
      IF v_last IS NOT NULL AND v_last COLLATE "C">=v_cursor COLLATE "C" THEN RAISE EXCEPTION 'Invalid notification backup row order.';END IF;
      v_last:=v_cursor;v_count:=v_count+1;v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    END LOOP;END IF;
    v_total:=v_total+octet_length(v_text);
    IF NOT private.employee_transfer_exact_object(v_table,ARRAY['key','rows','bytes','row_hashes_sha256']) OR v_table->>'key' IS DISTINCT FROM v_key
      OR v_table->'rows' IS DISTINCT FROM to_jsonb(v_count) OR v_table->'bytes' IS DISTINCT FROM to_jsonb(octet_length(v_text))
      OR v_count IS DISTINCT FROM v_row_count::bigint OR v_count>500000 OR v_total>8388608
      OR v_table->>'row_hashes_sha256' IS DISTINCT FROM encode(extensions.digest(convert_to(v_hashes,'UTF8'),'sha256'),'hex')
      OR (v_key='notification_automation_date_runs' AND p_backup.catalog->'date_runs_supported'='false'::jsonb AND v_count<>0) THEN
      RAISE EXCEPTION 'Notification backup snapshot verification failed.';
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.employee_import_notification_backup_prepare(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_plan jsonb;v_backup private.employee_transfer_notification_backups%ROWTYPE;
  v_key text;v_query text;v_text text;v_rows bigint;v_bytes bigint;v_largest bigint;v_hash text;v_total bigint:=0;v_tables jsonb:='[]';v_row record;v_catalog jsonb;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_notification_lock();
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  v_plan:=private.employee_transfer_notification_configuration_plan(v_job);
  IF p_plan_hash IS DISTINCT FROM v_plan->>'plan_hash' OR v_plan->'can_prepare_backup' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'A matching conflict-free notification configuration plan is required.';
  END IF;
  SELECT * INTO v_backup FROM private.employee_transfer_notification_backups WHERE job_id=v_job.id FOR UPDATE;
  IF v_backup.id IS NOT NULL THEN
    IF v_backup.plan_hash IS DISTINCT FROM p_plan_hash OR v_backup.target_hash IS DISTINCT FROM v_plan->>'target_hash' THEN
      RAISE EXCEPTION 'Notification target or plan changed after backup preparation; restart the task.';
    END IF;
    PERFORM private.employee_transfer_notification_check_snapshot(v_backup);
  ELSE
    FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP
      v_query:=private.employee_transfer_notifications_query(v_key);
      EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),COALESCE(max(octet_length(body::text||E''\n'')),0) FROM ('||v_query||') AS r' INTO v_rows,v_bytes,v_largest;
      v_total:=v_total+v_bytes;
      IF v_rows>500000 OR v_total>8388608 OR v_largest>65536 THEN RAISE EXCEPTION 'Notification backup exceeds limits; no data was truncated.';END IF;
      FOR v_row IN EXECUTE v_query LOOP PERFORM private.employee_transfer_check_notifications_row(v_key,v_row.body);END LOOP;
      EXECUTE 'SELECT COALESCE(string_agg(body::text||E''\n'','''' ORDER BY id COLLATE "C"),''''),
        encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id COLLATE "C"),''''),''UTF8''),''sha256''),''hex'') FROM ('||v_query||') AS r'
        INTO v_text,v_hash;
      INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
        VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','notifications-backup:'||v_key,0,v_rows,
          jsonb_build_object('ndjson',v_text));
      v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
    END LOOP;
    v_catalog:=jsonb_build_object('version',1,'scope','notification-backup','site_id',(SELECT site_id FROM private.employee_transfer_site),
      'package_id',v_job.options->'package_id','date_runs_supported',to_regclass('public.notification_automation_date_runs') IS NOT NULL,
      'tables',v_tables,'media_included',false,'full_site_complete',false);
    INSERT INTO private.employee_transfer_notification_backups(job_id,admin_id,plan_hash,target_hash,catalog)
      VALUES(v_job.id,v_job.admin_id,p_plan_hash,v_plan->>'target_hash',v_catalog) RETURNING * INTO v_backup;
    PERFORM private.employee_transfer_notification_check_snapshot(v_backup);
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','notification_backup_prepared',
      jsonb_build_object('backup_id',v_backup.id,'plan_hash',p_plan_hash,'target_hash',v_backup.target_hash,'bytes',v_total,'tables',13));
  END IF;
  RETURN jsonb_build_object('backup_id',v_backup.id,'plan_hash',v_backup.plan_hash,'target_hash',v_backup.target_hash,'catalog',v_backup.catalog);
END;
$$;

CREATE FUNCTION public.get_employee_import_notification_backup_page(p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_backup private.employee_transfer_notification_backups%ROWTYPE;v_text text;v_line text;v_result text:='';
  v_count integer:=0;v_cursor text;v_last text;v_found boolean:=p_after IS NULL;v_more boolean:=false;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  IF p_table_key IS NULL OR NOT p_table_key=ANY(private.employee_transfer_notifications_keys()) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
    OR (p_after IS NOT NULL AND length(p_after)>256) THEN RAISE EXCEPTION 'Invalid notification backup page size, table or cursor.';END IF;
  SELECT * INTO v_backup FROM private.employee_transfer_notification_backups WHERE id=p_backup_id AND job_id=v_job.id AND admin_id=v_job.admin_id;
  IF v_backup.id IS NULL THEN RAISE EXCEPTION 'Notification backup is unavailable.';END IF;
  SELECT payload->>'ndjson' INTO v_text FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='notifications-backup:'||p_table_key AND chunk_no=0;
  IF v_text IS NULL THEN RAISE EXCEPTION 'Notification backup snapshot is incomplete.';END IF;
  IF v_text<>'' THEN FOR v_line IN SELECT line FROM unnest(string_to_array(left(v_text,length(v_text)-1),E'\n')) AS s(line) LOOP
    v_cursor:=v_line::jsonb->>'id';
    IF v_cursor=p_after THEN v_found:=true;END IF;
    IF p_after IS NOT NULL AND v_cursor COLLATE "C"<=p_after COLLATE "C" THEN CONTINUE;END IF;
    IF v_count=p_limit OR octet_length(v_result)+octet_length(v_line)+1>262144 THEN v_more:=true;EXIT;END IF;
    v_result:=v_result||v_line||E'\n';v_count:=v_count+1;v_last:=v_cursor;
  END LOOP;END IF;
  IF NOT v_found THEN RAISE EXCEPTION 'Notification backup cursor is not canonical or does not exist.';END IF;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_result,'next_after',CASE WHEN v_more THEN v_last ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_result,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_import_notification_backup_verify(p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_backup private.employee_transfer_notification_backups%ROWTYPE;v_plan jsonb;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  SELECT * INTO v_backup FROM private.employee_transfer_notification_backups WHERE id=p_backup_id AND job_id=v_job.id AND admin_id=v_job.admin_id;
  IF v_backup.id IS NULL THEN RAISE EXCEPTION 'Notification backup is unavailable.';END IF;
  v_plan:=private.employee_transfer_notification_configuration_plan(v_job);
  IF v_plan->>'plan_hash' IS DISTINCT FROM v_backup.plan_hash OR v_plan->>'target_hash' IS DISTINCT FROM v_backup.target_hash
    OR v_plan->'can_prepare_backup' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Notification target or plan changed after backup preparation.';END IF;
  PERFORM private.employee_transfer_notification_check_snapshot(v_backup);
  RETURN jsonb_build_object('verified',true,'backup_id',v_backup.id,'plan_hash',v_backup.plan_hash,'target_hash',v_backup.target_hash,'media_included',false,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_notification_backup_append(p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_chunk_no integer,p_hex text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_backup private.employee_transfer_notification_backups%ROWTYPE;v_chunk bytea;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  IF p_hex IS NULL OR length(p_hex) NOT BETWEEN 2 AND 262144 OR length(p_hex)%2<>0 OR p_hex!~'^[0-9a-f]+$'
    OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 1023 THEN RAISE EXCEPTION 'Invalid encrypted notification backup chunk.';END IF;
  SELECT * INTO v_backup FROM private.employee_transfer_notification_backups WHERE id=p_backup_id AND job_id=v_job.id AND admin_id=v_job.admin_id FOR UPDATE;
  IF v_backup.id IS NULL OR v_backup.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'Notification backup does not accept encrypted chunks.';END IF;
  v_chunk:=decode(p_hex,'hex');
  IF p_chunk_no>cardinality(v_backup.chunks) THEN RAISE EXCEPTION 'Notification backup chunks must be contiguous.';END IF;
  v_repeated:=p_chunk_no<cardinality(v_backup.chunks);
  IF v_repeated THEN
    IF v_backup.chunks[p_chunk_no+1] IS DISTINCT FROM v_chunk THEN RAISE EXCEPTION 'Encrypted notification backup chunk has different contents.';END IF;
  ELSE
    IF v_backup.byte_count+octet_length(v_chunk)>9437184 THEN RAISE EXCEPTION 'Encrypted notification backup exceeds the limit.';END IF;
    IF cardinality(v_backup.chunks)>0 AND octet_length(v_backup.chunks[cardinality(v_backup.chunks)])<>131072 THEN
      RAISE EXCEPTION 'Only the last notification backup chunk may be short.';
    END IF;
    UPDATE private.employee_transfer_notification_backups SET chunks=array_append(chunks,v_chunk),byte_count=byte_count+octet_length(v_chunk) WHERE id=v_backup.id;
  END IF;
  RETURN jsonb_build_object('success',true,'bytes',octet_length(v_chunk),'sha256',encode(extensions.digest(v_chunk,'sha256'),'hex'),'repeated',v_repeated);
END;
$$;

CREATE FUNCTION public.employee_import_notification_backup_seal(p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_sha256 text,p_bytes integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_backup private.employee_transfer_notification_backups%ROWTYPE;v_cipher bytea;v_hash text;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_notification_lock();
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  SELECT * INTO v_backup FROM private.employee_transfer_notification_backups WHERE id=p_backup_id AND job_id=v_job.id AND admin_id=v_job.admin_id FOR UPDATE;
  IF v_backup.id IS NULL OR p_bytes IS NULL OR p_sha256 IS NULL OR p_sha256!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid notification backup seal request.';END IF;
  PERFORM public.employee_import_notification_backup_verify(p_admin_session_token,p_job_token,p_backup_id);
  SELECT string_agg(chunk,''::bytea ORDER BY ordinal) INTO v_cipher FROM unnest(v_backup.chunks) WITH ORDINALITY AS s(chunk,ordinal);
  v_hash:=encode(extensions.digest(v_cipher,'sha256'),'hex');
  IF v_backup.byte_count<>p_bytes OR octet_length(v_cipher) IS DISTINCT FROM p_bytes OR p_bytes<64
    OR substring(v_cipher FROM 1 FOR 8) IS DISTINCT FROM convert_to('EDXSTRM1','UTF8') OR v_hash IS DISTINCT FROM p_sha256 THEN
    RAISE EXCEPTION 'Encrypted notification backup does not match its seal.';
  END IF;
  v_repeated:=v_backup.sealed_at IS NOT NULL;
  IF v_repeated AND (v_backup.sealed_sha256 IS DISTINCT FROM p_sha256 OR v_backup.byte_count IS DISTINCT FROM p_bytes) THEN
    RAISE EXCEPTION 'Notification backup is already sealed with different contents.';
  END IF;
  IF NOT v_repeated THEN
    UPDATE private.employee_transfer_notification_backups SET sealed_sha256=v_hash,sealed_at=clock_timestamp() WHERE id=v_backup.id;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','notification_backup_sealed',
      jsonb_build_object('backup_id',v_backup.id,'sha256',v_hash,'bytes',p_bytes,'media_pending',true,'full_site_complete',false));
  END IF;
  RETURN jsonb_build_object('success',true,'backup_id',v_backup.id,'sha256',v_hash,'bytes',p_bytes,'repeated',v_repeated,'media_pending',true,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_notification_saved_backup_chunk(p_admin_session_token uuid,p_backup_id uuid,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid;v_backup private.employee_transfer_notification_backups%ROWTYPE;v_chunk bytea;
BEGIN
  SELECT admin_id INTO v_admin FROM private.employee_transfer_admin(p_admin_session_token);
  SELECT * INTO v_backup FROM private.employee_transfer_notification_backups WHERE id=p_backup_id AND admin_id=v_admin AND sealed_at IS NOT NULL;
  IF v_backup.id IS NULL OR p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>=cardinality(v_backup.chunks) THEN
    RAISE EXCEPTION 'Saved notification backup or chunk is unavailable.';
  END IF;
  v_chunk:=v_backup.chunks[p_chunk_no+1];
  RETURN jsonb_build_object('backup_id',v_backup.id,'chunk_no',p_chunk_no,'hex',encode(v_chunk,'hex'),'sha256',v_backup.sealed_sha256,
    'bytes',v_backup.byte_count,'chunks',cardinality(v_backup.chunks));
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_notification\_%' ESCAPE '\' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'get_employee_import_notification_configuration_plan','employee_import_notification_backup_prepare','get_employee_import_notification_backup_page',
    'employee_import_notification_backup_verify','employee_import_notification_backup_append','employee_import_notification_backup_seal','get_employee_notification_saved_backup_chunk') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon,authenticated',v_function);
  END LOOP;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
