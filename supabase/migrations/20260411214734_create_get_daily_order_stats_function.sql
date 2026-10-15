
/*
  # Create get_daily_order_stats Function

  ## Summary
  Creates a server-side aggregation function that returns daily order statistics
  for a given user. This avoids the PostgREST row-limit issue when fetching
  thousands of individual order rows.

  ## Returns
  One row per day with:
  - day_date: the calendar date
  - total_orders: all orders that day
  - success_count: orders with status = 'success'
  - failure_count: orders with status = 'failure'
  - daily_earnings: sum of commission_amount for successful orders
*/

CREATE OR REPLACE FUNCTION get_daily_order_stats(p_user_id uuid)
RETURNS TABLE (
  day_date date,
  total_orders bigint,
  success_count bigint,
  failure_count bigint,
  daily_earnings numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    (created_at AT TIME ZONE 'UTC')::date AS day_date,
    COUNT(*) AS total_orders,
    COUNT(*) FILTER (WHERE status = 'success') AS success_count,
    COUNT(*) FILTER (WHERE status = 'failure') AS failure_count,
    COALESCE(SUM(commission_amount) FILTER (WHERE status = 'success'), 0) AS daily_earnings
  FROM orders
  WHERE user_id = p_user_id
  GROUP BY (created_at AT TIME ZONE 'UTC')::date
  ORDER BY day_date DESC;
$$;

CREATE OR REPLACE FUNCTION get_overall_order_stats(p_user_id uuid)
RETURNS TABLE (
  total_orders bigint,
  total_success bigint,
  total_failed bigint,
  total_revenue numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COUNT(*) AS total_orders,
    COUNT(*) FILTER (WHERE status = 'success') AS total_success,
    COUNT(*) FILTER (WHERE status = 'failure') AS total_failed,
    COALESCE(SUM(commission_amount) FILTER (WHERE status = 'success'), 0) AS total_revenue
  FROM orders
  WHERE user_id = p_user_id;
$$;
