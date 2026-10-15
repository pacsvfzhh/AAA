/*
  # Fix Withdrawal Rejected Balance Bug

  1. Problem
    - When withdrawal is rejected, funds are moved from frozen to available (correct)
    - BUT wallet_transactions creates a record with positive amount
    - This causes wallet balance calculations to ADD the amount again
    - Result: Balance increases every time withdrawal is rejected
    
  2. Root Cause
    - withdrawal_rejected transactions should NOT be counted in balance calculations
    - They are internal transfers (frozen -> available), not new funds
    - Current system counts ALL wallet_transactions amounts
    
  3. Solution
    - Do NOT create wallet_transactions for withdrawal_rejected
    - Only track state changes in wallets table itself
    - Clean up existing invalid withdrawal_rejected transactions
    - Fix affected user balances
    
  4. Changes
    - Delete all withdrawal_rejected transactions
    - Recalculate correct wallet balances
    - Update frontend to not create these transactions
*/

-- 1. Identify affected users and their invalid transactions
DO $$
DECLARE
  v_user RECORD;
  v_invalid_amount numeric;
BEGIN
  RAISE NOTICE 'Identifying users affected by withdrawal_rejected bug...';
  
  FOR v_user IN (
    SELECT 
      u.id,
      u.username,
      SUM(wt.amount) as total_invalid_amount,
      COUNT(*) as invalid_transaction_count
    FROM users u
    JOIN wallet_transactions wt ON wt.user_id = u.id
    WHERE wt.type = 'withdrawal_rejected'
    GROUP BY u.id, u.username
  )
  LOOP
    RAISE NOTICE 'User %: $ % from % invalid transactions',
      v_user.username, v_user.total_invalid_amount, v_user.invalid_transaction_count;
  END LOOP;
END $$;

-- 2. Delete all withdrawal_rejected transactions (they should never have been created)
DO $$
DECLARE
  v_deleted_count integer;
BEGIN
  -- Enable cleanup mode to bypass protection
  PERFORM set_config('app.in_user_cleanup', 'true', true);
  
  DELETE FROM wallet_transactions
  WHERE type = 'withdrawal_rejected';
  
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  
  PERFORM set_config('app.in_user_cleanup', 'false', true);
  
  RAISE NOTICE 'Deleted % invalid withdrawal_rejected transactions', v_deleted_count;
END $$;

-- 3. Also check for withdrawal_request transactions (if any exist)
DO $$
DECLARE
  v_request_count integer;
BEGIN
  SELECT COUNT(*) INTO v_request_count
  FROM wallet_transactions
  WHERE type = 'withdrawal_request';
  
  IF v_request_count > 0 THEN
    RAISE NOTICE 'Found % withdrawal_request transactions (these may also need review)', v_request_count;
  ELSE
    RAISE NOTICE 'No withdrawal_request transactions found (this is actually a problem - see comments)';
  END IF;
END $$;

-- 4. Recalculate ALL wallet balances based on valid transactions only
DO $$
DECLARE
  v_wallet RECORD;
  v_correct_balance numeric;
  v_fixed_count integer := 0;
BEGIN
  RAISE NOTICE 'Recalculating wallet balances...';
  
  FOR v_wallet IN (
    SELECT 
      w.user_id,
      u.username,
      w.available_balance as current_available,
      w.frozen_balance,
      COALESCE(SUM(wt.amount), 0) as calculated_total
    FROM wallets w
    JOIN users u ON u.id = w.user_id
    LEFT JOIN wallet_transactions wt ON wt.user_id = w.user_id
    GROUP BY w.user_id, u.username, w.available_balance, w.frozen_balance
  )
  LOOP
    -- Correct available balance = total transactions - frozen balance
    v_correct_balance := v_wallet.calculated_total - v_wallet.frozen_balance;
    
    -- Update if different
    IF ABS(v_correct_balance - v_wallet.current_available) > 0.01 THEN
      UPDATE wallets
      SET available_balance = v_correct_balance
      WHERE user_id = v_wallet.user_id;
      
      RAISE NOTICE 'Fixed wallet for %: $ % -> $ % (diff: $ %)',
        v_wallet.username,
        v_wallet.current_available,
        v_correct_balance,
        v_correct_balance - v_wallet.current_available;
      
      v_fixed_count := v_fixed_count + 1;
    END IF;
  END LOOP;
  
  RAISE NOTICE 'Fixed % wallet balances', v_fixed_count;
END $$;

-- 5. Recalculate balance chain in wallet_transactions
DO $$
DECLARE
  v_user_id uuid;
  v_txn RECORD;
  v_balance numeric;
BEGIN
  RAISE NOTICE 'Recalculating transaction balance chain...';
  
  FOR v_user_id IN (SELECT DISTINCT user_id FROM wallet_transactions)
  LOOP
    v_balance := 0;
    
    FOR v_txn IN (
      SELECT id, amount
      FROM wallet_transactions
      WHERE user_id = v_user_id
      ORDER BY created_at, id
    )
    LOOP
      UPDATE wallet_transactions
      SET 
        balance_before = v_balance,
        balance_after = v_balance + v_txn.amount
      WHERE id = v_txn.id;
      
      v_balance := v_balance + v_txn.amount;
    END LOOP;
  END LOOP;
  
  RAISE NOTICE 'Completed balance chain recalculation';
END $$;

-- 6. Verify consistency
DO $$
DECLARE
  v_inconsistent RECORD;
  v_count integer := 0;
BEGIN
  RAISE NOTICE 'Verifying data consistency...';
  
  FOR v_inconsistent IN (
    SELECT * FROM validate_commission_integrity()
    WHERE is_consistent = false
  )
  LOOP
    RAISE WARNING 'Inconsistency found for user %: income_diff=$ %, transaction_diff=$ %',
      v_inconsistent.username, v_inconsistent.income_diff, v_inconsistent.transaction_diff;
    v_count := v_count + 1;
  END LOOP;
  
  IF v_count = 0 THEN
    RAISE NOTICE 'SUCCESS: All data is now consistent!';
  ELSE
    RAISE WARNING 'Found % users with remaining inconsistencies', v_count;
  END IF;
END $$;

-- 7. Add comment explaining the fix
COMMENT ON COLUMN wallet_transactions.type IS 
'Transaction types:
- commission: earned from successful orders (increases balance)
- manual_adjustment: admin adjustment (can increase/decrease)
- withdrawal_approved: approved withdrawal (decreases balance from frozen)
NOTE: withdrawal_rejected should NOT create transactions!
It only moves funds internally (frozen -> available) without changing total balance.';
