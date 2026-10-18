-- Objects that exist in production but are not created by any file in supabase/migrations
-- (created through the dashboard before the migration history was exported). Definitions were
-- read from the production catalog on 2026-10-16 (read-only); only columns and keys are kept.

CREATE TABLE IF NOT EXISTS public.admin_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.admin_groups(id) ON DELETE CASCADE,
  admin_id uuid NOT NULL REFERENCES public.admins(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.orders_history (
  id uuid NOT NULL,
  user_id uuid NOT NULL,
  product_type_id uuid NOT NULL,
  product_value numeric NOT NULL,
  transaction_id text NOT NULL,
  status text NOT NULL,
  screenshot_url text,
  commission_amount numeric,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  archived_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
CREATE TABLE IF NOT EXISTS public.orders_history_2025 PARTITION OF public.orders_history
  FOR VALUES FROM ('2025-01-01') TO ('2026-01-01');
CREATE TABLE IF NOT EXISTS public.orders_history_2026 PARTITION OF public.orders_history
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS current_session_token uuid;
ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS is_hidden boolean DEFAULT false;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS session_created_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS current_tab_id text;

CREATE TABLE IF NOT EXISTS public.bulk_import_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name text, import_type text, total_records integer,
  records_imported integer DEFAULT 0, records_failed integer DEFAULT 0,
  started_at timestamptz DEFAULT now(), completed_at timestamptz,
  status text DEFAULT 'in_progress', error_message text, import_batch_size integer DEFAULT 1000,
  performed_by uuid, metadata jsonb
);

CREATE TABLE IF NOT EXISTS public.group_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid, config_type text, config_value text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

-- @before 20260706000801
-- Functions that exist in production but were created outside the migration history.
CREATE FUNCTION public.cleanup_all_practice_data() RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION public.test_concurrent_dispatch(p_user uuid, p_count integer) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;

-- @before 20260706001347
CREATE FUNCTION public.validate_employee_session(p_user uuid, p_token uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE FUNCTION public.clear_employee_session(p_user uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION public.update_employee_heartbeat(p_user uuid, p_token uuid) RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;

-- @before 20261001043534
-- Schedule saved by the dashboard (public.system_configs) before the cleanup schedule moved to history_cleanup_config.
INSERT INTO public.system_configs (key, value) VALUES ('auto_cleanup_schedule', '[
  {"table_name":"bulk_import_log","enabled":false,"days_to_keep":365,"schedule_time":"06:00"},
  {"table_name":"commission_audit_log","enabled":false,"days_to_keep":365,"schedule_time":"05:00"},
  {"table_name":"customer_service_sessions","enabled":false,"days_to_keep":180,"schedule_time":"04:00"},
  {"table_name":"dispatch_assignments","enabled":true,"days_to_keep":30,"schedule_time":"02:00"},
  {"table_name":"dispatch_performance_metrics","enabled":true,"days_to_keep":30,"schedule_time":"02:00"},
  {"table_name":"dispatch_sessions","enabled":true,"days_to_keep":30,"schedule_time":"02:00"},
  {"table_name":"dispatch_system_logs","enabled":true,"days_to_keep":60,"schedule_time":"02:00"},
  {"table_name":"money_data_protection_audit","enabled":false,"days_to_keep":365,"schedule_time":"05:00"},
  {"table_name":"orders_history","enabled":false,"days_to_keep":730,"schedule_time":"06:00"},
  {"table_name":"used_order_data","enabled":true,"days_to_keep":30,"schedule_time":"02:30"},
  {"table_name":"valid_data_audit_log","enabled":true,"days_to_keep":90,"schedule_time":"03:00"},
  {"table_name":"valid_data_error_log","enabled":true,"days_to_keep":90,"schedule_time":"03:00"},
  {"table_name":"valid_data_query_performance","enabled":true,"days_to_keep":30,"schedule_time":"03:00"},
  {"table_name":"valid_order_data","enabled":true,"days_to_keep":30,"schedule_time":"02:45"},
  {"table_name":"valid_order_data_archive","enabled":false,"days_to_keep":730,"schedule_time":"06:00"},
  {"table_name":"work_sessions","enabled":true,"days_to_keep":400,"schedule_time":"02:00"}
]'::jsonb) ON CONFLICT (key) DO UPDATE SET value = excluded.value;
