CREATE OR REPLACE FUNCTION public.admin_manage_dispatch_orders(
  p_admin_session_token uuid, p_pool_id uuid, p_action text,
  p_order_id uuid DEFAULT NULL, p_content text DEFAULT NULL, p_contents text[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_count integer := 0;
  v_order public.dispatch_group_orders%ROWTYPE;
BEGIN
  SELECT admin_id, admin_role INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_admin_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can manage dispatch orders.';
  END IF;
  IF p_pool_id IS NULL OR p_action IS NULL OR p_action NOT IN (
    'import', 'edit', 'toggle', 'delete_permanent', 'delete_all_permanent'
  ) THEN
    RAISE EXCEPTION 'Invalid dispatch order action or pool.';
  END IF;
  -- Match assignment creation's group-before-pool lock order without blocking submissions.
  PERFORM 1 FROM public.dispatch_groups AS dispatch_group
  WHERE dispatch_group.id = (
    SELECT pool.group_id FROM public.dispatch_order_pools AS pool WHERE pool.id = p_pool_id
  ) AND dispatch_group.archived_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispatch pool not found or archived.';
  END IF;
  PERFORM 1 FROM public.dispatch_order_pools AS pool
  WHERE pool.id = p_pool_id AND pool.archived_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispatch pool not found or archived.';
  END IF;

  IF p_action = 'import' THEN
    IF p_order_id IS NOT NULL OR p_content IS NOT NULL OR p_contents IS NULL
       OR COALESCE(cardinality(p_contents), 0) NOT BETWEEN 1 AND 2000
       OR EXISTS (SELECT 1 FROM unnest(p_contents) AS item(value)
                  WHERE nullif(btrim(item.value), '') IS NULL) THEN
      RAISE EXCEPTION 'Import requires between 1 and 2000 nonempty contents.';
    END IF;
    INSERT INTO public.dispatch_group_orders (group_id, pool_id, order_content, created_by)
    SELECT pool.group_id, p_pool_id, btrim(item.value), v_admin_id
    FROM public.dispatch_order_pools AS pool
    CROSS JOIN unnest(p_contents) AS item(value)
    WHERE pool.id = p_pool_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSIF p_action IN ('delete_permanent', 'delete_all_permanent') THEN
    IF p_action = 'delete_all_permanent' THEN
      IF p_order_id IS NOT NULL OR p_content IS NOT NULL OR p_contents IS NOT NULL THEN
        RAISE EXCEPTION 'Delete all does not take order contents or an order ID.';
      END IF;
    ELSE
      IF p_order_id IS NULL OR p_content IS NOT NULL OR p_contents IS NOT NULL THEN
        RAISE EXCEPTION 'Invalid order parameters for this action.';
      END IF;
      SELECT * INTO v_order FROM public.dispatch_group_orders
      WHERE id = p_order_id AND pool_id = p_pool_id AND archived_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Dispatch order not found in this pool.';
      END IF;
    END IF;

    UPDATE public.dispatch_assignments AS assignment
    SET order_content_snapshot = COALESCE(assignment.order_content_snapshot, dispatch_order.order_content),
        group_id = COALESCE(assignment.group_id, dispatch_order.group_id),
        pool_id = COALESCE(assignment.pool_id, dispatch_order.pool_id)
    FROM public.dispatch_group_orders AS dispatch_order
    WHERE assignment.dispatch_order_id = dispatch_order.id
      AND dispatch_order.pool_id = p_pool_id
      AND (p_action = 'delete_all_permanent' OR dispatch_order.id = p_order_id)
      AND (assignment.order_content_snapshot IS NULL OR assignment.group_id IS NULL
        OR assignment.pool_id IS NULL);

    IF p_action = 'delete_all_permanent' THEN
      DELETE FROM public.dispatch_group_orders WHERE pool_id = p_pool_id;
    ELSE
      DELETE FROM public.dispatch_group_orders WHERE id = p_order_id AND pool_id = p_pool_id;
    END IF;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  ELSE
    IF p_order_id IS NULL OR p_contents IS NOT NULL
       OR (p_action = 'edit' AND nullif(btrim(p_content), '') IS NULL)
       OR (p_action <> 'edit' AND p_content IS NOT NULL) THEN
      RAISE EXCEPTION 'Invalid order parameters for this action.';
    END IF;
    SELECT * INTO v_order FROM public.dispatch_group_orders
    WHERE id = p_order_id AND pool_id = p_pool_id AND archived_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Dispatch order not found in this pool.';
    END IF;
    UPDATE public.dispatch_group_orders
    SET order_content = CASE WHEN p_action = 'edit' THEN btrim(p_content)
                             ELSE order_content END,
        is_active = CASE WHEN p_action = 'toggle' THEN NOT is_active ELSE is_active END,
        updated_at = clock_timestamp()
    WHERE id = p_order_id AND pool_id = p_pool_id
    RETURNING * INTO v_order;
    v_count := 1;
  END IF;
  RETURN jsonb_build_object('success', true, 'action', p_action, 'affected', v_count,
                            'order', CASE WHEN p_action IN ('edit', 'toggle', 'delete_permanent')
                                          THEN to_jsonb(v_order) ELSE NULL END);
END;
$function$;

REVOKE ALL ON FUNCTION public.admin_manage_dispatch_orders(uuid, uuid, text, uuid, text, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_manage_dispatch_orders(uuid, uuid, text, uuid, text, text[])
  TO anon, authenticated;
