/*
  # Show All Admins in Customer Service (Even Without Employees)
  
  ## Change
  Previously: Only showed admins with employees or customers
  Now: Show all active admins (except emergency_admin), even if they have 0 employees
  
  ## Reason
  Super admin needs to see all secondary admins in the list, 
  even if they haven't created any employees yet.
*/

CREATE OR REPLACE FUNCTION get_admin_groups_for_customer_service()
RETURNS TABLE (
  admin_id uuid,
  admin_username text,
  admin_role text,
  employee_count bigint,
  customer_count bigint,
  conversation_count bigint
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
    COUNT(DISTINCT u.id) as employee_count,
    COUNT(DISTINCT sc.id) as customer_count,
    COUNT(DISTINCT cec.id) as conversation_count
  FROM admins a
  LEFT JOIN users u ON u.created_by = a.id
  LEFT JOIN simulated_customers sc ON sc.admin_id = a.id
  LEFT JOIN customer_employee_conversations cec ON cec.employee_id = u.id
  WHERE a.role != 'emergency_admin'  -- Exclude emergency_admin
    AND a.is_active = true
  GROUP BY a.id, a.username, a.role
  -- REMOVED: HAVING clause that filtered out admins with 0 employees
  ORDER BY 
    CASE 
      WHEN a.role = 'super_admin' THEN 1
      WHEN a.role = 'secondary_admin' THEN 2
      ELSE 3
    END,
    a.username;
END;
$$;

COMMENT ON FUNCTION get_admin_groups_for_customer_service() IS
  'Returns ALL active admins (except emergency_admin) with aggregated counts.
  
  Shows admins even if they have:
  - 0 employees
  - 0 customers
  - 0 conversations
  
  This allows super admin to see all secondary admins in Customer Service Management.';
