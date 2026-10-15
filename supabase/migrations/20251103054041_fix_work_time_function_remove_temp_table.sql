/*
  # Fix Work Time Function - Remove Temporary Table

  1. Problem
    - Current function uses temporary tables which can cause issues:
      - Concurrent calls might interfere with each other
      - Temporary tables persist across transactions
      - May cause "table already exists" errors
    
  2. Solution
    - Rewrite function using CTE (Common Table Expression) instead
    - CTE is transaction-scoped and doesn't have naming conflicts
    - Maintains the same overlap-merging logic
    - More performant and safer for concurrent access
  
  3. Benefits
    - No temporary table management needed
    - Safe for concurrent access
    - Cleaner, more maintainable code
    - Better performance
*/

CREATE OR REPLACE FUNCTION get_user_work_time_today(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_today_start timestamptz;
  v_total_seconds integer := 0;
  v_current_start timestamptz;
  v_current_end timestamptz;
  v_merged_seconds integer := 0;
  r RECORD;
BEGIN
  v_today_start := date_trunc('day', now());
  
  -- Use CTE to gather all sessions (completed + active) in one query
  FOR r IN 
    WITH all_sessions AS (
      -- Completed sessions
      SELECT 
        ws.start_time,
        ws.end_time
      FROM work_sessions ws
      WHERE ws.user_id = p_user_id
        AND ws.end_time IS NOT NULL
        AND ws.start_time >= v_today_start
      
      UNION ALL
      
      -- Most recent active session (if exists)
      SELECT 
        ws.start_time,
        now() as end_time
      FROM work_sessions ws
      WHERE ws.user_id = p_user_id
        AND ws.end_time IS NULL
        AND ws.start_time >= v_today_start
      ORDER BY ws.start_time DESC
      LIMIT 1
    )
    SELECT start_time, end_time 
    FROM all_sessions
    ORDER BY start_time
  LOOP
    IF v_current_start IS NULL THEN
      -- First interval
      v_current_start := r.start_time;
      v_current_end := r.end_time;
    ELSIF r.start_time <= v_current_end THEN
      -- Overlapping interval - merge by extending current end if needed
      v_current_end := GREATEST(v_current_end, r.end_time);
    ELSE
      -- Non-overlapping interval - add current merged interval to total
      v_merged_seconds := v_merged_seconds + EXTRACT(EPOCH FROM (v_current_end - v_current_start))::integer;
      -- Start new interval
      v_current_start := r.start_time;
      v_current_end := r.end_time;
    END IF;
  END LOOP;
  
  -- Add the last merged interval
  IF v_current_start IS NOT NULL AND v_current_end IS NOT NULL THEN
    v_merged_seconds := v_merged_seconds + EXTRACT(EPOCH FROM (v_current_end - v_current_start))::integer;
  END IF;
  
  RETURN COALESCE(v_merged_seconds, 0);
END;
$$;

COMMENT ON FUNCTION get_user_work_time_today(uuid) IS 
'Calculates total work time in seconds for a user on the current UTC day.
Properly handles overlapping work sessions by merging time intervals.
Prevents double-counting when multiple sessions overlap in time.
Includes both completed sessions and the most recent active session.
Uses CTE for better performance and concurrency safety.';

GRANT EXECUTE ON FUNCTION get_user_work_time_today(uuid) TO authenticated;