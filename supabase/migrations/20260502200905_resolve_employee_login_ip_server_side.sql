/*
  # Resolve employee login/logout IP on the server side

  1. Changes
    - Update `log_employee_login` and `log_employee_logout` to read the client IP
      from the PostgREST request headers (`x-forwarded-for` first segment, then
      `x-real-ip`) before falling back to the IP passed in from the browser.
    - If neither source yields a usable value, keep writing `'Unknown'` so
      behaviour is strictly non-regressive.

  2. Why
    - The browser-side fetch to api.ipify.org is unreliable on cloned
      deployments (CSP, regional blocks, 500ms logout race), which caused the
      Latest Logout IP column to show `Unknown`. Resolving the IP from the
      request headers is zero-config on any Supabase project.

  3. Safety
    - Function signatures, return types and parameter lists are unchanged, so
      no frontend call site needs updating.
    - No table, RLS policy, trigger or existing data is modified.
    - `current_setting('request.headers', true)` uses missing_ok = true and
      cannot raise; JSON parsing is wrapped so malformed headers fall through
      to the existing fallback chain.
*/

CREATE OR REPLACE FUNCTION public.log_employee_login(
  p_user_id uuid,
  p_username text,
  p_employee_id text,
  p_ip_address text,
  p_user_agent text DEFAULT NULL::text,
  p_session_id text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_log_id uuid;
  v_headers jsonb;
  v_server_ip text;
  v_final_ip text;
BEGIN
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;

  IF v_headers IS NOT NULL THEN
    v_server_ip := split_part(COALESCE(v_headers ->> 'x-forwarded-for', ''), ',', 1);
    v_server_ip := NULLIF(trim(v_server_ip), '');
    IF v_server_ip IS NULL THEN
      v_server_ip := NULLIF(trim(COALESCE(v_headers ->> 'x-real-ip', '')), '');
    END IF;
  END IF;

  v_final_ip := COALESCE(
    v_server_ip,
    NULLIF(trim(COALESCE(p_ip_address, '')), ''),
    'Unknown'
  );

  INSERT INTO employee_login_history (
    user_id, username, employee_id, action_type,
    ip_address, user_agent, session_id
  ) VALUES (
    p_user_id, p_username, p_employee_id, 'login',
    v_final_ip, p_user_agent, p_session_id
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.log_employee_logout(
  p_user_id uuid,
  p_username text,
  p_employee_id text,
  p_ip_address text,
  p_user_agent text DEFAULT NULL::text,
  p_session_id text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_log_id uuid;
  v_headers jsonb;
  v_server_ip text;
  v_final_ip text;
BEGIN
  BEGIN
    v_headers := NULLIF(current_setting('request.headers', true), '')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := NULL;
  END;

  IF v_headers IS NOT NULL THEN
    v_server_ip := split_part(COALESCE(v_headers ->> 'x-forwarded-for', ''), ',', 1);
    v_server_ip := NULLIF(trim(v_server_ip), '');
    IF v_server_ip IS NULL THEN
      v_server_ip := NULLIF(trim(COALESCE(v_headers ->> 'x-real-ip', '')), '');
    END IF;
  END IF;

  v_final_ip := COALESCE(
    v_server_ip,
    NULLIF(trim(COALESCE(p_ip_address, '')), ''),
    'Unknown'
  );

  INSERT INTO employee_login_history (
    user_id, username, employee_id, action_type,
    ip_address, user_agent, session_id
  ) VALUES (
    p_user_id, p_username, p_employee_id, 'logout',
    v_final_ip, p_user_agent, p_session_id
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$function$;
