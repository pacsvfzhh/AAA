DO $pending_cleanup$
BEGIN
  IF EXISTS (SELECT 1 FROM private.content_audit_delete_jobs WHERE finished_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM private.deleted_employee_delete_jobs WHERE finished_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Finish pending media cleanup before upgrading permanent deletion.';
  END IF;
END;
$pending_cleanup$;

CREATE TABLE private.content_audit_storage_origins (origin text PRIMARY KEY);
REVOKE ALL ON private.content_audit_storage_origins FROM PUBLIC, anon, authenticated;
INSERT INTO private.content_audit_storage_origins(origin) VALUES ('https://hxpbpqoqkoiiplvdwmld.supabase.co');

ALTER TABLE private.content_audit_delete_jobs
  ADD COLUMN public_media_to_remove jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN retained_shared_images integer NOT NULL DEFAULT 0;

CREATE TABLE private.content_audit_public_media_claims (
  bucket_id text NOT NULL CHECK (bucket_id IN ('chat-images', 'template-images', 'announcement-images', 'super-customer-avatars')),
  path text NOT NULL,
  job_id uuid,
  job_kind text CHECK (job_kind IN ('content', 'employee')),
  PRIMARY KEY (bucket_id, path),
  CHECK ((job_id IS NULL) = (job_kind IS NULL))
);
REVOKE ALL ON private.content_audit_public_media_claims FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.content_audit_decode_uri_path(p_path text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = pg_catalog, private, pg_temp AS $$
DECLARE v_bytes bytea := ''::bytea; v_index integer := 1; v_character text;
BEGIN
  WHILE v_index <= length(p_path) LOOP
    v_character := substring(p_path FROM v_index FOR 1);
    IF v_character = '%' THEN
      IF substring(p_path FROM v_index + 1 FOR 2) !~ '^[0-9A-Fa-f]{2}$' THEN RETURN NULL; END IF;
      v_bytes := v_bytes || decode(substring(p_path FROM v_index + 1 FOR 2), 'hex');
      v_index := v_index + 3;
    ELSE
      v_bytes := v_bytes || convert_to(v_character, 'UTF8');
      v_index := v_index + 1;
    END IF;
  END LOOP;
  RETURN convert_from(v_bytes, 'UTF8');
EXCEPTION WHEN character_not_in_repertoire OR untranslatable_character OR invalid_parameter_value THEN
  RETURN NULL;
END;
$$;

CREATE FUNCTION private.content_audit_public_media_candidates(p_urls text[])
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  WITH parsed AS (
    SELECT matched.parts[2] AS bucket,
      private.content_audit_decode_uri_path(matched.parts[3]) AS path
    FROM unnest(COALESCE(p_urls, '{}'::text[])) source(url)
    CROSS JOIN LATERAL regexp_match(source.url,
      '^(https?://[^/?#]+)/storage/v1/object/public/(chat-images|template-images|announcement-images|super-customer-avatars)/([^?#]+)$') matched(parts)
    WHERE EXISTS (SELECT 1 FROM private.content_audit_storage_origins trusted
      WHERE trusted.origin = lower(matched.parts[1]))
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('bucket', candidate.bucket, 'path', candidate.path)
    ORDER BY candidate.bucket, candidate.path), '[]'::jsonb)
  FROM (SELECT DISTINCT parsed.bucket, parsed.path FROM parsed
    JOIN storage.objects object ON object.bucket_id = parsed.bucket AND object.name = parsed.path) candidate;
$$;

CREATE FUNCTION private.content_audit_document_uses_media(p_document jsonb, p_bucket text, p_path text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, private, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM private.content_audit_storage_origins trusted
    WHERE strpos(p_document::text, trusted.origin || '/storage/v1/object/public/' || p_bucket || '/' || p_path) > 0)
  OR EXISTS (
    SELECT 1 FROM jsonb_path_query(p_document, '$.** ? (@.type() == "string")') leaf(value)
    CROSS JOIN LATERAL regexp_matches(leaf.value #>> '{}',
      '(https?://[^/?#"''[:space:]]+)/storage/v1/object/public/([^/"''[:space:]]+)/([^"''<>[:space:]?#)}]+)', 'g') url(parts)
    JOIN private.content_audit_storage_origins trusted ON trusted.origin = lower(url.parts[1])
    WHERE url.parts[2] = p_bucket
      AND private.content_audit_decode_uri_path(replace(url.parts[3], '&amp;', '&')) = p_path
  );
$$;

CREATE FUNCTION private.content_audit_public_media_in_use(p_bucket text, p_path text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_source record; v_found boolean;
BEGIN
  IF p_bucket NOT IN ('chat-images', 'template-images', 'announcement-images', 'super-customer-avatars')
    OR p_path IS NULL OR p_path = '' THEN RETURN true; END IF;
  FOR v_source IN SELECT * FROM (VALUES
    ('public', 'cs_message_templates'), ('public', 'customer_employee_conversations'),
    ('public', 'messages'), ('public', 'broadcast_messages'), ('public', 'announcements'),
    ('public', 'customer_auto_messages'), ('public', 'message_templates'),
    ('public', 'notification_automation_tasks'), ('public', 'notification_automation_executions'),
    ('public', 'simulated_customers'), ('public', 'admin_configs'), ('public', 'system_configs'),
    ('public', 'financial_operations'), ('public', 'rich_card_contents'),
    ('private', 'content_audit_events'), ('private', 'deleted_employee_notifications')
  ) sources(schema_name, table_name) LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I source
      WHERE private.content_audit_document_uses_media(to_jsonb(source), $1, $2))',
      v_source.schema_name, v_source.table_name) INTO v_found USING p_bucket, p_path;
    IF v_found THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END;
$$;

CREATE FUNCTION private.guard_content_audit_public_media_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_row jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('employee-chat-image-references'));
  IF NOT EXISTS (SELECT 1 FROM private.content_audit_public_media_claims) THEN RETURN NEW; END IF;
  v_row := to_jsonb(NEW);
  IF EXISTS (SELECT 1 FROM private.content_audit_public_media_claims claim
    WHERE private.content_audit_document_uses_media(v_row, claim.bucket_id, claim.path)) THEN
    RAISE EXCEPTION 'This media file is reserved for permanent deletion. Upload another file.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION private.guard_content_audit_public_media_upload()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, private, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtext('employee-chat-image-references'));
  IF EXISTS (SELECT 1 FROM private.content_audit_public_media_claims
    WHERE bucket_id = NEW.bucket_id AND path = NEW.name) THEN
    RAISE EXCEPTION 'This media path is reserved for permanent deletion. Upload another file.';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_content_audit_public_media_upload BEFORE INSERT OR UPDATE ON storage.objects
FOR EACH ROW EXECUTE FUNCTION private.guard_content_audit_public_media_upload();

DO $reference_guards$
DECLARE v_source record;
BEGIN
  FOR v_source IN SELECT * FROM (VALUES
    ('public', 'cs_message_templates'), ('public', 'customer_employee_conversations'),
    ('public', 'messages'), ('public', 'broadcast_messages'), ('public', 'announcements'),
    ('public', 'customer_auto_messages'), ('public', 'message_templates'),
    ('public', 'notification_automation_tasks'), ('public', 'notification_automation_executions'),
    ('public', 'simulated_customers'), ('public', 'admin_configs'), ('public', 'system_configs'),
    ('public', 'financial_operations'), ('public', 'rich_card_contents'),
    ('private', 'content_audit_events'), ('private', 'deleted_employee_notifications')
  ) sources(schema_name, table_name) LOOP
    EXECUTE format('CREATE TRIGGER guard_content_audit_public_media_reference BEFORE INSERT OR UPDATE ON %I.%I
      FOR EACH ROW EXECUTE FUNCTION private.guard_content_audit_public_media_reference()',
      v_source.schema_name, v_source.table_name);
  END LOOP;
END;
$reference_guards$;

CREATE FUNCTION private.redact_deleted_notification_send_content(p_message_ids uuid[])
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_count integer;
BEGIN
  UPDATE public.financial_operations operation
  SET request_data = (operation.request_data - 'title' - 'content') || jsonb_build_object('_original_request_sha256',
    COALESCE(operation.request_data ->> '_original_request_sha256',
      encode(sha256(convert_to(operation.request_data::text, 'UTF8')), 'hex')))
  WHERE operation.operation_type = 'admin_message_send'
    AND operation.result ->> 'message_id' = ANY(p_message_ids::text[])
    AND (operation.request_data ? 'title' OR operation.request_data ? 'content')
    AND NOT EXISTS (SELECT 1 FROM public.messages message WHERE message.id::text = operation.result ->> 'message_id')
    AND NOT EXISTS (SELECT 1 FROM private.content_audit_events event
      WHERE event.entity_type = 'notification' AND event.entity_id::text = operation.result ->> 'message_id'
        AND event.cleared_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM private.deleted_employee_notifications notification
      WHERE notification.message_id::text = operation.result ->> 'message_id'
        AND notification.cleared_at IS NULL AND notification.message_data IS NOT NULL);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

DO $content_finish$
DECLARE v_definition text; v_anchor text;
BEGIN
  v_definition := pg_get_functiondef('public.finish_content_audit_delete(uuid, uuid)'::regprocedure);
  v_anchor := 'DELETE FROM private.content_audit_events WHERE id = ANY(v_job.target_ids);';
  IF strpos(v_definition, v_anchor) = 0 OR strpos(v_definition, 'v_paths jsonb;') = 0 THEN
    RAISE EXCEPTION 'Unexpected content deletion definition.';
  END IF;
  v_definition := replace(v_definition, 'v_paths jsonb;', 'v_paths jsonb; v_urls text[]; v_public_paths jsonb;');
  v_definition := replace(v_definition, v_anchor, $capture$
  SELECT array_agg(DISTINCT source.url) INTO v_urls FROM (
    SELECT key AS url FROM private.content_audit_events event
    CROSS JOIN LATERAL jsonb_object_keys(COALESCE(event.media_refs, '{}'::jsonb)) key
    WHERE event.id = ANY(v_job.target_ids)
    UNION
    SELECT unnest(private.content_audit_storage_urls(operation.request_data))
    FROM public.financial_operations operation
    WHERE operation.operation_type = 'admin_message_send'
      AND operation.result ->> 'message_id' = ANY(v_notification_ids::text[])
  ) source;
  v_public_paths := private.content_audit_public_media_candidates(v_urls);
  DELETE FROM private.content_audit_events WHERE id = ANY(v_job.target_ids);$capture$);
  v_anchor := 'SELECT COALESCE(jsonb_agg(object.name), ''[]''::jsonb) INTO v_paths FROM storage.objects object';
  IF strpos(v_definition, v_anchor) = 0 THEN RAISE EXCEPTION 'Unexpected content media selection.'; END IF;
  v_definition := replace(v_definition, v_anchor,
    'PERFORM private.redact_deleted_notification_send_content(v_notification_ids);' || E'\n  ' || v_anchor);
  v_anchor := 'SET finished_at = clock_timestamp(), paths_to_remove = v_paths WHERE id = p_job_id;';
  IF strpos(v_definition, v_anchor) = 0 THEN RAISE EXCEPTION 'Unexpected content deletion completion.'; END IF;
  v_definition := replace(v_definition, v_anchor,
    'SET finished_at = clock_timestamp(), paths_to_remove = v_paths, public_media_to_remove = v_public_paths WHERE id = p_job_id;');
  v_definition := replace(v_definition, '''paths_to_remove'', v_job.paths_to_remove)',
    '''paths_to_remove'', v_job.paths_to_remove, ''public_media_to_remove'', v_job.public_media_to_remove, ''retained_shared_images'', v_job.retained_shared_images)');
  v_definition := replace(v_definition, '''paths_to_remove'', v_paths)',
    '''paths_to_remove'', v_paths, ''public_media_to_remove'', v_public_paths, ''retained_shared_images'', 0)');
  EXECUTE v_definition;
END;
$content_finish$;

DO $employee_finish$
DECLARE v_definition text; v_anchor text;
BEGIN
  v_definition := pg_get_functiondef('public.finish_deleted_employee_archive_delete(uuid, uuid)'::regprocedure);
  v_anchor := 'SELECT COALESCE(array_agg(DISTINCT original.path), ''{}''::text[]) INTO v_original_paths';
  IF strpos(v_definition, v_anchor) = 0 OR strpos(v_definition, 'v_public_paths jsonb;') = 0 THEN
    RAISE EXCEPTION 'Unexpected employee media deletion definition.';
  END IF;
  v_definition := replace(v_definition, $legacy$
  IF EXISTS (SELECT 1 FROM unnest(v_original_paths) candidate(path)
    WHERE strpos(candidate.path, '%') > 0
      OR regexp_replace(candidate.path, '^.*/', '') !~ '^[A-Za-z0-9_.-]+[.][A-Za-z0-9]{2,8}$') THEN
    RAISE EXCEPTION 'An archived chat image path must be reviewed before permanent deletion.';
  END IF;$legacy$, '');
  IF strpos(v_definition, 'An archived chat image path must be reviewed') > 0 THEN
    RAISE EXCEPTION 'Unexpected legacy employee path validation.';
  END IF;
  v_definition := replace(v_definition, 'v_public_paths jsonb;', 'v_public_paths jsonb; v_all_public_paths jsonb; v_notification_ids uuid[]; v_urls text[];');
  v_definition := replace(v_definition, v_anchor, $capture$
  SELECT array_agg(DISTINCT message_id) INTO v_notification_ids FROM (
    SELECT event.entity_id AS message_id FROM private.content_audit_events event
    WHERE event.employee_id = ANY(v_employee_ids) AND event.entity_type = 'notification'
    UNION
    SELECT notification.message_id FROM private.deleted_employee_notifications notification
    WHERE notification.record_id = ANY(v_job.account_ids) OR notification.id = ANY(v_job.notification_ids)
  ) notifications;
  SELECT array_agg(DISTINCT source.url) INTO v_urls FROM (
    SELECT key AS url FROM private.content_audit_events event
    CROSS JOIN LATERAL jsonb_object_keys(COALESCE(event.media_refs, '{}'::jsonb)) key
    WHERE event.employee_id = ANY(v_employee_ids)
    UNION
    SELECT unnest(private.content_audit_storage_urls(notification.message_data))
    FROM private.deleted_employee_notifications notification
    WHERE notification.record_id = ANY(v_job.account_ids) OR notification.id = ANY(v_job.notification_ids)
    UNION
    SELECT unnest(private.content_audit_storage_urls(operation.request_data))
    FROM public.financial_operations operation
    WHERE operation.operation_type = 'admin_message_send'
      AND operation.result ->> 'message_id' = ANY(v_notification_ids::text[])
  ) source;
  v_all_public_paths := private.content_audit_public_media_candidates(v_urls);
  SELECT COALESCE(array_agg(DISTINCT original.path), '{}'::text[]) INTO v_original_paths$capture$);
  v_anchor := 'DELETE FROM private.deleted_employee_accounts WHERE id = ANY(v_job.account_ids);';
  IF strpos(v_definition, v_anchor) = 0 THEN RAISE EXCEPTION 'Unexpected employee final deletion.'; END IF;
  v_definition := replace(v_definition, v_anchor, $cleanup$
  PERFORM private.redact_deleted_notification_send_content(v_notification_ids);
  SELECT COALESCE(jsonb_agg(DISTINCT item), '[]'::jsonb) INTO v_paths
  FROM jsonb_array_elements(v_paths || v_all_public_paths) paths(item);
  DELETE FROM private.deleted_employee_accounts WHERE id = ANY(v_job.account_ids);$cleanup$);
  EXECUTE v_definition;
END;
$employee_finish$;

CREATE FUNCTION public.recheck_content_audit_public_media(
  p_admin_session_token uuid, p_job_id uuid, p_job_kind text, p_paths jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_role text; v_paths jsonb; v_claim record; v_item jsonb;
  v_retained integer := 0; v_total integer; v_finished timestamptz;
BEGIN
  SELECT admin_id, admin_role INTO v_admin, v_role FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_role IS DISTINCT FROM 'super_admin' THEN RAISE EXCEPTION 'Super administrator permission is required.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('content-audit-purge-media'));
  IF p_job_kind = 'content' THEN
    SELECT public_media_to_remove, retained_shared_images, finished_at INTO v_paths, v_total, v_finished
    FROM private.content_audit_delete_jobs WHERE id = p_job_id AND admin_id = v_admin FOR UPDATE;
  ELSIF p_job_kind = 'employee' THEN
    SELECT paths_to_remove, retained_shared_images, finished_at INTO v_paths, v_total, v_finished
    FROM private.deleted_employee_delete_jobs WHERE id = p_job_id FOR UPDATE;
  ELSE RAISE EXCEPTION 'Invalid media deletion scope.'; END IF;
  IF v_finished IS NULL THEN RAISE EXCEPTION 'Database deletion has not finished.'; END IF;
  IF jsonb_typeof(p_paths) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid media batch.'; END IF;
  IF jsonb_array_length(p_paths) NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'Invalid media batch.'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_paths) requested(item)
    WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR item ->> 'bucket' IS NULL OR item ->> 'path' IS NULL
      OR item ->> 'bucket' NOT IN ('chat-images', 'template-images', 'announcement-images', 'super-customer-avatars')
      OR NOT v_paths @> jsonb_build_array(item)) THEN RAISE EXCEPTION 'Media is outside this deletion confirmation.'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('employee-chat-image-references'));
  FOR v_item IN SELECT DISTINCT item FROM jsonb_array_elements(p_paths) requested(item) LOOP
    SELECT * INTO v_claim FROM private.content_audit_public_media_claims
    WHERE bucket_id = v_item ->> 'bucket' AND path = v_item ->> 'path';
    IF FOUND AND (v_claim.job_id IS DISTINCT FROM p_job_id OR v_claim.job_kind IS DISTINCT FROM p_job_kind) THEN
      IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = v_item ->> 'bucket' AND name = v_item ->> 'path') THEN
        RAISE EXCEPTION 'Media is reserved by another deletion. Finish that cleanup first.';
      END IF;
    ELSIF private.content_audit_public_media_in_use(v_item ->> 'bucket', v_item ->> 'path') THEN
      SELECT COALESCE(jsonb_agg(item), '[]'::jsonb) INTO v_paths
      FROM jsonb_array_elements(v_paths) remaining(item) WHERE item <> v_item;
      v_retained := v_retained + 1;
      CONTINUE;
    ELSE
      INSERT INTO private.content_audit_public_media_claims(bucket_id, path, job_id, job_kind)
      VALUES (v_item ->> 'bucket', v_item ->> 'path', p_job_id, p_job_kind)
      ON CONFLICT (bucket_id, path) DO NOTHING;
    END IF;
  END LOOP;
  IF p_job_kind = 'content' THEN
    UPDATE private.content_audit_delete_jobs SET public_media_to_remove = v_paths,
      retained_shared_images = v_total + v_retained WHERE id = p_job_id;
  ELSE
    UPDATE private.deleted_employee_delete_jobs SET paths_to_remove = v_paths,
      retained_shared_images = v_total + v_retained WHERE id = p_job_id;
  END IF;
  RETURN jsonb_build_object('paths_to_remove', v_paths, 'retained_shared_images', v_total + v_retained);
END;
$$;

DO $complete_media$
DECLARE v_definition text; v_signature regprocedure; v_anchor text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.complete_content_audit_delete(uuid, uuid)'::regprocedure,
    'public.complete_deleted_employee_archive_delete(uuid, uuid)'::regprocedure
  ] LOOP
    v_definition := pg_get_functiondef(v_signature);
    IF v_signature = 'public.complete_content_audit_delete(uuid, uuid)'::regprocedure THEN
      v_anchor := 'DELETE FROM private.content_audit_delete_jobs WHERE id = p_job_id;';
      IF strpos(v_definition, v_anchor) = 0 THEN RAISE EXCEPTION 'Unexpected content media completion.'; END IF;
      v_definition := replace(v_definition, v_anchor, $content$
  IF EXISTS (SELECT 1 FROM storage.objects object
    WHERE (object.bucket_id, object.name) IN (
      SELECT item ->> 'bucket', item ->> 'path' FROM jsonb_array_elements(v_job.public_media_to_remove) item
    )) THEN RAISE EXCEPTION 'Original media cleanup is incomplete.'; END IF;
  UPDATE private.content_audit_public_media_claims SET job_id = NULL, job_kind = NULL
  WHERE job_id = p_job_id AND job_kind = 'content';
  DELETE FROM private.content_audit_delete_jobs WHERE id = p_job_id;$content$);
    ELSE
      v_anchor := 'DELETE FROM private.deleted_employee_delete_jobs WHERE id = p_job_id;';
      IF strpos(v_definition, v_anchor) = 0 THEN RAISE EXCEPTION 'Unexpected employee media completion.'; END IF;
      v_definition := replace(v_definition, v_anchor, $employee$
  UPDATE private.content_audit_public_media_claims SET job_id = NULL, job_kind = NULL
  WHERE job_id = p_job_id AND job_kind = 'employee';
  DELETE FROM private.deleted_employee_delete_jobs WHERE id = p_job_id;$employee$);
    END IF;
    EXECUTE v_definition;
  END LOOP;
END;
$complete_media$;

REVOKE ALL ON FUNCTION private.content_audit_decode_uri_path(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.content_audit_public_media_candidates(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.content_audit_document_uses_media(jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.content_audit_public_media_in_use(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_content_audit_public_media_reference() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_content_audit_public_media_upload() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.redact_deleted_notification_send_content(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recheck_content_audit_public_media(uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recheck_content_audit_public_media(uuid, uuid, text, jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
