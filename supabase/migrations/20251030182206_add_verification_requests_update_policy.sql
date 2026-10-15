/*
  # Add UPDATE policy for verification_requests

  1. Changes
    - Add UPDATE policy to allow admins to review verification requests
    - Allow authenticated users to update their own rejected requests
  
  2. Security
    - Admins can update any verification request (for reviewing)
    - Employees can only update their own rejected requests (for resubmission)
*/

-- Drop the old policy if it exists
DROP POLICY IF EXISTS "Allow verification request updates" ON verification_requests;

-- Allow admins and employees to update verification requests
CREATE POLICY "Allow verification request updates"
  ON verification_requests
  FOR UPDATE
  TO authenticated
  USING (
    -- Admins can update any request
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.id = auth.uid()
    )
    OR
    -- Employees can update their own rejected requests
    (
      user_id = auth.uid()
      AND status = 'rejected'
    )
  )
  WITH CHECK (
    -- Admins can set any status
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.id = auth.uid()
    )
    OR
    -- Employees can only set status to pending when resubmitting
    (
      user_id = auth.uid()
      AND status = 'pending'
    )
  );
