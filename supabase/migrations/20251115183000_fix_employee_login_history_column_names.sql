/*
  # Fix get_employee_login_history() - Correct Column Names

  ## Problem
  Function uses incorrect column names:
  - `login_time` should be `created_at`
  - `status` should be `action_type`

  ## Error
  Will cause errors when function is called

  ## Solution
  Update function to use correct column names from employee_login_history table:
  - created_at (timestamptz)
  - action_type (text: 'login' or 'logout')

  ## Table Structure
  employee_login_history:
  - id
  - user_id
  - username
  - employee_id
  - action_type ← Not 'status'
  - ip_address
  - user_agent
  - session_id
  - created_at ← Not 'login_time'
*/

DROP FUNCTION IF EXISTS get_employee_login_history(uuid, uuid, integer, integer);

CREATE FUNCTION get_employee_login_history(
  p_admin_id uuid,
  p_user_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  username text,
  employee_id text,
  login_time timestamptz,
  ip_address text,
  user_agent text,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_role text;
  v_user_created_by uuid;
BEGIN
  -- Get admin role
  SELECT a.role INTO v_admin_role
  FROM admins a
  WHERE a.id = p_admin_id;

  -- Get user's creator
  SELECT u.created_by INTO v_user_created_by
  FROM users u
  WHERE u.id = p_user_id;

  -- Check permission
  IF v_admin_role != 'super_admin' AND v_user_created_by != p_admin_id THEN
    RAISE EXCEPTION 'Permission denied: You can only view login history of your own employees';
  END IF;

  -- Check if user belongs to emergency_admin (super admin can't access)
  IF v_admin_role = 'super_admin' THEN
    IF EXISTS (
      SELECT 1 FROM users u
      JOIN admins a ON a.id = u.created_by
      WHERE u.id = p_user_id
        AND a.role = 'emergency_admin'
    ) THEN
      RAISE EXCEPTION 'Permission denied: Cannot access emergency admin data';
    END IF;
  END IF;

  -- Return login history
  RETURN QUERY
  SELECT
    elh.id,
    elh.user_id,
    u.username,
    u.employee_id,
    elh.created_at as login_time,
    elh.ip_address,
    elh.user_agent,
    elh.action_type as status
  FROM employee_login_history elh
  JOIN users u ON u.id = elh.user_id
  WHERE elh.user_id = p_user_id
  ORDER BY elh.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION get_employee_login_history(uuid, uuid, integer, integer) IS
  'Returns employee login history with correct column names.

  Permission checks:
  - Super admin: Can view all employees except emergency_admin''s
  - Secondary admin: Can only view their own employees

  Fixed: Uses created_at (as login_time) and action_type (as status)';
