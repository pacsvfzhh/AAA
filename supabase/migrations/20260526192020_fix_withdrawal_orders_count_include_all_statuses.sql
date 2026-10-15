/*
  # Fix Withdrawal Orders Count to Include All Order Statuses

  1. Modified Function
    - `get_user_completed_orders_count(p_user_id uuid)` - Now counts ALL orders for the user
      (both success and failed), not just successful ones

  2. Purpose
    - The withdrawal orders threshold should count total orders processed by the employee
    - This includes both successful and failed orders
    - Matches the total order count shown in the admin dashboard
*/

-- Update function to count ALL orders (success + failed), not just success
CREATE OR REPLACE FUNCTION get_user_completed_orders_count(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(COUNT(*)::integer, 0)
  FROM orders
  WHERE orders.user_id = p_user_id;
$$;
