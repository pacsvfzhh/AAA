UPDATE public.notification_automation_tasks
SET minimum_daily_orders = 1
WHERE trigger_type IN ('work_days', 'consecutive_work_days')
  AND minimum_daily_orders IS NULL;

ALTER TABLE public.notification_automation_tasks
  DROP CONSTRAINT IF EXISTS notification_automation_tasks_daily_orders_check;

ALTER TABLE public.notification_automation_tasks
  ADD CONSTRAINT notification_automation_tasks_daily_orders_check
  CHECK (
    trigger_type NOT IN ('work_days', 'consecutive_work_days')
    OR minimum_daily_orders IS NOT NULL
  );

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
      SELECT (work_session.start_time AT TIME ZONE 'UTC')::date AS day_date
      FROM public.work_sessions AS work_session
      WHERE work_session.user_id = p_user_id
        AND work_session.end_time IS NOT NULL
        AND work_session.end_time <= p_now
      GROUP BY (work_session.start_time AT TIME ZONE 'UTC')::date
      HAVING sum(COALESCE(
        work_session.duration_minutes,
        floor(extract(epoch FROM (COALESCE(work_session.end_time, p_now) - work_session.start_time)) / 60)::integer,
        0
      )) >= COALESCE(p_task.minimum_daily_work_minutes, 1)
        AND EXISTS (
          SELECT 1
          FROM public.orders
          WHERE orders.user_id = p_user_id
            AND orders.status IN ('success', 'failure')
            AND (orders.processed_at AT TIME ZONE 'UTC')::date = (work_session.start_time AT TIME ZONE 'UTC')::date
            AND orders.processed_at < p_now
          GROUP BY (orders.processed_at AT TIME ZONE 'UTC')::date
          HAVING count(*) >= COALESCE(p_task.minimum_daily_orders, 1)
        )
    ) AS qualifying_work_days;
  ELSIF p_task.trigger_type = 'commission_amount' THEN
    SELECT COALESCE(sum(amount), 0)
    INTO v_metric
    FROM public.wallet_transactions
    WHERE user_id = p_user_id
      AND type = 'commission'
      AND created_at < p_now;
  ELSIF p_task.trigger_type = 'annual_date' THEN
    v_period_key := 'annual-' || to_char(p_now AT TIME ZONE 'UTC', 'YYYY');
    IF extract(month FROM p_now AT TIME ZONE 'UTC')::integer = p_task.annual_month
      AND extract(day FROM p_now AT TIME ZONE 'UTC')::integer = p_task.annual_day THEN
      v_metric := 1;
    ELSE
      v_metric := 0;
    END IF;
  ELSIF p_task.trigger_type = 'first_login' THEN
    v_period_key := 'first-login';
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM public.employee_login_history
      WHERE user_id = p_user_id
        AND action_type = 'login'
        AND created_at < p_now
    ) THEN 1 ELSE 0 END
    INTO v_metric;
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
