/*
  # Fix Failed Orders Count Function
  
  1. Changes
    - Update `count_failed_orders_by_user` to use correct status 'failure' instead of 'failed'
    
  2. Reason
    - Database constraint requires status to be 'failure', not 'failed'
    - This was causing failed orders to not be counted in Dispatch Records
*/

-- Function to count failed orders per user (fixed status value)
CREATE OR REPLACE FUNCTION count_failed_orders_by_user(user_ids uuid[])
RETURNS TABLE (user_id uuid, count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT
    orders.user_id,
    COUNT(*)::bigint as count
  FROM orders
  WHERE orders.user_id = ANY(user_ids)
    AND orders.status = 'failure'
  GROUP BY orders.user_id;
$$;
