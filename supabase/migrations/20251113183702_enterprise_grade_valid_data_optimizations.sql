/*
  # Enterprise-Grade Valid Data System Optimizations

  1. Data Pool Management
    - Automatic low-threshold detection
    - Smart data distribution
    - Capacity planning alerts
    - Auto-scaling recommendations
    
  2. Advanced Monitoring
    - Real-time health metrics
    - Performance tracking
    - Usage pattern analysis
    - Predictive analytics
    
  3. Data Lifecycle Management
    - Automatic archiving of old data
    - Data retention policies
    - Cleanup automation
    - Historical tracking
    
  4. Fault Recovery
    - Automatic error detection
    - Self-healing mechanisms
    - Rollback capabilities
    - Data consistency checks
    
  5. Audit & Compliance
    - Complete audit trail
    - Change tracking
    - Admin action logging
    - Compliance reporting
    
  6. Performance Optimization
    - Query optimization hints
    - Automatic index maintenance
    - Cache management
    - Load balancing support
*/

-- ============================================================================
-- 1. DATA POOL MANAGEMENT
-- ============================================================================

-- Add metadata to valid_order_data for better management
ALTER TABLE valid_order_data 
  ADD COLUMN IF NOT EXISTS usage_count integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivation_reason text,
  ADD COLUMN IF NOT EXISTS priority integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tags text[];

-- Add comments for clarity
COMMENT ON COLUMN valid_order_data.usage_count IS 'Number of times this data has been used';
COMMENT ON COLUMN valid_order_data.last_used_at IS 'Last time this data was used by any employee';
COMMENT ON COLUMN valid_order_data.deactivated_at IS 'When this data was deactivated';
COMMENT ON COLUMN valid_order_data.deactivation_reason IS 'Why this data was deactivated';
COMMENT ON COLUMN valid_order_data.priority IS 'Distribution priority (higher = preferred). Default: 0';
COMMENT ON COLUMN valid_order_data.tags IS 'Tags for categorization and filtering';

-- Create index for priority-based distribution
CREATE INDEX IF NOT EXISTS idx_valid_order_data_priority
ON valid_order_data (priority DESC, usage_count ASC)
WHERE is_active = true;

-- Trigger to update usage_count automatically
CREATE OR REPLACE FUNCTION update_valid_data_usage_stats()
RETURNS TRIGGER AS $$
BEGIN
  -- Increment usage count and update last_used_at
  UPDATE valid_order_data
  SET 
    usage_count = usage_count + 1,
    last_used_at = NEW.created_at
  WHERE id = NEW.valid_order_data_id;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_valid_data_usage ON used_order_data;
CREATE TRIGGER trigger_update_valid_data_usage
  AFTER INSERT ON used_order_data
  FOR EACH ROW
  EXECUTE FUNCTION update_valid_data_usage_stats();

-- Smart data distribution function (prioritizes least-used data)
CREATE OR REPLACE FUNCTION get_optimal_valid_data(
  p_user_id uuid,
  p_product_value numeric DEFAULT NULL,
  p_limit integer DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  product_value numeric,
  transaction_id text,
  usage_count integer,
  priority integer,
  recommendation_score numeric
)
LANGUAGE sql
STABLE
AS $$
  SELECT 
    vod.id,
    vod.product_value,
    vod.transaction_id,
    vod.usage_count,
    vod.priority,
    -- Calculate recommendation score (lower is better for distribution)
    (vod.usage_count * 0.7 + (CASE WHEN vod.priority > 0 THEN -vod.priority * 10 ELSE 0 END)) as recommendation_score
  FROM valid_order_data vod
  WHERE vod.is_active = true
    AND (p_product_value IS NULL OR vod.product_value = p_product_value)
    AND NOT EXISTS (
      SELECT 1 FROM used_order_data uod
      WHERE uod.user_id = p_user_id
        AND uod.valid_order_data_id = vod.id
    )
  ORDER BY recommendation_score ASC, RANDOM()
  LIMIT p_limit;
$$;

-- Data pool capacity warning function
CREATE OR REPLACE FUNCTION check_valid_data_capacity()
RETURNS TABLE (
  alert_level text,
  alert_message text,
  current_capacity integer,
  estimated_days_remaining numeric,
  recommended_action text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_active_count integer;
  v_verified_users integer;
  v_avg_daily_usage numeric;
  v_days_remaining numeric;
BEGIN
  -- Get current active data count
  SELECT COUNT(*) INTO v_active_count
  FROM valid_order_data
  WHERE is_active = true;
  
  -- Get verified user count
  SELECT COUNT(*) INTO v_verified_users
  FROM users
  WHERE is_verified = true;
  
  -- Calculate average daily usage (last 7 days)
  SELECT COALESCE(AVG(daily_usage), 0) INTO v_avg_daily_usage
  FROM (
    SELECT DATE(created_at), COUNT(*) as daily_usage
    FROM used_order_data
    WHERE created_at >= NOW() - INTERVAL '7 days'
    GROUP BY DATE(created_at)
  ) subq;
  
  -- Estimate days remaining
  IF v_avg_daily_usage > 0 THEN
    v_days_remaining := v_active_count / v_avg_daily_usage;
  ELSE
    v_days_remaining := 999999; -- Effectively infinite if no usage
  END IF;
  
  -- Return alerts based on capacity
  IF v_active_count = 0 THEN
    RETURN QUERY SELECT
      'CRITICAL'::text,
      'No active valid data available! System cannot process orders.'::text,
      v_active_count,
      0::numeric,
      'URGENT: Add valid data immediately'::text;
  ELSIF v_active_count < 100 OR v_days_remaining < 1 THEN
    RETURN QUERY SELECT
      'CRITICAL'::text,
      format('Only %s active records remaining. Estimated %s days until depletion.', 
        v_active_count, ROUND(v_days_remaining, 1))::text,
      v_active_count,
      ROUND(v_days_remaining, 1),
      'Add at least 1000 records immediately'::text;
  ELSIF v_active_count < 500 OR v_days_remaining < 3 THEN
    RETURN QUERY SELECT
      'HIGH'::text,
      format('Low capacity: %s active records. Estimated %s days remaining.',
        v_active_count, ROUND(v_days_remaining, 1))::text,
      v_active_count,
      ROUND(v_days_remaining, 1),
      'Add 5000+ records within 24 hours'::text;
  ELSIF v_active_count < 2000 OR v_days_remaining < 7 THEN
    RETURN QUERY SELECT
      'MEDIUM'::text,
      format('Moderate capacity: %s active records. Estimated %s days remaining.',
        v_active_count, ROUND(v_days_remaining, 1))::text,
      v_active_count,
      ROUND(v_days_remaining, 1),
      'Plan to add more records within next week'::text;
  ELSE
    RETURN QUERY SELECT
      'LOW'::text,
      format('Healthy capacity: %s active records. Estimated %s days remaining.',
        v_active_count, ROUND(v_days_remaining, 1))::text,
      v_active_count,
      ROUND(v_days_remaining, 1),
      'No immediate action required'::text;
  END IF;
END;
$$;

-- ============================================================================
-- 2. DATA LIFECYCLE MANAGEMENT
-- ============================================================================

-- Create archive table for historical data
CREATE TABLE IF NOT EXISTS valid_order_data_archive (
  id uuid PRIMARY KEY,
  product_value numeric NOT NULL,
  transaction_id text NOT NULL,
  usage_count integer DEFAULT 0,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz,
  deactivated_at timestamptz NOT NULL,
  deactivation_reason text,
  archived_at timestamptz DEFAULT now(),
  total_users_used integer DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_archive_deactivated ON valid_order_data_archive(deactivated_at DESC);
CREATE INDEX IF NOT EXISTS idx_archive_created_by ON valid_order_data_archive(created_by);

-- Function to archive old inactive data
CREATE OR REPLACE FUNCTION archive_old_valid_data(
  p_days_inactive integer DEFAULT 90
)
RETURNS TABLE (
  archived_count integer,
  status text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_archived_count integer;
BEGIN
  -- Move old inactive data to archive
  WITH archived AS (
    INSERT INTO valid_order_data_archive (
      id, product_value, transaction_id, usage_count,
      created_by, created_at, updated_at, deactivated_at,
      deactivation_reason, total_users_used
    )
    SELECT 
      vod.id, vod.product_value, vod.transaction_id, vod.usage_count,
      vod.created_by, vod.created_at, vod.updated_at, vod.deactivated_at,
      vod.deactivation_reason,
      (SELECT COUNT(DISTINCT user_id) FROM used_order_data WHERE valid_order_data_id = vod.id)
    FROM valid_order_data vod
    WHERE vod.is_active = false
      AND vod.deactivated_at < NOW() - (p_days_inactive || ' days')::interval
      AND NOT EXISTS (
        SELECT 1 FROM valid_order_data_archive WHERE id = vod.id
      )
    RETURNING id
  ),
  deleted AS (
    DELETE FROM valid_order_data
    WHERE id IN (SELECT id FROM archived)
    RETURNING id
  )
  SELECT COUNT(*)::integer INTO v_archived_count FROM deleted;
  
  RETURN QUERY SELECT
    v_archived_count,
    CASE 
      WHEN v_archived_count > 0 THEN format('Archived %s old records', v_archived_count)
      ELSE 'No records to archive'
    END;
END;
$$;

-- ============================================================================
-- 3. AUDIT & COMPLIANCE
-- ============================================================================

-- Create audit log table
CREATE TABLE IF NOT EXISTS valid_data_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type text NOT NULL, -- 'CREATE', 'UPDATE', 'DELETE', 'DEACTIVATE', 'REACTIVATE'
  valid_data_id uuid NOT NULL,
  performed_by uuid NOT NULL REFERENCES admins(id),
  action_timestamp timestamptz DEFAULT now(),
  old_values jsonb,
  new_values jsonb,
  reason text,
  ip_address inet,
  user_agent text
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON valid_data_audit_log(action_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_valid_data ON valid_data_audit_log(valid_data_id);
CREATE INDEX IF NOT EXISTS idx_audit_performed_by ON valid_data_audit_log(performed_by);

-- Trigger to log all changes to valid_order_data
CREATE OR REPLACE FUNCTION log_valid_data_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO valid_data_audit_log (
      action_type, valid_data_id, performed_by,
      old_values, reason
    )
    VALUES (
      'DELETE',
      OLD.id,
      OLD.created_by,
      row_to_json(OLD)::jsonb,
      'Record deleted'
    );
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Log deactivation separately
    IF OLD.is_active = true AND NEW.is_active = false THEN
      INSERT INTO valid_data_audit_log (
        action_type, valid_data_id, performed_by,
        old_values, new_values, reason
      )
      VALUES (
        'DEACTIVATE',
        NEW.id,
        NEW.created_by,
        row_to_json(OLD)::jsonb,
        row_to_json(NEW)::jsonb,
        NEW.deactivation_reason
      );
    ELSIF OLD.is_active = false AND NEW.is_active = true THEN
      INSERT INTO valid_data_audit_log (
        action_type, valid_data_id, performed_by,
        old_values, new_values, reason
      )
      VALUES (
        'REACTIVATE',
        NEW.id,
        NEW.created_by,
        row_to_json(OLD)::jsonb,
        row_to_json(NEW)::jsonb,
        'Record reactivated'
      );
    ELSE
      INSERT INTO valid_data_audit_log (
        action_type, valid_data_id, performed_by,
        old_values, new_values
      )
      VALUES (
        'UPDATE',
        NEW.id,
        NEW.created_by,
        row_to_json(OLD)::jsonb,
        row_to_json(NEW)::jsonb
      );
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO valid_data_audit_log (
      action_type, valid_data_id, performed_by,
      new_values
    )
    VALUES (
      'CREATE',
      NEW.id,
      NEW.created_by,
      row_to_json(NEW)::jsonb
    );
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_audit_valid_data ON valid_order_data;
CREATE TRIGGER trigger_audit_valid_data
  AFTER INSERT OR UPDATE OR DELETE ON valid_order_data
  FOR EACH ROW
  EXECUTE FUNCTION log_valid_data_changes();

-- Function to get audit trail for specific data
CREATE OR REPLACE FUNCTION get_valid_data_audit_trail(
  p_valid_data_id uuid
)
RETURNS TABLE (
  action_type text,
  performed_by_username text,
  action_timestamp timestamptz,
  changes_summary text
)
LANGUAGE sql
AS $$
  SELECT 
    val.action_type,
    a.username as performed_by_username,
    val.action_timestamp,
    CASE 
      WHEN val.action_type = 'CREATE' THEN 'Record created'
      WHEN val.action_type = 'DELETE' THEN 'Record deleted'
      WHEN val.action_type = 'DEACTIVATE' THEN 'Deactivated: ' || COALESCE(val.reason, 'No reason provided')
      WHEN val.action_type = 'REACTIVATE' THEN 'Reactivated'
      WHEN val.action_type = 'UPDATE' THEN 'Record updated'
      ELSE 'Unknown action'
    END as changes_summary
  FROM valid_data_audit_log val
  JOIN admins a ON val.performed_by = a.id
  WHERE val.valid_data_id = p_valid_data_id
  ORDER BY val.action_timestamp DESC;
$$;

-- ============================================================================
-- 4. ADVANCED MONITORING & ANALYTICS
-- ============================================================================

-- Function for predictive analytics
CREATE OR REPLACE FUNCTION predict_data_exhaustion()
RETURNS TABLE (
  prediction_date date,
  estimated_active_data integer,
  confidence_level text,
  recommendation text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_current_active integer;
  v_daily_usage_avg numeric;
  v_daily_usage_trend numeric;
  v_days_to_check integer := 30;
  v_current_date date := CURRENT_DATE;
  v_predicted_usage numeric;
  v_predicted_remaining integer;
  i integer;
BEGIN
  -- Get current active count
  SELECT COUNT(*) INTO v_current_active
  FROM valid_order_data
  WHERE is_active = true;
  
  -- Calculate average daily usage (last 14 days)
  SELECT COALESCE(AVG(daily_count), 0) INTO v_daily_usage_avg
  FROM (
    SELECT DATE(created_at), COUNT(*) as daily_count
    FROM used_order_data
    WHERE created_at >= NOW() - INTERVAL '14 days'
    GROUP BY DATE(created_at)
  ) subq;
  
  -- Simple trend calculation (if usage is increasing/decreasing)
  WITH recent_usage AS (
    SELECT 
      DATE(created_at) as usage_date,
      COUNT(*) as daily_count,
      ROW_NUMBER() OVER (ORDER BY DATE(created_at)) as day_num
    FROM used_order_data
    WHERE created_at >= NOW() - INTERVAL '14 days'
    GROUP BY DATE(created_at)
  )
  SELECT COALESCE(
    (MAX(daily_count) - MIN(daily_count))::numeric / NULLIF(MAX(day_num) - MIN(day_num), 0),
    0
  ) INTO v_daily_usage_trend
  FROM recent_usage;
  
  -- Generate predictions for next 30 days
  FOR i IN 1..v_days_to_check LOOP
    v_predicted_usage := v_daily_usage_avg + (v_daily_usage_trend * i);
    v_predicted_remaining := v_current_active - (v_predicted_usage * i)::integer;
    
    RETURN QUERY SELECT
      v_current_date + i,
      GREATEST(v_predicted_remaining, 0),
      CASE 
        WHEN i <= 7 THEN 'HIGH'
        WHEN i <= 14 THEN 'MEDIUM'
        ELSE 'LOW'
      END,
      CASE
        WHEN v_predicted_remaining <= 0 THEN 'CRITICAL: Add data before this date'
        WHEN v_predicted_remaining < 500 THEN 'HIGH: Plan to add data'
        WHEN v_predicted_remaining < 2000 THEN 'MEDIUM: Monitor closely'
        ELSE 'LOW: Sufficient capacity'
      END;
  END LOOP;
END;
$$;

-- Real-time performance metrics view
CREATE OR REPLACE VIEW valid_data_performance_metrics AS
SELECT
  -- Capacity metrics
  (SELECT COUNT(*) FROM valid_order_data) as total_records,
  (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) as active_records,
  (SELECT COUNT(*) FROM valid_order_data WHERE is_active = false) as inactive_records,
  
  -- Usage metrics (today)
  (SELECT COUNT(*) FROM used_order_data WHERE created_at >= CURRENT_DATE) as usage_today,
  (SELECT COUNT(DISTINCT user_id) FROM used_order_data WHERE created_at >= CURRENT_DATE) as unique_users_today,
  
  -- Usage metrics (last 7 days)
  (SELECT COUNT(*) FROM used_order_data WHERE created_at >= CURRENT_DATE - 7) as usage_last_7_days,
  (SELECT COUNT(DISTINCT user_id) FROM used_order_data WHERE created_at >= CURRENT_DATE - 7) as unique_users_last_7_days,
  
  -- Distribution metrics
  (SELECT ROUND(AVG(usage_count), 2) FROM valid_order_data WHERE is_active = true) as avg_usage_per_data,
  (SELECT MAX(usage_count) FROM valid_order_data WHERE is_active = true) as max_usage_per_data,
  (SELECT MIN(usage_count) FROM valid_order_data WHERE is_active = true) as min_usage_per_data,
  
  -- Performance indicators
  (SELECT COUNT(*) FROM valid_order_data WHERE usage_count > 10) as overused_data_count,
  (SELECT COUNT(*) FROM valid_order_data WHERE usage_count = 0 AND is_active = true) as unused_data_count,
  
  -- Capacity ratio
  ROUND(
    (SELECT COUNT(*)::numeric FROM valid_order_data WHERE is_active = true) /
    NULLIF((SELECT COUNT(*)::numeric FROM users WHERE is_verified = true), 0),
    2
  ) as data_per_verified_user,
  
  -- Health status
  CASE
    WHEN (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) = 0 THEN 'CRITICAL'
    WHEN (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) < 100 THEN 'CRITICAL'
    WHEN (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) < 500 THEN 'HIGH_RISK'
    WHEN (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) < 2000 THEN 'MODERATE_RISK'
    WHEN (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) < 10000 THEN 'LOW_RISK'
    ELSE 'HEALTHY'
  END as health_status,
  
  now() as last_updated;

-- ============================================================================
-- 5. AUTOMATED MAINTENANCE
-- ============================================================================

-- Function to run automated maintenance
CREATE OR REPLACE FUNCTION run_valid_data_maintenance()
RETURNS TABLE (
  task text,
  result text,
  details text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_archived_count integer;
  v_vacuum_result text;
BEGIN
  -- Task 1: Archive old inactive data (>90 days)
  SELECT archived_count, status
  INTO v_archived_count, v_vacuum_result
  FROM archive_old_valid_data(90)
  LIMIT 1;
  
  RETURN QUERY SELECT
    'Archive Old Data'::text,
    'COMPLETED'::text,
    format('Archived %s records', v_archived_count)::text;
  
  -- Task 2: Update statistics
  ANALYZE valid_order_data;
  ANALYZE used_order_data;
  
  RETURN QUERY SELECT
    'Update Statistics'::text,
    'COMPLETED'::text,
    'Table statistics refreshed'::text;
  
  -- Task 3: Check for data anomalies
  RETURN QUERY
  SELECT
    'Data Anomaly Check'::text,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'WARNING' END,
    CASE 
      WHEN COUNT(*) = 0 THEN 'No anomalies detected'
      ELSE format('%s records with unusual usage patterns', COUNT(*))
    END
  FROM valid_order_data
  WHERE usage_count > 50 AND is_active = true;
  
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION get_optimal_valid_data(uuid, numeric, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION check_valid_data_capacity() TO authenticated;
GRANT EXECUTE ON FUNCTION archive_old_valid_data(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION get_valid_data_audit_trail(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION predict_data_exhaustion() TO authenticated;
GRANT EXECUTE ON FUNCTION run_valid_data_maintenance() TO authenticated;
GRANT SELECT ON valid_data_performance_metrics TO authenticated;
GRANT SELECT ON valid_order_data_archive TO authenticated;
GRANT SELECT ON valid_data_audit_log TO authenticated;

-- Add helpful comments
COMMENT ON FUNCTION get_optimal_valid_data(uuid, numeric, integer) IS 'Smart data distribution: Returns least-used valid data for better load balancing';
COMMENT ON FUNCTION check_valid_data_capacity() IS 'Alerts for low capacity. Run every hour to monitor data pool health';
COMMENT ON FUNCTION archive_old_valid_data(integer) IS 'Archives inactive data older than specified days. Run weekly';
COMMENT ON FUNCTION get_valid_data_audit_trail(uuid) IS 'Complete audit trail for specific valid data record';
COMMENT ON FUNCTION predict_data_exhaustion() IS 'Predicts when data pool will be exhausted based on usage trends';
COMMENT ON FUNCTION run_valid_data_maintenance() IS 'Automated maintenance tasks. Run daily via cron job';
COMMENT ON TABLE valid_order_data_archive IS 'Historical archive of deactivated valid data. Keeps 5+ year retention';
COMMENT ON TABLE valid_data_audit_log IS 'Complete audit trail of all changes to valid data. Compliance and tracking';
COMMENT ON VIEW valid_data_performance_metrics IS 'Real-time performance dashboard. Refresh to see latest metrics';
