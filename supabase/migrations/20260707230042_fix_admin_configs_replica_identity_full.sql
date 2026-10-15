-- Set REPLICA IDENTITY FULL on admin_configs so realtime filters
-- work correctly for DELETE events (all columns are sent)
ALTER TABLE admin_configs REPLICA IDENTITY FULL;