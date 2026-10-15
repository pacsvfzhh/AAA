/*
  # Fix Commission Double Creation Issue

  1. Problem
    - Edge Function creates commission transactions for successful orders
    - Database trigger ALSO tries to create commission transactions
    - This causes duplicate commission payments for the same order
    - Found case: Order bf1c19b6 (failure) has $4.10 commission transaction

  2. Root Cause
    - Two systems trying to do the same thing
    - Edge Function is authoritative and should be the only creator
    - Trigger should only handle edge cases and rollbacks

  3. Solution
    - Update trigger to NOT create new commissions (Edge Function does this)
    - Trigger only handles:
      a) Rollback if order changes FROM success TO failure
      b) Data consistency checks
    - Clean up any invalid commission transactions
    - Recalculate all affected user balances

  4. Data Flow
    - Edge Function: Creates order -> waits 3-10min -> updates to success/failure -> creates transaction (if success)
    - Trigger: Only monitors for status changes that need rollback
*/

-- 1. Drop and recreate trigger function - NO commission creation, only rollback
DROP TRIGGER IF EXISTS trigger_sync_order_to_wallet ON orders;

CREATE OR REPLACE FUNCTION auto_create_commission_and_update_wallet()
RETURNS TRIGGER AS $$
BEGIN
  -- IMPORTANT: This trigger does NOT create new commissions
  -- Edge Function handles commission creation for successful orders
  -- This trigger ONLY handles rollback when order changes from success to failure

  -- Handle rollback: order changes FROM success TO failure
  IF OLD IS NOT NULL
     AND OLD.status = 'success'
     AND NEW.status != 'success'
     AND OLD.commission_amount IS NOT NULL
     AND OLD.commission_amount > 0 THEN

    -- Remove the commission transaction
    DELETE FROM wallet_transactions
    WHERE user_id = NEW.user_id
    AND type = 'commission'
    AND reference_id = NEW.id;

    -- Deduct from wallet balance
    UPDATE wallets
    SET available_balance = available_balance - OLD.commission_amount
    WHERE user_id = NEW.user_id;

    -- Deduct from total_income
    UPDATE users
    SET total_income = total_income - OLD.commission_amount
    WHERE id = NEW.user_id;

    RAISE NOTICE 'Rolled back commission for order % (changed to %)', NEW.id, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Recreate trigger
CREATE TRIGGER trigger_sync_order_to_wallet
  AFTER UPDATE OF status ON orders
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_commission_and_update_wallet();

-- 3. Clean up: Delete ALL invalid commission transactions (where order is NOT success)
DO $$
DECLARE
  invalid_txn RECORD;
  deleted_count INTEGER := 0;
  total_invalid_amount NUMERIC := 0;
BEGIN
  RAISE NOTICE 'Starting cleanup of invalid commission transactions...';

  FOR invalid_txn IN (
    SELECT
      wt.id as txn_id,
      wt.user_id,
      wt.amount,
      wt.reference_id as order_id,
      o.status as order_status,
      o.id as order_exists
    FROM wallet_transactions wt
    LEFT JOIN orders o ON wt.reference_id = o.id
    WHERE wt.type = 'commission'
    AND (o.id IS NULL OR o.status != 'success')
  )
  LOOP
    -- Delete the invalid transaction
    DELETE FROM wallet_transactions WHERE id = invalid_txn.txn_id;

    deleted_count := deleted_count + 1;
    total_invalid_amount := total_invalid_amount + invalid_txn.amount;

    RAISE NOTICE 'Deleted invalid commission: order=%, status=%, amount=%',
      invalid_txn.order_id,
      COALESCE(invalid_txn.order_status, 'not_found'),
      invalid_txn.amount;
  END LOOP;

  RAISE NOTICE 'Cleanup complete: % invalid transactions deleted, total amount: %',
    deleted_count,
    total_invalid_amount;
END $$;

-- 4. Recalculate balance_before and balance_after for all transactions
DO $$
DECLARE
  user_rec RECORD;
  txn_rec RECORD;
  running_balance NUMERIC;
  processed_users INTEGER := 0;
BEGIN
  RAISE NOTICE 'Recalculating transaction balances for all users...';

  FOR user_rec IN (SELECT DISTINCT user_id FROM wallet_transactions)
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

    processed_users := processed_users + 1;
  END LOOP;

  RAISE NOTICE 'Balance recalculation complete for % users', processed_users;
END $$;

-- 5. Fix wallet available_balance to match transaction history
DO $$
DECLARE
  wallet_rec RECORD;
  calculated_balance NUMERIC;
  old_available NUMERIC;
  difference NUMERIC;
  fixed_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Fixing wallet balances...';

  FOR wallet_rec IN (
    SELECT
      w.user_id,
      w.available_balance,
      w.frozen_balance,
      COALESCE(SUM(wt.amount), 0) as total_from_transactions
    FROM wallets w
    LEFT JOIN wallet_transactions wt ON w.user_id = wt.user_id
    GROUP BY w.user_id, w.available_balance, w.frozen_balance
  )
  LOOP
    old_available := wallet_rec.available_balance;
    calculated_balance := wallet_rec.total_from_transactions - wallet_rec.frozen_balance;
    difference := calculated_balance - old_available;

    -- Only update if there's a significant difference (> $0.01)
    IF ABS(difference) > 0.01 THEN
      UPDATE wallets
      SET available_balance = calculated_balance
      WHERE user_id = wallet_rec.user_id;

      fixed_count := fixed_count + 1;
      RAISE NOTICE 'Fixed wallet for user % (diff: %)', wallet_rec.user_id, difference;
    END IF;
  END LOOP;

  RAISE NOTICE 'Wallet fix complete: % wallets updated', fixed_count;
END $$;

-- 6. Fix users.total_income to match successful orders
DO $$
DECLARE
  user_rec RECORD;
  calculated_income NUMERIC;
  old_income NUMERIC;
  difference NUMERIC;
  fixed_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Fixing users total_income...';

  FOR user_rec IN (
    SELECT
      u.id as user_id,
      u.total_income as old_total_income,
      COALESCE(SUM(o.commission_amount), 0) as calculated_total_income
    FROM users u
    LEFT JOIN orders o ON u.id = o.user_id AND o.status = 'success'
    GROUP BY u.id, u.total_income
  )
  LOOP
    old_income := user_rec.old_total_income;
    calculated_income := user_rec.calculated_total_income;
    difference := calculated_income - old_income;

    IF ABS(difference) > 0.01 THEN
      UPDATE users
      SET total_income = calculated_income
      WHERE id = user_rec.user_id;

      fixed_count := fixed_count + 1;
      RAISE NOTICE 'Fixed total_income for user % (diff: %)', user_rec.user_id, difference;
    END IF;
  END LOOP;

  RAISE NOTICE 'Total income fix complete: % users updated', fixed_count;
END $$;
