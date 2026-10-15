/*
# Add source_type parameter to get_admin_groups_for_customer_service

1. Modified Functions
   - `get_admin_groups_for_customer_service`: Now accepts optional `p_source_type` TEXT parameter
   - When provided, filters simulated_customers and conversations by source_type
   - When NULL (default), returns all data (backward compatible)

2. Purpose
   - The CCC page needs to see only ccc_service customers/messages
   - The original Customer Service page needs to see only aaa_service customers/messages
   - The admin group overview table (Customers, Messages columns) must reflect the correct counts per page
*/

CREATE OR REPLACE FUNCTION public.get_admin_groups_for_customer_service(p_source_type text DEFAULT NULL)
RETURNS TABLE(admin_id uuid, admin_username text, admin_role text, employee_count bigint, customer_count bigint, conversation_count bigint)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
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
  AND (p_source_type IS NULL OR sc.source_type = p_source_type)
LEFT JOIN customer_employee_conversations cec ON cec.employee_id = u.id
  AND (p_source_type IS NULL OR cec.source_type = p_source_type)
WHERE a.role != 'emergency_admin'
AND a.is_active = true
GROUP BY a.id, a.username, a.role
ORDER BY 
CASE 
WHEN a.role = 'super_admin' THEN 1
WHEN a.role = 'secondary_admin' THEN 2
ELSE 3
END,
a.username;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_groups_for_customer_service(text) TO anon, authenticated;
