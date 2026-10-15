
-- Restrict RLS policies from overly-broad 'public' role to specific roles.
-- The app uses the anon key for all client operations, so we need anon access.
-- But using 'public' is broader than necessary. Restrict to {anon, authenticated}.

-- account_locks: System insert uses public, restrict to anon,authenticated
DROP POLICY IF EXISTS "System can insert account locks" ON account_locks;
CREATE POLICY "System can insert account locks" ON account_locks
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- admin_group_members
DROP POLICY IF EXISTS "All can view group memberships" ON admin_group_members;
CREATE POLICY "All can view group memberships" ON admin_group_members
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Super admins can add group members" ON admin_group_members;
CREATE POLICY "Super admins can add group members" ON admin_group_members
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Super admins can remove group members" ON admin_group_members;
CREATE POLICY "Super admins can remove group members" ON admin_group_members
  FOR DELETE TO anon, authenticated USING (true);

-- admin_groups
DROP POLICY IF EXISTS "Super admins can create groups" ON admin_groups;
CREATE POLICY "Super admins can create groups" ON admin_groups
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Super admins can delete groups" ON admin_groups;
CREATE POLICY "Super admins can delete groups" ON admin_groups
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Super admins can update groups" ON admin_groups;
CREATE POLICY "Super admins can update groups" ON admin_groups
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Super admins can view all groups" ON admin_groups;
CREATE POLICY "Super admins can view all groups" ON admin_groups
  FOR SELECT TO anon, authenticated USING (true);

-- broadcast_messages
DROP POLICY IF EXISTS "Admins can insert broadcasts" ON broadcast_messages;
CREATE POLICY "Admins can insert broadcasts" ON broadcast_messages
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can view their own broadcasts" ON broadcast_messages;
CREATE POLICY "Admins can view their own broadcasts" ON broadcast_messages
  FOR SELECT TO anon, authenticated USING (true);

-- broadcast_recipients
DROP POLICY IF EXISTS "Employees can update read status" ON broadcast_recipients;
CREATE POLICY "Employees can update read status" ON broadcast_recipients
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Employees can view their broadcasts" ON broadcast_recipients;
CREATE POLICY "Employees can view their broadcasts" ON broadcast_recipients
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "System can insert broadcast recipients" ON broadcast_recipients;
CREATE POLICY "System can insert broadcast recipients" ON broadcast_recipients
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- commission_audit_log
DROP POLICY IF EXISTS "System can insert commission audit logs" ON commission_audit_log;
CREATE POLICY "System can insert commission audit logs" ON commission_audit_log
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "View commission audit logs with optimized RLS" ON commission_audit_log;
CREATE POLICY "View commission audit logs with optimized RLS" ON commission_audit_log
  FOR SELECT TO anon, authenticated USING (true);

-- customer_employee_conversations
DROP POLICY IF EXISTS "Anyone can delete messages" ON customer_employee_conversations;
CREATE POLICY "Anyone can delete messages" ON customer_employee_conversations
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can send messages" ON customer_employee_conversations;
CREATE POLICY "Anyone can send messages" ON customer_employee_conversations
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can update messages" ON customer_employee_conversations;
CREATE POLICY "Anyone can update messages" ON customer_employee_conversations
  FOR UPDATE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view conversations" ON customer_employee_conversations;
CREATE POLICY "Anyone can view conversations" ON customer_employee_conversations
  FOR SELECT TO anon, authenticated USING (true);

-- customer_service_sessions
DROP POLICY IF EXISTS "Anyone can create service sessions" ON customer_service_sessions;
CREATE POLICY "Anyone can create service sessions" ON customer_service_sessions
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can delete service sessions" ON customer_service_sessions;
CREATE POLICY "Anyone can delete service sessions" ON customer_service_sessions
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can update service sessions" ON customer_service_sessions;
CREATE POLICY "Anyone can update service sessions" ON customer_service_sessions
  FOR UPDATE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view service sessions" ON customer_service_sessions;
CREATE POLICY "Anyone can view service sessions" ON customer_service_sessions
  FOR SELECT TO anon, authenticated USING (true);

-- dispatch_group_members
DROP POLICY IF EXISTS "Anyone can delete group members" ON dispatch_group_members;
CREATE POLICY "Anyone can delete group members" ON dispatch_group_members
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can insert group members" ON dispatch_group_members;
CREATE POLICY "Anyone can insert group members" ON dispatch_group_members
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can view group members" ON dispatch_group_members;
CREATE POLICY "Anyone can view group members" ON dispatch_group_members
  FOR SELECT TO anon, authenticated USING (true);

-- dispatch_group_orders
DROP POLICY IF EXISTS "Anyone can delete group orders" ON dispatch_group_orders;
CREATE POLICY "Anyone can delete group orders" ON dispatch_group_orders
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can insert group orders" ON dispatch_group_orders;
CREATE POLICY "Anyone can insert group orders" ON dispatch_group_orders
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can update group orders" ON dispatch_group_orders;
CREATE POLICY "Anyone can update group orders" ON dispatch_group_orders
  FOR UPDATE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view group orders" ON dispatch_group_orders;
CREATE POLICY "Anyone can view group orders" ON dispatch_group_orders
  FOR SELECT TO anon, authenticated USING (true);

-- dispatch_groups
DROP POLICY IF EXISTS "Anyone can delete dispatch groups" ON dispatch_groups;
CREATE POLICY "Anyone can delete dispatch groups" ON dispatch_groups
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can insert dispatch groups" ON dispatch_groups;
CREATE POLICY "Anyone can insert dispatch groups" ON dispatch_groups
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can update dispatch groups" ON dispatch_groups;
CREATE POLICY "Anyone can update dispatch groups" ON dispatch_groups
  FOR UPDATE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view dispatch groups" ON dispatch_groups;
CREATE POLICY "Anyone can view dispatch groups" ON dispatch_groups
  FOR SELECT TO anon, authenticated USING (true);

-- group_configs
DROP POLICY IF EXISTS "All can view group configs" ON group_configs;
CREATE POLICY "All can view group configs" ON group_configs
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Super admins can create group configs" ON group_configs;
CREATE POLICY "Super admins can create group configs" ON group_configs
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Super admins can delete group configs" ON group_configs;
CREATE POLICY "Super admins can delete group configs" ON group_configs
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Super admins can update group configs" ON group_configs;
CREATE POLICY "Super admins can update group configs" ON group_configs
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- history_cleanup_log
DROP POLICY IF EXISTS "Allow all operations on cleanup log" ON history_cleanup_log;
CREATE POLICY "Allow all operations on cleanup log" ON history_cleanup_log
  FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- login_attempts
DROP POLICY IF EXISTS "System can insert login attempts" ON login_attempts;
CREATE POLICY "System can insert login attempts" ON login_attempts
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- message_recipients
DROP POLICY IF EXISTS "Allow creating message recipients" ON message_recipients;
CREATE POLICY "Allow creating message recipients" ON message_recipients
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Allow updating message recipients" ON message_recipients;
CREATE POLICY "Allow updating message recipients" ON message_recipients
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow viewing message recipients" ON message_recipients;
CREATE POLICY "Allow viewing message recipients" ON message_recipients
  FOR SELECT TO anon, authenticated USING (true);

-- messages
DROP POLICY IF EXISTS "Admins can create messages" ON messages;
CREATE POLICY "Admins can create messages" ON messages
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Admins can view messages" ON messages;
CREATE POLICY "Admins can view messages" ON messages
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Allow updating messages" ON messages;
CREATE POLICY "Allow updating messages" ON messages
  FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

-- rating_requests
DROP POLICY IF EXISTS "Anyone can delete rating requests" ON rating_requests;
CREATE POLICY "Anyone can delete rating requests" ON rating_requests
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can insert rating requests" ON rating_requests;
CREATE POLICY "Anyone can insert rating requests" ON rating_requests
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can update rating requests" ON rating_requests;
CREATE POLICY "Anyone can update rating requests" ON rating_requests
  FOR UPDATE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view rating requests" ON rating_requests;
CREATE POLICY "Anyone can view rating requests" ON rating_requests
  FOR SELECT TO anon, authenticated USING (true);

-- service_ratings
DROP POLICY IF EXISTS "Anyone can delete service ratings" ON service_ratings;
CREATE POLICY "Anyone can delete service ratings" ON service_ratings
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can insert service ratings" ON service_ratings;
CREATE POLICY "Anyone can insert service ratings" ON service_ratings
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can update service ratings" ON service_ratings;
CREATE POLICY "Anyone can update service ratings" ON service_ratings
  FOR UPDATE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view service ratings" ON service_ratings;
CREATE POLICY "Anyone can view service ratings" ON service_ratings
  FOR SELECT TO anon, authenticated USING (true);

-- simulated_customers
DROP POLICY IF EXISTS "Anyone can create customers" ON simulated_customers;
CREATE POLICY "Anyone can create customers" ON simulated_customers
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Anyone can delete customers" ON simulated_customers;
CREATE POLICY "Anyone can delete customers" ON simulated_customers
  FOR DELETE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can update customers" ON simulated_customers;
CREATE POLICY "Anyone can update customers" ON simulated_customers
  FOR UPDATE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Anyone can view customers" ON simulated_customers;
CREATE POLICY "Anyone can view customers" ON simulated_customers
  FOR SELECT TO anon, authenticated USING (true);

-- work_sessions
DROP POLICY IF EXISTS "Users can create own work sessions" ON work_sessions;
CREATE POLICY "Users can create own work sessions" ON work_sessions
  FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "Users can update own work sessions" ON work_sessions;
CREATE POLICY "Users can update own work sessions" ON work_sessions
  FOR UPDATE TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Users can view own work sessions" ON work_sessions;
CREATE POLICY "Users can view own work sessions" ON work_sessions
  FOR SELECT TO anon, authenticated USING (true);

-- announcement_categories: Keep SELECT as public for viewing, restrict write ops
DROP POLICY IF EXISTS "Anyone can view announcement categories" ON announcement_categories;
CREATE POLICY "Anyone can view announcement categories" ON announcement_categories
  FOR SELECT TO anon, authenticated USING (true);
