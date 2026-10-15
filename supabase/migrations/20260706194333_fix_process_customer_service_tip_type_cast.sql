
-- Drop and recreate the function with the correct type cast
DROP FUNCTION IF EXISTS process_customer_service_tip(uuid, numeric, uuid);

CREATE OR REPLACE FUNCTION process_customer_service_tip(
  p_employee_id uuid,
  p_amount numeric,
  p_message_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
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

  -- Create wallet transaction record (reference_id is uuid type)
  INSERT INTO wallet_transactions (user_id, type, amount, balance_before, balance_after, reference_id, remarks)
  VALUES (p_employee_id, 'tip', p_amount, v_balance_before, v_balance_after, p_message_id, 'Customer service tip')
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

GRANT EXECUTE ON FUNCTION process_customer_service_tip(uuid, numeric, uuid) TO anon, authenticated;
