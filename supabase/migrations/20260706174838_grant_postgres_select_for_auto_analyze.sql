/*
# Grant postgres role SELECT for auto-analyze

## Problem
Supabase's auto-analyze background process runs as the `postgres` role.
After the security hardening migrations that revoked default PUBLIC privileges,
the postgres role lost inherited SELECT access to tables it owns.
This causes SQLSTATE 01000 warnings: "permission denied to analyze [table], skipping it"
appearing repeatedly in database logs (every few minutes).

## Impact
- Warnings are harmless (data still works correctly)
- But auto-analyze can't update table statistics, potentially degrading query planner performance
- Logs are flooded with these warnings making real issues harder to spot

## Fix
Grant SELECT to the `postgres` role on all public schema tables so auto-analyze
can gather statistics. This is safe because postgres owns these tables anyway.
*/

-- Grant SELECT on all existing tables in public schema to postgres
-- This allows the auto-analyze process to gather statistics
GRANT SELECT ON ALL TABLES IN SCHEMA public TO postgres;

-- Also grant for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO postgres;
