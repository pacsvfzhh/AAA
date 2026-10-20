BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- Permanent SQL34 records, not an active import/export job or staging snapshot.
-- Keep SQL33's native-export blocker unchanged: individual readers bind an explicit
-- source namespace, while inventory checks every imported namespace, never native data.
CREATE FUNCTION private.employee_transfer_archive_reexport_snapshot(
  p_admin_session_token uuid, p_source_site_id uuid, p_package_id uuid
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_media jsonb;
  v_hash text;
BEGIN
  PERFORM private.employee_transfer_admin(p_admin_session_token);
  IF p_source_site_id IS NULL OR p_package_id IS NULL THEN
    RAISE EXCEPTION 'Invalid archive re-export namespace.';
  END IF;
  -- Exactly SQL34/36's latest records_verified selection, including its id tie-break.
  -- Do not filter by media, owner, status, expiry or heartbeat, or fall back to an
  -- older media-verified job when the selected job is incomplete or has drifted.
  SELECT * INTO v_job FROM private.employee_transfer_jobs j
    WHERE j.kind = 'import' AND j.options->>'import_protocol' = 'dispatch-submission-v1'
      AND j.summary#>'{archives_restore,records_verified}' = 'true'::jsonb
      AND j.summary#>'{archives_restore,catalog,site_id}' = to_jsonb(p_source_site_id)
      AND j.summary#>'{archives_restore,catalog,package_id}' = to_jsonb(p_package_id)
    ORDER BY j.started_at DESC, j.id LIMIT 1;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Verified archive namespace is required.'; END IF;
  PERFORM private.employee_transfer_archives_persisted(v_job);
  v_media := private.employee_transfer_archive_media_state(v_job, false);
  -- Missing sidecars are NOT verified empty inventories. SQL35 must have checked
  -- the complete refs/files/receipts/generation even when there are zero files.
  IF v_media->'verified' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Verified archive media sidecar is required for re-export.';
  END IF;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'job_id', v_job.id, 'catalog', v_job.summary->'archives_catalog',
    'namespace_hash', v_job.summary#>>'{archives_restore,namespace_hash}',
    'archives_media', v_media)::text, 'UTF8'), 'sha256'), 'hex');
  RETURN jsonb_build_object('catalog', v_job.summary->'archives_catalog', 'snapshot_hash', v_hash);
END;
$$;

CREATE FUNCTION public.get_employee_archive_reexport_catalog(
  p_admin_session_token uuid, p_source_site_id uuid, p_package_id uuid
) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT private.employee_transfer_archive_reexport_snapshot(p_admin_session_token, p_source_site_id, p_package_id);
$$;

CREATE FUNCTION public.get_employee_archive_reexport_page(
  p_admin_session_token uuid, p_source_site_id uuid, p_package_id uuid,
  p_snapshot_hash text, p_table_key text, p_after text DEFAULT NULL, p_limit integer DEFAULT 200
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_snapshot jsonb;
  v_row record;
  v_text text := '';
  v_count integer := 0;
  v_cursor text;
  v_more boolean := false;
BEGIN
  v_snapshot := private.employee_transfer_archive_reexport_snapshot(p_admin_session_token, p_source_site_id, p_package_id);
  IF p_snapshot_hash IS NULL OR length(p_snapshot_hash) <> 64 OR p_snapshot_hash !~ '^[0-9a-f]{64}$'
    OR p_snapshot_hash IS DISTINCT FROM v_snapshot->>'snapshot_hash' THEN
    RAISE EXCEPTION 'Archive re-export snapshot changed or is invalid; restart the export.';
  END IF;
  IF p_table_key IS NULL OR NOT p_table_key = ANY(private.employee_transfer_archives_keys())
    OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200
    OR (p_after IS NOT NULL AND length(p_after) > 73) THEN
    RAISE EXCEPTION 'Invalid archive re-export page.';
  END IF;
  IF p_after IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM private.employee_transfer_archive_records r
    WHERE r.source_site_id = p_source_site_id AND r.package_id = p_package_id AND r.table_key = p_table_key
      AND r.source_id COLLATE "C" = p_after COLLATE "C"
  ) THEN RAISE EXCEPTION 'Archive re-export cursor is not canonical.'; END IF;
  FOR v_row IN
    SELECT r.source_id, r.source_line FROM private.employee_transfer_archive_records r
    WHERE r.source_site_id = p_source_site_id AND r.package_id = p_package_id AND r.table_key = p_table_key
      AND (p_after IS NULL OR r.source_id COLLATE "C" > p_after COLLATE "C")
    ORDER BY r.source_id COLLATE "C" LIMIT p_limit + 1
  LOOP
    IF octet_length(v_row.source_line) NOT BETWEEN 1 AND 65536 THEN
      RAISE EXCEPTION 'Archive re-export row exceeds limits; no data was truncated.';
    END IF;
    IF v_count = p_limit OR octet_length(v_text) + octet_length(v_row.source_line) > 262144 THEN
      v_more := true; EXIT;
    END IF;
    -- Never reconstruct JSON: precision, microseconds, whitespace and null markers
    -- belong to the original LF-terminated source_line, not its jsonb projection.
    v_text := v_text || v_row.source_line;
    v_count := v_count + 1; v_cursor := v_row.source_id;
  END LOOP;
  RETURN jsonb_build_object('table_key', p_table_key, 'count', v_count, 'ndjson', v_text,
    'next_after', CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256', encode(extensions.digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex'));
END;
$$;

CREATE FUNCTION public.get_employee_archive_reexport_verify(
  p_admin_session_token uuid, p_source_site_id uuid, p_package_id uuid, p_snapshot_hash text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_snapshot jsonb;
BEGIN
  v_snapshot := private.employee_transfer_archive_reexport_snapshot(p_admin_session_token, p_source_site_id, p_package_id);
  IF p_snapshot_hash IS NULL OR length(p_snapshot_hash) <> 64 OR p_snapshot_hash !~ '^[0-9a-f]{64}$'
    OR p_snapshot_hash IS DISTINCT FROM v_snapshot->>'snapshot_hash' THEN
    RAISE EXCEPTION 'Archive re-export snapshot changed or is invalid; restart the export.';
  END IF;
  -- SQL33-compatible RECORD receipt only, despite the mandatory verified sidecar.
  -- This read neither changes media state nor claims Storage/full-site verification.
  RETURN '{"verified":true,"scope":"site-archives","media_pending":true,"full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.get_employee_archive_reexport_media(
  p_admin_session_token uuid, p_source_site_id uuid, p_package_id uuid, p_snapshot_hash text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_snapshot jsonb;
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_state jsonb;
  v_files jsonb;
  v_keys jsonb;
BEGIN
  v_snapshot := private.employee_transfer_archive_reexport_snapshot(p_admin_session_token, p_source_site_id, p_package_id);
  IF p_snapshot_hash IS NULL OR length(p_snapshot_hash) <> 64 OR p_snapshot_hash !~ '^[0-9a-f]{64}$'
    OR p_snapshot_hash IS DISTINCT FROM v_snapshot->>'snapshot_hash' THEN
    RAISE EXCEPTION 'Archive re-export snapshot changed or is invalid; restart the export.';
  END IF;
  -- STABLE functions share the calling SQL snapshot. Resolve exactly the same
  -- SQL34/36 job as the helper, not an older job selected by media availability.
  SELECT * INTO v_job FROM private.employee_transfer_jobs j
    WHERE j.kind = 'import' AND j.options->>'import_protocol' = 'dispatch-submission-v1'
      AND j.summary#>'{archives_restore,records_verified}' = 'true'::jsonb
      AND j.summary#>'{archives_restore,catalog,site_id}' = to_jsonb(p_source_site_id)
      AND j.summary#>'{archives_restore,catalog,package_id}' = to_jsonb(p_package_id)
    ORDER BY j.started_at DESC, j.id LIMIT 1;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Verified archive namespace is required.'; END IF;
  v_state := private.employee_transfer_archive_media_state(v_job, false);
  IF v_state->'verified' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'Verified archive media sidecar is required for re-export.';
  END IF;
  -- Only expose original refs (path = ref_value) and their bound file tuples.
  -- Storage target paths, origins, generations and receipts stay server-side;
  -- actual bytes must use readArchiveMedia's namespace/event/ref-key binding.
  SELECT COALESCE(jsonb_agg(r.value || jsonb_build_object('file', v_state->'files'->((r.n - 1)::integer)) ORDER BY r.n), '[]'::jsonb),
    COALESCE(jsonb_agg(r.value->'key' ORDER BY r.n), '[]'::jsonb)
    INTO v_files, v_keys
    FROM jsonb_array_elements(v_state->'refs') WITH ORDINALITY r(value, n);
  RETURN jsonb_build_object('version', 1, 'scope', 'site-archives-media', 'direction', 'export',
    'archives_catalog', v_snapshot->'catalog', 'files', v_files, 'bound', true, 'verified', true,
    'transferred', v_keys, 'checked', v_keys, 'full_site_complete', false);
END;
$$;

CREATE FUNCTION public.get_employee_archive_reexport_inventory(p_admin_session_token uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_namespace record;
  v_namespaces jsonb := '[]';
  v_result jsonb;
BEGIN
  -- Authenticate even an empty inventory. This is ONLY imported archive history;
  -- it neither includes this site's native six tables nor relaxes SQL33's blocker.
  PERFORM private.employee_transfer_admin(p_admin_session_token);
  FOR v_namespace IN
    SELECT n.source_site_id, n.package_id, count(*) OVER () AS total
    FROM (
      SELECT r.source_site_id, r.package_id FROM private.employee_transfer_archive_records r
      UNION
      SELECT (j.summary#>>'{archives_restore,catalog,site_id}')::uuid,
        (j.summary#>>'{archives_restore,catalog,package_id}')::uuid
      FROM private.employee_transfer_jobs j
      WHERE j.kind = 'import' AND j.options->>'import_protocol' = 'dispatch-submission-v1'
        AND j.summary#>'{archives_restore,records_verified}' = 'true'::jsonb
    ) n
    ORDER BY (n.source_site_id::text || ':' || n.package_id::text) COLLATE "C"
    LIMIT 1001
  LOOP
    -- The count is over the complete UNION, never a truncated/verified-only list.
    IF v_namespace.total > 1000 THEN
      RAISE EXCEPTION 'Archive re-export inventory exceeds 1000 namespaces; no namespace was omitted.';
    END IF;
    -- Every physical namespace must have a fully verified job AND media sidecar.
    -- Job-only namespaces preserve verified all-empty catalogs. Any failure aborts
    -- the ENTIRE inventory rather than silently skipping an unfinished import.
    v_namespaces := v_namespaces || jsonb_build_array(private.employee_transfer_archive_reexport_snapshot(
      p_admin_session_token, v_namespace.source_site_id, v_namespace.package_id));
    IF octet_length(v_namespaces::text) > 2097152 THEN
      RAISE EXCEPTION 'Archive re-export inventory exceeds 2 MiB; no namespace was omitted.';
    END IF;
  END LOOP;
  v_result := jsonb_build_object('scope', 'transferred-archives', 'namespaces', v_namespaces,
    'fingerprint', encode(extensions.digest(convert_to(v_namespaces::text, 'UTF8'), 'sha256'), 'hex'),
    'full_site_complete', false);
  IF octet_length(v_result::text) > 2097152 THEN
    RAISE EXCEPTION 'Archive re-export inventory exceeds 2 MiB; no namespace was omitted.';
  END IF;
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_archive_reexport_snapshot(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_employee_archive_reexport_catalog(uuid,uuid,uuid),
  public.get_employee_archive_reexport_page(uuid,uuid,uuid,text,text,text,integer),
  public.get_employee_archive_reexport_verify(uuid,uuid,uuid,text),
  public.get_employee_archive_reexport_media(uuid,uuid,uuid,text),
  public.get_employee_archive_reexport_inventory(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_archive_reexport_catalog(uuid,uuid,uuid),
  public.get_employee_archive_reexport_page(uuid,uuid,uuid,text,text,text,integer),
  public.get_employee_archive_reexport_verify(uuid,uuid,uuid,text),
  public.get_employee_archive_reexport_media(uuid,uuid,uuid,text),
  public.get_employee_archive_reexport_inventory(uuid)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
