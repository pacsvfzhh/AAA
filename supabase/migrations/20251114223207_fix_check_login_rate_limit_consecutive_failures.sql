/*
  # Fix check_login_rate_limit to count consecutive failures only

  1. Problem
    - check_login_rate_limit counts all failures in the past hour
    - Should only count consecutive failures after the last success
    - Inconsistent with the fixed record_login_attempt logic
  
  2. Solution
    - Update check_login_rate_limit to match record_login_attempt logic
    - Only count failed attempts after the most recent successful login
    - Provide accurate warning messages based on consecutive failures
  
  3. Changes
    - Modified failure counting logic to ignore failures before last success
    - Updated warning threshold to match consecutive failure count
*/

CREATE OR REPLACE FUNCTION check_login_rate_limit(
  p_identifier text,
  p_identifier_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_active_lock record;
  v_consecutive_failures integer;
  v_last_success_time timestamptz;
  v_result jsonb;
BEGIN
  -- Check for active lock (not manually unlocked and still within lock period)
  SELECT * INTO v_active_lock
  FROM account_locks
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL
  ORDER BY lock_until DESC
  LIMIT 1;

  -- If account is locked, return lock info
  IF FOUND THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'locked', true,
      'lock_until', v_active_lock.lock_until,
      'lock_reason', v_active_lock.lock_reason,
      'failed_attempts', v_active_lock.failed_attempts,
      'remaining_seconds', EXTRACT(EPOCH FROM (v_active_lock.lock_until - now()))::integer
    );
  END IF;

  -- Account is not locked, check consecutive failures
  
  -- Find the most recent successful login time
  SELECT MAX(attempt_time) INTO v_last_success_time
  FROM login_attempts
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND success = true;

  -- Count consecutive failures (after last success or all in past hour)
  IF v_last_success_time IS NOT NULL THEN
    -- Count failures AFTER the last successful login
    SELECT COUNT(*) INTO v_consecutive_failures
    FROM login_attempts
    WHERE identifier = p_identifier
      AND identifier_type = p_identifier_type
      AND success = false
      AND attempt_time > v_last_success_time;
  ELSE
    -- No successful login found, count all failures in the past hour
    SELECT COUNT(*) INTO v_consecutive_failures
    FROM login_attempts
    WHERE identifier = p_identifier
      AND identifier_type = p_identifier_type
      AND success = false
      AND attempt_time > now() - interval '1 hour';
  END IF;

  -- Return status with appropriate warning
  RETURN jsonb_build_object(
    'allowed', true,
    'locked', false,
    'failed_attempts', v_consecutive_failures,
    'warning', CASE
      WHEN v_consecutive_failures >= 3 THEN 
        format('%s consecutive failed attempts. Account will be locked after 5 attempts', v_consecutive_failures)
      ELSE NULL
    END
  );
END;
$$;
