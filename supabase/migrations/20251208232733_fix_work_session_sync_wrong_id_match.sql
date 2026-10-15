/*
  # Fix work session sync - wrong ID matching

  ## Problem
  The sync_dispatch_session_end function was using dispatch_session.id to update work_sessions,
  but these two tables have different IDs. The UPDATE never found matching records.

  ## Solution
  Match work_sessions by user_id and start_time instead of id.

  ## Changes
  1. Fix sync_dispatch_session_end function to use correct matching criteria
  2. Fix any existing incorrect work_sessions data
*/

-- Fix the sync function
CREATE OR REPLACE FUNCTION sync_dispatch_session_end()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_duration_minutes integer;
BEGIN
  -- Only process if status changed to 'offline' and ended_at is set
  IF NEW.status = 'offline' AND NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL THEN
    -- Calculate duration in minutes
    v_duration_minutes := EXTRACT(EPOCH FROM (NEW.ended_at - NEW.started_at)) / 60;

    -- Update work_sessions table - match by user_id and approximate start_time
    UPDATE work_sessions
    SET 
      end_time = NEW.ended_at,
      duration_minutes = v_duration_minutes
    WHERE user_id = NEW.user_id
      AND start_time >= NEW.started_at - interval '5 seconds'
      AND start_time <= NEW.started_at + interval '5 seconds'
      AND end_time IS NULL;
  END IF;

  RETURN NEW;
END;
$$;

-- Fix existing incorrect work_sessions data by syncing from dispatch_sessions
UPDATE work_sessions ws
SET 
  end_time = ds.ended_at,
  duration_minutes = EXTRACT(EPOCH FROM (ds.ended_at - ds.started_at)) / 60
FROM dispatch_sessions ds
WHERE ws.user_id = ds.user_id
  AND ws.start_time >= ds.started_at - interval '5 seconds'
  AND ws.start_time <= ds.started_at + interval '5 seconds'
  AND ds.ended_at IS NOT NULL
  AND (ws.end_time IS NULL OR ws.end_time > ds.ended_at + interval '1 minute');

-- Add comment
COMMENT ON FUNCTION sync_dispatch_session_end IS 'Syncs dispatch session end time to work_sessions. Fixed to use user_id + start_time matching instead of id.';
