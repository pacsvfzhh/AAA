/*
  # Add Login Page Title Settings

  1. Purpose
    - Allow super admin to customize login page titles
    - Add two configuration keys: login_title and login_subtitle

  2. New Configuration Keys
    - `login_title`: Main title on login page (default: company name)
    - `login_subtitle`: Subtitle text below the title (default: "BLOCKCHAIN TRADING PLATFORM")

  3. Security
    - Only super admin can modify these settings via AdminGroupConfiguration page
*/

-- Insert default login title configuration
INSERT INTO system_configs (key, value, description)
VALUES (
  'login_title',
  '"QUANTUM TRADER"'::jsonb,
  'Main title displayed on the login page'
)
ON CONFLICT (key) DO NOTHING;

-- Insert default login subtitle configuration
INSERT INTO system_configs (key, value, description)
VALUES (
  'login_subtitle',
  '"BLOCKCHAIN TRADING PLATFORM"'::jsonb,
  'Subtitle text displayed below the main title on login page'
)
ON CONFLICT (key) DO NOTHING;

-- Add comment
COMMENT ON TABLE system_configs IS 'System-wide configuration settings including login page customization, auto cleanup schedules, and announcement carousel settings';
