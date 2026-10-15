/*
  # Fix cleanup_user_data Function - Remove Invalid References
  
  ## Problem
  The cleanup_user_data() function references:
  1. login_attempts.user_id - Column does not exist (should use 'identifier')
  2. tab_sessions.user_id - Table does not exist
  
  ## Error Message
  "column user_id does not exist"
  
  ## Solution
  Update cleanup_user_data() to:
  1. Use correct column name for login_attempts (identifier instead of user_id)
  2. Remove reference to non-existent tab_sessions table
  3. Keep all other cleanup logic intact
*/

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

  -- FIX: login_attempts uses 'identifier' not 'user_id'
  -- Delete by username match instead
  DELETE FROM login_attempts WHERE identifier = OLD.username;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[EXTRA] Deleted % login attempts', v_deleted_count;

  -- REMOVED: tab_sessions table does not exist
  -- The tab session tracking is handled differently

  -- ========================================================================
  -- ACCOUNT LOCKS
  -- ========================================================================
  
  DELETE FROM account_locks WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  v_total_deleted := v_total_deleted + v_deleted_count;
  RAISE NOTICE '[EXTRA] Deleted % account locks', v_deleted_count;

  -- Clear cleanup mode
  PERFORM set_config('app.in_user_cleanup', 'false', true);
  
  RAISE NOTICE '==========================================';
  RAISE NOTICE '✅ Cleanup completed for user: %', v_user_id;
  RAISE NOTICE 'Total records deleted: %', v_total_deleted;
  RAISE NOTICE '==========================================';

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION cleanup_user_data() IS 
  'Comprehensively cleans up ALL user data when user is deleted.
  
  Triggered when:
  - Super admin deletes an employee
  - Secondary admin deletes their employee  
  - Admin is deleted (CASCADE deletes their employees)
  
  Sets app.in_user_cleanup to bypass wallet protection.
  Cleans 20+ tables including: dispatch, customer service, work sessions, 
  orders, wallets, transactions, verifications, withdrawals, messages, 
  login history, account locks, and all history tables.
  
  Data Safety: Only runs during explicit user deletion by admins.
  
  Fixed in this version:
  - Uses login_attempts.identifier instead of non-existent user_id
  - Removed reference to non-existent tab_sessions table
  - Added account_locks cleanup';
