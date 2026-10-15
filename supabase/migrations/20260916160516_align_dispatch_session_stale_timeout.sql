/*
  Keep dispatch presence consistent with heartbeat-based work-session cleanup.
  Browser unload still ends sessions immediately through end_work_session_by_user.
*/

CREATE OR REPLACE FUNCTION public.cleanup_stale_dispatch_sessions()
RETURNS TABLE (
  cleaned_session_id uuid,
  user_id uuid,
  started_at timestamptz,
  inactive_duration interval
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT pg_try_advisory_xact_lock(8675310) THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.dispatch_sessions AS ds
  SET
    status = 'offline',
    ended_at = COALESCE(ds.last_activity_at, ds.started_at) + interval '1 minute'
  WHERE ds.status = 'online'
    AND COALESCE(ds.last_activity_at, ds.started_at) < now() - interval '3 minutes'
  RETURNING
    ds.id,
    ds.user_id,
    ds.started_at,
    now() - COALESCE(ds.last_activity_at, ds.started_at);
END;
$function$;
