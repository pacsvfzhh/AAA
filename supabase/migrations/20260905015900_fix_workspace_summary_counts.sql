/*
  Keep workspace summary counts scoped to the selected service and admin group.

  Conversation source_type is derived from its customer so employee-originated
  messages cannot be assigned to the wrong service partition.
*/

UPDATE public.customer_employee_conversations c
SET source_type = sc.source_type
FROM public.simulated_customers sc
WHERE sc.id = c.customer_id
  AND c.source_type IS DISTINCT FROM sc.source_type;

CREATE OR REPLACE FUNCTION public.sync_conversation_source_type()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  SELECT sc.source_type
  INTO NEW.source_type
  FROM public.simulated_customers sc
  WHERE sc.id = NEW.customer_id;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_conversation_source_type ON public.customer_employee_conversations;
CREATE TRIGGER trg_sync_conversation_source_type
  BEFORE INSERT OR UPDATE OF customer_id, source_type ON public.customer_employee_conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_conversation_source_type();

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
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    a.id AS admin_id,
    a.username AS admin_username,
    a.role AS admin_role,
    (
      SELECT COUNT(*)
      FROM public.users u
      WHERE u.created_by = a.id
    ) AS employee_count,
    (
      SELECT COUNT(*)
      FROM public.simulated_customers sc
      WHERE sc.admin_id = a.id
        AND (p_source_type IS NULL OR sc.source_type = p_source_type)
    ) AS customer_count,
    (
      SELECT COUNT(DISTINCT (cec.customer_id, cec.employee_id))
      FROM public.customer_employee_conversations cec
      JOIN public.simulated_customers sc ON sc.id = cec.customer_id
      JOIN public.users u ON u.id = cec.employee_id
      WHERE sc.admin_id = a.id
        AND u.created_by = a.id
        AND (p_source_type IS NULL OR sc.source_type = p_source_type)
        AND (p_source_type IS NULL OR cec.source_type = p_source_type)
    ) AS conversation_count
  FROM public.admins a
  WHERE a.role != 'emergency_admin'
    AND a.is_active = true
  ORDER BY
    CASE
      WHEN a.role = 'super_admin' THEN 1
      WHEN a.role = 'secondary_admin' THEN 2
      ELSE 3
    END,
    a.username;
$function$;

CREATE OR REPLACE FUNCTION public.get_ccc_conversation_summaries(
  p_admin_id uuid,
  p_source_type text DEFAULT 'ccc_service'
)
RETURNS TABLE(
  customer_id uuid,
  employee_id uuid,
  customer_name text,
  customer_avatar text,
  custom_avatar_url text,
  employee_username text,
  employee_number text,
  message_count bigint,
  unread_count bigint,
  last_message text,
  last_message_type text,
  last_message_time timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH customer_ids AS (
    SELECT sc.id, sc.customer_name, sc.customer_avatar, sc.custom_avatar_url
    FROM public.simulated_customers sc
    WHERE sc.admin_id = p_admin_id
      AND sc.source_type = p_source_type
  ),
  group_employee_ids AS (
    SELECT u.id
    FROM public.users u
    WHERE u.created_by = p_admin_id
  ),
  conv_stats AS (
    SELECT
      c.customer_id,
      c.employee_id,
      COUNT(*) AS message_count,
      COUNT(*) FILTER (WHERE c.sender_type = 'employee' AND c.is_read = false) AS unread_count,
      MAX(c.created_at) AS last_message_time
    FROM public.customer_employee_conversations c
    WHERE c.customer_id IN (SELECT id FROM customer_ids)
      AND c.employee_id IN (SELECT id FROM group_employee_ids)
      AND c.source_type = p_source_type
    GROUP BY c.customer_id, c.employee_id
  ),
  last_msgs AS (
    SELECT DISTINCT ON (c.customer_id, c.employee_id)
      c.customer_id,
      c.employee_id,
      CASE
        WHEN c.message_type = 'rich_card' THEN '[Rich Card]'
        ELSE c.message_content
      END AS message_content,
      c.message_type
    FROM public.customer_employee_conversations c
    WHERE c.customer_id IN (SELECT id FROM customer_ids)
      AND c.employee_id IN (SELECT id FROM group_employee_ids)
      AND c.source_type = p_source_type
    ORDER BY c.customer_id, c.employee_id, c.created_at DESC
  )
  SELECT
    cs.customer_id,
    cs.employee_id,
    ci.customer_name,
    ci.customer_avatar,
    ci.custom_avatar_url,
    u.username AS employee_username,
    u.employee_id AS employee_number,
    cs.message_count,
    cs.unread_count,
    lm.message_content AS last_message,
    lm.message_type AS last_message_type,
    cs.last_message_time
  FROM conv_stats cs
  JOIN customer_ids ci ON ci.id = cs.customer_id
  JOIN public.users u ON u.id = cs.employee_id
  LEFT JOIN last_msgs lm ON lm.customer_id = cs.customer_id AND lm.employee_id = cs.employee_id
  ORDER BY cs.last_message_time DESC;
$function$;

GRANT EXECUTE ON FUNCTION public.get_admin_groups_for_customer_service(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_ccc_conversation_summaries(uuid, text) TO anon, authenticated;
