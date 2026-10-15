CREATE INDEX IF NOT EXISTS notification_automation_tasks_source_idx
  ON public.notification_automation_tasks(source_task_id)
  WHERE source_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_automation_task_recipients_user_idx
  ON public.notification_automation_task_recipients(user_id, task_id);

CREATE INDEX IF NOT EXISTS notification_automation_progress_user_idx
  ON public.notification_automation_progress(user_id, task_id);

CREATE INDEX IF NOT EXISTS notification_automation_executions_message_idx
  ON public.notification_automation_executions(message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_automation_executions_wallet_transaction_idx
  ON public.notification_automation_executions(wallet_transaction_id)
  WHERE wallet_transaction_id IS NOT NULL;
