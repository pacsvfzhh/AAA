/*
  # Add Document Storage to Verification Requests

  1. Changes
    - Add `id_front_url` column to store front ID document image URL
    - Add `id_back_url` column to store back ID document image URL (optional)
    - Add `selfie_url` column to store selfie with ID image URL (optional)

  2. Purpose
    - Enable employees to upload ID documents during verification
    - Store document URLs for admin review
    - Support multiple document types for comprehensive verification

  3. Notes
    - URLs will point to Supabase Storage bucket
    - All document fields are optional (nullable)
    - Existing verification requests will have NULL values for these fields
*/

-- Add document URL columns to verification_requests table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'verification_requests' AND column_name = 'id_front_url'
  ) THEN
    ALTER TABLE verification_requests ADD COLUMN id_front_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'verification_requests' AND column_name = 'id_back_url'
  ) THEN
    ALTER TABLE verification_requests ADD COLUMN id_back_url text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'verification_requests' AND column_name = 'selfie_url'
  ) THEN
    ALTER TABLE verification_requests ADD COLUMN selfie_url text;
  END IF;
END $$;