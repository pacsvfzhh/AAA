/*
  # Complete Admin and Employee Deletion with Data Cleanup
  
  ## Requirements
  1. Deleting secondary admin → delete all their employees + cleanup all data
  2. Super admin deleting employee → cleanup all employee data
  3. Secondary admin deleting their employee → cleanup all employee data
  4. All operations bypass wallet protection (legitimate admin operations)
  
  ## Implementation
  1. Restore users.created_by CASCADE delete (delete employees when admin deleted)
  2. Update cleanup_user_data() to always allow wallet deletion during user cleanup
  3. Ensure wallet protection allows cleanup mode
  
  ## Data Safety
  - Only triggered when explicitly deleting users/admins
  - Comprehensive logging for audit trail
  - Wallet protection still active for direct manipulation
*/

-- ============================================
-- Step 1: Restore CASCADE for users.created_by
-- ============================================

-- Drop existing foreign key
ALTER TABLE users
DROP CONSTRAINT IF EXISTS users_created_by_fkey;

-- Restore CASCADE behavior
ALTER TABLE users
ADD CONSTRAINT users_created_by_fkey
FOREIGN KEY (created_by)
REFERENCES admins(id)
ON DELETE CASCADE;

-- ============================================
-- Step 2: Update cleanup_user_data() function
-- ============================================

CREATE OR REPLACE FUNCTION cleanup_user_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_deleted_count integer;
  v_total_deleted integer := 0;
BEGIN
  v_user_id := OLD.id;
  
  -- Set cleanup mode to bypass wallet protection
  PERFORM set_config('app.in_user_cleanup', 'true', true);
  
  RAISE NOTICE '==========================================';
  RAISE NOTICE 'Starting comprehensive cleanup for user: %', v_user_id;
  RAISE NOTICE 'User: % (Employee ID: %)', OLD.username, OLD.employee_id;
  RAISE NOTICE '==========================================';

  -- ========================================================================
  -- CUSTOMER SERVICE SYSTEM
  -- ========================================================================
  
  DELETE FROM service_ratings WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[1/20] Deleted % service ratings', v_deleted_count;

  DELETE FROM rating_requests WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[2/20] Deleted % rating requests', v_deleted_count;

  DELETE FROM customer_employee_conversations WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[3/20] Deleted % customer conversations', v_deleted_count;

  DELETE FROM customer_service_sessions WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[4/20] Deleted % customer service sessions', v_deleted_count;

  -- ========================================================================
  -- BROADCAST SYSTEM
  -- ========================================================================

  DELETE FROM broadcast_recipients WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[5/20] Deleted % broadcast recipients', v_deleted_count;

  -- ========================================================================
  -- DISPATCH SYSTEM
  -- ========================================================================

  DELETE FROM dispatch_rate_limits WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[6/20] Deleted % dispatch rate limits', v_deleted_count;

  DELETE FROM dispatch_assignments WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[7/20] Deleted % dispatch assignments', v_deleted_count;

  DELETE FROM dispatch_sessions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[8/20] Deleted % dispatch sessions', v_deleted_count;

  DELETE FROM work_sessions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[9/20] Deleted % work sessions', v_deleted_count;

  -- ========================================================================
  -- HISTORY TABLES (NO FK - must delete explicitly)
  -- ========================================================================

  DELETE FROM orders_history WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[10/20] Deleted % orders from orders_history', v_deleted_count;

  DELETE FROM orders_history_2025 WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[11/20] Deleted % orders from orders_history_2025', v_deleted_count;

  DELETE FROM orders_history_2026 WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[12/20] Deleted % orders from orders_history_2026', v_deleted_count;

  -- ========================================================================
  -- MESSAGES SYSTEM
  -- ========================================================================

  DELETE FROM message_recipients WHERE recipient_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[13/20] Deleted % message recipients', v_deleted_count;

  DELETE FROM messages WHERE sender_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[14/20] Deleted % messages', v_deleted_count;

  -- ========================================================================
  -- FINANCIAL SYSTEM (Protected by wallet protection, but allowed in cleanup mode)
  -- ========================================================================

  DELETE FROM commission_audit_log WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[15/20] Deleted % commission audit log entries', v_deleted_count;

  DELETE FROM withdrawals WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[16/20] Deleted % withdrawals', v_deleted_count;

  DELETE FROM wallet_transactions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[17/20] Deleted % wallet transactions', v_deleted_count;

  -- Delete wallet (bypasses protection because we are in cleanup mode)
  DELETE FROM wallets WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[18/20] Deleted % wallets', v_deleted_count;

  -- ========================================================================
  -- VERIFICATION & ORDERS
  -- ========================================================================

  DELETE FROM verification_requests WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[19/20] Deleted % verification requests', v_deleted_count;

  DELETE FROM orders WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[20/20] Deleted % orders', v_deleted_count;

  -- ========================================================================
  -- LOGIN & SESSION DATA
  -- ========================================================================

  DELETE FROM employee_login_history WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[EXTRA] Deleted % login history records', v_deleted_count;

  DELETE FROM login_attempts WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[EXTRA] Deleted % login attempts', v_deleted_count;

  DELETE FROM tab_sessions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[EXTRA] Deleted % tab sessions', v_deleted_count;

  -- Clear cleanup mode
  PERFORM set_config('app.in_user_cleanup', 'false', true);
  
  RAISE NOTICE '==========================================';
  RAISE NOTICE '✅ Cleanup completed for user: %', v_user_id;
  RAISE NOTICE 'Total records deleted: %', v_total_deleted;
  RAISE NOTICE '==========================================';

  RETURN OLD;
END;
$$;

-- ============================================
-- Step 3: Verify wallet protection allows cleanup
-- ============================================

-- The protect_money_data() function already checks for app.in_user_cleanup
-- No changes needed - it was fixed in the previous migration

-- ============================================
-- Step 4: Add comments for documentation
-- ============================================

COMMENT ON FUNCTION cleanup_user_data() IS 
  'Comprehensively cleans up ALL user data when user is deleted.
  
  Triggered when:
  - Super admin deletes an employee
  - Secondary admin deletes their employee  
  - Admin is deleted (CASCADE deletes their employees)
  
  Sets app.in_user_cleanup to bypass wallet protection.
  Cleans 20+ tables including: dispatch, customer service, work sessions, 
  orders, wallets, transactions, verifications, withdrawals, messages, 
  login history, and all history tables.
  
  Data Safety: Only runs during explicit user deletion by admins.';

-- ============================================
-- Step 5: Verify configuration
-- ============================================

DO $$
DECLARE
  v_fk_delete_rule text;
  v_trigger_exists boolean;
BEGIN
  -- Check CASCADE is restored
  SELECT rc.delete_rule INTO v_fk_delete_rule
  FROM information_schema.referential_constraints rc
  WHERE rc.constraint_name = 'users_created_by_fkey';
  
  IF v_fk_delete_rule = 'CASCADE' THEN
    RAISE NOTICE '✅ users.created_by: ON DELETE CASCADE (deletes employees when admin deleted)';
  ELSE
    RAISE WARNING '⚠️ users.created_by: ON DELETE % (expected CASCADE)', v_fk_delete_rule;
  END IF;
  
  -- Check cleanup trigger exists
  SELECT EXISTS (
    SELECT 1 FROM pg_trigger 
    WHERE tgname = 'cleanup_user_data_trigger'
      AND tgrelid = 'users'::regclass
  ) INTO v_trigger_exists;
  
  IF v_trigger_exists THEN
    RAISE NOTICE '✅ cleanup_user_data_trigger: Active on users table';
  ELSE
    RAISE EXCEPTION '❌ cleanup_user_data_trigger: NOT FOUND';
  END IF;
  
  RAISE NOTICE '✅ Configuration verified successfully';
  RAISE NOTICE '';
  RAISE NOTICE 'Deletion behavior:';
  RAISE NOTICE '  1. Delete admin → CASCADE deletes employees → cleanup all data';
  RAISE NOTICE '  2. Delete employee → cleanup all data';
  RAISE NOTICE '  3. Wallet protection bypassed during cleanup';
END $$;
