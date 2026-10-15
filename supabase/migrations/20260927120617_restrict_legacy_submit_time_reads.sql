REVOKE SELECT ON TABLE public.submit_time_groups, public.employee_submit_time_settings
  FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS "Read legacy submit time groups" ON public.submit_time_groups;
DROP POLICY IF EXISTS "Read legacy employee submit time settings" ON public.employee_submit_time_settings;
