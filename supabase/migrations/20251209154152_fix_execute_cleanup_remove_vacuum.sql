/*
  # 修复清理函数 - 移除 VACUUM 命令

  ## 问题
  - VACUUM 不能在函数内执行（PostgreSQL 限制）
  - 导致所有清理操作失败

  ## 解决方案
  1. 移除 VACUUM 和 REINDEX 命令
  2. 改用表大小计算估算空间释放
  3. 建议管理员定期手动执行 VACUUM

  ## 安全性
  - 保持 SECURITY DEFINER 权限
  - 所有验证逻辑保持不变
*/

-- 修复 execute_cleanup 函数
CREATE OR REPLACE FUNCTION execute_cleanup(
  p_table_name text,
  p_days_to_keep integer,
  p_admin_id uuid DEFAULT NULL
)
RETURNS TABLE (
  success boolean,
  records_deleted bigint,
  space_freed text,
  execution_time_ms numeric,
  message text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start_time timestamp;
  v_deleted bigint := 0;
  v_cutoff timestamptz;
  v_size_before bigint;
  v_size_after bigint;
  v_total_before bigint;
  v_delete_percentage numeric;
  v_config record;
  v_estimated_space bigint;
BEGIN
  v_start_time := clock_timestamp();

  -- Validate table exists in cleanup config and cleanup is allowed
  SELECT * INTO v_config
  FROM history_cleanup_config
  WHERE history_cleanup_config.table_name = p_table_name
    AND can_cleanup = true;

  IF NOT FOUND THEN
    RETURN QUERY SELECT
      false,
      0::bigint,
      '0 bytes',
      0::numeric,
      'Table not found or cleanup not allowed'::text;
    RETURN;
  END IF;

  -- Validate retention period
  IF p_days_to_keep < 0 THEN
    RETURN QUERY SELECT
      false,
      0::bigint,
      '0 bytes',
      0::numeric,
      'Retention days must be 0 or greater'::text;
    RETURN;
  END IF;

  -- Calculate cutoff date
  v_cutoff := NOW() - (p_days_to_keep || ' days')::interval;

  -- Get size and count before cleanup
  EXECUTE format('SELECT pg_total_relation_size(%L)', p_table_name) INTO v_size_before;
  EXECUTE format('SELECT COUNT(*) FROM %I', p_table_name) INTO v_total_before;

  -- Execute cleanup based on table
  CASE p_table_name
    WHEN 'dispatch_assignments' THEN
      DELETE FROM dispatch_assignments WHERE assigned_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'dispatch_sessions' THEN
      DELETE FROM dispatch_sessions WHERE started_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'work_sessions' THEN
      DELETE FROM work_sessions WHERE start_time < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'customer_service_sessions' THEN
      DELETE FROM customer_service_sessions WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'used_order_data' THEN
      DELETE FROM used_order_data WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'valid_data_audit_log' THEN
      DELETE FROM valid_data_audit_log WHERE action_timestamp < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'valid_data_error_log' THEN
      DELETE FROM valid_data_error_log
      WHERE detected_at < v_cutoff AND resolved_at IS NOT NULL;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'dispatch_system_logs' THEN
      DELETE FROM dispatch_system_logs WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'commission_audit_log' THEN
      DELETE FROM commission_audit_log WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'money_data_protection_audit' THEN
      DELETE FROM money_data_protection_audit WHERE attempted_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'dispatch_performance_metrics' THEN
      DELETE FROM dispatch_performance_metrics WHERE measured_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'valid_data_query_performance' THEN
      DELETE FROM valid_data_query_performance WHERE recorded_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'orders_history' THEN
      DELETE FROM orders_history WHERE archived_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'valid_order_data_archive' THEN
      DELETE FROM valid_order_data_archive WHERE archived_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    WHEN 'bulk_import_log' THEN
      DELETE FROM bulk_import_log
      WHERE completed_at < v_cutoff AND status IN ('completed', 'failed');
      GET DIAGNOSTICS v_deleted = ROW_COUNT;

    ELSE
      RAISE EXCEPTION 'Cleanup not implemented for table %', p_table_name;
  END CASE;

  -- Calculate deletion percentage
  IF v_total_before > 0 THEN
    v_delete_percentage := (v_deleted::numeric / v_total_before::numeric) * 100;
  ELSE
    v_delete_percentage := 0;
  END IF;

  -- Get size after cleanup (immediate check, no VACUUM)
  EXECUTE format('SELECT pg_total_relation_size(%L)', p_table_name) INTO v_size_after;

  -- Estimate space that will be freed after VACUUM
  -- Note: Space is not immediately reclaimed until VACUUM is run
  v_estimated_space := v_size_before - v_size_after;

  -- Log the cleanup (only if admin_id provided, for scheduled tasks it's NULL)
  IF p_admin_id IS NOT NULL THEN
    INSERT INTO history_cleanup_log (
      table_name,
      admin_id,
      records_deleted,
      space_freed,
      retention_days,
      status,
      message
    ) VALUES (
      p_table_name,
      p_admin_id,
      v_deleted,
      pg_size_pretty(GREATEST(v_estimated_space, 0)),
      p_days_to_keep,
      'completed',
      format('Deleted %s records (%.1f%%). Run VACUUM to reclaim disk space.',
        v_deleted,
        v_delete_percentage
      )
    );
  END IF;

  -- Update config
  UPDATE history_cleanup_config
  SET
    last_cleanup_at = NOW(),
    last_cleanup_records = v_deleted,
    updated_at = NOW()
  WHERE history_cleanup_config.table_name = p_table_name;

  -- Return result
  RETURN QUERY SELECT
    true,
    v_deleted,
    pg_size_pretty(GREATEST(v_estimated_space, 0)),
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    format('Successfully deleted %s records (%.1f%%). Space will be reclaimed after next VACUUM.',
      v_deleted,
      v_delete_percentage
    )::text;
END;
$$;

COMMENT ON FUNCTION execute_cleanup IS 'Execute cleanup without VACUUM (must be run separately by admin)';

-- 更新自动清理函数
CREATE OR REPLACE FUNCTION auto_cleanup_all_tables()
RETURNS TABLE (
  table_name text,
  records_deleted bigint,
  space_freed text,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_config record;
  v_result record;
BEGIN
  -- Loop through all enabled cleanup configurations
  FOR v_config IN
    SELECT
      hcc.table_name,
      hcc.retention_days,
      hcc.auto_cleanup_enabled,
      hcc.cleanup_schedule
    FROM history_cleanup_config hcc
    WHERE hcc.can_cleanup = true
      AND hcc.auto_cleanup_enabled = true
    ORDER BY hcc.table_name
  LOOP
    BEGIN
      -- Execute cleanup for this table
      SELECT * INTO v_result
      FROM execute_cleanup(
        v_config.table_name,
        v_config.retention_days,
        NULL  -- NULL admin_id for scheduled cleanup
      );

      -- Return results
      RETURN QUERY SELECT
        v_config.table_name,
        v_result.records_deleted,
        v_result.space_freed,
        CASE
          WHEN v_result.success THEN 'Success'
          ELSE 'Failed'
        END::text;

    EXCEPTION WHEN OTHERS THEN
      -- Log error and continue with next table
      RETURN QUERY SELECT
        v_config.table_name,
        0::bigint,
        '0 bytes'::text,
        ('Error: ' || SQLERRM)::text;
    END;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION auto_cleanup_all_tables IS 'Automatically cleanup all tables with auto_cleanup_enabled = true';
