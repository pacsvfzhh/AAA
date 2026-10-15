/*
# Enforce CCC Group Isolation

1. Modified Functions
   - `get_ccc_conversation_summaries`: Added employee group filter so only employees 
     belonging to the same admin group as the customer appear in conversation summaries.
   - `get_employee_conversation_summaries`: Added admin group filter so employees only see
     conversations with customers belonging to their own admin group.

2. New Function
   - `check_conversation_group_isolation`: BEFORE INSERT trigger function on 
     customer_employee_conversations that rejects inserts where the employee and customer
     belong to different admin groups.

3. Data Cleanup
   - Deletes existing cross-group conversation records.
   - Also cleans up orphaned rich_card_contents rows.

4. Security
   - No RLS changes. The trigger runs as the table owner automatically.
*/

-- 1. Fix get_ccc_conversation_summaries: filter employees by admin group
CREATE OR REPLACE FUNCTION public.get_ccc_conversation_summaries(p_admin_id uuid, p_source_type text DEFAULT 'ccc_service'::text)
 RETURNS TABLE(customer_id uuid, employee_id uuid, customer_name text, customer_avatar text, custom_avatar_url text, employee_username text, employee_number text, message_count bigint, unread_count bigint, last_message text, last_message_type text, last_message_time timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
WITH customer_ids AS (
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
conv_stats AS (
  SELECT
    c.customer_id,
    c.employee_id,
    count(*) AS message_count,
    count(*) FILTER (WHERE c.sender_type = 'employee' AND c.is_read = false) AS unread_count,
    max(c.created_at) AS last_message_time
  FROM customer_employee_conversations c
  WHERE c.customer_id IN (SELECT id FROM customer_ids)
  AND c.employee_id IN (SELECT id FROM group_employee_ids)
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
  FROM customer_employee_conversations c
  WHERE c.customer_id IN (SELECT id FROM customer_ids)
  AND c.employee_id IN (SELECT id FROM group_employee_ids)
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
$function$;

-- 2. Fix get_employee_conversation_summaries: filter by admin group
CREATE OR REPLACE FUNCTION public.get_employee_conversation_summaries(p_employee_id uuid)
 RETURNS TABLE(customer_id uuid, customer_name text, customer_display_id text, customer_avatar text, is_super boolean, super_customer_title text, badge_type text, custom_avatar_url text, vip_label text, employee_pin_top boolean, employee_always_visible boolean, target_employee_id uuid, target_employee_ids uuid[], unread_count bigint, last_message text, last_message_type text, last_message_time timestamp with time zone, last_customer_message_time timestamp with time zone)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
WITH employee_admin AS (
  SELECT u.created_by AS admin_id, COALESCE(a.role, 'secondary_admin') AS admin_role
  FROM users u
  LEFT JOIN admins a ON a.id = u.created_by
  WHERE u.id = p_employee_id
  LIMIT 1
),
group_customer_ids AS (
  SELECT sc.id
  FROM simulated_customers sc
  WHERE (
    ((SELECT admin_role FROM employee_admin) = 'super_admin')
    OR
    (sc.admin_id = (SELECT admin_id FROM employee_admin))
  )
),
conv_stats AS (
  SELECT
    c.customer_id,
    count(*) FILTER (WHERE c.sender_type = 'customer' AND c.is_read = false) AS unread_count,
    max(c.created_at) AS last_message_time,
    max(c.created_at) FILTER (WHERE c.sender_type = 'customer') AS last_customer_message_time
  FROM customer_employee_conversations c
  WHERE c.employee_id = p_employee_id
  AND c.customer_id IN (SELECT id FROM group_customer_ids)
  GROUP BY c.customer_id
),
last_msgs AS (
  SELECT DISTINCT ON (c.customer_id)
    c.customer_id,
    CASE
      WHEN c.message_type = 'rich_card' THEN '[Rich Card]'
      ELSE c.message_content
    END AS message_content,
    c.message_type
  FROM customer_employee_conversations c
  WHERE c.employee_id = p_employee_id
  AND c.customer_id IN (SELECT id FROM group_customer_ids)
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
$function$;

-- 3. Create trigger to prevent cross-group inserts
CREATE OR REPLACE FUNCTION public.check_conversation_group_isolation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_customer_admin_id uuid;
  v_employee_admin_id uuid;
BEGIN
  SELECT sc.admin_id INTO v_customer_admin_id
  FROM simulated_customers sc
  WHERE sc.id = NEW.customer_id;

  SELECT u.created_by INTO v_employee_admin_id
  FROM users u
  WHERE u.id = NEW.employee_id;

  IF v_customer_admin_id IS NULL OR v_employee_admin_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF v_customer_admin_id = v_employee_admin_id THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM admins WHERE id = v_employee_admin_id AND role = 'super_admin') THEN
    RETURN NEW;
  END IF;

  IF EXISTS (SELECT 1 FROM admins WHERE id = v_customer_admin_id AND role = 'super_admin') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Group isolation violation: employee and customer belong to different admin groups';
END;
$function$;

DROP TRIGGER IF EXISTS trg_check_conversation_group_isolation ON customer_employee_conversations;
CREATE TRIGGER trg_check_conversation_group_isolation
  BEFORE INSERT ON customer_employee_conversations
  FOR EACH ROW
  EXECUTE FUNCTION check_conversation_group_isolation();

-- 4. Clean up existing cross-group conversation data
-- Delete rich_card_contents that share IDs with cross-group messages
DELETE FROM rich_card_contents
WHERE id IN (
  SELECT c.id
  FROM customer_employee_conversations c
  JOIN simulated_customers sc ON sc.id = c.customer_id
  JOIN users u ON u.id = c.employee_id
  LEFT JOIN admins a_emp ON a_emp.id = u.created_by
  LEFT JOIN admins a_cust ON a_cust.id = sc.admin_id
  WHERE sc.admin_id != u.created_by
  AND (a_emp.role IS NULL OR a_emp.role != 'super_admin')
  AND (a_cust.role IS NULL OR a_cust.role != 'super_admin')
);

DELETE FROM customer_employee_conversations
WHERE id IN (
  SELECT c.id
  FROM customer_employee_conversations c
  JOIN simulated_customers sc ON sc.id = c.customer_id
  JOIN users u ON u.id = c.employee_id
  LEFT JOIN admins a_emp ON a_emp.id = u.created_by
  LEFT JOIN admins a_cust ON a_cust.id = sc.admin_id
  WHERE sc.admin_id != u.created_by
  AND (a_emp.role IS NULL OR a_emp.role != 'super_admin')
  AND (a_cust.role IS NULL OR a_cust.role != 'super_admin')
);
