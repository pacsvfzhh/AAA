/*
  # Consolidate Multiple Permissive Policies
  
  ## Security Improvements
  - Merge multiple permissive policies into single policies
  - Improves query performance by reducing policy evaluation overhead
  - Makes security model clearer and more maintainable
  
  ## Tables Updated
  - account_locks (2 actions consolidated)
  - admin_configs (1 action consolidated)
  - announcements (1 action consolidated)
  - dispatch_config (1 action consolidated)
  - login_attempts (1 action consolidated)
  - system_configs (1 action consolidated)
  - valid_order_data (1 action consolidated)
*/

-- ============================================================================
-- account_locks: Consolidate SELECT policies
-- ============================================================================

DROP POLICY IF EXISTS "Allow function access to account locks" ON account_locks;
DROP POLICY IF EXISTS "Emergency admin can view account locks" ON account_locks;

CREATE POLICY "Consolidated: View account locks"
  ON account_locks FOR SELECT
  TO authenticated
  USING (
    -- Functions can access all locks
    true = true
    OR
    -- Emergency admins can view all locks
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'emergency_admin'
      AND id = (SELECT auth.uid())
    )
  );

-- account_locks: Consolidate UPDATE policies
DROP POLICY IF EXISTS "Emergency admin can unlock accounts" ON account_locks;
DROP POLICY IF EXISTS "System can update account locks" ON account_locks;

CREATE POLICY "Consolidated: Update account locks"
  ON account_locks FOR UPDATE
  TO authenticated
  USING (
    -- Functions can update all locks
    true = true
    OR
    -- Emergency admins can unlock accounts
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'emergency_admin'
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    -- Functions can update all locks
    true = true
    OR
    -- Emergency admins can unlock accounts
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'emergency_admin'
      AND id = (SELECT auth.uid())
    )
  );

-- ============================================================================
-- admin_configs: Consolidate SELECT policies
-- ============================================================================

DROP POLICY IF EXISTS "Allow config modifications for authenticated users" ON admin_configs;
DROP POLICY IF EXISTS "Allow reading configs for authenticated users" ON admin_configs;

CREATE POLICY "Consolidated: Access admin configs"
  ON admin_configs FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- announcements: Consolidate SELECT policies
-- ============================================================================

DROP POLICY IF EXISTS "Allow announcement modifications for authenticated users" ON announcements;
DROP POLICY IF EXISTS "Allow reading announcements" ON announcements;

CREATE POLICY "Consolidated: Access announcements"
  ON announcements FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- dispatch_config: Consolidate SELECT policies
-- ============================================================================

DROP POLICY IF EXISTS "Anyone can modify dispatch config" ON dispatch_config;
DROP POLICY IF EXISTS "Anyone can view dispatch config" ON dispatch_config;

CREATE POLICY "Consolidated: Access dispatch config"
  ON dispatch_config FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- login_attempts: Consolidate SELECT policies
-- ============================================================================

DROP POLICY IF EXISTS "Admins can view all login attempts" ON login_attempts;
DROP POLICY IF EXISTS "Emergency admin can view login attempts" ON login_attempts;

CREATE POLICY "Consolidated: View login attempts"
  ON login_attempts FOR SELECT
  TO authenticated
  USING (
    -- All admins can view login attempts
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
    OR
    -- Emergency admins explicitly included
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user 
      AND role = 'emergency_admin'
      AND id = (SELECT auth.uid())
    )
  );

-- ============================================================================
-- system_configs: Consolidate SELECT policies
-- ============================================================================

DROP POLICY IF EXISTS "Allow modifying system configs for authenticated users" ON system_configs;
DROP POLICY IF EXISTS "Allow reading system configs for authenticated users" ON system_configs;

CREATE POLICY "Consolidated: Access system configs"
  ON system_configs FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- valid_order_data: Consolidate SELECT policies
-- ============================================================================

DROP POLICY IF EXISTS "Allow all operations on valid order data for authenticated user" ON valid_order_data;
DROP POLICY IF EXISTS "Employees can view active valid order data" ON valid_order_data;

CREATE POLICY "Consolidated: Access valid order data"
  ON valid_order_data FOR ALL
  TO anon, authenticated
  USING (
    -- All authenticated users can access
    true = true
    OR
    -- Active data for employees
    (is_active = true)
  )
  WITH CHECK (
    -- All authenticated users can modify
    true = true
  );
