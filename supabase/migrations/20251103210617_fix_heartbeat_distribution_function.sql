/*
  # Fix Heartbeat Distribution Function

  1. Fix
    - Correct GROUP BY clause syntax
    - Use subquery to avoid column reference issue
*/

-- Drop and recreate with fixed query
DROP FUNCTION IF EXISTS get_heartbeat_distribution();

CREATE OR REPLACE FUNCTION get_heartbeat_distribution()
RETURNS TABLE (
  time_since_heartbeat text,
  session_count bigint
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    time_category as time_since_heartbeat,
    COUNT(*) as session_count
  FROM (
    SELECT
      CASE
        WHEN last_activity_at IS NULL THEN 'Never'
        WHEN last_activity_at > now() - interval '30 seconds' THEN '0-30s (Fresh)'
        WHEN last_activity_at > now() - interval '1 minute' THEN '30s-1m (Good)'
        WHEN last_activity_at > now() - interval '2 minutes' THEN '1-2m (OK)'
        WHEN last_activity_at > now() - interval '3 minutes' THEN '2-3m (Stale)'
        ELSE '3m+ (Will be cleaned)'
      END as time_category,
      CASE
        WHEN last_activity_at IS NULL THEN 6
        WHEN last_activity_at > now() - interval '30 seconds' THEN 1
        WHEN last_activity_at > now() - interval '1 minute' THEN 2
        WHEN last_activity_at > now() - interval '2 minutes' THEN 3
        WHEN last_activity_at > now() - interval '3 minutes' THEN 4
        ELSE 5
      END as sort_order
    FROM dispatch_sessions
    WHERE status = 'online'
  ) subq
  GROUP BY time_category, sort_order
  ORDER BY sort_order;
$$;

GRANT EXECUTE ON FUNCTION get_heartbeat_distribution() TO authenticated;
