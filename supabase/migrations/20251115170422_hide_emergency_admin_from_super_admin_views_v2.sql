/*
  # Hide Emergency Admin from Super Admin Views
  
  ## Problem
  The emergency_admin account is showing up in super admin's management pages:
  - Customer Service Management
  - Messages
  - Dispatch Records
  - Wallets
  - Login History
  
  ## Solution
  Update all functions that return admin lists or employee lists to filter out:
  - Admins with role = 'emergency_admin'
  - Employees created by emergency_admin
  
  ## Functions to Update
  1. get_admin_employees() - Used in employee management
  2. get_employees_by_admin() - Used in various views
  3. get_employee_login_summary() - Used in login history
  4. get_employee_login_history() - Used in login history details
  5. get_admin_customer_conversations() - Used in customer service
  
  ## Data Safety
  - Only affects display logic, no data deletion
  - emergency_admin can still access its own data
  - Super admin and secondary admins won't see emergency_admin
*/

-- ============================================
-- Drop existing functions to allow signature changes
-- ============================================

DROP FUNCTION IF EXISTS get_admin_employees(uuid);
DROP FUNCTION IF EXISTS get_employees_by_admin();
DROP FUNCTION IF EXISTS get_employee_login_summary(uuid, text);
DROP FUNCTION IF EXISTS get_employee_login_history(uuid, uuid, integer, integer);
DROP FUNCTION IF EXISTS get_admin_customer_conversations(uuid);

-- ============================================
-- 1. Recreate get_admin_employees()
-- ============================================

CREATE FUNCTION get_admin_employees(p_admin_id uuid)
RETURNS TABLE (
  id uuid,
  username text,
  employee_id text,
  is_active boolean,
  is_verified boolean,
  wallet_balance numeric,
  total_orders bigint,
  completed_orders bigint,
  failed_orders bigint,
  created_at timestamptz,
  tags text[],
  remarks text,
  is_pinned boolean,
  today_commission numeric,
  admin_username text,
  admin_role text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_role text;
BEGIN
  -- Get requesting admin's role
  SELECT role INTO v_admin_role FROM admins WHERE admins.id = p_admin_id;
  
  IF v_admin_role = 'super_admin' THEN
    -- Super admin: see all employees except those created by emergency_admin
    RETURN QUERY
    SELECT 
      u.id,
      u.username,
      u.employee_id,
      u.is_active,
      u.is_verified,
      COALESCE(w.balance, 0) as wallet_balance,
      COALESCE(o.total_orders, 0) as total_orders,
      COALESCE(o.completed_orders, 0) as completed_orders,
      COALESCE(o.failed_orders, 0) as failed_orders,
      u.created_at,
      u.tags,
      u.remarks,
      u.is_pinned,
      COALESCE(get_today_commission(u.id), 0) as today_commission,
      a.username as admin_username,
      a.role as admin_role
    FROM users u
    LEFT JOIN wallets w ON w.user_id = u.id
    LEFT JOIN admins a ON a.id = u.created_by
    LEFT JOIN LATERAL (
      SELECT 
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_orders,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_orders
      FROM orders
      WHERE orders.user_id = u.id
    ) o ON true
    WHERE u.created_by IS NOT NULL
      AND a.role != 'emergency_admin'  -- Exclude emergency_admin's employees
    ORDER BY u.is_pinned DESC NULLS LAST, u.created_at DESC;
    
  ELSE
    -- Secondary admin: see only their own employees
    RETURN QUERY
    SELECT 
      u.id,
      u.username,
      u.employee_id,
      u.is_active,
      u.is_verified,
      COALESCE(w.balance, 0) as wallet_balance,
      COALESCE(o.total_orders, 0) as total_orders,
      COALESCE(o.completed_orders, 0) as completed_orders,
      COALESCE(o.failed_orders, 0) as failed_orders,
      u.created_at,
      u.tags,
      u.remarks,
      u.is_pinned,
      COALESCE(get_today_commission(u.id), 0) as today_commission,
      a.username as admin_username,
      a.role as admin_role
    FROM users u
    LEFT JOIN wallets w ON w.user_id = u.id
    LEFT JOIN admins a ON a.id = u.created_by
    LEFT JOIN LATERAL (
      SELECT 
        COUNT(*) as total_orders,
        COUNT(*) FILTER (WHERE status = 'completed') as completed_orders,
        COUNT(*) FILTER (WHERE status = 'failed') as failed_orders
      FROM orders
      WHERE orders.user_id = u.id
    ) o ON true
    WHERE u.created_by = p_admin_id
    ORDER BY u.is_pinned DESC NULLS LAST, u.created_at DESC;
  END IF;
END;
$$;

-- ============================================
-- 2. Recreate get_employees_by_admin()
-- ============================================

CREATE FUNCTION get_employees_by_admin()
RETURNS TABLE (
  admin_id uuid,
  admin_username text,
  admin_role text,
  employee_id uuid,
  employee_username text,
  employee_employee_id text,
  is_active boolean,
  wallet_balance numeric,
  total_orders bigint,
  completed_orders bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    a.id as admin_id,
    a.username as admin_username,
    a.role as admin_role,
    u.id as employee_id,
    u.username as employee_username,
    u.employee_id as employee_employee_id,
    u.is_active,
    COALESCE(w.balance, 0) as wallet_balance,
    COUNT(o.id) as total_orders,
    COUNT(o.id) FILTER (WHERE o.status = 'completed') as completed_orders
  FROM admins a
  LEFT JOIN users u ON u.created_by = a.id
  LEFT JOIN wallets w ON w.user_id = u.id
  LEFT JOIN orders o ON o.user_id = u.id
  WHERE a.role != 'emergency_admin'  -- Exclude emergency_admin
    AND (u.id IS NOT NULL OR a.role = 'super_admin')
  GROUP BY a.id, a.username, a.role, u.id, u.username, u.employee_id, u.is_active, w.balance
  ORDER BY a.role DESC, a.username, u.username;
END;
$$;

-- ============================================
-- 3. Recreate get_employee_login_summary()
-- ============================================

CREATE FUNCTION get_employee_login_summary(
  p_admin_id uuid,
  p_search_term text DEFAULT NULL
)
RETURNS TABLE (
  user_id uuid,
  username text,
  employee_id text,
  is_active boolean,
  last_login_time timestamptz,
  last_login_ip text,
  login_count bigint,
  created_by_admin text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_role text;
BEGIN
  -- Get requesting admin's role
  SELECT a.role INTO v_admin_role 
  FROM admins a 
  WHERE a.id = p_admin_id;

  IF v_admin_role = 'super_admin' THEN
    -- Super admin sees all employees except emergency_admin's
    RETURN QUERY
    SELECT 
      u.id as user_id,
      u.username,
      u.employee_id,
      u.is_active,
      elh.last_login_time,
      elh.last_login_ip,
      COALESCE(elh.login_count, 0) as login_count,
      a.username as created_by_admin
    FROM users u
    LEFT JOIN admins a ON a.id = u.created_by
    LEFT JOIN LATERAL (
      SELECT 
        MAX(login_time) as last_login_time,
        (SELECT ip_address FROM employee_login_history 
         WHERE employee_login_history.user_id = u.id 
         ORDER BY login_time DESC LIMIT 1) as last_login_ip,
        COUNT(*) as login_count
      FROM employee_login_history
      WHERE employee_login_history.user_id = u.id
    ) elh ON true
    WHERE (p_search_term IS NULL 
           OR u.username ILIKE '%' || p_search_term || '%'
           OR u.employee_id ILIKE '%' || p_search_term || '%')
      AND a.role != 'emergency_admin'  -- Exclude emergency_admin's employees
    ORDER BY u.username;
  ELSE
    -- Secondary admin sees only their employees
    RETURN QUERY
    SELECT 
      u.id as user_id,
      u.username,
      u.employee_id,
      u.is_active,
      elh.last_login_time,
      elh.last_login_ip,
      COALESCE(elh.login_count, 0) as login_count,
      a.username as created_by_admin
    FROM users u
    LEFT JOIN admins a ON a.id = u.created_by
    LEFT JOIN LATERAL (
      SELECT 
        MAX(login_time) as last_login_time,
        (SELECT ip_address FROM employee_login_history 
         WHERE employee_login_history.user_id = u.id 
         ORDER BY login_time DESC LIMIT 1) as last_login_ip,
        COUNT(*) as login_count
      FROM employee_login_history
      WHERE employee_login_history.user_id = u.id
    ) elh ON true
    WHERE u.created_by = p_admin_id
      AND (p_search_term IS NULL 
           OR u.username ILIKE '%' || p_search_term || '%'
           OR u.employee_id ILIKE '%' || p_search_term || '%')
    ORDER BY u.username;
  END IF;
END;
$$;

-- ============================================
-- 4. Recreate get_employee_login_history()
-- ============================================

CREATE FUNCTION get_employee_login_history(
  p_admin_id uuid,
  p_user_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  username text,
  employee_id text,
  login_time timestamptz,
  ip_address text,
  user_agent text,
  status text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_role text;
  v_user_created_by uuid;
BEGIN
  -- Get admin role
  SELECT a.role INTO v_admin_role 
  FROM admins a 
  WHERE a.id = p_admin_id;

  -- Get user's creator
  SELECT u.created_by INTO v_user_created_by
  FROM users u
  WHERE u.id = p_user_id;

  -- Check permission
  IF v_admin_role != 'super_admin' AND v_user_created_by != p_admin_id THEN
    RAISE EXCEPTION 'Permission denied: You can only view login history of your own employees';
  END IF;

  -- Check if user belongs to emergency_admin (super admin can't access)
  IF v_admin_role = 'super_admin' THEN
    IF EXISTS (
      SELECT 1 FROM users u
      JOIN admins a ON a.id = u.created_by
      WHERE u.id = p_user_id
        AND a.role = 'emergency_admin'
    ) THEN
      RAISE EXCEPTION 'Permission denied: Cannot access emergency admin data';
    END IF;
  END IF;

  -- Return login history
  RETURN QUERY
  SELECT 
    elh.id,
    elh.user_id,
    u.username,
    u.employee_id,
    elh.login_time,
    elh.ip_address,
    elh.user_agent,
    elh.status
  FROM employee_login_history elh
  JOIN users u ON u.id = elh.user_id
  WHERE elh.user_id = p_user_id
  ORDER BY elh.login_time DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ============================================
-- 5. Recreate get_admin_customer_conversations()
-- ============================================

CREATE FUNCTION get_admin_customer_conversations(p_admin_id uuid)
RETURNS TABLE (
  conversation_id uuid,
  customer_id uuid,
  customer_name text,
  employee_id uuid,
  employee_username text,
  last_message_time timestamptz,
  unread_count bigint,
  rating integer,
  admin_username text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_admin_role text;
BEGIN
  -- Get admin role
  SELECT role INTO v_admin_role FROM admins WHERE id = p_admin_id;

  IF v_admin_role = 'super_admin' THEN
    -- Super admin sees all conversations except emergency_admin's
    RETURN QUERY
    SELECT 
      cec.id as conversation_id,
      cec.customer_id,
      sc.customer_name,
      cec.employee_id,
      u.username as employee_username,
      cec.last_message_time,
      cec.unread_count,
      sr.rating,
      a.username as admin_username
    FROM customer_employee_conversations cec
    JOIN simulated_customers sc ON sc.id = cec.customer_id
    JOIN users u ON u.id = cec.employee_id
    LEFT JOIN admins a ON a.id = u.created_by
    LEFT JOIN service_ratings sr ON sr.conversation_id = cec.id
    WHERE a.role != 'emergency_admin'  -- Exclude emergency_admin's employees
    ORDER BY cec.last_message_time DESC;
  ELSE
    -- Secondary admin sees only their employees' conversations
    RETURN QUERY
    SELECT 
      cec.id as conversation_id,
      cec.customer_id,
      sc.customer_name,
      cec.employee_id,
      u.username as employee_username,
      cec.last_message_time,
      cec.unread_count,
      sr.rating,
      a.username as admin_username
    FROM customer_employee_conversations cec
    JOIN simulated_customers sc ON sc.id = cec.customer_id
    JOIN users u ON u.id = cec.employee_id
    LEFT JOIN admins a ON a.id = u.created_by
    LEFT JOIN service_ratings sr ON sr.conversation_id = cec.id
    WHERE u.created_by = p_admin_id
    ORDER BY cec.last_message_time DESC;
  END IF;
END;
$$;

-- ============================================
-- 6. Add comments for documentation
-- ============================================

COMMENT ON FUNCTION get_admin_employees(uuid) IS
  'Returns employee list with filtering:
  - Super admin: All employees except those created by emergency_admin
  - Secondary admin: Only their own employees
  Updated to hide emergency_admin from super admin views.';

COMMENT ON FUNCTION get_employees_by_admin() IS
  'Returns employees grouped by admin, excluding emergency_admin and their employees.';

COMMENT ON FUNCTION get_employee_login_summary(uuid, text) IS
  'Returns employee login summary with filtering:
  - Super admin: All employees except emergency_admin''s
  - Secondary admin: Only their own employees';

COMMENT ON FUNCTION get_employee_login_history(uuid, uuid, integer, integer) IS
  'Returns employee login history with permission checks.
  Blocks access to emergency_admin employee data.';

COMMENT ON FUNCTION get_admin_customer_conversations(uuid) IS
  'Returns customer service conversations with filtering:
  - Super admin: All conversations except emergency_admin''s employees
  - Secondary admin: Only their employees'' conversations';

-- ============================================
-- 7. Verification
-- ============================================

DO $$
BEGIN
  RAISE NOTICE '✅ All functions updated to hide emergency_admin';
  RAISE NOTICE '';
  RAISE NOTICE 'Updated functions:';
  RAISE NOTICE '  1. get_admin_employees() - Employee Management';
  RAISE NOTICE '  2. get_employees_by_admin() - Various views';
  RAISE NOTICE '  3. get_employee_login_summary() - Login History';
  RAISE NOTICE '  4. get_employee_login_history() - Login Details';
  RAISE NOTICE '  5. get_admin_customer_conversations() - Customer Service';
  RAISE NOTICE '';
  RAISE NOTICE 'Filtering rules:';
  RAISE NOTICE '  ✅ Super admin: See all except emergency_admin''s data';
  RAISE NOTICE '  ✅ Secondary admin: See only their own data';
  RAISE NOTICE '  ✅ Emergency admin: Can still access their own data';
END $$;
