/*
  # Fix company name unique constraint

  1. Changes
    - Add unique constraint for company_name config to prevent duplicates
    - Ensures only one global company_name can exist (where admin_id IS NULL)
  
  2. Security
    - No RLS changes needed
*/

-- Add unique constraint for company_name with null admin_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_configs_company_name_unique
  ON admin_configs (config_type)
  WHERE config_type = 'company_name' AND admin_id IS NULL;
