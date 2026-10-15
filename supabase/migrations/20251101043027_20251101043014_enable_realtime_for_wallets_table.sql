/*
  # Enable Realtime for Wallets Table

  1. Changes
    - Enable realtime replication for wallets table
  
  2. Purpose
    - Allow Wallet Management panel to receive real-time updates when:
      - New wallets are created automatically for new employees
      - Wallet balances are adjusted by admins
      - Wallet balances change due to commissions or withdrawals
    - Ensures wallet data stays synchronized across all admin dashboards
    - Improves user experience with instant balance updates
*/

-- Enable realtime for wallets table
ALTER PUBLICATION supabase_realtime ADD TABLE wallets;
