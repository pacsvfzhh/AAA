/*
# Fix end_work_session to Use Accurate End Time Based on Heartbeat

## Problem
When a page was hidden on mobile (background tab, app switched), the heartbeat
stops updating. If we detect a gap when the page becomes visible again, we call
`end_work_session` to close the old session. But using `now()` as end_time would
include the entire hidden period as "work time".

## Solution
Update `end_work_session` to use `last_heartbeat_at + 1 minute` as the end time
when the last heartbeat is more than 2 minutes old. This ensures:
- Normal stop (user clicks button): uses `now()` since heartbeat is recent
- Gap recovery (page was hidden): uses last known activity time

## Changes
1. Updated `end_work_session()` to use heartbeat-based end time when stale
2. This ensures accurate duration even when called after a visibility gap

## Important Notes
1. When heartbeat is recent (< 2 min old), behavior is unchanged (uses now())
2. When heartbeat is stale (> 2 min old), uses last_heartbeat_at + 1 minute
3. Duration calculation uses the accurate end time
*/

CREATE OR REPLACE FUNCTION end_work_session(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_session_id uuid;
  v_start_time timestamptz;
  v_last_heartbeat timestamptz;
  v_end_time timestamptz;
  v_duration integer;
BEGIN
  -- Find active session
  SELECT id, start_time, last_heartbeat_at 
  INTO v_session_id, v_start_time, v_last_heartbeat
  FROM work_sessions
  WHERE user_id = p_user_id AND end_time IS NULL
  ORDER BY start_time DESC
  LIMIT 1;
  
  -- If no active session, return false
  IF v_session_id IS NULL THEN
    RETURN false;
  END IF;
  
  -- Determine accurate end time:
  -- If last_heartbeat is recent (within 2 min), use now() (normal stop by user)
  -- If last_heartbeat is stale (> 2 min old), use last_heartbeat + 1 min (gap recovery)
  IF v_last_heartbeat IS NOT NULL AND v_last_heartbeat < now() - interval '2 minutes' THEN
    v_end_time := v_last_heartbeat + interval '1 minute';
  ELSE
    v_end_time := now();
  END IF;
  
  -- Calculate duration in minutes
  v_duration := GREATEST(EXTRACT(EPOCH FROM (v_end_time - v_start_time)) / 60, 1)::integer;
  
  -- End the session with accurate end time
  UPDATE work_sessions
  SET end_time = v_end_time,
      duration_minutes = v_duration
  WHERE id = v_session_id;
  
  RETURN true;
END;
$$;

-- Also fix end_work_session_by_user (called by sendBeacon on page close)
-- Same logic: use heartbeat-based end time if stale
CREATE OR REPLACE FUNCTION end_work_session_by_user(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_session_id uuid;
  v_start_time timestamptz;
  v_last_heartbeat timestamptz;
  v_end_time timestamptz;
  v_duration integer;
  v_result json;
BEGIN
  -- Find active work session
  SELECT id, start_time, last_heartbeat_at 
  INTO v_session_id, v_start_time, v_last_heartbeat
  FROM work_sessions
  WHERE user_id = p_user_id AND end_time IS NULL
  ORDER BY start_time DESC
  LIMIT 1;
  
  IF v_session_id IS NULL THEN
    v_result := json_build_object('success', false, 'reason', 'no_active_session');
    RETURN v_result;
  END IF;
  
  -- Determine accurate end time based on heartbeat freshness
  IF v_last_heartbeat IS NOT NULL AND v_last_heartbeat < now() - interval '2 minutes' THEN
    v_end_time := v_last_heartbeat + interval '1 minute';
  ELSE
    v_end_time := now();
  END IF;
  
  -- Calculate duration
  v_duration := GREATEST(EXTRACT(EPOCH FROM (v_end_time - v_start_time)) / 60, 1)::integer;
  
  -- End the work session
  UPDATE work_sessions
  SET end_time = v_end_time,
      duration_minutes = v_duration
  WHERE id = v_session_id;
  
  -- Also mark dispatch sessions offline
  UPDATE dispatch_sessions
  SET status = 'offline',
      ended_at = v_end_time
  WHERE user_id = p_user_id
  AND status = 'online';
  
  v_result := json_build_object(
    'success', true,
    'session_id', v_session_id,
    'end_time', v_end_time,
    'duration_minutes', v_duration
  );
  
  RETURN v_result;
END;
$$;

-- Grant permissions (sendBeacon uses anon key)
GRANT EXECUTE ON FUNCTION end_work_session(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION end_work_session(uuid) TO anon;
GRANT EXECUTE ON FUNCTION end_work_session_by_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION end_work_session_by_user(uuid) TO anon;
