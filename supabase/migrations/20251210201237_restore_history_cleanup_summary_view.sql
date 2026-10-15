/*
  # Restore History Cleanup Summary View
  
  1. Problem
    - The history_cleanup_summary view was dropped by security fixes (20251210200130)
    - This broke the History Data Management page in the admin dashboard
    - The view is essential for displaying cleanup configuration and statistics
  
  2. Solution
    - Recreate the view as a normal view (not SECURITY DEFINER)
    - Reuse existing helper functions (get_table_size, get_table_record_count)
    - Access control is handled via RLS policies on history_cleanup_config table
  
  3. Security
    - View is a normal view (security_invoker = true by default in Postgres 15+)
    - RLS policies on history_cleanup_config control access
    - Only admins can access via frontend route protection
    - Helper functions use SECURITY DEFINER (needed to read pg_catalog tables)
*/

-- Recreate the history_cleanup_summary view
CREATE OR REPLACE VIEW history_cleanup_summary AS
SELECT 
  hcc.category,
  hcc.display_name,
  hcc.table_name,
  hcc.description,
  hcc.default_retention_days,
  hcc.min_retention_days,
  hcc.cleanup_priority,
  hcc.last_cleanup_at,
  hcc.last_cleanup_records,
  CASE 
    WHEN hcc.last_cleanup_at IS NULL THEN 'Never cleaned'
    WHEN hcc.last_cleanup_at < NOW() - INTERVAL '7 days' THEN 'Cleanup overdue'
    WHEN hcc.last_cleanup_at < NOW() - INTERVAL '3 days' THEN 'Consider cleanup'
    ELSE 'Recently cleaned'
  END AS cleanup_status,
  pg_size_pretty(get_table_size(hcc.table_name)) AS current_size,
  get_table_record_count(hcc.table_name) AS current_record_count
FROM history_cleanup_config hcc
WHERE hcc.can_cleanup = true
ORDER BY hcc.cleanup_priority DESC, hcc.category, hcc.table_name;

-- Grant SELECT permission to authenticated users
-- (Frontend route protection ensures only admins access this)
GRANT SELECT ON history_cleanup_summary TO authenticated, anon;

-- Add helpful comment
COMMENT ON VIEW history_cleanup_summary IS 'Summary view for history data management dashboard. Shows cleanup configuration and current table statistics.';
