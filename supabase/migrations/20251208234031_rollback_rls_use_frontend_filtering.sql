/*
  # Rollback RLS - Use Frontend Filtering
  
  ## Context
  This project uses custom authentication (not Supabase Auth).
  RLS policies cannot use auth.uid() or current_setting() effectively.
  
  ## Solution
  Keep simple RLS policy and rely on frontend filtering.
*/

-- Drop the policies that won't work with custom auth
DROP POLICY IF EXISTS "Employees can view relevant announcements" ON announcements;
DROP POLICY IF EXISTS "Admins can view own announcements" ON announcements;
DROP POLICY IF EXISTS "Admins can create announcements" ON announcements;
DROP POLICY IF EXISTS "Admins can update own announcements" ON announcements;
DROP POLICY IF EXISTS "Admins can delete own announcements" ON announcements;

-- Restore simple policy for custom auth
CREATE POLICY "Allow all access for custom auth"
  ON announcements
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
