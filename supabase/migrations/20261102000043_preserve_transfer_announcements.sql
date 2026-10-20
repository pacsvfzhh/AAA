BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- SQL05 still defines these three helpers. SQL06 validates imported rows with
-- shared_setting_valid before either SQL06 create-only or SQL07 replacement can
-- write; SQL07 backup/target hashes and SQL41 catalogs use shared_rows through
-- shared_capture. Keep those callers, their catalogs and administrator rules.
-- Announcements/categories/media are not shared domains. The carousel settings
-- are known local-only keys: neither validate their values on export nor carry
-- them in snapshots. An old package containing either key must fail row
-- validation, not be filtered or have its bound catalog/hashes rewritten.
CREATE OR REPLACE FUNCTION private.employee_transfer_shared_setting_valid(p_key text, p_value jsonb)
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
    WHEN 'login_title', 'login_subtitle' THEN
      IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      RETURN nullif(btrim(p_value #>> '{}'), '') IS NOT NULL
        AND char_length(p_value #>> '{}') <= CASE p_key WHEN 'login_title' THEN 100 ELSE 200 END;
    ELSE RETURN false;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION private.employee_transfer_shared_validate()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.system_configs WHERE key NOT IN (
    'admin_navigation_preferences', 'announcement_carousel_enabled', 'announcement_carousel_speed',
    'login_title', 'login_subtitle', 'ios_config', 'auto_cleanup_schedule', 'auto_cleanup_history')) THEN
    RAISE EXCEPTION 'Unreviewed shared setting key; export blocked.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.system_configs WHERE key IN (
    'admin_navigation_preferences', 'login_title', 'login_subtitle')
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

CREATE OR REPLACE FUNCTION private.employee_transfer_shared_rows(p_table_key text)
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
      FROM public.system_configs AS item WHERE item.key IN ('admin_navigation_preferences', 'login_title', 'login_subtitle');
    WHEN 'history_cleanup_config' THEN
      RETURN QUERY SELECT item.table_name, jsonb_build_object('table_name', item.table_name, 'retention_days', item.retention_days,
        'auto_cleanup_enabled', item.auto_cleanup_enabled, 'schedule_time_utc', item.schedule_time_utc)
      FROM public.history_cleanup_config AS item;
    ELSE RAISE EXCEPTION 'Unsupported shared export table key.';
  END CASE;
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_shared_setting_valid(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_validate() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.employee_transfer_shared_rows(text) FROM PUBLIC, anon, authenticated;
COMMIT;
