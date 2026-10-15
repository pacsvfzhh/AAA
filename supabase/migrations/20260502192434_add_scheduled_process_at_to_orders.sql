/*
  # Add scheduled_process_at for true-random order processing delay

  1. Schema changes
     - Add `orders.scheduled_process_at` (timestamptz, nullable).
     - On INSERT, a trigger sets it to `created_at + random(180..600) seconds`.
     - This gives each order an independent, uniformly random 3-10 min delay,
       replacing the hashtext-derived value that could cluster for some users.

  2. Compatibility
     - Column is nullable. Existing rows keep NULL.
     - Backfill existing `status = 'processing'` rows using the same
       hashtext formula that was previously used, so their target time
       does not change.
     - `process_pending_orders()` is updated to:
         a) Pick up rows where `scheduled_process_at <= now()`.
         b) Fall back to the old hashtext gate when `scheduled_process_at IS NULL`
            (covers any edge case / historical rows left in 'processing').

  3. Performance
     - Partial index on (scheduled_process_at) WHERE status = 'processing'
       so the cron query stays cheap.

  4. Security
     - Function remains SECURITY DEFINER with search_path pinned.
     - EXECUTE re-granted to anon, authenticated.
*/

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS scheduled_process_at timestamptz;

CREATE OR REPLACE FUNCTION public.set_order_scheduled_process_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.scheduled_process_at IS NULL THEN
    NEW.scheduled_process_at :=
      COALESCE(NEW.created_at, now())
      + make_interval(secs => 180 + floor(random() * 421)::int);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_order_scheduled_process_at ON orders;
CREATE TRIGGER trg_set_order_scheduled_process_at
  BEFORE INSERT ON orders
  FOR EACH ROW
  EXECUTE FUNCTION public.set_order_scheduled_process_at();

UPDATE orders
   SET scheduled_process_at =
       created_at + make_interval(secs => 180 + (abs(hashtext(id::text)) % 421))
 WHERE scheduled_process_at IS NULL
   AND status = 'processing';

CREATE INDEX IF NOT EXISTS idx_orders_processing_scheduled
  ON orders (scheduled_process_at)
  WHERE status = 'processing';

CREATE OR REPLACE FUNCTION public.process_pending_orders()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order RECORD;
  v_user RECORD;
  v_wallet RECORD;
  v_commission_rate numeric;
  v_success_rate numeric;
  v_is_success boolean;
  v_status text;
  v_commission_amount numeric;
  v_new_balance numeric;
  v_success_count int := 0;
  v_failure_count int := 0;
  v_skipped int := 0;
BEGIN
  FOR v_order IN
    SELECT id, user_id, product_value, status, created_at
    FROM orders
    WHERE status = 'processing'
      AND (
        (scheduled_process_at IS NOT NULL AND scheduled_process_at <= now())
        OR (
          scheduled_process_at IS NULL
          AND EXTRACT(EPOCH FROM (now() - created_at))
              >= 180 + (abs(hashtext(id::text)) % 421)
        )
      )
    ORDER BY COALESCE(scheduled_process_at, created_at) ASC
    LIMIT 200
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT id, created_by, total_income, first_success_order_date
      INTO v_user
    FROM users
    WHERE id = v_order.user_id;

    IF v_user.id IS NULL THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    SELECT COALESCE(
      (SELECT config_value FROM admin_configs
         WHERE admin_id = v_user.created_by AND config_type = 'commission_rate' LIMIT 1),
      (SELECT config_value FROM admin_configs
         WHERE admin_id IS NULL AND config_type = 'commission_rate' LIMIT 1),
      '0'
    )::numeric INTO v_commission_rate;

    SELECT COALESCE(
      (SELECT config_value FROM admin_configs
         WHERE admin_id = v_user.created_by AND config_type = 'success_rate' LIMIT 1),
      (SELECT config_value FROM admin_configs
         WHERE admin_id IS NULL AND config_type = 'success_rate' LIMIT 1),
      '0'
    )::numeric INTO v_success_rate;

    v_is_success := random() < v_success_rate;
    v_status := CASE WHEN v_is_success THEN 'success' ELSE 'failure' END;
    v_commission_amount := CASE WHEN v_is_success THEN v_order.product_value * v_commission_rate ELSE NULL END;

    UPDATE orders
       SET status = v_status,
           commission_rate = v_commission_rate,
           commission_amount = v_commission_amount,
           processed_at = now()
     WHERE id = v_order.id AND status = 'processing';

    IF NOT FOUND THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    IF v_is_success THEN
      SELECT user_id, available_balance, frozen_balance
        INTO v_wallet
      FROM wallets
      WHERE user_id = v_order.user_id
      FOR UPDATE;

      IF v_wallet.user_id IS NULL THEN
        INSERT INTO wallets (user_id, available_balance, frozen_balance)
        VALUES (v_order.user_id, 0, 0)
        RETURNING user_id, available_balance, frozen_balance INTO v_wallet;
      END IF;

      v_new_balance := v_wallet.available_balance + v_commission_amount;

      BEGIN
        INSERT INTO wallet_transactions (
          user_id, type, amount, balance_before, balance_after, reference_id, remarks
        ) VALUES (
          v_order.user_id, 'commission', v_commission_amount,
          v_wallet.available_balance, v_new_balance, v_order.id,
          'Commission from order ' || v_order.id::text
        );
      EXCEPTION WHEN unique_violation THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END;

      UPDATE wallets
         SET available_balance = v_new_balance,
             updated_at = now()
       WHERE user_id = v_order.user_id;

      UPDATE users
         SET total_income = COALESCE(total_income, 0) + v_commission_amount,
             first_success_order_date = COALESCE(first_success_order_date, now())
       WHERE id = v_order.user_id;

      v_success_count := v_success_count + 1;
    ELSE
      v_failure_count := v_failure_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'success', v_success_count,
    'failure', v_failure_count,
    'skipped', v_skipped
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.process_pending_orders() TO anon, authenticated;
