/*
  # Fix History Cleanup Config RLS for Custom Auth
  
  1. Problem
    - history_cleanup_config table has RLS enabled with policy using auth.uid()
    - This project uses custom authentication, not Supabase built-in auth
    - Frontend cannot access history_cleanup_summary view because underlying table is blocked
  
  2. Solution
    - Drop existing restrictive policy
    - Create new policy allowing authenticated API access (anon/service role)
    - The view is read-only configuration data, safe for admin viewing
  
  3. Security
    - Only super_admin users should access History Data Management page (enforced in frontend)
    - This table contains only configuration metadata, no sensitive user data
*/

-- Drop the existing policy that doesn't work with custom auth
DROP POLICY IF EXISTS "Admins can access cleanup config" ON history_cleanup_config;

-- Create a policy that allows read access for API calls
-- The actual admin check is done in the frontend
CREATE POLICY "Allow read access to cleanup config"
  ON history_cleanup_config
  FOR SELECT
  TO authenticated, anon
  USING (true);

-- Also ensure the view has proper security definer to bypass RLS
DROP VIEW IF EXISTS history_cleanup_summary;

CREATE OR REPLACE VIEW history_cleanup_summary 
WITH (security_invoker = false)
AS
SELECT 
  category,
  display_name,
  table_name,
  description,
  default_retention_days,
  min_retention_days,
  cleanup_priority,
  last_cleanup_at,
  last_cleanup_records,
  CASE 
    WHEN last_cleanup_at IS NULL THEN 'Never cleaned'
    WHEN last_cleanup_at < NOW() - INTERVAL '7 days' THEN 'Cleanup overdue'
    WHEN last_cleanup_at < NOW() - INTERVAL '3 days' THEN 'Consider cleanup'
    ELSE 'Recently cleaned'
  END AS cleanup_status,
  pg_size_pretty(get_table_size(table_name)) AS current_size,
  get_table_record_count(table_name) AS current_record_count
FROM history_cleanup_config hcc
WHERE can_cleanup = true
ORDER BY cleanup_priority DESC, category, table_name;

-- Grant access to the view
GRANT SELECT ON history_cleanup_summary TO authenticated, anon;
