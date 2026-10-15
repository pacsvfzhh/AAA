/*
  # Increase Valid Data Pool Limit to 500,000

  ## Overview
  This migration increases the maximum capacity of the valid_order_data pool from 30,000 to 500,000 records.

  ## Changes
  1. Update cleanup_old_valid_data function default parameter from 30,000 to 500,000
  2. Update description in history_cleanup_config
  3. Update pool health thresholds for larger capacity
  4. All safety mechanisms remain in place

  ## Rationale
  - Support for larger scale operations
  - Accommodate more concurrent users and higher transaction volume
  - Maintain same safety and cleanup principles
  - Better performance for high-volume periods

  ## Safety
  - No data loss risk
  - All existing data preserved
  - Cleanup logic unchanged, only capacity increased
*/

-- ============================================================================
-- 1. UPDATE CLEANUP FUNCTION WITH NEW DEFAULT LIMIT
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_old_valid_data(
  p_keep_count integer DEFAULT 500000
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
'Safely removes old inactive and unused valid order data while keeping the most recent records. Default capacity: 500,000 records.';

-- ============================================================================
-- 2. UPDATE HISTORY CLEANUP CONFIG DESCRIPTION
-- ============================================================================

UPDATE history_cleanup_config
SET
  description = '订单验证数据池。自动保留最近500,000条记录。仅删除不活跃和未使用的数据。',
  updated_at = NOW()
WHERE table_name = 'valid_order_data';

-- ============================================================================
-- 3. UPDATE POOL HEALTH MONITORING FOR LARGER CAPACITY
-- ============================================================================

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
      WHEN COUNT(*) FILTER (WHERE is_active = true) < 10000 THEN 'CRITICAL'
      WHEN COUNT(*) FILTER (WHERE is_active = true) < 50000 THEN 'WARNING'
      ELSE 'HEALTHY'
    END as pool_health
  FROM valid_order_data
  LEFT JOIN used_order_data uod ON uod.valid_order_data_id = valid_order_data.id;
$$;

COMMENT ON FUNCTION get_valid_data_pool_stats IS
'Returns comprehensive statistics about the valid order data pool. Health thresholds adjusted for 500K capacity.';
