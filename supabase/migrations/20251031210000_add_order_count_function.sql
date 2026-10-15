/*
  # Add Order Count Aggregation Function

  1. Purpose
    - Creates an efficient PostgreSQL function to get order counts per user
    - Replaces inefficient client-side aggregation of all order records
    - Improves Employee Management panel load performance

  2. Function Details
    - Returns user_id and order_count for all users with orders
    - Uses GROUP BY for efficient aggregation at database level
    - Much faster than fetching all order records to client

  3. Performance Impact
    - Reduces data transfer from thousands of rows to just user count rows
    - Eliminates client-side processing overhead
    - Speeds up employee list loading significantly
*/

-- Create function to get order counts by user
CREATE OR REPLACE FUNCTION get_order_counts_by_user()
RETURNS TABLE (
  user_id uuid,
  order_count bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    user_id,
    COUNT(*) as order_count
  FROM orders
  GROUP BY user_id;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION get_order_counts_by_user() TO authenticated;
GRANT EXECUTE ON FUNCTION get_order_counts_by_user() TO anon;
