/*
  # Enable security_invoker on history_cleanup_summary view

  1. Problem
    - The history_cleanup_summary view was created without security_invoker option
    - By default, PostgreSQL views execute queries with the view owner's privileges
    - This bypasses RLS on underlying tables and was flagged by Supabase Security Advisor
    - Anyone with the anon key could read table sizes, cleanup history, and record counts

  2. Solution
    - Set security_invoker = true so the view executes with the calling user's privileges
    - RLS policies on underlying tables (history_cleanup_config, etc.) now apply correctly

  3. Security
    - Only admins with proper RLS access to history_cleanup_config can see the summary
    - Frontend route protection continues to restrict page access to super admins
    - No functional change for legitimate admin users
*/

ALTER VIEW public.history_cleanup_summary SET (security_invoker = true);