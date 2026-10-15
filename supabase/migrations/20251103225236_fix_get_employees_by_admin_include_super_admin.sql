/*
  # Fix get_employees_by_admin to include super_admin
  
  1. Changes
    - Remove the `WHERE a.parent_id IS NOT NULL` filter
    - This allows the function to return ALL admins including super_admin
    - Super admin can now be displayed in the Customer Service Management panel
  
  2. Impact
    - Super admin will now appear in the admin groups list
    - Super admin can manage their own customers and employees
    - Maintains backward compatibility for secondary admins
*/

CREATE OR REPLACE FUNCTION get_employees_by_admin()
RETURNS TABLE (
  admin_id uuid,
  admin_username text,
  admin_role text,
  employee_count bigint,
  customer_count bigint,
  conversation_count bigint
)
LANGUAGE sql
SECURITY DEFINER
AS $$
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
  LEFT JOIN customer_employee_conversations cec ON cec.customer_id = sc.id
  GROUP BY a.id, a.username, a.role
  ORDER BY 
    CASE 
      WHEN a.role = 'super_admin' THEN 0
      ELSE 1
    END,
    a.username;
$$;
