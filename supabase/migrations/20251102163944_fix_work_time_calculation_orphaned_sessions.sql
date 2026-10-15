/*
  # Fix Work Time Calculation - Handle Orphaned Sessions

  1. Problem
    - Multiple work_sessions with end_time IS NULL (orphaned sessions)
    - Function calculates time from earliest orphaned session to now
    - Results in incorrect work time display (shows 16+ hours when only worked 2 hours)

  2. Solution
    - Clean up orphaned sessions (sessions without end_time that are old)
    - Update get_user_work_time_today to only count the most recent active session
    - Add constraint to ensure only one active session per user at a time

  3. Changes
    - Close all orphaned sessions older than 30 minutes
    - Update function to get the single most recent active session
    - Add prevention logic for multiple active sessions
*/

-- Step 1: Close orphaned sessions (older than 30 minutes without end_time)
-- Set their end_time and calculate duration
UPDATE work_sessions
SET 
  end_time = start_time + interval '1 minute',
  duration_minutes = 1
WHERE end_time IS NULL 
  AND start_time < now() - interval '30 minutes';

-- Step 2: Update the function to be more robust
CREATE OR REPLACE FUNCTION get_user_work_time_today(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_today_start timestamptz;
  v_completed_seconds integer := 0;
  v_active_seconds integer := 0;
  v_active_session_start timestamptz;
BEGIN
  v_today_start := date_trunc('day', now());

  -- Get completed sessions today (only sessions with end_time)
  SELECT COALESCE(SUM(ws.duration_minutes * 60), 0)
  INTO v_completed_seconds
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NOT NULL
    AND ws.duration_minutes IS NOT NULL
    AND ws.start_time >= v_today_start;

  -- Get the SINGLE most recent active session (if exists and started today)
  SELECT ws.start_time
  INTO v_active_session_start
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id
    AND ws.end_time IS NULL
    AND ws.start_time >= v_today_start
  ORDER BY ws.start_time DESC
  LIMIT 1;
  
  -- Calculate active session duration if found
  IF v_active_session_start IS NOT NULL THEN
    v_active_seconds := GREATEST(0, EXTRACT(EPOCH FROM (now() - v_active_session_start))::integer);
  END IF;

  RETURN COALESCE(v_completed_seconds, 0) + COALESCE(v_active_seconds, 0);
END;
$$;

-- Step 3: Add a function to clean up duplicate active sessions
-- This ensures only one active session per user
CREATE OR REPLACE FUNCTION cleanup_duplicate_active_sessions()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  -- For each user with multiple active sessions, close all but the most recent one
  WITH duplicate_sessions AS (
    SELECT 
      id,
      user_id,
      start_time,
      ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY start_time DESC) as rn
    FROM work_sessions
    WHERE end_time IS NULL
  )
  UPDATE work_sessions ws
  SET 
    end_time = ws.start_time + interval '1 minute',
    duration_minutes = 1
  FROM duplicate_sessions ds
  WHERE ws.id = ds.id 
    AND ds.rn > 1;
END;
$$;

-- Run the cleanup immediately
SELECT cleanup_duplicate_active_sessions();

-- Step 4: Add a trigger to prevent multiple active sessions
CREATE OR REPLACE FUNCTION prevent_multiple_active_sessions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- If inserting a new session without end_time, close any existing active sessions
  IF NEW.end_time IS NULL THEN
    UPDATE work_sessions
    SET 
      end_time = now(),
      duration_minutes = GREATEST(1, EXTRACT(EPOCH FROM (now() - start_time))::integer / 60)
    WHERE user_id = NEW.user_id
      AND end_time IS NULL
      AND id != NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Drop trigger if exists and recreate
DROP TRIGGER IF EXISTS trigger_prevent_multiple_active_sessions ON work_sessions;

CREATE TRIGGER trigger_prevent_multiple_active_sessions
  BEFORE INSERT OR UPDATE ON work_sessions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_multiple_active_sessions();
