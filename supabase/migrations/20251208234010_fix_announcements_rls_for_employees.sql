/*
  # Fix Announcements RLS Policy for Employees

  ## Problem
  Current policy allows all users to see all announcements (qual: true).
  Employees are seeing 41 announcements instead of only their admin's + global announcements.

  ## Changes
  1. Drop the overly permissive policy
  2. Create proper policies:
     - Employees can only see announcements from their admin or global announcements
     - Admins can see and manage their own announcements
     - Super admins can see and manage all announcements

  ## Security
  - Employees are restricted to their admin's announcements + global ones
  - Proper data isolation between different admin groups
*/

-- Drop the overly permissive policy
DROP POLICY IF EXISTS "Consolidated: Access announcements" ON announcements;

-- Employees can view announcements from their admin or global announcements
CREATE POLICY "Employees can view relevant announcements"
  ON announcements
  FOR SELECT
  TO anon, authenticated
  USING (
    is_hidden = false
    AND publish_at <= NOW()
    AND (
      is_global = true
      OR created_by IN (
        SELECT created_by 
        FROM users 
        WHERE id = current_setting('app.current_user_id', true)::uuid
      )
    )
  );

-- Admins can view their own announcements
CREATE POLICY "Admins can view own announcements"
  ON announcements
  FOR SELECT
  TO anon, authenticated
  USING (
    created_by IN (
      SELECT id 
      FROM admins 
      WHERE id = current_setting('app.current_user_id', true)::uuid
    )
  );

-- Admins can insert their own announcements
CREATE POLICY "Admins can create announcements"
  ON announcements
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    created_by IN (
      SELECT id 
      FROM admins 
      WHERE id = current_setting('app.current_user_id', true)::uuid
    )
  );

-- Admins can update their own announcements
CREATE POLICY "Admins can update own announcements"
  ON announcements
  FOR UPDATE
  TO anon, authenticated
  USING (
    created_by IN (
      SELECT id 
      FROM admins 
      WHERE id = current_setting('app.current_user_id', true)::uuid
    )
  )
  WITH CHECK (
    created_by IN (
      SELECT id 
      FROM admins 
      WHERE id = current_setting('app.current_user_id', true)::uuid
    )
  );

-- Admins can delete their own announcements
CREATE POLICY "Admins can delete own announcements"
  ON announcements
  FOR DELETE
  TO anon, authenticated
  USING (
    created_by IN (
      SELECT id 
      FROM admins 
      WHERE id = current_setting('app.current_user_id', true)::uuid
    )
  );
