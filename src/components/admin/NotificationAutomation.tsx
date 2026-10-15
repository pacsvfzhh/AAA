import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Archive,
  ArrowLeft,
  Bell,
  CheckCircle2,
  ChevronDown,
  Edit3,
  Eye,
  FileText,
  Gift,
  History,
  Info,
  Layers3,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { getAdminFinancialSessionToken } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { useResponsive } from '../../lib/useResponsive';
import EmployeeNotificationDetailPanel from '../employee/EmployeeNotificationDetailPanel';
import AdminPageLoading from './AdminPageLoading';
import TiptapEditor from './TiptapEditor';
import NotificationDeliverySelector, { type NotificationDeliveryMode } from './NotificationDeliverySelector';

interface AdminIdentity {
  id: string;
  username: string;
  role: string;
  is_super_admin?: boolean;
}

interface AutomationEmployee {
  id: string;
  username: string;
  employee_id: string;
  created_by: string;
  is_active: boolean;
  tags: string[];
}

type TriggerType = 'total_orders' | 'daily_orders' | 'work_days' | 'commission_amount' | 'consecutive_work_days' | 'annual_date' | 'first_login';
type TriggerMode = 'reach_once' | 'recurring';
type TaskStatus = 'draft' | 'active' | 'paused';
type PlanStatus = 'active' | 'paused' | 'archived';
type EmployeePickerStatusFilter = 'all' | 'active' | 'inactive';

interface AutomationPlan {
  id: string;
  owner_admin_id: string;
  name: string;
  description: string;
  status: PlanStatus;
  member_count: number;
  task_count: number;
  active_task_count: number;
  selected_task_count: number;
  all_managed_task_count: number;
  updated_at: string;
}

interface AutomationPlanMember {
  plan_id: string;
  user_id: string;
}

interface AutomationTask {
  id: string;
  owner_admin_id: string;
  owner_username: string;
  plan_id: string | null;
  name: string;
  description: string;
  status: TaskStatus;
  trigger_type: TriggerType;
  trigger_mode: TriggerMode;
  threshold_value: number;
  minimum_daily_orders: number | null;
  minimum_daily_work_minutes: number | null;
  annual_month: number | null;
  annual_day: number | null;
  recipient_scope: 'all_managed' | 'selected';
  recipient_ids?: string[];
  title_template: string;
  content_template: string;
  message_type: 'realtime' | 'login_popup';
  delivery_mode: NotificationDeliveryMode;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  reward_enabled: boolean;
  reward_amount: number | null;
  starts_at: string | null;
  ends_at: string | null;
  version: number;
  execution_count?: number;
  total_rewards?: number;
  updated_at: string;
}

interface AutomationExecution {
  id: string;
  plan_id: string | null;
  task_name: string;
  employee_username: string;
  employee_id: string | null;
  owner_username: string | null;
  actual_value: number;
  stage: number;
  reward_amount: number | null;
  reward_currency: string | null;
  status: 'processing' | 'succeeded' | 'failed';
  executed_at: string;
  error_message: string | null;
}

interface AutomationFailure {
  task_id: string;
  task_name: string;
  plan_name: string | null;
  user_id: string;
  employee_username: string;
  employee_code: string | null;
  attempts: number;
  last_error: string;
  last_failed_at: string;
}

interface AutomationAdminGroup {
  id: string;
  username: string;
  role: string;
  is_active?: boolean;
  employee_count?: number;
  plan_count?: number;
}

interface AutomationDashboard {
  currency: string;
  selected_owner_id: string;
  admin_groups: AutomationAdminGroup[];
  plans: AutomationPlan[];
  plan_members: AutomationPlanMember[];
  employees: AutomationEmployee[];
  tasks: AutomationTask[];
  executions: AutomationExecution[];
}

interface TaskForm {
  id: string | null;
  planId: string | null;
  name: string;
  triggerType: TriggerType;
  triggerMode: TriggerMode;
  thresholdValue: string;
  minimumDailyOrders: string;
  minimumDailyWorkMinutes: string;
  annualMonth: string;
  annualDay: string;
  recipientScope: 'all_managed' | 'selected';
  recipientIds: string[];
  titleTemplate: string;
  contentTemplate: string;
  deliveryMode: NotificationDeliveryMode;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  rewardEnabled: boolean;
  rewardAmount: string;
  startsAt: string;
}

interface Props {
  admin: AdminIdentity;
  employees: AutomationEmployee[];
  isActive?: boolean;
  onBack: () => void;
}

type AutomationNoticeType = 'success' | 'error' | 'info';
type AutomationNoticeVariant = 'activated' | 'paused';

interface AutomationNotice {
  type: AutomationNoticeType;
  title?: string;
  message: string;
  variant?: AutomationNoticeVariant;
}

const UNGROUPED_PLAN_ID = '__ungrouped__';

const triggerLabels: Record<TriggerType, string> = {
  total_orders: '累計完成訂單數',
  daily_orders: '當天完成訂單數',
  work_days: '累計工作天數',
  commission_amount: '累計佣金金額',
  consecutive_work_days: '連續工作達標',
  annual_date: '每年指定日期',
  first_login: '新員工帳戶第一次登入',
};

const taskStatusLabels: Record<TaskStatus, string> = {
  draft: '草稿',
  active: '已啟用',
  paused: '已暫停',
};

const planStatusLabels: Record<PlanStatus, string> = {
  active: '執行中',
  paused: '已暫停',
  archived: '已封存',
};

const planStatusFilterLabels: Record<'all' | PlanStatus, string> = {
  all: '全部狀態',
  active: '執行中',
  paused: '已暫停',
  archived: '已封存',
};

const statusSortOrder: Record<TaskStatus, number> = {
  active: 0,
  paused: 1,
  draft: 2,
};

const getTaskDeliveryMode = (task: Pick<AutomationTask, 'message_type' | 'delivery_mode'>): NotificationDeliveryMode =>
  task.delivery_mode || (task.message_type === 'login_popup' ? 'login_only' : 'realtime_only');

const getNotificationDeliveryLabel = (deliveryMode: NotificationDeliveryMode) => ({
  realtime_with_login_fallback: '結合通知',
  realtime_only: '即時通知',
  login_only: '登入通知',
})[deliveryMode];

function NotificationDeliveryBadge({ mode }: { mode: NotificationDeliveryMode }) {
  const Icon = mode === 'realtime_with_login_fallback'
    ? ShieldCheck
    : mode === 'realtime_only'
      ? Bell
      : AlertCircle;
  const tone = mode === 'realtime_with_login_fallback'
    ? 'border-amber-100/80 bg-gradient-to-r from-amber-400 to-orange-500 text-amber-950 shadow-[0_4px_14px_rgba(245,158,11,0.22)]'
    : mode === 'realtime_only'
      ? 'border-blue-100/75 bg-gradient-to-r from-blue-500 to-sky-500 text-white shadow-[0_4px_14px_rgba(14,165,233,0.2)]'
      : 'border-violet-100/75 bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white shadow-[0_4px_14px_rgba(139,92,246,0.2)]';

  return <span className={`inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-black ${tone}`}><Icon className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{getNotificationDeliveryLabel(mode)}</span></span>;
}

function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const tone = status === 'active'
    ? 'border-emerald-300/35 bg-gradient-to-r from-emerald-500/20 to-teal-500/15 text-emerald-200'
    : status === 'paused'
      ? 'border-amber-300/35 bg-gradient-to-r from-amber-500/20 to-yellow-500/15 text-amber-100'
      : 'border-slate-400/35 bg-gradient-to-r from-slate-600/30 to-slate-700/25 text-slate-100';

  return <span className={`inline-flex h-6 shrink-0 items-center rounded-full border px-2.5 text-[11px] font-black leading-none shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ${tone}`}>{taskStatusLabels[status]}</span>;
}

function compareAutomationTasks(left: AutomationTask, right: AutomationTask) {
  const statusDifference = statusSortOrder[left.status] - statusSortOrder[right.status];
  if (statusDifference !== 0) return statusDifference;
  return right.updated_at.localeCompare(left.updated_at) || left.name.localeCompare(right.name, 'zh-Hant');
}

function createDefaultForm(planId: string | null = null): TaskForm {
  return {
    id: null,
    planId,
    name: '',
    triggerType: 'total_orders',
    triggerMode: 'reach_once',
    thresholdValue: '100',
    minimumDailyOrders: '10',
    minimumDailyWorkMinutes: '',
    annualMonth: '1',
    annualDay: '1',
    recipientScope: planId === null ? 'all_managed' : 'selected',
    recipientIds: [],
    titleTemplate: '',
    contentTemplate: '',
    deliveryMode: 'realtime_with_login_fallback',
    priority: 'normal',
    rewardEnabled: false,
    rewardAmount: '',
    startsAt: '',
  };
}

function taskToForm(task: AutomationTask): TaskForm {
  return {
    id: task.id,
    planId: task.plan_id,
    name: task.name,
    triggerType: task.trigger_type,
    triggerMode: task.trigger_mode,
    thresholdValue: String(task.threshold_value),
    minimumDailyOrders: task.minimum_daily_orders ? String(task.minimum_daily_orders) : '',
    minimumDailyWorkMinutes: task.minimum_daily_work_minutes ? String(task.minimum_daily_work_minutes) : '',
    annualMonth: task.annual_month ? String(task.annual_month) : '1',
    annualDay: task.annual_day ? String(task.annual_day) : '1',
    recipientScope: task.plan_id === null ? task.recipient_scope : 'selected',
    recipientIds: task.plan_id === null ? task.recipient_ids || [] : [],
    titleTemplate: task.title_template,
    contentTemplate: task.content_template,
    deliveryMode: getTaskDeliveryMode(task),
    priority: task.priority,
    rewardEnabled: task.reward_enabled,
    rewardAmount: task.reward_amount ? String(task.reward_amount) : '',
    startsAt: task.starts_at ? task.starts_at.slice(0, 16) : '',
  };
}

function buildEnglishContent(triggerType: TriggerType, rewardEnabled: boolean) {
  const reward = rewardEnabled
    ? ' You have also earned a performance bonus of {{bonus_amount}} {{currency}}, which has been credited to your wallet.'
    : '';

  switch (triggerType) {
    case 'daily_orders':
      return {
        title: 'Congratulations on Your Daily Achievement',
        content: `<p>Congratulations, {{employee_name}}! You completed at least {{threshold_value}} orders today.${reward} Thank you for your dedication and keep up the excellent work!</p>`,
      };
    case 'work_days':
      return {
        title: 'Congratulations on Your Work Milestone',
        content: `<p>Congratulations, {{employee_name}}! You have completed {{threshold_value}} qualifying working days with at least {{minimum_daily_orders}} orders per day.${reward} Your consistency and dedication are greatly appreciated.</p>`,
      };
    case 'commission_amount':
      return {
        title: 'Congratulations on Your Commission Milestone',
        content: `<p>Congratulations, {{employee_name}}! Your accumulated commission has reached {{threshold_value}} {{currency}}.${reward} Thank you for your outstanding performance!</p>`,
      };
    case 'consecutive_work_days':
      return {
        title: 'Congratulations on Achieving Your Performance Goal',
        content: `<p>Congratulations, {{employee_name}}! You have worked for {{threshold_value}} consecutive days and completed at least {{minimum_daily_orders}} orders each day.${reward} Thank you for your dedication and keep up the excellent work!</p>`,
      };
    case 'annual_date':
      return {
        title: 'A Special Message for You',
        content: `<p>Hello, {{employee_name}}! Today is {{annual_month}}/{{annual_day}}, and we would like to share this special message with you.${reward} Thank you for being an important part of our team!</p>`,
      };
    case 'first_login':
      return {
        title: 'Welcome to the Team',
        content: `<p>Welcome, {{employee_name}}! This is your first login to the employee platform.${reward} We are glad to have you with us.</p>`,
      };
    default:
      return {
        title: 'Congratulations on Your Order Milestone',
        content: `<p>Congratulations, {{employee_name}}! You have completed {{threshold_value}} orders.${reward} Thank you for your continued effort and excellent performance!</p>`,
      };
  }
}

function replaceContentToken(value: string, token: string, replacement: string) {
  return value.split(token).join(replacement);
}

function renderPreview(content: string, form: TaskForm, currency: string) {
  let preview = replaceContentToken(content, '{{employee_name}}', 'Emily');
  preview = replaceContentToken(preview, '{{actual_value}}', form.thresholdValue || '0');
  preview = replaceContentToken(preview, '{{threshold_value}}', form.thresholdValue || '0');
  preview = replaceContentToken(preview, '{{minimum_daily_orders}}', form.minimumDailyOrders || '0');
  preview = replaceContentToken(preview, '{{annual_month}}', form.annualMonth || '1');
  preview = replaceContentToken(preview, '{{annual_day}}', form.annualDay || '1');
  preview = replaceContentToken(preview, '{{bonus_amount}}', Number(form.rewardAmount || 0).toFixed(2));
  return replaceContentToken(preview, '{{currency}}', currency);
}

function summarizeTask(task: AutomationTask, currency: string) {
  const value = task.trigger_type === 'commission_amount'
    ? `${Number(task.threshold_value).toLocaleString()} ${currency}`
    : Number(task.threshold_value).toLocaleString();
  const mode = task.trigger_mode === 'recurring' ? '每達到' : '累計達到';

  if (task.trigger_type === 'annual_date') return `每年 ${task.annual_month || 1} 月 ${task.annual_day || 1} 日執行一次`;
  if (task.trigger_type === 'first_login') return '新員工帳戶第一次登入時發送一次通知';
  if (task.trigger_type === 'consecutive_work_days') {
    const workMinutes = task.minimum_daily_work_minutes && task.minimum_daily_work_minutes > 0
      ? `，且每天至少工作 ${task.minimum_daily_work_minutes} 分鐘`
      : '';
    return `${task.trigger_mode === 'recurring' ? '每連續' : '連續'} ${value} 天，每天至少完成 ${task.minimum_daily_orders || 0} 筆訂單${workMinutes}`;
  }
  if (task.trigger_type === 'daily_orders') return `每天${mode} ${value} 筆成功或失敗訂單`;
  if (task.trigger_type === 'work_days') {
    const workMinutes = task.minimum_daily_work_minutes && task.minimum_daily_work_minutes > 0
      ? `，且每天至少工作 ${task.minimum_daily_work_minutes} 分鐘`
      : '';
    return `${mode} ${value} 個有效工作日，每天至少完成 ${task.minimum_daily_orders || 0} 筆訂單${workMinutes}`;
  }
  if (task.trigger_type === 'commission_amount') return `${mode} ${value} 佣金`;
  return `${mode} ${value} 筆成功或失敗訂單`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat('zh-TW', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function planSelectionStorageKey(ownerId: string) {
  return `notification-automation:selected-plan:${ownerId}`;
}

function serializeTaskForm(form: TaskForm) {
  return JSON.stringify(form);
}

function serializeMemberIds(memberIds: string[]) {
  return JSON.stringify([...memberIds].sort());
}

interface AutomationRuleSelectProps {
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  accent?: boolean;
}

function AutomationRuleSelect({ value, options, onChange, disabled = false, ariaLabel, accent = false }: AutomationRuleSelectProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedLabel = options.find(option => option.value === value)?.label || value;

  useEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const menuHeight = Math.min(options.length * 36 + 8, 280);
      const top = window.innerHeight - rect.bottom >= menuHeight + 8
        ? rect.bottom + 6
        : Math.max(8, rect.top - menuHeight - 6);
      setMenuPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
        top,
        width: rect.width,
      });
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    updatePosition();
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, options.length]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(previous => !previous)}
        className={`flex h-9 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left text-sm font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_4px_12px_rgba(2,6,23,0.18)] outline-none transition focus-visible:ring-2 focus-visible:ring-cyan-300/25 disabled:opacity-60 ${accent ? 'border-cyan-300/40 bg-gradient-to-r from-cyan-950/95 to-blue-950/90 text-cyan-50 hover:border-cyan-200/60' : 'border-blue-300/25 bg-gradient-to-r from-slate-800/95 to-blue-950/75 text-slate-100 hover:border-blue-300/45'}`}
      >
        <span className="min-w-0 truncate">{selectedLabel}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cyan-300/70 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label={ariaLabel}
          className="fixed z-[280] max-h-[280px] overflow-y-auto rounded-xl border border-cyan-300/25 bg-[linear-gradient(145deg,rgba(15,23,42,0.99),rgba(2,6,23,0.98))] p-1.5 shadow-[0_18px_45px_rgba(2,6,23,0.65),inset_0_1px_0_rgba(255,255,255,0.05)] backdrop-blur-xl"
          style={{ left: menuPosition.left, top: menuPosition.top, width: menuPosition.width }}
        >
          {options.map(option => {
            const selected = option.value === value;
            return <button key={option.value} type="button" role="option" aria-selected={selected} onClick={() => { onChange(option.value); setOpen(false); }} className={`flex h-9 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-xs font-bold transition-colors ${selected ? 'bg-gradient-to-r from-cyan-500/25 to-blue-500/15 text-cyan-50' : 'text-slate-300 hover:bg-white/[0.06] hover:text-white'}`}><span className="truncate">{option.label}</span>{selected && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-cyan-300" />}</button>;
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

type ExecutionScope = 'selected' | 'all';

interface ExecutionScopeSelectProps {
  value: ExecutionScope;
  currentSelectionName: string;
  onChange: (value: ExecutionScope) => void;
}

function ExecutionScopeSelect({ value, currentSelectionName, onChange }: ExecutionScopeSelectProps) {
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedOption = value === 'selected'
    ? { label: '目前方案', detail: currentSelectionName, Icon: Settings2 }
    : { label: '全部方案', detail: '跨方案查詢', Icon: Layers3 };

  useEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const button = buttonRef.current;
      if (!button) return;
      const rect = button.getBoundingClientRect();
      const width = Math.max(rect.width, 280);
      const menuHeight = 178;
      const top = window.innerHeight - rect.bottom >= menuHeight + 8
        ? rect.bottom + 8
        : Math.max(8, rect.top - menuHeight - 8);
      setMenuPosition({
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
        top,
        width,
      });
    };
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    updatePosition();
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const SelectedIcon = selectedOption.Icon;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="選擇執行記錄查詢範圍"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(previous => !previous)}
        className={`group flex h-10 w-[184px] shrink-0 items-center gap-2 rounded-xl border px-2 text-left outline-none transition-all focus-visible:ring-2 focus-visible:ring-cyan-300/30 ${open ? 'border-cyan-200/75 bg-gradient-to-r from-cyan-500/25 to-blue-500/20 shadow-[0_0_0_1px_rgba(103,232,249,0.12),0_10px_24px_rgba(8,145,178,0.2)]' : 'border-cyan-300/35 bg-gradient-to-r from-slate-900 via-cyan-950/70 to-blue-950/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_6px_16px_rgba(2,6,23,0.3)] hover:border-cyan-200/60 hover:from-cyan-950/90 hover:to-blue-950'}`}
      >
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors ${open ? 'border-cyan-100/40 bg-cyan-300/20 text-white' : 'border-cyan-200/25 bg-cyan-400/15 text-cyan-200 group-hover:bg-cyan-300/20 group-hover:text-white'}`}>
          <SelectedIcon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[9px] font-black uppercase leading-3 tracking-[0.12em] text-cyan-200/70">查詢範圍</span>
          <span className="flex min-w-0 items-center gap-1 text-[11px] font-black leading-4 text-white"><span className="shrink-0">{selectedOption.label}</span><span className={`truncate text-[11px] font-black ${value === 'selected' ? 'text-amber-200' : 'text-cyan-100'}`}><span className="mr-1 text-cyan-200/45">·</span>{selectedOption.detail}</span></span>
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cyan-200 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && menuPosition && createPortal(
        <div
          ref={menuRef}
          role="listbox"
          aria-label="執行記錄查詢範圍"
          className="fixed z-[280] overflow-hidden rounded-2xl border border-cyan-200/30 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.16),transparent_42%),linear-gradient(145deg,rgba(15,23,42,0.99),rgba(2,6,23,0.99))] p-2 shadow-[0_22px_55px_rgba(2,6,23,0.72),inset_0_1px_0_rgba(255,255,255,0.07)] backdrop-blur-xl"
          style={{ left: menuPosition.left, top: menuPosition.top, width: menuPosition.width }}
        >
          <div className="mb-1.5 flex items-center justify-between px-2 py-1">
            <span><span className="block text-[10px] font-black uppercase tracking-[0.15em] text-cyan-200">執行記錄範圍</span><span className="mt-0.5 block text-[9px] font-semibold text-slate-500">只影響目前顯示與搜尋的記錄</span></span>
            <SlidersHorizontal className="h-4 w-4 text-cyan-300/80" />
          </div>
          {([
            { id: 'selected' as const, label: '目前方案', description: `只查詢「${currentSelectionName}」的執行記錄`, Icon: Settings2 },
            { id: 'all' as const, label: '全部方案', description: '跨目前管理員的所有方案查詢執行記錄', Icon: Layers3 },
          ]).map(option => {
            const selected = option.id === value;
            const OptionIcon = option.Icon;
            return <button key={option.id} type="button" role="option" aria-selected={selected} onClick={() => { onChange(option.id); setOpen(false); }} className={`group/option flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all ${selected ? 'border-cyan-200/35 bg-gradient-to-r from-cyan-500/25 via-sky-500/15 to-blue-500/15 shadow-[inset_3px_0_0_rgba(34,211,238,0.9)]' : 'border-transparent text-slate-300 hover:border-blue-300/20 hover:bg-gradient-to-r hover:from-blue-500/10 hover:to-cyan-500/10'}`}><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${selected ? 'border-cyan-100/35 bg-cyan-300/20 text-cyan-50' : 'border-slate-700 bg-slate-900/80 text-slate-400 group-hover/option:border-cyan-300/25 group-hover/option:text-cyan-200'}`}><OptionIcon className="h-4 w-4" /></span><span className="min-w-0 flex-1"><span className={`block text-xs font-black ${selected ? 'text-white' : 'text-slate-200'}`}>{option.label}</span><span className={`mt-0.5 block truncate text-[10px] font-semibold ${selected ? 'text-cyan-100/70' : 'text-slate-500'}`}>{option.description}</span></span><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-cyan-200/50 bg-cyan-400/20 text-cyan-100' : 'border-slate-700 text-transparent'}`}><CheckCircle2 className="h-3.5 w-3.5" /></span></button>;
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

export default function NotificationAutomation({ admin, employees, isActive = true, onBack }: Props) {
  const { isDesktop } = useResponsive();
  const isSuperAdmin = admin.role === 'super_admin' || Boolean(admin.is_super_admin);
  const emptyDashboard: AutomationDashboard = {
    currency: 'USDC',
    selected_owner_id: admin.id,
    admin_groups: [],
    plans: [],
    plan_members: [],
    employees: [],
    tasks: [],
    executions: [],
  };
  const [dashboard, setDashboard] = useState<AutomationDashboard>(emptyDashboard);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<'tasks' | 'executions'>('tasks');
  const [selectedAdminId, setSelectedAdminId] = useState(admin.id);
  const [selectedPlanId, setSelectedPlanId] = useState<string>(UNGROUPED_PLAN_ID);
  const [planStatusFilter, setPlanStatusFilter] = useState<'all' | PlanStatus>('all');
  const [planStatusMenuOpen, setPlanStatusMenuOpen] = useState(false);
  const [adminGroupMenuOpen, setAdminGroupMenuOpen] = useState(false);
  const [taskStatusFilter, setTaskStatusFilter] = useState<'all' | TaskStatus>('all');
  const [taskTriggerFilter, setTaskTriggerFilter] = useState<'all' | TriggerType>('all');
  const [taskStatusMenuOpen, setTaskStatusMenuOpen] = useState(false);
  const [taskTriggerMenuOpen, setTaskTriggerMenuOpen] = useState(false);
  const [executionSearch, setExecutionSearch] = useState('');
  const [debouncedExecutionSearch, setDebouncedExecutionSearch] = useState('');
  const [executionScope, setExecutionScope] = useState<'selected' | 'all'>('selected');
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [executionsInitialized, setExecutionsInitialized] = useState(false);
  const [executionRefreshKey, setExecutionRefreshKey] = useState(0);
  const [failures, setFailures] = useState<AutomationFailure[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [form, setForm] = useState<TaskForm>(createDefaultForm());
  const [contentCustomized, setContentCustomized] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AutomationTask | null>(null);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [planDeleteTarget, setPlanDeleteTarget] = useState<AutomationPlan | null>(null);
  const [planArchiveTarget, setPlanArchiveTarget] = useState<AutomationPlan | null>(null);
  const [discardTarget, setDiscardTarget] = useState<'plan' | 'members' | 'task' | null>(null);
  const [notice, setNotice] = useState<AutomationNotice | null>(null);
  const [variableHelpOpen, setVariableHelpOpen] = useState(false);
  const [employeePreviewOpen, setEmployeePreviewOpen] = useState(false);
  const [employeePickerOpen, setEmployeePickerOpen] = useState(false);
  const [employeePickerSearch, setEmployeePickerSearch] = useState('');
  const [employeePickerStatusFilter, setEmployeePickerStatusFilter] = useState<EmployeePickerStatusFilter>('all');
  const [pendingRecipientIds, setPendingRecipientIds] = useState<string[]>([]);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<AutomationPlan | null>(null);
  const [planName, setPlanName] = useState('');
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
  const [memberPickerSearch, setMemberPickerSearch] = useState('');
  const [memberPickerStatusFilter, setMemberPickerStatusFilter] = useState<EmployeePickerStatusFilter>('all');
  const [pendingMemberIds, setPendingMemberIds] = useState<string[]>([]);
  const [memberTagPopover, setMemberTagPopover] = useState<{ employee: AutomationEmployee; x: number; y: number } | null>(null);
  const loadRef = useRef<((ownerAdminId?: string) => Promise<void>) | null>(null);
  const wasActiveRef = useRef(isActive);
  const dashboardRequestIdRef = useRef(0);
  const executionRequestIdRef = useRef(0);
  const failureRequestIdRef = useRef(0);
  const editorInitialSnapshotRef = useRef('');
  const planInitialSnapshotRef = useRef('');
  const memberInitialSnapshotRef = useRef('');
  const editorDirty = editorOpen && editorInitialSnapshotRef.current !== serializeTaskForm(form);
  const planDirty = planModalOpen && planInitialSnapshotRef.current !== planName;
  const membersDirty = memberPickerOpen && memberInitialSnapshotRef.current !== serializeMemberIds(pendingMemberIds);
  const hasUnsavedChanges = editorDirty || planDirty || membersDirty;

  const showNotice = (type: AutomationNoticeType, message: string, title?: string, variant?: AutomationNoticeVariant) => {
    setNotice({ type, message, title, variant });
  };

  const loadDashboard = async (ownerAdminId = selectedAdminId) => {
    const requestId = ++dashboardRequestIdRef.current;
    try {
      const { data, error } = await supabase.rpc('get_notification_automation_dashboard_v2', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_owner_admin_id: isSuperAdmin ? ownerAdminId : null,
      });
      if (error) throw error;
      if (requestId !== dashboardRequestIdRef.current) return;

      const next = (data || emptyDashboard) as unknown as AutomationDashboard;
      const normalized: AutomationDashboard = {
        currency: next.currency || 'USDC',
        selected_owner_id: next.selected_owner_id || ownerAdminId || admin.id,
        admin_groups: Array.isArray(next.admin_groups) ? next.admin_groups : [],
        plans: Array.isArray(next.plans) ? next.plans : [],
        plan_members: Array.isArray(next.plan_members) ? next.plan_members : [],
        employees: Array.isArray(next.employees) ? next.employees : [],
        tasks: Array.isArray(next.tasks) ? next.tasks : [],
        executions: Array.isArray(next.executions) ? next.executions : [],
      };
      setDashboard(previous => ({
        ...normalized,
        executions: previous.selected_owner_id === normalized.selected_owner_id ? previous.executions : [],
      }));
      setSelectedAdminId(normalized.selected_owner_id);
      const storedSelection = window.localStorage.getItem(planSelectionStorageKey(normalized.selected_owner_id));
      const validStoredSelection = storedSelection === UNGROUPED_PLAN_ID
        || normalized.plans.some(plan => plan.id === storedSelection);
      const nextSelection = validStoredSelection
        ? storedSelection as string
        : normalized.plans.find(plan => plan.status === 'active')?.id
          || normalized.plans.find(plan => plan.status === 'paused')?.id
          || UNGROUPED_PLAN_ID;
      setSelectedPlanId(nextSelection);
      setExecutionRefreshKey(previous => previous + 1);
      window.localStorage.setItem(planSelectionStorageKey(normalized.selected_owner_id), nextSelection);
    } catch {
      if (requestId === dashboardRequestIdRef.current) {
        showNotice('error', '無法載入自動化方案資料，請稍後再試。');
      }
    } finally {
      if (requestId === dashboardRequestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  };
  loadRef.current = loadDashboard;

  useEffect(() => {
    void loadRef.current?.(admin.id);
  }, [admin.id]);

  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      setRefreshing(true);
      void loadRef.current?.(dashboard.selected_owner_id);
    }
    wasActiveRef.current = isActive;
  }, [dashboard.selected_owner_id, isActive]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (contentCustomized || readOnly) return;
    const content = buildEnglishContent(form.triggerType, form.rewardEnabled);
    setForm(previous => ({ ...previous, titleTemplate: content.title, contentTemplate: content.content }));
  }, [form.triggerType, form.rewardEnabled, contentCustomized, readOnly]);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedExecutionSearch(executionSearch.trim()), 300);
    return () => window.clearTimeout(timeout);
  }, [executionSearch]);

  useEffect(() => {
    setExecutionsInitialized(false);
  }, [dashboard.selected_owner_id]);

  useEffect(() => {
    if (loading) return;
    const requestId = ++executionRequestIdRef.current;
    const ownerId = dashboard.selected_owner_id;
    setExecutionsLoading(true);

    const loadExecutions = async () => {
      try {
        const { data, error } = await supabase.rpc('get_notification_automation_executions_v2', {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_owner_admin_id: ownerId,
          p_plan_id: null,
          p_all_plans: true,
          p_search_query: debouncedExecutionSearch || null,
        });
        if (requestId !== executionRequestIdRef.current) return;
        if (error) throw error;
        setDashboard(previous => previous.selected_owner_id === ownerId
          ? { ...previous, executions: Array.isArray(data) ? data as unknown as AutomationExecution[] : [] }
          : previous);
      } catch {
        if (requestId === executionRequestIdRef.current) {
          showNotice('error', '無法載入執行記錄，請稍後再試。');
        }
      } finally {
        if (requestId === executionRequestIdRef.current) {
          setExecutionsInitialized(true);
          setExecutionsLoading(false);
        }
      }
    };

    void loadExecutions();
  }, [dashboard.selected_owner_id, debouncedExecutionSearch, executionRefreshKey, loading]);

  useEffect(() => {
    if (loading) return;
    const requestId = ++failureRequestIdRef.current;
    const ownerId = dashboard.selected_owner_id;

    const loadFailures = async () => {
      try {
        const { data, error } = await supabase.rpc('get_notification_automation_failures', {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_owner_admin_id: ownerId,
        });
        if (requestId !== failureRequestIdRef.current) return;
        if (error) throw error;
        setFailures(Array.isArray(data) ? data as unknown as AutomationFailure[] : []);
      } catch {
        if (requestId === failureRequestIdRef.current) setFailures([]);
      }
    };

    void loadFailures();
  }, [dashboard.selected_owner_id, executionRefreshKey, loading]);

  const selectedAdmin = dashboard.admin_groups.find(group => group.id === selectedAdminId);
  const selectedOwnerName = selectedAdmin?.username || (dashboard.selected_owner_id === admin.id ? admin.username : '管理員分組');
  const selectedPlan = dashboard.plans.find(plan => plan.id === selectedPlanId) || null;
  const isUngroupedSelected = selectedPlanId === UNGROUPED_PLAN_ID || !selectedPlan;
  const currentSelectionName = selectedPlan?.name || '未分組任務';
  const ownerEmployees = useMemo(() => {
    if (dashboard.employees.length > 0) return dashboard.employees;
    return employees.filter(employee => employee.created_by === dashboard.selected_owner_id);
  }, [dashboard.employees, dashboard.selected_owner_id, employees]);
  const legacyRecipientEmployees = useMemo(() => (
    isSuperAdmin && dashboard.selected_owner_id === admin.id && form.planId === null
      ? employees
      : ownerEmployees
  ), [admin.id, dashboard.selected_owner_id, employees, form.planId, isSuperAdmin, ownerEmployees]);
  const planById = useMemo(
    () => new Map(dashboard.plans.map(plan => [plan.id, plan])),
    [dashboard.plans],
  );
  const memberPlanByEmployeeId = useMemo(() => {
    const assignments = new Map<string, string>();
    dashboard.plan_members.forEach(member => assignments.set(member.user_id, member.plan_id));
    return assignments;
  }, [dashboard.plan_members]);
  const selectedPlanMemberIds = useMemo(
    () => selectedPlan ? dashboard.plan_members.filter(member => member.plan_id === selectedPlan.id).map(member => member.user_id) : [],
    [dashboard.plan_members, selectedPlan],
  );
  const selectionTasks = useMemo(
    () => dashboard.tasks
      .filter(task => isUngroupedSelected ? task.plan_id === null : task.plan_id === selectedPlan?.id)
      .sort(compareAutomationTasks),
    [dashboard.tasks, isUngroupedSelected, selectedPlan],
  );
  const filteredTasks = useMemo(() => selectionTasks.filter(task => {
    const matchesStatus = taskStatusFilter === 'all' || task.status === taskStatusFilter;
    const matchesTrigger = taskTriggerFilter === 'all' || task.trigger_type === taskTriggerFilter;
    return matchesStatus && matchesTrigger;
  }), [selectionTasks, taskStatusFilter, taskTriggerFilter]);
  const filteredExecutions = useMemo(() => {
    const query = executionSearch.trim().toLocaleLowerCase();
    const scopedExecutions = executionScope === 'all'
      ? dashboard.executions
      : dashboard.executions.filter(execution => isUngroupedSelected
        ? execution.plan_id === null
        : execution.plan_id === selectedPlan?.id);
    return scopedExecutions.filter(execution => {
      const employeeId = execution.employee_id || dashboard.employees.find(employee => employee.username === execution.employee_username)?.employee_id || '';
      return !query
        || execution.employee_username.toLocaleLowerCase().includes(query)
        || employeeId.toLocaleLowerCase().includes(query);
    });
  }, [dashboard.employees, dashboard.executions, executionScope, executionSearch, isUngroupedSelected, selectedPlan]);
  const activePlans = useMemo(() => dashboard.plans.filter(plan => {
    if (plan.status === 'archived') return false;
    return planStatusFilter === 'all' || plan.status === planStatusFilter;
  }), [dashboard.plans, planStatusFilter]);
  const archivedPlans = useMemo(() => dashboard.plans.filter(plan => plan.status === 'archived'
    && (planStatusFilter === 'all' || planStatusFilter === 'archived')),
  [dashboard.plans, planStatusFilter]);
  const selectedEmployees = useMemo(
    () => legacyRecipientEmployees.filter(employee => form.recipientIds.includes(employee.id)),
    [form.recipientIds, legacyRecipientEmployees],
  );
  const employeePickerResults = useMemo(() => {
    const query = employeePickerSearch.trim().toLocaleLowerCase();
    return legacyRecipientEmployees.filter(employee => {
      const matchesQuery = !query
        || employee.username.toLocaleLowerCase().includes(query)
        || employee.employee_id.toLocaleLowerCase().includes(query)
        || employee.tags?.some(tag => tag.toLocaleLowerCase().includes(query));
      const matchesStatus = employeePickerStatusFilter === 'all'
        || employee.is_active === (employeePickerStatusFilter === 'active');
      return matchesQuery && matchesStatus;
    });
  }, [employeePickerSearch, employeePickerStatusFilter, legacyRecipientEmployees]);
  const pendingSelectedEmployees = useMemo(
    () => legacyRecipientEmployees.filter(employee => pendingRecipientIds.includes(employee.id)),
    [legacyRecipientEmployees, pendingRecipientIds],
  );
  const memberPickerResults = useMemo(() => {
    const query = memberPickerSearch.trim().toLocaleLowerCase();
    return ownerEmployees.filter(employee => {
      const matchesQuery = !query
        || employee.username.toLocaleLowerCase().includes(query)
        || employee.employee_id.toLocaleLowerCase().includes(query)
        || employee.tags?.some(tag => tag.toLocaleLowerCase().includes(query));
      const matchesStatus = memberPickerStatusFilter === 'all'
        || employee.is_active === (memberPickerStatusFilter === 'active');
      return matchesQuery && matchesStatus;
    });
  }, [memberPickerSearch, memberPickerStatusFilter, ownerEmployees]);
  const pendingSelectedMembers = useMemo(() => {
    const query = memberPickerSearch.trim().toLocaleLowerCase();
    return ownerEmployees.filter(employee => {
      const matchesQuery = !query
        || employee.username.toLocaleLowerCase().includes(query)
        || employee.employee_id.toLocaleLowerCase().includes(query)
        || employee.tags?.some(tag => tag.toLocaleLowerCase().includes(query));
      const matchesStatus = memberPickerStatusFilter === 'all'
        || employee.is_active === (memberPickerStatusFilter === 'active');
      return pendingMemberIds.includes(employee.id) && matchesQuery && matchesStatus;
    });
  }, [memberPickerSearch, memberPickerStatusFilter, ownerEmployees, pendingMemberIds]);
  const allVisibleEmployeesSelected = employeePickerResults.length > 0
    && employeePickerResults.every(employee => pendingRecipientIds.includes(employee.id));
  const allVisibleMembersSelected = memberPickerResults.length > 0
    && memberPickerResults.every(employee => pendingMemberIds.includes(employee.id));
  const membersAdded = pendingMemberIds.filter(id => !selectedPlanMemberIds.includes(id));
  const membersRemoved = selectedPlanMemberIds.filter(id => !pendingMemberIds.includes(id));
  const membersMoved = membersAdded.filter(id => {
    const assignedPlanId = memberPlanByEmployeeId.get(id);
    return Boolean(assignedPlanId && assignedPlanId !== selectedPlan?.id);
  });

  const selectPlan = (planId: string) => {
    setSelectedPlanId(planId);
    setExecutionScope('selected');
    window.localStorage.setItem(planSelectionStorageKey(dashboard.selected_owner_id), planId);
  };

  const selectAdminGroup = (ownerAdminId: string) => {
    if (ownerAdminId === dashboard.selected_owner_id || saving || deletingTaskId !== null) return;
    setRefreshing(true);
    setExecutionScope('selected');
    setTaskStatusFilter('all');
    setTaskTriggerFilter('all');
    void loadDashboard(ownerAdminId);
  };

  const openPlanModal = (plan: AutomationPlan | null = null) => {
    const name = plan?.name || '';
    setEditingPlan(plan);
    setPlanName(name);
    planInitialSnapshotRef.current = name;
    setPlanModalOpen(true);
  };

  const closePlanModal = () => {
    if (saving) return;
    if (planDirty) {
      setDiscardTarget('plan');
      return;
    }
    setPlanModalOpen(false);
  };

  const savePlan = async () => {
    if (!planName.trim()) {
      showNotice('error', '請輸入方案名稱');
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('save_notification_automation_plan', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_owner_admin_id: dashboard.selected_owner_id,
        p_plan_id: editingPlan?.id || null,
        p_name: planName.trim(),
        p_description: '',
      });
      if (error) throw error;
      const result = data as unknown as { plan?: AutomationPlan } | null;
      const savedPlanId = result?.plan?.id || editingPlan?.id;
      if (!savedPlanId) throw new Error('Missing automation plan id.');
      window.localStorage.setItem(planSelectionStorageKey(dashboard.selected_owner_id), savedPlanId);
      setPlanModalOpen(false);
      showNotice('success', editingPlan ? '方案資料已更新' : '新方案已建立並選取');
      setRefreshing(true);
      await loadDashboard(dashboard.selected_owner_id);
    } catch {
      showNotice('error', '無法儲存方案，請確認內容後再試。');
    } finally {
      setSaving(false);
    }
  };

  const deleteArchivedPlan = async () => {
    if (!planDeleteTarget) return;
    setSaving(true);
    try {
      const { error } = await supabase.rpc('delete_archived_notification_automation_plan', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_plan_id: planDeleteTarget.id,
      });
      if (error) throw error;
      showNotice('success', `方案「${planDeleteTarget.name}」及其 ${planDeleteTarget.task_count} 條任務已刪除`);
      setPlanDeleteTarget(null);
      setRefreshing(true);
      await loadDashboard(dashboard.selected_owner_id);
    } catch {
      showNotice('error', '無法刪除封存方案，請稍後再試。');
    } finally {
      setSaving(false);
    }
  };

  const changePlanStatus = async (plan: AutomationPlan, status: PlanStatus) => {
    setSaving(true);
    try {
      const { error } = await supabase.rpc('set_notification_automation_plan_status', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_plan_id: plan.id,
        p_status: status,
      });
      if (error) throw error;
      showNotice(
        'success',
        status === 'paused' ? '方案已暫停，方案內任務不會繼續執行。' : status === 'active' ? '方案已恢復執行。' : '方案已移至封存歷史。',
        status === 'paused' ? '方案已暫停' : status === 'active' ? '方案已啟用' : '方案已封存',
        status === 'paused' ? 'paused' : status === 'active' ? 'activated' : undefined,
      );
      setRefreshing(true);
      await loadDashboard(dashboard.selected_owner_id);
    } catch {
      showNotice('error', '無法更新方案狀態，請稍後再試。');
    } finally {
      setSaving(false);
    }
  };

  const openMemberPicker = () => {
    if (!selectedPlan || selectedPlan.status === 'archived') return;
    setPendingMemberIds(selectedPlanMemberIds);
    memberInitialSnapshotRef.current = serializeMemberIds(selectedPlanMemberIds);
    setMemberPickerSearch('');
    setMemberPickerStatusFilter('all');
    setMemberTagPopover(null);
    setMemberPickerOpen(true);
  };

  const closeMemberPicker = () => {
    if (saving) return;
    if (membersDirty) {
      setDiscardTarget('members');
      return;
    }
    setMemberTagPopover(null);
    setMemberPickerOpen(false);
  };

  const savePlanMembers = async () => {
    if (!selectedPlan) return;
    setSaving(true);
    try {
      const { error } = await supabase.rpc('set_notification_automation_plan_members', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_plan_id: selectedPlan.id,
        p_user_ids: pendingMemberIds,
      });
      if (error) throw error;
      setMemberTagPopover(null);
      setMemberPickerOpen(false);
      showNotice('success', `員工名單已更新：新增 ${membersAdded.length} 名、移除 ${membersRemoved.length} 名${membersMoved.length ? `，其中 ${membersMoved.length} 名由其他方案移入` : ''}`);
      setRefreshing(true);
      await loadDashboard(dashboard.selected_owner_id);
    } catch {
      showNotice('error', '無法更新方案員工，請稍後再試。');
    } finally {
      setSaving(false);
    }
  };

  const openNewTask = () => {
    if (!selectedPlan || selectedPlan.status === 'archived') {
      showNotice('info', isUngroupedSelected ? '新增任務前，請先選擇一個方案。' : '封存方案無法新增任務，請先恢復方案。');
      return;
    }
    const next = createDefaultForm(selectedPlan.id);
    const content = buildEnglishContent(next.triggerType, next.rewardEnabled);
    next.titleTemplate = content.title;
    next.contentTemplate = content.content;
    setForm(next);
    editorInitialSnapshotRef.current = serializeTaskForm(next);
    setContentCustomized(false);
    setReadOnly(false);
    setVariableHelpOpen(false);
    setEmployeePreviewOpen(false);
    setEmployeePickerOpen(false);
    setEditorOpen(true);
  };

  const openTask = (task: AutomationTask) => {
    const taskPlan = task.plan_id ? planById.get(task.plan_id) : null;
    const nextForm = taskToForm(task);
    setForm(nextForm);
    editorInitialSnapshotRef.current = serializeTaskForm(nextForm);
    setContentCustomized(true);
    setReadOnly(taskPlan?.status === 'archived');
    setVariableHelpOpen(false);
    setEmployeePreviewOpen(false);
    setEmployeePickerOpen(false);
    setEditorOpen(true);
  };

  const closeTaskEditor = () => {
    if (saving) return;
    if (editorDirty) {
      setDiscardTarget('task');
      return;
    }
    setVariableHelpOpen(false);
    setEmployeePreviewOpen(false);
    setEmployeePickerOpen(false);
    setEditorOpen(false);
  };

  const confirmDiscardChanges = () => {
    if (discardTarget === 'plan') setPlanModalOpen(false);
    if (discardTarget === 'members') setMemberPickerOpen(false);
    if (discardTarget === 'task') {
      setVariableHelpOpen(false);
      setEmployeePreviewOpen(false);
      setEmployeePickerOpen(false);
      setEditorOpen(false);
    }
    setDiscardTarget(null);
  };

  const openEmployeePicker = (initialRecipientIds = form.recipientIds) => {
    setPendingRecipientIds(initialRecipientIds);
    setEmployeePickerSearch('');
    setEmployeePickerStatusFilter('all');
    setEmployeePickerOpen(true);
  };

  const saveEmployeePicker = () => {
    if (pendingRecipientIds.length === 0) {
      showNotice('error', '請至少選擇一名員工');
      return;
    }
    setForm(previous => ({ ...previous, recipientScope: 'selected', recipientIds: pendingRecipientIds }));
    setEmployeePickerOpen(false);
  };

  const saveTask = async () => {
    if (!form.name.trim()) {
      showNotice('error', '請輸入任務名稱');
      return;
    }
    if (!form.titleTemplate.trim() || !form.contentTemplate.trim()) {
      showNotice('error', '請確認英文通知標題與內容');
      return;
    }
    if (form.triggerType !== 'annual_date' && Number(form.thresholdValue) <= 0) {
      showNotice('error', '觸發數值必須大於零');
      return;
    }
    if ((form.triggerType === 'work_days' || form.triggerType === 'consecutive_work_days') && Number(form.minimumDailyOrders) <= 0) {
      showNotice('error', '請設定每天至少完成訂單數');
      return;
    }
    if (form.triggerType === 'annual_date') {
      const annualMonth = Number(form.annualMonth);
      const annualDay = Number(form.annualDay);
      const maximumDay = new Date(2000, annualMonth, 0).getDate();
      if (!Number.isInteger(annualMonth) || annualMonth < 1 || annualMonth > 12 || !Number.isInteger(annualDay) || annualDay < 1 || annualDay > maximumDay) {
        showNotice('error', '請設定有效的每年指定日期');
        return;
      }
    }
    if (form.rewardEnabled && Number(form.rewardAmount) <= 0) {
      showNotice('error', '獎金金額必須大於零');
      return;
    }
    if (form.planId === null && form.recipientScope === 'selected' && form.recipientIds.length === 0) {
      showNotice('error', '請至少選擇一名員工');
      return;
    }
    if (!form.id) {
      const taskPlan = form.planId ? planById.get(form.planId) : null;
      if (!taskPlan || taskPlan.status === 'archived') {
        showNotice('error', '新任務只能建立在未封存的方案內');
        return;
      }
    }

    setSaving(true);
    try {
      const { error } = await supabase.rpc('save_notification_automation_task_v2', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_owner_admin_id: dashboard.selected_owner_id,
        p_plan_id: form.planId,
        p_task_id: form.id,
        p_name: form.name.trim(),
        p_description: '',
        p_trigger_type: form.triggerType,
        p_trigger_mode: form.triggerType === 'first_login' || form.triggerType === 'annual_date' ? 'reach_once' : form.triggerMode,
        p_threshold_value: form.triggerType === 'first_login' || form.triggerType === 'annual_date' ? 1 : Number(form.thresholdValue),
        p_minimum_daily_orders: form.triggerType === 'work_days' || form.triggerType === 'consecutive_work_days' ? Number(form.minimumDailyOrders) : null,
        p_minimum_daily_work_minutes: form.minimumDailyWorkMinutes ? Number(form.minimumDailyWorkMinutes) : null,
        p_annual_month: form.triggerType === 'annual_date' ? Number(form.annualMonth) : null,
        p_annual_day: form.triggerType === 'annual_date' ? Number(form.annualDay) : null,
        p_recipient_scope: form.planId === null ? form.recipientScope : 'selected',
        p_recipient_ids: form.planId === null && form.recipientScope === 'selected' ? form.recipientIds : [],
        p_title_template: form.titleTemplate.trim(),
        p_content_template: form.contentTemplate.trim(),
        p_delivery_mode: form.deliveryMode,
        p_priority: form.priority,
        p_reward_enabled: form.rewardEnabled,
        p_reward_amount: form.rewardEnabled ? Number(form.rewardAmount) : null,
        p_starts_at: form.startsAt ? new Date(form.startsAt).toISOString() : null,
        p_ends_at: null,
      });
      if (error) throw error;
      showNotice('success', form.id ? '任務已更新並重設為草稿' : '自動化任務已儲存為草稿');
      setEditorOpen(false);
      setVariableHelpOpen(false);
      setEmployeePreviewOpen(false);
      setEmployeePickerOpen(false);
      setRefreshing(true);
      await loadDashboard(dashboard.selected_owner_id);
    } catch {
      showNotice('error', '自動化任務儲存失敗，請確認設定後再試。');
    } finally {
      setSaving(false);
    }
  };

  const changeTaskStatus = async (task: AutomationTask, status: TaskStatus) => {
    const taskPlan = task.plan_id ? planById.get(task.plan_id) : null;
    if (status === 'active' && taskPlan && taskPlan.status !== 'active') {
      showNotice('info', `方案目前為「${planStatusLabels[taskPlan.status]}」，請先恢復方案才能啟用任務。`);
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.rpc('set_notification_automation_task_status_v2', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_task_id: task.id,
        p_status: status,
      });
      if (error) throw error;
      if (status === 'active') {
        showNotice('success', '現有進度已設為基準，後續達標將從新基準開始計算。', '任務啟用成功', 'activated');
      } else if (status === 'paused') {
        showNotice('success', '此任務已停止執行，可隨時再次啟用。', '任務已暫停', 'paused');
      } else {
        showNotice('success', '任務狀態已完成更新。', '狀態更新成功');
      }
      setRefreshing(true);
      await loadDashboard(dashboard.selected_owner_id);
    } catch {
      showNotice('error', '無法更新任務狀態，請稍後再試。');
    } finally {
      setSaving(false);
    }
  };

  const deleteTask = async () => {
    if (!deleteTarget) return;
    setDeletingTaskId(deleteTarget.id);
    try {
      const { error } = await supabase.rpc('delete_notification_automation_task', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_task_id: deleteTarget.id,
      });
      if (error) throw error;
      showNotice('success', `任務「${deleteTarget.name}」已刪除`);
      setDeleteTarget(null);
      setRefreshing(true);
      await loadDashboard(dashboard.selected_owner_id);
    } catch {
      showNotice('error', '無法刪除任務，請稍後再試。');
    } finally {
      setDeletingTaskId(null);
    }
  };

  const regenerateContent = () => {
    const content = buildEnglishContent(form.triggerType, form.rewardEnabled);
    setForm(previous => ({ ...previous, titleTemplate: content.title, contentTemplate: content.content }));
    setContentCustomized(false);
  };

  const togglePendingRecipient = (employeeId: string) => {
    setPendingRecipientIds(previous => previous.includes(employeeId)
      ? previous.filter(id => id !== employeeId)
      : [...previous, employeeId]);
  };

  const togglePendingMember = (employeeId: string) => {
    setPendingMemberIds(previous => previous.includes(employeeId)
      ? previous.filter(id => id !== employeeId)
      : [...previous, employeeId]);
  };

  const noticeCard = notice && createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-5 z-[250] flex justify-center px-4 sm:justify-end sm:px-6" role={notice.type === 'error' ? 'alert' : 'status'}>
      <div className={`pointer-events-auto relative flex w-full max-w-sm items-start gap-3 overflow-hidden rounded-2xl border p-4 shadow-2xl ${
        notice.variant === 'activated'
          ? 'border-emerald-100/60 bg-gradient-to-br from-emerald-500 via-teal-600 to-cyan-700'
          : notice.variant === 'paused'
            ? 'border-amber-100/60 bg-gradient-to-br from-amber-400 via-orange-500 to-rose-600'
            : notice.type === 'success'
              ? 'border-sky-100/60 bg-gradient-to-br from-sky-500 via-blue-600 to-indigo-700'
              : notice.type === 'error'
                ? 'border-rose-100/60 bg-gradient-to-br from-rose-500 via-red-600 to-pink-700'
                : 'border-amber-100/60 bg-gradient-to-br from-amber-400 via-orange-500 to-yellow-600'
      }`}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/30 bg-white/20 text-white">
          {notice.variant === 'activated' ? <Play className="h-5 w-5 fill-current" /> : notice.variant === 'paused' ? <Pause className="h-5 w-5 fill-current" /> : notice.type === 'success' ? <CheckCircle2 className="h-5 w-5" /> : notice.type === 'error' ? <AlertCircle className="h-5 w-5" /> : <Info className="h-5 w-5" />}
        </span>
        <div className="min-w-0 flex-1 text-white">
          <p className="text-sm font-black">{notice.title || (notice.type === 'success' ? '操作成功' : notice.type === 'error' ? '操作未完成' : '操作提示')}</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-white/90">{notice.message}</p>
        </div>
        <button type="button" onClick={() => setNotice(null)} className="flex h-7 w-7 items-center justify-center rounded-lg text-white/70 hover:bg-white/20 hover:text-white" aria-label="關閉提示"><X className="h-4 w-4" /></button>
      </div>
    </div>,
    document.body,
  );

  const deleteDialog = deleteTarget && createPortal(
    <div className="fixed inset-0 z-[220] flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-rose-300/25 bg-slate-900 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="delete-task-title">
        <div className="flex items-start gap-3 border-b border-rose-300/15 bg-rose-500/[0.08] px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-rose-300/25 bg-rose-400/15 text-rose-300"><Trash2 className="h-5 w-5" /></span>
          <div><h2 id="delete-task-title" className="text-sm font-black text-white">刪除自動化任務？</h2><p className="mt-1 text-xs leading-5 text-rose-100/70">刪除後無法恢復，請確認是否繼續。</p></div>
        </div>
        <div className="px-5 py-4"><p className="truncate rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm font-bold text-slate-100">{deleteTarget.name}</p></div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button type="button" onClick={() => setDeleteTarget(null)} disabled={deletingTaskId !== null} className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-4 text-xs font-bold text-slate-200 disabled:opacity-50">取消</button>
          <button type="button" onClick={() => void deleteTask()} disabled={deletingTaskId !== null} className="flex h-9 items-center gap-2 rounded-lg bg-rose-600 px-4 text-xs font-black text-white disabled:opacity-60">{deletingTaskId ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}{deletingTaskId ? '刪除中……' : '確認刪除'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );

  const discardDialog = discardTarget && createPortal(
    <div className="fixed inset-0 z-[230] flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-sm">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl border border-amber-300/25 bg-slate-900 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="discard-changes-title">
        <div className="flex items-start gap-3 border-b border-amber-300/15 bg-amber-500/[0.08] px-5 py-4"><span className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-300/25 bg-amber-400/15 text-amber-200"><AlertCircle className="h-5 w-5" /></span><div><h2 id="discard-changes-title" className="text-sm font-black text-white">放棄未儲存的變更？</h2><p className="mt-1 text-xs leading-5 text-amber-100/75">關閉後，本次編輯內容不會保留。</p></div></div>
        <div className="flex justify-end gap-2 px-5 py-3"><button type="button" onClick={() => setDiscardTarget(null)} className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-4 text-xs font-bold text-slate-200">繼續編輯</button><button type="button" onClick={confirmDiscardChanges} className="h-9 rounded-lg bg-amber-500 px-4 text-xs font-black text-slate-950 hover:bg-amber-400">放棄變更</button></div>
      </div>
    </div>,
    document.body,
  );

  const planArchiveDialog = planArchiveTarget && createPortal(
    <div className="fixed inset-0 z-[225] flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-amber-300/30 bg-slate-900 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="archive-plan-title">
        <div className="flex items-start gap-3 border-b border-amber-300/15 bg-amber-500/[0.08] px-5 py-4"><span className="flex h-10 w-10 items-center justify-center rounded-xl border border-amber-300/25 bg-amber-400/15 text-amber-200"><Archive className="h-5 w-5" /></span><div><h2 id="archive-plan-title" className="text-sm font-black text-white">封存自動化方案？</h2><p className="mt-1 text-xs leading-5 text-amber-100/75">封存後方案與任務會停止執行，但資料仍可查看、恢復或永久刪除。</p></div></div>
        <div className="px-5 py-4"><p className="truncate rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm font-black text-slate-100">{planArchiveTarget.name}</p></div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3"><button type="button" onClick={() => setPlanArchiveTarget(null)} disabled={saving} className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-4 text-xs font-bold text-slate-200 disabled:opacity-50">取消</button><button type="button" onClick={() => { const plan = planArchiveTarget; setPlanArchiveTarget(null); void changePlanStatus(plan, 'archived'); }} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-amber-500 px-4 text-xs font-black text-slate-950 hover:bg-amber-400 disabled:opacity-50"><Archive className="h-3.5 w-3.5" />確認封存</button></div>
      </div>
    </div>,
    document.body,
  );

  const planDeleteDialog = planDeleteTarget && createPortal(
    <div className="fixed inset-0 z-[225] flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-rose-300/30 bg-slate-900 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="delete-plan-title">
        <div className="flex items-start gap-3 border-b border-rose-300/15 bg-rose-500/[0.08] px-5 py-4"><span className="flex h-10 w-10 items-center justify-center rounded-xl border border-rose-300/25 bg-rose-400/15 text-rose-300"><Archive className="h-5 w-5" /></span><div><h2 id="delete-plan-title" className="text-sm font-black text-white">永久刪除封存方案？</h2><p className="mt-1 text-xs leading-5 text-rose-100/75">這會同時刪除方案內任務、收件人設定與進度，無法復原。</p></div></div>
        <div className="space-y-2 px-5 py-4"><p className="truncate rounded-xl border border-slate-700 bg-slate-950/70 px-3 py-2.5 text-sm font-black text-slate-100">{planDeleteTarget.name}</p><p className="text-xs text-slate-400">將刪除 <strong className="text-rose-200">{planDeleteTarget.task_count}</strong> 條方案任務；歷史執行、消息與獎勵記錄會保留。</p></div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3"><button type="button" onClick={() => setPlanDeleteTarget(null)} disabled={saving} className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-4 text-xs font-bold text-slate-200 disabled:opacity-50">取消</button><button type="button" onClick={() => void deleteArchivedPlan()} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-rose-600 px-4 text-xs font-black text-white hover:bg-rose-500 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />永久刪除</button></div>
      </div>
    </div>,
    document.body,
  );

  const planDialog = planModalOpen && createPortal(
    <div className="fixed inset-0 z-[210] flex items-center justify-center bg-slate-950/80 px-4 py-6 backdrop-blur-sm" onMouseDown={closePlanModal}>
      <div className={`w-full max-w-lg overflow-hidden rounded-2xl border border-cyan-300/25 bg-slate-900 shadow-2xl ${saving ? 'pointer-events-none' : ''}`} role="dialog" aria-modal="true" aria-labelledby="plan-dialog-title" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-cyan-300/20 bg-gradient-to-r from-blue-950 to-cyan-950 px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200"><Settings2 className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/60">{selectedOwnerName}</p><h2 id="plan-dialog-title" className="text-base font-black text-white">{editingPlan ? '編輯自動化方案' : '新增自動化方案'}</h2></div>
          <button type="button" onClick={closePlanModal} disabled={saving} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-4 p-5">
          <label className="block"><span className="mb-1.5 block text-xs font-bold text-slate-300">方案名稱</span><input autoFocus maxLength={120} value={planName} onChange={event => setPlanName(event.target.value)} placeholder="例如：新進員工成長方案" className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm font-semibold text-slate-900 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-400/25" /></label>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-800 px-5 py-3">
          <button type="button" onClick={closePlanModal} disabled={saving} className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-4 text-xs font-bold text-slate-200 disabled:opacity-50">取消</button>
          <button type="button" onClick={() => void savePlan()} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 text-xs font-black text-white disabled:opacity-50">{saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}{editingPlan ? '儲存變更' : '建立方案'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );

  const memberPickerDialog = memberPickerOpen && selectedPlan && createPortal(
    <div className="fixed inset-0 z-[215] flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm" onMouseDown={closeMemberPicker}>
      <div className={`flex h-[min(820px,calc(100vh-24px))] w-full max-w-3xl flex-col overflow-hidden rounded-3xl border border-cyan-300/30 bg-slate-900 shadow-[0_24px_64px_rgba(2,6,23,0.7)] ${saving ? 'pointer-events-none' : ''}`} role="dialog" aria-modal="true" aria-labelledby="member-picker-title" onMouseDown={event => event.stopPropagation()}>
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-cyan-300/20 bg-gradient-to-r from-blue-950 via-cyan-950 to-blue-950 px-4 py-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200"><Users className="h-5 w-5" /></span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2"><h2 id="member-picker-title" className="shrink-0 text-base font-black text-white">管理方案員工</h2><span className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-cyan-300/25 bg-cyan-400/10 px-2.5 py-1 text-xs font-bold text-cyan-50 shadow-[0_4px_12px_rgba(6,182,212,0.1)]"><span className="shrink-0 text-[9px] font-black uppercase tracking-[0.12em] text-cyan-200/70">目前方案</span><span className="h-3 w-px shrink-0 bg-cyan-200/25" /><span className="truncate">{selectedOwnerName} · {selectedPlan.name}</span></span></div>
          <div className="relative w-full sm:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /><input autoFocus value={memberPickerSearch} onChange={event => setMemberPickerSearch(event.target.value)} placeholder="搜尋帳號、員工 ID 或標籤" className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-10 text-sm font-semibold text-slate-900 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-400/25" />{memberPickerSearch && <button type="button" onClick={() => setMemberPickerSearch('')} className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700" aria-label="清除搜尋"><X className="h-3.5 w-3.5" /></button>}</div>
          <button type="button" onClick={closeMemberPicker} disabled={saving} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cyan-300/15 bg-gradient-to-r from-slate-950 via-blue-950 to-cyan-950 px-4 py-2.5">
          <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-slate-950/40 px-2 py-1.5 shadow-inner shadow-slate-950/40">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-200"><SlidersHorizontal className="h-3.5 w-3.5" /></span>
            <span className="mr-0.5 text-[10px] font-black tracking-[0.12em] text-cyan-100/70">員工狀態</span>
            {(['all', 'active', 'inactive'] as const).map(status => <button key={status} type="button" onClick={() => setMemberPickerStatusFilter(status)} className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-black transition-all ${memberPickerStatusFilter === status ? status === 'all' ? 'border-sky-200/70 bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-[0_4px_10px_rgba(37,99,235,0.3)]' : status === 'active' ? 'border-emerald-200/70 bg-gradient-to-r from-emerald-500 to-teal-600 text-white shadow-[0_4px_10px_rgba(16,185,129,0.25)]' : 'border-rose-200/70 bg-gradient-to-r from-rose-500 to-red-600 text-white shadow-[0_4px_10px_rgba(244,63,94,0.25)]' : status === 'all' ? 'border-sky-300/25 bg-sky-400/10 text-sky-200 hover:bg-sky-400/20' : status === 'active' ? 'border-emerald-300/25 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20' : 'border-rose-300/25 bg-rose-400/10 text-rose-200 hover:bg-rose-400/20'}`}>{status === 'all' ? '全部' : status === 'active' ? '啟用' : '停用'}</button>)}
          </div>
        </div>
        <div className="grid min-h-0 flex-1 md:grid-cols-[2fr_1fr]">
          <div className="flex min-h-0 flex-col border-b border-slate-700 bg-slate-950 md:border-b-0 md:border-r">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 bg-slate-900 px-4 py-2.5"><div className="flex items-center gap-2"><p className="text-xs font-black text-white">可選員工</p><span className="rounded-full border border-cyan-300/20 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-black text-cyan-200">{memberPickerResults.length} 名</span></div><div className="flex items-center gap-1.5"><button type="button" disabled={memberPickerResults.length === 0} onClick={() => setPendingMemberIds(previous => allVisibleMembersSelected ? previous.filter(id => !memberPickerResults.some(employee => employee.id === id)) : Array.from(new Set([...previous, ...memberPickerResults.map(employee => employee.id)])))} className="h-7 rounded-lg border border-cyan-300/35 bg-cyan-500/15 px-2.5 text-[10px] font-black text-cyan-100 transition-colors hover:bg-cyan-500/25 disabled:opacity-40">{allVisibleMembersSelected ? '取消全選' : '全選員工'}</button><button type="button" onClick={() => setPendingMemberIds([])} disabled={pendingMemberIds.length === 0} className="h-7 rounded-lg border border-rose-300/30 bg-rose-500/10 px-2.5 text-[10px] font-black text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-40">清除已選</button></div></div>
            <div className="dark-panel-scroll min-h-0 flex-1 divide-y divide-slate-800 overflow-y-auto">
              {memberPickerResults.length === 0 ? <div className="flex h-full items-center justify-center p-8 text-sm text-slate-500">找不到符合條件的員工</div> : memberPickerResults.map(employee => {
                const selected = pendingMemberIds.includes(employee.id);
                const assignedPlanId = memberPlanByEmployeeId.get(employee.id);
                const assignedPlan = assignedPlanId ? planById.get(assignedPlanId) : null;
                const assignedElsewhere = assignedPlan && assignedPlan.id !== selectedPlan.id;
                return <button key={employee.id} type="button" onClick={() => togglePendingMember(employee.id)} className={`flex w-full items-start gap-3 border-l-2 px-4 py-2.5 text-left transition-colors ${selected ? 'border-cyan-300 bg-cyan-500/10' : 'border-transparent hover:bg-slate-800/70'}`}>
                  <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${selected ? 'border-cyan-200 bg-cyan-500 text-white' : 'border-slate-600 bg-slate-950 text-transparent'}`}><CheckCircle2 className="h-3.5 w-3.5" /></span>
                  <span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-2"><span className="truncate text-xs font-black text-white">{employee.username}</span><span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-black ${employee.is_active ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>{employee.is_active ? '啟用' : '停用'}</span></span><span className="mt-0.5 flex min-w-0 items-center gap-1"><span className="shrink-0 text-[10px] text-slate-500">{employee.employee_id}</span>{employee.tags?.length ? <span className="min-w-0 flex-1" onMouseEnter={event => { const rect = event.currentTarget.getBoundingClientRect(); setMemberTagPopover({ employee, x: rect.left, y: rect.bottom + 8 }); }} onMouseLeave={() => setMemberTagPopover(null)}><span className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">{employee.tags.map((tag, index) => <span key={`${tag}-${index}`} className="shrink-0 rounded-full border border-amber-500/30 bg-amber-500/20 px-1.5 py-0 text-[10px] font-medium text-amber-400">{tag}</span>)}</span>{memberTagPopover?.employee.id === employee.id && createPortal(<div className="pointer-events-none fixed z-[260] flex w-max max-w-[320px] flex-wrap gap-1 rounded-lg border border-amber-300 bg-amber-100 px-2.5 py-1.5 text-xs font-semibold text-amber-950 shadow-[0_12px_30px_rgba(2,6,23,0.45)]" style={{ left: memberTagPopover.x, top: memberTagPopover.y }}>{employee.tags.map((tag, index) => <span key={`${tag}-${index}`} className="rounded-full border border-amber-700 bg-amber-900 px-1.5 py-px text-[10px] font-medium text-amber-100">{tag}</span>)}</div>, document.body)}</span> : null}</span>{assignedElsewhere && <span className="mt-1 block truncate text-[10px] font-bold text-amber-300">目前屬於「{assignedPlan.name}」，儲存後將移入此方案</span>}</span>
                </button>;
              })}
            </div>
          </div>
          <div className="flex min-h-0 flex-col bg-gradient-to-b from-yellow-950 via-amber-950 to-stone-950">
            <div className="flex items-center justify-between border-b border-yellow-300/15 bg-gradient-to-r from-yellow-900 via-amber-950 to-stone-950 px-4 py-2.5 shadow-[0_4px_14px_rgba(120,53,15,0.2)]"><div className="flex items-center gap-2"><span className="flex h-6 w-6 items-center justify-center rounded-lg border border-yellow-200/20 bg-yellow-200/10 text-yellow-100"><Users className="h-3.5 w-3.5" /></span><p className="text-xs font-black text-amber-50">已選員工</p></div><span className="rounded-full border border-yellow-200/25 bg-yellow-200/10 px-2 py-1 text-[10px] font-black text-yellow-100">{pendingMemberIds.length} 名</span></div>
            <div className="dark-panel-scroll min-h-0 flex-1 divide-y divide-yellow-200/[0.08] overflow-y-auto">
              {pendingSelectedMembers.length === 0 ? <div className="flex h-full flex-col items-center justify-center p-8 text-center"><span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-yellow-300/15 bg-yellow-300/[0.08] text-yellow-200/80"><Users className="h-6 w-6" /></span><p className="mt-3 text-xs font-black text-yellow-100">{memberPickerSearch || memberPickerStatusFilter !== 'all' ? '找不到符合條件的已選員工' : '尚未選擇員工'}</p><p className="mt-1 text-[10px] font-medium text-yellow-200/45">{memberPickerSearch || memberPickerStatusFilter !== 'all' ? '調整搜尋或篩選條件後再試一次' : '從左側清單加入方案成員'}</p></div> : pendingSelectedMembers.map(employee => <div key={employee.id} className="flex items-center gap-3 border-l-2 border-transparent px-4 py-2.5 transition-colors hover:border-yellow-300/70 hover:bg-yellow-300/[0.07]"><span className="min-w-0 flex-1"><span className="block truncate text-xs font-black text-yellow-50">{employee.username}</span><span className="block truncate text-[10px] text-yellow-200/45">{employee.employee_id}</span></span><span className={`rounded-full px-1.5 py-0.5 text-[9px] font-black ${employee.is_active ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>{employee.is_active ? '啟用' : '停用'}</span><button type="button" onClick={() => togglePendingMember(employee.id)} className="flex h-7 w-7 items-center justify-center rounded-lg text-yellow-200/40 transition-colors hover:bg-rose-500/20 hover:text-rose-200" aria-label={`移除 ${employee.username}`}><X className="h-4 w-4" /></button></div>)}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-cyan-300/15 bg-slate-950/70 px-4 py-3">
          <p className="text-xs font-bold text-slate-300">變更摘要：新增 <span className="text-emerald-300">{membersAdded.length}</span> 名、移除 <span className="text-rose-300">{membersRemoved.length}</span> 名、由其他方案移入 <span className="text-amber-300">{membersMoved.length}</span> 名</p>
          <div className="flex gap-2"><button type="button" onClick={closeMemberPicker} disabled={saving} className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-4 text-xs font-bold text-slate-200 disabled:opacity-50">取消</button><button type="button" onClick={() => void savePlanMembers()} disabled={saving} className="inline-flex h-9 items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 text-xs font-black text-white disabled:opacity-50">{saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}儲存員工名單</button></div>
        </div>
      </div>
    </div>,
    document.body,
  );

  const employeePickerDialog = employeePickerOpen && form.planId === null && createPortal(
    <div className="fixed inset-0 z-[230] flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm" onMouseDown={() => setEmployeePickerOpen(false)}>
      <div className="flex h-[min(780px,calc(100vh-24px))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-cyan-300/25 bg-slate-900 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="legacy-picker-title" onMouseDown={event => event.stopPropagation()}>
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-cyan-300/20 bg-gradient-to-r from-blue-950 to-cyan-950 px-4 py-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200"><Users className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/60">未分組任務</p><h2 id="legacy-picker-title" className="text-base font-black text-white">選擇指定員工</h2></div>
          <div className="relative w-full sm:w-72"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" /><input autoFocus value={employeePickerSearch} onChange={event => setEmployeePickerSearch(event.target.value)} placeholder="搜尋帳號、員工 ID 或標籤" className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm font-semibold text-slate-900 outline-none focus:border-cyan-500" /></div>
          <button type="button" onClick={() => setEmployeePickerOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-700 bg-slate-950/55 px-4 py-2.5">
          <div className="flex gap-1.5">{(['all', 'active', 'inactive'] as const).map(status => <button key={status} type="button" onClick={() => setEmployeePickerStatusFilter(status)} className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-black ${employeePickerStatusFilter === status ? 'border-cyan-300/50 bg-cyan-500/20 text-cyan-100' : 'border-slate-700 text-slate-400'}`}>{status === 'all' ? '全部' : status === 'active' ? '啟用' : '停用'}</button>)}</div>
          <button type="button" disabled={employeePickerResults.length === 0} onClick={() => setPendingRecipientIds(previous => allVisibleEmployeesSelected ? previous.filter(id => !employeePickerResults.some(employee => employee.id === id)) : Array.from(new Set([...previous, ...employeePickerResults.map(employee => employee.id)])))} className="rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-3 py-1.5 text-[11px] font-black text-cyan-100 disabled:opacity-40">{allVisibleEmployeesSelected ? '取消結果' : '選取結果'}</button>
        </div>
        <div className="grid min-h-0 flex-1 md:grid-cols-2">
          <div className="flex min-h-0 flex-col border-b border-slate-700 md:border-b-0 md:border-r"><div className="border-b border-slate-700 px-4 py-2.5 text-xs font-black text-white">可選員工 <span className="ml-1 text-cyan-300">{employeePickerResults.length}</span></div><div className="dark-panel-scroll min-h-0 flex-1 divide-y divide-slate-800 overflow-y-auto">{employeePickerResults.map(employee => {
            const selected = pendingRecipientIds.includes(employee.id);
            return <button key={employee.id} type="button" onClick={() => togglePendingRecipient(employee.id)} className={`flex w-full items-center gap-3 border-l-2 px-4 py-2.5 text-left ${selected ? 'border-cyan-300 bg-cyan-500/10' : 'border-transparent hover:bg-slate-800/70'}`}><span className={`flex h-5 w-5 items-center justify-center rounded-md border ${selected ? 'border-cyan-200 bg-cyan-500 text-white' : 'border-slate-600 text-transparent'}`}><CheckCircle2 className="h-3.5 w-3.5" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-black text-white">{employee.username}</span><span className="block truncate text-[10px] text-slate-500">{employee.employee_id}</span></span><span className={`rounded-full px-1.5 py-0.5 text-[9px] font-black ${employee.is_active ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>{employee.is_active ? '啟用' : '停用'}</span></button>;
          })}</div></div>
          <div className="flex min-h-0 flex-col bg-cyan-950/10"><div className="flex items-center justify-between border-b border-cyan-300/15 px-4 py-2.5"><p className="text-xs font-black text-white">已選員工</p><span className="text-[10px] font-black text-cyan-300">{pendingRecipientIds.length} 名</span></div><div className="dark-panel-scroll min-h-0 flex-1 divide-y divide-cyan-300/10 overflow-y-auto">{pendingSelectedEmployees.length === 0 ? <div className="flex h-full items-center justify-center p-8 text-xs text-slate-500">尚未選擇員工</div> : pendingSelectedEmployees.map(employee => <div key={employee.id} className="flex items-center gap-3 px-4 py-2.5"><span className="min-w-0 flex-1"><span className="block truncate text-xs font-black text-cyan-50">{employee.username}</span><span className="block truncate text-[10px] text-slate-500">{employee.employee_id}</span></span><button type="button" onClick={() => togglePendingRecipient(employee.id)} className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-500 hover:bg-rose-500/10 hover:text-rose-300"><X className="h-4 w-4" /></button></div>)}</div></div>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-cyan-300/15 bg-slate-950/70 px-4 py-3"><p className="text-xs font-bold text-slate-300">已暫存 {pendingRecipientIds.length} 名員工</p><div className="flex gap-2"><button type="button" onClick={() => setEmployeePickerOpen(false)} className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-4 text-xs font-bold text-slate-200">取消</button><button type="button" onClick={saveEmployeePicker} className="inline-flex h-9 items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 text-xs font-black text-white"><CheckCircle2 className="h-4 w-4" />保存選擇</button></div></div>
      </div>
    </div>,
    document.body,
  );

  const variableHelpDialog = variableHelpOpen && createPortal(
    <div className="fixed inset-0 z-[225] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm" onMouseDown={() => setVariableHelpOpen(false)}>
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-cyan-300/25 bg-slate-900 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="variable-help-title" onMouseDown={event => event.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-cyan-300/20 bg-gradient-to-r from-blue-950 to-cyan-950 px-5 py-4"><Info className="h-5 w-5 text-cyan-200" /><div className="min-w-0 flex-1"><h2 id="variable-help-title" className="text-base font-black text-white">英文通知變數說明</h2><p className="mt-1 text-xs text-cyan-100/70">發送時會自動替換成員工與任務的實際資料。</p></div><button type="button" onClick={() => setVariableHelpOpen(false)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-white"><X className="h-4 w-4" /></button></div>
        <div className="grid gap-3 p-5 sm:grid-cols-2">{[
          ['{{employee_name}}', '員工名稱'],
          ['{{actual_value}}', '實際達成值'],
          ['{{threshold_value}}', '任務目標值'],
          ['{{minimum_daily_orders}}', '每日最低訂單數'],
          ['{{annual_month}} / {{annual_day}}', '年度指定日期'],
          ['{{bonus_amount}} / {{currency}}', '獎金與貨幣'],
        ].map(([token, label]) => <div key={token} className="rounded-xl border border-slate-700 bg-slate-950/55 p-3"><code className="font-mono text-xs font-bold text-cyan-200">{token}</code><p className="mt-2 text-xs font-bold text-slate-200">{label}</p></div>)}</div>
      </div>
    </div>,
    document.body,
  );

  if (loading) {
    return <div className="flex min-h-0 flex-1 bg-slate-950"><AdminPageLoading label="自動化方案" /></div>;
  }

  if (editorOpen) {
    const editorPlan = form.planId ? planById.get(form.planId) : null;
    const previewTitle = renderPreview(form.titleTemplate, form, dashboard.currency);
    const previewContent = renderPreview(form.contentTemplate, form, dashboard.currency);
    const employeePreviewDialog = employeePreviewOpen && createPortal(
      <div className={`fixed inset-0 z-[240] flex items-center justify-center bg-slate-900/45 backdrop-blur-sm ${isDesktop ? 'p-4' : ''}`} onMouseDown={() => setEmployeePreviewOpen(false)}>
        <div className={`pointer-events-auto flex w-full max-w-2xl flex-col overflow-hidden ${isDesktop ? 'h-[82vh] max-h-[88vh] rounded-3xl shadow-2xl' : 'h-full'}`} onMouseDown={event => event.stopPropagation()}>
          <EmployeeNotificationDetailPanel message={{ title: previewTitle || 'Notification title', content: previewContent, message_type: form.deliveryMode === 'login_only' ? 'login_popup' : 'realtime', priority: form.priority, notification_category: form.rewardEnabled ? 'performance_reward' : null, reward_amount: form.rewardEnabled ? Number(form.rewardAmount || 0) : null, reward_currency: dashboard.currency, created_at: new Date().toISOString(), is_read: false }} onClose={() => setEmployeePreviewOpen(false)} />
        </div>
      </div>,
      document.body,
    );

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950 text-slate-100">
        {noticeCard}{discardDialog}{variableHelpDialog}{employeePreviewDialog}{employeePickerDialog}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cyan-300/25 bg-gradient-to-r from-blue-950 via-cyan-900 to-blue-950 px-3 py-2 shadow-lg">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" onClick={closeTaskEditor} aria-label="返回上一頁" title="返回上一頁" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-red-200/60 bg-red-600 text-white"><ArrowLeft className="h-4 w-4" /></button>
            <div className="min-w-0"><h2 className="truncate text-base font-black text-white">{readOnly ? '查看自動化任務' : form.id ? '編輯自動化任務' : '新增自動化任務'}</h2><p className="truncate text-[10px] font-bold text-cyan-100/75">{selectedOwnerName} · {editorPlan?.name || '未分組任務'}</p></div>
          </div>
          {readOnly ? <span className="rounded-lg border border-amber-300/25 bg-amber-500/10 px-3 py-1.5 text-xs font-bold text-amber-200">封存方案僅供查看</span> : <button type="button" disabled={saving} onClick={() => void saveTask()} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 text-xs font-black text-white disabled:opacity-50">{saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}儲存任務草稿</button>}
        </div>
        <div className={`min-h-0 flex-1 overflow-y-auto bg-slate-900 xl:overflow-hidden ${saving ? 'pointer-events-none opacity-75' : ''}`}>
          <div className="grid min-h-full grid-cols-1 xl:h-full xl:min-h-0 xl:grid-cols-2">
            <div className="min-h-0 space-y-3 border-slate-700 bg-slate-900/60 p-3 xl:overflow-y-auto xl:border-r">
              <NotificationDeliverySelector value={form.deliveryMode} onChange={deliveryMode => setForm(previous => ({ ...previous, deliveryMode }))} disabled={readOnly} embedded />
              <label className="block"><span className="mb-1.5 block text-xs font-semibold text-slate-400">任務名稱</span><input disabled={readOnly} value={form.name} onChange={event => setForm(previous => ({ ...previous, name: event.target.value }))} placeholder="例如：100 筆訂單鼓勵通知" className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/25 disabled:bg-slate-200" /></label>
              <section className="relative isolate flex flex-col overflow-hidden rounded-2xl border border-cyan-300/25 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.12),transparent_38%),linear-gradient(145deg,rgba(15,23,42,0.98),rgba(2,6,23,0.9))] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_12px_32px_rgba(2,6,23,0.24)] sm:h-[248px]">
                <span className="pointer-events-none absolute -right-8 -top-12 h-32 w-32 rounded-full border border-cyan-300/10 bg-cyan-400/[0.04]" />
                <span className="pointer-events-none absolute bottom-0 left-16 h-px w-48 bg-gradient-to-r from-transparent via-cyan-300/20 to-transparent" />
                <div className="relative z-10 mb-2 flex h-7 shrink-0 items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-200/25 bg-gradient-to-br from-cyan-400/20 to-blue-500/10 text-cyan-200 shadow-[0_0_16px_rgba(34,211,238,0.08)]"><SlidersHorizontal className="h-3.5 w-3.5" /></span><div className="flex min-w-0 items-baseline gap-2"><h3 className="text-xs font-black text-cyan-50">觸發條件</h3><span className="truncate text-[8px] font-black uppercase tracking-[0.18em] text-cyan-300/45">Automation rule</span></div></div>
                  <span className="shrink-0 rounded-full border border-emerald-300/15 bg-emerald-400/[0.07] px-2 py-1 text-[8px] font-black tracking-wide text-emerald-200/75">即時規則</span>
                </div>
                <div className="relative z-10 grid gap-3 sm:h-[150px] sm:shrink-0 sm:grid-cols-3 sm:grid-rows-2">
                  <div><span className="mb-1 block text-[11px] font-black tracking-wide text-cyan-50/90">條件類型</span><AutomationRuleSelect ariaLabel="條件類型" disabled={readOnly} accent value={form.triggerType} options={Object.entries(triggerLabels).map(([value, label]) => ({ value, label }))} onChange={value => { const triggerType = value as TriggerType; const fixedThresholdTrigger = triggerType === 'first_login' || triggerType === 'annual_date'; setContentCustomized(false); setForm(previous => ({ ...previous, triggerType, triggerMode: fixedThresholdTrigger ? 'reach_once' : previous.triggerMode, thresholdValue: fixedThresholdTrigger ? '1' : previous.thresholdValue })); }} /></div>
                  {form.triggerType !== 'annual_date' && form.triggerType !== 'first_login' ? <>
                    <div><span className="mb-1 block text-[11px] font-black tracking-wide text-blue-100/80">觸發方式</span><AutomationRuleSelect ariaLabel="觸發方式" disabled={readOnly} value={form.triggerMode} options={[{ value: 'reach_once', label: '累計達到一次' }, { value: 'recurring', label: '每達到指定數量' }]} onChange={value => setForm(previous => ({ ...previous, triggerMode: value as TriggerMode }))} /></div>
                    <label><span className="mb-1 block text-[11px] font-black tracking-wide text-blue-100/80">{form.triggerType === 'commission_amount' ? `目標金額（${dashboard.currency}）` : form.triggerType.includes('work_days') ? '目標天數' : '目標訂單數'}</span><input disabled={readOnly} type="number" min={form.triggerType === 'commission_amount' ? '0.01' : '1'} step={form.triggerType === 'commission_amount' ? '0.01' : '1'} value={form.thresholdValue} onChange={event => setForm(previous => ({ ...previous, thresholdValue: event.target.value }))} className="h-9 w-full rounded-lg border border-slate-600/80 bg-slate-900/90 px-3 text-sm font-black text-white shadow-[inset_0_1px_3px_rgba(2,6,23,0.55)] outline-none transition focus:border-cyan-300/65 focus:ring-2 focus:ring-cyan-400/10 disabled:opacity-60" /></label>
                  </> : form.triggerType === 'annual_date' ? <>
                    <div><span className="mb-1 block text-[11px] font-black tracking-wide text-blue-100/80">月份</span><AutomationRuleSelect ariaLabel="月份" disabled={readOnly} value={form.annualMonth} options={Array.from({ length: 12 }, (_, index) => ({ value: String(index + 1), label: `${index + 1} 月` }))} onChange={value => setForm(previous => ({ ...previous, annualMonth: value }))} /></div>
                    <label><span className="mb-1 block text-[11px] font-black tracking-wide text-blue-100/80">日期</span><input disabled={readOnly} type="number" min="1" max={new Date(2000, Number(form.annualMonth), 0).getDate()} value={form.annualDay} onChange={event => setForm(previous => ({ ...previous, annualDay: event.target.value }))} className="h-9 w-full rounded-lg border border-slate-600/80 bg-slate-900/90 px-3 text-sm font-black text-white shadow-[inset_0_1px_3px_rgba(2,6,23,0.55)] outline-none transition focus:border-cyan-300/65 focus:ring-2 focus:ring-cyan-400/10 disabled:opacity-60" /></label>
                  </> : <><div aria-hidden="true" /><div aria-hidden="true" /></>}
                  {(form.triggerType === 'work_days' || form.triggerType === 'consecutive_work_days') ? <>
                    <label><span className="mb-1 block text-[11px] font-black tracking-wide text-blue-100/80">每天至少完成訂單數</span><input disabled={readOnly} type="number" min="1" value={form.minimumDailyOrders} onChange={event => setForm(previous => ({ ...previous, minimumDailyOrders: event.target.value }))} className="h-9 w-full rounded-lg border border-slate-600/80 bg-slate-900/90 px-3 text-sm font-black text-white shadow-[inset_0_1px_3px_rgba(2,6,23,0.55)] outline-none transition focus:border-cyan-300/65 focus:ring-2 focus:ring-cyan-400/10 disabled:opacity-60" /></label>
                    <label><span className="mb-1 block truncate text-[11px] font-black tracking-wide text-blue-100/80">每天至少工作分鐘（選填）</span><input disabled={readOnly} type="number" min="1" value={form.minimumDailyWorkMinutes} onChange={event => setForm(previous => ({ ...previous, minimumDailyWorkMinutes: event.target.value }))} className="h-9 w-full rounded-lg border border-slate-600/80 bg-slate-900/90 px-3 text-sm font-black text-white shadow-[inset_0_1px_3px_rgba(2,6,23,0.55)] outline-none transition focus:border-cyan-300/65 focus:ring-2 focus:ring-cyan-400/10 disabled:opacity-60" /></label>
                    <div aria-hidden="true" />
                  </> : <><div aria-hidden="true" /><div aria-hidden="true" /><div aria-hidden="true" /></>}
                </div>
                <div className="relative z-10 mt-auto flex h-9 shrink-0 items-center gap-2 overflow-hidden rounded-lg border border-cyan-300/20 bg-gradient-to-r from-cyan-500/15 via-blue-500/10 to-slate-900/40 px-2.5 text-xs text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"><Sparkles className="h-3.5 w-3.5 shrink-0 text-cyan-300" /><span className="shrink-0 text-[9px] font-black uppercase tracking-[0.12em] text-cyan-300/55">規則摘要</span><span className="h-3 w-px shrink-0 bg-cyan-200/15" /><span className="min-w-0 truncate font-bold">{summarizeTask({ trigger_type: form.triggerType, trigger_mode: form.triggerType === 'annual_date' ? 'reach_once' : form.triggerMode, threshold_value: Number(form.thresholdValue || 0), minimum_daily_orders: Number(form.minimumDailyOrders || 0), minimum_daily_work_minutes: form.minimumDailyWorkMinutes ? Number(form.minimumDailyWorkMinutes) : null, annual_month: Number(form.annualMonth || 1), annual_day: Number(form.annualDay || 1) } as AutomationTask, dashboard.currency)}</span></div>
              </section>
              <section className={`relative min-h-[68px] overflow-hidden rounded-xl border px-3 py-2.5 transition-colors sm:h-[68px] ${form.rewardEnabled ? 'border-amber-300/45 bg-[linear-gradient(90deg,rgba(120,53,15,0.3),rgba(15,23,42,0.94)_62%,rgba(8,47,73,0.38))] shadow-[0_8px_22px_rgba(245,158,11,0.07)]' : 'border-slate-700 bg-[linear-gradient(90deg,rgba(15,23,42,0.94),rgba(2,6,23,0.76))]'}`}>
                <span className={`pointer-events-none absolute -right-6 -top-10 h-24 w-24 rounded-full blur-3xl ${form.rewardEnabled ? 'bg-amber-400/20' : 'bg-cyan-400/5'}`} />
                <div className="relative flex h-full flex-wrap items-center gap-2.5 sm:flex-nowrap">
                  <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${form.rewardEnabled ? 'border-amber-200/35 bg-gradient-to-br from-amber-400/30 to-yellow-500/10 text-amber-200' : 'border-slate-600 bg-slate-800/80 text-slate-400'}`}><Gift className="h-4.5 w-4.5" /></span>
                  <div className="min-w-[136px] flex-1"><h3 className="text-sm font-black text-white">績效獎金</h3><p className={`truncate text-[10px] font-semibold ${form.rewardEnabled ? 'text-amber-100/65' : 'text-slate-500'}`}>達標時同步發放獎金</p></div>
                  {form.rewardEnabled && <label className="flex shrink-0 items-center gap-1.5"><span className="text-[11px] font-black text-amber-100">獎金</span><input disabled={readOnly} type="number" min="0.01" step="0.01" value={form.rewardAmount} onChange={event => setForm(previous => ({ ...previous, rewardAmount: event.target.value }))} placeholder="0.00" aria-label="每次獎金金額" className="h-8 w-28 rounded-lg border border-amber-300/70 bg-white px-2.5 text-sm font-black text-slate-900 outline-none focus:ring-2 focus:ring-amber-300/25 disabled:bg-slate-200" /><span className="text-[11px] font-black text-amber-200">{dashboard.currency}</span></label>}
                  <button type="button" disabled={readOnly} aria-pressed={form.rewardEnabled} onClick={() => { setContentCustomized(false); setForm(previous => ({ ...previous, rewardEnabled: !previous.rewardEnabled })); }} className={`inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-2.5 text-[11px] font-black transition-colors ${form.rewardEnabled ? 'border-amber-200/45 bg-amber-400/15 text-amber-100' : 'border-slate-600 bg-slate-800/90 text-slate-300'} disabled:opacity-50`}><span>{form.rewardEnabled ? '已啟用' : '未啟用'}</span><span className={`relative h-4 w-7 rounded-full transition-colors ${form.rewardEnabled ? 'bg-amber-400' : 'bg-slate-600'}`}><span className={`absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${form.rewardEnabled ? 'translate-x-3.5' : 'translate-x-0.5'}`} /></span></button>
                </div>
              </section>
              {form.planId === null && <section className="rounded-xl border border-slate-700 bg-slate-950/35 p-3">
                <div className="mb-3 flex items-center gap-1.5 text-xs font-black text-cyan-200"><Users className="h-3.5 w-3.5" />適用員工</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <button type="button" disabled={readOnly} onClick={() => setForm(previous => ({ ...previous, recipientScope: 'all_managed', recipientIds: [] }))} className={`rounded-lg border px-3 py-2 text-left ${form.recipientScope === 'all_managed' ? 'border-cyan-400 bg-cyan-500/15 text-cyan-100' : 'border-slate-700 text-slate-400'} disabled:opacity-50`}><p className="text-sm font-bold">所有員工</p><p className="mt-0.5 text-[10px] opacity-70">此管理員範圍內的員工會自動適用</p></button>
                  <button type="button" disabled={readOnly} onClick={() => { setForm(previous => ({ ...previous, recipientScope: 'selected' })); openEmployeePicker(form.recipientScope === 'selected' ? form.recipientIds : []); }} className={`rounded-lg border px-3 py-2 text-left ${form.recipientScope === 'selected' ? 'border-cyan-400 bg-cyan-500/15 text-cyan-100' : 'border-slate-700 text-slate-400'} disabled:opacity-50`}><p className="text-sm font-bold">指定員工</p><p className="mt-0.5 text-[10px] opacity-70">沿用此舊任務的個別名單</p></button>
                </div>
                {form.recipientScope === 'selected' && <div className="mt-3 rounded-lg border border-cyan-300/20 bg-cyan-500/[0.05] p-2.5"><div className="flex items-center justify-between gap-2"><p className="text-xs font-bold text-cyan-100">已選擇 {selectedEmployees.length} 名員工</p><button type="button" disabled={readOnly} onClick={() => openEmployeePicker()} className="rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-2.5 py-1.5 text-[10px] font-black text-cyan-100 disabled:opacity-50">編輯名單</button></div>{selectedEmployees.length > 0 && <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">{selectedEmployees.map(employee => <span key={employee.id} className="rounded-md border border-cyan-300/20 bg-slate-950/60 px-2 py-1 text-[10px] text-slate-300"><strong className="text-cyan-100">{employee.username}</strong> · {employee.employee_id}</span>)}</div>}</div>}
              </section>}
            </div>
            <div className="flex min-h-[620px] flex-col border-slate-700 bg-slate-950/35 p-3 xl:min-h-0 xl:border-l">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 border-l-2 border-cyan-400 pl-2.5"><FileText className="h-4 w-4 text-cyan-300" /><div><h3 className="text-sm font-black text-white">英文通知內容</h3><p className="text-[10px] text-slate-500">動態變數會在發送時替換</p></div></div><div className="flex flex-wrap gap-2"><button type="button" onClick={() => setEmployeePreviewOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-blue-300/35 bg-blue-500/15 px-2.5 text-[11px] font-bold text-blue-100"><Eye className="h-3.5 w-3.5" />員工端預覽</button><button type="button" onClick={() => setVariableHelpOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-2.5 text-[11px] font-bold text-cyan-200"><Info className="h-3.5 w-3.5" />變數說明</button>{!readOnly && <button type="button" onClick={regenerateContent} className="h-8 rounded-lg border border-cyan-300/30 bg-cyan-500/10 px-2.5 text-[11px] font-bold text-cyan-200">重新產生預設內容</button>}</div></div>
              <label className="shrink-0"><span className="mb-1.5 block text-xs font-semibold text-slate-400">通知標題</span><input disabled={readOnly} value={form.titleTemplate} onChange={event => { setContentCustomized(true); setForm(previous => ({ ...previous, titleTemplate: event.target.value })); }} className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none disabled:bg-slate-200" /></label>
              <div className="mt-3 flex min-h-[460px] flex-1 flex-col"><span className="mb-1.5 text-xs font-semibold text-slate-400">通知內容</span><div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-300 bg-white [&>div]:flex [&>div]:h-full [&>div]:flex-col"><TiptapEditor content={form.contentTemplate} onChange={content => { setContentCustomized(true); setForm(previous => ({ ...previous, contentTemplate: content })); }} placeholder="Write your notification content here..." editable={!readOnly && !saving} adminId={admin.id} theme="light" enableQuickCopy /></div></div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const renderPlanCard = (plan: AutomationPlan, compact = false) => {
    const selected = selectedPlanId === plan.id;
    const statusTone = plan.status === 'active'
      ? 'border-emerald-300/40 bg-emerald-400/15 text-emerald-100'
      : plan.status === 'paused'
        ? 'border-amber-300/40 bg-amber-400/15 text-amber-100'
        : 'border-slate-500/50 bg-slate-700/55 text-slate-200';
    const accentTone = selected
      ? 'bg-gradient-to-b from-white via-cyan-200 to-blue-300'
      : plan.status === 'active'
        ? 'bg-emerald-500/80 group-hover:bg-emerald-300'
        : plan.status === 'paused'
          ? 'bg-amber-500/80 group-hover:bg-amber-300'
          : 'bg-slate-600 group-hover:bg-slate-400';
    const iconTone = selected
      ? 'border-white/80 bg-gradient-to-br from-cyan-500 to-blue-600 text-white'
      : plan.status === 'active'
        ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300 group-hover:border-cyan-300/40 group-hover:bg-cyan-400/15 group-hover:text-cyan-100'
        : plan.status === 'paused'
          ? 'border-amber-400/25 bg-amber-500/10 text-amber-300 group-hover:border-cyan-300/40 group-hover:bg-cyan-400/15 group-hover:text-cyan-100'
          : 'border-slate-600 bg-slate-800 text-slate-400 group-hover:border-cyan-300/40 group-hover:bg-cyan-400/15 group-hover:text-cyan-100';

    return <button key={plan.id} type="button" onClick={() => selectPlan(plan.id)} aria-pressed={selected} className={`group relative w-full overflow-hidden rounded-xl border text-left outline-none transition-all duration-300 focus-visible:ring-2 focus-visible:ring-cyan-300/70 px-2.5 py-2 ${selected ? 'border-white/90 bg-[linear-gradient(120deg,rgba(8,145,178,0.96)_0%,rgba(29,78,216,0.92)_58%,rgba(15,23,42,0.98)_100%)] shadow-[0_6px_14px_rgba(2,6,23,0.42)] ring-1 ring-white/45' : 'border-slate-800 bg-[linear-gradient(145deg,rgba(15,23,42,0.76)_0%,rgba(2,6,23,0.96)_100%)] shadow-[0_3px_10px_rgba(2,6,23,0.3)] hover:-translate-y-px hover:border-slate-500 hover:bg-[linear-gradient(145deg,rgba(30,41,59,0.9)_0%,rgba(8,47,73,0.72)_100%)] hover:shadow-[0_8px_18px_rgba(2,6,23,0.34)]'}`}>
      <span className={`pointer-events-none absolute inset-0 bg-[linear-gradient(110deg,transparent_18%,rgba(255,255,255,0.08)_48%,transparent_76%)] transition-transform duration-500 ${selected ? 'translate-x-0 opacity-0' : '-translate-x-full opacity-0 group-hover:translate-x-full group-hover:opacity-100'}`} />
      <span className={`absolute inset-y-2 left-0 w-[3px] rounded-r-full transition-all duration-300 ${accentTone}`} />
      <span className={`pointer-events-none absolute -right-6 -top-6 h-16 w-16 rounded-full blur-2xl transition-opacity duration-300 ${selected ? 'opacity-0' : 'bg-cyan-400/10 opacity-0 group-hover:opacity-100'}`} />
      <div className="relative flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-all duration-300 ${iconTone}`}><Settings2 className="h-4 w-4" /></span>
        <span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-2"><span className={`min-w-0 truncate text-[13px] font-black tracking-[0.01em] ${selected ? 'text-white' : 'text-slate-100 group-hover:text-white'}`}>{plan.name}</span><span className="flex shrink-0 items-center gap-1.5">{selected && <CheckCircle2 className="h-3.5 w-3.5 text-white" />}<span className={`rounded-full border px-2 py-0.5 text-[9px] font-black tracking-wide ${statusTone}`}>{planStatusLabels[plan.status]}</span></span></span></span>
      </div>
      {!compact && <div className="relative mt-2 grid grid-cols-2 gap-1.5"><span className={`flex min-w-0 items-center justify-between gap-1.5 rounded-lg border px-2 py-1 transition-colors ${selected ? 'border-white/20 bg-slate-950/30' : 'border-slate-700/80 bg-slate-950/55 group-hover:border-slate-500'}`}><span className={`inline-flex items-center gap-1 text-[9px] font-bold ${selected ? 'text-cyan-50' : 'text-slate-300'}`}><Settings2 className="h-3 w-3 text-blue-300" />任務總數</span><strong className="text-[11px] font-black tabular-nums text-blue-100">{plan.task_count}</strong></span><span className={`flex min-w-0 items-center justify-between gap-1.5 rounded-lg border px-2 py-1 transition-colors ${selected ? 'border-white/20 bg-slate-950/30' : 'border-slate-700/80 bg-slate-950/55 group-hover:border-slate-500'}`}><span className={`inline-flex items-center gap-1 text-[9px] font-bold ${selected ? 'text-cyan-50' : 'text-slate-300'}`}><Play className="h-3 w-3 text-emerald-300" />啟用任務</span><strong className="text-[11px] font-black tabular-nums text-emerald-200">{plan.active_task_count}</strong></span></div>}
    </button>;
  };

  const renderTaskActions = (task: AutomationTask) => {
    const taskPlan = task.plan_id ? planById.get(task.plan_id) : null;
    const activationBlocked = Boolean(taskPlan && taskPlan.status !== 'active');
    const activationReason = activationBlocked ? `方案為「${planStatusLabels[taskPlan!.status]}」，請先恢復方案` : '啟用任務';
    return <div className="flex items-center justify-end gap-1.5">
      <button type="button" onClick={() => setDeleteTarget(task)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-rose-400/25 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20" aria-label={`刪除任務 ${task.name}`} title="刪除任務"><Trash2 className="h-3.5 w-3.5" /></button>
      <button type="button" onClick={() => openTask(task)} className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20" aria-label={`編輯任務 ${task.name}`} title={taskPlan?.status === 'archived' ? '查看任務' : '編輯任務'}><Edit3 className="h-3.5 w-3.5" /></button>
      {task.status !== 'active' ? <button type="button" disabled={activationBlocked} onClick={() => void changeTaskStatus(task, 'active')} className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-400/25 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:border-slate-700 disabled:bg-slate-800 disabled:text-slate-600" aria-label={`${activationReason} ${task.name}`} title={activationReason}><Play className="h-3.5 w-3.5" /></button> : <button type="button" onClick={() => void changeTaskStatus(task, 'paused')} className="flex h-8 w-8 items-center justify-center rounded-lg border border-amber-400/25 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20" aria-label={`暫停任務 ${task.name}`} title="暫停任務"><Pause className="h-3.5 w-3.5" /></button>}
    </div>;
  };

  return (
    <>
      {noticeCard}{deleteDialog}{discardDialog}{planArchiveDialog}{planDeleteDialog}{planDialog}{memberPickerDialog}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950 text-slate-100">
        <header className="shrink-0 border-b border-cyan-300/20 bg-[radial-gradient(circle_at_82%_0%,rgba(6,182,212,0.18),transparent_34%),linear-gradient(90deg,#020617_0%,#0f172a_55%,#083344_100%)] px-3 py-3 shadow-[0_8px_24px_rgba(2,6,23,0.32)] sm:px-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <button type="button" onClick={onBack} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-red-400/40 bg-red-500/15 text-red-300 hover:bg-red-500/25"><ArrowLeft className="h-4 w-4" /></button>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/20 bg-cyan-500/10 text-cyan-300"><Sparkles className="h-5 w-5" /></span>
              <div className="flex min-w-0 items-center gap-3"><h1 className="shrink-0 text-lg font-black text-white sm:text-xl">通知自動化方案</h1><div className="flex h-10 w-[260px] min-w-0 items-center gap-2 rounded-xl border border-cyan-300/45 bg-gradient-to-r from-cyan-500/20 via-sky-500/10 to-slate-950/60 px-2.5 shadow-[0_8px_18px_rgba(8,145,178,0.16)]"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-cyan-200/20 bg-cyan-300/15 text-cyan-100"><Users className="h-3.5 w-3.5" /></span><span className="shrink-0 rounded-md border border-cyan-200/25 bg-cyan-200/10 px-1.5 py-0.5 text-[9px] font-black text-cyan-100">目前分組</span><span className="min-w-0 truncate text-xs font-black text-white">{selectedOwnerName} <span className="text-cyan-200">·</span> {currentSelectionName}</span></div></div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {isSuperAdmin ? <div className="relative"><button type="button" onClick={() => setAdminGroupMenuOpen(previous => !previous)} disabled={refreshing || saving || deletingTaskId !== null} aria-expanded={adminGroupMenuOpen} aria-haspopup="menu" className={`inline-flex h-10 w-[260px] items-center justify-between gap-2 rounded-xl border px-3 text-left shadow-[0_8px_18px_rgba(14,116,144,0.18)] transition-all disabled:opacity-50 ${adminGroupMenuOpen ? 'border-cyan-200/70 bg-cyan-400/20 text-cyan-50 ring-2 ring-cyan-300/20' : 'border-cyan-300/35 bg-slate-950/45 text-cyan-50 hover:border-cyan-200/60 hover:bg-cyan-500/15'}`}><span className="flex min-w-0 items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/15 text-white"><Users className="h-3.5 w-3.5" /></span><span className="min-w-0 truncate text-sm font-black leading-5 text-white">{selectedOwnerName}</span></span><span className="shrink-0 border-l border-cyan-200/25 pl-2.5 text-xs font-black tabular-nums text-cyan-50">{selectedAdmin?.employee_count ?? dashboard.employees.length}<span className="ml-1 text-[10px] font-bold text-cyan-100/75">位員工</span></span><ChevronDown className={`h-4 w-4 shrink-0 text-white transition-transform ${adminGroupMenuOpen ? 'rotate-180' : ''}`} /></button>{adminGroupMenuOpen && <div role="menu" className="absolute right-0 top-[calc(100%+8px)] z-40 w-[260px] overflow-hidden rounded-2xl border border-cyan-300/25 bg-slate-950 p-2 shadow-[0_20px_42px_rgba(2,6,23,0.68)]"><p className="mb-1 rounded-lg border border-cyan-300/10 bg-cyan-400/[0.06] px-2.5 py-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-cyan-100/65">切換管理員分組</p>{[dashboard.admin_groups.find(group => group.id === admin.id) || admin, ...dashboard.admin_groups.filter(group => group.id !== admin.id)].map(group => <button key={group.id} type="button" role="menuitem" onClick={() => { setAdminGroupMenuOpen(false); selectAdminGroup(group.id); }} className={`flex h-10 w-full items-center justify-between gap-2 rounded-xl border px-2.5 text-left text-[11px] font-black transition-all ${group.id === dashboard.selected_owner_id ? 'border-cyan-300/55 bg-gradient-to-r from-cyan-500/30 to-sky-500/20 text-white shadow-[inset_3px_0_0_rgb(103_232_249),0_5px_14px_rgba(8,145,178,0.12)]' : 'border-transparent text-slate-300 hover:border-cyan-300/20 hover:bg-slate-800/90 hover:text-white'}`}><span className="flex min-w-0 items-center gap-2"><span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${group.id === dashboard.selected_owner_id ? 'bg-sky-400/15 text-sky-200' : 'bg-slate-800 text-slate-500'}`}><Users className="h-3 w-3" /></span><span className="truncate">{group.username}</span>{group.id === dashboard.selected_owner_id && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-cyan-200" />}</span><span className={`shrink-0 rounded-lg border px-1.5 py-1 text-[9px] font-black tabular-nums ${group.id === dashboard.selected_owner_id ? 'border-cyan-200/25 bg-cyan-200/10 text-cyan-100' : 'border-slate-600/80 bg-slate-950/70 text-slate-300'}`}>{('employee_count' in group ? group.employee_count : undefined) ?? (group.id === dashboard.selected_owner_id ? dashboard.employees.length : 0)} 位員工</span></button>)}</div>}</div> : <span className="inline-flex h-10 w-[260px] items-center justify-between gap-2 rounded-xl border border-cyan-300/35 bg-slate-950/45 px-3 text-sm font-black text-cyan-50 shadow-[0_8px_18px_rgba(14,116,144,0.18)]"><span className="flex min-w-0 items-center gap-2"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-white/25 bg-white/15 text-white"><Users className="h-3.5 w-3.5" /></span><span className="truncate">{admin.username}</span></span><span className="shrink-0 border-l border-cyan-200/25 pl-2.5 text-xs font-black tabular-nums text-cyan-50">{selectedAdmin?.employee_count ?? dashboard.employees.length}<span className="ml-1 text-[10px] font-bold text-cyan-100/75">位員工</span></span></span>}
              <button type="button" onClick={() => { setRefreshing(true); void loadDashboard(dashboard.selected_owner_id); }} disabled={refreshing} className={`inline-flex h-9 items-center gap-2 rounded-xl border border-blue-300/40 bg-gradient-to-r from-blue-600 to-cyan-600 px-3 text-xs font-black text-white shadow-[0_8px_18px_rgba(8,47,73,0.35)] transition-all hover:from-blue-500 hover:to-cyan-500 active:scale-[0.97] disabled:opacity-50 ${refreshing ? 'animate-pulse ring-2 ring-cyan-300/25' : ''}`}><RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />刷新</button>
            </div>
          </div>
        </header>
        <div className="shrink-0 border-b border-slate-700 bg-slate-900 px-3 py-2 lg:hidden">
          <div className="flex gap-2"><label className="relative min-w-0 flex-1"><span className="sr-only">選擇方案</span><select value={selectedPlanId} onChange={event => selectPlan(event.target.value)} className="h-10 w-full appearance-none rounded-xl border border-cyan-300/25 bg-slate-950 py-0 pl-3 pr-9 text-xs font-black text-white outline-none"><optgroup label="目前方案">{dashboard.plans.filter(plan => plan.status !== 'archived').map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {planStatusLabels[plan.status]}</option>)}</optgroup><option value={UNGROUPED_PLAN_ID}>未分組任務</option>{dashboard.plans.some(plan => plan.status === 'archived') && <optgroup label="封存歷史">{dashboard.plans.filter(plan => plan.status === 'archived').map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</optgroup>}</select><ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cyan-300" /></label><button type="button" onClick={() => openPlanModal()} className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-500/10 text-cyan-200" aria-label="新增方案"><Plus className="h-4 w-4" /></button></div>
        </div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[270px_minmax(0,1fr)]">
          <aside className="hidden min-h-0 flex-col border-r border-slate-700/90 bg-[linear-gradient(180deg,#0b1220_0%,#0b1220_48%,#111827_100%)] lg:flex">
            <div className="border-b border-cyan-300/10 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.1),transparent_55%)] px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-cyan-300/20 bg-cyan-500/10 text-cyan-200"><Sparkles className="h-3.5 w-3.5" /></span><p className="truncate text-xs font-black text-white">自動化方案</p></div>
                <button type="button" onClick={() => openPlanModal()} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-2 text-[10px] font-black text-white shadow-md shadow-cyan-950/30 transition-colors hover:from-cyan-400 hover:to-blue-500"><Plus className="h-3 w-3" />新增方案</button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-1.5 text-[9px] font-bold">
                <span className="flex h-6 items-center justify-between gap-1 rounded-md border border-emerald-300/15 bg-emerald-500/[0.08] px-2 text-emerald-100/75"><span className="truncate">執行中方案</span><strong className="shrink-0 text-[11px] font-black tabular-nums text-emerald-300">{dashboard.plans.filter(plan => plan.status === 'active').length}</strong></span>
                <span className="flex h-6 items-center justify-between gap-1 rounded-md border border-cyan-300/15 bg-cyan-500/[0.08] px-2 text-cyan-100/75"><span className="truncate">全部自動化任務</span><strong className="shrink-0 text-[11px] font-black tabular-nums text-cyan-200">{dashboard.tasks.length}</strong></span>
              </div>
              <div className="relative mt-2"><button type="button" onClick={() => setPlanStatusMenuOpen(previous => !previous)} aria-expanded={planStatusMenuOpen} aria-haspopup="menu" className={`flex h-8 w-full items-center justify-between rounded-lg border px-2.5 text-[10px] font-black transition-colors ${planStatusMenuOpen ? 'border-cyan-300/70 bg-cyan-500/15 text-cyan-100' : 'border-slate-700 bg-slate-950/70 text-slate-300 hover:border-cyan-300/40 hover:bg-slate-900'}`}><span className="inline-flex items-center gap-1.5"><SlidersHorizontal className="h-3.5 w-3.5 text-cyan-300" />{planStatusFilterLabels[planStatusFilter]}</span><ChevronDown className={`h-3.5 w-3.5 text-cyan-300 transition-transform ${planStatusMenuOpen ? 'rotate-180' : ''}`} /></button>{planStatusMenuOpen && <div role="menu" className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-xl border border-cyan-300/25 bg-slate-950 p-1.5 shadow-[0_16px_32px_rgba(2,6,23,0.55)]">{(['all', 'active', 'paused', 'archived'] as const).map(status => <button key={status} type="button" role="menuitem" onClick={() => { setPlanStatusFilter(status); setPlanStatusMenuOpen(false); }} className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[10px] font-black transition-colors ${planStatusFilter === status ? 'bg-cyan-500/15 text-cyan-100' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}><span>{planStatusFilterLabels[status]}</span>{planStatusFilter === status && <CheckCircle2 className="h-3.5 w-3.5 text-cyan-300" />}</button>)}</div>}</div>
            </div>
            <div className="dark-panel-scroll min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
              <p className="px-1 text-[9px] font-black uppercase tracking-[0.16em] text-slate-500">目前方案</p>
              {activePlans.length === 0 && planStatusFilter !== 'archived' && <p className="rounded-2xl border border-dashed border-slate-700 bg-slate-950/35 px-3 py-5 text-center text-xs text-slate-500">找不到符合條件的方案</p>}
              {activePlans.map(plan => renderPlanCard(plan))}
              {archivedPlans.length > 0 && <details className="rounded-xl border border-slate-700/70 bg-slate-950/35 p-2" open={planStatusFilter === 'archived'}><summary className="cursor-pointer select-none px-1 py-1 text-[11px] font-black tracking-wide text-blue-100/80">封存歷史 <span className="text-slate-600">·</span> {archivedPlans.length}</summary><div className="mt-2 space-y-1.5">{archivedPlans.map(plan => renderPlanCard(plan, true))}</div></details>}
            </div>
          </aside>
          <main className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-slate-900">
            {failures.length > 0 && <details className="shrink-0 border-b border-rose-400/30 bg-rose-950/40 px-3 py-2 text-xs text-rose-100">
              <summary className="flex cursor-pointer select-none items-center gap-2 font-black"><AlertCircle className="h-4 w-4 shrink-0 text-rose-300" /><span className="min-w-0 flex-1">有 {failures.length} 筆自動通知發送失敗，系統會自動重試</span><span className="shrink-0 text-[10px] font-semibold text-rose-200/70">點擊查看原因</span></summary>
              <div className="dark-panel-scroll mt-2 max-h-48 space-y-1.5 overflow-y-auto">
                {failures.map(failure => <div key={`${failure.task_id}:${failure.user_id}`} className="rounded-lg border border-rose-400/20 bg-slate-950/60 px-2.5 py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5"><span className="font-black text-white">{failure.employee_username}</span>{failure.employee_code && <span className="text-[10px] text-slate-400">{failure.employee_code}</span>}<span className="text-rose-100/80">任務：{failure.task_name}{failure.plan_name ? `（${failure.plan_name}）` : ''}</span><span className="text-rose-200/60">已重試 {failure.attempts} 次 · 最後 {formatDateTime(failure.last_failed_at)}</span></div>
                  <p className="mt-1 break-words font-mono text-[10px] text-rose-200/80">{failure.last_error}</p>
                </div>)}
              </div>
            </details>}
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-700 bg-slate-950/50 px-3 py-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <div className="flex rounded-xl border border-slate-700 bg-slate-950 p-1">{[{ id: 'tasks' as const, label: '任務', icon: Settings2 }, { id: 'executions' as const, label: '執行記錄', icon: History }].map(tab => <button key={tab.id} type="button" onClick={() => setView(tab.id)} className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-black ${view === tab.id ? 'bg-gradient-to-r from-cyan-600 to-blue-700 text-white' : 'text-slate-400 hover:bg-slate-800'}`}><tab.icon className="h-3.5 w-3.5" />{tab.label}</button>)}</div>
                {view === 'tasks' && <div className="flex flex-wrap items-center gap-1.5">
                  {selectedPlan && <><button type="button" onClick={openMemberPicker} disabled={selectedPlan.status === 'archived'} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-blue-300/30 bg-gradient-to-r from-blue-500/15 to-cyan-500/15 px-2.5 text-[11px] font-black text-cyan-100 hover:border-cyan-300/45 hover:from-blue-500/25 hover:to-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-40"><Users className="h-3.5 w-3.5" />管理方案員工</button><button type="button" onClick={() => openPlanModal(selectedPlan)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-cyan-300/25 bg-cyan-500/10 px-2.5 text-[11px] font-black text-cyan-200"><Edit3 className="h-3.5 w-3.5" />編輯</button>{selectedPlan.status === 'active' ? <button type="button" onClick={() => void changePlanStatus(selectedPlan, 'paused')} disabled={saving} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-300/25 bg-amber-500/10 px-2.5 text-[11px] font-black text-amber-200 disabled:opacity-50"><Pause className="h-3.5 w-3.5" />暫停</button> : <button type="button" onClick={() => void changePlanStatus(selectedPlan, 'active')} disabled={saving} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-emerald-300/25 bg-emerald-500/10 px-2.5 text-[11px] font-black text-emerald-200 disabled:opacity-50"><Play className="h-3.5 w-3.5" />{selectedPlan.status === 'archived' ? '恢復' : '繼續'}</button>}{selectedPlan.status !== 'archived' ? <button type="button" onClick={() => setPlanArchiveTarget(selectedPlan)} disabled={saving} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-300/35 bg-rose-500/15 px-2.5 text-[11px] font-black text-rose-100 transition-colors hover:border-rose-200/60 hover:bg-rose-500/25 disabled:opacity-50" title="封存方案"><Archive className="h-3.5 w-3.5" />封存方案</button> : <button type="button" onClick={() => setPlanDeleteTarget(selectedPlan)} disabled={saving} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-300/50 bg-rose-600 px-2.5 text-[11px] font-black text-white shadow-sm shadow-rose-950/35 transition-colors hover:bg-rose-500 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />刪除方案</button>}</>}
                  <button type="button" onClick={openNewTask} disabled={!selectedPlan || selectedPlan.status === 'archived'} title={!selectedPlan ? '請先選擇方案' : selectedPlan.status === 'archived' ? '請先恢復方案' : selectedPlan.status === 'paused' ? '建立草稿任務' : '新增任務'} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-3 text-[11px] font-black text-white disabled:cursor-not-allowed disabled:from-slate-700 disabled:to-slate-700 disabled:text-slate-500"><Plus className="h-3.5 w-3.5" />新增任務</button>
                </div>}
              </div>
              {view === 'tasks' ? <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2"><div className="relative"><button type="button" onClick={() => { setTaskStatusMenuOpen(previous => !previous); setTaskTriggerMenuOpen(false); }} aria-expanded={taskStatusMenuOpen} className={`inline-flex h-8 min-w-[112px] items-center justify-between gap-2 rounded-lg border px-2.5 text-[10px] font-black transition-colors ${taskStatusMenuOpen ? 'border-cyan-300/60 bg-cyan-500/15 text-cyan-100' : 'border-slate-600 bg-slate-900 text-slate-300 hover:border-cyan-300/40 hover:bg-slate-800'}`}><span>{taskStatusFilter === 'all' ? '全部狀態' : taskStatusLabels[taskStatusFilter]}</span><ChevronDown className={`h-3.5 w-3.5 text-cyan-300 transition-transform ${taskStatusMenuOpen ? 'rotate-180' : ''}`} /></button>{taskStatusMenuOpen && <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-30 w-40 overflow-hidden rounded-xl border border-cyan-300/25 bg-slate-950 p-1.5 shadow-[0_16px_32px_rgba(2,6,23,0.6)]">{(['all', 'draft', 'active', 'paused'] as const).map(status => <button key={status} type="button" role="menuitem" onClick={() => { setTaskStatusFilter(status); setTaskStatusMenuOpen(false); }} className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[10px] font-black transition-colors ${taskStatusFilter === status ? 'bg-cyan-500/15 text-cyan-100' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}><span>{status === 'all' ? '全部狀態' : taskStatusLabels[status]}</span>{taskStatusFilter === status && <CheckCircle2 className="h-3.5 w-3.5 text-cyan-300" />}</button>)}</div>}</div><div className="relative"><button type="button" onClick={() => { setTaskTriggerMenuOpen(previous => !previous); setTaskStatusMenuOpen(false); }} aria-expanded={taskTriggerMenuOpen} className={`inline-flex h-8 w-[180px] items-center justify-between gap-2 rounded-lg border px-2.5 text-[10px] font-black transition-colors ${taskTriggerMenuOpen ? 'border-blue-300/60 bg-blue-500/15 text-blue-100' : 'border-slate-600 bg-slate-900 text-slate-300 hover:border-blue-300/40 hover:bg-slate-800'}`}><span className="truncate">{taskTriggerFilter === 'all' ? '全部條件' : triggerLabels[taskTriggerFilter]}</span><ChevronDown className={`h-3.5 w-3.5 text-blue-300 transition-transform ${taskTriggerMenuOpen ? 'rotate-180' : ''}`} /></button>{taskTriggerMenuOpen && <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-30 w-48 overflow-hidden rounded-xl border border-blue-300/25 bg-slate-950 p-1.5 shadow-[0_16px_32px_rgba(2,6,23,0.6)]">{(['all', 'total_orders', 'daily_orders', 'work_days', 'commission_amount', 'consecutive_work_days', 'annual_date', 'first_login'] as const).map(trigger => <button key={trigger} type="button" role="menuitem" onClick={() => { setTaskTriggerFilter(trigger); setTaskTriggerMenuOpen(false); }} className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[10px] font-black transition-colors ${taskTriggerFilter === trigger ? 'bg-blue-500/15 text-blue-100' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}><span className="truncate">{trigger === 'all' ? '全部條件' : triggerLabels[trigger]}</span>{taskTriggerFilter === trigger && <CheckCircle2 className="h-3.5 w-3.5 text-blue-300" />}</button>)}</div>}</div></div> : <div className="flex min-w-0 flex-1 items-center justify-end gap-2"><label className="relative w-64 shrink-0"><Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cyan-300" /><input value={executionSearch} onChange={event => setExecutionSearch(event.target.value)} placeholder="搜尋曾接收通知的員工帳號或 ID" aria-label="搜尋自動化通知接收員工" className="h-10 w-full rounded-xl border border-cyan-300/25 bg-slate-900 pl-9 pr-3 text-xs font-semibold text-white outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-300 focus:ring-2 focus:ring-cyan-400/15" /></label><ExecutionScopeSelect value={executionScope} currentSelectionName={currentSelectionName} onChange={setExecutionScope} /></div>}
            </div>
            <div className="dark-panel-scroll min-h-0 flex-1 overflow-y-auto">
              {view === 'tasks' && (filteredTasks.length === 0 ? <div className="flex min-h-[320px] flex-col items-center justify-center px-6 py-12 text-center"><span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-500/10 text-cyan-300"><Bell className="h-6 w-6" /></span><p className="mt-3 text-sm font-black text-slate-200">{selectionTasks.length === 0 ? '此處尚無自動化任務' : '找不到符合篩選條件的任務'}</p><p className="mt-1 max-w-md text-xs leading-5 text-slate-500">{selectedPlan?.status === 'active' ? '新增任務後會先儲存為草稿，再由你確認啟用。' : selectedPlan?.status === 'paused' ? '可新增並編輯草稿任務；方案恢復前無法啟用或執行任務。' : isUngroupedSelected ? '請先選擇一個方案建立新任務。' : '恢復方案後即可新增或啟用任務。'}</p>{selectedPlan && selectedPlan.status !== 'archived' && <button type="button" onClick={openNewTask} className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 px-4 text-xs font-black text-white"><Plus className="h-4 w-4" />新增第一個任務</button>}</div> : <>
                <div className="hidden lg:block"><table className="w-full table-fixed text-left text-xs"><thead className="sticky top-0 z-10 bg-gradient-to-r from-blue-800 via-cyan-800 to-blue-900 text-white"><tr><th className="w-[24%] px-4 py-2 font-black">任務</th><th className="w-[30%] px-3 py-2 font-black">觸發條件</th><th className="w-[13%] px-3 py-2 font-black">適用範圍</th><th className="w-[7%] px-3 py-2 font-black">執行</th><th className="w-[10%] px-3 py-2 font-black">獎金</th><th className="w-[16%] px-4 py-2 text-right font-black">操作</th></tr></thead><tbody className="divide-y divide-slate-800">{filteredTasks.map(task => <tr key={task.id} className={`${task.status === 'active' ? 'bg-[linear-gradient(90deg,rgba(6,78,59,0.34),rgba(6,95,70,0.12),rgba(15,23,42,0.32))]' : task.status === 'paused' ? 'bg-[linear-gradient(90deg,rgba(120,53,15,0.30),rgba(146,64,14,0.10),rgba(15,23,42,0.32))]' : 'bg-[linear-gradient(90deg,rgba(51,65,85,0.42),rgba(15,23,42,0.30))]'} transition-[filter] hover:brightness-110`}><td className="px-4 py-2"><div className="flex min-w-0 items-start gap-2"><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${task.status === 'active' ? 'border-emerald-300/35 bg-emerald-500/15 text-emerald-200' : task.status === 'paused' ? 'border-amber-300/35 bg-amber-500/15 text-amber-200' : 'border-slate-600 bg-slate-800 text-slate-300'}`}>{task.reward_enabled ? <Gift className="h-4 w-4" /> : <Bell className="h-4 w-4" />}</span><div className="min-w-0 flex-1"><p className="truncate font-black leading-4 text-white" title={task.name}>{task.name}</p><div className="mt-1 flex min-w-0 items-center gap-1.5"><TaskStatusBadge status={task.status} /><NotificationDeliveryBadge mode={getTaskDeliveryMode(task)} /></div></div></div></td><td className="px-3 py-2"><p className="truncate text-xs font-black leading-4 text-cyan-100">{triggerLabels[task.trigger_type]}</p><p className="mt-0.5 line-clamp-2 text-[11px] font-semibold leading-4 text-blue-100/70">{summarizeTask(task, dashboard.currency)}</p></td><td className="px-3 py-2 text-[11px] font-bold text-slate-300">{task.plan_id ? `方案員工 · ${selectedPlan?.member_count || 0} 名` : task.recipient_scope === 'selected' ? `指定 ${task.recipient_ids?.length || 0} 名` : '所有員工'}</td><td className="px-3 py-2 font-black tabular-nums text-cyan-200">{task.execution_count || 0}</td><td className="px-3 py-2 text-[13px] font-black text-amber-200">{task.reward_enabled ? `${Number(task.reward_amount || 0).toFixed(2)} ${dashboard.currency}` : '無'}</td><td className="px-4 py-2">{renderTaskActions(task)}</td></tr>)}</tbody></table></div>
                <div className="space-y-3 p-3 lg:hidden">{filteredTasks.map(task => <article key={task.id} className={`rounded-xl border p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] ${task.status === 'active' ? 'border-emerald-300/30 bg-[linear-gradient(135deg,rgba(6,78,59,0.38),rgba(15,23,42,0.82))]' : task.status === 'paused' ? 'border-amber-300/30 bg-[linear-gradient(135deg,rgba(120,53,15,0.36),rgba(15,23,42,0.82))]' : 'border-slate-600/80 bg-[linear-gradient(135deg,rgba(51,65,85,0.46),rgba(15,23,42,0.82))]'}`}><div className="flex items-start gap-3"><span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${task.status === 'active' ? 'border-emerald-300/35 bg-emerald-500/15 text-emerald-200' : task.status === 'paused' ? 'border-amber-300/35 bg-amber-500/15 text-amber-200' : 'border-slate-600 bg-slate-800 text-slate-300'}`}>{task.reward_enabled ? <Gift className="h-4 w-4" /> : <Bell className="h-4 w-4" />}</span><div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-2"><h3 className="truncate text-sm font-black text-white">{task.name}</h3><TaskStatusBadge status={task.status} /></div><div className="mt-1.5 flex flex-wrap items-center gap-2"><span className="text-xs font-black text-cyan-100">{triggerLabels[task.trigger_type]}</span><NotificationDeliveryBadge mode={getTaskDeliveryMode(task)} /></div></div></div><p className="mt-3 text-[11px] font-semibold leading-5 text-blue-100/70">{summarizeTask(task, dashboard.currency)}</p><div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-slate-900 px-2 py-2"><p className="text-[9px] text-slate-500">適用</p><p className="mt-0.5 truncate text-[10px] font-bold text-slate-200">{task.plan_id ? `方案 ${selectedPlan?.member_count || 0} 名` : task.recipient_scope === 'selected' ? `指定 ${task.recipient_ids?.length || 0} 名` : '所有員工'}</p></div><div className="rounded-lg bg-slate-900 px-2 py-2"><p className="text-[9px] text-slate-500">執行</p><p className="mt-0.5 text-xs font-black text-cyan-200">{task.execution_count || 0}</p></div><div className="rounded-lg bg-slate-900 px-2 py-2"><p className="text-[9px] text-slate-500">獎金</p><p className="mt-0.5 truncate text-[10px] font-black text-amber-200">{task.reward_enabled ? `${Number(task.reward_amount || 0).toFixed(2)} ${dashboard.currency}` : '無'}</p></div></div><div className="mt-3 border-t border-slate-700 pt-3">{renderTaskActions(task)}</div></article>)}</div>
              </>)}
              {view === 'executions' && (!executionsInitialized && executionsLoading ? <div className="flex min-h-[320px] items-center justify-center"><RefreshCw className="h-6 w-6 animate-spin text-cyan-300" /></div> : filteredExecutions.length === 0 ? <div className="flex min-h-[320px] flex-col items-center justify-center px-6 py-12 text-center"><span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-blue-400/20 bg-blue-500/10 text-cyan-300"><History className="h-6 w-6" /></span><p className="mt-3 text-sm font-black text-slate-200">尚無執行記錄</p><p className="mt-1 text-xs text-slate-500">任務成功觸發後，執行資料會顯示在這裡</p></div> : <><div className="hidden md:block"><table className="w-full table-fixed text-left text-xs"><thead className={`sticky top-0 z-10 ${executionScope === 'all' ? 'bg-[linear-gradient(90deg,#422006_0%,#a16207_34%,#ea580c_68%,#431407_100%)] text-amber-50 shadow-[inset_0_-1px_0_rgba(253,230,138,0.28)]' : 'bg-gradient-to-r from-blue-800 via-cyan-800 to-blue-900 text-white'}`}><tr><th className={`${executionScope === 'all' ? 'w-[15%]' : 'w-[21%]'} px-4 py-2 font-black`}>任務</th><th className={`${executionScope === 'all' ? 'w-[18%]' : 'w-[23%]'} px-3 py-2 font-black`}>員工 / ID</th>{executionScope === 'all' && <th className="w-[12%] px-3 py-2 font-black text-amber-100">方案</th>}<th className="w-[8%] px-3 py-2 font-black">階段</th><th className="w-[7%] px-2 py-2 font-black">實際數值</th><th className="w-[13%] px-3 py-2 font-black">獎金</th><th className={`${executionScope === 'all' ? 'w-[6%]' : 'w-[7%]'} px-2 py-2 font-black`}>狀態</th><th className="w-[21%] px-4 py-2 text-right font-black">執行時間</th></tr></thead><tbody className="divide-y divide-slate-800">{filteredExecutions.map(execution => <tr key={execution.id} className="bg-slate-950/20 text-slate-300 hover:bg-slate-800/60"><td className="truncate px-4 py-3 font-semibold text-white">{execution.task_name}</td><td className="px-3 py-3" title={`${execution.employee_username} · ${execution.employee_id || '未設定員工 ID'}`}><div className="flex min-w-0 items-center"><span className="min-w-0 truncate font-semibold text-slate-100">{execution.employee_username}</span><span className="mx-1.5 shrink-0 text-slate-600">·</span><span className="shrink-0 font-mono text-[10px] font-bold text-cyan-200">{execution.employee_id || '—'}</span></div></td>{executionScope === 'all' && <td className="truncate px-3 py-3 text-slate-400">{execution.plan_id ? planById.get(execution.plan_id)?.name || '已移除方案' : '未分組任務'}</td>}<td className="px-3 py-3">第 {execution.stage} 階段</td><td className="px-2 py-3">{Number(execution.actual_value).toLocaleString()}</td><td className="whitespace-nowrap px-3 py-3 font-bold text-amber-300">{execution.reward_amount ? `${Number(execution.reward_amount).toFixed(2)} ${execution.reward_currency}` : '—'}</td><td className="px-2 py-3"><span className={`whitespace-nowrap rounded-md px-1.5 py-1 font-bold ${execution.status === 'succeeded' ? 'bg-emerald-500/10 text-emerald-300' : execution.status === 'failed' ? 'bg-red-500/10 text-red-300' : 'bg-blue-500/10 text-blue-300'}`}>{execution.status === 'succeeded' ? '成功' : execution.status === 'failed' ? '失敗' : '處理中'}</span></td><td className="whitespace-nowrap px-4 py-3 text-right text-[10px] font-semibold text-cyan-200/90">{formatDateTime(execution.executed_at)}</td></tr>)}</tbody></table></div><div className="space-y-3 p-3 md:hidden">{filteredExecutions.map(execution => <article key={execution.id} className="rounded-xl border border-slate-700 bg-slate-950/45 p-3"><div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="truncate text-sm font-black text-white">{execution.task_name}</h3><p className="mt-1 truncate text-xs text-slate-300">{execution.employee_username}<span className="mx-1.5 text-slate-600">·</span><span className="font-mono text-[10px] font-bold text-cyan-200">{execution.employee_id || '—'}</span></p>{executionScope === 'all' && <p className="mt-1 truncate text-[10px] font-bold text-amber-300">{execution.plan_id ? planById.get(execution.plan_id)?.name || '已移除方案' : '未分組任務'}</p>}</div><span className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-bold ${execution.status === 'succeeded' ? 'bg-emerald-500/10 text-emerald-300' : execution.status === 'failed' ? 'bg-red-500/10 text-red-300' : 'bg-blue-500/10 text-blue-300'}`}>{execution.status === 'succeeded' ? '成功' : execution.status === 'failed' ? '失敗' : '處理中'}</span></div><div className="mt-3 grid grid-cols-3 gap-2 text-center"><div className="rounded-lg bg-slate-900 p-2"><p className="text-[9px] text-slate-500">階段</p><p className="mt-0.5 text-xs font-bold text-slate-200">{execution.stage}</p></div><div className="rounded-lg bg-slate-900 p-2"><p className="text-[9px] text-slate-500">實際數值</p><p className="mt-0.5 text-xs font-bold text-cyan-200">{Number(execution.actual_value).toLocaleString()}</p></div><div className="rounded-lg bg-slate-900 p-2"><p className="text-[9px] text-slate-500">獎金</p><p className="mt-0.5 truncate text-[10px] font-bold text-amber-200">{execution.reward_amount ? `${Number(execution.reward_amount).toFixed(2)} ${execution.reward_currency}` : '—'}</p></div></div><p className="mt-3 text-right text-[10px] font-semibold text-cyan-200/90">{formatDateTime(execution.executed_at)}</p></article>)}</div></>)}
            </div>
          </main>
        </div>
      </div>
    </>
  );
}
