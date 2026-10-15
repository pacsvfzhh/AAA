/*
  # Fix Cleanup Summary - Size Based on Record Count
  
  ## Problem
  pg_total_relation_size returns physical disk space which doesn't 
  immediately decrease after deleting records (requires VACUUM).
  
  ## Solution
  Calculate size based on record count with estimated row size.
  This provides immediate feedback after deletion.
  
  ## Changes
  - Update get_table_size to estimate based on record count
  - Each record estimated at ~200 bytes average
*/

-- Update helper function to estimate size based on record count
CREATE OR REPLACE FUNCTION get_table_size(p_table_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count bigint;
  v_estimated_row_size integer;
BEGIN
  -- Get actual record count
  EXECUTE format('SELECT COUNT(*) FROM %I', p_table_name) INTO v_count;
  
  -- Estimate row size based on table type
  v_estimated_row_size := CASE p_table_name
    WHEN 'dispatch_assignments' THEN 300
    WHEN 'dispatch_sessions' THEN 200
    WHEN 'work_sessions' THEN 150
    WHEN 'customer_service_sessions' THEN 250
    WHEN 'valid_data_audit_log' THEN 500
    WHEN 'valid_data_error_log' THEN 400
    WHEN 'dispatch_system_logs' THEN 350
    WHEN 'commission_audit_log' THEN 400
    WHEN 'money_data_protection_audit' THEN 450
    WHEN 'dispatch_performance_metrics' THEN 300
    WHEN 'valid_data_query_performance' THEN 250
    WHEN 'orders_history' THEN 500
    WHEN 'valid_order_data_archive' THEN 400
    WHEN 'bulk_import_log' THEN 350
    WHEN 'used_order_data' THEN 350
    ELSE 250
  END;
  
  RETURN v_count * v_estimated_row_size;
EXCEPTION
  WHEN OTHERS THEN
    RETURN 0;
END;
$$;

COMMENT ON FUNCTION get_table_size IS 'Estimate table size based on record count for immediate feedback after deletion.';
