/*
  # Fix get_employee_login_summary() - Correct Column Name

  ## Problem
  Function uses `login_time` but employee_login_history table has `created_at`

  ## Error
  "column login_time does not exist"

  ## Solution
  Update function to use correct column name:
  - Change all `login_time` references to `created_at`

  ## Table Structure
  employee_login_history:
  - id
  - user_id
  - username
  - employee_id
  - action_type (login/logout)
  - ip_address
  - user_agent
  - session_id
  - created_at ← Correct column name
*/

DROP FUNCTION IF EXISTS get_employee_login_summary(uuid, text);

CREATE FUNCTION get_employee_login_summary(
  p_admin_id uuid,
  p_search_term text DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  username text,
  employee_id text,
  is_active boolean,
  last_login_time timestamptz,
  last_login_ip text,
  login_count bigint,
  created_by_admin text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_role text;
BEGIN
  -- Get requesting admin's role
  SELECT a.role INTO v_admin_role
  FROM admins a
  WHERE a.id = p_admin_id;

  IF v_admin_role = 'super_admin' THEN
    -- Super admin sees all employees except emergency_admin's
    RETURN QUERY
    SELECT
      u.id as user_id,
      u.username,
      u.employee_id,
      u.is_active,
      elh.last_login_time,
      elh.last_login_ip,
      COALESCE(elh.login_count, 0) as login_count,
      a.username as created_by_admin
    FROM users u
    LEFT JOIN admins a ON a.id = u.created_by
    LEFT JOIN LATERAL (
      SELECT
        MAX(created_at) as last_login_time,
        (SELECT ip_address FROM employee_login_history
         WHERE employee_login_history.user_id = u.id
         ORDER BY created_at DESC LIMIT 1) as last_login_ip,
        COUNT(*) as login_count
      FROM employee_login_history
      WHERE employee_login_history.user_id = u.id
    ) elh ON true
    WHERE (p_search_term IS NULL
           OR u.username ILIKE '%' || p_search_term || '%'
           OR u.employee_id ILIKE '%' || p_search_term || '%')
      AND a.role != 'emergency_admin'  -- Exclude emergency_admin's employees
    ORDER BY u.username;
  ELSE
    -- Secondary admin sees only their employees
    RETURN QUERY
    SELECT
      u.id as user_id,
      u.username,
      u.employee_id,
      u.is_active,
      elh.last_login_time,
      elh.last_login_ip,
      COALESCE(elh.login_count, 0) as login_count,
      a.username as created_by_admin
    FROM users u
    LEFT JOIN admins a ON a.id = u.created_by
    LEFT JOIN LATERAL (
      SELECT
        MAX(created_at) as last_login_time,
        (SELECT ip_address FROM employee_login_history
         WHERE employee_login_history.user_id = u.id
         ORDER BY created_at DESC LIMIT 1) as last_login_ip,
        COUNT(*) as login_count
      FROM employee_login_history
      WHERE employee_login_history.user_id = u.id
    ) elh ON true
    WHERE u.created_by = p_admin_id
      AND (p_search_term IS NULL
           OR u.username ILIKE '%' || p_search_term || '%'
           OR u.employee_id ILIKE '%' || p_search_term || '%')
    ORDER BY u.username;
  END IF;
END;
$$;

COMMENT ON FUNCTION get_employee_login_summary(uuid, text) IS
  'Returns employee login summary with correct column names.

  Filtering:
  - Super admin: All employees except emergency_admin''s
  - Secondary admin: Only their own employees

  Fixed: Uses created_at instead of login_time';
