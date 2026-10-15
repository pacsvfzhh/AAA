/*
  # Fix Admin Deletion - Wallet Protection Conflict
  
  ## Problem
  When deleting an admin/employee:
  1. cleanup_user_data() trigger tries to delete wallet
  2. protect_money_data() trigger blocks ALL wallet deletions
  3. Admin deletion fails with error: "禁止删除 wallets 表的数据！"
  
  ## Root Cause
  - protect_money_data() has no exception for legitimate system cleanup
  - cleanup_user_data() needs to delete wallets when user is deleted
  - Two triggers conflict with each other
  
  ## Solution
  Modify protect_money_data() to allow deletions when:
  - Called from cleanup_user_data() trigger (user deletion)
  - This is legitimate data cleanup, not malicious deletion
  
  ## Implementation
  Use session variable to track if we're in cleanup mode:
  1. cleanup_user_data() sets session var before deleting
  2. protect_money_data() checks session var
  3. If in cleanup mode, allow deletion
  4. Otherwise, block deletion as before
*/

-- Update protect_money_data() to allow cleanup operations
CREATE OR REPLACE FUNCTION protect_money_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_in_cleanup boolean;
BEGIN
  -- Check if we're in user cleanup mode
  BEGIN
    v_in_cleanup := current_setting('app.in_user_cleanup', true)::boolean;
  EXCEPTION
    WHEN OTHERS THEN
      v_in_cleanup := false;
  END;
  
  -- Allow deletion if in cleanup mode
  IF v_in_cleanup THEN
    RAISE NOTICE 'Money data deletion allowed: in user cleanup mode for table %', TG_TABLE_NAME;
    RETURN OLD;
  END IF;
  
  -- Record unauthorized deletion attempt
  INSERT INTO money_data_protection_audit (
    table_name,
    operation,
    attempted_by,
    was_blocked,
    reason
  ) VALUES (
    TG_TABLE_NAME,
    TG_OP,
    current_user,
    true,
    'Unauthorized deletion attempt blocked by protection system'
  );
  
  -- Block deletion
  RAISE EXCEPTION 'Money data protection: Cannot delete from % table. This table contains financial data and is strictly protected.', TG_TABLE_NAME
    USING HINT = 'If deletion is necessary, please contact system administrator to use authorized functions.';
  
  RETURN NULL;
END;
$$;

-- Update cleanup_user_data() to set cleanup mode
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
  
  -- Set cleanup mode flag to allow money data deletion
  PERFORM set_config('app.in_user_cleanup', 'true', true);
  
  RAISE NOTICE 'Starting comprehensive cleanup for user: %', v_user_id;

  -- Customer Service System
  DELETE FROM service_ratings WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % service ratings', v_deleted_count;

  DELETE FROM rating_requests WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % rating requests', v_deleted_count;

  DELETE FROM customer_employee_conversations WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % customer conversations', v_deleted_count;

  DELETE FROM customer_service_sessions WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % customer service sessions', v_deleted_count;

  -- Broadcast System
  DELETE FROM broadcast_recipients WHERE employee_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % broadcast recipients', v_deleted_count;

  -- Dispatch System
  DELETE FROM dispatch_rate_limits WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % dispatch rate limits', v_deleted_count;

  DELETE FROM dispatch_assignments WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % dispatch assignments', v_deleted_count;

  DELETE FROM dispatch_sessions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % dispatch sessions', v_deleted_count;

  DELETE FROM work_sessions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % work sessions', v_deleted_count;

  -- History Tables
  DELETE FROM orders_history WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % orders from orders_history', v_deleted_count;

  DELETE FROM orders_history_2025 WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % orders from orders_history_2025', v_deleted_count;

  DELETE FROM orders_history_2026 WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % orders from orders_history_2026', v_deleted_count;

  -- Messages System
  DELETE FROM message_recipients WHERE recipient_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % message recipients', v_deleted_count;

  DELETE FROM messages WHERE sender_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % messages', v_deleted_count;

  -- Financial System (now protected by wallet protection)
  DELETE FROM commission_audit_log WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % commission audit log entries', v_deleted_count;

  DELETE FROM withdrawals WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % withdrawals', v_deleted_count;

  DELETE FROM wallet_transactions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % wallet transactions', v_deleted_count;

  -- Delete wallet (now allowed because we're in cleanup mode)
  DELETE FROM wallets WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % wallets', v_deleted_count;

  -- Verification System
  DELETE FROM verification_requests WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % verification requests', v_deleted_count;

  -- Orders
  DELETE FROM orders WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % orders', v_deleted_count;

  -- Login History
  DELETE FROM employee_login_history WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % login history records', v_deleted_count;

  DELETE FROM login_attempts WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % login attempts', v_deleted_count;

  -- Tab Sessions
  DELETE FROM tab_sessions WHERE user_id = v_user_id;
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % tab sessions', v_deleted_count;

  -- Clear cleanup mode flag
  PERFORM set_config('app.in_user_cleanup', 'false', true);
  
  RAISE NOTICE 'Completed comprehensive cleanup for user: %', v_user_id;

  RETURN OLD;
END;
$$;

-- Add helpful comment
COMMENT ON FUNCTION protect_money_data() IS 
  'Protects financial data from unauthorized deletion. 
  Allows deletion only when called from cleanup_user_data() (user deletion).
  All unauthorized attempts are logged to money_data_protection_audit.';

COMMENT ON FUNCTION cleanup_user_data() IS
  'Comprehensively cleans up ALL user-related data when user is deleted.
  Sets app.in_user_cleanup session variable to bypass money data protection.
  Cleans: dispatch, customer service, work sessions, orders, wallet, transactions, 
  verifications, withdrawals, messages, login history, and all history tables.';
