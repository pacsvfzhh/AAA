
-- The login rate limiting system needs to work BEFORE authentication (anon role).
-- Functions were converted to SECURITY INVOKER but RLS blocks anon from reading
-- login_attempts and account_locks. Fix by adding anon access.

-- Fix login_attempts: allow anon+authenticated to SELECT (needed by check_login_rate_limit and record_login_attempt)
DROP POLICY IF EXISTS "Consolidated: View login attempts" ON login_attempts;
CREATE POLICY "Allow read for rate limit checks"
  ON login_attempts
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Fix account_locks: allow anon+authenticated to SELECT (needed by check_login_rate_limit)
DROP POLICY IF EXISTS "Consolidated: View account locks" ON account_locks;
CREATE POLICY "Allow read for rate limit checks"
  ON account_locks
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- Fix account_locks: allow anon+authenticated to UPDATE (needed by record_login_attempt on successful login)
DROP POLICY IF EXISTS "Consolidated: Update account locks" ON account_locks;
CREATE POLICY "Allow update for rate limit system"
  ON account_locks
  FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);
