/*
  # Update global default company name

  1. Changes
    - Updates the global default `company_name` in `admin_configs`
      (where `admin_id IS NULL`) from `QUANTUM TRADER` to `Globy`
    - This is the name shown on the login page and in the browser tab
      before any admin logs in

  2. Notes
    - No schema changes, data only
    - Per-admin overrides are untouched
*/

UPDATE admin_configs
SET config_value = 'Globy',
    updated_at = now()
WHERE config_type = 'company_name'
  AND admin_id IS NULL;
