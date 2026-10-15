/*
  # Add timeout and cancelled status to dispatch_assignments

  1. Changes
    - Add 'timeout' and 'cancelled' to the allowed status values in dispatch_assignments table
    - This allows tracking of orders that timeout or are cancelled due to not being accepted in time
  
  2. Status definitions
    - pending: Order assigned, waiting for acceptance
    - accepted: Order accepted by employee, in progress
    - completed: Order successfully completed
    - error: Order reported with errors
    - timeout: Order timed out (not completed within 10 minutes)
    - cancelled: Order cancelled (not accepted within 60 seconds)
*/

-- Drop the existing check constraint
ALTER TABLE dispatch_assignments 
DROP CONSTRAINT IF EXISTS dispatch_assignments_status_check;

-- Add new check constraint with timeout and cancelled statuses
ALTER TABLE dispatch_assignments 
ADD CONSTRAINT dispatch_assignments_status_check 
CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'completed'::text, 'error'::text, 'timeout'::text, 'cancelled'::text]));