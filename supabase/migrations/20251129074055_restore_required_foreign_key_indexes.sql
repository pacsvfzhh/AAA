/*
  # Restore Required Foreign Key Indexes
  
  ## Performance Fix
  - Restore foreign key indexes that were incorrectly removed
  - These indexes are essential for JOIN performance
  - Use partial indexes (WHERE NOT NULL) for nullable foreign keys
  
  ## Impact
  - Improved JOIN performance on foreign key relationships
  - Faster query execution for related table queries
  - Essential for maintaining good performance at scale
*/

-- account_locks foreign keys
CREATE INDEX IF NOT EXISTS idx_account_locks_user_id 
  ON account_locks(user_id);

CREATE INDEX IF NOT EXISTS idx_account_locks_unlocked_by 
  ON account_locks(unlocked_by) 
  WHERE unlocked_by IS NOT NULL;

-- admin_group_members foreign keys
CREATE INDEX IF NOT EXISTS idx_admin_group_members_admin_id 
  ON admin_group_members(admin_id);

-- admin_groups foreign keys
CREATE INDEX IF NOT EXISTS idx_admin_groups_created_by 
  ON admin_groups(created_by);

-- admins foreign keys
CREATE INDEX IF NOT EXISTS idx_admins_parent_id 
  ON admins(parent_id) 
  WHERE parent_id IS NOT NULL;

-- broadcast_messages foreign keys
CREATE INDEX IF NOT EXISTS idx_broadcast_messages_target_admin_id 
  ON broadcast_messages(target_admin_id) 
  WHERE target_admin_id IS NOT NULL;

-- bulk_import_log foreign keys
CREATE INDEX IF NOT EXISTS idx_bulk_import_log_performed_by 
  ON bulk_import_log(performed_by);

-- commission_audit_log foreign keys
CREATE INDEX IF NOT EXISTS idx_commission_audit_log_transaction_id 
  ON commission_audit_log(transaction_id);

-- customer_service_sessions foreign keys
CREATE INDEX IF NOT EXISTS idx_customer_service_sessions_employee_id 
  ON customer_service_sessions(employee_id);

-- dispatch_group_members foreign keys
CREATE INDEX IF NOT EXISTS idx_dispatch_group_members_assigned_by 
  ON dispatch_group_members(assigned_by) 
  WHERE assigned_by IS NOT NULL;

-- dispatch_group_orders foreign keys
CREATE INDEX IF NOT EXISTS idx_dispatch_group_orders_created_by 
  ON dispatch_group_orders(created_by);

-- dispatch_groups foreign keys
CREATE INDEX IF NOT EXISTS idx_dispatch_groups_created_by 
  ON dispatch_groups(created_by);

-- dispatch_orders foreign keys
CREATE INDEX IF NOT EXISTS idx_dispatch_orders_created_by 
  ON dispatch_orders(created_by) 
  WHERE created_by IS NOT NULL;

-- orders foreign keys
CREATE INDEX IF NOT EXISTS idx_orders_product_type_id 
  ON orders(product_type_id);

-- rating_requests foreign keys
CREATE INDEX IF NOT EXISTS idx_rating_requests_session_id 
  ON rating_requests(session_id);

-- used_order_data foreign keys
CREATE INDEX IF NOT EXISTS idx_used_order_data_order_id 
  ON used_order_data(order_id);

-- valid_data_error_log foreign keys
CREATE INDEX IF NOT EXISTS idx_valid_data_error_log_resolved_by 
  ON valid_data_error_log(resolved_by) 
  WHERE resolved_by IS NOT NULL;

-- verification_requests foreign keys
CREATE INDEX IF NOT EXISTS idx_verification_requests_audited_by 
  ON verification_requests(audited_by) 
  WHERE audited_by IS NOT NULL;

-- wallet_transactions foreign keys
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_by 
  ON wallet_transactions(created_by) 
  WHERE created_by IS NOT NULL;

-- withdrawals foreign keys
CREATE INDEX IF NOT EXISTS idx_withdrawals_audited_by 
  ON withdrawals(audited_by) 
  WHERE audited_by IS NOT NULL;
