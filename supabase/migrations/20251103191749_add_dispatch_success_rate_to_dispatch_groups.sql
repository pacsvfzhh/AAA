/*
  # Add Dispatch Success Rate to Dispatch Groups

  1. Changes
    - Add `dispatch_success_rate` column to `dispatch_groups` table
      - Integer type (0-100) representing percentage
      - Default value: 100 (100% success rate)
      - Allows simulating order grab competition scenarios per group
  
  2. Purpose
    - Enable admins to configure different success rates for different dispatch groups
    - More realistic simulation where employees compete for orders
    - Group-specific success rates allow testing different competitive scenarios
  
  3. Notes
    - Value of 100 means orders are always successfully accepted (current behavior)
    - Value of 80 means 80% chance of success, 20% chance of "already grabbed" message
    - Value of 0 means orders always fail (for testing purposes)
    - Each dispatch group can have a different success rate
*/

-- Add dispatch_success_rate column to dispatch_groups table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'dispatch_groups' AND column_name = 'dispatch_success_rate'
  ) THEN
    ALTER TABLE dispatch_groups 
    ADD COLUMN dispatch_success_rate integer DEFAULT 100 NOT NULL
    CHECK (dispatch_success_rate >= 0 AND dispatch_success_rate <= 100);
  END IF;
END $$;

COMMENT ON COLUMN dispatch_groups.dispatch_success_rate IS 
'Dispatch success rate percentage (0-100) for this group. Determines probability of successful order acceptance. 100 = always success, 80 = 80% success rate, etc.';