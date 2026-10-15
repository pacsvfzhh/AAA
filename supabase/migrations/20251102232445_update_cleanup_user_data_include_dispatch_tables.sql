/*
  # Update cleanup_user_data Function to Include Dispatch Tables
  
  1. Overview
    - Update the cleanup_user_data function to explicitly handle new dispatch system tables
    - Although CASCADE is set on foreign keys, explicit cleanup ensures proper order
    - This prevents potential issues with complex foreign key relationships
  
  2. Tables Added to Cleanup
    - dispatch_assignments - All assignments for the user
    - dispatch_group_members - Group memberships for the user
    - dispatch_sessions - Dispatch sessions for the user
    - work_sessions - Work time tracking sessions for the user
    - used_order_data - Used order data records for the user
  
  3. Cleanup Order
    - Follow dependency order to avoid foreign key violations
    - Delete child records before parent records
    - Use explicit DELETE statements for clarity and logging
  
  4. Notes
    - The BEFORE DELETE trigger ensures cleanup happens automatically
    - Logging statements help with debugging and audit trails
    - CASCADE on foreign keys provides a safety net
*/

-- Update function to clean up user data on deletion
CREATE OR REPLACE FUNCTION cleanup_user_data()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := OLD.id;
  
  -- Log the cleanup operation
  RAISE NOTICE 'Cleaning up data for user: %', v_user_id;
  
  -- Delete dispatch assignments (派单分配记录)
  DELETE FROM dispatch_assignments WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted dispatch assignments for user: %', v_user_id;
  
  -- Delete dispatch group memberships (分组成员关系)
  DELETE FROM dispatch_group_members WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted dispatch group memberships for user: %', v_user_id;
  
  -- Delete dispatch sessions (派单会话记录)
  DELETE FROM dispatch_sessions WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted dispatch sessions for user: %', v_user_id;
  
  -- Delete work sessions (工作时间记录)
  DELETE FROM work_sessions WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted work sessions for user: %', v_user_id;
  
  -- Delete used order data (已使用的面单数据)
  DELETE FROM used_order_data WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted used order data for user: %', v_user_id;
  
  -- Delete message recipients (messages sent TO this user)
  DELETE FROM message_recipients WHERE recipient_id = v_user_id;
  RAISE NOTICE 'Deleted message recipients for user: %', v_user_id;
  
  -- Delete messages sent BY this user
  DELETE FROM messages WHERE sender_id = v_user_id;
  RAISE NOTICE 'Deleted messages from user: %', v_user_id;
  
  -- Delete withdrawal requests
  DELETE FROM withdrawals WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted withdrawals for user: %', v_user_id;
  
  -- Delete verification requests (includes document URLs)
  -- Note: Storage cleanup for verification documents is handled by existing trigger
  DELETE FROM verification_requests WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted verification requests for user: %', v_user_id;
  
  -- Delete wallet transactions
  DELETE FROM wallet_transactions WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted wallet transactions for user: %', v_user_id;
  
  -- Delete wallet
  DELETE FROM wallets WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted wallet for user: %', v_user_id;
  
  -- Delete orders
  DELETE FROM orders WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted orders for user: %', v_user_id;
  
  RAISE NOTICE 'Completed cleanup for user: %', v_user_id;
  
  -- Allow the user deletion to proceed
  RETURN OLD;
END;
$$;

-- Comment
COMMENT ON FUNCTION cleanup_user_data() IS 'Automatically cleans up all user-related data when a user is deleted. Includes dispatch assignments, group memberships, sessions, orders, wallet, transactions, verifications, withdrawals, and messages.';
