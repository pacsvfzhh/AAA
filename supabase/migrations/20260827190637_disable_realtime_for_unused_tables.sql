/*
# Disable Realtime for tables with no frontend subscriptions

## Purpose
Reduce Realtime replication lag by removing tables from the publication that
generate WAL traffic but have zero frontend Realtime subscribers.

## Tables removed from Realtime publication:
1. dispatch_assignments - backend-only, no .on('postgres_changes') in frontend
2. dispatch_orders - backend-only queue table
3. dispatch_config - rarely changed, no subscription
4. broadcast_messages - no subscription
5. broadcast_recipients - no subscription
6. service_ratings - no subscription
7. simulated_customers - no subscription
8. customer_service_sessions - no subscription
9. announcement_categories - no subscription

## Tables kept (have active frontend subscriptions):
- orders, users, admins, wallets, withdrawals, verification_requests
- announcements, admin_configs, system_configs, account_locks
- customer_employee_conversations, message_recipients, product_types
- dispatch_groups, dispatch_group_members, dispatch_group_orders
- dispatch_sessions, work_sessions, employee_login_history
- rating_requests

## Impact
- No frontend functionality affected (verified: none of the removed tables
  have .on('postgres_changes') listeners in the codebase)
- Reduces WAL decoded by Realtime replication slot
- Reduces replication lag during bulk operations on these tables
*/

ALTER PUBLICATION supabase_realtime DROP TABLE dispatch_assignments;
ALTER PUBLICATION supabase_realtime DROP TABLE dispatch_orders;
ALTER PUBLICATION supabase_realtime DROP TABLE dispatch_config;
ALTER PUBLICATION supabase_realtime DROP TABLE broadcast_messages;
ALTER PUBLICATION supabase_realtime DROP TABLE broadcast_recipients;
ALTER PUBLICATION supabase_realtime DROP TABLE service_ratings;
ALTER PUBLICATION supabase_realtime DROP TABLE simulated_customers;
ALTER PUBLICATION supabase_realtime DROP TABLE customer_service_sessions;
ALTER PUBLICATION supabase_realtime DROP TABLE announcement_categories;