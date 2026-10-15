/*
  # Add Company Name Configuration
  
  1. Changes
    - Add 'company_name' as a valid config type for super admin
    
  2. Notes
    - This will allow super admin to set a company name that appears in the website header
    - Secondary admins will not see this configuration option
*/

-- No schema changes needed - the admin_configs table already supports any config_type
-- We're just documenting that 'company_name' is now a valid config type for super admins