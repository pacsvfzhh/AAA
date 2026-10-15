/*
  # Add Valid Data Statistics Views and Functions

  ## Overview
  This migration adds comprehensive statistics views and functions for monitoring
  the Valid Order Data system usage, trends, and health.

  ## New Views
  1. `valid_data_usage_stats` - Overall usage statistics
  2. `valid_data_by_value` - Statistics grouped by product value
  3. `valid_data_usage_trend` - Daily usage trends (last 30 days)

  ## Benefits
  - Real-time visibility into data pool health
  - Usage pattern analysis
  - Capacity planning support
  - Performance monitoring
*/

-- ============================================================================
-- 1. OVERALL USAGE STATISTICS VIEW
-- ============================================================================

CREATE OR REPLACE VIEW valid_data_usage_stats AS
SELECT
  COUNT(*)::bigint as total_records,
  COUNT(*) FILTER (WHERE is_active = true)::bigint as active_records,
  COUNT(*) FILTER (WHERE is_active = false)::bigint as inactive_records,
  COUNT(DISTINCT uod.valid_order_data_id)::bigint as used_records,
  (COUNT(*) - COUNT(DISTINCT uod.valid_order_data_id))::bigint as unused_records,
  COALESCE(SUM(usage_count), 0)::bigint as total_usage,
  ROUND(AVG(usage_count)::numeric, 2) as avg_usage_per_record,
  MAX(usage_count) as max_usage,
  COUNT(DISTINCT created_by)::integer as admin_count,
  COUNT(*) FILTER (WHERE last_used_at > NOW() - INTERVAL '24 hours')::bigint as used_last_24h,
  COUNT(*) FILTER (WHERE last_used_at > NOW() - INTERVAL '7 days')::bigint as used_last_7d,
  COUNT(*) FILTER (WHERE usage_count = 0 OR usage_count IS NULL)::bigint as never_used
FROM valid_order_data
LEFT JOIN used_order_data uod ON uod.valid_order_data_id = valid_order_data.id;

COMMENT ON VIEW valid_data_usage_stats IS
'Provides comprehensive statistics about the valid order data pool usage';

-- ============================================================================
-- 2. STATISTICS BY PRODUCT VALUE
-- ============================================================================

CREATE OR REPLACE VIEW valid_data_by_value AS
SELECT
  product_value,
  COUNT(*)::bigint as total_count,
  COUNT(*) FILTER (WHERE is_active = true)::bigint as active_count,
  COUNT(*) FILTER (WHERE is_active = false)::bigint as inactive_count,
  COALESCE(SUM(usage_count), 0)::bigint as total_usage,
  ROUND(AVG(usage_count)::numeric, 2) as avg_usage,
  MAX(usage_count) as max_usage,
  COUNT(DISTINCT uod.valid_order_data_id)::bigint as unique_users
FROM valid_order_data
LEFT JOIN used_order_data uod ON uod.valid_order_data_id = valid_order_data.id
GROUP BY product_value
ORDER BY product_value;

COMMENT ON VIEW valid_data_by_value IS
'Shows valid data statistics grouped by product value';

-- ============================================================================
-- 3. USAGE TREND VIEW (LAST 30 DAYS)
-- ============================================================================

CREATE OR REPLACE VIEW valid_data_usage_trend AS
SELECT
  DATE_TRUNC('day', created_at)::date as date,
  COUNT(*)::bigint as records_created,
  COALESCE(SUM(usage_count), 0)::bigint as times_used,
  COUNT(*) FILTER (WHERE is_active = true)::bigint as active_on_date,
  COUNT(DISTINCT created_by) as admins_active
FROM valid_order_data
WHERE created_at >= NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', created_at)
ORDER BY date DESC;

COMMENT ON VIEW valid_data_usage_trend IS
'Shows daily trends of valid data creation and usage for the last 30 days';

-- ============================================================================
-- 4. HELPER FUNCTION FOR DETAILED STATISTICS
-- ============================================================================

CREATE OR REPLACE FUNCTION get_detailed_valid_data_stats(
  p_days integer DEFAULT 7
)
RETURNS TABLE (
  metric_name text,
  metric_value numeric,
  metric_description text
)
LANGUAGE sql
STABLE
AS $$
  -- Basic counts
  SELECT 'total_records'::text, COUNT(*)::numeric, 'Total valid order data records'::text
  FROM valid_order_data
  
  UNION ALL
  
  SELECT 'active_records', COUNT(*)::numeric, 'Currently active records'
  FROM valid_order_data WHERE is_active = true
  
  UNION ALL
  
  SELECT 'inactive_records', COUNT(*)::numeric, 'Currently inactive records'
  FROM valid_order_data WHERE is_active = false
  
  UNION ALL
  
  -- Usage metrics
  SELECT 'total_usages', COALESCE(SUM(usage_count), 0)::numeric, 'Total times data has been used'
  FROM valid_order_data
  
  UNION ALL
  
  SELECT 'avg_usage_per_record', ROUND(AVG(usage_count)::numeric, 2), 'Average usage count per record'
  FROM valid_order_data WHERE usage_count > 0
  
  UNION ALL
  
  SELECT 'max_usage', MAX(usage_count)::numeric, 'Maximum usage count for a single record'
  FROM valid_order_data
  
  UNION ALL
  
  SELECT 'never_used', COUNT(*)::numeric, 'Records that have never been used'
  FROM valid_order_data WHERE usage_count = 0 OR usage_count IS NULL
  
  UNION ALL
  
  -- Recent activity
  SELECT 'used_last_24h', COUNT(*)::numeric, 'Records used in last 24 hours'
  FROM valid_order_data WHERE last_used_at > NOW() - INTERVAL '24 hours'
  
  UNION ALL
  
  SELECT 'used_last_7d', COUNT(*)::numeric, 'Records used in last 7 days'
  FROM valid_order_data WHERE last_used_at > NOW() - INTERVAL '7 days'
  
  UNION ALL
  
  SELECT 'created_today', COUNT(*)::numeric, 'Records created today'
  FROM valid_order_data WHERE created_at >= CURRENT_DATE
  
  UNION ALL
  
  -- Admin activity
  SELECT 'unique_admins', COUNT(DISTINCT created_by)::numeric, 'Number of admins who created data'
  FROM valid_order_data
  
  ORDER BY 1;
$$;

COMMENT ON FUNCTION get_detailed_valid_data_stats IS
'Returns detailed statistics about the valid order data system in a structured format';
