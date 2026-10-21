BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- Additive, export-only sidecar in the SAME SQL46 task. No SQL46 catalog/close changes,
-- business writes, staging tables, Storage policy, maintenance permit or import authority.
CREATE FUNCTION private.employee_safety_media_hash(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT encode(extensions.digest(convert_to(p_text,'UTF8'),'sha256'),'hex');
$$;

CREATE FUNCTION private.employee_safety_media_fields(p_table text)
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT CASE p_table
    WHEN 'verification_requests' THEN ARRAY['id_front_url','id_back_url','selfie_url']
    WHEN 'simulated_customers' THEN ARRAY['custom_avatar_url','customer_avatar']
    WHEN 'customer_employee_conversations' THEN ARRAY['message_content','image_url','rating_data']
    WHEN 'cs_message_templates' THEN ARRAY['content']
    WHEN 'customer_auto_messages' THEN ARRAY['content']
    WHEN 'rich_card_contents' THEN ARRAY['html_content']
    WHEN 'messages' THEN ARRAY['content']
    WHEN 'message_templates' THEN ARRAY['content']
    WHEN 'notification_automation_tasks' THEN ARRAY['content_template']
    WHEN 'notification_automation_executions' THEN ARRAY['content_snapshot']
    WHEN 'broadcast_messages' THEN ARRAY['message_content','image_url']
    WHEN 'content_audit_events' THEN ARRAY['media_refs','before_data','after_data']
    ELSE ARRAY[]::text[] END;
$$;

-- Unreviewed fields are NOT another media container. Recursively fail closed, including
-- decoded JSON strings/keys. Audit before/after snapshots alone are exempt: their original
-- public URLs are historical text; only the event's private media_refs authorize evidence.
CREATE FUNCTION private.employee_safety_media_guard(p_value jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_entry record;v_item jsonb;v_text text;
BEGIN
  IF jsonb_typeof(p_value)='object' THEN
    FOR v_entry IN SELECT key,value FROM jsonb_each(p_value) LOOP
      IF v_entry.value NOT IN ('null'::jsonb,'""'::jsonb,'[]'::jsonb,'{}'::jsonb)
        AND v_entry.key ~* '(url|uri|src|href|poster|image|avatar|file|attachment|media|path|bucket|storage|base64)' THEN
        RAISE EXCEPTION 'Unsupported employee safety media reference.';
      END IF;
      PERFORM private.employee_safety_media_guard(to_jsonb(v_entry.key));
      PERFORM private.employee_safety_media_guard(v_entry.value);
    END LOOP;
  ELSIF jsonb_typeof(p_value)='array' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      PERFORM private.employee_safety_media_guard(v_item);
    END LOOP;
  ELSIF jsonb_typeof(p_value)='string' THEN
    v_text:=p_value#>>'{}';
    IF v_text ~* '(storage|supabase|verification-documents|announcement-images|chat-images|template-images|super-customer-avatars|content-audit-evidence|base64)'
      OR v_text ~* '(data|blob)[[:space:]]*:'
      OR v_text ~* '(^|[^A-Za-z0-9_-])url[[:space:]]*[(]'
      OR v_text ~* '<[[:space:]]*(img|video|audio|source|iframe|object|embed)([[:space:]/>]|$)'
      OR v_text ~* '(src|srcset|poster|href)[[:space:]]*='
      OR v_text ~* '[.](jpe?g|png|gif|webp|pdf|mp4|webm|svg|avif|heic|zip)($|[?#[:space:]<>"''])' THEN
      RAISE EXCEPTION 'Unsupported employee safety media reference.';
    END IF;
  END IF;
END;
$$;

-- Strict public Storage parser, not a fetch target. Edge uses its fixed origin + bucket/path.
CREATE FUNCTION private.employee_safety_media_public(p_url text,p_kind text,p_employee uuid,p_avatar boolean)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_bucket text;v_path text;v_origin text;
BEGIN
  IF p_url IS NULL OR octet_length(p_url)>1024 OR p_url ~ '[[:cntrl:]]'
    OR p_url !~ '^https://[a-z0-9-]+[.]supabase[.]co/storage/v1/object/public/(verification-documents|announcement-images|chat-images|template-images|super-customer-avatars)/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*[.][A-Za-z0-9]{1,8}$' THEN
    RAISE EXCEPTION 'Unmanaged employee safety media URL.';
  END IF;
  v_origin:=split_part(p_url,'/storage/',1);v_bucket:=split_part(p_url,'/',8);
  v_path:=substring(p_url FROM length(v_origin||'/storage/v1/object/public/'||v_bucket||'/')+1);
  IF strpos(v_path,'..')>0 OR v_path ~ '(^|/)[.](/|$)' THEN RAISE EXCEPTION 'Unsafe employee safety media path.';END IF;
  IF p_kind='verification' THEN
    IF v_bucket<>'verification-documents' OR p_employee IS NULL
      OR v_path !~ '^(id-front|id-back|selfie)/[0-9a-f-]{36}-[A-Za-z0-9._-]+[.][A-Za-z0-9]{1,8}$'
      OR left(split_part(v_path,'/',2),37) IS DISTINCT FROM p_employee::text||'-'
      OR length(split_part(v_path,'/',2))>128 THEN RAISE EXCEPTION 'Employee safety document ownership is invalid.';END IF;
  ELSIF p_kind='chat' THEN
    IF v_bucket NOT IN ('announcement-images','chat-images','template-images','super-customer-avatars') THEN
      RAISE EXCEPTION 'Unmanaged employee safety media bucket.';
    END IF;
  ELSIF p_kind='notifications' THEN
    IF v_bucket NOT IN ('announcement-images','chat-images','template-images') THEN
      RAISE EXCEPTION 'Unmanaged employee safety media bucket.';
    END IF;
  ELSE RAISE EXCEPTION 'Unsupported employee safety media kind.';END IF;
  IF v_bucket='super-customer-avatars' AND left(v_path,8)<>'avatars/' THEN RAISE EXCEPTION 'Unsafe employee safety avatar path.';END IF;
  RETURN jsonb_build_object('bucket',v_bucket,'path',v_path,'origin',v_origin,'kind',p_kind,
    'avatar',COALESCE(p_avatar,false) OR v_bucket='super-customer-avatars');
END;
$$;

CREATE FUNCTION private.employee_safety_media_owner(p_session uuid,p_token uuid,p_fingerprint text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_catalog jsonb;
BEGIN
  v_job:=private.employee_safety_backup_owner(p_session,p_token);
  v_catalog:=public.get_employee_safety_backup_catalog(p_session,p_token);
  IF p_fingerprint IS NULL OR p_fingerprint IS DISTINCT FROM v_catalog->>'fingerprint' THEN
    RAISE EXCEPTION 'Employee safety media catalog binding changed.';
  END IF;
  RETURN v_job;
END;
$$;

-- ONLY SQL46's fixed employee-scoped projections are queried. No domain/job-wide inventory.
-- One identity per row/field/original reference; duplicate tokens in the SAME field deduplicate.
CREATE FUNCTION private.employee_safety_media_refs(p_job private.employee_transfer_jobs,p_private_origin text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_table text;v_field text;v_row record;v_content text;v_url text;v_urls text[];v_residual text;
  v_fields text[];v_ref record;v_candidate jsonb;v_candidates jsonb;v_refs jsonb:='{}';v_count integer:=0;
  v_kind text;v_line_hash text;v_identity text;v_key text;v_origin text;v_original text;
  v_catalog jsonb:=p_job.summary->'employee_safety_catalog';v_employee uuid:=(p_job.options->>'employee_id')::uuid;
BEGIN
  IF p_private_origin IS NOT NULL AND (p_private_origin ~ '[[:cntrl:]]'
    OR p_private_origin !~ '^https://[a-z0-9-]+[.]supabase[.]co$') THEN RAISE EXCEPTION 'Invalid employee safety Storage origin.';END IF;
  FOREACH v_table IN ARRAY private.employee_safety_backup_keys() LOOP
    v_fields:=private.employee_safety_media_fields(v_table);
    FOR v_row IN EXECUTE 'SELECT id,body FROM ('||private.employee_safety_backup_query(v_table)||') AS scoped'
      USING v_employee LOOP
      PERFORM private.employee_safety_media_guard(v_row.body-v_fields);
      v_line_hash:=private.employee_safety_media_hash(v_row.body::text||E'\n');
      v_candidates:='[]';
      IF v_table='content_audit_events' THEN
        IF jsonb_typeof(v_row.body->'media_refs') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid employee safety evidence references.';END IF;
        IF v_row.body->>'cleared_at' IS NOT NULL AND v_row.body->'media_refs'<>'{}'::jsonb THEN
          RAISE EXCEPTION 'Cleared employee safety evidence contains references.';
        END IF;
        FOR v_ref IN SELECT key,value FROM jsonb_each(v_row.body->'media_refs') LOOP
          IF octet_length(v_ref.key) NOT BETWEEN 1 AND 4096 OR v_ref.key ~ '[[:cntrl:]]'
            OR jsonb_typeof(v_ref.value) IS DISTINCT FROM 'string' OR octet_length(v_ref.value#>>'{}') NOT BETWEEN 1 AND 512
            OR (v_ref.value#>>'{}') ~ '[[:cntrl:]]'
            OR (v_ref.value#>>'{}') !~ '^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$'
            OR strpos(v_ref.value#>>'{}','..')>0 THEN RAISE EXCEPTION 'Unsafe employee safety evidence path.';END IF;
          -- The original event/ref key is opaque evidence, NEVER a URL destination or scanned.
          v_candidates:=v_candidates||jsonb_build_array(jsonb_build_object('field','media_refs','original',v_ref.key,
            'bucket','content-audit-evidence','path',v_ref.value,'kind','archives','avatar',false,'origin',p_private_origin));
        END LOOP;
      ELSE
        FOREACH v_field IN ARRAY v_fields LOOP
          IF v_field='rating_data' THEN
            PERFORM private.employee_transfer_chat_rating_media_guard(v_row.body->v_field);CONTINUE;
          END IF;
          v_content:=v_row.body->>v_field;
          IF v_content IS NULL THEN CONTINUE;END IF;
          IF v_field='customer_avatar' AND v_content ~ '^customer-avatar:(regular|vip):[0-9]+$'
            AND v_content !~ '[[:cntrl:]]' THEN CONTINUE;END IF;
          v_kind:=CASE WHEN v_table='verification_requests' THEN 'verification'
            WHEN v_table=ANY(private.employee_transfer_chat_keys()) THEN 'chat' ELSE 'notifications' END;
          v_urls:=private.employee_transfer_chat_media_urls(v_content,
            v_field IN ('id_front_url','id_back_url','selfie_url','image_url','custom_avatar_url','customer_avatar'));
          v_residual:=v_content;
          FOREACH v_url IN ARRAY v_urls LOOP
            v_candidate:=private.employee_safety_media_public(v_url,v_kind,v_employee,v_table='simulated_customers');
            v_candidates:=v_candidates||jsonb_build_array(v_candidate||jsonb_build_object('field',v_field,'original',v_url));
            v_residual:=replace(v_residual,v_url,'');
          END LOOP;
          -- The tokenizer handles attributes. Also reject unparsed/encoded/plain media tokens.
          IF v_residual ~* '(storage|supabase|verification-documents|announcement-images|chat-images|template-images|super-customer-avatars|content-audit-evidence|base64)'
            OR v_residual ~* '(data|blob)[[:space:]]*:'
            OR v_residual ~* 'https?[^[:space:]<>"'']*[.](jpe?g|png|gif|webp|pdf|mp4|webm|svg|avif|heic|zip)($|[?#[:space:]<>"''])' THEN
            RAISE EXCEPTION 'Unsupported employee safety media reference.';
          END IF;
        END LOOP;
      END IF;
      FOR v_candidate IN SELECT value FROM jsonb_array_elements(v_candidates) LOOP
        v_original:=v_candidate->>'original';
        v_identity:='employee-safety-media-v1:'||(v_catalog->>'site_id')||':'||p_job.id::text||':'||v_employee::text||':'||
          (v_catalog->>'fingerprint')||':'||v_line_hash||':'||
          private.employee_safety_media_hash(v_table||':'||v_row.id||':'||(v_candidate->>'field')||':'||v_original)||':'||
          private.employee_safety_media_hash((v_candidate->>'bucket')||'/'||(v_candidate->>'path'));
        v_key:=private.employee_safety_media_hash(v_identity);
        v_candidate:=(v_candidate-ARRAY['field','original'])||jsonb_build_object('key',v_key,
          'source_url',CASE WHEN v_candidate->>'kind'='archives' THEN v_identity ELSE v_original END);
        IF v_candidate->>'kind'<>'archives' THEN
          IF v_origin IS NOT NULL AND v_origin IS DISTINCT FROM v_candidate->>'origin' THEN
            RAISE EXCEPTION 'Employee safety media spans different Storage origins.';
          END IF;
          v_origin:=v_candidate->>'origin';
        END IF;
        IF v_refs ? v_key THEN
          IF v_refs->v_key IS DISTINCT FROM v_candidate THEN RAISE EXCEPTION 'Employee safety media identity collision.';END IF;
        ELSE
          v_count:=v_count+1;IF v_count>3000 THEN RAISE EXCEPTION 'Employee safety media exceeds 3000 references.';END IF;
          v_refs:=v_refs||jsonb_build_object(v_key,v_candidate);
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  IF p_private_origin IS NOT NULL AND v_origin IS NOT NULL AND p_private_origin IS DISTINCT FROM v_origin THEN
    RAISE EXCEPTION 'Employee safety Storage origin changed.';
  END IF;
  -- Public URLs establish the common origin even before the first evidence receipt.
  RETURN COALESCE((SELECT jsonb_agg(CASE WHEN value->>'kind'='archives' THEN
    jsonb_set(value,'{origin}',COALESCE(to_jsonb(COALESCE(v_origin,p_private_origin)),'null'::jsonb)) ELSE value END
    ORDER BY key COLLATE "C") FROM jsonb_each(v_refs)),'[]'::jsonb);
END;
$$;

CREATE FUNCTION private.employee_safety_media_file(p_ref jsonb,p_file jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_bytes bigint;v_mime text;
BEGIN
  IF NOT private.employee_transfer_exact_object(p_file,ARRAY['key','source_url','bytes','sha256','content_type'])
    OR p_file->'key' IS DISTINCT FROM p_ref->'key' OR p_file->'source_url' IS DISTINCT FROM p_ref->'source_url'
    OR jsonb_typeof(p_file->'bytes') IS DISTINCT FROM 'number' OR (p_file->>'bytes') !~ '^[1-9][0-9]{0,7}$'
    OR jsonb_typeof(p_file->'sha256') IS DISTINCT FROM 'string' OR length(p_file->>'sha256')<>64
    OR p_file->>'sha256' !~ '^[0-9a-f]{64}$' OR jsonb_typeof(p_file->'content_type') IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'Invalid employee safety media file tuple.';
  END IF;
  v_bytes:=(p_file->>'bytes')::bigint;v_mime:=p_file->>'content_type';
  IF v_bytes>52428800 OR v_mime NOT IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf','video/mp4','video/webm')
    OR (p_ref->>'kind'='verification' AND v_mime NOT IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf'))
    OR (p_ref->>'kind'='archives' AND v_mime NOT IN ('image/jpeg','image/png','image/gif','image/webp','video/mp4'))
    OR (p_ref->'avatar'='true'::jsonb AND (v_bytes>5242880 OR v_mime NOT IN ('image/jpeg','image/png','image/gif','image/webp'))) THEN
    RAISE EXCEPTION 'Employee safety media type or size is unsupported.';
  END IF;
  RETURN v_bytes;
END;
$$;

-- Recompute refs and validate EVERY existing receipt, not just the requested object.
-- Missing/unchecked receipts mean pending, malformed or drifting receipts are errors.
CREATE FUNCTION private.employee_safety_media_state(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_state jsonb:=p_job.summary->'employee_safety_media';v_refs jsonb;v_origin text;
  v_ref jsonb;v_receipt jsonb;v_entry record;v_bytes bigint:=0;v_records bigint;
  v_generation text:=p_job.summary#>>'{employee_safety_catalog,fingerprint}';
BEGIN
  IF v_state IS NOT NULL THEN
    IF NOT private.employee_transfer_exact_object(v_state,ARRAY['version','protocol','generation','refs','receipts','storage_origin'])
      OR v_state->'version' IS DISTINCT FROM '1'::jsonb OR v_state->>'protocol' IS DISTINCT FROM 'employee-safety-media-v1'
      OR v_state->'generation' IS DISTINCT FROM to_jsonb(v_generation)
      OR jsonb_typeof(v_state->'receipts') IS DISTINCT FROM 'object'
      OR (v_state->'storage_origin'<>'null'::jsonb AND jsonb_typeof(v_state->'storage_origin') IS DISTINCT FROM 'string') THEN
      RAISE EXCEPTION 'Employee safety media sidecar binding changed.';
    END IF;
    v_origin:=v_state->>'storage_origin';
  END IF;
  v_refs:=private.employee_safety_media_refs(p_job,v_origin);
  IF v_state IS NULL THEN
    SELECT value->>'origin' INTO v_origin FROM jsonb_array_elements(v_refs) WHERE value->>'origin' IS NOT NULL LIMIT 1;
    v_state:=jsonb_build_object('version',1,'protocol','employee-safety-media-v1','generation',v_generation,
      'refs',v_refs,'receipts','{}'::jsonb,'storage_origin',v_origin);
  ELSIF v_state->'refs' IS DISTINCT FROM v_refs THEN RAISE EXCEPTION 'Employee safety media references changed.';END IF;
  FOR v_entry IN SELECT key,value FROM jsonb_each(v_state->'receipts') LOOP
    SELECT value INTO v_ref FROM jsonb_array_elements(v_refs) WHERE value->>'key'=v_entry.key;
    v_receipt:=v_entry.value;
    IF v_ref IS NULL OR NOT private.employee_transfer_exact_object(v_receipt,ARRAY['file','path','storage_origin','generation','checked'])
      OR v_receipt->'path' IS DISTINCT FROM v_ref->'path' OR v_receipt->'storage_origin' IS DISTINCT FROM to_jsonb(v_origin)
      OR v_receipt->'storage_origin' IS DISTINCT FROM v_ref->'origin' OR v_origin IS NULL
      OR v_receipt->'generation' IS DISTINCT FROM to_jsonb(v_generation)
      OR jsonb_typeof(v_receipt->'checked') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'Employee safety media receipt binding changed.';
    END IF;
    v_bytes:=v_bytes+private.employee_safety_media_file(v_ref,v_receipt->'file');
  END LOOP;
  SELECT COALESCE(sum((value->>'bytes')::bigint),0) INTO v_records
    FROM jsonb_array_elements(p_job.summary#>'{employee_safety_catalog,tables}');
  IF v_bytes+v_records>1073741824 THEN RAISE EXCEPTION 'Employee safety records and media exceed 1 GiB.';END IF;
  RETURN v_state;
END;
$$;

CREATE FUNCTION public.get_employee_safety_backup_media(p_admin_session_token uuid,p_job_token uuid,p_catalog_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_state jsonb;v_files jsonb;v_verified boolean;
BEGIN
  v_job:=private.employee_safety_media_owner(p_admin_session_token,p_job_token,p_catalog_fingerprint);
  v_state:=private.employee_safety_media_state(v_job);
  SELECT COALESCE(jsonb_agg((r.value-'origin')||jsonb_build_object('file',v_state#>ARRAY['receipts',r.value->>'key','file'])
    ORDER BY r.value->>'key' COLLATE "C"),'[]'::jsonb),
    COALESCE(bool_and(v_state#>ARRAY['receipts',r.value->>'key','checked'] IS NOT DISTINCT FROM 'true'::jsonb),true)
    INTO v_files,v_verified FROM jsonb_array_elements(v_state->'refs') r(value);
  RETURN jsonb_build_object('version',1,'scope','employee-safety-media','records_catalog',v_job.summary->'employee_safety_catalog',
    'files',v_files,'verified',v_verified,'complete_employee_backup',false,'can_archive',false,'can_replace',false,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_safety_backup_media_verify(p_admin_session_token uuid,p_job_token uuid,p_catalog_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_inventory jsonb;
BEGIN
  v_inventory:=public.get_employee_safety_backup_media(p_admin_session_token,p_job_token,p_catalog_fingerprint);
  IF v_inventory->'verified' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Employee safety media requires complete export readback.';END IF;
  RETURN v_inventory;
END;
$$;

CREATE FUNCTION public.employee_safety_backup_media_authorize(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_state jsonb;v_ref jsonb;v_receipt jsonb;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('download','recheck-export') THEN RAISE EXCEPTION 'Unsupported employee safety media action.';END IF;
  IF p_object_key IS NULL OR length(p_object_key)<>64 OR p_object_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid employee safety media key.';END IF;
  v_job:=private.employee_safety_backup_owner(p_admin_session_token,p_job_token);
  v_job:=private.employee_safety_media_owner(p_admin_session_token,p_job_token,v_job.summary#>>'{employee_safety_catalog,fingerprint}');
  v_state:=private.employee_safety_media_state(v_job);
  SELECT value INTO v_ref FROM jsonb_array_elements(v_state->'refs') WHERE value->>'key'=p_object_key;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Employee safety media is outside this task.';END IF;
  v_receipt:=v_state#>ARRAY['receipts',p_object_key];
  IF p_action='recheck-export' AND v_receipt IS NULL THEN RAISE EXCEPTION 'Download employee safety media before rechecking.';END IF;
  RETURN jsonb_build_object('direction','export','key',p_object_key,'bucket',v_ref->'bucket','path',v_ref->'path',
    'source_url',v_ref->'source_url','file',v_receipt->'file','generation',v_state->'generation','avatar',v_ref->'avatar','kind',v_ref->'kind');
END;
$$;

CREATE FUNCTION public.employee_safety_backup_media_commit(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text,
  p_bytes integer,p_sha256 text,p_content_type text,p_storage_origin text,p_generation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_context jsonb;v_state jsonb;v_file jsonb;v_previous jsonb;v_origin text;v_refs jsonb;
BEGIN
  v_job:=private.employee_safety_backup_owner(p_admin_session_token,p_job_token);
  -- Serialize receipt merges, then reauthorize/source-check AFTER the actual read/row lock.
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_context:=public.employee_safety_backup_media_authorize(p_admin_session_token,p_job_token,p_action,p_object_key);
  v_job:=private.employee_safety_backup_owner(p_admin_session_token,p_job_token);
  IF p_generation IS NULL OR p_generation IS DISTINCT FROM v_context->>'generation' THEN
    RAISE EXCEPTION 'Employee safety media read generation changed.';
  END IF;
  IF p_storage_origin IS NULL OR p_storage_origin ~ '[[:cntrl:]]'
    OR p_storage_origin !~ '^https://[a-z0-9-]+[.]supabase[.]co$' THEN RAISE EXCEPTION 'Invalid employee safety Storage origin.';END IF;
  v_state:=private.employee_safety_media_state(v_job);v_origin:=v_state->>'storage_origin';
  IF v_origin IS NOT NULL AND v_origin IS DISTINCT FROM p_storage_origin THEN RAISE EXCEPTION 'Employee safety Storage origin changed.';END IF;
  v_file:=jsonb_build_object('key',p_object_key,'source_url',v_context->'source_url','bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type);
  PERFORM private.employee_safety_media_file(v_context,v_file);
  IF v_context->'file'<>'null'::jsonb AND v_context->'file' IS DISTINCT FROM v_file THEN RAISE EXCEPTION 'Employee safety media file changed.';END IF;
  v_previous:=v_state#>ARRAY['receipts',p_object_key];
  -- Private-only evidence acquires the configured origin on the FIRST service receipt.
  v_refs:=private.employee_safety_media_refs(v_job,p_storage_origin);
  v_state:=jsonb_set(jsonb_set(v_state,'{refs}',v_refs),'{storage_origin}',to_jsonb(p_storage_origin));
  v_state:=jsonb_set(v_state,ARRAY['receipts',p_object_key],jsonb_build_object('file',v_file,'path',v_context->'path',
    'storage_origin',p_storage_origin,'generation',p_generation,
    'checked',p_action='recheck-export' OR COALESCE(v_previous->'checked'='true'::jsonb,false)));
  v_job.summary:=jsonb_set(v_job.summary,'{employee_safety_media}',v_state);
  PERFORM private.employee_safety_media_state(v_job);
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary WHERE id=v_job.id;
  RETURN jsonb_build_object('success',true,'key',p_object_key,'bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type,
    'complete_employee_backup',false,'can_archive',false,'can_replace',false,'full_site_complete',false);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_safety_media_hash(text),private.employee_safety_media_fields(text),
  private.employee_safety_media_guard(jsonb),private.employee_safety_media_public(text,text,uuid,boolean),
  private.employee_safety_media_owner(uuid,uuid,text),private.employee_safety_media_refs(private.employee_transfer_jobs,text),
  private.employee_safety_media_file(jsonb,jsonb),private.employee_safety_media_state(private.employee_transfer_jobs)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_employee_safety_backup_media(uuid,uuid,text),public.employee_safety_backup_media_verify(uuid,uuid,text),
  public.employee_safety_backup_media_authorize(uuid,uuid,text,text),
  public.employee_safety_backup_media_commit(uuid,uuid,text,text,integer,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_safety_backup_media(uuid,uuid,text),public.employee_safety_backup_media_verify(uuid,uuid,text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.employee_safety_backup_media_authorize(uuid,uuid,text,text),
  public.employee_safety_backup_media_commit(uuid,uuid,text,text,integer,text,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
