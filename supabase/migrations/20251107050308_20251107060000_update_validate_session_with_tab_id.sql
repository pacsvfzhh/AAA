/*
  # Update Session Validation to Support Tab ID

  1. Changes
    - Update validate_employee_session function to accept optional tab_id parameter
    - Check both session_token and tab_id for validation
    - Maintain backward compatibility with existing code

  2. Notes
    - Uses existing current_session_token field (UUID type)
    - Uses existing current_tab_id field (text type)
    - If tab_id is provided, both session_token and tab_id must match
*/

-- Drop and recreate the function with tab_id support
CREATE OR REPLACE FUNCTION public.validate_employee_session(
  p_user_id uuid, 
  p_session_token uuid,
  p_tab_id text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_valid boolean;
BEGIN
  -- If tab_id is provided, check both session_token and tab_id
  IF p_tab_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM users
      WHERE id = p_user_id
        AND current_session_token = p_session_token
        AND current_tab_id = p_tab_id
        AND is_active = true
        AND session_created_at > now() - interval '24 hours'
    ) INTO v_valid;
  ELSE
    -- If tab_id is not provided, only check session_token (backward compatible)
    SELECT EXISTS (
      SELECT 1
      FROM users
      WHERE id = p_user_id
        AND current_session_token = p_session_token
        AND is_active = true
        AND session_created_at > now() - interval '24 hours'
    ) INTO v_valid;
  END IF;

  RETURN v_valid;
END;
$$;