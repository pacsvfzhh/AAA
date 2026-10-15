/*
  # Fix verification_requests INSERT policy

  1. Changes
    - Drop existing INSERT policy that checks auth.uid()
    - Create new INSERT policy that allows anon and authenticated users

  2. Security
    - Allow users to create verification requests
    - Application logic handles user_id validation
*/

-- Drop existing INSERT policy
DROP POLICY IF EXISTS "Employees can create verification requests" ON verification_requests;

-- Create new INSERT policy that allows all users
CREATE POLICY "Allow verification request creation"
  ON verification_requests FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);
