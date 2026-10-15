/*
  # Add Performance Indexes for Employee Detail Modal

  1. Performance Improvements
    - Add index on orders (user_id, created_at) for faster employee order queries
    - Add index on wallet_transactions (user_id, created_at) for faster transaction history
    - These indexes will dramatically speed up the employee detail modal loading

  2. Notes
    - Indexes are created IF NOT EXISTS to prevent errors on re-run
    - Descending order on created_at matches the query pattern
*/

-- Index for orders query in employee detail modal
CREATE INDEX IF NOT EXISTS idx_orders_user_created 
  ON orders(user_id, created_at DESC);

-- Index for wallet transactions query in employee detail modal
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_created 
  ON wallet_transactions(user_id, created_at DESC);

-- Additional index for orders status queries
CREATE INDEX IF NOT EXISTS idx_orders_user_status_created 
  ON orders(user_id, status, created_at DESC);