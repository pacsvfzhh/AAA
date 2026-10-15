/*
# Create customer service message templates

1. New Tables
   - `cs_message_templates`
     - `id` (uuid, primary key)
     - `admin_id` (text, not null) - the admin who created the template
     - `name` (text, not null) - short label for easy selection
     - `content` (text, not null) - the template body (supports markdown/plain text)
     - `content_type` (text, default 'text') - 'text' or 'markdown'
     - `sort_order` (integer, default 0) - for ordering templates
     - `created_at` (timestamptz)
     - `updated_at` (timestamptz)

2. Security
   - Enable RLS on `cs_message_templates`.
   - Allow anon + authenticated full CRUD (custom auth system).

3. Notes
   - Templates are scoped per admin so each admin can have their own set.
   - Supports both plain text and markdown content types.
*/

CREATE TABLE IF NOT EXISTS cs_message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id text NOT NULL,
  name text NOT NULL,
  content text NOT NULL,
  content_type text NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'markdown')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cs_message_templates_admin_id ON cs_message_templates(admin_id);

ALTER TABLE cs_message_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_cs_message_templates" ON cs_message_templates;
CREATE POLICY "select_cs_message_templates" ON cs_message_templates FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "insert_cs_message_templates" ON cs_message_templates;
CREATE POLICY "insert_cs_message_templates" ON cs_message_templates FOR INSERT
  TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "update_cs_message_templates" ON cs_message_templates;
CREATE POLICY "update_cs_message_templates" ON cs_message_templates FOR UPDATE
  TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "delete_cs_message_templates" ON cs_message_templates;
CREATE POLICY "delete_cs_message_templates" ON cs_message_templates FOR DELETE
  TO anon, authenticated USING (true);
