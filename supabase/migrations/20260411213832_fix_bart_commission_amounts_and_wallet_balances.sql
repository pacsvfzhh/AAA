
/*
  # Fix Bart Members - Correct Commission Amounts & Wallet Balances

  ## Summary
  1. Removes the previously inserted simulation orders (high commission values)
  2. Re-inserts with realistic daily earnings $350-$700
  3. Sets wallet balances to $30,000-$50,000 range
  4. Inserts wallet_transactions commission records
  5. Updates users.total_income

  ## Data Parameters
  - Orders per day: 100-300
  - Success rate: ~70%
  - Daily earnings: $350-$700
  - Wallet balances: $30,000-$50,000
*/

-- Step 1: Enable cleanup mode to allow deletion
SET app.in_user_cleanup = 'true';

-- Step 2: Delete old simulation orders for the 10 Bart members
DELETE FROM orders
WHERE user_id IN (
  'ee6dfe54-24e0-41bb-b472-4c2e2c3ac32b',
  '13f53c1e-b44d-4460-bfaf-4935472baa75',
  '82e12246-b62d-47a1-b3f7-22de790dddcc',
  '406e6b7a-231b-433c-80ea-4db66849bfa2',
  'b631002d-d37b-41e5-b16e-c0962928f94c',
  '1267f9ab-1db3-4420-94dc-00f34dbc4d24',
  '726757e3-8208-450f-a3f9-db9e6c554ee2',
  '43286cff-d572-484e-b7dd-8140c29ac1c9',
  '328eb144-c21e-46e5-b4eb-43d7c70769b9',
  '2e895d14-3b38-4c11-bd53-3080da54d4fc'
)
AND created_at >= (now() - interval '16 days');

-- Step 3: Also delete wallet_transactions for these users from same period
DELETE FROM wallet_transactions
WHERE user_id IN (
  'ee6dfe54-24e0-41bb-b472-4c2e2c3ac32b',
  '13f53c1e-b44d-4460-bfaf-4935472baa75',
  '82e12246-b62d-47a1-b3f7-22de790dddcc',
  '406e6b7a-231b-433c-80ea-4db66849bfa2',
  'b631002d-d37b-41e5-b16e-c0962928f94c',
  '1267f9ab-1db3-4420-94dc-00f34dbc4d24',
  '726757e3-8208-450f-a3f9-db9e6c554ee2',
  '43286cff-d572-484e-b7dd-8140c29ac1c9',
  '328eb144-c21e-46e5-b4eb-43d7c70769b9',
  '2e895d14-3b38-4c11-bd53-3080da54d4fc'
)
AND type = 'commission'
AND created_at >= (now() - interval '16 days');

-- Step 4: Reset cleanup mode
SET app.in_user_cleanup = 'false';

-- Step 5: Insert new orders with correct commission amounts
DO $$
DECLARE
  v_user_ids uuid[] := ARRAY[
    'ee6dfe54-24e0-41bb-b472-4c2e2c3ac32b'::uuid,
    '13f53c1e-b44d-4460-bfaf-4935472baa75'::uuid,
    '82e12246-b62d-47a1-b3f7-22de790dddcc'::uuid,
    '406e6b7a-231b-433c-80ea-4db66849bfa2'::uuid,
    'b631002d-d37b-41e5-b16e-c0962928f94c'::uuid,
    '1267f9ab-1db3-4420-94dc-00f34dbc4d24'::uuid,
    '726757e3-8208-450f-a3f9-db9e6c554ee2'::uuid,
    '43286cff-d572-484e-b7dd-8140c29ac1c9'::uuid,
    '328eb144-c21e-46e5-b4eb-43d7c70769b9'::uuid,
    '2e895d14-3b38-4c11-bd53-3080da54d4fc'::uuid
  ];
  v_usernames text[] := ARRAY[
    'CryptoBart_Tokyo','BartCrypto2026','TokyoTrader_X','NeoBart_HODL','BartChainMaster',
    'TokyoBullRun24','CryptoNomad_Bart','Bart SatoshiWave','TokyoDeFiKing','BartLeveragePro'
  ];
  -- Target final wallet balances $30K-$50K (varied per user)
  v_target_balances numeric[] := ARRAY[
    42500.00, 38750.00, 45200.00, 31800.00, 49300.00,
    36400.00, 43800.00, 33500.00, 47100.00, 40600.00
  ];
  v_pt_ids uuid[] := ARRAY[
    '70f07713-8c89-4f04-857e-3c3a351fe119'::uuid,
    'ffdee979-f3cf-4648-8f8c-8be94da63e88'::uuid,
    '67664dd4-239c-4dfb-b65e-6cf7e37dbc91'::uuid,
    '8165478d-203f-45b8-ad5b-ec33975c8fc4'::uuid,
    '49a220ee-afe8-4e77-96ea-0505af16a850'::uuid
  ];

  v_user_id uuid;
  v_username text;
  v_u integer;
  v_day_offset integer;
  v_day_date timestamptz;
  v_order_count integer;
  v_success_count integer;
  v_fail_count integer;
  v_target_daily_earn numeric;
  v_commission_per_order numeric;
  v_i integer;
  v_order_id uuid;
  v_product_value numeric;
  v_commission_amount numeric;
  v_order_number text;
  v_transaction_id text;
  v_product_type_id uuid;
  v_hour_offset integer;
  v_minute_offset integer;
  v_order_ts timestamptz;
  v_running_balance numeric;
  v_daily_total_commission numeric;
  v_total_earned_13days numeric;
BEGIN
  FOR v_u IN 1..10 LOOP
    v_user_id := v_user_ids[v_u];
    v_username := v_usernames[v_u];
    v_running_balance := v_target_balances[v_u];
    v_total_earned_13days := 0;

    -- First pass: calculate total commissions to earn over 13 days
    -- so we can set balance accurately
    FOR v_day_offset IN REVERSE 13..1 LOOP
      v_order_count := 100 + ((v_u * 17 + v_day_offset * 13) % 201);
      v_success_count := round(v_order_count * (0.68 + ((v_u + v_day_offset) % 5) * 0.01));
      v_target_daily_earn := 350 + ((v_u * 23 + v_day_offset * 17) % 351);
      v_total_earned_13days := v_total_earned_13days + v_target_daily_earn;
    END LOOP;

    -- Insert orders day by day
    FOR v_day_offset IN REVERSE 13..1 LOOP
      v_day_date := date_trunc('day', now() - (v_day_offset || ' days')::interval) + interval '8 hours';

      v_order_count := 100 + ((v_u * 17 + v_day_offset * 13) % 201);
      v_success_count := round(v_order_count * (0.68 + ((v_u + v_day_offset) % 5) * 0.01));
      v_fail_count := v_order_count - v_success_count;
      v_target_daily_earn := 350 + ((v_u * 23 + v_day_offset * 17) % 351);
      v_commission_per_order := round(v_target_daily_earn / GREATEST(v_success_count, 1), 2);

      v_daily_total_commission := 0;

      -- Insert success orders
      FOR v_i IN 1..v_success_count LOOP
        v_order_id := gen_random_uuid();
        v_product_type_id := v_pt_ids[((v_i + v_u) % 5) + 1];
        v_product_value := 100 + ((v_i * 37 + v_u * 7 + v_day_offset * 11) % 901)::numeric;
        v_commission_amount := round(v_commission_per_order * (0.8 + ((v_i % 5) * 0.1)), 2);
        v_daily_total_commission := v_daily_total_commission + v_commission_amount;
        v_order_number := 'ORD-' || to_char(v_day_date, 'YYYYMMDD') || '-' || lpad((v_u * 1000 + v_i)::text, 6, '0');
        v_transaction_id := 'TX-' || encode(gen_random_bytes(8), 'hex');
        v_hour_offset := (v_i * 5 + v_day_offset) % 14;
        v_minute_offset := (v_i * 7 + v_u * 3) % 60;
        v_order_ts := v_day_date + (v_hour_offset || ' hours')::interval + (v_minute_offset || ' minutes')::interval;

        INSERT INTO orders (
          id, user_id, username, product_type_id, product_value,
          order_number, transaction_id, status, commission_amount,
          commission_rate, processed_at, created_at
        ) VALUES (
          v_order_id, v_user_id, v_username, v_product_type_id, v_product_value,
          v_order_number, v_transaction_id, 'success', v_commission_amount,
          round(v_commission_amount / NULLIF(v_product_value, 0), 4),
          v_order_ts + interval '5 minutes', v_order_ts
        );
      END LOOP;

      -- Insert failure orders
      FOR v_i IN 1..v_fail_count LOOP
        v_order_id := gen_random_uuid();
        v_product_type_id := v_pt_ids[((v_i + v_u + 2) % 5) + 1];
        v_product_value := 100 + ((v_i * 41 + v_u * 9 + v_day_offset * 7) % 901)::numeric;
        v_order_number := 'ORD-' || to_char(v_day_date, 'YYYYMMDD') || '-F' || lpad((v_u * 1000 + v_i)::text, 5, '0');
        v_transaction_id := 'TX-' || encode(gen_random_bytes(8), 'hex');
        v_hour_offset := (v_i * 3 + v_day_offset + 1) % 14;
        v_minute_offset := (v_i * 11 + v_u * 5) % 60;
        v_order_ts := v_day_date + (v_hour_offset || ' hours')::interval + (v_minute_offset || ' minutes')::interval;

        INSERT INTO orders (
          id, user_id, username, product_type_id, product_value,
          order_number, transaction_id, status, commission_amount,
          commission_rate, processed_at, created_at
        ) VALUES (
          v_order_id, v_user_id, v_username, v_product_type_id, v_product_value,
          v_order_number, v_transaction_id, 'failure', 0,
          0, v_order_ts + interval '5 minutes', v_order_ts
        );
      END LOOP;

      -- Insert a wallet_transaction for the daily commission total
      INSERT INTO wallet_transactions (
        id, user_id, type, amount, balance_before, balance_after,
        remarks, created_at
      ) VALUES (
        gen_random_uuid(), v_user_id, 'commission',
        round(v_daily_total_commission, 2),
        0, 0,
        'Daily commission earnings - ' || to_char(v_day_date, 'YYYY-MM-DD'),
        v_day_date + interval '22 hours'
      );

    END LOOP;

  END LOOP;
END $$;

-- Step 6: Update wallet balances to target 30K-50K range
UPDATE wallets SET
  available_balance = 42500.00,
  updated_at = now()
WHERE user_id = 'ee6dfe54-24e0-41bb-b472-4c2e2c3ac32b'; -- CryptoBart_Tokyo

UPDATE wallets SET
  available_balance = 38750.00,
  updated_at = now()
WHERE user_id = '13f53c1e-b44d-4460-bfaf-4935472baa75'; -- BartCrypto2026

UPDATE wallets SET
  available_balance = 45200.00,
  updated_at = now()
WHERE user_id = '82e12246-b62d-47a1-b3f7-22de790dddcc'; -- TokyoTrader_X

UPDATE wallets SET
  available_balance = 31800.00,
  updated_at = now()
WHERE user_id = '406e6b7a-231b-433c-80ea-4db66849bfa2'; -- NeoBart_HODL

UPDATE wallets SET
  available_balance = 49300.00,
  updated_at = now()
WHERE user_id = 'b631002d-d37b-41e5-b16e-c0962928f94c'; -- BartChainMaster

UPDATE wallets SET
  available_balance = 36400.00,
  updated_at = now()
WHERE user_id = '1267f9ab-1db3-4420-94dc-00f34dbc4d24'; -- TokyoBullRun24

UPDATE wallets SET
  available_balance = 43800.00,
  updated_at = now()
WHERE user_id = '726757e3-8208-450f-a3f9-db9e6c554ee2'; -- CryptoNomad_Bart

UPDATE wallets SET
  available_balance = 33500.00,
  updated_at = now()
WHERE user_id = '43286cff-d572-484e-b7dd-8140c29ac1c9'; -- Bart SatoshiWave

UPDATE wallets SET
  available_balance = 47100.00,
  updated_at = now()
WHERE user_id = '328eb144-c21e-46e5-b4eb-43d7c70769b9'; -- TokyoDeFiKing

UPDATE wallets SET
  available_balance = 40600.00,
  updated_at = now()
WHERE user_id = '2e895d14-3b38-4c11-bd53-3080da54d4fc'; -- BartLeveragePro

-- Step 7: Update total_income on users table
UPDATE users SET
  total_income = (
    SELECT COALESCE(SUM(commission_amount), 0)
    FROM orders
    WHERE orders.user_id = users.id
    AND orders.status = 'success'
  ),
  updated_at = now()
WHERE id IN (
  'ee6dfe54-24e0-41bb-b472-4c2e2c3ac32b',
  '13f53c1e-b44d-4460-bfaf-4935472baa75',
  '82e12246-b62d-47a1-b3f7-22de790dddcc',
  '406e6b7a-231b-433c-80ea-4db66849bfa2',
  'b631002d-d37b-41e5-b16e-c0962928f94c',
  '1267f9ab-1db3-4420-94dc-00f34dbc4d24',
  '726757e3-8208-450f-a3f9-db9e6c554ee2',
  '43286cff-d572-484e-b7dd-8140c29ac1c9',
  '328eb144-c21e-46e5-b4eb-43d7c70769b9',
  '2e895d14-3b38-4c11-bd53-3080da54d4fc'
);
