/*
  # Add Completed Orders Count Function

  1. New Function
    - `count_today_completed_orders_by_user` - Counts successfully completed orders today per user
    - Returns user_id and count of completed orders for today

  2. Purpose
    - Enable Dispatch Records page to show today's successful order count
    - Allows sorting and filtering by completion rate
    - Helps admins track employee performance more accurately

  3. Notes
    - Only counts orders with status 'success' (the orders table uses 'success', not 'completed')
    - Uses timestamp comparison for today's date
    - Optimized with proper indexing
*/

-- Function to count today's completed orders per user
CREATE OR REPLACE FUNCTION count_today_completed_orders_by_user(
  user_ids uuid[],
  today_start timestamptz
)
RETURNS TABLE (user_id uuid, count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT
    orders.user_id,
    COUNT(*)::bigint as count
  FROM orders
  WHERE orders.user_id = ANY(user_ids)
    AND orders.status = 'success'
    AND orders.created_at >= today_start
  GROUP BY orders.user_id;
$$;
