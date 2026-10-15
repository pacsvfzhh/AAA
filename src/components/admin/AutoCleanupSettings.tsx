/**
 * Auto Cleanup Settings Component
 *
 * 自动清理配置界面 - 增强版
 * - 显示当前配置和计划
 * - 支持默认配置和自定义配置
 * - 显示下次执行时间
 */

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Settings, Play, Pause, Clock, CheckCircle, XCircle, History, RefreshCw, RotateCcw, CalendarClock, AlertTriangle } from 'lucide-react';
import { autoCleanupService, CleanupSchedule, CleanupResult } from '../../services/autoCleanupService';

interface AutoCleanupSettingsProps {
  onClose: () => void;
}

export default function AutoCleanupSettings({ onClose }: AutoCleanupSettingsProps) {
  const [schedule, setSchedule] = useState<CleanupSchedule[]>([]);
  const [history, setHistory] = useState<CleanupResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [serviceStatus, setServiceStatus] = useState(autoCleanupService.getStatus());
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showSuccessMessage, setShowSuccessMessage] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    const scrollY = window.scrollY;
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';
    return () => {
      document.body.style.overflow = '';
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, scrollY);
    };
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);

      // 加载当前配置
      const scheduleData = await autoCleanupService.getCurrentSchedule();
      setSchedule(scheduleData);

      // 加载清理历史
      const historyData = await autoCleanupService.getCleanupHistory();
      setHistory(historyData);

      // 获取服务状态
      setServiceStatus(autoCleanupService.getStatus());
    } catch (error) {
      console.error('Failed to load auto cleanup settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleToggleTable = (tableName: string) => {
    const updated = schedule.map(item => {
      if (item.table_name === tableName) {
        return { ...item, enabled: !item.enabled };
      }
      return item;
    });

    setSchedule(updated);
    setHasUnsavedChanges(true);
  };

  const handleUpdateDays = (tableName: string, days: number) => {
    const updated = schedule.map(item => {
      if (item.table_name === tableName) {
        return { ...item, days_to_keep: days };
      }
      return item;
    });

    setSchedule(updated);
    setHasUnsavedChanges(true);
  };

  const handleUpdateTime = (tableName: string, time: string) => {
    const updated = schedule.map(item => {
      if (item.table_name === tableName) {
        return { ...item, schedule_time: time };
      }
      return item;
    });

    setSchedule(updated);
    setHasUnsavedChanges(true);
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      const success = await autoCleanupService.updateSchedule(schedule);

      if (success) {
        setHasUnsavedChanges(false);
        const now = new Date();
        setLastSaved(now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        setSuccessMessage('保存成功！');
        setShowSuccessMessage(true);
        setTimeout(() => {
          setShowSuccessMessage(false);
          setLastSaved(null);
        }, 3000);
      } else {
        setSuccessMessage('保存失败，请重试');
        setShowSuccessMessage(true);
        setTimeout(() => setShowSuccessMessage(false), 3000);
      }
    } catch (error) {
      console.error('Failed to save schedule:', error);
      setSuccessMessage('保存失败，请重试');
      setShowSuccessMessage(true);
      setTimeout(() => setShowSuccessMessage(false), 3000);
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetToDefault = () => {
    setShowResetConfirm(true);
  };

  const confirmReset = async () => {
    setShowResetConfirm(false);

    try {
      setSaving(true);
      const success = await autoCleanupService.resetToDefaultSchedule();
      if (success) {
        await loadSettings();
        setHasUnsavedChanges(false);
        const now = new Date();
        setLastSaved(now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
        setSuccessMessage('已成功重置为默认配置！');
        setShowSuccessMessage(true);
        setTimeout(() => {
          setShowSuccessMessage(false);
          setLastSaved(null);
        }, 3000);
      } else {
        setSuccessMessage('重置失败，请重试');
        setShowSuccessMessage(true);
        setTimeout(() => setShowSuccessMessage(false), 3000);
      }
    } catch (error) {
      console.error('Failed to reset to default:', error);
      setSuccessMessage('重置失败，请重试');
      setShowSuccessMessage(true);
      setTimeout(() => setShowSuccessMessage(false), 3000);
    } finally {
      setSaving(false);
    }
  };

  const cancelReset = () => {
    setShowResetConfirm(false);
  };

  const handleRefresh = () => {
    loadSettings();
  };

  // 计算下次执行时间
  const getNextRunTime = (item: CleanupSchedule) => {
    if (!item.enabled) return '未启用';

    const now = new Date();
    const [hours, minutes] = item.schedule_time.split(':').map(Number);

    const today = new Date(now);
    today.setHours(hours, minutes, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 如果今天的时间已过，返回明天
    if (now > today) {
      return `明天 ${item.schedule_time}`;
    }

    // 如果今天已经执行过，返回明天
    if (item.last_run_at) {
      const lastRun = new Date(item.last_run_at);
      const lastRunDate = lastRun.toISOString().split('T')[0];
      const todayDate = now.toISOString().split('T')[0];

      if (lastRunDate === todayDate) {
        return `明天 ${item.schedule_time}`;
      }
    }

    return `今天 ${item.schedule_time}`;
  };

  // 计算将清理哪天的数据
  const getCleanupDate = (item: CleanupSchedule) => {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - item.days_to_keep);
    return cutoffDate.toISOString().split('T')[0] + ' 之前';
  };

  // 获取表名的中文说明
  const getTableInfo = (tableName: string): { label: string; description: string; warning?: string } => {
    const tableInfo: Record<string, { label: string; description: string; warning?: string }> = {
      // 高频操作数据
      'dispatch_assignments': {
        label: '派单分配记录',
        description: '员工接单、完成、失败的详细记录',
        warning: '清理后无法追溯历史派单'
      },
      'dispatch_sessions': {
        label: '派单会话',
        description: '员工上下线和工作会话记录',
        warning: '清理后无法统计历史在线时长'
      },
      'work_sessions': {
        label: '工作会话追踪',
        description: '员工登录登出和工作时长统计',
        warning: '清理后无法查看历史工作记录'
      },
      'dispatch_system_logs': {
        label: '派单系统日志',
        description: '系统运行日志和调试信息',
        warning: '清理后无法排查历史问题'
      },
      'dispatch_performance_metrics': {
        label: '派单性能指标',
        description: '派单系统的性能监控数据',
        warning: '清理后无法分析历史性能趋势'
      },
      'used_order_data': {
        label: 'Valid Data使用记录',
        description: '记录Valid Data被分配使用的历史，删除后相关数据可被再次分配',
        warning: '清理后无法追溯数据分配历史'
      },
      'valid_order_data': {
        label: '订单验证数据池',
        description: '用于订单验证的数据池，建议保留足够数据',
        warning: '⚠️ 谨慎！清理后可能影响派单功能'
      },

      // 审计日志
      'valid_data_audit_log': {
        label: '有效数据审计日志',
        description: '数据变更和审计追踪记录',
        warning: '清理后无法审计历史数据变更'
      },
      'valid_data_error_log': {
        label: '有效数据错误日志',
        description: '数据处理错误和异常记录',
        warning: '清理后无法排查历史错误'
      },
      'valid_data_query_performance': {
        label: '查询性能记录',
        description: '数据库查询性能监控',
        warning: '清理后无法优化查询性能'
      },
      'commission_audit_log': {
        label: '佣金审计日志',
        description: '佣金发放、扣除的完整审计记录',
        warning: '⚠️ 谨慎！清理后无法追溯佣金变更'
      },
      'money_data_protection_audit': {
        label: '资金数据保护审计',
        description: '资金操作的安全审计和防护记录',
        warning: '⚠️ 谨慎！清理后无法审计资金安全操作'
      },
      'bulk_import_log': {
        label: '批量导入日志',
        description: '批量导入有效数据的操作记录',
        warning: '清理后无法追溯批量导入操作'
      },

      // 客服数据
      'customer_service_sessions': {
        label: '客服会话',
        description: '客服对话会话记录',
        warning: '清理后无法查看历史对话'
      },
      'customer_service_messages': {
        label: '客服消息',
        description: '客服聊天消息详细内容',
        warning: '清理后消息内容永久丢失'
      },
      'customer_service_ratings': {
        label: '客服评价',
        description: '用户对客服的评分记录',
        warning: '清理后无法统计历史评价'
      },

      // 通知消息
      'messages': {
        label: '系统消息',
        description: '管理员发送给员工的通知',
        warning: '清理后员工无法查看历史消息'
      },

      // 财务数据
      'wallet_transactions': {
        label: '钱包交易记录',
        description: '所有充值、提现、佣金流水',
        warning: '⚠️ 谨慎！清理后无法追溯资金流向'
      },
      'withdrawals': {
        label: '提现记录',
        description: '员工提现申请和审核记录',
        warning: '⚠️ 谨慎！清理后无法查询历史提现'
      },

      // 订单数据
      'orders': {
        label: '订单记录',
        description: '员工提交的所有订单',
        warning: '⚠️ 谨慎！清理后无法查询历史订单'
      },

      // 历史归档表
      'history_orders': {
        label: '历史订单归档',
        description: '长期保存的历史订单数据',
        warning: '用于长期存储，建议保留更久'
      },
      'orders_history': {
        label: '订单历史归档',
        description: '从订单表自动归档的历史数据',
        warning: '用于长期存储，建议保留更久'
      },
      'history_transactions': {
        label: '历史交易归档',
        description: '长期保存的历史交易数据',
        warning: '用于长期存储，建议保留更久'
      },
      'history_work_sessions': {
        label: '历史工作记录归档',
        description: '长期保存的工作记录数据',
        warning: '用于长期存储，建议保留更久'
      },
      'valid_order_data_archive': {
        label: '有效订单数据归档',
        description: '有效数据池的历史归档记录',
        warning: '用于长期存储，建议保留更久'
      }
    };

    return tableInfo[tableName] || {
      label: tableName,
      description: '数据表',
      warning: '请谨慎设置清理策略'
    };
  };

  // 统计信息
  const enabledCount = schedule.filter(s => s.enabled).length;
  const totalCount = schedule.length;

  return createPortal(
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[9999] p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-7xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between bg-gradient-to-r from-blue-50 to-indigo-50">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600 rounded-lg">
              <Settings className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">自动清理配置</h2>
              <p className="text-sm text-gray-600">
                配置每日自动清理任务 · 当前启用 {enabledCount}/{totalCount} 个表
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleResetToDefault}
              disabled={saving}
              className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              title="重置为推荐配置"
            >
              <RotateCcw className="w-4 h-4" />
              重置为默认
            </button>
            <button
              onClick={handleRefresh}
              className="p-2 hover:bg-white rounded-lg transition-colors"
              title="刷新"
            >
              <RefreshCw className="w-5 h-5 text-gray-600" />
            </button>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              ×
            </button>
          </div>
        </div>

        {/* Service Status */}
        <div className="px-6 py-3 bg-gray-50 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {serviceStatus.isRunning ? (
                <>
                  <Play className="w-4 h-4 text-green-600" />
                  <span className="text-sm font-medium text-green-700">自动清理服务运行中</span>
                  <span className="text-xs text-gray-500">· 每小时检查配置</span>
                </>
              ) : (
                <>
                  <Pause className="w-4 h-4 text-gray-600" />
                  <span className="text-sm font-medium text-gray-700">自动清理服务已停止</span>
                  <span className="text-xs text-gray-500">· 登录后自动启动</span>
                </>
              )}
            </div>
            <div className="text-xs text-gray-500">
              最后检查: {serviceStatus.lastCheckDate || '未执行'}
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Info Box */}
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <div className="flex gap-3">
                  <Clock className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <h3 className="font-semibold text-blue-900 mb-1">工作原理与补偿机制</h3>
                    <p className="text-sm text-blue-800 leading-relaxed">
                      <strong>正常运行：</strong> 系统每小时检查一次配置，在指定时间（前后30分钟内）自动执行清理任务。每个表每天最多执行一次。
                      <br />
                      <strong>补偿机制：</strong> 如果昨天错过清理（如凌晨无人登录），下次登录时会自动检测并立即补上，确保数据正常清理。
                    </p>
                  </div>
                </div>
              </div>

              {/* Table Configuration */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <CalendarClock className="w-5 h-5" />
                  清理计划配置
                </h3>
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 mb-3">
                  <p className="text-sm text-gray-700">
                    <span className="font-medium">配置说明：</span>
                    开关切换、天数修改、时间调整会立即自动保存。你可以结合使用默认配置和自定义设置。
                  </p>
                </div>
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">状态</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">表名 / 说明</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">保留天数</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">执行时间</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">下次执行</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">清理范围</th>
                          <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">最后运行</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {schedule.map((item) => {
                          const tableInfo = getTableInfo(item.table_name);
                          return (
                            <tr key={item.table_name} className={`hover:bg-gray-50 ${!item.enabled ? 'opacity-60' : ''}`}>
                              <td className="px-4 py-3">
                                <button
                                  onClick={() => handleToggleTable(item.table_name)}
                                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                    item.enabled ? 'bg-green-600' : 'bg-gray-300'
                                  }`}
                                >
                                  <span
                                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                                      item.enabled ? 'translate-x-6' : 'translate-x-1'
                                    }`}
                                  />
                                </button>
                              </td>
                              <td className="px-4 py-3">
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold text-gray-900">{tableInfo.label}</span>
                                    {tableInfo.warning?.includes('⚠️') && (
                                      <span className="px-1.5 py-0.5 text-xs font-medium bg-red-100 text-red-700 rounded">
                                        重要
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs font-mono text-gray-500">{item.table_name}</div>
                                  <div className="text-xs text-gray-600">{tableInfo.description}</div>
                                  {tableInfo.warning && (
                                    <div className={`text-xs ${tableInfo.warning.includes('⚠️') ? 'text-red-600 font-medium' : 'text-amber-600'}`}>
                                      ⚠️ {tableInfo.warning}
                                    </div>
                                  )}
                                </div>
                              </td>
                            <td className="px-4 py-3">
                              <input
                                type="number"
                                value={item.days_to_keep}
                                onChange={(e) => handleUpdateDays(item.table_name, parseInt(e.target.value))}
                                min="14"
                                max="3650"
                                disabled={!item.enabled}
                                className="w-20 px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
                              />
                              <span className="ml-1 text-xs text-gray-500">天</span>
                            </td>
                            <td className="px-4 py-3">
                              <input
                                type="time"
                                value={item.schedule_time}
                                onChange={(e) => handleUpdateTime(item.table_name, e.target.value)}
                                disabled={!item.enabled}
                                className="px-2 py-1 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-100"
                              />
                            </td>
                            <td className="px-4 py-3 text-xs">
                              <span className={`font-medium ${item.enabled ? 'text-blue-700' : 'text-gray-500'}`}>
                                {getNextRunTime(item)}
                              </span>
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-600">
                              {item.enabled ? getCleanupDate(item) : '-'}
                            </td>
                            <td className="px-4 py-3 text-xs text-gray-600">
                              {item.last_run_at
                                ? new Date(item.last_run_at).toLocaleString('zh-CN', {
                                    month: '2-digit',
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit'
                                  })
                                : '从未运行'}
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Cleanup History */}
              <div>
                <h3 className="font-semibold text-gray-900 mb-3 flex items-center gap-2">
                  <History className="w-5 h-5" />
                  最近清理历史
                </h3>
                {history.length === 0 ? (
                  <div className="bg-gray-50 rounded-lg p-8 text-center">
                    <Clock className="w-12 h-12 text-gray-400 mx-auto mb-3" />
                    <p className="text-gray-600">暂无清理历史</p>
                    <p className="text-sm text-gray-500 mt-1">系统将在配置的时间自动执行清理</p>
                  </div>
                ) : (
                  <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                    <div className="max-h-64 overflow-y-auto">
                      <table className="min-w-full divide-y divide-gray-200">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">时间</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">表名</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">结果</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">删除记录</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">释放空间</th>
                            <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">备注</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-200">
                          {history.slice(0, 15).map((item, index) => {
                            const isCompensation = item.message?.includes('[Compensation]');
                            return (
                              <tr key={index} className="hover:bg-gray-50">
                                <td className="px-4 py-2 text-xs text-gray-600">
                                  {new Date(item.timestamp).toLocaleString('zh-CN', {
                                    month: '2-digit',
                                    day: '2-digit',
                                    hour: '2-digit',
                                    minute: '2-digit'
                                  })}
                                </td>
                                <td className="px-4 py-2 text-xs font-mono text-gray-900">{item.table_name}</td>
                                <td className="px-4 py-2">
                                  {item.success ? (
                                    <span className="inline-flex items-center gap-1 text-xs text-green-700">
                                      <CheckCircle className="w-3 h-3" />
                                      成功
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-xs text-red-700">
                                      <XCircle className="w-3 h-3" />
                                      失败
                                    </span>
                                  )}
                                </td>
                                <td className="px-4 py-2 text-xs text-gray-900">{item.records_deleted.toLocaleString()}</td>
                                <td className="px-4 py-2 text-xs text-gray-900">{item.space_freed}</td>
                                <td className="px-4 py-2">
                                  {isCompensation && (
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 text-xs rounded-full border border-amber-200">
                                      补偿执行
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 bg-gray-50 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {hasUnsavedChanges && !lastSaved && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-lg">
                <Clock className="w-4 h-4 text-amber-600" />
                <span className="text-xs font-medium text-amber-700">
                  有未保存的修改
                </span>
              </div>
            )}
            {lastSaved && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 bg-green-50 border border-green-200 rounded-lg animate-in fade-in">
                <CheckCircle className="w-4 h-4 text-green-600" />
                <span className="text-xs font-medium text-green-700">
                  已保存 {lastSaved}
                </span>
              </div>
            )}
          </div>
          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={!hasUnsavedChanges || isSaving}
              className={`px-4 py-2 rounded-lg font-medium transition-all ${
                hasUnsavedChanges && !isSaving
                  ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                  : 'bg-gray-200 text-gray-400 cursor-not-allowed'
              }`}
            >
              {isSaving ? (
                <span className="flex items-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  保存中...
                </span>
              ) : (
                '保存配置'
              )}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              关闭
            </button>
          </div>
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[10000]">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
            <div className="px-6 py-4 bg-gradient-to-r from-amber-50 to-orange-50 border-b border-amber-200">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-amber-500 rounded-lg">
                  <AlertTriangle className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-lg font-bold text-gray-900">确认重置配置</h3>
              </div>
            </div>
            <div className="px-6 py-4">
              <p className="text-gray-700 leading-relaxed">
                确定要重置为默认配置吗？
              </p>
              <p className="text-sm text-amber-700 mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <span className="font-medium">注意：</span>所有自定义设置（开关状态、保留天数、执行时间）将被恢复为推荐的默认值，此操作无法撤销。
              </p>
            </div>
            <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex items-center justify-end gap-3">
              <button
                onClick={cancelReset}
                className="px-4 py-2 text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                取消
              </button>
              <button
                onClick={confirmReset}
                disabled={saving}
                className="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                {saving ? '重置中...' : '确认重置'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Success Message Toast */}
      {showSuccessMessage && (
        <div className="fixed top-4 right-4 z-[10001] animate-in slide-in-from-top-2">
          <div className="bg-white rounded-lg shadow-2xl border border-gray-200 px-4 py-3 flex items-center gap-3 min-w-[300px]">
            <div className={`p-1 rounded-full ${successMessage.includes('成功') ? 'bg-green-100' : 'bg-red-100'}`}>
              {successMessage.includes('成功') ? (
                <CheckCircle className="w-5 h-5 text-green-600" />
              ) : (
                <XCircle className="w-5 h-5 text-red-600" />
              )}
            </div>
            <div className="flex-1">
              <p className={`text-sm font-medium ${successMessage.includes('成功') ? 'text-green-900' : 'text-red-900'}`}>
                {successMessage}
              </p>
            </div>
            <button
              onClick={() => setShowSuccessMessage(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
