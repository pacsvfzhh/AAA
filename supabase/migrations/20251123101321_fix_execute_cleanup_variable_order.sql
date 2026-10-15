/*
  # Fix execute_cleanup function variable ordering issue

  1. Problem
    - v_size_after is used on line 282 before being assigned on line 289
    - This causes NULL arithmetic error leading to 500 errors
    - Prevents proper cleanup execution

  2. Solution
    - Move v_size_after calculation before INSERT INTO history_cleanup_log
    - Ensure all variables are properly initialized before use
    
  3. Impact
    - Fixes 500 errors during auto cleanup execution
    - Allows proper space calculation and logging
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
  
  -- Get size after (MOVED BEFORE INSERT)
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

COMMENT ON FUNCTION execute_cleanup IS
'Generic cleanup function for all history tables. Executes actual deletion and logs results.';