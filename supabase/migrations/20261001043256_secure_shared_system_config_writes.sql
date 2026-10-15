-- Keep public/employee reads and the existing Realtime publication, but remove
-- direct client writes to shared system settings.
DROP POLICY IF EXISTS "Consolidated: Access system configs" ON public.system_configs;
DROP POLICY IF EXISTS "Allow modifying system configs for authenticated users" ON public.system_configs;
DROP POLICY IF EXISTS "Allow reading system configs for authenticated users" ON public.system_configs;

CREATE POLICY "Read system configs"
  ON public.system_configs FOR SELECT
  TO anon, authenticated
  USING (true);

REVOKE INSERT, UPDATE, DELETE ON TABLE public.system_configs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.system_configs TO anon, authenticated;

-- This older SECURITY DEFINER writer was already revoked from client roles,
-- but PUBLIC's default EXECUTE grant could still make it reachable by them.
REVOKE EXECUTE ON FUNCTION public.update_ios_config(jsonb) FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.admin_save_shared_system_config(
  p_admin_session_token uuid,
  p_key text,
  p_value jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_role text;
  v_tab_ids text[] := ARRAY[
    'employees', 'products', 'withdrawals', 'verifications', 'announcements',
    'config', 'admins', 'validdata', 'messages', 'dispatch', 'records',
    'customerservice', 'cccservice', 'employeesearch', 'history',
    'accountlocks', 'loginhistory'
  ];
BEGIN
  SELECT context.admin_role INTO v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;
  IF v_admin_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can save shared system settings.';
  END IF;

  IF p_key IS NULL OR p_key NOT IN (
    'admin_navigation_preferences', 'announcement_carousel_enabled',
    'announcement_carousel_speed', 'login_title', 'login_subtitle'
  ) THEN
    RAISE EXCEPTION 'Unsupported shared system setting.';
  END IF;

  IF p_value IS NULL THEN
    RAISE EXCEPTION 'Shared system setting value is required.';
  END IF;

  CASE p_key
    WHEN 'admin_navigation_preferences' THEN
      IF jsonb_typeof(p_value) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Navigation preferences must be an object.';
      END IF;
      IF NOT (p_value ? 'order' AND p_value ? 'labels')
         OR jsonb_typeof(p_value->'order') IS DISTINCT FROM 'array'
         OR jsonb_typeof(p_value->'labels') IS DISTINCT FROM 'object'
         OR EXISTS (
           SELECT 1 FROM jsonb_object_keys(p_value) AS field(name)
           WHERE field.name NOT IN ('order', 'labels')
         ) THEN
        RAISE EXCEPTION 'Invalid navigation preferences shape.';
      END IF;
      IF jsonb_array_length(p_value->'order') > 32
         OR (SELECT count(*) FROM jsonb_object_keys(p_value->'labels')) > 32
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(p_value->'order') AS tab(value)
           WHERE jsonb_typeof(tab.value) IS DISTINCT FROM 'string'
              OR (tab.value #>> '{}') <> ALL (v_tab_ids)
         )
         OR EXISTS (
           SELECT 1 FROM jsonb_each(p_value->'labels') AS label(key, value)
           WHERE label.key <> ALL (v_tab_ids)
              OR jsonb_typeof(label.value) IS DISTINCT FROM 'string'
              OR char_length(label.value #>> '{}') NOT BETWEEN 1 AND 12
              OR nullif(btrim(label.value #>> '{}'), '') IS NULL
         ) THEN
        RAISE EXCEPTION 'Invalid navigation preferences value.';
      END IF;
    WHEN 'announcement_carousel_enabled' THEN
      IF jsonb_typeof(p_value) IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'Carousel enabled must be a boolean.';
      END IF;
    WHEN 'announcement_carousel_speed' THEN
      IF jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN
        RAISE EXCEPTION 'Carousel speed must be a number from 0.1 to 5.';
      END IF;
      IF (p_value::text)::numeric NOT BETWEEN 0.1 AND 5 THEN
        RAISE EXCEPTION 'Carousel speed must be a number from 0.1 to 5.';
      END IF;
    WHEN 'login_title', 'login_subtitle' THEN
      IF jsonb_typeof(p_value) IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Login text must be a string.';
      END IF;
      IF nullif(btrim(p_value #>> '{}'), '') IS NULL
         OR char_length(p_value #>> '{}') > (CASE p_key WHEN 'login_title' THEN 100 ELSE 200 END) THEN
        RAISE EXCEPTION 'Login text must not be empty or exceed its length limit.';
      END IF;
  END CASE;

  INSERT INTO public.system_configs (key, value, description)
  VALUES (
    p_key,
    p_value,
    CASE p_key
      WHEN 'admin_navigation_preferences' THEN 'Administrator navigation display preferences'
      WHEN 'announcement_carousel_enabled' THEN 'Enable or disable automatic scrolling of announcements on employee dashboard'
      WHEN 'announcement_carousel_speed' THEN 'Speed of announcement auto-scroll (0.1 = very slow, 5.0 = very fast)'
      WHEN 'login_title' THEN 'Main title displayed on the login page'
      WHEN 'login_subtitle' THEN 'Subtitle text displayed below the main title on login page'
    END
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = now();
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_save_shared_system_config(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_save_shared_system_config(uuid, text, jsonb) TO anon, authenticated;
