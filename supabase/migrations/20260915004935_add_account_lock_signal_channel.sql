CREATE TABLE IF NOT EXISTS public.account_lock_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN ('INSERT', 'UPDATE', 'DELETE')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.account_lock_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.account_lock_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.account_lock_events TO anon, authenticated;

DROP POLICY IF EXISTS "Read account lock change signals" ON public.account_lock_events;
CREATE POLICY "Read account lock change signals"
  ON public.account_lock_events
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.emit_account_lock_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $$
BEGIN
  INSERT INTO public.account_lock_events (event_type)
  VALUES (TG_OP);

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.emit_account_lock_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS account_locks_emit_event ON public.account_locks;
CREATE TRIGGER account_locks_emit_event
AFTER INSERT OR UPDATE OR DELETE ON public.account_locks
FOR EACH ROW
EXECUTE FUNCTION public.emit_account_lock_event();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'account_lock_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.account_lock_events;
  END IF;
END;
$$;

COMMENT ON TABLE public.account_lock_events IS 'Non-sensitive realtime signal for account lock changes. Details are fetched through the session-validated lock RPCs.';
