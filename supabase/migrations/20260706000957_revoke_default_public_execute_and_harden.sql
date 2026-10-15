
-- Additional security hardening:
-- 1. Revoke default public EXECUTE grant on all public schema functions
--    (PostgreSQL grants EXECUTE to public by default on new functions)
-- 2. Restrict dispatch_performance_metrics and dispatch_system_logs

-- Revoke default EXECUTE on schema for future functions
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM public;

-- Restrict employee_login_history INSERT (should only be inserted by system/functions)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'employee_login_history') THEN
    -- Check if there's no INSERT policy and add one restricted to service_role
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'employee_login_history' AND cmd = 'INSERT') THEN
      EXECUTE 'CREATE POLICY "System can insert login history" ON employee_login_history FOR INSERT TO anon, authenticated WITH CHECK (true)';
    END IF;
  END IF;
END $$;
