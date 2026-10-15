/*
# Create Message Templates Table

1. New Tables
   - `message_templates`
     - `id` (uuid, primary key)
     - `admin_id` (uuid, references admins, the template creator)
     - `name` (text, short label for the dropdown)
     - `title` (text, message title to fill)
     - `content` (text, rich HTML body to fill)
     - `message_type` (text, 'realtime' or 'login_popup')
     - `priority` (text, 'low'|'normal'|'high'|'urgent')
     - `sort_order` (integer, for custom ordering)
     - `created_at` / `updated_at` (timestamps)

2. Security
   - RLS enabled with open policies (TO anon, authenticated) matching
     the existing custom-auth pattern used throughout this project.
   - 4 separate policies for SELECT, INSERT, UPDATE, DELETE.

3. Indexes
   - Index on admin_id for fast lookups per admin.

4. Notes
   - This project uses custom auth (not Supabase auth.uid()), so
     policies use USING (true) consistent with every other table.
*/

CREATE TABLE IF NOT EXISTS message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  name text NOT NULL,
  title text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  message_type text NOT NULL DEFAULT 'realtime'
    CHECK (message_type IN ('realtime', 'login_popup')),
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_message_templates" ON message_templates;
CREATE POLICY "select_message_templates" ON message_templates FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "insert_message_templates" ON message_templates;
CREATE POLICY "insert_message_templates" ON message_templates FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "update_message_templates" ON message_templates;
CREATE POLICY "update_message_templates" ON message_templates FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "delete_message_templates" ON message_templates;
CREATE POLICY "delete_message_templates" ON message_templates FOR DELETE
  TO anon, authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_message_templates_admin_id
  ON message_templates (admin_id);
