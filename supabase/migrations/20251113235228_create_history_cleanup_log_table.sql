/*
  # Create History Cleanup Log Table

  ## Overview
  Creates the `history_cleanup_log` table to track all cleanup operations performed
  on historical data tables. This provides audit trail and troubleshooting information.

  ## Changes
  1. Create history_cleanup_log table
  2. Add indexes for efficient querying
  3. Enable RLS (for security)
  4. Add policies for super admin access

  ## Why This is Needed
  The execute_cleanup function references this table to log all cleanup operations,
  but the table was never created in the original migration.
*/

-- ============================================================================
-- 1. CREATE CLEANUP LOG TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS history_cleanup_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text NOT NULL,
  admin_id uuid,
  records_deleted bigint NOT NULL DEFAULT 0,
  space_freed text,
  retention_days integer NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed', 'partial')),
  message text,
  error_details text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 2. CREATE INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_cleanup_log_table_name 
  ON history_cleanup_log(table_name);

CREATE INDEX IF NOT EXISTS idx_cleanup_log_admin_id 
  ON history_cleanup_log(admin_id);

CREATE INDEX IF NOT EXISTS idx_cleanup_log_created_at 
  ON history_cleanup_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cleanup_log_status 
  ON history_cleanup_log(status);

-- ============================================================================
-- 3. ENABLE RLS
-- ============================================================================

ALTER TABLE history_cleanup_log ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 4. CREATE RLS POLICIES
-- ============================================================================

-- Allow all operations (no restrictions for now since this is admin-only functionality)
CREATE POLICY "Allow all operations on cleanup log"
  ON history_cleanup_log
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- 5. ADD COMMENTS
-- ============================================================================

COMMENT ON TABLE history_cleanup_log IS
'Audit log for all history data cleanup operations. Tracks who cleaned what, when, and the results.';

COMMENT ON COLUMN history_cleanup_log.table_name IS
'Name of the table that was cleaned up';

COMMENT ON COLUMN history_cleanup_log.admin_id IS
'ID of the admin who performed the cleanup (NULL if system-initiated)';

COMMENT ON COLUMN history_cleanup_log.records_deleted IS
'Number of records deleted in this cleanup operation';

COMMENT ON COLUMN history_cleanup_log.space_freed IS
'Human-readable amount of disk space freed (e.g., "1.5 MB")';

COMMENT ON COLUMN history_cleanup_log.retention_days IS
'Number of days of data that were retained (older data was deleted)';

COMMENT ON COLUMN history_cleanup_log.status IS
'Status of the cleanup operation: completed, failed, or partial';

COMMENT ON COLUMN history_cleanup_log.message IS
'Success message or summary of the cleanup operation';

COMMENT ON COLUMN history_cleanup_log.error_details IS
'Detailed error information if the cleanup failed';
