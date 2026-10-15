CREATE OR REPLACE FUNCTION public.emit_account_lock_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.account_lock_events (id, event_type, occurred_at)
  VALUES (
    '00000000-0000-0000-0000-000000000001'::uuid,
    TG_OP,
    now()
  )
  ON CONFLICT (id) DO UPDATE
  SET event_type = EXCLUDED.event_type,
      occurred_at = EXCLUDED.occurred_at;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.emit_account_lock_event() IS 'Publishes only the latest non-sensitive account lock change signal.';
