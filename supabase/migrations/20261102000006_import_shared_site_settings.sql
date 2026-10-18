CREATE FUNCTION private.employee_transfer_exact_object(p_value jsonb, p_keys text[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN p_value ?& p_keys AND (SELECT count(*) FROM jsonb_object_keys(p_value)) = cardinality(p_keys);
END;
$$;

CREATE FUNCTION private.employee_transfer_unique_json(p_value json, p_depth integer DEFAULT 0)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_item json;
BEGIN
  IF p_depth > 16 THEN RETURN false; END IF;
  IF json_typeof(p_value) = 'object' THEN
    IF (SELECT count(*) <> count(DISTINCT key) FROM json_each(p_value)) THEN RETURN false; END IF;
    FOR v_item IN SELECT value FROM json_each(p_value) LOOP
      IF NOT private.employee_transfer_unique_json(v_item, p_depth + 1) THEN RETURN false; END IF;
    END LOOP;
  ELSIF json_typeof(p_value) = 'array' THEN
    FOR v_item IN SELECT value FROM json_array_elements(p_value) LOOP
      IF NOT private.employee_transfer_unique_json(v_item, p_depth + 1) THEN RETURN false; END IF;
    END LOOP;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION private.employee_transfer_check_shared_catalog(p_catalog jsonb)
RETURNS void LANGUAGE plpgsql IMMUTABLE
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_item jsonb; v_keys text[] := '{}'; v_total bigint := 0; v_excluded text[] := '{}'; v_key text;
BEGIN
  IF octet_length(p_catalog::text) > 16384 OR NOT private.employee_transfer_exact_object(p_catalog,
    ARRAY['version', 'scope', 'site_id', 'tables', 'excluded_system_keys', 'full_site_complete'])
    OR p_catalog->'version' IS DISTINCT FROM '1'::jsonb
    OR p_catalog->>'scope' IS DISTINCT FROM 'shared-settings'
    OR p_catalog->'full_site_complete' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(p_catalog->'site_id') IS DISTINCT FROM 'string'
    OR (p_catalog->>'site_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR jsonb_typeof(p_catalog->'tables') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_catalog->'excluded_system_keys') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Invalid shared import catalog.';
  END IF;
  IF jsonb_array_length(p_catalog->'tables') <> 7 OR jsonb_array_length(p_catalog->'excluded_system_keys') > 3 THEN
    RAISE EXCEPTION 'Invalid shared import catalog.';
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_catalog->'tables') LOOP
    IF NOT private.employee_transfer_exact_object(v_item, ARRAY['key', 'rows', 'bytes', 'sha256'])
      OR jsonb_typeof(v_item->'key') IS DISTINCT FROM 'string'
      OR (v_item->>'key') <> ALL(private.employee_transfer_shared_keys())
      OR (v_item->>'key') = ANY(v_keys)
      OR jsonb_typeof(v_item->'rows') IS DISTINCT FROM 'number' OR (v_item->>'rows') !~ '^(0|[1-9][0-9]{0,4})$'
      OR jsonb_typeof(v_item->'bytes') IS DISTINCT FROM 'number' OR (v_item->>'bytes') !~ '^(0|[1-9][0-9]{0,6})$'
      OR jsonb_typeof(v_item->'sha256') IS DISTINCT FROM 'string' OR (v_item->>'sha256') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'Invalid shared import table descriptor.';
    END IF;
    IF (v_item->>'rows')::integer > 10000 OR (v_item->>'bytes')::integer > 8388608 THEN
      RAISE EXCEPTION 'Shared import catalog exceeds limits.';
    END IF;
    v_total := v_total + (v_item->>'bytes')::integer;
    v_keys := array_append(v_keys, v_item->>'key');
  END LOOP;
  IF v_total > 8388608 THEN RAISE EXCEPTION 'Shared import catalog exceeds limits.'; END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(p_catalog->'excluded_system_keys') LOOP
    v_key := v_item #>> '{}';
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'string'
      OR v_key NOT IN ('ios_config', 'auto_cleanup_schedule', 'auto_cleanup_history') OR v_key = ANY(v_excluded) THEN
      RAISE EXCEPTION 'Invalid shared import excluded setting.';
    END IF;
    v_excluded := array_append(v_excluded, v_key);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION private.employee_transfer_job(p_session uuid, p_job_token uuid, p_kind text)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_admin uuid; v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  SELECT admin.admin_id INTO v_admin FROM private.employee_transfer_admin(p_session) AS admin;
  IF p_job_token IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.'; END IF;
  UPDATE private.employee_transfer_jobs SET last_activity_at = now()
  WHERE token_hash = private.hash_financial_token(p_job_token)
    AND kind = CASE WHEN p_kind = 'shared-import' THEN 'import' ELSE p_kind END
    AND admin_id = v_admin AND status = 'running'
    AND last_activity_at > now() - interval '3 hours' AND started_at > now() - interval '12 hours'
  RETURNING * INTO v_job;
  IF v_job.id IS NULL THEN RAISE EXCEPTION 'Employee transfer task is invalid or expired.'; END IF;
  IF (v_job.options->>'import_protocol' = 'shared-import-v1' AND p_kind <> 'shared-import')
    OR (p_kind = 'shared-import' AND v_job.options->>'import_protocol' IS DISTINCT FROM 'shared-import-v1') THEN
    RAISE EXCEPTION 'The task protocol does not permit this operation.';
  END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION private.employee_transfer_shared_import_job(p_session uuid, p_job_token uuid)
RETURNS private.employee_transfer_jobs LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE;
BEGIN
  v_job := private.employee_transfer_job(p_session, p_job_token, 'shared-import');
  IF v_job.options->>'import_protocol' IS DISTINCT FROM 'shared-import-v1' THEN
    RAISE EXCEPTION 'The task is not a shared settings import.';
  END IF;
  PERFORM private.employee_transfer_check_shared_catalog(v_job.options->'catalog');
  IF COALESCE(v_job.options->>'package_id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR v_job.options->>'source_site_id' IS DISTINCT FROM v_job.options #>> '{catalog,site_id}'
    OR (v_job.options #>> '{catalog,site_id}')::uuid = (SELECT site_id FROM private.employee_transfer_site) THEN
    RAISE EXCEPTION 'Invalid shared import source identity.';
  END IF;
  RETURN v_job;
END;
$$;

CREATE FUNCTION public.employee_import_shared_begin(
  p_admin_session_token uuid, p_admin_password text, p_package_id uuid, p_catalog jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_result jsonb;
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  PERFORM private.employee_transfer_check_shared_catalog(p_catalog);
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'A source package identity is required.'; END IF;
  IF (p_catalog->>'site_id')::uuid = (SELECT site_id FROM private.employee_transfer_site) THEN
    RAISE EXCEPTION 'The shared export belongs to this same site.';
  END IF;
  v_result := private.employee_transfer_start_job(p_admin_session_token, p_admin_password, 'import',
    jsonb_build_object('import_protocol', 'shared-import-v1', 'scope', 'shared-settings', 'package_id', p_package_id,
      'source_site_id', p_catalog->'site_id', 'catalog', p_catalog));
  IF NOT COALESCE((v_result->>'success')::boolean, false) THEN RETURN v_result; END IF;
  RETURN v_result || '{"scope":"shared-settings","full_site_complete":false}'::jsonb;
END;
$$;

CREATE FUNCTION public.employee_import_shared_stage(
  p_admin_session_token uuid, p_job_token uuid, p_table_key text, p_chunk_no integer, p_ndjson text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE; v_line text; v_json json; v_count integer := 0;
  v_hash text; v_bytes integer; v_previous jsonb; v_descriptor jsonb; v_count_total bigint; v_bytes_total bigint;
BEGIN
  v_job := private.employee_transfer_shared_import_job(p_admin_session_token, p_job_token);
  IF p_table_key IS NULL OR p_table_key <> ALL(private.employee_transfer_shared_keys())
    OR p_chunk_no IS NULL OR p_chunk_no NOT BETWEEN 0 AND 10000 OR p_ndjson IS NULL
    OR octet_length(p_ndjson) > 262144 OR (p_ndjson <> '' AND right(p_ndjson, 1) <> E'\n') THEN
    RAISE EXCEPTION 'Invalid shared import chunk.';
  END IF;
  IF COALESCE((v_job.summary->>'shared_applied')::boolean, false) THEN
    RAISE EXCEPTION 'The shared import has already been applied.';
  END IF;
  IF p_ndjson <> '' THEN
    FOR v_line IN SELECT line FROM unnest(string_to_array(left(p_ndjson, length(p_ndjson) - 1), E'\n')) AS item(line) LOOP
      IF octet_length(v_line) + 1 > 65536 THEN RAISE EXCEPTION 'Shared import row exceeds the limit.'; END IF;
      BEGIN
        v_json := v_line::json;
        IF json_typeof(v_json) IS DISTINCT FROM 'object' OR NOT private.employee_transfer_unique_json(v_json) THEN
          RAISE EXCEPTION 'Invalid JSON';
        END IF;
        PERFORM v_json::jsonb;
      EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid shared import JSON row.' USING ERRCODE = '22023';
      END;
      v_count := v_count + 1;
    END LOOP;
  END IF;
  IF v_count > 200 OR (v_count = 0 AND p_chunk_no <> 0) THEN RAISE EXCEPTION 'Invalid shared import chunk row count.'; END IF;
  v_bytes := octet_length(p_ndjson);
  v_hash := encode(extensions.digest(convert_to(p_ndjson, 'UTF8'), 'sha256'), 'hex');
  SELECT payload INTO v_previous FROM private.employee_transfer_staging WHERE job_id = v_job.id
    AND employee_id = '00000000-0000-0000-0000-000000000000' AND table_key = 'shared-import:' || p_table_key AND chunk_no = p_chunk_no;
  IF v_previous IS NOT NULL THEN
    IF v_previous->>'ndjson' IS DISTINCT FROM p_ndjson THEN RAISE EXCEPTION 'A staged chunk identity cannot be reused with different contents.'; END IF;
    RETURN jsonb_build_object('success', true, 'rows', v_count, 'bytes', v_bytes, 'sha256', v_hash, 'repeated', true);
  END IF;
  SELECT value INTO v_descriptor FROM jsonb_array_elements(v_job.options #> '{catalog,tables}')
    WHERE value->>'key' = p_table_key;
  SELECT COALESCE(sum(row_count), 0) + v_count, COALESCE(sum((payload->>'bytes')::integer), 0) + v_bytes
    INTO v_count_total, v_bytes_total FROM private.employee_transfer_staging
    WHERE job_id = v_job.id AND employee_id = '00000000-0000-0000-0000-000000000000' AND table_key = 'shared-import:' || p_table_key;
  IF v_count_total > (v_descriptor->>'rows')::integer OR v_bytes_total > (v_descriptor->>'bytes')::integer THEN
    RAISE EXCEPTION 'Shared import chunk exceeds its bound catalog totals.';
  END IF;
  INSERT INTO private.employee_transfer_staging (job_id, employee_id, table_key, chunk_no, row_count, payload)
  VALUES (v_job.id, '00000000-0000-0000-0000-000000000000', 'shared-import:' || p_table_key, p_chunk_no, v_count,
    jsonb_build_object('ndjson', p_ndjson, 'bytes', v_bytes, 'sha256', v_hash));
  RETURN jsonb_build_object('success', true, 'rows', v_count, 'bytes', v_bytes, 'sha256', v_hash, 'repeated', false);
END;
$$;

CREATE FUNCTION private.employee_transfer_shared_import_data(p_job private.employee_transfer_jobs)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE
  v_descriptor jsonb; v_key text; v_text text; v_rows integer; v_chunks integer; v_max integer;
  v_array jsonb; v_result jsonb := '{}'::jsonb;
BEGIN
  FOR v_descriptor IN SELECT value FROM jsonb_array_elements(p_job.options #> '{catalog,tables}') LOOP
    v_key := v_descriptor->>'key';
    SELECT COALESCE(string_agg(payload->>'ndjson', '' ORDER BY chunk_no), ''), COALESCE(sum(row_count), 0)::integer,
      count(*)::integer, max(chunk_no) INTO v_text, v_rows, v_chunks, v_max
    FROM private.employee_transfer_staging WHERE job_id = p_job.id
      AND employee_id = '00000000-0000-0000-0000-000000000000' AND table_key = 'shared-import:' || v_key;
    IF v_chunks = 0 OR v_max + 1 <> v_chunks OR v_rows <> (v_descriptor->>'rows')::integer
      OR octet_length(v_text) <> (v_descriptor->>'bytes')::integer
      OR encode(extensions.digest(convert_to(v_text, 'UTF8'), 'sha256'), 'hex') <> v_descriptor->>'sha256' THEN
      RAISE EXCEPTION 'Shared import is incomplete or does not match the bound catalog.';
    END IF;
    IF v_text = '' THEN v_array := '[]'::jsonb;
    ELSE SELECT jsonb_agg(line::jsonb ORDER BY ordinal) INTO v_array
      FROM unnest(string_to_array(left(v_text, length(v_text) - 1), E'\n')) WITH ORDINALITY AS item(line, ordinal);
    END IF;
    v_result := v_result || jsonb_build_object(v_key, v_array);
  END LOOP;
  RETURN v_result;
END;
$$;

CREATE FUNCTION private.employee_transfer_shared_import_row(p_key text, p_row jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_fields text[]; v_field text; v_type text; v_id uuid; v_time timestamptz; v_number numeric; v_role text;
BEGIN
  CASE p_key
    WHEN 'admins' THEN
      v_fields := ARRAY['id','username','role','parent_id','is_active','is_pinned','created_at','updated_at'];
      v_role := p_row->>'role';
      IF v_role NOT IN ('super_admin','secondary_admin','emergency_admin') OR v_role IS NULL THEN RAISE EXCEPTION 'Invalid role'; END IF;
      IF v_role <> 'super_admin' THEN v_fields := array_append(v_fields, 'password_hash'); END IF;
      IF jsonb_typeof(p_row->'username') IS DISTINCT FROM 'string' OR nullif(btrim(p_row->>'username'), '') IS NULL
        OR octet_length(p_row->>'username') > 1024 THEN RAISE EXCEPTION 'Invalid username'; END IF;
      PERFORM jsonb_populate_record(NULL::public.admins, p_row);
    WHEN 'financial_admin_credentials' THEN
      v_fields := ARRAY['admin_id','password_hash','created_at','updated_at'];
      PERFORM jsonb_populate_record(NULL::public.financial_admin_credentials, p_row);
    WHEN 'admin_groups' THEN
      v_fields := ARRAY['id','name','created_by','created_at','updated_at'];
      IF jsonb_typeof(p_row->'name') IS DISTINCT FROM 'string' OR nullif(btrim(p_row->>'name'), '') IS NULL THEN RAISE EXCEPTION 'Invalid group'; END IF;
      PERFORM jsonb_populate_record(NULL::public.admin_groups, p_row);
    WHEN 'admin_group_members' THEN
      v_fields := ARRAY['id','group_id','admin_id','created_at'];
      PERFORM jsonb_populate_record(NULL::public.admin_group_members, p_row);
    WHEN 'admin_configs' THEN
      v_fields := ARRAY['id','admin_id','config_type','config_value','icon_type','icon_custom_url','created_at','updated_at'];
      IF jsonb_typeof(p_row->'config_type') IS DISTINCT FROM 'string' OR jsonb_typeof(p_row->'config_value') IS DISTINCT FROM 'string'
        OR p_row->>'config_type' NOT IN ('commission_rate','success_rate','withdrawal_amount_threshold','withdrawal_days_threshold',
          'company_name','theme','withdrawal_condition_mode','currency_unit','order_submit_time_min','order_submit_time_max','branding_mode') THEN
        RAISE EXCEPTION 'Invalid setting';
      END IF;
      CASE p_row->>'config_type'
        WHEN 'commission_rate','success_rate','withdrawal_amount_threshold','withdrawal_days_threshold','order_submit_time_min','order_submit_time_max' THEN
          IF length(p_row->>'config_value') > 64 OR (p_row->>'config_value') !~ '^[0-9]+([.][0-9]+)?$' THEN RAISE EXCEPTION 'Invalid setting'; END IF;
        WHEN 'branding_mode' THEN IF p_row->>'config_value' NOT IN ('custom','global') THEN RAISE EXCEPTION 'Invalid setting'; END IF;
        WHEN 'withdrawal_condition_mode' THEN IF p_row->>'config_value' NOT IN ('OR','AND','amount_only','days_only') THEN RAISE EXCEPTION 'Invalid setting'; END IF;
        WHEN 'theme' THEN IF (p_row->>'config_value') !~ '^[a-zA-Z0-9_-]{1,64}$' THEN RAISE EXCEPTION 'Invalid setting'; END IF;
        WHEN 'currency_unit' THEN IF char_length(p_row->>'config_value') > 32 THEN RAISE EXCEPTION 'Invalid setting'; END IF;
        WHEN 'company_name' THEN IF char_length(p_row->>'config_value') > 200 THEN RAISE EXCEPTION 'Invalid setting'; END IF;
      END CASE;
      IF jsonb_typeof(p_row->'icon_type') NOT IN ('string','null') OR jsonb_typeof(p_row->'icon_custom_url') NOT IN ('string','null')
        OR octet_length(COALESCE(p_row->>'icon_custom_url','')) > 2048 THEN RAISE EXCEPTION 'Invalid icon'; END IF;
      IF p_row->>'icon_type' IS NOT NULL AND p_row->>'icon_type' NOT IN ('default','custom','preset_1','preset_2','preset_3','preset_4',
        'preset_5','preset_6','preset_7','preset_8','preset_9','preset_10','preset_11') THEN RAISE EXCEPTION 'Invalid icon'; END IF;
      PERFORM jsonb_populate_record(NULL::public.admin_configs, p_row);
    WHEN 'system_configs' THEN
      v_fields := ARRAY['key','value'];
      IF NOT private.employee_transfer_shared_setting_valid(p_row->>'key', p_row->'value') THEN RAISE EXCEPTION 'Invalid shared setting'; END IF;
    WHEN 'history_cleanup_config' THEN
      v_fields := ARRAY['table_name','retention_days','auto_cleanup_enabled','schedule_time_utc'];
      IF jsonb_typeof(p_row->'table_name') IS DISTINCT FROM 'string' OR NOT COALESCE(private.is_history_cleanup_table(p_row->>'table_name'), false)
        OR jsonb_typeof(p_row->'retention_days') IS DISTINCT FROM 'number' OR (p_row->>'retention_days') !~ '^(0|[1-9][0-9]{0,8})$'
        OR jsonb_typeof(p_row->'auto_cleanup_enabled') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(p_row->'schedule_time_utc') IS DISTINCT FROM 'string'
        OR (p_row->>'schedule_time_utc') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]:00$' THEN RAISE EXCEPTION 'Invalid retention setting'; END IF;
      v_number := (p_row->>'retention_days')::numeric;
      IF v_number < (SELECT min_retention_days FROM public.history_cleanup_config WHERE table_name = p_row->>'table_name') THEN
        RAISE EXCEPTION 'Invalid retention setting';
      END IF;
    ELSE RAISE EXCEPTION 'Invalid table key';
  END CASE;
  IF NOT private.employee_transfer_exact_object(p_row, v_fields) THEN RAISE EXCEPTION 'Invalid fields'; END IF;
  FOREACH v_field IN ARRAY v_fields LOOP
    v_type := jsonb_typeof(p_row->v_field);
    IF v_field IN ('id','admin_id','parent_id','created_by','group_id') THEN
      IF v_type = 'null' AND (v_field = 'parent_id' OR (v_field = 'admin_id' AND p_key = 'admin_configs')) THEN CONTINUE; END IF;
      IF v_type <> 'string' OR (p_row->>v_field) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid identity'; END IF;
      v_id := (p_row->>v_field)::uuid;
    ELSIF v_field IN ('is_active','is_pinned') THEN
      IF v_type NOT IN ('boolean','null') THEN RAISE EXCEPTION 'Invalid boolean'; END IF;
    ELSIF v_field = 'password_hash' THEN
      IF v_type <> 'string' OR (p_row->>v_field) !~ '^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$' THEN
        RAISE EXCEPTION 'Invalid credential';
      END IF;
    ELSIF v_field IN ('created_at','updated_at') THEN
      IF v_type = 'null' AND p_key <> 'financial_admin_credentials' THEN CONTINUE; END IF;
      IF v_type <> 'string' OR (p_row->>v_field) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN
        RAISE EXCEPTION 'Invalid timestamp';
      END IF;
      v_time := (p_row->>v_field)::timestamptz;
      IF NOT isfinite(v_time) THEN RAISE EXCEPTION 'Invalid timestamp'; END IF;
    END IF;
  END LOOP;
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid shared import record.' USING ERRCODE = '22023';
END;
$$;

CREATE FUNCTION private.employee_transfer_check_shared_input(p_data jsonb)
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_key text; v_row jsonb; v_id_key text;
BEGIN
  FOREACH v_key IN ARRAY private.employee_transfer_shared_keys() LOOP
    v_id_key := CASE v_key WHEN 'financial_admin_credentials' THEN 'admin_id' WHEN 'system_configs' THEN 'key'
      WHEN 'history_cleanup_config' THEN 'table_name' ELSE 'id' END;
    FOR v_row IN SELECT value FROM jsonb_array_elements(p_data->v_key) LOOP
      PERFORM private.employee_transfer_shared_import_row(v_key, v_row);
    END LOOP;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->v_key) AS item(value)
      GROUP BY value->>v_id_key HAVING count(*) > 1) THEN RAISE EXCEPTION 'Duplicate shared import identity.'; END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admins') WHERE value->>'role' = 'super_admin')
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admins') GROUP BY value->>'username' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Invalid source administrator identities.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admins') AS admin(value) WHERE admin.value->>'role' <> 'super_admin'
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'financial_admin_credentials') AS credential(value)
      WHERE credential.value->>'admin_id' = admin.value->>'id'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'financial_admin_credentials') AS credential(value)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admins') AS admin(value)
        WHERE admin.value->>'id' = credential.value->>'admin_id' AND admin.value->>'role' <> 'super_admin')) THEN
    RAISE EXCEPTION 'Source administrator credentials do not match the source identities.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admins') AS admin(value)
    WHERE admin.value->>'role' <> 'super_admin' AND admin.value->>'parent_id' IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admins') AS parent(value) WHERE parent.value->>'id' = admin.value->>'parent_id')) THEN
    RAISE EXCEPTION 'A source administrator parent is missing.';
  END IF;
  IF (WITH RECURSIVE hierarchy AS (
    SELECT value FROM jsonb_array_elements(p_data->'admins') WHERE value->>'role' <> 'super_admin'
      AND (value->>'parent_id' IS NULL OR value->>'parent_id' IN (SELECT value->>'id' FROM jsonb_array_elements(p_data->'admins') WHERE value->>'role' = 'super_admin'))
    UNION ALL SELECT child.value FROM jsonb_array_elements(p_data->'admins') AS child(value)
      JOIN hierarchy AS parent ON child.value->>'parent_id' = parent.value->>'id' WHERE child.value->>'role' <> 'super_admin'
  ) SELECT count(*) FROM hierarchy) <> (SELECT count(*) FROM jsonb_array_elements(p_data->'admins') WHERE value->>'role' <> 'super_admin') THEN
    RAISE EXCEPTION 'Source administrator hierarchy contains a cycle.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admin_groups') AS item(value)
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admins') WHERE value->>'id' = item.value->>'created_by'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admin_group_members') AS item(value)
      WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admin_groups') WHERE value->>'id' = item.value->>'group_id')
        OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admins') WHERE value->>'id' = item.value->>'admin_id'))
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admin_configs') AS item(value) WHERE item.value->>'admin_id' IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_data->'admins') WHERE value->>'id' = item.value->>'admin_id')) THEN
    RAISE EXCEPTION 'A shared import relationship is missing from the bound source package.';
  END IF;
END;
$$;

CREATE FUNCTION private.employee_transfer_shared_import_plan(p_job private.employee_transfer_jobs, p_data jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' AS $$
DECLARE
  v_row jsonb; v_mapped jsonb; v_target jsonb; v_key text; v_id text; v_reason text; v_action text; v_exact_target boolean;
  v_admin_map jsonb := '{}'::jsonb; v_admins jsonb := '[]'::jsonb; v_conflicts jsonb := '[]'::jsonb;
  v_records jsonb := '[]'::jsonb; v_seen text[] := '{}'; v_precise_global text[] := '{}'; v_natural text; v_plan jsonb;
BEGIN
  PERFORM private.employee_transfer_check_shared_input(p_data);
  FOR v_row IN SELECT value FROM jsonb_array_elements(p_data->'admins') LOOP
    v_reason := NULL;
    v_id := v_row->>'id';
    IF v_row->>'role' = 'super_admin' THEN
      v_action := 'map-super';
      v_admin_map := v_admin_map || jsonb_build_object(v_id, p_job.admin_id);
    ELSE
      v_action := 'create';
      IF EXISTS (SELECT 1 FROM public.admins WHERE id = v_id::uuid OR username = v_row->>'username') THEN
        v_reason := 'administrator_identity_conflict';
      ELSIF EXISTS (SELECT 1 FROM public.users WHERE username = v_row->>'username') THEN
        v_reason := 'username_matches_employee';
      END IF;
      v_admin_map := v_admin_map || jsonb_build_object(v_id, v_id);
    END IF;
    IF v_reason IS NOT NULL THEN
      v_action := 'conflict';
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('table_key','admins','source_id',v_id,'reason',v_reason));
    END IF;
    v_admins := v_admins || jsonb_build_array(jsonb_build_object('source_id',v_id,'username',v_row->'username',
      'role',v_row->'role','action',v_action,'target_id',v_admin_map->v_id));
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['admin_groups','admin_group_members','admin_configs','system_configs','history_cleanup_config'] LOOP
    v_seen := '{}'; v_precise_global := '{}';
    FOR v_row IN SELECT value FROM jsonb_array_elements(p_data->v_key) LOOP
      v_reason := NULL; v_target := NULL; v_mapped := v_row; v_exact_target := false;
      v_id := COALESCE(v_row->>'id',v_row->>'key',v_row->>'table_name');
      IF v_key = 'admin_groups' THEN
        v_mapped := jsonb_set(v_row, '{created_by}', v_admin_map->(v_row->>'created_by'));
        SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key) WHERE cursor = v_id;
        IF v_target IS NULL AND EXISTS (SELECT 1 FROM public.admin_groups WHERE name = v_row->>'name') THEN v_reason := 'group_name_conflict'; END IF;
      ELSIF v_key = 'admin_group_members' THEN
        v_mapped := jsonb_set(v_row,'{admin_id}',v_admin_map->(v_row->>'admin_id'));
        SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key) WHERE cursor = v_id;
        v_exact_target := v_target IS NOT NULL;
        IF v_target IS NULL AND EXISTS (SELECT 1 FROM public.admin_group_members
          WHERE group_id = (v_row->>'group_id')::uuid AND admin_id = (v_mapped->>'admin_id')::uuid) THEN
          v_reason := 'group_membership_conflict';
        END IF;
        v_natural := (v_row->>'group_id') || ':' || (v_mapped->>'admin_id');
      ELSIF v_key = 'admin_configs' THEN
        IF v_row->>'admin_id' IS NOT NULL THEN v_mapped := jsonb_set(v_row,'{admin_id}',v_admin_map->(v_row->>'admin_id')); END IF;
        SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key) WHERE cursor = v_id;
        v_exact_target := v_target IS NOT NULL;
        IF v_target IS NULL THEN
          SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key)
            WHERE (body->>'admin_id') IS NOT DISTINCT FROM (v_mapped->>'admin_id') AND body->>'config_type' = v_row->>'config_type';
          IF (SELECT count(*) FROM public.admin_configs WHERE admin_id IS NOT DISTINCT FROM (v_mapped->>'admin_id')::uuid
            AND config_type = v_row->>'config_type') > 1 THEN v_reason := 'ambiguous_target_setting'; END IF;
        END IF;
        IF EXISTS (SELECT 1 FROM public.admin_configs WHERE id = v_id::uuid
          AND (admin_id IS DISTINCT FROM (v_mapped->>'admin_id')::uuid OR config_type IS DISTINCT FROM v_row->>'config_type')) THEN
          v_reason := 'setting_id_conflict';
        END IF;
        IF COALESCE(v_row->>'icon_custom_url','') <> '' THEN v_reason := 'media_rewrite_required'; END IF;
        IF v_target IS NOT NULL THEN
          v_target := v_target - ARRAY['id','created_at','updated_at'];
          v_mapped := v_mapped - ARRAY['id','created_at','updated_at'];
        END IF;
        v_natural := COALESCE(v_mapped->>'admin_id','global') || ':' || (v_row->>'config_type');
      ELSIF v_key = 'system_configs' THEN
        SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key) WHERE cursor = v_id;
      ELSE
        SELECT body INTO v_target FROM private.employee_transfer_shared_rows(v_key) WHERE cursor = v_id;
        IF v_target IS NULL THEN v_reason := 'target_retention_definition_missing'; END IF;
      END IF;
      IF v_key IN ('admin_configs','admin_group_members') THEN
        IF v_natural = ANY(v_seen) THEN
          IF NOT (v_key='admin_configs' AND v_row->>'admin_id' IS NULL AND v_natural=ANY(v_precise_global)
            AND v_exact_target AND v_target=v_mapped) THEN v_reason := 'mapped_source_identity_collision'; END IF;
        ELSIF v_key='admin_configs' AND v_row->>'admin_id' IS NULL AND v_exact_target AND v_target=v_mapped THEN
          v_precise_global := array_append(v_precise_global,v_natural);
        END IF;
        v_seen := array_append(v_seen,v_natural);
      END IF;
      IF v_target IS NULL THEN v_action := 'create';
      ELSIF v_target = v_mapped THEN v_action := 'reuse';
      ELSE v_reason := COALESCE(v_reason,'target_content_conflict'); v_action := 'conflict'; END IF;
      IF v_reason IS NOT NULL THEN
        v_action := 'conflict';
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object('table_key',v_key,'source_id',v_id,'reason',v_reason));
      END IF;
      v_records := v_records || jsonb_build_array(jsonb_build_object('table_key',v_key,'source_id',v_id,'action',v_action));
    END LOOP;
  END LOOP;
  v_plan := jsonb_build_object('scope','shared-settings','full_site_complete',false,'can_apply',jsonb_array_length(v_conflicts)=0,
    'admins',v_admins,'conflicts',v_conflicts,'records',v_records,'admin_map',v_admin_map);
  RETURN v_plan || jsonb_build_object('plan_hash',encode(extensions.digest(convert_to(v_plan::text,'UTF8'),'sha256'),'hex'));
END;
$$;

CREATE FUNCTION public.get_employee_import_shared_dry_run(p_admin_session_token uuid, p_job_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_plan jsonb;
BEGIN
  v_job := private.employee_transfer_shared_import_job(p_admin_session_token,p_job_token);
  IF COALESCE((v_job.summary->>'shared_applied')::boolean,false) THEN RAISE EXCEPTION 'The shared import has already been applied.'; END IF;
  v_plan := private.employee_transfer_shared_import_plan(v_job,private.employee_transfer_shared_import_data(v_job));
  UPDATE private.employee_transfer_jobs SET summary = COALESCE(summary,'{}'::jsonb) || jsonb_build_object('shared_plan_hash',v_plan->'plan_hash') WHERE id = v_job.id;
  RETURN v_plan - ARRAY['records','admin_map'];
END;
$$;

CREATE FUNCTION private.employee_transfer_assert_shared_insert_triggers()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
DECLARE v_count integer; v_invalid boolean;
BEGIN
  WITH expected(table_name,trigger_name,definition,function_hash) AS (VALUES
    ('admin_configs','guard_content_audit_public_media_reference',
      'CREATE TRIGGER guard_content_audit_public_media_reference BEFORE INSERT OR UPDATE ON public.admin_configs FOR EACH ROW EXECUTE FUNCTION guard_content_audit_public_media_reference()',
      '2bbad610ca87b9e02c2f9cf7b45429b5c3469ea8ff9a1b661666a372a6a28ea5'),
    ('system_configs','guard_content_audit_public_media_reference',
      'CREATE TRIGGER guard_content_audit_public_media_reference BEFORE INSERT OR UPDATE ON public.system_configs FOR EACH ROW EXECUTE FUNCTION guard_content_audit_public_media_reference()',
      '2bbad610ca87b9e02c2f9cf7b45429b5c3469ea8ff9a1b661666a372a6a28ea5'),
    ('admin_configs','guard_employee_chat_image_reference',
      'CREATE TRIGGER guard_employee_chat_image_reference BEFORE INSERT OR UPDATE OF icon_custom_url, config_value ON public.admin_configs FOR EACH ROW EXECUTE FUNCTION guard_employee_chat_image_reference()',
      'ef9a064740ce2f154afba63c2b6830ac3e249e7bff66460000d796c0064736a0'),
    ('system_configs','guard_employee_chat_image_reference',
      'CREATE TRIGGER guard_employee_chat_image_reference BEFORE INSERT OR UPDATE OF value ON public.system_configs FOR EACH ROW EXECUTE FUNCTION guard_employee_chat_image_reference()',
      'ef9a064740ce2f154afba63c2b6830ac3e249e7bff66460000d796c0064736a0')
  )
  SELECT count(*)::integer,COALESCE(bool_or(expected.trigger_name IS NULL OR trigger.tgenabled NOT IN ('O','A')
    OR pg_get_triggerdef(trigger.oid) IS DISTINCT FROM expected.definition OR pg_get_userbyid(procedure.proowner) <> 'postgres'
    OR NOT procedure.prosecdef OR namespace.nspname <> 'private' OR procedure.proname <> trigger.tgname
    OR encode(extensions.digest(convert_to(pg_get_functiondef(procedure.oid),'UTF8'),'sha256'),'hex') IS DISTINCT FROM expected.function_hash),false)
  INTO v_count,v_invalid
  FROM pg_trigger AS trigger JOIN pg_class AS relation ON relation.oid=trigger.tgrelid
    JOIN pg_proc AS procedure ON procedure.oid=trigger.tgfoid JOIN pg_namespace AS namespace ON namespace.oid=procedure.pronamespace
    LEFT JOIN expected ON expected.table_name=relation.relname AND expected.trigger_name=trigger.tgname
  WHERE relation.relnamespace='public'::regnamespace AND relation.relname=ANY(private.employee_transfer_shared_keys())
    AND NOT trigger.tgisinternal AND (trigger.tgtype::integer & 4)<>0;
  IF v_count <> 4 OR v_invalid THEN RAISE EXCEPTION 'An unreviewed INSERT trigger prevents shared import.'; END IF;
END;
$$;

CREATE FUNCTION public.employee_import_shared_apply(p_admin_session_token uuid,p_job_token uuid,p_plan_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' SET lock_timeout = '2s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE; v_data jsonb; v_plan jsonb; v_map jsonb; v_row jsonb; v_item jsonb;
  v_key text; v_receipt jsonb; v_parent uuid;
BEGIN
  v_job := private.employee_transfer_shared_import_job(p_admin_session_token,p_job_token);
  IF COALESCE((v_job.summary->>'shared_applied')::boolean,false) THEN
    IF p_plan_hash IS DISTINCT FROM v_job.summary->>'shared_plan_hash' THEN RAISE EXCEPTION 'Shared import plan confirmation does not match.'; END IF;
    RETURN v_job.summary->'shared_receipt' || '{"repeated":true}'::jsonb;
  END IF;
  IF p_plan_hash IS NULL OR p_plan_hash IS DISTINCT FROM v_job.summary->>'shared_plan_hash' THEN
    RAISE EXCEPTION 'A matching shared import dry run must be confirmed first.';
  END IF;
  LOCK TABLE public.admins,public.financial_admin_credentials,public.admin_groups,public.admin_group_members,
    public.admin_configs,public.system_configs,public.history_cleanup_config,public.users IN SHARE ROW EXCLUSIVE MODE;
  PERFORM private.employee_transfer_assert_shared_insert_triggers();
  v_data := private.employee_transfer_shared_import_data(v_job);
  v_plan := private.employee_transfer_shared_import_plan(v_job,v_data);
  IF v_plan->>'plan_hash' IS DISTINCT FROM p_plan_hash THEN RAISE EXCEPTION 'The target changed after the shared import dry run.'; END IF;
  IF NOT (v_plan->>'can_apply')::boolean THEN RAISE EXCEPTION 'Shared import conflicts must be resolved before applying.'; END IF;
  v_map := v_plan->'admin_map';
  FOR v_row IN WITH RECURSIVE hierarchy AS (
    SELECT value AS row, 0 AS depth FROM jsonb_array_elements(v_data->'admins') WHERE value->>'role' <> 'super_admin'
      AND (value->>'parent_id' IS NULL OR value->>'parent_id' IN (SELECT value->>'id' FROM jsonb_array_elements(v_data->'admins') WHERE value->>'role'='super_admin'))
    UNION ALL SELECT child.value,parent.depth+1 FROM jsonb_array_elements(v_data->'admins') AS child(value)
      JOIN hierarchy AS parent ON child.value->>'parent_id'=parent.row->>'id' WHERE child.value->>'role'<>'super_admin'
  ) SELECT row FROM hierarchy ORDER BY depth,row->>'id' LOOP
    v_parent := NULL;
    IF v_row->>'parent_id' IS NOT NULL THEN v_parent := (v_map->>(v_row->>'parent_id'))::uuid; END IF;
    INSERT INTO public.admins (id,username,password_hash,role,parent_id,is_active,is_pinned,created_at,updated_at)
    VALUES ((v_row->>'id')::uuid,v_row->>'username',v_row->>'password_hash',v_row->>'role',v_parent,false,
      (v_row->>'is_pinned')::boolean,(v_row->>'created_at')::timestamptz,(v_row->>'updated_at')::timestamptz);
  END LOOP;
  INSERT INTO public.financial_admin_credentials (admin_id,password_hash,created_at,updated_at)
    SELECT (value->>'admin_id')::uuid,value->>'password_hash',(value->>'created_at')::timestamptz,(value->>'updated_at')::timestamptz
    FROM jsonb_array_elements(v_data->'financial_admin_credentials');
  FOR v_key IN SELECT unnest(ARRAY['admin_groups','admin_group_members','admin_configs','system_configs']) LOOP
    FOR v_row IN SELECT value FROM jsonb_array_elements(v_data->v_key) LOOP
      SELECT value INTO v_item FROM jsonb_array_elements(v_plan->'records') WHERE value->>'table_key'=v_key
        AND value->>'source_id'=COALESCE(v_row->>'id',v_row->>'key');
      IF v_item->>'action'='reuse' THEN CONTINUE; END IF;
      CASE v_key
        WHEN 'admin_groups' THEN
          INSERT INTO public.admin_groups (id,name,created_by,created_at,updated_at) VALUES ((v_row->>'id')::uuid,v_row->>'name',
            (v_map->>(v_row->>'created_by'))::uuid,(v_row->>'created_at')::timestamptz,(v_row->>'updated_at')::timestamptz);
        WHEN 'admin_group_members' THEN
          INSERT INTO public.admin_group_members (id,group_id,admin_id,created_at) VALUES ((v_row->>'id')::uuid,(v_row->>'group_id')::uuid,
            (v_map->>(v_row->>'admin_id'))::uuid,(v_row->>'created_at')::timestamptz);
        WHEN 'admin_configs' THEN
          INSERT INTO public.admin_configs (id,admin_id,config_type,config_value,icon_type,icon_custom_url,created_at,updated_at)
          VALUES ((v_row->>'id')::uuid,(v_map->>(v_row->>'admin_id'))::uuid,v_row->>'config_type',v_row->>'config_value',
            v_row->>'icon_type',v_row->>'icon_custom_url',(v_row->>'created_at')::timestamptz,(v_row->>'updated_at')::timestamptz);
        WHEN 'system_configs' THEN INSERT INTO public.system_configs (key,value) VALUES (v_row->>'key',v_row->'value');
      END CASE;
    END LOOP;
  END LOOP;
  v_receipt := jsonb_build_object('success',true,'scope','shared-settings','full_site_complete',false,'repeated',false,
    'created_admins',(SELECT count(*) FROM jsonb_array_elements(v_data->'admins') WHERE value->>'role'<>'super_admin'),
    'created_records',(SELECT count(*) FROM jsonb_array_elements(v_plan->'records') WHERE value->>'action'='create'),'admin_map',v_map);
  UPDATE private.employee_transfer_jobs SET admin_map=v_map,default_admin_id=v_job.admin_id,
    summary=COALESCE(summary,'{}'::jsonb) || jsonb_build_object('shared_applied',true,'shared_receipt',v_receipt) WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import','shared_applied',
    jsonb_build_object('created_admins',v_receipt->'created_admins','created_records',v_receipt->'created_records','full_site_complete',false));
  RETURN v_receipt;
EXCEPTION WHEN unique_violation OR foreign_key_violation OR check_violation OR not_null_violation OR data_exception THEN
  RAISE EXCEPTION 'Shared import was rolled back by a target constraint or data validation failure.' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.employee_import_begin(
  p_admin_session_token uuid,p_admin_password text,p_decisions jsonb,p_summary jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,private,pg_temp SET statement_timeout='120s' AS $$
DECLARE
  v_admin_map jsonb:=COALESCE(p_decisions->'admin_map','{}'::jsonb);
  v_group_map jsonb:=COALESCE(p_decisions->'group_map','{}'::jsonb);
  v_default_admin uuid:=NULLIF(p_decisions->>'default_admin_id','')::uuid;
  v_site uuid; v_result jsonb; v_job_id uuid; v_product uuid;
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  IF p_summary ?| ARRAY['import_protocol','export_protocol','catalog','package_id'] THEN
    RAISE EXCEPTION 'Reserved transfer protocol fields require the dedicated task initializer.';
  END IF;
  SELECT site_id INTO v_site FROM private.employee_transfer_site;
  IF NULLIF(p_summary->>'source_site_id','')::uuid IS NOT DISTINCT FROM v_site THEN
    RAISE EXCEPTION 'The export file was created by this same site and cannot be imported into it.';
  END IF;
  PERFORM private.employee_transfer_assert_triggers_reviewed();
  IF v_default_admin IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.admins WHERE id=v_default_admin AND is_active) THEN
    RAISE EXCEPTION 'The default administrator does not exist on this site.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(v_admin_map) AS entry(old_id,new_id) WHERE NULLIF(entry.new_id,'') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.admins WHERE id=entry.new_id::uuid AND is_active)) THEN
    RAISE EXCEPTION 'An administrator mapping points to an administrator that does not exist on this site.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(v_group_map) AS entry(old_id,new_id) WHERE NULLIF(entry.new_id,'') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.dispatch_groups WHERE id=entry.new_id::uuid AND archived_at IS NULL)) THEN
    RAISE EXCEPTION 'A dispatch group mapping points to a group that does not exist on this site.';
  END IF;
  v_result:=private.employee_transfer_start_job(p_admin_session_token,p_admin_password,'import',COALESCE(p_summary,'{}'::jsonb),v_admin_map,v_group_map,v_default_admin);
  IF NOT COALESCE((v_result->>'success')::boolean,false) THEN RETURN v_result; END IF;
  v_job_id:=(v_result->>'job_id')::uuid;
  SELECT id INTO v_product FROM public.product_types WHERE name='舊站匯入（精簡訂單）';
  IF v_product IS NULL THEN
    INSERT INTO public.product_types (name,is_active) VALUES ('舊站匯入（精簡訂單）',false) RETURNING id INTO v_product;
  ELSIF EXISTS (SELECT 1 FROM public.product_types WHERE id=v_product AND is_active) THEN
    RAISE EXCEPTION 'The placeholder product for imported orders must stay disabled.';
  END IF;
  UPDATE private.employee_transfer_jobs SET placeholder_product_id=v_product WHERE id=v_job_id;
  RETURN v_result || jsonb_build_object('placeholder_product_id',v_product);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_exact_object(jsonb,text[]) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_unique_json(json,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_check_shared_catalog(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_import_job(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_import_data(private.employee_transfer_jobs) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_import_row(text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_check_shared_input(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_import_plan(private.employee_transfer_jobs,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_assert_shared_insert_triggers() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.employee_import_shared_begin(uuid,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.employee_import_shared_stage(uuid,uuid,text,integer,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_employee_import_shared_dry_run(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.employee_import_shared_apply(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_shared_begin(uuid,text,uuid,jsonb) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_shared_stage(uuid,uuid,text,integer,text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_import_shared_dry_run(uuid,uuid) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_shared_apply(uuid,uuid,text) TO anon,authenticated;
NOTIFY pgrst,'reload schema';
