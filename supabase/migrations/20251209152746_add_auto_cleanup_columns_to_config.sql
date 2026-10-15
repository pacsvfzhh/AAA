/*
  # 添加自动清理配置列
  
  ## 新增列
  1. **retention_days**: 当前使用的保留天数
  2. **auto_cleanup_enabled**: 是否启用自动清理
  3. **cleanup_schedule**: 清理计划说明
  
  ## 逻辑
  - retention_days 默认使用 default_retention_days
  - auto_cleanup_enabled 默认为 true
  - cleanup_schedule 默认为 "每天凌晨 2:00"
*/

-- 添加新列
ALTER TABLE history_cleanup_config
ADD COLUMN IF NOT EXISTS retention_days integer,
ADD COLUMN IF NOT EXISTS auto_cleanup_enabled boolean DEFAULT true,
ADD COLUMN IF NOT EXISTS cleanup_schedule text DEFAULT '每天凌晨 2:00';

-- 初始化 retention_days 为 default_retention_days
UPDATE history_cleanup_config
SET retention_days = default_retention_days
WHERE retention_days IS NULL;

-- 设置非空约束
ALTER TABLE history_cleanup_config
ALTER COLUMN retention_days SET NOT NULL;

COMMENT ON COLUMN history_cleanup_config.retention_days IS 'Current retention period in days (can be overridden from default)';
COMMENT ON COLUMN history_cleanup_config.auto_cleanup_enabled IS 'Whether automatic cleanup is enabled for this table';
COMMENT ON COLUMN history_cleanup_config.cleanup_schedule IS 'Description of cleanup schedule';
