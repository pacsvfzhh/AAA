/*
# Update cleanup_all_stale_sessions to Use Optimized Heartbeat-Based Cleanup

## Problem
The `cleanup_all_stale_sessions()` function (called by frontend on page load) still
references the old `cleanup_stale_work_sessions()` function which uses a 2-hour timeout.
This needs to use the optimized version with 3-minute heartbeat-based timeout.

## Changes
1. Updated `cleanup_all_stale_sessions()` to call `cleanup_stale_work_sessions_optimized()`
2. This ensures that whenever any employee loads the page, stale sessions from crashed
   browsers get cleaned up with accurate time calculations
3. Also grant anon permission so the sendBeacon endpoint can trigger cleanup

## Important Notes
1. The old `cleanup_stale_work_sessions()` is preserved but no longer called by default
2. Stale timeout reduced from 2 hours to 3 minutes for more accurate work time
3. Stale sessions now get end_time = last_heartbeat_at + 1 minute (accurate)
*/

-- Update cleanup_all_stale_sessions to use optimized version
CREATE OR REPLACE FUNCTION cleanup_all_stale_sessions()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  work_result json;
  dispatch_sessions_cleaned integer;
  result json;
BEGIN
  -- Cleanup work sessions using optimized heartbeat-based approach
  SELECT cleanup_stale_work_sessions_optimized() INTO work_result;
  
  -- Cleanup dispatch sessions
  SELECT COUNT(*) INTO dispatch_sessions_cleaned
  FROM cleanup_stale_dispatch_sessions();
  
  -- Return summary
  result := json_build_object(
    'work_sessions_result', work_result,
    'dispatch_sessions_cleaned', dispatch_sessions_cleaned,
    'cleaned_at', now()
  );
  
  RETURN result;
END;
$$;

-- Ensure permissions
GRANT EXECUTE ON FUNCTION cleanup_all_stale_sessions() TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_all_stale_sessions() TO anon;
GRANT EXECUTE ON FUNCTION cleanup_stale_work_sessions_optimized() TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_stale_work_sessions_optimized() TO anon;
