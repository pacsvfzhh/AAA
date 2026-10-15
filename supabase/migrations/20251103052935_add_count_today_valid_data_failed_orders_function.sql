/*
  # Add Function to Count Today's Failed Orders from Valid Data

  1. Function Created
    - `count_today_valid_data_failed_orders_by_user`: Count failed orders from valid_order_data created today per user
  
  2. Purpose
    - Replace generic failed orders count with valid data specific count
    - Only count orders that used valid_order_data (verified transaction IDs)
    - Filter by today's date to show daily performance
    - Used in Dispatch Records page to track data validation failures
  
  3. Logic
    - Join orders with valid_order_data on transaction_id
    - Filter by status = 'failure'
    - Filter by orders created today (using Asia/Shanghai timezone)
    - Group by user_id to get per-user counts
  
  4. Performance
    - Uses indexed columns (user_id, status, transaction_id, created_at)
    - Single aggregation query replaces multiple N+1 queries
    - Optimized for Dispatch Records page load time
*/

-- Function to count today's failed orders from valid_order_data per user
CREATE OR REPLACE FUNCTION count_today_valid_data_failed_orders_by_user(user_ids uuid[])
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
    AND DATE(o.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') = DATE(NOW() AT TIME ZONE 'Asia/Shanghai')
  GROUP BY o.user_id;
$$;