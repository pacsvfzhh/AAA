DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'users'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.users;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'admins'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.admins;
  END IF;
END;
$$;

ALTER PUBLICATION supabase_realtime ADD TABLE public.users (
  id,
  username,
  employee_id,
  is_verified,
  is_active,
  total_income,
  first_success_order_date,
  created_by,
  remarks,
  created_at,
  updated_at,
  tags,
  is_pinned,
  current_session_token,
  session_created_at,
  last_heartbeat_at,
  current_tab_id
);

ALTER PUBLICATION supabase_realtime ADD TABLE public.admins (
  id,
  username,
  role,
  parent_id,
  is_active,
  created_at,
  updated_at,
  is_pinned
);
