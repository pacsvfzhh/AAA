
ALTER TABLE submit_time_groups DROP CONSTRAINT submit_time_groups_max_seconds_check;
ALTER TABLE submit_time_groups ADD CONSTRAINT submit_time_groups_max_seconds_check CHECK (max_seconds >= 3 AND max_seconds <= 300);
