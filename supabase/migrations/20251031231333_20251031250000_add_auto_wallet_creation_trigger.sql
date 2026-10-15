/*
  # Add Auto-Wallet Creation Trigger for New Users

  ## Purpose
  Automatically create a wallet when a new user (employee) is created.
  This prevents issues where employees cannot perform operations that require a wallet.

  ## Changes
  
  1. **New Function: `create_wallet_for_new_user()`**
     - Automatically creates a wallet entry when a new user is inserted
     - Initializes with zero balances
     - Runs after user insert operation
  
  2. **New Trigger: `create_wallet_trigger`**
     - Fires after INSERT on users table
     - Calls the wallet creation function
     - Ensures every user has a wallet immediately after creation

  ## Benefits
  - Prevents "wallet not found" errors
  - Ensures data consistency
  - Simplifies employee creation process
  - No manual wallet creation needed

  ## Security
  - Function runs with definer privileges
  - Only creates wallet, doesn't modify other data
  - Works within existing RLS policies
*/

-- Create function to automatically create wallet for new users
CREATE OR REPLACE FUNCTION create_wallet_for_new_user()
RETURNS TRIGGER AS $$
BEGIN
  -- Insert wallet for the new user
  INSERT INTO wallets (user_id, available_balance, frozen_balance)
  VALUES (NEW.id, 0, 0)
  ON CONFLICT (user_id) DO NOTHING;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to call the function after user insert
DROP TRIGGER IF EXISTS create_wallet_trigger ON users;
CREATE TRIGGER create_wallet_trigger
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION create_wallet_for_new_user();

-- Verify trigger was created
SELECT 
  trigger_name,
  event_manipulation,
  event_object_table,
  action_timing
FROM information_schema.triggers
WHERE event_object_table = 'users'
  AND trigger_name = 'create_wallet_trigger';
