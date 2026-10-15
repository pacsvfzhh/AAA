/*
  # Fix missing first_success_order_date and harden withdrawal eligibility

  1. Problem
     - Some users have successful orders but `users.first_success_order_date`
       is NULL because those orders were processed by the old pipeline that
       did not backfill this column.
     - `check_withdrawal_eligibility` requires this column to count
       `days_since_first`, so it silently returns false, causing the
       RLS insert policy on `withdrawals` to block legitimate requests.

  2. Fix
     - Backfill `users.first_success_order_date` from the earliest
       `orders.processed_at` where `status = 'success'` for every user
       currently missing it.
     - Update `check_withdrawal_eligibility` so that when the column is
       still NULL it transparently falls back to the earliest success
       order. This protects future users in case the column drifts again.

  3. Safety
     - Backfill only writes when the column is NULL — no existing values
       are overwritten.
     - Function remains SECURITY DEFINER with pinned search_path.
     - EXECUTE re-granted to anon, authenticated.
*/

UPDATE users u
   SET first_success_order_date = sub.first_success
  FROM (
    SELECT user_id, MIN(COALESCE(processed_at, created_at)) AS first_success
    FROM orders
    WHERE status = 'success'
    GROUP BY user_id
  ) sub
 WHERE u.id = sub.user_id
   AND u.first_success_order_date IS NULL;

CREATE OR REPLACE FUNCTION public.check_withdrawal_eligibility(check_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
  effective_first_success timestamptz;
  amount_met boolean := false;
  days_met boolean := false;
BEGIN
  SELECT * INTO user_record FROM users WHERE id = check_user_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF NOT user_record.is_verified THEN
    RETURN false;
  END IF;

  SELECT * INTO wallet_record FROM wallets WHERE user_id = check_user_id;
  IF NOT FOUND OR wallet_record.available_balance <= 0 THEN
    RETURN false;
  END IF;

  SELECT config_value::numeric INTO admin_amount_threshold
    FROM admin_configs
   WHERE admin_id = user_record.created_by
     AND config_type = 'withdrawal_amount_threshold';

  SELECT config_value::integer INTO admin_days_threshold
    FROM admin_configs
   WHERE admin_id = user_record.created_by
     AND config_type = 'withdrawal_days_threshold';

  SELECT config_value INTO admin_condition_mode
    FROM admin_configs
   WHERE admin_id = user_record.created_by
     AND config_type = 'withdrawal_condition_mode';

  SELECT config_value::numeric INTO global_amount_threshold
    FROM admin_configs
   WHERE admin_id IS NULL
     AND config_type = 'withdrawal_amount_threshold';

  SELECT config_value::integer INTO global_days_threshold
    FROM admin_configs
   WHERE admin_id IS NULL
     AND config_type = 'withdrawal_days_threshold';

  SELECT config_value INTO global_condition_mode
    FROM admin_configs
   WHERE admin_id IS NULL
     AND config_type = 'withdrawal_condition_mode';

  amount_threshold := COALESCE(admin_amount_threshold, global_amount_threshold, 100);
  days_threshold := COALESCE(admin_days_threshold, global_days_threshold, 7);
  condition_mode := COALESCE(admin_condition_mode, global_condition_mode, 'either');

  IF wallet_record.available_balance >= amount_threshold THEN
    amount_met := true;
  END IF;

  effective_first_success := user_record.first_success_order_date;
  IF effective_first_success IS NULL THEN
    SELECT MIN(COALESCE(processed_at, created_at))
      INTO effective_first_success
      FROM orders
     WHERE user_id = check_user_id
       AND status = 'success';
  END IF;

  IF effective_first_success IS NOT NULL THEN
    days_since_first := EXTRACT(DAY FROM (now() - effective_first_success))::integer;
    IF days_since_first >= days_threshold THEN
      days_met := true;
    END IF;
  END IF;

  CASE lower(condition_mode)
    WHEN 'amount_only' THEN RETURN amount_met;
    WHEN 'days_only' THEN RETURN days_met;
    WHEN 'both' THEN RETURN amount_met AND days_met;
    WHEN 'and' THEN RETURN amount_met AND days_met;
    ELSE RETURN amount_met OR days_met;
  END CASE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_withdrawal_eligibility(uuid) TO anon, authenticated;
