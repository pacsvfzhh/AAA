CREATE FUNCTION private.employee_transfer_shared_keys()
RETURNS text[] LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT ARRAY['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
    'admin_configs', 'system_configs', 'history_cleanup_config']::text[];
$$;

CREATE FUNCTION private.employee_transfer_shared_setting_valid(p_key text, p_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_tabs text[] := ARRAY['employees', 'products', 'withdrawals', 'verifications', 'announcements',
    'config', 'admins', 'validdata', 'messages', 'dispatch', 'records', 'customerservice',
    'cccservice', 'employeesearch', 'history', 'accountlocks', 'loginhistory'];
BEGIN
  IF p_key IS NULL OR p_value IS NULL THEN RETURN false; END IF;
  CASE p_key
    WHEN 'admin_navigation_preferences' THEN
      IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
      IF jsonb_typeof(p_value->'order') IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_value->'labels') IS DISTINCT FROM 'object'
        OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_value) AS item(key) WHERE item.key NOT IN ('order', 'labels'))
      THEN RETURN false; END IF;
      IF jsonb_array_length(p_value->'order') > 32
        OR (SELECT count(*) FROM jsonb_object_keys(p_value->'labels')) > 32
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_value->'order') AS item(value)
          WHERE jsonb_typeof(item.value) IS DISTINCT FROM 'string' OR (item.value #>> '{}') <> ALL(v_tabs))
        OR EXISTS (SELECT 1 FROM jsonb_each(p_value->'labels') AS item(key, value)
          WHERE item.key <> ALL(v_tabs) OR jsonb_typeof(item.value) IS DISTINCT FROM 'string'
            OR char_length(item.value #>> '{}') NOT BETWEEN 1 AND 12
            OR nullif(btrim(item.value #>> '{}'), '') IS NULL)
      THEN RETURN false; END IF;
      RETURN true;
    WHEN 'announcement_carousel_enabled' THEN RETURN jsonb_typeof(p_value) = 'boolean';
    WHEN 'announcement_carousel_speed' THEN
      IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN RETURN false; END IF;
      RETURN (p_value::text)::numeric BETWEEN 0.1 AND 5;
    WHEN 'login_title', 'login_subtitle' THEN
      IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      RETURN nullif(btrim(p_value #>> '{}'), '') IS NOT NULL
        AND char_length(p_value #>> '{}') <= CASE p_key WHEN 'login_title' THEN 100 ELSE 200 END;
    ELSE RETURN false;
  END CASE;
END;
$$;

CREATE FUNCTION private.employee_transfer_shared_validate()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.system_configs WHERE key NOT IN (
    'admin_navigation_preferences', 'announcement_carousel_enabled', 'announcement_carousel_speed',
    'login_title', 'login_subtitle', 'ios_config', 'auto_cleanup_schedule', 'auto_cleanup_history')) THEN
    RAISE EXCEPTION 'Unreviewed shared setting key; export blocked.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.system_configs WHERE key IN (
    'admin_navigation_preferences', 'announcement_carousel_enabled', 'announcement_carousel_speed', 'login_title', 'login_subtitle')
    AND NOT private.employee_transfer_shared_setting_valid(key, value)) THEN
    RAISE EXCEPTION 'Invalid shared setting value; export blocked.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admin_configs WHERE
    config_type NOT IN ('commission_rate', 'success_rate', 'withdrawal_amount_threshold', 'withdrawal_days_threshold',
      'company_name', 'theme', 'withdrawal_condition_mode', 'currency_unit', 'order_submit_time_min', 'order_submit_time_max', 'branding_mode')
    OR CASE
      WHEN config_type IN ('commission_rate', 'success_rate', 'withdrawal_amount_threshold', 'withdrawal_days_threshold',
        'order_submit_time_min', 'order_submit_time_max') THEN length(config_value) > 64 OR config_value !~ '^[0-9]+([.][0-9]+)?$'
      WHEN config_type = 'branding_mode' THEN config_value NOT IN ('custom', 'global')
      WHEN config_type = 'withdrawal_condition_mode' THEN config_value NOT IN ('OR', 'AND', 'amount_only', 'days_only')
      WHEN config_type = 'theme' THEN config_value !~ '^[a-zA-Z0-9_-]{1,64}$'
      WHEN config_type = 'currency_unit' THEN char_length(config_value) > 32
      WHEN config_type = 'company_name' THEN char_length(config_value) > 200
      ELSE false END
    OR octet_length(COALESCE(icon_custom_url, '')) > 2048) THEN
    RAISE EXCEPTION 'Unreviewed or invalid administrator setting; export blocked.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.history_cleanup_config
    WHERE NOT private.is_history_cleanup_table(table_name)) THEN
    RAISE EXCEPTION 'Unreviewed history retention setting; export blocked.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.admins AS admin
    LEFT JOIN public.financial_admin_credentials AS credential ON credential.admin_id = admin.id
    WHERE admin.role <> 'super_admin' AND (credential.admin_id IS NULL
      OR octet_length(admin.password_hash) > 128 OR octet_length(credential.password_hash) > 128)) THEN
    RAISE EXCEPTION 'Administrator credentials are missing or invalid; export blocked.';
  END IF;
  IF (SELECT count(*) FROM public.admins) > 10000
    OR (SELECT count(*) FROM public.financial_admin_credentials) > 10000
    OR (SELECT count(*) FROM public.admin_groups) > 10000
    OR (SELECT count(*) FROM public.admin_group_members) > 10000
    OR (SELECT count(*) FROM public.admin_configs) > 10000
    OR (SELECT count(*) FROM public.system_configs) > 10000
    OR (SELECT count(*) FROM public.history_cleanup_config) > 10000 THEN
    RAISE EXCEPTION 'Shared settings exceed the supported row limit.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_shared_rows(p_table_key text)
RETURNS TABLE(cursor text, body jsonb) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' AS $$
BEGIN
  CASE p_table_key
    WHEN 'admins' THEN
      RETURN QUERY SELECT admin.id::text, jsonb_build_object(
        'id', admin.id, 'username', admin.username, 'role', admin.role, 'parent_id', admin.parent_id,
        'is_active', admin.is_active, 'is_pinned', admin.is_pinned, 'created_at', admin.created_at, 'updated_at', admin.updated_at)
        || CASE WHEN admin.role = 'super_admin' THEN '{}'::jsonb ELSE jsonb_build_object('password_hash', admin.password_hash) END
      FROM public.admins AS admin;
    WHEN 'financial_admin_credentials' THEN
      RETURN QUERY SELECT credential.admin_id::text, jsonb_build_object('admin_id', credential.admin_id,
        'password_hash', credential.password_hash, 'created_at', credential.created_at, 'updated_at', credential.updated_at)
      FROM public.financial_admin_credentials AS credential JOIN public.admins AS admin ON admin.id = credential.admin_id
      WHERE admin.role IN ('secondary_admin', 'emergency_admin');
    WHEN 'admin_groups' THEN
      RETURN QUERY SELECT item.id::text, jsonb_build_object('id', item.id, 'name', item.name,
        'created_by', item.created_by, 'created_at', item.created_at, 'updated_at', item.updated_at)
      FROM public.admin_groups AS item;
    WHEN 'admin_group_members' THEN
      RETURN QUERY SELECT item.id::text, jsonb_build_object('id', item.id, 'group_id', item.group_id,
        'admin_id', item.admin_id, 'created_at', item.created_at) FROM public.admin_group_members AS item;
    WHEN 'admin_configs' THEN
      RETURN QUERY SELECT item.id::text, jsonb_build_object('id', item.id, 'admin_id', item.admin_id,
        'config_type', item.config_type, 'config_value', item.config_value, 'icon_type', item.icon_type,
        'icon_custom_url', item.icon_custom_url, 'created_at', item.created_at, 'updated_at', item.updated_at)
      FROM public.admin_configs AS item;
    WHEN 'system_configs' THEN
      RETURN QUERY SELECT item.key, jsonb_build_object('key', item.key, 'value', item.value)
      FROM public.system_configs AS item WHERE item.key IN ('admin_navigation_preferences', 'announcement_carousel_enabled',
        'announcement_carousel_speed', 'login_title', 'login_subtitle');
    WHEN 'history_cleanup_config' THEN
      RETURN QUERY SELECT item.table_name, jsonb_build_object('table_name', item.table_name, 'retention_days', item.retention_days,
        'auto_cleanup_enabled', item.auto_cleanup_enabled, 'schedule_time_utc', item.schedule_time_utc)
      FROM public.history_cleanup_config AS item;
    ELSE RAISE EXCEPTION 'Unsupported shared export table key.';
  END CASE;
END;
$$;

CREATE FUNCTION private.employee_transfer_shared_snapshot(p_table_key text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_rows jsonb; v_text text; v_count integer; v_bytes bigint; v_max_line integer;
BEGIN
  SELECT count(*)::integer, COALESCE(sum(octet_length(item.body::text || E'\n')), 0),
    COALESCE(max(octet_length(item.body::text || E'\n')), 0)
  INTO v_count, v_bytes, v_max_line FROM private.employee_transfer_shared_rows(p_table_key) AS item;
  IF v_count > 10000 OR v_bytes > 8388608 OR v_max_line > 65536 THEN
    RAISE EXCEPTION 'Shared export data exceeds the supported size limit.';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('cursor', item.cursor, 'ndjson', item.body::text || E'\n')
      ORDER BY item.cursor COLLATE "C"), '[]'::jsonb),
    COALESCE(string_agg(item.body::text || E'\n', '' ORDER BY item.cursor COLLATE "C"), ''), count(*)::integer
  INTO v_rows, v_text, v_count FROM private.employee_transfer_shared_rows(p_table_key) AS item;
  RETURN jsonb_build_object('rows', v_rows, 'count', v_count, 'bytes', octet_length(v_text),
    'sha256', encode(extensions.digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex'));
END;
$$;

-- STABLE keeps validation, all seven tables and both size scans on the caller's one MVCC snapshot.
CREATE FUNCTION private.employee_transfer_shared_capture()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text; v_snapshot jsonb; v_total integer := 0; v_result jsonb := '{}'::jsonb;
BEGIN
  PERFORM private.employee_transfer_shared_validate();
  FOREACH v_key IN ARRAY private.employee_transfer_shared_keys() LOOP
    v_snapshot := private.employee_transfer_shared_snapshot(v_key);
    v_total := v_total + (v_snapshot->>'bytes')::integer;
    IF v_total > 8388608 THEN RAISE EXCEPTION 'Shared settings exceed the supported total size limit.'; END IF;
    v_result := v_result || jsonb_build_object(v_key, v_snapshot);
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.employee_export_shared_begin(p_admin_session_token uuid, p_admin_password text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_begin jsonb; v_key text; v_snapshot jsonb; v_tables jsonb := '[]'::jsonb;
  v_capture jsonb; v_catalog jsonb; v_excluded jsonb;
BEGIN
  v_begin := private.employee_transfer_start_job(p_admin_session_token, p_admin_password, 'export',
    '{"export_protocol":"shared-settings-v1","scope":"shared-settings"}'::jsonb);
  IF NOT COALESCE((v_begin->>'success')::boolean, false) THEN RETURN v_begin; END IF;
  v_capture := private.employee_transfer_shared_capture();
  FOREACH v_key IN ARRAY private.employee_transfer_shared_keys() LOOP
    v_snapshot := v_capture->v_key;
    INSERT INTO private.employee_transfer_staging (job_id, employee_id, table_key, chunk_no, row_count, payload)
    VALUES ((v_begin->>'job_id')::uuid, '00000000-0000-0000-0000-000000000000', 'shared:' || v_key, 0,
      (v_snapshot->>'count')::integer, v_snapshot);
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('key', v_key, 'rows', v_snapshot->'count',
      'bytes', v_snapshot->'bytes', 'sha256', v_snapshot->'sha256'));
  END LOOP;
  SELECT COALESCE(jsonb_agg(item.key ORDER BY item.key COLLATE "C"), '[]'::jsonb) INTO v_excluded
    FROM public.system_configs AS item WHERE item.key IN ('ios_config', 'auto_cleanup_schedule', 'auto_cleanup_history');
  v_catalog := jsonb_build_object('version', 1, 'scope', 'shared-settings', 'site_id', v_begin->'site_id',
    'tables', v_tables, 'excluded_system_keys', v_excluded, 'full_site_complete', false);
  UPDATE private.employee_transfer_jobs SET summary = jsonb_build_object('shared_catalog', v_catalog)
  WHERE id = (v_begin->>'job_id')::uuid;
  RETURN v_begin || jsonb_build_object('catalog', v_catalog);
END;
$$;

CREATE FUNCTION public.get_employee_export_shared_catalog(p_admin_session_token uuid, p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  IF v_job.options->>'export_protocol' IS DISTINCT FROM 'shared-settings-v1' THEN
    RAISE EXCEPTION 'The task is not a shared settings export.';
  END IF;
  RETURN v_job.summary->'shared_catalog';
END;
$$;

CREATE FUNCTION public.get_employee_export_shared_page(
  p_admin_session_token uuid, p_job_token uuid, p_table_key text,
  p_after text DEFAULT NULL, p_limit integer DEFAULT 200
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE; v_snapshot jsonb; v_row jsonb;
  v_text text := ''; v_count integer := 0; v_bytes integer := 0; v_size integer;
  v_cursor text; v_more boolean := false;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  IF v_job.options->>'export_protocol' IS DISTINCT FROM 'shared-settings-v1' THEN
    RAISE EXCEPTION 'The task is not a shared settings export.';
  END IF;
  IF p_table_key IS NULL OR p_table_key <> ALL(private.employee_transfer_shared_keys()) THEN
    RAISE EXCEPTION 'Unsupported shared export table key.';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'Invalid shared export page limit.'; END IF;
  SELECT payload INTO v_snapshot FROM private.employee_transfer_staging
  WHERE job_id = v_job.id AND employee_id = '00000000-0000-0000-0000-000000000000'
    AND table_key = 'shared:' || p_table_key AND chunk_no = 0;
  IF v_snapshot IS NULL THEN RAISE EXCEPTION 'The shared export snapshot is missing.'; END IF;
  IF p_after IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_snapshot->'rows') AS item(value) WHERE item.value->>'cursor' = p_after) THEN
    RAISE EXCEPTION 'Invalid shared export cursor.';
  END IF;
  FOR v_row IN SELECT item.value FROM jsonb_array_elements(v_snapshot->'rows') AS item(value)
    WHERE p_after IS NULL OR (item.value->>'cursor') COLLATE "C" > p_after COLLATE "C"
    ORDER BY (item.value->>'cursor') COLLATE "C" LIMIT p_limit + 1 LOOP
    v_size := octet_length(v_row->>'ndjson');
    IF v_count = p_limit OR v_bytes + v_size > 262144 THEN v_more := true; EXIT; END IF;
    v_text := v_text || (v_row->>'ndjson');
    v_bytes := v_bytes + v_size;
    v_count := v_count + 1;
    v_cursor := v_row->>'cursor';
  END LOOP;
  RETURN jsonb_build_object('table_key', p_table_key, 'count', v_count, 'ndjson', v_text,
    'next_after', CASE WHEN v_more THEN v_cursor ELSE NULL END,
    'sha256', encode(extensions.digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex'));
END;
$$;

CREATE FUNCTION public.employee_export_shared_verify(p_admin_session_token uuid, p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_key text; v_expected jsonb; v_actual jsonb; v_capture jsonb;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  IF v_job.options->>'export_protocol' IS DISTINCT FROM 'shared-settings-v1' THEN
    RAISE EXCEPTION 'The task is not a shared settings export.';
  END IF;
  v_capture := private.employee_transfer_shared_capture();
  FOREACH v_key IN ARRAY private.employee_transfer_shared_keys() LOOP
    SELECT payload INTO v_expected FROM private.employee_transfer_staging
    WHERE job_id = v_job.id AND employee_id = '00000000-0000-0000-0000-000000000000'
      AND table_key = 'shared:' || v_key AND chunk_no = 0;
    v_actual := v_capture->v_key;
    IF v_expected IS NULL OR v_expected->'count' IS DISTINCT FROM v_actual->'count'
      OR v_expected->'bytes' IS DISTINCT FROM v_actual->'bytes'
      OR v_expected->'sha256' IS DISTINCT FROM v_actual->'sha256' THEN
      RAISE EXCEPTION 'Shared source data changed; export must be restarted.';
    END IF;
  END LOOP;
  UPDATE private.employee_transfer_jobs SET summary = summary || '{"shared_verified":true}'::jsonb WHERE id = v_job.id;
  PERFORM private.employee_transfer_log(v_job.id, v_job.admin_id, v_job.admin_username, 'export', 'shared_source_verified',
    '{"scope":"shared-settings","full_site_complete":false}'::jsonb);
  RETURN '{"verified":true,"scope":"shared-settings","full_site_complete":false}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.employee_export_finish(p_admin_session_token uuid, p_job_token uuid, p_summary jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'export');
  IF v_job.options->>'export_protocol' = 'shared-settings-v1' THEN
    RAISE EXCEPTION 'Shared settings verification is not a completed full-site export.';
  END IF;
  PERFORM private.employee_transfer_end_job(v_job, 'finished', COALESCE(p_summary, '{}'::jsonb));
  RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_shared_keys() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_setting_valid(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_validate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_rows(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_snapshot(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_capture() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_export_shared_begin(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_export_shared_catalog(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_export_shared_page(uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_export_shared_verify(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_export_shared_begin(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_export_shared_catalog(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_export_shared_page(uuid, uuid, text, text, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_export_shared_verify(uuid, uuid) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
