CREATE OR REPLACE FUNCTION public.change_admin_username_atomic(
  p_admin_session_token uuid,
  p_current_password text,
  p_new_username text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'extensions', 'pg_temp'
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_password_hash text;
  v_admin public.admins%ROWTYPE;
BEGIN
  SELECT s.admin_id, a.role, credentials.password_hash
  INTO v_admin_id, v_admin_role, v_password_hash
  FROM public.admin_financial_sessions s
  JOIN public.financial_admin_credentials credentials ON credentials.admin_id = s.admin_id
  JOIN public.admins a ON a.id = s.admin_id
  WHERE s.token_hash = private.hash_financial_token(p_admin_session_token)
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND a.is_active = true;

  IF v_admin_id IS NULL OR NOT private.verify_bcrypt_password(p_current_password, v_password_hash) THEN
    RAISE EXCEPTION 'Current password is incorrect.';
  END IF;
  IF v_admin_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can change the username.';
  END IF;
  IF length(trim(p_new_username)) < 3 OR trim(p_new_username) !~ '^[A-Za-z0-9_]+$' THEN
    RAISE EXCEPTION 'Username must contain at least three letters, numbers, or underscores.';
  END IF;

  UPDATE public.admins
  SET username = trim(p_new_username),
      updated_at = now()
  WHERE id = v_admin_id
  RETURNING * INTO v_admin;

  RETURN jsonb_build_object(
    'success', true,
    'user', to_jsonb(v_admin) - 'password_hash'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.change_admin_username_atomic(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.change_admin_username_atomic(uuid, text, text) TO anon, authenticated;

COMMENT ON FUNCTION public.change_admin_username_atomic IS 'Allows an active super administrator to change their own username after current-password verification.';
