/*
  # Add Today Commission Calculation Function

  1. New Functions
    - `get_today_commission_by_user` - Calculates today's commission earnings for multiple users
      - Returns user_id and today_commission for each user
      - Only includes commission transactions from today (UTC midnight to now)
      - Optimized for batch queries

  2. Security
    - Function runs with SECURITY DEFINER to allow efficient queries
    - No direct RLS concerns as it's used internally by admin views
*/

-- Create function to get today's commission for multiple users
CREATE OR REPLACE FUNCTION get_today_commission_by_user(
  user_ids uuid[]
)
RETURNS TABLE(
  user_id uuid,
  today_commission numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    wt.user_id,
    COALESCE(SUM(wt.amount), 0) AS today_commission
  FROM wallet_transactions wt
  WHERE wt.user_id = ANY(user_ids)
    AND wt.type = 'commission'
    AND wt.created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')
  GROUP BY wt.user_id;
END;
$$;
