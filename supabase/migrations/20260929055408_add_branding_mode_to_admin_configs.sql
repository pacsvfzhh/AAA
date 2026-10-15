ALTER TABLE public.admin_configs
  DROP CONSTRAINT admin_configs_config_type_check;

ALTER TABLE public.admin_configs
  ADD CONSTRAINT admin_configs_config_type_check
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
    'order_submit_time_max',
    'branding_mode'
  ));

ALTER TABLE public.admin_configs
  ADD CONSTRAINT admin_configs_branding_mode_value_check
  CHECK (config_type <> 'branding_mode' OR config_value IN ('custom', 'global'));
