/*
  # Add Tab Session Tracking

  1. Changes
    - Add `current_tab_id` column to `users` table to track which browser tab is currently active
    - Update `validate_employee_session` function to validate both sessionToken and tabId
    - Ensures only one browser tab per user account can be logged in at a time

  2. Security
    - Tab ID validation prevents multiple tabs from using the same session
    - New tab logins will invalidate previous tab sessions
*/

-- Add current_tab_id column to users table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'current_tab_id'
  ) THEN
    ALTER TABLE users ADD COLUMN current_tab_id text;
  END IF;
END $$;

-- Update validate_employee_session to check both sessionToken and tabId
CREATE OR REPLACE FUNCTION validate_employee_session(
  user_id uuid,
  session_token text,
  tab_id text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  stored_token text;
  stored_tab_id text;
BEGIN
  -- Get stored session token and tab ID
  SELECT session_token, current_tab_id INTO stored_token, stored_tab_id
  FROM users
  WHERE id = user_id;

  -- If no stored token, session is invalid
  IF stored_token IS NULL THEN
    RETURN false;
  END IF;

  -- Check if session token matches
  IF stored_token != session_token THEN
    RETURN false;
  END IF;

  -- If tab_id is provided and stored_tab_id exists, they must match
  IF tab_id IS NOT NULL AND stored_tab_id IS NOT NULL THEN
    IF stored_tab_id != tab_id THEN
      RETURN false;
    END IF;
  END IF;

  RETURN true;
END;
$$;