/*
# Enable realtime for wallet_transactions table

1. Changes
   - Add wallet_transactions to supabase_realtime publication
   - Set REPLICA IDENTITY FULL for proper filter support
   
2. Purpose
   - Allow employee frontend to instantly detect new tips, commissions, and admin adjustments
   - Eliminates need for frequent polling; wallet balance updates appear immediately
*/

ALTER PUBLICATION supabase_realtime ADD TABLE wallet_transactions;

ALTER TABLE wallet_transactions REPLICA IDENTITY FULL;
