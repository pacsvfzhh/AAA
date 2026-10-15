
-- The assign_next_dispatch_order function (now SECURITY INVOKER) needs to INSERT
-- into dispatch_system_logs and dispatch_performance_metrics.
-- Without INSERT policies, the function fails silently and returns {success: false}.

-- Add INSERT policy for dispatch_system_logs
CREATE POLICY "Anyone can insert system logs"
  ON dispatch_system_logs FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Add INSERT policy for dispatch_performance_metrics
CREATE POLICY "Anyone can insert performance metrics"
  ON dispatch_performance_metrics FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);
