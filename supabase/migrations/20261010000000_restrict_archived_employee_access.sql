CREATE OR REPLACE FUNCTION private.assert_admin_can_manage_user(
  p_admin_id uuid, p_admin_role text, p_user_id uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF p_admin_role = 'super_admin' THEN
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = p_user_id AND archived_at IS NULL) THEN
      RAISE EXCEPTION 'Employee account was not found.';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users
    WHERE id = p_user_id AND created_by = p_admin_id AND archived_at IS NULL) THEN
    RAISE EXCEPTION 'You do not have permission to manage this employee.';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION private.assert_admin_can_manage_user(uuid, text, uuid) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_definition text;
  v_function regprocedure;
  v_old text;
  v_new text;
BEGIN
  v_function := 'public.get_employee_login_summary(uuid,text)'::regprocedure;
  v_definition := pg_get_functiondef(v_function);
  IF strpos(v_definition, 'WHERE (p_search_term IS NULL') = 0
    OR strpos(v_definition, 'WHERE u.created_by = v_admin_id') = 0 THEN
    RAISE EXCEPTION 'Login summary function has changed; review archive filters before deploying.';
  END IF;
  v_definition := replace(v_definition, 'WHERE (p_search_term IS NULL',
    'WHERE u.archived_at IS NULL AND (p_search_term IS NULL');
  v_definition := replace(v_definition, 'WHERE u.created_by = v_admin_id',
    'WHERE u.archived_at IS NULL AND u.created_by = v_admin_id');
  EXECUTE v_definition;

  v_function := 'public.get_employee_login_history_with_device_info(uuid,uuid,integer,integer)'::regprocedure;
  v_definition := pg_get_functiondef(v_function);
  IF strpos(v_definition, 'WHERE u.id = p_user_id;') = 0 THEN
    RAISE EXCEPTION 'Login history function has changed; review archive filters before deploying.';
  END IF;
  EXECUTE replace(v_definition, 'WHERE u.id = p_user_id;',
    'WHERE u.id = p_user_id AND u.archived_at IS NULL;');

  v_function := 'public.get_withdrawals_for_admin(uuid)'::regprocedure;
  v_definition := pg_get_functiondef(v_function);
  IF strpos(v_definition, 'FROM public.withdrawals AS w
    ORDER BY w.created_at DESC;') = 0
    OR strpos(v_definition, 'JOIN public.users AS u ON u.id = w.user_id') = 0 THEN
    RAISE EXCEPTION 'Withdrawal list function has changed; review archive filters before deploying.';
  END IF;
  v_definition := replace(v_definition, 'FROM public.withdrawals AS w
    ORDER BY w.created_at DESC;',
    'FROM public.withdrawals AS w
    JOIN public.users AS u ON u.id = w.user_id AND u.archived_at IS NULL
    ORDER BY w.created_at DESC;');
  v_definition := replace(v_definition, 'JOIN public.users AS u ON u.id = w.user_id
    WHERE u.created_by',
    'JOIN public.users AS u ON u.id = w.user_id AND u.archived_at IS NULL
    WHERE u.created_by');
  EXECUTE v_definition;

  v_function := 'public.get_withdrawal_review_data(uuid)'::regprocedure;
  v_definition := pg_get_functiondef(v_function);
  IF strpos(v_definition, 'WHERE v_admin_role = ''super_admin''
        OR EXISTS (') = 0
    OR strpos(v_definition, 'WHERE v_admin_role = ''super_admin''
        OR u.created_by = v_admin_id') = 0 THEN
    RAISE EXCEPTION 'Withdrawal review function has changed; review archive filters before deploying.';
  END IF;
  v_definition := replace(v_definition, 'WHERE v_admin_role = ''super_admin''
        OR EXISTS (',
    'WHERE EXISTS (SELECT 1 FROM public.users AS active_user
        WHERE active_user.id = w.user_id AND active_user.archived_at IS NULL)
        AND (v_admin_role = ''super_admin'' OR EXISTS (');
  v_definition := replace(v_definition, 'AND owned_user.created_by = v_admin_id
        )',
    'AND owned_user.created_by = v_admin_id
        ))');
  v_definition := replace(v_definition, 'WHERE v_admin_role = ''super_admin''
        OR u.created_by = v_admin_id',
    'WHERE u.archived_at IS NULL AND (v_admin_role = ''super_admin'' OR u.created_by = v_admin_id)');
  EXECUTE v_definition;

  v_function := 'public.get_pending_withdrawal_count_for_admin(uuid)'::regprocedure;
  v_definition := pg_get_functiondef(v_function);
  IF strpos(v_definition, 'WHERE w.status = ''pending'';') = 0
    OR strpos(v_definition, 'JOIN public.users AS u ON u.id = w.user_id') = 0 THEN
    RAISE EXCEPTION 'Pending withdrawal function has changed; review archive filters before deploying.';
  END IF;
  v_definition := replace(v_definition, 'WHERE w.status = ''pending'';',
    'WHERE w.status = ''pending'' AND EXISTS (SELECT 1 FROM public.users AS active_user
      WHERE active_user.id = w.user_id AND active_user.archived_at IS NULL);');
  v_definition := replace(v_definition, 'JOIN public.users AS u ON u.id = w.user_id',
    'JOIN public.users AS u ON u.id = w.user_id AND u.archived_at IS NULL');
  EXECUTE v_definition;

  FOREACH v_function IN ARRAY ARRAY[
    'public.get_account_locks_for_admin(uuid)'::regprocedure,
    'public.get_account_lock_history_for_admin(uuid,integer)'::regprocedure
  ] LOOP
    v_definition := pg_get_functiondef(v_function);
    IF v_function::text LIKE '%get_account_locks_for_admin%' THEN
      v_old := 'WHERE al.unlocked_at IS NULL';
    ELSE
      v_old := 'WHERE al.identifier_type = ''username''';
    END IF;
    IF strpos(v_definition, v_old) = 0 THEN
      RAISE EXCEPTION 'Account lock function % has changed; review archive filters before deploying.', v_function;
    END IF;
    v_new := v_old || '
      AND NOT EXISTS (SELECT 1 FROM private.deleted_employee_accounts AS archived
        WHERE archived.employee_id = al.user_id
          OR (al.identifier_type = ''username'' AND archived.account_username = al.identifier))';
    EXECUTE replace(v_definition, v_old, v_new);
  END LOOP;

  v_function := 'public.get_notification_automation_dashboard_v2(uuid,uuid)'::regprocedure;
  v_definition := pg_get_functiondef(v_function);
  IF strpos(v_definition, 'WHERE employee.created_by = visible_admin.id') = 0
    OR strpos(v_definition, 'WHERE employee.created_by = v_owner_admin_id') = 0 THEN
    RAISE EXCEPTION 'Automation dashboard has changed; review archive filters before deploying.';
  END IF;
  IF strpos(v_definition, 'WHERE execution.owner_admin_id = v_owner_admin_id
        ORDER BY execution.executed_at DESC') = 0 THEN
    RAISE EXCEPTION 'Automation execution list has changed; review archive filters before deploying.';
  END IF;
  v_definition := replace(v_definition, 'WHERE employee.created_by = visible_admin.id',
    'WHERE employee.created_by = visible_admin.id AND employee.archived_at IS NULL');
  v_definition := replace(v_definition, 'WHERE employee.created_by = v_owner_admin_id',
    'WHERE employee.created_by = v_owner_admin_id AND employee.archived_at IS NULL');
  v_definition := replace(v_definition, 'WHERE execution.owner_admin_id = v_owner_admin_id
        ORDER BY execution.executed_at DESC',
    'WHERE execution.owner_admin_id = v_owner_admin_id
          AND NOT EXISTS (SELECT 1 FROM public.users AS archived_user
            WHERE archived_user.id = execution.user_id AND archived_user.archived_at IS NOT NULL)
        ORDER BY execution.executed_at DESC');
  EXECUTE v_definition;

  v_function := 'public.get_notification_automation_executions_v2(uuid,uuid,uuid,boolean,text)'::regprocedure;
  v_definition := pg_get_functiondef(v_function);
  IF strpos(v_definition, 'WHERE execution.owner_admin_id = v_owner_admin_id') = 0 THEN
    RAISE EXCEPTION 'Automation execution search has changed; review archive filters before deploying.';
  END IF;
  EXECUTE replace(v_definition, 'WHERE execution.owner_admin_id = v_owner_admin_id',
    'WHERE execution.owner_admin_id = v_owner_admin_id
        AND NOT EXISTS (SELECT 1 FROM public.users AS archived_user
          WHERE archived_user.id = execution.user_id AND archived_user.archived_at IS NOT NULL)');

  v_function := 'public.get_notification_automation_dashboard(uuid,uuid)'::regprocedure;
  v_definition := pg_get_functiondef(v_function);
  IF strpos(v_definition, 'WHERE execution.owner_admin_id = v_selected_admin_id
          OR (v_admin_role = ''super_admin'' AND v_selected_admin_id IS NULL)') = 0 THEN
    RAISE EXCEPTION 'Legacy automation dashboard has changed; review archive filters before deploying.';
  END IF;
  EXECUTE replace(v_definition, 'WHERE execution.owner_admin_id = v_selected_admin_id
          OR (v_admin_role = ''super_admin'' AND v_selected_admin_id IS NULL)',
    'WHERE (execution.owner_admin_id = v_selected_admin_id
          OR (v_admin_role = ''super_admin'' AND v_selected_admin_id IS NULL))
          AND NOT EXISTS (SELECT 1 FROM public.users AS archived_user
            WHERE archived_user.id = execution.user_id AND archived_user.archived_at IS NOT NULL)');

  v_function := 'public.get_notification_automation_plan_assignments(uuid)'::regprocedure;
  v_definition := pg_get_functiondef(v_function);
  IF strpos(v_definition, 'JOIN public.users AS employee ON employee.id = member.user_id') = 0 THEN
    RAISE EXCEPTION 'Automation assignments have changed; review archive filters before deploying.';
  END IF;
  EXECUTE replace(v_definition, 'JOIN public.users AS employee ON employee.id = member.user_id',
    'JOIN public.users AS employee ON employee.id = member.user_id AND employee.archived_at IS NULL');
END;
$$;

DO $$
DECLARE
  v_table text;
  v_column text;
BEGIN
  FOR v_table, v_column IN
    SELECT table_name, link_column FROM (VALUES
      ('broadcast_recipients', 'employee_id'),
      ('commission_audit_log', 'user_id'),
      ('customer_auto_message_logs', 'employee_id'),
      ('customer_employee_conversations', 'employee_id'),
      ('customer_service_sessions', 'employee_id'),
      ('dispatch_assignments', 'user_id'),
      ('dispatch_group_members', 'user_id'),
      ('dispatch_rate_limits', 'user_id'),
      ('dispatch_sessions', 'user_id'),
      ('dispatch_system_logs', 'user_id'),
      ('employee_presence_events', 'user_id'),
      ('orders', 'user_id'),
      ('orders_history', 'user_id'),
      ('orders_history_2025', 'user_id'),
      ('orders_history_2026', 'user_id'),
      ('rating_requests', 'employee_id'),
      ('service_ratings', 'employee_id'),
      ('used_order_data', 'user_id'),
      ('verification_requests', 'user_id'),
      ('wallet_transactions', 'user_id'),
      ('wallets', 'user_id'),
      ('withdrawal_events', 'user_id'),
      ('withdrawals', 'user_id'),
      ('work_sessions', 'user_id')
    ) AS linked(table_name, link_column)
  LOOP
    EXECUTE format('CREATE POLICY archived_employee_visibility ON public.%I AS RESTRICTIVE
      FOR ALL TO anon, authenticated
      USING (%I IS NULL OR EXISTS (SELECT 1 FROM public.users AS active_employee WHERE active_employee.id = %I.%I))
      WITH CHECK (%I IS NULL OR EXISTS (SELECT 1 FROM public.users AS active_employee WHERE active_employee.id = %I.%I))',
      v_table, v_column, v_table, v_column, v_column, v_table, v_column);
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
