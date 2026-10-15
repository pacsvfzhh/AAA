/*
  # Change Withdrawal Days Threshold to Orders Threshold

  1. New Function
    - `get_user_completed_orders_count(p_user_id uuid)` - Returns the total number of 
      successfully completed orders for a given user (all time, not just today)

  2. Modified Function
    - `check_withdrawal_eligibility(check_user_id uuid)` - Updated to check the user's 
      total completed orders count against the threshold instead of days since first order

  3. Purpose
    - The withdrawal eligibility "days threshold" concept is being changed to "orders threshold"
    - Instead of requiring X working days, the system now requires X completed orders
    - The config key remains `withdrawal_days_threshold` in the database for backward compatibility
      but its semantic meaning is now "number of completed orders required"

  4. Notes
    - No schema changes needed (config_type stays the same in admin_configs)
    - Only function logic changes
    - Default threshold remains 7 (now means 7 orders instead of 7 days)
*/

-- Create function to count total completed orders for a user
CREATE OR REPLACE FUNCTION get_user_completed_orders_count(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(COUNT(*)::integer, 0)
  FROM orders
  WHERE orders.user_id = p_user_id
    AND orders.status = 'success';
$$;

-- Update the check_withdrawal_eligibility function to use orders count
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
  -- Get user record
  SELECT * INTO user_record FROM users WHERE id = check_user_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  -- Check if user is verified
  IF NOT user_record.is_verified THEN
    RETURN false;
  END IF;

  -- Get wallet record
  SELECT * INTO wallet_record FROM wallets WHERE user_id = check_user_id;

  IF NOT FOUND OR wallet_record.available_balance <= 0 THEN
    RETURN false;
  END IF;

  -- Get admin-specific thresholds
  SELECT config_value::numeric INTO admin_amount_threshold
  FROM admin_configs
  WHERE admin_id = user_record.created_by
    AND config_type = 'withdrawal_amount_threshold';

  SELECT config_value::integer INTO admin_orders_threshold
  FROM admin_configs
  WHERE admin_id = user_record.created_by
    AND config_type = 'withdrawal_days_threshold';

  -- Get admin-specific condition mode
  SELECT config_value INTO admin_condition_mode
  FROM admin_configs
  WHERE admin_id = user_record.created_by
    AND config_type = 'withdrawal_condition_mode';

  -- Get global default thresholds
  SELECT config_value::numeric INTO global_amount_threshold
  FROM admin_configs
  WHERE admin_id IS NULL
    AND config_type = 'withdrawal_amount_threshold';

  SELECT config_value::integer INTO global_orders_threshold
  FROM admin_configs
  WHERE admin_id IS NULL
    AND config_type = 'withdrawal_days_threshold';

  -- Get global default condition mode
  SELECT config_value INTO global_condition_mode
  FROM admin_configs
  WHERE admin_id IS NULL
    AND config_type = 'withdrawal_condition_mode';

  -- Use admin-specific or fall back to global defaults
  amount_threshold := COALESCE(admin_amount_threshold, global_amount_threshold, 100);
  orders_threshold := COALESCE(admin_orders_threshold, global_orders_threshold, 7);
  condition_mode := COALESCE(admin_condition_mode, global_condition_mode, 'either');

  -- Check amount condition
  IF wallet_record.available_balance >= amount_threshold THEN
    amount_met := true;
  END IF;

  -- Check orders condition (total completed orders)
  completed_orders_count := get_user_completed_orders_count(check_user_id);
  IF completed_orders_count >= orders_threshold THEN
    orders_met := true;
  END IF;

  -- Apply condition mode logic
  CASE condition_mode
    WHEN 'amount_only' THEN
      RETURN amount_met;
    WHEN 'days_only' THEN
      RETURN orders_met;
    WHEN 'both' THEN
      RETURN amount_met AND orders_met;
    ELSE  -- 'either' or default
      RETURN amount_met OR orders_met;
  END CASE;
END;
$$;
