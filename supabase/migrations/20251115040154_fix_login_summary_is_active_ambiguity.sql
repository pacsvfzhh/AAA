/*
  # Fix is_active Column Ambiguity in get_employee_login_summary

  1. Issue
    - Column reference "is_active" is ambiguous
    - Need to explicitly specify table aliases for all is_active references

  2. Solution
    - Use fully qualified column names (table.column)
    - Explicitly reference admins.is_active and users.is_active
*/

-- Drop and recreate function with explicit column references
DROP FUNCTION IF EXISTS get_employee_login_summary(uuid, text);

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
  -- Get admin role (explicitly reference admins.is_active)
  SELECT admins.role INTO v_admin_role
  FROM admins
  WHERE admins.id = p_admin_id AND admins.is_active = true;

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
  ),
  login_counts AS (
    SELECT
      user_id,
      COUNT(*) AS login_count
    FROM employee_login_history
    WHERE action_type = 'login'
    GROUP BY user_id
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
    COALESCE(lc.login_count, 0) AS total_logins,
    u.is_active  -- Explicitly reference users.is_active
  FROM users u
  LEFT JOIN latest_logins ll ON ll.user_id = u.id
  LEFT JOIN latest_logouts lo ON lo.user_id = u.id
  LEFT JOIN login_counts lc ON lc.user_id = u.id
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
