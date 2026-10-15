ALTER TABLE public.dispatch_groups
  ADD COLUMN grab_success_rate integer NOT NULL DEFAULT 100
    CONSTRAINT dispatch_groups_grab_success_rate_check CHECK (grab_success_rate BETWEEN 0 AND 100);

UPDATE public.dispatch_groups
SET grab_success_rate = dispatch_success_rate;

ALTER TABLE public.dispatch_assignments
  ADD COLUMN grab_success_rate_snapshot integer
    CONSTRAINT dispatch_assignments_grab_success_rate_snapshot_check
      CHECK (grab_success_rate_snapshot BETWEEN 0 AND 100);

-- Existing assignments must retain their original grab odds, including in-flight ones.
UPDATE public.dispatch_assignments
SET grab_success_rate_snapshot = dispatch_success_rate_snapshot
WHERE grab_success_rate_snapshot IS NULL AND dispatch_success_rate_snapshot IS NOT NULL;

DO $block$
DECLARE
  v_source text;
  v_old text;
BEGIN
  SELECT pg_get_functiondef('public.admin_save_dispatch_group(uuid,uuid,jsonb)'::regprocedure)
  INTO v_source;
  v_old := $anchor$'withdrawal_condition_mode'])$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch group allowed fields changed.'; END IF;
  v_source := replace(v_source, v_old, $anchor$'withdrawal_condition_mode', 'grab_success_rate'])$anchor$);
  v_old := '  IF p_group_id IS NULL THEN';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch group validation changed.'; END IF;
  v_source := replace(v_source, v_old, $patch$  IF p_changes ? 'grab_success_rate' AND
     (jsonb_typeof(p_changes->'grab_success_rate') <> 'number' OR
      (p_changes->>'grab_success_rate') !~ '^[0-9]{1,3}$' OR
      (p_changes->>'grab_success_rate')::integer NOT BETWEEN 0 AND 100) THEN
    RAISE EXCEPTION 'Invalid dispatch grab success rate.';
  END IF;
  IF p_group_id IS NULL THEN$patch$);
  v_old := 'withdrawal_orders_threshold, withdrawal_condition_mode
    ) VALUES (';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch group insert columns changed.'; END IF;
  v_source := replace(v_source, v_old, 'withdrawal_orders_threshold, withdrawal_condition_mode, grab_success_rate
    ) VALUES (');
  v_old := $anchor$COALESCE(p_changes->>'withdrawal_condition_mode', 'OR')
    ) RETURNING$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch group insert values changed.'; END IF;
  v_source := replace(v_source, v_old, $patch$COALESCE(p_changes->>'withdrawal_condition_mode', 'OR'),
      COALESCE((p_changes->>'grab_success_rate')::integer,
               (p_changes->>'dispatch_success_rate')::integer, 100)
    ) RETURNING$patch$);
  v_old := $anchor$withdrawal_condition_mode = COALESCE(p_changes->>'withdrawal_condition_mode', withdrawal_condition_mode),
        updated_at$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch group update changed.'; END IF;
  v_source := replace(v_source, v_old, $patch$withdrawal_condition_mode = COALESCE(p_changes->>'withdrawal_condition_mode', withdrawal_condition_mode),
        grab_success_rate = COALESCE((p_changes->>'grab_success_rate')::integer, grab_success_rate),
        updated_at$patch$);
  EXECUTE v_source;

  SELECT pg_get_functiondef('public.prepare_next_dispatch_order_secure(uuid,uuid,text,uuid)'::regprocedure)
  INTO v_source;
  v_old := 'dispatch_group.session_timeout_minutes, dispatch_group.dispatch_success_rate';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch preparation group fields changed.'; END IF;
  v_source := replace(v_source, v_old, 'dispatch_group.session_timeout_minutes, dispatch_group.grab_success_rate');
  v_old := $anchor$'dispatch_success_rate', v_group.dispatch_success_rate$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch preparation rate response changed.'; END IF;
  EXECUTE replace(v_source, v_old, $anchor$'grab_success_rate', v_group.grab_success_rate$anchor$);

  SELECT pg_get_functiondef('public.assign_next_dispatch_order_secure(uuid,uuid,text,uuid,uuid,text)'::regprocedure)
  INTO v_source;
  v_old := 'dispatch_group.commission_rate, dispatch_group.dispatch_success_rate
  INTO v_group';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch assignment group rates changed.'; END IF;
  v_source := replace(v_source, v_old,
    'dispatch_group.commission_rate, dispatch_group.dispatch_success_rate, dispatch_group.grab_success_rate
  INTO v_group');
  v_old := 'dispatch_success_rate_snapshot, commission_rate_snapshot, session_timeout_minutes_snapshot';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch assignment snapshot columns changed.'; END IF;
  v_source := replace(v_source, v_old,
    'dispatch_success_rate_snapshot, grab_success_rate_snapshot, commission_rate_snapshot, session_timeout_minutes_snapshot');
  v_old := 'v_group.dispatch_success_rate, v_group.commission_rate, v_group.session_timeout_minutes';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch assignment snapshot values changed.'; END IF;
  EXECUTE replace(v_source, v_old,
    'v_group.dispatch_success_rate, v_group.grab_success_rate, v_group.commission_rate, v_group.session_timeout_minutes');

  SELECT pg_get_functiondef('public.accept_dispatch_assignment_secure(uuid,uuid,text,uuid,uuid,text)'::regprocedure)
  INTO v_source;
  v_old := 'COALESCE(assignment.dispatch_success_rate_snapshot,
                  dispatch_group.dispatch_success_rate, 100) AS success_rate';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch grab success decision changed.'; END IF;
  EXECUTE replace(v_source, v_old,
    'COALESCE(assignment.grab_success_rate_snapshot, assignment.dispatch_success_rate_snapshot,
                  dispatch_group.grab_success_rate, 100) AS success_rate');
END;
$block$;
