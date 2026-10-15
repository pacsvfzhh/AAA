-- Grant MAINTAIN on ALL public tables to supabase_read_only_user
-- This allows Supabase's internal auto-analyze to update table statistics
-- MAINTAIN only permits VACUUM/ANALYZE - no data read/write access
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT MAINTAIN ON public.%I TO supabase_read_only_user', r.tablename);
  END LOOP;
END;
$$;

-- Also grant on partitioned tables (orders_history partitions)
-- and set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT MAINTAIN ON TABLES TO supabase_read_only_user;
