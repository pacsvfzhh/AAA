BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- No audit table, source line, body, media_refs, Storage policy or deletion scope is changed.
-- The original import job is permanent (SQL33/34); its summary owns this sidecar.
CREATE FUNCTION private.employee_transfer_archive_media_hash(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT encode(extensions.digest(convert_to(p_text,'UTF8'),'sha256'),'hex');
$$;

CREATE FUNCTION private.employee_transfer_archive_media_job(p_session uuid,p_token uuid,p_direction text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid;v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  SELECT admin_id INTO v_admin FROM private.employee_transfer_admin(p_session);
  SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE token_hash=private.hash_financial_token(p_token)
    AND admin_id=v_admin AND status='running' AND last_activity_at>now()-interval '3 hours' AND started_at>now()-interval '12 hours'
    AND ((p_direction='export' AND kind='export' AND options->>'export_protocol'='site-archives-v1')
      OR (p_direction='import' AND kind='import' AND options->>'import_protocol'='dispatch-submission-v1'));
  IF p_token IS NULL OR v_job.id IS NULL THEN RAISE EXCEPTION 'Invalid archive media job.';END IF;
  PERFORM private.employee_transfer_check_archives_catalog(v_job.summary->'archives_catalog');
  IF p_direction='export' THEN
    IF v_job.summary->'archives_catalog' IS DISTINCT FROM private.employee_transfer_archives_catalog((v_job.options->>'package_id')::uuid)
      THEN RAISE EXCEPTION 'Archive source changed.';END IF;
  ELSIF p_direction='import' THEN
    PERFORM private.employee_transfer_archives_owner(v_job);
    PERFORM private.employee_transfer_archives_persisted(v_job);
  ELSE RAISE EXCEPTION 'Invalid archive media direction.';END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION private.employee_transfer_archive_media_refs(p_job private.employee_transfer_jobs,p_export boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET timezone='UTC' SET datestyle='ISO, YMD' AS $$
DECLARE v_query text;v_row record;v_ref record;v_refs jsonb:='{}';v_line_hash text;v_identity text;v_key text;v_count integer:=0;
  v_site text:=p_job.summary#>>'{archives_catalog,site_id}';v_package text:=p_job.summary#>>'{archives_catalog,package_id}';
BEGIN
  IF p_export IS NULL THEN RAISE EXCEPTION 'Explicit archive mode required.';END IF;
  IF p_export THEN
    v_query:='SELECT id,body,body::text||E''\n'' AS source_line FROM ('||private.employee_transfer_archives_query('content_audit_events')||') r';
  ELSE
    v_query:='SELECT source_id AS id,body,source_line FROM private.employee_transfer_archive_records WHERE source_site_id=$1 AND package_id=$2 AND table_key=''content_audit_events''';
  END IF;
  FOR v_row IN EXECUTE v_query USING v_site::uuid,v_package::uuid LOOP
    IF jsonb_typeof(v_row.body->'media_refs') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Unsupported archive media_refs; no reference was omitted.';END IF;
    v_line_hash:=private.employee_transfer_archive_media_hash(v_row.source_line);
    FOR v_ref IN SELECT key,value FROM jsonb_each(v_row.body->'media_refs') LOOP
      IF octet_length(v_ref.key) NOT BETWEEN 1 AND 4096 OR v_ref.key ~ '[[:cntrl:]]'
        OR jsonb_typeof(v_ref.value) IS DISTINCT FROM 'string' OR octet_length(v_ref.value#>>'{}') NOT BETWEEN 1 AND 512
        OR (v_ref.value#>>'{}') ~ '[[:cntrl:]]'
        OR (v_ref.value#>>'{}') !~ '^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$'
        OR strpos(v_ref.value#>>'{}','..')>0 THEN RAISE EXCEPTION 'Unsafe private archive reference; no reference was omitted.';END IF;
      -- Original URL keys are opaque evidence, NEVER network destinations. Hashes bind exact UTF8.
      v_identity:='archive-evidence-v1:'||v_site||':'||v_package||':'||v_row.id||':'||v_line_hash||':'||
        private.employee_transfer_archive_media_hash(v_ref.key)||':'||private.employee_transfer_archive_media_hash(v_ref.value#>>'{}');
      v_key:=private.employee_transfer_archive_media_hash(v_identity);
      IF v_refs ? v_key THEN RAISE EXCEPTION 'Duplicate archive media identity.';END IF;
      v_count:=v_count+1;IF v_count>3000 THEN RAISE EXCEPTION 'Archive media exceeds 3000 files.';END IF;
      v_refs:=v_refs||jsonb_build_object(v_key,jsonb_build_object('key',v_key,'source_url',v_identity,
        'event_id',v_row.id,'source_line_sha256',v_line_hash,'ref_key',v_ref.key,'ref_value',v_ref.value,
        'bucket','content-audit-evidence','path',v_ref.value));
    END LOOP;
  END LOOP;
  RETURN COALESCE((SELECT jsonb_agg(value ORDER BY key COLLATE "C") FROM jsonb_each(v_refs)),'[]'::jsonb);
END;
$$;

CREATE FUNCTION private.employee_transfer_archive_media_file(p_ref jsonb,p_file jsonb)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF NOT private.employee_transfer_exact_object(p_file,ARRAY['key','source_url','bytes','sha256','content_type'])
    OR p_file->'key' IS DISTINCT FROM p_ref->'key' OR p_file->'source_url' IS DISTINCT FROM p_ref->'source_url'
    OR jsonb_typeof(p_file->'bytes') IS DISTINCT FROM 'number' OR (p_file->>'bytes') !~ '^[1-9][0-9]{0,7}$'
    OR (p_file->>'bytes')::bigint>52428800
    OR jsonb_typeof(p_file->'sha256') IS DISTINCT FROM 'string' OR length(p_file->>'sha256')<>64 OR (p_file->>'sha256') !~ '^[0-9a-f]{64}$'
    OR p_file->>'content_type' IS NULL OR p_file->>'content_type' NOT IN ('image/png','image/jpeg','image/webp','image/gif','video/mp4')
    THEN RAISE EXCEPTION 'Invalid archive file tuple.';END IF;
  RETURN (p_file->>'bytes')::bigint;
END;
$$;

CREATE FUNCTION private.employee_transfer_archive_media_path(p_job private.employee_transfer_jobs,p_key text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT 'transfer-archives/'||p_job.id::text||'/'||p_key;
$$;

CREATE FUNCTION private.employee_transfer_archive_media_generation(p_job private.employee_transfer_jobs,p_refs jsonb)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT private.employee_transfer_archive_media_hash(jsonb_build_array(p_job.id,p_job.summary->'archives_catalog',p_refs,
    CASE WHEN p_job.kind='import' THEN p_job.summary#>'{archives_restore,namespace_hash}' ELSE 'null'::jsonb END)::text);
$$;

-- Reconstruct and validate all sidecar bindings, including permanent records, on EVERY call.
CREATE FUNCTION private.employee_transfer_archive_media_state(p_job private.employee_transfer_jobs,p_export boolean)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_refs jsonb:=private.employee_transfer_archive_media_refs(p_job,p_export);v_state jsonb:=p_job.summary->'archives_media';
  v_ref jsonb;v_file jsonb;v_receipt jsonb;v_item record;v_n integer:=0;v_bytes bigint:=0;v_records bigint;v_origin text;
  v_generation text:=private.employee_transfer_archive_media_generation(p_job,v_refs);
BEGIN
  IF v_state IS NULL THEN RETURN jsonb_build_object('version',1,'refs',v_refs,'files',NULL,'receipts','{}'::jsonb,'verified',false);END IF;
  IF NOT private.employee_transfer_exact_object(v_state,ARRAY['version','refs','files','receipts','verified'])
    OR v_state->'version' IS DISTINCT FROM '1'::jsonb OR v_state->'refs' IS DISTINCT FROM v_refs
    OR jsonb_typeof(v_state->'receipts') IS DISTINCT FROM 'object' OR jsonb_typeof(v_state->'verified') IS DISTINCT FROM 'boolean'
    OR (p_export AND v_state->'files' IS DISTINCT FROM 'null'::jsonb)
    OR (NOT p_export AND (jsonb_typeof(v_state->'files') IS DISTINCT FROM 'array')) THEN RAISE EXCEPTION 'Archive sidecar binding changed.';END IF;
  IF NOT p_export AND jsonb_array_length(v_state->'files')<>jsonb_array_length(v_refs) THEN RAISE EXCEPTION 'Incomplete archive file binding.';END IF;
  FOR v_item IN SELECT key,value FROM jsonb_each(v_state->'receipts') LOOP
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_refs) r WHERE r->>'key'=v_item.key) THEN RAISE EXCEPTION 'Unbound archive receipt.';END IF;
  END LOOP;
  FOR v_ref IN SELECT value FROM jsonb_array_elements(v_refs) LOOP
    v_receipt:=v_state#>ARRAY['receipts',v_ref->>'key'];
    v_file:=CASE WHEN p_export THEN v_receipt->'file' ELSE v_state->'files'->v_n END;v_n:=v_n+1;
    IF v_file IS NOT NULL THEN v_bytes:=v_bytes+private.employee_transfer_archive_media_file(v_ref,v_file);END IF;
    IF v_receipt IS NOT NULL THEN
      IF NOT private.employee_transfer_exact_object(v_receipt,ARRAY['file','path','generation','checked','storage_origin'])
        OR v_receipt->'file' IS DISTINCT FROM v_file OR v_receipt->>'generation' IS DISTINCT FROM v_generation
        OR v_receipt->>'path' IS DISTINCT FROM (CASE WHEN p_export THEN v_ref->>'path' ELSE private.employee_transfer_archive_media_path(p_job,v_ref->>'key') END)
        OR jsonb_typeof(v_receipt->'checked') IS DISTINCT FROM 'boolean'
        OR v_receipt->>'storage_origin' IS NULL OR v_receipt->>'storage_origin' ~ '[[:cntrl:]]'
        OR v_receipt->>'storage_origin' !~ '^https://[a-z0-9-]+[.]supabase[.]co$'
        THEN RAISE EXCEPTION 'Archive receipt changed.';END IF;
      IF v_origin IS NOT NULL AND v_origin IS DISTINCT FROM v_receipt->>'storage_origin' THEN RAISE EXCEPTION 'Archive Storage origin changed.';END IF;
      v_origin:=v_receipt->>'storage_origin';
    END IF;
    IF v_state->'verified'='true'::jsonb AND (v_receipt IS NULL OR v_receipt->'checked' IS DISTINCT FROM 'true'::jsonb)
      THEN RAISE EXCEPTION 'Verified archive media is incomplete.';END IF;
  END LOOP;
  SELECT COALESCE(sum((value->>'bytes')::bigint),0) INTO v_records FROM jsonb_array_elements(p_job.summary#>'{archives_catalog,tables}');
  IF v_bytes+v_records>1073741824 THEN RAISE EXCEPTION 'Archive records and media exceed 1 GiB.';END IF;
  RETURN v_state;
END;
$$;

CREATE FUNCTION public.employee_transfer_archive_media_inventory(p_admin_session_token uuid,p_job_token uuid,p_direction text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_state jsonb;v_files jsonb;
BEGIN
  v_job:=private.employee_transfer_archive_media_job(p_admin_session_token,p_job_token,p_direction);
  v_state:=private.employee_transfer_archive_media_state(v_job,p_direction='export');
  SELECT COALESCE(jsonb_agg(r.value||jsonb_build_object('file',CASE WHEN p_direction='export' THEN v_state#>ARRAY['receipts',r.value->>'key','file']
    ELSE v_state->'files'->((r.n-1)::integer) END) ORDER BY r.n),'[]') INTO v_files FROM jsonb_array_elements(v_state->'refs') WITH ORDINALITY r(value,n);
  RETURN jsonb_build_object('version',1,'scope','site-archives-media','direction',p_direction,'archives_catalog',v_job.summary->'archives_catalog',
    'files',v_files,'bound',p_direction='export' OR v_state->'files'<>'null'::jsonb,'verified',v_state->'verified',
    'transferred',COALESCE((SELECT jsonb_agg(key ORDER BY key COLLATE "C") FROM jsonb_each(v_state->'receipts')),'[]'),
    'checked',COALESCE((SELECT jsonb_agg(key ORDER BY key COLLATE "C") FROM jsonb_each(v_state->'receipts') WHERE value->'checked'='true'::jsonb),'[]'),
    'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_transfer_archive_media_status(p_admin_session_token uuid,p_job_token uuid,p_direction text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT public.employee_transfer_archive_media_inventory(p_admin_session_token,p_job_token,p_direction);
$$;

CREATE FUNCTION public.employee_transfer_archive_media_bind(p_admin_session_token uuid,p_job_token uuid,p_files jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_state jsonb;v_ref jsonb;v_n integer:=0;v_total bigint:=0;v_repeat boolean;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance',0));
  v_job:=private.employee_transfer_archive_media_job(p_admin_session_token,p_job_token,'import');
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_archive_media_job(p_admin_session_token,p_job_token,'import');
  v_state:=private.employee_transfer_archive_media_state(v_job,false);v_repeat:=v_job.summary ? 'archives_media';
  IF jsonb_typeof(p_files) IS DISTINCT FROM 'array' OR octet_length(p_files::text)>4194304 THEN RAISE EXCEPTION 'Invalid archive media catalog.';END IF;
  IF jsonb_array_length(p_files)<>jsonb_array_length(v_state->'refs') THEN RAISE EXCEPTION 'Incomplete archive media catalog.';END IF;
  FOR v_ref IN SELECT value FROM jsonb_array_elements(v_state->'refs') LOOP
    v_total:=v_total+private.employee_transfer_archive_media_file(v_ref,p_files->v_n);v_n:=v_n+1;
  END LOOP;
  IF v_repeat AND v_state->'files' IS DISTINCT FROM p_files THEN RAISE EXCEPTION 'Archive media binding is immutable.';END IF;
  v_state:=jsonb_set(v_state,'{files}',p_files);v_job.summary:=jsonb_set(v_job.summary,'{archives_media}',v_state);
  PERFORM private.employee_transfer_archive_media_state(v_job,false);
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary WHERE id=v_job.id;
  RETURN jsonb_build_object('success',true,'files',v_n,'bytes',v_total,'repeated',v_repeat,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_transfer_archive_media_authorize(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_direction text;v_job private.employee_transfer_jobs%ROWTYPE;v_state jsonb;v_ref jsonb;v_file jsonb;v_n integer;v_receipt jsonb;
BEGIN
  IF p_action IN ('download','recheck-export') THEN v_direction:='export';
  ELSIF p_action IN ('upload','recheck-import') THEN v_direction:='import';ELSE RAISE EXCEPTION 'Invalid archive media action.';END IF;
  IF p_object_key IS NULL OR length(p_object_key)<>64 OR p_object_key !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid archive object key.';END IF;
  v_job:=private.employee_transfer_archive_media_job(p_admin_session_token,p_job_token,v_direction);
  v_state:=private.employee_transfer_archive_media_state(v_job,v_direction='export');
  SELECT value,(n-1)::integer INTO v_ref,v_n FROM jsonb_array_elements(v_state->'refs') WITH ORDINALITY r(value,n) WHERE value->>'key'=p_object_key;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Archive reference is outside this job.';END IF;
  v_receipt:=v_state#>ARRAY['receipts',p_object_key];
  IF p_action IN ('recheck-export','recheck-import') AND v_receipt IS NULL THEN RAISE EXCEPTION 'Transfer archive media before rechecking.';END IF;
  IF v_direction='export' THEN v_file:=v_receipt->'file';
  ELSE
    IF v_state->'files'='null'::jsonb THEN RAISE EXCEPTION 'Bind archive files first.';END IF;
    v_file:=v_state->'files'->v_n;
  END IF;
  RETURN jsonb_build_object('direction',v_direction,'key',p_object_key,'bucket','content-audit-evidence',
    'path',CASE WHEN v_direction='export' THEN v_ref->>'path' ELSE private.employee_transfer_archive_media_path(v_job,p_object_key) END,
    'source_url',v_ref->>'source_url','file',v_file,'generation',private.employee_transfer_archive_media_generation(v_job,v_state->'refs'));
END;
$$;

CREATE FUNCTION public.employee_transfer_archive_media_commit(p_admin_session_token uuid,p_job_token uuid,p_action text,p_object_key text,
  p_bytes integer,p_sha256 text,p_content_type text,p_storage_origin text,p_generation text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_direction text;v_context jsonb;v_state jsonb;v_file jsonb;v_previous jsonb;v_checked boolean;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance',0));
  v_direction:=CASE WHEN p_action IN ('download','recheck-export') THEN 'export' ELSE 'import' END;
  v_job:=private.employee_transfer_archive_media_job(p_admin_session_token,p_job_token,v_direction);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_context:=public.employee_transfer_archive_media_authorize(p_admin_session_token,p_job_token,p_action,p_object_key);
  v_job:=private.employee_transfer_archive_media_job(p_admin_session_token,p_job_token,v_direction);
  IF p_generation IS NULL OR p_generation IS DISTINCT FROM v_context->>'generation' THEN RAISE EXCEPTION 'Archive media read generation changed.';END IF;
  IF p_storage_origin IS NULL OR p_storage_origin ~ '[[:cntrl:]]' OR p_storage_origin !~ '^https://[a-z0-9-]+[.]supabase[.]co$' THEN RAISE EXCEPTION 'Invalid archive Storage origin.';END IF;
  v_file:=jsonb_build_object('key',p_object_key,'source_url',v_context->>'source_url','bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type);
  PERFORM private.employee_transfer_archive_media_file(v_context,v_file);
  IF v_context->'file'<>'null'::jsonb AND v_context->'file' IS DISTINCT FROM v_file THEN RAISE EXCEPTION 'Archive media bytes changed.';END IF;
  v_state:=private.employee_transfer_archive_media_state(v_job,v_direction='export');v_previous:=v_state#>ARRAY['receipts',p_object_key];
  IF v_previous IS NOT NULL AND (v_previous->'file' IS DISTINCT FROM v_file OR v_previous->>'storage_origin' IS DISTINCT FROM p_storage_origin) THEN RAISE EXCEPTION 'Archive receipt is immutable.';END IF;
  v_checked:=p_action IN ('recheck-export','recheck-import') OR COALESCE(v_previous->'checked'='true'::jsonb,false);
  v_state:=jsonb_set(v_state,ARRAY['receipts',p_object_key],jsonb_build_object('file',v_file,'path',v_context->>'path',
    'generation',p_generation,'checked',v_checked,'storage_origin',p_storage_origin));
  v_job.summary:=jsonb_set(v_job.summary,'{archives_media}',v_state);
  PERFORM private.employee_transfer_archive_media_state(v_job,v_direction='export');
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary,last_activity_at=now() WHERE id=v_job.id;
  RETURN jsonb_build_object('success',true,'key',p_object_key,'bytes',p_bytes,'sha256',p_sha256,'content_type',p_content_type,'full_site_complete',false);
END;
$$;

CREATE FUNCTION public.employee_transfer_archive_media_verify(p_admin_session_token uuid,p_job_token uuid,p_direction text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_state jsonb;v_ref jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance',0));
  v_job:=private.employee_transfer_archive_media_job(p_admin_session_token,p_job_token,p_direction);
  PERFORM 1 FROM private.employee_transfer_jobs WHERE id=v_job.id FOR UPDATE;
  v_job:=private.employee_transfer_archive_media_job(p_admin_session_token,p_job_token,p_direction);
  v_state:=private.employee_transfer_archive_media_state(v_job,p_direction='export');
  IF p_direction='import' AND v_state->'files'='null'::jsonb THEN RAISE EXCEPTION 'Bind archive files first.';END IF;
  FOR v_ref IN SELECT value FROM jsonb_array_elements(v_state->'refs') LOOP
    IF v_state#>ARRAY['receipts',v_ref->>'key','checked'] IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'Archive media requires actual recheck.';END IF;
  END LOOP;
  v_state:=jsonb_set(v_state,'{verified}','true'::jsonb);v_job.summary:=jsonb_set(v_job.summary,'{archives_media}',v_state);
  PERFORM private.employee_transfer_archive_media_state(v_job,p_direction='export');
  UPDATE private.employee_transfer_jobs SET summary=v_job.summary WHERE id=v_job.id;
  RETURN public.employee_transfer_archive_media_status(p_admin_session_token,p_job_token,p_direction);
END;
$$;

-- No job token, heartbeat, dirty-maintenance requirement, signed URL or caller path for viewing.
-- The super-admin session and permanent SQL34 namespace + fully verified sidecar are revalidated.
CREATE FUNCTION public.employee_transfer_archive_media_read_authorize(p_admin_session_token uuid,p_source_site_id uuid,p_package_id uuid,p_event_id uuid,p_ref_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;v_state jsonb;v_ref jsonb;v_receipt jsonb;
BEGIN
  PERFORM private.employee_transfer_admin(p_admin_session_token);
  IF p_source_site_id IS NULL OR p_package_id IS NULL OR p_event_id IS NULL OR p_ref_key IS NULL OR octet_length(p_ref_key) NOT BETWEEN 1 AND 4096 THEN RAISE EXCEPTION 'Invalid archive read binding.';END IF;
  SELECT * INTO v_job FROM private.employee_transfer_jobs j WHERE j.kind='import' AND j.options->>'import_protocol'='dispatch-submission-v1'
    AND j.summary#>'{archives_restore,records_verified}'='true'::jsonb AND j.summary#>'{archives_media,verified}'='true'::jsonb
    AND j.summary#>>'{archives_catalog,site_id}'=p_source_site_id::text AND j.summary#>>'{archives_catalog,package_id}'=p_package_id::text
    ORDER BY j.started_at DESC,j.id LIMIT 1;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Verified archive media is unavailable.';END IF;
  PERFORM private.employee_transfer_archives_persisted(v_job);v_state:=private.employee_transfer_archive_media_state(v_job,false);
  SELECT value INTO v_ref FROM jsonb_array_elements(v_state->'refs') WHERE value->>'event_id'=p_event_id::text AND value->>'ref_key'=p_ref_key;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Archive media reference is unavailable.';END IF;
  v_receipt:=v_state#>ARRAY['receipts',v_ref->>'key'];
  RETURN jsonb_build_object('direction','read','key',v_ref->>'key','bucket','content-audit-evidence','path',v_receipt->>'path',
    'source_url',v_ref->>'source_url','file',v_receipt->'file','generation',private.employee_transfer_archive_media_generation(v_job,v_state->'refs'));
END;
$$;

DO $permissions$
DECLARE v_function regprocedure;
BEGIN
  FOR v_function IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace IN ('public'::regnamespace,'private'::regnamespace)
    AND proname LIKE 'employee_transfer_archive_media_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',v_function);
  END LOOP;
END;
$permissions$;
GRANT EXECUTE ON FUNCTION public.employee_transfer_archive_media_inventory(uuid,uuid,text),public.employee_transfer_archive_media_status(uuid,uuid,text),
  public.employee_transfer_archive_media_bind(uuid,uuid,jsonb),public.employee_transfer_archive_media_verify(uuid,uuid,text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.employee_transfer_archive_media_authorize(uuid,uuid,text,text),
  public.employee_transfer_archive_media_commit(uuid,uuid,text,text,integer,text,text,text,text),
  public.employee_transfer_archive_media_read_authorize(uuid,uuid,uuid,uuid,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
