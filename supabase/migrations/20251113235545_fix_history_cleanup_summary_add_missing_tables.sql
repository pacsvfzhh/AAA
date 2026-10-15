/*
  # Fix history_cleanup_summary View to Include Missing Tables

  ## Overview
  Updates the history_cleanup_summary view to include record counts for all tables,
  especially used_order_data and valid_order_data which were missing.

  ## Changes
  - Add used_order_data to current_record_count CASE
  - Add valid_order_data to current_record_count CASE

  ## Why This is Needed
  The Records column in History Data Management page shows NULL for tables that
  are not in the CASE statement, even though they have data. This causes confusion.
*/

-- ============================================================================
-- UPDATE history_cleanup_summary VIEW
-- ============================================================================

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
    -- Operational tables
    WHEN 'dispatch_assignments' THEN (SELECT COUNT(*) FROM dispatch_assignments)
    WHEN 'dispatch_sessions' THEN (SELECT COUNT(*) FROM dispatch_sessions)
    WHEN 'work_sessions' THEN (SELECT COUNT(*) FROM work_sessions)
    WHEN 'customer_service_sessions' THEN (SELECT COUNT(*) FROM customer_service_sessions)
    WHEN 'used_order_data' THEN (SELECT COUNT(*) FROM used_order_data)
    WHEN 'valid_order_data' THEN (SELECT COUNT(*) FROM valid_order_data)
    
    -- Audit tables
    WHEN 'valid_data_audit_log' THEN (SELECT COUNT(*) FROM valid_data_audit_log)
    WHEN 'valid_data_error_log' THEN (SELECT COUNT(*) FROM valid_data_error_log)
    WHEN 'commission_audit_log' THEN (SELECT COUNT(*) FROM commission_audit_log)
    WHEN 'money_data_protection_audit' THEN (SELECT COUNT(*) FROM money_data_protection_audit)
    
    -- Performance tables
    WHEN 'dispatch_system_logs' THEN (SELECT COUNT(*) FROM dispatch_system_logs)
    WHEN 'dispatch_performance_metrics' THEN (SELECT COUNT(*) FROM dispatch_performance_metrics)
    WHEN 'valid_data_query_performance' THEN (SELECT COUNT(*) FROM valid_data_query_performance)
    
    -- Archive tables
    WHEN 'orders_history' THEN (SELECT COUNT(*) FROM orders_history)
    WHEN 'valid_order_data_archive' THEN (SELECT COUNT(*) FROM valid_order_data_archive)
    WHEN 'bulk_import_log' THEN (SELECT COUNT(*) FROM bulk_import_log)
    
    ELSE NULL
  END as current_record_count
FROM history_cleanup_config hcc
WHERE hcc.can_cleanup = true
ORDER BY hcc.cleanup_priority DESC, hcc.category, hcc.table_name;

COMMENT ON VIEW history_cleanup_summary IS
'Summary view for history data management dashboard. Shows current status, size, and record count for all cleanable tables.';
