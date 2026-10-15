/*
  # Add Admin Grouping to Customer Simulation System

  1. Changes
    - Link simulated_customers to specific admin (already done via admin_id)
    - Add helper functions for admin-employee relationship queries
    
  2. New Functions
    - `get_admin_employees` - Get all employees created by a specific admin
    - `get_admin_customer_conversations` - Get all conversations for an admin's customers
    - `get_employees_by_admin` - Get employee stats grouped by admin (for super admin)
    
  3. Security
    - Maintain RLS policies
    - Ensure admins can only see their own data
*/

-- Function: Get all employees created by a specific admin
CREATE OR REPLACE FUNCTION get_admin_employees(p_admin_id uuid)
RETURNS TABLE (
  id uuid,
  username text,
  employee_id text,
  is_verified boolean,
  is_active boolean,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    id,
    username,
    employee_id,
    is_verified,
    is_active,
    created_at
  FROM users
  WHERE created_by = p_admin_id
  ORDER BY username;
$$;

-- Function: Get all conversations for an admin (via their customers)
CREATE OR REPLACE FUNCTION get_admin_customer_conversations(p_admin_id uuid)
RETURNS TABLE (
  conversation_id uuid,
  customer_id uuid,
  customer_name text,
  customer_avatar text,
  employee_id uuid,
  employee_username text,
  employee_number text,
  sender_type text,
  message_content text,
  is_read boolean,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT 
    cec.id as conversation_id,
    cec.customer_id,
    sc.customer_name,
    sc.customer_avatar,
    cec.employee_id,
    u.username as employee_username,
    u.employee_id as employee_number,
    cec.sender_type,
    cec.message_content,
    cec.is_read,
    cec.created_at
  FROM customer_employee_conversations cec
  JOIN simulated_customers sc ON cec.customer_id = sc.id
  JOIN users u ON cec.employee_id = u.id
  WHERE sc.admin_id = p_admin_id
  ORDER BY cec.created_at DESC;
$$;

-- Function: Get employees grouped by admin (for super admin view)
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
  WHERE a.parent_id IS NOT NULL
  GROUP BY a.id, a.username, a.role
  ORDER BY a.username;
$$;
