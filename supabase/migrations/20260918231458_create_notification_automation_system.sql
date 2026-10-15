ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS notification_category text NOT NULL DEFAULT 'standard',
  ADD COLUMN IF NOT EXISTS reward_amount numeric,
  ADD COLUMN IF NOT EXISTS reward_currency text,
  ADD COLUMN IF NOT EXISTS automation_execution_id uuid;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_notification_category_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_notification_category_check
  CHECK (notification_category IN ('standard', 'performance_reward'));

ALTER TABLE public.wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE public.wallet_transactions
  ADD CONSTRAINT wallet_transactions_type_check CHECK (
    type IN (
      'commission',
      'withdrawal_request',
      'withdrawal_approved',
      'withdrawal_rejected',
      'withdrawal_correction',
      'manual_adjustment',
      'tip',
      'performance_bonus'
    )
  );

CREATE TABLE public.notification_automation_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_admin_id uuid NOT NULL REFERENCES public.admins(id) ON DELETE CASCADE,
  source_task_id uuid REFERENCES public.notification_automation_tasks(id) ON DELETE SET NULL,
  source_version integer,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  is_shared_template boolean NOT NULL DEFAULT false,
  trigger_type text NOT NULL CHECK (trigger_type IN (
    'total_orders',
    'daily_orders',
    'work_days',
    'commission_amount',
    'consecutive_work_days'
  )),
  trigger_mode text NOT NULL CHECK (trigger_mode IN ('reach_once', 'recurring')),
  threshold_value numeric NOT NULL CHECK (
    threshold_value > 0
    AND threshold_value::text NOT IN ('NaN', 'Infinity', '-Infinity')
  ),
  minimum_daily_orders integer CHECK (minimum_daily_orders IS NULL OR minimum_daily_orders > 0),
  minimum_daily_work_minutes integer CHECK (minimum_daily_work_minutes IS NULL OR minimum_daily_work_minutes > 0),
  recipient_scope text NOT NULL DEFAULT 'all_managed' CHECK (recipient_scope IN ('all_managed', 'selected')),
  title_template text NOT NULL CHECK (char_length(trim(title_template)) BETWEEN 1 AND 200),
  content_template text NOT NULL CHECK (char_length(trim(content_template)) BETWEEN 1 AND 5000),
  message_type text NOT NULL DEFAULT 'realtime' CHECK (message_type IN ('login_popup', 'realtime')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  reward_enabled boolean NOT NULL DEFAULT false,
  reward_amount numeric CHECK (
    reward_amount IS NULL
    OR (
      reward_amount > 0
      AND reward_amount::text NOT IN ('NaN', 'Infinity', '-Infinity')
    )
  ),
  starts_at timestamptz,
  ends_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT reward_enabled OR reward_amount IS NOT NULL),
  CHECK (trigger_type <> 'consecutive_work_days' OR minimum_daily_orders IS NOT NULL),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE public.notification_automation_task_recipients (
  task_id uuid NOT NULL REFERENCES public.notification_automation_tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE public.notification_automation_progress (
  task_id uuid NOT NULL REFERENCES public.notification_automation_tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  last_metric numeric NOT NULL DEFAULT 0,
  last_stage bigint NOT NULL DEFAULT 0,
  last_period_key text NOT NULL DEFAULT 'all_time',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);

CREATE TABLE public.notification_automation_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid REFERENCES public.notification_automation_tasks(id) ON DELETE SET NULL,
  task_version integer NOT NULL,
  owner_admin_id uuid REFERENCES public.admins(id) ON DELETE SET NULL,
  user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  employee_username text NOT NULL,
  period_key text NOT NULL,
  stage bigint NOT NULL CHECK (stage > 0),
  actual_value numeric NOT NULL,
  trigger_snapshot jsonb NOT NULL,
  title_snapshot text NOT NULL,
  content_snapshot text NOT NULL,
  reward_amount numeric,
  reward_currency text,
  message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  wallet_transaction_id uuid REFERENCES public.wallet_transactions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'succeeded', 'failed')),
  error_message text,
  executed_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (task_id, task_version, user_id, period_key, stage)
);

CREATE TABLE public.notification_automation_queue (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  requested_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);

CREATE INDEX notification_automation_tasks_owner_status_idx
  ON public.notification_automation_tasks(owner_admin_id, status, updated_at DESC);
CREATE INDEX notification_automation_tasks_active_type_idx
  ON public.notification_automation_tasks(trigger_type, starts_at, ends_at)
  WHERE status = 'active';
CREATE INDEX notification_automation_executions_owner_idx
  ON public.notification_automation_executions(owner_admin_id, executed_at DESC);
CREATE INDEX notification_automation_executions_user_idx
  ON public.notification_automation_executions(user_id, executed_at DESC);
CREATE INDEX notification_automation_queue_due_idx
  ON public.notification_automation_queue(next_attempt_at, requested_at);
CREATE UNIQUE INDEX wallet_transactions_performance_bonus_reference_idx
  ON public.wallet_transactions(reference_id)
  WHERE type = 'performance_bonus' AND reference_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.track_wallet_transaction_in_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_operation_id uuid := COALESCE(NEW.operation_id, gen_random_uuid());
  v_available_delta numeric := 0;
  v_income_delta numeric := 0;
BEGIN
  IF NEW.type IN ('commission', 'tip', 'manual_adjustment', 'performance_bonus') THEN
    v_available_delta := NEW.amount;
  ELSE
    RETURN NEW;
  END IF;

  IF NEW.type IN ('commission', 'tip', 'performance_bonus') THEN
    v_income_delta := NEW.amount;
  END IF;

  INSERT INTO public.wallet_ledger_entries (
    user_id,
    operation_id,
    source_type,
    source_id,
    event_type,
    available_delta,
    frozen_delta,
    income_delta
  ) VALUES (
    NEW.user_id,
    v_operation_id,
    'wallet_transaction',
    NEW.id,
    NEW.type,
    v_available_delta,
    0,
    v_income_delta
  )
  ON CONFLICT DO NOTHING;

  PERFORM public.enqueue_wallet_reconciliation(NEW.user_id);
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverse_deleted_wallet_transaction_in_ledger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_operation_id uuid := gen_random_uuid();
  v_available_delta numeric := 0;
  v_income_delta numeric := 0;
BEGIN
  IF OLD.type IN ('commission', 'tip', 'manual_adjustment', 'performance_bonus') THEN
    v_available_delta := -OLD.amount;
  ELSE
    RETURN OLD;
  END IF;

  IF OLD.type IN ('commission', 'tip', 'performance_bonus') THEN
    v_income_delta := -OLD.amount;
  END IF;

  INSERT INTO public.wallet_ledger_entries (
    user_id,
    operation_id,
    source_type,
    source_id,
    event_type,
    available_delta,
    frozen_delta,
    income_delta
  ) VALUES (
    OLD.user_id,
    v_operation_id,
    'wallet_transaction',
    OLD.id,
    'reversal:' || OLD.type,
    v_available_delta,
    0,
    v_income_delta
  );

  PERFORM public.enqueue_wallet_reconciliation(OLD.user_id);
  RETURN OLD;
END;
$function$;

ALTER TABLE public.notification_automation_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_automation_task_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_automation_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_automation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_automation_queue ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.notification_automation_tasks FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.notification_automation_task_recipients FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.notification_automation_progress FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.notification_automation_executions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.notification_automation_queue FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.resolve_admin_currency(p_admin_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(
    (
      SELECT NULLIF(trim(config_value), '')
      FROM public.admin_configs
      WHERE config_type = 'currency_unit'
        AND admin_id = p_admin_id
      LIMIT 1
    ),
    (
      SELECT NULLIF(trim(config_value), '')
      FROM public.admin_configs
      WHERE config_type = 'currency_unit'
        AND admin_id IS NULL
      LIMIT 1
    ),
    'USDT'
  );
$$;

CREATE OR REPLACE FUNCTION private.admin_can_manage_automation_user(
  p_admin_id uuid,
  p_admin_role text,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN p_admin_role = 'super_admin' THEN EXISTS (
      SELECT 1 FROM public.users WHERE id = p_user_id
    )
    ELSE EXISTS (
      SELECT 1
      FROM public.users
      WHERE id = p_user_id
        AND created_by = p_admin_id
    )
  END;
$$;

CREATE OR REPLACE FUNCTION private.automation_task_applies_to_user(
  p_task public.notification_automation_tasks,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
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
  );
$$;

CREATE OR REPLACE FUNCTION private.calculate_automation_metric(
  p_task public.notification_automation_tasks,
  p_user_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_metric numeric := 0;
  v_period_key text := 'all_time';
  v_latest_day date;
  v_cursor_day date;
  v_streak integer := 0;
BEGIN
  IF p_task.trigger_type = 'total_orders' THEN
    SELECT count(*)::numeric
    INTO v_metric
    FROM public.orders
    WHERE user_id = p_user_id
      AND status IN ('success', 'failure')
      AND processed_at < p_now;
  ELSIF p_task.trigger_type = 'daily_orders' THEN
    v_period_key := to_char(p_now AT TIME ZONE 'UTC', 'YYYY-MM-DD');
    SELECT count(*)::numeric
    INTO v_metric
    FROM public.orders
    WHERE user_id = p_user_id
      AND status IN ('success', 'failure')
      AND processed_at >= date_trunc('day', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND processed_at < LEAST(
        (date_trunc('day', p_now AT TIME ZONE 'UTC') + interval '1 day') AT TIME ZONE 'UTC',
        p_now
      );
  ELSIF p_task.trigger_type = 'work_days' THEN
    SELECT count(*)::numeric
    INTO v_metric
    FROM (
      SELECT (start_time AT TIME ZONE 'UTC')::date AS day_date
      FROM public.work_sessions
      WHERE user_id = p_user_id
        AND end_time IS NOT NULL
        AND end_time <= p_now
      GROUP BY (start_time AT TIME ZONE 'UTC')::date
      HAVING sum(COALESCE(
        duration_minutes,
        floor(extract(epoch FROM (COALESCE(end_time, p_now) - start_time)) / 60)::integer,
        0
      )) >= COALESCE(p_task.minimum_daily_work_minutes, 1)
    ) AS qualifying_work_days;
  ELSIF p_task.trigger_type = 'commission_amount' THEN
    SELECT COALESCE(sum(amount), 0)
    INTO v_metric
    FROM public.wallet_transactions
    WHERE user_id = p_user_id
      AND type = 'commission'
      AND created_at < p_now;
  ELSE
    CREATE TEMP TABLE IF NOT EXISTS pg_temp.qualified_automation_days (
      day_date date PRIMARY KEY
    ) ON COMMIT DROP;
    TRUNCATE pg_temp.qualified_automation_days;

    INSERT INTO pg_temp.qualified_automation_days(day_date)
    SELECT order_day.day_date
    FROM (
      SELECT (processed_at AT TIME ZONE 'UTC')::date AS day_date,
             count(*) AS completed_orders
      FROM public.orders
      WHERE user_id = p_user_id
        AND status IN ('success', 'failure')
        AND processed_at < p_now
      GROUP BY (processed_at AT TIME ZONE 'UTC')::date
    ) AS order_day
    WHERE order_day.completed_orders >= p_task.minimum_daily_orders
      AND EXISTS (
        SELECT 1
        FROM public.work_sessions AS work_session
        WHERE work_session.user_id = p_user_id
          AND work_session.end_time IS NOT NULL
          AND work_session.end_time <= p_now
          AND (work_session.start_time AT TIME ZONE 'UTC')::date = order_day.day_date
        GROUP BY (work_session.start_time AT TIME ZONE 'UTC')::date
        HAVING sum(COALESCE(work_session.duration_minutes, 0))
          >= COALESCE(p_task.minimum_daily_work_minutes, 1)
      );

    SELECT max(day_date) INTO v_latest_day
    FROM pg_temp.qualified_automation_days;

    IF v_latest_day IS NOT NULL
      AND v_latest_day >= (p_now AT TIME ZONE 'UTC')::date - 1 THEN
      v_cursor_day := v_latest_day;
      LOOP
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM pg_temp.qualified_automation_days WHERE day_date = v_cursor_day
        );
        v_streak := v_streak + 1;
        v_cursor_day := v_cursor_day - 1;
      END LOOP;
      v_metric := v_streak;
      v_period_key := to_char(v_cursor_day + 1, 'YYYY-MM-DD');
    ELSE
      v_metric := 0;
      v_period_key := 'no_active_streak';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'metric', COALESCE(v_metric, 0),
    'period_key', v_period_key
  );
END;
$function$;

CREATE OR REPLACE FUNCTION private.capture_automation_baseline(
  p_task public.notification_automation_tasks,
  p_user_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_metric_result jsonb;
  v_metric numeric;
  v_period_key text;
  v_stage bigint;
BEGIN
  IF NOT private.automation_task_applies_to_user(p_task, p_user_id) THEN
    RETURN;
  END IF;

  v_metric_result := private.calculate_automation_metric(p_task, p_user_id, p_now);
  v_metric := COALESCE((v_metric_result->>'metric')::numeric, 0);
  v_period_key := COALESCE(v_metric_result->>'period_key', 'all_time');
  v_stage := CASE
    WHEN p_task.trigger_mode = 'reach_once' AND v_metric >= p_task.threshold_value THEN 1
    WHEN p_task.trigger_mode = 'recurring' THEN floor(v_metric / p_task.threshold_value)::bigint
    ELSE 0
  END;

  INSERT INTO public.notification_automation_progress (
    task_id,
    user_id,
    last_metric,
    last_stage,
    last_period_key
  ) VALUES (
    p_task.id,
    p_user_id,
    v_metric,
    v_stage,
    v_period_key
  )
  ON CONFLICT (task_id, user_id) DO UPDATE
  SET last_metric = EXCLUDED.last_metric,
      last_stage = EXCLUDED.last_stage,
      last_period_key = EXCLUDED.last_period_key,
      updated_at = p_now;
END;
$function$;

CREATE OR REPLACE FUNCTION private.credit_performance_bonus(
  p_user_id uuid,
  p_admin_id uuid,
  p_amount numeric,
  p_currency text,
  p_reference_id uuid,
  p_operation_id uuid,
  p_remarks text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_wallet public.wallets%ROWTYPE;
  v_transaction_id uuid;
BEGIN
  IF p_amount IS NULL
    OR p_amount <= 0
    OR p_amount::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Performance bonus must be a finite positive amount.';
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee wallet was not found.';
  END IF;

  INSERT INTO public.wallet_transactions (
    user_id,
    type,
    amount,
    balance_before,
    balance_after,
    reference_id,
    remarks,
    created_by,
    operation_id
  ) VALUES (
    p_user_id,
    'performance_bonus',
    p_amount,
    v_wallet.available_balance,
    v_wallet.available_balance + p_amount,
    p_reference_id,
    p_remarks || ' (' || p_currency || ')',
    p_admin_id,
    p_operation_id
  )
  RETURNING id INTO v_transaction_id;

  UPDATE public.wallets
  SET available_balance = available_balance + p_amount,
      updated_at = now()
  WHERE user_id = p_user_id;

  UPDATE public.users
  SET total_income = COALESCE(total_income, 0) + p_amount
  WHERE id = p_user_id;

  RETURN v_transaction_id;
END;
$function$;

CREATE OR REPLACE FUNCTION private.render_automation_template(
  p_template text,
  p_username text,
  p_actual_value numeric,
  p_task public.notification_automation_tasks,
  p_currency text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $$
  SELECT replace(
    replace(
      replace(
        replace(
          replace(
            replace(
              p_template,
              '{{employee_name}}', COALESCE(p_username, 'Employee')
            ),
            '{{actual_value}}', trim(to_char(p_actual_value, 'FM999999999999990.##'))
          ),
          '{{threshold_value}}', trim(to_char(p_task.threshold_value, 'FM999999999999990.##'))
        ),
        '{{minimum_daily_orders}}', COALESCE(p_task.minimum_daily_orders::text, '')
      ),
      '{{bonus_amount}}', COALESCE(trim(to_char(p_task.reward_amount, 'FM999999999999990.00')), '')
    ),
    '{{currency}}', p_currency
  );
$$;

CREATE OR REPLACE FUNCTION private.evaluate_notification_automation_for_user(
  p_user_id uuid,
  p_now timestamptz DEFAULT clock_timestamp()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_task public.notification_automation_tasks%ROWTYPE;
  v_progress public.notification_automation_progress%ROWTYPE;
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
  v_processed integer := 0;
  v_operation_result jsonb;
BEGIN
  SELECT username INTO v_username
  FROM public.users
  WHERE id = p_user_id
    AND is_active = true;

  IF v_username IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_task IN
    SELECT task.*
    FROM public.notification_automation_tasks AS task
    WHERE task.status = 'active'
      AND task.is_shared_template = false
      AND COALESCE(task.starts_at, '-infinity'::timestamptz) <= p_now
      AND COALESCE(task.ends_at, 'infinity'::timestamptz) > p_now
    ORDER BY task.id
  LOOP
    CONTINUE WHEN NOT private.automation_task_applies_to_user(v_task, p_user_id);

    SELECT * INTO v_progress
    FROM public.notification_automation_progress
    WHERE task_id = v_task.id
      AND user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      PERFORM private.capture_automation_baseline(
        v_task,
        p_user_id,
        LEAST(
          p_now,
          COALESCE(v_task.starts_at, v_task.activated_at, p_now)
        )
      );
      SELECT * INTO v_progress
      FROM public.notification_automation_progress
      WHERE task_id = v_task.id
        AND user_id = p_user_id
      FOR UPDATE;
      CONTINUE WHEN NOT FOUND;
    END IF;

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

    CONTINUE WHEN v_stage <= 0 OR v_stage <= v_previous_stage;

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

      v_processed := v_processed + 1;
    END LOOP;
  END LOOP;

  RETURN v_processed;
END;
$function$;

CREATE OR REPLACE FUNCTION public.process_notification_automation_queue(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_item record;
  v_processed integer := 0;
  v_notifications integer := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('notification_automation_queue', 0)) THEN
    RETURN jsonb_build_object('success', true, 'skipped', true);
  END IF;

  FOR v_item IN
    SELECT queue.user_id
    FROM public.notification_automation_queue AS queue
    WHERE queue.next_attempt_at <= clock_timestamp()
    ORDER BY queue.requested_at
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500)
  LOOP
    BEGIN
      v_notifications := v_notifications
        + private.evaluate_notification_automation_for_user(v_item.user_id);
      DELETE FROM public.notification_automation_queue
      WHERE user_id = v_item.user_id;
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.notification_automation_queue
      SET attempts = attempts + 1,
          next_attempt_at = clock_timestamp() + make_interval(
            secs => LEAST(300, 5 * (attempts + 1))
          ),
          last_error = left(SQLERRM, 500)
      WHERE user_id = v_item.user_id;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'processed_users', v_processed,
    'created_notifications', v_notifications
  );
END;
$function$;

CREATE OR REPLACE FUNCTION private.queue_notification_automation_user(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  INSERT INTO public.notification_automation_queue(user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO UPDATE
  SET requested_at = LEAST(
        public.notification_automation_queue.requested_at,
        EXCLUDED.requested_at
      ),
      next_attempt_at = LEAST(
        public.notification_automation_queue.next_attempt_at,
        EXCLUDED.next_attempt_at
      );
$$;

CREATE OR REPLACE FUNCTION private.queue_automation_from_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $$
BEGIN
  IF NEW.status IN ('success', 'failure')
    AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
    PERFORM private.queue_notification_automation_user(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.queue_automation_from_wallet_transaction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $$
BEGIN
  IF NEW.type = 'commission' THEN
    PERFORM private.queue_notification_automation_user(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.queue_automation_from_work_session()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $$
BEGIN
  IF NEW.end_time IS NOT NULL
    AND (TG_OP = 'INSERT' OR OLD.end_time IS DISTINCT FROM NEW.end_time) THEN
    PERFORM private.queue_notification_automation_user(NEW.user_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS queue_notification_automation_from_order ON public.orders;
CREATE TRIGGER queue_notification_automation_from_order
AFTER INSERT OR UPDATE OF status ON public.orders
FOR EACH ROW EXECUTE FUNCTION private.queue_automation_from_order();

DROP TRIGGER IF EXISTS queue_notification_automation_from_wallet_transaction ON public.wallet_transactions;
CREATE TRIGGER queue_notification_automation_from_wallet_transaction
AFTER INSERT ON public.wallet_transactions
FOR EACH ROW EXECUTE FUNCTION private.queue_automation_from_wallet_transaction();

DROP TRIGGER IF EXISTS queue_notification_automation_from_work_session ON public.work_sessions;
CREATE TRIGGER queue_notification_automation_from_work_session
AFTER INSERT OR UPDATE OF end_time ON public.work_sessions
FOR EACH ROW EXECUTE FUNCTION private.queue_automation_from_work_session();

CREATE OR REPLACE FUNCTION public.get_notification_automation_dashboard(
  p_admin_session_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_result jsonb;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  SELECT jsonb_build_object(
    'currency', private.resolve_admin_currency(v_admin_id),
    'tasks', COALESCE((
      SELECT jsonb_agg(task_data ORDER BY (task_data->>'updated_at') DESC)
      FROM (
        SELECT to_jsonb(task.*)
          || jsonb_build_object(
            'owner_username', owner.username,
            'recipient_ids', COALESCE((
              SELECT jsonb_agg(recipient.user_id)
              FROM public.notification_automation_task_recipients AS recipient
              WHERE recipient.task_id = task.id
            ), '[]'::jsonb),
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
        WHERE task.owner_admin_id = v_admin_id
          OR v_admin_role = 'super_admin'
      ) AS visible_tasks
    ), '[]'::jsonb),
    'shared_templates', COALESCE((
      SELECT jsonb_agg(template_data ORDER BY (template_data->>'updated_at') DESC)
      FROM (
        SELECT to_jsonb(task.*)
          || jsonb_build_object('owner_username', owner.username) AS template_data
        FROM public.notification_automation_tasks AS task
        JOIN public.admins AS owner ON owner.id = task.owner_admin_id
        WHERE v_admin_role = 'secondary_admin'
          AND owner.role = 'super_admin'
          AND task.is_shared_template = true
          AND task.status IN ('active', 'paused')
      ) AS available_templates
    ), '[]'::jsonb),
    'executions', COALESCE((
      SELECT jsonb_agg(execution_data ORDER BY (execution_data->>'executed_at') DESC)
      FROM (
        SELECT to_jsonb(execution.*)
          || jsonb_build_object(
            'task_name', task.name,
            'employee_username', COALESCE(employee.username, execution.employee_username),
            'owner_username', owner.username
          ) AS execution_data
        FROM public.notification_automation_executions AS execution
        JOIN public.notification_automation_tasks AS task ON task.id = execution.task_id
        LEFT JOIN public.users AS employee ON employee.id = execution.user_id
        LEFT JOIN public.admins AS owner ON owner.id = execution.owner_admin_id
        WHERE execution.owner_admin_id = v_admin_id
          OR v_admin_role = 'super_admin'
        ORDER BY execution.executed_at DESC
        LIMIT 200
      ) AS visible_executions
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_notification_automation_task(
  p_admin_session_token uuid,
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
  p_message_type text,
  p_priority text,
  p_reward_enabled boolean,
  p_reward_amount numeric,
  p_is_shared_template boolean,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  IF p_is_shared_template AND v_admin_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can share automation templates.';
  END IF;
  IF p_trigger_type NOT IN ('total_orders', 'daily_orders', 'work_days', 'commission_amount', 'consecutive_work_days') THEN
    RAISE EXCEPTION 'Unsupported automation trigger.';
  END IF;
  IF p_trigger_mode NOT IN ('reach_once', 'recurring') THEN
    RAISE EXCEPTION 'Unsupported automation trigger mode.';
  END IF;
  IF p_threshold_value IS NULL
    OR p_threshold_value <= 0
    OR p_threshold_value > 1000000000000
    OR p_threshold_value::text IN ('NaN', 'Infinity', '-Infinity')
    OR (
      p_trigger_type <> 'commission_amount'
      AND p_threshold_value <> trunc(p_threshold_value)
    )
    OR (
      p_trigger_type = 'commission_amount'
      AND p_threshold_value < 0.01
    ) THEN
    RAISE EXCEPTION 'Trigger threshold is outside the supported range.';
  END IF;
  IF p_trigger_type = 'consecutive_work_days'
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
  IF p_recipient_scope = 'selected' AND COALESCE(cardinality(p_recipient_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one employee.';
  END IF;

  IF p_task_id IS NULL THEN
    INSERT INTO public.notification_automation_tasks (
      owner_admin_id,
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
      priority,
      reward_enabled,
      reward_amount,
      is_shared_template,
      starts_at,
      ends_at
    ) VALUES (
      v_admin_id,
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
      p_message_type,
      p_priority,
      COALESCE(p_reward_enabled, false),
      CASE WHEN p_reward_enabled THEN p_reward_amount ELSE NULL END,
      COALESCE(p_is_shared_template, false),
      p_starts_at,
      p_ends_at
    )
    RETURNING * INTO v_task;
  ELSE
    SELECT * INTO v_task
    FROM public.notification_automation_tasks
    WHERE id = p_task_id
      AND owner_admin_id = v_admin_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Automation task was not found or cannot be edited.';
    END IF;

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
        message_type = p_message_type,
        priority = p_priority,
        reward_enabled = COALESCE(p_reward_enabled, false),
        reward_amount = CASE WHEN p_reward_enabled THEN p_reward_amount ELSE NULL END,
        is_shared_template = COALESCE(p_is_shared_template, false),
        starts_at = p_starts_at,
        ends_at = p_ends_at,
        status = 'draft',
        activated_at = NULL,
        version = version + 1,
        updated_at = now()
    WHERE id = p_task_id
    RETURNING * INTO v_task;

    DELETE FROM public.notification_automation_task_recipients
    WHERE task_id = v_task.id;

    DELETE FROM public.notification_automation_progress
    WHERE task_id = v_task.id;
  END IF;

  IF p_recipient_scope = 'selected' THEN
    FOREACH v_user_id IN ARRAY p_recipient_ids
    LOOP
      IF NOT private.admin_can_manage_automation_user(
        v_admin_id,
        v_admin_role,
        v_user_id
      ) THEN
        RAISE EXCEPTION 'An employee is outside your management scope.';
      END IF;
      INSERT INTO public.notification_automation_task_recipients(task_id, user_id)
      VALUES (v_task.id, v_user_id);
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'task_id', v_task.id,
    'version', v_task.version,
    'status', v_task.status
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_notification_automation_task_status(
  p_admin_session_token uuid,
  p_task_id uuid,
  p_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_task public.notification_automation_tasks%ROWTYPE;
  v_user_id uuid;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  IF p_status NOT IN ('draft', 'active', 'paused', 'archived') THEN
    RAISE EXCEPTION 'Unsupported task status.';
  END IF;

  SELECT * INTO v_task
  FROM public.notification_automation_tasks
  WHERE id = p_task_id
    AND owner_admin_id = v_admin_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Automation task was not found or cannot be changed.';
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
      JOIN public.admins AS owner ON owner.id = v_task.owner_admin_id
      WHERE employee.is_active = true
        AND (
            (
            v_task.recipient_scope = 'all_managed'
            AND (
              owner.role = 'super_admin'
              OR employee.created_by = owner.id
            )
          )
          OR (
            v_task.recipient_scope = 'selected'
            AND EXISTS (
              SELECT 1
              FROM public.notification_automation_task_recipients AS recipient
              WHERE recipient.task_id = v_task.id
                AND recipient.user_id = employee.id
            )
          )
        )
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
$function$;

CREATE OR REPLACE FUNCTION public.copy_shared_notification_automation_task(
  p_admin_session_token uuid,
  p_source_task_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_source public.notification_automation_tasks%ROWTYPE;
  v_task_id uuid;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  IF v_admin_role <> 'secondary_admin' THEN
    RAISE EXCEPTION 'Only a secondary administrator can copy a shared template.';
  END IF;

  SELECT task.* INTO v_source
  FROM public.notification_automation_tasks AS task
  JOIN public.admins AS owner ON owner.id = task.owner_admin_id
  WHERE task.id = p_source_task_id
    AND task.is_shared_template = true
    AND owner.role = 'super_admin';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Shared automation template was not found.';
  END IF;

  INSERT INTO public.notification_automation_tasks (
    owner_admin_id,
    source_task_id,
    source_version,
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
    priority,
    reward_enabled,
    reward_amount,
    starts_at,
    ends_at
  ) VALUES (
    v_admin_id,
    v_source.id,
    v_source.version,
    v_source.name,
    v_source.description,
    v_source.trigger_type,
    v_source.trigger_mode,
    v_source.threshold_value,
    v_source.minimum_daily_orders,
    v_source.minimum_daily_work_minutes,
    'all_managed',
    v_source.title_template,
    v_source.content_template,
    v_source.message_type,
    v_source.priority,
    v_source.reward_enabled,
    v_source.reward_amount,
    v_source.starts_at,
    v_source.ends_at
  )
  RETURNING id INTO v_task_id;

  RETURN jsonb_build_object(
    'success', true,
    'task_id', v_task_id,
    'status', 'draft'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.send_admin_message_secure(
  p_admin_session_token uuid,
  p_recipient_ids uuid[],
  p_title text,
  p_content text,
  p_message_type text,
  p_priority text,
  p_reward_amount numeric,
  p_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_admin_username text;
  v_currency text;
  v_cached jsonb;
  v_message_id uuid;
  v_recipient_id uuid;
  v_user_id uuid;
  v_transaction_id uuid;
  v_child_operation_id uuid;
  v_sent integer := 0;
  v_result jsonb;
BEGIN
  SELECT context.admin_id, context.admin_role, admin.username
  INTO v_admin_id, v_admin_role, v_admin_username
  FROM private.get_financial_admin_context(p_admin_session_token) AS context
  JOIN public.admins AS admin ON admin.id = context.admin_id;

  IF COALESCE(cardinality(p_recipient_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one employee.';
  END IF;
  IF char_length(trim(COALESCE(p_title, ''))) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'Message title must contain between 1 and 200 characters.';
  END IF;
  IF char_length(trim(COALESCE(p_content, ''))) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Message content must contain between 1 and 5000 characters.';
  END IF;
  IF p_message_type NOT IN ('login_popup', 'realtime') THEN
    RAISE EXCEPTION 'Unsupported message type.';
  END IF;
  IF p_priority NOT IN ('low', 'normal', 'high', 'urgent') THEN
    RAISE EXCEPTION 'Unsupported message priority.';
  END IF;
  IF p_reward_amount IS NOT NULL
    AND (
      p_reward_amount <= 0
      OR p_reward_amount::text IN ('NaN', 'Infinity', '-Infinity')
    ) THEN
    RAISE EXCEPTION 'Performance bonus must be a finite positive amount.';
  END IF;

  v_cached := private.begin_financial_operation(
    p_operation_id,
    'admin_message_send',
    'admin',
    v_admin_id,
    jsonb_build_object(
      'recipient_ids', to_jsonb(p_recipient_ids),
      'title', trim(p_title),
      'content', p_content,
      'message_type', p_message_type,
      'priority', p_priority,
      'reward_amount', p_reward_amount
    )
  );
  IF v_cached IS NOT NULL THEN
    RETURN v_cached;
  END IF;

  FOREACH v_user_id IN ARRAY p_recipient_ids
  LOOP
    IF NOT private.admin_can_manage_automation_user(
      v_admin_id,
      v_admin_role,
      v_user_id
    ) THEN
      RAISE EXCEPTION 'An employee is outside your management scope.';
    END IF;
  END LOOP;

  v_currency := private.resolve_admin_currency(v_admin_id);

  INSERT INTO public.messages (
    sender_id,
    sender_username,
    title,
    content,
    message_type,
    priority,
    notification_category,
    reward_amount,
    reward_currency
  ) VALUES (
    v_admin_id,
    v_admin_username,
    trim(p_title),
    p_content,
    p_message_type,
    p_priority,
    CASE WHEN p_reward_amount IS NOT NULL THEN 'performance_reward' ELSE 'standard' END,
    p_reward_amount,
    CASE WHEN p_reward_amount IS NOT NULL THEN v_currency ELSE NULL END
  )
  RETURNING id INTO v_message_id;

  FOREACH v_user_id IN ARRAY p_recipient_ids
  LOOP
    INSERT INTO public.message_recipients(message_id, recipient_id)
    VALUES (v_message_id, v_user_id)
    RETURNING id INTO v_recipient_id;

    IF p_reward_amount IS NOT NULL THEN
      v_child_operation_id := gen_random_uuid();
      v_transaction_id := private.credit_performance_bonus(
        v_user_id,
        v_admin_id,
        p_reward_amount,
        v_currency,
        v_recipient_id,
        v_child_operation_id,
        'Performance Bonus / 業績獎金'
      );
    END IF;
    v_sent := v_sent + 1;
  END LOOP;

  v_result := jsonb_build_object(
    'success', true,
    'message_id', v_message_id,
    'sent_count', v_sent,
    'reward_amount', p_reward_amount,
    'currency', CASE WHEN p_reward_amount IS NOT NULL THEN v_currency ELSE NULL END,
    'total_reward', CASE
      WHEN p_reward_amount IS NOT NULL THEN p_reward_amount * v_sent
      ELSE NULL
    END
  );

  PERFORM private.save_financial_operation(
    p_operation_id,
    'admin_message_send',
    'admin',
    v_admin_id,
    jsonb_build_object(
      'recipient_ids', to_jsonb(p_recipient_ids),
      'title', trim(p_title),
      'content', p_content,
      'message_type', p_message_type,
      'priority', p_priority,
      'reward_amount', p_reward_amount
    ),
    v_result
  );

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_notification_automation_dashboard(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_notification_automation_task(uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_notification_automation_task_status(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.copy_shared_notification_automation_task(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.send_admin_message_secure(uuid, uuid[], text, text, text, text, numeric, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.process_notification_automation_queue(integer) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_notification_automation_dashboard(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_notification_automation_task(uuid, uuid, text, text, text, text, numeric, integer, integer, text, uuid[], text, text, text, text, boolean, numeric, boolean, timestamptz, timestamptz) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_notification_automation_task_status(uuid, uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.copy_shared_notification_automation_task(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_admin_message_secure(uuid, uuid[], text, text, text, text, numeric, uuid) TO anon, authenticated;

DO $block$
DECLARE
  v_job_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    SELECT jobid INTO v_job_id
    FROM cron.job
    WHERE jobname = 'process_notification_automation_queue_every_minute';

    IF v_job_id IS NULL THEN
      PERFORM cron.schedule(
        'process_notification_automation_queue_every_minute',
        '* * * * *',
        $command$SELECT public.process_notification_automation_queue(200);$command$
      );
    END IF;
  END IF;
END;
$block$;
