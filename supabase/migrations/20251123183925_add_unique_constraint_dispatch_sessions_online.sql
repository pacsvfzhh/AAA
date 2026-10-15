/*
  # Add Unique Constraint for Dispatch Sessions
  
  1. Problem
    - Multiple rapid clicks on "Start Work Session" can create duplicate dispatch_sessions
    - No database-level constraint prevents multiple online sessions for same user
    - This causes "no session ID returned" errors when insert fails silently
  
  2. Solution
    - Add partial unique index to ensure only one online session per user
    - Update insert logic to handle conflicts gracefully
    - Clean up any existing duplicate online sessions
  
  3. Changes
    - Clean up duplicate online sessions (keep most recent)
    - Create partial unique index on (user_id) WHERE status = 'online'
    - This prevents concurrent inserts from creating duplicates
*/

-- Step 1: Clean up any existing duplicate online sessions (keep most recent)
WITH duplicates AS (
  SELECT 
    user_id,
    array_agg(id ORDER BY started_at DESC) as session_ids
  FROM dispatch_sessions
  WHERE status = 'online'
  GROUP BY user_id
  HAVING COUNT(*) > 1
)
UPDATE dispatch_sessions ds
SET 
  status = 'offline',
  ended_at = now()
FROM duplicates d
WHERE ds.user_id = d.user_id
  AND ds.id = ANY(d.session_ids[2:]);  -- Keep first (most recent), close others

-- Step 2: Create partial unique index to prevent future duplicates
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_sessions_one_online_per_user
ON dispatch_sessions (user_id)
WHERE status = 'online';

-- Add helpful comment
COMMENT ON INDEX idx_dispatch_sessions_one_online_per_user IS
'Ensures each user can only have one online dispatch session at a time. Prevents race conditions from rapid Start Work clicks.';
