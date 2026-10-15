/*
  # Fix Cascade Delete for User Data
  
  1. Overview
    - Fix the cleanup_user_data function to remove reference to non-existent table
    - The verification_documents table doesn't exist - documents are stored as URLs in verification_requests
  
  2. Changes
    - Remove the line that tries to delete from verification_documents table
    - Keep all other cleanup operations intact
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
COMMENT ON FUNCTION cleanup_user_data() IS 'Automatically cleans up all user-related data when a user is deleted. Includes orders, wallet, transactions, verifications, withdrawals, and messages.';