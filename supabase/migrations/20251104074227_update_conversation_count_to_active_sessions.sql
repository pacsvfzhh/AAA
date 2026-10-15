/*
  # Update conversation_count to show active chat sessions

  1. Changes
    - Modify `get_employees_by_admin` function to count unique customer-employee conversation pairs
    - Previously counted all messages (cec.id)
    - Now counts distinct combinations of customer_id and employee_id that have at least one message

  2. Impact
    - The "Messages" column will now display the number of active chat sessions
    - A session is counted when a customer and employee have exchanged messages
    - Provides more meaningful metric for customer service activity
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
    COUNT(DISTINCT (cec.customer_id, cec.employee_id)) as conversation_count
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