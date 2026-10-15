/*
  # Create Website Icons Storage Bucket
  
  1. New Storage Bucket
    - `website-icons` bucket for custom uploaded icons
    - Public access for reading
    - File type restrictions: image/png, image/svg+xml, image/jpeg
    - Size limit: 500KB
  
  2. Security
    - Only super admins can upload
    - Public read access for displaying icons
    - Automatic cleanup when icon is replaced
*/

-- Create storage bucket for website icons
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'website-icons',
  'website-icons',
  true,
  512000, -- 500KB
  ARRAY['image/png', 'image/svg+xml', 'image/jpeg', 'image/jpg']
)
ON CONFLICT (id) DO NOTHING;

-- Drop existing policies if they exist
DO $$
BEGIN
  DROP POLICY IF EXISTS "Public read access for website icons" ON storage.objects;
  DROP POLICY IF EXISTS "Super admin can upload website icons" ON storage.objects;
  DROP POLICY IF EXISTS "Super admin can delete website icons" ON storage.objects;
END $$;

-- Allow public read access
CREATE POLICY "Public read access for website icons"
ON storage.objects FOR SELECT
TO public
USING (bucket_id = 'website-icons');

-- Only super admins can upload
CREATE POLICY "Super admin can upload website icons"
ON storage.objects FOR INSERT
TO public
WITH CHECK (
  bucket_id = 'website-icons' AND
  EXISTS (
    SELECT 1 FROM admins
    WHERE username = current_setting('request.headers', true)::json->>'x-admin-username'
    AND role = 'super_admin'
  )
);

-- Only super admins can delete
CREATE POLICY "Super admin can delete website icons"
ON storage.objects FOR DELETE
TO public
USING (
  bucket_id = 'website-icons' AND
  EXISTS (
    SELECT 1 FROM admins
    WHERE username = current_setting('request.headers', true)::json->>'x-admin-username'
    AND role = 'super_admin'
  )
);