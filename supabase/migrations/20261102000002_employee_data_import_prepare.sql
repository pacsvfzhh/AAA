/*
  Employee data import, preparation phase: capabilities, dry run, job start and chat-role mapping.
  Nothing here writes employee data; employee_import_apply_roles only creates chat roles that the
  administrator explicitly chose to create.
*/

CREATE FUNCTION public.get_employee_import_capabilities(p_admin_session_token uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  RETURN jsonb_build_object(
    'format_versions', jsonb_build_array(1),
    'site_id', (SELECT site_id FROM private.employee_transfer_site),
    'schema_fingerprint', private.employee_transfer_schema_fingerprint(),
    'unreviewed_triggers', private.employee_transfer_unreviewed_triggers(),
    'statement_timeout', current_setting('statement_timeout'),
    'online_employees', (SELECT count(*) FROM public.users
      WHERE archived_at IS NULL AND is_active AND last_heartbeat_at > now() - interval '3 minutes'),
    'employees', (SELECT count(*) FROM public.users WHERE archived_at IS NULL),
    'retention', private.employee_transfer_retention(),
    'admins', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', admin.id, 'username', admin.username,
      'role', admin.role, 'is_active', admin.is_active) ORDER BY admin.username) FROM public.admins AS admin), '[]'::jsonb),
    'groups', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', dispatch_group.id, 'name', dispatch_group.group_name,
      'is_active', dispatch_group.is_active, 'archived', dispatch_group.archived_at IS NOT NULL)
      ORDER BY dispatch_group.group_name) FROM public.dispatch_groups AS dispatch_group), '[]'::jsonb),
    'running_job', (SELECT to_jsonb(job) FROM (SELECT item.kind, item.admin_username, item.started_at, item.last_activity_at
      FROM private.employee_transfer_jobs AS item WHERE item.status = 'running'
        AND item.last_activity_at > now() - interval '3 hours' LIMIT 1) AS job));
END;
$$;

CREATE FUNCTION private.employee_transfer_mapped_admin(p_job private.employee_transfer_jobs, p_old_admin uuid)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp AS $$
  SELECT COALESCE(
    CASE WHEN p_old_admin IS NULL THEN NULL
      ELSE NULLIF(p_job.admin_map ->> p_old_admin::text, '')::uuid END,
    p_job.default_admin_id);
$$;

-- Dry run: classifies every exported employee and proposes the chat-role mapping. Read only.
CREATE FUNCTION public.get_employee_import_dry_run(
  p_admin_session_token uuid, p_manifest jsonb, p_decisions jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE
  v_site uuid;
  v_admin_map jsonb := COALESCE(p_decisions -> 'admin_map', '{}'::jsonb);
  v_group_map jsonb := COALESCE(p_decisions -> 'group_map', '{}'::jsonb);
  v_default_admin uuid := NULLIF(p_decisions ->> 'default_admin_id', '')::uuid;
  v_admins jsonb; v_groups jsonb; v_employees jsonb; v_roles jsonb; v_blockers jsonb := '[]'::jsonb;
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  SELECT site_id INTO v_site FROM private.employee_transfer_site;
  IF jsonb_typeof(p_manifest -> 'employees') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'The export manifest has no employee list.';
  END IF;

  -- Old administrators referenced by employees and chat roles, with candidates by username.
  WITH old_admins AS (
    SELECT DISTINCT old.id, old.username FROM (
      SELECT e.created_by AS id, e.created_by_username AS username
      FROM jsonb_to_recordset(p_manifest -> 'employees') AS e(created_by uuid, created_by_username text)
      UNION
      SELECT c.admin_id, c.admin_username
      FROM jsonb_to_recordset(COALESCE(p_manifest -> 'customers', '[]'::jsonb)) AS c(admin_id uuid, admin_username text)
    ) AS old WHERE old.id IS NOT NULL)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'old_id', old_admins.id, 'old_username', old_admins.username,
    'proposed_id', COALESCE(NULLIF(v_admin_map ->> old_admins.id::text, '')::uuid,
      (SELECT admin.id FROM public.admins AS admin WHERE admin.username = old_admins.username AND admin.is_active LIMIT 1)),
    'candidates', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', admin.id, 'username', admin.username, 'role', admin.role))
      FROM public.admins AS admin WHERE admin.username = old_admins.username AND admin.is_active), '[]'::jsonb))
    ORDER BY old_admins.username), '[]'::jsonb) INTO v_admins FROM old_admins;

  WITH old_groups AS (
    SELECT DISTINCT e.group_id AS id, e.group_name AS name
    FROM jsonb_to_recordset(p_manifest -> 'employees') AS e(group_id uuid, group_name text)
    WHERE e.group_id IS NOT NULL)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'old_id', old_groups.id, 'name', old_groups.name,
    'proposed_id', CASE WHEN v_group_map ? old_groups.id::text THEN NULLIF(v_group_map ->> old_groups.id::text, '')::uuid
      WHEN (SELECT count(*) FROM public.dispatch_groups AS dispatch_group WHERE dispatch_group.group_name = old_groups.name
        AND dispatch_group.is_active AND dispatch_group.archived_at IS NULL) = 1
        THEN (SELECT dispatch_group.id FROM public.dispatch_groups AS dispatch_group WHERE dispatch_group.group_name = old_groups.name
          AND dispatch_group.is_active AND dispatch_group.archived_at IS NULL) END,
    'candidates', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', dispatch_group.id, 'name', dispatch_group.group_name))
      FROM public.dispatch_groups AS dispatch_group WHERE dispatch_group.group_name = old_groups.name
        AND dispatch_group.is_active AND dispatch_group.archived_at IS NULL), '[]'::jsonb))
    ORDER BY old_groups.name), '[]'::jsonb) INTO v_groups FROM old_groups;

  WITH incoming AS (
    SELECT e.* FROM jsonb_to_recordset(p_manifest -> 'employees') AS e(
      id uuid, username text, employee_id text, created_by uuid, created_by_username text,
      group_id uuid, group_name text, is_active boolean)),
  classified AS (
    SELECT incoming.*,
      same_id.id AS same_id_user, same_id.username AS same_id_username,
      same_name.id AS same_name_user, same_name.archived_at AS same_name_archived,
      same_number.id AS same_number_user,
      admin_clash.id AS admin_clash_id,
      COALESCE(NULLIF(v_admin_map ->> incoming.created_by::text, '')::uuid, v_default_admin,
        (SELECT admin.id FROM public.admins AS admin WHERE admin.username = incoming.created_by_username AND admin.is_active LIMIT 1)) AS mapped_admin
    FROM incoming
    LEFT JOIN public.users AS same_id ON same_id.id = incoming.id
    LEFT JOIN public.users AS same_name ON same_name.username = incoming.username
    LEFT JOIN public.users AS same_number ON same_number.employee_id = incoming.employee_id
    LEFT JOIN public.admins AS admin_clash ON admin_clash.username = incoming.username)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', classified.id, 'username', classified.username, 'employee_id', classified.employee_id,
    'admin_id', classified.mapped_admin,
    'action', CASE
      WHEN classified.same_id_user IS NOT NULL THEN 'skip'
      WHEN classified.admin_clash_id IS NOT NULL THEN 'skip'
      WHEN classified.same_name_archived IS NOT NULL THEN 'skip'
      WHEN classified.same_number_user IS NOT NULL AND classified.same_number_user IS DISTINCT FROM classified.same_name_user THEN 'skip'
      WHEN classified.mapped_admin IS NULL THEN 'skip'
      WHEN classified.same_name_user IS NOT NULL THEN 'replace'
      ELSE 'new' END,
    'resumable', classified.same_id_user IS NOT NULL AND classified.same_id_username = classified.username AND EXISTS (
      SELECT 1 FROM public.users AS pending WHERE pending.id = classified.same_id_user AND NOT pending.is_active
        AND EXISTS (SELECT 1 FROM private.employee_transfer_events AS core_event
          WHERE core_event.action = 'import_core' AND core_event.details ->> 'employee_id' = classified.same_id_user::text)
        AND NOT EXISTS (SELECT 1 FROM private.employee_transfer_events AS done_event
          WHERE done_event.action = 'import_finalize' AND done_event.details ->> 'employee_id' = classified.same_id_user::text
            AND (done_event.details ->> 'ok')::boolean)),
    'reason', CASE
      WHEN classified.same_id_user IS NOT NULL AND classified.same_id_username = classified.username THEN 'already_present'
      WHEN classified.same_id_user IS NOT NULL THEN 'id_conflict'
      WHEN classified.admin_clash_id IS NOT NULL THEN 'username_matches_admin'
      WHEN classified.same_name_archived IS NOT NULL THEN 'archived_username_conflict'
      WHEN classified.same_number_user IS NOT NULL AND classified.same_number_user IS DISTINCT FROM classified.same_name_user THEN 'employee_number_conflict'
      WHEN classified.mapped_admin IS NULL THEN 'admin_unmapped'
      WHEN classified.same_name_user IS NOT NULL THEN 'same_username'
      ELSE 'new' END,
    'existing', CASE WHEN classified.same_name_user IS NOT NULL AND classified.same_name_archived IS NULL THEN (
      SELECT jsonb_build_object('id', existing.id, 'employee_id', existing.employee_id, 'is_active', existing.is_active,
        'admin_username', (SELECT username FROM public.admins WHERE id = existing.created_by),
        'available_balance', wallet.available_balance, 'frozen_balance', wallet.frozen_balance,
        'pending_withdrawals', (SELECT count(*) FROM public.withdrawals WHERE user_id = existing.id AND status = 'pending'),
        'pending_amount', (SELECT COALESCE(sum(amount), 0) FROM public.withdrawals WHERE user_id = existing.id AND status = 'pending'),
        'orders', (SELECT count(*) FROM public.orders WHERE user_id = existing.id),
        'chat_messages', (SELECT count(*) FROM public.customer_employee_conversations WHERE employee_id = existing.id),
        'last_login', (SELECT max(created_at) FROM public.employee_login_history
          WHERE user_id = existing.id AND action_type = 'login'))
      FROM public.users AS existing LEFT JOIN public.wallets AS wallet ON wallet.user_id = existing.id
      WHERE existing.id = classified.same_name_user) END)
    ORDER BY classified.username), '[]'::jsonb) INTO v_employees FROM classified;

  -- Chat roles are matched inside the mapped administrator and the same service type only.
  WITH incoming AS (
    SELECT c.* FROM jsonb_to_recordset(COALESCE(p_manifest -> 'customers', '[]'::jsonb)) AS c(
      id uuid, admin_id uuid, admin_username text, customer_name text, customer_id text, source_type text)),
  mapped AS (
    SELECT incoming.*, COALESCE(NULLIF(v_admin_map ->> incoming.admin_id::text, '')::uuid, v_default_admin,
      (SELECT admin.id FROM public.admins AS admin WHERE admin.username = incoming.admin_username AND admin.is_active LIMIT 1)) AS new_admin
    FROM incoming),
  proposals AS (
    SELECT mapped.id AS old_id, mapped.customer_name, mapped.customer_id, mapped.source_type, mapped.admin_username, mapped.new_admin,
      (SELECT jsonb_agg(jsonb_build_object('id', target.id, 'customer_id', target.customer_id,
          'customer_name', target.customer_name, 'restricted', target.target_employee_ids IS NOT NULL
            AND cardinality(target.target_employee_ids) > 0) ORDER BY target.customer_name, target.customer_id)
        FROM public.simulated_customers AS target
        WHERE target.admin_id = mapped.new_admin AND target.source_type = mapped.source_type
          AND (target.customer_name = mapped.customer_name OR target.customer_id = mapped.customer_id)) AS candidates,
      (SELECT target.id FROM public.simulated_customers AS target
        WHERE target.admin_id = mapped.new_admin AND target.source_type = mapped.source_type
          AND target.customer_name = mapped.customer_name AND target.customer_id = mapped.customer_id LIMIT 1) AS exact_id,
      (SELECT count(*) FROM public.simulated_customers AS target
        WHERE target.admin_id = mapped.new_admin AND target.source_type = mapped.source_type
          AND target.customer_name = mapped.customer_name) AS same_name_count,
      (SELECT target.id FROM public.simulated_customers AS target
        WHERE target.admin_id = mapped.new_admin AND target.source_type = mapped.source_type
          AND target.customer_name = mapped.customer_name ORDER BY target.id LIMIT 1) AS only_name_id,
      EXISTS (SELECT 1 FROM public.simulated_customers AS taken WHERE taken.customer_id = mapped.customer_id) AS display_id_taken
    FROM mapped),
  decided AS (
    SELECT proposals.*,
      CASE WHEN proposals.new_admin IS NULL THEN 'unmapped'
        WHEN proposals.exact_id IS NOT NULL THEN 'merge'
        WHEN proposals.same_name_count = 1 THEN 'merge'
        WHEN proposals.same_name_count > 1 THEN 'choose'
        WHEN proposals.candidates IS NOT NULL THEN 'choose'
        ELSE 'new' END AS action,
      CASE WHEN proposals.exact_id IS NOT NULL THEN proposals.exact_id
        WHEN proposals.same_name_count = 1 THEN proposals.only_name_id END AS target_id,
      CASE WHEN proposals.exact_id IS NOT NULL THEN 'id_and_name'
        WHEN proposals.same_name_count = 1 THEN 'name'
        WHEN proposals.same_name_count > 1 THEN 'ambiguous_name'
        WHEN proposals.candidates IS NOT NULL THEN 'id_only' END AS basis
    FROM proposals)
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'old_id', decided.old_id, 'customer_name', decided.customer_name, 'customer_id', decided.customer_id,
    'source_type', decided.source_type, 'admin_username', decided.admin_username, 'new_admin_id', decided.new_admin,
    'action', decided.action, 'target_id', decided.target_id, 'basis', decided.basis,
    'candidates', COALESCE(decided.candidates, '[]'::jsonb),
    'restricted', COALESCE((SELECT target.target_employee_ids IS NOT NULL AND cardinality(target.target_employee_ids) > 0
      FROM public.simulated_customers AS target WHERE target.id = decided.target_id), false),
    'display_id_taken', decided.display_id_taken,
    'shared_with', COALESCE((SELECT jsonb_agg(other.old_id) FROM decided AS other
      WHERE decided.target_id IS NOT NULL AND other.target_id = decided.target_id AND other.old_id <> decided.old_id), '[]'::jsonb))
    ORDER BY decided.customer_name, decided.old_id), '[]'::jsonb) INTO v_roles FROM decided;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_employees) AS item WHERE item ->> 'reason' = 'admin_unmapped') THEN
    v_blockers := v_blockers || to_jsonb('Some employees belong to an administrator that is not mapped to this site.'::text);
  END IF;

  RETURN jsonb_build_object(
    'site_id', v_site,
    'same_site', NULLIF(p_manifest ->> 'source_site_id', '')::uuid IS NOT DISTINCT FROM v_site,
    'admins', v_admins, 'groups', v_groups, 'employees', v_employees, 'roles', v_roles,
    'blockers', v_blockers,
    'retention', private.employee_transfer_retention(),
    'unreviewed_triggers', private.employee_transfer_unreviewed_triggers(),
    'schema_fingerprint', private.employee_transfer_schema_fingerprint(),
    'statement_timeout', current_setting('statement_timeout'));
END;
$$;

CREATE FUNCTION public.employee_import_begin(
  p_admin_session_token uuid, p_admin_password text, p_decisions jsonb, p_summary jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE
  v_admin_map jsonb := COALESCE(p_decisions -> 'admin_map', '{}'::jsonb);
  v_group_map jsonb := COALESCE(p_decisions -> 'group_map', '{}'::jsonb);
  v_default_admin uuid := NULLIF(p_decisions ->> 'default_admin_id', '')::uuid;
  v_site uuid; v_result jsonb; v_job_id uuid; v_product uuid;
BEGIN
  PERFORM 1 FROM private.employee_transfer_admin(p_admin_session_token);
  SELECT site_id INTO v_site FROM private.employee_transfer_site;
  IF NULLIF(p_summary ->> 'source_site_id', '')::uuid IS NOT DISTINCT FROM v_site THEN
    RAISE EXCEPTION 'The export file was created by this same site and cannot be imported into it.';
  END IF;
  PERFORM private.employee_transfer_assert_triggers_reviewed();
  IF v_default_admin IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.admins WHERE id = v_default_admin AND is_active) THEN
    RAISE EXCEPTION 'The default administrator does not exist on this site.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(v_admin_map) AS entry(old_id, new_id)
      WHERE NULLIF(entry.new_id, '') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.admins WHERE id = entry.new_id::uuid AND is_active)) THEN
    RAISE EXCEPTION 'An administrator mapping points to an administrator that does not exist on this site.';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_each_text(v_group_map) AS entry(old_id, new_id)
      WHERE NULLIF(entry.new_id, '') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.dispatch_groups WHERE id = entry.new_id::uuid AND archived_at IS NULL)) THEN
    RAISE EXCEPTION 'A dispatch group mapping points to a group that does not exist on this site.';
  END IF;

  v_result := private.employee_transfer_start_job(p_admin_session_token, p_admin_password, 'import',
    COALESCE(p_summary, '{}'::jsonb), v_admin_map, v_group_map, v_default_admin);
  IF NOT COALESCE((v_result ->> 'success')::boolean, false) THEN RETURN v_result; END IF;
  v_job_id := (v_result ->> 'job_id')::uuid;

  SELECT id INTO v_product FROM public.product_types WHERE name = '舊站匯入（精簡訂單）';
  IF v_product IS NULL THEN
    INSERT INTO public.product_types (name, is_active) VALUES ('舊站匯入（精簡訂單）', false) RETURNING id INTO v_product;
  ELSIF EXISTS (SELECT 1 FROM public.product_types WHERE id = v_product AND is_active) THEN
    RAISE EXCEPTION 'The placeholder product for imported orders must stay disabled.';
  END IF;
  UPDATE private.employee_transfer_jobs SET placeholder_product_id = v_product WHERE id = v_job_id;
  RETURN v_result || jsonb_build_object('placeholder_product_id', v_product);
END;
$$;

-- Creates or merges the chat roles the administrator decided on. Decision shape:
-- { old_id, action: 'merge' | 'new', target_id, make_visible } plus the exported role row.
CREATE FUNCTION public.employee_import_apply_roles(
  p_admin_session_token uuid, p_job_token uuid, p_decisions jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, private, pg_temp
SET statement_timeout = '120s' AS $$
DECLARE
  v_job private.employee_transfer_jobs%ROWTYPE;
  v_item jsonb; v_old uuid; v_action text; v_target uuid; v_admin uuid; v_role public.simulated_customers%ROWTYPE;
  v_new uuid; v_display text; v_results jsonb := '[]'::jsonb; v_map jsonb;
  v_targets uuid[];
BEGIN
  v_job := private.employee_transfer_job(p_admin_session_token, p_job_token, 'import');
  IF jsonb_typeof(p_decisions) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Role decisions must be a list.'; END IF;
  v_map := v_job.role_map;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_decisions)
  LOOP
    v_old := (v_item ->> 'old_id')::uuid;
    v_action := v_item ->> 'action';
    IF v_map ? v_old::text THEN
      v_results := v_results || jsonb_build_array(v_map -> v_old::text || jsonb_build_object('old_id', v_old, 'repeated', true));
      CONTINUE;
    END IF;
    v_admin := private.employee_transfer_mapped_admin(v_job, NULLIF(v_item #>> '{role,admin_id}', '')::uuid);
    IF v_admin IS NULL THEN
      RAISE EXCEPTION 'The administrator of chat role % is not mapped.', COALESCE(v_item #>> '{role,customer_name}', v_old::text);
    END IF;

    IF v_action = 'merge' THEN
      v_target := (v_item ->> 'target_id')::uuid;
      SELECT * INTO v_role FROM public.simulated_customers WHERE id = v_target;
      IF v_role.id IS NULL OR v_role.admin_id IS DISTINCT FROM v_admin
        OR v_role.source_type IS DISTINCT FROM (v_item #>> '{role,source_type}') THEN
        RAISE EXCEPTION 'Chat role % cannot be merged into the selected role.', COALESCE(v_item #>> '{role,customer_name}', v_old::text);
      END IF;
      v_map := v_map || jsonb_build_object(v_old::text, jsonb_build_object(
        'new_id', v_target, 'merged', true, 'created', false, 'admin_id', v_admin,
        'make_visible', COALESCE((v_item ->> 'make_visible')::boolean, true),
        'old_targets', COALESCE(v_item #> '{role,target_employee_ids}', '[]'::jsonb)));
    ELSIF v_action = 'new' THEN
      SELECT * INTO v_role FROM public.simulated_customers WHERE id = v_old;
      IF v_role.id IS NOT NULL AND v_role.admin_id = v_admin AND v_role.source_type = (v_item #>> '{role,source_type}')
        AND v_role.customer_name = (v_item #>> '{role,customer_name}') THEN
        v_new := v_role.id;
        v_map := v_map || jsonb_build_object(v_old::text, jsonb_build_object(
          'new_id', v_new, 'merged', false, 'created', false, 'admin_id', v_admin,
          'make_visible', false, 'old_targets', COALESCE(v_item #> '{role,target_employee_ids}', '[]'::jsonb)));
      ELSE
        v_new := CASE WHEN v_role.id IS NULL THEN v_old ELSE gen_random_uuid() END;
        v_display := v_item #>> '{role,customer_id}';
        IF v_display IS NOT NULL AND EXISTS (SELECT 1 FROM public.simulated_customers WHERE customer_id = v_display) THEN
          v_display := NULL;
        END IF;
        SELECT COALESCE(array_agg(entry.value::uuid), '{}') INTO v_targets
        FROM jsonb_array_elements_text(COALESCE(v_item #> '{role,target_employee_ids}', '[]'::jsonb)) AS entry(value);
        INSERT INTO public.simulated_customers (
          id, admin_id, customer_name, customer_avatar, is_active, customer_id, is_super, super_customer_title,
          badge_type, custom_avatar_url, is_pinned, vip_label, remarks, source_type, employee_pin_top,
          employee_always_visible, target_employee_id, target_employee_ids, auto_messages_enabled)
        VALUES (
          v_new, v_admin, v_item #>> '{role,customer_name}', COALESCE(v_item #>> '{role,customer_avatar}', '👤'),
          COALESCE((v_item #>> '{role,is_active}')::boolean, true), v_display,
          COALESCE((v_item #>> '{role,is_super}')::boolean, false), v_item #>> '{role,super_customer_title}',
          v_item #>> '{role,badge_type}', v_item #>> '{role,custom_avatar_url}',
          COALESCE((v_item #>> '{role,is_pinned}')::boolean, false), COALESCE(v_item #>> '{role,vip_label}', 'VIP'),
          v_item #>> '{role,remarks}', v_item #>> '{role,source_type}',
          COALESCE((v_item #>> '{role,employee_pin_top}')::boolean, false),
          COALESCE((v_item #>> '{role,employee_always_visible}')::boolean, false),
          (SELECT user_row.id FROM public.users AS user_row WHERE user_row.id = NULLIF(v_item #>> '{role,target_employee_id}', '')::uuid),
          NULLIF(v_targets, '{}'), COALESCE((v_item #>> '{role,auto_messages_enabled}')::boolean, false));
        v_map := v_map || jsonb_build_object(v_old::text, jsonb_build_object(
          'new_id', v_new, 'merged', false, 'created', true, 'admin_id', v_admin,
          'make_visible', false, 'old_targets', COALESCE(v_item #> '{role,target_employee_ids}', '[]'::jsonb),
          'old_target', v_item #>> '{role,target_employee_id}',
          'display_id_changed', v_display IS DISTINCT FROM (v_item #>> '{role,customer_id}')));
      END IF;
    ELSE
      RAISE EXCEPTION 'Unsupported chat role decision: %', v_action;
    END IF;
    v_results := v_results || jsonb_build_array(v_map -> v_old::text || jsonb_build_object('old_id', v_old));
  END LOOP;

  UPDATE private.employee_transfer_jobs SET role_map = v_map WHERE id = v_job.id;
  PERFORM private.employee_transfer_log(v_job.id, v_job.admin_id, v_job.admin_username, 'import', 'import_roles',
    jsonb_build_object('roles', jsonb_array_length(v_results)));
  RETURN jsonb_build_object('success', true, 'roles', v_results);
END;
$$;

REVOKE ALL ON FUNCTION private.employee_transfer_mapped_admin(private.employee_transfer_jobs, uuid) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_employee_import_capabilities(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_import_dry_run(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_import_begin(uuid, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.employee_import_apply_roles(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_import_capabilities(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_import_dry_run(uuid, jsonb, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_begin(uuid, text, jsonb, jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.employee_import_apply_roles(uuid, uuid, jsonb) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
