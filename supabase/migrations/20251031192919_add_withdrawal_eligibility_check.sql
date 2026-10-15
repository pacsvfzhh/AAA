/*
  # Add Withdrawal Eligibility Check

  1. New Functions
    - `check_withdrawal_eligibility(user_id uuid)` - Checks if user is eligible to withdraw based on:
      - User must be verified (is_verified = true)
      - Available balance must be > 0
      - Either condition must be met:
        a) Available balance >= withdrawal_amount_threshold
        b) Days since first_success_order_date >= withdrawal_days_threshold

  2. Security
    - Update RLS policy for withdrawals table to use the eligibility check function
    - Prevent users from submitting withdrawal requests if they don't meet requirements

  3. Notes
    - Function reads admin_configs to get thresholds (admin-specific or global defaults)
    - Returns boolean indicating eligibility
*/

-- Create function to check withdrawal eligibility
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

  -- Get global default thresholds
  SELECT config_value::numeric INTO global_amount_threshold
  FROM admin_configs
  WHERE admin_id IS NULL
    AND config_type = 'withdrawal_amount_threshold';

  SELECT config_value::integer INTO global_days_threshold
  FROM admin_configs
  WHERE admin_id IS NULL
    AND config_type = 'withdrawal_days_threshold';

  -- Use admin-specific or fall back to global defaults
  amount_threshold := COALESCE(admin_amount_threshold, global_amount_threshold, 100);
  days_threshold := COALESCE(admin_days_threshold, global_days_threshold, 7);

  -- Check condition 1: Balance meets threshold
  IF wallet_record.available_balance >= amount_threshold THEN
    RETURN true;
  END IF;

  -- Check condition 2: Days since first order meets threshold
  IF user_record.first_success_order_date IS NOT NULL THEN
    days_since_first := EXTRACT(DAY FROM (NOW() - user_record.first_success_order_date))::integer;
    
    IF days_since_first >= days_threshold THEN
      RETURN true;
    END IF;
  END IF;

  -- Neither condition met
  RETURN false;
END;
$$;

-- Drop old policy
DROP POLICY IF EXISTS "Users can insert withdrawals" ON withdrawals;

-- Create new policy with eligibility check
CREATE POLICY "Users can insert withdrawals"
  ON withdrawals FOR INSERT
  TO anon, authenticated
  WITH CHECK (check_withdrawal_eligibility(user_id));
