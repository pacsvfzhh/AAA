/*
  # Comprehensive User Deletion Cleanup Fix

  ## Critical Issue
  The current cleanup_user_data() function is missing several tables, especially:
  - orders_history* tables (NO FOREIGN KEY - data accumulates!)
  - Several CASCADE tables that should be explicitly handled

  ## Problem
  When deleting an employee:
  - History tables (orders_history, orders_history_2025, orders_history_2026) are NOT cleaned
  - These tables have no foreign key constraints
  - Data accumulates indefinitely, causing storage bloat
  - User data remains after deletion (privacy/GDPR violation)

  ## Solution
  Update cleanup_user_data() to include ALL tables with user references:

  ### Tables Added
  1. **History Tables** (CRITICAL - no FK, won't auto-delete):
     - orders_history
     - orders_history_2025
     - orders_history_2026

  2. **Customer Service Tables** (have CASCADE but better to be explicit):
     - customer_service_sessions
     - customer_employee_conversations
     - service_ratings
     - rating_requests

  3. **Dispatch System Tables** (have CASCADE but better to be explicit):
     - dispatch_rate_limits
     - commission_audit_log

  4. **Broadcast System Tables** (have CASCADE but better to be explicit):
     - broadcast_recipients

  ## Benefits
  - ✅ Complete data cleanup - no orphaned records
  - ✅ Privacy compliance - all user data removed
  - ✅ Storage optimization - prevent bloat
  - ✅ Clear audit trail - explicit logging
  - ✅ Fail-safe - even if CASCADE fails, explicit DELETE succeeds

  ## Deletion Order
  Follow dependency order to avoid foreign key violations:
  1. Customer service records (child records first)
  2. Dispatch system records
  3. History records (no dependencies)
  4. Broadcast records
  5. (existing tables...)
*/

-- Update function to clean up ALL user data on deletion
CREATE OR REPLACE FUNCTION cleanup_user_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_deleted_count integer;
BEGIN
  v_user_id := OLD.id;

  -- Log the cleanup operation
  RAISE NOTICE 'Cleaning up data for user: %', v_user_id;

  -- ========================================================================
  -- CUSTOMER SERVICE SYSTEM (delete child records first)
  -- ========================================================================

  -- Delete service ratings (child of customer_employee_conversations)
  DELETE FROM service_ratings WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % service ratings for user: %', v_deleted_count, v_user_id;

  -- Delete rating requests
  DELETE FROM rating_requests WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % rating requests for user: %', v_deleted_count, v_user_id;

  -- Delete customer conversations
  DELETE FROM customer_employee_conversations WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % customer conversations for user: %', v_deleted_count, v_user_id;

  -- Delete customer service sessions
  DELETE FROM customer_service_sessions WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % customer service sessions for user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- BROADCAST SYSTEM
  -- ========================================================================

  -- Delete broadcast recipients
  DELETE FROM broadcast_recipients WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % broadcast recipients for user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- DISPATCH SYSTEM
  -- ========================================================================

  -- Delete dispatch rate limits
  DELETE FROM dispatch_rate_limits WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % dispatch rate limits for user: %', v_deleted_count, v_user_id;

  -- Delete dispatch assignments (派单分配记录)
  DELETE FROM dispatch_assignments WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % dispatch assignments for user: %', v_deleted_count, v_user_id;

  -- Delete dispatch group memberships (分组成员关系)
  DELETE FROM dispatch_group_members WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % dispatch group memberships for user: %', v_deleted_count, v_user_id;

  -- Delete dispatch sessions (派单会话记录)
  DELETE FROM dispatch_sessions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % dispatch sessions for user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- WORK TIME TRACKING
  -- ========================================================================

  -- Delete work sessions (工作时间记录)
  DELETE FROM work_sessions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % work sessions for user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- ORDER DATA
  -- ========================================================================

  -- Delete used order data (已使用的面单数据)
  DELETE FROM used_order_data WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % used order data for user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- CRITICAL: HISTORY TABLES (NO FOREIGN KEY - MUST DELETE EXPLICITLY!)
  -- ========================================================================

  -- Delete from orders_history (main history table)
  DELETE FROM orders_history WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % records from orders_history for user: %', v_deleted_count, v_user_id;

  -- Delete from orders_history_2025 (2025 partition)
  DELETE FROM orders_history_2025 WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % records from orders_history_2025 for user: %', v_deleted_count, v_user_id;

  -- Delete from orders_history_2026 (2026 partition)
  DELETE FROM orders_history_2026 WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % records from orders_history_2026 for user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- MESSAGES SYSTEM
  -- ========================================================================

  -- Delete message recipients (messages sent TO this user)
  DELETE FROM message_recipients WHERE recipient_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % message recipients for user: %', v_deleted_count, v_user_id;

  -- Delete messages sent BY this user
  DELETE FROM messages WHERE sender_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % messages from user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- FINANCIAL SYSTEM
  -- ========================================================================

  -- Delete commission audit log
  DELETE FROM commission_audit_log WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % commission audit log entries for user: %', v_deleted_count, v_user_id;

  -- Delete withdrawal requests
  DELETE FROM withdrawals WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % withdrawals for user: %', v_deleted_count, v_user_id;

  -- Delete wallet transactions
  DELETE FROM wallet_transactions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % wallet transactions for user: %', v_deleted_count, v_user_id;

  -- Delete wallet
  DELETE FROM wallets WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % wallets for user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- VERIFICATION SYSTEM
  -- ========================================================================

  -- Delete verification requests (includes document URLs)
  -- Note: Storage cleanup for verification documents is handled by separate trigger
  DELETE FROM verification_requests WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % verification requests for user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- ORDERS (main table)
  -- ========================================================================

  -- Delete orders from main table
  DELETE FROM orders WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % orders for user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- COMPLETION
  -- ========================================================================

  RAISE NOTICE 'Completed comprehensive cleanup for user: %', v_user_id;

  -- Allow the user deletion to proceed
  RETURN OLD;
END;
$$;

-- Update function comment
COMMENT ON FUNCTION cleanup_user_data() IS
  'Comprehensively cleans up ALL user-related data when a user is deleted.
  Includes: dispatch system, customer service, work sessions, orders (main + history),
  wallet, transactions, verifications, withdrawals, messages, broadcast recipients,
  commission audit logs, and service ratings.
  CRITICAL: Also cleans history tables that have no foreign key constraints.';

-- Verify trigger is still active
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'cleanup_user_data_trigger'
  ) THEN
    CREATE TRIGGER cleanup_user_data_trigger
      BEFORE DELETE ON users
      FOR EACH ROW
      EXECUTE FUNCTION cleanup_user_data();
    RAISE NOTICE 'Created cleanup_user_data_trigger';
  ELSE
    RAISE NOTICE 'cleanup_user_data_trigger already exists';
  END IF;
END $$;
