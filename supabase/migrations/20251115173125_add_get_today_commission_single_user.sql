/*
  # Add Single User Today Commission Function

  ## Problem
  get_admin_employees() calls get_today_commission(uuid) but only
  get_today_commission_by_user(uuid[]) exists

  ## Error
  "function get_today_commission(uuid) does not exist"

  ## Solution
  Create get_today_commission(uuid) function that:
  - Takes a single user_id
  - Returns today's commission total as numeric
  - Calculates from today's commission wallet transactions

  ## Note
  This allows get_admin_employees() to work correctly
*/

CREATE OR REPLACE FUNCTION get_today_commission(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_commission numeric;
BEGIN
  SELECT COALESCE(SUM(wt.amount), 0)
  INTO v_commission
  FROM wallet_transactions wt
  WHERE wt.user_id = p_user_id
    AND wt.type = 'commission'
    AND wt.created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC');

  RETURN v_commission;
END;
$$;

COMMENT ON FUNCTION get_today_commission(uuid) IS
  'Returns today''s commission earnings for a single user.

  Calculates total commission from wallet_transactions where:
  - type = ''commission''
  - created_at >= today (UTC midnight)

  Used by get_admin_employees() to display real-time commission data.';
