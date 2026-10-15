/*
  # Backfill Work Sessions from Dispatch Sessions
  
  1. Purpose
    - Backfill historical dispatch_sessions into work_sessions table
    - Calculate duration for completed sessions
    - This ensures historical work time data is accurate
    
  2. Changes
    - Insert work sessions for all dispatch sessions that don't have corresponding work sessions
    - Calculate and set duration_minutes for offline sessions
*/

-- Backfill work sessions from dispatch sessions
INSERT INTO work_sessions (id, user_id, start_time, end_time, duration_minutes)
SELECT 
  ds.id,
  ds.user_id,
  ds.started_at,
  ds.ended_at,
  CASE 
    WHEN ds.ended_at IS NOT NULL AND ds.started_at IS NOT NULL 
    THEN CAST(EXTRACT(EPOCH FROM (ds.ended_at - ds.started_at)) / 60 AS integer)
    ELSE NULL
  END as duration_minutes
FROM dispatch_sessions ds
LEFT JOIN work_sessions ws ON ws.id = ds.id
WHERE ws.id IS NULL
  AND ds.started_at IS NOT NULL
ON CONFLICT (id) DO NOTHING;
