/*
  # Create Employee Login History System

  1. New Tables
    - `employee_login_history`
      - `id` (uuid, primary key)
      - `user_id` (uuid, foreign key to users)
      - `username` (text, for quick reference)
      - `employee_id` (text, for quick reference)
      - `action_type` (text, 'login' or 'logout')
      - `ip_address` (text, the IP address used)
      - `user_agent` (text, browser/device info)
      - `session_id` (text, to track session pairs)
      - `created_at` (timestamptz)

  2. Indexes
    - Index on user_id for fast employee lookups
    - Index on username for search
    - Index on employee_id for search
    - Index on ip_address for search
    - Index on created_at for time-based queries
    - Composite index on user_id + created_at for efficient history queries

  3. Functions
    - `log_employee_login`: Log a login event with IP and session info
    - `log_employee_logout`: Log a logout event with IP and session info
    - `get_employee_login_summary`: Get latest login/logout IPs for all employees
    - `get_employee_login_history`: Get detailed login history for a specific employee

  4. Security
    - Enable RLS on `employee_login_history` table
    - Only admins can view login history
    - Super admins can view all employees
    - Secondary admins can only view their own employees' history
*/

-- Create employee_login_history table
CREATE TABLE IF NOT EXISTS employee_login_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username text NOT NULL,
  employee_id text NOT NULL,
  action_type text NOT NULL CHECK (action_type IN ('login', 'logout')),
  ip_address text,
  user_agent text,
  session_id text,
  created_at timestamptz DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_employee_login_history_user_id ON employee_login_history(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_login_history_username ON employee_login_history(username);
CREATE INDEX IF NOT EXISTS idx_employee_login_history_employee_id ON employee_login_history(employee_id);
CREATE INDEX IF NOT EXISTS idx_employee_login_history_ip_address ON employee_login_history(ip_address);
CREATE INDEX IF NOT EXISTS idx_employee_login_history_created_at ON employee_login_history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_employee_login_history_user_time ON employee_login_history(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_employee_login_history_action_type ON employee_login_history(action_type);

-- Enable RLS
ALTER TABLE employee_login_history ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Only admins can view login history
CREATE POLICY "Admins can view all login history"
  ON employee_login_history FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.id = current_setting('app.current_admin_id', true)::uuid
      AND admins.is_active = true
    )
  );

-- Function to log employee login
CREATE OR REPLACE FUNCTION log_employee_login(
  p_user_id uuid,
  p_username text,
  p_employee_id text,
  p_ip_address text,
  p_user_agent text DEFAULT NULL,
  p_session_id text DEFAULT NULL
)
RETURNS uuid AS $$
DECLARE
  v_log_id uuid;
BEGIN
  INSERT INTO employee_login_history (
    user_id,
    username,
    employee_id,
    action_type,
    ip_address,
    user_agent,
    session_id
  ) VALUES (
    p_user_id,
    p_username,
    p_employee_id,
    'login',
    p_ip_address,
    p_user_agent,
    p_session_id
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to log employee logout
CREATE OR REPLACE FUNCTION log_employee_logout(
  p_user_id uuid,
  p_username text,
  p_employee_id text,
  p_ip_address text,
  p_user_agent text DEFAULT NULL,
  p_session_id text DEFAULT NULL
)
RETURNS uuid AS $$
DECLARE
  v_log_id uuid;
BEGIN
  INSERT INTO employee_login_history (
    user_id,
    username,
    employee_id,
    action_type,
    ip_address,
    user_agent,
    session_id
  ) VALUES (
    p_user_id,
    p_username,
    p_employee_id,
    'logout',
    p_ip_address,
    p_user_agent,
    p_session_id
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get employee login summary (latest login/logout IPs)
-- Returns all employees with their most recent login and logout IP addresses
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

-- Function to get detailed login history for a specific employee
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
  -- Get admin role
  SELECT role INTO v_admin_role
  FROM admins
  WHERE id = p_admin_id AND is_active = true;

  IF v_admin_role IS NULL THEN
    RAISE EXCEPTION 'Admin not found or inactive';
  END IF;

  -- Get the admin who created this employee
  SELECT created_by INTO v_employee_admin_id
  FROM users
  WHERE id = p_user_id;

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

-- Enable realtime for admin monitoring
ALTER PUBLICATION supabase_realtime ADD TABLE employee_login_history;