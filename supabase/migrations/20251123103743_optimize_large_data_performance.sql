/*
  # Optimize performance for large data volumes

  1. Problem
    - valid_order_data: 118,957 rows (32 MB) - queries taking 892ms
    - Sequential scans causing slow performance
    
  2. Root Cause
    - Missing composite index for query pattern
    - Query: WHERE is_active = true ORDER BY priority DESC, created_at ASC
    
  3. Solution
    - Add composite index matching exact query pattern
    - Add partial index for active records only
    
  4. Expected Impact
    - Query time: 892ms → <50ms (18x faster)
*/

-- Step 1: Drop old partial indexes that may conflict
DROP INDEX IF EXISTS idx_valid_order_data_cleanup;

-- Step 2: Create optimal composite index for valid_order_data queries
CREATE INDEX IF NOT EXISTS idx_valid_order_data_active_priority_created 
ON valid_order_data (priority DESC, created_at ASC)
WHERE is_active = true;

-- Step 3: Create index for faster usage tracking
CREATE INDEX IF NOT EXISTS idx_valid_order_data_usage_cleanup
ON valid_order_data (usage_count, last_used_at)
WHERE usage_count > 0;

-- Step 4: Update statistics
ANALYZE valid_order_data;
ANALYZE dispatch_group_orders;
ANALYZE used_order_data;

-- Step 5: Verify optimization
DO $$
DECLARE
  v_table_size text;
  v_index_size text;
  v_row_count bigint;
BEGIN
  SELECT 
    pg_size_pretty(pg_total_relation_size('valid_order_data')),
    pg_size_pretty(pg_indexes_size('valid_order_data')),
    COUNT(*)
  INTO v_table_size, v_index_size, v_row_count
  FROM valid_order_data;
  
  RAISE NOTICE 'Optimization complete:';
  RAISE NOTICE '  Table size: %', v_table_size;
  RAISE NOTICE '  Index size: %', v_index_size;
  RAISE NOTICE '  Row count: %', v_row_count;
END $$;