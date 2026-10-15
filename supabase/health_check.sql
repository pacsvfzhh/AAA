-- =====================================================================
-- NEW DEPLOYMENT HEALTH CHECK (single-query version)
-- =====================================================================
-- How to use:
--   1. Open the NEW Supabase project -> SQL Editor -> New query
--   2. Paste this entire file
--   3. Click Run
--   4. One result grid appears with all checks. Sort by `status` to
--      see FAIL / WARN rows at the top.
--
-- Legend:
--   OK   = fine
--   WARN = worth reviewing (won't block launch)
--   FAIL = must fix before going live
--   INFO = informational (row counts)
--
-- Safe to run repeatedly. Read-only (no writes).
-- =====================================================================

WITH
-- 1. Required extensions
extensions AS (
  SELECT
    '01_extensions' AS section,
    t.ext AS name,
    CASE WHEN e.extversion IS NOT NULL THEN 'OK' ELSE 'FAIL' END AS status,
    COALESCE(e.extversion, 'NOT INSTALLED') AS detail
  FROM (VALUES ('pg_cron'), ('pg_net'), ('pgcrypto'), ('pg_stat_statements')) AS t(ext)
  LEFT JOIN pg_extension e ON e.extname = t.ext
),

-- 2. Cron jobs registered
cron_registered AS (
  SELECT
    '02_cron_jobs' AS section,
    jobname AS name,
    CASE WHEN active THEN 'OK' ELSE 'FAIL' END AS status,
    'schedule=' || schedule AS detail
  FROM cron.job
  WHERE jobname IN (
    'process_pending_orders_every_minute',
    'auto_cleanup_dispatch_every_5min',
    'daily_auto_cleanup_history_data',
    'weekly_cleanup_practice_data'
  )
),
cron_missing AS (
  SELECT
    '02_cron_jobs' AS section,
    expected AS name,
    'FAIL' AS status,
    'MISSING - job not registered' AS detail
  FROM (VALUES
    ('process_pending_orders_every_minute'),
    ('auto_cleanup_dispatch_every_5min'),
    ('daily_auto_cleanup_history_data'),
    ('weekly_cleanup_practice_data')
  ) AS t(expected)
  WHERE expected NOT IN (SELECT jobname FROM cron.job)
),

-- 3. Cron recent runs (24h)
cron_runs AS (
  SELECT
    '03_cron_runs_24h' AS section,
    j.jobname AS name,
    CASE
      WHEN r.last_run IS NULL THEN 'WARN'
      WHEN r.fail_count > 0 THEN 'WARN'
      ELSE 'OK'
    END AS status,
    'runs=' || COALESCE(r.run_count, 0)
      || ', fails=' || COALESCE(r.fail_count, 0)
      || ', last_run=' || COALESCE(r.last_run::text, 'never') AS detail
  FROM cron.job j
  LEFT JOIN (
    SELECT
      jobid,
      COUNT(*) AS run_count,
      COUNT(*) FILTER (WHERE status <> 'succeeded') AS fail_count,
      MAX(start_time) AS last_run
    FROM cron.job_run_details
    WHERE start_time > now() - interval '24 hours'
    GROUP BY jobid
  ) r ON r.jobid = j.jobid
),

-- 4. Super admin exists
super_admin AS (
  SELECT
    '04_super_admin' AS section,
    'super_admin_count' AS name,
    CASE WHEN COUNT(*) >= 1 THEN 'OK' ELSE 'FAIL' END AS status,
    'count=' || COUNT(*)::text AS detail
  FROM admins
  WHERE role = 'super_admin'
),

-- 5. Global admin_configs rows
global_config AS (
  SELECT
    '05_global_config' AS section,
    cfg AS name,
    CASE WHEN EXISTS (
      SELECT 1 FROM admin_configs WHERE admin_id IS NULL AND config_type = cfg
    ) THEN 'OK' ELSE 'WARN' END AS status,
    COALESCE((
      SELECT config_value FROM admin_configs
      WHERE admin_id IS NULL AND config_type = cfg
      LIMIT 1
    ), 'MISSING - uses hard-coded fallback') AS detail
  FROM (VALUES
    ('commission_rate'),
    ('success_rate'),
    ('company_name'),
    ('withdrawal_amount_threshold'),
    ('withdrawal_days_threshold'),
    ('withdrawal_condition_mode')
  ) AS t(cfg)
),

-- 6. system_configs row count
system_configs_check AS (
  SELECT
    '06_system_configs' AS section,
    'total_rows' AS name,
    CASE WHEN COUNT(*) >= 1 THEN 'OK' ELSE 'WARN' END AS status,
    'count=' || COUNT(*)::text AS detail
  FROM system_configs
),

-- 7. Storage buckets
buckets AS (
  SELECT
    '07_storage_buckets' AS section,
    bucket AS name,
    CASE WHEN EXISTS (SELECT 1 FROM storage.buckets WHERE id = bucket)
         THEN 'OK' ELSE 'FAIL' END AS status,
    COALESCE((
      SELECT CASE WHEN public THEN 'public' ELSE 'private' END
      FROM storage.buckets WHERE id = bucket
    ), 'MISSING') AS detail
  FROM (VALUES
    ('verification-documents'),
    ('announcement-images'),
    ('website-icons'),
    ('chat-images'),
    ('super-customer-avatars')
  ) AS t(bucket)
),

-- 8. Core tables exist
core_tables AS (
  SELECT
    '08_core_tables' AS section,
    tbl AS name,
    CASE WHEN EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN 'OK' ELSE 'FAIL' END AS status,
    tbl AS detail
  FROM (VALUES
    ('admins'), ('users'), ('wallets'), ('orders'),
    ('admin_configs'), ('system_configs'),
    ('dispatch_groups'), ('dispatch_assignments'),
    ('valid_order_data'), ('announcements'),
    ('customer_employee_conversations'), ('customer_service_sessions'),
    ('messages'), ('message_recipients'),
    ('work_sessions'), ('employee_login_history')
  ) AS t(tbl)
),

-- 9. Critical RPC functions
functions_check AS (
  SELECT
    '09_functions' AS section,
    fn AS name,
    CASE WHEN to_regproc('public.' || fn) IS NOT NULL THEN 'OK' ELSE 'FAIL' END AS status,
    fn AS detail
  FROM (VALUES
    ('process_pending_orders'),
    ('auto_cleanup_dispatch_system'),
    ('auto_cleanup_all_tables'),
    ('cleanup_all_practice_data'),
    ('assign_next_dispatch_order'),
    ('start_work_session'),
    ('get_user_work_time_today'),
    ('check_login_rate_limit'),
    ('adjust_wallet_balance'),
    ('cleanup_user_data')
  ) AS t(fn)
),

-- 10. RLS enabled on every public table
rls_check AS (
  SELECT
    '10_rls' AS section,
    schemaname || '.' || tablename AS name,
    CASE WHEN rowsecurity THEN 'OK' ELSE 'FAIL' END AS status,
    CASE WHEN rowsecurity THEN 'enabled' ELSE 'RLS DISABLED' END AS detail
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename NOT LIKE 'pg_%'
),

-- 11. Realtime publication coverage
realtime_check AS (
  SELECT
    '11_realtime' AS section,
    tbl AS name,
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public' AND tablename = tbl
    ) THEN 'OK' ELSE 'WARN' END AS status,
    tbl AS detail
  FROM (VALUES
    ('orders'), ('customer_employee_conversations'), ('customer_service_sessions'),
    ('wallets'), ('admins'), ('users'), ('announcements'),
    ('admin_configs'), ('system_configs'), ('account_locks')
  ) AS t(tbl)
),

-- 12. Data hygiene
hygiene AS (
  SELECT '12_data_hygiene' AS section, 'wallets_without_user' AS name,
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'WARN' END AS status,
    'count=' || COUNT(*)::text AS detail
  FROM wallets w
  LEFT JOIN users u ON u.id = w.user_id
  WHERE u.id IS NULL
  UNION ALL
  SELECT '12_data_hygiene', 'users_without_wallet',
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'WARN' END,
    'count=' || COUNT(*)::text
  FROM users u
  LEFT JOIN wallets w ON w.user_id = u.id
  WHERE w.user_id IS NULL
  UNION ALL
  SELECT '12_data_hygiene', 'pending_orders_stuck_over_1h',
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'WARN' END,
    'count=' || COUNT(*)::text
  FROM orders
  WHERE status = 'processing' AND created_at < now() - interval '1 hour'
  UNION ALL
  SELECT '12_data_hygiene', 'open_work_sessions_over_24h',
    CASE WHEN COUNT(*) = 0 THEN 'OK' ELSE 'WARN' END,
    'count=' || COUNT(*)::text
  FROM work_sessions
  WHERE end_time IS NULL AND start_time < now() - interval '24 hours'
),

-- 13. Replica identity (realtime DELETE events)
replica_identity AS (
  SELECT
    '13_replica_identity' AS section,
    c.relname AS name,
    CASE WHEN c.relreplident IN ('f', 'i') THEN 'OK' ELSE 'WARN' END AS status,
    CASE c.relreplident
      WHEN 'd' THEN 'default'
      WHEN 'n' THEN 'nothing'
      WHEN 'f' THEN 'full'
      WHEN 'i' THEN 'index'
    END AS detail
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN (
      'users', 'admins', 'orders', 'wallets',
      'customer_employee_conversations', 'customer_service_sessions', 'account_locks'
    )
),

-- 14. Row count snapshot
row_counts AS (
  SELECT '14_row_counts' AS section, 'admins' AS name, 'INFO' AS status, COUNT(*)::text AS detail FROM admins
  UNION ALL SELECT '14_row_counts', 'users', 'INFO', COUNT(*)::text FROM users
  UNION ALL SELECT '14_row_counts', 'wallets', 'INFO', COUNT(*)::text FROM wallets
  UNION ALL SELECT '14_row_counts', 'orders', 'INFO', COUNT(*)::text FROM orders
  UNION ALL SELECT '14_row_counts', 'valid_order_data', 'INFO', COUNT(*)::text FROM valid_order_data
  UNION ALL SELECT '14_row_counts', 'dispatch_groups', 'INFO', COUNT(*)::text FROM dispatch_groups
  UNION ALL SELECT '14_row_counts', 'announcements', 'INFO', COUNT(*)::text FROM announcements
),

-- Combine everything
all_checks AS (
  SELECT * FROM extensions
  UNION ALL SELECT * FROM cron_registered
  UNION ALL SELECT * FROM cron_missing
  UNION ALL SELECT * FROM cron_runs
  UNION ALL SELECT * FROM super_admin
  UNION ALL SELECT * FROM global_config
  UNION ALL SELECT * FROM system_configs_check
  UNION ALL SELECT * FROM buckets
  UNION ALL SELECT * FROM core_tables
  UNION ALL SELECT * FROM functions_check
  UNION ALL SELECT * FROM rls_check
  UNION ALL SELECT * FROM realtime_check
  UNION ALL SELECT * FROM hygiene
  UNION ALL SELECT * FROM replica_identity
  UNION ALL SELECT * FROM row_counts
)
SELECT
  section,
  name,
  status,
  detail
FROM all_checks
ORDER BY
  CASE status
    WHEN 'FAIL' THEN 1
    WHEN 'WARN' THEN 2
    WHEN 'INFO' THEN 3
    WHEN 'OK'   THEN 4
  END,
  section,
  name;
