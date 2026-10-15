ALTER TABLE public.product_types
ADD COLUMN IF NOT EXISTS sort_order integer;

WITH ranked_product_types AS (
  SELECT
    id,
    row_number() OVER (ORDER BY lower(name), name, id)::integer AS next_sort_order
  FROM public.product_types
)
UPDATE public.product_types AS product_type
SET sort_order = ranked.next_sort_order
FROM ranked_product_types AS ranked
WHERE product_type.id = ranked.id
  AND product_type.sort_order IS NULL;

ALTER TABLE public.product_types
ALTER COLUMN sort_order SET DEFAULT 0,
ALTER COLUMN sort_order SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_product_types_sort_order_id
ON public.product_types (sort_order, id);

CREATE OR REPLACE FUNCTION private.assign_product_type_sort_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  IF NEW.sort_order <= 0 THEN
    PERFORM pg_advisory_xact_lock(hashtext('public.product_types.sort_order'));

    SELECT COALESCE(MAX(product_type.sort_order), 0) + 1
    INTO NEW.sort_order
    FROM public.product_types AS product_type;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS assign_product_type_sort_order ON public.product_types;
CREATE TRIGGER assign_product_type_sort_order
BEFORE INSERT ON public.product_types
FOR EACH ROW
EXECUTE FUNCTION private.assign_product_type_sort_order();

CREATE OR REPLACE FUNCTION public.reorder_product_types(
  p_admin_session_token uuid,
  p_product_type_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_product_count integer;
  v_input_count integer;
  v_unique_count integer;
  v_matching_count integer;
BEGIN
  SELECT admin_id, admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);

  IF v_admin_role <> 'super_admin' THEN
    RAISE EXCEPTION 'Only super administrators can reorder product types.';
  END IF;

  LOCK TABLE public.product_types IN SHARE ROW EXCLUSIVE MODE;

  SELECT COUNT(*)::integer
  INTO v_product_count
  FROM public.product_types;

  v_input_count := COALESCE(cardinality(p_product_type_ids), 0);

  SELECT COUNT(DISTINCT product_type_id)::integer
  INTO v_unique_count
  FROM unnest(COALESCE(p_product_type_ids, ARRAY[]::uuid[])) AS product_type_id;

  SELECT COUNT(*)::integer
  INTO v_matching_count
  FROM public.product_types AS product_type
  WHERE product_type.id = ANY(COALESCE(p_product_type_ids, ARRAY[]::uuid[]));

  IF v_input_count <> v_product_count
    OR v_unique_count <> v_input_count
    OR v_matching_count <> v_product_count THEN
    RAISE EXCEPTION 'Product type order must contain every product type exactly once.';
  END IF;

  UPDATE public.product_types AS product_type
  SET
    sort_order = requested_order.sort_order,
    updated_at = now()
  FROM unnest(p_product_type_ids) WITH ORDINALITY AS requested_order(id, sort_order)
  WHERE product_type.id = requested_order.id;

  RETURN jsonb_build_object(
    'success', true,
    'updated_count', v_product_count,
    'admin_id', v_admin_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reorder_product_types(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reorder_product_types(uuid, uuid[]) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
