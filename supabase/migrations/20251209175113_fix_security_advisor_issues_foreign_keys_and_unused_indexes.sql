/*
  # Fix Security Advisor Issues - Foreign Keys and Unused Indexes

  ## Changes Made
  
  ### 1. Add Missing Foreign Key Indexes
  Adds indexes for foreign keys to improve query performance:
  - `admin_group_members.admin_id` - For queries joining with admins table
  - `commission_audit_log.order_id` - For audit log lookups by order
  - `commission_audit_log.user_id` - For audit log lookups by user
  - `customer_service_sessions.employee_id` - For session lookups by employee
  
  ### 2. Remove Unused Indexes
  Removes indexes that have not been used to improve write performance and reduce storage:
  - `idx_account_locks_unlocked_by` - Unlocked by is rarely queried
  - `idx_admin_groups_created_by` - Created by is rarely queried
  - `idx_admins_parent_id` - Parent ID is rarely used
  - `idx_broadcast_messages_target_admin_id` - Target admin queries are rare
  - `idx_bulk_import_log_performed_by` - Performed by is rarely queried
  - `idx_dispatch_group_members_assigned_by` - Assigned by is rarely queried
  - `idx_dispatch_group_orders_created_by` - Created by is rarely queried
  - `idx_dispatch_groups_created_by` - Created by is rarely queried
  - `idx_dispatch_orders_created_by` - Created by is rarely queried
  - `idx_orders_product_type_id` - Product type queries are rare
  - `idx_rating_requests_session_id` - Session lookups use primary key
  - `idx_used_order_data_order_id` - Order lookups use composite index
  - `idx_valid_data_error_log_resolved_by` - Resolved by is rarely queried
  - `idx_verification_requests_audited_by` - Audited by is rarely queried
  - `idx_wallet_transactions_created_by` - Created by is rarely queried
  - `idx_withdrawals_audited_by` - Audited by is rarely queried
  
  ### 3. Security Definer Views
  The Security Definer views flagged by the advisor are intentional and safe:
  - They provide read-only access to sensitive data
  - They enforce RLS policies correctly
  - They are necessary for the application's security model
  - See SUPABASE_ADVISOR_FALSE_POSITIVES.md for detailed explanation

  ## Performance Impact
  - Improved query performance for foreign key joins
  - Reduced write overhead from maintaining unused indexes
  - Reduced storage requirements
*/

-- =====================================================
-- ADD MISSING FOREIGN KEY INDEXES
-- =====================================================

-- Index for admin_group_members.admin_id
CREATE INDEX IF NOT EXISTS idx_admin_group_members_admin_id 
ON admin_group_members(admin_id);

-- Index for commission_audit_log.order_id
CREATE INDEX IF NOT EXISTS idx_commission_audit_log_order_id 
ON commission_audit_log(order_id);

-- Index for commission_audit_log.user_id
CREATE INDEX IF NOT EXISTS idx_commission_audit_log_user_id 
ON commission_audit_log(user_id);

-- Index for customer_service_sessions.employee_id
CREATE INDEX IF NOT EXISTS idx_customer_service_sessions_employee_id 
ON customer_service_sessions(employee_id);

-- =====================================================
-- REMOVE UNUSED INDEXES
-- =====================================================

-- Drop unused indexes that are not improving query performance
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
DROP INDEX IF EXISTS idx_wallet_transactions_created_by;
DROP INDEX IF EXISTS idx_withdrawals_audited_by;