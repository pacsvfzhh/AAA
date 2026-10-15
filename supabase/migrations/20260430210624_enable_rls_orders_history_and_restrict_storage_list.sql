/*
  # Fix two Security Advisor issues

  1. Enable RLS on orders_history
    - orders_history is the archive table for completed/old orders
    - It currently has RLS disabled, which means anyone with the anon key
      could read historical order data (user_id, amounts, commissions, etc.)
    - Enable RLS and add restrictive policies
    - Only used internally by cleanup/archival flows — frontend never reads it
    - Policies grant access only to the service_role; regular users (anon,
      authenticated) get no access

  2. Restrict LIST on public storage buckets
    - Public buckets (verification-documents, chat-images, super-customer-avatars,
      announcement-images, website-icons) had SELECT policies that allow anyone
      to list all objects in the bucket (bucket_id = 'X' with no further filter)
    - Public URL GET of individual objects still works (public buckets bypass
      RLS for direct URL reads) — but LIST uses RLS and was enumerating
      everything
    - Drop the permissive SELECT policies so anonymous callers cannot enumerate
      bucket contents
    - Object retrieval by known URL continues to work via the public bucket
      mechanism

  3. Security impact
    - Prevents unauthenticated enumeration of verification documents
      (KYC/ID uploads), chat images, avatars, announcement media, icons
    - Prevents unauthenticated reading of historical order records
    - No change to legitimate flows: admin actions use service_role; public
      asset viewing uses direct public URLs
*/

ALTER TABLE public.orders_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'orders_history'
      AND policyname = 'Service role full access to orders_history'
  ) THEN
    CREATE POLICY "Service role full access to orders_history"
      ON public.orders_history
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

DROP POLICY IF EXISTS "Allow read verification documents" ON storage.objects;
DROP POLICY IF EXISTS "Allow public read access to super customer avatars" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view announcement images" ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view chat images" ON storage.objects;
DROP POLICY IF EXISTS "Public read access for website icons" ON storage.objects;