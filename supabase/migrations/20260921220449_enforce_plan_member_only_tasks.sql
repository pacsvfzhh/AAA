UPDATE public.notification_automation_tasks
SET recipient_scope = 'selected',
    updated_at = clock_timestamp()
WHERE plan_id IS NOT NULL
  AND recipient_scope <> 'selected';

ALTER TABLE public.notification_automation_tasks
  DROP CONSTRAINT IF EXISTS notification_automation_plan_tasks_member_scope;
ALTER TABLE public.notification_automation_tasks
  ADD CONSTRAINT notification_automation_plan_tasks_member_scope
  CHECK (plan_id IS NULL OR recipient_scope = 'selected')
  NOT VALID;
ALTER TABLE public.notification_automation_tasks
  VALIDATE CONSTRAINT notification_automation_plan_tasks_member_scope;

CREATE OR REPLACE FUNCTION private.automation_task_applies_to_user(
  p_task public.notification_automation_tasks,
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admins AS owner
    JOIN public.users AS employee ON employee.id = p_user_id
    WHERE owner.id = p_task.owner_admin_id
      AND owner.is_active = true
      AND employee.is_active = true
      AND (
        (
          p_task.plan_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM public.notification_automation_plans AS plan
            WHERE plan.id = p_task.plan_id
              AND plan.owner_admin_id = p_task.owner_admin_id
              AND plan.status = 'active'
          )
          AND employee.created_by = p_task.owner_admin_id
          AND EXISTS (
            SELECT 1
            FROM public.notification_automation_plan_members AS member
            WHERE member.plan_id = p_task.plan_id
              AND member.user_id = employee.id
          )
        )
        OR (
          p_task.plan_id IS NULL
          AND (
            (
              p_task.recipient_scope = 'all_managed'
              AND (
                owner.role = 'super_admin'
                OR employee.created_by = owner.id
              )
            )
            OR (
              p_task.recipient_scope = 'selected'
              AND EXISTS (
                SELECT 1
                FROM public.notification_automation_task_recipients AS recipient
                WHERE recipient.task_id = p_task.id
                  AND recipient.user_id = employee.id
              )
            )
          )
        )
      )
  );
$$;
