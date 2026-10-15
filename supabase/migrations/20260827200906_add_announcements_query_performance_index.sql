/*
# Add composite index for announcements query performance

1. New Indexes
  - `idx_announcements_active_sorted` - covers the main employee-facing query
    that filters by publish_at, is_hidden, and sorts by is_pinned + publish_at
  - `idx_announcements_created_by` - speeds up the OR filter on created_by

2. Purpose
  - The announcements query filters: publish_at <= now(), is_hidden = false, 
    OR(created_by = adminId, is_global = true)
  - Then sorts by: is_pinned DESC, publish_at DESC
  - Without indexes, this causes a sequential scan on every employee login

3. Important Notes
  - These indexes are additive and don't affect existing functionality
  - They specifically target the employee dashboard's announcement loading query
*/

-- Composite index for the main filter + sort pattern
CREATE INDEX IF NOT EXISTS idx_announcements_active_sorted
ON announcements (is_hidden, is_pinned DESC, publish_at DESC)
WHERE is_hidden = false;

-- Index for created_by lookups in the OR filter
CREATE INDEX IF NOT EXISTS idx_announcements_created_by_active
ON announcements (created_by, publish_at DESC)
WHERE is_hidden = false;

-- Index for is_global lookups in the OR filter
CREATE INDEX IF NOT EXISTS idx_announcements_global_active
ON announcements (is_global, publish_at DESC)
WHERE is_hidden = false AND is_global = true;
