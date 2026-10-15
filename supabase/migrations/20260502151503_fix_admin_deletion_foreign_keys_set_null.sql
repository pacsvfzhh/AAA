/*
  # Fix Admin Deletion: Change Audit-Type Foreign Keys to SET NULL

  1. Problem
    - Deleting a secondary admin fails when that admin has audited/created audit-type records
    - Foreign keys with NO ACTION rule block the deletion (e.g. verification_requests.audited_by)

  2. Changes
    - Convert audit-trail foreign keys from NO ACTION to SET NULL
    - Preserves historical records while allowing admin deletion
    - Affected tables: verification_requests, wallet_transactions, withdrawals,
      admin_groups, dispatch_groups, dispatch_group_orders, dispatch_group_members,
      valid_data_audit_log, valid_data_error_log, bulk_import_log, account_locks

  3. Safety
    - No data is deleted or modified
    - Only changes ON DELETE behavior for future deletions
    - RLS policies remain unchanged
*/

DO $$
DECLARE
  rec record;
  fk_definitions jsonb := '[
    {"table":"verification_requests","column":"audited_by","constraint":"verification_requests_audited_by_fkey"},
    {"table":"wallet_transactions","column":"created_by","constraint":"wallet_transactions_created_by_fkey"},
    {"table":"withdrawals","column":"audited_by","constraint":"withdrawals_audited_by_fkey"},
    {"table":"admin_groups","column":"created_by","constraint":"admin_groups_created_by_fkey"},
    {"table":"dispatch_groups","column":"created_by","constraint":"dispatch_groups_created_by_fkey"},
    {"table":"dispatch_group_orders","column":"created_by","constraint":"dispatch_group_orders_created_by_fkey"},
    {"table":"dispatch_group_members","column":"assigned_by","constraint":"dispatch_group_members_assigned_by_fkey"},
    {"table":"valid_data_audit_log","column":"performed_by","constraint":"valid_data_audit_log_performed_by_fkey"},
    {"table":"valid_data_error_log","column":"resolved_by","constraint":"valid_data_error_log_resolved_by_fkey"},
    {"table":"bulk_import_log","column":"performed_by","constraint":"bulk_import_log_performed_by_fkey"},
    {"table":"account_locks","column":"unlocked_by","constraint":"account_locks_unlocked_by_fkey"}
  ]'::jsonb;
BEGIN
  FOR rec IN SELECT * FROM jsonb_array_elements(fk_definitions) AS elem LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = (rec.value->>'constraint')
        AND table_name = (rec.value->>'table')
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I DROP CONSTRAINT %I',
        rec.value->>'table',
        rec.value->>'constraint'
      );
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES admins(id) ON DELETE SET NULL',
        rec.value->>'table',
        rec.value->>'constraint',
        rec.value->>'column'
      );
    END IF;
  END LOOP;
END $$;
