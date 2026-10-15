/*
# Add source_type column to customer service tables

1. Modified Tables
   - `simulated_customers`: Add `source_type` TEXT column (default 'aaa_service')
   - `customer_employee_conversations`: Add `source_type` TEXT column (default 'aaa_service')
   - `cs_message_templates`: Add `source_type` TEXT column (default 'aaa_service')

2. Purpose
   - Partition customer service data between two independent admin pages (AAA and CCC)
   - All existing data defaults to 'aaa_service' (original page) with no data migration needed
   - New CCC page writes 'ccc_service' — completely separate data pool

3. Indexes
   - Add indexes on source_type for all three tables for query performance

4. Important Notes
   - Default 'aaa_service' means all existing data automatically belongs to the original page
   - No data migration or backfill needed — the DEFAULT handles it
   - CHECK constraint ensures only valid values: 'aaa_service' or 'ccc_service'
*/

-- Add source_type to simulated_customers
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'simulated_customers' AND column_name = 'source_type'
  ) THEN
    ALTER TABLE simulated_customers ADD COLUMN source_type text NOT NULL DEFAULT 'aaa_service';
    ALTER TABLE simulated_customers ADD CONSTRAINT simulated_customers_source_type_check
      CHECK (source_type IN ('aaa_service', 'ccc_service'));
  END IF;
END $$;

-- Add source_type to customer_employee_conversations
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'customer_employee_conversations' AND column_name = 'source_type'
  ) THEN
    ALTER TABLE customer_employee_conversations ADD COLUMN source_type text NOT NULL DEFAULT 'aaa_service';
    ALTER TABLE customer_employee_conversations ADD CONSTRAINT cec_source_type_check
      CHECK (source_type IN ('aaa_service', 'ccc_service'));
  END IF;
END $$;

-- Add source_type to cs_message_templates
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cs_message_templates' AND column_name = 'source_type'
  ) THEN
    ALTER TABLE cs_message_templates ADD COLUMN source_type text NOT NULL DEFAULT 'aaa_service';
    ALTER TABLE cs_message_templates ADD CONSTRAINT cs_templates_source_type_check
      CHECK (source_type IN ('aaa_service', 'ccc_service'));
  END IF;
END $$;

-- Add indexes for query performance
CREATE INDEX IF NOT EXISTS idx_simulated_customers_source_type ON simulated_customers(source_type);
CREATE INDEX IF NOT EXISTS idx_cec_source_type ON customer_employee_conversations(source_type);
CREATE INDEX IF NOT EXISTS idx_cs_templates_source_type ON cs_message_templates(source_type);

-- Add composite indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_simulated_customers_admin_source ON simulated_customers(admin_id, source_type);
CREATE INDEX IF NOT EXISTS idx_cs_templates_admin_source ON cs_message_templates(admin_id, source_type);
