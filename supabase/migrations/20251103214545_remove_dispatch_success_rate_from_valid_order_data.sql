/*
  # Remove Redundant dispatch_success_rate from valid_order_data

  1. Problem Analysis
    - The `dispatch_success_rate` column in `valid_order_data` table is not used anywhere in the codebase
    - It was confused with two other independent success rate systems:
      - `dispatch_groups.dispatch_success_rate` (controls order grab competition in dispatch system)
      - `admin_configs.success_rate` (controls order processing success/failure rate)
    
  2. Changes
    - Drop `dispatch_success_rate` column from `valid_order_data` table
    - This field exists but serves no purpose in the actual business logic
    
  3. Impact
    - No functional impact - field was never used
    - Reduces confusion between different success rate systems
    - Frees up storage space
    - Simplifies Valid Order Data Management interface
    
  4. Note
    - This does NOT affect:
      - Order dispatch/grab success rate (dispatch_groups.dispatch_success_rate)
      - Order processing success rate (admin_configs.success_rate)
*/

-- Drop the unused dispatch_success_rate column from valid_order_data
ALTER TABLE valid_order_data DROP COLUMN IF EXISTS dispatch_success_rate;

-- Verify the column is dropped
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'valid_order_data' AND column_name = 'dispatch_success_rate'
  ) THEN
    RAISE EXCEPTION 'Failed to drop dispatch_success_rate column';
  END IF;
END $$;
