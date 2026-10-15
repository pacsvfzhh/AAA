/*
  # Fix get_user_work_time_today NULL Handling
  
  1. Issue
    - Function returns NULL when there's no active session
    - The SELECT INTO statement sets variable to NULL when no rows are found
    - This causes the final addition to return NULL (completed + NULL = NULL)
    
  2. Solution
    - Ensure v_active_seconds is always coalesced to 0
    - Use COALESCE in the RETURN statement as final safeguard
*/

CREATE OR REPLACE FUNCTION get_user_work_time_today(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_today_start timestamptz;
  v_completed_seconds integer := 0;
  v_active_seconds integer := 0;
BEGIN
  v_today_start := date_trunc('day', now());

  -- Get completed sessions today (in seconds)
  SELECT COALESCE(SUM(ws.duration_minutes * 60), 0)
  INTO v_completed_seconds
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NOT NULL
    AND ws.start_time >= v_today_start;

  -- Get active session time (if started today)
  -- Use SELECT ... INTO with explicit NULL handling
  SELECT COALESCE(EXTRACT(EPOCH FROM (now() - ws.start_time))::integer, 0)
  INTO v_active_seconds
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NULL
    AND ws.start_time >= v_today_start
  LIMIT 1;
  
  -- If no active session found, v_active_seconds will be NULL, so coalesce it
  v_active_seconds := COALESCE(v_active_seconds, 0);

  -- Return total, with extra safeguard
  RETURN COALESCE(v_completed_seconds, 0) + COALESCE(v_active_seconds, 0);
END;
$$;
