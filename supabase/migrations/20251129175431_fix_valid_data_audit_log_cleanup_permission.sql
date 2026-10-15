/*
  # Fix valid_data_audit_log Cleanup Permission and Retention Configuration

  ## Problem
  1. The `valid_data_audit_log` table has `can_cleanup = false` in the history_cleanup_config table,
     causing auto cleanup to fail with "Table not found or cleanup not allowed" error.
  2. The retention days are dangerously short (min: 1 day, default: 3 days) which could
     result in losing critical audit trails too quickly.

  ## Solution
  1. Enable cleanup for valid_data_audit_log table by setting can_cleanup = true.
  2. Fix retention days to safe values:
     - min_retention_days: 30 days (industry standard for audit logs)
     - default_retention_days: 90 days (matching other audit logs)

  ## Impact
  - Allows auto cleanup service to clean up old audit log records
  - Fixes the failed cleanup attempts shown in the cleanup history
  - Ensures audit logs are retained for a reasonable period for compliance
*/

-- Enable cleanup and fix retention days for valid_data_audit_log
UPDATE history_cleanup_config
SET can_cleanup = true,
    min_retention_days = 30,
    default_retention_days = 90,
    updated_at = NOW()
WHERE table_name = 'valid_data_audit_log';

COMMENT ON TABLE history_cleanup_config IS 
'Configuration for historical data cleanup. All tables should have can_cleanup = true unless there is a specific security or compliance reason to prevent cleanup.';
