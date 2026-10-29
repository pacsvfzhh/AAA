BEGIN;

DO $block$
DECLARE
  v_patch record;
  v_source text;
BEGIN
  FOR v_patch IN
    SELECT * FROM (VALUES
      (
        'public.send_admin_message_secure(uuid,uuid[],text,text,text,text,numeric,uuid)',
        $old$IF char_length(trim(COALESCE(p_content, ''))) NOT BETWEEN 1 AND 5000 THEN
    RAISE EXCEPTION 'Message content must contain between 1 and 5000 characters.';$old$,
        $new$IF char_length(trim(COALESCE(p_content, ''))) = 0 THEN
    RAISE EXCEPTION 'Message content must not be empty.';$new$
      ),
      (
        'public.commit_content_audit_change(uuid,text,uuid[],uuid,text,jsonb,uuid,jsonb)',
        $old$char_length(trim(COALESCE(p_payload ->> 'content', ''))) NOT BETWEEN 1 AND 100000$old$,
        $new$char_length(trim(COALESCE(p_payload ->> 'content', ''))) = 0$new$
      )
    ) AS patches(signature, old_text, new_text)
  LOOP
    SELECT pg_get_functiondef(to_regprocedure(v_patch.signature)) INTO v_source;
    IF v_source IS NULL
       OR (length(v_source) - length(replace(v_source, v_patch.old_text, ''))) / length(v_patch.old_text) <> 1 THEN
      RAISE EXCEPTION 'Content validation changed; review % before removing the limit.', v_patch.signature;
    END IF;
    EXECUTE replace(v_source, v_patch.old_text, v_patch.new_text);
  END LOOP;
END;
$block$;

ALTER TABLE public.messages
  DROP CONSTRAINT messages_content_length,
  ADD CONSTRAINT messages_content_length CHECK (char_length(content) > 0);

ALTER TABLE public.notification_automation_tasks
  DROP CONSTRAINT notification_automation_tasks_content_template_check,
  ADD CONSTRAINT notification_automation_tasks_content_template_check
    CHECK (char_length(trim(content_template)) >= 1);

COMMIT;
