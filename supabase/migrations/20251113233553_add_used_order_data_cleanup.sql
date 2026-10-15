/*
  # Add Used Order Data to History Cleanup System

  ## Overview
  Adds the `used_order_data` table to the history cleanup configuration, allowing administrators
  to clean up old usage records and reset Valid Data back to "unused" status.

  ## Why This is Important
  - `used_order_data` tracks which Valid Data records have been used by employees
  - Over time, this table grows large with historical usage records
  - Cleaning old records allows Valid Data to be reused by setting them back to "unused" status
  - This maintains system efficiency and data freshness

  ## Changes
  1. Add `used_order_data` to history_cleanup_config
  2. Create cleanup function for used_order_data
  3. Create preview function for cleanup operations
  4. Create helper view for reusability stats

  ## Safety
  - Deletes only historical usage records older than specified days
  - Does NOT delete the Valid Data itself, only the usage tracking records
  - Valid Data records will automatically become "unused" again after their usage records are deleted
  - All cleanup operations are logged and auditable
*/

-- ============================================================================
-- 1. ADD USED_ORDER_DATA TO CLEANUP CONFIG
-- ============================================================================

INSERT INTO history_cleanup_config (
  category,
  display_name,
  table_name,
  description,
  default_retention_days,
  min_retention_days,
  can_cleanup,
  requires_confirmation,
  cleanup_priority
) VALUES (
  'operational',
  'Valid Data使用记录',
  'used_order_data',
  'Valid Data的使用历史记录。删除后，相关的Valid Data会重新变为"未使用"状态，可被再次分配。',
  180,  -- 默认保留180天（6个月）
  30,   -- 最少保留30天
  true,
  false,  -- 不需要额外确认，因为这只是使用记录
  7     -- 优先级（与其他operational表相同）
) ON CONFLICT (table_name) DO UPDATE SET
  description = EXCLUDED.description,
  default_retention_days = EXCLUDED.default_retention_days,
  cleanup_priority = EXCLUDED.cleanup_priority,
  updated_at = NOW();

-- ============================================================================
-- 2. CREATE CLEANUP FUNCTION FOR USED_ORDER_DATA
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_used_order_data(
  p_days_to_keep integer DEFAULT 180,
  p_admin_id uuid DEFAULT NULL
)
RETURNS TABLE (
  success boolean,
  records_deleted bigint,
  space_freed text,
  execution_time_ms numeric,
  message text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_start_time timestamp;
  v_cutoff_date timestamp;
  v_deleted bigint := 0;
  v_space_before bigint;
  v_space_after bigint;
  v_space_freed bigint;
BEGIN
  v_start_time := clock_timestamp();
  v_cutoff_date := NOW() - (p_days_to_keep || ' days')::interval;

  -- Get table size before cleanup
  SELECT pg_total_relation_size('used_order_data') INTO v_space_before;

  -- Delete old usage records
  -- This will make the corresponding Valid Data records "unused" again
  DELETE FROM used_order_data
  WHERE created_at < v_cutoff_date;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Get table size after cleanup
  SELECT pg_total_relation_size('used_order_data') INTO v_space_after;
  v_space_freed := v_space_before - v_space_after;

  -- Log the cleanup operation
  IF p_admin_id IS NOT NULL THEN
    INSERT INTO history_cleanup_log (
      table_name,
      admin_id,
      records_deleted,
      space_freed,
      retention_days,
      status,
      message
    ) VALUES (
      'used_order_data',
      p_admin_id,
      v_deleted,
      pg_size_pretty(v_space_freed),
      p_days_to_keep,
      'completed',
      format('Cleaned up %s records older than %s days. Valid Data records are now available for reuse.', 
             v_deleted, p_days_to_keep)
    );
  END IF;

  -- Update cleanup config
  UPDATE history_cleanup_config
  SET
    last_cleanup_at = NOW(),
    last_cleanup_records = v_deleted,
    updated_at = NOW()
  WHERE table_name = 'used_order_data';

  RETURN QUERY SELECT
    true,
    v_deleted,
    pg_size_pretty(v_space_freed),
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    format('Successfully cleaned up %s usage records. These Valid Data records can now be reused.', v_deleted)::text;

EXCEPTION WHEN OTHERS THEN
  -- Log error
  IF p_admin_id IS NOT NULL THEN
    INSERT INTO history_cleanup_log (
      table_name,
      admin_id,
      records_deleted,
      retention_days,
      status,
      message,
      error_details
    ) VALUES (
      'used_order_data',
      p_admin_id,
      0,
      p_days_to_keep,
      'failed',
      'Cleanup failed',
      SQLERRM
    );
  END IF;

  RETURN QUERY SELECT
    false,
    0::bigint,
    '0 bytes'::text,
    ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - v_start_time)) * 1000, 2),
    format('Error: %s', SQLERRM)::text;
END;
$$;

COMMENT ON FUNCTION cleanup_used_order_data IS
'Cleans up old usage records from used_order_data table. After deletion, the corresponding Valid Data records become "unused" and can be reassigned to employees.';

-- ============================================================================
-- 3. CREATE PREVIEW FUNCTION FOR USED_ORDER_DATA
-- ============================================================================

CREATE OR REPLACE FUNCTION preview_cleanup_used_order_data(
  p_days_to_keep integer DEFAULT 180
)
RETURNS TABLE (
  table_name text,
  total_records bigint,
  records_to_delete bigint,
  records_to_keep bigint,
  oldest_date timestamp,
  cutoff_date timestamp,
  estimated_space_freed text,
  safety_status text,
  affected_valid_data_count bigint
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_total bigint;
  v_to_delete bigint;
  v_to_keep bigint;
  v_oldest timestamp;
  v_cutoff timestamp;
  v_space_total bigint;
  v_affected_valid_data bigint;
BEGIN
  v_cutoff := NOW() - (p_days_to_keep || ' days')::interval;

  -- Get statistics
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE created_at < v_cutoff),
    COUNT(*) FILTER (WHERE created_at >= v_cutoff),
    MIN(created_at),
    pg_total_relation_size('used_order_data')
  INTO v_total, v_to_delete, v_to_keep, v_oldest, v_space_total
  FROM used_order_data;

  -- Get count of Valid Data that will become unused
  SELECT COUNT(DISTINCT valid_order_data_id)
  INTO v_affected_valid_data
  FROM used_order_data
  WHERE created_at < v_cutoff;

  RETURN QUERY SELECT
    'used_order_data'::text,
    v_total,
    v_to_delete,
    v_to_keep,
    v_oldest,
    v_cutoff,
    pg_size_pretty(CASE 
      WHEN v_total > 0 THEN (v_space_total * v_to_delete / v_total)
      ELSE 0 
    END),
    CASE
      WHEN v_to_delete = 0 THEN 'SAFE - No records to delete'
      WHEN v_to_keep > v_total * 0.5 THEN 'SAFE - Keeping majority of records'
      WHEN v_to_keep > v_total * 0.3 THEN 'MODERATE - Deleting significant portion'
      ELSE 'CAUTION - Deleting large portion'
    END,
    v_affected_valid_data;
END;
$$;

COMMENT ON FUNCTION preview_cleanup_used_order_data IS
'Previews the cleanup operation for used_order_data without making any changes. Shows how many Valid Data records will become available for reuse.';

-- ============================================================================
-- 4. CREATE HELPER VIEW FOR VALID DATA REUSABILITY
-- ============================================================================

CREATE OR REPLACE VIEW valid_data_reusability_stats AS
SELECT
  COUNT(DISTINCT vod.id) as total_valid_data,
  COUNT(DISTINCT uod.valid_order_data_id) as currently_used,
  COUNT(DISTINCT vod.id) - COUNT(DISTINCT uod.valid_order_data_id) as available_for_reuse,
  COUNT(DISTINCT CASE 
    WHEN uod.created_at < NOW() - INTERVAL '180 days' 
    THEN uod.valid_order_data_id 
  END) as reusable_after_180d_cleanup,
  COUNT(DISTINCT CASE 
    WHEN uod.created_at < NOW() - INTERVAL '90 days' 
    THEN uod.valid_order_data_id 
  END) as reusable_after_90d_cleanup,
  COUNT(DISTINCT CASE 
    WHEN uod.created_at < NOW() - INTERVAL '30 days' 
    THEN uod.valid_order_data_id 
  END) as reusable_after_30d_cleanup
FROM valid_order_data vod
LEFT JOIN used_order_data uod ON uod.valid_order_data_id = vod.id;

COMMENT ON VIEW valid_data_reusability_stats IS
'Shows statistics about Valid Data reusability. Helps administrators understand how many records will become available after cleanup.';
