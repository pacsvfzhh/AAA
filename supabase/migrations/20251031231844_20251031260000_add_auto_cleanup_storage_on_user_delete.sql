/*
  # Add Auto-Cleanup for Storage Files on User Deletion

  ## Purpose
  Automatically delete all verification documents from storage when a user is deleted.
  This prevents orphaned files from consuming storage space.

  ## Changes
  
  1. **New Function: `cleanup_user_storage_files()`**
     - Deletes all verification documents associated with a user
     - Searches for files in three folders: id-front, id-back, selfie
     - Runs before user deletion to ensure user_id is still available
     - Uses pattern matching to find all files for the user
  
  2. **New Trigger: `cleanup_user_storage_trigger`**
     - Fires BEFORE DELETE on users table
     - Ensures storage cleanup happens before cascade deletes
     - Prevents orphaned files in storage bucket

  ## Storage File Patterns
  Files are stored with pattern: {folder}/{user_id}-{timestamp}.{ext}
  - id-front/{user_id}-*.jpg
  - id-back/{user_id}-*.jpg
  - selfie/{user_id}-*.jpg

  ## Benefits
  - Prevents storage bloat from orphaned files
  - Automatic cleanup, no manual intervention needed
  - Reduces storage costs
  - Maintains data hygiene

  ## Security
  - Function runs with definer privileges to access storage
  - Only deletes files matching the user's UUID
  - Cannot delete other users' files
*/

-- Create function to cleanup user storage files
CREATE OR REPLACE FUNCTION cleanup_user_storage_files()
RETURNS TRIGGER AS $$
DECLARE
  file_record RECORD;
  deleted_count INTEGER := 0;
BEGIN
  -- Delete all verification documents for this user from storage
  -- Files are stored as: {folder}/{user_id}-{timestamp}.{ext}
  FOR file_record IN 
    SELECT name, bucket_id
    FROM storage.objects
    WHERE bucket_id = 'verification-documents'
      AND (
        name LIKE 'id-front/' || OLD.id::text || '-%' OR
        name LIKE 'id-back/' || OLD.id::text || '-%' OR
        name LIKE 'selfie/' || OLD.id::text || '-%'
      )
  LOOP
    -- Delete the file from storage
    DELETE FROM storage.objects
    WHERE bucket_id = file_record.bucket_id
      AND name = file_record.name;
    
    deleted_count := deleted_count + 1;
  END LOOP;

  -- Log the cleanup (optional, for debugging)
  RAISE NOTICE 'Deleted % storage files for user %', deleted_count, OLD.id;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to call the function before user deletion
DROP TRIGGER IF EXISTS cleanup_user_storage_trigger ON users;
CREATE TRIGGER cleanup_user_storage_trigger
  BEFORE DELETE ON users
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_user_storage_files();

-- Add comment for documentation
COMMENT ON FUNCTION cleanup_user_storage_files() IS 
  'Automatically deletes all verification document files from storage when a user is deleted. Prevents orphaned files and storage bloat.';
