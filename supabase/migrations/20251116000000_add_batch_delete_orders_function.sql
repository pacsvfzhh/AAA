/*
  # Add Batch Delete Orders Function

  1. New Functions
    - `batch_delete_dispatch_orders(p_group_id uuid, p_batch_size int)`
      - Deletes orders in batches
      - Returns the number of deleted records
      - Optimized for large-scale deletions

  2. Purpose
    - Enable efficient batch deletion of orders
    - Avoid timeout issues with large datasets
    - Provide progress tracking capability

  3. Notes
    - Function is SECURITY DEFINER to bypass RLS during deletion
    - Only deletes orders from specified group
    - Returns actual number of deleted records
*/

-- Create batch delete function
CREATE OR REPLACE FUNCTION batch_delete_dispatch_orders(
  p_group_id uuid,
  p_batch_size int DEFAULT 5000
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_deleted_count int;
BEGIN
  -- Delete up to p_batch_size records
  DELETE FROM dispatch_group_orders
  WHERE id IN (
    SELECT id
    FROM dispatch_group_orders
    WHERE group_id = p_group_id
    LIMIT p_batch_size
  );

  -- Get the number of deleted rows
  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

  RETURN v_deleted_count;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION batch_delete_dispatch_orders(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION batch_delete_dispatch_orders(uuid, int) TO anon;

-- Add comment
COMMENT ON FUNCTION batch_delete_dispatch_orders IS
'Deletes dispatch orders in batches. Returns the number of deleted records. Used for large-scale order deletions to avoid timeouts.';
