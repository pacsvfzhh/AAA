CREATE FUNCTION private.reject_archived_employee_chat()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.employee_id IS NOT DISTINCT FROM OLD.employee_id THEN
      RETURN NEW;
    END IF;
  END IF;

  PERFORM 1 FROM public.users
  WHERE id = NEW.employee_id AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Employee account is no longer available for chat.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER aa_reject_archived_employee_chat
BEFORE INSERT OR UPDATE OF employee_id ON public.customer_employee_conversations
FOR EACH ROW EXECUTE FUNCTION private.reject_archived_employee_chat();

REVOKE ALL ON FUNCTION private.reject_archived_employee_chat() FROM PUBLIC, anon, authenticated, service_role;
