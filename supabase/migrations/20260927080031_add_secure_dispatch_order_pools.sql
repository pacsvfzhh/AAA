-- Pools are shared across administrators. All writes below require a financial session;
-- legacy group configuration remains on dispatch_groups solely for compatibility.
ALTER TABLE public.dispatch_groups
  ADD COLUMN pool_selection_mode text NOT NULL DEFAULT 'base'
    CHECK (pool_selection_mode IN ('base', 'random')),
  ADD COLUMN archived_at timestamptz;

CREATE TABLE public.dispatch_order_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.dispatch_groups(id) ON DELETE RESTRICT,
  pool_name text NOT NULL CHECK (length(btrim(pool_name)) > 0),
  is_base boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  dispatch_interval_min integer NOT NULL DEFAULT 30 CHECK (dispatch_interval_min BETWEEN 1 AND 3000),
  dispatch_interval_max integer NOT NULL DEFAULT 120 CHECK (dispatch_interval_max BETWEEN 1 AND 3000),
  session_timeout_minutes integer NOT NULL DEFAULT 10 CHECK (session_timeout_minutes BETWEEN 1 AND 60),
  dispatch_order_mode text NOT NULL DEFAULT 'random' CHECK (dispatch_order_mode IN ('random', 'sequential')),
  dispatch_success_rate integer NOT NULL DEFAULT 100 CHECK (dispatch_success_rate BETWEEN 0 AND 100),
  archived_at timestamptz,
  created_by uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dispatch_order_pools_interval_check CHECK (dispatch_interval_min <= dispatch_interval_max),
  CONSTRAINT dispatch_order_pools_group_name_key UNIQUE (group_id, pool_name),
  CONSTRAINT dispatch_order_pools_id_group_key UNIQUE (id, group_id),
  CONSTRAINT dispatch_order_pools_base_not_archived CHECK (NOT is_base OR archived_at IS NULL)
);

CREATE UNIQUE INDEX dispatch_order_pools_one_base_per_group
  ON public.dispatch_order_pools(group_id) WHERE is_base;
CREATE INDEX dispatch_order_pools_active_group_idx
  ON public.dispatch_order_pools(group_id) WHERE is_active AND archived_at IS NULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.dispatch_order_pools;

-- The trigger supplies the mandatory base pool for every subsequently created group.
-- Base identity/group are immutable and a base pool cannot be deleted or archived.
CREATE FUNCTION private.guard_dispatch_pool_base()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_base THEN
      RAISE EXCEPTION 'Base dispatch pools cannot be deleted.';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.is_base IS DISTINCT FROM OLD.is_base OR NEW.group_id IS DISTINCT FROM OLD.group_id THEN
    RAISE EXCEPTION 'Dispatch pool group and base identity cannot be changed.';
  END IF;
  IF NEW.is_base AND NEW.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Base dispatch pools cannot be archived.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER guard_dispatch_pool_base
BEFORE UPDATE OR DELETE ON public.dispatch_order_pools
FOR EACH ROW EXECUTE FUNCTION private.guard_dispatch_pool_base();

CREATE FUNCTION private.create_dispatch_base_pool()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.dispatch_order_pools (
    group_id, pool_name, is_base, is_active, dispatch_interval_min,
    dispatch_interval_max, session_timeout_minutes, dispatch_order_mode,
    dispatch_success_rate, created_by
  ) VALUES (
    NEW.id, 'Base', true, true,
    LEAST(COALESCE(NEW.dispatch_interval_min, 30), COALESCE(NEW.dispatch_interval_max, 120)),
    GREATEST(COALESCE(NEW.dispatch_interval_min, 30), COALESCE(NEW.dispatch_interval_max, 120)),
    COALESCE(NEW.session_timeout_minutes, 10),
    COALESCE(NEW.dispatch_order_mode, 'random'),
    COALESCE(NEW.dispatch_success_rate, 100), NEW.created_by
  );
  RETURN NEW;
END;
$function$;

CREATE TRIGGER create_dispatch_base_pool
AFTER INSERT ON public.dispatch_groups
FOR EACH ROW EXECUTE FUNCTION private.create_dispatch_base_pool();

INSERT INTO public.dispatch_order_pools (
  group_id, pool_name, is_base, is_active, dispatch_interval_min,
  dispatch_interval_max, session_timeout_minutes, dispatch_order_mode,
  dispatch_success_rate, created_by
)
SELECT group_id.id, 'Base', true, true,
       LEAST(COALESCE(group_id.dispatch_interval_min, 30),
             COALESCE(group_id.dispatch_interval_max, 120)),
       GREATEST(COALESCE(group_id.dispatch_interval_min, 30),
                COALESCE(group_id.dispatch_interval_max, 120)),
       COALESCE(group_id.session_timeout_minutes, 10),
       COALESCE(group_id.dispatch_order_mode, 'random'),
       COALESCE(group_id.dispatch_success_rate, 100), group_id.created_by
FROM public.dispatch_groups AS group_id
WHERE true
ON CONFLICT DO NOTHING;

ALTER TABLE public.dispatch_group_orders
  ADD COLUMN pool_id uuid,
  ADD COLUMN archived_at timestamptz;

UPDATE public.dispatch_group_orders AS dispatch_order
SET pool_id = pool.id
FROM public.dispatch_order_pools AS pool
WHERE pool.group_id = dispatch_order.group_id AND pool.is_base;

ALTER TABLE public.dispatch_group_orders
  ALTER COLUMN pool_id SET NOT NULL,
  ADD CONSTRAINT dispatch_group_orders_pool_group_fkey
    FOREIGN KEY (pool_id, group_id)
    REFERENCES public.dispatch_order_pools(id, group_id) ON DELETE RESTRICT;
CREATE INDEX dispatch_group_orders_available_pool_idx
  ON public.dispatch_group_orders(pool_id, created_at, id)
  WHERE is_active AND archived_at IS NULL;

ALTER TABLE public.dispatch_assignments
  ADD COLUMN group_id uuid REFERENCES public.dispatch_groups(id) ON DELETE RESTRICT,
  ADD COLUMN pool_id uuid REFERENCES public.dispatch_order_pools(id) ON DELETE RESTRICT,
  ADD COLUMN order_content_snapshot text,
  ADD COLUMN dispatch_success_rate_snapshot integer
    CHECK (dispatch_success_rate_snapshot BETWEEN 0 AND 100),
  ADD COLUMN session_timeout_minutes_snapshot integer
    CHECK (session_timeout_minutes_snapshot BETWEEN 1 AND 60);

UPDATE public.dispatch_assignments AS assignment
SET group_id = dispatch_order.group_id,
    pool_id = dispatch_order.pool_id,
    order_content_snapshot = dispatch_order.order_content,
    dispatch_success_rate_snapshot = pool.dispatch_success_rate,
    session_timeout_minutes_snapshot = pool.session_timeout_minutes
FROM public.dispatch_group_orders AS dispatch_order
JOIN public.dispatch_order_pools AS pool ON pool.id = dispatch_order.pool_id
WHERE assignment.dispatch_order_id = dispatch_order.id;

-- Soft order removal is the normal path; even if an order is removed by a
-- privileged maintenance job, its assignments (and their snapshots) survive.
ALTER TABLE public.dispatch_assignments
  DROP CONSTRAINT dispatch_assignments_dispatch_order_id_fkey;
ALTER TABLE public.dispatch_assignments
  ADD CONSTRAINT dispatch_assignments_dispatch_order_id_fkey
  FOREIGN KEY (dispatch_order_id) REFERENCES public.dispatch_group_orders(id)
  ON DELETE SET NULL;
CREATE INDEX dispatch_assignments_pool_idx ON public.dispatch_assignments(pool_id);
CREATE INDEX dispatch_assignments_group_idx ON public.dispatch_assignments(group_id);

-- Membership must be unique per employee so reassignment can update the same row.
CREATE UNIQUE INDEX dispatch_group_members_one_group_per_user
  ON public.dispatch_group_members(user_id);

-- Historical groups may have members already. Only genuinely unmapped users
-- enter the existing default group; an inactive membership never falls back.
INSERT INTO public.dispatch_group_members (group_id, user_id)
SELECT default_group.id, employee.id
FROM public.users AS employee
CROSS JOIN LATERAL (
  SELECT id FROM public.dispatch_groups
  WHERE is_default AND archived_at IS NULL
  ORDER BY created_at, id LIMIT 1
) AS default_group
WHERE NOT EXISTS (
  SELECT 1 FROM public.dispatch_group_members AS member WHERE member.user_id = employee.id
)
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE public.dispatch_pool_selections (
  session_id uuid PRIMARY KEY REFERENCES public.dispatch_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  group_id uuid NOT NULL REFERENCES public.dispatch_groups(id) ON DELETE RESTRICT,
  pool_id uuid NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  due_at timestamptz NOT NULL,
  CONSTRAINT dispatch_pool_selections_due_check CHECK (due_at > selected_at),
  CONSTRAINT dispatch_pool_selections_pool_group_fkey FOREIGN KEY (pool_id, group_id)
    REFERENCES public.dispatch_order_pools(id, group_id) ON DELETE RESTRICT
);
CREATE INDEX dispatch_pool_selections_pool_idx ON public.dispatch_pool_selections(pool_id);
CREATE INDEX dispatch_pool_selections_user_idx ON public.dispatch_pool_selections(user_id);

ALTER TABLE public.dispatch_order_pools ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispatch_pool_selections ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.dispatch_groups, public.dispatch_order_pools,
  public.dispatch_group_orders, public.dispatch_group_members, public.dispatch_pool_selections
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.dispatch_groups, public.dispatch_order_pools,
  public.dispatch_group_orders, public.dispatch_group_members TO anon, authenticated;

-- Retain existing employee/admin SELECT policies but remove every direct write
-- policy, including any historical FOR ALL policy on these four tables.
DO $block$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT schemaname, tablename, policyname
    FROM pg_catalog.pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('dispatch_groups', 'dispatch_order_pools',
                        'dispatch_group_orders', 'dispatch_group_members',
                        'dispatch_pool_selections')
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I',
      v_policy.policyname, v_policy.schemaname, v_policy.tablename);
  END LOOP;
END;
$block$;
CREATE POLICY "Read dispatch pools" ON public.dispatch_order_pools
  FOR SELECT TO anon, authenticated USING (true);

REVOKE ALL ON FUNCTION private.guard_dispatch_pool_base() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.create_dispatch_base_pool() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.assign_next_dispatch_order(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.batch_delete_dispatch_orders(uuid, integer)
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_check_pool_health_on_deactivate ON public.dispatch_group_orders;

CREATE OR REPLACE FUNCTION public.auto_check_pool_health()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_group record;
  v_health json;
BEGIN
  FOR v_group IN
    SELECT DISTINCT new_order.group_id
    FROM old_dispatch_group_orders AS old_order
    JOIN new_dispatch_group_orders AS new_order ON new_order.id = old_order.id
    WHERE old_order.is_active IS TRUE AND new_order.is_active IS FALSE
  LOOP
    v_health := public.check_dispatch_pool_health(v_group.group_id);
    IF v_health->>'health_status' IN ('WARNING', 'CRITICAL') THEN
      INSERT INTO public.dispatch_system_logs (log_type, event_name, event_data)
      VALUES ('health_check', 'pool_health_alert', v_health::jsonb);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$function$;

CREATE TRIGGER trigger_check_pool_health_on_deactivate
AFTER UPDATE ON public.dispatch_group_orders
REFERENCING OLD TABLE AS old_dispatch_group_orders NEW TABLE AS new_dispatch_group_orders
FOR EACH STATEMENT EXECUTE FUNCTION public.auto_check_pool_health();

REVOKE ALL ON FUNCTION public.auto_check_pool_health() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.admin_save_dispatch_group(
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
BEGIN
  SELECT admin_id, admin_role INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_admin_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can edit dispatch groups.';
  END IF;
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' OR EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_changes) AS field(name)
    WHERE name <> ALL (ARRAY['group_name', 'description', 'pool_selection_mode',
                             'is_active', 'archived_at'])
  ) THEN
    RAISE EXCEPTION 'Invalid dispatch group changes.';
  END IF;
  IF (p_changes ? 'group_name' AND nullif(btrim(p_changes->>'group_name'), '') IS NULL)
     OR (p_changes ? 'pool_selection_mode' AND
         (p_changes->>'pool_selection_mode' IS NULL OR
          p_changes->>'pool_selection_mode' NOT IN ('base', 'random')))
     OR (p_changes ? 'is_active' AND jsonb_typeof(p_changes->'is_active') IS DISTINCT FROM 'boolean')
     OR (p_changes ? 'archived_at' AND jsonb_typeof(p_changes->'archived_at') NOT IN ('string', 'null')) THEN
    RAISE EXCEPTION 'Invalid dispatch group field value.';
  END IF;

  IF p_group_id IS NULL THEN
    IF nullif(btrim(p_changes->>'group_name'), '') IS NULL
       OR (p_changes ? 'archived_at' AND p_changes->>'archived_at' IS NOT NULL) THEN
      RAISE EXCEPTION 'New groups require a name and cannot start archived.';
    END IF;
    INSERT INTO public.dispatch_groups (
      group_name, description, pool_selection_mode, is_active, created_by
    ) VALUES (
      btrim(p_changes->>'group_name'), p_changes->>'description',
      COALESCE(p_changes->>'pool_selection_mode', 'base'),
      COALESCE((p_changes->>'is_active')::boolean, true), v_admin_id
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
        updated_at = clock_timestamp()
    WHERE id = p_group_id
    RETURNING * INTO v_group;
  END IF;
  RETURN jsonb_build_object('group', to_jsonb(v_group));
END;
$function$;

CREATE FUNCTION public.admin_save_dispatch_pool(
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
                                'dispatch_interval_max', 'session_timeout_minutes',
                                'dispatch_order_mode', 'dispatch_success_rate', 'archived_at'])
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
                      'session_timeout_minutes', 'dispatch_success_rate')
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
      session_timeout_minutes, dispatch_order_mode, dispatch_success_rate, created_by
    ) VALUES (
      p_group_id, btrim(p_changes->>'pool_name'),
      COALESCE((p_changes->>'is_active')::boolean, true),
      COALESCE((p_changes->>'dispatch_interval_min')::integer, 30),
      COALESCE((p_changes->>'dispatch_interval_max')::integer, 120),
      COALESCE((p_changes->>'session_timeout_minutes')::integer, 10),
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
        session_timeout_minutes = COALESCE((p_changes->>'session_timeout_minutes')::integer,
                                           session_timeout_minutes),
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

CREATE FUNCTION public.admin_manage_dispatch_orders(
  p_admin_session_token uuid, p_pool_id uuid, p_action text,
  p_order_id uuid DEFAULT NULL, p_content text DEFAULT NULL, p_contents text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_count integer := 0;
  v_order public.dispatch_group_orders%ROWTYPE;
BEGIN
  SELECT admin_id, admin_role INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_admin_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can manage dispatch orders.';
  END IF;
  IF p_pool_id IS NULL OR p_action NOT IN ('import', 'edit', 'toggle', 'delete', 'delete_all')
     OR p_action IS NULL THEN
    RAISE EXCEPTION 'Invalid dispatch order action or pool.';
  END IF;
  PERFORM 1 FROM public.dispatch_order_pools AS pool
  JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id = pool.group_id
  WHERE pool.id = p_pool_id AND pool.archived_at IS NULL
    AND dispatch_group.archived_at IS NULL
  FOR UPDATE OF pool, dispatch_group;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispatch pool not found or archived.';
  END IF;

  IF p_action = 'import' THEN
    IF p_order_id IS NOT NULL OR p_content IS NOT NULL OR p_contents IS NULL
       OR COALESCE(cardinality(p_contents), 0) NOT BETWEEN 1 AND 2000
       OR EXISTS (SELECT 1 FROM unnest(p_contents) AS item(value)
                  WHERE nullif(btrim(item.value), '') IS NULL) THEN
      RAISE EXCEPTION 'Import requires between 1 and 2000 nonempty contents.';
    END IF;
    INSERT INTO public.dispatch_group_orders (group_id, pool_id, order_content, created_by)
    SELECT pool.group_id, p_pool_id, btrim(item.value), v_admin_id
    FROM public.dispatch_order_pools AS pool
    CROSS JOIN unnest(p_contents) AS item(value)
    WHERE pool.id = p_pool_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_action = 'delete_all' THEN
    IF p_order_id IS NOT NULL OR p_content IS NOT NULL OR p_contents IS NOT NULL THEN
      RAISE EXCEPTION 'Delete all does not take order contents or an order ID.';
    END IF;
    UPDATE public.dispatch_group_orders
    SET archived_at = clock_timestamp(), is_active = false, updated_at = clock_timestamp()
    WHERE pool_id = p_pool_id AND archived_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    IF p_order_id IS NULL OR p_contents IS NOT NULL
       OR (p_action = 'edit' AND nullif(btrim(p_content), '') IS NULL)
       OR (p_action <> 'edit' AND p_content IS NOT NULL) THEN
      RAISE EXCEPTION 'Invalid order parameters for this action.';
    END IF;
    SELECT * INTO v_order FROM public.dispatch_group_orders
    WHERE id = p_order_id AND pool_id = p_pool_id AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Dispatch order not found in this pool.';
    END IF;
    UPDATE public.dispatch_group_orders
    SET order_content = CASE WHEN p_action = 'edit' THEN btrim(p_content)
                             ELSE order_content END,
        is_active = CASE WHEN p_action = 'toggle' THEN NOT is_active
                         WHEN p_action = 'delete' THEN false ELSE is_active END,
        archived_at = CASE WHEN p_action = 'delete' THEN clock_timestamp()
                           ELSE archived_at END,
        updated_at = clock_timestamp()
    WHERE id = p_order_id AND pool_id = p_pool_id
    RETURNING * INTO v_order;
    v_count := 1;
  END IF;
  RETURN jsonb_build_object('success', true, 'action', p_action, 'affected', v_count,
                            'order', CASE WHEN p_action IN ('edit', 'toggle', 'delete')
                                          THEN to_jsonb(v_order) ELSE NULL END);
END;
$function$;

CREATE FUNCTION public.admin_assign_dispatch_group_member(
  p_admin_session_token uuid, p_user_id uuid, p_group_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_member public.dispatch_group_members%ROWTYPE;
BEGIN
  SELECT admin_id, admin_role INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF p_user_id IS NULL OR p_group_id IS NULL THEN
    RAISE EXCEPTION 'An employee and dispatch group are required.';
  END IF;
  PERFORM 1 FROM public.users AS employee
  WHERE employee.id = p_user_id
    AND (v_admin_role = 'super_admin' OR
         (v_admin_role = 'secondary_admin' AND employee.created_by = v_admin_id))
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee not found or not owned by this administrator.';
  END IF;
  PERFORM 1 FROM public.dispatch_groups
  WHERE id = p_group_id AND is_active AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The target dispatch group is not active.';
  END IF;
  INSERT INTO public.dispatch_group_members AS member (user_id, group_id, assigned_by, assigned_at)
  VALUES (p_user_id, p_group_id, v_admin_id, clock_timestamp())
  ON CONFLICT (user_id) DO UPDATE
    SET group_id = EXCLUDED.group_id,
        assigned_by = EXCLUDED.assigned_by,
        assigned_at = EXCLUDED.assigned_at
  RETURNING * INTO v_member;
  RETURN jsonb_build_object('member', to_jsonb(v_member));
END;
$function$;

-- Selection is sticky per work session: repeated calls cannot reroll a pool or
-- shorten its server-generated due time. A depleted pool must be reselected.
CREATE FUNCTION public.prepare_next_dispatch_order_secure(
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

  SELECT dispatch_group.id, dispatch_group.pool_selection_mode
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
      'session_timeout_minutes', v_pool.session_timeout_minutes,
      'dispatch_order_mode', v_pool.dispatch_order_mode,
      'dispatch_success_rate', v_pool.dispatch_success_rate
    )
  );
END;
$function$;

-- Preserve the six-argument API for old callers, but never trust group/mode
-- supplied by a browser. The server selection is the sole assignment source.
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

  SELECT dispatch_group.id, dispatch_group.pool_selection_mode
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
    dispatch_success_rate_snapshot, session_timeout_minutes_snapshot
  ) VALUES (
    v_order.id, p_user_id, 'pending', v_assigned_at, p_session_id,
    v_deadline, v_group.id, v_pool.id, v_order.order_content,
    v_pool.dispatch_success_rate, v_pool.session_timeout_minutes
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
      'session_timeout_minutes', v_pool.session_timeout_minutes
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.accept_dispatch_assignment_secure(
  p_user_id uuid, p_session_token uuid, p_tab_id text,
  p_session_id uuid, p_assignment_id uuid, p_assignment_code text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_assignment record;
  v_success_rate integer;
  v_now timestamptz := clock_timestamp();
BEGIN
  PERFORM 1
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  JOIN public.dispatch_sessions AS dispatch_session
    ON dispatch_session.id = p_session_id AND dispatch_session.user_id = employee.id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id AND employee.is_active = true
    AND dispatch_session.status = 'online' AND dispatch_session.ended_at IS NULL
    AND dispatch_session.last_activity_at >= now() - interval '2 minutes'
  FOR UPDATE OF financial_session, employee, dispatch_session;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee work session is invalid, offline, or stale.';
  END IF;
  SELECT assignment.id, assignment.status, assignment.accept_deadline_at,
         COALESCE(assignment.dispatch_success_rate_snapshot,
                  dispatch_group.dispatch_success_rate, 100) AS success_rate
  INTO v_assignment
  FROM public.dispatch_assignments AS assignment
  LEFT JOIN public.dispatch_group_orders AS dispatch_order
    ON dispatch_order.id = assignment.dispatch_order_id
  LEFT JOIN public.dispatch_groups AS dispatch_group
    ON dispatch_group.id = COALESCE(assignment.group_id, dispatch_order.group_id)
  WHERE assignment.id = p_assignment_id AND assignment.user_id = p_user_id
    AND assignment.dispatch_session_id = p_session_id
  FOR UPDATE OF assignment;
  IF v_assignment.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'reason', 'assignment_not_found');
  END IF;
  IF v_assignment.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'reason', 'already_resolved',
                              'assignment_status', v_assignment.status);
  END IF;
  IF COALESCE(v_assignment.accept_deadline_at, v_now) <= v_now THEN
    RETURN jsonb_build_object('success', false, 'reason', 'accept_deadline_reached',
                              'accept_deadline_at', v_assignment.accept_deadline_at);
  END IF;
  v_success_rate := LEAST(GREATEST(v_assignment.success_rate, 0), 100);
  IF floor(random() * 100 + 1)::integer > v_success_rate THEN
    UPDATE public.dispatch_assignments
    SET status = 'cancelled', completed_at = v_now,
        remarks = 'Order grab failed based on dispatch pool success rate'
    WHERE id = p_assignment_id AND status = 'pending';
    RETURN jsonb_build_object('success', false, 'reason', 'grab_failed',
                              'assignment_status', 'cancelled', 'unaccepted_count', NULL);
  END IF;
  BEGIN
    UPDATE public.dispatch_assignments
    SET status = 'accepted', accepted_at = v_now,
        assignment_id = p_assignment_code, order_submitted = false
    WHERE id = p_assignment_id AND status = 'pending';
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'reason', 'assignment_code_conflict');
  END;
  UPDATE public.dispatch_sessions SET consecutive_unaccepted_count = 0 WHERE id = p_session_id;
  RETURN jsonb_build_object('success', true, 'assignment_id', p_assignment_id,
                            'assignment_code', p_assignment_code, 'accepted_at', v_now,
                            'unaccepted_count', 0);
END;
$function$;

CREATE OR REPLACE FUNCTION public.finish_dispatch_assignment_secure(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_assignment_id uuid,
  p_status text,
  p_remarks text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_updated_id uuid;
BEGIN
  IF p_status NOT IN ('completed', 'error', 'timeout', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid dispatch assignment status.';
  END IF;

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
    AND employee.is_active = true
  FOR UPDATE OF financial_session, employee;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  UPDATE public.dispatch_assignments AS assignment
  SET status = p_status,
      completed_at = clock_timestamp(),
      remarks = COALESCE(p_remarks, assignment.remarks)
  WHERE assignment.id = p_assignment_id
    AND assignment.user_id = p_user_id
    AND (
      (p_status = 'cancelled' AND assignment.status IN ('pending', 'accepted'))
      OR (p_status <> 'cancelled' AND assignment.status = 'accepted')
    )
    AND (p_status <> 'timeout' OR (
      assignment.order_submitted = false
      AND NOT EXISTS (
        SELECT 1 FROM public.orders AS submitted_order
        WHERE submitted_order.assignment_id = assignment.assignment_id
          AND submitted_order.user_id = p_user_id
      )
    ))
  RETURNING assignment.id INTO v_updated_id;

  RETURN jsonb_build_object(
    'success', v_updated_id IS NOT NULL,
    'assignment_id', v_updated_id,
    'status', p_status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.recover_employee_dispatch_assignment_secure(
  p_user_id uuid, p_session_token uuid, p_tab_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_candidate record;
  v_assignment record;
  v_existing_session record;
  v_submitted_order record;
  v_session jsonb;
  v_timeout_minutes integer;
BEGIN
  PERFORM 1
  FROM public.employee_financial_sessions AS financial_session
  JOIN public.users AS employee ON employee.id = financial_session.user_id
  WHERE financial_session.user_id = p_user_id
    AND financial_session.token_hash = private.hash_financial_token(p_session_token)
    AND financial_session.revoked_at IS NULL AND financial_session.expires_at > now()
    AND financial_session.tab_id = p_tab_id
    AND financial_session.session_marker = employee.current_session_token
    AND employee.current_tab_id = p_tab_id AND employee.is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  SELECT assignment.id, assignment.status, assignment.accepted_at,
         assignment.accept_deadline_at, assignment.dispatch_session_id,
         assignment.assignment_id, assignment.order_submitted,
         COALESCE(assignment.session_timeout_minutes_snapshot,
                  dispatch_group.session_timeout_minutes, 10) AS session_timeout_minutes
  INTO v_candidate
  FROM public.dispatch_assignments AS assignment
  LEFT JOIN public.dispatch_group_orders AS dispatch_order
    ON dispatch_order.id = assignment.dispatch_order_id
  LEFT JOIN public.dispatch_groups AS dispatch_group
    ON dispatch_group.id = COALESCE(assignment.group_id, dispatch_order.group_id)
  WHERE assignment.user_id = p_user_id AND assignment.status IN ('pending', 'accepted')
  ORDER BY assignment.assigned_at DESC LIMIT 1;

  IF v_candidate.id IS NULL THEN
    SELECT dispatch_session.id, dispatch_session.started_at,
           dispatch_session.consecutive_unaccepted_count
    INTO v_existing_session
    FROM public.dispatch_sessions AS dispatch_session
    WHERE dispatch_session.user_id = p_user_id
      AND dispatch_session.last_activity_at >= now() - interval '2 minutes'
      AND ((dispatch_session.status = 'online' AND dispatch_session.ended_at IS NULL)
           OR (dispatch_session.status = 'offline'
               AND dispatch_session.ended_at >= now() - interval '30 seconds'))
    ORDER BY dispatch_session.started_at DESC, dispatch_session.id DESC LIMIT 1;
    IF v_existing_session.id IS NULL THEN
      PERFORM public.stop_employee_dispatch_session_secure(
        p_user_id, p_session_token, p_tab_id, NULL);
      RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
    END IF;
    v_session := public.resume_employee_dispatch_session_secure(
      p_user_id, p_session_token, p_tab_id, v_existing_session.id);
    RETURN jsonb_build_object(
      'success', true, 'recovered', true, 'session_id', v_session->>'session_id',
      'started_at', v_session->>'started_at',
      'unaccepted_count', COALESCE((v_session->>'unaccepted_count')::integer, 0),
      'assignment', NULL);
  END IF;

  IF v_candidate.status = 'pending'
     AND COALESCE(v_candidate.accept_deadline_at, now()) <= now() THEN
    IF v_candidate.dispatch_session_id IS NOT NULL THEN
      PERFORM public.expire_pending_dispatch_assignment_secure(
        p_user_id, p_session_token, p_tab_id,
        v_candidate.dispatch_session_id, v_candidate.id);
    ELSE
      UPDATE public.dispatch_assignments
      SET status = 'cancelled', completed_at = clock_timestamp(),
          remarks = 'Auto-cancelled: server accept deadline reached before recovery'
      WHERE id = v_candidate.id AND user_id = p_user_id AND status = 'pending';
    END IF;
    PERFORM public.stop_employee_dispatch_session_secure(
      p_user_id, p_session_token, p_tab_id, NULL);
    RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
  END IF;

  v_timeout_minutes := GREATEST(COALESCE(v_candidate.session_timeout_minutes, 10), 1);
  IF v_candidate.status = 'accepted' THEN
    SELECT submitted_order.id, submitted_order.status,
           submitted_order.created_at, submitted_order.processed_at
    INTO v_submitted_order
    FROM public.orders AS submitted_order
    WHERE submitted_order.assignment_id = v_candidate.assignment_id
    ORDER BY CASE WHEN submitted_order.status IN ('success', 'failure', 'error') THEN 0 ELSE 1 END,
             submitted_order.created_at DESC NULLS LAST, submitted_order.id DESC
    LIMIT 1;

    IF v_submitted_order.status IN ('success', 'failure', 'error') THEN
      UPDATE public.dispatch_assignments
      SET status = CASE WHEN v_submitted_order.status = 'success' THEN 'completed' ELSE 'error' END,
          completed_at = COALESCE(v_submitted_order.processed_at, now()),
          remarks = CASE WHEN v_submitted_order.status = 'success'
                         THEN 'Auto-completed from processed order result'
                         ELSE 'Auto-marked error from processed order result' END
      WHERE id = v_candidate.id AND user_id = p_user_id AND status = 'accepted';
      PERFORM public.stop_employee_dispatch_session_secure(
        p_user_id, p_session_token, p_tab_id, NULL);
      RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
    ELSIF v_candidate.order_submitted = true OR v_submitted_order.id IS NOT NULL THEN
      IF COALESCE(v_submitted_order.created_at, v_candidate.accepted_at)
         < now() - interval '30 minutes' THEN
        UPDATE public.dispatch_assignments
        SET status = 'timeout', completed_at = clock_timestamp(),
            remarks = 'Auto-timeout: submitted order did not produce a final result within 30 minutes'
        WHERE id = v_candidate.id AND user_id = p_user_id AND status = 'accepted'
          AND (order_submitted = true OR EXISTS (
            SELECT 1 FROM public.orders AS submitted_order
            WHERE submitted_order.assignment_id = v_candidate.assignment_id
          ))
          AND NOT EXISTS (
            SELECT 1 FROM public.orders AS submitted_order
            WHERE submitted_order.assignment_id = v_candidate.assignment_id
              AND submitted_order.status IN ('success', 'failure', 'error')
          );
        IF FOUND THEN
          PERFORM public.stop_employee_dispatch_session_secure(
            p_user_id, p_session_token, p_tab_id, NULL);
          RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
        END IF;
      END IF;
    ELSIF v_candidate.accepted_at IS NULL OR
          v_candidate.accepted_at + make_interval(mins => v_timeout_minutes) <= now() THEN
      UPDATE public.dispatch_assignments
      SET status = 'timeout', completed_at = clock_timestamp(),
          remarks = 'Auto-timeout: accepted assignment expired before recovery'
      WHERE id = v_candidate.id AND user_id = p_user_id AND status = 'accepted'
        AND order_submitted = false
        AND NOT EXISTS (
          SELECT 1 FROM public.orders AS submitted_order
          WHERE submitted_order.assignment_id = v_candidate.assignment_id
        );
      IF FOUND THEN
        PERFORM public.stop_employee_dispatch_session_secure(
          p_user_id, p_session_token, p_tab_id, NULL);
        RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
      END IF;
    END IF;
  END IF;

  IF v_candidate.dispatch_session_id IS NOT NULL THEN
    v_session := public.resume_employee_dispatch_session_secure(
      p_user_id, p_session_token, p_tab_id, v_candidate.dispatch_session_id);
  ELSE
    v_session := public.start_employee_dispatch_session_secure(
      p_user_id, p_session_token, p_tab_id);
  END IF;
  SELECT assignment.id, assignment.dispatch_order_id, assignment.user_id,
         assignment.status, assignment.assigned_at, assignment.accepted_at,
         assignment.completed_at, assignment.remarks, assignment.assignment_id,
         assignment.order_submitted, assignment.accept_deadline_at,
         COALESCE(assignment.order_content_snapshot, dispatch_order.order_content) AS order_content,
         COALESCE(assignment.session_timeout_minutes_snapshot,
                  dispatch_group.session_timeout_minutes, 10) AS session_timeout_minutes
  INTO v_assignment
  FROM public.dispatch_assignments AS assignment
  LEFT JOIN public.dispatch_group_orders AS dispatch_order
    ON dispatch_order.id = assignment.dispatch_order_id
  LEFT JOIN public.dispatch_groups AS dispatch_group
    ON dispatch_group.id = COALESCE(assignment.group_id, dispatch_order.group_id)
  WHERE assignment.id = v_candidate.id AND assignment.user_id = p_user_id
    AND ((assignment.status = 'pending' AND assignment.accept_deadline_at > now())
         OR (assignment.status = 'accepted'
             AND NOT EXISTS (
               SELECT 1 FROM public.orders AS submitted_order
               WHERE submitted_order.assignment_id = assignment.assignment_id
                 AND submitted_order.status IN ('success', 'failure', 'error')
             )
             AND (
               (assignment.order_submitted = false
                AND NOT EXISTS (
                  SELECT 1 FROM public.orders AS submitted_order
                  WHERE submitted_order.assignment_id = assignment.assignment_id
                )
                AND assignment.accepted_at + make_interval(mins => GREATEST(
                  COALESCE(assignment.session_timeout_minutes_snapshot,
                           dispatch_group.session_timeout_minutes, 10), 1)) > now())
               OR ((assignment.order_submitted = true OR EXISTS (
                      SELECT 1 FROM public.orders AS submitted_order
                      WHERE submitted_order.assignment_id = assignment.assignment_id
                    ))
                   AND COALESCE((
                     SELECT MAX(submitted_order.created_at)
                     FROM public.orders AS submitted_order
                     WHERE submitted_order.assignment_id = assignment.assignment_id
                   ), assignment.accepted_at) >= now() - interval '30 minutes')
             )))
  FOR UPDATE OF assignment;
  IF v_assignment.id IS NULL THEN
    PERFORM public.stop_employee_dispatch_session_secure(
      p_user_id, p_session_token, p_tab_id, NULLIF(v_session->>'session_id', '')::uuid);
    RETURN jsonb_build_object('success', true, 'recovered', false, 'assignment', NULL);
  END IF;
  UPDATE public.dispatch_assignments
  SET dispatch_session_id = NULLIF(v_session->>'session_id', '')::uuid
  WHERE id = v_assignment.id;
  RETURN jsonb_build_object(
    'success', true, 'recovered', true,
    'session_id', v_session->>'session_id', 'started_at', v_session->>'started_at',
    'unaccepted_count', COALESCE((v_session->>'unaccepted_count')::integer, 0),
    'assignment', jsonb_build_object(
      'id', v_assignment.id, 'dispatch_order_id', v_assignment.dispatch_order_id,
      'user_id', v_assignment.user_id, 'status', v_assignment.status,
      'assigned_at', v_assignment.assigned_at, 'accepted_at', v_assignment.accepted_at,
      'completed_at', v_assignment.completed_at, 'remarks', v_assignment.remarks,
      'assignment_id', v_assignment.assignment_id, 'order_submitted', v_assignment.order_submitted,
      'accept_deadline_at', v_assignment.accept_deadline_at,
      'dispatch_session_id', v_session->>'session_id',
      'dispatch_orders', jsonb_build_object('order_content', v_assignment.order_content),
      'session_timeout_minutes', v_assignment.session_timeout_minutes));
END;
$function$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_dispatch_assignments(
  p_unsubmitted_timeout_minutes integer DEFAULT 10,
  p_submitted_timeout_minutes integer DEFAULT 30
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_default_unsubmitted_timeout integer := GREATEST(COALESCE(p_unsubmitted_timeout_minutes, 10), 1);
  v_submitted_timeout integer := GREATEST(COALESCE(p_submitted_timeout_minutes, 30), 1);
  v_auto_completed integer := 0;
  v_auto_failed integer := 0;
  v_unsubmitted_timed_out integer := 0;
  v_submitted_timed_out integer := 0;
BEGIN
  WITH finalized AS (
    UPDATE public.dispatch_assignments AS assignment
    SET status = CASE WHEN submitted_order.status = 'success' THEN 'completed' ELSE 'error' END,
        completed_at = COALESCE(submitted_order.processed_at, now()),
        remarks = CASE WHEN submitted_order.status = 'success'
                       THEN 'Auto-completed from processed order result'
                       ELSE 'Auto-marked error from processed order result' END
    FROM public.orders AS submitted_order
    WHERE assignment.status = 'accepted'
      AND submitted_order.assignment_id = assignment.assignment_id
      AND submitted_order.status IN ('success', 'failure', 'error')
    RETURNING assignment.status
  )
  SELECT COUNT(*) FILTER (WHERE status = 'completed'),
         COUNT(*) FILTER (WHERE status = 'error')
  INTO v_auto_completed, v_auto_failed FROM finalized;

  WITH timed_out AS (
    UPDATE public.dispatch_assignments AS assignment
    SET status = 'timeout', completed_at = now(),
        remarks = 'Auto-timeout: accepted order was not submitted within configured pool time'
    WHERE assignment.status = 'accepted' AND assignment.order_submitted = false
      AND assignment.accepted_at IS NOT NULL
      AND assignment.accepted_at < now() - make_interval(mins => GREATEST(
        COALESCE(assignment.session_timeout_minutes_snapshot,
          (SELECT dispatch_group.session_timeout_minutes
           FROM public.dispatch_groups AS dispatch_group
           WHERE dispatch_group.id = assignment.group_id),
          (SELECT dispatch_group.session_timeout_minutes
           FROM public.dispatch_group_orders AS dispatch_order
           JOIN public.dispatch_groups AS dispatch_group ON dispatch_group.id = dispatch_order.group_id
           WHERE dispatch_order.id = assignment.dispatch_order_id),
          v_default_unsubmitted_timeout), 1))
      AND NOT EXISTS (SELECT 1 FROM public.orders AS submitted_order
                      WHERE submitted_order.assignment_id = assignment.assignment_id)
    RETURNING assignment.id
  )
  SELECT COUNT(*) INTO v_unsubmitted_timed_out FROM timed_out;

  WITH stale_submissions AS (
    SELECT assignment.id,
           COALESCE(MAX(submitted_order.created_at), assignment.accepted_at) AS last_submission_time
    FROM public.dispatch_assignments AS assignment
    LEFT JOIN public.orders AS submitted_order
      ON submitted_order.assignment_id = assignment.assignment_id
    WHERE assignment.status = 'accepted'
      AND (assignment.order_submitted = true OR EXISTS (
        SELECT 1 FROM public.orders AS existing_order
        WHERE existing_order.assignment_id = assignment.assignment_id))
    GROUP BY assignment.id, assignment.accepted_at
  ), timed_out AS (
    UPDATE public.dispatch_assignments AS assignment
    SET status = 'timeout', completed_at = now(),
        remarks = 'Auto-timeout: submitted order did not produce a final result within '
                  || v_submitted_timeout || ' minutes'
    FROM stale_submissions AS stale
    WHERE assignment.id = stale.id AND assignment.status = 'accepted'
      AND stale.last_submission_time IS NOT NULL
      AND stale.last_submission_time < now() - make_interval(mins => v_submitted_timeout)
    RETURNING assignment.id
  )
  SELECT COUNT(*) INTO v_submitted_timed_out FROM timed_out;
  RETURN jsonb_build_object('success', true, 'auto_completed', v_auto_completed,
    'auto_failed', v_auto_failed, 'unsubmitted_timed_out', v_unsubmitted_timed_out,
    'submitted_timed_out', v_submitted_timed_out, 'checked_at', now());
END;
$function$;

-- The deployed process_pending_orders() body can differ from the repository's
-- 202605 version. Replace ONLY its success-rate decision, leaving its scheduling,
-- wallet accounting, locking and other live logic intact. Fail closed if the
-- deployed function does not have the expected decision point.
DO $block$
DECLARE
  v_source text;
  v_patched text;
  v_anchor text := 'v_is_success[[:space:]]*:=[[:space:]]*random\(\)[[:space:]]*<[[:space:]]*v_success_rate[[:space:]]*;';
  v_decision text := $decision$
    -- The assignment code is unique, so a submitted order has at most one
    -- immutable dispatch outcome snapshot. Non-dispatch orders retain the
    -- existing admin configuration precedence.
    v_success_rate := LEAST(GREATEST(COALESCE(
      (SELECT assignment.dispatch_success_rate_snapshot::numeric / 100
       FROM public.orders AS submitted_order
       JOIN public.dispatch_assignments AS assignment
         ON assignment.assignment_id = submitted_order.assignment_id
        AND assignment.user_id = submitted_order.user_id
       WHERE submitted_order.id = v_order.id),
      (SELECT dispatch_group.dispatch_success_rate::numeric / 100
       FROM public.orders AS submitted_order
       JOIN public.dispatch_assignments AS assignment
         ON assignment.assignment_id = submitted_order.assignment_id
        AND assignment.user_id = submitted_order.user_id
       LEFT JOIN public.dispatch_group_orders AS dispatch_order
         ON dispatch_order.id = assignment.dispatch_order_id
       JOIN public.dispatch_groups AS dispatch_group
         ON dispatch_group.id = COALESCE(assignment.group_id, dispatch_order.group_id)
       WHERE submitted_order.id = v_order.id),
      (SELECT config_value::numeric FROM public.admin_configs
       WHERE admin_id = (SELECT employee.created_by FROM public.users AS employee
                         WHERE employee.id = v_order.user_id)
         AND config_type = 'success_rate' LIMIT 1),
      (SELECT config_value::numeric FROM public.admin_configs
       WHERE admin_id IS NULL AND config_type = 'success_rate' LIMIT 1),
      0), 0), 1);
    v_is_success := random() < v_success_rate;$decision$;
BEGIN
  SELECT pg_get_functiondef('public.process_pending_orders()'::regprocedure) INTO v_source;
  IF v_source IS NULL OR regexp_match(v_source, v_anchor, 'i') IS NULL THEN
    RAISE EXCEPTION 'process_pending_orders decision point changed; review live definition before patching.';
  END IF;
  v_patched := regexp_replace(v_source, v_anchor, v_decision, 'i');
  EXECUTE v_patched;
  ALTER FUNCTION public.process_pending_orders()
    SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp';
END;
$block$;

REVOKE ALL ON FUNCTION public.admin_save_dispatch_group(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_save_dispatch_pool(uuid, uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_manage_dispatch_orders(uuid, uuid, text, uuid, text, text[])
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_assign_dispatch_group_member(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prepare_next_dispatch_order_secure(uuid, uuid, text, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_next_dispatch_order_secure(uuid, uuid, text, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_dispatch_group(uuid, uuid, jsonb)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_dispatch_pool(uuid, uuid, uuid, jsonb)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_manage_dispatch_orders(uuid, uuid, text, uuid, text, text[])
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_dispatch_group_member(uuid, uuid, uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_next_dispatch_order_secure(uuid, uuid, text, uuid)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_next_dispatch_order_secure(uuid, uuid, text, uuid, uuid, text)
  TO anon, authenticated;
