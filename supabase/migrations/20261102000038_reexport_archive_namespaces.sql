BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- Permanent SQL34 records, not an active import/export job or staging snapshot.
-- Keep SQL33's native-export blocker unchanged: this protocol reads ONE explicit
-- source namespace and never silently substitutes native or other imported data.
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

REVOKE ALL ON FUNCTION private.employee_transfer_archive_reexport_snapshot(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_employee_archive_reexport_catalog(uuid,uuid,uuid),
  public.get_employee_archive_reexport_page(uuid,uuid,uuid,text,text,text,integer),
  public.get_employee_archive_reexport_verify(uuid,uuid,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_archive_reexport_catalog(uuid,uuid,uuid),
  public.get_employee_archive_reexport_page(uuid,uuid,uuid,text,text,text,integer),
  public.get_employee_archive_reexport_verify(uuid,uuid,uuid,text)
  TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
