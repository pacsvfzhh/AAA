-- Fix: Grant MAINTAIN to supabase_read_only_user for internal stats collection
-- Supabase's internal process runs periodic ANALYZE on empty tables using this role.
-- MAINTAIN only allows VACUUM/ANALYZE - no data read/write access.
-- PG17 supports this granular privilege.

GRANT MAINTAIN ON ALL TABLES IN SCHEMA public TO supabase_read_only_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT MAINTAIN ON TABLES TO supabase_read_only_user;
