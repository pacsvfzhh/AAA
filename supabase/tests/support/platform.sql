-- Roles, schemas and helper functions that Supabase provides outside the migrations.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE supabase_admin NOLOGIN;
CREATE ROLE dashboard_user NOLOGIN;
CREATE ROLE supabase_read_only_user NOLOGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE SCHEMA IF NOT EXISTS cron;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
ALTER DATABASE postgres SET search_path = "$user", public, extensions;
SET search_path = "$user", public, extensions;
GRANT USAGE ON SCHEMA public, extensions TO anon, authenticated, service_role;

CREATE TABLE storage.buckets (
  id text PRIMARY KEY, name text NOT NULL, owner uuid, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), public boolean DEFAULT false, file_size_limit bigint,
  allowed_mime_types text[]);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id),
  name text, owner uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now(), metadata jsonb, path_tokens text[],
  UNIQUE (bucket_id, name));
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql
  AS $$ SELECT string_to_array(name, '/') $$;
CREATE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql
  AS $$ SELECT (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$ SELECT 'anon'::text $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY);

CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text,
  active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(text, text, text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job(jobname, schedule, command) VALUES ($1, $2, $3)
  ON CONFLICT (jobname) DO UPDATE SET schedule = excluded.schedule, command = excluded.command
  RETURNING jobid $$;
CREATE FUNCTION cron.schedule(text, text) RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
CREATE FUNCTION cron.unschedule(text) RETURNS boolean LANGUAGE sql
  AS $$ DELETE FROM cron.job WHERE jobname = $1 RETURNING true $$;
CREATE FUNCTION cron.unschedule(bigint) RETURNS boolean LANGUAGE sql
  AS $$ DELETE FROM cron.job WHERE jobid = $1 RETURNING true $$;
CREATE PUBLICATION supabase_realtime;
