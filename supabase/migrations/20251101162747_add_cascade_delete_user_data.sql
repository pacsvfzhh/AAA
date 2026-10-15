/*
  # Add Cascade Delete for User Data
  
  1. Overview
    - Automatically clean up all user-related data when a user account is deleted
    - This improves database performance by removing orphaned records
    - Applies to both employee and admin deletions
  
  2. Data Cleaned on User Deletion
    - Orders submitted by the user
    - Wallet and all wallet transactions
    - Verification requests and documents
    - Withdrawal requests
    - Message recipients (messages sent to the user)
    - Messages sent by the user
    - Verification document files from storage
  
  3. Implementation
    - Create a trigger function that executes BEFORE user deletion
    - The function deletes all related data in the correct order
    - Storage files are cleaned up automatically via existing triggers
  
  4. Security
    - Only admins with proper permissions can delete users (enforced by RLS)
    - The cleanup is automatic and cannot be bypassed
    - All deletions are logged via the trigger execution
*/

-- Create function to clean up user data on deletion
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
  
  -- Delete verification documents
  -- Note: Storage cleanup is handled by existing trigger
  DELETE FROM verification_documents WHERE user_id = v_user_id;
  RAISE NOTICE 'Deleted verification documents for user: %', v_user_id;
  
  -- Delete verification requests
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

-- Create trigger on users table
DROP TRIGGER IF EXISTS trigger_cleanup_user_data ON users;
CREATE TRIGGER trigger_cleanup_user_data
  BEFORE DELETE ON users
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_user_data();

-- Add comment
COMMENT ON FUNCTION cleanup_user_data() IS 'Automatically cleans up all user-related data when a user is deleted. Includes orders, wallet, transactions, verifications, withdrawals, and messages.';