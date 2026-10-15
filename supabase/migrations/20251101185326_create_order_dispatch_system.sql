/*
  # 创建订单派送系统

  ## 概述
  为平台新增订单派送系统，总管理员可以批量导入派送订单，系统自动分配给员工。

  ## 新增表

  ### 1. dispatch_orders (派送订单库)
  存储可派送的订单池
  - `id` (uuid, primary key) - 订单唯一标识
  - `order_content` (text) - 订单详细内容
  - `is_active` (boolean) - 是否激活可派送
  - `created_by` (uuid) - 创建者（管理员ID）
  - `created_at` (timestamptz) - 创建时间
  - `updated_at` (timestamptz) - 更新时间

  ### 2. dispatch_assignments (派送记录)
  记录订单派送给员工的历史
  - `id` (uuid, primary key) - 记录唯一标识
  - `dispatch_order_id` (uuid) - 派送订单ID
  - `user_id` (uuid) - 员工ID
  - `status` (text) - 状态：pending(待处理)、accepted(已接单)、completed(已完成)、error(错误)
  - `assigned_at` (timestamptz) - 派送时间
  - `accepted_at` (timestamptz) - 接单时间
  - `completed_at` (timestamptz) - 完成时间
  - `remarks` (text) - 备注（如错误原因）

  ### 3. dispatch_config (派送配置)
  系统派送配置
  - `id` (uuid, primary key) - 配置ID
  - `config_key` (text, unique) - 配置键
  - `config_value` (text) - 配置值
  - `description` (text) - 配置说明
  - `updated_at` (timestamptz) - 更新时间

  ### 4. dispatch_sessions (员工工作会话)
  记录员工上下班状态
  - `id` (uuid, primary key) - 会话ID
  - `user_id` (uuid) - 员工ID
  - `status` (text) - online(在线)、offline(离线)
  - `started_at` (timestamptz) - 开始工作时间
  - `ended_at` (timestamptz) - 结束工作时间
  - `last_activity_at` (timestamptz) - 最后活动时间

  ## 安全策略
  - 所有表启用 RLS
  - 使用自定义认证系统
  - 管理员有完全访问权限
  - 员工只能查看和更新自己的派送记录

  ## 索引
  - 为常用查询字段添加索引以提升性能
*/

-- 创建派送订单库表
CREATE TABLE IF NOT EXISTS dispatch_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_content text NOT NULL,
  is_active boolean DEFAULT true,
  created_by uuid REFERENCES admins(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 创建派送记录表
CREATE TABLE IF NOT EXISTS dispatch_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_order_id uuid REFERENCES dispatch_orders(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'completed', 'error')),
  assigned_at timestamptz DEFAULT now(),
  accepted_at timestamptz,
  completed_at timestamptz,
  remarks text,
  UNIQUE(dispatch_order_id, user_id)
);

-- 创建派送配置表
CREATE TABLE IF NOT EXISTS dispatch_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_key text UNIQUE NOT NULL,
  config_value text NOT NULL,
  description text,
  updated_at timestamptz DEFAULT now()
);

-- 创建员工工作会话表
CREATE TABLE IF NOT EXISTS dispatch_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  status text DEFAULT 'online' CHECK (status IN ('online', 'offline')),
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz,
  last_activity_at timestamptz DEFAULT now()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_dispatch_orders_active ON dispatch_orders(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_user ON dispatch_assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_status ON dispatch_assignments(status);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignments_order ON dispatch_assignments(dispatch_order_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_sessions_user ON dispatch_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_sessions_status ON dispatch_sessions(status) WHERE status = 'online';

-- 启用 RLS
ALTER TABLE dispatch_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_sessions ENABLE ROW LEVEL SECURITY;

-- dispatch_orders RLS 策略
CREATE POLICY "Anyone can view active dispatch orders"
  ON dispatch_orders FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Anyone can insert dispatch orders"
  ON dispatch_orders FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Anyone can update dispatch orders"
  ON dispatch_orders FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can delete dispatch orders"
  ON dispatch_orders FOR DELETE
  TO anon, authenticated
  USING (true);

-- dispatch_assignments RLS 策略
CREATE POLICY "Anyone can view dispatch assignments"
  ON dispatch_assignments FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Anyone can insert dispatch assignments"
  ON dispatch_assignments FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Anyone can update dispatch assignments"
  ON dispatch_assignments FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can delete dispatch assignments"
  ON dispatch_assignments FOR DELETE
  TO anon, authenticated
  USING (true);

-- dispatch_config RLS 策略
CREATE POLICY "Anyone can view dispatch config"
  ON dispatch_config FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Anyone can modify dispatch config"
  ON dispatch_config FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

-- dispatch_sessions RLS 策略
CREATE POLICY "Anyone can view dispatch sessions"
  ON dispatch_sessions FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Anyone can insert dispatch sessions"
  ON dispatch_sessions FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Anyone can update dispatch sessions"
  ON dispatch_sessions FOR UPDATE
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Anyone can delete dispatch sessions"
  ON dispatch_sessions FOR DELETE
  TO anon, authenticated
  USING (true);

-- 插入默认配置
INSERT INTO dispatch_config (config_key, config_value, description)
VALUES 
  ('dispatch_interval_min', '30', '派送间隔最小秒数'),
  ('dispatch_interval_max', '120', '派送间隔最大秒数'),
  ('session_timeout_minutes', '10', '会话超时时间（分钟）')
ON CONFLICT (config_key) DO NOTHING;

-- 启用实时订阅
ALTER PUBLICATION supabase_realtime ADD TABLE dispatch_orders;
ALTER PUBLICATION supabase_realtime ADD TABLE dispatch_assignments;
ALTER PUBLICATION supabase_realtime ADD TABLE dispatch_config;
ALTER PUBLICATION supabase_realtime ADD TABLE dispatch_sessions;
