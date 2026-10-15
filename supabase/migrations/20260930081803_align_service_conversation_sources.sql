UPDATE public.customer_employee_conversations AS conversation
SET source_type = 'ccc_service'
FROM public.simulated_customers AS customer
WHERE customer.id = conversation.customer_id
  AND customer.source_type = 'ccc_service'
  AND conversation.source_type = 'aaa_service';

ALTER TABLE public.simulated_customers
  ADD CONSTRAINT simulated_customers_id_source_type_key UNIQUE (id, source_type);

ALTER TABLE public.customer_employee_conversations
  DROP CONSTRAINT customer_employee_conversations_customer_id_fkey,
  ADD CONSTRAINT customer_employee_conversations_customer_id_fkey
    FOREIGN KEY (customer_id, source_type)
    REFERENCES public.simulated_customers(id, source_type)
    ON UPDATE CASCADE ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.get_admin_groups_for_customer_service(p_source_type text DEFAULT NULL)
RETURNS TABLE(
  admin_id uuid,
  admin_username text,
  admin_role text,
  employee_count bigint,
  customer_count bigint,
  conversation_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  SELECT
    admin.id,
    admin.username,
    admin.role,
    (
      SELECT COUNT(*)
      FROM public.users AS employee
      WHERE employee.created_by = admin.id
    ),
    (
      SELECT COUNT(*)
      FROM public.simulated_customers AS customer
      WHERE customer.admin_id = admin.id
        AND (p_source_type IS NULL OR customer.source_type = p_source_type)
    ),
    (
      SELECT COUNT(DISTINCT (conversation.customer_id, conversation.employee_id))
      FROM public.customer_employee_conversations AS conversation
      JOIN public.simulated_customers AS customer ON customer.id = conversation.customer_id
      JOIN public.users AS employee ON employee.id = conversation.employee_id
      WHERE customer.admin_id = admin.id
        AND employee.created_by = admin.id
        AND (p_source_type IS NULL OR customer.source_type = p_source_type)
        AND (p_source_type IS NULL OR conversation.source_type = p_source_type)
    )
  FROM public.admins AS admin
  WHERE admin.role <> 'emergency_admin'
    AND admin.is_active = true
  ORDER BY CASE WHEN admin.role = 'super_admin' THEN 1
                WHEN admin.role = 'secondary_admin' THEN 2
                ELSE 3 END, admin.username;
$function$;
