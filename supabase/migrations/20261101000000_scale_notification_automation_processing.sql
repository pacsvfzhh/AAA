CREATE INDEX IF NOT EXISTS idx_orders_user_completed_processed_at
  ON public.orders (user_id, processed_at)
  WHERE status IN ('success', 'failure');

ALTER TABLE public.notification_automation_plans
  ADD COLUMN IF NOT EXISTS activated_at timestamptz;

CREATE TABLE IF NOT EXISTS public.notification_automation_failures (
  task_id uuid NOT NULL REFERENCES public.notification_automation_tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  owner_admin_id uuid NOT NULL REFERENCES public.admins(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  last_error text NOT NULL,
  first_failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS notification_automation_failures_owner_idx
  ON public.notification_automation_failures (owner_admin_id, last_failed_at DESC);
CREATE INDEX IF NOT EXISTS notification_automation_failures_user_idx
  ON public.notification_automation_failures (user_id);

ALTER TABLE public.notification_automation_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_automation_failures FROM PUBLIC, anon, authenticated;

DO $block$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.notification_automation_tasks'::regclass
      AND conname = 'notification_automation_active_tasks_require_plan'
  ) THEN
    ALTER TABLE public.notification_automation_tasks
      ADD CONSTRAINT notification_automation_active_tasks_require_plan
      CHECK (status <> 'active' OR (plan_id IS NOT NULL AND is_shared_template = false));
  END IF;
END;
$block$;

CREATE OR REPLACE FUNCTION private.automation_task_applies_to_user(p_task public.notification_automation_tasks, p_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p_task.plan_id IS NOT NULL
    AND p_task.is_shared_template = false
    AND EXISTS (
      SELECT 1
      FROM public.admins AS owner
      JOIN public.users AS employee ON employee.id = p_user_id
      JOIN public.notification_automation_plans AS plan ON plan.id = p_task.plan_id
      JOIN public.notification_automation_plan_members AS member
        ON member.plan_id = plan.id
       AND member.user_id = employee.id
      WHERE owner.id = p_task.owner_admin_id
        AND owner.is_active = true
        AND employee.is_active = true
        AND employee.created_by = p_task.owner_admin_id
        AND plan.owner_admin_id = p_task.owner_admin_id
        AND plan.status = 'active'
    );
$function$;

CREATE OR REPLACE FUNCTION private.acquire_notification_automation_evaluation_lock(p_wait boolean DEFAULT true)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
BEGIN
  -- Evaluations share this lock with each other; configuration changes take it exclusively.
  IF p_wait THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('notification_automation_queue', 0));
    RETURN true;
  END IF;

  RETURN pg_try_advisory_xact_lock_shared(hashtextextended('notification_automation_queue', 0));
END;
$function$;

REVOKE ALL ON FUNCTION private.acquire_notification_automation_evaluation_lock(boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.evaluate_notification_automation_tasks(
  p_user_id uuid,
  p_now timestamp with time zone DEFAULT clock_timestamp(),
  p_day_bound_only boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_task public.notification_automation_tasks%ROWTYPE;
  v_progress public.notification_automation_progress%ROWTYPE;
  v_progress_found boolean;
  v_metric_result jsonb;
  v_metric numeric;
  v_period_key text;
  v_previous_stage bigint;
  v_stage bigint;
  v_target_stage bigint;
  v_execution_id uuid;
  v_message_id uuid;
  v_recipient_id uuid;
  v_transaction_id uuid;
  v_username text;
  v_currency text;
  v_title text;
  v_content text;
  v_operation_result jsonb;
  v_joined_at timestamptz;
  v_plan_activated_at timestamptz;
  v_effective_start timestamptz;
  v_task_notifications integer;
  v_processed integer := 0;
  v_failures integer := 0;
  v_last_error text;
BEGIN
  SELECT username INTO v_username
  FROM public.users
  WHERE id = p_user_id
    AND is_active = true;

  IF v_username IS NULL THEN
    RETURN jsonb_build_object('notifications', 0, 'failures', 0);
  END IF;

  FOR v_task IN
    SELECT task.*
    FROM public.notification_automation_tasks AS task
    WHERE task.status = 'active'
      AND task.plan_id IS NOT NULL
      AND (NOT p_day_bound_only OR task.trigger_type IN ('daily_orders', 'annual_date'))
      AND COALESCE(task.starts_at, '-infinity'::timestamptz) <= p_now
      AND COALESCE(task.ends_at, 'infinity'::timestamptz) > p_now
    ORDER BY task.id
  LOOP
    CONTINUE WHEN NOT private.automation_task_applies_to_user(v_task, p_user_id);

    SELECT member.created_at, plan.activated_at
    INTO v_joined_at, v_plan_activated_at
    FROM public.notification_automation_plan_members AS member
    JOIN public.notification_automation_plans AS plan ON plan.id = member.plan_id
    WHERE member.plan_id = v_task.plan_id
      AND member.user_id = p_user_id;

    -- Progress made before the task, its plan or the membership took effect never counts.
    v_effective_start := GREATEST(
      COALESCE(v_task.activated_at, '-infinity'::timestamptz),
      COALESCE(v_task.starts_at, '-infinity'::timestamptz),
      COALESCE(v_plan_activated_at, '-infinity'::timestamptz),
      COALESCE(v_joined_at, '-infinity'::timestamptz)
    );
    CONTINUE WHEN v_effective_start > p_now;

    v_task_notifications := 0;

    BEGIN
      SELECT * INTO v_progress
      FROM public.notification_automation_progress
      WHERE task_id = v_task.id
        AND user_id = p_user_id
      FOR UPDATE;
      v_progress_found := FOUND;

      IF NOT v_progress_found THEN
        PERFORM private.capture_automation_baseline(
          v_task,
          p_user_id,
          CASE WHEN v_effective_start = '-infinity'::timestamptz THEN p_now ELSE v_effective_start END
        );

        SELECT * INTO v_progress
        FROM public.notification_automation_progress
        WHERE task_id = v_task.id
          AND user_id = p_user_id
        FOR UPDATE;
        v_progress_found := FOUND;
      END IF;

      IF v_progress_found THEN
        v_metric_result := private.calculate_automation_metric(v_task, p_user_id, p_now);
        v_metric := COALESCE((v_metric_result->>'metric')::numeric, 0);
        v_period_key := COALESCE(v_metric_result->>'period_key', 'all_time');
        IF v_task.trigger_type = 'consecutive_work_days'
          AND v_task.trigger_mode = 'reach_once' THEN
          v_period_key := 'all_time';
        END IF;
        v_previous_stage := CASE
          WHEN (
            v_task.trigger_type = 'daily_orders'
            OR (
              v_task.trigger_type = 'consecutive_work_days'
              AND v_task.trigger_mode = 'recurring'
            )
          ) AND v_progress.last_period_key <> v_period_key THEN 0
          ELSE v_progress.last_stage
        END;
        v_stage := CASE
          WHEN v_task.trigger_mode = 'reach_once' AND v_metric >= v_task.threshold_value THEN 1
          WHEN v_task.trigger_mode = 'recurring' THEN floor(v_metric / v_task.threshold_value)::bigint
          ELSE 0
        END;

        UPDATE public.notification_automation_progress
        SET last_metric = v_metric,
            last_stage = v_stage,
            last_period_key = v_period_key,
            updated_at = p_now
        WHERE task_id = v_task.id
          AND user_id = p_user_id;

        IF v_stage > 0 AND v_stage > v_previous_stage THEN
          FOR v_target_stage IN v_previous_stage + 1..v_stage
          LOOP
            v_execution_id := NULL;
            v_message_id := NULL;
            v_recipient_id := NULL;
            v_transaction_id := NULL;
            v_currency := private.resolve_admin_currency(v_task.owner_admin_id);
            v_title := private.render_automation_template(
              v_task.title_template,
              v_username,
              v_metric,
              v_task,
              v_currency
            );
            v_content := private.render_automation_template(
              v_task.content_template,
              v_username,
              v_metric,
              v_task,
              v_currency
            );

            INSERT INTO public.notification_automation_executions (
              task_id,
              task_version,
              owner_admin_id,
              user_id,
              employee_username,
              period_key,
              stage,
              actual_value,
              trigger_snapshot,
              title_snapshot,
              content_snapshot,
              reward_amount,
              reward_currency
            ) VALUES (
              v_task.id,
              v_task.version,
              v_task.owner_admin_id,
              p_user_id,
              v_username,
              v_period_key,
              v_target_stage,
              v_metric,
              jsonb_build_object(
                'trigger_type', v_task.trigger_type,
                'trigger_mode', v_task.trigger_mode,
                'threshold_value', v_task.threshold_value,
                'minimum_daily_orders', v_task.minimum_daily_orders,
                'minimum_daily_work_minutes', v_task.minimum_daily_work_minutes
              ),
              v_title,
              v_content,
              CASE WHEN v_task.reward_enabled THEN v_task.reward_amount ELSE NULL END,
              CASE WHEN v_task.reward_enabled THEN v_currency ELSE NULL END
            )
            ON CONFLICT (task_id, task_version, user_id, period_key, stage) DO NOTHING
            RETURNING id INTO v_execution_id;

            CONTINUE WHEN v_execution_id IS NULL;

            INSERT INTO public.messages (
              sender_id,
              sender_username,
              title,
              content,
              message_type,
              priority,
              notification_category,
              reward_amount,
              reward_currency,
              automation_execution_id
            )
            SELECT
              admin.id,
              admin.username,
              v_title,
              v_content,
              v_task.message_type,
              v_task.priority,
              CASE WHEN v_task.reward_enabled THEN 'performance_reward' ELSE 'standard' END,
              CASE WHEN v_task.reward_enabled THEN v_task.reward_amount ELSE NULL END,
              CASE WHEN v_task.reward_enabled THEN v_currency ELSE NULL END,
              v_execution_id
            FROM public.admins AS admin
            WHERE admin.id = v_task.owner_admin_id
            RETURNING id INTO v_message_id;

            INSERT INTO public.message_recipients(message_id, recipient_id)
            VALUES (v_message_id, p_user_id)
            RETURNING id INTO v_recipient_id;

            IF v_task.reward_enabled THEN
              v_transaction_id := private.credit_performance_bonus(
                p_user_id,
                v_task.owner_admin_id,
                v_task.reward_amount,
                v_currency,
                v_recipient_id,
                v_execution_id,
                'Performance Bonus / 業績獎金'
              );

              v_operation_result := jsonb_build_object(
                'success', true,
                'execution_id', v_execution_id,
                'message_id', v_message_id,
                'transaction_id', v_transaction_id,
                'user_id', p_user_id,
                'amount', v_task.reward_amount,
                'currency', v_currency
              );
              PERFORM private.save_financial_operation(
                v_execution_id,
                'notification_automation_bonus',
                'system',
                v_task.owner_admin_id,
                jsonb_build_object(
                  'task_id', v_task.id,
                  'task_version', v_task.version,
                  'user_id', p_user_id,
                  'period_key', v_period_key,
                  'stage', v_target_stage
                ),
                v_operation_result
              );
            END IF;

            UPDATE public.notification_automation_executions
            SET status = 'succeeded',
                message_id = v_message_id,
                wallet_transaction_id = v_transaction_id,
                completed_at = clock_timestamp()
            WHERE id = v_execution_id;

            v_task_notifications := v_task_notifications + 1;
          END LOOP;
        END IF;
      END IF;

      DELETE FROM public.notification_automation_failures
      WHERE task_id = v_task.id
        AND user_id = p_user_id;

      v_processed := v_processed + v_task_notifications;
    EXCEPTION WHEN OTHERS THEN
      v_failures := v_failures + 1;
      v_last_error := left(SQLERRM, 500);

      INSERT INTO public.notification_automation_failures AS failure (
        task_id,
        user_id,
        owner_admin_id,
        last_error
      ) VALUES (
        v_task.id,
        p_user_id,
        v_task.owner_admin_id,
        v_last_error
      )
      ON CONFLICT (task_id, user_id) DO UPDATE
      SET attempts = failure.attempts + 1,
          owner_admin_id = EXCLUDED.owner_admin_id,
          last_error = EXCLUDED.last_error,
          last_failed_at = clock_timestamp();
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'notifications', v_processed,
    'failures', v_failures,
    'last_error', v_last_error
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.evaluate_notification_automation_tasks(uuid, timestamptz, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.evaluate_notification_automation_for_user(p_user_id uuid, p_now timestamp with time zone DEFAULT clock_timestamp())
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  RETURN COALESCE(
    (private.evaluate_notification_automation_tasks(p_user_id, p_now, false)->>'notifications')::integer,
    0
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.evaluate_notification_automation_for_user(uuid, timestamptz) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.process_notification_automation_user(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_queue public.notification_automation_queue%ROWTYPE;
  v_has_queue boolean;
  v_now timestamptz := clock_timestamp();
  v_today date := (v_now AT TIME ZONE 'UTC')::date;
  v_day date;
  v_result jsonb;
  v_notifications integer := 0;
  v_failures integer := 0;
  v_last_error text;
BEGIN
  SELECT * INTO v_queue
  FROM public.notification_automation_queue
  WHERE user_id = p_user_id
  FOR UPDATE;
  v_has_queue := FOUND;

  PERFORM private.acquire_notification_automation_evaluation_lock(true);

  BEGIN
    -- Daily and annual-date conditions depend on the evaluation day, so events queued
    -- before a UTC day change are first judged at the end of their own day.
    IF v_has_queue THEN
      v_day := GREATEST((v_queue.requested_at AT TIME ZONE 'UTC')::date, v_today - 7);
      WHILE v_day < v_today LOOP
        v_result := private.evaluate_notification_automation_tasks(
          p_user_id,
          ((v_day + 1)::timestamp AT TIME ZONE 'UTC') - interval '1 microsecond',
          true
        );
        v_notifications := v_notifications + COALESCE((v_result->>'notifications')::integer, 0);
        v_failures := v_failures + COALESCE((v_result->>'failures')::integer, 0);
        v_last_error := COALESCE(v_result->>'last_error', v_last_error);
        v_day := v_day + 1;
      END LOOP;
    END IF;

    v_result := private.evaluate_notification_automation_tasks(p_user_id, v_now, false);
    v_notifications := v_notifications + COALESCE((v_result->>'notifications')::integer, 0);
    v_failures := v_failures + COALESCE((v_result->>'failures')::integer, 0);
    v_last_error := COALESCE(v_result->>'last_error', v_last_error);
  EXCEPTION WHEN OTHERS THEN
    v_failures := v_failures + 1;
    v_last_error := left(SQLERRM, 500);
  END;

  IF v_has_queue THEN
    IF v_failures = 0 THEN
      DELETE FROM public.notification_automation_queue
      WHERE user_id = p_user_id;
    ELSE
      UPDATE public.notification_automation_queue
      SET attempts = attempts + 1,
          next_attempt_at = clock_timestamp() + make_interval(secs => LEAST(300, 5 * (attempts + 1))),
          last_error = left(COALESCE(v_last_error, 'Notification automation evaluation failed.'), 500)
      WHERE user_id = p_user_id;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'user_id', p_user_id,
    'notifications', v_notifications,
    'failures', v_failures,
    'last_error', v_last_error
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.process_notification_automation_user(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.process_next_notification_automation_user()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  -- Wait for configuration changes before claiming, so a claimed queue row never blocks a login.
  PERFORM private.acquire_notification_automation_evaluation_lock(true);

  SELECT queue.user_id INTO v_user_id
  FROM public.notification_automation_queue AS queue
  WHERE queue.next_attempt_at <= clock_timestamp()
  ORDER BY queue.next_attempt_at, queue.requested_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN private.process_notification_automation_user(v_user_id);
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.notification_automation_queue
    SET attempts = attempts + 1,
        next_attempt_at = clock_timestamp() + make_interval(secs => LEAST(300, 5 * (attempts + 1))),
        last_error = left(SQLERRM, 500)
    WHERE user_id = v_user_id;

    RETURN jsonb_build_object(
      'user_id', v_user_id,
      'notifications', 0,
      'failures', 1,
      'last_error', left(SQLERRM, 500)
    );
  END;
END;
$function$;

REVOKE ALL ON FUNCTION private.process_next_notification_automation_user() FROM PUBLIC, anon, authenticated;

-- Commits after every employee so queue rows, wallets and the shared lock are held only briefly.
-- Transaction control rules out SECURITY DEFINER and SET clauses, so every name is schema-qualified.
CREATE OR REPLACE PROCEDURE private.run_notification_automation_queue(
  p_limit integer DEFAULT 200,
  p_schedule_annual boolean DEFAULT false
)
LANGUAGE plpgsql
AS $procedure$
DECLARE
  v_started_at timestamptz := pg_catalog.clock_timestamp();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 2000);
  v_processed integer := 0;
BEGIN
  IF p_schedule_annual THEN
    PERFORM private.queue_annual_date_automation_users(pg_catalog.clock_timestamp());
    COMMIT;
  END IF;

  WHILE v_processed < v_limit
    AND pg_catalog.clock_timestamp() - v_started_at < interval '4 seconds'
  LOOP
    EXIT WHEN private.process_next_notification_automation_user() IS NULL;
    v_processed := v_processed + 1;
    COMMIT;
  END LOOP;
END;
$procedure$;

REVOKE ALL ON PROCEDURE private.run_notification_automation_queue(integer, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.process_notification_automation_queue(p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_processed integer := 0;
  v_notifications integer := 0;
  v_scheduled_users integer;
BEGIN
  v_scheduled_users := private.queue_annual_date_automation_users();

  FOR v_index IN 1..LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  LOOP
    v_result := private.process_next_notification_automation_user();
    EXIT WHEN v_result IS NULL;
    v_processed := v_processed + 1;
    v_notifications := v_notifications + COALESCE((v_result->>'notifications')::integer, 0);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'processed_users', v_processed,
    'created_notifications', v_notifications,
    'scheduled_users', v_scheduled_users
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.process_notification_automation_queue(integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.process_notification_automation_queue_fast(p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_processed integer := 0;
  v_notifications integer := 0;
BEGIN
  FOR v_index IN 1..LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  LOOP
    v_result := private.process_next_notification_automation_user();
    EXIT WHEN v_result IS NULL;
    v_processed := v_processed + 1;
    v_notifications := v_notifications + COALESCE((v_result->>'notifications')::integer, 0);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'processed_users', v_processed,
    'created_notifications', v_notifications
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.process_notification_automation_queue_fast(integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.queue_automation_from_employee_login()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  IF NEW.action_type = 'login' THEN
    PERFORM private.queue_notification_automation_user(NEW.user_id);

    -- Never wait at login: while a configuration change holds the lock, the queue worker finishes the job.
    IF private.acquire_notification_automation_evaluation_lock(false) THEN
      BEGIN
        PERFORM private.process_notification_automation_user(NEW.user_id);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_task_status_v2(p_admin_session_token uuid, p_task_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_task public.notification_automation_tasks%ROWTYPE;
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();

  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF p_status NOT IN ('draft', 'active', 'paused') THEN
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

    -- The evaluator recaptures each member's baseline as of activated_at.
    DELETE FROM public.notification_automation_progress
    WHERE task_id = v_task.id;
    DELETE FROM public.notification_automation_failures
    WHERE task_id = v_task.id;
  ELSE
    UPDATE public.notification_automation_tasks
    SET status = p_status,
        updated_at = clock_timestamp()
    WHERE id = v_task.id
    RETURNING * INTO v_task;
  END IF;

  RETURN jsonb_build_object('success', true, 'status', v_task.status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_plan_status(p_admin_session_token uuid, p_plan_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_plan public.notification_automation_plans%ROWTYPE;
  v_previous_status text;
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();

  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF p_status NOT IN ('active', 'paused', 'archived') THEN
    RAISE EXCEPTION 'Unsupported automation plan status.';
  END IF;

  SELECT plan.* INTO v_plan
  FROM public.notification_automation_plans AS plan
  WHERE plan.id = p_plan_id
    AND (plan.owner_admin_id = v_admin_id OR v_admin_role = 'super_admin')
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automation plan was not found or cannot be changed.';
  END IF;

  PERFORM private.resolve_notification_automation_owner(v_admin_id, v_admin_role, v_plan.owner_admin_id);
  v_previous_status := v_plan.status;

  UPDATE public.notification_automation_plans
  SET status = p_status,
      activated_at = CASE
        WHEN p_status = 'active' AND v_previous_status <> 'active' THEN clock_timestamp()
        ELSE activated_at
      END,
      updated_at = clock_timestamp()
  WHERE id = v_plan.id
  RETURNING * INTO v_plan;

  IF p_status = 'active' AND v_previous_status <> 'active' THEN
    DELETE FROM public.notification_automation_progress AS progress
    USING public.notification_automation_tasks AS task
    WHERE progress.task_id = task.id
      AND task.plan_id = v_plan.id;
  END IF;

  RETURN jsonb_build_object('success', true, 'plan', to_jsonb(v_plan));
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_plan_members(p_admin_session_token uuid, p_plan_id uuid, p_user_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_plan public.notification_automation_plans%ROWTYPE;
  v_user_ids uuid[] := COALESCE(p_user_ids, ARRAY[]::uuid[]);
  v_added_user_ids uuid[];
BEGIN
  PERFORM private.acquire_notification_automation_configuration_lock();
  SELECT context.admin_id, context.admin_role INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF cardinality(v_user_ids) <> (SELECT count(DISTINCT requested_user_id) FROM unnest(v_user_ids) AS requested_user_id) THEN
    RAISE EXCEPTION 'The employee selection contains duplicate accounts.';
  END IF;

  SELECT plan.* INTO v_plan
  FROM public.notification_automation_plans AS plan
  WHERE plan.id = p_plan_id AND plan.status <> 'archived'
    AND (plan.owner_admin_id = v_admin_id OR v_admin_role = 'super_admin')
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Automation plan was not found or cannot manage employees.'; END IF;

  PERFORM private.resolve_notification_automation_owner(v_admin_id, v_admin_role, v_plan.owner_admin_id);

  IF EXISTS (
    SELECT 1 FROM unnest(v_user_ids) AS requested_user_id
    LEFT JOIN public.users AS employee ON employee.id = requested_user_id
    WHERE employee.id IS NULL OR employee.created_by <> v_plan.owner_admin_id
  ) THEN RAISE EXCEPTION 'An employee is outside the automation plan administrator group.'; END IF;

  PERFORM employee.id FROM public.users AS employee
  WHERE employee.id = ANY(v_user_ids)
     OR EXISTS (
       SELECT 1 FROM public.notification_automation_plan_members AS current_member
       WHERE current_member.plan_id = v_plan.id AND current_member.user_id = employee.id
     )
  ORDER BY employee.id FOR UPDATE;

  SELECT COALESCE(array_agg(requested_user_id), ARRAY[]::uuid[]) INTO v_added_user_ids
  FROM unnest(v_user_ids) AS requested_user_id
  WHERE NOT EXISTS (
    SELECT 1 FROM public.notification_automation_plan_members AS existing_member
    WHERE existing_member.plan_id = v_plan.id AND existing_member.user_id = requested_user_id
  );

  DELETE FROM public.notification_automation_plan_members AS member
  WHERE member.plan_id = v_plan.id AND NOT (member.user_id = ANY(v_user_ids));
  DELETE FROM public.notification_automation_plan_members AS member
  WHERE member.plan_id <> v_plan.id AND member.user_id = ANY(v_user_ids);

  INSERT INTO public.notification_automation_plan_members(plan_id, user_id)
  SELECT v_plan.id, added_user_id
  FROM unnest(v_added_user_ids) AS added_user_id;

  -- New members get their baseline lazily as of the join time.
  DELETE FROM public.notification_automation_progress AS progress
  USING public.notification_automation_tasks AS task
  WHERE progress.task_id = task.id
    AND task.plan_id = v_plan.id
    AND progress.user_id = ANY(v_added_user_ids);

  RETURN jsonb_build_object(
    'success', true,
    'plan_id', v_plan.id,
    'member_count', (SELECT count(*) FROM public.notification_automation_plan_members AS member WHERE member.plan_id = v_plan.id)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_notification_automation_failures(
  p_admin_session_token uuid,
  p_owner_admin_id uuid DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_owner_id uuid;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  v_owner_id := private.resolve_notification_automation_owner(v_admin_id, v_admin_role, p_owner_admin_id);

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'task_id', failure.task_id,
      'task_name', task.name,
      'plan_id', task.plan_id,
      'plan_name', plan.name,
      'user_id', failure.user_id,
      'employee_username', employee.username,
      'employee_code', employee.employee_id,
      'attempts', failure.attempts,
      'last_error', failure.last_error,
      'first_failed_at', failure.first_failed_at,
      'last_failed_at', failure.last_failed_at
    ) ORDER BY failure.last_failed_at DESC)
    FROM (
      SELECT recent_failure.*
      FROM public.notification_automation_failures AS recent_failure
      WHERE recent_failure.owner_admin_id = v_owner_id
      ORDER BY recent_failure.last_failed_at DESC
      LIMIT 200
    ) AS failure
    JOIN public.notification_automation_tasks AS task ON task.id = failure.task_id
    LEFT JOIN public.notification_automation_plans AS plan ON plan.id = task.plan_id
    JOIN public.users AS employee ON employee.id = failure.user_id
    WHERE task.status = 'active'
      AND private.automation_task_applies_to_user(task, failure.user_id)
  ), '[]'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.get_notification_automation_failures(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_notification_automation_failures(uuid, uuid) TO anon, authenticated;

DO $block$
DECLARE
  v_function regprocedure;
BEGIN
  FOR v_function IN
    SELECT procedure.oid::regprocedure
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN (
        'save_notification_automation_task',
        'save_notification_automation_task_with_delivery',
        'save_notification_automation_task_copy',
        'save_notification_automation_task_copy_with_delivery',
        'copy_shared_notification_automation_task',
        'copy_shared_notification_automation_task_with_delivery',
        'set_notification_automation_task_status',
        'get_notification_automation_dashboard'
      )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_function);
  END LOOP;
END;
$block$;

DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule(job.jobid)
    FROM cron.job AS job
    WHERE job.jobname IN (
      'process_notification_automation_queue_every_five_seconds',
      'process_notification_automation_queue_every_minute'
    );

    PERFORM cron.schedule(
      'process_notification_automation_queue_every_five_seconds',
      '5 seconds',
      'CALL private.run_notification_automation_queue(200, false);'
    );
    PERFORM cron.schedule(
      'process_notification_automation_queue_every_minute',
      '* * * * *',
      'CALL private.run_notification_automation_queue(200, true);'
    );
  END IF;
END;
$block$;
