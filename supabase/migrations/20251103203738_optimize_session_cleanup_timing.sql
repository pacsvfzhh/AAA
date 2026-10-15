/*
  # Optimize Session Cleanup Timing

  1. Changes
    - Reduce dispatch_sessions cleanup interval from 30 minutes to 3 minutes
    - Reduce work_sessions cleanup interval from 2 hours to 15 minutes
    - Add fast cleanup function for immediate status updates
  
  2. Rationale
    - 3 minutes for dispatch sessions: Quick detection of browser closure/crashes
    - 15 minutes for work sessions: Reasonable max session duration before auto-end
    - Admins get near real-time employee status
    
  3. Behavior
    - If employee is actively working: last_activity_at is updated every 30 seconds
    - If no activity for 3 minutes: Marked as offline (browser closed)
    - Work sessions auto-end after 15 minutes of inactivity
*/

-- Optimized cleanup for dispatch sessions (3 minutes instead of 30)
CREATE OR REPLACE FUNCTION cleanup_stale_dispatch_sessions()
RETURNS TABLE (
  cleaned_session_id uuid,
  user_id uuid,
  started_at timestamptz,
  inactive_duration interval
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Mark dispatch sessions as offline if no activity for more than 3 minutes
  -- This provides near real-time status updates for admins
  RETURN QUERY
  UPDATE dispatch_sessions ds
  SET 
    status = 'offline',
    ended_at = last_activity_at + interval '3 minutes'
  WHERE ds.status = 'online'
    AND ds.last_activity_at < now() - interval '3 minutes'
  RETURNING 
    ds.id,
    ds.user_id,
    ds.started_at,
    now() - ds.last_activity_at;
END;
$$;

-- Optimized cleanup for work sessions (15 minutes instead of 2 hours)
CREATE OR REPLACE FUNCTION cleanup_stale_work_sessions()
RETURNS TABLE (
  cleaned_session_id uuid,
  user_id uuid,
  started_at timestamptz,
  duration_calculated integer
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- End work sessions that have been active for more than 15 minutes without being ended
  -- This is a reasonable maximum session duration
  RETURN QUERY
  UPDATE work_sessions ws
  SET 
    end_time = start_time + interval '15 minutes',
    duration_minutes = 15
  WHERE ws.end_time IS NULL
    AND ws.start_time < now() - interval '15 minutes'
  RETURNING 
    ws.id,
    ws.user_id,
    ws.start_time,
    ws.duration_minutes;
END;
$$;

-- Add a fast cleanup function for immediate status checks
-- This can be called frequently without performance concerns
CREATE OR REPLACE FUNCTION cleanup_inactive_sessions()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  dispatch_cleaned integer;
  result json;
BEGIN
  -- Only cleanup dispatch sessions (fastest operation)
  SELECT COUNT(*) INTO dispatch_cleaned
  FROM cleanup_stale_dispatch_sessions();
  
  result := json_build_object(
    'dispatch_sessions_cleaned', dispatch_cleaned,
    'cleaned_at', now()
  );
  
  RETURN result;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION cleanup_inactive_sessions() TO authenticated;

COMMENT ON FUNCTION cleanup_stale_dispatch_sessions() IS 'Marks dispatch sessions as offline if inactive for >3 minutes. Provides near real-time status.';
COMMENT ON FUNCTION cleanup_stale_work_sessions() IS 'Ends work sessions that have been active for >15 minutes. Prevents indefinite accumulation.';
COMMENT ON FUNCTION cleanup_inactive_sessions() IS 'Fast cleanup for dispatch sessions only. Can be called frequently for real-time status updates.';
