BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- SQL26's tokenizer is shared as-is; its notification bucket/RPC whitelist is NOT extended.
-- This substage never rewrites staged chat_catalog/NDJSON or writes chat business tables.
CREATE FUNCTION private.employee_transfer_chat_media_urls(p_content text,p_direct boolean DEFAULT false)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_urls text[];v_match text[];
BEGIN
  v_urls:=private.employee_transfer_notification_media_urls(p_content,p_direct);
  IF p_content IS NULL OR p_direct THEN RETURN v_urls;END IF;
  IF p_content ~* $re$(https?|storage|supabase)[^[:space:]<>"'`]*[&%\\]$re$ THEN
    RAISE EXCEPTION 'Encoded chat media is unsupported; no file was omitted.';
  END IF;
  -- Also capture non-public/signed raw Storage tokens, so the strict URL check rejects them.
  FOR v_match IN SELECT regexp_matches(p_content,$re$[^[:space:]<>"'`]*[/]storage/v1/object/[^[:space:]<>"'`]*$re$,'gi') LOOP
    v_urls:=array_append(v_urls,v_match[1]);
  END LOOP;
  RETURN v_urls;
END;
$$;

-- Smallest safe contract: rating JSON is not a media container. Reject suspected references
-- recursively (including decoded JSON keys/strings), rather than guessing or reserializing it.
CREATE FUNCTION private.employee_transfer_chat_rating_media_guard(p_value jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_entry record;v_item jsonb;v_text text;
BEGIN
  IF jsonb_typeof(p_value)='object' THEN
    FOR v_entry IN SELECT key,value FROM jsonb_each(p_value) LOOP
      -- Known React text field, never a media-loading container. Non-string comments recurse.
      IF v_entry.key='comment' AND jsonb_typeof(v_entry.value)='string' THEN CONTINUE;END IF;
      IF v_entry.key ~* '(url|uri|src|href|poster|image|avatar|file|attachment|media|path|bucket|storage|base64)' THEN
        RAISE EXCEPTION 'Chat rating JSON contains unsupported media fields.';
      END IF;
      PERFORM private.employee_transfer_chat_rating_media_guard(v_entry.value);
    END LOOP;
  ELSIF jsonb_typeof(p_value)='array' THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      PERFORM private.employee_transfer_chat_rating_media_guard(v_item);
    END LOOP;
  ELSIF jsonb_typeof(p_value)='string' THEN
    v_text:=p_value#>>'{}';
    IF v_text ~ $re$[:/\\%&<>]$re$ OR v_text ~* '(https?|data|blob|storage|supabase|base64)'
      OR v_text ~* '[.](jpe?g|png|gif|webp|pdf|mp4|webm|svg|avif|heic|zip)($|[?#[:space:]])' THEN
      RAISE EXCEPTION 'Chat rating JSON contains unsupported media references.';
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_media_refs(p_job private.employee_transfer_jobs,p_export boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table text;v_field text;v_query text;v_row record;v_url text;v_key text;v_bucket text;v_path text;
  v_content text;v_avatar boolean;v_origin text;v_source_origin text;v_refs jsonb:='{}';v_count integer:=0;
BEGIN
  IF p_export IS NULL THEN RAISE EXCEPTION 'An explicit chat media mode is required.';END IF;
  FOR v_table,v_field IN SELECT * FROM (VALUES
    ('simulated_customers','custom_avatar_url'),('simulated_customers','customer_avatar'),
    ('customer_employee_conversations','message_content'),('customer_employee_conversations','image_url'),
    ('customer_employee_conversations','rating_data'),('cs_message_templates','content'),
    ('customer_auto_messages','content'),('rich_card_contents','html_content')) AS fields(t,f) LOOP
    IF p_export THEN v_query:='SELECT body FROM ('||private.employee_transfer_chat_query(v_table)||') AS r';
    ELSE v_query:='SELECT body FROM private.employee_transfer_chat_input($1,'||quote_literal(v_table)||')';END IF;
    FOR v_row IN EXECUTE v_query USING p_job.id LOOP
      IF v_field='rating_data' THEN
        PERFORM private.employee_transfer_chat_rating_media_guard(v_row.body->v_field);CONTINUE;
      END IF;
      v_content:=v_row.body->>v_field;
      IF v_content IS NULL THEN CONTINUE;END IF;
      IF v_field='customer_avatar' AND v_content ~ '^customer-avatar:(regular|vip):[0-9]+$'
        AND v_content !~ '[[:cntrl:]]' THEN CONTINUE;END IF;
      FOREACH v_url IN ARRAY private.employee_transfer_chat_media_urls(v_content,v_field IN ('image_url','custom_avatar_url','customer_avatar')) LOOP
        IF octet_length(v_url)>1024 OR v_url ~ '[[:cntrl:]]'
          OR v_url !~ '^https://[a-z0-9-]+[.]supabase[.]co/storage/v1/object/public/(announcement-images|chat-images|template-images|super-customer-avatars)/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*[.][A-Za-z0-9]{1,8}$' THEN
          RAISE EXCEPTION 'Unmanaged chat media URL; no file was omitted.';
        END IF;
        v_bucket:=split_part(v_url,'/',8);v_path:=substring(v_url FROM length(split_part(v_url,'/storage/',1))+length('/storage/v1/object/public/')+length(v_bucket)+2);
        IF strpos(v_path,'..')>0 OR v_path ~ '(^|/)[.](/|$)'
          OR (v_bucket='super-customer-avatars' AND left(v_path,8)<>'avatars/') THEN RAISE EXCEPTION 'Unsafe chat media path.';END IF;
        v_source_origin:=split_part(v_url,'/storage/',1);
        IF v_origin IS NOT NULL AND v_origin IS DISTINCT FROM v_source_origin THEN RAISE EXCEPTION 'Chat media spans different storage origins.';END IF;
        v_origin:=v_source_origin;
        v_avatar:=v_table='simulated_customers' OR v_bucket='super-customer-avatars';
        v_key:=encode(extensions.digest(convert_to(v_url,'UTF8'),'sha256'),'hex');
        IF v_refs ? v_key THEN
          IF v_refs#>>ARRAY[v_key,'source_url'] IS DISTINCT FROM v_url THEN RAISE EXCEPTION 'Chat media key collision.';END IF;
          IF v_avatar THEN v_refs:=jsonb_set(v_refs,ARRAY[v_key,'avatar'],'true'::jsonb);END IF;
        ELSE
          v_count:=v_count+1;
          IF v_count>3000 THEN RAISE EXCEPTION 'Chat media exceeds 3000 files; no files were truncated.';END IF;
          v_refs:=v_refs||jsonb_build_object(v_key,jsonb_build_object('key',v_key,'source_url',v_url,'bucket',v_bucket,'path',v_path,'avatar',v_avatar));
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN COALESCE((SELECT jsonb_agg(value ORDER BY key COLLATE "C") FROM jsonb_each(v_refs)),'[]'::jsonb);
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_media_files(p_refs jsonb,p_files jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_ref jsonb;v_file jsonb;v_n integer:=0;v_total bigint:=0;
BEGIN
  IF jsonb_typeof(p_files) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid chat media catalog.';END IF;
  IF jsonb_array_length(p_files)<>jsonb_array_length(p_refs) OR octet_length(p_files::text)>4194304 THEN RAISE EXCEPTION 'Incomplete or oversized chat media catalog.';END IF;
  FOR v_ref IN SELECT value FROM jsonb_array_elements(p_refs) LOOP
    v_file:=p_files->v_n;v_n:=v_n+1;
    IF NOT private.employee_transfer_exact_object(v_file,ARRAY['key','source_url','bytes','sha256','content_type'])
      OR v_file->'key' IS DISTINCT FROM v_ref->'key' OR v_file->'source_url' IS DISTINCT FROM v_ref->'source_url'
      OR jsonb_typeof(v_file->'bytes') IS DISTINCT FROM 'number' OR (v_file->>'bytes') !~ '^[1-9][0-9]{0,7}$'
      OR jsonb_typeof(v_file->'sha256') IS DISTINCT FROM 'string' OR (v_file->>'sha256') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(v_file->'content_type') IS DISTINCT FROM 'string'
      OR v_file->>'content_type' NOT IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf','video/mp4','video/webm') THEN
      RAISE EXCEPTION 'Invalid or mismatched chat file.';
    END IF;
    IF (v_file->>'bytes')::bigint>52428800 THEN RAISE EXCEPTION 'Chat file exceeds 50 MiB.';END IF;
    IF v_ref->'avatar'='true'::jsonb AND ((v_file->>'bytes')::bigint>5242880
      OR v_file->>'content_type' NOT IN ('image/jpeg','image/png','image/gif','image/webp')) THEN RAISE EXCEPTION 'Chat avatar must be an image of at most 5 MiB.';END IF;
    v_total:=v_total+(v_file->>'bytes')::bigint;
  END LOOP;
  IF v_total>1073741824 THEN RAISE EXCEPTION 'Chat media exceeds 1 GiB; no files were truncated.';END IF;
  RETURN v_total;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_media_total(p_job private.employee_transfer_jobs,p_media_bytes bigint)
RETURNS void LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_records bigint;
BEGIN
  PERFORM private.employee_transfer_check_chat_catalog(p_job.summary->'chat_catalog');
  SELECT COALESCE(sum((value->>'bytes')::bigint),0) INTO v_records FROM jsonb_array_elements(p_job.summary#>'{chat_catalog,tables}');
  IF p_media_bytes IS NULL OR p_media_bytes<0 OR v_records+p_media_bytes>1073741824 THEN RAISE EXCEPTION 'Chat records plus media exceed 1 GiB.';END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_media_generation(p_job private.employee_transfer_jobs)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_value text:=COALESCE(p_job.summary#>>'{chat_restore,generation}','0');
BEGIN
  IF (p_job.summary#>'{chat_restore,generation}' IS NOT NULL AND jsonb_typeof(p_job.summary#>'{chat_restore,generation}') IS DISTINCT FROM 'string')
    OR v_value ~ '[[:cntrl:]]' OR v_value !~ '^(0|[1-9][0-9]{0,18})$' OR v_value::numeric>9223372036854775807 THEN RAISE EXCEPTION 'Invalid chat media generation.';END IF;
  RETURN v_value;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_media_job(p_session uuid,p_token uuid,p_direction text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_admin uuid;
BEGIN
  SELECT admin_id INTO v_admin FROM private.employee_transfer_admin(p_session);
  SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE token_hash=private.hash_financial_token(p_token)
    AND admin_id=v_admin AND status='running' AND last_activity_at>now()-interval '3 hours' AND started_at>now()-interval '12 hours'
    AND ((p_direction='export' AND kind='export' AND options->>'export_protocol'='site-chat-v1')
      OR (p_direction='import' AND kind='import' AND options->>'import_protocol'='dispatch-submission-v1'));
  IF p_token IS NULL OR v_job.id IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.';END IF;
  -- Same authority/protocol/lifetime checks as employee_transfer_job, without refreshing heartbeat.
  IF p_direction='export' THEN
    PERFORM private.employee_transfer_check_chat_catalog(v_job.summary->'chat_catalog');
    IF v_job.summary->'chat_catalog' IS DISTINCT FROM private.employee_transfer_chat_catalog((v_job.options->>'package_id')::uuid) THEN RAISE EXCEPTION 'Chat, finance or identity source changed; restart the export.';END IF;
  ELSIF p_direction='import' THEN
    PERFORM private.employee_transfer_chat_owner(v_job);PERFORM private.employee_transfer_check_chat_input(v_job);
    PERFORM private.employee_transfer_chat_media_generation(v_job);
  ELSE RAISE EXCEPTION 'Unsupported chat media direction.';END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_media_target_path(p_job private.employee_transfer_jobs,p_ref jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT CASE WHEN p_ref->>'bucket'='super-customer-avatars' THEN 'avatars' ELSE p_job.admin_id::text END||'/transfer-'||
    left(encode(extensions.digest(convert_to(p_job.id::text||':'||(p_ref->>'key'),'UTF8'),'sha256'),'hex'),32)||'.'||lower(substring(p_ref->>'path' FROM '[.]([A-Za-z0-9]{1,8})$'));
$$;

CREATE FUNCTION public.get_employee_transfer_chat_media(p_admin_session_token uuid,p_job_token uuid,p_direction text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_refs jsonb;v_files jsonb;
BEGIN
  v_job:=private.employee_transfer_chat_media_job(p_admin_session_token,p_job_token,p_direction);
  v_refs:=private.employee_transfer_chat_media_refs(v_job,p_direction='export');
  IF p_direction='export' THEN
    SELECT COALESCE(jsonb_agg(ref.value||jsonb_build_object('file',s.payload->'file') ORDER BY ref.n),'[]'::jsonb) INTO v_files
      FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n)
      LEFT JOIN private.employee_transfer_staging AS s ON s.job_id=v_job.id AND s.employee_id='00000000-0000-0000-0000-000000000000' AND s.table_key='chat-media:export' AND s.chunk_no=ref.n-1;
  ELSE
    IF v_job.summary ? 'chat_media_files' THEN
      PERFORM private.employee_transfer_chat_media_total(v_job,private.employee_transfer_chat_media_files(v_refs,v_job.summary->'chat_media_files'));
    END IF;
    SELECT COALESCE(jsonb_agg(ref.value||jsonb_build_object('file',v_job.summary->'chat_media_files'->((ref.n-1)::integer)) ORDER BY ref.n),'[]'::jsonb) INTO v_files FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n);
  END IF;
  RETURN jsonb_build_object('version',1,'scope','site-chat-media','direction',p_direction,'chat_catalog',v_job.summary->'chat_catalog','files',v_files,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_chat_media_bind(p_admin_session_token uuid,p_job_token uuid,p_files jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_refs jsonb;v_total bigint;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_chat_media_job(p_admin_session_token,p_job_token,'import');
  v_refs:=private.employee_transfer_chat_media_refs(v_job,false);
  v_total:=private.employee_transfer_chat_media_files(v_refs,p_files);PERFORM private.employee_transfer_chat_media_total(v_job,v_total);
  v_repeated:=v_job.summary ? 'chat_media_files';
  IF v_repeated THEN
    IF p_files IS DISTINCT FROM v_job.summary->'chat_media_files' THEN RAISE EXCEPTION 'Chat media binding is immutable.';END IF;
  ELSE
    IF v_job.summary ? 'chat_restore' THEN RAISE EXCEPTION 'Chat media binding is frozen.';END IF;
    UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('chat_media_files',p_files) WHERE id=v_job.id;
  END IF;
  RETURN jsonb_build_object('success',true,'version',1,'scope','site-chat-media','files',jsonb_array_length(v_refs),'bytes',v_total,'repeated',v_repeated,'full_site_complete',false);
END;
$$;

-- Only service_role may attest actual bytes. Generation is a decimal STRING in JSON,
-- including '0' for export, and a bigint RPC argument (never a JS floating-point number).
CREATE FUNCTION public.employee_transfer_chat_media_authorize(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_direction text;v_refs jsonb;v_ref jsonb;v_file jsonb;v_path text;v_n integer;v_receipt jsonb;
BEGIN
  IF p_action IN ('download','recheck-export') THEN v_direction:='export';
  ELSIF p_action IN ('upload','recheck-import') THEN v_direction:='import';ELSE RAISE EXCEPTION 'Unsupported chat media action.';END IF;
  IF p_object_key IS NULL OR p_object_key ~ '[[:cntrl:]]' OR p_object_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid chat object key.';END IF;
  v_job:=private.employee_transfer_chat_media_job(p_admin_session_token,p_job_token,v_direction);
  v_refs:=private.employee_transfer_chat_media_refs(v_job,v_direction='export');
  SELECT value,(n-1)::integer INTO v_ref,v_n FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n) WHERE value->>'key'=p_object_key;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Chat media is outside this task.';END IF;
  SELECT payload INTO v_receipt FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='chat-media:'||v_direction AND chunk_no=v_n;
  IF p_action IN ('recheck-export','recheck-import') AND v_receipt IS NULL THEN RAISE EXCEPTION 'Chat media must first be transferred.';END IF;
  IF v_direction='export' THEN v_file:=v_receipt->'file';v_path:=v_ref->>'path';
  ELSE
    PERFORM private.employee_transfer_chat_media_total(v_job,private.employee_transfer_chat_media_files(v_refs,v_job.summary->'chat_media_files'));
    v_file:=v_job.summary->'chat_media_files'->v_n;v_path:=private.employee_transfer_chat_media_target_path(v_job,v_ref);
  END IF;
  IF v_receipt IS NOT NULL AND (v_receipt#>'{file,key}' IS DISTINCT FROM v_ref->'key' OR v_receipt#>'{file,source_url}' IS DISTINCT FROM v_ref->'source_url'
    OR v_receipt->>'path' IS DISTINCT FROM v_path OR (v_direction='import' AND v_receipt->'file' IS DISTINCT FROM v_file)) THEN RAISE EXCEPTION 'Chat media receipt binding changed.';END IF;
  RETURN jsonb_build_object('direction',v_direction,'key',p_object_key,'bucket',v_ref->>'bucket','path',v_path,'source_url',v_ref->>'source_url','file',v_file,'avatar',v_ref->'avatar',
    'generation',CASE WHEN v_direction='export' THEN '0' ELSE private.employee_transfer_chat_media_generation(v_job) END);
END;
$$;

CREATE FUNCTION public.employee_transfer_chat_media_commit(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text,p_bytes integer,p_sha256 text,p_content_type text,p_storage_origin text,p_generation bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_context jsonb;v_job private.employee_transfer_jobs%ROWTYPE;v_direction text;v_file jsonb;v_refs jsonb;v_n integer;
  v_previous jsonb;v_table text;v_origin text;v_total bigint;v_checked boolean;
BEGIN
  IF p_action IN ('download','recheck-export') THEN v_direction:='export';v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'chat-export');
  ELSIF p_action IN ('upload','recheck-import') THEN v_direction:='import';v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  ELSE RAISE EXCEPTION 'Unsupported chat media action.';END IF;
  -- Same job row lock as SQL32's generation change; revalidate tokens and input AFTER the lock.
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_context:=public.employee_transfer_chat_media_authorize(p_admin_session_token,p_job_token,p_action,p_object_key);
  SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE id=v_job.id;
  IF p_generation IS NULL OR p_generation<0 OR p_generation::text IS DISTINCT FROM v_context->>'generation' THEN RAISE EXCEPTION 'Chat media read generation changed; read the file again.';END IF;
  IF p_storage_origin IS NULL OR p_storage_origin ~ '[[:cntrl:]]' OR p_storage_origin !~ '^https://[a-z0-9-]+[.]supabase[.]co$'
    OR p_bytes IS NULL OR p_bytes NOT BETWEEN 1 AND 52428800 OR p_sha256 IS NULL OR p_sha256 ~ '[[:cntrl:]]' OR p_sha256 !~ '^[0-9a-f]{64}$'
    OR p_content_type IS NULL OR p_content_type NOT IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf','video/mp4','video/webm') THEN RAISE EXCEPTION 'Invalid verified chat media receipt.';END IF;
  IF v_context->'avatar'='true'::jsonb AND (p_bytes>5242880 OR p_content_type NOT IN ('image/jpeg','image/png','image/gif','image/webp')) THEN RAISE EXCEPTION 'Chat avatar must be an image of at most 5 MiB.';END IF;
  IF v_direction='export' AND split_part(v_context->>'source_url','/storage/',1) IS DISTINCT FROM p_storage_origin THEN RAISE EXCEPTION 'Source chat media is not stored on this site.';END IF;
  v_file:=jsonb_build_object('key',p_object_key,'source_url',v_context->>'source_url','bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type);
  IF v_context->'file'<>'null'::jsonb AND v_file IS DISTINCT FROM v_context->'file' THEN RAISE EXCEPTION 'Chat media content changed.';END IF;
  v_origin:=v_job.summary->>'chat_storage_origin';
  IF v_origin IS NOT NULL AND v_origin IS DISTINCT FROM p_storage_origin THEN RAISE EXCEPTION 'Chat storage origin changed.';END IF;
  v_refs:=private.employee_transfer_chat_media_refs(v_job,v_direction='export');
  SELECT (n-1)::integer INTO v_n FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n) WHERE value->>'key'=p_object_key;
  v_table:='chat-media:'||v_direction;
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key=v_table AND chunk_no=v_n;
  IF v_previous IS NOT NULL AND (v_previous->'file' IS DISTINCT FROM v_file OR v_previous->>'path' IS DISTINCT FROM v_context->>'path' OR v_previous->>'storage_origin' IS DISTINCT FROM p_storage_origin) THEN RAISE EXCEPTION 'Chat media receipt is immutable.';END IF;
  SELECT COALESCE(sum((payload#>>'{file,bytes}')::bigint),0)+p_bytes INTO v_total FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key=v_table AND chunk_no<>v_n;
  PERFORM private.employee_transfer_chat_media_total(v_job,v_total);
  v_checked:=p_action IN ('recheck-export','recheck-import') OR (v_previous->>'generation' IS NOT DISTINCT FROM p_generation::text AND v_previous->'checked'='true'::jsonb
    AND (v_job.summary#>>'{chat_restore,last_apply_at}' IS NULL OR (v_previous->>'checked_at')::timestamptz >= (v_job.summary#>>'{chat_restore,last_apply_at}')::timestamptz));
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,'00000000-0000-0000-0000-000000000000',v_table,v_n,1,jsonb_build_object('file',v_file,'path',v_context->>'path',
      'storage_origin',p_storage_origin,'generation',p_generation::text,'checked',COALESCE(v_checked,false),'checked_at',clock_timestamp()))
    ON CONFLICT(job_id,employee_id,table_key,chunk_no) DO UPDATE SET payload=EXCLUDED.payload;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('chat_storage_origin',p_storage_origin) WHERE id=v_job.id;
  RETURN jsonb_build_object('success',true,'key',p_object_key,'bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type,'full_site_complete',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_media_ready(p_job private.employee_transfer_jobs,p_final boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_refs jsonb;v_ref record;v_file jsonb;v_receipt jsonb;v_origin text;v_rows integer;v_generation text;
BEGIN
  IF p_final IS NULL THEN RAISE EXCEPTION 'An explicit chat media readiness mode is required.';END IF;
  PERFORM private.employee_transfer_chat_owner(p_job);PERFORM private.employee_transfer_check_chat_input(p_job);
  v_generation:=private.employee_transfer_chat_media_generation(p_job);
  IF jsonb_typeof(p_job.summary->'chat_media_files') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  v_refs:=private.employee_transfer_chat_media_refs(p_job,false);
  PERFORM private.employee_transfer_chat_media_total(p_job,private.employee_transfer_chat_media_files(v_refs,p_job.summary->'chat_media_files'));
  IF (SELECT count(*) FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='chat-media:import')<>jsonb_array_length(v_refs) THEN RETURN false;END IF;
  v_origin:=p_job.summary->>'chat_storage_origin';
  IF jsonb_array_length(v_refs)>0 AND (v_origin IS NULL OR v_origin ~ '[[:cntrl:]]' OR v_origin !~ '^https://[a-z0-9-]+[.]supabase[.]co$') THEN RETURN false;END IF;
  FOR v_ref IN SELECT value,(n-1)::integer AS no FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n) LOOP
    v_file:=p_job.summary->'chat_media_files'->v_ref.no;
    SELECT payload,row_count INTO v_receipt,v_rows FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='chat-media:import' AND chunk_no=v_ref.no;
    IF NOT private.employee_transfer_exact_object(v_receipt,ARRAY['file','path','storage_origin','generation','checked','checked_at']) OR v_rows IS DISTINCT FROM 1
      OR v_receipt->'file' IS DISTINCT FROM v_file OR v_receipt->>'path' IS DISTINCT FROM private.employee_transfer_chat_media_target_path(p_job,v_ref.value)
      OR v_receipt->>'storage_origin' IS DISTINCT FROM v_origin OR jsonb_typeof(v_receipt->'generation') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_receipt->'checked') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_receipt->'checked_at') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
    IF p_final AND (v_receipt->>'generation' IS DISTINCT FROM v_generation OR v_receipt->'checked' IS DISTINCT FROM 'true'::jsonb
      OR (p_job.summary#>>'{chat_restore,last_apply_at}' IS NOT NULL AND (v_receipt->>'checked_at')::timestamptz < (p_job.summary#>>'{chat_restore,last_apply_at}')::timestamptz)) THEN RETURN false;END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION private.employee_transfer_chat_rewrite_media(p_job private.employee_transfer_jobs,p_content text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_refs jsonb;v_urls text[];v_url text;v_ref jsonb;v_receipt jsonb;v_map jsonb:='{}';v_rest text;v_result text:='';v_next record;
BEGIN
  IF p_content IS NULL THEN RETURN NULL;END IF;
  v_urls:=private.employee_transfer_chat_media_urls(p_content,false);
  IF cardinality(v_urls)=0 THEN RETURN p_content;END IF;
  IF NOT private.employee_transfer_chat_media_ready(p_job,false) THEN RAISE EXCEPTION 'Verified target chat media is required before rewriting.';END IF;
  v_refs:=private.employee_transfer_chat_media_refs(p_job,false);
  FOREACH v_url IN ARRAY v_urls LOOP
    SELECT value INTO v_ref FROM jsonb_array_elements(v_refs) WHERE value->>'source_url'=v_url;
    IF v_ref IS NULL THEN RAISE EXCEPTION 'Chat rewrite URL is outside the verified package.';END IF;
    SELECT payload INTO STRICT v_receipt FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='chat-media:import' AND payload#>>'{file,key}'=v_ref->>'key';
    v_map:=v_map||jsonb_build_object(v_url,(v_receipt->>'storage_origin')||'/storage/v1/object/public/'||(v_ref->>'bucket')||'/'||(v_receipt->>'path'));
  END LOOP;
  -- Simultaneous literal replacement on ORIGINAL text; never normalize HTML or cascade URLs.
  v_rest:=p_content;
  LOOP
    SELECT key,value,strpos(v_rest,key) AS pos INTO v_next FROM jsonb_each_text(v_map) WHERE strpos(v_rest,key)>0 ORDER BY strpos(v_rest,key),length(key) DESC,key COLLATE "C" LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_result:=v_result||left(v_rest,v_next.pos-1)||v_next.value;v_rest:=substring(v_rest FROM v_next.pos+length(v_next.key));
  END LOOP;
  RETURN v_result||v_rest;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_chat_media_export(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_refs jsonb;v_ref record;v_receipt jsonb;v_files jsonb:='[]';v_rows integer;
BEGIN
  IF p_job.kind IS DISTINCT FROM 'export' OR p_job.status IS DISTINCT FROM 'running' OR p_job.options->>'export_protocol' IS DISTINCT FROM 'site-chat-v1' THEN RAISE EXCEPTION 'Not a running chat export.';END IF;
  IF p_job.summary->'chat_catalog' IS DISTINCT FROM private.employee_transfer_chat_catalog((p_job.options->>'package_id')::uuid) THEN RAISE EXCEPTION 'Chat, finance or identity source changed; restart the export.';END IF;
  v_refs:=private.employee_transfer_chat_media_refs(p_job,true);
  IF (SELECT count(*) FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='chat-media:export')<>jsonb_array_length(v_refs) THEN RAISE EXCEPTION 'Chat media export is incomplete.';END IF;
  FOR v_ref IN SELECT value,(n-1)::integer AS no FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n) LOOP
    SELECT payload,row_count INTO v_receipt,v_rows FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='chat-media:export' AND chunk_no=v_ref.no;
    IF NOT private.employee_transfer_exact_object(v_receipt,ARRAY['file','path','storage_origin','generation','checked','checked_at']) OR v_rows IS DISTINCT FROM 1
      OR v_receipt->'checked' IS DISTINCT FROM 'true'::jsonb OR v_receipt->>'generation' IS DISTINCT FROM '0'
      OR v_receipt->>'path' IS DISTINCT FROM v_ref.value->>'path' OR jsonb_typeof(v_receipt->'checked_at') IS DISTINCT FROM 'string'
      OR v_receipt->>'storage_origin' IS DISTINCT FROM split_part(v_ref.value->>'source_url','/storage/',1) OR v_receipt->>'storage_origin' IS DISTINCT FROM p_job.summary->>'chat_storage_origin' THEN RAISE EXCEPTION 'Chat media requires matching export readback.';END IF;
    v_files:=v_files||jsonb_build_array(v_receipt->'file');
  END LOOP;
  PERFORM private.employee_transfer_chat_media_total(p_job,private.employee_transfer_chat_media_files(v_refs,v_files));
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_chat_media_urls(text,boolean),private.employee_transfer_chat_rating_media_guard(jsonb),
  private.employee_transfer_chat_media_refs(private.employee_transfer_jobs,boolean),private.employee_transfer_chat_media_files(jsonb,jsonb),
  private.employee_transfer_chat_media_total(private.employee_transfer_jobs,bigint),private.employee_transfer_chat_media_generation(private.employee_transfer_jobs),
  private.employee_transfer_chat_media_job(uuid,uuid,text),private.employee_transfer_chat_media_target_path(private.employee_transfer_jobs,jsonb),
  private.employee_transfer_chat_media_ready(private.employee_transfer_jobs,boolean),private.employee_transfer_chat_rewrite_media(private.employee_transfer_jobs,text),
  private.employee_transfer_check_chat_media_export(private.employee_transfer_jobs) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_employee_transfer_chat_media(uuid,uuid,text),public.employee_import_chat_media_bind(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_transfer_chat_media(uuid,uuid,text),public.employee_import_chat_media_bind(uuid,uuid,jsonb) TO anon,authenticated;
REVOKE ALL ON FUNCTION public.employee_transfer_chat_media_authorize(uuid,uuid,text,text),public.employee_transfer_chat_media_commit(uuid,uuid,text,text,integer,text,text,text,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_transfer_chat_media_authorize(uuid,uuid,text,text),public.employee_transfer_chat_media_commit(uuid,uuid,text,text,integer,text,text,text,bigint) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
