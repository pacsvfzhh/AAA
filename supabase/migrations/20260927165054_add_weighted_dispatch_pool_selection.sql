ALTER TABLE public.dispatch_order_pools
  ADD COLUMN trigger_probability integer NOT NULL DEFAULT 0
    CONSTRAINT dispatch_order_pools_trigger_probability_check
      CHECK (trigger_probability BETWEEN 0 AND 100);

UPDATE public.dispatch_order_pools SET trigger_probability = 100 WHERE is_base;

ALTER TABLE public.dispatch_groups DROP CONSTRAINT dispatch_groups_pool_selection_mode_check;
ALTER TABLE public.dispatch_groups
  ADD CONSTRAINT dispatch_groups_pool_selection_mode_check
    CHECK (pool_selection_mode IN ('base', 'random', 'weighted'));

CREATE OR REPLACE FUNCTION private.create_dispatch_base_pool()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.dispatch_order_pools (
    group_id, pool_name, is_base, is_active, dispatch_interval_min,
    dispatch_interval_max, session_timeout_minutes, dispatch_order_mode,
    dispatch_success_rate, trigger_probability, created_by
  ) VALUES (
    NEW.id, 'Base', true, true,
    LEAST(COALESCE(NEW.dispatch_interval_min, 30), COALESCE(NEW.dispatch_interval_max, 120)),
    GREATEST(COALESCE(NEW.dispatch_interval_min, 30), COALESCE(NEW.dispatch_interval_max, 120)),
    COALESCE(NEW.session_timeout_minutes, 10),
    COALESCE(NEW.dispatch_order_mode, 'random'),
    COALESCE(NEW.dispatch_success_rate, 100), 100, NEW.created_by
  );
  RETURN NEW;
END;
$function$;

DO $block$
DECLARE
  v_source text;
  v_old text;
BEGIN
  SELECT pg_get_functiondef('public.admin_save_dispatch_group(uuid,uuid,jsonb)'::regprocedure)
  INTO v_source;
  v_old := $anchor$p_changes->>'pool_selection_mode' NOT IN ('base', 'random')$anchor$;
  IF strpos(v_source, v_old) = 0 THEN
    RAISE EXCEPTION 'Dispatch group mode validation changed.';
  END IF;
  v_source := replace(v_source, v_old,
    $anchor$p_changes->>'pool_selection_mode' NOT IN ('base', 'random', 'weighted')$anchor$);
  v_old := '    UPDATE public.dispatch_groups
    SET group_name =';
  IF strpos(v_source, v_old) = 0 THEN
    RAISE EXCEPTION 'Dispatch group update changed.';
  END IF;
  v_source := replace(v_source, v_old, $patch$    IF p_changes->>'pool_selection_mode' = 'weighted' AND
       (SELECT COALESCE(sum(pool.trigger_probability), 0)
        FROM public.dispatch_order_pools AS pool
        WHERE pool.group_id = p_group_id AND pool.archived_at IS NULL) <> 100 THEN
      RAISE EXCEPTION 'Active dispatch pool probabilities must total 100 percent.';
    END IF;
    UPDATE public.dispatch_groups
    SET group_name =$patch$);
  EXECUTE v_source;

  SELECT pg_get_functiondef('public.prepare_next_dispatch_order_secure(uuid,uuid,text,uuid)'::regprocedure)
  INTO v_source;
  v_old := $anchor$(v_group.pool_selection_mode = 'random' OR pool.is_base)$anchor$;
  IF (length(v_source) - length(replace(v_source, v_old, ''))) / length(v_old) <> 2 THEN
    RAISE EXCEPTION 'Dispatch pool eligibility changed.';
  END IF;
  v_source := replace(v_source, v_old, $patch$(v_group.pool_selection_mode IN ('random', 'weighted') OR pool.is_base)
      AND (v_group.pool_selection_mode <> 'weighted' OR pool.trigger_probability > 0)$patch$);
  v_old := $anchor$ORDER BY CASE WHEN v_group.pool_selection_mode = 'random' THEN random() ELSE 0 END,$anchor$;
  IF strpos(v_source, v_old) = 0 THEN
    RAISE EXCEPTION 'Dispatch pool random selection changed.';
  END IF;
  v_source := replace(v_source, v_old, $patch$ORDER BY CASE
               WHEN v_group.pool_selection_mode = 'weighted'
                 THEN -ln(greatest(random(), 0.000000000001)) / pool.trigger_probability
               WHEN v_group.pool_selection_mode = 'random' THEN random()
               ELSE 0 END,$patch$);
  EXECUTE v_source;
END;
$block$;

CREATE FUNCTION public.admin_set_dispatch_pool_probabilities(
  p_admin_session_token uuid, p_group_id uuid, p_probabilities jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
DECLARE
  v_admin_role text;
  v_entry jsonb;
  v_count integer;
  v_unique_count integer;
  v_total integer;
  v_pool_count integer;
BEGIN
  SELECT admin_role INTO v_admin_role
  FROM private.get_financial_admin_context(p_admin_session_token);
  IF v_admin_role IS DISTINCT FROM 'super_admin' THEN
    RAISE EXCEPTION 'Only a super administrator can edit dispatch pool probabilities.';
  END IF;
  IF p_group_id IS NULL OR p_probabilities IS NULL OR jsonb_typeof(p_probabilities) <> 'array' THEN
    RAISE EXCEPTION 'Invalid dispatch pool probabilities.';
  END IF;
  PERFORM 1 FROM public.dispatch_groups
  WHERE id = p_group_id AND archived_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Dispatch group not found or archived.';
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_probabilities)
  LOOP
    IF jsonb_typeof(v_entry) <> 'object'
       OR v_entry->>'pool_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR jsonb_typeof(v_entry->'probability') <> 'number'
       OR v_entry->>'probability' !~ '^[0-9]{1,3}$'
       OR (v_entry->>'probability')::integer > 100
       OR (SELECT count(*) FROM jsonb_object_keys(v_entry)) <> 2 THEN
      RAISE EXCEPTION 'Invalid dispatch pool probability entry.';
    END IF;
  END LOOP;
  SELECT count(*), count(DISTINCT pool_id), COALESCE(sum(probability), 0)
  INTO v_count, v_unique_count, v_total
  FROM jsonb_to_recordset(p_probabilities) AS entry(pool_id uuid, probability integer);
  SELECT count(*) INTO v_pool_count
  FROM public.dispatch_order_pools
  WHERE group_id = p_group_id AND archived_at IS NULL;
  IF v_count <> v_pool_count OR v_unique_count <> v_count OR v_total <> 100
     OR EXISTS (
       SELECT 1 FROM jsonb_to_recordset(p_probabilities) AS entry(pool_id uuid, probability integer)
       LEFT JOIN public.dispatch_order_pools AS pool
         ON pool.id = entry.pool_id AND pool.group_id = p_group_id AND pool.archived_at IS NULL
       WHERE pool.id IS NULL
     ) THEN
    RAISE EXCEPTION 'Dispatch pool probabilities must include every non-archived pool and total 100 percent.';
  END IF;
  UPDATE public.dispatch_order_pools AS pool
  SET trigger_probability = entry.probability, updated_at = clock_timestamp()
  FROM jsonb_to_recordset(p_probabilities) AS entry(pool_id uuid, probability integer)
  WHERE pool.id = entry.pool_id AND pool.group_id = p_group_id AND pool.archived_at IS NULL;
  RETURN jsonb_build_object('pools',
    (SELECT COALESCE(jsonb_agg(to_jsonb(pool) ORDER BY pool.is_base DESC, pool.created_at), '[]'::jsonb)
     FROM public.dispatch_order_pools AS pool
     WHERE pool.group_id = p_group_id AND pool.archived_at IS NULL));
END;
$function$;

CREATE FUNCTION private.guard_weighted_dispatch_pool_archive()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL
     AND OLD.trigger_probability > 0
     AND EXISTS (SELECT 1 FROM public.dispatch_groups
                 WHERE id = OLD.group_id AND pool_selection_mode = 'weighted') THEN
    RAISE EXCEPTION 'Set this pool probability to zero and redistribute it before archiving.';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER guard_weighted_dispatch_pool_archive
BEFORE UPDATE OF archived_at ON public.dispatch_order_pools
FOR EACH ROW EXECUTE FUNCTION private.guard_weighted_dispatch_pool_archive();

REVOKE ALL ON FUNCTION public.admin_set_dispatch_pool_probabilities(uuid, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_dispatch_pool_probabilities(uuid, uuid, jsonb)
  TO anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_weighted_dispatch_pool_archive() FROM PUBLIC, anon, authenticated;
