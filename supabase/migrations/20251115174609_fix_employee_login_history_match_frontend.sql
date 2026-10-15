/*
  # Fix get_employee_login_history() - Match Frontend Interface

  ## Problem
  Function returns fields that don't match frontend expectations:
  - Returns: login_time, status
  - Frontend expects: created_at, action_type, session_id

  ## Solution
  Update function to return correct field names:
  - id (uuid)
  - user_id (uuid) ← Keep for internal use
  - username (text) ← Keep for display
  - employee_id (text) ← Keep for display
  - action_type (text) ← Changed from status
  - ip_address (text)
  - user_agent (text)
  - session_id (text) ← NEW field
  - created_at (timestamptz) ← Changed from login_time

  ## Frontend Interface
  ```typescript
  interface LoginHistoryRecord {
    id: string;
    action_type: 'login' | 'logout';
    ip_address: string;
    user_agent: string | null;
    session_id: string | null;
    created_at: string;
  }
  ```
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
  action_type text,
  ip_address text,
  user_agent text,
  session_id text,
  created_at timestamptz
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

  -- Return login history with correct field names
  RETURN QUERY
  SELECT
    elh.id,
    elh.action_type,
    elh.ip_address,
    elh.user_agent,
    elh.session_id,
    elh.created_at
  FROM employee_login_history elh
  WHERE elh.user_id = p_user_id
  ORDER BY elh.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION get_employee_login_history(uuid, uuid, integer, integer) IS
  'Returns employee login history with correct field names matching frontend interface.

  Returns:
  - id, action_type, ip_address, user_agent, session_id, created_at

  Permissions:
  - Super admin: All employees except emergency_admin''s
  - Secondary admin: Only their own employees';
