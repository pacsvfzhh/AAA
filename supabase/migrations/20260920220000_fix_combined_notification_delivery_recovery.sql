SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE OR REPLACE FUNCTION public.claim_next_realtime_notification_delivery(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_recipient public.message_recipients%ROWTYPE;
  v_message public.messages%ROWTYPE;
  v_claim_token uuid := gen_random_uuid();
  v_lease_seconds integer := LEAST(GREATEST(COALESCE(p_lease_seconds, 120), 30), 300);
BEGIN
  IF NOT public.validate_employee_session(p_user_id, p_session_token, p_tab_id) THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;

  WITH candidate AS (
    SELECT recipient.id
    FROM public.message_recipients AS recipient
    JOIN public.messages AS message ON message.id = recipient.message_id
    WHERE recipient.recipient_id = p_user_id
      AND recipient.delivery_channel IS NULL
      AND (recipient.delivery_claim_token IS NULL OR recipient.delivery_claim_until <= clock_timestamp())
      AND (message.expires_at IS NULL OR message.expires_at > clock_timestamp())
      AND message.delivery_mode IN ('realtime_only', 'realtime_with_login_fallback')
    ORDER BY recipient.delivery_sequence
    LIMIT 1
    FOR UPDATE OF recipient SKIP LOCKED
  )
  UPDATE public.message_recipients AS recipient
  SET delivery_claim_token = v_claim_token,
      delivery_claim_channel = 'realtime',
      delivery_claim_until = clock_timestamp() + make_interval(secs => v_lease_seconds)
  FROM candidate
  WHERE recipient.id = candidate.id
  RETURNING recipient.* INTO v_recipient;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_message
  FROM public.messages
  WHERE id = v_recipient.message_id;

  RETURN jsonb_build_object(
    'claim_token', v_claim_token,
    'recipient', to_jsonb(v_recipient),
    'message', to_jsonb(v_message)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_next_realtime_notification_delivery(uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_realtime_notification_delivery(uuid, uuid, text, integer) TO anon, authenticated;
