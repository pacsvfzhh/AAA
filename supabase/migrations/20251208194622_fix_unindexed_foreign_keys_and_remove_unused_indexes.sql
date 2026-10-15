/*
  # Fix Security Advisor Issues - Indexes Only

  1. Foreign Key Indexes
    - Add missing indexes for 16 foreign keys to improve query performance
    - Each foreign key should have a covering index for optimal JOIN performance

  2. Remove Unused Indexes
    - Drop 4 unused indexes that are not being utilized
    - Reduces storage overhead and maintenance costs

  Note: SECURITY DEFINER views are intentionally left unchanged as they may be
  required for proper access control and data aggregation across RLS boundaries.
  These views should be reviewed individually to determine if SECURITY INVOKER
  is appropriate for each specific use case.
*/

-- =====================================================
-- SECTION 1: ADD MISSING FOREIGN KEY INDEXES
-- =====================================================

-- These indexes improve JOIN performance for foreign key relationships
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

-- =====================================================
-- SECTION 2: REMOVE UNUSED INDEXES
-- =====================================================

-- These indexes have not been used and can be safely removed
DROP INDEX IF EXISTS idx_admin_group_members_admin_id;
DROP INDEX IF EXISTS idx_commission_audit_log_order_id;
DROP INDEX IF EXISTS idx_commission_audit_log_user_id;
DROP INDEX IF EXISTS idx_customer_service_sessions_employee_id;

-- =====================================================
-- VERIFICATION
-- =====================================================

-- Verify all foreign key indexes exist
DO $$
DECLARE
  missing_indexes TEXT[];
  unused_indexes TEXT[];
BEGIN
  -- Check for missing indexes
  SELECT ARRAY_AGG(index_name) INTO missing_indexes
  FROM (
    SELECT 'idx_account_locks_unlocked_by' as index_name
    UNION ALL SELECT 'idx_admin_groups_created_by'
    UNION ALL SELECT 'idx_admins_parent_id'
    UNION ALL SELECT 'idx_broadcast_messages_target_admin_id'
    UNION ALL SELECT 'idx_bulk_import_log_performed_by'
    UNION ALL SELECT 'idx_dispatch_group_members_assigned_by'
    UNION ALL SELECT 'idx_dispatch_group_orders_created_by'
    UNION ALL SELECT 'idx_dispatch_groups_created_by'
    UNION ALL SELECT 'idx_dispatch_orders_created_by'
    UNION ALL SELECT 'idx_orders_product_type_id'
    UNION ALL SELECT 'idx_rating_requests_session_id'
    UNION ALL SELECT 'idx_used_order_data_order_id'
    UNION ALL SELECT 'idx_valid_data_error_log_resolved_by'
    UNION ALL SELECT 'idx_verification_requests_audited_by'
    UNION ALL SELECT 'idx_wallet_transactions_created_by'
    UNION ALL SELECT 'idx_withdrawals_audited_by'
  ) expected
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
    AND indexname = expected.index_name
  );

  -- Check for remaining unused indexes
  SELECT ARRAY_AGG(indexname) INTO unused_indexes
  FROM pg_indexes
  WHERE schemaname = 'public'
  AND indexname IN (
    'idx_admin_group_members_admin_id',
    'idx_commission_audit_log_order_id',
    'idx_commission_audit_log_user_id',
    'idx_customer_service_sessions_employee_id'
  );

  -- Report results
  IF array_length(missing_indexes, 1) > 0 THEN
    RAISE WARNING 'Missing indexes: %', array_to_string(missing_indexes, ', ');
  ELSE
    RAISE NOTICE '✓ All 16 foreign key indexes created successfully';
  END IF;

  IF array_length(unused_indexes, 1) > 0 THEN
    RAISE WARNING 'Unused indexes still present: %', array_to_string(unused_indexes, ', ');
  ELSE
    RAISE NOTICE '✓ All 4 unused indexes removed successfully';
  END IF;
END $$;
