CREATE TABLE IF NOT EXISTS public.withdrawal_events (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  admin_id uuid REFERENCES public.admins(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('INSERT', 'UPDATE', 'DELETE')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.withdrawal_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.withdrawal_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.withdrawal_events TO anon, authenticated;

DROP POLICY IF EXISTS "Read withdrawal change signals" ON public.withdrawal_events;
CREATE POLICY "Read withdrawal change signals"
  ON public.withdrawal_events
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.emit_withdrawal_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid;
  v_admin_id uuid;
BEGIN
  v_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;

  SELECT u.created_by
  INTO v_admin_id
  FROM public.users AS u
  WHERE u.id = v_user_id;

  INSERT INTO public.withdrawal_events (user_id, admin_id, event_type, occurred_at)
  VALUES (v_user_id, v_admin_id, TG_OP, now())
  ON CONFLICT (user_id) DO UPDATE
  SET admin_id = EXCLUDED.admin_id,
      event_type = EXCLUDED.event_type,
      occurred_at = EXCLUDED.occurred_at;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.emit_withdrawal_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS withdrawals_emit_event ON public.withdrawals;
CREATE TRIGGER withdrawals_emit_event
AFTER INSERT OR UPDATE OR DELETE ON public.withdrawals
FOR EACH ROW
EXECUTE FUNCTION public.emit_withdrawal_event();

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'withdrawals'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.withdrawals;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'withdrawal_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.withdrawal_events;
  END IF;
END;
$do$;

COMMENT ON TABLE public.withdrawal_events IS
  'Non-sensitive per-employee and per-administrator Realtime signal. Withdrawal amounts and audit details remain available through scoped reads.';
