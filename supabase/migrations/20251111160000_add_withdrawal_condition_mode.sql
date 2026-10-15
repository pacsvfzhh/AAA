/*
  # Add Withdrawal Condition Mode Configuration

  1. New Configuration Type
    - `withdrawal_condition_mode` - Controls how withdrawal eligibility is determined
      - 'amount_only' - Only balance requirement must be met
      - 'days_only' - Only days requirement must be met
      - 'either' - Either condition can be met (OR logic) - DEFAULT
      - 'both' - Both conditions must be met (AND logic)

  2. Changes
    - Add new config type to admin_configs table
    - Update check_withdrawal_eligibility function to support different modes
    - Maintain backward compatibility (default to 'either' mode)

  3. Security
    - No RLS changes needed
    - Function remains SECURITY DEFINER
*/

-- Update the check_withdrawal_eligibility function to support condition modes
CREATE OR REPLACE FUNCTION check_withdrawal_eligibility(check_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  user_record RECORD;
  wallet_record RECORD;
  admin_amount_threshold numeric;
  admin_days_threshold integer;
  global_amount_threshold numeric;
  global_days_threshold integer;
  amount_threshold numeric;
  days_threshold integer;
  days_since_first integer;
  condition_mode text;
  admin_condition_mode text;
  global_condition_mode text;
  amount_met boolean := false;
  days_met boolean := false;
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

  SELECT config_value::integer INTO admin_days_threshold
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

  SELECT config_value::integer INTO global_days_threshold
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
  days_threshold := COALESCE(admin_days_threshold, global_days_threshold, 7);
  condition_mode := COALESCE(admin_condition_mode, global_condition_mode, 'either');

  -- Check amount condition
  IF wallet_record.available_balance >= amount_threshold THEN
    amount_met := true;
  END IF;

  -- Check days condition
  IF user_record.first_success_order_date IS NOT NULL THEN
    days_since_first := EXTRACT(DAY FROM (NOW() - user_record.first_success_order_date))::integer;

    IF days_since_first >= days_threshold THEN
      days_met := true;
    END IF;
  END IF;

  -- Apply condition mode logic
  CASE condition_mode
    WHEN 'amount_only' THEN
      RETURN amount_met;
    WHEN 'days_only' THEN
      RETURN days_met;
    WHEN 'both' THEN
      RETURN amount_met AND days_met;
    ELSE  -- 'either' or default
      RETURN amount_met OR days_met;
  END CASE;
END;
$$;
