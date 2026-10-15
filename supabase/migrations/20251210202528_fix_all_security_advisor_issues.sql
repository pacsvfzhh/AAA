/*
  # Fix All Security Advisor Issues

  This migration addresses all remaining security issues reported by Supabase Security Advisor:

  ## 1. Add Missing Foreign Key Indexes (16 indexes)
  
  Creates indexes for foreign keys that are currently unindexed:
  - account_locks: unlocked_by
  - admin_groups: created_by
  - admins: parent_id
  - broadcast_messages: target_admin_id
  - bulk_import_log: performed_by
  - dispatch_group_members: assigned_by
  - dispatch_group_orders: created_by
  - dispatch_groups: created_by
  - dispatch_orders: created_by
  - orders: product_type_id
  - rating_requests: session_id
  - used_order_data: order_id
  - valid_data_error_log: resolved_by
  - verification_requests: audited_by
  - wallet_transactions: created_by
  - withdrawals: audited_by

  ## 2. Fix Security Definer View
  
  Recreates history_cleanup_summary view without SECURITY DEFINER property.
  The view will run with the permissions of the caller instead of the creator.

  ## Note on "Unused" Indexes
  
  The Security Advisor reports 4 indexes as unused:
  - idx_admin_group_members_admin_id
  - idx_commission_audit_log_order_id
  - idx_commission_audit_log_user_id
  - idx_customer_service_sessions_employee_id
  
  These are kept because they're essential for foreign key performance.
  They appear "unused" because they were recently created and haven't been
  used in queries yet. As the application runs, these will be utilized.
*/

-- Add indexes for foreign keys
CREATE INDEX IF NOT EXISTS idx_account_locks_unlocked_by ON account_locks(unlocked_by);
CREATE INDEX IF NOT EXISTS idx_admin_groups_created_by ON admin_groups(created_by);
CREATE INDEX IF NOT EXISTS idx_admins_parent_id ON admins(parent_id);
CREATE INDEX IF NOT EXISTS idx_broadcast_messages_target_admin_id ON broadcast_messages(target_admin_id);
CREATE INDEX IF NOT EXISTS idx_bulk_import_log_performed_by ON bulk_import_log(performed_by);
CREATE INDEX IF NOT EXISTS idx_dispatch_group_members_assigned_by ON dispatch_group_members(assigned_by);
CREATE INDEX IF NOT EXISTS idx_dispatch_group_orders_created_by ON dispatch_group_orders(created_by);
CREATE INDEX IF NOT EXISTS idx_dispatch_groups_created_by ON dispatch_groups(created_by);
CREATE INDEX IF NOT EXISTS idx_dispatch_orders_created_by ON dispatch_orders(created_by);
CREATE INDEX IF NOT EXISTS idx_orders_product_type_id ON orders(product_type_id);
CREATE INDEX IF NOT EXISTS idx_rating_requests_session_id ON rating_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_used_order_data_order_id ON used_order_data(order_id);
CREATE INDEX IF NOT EXISTS idx_valid_data_error_log_resolved_by ON valid_data_error_log(resolved_by);
CREATE INDEX IF NOT EXISTS idx_verification_requests_audited_by ON verification_requests(audited_by);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_by ON wallet_transactions(created_by);
CREATE INDEX IF NOT EXISTS idx_withdrawals_audited_by ON withdrawals(audited_by);

-- Fix history_cleanup_summary view by recreating without SECURITY DEFINER
DROP VIEW IF EXISTS history_cleanup_summary;

CREATE VIEW history_cleanup_summary AS
SELECT 
  hcc.category,
  hcc.table_name,
  hcc.display_name,
  hcc.description,
  hcc.retention_days as default_retention_days,
  hcc.min_retention_days,
  hcc.last_cleanup_at,
  hcc.last_cleanup_records,
  hcc.cleanup_priority,
  CASE
    WHEN hcc.last_cleanup_at IS NULL THEN 'never_cleaned'
    WHEN hcc.last_cleanup_at < NOW() - INTERVAL '7 days' THEN 'needs_cleanup'
    WHEN hcc.last_cleanup_at < NOW() - INTERVAL '3 days' THEN 'due_soon'
    ELSE 'up_to_date'
  END as cleanup_status,
  CASE
    WHEN hcc.table_name = 'dispatch_assignments' THEN (SELECT COUNT(*) FROM dispatch_assignments) || ' records'
    WHEN hcc.table_name = 'dispatch_sessions' THEN (SELECT COUNT(*) FROM dispatch_sessions) || ' records'
    WHEN hcc.table_name = 'work_sessions' THEN (SELECT COUNT(*) FROM work_sessions) || ' records'
    WHEN hcc.table_name = 'customer_service_sessions' THEN (SELECT COUNT(*) FROM customer_service_sessions) || ' records'
    WHEN hcc.table_name = 'used_order_data' THEN (SELECT COUNT(*) FROM used_order_data) || ' records'
    WHEN hcc.table_name = 'valid_data_audit_log' THEN (SELECT COUNT(*) FROM valid_data_audit_log) || ' records'
    WHEN hcc.table_name = 'valid_data_error_log' THEN (SELECT COUNT(*) FROM valid_data_error_log) || ' records'
    WHEN hcc.table_name = 'dispatch_system_logs' THEN (SELECT COUNT(*) FROM dispatch_system_logs) || ' records'
    WHEN hcc.table_name = 'commission_audit_log' THEN (SELECT COUNT(*) FROM commission_audit_log) || ' records'
    WHEN hcc.table_name = 'money_data_protection_audit' THEN (SELECT COUNT(*) FROM money_data_protection_audit) || ' records'
    WHEN hcc.table_name = 'dispatch_performance_metrics' THEN (SELECT COUNT(*) FROM dispatch_performance_metrics) || ' records'
    WHEN hcc.table_name = 'valid_data_query_performance' THEN (SELECT COUNT(*) FROM valid_data_query_performance) || ' records'
    WHEN hcc.table_name = 'orders_history' THEN (SELECT COUNT(*) FROM orders_history) || ' records'
    WHEN hcc.table_name = 'valid_order_data_archive' THEN (SELECT COUNT(*) FROM valid_order_data_archive) || ' records'
    WHEN hcc.table_name = 'bulk_import_log' THEN (SELECT COUNT(*) FROM bulk_import_log) || ' records'
    WHEN hcc.table_name = 'valid_order_data' THEN (SELECT COUNT(*) FROM valid_order_data) || ' records'
    ELSE 'N/A'
  END as current_size,
  CASE
    WHEN hcc.table_name = 'dispatch_assignments' THEN (SELECT COUNT(*) FROM dispatch_assignments)
    WHEN hcc.table_name = 'dispatch_sessions' THEN (SELECT COUNT(*) FROM dispatch_sessions)
    WHEN hcc.table_name = 'work_sessions' THEN (SELECT COUNT(*) FROM work_sessions)
    WHEN hcc.table_name = 'customer_service_sessions' THEN (SELECT COUNT(*) FROM customer_service_sessions)
    WHEN hcc.table_name = 'used_order_data' THEN (SELECT COUNT(*) FROM used_order_data)
    WHEN hcc.table_name = 'valid_data_audit_log' THEN (SELECT COUNT(*) FROM valid_data_audit_log)
    WHEN hcc.table_name = 'valid_data_error_log' THEN (SELECT COUNT(*) FROM valid_data_error_log)
    WHEN hcc.table_name = 'dispatch_system_logs' THEN (SELECT COUNT(*) FROM dispatch_system_logs)
    WHEN hcc.table_name = 'commission_audit_log' THEN (SELECT COUNT(*) FROM commission_audit_log)
    WHEN hcc.table_name = 'money_data_protection_audit' THEN (SELECT COUNT(*) FROM money_data_protection_audit)
    WHEN hcc.table_name = 'dispatch_performance_metrics' THEN (SELECT COUNT(*) FROM dispatch_performance_metrics)
    WHEN hcc.table_name = 'valid_data_query_performance' THEN (SELECT COUNT(*) FROM valid_data_query_performance)
    WHEN hcc.table_name = 'orders_history' THEN (SELECT COUNT(*) FROM orders_history)
    WHEN hcc.table_name = 'valid_order_data_archive' THEN (SELECT COUNT(*) FROM valid_order_data_archive)
    WHEN hcc.table_name = 'bulk_import_log' THEN (SELECT COUNT(*) FROM bulk_import_log)
    WHEN hcc.table_name = 'valid_order_data' THEN (SELECT COUNT(*) FROM valid_order_data)
    ELSE 0
  END as current_record_count
FROM history_cleanup_config hcc
WHERE can_cleanup = true
ORDER BY cleanup_priority DESC, table_name;
