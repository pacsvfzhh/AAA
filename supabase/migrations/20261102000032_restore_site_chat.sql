BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

DO $audit$
DECLARE v_expected constant jsonb := '{
 "cs_message_templates.audit_template_source": "bea540e4f423873ca0d34c30f24a4babadbc2ac6493a1d2edaf37c0f43f93c0c",
 "cs_message_templates.guard_content_audit_public_media_reference": "0628609ad2f5d38f8045e0654878b11a2b295f5d789c2263eaf3aea29b13f403",
 "cs_message_templates.guard_employee_chat_image_reference": "9956aedbc4745a2f5a204a42a6ee211d5fd96eb07aacebe598b6d30afbf59f20",
 "customer_auto_messages.audit_auto_source": "19fdcdcb2fb270ac7f6ba607273ff64eef42d155c2d9db542186d8cca7a48c5b",
 "customer_auto_messages.guard_content_audit_public_media_reference": "ffdf66b47421c5e940ab47321edb1e3e0f5301a1928c832fa6d5ca8983746495",
 "customer_auto_messages.guard_employee_chat_image_reference": "1b463f670c07702a8073c31129df06e08c442260194a2f58c0d91f0045a50efd",
 "customer_employee_conversations.aa_reject_archived_employee_chat": "9d811cd251245e2a473905a9ff6c109d05f86c1e223d84124387658ef4a46ebf",
 "customer_employee_conversations.audit_chat_change": "21bce479f00f35228da32dab73a051e2c4afca32d8b366309eb5ca30927e276b",
 "customer_employee_conversations.freeze_service_rich_card_before_insert": "607c2d3dcf30951372ea55cd044b411e3bde36cd77d6efb54bd5244041152d3a",
 "customer_employee_conversations.guard_content_audit_public_media_reference": "9e2b731afad12a045be59c7130e3bda81699f7438e20975aa696a40957303578",
 "customer_employee_conversations.guard_employee_chat_image_reference": "4e5814fc880364d3b3e19b3c36aaeed2377592e02c40ca4dd813cfe9db5c6be9",
 "customer_employee_conversations.trg_check_conversation_group_isolation": "8b1c39050bb05262c9dc2bc4a0556c1e042845b7c745a6d3e43c694891059c02",
 "customer_employee_conversations.trg_sync_conversation_source_type": "2cf3eca6be3d48d5d91ace99c9fc410105120ccdb1d5700f06f43eb0c0a01c59",
 "customer_service_sessions.set_service_ticket_number_trigger": "9d8ef4c3abbb82a5f80b6664a7bc98ed52e8539096b1532828dc1cfa7a85130f",
 "rich_card_contents.audit_card_source": "c34179456478be2a8b78ea41afed0716b6264a9a2a440d11f330908ae7a31f8a",
 "rich_card_contents.guard_content_audit_public_media_reference": "310c97382243f9ccf88a813fdc916cbfcf180f1451e493614830923102f26c83",
 "rich_card_contents.guard_employee_chat_image_reference": "a7633eb83381e594602a43997a95a1500f331a9e0904f348f04034c09f4d805b",
 "simulated_customers.guard_content_audit_public_media_reference": "a12917d4506a0f8edd6d0103bd6b5c21f56c708290b2a23d959b9042ccbab54f",
 "simulated_customers.guard_employee_chat_image_reference": "c534dfb2d5a311048683e1578c173f89388a1df931861e397a669840be16fd83",
 "simulated_customers.set_customer_id_trigger": "18cc5feaac6dbce7ee81bbc8168166ea943d1ae57806e4854d754f9835e1480b"
}';v_native jsonb; v_actual jsonb;v_modes jsonb;
BEGIN
  SELECT jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_install_trigger_digest(t.oid)),
    jsonb_object_agg(c.relname||'.'||t.tgname,t.tgenabled::text),
    jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_trigger_digest(t.oid)) INTO v_actual,v_modes,v_native
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
      AND c.relname=ANY(private.employee_transfer_chat_keys()) AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance';
  IF v_actual IS DISTINCT FROM v_expected OR EXISTS(SELECT 1 FROM jsonb_each_text(v_modes) WHERE value NOT IN ('O','A')) THEN
    RAISE EXCEPTION 'Unreviewed chat restore triggers.';
  END IF;
  EXECUTE format($definition$
    CREATE FUNCTION private.employee_transfer_chat_restore_assert()
    RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, public, private, pg_temp AS $body$
    DECLARE v_expected constant jsonb := %L::jsonb;v_modes constant jsonb := %L::jsonb;v_actual jsonb;v_actual_modes jsonb;
    BEGIN
      PERFORM private.employee_transfer_assert_maintenance_guards();PERFORM private.employee_transfer_chat_schema();
      IF current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN RAISE EXCEPTION 'Chat restore requires origin mode.';END IF;
      SELECT jsonb_object_agg(c.relname||'.'||t.tgname,private.employee_transfer_trigger_digest(t.oid)),
        jsonb_object_agg(c.relname||'.'||t.tgname,t.tgenabled::text) INTO v_actual,v_actual_modes
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
          AND c.relname=ANY(private.employee_transfer_chat_keys()) AND NOT t.tgisinternal AND t.tgname<>'zz_employee_transfer_maintenance';
      IF v_actual IS DISTINCT FROM v_expected OR v_actual_modes IS DISTINCT FROM v_modes THEN RAISE EXCEPTION 'Unreviewed chat restore triggers.';END IF;
      IF EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace
        AND c.relname=ANY(private.employee_transfer_chat_keys()) AND t.tgisinternal AND t.tgenabled NOT IN ('O','A')) THEN
        RAISE EXCEPTION 'Chat foreign key protection is disabled.';
      END IF;
    END;
    $body$;
  $definition$,v_native::text,v_modes::text);
END;
$audit$;

CREATE FUNCTION private.employee_transfer_chat_restore_lock()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;
BEGIN
  FOREACH v_key IN ARRAY private.employee_transfer_chat_keys() LOOP EXECUTE format('LOCK TABLE ONLY public.%I IN ACCESS EXCLUSIVE MODE',v_key);END LOOP;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance',0));
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_media_map(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT COALESCE(jsonb_object_agg(ref.value->>'source_url',s.payload->>'storage_origin'||'/storage/v1/object/public/'||
    (ref.value->>'bucket')||'/'||(s.payload->>'path')),'{}'::jsonb)
  FROM jsonb_array_elements(private.employee_transfer_chat_media_refs(p_job,false)) WITH ORDINALITY ref(value,n)
  JOIN private.employee_transfer_staging s ON s.job_id=p_job.id AND s.employee_id='00000000-0000-0000-0000-000000000000'
    AND s.table_key='chat-media:import' AND s.chunk_no=ref.n-1;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_context(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_map jsonb;
BEGIN
  PERFORM private.employee_transfer_chat_restore_assert();v_map:=private.employee_transfer_chat_owner(p_job);
  PERFORM private.employee_transfer_check_chat_input(p_job);
  IF private.employee_transfer_chat_source_issues(p_job,v_map)<>'[]'::jsonb THEN RAISE EXCEPTION 'Chat source references or ownership conflict.';END IF;
  IF NOT EXISTS(SELECT 1 FROM private.employee_transfer_maintenance m WHERE m.singleton AND m.dirty AND m.job_id=p_job.id
    AND m.admin_id=p_job.admin_id AND m.plan_hash=p_job.summary->>'dispatch_plan_hash') THEN RAISE EXCEPTION 'The original dirty maintenance owner is required for chat restore.';END IF;
  IF p_job.summary ? 'chat_restore' AND (p_job.summary#>'{chat_restore,admin_map}' IS DISTINCT FROM v_map
    OR p_job.summary#>'{chat_restore,catalog}' IS DISTINCT FROM p_job.summary->'chat_catalog'
    OR p_job.summary#>'{chat_restore,plan,decisions}' IS DISTINCT FROM p_job.summary->'chat_decisions'
    OR p_job.summary#>'{chat_restore,media_map}' IS DISTINCT FROM private.employee_transfer_chat_restore_media_map(p_job)) THEN
    RAISE EXCEPTION 'Chat source, media or administrator mapping changed.';
  END IF;
  IF NOT COALESCE(private.employee_transfer_chat_media_ready(p_job,false),false) THEN RAISE EXCEPTION 'Verified chat media is required before restore.';END IF;
  RETURN v_map;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_text(p_job private.employee_transfer_jobs,p_content text)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_rest text:=p_content;v_result text:='';v_next record;
BEGIN
  IF p_content IS NULL THEN RETURN NULL;END IF;
  LOOP
    SELECT key,value,strpos(v_rest,key) AS pos INTO v_next FROM jsonb_each_text(p_job.summary#>'{chat_restore,media_map}')
      WHERE strpos(v_rest,key)>0 ORDER BY strpos(v_rest,key),length(key) DESC,key COLLATE "C" LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_result:=v_result||left(v_rest,v_next.pos-1)||v_next.value;v_rest:=substring(v_rest FROM v_next.pos+length(v_next.key));
  END LOOP;
  RETURN v_result||v_rest;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_id(p_job_id uuid,p_key text,p_source text,p_optional boolean DEFAULT false)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_saved jsonb;
BEGIN
  IF p_source IS NULL THEN RETURN NULL;END IF;
  PERFORM private.employee_transfer_chat_relation(p_key);
  SELECT payload INTO v_saved FROM private.employee_transfer_staging WHERE job_id=p_job_id AND employee_id=md5(p_source)::uuid
    AND table_key='chat-applied:'||p_key AND chunk_no=0;
  IF v_saved IS NULL THEN IF p_optional THEN RETURN NULL;END IF;RAISE EXCEPTION 'Chat dependency has not been restored.';END IF;
  IF v_saved->>'source_id' IS DISTINCT FROM p_source THEN RAISE EXCEPTION 'Chat mapping identity collision.';END IF;
  RETURN (v_saved->>'target_id')::uuid;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_write(p_key text,p_row jsonb,p_rating_sql_null boolean DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_columns text;v_projection text;v_n bigint;
BEGIN
  PERFORM private.employee_transfer_chat_relation(p_key);
  SELECT string_agg(format('%I',key),',' ORDER BY key COLLATE "C"),string_agg(CASE
    WHEN p_key='customer_employee_conversations' AND key='rating_data' THEN 'CASE WHEN $2 THEN NULL::jsonb ELSE $1->''rating_data'' END'
    ELSE format('r.%I',key) END,',' ORDER BY key COLLATE "C") INTO v_columns,v_projection
    FROM jsonb_each(private.employee_transfer_chat_spec()->p_key)
    WHERE NOT(p_key='ccc_conversation_annotations' AND key='id') AND key<>'rating_data_sql_null';
  IF p_key='customer_employee_conversations' AND p_rating_sql_null IS NULL THEN RAISE EXCEPTION 'An explicit chat JSON NULL marker is required.';END IF;
  EXECUTE format('INSERT INTO public.%I(%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) r',p_key,v_columns,v_projection,p_key)
    USING p_row,p_rating_sql_null;
  GET DIAGNOSTICS v_n=ROW_COUNT;IF v_n<>1 THEN RAISE EXCEPTION 'Chat write did not affect exactly one row.';END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_actual(p_key text,p_row jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_actual jsonb;v_where text;
BEGIN
  PERFORM private.employee_transfer_chat_relation(p_key);
  v_where:=CASE WHEN p_key='ccc_conversation_annotations' THEN 't.customer_id=r.customer_id AND t.employee_id=r.employee_id' ELSE 't.id=r.id' END;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t,jsonb_populate_record(NULL::public.%I,$1) r WHERE %s',p_key,p_key,v_where) INTO v_actual USING p_row;
  RETURN v_actual;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_check(p_key text,p_row jsonb,p_rating_sql_null boolean DEFAULT NULL)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_actual boolean;
BEGIN
  IF private.employee_transfer_chat_restore_actual(p_key,p_row) IS DISTINCT FROM p_row THEN RAISE EXCEPTION 'Chat committed row differs in content or references.';END IF;
  IF p_key='customer_employee_conversations' THEN
    SELECT rating_data IS NULL INTO v_actual FROM public.customer_employee_conversations WHERE id=(p_row->>'id')::uuid;
    IF p_rating_sql_null IS NULL OR v_actual IS DISTINCT FROM p_rating_sql_null THEN RAISE EXCEPTION 'Chat committed JSON NULL semantics changed.';END IF;
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_snapshot(p_html text,p_created timestamptz)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_card public.rich_card_contents%ROWTYPE;
BEGIN
  IF p_html IS NULL THEN RAISE EXCEPTION 'Chat rich card source is unavailable.';END IF;
  SELECT * INTO v_card FROM public.rich_card_contents WHERE content_hash=md5(p_html);
  IF v_card.id IS NOT NULL THEN
    IF v_card.html_content IS DISTINCT FROM p_html THEN RAISE EXCEPTION 'Chat rich card hash collision.';END IF;
    RETURN v_card.id;
  END IF;
  INSERT INTO public.rich_card_contents(html_content,created_at,content_hash) VALUES(p_html,COALESCE(p_created,now()),md5(p_html)) RETURNING id INTO v_card.id;
  RETURN v_card.id;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_apply_row(p_job private.employee_transfer_jobs,p_key text,p_source jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_row jsonb:=p_source-'rating_data_sql_null';v_existing jsonb;v_normal jsonb;v_saved jsonb;v_role jsonb;v_field text;
  v_id uuid;v_target uuid;v_html text;v_action text:='create';v_visibility uuid[];v_original jsonb;v_sql_null boolean;v_source_id text:=p_source->>'id';
BEGIN
  PERFORM private.employee_transfer_check_chat_row(p_key,p_source);
  IF p_key='ccc_conversation_annotations' THEN v_row:=v_row-'id';END IF;
  FOREACH v_field IN ARRAY ARRAY['admin_id','owner_admin_id','updated_by'] LOOP
    IF v_row ? v_field AND v_row->>v_field IS NOT NULL THEN
      IF p_job.summary#>'{chat_restore,admin_map}'->>(v_row->>v_field) IS NULL THEN RAISE EXCEPTION 'Chat administrator mapping is missing.';END IF;
      v_row:=jsonb_set(v_row,ARRAY[v_field],p_job.summary#>'{chat_restore,admin_map}'->(v_row->>v_field));
    END IF;
  END LOOP;
  IF v_row ? 'customer_id' AND p_key<>'simulated_customers' THEN
    v_row:=jsonb_set(v_row,'{customer_id}',to_jsonb(private.employee_transfer_chat_restore_id(p_job.id,'simulated_customers',p_source->>'customer_id')));
  END IF;
  FOREACH v_field IN ARRAY CASE p_key WHEN 'simulated_customers' THEN ARRAY['customer_avatar','custom_avatar_url']
    WHEN 'cs_message_templates' THEN ARRAY['content'] WHEN 'customer_auto_messages' THEN ARRAY['content']
    WHEN 'rich_card_contents' THEN ARRAY['html_content'] WHEN 'customer_employee_conversations' THEN ARRAY['message_content','image_url'] ELSE ARRAY[]::text[] END LOOP
    IF v_row->>v_field IS NOT NULL THEN v_row:=jsonb_set(v_row,ARRAY[v_field],to_jsonb(private.employee_transfer_chat_restore_text(p_job,v_row->>v_field)));END IF;
  END LOOP;
  IF p_key='simulated_customers' THEN
    SELECT r INTO STRICT v_role FROM jsonb_array_elements(p_job.summary#>'{chat_restore,plan,roles}') r WHERE r->>'source_id'=v_source_id;
    v_row:=v_row||jsonb_build_object('id',v_role->'target_id','customer_id',v_role->'number');
    IF v_role->>'action'='merge' THEN
      SELECT line::jsonb INTO STRICT v_original FROM private.employee_transfer_staging s
        CROSS JOIN LATERAL unnest(string_to_array(rtrim(s.payload->>'ndjson',E'\n'),E'\n')) AS l(line)
        WHERE s.job_id=p_job.id AND s.table_key='chat-backup:simulated_customers' AND line<>'' AND line::jsonb->>'id'=v_role->>'target_id';
      v_row:=v_original;v_action:='merge';
      SELECT array_agg(employee ORDER BY employee) INTO v_visibility FROM (
        SELECT DISTINCT a.value::uuid AS employee FROM jsonb_array_elements(p_job.summary#>'{chat_restore,plan,roles}') r
          CROSS JOIN LATERAL jsonb_array_elements_text(r->'visibility_employee_ids') a(value)
          WHERE r->>'target_id'=v_role->>'target_id' AND r->'allow_visibility'='true'::jsonb
        UNION SELECT unnest((SELECT target_employee_ids FROM jsonb_populate_record(NULL::public.simulated_customers,v_original)))
      ) s;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_job.summary#>'{chat_restore,plan,roles}') r
        WHERE r->>'target_id'=v_role->>'target_id' AND r->'allow_visibility'='true'::jsonb AND jsonb_array_length(r->'visibility_employee_ids')>0) THEN
        v_row:=jsonb_set(v_row,'{target_employee_ids}',to_jsonb(v_visibility));
      END IF;
    END IF;
  ELSIF p_key='cs_message_templates' THEN
    SELECT to_jsonb(t) INTO v_existing FROM public.cs_message_templates t WHERE admin_id=v_row->>'admin_id' AND source_type=v_row->>'source_type'
      AND name=v_row->>'name' AND content=v_row->>'content' AND content_type=v_row->>'content_type'
      AND title IS NOT DISTINCT FROM v_row->>'title' AND subtitle IS NOT DISTINCT FROM v_row->>'subtitle' ORDER BY id LIMIT 1;
  ELSIF p_key='customer_auto_messages' THEN
    SELECT to_jsonb(t) INTO v_existing FROM public.customer_auto_messages t WHERE customer_id=(v_row->>'customer_id')::uuid
      AND admin_id=v_row->>'admin_id' AND message_type=v_row->>'message_type' AND content=v_row->>'content'
      AND content_type=v_row->>'content_type' AND title IS NOT DISTINCT FROM v_row->>'title' AND subtitle IS NOT DISTINCT FROM v_row->>'subtitle' ORDER BY id LIMIT 1;
  ELSIF p_key='rich_card_contents' THEN
    v_row:=v_row||jsonb_build_object('content_hash',md5(v_row->>'html_content'),'source_template_id',NULL,'source_auto_message_id',NULL);
    SELECT to_jsonb(t) INTO v_existing FROM public.rich_card_contents t WHERE content_hash=v_row->>'content_hash';
    IF v_existing IS NOT NULL AND v_existing->'html_content' IS DISTINCT FROM v_row->'html_content' THEN RAISE EXCEPTION 'Chat rich card hash collision.';END IF;
  ELSIF p_key='customer_service_sessions' THEN
    SELECT to_jsonb(t) INTO v_existing FROM public.customer_service_sessions t WHERE customer_id=(v_row->>'customer_id')::uuid
      AND employee_id=(v_row->>'employee_id')::uuid AND status=v_row->>'status';
    IF v_existing IS NULL AND EXISTS(SELECT 1 FROM public.customer_service_sessions WHERE service_ticket_number=v_row->>'service_ticket_number') THEN
      v_row:=jsonb_set(v_row,'{service_ticket_number}',to_jsonb('TRANSFER-'||replace(v_source_id,'-','')));
    END IF;
  ELSIF p_key='customer_employee_conversations' THEN
    v_sql_null:=(p_source->>'rating_data_sql_null')::boolean;
    FOREACH v_field IN ARRAY ARRAY['source_template_id','source_auto_message_id'] LOOP
      v_target:=private.employee_transfer_chat_restore_id(p_job.id,CASE WHEN v_field='source_template_id' THEN 'cs_message_templates' ELSE 'customer_auto_messages' END,p_source->>v_field,true);
      v_row:=jsonb_set(v_row,ARRAY[v_field],COALESCE(to_jsonb(v_target),'null'::jsonb));
    END LOOP;
    IF p_source->>'message_type'='rich_card' THEN
      IF p_source->'content_frozen'='true'::jsonb THEN
        v_target:=private.employee_transfer_chat_restore_id(p_job.id,'rich_card_contents',p_source->>'rich_card_content_id');
      ELSE
        IF p_source->>'source_template_id' IS NOT NULL THEN SELECT body->>'content' INTO v_html FROM private.employee_transfer_chat_input(p_job.id,'cs_message_templates') WHERE id=p_source->>'source_template_id';
        ELSIF p_source->>'source_auto_message_id' IS NOT NULL THEN SELECT body->>'content' INTO v_html FROM private.employee_transfer_chat_input(p_job.id,'customer_auto_messages') WHERE id=p_source->>'source_auto_message_id';
        ELSIF p_source->>'rich_card_content_id' IS NOT NULL THEN SELECT body->>'html_content' INTO v_html FROM private.employee_transfer_chat_input(p_job.id,'rich_card_contents') WHERE id=p_source->>'rich_card_content_id';
        ELSE v_html:=p_source->>'message_content';END IF;
        v_target:=private.employee_transfer_chat_restore_snapshot(private.employee_transfer_chat_restore_text(p_job,v_html),(p_source->>'created_at')::timestamptz);
      END IF;
      IF v_target IS NULL THEN RAISE EXCEPTION 'Frozen chat card is missing.';END IF;
      v_row:=v_row||jsonb_build_object('rich_card_content_id',v_target,'content_frozen',true);
    ELSIF p_source->>'rich_card_content_id' IS NOT NULL THEN
      v_row:=jsonb_set(v_row,'{rich_card_content_id}',to_jsonb(private.employee_transfer_chat_restore_id(p_job.id,'rich_card_contents',p_source->>'rich_card_content_id')));
    END IF;
  ELSIF p_key='ccc_conversation_annotations' THEN
    SELECT to_jsonb(t) INTO v_existing FROM public.ccc_conversation_annotations t WHERE customer_id=(v_row->>'customer_id')::uuid AND employee_id=(v_row->>'employee_id')::uuid;
  ELSIF p_key='customer_auto_message_logs' THEN
    v_row:=jsonb_set(v_row,'{auto_message_id}',to_jsonb(private.employee_transfer_chat_restore_id(p_job.id,'customer_auto_messages',p_source->>'auto_message_id')));
    SELECT to_jsonb(t) INTO v_existing FROM public.customer_auto_message_logs t WHERE customer_id=(v_row->>'customer_id')::uuid
      AND employee_id=(v_row->>'employee_id')::uuid AND auto_message_id=(v_row->>'auto_message_id')::uuid ORDER BY sent_at,id LIMIT 1;
  ELSIF p_key IN ('rating_requests','service_ratings') AND p_source->>'session_id' IS NOT NULL THEN
    v_row:=jsonb_set(v_row,'{session_id}',to_jsonb(private.employee_transfer_chat_restore_id(p_job.id,'customer_service_sessions',p_source->>'session_id')));
  END IF;
  IF v_existing IS NOT NULL THEN v_row:=v_existing;v_action:='reuse';END IF;
  EXECUTE format('SELECT to_jsonb(r) FROM jsonb_populate_record(NULL::public.%I,$1) r',p_key) INTO v_normal USING v_row;
  IF p_key='customer_employee_conversations' THEN v_normal:=jsonb_set(v_normal,'{rating_data}',p_source->'rating_data');END IF;
  v_existing:=private.employee_transfer_chat_restore_actual(p_key,v_normal);
  IF p_key='simulated_customers' AND v_action='merge' THEN
    IF v_existing IS NULL THEN RAISE EXCEPTION 'Target chat role disappeared.';END IF;
    UPDATE public.simulated_customers SET target_employee_ids=r.target_employee_ids FROM jsonb_populate_record(NULL::public.simulated_customers,v_normal) r WHERE public.simulated_customers.id=r.id
      AND public.simulated_customers.target_employee_ids IS DISTINCT FROM r.target_employee_ids;
    PERFORM private.employee_transfer_chat_restore_check(p_key,v_normal);
  ELSIF v_existing IS NOT NULL THEN
    IF v_existing IS DISTINCT FROM v_normal THEN RAISE EXCEPTION 'Chat UUID belongs to different content; no existing history was overwritten.';END IF;
    v_action:='reuse';PERFORM private.employee_transfer_chat_restore_check(p_key,v_normal,v_sql_null);
  ELSE
    PERFORM private.employee_transfer_chat_restore_write(p_key,v_normal,v_sql_null);
    PERFORM private.employee_transfer_chat_restore_check(p_key,v_normal,v_sql_null);
  END IF;
  v_id:=md5(v_source_id)::uuid;
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(p_job.id,v_id,'chat-applied:'||p_key,0,1,jsonb_build_object('source_id',v_source_id,'target_id',v_normal->>'id','action',v_action,
      'source_hash',encode(extensions.digest(convert_to(p_source::text,'UTF8'),'sha256'),'hex'),'expected',v_normal,'rating_sql_null',v_sql_null));
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_work(p_job private.employee_transfer_jobs)
RETURNS TABLE(chunk_no integer,table_key text,rows jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text;v_part record;v_start integer:=0;
BEGIN
  FOREACH v_key IN ARRAY ARRAY['simulated_customers','cs_message_templates','customer_auto_messages','rich_card_contents','customer_service_sessions',
    'customer_employee_conversations','ccc_conversation_annotations','customer_auto_message_logs','rating_requests','service_ratings'] LOOP
    FOR v_part IN SELECT ((n-1)/200)::integer AS part,jsonb_agg(body ORDER BY n) AS bodies FROM (
      SELECT body,row_number() OVER(ORDER BY id COLLATE "C") AS n FROM private.employee_transfer_chat_input(p_job.id,v_key)) s GROUP BY (n-1)/200 ORDER BY (n-1)/200 LOOP
      chunk_no:=v_start;table_key:=v_key;rows:=v_part.bodies;RETURN NEXT;v_start:=v_start+1;
    END LOOP;
    IF NOT FOUND THEN chunk_no:=v_start;table_key:=v_key;rows:='[]';RETURN NEXT;v_start:=v_start+1;END IF;
  END LOOP;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_progress(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_state jsonb:=p_job.summary->'chat_restore';v_work record;v_done record;v_body jsonb;v_saved jsonb;v_counts jsonb:='{}';
  v_key text;v_n integer:=0;v_total integer:=0;v_rows integer:=0;
BEGIN
  IF v_state IS NULL OR v_state->>'target_hash' IS DISTINCT FROM private.employee_transfer_chat_target_hash()
    OR v_state->>'plan_hash' IS DISTINCT FROM v_state#>>'{plan,plan_hash}' THEN RAISE EXCEPTION 'Chat restore target or plan changed.';END IF;
  FOREACH v_key IN ARRAY private.employee_transfer_chat_keys() LOOP v_counts:=v_counts||jsonb_build_object(v_key,0);END LOOP;
  FOR v_work IN SELECT * FROM private.employee_transfer_chat_restore_work(p_job) ORDER BY chunk_no LOOP
    v_total:=v_total+1;
    SELECT * INTO v_done FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000'
      AND table_key='chat-restore-done' AND chunk_no=v_work.chunk_no;
    IF v_done.job_id IS NULL THEN CONTINUE;END IF;
    IF v_work.chunk_no<>v_n OR v_done.row_count<>jsonb_array_length(v_work.rows) OR v_done.payload IS DISTINCT FROM jsonb_build_object(
      'plan_hash',v_state->>'plan_hash','table_key',v_work.table_key,'source_hash',encode(extensions.digest(convert_to(v_work.rows::text,'UTF8'),'sha256'),'hex')) THEN
      RAISE EXCEPTION 'Chat committed chunk binding changed.';
    END IF;
    v_n:=v_n+1;v_rows:=v_rows+jsonb_array_length(v_work.rows);
    v_counts:=jsonb_set(v_counts,ARRAY[v_work.table_key],to_jsonb((v_counts->>v_work.table_key)::integer+jsonb_array_length(v_work.rows)));
    FOR v_body IN SELECT value FROM jsonb_array_elements(v_work.rows) LOOP
      SELECT payload INTO v_saved FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id=md5(v_body->>'id')::uuid
        AND table_key='chat-applied:'||v_work.table_key AND chunk_no=0;
      IF v_saved->>'source_id' IS DISTINCT FROM v_body->>'id' OR v_saved->>'source_hash' IS DISTINCT FROM encode(extensions.digest(convert_to(v_body::text,'UTF8'),'sha256'),'hex') THEN
        RAISE EXCEPTION 'Chat committed source mapping changed.';
      END IF;
      PERFORM private.employee_transfer_chat_restore_check(v_work.table_key,v_saved->'expected',(v_saved->>'rating_sql_null')::boolean);
    END LOOP;
  END LOOP;
  IF v_n<>(v_state->>'next_chunk')::integer OR v_total<>(v_state->>'total_chunks')::integer OR v_counts IS DISTINCT FROM v_state->'counts'
    OR v_state->>'generation' IS DISTINCT FROM v_n::text
    OR (SELECT count(*) FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='chat-restore-done')<>v_n
    OR (SELECT count(*) FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key LIKE 'chat-applied:%')<>v_rows THEN
    RAISE EXCEPTION 'Chat committed progress changed.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_receipt(p_job private.employee_transfer_jobs,p_operation text,p_repeated boolean,p_chunk integer DEFAULT NULL,p_rows integer DEFAULT 0)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object('success',true,'scope','site-chat','operation',p_operation,'plan_hash',p_job.summary#>>'{chat_restore,plan_hash}',
    'source_site_id',p_job.summary#>>'{chat_catalog,site_id}','package_id',p_job.summary#>>'{chat_catalog,package_id}',
    'stage',CASE WHEN p_job.summary#>'{chat_restore,verified}'='true'::jsonb THEN 'done'
      WHEN p_job.summary#>'{chat_restore,next_chunk}'=p_job.summary#>'{chat_restore,total_chunks}' THEN 'ready_to_verify' ELSE 'restoring' END,
    'counts',p_job.summary#>'{chat_restore,counts}','totals',(SELECT jsonb_object_agg(value->>'key',value->'rows') FROM jsonb_array_elements(p_job.summary#>'{chat_catalog,tables}')),
    'next_chunk',(p_job.summary#>>'{chat_restore,next_chunk}')::integer,'total_chunks',(p_job.summary#>>'{chat_restore,total_chunks}')::integer,
    'generation',p_job.summary#>>'{chat_restore,generation}','verified',p_job.summary#>'{chat_restore,verified}','repeated',p_repeated,'chunk_no',p_chunk,'rows',p_rows,
    'media_pending',p_job.summary#>'{chat_restore,verified}' IS DISTINCT FROM 'true'::jsonb,'maintenance',true,'replacement_ready',false,'full_site_complete',false);
$$;

CREATE FUNCTION private.employee_transfer_chat_restore_bypass(p_restore jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_entries jsonb;v_item jsonb;v_id uuid:=gen_random_uuid();v_pending jsonb;
BEGIN
  IF p_restore IS NULL THEN
    PERFORM private.employee_transfer_chat_restore_assert();
    IF private.employee_transfer_pending_trigger_bypass() IS NOT NULL THEN RAISE EXCEPTION 'A trigger bypass is already pending.';END IF;
    SELECT jsonb_build_array(jsonb_build_object('table','customer_employee_conversations','trigger',tgname,'mode',tgenabled::text,
      'digest',private.employee_transfer_trigger_digest(oid))) INTO STRICT v_entries FROM pg_trigger
      WHERE tgrelid='public.customer_employee_conversations'::regclass AND tgname='freeze_service_rich_card_before_insert';
    -- Source snapshots must not be replaced by the target's current templates.
    ALTER TABLE ONLY public.customer_employee_conversations DISABLE TRIGGER freeze_service_rich_card_before_insert;
    INSERT INTO private.employee_transfer_events(kind,action,details) VALUES('import','trigger_bypass',jsonb_build_object(
      'transaction_id',pg_current_xact_id()::text,'bypass_id',v_id,'entries',v_entries,'scope','chat-restore'));
    RETURN v_entries;
  END IF;
  v_pending:=private.employee_transfer_pending_trigger_bypass();
  IF v_pending IS NULL OR v_pending->>'scope' IS DISTINCT FROM 'chat-restore' OR v_pending->'entries' IS DISTINCT FROM p_restore THEN RAISE EXCEPTION 'Chat trigger restore receipt differs.';END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_restore) LOOP
    IF v_item->>'table'<>'customer_employee_conversations' OR v_item->>'trigger'<>'freeze_service_rich_card_before_insert'
      OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.customer_employee_conversations'::regclass AND tgname=v_item->>'trigger'
        AND tgenabled='D' AND private.employee_transfer_trigger_digest(oid)=v_item->>'digest') THEN RAISE EXCEPTION 'Chat bypass trigger changed.';END IF;
    EXECUTE format('ALTER TABLE ONLY public.customer_employee_conversations ENABLE %s TRIGGER freeze_service_rich_card_before_insert',CASE WHEN v_item->>'mode'='A' THEN 'ALWAYS' ELSE '' END);
  END LOOP;
  INSERT INTO private.employee_transfer_events(kind,action,details) VALUES('import','trigger_restore',jsonb_build_object('transaction_id',pg_current_xact_id()::text,'bypass_id',v_pending->>'bypass_id'));
  PERFORM private.employee_transfer_chat_restore_assert();RETURN p_restore;
END;
$$;

CREATE FUNCTION public.employee_import_chat_begin(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_backup private.employee_transfer_chat_backups%ROWTYPE;v_plan jsonb;v_map jsonb;v_counts jsonb:='{}';v_key text;v_total integer;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);PERFORM private.employee_transfer_chat_restore_lock();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');v_map:=private.employee_transfer_chat_restore_context(v_job);
  IF v_job.summary ? 'chat_restore' THEN
    IF p_plan_hash IS DISTINCT FROM v_job.summary#>>'{chat_restore,plan_hash}' THEN RAISE EXCEPTION 'Chat restore plan differs.';END IF;
    PERFORM private.employee_transfer_chat_restore_progress(v_job);
    IF v_job.summary#>'{chat_restore,verified}'='true'::jsonb AND NOT COALESCE(private.employee_transfer_chat_media_ready(v_job,true),false) THEN RAISE EXCEPTION 'Final chat media readback is incomplete.';END IF;
    RETURN private.employee_transfer_chat_restore_receipt(v_job,'begin',true);
  END IF;
  v_plan:=private.employee_transfer_chat_merge_plan(v_job,v_job.summary->'chat_decisions');
  SELECT * INTO v_backup FROM private.employee_transfer_chat_backups WHERE job_id=v_job.id AND admin_id=v_job.admin_id FOR UPDATE;
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_plan->>'plan_hash' OR v_plan->'can_prepare_backup' IS DISTINCT FROM 'true'::jsonb
    OR v_backup.id IS NULL OR v_backup.plan_hash IS DISTINCT FROM p_plan_hash OR v_backup.target_hash IS DISTINCT FROM v_plan->>'target_hash'
    OR v_backup.sealed_at IS NULL OR v_backup.sealed_sha256 IS NULL OR v_backup.target_hash IS DISTINCT FROM private.employee_transfer_chat_target_hash() THEN
    RAISE EXCEPTION 'A current confirmed chat merge plan and independent sealed backup are required.';
  END IF;
  PERFORM private.employee_transfer_chat_check_snapshot(v_backup);
  FOREACH v_key IN ARRAY private.employee_transfer_chat_keys() LOOP v_counts:=v_counts||jsonb_build_object(v_key,0);END LOOP;
  SELECT count(*) INTO v_total FROM private.employee_transfer_chat_restore_work(v_job);
  v_job.summary:=v_job.summary||jsonb_build_object('chat_restore',jsonb_build_object('plan',v_plan,'plan_hash',p_plan_hash,'backup_id',v_backup.id,
    'admin_map',v_map,'catalog',v_job.summary->'chat_catalog','media_map',private.employee_transfer_chat_restore_media_map(v_job),
    'counts',v_counts,'next_chunk',0,'total_chunks',v_total,'generation','0','last_apply_at',NULL,'verified',false,'target_hash',private.employee_transfer_chat_target_hash()));
  PERFORM private.employee_transfer_chat_restore_progress(v_job);
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','chat_restore_started',
    jsonb_build_object('plan_hash',p_plan_hash,'backup_id',v_backup.id,'total_chunks',v_total,'full_site_complete',false));
  RETURN private.employee_transfer_chat_restore_receipt(v_job,'begin',false);
END;
$$;

CREATE FUNCTION public.employee_import_chat_chunk(p_admin_session_token uuid,p_job_token uuid,p_chunk_no integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_work record;v_body jsonb;v_disabled jsonb;v_state jsonb;v_keys text[];
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);PERFORM private.employee_transfer_chat_restore_lock();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');PERFORM private.employee_transfer_chat_restore_context(v_job);
  PERFORM private.employee_transfer_chat_restore_progress(v_job);
  IF p_chunk_no IS NULL OR p_chunk_no<0 OR p_chunk_no>=(v_job.summary#>>'{chat_restore,total_chunks}')::integer THEN RAISE EXCEPTION 'Invalid chat chunk number.';END IF;
  SELECT * INTO v_work FROM private.employee_transfer_chat_restore_work(v_job) WHERE chunk_no=p_chunk_no;
  IF p_chunk_no<(v_job.summary#>>'{chat_restore,next_chunk}')::integer THEN
    IF v_job.summary#>'{chat_restore,verified}'='true'::jsonb AND NOT COALESCE(private.employee_transfer_chat_media_ready(v_job,true),false) THEN RAISE EXCEPTION 'Final chat media readback is incomplete.';END IF;
    RETURN private.employee_transfer_chat_restore_receipt(v_job,'chunk',true,p_chunk_no,jsonb_array_length(v_work.rows));
  END IF;
  IF p_chunk_no<>(v_job.summary#>>'{chat_restore,next_chunk}')::integer THEN RAISE EXCEPTION 'Chat chunks must be applied in order.';END IF;
  v_keys:=ARRAY['public.'||v_work.table_key];
  IF v_work.table_key='customer_employee_conversations' THEN v_keys:=v_keys||ARRAY['public.rich_card_contents'];END IF;
  INSERT INTO private.employee_transfer_write_permits(transaction_id,job_id,table_names) VALUES(pg_current_xact_id(),v_job.id,v_keys);
  IF v_work.table_key='customer_employee_conversations' THEN v_disabled:=private.employee_transfer_chat_restore_bypass();END IF;
  FOR v_body IN SELECT value FROM jsonb_array_elements(v_work.rows) LOOP PERFORM private.employee_transfer_chat_restore_apply_row(v_job,v_work.table_key,v_body);END LOOP;
  IF v_disabled IS NOT NULL THEN PERFORM private.employee_transfer_chat_restore_bypass(v_disabled);END IF;
  PERFORM private.employee_transfer_clear_write_permit();
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload) VALUES(v_job.id,'00000000-0000-0000-0000-000000000000','chat-restore-done',p_chunk_no,jsonb_array_length(v_work.rows),
    jsonb_build_object('plan_hash',v_job.summary#>>'{chat_restore,plan_hash}','table_key',v_work.table_key,'source_hash',encode(extensions.digest(convert_to(v_work.rows::text,'UTF8'),'sha256'),'hex')));
  v_state:=v_job.summary->'chat_restore';
  v_state:=jsonb_set(v_state,ARRAY['counts',v_work.table_key],to_jsonb((v_state#>>ARRAY['counts',v_work.table_key])::integer+jsonb_array_length(v_work.rows)));
  v_state:=v_state||jsonb_build_object('next_chunk',p_chunk_no+1,'generation',(p_chunk_no+1)::text,'verified',false,'last_apply_at',clock_timestamp(),'target_hash',private.employee_transfer_chat_target_hash());
  v_job.summary:=jsonb_set(v_job.summary,'{chat_restore}',v_state);PERFORM private.employee_transfer_chat_restore_progress(v_job);
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','chat_chunk_restored',
    jsonb_build_object('table_key',v_work.table_key,'chunk_no',p_chunk_no,'rows',jsonb_array_length(v_work.rows),'generation',v_state->>'generation','full_site_complete',false));
  RETURN private.employee_transfer_chat_restore_receipt(v_job,'chunk',false,p_chunk_no,jsonb_array_length(v_work.rows));
EXCEPTION WHEN OTHERS THEN PERFORM private.employee_transfer_clear_write_permit();RAISE;
END;
$$;

CREATE FUNCTION public.employee_import_chat_verify(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout='2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_repeated boolean;v_table jsonb;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);PERFORM private.employee_transfer_chat_restore_lock();
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');PERFORM private.employee_transfer_chat_restore_context(v_job);
  PERFORM private.employee_transfer_chat_restore_progress(v_job);
  IF v_job.summary#>'{chat_restore,next_chunk}' IS DISTINCT FROM v_job.summary#>'{chat_restore,total_chunks}' THEN RAISE EXCEPTION 'Chat restore is incomplete.';END IF;
  FOR v_table IN SELECT value FROM jsonb_array_elements(v_job.summary#>'{chat_catalog,tables}') LOOP
    IF v_job.summary#>ARRAY['chat_restore','counts',v_table->>'key'] IS DISTINCT FROM v_table->'rows' THEN RAISE EXCEPTION 'Chat restored totals differ.';END IF;
  END LOOP;
  IF NOT COALESCE(private.employee_transfer_chat_media_ready(v_job,true),false) THEN RAISE EXCEPTION 'Final chat media readback is incomplete.';END IF;
  v_repeated:=(v_job.summary#>>'{chat_restore,verified}')::boolean;v_job.summary:=jsonb_set(v_job.summary,'{chat_restore,verified}','true');
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary WHERE id=v_job.id;
  IF NOT v_repeated THEN PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','chat_restore_verified',
    jsonb_build_object('counts',v_job.summary#>'{chat_restore,counts}','generation',v_job.summary#>>'{chat_restore,generation}','full_site_complete',false));END IF;
  RETURN private.employee_transfer_chat_restore_receipt(v_job,'verify',v_repeated);
END;
$$;

CREATE FUNCTION public.get_employee_import_chat_restore_status(p_admin_session_token uuid,p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM private.employee_transfer_chat_restore_context(v_job);PERFORM private.employee_transfer_chat_restore_progress(v_job);
  IF v_job.summary#>'{chat_restore,verified}'='true'::jsonb AND NOT COALESCE(private.employee_transfer_chat_media_ready(v_job,true),false) THEN RAISE EXCEPTION 'Final chat media readback is incomplete.';END IF;
  RETURN private.employee_transfer_chat_restore_receipt(v_job,'status',true);
END;
$$;

DO $$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='private'::regnamespace AND proname LIKE 'employee_transfer_chat_restore_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
  FOREACH v_function IN ARRAY ARRAY['public.employee_import_chat_begin(uuid,uuid,text)'::regprocedure,'public.employee_import_chat_chunk(uuid,uuid,integer)'::regprocedure,
    'public.employee_import_chat_verify(uuid,uuid)'::regprocedure,'public.get_employee_import_chat_restore_status(uuid,uuid)'::regprocedure] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon,authenticated',v_function);
  END LOOP;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
