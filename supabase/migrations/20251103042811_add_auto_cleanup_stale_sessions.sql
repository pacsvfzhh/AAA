/*
  # Auto-cleanup stale work and dispatch sessions

  1. New Functions
    - `cleanup_stale_work_sessions()` - Automatically ends work sessions that have been active for too long without activity
    - `cleanup_stale_dispatch_sessions()` - Automatically marks dispatch sessions as offline if inactive for too long
  
  2. Purpose
    - Handle cases where user closes browser without clicking stop
    - Handle network disconnections and crashes
    - Prevent work time from accumulating indefinitely
    - Automatically clean up orphaned sessions
  
  3. Logic
    - Work sessions: End any session that has been active for more than 2 hours without being ended
    - Dispatch sessions: Mark as offline any session that hasn't had activity for more than 30 minutes
    
  4. Usage
    - Can be called manually by admin
    - Can be scheduled to run periodically (e.g., every 15 minutes)
*/

-- Function to cleanup stale work sessions
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
  -- End work sessions that have been active for more than 2 hours
  -- This handles cases where user closed browser or network disconnected
  RETURN QUERY
  UPDATE work_sessions ws
  SET 
    end_time = start_time + interval '2 hours',
    duration_minutes = 120
  WHERE ws.end_time IS NULL
    AND ws.start_time < now() - interval '2 hours'
  RETURNING 
    ws.id,
    ws.user_id,
    ws.start_time,
    ws.duration_minutes;
END;
$$;

-- Function to cleanup stale dispatch sessions
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
  -- Mark dispatch sessions as offline if no activity for more than 30 minutes
  RETURN QUERY
  UPDATE dispatch_sessions ds
  SET 
    status = 'offline',
    ended_at = last_activity_at + interval '30 minutes'
  WHERE ds.status = 'online'
    AND ds.last_activity_at < now() - interval '30 minutes'
  RETURNING 
    ds.id,
    ds.user_id,
    ds.started_at,
    now() - ds.last_activity_at;
END;
$$;

-- Function to run both cleanup operations
CREATE OR REPLACE FUNCTION cleanup_all_stale_sessions()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  work_sessions_cleaned integer;
  dispatch_sessions_cleaned integer;
  result json;
BEGIN
  -- Cleanup work sessions
  SELECT COUNT(*) INTO work_sessions_cleaned
  FROM cleanup_stale_work_sessions();
  
  -- Cleanup dispatch sessions
  SELECT COUNT(*) INTO dispatch_sessions_cleaned
  FROM cleanup_stale_dispatch_sessions();
  
  -- Return summary
  result := json_build_object(
    'work_sessions_cleaned', work_sessions_cleaned,
    'dispatch_sessions_cleaned', dispatch_sessions_cleaned,
    'cleaned_at', now()
  );
  
  RETURN result;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION cleanup_stale_work_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_stale_dispatch_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_all_stale_sessions() TO authenticated;