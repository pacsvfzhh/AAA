/*
  # Fix All Column Ambiguity Issues in get_employee_login_summary

  1. Issue
    - Multiple column references are ambiguous (user_id, username, employee_id, is_active)
    - Function return type column names conflict with CTE and table columns

  2. Solution
    - Rename columns in CTEs to avoid conflicts
    - Use distinct aliases throughout
*/

-- Drop existing function
DROP FUNCTION IF EXISTS get_employee_login_summary(uuid, text);

-- Recreate function with distinct column names
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
  total_logins bigint,
  is_active boolean
) AS $$
DECLARE
  v_admin_role text;
BEGIN
  -- Get admin role
  SELECT a.role INTO v_admin_role
  FROM admins a
  WHERE a.id = p_admin_id AND a.is_active = true;

  IF v_admin_role IS NULL THEN
    RAISE EXCEPTION 'Admin not found or inactive';
  END IF;

  RETURN QUERY
  WITH latest_logins AS (
    SELECT DISTINCT ON (elh.user_id)
      elh.user_id AS ll_user_id,
      elh.ip_address AS login_ip,
      elh.created_at AS login_time
    FROM employee_login_history elh
    WHERE elh.action_type = 'login'
    ORDER BY elh.user_id, elh.created_at DESC
  ),
  latest_logouts AS (
    SELECT DISTINCT ON (elh.user_id)
      elh.user_id AS lo_user_id,
      elh.ip_address AS logout_ip,
      elh.created_at AS logout_time
    FROM employee_login_history elh
    WHERE elh.action_type = 'logout'
    ORDER BY elh.user_id, elh.created_at DESC
  ),
  login_counts AS (
    SELECT
      elh.user_id AS lc_user_id,
      COUNT(*) AS login_count
    FROM employee_login_history elh
    WHERE elh.action_type = 'login'
    GROUP BY elh.user_id
  )
  SELECT
    u.id,
    u.username,
    u.employee_id,
    u.created_by,
    ll.login_ip,
    ll.login_time,
    lo.logout_ip,
    lo.logout_time,
    COALESCE(lc.login_count, 0)::bigint,
    u.is_active
  FROM users u
  LEFT JOIN latest_logins ll ON ll.ll_user_id = u.id
  LEFT JOIN latest_logouts lo ON lo.lo_user_id = u.id
  LEFT JOIN login_counts lc ON lc.lc_user_id = u.id
  WHERE
    (v_admin_role = 'super_admin' OR u.created_by = p_admin_id)
    AND (
      p_search_term IS NULL OR
      u.username ILIKE '%' || p_search_term || '%' OR
      u.employee_id ILIKE '%' || p_search_term || '%' OR
      ll.login_ip ILIKE '%' || p_search_term || '%' OR
      lo.logout_ip ILIKE '%' || p_search_term || '%'
    )
  ORDER BY u.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
