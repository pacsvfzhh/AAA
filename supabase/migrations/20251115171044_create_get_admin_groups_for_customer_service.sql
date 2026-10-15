/*
  # Create get_admin_groups_for_customer_service Function
  
  ## Purpose
  Returns admin groups with employee counts, customer counts, and conversation counts
  for the Customer Service Management page.
  
  ## Returns
  Each row represents one admin with aggregated counts:
  - admin_id: Admin's UUID
  - admin_username: Admin's username
  - admin_role: Admin's role
  - employee_count: Number of employees under this admin
  - customer_count: Number of simulated customers for this admin
  - conversation_count: Number of customer-employee conversations
  
  ## Filtering
  - Excludes emergency_admin
  - Shows all admins with employees or customers
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
  HAVING COUNT(DISTINCT u.id) > 0 OR COUNT(DISTINCT sc.id) > 0
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
  'Returns admin groups with aggregated counts for Customer Service Management.
  
  Used by Customer Service Management page to show admin list with:
  - Employee count
  - Customer count  
  - Conversation count
  
  Excludes emergency_admin.';
