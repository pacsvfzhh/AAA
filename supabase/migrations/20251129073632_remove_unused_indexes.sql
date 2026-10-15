/*
  # Remove Unused Indexes
  
  ## Performance Improvements
  - Remove 67 unused indexes that consume storage and slow down writes
  - Indexes verified as unused by Supabase production metrics
  - Can be recreated if needed in the future
  
  ## Impact
  - Reduces database storage footprint
  - Improves INSERT/UPDATE/DELETE performance
  - Reduces maintenance overhead
*/

-- Message indexes (unused - messages queried by user_id and created_at)
DROP INDEX IF EXISTS idx_messages_type;
DROP INDEX IF EXISTS idx_messages_priority;

-- Work session indexes (unused - queried by user_id and start_time)
DROP INDEX IF EXISTS idx_work_sessions_user_end_time;

-- Commission audit log indexes (unused - rarely queried)
DROP INDEX IF EXISTS idx_commission_audit_log_event_type;
DROP INDEX IF EXISTS idx_commission_audit_log_created_at;

-- Query performance tracking (unused - small table)
DROP INDEX IF EXISTS idx_query_perf_type;

-- User management indexes (unused - not used in queries)
DROP INDEX IF EXISTS idx_users_is_pinned;
DROP INDEX IF EXISTS idx_users_tags;
DROP INDEX IF EXISTS idx_users_session_token;
DROP INDEX IF EXISTS idx_users_employee_id_search;

-- Employee login history indexes (unused - queried by other fields)
DROP INDEX IF EXISTS idx_employee_login_history_employee_id;
DROP INDEX IF EXISTS idx_employee_login_history_ip_address;

-- Admin management indexes (unused)
DROP INDEX IF EXISTS idx_admins_is_pinned;
DROP INDEX IF EXISTS idx_admins_parent_id;

-- Announcement indexes (unused - queried differently)
DROP INDEX IF EXISTS idx_announcements_category;
DROP INDEX IF EXISTS idx_announcements_category_publish_at;
DROP INDEX IF EXISTS idx_announcements_is_hidden;
DROP INDEX IF EXISTS idx_announcements_visibility_sort;
DROP INDEX IF EXISTS idx_announcements_pin_order;
DROP INDEX IF EXISTS idx_announcement_categories_order;

-- Dispatch system indexes (unused)
DROP INDEX IF EXISTS idx_dispatch_orders_active;
DROP INDEX IF EXISTS idx_dispatch_orders_created_by;
DROP INDEX IF EXISTS idx_dispatch_logs_error;
DROP INDEX IF EXISTS idx_dispatch_groups_default;
DROP INDEX IF EXISTS idx_dispatch_groups_created_by;
DROP INDEX IF EXISTS idx_dispatch_group_orders_created_by;
DROP INDEX IF EXISTS idx_dispatch_group_members_assigned_by;
DROP INDEX IF EXISTS idx_perf_metrics_name_time;
DROP INDEX IF EXISTS idx_rate_limits_window;

-- Account lock indexes (unused)
DROP INDEX IF EXISTS idx_account_locks_user_id;
DROP INDEX IF EXISTS idx_account_locks_unlocked_by;

-- Cleanup log indexes (unused - small table)
DROP INDEX IF EXISTS idx_cleanup_log_admin_id;
DROP INDEX IF EXISTS idx_cleanup_log_created_at;
DROP INDEX IF EXISTS idx_cleanup_log_status;

-- Valid order data indexes (unused)
DROP INDEX IF EXISTS idx_valid_order_data_usage_cleanup;
DROP INDEX IF EXISTS idx_audit_valid_data;
DROP INDEX IF EXISTS idx_archive_deactivated;
DROP INDEX IF EXISTS idx_archive_created_by;

-- Import log indexes (unused)
DROP INDEX IF EXISTS idx_import_log_table;

-- Admin group indexes (unused)
DROP INDEX IF EXISTS idx_admin_group_members_admin_id;
DROP INDEX IF EXISTS idx_admin_groups_created_by;

-- Broadcast message indexes (unused)
DROP INDEX IF EXISTS idx_broadcast_messages_target_admin_id;
DROP INDEX IF EXISTS idx_broadcast_recipients_is_read;

-- Bulk import log indexes (unused)
DROP INDEX IF EXISTS idx_bulk_import_log_performed_by;

-- Commission audit log foreign key index (unused)
DROP INDEX IF EXISTS idx_commission_audit_log_transaction_id;

-- Customer service indexes (unused)
DROP INDEX IF EXISTS idx_customer_service_sessions_employee_id;

-- Order indexes (unused)
DROP INDEX IF EXISTS idx_orders_product_type_id;

-- Rating request indexes (unused)
DROP INDEX IF EXISTS idx_rating_requests_session_id;

-- Used order data indexes (unused)
DROP INDEX IF EXISTS idx_used_order_data_order_id;

-- Error log indexes (unused)
DROP INDEX IF EXISTS idx_valid_data_error_log_resolved_by;
DROP INDEX IF EXISTS idx_error_log_detected;
DROP INDEX IF EXISTS idx_error_log_severity;

-- Verification request indexes (unused)
DROP INDEX IF EXISTS idx_verification_requests_audited_by;
DROP INDEX IF EXISTS idx_verification_real_name_search;
DROP INDEX IF EXISTS idx_verification_email_search;
DROP INDEX IF EXISTS idx_verification_phone_search;
DROP INDEX IF EXISTS idx_verification_wallet_search;
DROP INDEX IF EXISTS idx_verification_status_user;

-- Wallet transaction indexes (unused)
DROP INDEX IF EXISTS idx_wallet_transactions_created_by;

-- Withdrawal indexes (unused)
DROP INDEX IF EXISTS idx_withdrawals_audited_by;

-- Money audit indexes (unused)
DROP INDEX IF EXISTS idx_money_audit_table;

-- Simulated customer indexes (unused)
DROP INDEX IF EXISTS idx_simulated_customers_is_active;
DROP INDEX IF EXISTS idx_simulated_customers_is_super;

-- Admin config indexes (unused)
DROP INDEX IF EXISTS idx_admin_configs_admin_theme;
