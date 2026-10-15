/*
  # 创建订单派送监控系统
  
  1. 新增表
    - `dispatch_system_logs` - 系统日志表
      - `id` (uuid, primary key)
      - `log_type` (text) - 日志类型：assignment, timeout, error, performance
      - `user_id` (uuid) - 关联用户
      - `assignment_id` (uuid) - 关联分配记录
      - `event_name` (text) - 事件名称
      - `event_data` (jsonb) - 事件数据
      - `execution_time_ms` (numeric) - 执行时间（毫秒）
      - `error_message` (text) - 错误信息
      - `created_at` (timestamptz) - 创建时间
    
    - `dispatch_performance_metrics` - 性能指标表
      - `id` (uuid, primary key)
      - `metric_name` (text) - 指标名称
      - `metric_value` (numeric) - 指标值
      - `metric_unit` (text) - 单位
      - `metadata` (jsonb) - 元数据
      - `measured_at` (timestamptz) - 测量时间
  
  2. 索引
    - 按类型和时间查询优化
    - 按用户查询优化
    - 错误日志快速查询
    - 性能指标按名称查询
  
  3. 安全性
    - 启用RLS
    - 只有管理员可以查看日志和指标
*/

-- 创建系统日志表
CREATE TABLE IF NOT EXISTS dispatch_system_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  log_type text NOT NULL CHECK (log_type IN ('assignment', 'timeout', 'error', 'performance', 'health_check')),
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  assignment_id uuid REFERENCES dispatch_assignments(id) ON DELETE SET NULL,
  event_name text NOT NULL,
  event_data jsonb,
  execution_time_ms numeric,
  error_message text,
  created_at timestamptz DEFAULT now()
);

-- 索引优化查询
CREATE INDEX IF NOT EXISTS idx_dispatch_logs_type_created 
ON dispatch_system_logs(log_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dispatch_logs_user_created 
ON dispatch_system_logs(user_id, created_at DESC)
WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_dispatch_logs_error 
ON dispatch_system_logs(log_type, created_at DESC)
WHERE log_type = 'error';

CREATE INDEX IF NOT EXISTS idx_dispatch_logs_assignment 
ON dispatch_system_logs(assignment_id, created_at DESC)
WHERE assignment_id IS NOT NULL;

-- 创建性能指标表
CREATE TABLE IF NOT EXISTS dispatch_performance_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_name text NOT NULL,
  metric_value numeric NOT NULL,
  metric_unit text,
  metadata jsonb,
  measured_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_perf_metrics_name_time 
ON dispatch_performance_metrics(metric_name, measured_at DESC);

-- 启用RLS
ALTER TABLE dispatch_system_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_performance_metrics ENABLE ROW LEVEL SECURITY;

-- RLS策略：只有管理员能查看
CREATE POLICY "Admins can view system logs"
  ON dispatch_system_logs FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.username = current_user
    )
  );

CREATE POLICY "Admins can view performance metrics"
  ON dispatch_performance_metrics FOR SELECT
  TO public
  USING (
    EXISTS (
      SELECT 1 FROM admins
      WHERE admins.username = current_user
    )
  );

-- 验证创建成功
DO $$
BEGIN
  RAISE NOTICE '✅ 监控系统创建完成';
  RAISE NOTICE '   - dispatch_system_logs: 系统日志表';
  RAISE NOTICE '   - dispatch_performance_metrics: 性能指标表';
  RAISE NOTICE '   - 4个日志索引 + 1个指标索引';
  RAISE NOTICE '   - RLS已启用，仅管理员可查看';
END $$;
