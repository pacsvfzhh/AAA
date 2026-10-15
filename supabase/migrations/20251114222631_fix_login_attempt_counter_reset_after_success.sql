/*
  # Fix login attempt counter to reset after successful login

  1. Problem
    - Currently, failed login attempts accumulate even after successful login
    - Example: 5 fails → lock → unlock → 1 success → 1 fail = immediately locked again
    - The counter counts ALL failures in the past hour, not just consecutive failures
  
  2. Solution
    - Only count failed attempts AFTER the last successful login
    - If no successful login exists, count all failures in the past hour
    - This ensures the counter resets to zero after each successful login
  
  3. Changes
    - Update record_login_attempt function to count consecutive failures only
    - Failed attempts before the last success are ignored
*/

CREATE OR REPLACE FUNCTION record_login_attempt(
  p_identifier text,
  p_identifier_type text,
  p_success boolean,
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_recent_failures integer;
  v_lock_duration interval;
  v_lock_reason text;
  v_user_id uuid;
  v_last_success_time timestamptz;
BEGIN
  -- Record this login attempt
  INSERT INTO login_attempts (
    identifier, identifier_type, success, ip_address, user_agent
  ) VALUES (
    p_identifier, p_identifier_type, p_success, p_ip_address, p_user_agent
  );

  -- Get user_id if this is a username login
  IF p_identifier_type = 'username' THEN
    SELECT id INTO v_user_id FROM users WHERE username = p_identifier;
  END IF;

  -- If login was successful
  IF p_success THEN
    -- Unlock any existing locks for this identifier
    UPDATE account_locks
    SET unlocked_at = now()
    WHERE identifier = p_identifier
      AND identifier_type = p_identifier_type
      AND unlocked_at IS NULL;

    RETURN jsonb_build_object(
      'success', true,
      'message', 'Login successful'
    );
  END IF;

  -- Login failed - count CONSECUTIVE failures (after last success)
  
  -- Find the most recent successful login time
  SELECT MAX(attempt_time) INTO v_last_success_time
  FROM login_attempts
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND success = true;

  -- Count failed attempts after the last success (or all in past hour if no success)
  IF v_last_success_time IS NOT NULL THEN
    -- Count failures AFTER the last successful login
    SELECT COUNT(*) INTO v_recent_failures
    FROM login_attempts
    WHERE identifier = p_identifier
      AND identifier_type = p_identifier_type
      AND success = false
      AND attempt_time > v_last_success_time;
  ELSE
    -- No successful login found, count all failures in the past hour
    SELECT COUNT(*) INTO v_recent_failures
    FROM login_attempts
    WHERE identifier = p_identifier
      AND identifier_type = p_identifier_type
      AND success = false
      AND attempt_time > now() - interval '1 hour';
  END IF;

  -- Check if account should be locked based on consecutive failures
  IF v_recent_failures >= 15 THEN
    v_lock_duration := interval '24 hours';
    v_lock_reason := 'Account locked for 24 hours after 15 consecutive failed login attempts';
  ELSIF v_recent_failures >= 10 THEN
    v_lock_duration := interval '1 hour';
    v_lock_reason := 'Account locked for 1 hour after 10 consecutive failed login attempts';
  ELSIF v_recent_failures >= 5 THEN
    v_lock_duration := interval '15 minutes';
    v_lock_reason := 'Account locked for 15 minutes after 5 consecutive failed login attempts';
  ELSE
    -- Not enough consecutive failures to lock
    RETURN jsonb_build_object(
      'success', false,
      'locked', false,
      'failed_attempts', v_recent_failures,
      'message', 'Login failed'
    );
  END IF;

  -- Create the lock
  INSERT INTO account_locks (
    identifier, identifier_type, lock_until, lock_reason, failed_attempts, user_id
  ) VALUES (
    p_identifier, p_identifier_type, now() + v_lock_duration, v_lock_reason, v_recent_failures, v_user_id
  );

  RETURN jsonb_build_object(
    'success', false,
    'locked', true,
    'lock_until', now() + v_lock_duration,
    'lock_reason', v_lock_reason,
    'failed_attempts', v_recent_failures
  );
END;
$$;
