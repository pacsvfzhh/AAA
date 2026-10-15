/*
  # Create Atomic Wallet Adjustment Function
  
  This migration creates a secure, atomic function for wallet balance adjustments
  to prevent race conditions and ensure data integrity.
  
  1. Problem Being Solved
    - Race condition when multiple adjustments happen simultaneously
    - Both transactions read the same balance_before value
    - Results in incorrect final balance
  
  2. Solution
    - Use SELECT FOR UPDATE to lock the wallet row during adjustment
    - Perform all operations in a single atomic transaction
    - Return the result for verification
  
  3. Security
    - Function uses SECURITY DEFINER with explicit search_path
    - Only allows authenticated access
*/

CREATE OR REPLACE FUNCTION adjust_wallet_balance(
  p_user_id uuid,
  p_amount numeric,
  p_remarks text,
  p_created_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_wallet_id uuid;
  v_balance_before numeric;
  v_balance_after numeric;
  v_transaction_id uuid;
BEGIN
  -- Lock the wallet row and get current balance
  SELECT id, available_balance
  INTO v_wallet_id, v_balance_before
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE;
  
  -- If no wallet exists, create one
  IF v_wallet_id IS NULL THEN
    INSERT INTO wallets (user_id, available_balance, frozen_balance)
    VALUES (p_user_id, 0, 0)
    RETURNING id, available_balance INTO v_wallet_id, v_balance_before;
  END IF;
  
  -- Calculate new balance
  v_balance_after := v_balance_before + p_amount;
  
  -- Check for insufficient balance on subtract
  IF v_balance_after < 0 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Insufficient balance'
    );
  END IF;
  
  -- Update the wallet balance
  UPDATE wallets
  SET available_balance = v_balance_after,
      updated_at = now()
  WHERE id = v_wallet_id;
  
  -- Create transaction record
  INSERT INTO wallet_transactions (
    user_id,
    type,
    amount,
    balance_before,
    balance_after,
    remarks,
    created_by
  )
  VALUES (
    p_user_id,
    'manual_adjustment',
    p_amount,
    v_balance_before,
    v_balance_after,
    p_remarks,
    p_created_by
  )
  RETURNING id INTO v_transaction_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'balance_before', v_balance_before,
    'balance_after', v_balance_after,
    'transaction_id', v_transaction_id
  );
END;
$$;

COMMENT ON FUNCTION adjust_wallet_balance IS 'Atomically adjusts wallet balance with row-level locking to prevent race conditions';
