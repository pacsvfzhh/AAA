/*
  # Fix get_employee_login_history Column Ambiguity

  Fix the column name ambiguity error in get_employee_login_history function.
  The issue is that the RETURNS TABLE has a column named 'id' which conflicts with
  the 'id' column in the SELECT statement when querying the admins table.

  Solution: Use fully qualified column names (admins.id, users.id) in all queries.
*/

-- Recreate the function with fully qualified column names
CREATE OR REPLACE FUNCTION get_employee_login_history(
  p_admin_id uuid,
  p_user_id uuid,
  p_limit int DEFAULT 100,
  p_offset int DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  action_type text,
  ip_address text,
  user_agent text,
  session_id text,
  created_at timestamptz
) AS $$
DECLARE
  v_admin_role text;
  v_employee_admin_id uuid;
BEGIN
  -- Get admin role (use fully qualified column names)
  SELECT admins.role INTO v_admin_role
  FROM admins
  WHERE admins.id = p_admin_id AND admins.is_active = true;

  IF v_admin_role IS NULL THEN
    RAISE EXCEPTION 'Admin not found or inactive';
  END IF;

  -- Get the admin who created this employee (use fully qualified column names)
  SELECT users.created_by INTO v_employee_admin_id
  FROM users
  WHERE users.id = p_user_id;

  IF v_employee_admin_id IS NULL THEN
    RAISE EXCEPTION 'Employee not found';
  END IF;

  -- Check permission: super_admin can view all, secondary_admin can only view their own employees
  IF v_admin_role != 'super_admin' AND v_employee_admin_id != p_admin_id THEN
    RAISE EXCEPTION 'Permission denied: You can only view login history for your own employees';
  END IF;

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
$$ LANGUAGE plpgsql SECURITY DEFINER;
