/*
# Create rich_card_contents table for lazy-loading Rich Card messages

## Problem
Rich Card messages store full HTML content (including embedded images, rich formatting)
directly in the `message_content` column. This causes slow loading.

## Solution
Store only a lightweight text preview in the message row. Full HTML in a separate
`rich_card_contents` table, fetched on demand when user clicks "Tap to view".

1. New Tables
  - `rich_card_contents` (id, html_content, created_at)
2. Modified Tables
  - `customer_employee_conversations` - Added `rich_card_content_id` (nullable FK)
3. Modified Functions
  - `get_ccc_conversation_summaries` - Returns '[Rich Card]' for rich_card last messages
  - `get_employee_conversation_summaries` - Same optimization
4. Security - RLS enabled, open to anon + authenticated (custom auth)
*/

-- Create the rich_card_contents table
CREATE TABLE IF NOT EXISTS rich_card_contents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  html_content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE rich_card_contents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rich_card_contents_select" ON rich_card_contents;
CREATE POLICY "rich_card_contents_select" ON rich_card_contents
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "rich_card_contents_insert" ON rich_card_contents;
CREATE POLICY "rich_card_contents_insert" ON rich_card_contents
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "rich_card_contents_update" ON rich_card_contents;
CREATE POLICY "rich_card_contents_update" ON rich_card_contents
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "rich_card_contents_delete" ON rich_card_contents;
CREATE POLICY "rich_card_contents_delete" ON rich_card_contents
  FOR DELETE TO anon, authenticated USING (true);

-- Add rich_card_content_id column to customer_employee_conversations
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'customer_employee_conversations'
    AND column_name = 'rich_card_content_id'
  ) THEN
    ALTER TABLE customer_employee_conversations
      ADD COLUMN rich_card_content_id uuid REFERENCES rich_card_contents(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_rich_card_content_id
  ON customer_employee_conversations(rich_card_content_id)
  WHERE rich_card_content_id IS NOT NULL;

-- Update CCC admin conversation summary: return '[Rich Card]' placeholder for rich_card messages
CREATE OR REPLACE FUNCTION get_ccc_conversation_summaries(
  p_admin_id uuid,
  p_source_type text DEFAULT 'ccc_service'
)
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
      CASE
        WHEN c.message_type = 'rich_card' THEN '[Rich Card]'
        ELSE c.message_content
      END AS message_content,
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

-- Drop and recreate employee conversation summary with rich_card optimization
DROP FUNCTION IF EXISTS get_employee_conversation_summaries(uuid);

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
      CASE
        WHEN c.message_type = 'rich_card' THEN '[Rich Card]'
        ELSE c.message_content
      END AS message_content,
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

GRANT EXECUTE ON FUNCTION get_employee_conversation_summaries(uuid) TO anon, authenticated;
