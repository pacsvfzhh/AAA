BEGIN;
SET LOCAL search_path = pg_catalog, public, private, pg_temp;

-- Explicit owner-only recovery for a lost export begin response. It can end only
-- the caller's own running export of an implemented protocol; it never touches
-- import tasks, maintenance state, sealed backups or business data. The job token
-- is neither required nor returned. Password re-verification reuses the existing
-- admin credential check and its lockout bookkeeping.
CREATE FUNCTION public.employee_export_stop_owned(
  p_admin_session_token uuid, p_admin_password text, p_job_id uuid, p_confirmation text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp SET lock_timeout = '2s' AS $$
DECLARE
  v_admin uuid; v_username text; v_check jsonb;
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_protocols constant text[] := ARRAY['shared-settings-v1', 'products-v1', 'dispatch-submission-v1',
    'employee-identity-v1', 'employee-finance-v1', 'employee-activity-v1', 'employee-verification-v1',
    'site-notifications-v1', 'site-chat-v1', 'site-archives-v1'];
BEGIN
  SELECT admin.admin_id, admin.admin_username INTO v_admin, v_username
  FROM private.employee_transfer_admin(p_admin_session_token) AS admin;
  IF p_confirmation IS DISTINCT FROM '確認停止導出任務' THEN
    RAISE EXCEPTION 'The stop confirmation text is incorrect.';
  END IF;
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'Employee export task cannot be stopped.';
  END IF;

  v_check := private.employee_transfer_verify_password(v_admin, v_username, p_admin_password);
  IF NOT COALESCE((v_check ->> 'success')::boolean, false) THEN
    RETURN v_check;
  END IF;

  SELECT job.* INTO v_job FROM private.employee_transfer_jobs AS job
  WHERE job.id = p_job_id AND job.admin_id = v_admin AND job.kind = 'export'
    AND job.options->>'export_protocol' = ANY (v_protocols)
  FOR UPDATE;
  IF v_job.id IS NULL THEN
    RAISE EXCEPTION 'Employee export task cannot be stopped.';
  END IF;

  IF v_job.status <> 'running' OR v_job.last_activity_at <= now() - interval '3 hours'
     OR v_job.started_at <= now() - interval '12 hours' THEN
    RETURN jsonb_build_object('success', true, 'cancelled', false, 'job_id', v_job.id,
      'status', CASE WHEN v_job.status = 'running' THEN 'expired' ELSE v_job.status END,
      'scope', 'export-task', 'full_site_complete', false);
  END IF;

  PERFORM private.employee_transfer_end_job(v_job, 'cancelled', jsonb_build_object(
    'scope', 'export-task', 'stopped_by_owner', true,
    'export_protocol', v_job.options->>'export_protocol', 'full_site_complete', false));
  RETURN jsonb_build_object('success', true, 'cancelled', true, 'job_id', v_job.id,
    'scope', 'export-task', 'full_site_complete', false);
END;
$$;

REVOKE ALL ON FUNCTION public.employee_export_stop_owned(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_export_stop_owned(uuid, text, uuid, text) TO anon, authenticated;

COMMIT;
