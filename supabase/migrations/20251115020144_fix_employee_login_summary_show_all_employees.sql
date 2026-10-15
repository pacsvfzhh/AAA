/*
  # Fix Employee Login Summary to Show All Employees

  Updates the get_employee_login_summary function to show all employees,
  not just those with login history.
*/

-- Drop and recreate the function to show all employees
CREATE OR REPLACE FUNCTION get_employee_login_summary(
  p_admin_id uuid,
  p_search_term text DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  username text,
  employee_id text,
  created_by uuid,
  latest_login_ip text,
  latest_login_time timestamptz,
  latest_logout_ip text,
  latest_logout_time timestamptz,
  is_active boolean
) AS $$
DECLARE
  v_admin_role text;
BEGIN
  -- Get admin role
  SELECT role INTO v_admin_role
  FROM admins
  WHERE id = p_admin_id AND is_active = true;

  IF v_admin_role IS NULL THEN
    RAISE EXCEPTION 'Admin not found or inactive';
  END IF;

  RETURN QUERY
  WITH latest_logins AS (
    SELECT DISTINCT ON (elh.user_id)
      elh.user_id,
      elh.ip_address AS login_ip,
      elh.created_at AS login_time
    FROM employee_login_history elh
    WHERE elh.action_type = 'login'
    ORDER BY elh.user_id, elh.created_at DESC
  ),
  latest_logouts AS (
    SELECT DISTINCT ON (elh.user_id)
      elh.user_id,
      elh.ip_address AS logout_ip,
      elh.created_at AS logout_time
    FROM employee_login_history elh
    WHERE elh.action_type = 'logout'
    ORDER BY elh.user_id, elh.created_at DESC
  )
  SELECT
    u.id AS user_id,
    u.username,
    u.employee_id,
    u.created_by,
    ll.login_ip AS latest_login_ip,
    ll.login_time AS latest_login_time,
    lo.logout_ip AS latest_logout_ip,
    lo.logout_time AS latest_logout_time,
    u.is_active
  FROM users u
  LEFT JOIN latest_logins ll ON ll.user_id = u.id
  LEFT JOIN latest_logouts lo ON lo.user_id = u.id
  WHERE
    -- Check admin permission
    (v_admin_role = 'super_admin' OR v_admin_role = 'emergency_admin' OR u.created_by = p_admin_id)
    AND (
      -- Apply search filter if provided
      p_search_term IS NULL OR
      u.username ILIKE '%' || p_search_term || '%' OR
      u.employee_id ILIKE '%' || p_search_term || '%' OR
      COALESCE(ll.login_ip, '') ILIKE '%' || p_search_term || '%' OR
      COALESCE(lo.logout_ip, '') ILIKE '%' || p_search_term || '%'
    )
  ORDER BY u.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;