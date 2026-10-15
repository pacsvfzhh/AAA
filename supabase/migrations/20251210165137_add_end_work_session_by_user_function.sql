/*
  # Add End Work Session by User Function
  
  ## Purpose
  - Provides a simple RPC function for sendBeacon to call during page unload
  - Reliably ends work sessions when browser closes unexpectedly
  - Works without requiring full authentication headers
  
  ## Security
  - Function only ends sessions for the specified user
  - No sensitive data is exposed
  - Rate limited by Supabase's built-in protection
*/

-- Create function to end work session by user ID
CREATE OR REPLACE FUNCTION end_work_session_by_user(p_user_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session_id uuid;
  v_start_time timestamptz;
  v_duration integer;
  v_result json;
BEGIN
  -- Find active work session for this user
  SELECT id, start_time INTO v_session_id, v_start_time
  FROM work_sessions
  WHERE user_id = p_user_id
  AND end_time IS NULL
  ORDER BY start_time DESC
  LIMIT 1;

  -- If no active session, return early
  IF v_session_id IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'message', 'No active session found'
    );
  END IF;

  -- Calculate duration in minutes
  v_duration := GREATEST(
    ROUND(EXTRACT(EPOCH FROM (now() - v_start_time)) / 60)::integer,
    1
  );

  -- End the work session
  UPDATE work_sessions
  SET 
    end_time = now(),
    duration_minutes = v_duration
  WHERE id = v_session_id;

  -- Also end any active dispatch sessions
  UPDATE dispatch_sessions
  SET 
    status = 'offline',
    ended_at = now()
  WHERE user_id = p_user_id
  AND status = 'online';

  v_result := json_build_object(
    'success', true,
    'session_id', v_session_id,
    'duration_minutes', v_duration,
    'ended_at', now()
  );

  RETURN v_result;
END;
$function$;

-- Grant execute to anon for sendBeacon calls (no auth)
GRANT EXECUTE ON FUNCTION end_work_session_by_user(uuid) TO anon;
GRANT EXECUTE ON FUNCTION end_work_session_by_user(uuid) TO authenticated;
