/*
  # Add Batch Work Time Functions

  1. New Functions
    - `get_batch_work_time()` - Get work time for multiple users at once
    - Returns table with user_id, total_work_minutes, today_work_minutes
    
  2. Performance Optimization
    - Single query to get all work times instead of N queries
    - Significantly faster for loading dispatch records with many users
*/

-- Function to get work time for multiple users in one query
CREATE OR REPLACE FUNCTION get_batch_work_time(p_user_ids uuid[])
RETURNS TABLE(
  user_id uuid,
  total_work_minutes integer,
  today_work_minutes integer
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_today_start timestamptz;
BEGIN
  v_today_start := date_trunc('day', now());
  
  RETURN QUERY
  WITH user_stats AS (
    SELECT 
      u.id as user_id,
      -- Total completed work time
      COALESCE(SUM(
        CASE 
          WHEN ws.end_time IS NOT NULL 
          THEN ws.duration_minutes 
          ELSE 0 
        END
      ), 0) as completed_minutes,
      -- Total today's completed work time
      COALESCE(SUM(
        CASE 
          WHEN ws.end_time IS NOT NULL AND ws.start_time >= v_today_start
          THEN ws.duration_minutes 
          ELSE 0 
        END
      ), 0) as today_completed_minutes,
      -- Active session total time (if exists)
      COALESCE(MAX(
        CASE 
          WHEN ws.end_time IS NULL 
          THEN EXTRACT(EPOCH FROM (now() - ws.start_time)) / 60
          ELSE 0 
        END
      ), 0) as active_minutes,
      -- Active session today time (if started today)
      COALESCE(MAX(
        CASE 
          WHEN ws.end_time IS NULL AND ws.start_time >= v_today_start
          THEN EXTRACT(EPOCH FROM (now() - ws.start_time)) / 60
          ELSE 0 
        END
      ), 0) as active_today_minutes
    FROM unnest(p_user_ids) u(id)
    LEFT JOIN work_sessions ws ON ws.user_id = u.id
    GROUP BY u.id
  )
  SELECT 
    user_stats.user_id,
    CAST((user_stats.completed_minutes + user_stats.active_minutes) AS integer) as total_work_minutes,
    CAST((user_stats.today_completed_minutes + user_stats.active_today_minutes) AS integer) as today_work_minutes
  FROM user_stats;
END;
$$;
