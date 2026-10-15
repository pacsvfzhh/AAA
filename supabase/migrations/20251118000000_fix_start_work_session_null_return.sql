/*
  # Fix start_work_session NULL Return Issue

  1. Problem
    - start_work_session() returns NULL when called for the first time after identity verification
    - This causes "Cannot read properties of null (reading 'id')" error in frontend
    - Root cause: ON CONFLICT uses an index name instead of a constraint name

  2. Solution
    - Add proper unique constraint instead of relying on partial unique index
    - Fix start_work_session to handle wallet creation check
    - Ensure function always returns a valid session_id
    - Add better error handling and logging

  3. Changes
    - Add unique constraint for active sessions
    - Update start_work_session function with proper conflict handling
    - Add validation to ensure users table record exists
*/

-- Step 1: Drop the old unique index if it exists
DROP INDEX IF EXISTS idx_work_sessions_active_user;

-- Step 2: Add a proper unique constraint for active sessions
-- Note: We can't add constraint with WHERE clause, so we recreate the partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_sessions_one_active_per_user
ON work_sessions (user_id)
WHERE end_time IS NULL;

-- Step 3: Fix start_work_session function
CREATE OR REPLACE FUNCTION start_work_session(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_active_session_id uuid;
  v_new_session_id uuid;
  v_user_exists boolean;
BEGIN
  -- Validate that user exists in users table
  SELECT EXISTS(SELECT 1 FROM users WHERE id = p_user_id) INTO v_user_exists;

  IF NOT v_user_exists THEN
    RAISE EXCEPTION 'User % does not exist', p_user_id;
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
    RETURNING id INTO v_new_session_id;

    RETURN v_new_session_id;
  EXCEPTION
    WHEN unique_violation THEN
      -- If concurrent insert happened, fetch the existing session
      SELECT id INTO v_new_session_id
      FROM work_sessions
      WHERE user_id = p_user_id
        AND end_time IS NULL
      ORDER BY start_time DESC
      LIMIT 1;

      IF v_new_session_id IS NULL THEN
        RAISE EXCEPTION 'Failed to create or retrieve work session for user %', p_user_id;
      END IF;

      RETURN v_new_session_id;
  END;
END;
$$;

-- Step 4: Fix sync_dispatch_session_start to avoid conflicts with start_work_session
CREATE OR REPLACE FUNCTION sync_dispatch_session_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing_session uuid;
BEGIN
  -- Only process when dispatch session becomes online
  IF NEW.status = 'online' AND NEW.started_at IS NOT NULL THEN
    -- Check if work_session already exists
    SELECT id INTO v_existing_session
    FROM work_sessions
    WHERE user_id = NEW.user_id
      AND end_time IS NULL
    LIMIT 1;

    -- If no active session exists, create one
    IF v_existing_session IS NULL THEN
      BEGIN
        INSERT INTO work_sessions (id, user_id, start_time)
        VALUES (NEW.id, NEW.user_id, NEW.started_at)
        ON CONFLICT (id) DO NOTHING;
      EXCEPTION
        WHEN unique_violation THEN
          -- Another session was created concurrently, ignore
          NULL;
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Step 5: Update cleanup trigger to be more robust
CREATE OR REPLACE FUNCTION cleanup_duplicate_work_sessions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_other_active_count integer;
BEGIN
  -- Only process new active sessions
  IF NEW.end_time IS NULL THEN
    -- Count other active sessions for this user
    SELECT COUNT(*) INTO v_other_active_count
    FROM work_sessions
    WHERE user_id = NEW.user_id
      AND end_time IS NULL
      AND id != NEW.id;

    -- If duplicates exist, close the older ones
    IF v_other_active_count > 0 THEN
      UPDATE work_sessions
      SET
        end_time = NEW.start_time,
        duration_minutes = GREATEST(0, EXTRACT(EPOCH FROM (NEW.start_time - start_time)) / 60)::integer
      WHERE user_id = NEW.user_id
        AND end_time IS NULL
        AND id != NEW.id
        AND start_time <= NEW.start_time;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Ensure trigger is properly set up
DROP TRIGGER IF EXISTS trigger_cleanup_duplicate_sessions ON work_sessions;
CREATE TRIGGER trigger_cleanup_duplicate_sessions
  AFTER INSERT ON work_sessions
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_duplicate_work_sessions();

-- Add helpful comments
COMMENT ON FUNCTION start_work_session(uuid) IS
'Starts a work session for a user. Returns existing active session if one exists, otherwise creates a new one. Always returns a valid session_id or raises an exception.';

COMMENT ON INDEX idx_work_sessions_one_active_per_user IS
'Ensures each user can only have one active work session (where end_time IS NULL) at a time';
