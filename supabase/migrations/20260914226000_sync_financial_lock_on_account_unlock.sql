CREATE OR REPLACE FUNCTION private.clear_financial_login_lock_after_account_unlock()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF OLD.unlocked_at IS NULL
    AND NEW.unlocked_at IS NOT NULL
    AND NEW.identifier_type = 'username' THEN
    DELETE FROM financial_login_attempts
    WHERE username = NEW.identifier;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_clear_financial_login_lock_after_account_unlock ON account_locks;

CREATE TRIGGER trigger_clear_financial_login_lock_after_account_unlock
AFTER UPDATE OF unlocked_at ON account_locks
FOR EACH ROW
WHEN (OLD.unlocked_at IS NULL AND NEW.unlocked_at IS NOT NULL)
EXECUTE FUNCTION private.clear_financial_login_lock_after_account_unlock();

REVOKE ALL ON FUNCTION private.clear_financial_login_lock_after_account_unlock() FROM PUBLIC, anon, authenticated;
