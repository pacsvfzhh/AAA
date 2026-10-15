/*
  # Update Withdrawal Orders Threshold Default to 1000

  1. Changes
    - Update `check_withdrawal_eligibility` function default orders threshold from 7 to 1000
    - Update existing global default config value from 7 to 1000 (if it exists)

  2. Purpose
    - Default threshold should be 1000 orders instead of 7
*/

-- Update the check_withdrawal_eligibility function with new default
CREATE OR REPLACE FUNCTION check_withdrawal_eligibility(check_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  user_record RECORD;
  wallet_record RECORD;
  admin_amount_threshold numeric;
  admin_orders_threshold integer;
  global_amount_threshold numeric;
  global_orders_threshold integer;
  amount_threshold numeric;
  orders_threshold integer;
  completed_orders_count integer;
  condition_mode text;
  admin_condition_mode text;
  global_condition_mode text;
  amount_met boolean := false;
  orders_met boolean := false;
BEGIN
  SELECT * INTO user_record FROM users WHERE id = check_user_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT user_record.is_verified THEN RETURN false; END IF;

  SELECT * INTO wallet_record FROM wallets WHERE user_id = check_user_id;
  IF NOT FOUND OR wallet_record.available_balance <= 0 THEN RETURN false; END IF;

  SELECT config_value::numeric INTO admin_amount_threshold
  FROM admin_configs
  WHERE admin_id = user_record.created_by AND config_type = 'withdrawal_amount_threshold';

  SELECT config_value::integer INTO admin_orders_threshold
  FROM admin_configs
  WHERE admin_id = user_record.created_by AND config_type = 'withdrawal_days_threshold';

  SELECT config_value INTO admin_condition_mode
  FROM admin_configs
  WHERE admin_id = user_record.created_by AND config_type = 'withdrawal_condition_mode';

  SELECT config_value::numeric INTO global_amount_threshold
  FROM admin_configs
  WHERE admin_id IS NULL AND config_type = 'withdrawal_amount_threshold';

  SELECT config_value::integer INTO global_orders_threshold
  FROM admin_configs
  WHERE admin_id IS NULL AND config_type = 'withdrawal_days_threshold';

  SELECT config_value INTO global_condition_mode
  FROM admin_configs
  WHERE admin_id IS NULL AND config_type = 'withdrawal_condition_mode';

  amount_threshold := COALESCE(admin_amount_threshold, global_amount_threshold, 100);
  orders_threshold := COALESCE(admin_orders_threshold, global_orders_threshold, 1000);
  condition_mode := COALESCE(admin_condition_mode, global_condition_mode, 'either');

  IF wallet_record.available_balance >= amount_threshold THEN
    amount_met := true;
  END IF;

  completed_orders_count := get_user_completed_orders_count(check_user_id);
  IF completed_orders_count >= orders_threshold THEN
    orders_met := true;
  END IF;

  CASE condition_mode
    WHEN 'amount_only' THEN RETURN amount_met;
    WHEN 'days_only' THEN RETURN orders_met;
    WHEN 'both' THEN RETURN amount_met AND orders_met;
    ELSE RETURN amount_met OR orders_met;
  END CASE;
END;
$$;

-- Update existing global default if it's set to 7
UPDATE admin_configs
SET config_value = '1000'
WHERE admin_id IS NULL
  AND config_type = 'withdrawal_days_threshold'
  AND config_value = '7';
