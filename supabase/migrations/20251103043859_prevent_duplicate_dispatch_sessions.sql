/*
  # Prevent Duplicate Dispatch Sessions

  1. Problem
    - Multiple dispatch_sessions can be created for the same user simultaneously
    - Each session creates its own work_session
    - Results in overlapping work_sessions and inflated work time calculations
    
  2. Solution
    - Add trigger to automatically close existing online sessions before creating new one
    - Ensures only ONE active dispatch_session per user at any time
    - Prevents creation of overlapping work_sessions
    
  3. Implementation
    - Create trigger function that runs BEFORE INSERT on dispatch_sessions
    - Automatically sets existing online sessions to offline
    - Allows the new session to be created cleanly
*/

-- Function to prevent multiple active dispatch sessions
CREATE OR REPLACE FUNCTION prevent_duplicate_dispatch_sessions()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- If creating a new online session, close any existing online sessions for this user
  IF NEW.status = 'online' THEN
    UPDATE dispatch_sessions
    SET 
      status = 'offline',
      ended_at = now()
    WHERE user_id = NEW.user_id
      AND status = 'online'
      AND id != NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$;

-- Drop trigger if exists and recreate
DROP TRIGGER IF EXISTS trigger_prevent_duplicate_dispatch_sessions ON dispatch_sessions;

CREATE TRIGGER trigger_prevent_duplicate_dispatch_sessions
  BEFORE INSERT ON dispatch_sessions
  FOR EACH ROW
  EXECUTE FUNCTION prevent_duplicate_dispatch_sessions();

COMMENT ON FUNCTION prevent_duplicate_dispatch_sessions() IS 
'Automatically closes existing online dispatch sessions before creating a new one.
Ensures only one active dispatch session per user at any time.
Prevents creation of overlapping work sessions.';