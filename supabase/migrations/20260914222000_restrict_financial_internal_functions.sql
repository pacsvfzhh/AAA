REVOKE EXECUTE ON FUNCTION enqueue_wallet_reconciliation(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION reconcile_wallet_from_ledger(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION process_wallet_reconciliation_queue(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION enqueue_all_wallets_for_reconciliation() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION track_wallet_transaction_in_ledger() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION reverse_deleted_wallet_transaction_in_ledger() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION track_withdrawal_in_ledger() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION enqueue_changed_wallet() FROM PUBLIC, anon, authenticated;
