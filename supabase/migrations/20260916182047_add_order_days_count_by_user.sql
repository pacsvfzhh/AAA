CREATE OR REPLACE FUNCTION public.count_order_days_by_user(user_ids uuid[])
RETURNS TABLE (
  user_id uuid,
  day_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  WITH requested_users AS (
    SELECT DISTINCT id
    FROM unnest(user_ids) AS input(id)
  ),
  counts AS (
    SELECT
      orders.user_id,
      COUNT(DISTINCT (orders.created_at AT TIME ZONE 'UTC')::date)::bigint AS day_count
    FROM public.orders AS orders
    INNER JOIN requested_users
      ON requested_users.id = orders.user_id
    GROUP BY orders.user_id
  )
  SELECT
    requested_users.id AS user_id,
    COALESCE(counts.day_count, 0)::bigint AS day_count
  FROM requested_users
  LEFT JOIN counts
    ON counts.user_id = requested_users.id;
$$;

GRANT EXECUTE ON FUNCTION public.count_order_days_by_user(uuid[]) TO anon, authenticated;
