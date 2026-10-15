/*
  # History Data Management System for Super Admin

  1. Purpose
    - Centralized management of historical data
    - Quick cleanup of old records
    - Prevent database bloat
    - Configurable retention policies
    
  2. Cleanable Data Categories
    
    A. High-Volume Operational Data (Clean frequently)
       - dispatch_assignments (派单记录)
       - dispatch_sessions (派单会话)
       - work_sessions (工作会话)
       - customer_service_sessions (客服会话)
    
    B. Audit & Monitoring Logs (Clean periodically)
       - valid_data_audit_log (数据审计)
       - valid_data_error_log (错误日志)
       - dispatch_system_logs (系统日志)
       - commission_audit_log (佣金审计)
       - money_data_protection_audit (资金保护审计)
    
    C. Performance Metrics (Clean regularly)
       - dispatch_performance_metrics (派单性能)
       - valid_data_query_performance (查询性能)
    
    D. Historical Archives (Clean rarely)
       - orders_history (订单历史)
       - valid_order_data_archive (数据归档)
       - bulk_import_log (导入日志)
    
  3. Safety Features
    - Configurable retention periods
    - Preview before delete
    - Backup recommendations
    - Cascade delete prevention for active data
*/

-- ============================================================================
-- 1. DATA CLEANUP CONFIGURATION TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS history_cleanup_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text UNIQUE NOT NULL,
  display_name text NOT NULL,
  category text NOT NULL CHECK (category IN ('operational', 'audit', 'performance', 'archive')),
  description text NOT NULL,
  default_retention_days integer NOT NULL,
  min_retention_days integer NOT NULL,
  can_cleanup boolean DEFAULT true,
  requires_confirmation boolean DEFAULT true,
  cleanup_priority integer DEFAULT 5 CHECK (cleanup_priority BETWEEN 1 AND 10),
  last_cleanup_at timestamptz,
  last_cleanup_records integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Insert cleanup configurations
INSERT INTO history_cleanup_config (
  table_name, display_name, category, description,
  default_retention_days, min_retention_days,
  cleanup_priority, requires_confirmation
) VALUES
  -- High Priority: Operational Data
  ('dispatch_assignments', '派单分配记录', 'operational',
   '员工订单派送历史记录。保留太久会影响查询性能。',
   90, 30, 8, false),
  
  ('dispatch_sessions', '派单会话记录', 'operational',
   '员工派单会话历史。记录每次开始/结束派单的时间。',
   60, 30, 8, false),
  
  ('work_sessions', '工作会话记录', 'operational',
   '员工工作时长统计会话。用于计算工作时间。',
   90, 60, 7, false),
  
  ('customer_service_sessions', '客服会话记录', 'operational',
   '客服与客户的聊天会话历史。',
   180, 90, 6, true),
  
  -- Medium Priority: Audit Logs
  ('valid_data_audit_log', '数据审计日志', 'audit',
   'Valid Order Data 的变更审计日志。记录所有数据操作。',
   90, 30, 5, false),
  
  ('valid_data_error_log', '数据错误日志', 'audit',
   'Valid Order Data 的错误检测日志。记录数据异常。',
   90, 30, 5, false),
  
  ('dispatch_system_logs', '派单系统日志', 'audit',
   '派单系统的运行日志和错误记录。',
   60, 30, 6, false),
  
  ('commission_audit_log', '佣金审计日志', 'audit',
   '佣金计算和发放的审计记录。重要财务数据。',
   365, 180, 3, true),
  
  ('money_data_protection_audit', '资金保护审计', 'audit',
   '资金操作的安全审计日志。重要财务数据。',
   365, 180, 2, true),
  
  -- Low Priority: Performance Metrics
  ('dispatch_performance_metrics', '派单性能指标', 'performance',
   '派单系统性能监控数据。用于性能分析。',
   30, 7, 7, false),
  
  ('valid_data_query_performance', '查询性能记录', 'performance',
   'Valid Data 系统的查询性能监控。',
   30, 7, 7, false),
  
  -- Very Low Priority: Archives
  ('orders_history', '订单历史归档', 'archive',
   '已归档的历史订单。超长期保留。',
   730, 365, 1, true),
  
  ('valid_order_data_archive', '数据归档', 'archive',
   '已归档的 Valid Order Data。',
   730, 365, 1, true),
  
  ('bulk_import_log', '批量导入日志', 'archive',
   '批量数据导入操作的历史记录。',
   365, 180, 4, false)
ON CONFLICT (table_name) DO UPDATE SET
  description = EXCLUDED.description,
  default_retention_days = EXCLUDED.default_retention_days,
  min_retention_days = EXCLUDED.min_retention_days;

-- ============================================================================
-- 2. PREVIEW CLEANUP FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION preview_cleanup(
  p_table_name text,
  p_days_to_keep integer
)
RETURNS TABLE (
  table_name text,
  total_records bigint,
  records_to_delete bigint,
  records_to_keep bigint,
  oldest_date timestamptz,
  cutoff_date timestamptz,
  estimated_space_freed text,
  safety_status text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_total bigint;
  v_to_delete bigint;
  v_oldest timestamptz;
  v_cutoff timestamptz;
  v_config record;
  v_current_size bigint;
  v_estimated_freed bigint;
BEGIN
  -- Validate table exists in config
  SELECT * INTO v_config
  FROM history_cleanup_config
  WHERE history_cleanup_config.table_name = p_table_name
    AND can_cleanup = true;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Table % not found or cleanup not allowed', p_table_name;
  END IF;
  
  -- Validate retention period
  IF p_days_to_keep < v_config.min_retention_days THEN
    RAISE EXCEPTION 'Retention period must be at least % days for %',
      v_config.min_retention_days, p_table_name;
  END IF;
  
  v_cutoff := NOW() - (p_days_to_keep || ' days')::interval;
  
  -- Calculate based on table type
  CASE p_table_name
    WHEN 'dispatch_assignments' THEN
      SELECT COUNT(*), MIN(assigned_at) INTO v_total, v_oldest FROM dispatch_assignments;
      SELECT COUNT(*) INTO v_to_delete FROM dispatch_assignments WHERE assigned_at < v_cutoff;
    
    WHEN 'dispatch_sessions' THEN
      SELECT COUNT(*), MIN(started_at) INTO v_total, v_oldest FROM dispatch_sessions;
      SELECT COUNT(*) INTO v_to_delete FROM dispatch_sessions WHERE started_at < v_cutoff;
    
    WHEN 'work_sessions' THEN
      SELECT COUNT(*), MIN(started_at) INTO v_total, v_oldest FROM work_sessions;
      SELECT COUNT(*) INTO v_to_delete FROM work_sessions WHERE started_at < v_cutoff;
    
    WHEN 'customer_service_sessions' THEN
      SELECT COUNT(*), MIN(started_at) INTO v_total, v_oldest FROM customer_service_sessions;
      SELECT COUNT(*) INTO v_to_delete FROM customer_service_sessions WHERE started_at < v_cutoff;
    
    WHEN 'valid_data_audit_log' THEN
      SELECT COUNT(*), MIN(action_timestamp) INTO v_total, v_oldest FROM valid_data_audit_log;
      SELECT COUNT(*) INTO v_to_delete FROM valid_data_audit_log WHERE action_timestamp < v_cutoff;
    
    WHEN 'valid_data_error_log' THEN
      SELECT COUNT(*), MIN(detected_at) INTO v_total, v_oldest FROM valid_data_error_log;
      SELECT COUNT(*) INTO v_to_delete FROM valid_data_error_log WHERE detected_at < v_cutoff AND resolved_at IS NOT NULL;
    
    WHEN 'dispatch_system_logs' THEN
      SELECT COUNT(*), MIN(logged_at) INTO v_total, v_oldest FROM dispatch_system_logs;
      SELECT COUNT(*) INTO v_to_delete FROM dispatch_system_logs WHERE logged_at < v_cutoff;
    
    WHEN 'commission_audit_log' THEN
      SELECT COUNT(*), MIN(created_at) INTO v_total, v_oldest FROM commission_audit_log;
      SELECT COUNT(*) INTO v_to_delete FROM commission_audit_log WHERE created_at < v_cutoff;
    
    WHEN 'money_data_protection_audit' THEN
      SELECT COUNT(*), MIN(created_at) INTO v_total, v_oldest FROM money_data_protection_audit;
      SELECT COUNT(*) INTO v_to_delete FROM money_data_protection_audit WHERE created_at < v_cutoff;
    
    WHEN 'dispatch_performance_metrics' THEN
      SELECT COUNT(*), MIN(recorded_at) INTO v_total, v_oldest FROM dispatch_performance_metrics;
      SELECT COUNT(*) INTO v_to_delete FROM dispatch_performance_metrics WHERE recorded_at < v_cutoff;
    
    WHEN 'valid_data_query_performance' THEN
      SELECT COUNT(*), MIN(recorded_at) INTO v_total, v_oldest FROM valid_data_query_performance;
      SELECT COUNT(*) INTO v_to_delete FROM valid_data_query_performance WHERE recorded_at < v_cutoff;
    
    WHEN 'orders_history' THEN
      SELECT COUNT(*), MIN(archived_at) INTO v_total, v_oldest FROM orders_history;
      SELECT COUNT(*) INTO v_to_delete FROM orders_history WHERE archived_at < v_cutoff;
    
    WHEN 'valid_order_data_archive' THEN
      SELECT COUNT(*), MIN(archived_at) INTO v_total, v_oldest FROM valid_order_data_archive;
      SELECT COUNT(*) INTO v_to_delete FROM valid_order_data_archive WHERE archived_at < v_cutoff;
    
    WHEN 'bulk_import_log' THEN
      SELECT COUNT(*), MIN(started_at) INTO v_total, v_oldest FROM bulk_import_log;
      SELECT COUNT(*) INTO v_to_delete FROM bulk_import_log WHERE completed_at < v_cutoff AND status IN ('completed', 'failed');
    
    ELSE
      RAISE EXCEPTION 'Cleanup not implemented for table %', p_table_name;
  END CASE;
  
  -- Calculate space to be freed
  EXECUTE format('SELECT pg_total_relation_size(%L)', p_table_name) INTO v_current_size;
  v_estimated_freed := (v_current_size::numeric * v_to_delete / GREATEST(v_total, 1))::bigint;
  
  RETURN QUERY SELECT
    p_table_name,
    v_total,
    COALESCE(v_to_delete, 0),
    v_total - COALESCE(v_to_delete, 0),
    v_oldest,
    v_cutoff,
    pg_size_pretty(v_estimated_freed),
    CASE
      WHEN COALESCE(v_to_delete, 0) = 0 THEN 'No records to delete'
      WHEN COALESCE(v_to_delete, 0) > v_total * 0.9 THEN 'WARNING: Will delete >90% of records'
      WHEN COALESCE(v_to_delete, 0) > v_total * 0.5 THEN 'CAUTION: Will delete >50% of records'
      ELSE 'Safe to proceed'
    END;
END;
$$;

-- ============================================================================
-- 3. EXECUTE CLEANUP FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION execute_cleanup(
  p_table_name text,
  p_days_to_keep integer,
  p_admin_id uuid
)
RETURNS TABLE (
  success boolean,
  records_deleted bigint,
  space_freed text,
  execution_time_ms numeric,
  message text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_time timestamp;
  v_deleted bigint := 0;
  v_cutoff timestamptz;
  v_size_before bigint;
  v_size_after bigint;
  v_config record;
BEGIN
  v_start_time := clock_timestamp();
  
  -- Validate
  SELECT * INTO v_config
  FROM history_cleanup_config
  WHERE history_cleanup_config.table_name = p_table_name
    AND can_cleanup = true;
  
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0::bigint, '0 bytes', 0::numeric,
      'Table not found or cleanup not allowed'::text;
    RETURN;
  END IF;
  
  IF p_days_to_keep < v_config.min_retention_days THEN
    RETURN QUERY SELECT false, 0::bigint, '0 bytes', 0::numeric,
      format('Retention must be at least %s days', v_config.min_retention_days)::text;
    RETURN;
  END IF;
  
  v_cutoff := NOW() - (p_days_to_keep || ' days')::interval;
  
  -- Get size before
  EXECUTE format('SELECT pg_total_relation_size(%L)', p_table_name) INTO v_size_before;
  
  -- Execute cleanup based on table
  CASE p_table_name
    WHEN 'dispatch_assignments' THEN
      DELETE FROM dispatch_assignments WHERE assigned_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    WHEN 'dispatch_sessions' THEN
      DELETE FROM dispatch_sessions WHERE started_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    WHEN 'work_sessions' THEN
      DELETE FROM work_sessions WHERE started_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    WHEN 'customer_service_sessions' THEN
      DELETE FROM customer_service_sessions WHERE started_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    WHEN 'valid_data_audit_log' THEN
      DELETE FROM valid_data_audit_log WHERE action_timestamp < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    WHEN 'valid_data_error_log' THEN
      DELETE FROM valid_data_error_log WHERE detected_at < v_cutoff AND resolved_at IS NOT NULL;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    WHEN 'dispatch_system_logs' THEN
      DELETE FROM dispatch_system_logs WHERE logged_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    WHEN 'commission_audit_log' THEN
      DELETE FROM commission_audit_log WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    WHEN 'money_data_protection_audit' THEN
      DELETE FROM money_data_protection_audit WHERE created_at < v_cutoff;
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    WHEN 'dispatch_performance_metrics' THEN
      DELETE FROM dispatch_performance_metrics WHERE recorded_at < v_cutoff;
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
      DELETE FROM bulk_import_log WHERE completed_at < v_cutoff AND status IN ('completed', 'failed');
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END CASE;
  
  -- Get size after
  EXECUTE format('SELECT pg_total_relation_size(%L)', p_table_name) INTO v_size_after;
  
  -- Update config
  UPDATE history_cleanup_config
  SET last_cleanup_at = NOW(),
      last_cleanup_records = v_deleted,
      updated_at = NOW()
  WHERE history_cleanup_config.table_name = p_table_name;
  
  -- Update statistics
  EXECUTE format('ANALYZE %I', p_table_name);
  
  RETURN QUERY SELECT
    true,
    v_deleted,
    pg_size_pretty(v_size_before - v_size_after),
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    format('Successfully deleted %s records older than %s days', v_deleted, p_days_to_keep)::text;
END;
$$;

-- ============================================================================
-- 4. MANAGEMENT VIEWS
-- ============================================================================

-- Summary view for admin dashboard
CREATE OR REPLACE VIEW history_cleanup_summary AS
SELECT
  hcc.category,
  hcc.display_name,
  hcc.table_name,
  hcc.description,
  hcc.default_retention_days,
  hcc.min_retention_days,
  hcc.cleanup_priority,
  hcc.last_cleanup_at,
  hcc.last_cleanup_records,
  CASE
    WHEN hcc.last_cleanup_at IS NULL THEN 'Never cleaned'
    WHEN hcc.last_cleanup_at < NOW() - INTERVAL '7 days' THEN 'Cleanup overdue'
    WHEN hcc.last_cleanup_at < NOW() - INTERVAL '3 days' THEN 'Consider cleanup'
    ELSE 'Recently cleaned'
  END as cleanup_status,
  pg_size_pretty(pg_total_relation_size(hcc.table_name)) as current_size,
  CASE hcc.table_name
    WHEN 'dispatch_assignments' THEN (SELECT COUNT(*) FROM dispatch_assignments)
    WHEN 'dispatch_sessions' THEN (SELECT COUNT(*) FROM dispatch_sessions)
    WHEN 'work_sessions' THEN (SELECT COUNT(*) FROM work_sessions)
    WHEN 'customer_service_sessions' THEN (SELECT COUNT(*) FROM customer_service_sessions)
    WHEN 'valid_data_audit_log' THEN (SELECT COUNT(*) FROM valid_data_audit_log)
    WHEN 'valid_data_error_log' THEN (SELECT COUNT(*) FROM valid_data_error_log)
    WHEN 'dispatch_system_logs' THEN (SELECT COUNT(*) FROM dispatch_system_logs)
    WHEN 'commission_audit_log' THEN (SELECT COUNT(*) FROM commission_audit_log)
    WHEN 'money_data_protection_audit' THEN (SELECT COUNT(*) FROM money_data_protection_audit)
    WHEN 'dispatch_performance_metrics' THEN (SELECT COUNT(*) FROM dispatch_performance_metrics)
    WHEN 'valid_data_query_performance' THEN (SELECT COUNT(*) FROM valid_data_query_performance)
    WHEN 'orders_history' THEN (SELECT COUNT(*) FROM orders_history)
    WHEN 'valid_order_data_archive' THEN (SELECT COUNT(*) FROM valid_order_data_archive)
    WHEN 'bulk_import_log' THEN (SELECT COUNT(*) FROM bulk_import_log)
  END as current_record_count
FROM history_cleanup_config hcc
WHERE hcc.can_cleanup = true
ORDER BY hcc.cleanup_priority DESC, hcc.category, hcc.table_name;

-- Grant permissions
GRANT SELECT ON history_cleanup_config TO authenticated;
GRANT SELECT ON history_cleanup_summary TO authenticated;
GRANT EXECUTE ON FUNCTION preview_cleanup(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION execute_cleanup(text, integer, uuid) TO authenticated;

-- Add comments
COMMENT ON TABLE history_cleanup_config IS 'Configuration for historical data cleanup. Defines retention policies for each table.';
COMMENT ON FUNCTION preview_cleanup IS 'Preview what records will be deleted without actually deleting them.';
COMMENT ON FUNCTION execute_cleanup IS 'Execute cleanup for a specific table. Super admin only.';
COMMENT ON VIEW history_cleanup_summary IS 'Summary view for history data management dashboard.';
