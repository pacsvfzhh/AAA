/*
  # Fix Dispatch Records Failed Orders Count

  ## Problem
  The `count_today_valid_data_failed_orders_by_user` function used an INNER JOIN
  with `valid_order_data` table, which filtered out all results when that table
  is empty or has no matching transaction_ids. This caused Failed = 0 in the
  admin Dispatch Records page even though employees had failure orders.

  ## Fix
  Replace the function with a version that queries the `orders` table directly
  using `status = 'failure'`, consistent with how `get_daily_order_stats` works
  on the employee side.

  ## Changes
  - Drop both overloaded versions of `count_today_valid_data_failed_orders_by_user`
  - Recreate a single clean version that uses `today_start` param and queries
    `orders` directly without JOIN to `valid_order_data`
*/

DROP FUNCTION IF EXISTS public.count_today_valid_data_failed_orders_by_user(uuid[]);
DROP FUNCTION IF EXISTS public.count_today_valid_data_failed_orders_by_user(uuid[], timestamp with time zone);

CREATE OR REPLACE FUNCTION public.count_today_valid_data_failed_orders_by_user(
  user_ids uuid[],
  today_start timestamp with time zone
)
RETURNS TABLE(user_id uuid, count bigint)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
SELECT
  orders.user_id,
  COUNT(*)::bigint AS count
FROM orders
WHERE orders.user_id = ANY(user_ids)
  AND orders.status = 'failure'
  AND orders.created_at >= today_start
GROUP BY orders.user_id;
$$;
