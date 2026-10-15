/*
  # Optimize RLS Auth Policies
  
  ## Performance Improvements
  - Replace auth.uid() calls with (SELECT auth.uid()) to prevent re-evaluation per row
  - This dramatically improves query performance at scale
  
  ## Affected Tables
  - announcement_categories (3 policies)
  - dispatch_rate_limits (1 policy)
  - account_locks (2 policies)
  - login_attempts (1 policy)
  - employee_login_history (1 policy)
*/

-- announcement_categories policies
DROP POLICY IF EXISTS "Super admins can insert categories" ON announcement_categories;
CREATE POLICY "Super admins can insert categories"
  ON announcement_categories FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'super_admin'
      AND id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Super admins can update categories" ON announcement_categories;
CREATE POLICY "Super admins can update categories"
  ON announcement_categories FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'super_admin'
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'super_admin'
      AND id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Super admins can delete categories" ON announcement_categories;
CREATE POLICY "Super admins can delete categories"
  ON announcement_categories FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'super_admin'
      AND id = (SELECT auth.uid())
    )
  );

-- dispatch_rate_limits policy
DROP POLICY IF EXISTS "Users can view own rate limits" ON dispatch_rate_limits;
CREATE POLICY "Users can view own rate limits"
  ON dispatch_rate_limits FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- account_locks policies
DROP POLICY IF EXISTS "Emergency admin can view account locks" ON account_locks;
CREATE POLICY "Emergency admin can view account locks"
  ON account_locks FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'emergency_admin'
      AND id = (SELECT auth.uid())
    )
  );

DROP POLICY IF EXISTS "Emergency admin can unlock accounts" ON account_locks;
CREATE POLICY "Emergency admin can unlock accounts"
  ON account_locks FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'emergency_admin'
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'emergency_admin'
      AND id = (SELECT auth.uid())
    )
  );

-- login_attempts policy
DROP POLICY IF EXISTS "Emergency admin can view login attempts" ON login_attempts;
CREATE POLICY "Emergency admin can view login attempts"
  ON login_attempts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'emergency_admin'
      AND id = (SELECT auth.uid())
    )
  );

-- employee_login_history policy
DROP POLICY IF EXISTS "Admins can view all login history" ON employee_login_history;
CREATE POLICY "Admins can view all login history"
  ON employee_login_history FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );
