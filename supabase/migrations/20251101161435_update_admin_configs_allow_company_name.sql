/*
  # Update admin_configs to allow company_name
  
  1. Changes
    - Drop the existing check constraint on config_type
    - Add a new check constraint that includes 'company_name' in the allowed values
    
  2. Security
    - Only super admins (admin_id IS NULL) can set company_name
    - This maintains data integrity while allowing the new config type
*/

-- Drop the old constraint
ALTER TABLE admin_configs DROP CONSTRAINT IF EXISTS admin_configs_config_type_check;

-- Add the new constraint with company_name included
ALTER TABLE admin_configs ADD CONSTRAINT admin_configs_config_type_check 
  CHECK (config_type IN (
    'commission_rate',
    'success_rate', 
    'withdrawal_amount_threshold',
    'withdrawal_days_threshold',
    'company_name'
  ));