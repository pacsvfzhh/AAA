
-- Fix: After converting functions to SECURITY INVOKER, internal sub-functions
-- also need EXECUTE grants because the calling role (anon/authenticated) must
-- have permission on every function in the call chain.

-- Called internally by cleanup_all_stale_sessions():
GRANT EXECUTE ON FUNCTION public.cleanup_stale_work_sessions_optimized() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_dispatch_sessions() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_inactive_sessions() TO anon, authenticated;

-- Called internally by get_admin_employees(uuid):
GRANT EXECUTE ON FUNCTION public.get_today_commission(uuid) TO anon, authenticated;

-- Used by dispatch records batch queries (get_today_commission_by_user):
GRANT EXECUTE ON FUNCTION public.get_today_commission_by_user(uuid[]) TO anon, authenticated;

-- Customer service internal functions called by the customer service management page:
GRANT EXECUTE ON FUNCTION public.get_admin_customer_conversations(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_unread_customer_messages_count(uuid) TO anon, authenticated;

-- Message system functions:
GRANT EXECUTE ON FUNCTION public.mark_login_popup_as_shown(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_message_as_read(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_unread_message_count(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_broadcast_message(uuid, text, text, text, text, uuid, uuid[]) TO anon, authenticated;

-- Employee heartbeat (called from dispatch):
GRANT EXECUTE ON FUNCTION public.update_employee_heartbeat(uuid, uuid) TO anon, authenticated;
