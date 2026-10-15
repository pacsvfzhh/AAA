UPDATE public.work_sessions
SET end_time = start_time,
    duration_minutes = 0
WHERE end_time IS NOT NULL
  AND end_time < start_time;

ALTER TABLE public.work_sessions
  VALIDATE CONSTRAINT work_sessions_valid_time_range;
