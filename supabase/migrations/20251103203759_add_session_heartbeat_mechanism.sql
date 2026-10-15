/*
  # Add Session Heartbeat Mechanism

  1. New Function
    - `update_session_heartbeat(session_id)` - Updates last_activity_at for active sessions
  
  2. Purpose
    - Allow frontend to send periodic heartbeat signals
    - Keeps session alive while user is actively working
    - Enables accurate real-time status detection
    
  3. Usage
    - Frontend calls this every 30 seconds while working
    - Only updates if session is still online
    - Lightweight operation for frequent calls
*/

-- Function to update session heartbeat
CREATE OR REPLACE FUNCTION update_session_heartbeat(
  p_session_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_rows integer;
BEGIN
  -- Update last_activity_at only if session is online
  UPDATE dispatch_sessions
  SET last_activity_at = now()
  WHERE id = p_session_id
    AND status = 'online';
  
  GET DIAGNOSTICS updated_rows = ROW_COUNT;
  
  RETURN updated_rows > 0;
END;
$$;

-- Grant execute permission
GRANT EXECUTE ON FUNCTION update_session_heartbeat(uuid) TO authenticated;

COMMENT ON FUNCTION update_session_heartbeat(uuid) IS 'Updates last_activity_at for an active session. Called every 30s by frontend to maintain heartbeat.';
