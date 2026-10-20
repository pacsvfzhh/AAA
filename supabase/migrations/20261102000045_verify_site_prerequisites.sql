BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- SQL11 pins only guarded_tables/guard_write/lock_maintenance_tables/
-- allow_config_write/clear_write_permit. Neither apply below is pinned.
-- Preserve the original bodies, backup gates, trigger audits and receipts.
ALTER FUNCTION public.employee_import_shared_replace_apply(uuid,uuid,text) SET SCHEMA private;
ALTER FUNCTION private.employee_import_shared_replace_apply(uuid,uuid,text)
  RENAME TO employee_import_shared_replace_apply_base;
ALTER FUNCTION public.employee_import_products_apply(uuid,uuid,text) SET SCHEMA private;
ALTER FUNCTION private.employee_import_products_apply(uuid,uuid,text)
  RENAME TO employee_import_products_apply_base;

-- Called AFTER the base apply's writes, in the same transaction while its table
-- locks are still held. Only the digest is persisted, never another plaintext copy.
CREATE FUNCTION private.employee_transfer_site_prerequisite_checkpoint(
  p_job private.employee_transfer_jobs, p_type text
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' AS $$
DECLARE v_hash text; v_map jsonb; v_rows jsonb; v_count integer; v_distinct integer;
BEGIN
  IF p_job.options#>>'{catalog,site_id}' IS NULL OR p_job.options->>'package_id' IS NULL THEN
    RAISE EXCEPTION 'Site prerequisite source identity is missing.';
  END IF;
  IF p_type='shared-settings' THEN
    IF p_job.summary#>'{shared_receipt,admin_map}' IS DISTINCT FROM p_job.admin_map
      OR jsonb_typeof(p_job.admin_map) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Site prerequisite administrator mapping changed.';
    END IF;
    v_hash:=encode(extensions.digest(convert_to(private.employee_transfer_shared_capture()::text,'UTF8'),'sha256'),'hex');
  ELSIF p_type='product-catalog' THEN
    PERFORM private.employee_transfer_product_schema();
    v_map:=p_job.summary#>'{products_receipt,product_map}';
    IF jsonb_typeof(v_map) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Site prerequisite product mapping is missing or invalid.';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_each(v_map) AS m WHERE jsonb_typeof(m.value) IS DISTINCT FROM 'string'
      OR m.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      OR (m.value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
      RAISE EXCEPTION 'Site prerequisite product mapping is missing or invalid.';
    END IF;
    SELECT count(*)::integer,count(DISTINCT value)::integer INTO v_count,v_distinct FROM jsonb_each_text(v_map);
    IF v_count<>v_distinct OR v_count IS DISTINCT FROM (p_job.options#>>'{catalog,tables,0,rows}')::integer THEN
      RAISE EXCEPTION 'Site prerequisite product mapping count changed.';
    END IF;
    -- Source-keyed object binds the server map too (including a source/target swap).
    -- Each value is exactly the six real target columns, ordered by source UUID.
    -- Unmapped target-only/identity placeholder products are deliberately absent.
    SELECT COALESCE(jsonb_object_agg(m.key,jsonb_build_object('id',p.id,'name',p.name,
      'is_active',p.is_active,'sort_order',p.sort_order,'created_at',p.created_at,'updated_at',p.updated_at)
      ORDER BY m.key COLLATE "C"),'{}'::jsonb),count(*)::integer INTO v_rows,v_distinct
      FROM jsonb_each_text(v_map) AS m JOIN public.product_types AS p ON p.id=m.value::uuid;
    IF v_distinct<>v_count THEN RAISE EXCEPTION 'Site prerequisite mapped products are missing.'; END IF;
    v_hash:=encode(extensions.digest(convert_to(v_rows::text,'UTF8'),'sha256'),'hex');
  ELSE
    RAISE EXCEPTION 'Unsupported site prerequisite type.';
  END IF;
  RETURN jsonb_build_object('protocol','site-prerequisites-v1','source_site_id',p_job.options#>'{catalog,site_id}',
    'package_id',p_job.options->'package_id','type',p_type,'hash',v_hash);
END;
$$;

CREATE FUNCTION public.employee_import_shared_replace_apply(
  p_admin_session_token uuid,p_job_token uuid,p_plan_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' SET lock_timeout = '2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_receipt jsonb; v_checkpoint jsonb; v_applied boolean;
BEGIN
  v_job:=private.employee_transfer_shared_replace_job(p_admin_session_token,p_job_token);
  v_applied:=COALESCE((v_job.summary->>'shared_applied')::boolean,false);
  IF v_applied AND NOT (v_job.summary ? 'site_prerequisite_checkpoint') THEN
    RAISE EXCEPTION 'Historical shared apply has no site prerequisite checkpoint; restart the import, not a backfill.';
  END IF;
  IF NOT v_applied AND v_job.summary ? 'site_prerequisite_checkpoint' THEN
    RAISE EXCEPTION 'Site prerequisite checkpoint already exists before shared apply.';
  END IF;
  v_receipt:=private.employee_import_shared_replace_apply_base(p_admin_session_token,p_job_token,p_plan_hash);
  IF v_receipt->'success'='true'::jsonb THEN
    SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE id=v_job.id;
    v_checkpoint:=private.employee_transfer_site_prerequisite_checkpoint(v_job,'shared-settings');
    IF v_applied THEN
      IF v_job.summary->'site_prerequisite_checkpoint' IS DISTINCT FROM v_checkpoint THEN
        RAISE EXCEPTION 'Shared site prerequisite checkpoint drift; repeat apply cannot refresh it.';
      END IF;
    ELSE
      UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('site_prerequisite_checkpoint',v_checkpoint)
        WHERE id=v_job.id;
    END IF;
  END IF;
  RETURN v_receipt;
END;
$$;

CREATE FUNCTION public.employee_import_products_apply(
  p_admin_session_token uuid,p_job_token uuid,p_plan_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' SET lock_timeout = '2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_receipt jsonb; v_checkpoint jsonb; v_applied boolean;
BEGIN
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'products-import');
  v_applied:=COALESCE((v_job.summary->>'products_applied')::boolean,false);
  IF v_applied AND NOT (v_job.summary ? 'site_prerequisite_checkpoint') THEN
    RAISE EXCEPTION 'Historical product apply has no site prerequisite checkpoint; restart the import, not a backfill.';
  END IF;
  IF NOT v_applied AND v_job.summary ? 'site_prerequisite_checkpoint' THEN
    RAISE EXCEPTION 'Site prerequisite checkpoint already exists before product apply.';
  END IF;
  v_receipt:=private.employee_import_products_apply_base(p_admin_session_token,p_job_token,p_plan_hash);
  IF v_receipt->'success'='true'::jsonb THEN
    SELECT * INTO v_job FROM private.employee_transfer_jobs WHERE id=v_job.id;
    v_checkpoint:=private.employee_transfer_site_prerequisite_checkpoint(v_job,'product-catalog');
    IF v_applied THEN
      IF v_job.summary->'site_prerequisite_checkpoint' IS DISTINCT FROM v_checkpoint THEN
        RAISE EXCEPTION 'Product site prerequisite checkpoint drift; repeat apply cannot refresh it.';
      END IF;
    ELSE
      UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('site_prerequisite_checkpoint',v_checkpoint)
        WHERE id=v_job.id;
    END IF;
  END IF;
  RETURN v_receipt;
END;
$$;

CREATE FUNCTION public.employee_import_site_verify_prerequisites(
  p_admin_session_token uuid,p_job_token uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET timezone = 'UTC' SET datestyle = 'ISO, YMD' SET lock_timeout = '2s' AS $$
DECLARE v_job private.employee_transfer_jobs%ROWTYPE; v_prior private.employee_transfer_jobs%ROWTYPE;
  v_type text; v_protocol text; v_flag text; v_count integer; v_checkpoint jsonb;
  v_receipt constant jsonb := '{"success":true,"scope":"site-prerequisites","verified":true,"maintenance":true,"full_site_complete":false}';
BEGIN
  -- Hold maintenance against enter/leave. No business write permit is issued.
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'Site prerequisite verification requires read committed isolation.';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('employee-transfer-maintenance',0));
  v_job:=private.employee_transfer_job(p_admin_session_token,p_job_token,'dispatch-import');
  PERFORM private.employee_transfer_assert_maintenance_guards();
  PERFORM 1 FROM private.employee_transfer_maintenance AS m
    WHERE m.singleton AND m.job_id=v_job.id AND m.admin_id=v_job.admin_id
      AND m.plan_hash=v_job.summary->>'dispatch_plan_hash'
      AND EXISTS(SELECT 1 FROM private.employee_transfer_shared_backups AS b WHERE b.id=v_job.id
        AND b.admin_id=v_job.admin_id AND b.plan_hash=m.plan_hash AND b.target_hash=m.target_hash
        AND b.sealed_at IS NOT NULL AND b.sealed_sha256 IS NOT NULL AND b.catalog->>'scope'='dispatch-submission')
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Site prerequisite verification requires matching dispatch maintenance.'; END IF;
  IF v_job.options->>'package_id' IS NULL OR v_job.options#>>'{catalog,site_id}' IS NULL THEN
    RAISE EXCEPTION 'Site prerequisite source identity is missing.';
  END IF;
  FOREACH v_type IN ARRAY ARRAY['shared-settings','product-catalog'] LOOP
    v_protocol:=CASE v_type WHEN 'shared-settings' THEN 'shared-import-v1' ELSE 'products-v1' END;
    v_flag:=CASE v_type WHEN 'shared-settings' THEN 'shared_applied' ELSE 'products_applied' END;
    -- Count jobs, not DISTINCT hashes: two matching applies are ambiguous even if
    -- their checkpoints are identical. Finished jobs keep their server summary.
    SELECT count(*)::integer INTO v_count FROM private.employee_transfer_jobs AS j
      WHERE j.kind='import' AND j.admin_id=v_job.admin_id AND j.options->>'import_protocol'=v_protocol
        AND (v_type<>'shared-settings' OR j.options->>'replace_policy'='source-v1')
        AND j.options->'package_id'=v_job.options->'package_id'
        AND j.options#>'{catalog,site_id}'=v_job.options#>'{catalog,site_id}' AND j.summary->v_flag='true'::jsonb;
    IF v_count<>1 THEN RAISE EXCEPTION 'A unique applied same-package site prerequisite is required (%).',v_type; END IF;
    SELECT * INTO v_prior FROM private.employee_transfer_jobs AS j
      WHERE j.kind='import' AND j.admin_id=v_job.admin_id AND j.options->>'import_protocol'=v_protocol
        AND (v_type<>'shared-settings' OR j.options->>'replace_policy'='source-v1')
        AND j.options->'package_id'=v_job.options->'package_id'
        AND j.options#>'{catalog,site_id}'=v_job.options#>'{catalog,site_id}' AND j.summary->v_flag='true'::jsonb
      FOR SHARE;
    v_checkpoint:=v_prior.summary->'site_prerequisite_checkpoint';
    IF v_checkpoint IS NULL THEN RAISE EXCEPTION 'Site prerequisite checkpoint is missing (%).',v_type; END IF;
    IF v_checkpoint IS DISTINCT FROM private.employee_transfer_site_prerequisite_checkpoint(v_prior,v_type) THEN
      RAISE EXCEPTION 'Site prerequisite checkpoint drift (%).',v_type;
    END IF;
  END LOOP;
  UPDATE private.employee_transfer_jobs SET summary=summary||jsonb_build_object('site_prerequisites_verified',v_receipt)
    WHERE id=v_job.id;
  PERFORM private.employee_transfer_log(v_job.id,v_job.admin_id,v_job.admin_username,'import',
    'site_prerequisites_verified',v_receipt);
  RETURN v_receipt;
END;
$$;

REVOKE ALL ON FUNCTION private.employee_import_shared_replace_apply_base(uuid,uuid,text),
  private.employee_import_products_apply_base(uuid,uuid,text),
  private.employee_transfer_site_prerequisite_checkpoint(private.employee_transfer_jobs,text)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.employee_import_shared_replace_apply(uuid,uuid,text),
  public.employee_import_products_apply(uuid,uuid,text),public.employee_import_site_verify_prerequisites(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.employee_import_shared_replace_apply(uuid,uuid,text),
  public.employee_import_products_apply(uuid,uuid,text),public.employee_import_site_verify_prerequisites(uuid,uuid)
  TO anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
