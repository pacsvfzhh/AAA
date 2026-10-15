/*
  # Fix Timezone Inconsistency in count_today_valid_data_failed_orders_by_user

  1. Problem
    - Employee Daily Breakdown uses UTC timezone: created_at >= date_trunc('day', NOW())
    - Admin Today Orders uses UTC timezone: created_at >= today_start
    - Admin Completed Orders uses UTC timezone: created_at >= today_start
    - Admin Failed Orders uses Asia/Shanghai timezone: DATE(created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')
    
  2. Inconsistency Example
    Order created at: 2025-11-03 06:01:20 UTC
    - UTC timezone: 2025-11-03 (counted as "today")
    - Shanghai timezone: 2025-11-02 22:01:20 (counted as "yesterday")
    
    Result:
    - Employee panel shows: 1 order today
    - Admin Today Orders shows: 1 order
    - Admin Completed shows: 1 order
    - Admin Failed shows: 0 orders (because it's "yesterday" in Shanghai time)
    
  3. Solution
    - Change count_today_valid_data_failed_orders_by_user to use UTC timezone
    - Make it consistent with other count functions
    - Add today_start parameter like other functions
    
  4. Benefits
    - All panels use consistent timezone (UTC)
    - Data matches across employee and admin panels
    - Easier to understand and debug
*/

CREATE OR REPLACE FUNCTION count_today_valid_data_failed_orders_by_user(
  user_ids uuid[],
  today_start timestamptz
)
RETURNS TABLE (user_id uuid, count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT 
    o.user_id,
    COUNT(*)::bigint as count
  FROM orders o
  INNER JOIN valid_order_data v ON o.transaction_id = v.transaction_id
  WHERE o.user_id = ANY(user_ids)
    AND o.status = 'failure'
    AND o.created_at >= today_start
  GROUP BY o.user_id;
$$;

COMMENT ON FUNCTION count_today_valid_data_failed_orders_by_user(uuid[], timestamptz) IS 
'Counts today''s failed orders that have valid data for multiple users.
Uses UTC timezone for consistency with other count functions.
Requires INNER JOIN with valid_order_data to ensure data quality.';

GRANT EXECUTE ON FUNCTION count_today_valid_data_failed_orders_by_user(uuid[], timestamptz) TO authenticated;