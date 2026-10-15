/*
# Add 5 missing tables to cleanup_user_data trigger function

## Problem
The cleanup_user_data() trigger function was missing DELETE statements for 5 tables
that were added after the function was last updated. This caused orphaned rows to
remain in the database after an employee was deleted.

## Tables added to cleanup
1. customer_auto_message_logs (employee_id) - auto message delivery logs
2. dispatch_group_members (user_id) - dispatch group membership records
3. dispatch_system_logs (user_id) - dispatch system operation logs
4. employee_submit_time_settings (user_id) - per-employee submit time config
5. used_order_data (user_id) - order data already assigned to the employee

## Changes
- Updated cleanup_user_data() function: step count 20/20 -> 25/25
- Added 5 new DELETE steps at appropriate positions in the function
- No other changes to existing logic

## Security
- Function remains SECURITY DEFINER with search_path = 'public', 'pg_temp'
- No RLS or policy changes
*/

CREATE OR REPLACE FUNCTION public.cleanup_user_data()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
v_user_id uuid;
v_deleted_count integer;
v_total_deleted integer := 0;
BEGIN
v_user_id := OLD.id;

-- Set cleanup mode to bypass wallet protection
PERFORM set_config('app.in_user_cleanup', 'true', true);

RAISE NOTICE '==========================================';
RAISE NOTICE 'Starting comprehensive cleanup for user: %', v_user_id;
RAISE NOTICE 'User: % (Employee ID: %)', OLD.username, OLD.employee_id;
RAISE NOTICE '==========================================';

-- ========================================================================
-- CUSTOMER SERVICE SYSTEM
-- ========================================================================

DELETE FROM service_ratings WHERE employee_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[1/25] Deleted % service ratings', v_deleted_count;

DELETE FROM rating_requests WHERE employee_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[2/25] Deleted % rating requests', v_deleted_count;

DELETE FROM customer_employee_conversations WHERE employee_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[3/25] Deleted % customer conversations', v_deleted_count;

DELETE FROM customer_service_sessions WHERE employee_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[4/25] Deleted % customer service sessions', v_deleted_count;

DELETE FROM customer_auto_message_logs WHERE employee_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[5/25] Deleted % customer auto message logs', v_deleted_count;

-- ========================================================================
-- BROADCAST SYSTEM
-- ========================================================================

DELETE FROM broadcast_recipients WHERE employee_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[6/25] Deleted % broadcast recipients', v_deleted_count;

-- ========================================================================
-- DISPATCH SYSTEM
-- ========================================================================

DELETE FROM dispatch_rate_limits WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[7/25] Deleted % dispatch rate limits', v_deleted_count;

DELETE FROM dispatch_assignments WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[8/25] Deleted % dispatch assignments', v_deleted_count;

DELETE FROM dispatch_sessions WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[9/25] Deleted % dispatch sessions', v_deleted_count;

DELETE FROM dispatch_group_members WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[10/25] Deleted % dispatch group memberships', v_deleted_count;

DELETE FROM dispatch_system_logs WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[11/25] Deleted % dispatch system logs', v_deleted_count;

-- ========================================================================
-- WORK SESSIONS
-- ========================================================================

DELETE FROM work_sessions WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[12/25] Deleted % work sessions', v_deleted_count;

-- ========================================================================
-- ORDERS
-- ========================================================================

DELETE FROM orders_history WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[13/25] Deleted % orders history records', v_deleted_count;

DELETE FROM orders_history_2025 WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[14/25] Deleted % orders history 2025 records', v_deleted_count;

DELETE FROM orders_history_2026 WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[15/25] Deleted % orders history 2026 records', v_deleted_count;

DELETE FROM used_order_data WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[16/25] Deleted % used order data records', v_deleted_count;

-- ========================================================================
-- MESSAGES
-- ========================================================================

DELETE FROM message_recipients WHERE recipient_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[17/25] Deleted % message recipients', v_deleted_count;

DELETE FROM messages WHERE sender_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[18/25] Deleted % sent messages', v_deleted_count;

-- ========================================================================
-- FINANCIAL DATA
-- ========================================================================

DELETE FROM commission_audit_log WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[19/25] Deleted % commission audit logs', v_deleted_count;

DELETE FROM withdrawals WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[20/25] Deleted % withdrawals', v_deleted_count;

DELETE FROM wallet_transactions WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[21/25] Deleted % wallet transactions', v_deleted_count;

DELETE FROM wallets WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[22/25] Deleted % wallets', v_deleted_count;

-- ========================================================================
-- EMPLOYEE SETTINGS & VERIFICATION
-- ========================================================================

DELETE FROM employee_submit_time_settings WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[23/25] Deleted % employee submit time settings', v_deleted_count;

DELETE FROM verification_requests WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[24/25] Deleted % verification requests', v_deleted_count;

-- ========================================================================
-- ACTIVE ORDERS (must be after financial data)
-- ========================================================================

DELETE FROM orders WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[25/25] Deleted % active orders', v_deleted_count;

-- ========================================================================
-- LOGIN & SECURITY (these use different column references)
-- ========================================================================

DELETE FROM employee_login_history WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[+] Deleted % login history records', v_deleted_count;

DELETE FROM login_attempts WHERE identifier = OLD.username;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[+] Deleted % login attempts', v_deleted_count;

DELETE FROM account_locks WHERE user_id = v_user_id;
GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
v_total_deleted := v_total_deleted + v_deleted_count;
RAISE NOTICE '[+] Deleted % account locks', v_deleted_count;

RAISE NOTICE '==========================================';
RAISE NOTICE 'Cleanup complete. Total records deleted: %', v_total_deleted;
RAISE NOTICE '==========================================';

RETURN OLD;
END;
$function$;
