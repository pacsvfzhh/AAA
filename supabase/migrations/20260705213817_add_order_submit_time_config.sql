/*
# Add Order Submit Time Configuration

1. Changes
   - Adds 'order_submit_time_min' and 'order_submit_time_max' to admin_configs config_type constraint
   - These control the simulated order submission animation duration range (in seconds)
   - Default: min=5, max=20 seconds

2. Security
   - No policy changes needed; uses existing admin_configs RLS

3. Notes
   - Admins can configure per-group or use global defaults
   - The frontend will randomly pick a duration between min and max for the submission animation
*/

-- Update the config_type constraint to include new types
ALTER TABLE admin_configs DROP CONSTRAINT IF EXISTS admin_configs_config_type_check;

ALTER TABLE admin_configs ADD CONSTRAINT admin_configs_config_type_check 
CHECK (config_type IN (
  'commission_rate', 
  'success_rate', 
  'withdrawal_amount_threshold', 
  'withdrawal_days_threshold',
  'company_name',
  'theme',
  'withdrawal_condition_mode',
  'currency_unit',
  'order_submit_time_min',
  'order_submit_time_max'
));

-- Insert global defaults (5 seconds min, 20 seconds max)
INSERT INTO admin_configs (admin_id, config_type, config_value)
VALUES (NULL, 'order_submit_time_min', '5')
ON CONFLICT (admin_id, config_type) WHERE admin_id IS NULL DO NOTHING;

INSERT INTO admin_configs (admin_id, config_type, config_value)
VALUES (NULL, 'order_submit_time_max', '20')
ON CONFLICT (admin_id, config_type) WHERE admin_id IS NULL DO NOTHING;
