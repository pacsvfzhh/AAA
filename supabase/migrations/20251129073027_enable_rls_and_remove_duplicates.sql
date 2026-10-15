/*
  # Enable RLS and Remove Duplicate Indexes
  
  ## Security Improvements
  - Enable RLS on 10 tables currently missing it
  - Add admin-only access policies for all tables
  
  ## Performance Improvements
  - Remove duplicate index on valid_data_audit_log
  
  ## Tables Updated
  - valid_data_error_log
  - valid_data_query_performance
  - history_cleanup_config
  - data_retention_policies
  - valid_data_monthly_stats
  - orders_history_2025
  - orders_history_2026
  - valid_data_audit_log
  - valid_order_data_archive
  - bulk_import_log
*/

-- ============================================================================
-- REMOVE DUPLICATE INDEXES
-- ============================================================================

DROP INDEX IF EXISTS idx_audit_timestamp;

-- ============================================================================
-- ENABLE RLS ON PUBLIC TABLES
-- ============================================================================

ALTER TABLE valid_data_error_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE valid_data_query_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE history_cleanup_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE valid_data_monthly_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_history_2025 ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders_history_2026 ENABLE ROW LEVEL SECURITY;
ALTER TABLE valid_data_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE valid_order_data_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_import_log ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- ADD RLS POLICIES FOR ADMIN ACCESS
-- ============================================================================

-- valid_data_error_log
CREATE POLICY "Admins can access error logs"
  ON valid_data_error_log FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );

-- valid_data_query_performance
CREATE POLICY "Admins can access query performance"
  ON valid_data_query_performance FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );

-- history_cleanup_config
CREATE POLICY "Admins can access cleanup config"
  ON history_cleanup_config FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );

-- data_retention_policies
CREATE POLICY "Admins can access retention policies"
  ON data_retention_policies FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );

-- valid_data_monthly_stats
CREATE POLICY "Admins can access monthly stats"
  ON valid_data_monthly_stats FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );

-- orders_history_2025
CREATE POLICY "Admins can access order history 2025"
  ON orders_history_2025 FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );

-- orders_history_2026
CREATE POLICY "Admins can access order history 2026"
  ON orders_history_2026 FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );

-- valid_data_audit_log
CREATE POLICY "Admins can access audit log"
  ON valid_data_audit_log FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );

-- valid_order_data_archive
CREATE POLICY "Admins can access archived data"
  ON valid_order_data_archive FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );

-- bulk_import_log
CREATE POLICY "Admins can access import log"
  ON bulk_import_log FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM admins 
      WHERE username = current_user
      AND id = (SELECT auth.uid())
    )
  );
