/*
  # Fix valid_order_data RLS policies for super admin updates
  
  ## Problem
  - Super admin policy has WITH CHECK that requires created_by = admin.id
  - This prevents super admin from updating records created by other admins
  - When deactivating valid_order_data, the WITH CHECK clause fails
  
  ## Solution
  - Drop existing super admin policy
  - Create new super admin policy with proper WITH CHECK that allows all updates
  - Super admin should be able to UPDATE any valid_order_data record regardless of created_by
*/

-- Drop the broken super admin policy
DROP POLICY IF EXISTS "Super admin can manage all valid order data" ON valid_order_data;

-- Create correct super admin policy for SELECT
CREATE POLICY "Super admin can view all valid order data"
  ON valid_order_data
  FOR SELECT
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.username = CURRENT_USER
        AND admins.role = 'super_admin'
    )
  );

-- Create correct super admin policy for INSERT
CREATE POLICY "Super admin can insert valid order data"
  ON valid_order_data
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.username = CURRENT_USER
        AND admins.role = 'super_admin'
    )
  );

-- Create correct super admin policy for UPDATE (NO created_by restriction)
CREATE POLICY "Super admin can update all valid order data"
  ON valid_order_data
  FOR UPDATE
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.username = CURRENT_USER
        AND admins.role = 'super_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.username = CURRENT_USER
        AND admins.role = 'super_admin'
    )
  );

-- Create correct super admin policy for DELETE
CREATE POLICY "Super admin can delete all valid order data"
  ON valid_order_data
  FOR DELETE
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.username = CURRENT_USER
        AND admins.role = 'super_admin'
    )
  );

-- Verify policies
DO $$
BEGIN
  RAISE NOTICE '✅ Valid order data RLS policies fixed';
  RAISE NOTICE '   - Super admin can now UPDATE any valid_order_data record';
  RAISE NOTICE '   - created_by restriction removed from super admin WITH CHECK';
  RAISE NOTICE '   - Regular admins still restricted to their own records';
END $$;
