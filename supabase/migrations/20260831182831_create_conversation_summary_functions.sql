/*
# Create conversation summary functions for performance optimization

1. New Functions
  - `get_ccc_conversation_summaries(p_admin_id uuid)` - Returns one row per 
    (customer_id, employee_id) pair with last message, time, counts. 
    Replaces the heavy pattern of loading ALL messages client-side to build summaries.
  - `get_employee_conversation_summaries(p_employee_id uuid)` - Returns one row 
    per customer for a given employee with last message, time, unread count.
    Replaces loading ALL messages with joins on the employee chat page.

2. Performance Impact
  - Previously: client loaded ALL messages (potentially thousands) and processed in JS
  - Now: database returns only summary rows (one per conversation pair)
  - Reduces data transfer by 10-100x depending on message volume

3. Security
  - Functions use SECURITY INVOKER (runs as calling role)
  - Existing RLS policies on customer_employee_conversations apply
*/

-- Function 1: CCC Admin conversation summaries
CREATE OR REPLACE FUNCTION get_ccc_conversation_summaries(p_admin_id uuid)
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
      AND sc.source_type = 'ccc_service'
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

-- Function 2: Employee conversation summaries
CREATE OR REPLACE FUNCTION get_employee_conversation_summaries(p_employee_id uuid)
RETURNS TABLE (
  customer_id uuid,
  customer_name text,
  customer_display_id text,
  customer_avatar text,
  is_super boolean,
  super_customer_title text,
  badge_type text,
  custom_avatar_url text,
  vip_label text,
  employee_pin_top boolean,
  employee_always_visible boolean,
  target_employee_id uuid,
  target_employee_ids uuid[],
  unread_count bigint,
  last_message text,
  last_message_type text,
  last_message_time timestamptz,
  last_customer_message_time timestamptz
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH conv_stats AS (
    SELECT
      c.customer_id,
      count(*) FILTER (WHERE c.sender_type = 'customer' AND c.is_read = false) AS unread_count,
      max(c.created_at) AS last_message_time,
      max(c.created_at) FILTER (WHERE c.sender_type = 'customer') AS last_customer_message_time
    FROM customer_employee_conversations c
    WHERE c.employee_id = p_employee_id
    GROUP BY c.customer_id
  ),
  last_msgs AS (
    SELECT DISTINCT ON (c.customer_id)
      c.customer_id,
      c.message_content,
      c.message_type
    FROM customer_employee_conversations c
    WHERE c.employee_id = p_employee_id
    ORDER BY c.customer_id, c.created_at DESC
  )
  SELECT
    sc.id AS customer_id,
    sc.customer_name,
    sc.customer_id AS customer_display_id,
    sc.customer_avatar,
    sc.is_super,
    sc.super_customer_title,
    sc.badge_type,
    sc.custom_avatar_url,
    sc.vip_label,
    sc.employee_pin_top,
    sc.employee_always_visible,
    sc.target_employee_id,
    sc.target_employee_ids,
    COALESCE(cs.unread_count, 0) AS unread_count,
    lm.message_content AS last_message,
    lm.message_type AS last_message_type,
    cs.last_message_time,
    cs.last_customer_message_time
  FROM conv_stats cs
  JOIN simulated_customers sc ON sc.id = cs.customer_id
  LEFT JOIN last_msgs lm ON lm.customer_id = cs.customer_id
  ORDER BY cs.last_message_time DESC;
$$;

-- Grant execute to anon and authenticated roles
GRANT EXECUTE ON FUNCTION get_ccc_conversation_summaries(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_employee_conversation_summaries(uuid) TO anon, authenticated;
