-- Grant SELECT to dashboard_user for Supabase internal auto-analyze
-- This role is used by Supabase's stats collection process that runs ANALYZE.
-- It lost access when PUBLIC privileges were revoked in security hardening.

GRANT SELECT ON ALL TABLES IN SCHEMA public TO dashboard_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO dashboard_user;
