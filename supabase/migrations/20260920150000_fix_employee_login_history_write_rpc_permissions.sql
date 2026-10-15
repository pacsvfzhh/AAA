-- Login history writes go through controlled RPCs; clients do not need direct table access.
-- SECURITY INVOKER cannot INSERT after employee_login_history table privileges are revoked.

ALTER FUNCTION public.log_employee_login(uuid, text, text, text, text, text)
  SECURITY DEFINER;

ALTER FUNCTION public.log_employee_logout(uuid, text, text, text, text, text)
  SECURITY DEFINER;

ALTER FUNCTION public.log_employee_login_with_device_info(uuid, text, text, text, text, text, jsonb)
  SECURITY DEFINER;

ALTER FUNCTION public.log_employee_logout_with_device_info(uuid, text, text, text, text, text, jsonb)
  SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.log_employee_login(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_employee_logout(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_employee_login_with_device_info(uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.log_employee_logout_with_device_info(uuid, text, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.log_employee_login(uuid, text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_employee_logout(uuid, text, text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_employee_login_with_device_info(uuid, text, text, text, text, text, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_employee_logout_with_device_info(uuid, text, text, text, text, text, jsonb) TO anon, authenticated;
