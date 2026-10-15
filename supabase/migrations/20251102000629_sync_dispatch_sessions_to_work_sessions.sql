/*
  # Sync Dispatch Sessions to Work Sessions
  
  1. Purpose
    - Automatically sync dispatch_sessions to work_sessions for time tracking
    - When a dispatch session starts, create a work session
    - When a dispatch session ends, end the work session with calculated duration
    
  2. Changes
    - Create trigger function to sync session creation
    - Create trigger function to sync session ending
    - Add triggers on dispatch_sessions table
    
  3. Notes
    - This ensures work time is automatically tracked based on dispatch sessions
    - Duration is calculated in minutes for consistency
*/

-- Function to create work session when dispatch session starts
CREATE OR REPLACE FUNCTION sync_dispatch_session_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only create work session if status is 'online' and started_at is set
  IF NEW.status = 'online' AND NEW.started_at IS NOT NULL THEN
    -- Insert into work_sessions (use dispatch_session id as work_session id for tracking)
    INSERT INTO work_sessions (id, user_id, start_time)
    VALUES (NEW.id, NEW.user_id, NEW.started_at)
    ON CONFLICT (id) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Function to end work session when dispatch session ends
CREATE OR REPLACE FUNCTION sync_dispatch_session_end()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_duration_minutes integer;
BEGIN
  -- Only process if status changed to 'offline' and ended_at is set
  IF NEW.status = 'offline' AND NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL THEN
    -- Calculate duration in minutes
    v_duration_minutes := EXTRACT(EPOCH FROM (NEW.ended_at - NEW.started_at)) / 60;
    
    -- Update work_sessions table
    UPDATE work_sessions
    SET 
      end_time = NEW.ended_at,
      duration_minutes = v_duration_minutes
    WHERE id = NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Create trigger for session start (INSERT)
DROP TRIGGER IF EXISTS trigger_sync_dispatch_session_start ON dispatch_sessions;
CREATE TRIGGER trigger_sync_dispatch_session_start
  AFTER INSERT ON dispatch_sessions
  FOR EACH ROW
  EXECUTE FUNCTION sync_dispatch_session_start();

-- Create trigger for session end (UPDATE)
DROP TRIGGER IF EXISTS trigger_sync_dispatch_session_end ON dispatch_sessions;
CREATE TRIGGER trigger_sync_dispatch_session_end
  AFTER UPDATE ON dispatch_sessions
  FOR EACH ROW
  WHEN (NEW.status = 'offline' AND NEW.ended_at IS NOT NULL)
  EXECUTE FUNCTION sync_dispatch_session_end();
