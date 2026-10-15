
-- Restrict remaining policies using {public} role to {anon, authenticated}

DROP POLICY IF EXISTS "Admins can view performance metrics" ON dispatch_performance_metrics;
CREATE POLICY "Admins can view performance metrics" ON dispatch_performance_metrics
  FOR SELECT TO anon, authenticated 
  USING (EXISTS (SELECT 1 FROM admins WHERE admins.username = CURRENT_USER));

DROP POLICY IF EXISTS "Admins can view system logs" ON dispatch_system_logs;
CREATE POLICY "Admins can view system logs" ON dispatch_system_logs
  FOR SELECT TO anon, authenticated 
  USING (EXISTS (SELECT 1 FROM admins WHERE admins.username = CURRENT_USER));
