/*
  # Add indexes for employee search optimization

  1. Purpose
    - Optimize employee search queries across multiple fields
    - Improve search performance for username, employee_id, and verification data
    
  2. Changes
    - Enable pg_trgm extension for trigram text search
    - Add GIN indexes on frequently searched text columns
    
  3. Performance Impact
    - Significantly faster ILIKE queries
    - Better handling of partial text matches
*/

-- Enable pg_trgm extension for trigram text search (must be done first)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Add indexes to users table for faster username and employee_id searches
CREATE INDEX IF NOT EXISTS idx_users_username_search ON users USING gin (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_employee_id_search ON users USING gin (employee_id gin_trgm_ops);

-- Add indexes to verification_requests table for faster personal info searches
CREATE INDEX IF NOT EXISTS idx_verification_real_name_search ON verification_requests USING gin (real_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_verification_email_search ON verification_requests USING gin (email gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_verification_phone_search ON verification_requests USING gin (phone gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_verification_wallet_search ON verification_requests USING gin (wallet_address gin_trgm_ops);

-- Add composite index for verification_requests status filtering
CREATE INDEX IF NOT EXISTS idx_verification_status_user ON verification_requests (status, user_id);
