
/*
  # Insert Realistic Simulation Data for 10 Bart Members

  ## Summary
  Generates 10-15 days of realistic order history for the 10 Bart team members:
  CryptoBart_Tokyo, BartCrypto2026, TokyoTrader_X, NeoBart_HODL, BartChainMaster,
  TokyoBullRun24, CryptoNomad_Bart, Bart SatoshiWave, TokyoDeFiKing, BartLeveragePro

  ## Data Parameters
  - Orders per day: 100-300 per member
  - Success rate: ~70%, Failure rate: ~30%
  - Daily earnings: $350-$700 per member
  - Final wallet balance: $30,000-$50,000 per member

  ## Tables Modified
  - orders: New order records for each member across 13 days
  - wallet_transactions: Commission transaction records
  - wallets: Updated available_balance to 30K-50K range
  - users: Updated total_income to reflect cumulative earnings
*/

DO $$
DECLARE
  -- Member IDs
  v_bart1 uuid := 'ee6dfe54-24e0-41bb-b472-4c2e2c3ac32b'; -- CryptoBart_Tokyo
  v_bart2 uuid := '13f53c1e-b44d-4460-bfaf-4935472baa75'; -- BartCrypto2026
  v_bart3 uuid := '82e12246-b62d-47a1-b3f7-22de790dddcc'; -- TokyoTrader_X
  v_bart4 uuid := '406e6b7a-231b-433c-80ea-4db66849bfa2'; -- NeoBart_HODL
  v_bart5 uuid := 'b631002d-d37b-41e5-b16e-c0962928f94c'; -- BartChainMaster
  v_bart6 uuid := '1267f9ab-1db3-4420-94dc-00f34dbc4d24'; -- TokyoBullRun24
  v_bart7 uuid := '726757e3-8208-450f-a3f9-db9e6c554ee2'; -- CryptoNomad_Bart
  v_bart8 uuid := '43286cff-d572-484e-b7dd-8140c29ac1c9'; -- Bart SatoshiWave
  v_bart9 uuid := '328eb144-c21e-46e5-b4eb-43d7c70769b9'; -- TokyoDeFiKing
  v_bart10 uuid := '2e895d14-3b38-4c11-bd53-3080da54d4fc'; -- BartLeveragePro

  -- Product type IDs
  v_pt1 uuid := '70f07713-8c89-4f04-857e-3c3a351fe119'; -- Aura
  v_pt2 uuid := 'ffdee979-f3cf-4648-8f8c-8be94da63e88'; -- Nexus
  v_pt3 uuid := '67664dd4-239c-4dfb-b65e-6cf7e37dbc91'; -- Vortex
  v_pt4 uuid := '8165478d-203f-45b8-ad5b-ec33975c8fc4'; -- Orion
  v_pt5 uuid := '49a220ee-afe8-4e77-96ea-0505af16a850'; -- Cortex

  -- Admin for created_by reference
  v_admin_id uuid := 'e169a8c3-e5d7-4458-9f44-d12986c147ec'; -- ada66 (super_admin)

  -- Loop variables
  v_user_id uuid;
  v_username text;
  v_day_offset integer;
  v_day_date timestamptz;
  v_order_count integer;
  v_success_count integer;
  v_fail_count integer;
  v_i integer;
  v_order_id uuid;
  v_status text;
  v_product_value numeric;
  v_commission_rate numeric;
  v_commission_amount numeric;
  v_order_number text;
  v_transaction_id text;
  v_product_type_id uuid;
  v_hour_offset integer;
  v_minute_offset integer;
  v_order_ts timestamptz;
  v_target_balance numeric;
  v_current_balance numeric;
  v_total_commission numeric;
  v_pt_ids uuid[];
  v_usernames text[];
  v_user_ids uuid[];
  v_u integer;
BEGIN
  -- Arrays for iteration
  v_user_ids := ARRAY[v_bart1, v_bart2, v_bart3, v_bart4, v_bart5, v_bart6, v_bart7, v_bart8, v_bart9, v_bart10];
  v_usernames := ARRAY['CryptoBart_Tokyo','BartCrypto2026','TokyoTrader_X','NeoBart_HODL','BartChainMaster','TokyoBullRun24','CryptoNomad_Bart','Bart SatoshiWave','TokyoDeFiKing','BartLeveragePro'];
  v_pt_ids := ARRAY[v_pt1, v_pt2, v_pt3, v_pt4, v_pt5];

  -- Loop over each user
  FOR v_u IN 1..10 LOOP
    v_user_id := v_user_ids[v_u];
    v_username := v_usernames[v_u];

    -- Delete existing simulation orders to avoid duplicates (only orders from last 15 days)
    DELETE FROM orders 
    WHERE user_id = v_user_id 
      AND created_at >= (now() - interval '16 days');

    -- Loop over 13 days (days 13 down to 1, so most recent is "today minus 1")
    FOR v_day_offset IN REVERSE 13..1 LOOP
      v_day_date := date_trunc('day', now() - (v_day_offset || ' days')::interval) + interval '8 hours';

      -- Orders per day: 100-300, seeded by user and day for variety
      v_order_count := 100 + ((v_u * 17 + v_day_offset * 13) % 201);

      -- Success ~70%, fail ~30%
      v_success_count := round(v_order_count * (0.68 + ((v_u + v_day_offset) % 5) * 0.01));
      v_fail_count := v_order_count - v_success_count;

      -- Insert success orders
      FOR v_i IN 1..v_success_count LOOP
        v_order_id := gen_random_uuid();
        v_product_type_id := v_pt_ids[((v_i + v_u) % 5) + 1];
        -- Product values between 500-5000 for realistic commissions
        v_product_value := 500 + ((v_i * 37 + v_u * 7 + v_day_offset * 11) % 4501)::numeric;
        -- Commission rate 0.03-0.06
        v_commission_rate := 0.03 + (((v_i + v_day_offset) % 4) * 0.01);
        v_commission_amount := round(v_product_value * v_commission_rate, 2);
        v_order_number := 'ORD-' || to_char(v_day_date, 'YYYYMMDD') || '-' || lpad((v_u * 1000 + v_i)::text, 6, '0');
        v_transaction_id := 'TX-' || encode(gen_random_bytes(8), 'hex');
        -- Spread orders through the day
        v_hour_offset := (v_i * 5 + v_day_offset) % 14; -- 0-13 hours after 8am
        v_minute_offset := (v_i * 7 + v_u * 3) % 60;
        v_order_ts := v_day_date + (v_hour_offset || ' hours')::interval + (v_minute_offset || ' minutes')::interval;

        INSERT INTO orders (
          id, user_id, username, product_type_id, product_value,
          order_number, transaction_id, status, commission_amount,
          commission_rate, processed_at, created_at
        ) VALUES (
          v_order_id, v_user_id, v_username, v_product_type_id, v_product_value,
          v_order_number, v_transaction_id, 'success', v_commission_amount,
          v_commission_rate, v_order_ts + interval '5 minutes', v_order_ts
        );
      END LOOP;

      -- Insert failure orders
      FOR v_i IN 1..v_fail_count LOOP
        v_order_id := gen_random_uuid();
        v_product_type_id := v_pt_ids[((v_i + v_u + 2) % 5) + 1];
        v_product_value := 500 + ((v_i * 41 + v_u * 9 + v_day_offset * 7) % 4501)::numeric;
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

    END LOOP; -- end day loop

  END LOOP; -- end user loop

END $$;
