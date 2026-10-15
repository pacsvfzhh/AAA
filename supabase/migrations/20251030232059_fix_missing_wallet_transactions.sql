/*
  # Fix Missing Wallet Transactions
  
  1. Problem
    - 67 successful orders have commission_amount but no corresponding wallet_transactions record
    - This causes discrepancy between order profits and wallet balance records
    
  2. Solution
    - Create missing wallet_transaction records for all successful orders without transactions
    - Update wallet balances to match the actual commission earned
    - Use a transaction to ensure data consistency
    
  3. Important Notes
    - Only processes orders with status = 'success' and commission_amount > 0
    - Skips orders that already have wallet_transactions
    - Creates records with proper balance_before and balance_after tracking
*/

DO $$
DECLARE
  order_record RECORD;
  current_balance NUMERIC := 0;
  new_balance NUMERIC;
BEGIN
  -- Process each missing transaction in chronological order
  FOR order_record IN (
    SELECT 
      o.id,
      o.user_id,
      o.commission_amount,
      o.processed_at,
      o.created_at
    FROM orders o
    LEFT JOIN wallet_transactions wt ON wt.reference_id = o.id AND wt.type = 'commission'
    WHERE o.status = 'success' 
      AND o.commission_amount IS NOT NULL
      AND o.commission_amount > 0
      AND wt.id IS NULL
    ORDER BY o.processed_at ASC
  )
  LOOP
    -- Get current wallet balance before this transaction
    SELECT COALESCE(
      (SELECT balance_after FROM wallet_transactions 
       WHERE user_id = order_record.user_id 
         AND created_at < order_record.processed_at
       ORDER BY created_at DESC LIMIT 1),
      0
    ) INTO current_balance;
    
    -- Calculate new balance
    new_balance := current_balance + order_record.commission_amount;
    
    -- Create the missing wallet transaction
    INSERT INTO wallet_transactions (
      user_id,
      type,
      amount,
      balance_before,
      balance_after,
      reference_id,
      remarks,
      created_at
    ) VALUES (
      order_record.user_id,
      'commission',
      order_record.commission_amount,
      current_balance,
      new_balance,
      order_record.id,
      'Commission from order ' || order_record.id,
      order_record.processed_at
    );
    
  END LOOP;
  
  -- Update wallet balances to reflect all transactions
  UPDATE wallets w
  SET available_balance = (
    SELECT COALESCE(
      (SELECT balance_after FROM wallet_transactions 
       WHERE user_id = w.user_id 
       ORDER BY created_at DESC LIMIT 1),
      0
    )
  )
  WHERE EXISTS (
    SELECT 1 FROM wallet_transactions 
    WHERE user_id = w.user_id
  );
  
END $$;
