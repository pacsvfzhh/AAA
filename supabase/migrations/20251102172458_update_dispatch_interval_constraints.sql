/*
  # Update Dispatch Interval Constraints
  
  1. Changes
    - Update min_interval constraint: allow 1-3000 seconds (was 10-300)
    - Update max_interval constraint: allow 1-3000 seconds (was 30-600)
    - Remove minimum value requirement for max_interval
    - Allow flexible configuration by admins
    
  2. Notes
    - Admins can now set any interval between 1 second and 3000 seconds (50 minutes)
    - System will still validate that max >= min in application layer
*/

-- Drop existing constraints
ALTER TABLE dispatch_groups 
  DROP CONSTRAINT IF EXISTS dispatch_groups_dispatch_interval_min_check;

ALTER TABLE dispatch_groups 
  DROP CONSTRAINT IF EXISTS dispatch_groups_dispatch_interval_max_check;

-- Add new constraints with wider range
ALTER TABLE dispatch_groups 
  ADD CONSTRAINT dispatch_groups_dispatch_interval_min_check 
  CHECK (dispatch_interval_min >= 1 AND dispatch_interval_min <= 3000);

ALTER TABLE dispatch_groups 
  ADD CONSTRAINT dispatch_groups_dispatch_interval_max_check 
  CHECK (dispatch_interval_max >= 1 AND dispatch_interval_max <= 3000);

-- Update default group to ensure it meets new constraints (it already does, but this is safe)
UPDATE dispatch_groups 
SET 
  dispatch_interval_min = GREATEST(1, LEAST(dispatch_interval_min, 3000)),
  dispatch_interval_max = GREATEST(1, LEAST(dispatch_interval_max, 3000))
WHERE is_default = true;
