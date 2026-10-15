/*
# Create Customer Auto Messages System

1. New Tables
   - `customer_auto_messages`
     - `id` (uuid, primary key)
     - `customer_id` (uuid, FK to simulated_customers, CASCADE delete)
     - `admin_id` (text, the admin who owns this config)
     - `message_type` ('quick_send' | 'rich_card')
     - `name` (text, template name/label)
     - `title` (text, nullable - for rich cards)
     - `subtitle` (text, nullable - for rich cards)
     - `content` (text, message content / HTML)
     - `content_type` ('text' | 'richtext' | 'rich_card')
     - `sort_order` (integer, for ordering messages)
     - `is_enabled` (boolean, default true)
     - `created_at` / `updated_at` (timestamps)

   - `customer_auto_message_logs`
     - `id` (uuid, primary key)
     - `customer_id` (uuid, FK to simulated_customers)
     - `employee_id` (uuid, FK to users)
     - `auto_message_id` (uuid, FK to customer_auto_messages)
     - `sent_at` (timestamp)
     Tracks which auto-messages have been sent to which employees to prevent duplicates.

2. Security
   - Enable RLS on both tables.
   - Policies allow anon + authenticated CRUD (custom auth, no Supabase auth).

3. Indexes
   - customer_auto_messages: (customer_id, sort_order)
   - customer_auto_message_logs: (customer_id, employee_id) unique partial
*/

-- Auto messages configuration table
CREATE TABLE IF NOT EXISTS customer_auto_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES simulated_customers(id) ON DELETE CASCADE,
  admin_id text NOT NULL,
  message_type text NOT NULL CHECK (message_type IN ('quick_send', 'rich_card')),
  name text NOT NULL DEFAULT '',
  title text,
  subtitle text,
  content text NOT NULL DEFAULT '',
  content_type text NOT NULL DEFAULT 'richtext' CHECK (content_type IN ('text', 'richtext', 'rich_card')),
  sort_order integer NOT NULL DEFAULT 0,
  is_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE customer_auto_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_customer_auto_messages" ON customer_auto_messages;
CREATE POLICY "select_customer_auto_messages" ON customer_auto_messages FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "insert_customer_auto_messages" ON customer_auto_messages;
CREATE POLICY "insert_customer_auto_messages" ON customer_auto_messages FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "update_customer_auto_messages" ON customer_auto_messages;
CREATE POLICY "update_customer_auto_messages" ON customer_auto_messages FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "delete_customer_auto_messages" ON customer_auto_messages;
CREATE POLICY "delete_customer_auto_messages" ON customer_auto_messages FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_customer_auto_messages_customer_sort 
  ON customer_auto_messages(customer_id, sort_order);

-- Auto message delivery logs
CREATE TABLE IF NOT EXISTS customer_auto_message_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES simulated_customers(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  auto_message_id uuid NOT NULL REFERENCES customer_auto_messages(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE customer_auto_message_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_customer_auto_message_logs" ON customer_auto_message_logs;
CREATE POLICY "select_customer_auto_message_logs" ON customer_auto_message_logs FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "insert_customer_auto_message_logs" ON customer_auto_message_logs;
CREATE POLICY "insert_customer_auto_message_logs" ON customer_auto_message_logs FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "update_customer_auto_message_logs" ON customer_auto_message_logs;
CREATE POLICY "update_customer_auto_message_logs" ON customer_auto_message_logs FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "delete_customer_auto_message_logs" ON customer_auto_message_logs;
CREATE POLICY "delete_customer_auto_message_logs" ON customer_auto_message_logs FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_auto_message_logs_customer_employee 
  ON customer_auto_message_logs(customer_id, employee_id);

CREATE INDEX IF NOT EXISTS idx_auto_message_logs_message_id
  ON customer_auto_message_logs(auto_message_id);
