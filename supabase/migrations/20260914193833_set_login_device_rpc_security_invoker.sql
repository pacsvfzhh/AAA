ALTER FUNCTION public.log_employee_login_with_device_info(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb
) SECURITY INVOKER;

ALTER FUNCTION public.log_employee_logout_with_device_info(
  uuid,
  text,
  text,
  text,
  text,
  text,
  jsonb
) SECURITY INVOKER;
