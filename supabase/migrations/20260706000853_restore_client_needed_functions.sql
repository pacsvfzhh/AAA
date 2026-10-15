
-- Restore EXECUTE privileges for functions that ARE needed by the client:
-- 1. end_work_session_by_user: called via REST API from OrderDispatch component
-- 2. check_withdrawal_eligibility: used in RLS WITH CHECK clause on withdrawals table
--    (RLS evaluates in the calling role context, so anon needs EXECUTE)

GRANT EXECUTE ON FUNCTION public.end_work_session_by_user(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_withdrawal_eligibility(uuid) TO anon, authenticated;
