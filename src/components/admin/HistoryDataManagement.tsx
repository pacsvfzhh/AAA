import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Trash2, AlertTriangle, CheckCircle, Database, Info, RefreshCw, Save, Check, Clock, X } from 'lucide-react';
import { formatSupabaseError, isFinancialAdminSessionError, isSupabaseTransientError, supabase } from '../../lib/supabase';
import type { Database as DatabaseSchema } from '../../types/database';
import { getAdminFinancialSessionToken } from '../../lib/auth';
import { safeToLocaleString } from '../../lib/safeUtils';
import ContentAuditPanel from './ContentAuditPanel';

type CleanupSchedule = DatabaseSchema['public']['Functions']['admin_get_history_cleanup_schedule']['Returns'][number];

interface CleanupConfig {
  category: string;
  display_name: string;
  table_name: string;
  description: string;
  default_retention_days: number;
  min_retention_days: number;
  cleanup_priority: number;
  last_cleanup_at: string | null;
  last_cleanup_records: number;
  cleanup_status: string;
  current_size: string;
  current_record_count: number;
}

interface PreviewResult {
  table_name: string;
  total_records: number;
  records_to_delete: number;
  records_to_keep: number;
  oldest_record: string | null;
  cutoff_date: string;
  estimated_space: string;
  risk_level: string;
  retention_days: number;
}

interface CleanupResult {
  success: boolean;
  records_deleted: number;
  space_freed: string;
  execution_time_ms: number;
  message: string;
}

const tableLabels: Record<string, { name: string; description: string }> = {
  dispatch_assignments: { name: '派單分配紀錄', description: '員工訂單派送歷史紀錄，保留過久可能影響查詢效能。' },
  dispatch_sessions: { name: '派單會話紀錄', description: '員工每次開始與結束派單的會話紀錄。' },
  work_sessions: { name: '工作會話紀錄', description: '員工工作時長的統計會話。' },
  customer_service_sessions: { name: '客服會話紀錄', description: '客服與客戶之間的會話歷史。' },
  used_order_data: { name: '訂單派送使用紀錄', description: '清理使用紀錄後，對應驗證資料可回流至可用池。' },
  valid_order_data: { name: '訂單驗證資料回流', description: '將符合條件的已用驗證資料重新啟用，供再次派送。' },
  valid_data_audit_log: { name: '驗證資料稽核紀錄', description: '記錄驗證資料的變更與操作。' },
  valid_data_error_log: { name: '驗證資料錯誤紀錄', description: '記錄驗證資料的異常與錯誤。' },
  dispatch_system_logs: { name: '派單系統日誌', description: '派單系統的執行與錯誤紀錄。' },
  commission_audit_log: { name: '佣金稽核紀錄', description: '佣金計算與發放的稽核資料。' },
  money_data_protection_audit: { name: '資金保護稽核', description: '資金操作的安全稽核資料。' },
  dispatch_performance_metrics: { name: '派單效能指標', description: '派單系統的效能監測資料。' },
  valid_data_query_performance: { name: '查詢效能紀錄', description: '驗證資料的查詢效能監測紀錄。' },
  orders_history: { name: '訂單歷史封存', description: '已封存的歷史訂單資料。' },
  valid_order_data_archive: { name: '驗證資料封存', description: '已封存的訂單驗證資料。' },
  bulk_import_log: { name: '批次匯入紀錄', description: '批次資料匯入的歷史紀錄。' },
};

const getTableName = (config: CleanupConfig) => tableLabels[config.table_name]?.name ?? config.display_name;
const getTableDescription = (config: CleanupConfig) => tableLabels[config.table_name]?.description ?? config.description;
const formatSize = (size: string) => size.replace(/\bbytes?\b/gi, '位元組').replace(/\brecords?\b/gi, '筆紀錄').replace(/^N\/A$/i, '無資料');
const utcTimePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const hourOptions = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0'));
const minuteOptions = Array.from({ length: 12 }, (_, step) => String(step * 5).padStart(2, '0'));
const quickTimes = ['00:00', '02:00', '02:30', '03:00', '06:00'];

export default function HistoryDataManagement({ isActive }: { isActive: boolean }) {
  const [showAudit, setShowAudit] = useState(false);
  const auditActivations = useRef<number[]>([]);
  const [configs, setConfigs] = useState<CleanupConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<CleanupConfig | null>(null);
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null);
  const [showPreviewModal, setShowPreviewModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [autoCleanupSchedule, setAutoCleanupSchedule] = useState<CleanupSchedule[]>([]);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  const scheduleRequestId = useRef(0);
  const [editingRetention, setEditingRetention] = useState<Record<string, string>>({});
  const [editingTime, setEditingTime] = useState<Record<string, string>>({});
  const [timePicker, setTimePicker] = useState<{ tableName: string; label: string; time: string } | null>(null);
  const [savingTable, setSavingTable] = useState<string | null>(null);
  const [savedTable, setSavedTable] = useState<string | null>(null);

  useEffect(() => {
    loadConfigs();
    loadAutoCleanupSchedule();
    return () => { scheduleRequestId.current += 1; };
  }, []);

  useEffect(() => {
    if (!isActive) {
      setShowAudit(false);
      auditActivations.current = [];
    }
  }, [isActive]);

  const handleAuditActivation = () => {
    const now = Date.now();
    auditActivations.current = [...auditActivations.current.filter(time => now - time <= 1100), now];
    if (auditActivations.current.length >= 3) {
      auditActivations.current = [];
      setShowAudit(true);
    }
  };

  const isTimePickerOpen = timePicker !== null;

  useEffect(() => {
    const anyModalOpen = showPreviewModal || showConfirmModal || isTimePickerOpen;
    if (anyModalOpen) {
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
    }
  }, [showPreviewModal, showConfirmModal, isTimePickerOpen]);

  useEffect(() => {
    if (!isTimePickerOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTimePicker(null);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isTimePickerOpen]);

  const loadConfigs = async (silent = false): Promise<boolean> => {
    try {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      const { data, error } = await supabase
        .from('history_cleanup_summary')
        .select('*')
        .order('cleanup_priority', { ascending: false });

      if (error) throw error;
      setConfigs(data || []);
      return true;
    } catch (err) {
      console.error('Error loading cleanup configs:', err);
      setError('載入歷史資料失敗，請稍後重試。');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const loadAutoCleanupSchedule = async (): Promise<boolean> => {
    const requestId = ++scheduleRequestId.current;
    try {
      const { data, error } = await supabase.rpc('admin_get_history_cleanup_schedule', {
        p_admin_session_token: getAdminFinancialSessionToken(),
      });
      if (requestId !== scheduleRequestId.current) return false;
      if (error) throw error;
      setAutoCleanupSchedule(data ?? []);
      setScheduleLoaded(true);
      return true;
    } catch (err) {
      if (requestId !== scheduleRequestId.current) return false;
      console.error('Error loading auto cleanup schedule:', formatSupabaseError(err));
      setScheduleLoaded(false);
      setError(isFinancialAdminSessionError(err)
        ? '管理員登入已失效，請重新登入。'
        : isSupabaseTransientError(err)
          ? '連線暫時不穩，請按「刷新」重試。'
          : `載入自動清理排程失敗：${formatSupabaseError(err)}`);
      return false;
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    setError(null);
    const results = await Promise.all([loadConfigs(true), loadAutoCleanupSchedule()]);
    setLastRefreshedAt(results.every(Boolean) ? new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null);
    setRefreshing(false);
  };

  const getScheduleForTable = useCallback((tableName: string) => {
    return autoCleanupSchedule.find(s => s.table_name === tableName);
  }, [autoCleanupSchedule]);

  const handleRetentionChange = (tableName: string, days: string) => {
    if (/^\d*$/.test(days)) {
      setEditingRetention(prev => ({ ...prev, [tableName]: days }));
    }
  };

  const handleTimeChange = (tableName: string, time: string) => {
    const shortHourTime = time.match(/^(\d{1,2}):(\d{2})$/);
    const digits = time.replace(/\D/g, '').slice(0, 4);
    const formatted = shortHourTime && shortHourTime[1].length === 1
      ? `${shortHourTime[1].padStart(2, '0')}:${shortHourTime[2]}`
      : digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
    setEditingTime(prev => ({ ...prev, [tableName]: formatted }));
  };

  const handleToggleEnabled = async (tableName: string) => {
    const scheduleItem = getScheduleForTable(tableName);
    if (!scheduleItem) return;

    setSavingTable(tableName);
    setError(null);
    try {
      const { error } = await supabase.rpc('admin_save_history_cleanup_schedule', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_table_name: tableName,
        p_days_to_keep: scheduleItem.days_to_keep,
        p_schedule_time: scheduleItem.schedule_time,
        p_enabled: !scheduleItem.enabled,
      });
      if (error) throw error;
      const results = await Promise.all([loadConfigs(true), loadAutoCleanupSchedule()]);
      if (!results.every(Boolean)) return;
      setSavedTable(tableName);
      setTimeout(() => setSavedTable(null), 2000);
    } catch (err) {
      console.error('Error saving auto cleanup schedule:', err);
      setError('儲存自動清理設定失敗，請稍後重試。');
    } finally {
      setSavingTable(null);
    }
  };

  const handleSaveSchedule = async (config: CleanupConfig) => {
    const tableName = config.table_name;
    const scheduleItem = getScheduleForTable(tableName);
    if (!scheduleItem) return;
    const newDays = editingRetention[tableName];
    const newTime = editingTime[tableName];
    if (newDays === undefined && newTime === undefined) return;
    const daysToKeep = Number(newDays ?? scheduleItem.days_to_keep);
    const scheduleTime = newTime ?? scheduleItem.schedule_time;
    if (newDays === '' || !Number.isInteger(daysToKeep) || daysToKeep < config.min_retention_days || daysToKeep > 2147483647 || !utcTimePattern.test(scheduleTime)) return;

    setSavingTable(tableName);
    setError(null);
    try {
      const { error } = await supabase.rpc('admin_save_history_cleanup_schedule', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_table_name: tableName,
        p_days_to_keep: daysToKeep,
        p_schedule_time: scheduleTime,
        p_enabled: scheduleItem.enabled,
      });
      if (error) throw error;
      const results = await Promise.all([loadConfigs(true), loadAutoCleanupSchedule()]);
      if (!results.every(Boolean)) return;
      setEditingRetention(prev => {
        const next = { ...prev };
        delete next[tableName];
        return next;
      });
      setEditingTime(prev => {
        const next = { ...prev };
        delete next[tableName];
        return next;
      });
      setSavedTable(tableName);
      setTimeout(() => setSavedTable(null), 2000);
    } catch (err) {
      console.error('Error saving auto cleanup schedule:', err);
      setError('儲存自動清理設定失敗，請稍後重試。');
    } finally {
      setSavingTable(null);
    }
  };

  const handlePreview = async (config: CleanupConfig) => {
    try {
      setProcessing(true);
      setError(null);
      setSelectedTable(config);

      const { data, error } = await supabase.rpc('admin_preview_history_cleanup', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_table_name: config.table_name,
      });

      if (error) throw error;
      if (data && data.length > 0) {
        setPreviewResult(data[0]);
        setShowPreviewModal(true);
      }
    } catch (err) {
      console.error('Error previewing cleanup:', err);
      setError('無法預覽清理結果，請稍後重試。');
    } finally {
      setProcessing(false);
    }
  };

  const handleExecuteCleanup = async () => {
    if (!selectedTable || !previewResult) return;

    try {
      setProcessing(true);
      setError(null);
      setShowPreviewModal(false);

      const { data, error } = await supabase.rpc('admin_execute_history_cleanup', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_table_name: selectedTable.table_name,
        p_expected_retention_days: previewResult.retention_days,
      });

      if (error) throw error;
      if (data && data.length > 0) {
        setCleanupResult(data[0]);
        setShowConfirmModal(true);
      }
    } catch (err) {
      console.error('Error executing cleanup:', err);
      setError('執行清理失敗，設定或資料可能已變更，請重新預覽。');
    } finally {
      setProcessing(false);
    }
  };

  const handleCloseResultModal = () => {
    setShowConfirmModal(false);
    setCleanupResult(null);
    setSelectedTable(null);
    loadConfigs(true);
  };

  const getCategoryColor = (category: string) => {
    switch (category) {
      case 'operational': return 'from-sky-600 via-blue-600 to-indigo-600';
      case 'audit': return 'from-violet-600 via-purple-600 to-fuchsia-600';
      case 'performance': return 'from-emerald-600 via-teal-600 to-cyan-600';
      case 'archive': return 'from-amber-600 via-orange-600 to-rose-600';
      default: return 'from-slate-600 via-slate-700 to-slate-800';
    }
  };

  const getCategoryLabel = (category: string) => {
    switch (category) {
      case 'operational': return '日常作業資料';
      case 'audit': return '稽核與日誌';
      case 'performance': return '效能指標';
      case 'archive': return '歷史封存';
      default: return '其他資料';
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Never cleaned':
      case 'never_cleaned': return 'text-rose-700';
      case 'Cleanup overdue':
      case 'needs_cleanup': return 'text-orange-700';
      case 'Consider cleanup':
      case 'due_soon': return 'text-amber-700';
      case 'Recently cleaned':
      case 'up_to_date': return 'text-emerald-700';
      case 'disabled': return 'text-slate-500';
      case 'waiting': return 'text-sky-700';
      case 'due': return 'text-orange-700';
      default: return 'text-slate-600';
    }
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'Never cleaned':
      case 'never_cleaned': return '尚未清理';
      case 'Cleanup overdue':
      case 'needs_cleanup': return '清理逾期';
      case 'Consider cleanup':
      case 'due_soon': return '建議清理';
      case 'Recently cleaned':
      case 'up_to_date': return '今日排程已完成';
      case 'disabled': return '自動清理已關閉';
      case 'waiting': return '等待今日排程';
      case 'due': return '今日排程待執行';
      default: return '狀態未知';
    }
  };

  const getTableWarning = (tableName: string): { warning: string; color: string } | null => {
    switch (tableName) {
      case 'used_order_data':
        return {
          warning: '派送紀錄清理後，對應的驗證資料可回流至可用池，供員工再次使用。',
          color: 'text-sky-700'
        };
      case 'valid_order_data':
        return {
          warning: '符合條件的驗證資料將重新啟用並回流至可用池，不會刪除驗證資料。',
          color: 'text-sky-700'
        };
      default:
        return null;
    }
  };

  const groupedConfigs = configs.reduce((acc, config) => {
    if (!acc[config.category]) {
      acc[config.category] = [];
    }
    acc[config.category].push(config);
    return acc;
  }, {} as Record<string, CleanupConfig[]>);

  if (showAudit && isActive) {
    return <ContentAuditPanel onBack={() => setShowAudit(false)} />;
  }

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-white text-slate-600">
        <RefreshCw className="mr-3 h-5 w-5 animate-spin text-blue-600" />
        載入歷史資料中…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-white text-slate-900">
      <div className="relative isolate shrink-0 overflow-hidden border-b border-cyan-600/40 bg-[linear-gradient(112deg,#081529_0%,#14284b_35%,#0d4253_70%,#0b263e_100%)] px-4 py-4 sm:px-6">
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-cyan-300 to-amber-400" />
        <div aria-hidden="true" className="pointer-events-none absolute -right-10 -top-20 h-44 w-60 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={handleAuditActivation}
              aria-label="開啟內容稽核總覽：一秒內連續按三次"
              title="一秒內連續按三次開啟內容稽核總覽"
              className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 via-cyan-500 to-teal-500 text-white shadow-[0_10px_24px_-12px_rgba(34,211,238,0.8)] ring-1 ring-cyan-200/60 transition-colors hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
            >
              <Database className="h-5 w-5" aria-hidden="true" />
            </button>
            <div className="min-w-0">
              <h2 className="text-lg font-extrabold tracking-tight text-white">歷史資料管理</h2>
              <p className="mt-0.5 text-xs leading-5 text-slate-200">各類資料可分別設定保留天數和每日執行時間（UTC）；自動清理可逐項開關。</p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              aria-busy={refreshing}
              className="group inline-flex h-[38px] w-[104px] items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-cyan-300/60 bg-gradient-to-r from-cyan-500 via-blue-600 to-indigo-600 px-2 text-xs font-bold text-white shadow-[0_8px_20px_-9px_rgba(34,211,238,0.65)] transition-all hover:brightness-110 hover:shadow-[0_10px_22px_-8px_rgba(34,211,238,0.75)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 disabled:cursor-wait disabled:opacity-70"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : 'transition-transform duration-300 group-hover:rotate-45'}`} aria-hidden="true" />
              {refreshing ? '刷新中…' : '刷新'}
            </button>
            {lastRefreshedAt && <span role="status" className="text-[10px] text-cyan-200">上次刷新 {lastRefreshedAt}</span>}
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 border-b border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 sm:px-6">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-dark">
        {configs.length === 0 && <p className="px-6 py-12 text-center text-sm text-slate-500">目前沒有可管理的歷史資料。</p>}
        {Object.entries(groupedConfigs).map(([category, categoryConfigs]) => (
          <section key={category} className="border-b border-slate-200 last:border-b-0">
            <div className={`flex items-center gap-3 bg-gradient-to-r px-5 py-3 text-white shadow-sm sm:px-6 ${getCategoryColor(category)}`}>
              <h3 className="text-sm font-bold tracking-wide">{getCategoryLabel(category)}</h3>
              <span className="ml-auto rounded-full bg-white/20 px-2.5 py-1 text-xs font-semibold text-white ring-1 ring-white/30">{categoryConfigs.length} 項資料</span>
            </div>

            <div className="overflow-x-auto scrollbar-dark">
              <table className="w-full min-w-[1200px] table-fixed">
                <colgroup>
                  <col className="w-[23%]" />
                  <col className="w-[10%]" />
                  <col className="w-[16%]" />
                  <col className="w-[12%]" />
                  <col className="w-[8%]" />
                  <col className="w-[13%]" />
                  <col className="w-[18%]" />
                </colgroup>
                <thead className="border-b border-blue-200 bg-gradient-to-r from-blue-100 via-sky-100 to-cyan-100">
                  <tr>
                    <th className="px-5 py-3 text-left text-xs font-semibold tracking-wider text-blue-950">資料類型</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold tracking-wider text-blue-950">紀錄／大小</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold tracking-wider text-blue-950">保留天數</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold tracking-wider text-blue-950">執行時間（UTC）</th>
                    <th className="px-5 py-3 text-center text-xs font-semibold tracking-wider text-blue-950">自動清理</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold tracking-wider text-blue-950">狀態</th>
                    <th className="px-5 py-3 text-right text-xs font-semibold tracking-wider text-blue-950">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/80">
                {categoryConfigs.map((config) => {
                  const scheduleItem = getScheduleForTable(config.table_name);
                  const currentDays = editingRetention[config.table_name] ?? String(scheduleItem?.days_to_keep ?? config.default_retention_days);
                  const currentTime = editingTime[config.table_name] ?? scheduleItem?.schedule_time ?? '03:00';
                  const daysToKeep = Number(currentDays);
                  const invalidDays = !/^\d+$/.test(currentDays) || !Number.isInteger(daysToKeep)
                    || daysToKeep < config.min_retention_days || daysToKeep > 2147483647;
                  const invalidTime = !utcTimePattern.test(currentTime);
                  const isEnabled = scheduleItem?.enabled ?? false;
                  const hasChanges = scheduleLoaded && scheduleItem && ((editingRetention[config.table_name] !== undefined && (invalidDays || daysToKeep !== scheduleItem.days_to_keep))
                    || (editingTime[config.table_name] !== undefined && editingTime[config.table_name] !== scheduleItem.schedule_time));
                  const isSaving = savingTable === config.table_name;
                  const justSaved = savedTable === config.table_name;

                  return (
                    <tr key={config.table_name} className="transition-colors even:bg-slate-50/60 hover:bg-blue-50/75">
                      <td className="px-5 py-4">
                        <div>
                          <div className="text-sm font-semibold text-slate-900">{getTableName(config)}</div>
                          <div className="mt-0.5 text-xs text-slate-600">{getTableDescription(config)}</div>
                          {getTableWarning(config.table_name) && (
                            <div className={`mt-1.5 text-xs ${getTableWarning(config.table_name)!.color}`}>
                              {getTableWarning(config.table_name)!.warning}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap">
                        <div className="text-sm font-semibold tabular-nums text-slate-900">
                          {safeToLocaleString(config.current_record_count)}
                        </div>
                        <div className="text-xs text-slate-500">{formatSize(config.current_size)}</div>
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={currentDays}
                            onFocus={(e) => e.currentTarget.select()}
                            onClick={(e) => e.currentTarget.select()}
                            onChange={(e) => handleRetentionChange(config.table_name, e.target.value)}
                            disabled={!scheduleLoaded || !scheduleItem || isSaving}
                            aria-label={`${getTableName(config)}保留天數`}
                            aria-invalid={invalidDays}
                            className={`w-20 rounded-lg border bg-white px-2 py-1.5 text-center text-sm text-slate-900 outline-none transition-colors focus:ring-2 ${invalidDays ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20' : 'border-slate-300 focus:border-blue-500 focus:ring-blue-500/20'}`}
                          />
                          <span className={`text-xs ${invalidDays ? 'text-rose-600' : 'text-slate-500'}`}>至少 {config.min_retention_days} 天</span>
                        </div>
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={currentTime}
                            onFocus={(e) => e.currentTarget.select()}
                            onClick={(e) => e.currentTarget.select()}
                            onChange={(e) => handleTimeChange(config.table_name, e.target.value)}
                            disabled={!scheduleLoaded || !scheduleItem || isSaving}
                            aria-label={`${getTableName(config)}執行時間（UTC），輸入四位數，例如 0930`}
                            aria-invalid={invalidTime}
                            title={invalidTime ? '請輸入有效時間，例如 0930' : '直接輸入四位數時間，例如 0930'}
                            placeholder="HH:MM"
                            maxLength={5}
                            className={`w-16 rounded-lg border bg-white px-1 py-1.5 text-center text-sm tabular-nums text-slate-900 outline-none transition-colors focus:ring-2 ${invalidTime ? 'border-rose-400 focus:border-rose-500 focus:ring-rose-500/20' : 'border-slate-300 focus:border-blue-500 focus:ring-blue-500/20'}`}
                          />
                          <button
                            type="button"
                            onClick={() => setTimePicker({
                              tableName: config.table_name,
                              label: getTableName(config),
                              time: invalidTime ? scheduleItem?.schedule_time ?? '00:00' : currentTime,
                            })}
                            disabled={!scheduleLoaded || !scheduleItem || isSaving}
                            aria-label={`${getTableName(config)}選擇執行時間`}
                            aria-haspopup="dialog"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-blue-700 transition-colors hover:border-blue-400 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-50"
                          >
                            <Clock className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-center">
                        <button
                          onClick={() => handleToggleEnabled(config.table_name)}
                          disabled={isSaving || !scheduleLoaded || !scheduleItem || Boolean(hasChanges)}
                          type="button"
                          role="switch"
                          aria-checked={isEnabled}
                          aria-label={`${getTableName(config)}自動清理`}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-white ${
                            isEnabled ? 'bg-blue-600' : 'bg-slate-300'
                          }`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
                              isEnabled ? 'translate-x-6' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${getStatusColor(config.cleanup_status)}`}>
                          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
                          {getStatusLabel(config.cleanup_status)}
                        </span>
                        {config.last_cleanup_at && (
                          <div className="mt-1 text-xs text-slate-500">
                            上次：{new Date(config.last_cleanup_at).toLocaleDateString('zh-TW')}
                          </div>
                        )}
                      </td>
                      <td className="px-5 py-4 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="flex w-[72px] shrink-0 justify-end">
                            {hasChanges ? (
                              <button
                                onClick={() => handleSaveSchedule(config)}
                                disabled={isSaving || invalidDays || invalidTime}
                                type="button"
                                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                              >
                                {isSaving ? (
                                  <RefreshCw className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Save className="w-3 h-3" />
                                )}
                                儲存
                              </button>
                            ) : justSaved ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                                <Check className="w-3 h-3" />
                                已儲存
                              </span>
                            ) : null}
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              handlePreview(config);
                            }}
                            disabled={processing || !scheduleLoaded || !scheduleItem || Boolean(hasChanges) || isSaving}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 transition-colors hover:border-rose-400 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            <Trash2 className="w-3 h-3" />
                            清理
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                </tbody>
              </table>
            </div>
          </section>
        ))}
      </div>

      {timePicker && createPortal(
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-sm"
          onClick={() => setTimePicker(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="history-time-picker-title"
            className="max-h-[calc(100vh-2rem)] w-full max-w-[400px] overflow-y-auto rounded-2xl bg-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-gradient-to-r from-slate-900 to-blue-950 px-5 py-4 text-white">
              <div>
                <h3 id="history-time-picker-title" className="text-base font-bold">設定執行時間</h3>
                <p className="mt-1 text-xs text-blue-100">{timePicker.label} · UTC</p>
              </div>
              <button
                type="button"
                onClick={() => setTimePicker(null)}
                aria-label="關閉時間選擇"
                autoFocus
                className="rounded-lg p-1 text-blue-100 hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div className="space-y-5 p-5">
              <div className="rounded-xl bg-blue-50 py-2 text-center text-2xl font-bold tabular-nums text-blue-900">
                {timePicker.time || '--:--'} <span className="text-xs font-medium">UTC</span>
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold text-slate-600">常用時間</p>
                <div className="grid grid-cols-5 gap-1.5">
                  {quickTimes.map(time => (
                    <button
                      key={time}
                      type="button"
                      onClick={() => setTimePicker(prev => prev && ({ ...prev, time }))}
                      aria-pressed={timePicker.time === time}
                      className={`rounded-lg py-1.5 text-xs font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${timePicker.time === time ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-blue-100'}`}
                    >
                      {time}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold text-slate-600">小時</p>
                <div className="grid grid-cols-6 gap-1.5">
                  {hourOptions.map(hour => (
                    <button
                      key={hour}
                      type="button"
                      onClick={() => setTimePicker(prev => prev && ({ ...prev, time: `${hour}:${prev.time.slice(3)}` }))}
                      aria-pressed={timePicker.time.slice(0, 2) === hour}
                      className={`rounded-lg py-1.5 text-sm font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${timePicker.time.slice(0, 2) === hour ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-blue-100'}`}
                    >
                      {hour}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-600">分鐘</p>
                  <label className="flex items-center gap-1.5 text-xs text-slate-600">
                    精確分鐘
                    <input
                      type="text"
                      inputMode="numeric"
                      value={timePicker.time.slice(3)}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => {
                        const minute = event.target.value.replace(/\D/g, '').slice(0, 2);
                        if (minute === '' || Number(minute) < 60) {
                          setTimePicker(prev => prev && ({ ...prev, time: `${prev.time.slice(0, 2)}:${minute}` }));
                        }
                      }}
                      onBlur={() => setTimePicker(prev => prev && ({
                        ...prev,
                        time: `${prev.time.slice(0, 2)}:${prev.time.slice(3).padStart(2, '0')}`,
                      }))}
                      aria-label="精確分鐘，00 至 59"
                      maxLength={2}
                      className="w-12 rounded-lg border border-slate-300 bg-white px-1 py-1 text-center font-semibold tabular-nums text-slate-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                    />
                  </label>
                </div>
                <div className="grid grid-cols-6 gap-1.5">
                  {minuteOptions.map(minute => (
                    <button
                      key={minute}
                      type="button"
                      onClick={() => setTimePicker(prev => prev && ({ ...prev, time: `${prev.time.slice(0, 2)}:${minute}` }))}
                      aria-pressed={timePicker.time.slice(3) === minute}
                      className={`rounded-lg py-1.5 text-sm font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${timePicker.time.slice(3) === minute ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-blue-100'}`}
                    >
                      {minute}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end gap-2 border-t border-slate-200 pt-4">
                <button type="button" onClick={() => setTimePicker(null)} className="rounded-lg px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100">取消</button>
                <button
                  type="button"
                  disabled={!utcTimePattern.test(timePicker.time)}
                  onClick={() => {
                    handleTimeChange(timePicker.tableName, timePicker.time);
                    setTimePicker(null);
                  }}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  套用時間
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Preview Modal */}
      {showPreviewModal && previewResult && selectedTable && createPortal(
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full">
            <div className="px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-red-100 rounded-full">
                  <Trash2 className="w-5 h-5 text-red-600" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-gray-900">確認清理</h3>
                  <p className="text-sm text-gray-600">{getTableName(selectedTable)}</p>
                </div>
              </div>
            </div>

            <div className="px-6 py-5 space-y-4">
              <div className="text-center">
                <div className="text-4xl font-bold text-red-600 mb-1">
                  {previewResult.records_to_delete.toLocaleString()}
                </div>
                <div className="text-gray-600 text-sm">
                  {selectedTable.table_name === 'valid_order_data'
                    ? '筆驗證資料將回流至可用池'
                    : '筆符合條件的紀錄將被刪除'}
                </div>
              </div>

              <p className="text-xs text-amber-700">手動清理使用此資料類型的保留期限（{previewResult.retention_days} 天），只處理到期且符合條件的資料；請確認預覽筆數。</p>

              {selectedTable.table_name !== 'valid_order_data' && (
                <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600">預估釋出空間：</span>
                    <span className="font-medium text-blue-600">{formatSize(previewResult.estimated_space)}</span>
                  </div>
                </div>
              )}

              {previewResult.records_to_delete === 0 ? (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0" />
                  <span className="text-sm text-green-800">目前沒有符合條件的紀錄需要清理。</span>
                </div>
              ) : selectedTable.table_name === 'valid_order_data' ? (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center gap-2">
                  <Info className="w-5 h-5 text-blue-600 flex-shrink-0" />
                  <span className="text-sm text-blue-800">符合條件的驗證資料將重新啟用並回流至可用池；驗證資料不會被永久刪除。</span>
                </div>
              ) : (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-red-600 flex-shrink-0" />
                  <span className="text-sm text-red-800">將刪除所有符合條件的紀錄，此操作無法復原。</span>
                </div>
              )}

              {selectedTable.table_name === 'used_order_data' && previewResult.records_to_delete > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <p className="text-sm text-blue-800 font-medium mb-1">訂單派送使用紀錄</p>
                  <p className="text-xs text-blue-700">
                    清理派送紀錄後，對應的驗證資料可回流至可用池，供員工再次使用。
                  </p>
                </div>
              )}

              {selectedTable.table_name === 'valid_order_data' && previewResult.records_to_delete > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                  <p className="text-sm text-blue-800 font-medium mb-1">訂單驗證資料回流</p>
                  <p className="text-xs text-blue-700">
                    符合條件的已用驗證資料將重新啟用，供再次派送；相關使用紀錄會被清除。
                  </p>
                </div>
              )}
            </div>

            <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3 rounded-b-xl">
              <button
                type="button"
                onClick={() => {
                  setShowPreviewModal(false);
                  setPreviewResult(null);
                }}
                className="px-4 py-2 text-gray-700 hover:text-gray-900 font-medium text-sm"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleExecuteCleanup}
                disabled={processing || previewResult.records_to_delete === 0}
                className="px-5 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm"
              >
                {processing ? '處理中…' : selectedTable.table_name === 'valid_order_data' ? '確認回流' : '確認刪除'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Result Modal */}
      {showConfirmModal && cleanupResult && createPortal(
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full">
            <div className="px-6 py-4 border-b border-gray-200">
              <div className="flex items-center gap-3">
                {cleanupResult.success ? (
                  <CheckCircle className="w-6 h-6 text-green-600" />
                ) : (
                  <AlertTriangle className="w-6 h-6 text-red-600" />
                )}
                <h3 className="text-lg font-bold text-gray-900">
                  {cleanupResult.success ? '清理完成' : '清理失敗'}
                </h3>
              </div>
            </div>

            <div className="px-6 py-4 space-y-4">
              <p className="text-gray-700 text-sm">{cleanupResult.success ? '本次操作已完成。' : '無法完成清理，請稍後重試。'}</p>

              {cleanupResult.success && (
                <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">{selectedTable?.table_name === 'valid_order_data' ? '已回流資料：' : '已刪除紀錄：'}</span>
                    <span className="font-bold text-gray-900">
                      {cleanupResult.records_deleted.toLocaleString()}
                    </span>
                  </div>
                  {selectedTable?.table_name !== 'valid_order_data' && (
                    <div className="flex justify-between text-sm">
                      <span className="text-gray-600">釋出空間：</span>
                      <span className="font-bold text-gray-900">{formatSize(cleanupResult.space_freed)}</span>
                    </div>
                  )}
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">執行時間：</span>
                    <span className="font-bold text-gray-900">
                      {cleanupResult.execution_time_ms.toFixed(2)} 毫秒
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end rounded-b-xl">
              <button
                type="button"
                onClick={handleCloseResultModal}
                className="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
              >
                關閉
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
