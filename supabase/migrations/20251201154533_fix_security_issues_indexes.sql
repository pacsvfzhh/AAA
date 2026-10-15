/*
  # Fix Security Issues - Foreign Key Indexes and Unused Indexes

  1. Add Missing Foreign Key Indexes
    - Add index on `admin_group_members.admin_id` for better join performance
    - Add index on `customer_service_sessions.employee_id` for better join performance

  2. Remove Unused Indexes
    - Remove indexes that are not being used by queries
    - This reduces maintenance overhead and improves write performance

  3. Important Notes
    - Only removing indexes that are confirmed unused
    - Keeping indexes that may be needed for future queries
    - Foreign key indexes are critical for join performance
*/

-- =====================================================
-- PART 1: Add Missing Foreign Key Indexes
-- =====================================================

-- Index for admin_group_members.admin_id foreign key
-- This improves performance when querying group members by admin
CREATE INDEX IF NOT EXISTS idx_admin_group_members_admin_id
ON admin_group_members(admin_id);

-- Index for customer_service_sessions.employee_id foreign key
-- This improves performance when querying sessions by employee
CREATE INDEX IF NOT EXISTS idx_customer_service_sessions_employee_id
ON customer_service_sessions(employee_id);

-- =====================================================
-- PART 2: Remove Unused Indexes
-- =====================================================

-- Remove unused indexes that are not improving query performance
-- These indexes add overhead to INSERT/UPDATE/DELETE operations

-- Account locks - unlocked_by is rarely queried alone
DROP INDEX IF EXISTS idx_account_locks_unlocked_by;

-- Admin groups - created_by is rarely queried alone
DROP INDEX IF EXISTS idx_admin_groups_created_by;

-- Admins - parent_id index (keeping this one as it may be used for hierarchical queries)
-- DROP INDEX IF EXISTS idx_admins_parent_id;  -- KEEP for potential hierarchy queries

-- Broadcast messages - target_admin_id is rarely queried alone
DROP INDEX IF EXISTS idx_broadcast_messages_target_admin_id;

-- Bulk import log - performed_by is rarely queried alone
DROP INDEX IF EXISTS idx_bulk_import_log_performed_by;

-- Commission audit log - transaction_id is rarely queried alone
DROP INDEX IF EXISTS idx_commission_audit_log_transaction_id;

-- Dispatch group members - assigned_by is rarely queried alone
DROP INDEX IF EXISTS idx_dispatch_group_members_assigned_by;

-- Dispatch group orders - created_by is rarely queried alone
DROP INDEX IF EXISTS idx_dispatch_group_orders_created_by;

-- Dispatch groups - created_by is rarely queried alone
DROP INDEX IF EXISTS idx_dispatch_groups_created_by;

-- Dispatch orders - created_by is rarely queried alone
DROP INDEX IF EXISTS idx_dispatch_orders_created_by;

-- Orders - product_type_id (keeping this one as it may be used for filtering)
-- DROP INDEX IF EXISTS idx_orders_product_type_id;  -- KEEP for product filtering

-- Rating requests - session_id is rarely queried alone
DROP INDEX IF EXISTS idx_rating_requests_session_id;

-- Used order data - order_id is rarely queried alone
DROP INDEX IF EXISTS idx_used_order_data_order_id;

-- Valid data error log - resolved_by is rarely queried alone
DROP INDEX IF EXISTS idx_valid_data_error_log_resolved_by;

-- Verification requests - audited_by is rarely queried alone
DROP INDEX IF EXISTS idx_verification_requests_audited_by;

-- Wallet transactions - created_by is rarely queried alone
DROP INDEX IF EXISTS idx_wallet_transactions_created_by;

-- Withdrawals - audited_by is rarely queried alone
DROP INDEX IF EXISTS idx_withdrawals_audited_by;

-- =====================================================
-- PART 3: Add Comments
-- =====================================================

COMMENT ON INDEX idx_admin_group_members_admin_id IS 'Improves performance for foreign key joins on admin_id';
COMMENT ON INDEX idx_customer_service_sessions_employee_id IS 'Improves performance for foreign key joins on employee_id';
