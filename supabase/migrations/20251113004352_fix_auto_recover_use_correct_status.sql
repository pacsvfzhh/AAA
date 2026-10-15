/*
  # Fix Auto-Recovery Function Status

  1. Changes
    - Update auto_recover_stale_pending_orders to use 'timeout' instead of 'timeout_cancelled'
    - This matches the existing constraint: 'pending', 'accepted', 'completed', 'error', 'timeout', 'cancelled'
  
  2. Why
    - The dispatch_assignments table constraint uses 'timeout' not 'timeout_cancelled'
    - This was causing 500 errors in the cleanup-dispatch Edge Function
*/

CREATE OR REPLACE FUNCTION auto_recover_stale_pending_orders(
  p_timeout_minutes int DEFAULT 5
)
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_recovered_count int;
  v_recovered_ids uuid[];
  v_recovered_details jsonb;
BEGIN
  -- Find and update stale pending orders
  WITH stale_orders AS (
    SELECT 
      da.id,
      da.user_id,
      da.dispatch_order_id,
      da.assigned_at,
      EXTRACT(EPOCH FROM (now() - da.assigned_at))/60 as minutes_elapsed
    FROM dispatch_assignments da
    WHERE da.status = 'pending'
      AND da.assigned_at < now() - (p_timeout_minutes || ' minutes')::interval
  ),
  updated AS (
    UPDATE dispatch_assignments
    SET 
      status = 'timeout',  -- Changed from 'timeout_cancelled' to 'timeout'
      remarks = 'Auto-recovered: pending timeout after ' || p_timeout_minutes || ' minutes',
      completed_at = now()
    WHERE id IN (SELECT id FROM stale_orders)
    RETURNING id, user_id, dispatch_order_id
  )
  SELECT 
    COUNT(*),
    array_agg(id),
    jsonb_agg(
      jsonb_build_object(
        'assignment_id', id,
        'user_id', user_id,
        'dispatch_order_id', dispatch_order_id
      )
    )
  INTO v_recovered_count, v_recovered_ids, v_recovered_details
  FROM updated;

  -- Return result
  RETURN json_build_object(
    'recovered_count', COALESCE(v_recovered_count, 0),
    'recovered_ids', COALESCE(v_recovered_ids, ARRAY[]::uuid[]),
    'details', COALESCE(v_recovered_details, '[]'::jsonb),
    'timeout_minutes', p_timeout_minutes,
    'executed_at', now()
  );
END;
$$;
