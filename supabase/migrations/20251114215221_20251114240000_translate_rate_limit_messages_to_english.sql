/*
  # Translate Rate Limit Messages to English

  ## Changes
  Update all rate limit and account lock related functions to use English messages instead of Chinese.

  ## Functions Updated
  1. check_login_rate_limit - Warning messages
  2. record_login_attempt - Lock reason messages
  3. unlock_account - Success/error messages
  4. unlock_account_with_permission_check - Permission and status messages
*/

-- 1. Update check_login_rate_limit function
CREATE OR REPLACE FUNCTION check_login_rate_limit(
  p_identifier text,
  p_identifier_type text
) RETURNS jsonb AS $$
DECLARE
  v_active_lock record;
  v_recent_failures integer;
  v_result jsonb;
BEGIN
  SELECT * INTO v_active_lock
  FROM account_locks
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL
  ORDER BY lock_until DESC
  LIMIT 1;

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

  SELECT COUNT(*) INTO v_recent_failures
  FROM login_attempts
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND success = false
    AND attempt_time > now() - interval '1 hour';

  RETURN jsonb_build_object(
    'allowed', true,
    'locked', false,
    'recent_failures', v_recent_failures,
    'warning', CASE
      WHEN v_recent_failures >= 3 THEN 'Multiple login failures detected, please be careful'
      ELSE NULL
    END
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Update record_login_attempt function
CREATE OR REPLACE FUNCTION record_login_attempt(
  p_identifier text,
  p_identifier_type text,
  p_success boolean,
  p_ip_address text DEFAULT NULL,
  p_user_agent text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_recent_failures integer;
  v_lock_duration interval;
  v_lock_reason text;
  v_user_id uuid;
BEGIN
  INSERT INTO login_attempts (
    identifier, identifier_type, success, ip_address, user_agent
  ) VALUES (
    p_identifier, p_identifier_type, p_success, p_ip_address, p_user_agent
  );

  IF p_identifier_type = 'username' THEN
    SELECT id INTO v_user_id FROM users WHERE username = p_identifier;
  END IF;

  IF p_success THEN
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

  SELECT COUNT(*) INTO v_recent_failures
  FROM login_attempts
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND success = false
    AND attempt_time > now() - interval '1 hour';

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
    RETURN jsonb_build_object(
      'success', false,
      'locked', false,
      'failed_attempts', v_recent_failures,
      'message', 'Login failed'
    );
  END IF;

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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Update unlock_account function
CREATE OR REPLACE FUNCTION unlock_account(
  p_identifier text,
  p_identifier_type text,
  p_admin_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_updated_count integer;
BEGIN
  UPDATE account_locks
  SET unlocked_at = now(),
      unlocked_by = p_admin_id
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', 'Account unlocked successfully',
      'unlocked_count', v_updated_count
    );
  ELSE
    RETURN jsonb_build_object(
      'success', false,
      'message', 'No locked account found'
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Update unlock_account_with_permission_check function
CREATE OR REPLACE FUNCTION unlock_account_with_permission_check(
  p_identifier text,
  p_identifier_type text,
  p_admin_id uuid
) RETURNS jsonb AS $$
DECLARE
  v_admin_role text;
  v_lock_user_id uuid;
  v_user_created_by uuid;
  v_updated_count integer;
BEGIN
  SELECT role INTO v_admin_role FROM admins WHERE id = p_admin_id;

  IF v_admin_role IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Admin not found'
    );
  END IF;

  SELECT user_id INTO v_lock_user_id
  FROM account_locks
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL
  LIMIT 1;

  IF v_admin_role = 'secondary' AND v_lock_user_id IS NOT NULL THEN
    SELECT created_by INTO v_user_created_by FROM users WHERE id = v_lock_user_id;

    IF v_user_created_by IS NULL OR v_user_created_by != p_admin_id THEN
      RETURN jsonb_build_object(
        'success', false,
        'message', 'You do not have permission to unlock this account'
      );
    END IF;
  END IF;

  UPDATE account_locks
  SET unlocked_at = now(),
      unlocked_by = p_admin_id
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count > 0 THEN
    RETURN jsonb_build_object(
      'success', true,
      'message', 'Account unlocked successfully',
      'unlocked_count', v_updated_count
    );
  ELSE
    RETURN jsonb_build_object(
      'success', false,
      'message', 'No locked account found'
    );
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add comments
COMMENT ON FUNCTION check_login_rate_limit IS 'Check if login is rate limited (English messages)';
COMMENT ON FUNCTION record_login_attempt IS 'Record login attempt and apply rate limit if needed (English messages)';
COMMENT ON FUNCTION unlock_account IS 'Unlock account (English messages)';
COMMENT ON FUNCTION unlock_account_with_permission_check IS 'Unlock account with permission check (English messages)';
