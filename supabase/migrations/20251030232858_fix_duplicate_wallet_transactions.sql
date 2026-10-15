/*
  # Fix Duplicate Wallet Transactions
  
  1. Problem
    - Two orders have duplicate commission transactions
    - Order 151312031: Has 2 transactions of 20 USDT (should be 1)
    - Order 453454353: Has 2 transactions of 2.15075 USDT (should be 1)
    - This caused wallet balance to be inflated by 44.3015 USDT
  
  2. Solution
    - Delete the duplicate transactions (keep the first one for each order)
    - Recalculate the wallet balance for employee1
*/

-- Delete duplicate transactions (keep only the first transaction for each order)
DELETE FROM wallet_transactions
WHERE id IN (
  'b91d1c3e-b9a9-4052-9801-6cd0b4081f27',  -- Duplicate for order 151312031
  '481545cc-fa40-4b5e-8165-861ffe5be3ae'   -- Duplicate for order 453454353
);

-- Recalculate wallet balance for employee1
UPDATE wallets
SET 
  available_balance = (
    SELECT COALESCE(SUM(amount), 0)
    FROM wallet_transactions
    WHERE user_id = '90d5b1d9-b254-4d82-ad03-682c08e98c6d'
  ),
  updated_at = now()
WHERE user_id = '90d5b1d9-b254-4d82-ad03-682c08e98c6d';
