CREATE OR REPLACE FUNCTION public.get_ccc_conversation_annotations(
  p_admin_session_token uuid,
  p_owner_admin_id uuid
)
RETURNS TABLE (customer_id uuid, employee_id uuid, is_special boolean, note text)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  IF v_admin_role <> 'super_admin' AND p_owner_admin_id IS DISTINCT FROM v_admin_id THEN
    RAISE EXCEPTION 'Administrator group is not accessible.';
  END IF;

  RETURN QUERY
  SELECT annotation.customer_id, annotation.employee_id, annotation.is_special, annotation.note
  FROM public.ccc_conversation_annotations AS annotation
  JOIN public.simulated_customers AS customer ON customer.id = annotation.customer_id
  JOIN public.admins AS owner_admin ON owner_admin.id = customer.admin_id
  JOIN public.users AS employee ON employee.id = annotation.employee_id
  LEFT JOIN public.admins AS employee_admin ON employee_admin.id = employee.created_by
  WHERE annotation.owner_admin_id = p_owner_admin_id
    AND customer.admin_id = p_owner_admin_id
    AND customer.source_type = 'ccc_service'
    AND (
      (owner_admin.role = 'super_admin' AND employee.created_by IS NOT NULL AND employee_admin.role <> 'emergency_admin')
      OR (owner_admin.role <> 'super_admin' AND employee.created_by = p_owner_admin_id)
    )
    AND EXISTS (
      SELECT 1 FROM public.customer_employee_conversations AS message
      WHERE message.customer_id = annotation.customer_id
        AND message.employee_id = annotation.employee_id
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.update_ccc_conversation_annotation(
  p_admin_session_token uuid,
  p_customer_id uuid,
  p_employee_id uuid,
  p_is_special boolean,
  p_note text,
  p_update_note boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
AS $$
DECLARE
  v_admin_id uuid;
  v_admin_role text;
  v_owner_admin_id uuid;
  v_is_special boolean;
  v_note text;
BEGIN
  SELECT context.admin_id, context.admin_role
  INTO v_admin_id, v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token) AS context;

  SELECT customer.admin_id INTO v_owner_admin_id
  FROM public.simulated_customers AS customer
  JOIN public.admins AS owner_admin ON owner_admin.id = customer.admin_id
  JOIN public.users AS employee ON employee.id = p_employee_id
  LEFT JOIN public.admins AS employee_admin ON employee_admin.id = employee.created_by
  WHERE customer.id = p_customer_id
    AND customer.source_type = 'ccc_service'
    AND (v_admin_role = 'super_admin' OR customer.admin_id = v_admin_id)
    AND (
      (owner_admin.role = 'super_admin' AND employee.created_by IS NOT NULL AND employee_admin.role <> 'emergency_admin')
      OR (owner_admin.role <> 'super_admin' AND employee.created_by = customer.admin_id)
    )
    AND EXISTS (
      SELECT 1 FROM public.customer_employee_conversations AS message
      WHERE message.customer_id = customer.id
        AND message.employee_id = employee.id
    );

  IF v_owner_admin_id IS NULL THEN
    RAISE EXCEPTION 'Manager conversation was not found or cannot be edited.';
  END IF;

  IF p_is_special IS NULL AND NOT p_update_note THEN
    RAISE EXCEPTION 'No annotation change was provided.';
  END IF;

  v_note := nullif(btrim(p_note), '');
  IF p_update_note AND length(v_note) > 2000 THEN
    RAISE EXCEPTION 'Conversation note is too long.';
  END IF;

  INSERT INTO public.ccc_conversation_annotations AS annotation
    (customer_id, employee_id, owner_admin_id, is_special, note, updated_by)
  VALUES
    (p_customer_id, p_employee_id, v_owner_admin_id, COALESCE(p_is_special, false),
     CASE WHEN p_update_note THEN v_note ELSE NULL END, v_admin_id)
  ON CONFLICT (customer_id, employee_id) DO UPDATE
  SET owner_admin_id = EXCLUDED.owner_admin_id,
      is_special = COALESCE(p_is_special, annotation.is_special),
      note = CASE WHEN p_update_note THEN EXCLUDED.note ELSE annotation.note END,
      updated_by = EXCLUDED.updated_by,
      updated_at = now()
  RETURNING annotation.is_special, annotation.note INTO v_is_special, v_note;

  RETURN jsonb_build_object('customer_id', p_customer_id, 'employee_id', p_employee_id,
                            'is_special', v_is_special, 'note', v_note);
END;
$$;

NOTIFY pgrst, 'reload schema';
