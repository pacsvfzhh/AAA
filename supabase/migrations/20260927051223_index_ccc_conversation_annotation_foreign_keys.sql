CREATE INDEX ccc_conversation_annotations_employee_idx
  ON public.ccc_conversation_annotations (employee_id);

CREATE INDEX ccc_conversation_annotations_updated_by_idx
  ON public.ccc_conversation_annotations (updated_by);
