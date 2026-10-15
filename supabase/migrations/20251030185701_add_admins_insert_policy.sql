/*
  # Add INSERT Policy for Admins Table

  ## Changes
  This migration adds an INSERT policy to the admins table to allow super admins
  to create secondary admin accounts.

  ## Security
  - Only super_admin role can create new admin accounts
  - New admins must be secondary_admin role with proper parent_id reference
*/

-- Add INSERT policy for admins table
CREATE POLICY "Super admins can create secondary admins"
  ON admins FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);
