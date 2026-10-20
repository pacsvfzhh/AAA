BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- Independent of the dispatch backup occupying shared_backups(job.id). No business apply.
CREATE TABLE private.employee_transfer_chat_backups (
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
ALTER TABLE private.employee_transfer_chat_backups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.employee_transfer_chat_backups FROM PUBLIC, anon, authenticated, service_role;

-- The exact inventory must admit this private metadata table without exempting business writes.
DO $chat_inventory$
DECLARE v_definition text;v_anchor constant text:='''private.employee_transfer_notification_backups'',''private.employee_transfer_shared_backups''';
BEGIN
  v_definition:=pg_get_functiondef('private.employee_transfer_assert_maintenance_guards()'::regprocedure);
  IF (length(v_definition)-length(replace(v_definition,v_anchor,'')))/length(v_anchor)<>1 THEN
    RAISE EXCEPTION 'Chat backup maintenance inventory anchor changed.';
  END IF;
  EXECUTE replace(v_definition,v_anchor,'''private.employee_transfer_chat_backups'','||v_anchor);
  PERFORM private.employee_transfer_assert_maintenance_guards();
END;
$chat_inventory$;

CREATE FUNCTION private.employee_transfer_chat_discard_unsealed()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  DELETE FROM private.employee_transfer_chat_backups WHERE job_id=NEW.id AND sealed_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER discard_unsealed_chat_backup AFTER UPDATE OF status ON private.employee_transfer_jobs
FOR EACH ROW WHEN (NEW.status <> 'running') EXECUTE FUNCTION private.employee_transfer_chat_discard_unsealed();


-- No heartbeat, role writes or caller-provided administrator maps are permitted here.
CREATE FUNCTION private.employee_transfer_chat_merge_plan(p_job private.employee_transfer_jobs,p_decisions jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_map jsonb;v_counts jsonb;v_conflicts jsonb;v_decisions jsonb;v_item jsonb;v_source record;
  v_target public.simulated_customers%ROWTYPE;v_target_id uuid;v_admin uuid;v_number text;v_visibility jsonb;
  v_roles jsonb:='[]';v_plan jsonb;v_target_hash text;v_create boolean;
BEGIN
  IF p_decisions IS NULL OR jsonb_typeof(p_decisions) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Chat decisions must be an array.';END IF;
  IF jsonb_array_length(p_decisions)>2000 OR octet_length(p_decisions::text)>1048576 THEN RAISE EXCEPTION 'Chat decisions exceed limits.';END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_decisions) LOOP
    IF NOT private.employee_transfer_exact_object(v_item,ARRAY['source_id','target_id','allow_visibility','confirmed'])
      OR jsonb_typeof(v_item->'source_id') IS DISTINCT FROM 'string'
      OR (v_item->>'source_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR jsonb_typeof(v_item->'target_id') NOT IN ('string','null')
      OR (v_item->'target_id'<>'null'::jsonb AND (v_item->>'target_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      OR jsonb_typeof(v_item->'allow_visibility') IS DISTINCT FROM 'boolean'
      OR v_item->'confirmed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Each chat role requires one explicit confirmed decision.';END IF;
  END LOOP;
  v_map:=private.employee_transfer_chat_owner(p_job);
  v_counts:=private.employee_transfer_check_chat_input(p_job);
  IF jsonb_array_length(p_decisions)<>(v_counts->>'simulated_customers')::bigint
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_decisions) AS d GROUP BY d->>'source_id' HAVING count(*)>1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_decisions) AS d
      WHERE NOT EXISTS(SELECT 1 FROM private.employee_transfer_chat_input(p_job.id,'simulated_customers') AS r WHERE r.id=d->>'source_id')) THEN
    RAISE EXCEPTION 'Chat decisions must cover every source role exactly once.';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('source_id',(d->>'source_id')::uuid,'target_id',(d->>'target_id')::uuid,
    'allow_visibility',(d->>'allow_visibility')::boolean,'confirmed',true) ORDER BY d->>'source_id' COLLATE "C"),'[]')
    INTO v_decisions FROM jsonb_array_elements(p_decisions) AS d;
  v_conflicts:=private.employee_transfer_chat_source_issues(p_job,v_map);
  FOR v_source IN SELECT r.id,r.body,d AS decision FROM private.employee_transfer_chat_input(p_job.id,'simulated_customers') AS r
    JOIN jsonb_array_elements(v_decisions) AS d ON d->>'source_id'=r.id ORDER BY r.id COLLATE "C" LOOP
    v_admin:=(v_map->>(v_source.body->>'admin_id'))::uuid;
    v_create:=v_source.decision->'target_id'='null'::jsonb;
    v_target_id:=COALESCE((v_source.decision->>'target_id')::uuid,v_source.id::uuid);
    v_number:=v_source.body->>'customer_id';v_visibility:='[]';
    SELECT * INTO v_target FROM public.simulated_customers WHERE id=v_target_id;
    IF v_create THEN
      IF v_target.id IS NOT NULL THEN v_conflicts:=v_conflicts||'"chat_role_uuid_collision"'::jsonb;END IF;
      IF EXISTS(SELECT 1 FROM public.simulated_customers WHERE customer_id=v_number) THEN
        v_number:='CUS-'||upper(substr(encode(extensions.digest(convert_to(p_job.id::text||':'||v_source.id,'UTF8'),'sha256'),'hex'),1,12));
        IF EXISTS(SELECT 1 FROM public.simulated_customers WHERE customer_id=v_number) THEN
          v_conflicts:=v_conflicts||'"chat_role_number_collision"'::jsonb;
        END IF;
      END IF;
    ELSE
      IF v_target.id IS NULL OR v_target.admin_id IS DISTINCT FROM v_admin
        OR v_target.source_type IS DISTINCT FROM v_source.body->>'source_type' THEN
        v_conflicts:=v_conflicts||'"chat_target_role_invalid"'::jsonb;
      ELSE
        v_number:=v_target.customer_id;
        SELECT COALESCE(jsonb_agg(a.id ORDER BY a.id),'[]') INTO v_visibility
          FROM private.employee_transfer_identity_input(p_job.id,'accounts') AS a
          LEFT JOIN public.admins AS owner ON owner.id=(v_map->>(a.body->>'created_by'))::uuid
          LEFT JOIN public.admins AS role_owner ON role_owner.id=v_admin
          WHERE (v_map->>(a.body->>'created_by')=v_admin::text OR owner.role='super_admin' OR role_owner.role='super_admin')
            AND CASE WHEN jsonb_array_length(COALESCE(NULLIF(v_source.body->'target_employee_ids','null'::jsonb),'[]'::jsonb))>0
              THEN v_source.body->'target_employee_ids' ? a.id::text ELSE true END
            AND COALESCE(cardinality(v_target.target_employee_ids),0)>0
            AND NOT EXISTS(SELECT 1 FROM unnest(v_target.target_employee_ids) AS visible(employee_id) WHERE visible.employee_id=a.id);
      END IF;
    END IF;
    v_roles:=v_roles||jsonb_build_array(jsonb_build_object('source_id',v_source.id,'target_id',v_target_id,
      'action',CASE WHEN v_create THEN 'create' ELSE 'merge' END,'number',v_number,'visibility_employee_ids',v_visibility,
      'allow_visibility',v_source.decision->'allow_visibility','multi_source_target',false));
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_roles) AS r WHERE r->>'action'='create' GROUP BY r->>'number' HAVING count(*)>1) THEN
    v_conflicts:=v_conflicts||'"chat_role_number_collision"'::jsonb;
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_set(r,'{multi_source_target}',to_jsonb((SELECT count(*)>1 FROM jsonb_array_elements(v_roles) AS x
    WHERE x->>'target_id'=r->>'target_id'))) ORDER BY r->>'source_id' COLLATE "C"),'[]') INTO v_roles FROM jsonb_array_elements(v_roles) AS r;
  SELECT COALESCE(jsonb_agg(value ORDER BY value#>>'{}' COLLATE "C"),'[]') INTO v_conflicts
    FROM (SELECT DISTINCT value FROM jsonb_array_elements(v_conflicts)) AS reasons;
  v_target_hash:=private.employee_transfer_chat_target_hash();
  v_plan:=jsonb_build_object('scope','chat-merge','checked',true,'decisions',v_decisions,'roles',v_roles,'counts',v_counts,'conflicts',v_conflicts,
    'can_prepare_backup',jsonb_array_length(v_conflicts)=0,'can_restore',false,'backup_required',true,'media_pending',true,
    'maintenance',true,'replacement_ready',false,'full_site_complete',false,'target_hash',v_target_hash);
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(jsonb_build_object('plan',v_plan,
    'catalog',p_job.summary->'chat_catalog','admin_map',v_map,'job_id',p_job.id,'package_id',p_job.options->'package_id')::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.get_employee_import_chat_merge_plan(p_admin_session_token uuid,p_job_token uuid,p_decisions jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  RETURN private.employee_transfer_chat_merge_plan(private.employee_transfer_notification_job(p_admin_session_token,p_job_token),p_decisions);
END;
$$;

-- Writer lock order: ten chat tables -> maintenance advisory shared -> job -> backup.
CREATE FUNCTION private.employee_transfer_chat_lock()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;
BEGIN
  PERFORM private.employee_transfer_chat_schema();
  FOREACH v_key IN ARRAY private.employee_transfer_chat_keys() LOOP
    IF private.employee_transfer_chat_relation(v_key) IS NOT NULL THEN EXECUTE format('LOCK TABLE public.%I IN SHARE MODE',v_key);END IF;
  END LOOP;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance',0));
  PERFORM private.employee_transfer_assert_maintenance_guards();
END;
$$;

-- A target uuid[] may legally contain SQL NULL. Strip JSON null only in this validation
-- copy; [null], [], SQL NULL and mixed arrays remain byte-for-byte distinct in the snapshot.
CREATE FUNCTION private.employee_transfer_check_chat_backup_row(p_key text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_validation jsonb:=p_row;v_ids jsonb;
BEGIN
  IF p_key='simulated_customers' AND jsonb_typeof(p_row->'target_employee_ids')='array' THEN
    SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinal) FILTER (WHERE item.value<>'null'::jsonb),'[]'::jsonb)
      INTO v_ids FROM jsonb_array_elements(p_row->'target_employee_ids') WITH ORDINALITY AS item(value,ordinal);
    v_validation:=jsonb_set(v_validation,'{target_employee_ids}',v_ids);
  END IF;
  PERFORM private.employee_transfer_check_chat_row(p_key,v_validation);
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_check_snapshot(p_backup private.employee_transfer_chat_backups)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_key text;v_table jsonb;v_payload jsonb;v_row_count integer;v_text text;v_line text;v_json json;v_cursor text;v_last text;
  v_count bigint;v_hashes text;v_total bigint:=0;v_index integer:=0;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_backup.catalog,ARRAY['version','scope','site_id','package_id','tables','media_included','full_site_complete'])
    OR p_backup.catalog->'version' IS DISTINCT FROM '1'::jsonb OR p_backup.catalog->>'scope' IS DISTINCT FROM 'chat-backup'
    OR p_backup.catalog->'media_included' IS DISTINCT FROM 'false'::jsonb OR p_backup.catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb
    OR p_backup.catalog->'site_id' IS DISTINCT FROM to_jsonb((SELECT site_id FROM private.employee_transfer_site))
    OR p_backup.catalog->'package_id' IS DISTINCT FROM (SELECT options->'package_id' FROM private.employee_transfer_jobs WHERE id=p_backup.job_id)
    OR jsonb_typeof(p_backup.catalog->'tables') IS DISTINCT FROM 'array' OR jsonb_array_length(p_backup.catalog->'tables')<>10 THEN
    RAISE EXCEPTION 'Invalid chat backup catalog.';
  END IF;
  IF (SELECT count(*) FROM private.employee_transfer_staging WHERE job_id=p_backup.job_id AND table_key LIKE 'chat-backup:%')<>10 THEN
    RAISE EXCEPTION 'Chat backup snapshot is incomplete.';
  END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_chat_keys() LOOP
    v_table:=p_backup.catalog->'tables'->v_index;v_index:=v_index+1;
    SELECT payload,row_count INTO v_payload,v_row_count FROM private.employee_transfer_staging WHERE job_id=p_backup.job_id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='chat-backup:'||v_key AND chunk_no=0;
    v_text:=v_payload->>'ndjson';v_count:=0;v_hashes:='';v_last:=NULL;
    IF v_text IS NULL OR (v_text<>'' AND right(v_text,1)<>E'\n') THEN RAISE EXCEPTION 'Invalid chat backup snapshot.';END IF;
    IF v_text<>'' THEN FOR v_line IN SELECT line FROM unnest(string_to_array(left(v_text,length(v_text)-1),E'\n')) AS s(line) LOOP
      v_json:=v_line::json;
      IF octet_length(v_line)+1>65536 OR NOT private.employee_transfer_chat_unique_json(v_json) THEN RAISE EXCEPTION 'Invalid chat backup row.';END IF;
      PERFORM private.employee_transfer_check_chat_backup_row(v_key,v_json::jsonb);
      v_cursor:=v_json->>'id';
      IF v_last IS NOT NULL AND v_last COLLATE "C">=v_cursor COLLATE "C" THEN RAISE EXCEPTION 'Invalid chat backup row order.';END IF;
      v_last:=v_cursor;v_count:=v_count+1;v_hashes:=v_hashes||encode(extensions.digest(convert_to(v_line||E'\n','UTF8'),'sha256'),'hex');
    END LOOP;END IF;
    v_total:=v_total+octet_length(v_text);
    IF NOT private.employee_transfer_exact_object(v_table,ARRAY['key','rows','bytes','row_hashes_sha256']) OR v_table->>'key' IS DISTINCT FROM v_key
      OR v_table->'rows' IS DISTINCT FROM to_jsonb(v_count) OR v_table->'bytes' IS DISTINCT FROM to_jsonb(octet_length(v_text))
      OR v_count IS DISTINCT FROM v_row_count::bigint OR v_count>1000000 OR v_total>8388608
      OR (v_key='simulated_customers' AND v_count>2000)
      OR v_table->>'row_hashes_sha256' IS DISTINCT FROM encode(extensions.digest(convert_to(v_hashes,'UTF8'),'sha256'),'hex') THEN
      RAISE EXCEPTION 'Chat backup snapshot verification failed.';
    END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION public.employee_import_chat_backup_prepare(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text,p_decisions jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_plan jsonb;v_backup private.employee_transfer_chat_backups%ROWTYPE;
  v_key text;v_query text;v_text text;v_rows bigint;v_bytes bigint;v_largest bigint;v_hash text;v_total bigint:=0;v_tables jsonb:='[]';v_row record;v_catalog jsonb;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_chat_lock();
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  v_plan:=private.employee_transfer_chat_merge_plan(v_job,p_decisions);
  IF p_plan_hash IS DISTINCT FROM v_plan->>'plan_hash' OR v_plan->'can_prepare_backup' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'A matching conflict-free chat configuration plan is required.';
  END IF;
  SELECT * INTO v_backup FROM private.employee_transfer_chat_backups WHERE job_id=v_job.id FOR UPDATE;
  IF v_backup.id IS NOT NULL THEN
    IF v_backup.plan_hash IS DISTINCT FROM p_plan_hash OR v_backup.target_hash IS DISTINCT FROM v_plan->>'target_hash' THEN
      RAISE EXCEPTION 'Chat target or plan changed after backup preparation; restart the task.';
    END IF;
    PERFORM private.employee_transfer_chat_check_snapshot(v_backup);
  ELSE
    FOREACH v_key IN ARRAY private.employee_transfer_chat_keys() LOOP
      v_query:=private.employee_transfer_chat_query(v_key);
      EXECUTE 'SELECT count(*),COALESCE(sum(octet_length(body::text||E''\n'')),0),COALESCE(max(octet_length(body::text||E''\n'')),0) FROM ('||v_query||') AS r' INTO v_rows,v_bytes,v_largest;
      v_total:=v_total+v_bytes;
      IF v_rows>1000000 OR (v_key='simulated_customers' AND v_rows>2000) OR v_total>8388608 OR v_largest>65536 THEN RAISE EXCEPTION 'Chat backup exceeds limits; no data was truncated.';END IF;
      FOR v_row IN EXECUTE v_query LOOP
        IF NOT private.employee_transfer_chat_unique_json(v_row.body::text::json) THEN RAISE EXCEPTION 'Chat backup JSON exceeds depth limits.';END IF;
        PERFORM private.employee_transfer_check_chat_backup_row(v_key,v_row.body);
      END LOOP;
      EXECUTE 'SELECT COALESCE(string_agg(body::text||E''\n'','''' ORDER BY id COLLATE "C"),''''),
        encode(extensions.digest(convert_to(COALESCE(string_agg(encode(extensions.digest(convert_to(body::text||E''\n'',''UTF8''),''sha256''),''hex''),'''' ORDER BY id COLLATE "C"),''''),''UTF8''),''sha256''),''hex'') FROM ('||v_query||') AS r'
        INTO v_text,v_hash;
      INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
        VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','chat-backup:'||v_key,0,v_rows,
          jsonb_build_object('ndjson',v_text));
      v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_rows,'bytes',v_bytes,'row_hashes_sha256',v_hash));
    END LOOP;
    v_catalog:=jsonb_build_object('version',1,'scope','chat-backup','site_id',(SELECT site_id FROM private.employee_transfer_site),
      'package_id',v_job.options->'package_id',
      'tables',v_tables,'media_included',false,'full_site_complete',false);
    INSERT INTO private.employee_transfer_chat_backups(job_id,admin_id,plan_hash,target_hash,catalog)
      VALUES(v_job.id,v_job.admin_id,p_plan_hash,v_plan->>'target_hash',v_catalog) RETURNING * INTO v_backup;
    PERFORM private.employee_transfer_chat_check_snapshot(v_backup);
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','chat_backup_prepared',
      jsonb_build_object('backup_id',v_backup.id,'plan_hash',p_plan_hash,'target_hash',v_backup.target_hash,'bytes',v_total,'tables',10));
  END IF;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('chat_decisions',v_plan->'decisions') WHERE id=v_job.id;
  RETURN jsonb_build_object('backup_id',v_backup.id,'plan_hash',v_backup.plan_hash,'target_hash',v_backup.target_hash,'catalog',v_backup.catalog);
END;
$$;

CREATE FUNCTION public.get_employee_import_chat_backup_page(p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_backup private.employee_transfer_chat_backups%ROWTYPE;v_text text;v_line text;v_result text:='';
  v_count integer:=0;v_cursor text;v_last text;v_found boolean:=p_after IS NULL;v_more boolean:=false;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  IF p_table_key IS NULL OR NOT p_table_key=ANY(private.employee_transfer_chat_keys()) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
    OR (p_after IS NOT NULL AND length(p_after)>256) THEN RAISE EXCEPTION 'Invalid chat backup page size, table or cursor.';END IF;
  SELECT * INTO v_backup FROM private.employee_transfer_chat_backups WHERE id=p_backup_id AND job_id=v_job.id AND admin_id=v_job.admin_id;
  IF v_backup.id IS NULL THEN RAISE EXCEPTION 'Chat backup is unavailable.';END IF;
  SELECT payload->>'ndjson' INTO v_text FROM private.employee_transfer_staging WHERE job_id=v_job.id
    AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='chat-backup:'||p_table_key AND chunk_no=0;
  IF v_text IS NULL THEN RAISE EXCEPTION 'Chat backup snapshot is incomplete.';END IF;
  IF v_text<>'' THEN FOR v_line IN SELECT line FROM unnest(string_to_array(left(v_text,length(v_text)-1),E'\n')) AS s(line) LOOP
    v_cursor:=v_line::jsonb->>'id';
    IF v_cursor=p_after THEN v_found:=true;END IF;
    IF p_after IS NOT NULL AND v_cursor COLLATE "C"<=p_after COLLATE "C" THEN CONTINUE;END IF;
    IF v_count=p_limit OR octet_length(v_result)+octet_length(v_line)+1>262144 THEN v_more:=true;EXIT;END IF;
    v_result:=v_result||v_line||E'\n';v_count:=v_count+1;v_last:=v_cursor;
  END LOOP;END IF;
  IF NOT v_found THEN RAISE EXCEPTION 'Chat backup cursor is not canonical or does not exist.';END IF;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_result,'next_after',CASE WHEN v_more THEN v_last ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_result,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_import_chat_backup_verify(p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_backup private.employee_transfer_chat_backups%ROWTYPE;v_plan jsonb;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  SELECT * INTO v_backup FROM private.employee_transfer_chat_backups WHERE id=p_backup_id AND job_id=v_job.id AND admin_id=v_job.admin_id;
  IF v_backup.id IS NULL THEN RAISE EXCEPTION 'Chat backup is unavailable.';END IF;
  v_plan:=private.employee_transfer_chat_merge_plan(v_job,v_job.summary->'chat_decisions');
  IF v_plan->>'plan_hash' IS DISTINCT FROM v_backup.plan_hash OR v_plan->>'target_hash' IS DISTINCT FROM v_backup.target_hash
    OR v_plan->'can_prepare_backup' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Chat target or plan changed after backup preparation.';END IF;
  PERFORM private.employee_transfer_chat_check_snapshot(v_backup);
  RETURN jsonb_build_object('verified',true,'backup_id',v_backup.id,'plan_hash',v_backup.plan_hash,'target_hash',v_backup.target_hash,'media_included',false,'media_pending',true,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_chat_backup_append(p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_chunk_no integer,p_hex text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_backup private.employee_transfer_chat_backups%ROWTYPE;v_chunk bytea;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_chat_lock();
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  IF p_hex IS NULL OR length(p_hex) NOT BETWEEN 2 AND 262144 OR length(p_hex)%2<>0 OR p_hex!~'^[0-9a-f]+$'
    OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 1023 THEN RAISE EXCEPTION 'Invalid encrypted chat backup chunk.';END IF;
  SELECT * INTO v_backup FROM private.employee_transfer_chat_backups WHERE id=p_backup_id AND job_id=v_job.id AND admin_id=v_job.admin_id FOR UPDATE;
  IF v_backup.id IS NULL OR v_backup.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'Chat backup does not accept encrypted chunks.';END IF;
  v_chunk:=decode(p_hex,'hex');
  IF p_chunk_no>cardinality(v_backup.chunks) THEN RAISE EXCEPTION 'Chat backup chunks must be contiguous.';END IF;
  v_repeated:=p_chunk_no<cardinality(v_backup.chunks);
  IF v_repeated THEN
    IF v_backup.chunks[p_chunk_no+1] IS DISTINCT FROM v_chunk THEN RAISE EXCEPTION 'Encrypted chat backup chunk has different contents.';END IF;
  ELSE
    IF v_backup.byte_count+octet_length(v_chunk)>9437184 THEN RAISE EXCEPTION 'Encrypted chat backup exceeds the limit.';END IF;
    IF cardinality(v_backup.chunks)>0 AND octet_length(v_backup.chunks[cardinality(v_backup.chunks)])<>131072 THEN
      RAISE EXCEPTION 'Only the last chat backup chunk may be short.';
    END IF;
    UPDATE private.employee_transfer_chat_backups SET chunks=array_append(chunks,v_chunk),byte_count=byte_count+octet_length(v_chunk) WHERE id=v_backup.id;
  END IF;
  RETURN jsonb_build_object('success',true,'bytes',octet_length(v_chunk),'sha256',encode(extensions.digest(v_chunk,'sha256'),'hex'),'repeated',v_repeated,'media_pending',true,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_chat_backup_seal(p_admin_session_token uuid,p_job_token uuid,p_backup_id uuid,p_sha256 text,p_bytes integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_backup private.employee_transfer_chat_backups%ROWTYPE;v_cipher bytea;v_hash text;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_chat_lock();
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  SELECT * INTO v_backup FROM private.employee_transfer_chat_backups WHERE id=p_backup_id AND job_id=v_job.id AND admin_id=v_job.admin_id FOR UPDATE;
  IF v_backup.id IS NULL OR p_bytes IS NULL OR p_sha256 IS NULL OR p_sha256!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid chat backup seal request.';END IF;
  PERFORM public.employee_import_chat_backup_verify(p_admin_session_token,p_job_token,p_backup_id);
  SELECT string_agg(chunk,''::bytea ORDER BY ordinal) INTO v_cipher FROM unnest(v_backup.chunks) WITH ORDINALITY AS s(chunk,ordinal);
  v_hash:=encode(extensions.digest(v_cipher,'sha256'),'hex');
  IF v_backup.byte_count<>p_bytes OR octet_length(v_cipher) IS DISTINCT FROM p_bytes OR p_bytes<64
    OR substring(v_cipher FROM 1 FOR 8) IS DISTINCT FROM convert_to('EDXSTRM1','UTF8') OR v_hash IS DISTINCT FROM p_sha256 THEN
    RAISE EXCEPTION 'Encrypted chat backup does not match its seal.';
  END IF;
  v_repeated:=v_backup.sealed_at IS NOT NULL;
  IF v_repeated AND (v_backup.sealed_sha256 IS DISTINCT FROM p_sha256 OR v_backup.byte_count IS DISTINCT FROM p_bytes) THEN
    RAISE EXCEPTION 'Chat backup is already sealed with different contents.';
  END IF;
  IF NOT v_repeated THEN
    UPDATE private.employee_transfer_chat_backups SET sealed_sha256=v_hash,sealed_at=clock_timestamp() WHERE id=v_backup.id;
    PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','chat_backup_sealed',
      jsonb_build_object('backup_id',v_backup.id,'sha256',v_hash,'bytes',p_bytes,'media_pending',true,'full_site_complete',false));
  END IF;
  RETURN jsonb_build_object('success',true,'backup_id',v_backup.id,'sha256',v_hash,'bytes',p_bytes,'repeated',v_repeated,'media_pending',true,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_chat_saved_backup_chunk(p_admin_session_token uuid,p_backup_id uuid,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid;v_backup private.employee_transfer_chat_backups%ROWTYPE;v_chunk bytea;
BEGIN
  SELECT admin_id INTO v_admin FROM private.employee_transfer_admin(p_admin_session_token);
  SELECT * INTO v_backup FROM private.employee_transfer_chat_backups WHERE id=p_backup_id AND admin_id=v_admin AND sealed_at IS NOT NULL;
  IF v_backup.id IS NULL OR p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>=cardinality(v_backup.chunks) THEN
    RAISE EXCEPTION 'Saved chat backup or chunk is unavailable.';
  END IF;
  v_chunk:=v_backup.chunks[p_chunk_no+1];
  RETURN jsonb_build_object('backup_id',v_backup.id,'chunk_no',p_chunk_no,'hex',encode(v_chunk,'hex'),'sha256',v_backup.sealed_sha256,
    'bytes',v_backup.byte_count,'chunks',cardinality(v_backup.chunks));
END;
$$;

-- Do not enumerate chat helpers by prefix: SQL31's service-only media ACL must survive.
REVOKE ALL ON FUNCTION private.employee_transfer_chat_discard_unsealed(),
  private.employee_transfer_chat_merge_plan(private.employee_transfer_jobs,jsonb),
  private.employee_transfer_chat_lock(),private.employee_transfer_chat_check_snapshot(private.employee_transfer_chat_backups),
  private.employee_transfer_check_chat_backup_row(text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_employee_import_chat_merge_plan(uuid,uuid,jsonb),
  public.employee_import_chat_backup_prepare(uuid,uuid,text,jsonb),
  public.get_employee_import_chat_backup_page(uuid,uuid,uuid,text,text,integer),
  public.employee_import_chat_backup_verify(uuid,uuid,uuid),public.employee_import_chat_backup_append(uuid,uuid,uuid,integer,text),
  public.employee_import_chat_backup_seal(uuid,uuid,uuid,text,integer),public.get_employee_chat_saved_backup_chunk(uuid,uuid,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_import_chat_merge_plan(uuid,uuid,jsonb),
  public.employee_import_chat_backup_prepare(uuid,uuid,text,jsonb),
  public.get_employee_import_chat_backup_page(uuid,uuid,uuid,text,text,integer),
  public.employee_import_chat_backup_verify(uuid,uuid,uuid),public.employee_import_chat_backup_append(uuid,uuid,uuid,integer,text),
  public.employee_import_chat_backup_seal(uuid,uuid,uuid,text,integer),public.get_employee_chat_saved_backup_chunk(uuid,uuid,integer)
  TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
