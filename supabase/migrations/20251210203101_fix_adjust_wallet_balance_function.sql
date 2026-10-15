/*
  # Fix adjust_wallet_balance Function

  The adjust_wallet_balance function was referencing a non-existent 'id' column in the wallets table.
  The wallets table uses 'user_id' as the primary key, not 'id'.

  ## Changes
  - Updated the function to use user_id instead of id
  - Fixed the wallet locking mechanism
  - Fixed the wallet insertion logic
  - Removed references to non-existent wallet id column
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
SET search_path TO 'public'
AS $$
DECLARE
  v_balance_before numeric;
  v_balance_after numeric;
  v_transaction_id uuid;
  v_wallet_exists boolean;
BEGIN
  -- Lock the wallet row and get current balance
  SELECT 
    available_balance,
    true
  INTO 
    v_balance_before,
    v_wallet_exists
  FROM wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  -- If no wallet exists, create one
  IF NOT FOUND THEN
    INSERT INTO wallets (user_id, available_balance, frozen_balance)
    VALUES (p_user_id, 0, 0)
    RETURNING available_balance INTO v_balance_before;
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
  SET 
    available_balance = v_balance_after,
    updated_at = now()
  WHERE user_id = p_user_id;

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
