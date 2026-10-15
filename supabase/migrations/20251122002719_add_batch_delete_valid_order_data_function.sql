/*
  # Add batch delete function for valid_order_data

  1. New Functions
    - `batch_delete_valid_order_data(p_batch_size int)`
      - Deletes valid order data in batches
      - Returns the number of deleted records
      - Optimized for large-scale deletions

  2. Purpose
    - Enable efficient batch deletion of valid order data
    - Avoid timeout issues with large datasets (36K+ records)
    - Provide progress tracking capability

  3. Notes
    - Function is SECURITY DEFINER to bypass RLS during deletion
    - Deletes all records without filter (for Delete All functionality)
    - Returns actual number of deleted records
    - Uses same pattern as batch_delete_dispatch_orders
*/

-- Create batch delete function for valid_order_data
CREATE OR REPLACE FUNCTION batch_delete_valid_order_data(
  p_batch_size int DEFAULT 1000
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted_count int;
BEGIN
  -- Delete up to p_batch_size records
  DELETE FROM valid_order_data
  WHERE id IN (
    SELECT id
    FROM valid_order_data
    LIMIT p_batch_size
  );

  -- Get the number of deleted rows
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN v_deleted_count;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION batch_delete_valid_order_data(int) TO authenticated;
GRANT EXECUTE ON FUNCTION batch_delete_valid_order_data(int) TO anon;

-- Add comment
COMMENT ON FUNCTION batch_delete_valid_order_data IS
'Deletes valid order data in batches. Returns the number of deleted records. Used for large-scale deletions to avoid timeouts.';