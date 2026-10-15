CREATE INDEX idx_conversations_customer_source
  ON public.customer_employee_conversations(customer_id, source_type);
