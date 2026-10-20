BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- One statement's MVCC baseline for a serial export coordinator. Comparing this
-- fingerprint before/after the stages detects catalog drift; it does NOT freeze
-- later exports, capture Storage bytes, or certify an atomic full-site backup.
CREATE FUNCTION public.get_employee_export_site_snapshot(p_admin_session_token uuid, p_package_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' AS $$
DECLARE
  v_site uuid;
  v_key text;
  v_capture jsonb;
  v_snapshot jsonb;
  v_tables jsonb := '[]'::jsonb;
  v_excluded jsonb;
  v_shared jsonb;
  v_catalogs jsonb;
  v_device jsonb;
BEGIN
  PERFORM private.employee_transfer_admin(p_admin_session_token);
  IF p_package_id IS NULL THEN RAISE EXCEPTION 'A site export package id is required.'; END IF;
  SELECT site_id INTO v_site FROM private.employee_transfer_site;
  FOR v_device IN SELECT h.device_info FROM public.employee_login_history h
    JOIN public.users u ON u.id=h.user_id WHERE u.archived_at IS NULL LOOP
    PERFORM private.employee_transfer_replacement_device_check(v_device);
  END LOOP;

  -- Exactly SQL05's seven-table catalog, never the captured rows or credentials.
  v_capture := private.employee_transfer_shared_capture();
  FOREACH v_key IN ARRAY private.employee_transfer_shared_keys() LOOP
    v_snapshot := v_capture->v_key;
    v_tables := v_tables || jsonb_build_array(jsonb_build_object('key', v_key,
      'rows', v_snapshot->'count', 'bytes', v_snapshot->'bytes', 'sha256', v_snapshot->'sha256'));
  END LOOP;
  SELECT COALESCE(jsonb_agg(item.key ORDER BY item.key COLLATE "C"), '[]'::jsonb) INTO v_excluded
    FROM public.system_configs AS item WHERE item.key IN ('ios_config', 'auto_cleanup_schedule', 'auto_cleanup_history');
  v_shared := jsonb_build_object('version', 1, 'scope', 'shared-settings', 'site_id', v_site,
    'tables', v_tables, 'excluded_system_keys', v_excluded, 'full_site_complete', false);

  -- All existing STABLE catalogs (including nested identity/finance) inherit the
  -- caller's same MVCC snapshot. Keep their validation/limits/NULL semantics.
  -- In particular SQL33 MUST reject previously imported archive namespaces;
  -- never catch that error, omit archives, or replace it with an empty catalog.
  v_catalogs := jsonb_build_object(
    'shared', v_shared,
    'products', private.employee_transfer_product_catalog(private.employee_transfer_product_snapshot()),
    'dispatch', private.employee_transfer_dispatch_catalog(),
    'identity', private.employee_transfer_identity_catalog(p_package_id),
    'finance', private.employee_transfer_finance_catalog(p_package_id),
    'activity', private.employee_transfer_activity_catalog(p_package_id),
    'verification', private.employee_transfer_verification_catalog(p_package_id),
    'notifications', private.employee_transfer_notifications_catalog(p_package_id),
    'chat', private.employee_transfer_chat_catalog(p_package_id),
    'archives', private.employee_transfer_archives_catalog(p_package_id));
  RETURN jsonb_build_object('version', 1, 'protocol', 'site-bundle-set-v1',
    'site_id', v_site, 'package_id', p_package_id, 'catalogs', v_catalogs,
    'sha256', encode(extensions.digest(convert_to(v_catalogs::text, 'UTF8'), 'sha256'), 'hex'),
    'full_site_complete', false, 'import_ready', false);
END;
$$;

REVOKE ALL ON FUNCTION public.get_employee_export_site_snapshot(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_export_site_snapshot(uuid, uuid) TO anon, authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
