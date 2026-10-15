/*
  # Add Website Icon Configuration
  
  1. Changes
    - Add `icon_type` field to admin_configs table
      - Supports: 'default', 'preset_1' to 'preset_11', 'custom'
    - Add `icon_custom_url` field for custom uploaded icons
    - Add check constraint to validate icon_type values
  
  2. Notes
    - Default icon remains 'default' (blue lightning bolt)
    - 11 preset high-end blockchain tech style icons available
    - Custom icon upload stores URL in icon_custom_url field
*/

DO $$
BEGIN
  -- Add icon_type column if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'admin_configs' AND column_name = 'icon_type'
  ) THEN
    ALTER TABLE admin_configs ADD COLUMN icon_type TEXT DEFAULT 'default';
  END IF;

  -- Add icon_custom_url column if not exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'admin_configs' AND column_name = 'icon_custom_url'
  ) THEN
    ALTER TABLE admin_configs ADD COLUMN icon_custom_url TEXT;
  END IF;
END $$;

-- Add check constraint for icon_type
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'admin_configs_icon_type_check'
  ) THEN
    ALTER TABLE admin_configs
    ADD CONSTRAINT admin_configs_icon_type_check
    CHECK (icon_type IN (
      'default',
      'preset_1', 'preset_2', 'preset_3', 'preset_4', 'preset_5', 'preset_6',
      'preset_7', 'preset_8', 'preset_9', 'preset_10', 'preset_11',
      'custom'
    ));
  END IF;
END $$;

-- Update existing configs to have default icon
UPDATE admin_configs 
SET icon_type = 'default' 
WHERE icon_type IS NULL;

-- Add comment
COMMENT ON COLUMN admin_configs.icon_type IS 'Website icon type: default, preset_1-11, or custom';
COMMENT ON COLUMN admin_configs.icon_custom_url IS 'Custom icon URL when icon_type is custom';