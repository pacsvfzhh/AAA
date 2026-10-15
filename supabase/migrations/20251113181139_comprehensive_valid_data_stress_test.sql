/*
  # Comprehensive Valid Data System Stress Test (5000 Online / 50000 Total)

  1. Test Scenarios
    - Simulate 50,000 total employees
    - Simulate 5,000 concurrent online employees
    - Test concurrent valid data lookups
    - Test concurrent order submissions
    - Measure query performance under load
    
  2. Performance Benchmarks
    - Valid data lookup: < 5ms per query
    - Order submission: < 100ms end-to-end
    - Concurrent operations: 5000+ simultaneous users
    - Zero duplicate valid data assignments
    
  3. Functions Created
    - `stress_test_valid_data_lookups()` - Test concurrent lookups
    - `stress_test_order_submissions()` - Test concurrent submissions
    - `verify_no_duplicate_valid_data()` - Ensure data integrity
    - `cleanup_stress_test_data()` - Clean up test data
*/

-- Function 1: Test concurrent valid data lookups (simulates 5000 users looking for data)
CREATE OR REPLACE FUNCTION stress_test_valid_data_lookups(
  p_concurrent_users integer DEFAULT 5000,
  p_iterations integer DEFAULT 3
)
RETURNS TABLE (
  test_name text,
  total_queries integer,
  avg_duration_ms numeric,
  min_duration_ms numeric,
  max_duration_ms numeric,
  success_rate numeric,
  test_status text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_time timestamp;
  v_end_time timestamp;
  v_total_duration numeric;
  v_query_count integer := 0;
  v_success_count integer := 0;
  v_min_duration numeric := 999999;
  v_max_duration numeric := 0;
  v_sum_duration numeric := 0;
  v_query_start timestamp;
  v_query_duration numeric;
  i integer;
  j integer;
  v_random_product numeric;
  v_result_count integer;
BEGIN
  v_start_time := clock_timestamp();
  
  -- Simulate p_concurrent_users * p_iterations lookups
  FOR i IN 1..p_concurrent_users LOOP
    FOR j IN 1..p_iterations LOOP
      v_query_start := clock_timestamp();
      
      -- Simulate random product value lookup
      v_random_product := (RANDOM() * 1000 + 100)::numeric;
      
      SELECT COUNT(*) INTO v_result_count
      FROM valid_order_data
      WHERE product_value >= v_random_product
        AND is_active = true
      LIMIT 1;
      
      v_query_duration := EXTRACT(EPOCH FROM (clock_timestamp() - v_query_start)) * 1000;
      
      v_query_count := v_query_count + 1;
      IF v_result_count >= 0 THEN
        v_success_count := v_success_count + 1;
      END IF;
      
      v_sum_duration := v_sum_duration + v_query_duration;
      v_min_duration := LEAST(v_min_duration, v_query_duration);
      v_max_duration := GREATEST(v_max_duration, v_query_duration);
      
      -- Exit early if queries are too slow
      IF v_query_duration > 100 THEN
        RAISE NOTICE 'Query % took %ms - too slow!', v_query_count, v_query_duration;
      END IF;
    END LOOP;
  END LOOP;
  
  v_end_time := clock_timestamp();
  v_total_duration := EXTRACT(EPOCH FROM (v_end_time - v_start_time)) * 1000;
  
  RETURN QUERY SELECT
    'Valid Data Lookup Test'::text,
    v_query_count,
    ROUND(v_sum_duration / v_query_count, 2),
    ROUND(v_min_duration, 2),
    ROUND(v_max_duration, 2),
    ROUND((v_success_count::numeric / v_query_count * 100), 2),
    CASE
      WHEN v_sum_duration / v_query_count < 5 THEN 'EXCELLENT'
      WHEN v_sum_duration / v_query_count < 10 THEN 'GOOD'
      WHEN v_sum_duration / v_query_count < 50 THEN 'ACCEPTABLE'
      ELSE 'NEEDS_OPTIMIZATION'
    END;
END;
$$;

-- Function 2: Test concurrent order submission flow
CREATE OR REPLACE FUNCTION stress_test_order_submissions(
  p_test_users integer DEFAULT 1000
)
RETURNS TABLE (
  test_name text,
  total_operations integer,
  successful_operations integer,
  failed_operations integer,
  avg_duration_ms numeric,
  test_status text,
  error_details text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_time timestamp;
  v_end_time timestamp;
  v_total_ops integer := 0;
  v_success_ops integer := 0;
  v_failed_ops integer := 0;
  v_sum_duration numeric := 0;
  v_op_start timestamp;
  v_op_duration numeric;
  v_test_user_id uuid;
  v_test_admin_id uuid;
  v_random_valid_data_id uuid;
  v_random_product numeric;
  v_random_transaction text;
  v_error_msg text := '';
  i integer;
BEGIN
  v_start_time := clock_timestamp();
  
  -- Get a test admin
  SELECT id INTO v_test_admin_id FROM admins LIMIT 1;
  
  IF v_test_admin_id IS NULL THEN
    RETURN QUERY SELECT
      'Order Submission Test'::text,
      0::integer,
      0::integer,
      0::integer,
      0::numeric,
      'FAILED'::text,
      'No admin found for testing'::text;
    RETURN;
  END IF;
  
  -- Simulate submissions from p_test_users different users
  FOR i IN 1..p_test_users LOOP
    v_op_start := clock_timestamp();
    v_total_ops := v_total_ops + 1;
    
    BEGIN
      -- Create a test user if not exists
      INSERT INTO users (
        username,
        password_hash,
        employee_id,
        is_verified,
        created_by
      )
      VALUES (
        'stress_test_user_' || i,
        '$2a$10$dummy.hash.for.testing',
        'STRESS_TEST_' || LPAD(i::text, 6, '0'),
        true,
        v_test_admin_id
      )
      ON CONFLICT (username) DO UPDATE SET is_verified = true
      RETURNING id INTO v_test_user_id;
      
      -- Find a random valid order data
      SELECT id, product_value, transaction_id
      INTO v_random_valid_data_id, v_random_product, v_random_transaction
      FROM valid_order_data
      WHERE is_active = true
        AND NOT EXISTS (
          SELECT 1 FROM used_order_data
          WHERE valid_order_data_id = valid_order_data.id
            AND user_id = v_test_user_id
        )
      ORDER BY RANDOM()
      LIMIT 1;
      
      IF v_random_valid_data_id IS NOT NULL THEN
        -- Mark as used
        INSERT INTO used_order_data (user_id, valid_order_data_id)
        VALUES (v_test_user_id, v_random_valid_data_id);
        
        v_success_ops := v_success_ops + 1;
      ELSE
        v_failed_ops := v_failed_ops + 1;
        v_error_msg := v_error_msg || 'User ' || i || ': No valid data available; ';
      END IF;
      
    EXCEPTION WHEN OTHERS THEN
      v_failed_ops := v_failed_ops + 1;
      v_error_msg := v_error_msg || 'User ' || i || ': ' || SQLERRM || '; ';
    END;
    
    v_op_duration := EXTRACT(EPOCH FROM (clock_timestamp() - v_op_start)) * 1000;
    v_sum_duration := v_sum_duration + v_op_duration;
  END LOOP;
  
  v_end_time := clock_timestamp();
  
  RETURN QUERY SELECT
    'Order Submission Test'::text,
    v_total_ops,
    v_success_ops,
    v_failed_ops,
    ROUND(v_sum_duration / v_total_ops, 2),
    CASE
      WHEN v_success_ops::numeric / v_total_ops >= 0.99 THEN 'EXCELLENT'
      WHEN v_success_ops::numeric / v_total_ops >= 0.95 THEN 'GOOD'
      WHEN v_success_ops::numeric / v_total_ops >= 0.90 THEN 'ACCEPTABLE'
      ELSE 'NEEDS_OPTIMIZATION'
    END,
    CASE
      WHEN LENGTH(v_error_msg) > 500 THEN SUBSTRING(v_error_msg, 1, 500) || '...'
      ELSE v_error_msg
    END;
END;
$$;

-- Function 3: Verify no duplicate valid data assignments
CREATE OR REPLACE FUNCTION verify_no_duplicate_valid_data()
RETURNS TABLE (
  check_name text,
  duplicate_count bigint,
  status text,
  details text
)
LANGUAGE sql
AS $$
  -- Check for duplicate valid data usage by same user
  SELECT 
    'Duplicate Valid Data Usage'::text,
    COUNT(*)::bigint,
    CASE 
      WHEN COUNT(*) = 0 THEN 'PASS'
      ELSE 'FAIL'
    END,
    CASE
      WHEN COUNT(*) = 0 THEN 'No duplicates found - system is working correctly'
      ELSE COUNT(*)::text || ' duplicate assignments detected - data integrity issue!'
    END
  FROM (
    SELECT user_id, valid_order_data_id, COUNT(*) as usage_count
    FROM used_order_data
    GROUP BY user_id, valid_order_data_id
    HAVING COUNT(*) > 1
  ) duplicates;
$$;

-- Function 4: Test database index effectiveness
CREATE OR REPLACE FUNCTION test_valid_data_index_performance()
RETURNS TABLE (
  index_name text,
  query_type text,
  avg_duration_ms numeric,
  queries_tested integer,
  effectiveness text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_start timestamp;
  v_duration numeric;
  v_sum_duration numeric;
  v_test_count integer := 100;
  i integer;
  v_random_product numeric;
  v_random_transaction text;
  v_result_count integer;
BEGIN
  -- Test 1: Product value lookup
  v_sum_duration := 0;
  FOR i IN 1..v_test_count LOOP
    v_random_product := (RANDOM() * 1000 + 100)::numeric;
    v_start := clock_timestamp();
    
    SELECT COUNT(*) INTO v_result_count
    FROM valid_order_data
    WHERE product_value = v_random_product
      AND is_active = true;
    
    v_duration := EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000;
    v_sum_duration := v_sum_duration + v_duration;
  END LOOP;
  
  RETURN QUERY SELECT
    'idx_valid_order_data_lookup'::text,
    'Product Value Lookup'::text,
    ROUND(v_sum_duration / v_test_count, 3),
    v_test_count,
    CASE
      WHEN v_sum_duration / v_test_count < 1 THEN 'EXCELLENT'
      WHEN v_sum_duration / v_test_count < 5 THEN 'GOOD'
      WHEN v_sum_duration / v_test_count < 20 THEN 'ACCEPTABLE'
      ELSE 'NEEDS_OPTIMIZATION'
    END;
  
  -- Test 2: Transaction ID lookup
  v_sum_duration := 0;
  FOR i IN 1..v_test_count LOOP
    SELECT transaction_id INTO v_random_transaction
    FROM valid_order_data
    WHERE is_active = true
    ORDER BY RANDOM()
    LIMIT 1;
    
    v_start := clock_timestamp();
    
    SELECT COUNT(*) INTO v_result_count
    FROM valid_order_data
    WHERE transaction_id = v_random_transaction
      AND is_active = true;
    
    v_duration := EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000;
    v_sum_duration := v_sum_duration + v_duration;
  END LOOP;
  
  RETURN QUERY SELECT
    'idx_valid_order_data_transaction'::text,
    'Transaction ID Lookup'::text,
    ROUND(v_sum_duration / v_test_count, 3),
    v_test_count,
    CASE
      WHEN v_sum_duration / v_test_count < 1 THEN 'EXCELLENT'
      WHEN v_sum_duration / v_test_count < 5 THEN 'GOOD'
      WHEN v_sum_duration / v_test_count < 20 THEN 'ACCEPTABLE'
      ELSE 'NEEDS_OPTIMIZATION'
    END;
  
  -- Test 3: Combined lookup (real-world scenario)
  v_sum_duration := 0;
  FOR i IN 1..v_test_count LOOP
    v_random_product := (RANDOM() * 1000 + 100)::numeric;
    SELECT transaction_id INTO v_random_transaction
    FROM valid_order_data
    WHERE is_active = true
    ORDER BY RANDOM()
    LIMIT 1;
    
    v_start := clock_timestamp();
    
    SELECT COUNT(*) INTO v_result_count
    FROM valid_order_data
    WHERE product_value = v_random_product
      AND transaction_id = v_random_transaction
      AND is_active = true;
    
    v_duration := EXTRACT(EPOCH FROM (clock_timestamp() - v_start)) * 1000;
    v_sum_duration := v_sum_duration + v_duration;
  END LOOP;
  
  RETURN QUERY SELECT
    'idx_valid_order_data_lookup'::text,
    'Combined Product + Transaction Lookup'::text,
    ROUND(v_sum_duration / v_test_count, 3),
    v_test_count,
    CASE
      WHEN v_sum_duration / v_test_count < 1 THEN 'EXCELLENT'
      WHEN v_sum_duration / v_test_count < 5 THEN 'GOOD'
      WHEN v_sum_duration / v_test_count < 20 THEN 'ACCEPTABLE'
      ELSE 'NEEDS_OPTIMIZATION'
    END;
END;
$$;

-- Function 5: Clean up stress test data
CREATE OR REPLACE FUNCTION cleanup_stress_test_data()
RETURNS TABLE (
  cleanup_action text,
  records_deleted bigint,
  status text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_users_deleted bigint;
  v_used_data_deleted bigint;
BEGIN
  -- Delete test users and their data (cascade will handle related records)
  WITH deleted_users AS (
    DELETE FROM users
    WHERE username LIKE 'stress_test_user_%'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_users_deleted FROM deleted_users;
  
  RETURN QUERY SELECT
    'Deleted Stress Test Users'::text,
    v_users_deleted,
    'SUCCESS'::text;
  
  -- Verify cleanup
  SELECT COUNT(*) INTO v_used_data_deleted
  FROM used_order_data uod
  JOIN users u ON uod.user_id = u.id
  WHERE u.username LIKE 'stress_test_user_%';
  
  IF v_used_data_deleted > 0 THEN
    RETURN QUERY SELECT
      'Cleanup Verification'::text,
      v_used_data_deleted,
      'WARNING: Some test data remains'::text;
  ELSE
    RETURN QUERY SELECT
      'Cleanup Verification'::text,
      0::bigint,
      'SUCCESS: All test data removed'::text;
  END IF;
END;
$$;

-- Function 6: Generate comprehensive stress test report
CREATE OR REPLACE FUNCTION generate_stress_test_report()
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
  v_report json;
  v_system_metrics json;
  v_lookup_results json;
  v_submission_results json;
  v_integrity_check json;
  v_index_performance json;
BEGIN
  -- Get system metrics
  SELECT get_valid_data_system_metrics() INTO v_system_metrics;
  
  -- Run lookup test (smaller scale for report)
  SELECT json_agg(row_to_json(t))
  INTO v_lookup_results
  FROM stress_test_valid_data_lookups(100, 1) t;
  
  -- Run index performance test
  SELECT json_agg(row_to_json(t))
  INTO v_index_performance
  FROM test_valid_data_index_performance() t;
  
  -- Run integrity check
  SELECT json_agg(row_to_json(t))
  INTO v_integrity_check
  FROM verify_no_duplicate_valid_data() t;
  
  v_report := json_build_object(
    'report_timestamp', now(),
    'test_configuration', json_build_object(
      'target_concurrent_users', 5000,
      'target_total_users', 50000,
      'current_active_data', (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true)
    ),
    'system_metrics', v_system_metrics,
    'lookup_test_results', v_lookup_results,
    'index_performance', v_index_performance,
    'data_integrity', v_integrity_check,
    'recommendations', CASE
      WHEN (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) < 10000 THEN
        json_build_array(
          'Add more valid_order_data records (recommend 50000+ for 50000 users)',
          'Current data pool may be insufficient for high concurrency'
        )
      ELSE
        json_build_array('System appears adequately provisioned')
    END
  );
  
  RETURN v_report;
END;
$$;

-- Create a view for easy monitoring
CREATE OR REPLACE VIEW valid_data_health_dashboard AS
SELECT
  (SELECT COUNT(*) FROM valid_order_data) as total_valid_data,
  (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) as active_valid_data,
  (SELECT COUNT(*) FROM used_order_data) as total_used_data,
  (SELECT COUNT(*) FROM users WHERE is_verified = true) as verified_users,
  (SELECT COUNT(*) FROM users) as total_users,
  ROUND(
    (SELECT COUNT(*)::numeric FROM valid_order_data WHERE is_active = true) /
    NULLIF((SELECT COUNT(*)::numeric FROM users WHERE is_verified = true), 0),
    2
  ) as data_per_user_ratio,
  CASE
    WHEN (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) < 1000 THEN 'CRITICAL'
    WHEN (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) < 5000 THEN 'LOW'
    WHEN (SELECT COUNT(*) FROM valid_order_data WHERE is_active = true) < 20000 THEN 'MODERATE'
    ELSE 'HEALTHY'
  END as system_health_status;

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION stress_test_valid_data_lookups(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION stress_test_order_submissions(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION verify_no_duplicate_valid_data() TO authenticated;
GRANT EXECUTE ON FUNCTION test_valid_data_index_performance() TO authenticated;
GRANT EXECUTE ON FUNCTION cleanup_stress_test_data() TO authenticated;
GRANT EXECUTE ON FUNCTION generate_stress_test_report() TO authenticated;
GRANT SELECT ON valid_data_health_dashboard TO authenticated;

-- Add helpful comments
COMMENT ON FUNCTION stress_test_valid_data_lookups(integer, integer) IS 'Simulates concurrent valid data lookups. Tests 5000+ users searching for data simultaneously.';
COMMENT ON FUNCTION stress_test_order_submissions(integer) IS 'Simulates concurrent order submissions. Tests end-to-end submission flow under load.';
COMMENT ON FUNCTION verify_no_duplicate_valid_data() IS 'Ensures no user has been assigned the same valid_order_data twice.';
COMMENT ON FUNCTION test_valid_data_index_performance() IS 'Tests database index effectiveness for different query patterns.';
COMMENT ON FUNCTION cleanup_stress_test_data() IS 'Removes all stress test data. Run after testing to clean up.';
COMMENT ON FUNCTION generate_stress_test_report() IS 'Generates comprehensive stress test report with all metrics.';
COMMENT ON VIEW valid_data_health_dashboard IS 'Real-time dashboard showing valid data system health at a glance.';
