/*
  # Fix start_work_session to Guarantee Non-NULL Return
  
  1. Problem
    - start_work_session can still return NULL in edge cases
    - After unique_violation exception, if no session is found, NULL is returned
    - This causes "Cannot read properties of null (reading 'id')" error in frontend
  
  2. Solution
    - Add explicit NULL check and raise exception if session cannot be created or retrieved
    - Ensure function ALWAYS returns a valid UUID or raises an error
    - Add better error messages for debugging
  
  3. Changes
    - Rewrite start_work_session with guaranteed non-NULL return
    - Add comprehensive error handling
    - Add detailed logging for troubleshooting
*/

CREATE OR REPLACE FUNCTION start_work_session(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_active_session_id uuid;
  v_session_id uuid;
  v_user_exists boolean;
BEGIN
  -- Validate user exists
  SELECT EXISTS(SELECT 1 FROM users WHERE id = p_user_id) INTO v_user_exists;
  
  IF NOT v_user_exists THEN
    RAISE EXCEPTION 'User % does not exist in users table', p_user_id;
  END IF;

  -- Check for existing active session
  SELECT id INTO v_active_session_id
  FROM work_sessions
  WHERE user_id = p_user_id
    AND end_time IS NULL
  ORDER BY start_time DESC
  LIMIT 1;

  -- If active session exists, return it
  IF v_active_session_id IS NOT NULL THEN
    RETURN v_active_session_id;
  END IF;

  -- Create new session
  BEGIN
    INSERT INTO work_sessions (user_id, start_time)
    VALUES (p_user_id, now())
    RETURNING id INTO v_session_id;

    -- Verify insertion was successful
    IF v_session_id IS NULL THEN
      RAISE EXCEPTION 'INSERT returned NULL for user %', p_user_id;
    END IF;

    RETURN v_session_id;
    
  EXCEPTION
    WHEN unique_violation THEN
      -- Concurrent insert detected, fetch existing session
      SELECT id INTO v_session_id
      FROM work_sessions
      WHERE user_id = p_user_id
        AND end_time IS NULL
      ORDER BY start_time DESC
      LIMIT 1;

      -- If still NULL after unique violation, something is seriously wrong
      IF v_session_id IS NULL THEN
        RAISE EXCEPTION 'Failed to create or retrieve work session for user % after unique_violation', p_user_id;
      END IF;

      RETURN v_session_id;
      
    WHEN OTHERS THEN
      -- Log unexpected errors and re-raise
      RAISE EXCEPTION 'Unexpected error in start_work_session for user %: % (SQLSTATE: %)', 
        p_user_id, SQLERRM, SQLSTATE;
  END;
END;
$$;

-- Add helpful comment
COMMENT ON FUNCTION start_work_session(uuid) IS 
'Starts a work session for a user. ALWAYS returns a valid session_id (never NULL) or raises an exception. Returns existing active session if one exists, otherwise creates a new one.';
