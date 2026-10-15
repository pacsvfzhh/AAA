/*
  # Update get_admin_employees function to include remarks and tags
  
  1. Changes
    - Drop and recreate get_admin_employees function
    - Add remarks and tags columns to the return data
    - Maintains all existing functionality
  
  2. Purpose
    - Allow Customer Service interface to display employee remarks and tags
    - Improve employee identification and organization in chat interface
*/

-- Drop existing function
DROP FUNCTION IF EXISTS get_admin_employees(uuid);

-- Recreate with remarks and tags included
CREATE OR REPLACE FUNCTION get_admin_employees(p_admin_id uuid)
RETURNS TABLE (
  id uuid,
  username text,
  employee_id text,
  is_verified boolean,
  is_active boolean,
  remarks text,
  tags text[],
  created_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    u.id,
    u.username,
    u.employee_id,
    u.is_verified,
    u.is_active,
    u.remarks,
    u.tags,
    u.created_at
  FROM users u
  WHERE u.created_by = p_admin_id
  ORDER BY u.username;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;