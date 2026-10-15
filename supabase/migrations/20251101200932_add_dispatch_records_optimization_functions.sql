/*
  # Add Dispatch Records Performance Optimization Functions
  
  1. Functions Created
    - `count_orders_by_user`: Efficiently count total orders per user
    - `count_today_orders_by_user`: Count orders created today per user
    - `count_failed_orders_by_user`: Count failed orders per user
  
  2. Purpose
    - Dramatically improve Dispatch Records page load time
    - Replace N+1 query pattern with single aggregation queries
    - Reduce database round trips from hundreds to just 3-4 queries
  
  3. Performance Impact
    - Before: O(n * m) queries where n=admins, m=employees
    - After: O(1) queries - constant time regardless of data size
    - Expected speed improvement: 10-100x faster
*/

-- Function to count total orders per user
CREATE OR REPLACE FUNCTION count_orders_by_user(user_ids uuid[])
RETURNS TABLE (user_id uuid, count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT 
    orders.user_id,
    COUNT(*)::bigint as count
  FROM orders
  WHERE orders.user_id = ANY(user_ids)
  GROUP BY orders.user_id;
$$;

-- Function to count today's orders per user
CREATE OR REPLACE FUNCTION count_today_orders_by_user(user_ids uuid[], today_start timestamptz)
RETURNS TABLE (user_id uuid, count bigint)
LANGUAGE sql
STABLE
AS $$
  SELECT 
    orders.user_id,
    COUNT(*)::bigint as count
  FROM orders
  WHERE orders.user_id = ANY(user_ids)
    AND orders.created_at >= today_start
  GROUP BY orders.user_id;
$$;

-- Function to count failed orders per user
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
    AND orders.status = 'failed'
  GROUP BY orders.user_id;
$$;
