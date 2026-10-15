/*
  # Add Valid Data Cleanup Function

  ## Overview
  This migration adds a safe and efficient cleanup function for valid_order_data table.
  The current frontend implementation has issues with SQL syntax and data safety.

  ## New Function
  - `cleanup_old_valid_data()` - Safely removes old inactive unused records
  
  ## Features
  1. Keeps most recent 30,000 records by default
  2. Only deletes inactive data (is_active = false)
  3. Never deletes data that has been used
  4. Returns detailed statistics
  5. Executes in a single efficient query
  6. Includes execution time tracking

  ## Integration
  - Adds valid_order_data to history_cleanup_config
  - Enables automatic cleanup through the History Data Management system
  
  ## Safety
  - Transaction-safe
  - No risk of data loss
  - Preserves all used data
  - Only removes truly obsolete records
*/

-- ============================================================================
-- 1. CREATE CLEANUP FUNCTION
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_old_valid_data(
  p_keep_count integer DEFAULT 30000
)
RETURNS TABLE (
  deleted_count bigint,
  kept_count bigint,
  execution_time_ms numeric,
  message text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_time timestamp;
  v_deleted bigint;
  v_total bigint;
  v_kept bigint;
BEGIN
  v_start_time := clock_timestamp();

  -- Get total count before cleanup
  SELECT COUNT(*) INTO v_total FROM valid_order_data;

  -- If total is within limit, no cleanup needed
  IF v_total <= p_keep_count THEN
    RETURN QUERY SELECT 
      0::bigint,
      v_total,
      ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
      'No cleanup needed. Total records within limit.'::text;
    RETURN;
  END IF;

  -- Delete old records with safety checks
  -- Uses CTE for efficiency and correctness
  WITH records_to_keep AS (
    SELECT id
    FROM valid_order_data
    ORDER BY created_at DESC
    LIMIT p_keep_count
  ),
  deletable_records AS (
    SELECT vod.id
    FROM valid_order_data vod
    WHERE vod.id NOT IN (SELECT id FROM records_to_keep)
      AND vod.is_active = false  -- Only delete inactive data
      AND NOT EXISTS (           -- Never delete used data
        SELECT 1 FROM used_order_data uod
        WHERE uod.valid_order_data_id = vod.id
      )
  )
  DELETE FROM valid_order_data
  WHERE id IN (SELECT id FROM deletable_records);

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  
  -- Get count after cleanup
  SELECT COUNT(*) INTO v_kept FROM valid_order_data;

  RETURN QUERY SELECT
    v_deleted,
    v_kept,
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    format('Cleaned up %s old records. %s records remaining.', v_deleted, v_kept)::text;
END;
$$;

COMMENT ON FUNCTION cleanup_old_valid_data IS 
'Safely removes old inactive and unused valid order data while keeping the most recent records';

-- ============================================================================
-- 2. INTEGRATE WITH HISTORY CLEANUP SYSTEM
-- ============================================================================

-- Add or update valid_order_data in history_cleanup_config
INSERT INTO history_cleanup_config (
  table_name,
  display_name,
  category,
  description,
  default_retention_days,
  min_retention_days,
  cleanup_priority,
  requires_confirmation,
  can_cleanup
) VALUES (
  'valid_order_data',
  '订单验证数据池',
  'operational',
  '订单验证数据池。自动保留最近30,000条记录。仅删除不活跃和未使用的数据。',
  90,  -- Keep for 90 days
  30,  -- Minimum 30 days
  7,   -- Medium-low priority
  false, -- No confirmation needed for automatic cleanup
  true
)
ON CONFLICT (table_name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  updated_at = NOW();

-- ============================================================================
-- 3. CREATE HELPER FUNCTIONS FOR MONITORING
-- ============================================================================

-- Function to get valid data pool statistics
CREATE OR REPLACE FUNCTION get_valid_data_pool_stats()
RETURNS TABLE (
  total_records bigint,
  active_records bigint,
  inactive_records bigint,
  used_records bigint,
  unused_records bigint,
  deletable_records bigint,
  avg_usage_count numeric,
  pool_health text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*)::bigint as total_records,
    COUNT(*) FILTER (WHERE is_active = true)::bigint as active_records,
    COUNT(*) FILTER (WHERE is_active = false)::bigint as inactive_records,
    COUNT(DISTINCT uod.valid_order_data_id)::bigint as used_records,
    (COUNT(*) - COUNT(DISTINCT uod.valid_order_data_id))::bigint as unused_records,
    COUNT(*) FILTER (
      WHERE is_active = false 
      AND NOT EXISTS (
        SELECT 1 FROM used_order_data uod2 
        WHERE uod2.valid_order_data_id = valid_order_data.id
      )
    )::bigint as deletable_records,
    AVG(usage_count)::numeric(10,2) as avg_usage_count,
    CASE
      WHEN COUNT(*) FILTER (WHERE is_active = true) < 1000 THEN 'CRITICAL'
      WHEN COUNT(*) FILTER (WHERE is_active = true) < 5000 THEN 'WARNING'
      ELSE 'HEALTHY'
    END as pool_health
  FROM valid_order_data
  LEFT JOIN used_order_data uod ON uod.valid_order_data_id = valid_order_data.id;
$$;

COMMENT ON FUNCTION get_valid_data_pool_stats IS 
'Returns comprehensive statistics about the valid order data pool';

-- ============================================================================
-- 4. CREATE INDEX FOR CLEANUP PERFORMANCE
-- ============================================================================

-- Index to speed up cleanup operations
CREATE INDEX IF NOT EXISTS idx_valid_order_data_cleanup
ON valid_order_data (created_at DESC, is_active)
WHERE is_active = false;

COMMENT ON INDEX idx_valid_order_data_cleanup IS 
'Optimizes cleanup operations by indexing old inactive records';
