BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

CREATE FUNCTION public.get_employee_transferred_archive_namespaces(
  p_admin_session_token uuid, p_after text DEFAULT NULL, p_limit integer DEFAULT 30
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_site uuid; v_package uuid; v_cursor text; v_last text;
  v_items jsonb := '[]'; v_counts jsonb; v_imported_at timestamptz;
  v_more boolean := false;
BEGIN
  PERFORM private.employee_transfer_admin(p_admin_session_token);
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
    OR (p_after IS NOT NULL AND (length(p_after) <> 73 OR p_after !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) THEN
    RAISE EXCEPTION 'Invalid transferred archive namespace page.';
  END IF;

  -- Match SQL34's latest verified import for each source namespace, independently of
  -- job expiry/cancellation, staging, maintenance or target live employee identities.
  FOR v_job IN
    SELECT latest.* FROM (
      SELECT DISTINCT ON ((j.summary#>>'{archives_restore,catalog,site_id}') COLLATE "C",
        (j.summary#>>'{archives_restore,catalog,package_id}') COLLATE "C") j.*
      FROM private.employee_transfer_jobs j
      WHERE j.kind = 'import' AND j.options->>'import_protocol' = 'dispatch-submission-v1'
        AND j.summary#>'{archives_restore,records_verified}' = 'true'::jsonb
      ORDER BY (j.summary#>>'{archives_restore,catalog,site_id}') COLLATE "C",
        (j.summary#>>'{archives_restore,catalog,package_id}') COLLATE "C", j.started_at DESC, j.id
    ) latest
    WHERE p_after IS NULL OR
      ((latest.summary#>>'{archives_restore,catalog,site_id}') || ':' ||
        (latest.summary#>>'{archives_restore,catalog,package_id}')) COLLATE "C" > p_after COLLATE "C"
    ORDER BY ((latest.summary#>>'{archives_restore,catalog,site_id}') || ':' ||
      (latest.summary#>>'{archives_restore,catalog,package_id}')) COLLATE "C"
    LIMIT p_limit + 1
  LOOP
    -- Fail closed on drift: never present a stale verified flag as a verified archive.
    PERFORM private.employee_transfer_archives_persisted(v_job);
    IF jsonb_array_length(v_items) = p_limit THEN v_more := true; EXIT; END IF;
    v_site := (v_job.summary#>>'{archives_restore,catalog,site_id}')::uuid;
    v_package := (v_job.summary#>>'{archives_restore,catalog,package_id}')::uuid;
    SELECT jsonb_object_agg(t->>'key', t->'rows') INTO v_counts
      FROM jsonb_array_elements(v_job.summary#>'{archives_restore,catalog,tables}') t;
    SELECT max(r.imported_at) INTO v_imported_at FROM private.employee_transfer_archive_records r
      WHERE r.source_site_id = v_site AND r.package_id = v_package;
    v_cursor := v_site::text || ':' || v_package::text;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'source_site_id', v_site, 'package_id', v_package,
      'imported_at', COALESCE(v_imported_at, v_job.finished_at, v_job.started_at),
      'counts', v_counts,
      'media_pending', v_job.summary#>'{archives_media,verified}' IS DISTINCT FROM 'true'::jsonb));
    v_last := v_cursor;
  END LOOP;
  RETURN jsonb_build_object('items', v_items, 'next_after', CASE WHEN v_more THEN v_last ELSE NULL END);
END;
$$;

REVOKE ALL ON FUNCTION public.get_employee_transferred_archive_namespaces(uuid,text,integer)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_transferred_archive_namespaces(uuid,text,integer)
  TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
