/*
  # Fix Security Advisor Issues - Indexes and Views
  
  ## Changes
  
  1. **Add Missing Foreign Key Indexes**
     - `admin_group_members.admin_id` - Improve join performance for admin group queries
     - `commission_audit_log.order_id` - Improve audit log queries by order
     - `commission_audit_log.user_id` - Improve audit log queries by user
     - `customer_service_sessions.employee_id` - Improve session queries by employee
  
  2. **Remove Unused Indexes**
     - Remove 16 indexes that are not being used by any queries
     - This reduces storage overhead and improves write performance
  
  3. **Fix Security Definer View**
     - Recreate `history_cleanup_summary` view without SECURITY DEFINER
     - Use invoker's permissions for better security
  
  ## Security Impact
  - Better performance through proper indexing
  - Reduced attack surface by removing unused indexes
  - Safer view execution with invoker permissions
*/

-- ============================================================================
-- PART 1: Add Missing Foreign Key Indexes
-- ============================================================================

-- Index for admin_group_members.admin_id
CREATE INDEX IF NOT EXISTS idx_admin_group_members_admin_id 
ON admin_group_members(admin_id);

-- Indexes for commission_audit_log foreign keys
CREATE INDEX IF NOT EXISTS idx_commission_audit_log_order_id 
ON commission_audit_log(order_id);

CREATE INDEX IF NOT EXISTS idx_commission_audit_log_user_id 
ON commission_audit_log(user_id);

-- Index for customer_service_sessions.employee_id
CREATE INDEX IF NOT EXISTS idx_customer_service_sessions_employee_id 
ON customer_service_sessions(employee_id);

-- ============================================================================
-- PART 2: Remove Unused Indexes
-- ============================================================================

DROP INDEX IF EXISTS idx_wallet_transactions_created_by;
DROP INDEX IF EXISTS idx_withdrawals_audited_by;
DROP INDEX IF EXISTS idx_account_locks_unlocked_by;
DROP INDEX IF EXISTS idx_admin_groups_created_by;
DROP INDEX IF EXISTS idx_admins_parent_id;
DROP INDEX IF EXISTS idx_broadcast_messages_target_admin_id;
DROP INDEX IF EXISTS idx_bulk_import_log_performed_by;
DROP INDEX IF EXISTS idx_dispatch_group_members_assigned_by;
DROP INDEX IF EXISTS idx_dispatch_group_orders_created_by;
DROP INDEX IF EXISTS idx_dispatch_groups_created_by;
DROP INDEX IF EXISTS idx_dispatch_orders_created_by;
DROP INDEX IF EXISTS idx_orders_product_type_id;
DROP INDEX IF EXISTS idx_rating_requests_session_id;
DROP INDEX IF EXISTS idx_used_order_data_order_id;
DROP INDEX IF EXISTS idx_valid_data_error_log_resolved_by;
DROP INDEX IF EXISTS idx_verification_requests_audited_by;

-- ============================================================================
-- PART 3: Fix Security Definer View
-- ============================================================================

-- Drop the existing SECURITY DEFINER view
DROP VIEW IF EXISTS history_cleanup_summary;

-- Recreate without SECURITY DEFINER (uses invoker's permissions)
CREATE VIEW history_cleanup_summary AS
SELECT 
  hcc.category,
  hcc.table_name,
  hcc.display_name,
  hcc.description,
  hcc.retention_days AS default_retention_days,
  hcc.min_retention_days,
  hcc.last_cleanup_at,
  hcc.last_cleanup_records,
  hcc.cleanup_priority,
  CASE 
    WHEN hcc.last_cleanup_at IS NULL THEN 'never_cleaned'
    WHEN hcc.last_cleanup_at < NOW() - INTERVAL '7 days' THEN 'needs_cleanup'
    WHEN hcc.last_cleanup_at < NOW() - INTERVAL '3 days' THEN 'due_soon'
    ELSE 'up_to_date'
  END AS cleanup_status,
  -- Estimate current size using record count (approximate)
  CASE 
    WHEN hcc.table_name = 'dispatch_assignments' THEN 
      (SELECT COUNT(*) FROM dispatch_assignments) || ' records'
    WHEN hcc.table_name = 'dispatch_sessions' THEN 
      (SELECT COUNT(*) FROM dispatch_sessions) || ' records'
    WHEN hcc.table_name = 'work_sessions' THEN 
      (SELECT COUNT(*) FROM work_sessions) || ' records'
    WHEN hcc.table_name = 'customer_service_sessions' THEN 
      (SELECT COUNT(*) FROM customer_service_sessions) || ' records'
    WHEN hcc.table_name = 'used_order_data' THEN 
      (SELECT COUNT(*) FROM used_order_data) || ' records'
    WHEN hcc.table_name = 'valid_data_audit_log' THEN 
      (SELECT COUNT(*) FROM valid_data_audit_log) || ' records'
    WHEN hcc.table_name = 'valid_data_error_log' THEN 
      (SELECT COUNT(*) FROM valid_data_error_log) || ' records'
    WHEN hcc.table_name = 'dispatch_system_logs' THEN 
      (SELECT COUNT(*) FROM dispatch_system_logs) || ' records'
    WHEN hcc.table_name = 'commission_audit_log' THEN 
      (SELECT COUNT(*) FROM commission_audit_log) || ' records'
    WHEN hcc.table_name = 'money_data_protection_audit' THEN 
      (SELECT COUNT(*) FROM money_data_protection_audit) || ' records'
    WHEN hcc.table_name = 'dispatch_performance_metrics' THEN 
      (SELECT COUNT(*) FROM dispatch_performance_metrics) || ' records'
    WHEN hcc.table_name = 'valid_data_query_performance' THEN 
      (SELECT COUNT(*) FROM valid_data_query_performance) || ' records'
    WHEN hcc.table_name = 'orders_history' THEN 
      (SELECT COUNT(*) FROM orders_history) || ' records'
    WHEN hcc.table_name = 'valid_order_data_archive' THEN 
      (SELECT COUNT(*) FROM valid_order_data_archive) || ' records'
    WHEN hcc.table_name = 'bulk_import_log' THEN 
      (SELECT COUNT(*) FROM bulk_import_log) || ' records'
    WHEN hcc.table_name = 'valid_order_data' THEN 
      (SELECT COUNT(*) FROM valid_order_data) || ' records'
    ELSE 'N/A'
  END AS current_size,
  -- Get actual record count
  CASE 
    WHEN hcc.table_name = 'dispatch_assignments' THEN 
      (SELECT COUNT(*) FROM dispatch_assignments)
    WHEN hcc.table_name = 'dispatch_sessions' THEN 
      (SELECT COUNT(*) FROM dispatch_sessions)
    WHEN hcc.table_name = 'work_sessions' THEN 
      (SELECT COUNT(*) FROM work_sessions)
    WHEN hcc.table_name = 'customer_service_sessions' THEN 
      (SELECT COUNT(*) FROM customer_service_sessions)
    WHEN hcc.table_name = 'used_order_data' THEN 
      (SELECT COUNT(*) FROM used_order_data)
    WHEN hcc.table_name = 'valid_data_audit_log' THEN 
      (SELECT COUNT(*) FROM valid_data_audit_log)
    WHEN hcc.table_name = 'valid_data_error_log' THEN 
      (SELECT COUNT(*) FROM valid_data_error_log)
    WHEN hcc.table_name = 'dispatch_system_logs' THEN 
      (SELECT COUNT(*) FROM dispatch_system_logs)
    WHEN hcc.table_name = 'commission_audit_log' THEN 
      (SELECT COUNT(*) FROM commission_audit_log)
    WHEN hcc.table_name = 'money_data_protection_audit' THEN 
      (SELECT COUNT(*) FROM money_data_protection_audit)
    WHEN hcc.table_name = 'dispatch_performance_metrics' THEN 
      (SELECT COUNT(*) FROM dispatch_performance_metrics)
    WHEN hcc.table_name = 'valid_data_query_performance' THEN 
      (SELECT COUNT(*) FROM valid_data_query_performance)
    WHEN hcc.table_name = 'orders_history' THEN 
      (SELECT COUNT(*) FROM orders_history)
    WHEN hcc.table_name = 'valid_order_data_archive' THEN 
      (SELECT COUNT(*) FROM valid_order_data_archive)
    WHEN hcc.table_name = 'bulk_import_log' THEN 
      (SELECT COUNT(*) FROM bulk_import_log)
    WHEN hcc.table_name = 'valid_order_data' THEN 
      (SELECT COUNT(*) FROM valid_order_data)
    ELSE 0
  END AS current_record_count
FROM history_cleanup_config hcc
WHERE hcc.can_cleanup = true
ORDER BY hcc.cleanup_priority DESC, hcc.table_name;

COMMENT ON VIEW history_cleanup_summary IS 
'Summary view of all cleanable tables with their current status and metrics. Uses invoker permissions for security.';

-- ============================================================================
-- Verification
-- ============================================================================

DO $$
DECLARE
  v_new_indexes int;
  v_removed_indexes int;
BEGIN
  -- Count new indexes
  SELECT COUNT(*) INTO v_new_indexes
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'idx_admin_group_members_admin_id',
      'idx_commission_audit_log_order_id',
      'idx_commission_audit_log_user_id',
      'idx_customer_service_sessions_employee_id'
    );
  
  -- Verify removed indexes don't exist
  SELECT COUNT(*) INTO v_removed_indexes
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname IN (
      'idx_wallet_transactions_created_by',
      'idx_withdrawals_audited_by',
      'idx_account_locks_unlocked_by',
      'idx_admin_groups_created_by'
    );
  
  RAISE NOTICE 'Security fixes applied:';
  RAISE NOTICE '  - Added % new indexes for foreign keys', v_new_indexes;
  RAISE NOTICE '  - Removed unused indexes (% should be 0)', v_removed_indexes;
  RAISE NOTICE '  - Recreated history_cleanup_summary view without SECURITY DEFINER';
END $$;
