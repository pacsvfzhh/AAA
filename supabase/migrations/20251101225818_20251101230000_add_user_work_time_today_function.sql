/*
  # Add User Work Time Today Function

  1. New Function
    - `get_user_work_time_today(p_user_id uuid)` - Get today's total work time in seconds for a user
    - Returns integer (total seconds worked today)
    - Includes both completed sessions and currently active session

  2. Purpose
    - Display real-time work duration for employees
    - Used in Work Session Control panel to show total work time
    - Updates every minute to reflect current session time
*/

-- Function to get today's work time for a single user in seconds
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
  SELECT COALESCE(EXTRACT(EPOCH FROM (now() - ws.start_time))::integer, 0)
  INTO v_active_seconds
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NULL
    AND ws.start_time >= v_today_start
  LIMIT 1;

  RETURN v_completed_seconds + v_active_seconds;
END;
$$;
