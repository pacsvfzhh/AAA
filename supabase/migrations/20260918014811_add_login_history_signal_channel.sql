CREATE TABLE IF NOT EXISTS public.employee_login_history_events (
  admin_id uuid PRIMARY KEY REFERENCES public.admins(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('INSERT', 'UPDATE', 'DELETE')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.employee_login_history_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.employee_login_history_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.employee_login_history_events TO anon, authenticated;

DROP POLICY IF EXISTS "Read employee login history change signals" ON public.employee_login_history_events;
CREATE POLICY "Read employee login history change signals"
  ON public.employee_login_history_events
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.emit_employee_login_history_event()
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

  IF v_admin_id IS NOT NULL THEN
    INSERT INTO public.employee_login_history_events (admin_id, event_type, occurred_at)
    VALUES (v_admin_id, TG_OP, now())
    ON CONFLICT (admin_id) DO UPDATE
    SET event_type = EXCLUDED.event_type,
        occurred_at = EXCLUDED.occurred_at;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.emit_employee_login_history_event() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS employee_login_history_emit_event ON public.employee_login_history;
CREATE TRIGGER employee_login_history_emit_event
AFTER INSERT OR UPDATE OR DELETE ON public.employee_login_history
FOR EACH ROW
EXECUTE FUNCTION public.emit_employee_login_history_event();

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'employee_login_history'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.employee_login_history;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'employee_login_history_events'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.employee_login_history_events;
  END IF;
END;
$do$;

COMMENT ON TABLE public.employee_login_history_events IS
  'Non-sensitive per-administrator Realtime signal. Login audit details remain available only through session-validated RPCs.';
