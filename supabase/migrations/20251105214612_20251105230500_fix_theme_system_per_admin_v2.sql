/*
  # Fix Theme System for Per-Admin Configuration (v2)

  1. Changes
    - Remove the incorrectly added `theme` column from `admin_configs`
    - Themes are stored as config_type='theme' with config_value containing the theme ID
    - Each admin has their own theme configuration
    - Super admin's theme applies to all admins who haven't set a custom theme

  2. Updates
    - Update config_type constraint to include 'theme' and 'company_name'
    - Ensure themes are stored per admin_id
*/

-- Remove the theme column if it exists (from previous migration)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'admin_configs' AND column_name = 'theme'
  ) THEN
    ALTER TABLE admin_configs DROP COLUMN theme;
  END IF;
END $$;

-- Drop the old index
DROP INDEX IF EXISTS idx_admin_configs_theme;

-- Update the config_type constraint to include 'theme' and 'company_name'
ALTER TABLE admin_configs DROP CONSTRAINT IF EXISTS admin_configs_config_type_check;

ALTER TABLE admin_configs ADD CONSTRAINT admin_configs_config_type_check 
CHECK (config_type IN (
  'commission_rate', 
  'success_rate', 
  'withdrawal_amount_threshold', 
  'withdrawal_days_threshold',
  'company_name',
  'theme'
));

-- Create index for theme lookups
CREATE INDEX IF NOT EXISTS idx_admin_configs_admin_theme ON admin_configs(admin_id, config_type) WHERE config_type = 'theme';