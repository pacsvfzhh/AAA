/*
  # Fix get_employee_login_summary() - Match Frontend Interface

  ## Problem
  Function returns fields that don't match frontend expectations:
  - Returns: last_login_time, last_login_ip, login_count, created_by_admin (username)
  - Frontend expects: latest_login_time, latest_login_ip, total_logins, created_by (uuid)
  - Missing: latest_logout_time, latest_logout_ip

  ## Solution
  Update function to return correct field names and types:
  - user_id (uuid)
  - username (text)
  - employee_id (text)
  - is_active (boolean)
  - created_by (uuid) ← Changed from created_by_admin (text)
  - latest_login_time (timestamptz) ← Changed from last_login_time
  - latest_login_ip (text) ← Changed from last_login_ip
  - latest_logout_time (timestamptz) ← NEW
  - latest_logout_ip (text) ← NEW
  - total_logins (bigint) ← Changed from login_count

  ## Frontend Interface
  ```typescript
  interface EmployeeSummary {
    user_id: string;
    username: string;
    employee_id: string;
    created_by: string;
    latest_login_ip: string | null;
    latest_login_time: string | null;
    latest_logout_ip: string | null;
    latest_logout_time: string | null;
    total_logins: number;
    is_active: boolean;
  }
  ```
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
  created_by uuid,
  latest_login_time timestamptz,
  latest_login_ip text,
  latest_logout_time timestamptz,
  latest_logout_ip text,
  total_logins bigint
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
      u.created_by,
      login_data.latest_login_time,
      login_data.latest_login_ip,
      logout_data.latest_logout_time,
      logout_data.latest_logout_ip,
      COALESCE(login_data.total_logins, 0) as total_logins
    FROM users u
    LEFT JOIN admins a ON a.id = u.created_by
    LEFT JOIN LATERAL (
      SELECT
        MAX(created_at) as latest_login_time,
        (SELECT ip_address FROM employee_login_history
         WHERE employee_login_history.user_id = u.id
           AND action_type = 'login'
         ORDER BY created_at DESC LIMIT 1) as latest_login_ip,
        COUNT(*) as total_logins
      FROM employee_login_history
      WHERE employee_login_history.user_id = u.id
        AND action_type = 'login'
    ) login_data ON true
    LEFT JOIN LATERAL (
      SELECT
        MAX(created_at) as latest_logout_time,
        (SELECT ip_address FROM employee_login_history
         WHERE employee_login_history.user_id = u.id
           AND action_type = 'logout'
         ORDER BY created_at DESC LIMIT 1) as latest_logout_ip
      FROM employee_login_history
      WHERE employee_login_history.user_id = u.id
        AND action_type = 'logout'
    ) logout_data ON true
    WHERE (p_search_term IS NULL
           OR u.username ILIKE '%' || p_search_term || '%'
           OR u.employee_id ILIKE '%' || p_search_term || '%')
      AND (a.role IS NULL OR a.role != 'emergency_admin')  -- Exclude emergency_admin's employees
    ORDER BY u.username;
  ELSE
    -- Secondary admin sees only their employees
    RETURN QUERY
    SELECT
      u.id as user_id,
      u.username,
      u.employee_id,
      u.is_active,
      u.created_by,
      login_data.latest_login_time,
      login_data.latest_login_ip,
      logout_data.latest_logout_time,
      logout_data.latest_logout_ip,
      COALESCE(login_data.total_logins, 0) as total_logins
    FROM users u
    LEFT JOIN LATERAL (
      SELECT
        MAX(created_at) as latest_login_time,
        (SELECT ip_address FROM employee_login_history
         WHERE employee_login_history.user_id = u.id
           AND action_type = 'login'
         ORDER BY created_at DESC LIMIT 1) as latest_login_ip,
        COUNT(*) as total_logins
      FROM employee_login_history
      WHERE employee_login_history.user_id = u.id
        AND action_type = 'login'
    ) login_data ON true
    LEFT JOIN LATERAL (
      SELECT
        MAX(created_at) as latest_logout_time,
        (SELECT ip_address FROM employee_login_history
         WHERE employee_login_history.user_id = u.id
           AND action_type = 'logout'
         ORDER BY created_at DESC LIMIT 1) as latest_logout_ip
      FROM employee_login_history
      WHERE employee_login_history.user_id = u.id
        AND action_type = 'logout'
    ) logout_data ON true
    WHERE u.created_by = p_admin_id
      AND (p_search_term IS NULL
           OR u.username ILIKE '%' || p_search_term || '%'
           OR u.employee_id ILIKE '%' || p_search_term || '%')
    ORDER BY u.username;
  END IF;
END;
$$;

COMMENT ON FUNCTION get_employee_login_summary(uuid, text) IS
  'Returns employee login summary with correct field names matching frontend interface.

  Returns:
  - user_id, username, employee_id, is_active, created_by (uuid)
  - latest_login_time, latest_login_ip (from login records)
  - latest_logout_time, latest_logout_ip (from logout records)
  - total_logins (count of login records)

  Filtering:
  - Super admin: All employees except emergency_admin''s
  - Secondary admin: Only their own employees';
