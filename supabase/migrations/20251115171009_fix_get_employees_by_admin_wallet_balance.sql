/*
  # Fix get_employees_by_admin() - Correct Wallet Column Name
  
  ## Problem
  Function uses `w.balance` but wallets table has:
  - available_balance
  - frozen_balance
  
  ## Error
  "column w.balance does not exist"
  
  ## Solution
  Update function to use correct column names:
  - wallet_balance = available_balance + frozen_balance
*/

DROP FUNCTION IF EXISTS get_employees_by_admin();

CREATE FUNCTION get_employees_by_admin()
RETURNS TABLE (
  admin_id uuid,
  admin_username text,
  admin_role text,
  employee_id uuid,
  employee_username text,
  employee_employee_id text,
  is_active boolean,
  wallet_balance numeric,
  total_orders bigint,
  completed_orders bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.id as admin_id,
    a.username as admin_username,
    a.role as admin_role,
    u.id as employee_id,
    u.username as employee_username,
    u.employee_id as employee_employee_id,
    u.is_active,
    COALESCE(w.available_balance + w.frozen_balance, 0) as wallet_balance,
    COUNT(o.id) as total_orders,
    COUNT(o.id) FILTER (WHERE o.status = 'completed') as completed_orders
  FROM admins a
  LEFT JOIN users u ON u.created_by = a.id
  LEFT JOIN wallets w ON w.user_id = u.id
  LEFT JOIN orders o ON o.user_id = u.id
  WHERE a.role != 'emergency_admin'  -- Exclude emergency_admin
    AND (u.id IS NOT NULL OR a.role = 'super_admin')
  GROUP BY a.id, a.username, a.role, u.id, u.username, u.employee_id, u.is_active, w.available_balance, w.frozen_balance
  ORDER BY a.role DESC, a.username, u.username;
END;
$$;

COMMENT ON FUNCTION get_employees_by_admin() IS
  'Returns employees grouped by admin with correct wallet balance calculation.
  
  - Excludes emergency_admin and their employees
  - wallet_balance = available_balance + frozen_balance
  - Used in Customer Service Management to show admin groups';
