/*
  # Emergency cleanup for bloated audit logs

  1. Problem
    - valid_data_audit_log: 218,695 rows (134 MB) → ALL QUERIES TIMING OUT
    - System unusable due to statement timeouts
    
  2. Solution
    - Emergency cleanup: keep only last 3 days
    - Add performance indexes
    - Update statistics
    
  3. Impact
    - Reduces table to ~30k rows
    - Query time: 2min+ → seconds
    - System becomes usable again
*/

-- Step 1: Create index for faster cleanup
CREATE INDEX IF NOT EXISTS idx_valid_data_audit_log_timestamp 
ON valid_data_audit_log(action_timestamp DESC);

-- Step 2: Emergency batch delete (keep last 3 days only)
DO $$
DECLARE
  v_deleted integer;
  v_total integer := 0;
  v_cutoff timestamptz := NOW() - INTERVAL '3 days';
BEGIN
  RAISE NOTICE 'Starting emergency cleanup of valid_data_audit_log...';
  RAISE NOTICE 'Cutoff date: %', v_cutoff;
  
  LOOP
    -- Delete in small batches to avoid locks
    DELETE FROM valid_data_audit_log 
    WHERE ctid IN (
      SELECT ctid 
      FROM valid_data_audit_log
      WHERE action_timestamp < v_cutoff
      LIMIT 10000
    );
    
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    v_total := v_total + v_deleted;
    
    EXIT WHEN v_deleted = 0;
    
    RAISE NOTICE 'Deleted % rows (total: %)', v_deleted, v_total;
    
    -- Breathe between batches
    PERFORM pg_sleep(0.05);
  END LOOP;
  
  RAISE NOTICE 'Emergency cleanup complete. Total deleted: % rows', v_total;
END $$;

-- Step 3: Update statistics immediately
ANALYZE valid_data_audit_log;

-- Step 4: Update retention policy
UPDATE history_cleanup_config
SET 
  min_retention_days = 1,
  default_retention_days = 3,
  description = 'Audit log (EMERGENCY: 3-day retention - 200k+ rows in 10 days)',
  updated_at = NOW()
WHERE table_name = 'valid_data_audit_log';

-- Step 5: Check final size
DO $$
DECLARE
  v_count bigint;
  v_size text;
BEGIN
  SELECT COUNT(*) INTO v_count FROM valid_data_audit_log;
  SELECT pg_size_pretty(pg_total_relation_size('valid_data_audit_log')) INTO v_size;
  RAISE NOTICE 'After cleanup: % rows, %', v_count, v_size;
END $$;