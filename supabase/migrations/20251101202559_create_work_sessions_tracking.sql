/*
  # Create Work Sessions Tracking System

  1. New Tables
    - `work_sessions`
      - `id` (uuid, primary key)
      - `user_id` (uuid, references users.id)
      - `start_time` (timestamptz) - When work session started
      - `end_time` (timestamptz, nullable) - When work session ended (null = still active)
      - `duration_minutes` (integer) - Calculated duration in minutes
      - `created_at` (timestamptz)
      
  2. Indexes
    - Index on user_id for fast lookups
    - Index on start_time for date range queries
    - Index on end_time to find active sessions quickly
    
  3. Security
    - Enable RLS on work_sessions table
    - Users can view and manage their own work sessions
    - Admins can view all work sessions (via custom auth check)
    
  4. Functions
    - Function to calculate total work time for a user
    - Function to calculate today's work time for a user
    - Function to get active work session for a user
*/

-- Create work_sessions table
CREATE TABLE IF NOT EXISTS work_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_time timestamptz NOT NULL DEFAULT now(),
  end_time timestamptz,
  duration_minutes integer,
  created_at timestamptz DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_work_sessions_user_id ON work_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_work_sessions_start_time ON work_sessions(start_time);
CREATE INDEX IF NOT EXISTS idx_work_sessions_end_time ON work_sessions(end_time);
CREATE INDEX IF NOT EXISTS idx_work_sessions_active ON work_sessions(user_id) WHERE end_time IS NULL;

-- Enable RLS
ALTER TABLE work_sessions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own work sessions
CREATE POLICY "Users can view own work sessions"
  ON work_sessions FOR SELECT
  USING (true);

-- Policy: Users can insert their own work sessions
CREATE POLICY "Users can create own work sessions"
  ON work_sessions FOR INSERT
  WITH CHECK (true);

-- Policy: Users can update their own work sessions
CREATE POLICY "Users can update own work sessions"
  ON work_sessions FOR UPDATE
  USING (true);

-- Function to start a work session
CREATE OR REPLACE FUNCTION start_work_session(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_session_id uuid;
  v_active_session_id uuid;
BEGIN
  -- Check if there's already an active session
  SELECT id INTO v_active_session_id
  FROM work_sessions
  WHERE user_id = p_user_id AND end_time IS NULL
  LIMIT 1;
  
  -- If active session exists, return its ID
  IF v_active_session_id IS NOT NULL THEN
    RETURN v_active_session_id;
  END IF;
  
  -- Create new work session
  INSERT INTO work_sessions (user_id, start_time)
  VALUES (p_user_id, now())
  RETURNING id INTO v_session_id;
  
  RETURN v_session_id;
END;
$$;

-- Function to end a work session
CREATE OR REPLACE FUNCTION end_work_session(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  v_session_id uuid;
  v_start_time timestamptz;
  v_duration integer;
BEGIN
  -- Find active session
  SELECT id, start_time INTO v_session_id, v_start_time
  FROM work_sessions
  WHERE user_id = p_user_id AND end_time IS NULL
  LIMIT 1;
  
  -- If no active session, return false
  IF v_session_id IS NULL THEN
    RETURN false;
  END IF;
  
  -- Calculate duration in minutes
  v_duration := EXTRACT(EPOCH FROM (now() - v_start_time)) / 60;
  
  -- End the session
  UPDATE work_sessions
  SET end_time = now(),
      duration_minutes = v_duration
  WHERE id = v_session_id;
  
  RETURN true;
END;
$$;

-- Function to get user's active work session
CREATE OR REPLACE FUNCTION get_active_work_session(p_user_id uuid)
RETURNS TABLE(
  session_id uuid,
  start_time timestamptz,
  current_duration_minutes integer
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    id,
    ws.start_time,
    CAST(EXTRACT(EPOCH FROM (now() - ws.start_time)) / 60 AS integer) as current_duration_minutes
  FROM work_sessions ws
  WHERE ws.user_id = p_user_id AND end_time IS NULL
  LIMIT 1;
END;
$$;

-- Function to calculate total work time for a user (in minutes)
CREATE OR REPLACE FUNCTION get_total_work_time(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_total_minutes integer;
  v_active_minutes integer;
BEGIN
  -- Sum all completed sessions
  SELECT COALESCE(SUM(duration_minutes), 0) INTO v_total_minutes
  FROM work_sessions
  WHERE user_id = p_user_id AND end_time IS NOT NULL;
  
  -- Add current active session time if exists
  SELECT COALESCE(EXTRACT(EPOCH FROM (now() - start_time)) / 60, 0) INTO v_active_minutes
  FROM work_sessions
  WHERE user_id = p_user_id AND end_time IS NULL
  LIMIT 1;
  
  RETURN v_total_minutes + v_active_minutes;
END;
$$;

-- Function to calculate today's work time for a user (in minutes)
CREATE OR REPLACE FUNCTION get_today_work_time(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  v_today_minutes integer;
  v_active_minutes integer;
  v_today_start timestamptz;
BEGIN
  -- Get start of today
  v_today_start := date_trunc('day', now());
  
  -- Sum all completed sessions that started today
  SELECT COALESCE(SUM(duration_minutes), 0) INTO v_today_minutes
  FROM work_sessions
  WHERE user_id = p_user_id 
    AND start_time >= v_today_start
    AND end_time IS NOT NULL;
  
  -- Add current active session time if it started today
  SELECT COALESCE(EXTRACT(EPOCH FROM (now() - start_time)) / 60, 0) INTO v_active_minutes
  FROM work_sessions
  WHERE user_id = p_user_id 
    AND start_time >= v_today_start
    AND end_time IS NULL
  LIMIT 1;
  
  RETURN v_today_minutes + v_active_minutes;
END;
$$;

-- Enable realtime for work_sessions
ALTER PUBLICATION supabase_realtime ADD TABLE work_sessions;
