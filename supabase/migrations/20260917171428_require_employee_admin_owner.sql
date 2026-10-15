ALTER TABLE public.users
  ADD CONSTRAINT users_created_by_required
  CHECK (created_by IS NOT NULL)
  NOT VALID;
