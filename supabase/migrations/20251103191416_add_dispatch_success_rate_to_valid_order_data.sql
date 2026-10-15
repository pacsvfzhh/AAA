/*
  # Add Dispatch Success Rate Configuration

  1. Changes
    - Add `dispatch_success_rate` column to `valid_order_data` table
      - Integer type (0-100) representing percentage
      - Default value: 100 (100% success rate)
      - Allows simulating order grab competition scenarios
  
  2. Purpose
    - Enable admins to configure different success rates for different order data groups
    - More realistic simulation of employee work scenarios where orders can be "grabbed by others"
    - Helps test and train employees in competitive order scenarios
  
  3. Notes
    - Value of 100 means orders are always successfully accepted (current behavior)
    - Value of 80 means 80% chance of success, 20% chance of "already grabbed" message
    - Value of 0 means orders always fail (for testing purposes)
*/

-- Add dispatch_success_rate column to valid_order_data table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'valid_order_data' AND column_name = 'dispatch_success_rate'
  ) THEN
    ALTER TABLE valid_order_data 
    ADD COLUMN dispatch_success_rate integer DEFAULT 100 NOT NULL
    CHECK (dispatch_success_rate >= 0 AND dispatch_success_rate <= 100);
  END IF;
END $$;

COMMENT ON COLUMN valid_order_data.dispatch_success_rate IS 
'Dispatch success rate percentage (0-100). Determines probability of successful order acceptance. 100 = always success, 80 = 80% success rate, etc.';