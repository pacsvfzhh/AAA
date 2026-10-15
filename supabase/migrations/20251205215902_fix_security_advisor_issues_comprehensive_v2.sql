/*
  # Comprehensive Security and Performance Fixes

  ## 1. Add Missing Foreign Key Indexes
    - `admin_group_members.admin_id`
    - `commission_audit_log.order_id`
    - `commission_audit_log.user_id`
    - `customer_service_sessions.employee_id`

  ## 2. Optimize RLS Policies
    - Consolidate multiple permissive policies on `commission_audit_log`
    - Replace `auth.uid()` with `(select auth.uid())` for better performance

  ## 3. Remove Unused Indexes
    - Drop 16 unused indexes that waste storage and slow down writes

  ## 4. Security Definer Views
    - Views remain as-is (SECURITY DEFINER is required for cross-schema access)

  ## Changes Made
    - Added 4 missing foreign key indexes
    - Consolidated 3 RLS policies into 1 optimized policy
    - Removed 16 unused indexes
    - Improved query performance at scale
*/

-- ============================================================================
-- 1. ADD MISSING FOREIGN KEY INDEXES
-- ============================================================================

-- Index for admin_group_members.admin_id foreign key
CREATE INDEX IF NOT EXISTS idx_admin_group_members_admin_id 
ON admin_group_members(admin_id);

-- Indexes for commission_audit_log foreign keys
CREATE INDEX IF NOT EXISTS idx_commission_audit_log_order_id 
ON commission_audit_log(order_id);

CREATE INDEX IF NOT EXISTS idx_commission_audit_log_user_id 
ON commission_audit_log(user_id);

-- Index for customer_service_sessions.employee_id foreign key
CREATE INDEX IF NOT EXISTS idx_customer_service_sessions_employee_id 
ON customer_service_sessions(employee_id);

-- ============================================================================
-- 2. OPTIMIZE RLS POLICIES ON commission_audit_log
-- ============================================================================

-- Drop existing multiple permissive policies
DROP POLICY IF EXISTS "Users can view their own commission audit logs" ON commission_audit_log;
DROP POLICY IF EXISTS "Admins can view commission audit logs for their users" ON commission_audit_log;
DROP POLICY IF EXISTS "Super admins can view all commission audit logs" ON commission_audit_log;

-- Create single optimized policy that covers all cases
CREATE POLICY "View commission audit logs with optimized RLS"
  ON commission_audit_log
  FOR SELECT
  USING (
    -- Cache auth.uid() once per query for performance
    user_id = (SELECT auth.uid())
    OR
    -- Admins can view logs for their employees (users they created)
    EXISTS (
      SELECT 1 FROM admins a
      WHERE a.id = (SELECT auth.uid())
      AND a.role = 'admin'
      AND EXISTS (
        SELECT 1 FROM users u
        WHERE u.id = commission_audit_log.user_id
        AND u.created_by = a.id
      )
    )
    OR
    -- Super admins can view all logs
    EXISTS (
      SELECT 1 FROM admins a
      WHERE a.id = (SELECT auth.uid())
      AND a.role = 'super_admin'
    )
  );

-- ============================================================================
-- 3. REMOVE UNUSED INDEXES
-- ============================================================================

-- Drop unused indexes that waste storage and slow down INSERT/UPDATE operations
DROP INDEX IF EXISTS idx_account_locks_unlocked_by;
DROP INDEX IF EXISTS idx_admin_groups_created_by;
DROP INDEX IF EXISTS idx_admins_parent_id;
DROP INDEX IF EXISTS idx_broadcast_messages_target_admin_id;
DROP INDEX IF EXISTS idx_bulk_import_log_performed_by;
DROP INDEX IF EXISTS idx_orders_product_type_id;
DROP INDEX IF EXISTS idx_dispatch_group_members_assigned_by;
DROP INDEX IF EXISTS idx_dispatch_group_orders_created_by;
DROP INDEX IF EXISTS idx_dispatch_groups_created_by;
DROP INDEX IF EXISTS idx_dispatch_orders_created_by;
DROP INDEX IF EXISTS idx_rating_requests_session_id;
DROP INDEX IF EXISTS idx_used_order_data_order_id;
DROP INDEX IF EXISTS idx_valid_data_error_log_resolved_by;
DROP INDEX IF EXISTS idx_verification_requests_audited_by;
DROP INDEX IF EXISTS idx_wallet_transactions_created_by;
DROP INDEX IF EXISTS idx_withdrawals_audited_by;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Verify new indexes exist
DO $$
BEGIN
  RAISE NOTICE '=== Foreign Key Indexes Added ===';
  RAISE NOTICE 'idx_admin_group_members_admin_id: %', 
    (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'idx_admin_group_members_admin_id');
  RAISE NOTICE 'idx_commission_audit_log_order_id: %', 
    (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'idx_commission_audit_log_order_id');
  RAISE NOTICE 'idx_commission_audit_log_user_id: %', 
    (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'idx_commission_audit_log_user_id');
  RAISE NOTICE 'idx_customer_service_sessions_employee_id: %', 
    (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'idx_customer_service_sessions_employee_id');
  
  RAISE NOTICE '=== RLS Policy Consolidated ===';
  RAISE NOTICE 'commission_audit_log policies: %', 
    (SELECT COUNT(*) FROM pg_policies WHERE tablename = 'commission_audit_log' AND cmd = 'SELECT');
  
  RAISE NOTICE '=== Unused Indexes Removed ===';
  RAISE NOTICE 'Cleanup complete - 16 unused indexes removed';
END $$;