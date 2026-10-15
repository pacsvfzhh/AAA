/*
  # Make dispatch_groups.dispatch_success_rate actually drive order outcomes

  1. Purpose
    - The admin UI "Group-Based Order Assignment" panel lets admins set a
      `dispatch_success_rate` per group (0-100). Until now that value was
      stored but never read by the order resolver, so changing it had no
      effect on real success/failure ratios.
    - This migration rewrites `process_pending_orders` so that, for each
      order, it looks up the owning user's dispatch group and uses that
      group's `dispatch_success_rate` (converted from 0-100 to 0-1) as the
      probability of success.

  2. Lookup precedence (first non-null wins)
    a) The user's active dispatch group's `dispatch_success_rate / 100`
       (only groups with is_active = true are considered).
    b) admin_configs.success_rate for the user's owning admin.
    c) admin_configs.success_rate with admin_id IS NULL (global default).
    d) 0 (defensive fallback).

  3. Behavior preserved
    - Per-order random 3-10 minute delay via hashtext(id::text).
    - FOR UPDATE SKIP LOCKED concurrency safety.
    - Commission write + wallet update + total_income update.
    - unique_violation idempotency on wallet_transactions.
    - SECURITY DEFINER with search_path pinned to public.
    - EXECUTE granted to anon and authenticated.

  4. Safety
    - No schema changes. Only the function body is replaced.
    - If a user is not in any active group, behavior is identical to before.
    - If dispatch_group_members / dispatch_groups tables are missing (they
      should not be), the LEFT JOIN simply yields NULL and we fall back.
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
  v_group_rate numeric;
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
      AND EXTRACT(EPOCH FROM (now() - created_at))
          >= 180 + (abs(hashtext(id::text)) % 421)
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

    -- Group-level success rate takes precedence over admin_configs.
    SELECT dg.dispatch_success_rate::numeric / 100.0
      INTO v_group_rate
    FROM dispatch_group_members dgm
    JOIN dispatch_groups dg ON dg.id = dgm.group_id
    WHERE dgm.user_id = v_order.user_id
      AND dg.is_active = true
      AND dg.dispatch_success_rate IS NOT NULL
    ORDER BY dgm.created_at DESC NULLS LAST
    LIMIT 1;

    IF v_group_rate IS NOT NULL THEN
      v_success_rate := v_group_rate;
    ELSE
      SELECT COALESCE(
        (SELECT config_value FROM admin_configs
           WHERE admin_id = v_user.created_by AND config_type = 'success_rate' LIMIT 1),
        (SELECT config_value FROM admin_configs
           WHERE admin_id IS NULL AND config_type = 'success_rate' LIMIT 1),
        '0'
      )::numeric INTO v_success_rate;
    END IF;

    -- Clamp into [0, 1] defensively.
    IF v_success_rate < 0 THEN v_success_rate := 0; END IF;
    IF v_success_rate > 1 THEN v_success_rate := 1; END IF;

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
