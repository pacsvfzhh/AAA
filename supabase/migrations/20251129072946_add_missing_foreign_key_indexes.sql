/*
  # Add Missing Foreign Key Indexes
  
  ## Performance Improvements
  - Add indexes for 19 unindexed foreign keys
  - This improves JOIN performance and query optimization
  
  ## Impact
  - Significant performance boost for queries involving these foreign keys
  - Essential for maintaining good performance at scale
*/

-- Account locks
CREATE INDEX IF NOT EXISTS idx_account_locks_unlocked_by 
  ON account_locks(unlocked_by) WHERE unlocked_by IS NOT NULL;

-- Admin group members
CREATE INDEX IF NOT EXISTS idx_admin_group_members_admin_id 
  ON admin_group_members(admin_id);

-- Admin groups
CREATE INDEX IF NOT EXISTS idx_admin_groups_created_by 
  ON admin_groups(created_by);

-- Admins
CREATE INDEX IF NOT EXISTS idx_admins_parent_id 
  ON admins(parent_id) WHERE parent_id IS NOT NULL;

-- Broadcast messages
CREATE INDEX IF NOT EXISTS idx_broadcast_messages_target_admin_id 
  ON broadcast_messages(target_admin_id) WHERE target_admin_id IS NOT NULL;

-- Bulk import log
CREATE INDEX IF NOT EXISTS idx_bulk_import_log_performed_by 
  ON bulk_import_log(performed_by);

-- Commission audit log
CREATE INDEX IF NOT EXISTS idx_commission_audit_log_transaction_id 
  ON commission_audit_log(transaction_id);

-- Customer service sessions
CREATE INDEX IF NOT EXISTS idx_customer_service_sessions_employee_id 
  ON customer_service_sessions(employee_id);

-- Dispatch group members
CREATE INDEX IF NOT EXISTS idx_dispatch_group_members_assigned_by 
  ON dispatch_group_members(assigned_by) WHERE assigned_by IS NOT NULL;

-- Dispatch group orders
CREATE INDEX IF NOT EXISTS idx_dispatch_group_orders_created_by 
  ON dispatch_group_orders(created_by);

-- Dispatch groups
CREATE INDEX IF NOT EXISTS idx_dispatch_groups_created_by 
  ON dispatch_groups(created_by);

-- Dispatch orders
CREATE INDEX IF NOT EXISTS idx_dispatch_orders_created_by 
  ON dispatch_orders(created_by) WHERE created_by IS NOT NULL;

-- Orders
CREATE INDEX IF NOT EXISTS idx_orders_product_type_id 
  ON orders(product_type_id);

-- Rating requests
CREATE INDEX IF NOT EXISTS idx_rating_requests_session_id 
  ON rating_requests(session_id);

-- Used order data
CREATE INDEX IF NOT EXISTS idx_used_order_data_order_id 
  ON used_order_data(order_id);

-- Valid data error log
CREATE INDEX IF NOT EXISTS idx_valid_data_error_log_resolved_by 
  ON valid_data_error_log(resolved_by) WHERE resolved_by IS NOT NULL;

-- Verification requests
CREATE INDEX IF NOT EXISTS idx_verification_requests_audited_by 
  ON verification_requests(audited_by) WHERE audited_by IS NOT NULL;

-- Wallet transactions
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_by 
  ON wallet_transactions(created_by) WHERE created_by IS NOT NULL;

-- Withdrawals
CREATE INDEX IF NOT EXISTS idx_withdrawals_audited_by 
  ON withdrawals(audited_by) WHERE audited_by IS NOT NULL;
