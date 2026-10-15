CREATE TABLE IF NOT EXISTS public.notification_automation_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_admin_id uuid NOT NULL REFERENCES public.admins(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_automation_plans_owner_name_idx
  ON public.notification_automation_plans(owner_admin_id, lower(name));
CREATE INDEX IF NOT EXISTS notification_automation_plans_owner_status_idx
  ON public.notification_automation_plans(owner_admin_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.notification_automation_plan_members (
  plan_id uuid NOT NULL REFERENCES public.notification_automation_plans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, user_id),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS notification_automation_plan_members_plan_idx
  ON public.notification_automation_plan_members(plan_id, created_at DESC);

ALTER TABLE public.notification_automation_tasks
  ADD COLUMN IF NOT EXISTS plan_id uuid REFERENCES public.notification_automation_plans(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS notification_automation_tasks_plan_status_idx
  ON public.notification_automation_tasks(plan_id, status, updated_at DESC)
  WHERE plan_id IS NOT NULL;

ALTER TABLE public.notification_automation_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_automation_plan_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_automation_plans FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.notification_automation_plan_members FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.notification_automation_plans TO service_role;
GRANT ALL ON TABLE public.notification_automation_plan_members TO service_role;

CREATE OR REPLACE FUNCTION private.resolve_notification_automation_owner(
  p_admin_id uuid,
  p_admin_role text,
  p_requested_owner_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_id uuid;
BEGIN
  IF p_admin_role = 'secondary_admin' THEN
    IF p_requested_owner_id IS NOT NULL AND p_requested_owner_id <> p_admin_id THEN
      RAISE EXCEPTION 'You cannot manage another administrator group.';
    END IF;
    v_owner_id := p_admin_id;
  ELSIF p_admin_role = 'super_admin' THEN
    v_owner_id := COALESCE(p_requested_owner_id, p_admin_id);
  ELSE
    RAISE EXCEPTION 'This administrator cannot manage automation plans.';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.admins AS owner
    WHERE owner.id = v_owner_id
      AND owner.is_active = true
      AND owner.role IN ('super_admin', 'secondary_admin')
  ) THEN
    RAISE EXCEPTION 'The selected administrator group is not available.';
  END IF;

  RETURN v_owner_id;
END;
$$;

CREATE OR REPLACE FUNCTION private.validate_notification_automation_plan_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_admin_id uuid;
  v_created_by uuid;
BEGIN
  SELECT plan.owner_admin_id
  INTO v_owner_admin_id
  FROM public.notification_automation_plans AS plan
  WHERE plan.id = NEW.plan_id;

  SELECT employee.created_by
  INTO v_created_by
  FROM public.users AS employee
  WHERE employee.id = NEW.user_id;

  IF v_owner_admin_id IS NULL OR v_created_by IS NULL OR v_owner_admin_id <> v_created_by THEN
    RAISE EXCEPTION 'The employee and automation plan must belong to the same administrator group.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_notification_automation_plan_member
  ON public.notification_automation_plan_members;
CREATE TRIGGER validate_notification_automation_plan_member
  BEFORE INSERT OR UPDATE OF plan_id, user_id
  ON public.notification_automation_plan_members
  FOR EACH ROW
  EXECUTE FUNCTION private.validate_notification_automation_plan_member();

CREATE OR REPLACE FUNCTION private.validate_notification_automation_task_plan()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_owner_admin_id uuid;
  v_plan_status text;
BEGIN
  IF NEW.plan_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT plan.owner_admin_id, plan.status
  INTO v_owner_admin_id, v_plan_status
  FROM public.notification_automation_plans AS plan
  WHERE plan.id = NEW.plan_id;

  IF v_owner_admin_id IS NULL OR v_owner_admin_id <> NEW.owner_admin_id THEN
    RAISE EXCEPTION 'The automation task and plan must belong to the same administrator group.';
  END IF;

  IF NEW.is_shared_template THEN
    RAISE EXCEPTION 'Shared templates cannot be assigned to an automation plan.';
  END IF;

  IF NEW.status = 'active' AND v_plan_status <> 'active' THEN
    RAISE EXCEPTION 'Activate the automation plan before activating this task.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_notification_automation_task_plan
  ON public.notification_automation_tasks;
CREATE TRIGGER validate_notification_automation_task_plan
  BEFORE INSERT OR UPDATE OF plan_id, owner_admin_id, is_shared_template, status
  ON public.notification_automation_tasks
  FOR EACH ROW
  EXECUTE FUNCTION private.validate_notification_automation_task_plan();

CREATE OR REPLACE FUNCTION private.pause_notification_automation_plans_for_disabled_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.is_active IS DISTINCT FROM false AND NEW.is_active = false THEN
    UPDATE public.notification_automation_plans
    SET status = 'paused',
        updated_at = clock_timestamp()
    WHERE owner_admin_id = NEW.id
      AND status = 'active';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pause_notification_automation_plans_for_disabled_admin
  ON public.admins;
CREATE TRIGGER pause_notification_automation_plans_for_disabled_admin
  AFTER UPDATE OF is_active
  ON public.admins
  FOR EACH ROW
  EXECUTE FUNCTION private.pause_notification_automation_plans_for_disabled_admin();

CREATE OR REPLACE FUNCTION private.automation_task_applies_to_user(
  p_task public.notification_automation_tasks,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admins AS owner
    JOIN public.users AS employee ON employee.id = p_user_id
    WHERE owner.id = p_task.owner_admin_id
      AND owner.is_active = true
      AND employee.is_active = true
      AND (
        (
          p_task.plan_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.notification_automation_plans AS plan
            WHERE plan.id = p_task.plan_id
              AND plan.owner_admin_id = p_task.owner_admin_id
              AND plan.status = 'active'
          )
          AND employee.created_by = p_task.owner_admin_id
          AND (
            p_task.recipient_scope = 'all_managed'
            OR (
              p_task.recipient_scope = 'selected'
              AND EXISTS (
                SELECT 1
                FROM public.notification_automation_plan_members AS member
                WHERE member.plan_id = p_task.plan_id
                  AND member.user_id = employee.id
              )
            )
          )
        )
        OR (
          p_task.plan_id IS NULL
          AND (
            (
              p_task.recipient_scope = 'all_managed'
              AND (
                owner.role = 'super_admin'
                OR employee.created_by = owner.id
              )
            )
            OR (
              p_task.recipient_scope = 'selected'
              AND EXISTS (
                SELECT 1
                FROM public.notification_automation_task_recipients AS recipient
                WHERE recipient.task_id = p_task.id
                  AND recipient.user_id = employee.id
              )
            )
          )
        )
      )
  );
$$;

CREATE OR REPLACE FUNCTION public.get_notification_automation_dashboard_v2(
  p_admin_session_token uuid,
  p_owner_admin_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_owner_admin_id uuid;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  v_owner_admin_id := private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    p_owner_admin_id
  );

  RETURN jsonb_build_object(
    'currency', private.resolve_admin_currency(v_owner_admin_id),
    'selected_owner_id', v_owner_admin_id,
    'admin_groups', CASE
      WHEN v_admin_role = 'super_admin' THEN COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', visible_admin.id,
            'username', visible_admin.username,
            'role', visible_admin.role,
            'is_active', visible_admin.is_active,
            'employee_count', (
              SELECT count(*)
              FROM public.users AS employee
              WHERE employee.created_by = visible_admin.id
            ),
            'plan_count', (
              SELECT count(*)
              FROM public.notification_automation_plans AS plan
              WHERE plan.owner_admin_id = visible_admin.id
                AND plan.status <> 'archived'
            )
          )
          ORDER BY CASE WHEN visible_admin.id = v_admin_id THEN 0 ELSE 1 END,
                   visible_admin.username
        )
        FROM public.admins AS visible_admin
        WHERE visible_admin.is_active = true
          AND visible_admin.role IN ('super_admin', 'secondary_admin')
      ), '[]'::jsonb)
      ELSE '[]'::jsonb
    END,
    'plans', COALESCE((
      SELECT jsonb_agg(plan_data ORDER BY (plan_data->>'updated_at') DESC)
      FROM (
        SELECT to_jsonb(plan.*)
          || jsonb_build_object(
            'member_count', (
              SELECT count(*)
              FROM public.notification_automation_plan_members AS member
              WHERE member.plan_id = plan.id
            ),
            'task_count', (
              SELECT count(*)
              FROM public.notification_automation_tasks AS task
              WHERE task.plan_id = plan.id
                AND task.is_shared_template = false
            ),
            'active_task_count', (
              SELECT count(*)
              FROM public.notification_automation_tasks AS task
              WHERE task.plan_id = plan.id
                AND task.is_shared_template = false
                AND task.status = 'active'
            ),
            'selected_task_count', (
              SELECT count(*)
              FROM public.notification_automation_tasks AS task
              WHERE task.plan_id = plan.id
                AND task.is_shared_template = false
                AND task.recipient_scope = 'selected'
            ),
            'all_managed_task_count', (
              SELECT count(*)
              FROM public.notification_automation_tasks AS task
              WHERE task.plan_id = plan.id
                AND task.is_shared_template = false
                AND task.recipient_scope = 'all_managed'
            )
          ) AS plan_data
        FROM public.notification_automation_plans AS plan
        WHERE plan.owner_admin_id = v_owner_admin_id
      ) AS visible_plans
    ), '[]'::jsonb),
    'plan_members', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'plan_id', member.plan_id,
          'user_id', member.user_id,
          'created_at', member.created_at
        )
        ORDER BY member.created_at, member.user_id
      )
      FROM public.notification_automation_plan_members AS member
      JOIN public.notification_automation_plans AS plan ON plan.id = member.plan_id
      WHERE plan.owner_admin_id = v_owner_admin_id
    ), '[]'::jsonb),
    'employees', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', employee.id,
          'username', employee.username,
          'employee_id', employee.employee_id,
          'created_by', employee.created_by,
          'is_active', employee.is_active,
          'tags', COALESCE(to_jsonb(employee.tags), '[]'::jsonb)
        )
        ORDER BY employee.is_active DESC, employee.username, employee.id
      )
      FROM public.users AS employee
      WHERE employee.created_by = v_owner_admin_id
    ), '[]'::jsonb),
    'tasks', COALESCE((
      SELECT jsonb_agg(task_data ORDER BY (task_data->>'updated_at') DESC)
      FROM (
        SELECT to_jsonb(task.*)
          || jsonb_build_object(
            'owner_username', owner.username,
            'recipient_ids', CASE
              WHEN task.plan_id IS NULL THEN COALESCE((
                SELECT jsonb_agg(recipient.user_id)
                FROM public.notification_automation_task_recipients AS recipient
                WHERE recipient.task_id = task.id
              ), '[]'::jsonb)
              ELSE '[]'::jsonb
            END,
            'execution_count', (
              SELECT count(*)
              FROM public.notification_automation_executions AS execution
              WHERE execution.task_id = task.id
                AND execution.status = 'succeeded'
            ),
            'total_rewards', (
              SELECT COALESCE(sum(execution.reward_amount), 0)
              FROM public.notification_automation_executions AS execution
              WHERE execution.task_id = task.id
                AND execution.status = 'succeeded'
            )
          ) AS task_data
        FROM public.notification_automation_tasks AS task
        JOIN public.admins AS owner ON owner.id = task.owner_admin_id
        WHERE task.owner_admin_id = v_owner_admin_id
          AND task.is_shared_template = false
      ) AS visible_tasks
    ), '[]'::jsonb),
    'executions', COALESCE((
      SELECT jsonb_agg(execution_data ORDER BY (execution_data->>'executed_at') DESC)
      FROM (
        SELECT to_jsonb(execution.*)
          || jsonb_build_object(
            'task_name', COALESCE(task.name, execution.trigger_snapshot->>'task_name', '已移除任務'),
            'plan_id', task.plan_id,
            'employee_username', COALESCE(employee.username, execution.employee_username),
            'owner_username', owner.username
          ) AS execution_data
        FROM public.notification_automation_executions AS execution
        LEFT JOIN public.notification_automation_tasks AS task ON task.id = execution.task_id
        LEFT JOIN public.users AS employee ON employee.id = execution.user_id
        LEFT JOIN public.admins AS owner ON owner.id = execution.owner_admin_id
        WHERE execution.owner_admin_id = v_owner_admin_id
        ORDER BY execution.executed_at DESC
        LIMIT 200
      ) AS visible_executions
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_notification_automation_plan(
  p_admin_session_token uuid,
  p_owner_admin_id uuid,
  p_plan_id uuid,
  p_name text,
  p_description text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_owner_admin_id uuid;
  v_plan public.notification_automation_plans%ROWTYPE;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  v_owner_admin_id := private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    p_owner_admin_id
  );

  IF char_length(trim(COALESCE(p_name, ''))) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Plan name must contain between 1 and 120 characters.';
  END IF;

  IF p_plan_id IS NULL THEN
    INSERT INTO public.notification_automation_plans (
      owner_admin_id,
      name,
      description
    ) VALUES (
      v_owner_admin_id,
      trim(p_name),
      COALESCE(trim(p_description), '')
    )
    RETURNING * INTO v_plan;
  ELSE
    UPDATE public.notification_automation_plans
    SET name = trim(p_name),
        description = COALESCE(trim(p_description), ''),
        updated_at = clock_timestamp()
    WHERE id = p_plan_id
      AND owner_admin_id = v_owner_admin_id
    RETURNING * INTO v_plan;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Automation plan was not found or cannot be edited.';
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'plan', to_jsonb(v_plan));
END;
$$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_plan_status(
  p_admin_session_token uuid,
  p_plan_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_plan public.notification_automation_plans%ROWTYPE;
  v_previous_status text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF p_status NOT IN ('active', 'paused', 'archived') THEN
    RAISE EXCEPTION 'Unsupported automation plan status.';
  END IF;

  SELECT plan.*
  INTO v_plan
  FROM public.notification_automation_plans AS plan
  WHERE plan.id = p_plan_id
    AND (
      plan.owner_admin_id = v_admin_id
      OR v_admin_role = 'super_admin'
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automation plan was not found or cannot be changed.';
  END IF;

  PERFORM private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    v_plan.owner_admin_id
  );

  v_previous_status := v_plan.status;

  UPDATE public.notification_automation_plans
  SET status = p_status,
      updated_at = clock_timestamp()
  WHERE id = v_plan.id
  RETURNING * INTO v_plan;

  IF p_status = 'active' AND v_previous_status <> 'active' THEN
    FOR v_task IN
      SELECT task.*
      FROM public.notification_automation_tasks AS task
      WHERE task.plan_id = v_plan.id
        AND task.status = 'active'
        AND (task.starts_at IS NULL OR task.starts_at <= clock_timestamp())
    LOOP
      FOR v_user_id IN
        SELECT employee.id
        FROM public.users AS employee
        WHERE employee.is_active = true
          AND private.automation_task_applies_to_user(v_task, employee.id)
      LOOP
        PERFORM private.capture_automation_baseline(v_task, v_user_id);
      END LOOP;
    END LOOP;
  END IF;

  RETURN jsonb_build_object('success', true, 'plan', to_jsonb(v_plan));
END;
$$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_plan_members(
  p_admin_session_token uuid,
  p_plan_id uuid,
  p_user_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_plan public.notification_automation_plans%ROWTYPE;
  v_user_id uuid;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_ids uuid[] := COALESCE(p_user_ids, ARRAY[]::uuid[]);
  v_added_user_ids uuid[];
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF cardinality(v_user_ids) <> (
    SELECT count(DISTINCT requested_user_id)
    FROM unnest(v_user_ids) AS requested_user_id
  ) THEN
    RAISE EXCEPTION 'The employee selection contains duplicate accounts.';
  END IF;

  SELECT plan.*
  INTO v_plan
  FROM public.notification_automation_plans AS plan
  WHERE plan.id = p_plan_id
    AND plan.status <> 'archived'
    AND (
      plan.owner_admin_id = v_admin_id
      OR v_admin_role = 'super_admin'
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automation plan was not found or cannot manage employees.';
  END IF;

  PERFORM private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    v_plan.owner_admin_id
  );

  IF EXISTS (
    SELECT 1
    FROM unnest(v_user_ids) AS requested_user_id
    LEFT JOIN public.users AS employee ON employee.id = requested_user_id
    WHERE employee.id IS NULL
       OR employee.created_by <> v_plan.owner_admin_id
  ) THEN
    RAISE EXCEPTION 'An employee is outside the automation plan administrator group.';
  END IF;

  PERFORM employee.id
  FROM public.users AS employee
  WHERE employee.id = ANY(v_user_ids)
  ORDER BY employee.id
  FOR UPDATE;

  SELECT COALESCE(array_agg(requested_user_id), ARRAY[]::uuid[])
  INTO v_added_user_ids
  FROM unnest(v_user_ids) AS requested_user_id
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.notification_automation_plan_members AS existing_member
    WHERE existing_member.plan_id = v_plan.id
      AND existing_member.user_id = requested_user_id
  );

  DELETE FROM public.notification_automation_plan_members AS member
  WHERE member.plan_id = v_plan.id
    AND NOT (member.user_id = ANY(v_user_ids));

  DELETE FROM public.notification_automation_plan_members AS member
  WHERE member.plan_id <> v_plan.id
    AND member.user_id = ANY(v_user_ids);

  FOREACH v_user_id IN ARRAY v_added_user_ids
  LOOP
    INSERT INTO public.notification_automation_plan_members(plan_id, user_id)
    VALUES (v_plan.id, v_user_id);

    FOR v_task IN
      SELECT task.*
      FROM public.notification_automation_tasks AS task
      WHERE task.plan_id = v_plan.id
        AND task.status = 'active'
        AND task.recipient_scope = 'selected'
        AND (task.starts_at IS NULL OR task.starts_at <= clock_timestamp())
    LOOP
      PERFORM private.capture_automation_baseline(v_task, v_user_id);
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'plan_id', v_plan.id,
    'member_count', (
      SELECT count(*)
      FROM public.notification_automation_plan_members AS member
      WHERE member.plan_id = v_plan.id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.save_notification_automation_task_v2(
  p_admin_session_token uuid,
  p_owner_admin_id uuid,
  p_plan_id uuid,
  p_task_id uuid,
  p_name text,
  p_description text,
  p_trigger_type text,
  p_trigger_mode text,
  p_threshold_value numeric,
  p_minimum_daily_orders integer,
  p_minimum_daily_work_minutes integer,
  p_recipient_scope text,
  p_recipient_ids uuid[],
  p_title_template text,
  p_content_template text,
  p_delivery_mode text,
  p_priority text,
  p_reward_enabled boolean,
  p_reward_amount numeric,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_owner_admin_id uuid;
  v_owner_role text;
  v_message_type text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
  v_recipient_ids uuid[] := COALESCE(p_recipient_ids, ARRAY[]::uuid[]);
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  v_owner_admin_id := private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    p_owner_admin_id
  );

  SELECT owner.role
  INTO v_owner_role
  FROM public.admins AS owner
  WHERE owner.id = v_owner_admin_id;

  IF p_trigger_type NOT IN ('total_orders', 'daily_orders', 'work_days', 'commission_amount', 'consecutive_work_days', 'first_login') THEN
    RAISE EXCEPTION 'Unsupported automation trigger.';
  END IF;
  IF p_trigger_mode NOT IN ('reach_once', 'recurring') THEN
    RAISE EXCEPTION 'Unsupported automation trigger mode.';
  END IF;
  IF p_trigger_type = 'first_login'
    AND (p_trigger_mode <> 'reach_once' OR p_threshold_value IS DISTINCT FROM 1) THEN
    RAISE EXCEPTION 'First-login automation only supports a single reach-once threshold.';
  END IF;
  IF p_threshold_value IS NULL
    OR p_threshold_value <= 0
    OR p_threshold_value > 1000000000000
    OR p_threshold_value::text IN ('NaN', 'Infinity', '-Infinity')
    OR (p_trigger_type <> 'commission_amount' AND p_threshold_value <> trunc(p_threshold_value))
    OR (p_trigger_type = 'commission_amount' AND p_threshold_value < 0.01) THEN
    RAISE EXCEPTION 'Trigger threshold is outside the supported range.';
  END IF;
  IF p_trigger_type IN ('work_days', 'consecutive_work_days')
    AND COALESCE(p_minimum_daily_orders, 0) <= 0 THEN
    RAISE EXCEPTION 'A minimum daily order count is required.';
  END IF;
  IF COALESCE(p_reward_enabled, false)
    AND (
      p_reward_amount IS NULL
      OR p_reward_amount <= 0
      OR p_reward_amount::text IN ('NaN', 'Infinity', '-Infinity')
    ) THEN
    RAISE EXCEPTION 'Reward amount must be a finite positive number.';
  END IF;
  IF p_recipient_scope NOT IN ('all_managed', 'selected') THEN
    RAISE EXCEPTION 'Unsupported recipient scope.';
  END IF;
  IF p_delivery_mode NOT IN ('realtime_only', 'login_only', 'realtime_with_login_fallback') THEN
    RAISE EXCEPTION 'Unsupported notification delivery mode.';
  END IF;
  IF p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'Unsupported notification priority.';
  END IF;

  v_message_type := CASE p_delivery_mode
    WHEN 'realtime_only' THEN 'realtime'
    ELSE 'login_popup'
  END;

  IF p_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.notification_automation_plans AS plan
    WHERE plan.id = p_plan_id
      AND plan.owner_admin_id = v_owner_admin_id
      AND plan.status <> 'archived'
  ) THEN
    RAISE EXCEPTION 'The selected automation plan is not available.';
  END IF;

  IF p_task_id IS NULL AND p_plan_id IS NULL THEN
    RAISE EXCEPTION 'New automation tasks must belong to a plan.';
  END IF;

  IF p_task_id IS NOT NULL THEN
    SELECT task.*
    INTO v_task
    FROM public.notification_automation_tasks AS task
    WHERE task.id = p_task_id
      AND task.owner_admin_id = v_owner_admin_id
      AND task.is_shared_template = false
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Automation task was not found or cannot be edited.';
    END IF;

    IF v_task.plan_id IS NULL AND p_plan_id IS NOT NULL THEN
      RAISE EXCEPTION 'Legacy ungrouped tasks cannot be moved into a plan automatically.';
    END IF;
    IF v_task.plan_id IS NOT NULL AND p_plan_id IS DISTINCT FROM v_task.plan_id THEN
      RAISE EXCEPTION 'Move tasks between plans with an explicit migration workflow.';
    END IF;
  END IF;

  IF p_plan_id IS NULL
    AND p_recipient_scope = 'selected'
    AND cardinality(v_recipient_ids) = 0 THEN
    RAISE EXCEPTION 'Select at least one employee for the legacy task.';
  END IF;

  IF p_task_id IS NULL THEN
    INSERT INTO public.notification_automation_tasks (
      owner_admin_id,
      plan_id,
      name,
      description,
      trigger_type,
      trigger_mode,
      threshold_value,
      minimum_daily_orders,
      minimum_daily_work_minutes,
      recipient_scope,
      title_template,
      content_template,
      message_type,
      delivery_mode,
      priority,
      reward_enabled,
      reward_amount,
      is_shared_template,
      starts_at,
      ends_at
    ) VALUES (
      v_owner_admin_id,
      p_plan_id,
      trim(p_name),
      COALESCE(trim(p_description), ''),
      p_trigger_type,
      p_trigger_mode,
      p_threshold_value,
      p_minimum_daily_orders,
      p_minimum_daily_work_minutes,
      p_recipient_scope,
      trim(p_title_template),
      p_content_template,
      v_message_type,
      p_delivery_mode,
      p_priority,
      COALESCE(p_reward_enabled, false),
      CASE WHEN p_reward_enabled THEN p_reward_amount ELSE NULL END,
      false,
      p_starts_at,
      p_ends_at
    )
    RETURNING * INTO v_task;
  ELSE
    UPDATE public.notification_automation_tasks
    SET name = trim(p_name),
        description = COALESCE(trim(p_description), ''),
        trigger_type = p_trigger_type,
        trigger_mode = p_trigger_mode,
        threshold_value = p_threshold_value,
        minimum_daily_orders = p_minimum_daily_orders,
        minimum_daily_work_minutes = p_minimum_daily_work_minutes,
        recipient_scope = p_recipient_scope,
        title_template = trim(p_title_template),
        content_template = p_content_template,
        message_type = v_message_type,
        delivery_mode = p_delivery_mode,
        priority = p_priority,
        reward_enabled = COALESCE(p_reward_enabled, false),
        reward_amount = CASE WHEN p_reward_enabled THEN p_reward_amount ELSE NULL END,
        starts_at = p_starts_at,
        ends_at = p_ends_at,
        status = 'draft',
        activated_at = NULL,
        version = version + 1,
        updated_at = clock_timestamp()
    WHERE id = v_task.id
    RETURNING * INTO v_task;

    DELETE FROM public.notification_automation_task_recipients
    WHERE task_id = v_task.id;

    DELETE FROM public.notification_automation_progress
    WHERE task_id = v_task.id;
  END IF;

  IF v_task.plan_id IS NULL AND p_recipient_scope = 'selected' THEN
    FOREACH v_user_id IN ARRAY v_recipient_ids
    LOOP
      IF NOT private.admin_can_manage_automation_user(
        v_owner_admin_id,
        v_owner_role,
        v_user_id
      ) THEN
        RAISE EXCEPTION 'An employee is outside the task administrator scope.';
      END IF;

      INSERT INTO public.notification_automation_task_recipients(task_id, user_id)
      VALUES (v_task.id, v_user_id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'task_id', v_task.id,
    'plan_id', v_task.plan_id,
    'version', v_task.version,
    'status', v_task.status,
    'delivery_mode', v_task.delivery_mode
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_task_status_v2(
  p_admin_session_token uuid,
  p_task_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF p_status NOT IN ('draft', 'active', 'paused', 'archived') THEN
    RAISE EXCEPTION 'Unsupported task status.';
  END IF;

  SELECT task.*
  INTO v_task
  FROM public.notification_automation_tasks AS task
  WHERE task.id = p_task_id
    AND task.is_shared_template = false
    AND (
      task.owner_admin_id = v_admin_id
      OR v_admin_role = 'super_admin'
    )
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automation task was not found or cannot be changed.';
  END IF;

  PERFORM private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    v_task.owner_admin_id
  );

  IF p_status = 'active'
    AND v_task.plan_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.notification_automation_plans AS plan
      WHERE plan.id = v_task.plan_id
        AND plan.status = 'active'
    ) THEN
    RAISE EXCEPTION 'Activate the automation plan before activating this task.';
  END IF;

  IF p_status = 'active' AND v_task.status <> 'active' THEN
    UPDATE public.notification_automation_tasks
    SET status = 'active',
        activated_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE id = v_task.id
    RETURNING * INTO v_task;

    IF v_task.starts_at IS NULL OR v_task.starts_at <= clock_timestamp() THEN
      FOR v_user_id IN
        SELECT employee.id
        FROM public.users AS employee
        WHERE employee.is_active = true
          AND private.automation_task_applies_to_user(v_task, employee.id)
      LOOP
        PERFORM private.capture_automation_baseline(v_task, v_user_id);
      END LOOP;
    END IF;
  ELSE
    UPDATE public.notification_automation_tasks
    SET status = p_status,
        updated_at = clock_timestamp()
    WHERE id = v_task.id
    RETURNING * INTO v_task;
  END IF;

  RETURN jsonb_build_object('success', true, 'status', v_task.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_notification_automation_plan_assignments(
  p_admin_session_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  RETURN jsonb_build_object(
    'plans', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', plan.id,
          'owner_admin_id', plan.owner_admin_id,
          'name', plan.name,
          'description', plan.description,
          'status', plan.status,
          'selected_task_count', (
            SELECT count(*)
            FROM public.notification_automation_tasks AS task
            WHERE task.plan_id = plan.id
              AND task.is_shared_template = false
              AND task.recipient_scope = 'selected'
          )
        )
        ORDER BY owner.username, plan.status, plan.name
      )
      FROM public.notification_automation_plans AS plan
      JOIN public.admins AS owner ON owner.id = plan.owner_admin_id
      WHERE owner.is_active = true
        AND owner.role IN ('super_admin', 'secondary_admin')
        AND (
          v_admin_role = 'super_admin'
          OR plan.owner_admin_id = v_admin_id
        )
    ), '[]'::jsonb),
    'assignments', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'user_id', member.user_id,
          'plan_id', member.plan_id,
          'plan_name', plan.name,
          'plan_status', plan.status
        )
        ORDER BY member.user_id
      )
      FROM public.notification_automation_plan_members AS member
      JOIN public.notification_automation_plans AS plan ON plan.id = member.plan_id
      JOIN public.users AS employee ON employee.id = member.user_id
      WHERE v_admin_role = 'super_admin'
         OR employee.created_by = v_admin_id
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_plan_for_employee(
  p_admin_session_token uuid,
  p_user_id uuid,
  p_plan_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_employee public.users%ROWTYPE;
  v_plan public.notification_automation_plans%ROWTYPE;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_current_plan_id uuid;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  PERFORM private.assert_admin_can_manage_user(v_admin_id, v_admin_role, p_user_id);

  SELECT employee.*
  INTO v_employee
  FROM public.users AS employee
  WHERE employee.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee account was not found.';
  END IF;

  SELECT member.plan_id
  INTO v_current_plan_id
  FROM public.notification_automation_plan_members AS member
  WHERE member.user_id = v_employee.id;

  IF p_plan_id IS NOT NULL THEN
    SELECT plan.*
    INTO v_plan
    FROM public.notification_automation_plans AS plan
    JOIN public.admins AS owner ON owner.id = plan.owner_admin_id
    WHERE plan.id = p_plan_id
      AND plan.owner_admin_id = v_employee.created_by
      AND plan.status = 'active'
      AND owner.is_active = true;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'The selected automation plan is not available for this employee.';
    END IF;
  END IF;

  IF p_plan_id IS NOT DISTINCT FROM v_current_plan_id THEN
    RETURN jsonb_build_object(
      'success', true,
      'user_id', v_employee.id,
      'plan_id', p_plan_id
    );
  END IF;

  DELETE FROM public.notification_automation_plan_members
  WHERE user_id = v_employee.id;

  IF p_plan_id IS NOT NULL THEN
    INSERT INTO public.notification_automation_plan_members(plan_id, user_id)
    VALUES (v_plan.id, v_employee.id);

    FOR v_task IN
      SELECT task.*
      FROM public.notification_automation_tasks AS task
      WHERE task.plan_id = v_plan.id
        AND task.status = 'active'
        AND task.recipient_scope = 'selected'
        AND (task.starts_at IS NULL OR task.starts_at <= clock_timestamp())
    LOOP
      PERFORM private.capture_automation_baseline(v_task, v_employee.id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'user_id', v_employee.id,
    'plan_id', p_plan_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_employee_account_with_automation_plan(
  p_admin_session_token uuid,
  p_username text,
  p_password text,
  p_employee_id text,
  p_created_by uuid,
  p_remarks text,
  p_automation_plan_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, extensions, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_owner_admin_id uuid;
  v_user public.users%ROWTYPE;
  v_plan public.notification_automation_plans%ROWTYPE;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_password_hash text;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  v_owner_admin_id := private.resolve_notification_automation_owner(
    v_admin_id,
    v_admin_role,
    p_created_by
  );

  IF length(trim(COALESCE(p_username, ''))) = 0
    OR length(p_password) < 6
    OR length(trim(COALESCE(p_employee_id, ''))) = 0 THEN
    RAISE EXCEPTION 'Invalid employee account details.';
  END IF;

  IF p_automation_plan_id IS NOT NULL THEN
    SELECT plan.*
    INTO v_plan
    FROM public.notification_automation_plans AS plan
    WHERE plan.id = p_automation_plan_id
      AND plan.owner_admin_id = v_owner_admin_id
      AND plan.status = 'active';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'The selected automation plan is not available.';
    END IF;
  END IF;

  v_password_hash := extensions.crypt(p_password, extensions.gen_salt('bf', 10));

  INSERT INTO public.users (
    username,
    password_hash,
    employee_id,
    created_by,
    remarks
  ) VALUES (
    trim(p_username),
    v_password_hash,
    trim(p_employee_id),
    v_owner_admin_id,
    trim(COALESCE(p_remarks, ''))
  )
  RETURNING * INTO v_user;

  INSERT INTO public.financial_employee_credentials(user_id, password_hash)
  VALUES (v_user.id, v_password_hash);

  IF p_automation_plan_id IS NOT NULL THEN
    INSERT INTO public.notification_automation_plan_members(plan_id, user_id)
    VALUES (v_plan.id, v_user.id);

    FOR v_task IN
      SELECT task.*
      FROM public.notification_automation_tasks AS task
      WHERE task.plan_id = v_plan.id
        AND task.status = 'active'
        AND task.recipient_scope = 'selected'
        AND (task.starts_at IS NULL OR task.starts_at <= clock_timestamp())
    LOOP
      PERFORM private.capture_automation_baseline(v_task, v_user.id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'user', to_jsonb(v_user) - 'password_hash',
    'automation_plan_id', p_automation_plan_id
  );
END;
$$;

REVOKE ALL ON FUNCTION private.resolve_notification_automation_owner(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.validate_notification_automation_plan_member() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.validate_notification_automation_task_plan() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.pause_notification_automation_plans_for_disabled_admin() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.automation_task_applies_to_user(public.notification_automation_tasks, uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_notification_automation_dashboard_v2(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_notification_automation_plan(uuid, uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_notification_automation_plan_status(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_notification_automation_plan_members(uuid, uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_notification_automation_task_v2(uuid, uuid, uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_notification_automation_task_status_v2(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_notification_automation_plan_assignments(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_notification_automation_plan_for_employee(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.get_notification_automation_dashboard_v2(uuid, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_notification_automation_plan(uuid, uuid, uuid, text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_notification_automation_plan_status(uuid, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_notification_automation_plan_members(uuid, uuid, uuid[]) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_notification_automation_task_v2(uuid, uuid, uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, timestamptz, timestamptz) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_notification_automation_task_status_v2(uuid, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_notification_automation_plan_assignments(uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_notification_automation_plan_for_employee(uuid, uuid, uuid) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_employee_account_with_automation_plan(uuid, text, text, text, uuid, text, uuid) TO anon, authenticated, service_role;
