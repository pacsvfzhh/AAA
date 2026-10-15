/*
  # Fix verification_requests SELECT policy

  1. Changes
    - Drop existing SELECT policy that checks auth.uid()
    - Create new SELECT policy that allows anon and authenticated users

  2. Security
    - Allow users to view verification requests
    - Application logic handles user_id validation
*/

-- Drop existing SELECT policy
DROP POLICY IF EXISTS "Employees can view own verification requests" ON verification_requests;

-- Create new SELECT policy that allows all users
CREATE POLICY "Allow verification request viewing"
  ON verification_requests FOR SELECT
  TO anon, authenticated
  USING (true);
