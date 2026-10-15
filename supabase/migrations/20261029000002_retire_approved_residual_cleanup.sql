DO $completed_cleanup$
BEGIN
  IF EXISTS (SELECT 1 FROM private.content_audit_delete_jobs
    WHERE cardinality(target_ids) = 0 AND card_count = 0 AND finished_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Finish the approved residual media cleanup before retiring its preparation endpoint.';
  END IF;
END;
$completed_cleanup$;
DROP FUNCTION public.prepare_approved_content_residual_cleanup(uuid);
NOTIFY pgrst, 'reload schema';
