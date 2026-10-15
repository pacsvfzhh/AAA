/*
  # Fix get_batch_work_time to Use Seconds-based Calculation

  1. Problem
    - get_user_work_time_today returns seconds (precise)
    - get_batch_work_time returns minutes (uses rounded duration_minutes field)
    - This causes inconsistency: 649 seconds = 10.82 minutes
      - Employee panel shows: 10 minutes (649/60 = 10.8, displayed as 10)
      - Admin panel shows: 11 minutes (duration_minutes field stored as 11)
    
  2. Root Cause
    - duration_minutes field is calculated as: EXTRACT(EPOCH FROM (now() - start_time)) / 60
    - This rounds 10.54 minutes to 11 minutes when stored
    - get_batch_work_time uses this rounded value directly
    
  3. Solution
    - Change get_batch_work_time to calculate from actual timestamps
    - Use EXTRACT(EPOCH FROM (end_time - start_time)) for precise seconds
    - Convert to minutes at return time for consistency
    - Match the logic of get_user_work_time_today
    
  4. Benefits
    - Both functions return consistent values
    - More accurate work time tracking
    - Seconds-level precision maintained
*/

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
      -- Total completed work time (in seconds, then convert to minutes)
      COALESCE(SUM(
        CASE 
          WHEN ws.end_time IS NOT NULL 
          THEN EXTRACT(EPOCH FROM (ws.end_time - ws.start_time))
          ELSE 0 
        END
      ), 0) as completed_seconds,
      -- Total today's completed work time (in seconds)
      COALESCE(SUM(
        CASE 
          WHEN ws.end_time IS NOT NULL AND ws.start_time >= v_today_start
          THEN EXTRACT(EPOCH FROM (ws.end_time - ws.start_time))
          ELSE 0 
        END
      ), 0) as today_completed_seconds,
      -- Active session total time (if exists, in seconds)
      COALESCE(MAX(
        CASE 
          WHEN ws.end_time IS NULL 
          THEN EXTRACT(EPOCH FROM (now() - ws.start_time))
          ELSE 0 
        END
      ), 0) as active_seconds,
      -- Active session today time (if started today, in seconds)
      COALESCE(MAX(
        CASE 
          WHEN ws.end_time IS NULL AND ws.start_time >= v_today_start
          THEN EXTRACT(EPOCH FROM (now() - ws.start_time))
          ELSE 0 
        END
      ), 0) as active_today_seconds
    FROM unnest(p_user_ids) u(id)
    LEFT JOIN work_sessions ws ON ws.user_id = u.id
    GROUP BY u.id
  )
  SELECT 
    user_stats.user_id,
    -- Convert seconds to minutes (round down to match display logic)
    CAST(FLOOR((user_stats.completed_seconds + user_stats.active_seconds) / 60) AS integer) as total_work_minutes,
    CAST(FLOOR((user_stats.today_completed_seconds + user_stats.active_today_seconds) / 60) AS integer) as today_work_minutes
  FROM user_stats;
END;
$$;

COMMENT ON FUNCTION get_batch_work_time(uuid[]) IS 
'Calculates work time for multiple users in a single query.
Uses seconds-based calculation from actual timestamps for precision.
Returns minutes (rounded down) to match get_user_work_time_today display logic.
Includes both completed sessions and active sessions.';

GRANT EXECUTE ON FUNCTION get_batch_work_time(uuid[]) TO authenticated;