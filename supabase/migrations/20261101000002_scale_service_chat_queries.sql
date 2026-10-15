/*
  Scale service chat queries (tested on a branch with 3,000 employees and ~1M messages).

  1. Index (employee_id, customer_id, created_at DESC) serves the employee/admin chat page,
     older pages, mark-read lookups and the employee conversation list.
  2. get_ccc_conversation_summaries: same signature and result, rewritten to aggregate per
     customer first and look up each conversation's last message through the new index.
     The old shape probed every customer x employee combination once the index existed.
  3. get_admin_groups_for_customer_service: same signature and result; conversation counts
     walk the index one conversation at a time instead of de-duplicating every message.
  4. get_admin_chat_unread_counts: unread employee messages per admin group and workspace,
     counted in the database instead of downloading rows (PostgREST returns at most 1,000).
*/

CREATE INDEX IF NOT EXISTS idx_conversations_employee_customer_created
  ON public.customer_employee_conversations USING btree (employee_id, customer_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.get_ccc_conversation_summaries(p_admin_id uuid, p_source_type text DEFAULT 'ccc_service'::text)
 RETURNS TABLE(customer_id uuid, employee_id uuid, customer_name text, customer_avatar text, custom_avatar_url text, employee_username text, employee_number text, message_count bigint, unread_count bigint, last_message text, last_message_type text, last_message_time timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
WITH customer_ids AS MATERIALIZED (
  SELECT sc.id, sc.customer_name, sc.customer_avatar, sc.custom_avatar_url
  FROM simulated_customers sc
  WHERE sc.admin_id = p_admin_id
    AND sc.source_type = p_source_type
),
admin_role AS (
  SELECT role FROM admins WHERE id = p_admin_id LIMIT 1
),
group_employee_ids AS (
  SELECT u.id
  FROM users u
  LEFT JOIN admins a ON a.id = u.created_by
  WHERE u.created_by IS NOT NULL
    AND (
      ((SELECT role FROM admin_role) = 'super_admin' AND a.role != 'emergency_admin')
      OR
      ((SELECT role FROM admin_role) != 'super_admin' AND u.created_by = p_admin_id)
    )
),
conv_stats AS MATERIALIZED (
  SELECT
    c.customer_id,
    c.employee_id,
    count(*) AS message_count,
    count(*) FILTER (WHERE c.sender_type = 'employee' AND c.is_read = false) AS unread_count,
    max(c.created_at) AS last_message_time
  FROM customer_employee_conversations c
  WHERE c.customer_id IN (SELECT id FROM customer_ids)
  GROUP BY c.customer_id, c.employee_id
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
JOIN users u ON u.id = cs.employee_id
LEFT JOIN LATERAL (
  SELECT
    CASE WHEN c.message_type = 'rich_card' THEN '[Rich Card]' ELSE c.message_content END AS message_content,
    c.message_type
  FROM customer_employee_conversations c
  WHERE c.customer_id = cs.customer_id
    AND c.employee_id = cs.employee_id
  ORDER BY c.created_at DESC
  LIMIT 1
) lm ON true
WHERE cs.employee_id IN (SELECT id FROM group_employee_ids)
ORDER BY cs.last_message_time DESC;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_groups_for_customer_service(p_source_type text DEFAULT NULL::text)
 RETURNS TABLE(admin_id uuid, admin_username text, admin_role text, employee_count bigint, customer_count bigint, conversation_count bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  WITH RECURSIVE pairs AS (
    (
      SELECT c.employee_id, c.customer_id
      FROM public.customer_employee_conversations AS c
      ORDER BY c.employee_id, c.customer_id
      LIMIT 1
    )
    UNION ALL
    SELECT next_pair.employee_id, next_pair.customer_id
    FROM pairs
    CROSS JOIN LATERAL (
      SELECT c.employee_id, c.customer_id
      FROM public.customer_employee_conversations AS c
      WHERE (c.employee_id, c.customer_id) > (pairs.employee_id, pairs.customer_id)
      ORDER BY c.employee_id, c.customer_id
      LIMIT 1
    ) AS next_pair
  ),
  group_conversations AS (
    SELECT customer.admin_id, count(*) AS conversation_count
    FROM pairs
    JOIN public.simulated_customers AS customer ON customer.id = pairs.customer_id
    JOIN public.users AS employee ON employee.id = pairs.employee_id
    WHERE employee.created_by = customer.admin_id
      AND (p_source_type IS NULL OR customer.source_type = p_source_type)
    GROUP BY customer.admin_id
  )
  SELECT
    admin.id,
    admin.username,
    admin.role,
    (SELECT COUNT(*) FROM public.users AS employee WHERE employee.created_by = admin.id),
    (SELECT COUNT(*) FROM public.simulated_customers AS customer
      WHERE customer.admin_id = admin.id
        AND (p_source_type IS NULL OR customer.source_type = p_source_type)),
    COALESCE(group_conversations.conversation_count, 0)
  FROM public.admins AS admin
  LEFT JOIN group_conversations ON group_conversations.admin_id = admin.id
  WHERE admin.role <> 'emergency_admin'
    AND admin.is_active = true
  ORDER BY CASE WHEN admin.role = 'super_admin' THEN 1
                WHEN admin.role = 'secondary_admin' THEN 2
                ELSE 3 END, admin.username;
$function$;

CREATE OR REPLACE FUNCTION public.get_admin_chat_unread_counts(p_admin_session_token uuid)
RETURNS TABLE(admin_id uuid, source_type text, unread_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $function$
DECLARE
  v_admin uuid;
  v_role text;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin, v_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF v_admin IS NULL THEN
    RAISE EXCEPTION 'Financial administrator session is invalid or expired.';
  END IF;

  -- Same-group conversations only, matching what the chat workspaces can open.
  RETURN QUERY
  SELECT customer.admin_id, conversation.source_type, count(*)::bigint
  FROM public.customer_employee_conversations AS conversation
  JOIN public.simulated_customers AS customer
    ON customer.id = conversation.customer_id
   AND customer.source_type = conversation.source_type
  JOIN public.users AS employee
    ON employee.id = conversation.employee_id
   AND employee.created_by = customer.admin_id
   AND employee.archived_at IS NULL
  JOIN public.admins AS group_admin
    ON group_admin.id = customer.admin_id
   AND group_admin.role <> 'emergency_admin'
   AND group_admin.is_active = true
  WHERE conversation.is_read = false
    AND conversation.sender_type = 'employee'
    AND (v_role = 'super_admin' OR customer.admin_id = v_admin)
  GROUP BY customer.admin_id, conversation.source_type;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_admin_chat_unread_counts(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_admin_chat_unread_counts(uuid) TO anon, authenticated;
