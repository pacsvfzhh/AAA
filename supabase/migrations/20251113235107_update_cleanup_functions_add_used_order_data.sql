/*
  # Update Cleanup Functions to Support used_order_data

  ## Overview
  Updates the generic `preview_cleanup` and `execute_cleanup` functions to add support 
  for the `used_order_data` table.

  ## Changes
  1. Add `used_order_data` case to preview_cleanup function
  2. Add `used_order_data` case to execute_cleanup function

  ## Why This is Needed
  The History Data Management UI uses these generic functions to preview and execute
  cleanup operations. Without these cases, the UI will fail with "Cleanup not implemented"
  error when trying to clean up used_order_data.
*/

-- ============================================================================
-- 1. UPDATE preview_cleanup FUNCTION
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

  -- Calculate based on table type with CORRECT column names
  CASE p_table_name
    WHEN 'dispatch_assignments' THEN
      SELECT COUNT(*), MIN(assigned_at) INTO v_total, v_oldest FROM dispatch_assignments;
      SELECT COUNT(*) INTO v_to_delete FROM dispatch_assignments WHERE assigned_at < v_cutoff;

    WHEN 'dispatch_sessions' THEN
      SELECT COUNT(*), MIN(started_at) INTO v_total, v_oldest FROM dispatch_sessions;
      SELECT COUNT(*) INTO v_to_delete FROM dispatch_sessions WHERE started_at < v_cutoff;

    WHEN 'work_sessions' THEN
      SELECT COUNT(*), MIN(start_time) INTO v_total, v_oldest FROM work_sessions;
      SELECT COUNT(*) INTO v_to_delete FROM work_sessions WHERE start_time < v_cutoff;

    WHEN 'customer_service_sessions' THEN
      SELECT COUNT(*), MIN(created_at) INTO v_total, v_oldest FROM customer_service_sessions;
      SELECT COUNT(*) INTO v_to_delete FROM customer_service_sessions WHERE created_at < v_cutoff;

    WHEN 'used_order_data' THEN
      SELECT COUNT(*), MIN(created_at) INTO v_total, v_oldest FROM used_order_data;
      SELECT COUNT(*) INTO v_to_delete FROM used_order_data WHERE created_at < v_cutoff;

    WHEN 'valid_data_audit_log' THEN
      SELECT COUNT(*), MIN(action_timestamp) INTO v_total, v_oldest FROM valid_data_audit_log;
      SELECT COUNT(*) INTO v_to_delete FROM valid_data_audit_log WHERE action_timestamp < v_cutoff;

    WHEN 'valid_data_error_log' THEN
      SELECT COUNT(*), MIN(detected_at) INTO v_total, v_oldest FROM valid_data_error_log;
      SELECT COUNT(*) INTO v_to_delete FROM valid_data_error_log WHERE detected_at < v_cutoff AND resolved_at IS NOT NULL;

    WHEN 'dispatch_system_logs' THEN
      SELECT COUNT(*), MIN(created_at) INTO v_total, v_oldest FROM dispatch_system_logs;
      SELECT COUNT(*) INTO v_to_delete FROM dispatch_system_logs WHERE created_at < v_cutoff;

    WHEN 'commission_audit_log' THEN
      SELECT COUNT(*), MIN(created_at) INTO v_total, v_oldest FROM commission_audit_log;
      SELECT COUNT(*) INTO v_to_delete FROM commission_audit_log WHERE created_at < v_cutoff;

    WHEN 'money_data_protection_audit' THEN
      SELECT COUNT(*), MIN(attempted_at) INTO v_total, v_oldest FROM money_data_protection_audit;
      SELECT COUNT(*) INTO v_to_delete FROM money_data_protection_audit WHERE attempted_at < v_cutoff;

    WHEN 'dispatch_performance_metrics' THEN
      SELECT COUNT(*), MIN(measured_at) INTO v_total, v_oldest FROM dispatch_performance_metrics;
      SELECT COUNT(*) INTO v_to_delete FROM dispatch_performance_metrics WHERE measured_at < v_cutoff;

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
-- 2. UPDATE execute_cleanup FUNCTION
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
      DELETE FROM valid_data_error_log WHERE detected_at < v_cutoff AND resolved_at IS NOT NULL;
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
      DELETE FROM bulk_import_log WHERE completed_at < v_cutoff AND status IN ('completed', 'failed');
      GET DIAGNOSTICS v_deleted = ROW_COUNT;
    
    ELSE
      RAISE EXCEPTION 'Cleanup not implemented for table %', p_table_name;
  END CASE;
  
  -- Log the cleanup
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
    pg_size_pretty(v_size_before - v_size_after),
    p_days_to_keep,
    'completed',
    format('Deleted %s records older than %s days', v_deleted, p_days_to_keep)
  );
  
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

COMMENT ON FUNCTION preview_cleanup IS
'Generic preview function for all history tables. Now includes support for used_order_data.';

COMMENT ON FUNCTION execute_cleanup IS
'Generic cleanup execution function for all history tables. Now includes support for used_order_data.';
