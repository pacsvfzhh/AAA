/*
  # Optimize Work Session Stale Detection System
  
  ## Problem
  - Current 3-hour timeout is too long for stale session detection
  - If browser crashes, work time could be inflated by hours
  - Need more accurate work time calculation based on actual activity
  
  ## Solution
  1. Reduce stale session timeout from 3 hours to 10 minutes
  2. Calculate work time based on last_activity_at instead of current time
  3. Add smarter cleanup that preserves accurate work duration
  4. Add work_sessions.last_heartbeat_at column for precise tracking
  
  ## Changes
  - Add last_heartbeat_at column to work_sessions
  - Update cleanup function to use 10-minute timeout
  - Calculate duration based on last heartbeat, not current time
  
  ## Performance Impact
  - Minimal - only affects cleanup operations
  - No impact on normal session operations
*/

-- 1. Add last_heartbeat_at column to work_sessions if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'work_sessions' AND column_name = 'last_heartbeat_at'
  ) THEN
    ALTER TABLE work_sessions ADD COLUMN last_heartbeat_at timestamptz DEFAULT now();
    
    CREATE INDEX IF NOT EXISTS idx_work_sessions_last_heartbeat 
    ON work_sessions(last_heartbeat_at) 
    WHERE end_time IS NULL;
  END IF;
END $$;

-- 2. Create optimized stale session cleanup function
CREATE OR REPLACE FUNCTION cleanup_stale_work_sessions_optimized()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  updated_count integer;
  result json;
  v_stale_timeout_minutes integer := 10;
BEGIN
  /*
    Optimized cleanup logic:
    1. Sessions without heartbeat for 10+ minutes are considered stale
    2. Work time is calculated based on LAST HEARTBEAT, not current time
    3. This ensures accurate work time even if browser crashes
    4. Maximum duration cap of 480 minutes (8 hours) as safety net
  */
  
  WITH stale_sessions AS (
    SELECT 
      id,
      user_id,
      start_time,
      last_heartbeat_at,
      COALESCE(last_heartbeat_at, start_time) as last_active,
      -- Calculate actual work duration based on last heartbeat
      LEAST(
        EXTRACT(EPOCH FROM (COALESCE(last_heartbeat_at, start_time + interval '1 minute') - start_time)) / 60,
        480  -- Max 8 hours cap
      ) as calculated_duration
    FROM work_sessions
    WHERE end_time IS NULL
    AND (
      -- No heartbeat for 10 minutes
      (last_heartbeat_at IS NOT NULL AND last_heartbeat_at < now() - (v_stale_timeout_minutes || ' minutes')::interval)
      OR
      -- No heartbeat column set and session older than 10 minutes
      (last_heartbeat_at IS NULL AND start_time < now() - (v_stale_timeout_minutes || ' minutes')::interval)
    )
  ),
  updated AS (
    UPDATE work_sessions ws
    SET 
      end_time = COALESCE(ss.last_active, ws.start_time) + interval '1 minute',
      duration_minutes = GREATEST(ss.calculated_duration, 1)::integer
    FROM stale_sessions ss
    WHERE ws.id = ss.id
    RETURNING ws.id
  )
  SELECT COUNT(*) INTO updated_count FROM updated;

  result := json_build_object(
    'table', 'work_sessions',
    'stale_timeout_minutes', v_stale_timeout_minutes,
    'sessions_closed', updated_count,
    'cleaned_at', now(),
    'method', 'heartbeat_based_duration'
  );

  RETURN result;
END;
$function$;

-- 3. Update the heartbeat function to also update work_sessions
CREATE OR REPLACE FUNCTION update_session_heartbeat(p_session_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid;
  v_result json;
BEGIN
  -- Update dispatch session heartbeat
  UPDATE dispatch_sessions
  SET last_activity_at = now()
  WHERE id = p_session_id
  RETURNING user_id INTO v_user_id;

  -- Also update work session heartbeat for the same user
  IF v_user_id IS NOT NULL THEN
    UPDATE work_sessions
    SET last_heartbeat_at = now()
    WHERE user_id = v_user_id
    AND end_time IS NULL;
  END IF;

  v_result := json_build_object(
    'success', v_user_id IS NOT NULL,
    'session_id', p_session_id,
    'user_id', v_user_id,
    'heartbeat_at', now()
  );

  RETURN v_result;
END;
$function$;

-- 4. Create comprehensive auto-cleanup function
CREATE OR REPLACE FUNCTION auto_cleanup_stale_sessions_fast()
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_work_result json;
  v_dispatch_result json;
  v_dispatch_cleaned integer;
BEGIN
  -- 1. Cleanup stale work sessions (10 minute timeout, heartbeat-based duration)
  SELECT cleanup_stale_work_sessions_optimized() INTO v_work_result;

  -- 2. Cleanup stale dispatch sessions (3 minute timeout for real-time status)
  SELECT COUNT(*) INTO v_dispatch_cleaned
  FROM cleanup_stale_dispatch_sessions();

  v_dispatch_result := json_build_object(
    'sessions_marked_offline', v_dispatch_cleaned
  );

  RETURN json_build_object(
    'work_sessions', v_work_result,
    'dispatch_sessions', v_dispatch_result,
    'executed_at', now()
  );
END;
$function$;

-- 5. Update start_work_session to initialize last_heartbeat_at
CREATE OR REPLACE FUNCTION start_work_session(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_session_id uuid;
  v_existing_session_id uuid;
BEGIN
  -- Check for existing active session
  SELECT id INTO v_existing_session_id
  FROM work_sessions
  WHERE user_id = p_user_id
  AND end_time IS NULL
  ORDER BY start_time DESC
  LIMIT 1;

  -- If active session exists, return it
  IF v_existing_session_id IS NOT NULL THEN
    -- Update heartbeat on existing session
    UPDATE work_sessions
    SET last_heartbeat_at = now()
    WHERE id = v_existing_session_id;
    
    RETURN v_existing_session_id;
  END IF;

  -- Create new session with heartbeat initialized
  INSERT INTO work_sessions (user_id, start_time, last_heartbeat_at)
  VALUES (p_user_id, now(), now())
  RETURNING id INTO v_session_id;

  -- Guarantee non-null return
  IF v_session_id IS NULL THEN
    RAISE EXCEPTION 'Failed to create work session';
  END IF;

  RETURN v_session_id;
END;
$function$;

-- 6. Create index for efficient stale session queries
CREATE INDEX IF NOT EXISTS idx_work_sessions_stale_check
ON work_sessions(user_id, last_heartbeat_at)
WHERE end_time IS NULL;

-- 7. Update existing active sessions to have last_heartbeat_at set
UPDATE work_sessions
SET last_heartbeat_at = COALESCE(last_heartbeat_at, start_time)
WHERE end_time IS NULL
AND last_heartbeat_at IS NULL;
