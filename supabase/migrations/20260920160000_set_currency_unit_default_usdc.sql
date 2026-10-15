-- Use USDC when no currency has been configured.
INSERT INTO public.admin_configs (admin_id, config_type, config_value)
VALUES (NULL, 'currency_unit', 'USDC')
ON CONFLICT (admin_id, config_type) WHERE admin_id IS NULL DO NOTHING;

UPDATE public.admin_configs
SET config_value = 'USDC'
WHERE admin_id IS NULL
  AND config_type = 'currency_unit'
  AND lower(trim(config_value)) = 'usdt';

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
    'USDC'
  );
$$;
