DO $block$
DECLARE
  v_source text;
  v_old text := $anchor$AND (v_group.pool_selection_mode = 'random' OR is_base) FOR SHARE$anchor$;
  v_new text := $anchor$AND (v_group.pool_selection_mode IN ('random', 'weighted') OR is_base)
    AND (v_group.pool_selection_mode <> 'weighted' OR trigger_probability > 0) FOR SHARE$anchor$;
BEGIN
  SELECT pg_get_functiondef('public.assign_next_dispatch_order_secure(uuid,uuid,text,uuid,uuid,text)'::regprocedure)
  INTO v_source;

  IF strpos(v_source, v_new) > 0 THEN
    RETURN;
  END IF;
  IF (length(v_source) - length(replace(v_source, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'Secure dispatch pool validation changed; cannot apply weighted pool patch.';
  END IF;

  EXECUTE replace(v_source, v_old, v_new);
END;
$block$;
