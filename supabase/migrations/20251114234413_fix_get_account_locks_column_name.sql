/*
  # Fix get_account_locks_for_admin - Column Name Error
  
  1. Problem
    - Function references u.admin_id which doesn't exist
    - The correct column in users table is created_by (the admin who created the employee)
  
  2. Solution
    - Replace all u.admin_id references with u.created_by
    - This correctly identifies which admin owns each employee
*/

CREATE OR REPLACE FUNCTION get_account_locks_for_admin(p_admin_id uuid)
RETURNS TABLE (
  id uuid,
  identifier text,
  identifier_type text,
  lock_until timestamptz,
  lock_reason text,
  failed_attempts integer,
  created_at timestamptz,
  unlocked_at timestamptz,
  unlocked_by uuid,
  user_id uuid,
  username text,
  admin_username text
) AS $$
DECLARE
  v_admin_role text;
BEGIN
  -- Get admin role
  SELECT role INTO v_admin_role
  FROM admins
  WHERE admins.id = p_admin_id;
  
  -- Super admin and Emergency admin: return all lock records
  IF v_admin_role IN ('super_admin', 'emergency_admin') THEN
    RETURN QUERY
    SELECT
      al.id,
      al.identifier,
      al.identifier_type,
      al.lock_until,
      al.lock_reason,
      al.failed_attempts,
      al.created_at,
      al.unlocked_at,
      al.unlocked_by,
      al.user_id,
      u.username,
      a.username as admin_username
    FROM account_locks al
    LEFT JOIN users u ON al.user_id = u.id
    LEFT JOIN admins a ON u.created_by = a.id
    WHERE al.unlocked_at IS NULL
      AND al.lock_until > now()
    ORDER BY al.created_at DESC;
  ELSE
    -- Secondary admin: return own employees' locks + all IP locks
    RETURN QUERY
    SELECT
      al.id,
      al.identifier,
      al.identifier_type,
      al.lock_until,
      al.lock_reason,
      al.failed_attempts,
      al.created_at,
      al.unlocked_at,
      al.unlocked_by,
      al.user_id,
      u.username,
      a.username as admin_username
    FROM account_locks al
    LEFT JOIN users u ON al.user_id = u.id
    LEFT JOIN admins a ON u.created_by = a.id
    WHERE al.unlocked_at IS NULL
      AND al.lock_until > now()
      AND (
        -- IP locks: all admins can see
        al.identifier_type = 'ip'
        -- Username locks: only show own employees
        OR (al.identifier_type = 'username' AND u.created_by = p_admin_id)
      )
    ORDER BY al.created_at DESC;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION get_account_locks_for_admin IS 'Get account lock records based on admin role. Super admin and emergency admin can see all records. Secondary admin can see own employees username locks and all IP locks.';