/*
  # Create Batch Work Status Function

  1. New Functions
    - `get_batch_work_status` - Returns the current work status for multiple users in one query
      - Accepts an array of user IDs
      - Returns user_id and work_status ('online', 'offline', 'never_started') for each user
      - Checks the most recent dispatch_session per user
      - A user is 'online' if their latest session has status='online' and ended_at IS NULL
      - A user is 'offline' if they have any session but it's ended or not online
      - A user is 'never_started' if they have no dispatch sessions at all

  2. Security
    - SECURITY INVOKER so it respects the caller's permissions
    - Granted EXECUTE to anon and authenticated roles

  3. Notes
    - Replaces client-side logic that downloaded up to 10,000 dispatch_session rows
    - Returns at most one row per user, dramatically reducing data transfer
*/

CREATE OR REPLACE FUNCTION get_batch_work_status(p_user_ids uuid[])
RETURNS TABLE(
  user_id uuid,
  work_status text
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH latest_session AS (
    SELECT DISTINCT ON (ds.user_id)
      ds.user_id,
      ds.status,
      ds.ended_at
    FROM dispatch_sessions ds
    WHERE ds.user_id = ANY(p_user_ids)
    ORDER BY ds.user_id, ds.started_at DESC
  )
  SELECT
    u.id AS user_id,
    CASE
      WHEN ls.user_id IS NULL THEN 'never_started'
      WHEN ls.status = 'online' AND ls.ended_at IS NULL THEN 'online'
      ELSE 'offline'
    END AS work_status
  FROM unnest(p_user_ids) AS u(id)
  LEFT JOIN latest_session ls ON ls.user_id = u.id;
$$;

GRANT EXECUTE ON FUNCTION get_batch_work_status(uuid[]) TO anon, authenticated;
