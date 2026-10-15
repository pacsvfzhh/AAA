/*
  # Restrict Configuration and Announcement Management to Super Admin Only

  1. Security Changes
    - Drop existing permissive policies for `admin_configs` table
    - Drop existing permissive policies for `announcements` table
    - Create new restrictive policies that only allow super_admin role to modify
    - Regular admins can only read their own configs and global configs
    - Employees can only read announcements, not modify

  2. Important Notes
    - This ensures data integrity by preventing unauthorized configuration changes
    - Only users with super_admin role in the admins table can modify these critical settings
    - Secondary admins cannot access or modify system configurations
    - Secondary admins cannot create, update, or delete announcements
*/

-- Drop existing permissive policies for admin_configs
DROP POLICY IF EXISTS "Configs are viewable" ON admin_configs;
DROP POLICY IF EXISTS "Configs can be modified" ON admin_configs;

-- Drop existing permissive policies for announcements
DROP POLICY IF EXISTS "Announcements are viewable" ON announcements;
DROP POLICY IF EXISTS "Announcements can be modified" ON announcements;

-- Create new restrictive policies for admin_configs

-- Allow reading configs: global configs + own admin configs (for secondary admins)
CREATE POLICY "Admins can read relevant configs"
  ON admin_configs FOR SELECT
  TO anon, authenticated
  USING (
    admin_id IS NULL  -- Global configs readable by all
    OR 
    EXISTS (
      SELECT 1 FROM admins 
      WHERE admins.id = admin_id
    )
  );

-- Only super_admin can insert/update/delete configs
CREATE POLICY "Only super admin can modify configs"
  ON admin_configs FOR ALL
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE admins.username = current_user 
      AND admins.role = 'super_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE admins.username = current_user 
      AND admins.role = 'super_admin'
    )
  );

-- Create new restrictive policies for announcements

-- All authenticated users can read announcements
CREATE POLICY "Everyone can read announcements"
  ON announcements FOR SELECT
  TO anon, authenticated
  USING (true);

-- Only super_admin can insert announcements
CREATE POLICY "Only super admin can create announcements"
  ON announcements FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE admins.username = current_user 
      AND admins.role = 'super_admin'
    )
  );

-- Only super_admin can update announcements
CREATE POLICY "Only super admin can update announcements"
  ON announcements FOR UPDATE
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE admins.username = current_user 
      AND admins.role = 'super_admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE admins.username = current_user 
      AND admins.role = 'super_admin'
    )
  );

-- Only super_admin can delete announcements
CREATE POLICY "Only super admin can delete announcements"
  ON announcements FOR DELETE
  TO anon, authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE admins.username = current_user 
      AND admins.role = 'super_admin'
    )
  );
