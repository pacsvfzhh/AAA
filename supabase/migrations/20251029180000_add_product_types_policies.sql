/*
  # Add Product Types Management Policies

  1. Changes
    - Add INSERT policy for product_types table
    - Add UPDATE policy for product_types table
    - Add DELETE policy for product_types table
  
  2. Security
    - All policies allow public access for now (using true condition)
    - In production, these should be restricted to admin users only

  3. Notes
    - These policies enable full CRUD operations on product_types table
    - Policies use permissive approach with true condition
*/

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Product types can be inserted" ON product_types;
DROP POLICY IF EXISTS "Product types can be updated" ON product_types;
DROP POLICY IF EXISTS "Product types can be deleted" ON product_types;

-- Allow anyone to insert product types
CREATE POLICY "Product types can be inserted"
  ON product_types
  FOR INSERT
  TO authenticated, anon
  WITH CHECK (true);

-- Allow anyone to update product types
CREATE POLICY "Product types can be updated"
  ON product_types
  FOR UPDATE
  TO authenticated, anon
  USING (true)
  WITH CHECK (true);

-- Allow anyone to delete product types
CREATE POLICY "Product types can be deleted"
  ON product_types
  FOR DELETE
  TO authenticated, anon
  USING (true);
