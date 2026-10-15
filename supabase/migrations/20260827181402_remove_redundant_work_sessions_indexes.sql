/*
# Remove Redundant Work Sessions Indexes

## Problem
The work_sessions table has multiple redundant indexes that increase write overhead
(every heartbeat UPDATE touches this table). Redundant indexes waste CPU on index
maintenance for every INSERT/UPDATE.

## Changes
- Drop idx_work_sessions_active (subset of idx_work_sessions_active_user which is UNIQUE)
- Drop idx_work_sessions_cleanup (superseded by idx_work_sessions_cleanup_scan)
- Drop idx_work_sessions_last_heartbeat (superseded by idx_work_sessions_cleanup_scan)
- Drop idx_work_sessions_start_time_null_end (superseded by idx_work_sessions_cleanup_scan)
- Keep: idx_work_sessions_active_user (unique constraint), idx_work_sessions_cleanup_scan,
  idx_work_sessions_user_start_time, idx_work_sessions_user_id, work_sessions_pkey,
  idx_work_sessions_end_time, idx_work_sessions_start_time

## Important Notes
1. This reduces index maintenance overhead on every heartbeat write
2. All query patterns are still covered by remaining indexes
*/

DROP INDEX IF EXISTS idx_work_sessions_active;
DROP INDEX IF EXISTS idx_work_sessions_cleanup;
DROP INDEX IF EXISTS idx_work_sessions_last_heartbeat;
DROP INDEX IF EXISTS idx_work_sessions_start_time_null_end;
