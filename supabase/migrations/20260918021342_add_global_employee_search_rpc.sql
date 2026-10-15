CREATE INDEX IF NOT EXISTS idx_verification_approved_real_name
  ON public.verification_requests(real_name)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_verification_approved_email
  ON public.verification_requests(email)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_verification_approved_phone
  ON public.verification_requests(phone)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_verification_approved_wallet_address
  ON public.verification_requests(wallet_address)
  WHERE status = 'approved';

CREATE OR REPLACE FUNCTION public.search_all_employees_for_admin(
  p_admin_session_token uuid,
  p_search_term text,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_search_term text := btrim(COALESCE(p_search_term, ''));
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
  v_result jsonb;
BEGIN
  PERFORM context.admin_id
  FROM private.get_financial_admin_context(p_admin_session_token) context;

  IF v_search_term = '' THEN
    RETURN '[]'::jsonb;
  END IF;

  WITH candidate_user_ids AS (
    SELECT u.id AS user_id
    FROM public.users AS u
    LEFT JOIN public.admins AS owner_admin ON owner_admin.id = u.created_by
    WHERE owner_admin.role IS DISTINCT FROM 'emergency_admin'
      AND (u.username = v_search_term OR u.employee_id = v_search_term)

    UNION

    SELECT search_verification.user_id
    FROM public.verification_requests AS search_verification
    JOIN public.users AS search_user ON search_user.id = search_verification.user_id
    LEFT JOIN public.admins AS search_owner_admin ON search_owner_admin.id = search_user.created_by
    WHERE search_owner_admin.role IS DISTINCT FROM 'emergency_admin'
      AND search_verification.status = 'approved'
      AND (
        search_verification.real_name = v_search_term
        OR search_verification.email = v_search_term
        OR search_verification.phone = v_search_term
        OR search_verification.wallet_address = v_search_term
      )
  )
  SELECT COALESCE(
    jsonb_agg(matched.payload ORDER BY matched.is_pinned DESC, matched.username),
    '[]'::jsonb
  )
  INTO v_result
  FROM (
    SELECT
      u.username,
      COALESCE(u.is_pinned, false) AS is_pinned,
      jsonb_build_object(
        'id', u.id,
        'username', u.username,
        'employee_id', u.employee_id,
        'created_at', u.created_at,
        'is_active', u.is_active,
        'is_verified', u.is_verified,
        'remarks', u.remarks,
        'tags', COALESCE(to_jsonb(u.tags), '[]'::jsonb),
        'total_income', COALESCE(w.available_balance, 0) + COALESCE(w.frozen_balance, 0),
        'first_success_order_date', u.first_success_order_date,
        'admin_info', CASE
          WHEN owner_admin.id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'username', owner_admin.username,
            'role', owner_admin.role
          )
        END,
        'verification_info', CASE
          WHEN verification.id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'real_name', verification.real_name,
            'email', verification.email,
            'phone', verification.phone,
            'wallet_address', verification.wallet_address,
            'created_at', verification.created_at
          )
        END
      ) AS payload
    FROM candidate_user_ids AS candidate
    JOIN public.users AS u ON u.id = candidate.user_id
    LEFT JOIN public.admins AS owner_admin ON owner_admin.id = u.created_by
    LEFT JOIN public.wallets AS w ON w.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT
        vr.id,
        vr.real_name,
        vr.email,
        vr.phone,
        vr.wallet_address,
        vr.created_at
      FROM public.verification_requests AS vr
      WHERE vr.user_id = u.id
        AND vr.status = 'approved'
      ORDER BY vr.created_at DESC
      LIMIT 1
    ) AS verification ON true
    WHERE owner_admin.role IS DISTINCT FROM 'emergency_admin'
    ORDER BY COALESCE(u.is_pinned, false) DESC, u.username
    LIMIT v_limit
  ) AS matched;

  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.search_all_employees_for_admin(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_all_employees_for_admin(uuid, text, integer) TO anon, authenticated;

COMMENT ON FUNCTION public.search_all_employees_for_admin(uuid, text, integer) IS
  'Allows active super and secondary administrators to search employees across non-emergency administrator groups after validating the financial session token.';
