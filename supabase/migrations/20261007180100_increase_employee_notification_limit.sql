CREATE OR REPLACE FUNCTION public.get_employee_notification_messages(
  p_user_id uuid,
  p_session_token uuid,
  p_tab_id text,
  p_filter text DEFAULT 'all',
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
DECLARE
  v_result jsonb;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 300);
BEGIN
  IF NOT public.validate_employee_session(p_user_id, p_session_token, p_tab_id) THEN
    RAISE EXCEPTION 'Employee session is invalid or expired.';
  END IF;
  IF p_filter NOT IN ('all', 'unread', 'login', 'realtime') THEN
    RAISE EXCEPTION 'Unsupported notification filter.';
  END IF;

  SELECT COALESCE(jsonb_agg(entry.payload ORDER BY entry.delivery_sequence DESC), '[]'::jsonb)
  INTO v_result
  FROM (
    SELECT
      recipient.delivery_sequence,
      jsonb_build_object(
        'id', recipient.id,
        'message_id', recipient.message_id,
        'recipient_id', recipient.recipient_id,
        'is_read', recipient.is_read,
        'read_at', recipient.read_at,
        'is_shown', recipient.is_shown,
        'shown_at', recipient.shown_at,
        'delivery_channel', recipient.delivery_channel,
        'delivery_claim_token', NULL,
        'delivery_claim_channel', NULL,
        'delivery_claim_until', NULL,
        'delivery_completed_claim_token', NULL,
        'delivered_at', recipient.delivered_at,
        'delivery_sequence', recipient.delivery_sequence,
        'created_at', recipient.created_at,
        'messages', to_jsonb(message)
      ) AS payload
    FROM public.message_recipients AS recipient
    JOIN public.messages AS message ON message.id = recipient.message_id
    WHERE recipient.recipient_id = p_user_id
      AND (message.expires_at IS NULL OR message.expires_at > clock_timestamp())
      AND (p_filter <> 'unread' OR recipient.is_read = false)
      AND (
        p_filter IN ('all', 'unread')
        OR (
          p_filter = 'login'
          AND (
            recipient.delivery_channel = 'login_popup'
            OR (recipient.delivery_channel IS NULL AND message.delivery_mode = 'login_only')
          )
        )
        OR (
          p_filter = 'realtime'
          AND (
            recipient.delivery_channel = 'realtime'
            OR (recipient.delivery_channel IS NULL AND message.delivery_mode = 'realtime_only')
          )
        )
      )
    ORDER BY recipient.delivery_sequence DESC
    LIMIT v_limit
  ) AS entry;

  RETURN v_result;
END;
$$;
