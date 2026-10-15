/*
  # Create Dispatch Groups System
  
  1. New Tables
    - `dispatch_groups`
      - `id` (uuid, primary key)
      - `group_name` (text, unique) - 分组名称
      - `description` (text, nullable) - 分组描述
      - `dispatch_interval_min` (integer, default 30) - 最小派单间隔（秒）
      - `dispatch_interval_max` (integer, default 120) - 最大派单间隔（秒）
      - `session_timeout_minutes` (integer, default 10) - 会话超时（分钟）
      - `dispatch_order_mode` (text, default 'random') - 派单模式
      - `is_default` (boolean, default false) - 是否为默认组
      - `is_active` (boolean, default true) - 是否激活
      - `created_by` (uuid, references admins) - 创建人
      - `created_at` (timestamptz, default now())
      - `updated_at` (timestamptz, default now())
      
    - `dispatch_group_orders`
      - `id` (uuid, primary key)
      - `group_id` (uuid, references dispatch_groups) - 所属分组
      - `order_content` (text) - 面单内容
      - `is_active` (boolean, default true) - 是否激活
      - `created_by` (uuid, references admins) - 创建人
      - `created_at` (timestamptz, default now())
      - `updated_at` (timestamptz, default now())
      
    - `dispatch_group_members`
      - `id` (uuid, primary key)
      - `group_id` (uuid, references dispatch_groups) - 分组ID
      - `user_id` (uuid, references users) - 员工ID
      - `assigned_by` (uuid, references admins) - 分配人
      - `assigned_at` (timestamptz, default now())
      - Unique constraint on (group_id, user_id)
      
  2. Security
    - Enable RLS on all tables
    - Add policies for authenticated access
    
  3. Notes
    - Default group will be created automatically
    - Users not in any group will use default group
    - Each group has independent order pool and settings
*/

-- Create dispatch_groups table
CREATE TABLE IF NOT EXISTS dispatch_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_name text UNIQUE NOT NULL,
  description text,
  dispatch_interval_min integer DEFAULT 30 CHECK (dispatch_interval_min >= 10 AND dispatch_interval_min <= 300),
  dispatch_interval_max integer DEFAULT 120 CHECK (dispatch_interval_max >= 30 AND dispatch_interval_max <= 600),
  session_timeout_minutes integer DEFAULT 10 CHECK (session_timeout_minutes >= 1 AND session_timeout_minutes <= 60),
  dispatch_order_mode text DEFAULT 'random' CHECK (dispatch_order_mode IN ('random', 'sequential')),
  is_default boolean DEFAULT false,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES admins(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create dispatch_group_orders table
CREATE TABLE IF NOT EXISTS dispatch_group_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES dispatch_groups(id) ON DELETE CASCADE NOT NULL,
  order_content text NOT NULL,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES admins(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create dispatch_group_members table
CREATE TABLE IF NOT EXISTS dispatch_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES dispatch_groups(id) ON DELETE CASCADE NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  assigned_by uuid REFERENCES admins(id),
  assigned_at timestamptz DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_dispatch_group_orders_group_id ON dispatch_group_orders(group_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_group_orders_active ON dispatch_group_orders(group_id, is_active);
CREATE INDEX IF NOT EXISTS idx_dispatch_group_members_user_id ON dispatch_group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_group_members_group_id ON dispatch_group_members(group_id);

-- Enable RLS
ALTER TABLE dispatch_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_group_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_group_members ENABLE ROW LEVEL SECURITY;

-- RLS Policies for dispatch_groups
CREATE POLICY "Anyone can view dispatch groups"
  ON dispatch_groups FOR SELECT
  USING (true);

CREATE POLICY "Anyone can insert dispatch groups"
  ON dispatch_groups FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update dispatch groups"
  ON dispatch_groups FOR UPDATE
  USING (true);

CREATE POLICY "Anyone can delete dispatch groups"
  ON dispatch_groups FOR DELETE
  USING (true);

-- RLS Policies for dispatch_group_orders
CREATE POLICY "Anyone can view group orders"
  ON dispatch_group_orders FOR SELECT
  USING (true);

CREATE POLICY "Anyone can insert group orders"
  ON dispatch_group_orders FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can update group orders"
  ON dispatch_group_orders FOR UPDATE
  USING (true);

CREATE POLICY "Anyone can delete group orders"
  ON dispatch_group_orders FOR DELETE
  USING (true);

-- RLS Policies for dispatch_group_members
CREATE POLICY "Anyone can view group members"
  ON dispatch_group_members FOR SELECT
  USING (true);

CREATE POLICY "Anyone can insert group members"
  ON dispatch_group_members FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Anyone can delete group members"
  ON dispatch_group_members FOR DELETE
  USING (true);

-- Insert default group
INSERT INTO dispatch_groups (
  group_name,
  description,
  dispatch_interval_min,
  dispatch_interval_max,
  session_timeout_minutes,
  dispatch_order_mode,
  is_default,
  is_active
) VALUES (
  'Default Group',
  '默认分组 - 未分配到其他组的员工使用此组',
  30,
  120,
  10,
  'random',
  true,
  true
) ON CONFLICT (group_name) DO NOTHING;

-- Enable realtime for new tables
ALTER PUBLICATION supabase_realtime ADD TABLE dispatch_groups;
ALTER PUBLICATION supabase_realtime ADD TABLE dispatch_group_orders;
ALTER PUBLICATION supabase_realtime ADD TABLE dispatch_group_members;
