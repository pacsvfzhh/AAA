CREATE OR REPLACE FUNCTION private.resolve_admin_currency(p_admin_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT COALESCE(
    (
      SELECT NULLIF(trim(currency.config_value), '')
      FROM public.admin_configs currency
      WHERE currency.config_type = 'currency_unit'
        AND currency.admin_id = p_admin_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.admin_configs mode
          WHERE mode.admin_id = p_admin_id
            AND mode.config_type = 'branding_mode'
            AND mode.config_value = 'global'
        )
      LIMIT 1
    ),
    (
      SELECT NULLIF(trim(currency.config_value), '')
      FROM public.admin_configs currency
      WHERE currency.config_type = 'currency_unit'
        AND currency.admin_id IS NULL
      ORDER BY currency.updated_at DESC NULLS LAST
      LIMIT 1
    ),
    'USDC'
  );
$$;
