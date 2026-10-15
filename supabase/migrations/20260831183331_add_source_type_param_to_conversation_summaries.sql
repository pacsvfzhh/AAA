/*
# Add source_type parameter to conversation summary function

Updates `get_ccc_conversation_summaries` to accept a `p_source_type` parameter
so both the CCC page ('ccc_service') and the original Customer Service page ('aaa_service')
can use the same optimized function.
*/

CREATE OR REPLACE FUNCTION get_ccc_conversation_summaries(p_admin_id uuid, p_source_type text DEFAULT 'ccc_service')
RETURNS TABLE (
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
SET search_path = public
AS $$
  WITH customer_ids AS (
    SELECT sc.id, sc.customer_name, sc.customer_avatar, sc.custom_avatar_url
    FROM simulated_customers sc
    WHERE sc.admin_id = p_admin_id
      AND sc.source_type = p_source_type
  ),
  conv_stats AS (
    SELECT
      c.customer_id,
      c.employee_id,
      count(*) AS message_count,
      count(*) FILTER (WHERE c.sender_type = 'employee' AND c.is_read = false) AS unread_count,
      max(c.created_at) AS last_message_time
    FROM customer_employee_conversations c
    WHERE c.customer_id IN (SELECT id FROM customer_ids)
    GROUP BY c.customer_id, c.employee_id
  ),
  last_msgs AS (
    SELECT DISTINCT ON (c.customer_id, c.employee_id)
      c.customer_id,
      c.employee_id,
      c.message_content,
      c.message_type
    FROM customer_employee_conversations c
    WHERE c.customer_id IN (SELECT id FROM customer_ids)
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
  JOIN users u ON u.id = cs.employee_id
  LEFT JOIN last_msgs lm ON lm.customer_id = cs.customer_id AND lm.employee_id = cs.employee_id
  ORDER BY cs.last_message_time DESC;
$$;

GRANT EXECUTE ON FUNCTION get_ccc_conversation_summaries(uuid, text) TO anon, authenticated;
