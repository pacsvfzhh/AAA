
-- Grant EXECUTE on assign_next_dispatch_order which is called from the
-- employee OrderDispatch page. This was missed when converting to SECURITY INVOKER.
GRANT EXECUTE ON FUNCTION public.assign_next_dispatch_order(uuid, uuid, text) TO anon, authenticated;

-- Also grant the fairness/rate-limit variants since assign_next_dispatch_order
-- may be swapped with these in admin config:
GRANT EXECUTE ON FUNCTION public.assign_with_fairness(uuid, uuid, text, boolean) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_with_rate_limit(uuid, uuid, text, integer) TO anon, authenticated;
