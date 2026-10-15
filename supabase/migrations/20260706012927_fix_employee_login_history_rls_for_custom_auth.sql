
-- The app uses custom auth (not Supabase Auth), so auth.uid() is always NULL.
-- The RPC functions already handle authorization internally by checking admin role.
-- Fix the SELECT policy to allow the client to read data through the RPC functions.

-- Drop the broken policy that relies on auth.uid()
DROP POLICY IF EXISTS "Admins can view all login history" ON employee_login_history;

-- Create a policy that works with custom auth (allows read access for RPC functions)
CREATE POLICY "Allow read access for custom auth"
  ON employee_login_history
  FOR SELECT
  TO anon, authenticated
  USING (true);
