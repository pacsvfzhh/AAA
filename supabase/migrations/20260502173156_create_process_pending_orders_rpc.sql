/*
  # Process Pending Orders via RPC

  1. Purpose
     - Move the order-processing logic out of the process-orders Edge Function
       into a regular Postgres function callable via supabase.rpc().
     - Goal: the system no longer depends on Edge Functions, so cloning the
       database (pg_dump/restore) is enough to fully replicate behavior.

  2. Behavior
     - Scans orders with status = 'processing' that are at least 3 minutes old.
     - For each order, reads commission_rate and success_rate from admin_configs
       (admin-specific value overrides global default; admin_id IS NULL is global).
     - Uses a pseudo-random draw to decide success/failure.
     - On success: creates a wallet_transactions row (commission), increments the
       wallet balance, updates user total_income and first_success_order_date.
     - All updates for a single order are performed atomically inside the function.

  3. Security
     - SECURITY DEFINER so employees (anon/authenticated) can execute it without
       owning the underlying tables.
     - search_path is pinned to public.
     - Execute permission granted to anon and authenticated roles so the frontend
       polling loop can call it.
*/

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
      AND created_at < now() - interval '3 minutes'
    ORDER BY created_at ASC
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
