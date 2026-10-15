/*
# Add Customer Service Tip System

1. Modified Tables
   - `customer_employee_conversations`: Added 'tip' to message_type check constraint
   - `wallet_transactions`: Added 'tip' to type check constraint

2. Changes
   - Allows admins to send tip messages in customer service chat
   - Tips are recorded as wallet transactions with type 'tip'
   - Tips are completely separate from commission calculations (orders table untouched)
   - The get_daily_order_stats function only queries the orders table, so tips never affect commission logic

3. Security
   - No RLS changes needed - existing policies on wallet_transactions and customer_employee_conversations already cover the new types
   
4. Important Notes
   - Tips flow: admin sends tip message -> wallet transaction created -> employee balance updated
   - Tips do NOT create order records, keeping commission calculations clean
   - The wallet available_balance is updated atomically when a tip is given
*/

-- 1. Update message_type constraint to allow 'tip'
ALTER TABLE customer_employee_conversations
  DROP CONSTRAINT IF EXISTS customer_employee_conversations_message_type_check;

ALTER TABLE customer_employee_conversations
  ADD CONSTRAINT customer_employee_conversations_message_type_check
  CHECK (message_type = ANY (ARRAY['text'::text, 'image'::text, 'rating_request'::text, 'rating_result'::text, 'tip'::text]));

-- 2. Update wallet_transactions type constraint to allow 'tip'
ALTER TABLE wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;

ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type = ANY (ARRAY['commission'::text, 'withdrawal_request'::text, 'withdrawal_approved'::text, 'withdrawal_rejected'::text, 'manual_adjustment'::text, 'tip'::text]));

-- 3. Create a function to process a tip (atomic wallet update + transaction record)
CREATE OR REPLACE FUNCTION process_customer_service_tip(
  p_employee_id uuid,
  p_amount numeric,
  p_message_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_balance_before numeric;
  v_balance_after numeric;
  v_transaction_id uuid;
BEGIN
  IF p_amount <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Tip amount must be positive');
  END IF;

  -- Lock and update wallet atomically
  SELECT available_balance INTO v_balance_before
  FROM wallets
  WHERE user_id = p_employee_id
  FOR UPDATE;

  IF v_balance_before IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Employee wallet not found');
  END IF;

  v_balance_after := v_balance_before + p_amount;

  UPDATE wallets
  SET available_balance = v_balance_after,
      updated_at = now()
  WHERE user_id = p_employee_id;

  -- Create wallet transaction record
  INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, reference_id, remarks)
  VALUES (p_employee_id, 'tip', p_amount, v_balance_before, v_balance_after, p_message_id::text, 'Customer service tip')
  RETURNING id INTO v_transaction_id;

  -- Update employee total_income
  UPDATE users
  SET total_income = total_income + p_amount
  WHERE id = p_employee_id;

  RETURN jsonb_build_object(
    'success', true,
    'transaction_id', v_transaction_id,
    'balance_before', v_balance_before,
    'balance_after', v_balance_after
  );
END;
$$;

-- Grant execute to anon and authenticated (needed for security invoker chain)
GRANT EXECUTE ON FUNCTION process_customer_service_tip(uuid, numeric, uuid) TO anon, authenticated;
