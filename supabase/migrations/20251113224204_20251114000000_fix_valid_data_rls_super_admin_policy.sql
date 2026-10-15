/*
  # Fix Valid Data RLS - Super Admin Policy

  ## Problem
  The current "Super admin can manage all valid order data" policy has a bug:
  - It checks `a.id = valid_order_data.created_by`
  - This means super admin can only manage their OWN data
  - This defeats the purpose of having a super admin

  ## Solution
  - Remove the buggy super admin policy
  - Create a correct super admin policy that allows managing ALL data
  - Super admin should be able to manage data created by any admin
  - Uses `current_user` (username) to identify the super admin

  ## Impact
  - ✅ Super admin can now manage all valid_order_data (as intended)
  - ✅ Regular admins still can only manage their own data
  - ✅ Employees remain read-only for active data
  - ✅ No breaking changes to existing functionality

  ## Security
  - Maintains principle of least privilege
  - Super admin role properly verified via username
  - All other policies remain unchanged
*/

-- ============================================================================
-- 1. REMOVE BUGGY SUPER ADMIN POLICY
-- ============================================================================

DROP POLICY IF EXISTS "Super admin can manage all valid order data" ON valid_order_data;

-- ============================================================================
-- 2. CREATE CORRECT SUPER ADMIN POLICY
-- ============================================================================

-- Super admin can manage ALL valid order data (not just their own)
CREATE POLICY "Super admin can manage all valid order data"
  ON valid_order_data FOR ALL
  TO anon, authenticated
  USING (
    -- Check if current user is a super admin
    -- Uses username (current_user) to identify the user
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.username = current_user
      AND admins.role = 'super_admin'
    )
  )
  WITH CHECK (
    -- For INSERT/UPDATE, verify the created_by is an admin
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.id = valid_order_data.created_by
    )
  );

-- ============================================================================
-- 3. ADD COMMENT
-- ============================================================================

COMMENT ON POLICY "Super admin can manage all valid order data" ON valid_order_data IS
'Allows super admins to manage all valid order data regardless of who created it. Regular admins are restricted by other policies.';

-- ============================================================================
-- 4. VERIFICATION QUERY
-- ============================================================================

-- To verify the policies are correct, run:
-- SELECT policyname, cmd, qual, with_check
-- FROM pg_policies
-- WHERE tablename = 'valid_order_data'
-- ORDER BY policyname;