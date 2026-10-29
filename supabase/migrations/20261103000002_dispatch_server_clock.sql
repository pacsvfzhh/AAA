BEGIN;

DO $block$
DECLARE
  v_signature text;
  v_source text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.prepare_next_dispatch_order_secure(uuid,uuid,text,uuid)',
    'public.assign_next_dispatch_order_secure(uuid,uuid,text,uuid,uuid,text)'
  ] LOOP
    SELECT pg_get_functiondef(to_regprocedure(v_signature)) INTO v_source;
    IF v_source IS NULL
       OR strpos(v_source, 'RETURN jsonb_build_object(') = 0
       OR strpos(v_source, '''due_at''') = 0
       OR strpos(v_source, '''server_now''') > 0 THEN
      RAISE EXCEPTION 'Dispatch response changed; review % before adding server time.', v_signature;
    END IF;
    EXECUTE replace(v_source,
      'RETURN jsonb_build_object(',
      'RETURN jsonb_build_object(''server_now'', clock_timestamp(), ');
  END LOOP;
END;
$block$;

COMMIT;
