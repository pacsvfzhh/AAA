-- Add currency_unit to admin_configs config_type constraint
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
  'currency_unit'
));

-- Insert global default currency_unit as USDT
INSERT INTO admin_configs (admin_id, config_type, config_value)
VALUES (NULL, 'currency_unit', 'USDT')
ON CONFLICT (admin_id, config_type) WHERE admin_id IS NULL DO NOTHING;
