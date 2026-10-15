/*
  # Recreate History Cleanup Summary View
  
  ## Problem
  The history_cleanup_summary view doesn't exist or failed to create.
  
  ## Solution
  Create a simplified version that uses a helper function to get table sizes dynamically.
*/

-- Drop the view if it exists
DROP VIEW IF EXISTS history_cleanup_summary CASCADE;

-- Helper function to get table size safely
CREATE OR REPLACE FUNCTION get_table_size(p_table_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN pg_total_relation_size(p_table_name::regclass);
EXCEPTION
  WHEN OTHERS THEN
    RETURN 0;
END;
$$;

-- Helper function to get record count safely
CREATE OR REPLACE FUNCTION get_table_record_count(p_table_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count bigint;
BEGIN
  EXECUTE format('SELECT COUNT(*) FROM %I', p_table_name) INTO v_count;
  RETURN v_count;
EXCEPTION
  WHEN OTHERS THEN
    RETURN 0;
END;
$$;

-- Create the summary view
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
  END as cleanup_status,
  pg_size_pretty(get_table_size(hcc.table_name)) as current_size,
  get_table_record_count(hcc.table_name) as current_record_count
FROM history_cleanup_config hcc
WHERE hcc.can_cleanup = true
ORDER BY hcc.cleanup_priority DESC, hcc.category, hcc.table_name;

-- Grant permissions
GRANT SELECT ON history_cleanup_summary TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_table_size(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_table_record_count(text) TO anon, authenticated;

-- Add comment
COMMENT ON VIEW history_cleanup_summary IS 'Summary view for history data management dashboard with dynamic table size and count.';
COMMENT ON FUNCTION get_table_size IS 'Safely get table size for history cleanup summary.';
COMMENT ON FUNCTION get_table_record_count IS 'Safely get record count for history cleanup summary.';
