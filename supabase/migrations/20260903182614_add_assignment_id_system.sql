/*
# Add Assignment ID System

Links Order Assignment and Orders pages via a shared Assignment ID.

1. Modified Tables
   - `dispatch_assignments`:
     - `assignment_id` (text, unique) — random ID like "ASN-8F3K2M" generated on accept
     - `order_submitted` (boolean, default false) — tracks if employee submitted order details
   - `orders`:
     - `assignment_id` (text, nullable) — links submitted order to its dispatch assignment

2. New Indexes
   - `idx_dispatch_assignments_user_status` on (user_id, status) for fast active-assignment lookup
   - `idx_orders_assignment_id` on (assignment_id) for linking queries

3. Notes
   - assignment_id UNIQUE constraint prevents ID collisions across all employees
   - order_submitted flag is the gate for "Mark Completed" button
   - orders.assignment_id is nullable for backward compatibility with existing orders
*/

-- Add assignment_id and order_submitted to dispatch_assignments
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dispatch_assignments' AND column_name = 'assignment_id'
  ) THEN
    ALTER TABLE dispatch_assignments ADD COLUMN assignment_id text UNIQUE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'dispatch_assignments' AND column_name = 'order_submitted'
  ) THEN
    ALTER TABLE dispatch_assignments ADD COLUMN order_submitted boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- Add assignment_id to orders table
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'assignment_id'
  ) THEN
    ALTER TABLE orders ADD COLUMN assignment_id text;
  END IF;
END $$;

-- Index for fast active-assignment lookup per employee
CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_user_status
  ON dispatch_assignments (user_id, status);

-- Index for order-to-assignment linking
CREATE INDEX IF NOT EXISTS idx_orders_assignment_id
  ON orders (assignment_id);
