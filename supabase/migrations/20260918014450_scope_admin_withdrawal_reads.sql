CREATE INDEX IF NOT EXISTS idx_users_created_by
  ON public.users(created_by);

CREATE OR REPLACE FUNCTION public.get_withdrawals_for_admin(
  p_admin_session_token uuid
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  amount numeric,
  status text,
  audit_remark text,
  audited_by uuid,
  audited_at timestamptz,
  last_operation_id uuid,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) context;

  IF v_admin_role = 'super_admin' THEN
    RETURN QUERY
    SELECT
      w.id,
      w.user_id,
      w.amount,
      w.status,
      w.audit_remark,
      w.audited_by,
      w.audited_at,
      w.last_operation_id,
      w.created_at
    FROM public.withdrawals AS w
    ORDER BY w.created_at DESC;
  ELSE
    RETURN QUERY
    SELECT
      w.id,
      w.user_id,
      w.amount,
      w.status,
      w.audit_remark,
      w.audited_by,
      w.audited_at,
      w.last_operation_id,
      w.created_at
    FROM public.withdrawals AS w
    JOIN public.users AS u ON u.id = w.user_id
    WHERE u.created_by = v_admin_id
    ORDER BY w.created_at DESC;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_withdrawal_review_data(
  p_admin_session_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_result jsonb;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) context;

  SELECT jsonb_build_object(
    'admin_id', v_admin_id,
    'admin_role', v_admin_role,
    'withdrawals', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', w.id,
        'user_id', w.user_id,
        'amount', w.amount,
        'status', w.status,
        'audit_remark', w.audit_remark,
        'audited_by', w.audited_by,
        'audited_at', w.audited_at,
        'last_operation_id', w.last_operation_id,
        'created_at', w.created_at
      ) ORDER BY w.created_at DESC)
      FROM public.withdrawals AS w
      WHERE v_admin_role = 'super_admin'
        OR EXISTS (
          SELECT 1
          FROM public.users AS owned_user
          WHERE owned_user.id = w.user_id
            AND owned_user.created_by = v_admin_id
        )
    ), '[]'::jsonb),
    'employees', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', u.id,
        'username', u.username,
        'employee_id', u.employee_id,
        'created_by', u.created_by
      ) ORDER BY u.username)
      FROM public.users AS u
      WHERE v_admin_role = 'super_admin'
        OR u.created_by = v_admin_id
    ), '[]'::jsonb),
    'admins', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', a.id,
        'username', a.username,
        'role', a.role
      ) ORDER BY a.username)
      FROM public.admins AS a
      WHERE v_admin_role = 'super_admin'
        OR a.id = v_admin_id
    ), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_pending_withdrawal_count_for_admin(
  p_admin_session_token uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_count bigint;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) context;

  IF v_admin_role = 'super_admin' THEN
    SELECT COUNT(*)
    INTO v_count
    FROM public.withdrawals AS w
    WHERE w.status = 'pending';
  ELSE
    SELECT COUNT(*)
    INTO v_count
    FROM public.withdrawals AS w
    JOIN public.users AS u ON u.id = w.user_id
    WHERE w.status = 'pending'
      AND u.created_by = v_admin_id;
  END IF;

  RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_withdrawals_for_admin(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_withdrawal_review_data(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_pending_withdrawal_count_for_admin(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_withdrawals_for_admin(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_withdrawal_review_data(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_withdrawal_count_for_admin(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.get_withdrawals_for_admin(uuid) IS
  'Returns all withdrawals for a super administrator or only owned-employee withdrawals for a secondary administrator, based on the financial session token.';
COMMENT ON FUNCTION public.get_withdrawal_review_data(uuid) IS
  'Returns the withdrawal review rows and association metadata within the administrator scope derived from the financial session token.';
COMMENT ON FUNCTION public.get_pending_withdrawal_count_for_admin(uuid) IS
  'Returns the pending withdrawal count within the administrator scope derived from the financial session token.';
