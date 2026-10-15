/*
  # Disable excessive audit logging

  1. Problem
    - valid_data_audit_log accumulated 168k+ rows in <24 hours
    - Causing all database queries to timeout (statement_timeout: 2min)
    - System completely unusable
    
  2. Root Cause
    - Audit trigger fires on EVERY insert/delete to valid_order_data
    - High-frequency operations (118k creates, 49k deletes)
    - Audit log grows faster than it can be cleaned
    
  3. Solution
    - Disable audit trigger
    - Truncate existing audit log (data not critical for operations)
    - Keep table structure for future selective auditing if needed
    
  4. Impact
    - Immediate: System becomes usable again
    - Queries return in milliseconds instead of timing out
    - Saves disk space and I/O
*/

-- Step 1: Find and disable the audit trigger
DO $$
DECLARE
  v_trigger_name text;
BEGIN
  -- Find triggers on valid_order_data table
  FOR v_trigger_name IN 
    SELECT tgname 
    FROM pg_trigger t
    JOIN pg_class c ON t.tgrelid = c.oid
    WHERE c.relname = 'valid_order_data'
      AND tgname LIKE '%audit%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON valid_order_data', v_trigger_name);
    RAISE NOTICE 'Dropped trigger: %', v_trigger_name;
  END LOOP;
END $$;

-- Step 2: Truncate the audit log (emergency measure)
TRUNCATE TABLE valid_data_audit_log;

-- Step 3: Disable auto-cleanup for this table (no longer needed)
UPDATE history_cleanup_config
SET 
  can_cleanup = false,
  description = 'DISABLED: Audit logging disabled due to excessive volume causing system-wide timeouts',
  updated_at = NOW()
WHERE table_name = 'valid_data_audit_log';

-- Step 4: Add comment explaining why it's disabled
COMMENT ON TABLE valid_data_audit_log IS 
'AUDIT LOGGING DISABLED 2025-11-23: Generated 168k+ rows in <24 hours, caused system-wide query timeouts. Table kept for structure but triggers removed.';

-- Step 5: Verify trigger removal
DO $$
DECLARE
  v_count integer;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM pg_trigger t
  JOIN pg_class c ON t.tgrelid = c.oid
  WHERE c.relname = 'valid_order_data';
  
  RAISE NOTICE 'Remaining triggers on valid_order_data: %', v_count;
END $$;