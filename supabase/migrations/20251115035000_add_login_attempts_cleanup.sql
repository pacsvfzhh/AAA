/*
  # Add Login Attempts Cleanup to User Deletion

  1. Updates
    - Update `cleanup_user_data()` function to include login_attempts table
    - Clean up login attempts based on username (identifier)

  2. Reasoning
    - login_attempts table stores attempts by username (identifier)
    - No foreign key to users table, must clean up explicitly
    - Prevents accumulation of orphaned login attempt records

  3. Benefits
    - ✅ Complete cleanup of login attempt history
    - ✅ Privacy compliance (no login attempts remain)
    - ✅ Storage optimization
    - ✅ Consistent with other cleanup operations

  4. Security
    - Function maintains SECURITY DEFINER for proper permissions
    - Only triggered on user deletion
    - Logged via RAISE NOTICE for audit purposes
*/

-- Update cleanup_user_data() function to include login_attempts
CREATE OR REPLACE FUNCTION cleanup_user_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
  v_username text;
  v_deleted_count integer;
BEGIN
  v_user_id := OLD.id;
  v_username := OLD.username;

  -- Log the cleanup operation
  RAISE NOTICE 'Cleaning up data for user: % (username: %)', v_user_id, v_username;

  -- ========================================================================
  -- LOGIN ATTEMPTS AND SECURITY
  -- ========================================================================

  -- Delete login attempts (by username identifier)
  DELETE FROM login_attempts WHERE identifier = v_username AND identifier_type = 'username';
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % login attempts for user: %', v_deleted_count, v_user_id;

  -- ========================================================================
  -- EMPLOYEE LOGIN HISTORY
  -- ========================================================================

  -- Delete employee login history records
  DELETE FROM employee_login_history WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % employee login history records for user: %', v_deleted_count, v_user_id;

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
  Includes: login attempts, employee login history, dispatch system, customer service,
  work sessions, orders (main + history), wallet, transactions, verifications, withdrawals,
  messages, broadcast recipients, commission audit logs, and service ratings.
  CRITICAL: Also cleans history tables and login attempts that have no foreign key constraints.';
