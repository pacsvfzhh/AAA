BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- Fail closed on unsupported media syntax, without parsing/reserializing the source body.
-- This is a conservative HTML attribute tokenizer, not an HTML sanitizer or CSS parser.
CREATE FUNCTION private.employee_transfer_notification_media_urls(p_content text,p_direct boolean DEFAULT false)
RETURNS text[] LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_urls text[]:='{}';v_rest text;v_name text;v_attr text;v_value text;v_quote text;
  v_open integer;v_end integer;v_quoted boolean;v_match text[];
BEGIN
  IF p_content IS NULL THEN RETURN v_urls;END IF;
  IF p_direct IS NULL THEN RAISE EXCEPTION 'An explicit notification media field mode is required.';END IF;
  IF p_direct THEN RETURN ARRAY[p_content];END IF;
  IF p_content ~* '(^|[^A-Za-z0-9_-])url[[:space:]]*[(]' THEN
    RAISE EXCEPTION 'CSS media URLs are unsupported; no notification media was omitted.';
  END IF;
  v_rest:=p_content;
  LOOP
    v_open:=strpos(v_rest,'<');EXIT WHEN v_open=0;
    v_rest:=substring(v_rest FROM v_open+1);
    -- Reject comments/declarations rather than disagreeing with browser comment recovery.
    IF left(v_rest,1) IN ('!','?') THEN RAISE EXCEPTION 'Unsupported notification HTML comment or declaration.';END IF;
    v_name:=substring(v_rest FROM '^/?[A-Za-z][A-Za-z0-9:_-]*');
    IF v_name IS NULL THEN CONTINUE;END IF;
    IF lower(ltrim(v_name,'/')) IN ('style','script') THEN RAISE EXCEPTION 'Unreviewed notification HTML raw text.';END IF;
    v_rest:=substring(v_rest FROM length(v_name)+1);
    LOOP
      v_rest:=ltrim(v_rest,E' \t\n\r\f');
      IF left(v_rest,1)='>' THEN v_rest:=substring(v_rest FROM 2);EXIT;END IF;
      IF left(v_rest,2)='/>' THEN v_rest:=substring(v_rest FROM 3);EXIT;END IF;
      v_attr:=substring(v_rest FROM $re$^[^[:space:]<>"'=/`]+$re$);
      IF v_attr IS NULL THEN RAISE EXCEPTION 'Malformed notification HTML attribute; no media was omitted.';END IF;
      v_rest:=ltrim(substring(v_rest FROM length(v_attr)+1),E' \t\n\r\f');
      v_value:=NULL;v_quoted:=false;
      IF left(v_rest,1)='=' THEN
        v_rest:=ltrim(substring(v_rest FROM 2),E' \t\n\r\f');v_quote:=left(v_rest,1);
        IF v_quote IN ('"',E'\'') THEN
          v_quoted:=true;v_end:=strpos(substring(v_rest FROM 2),v_quote);
          IF v_end=0 THEN RAISE EXCEPTION 'Unterminated notification HTML attribute.';END IF;
          v_value:=substring(v_rest FROM 2 FOR v_end-1);v_rest:=substring(v_rest FROM v_end+2);
        ELSE
          v_value:=substring(v_rest FROM $re$^[^[:space:]<>"'=`]+$re$);
          IF v_value IS NULL THEN RAISE EXCEPTION 'Malformed notification HTML attribute value.';END IF;
          v_rest:=substring(v_rest FROM length(v_value)+1);
        END IF;
      END IF;
      v_attr:=lower(v_attr);
      IF v_attr='srcset' THEN RAISE EXCEPTION 'Notification srcset is unsupported; no media was omitted.';END IF;
      -- Escaped/commented/entity-encoded CSS must not bypass the url() rejection.
      IF v_attr='style' AND (v_value ~ $re$[&\\]$re$ OR strpos(v_value,'/*')>0) THEN
        RAISE EXCEPTION 'Encoded notification CSS is unsupported.';
      END IF;
      IF v_attr IN ('src','poster') THEN
        IF NOT v_quoted OR v_value IS NULL THEN RAISE EXCEPTION 'Notification media attributes must have quoted URLs.';END IF;
        v_urls:=array_append(v_urls,v_value);
      ELSIF v_attr='href' THEN
        IF strpos(v_value,'&')>0 THEN RAISE EXCEPTION 'Encoded notification attachment URLs are unsupported; no file was omitted.';END IF;
        IF v_value ~* '^[[:space:]]*(data|blob):' THEN RAISE EXCEPTION 'Inline notification attachments are unsupported.';END IF;
        IF v_value ~* '/storage/v1/object/' THEN
          IF NOT v_quoted THEN RAISE EXCEPTION 'Notification storage attachment URLs must be quoted.';END IF;
          v_urls:=array_append(v_urls,v_value);
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  -- Include plain public Storage URLs and URLs in other attributes, including attachments.
  -- Consume the ENTIRE token (including %, ?, #, &) so a safe prefix cannot hide a bad URL.
  FOR v_match IN SELECT regexp_matches(p_content,$re$[^[:space:]<>"'`]*[/]storage/v1/object/public/[^[:space:]<>"'`]*$re$,'gi') LOOP
    v_urls:=array_append(v_urls,v_match[1]);
  END LOOP;
  RETURN v_urls;
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_media_refs(p_job private.employee_transfer_jobs,p_export boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_table text;v_field text;v_query text;v_row record;v_url text;v_key text;v_bucket text;v_path text;
  v_origin text;v_source_origin text;v_refs jsonb:='{}';v_count integer:=0;
BEGIN
  IF p_export IS NULL THEN RAISE EXCEPTION 'An explicit notification media mode is required.';END IF;
  FOR v_table,v_field IN SELECT * FROM (VALUES ('messages','content'),('message_templates','content'),
    ('notification_automation_tasks','content_template'),('notification_automation_executions','content_snapshot'),
    ('broadcast_messages','message_content'),('broadcast_messages','image_url')) AS fields(t,f) LOOP
    IF p_export THEN v_query:='SELECT body FROM ('||private.employee_transfer_notifications_query(v_table)||') AS r';
    ELSE v_query:='SELECT body FROM private.employee_transfer_notifications_input($1,'||quote_literal(v_table)||')';END IF;
    FOR v_row IN EXECUTE v_query USING p_job.id LOOP
      FOREACH v_url IN ARRAY private.employee_transfer_notification_media_urls(v_row.body->>v_field,v_field='image_url') LOOP
        IF octet_length(v_url)>1024 OR v_url ~ '[[:cntrl:]]'
          OR v_url !~ '^https://[a-z0-9-]+[.]supabase[.]co/storage/v1/object/public/(announcement-images|chat-images|template-images)/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*[.][A-Za-z0-9]{1,8}$' THEN
          RAISE EXCEPTION 'Unmanaged notification media URL; no file was omitted.';
        END IF;
        v_bucket:=split_part(v_url,'/',8);v_path:=substring(v_url FROM length(split_part(v_url,'/storage/',1))+length('/storage/v1/object/public/')+length(v_bucket)+2);
        IF strpos(v_path,'..')>0 OR v_path ~ '(^|/)[.](/|$)' THEN RAISE EXCEPTION 'Unsafe notification media path.';END IF;
        v_source_origin:=split_part(v_url,'/storage/',1);
        IF v_origin IS NOT NULL AND v_origin IS DISTINCT FROM v_source_origin THEN RAISE EXCEPTION 'Notification media spans different storage origins.';END IF;
        v_origin:=v_source_origin;
        v_key:=encode(extensions.digest(convert_to(v_url,'UTF8'),'sha256'),'hex');
        IF v_refs ? v_key THEN
          IF v_refs#>>ARRAY[v_key,'source_url'] IS DISTINCT FROM v_url THEN RAISE EXCEPTION 'Notification media key collision.';END IF;
        ELSE
          v_count:=v_count+1;
          IF v_count>3000 THEN RAISE EXCEPTION 'Notification media exceeds 3000 files; no files were truncated.';END IF;
          v_refs:=v_refs||jsonb_build_object(v_key,jsonb_build_object('key',v_key,'source_url',v_url,'bucket',v_bucket,'path',v_path));
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
  RETURN COALESCE((SELECT jsonb_agg(value ORDER BY key COLLATE "C") FROM jsonb_each(v_refs)),'[]'::jsonb);
END;
$$;

-- Validates the complete, C-ordered, exact five-key tuple catalog, also for an empty source.
CREATE FUNCTION private.employee_transfer_notification_media_files(p_refs jsonb,p_files jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_ref jsonb;v_file jsonb;v_n integer:=0;v_total bigint:=0;
BEGIN
  IF jsonb_typeof(p_files) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid notification media catalog.';END IF;
  IF jsonb_array_length(p_files)<>jsonb_array_length(p_refs) OR octet_length(p_files::text)>4194304 THEN RAISE EXCEPTION 'Incomplete or oversized notification media catalog.';END IF;
  FOR v_ref IN SELECT value FROM jsonb_array_elements(p_refs) LOOP
    v_file:=p_files->v_n;v_n:=v_n+1;
    IF NOT private.employee_transfer_exact_object(v_file,ARRAY['key','source_url','bytes','sha256','content_type'])
      OR v_file->'key' IS DISTINCT FROM v_ref->'key' OR v_file->'source_url' IS DISTINCT FROM v_ref->'source_url'
      OR jsonb_typeof(v_file->'bytes') IS DISTINCT FROM 'number' OR (v_file->>'bytes') !~ '^[1-9][0-9]{0,7}$'
      OR jsonb_typeof(v_file->'sha256') IS DISTINCT FROM 'string' OR (v_file->>'sha256') !~ '^[0-9a-f]{64}$'
      OR jsonb_typeof(v_file->'content_type') IS DISTINCT FROM 'string'
      OR v_file->>'content_type' NOT IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf','video/mp4','video/webm') THEN
      RAISE EXCEPTION 'Invalid or mismatched notification file.';
    END IF;
    IF (v_file->>'bytes')::bigint>52428800 THEN RAISE EXCEPTION 'Notification file exceeds 50 MiB.';END IF;
    v_total:=v_total+(v_file->>'bytes')::bigint;
  END LOOP;
  IF v_total>1073741824 THEN RAISE EXCEPTION 'Notification media exceeds 1 GiB; no files were truncated.';END IF;
  RETURN v_total;
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_media_job(p_session uuid,p_token uuid,p_direction text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  IF p_direction='export' THEN
    v_job:=private.employee_transfer_job(p_session,p_token,'notifications-export');
    PERFORM private.employee_transfer_check_notifications_catalog(v_job.summary->'notifications_catalog');
    IF v_job.summary->'notifications_catalog' IS DISTINCT FROM private.employee_transfer_notifications_catalog((v_job.options->>'package_id')::uuid) THEN
      RAISE EXCEPTION 'Notifications, finance or identity source changed; restart the export.';
    END IF;
  ELSIF p_direction='import' THEN
    v_job:=private.employee_transfer_notification_job(p_session,p_token);
    PERFORM private.employee_transfer_notifications_owner(v_job);
    PERFORM private.employee_transfer_check_notifications_input(v_job);
  ELSE RAISE EXCEPTION 'Unsupported notification media direction.';END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_media_target_path(p_job private.employee_transfer_jobs,p_ref jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT p_job.admin_id::text||'/transfer-'||left(encode(extensions.digest(convert_to(p_job.id::text||':'||(p_ref->>'key'),'UTF8'),'sha256'),'hex'),32)
    ||'.'||lower(substring(p_ref->>'path' FROM '[.]([A-Za-z0-9]{1,8})$'));
$$;

CREATE FUNCTION public.get_employee_transfer_notification_media(p_admin_session_token uuid,p_job_token uuid,p_direction text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_refs jsonb;v_files jsonb;
BEGIN
  v_job:=private.employee_transfer_notification_media_job(p_admin_session_token,p_job_token,p_direction);
  v_refs:=private.employee_transfer_notification_media_refs(v_job,p_direction='export');
  IF p_direction='export' THEN
    SELECT COALESCE(jsonb_agg(ref.value||jsonb_build_object('file',s.payload->'file') ORDER BY ref.n),'[]'::jsonb) INTO v_files
      FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n)
      LEFT JOIN private.employee_transfer_staging AS s ON s.job_id=v_job.id AND s.employee_id='00000000-0000-0000-0000-000000000000'
        AND s.table_key='notification-media-export' AND s.chunk_no=ref.n-1;
  ELSE
    IF v_job.summary ? 'notification_media_files' THEN PERFORM private.employee_transfer_notification_media_files(v_refs,v_job.summary->'notification_media_files');END IF;
    SELECT COALESCE(jsonb_agg(ref.value||jsonb_build_object('file',v_job.summary->'notification_media_files'->((ref.n-1)::integer)) ORDER BY ref.n),'[]'::jsonb) INTO v_files
      FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n);
  END IF;
  RETURN jsonb_build_object('scope','site-notifications-media','direction',p_direction,'files',v_files,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_import_notification_media_bind(p_admin_session_token uuid,p_job_token uuid,p_files jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_refs jsonb;v_total bigint;v_repeated boolean;
BEGIN
  v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_notification_media_job(p_admin_session_token,p_job_token,'import');
  v_refs:=private.employee_transfer_notification_media_refs(v_job,false);
  v_total:=private.employee_transfer_notification_media_files(v_refs,p_files);
  v_repeated:=v_job.summary ? 'notification_media_files';
  IF v_repeated THEN
    IF p_files IS DISTINCT FROM v_job.summary->'notification_media_files' THEN RAISE EXCEPTION 'Notification media binding is immutable.';END IF;
  ELSE
    IF v_job.summary ? 'notification_restore' THEN RAISE EXCEPTION 'Notification media binding is frozen.';END IF;
    UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('notification_media_files',p_files) WHERE id=v_job.id;
  END IF;
  RETURN jsonb_build_object('success',true,'scope','site-notifications-media','files',jsonb_array_length(v_refs),'bytes',v_total,'repeated',v_repeated,'full_site_complete',false);
END;
$$;

-- These two service-only RPCs attest to Edge reads. SQL never fetches bytes or overwrites Storage.
-- Edge must enforce its configured local origin, upsert=false and actual byte/hash/MIME signatures,
-- including MP4/WebM signatures; a service receipt is not a decoder or antivirus result.
CREATE FUNCTION public.employee_transfer_notification_media_authorize(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_direction text;v_refs jsonb;v_ref jsonb;v_file jsonb;v_path text;v_n integer;v_receipt jsonb;
BEGIN
  IF p_action IN ('download','recheck-export') THEN v_direction:='export';
  ELSIF p_action IN ('upload','recheck-import') THEN v_direction:='import';
  ELSE RAISE EXCEPTION 'Unsupported notification media action.';END IF;
  IF p_object_key IS NULL OR p_object_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid notification object key.';END IF;
  v_job:=private.employee_transfer_notification_media_job(p_admin_session_token,p_job_token,v_direction);
  v_refs:=private.employee_transfer_notification_media_refs(v_job,v_direction='export');
  SELECT value,(n-1)::integer INTO v_ref,v_n FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n) WHERE value->>'key'=p_object_key;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Notification media is outside this task.';END IF;
  SELECT payload INTO v_receipt FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000'
    AND table_key='notification-media-'||v_direction AND chunk_no=v_n;
  IF p_action IN ('recheck-export','recheck-import') AND v_receipt IS NULL THEN RAISE EXCEPTION 'Notification media must first be transferred.';END IF;
  IF v_direction='export' THEN v_file:=v_receipt->'file';v_path:=v_ref->>'path';
  ELSE
    PERFORM private.employee_transfer_notification_media_files(v_refs,v_job.summary->'notification_media_files');
    v_file:=v_job.summary->'notification_media_files'->v_n;
    v_path:=private.employee_transfer_notification_media_target_path(v_job,v_ref);
  END IF;
  IF v_receipt IS NOT NULL AND (v_receipt#>'{file,key}' IS DISTINCT FROM v_ref->'key'
    OR v_receipt#>'{file,source_url}' IS DISTINCT FROM v_ref->'source_url' OR v_receipt->>'path' IS DISTINCT FROM v_path
    OR (v_direction='import' AND v_receipt->'file' IS DISTINCT FROM v_file)) THEN RAISE EXCEPTION 'Notification media receipt binding changed.';END IF;
  RETURN jsonb_build_object('direction',v_direction,'key',p_object_key,'bucket',v_ref->>'bucket','path',v_path,'source_url',v_ref->>'source_url','file',v_file,
    'generation',CASE WHEN v_direction='export' THEN 'export' ELSE COALESCE(v_job.summary#>>'{notification_restore,generation}','0') END);
END;
$$;

CREATE FUNCTION public.employee_transfer_notification_media_commit(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text,p_bytes integer,p_sha256 text,p_content_type text,p_storage_origin text,p_generation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_context jsonb;v_job private.employee_transfer_jobs%ROWTYPE;v_direction text;v_file jsonb;v_refs jsonb;v_n integer;
  v_previous jsonb;v_table text;v_origin text;v_total bigint;v_checked boolean;
BEGIN
  -- Serialize origin/receipt binding with restore generation changes and concurrent commits.
  IF p_action IN ('download','recheck-export') THEN v_direction:='export';v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'notifications-export');
  ELSIF p_action IN ('upload','recheck-import') THEN v_direction:='import';v_job:=private.employee_transfer_notification_job(p_admin_session_token,p_job_token);
  ELSE RAISE EXCEPTION 'Unsupported notification media action.';END IF;
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_context:=public.employee_transfer_notification_media_authorize(p_admin_session_token,p_job_token,p_action,p_object_key);
  SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE id=v_job.id;
  IF p_generation IS NULL OR p_generation IS DISTINCT FROM v_context->>'generation' THEN RAISE EXCEPTION 'Notification media read generation changed; read the file again.';END IF;
  IF p_storage_origin IS NULL OR p_storage_origin ~ '[[:cntrl:]]' OR p_storage_origin !~ '^https://[a-z0-9-]+[.]supabase[.]co$'
    OR p_bytes IS NULL OR p_bytes NOT BETWEEN 1 AND 52428800 OR p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$'
    OR p_content_type IS NULL OR p_content_type NOT IN ('image/jpeg','image/png','image/gif','image/webp','application/pdf','video/mp4','video/webm') THEN
    RAISE EXCEPTION 'Invalid verified notification media receipt.';
  END IF;
  IF v_direction='export' AND split_part(v_context->>'source_url','/storage/',1) IS DISTINCT FROM p_storage_origin THEN RAISE EXCEPTION 'Source notification media is not stored on this site.';END IF;
  v_file:=jsonb_build_object('key',p_object_key,'source_url',v_context->>'source_url','bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type);
  IF v_context->'file'<>'null'::jsonb AND v_file IS DISTINCT FROM v_context->'file' THEN RAISE EXCEPTION 'Notification media content changed.';END IF;
  v_origin:=v_job.summary->>'notification_storage_origin';
  IF v_origin IS NOT NULL AND v_origin IS DISTINCT FROM p_storage_origin THEN RAISE EXCEPTION 'Notification storage origin changed.';END IF;
  v_refs:=private.employee_transfer_notification_media_refs(v_job,v_direction='export');
  SELECT (n-1)::integer INTO v_n FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n) WHERE value->>'key'=p_object_key;
  v_table:='notification-media-'||v_direction;
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key=v_table AND chunk_no=v_n;
  IF v_previous IS NOT NULL AND (v_previous->'file' IS DISTINCT FROM v_file OR v_previous->>'path' IS DISTINCT FROM v_context->>'path'
    OR v_previous->>'storage_origin' IS DISTINCT FROM p_storage_origin) THEN RAISE EXCEPTION 'Notification media receipt is immutable.';END IF;
  SELECT COALESCE(sum((payload#>>'{file,bytes}')::bigint),0)+p_bytes INTO v_total FROM private.employee_transfer_staging
    WHERE job_id=v_job.id AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key=v_table AND chunk_no<>v_n;
  IF v_total>1073741824 THEN RAISE EXCEPTION 'Notification media exceeds 1 GiB; no files were truncated.';END IF;
  v_checked:=p_action IN ('recheck-export','recheck-import') OR (v_previous->>'generation' IS NOT DISTINCT FROM p_generation AND v_previous->'checked'='true'::jsonb);
  INSERT INTO private.employee_transfer_staging(job_id,employee_id,table_key,chunk_no,row_count,payload)
    VALUES(v_job.id,'00000000-0000-0000-0000-000000000000',v_table,v_n,1,jsonb_build_object('file',v_file,'path',v_context->>'path',
      'storage_origin',p_storage_origin,'generation',p_generation,'checked',COALESCE(v_checked,false),'checked_at',clock_timestamp()))
    ON CONFLICT(job_id,employee_id,table_key,chunk_no) DO UPDATE SET payload=EXCLUDED.payload;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('notification_storage_origin',p_storage_origin) WHERE id=v_job.id;
  RETURN jsonb_build_object('success',true,'key',p_object_key,'bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type,'full_site_complete',false);
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_media_ready(p_job private.employee_transfer_jobs,p_final boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_refs jsonb;v_ref record;v_file jsonb;v_receipt jsonb;v_origin text;v_rows integer;
BEGIN
  IF p_final IS NULL THEN RAISE EXCEPTION 'An explicit notification media readiness mode is required.';END IF;
  PERFORM private.employee_transfer_notifications_owner(p_job);PERFORM private.employee_transfer_check_notifications_input(p_job);
  IF jsonb_typeof(p_job.summary->'notification_media_files') IS DISTINCT FROM 'array' THEN RETURN false;END IF;
  v_refs:=private.employee_transfer_notification_media_refs(p_job,false);
  PERFORM private.employee_transfer_notification_media_files(v_refs,p_job.summary->'notification_media_files');
  IF (SELECT count(*) FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='notification-media-import')<>jsonb_array_length(v_refs) THEN RETURN false;END IF;
  v_origin:=p_job.summary->>'notification_storage_origin';
  IF jsonb_array_length(v_refs)>0 AND (v_origin IS NULL OR v_origin ~ '[[:cntrl:]]' OR v_origin !~ '^https://[a-z0-9-]+[.]supabase[.]co$') THEN RETURN false;END IF;
  FOR v_ref IN SELECT value,(n-1)::integer AS no FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n) LOOP
    v_file:=p_job.summary->'notification_media_files'->v_ref.no;
    SELECT payload,row_count INTO v_receipt,v_rows FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='notification-media-import' AND chunk_no=v_ref.no;
    IF NOT private.employee_transfer_exact_object(v_receipt,ARRAY['file','path','storage_origin','generation','checked','checked_at']) OR v_rows IS DISTINCT FROM 1
      OR v_receipt->'file' IS DISTINCT FROM v_file OR v_receipt->>'path' IS DISTINCT FROM private.employee_transfer_notification_media_target_path(p_job,v_ref.value)
      OR v_receipt->>'storage_origin' IS DISTINCT FROM v_origin OR jsonb_typeof(v_receipt->'generation') IS DISTINCT FROM 'string'
      OR jsonb_typeof(v_receipt->'checked') IS DISTINCT FROM 'boolean' OR jsonb_typeof(v_receipt->'checked_at') IS DISTINCT FROM 'string' THEN RETURN false;END IF;
    IF p_final AND (v_receipt->>'generation' IS DISTINCT FROM COALESCE(p_job.summary#>>'{notification_restore,generation}','0')
      OR v_receipt->'checked' IS DISTINCT FROM 'true'::jsonb) THEN RETURN false;END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE FUNCTION private.employee_transfer_notification_rewrite_media(p_job private.employee_transfer_jobs,p_content text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_refs jsonb;v_urls text[];v_url text;v_ref jsonb;v_receipt jsonb;v_map jsonb:='{}';v_rest text;v_result text:='';v_next record;
BEGIN
  IF p_content IS NULL THEN RETURN NULL;END IF;
  v_urls:=private.employee_transfer_notification_media_urls(p_content,false);
  IF cardinality(v_urls)=0 THEN RETURN p_content;END IF;
  IF NOT private.employee_transfer_notification_media_ready(p_job) THEN RAISE EXCEPTION 'Verified target notification media is required before rewriting.';END IF;
  v_refs:=private.employee_transfer_notification_media_refs(p_job,false);
  FOREACH v_url IN ARRAY v_urls LOOP
    SELECT value INTO v_ref FROM jsonb_array_elements(v_refs) WHERE value->>'source_url'=v_url;
    IF v_ref IS NULL THEN RAISE EXCEPTION 'Notification rewrite URL is outside the verified package.';END IF;
    SELECT payload INTO v_receipt FROM private.employee_transfer_staging WHERE job_id=p_job.id AND employee_id='00000000-0000-0000-0000-000000000000'
      AND table_key='notification-media-import' AND payload#>>'{file,key}'=v_ref->>'key';
    v_map:=v_map||jsonb_build_object(v_url,(v_receipt->>'storage_origin')||'/storage/v1/object/public/'||(v_ref->>'bucket')||'/'||(v_receipt->>'path'));
  END LOOP;
  -- Simultaneous literal replacement on the ORIGINAL text, never cascading into generated URLs.
  -- Longest first at a shared offset also protects URL-prefix pairs. All other bytes stay intact.
  v_rest:=p_content;
  LOOP
    SELECT key,value,strpos(v_rest,key) AS pos INTO v_next FROM jsonb_each_text(v_map) WHERE strpos(v_rest,key)>0
      ORDER BY strpos(v_rest,key),length(key) DESC,key COLLATE "C" LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_result:=v_result||left(v_rest,v_next.pos-1)||v_next.value;
    v_rest:=substring(v_rest FROM v_next.pos+length(v_next.key));
  END LOOP;
  RETURN v_result||v_rest;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_notification_media_export(p_job private.employee_transfer_jobs)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_refs jsonb;v_ref record;v_receipt jsonb;v_files jsonb:='[]';v_rows integer;
BEGIN
  IF p_job.kind IS DISTINCT FROM 'export' OR p_job.status IS DISTINCT FROM 'running'
    OR p_job.options->>'export_protocol' IS DISTINCT FROM 'site-notifications-v1' THEN RAISE EXCEPTION 'Not a running notifications export.';END IF;
  PERFORM private.employee_transfer_check_notifications_catalog(p_job.summary->'notifications_catalog');
  IF p_job.summary->'notifications_catalog' IS DISTINCT FROM private.employee_transfer_notifications_catalog((p_job.options->>'package_id')::uuid) THEN
    RAISE EXCEPTION 'Notifications, finance or identity source changed; restart the export.';
  END IF;
  v_refs:=private.employee_transfer_notification_media_refs(p_job,true);
  IF (SELECT count(*) FROM private.employee_transfer_staging WHERE job_id=p_job.id AND table_key='notification-media-export')<>jsonb_array_length(v_refs) THEN
    RAISE EXCEPTION 'Notification media export is incomplete.';
  END IF;
  FOR v_ref IN SELECT value,(n-1)::integer AS no FROM jsonb_array_elements(v_refs) WITH ORDINALITY AS ref(value,n) LOOP
    SELECT payload,row_count INTO v_receipt,v_rows FROM private.employee_transfer_staging WHERE job_id=p_job.id
      AND employee_id='00000000-0000-0000-0000-000000000000' AND table_key='notification-media-export' AND chunk_no=v_ref.no;
    IF NOT private.employee_transfer_exact_object(v_receipt,ARRAY['file','path','storage_origin','generation','checked','checked_at']) OR v_rows IS DISTINCT FROM 1
      OR v_receipt->'checked' IS DISTINCT FROM 'true'::jsonb OR v_receipt->>'generation' IS DISTINCT FROM 'export'
      OR v_receipt->>'path' IS DISTINCT FROM v_ref.value->>'path' OR jsonb_typeof(v_receipt->'checked_at') IS DISTINCT FROM 'string'
      OR v_receipt->>'storage_origin' IS DISTINCT FROM split_part(v_ref.value->>'source_url','/storage/',1)
      OR v_receipt->>'storage_origin' IS DISTINCT FROM p_job.summary->>'notification_storage_origin' THEN
      RAISE EXCEPTION 'Notification media requires a complete, matching export readback.';
    END IF;
    v_files:=v_files||jsonb_build_array(v_receipt->'file');
  END LOOP;
  PERFORM private.employee_transfer_notification_media_files(v_refs,v_files);
END;
$$;

-- Only the functions introduced here are granted/revoked; old RPC definitions/returns stay intact.
REVOKE ALL ON FUNCTION private.employee_transfer_notification_media_urls(text,boolean),
  private.employee_transfer_notification_media_refs(private.employee_transfer_jobs,boolean),
  private.employee_transfer_notification_media_files(jsonb,jsonb),private.employee_transfer_notification_media_job(uuid,uuid,text),
  private.employee_transfer_notification_media_target_path(private.employee_transfer_jobs,jsonb),
  private.employee_transfer_notification_media_ready(private.employee_transfer_jobs,boolean),
  private.employee_transfer_notification_rewrite_media(private.employee_transfer_jobs,text),
  private.employee_transfer_check_notification_media_export(private.employee_transfer_jobs) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_employee_transfer_notification_media(uuid,uuid,text),public.employee_import_notification_media_bind(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_transfer_notification_media(uuid,uuid,text),public.employee_import_notification_media_bind(uuid,uuid,jsonb) TO anon,authenticated;
REVOKE ALL ON FUNCTION public.employee_transfer_notification_media_authorize(uuid,uuid,text,text),
  public.employee_transfer_notification_media_commit(uuid,uuid,text,text,integer,text,text,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_transfer_notification_media_authorize(uuid,uuid,text,text),
  public.employee_transfer_notification_media_commit(uuid,uuid,text,text,integer,text,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
