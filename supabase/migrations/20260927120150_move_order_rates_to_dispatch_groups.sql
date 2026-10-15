ALTER TABLE public.dispatch_groups
  ADD COLUMN commission_rate numeric(12,8) NOT NULL DEFAULT 0.001
    CONSTRAINT dispatch_groups_commission_rate_check CHECK (commission_rate BETWEEN 0.00001 AND 1);

-- A mixed-admin group cannot retain different member rates; seed its most common
-- effective rate, then fall back to its creator's rate and the global default.
UPDATE public.dispatch_groups AS dispatch_group
SET commission_rate = COALESCE(
  (SELECT effective_rate.rate
   FROM public.dispatch_group_members AS member
   JOIN public.users AS employee ON employee.id = member.user_id
   LEFT JOIN public.admin_configs AS admin_config
     ON admin_config.admin_id = employee.created_by AND admin_config.config_type = 'commission_rate'
   LEFT JOIN public.admin_configs AS global_config
     ON global_config.admin_id IS NULL AND global_config.config_type = 'commission_rate'
   CROSS JOIN LATERAL (SELECT COALESCE(admin_config.config_value, global_config.config_value) AS value) AS configured_rate
   CROSS JOIN LATERAL (SELECT CASE WHEN configured_rate.value ~ '^[0-9]+(\.[0-9]+)?$'
                                THEN configured_rate.value::numeric END AS rate) AS effective_rate
   WHERE member.group_id = dispatch_group.id
     AND effective_rate.rate BETWEEN 0.00001 AND 1
     AND scale(effective_rate.rate) <= 8
   GROUP BY effective_rate.rate
   ORDER BY count(*) DESC, effective_rate.rate
   LIMIT 1),
  (SELECT config_value::numeric FROM public.admin_configs
   WHERE admin_id = dispatch_group.created_by AND config_type = 'commission_rate'
     AND config_value ~ '^[0-9]+(\.[0-9]+)?$'
     AND config_value::numeric BETWEEN 0.00001 AND 1
     AND scale(config_value::numeric) <= 8
   LIMIT 1),
  (SELECT config_value::numeric FROM public.admin_configs
   WHERE admin_id IS NULL AND config_type = 'commission_rate'
     AND config_value ~ '^[0-9]+(\.[0-9]+)?$'
     AND config_value::numeric BETWEEN 0.00001 AND 1
     AND scale(config_value::numeric) <= 8
   LIMIT 1),
  0.001
);

ALTER TABLE public.dispatch_assignments
  ADD COLUMN commission_rate_snapshot numeric(12,8)
    CONSTRAINT dispatch_assignments_commission_rate_snapshot_check
      CHECK (commission_rate_snapshot BETWEEN 0.00001 AND 1);
ALTER TABLE public.orders
  ADD COLUMN dispatch_commission_rate_snapshot numeric(12,8)
    CONSTRAINT orders_dispatch_commission_rate_snapshot_check
      CHECK (dispatch_commission_rate_snapshot BETWEEN 0.00001 AND 1),
  ADD COLUMN dispatch_success_rate_snapshot integer
    CONSTRAINT orders_dispatch_success_rate_snapshot_check
      CHECK (dispatch_success_rate_snapshot BETWEEN 0 AND 100);

-- Existing in-flight assignments keep their pool success snapshots. Capture the
-- old per-admin commission for them before retiring admin settings as a source.
UPDATE public.dispatch_assignments AS assignment
SET commission_rate_snapshot = COALESCE(
  (SELECT config_value::numeric FROM public.admin_configs
   WHERE admin_id = (SELECT created_by FROM public.users WHERE id = assignment.user_id)
     AND config_type = 'commission_rate' LIMIT 1),
  (SELECT config_value::numeric FROM public.admin_configs
   WHERE admin_id IS NULL AND config_type = 'commission_rate' LIMIT 1),
  (SELECT commission_rate FROM public.dispatch_groups WHERE id = assignment.group_id),
  0.001)
WHERE assignment.status IN ('pending', 'accepted')
  AND assignment.commission_rate_snapshot IS NULL;

CREATE OR REPLACE FUNCTION private.snapshot_order_dispatch_rates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_rates record;
BEGIN
  IF NEW.assignment_id IS NOT NULL THEN
    SELECT COALESCE(assignment.commission_rate_snapshot, dispatch_group.commission_rate) AS commission_rate,
           COALESCE(assignment.dispatch_success_rate_snapshot, dispatch_group.dispatch_success_rate) AS success_rate
    INTO v_rates
    FROM public.dispatch_assignments AS assignment
    LEFT JOIN public.dispatch_group_orders AS dispatch_order
      ON dispatch_order.id = assignment.dispatch_order_id
    LEFT JOIN public.dispatch_order_pools AS pool
      ON pool.id = COALESCE(assignment.pool_id, dispatch_order.pool_id)
    JOIN public.dispatch_groups AS dispatch_group
      ON dispatch_group.id = COALESCE(assignment.group_id, pool.group_id, dispatch_order.group_id)
    WHERE assignment.assignment_id = NEW.assignment_id AND assignment.user_id = NEW.user_id
      AND assignment.status = 'accepted' AND assignment.order_submitted = false
      AND assignment.accepted_at + make_interval(mins => COALESCE(
        assignment.session_timeout_minutes_snapshot, dispatch_group.session_timeout_minutes, 10)) > now()
    FOR SHARE OF assignment, dispatch_group;
  ELSE
    PERFORM 1 FROM public.users WHERE id = NEW.user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Order employee not found.'; END IF;
    IF EXISTS (SELECT 1 FROM public.dispatch_assignments
               WHERE user_id = NEW.user_id AND status IN ('pending', 'accepted')) THEN
      RAISE EXCEPTION 'Resolve active dispatch assignment before direct submission.';
    END IF;
    SELECT dispatch_group.commission_rate, dispatch_group.dispatch_success_rate AS success_rate
    INTO v_rates
    FROM public.dispatch_group_members AS member
    JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id = member.group_id
    WHERE member.user_id = NEW.user_id AND dispatch_group.is_active
      AND dispatch_group.archived_at IS NULL
    FOR SHARE OF member, dispatch_group;
  END IF;
  IF v_rates.commission_rate IS NULL OR v_rates.success_rate IS NULL THEN
    RAISE EXCEPTION 'Order has no valid dispatch group rate.';
  END IF;
  NEW.dispatch_commission_rate_snapshot := v_rates.commission_rate;
  NEW.dispatch_success_rate_snapshot := v_rates.success_rate;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER snapshot_order_dispatch_rates
BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION private.snapshot_order_dispatch_rates();
REVOKE ALL ON FUNCTION private.snapshot_order_dispatch_rates() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.protect_order_dispatch_rate_snapshots()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.dispatch_commission_rate_snapshot IS DISTINCT FROM OLD.dispatch_commission_rate_snapshot
     OR NEW.dispatch_success_rate_snapshot IS DISTINCT FROM OLD.dispatch_success_rate_snapshot
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.assignment_id IS DISTINCT FROM OLD.assignment_id THEN
    RAISE EXCEPTION 'Order dispatch rate snapshots and source cannot be changed.';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER protect_order_dispatch_rate_snapshots
BEFORE UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION private.protect_order_dispatch_rate_snapshots();
REVOKE ALL ON FUNCTION private.protect_order_dispatch_rate_snapshots() FROM PUBLIC, anon, authenticated;

-- Keep the existing locking, scheduling, wallet writes and return shapes. Each
-- patch is anchored to the immediately preceding migration and fails closed.
DO $block$
DECLARE
  v_source text;
  v_old text;
  v_new text;
BEGIN
  SELECT pg_get_functiondef('public.admin_save_dispatch_group(uuid,uuid,jsonb)'::regprocedure) INTO v_source;
  v_old := $anchor$'submit_wait_min_seconds', 'submit_wait_max_seconds'])$anchor$;
  v_new := $anchor$'submit_wait_min_seconds', 'submit_wait_max_seconds',
                             'commission_rate', 'dispatch_success_rate'])$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch group whitelist changed.'; END IF;
  v_source := replace(v_source, v_old, v_new);
  v_old := '  IF p_group_id IS NULL THEN';
  v_new := $patch$  IF (p_changes ? 'commission_rate' AND
        (jsonb_typeof(p_changes->'commission_rate') <> 'number' OR
         (p_changes->>'commission_rate')::numeric NOT BETWEEN 0.00001 AND 1 OR
         scale((p_changes->>'commission_rate')::numeric) > 8))
     OR (p_changes ? 'dispatch_success_rate' AND
        (jsonb_typeof(p_changes->'dispatch_success_rate') <> 'number' OR
         (p_changes->>'dispatch_success_rate') !~ '^[0-9]{1,3}$' OR
         (p_changes->>'dispatch_success_rate')::integer NOT BETWEEN 0 AND 100)) THEN
    RAISE EXCEPTION 'Invalid dispatch group commission or success rate.';
  END IF;
  IF p_group_id IS NULL THEN$patch$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch group validation changed.'; END IF;
  v_source := replace(v_source, v_old, v_new);
  v_old := 'session_timeout_minutes, submit_wait_min_seconds, submit_wait_max_seconds';
  v_new := 'session_timeout_minutes, submit_wait_min_seconds, submit_wait_max_seconds,
      commission_rate, dispatch_success_rate';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch group insert columns changed.'; END IF;
  v_source := replace(v_source, v_old, v_new);
  v_old := 'v_wait_min, v_wait_max
    ) RETURNING';
  v_new := $patch$v_wait_min, v_wait_max,
      COALESCE((p_changes->>'commission_rate')::numeric,
        (SELECT config_value::numeric FROM public.admin_configs
         WHERE admin_id IS NULL AND config_type = 'commission_rate'
           AND config_value ~ '^[0-9]+(\.[0-9]+)?$'
           AND config_value::numeric BETWEEN 0.00001 AND 1 LIMIT 1), 0.001),
      COALESCE((p_changes->>'dispatch_success_rate')::integer,
        (SELECT (config_value::numeric * 100)::integer FROM public.admin_configs
         WHERE admin_id IS NULL AND config_type = 'success_rate'
           AND config_value ~ '^[0-9]+(\.[0-9]+)?$'
           AND config_value::numeric BETWEEN 0 AND 1 LIMIT 1), 100)
    ) RETURNING$patch$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch group insert values changed.'; END IF;
  v_source := replace(v_source, v_old, v_new);
  v_old := 'submit_wait_max_seconds = v_wait_max,
        updated_at';
  v_new := $patch$submit_wait_max_seconds = v_wait_max,
        commission_rate = COALESCE((p_changes->>'commission_rate')::numeric, commission_rate),
        dispatch_success_rate = COALESCE((p_changes->>'dispatch_success_rate')::integer, dispatch_success_rate),
        updated_at$patch$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch group update changed.'; END IF;
  EXECUTE replace(v_source, v_old, v_new);

  SELECT pg_get_functiondef('public.admin_save_dispatch_pool(uuid,uuid,uuid,jsonb)'::regprocedure) INTO v_source;
  v_old := $anchor$'dispatch_success_rate', 'archived_at'$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch pool whitelist changed.'; END IF;
  v_source := replace(v_source, v_old, $anchor$'archived_at'$anchor$);
  v_old := $anchor$'dispatch_interval_max',
                      'dispatch_success_rate'$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch pool validation changed.'; END IF;
  v_source := replace(v_source, v_old, $anchor$'dispatch_interval_max'$anchor$);
  v_old := 'dispatch_order_mode, dispatch_success_rate, created_by';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch pool insert columns changed.'; END IF;
  v_source := replace(v_source, v_old, 'dispatch_order_mode, created_by');
  v_old := $anchor$COALESCE((p_changes->>'dispatch_success_rate')::integer, 100), v_admin_id$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch pool insert values changed.'; END IF;
  v_source := replace(v_source, v_old, 'v_admin_id');
  v_old := $anchor$        dispatch_success_rate = COALESCE((p_changes->>'dispatch_success_rate')::integer,
                                         dispatch_success_rate),
$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch pool update changed.'; END IF;
  EXECUTE replace(v_source, v_old, '');

  SELECT pg_get_functiondef('public.prepare_next_dispatch_order_secure(uuid,uuid,text,uuid)'::regprocedure) INTO v_source;
  v_old := 'dispatch_group.session_timeout_minutes
  INTO v_group';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch preparation group selection changed.'; END IF;
  v_source := replace(v_source, v_old, 'dispatch_group.session_timeout_minutes, dispatch_group.dispatch_success_rate
  INTO v_group');
  v_old := $anchor$'dispatch_success_rate', v_pool.dispatch_success_rate$anchor$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch preparation config changed.'; END IF;
  EXECUTE replace(v_source, v_old, $anchor$'dispatch_success_rate', v_group.dispatch_success_rate$anchor$);

  SELECT pg_get_functiondef('public.assign_next_dispatch_order_secure(uuid,uuid,text,uuid,uuid,text)'::regprocedure) INTO v_source;
  v_old := 'dispatch_group.submit_wait_min_seconds, dispatch_group.submit_wait_max_seconds
  INTO v_group';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch assignment group selection changed.'; END IF;
  v_source := replace(v_source, v_old, 'dispatch_group.submit_wait_min_seconds, dispatch_group.submit_wait_max_seconds,
         dispatch_group.commission_rate, dispatch_group.dispatch_success_rate
  INTO v_group');
  v_old := 'dispatch_success_rate_snapshot, session_timeout_minutes_snapshot,
    submit_wait_min_seconds_snapshot';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch assignment snapshot columns changed.'; END IF;
  v_source := replace(v_source, v_old, 'dispatch_success_rate_snapshot, commission_rate_snapshot, session_timeout_minutes_snapshot,
    submit_wait_min_seconds_snapshot');
  v_old := 'v_pool.dispatch_success_rate, v_group.session_timeout_minutes';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Dispatch assignment snapshot values changed.'; END IF;
  EXECUTE replace(v_source, v_old, 'v_group.dispatch_success_rate, v_group.commission_rate, v_group.session_timeout_minutes');

  SELECT pg_get_functiondef('public.process_pending_orders()'::regprocedure) INTO v_source;
  IF strpos(v_source, 'SELECT COALESCE(') = 0
     OR strpos(v_source, ')::numeric INTO v_commission_rate;') = 0 THEN
    RAISE EXCEPTION 'Order commission decision changed; review before migration.';
  END IF;
  v_old := substring(v_source FROM strpos(v_source, 'SELECT COALESCE(')
    FOR strpos(v_source, ')::numeric INTO v_commission_rate;')
      - strpos(v_source, 'SELECT COALESCE(') + length(')::numeric INTO v_commission_rate;'));
  v_new := $patch$SELECT COALESCE(
  (SELECT dispatch_commission_rate_snapshot FROM public.orders WHERE id = v_order.id),
  (SELECT config_value::numeric FROM public.admin_configs
   WHERE admin_id = v_user.created_by AND config_type = 'commission_rate' LIMIT 1),
  (SELECT config_value::numeric FROM public.admin_configs
   WHERE admin_id IS NULL AND config_type = 'commission_rate' LIMIT 1), 0
) INTO v_commission_rate;$patch$;
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Order commission decision changed; review before migration.'; END IF;
  v_source := replace(v_source, v_old, v_new);
  v_old := 'v_success_rate := LEAST(GREATEST(COALESCE(
      (SELECT assignment.dispatch_success_rate_snapshot::numeric / 100';
  v_new := 'v_success_rate := LEAST(GREATEST(COALESCE(
      (SELECT dispatch_success_rate_snapshot::numeric / 100 FROM public.orders WHERE id = v_order.id),
      (SELECT assignment.dispatch_success_rate_snapshot::numeric / 100';
  IF strpos(v_source, v_old) = 0 THEN RAISE EXCEPTION 'Order success decision changed; review before migration.'; END IF;
  EXECUTE replace(v_source, v_old, v_new);
END;
$block$;
