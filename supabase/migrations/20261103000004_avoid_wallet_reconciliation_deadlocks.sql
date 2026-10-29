BEGIN;

DO $migration$
DECLARE
  v_definition text;
  v_body text;
  v_expected_body constant text := $old$ DECLARE v_item record; v_processed integer:=0; v_failed integer:=0; BEGIN FOR v_item IN SELECT user_id FROM wallet_reconciliation_queue WHERE next_attempt_at<=now() ORDER BY requested_at LIMIT GREATEST(1,LEAST(p_batch_size,500)) LOOP BEGIN PERFORM reconcile_wallet_from_ledger(v_item.user_id); v_processed:=v_processed+1; EXCEPTION WHEN OTHERS THEN UPDATE wallet_reconciliation_queue SET attempts=attempts+1,next_attempt_at=now()+make_interval(mins=>LEAST(60,GREATEST(1,(attempts+1)*5))),last_error=SQLERRM WHERE user_id=v_item.user_id; v_failed:=v_failed+1; END; END LOOP; RETURN jsonb_build_object('success',true,'processed',v_processed,'failed',v_failed); END $old$;
  v_expected_repository_body constant text := $repository$
DECLARE
  v_item record;
  v_processed integer := 0;
  v_failed integer := 0;
BEGIN
  FOR v_item IN
    SELECT user_id
    FROM wallet_reconciliation_queue
    WHERE next_attempt_at <= now()
    ORDER BY requested_at
    LIMIT GREATEST(1, LEAST(p_batch_size, 500))
  LOOP
    BEGIN
      PERFORM reconcile_wallet_from_ledger(v_item.user_id);
      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE wallet_reconciliation_queue
      SET attempts = attempts + 1,
          next_attempt_at = now() + make_interval(
            mins => LEAST(60, GREATEST(1, (attempts + 1) * 5))
          ),
          last_error = SQLERRM
      WHERE user_id = v_item.user_id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'processed', v_processed,
    'failed', v_failed
  );
END;
$repository$;
  v_replacement_body constant text := $new$
DECLARE
  v_item record;
  v_processed integer := 0;
  v_failed integer := 0;
  v_skipped_busy integer := 0;
  v_error text;
  v_error_state text;
BEGIN
  FOR v_item IN
    SELECT user_id
    FROM public.wallet_reconciliation_queue
    WHERE next_attempt_at <= now()
    ORDER BY requested_at, user_id
    LIMIT GREATEST(1, LEAST(p_batch_size, 500))
  LOOP
    BEGIN
      PERFORM 1 FROM public.wallet_reconciliation_queue
      WHERE user_id = v_item.user_id AND next_attempt_at <= now()
      FOR UPDATE NOWAIT;
      IF NOT FOUND THEN
        CONTINUE;
      END IF;

      PERFORM 1 FROM public.wallets
      WHERE user_id = v_item.user_id
      FOR UPDATE NOWAIT;
      PERFORM 1 FROM public.users
      WHERE id = v_item.user_id
      FOR UPDATE NOWAIT;

      PERFORM public.reconcile_wallet_from_ledger(v_item.user_id);
      v_processed := v_processed + 1;
    EXCEPTION
      WHEN lock_not_available THEN
        v_skipped_busy := v_skipped_busy + 1;
      WHEN OTHERS THEN
        v_error := SQLERRM;
        v_error_state := SQLSTATE;
        v_failed := v_failed + 1;
        BEGIN
          PERFORM 1 FROM public.wallet_reconciliation_queue
          WHERE user_id = v_item.user_id
          FOR UPDATE NOWAIT;
          IF FOUND THEN
            UPDATE public.wallet_reconciliation_queue
            SET attempts = attempts + 1,
                next_attempt_at = now() + make_interval(
                  mins => LEAST(60, GREATEST(1, (attempts + 1) * 5))
                ),
                last_error = v_error
            WHERE user_id = v_item.user_id;
          END IF;
        EXCEPTION
          WHEN lock_not_available THEN
            RAISE WARNING 'Wallet reconciliation failure could not be recorded because its queue row is busy (SQLSTATE %): %', v_error_state, v_error;
        END;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'processed', v_processed,
    'failed', v_failed,
    'skipped_busy', v_skipped_busy
  );
END;
$new$;
BEGIN
  SELECT pg_get_functiondef(p.oid), p.prosrc
  INTO v_definition, v_body
  FROM pg_proc p
  WHERE p.oid = to_regprocedure('public.process_wallet_reconciliation_queue(integer)');

  IF v_definition IS NULL OR (
    v_body IS DISTINCT FROM v_expected_body
    AND v_body IS DISTINCT FROM v_expected_repository_body
  ) THEN
    RAISE EXCEPTION 'Wallet reconciliation worker differs from the reviewed definition; migration cancelled.';
  END IF;

  IF (length(v_definition) - length(replace(v_definition, v_body, ''))) / length(v_body) <> 1 THEN
    RAISE EXCEPTION 'Wallet reconciliation worker body is not unique; migration cancelled.';
  END IF;

  EXECUTE replace(v_definition, v_body, v_replacement_body);
END;
$migration$;

COMMIT;
