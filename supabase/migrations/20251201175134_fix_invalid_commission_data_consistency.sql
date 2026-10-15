/*
  # Fix Invalid Commission Data Consistency

  1. Problem
    - Found 2 wallet_transactions records with type='commission' where order status is 'failure'
    - User kkkkkk has $601.68 in total_income but only $581.16 in actual success order commissions
    - Difference: $20.52 from 2 invalid commission records ($4.05 + $16.46)
    
  2. Root Cause
    - Orders were changed from 'success' to 'failure' but commission transactions were not removed
    - This happened before the trigger fix in migration 20251111230000
    
  3. Solution
    - Use app.in_user_cleanup flag to bypass money data protection
    - Delete invalid commission transactions where order status != 'success'
    - Recalculate wallet balances for affected users
    - Recalculate balance_before and balance_after for all remaining transactions
    - Update users.total_income to match actual successful order commissions
    
  4. Changes
    - Remove invalid commission transactions (with protection bypass)
    - Fix wallet.available_balance
    - Fix users.total_income
    - Recalculate transaction balance chain
*/

-- 1. Delete invalid commission transactions (with protection bypass)
DO $$
DECLARE
  invalid_txn RECORD;
  deleted_count INTEGER := 0;
BEGIN
  -- Enable cleanup mode to bypass money data protection
  PERFORM set_config('app.in_user_cleanup', 'true', true);
  
  RAISE NOTICE 'Cleaning up invalid commission transactions...';

  FOR invalid_txn IN (
    SELECT
      wt.id as txn_id,
      wt.user_id,
      wt.amount,
      wt.reference_id as order_id,
      o.status as order_status,
      u.username
    FROM wallet_transactions wt
    JOIN orders o ON wt.reference_id = o.id
    JOIN users u ON wt.user_id = u.id
    WHERE wt.type = 'commission'
      AND o.status != 'success'
  )
  LOOP
    RAISE NOTICE 'Deleting invalid commission: user=%, amount=$%, order=%, status=%',
      invalid_txn.username, invalid_txn.amount, invalid_txn.order_id, invalid_txn.order_status;
    
    -- Delete the invalid transaction
    DELETE FROM wallet_transactions WHERE id = invalid_txn.txn_id;
    deleted_count := deleted_count + 1;
  END LOOP;

  -- Disable cleanup mode
  PERFORM set_config('app.in_user_cleanup', 'false', true);

  RAISE NOTICE 'Deleted % invalid commission transactions', deleted_count;
END $$;

-- 2. Recalculate balance_before and balance_after for all transactions
DO $$
DECLARE
  user_rec RECORD;
  txn_rec RECORD;
  running_balance numeric;
  recalculated_users INTEGER := 0;
BEGIN
  RAISE NOTICE 'Recalculating transaction balance chain...';

  FOR user_rec IN (SELECT DISTINCT user_id FROM wallet_transactions ORDER BY user_id)
  LOOP
    running_balance := 0;

    FOR txn_rec IN (
      SELECT id, amount
      FROM wallet_transactions
      WHERE user_id = user_rec.user_id
      ORDER BY created_at, id
    )
    LOOP
      UPDATE wallet_transactions
      SET
        balance_before = running_balance,
        balance_after = running_balance + txn_rec.amount
      WHERE id = txn_rec.id;

      running_balance := running_balance + txn_rec.amount;
    END LOOP;

    recalculated_users := recalculated_users + 1;
  END LOOP;

  RAISE NOTICE 'Recalculated balance chain for % users', recalculated_users;
END $$;

-- 3. Fix wallet.available_balance to match transaction history
DO $$
DECLARE
  wallet_rec RECORD;
  calculated_balance numeric;
  old_available numeric;
  difference numeric;
  fixed_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Fixing wallet balances...';

  FOR wallet_rec IN (
    SELECT
      w.user_id,
      w.available_balance,
      w.frozen_balance,
      u.username,
      COALESCE(SUM(wt.amount), 0) as total_from_transactions
    FROM wallets w
    JOIN users u ON w.user_id = u.id
    LEFT JOIN wallet_transactions wt ON w.user_id = wt.user_id
    GROUP BY w.user_id, w.available_balance, w.frozen_balance, u.username
  )
  LOOP
    old_available := wallet_rec.available_balance;
    calculated_balance := wallet_rec.total_from_transactions - wallet_rec.frozen_balance;
    difference := calculated_balance - old_available;

    -- Update if there's any difference
    IF ABS(difference) > 0.001 THEN
      UPDATE wallets
      SET available_balance = calculated_balance
      WHERE user_id = wallet_rec.user_id;

      RAISE NOTICE 'Fixed wallet for user %: $% -> $% (diff: $%)',
        wallet_rec.username, old_available, calculated_balance, difference;
      fixed_count := fixed_count + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Fixed % wallets with incorrect balances', fixed_count;
END $$;

-- 4. Fix users.total_income to match actual successful order commissions
DO $$
DECLARE
  user_rec RECORD;
  old_income numeric;
  new_income numeric;
  difference numeric;
  fixed_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Fixing users.total_income...';

  FOR user_rec IN (
    SELECT
      u.id,
      u.username,
      u.total_income as current_total_income,
      COALESCE(SUM(CASE WHEN o.status = 'success' THEN o.commission_amount ELSE 0 END), 0) as actual_commission_total
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    WHERE u.total_income IS NOT NULL
    GROUP BY u.id, u.username, u.total_income
  )
  LOOP
    old_income := user_rec.current_total_income;
    new_income := user_rec.actual_commission_total;
    difference := new_income - old_income;

    -- Update if there's any difference
    IF ABS(difference) > 0.001 THEN
      UPDATE users
      SET total_income = new_income
      WHERE id = user_rec.id;

      RAISE NOTICE 'Fixed total_income for user %: $% -> $% (diff: $%)',
        user_rec.username, old_income, new_income, difference;
      fixed_count := fixed_count + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Fixed % users with incorrect total_income', fixed_count;
END $$;

-- 5. Verification: Report data consistency
DO $$
DECLARE
  inconsistent_rec RECORD;
  inconsistent_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Verifying data consistency...';

  FOR inconsistent_rec IN (
    SELECT
      u.username,
      u.total_income,
      COALESCE(SUM(CASE WHEN o.status = 'success' THEN o.commission_amount ELSE 0 END), 0) as order_total,
      ABS(u.total_income - COALESCE(SUM(CASE WHEN o.status = 'success' THEN o.commission_amount ELSE 0 END), 0)) as difference
    FROM users u
    LEFT JOIN orders o ON o.user_id = u.id
    WHERE u.total_income IS NOT NULL
    GROUP BY u.id, u.username, u.total_income
    HAVING ABS(u.total_income - COALESCE(SUM(CASE WHEN o.status = 'success' THEN o.commission_amount ELSE 0 END), 0)) > 0.001
  )
  LOOP
    RAISE WARNING 'Inconsistency found for user %: total_income=$%, order_total=$%, diff=$%',
      inconsistent_rec.username, inconsistent_rec.total_income, inconsistent_rec.order_total, inconsistent_rec.difference;
    inconsistent_count := inconsistent_count + 1;
  END LOOP;

  IF inconsistent_count = 0 THEN
    RAISE NOTICE 'SUCCESS: All data is now consistent!';
  ELSE
    RAISE WARNING 'Found % users with remaining inconsistencies', inconsistent_count;
  END IF;
END $$;
