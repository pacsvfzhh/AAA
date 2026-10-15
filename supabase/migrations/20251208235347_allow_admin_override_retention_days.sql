/*
  # Allow Admin to Override Retention Days
  
  ## Changes
  - Remove min_retention_days check from execute_cleanup
  - Allow super admin to delete any age of data
  - Keep validation only for safety confirmation
*/

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
SECURITY DEFINER
SET search_path = public
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
  
  -- Validate retention period is non-negative
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
  
  -- Get size before cleanup
  EXECUTE format('SELECT pg_total_relation_size(%L)', p_table_name) INTO v_size_before;
  
  -- Execute cleanup based on table with correct timestamp columns
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
  
  -- Get size after cleanup
  EXECUTE format('SELECT pg_total_relation_size(%L)', p_table_name) INTO v_size_after;
  
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
  
  -- Update config
  UPDATE history_cleanup_config
  SET 
    last_cleanup_at = NOW(),
    last_cleanup_records = v_deleted,
    updated_at = NOW()
  WHERE history_cleanup_config.table_name = p_table_name;
  
  -- Update statistics
  EXECUTE format('ANALYZE %I', p_table_name);
  
  -- Return result
  RETURN QUERY SELECT
    true,
    v_deleted,
    pg_size_pretty(v_size_before - v_size_after),
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    format('Successfully deleted %s records older than %s days', v_deleted, p_days_to_keep)::text;
END;
$$;

COMMENT ON FUNCTION execute_cleanup IS 'Execute cleanup with admin override - no min retention enforcement for manual cleanup';
