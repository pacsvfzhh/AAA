/*
  # Fix preview_cleanup Function - Add SECURITY DEFINER
  
  ## Problem
  preview_cleanup function uses SECURITY INVOKER, which fails in custom auth
  because anon users don't have direct table access through RLS.
  
  ## Solution
  Change to SECURITY DEFINER so it runs with function creator's privileges.
*/

-- Recreate preview_cleanup with SECURITY DEFINER
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
SECURITY DEFINER  -- Changed from INVOKER to DEFINER
SET search_path = public
AS $$
DECLARE
  v_total bigint;
  v_to_delete bigint;
  v_oldest timestamptz;
  v_cutoff timestamptz;
  v_size_estimate bigint;
BEGIN
  -- Validate table name exists
  IF NOT EXISTS (
    SELECT 1 FROM history_cleanup_config
    WHERE history_cleanup_config.table_name = p_table_name
      AND can_cleanup = true
  ) THEN
    RAISE EXCEPTION 'Table % is not configured for cleanup or cleanup is disabled', p_table_name;
  END IF;
  
  -- Calculate cutoff date
  v_cutoff := NOW() - (p_days_to_keep || ' days')::INTERVAL;
  
  -- Get statistics based on table
  CASE p_table_name
    -- Operational tables with created_at
    WHEN 'dispatch_assignments' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_assignments;
      
    WHEN 'dispatch_sessions' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_sessions;
      
    WHEN 'work_sessions' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM work_sessions;
      
    WHEN 'customer_service_sessions' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM customer_service_sessions;
      
    -- Audit logs with created_at
    WHEN 'valid_data_audit_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_data_audit_log;
      
    WHEN 'valid_data_error_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_data_error_log;
      
    WHEN 'dispatch_system_logs' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_system_logs;
      
    WHEN 'commission_audit_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM commission_audit_log;
      
    WHEN 'money_data_protection_audit' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM money_data_protection_audit;
      
    -- Performance metrics
    WHEN 'dispatch_performance_metrics' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM dispatch_performance_metrics;
      
    WHEN 'valid_data_query_performance' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_data_query_performance;
      
    -- Archive tables
    WHEN 'orders_history' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE archived_at < v_cutoff), MIN(archived_at)
      INTO v_total, v_to_delete, v_oldest
      FROM orders_history;
      
    WHEN 'valid_order_data_archive' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE archived_at < v_cutoff), MIN(archived_at)
      INTO v_total, v_to_delete, v_oldest
      FROM valid_order_data_archive;
      
    WHEN 'bulk_import_log' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE created_at < v_cutoff), MIN(created_at)
      INTO v_total, v_to_delete, v_oldest
      FROM bulk_import_log;
      
    WHEN 'used_order_data' THEN
      SELECT COUNT(*), COUNT(*) FILTER (WHERE used_at < v_cutoff), MIN(used_at)
      INTO v_total, v_to_delete, v_oldest
      FROM used_order_data;
      
    ELSE
      RAISE EXCEPTION 'Table % is not supported for cleanup preview', p_table_name;
  END CASE;
  
  -- Estimate space to be freed (approximate)
  IF v_to_delete > 0 THEN
    v_size_estimate := (pg_total_relation_size(p_table_name::regclass) * v_to_delete / GREATEST(v_total, 1));
  ELSE
    v_size_estimate := 0;
  END IF;
  
  -- Return results
  RETURN QUERY SELECT
    p_table_name,
    v_total,
    v_to_delete,
    v_total - v_to_delete,
    v_oldest,
    v_cutoff,
    pg_size_pretty(v_size_estimate),
    CASE
      WHEN v_to_delete = 0 THEN 'No records to delete'
      WHEN v_to_delete < v_total * 0.1 THEN 'Safe - Less than 10% will be deleted'
      WHEN v_to_delete < v_total * 0.5 THEN 'Moderate - Less than 50% will be deleted'
      ELSE 'Warning - More than 50% will be deleted'
    END;
END;
$$;

-- Ensure permissions
GRANT EXECUTE ON FUNCTION preview_cleanup(text, integer) TO anon, authenticated;

COMMENT ON FUNCTION preview_cleanup IS 'Preview cleanup results for a table. Uses SECURITY DEFINER for custom auth compatibility.';
