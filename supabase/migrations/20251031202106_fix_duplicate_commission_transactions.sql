/*
  # Fix Duplicate Commission Transactions and Add Unique Constraint

  1. Problem
    - Found 3 orders with duplicate commission transactions:
      - Order 99ec70ef-d346-4a30-ab5b-df22e2f5cdad: 2 commission records
      - Order 9c0684c6-b291-4e01-88e3-77b90432c98e: 2 commission records
      - Order 38b9d545-705a-4b96-947b-2c89e69f1d7f: 2 commission records
    - 1 withdrawal with 3 rejection records
    - Race condition in edge function allows concurrent processing
    - Employees received double commission payments

  2. Solution
    - Step 1: Identify and delete duplicate transactions (keep earliest)
    - Step 2: Recalculate wallet balances based on SUM of all transactions
    - Step 3: Add unique constraint to prevent future duplicates

  3. Important Notes
    - Keeps the earliest transaction for each order (first-come-first-serve)
    - Recalculates balances to reflect correct amounts
    - Unique constraint will prevent this issue going forward
*/

-- Step 1: Delete duplicate transactions (keep the first one for each reference_id + type combination)
WITH ranked_transactions AS (
  SELECT 
    id,
    reference_id,
    type,
    user_id,
    created_at,
    ROW_NUMBER() OVER (PARTITION BY reference_id, type ORDER BY created_at ASC) as rn
  FROM wallet_transactions
  WHERE reference_id IS NOT NULL
)
DELETE FROM wallet_transactions
WHERE id IN (
  SELECT id 
  FROM ranked_transactions 
  WHERE rn > 1
);

-- Step 2: Recalculate wallet balances for all affected users
-- Get users who had transactions with the duplicated reference_ids
UPDATE wallets w
SET 
  available_balance = (
    SELECT COALESCE(SUM(
      CASE 
        WHEN wt.type IN ('commission', 'adjustment', 'withdrawal_refund', 'withdrawal_rejected') THEN wt.amount
        WHEN wt.type = 'withdrawal_deduction' THEN -wt.amount
        ELSE 0
      END
    ), 0)
    FROM wallet_transactions wt
    WHERE wt.user_id = w.user_id
  ),
  updated_at = now()
WHERE w.user_id IN (
  SELECT DISTINCT user_id 
  FROM wallet_transactions
  WHERE reference_id IN (
    '99ec70ef-d346-4a30-ab5b-df22e2f5cdad',
    '9c0684c6-b291-4e01-88e3-77b90432c98e',
    '38b9d545-705a-4b96-947b-2c89e69f1d7f',
    '6e99f050-07a0-40b4-905c-cc8d3c4a79f0'
  )
);

-- Step 3: Add unique constraint to prevent future duplicates
-- This ensures one reference_id can only have one transaction of each type
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_reference_type
ON wallet_transactions(reference_id, type)
WHERE reference_id IS NOT NULL;