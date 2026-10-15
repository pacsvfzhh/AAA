/*
  # Fix Security Advisor Issues - Indexes

  1. Add Missing Foreign Key Indexes
    - Add indexes for 16 unindexed foreign keys to improve query performance

  2. Remove Unused Indexes
    - Remove 5 unused indexes that are not being utilized
*/

-- =====================================================
-- PART 1: Add Missing Foreign Key Indexes
-- =====================================================

-- account_locks.unlocked_by
CREATE INDEX IF NOT EXISTS idx_account_locks_unlocked_by 
ON account_locks(unlocked_by) 
WHERE unlocked_by IS NOT NULL;

-- admin_groups.created_by
CREATE INDEX IF NOT EXISTS idx_admin_groups_created_by 
ON admin_groups(created_by);

-- admins.parent_id
CREATE INDEX IF NOT EXISTS idx_admins_parent_id 
ON admins(parent_id) 
WHERE parent_id IS NOT NULL;

-- broadcast_messages.target_admin_id
CREATE INDEX IF NOT EXISTS idx_broadcast_messages_target_admin_id 
ON broadcast_messages(target_admin_id) 
WHERE target_admin_id IS NOT NULL;

-- bulk_import_log.performed_by
CREATE INDEX IF NOT EXISTS idx_bulk_import_log_performed_by 
ON bulk_import_log(performed_by);

-- dispatch_group_members.assigned_by
CREATE INDEX IF NOT EXISTS idx_dispatch_group_members_assigned_by 
ON dispatch_group_members(assigned_by);

-- dispatch_group_orders.created_by
CREATE INDEX IF NOT EXISTS idx_dispatch_group_orders_created_by 
ON dispatch_group_orders(created_by);

-- dispatch_groups.created_by
CREATE INDEX IF NOT EXISTS idx_dispatch_groups_created_by 
ON dispatch_groups(created_by);

-- dispatch_orders.created_by
CREATE INDEX IF NOT EXISTS idx_dispatch_orders_created_by 
ON dispatch_orders(created_by);

-- orders.product_type_id
CREATE INDEX IF NOT EXISTS idx_orders_product_type_id 
ON orders(product_type_id);

-- rating_requests.session_id
CREATE INDEX IF NOT EXISTS idx_rating_requests_session_id 
ON rating_requests(session_id);

-- used_order_data.order_id
CREATE INDEX IF NOT EXISTS idx_used_order_data_order_id 
ON used_order_data(order_id);

-- valid_data_error_log.resolved_by
CREATE INDEX IF NOT EXISTS idx_valid_data_error_log_resolved_by 
ON valid_data_error_log(resolved_by) 
WHERE resolved_by IS NOT NULL;

-- verification_requests.audited_by
CREATE INDEX IF NOT EXISTS idx_verification_requests_audited_by 
ON verification_requests(audited_by) 
WHERE audited_by IS NOT NULL;

-- wallet_transactions.created_by
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_by 
ON wallet_transactions(created_by) 
WHERE created_by IS NOT NULL;

-- withdrawals.audited_by
CREATE INDEX IF NOT EXISTS idx_withdrawals_audited_by 
ON withdrawals(audited_by) 
WHERE audited_by IS NOT NULL;

-- =====================================================
-- PART 2: Remove Unused Indexes
-- =====================================================

DROP INDEX IF EXISTS idx_admin_group_members_admin_id;
DROP INDEX IF EXISTS idx_commission_audit_log_order_id;
DROP INDEX IF EXISTS idx_commission_audit_log_user_id;
DROP INDEX IF EXISTS idx_customer_service_sessions_employee_id;
DROP INDEX IF EXISTS idx_work_sessions_stale_check;
