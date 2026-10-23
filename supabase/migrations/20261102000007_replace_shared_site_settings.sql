CREATE TABLE private.employee_transfer_shared_backups (
  id uuid PRIMARY KEY REFERENCES private.employee_transfer_jobs(id),
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
ALTER TABLE private.employee_transfer_shared_backups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.employee_transfer_shared_backups FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.employee_transfer_discard_unsealed_backup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $$
BEGIN
  DELETE FROM private.employee_transfer_shared_backups WHERE id=NEW.id AND sealed_at IS NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER discard_unsealed_transfer_backup AFTER UPDATE OF status ON private.employee_transfer_jobs
FOR EACH ROW WHEN (NEW.status <> 'running') EXECUTE FUNCTION private.employee_transfer_discard_unsealed_backup();
REVOKE ALL ON FUNCTION private.employee_transfer_discard_unsealed_backup() FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.employee_transfer_shared_replace_job(p_session uuid,p_token uuid)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_shared_import_job(p_session,p_token);
  IF v_job.options->>'replace_policy' IS DISTINCT FROM 'source-v1' THEN
    RAISE EXCEPTION 'The task does not permit shared replacement.';
  END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION public.employee_import_shared_replace_begin(p_admin_session_token uuid,p_admin_password text,p_package_id uuid,p_catalog jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  v_result:=public.employee_import_shared_begin(p_admin_session_token,p_admin_password,p_package_id,p_catalog);
  IF (v_result->>'success')::boolean THEN
    UPDATE private.employee_transfer_jobs SET options=options||'{"replace_policy":"source-v1"}'::jsonb
    WHERE id=(v_result->>'job_id')::uuid;
  END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.employee_transfer_shared_replace_plan(p_job private.employee_transfer_jobs,p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE
  v_row jsonb; v_target jsonb; v_mapped jsonb; v_key text; v_id text; v_target_id text;
  v_reason text; v_action text; v_natural text; v_count integer; v_exact boolean;
  v_admin_map jsonb:='{}'; v_group_map jsonb:='{}'; v_admins jsonb:='[]'; v_records jsonb:='[]';
  v_conflicts jsonb:='[]'; v_seen text[]:='{}'; v_precise text[]:='{}'; v_plan jsonb; v_target_hash text;
BEGIN
  PERFORM private.employee_transfer_check_shared_input(p_data);
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_data->'admins') ORDER BY value->>'id' LOOP
    v_id:=v_row->>'id'; v_reason:=NULL; v_target:=NULL; v_target_id:=v_id; v_action:='create';
    IF v_row->>'role'='super_admin' THEN v_target_id:=p_job.admin_id::text; v_action:='map-super';
    ELSE
      SELECT body INTO v_target FROM private.employee_transfer_shared_rows('admins') WHERE body->>'username'=v_row->>'username';
      IF v_target IS NOT NULL THEN v_target_id:=v_target->>'id'; v_action:='replace'; END IF;
      IF v_target->>'role'='super_admin' THEN v_reason:='target_super_identity_protected';
      ELSIF EXISTS(SELECT 1 FROM public.admins WHERE id=v_id::uuid AND (v_target IS NULL OR id<>v_target_id::uuid)) THEN v_reason:='administrator_id_conflict';
      ELSIF EXISTS(SELECT 1 FROM public.users WHERE username=v_row->>'username') THEN v_reason:='username_matches_employee';
      ELSIF EXISTS(SELECT 1 FROM public.notification_automation_plans WHERE owner_admin_id=v_target_id::uuid AND status='active') THEN
        v_reason:='target_automation_maintenance_required';
      END IF;
    END IF;
    v_admin_map:=v_admin_map||jsonb_build_object(v_id,v_target_id);
    IF v_reason IS NOT NULL THEN
      v_action:='conflict'; v_conflicts:=v_conflicts||jsonb_build_array(jsonb_build_object('table_key','admins','source_id',v_id,'reason',v_reason));
    END IF;
    v_admins:=v_admins||jsonb_build_array(jsonb_build_object('source_id',v_id,'target_id',v_target_id,'username',v_row->'username','role',v_row->'role','action',v_action));
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['admin_groups','admin_group_members','admin_configs','system_configs','history_cleanup_config'] LOOP
    v_seen:='{}'; v_precise:='{}';
    FOR v_row IN SELECT value FROM jsonb_array_elements(p_data->v_key) ORDER BY COALESCE(value->>'id',value->>'key',value->>'table_name') LOOP
      v_id:=COALESCE(v_row->>'id',v_row->>'key',v_row->>'table_name'); v_target_id:=v_id;
      v_target:=NULL; v_reason:=NULL; v_mapped:=v_row; v_exact:=false; v_natural:=NULL;
      IF v_key='admin_groups' THEN
        v_mapped:=jsonb_set(v_row,'{created_by}',v_admin_map->(v_row->>'created_by'));
        SELECT count(*) INTO v_count FROM public.admin_groups WHERE name=v_row->>'name' AND created_by=(v_mapped->>'created_by')::uuid;
        IF v_count>1 THEN v_reason:='ambiguous_target_group'; END IF;
        SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key) WHERE body->>'name'=v_row->>'name' AND body->>'created_by'=v_mapped->>'created_by' ORDER BY cursor LIMIT 1;
        IF v_target IS NOT NULL THEN v_target_id:=v_target->>'id'; END IF;
        IF EXISTS(SELECT 1 FROM public.admin_groups WHERE id=v_id::uuid AND (v_target IS NULL OR id<>v_target_id::uuid)) THEN v_reason:='group_id_conflict'; END IF;
        v_natural:=(v_mapped->>'created_by')||':'||(v_row->>'name');
        v_group_map:=v_group_map||jsonb_build_object(v_id,v_target_id);
        v_mapped:=jsonb_set(v_mapped,'{id}',to_jsonb(v_target_id));
      ELSIF v_key='admin_group_members' THEN
        v_mapped:=jsonb_set(jsonb_set(v_row,'{admin_id}',v_admin_map->(v_row->>'admin_id')),'{group_id}',v_group_map->(v_row->>'group_id'));
        SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key) WHERE cursor=v_id;
        IF v_target IS NOT NULL AND (v_target->>'group_id' IS DISTINCT FROM v_mapped->>'group_id' OR v_target->>'admin_id' IS DISTINCT FROM v_mapped->>'admin_id') THEN
          v_reason:='membership_id_conflict';
        END IF;
        v_natural:=(v_mapped->>'group_id')||':'||(v_mapped->>'admin_id');
      ELSIF v_key='admin_configs' THEN
        IF v_row->>'admin_id' IS NOT NULL THEN v_mapped:=jsonb_set(v_row,'{admin_id}',v_admin_map->(v_row->>'admin_id')); END IF;
        SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key) WHERE cursor=v_id;
        v_exact:=v_target IS NOT NULL;
        IF v_exact AND (v_target->>'admin_id' IS DISTINCT FROM v_mapped->>'admin_id' OR v_target->>'config_type' IS DISTINCT FROM v_mapped->>'config_type') THEN
          v_reason:='setting_id_conflict';
        END IF;
        IF NOT v_exact THEN
          SELECT count(*) INTO v_count FROM public.admin_configs WHERE admin_id IS NOT DISTINCT FROM (v_mapped->>'admin_id')::uuid AND config_type=v_row->>'config_type';
          IF v_count>1 THEN v_reason:='ambiguous_target_setting'; END IF;
          SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key) WHERE body->>'admin_id' IS NOT DISTINCT FROM v_mapped->>'admin_id'
            AND body->>'config_type'=v_row->>'config_type' ORDER BY cursor LIMIT 1;
        END IF;
        SELECT count(*) INTO v_count FROM public.admin_configs WHERE admin_id IS NOT DISTINCT FROM (v_mapped->>'admin_id')::uuid AND config_type=v_row->>'config_type';
        IF v_count>1 AND (
          (SELECT count(*) FROM jsonb_array_elements(p_data->'admin_configs') AS source(value)
            WHERE (v_admin_map->>(source.value->>'admin_id')) IS NOT DISTINCT FROM v_mapped->>'admin_id' AND source.value->>'config_type'=v_row->>'config_type')<>v_count
          OR EXISTS(SELECT 1 FROM private.employee_transfer_shared_rows(v_key) AS target
            WHERE target.body->>'admin_id' IS NOT DISTINCT FROM v_mapped->>'admin_id' AND target.body->>'config_type'=v_row->>'config_type'
              AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_data->'admin_configs') AS source(value)
                WHERE (jsonb_set(source.value,'{admin_id}',COALESCE(v_admin_map->(source.value->>'admin_id'),'null'::jsonb))-ARRAY['created_at','updated_at'])
                  =(target.body-ARRAY['created_at','updated_at'])))
        ) THEN v_reason:='ambiguous_target_setting'; END IF;
        IF v_target IS NOT NULL THEN v_target_id:=v_target->>'id'; END IF;
        IF COALESCE(v_mapped->>'icon_custom_url','')<>'' OR COALESCE(v_target->>'icon_custom_url','')<>'' THEN v_reason:='media_backup_and_rewrite_required'; END IF;
        v_mapped:=jsonb_set(v_mapped,'{id}',to_jsonb(v_target_id));
        v_natural:=COALESCE(v_mapped->>'admin_id','global')||':'||(v_row->>'config_type');
        IF v_target IS NOT NULL THEN
          v_target:=v_target-ARRAY['created_at','updated_at']; v_mapped:=v_mapped-ARRAY['created_at','updated_at'];
        END IF;
      ELSE
        SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key) WHERE cursor=v_id;
        IF v_key='history_cleanup_config' AND (v_target IS NULL OR v_target IS DISTINCT FROM v_row) THEN v_reason:='retention_maintenance_required'; END IF;
      END IF;
      IF v_natural IS NOT NULL THEN
        IF v_natural=ANY(v_seen) THEN
          IF NOT (v_key='admin_configs' AND v_row->>'admin_id' IS NULL AND v_natural=ANY(v_precise) AND v_exact AND v_target=v_mapped) THEN
            v_reason:='mapped_source_identity_collision';
          END IF;
        ELSIF v_key='admin_configs' AND v_row->>'admin_id' IS NULL AND v_exact AND v_target=v_mapped THEN
          v_precise:=array_append(v_precise,v_natural);
        END IF;
        v_seen:=array_append(v_seen,v_natural);
      END IF;
      IF v_target IS NULL THEN v_action:='create'; ELSIF v_target=v_mapped THEN v_action:='reuse'; ELSE v_action:='replace'; END IF;
      IF v_key='admin_group_members' THEN v_action:='replace-members'; END IF;
      IF v_reason IS NOT NULL THEN
        v_action:='conflict'; v_conflicts:=v_conflicts||jsonb_build_array(jsonb_build_object('table_key',v_key,'source_id',v_id,'reason',v_reason));
      END IF;
      v_records:=v_records||jsonb_build_array(jsonb_build_object('table_key',v_key,'source_id',v_id,'target_id',v_target_id,'action',v_action));
    END LOOP;
  END LOOP;
  v_target_hash:=encode(extensions.digest(convert_to(private.employee_transfer_shared_capture()::text,'UTF8'),'sha256'),'hex');
  v_plan:=jsonb_build_object('scope','shared-settings','full_site_complete',false,'can_apply',jsonb_array_length(v_conflicts)=0,
    'admins',v_admins,'conflicts',v_conflicts,'records',v_records,'admin_map',v_admin_map,'group_map',v_group_map,'target_hash',v_target_hash,
    'source_catalog',p_job.options->'catalog');
  RETURN v_plan||jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(v_plan::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.get_employee_import_shared_replace_dry_run(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE; v_plan jsonb; v_capture jsonb; v_key text; v_catalog jsonb;
  v_tables jsonb:='[]'; v_existing private.employee_transfer_shared_backups%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_shared_replace_job(p_admin_session_token,p_job_token);
  IF COALESCE((v_job.summary->>'shared_applied')::boolean,false) THEN RAISE EXCEPTION 'The shared import has already been applied.'; END IF;
  LOCK TABLE public.admins,public.financial_admin_credentials,public.admin_groups,public.admin_group_members,
    public.admin_configs,public.system_configs,public.history_cleanup_config,public.users IN SHARE MODE;
  v_plan:=private.employee_transfer_shared_replace_plan(v_job,private.employee_transfer_shared_import_data(v_job));
  v_capture:=private.employee_transfer_shared_capture();
  SELECT * INTO v_existing FROM private.employee_transfer_shared_backups WHERE id=v_job.id;
  IF v_existing.id IS NOT NULL AND v_existing.plan_hash IS DISTINCT FROM v_plan->>'plan_hash' THEN
    RAISE EXCEPTION 'The target changed after backup preparation; cancel and restart with a new backup.';
  END IF;
  IF (v_plan->>'can_apply')::boolean AND v_existing.id IS NULL THEN
    FOREACH v_key IN ARRAY private.employee_transfer_shared_keys() LOOP
      INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
      VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','shared-backup:'||v_key,0,(v_capture->v_key->>'count')::integer,v_capture->v_key);
      v_tables:=v_tables||jsonb_build_array(jsonb_build_object('key',v_key,'rows',v_capture->v_key->'count','bytes',v_capture->v_key->'bytes','sha256',v_capture->v_key->'sha256'));
    END LOOP;
    SELECT jsonb_build_object('version',1,'scope','shared-settings','site_id',site_id,'tables',v_tables,'excluded_system_keys','[]'::jsonb,'full_site_complete',false)
      INTO v_catalog FROM private.employee_transfer_site;
    INSERT INTO private.employee_transfer_shared_backups(id,admin_id,plan_hash,target_hash,catalog)
    VALUES(v_job.id,v_job.admin_id,v_plan->>'plan_hash',v_plan->>'target_hash',v_catalog);
  END IF;
  UPDATE private.employee_transfer_jobs SET summary=COALESCE(summary,'{}')||jsonb_build_object('shared_replace_plan_hash',v_plan->'plan_hash') WHERE id=v_job.id;
  RETURN v_plan-ARRAY['records','admin_map','group_map','target_hash','source_catalog'];
END;
$$;

CREATE FUNCTION public.get_employee_import_shared_backup(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_shared_replace_job(p_admin_session_token,p_job_token);
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id;
  IF v_backup.id IS NULL THEN RAISE EXCEPTION 'A conflict-free replacement dry run is required before backup.'; END IF;
  RETURN jsonb_build_object('backup_id',v_backup.id,'plan_hash',v_backup.plan_hash,'target_hash',v_backup.target_hash,'catalog',v_backup.catalog);
END;
$$;

CREATE FUNCTION public.get_employee_import_shared_backup_page(p_admin_session_token uuid,p_job_token uuid,p_table_key text,p_after text DEFAULT NULL,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_snapshot jsonb; v_row jsonb; v_text text:=''; v_count integer:=0; v_cursor text; v_more boolean:=false;
BEGIN
  v_job:=private.employee_transfer_shared_replace_job(p_admin_session_token,p_job_token);
  IF p_table_key IS NULL OR p_table_key<>ALL(private.employee_transfer_shared_keys()) OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid backup page request.'; END IF;
  SELECT payload INTO v_snapshot FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000'
    AND table_key='shared-backup:'||p_table_key AND chunk_no=0;
  IF v_snapshot IS NULL THEN RAISE EXCEPTION 'The frozen replacement backup is missing.'; END IF;
  IF p_after IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_snapshot->'rows') WHERE value->>'cursor'=p_after) THEN RAISE EXCEPTION 'Invalid backup cursor.'; END IF;
  FOR v_row IN SELECT value FROM jsonb_array_elements(v_snapshot->'rows') WHERE p_after IS NULL OR (value->>'cursor') COLLATE "C">p_after COLLATE "C" ORDER BY (value->>'cursor') COLLATE "C" LIMIT p_limit+1 LOOP
    IF v_count=p_limit OR octet_length(v_text)+octet_length(v_row->>'ndjson')>262144 THEN v_more:=true; EXIT; END IF;
    v_text:=v_text||(v_row->>'ndjson'); v_count:=v_count+1; v_cursor:=v_row->>'cursor';
  END LOOP;
  RETURN jsonb_build_object('table_key',p_table_key,'count',v_count,'ndjson',v_text,'next_after',CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256',encode(extensions.digest(convert_to(v_text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.employee_import_shared_backup_append(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text,p_chunk_no integer,p_hex text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE; v_chunk bytea; v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_shared_replace_job(p_admin_session_token,p_job_token);
  IF p_hex IS NULL OR length(p_hex) NOT BETWEEN 2 AND 262144 OR length(p_hex)%2<>0 OR p_hex!~'^[0-9a-f]+$'
    OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 1023 THEN RAISE EXCEPTION 'Invalid encrypted backup chunk.'; END IF;
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id FOR UPDATE;
  IF v_backup.id IS NULL OR p_plan_hash IS DISTINCT FROM v_backup.plan_hash OR v_backup.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'The backup does not accept encrypted chunks.'; END IF;
  v_chunk:=decode(p_hex,'hex');
  IF p_chunk_no>cardinality(v_backup.chunks) THEN RAISE EXCEPTION 'Backup chunks must be contiguous.'; END IF;
  v_repeated:=p_chunk_no<cardinality(v_backup.chunks);
  IF v_repeated THEN
    IF v_backup.chunks[p_chunk_no+1] IS DISTINCT FROM v_chunk THEN RAISE EXCEPTION 'The encrypted backup chunk identity has different contents.'; END IF;
  ELSE
    IF v_backup.byte_count+octet_length(v_chunk)>9437184 THEN RAISE EXCEPTION 'Encrypted backup exceeds the limit.'; END IF;
    UPDATE private.employee_transfer_shared_backups SET chunks=array_append(chunks,v_chunk),byte_count=byte_count+octet_length(v_chunk) WHERE id=v_job.id;
  END IF;
  RETURN jsonb_build_object('success',true,'bytes',octet_length(v_chunk),'sha256',encode(extensions.digest(v_chunk,'sha256'),'hex'),'repeated',v_repeated);
END;
$$;

CREATE FUNCTION public.employee_import_shared_backup_seal(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text,p_sha256 text,p_bytes integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE; v_cipher bytea; v_hash text; v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_shared_replace_job(p_admin_session_token,p_job_token);
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id FOR UPDATE;
  IF v_backup.id IS NULL OR p_plan_hash IS DISTINCT FROM v_backup.plan_hash OR p_bytes IS NULL OR p_sha256 IS NULL OR p_sha256!~'^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid backup seal request.'; END IF;
  SELECT string_agg(chunk,''::bytea ORDER BY ordinal) INTO v_cipher FROM unnest(v_backup.chunks) WITH ORDINALITY AS item(chunk,ordinal);
  v_hash:=encode(extensions.digest(v_cipher,'sha256'),'hex');
  IF v_backup.byte_count<>p_bytes OR p_bytes<64 OR substring(v_cipher FROM 1 FOR 8) IS DISTINCT FROM convert_to('EDXSTRM1','UTF8') OR v_hash IS DISTINCT FROM p_sha256 THEN
    RAISE EXCEPTION 'The saved encrypted backup does not match its seal.';
  END IF;
  v_repeated:=v_backup.sealed_at IS NOT NULL;
  UPDATE private.employee_transfer_shared_backups SET sealed_sha256=v_hash,sealed_at=COALESCE(sealed_at,clock_timestamp()) WHERE id=v_job.id;
  RETURN jsonb_build_object('success',true,'backup_id',v_backup.id,'sha256',v_hash,'bytes',p_bytes,'repeated',v_repeated,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.get_employee_shared_saved_backup_chunk(p_admin_session_token uuid,p_backup_id uuid,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $$
DECLARE v_admin uuid; v_backup private.employee_transfer_shared_backups%ROWTYPE; v_chunk bytea;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_admin_session_token) AS admin;
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=p_backup_id AND admin_id=v_admin AND sealed_at IS NOT NULL;
  IF v_backup.id IS NULL OR p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>=cardinality(v_backup.chunks) THEN RAISE EXCEPTION 'The saved backup or chunk is unavailable.'; END IF;
  v_chunk:=v_backup.chunks[p_chunk_no+1];
  RETURN jsonb_build_object('backup_id',v_backup.id,'chunk_no',p_chunk_no,'hex',encode(v_chunk,'hex'),'sha256',v_backup.sealed_sha256,
    'bytes',v_backup.byte_count,'chunks',cardinality(v_backup.chunks));
END;
$$;

DO $install_shared_replace_audit$
DECLARE v_system_hash text; v_system_portable text; v_system_native text; v_mode text;
BEGIN
  SELECT encode(extensions.digest(convert_to(pg_get_functiondef(t.tgfoid),'UTF8'),'sha256'),'hex'),
    private.employee_transfer_install_trigger_digest(t.oid),private.employee_transfer_trigger_digest(t.oid),t.tgenabled::text
    INTO v_system_hash,v_system_portable,v_system_native,v_mode FROM pg_trigger t
    WHERE t.tgrelid='public.system_configs'::regclass AND t.tgname='set_system_configs_updated_at' AND NOT t.tgisinternal;
  IF v_system_hash IS NULL OR (v_system_hash<>'7f6bfa6679e72e65ae1616b97cc13d193d547875cc3e396ce3041e9001eff52b'
    AND (v_system_portable IS DISTINCT FROM 'bf0f92dac810b8bc136d768b846c7f0c687acf0ad43d611d17744d930ebaf045' OR v_mode<>'O')) THEN
    RAISE EXCEPTION 'An unreviewed write trigger prevents shared replacement.';
  END IF;
  EXECUTE format($definition$
CREATE FUNCTION private.employee_transfer_assert_shared_replace_triggers()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $body$
DECLARE v_count integer; v_invalid boolean; v_system_native constant text := %L; v_system_mode constant text := %L;
BEGIN
  PERFORM private.employee_transfer_assert_shared_insert_triggers();
  WITH expected(table_name,trigger_name,definition,function_hash) AS (VALUES
    ('admins','pause_notification_automation_plans_for_disabled_admin','CREATE TRIGGER pause_notification_automation_plans_for_disabled_admin AFTER UPDATE OF is_active ON public.admins FOR EACH ROW EXECUTE FUNCTION pause_notification_automation_plans_for_disabled_admin()', 'd4e6c22e3b65548e2985dfd289bb3b8360f5af1a0f38abf9f8ae7958ea40284a'),
    ('system_configs','set_system_configs_updated_at','CREATE TRIGGER set_system_configs_updated_at BEFORE UPDATE ON public.system_configs FOR EACH ROW EXECUTE FUNCTION update_system_configs_updated_at()', %L)
  )
  SELECT count(*)::integer,COALESCE(bool_or(expected.trigger_name IS NULL OR trigger.tgenabled NOT IN ('O','A') OR pg_get_triggerdef(trigger.oid) IS DISTINCT FROM expected.definition
    OR pg_get_userbyid(procedure.proowner)<>'postgres' OR encode(extensions.digest(convert_to(pg_get_functiondef(procedure.oid),'UTF8'),'sha256'),'hex') IS DISTINCT FROM expected.function_hash
    OR (relation.relname='system_configs' AND (private.employee_transfer_trigger_digest(trigger.oid) IS DISTINCT FROM v_system_native
      OR trigger.tgenabled::text IS DISTINCT FROM v_system_mode))),false)
  INTO v_count,v_invalid FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid=trigger.tgrelid JOIN pg_proc AS procedure ON procedure.oid=trigger.tgfoid
  LEFT JOIN expected ON expected.table_name=relation.relname AND expected.trigger_name=trigger.tgname
  WHERE relation.relnamespace='public'::regnamespace AND NOT trigger.tgisinternal AND (
    (relation.relname=ANY(ARRAY['admins','financial_admin_credentials','admin_financial_sessions']) AND (trigger.tgtype::integer & 20)<>0)
    OR (relation.relname='admin_group_members' AND (trigger.tgtype::integer & 28)<>0)
    OR (relation.relname IN ('admin_groups','admin_configs','system_configs','notification_automation_plans') AND (trigger.tgtype::integer & 16)<>0
      AND NOT (relation.relname IN ('admin_configs','system_configs') AND trigger.tgname IN ('guard_content_audit_public_media_reference','guard_employee_chat_image_reference'))));
  IF v_count<>2 OR v_invalid THEN RAISE EXCEPTION 'An unreviewed write trigger prevents shared replacement.'; END IF;
END;
$body$;
$definition$,v_system_native,v_mode,v_system_hash);
END;
$install_shared_replace_audit$;

CREATE FUNCTION public.employee_import_shared_replace_apply(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_shared_backups%ROWTYPE;
  v_data jsonb; v_plan jsonb; v_map jsonb; v_groups jsonb; v_row jsonb; v_item jsonb; v_key text; v_id uuid; v_parent uuid; v_receipt jsonb;
BEGIN
  v_job:=private.employee_transfer_shared_replace_job(p_admin_session_token,p_job_token);
  IF COALESCE((v_job.summary->>'shared_applied')::boolean,false) THEN
    IF p_plan_hash IS DISTINCT FROM v_job.summary->>'shared_replace_plan_hash' THEN RAISE EXCEPTION 'Replacement confirmation does not match.'; END IF;
    RETURN v_job.summary->'shared_receipt'||'{"repeated":true}'::jsonb;
  END IF;
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_job.summary->>'shared_replace_plan_hash' THEN RAISE EXCEPTION 'A replacement dry run must be confirmed first.'; END IF;
  LOCK TABLE public.admins,public.financial_admin_credentials,public.admin_groups,public.admin_group_members,public.admin_configs,
    public.system_configs,public.history_cleanup_config,public.users,public.admin_financial_sessions,public.notification_automation_plans IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO v_backup FROM private.employee_transfer_shared_backups WHERE id=v_job.id FOR UPDATE;
  IF v_backup.id IS NULL OR v_backup.sealed_at IS NULL OR v_backup.plan_hash IS DISTINCT FROM p_plan_hash THEN RAISE EXCEPTION 'A saved and sealed replacement backup is required.'; END IF;
  PERFORM private.employee_transfer_assert_shared_replace_triggers();
  v_data:=private.employee_transfer_shared_import_data(v_job);
  v_plan:=private.employee_transfer_shared_replace_plan(v_job,v_data);
  IF v_plan->>'plan_hash' IS DISTINCT FROM p_plan_hash OR v_plan->>'target_hash' IS DISTINCT FROM v_backup.target_hash THEN RAISE EXCEPTION 'The target changed after the replacement backup; restart the task.'; END IF;
  IF NOT (v_plan->>'can_apply')::boolean THEN RAISE EXCEPTION 'Shared replacement conflicts must be resolved before applying.'; END IF;
  v_map:=v_plan->'admin_map'; v_groups:=v_plan->'group_map';
  FOR v_row IN WITH RECURSIVE hierarchy AS (
    SELECT value AS row,0 AS depth FROM jsonb_array_elements(v_data->'admins') WHERE value->>'role'<>'super_admin'
      AND (value->>'parent_id' IS NULL OR value->>'parent_id' IN(SELECT value->>'id' FROM jsonb_array_elements(v_data->'admins') WHERE value->>'role'='super_admin'))
    UNION ALL SELECT child.value,parent.depth+1 FROM jsonb_array_elements(v_data->'admins') AS child(value) JOIN hierarchy AS parent ON child.value->>'parent_id'=parent.row->>'id' WHERE child.value->>'role'<>'super_admin'
  ) SELECT row FROM hierarchy ORDER BY depth,row->>'id' LOOP
    v_id:=(v_map->>(v_row->>'id'))::uuid; v_parent:=(v_map->>(v_row->>'parent_id'))::uuid;
    INSERT INTO public.admins(id,username,password_hash,role,parent_id,is_active,is_pinned,created_at,updated_at)
    VALUES(v_id,v_row->>'username',v_row->>'password_hash',v_row->>'role',v_parent,false,(v_row->>'is_pinned')::boolean,(v_row->>'created_at')::timestamptz,(v_row->>'updated_at')::timestamptz)
    ON CONFLICT(id) DO UPDATE SET username=EXCLUDED.username,password_hash=EXCLUDED.password_hash,role=EXCLUDED.role,parent_id=EXCLUDED.parent_id,
      is_active=false,is_pinned=EXCLUDED.is_pinned,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at;
    UPDATE public.admin_financial_sessions SET revoked_at=clock_timestamp() WHERE admin_id=v_id AND revoked_at IS NULL;
  END LOOP;
  INSERT INTO public.financial_admin_credentials(admin_id,password_hash,created_at,updated_at)
    SELECT (v_map->>(value->>'admin_id'))::uuid,value->>'password_hash',(value->>'created_at')::timestamptz,(value->>'updated_at')::timestamptz FROM jsonb_array_elements(v_data->'financial_admin_credentials')
    ON CONFLICT(admin_id) DO UPDATE SET password_hash=EXCLUDED.password_hash,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at;
  FOR v_key IN SELECT unnest(ARRAY['admin_groups','admin_configs','system_configs']) LOOP
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_data->v_key) LOOP
      SELECT value INTO v_item FROM jsonb_array_elements(v_plan->'records') WHERE value->>'table_key'=v_key AND value->>'source_id'=COALESCE(v_row->>'id',v_row->>'key');
      IF v_item->>'action'='reuse' THEN CONTINUE; END IF;
      IF v_key='admin_groups' THEN
        INSERT INTO public.admin_groups(id,name,created_by,created_at,updated_at) VALUES((v_item->>'target_id')::uuid,v_row->>'name',(v_map->>(v_row->>'created_by'))::uuid,(v_row->>'created_at')::timestamptz,(v_row->>'updated_at')::timestamptz)
        ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,created_by=EXCLUDED.created_by,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at;
      ELSIF v_key='admin_configs' THEN
        INSERT INTO public.admin_configs(id,admin_id,config_type,config_value,icon_type,icon_custom_url,created_at,updated_at)
        VALUES((v_item->>'target_id')::uuid,(v_map->>(v_row->>'admin_id'))::uuid,v_row->>'config_type',v_row->>'config_value',v_row->>'icon_type',v_row->>'icon_custom_url',(v_row->>'created_at')::timestamptz,(v_row->>'updated_at')::timestamptz)
        ON CONFLICT(id) DO UPDATE SET config_value=EXCLUDED.config_value,icon_type=EXCLUDED.icon_type,icon_custom_url=EXCLUDED.icon_custom_url,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at;
      ELSE
        INSERT INTO public.system_configs(key,value) VALUES(v_row->>'key',v_row->'value') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
      END IF;
    END LOOP;
  END LOOP;
  DELETE FROM public.admin_group_members WHERE group_id IN(SELECT value::uuid FROM jsonb_each_text(v_groups));
  INSERT INTO public.admin_group_members(id,group_id,admin_id,created_at)
    SELECT (value->>'id')::uuid,(v_groups->>(value->>'group_id'))::uuid,(v_map->>(value->>'admin_id'))::uuid,(value->>'created_at')::timestamptz FROM jsonb_array_elements(v_data->'admin_group_members');
  v_receipt:=jsonb_build_object('success',true,'scope','shared-settings','full_site_complete',false,'repeated',false,'backup_id',v_backup.id,
    'admin_map',v_map,'admin_group_map',v_groups,'created_admins',(SELECT count(*) FROM jsonb_array_elements(v_plan->'admins') WHERE value->>'action'='create'),
    'replaced_admins',(SELECT count(*) FROM jsonb_array_elements(v_plan->'admins') WHERE value->>'action'='replace'));
  UPDATE private.employee_transfer_jobs SET admin_map=v_map,default_admin_id=v_job.admin_id,summary=summary||jsonb_build_object('shared_applied',true,'shared_receipt',v_receipt) WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','shared_replaced',jsonb_build_object('backup_id',v_backup.id,'full_site_complete',false));
  RETURN v_receipt;
EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation OR not_null_violation OR data_exception THEN
  RAISE EXCEPTION 'Shared replacement was rolled back by target validation.' USING ERRCODE='22023';
END;
$$;

ALTER FUNCTION public.employee_import_shared_apply(uuid,uuid,text) SET SCHEMA private;
ALTER FUNCTION private.employee_import_shared_apply(uuid,uuid,text) RENAME TO employee_transfer_shared_create_apply;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_create_apply(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.employee_import_shared_apply(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_shared_import_job(p_admin_session_token,p_job_token);
  IF v_job.options ? 'replace_policy' THEN RAISE EXCEPTION 'A replacement task cannot use the create-only apply operation.'; END IF;
  RETURN private.employee_transfer_shared_create_apply(p_admin_session_token,p_job_token,p_plan_hash);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_shared_replace_job(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_replace_plan(private.employee_transfer_jobs,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_assert_shared_replace_triggers() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.employee_import_shared_replace_begin(uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_employee_import_shared_replace_dry_run(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_employee_import_shared_backup(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_employee_import_shared_backup_page(uuid,uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.employee_import_shared_backup_append(uuid,uuid,text,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.employee_import_shared_backup_seal(uuid,uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_employee_shared_saved_backup_chunk(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.employee_import_shared_replace_apply(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.employee_import_shared_apply(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_shared_replace_begin(uuid,text,uuid,jsonb),public.get_employee_import_shared_replace_dry_run(uuid,uuid),
 public.get_employee_import_shared_backup(uuid,uuid),public.get_employee_import_shared_backup_page(uuid,uuid,text,text,integer),
 public.employee_import_shared_backup_append(uuid,uuid,text,integer,text),public.employee_import_shared_backup_seal(uuid,uuid,text,text,integer),
 public.get_employee_shared_saved_backup_chunk(uuid,uuid,integer),public.employee_import_shared_replace_apply(uuid,uuid,text),public.employee_import_shared_apply(uuid,uuid,text) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
