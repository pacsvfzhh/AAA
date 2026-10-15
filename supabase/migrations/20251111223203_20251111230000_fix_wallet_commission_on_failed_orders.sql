/*
  # Fix Wallet Commission on Failed Orders

  1. Problem
    - Database trigger `auto_create_commission_and_update_wallet()` was adding commissions for failed orders
    - Found case where order status is 'failure' but wallet_transaction shows commission added
    - Root cause: Trigger logic didn't properly validate commission_amount before creating transaction

  2. Solution
    - Update trigger to ONLY add commission when:
      a) Status changes to 'success'
      b) commission_amount IS NOT NULL and > 0
      c) No existing transaction for this order
    - Remove invalid commission transactions for failed orders
    - Recalculate correct wallet balances for all affected users

  3. Changes
    - Drop and recreate trigger function with stricter validation
    - Delete commission transactions where order status is NOT 'success'
    - Recalculate all wallet balances based on valid transactions only
*/

-- 1. Drop existing trigger first
DROP TRIGGER IF EXISTS trigger_sync_order_to_wallet ON orders;

-- 2. Create improved trigger function with strict validation
CREATE OR REPLACE FUNCTION auto_create_commission_and_update_wallet()
RETURNS TRIGGER AS $$
DECLARE
  current_balance numeric;
BEGIN
  -- CRITICAL: Only add commission when ALL conditions are met:
  -- 1. New status is 'success'
  -- 2. Old status was NOT 'success' (prevent duplicate on re-update)
  -- 3. commission_amount is NOT NULL and > 0
  IF NEW.status = 'success'
     AND (OLD IS NULL OR OLD.status != 'success')
     AND NEW.commission_amount IS NOT NULL
     AND NEW.commission_amount > 0 THEN

    -- Check if transaction already exists for this order (double-check protection)
    IF NOT EXISTS (
      SELECT 1 FROM wallet_transactions
      WHERE user_id = NEW.user_id
      AND type = 'commission'
      AND reference_id = NEW.id
    ) THEN
      -- Get current balance from last transaction
      SELECT COALESCE(balance_after, 0)
      INTO current_balance
      FROM wallet_transactions
      WHERE user_id = NEW.user_id
      ORDER BY created_at DESC, id DESC
      LIMIT 1;

      IF current_balance IS NULL THEN
        current_balance := 0;
      END IF;

      -- Create commission transaction
      INSERT INTO wallet_transactions (
        user_id,
        type,
        amount,
        balance_before,
        balance_after,
        reference_id,
        created_at
      )
      VALUES (
        NEW.user_id,
        'commission',
        NEW.commission_amount,
        current_balance,
        current_balance + NEW.commission_amount,
        NEW.id,
        NOW()
      );

      -- Update wallet balance
      UPDATE wallets
      SET available_balance = available_balance + NEW.commission_amount
      WHERE user_id = NEW.user_id;

      RAISE NOTICE 'Added commission for successful order %', NEW.id;
    END IF;
  END IF;

  -- Handle case where order changes FROM success TO failure (rollback)
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

    RAISE NOTICE 'Removed commission for order % (status changed to %)', NEW.id, NEW.status;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Recreate trigger
CREATE TRIGGER trigger_sync_order_to_wallet
  AFTER INSERT OR UPDATE OF status ON orders
  FOR EACH ROW
  EXECUTE FUNCTION auto_create_commission_and_update_wallet();

-- 4. Clean up: Delete invalid commission transactions (where order is NOT success)
DO $$
DECLARE
  invalid_txn RECORD;
  deleted_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Checking for invalid commission transactions...';

  FOR invalid_txn IN (
    SELECT
      wt.id as txn_id,
      wt.user_id,
      wt.amount,
      wt.reference_id as order_id,
      o.status as order_status
    FROM wallet_transactions wt
    JOIN orders o ON wt.reference_id = o.id
    WHERE wt.type = 'commission'
    AND o.status != 'success'
  )
  LOOP
    -- Delete the invalid transaction
    DELETE FROM wallet_transactions WHERE id = invalid_txn.txn_id;

    deleted_count := deleted_count + 1;
    RAISE NOTICE 'Deleted invalid commission transaction for order %', invalid_txn.order_id;
  END LOOP;

  RAISE NOTICE 'Deleted % invalid commission transactions', deleted_count;
END $$;

-- 5. Recalculate balance_before and balance_after for all transactions
DO $$
DECLARE
  user_rec RECORD;
  txn_rec RECORD;
  running_balance numeric;
BEGIN
  RAISE NOTICE 'Recalculating balance_before/balance_after for all users...';

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
  END LOOP;

  RAISE NOTICE 'Completed balance recalculation';
END $$;

-- 6. Fix wallet available_balance to match transaction history
DO $$
DECLARE
  wallet_rec RECORD;
  calculated_balance numeric;
  old_available numeric;
  difference numeric;
  fixed_count INTEGER := 0;
BEGIN
  RAISE NOTICE 'Recalculating wallet balances...';

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
      RAISE NOTICE 'Fixed wallet for user %', wallet_rec.user_id;
    END IF;
  END LOOP;

  RAISE NOTICE 'Fixed % wallets with incorrect balances', fixed_count;
END $$;
