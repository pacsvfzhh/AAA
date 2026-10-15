/*
  # Fix unlock account to reset failure counter

  1. Problem
    - When admin unlocks an account, the failure counter is not reset
    - Previous failed login attempts are still counted
    - Next failed login immediately triggers lock again
  
  2. Solution
    - When unlocking, insert a "virtual" successful login attempt
    - This resets the consecutive failure counter to zero
    - The record_login_attempt logic will then count from zero
  
  3. Changes
    - Update unlock_account function to insert success login attempt
    - Update unlock_account_with_permission_check function to insert success login attempt
    - This ensures consistency with the "consecutive failures" logic
*/

-- Update the basic unlock_account function
CREATE OR REPLACE FUNCTION unlock_account(
  p_identifier text,
  p_identifier_type text,
  p_admin_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated_count integer;
BEGIN
  -- Mark the lock as unlocked
  UPDATE account_locks
  SET unlocked_at = now(),
      unlocked_by = p_admin_id
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count > 0 THEN
    -- Insert a virtual "successful login" to reset the failure counter
    -- This is crucial: it makes the consecutive failure counter start from zero
    INSERT INTO login_attempts (
      identifier,
      identifier_type,
      success,
      ip_address,
      user_agent
    ) VALUES (
      p_identifier,
      p_identifier_type,
      true,
      'admin-unlock',
      'Admin manual unlock'
    );

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
$$;

-- Update the permission-checked unlock function
CREATE OR REPLACE FUNCTION unlock_account_with_permission_check(
  p_identifier text,
  p_identifier_type text,
  p_admin_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_role text;
  v_lock_user_id uuid;
  v_user_created_by uuid;
  v_updated_count integer;
BEGIN
  -- Check if admin exists and get their role
  SELECT role INTO v_admin_role FROM admins WHERE id = p_admin_id;

  IF v_admin_role IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'message', 'Admin not found'
    );
  END IF;

  -- Get the user_id of the locked account
  SELECT user_id INTO v_lock_user_id
  FROM account_locks
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL
  LIMIT 1;

  -- Permission check for secondary admins
  IF v_admin_role = 'secondary' AND v_lock_user_id IS NOT NULL THEN
    SELECT created_by INTO v_user_created_by FROM users WHERE id = v_lock_user_id;

    IF v_user_created_by IS NULL OR v_user_created_by != p_admin_id THEN
      RETURN jsonb_build_object(
        'success', false,
        'message', 'You do not have permission to unlock this account'
      );
    END IF;
  END IF;

  -- Mark the lock as unlocked
  UPDATE account_locks
  SET unlocked_at = now(),
      unlocked_by = p_admin_id
  WHERE identifier = p_identifier
    AND identifier_type = p_identifier_type
    AND lock_until > now()
    AND unlocked_at IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count > 0 THEN
    -- Insert a virtual "successful login" to reset the failure counter
    -- This is crucial: it makes the consecutive failure counter start from zero
    INSERT INTO login_attempts (
      identifier,
      identifier_type,
      success,
      ip_address,
      user_agent
    ) VALUES (
      p_identifier,
      p_identifier_type,
      true,
      'admin-unlock',
      'Admin manual unlock'
    );

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
$$;
