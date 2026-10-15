/*
  # Fix Storage Policies for Custom Authentication

  1. Changes
    - Remove restrictive RLS policies on storage.objects
    - Allow public upload and update for verification documents
    - This project uses custom authentication (not Supabase Auth)
    - Storage bucket remains public for document viewing

  2. Security Notes
    - File uploads are controlled at application level
    - File naming includes user ID for organization
    - Admin review process validates all submissions
*/

-- Drop existing restrictive policies
DROP POLICY IF EXISTS "Authenticated users can upload verification documents" ON storage.objects;
DROP POLICY IF EXISTS "Users can update own verification documents" ON storage.objects;
DROP POLICY IF EXISTS "Public read access to verification documents" ON storage.objects;

-- Allow anyone to upload to verification-documents bucket
-- Security is handled at application level
CREATE POLICY "Allow upload to verification documents"
ON storage.objects
FOR INSERT
TO public
WITH CHECK (bucket_id = 'verification-documents');

-- Allow anyone to update files in verification-documents bucket
CREATE POLICY "Allow update verification documents"
ON storage.objects
FOR UPDATE
TO public
USING (bucket_id = 'verification-documents');

-- Allow anyone to delete files in verification-documents bucket
CREATE POLICY "Allow delete verification documents"
ON storage.objects
FOR DELETE
TO public
USING (bucket_id = 'verification-documents');

-- Allow public read access to all files in the bucket
CREATE POLICY "Allow read verification documents"
ON storage.objects
FOR SELECT
TO public
USING (bucket_id = 'verification-documents');