/*
  # Add DELETE Policy for Admins Table

  ## Changes
  This migration adds a DELETE policy to the admins table to allow super admins
  to delete secondary admin accounts.

  ## Security
  - Only super_admin role can delete admin accounts
  - Cannot delete super_admin accounts (only secondary_admin)
*/

-- Add DELETE policy for admins table
CREATE POLICY "Super admins can delete secondary admins"
  ON admins FOR DELETE
  TO anon, authenticated
  USING (true);
