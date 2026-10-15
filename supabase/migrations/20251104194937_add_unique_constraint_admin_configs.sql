/*
  # Add unique constraint for admin-specific configs
  
  1. Changes
    - Add unique index to prevent duplicate config_type per admin_id
    - This ensures each admin can only have one value per config type
    - Does NOT affect global configs (admin_id IS NULL)
    
  2. Security
    - Prevents data inconsistency from duplicate configurations
    - Maintains referential integrity for multi-brand setup
    
  3. Impact
    - No impact on existing data (assuming no duplicates exist)
    - Future inserts will be validated for uniqueness
*/

-- Add unique constraint for admin-specific configs
-- This prevents the same admin from having duplicate config entries
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_configs_admin_config_unique
ON admin_configs (admin_id, config_type)
WHERE admin_id IS NOT NULL;

-- Verify the index was created
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes 
    WHERE indexname = 'idx_admin_configs_admin_config_unique'
  ) THEN
    RAISE NOTICE 'Index created successfully: idx_admin_configs_admin_config_unique';
  END IF;
END $$;
