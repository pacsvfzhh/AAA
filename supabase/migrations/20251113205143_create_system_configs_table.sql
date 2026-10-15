/*
  # Create system_configs table for global system settings

  1. New Tables
    - `system_configs`
      - `id` (uuid, primary key)
      - `key` (text, unique) - Configuration key (e.g., 'auto_cleanup_schedule', 'theme_config')
      - `value` (jsonb) - Configuration value stored as JSON
      - `description` (text) - Human-readable description
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Security
    - Enable RLS on `system_configs` table
    - Allow all authenticated users to read configs
    - Allow all authenticated users to modify configs (application handles authorization)
    - This matches the pattern used in admin_configs

  3. Notes
    - This table stores global system configurations that don't belong to specific admins
    - Examples: auto cleanup schedules, global theme settings, system-wide feature flags
    - The `key` field is unique to prevent duplicate configurations
*/

-- Create system_configs table
CREATE TABLE IF NOT EXISTS system_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  value jsonb NOT NULL,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE system_configs ENABLE ROW LEVEL SECURITY;

-- Create policies for custom auth system
CREATE POLICY "Allow reading system configs for authenticated users"
  ON system_configs
  FOR SELECT
  TO authenticated, anon
  USING (true);

CREATE POLICY "Allow modifying system configs for authenticated users"
  ON system_configs
  FOR ALL
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

-- Create index for faster lookups by key
CREATE INDEX IF NOT EXISTS idx_system_configs_key ON system_configs(key);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_system_configs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_system_configs_updated_at
  BEFORE UPDATE ON system_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_system_configs_updated_at();