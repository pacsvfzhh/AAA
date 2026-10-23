BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- SQL26 owns media authorization/readback. No Storage DML, sending, bonus credit,
-- financial DML, employee activation, or maintenance release is performed here.
DO $audit$
DECLARE v_expected constant jsonb := '{
 "messages.audit_notification_change": "f42728300d199cfec10bd81322d00b7a59d09ad9ec3821c080a2b06c9a4a8c2a",
 "messages.sync_messages_delivery_mode": "09b750ca1be41a69464eda622a139d3da10714c54302f900094b6812f7f6b7dd",
 "messages.classify_notification_origin": "b152eda73f57d6552c377f4c7b761ff9054b6df3223c18549aa46d481c4b1a0e",
 "messages.guard_employee_chat_image_reference": "ce90a02b8a9b80a025f349c86dd4c7f5e4004f08ce97b37a302ab03c13586495",
 "messages.inherit_automation_message_delivery_mode": "7d5fa924685f263c9861a8472db04fcee83b2d070b64132398ef64175908a76a",
 "messages.guard_content_audit_public_media_reference": "54fb0974035bd104da891e715ba11e2dc4243d27e3ba72cd11b73d6ab50f52a9",
 "message_recipients.remember_content_audit_recipient": "9cdf4f0a027313832e8b5646b77e1d9a12a79738bcfb7871d911d99ec5501e7d",
 "message_recipients.reject_archived_notification_recipient": "f056b9be7b2af1a63f335fae1fe73d9883589507d7bbdea74bc40269de077012",
 "message_templates.guard_employee_chat_image_reference": "7b1aa37d98d9e7d4516da928f729120a8a2a24434856b0c136e12fa4a1347500",
 "message_templates.sync_message_templates_delivery_mode": "c35f682c336f68e285b527d0a15011e8679017775c59789a422b042bd1ac661b",
 "message_templates.guard_content_audit_public_media_reference": "3516f4a370ac30825168ead26db41ae5b3f35c35eed8e309ae5e531beb53406b",
 "broadcast_messages.guard_employee_chat_image_reference": "c1fab0eb447d6dd0dc609b16e487ec2fb121126a3dbd697f10089e9ee86c01fd",
 "broadcast_messages.guard_content_audit_public_media_reference": "530b44fd255fb009c3f5ee3964f9b7ad35b86d91f0f7b6fcde13d5991406d765",
 "notification_automation_tasks.guard_employee_chat_image_reference": "c40231187d220df8cf4bfa844de322552575f0267bf06bde23bc7f0e4cf55685",
 "notification_automation_tasks.guard_content_audit_public_media_reference": "f701a0a595268865771d518865cd48cc7a40174ce4d6aa9164cd40700523f295",
 "notification_automation_tasks.validate_notification_automation_task_plan": "16f2c09cc86fb36b8821f3aac7bf0f9897181d54919eb4a4be5e539dd868028e",
 "notification_automation_tasks.sync_notification_automation_tasks_delivery_mode": "f35fdce02b8d0e1b0316515b5db2428d40f35a18d06d4d45f691ab9a45f75e6c",
 "notification_automation_executions.guard_employee_chat_image_reference": "0aad1d91d9adbdc1dfa40d0ea08f7e51642ad54795d2c2c6d465d34fc3c837b8",
 "notification_automation_executions.guard_content_audit_public_media_reference": "a1bd242c171412f56500208f785a25a338e5c8f49f1c8de2a1bc195a6bdb58e7",
 "notification_automation_executions.snapshot_notification_automation_execution_plan": "9c08190e941a614188b2849c9885b6bc850f2080f42d536325528da775ac7c3a",
 "notification_automation_plan_members.validate_notification_automation_plan_member": "7287725864598612686569eb1d24cb597f91ceca9c4beee0c254d0a8600531b9"
}'; v_native jsonb; v_actual jsonb; v_modes jsonb;
BEGIN
  SELECT jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_install_trigger_digest(t.oid)),
    jsonb_object_agg(c.relname||'.'||t.tgname,t.tgenabled::text),
    jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_trigger_digest(t.oid)) INTO v_actual,v_modes,v_native
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
      AND c.relname=ANY(private.employee_transfer_notifications_keys()) AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance';
  IF v_actual IS DISTINCT FROM v_expected OR EXISTS(SELECT 1 FROM jsonb_each_text(v_modes) WHERE value NOT IN ('O','A')) THEN
    RAISE EXCEPTION 'Unreviewed notification restore triggers.';
  END IF;
  EXECUTE format($definition$
    CREATE FUNCTION private.employee_transfer_notification_restore_assert()
    RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, private, pg_temp AS $body$
    DECLARE v_expected constant jsonb := %L::jsonb; v_modes constant jsonb := %L::jsonb; v_actual jsonb; v_actual_modes jsonb;
    BEGIN
      PERFORM private.employee_transfer_assert_maintenance_guards();
      PERFORM private.employee_transfer_notifications_schema();
      IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN RAISE EXCEPTION 'Notification restore requires origin mode.'; END IF;
      SELECT jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_trigger_digest(t.oid)),
        jsonb_object_agg(c.relname||'.'||t.tgname,t.tgenabled::text) INTO v_actual,v_actual_modes
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
          AND c.relname=ANY(private.employee_transfer_notifications_keys()) AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance';
      IF v_actual IS DISTINCT FROM v_expected OR v_actual_modes IS DISTINCT FROM v_modes THEN RAISE EXCEPTION 'Unreviewed notification restore triggers.'; END IF;
      IF EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
        WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(private.employee_transfer_notifications_keys())
          AND t.tgisinternal AND t.tgenabled NOT IN ('O','A')) THEN RAISE EXCEPTION 'Notification foreign key protection is disabled.'; END IF;
    END;
    $body$;
  $definition$,v_native::text,v_modes::text);
END;
$audit$;

CREATE FUNCTION private.employee_transfer_notification_restore_lock()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;
BEGIN
  -- Match SQL25 configuration-lock-first order; block evaluators before table DDL.
  PERFORM private.acquire_notification_automation_configuration_lock();
  FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP
    IF private.employee_transfer_notifications_relation(v_key) IS NOT NULL THEN EXECUTE format('LOCK TABLE ONLY public.%I IN ACCESS EXCLUSIVE MODE',v_key); END IF;
  END LOOP;
  LOCK TABLE private.content_audit_recipient_versions IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE public.notification_automation_queue IN SHARE MODE;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance',0));
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_restore_context(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;
BEGIN
  PERFORM private.employee_transfer_notification_restore_assert();
  v_map:=private.employee_transfer_notifications_owner(p_job);
  IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance m WHERE m.singleton AND m.dirty AND m.job_id=p_job.id
    AND m.admin_id=p_job.admin_id AND m.plan_hash=p_job.summary->>'dispatch_plan_hash') THEN
    RAISE EXCEPTION 'The original dirty maintenance owner is required for notification restore.';
  END IF;
  PERFORM private.employee_transfer_check_notifications_input(p_job);
  IF private.employee_transfer_notifications_source_issues(p_job,v_map)<>'[]'::jsonb THEN RAISE EXCEPTION 'Notification source references or rewards conflict.'; END IF;
  IF p_job.summary ? 'notification_restore' AND (p_job.summary#>'{notification_restore,admin_map}' IS DISTINCT FROM v_map
    OR p_job.summary#>'{notification_restore,catalog}' IS DISTINCT FROM p_job.summary->'notifications_catalog') THEN
    RAISE EXCEPTION 'Notification source or administrator mapping changed.';
  END IF;
  IF p_job.summary ? 'notification_restore' AND NOT COALESCE(private.employee_transfer_notification_media_ready(p_job,false),false) THEN
    RAISE EXCEPTION 'Notification media binding or readback changed.';
  END IF;
  RETURN v_map;
END;
$$;

-- Standalone precise bypass, leaving the old transfer policy and all SQL24/25 contracts unchanged.
-- Reviewed side effects: mode normalization, inheriting CURRENT task delivery mode,
-- execution plan re-snapshot. Recipient evidence is retained by its original trigger.
-- There are no baseline/queue/updated_at triggers on these tables in the audited inventory.
CREATE FUNCTION private.employee_transfer_notification_restore_bypass(p_restore jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_entries jsonb; v_item jsonb; v_id uuid:=gen_random_uuid(); v_pending jsonb;
BEGIN
  IF p_restore IS NULL THEN
    PERFORM private.employee_transfer_notification_restore_assert();
    IF private.employee_transfer_pending_trigger_bypass() IS NOT NULL THEN RAISE EXCEPTION 'A trigger bypass is already pending.'; END IF;
    SELECT jsonb_agg(jsonb_build_object('table',c.relname,'trigger',t.tgname,'mode',t.tgenabled::text,
      'digest',private.employee_transfer_trigger_digest(t.oid)) ORDER BY c.relname,t.tgname) INTO v_entries
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND (c.relname,t.tgname) IN (
        ('messages','sync_messages_delivery_mode'),('messages','inherit_automation_message_delivery_mode'),
        ('message_templates','sync_message_templates_delivery_mode'),('notification_automation_tasks','sync_notification_automation_tasks_delivery_mode'),
        ('notification_automation_executions','snapshot_notification_automation_execution_plan'));
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_entries) LOOP
      EXECUTE format('ALTER TABLE ONLY public.%I DISABLE TRIGGER %I',v_item->>'table',v_item->>'trigger');
    END LOOP;
    INSERT INTO private.employee_transfer_events(kind,action,details) VALUES('import','trigger_bypass',
      jsonb_build_object('transaction_id',pg_current_xact_id()::text,'bypass_id',v_id,'entries',v_entries,'scope','notification-restore'));
    RETURN v_entries;
  END IF;
  v_pending:=private.employee_transfer_pending_trigger_bypass();
  IF v_pending IS NULL OR v_pending->>'scope' IS DISTINCT FROM 'notification-restore' OR v_pending->'entries' IS DISTINCT FROM p_restore THEN
    RAISE EXCEPTION 'Notification trigger restore receipt differs.';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_restore) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.'||(v_item->>'table')) AND tgname=v_item->>'trigger'
      AND tgenabled='D' AND private.employee_transfer_trigger_digest(oid)=v_item->>'digest') THEN RAISE EXCEPTION 'Notification bypass trigger changed.'; END IF;
    EXECUTE format('ALTER TABLE ONLY public.%I ENABLE %s TRIGGER %I',v_item->>'table',CASE WHEN v_item->>'mode'='A' THEN 'ALWAYS' ELSE '' END,v_item->>'trigger');
  END LOOP;
  INSERT INTO private.employee_transfer_events(kind,action,details) VALUES('import','trigger_restore',
    jsonb_build_object('transaction_id',pg_current_xact_id()::text,'bypass_id',v_pending->>'bypass_id'));
  PERFORM private.employee_transfer_notification_restore_assert();
  RETURN p_restore;
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_restore_permit(p_job private.employee_transfer_jobs,p_keys text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance WHERE singleton AND dirty AND job_id=p_job.id AND admin_id=p_job.admin_id) THEN
    RAISE EXCEPTION 'Notification maintenance ownership changed.';
  END IF;
  IF p_keys IS NULL OR cardinality(p_keys)=0 OR EXISTS(SELECT 1 FROM unnest(p_keys) s(key) WHERE key IS NULL OR NOT key=ANY(private.employee_transfer_notifications_keys())) THEN
    RAISE EXCEPTION 'Unsupported notification write permit.';
  END IF;
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names)
    SELECT pg_current_xact_id(),p_job.id,array_agg('public.'||key)||
      CASE WHEN 'message_recipients'=ANY(p_keys) THEN ARRAY['private.content_audit_recipient_versions'] ELSE ARRAY[]::text[] END
      FROM unnest(p_keys) AS s(key);
END;
$$;

-- Convert only on the server. jsonb_populate_record casts bigint strings without JS,
-- retains arbitrary numeric precision, and normalizes timestamp representations for comparison.
CREATE FUNCTION private.employee_transfer_notification_restore_row(p_job private.employee_transfer_jobs,p_key text,p_body jsonb,p_unlinked boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_body jsonb:=p_body; v_field text; v_parent text; v_result jsonb; v_sequence text; v_mapping jsonb;
BEGIN
  PERFORM private.employee_transfer_notifications_relation(p_key);
  PERFORM private.employee_transfer_check_notifications_row(p_key,p_body);
  FOR v_field IN SELECT key FROM jsonb_each(v_body) WHERE key IN ('owner_admin_id','admin_id','target_admin_id','sender_id') LOOP
    IF v_body->>v_field IS NOT NULL THEN
      v_result:=p_job.summary#>'{notification_restore,admin_map}'->(v_body->>v_field);
      IF v_result IS NULL OR v_result='null'::jsonb THEN RAISE EXCEPTION 'Notification administrator mapping missing.'; END IF;
      v_body:=jsonb_set(v_body,ARRAY[v_field],v_result);
    END IF;
  END LOOP;
  FOR v_field,v_parent IN SELECT * FROM (VALUES ('plan_id','notification_automation_plans'),('task_id','notification_automation_tasks'),
    ('source_task_id','notification_automation_tasks')) AS s(f,k) LOOP
    IF v_body->>v_field IS NOT NULL THEN
      SELECT r->'target_id' INTO v_result FROM jsonb_array_elements(p_job.summary#>'{notification_restore,plan,records}') r
        WHERE r->>'table_key'=v_parent AND r->>'source_id'=p_body->>v_field;
      IF v_result IS NULL THEN RAISE EXCEPTION 'Notification configuration reference unmapped.'; END IF;
      v_body:=jsonb_set(v_body,ARRAY[v_field],v_result);
    END IF;
  END LOOP;
  IF p_key IN ('notification_automation_plans','notification_automation_tasks','message_templates') THEN
    SELECT r->'target_id' INTO v_result FROM jsonb_array_elements(p_job.summary#>'{notification_restore,plan,records}') r
      WHERE r->>'table_key'=p_key AND r->>'source_id'=p_body->>'id';
    IF v_result IS NULL THEN RAISE EXCEPTION 'Notification configuration identity unmapped.'; END IF;
    v_body:=jsonb_set(v_body,'{id}',v_result);
    IF p_key<>'message_templates' THEN v_body:=v_body||'{"status":"paused"}'::jsonb; END IF;
  END IF;
  -- Media helper only receives reviewed media-bearing fields, never the entire JSON row.
  FOREACH v_field IN ARRAY CASE p_key
    WHEN 'messages' THEN ARRAY['content'] WHEN 'broadcast_messages' THEN ARRAY['message_content','image_url']
    WHEN 'message_templates' THEN ARRAY['content'] WHEN 'notification_automation_tasks' THEN ARRAY['content_template']
    WHEN 'notification_automation_executions' THEN ARRAY['content_snapshot'] ELSE ARRAY[]::text[] END LOOP
    IF v_body->>v_field IS NOT NULL AND jsonb_array_length(p_job.summary->'notification_media_files')>0 THEN
      v_body:=jsonb_set(v_body,ARRAY[v_field],to_jsonb(private.employee_transfer_notification_rewrite_media(p_job,v_body->>v_field)));
    END IF;
  END LOOP;
  IF p_key='message_recipients' THEN
    SELECT payload INTO v_mapping FROM private.employee_transfer_staging
      WHERE job_id=p_job.id AND employee_id=(p_body->>'id')::uuid AND table_key='notification-delivery-map' AND chunk_no=0;
    v_sequence:=v_mapping->>'target_sequence';
    IF v_sequence IS NULL OR v_mapping->>'source_sequence' IS DISTINCT FROM p_body->>'delivery_sequence' THEN
      RAISE EXCEPTION 'Notification delivery sequence mapping missing or changed.';
    END IF;
    v_body:=v_body||jsonb_build_object('delivery_sequence',v_sequence,'delivery_claim_token',NULL,'delivery_claim_channel',NULL,
      'delivery_claim_until',NULL,'delivery_completed_claim_token',NULL);
  END IF;
  IF p_key='notification_automation_executions' AND p_unlinked THEN v_body:=v_body||'{"message_id":null}'::jsonb; END IF;
  IF private.employee_transfer_notifications_spec()->p_key->>'id'='text!' THEN v_body:=v_body-'id'; END IF;
  EXECUTE format('SELECT to_jsonb(r) FROM jsonb_populate_record(NULL::public.%I,$1) r',p_key) INTO v_result USING v_body;
  -- A future constrained numeric must not silently round a source value.
  FOR v_field IN SELECT key FROM jsonb_each(private.employee_transfer_notifications_spec()->p_key) WHERE value#>>'{}' LIKE 'numeric%' LOOP
    IF v_result->v_field IS DISTINCT FROM p_body->v_field THEN RAISE EXCEPTION 'Notification numeric precision would be lost.'; END IF;
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_restore_write(p_key text,p_row jsonb,p_update boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_columns text; v_projection text; v_set text; v_count bigint;
BEGIN
  PERFORM private.employee_transfer_notifications_relation(p_key);
  SELECT string_agg(format('%I',key),',' ORDER BY key COLLATE "C"),string_agg(format('r.%I',key),',' ORDER BY key COLLATE "C"),
    string_agg(format('%I=r.%I',key,key),',' ORDER BY key COLLATE "C") INTO v_columns,v_projection,v_set
    FROM jsonb_each(private.employee_transfer_notifications_spec()->p_key)
    WHERE NOT(key='id' AND private.employee_transfer_notifications_spec()->p_key->>'id'='text!');
  IF p_update THEN
    IF p_key<>ALL(ARRAY['notification_automation_plans','notification_automation_tasks','message_templates']) THEN RAISE EXCEPTION 'Unsupported notification configuration update.'; END IF;
    EXECUTE format('UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I,$1) r WHERE t.id=r.id',p_key,v_set,p_key) USING p_row;
  ELSE
    EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) r',p_key,v_columns,v_projection,p_key) USING p_row;
  END IF;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  IF v_count<>1 THEN RAISE EXCEPTION 'Notification write did not affect exactly one row.'; END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_restore_check_row(p_key text,p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_where text; v_actual jsonb;
BEGIN
  PERFORM private.employee_transfer_notifications_relation(p_key);
  v_where:=CASE p_key WHEN 'notification_automation_plan_members' THEN 't.user_id=r.user_id'
    WHEN 'notification_automation_task_recipients' THEN 't.task_id=r.task_id AND t.user_id=r.user_id'
    WHEN 'notification_automation_progress' THEN 't.task_id=r.task_id AND t.user_id=r.user_id'
    WHEN 'notification_automation_failures' THEN 't.task_id=r.task_id AND t.user_id=r.user_id'
    WHEN 'notification_automation_date_runs' THEN 't.task_id=r.task_id AND t.task_version=r.task_version AND t.period_key=r.period_key'
    ELSE 't.id=r.id' END;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t,jsonb_populate_record(NULL::public.%I,$1) r WHERE %s',p_key,p_key,v_where) INTO v_actual USING p_row;
  IF v_actual IS DISTINCT FROM p_row THEN RAISE EXCEPTION 'Notification committed row differs in content or references.'; END IF;
  IF p_key='message_recipients' AND EXISTS(SELECT 1 FROM public.messages WHERE id=(p_row->>'message_id')::uuid AND automation_execution_id IS NULL)
    AND NOT EXISTS(SELECT 1 FROM private.content_audit_recipient_versions WHERE message_id=(p_row->>'message_id')::uuid
      AND recipient_id=(p_row->>'recipient_id')::uuid AND recipient_data=p_row) THEN
    RAISE EXCEPTION 'Restored notification recipient evidence is missing or changed.';
  END IF;
END;
$$;

-- Deterministic work is generated from immutable server staging. Explicit empty chunks
-- are required too. Executions NULL message_id -> messages -> execution_links resolves
-- the cyclic FK without disabling constraints, including cross-chunk references.
CREATE FUNCTION private.employee_transfer_notification_restore_work(p_job private.employee_transfer_jobs)
RETURNS TABLE(chunk_no integer,table_key text,rows jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text; v_part record; v_start integer:=0;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['notification_automation_executions','messages','execution_links','message_recipients','broadcast_messages',
    'broadcast_recipients','notification_automation_progress','notification_automation_date_runs','notification_automation_failures'] LOOP
    FOR v_part IN
      SELECT ((n-1)/200)::integer AS part,jsonb_agg(body ORDER BY n) AS bodies FROM (
        SELECT body,row_number() OVER(ORDER BY CASE WHEN v_key='message_recipients' THEN (body->>'delivery_sequence')::bigint END,
          id COLLATE "C") AS n FROM private.employee_transfer_notifications_input(p_job.id,
            CASE WHEN v_key='execution_links' THEN 'notification_automation_executions' ELSE v_key END)) s GROUP BY (n-1)/200 ORDER BY (n-1)/200
    LOOP
      chunk_no:=v_start; table_key:=v_key; rows:=v_part.bodies; RETURN NEXT; v_start:=v_start+1;
    END LOOP;
    IF NOT FOUND THEN chunk_no:=v_start; table_key:=v_key; rows:='[]'; RETURN NEXT; v_start:=v_start+1; END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_restore_progress(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_state jsonb:=p_job.summary->'notification_restore'; v_counts jsonb:='{}'; v_key text; v_work record; v_done record;
  v_body jsonb; v_n integer:=0; v_linked integer:=0; v_total integer:=0; v_row jsonb; v_previous bigint:=0; v_seq bigint; v_count bigint; v_expected bigint;
BEGIN
  IF v_state IS NULL OR v_state->>'target_hash' IS DISTINCT FROM private.employee_transfer_notification_target_hash() THEN RAISE EXCEPTION 'Notification restore target fingerprint changed.'; END IF;
  IF v_state->>'plan_hash' IS DISTINCT FROM v_state#>>'{plan,plan_hash}' THEN RAISE EXCEPTION 'Notification restore plan binding changed.'; END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP v_counts:=v_counts||jsonb_build_object(v_key,0); END LOOP;
  FOREACH v_key IN ARRAY ARRAY['notification_automation_plans','notification_automation_tasks','message_templates','notification_automation_plan_members','notification_automation_task_recipients'] LOOP
    v_count:=0;
    FOR v_body IN SELECT body FROM private.employee_transfer_notifications_input(p_job.id,v_key) LOOP
      PERFORM private.employee_transfer_notification_restore_check_row(v_key,private.employee_transfer_notification_restore_row(p_job,v_key,v_body)); v_count:=v_count+1;
    END LOOP;
    v_counts:=v_counts||jsonb_build_object(v_key,v_count);
  END LOOP;
  FOR v_done IN SELECT payload FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='notification-retired-task' LOOP
    PERFORM private.employee_transfer_notification_restore_check_row('notification_automation_tasks',v_done.payload->'expected');
  END LOOP;
  -- Exact member sets, not a union, including empty sources and retired task recipients.
  SELECT count(*) INTO v_count FROM public.notification_automation_plan_members WHERE plan_id IN (
    SELECT (r->>'target_id')::uuid FROM jsonb_array_elements(v_state#>'{plan,records}') r WHERE r->>'table_key'='notification_automation_plans');
  IF v_count<>(v_counts->>'notification_automation_plan_members')::bigint THEN RAISE EXCEPTION 'Notification plan membership differs.'; END IF;
  SELECT count(*) INTO v_count FROM public.notification_automation_task_recipients WHERE task_id IN (
    SELECT (r->>'target_id')::uuid FROM jsonb_array_elements(v_state#>'{plan,records}') r WHERE r->>'table_key'='notification_automation_tasks'
    UNION ALL SELECT value::text::uuid FROM jsonb_array_elements_text(v_state#>'{plan,retire_tasks}'));
  IF v_count<>(v_counts->>'notification_automation_task_recipients')::bigint THEN RAISE EXCEPTION 'Notification task membership differs.'; END IF;
  FOR v_work IN SELECT * FROM private.employee_transfer_notification_restore_work(p_job) ORDER BY chunk_no LOOP
    v_total:=v_total+1;
    SELECT * INTO v_done FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000'
      AND table_key='notification-restore-done' AND chunk_no=v_work.chunk_no;
    IF v_done.job_id IS NULL THEN CONTINUE; END IF;
    IF v_work.chunk_no<>v_n OR v_done.row_count<>jsonb_array_length(v_work.rows)
      OR v_done.payload IS DISTINCT FROM jsonb_build_object('plan_hash',v_state->>'plan_hash','table_key',v_work.table_key,
        'source_hash',encode(extensions.digest(convert_to(v_work.rows::text,'UTF8'),'sha256'),'hex')) THEN RAISE EXCEPTION 'Notification chunk completion binding changed.'; END IF;
    v_n:=v_n+1;
    IF v_work.table_key='execution_links' THEN v_linked:=v_linked+jsonb_array_length(v_work.rows); CONTINUE; END IF;
    v_counts:=jsonb_set(v_counts,ARRAY[v_work.table_key],to_jsonb((v_counts->>v_work.table_key)::integer+jsonb_array_length(v_work.rows)));
  END LOOP;
  IF v_n<>(v_state->>'next_chunk')::integer OR v_total<>(v_state->>'total_chunks')::integer OR v_counts IS DISTINCT FROM v_state->'counts'
    OR v_linked<>(v_state->>'linked_executions')::integer OR (v_state->>'generation')::bigint<>v_n
    OR (SELECT count(*) FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='notification-restore-done')<>v_n THEN
    RAISE EXCEPTION 'Notification committed progress changed.';
  END IF;
  FOR v_work IN SELECT * FROM private.employee_transfer_notification_restore_work(p_job) WHERE chunk_no<v_n AND table_key<>'execution_links' ORDER BY chunk_no LOOP
    FOR v_body IN SELECT value FROM jsonb_array_elements(v_work.rows) LOOP
      v_row:=private.employee_transfer_notification_restore_row(p_job,v_work.table_key,v_body,
        v_work.table_key='notification_automation_executions' AND v_linked=0);
      -- A partially completed link phase patches the first N execution UUIDs only.
      IF v_work.table_key='notification_automation_executions' THEN
        SELECT count(*) INTO v_expected FROM private.employee_transfer_notifications_input(p_job.id,'notification_automation_executions') WHERE id COLLATE "C"<=(v_body->>'id') COLLATE "C";
        IF v_expected>v_linked THEN v_row:=v_row||'{"message_id":null}'::jsonb; END IF;
      END IF;
      PERFORM private.employee_transfer_notification_restore_check_row(v_work.table_key,v_row);
      IF v_work.table_key='message_recipients' THEN
        v_seq:=(v_row->>'delivery_sequence')::bigint;
        IF v_seq<=v_previous THEN RAISE EXCEPTION 'Restored delivery sequence order changed.'; END IF;
        v_previous:=v_seq;
      END IF;
    END LOOP;
  END LOOP;
  IF (SELECT count(*) FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='notification-delivery-map')<>(v_counts->>'message_recipients')::integer THEN
    RAISE EXCEPTION 'Notification delivery mapping count changed.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_restore_receipt(p_job private.employee_transfer_jobs,p_operation text,p_repeated boolean,p_chunk integer DEFAULT NULL,p_rows integer DEFAULT 0)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object('success',true,'scope','site-notifications','operation',p_operation,'plan_hash',p_job.summary#>>'{notification_restore,plan_hash}',
    'source_site_id',p_job.summary#>>'{notifications_catalog,site_id}','package_id',p_job.summary#>>'{notifications_catalog,package_id}',
    'stage',CASE WHEN p_job.summary#>'{notification_restore,verified}'='true'::jsonb THEN 'done'
      WHEN p_job.summary#>'{notification_restore,next_chunk}'=p_job.summary#>'{notification_restore,total_chunks}' THEN 'ready_to_verify' ELSE 'restoring' END,
    'counts',p_job.summary#>'{notification_restore,counts}','totals',(SELECT jsonb_object_agg(value->>'key',value->'rows') FROM jsonb_array_elements(p_job.summary#>'{notifications_catalog,tables}')),
    'next_chunk',(p_job.summary#>>'{notification_restore,next_chunk}')::integer,'total_chunks',(p_job.summary#>>'{notification_restore,total_chunks}')::integer,
    'linked_executions',(p_job.summary#>>'{notification_restore,linked_executions}')::integer,'generation',p_job.summary#>>'{notification_restore,generation}',
    'verified',p_job.summary#>'{notification_restore,verified}','repeated',p_repeated,'chunk_no',p_chunk,'rows',p_rows,
    'automation_pending',true,'maintenance',true,'replacement_ready',false,'full_site_complete',false);
$$;

CREATE FUNCTION public.employee_import_notifications_begin(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_backup private.employee_transfer_notification_backups%ROWTYPE;
  v_plan jsonb; v_map jsonb; v_state jsonb; v_statuses jsonb:='{}'; v_counts jsonb:='{}'; v_key text; v_record jsonb; v_body jsonb; v_row jsonb; v_disabled jsonb; v_total integer;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_notification_restore_lock();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  v_map:=private.employee_transfer_notification_restore_context(v_job);
  IF v_job.summary ? 'notification_restore' THEN
    IF p_plan_hash IS DISTINCT FROM v_job.summary#>>'{notification_restore,plan_hash}' THEN RAISE EXCEPTION 'Notification restore plan differs.'; END IF;
    PERFORM private.employee_transfer_notification_restore_progress(v_job);
    IF v_job.summary#>'{notification_restore,verified}'='true'::jsonb THEN IF NOT COALESCE(private.employee_transfer_notification_media_ready(v_job,true),false) THEN RAISE EXCEPTION 'Final notification media readback is incomplete.'; END IF; END IF;
    RETURN private.employee_transfer_notification_restore_receipt(v_job,'begin',true);
  END IF;
  v_plan:=private.employee_transfer_notification_configuration_plan(v_job);
  SELECT * INTO v_backup FROM private.employee_transfer_notification_backups WHERE job_id=v_job.id AND admin_id=v_job.admin_id FOR UPDATE;
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_plan->>'plan_hash' OR v_plan->'can_prepare_backup' IS DISTINCT FROM 'true'::jsonb
    OR v_backup.id IS NULL OR v_backup.plan_hash IS DISTINCT FROM p_plan_hash OR v_backup.target_hash IS DISTINCT FROM v_plan->>'target_hash'
    OR v_backup.sealed_at IS NULL OR v_backup.sealed_sha256 IS NULL OR v_backup.target_hash IS DISTINCT FROM private.employee_transfer_notification_target_hash() THEN
    RAISE EXCEPTION 'A current conflict-free notification plan and independent sealed backup are required.';
  END IF;
  PERFORM private.employee_transfer_notification_check_snapshot(v_backup);
  IF EXISTS(SELECT 1 FROM private.content_audit_recipient_versions AS v
    JOIN private.employee_transfer_notifications_input(v_job.id,'messages') AS m ON m.id=v.message_id::text) THEN
    RAISE EXCEPTION 'Target notification recipient evidence already exists; no evidence was overwritten.';
  END IF;
  IF NOT COALESCE(private.employee_transfer_notification_media_ready(v_job,false),false) THEN RAISE EXCEPTION 'Verified notification media is required before begin.'; END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_notifications_keys() LOOP
    SELECT count(*) INTO v_total FROM private.employee_transfer_notifications_input(v_job.id,v_key);
    v_counts:=v_counts||jsonb_build_object(v_key,CASE WHEN v_key=ANY(ARRAY['notification_automation_plans','notification_automation_tasks','message_templates','notification_automation_plan_members','notification_automation_task_recipients']) THEN v_total ELSE 0 END);
  END LOOP;
  SELECT count(*) INTO v_total FROM private.employee_transfer_notification_restore_work(v_job);
  FOR v_key IN SELECT unnest(ARRAY['notification_automation_plans','notification_automation_tasks']) LOOP
    SELECT COALESCE(jsonb_object_agg(r->>'target_id',s.body->'status'),'{}') INTO v_body
      FROM jsonb_array_elements(v_plan->'records') r JOIN private.employee_transfer_notifications_input(v_job.id,v_key) s ON s.id=r->>'source_id' WHERE r->>'table_key'=v_key;
    v_statuses:=v_statuses||jsonb_build_object(v_key,v_body);
  END LOOP;
  v_state:=jsonb_build_object('plan',v_plan,'plan_hash',p_plan_hash,'backup_id',v_backup.id,'admin_map',v_map,'catalog',v_job.summary->'notifications_catalog',
    'original_statuses',v_statuses,'counts',v_counts,'next_chunk',0,'total_chunks',v_total,'linked_executions',0,'generation','0','verified',false,
    'automation_pending',true,'maintenance',true,'full_site_complete',false);
  v_job.summary:=v_job.summary||jsonb_build_object('notification_restore',v_state);
  PERFORM private.employee_transfer_notification_restore_permit(v_job,ARRAY['notification_automation_plans','notification_automation_tasks','message_templates','notification_automation_plan_members','notification_automation_task_recipients']);
  v_disabled:=private.employee_transfer_notification_restore_bypass();
  FOREACH v_key IN ARRAY ARRAY['notification_automation_plans','notification_automation_tasks','message_templates'] LOOP
    FOR v_record IN SELECT value FROM jsonb_array_elements(v_plan->'records') WHERE value->>'table_key'=v_key LOOP
      SELECT body INTO v_body FROM private.employee_transfer_notifications_input(v_job.id,v_key) WHERE id=v_record->>'source_id';
      v_row:=private.employee_transfer_notification_restore_row(v_job,v_key,v_body);
      -- Self/cyclic source_task_id references are nullable; patch only after ALL tasks exist.
      IF v_key='notification_automation_tasks' THEN v_row:=v_row||'{"source_task_id":null}'::jsonb; END IF;
      PERFORM private.employee_transfer_notification_restore_write(v_key,v_row,v_record->>'action'='replace');
    END LOOP;
  END LOOP;
  FOR v_body IN SELECT body FROM private.employee_transfer_notifications_input(v_job.id,'notification_automation_tasks') LOOP
    v_row:=private.employee_transfer_notification_restore_row(v_job,'notification_automation_tasks',v_body);
    UPDATE public.notification_automation_tasks SET source_task_id=(v_row->>'source_task_id')::uuid WHERE id=(v_row->>'id')::uuid;
  END LOOP;
  FOR v_key IN SELECT value FROM jsonb_array_elements_text(v_plan->'retire_tasks') LOOP
    SELECT to_jsonb(t) INTO v_body FROM public.notification_automation_tasks t WHERE id=v_key::uuid;
    IF v_body IS NULL THEN RAISE EXCEPTION 'Notification retired task disappeared.'; END IF;
    INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,v_key::uuid,'notification-retired-task',0,1,
      jsonb_build_object('original_status',v_body->'status','expected',v_body||'{"status":"paused"}'::jsonb));
    UPDATE public.notification_automation_tasks SET status='paused' WHERE id=v_key::uuid;
  END LOOP;
  DELETE FROM public.notification_automation_plan_members WHERE plan_id IN (
    SELECT (r->>'target_id')::uuid FROM jsonb_array_elements(v_plan->'records') r WHERE r->>'table_key'='notification_automation_plans');
  DELETE FROM public.notification_automation_task_recipients WHERE task_id IN (
    SELECT (r->>'target_id')::uuid FROM jsonb_array_elements(v_plan->'records') r WHERE r->>'table_key'='notification_automation_tasks'
    UNION ALL SELECT value::uuid FROM jsonb_array_elements_text(v_plan->'retire_tasks'));
  FOREACH v_key IN ARRAY ARRAY['notification_automation_plan_members','notification_automation_task_recipients'] LOOP
    FOR v_body IN SELECT body FROM private.employee_transfer_notifications_input(v_job.id,v_key) LOOP
      PERFORM private.employee_transfer_notification_restore_write(v_key,private.employee_transfer_notification_restore_row(v_job,v_key,v_body));
    END LOOP;
  END LOOP;
  PERFORM private.employee_transfer_notification_restore_bypass(v_disabled);
  PERFORM private.employee_transfer_clear_write_permit();
  v_job.summary:=jsonb_set(v_job.summary,'{notification_restore,target_hash}',to_jsonb(private.employee_transfer_notification_target_hash()));
  PERFORM private.employee_transfer_notification_restore_progress(v_job);
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary WHERE id=v_job.id;
  RETURN private.employee_transfer_notification_restore_receipt(v_job,'begin',false);
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit(); RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_notifications_chunk(p_admin_session_token uuid,p_job_token uuid,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_work record; v_body jsonb; v_row jsonb; v_disabled jsonb; v_seq regclass; v_next bigint; v_high bigint; v_affected bigint; v_state jsonb;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_notification_restore_lock();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  PERFORM private.employee_transfer_notification_restore_context(v_job);
  PERFORM private.employee_transfer_notification_restore_progress(v_job);
  IF p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>=(v_job.summary#>>'{notification_restore,total_chunks}')::integer THEN RAISE EXCEPTION 'Invalid notification chunk number.'; END IF;
  SELECT * INTO v_work FROM private.employee_transfer_notification_restore_work(v_job) WHERE chunk_no=p_chunk_no;
  IF p_chunk_no<(v_job.summary#>>'{notification_restore,next_chunk}')::integer THEN
    IF v_job.summary#>'{notification_restore,verified}'='true'::jsonb THEN IF NOT COALESCE(private.employee_transfer_notification_media_ready(v_job,true),false) THEN RAISE EXCEPTION 'Final notification media readback is incomplete.'; END IF; END IF;
    RETURN private.employee_transfer_notification_restore_receipt(v_job,'chunk',true,p_chunk_no,jsonb_array_length(v_work.rows));
  END IF;
  IF p_chunk_no<>(v_job.summary#>>'{notification_restore,next_chunk}')::integer THEN RAISE EXCEPTION 'Notification chunks must be applied in order.'; END IF;
  PERFORM private.employee_transfer_notification_restore_permit(v_job,ARRAY[CASE WHEN v_work.table_key='execution_links' THEN 'notification_automation_executions' ELSE v_work.table_key END]);
  v_disabled:=private.employee_transfer_notification_restore_bypass();
  IF v_work.table_key='message_recipients' THEN
    v_seq:=pg_get_serial_sequence('public.message_recipients','delivery_sequence')::regclass;
    SELECT COALESCE(max(delivery_sequence),0) INTO v_high FROM public.message_recipients;
    -- A non-sequence installation uses max+1 under this same exclusive relation lock.
  END IF;
  FOR v_body IN SELECT value FROM jsonb_array_elements(v_work.rows) LOOP
    IF v_work.table_key='message_recipients' THEN
      IF v_seq IS NULL THEN v_next:=v_high+1;
      ELSE
        v_next:=nextval(v_seq);
        IF v_next<=v_high THEN PERFORM setval(v_seq,v_high,true); v_next:=nextval(v_seq); END IF;
      END IF;
      IF v_next<=v_high OR v_next<=0 THEN RAISE EXCEPTION 'Target notification delivery sequence is not increasing.'; END IF;
      INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,(v_body->>'id')::uuid,'notification-delivery-map',0,1,
        jsonb_build_object('source_sequence',v_body->>'delivery_sequence','target_sequence',v_next::text));
      v_high:=v_next;
    END IF;
    IF v_work.table_key='execution_links' THEN
      v_row:=private.employee_transfer_notification_restore_row(v_job,'notification_automation_executions',v_body);
      UPDATE public.notification_automation_executions SET message_id=(v_row->>'message_id')::uuid WHERE id=(v_row->>'id')::uuid;
      GET DIAGNOSTICS v_affected=ROW_COUNT;
      IF v_affected<>1 THEN RAISE EXCEPTION 'Notification execution link did not affect exactly one row.'; END IF;
      PERFORM private.employee_transfer_notification_restore_check_row('notification_automation_executions',v_row);
    ELSE
      v_row:=private.employee_transfer_notification_restore_row(v_job,v_work.table_key,v_body,v_work.table_key='notification_automation_executions');
      PERFORM private.employee_transfer_notification_restore_write(v_work.table_key,v_row);
      PERFORM private.employee_transfer_notification_restore_check_row(v_work.table_key,v_row);
    END IF;
  END LOOP;
  PERFORM private.employee_transfer_notification_restore_bypass(v_disabled);
  PERFORM private.employee_transfer_clear_write_permit();
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,'00000000-0000-0000-0000-000000000000',
    'notification-restore-done',p_chunk_no,jsonb_array_length(v_work.rows),jsonb_build_object('plan_hash',v_job.summary#>>'{notification_restore,plan_hash}',
      'table_key',v_work.table_key,'source_hash',encode(extensions.digest(convert_to(v_work.rows::text,'UTF8'),'sha256'),'hex')));
  v_state:=v_job.summary->'notification_restore';
  IF v_work.table_key='execution_links' THEN v_state:=jsonb_set(v_state,'{linked_executions}',to_jsonb((v_state->>'linked_executions')::integer+jsonb_array_length(v_work.rows)));
  ELSE v_state:=jsonb_set(v_state,ARRAY['counts',v_work.table_key],to_jsonb((v_state#>>ARRAY['counts',v_work.table_key])::integer+jsonb_array_length(v_work.rows))); END IF;
  v_state:=v_state||jsonb_build_object('next_chunk',p_chunk_no+1,'generation',((v_state->>'generation')::bigint+1)::text,'verified',false,
    'target_hash',private.employee_transfer_notification_target_hash());
  v_job.summary:=jsonb_set(v_job.summary,'{notification_restore}',v_state);
  PERFORM private.employee_transfer_notification_restore_progress(v_job);
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary WHERE id=v_job.id;
  RETURN private.employee_transfer_notification_restore_receipt(v_job,'chunk',false,p_chunk_no,jsonb_array_length(v_work.rows));
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit(); RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_notifications_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_repeated boolean; v_table jsonb;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_notification_restore_lock();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  PERFORM private.employee_transfer_notification_restore_context(v_job);
  PERFORM private.employee_transfer_notification_restore_progress(v_job);
  IF v_job.summary#>'{notification_restore,next_chunk}' IS DISTINCT FROM v_job.summary#>'{notification_restore,total_chunks}' THEN RAISE EXCEPTION 'Notification restore is incomplete.'; END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(v_job.summary#>'{notifications_catalog,tables}') LOOP
    IF v_job.summary#>ARRAY['notification_restore','counts',v_table->>'key'] IS DISTINCT FROM v_table->'rows' THEN RAISE EXCEPTION 'Notification restored totals differ.'; END IF;
  END LOOP;
  IF v_job.summary#>'{notification_restore,linked_executions}' IS DISTINCT FROM v_job.summary#>'{notification_restore,counts,notification_automation_executions}' THEN RAISE EXCEPTION 'Notification execution links are incomplete.'; END IF;
  IF NOT COALESCE(private.employee_transfer_notification_media_ready(v_job,true),false) THEN RAISE EXCEPTION 'Final notification media readback is incomplete.'; END IF;
  v_repeated:=(v_job.summary#>>'{notification_restore,verified}')::boolean;
  v_job.summary:=jsonb_set(v_job.summary,'{notification_restore,verified}','true');
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary WHERE id=v_job.id;
  RETURN private.employee_transfer_notification_restore_receipt(v_job,'verify',v_repeated);
END;
$$;

CREATE FUNCTION public.get_employee_import_notifications_restore_status(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_notification_restore_context(v_job);
  PERFORM private.employee_transfer_notification_restore_progress(v_job);
  IF v_job.summary#>'{notification_restore,verified}'='true'::jsonb THEN IF NOT COALESCE(private.employee_transfer_notification_media_ready(v_job,true),false) THEN RAISE EXCEPTION 'Final notification media readback is incomplete.'; END IF; END IF;
  RETURN private.employee_transfer_notification_restore_receipt(v_job,'status',true);
END;
$$;

DO $permissions$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_notification_restore_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
  REVOKE ALL ON FUNCTION public.employee_import_notifications_begin(uuid,uuid,text),public.employee_import_notifications_chunk(uuid,uuid,integer),
    public.employee_import_notifications_verify(uuid,uuid),public.get_employee_import_notifications_restore_status(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
  GRANT EXECUTE ON FUNCTION public.employee_import_notifications_begin(uuid,uuid,text),public.employee_import_notifications_chunk(uuid,uuid,integer),
    public.employee_import_notifications_verify(uuid,uuid),public.get_employee_import_notifications_restore_status(uuid,uuid) TO anon,authenticated;
END;
$permissions$;
NOTIFY pgrst,'reload schema';
COMMIT;
