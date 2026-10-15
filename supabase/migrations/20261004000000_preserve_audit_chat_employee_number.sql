CREATE OR REPLACE FUNCTION private.content_audit_chat_snapshot(p_message public.customer_employee_conversations)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT jsonb_build_object(
    'message', to_jsonb(p_message),
    'rendered_html', CASE WHEN p_message.message_type = 'rich_card' THEN
      CASE WHEN p_message.content_frozen THEN COALESCE(card.html_content, p_message.message_content)
        ELSE COALESCE(template.content, auto_message.content, card.html_content, p_message.message_content) END
      ELSE NULL END,
    'customer_name', customer.customer_name,
    'custom_avatar_url', customer.custom_avatar_url,
    'employee_name', employee.username,
    'employee_number', employee.employee_id,
    'source', CASE WHEN p_message.content_frozen THEN to_jsonb(card)
      ELSE COALESCE(to_jsonb(template), to_jsonb(auto_message), to_jsonb(card)) END
  )
  FROM public.simulated_customers customer
  LEFT JOIN public.users employee ON employee.id = p_message.employee_id
  LEFT JOIN public.cs_message_templates template ON template.id = p_message.source_template_id
  LEFT JOIN public.customer_auto_messages auto_message ON auto_message.id = p_message.source_auto_message_id
  LEFT JOIN public.rich_card_contents card ON card.id = p_message.rich_card_content_id
  WHERE customer.id = p_message.customer_id;
$$;

REVOKE ALL ON FUNCTION private.content_audit_chat_snapshot(public.customer_employee_conversations)
  FROM PUBLIC, anon, authenticated;
