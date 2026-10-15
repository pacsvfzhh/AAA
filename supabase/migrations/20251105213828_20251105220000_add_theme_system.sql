/*
  # Add Theme System to Admin Configs

  1. Changes
    - Add `theme` column to `admin_configs` table
    - Supports 10 predefined themes with tech + blockchain aesthetics
    - Default theme: 'theme-01' (Cyan Tech)

  2. Available Themes
    - theme-01: Cyan Tech (default) - Current cyan/blue scheme
    - theme-02: Purple Future - Deep purple with neon accents
    - theme-03: Green Matrix - Matrix-style green with dark background
    
  3. Notes
    - Each admin can set their own theme
    - Employees automatically inherit their admin's theme
    - Super admin's theme applies to all admins who haven't set their own
*/

-- Add theme column to admin_configs table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'admin_configs' AND column_name = 'theme'
  ) THEN
    ALTER TABLE admin_configs ADD COLUMN theme TEXT DEFAULT 'theme-01' CHECK (theme IN (
      'theme-01', 'theme-02', 'theme-03', 'theme-04', 'theme-05',
      'theme-06', 'theme-07', 'theme-08', 'theme-09', 'theme-10'
    ));
  END IF;
END $$;

-- Create index for theme lookups
CREATE INDEX IF NOT EXISTS idx_admin_configs_theme ON admin_configs(theme);