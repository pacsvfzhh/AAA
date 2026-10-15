/*
  # Product Types Soft Delete Documentation

  1. Purpose
    - Documents the soft delete behavior for product_types table
    - Ensures historical orders remain intact when product types are "deleted"

  2. How It Works
    - When admin clicks "delete" on a product type, is_active is set to false
    - Historical orders with that product_type_id remain unchanged
    - Product type no longer appears in employee's Submit New Order dropdown
    - All existing queries filter by is_active = true

  3. Benefits
    - Preserves data integrity for historical records
    - Prevents foreign key constraint violations
    - Maintains audit trail of all product types
    - Allows reactivation if needed (future feature)
*/

-- Ensure is_active defaults to true for all new product types
DO $$
BEGIN
  -- Set any existing NULL values to true (should not exist, but safety check)
  UPDATE product_types
  SET is_active = true
  WHERE is_active IS NULL;
END $$;

-- Add index for better performance on active product types queries
CREATE INDEX IF NOT EXISTS idx_product_types_active
ON product_types(is_active)
WHERE is_active = true;

-- Add comment to table explaining soft delete
COMMENT ON COLUMN product_types.is_active IS 'Soft delete flag: false means the product type is hidden from new orders but preserved in historical data';
