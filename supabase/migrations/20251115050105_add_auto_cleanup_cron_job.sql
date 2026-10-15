/*
  # Configure automatic cleanup for pending orders
  
  1. Purpose
    - Automatically clean up pending orders that timeout after 5 minutes
    - Automatically clean up expired work sessions and dispatch sessions
    - Ensure orders are recovered when employees disconnect/shutdown/close browser
  
  2. Cron Job Configuration
    - Job name: auto_cleanup_dispatch_every_5min
    - Frequency: Every 5 minutes
    - Function: auto_cleanup_dispatch_system()
  
  3. Cleanup Scope
    - Pending orders > 5 minutes -> timeout_cancelled
    - Work sessions > 2 hours -> auto end
    - Dispatch sessions > 30 minutes inactive -> offline
  
  4. Effect
    - Maximum 5 minute delay before cleanup after employee disconnects
    - Orders automatically return to dispatch pool
    - Fully automated, no manual intervention needed
*/

-- Create cron job to run cleanup every 5 minutes
SELECT cron.schedule(
  'auto_cleanup_dispatch_every_5min',
  '*/5 * * * *',
  $$SELECT auto_cleanup_dispatch_system();$$
);

-- Verify job creation
DO $$
DECLARE
  v_job_count int;
  v_job_info record;
BEGIN
  SELECT COUNT(*) INTO v_job_count
  FROM cron.job
  WHERE jobname = 'auto_cleanup_dispatch_every_5min';
  
  IF v_job_count = 0 THEN
    RAISE EXCEPTION 'Failed to create cron job';
  END IF;
  
  SELECT jobid, schedule, active INTO v_job_info
  FROM cron.job
  WHERE jobname = 'auto_cleanup_dispatch_every_5min';
  
  RAISE NOTICE 'Auto cleanup cron job created successfully';
  RAISE NOTICE 'Job ID: %, Schedule: %, Active: %', v_job_info.jobid, v_job_info.schedule, v_job_info.active;
END $$;
