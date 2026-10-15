/*
  # Fix Work Time Calculation - Handle Overlapping Sessions

  1. Problem
    - Multiple work_sessions with overlapping time periods
    - Simple SUM(duration_minutes) counts overlapping time multiple times
    - Results in inflated work time (13+ hours when actual work was much less)
    - Example: Two sessions from 10:00-12:00 both count 2 hours = 4 hours total (WRONG!)

  2. Root Cause
    - Multiple dispatch_sessions created simultaneously (testing or bugs)
    - Each dispatch_session created its own work_session
    - Sessions have overlapping time ranges
    - Current function doesn't merge overlapping periods

  3. Solution
    - Implement proper interval merging algorithm
    - Merge all overlapping time periods before calculating total
    - Only count each minute of work time once, even if multiple sessions overlap
    
  4. Algorithm
    - Sort all sessions by start_time
    - Merge overlapping intervals
    - Calculate total from merged intervals
    - Handle active sessions (end_time IS NULL) correctly
*/

-- Create the new function with proper overlap handling
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
  
  -- Create a temporary table to hold all sessions (completed and active)
  CREATE TEMP TABLE IF NOT EXISTS temp_sessions (
    start_time timestamptz,
    end_time timestamptz
  ) ON COMMIT DROP;
  
  -- Clear any existing data
  DELETE FROM temp_sessions;
  
  -- Insert completed sessions
  INSERT INTO temp_sessions (start_time, end_time)
  SELECT 
    ws.start_time,
    ws.end_time
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NOT NULL
    AND ws.start_time >= v_today_start;
  
  -- Insert the most recent active session (if exists)
  INSERT INTO temp_sessions (start_time, end_time)
  SELECT 
    ws.start_time,
    now() as end_time
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NULL
    AND ws.start_time >= v_today_start
  ORDER BY ws.start_time DESC
  LIMIT 1;
  
  -- If no sessions, return 0
  IF NOT EXISTS (SELECT 1 FROM temp_sessions) THEN
    DROP TABLE IF EXISTS temp_sessions;
    RETURN 0;
  END IF;
  
  -- Merge overlapping intervals and calculate total time
  -- Algorithm: Sort by start_time, merge overlapping periods
  v_current_start := NULL;
  v_current_end := NULL;
  
  FOR r IN 
    SELECT start_time, end_time 
    FROM temp_sessions 
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
  
  -- Clean up
  DROP TABLE IF EXISTS temp_sessions;
  
  RETURN COALESCE(v_merged_seconds, 0);
END;
$$;

COMMENT ON FUNCTION get_user_work_time_today(uuid) IS 
'Calculates total work time in seconds for a user on the current UTC day.
Properly handles overlapping work sessions by merging time intervals.
Prevents double-counting when multiple sessions overlap in time.
Includes both completed sessions and the most recent active session.';

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION get_user_work_time_today(uuid) TO authenticated;