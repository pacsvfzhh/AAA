/*
# Create Submit Time Management System

Adds dedicated tables for managing order submission time settings per-employee
with support for named time groups.

1. New Tables
  - `submit_time_groups`
    - `id` (uuid, primary key)
    - `admin_id` (uuid, FK to admins) - which admin owns this group
    - `name` (text) - display name for the group (e.g. "Fast", "Normal")
    - `min_seconds` (integer) - minimum submission time in seconds
    - `max_seconds` (integer) - maximum submission time in seconds
    - `created_at` (timestamptz)
  - `employee_submit_time_settings`
    - `id` (uuid, primary key)
    - `user_id` (uuid, FK to users, unique) - one setting per employee
    - `group_id` (uuid, FK to submit_time_groups, nullable) - assigned group
    - `min_seconds` (integer, nullable) - individual override min
    - `max_seconds` (integer, nullable) - individual override max
    - `created_at` (timestamptz)

2. Security
  - Enable RLS on both tables.
  - Allow anon + authenticated full CRUD (custom auth system).

3. Indexes
  - Index on submit_time_groups(admin_id) for admin-scoped queries
  - Unique constraint on employee_submit_time_settings(user_id)

4. Notes
  - If employee has group_id set, use that group's min/max
  - If employee has individual min/max (no group), use those
  - Otherwise fall back to admin_configs order_submit_time_min/max
*/

-- Submit time groups table
CREATE TABLE IF NOT EXISTS submit_time_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  name text NOT NULL,
  min_seconds integer NOT NULL DEFAULT 5 CHECK (min_seconds >= 3 AND min_seconds <= 120),
  max_seconds integer NOT NULL DEFAULT 20 CHECK (max_seconds >= 5 AND max_seconds <= 300),
  created_at timestamptz DEFAULT now(),
  CONSTRAINT min_less_than_max CHECK (min_seconds <= max_seconds)
);

ALTER TABLE submit_time_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "access_submit_time_groups" ON submit_time_groups;
CREATE POLICY "access_submit_time_groups" ON submit_time_groups
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_submit_time_groups_admin_id ON submit_time_groups(admin_id);

-- Employee submit time settings table
CREATE TABLE IF NOT EXISTS employee_submit_time_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id uuid REFERENCES submit_time_groups(id) ON DELETE SET NULL,
  min_seconds integer CHECK (min_seconds IS NULL OR (min_seconds >= 3 AND min_seconds <= 120)),
  max_seconds integer CHECK (max_seconds IS NULL OR (max_seconds >= 5 AND max_seconds <= 300)),
  created_at timestamptz DEFAULT now(),
  CONSTRAINT unique_employee_submit_time UNIQUE (user_id),
  CONSTRAINT individual_min_less_than_max CHECK (
    min_seconds IS NULL OR max_seconds IS NULL OR min_seconds <= max_seconds
  )
);

ALTER TABLE employee_submit_time_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "access_employee_submit_time_settings" ON employee_submit_time_settings;
CREATE POLICY "access_employee_submit_time_settings" ON employee_submit_time_settings
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_employee_submit_time_user_id ON employee_submit_time_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_employee_submit_time_group_id ON employee_submit_time_settings(group_id);
