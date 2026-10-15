/*
  # Add Work Days Count Function

  1. New Functions
    - `get_user_work_days_count` - Calculate the number of distinct days a user has worked
      - Counts unique dates from work_sessions table
      - Used for withdrawal eligibility based on working days threshold

  2. Changes
    - This replaces the old logic that relied on first_success_order_date
    - New logic: withdrawal requires N distinct working days (days with work sessions)
*/

-- Function to count the number of distinct days a user has worked
CREATE OR REPLACE FUNCTION get_user_work_days_count(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_work_days_count integer;
BEGIN
  -- Count distinct dates (UTC) where user has work sessions
  SELECT COUNT(DISTINCT DATE(start_time AT TIME ZONE 'UTC'))
  INTO v_work_days_count
  FROM work_sessions
  WHERE user_id = p_user_id;

  RETURN COALESCE(v_work_days_count, 0);
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION get_user_work_days_count(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_work_days_count(uuid) TO anon;
