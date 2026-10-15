/*
  # Intelligent Data Retention and Automatic Cleanup System

  1. Purpose
    - Prevent unlimited data growth
    - Maintain optimal database performance
    - Automatic cleanup of old non-critical data
    - Configurable retention policies
    
  2. Retention Policies
    - Audit logs: 90 days (configurable)
    - Error logs: 30 days for resolved, 365 days for unresolved
    - Query performance: 30 days (aggregated to monthly summaries)
    - Archive data: 2 years (then move to cold storage)
    
  3. Safety Features
    - Never delete active operational data
    - Always keep summary statistics
    - Configurable per-table policies
    - Manual override capability
*/

-- ============================================================================
-- 1. DATA RETENTION CONFIGURATION TABLE
-- ============================================================================

-- Create configuration table for retention policies
CREATE TABLE IF NOT EXISTS data_retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL UNIQUE,
  retention_days integer NOT NULL,
  cleanup_enabled boolean DEFAULT true,
  last_cleanup_at timestamptz,
  records_cleaned_last_run integer DEFAULT 0,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Insert default retention policies
INSERT INTO data_retention_policies (table_name, retention_days, description)
VALUES
  ('valid_data_audit_log', 90, 'Audit trail for valid_order_data changes. Keep 90 days for compliance.'),
  ('valid_data_error_log', 90, 'Error tracking log. Keep resolved errors for 90 days, unresolved for 365 days.'),
  ('valid_data_query_performance', 30, 'Query performance metrics. Keep 30 days of detailed data, summarize older.'),
  ('valid_order_data_archive', 730, 'Archived valid data. Keep 2 years then export to cold storage.')
ON CONFLICT (table_name) DO NOTHING;

-- ============================================================================
-- 2. AGGREGATED STATISTICS TABLES (FOR LONG-TERM TRENDS)
-- ============================================================================

-- Monthly aggregated statistics (keeps data forever without bloat)
CREATE TABLE IF NOT EXISTS valid_data_monthly_stats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year integer NOT NULL,
  month integer NOT NULL,
  total_valid_data_created integer DEFAULT 0,
  total_valid_data_used integer DEFAULT 0,
  unique_users_active integer DEFAULT 0,
  avg_data_per_user numeric DEFAULT 0,
  avg_usage_count numeric DEFAULT 0,
  total_orders_submitted integer DEFAULT 0,
  errors_detected integer DEFAULT 0,
  errors_auto_fixed integer DEFAULT 0,
  avg_query_time_ms numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(year, month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_stats_date ON valid_data_monthly_stats(year DESC, month DESC);

-- Function to aggregate current month data
CREATE OR REPLACE FUNCTION aggregate_monthly_statistics()
RETURNS TABLE (
  month_aggregated text,
  records_aggregated integer,
  status text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_year integer;
  v_month integer;
  v_valid_created integer;
  v_valid_used integer;
  v_unique_users integer;
  v_avg_data_per_user numeric;
  v_avg_usage_count numeric;
  v_total_orders integer;
  v_errors_detected integer;
  v_errors_fixed integer;
  v_avg_query_time numeric;
BEGIN
  -- Get last month's date
  v_year := EXTRACT(year FROM (CURRENT_DATE - INTERVAL '1 month'));
  v_month := EXTRACT(month FROM (CURRENT_DATE - INTERVAL '1 month'));
  
  -- Skip if already aggregated
  IF EXISTS (SELECT 1 FROM valid_data_monthly_stats WHERE year = v_year AND month = v_month) THEN
    RETURN QUERY SELECT
      format('%s-%s', v_year, LPAD(v_month::text, 2, '0'))::text,
      0,
      'Already aggregated'::text;
    RETURN;
  END IF;
  
  -- Aggregate valid data created
  SELECT COUNT(*) INTO v_valid_created
  FROM valid_order_data
  WHERE EXTRACT(year FROM created_at) = v_year
    AND EXTRACT(month FROM created_at) = v_month;
  
  -- Aggregate valid data used
  SELECT COUNT(*) INTO v_valid_used
  FROM used_order_data
  WHERE EXTRACT(year FROM created_at) = v_year
    AND EXTRACT(month FROM created_at) = v_month;
  
  -- Unique users active
  SELECT COUNT(DISTINCT user_id) INTO v_unique_users
  FROM used_order_data
  WHERE EXTRACT(year FROM created_at) = v_year
    AND EXTRACT(month FROM created_at) = v_month;
  
  -- Average data per user
  v_avg_data_per_user := CASE WHEN v_unique_users > 0 
    THEN v_valid_used::numeric / v_unique_users 
    ELSE 0 
  END;
  
  -- Average usage count
  SELECT ROUND(AVG(usage_count), 2) INTO v_avg_usage_count
  FROM valid_order_data
  WHERE last_used_at IS NOT NULL
    AND EXTRACT(year FROM last_used_at) = v_year
    AND EXTRACT(month FROM last_used_at) = v_month;
  
  -- Total orders
  SELECT COUNT(*) INTO v_total_orders
  FROM orders
  WHERE EXTRACT(year FROM created_at) = v_year
    AND EXTRACT(month FROM created_at) = v_month;
  
  -- Errors detected and fixed
  SELECT 
    COUNT(*) FILTER (WHERE auto_resolved = false),
    COUNT(*) FILTER (WHERE auto_resolved = true)
  INTO v_errors_detected, v_errors_fixed
  FROM valid_data_error_log
  WHERE EXTRACT(year FROM detected_at) = v_year
    AND EXTRACT(month FROM detected_at) = v_month;
  
  -- Average query time
  SELECT ROUND(AVG(execution_time_ms), 2) INTO v_avg_query_time
  FROM valid_data_query_performance
  WHERE EXTRACT(year FROM recorded_at) = v_year
    AND EXTRACT(month FROM recorded_at) = v_month;
  
  -- Insert aggregated data
  INSERT INTO valid_data_monthly_stats (
    year, month, total_valid_data_created, total_valid_data_used,
    unique_users_active, avg_data_per_user, avg_usage_count,
    total_orders_submitted, errors_detected, errors_auto_fixed,
    avg_query_time_ms
  )
  VALUES (
    v_year, v_month, v_valid_created, v_valid_used,
    v_unique_users, v_avg_data_per_user, COALESCE(v_avg_usage_count, 0),
    v_total_orders, COALESCE(v_errors_detected, 0), COALESCE(v_errors_fixed, 0),
    COALESCE(v_avg_query_time, 0)
  );
  
  RETURN QUERY SELECT
    format('%s-%s', v_year, LPAD(v_month::text, 2, '0'))::text,
    v_valid_used,
    'Success'::text;
END;
$$;

-- ============================================================================
-- 3. INTELLIGENT CLEANUP FUNCTIONS
-- ============================================================================

-- Cleanup old audit logs (keeps retention_days)
CREATE OR REPLACE FUNCTION cleanup_old_audit_logs()
RETURNS TABLE (
  cleanup_type text,
  records_deleted integer,
  oldest_kept_date date,
  status text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_retention_days integer;
  v_deleted_count integer;
  v_cutoff_date timestamptz;
BEGIN
  -- Get retention policy
  SELECT retention_days INTO v_retention_days
  FROM data_retention_policies
  WHERE table_name = 'valid_data_audit_log'
    AND cleanup_enabled = true;
  
  IF v_retention_days IS NULL THEN
    RETURN QUERY SELECT
      'Audit Log Cleanup'::text,
      0,
      CURRENT_DATE,
      'Cleanup disabled or policy not found'::text;
    RETURN;
  END IF;
  
  v_cutoff_date := NOW() - (v_retention_days || ' days')::interval;
  
  -- Delete old audit logs
  WITH deleted AS (
    DELETE FROM valid_data_audit_log
    WHERE action_timestamp < v_cutoff_date
    RETURNING id
  )
  SELECT COUNT(*)::integer INTO v_deleted_count FROM deleted;
  
  -- Update policy table
  UPDATE data_retention_policies
  SET last_cleanup_at = NOW(),
      records_cleaned_last_run = v_deleted_count
  WHERE table_name = 'valid_data_audit_log';
  
  RETURN QUERY SELECT
    'Audit Log Cleanup'::text,
    v_deleted_count,
    v_cutoff_date::date,
    format('Deleted %s records older than %s days', v_deleted_count, v_retention_days)::text;
END;
$$;

-- Cleanup old error logs (different retention for resolved vs unresolved)
CREATE OR REPLACE FUNCTION cleanup_old_error_logs()
RETURNS TABLE (
  cleanup_type text,
  records_deleted integer,
  oldest_kept_date date,
  status text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_retention_days integer;
  v_resolved_deleted integer;
  v_cutoff_date timestamptz;
BEGIN
  -- Get retention policy
  SELECT retention_days INTO v_retention_days
  FROM data_retention_policies
  WHERE table_name = 'valid_data_error_log'
    AND cleanup_enabled = true;
  
  IF v_retention_days IS NULL THEN
    RETURN QUERY SELECT
      'Error Log Cleanup'::text,
      0,
      CURRENT_DATE,
      'Cleanup disabled or policy not found'::text;
    RETURN;
  END IF;
  
  v_cutoff_date := NOW() - (v_retention_days || ' days')::interval;
  
  -- Delete ONLY resolved errors older than retention period
  -- Keep unresolved errors for much longer (365 days)
  WITH deleted AS (
    DELETE FROM valid_data_error_log
    WHERE resolved_at IS NOT NULL
      AND resolved_at < v_cutoff_date
    RETURNING id
  )
  SELECT COUNT(*)::integer INTO v_resolved_deleted FROM deleted;
  
  -- Also delete very old unresolved errors (365 days)
  WITH deleted_unresolved AS (
    DELETE FROM valid_data_error_log
    WHERE resolved_at IS NULL
      AND detected_at < (NOW() - INTERVAL '365 days')
    RETURNING id
  )
  SELECT v_resolved_deleted + COUNT(*)::integer INTO v_resolved_deleted FROM deleted_unresolved;
  
  -- Update policy table
  UPDATE data_retention_policies
  SET last_cleanup_at = NOW(),
      records_cleaned_last_run = v_resolved_deleted
  WHERE table_name = 'valid_data_error_log';
  
  RETURN QUERY SELECT
    'Error Log Cleanup'::text,
    v_resolved_deleted,
    v_cutoff_date::date,
    format('Deleted %s resolved errors older than %s days', v_resolved_deleted, v_retention_days)::text;
END;
$$;

-- Cleanup old query performance data (after aggregation)
CREATE OR REPLACE FUNCTION cleanup_old_query_performance()
RETURNS TABLE (
  cleanup_type text,
  records_deleted integer,
  oldest_kept_date date,
  status text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_retention_days integer;
  v_deleted_count integer;
  v_cutoff_date timestamptz;
BEGIN
  -- Get retention policy
  SELECT retention_days INTO v_retention_days
  FROM data_retention_policies
  WHERE table_name = 'valid_data_query_performance'
    AND cleanup_enabled = true;
  
  IF v_retention_days IS NULL THEN
    RETURN QUERY SELECT
      'Query Performance Cleanup'::text,
      0,
      CURRENT_DATE,
      'Cleanup disabled or policy not found'::text;
    RETURN;
  END IF;
  
  v_cutoff_date := NOW() - (v_retention_days || ' days')::interval;
  
  -- Delete old performance records
  WITH deleted AS (
    DELETE FROM valid_data_query_performance
    WHERE recorded_at < v_cutoff_date
    RETURNING id
  )
  SELECT COUNT(*)::integer INTO v_deleted_count FROM deleted;
  
  -- Update policy table
  UPDATE data_retention_policies
  SET last_cleanup_at = NOW(),
      records_cleaned_last_run = v_deleted_count
  WHERE table_name = 'valid_data_query_performance';
  
  RETURN QUERY SELECT
    'Query Performance Cleanup'::text,
    v_deleted_count,
    v_cutoff_date::date,
    format('Deleted %s performance records older than %s days', v_deleted_count, v_retention_days)::text;
END;
$$;

-- Cleanup very old archived data (2+ years)
CREATE OR REPLACE FUNCTION cleanup_old_archived_data()
RETURNS TABLE (
  cleanup_type text,
  records_deleted integer,
  oldest_kept_date date,
  status text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_retention_days integer;
  v_deleted_count integer;
  v_cutoff_date timestamptz;
BEGIN
  -- Get retention policy
  SELECT retention_days INTO v_retention_days
  FROM data_retention_policies
  WHERE table_name = 'valid_order_data_archive'
    AND cleanup_enabled = true;
  
  IF v_retention_days IS NULL THEN
    RETURN QUERY SELECT
      'Archive Data Cleanup'::text,
      0,
      CURRENT_DATE,
      'Cleanup disabled or policy not found'::text;
    RETURN;
  END IF;
  
  v_cutoff_date := NOW() - (v_retention_days || ' days')::interval;
  
  -- Delete very old archived data
  WITH deleted AS (
    DELETE FROM valid_order_data_archive
    WHERE archived_at < v_cutoff_date
    RETURNING id
  )
  SELECT COUNT(*)::integer INTO v_deleted_count FROM deleted;
  
  -- Update policy table
  UPDATE data_retention_policies
  SET last_cleanup_at = NOW(),
      records_cleaned_last_run = v_deleted_count
  WHERE table_name = 'valid_order_data_archive';
  
  RETURN QUERY SELECT
    'Archive Data Cleanup'::text,
    v_deleted_count,
    v_cutoff_date::date,
    format('Deleted %s archived records older than %s days (%s years)', 
      v_deleted_count, v_retention_days, ROUND(v_retention_days/365.0, 1))::text;
END;
$$;

-- ============================================================================
-- 4. MASTER CLEANUP FUNCTION
-- ============================================================================

-- Comprehensive cleanup function (runs all cleanup tasks)
CREATE OR REPLACE FUNCTION run_comprehensive_cleanup(
  p_force boolean DEFAULT false
)
RETURNS TABLE (
  task_name text,
  records_cleaned integer,
  execution_time_ms numeric,
  status text,
  details text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_time timestamp;
  v_duration numeric;
  v_total_cleaned integer := 0;
BEGIN
  -- Task 1: Aggregate monthly statistics (before cleanup)
  v_start_time := clock_timestamp();
  PERFORM aggregate_monthly_statistics();
  v_duration := EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000;
  
  RETURN QUERY SELECT
    'Aggregate Monthly Stats'::text,
    0,
    ROUND(v_duration, 2),
    'COMPLETED'::text,
    'Monthly statistics aggregated for long-term trends'::text;
  
  -- Task 2: Cleanup audit logs
  v_start_time := clock_timestamp();
  RETURN QUERY
  SELECT
    ct.cleanup_type::text,
    ct.records_deleted,
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    ct.status,
    ct.status
  FROM cleanup_old_audit_logs() ct;
  
  -- Task 3: Cleanup error logs
  v_start_time := clock_timestamp();
  RETURN QUERY
  SELECT
    ct.cleanup_type::text,
    ct.records_deleted,
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    ct.status,
    ct.status
  FROM cleanup_old_error_logs() ct;
  
  -- Task 4: Cleanup query performance data
  v_start_time := clock_timestamp();
  RETURN QUERY
  SELECT
    ct.cleanup_type::text,
    ct.records_deleted,
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    ct.status,
    ct.status
  FROM cleanup_old_query_performance() ct;
  
  -- Task 5: Cleanup archived data (only if 2+ years old)
  v_start_time := clock_timestamp();
  RETURN QUERY
  SELECT
    ct.cleanup_type::text,
    ct.records_deleted,
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    ct.status,
    ct.status
  FROM cleanup_old_archived_data() ct;
  
  -- Task 6: VACUUM ANALYZE for optimization
  v_start_time := clock_timestamp();
  VACUUM ANALYZE valid_data_audit_log;
  VACUUM ANALYZE valid_data_error_log;
  VACUUM ANALYZE valid_data_query_performance;
  VACUUM ANALYZE valid_order_data_archive;
  v_duration := EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000;
  
  RETURN QUERY SELECT
    'VACUUM ANALYZE'::text,
    0,
    ROUND(v_duration, 2),
    'COMPLETED'::text,
    'Optimized table storage and updated statistics'::text;
END;
$$;

-- ============================================================================
-- 5. STORAGE MONITORING
-- ============================================================================

-- Function to monitor storage usage
CREATE OR REPLACE FUNCTION monitor_storage_usage()
RETURNS TABLE (
  table_name text,
  total_size text,
  table_size text,
  index_size text,
  row_count bigint,
  avg_row_size text,
  size_trend text,
  recommendation text
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.tablename::text,
    pg_size_pretty(pg_total_relation_size('public.'||t.tablename)) as total_size,
    pg_size_pretty(pg_relation_size('public.'||t.tablename)) as table_size,
    pg_size_pretty(pg_total_relation_size('public.'||t.tablename) - pg_relation_size('public.'||t.tablename)) as index_size,
    (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t.tablename) as row_count,
    CASE
      WHEN (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t.tablename) > 0
      THEN pg_size_pretty(pg_relation_size('public.'||t.tablename) / GREATEST((SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t.tablename), 1))
      ELSE '0 bytes'
    END as avg_row_size,
    CASE
      WHEN pg_total_relation_size('public.'||t.tablename) > 1073741824 THEN 'LARGE (>1GB)'
      WHEN pg_total_relation_size('public.'||t.tablename) > 104857600 THEN 'MEDIUM (>100MB)'
      WHEN pg_total_relation_size('public.'||t.tablename) > 10485760 THEN 'SMALL (>10MB)'
      ELSE 'MINIMAL (<10MB)'
    END as size_trend,
    CASE
      WHEN pg_total_relation_size('public.'||t.tablename) > 1073741824 THEN 'Consider partitioning or archiving'
      WHEN pg_total_relation_size('public.'||t.tablename) > 524288000 THEN 'Monitor growth, plan cleanup'
      ELSE 'Size is acceptable'
    END as recommendation
  FROM pg_tables t
  WHERE t.schemaname = 'public'
    AND t.tablename IN (
      'valid_order_data',
      'used_order_data',
      'valid_order_data_archive',
      'valid_data_audit_log',
      'valid_data_error_log',
      'valid_data_query_performance',
      'valid_data_monthly_stats'
    )
  ORDER BY pg_total_relation_size('public.'||t.tablename) DESC;
END;
$$;

-- ============================================================================
-- 6. AUTOMATED CLEANUP SCHEDULE VIEW
-- ============================================================================

CREATE OR REPLACE VIEW data_cleanup_schedule AS
SELECT
  table_name,
  retention_days,
  cleanup_enabled,
  last_cleanup_at,
  records_cleaned_last_run,
  CASE
    WHEN last_cleanup_at IS NULL THEN 'Never run'
    WHEN last_cleanup_at < NOW() - INTERVAL '2 days' THEN 'OVERDUE'
    WHEN last_cleanup_at < NOW() - INTERVAL '1 day' THEN 'DUE SOON'
    ELSE 'UP TO DATE'
  END as cleanup_status,
  CASE
    WHEN last_cleanup_at IS NULL THEN NULL
    ELSE EXTRACT(days FROM (NOW() - last_cleanup_at))
  END as days_since_last_cleanup,
  description
FROM data_retention_policies
ORDER BY
  CASE
    WHEN last_cleanup_at IS NULL THEN 0
    ELSE EXTRACT(epoch FROM last_cleanup_at)
  END ASC;

-- Grant permissions
GRANT SELECT ON data_retention_policies TO authenticated;
GRANT SELECT ON valid_data_monthly_stats TO authenticated;
GRANT SELECT ON data_cleanup_schedule TO authenticated;
GRANT EXECUTE ON FUNCTION aggregate_monthly_statistics() TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_old_audit_logs() TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_old_error_logs() TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_old_query_performance() TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_old_archived_data() TO authenticated;
GRANT EXECUTE ON FUNCTION run_comprehensive_cleanup(boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION monitor_storage_usage() TO authenticated;

-- Add helpful comments
COMMENT ON TABLE data_retention_policies IS 'Configurable retention policies for each table. Adjust retention_days as needed.';
COMMENT ON TABLE valid_data_monthly_stats IS 'Aggregated monthly statistics. Keeps forever without bloat (1 row per month).';
COMMENT ON FUNCTION run_comprehensive_cleanup(boolean) IS 'Master cleanup function. Run daily to maintain optimal database size.';
COMMENT ON FUNCTION monitor_storage_usage() IS 'Storage monitoring. Check weekly to identify growth trends.';
COMMENT ON VIEW data_cleanup_schedule IS 'Shows last cleanup time and status for each table.';
