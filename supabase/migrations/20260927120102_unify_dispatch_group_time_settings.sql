-- Freeze historical timeouts before replacing group values with their base-pool values.
-- Never overwrite a timeout already captured by an assignment.
UPDATE public.dispatch_assignments AS assignment
SET session_timeout_minutes_snapshot = COALESCE(
  (SELECT existing_pool.session_timeout_minutes
   FROM public.dispatch_order_pools AS existing_pool
   WHERE existing_pool.id = assignment.pool_id),
  pool.session_timeout_minutes,
  (SELECT original_group.session_timeout_minutes
   FROM public.dispatch_groups AS original_group
   WHERE original_group.id = assignment.group_id),
  dispatch_group.session_timeout_minutes, 10)
FROM public.dispatch_group_orders AS dispatch_order
LEFT JOIN public.dispatch_order_pools AS pool ON pool.id = dispatch_order.pool_id
LEFT JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id = dispatch_order.group_id
WHERE assignment.dispatch_order_id = dispatch_order.id
  AND assignment.session_timeout_minutes_snapshot IS NULL;

-- Assignments whose order was deleted can still have a pool/group snapshot.
UPDATE public.dispatch_assignments AS assignment
SET session_timeout_minutes_snapshot = COALESCE(
  (SELECT pool.session_timeout_minutes
   FROM public.dispatch_order_pools AS pool WHERE pool.id = assignment.pool_id),
  (SELECT dispatch_group.session_timeout_minutes
   FROM public.dispatch_groups AS dispatch_group WHERE dispatch_group.id = assignment.group_id),
  10)
WHERE assignment.session_timeout_minutes_snapshot IS NULL;

-- Pool timeout remains a historical column, not an editable pool setting.
UPDATE public.dispatch_groups AS dispatch_group
SET session_timeout_minutes = pool.session_timeout_minutes
FROM public.dispatch_order_pools AS pool
WHERE pool.group_id = dispatch_group.id AND pool.is_base;
UPDATE public.dispatch_groups
SET session_timeout_minutes = 10
WHERE session_timeout_minutes IS NULL;
ALTER TABLE public.dispatch_groups
  ALTER COLUMN session_timeout_minutes SET DEFAULT 10,
  ALTER COLUMN session_timeout_minutes SET NOT NULL,
  ADD COLUMN submit_wait_min_seconds integer NOT NULL DEFAULT 5
    CONSTRAINT dispatch_groups_submit_wait_min_seconds_check
      CHECK (submit_wait_min_seconds BETWEEN 3 AND 120),
  ADD COLUMN submit_wait_max_seconds integer NOT NULL DEFAULT 20
    CONSTRAINT dispatch_groups_submit_wait_max_seconds_check
      CHECK (submit_wait_max_seconds BETWEEN 3 AND 300);
ALTER TABLE public.dispatch_groups
  ADD CONSTRAINT dispatch_groups_submit_wait_range_check
    CHECK (submit_wait_min_seconds <= submit_wait_max_seconds);

-- Seed existing groups only from GLOBAL configuration; ignore all admin- and
-- employee-specific submit-time settings. Invalid or inverted pairs use 5/20.
DO $block$
DECLARE
  v_min_text text;
  v_max_text text;
  v_min integer := 5;
  v_max integer := 20;
BEGIN
  SELECT config_value INTO v_min_text
  FROM public.admin_configs
  WHERE admin_id IS NULL AND config_type = 'order_submit_time_min'
  ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1;
  SELECT config_value INTO v_max_text
  FROM public.admin_configs
  WHERE admin_id IS NULL AND config_type = 'order_submit_time_max'
  ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1;

  IF v_min_text ~ '^[0-9]{1,3}$' THEN
    IF v_min_text::integer BETWEEN 3 AND 120 THEN
      v_min := v_min_text::integer;
    END IF;
  END IF;
  IF v_max_text ~ '^[0-9]{1,3}$' THEN
    IF v_max_text::integer BETWEEN 3 AND 300 THEN
      v_max := v_max_text::integer;
    END IF;
  END IF;
  IF v_min > v_max THEN
    v_min := 5;
    v_max := 20;
  END IF;
  UPDATE public.dispatch_groups
  SET submit_wait_min_seconds = v_min, submit_wait_max_seconds = v_max;
END;
$block$;

ALTER TABLE public.dispatch_assignments
  ADD COLUMN submit_wait_min_seconds_snapshot integer
    CONSTRAINT dispatch_assignments_submit_wait_min_seconds_snapshot_check
      CHECK (submit_wait_min_seconds_snapshot BETWEEN 3 AND 120),
  ADD COLUMN submit_wait_max_seconds_snapshot integer
    CONSTRAINT dispatch_assignments_submit_wait_max_seconds_snapshot_check
      CHECK (submit_wait_max_seconds_snapshot BETWEEN 3 AND 300);
ALTER TABLE public.dispatch_assignments
  ADD CONSTRAINT dispatch_assignments_submit_wait_snapshot_range_check
    CHECK (submit_wait_min_seconds_snapshot <= submit_wait_max_seconds_snapshot);

CREATE OR REPLACE FUNCTION public.admin_save_dispatch_group(
  p_admin_session_token uuid, p_group_id uuid, p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_group public.dispatch_groups%ROWTYPE;
  v_field record;
  v_wait_min integer;
  v_wait_max integer;
BEGIN
  SELECT admin_id, admin_role INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_admin_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can edit dispatch groups.';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_changes) AS field(name)
    WHERE name <> ALL (ARRAY['group_name', 'description', 'pool_selection_mode',
                             'is_active', 'archived_at', 'session_timeout_minutes',
                             'submit_wait_min_seconds', 'submit_wait_max_seconds'])
  ) THEN
    RAISE EXCEPTION 'Invalid dispatch group changes.';
  END IF;
  IF (p_changes ? 'group_name' AND
        (jsonb_typeof(p_changes->'group_name') <> 'string' OR
         nullif(btrim(p_changes->>'group_name'), '') IS NULL))
     OR (p_changes ? 'description' AND jsonb_typeof(p_changes->'description') NOT IN ('string', 'null'))
     OR (p_changes ? 'pool_selection_mode' AND
         (jsonb_typeof(p_changes->'pool_selection_mode') <> 'string' OR
          p_changes->>'pool_selection_mode' NOT IN ('base', 'random')))
     OR (p_changes ? 'is_active' AND jsonb_typeof(p_changes->'is_active') <> 'boolean')
     OR (p_changes ? 'archived_at' AND jsonb_typeof(p_changes->'archived_at') NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'Invalid dispatch group field value.';
  END IF;
  FOR v_field IN
    SELECT field.name, field.value
    FROM jsonb_each(p_changes) AS field(name, value)
    WHERE field.name IN ('session_timeout_minutes', 'submit_wait_min_seconds',
                         'submit_wait_max_seconds')
  LOOP
    IF jsonb_typeof(v_field.value) <> 'number'
       OR v_field.value::text !~ '^[0-9]{1,3}$' THEN
      RAISE EXCEPTION 'Invalid dispatch group time setting.';
    END IF;
    IF (v_field.name = 'session_timeout_minutes' AND
        v_field.value::text::integer NOT BETWEEN 1 AND 60)
       OR (v_field.name = 'submit_wait_min_seconds' AND
           v_field.value::text::integer NOT BETWEEN 3 AND 120)
       OR (v_field.name = 'submit_wait_max_seconds' AND
           v_field.value::text::integer NOT BETWEEN 3 AND 300) THEN
      RAISE EXCEPTION 'Dispatch group time setting is out of range.';
    END IF;
  END LOOP;

  IF p_group_id IS NULL THEN
    IF nullif(btrim(p_changes->>'group_name'), '') IS NULL
       OR (p_changes ? 'archived_at' AND p_changes->>'archived_at' IS NOT NULL) THEN
      RAISE EXCEPTION 'New groups require a name and cannot start archived.';
    END IF;
    v_wait_min := COALESCE((p_changes->>'submit_wait_min_seconds')::integer, 5);
    v_wait_max := COALESCE((p_changes->>'submit_wait_max_seconds')::integer, 20);
    IF v_wait_min > v_wait_max THEN
      RAISE EXCEPTION 'Minimum submit wait cannot exceed maximum submit wait.';
    END IF;
    INSERT INTO public.dispatch_groups (
      group_name, description, pool_selection_mode, is_active, created_by,
      session_timeout_minutes, submit_wait_min_seconds, submit_wait_max_seconds
    ) VALUES (
      btrim(p_changes->>'group_name'), p_changes->>'description',
      COALESCE(p_changes->>'pool_selection_mode', 'base'),
      COALESCE((p_changes->>'is_active')::boolean, true), v_admin_id,
      COALESCE((p_changes->>'session_timeout_minutes')::integer, 10),
      v_wait_min, v_wait_max
    ) RETURNING * INTO v_group;
  ELSE
    SELECT * INTO v_group FROM public.dispatch_groups WHERE id = p_group_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Dispatch group not found.';
    END IF;
    IF v_group.is_default AND p_changes ? 'archived_at'
       AND p_changes->>'archived_at' IS NOT NULL THEN
      RAISE EXCEPTION 'The default dispatch group cannot be archived.';
    END IF;
    v_wait_min := COALESCE((p_changes->>'submit_wait_min_seconds')::integer,
                           v_group.submit_wait_min_seconds);
    v_wait_max := COALESCE((p_changes->>'submit_wait_max_seconds')::integer,
                           v_group.submit_wait_max_seconds);
    IF v_wait_min > v_wait_max THEN
      RAISE EXCEPTION 'Minimum submit wait cannot exceed maximum submit wait.';
    END IF;
    UPDATE public.dispatch_groups
    SET group_name = CASE WHEN p_changes ? 'group_name'
                      THEN btrim(p_changes->>'group_name') ELSE group_name END,
        description = CASE WHEN p_changes ? 'description'
                      THEN p_changes->>'description' ELSE description END,
        pool_selection_mode = COALESCE(p_changes->>'pool_selection_mode', pool_selection_mode),
        is_active = COALESCE((p_changes->>'is_active')::boolean, is_active),
        archived_at = CASE WHEN p_changes ? 'archived_at'
                      THEN CASE WHEN p_changes->>'archived_at' IS NULL THEN NULL
                                ELSE clock_timestamp() END ELSE archived_at END,
        session_timeout_minutes = COALESCE((p_changes->>'session_timeout_minutes')::integer,
                                           session_timeout_minutes),
        submit_wait_min_seconds = v_wait_min,
        submit_wait_max_seconds = v_wait_max,
        updated_at = clock_timestamp()
    WHERE id = p_group_id
    RETURNING * INTO v_group;
  END IF;
  RETURN jsonb_build_object('group', to_jsonb(v_group));
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_save_dispatch_pool(
  p_admin_session_token uuid, p_group_id uuid, p_pool_id uuid, p_changes jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_pool public.dispatch_order_pools%ROWTYPE;
BEGIN
  SELECT admin_id, admin_role INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_admin_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can edit dispatch pools.';
  END IF;
  IF p_group_id IS NULL OR p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_object_keys(p_changes) AS field(name)
       WHERE name <> ALL (ARRAY['pool_name', 'is_active', 'dispatch_interval_min',
                                'dispatch_interval_max', 'dispatch_order_mode',
                                'dispatch_success_rate', 'archived_at'])
     ) THEN
    RAISE EXCEPTION 'Invalid dispatch pool changes.';
  END IF;
  IF (p_changes ? 'pool_name' AND nullif(btrim(p_changes->>'pool_name'), '') IS NULL)
     OR (p_changes ? 'is_active' AND jsonb_typeof(p_changes->'is_active') IS DISTINCT FROM 'boolean')
     OR (p_changes ? 'dispatch_order_mode' AND
         (p_changes->>'dispatch_order_mode' IS NULL OR
          p_changes->>'dispatch_order_mode' NOT IN ('random', 'sequential')))
     OR (p_changes ? 'archived_at' AND jsonb_typeof(p_changes->'archived_at') NOT IN ('string', 'null'))
     OR EXISTS (
       SELECT 1 FROM jsonb_each(p_changes) AS field(name, value)
       WHERE name IN ('dispatch_interval_min', 'dispatch_interval_max',
                      'dispatch_success_rate')
         AND (jsonb_typeof(value) <> 'number' OR value::text !~ '^[0-9]+$')
     ) THEN
    RAISE EXCEPTION 'Invalid dispatch pool field value.';
  END IF;

  -- Lock the parent before editing its pool; archived groups cannot gain pools.
  PERFORM 1 FROM public.dispatch_groups
  WHERE id = p_group_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispatch group not found or archived.';
  END IF;

  IF p_pool_id IS NULL THEN
    IF nullif(btrim(p_changes->>'pool_name'), '') IS NULL
       OR (p_changes ? 'archived_at' AND p_changes->>'archived_at' IS NOT NULL) THEN
      RAISE EXCEPTION 'New pools require a name and cannot start archived.';
    END IF;
    INSERT INTO public.dispatch_order_pools (
      group_id, pool_name, is_active, dispatch_interval_min, dispatch_interval_max,
      dispatch_order_mode, dispatch_success_rate, created_by
    ) VALUES (
      p_group_id, btrim(p_changes->>'pool_name'),
      COALESCE((p_changes->>'is_active')::boolean, true),
      COALESCE((p_changes->>'dispatch_interval_min')::integer, 30),
      COALESCE((p_changes->>'dispatch_interval_max')::integer, 120),
      COALESCE(p_changes->>'dispatch_order_mode', 'random'),
      COALESCE((p_changes->>'dispatch_success_rate')::integer, 100), v_admin_id
    ) RETURNING * INTO v_pool;
  ELSE
    SELECT * INTO v_pool FROM public.dispatch_order_pools
    WHERE id = p_pool_id AND group_id = p_group_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Pool does not belong to this dispatch group.';
    END IF;
    IF v_pool.is_base AND p_changes ? 'archived_at'
       AND p_changes->>'archived_at' IS NOT NULL THEN
      RAISE EXCEPTION 'The base pool cannot be archived.';
    END IF;
    UPDATE public.dispatch_order_pools
    SET pool_name = CASE WHEN p_changes ? 'pool_name'
                    THEN btrim(p_changes->>'pool_name') ELSE pool_name END,
        is_active = COALESCE((p_changes->>'is_active')::boolean, is_active),
        dispatch_interval_min = COALESCE((p_changes->>'dispatch_interval_min')::integer,
                                         dispatch_interval_min),
        dispatch_interval_max = COALESCE((p_changes->>'dispatch_interval_max')::integer,
                                         dispatch_interval_max),
        dispatch_order_mode = COALESCE(p_changes->>'dispatch_order_mode', dispatch_order_mode),
        dispatch_success_rate = COALESCE((p_changes->>'dispatch_success_rate')::integer,
                                         dispatch_success_rate),
        archived_at = CASE WHEN p_changes ? 'archived_at'
                      THEN CASE WHEN p_changes->>'archived_at' IS NULL THEN NULL
                                ELSE clock_timestamp() END ELSE archived_at END,
        updated_at = clock_timestamp()
    WHERE id = p_pool_id AND group_id = p_group_id
    RETURNING * INTO v_pool;
  END IF;
  RETURN jsonb_build_object('pool', to_jsonb(v_pool));
END;
$function$;

-- Keep pool selection and due-time behavior unchanged; expose group timeout.
CREATE OR REPLACE FUNCTION public.prepare_next_dispatch_order_secure(
  p_user_id uuid, p_session_token uuid, p_tab_id text, p_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_session record;
  v_group record;
  v_pool public.dispatch_order_pools%ROWTYPE;
  v_selection public.dispatch_pool_selections%ROWTYPE;
  v_selected_at timestamptz;
  v_due_at timestamptz;
BEGIN
  SELECT dispatch_session.id, dispatch_session.consecutive_unaccepted_count
  INTO v_session
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  JOIN public.dispatch_sessions AS dispatch_session
    ON dispatch_session.id = p_session_id AND dispatch_session.user_id = employee.id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true
    AND dispatch_session.status = 'online'
    AND dispatch_session.ended_at IS NULL
    AND dispatch_session.last_activity_at >= now() - interval '2 minutes'
  FOR UPDATE OF financial_session, employee, dispatch_session;
  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'Employee work session is invalid, offline, or stale.';
  END IF;
  IF v_session.consecutive_unaccepted_count >= 5 THEN
    PERFORM private.close_dispatch_session_from_system(p_session_id, clock_timestamp());
    RETURN jsonb_build_object('available', false,
      'message', 'Work stopped after five consecutive unaccepted orders.', 'auto_stopped', true);
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_assignments
             WHERE user_id = p_user_id AND status IN ('pending', 'accepted')) THEN
    RETURN jsonb_build_object('available', false, 'message', 'An active dispatch assignment already exists.');
  END IF;

  SELECT dispatch_group.id, dispatch_group.pool_selection_mode,
         dispatch_group.session_timeout_minutes
  INTO v_group
  FROM public.dispatch_group_members AS member
  JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id = member.group_id
  WHERE member.user_id = p_user_id
    AND dispatch_group.is_active AND dispatch_group.archived_at IS NULL
  FOR SHARE OF member, dispatch_group;
  IF v_group.id IS NULL THEN
    DELETE FROM public.dispatch_pool_selections WHERE session_id = p_session_id;
    RETURN jsonb_build_object('available', false, 'message', 'No active dispatch group assigned.');
  END IF;

  SELECT * INTO v_selection FROM public.dispatch_pool_selections
  WHERE session_id = p_session_id FOR UPDATE;
  IF v_selection.session_id IS NOT NULL THEN
    SELECT * INTO v_pool FROM public.dispatch_order_pools AS pool
    WHERE pool.id = v_selection.pool_id AND pool.group_id = v_group.id
      AND v_selection.user_id = p_user_id
      AND pool.is_active AND pool.archived_at IS NULL
      AND (v_group.pool_selection_mode = 'random' OR pool.is_base)
      AND EXISTS (
        SELECT 1 FROM public.dispatch_group_orders AS dispatch_order
        WHERE dispatch_order.pool_id = pool.id AND dispatch_order.is_active
          AND dispatch_order.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.dispatch_assignments AS assignment
            WHERE assignment.user_id = p_user_id AND assignment.dispatch_order_id = dispatch_order.id
          )
      );
    IF v_pool.id IS NOT NULL THEN
      v_due_at := v_selection.due_at;
    ELSE
      DELETE FROM public.dispatch_pool_selections WHERE session_id = p_session_id;
    END IF;
  END IF;

  IF v_pool.id IS NULL THEN
    SELECT pool.* INTO v_pool
    FROM public.dispatch_order_pools AS pool
    WHERE pool.group_id = v_group.id AND pool.is_active AND pool.archived_at IS NULL
      AND (v_group.pool_selection_mode = 'random' OR pool.is_base)
      AND EXISTS (
        SELECT 1 FROM public.dispatch_group_orders AS dispatch_order
        WHERE dispatch_order.pool_id = pool.id AND dispatch_order.is_active
          AND dispatch_order.archived_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.dispatch_assignments AS assignment
            WHERE assignment.user_id = p_user_id AND assignment.dispatch_order_id = dispatch_order.id
          )
      )
    ORDER BY CASE WHEN v_group.pool_selection_mode = 'random' THEN random() ELSE 0 END,
             pool.id
    LIMIT 1;
    IF v_pool.id IS NULL THEN
      RETURN jsonb_build_object('available', false, 'message', 'No active orders in pool');
    END IF;
    v_selected_at := clock_timestamp();
    v_due_at := v_selected_at + make_interval(secs =>
      v_pool.dispatch_interval_min + floor(random() *
        (v_pool.dispatch_interval_max - v_pool.dispatch_interval_min + 1))::integer);
    INSERT INTO public.dispatch_pool_selections
      (session_id, user_id, group_id, pool_id, selected_at, due_at)
    VALUES (p_session_id, p_user_id, v_group.id, v_pool.id, v_selected_at, v_due_at);
  END IF;
  RETURN jsonb_build_object(
    'available', true, 'group_id', v_group.id, 'pool_id', v_pool.id, 'due_at', v_due_at,
    'config', jsonb_build_object(
      'dispatch_interval_min', v_pool.dispatch_interval_min,
      'dispatch_interval_max', v_pool.dispatch_interval_max,
      'session_timeout_minutes', v_group.session_timeout_minutes,
      'dispatch_order_mode', v_pool.dispatch_order_mode,
      'dispatch_success_rate', v_pool.dispatch_success_rate
    )
  );
END;
$function$;

-- Keep the six-argument API and its server-side sticky selection and order lock.
CREATE OR REPLACE FUNCTION public.assign_next_dispatch_order_secure(
  p_user_id uuid, p_session_token uuid, p_tab_id text, p_session_id uuid,
  p_group_id uuid, p_dispatch_mode text DEFAULT 'random'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_session record;
  v_group record;
  v_pool public.dispatch_order_pools%ROWTYPE;
  v_selection public.dispatch_pool_selections%ROWTYPE;
  v_order record;
  v_assignment public.dispatch_assignments%ROWTYPE;
  v_assigned_at timestamptz;
  v_deadline timestamptz;
BEGIN
  SELECT dispatch_session.id, dispatch_session.consecutive_unaccepted_count
  INTO v_session
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  JOIN public.dispatch_sessions AS dispatch_session
    ON dispatch_session.id = p_session_id AND dispatch_session.user_id = employee.id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true
    AND dispatch_session.status = 'online'
    AND dispatch_session.ended_at IS NULL
    AND dispatch_session.last_activity_at >= now() - interval '2 minutes'
  FOR UPDATE OF financial_session, employee, dispatch_session;
  IF v_session.id IS NULL THEN
    RAISE EXCEPTION 'Employee work session is invalid, offline, or stale.';
  END IF;
  IF v_session.consecutive_unaccepted_count >= 5 THEN
    PERFORM private.close_dispatch_session_from_system(p_session_id, clock_timestamp());
    RETURN jsonb_build_object(
      'success', false, 'message', 'Work stopped after five consecutive unaccepted orders.',
      'auto_stopped', true, 'schedule_next', false,
      'unaccepted_count', v_session.consecutive_unaccepted_count, 'assignment', NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM public.dispatch_assignments
             WHERE user_id = p_user_id AND status IN ('pending', 'accepted')) THEN
    RETURN jsonb_build_object(
      'success', false, 'message', 'An active dispatch assignment already exists.',
      'auto_stopped', false, 'schedule_next', false,
      'unaccepted_count', v_session.consecutive_unaccepted_count, 'assignment', NULL);
  END IF;

  SELECT dispatch_group.id, dispatch_group.pool_selection_mode,
         dispatch_group.session_timeout_minutes,
         dispatch_group.submit_wait_min_seconds, dispatch_group.submit_wait_max_seconds
  INTO v_group
  FROM public.dispatch_group_members AS member
  JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id = member.group_id
  WHERE member.user_id = p_user_id AND dispatch_group.is_active
    AND dispatch_group.archived_at IS NULL
  FOR SHARE OF member, dispatch_group;
  SELECT * INTO v_selection FROM public.dispatch_pool_selections
  WHERE session_id = p_session_id FOR UPDATE;
  IF v_group.id IS NULL OR v_selection.session_id IS NULL
     OR v_selection.user_id IS DISTINCT FROM p_user_id
     OR v_selection.group_id IS DISTINCT FROM v_group.id THEN
    DELETE FROM public.dispatch_pool_selections WHERE session_id = p_session_id;
    RETURN jsonb_build_object(
      'success', false, 'message', 'A new dispatch pool selection is required.',
      'retry_selection', true, 'auto_stopped', false, 'schedule_next', true,
      'unaccepted_count', v_session.consecutive_unaccepted_count, 'assignment', NULL);
  END IF;
  IF v_selection.due_at > clock_timestamp() THEN
    RETURN jsonb_build_object(
      'success', false, 'message', 'Dispatch order is not due yet.', 'due_at', v_selection.due_at,
      'retry_selection', false, 'auto_stopped', false, 'schedule_next', false,
      'unaccepted_count', v_session.consecutive_unaccepted_count, 'assignment', NULL);
  END IF;
  SELECT * INTO v_pool FROM public.dispatch_order_pools
  WHERE id = v_selection.pool_id AND group_id = v_group.id
    AND is_active AND archived_at IS NULL
    AND (v_group.pool_selection_mode = 'random' OR is_base)
  FOR SHARE;
  IF v_pool.id IS NULL THEN
    DELETE FROM public.dispatch_pool_selections WHERE session_id = p_session_id;
    RETURN jsonb_build_object(
      'success', false, 'message', 'Selected dispatch pool is no longer active.',
      'retry_selection', true, 'auto_stopped', false, 'schedule_next', true,
      'unaccepted_count', v_session.consecutive_unaccepted_count, 'assignment', NULL);
  END IF;

  -- Lock the candidate until the assignment is inserted. No temp tables, no
  -- client-selected pool and no repeat of an order already assigned to this user.
  SELECT dispatch_order.id, dispatch_order.order_content INTO v_order
  FROM public.dispatch_group_orders AS dispatch_order
  WHERE dispatch_order.pool_id = v_pool.id AND dispatch_order.group_id = v_group.id
    AND dispatch_order.is_active AND dispatch_order.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.dispatch_assignments AS old_assignment
      WHERE old_assignment.user_id = p_user_id
        AND old_assignment.dispatch_order_id = dispatch_order.id
    )
  ORDER BY CASE WHEN v_pool.dispatch_order_mode = 'sequential'
                THEN dispatch_order.created_at END ASC NULLS LAST,
           CASE WHEN v_pool.dispatch_order_mode = 'sequential'
                THEN dispatch_order.id END ASC NULLS LAST,
           CASE WHEN v_pool.dispatch_order_mode = 'random' THEN random() END
  LIMIT 1 FOR UPDATE OF dispatch_order SKIP LOCKED;
  IF v_order.id IS NULL THEN
    DELETE FROM public.dispatch_pool_selections WHERE session_id = p_session_id;
    RETURN jsonb_build_object(
      'success', false, 'message', 'No active orders in selected pool.',
      'retry_selection', true, 'auto_stopped', false, 'schedule_next', true,
      'unaccepted_count', v_session.consecutive_unaccepted_count, 'assignment', NULL);
  END IF;
  v_assigned_at := clock_timestamp();
  v_deadline := v_assigned_at + interval '60 seconds';
  INSERT INTO public.dispatch_assignments (
    dispatch_order_id, user_id, status, assigned_at, dispatch_session_id,
    accept_deadline_at, group_id, pool_id, order_content_snapshot,
    dispatch_success_rate_snapshot, session_timeout_minutes_snapshot,
    submit_wait_min_seconds_snapshot, submit_wait_max_seconds_snapshot
  ) VALUES (
    v_order.id, p_user_id, 'pending', v_assigned_at, p_session_id,
    v_deadline, v_group.id, v_pool.id, v_order.order_content,
    v_pool.dispatch_success_rate, v_group.session_timeout_minutes,
    v_group.submit_wait_min_seconds, v_group.submit_wait_max_seconds
  ) RETURNING * INTO v_assignment;
  DELETE FROM public.dispatch_pool_selections WHERE session_id = p_session_id;
  RETURN jsonb_build_object(
    'success', true, 'auto_stopped', false, 'schedule_next', false,
    'unaccepted_count', v_session.consecutive_unaccepted_count,
    'assignment', jsonb_build_object(
      'id', v_assignment.id, 'dispatch_order_id', v_order.id,
      'order_content', v_assignment.order_content_snapshot, 'status', 'pending',
      'assigned_at', v_assignment.assigned_at, 'dispatch_session_id', p_session_id,
      'accept_deadline_at', v_deadline, 'group_id', v_group.id, 'pool_id', v_pool.id,
      'session_timeout_minutes', v_group.session_timeout_minutes
    )
  );
END;
$function$;

-- Resolve submit animation wait server-side. Accepted assignments always win over
-- current membership, including after a move to another group. Never fall back
-- to direct submission when an accepted assignment exists but is stale/invalid.
CREATE FUNCTION public.get_employee_dispatch_submit_wait_secure(
  p_user_id uuid, p_session_token uuid, p_tab_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_assignment record;
  v_group record;
  v_min integer;
  v_max integer;
BEGIN
  PERFORM 1
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL
    AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id
    AND employee.is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  SELECT assignment.id, assignment.assignment_id AS assignment_code,
         assignment.order_submitted, assignment.accepted_at, assignment.completed_at,
         assignment.session_timeout_minutes_snapshot,
         assignment.submit_wait_min_seconds_snapshot,
         assignment.submit_wait_max_seconds_snapshot,
         dispatch_group.id AS original_group_id,
         dispatch_group.session_timeout_minutes AS group_timeout_minutes,
         dispatch_group.submit_wait_min_seconds AS group_wait_min,
         dispatch_group.submit_wait_max_seconds AS group_wait_max
  INTO v_assignment
  FROM public.dispatch_assignments AS assignment
  LEFT JOIN public.dispatch_group_orders AS dispatch_order
    ON dispatch_order.id = assignment.dispatch_order_id
  LEFT JOIN public.dispatch_order_pools AS pool
    ON pool.id = COALESCE(assignment.pool_id, dispatch_order.pool_id)
  LEFT JOIN public.dispatch_groups AS dispatch_group
    ON dispatch_group.id = COALESCE(assignment.group_id, pool.group_id, dispatch_order.group_id)
  WHERE assignment.user_id = p_user_id AND assignment.status = 'accepted'
  ORDER BY assignment.assigned_at DESC, assignment.id DESC
  LIMIT 1 FOR UPDATE OF assignment;

  IF v_assignment.id IS NOT NULL THEN
    v_min := COALESCE(v_assignment.submit_wait_min_seconds_snapshot,
                      v_assignment.group_wait_min);
    v_max := COALESCE(v_assignment.submit_wait_max_seconds_snapshot,
                      v_assignment.group_wait_max);
    IF v_assignment.order_submitted IS DISTINCT FROM false
       OR nullif(btrim(v_assignment.assignment_code), '') IS NULL
       OR v_assignment.accepted_at IS NULL
       OR v_assignment.completed_at IS NOT NULL
       OR v_assignment.original_group_id IS NULL
       OR v_min IS NULL OR v_max IS NULL OR v_min > v_max
       OR v_assignment.accepted_at + make_interval(mins => COALESCE(
            v_assignment.session_timeout_minutes_snapshot,
            v_assignment.group_timeout_minutes, 10)) <= now()
       OR EXISTS (
         SELECT 1 FROM public.orders AS submitted_order
         WHERE submitted_order.assignment_id = v_assignment.assignment_code
       ) THEN
      RETURN jsonb_build_object('available', false,
        'message', 'Accepted dispatch assignment is no longer available for submission.');
    END IF;
    RETURN jsonb_build_object('available', true, 'min_seconds', v_min,
      'max_seconds', v_max, 'assignment_id', v_assignment.id,
      'assignment_code', v_assignment.assignment_code);
  END IF;

  IF EXISTS (SELECT 1 FROM public.dispatch_assignments
             WHERE user_id = p_user_id AND status = 'pending') THEN
    RETURN jsonb_build_object('available', false,
      'message', 'A dispatch assignment is awaiting acceptance.');
  END IF;

  SELECT dispatch_group.id, dispatch_group.submit_wait_min_seconds,
         dispatch_group.submit_wait_max_seconds
  INTO v_group
  FROM public.dispatch_group_members AS member
  JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id = member.group_id
  WHERE member.user_id = p_user_id
    AND dispatch_group.is_active AND dispatch_group.archived_at IS NULL
  FOR SHARE OF member, dispatch_group;
  IF v_group.id IS NULL THEN
    RETURN jsonb_build_object('available', false, 'message', 'No active dispatch group assigned.');
  END IF;
  RETURN jsonb_build_object('available', true,
    'min_seconds', v_group.submit_wait_min_seconds,
    'max_seconds', v_group.submit_wait_max_seconds,
    'assignment_id', NULL, 'assignment_code', NULL);
END;
$function$;

-- Keep legacy rows available to readers, but stop API clients writing either
-- legacy submit-time table. Leave unrelated admin_configs keys untouched.
REVOKE ALL ON TABLE public.submit_time_groups, public.employee_submit_time_settings
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.submit_time_groups, public.employee_submit_time_settings
  TO anon, authenticated;
DO $block$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT schemaname, tablename, policyname
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('submit_time_groups', 'employee_submit_time_settings')
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I',
      v_policy.policyname, v_policy.schemaname, v_policy.tablename);
  END LOOP;
END;
$block$;
CREATE POLICY "Read legacy submit time groups" ON public.submit_time_groups
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Read legacy employee submit time settings" ON public.employee_submit_time_settings
  FOR SELECT TO anon, authenticated USING (true);

REVOKE ALL ON FUNCTION public.get_employee_dispatch_submit_wait_secure(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_dispatch_submit_wait_secure(uuid, uuid, text)
  TO anon, authenticated;
