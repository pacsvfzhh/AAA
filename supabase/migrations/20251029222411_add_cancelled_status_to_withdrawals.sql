/*
  # Add 'cancelled' status to withdrawals

  1. Changes
    - Updates the withdrawals table status check constraint to include 'cancelled' status
    - This allows distinguishing between:
      - 'cancelled': User cancelled their own withdrawal request
      - 'rejected': Admin rejected the withdrawal request
      - 'approved': Admin approved the withdrawal
      - 'pending': Awaiting admin review

  2. Notes
    - Existing data is not affected
    - The cancelled status will be used when users voluntarily cancel their pending withdrawals
*/

-- Drop the existing check constraint
ALTER TABLE withdrawals DROP CONSTRAINT IF EXISTS withdrawals_status_check;

-- Add new check constraint with 'cancelled' status included
ALTER TABLE withdrawals ADD CONSTRAINT withdrawals_status_check 
  CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'));
