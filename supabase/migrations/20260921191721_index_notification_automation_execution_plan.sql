CREATE INDEX IF NOT EXISTS notification_automation_executions_plan_fk_idx
  ON public.notification_automation_executions(plan_id)
  WHERE plan_id IS NOT NULL;
