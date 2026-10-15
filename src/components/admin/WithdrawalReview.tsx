import { useState, useEffect, useRef } from 'react';
import { CheckCircle, XCircle, Clock, Ban, AlertCircle, ArrowUpDown, Pencil, Save, X, Search, Users, Layers, ChevronDown, Check, CalendarDays } from 'lucide-react';
import { formatSupabaseError, supabase, supabaseConfigurationError } from '../../lib/supabase';
import { Withdrawal, Employee, Admin } from '../../types';
import { createFinancialOperationId, getAdminFinancialSessionToken } from '../../lib/auth';
import AdminPageLoading from './AdminPageLoading';

type WithdrawalEmployee = Pick<Employee, 'id' | 'username' | 'employee_id' | 'created_by'>;
type WithdrawalAdmin = Pick<Admin, 'id' | 'username' | 'role'> & { admin_id?: string };

interface WithdrawalWithEmployee extends Withdrawal {
  employee?: WithdrawalEmployee;
}

interface WithdrawalRow extends WithdrawalWithEmployee {
  admin: WithdrawalAdmin | null;
}

interface WithdrawalReviewProps {
  admin: Admin;
}

interface AdminGroup {
  admin: WithdrawalAdmin | null;
  withdrawals: WithdrawalWithEmployee[];
}

interface WithdrawalReviewData {
  admin_id: string;
  admin_role: Admin['role'];
  withdrawals: Withdrawal[];
  employees: WithdrawalEmployee[];
  admins: WithdrawalAdmin[];
}

const FINANCIAL_CORRECTION_REMARK = 'Withdrawal accounting adjustment, please resubmit your application';
const formatFinancialCorrectionRemark = (remark: string | null) =>
  remark === 'Financial system correction' ? FINANCIAL_CORRECTION_REMARK : remark;

type FilterStatus = 'all' | 'today' | 'pending' | 'approved' | 'rejected' | 'cancelled' | 'processed';
type SortOption = 'submit_time_desc' | 'submit_time_asc' | 'audit_time_desc' | 'audit_time_asc';

const withdrawalTableHeaderThemes: Record<FilterStatus, string> = {
  all: 'border-cyan-300/25 bg-[linear-gradient(90deg,rgba(8,47,73,0.98),rgba(15,23,42,0.98)_55%,rgba(8,47,73,0.92))] text-cyan-100',
  today: 'border-amber-300/30 bg-[linear-gradient(90deg,rgba(120,53,15,0.96),rgba(30,41,59,0.98)_55%,rgba(120,53,15,0.88))] text-amber-100',
  pending: 'border-orange-300/30 bg-[linear-gradient(90deg,rgba(124,45,18,0.96),rgba(30,41,59,0.98)_55%,rgba(124,45,18,0.88))] text-orange-100',
  approved: 'border-emerald-300/30 bg-[linear-gradient(90deg,rgba(6,78,59,0.96),rgba(30,41,59,0.98)_55%,rgba(6,78,59,0.88))] text-emerald-100',
  rejected: 'border-rose-300/30 bg-[linear-gradient(90deg,rgba(136,19,55,0.94),rgba(30,41,59,0.98)_55%,rgba(136,19,55,0.86))] text-rose-100',
  cancelled: 'border-slate-400/30 bg-[linear-gradient(90deg,rgba(51,65,85,0.98),rgba(15,23,42,0.98)_55%,rgba(51,65,85,0.92))] text-slate-100',
  processed: 'border-sky-300/30 bg-[linear-gradient(90deg,rgba(7,89,133,0.96),rgba(30,41,59,0.98)_55%,rgba(7,89,133,0.88))] text-sky-100',
};

const sortOptions: Array<{ key: SortOption; label: string; description: string }> = [
  { key: 'submit_time_desc', label: '最新提交', description: '按提交時間從新到舊' },
  { key: 'submit_time_asc', label: '最早提交', description: '按提交時間從舊到新' },
  { key: 'audit_time_desc', label: '最新審核', description: '按審核時間從新到舊' },
  { key: 'audit_time_asc', label: '最早審核', description: '按審核時間從舊到新' },
];

type WithdrawalStatusTheme = {
  editButton: string;
  panel: string;
  header: string;
  topLine: string;
  iconShell: string;
  icon: string;
  eyebrow: string;
  subtext: string;
  divider: string;
  amount: string;
  label: string;
  textarea: string;
  notice: string;
  noticeIcon: string;
  footer: string;
  saveButton: string;
};

const withdrawalStatusThemes: Record<Withdrawal['status'], WithdrawalStatusTheme> = {
  pending: {
    editButton: 'border-orange-300/40 bg-orange-500/10 text-orange-200 hover:border-orange-300/70 hover:bg-orange-500/20 hover:text-white',
    panel: 'border-orange-400/35 bg-gradient-to-b from-slate-900 via-orange-950/20 to-slate-950 shadow-orange-950/45',
    header: 'border-orange-300/20 bg-gradient-to-r from-orange-950/75 via-slate-900 to-slate-900',
    topLine: 'from-orange-500 via-amber-300 to-orange-500',
    iconShell: 'border-orange-300/35 bg-orange-400/15 text-orange-100',
    icon: 'text-orange-300',
    eyebrow: 'text-orange-300',
    subtext: 'text-orange-100/65',
    divider: 'border-orange-300/15',
    amount: 'text-orange-200',
    label: 'text-orange-100',
    textarea: 'border-orange-300/40 focus:border-orange-500 focus:ring-orange-500/20',
    notice: 'border-orange-400/20 bg-orange-500/10 text-orange-100/80',
    noticeIcon: 'text-orange-300',
    footer: 'border-orange-300/15',
    saveButton: 'border-orange-300/35 bg-orange-600 shadow-orange-950/30 hover:bg-orange-500',
  },
  approved: {
    editButton: 'border-emerald-300/40 bg-emerald-500/10 text-emerald-200 hover:border-emerald-300/70 hover:bg-emerald-500/20 hover:text-white',
    panel: 'border-emerald-400/35 bg-gradient-to-b from-slate-900 via-emerald-950/20 to-slate-950 shadow-emerald-950/45',
    header: 'border-emerald-300/20 bg-gradient-to-r from-emerald-950/75 via-slate-900 to-slate-900',
    topLine: 'from-emerald-500 via-green-300 to-emerald-500',
    iconShell: 'border-emerald-300/35 bg-emerald-400/15 text-emerald-100',
    icon: 'text-emerald-300',
    eyebrow: 'text-emerald-300',
    subtext: 'text-emerald-100/65',
    divider: 'border-emerald-300/15',
    amount: 'text-emerald-200',
    label: 'text-emerald-100',
    textarea: 'border-emerald-300/40 focus:border-emerald-500 focus:ring-emerald-500/20',
    notice: 'border-emerald-400/20 bg-emerald-500/10 text-emerald-100/80',
    noticeIcon: 'text-emerald-300',
    footer: 'border-emerald-300/15',
    saveButton: 'border-emerald-300/35 bg-emerald-600 shadow-emerald-950/30 hover:bg-emerald-500',
  },
  rejected: {
    editButton: 'border-red-300/40 bg-red-500/10 text-red-200 hover:border-red-300/70 hover:bg-red-500/20 hover:text-white',
    panel: 'border-red-400/35 bg-gradient-to-b from-slate-900 via-red-950/20 to-slate-950 shadow-red-950/45',
    header: 'border-red-300/20 bg-gradient-to-r from-red-950/75 via-slate-900 to-slate-900',
    topLine: 'from-red-500 via-rose-300 to-red-500',
    iconShell: 'border-red-300/35 bg-red-400/15 text-red-100',
    icon: 'text-red-300',
    eyebrow: 'text-red-300',
    subtext: 'text-red-100/65',
    divider: 'border-red-300/15',
    amount: 'text-red-200',
    label: 'text-red-100',
    textarea: 'border-red-300/40 focus:border-red-500 focus:ring-red-500/20',
    notice: 'border-red-400/20 bg-red-500/10 text-red-100/80',
    noticeIcon: 'text-red-300',
    footer: 'border-red-300/15',
    saveButton: 'border-red-300/35 bg-red-600 shadow-red-950/30 hover:bg-red-500',
  },
  cancelled: {
    editButton: 'border-slate-500/70 bg-slate-700/40 text-slate-300 hover:border-slate-400 hover:bg-slate-700/70 hover:text-white',
    panel: 'border-slate-500/55 bg-gradient-to-b from-slate-900 via-slate-800/80 to-slate-950 shadow-slate-950/55',
    header: 'border-slate-500/25 bg-gradient-to-r from-slate-800 via-slate-900 to-slate-950',
    topLine: 'from-slate-500 via-slate-300 to-slate-600',
    iconShell: 'border-slate-500/55 bg-slate-700/45 text-slate-200',
    icon: 'text-slate-300',
    eyebrow: 'text-slate-300',
    subtext: 'text-slate-300/65',
    divider: 'border-slate-500/25',
    amount: 'text-slate-300',
    label: 'text-slate-200',
    textarea: 'border-slate-400/45 focus:border-slate-400 focus:ring-slate-400/20',
    notice: 'border-slate-500/30 bg-slate-700/35 text-slate-300',
    noticeIcon: 'text-slate-300',
    footer: 'border-slate-500/25',
    saveButton: 'border-slate-400/50 bg-slate-600 shadow-slate-950/40 hover:bg-slate-500',
  },
  processed: {
    editButton: 'border-cyan-300/40 bg-cyan-500/10 text-cyan-200 hover:border-cyan-300/70 hover:bg-cyan-500/20 hover:text-white',
    panel: 'border-cyan-400/35 bg-gradient-to-b from-slate-900 via-cyan-950/20 to-slate-950 shadow-cyan-950/45',
    header: 'border-cyan-300/20 bg-gradient-to-r from-cyan-950/75 via-slate-900 to-slate-900',
    topLine: 'from-cyan-500 via-sky-300 to-cyan-500',
    iconShell: 'border-cyan-300/35 bg-cyan-400/15 text-cyan-100',
    icon: 'text-cyan-300',
    eyebrow: 'text-cyan-300',
    subtext: 'text-cyan-100/65',
    divider: 'border-cyan-300/15',
    amount: 'text-cyan-200',
    label: 'text-cyan-100',
    textarea: 'border-cyan-300/40 focus:border-cyan-500 focus:ring-cyan-500/20',
    notice: 'border-cyan-400/20 bg-cyan-500/10 text-cyan-100/80',
    noticeIcon: 'text-cyan-300',
    footer: 'border-cyan-300/15',
    saveButton: 'border-cyan-300/35 bg-cyan-600 shadow-cyan-950/30 hover:bg-cyan-500',
  },
};

const getWithdrawalDateKey = (value: string) => {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export default function WithdrawalReview({ admin }: WithdrawalReviewProps) {
  const [adminGroups, setAdminGroups] = useState<AdminGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [auditRemark, setAuditRemark] = useState('');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all');
  const [adminFilter, setAdminFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedDate, setSelectedDate] = useState<string>('all');
  const [sortOption, setSortOption] = useState<SortOption>('submit_time_desc');
  const [error, setError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editingStatusTheme, setEditingStatusTheme] = useState<Withdrawal['status'] | null>(null);
  const [editStatus, setEditStatus] = useState<'approved' | 'rejected'>('approved');
  const [editRemark, setEditRemark] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'approved' | 'rejected' | null>(null);
  const [bulkRemark, setBulkRemark] = useState('');
  const [bulkValidationError, setBulkValidationError] = useState<string | null>(null);
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const loadWithdrawalsRef = useRef<(() => Promise<void>) | null>(null);
  const scopedEmployeeIdsRef = useRef<Set<string> | null>(admin.role === 'secondary_admin' ? new Set() : null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const dateMenuRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const financialOperationIdsRef = useRef(new Map<string, string>());
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    confirmText: string;
    confirmColor: 'green' | 'red';
  } | null>(null);

  useEffect(() => {
    if (!groupMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(event.target as Node)) {
        setGroupMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [groupMenuOpen]);

  useEffect(() => {
    if (!sortMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
        setSortMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [sortMenuOpen]);

  useEffect(() => {
    if (!dateMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (dateMenuRef.current && !dateMenuRef.current.contains(event.target as Node)) {
        setDateMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dateMenuOpen]);

  useEffect(() => {
    if (supabaseConfigurationError) {
      setError(supabaseConfigurationError);
      setLoading(false);
      return;
    }

    void loadWithdrawalsRef.current?.();

    // Set up real-time subscription for withdrawal requests
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const employeeScopeChannel = admin.role === 'secondary_admin'
      ? supabase
          .channel(`withdrawal-employee-scope-${admin.id}`)
          .on(
            'postgres_changes',
            { event: 'INSERT', schema: 'public', table: 'users', filter: `created_by=eq.${admin.id}` },
            () => { void loadWithdrawalsRef.current?.(); }
          )
          .on(
            'postgres_changes',
            { event: 'UPDATE', schema: 'public', table: 'users', filter: `created_by=eq.${admin.id}` },
            () => { void loadWithdrawalsRef.current?.(); }
          )
          .subscribe()
      : null;

    const withdrawalChannel = supabase
      .channel('withdrawal-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'withdrawal_events',
          ...(admin.role === 'secondary_admin' ? { filter: `admin_id=eq.${admin.id}` } : {}),
        },
        () => {
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => { void loadWithdrawalsRef.current?.(); }, 800);
        }
      )
      .subscribe();

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (employeeScopeChannel) supabase.removeChannel(employeeScopeChannel);
      supabase.removeChannel(withdrawalChannel);
    };
  }, [admin.id, admin.role]);

  const loadWithdrawals = async () => {
    try {
      if (supabaseConfigurationError) {
        setError(supabaseConfigurationError);
        return;
      }

      const { data, error: reviewDataError } = await supabase.rpc('get_withdrawal_review_data', {
        p_admin_session_token: getAdminFinancialSessionToken(),
      });
      if (reviewDataError) throw reviewDataError;

      const reviewData = data as unknown as WithdrawalReviewData;
      const withdrawalsData = Array.isArray(reviewData?.withdrawals) ? reviewData.withdrawals : [];
      const employees = Array.isArray(reviewData?.employees) ? reviewData.employees : [];
      const admins = Array.isArray(reviewData?.admins) ? reviewData.admins : [];
      scopedEmployeeIdsRef.current = reviewData?.admin_role === 'secondary_admin'
        ? new Set(employees.map(employee => employee.id))
        : null;

      const employeeMap = new Map(employees.map((employee) => [employee.id, employee]));
      const adminMap = new Map(admins.map((adminRow) => [adminRow.id, adminRow]));

      const withdrawalsWithEmployees = withdrawalsData.map((withdrawal) => ({
        ...withdrawal,
        employee: employeeMap.get(withdrawal.user_id),
      }));

      const groupedByAdmin = new Map<string, WithdrawalWithEmployee[]>();

      withdrawalsWithEmployees.forEach((withdrawal) => {
        const createdBy = withdrawal.employee?.created_by || 'unassigned';
        if (!groupedByAdmin.has(createdBy)) {
          groupedByAdmin.set(createdBy, []);
        }
        groupedByAdmin.get(createdBy)!.push(withdrawal);
      });

      // Include every admin as a selectable group, even those with no withdrawal records yet
      // (emergency admin accounts don't manage employees, so they're excluded)
      if (admin.role === 'super_admin') {
        admins.forEach((a) => {
          if (a.role === 'emergency_admin') return;
          if (!groupedByAdmin.has(a.id)) {
            groupedByAdmin.set(a.id, []);
          }
        });
      }

      const groups: AdminGroup[] = Array.from(groupedByAdmin.entries())
        .map(([adminId, withdrawals]) => ({
          admin: adminId === 'unassigned' ? null : adminMap.get(adminId) || null,
          withdrawals: withdrawals.sort((a, b) => {
            if (a.status === 'pending' && b.status !== 'pending') return -1;
            if (a.status !== 'pending' && b.status === 'pending') return 1;
            return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
          }),
        }))
        .sort((a, b) => {
          if (!a.admin && !b.admin) return 0;
          if (!a.admin) return 1;
          if (!b.admin) return -1;
          if (a.admin.role === 'super_admin' && b.admin.role !== 'super_admin') return -1;
          if (b.admin.role === 'super_admin' && a.admin.role !== 'super_admin') return 1;
          return (a.admin.username || '').localeCompare(b.admin.username || '');
        });

      setAdminGroups(groups);
    } catch (error) {
      console.error('Error loading withdrawals:', error);
      setError(formatSupabaseError(error));
    } finally {
      setLoading(false);
    }
  };
  loadWithdrawalsRef.current = loadWithdrawals;

  const processWithdrawalDecision = async (
    withdrawal: WithdrawalWithEmployee,
    status: 'approved' | 'rejected',
    remark: string,
  ) => {
    const operationKey = `review:${withdrawal.id}:${status}:${remark.trim()}`;
    const operationId = financialOperationIdsRef.current.get(operationKey)
      || createFinancialOperationId();
    financialOperationIdsRef.current.set(operationKey, operationId);

    const { data: result, error } = await supabase.rpc('review_withdrawal_atomic', {
      p_admin_session_token: getAdminFinancialSessionToken(),
      p_withdrawal_id: withdrawal.id,
      p_status: status,
      p_remark: remark.trim(),
      p_operation_id: operationId,
    });

    if (error) throw error;
    if (!result?.success) throw new Error(result?.error || '審核提現失敗');
    financialOperationIdsRef.current.delete(operationKey);
  };

  const handleReview = async (withdrawalId: string, status: 'approved' | 'rejected') => {
    if (!auditRemark.trim()) {
      setValidationError('請輸入審核備註');
      return;
    }

    setConfirmDialog({
      isOpen: true,
      title: status === 'approved' ? '批准提現' : '拒絕提現',
      message: status === 'approved'
        ? `確定要批准這筆提現嗎？金額將從凍結餘額中扣除。`
        : `確定要拒絕這筆提現嗎？金額將退回員工的可用餘額。`,
      confirmText: status === 'approved' ? '批准' : '拒絕',
      confirmColor: status === 'approved' ? 'green' : 'red',
      onConfirm: async () => {
        setConfirmDialog(null);
        setValidationError(null);

        setReviewSaving(true);
        try {
          const withdrawal = allRows.find((w) => w.id === withdrawalId);
          if (!withdrawal) return;

          await processWithdrawalDecision(withdrawal, status, auditRemark);

          setReviewing(null);
          setAuditRemark('');
          void loadWithdrawalsRef.current?.();
        } catch (error) {
          console.error('Error reviewing withdrawal:', error);
          setError('審核提現失敗');
        } finally {
          setReviewSaving(false);
        }
      }
    });
  };

  const cancelReviewing = () => {
    if (reviewSaving) return;
    setReviewing(null);
    setAuditRemark('');
    setValidationError(null);
  };

  const startEditing = (withdrawal: WithdrawalWithEmployee) => {
    setEditing(withdrawal.id);
    setEditingStatusTheme(withdrawal.status);
    setEditStatus(withdrawal.status === 'rejected' ? 'rejected' : 'approved');
    setEditRemark(formatFinancialCorrectionRemark(withdrawal.audit_remark) || '');
  };

  const cancelEditing = () => {
    if (editSaving) return;
    setEditing(null);
    setEditingStatusTheme(null);
    setEditRemark('');
  };

  const handleEditSave = async (withdrawal: WithdrawalWithEmployee) => {
    setConfirmDialog({
      isOpen: true,
      title: '修改提現記錄',
      message: `確定要將這筆提現修改為「${editStatus === 'approved' ? '已批准' : '已拒絕'}」嗎？系統會同步修正員工錢包；如有待審核提現，將自動取消並標記為 ${FINANCIAL_CORRECTION_REMARK}。`,
      confirmText: '儲存變更',
      confirmColor: editStatus === 'approved' ? 'green' : 'red',
      onConfirm: async () => {
        setConfirmDialog(null);
        setEditSaving(true);

        const operationKey = `correct:${withdrawal.id}:${editStatus}:${editRemark.trim()}`;
        const operationId = financialOperationIdsRef.current.get(operationKey)
          || createFinancialOperationId();
        financialOperationIdsRef.current.set(operationKey, operationId);

        try {
          const { data: result, error } = await supabase.rpc(
            'correct_withdrawal_status_atomic',
            {
              p_admin_session_token: getAdminFinancialSessionToken(),
              p_withdrawal_id: withdrawal.id,
              p_status: editStatus,
              p_remark: editRemark.trim(),
              p_operation_id: operationId,
            },
          );

          if (error) throw error;
          if (!result?.success) {
            throw new Error(result?.error || 'Unable to correct the withdrawal.');
          }

          financialOperationIdsRef.current.delete(operationKey);
          setEditing(null);
          setEditingStatusTheme(null);
          setEditRemark('');
          void loadWithdrawalsRef.current?.();
        } catch (err) {
          console.error('Error updating withdrawal:', err);
          setError(`更新提現記錄失敗：${formatSupabaseError(err)}`);
        } finally {
          setEditSaving(false);
        }
      }
    });
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      pending: 'bg-yellow-500/10 border-yellow-500/50 text-yellow-400',
      approved: 'bg-green-500/10 border-green-500/50 text-green-400',
      rejected: 'bg-red-500/10 border-red-500/50 text-red-400',
      cancelled: 'bg-slate-800/70 border-slate-600/70 text-slate-500',
      processed: 'bg-cyan-500/10 border-cyan-500/50 text-cyan-400',
    };

    const icons = {
      pending: <Clock className="w-3.5 h-3.5" />,
      approved: <CheckCircle className="w-3.5 h-3.5" />,
      rejected: <XCircle className="w-3.5 h-3.5" />,
      cancelled: <Ban className="w-3.5 h-3.5" />,
      processed: <CheckCircle className="w-3.5 h-3.5" />,
    };

    const labels = {
      pending: '待審核',
      approved: '已批准',
      rejected: '已拒絕',
      cancelled: '已取消',
      processed: '已處理',
    };

    return (
      <div className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold ${styles[status as keyof typeof styles]}`}>
        {icons[status as keyof typeof icons]}
        {labels[status as keyof typeof labels] || '未知狀態'}
      </div>
    );
  };

  const getGroupStats = (withdrawals: WithdrawalWithEmployee[]) => {
    const pending = withdrawals.filter((w) => w.status === 'pending').length;
    const approved = withdrawals.filter((w) => w.status === 'approved').length;
    const rejected = withdrawals.filter((w) => w.status === 'rejected').length;
    const cancelled = withdrawals.filter((w) => w.status === 'cancelled').length;
    const processed = approved + rejected + cancelled;
    const totalAmount = withdrawals.reduce((sum, w) => sum + w.amount, 0);

    return { pending, approved, rejected, cancelled, processed, total: withdrawals.length, totalAmount };
  };

  const getOverallStats = () => {
    const allWithdrawals = adminGroups.flatMap(g => g.withdrawals);
    return getGroupStats(allWithdrawals);
  };

  const sortWithdrawals = <T extends WithdrawalWithEmployee,>(withdrawals: T[]): T[] => {
    const sorted = [...withdrawals];

    switch (sortOption) {
      case 'submit_time_desc':
        return sorted.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      case 'submit_time_asc':
        return sorted.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      case 'audit_time_desc':
        return sorted.sort((a, b) => {
          if (!a.audited_at && !b.audited_at) return 0;
          if (!a.audited_at) return 1;
          if (!b.audited_at) return -1;
          return new Date(b.audited_at).getTime() - new Date(a.audited_at).getTime();
        });
      case 'audit_time_asc':
        return sorted.sort((a, b) => {
          if (!a.audited_at && !b.audited_at) return 0;
          if (!a.audited_at) return 1;
          if (!b.audited_at) return -1;
          return new Date(a.audited_at).getTime() - new Date(b.audited_at).getTime();
        });
      default:
        return sorted;
    }
  };

  const overallStats = getOverallStats();

  const allRows: WithdrawalRow[] = adminGroups.flatMap((group) =>
    group.withdrawals.map((w) => ({ ...w, admin: group.admin }))
  );

  const todayKey = new Date().toDateString();
  const scopedRows = adminFilter === 'all'
    ? allRows
    : allRows.filter((w) => (w.admin?.id || 'unassigned') === adminFilter);
  const scopedStats = getGroupStats(scopedRows);
  const todayCount = scopedRows.filter((w) => new Date(w.created_at).toDateString() === todayKey).length;

  const adminFilterOptions = adminGroups.map((group) => ({
    key: group.admin?.id || 'unassigned',
    label: group.admin
      ? group.admin.admin_id
        ? `${group.admin.username} (${group.admin.admin_id})`
        : group.admin.username
      : '未分配',
    count: group.withdrawals.length,
  }));

  const searchLower = searchQuery.trim().toLowerCase();

  const dateEligibleRows = allRows.filter((w) => {
    const ownerKey = w.admin?.id || 'unassigned';
    if (adminFilter !== 'all' && ownerKey !== adminFilter) return false;
    if (filterStatus === 'today' && new Date(w.created_at).toDateString() !== todayKey) return false;
    if (filterStatus === 'pending' && w.status !== 'pending') return false;
    if (filterStatus === 'approved' && w.status !== 'approved') return false;
    if (filterStatus === 'rejected' && w.status !== 'rejected') return false;
    if (filterStatus === 'cancelled' && w.status !== 'cancelled') return false;
    if (filterStatus === 'processed' && w.status === 'pending') return false;
    if (searchLower) {
      const username = (w.employee?.username || '').toLowerCase();
      const empId = (w.employee?.employee_id || '').toLowerCase();
      if (!username.includes(searchLower) && !empId.includes(searchLower)) return false;
    }
    return true;
  });

  const dateOptions = Array.from(
    dateEligibleRows.reduce((dates, withdrawal) => {
      const key = getWithdrawalDateKey(withdrawal.created_at);
      const existing = dates.get(key);
      dates.set(key, {
        key,
        count: (existing?.count || 0) + 1,
      });
      return dates;
    }, new Map<string, { key: string; count: number }>()).values()
  ).sort((a, b) => b.key.localeCompare(a.key));

  const selectedDateAvailable = selectedDate === 'all'
    || dateOptions.some((option) => option.key === selectedDate);

  useEffect(() => {
    if (!selectedDateAvailable) setSelectedDate('all');
  }, [selectedDateAvailable]);

  const filteredRows = sortWithdrawals(
    selectedDate === 'all'
      ? dateEligibleRows
      : dateEligibleRows.filter((w) => getWithdrawalDateKey(w.created_at) === selectedDate)
  );

  const showAdminColumn = admin.role === 'super_admin' && adminFilter === 'all';
  const reviewingWithdrawal = reviewing ? allRows.find((w) => w.id === reviewing) || null : null;
  const editingWithdrawal = editing ? allRows.find((w) => w.id === editing) || null : null;
  const pendingInView = filteredRows.filter((w) => w.status === 'pending');
  const allPendingSelected = pendingInView.length > 0 && pendingInView.every((w) => selectedIds.has(w.id));

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = !allPendingSelected && pendingInView.some((w) => selectedIds.has(w.id));
    }
  });

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allPendingSelected) {
        pendingInView.forEach((w) => next.delete(w.id));
      } else {
        pendingInView.forEach((w) => next.add(w.id));
      }
      return next;
    });
  };

  const openBulkAction = (status: 'approved' | 'rejected') => {
    if (selectedIds.size === 0) return;
    setBulkAction(status);
    setBulkRemark('');
    setBulkValidationError(null);
  };

  const closeBulkAction = () => {
    if (bulkProcessing) return;
    setBulkAction(null);
    setBulkRemark('');
    setBulkValidationError(null);
  };

  const confirmBulkAction = async () => {
    if (!bulkAction) return;
    if (!bulkRemark.trim()) {
      setBulkValidationError('請輸入審核備註');
      return;
    }

    setBulkProcessing(true);
    try {
      const targets = allRows.filter((w) => selectedIds.has(w.id) && w.status === 'pending');
      for (const withdrawal of targets) {
        await processWithdrawalDecision(withdrawal, bulkAction, bulkRemark.trim());
      }
      setSelectedIds(new Set());
      setBulkAction(null);
      setBulkRemark('');
      void loadWithdrawalsRef.current?.();
    } catch (err) {
      console.error('Error processing bulk action:', err);
      setError('批量處理失敗');
    } finally {
      setBulkProcessing(false);
    }
  };

  if (loading) {
    return <AdminPageLoading label="提款" />;
  }

  const editingTheme = withdrawalStatusThemes[editingStatusTheme || editingWithdrawal?.status || 'approved'];

  return (
    <>
      {/* Confirmation Dialog */}
      {confirmDialog?.isOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-md w-full p-6 animate-in fade-in zoom-in duration-200">
            <div className="flex items-start gap-4 mb-4">
              <div className={`p-3 rounded-full ${
                confirmDialog.confirmColor === 'green'
                  ? 'bg-green-500/10 border border-green-500/50'
                  : 'bg-red-500/10 border border-red-500/50'
              }`}>
                <AlertCircle className={`w-6 h-6 ${
                  confirmDialog.confirmColor === 'green' ? 'text-green-400' : 'text-red-400'
                }`} />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-white mb-2">{confirmDialog.title}</h3>
                <p className="text-slate-300 text-sm">{confirmDialog.message}</p>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setConfirmDialog(null)}
                className="flex-1 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-medium transition-all"
              >
                取消
              </button>
              <button
                onClick={confirmDialog.onConfirm}
                className={`flex-1 px-4 py-2.5 text-white rounded-lg font-medium transition-all ${
                  confirmDialog.confirmColor === 'green'
                    ? 'bg-green-600 hover:bg-green-700'
                    : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {confirmDialog.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Action Remark Modal */}
      {bulkAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <div className={`rounded-full p-2.5 ${bulkAction === 'approved' ? 'border border-green-500/40 bg-green-500/10' : 'border border-red-500/40 bg-red-500/10'}`}>
                {bulkAction === 'approved' ? <CheckCircle className="h-5 w-5 text-green-400" /> : <XCircle className="h-5 w-5 text-red-400" />}
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-bold text-white">
                  {bulkAction === 'approved' ? '批准' : '拒絕'} {selectedIds.size} 筆提現
                </h3>
                <p className="mt-0.5 text-xs text-slate-400">這則備註將套用至所有選取的申請。</p>
              </div>
            </div>
            <textarea
              value={bulkRemark}
              onChange={(e) => {
                setBulkRemark(e.target.value);
                if (bulkValidationError) setBulkValidationError(null);
              }}
              rows={3}
              placeholder="請輸入審核備註（必填）"
              className={`w-full resize-none rounded-lg border bg-slate-950/50 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 ${
                bulkValidationError ? 'border-red-500 focus:ring-red-500' : 'border-slate-700 focus:ring-blue-500'
              }`}
            />
            {bulkValidationError && (
              <div className="mt-2 flex items-center gap-2 text-xs text-red-400">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                {bulkValidationError}
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <button
                onClick={closeBulkAction}
                disabled={bulkProcessing}
                className="flex-1 rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-slate-700 disabled:opacity-50"
              >
                取消
              </button>
              <button
                onClick={confirmBulkAction}
                disabled={bulkProcessing}
                className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all disabled:opacity-50 ${
                  bulkAction === 'approved' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {bulkProcessing ? '處理中...' : bulkAction === 'approved' ? `批准 ${selectedIds.size} 筆` : `拒絕 ${selectedIds.size} 筆`}
              </button>
            </div>
          </div>
        </div>
      )}

      {reviewingWithdrawal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="withdrawal-review-title"
            className="dark-panel-scroll max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-cyan-400/35 bg-gradient-to-b from-slate-900 via-blue-950 to-slate-950 shadow-2xl shadow-cyan-950/60 ring-1 ring-inset ring-white/10"
          >
            <div className="relative border-b border-cyan-300/20 bg-gradient-to-r from-blue-700/35 via-cyan-600/20 to-slate-900 px-5 py-4">
              <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-blue-500 via-cyan-300 to-blue-500" />
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-300/35 bg-cyan-400/15 text-cyan-100 ring-1 ring-inset ring-white/10">
                    <CheckCircle className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">Pending decision</div>
                    <h2 id="withdrawal-review-title" className="mt-0.5 text-lg font-bold text-white">審核提現申請</h2>
                    <p className="mt-0.5 text-xs text-cyan-100/60">確認申請資料並填寫審核備註</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={cancelReviewing}
                  disabled={reviewSaving}
                  aria-label="關閉審核面板"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-300/20 bg-slate-950/35 text-slate-400 transition-colors hover:border-cyan-300/45 hover:text-white disabled:opacity-50"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="space-y-4 p-5">
              <div className="grid grid-cols-1 overflow-hidden rounded-xl border border-cyan-300/15 bg-slate-950/45 sm:grid-cols-3">
                <div className="border-b border-cyan-300/10 px-4 py-3 sm:border-b-0 sm:border-r">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">員工</div>
                  <div className="mt-1 truncate text-sm font-bold text-white">{reviewingWithdrawal.employee?.username || '未知員工'}</div>
                  <div className="mt-0.5 truncate text-[11px] text-cyan-200/65">{reviewingWithdrawal.employee?.employee_id || '—'}</div>
                </div>
                <div className="border-b border-cyan-300/10 px-4 py-3 sm:border-b-0 sm:border-r">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">提現金額</div>
                  <div className="mt-1 text-xl font-black tabular-nums text-cyan-100">${reviewingWithdrawal.amount.toFixed(2)}</div>
                </div>
                <div className="px-4 py-3">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">提交時間</div>
                  <div className="mt-1 text-xs font-semibold leading-5 text-slate-200">{new Date(reviewingWithdrawal.created_at).toLocaleString()}</div>
                </div>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-3">
                  <label htmlFor="withdrawal-review-remark" className="text-xs font-bold text-cyan-100">審核備註</label>
                  <span className="rounded-full border border-orange-400/25 bg-orange-400/10 px-2 py-0.5 text-[10px] font-semibold text-orange-200">必填</span>
                </div>
                <textarea
                  id="withdrawal-review-remark"
                  value={auditRemark}
                  onChange={(event) => {
                    setAuditRemark(event.target.value);
                    if (validationError) setValidationError(null);
                  }}
                  rows={4}
                  autoFocus
                  placeholder="請清楚輸入批准或拒絕原因..."
                  className={`w-full resize-none rounded-xl border bg-white px-3.5 py-3 text-sm leading-6 text-slate-900 placeholder-slate-400 outline-none transition-all focus:ring-2 ${
                    validationError
                      ? 'border-red-400 focus:border-red-500 focus:ring-red-500/20'
                      : 'border-cyan-300/40 focus:border-cyan-500 focus:ring-cyan-500/20'
                  }`}
                />
                {validationError && (
                  <div className="mt-2 flex items-center gap-2 text-xs font-medium text-red-300">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {validationError}
                  </div>
                )}
              </div>
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-cyan-300/15 bg-slate-950/40 px-5 py-4 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={cancelReviewing}
                disabled={reviewSaving}
                className="rounded-xl border border-slate-600/70 bg-slate-800/70 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-700 hover:text-white disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleReview(reviewingWithdrawal.id, 'rejected')}
                disabled={reviewSaving}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-red-300/30 bg-red-600/90 px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-red-500 disabled:opacity-50"
              >
                <XCircle className="h-4 w-4" />
                拒絕申請
              </button>
              <button
                type="button"
                onClick={() => handleReview(reviewingWithdrawal.id, 'approved')}
                disabled={reviewSaving}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-300/30 bg-emerald-600 px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
              >
                <CheckCircle className="h-4 w-4" />
                {reviewSaving ? '處理中...' : '批准申請'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingWithdrawal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="withdrawal-edit-title"
            className={`dark-panel-scroll max-h-[calc(100vh-2rem)] w-full max-w-xl overflow-y-auto rounded-2xl border shadow-2xl ring-1 ring-inset ring-white/10 ${editingTheme.panel}`}
          >
            <div className={`relative border-b px-5 py-4 ${editingTheme.header}`}>
              <div className={`absolute inset-x-0 top-0 h-1 bg-gradient-to-r ${editingTheme.topLine}`} />
              <div className="flex items-start justify-between gap-4">
                <div className="flex min-w-0 items-center gap-3">
                  <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ring-1 ring-inset ring-white/10 ${editingTheme.iconShell}`}>
                    <Pencil className={`h-5 w-5 ${editingTheme.icon}`} />
                  </div>
                  <div className="min-w-0">
                    <div className={`text-[10px] font-bold uppercase tracking-[0.18em] ${editingTheme.eyebrow}`}>Historical correction</div>
                    <h2 id="withdrawal-edit-title" className="mt-0.5 text-lg font-bold text-white">編輯提現記錄</h2>
                    <p className={`mt-0.5 text-xs ${editingTheme.subtext}`}>修改結果將同步修正員工錢包</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={cancelEditing}
                  disabled={editSaving}
                  aria-label="關閉編輯面板"
                  className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-slate-950/35 text-slate-400 transition-colors hover:text-white disabled:opacity-50 ${editingTheme.divider}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="space-y-4 p-5">
              <div className={`grid grid-cols-1 overflow-hidden rounded-xl border bg-slate-950/45 sm:grid-cols-3 ${editingTheme.divider}`}>
                <div className={`border-b px-4 py-3 sm:border-b-0 sm:border-r ${editingTheme.divider}`}>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">員工</div>
                  <div className="mt-1 truncate text-sm font-bold text-white">{editingWithdrawal.employee?.username || '未知員工'}</div>
                  <div className={`mt-0.5 truncate text-[11px] ${editingTheme.subtext}`}>{editingWithdrawal.employee?.employee_id || '—'}</div>
                </div>
                <div className={`border-b px-4 py-3 sm:border-b-0 sm:border-r ${editingTheme.divider}`}>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">提現金額</div>
                  <div className={`mt-1 text-xl font-black tabular-nums ${editingTheme.amount}`}>${editingWithdrawal.amount.toFixed(2)}</div>
                </div>
                <div className="px-4 py-3">
                  <div className={`text-[10px] font-semibold uppercase tracking-wider ${editingTheme.label}`}>目前狀態</div>
                  <div className="mt-1.5">{getStatusBadge(editingWithdrawal.status)}</div>
                </div>
              </div>

              <div>
                <div className={`mb-2 text-xs font-bold ${editingTheme.label}`}>修改後狀態</div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setEditStatus('approved')}
                    className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-bold transition-all ${
                      editStatus === 'approved'
                        ? 'border-emerald-300/55 bg-emerald-600 text-white ring-2 ring-emerald-400/15'
                        : 'border-slate-700 bg-slate-950/45 text-slate-400 hover:border-emerald-400/40 hover:text-emerald-200'
                    }`}
                  >
                    <CheckCircle className="h-4 w-4" />
                    已批准
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditStatus('rejected')}
                    className={`flex items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-bold transition-all ${
                      editStatus === 'rejected'
                        ? 'border-red-300/55 bg-red-600 text-white ring-2 ring-red-400/15'
                        : 'border-slate-700 bg-slate-950/45 text-slate-400 hover:border-red-400/40 hover:text-red-200'
                    }`}
                  >
                    <XCircle className="h-4 w-4" />
                    已拒絕
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="withdrawal-edit-remark" className={`mb-2 block text-xs font-bold ${editingTheme.label}`}>審核備註</label>
                <textarea
                  id="withdrawal-edit-remark"
                  value={editRemark}
                  onChange={(event) => setEditRemark(event.target.value)}
                  rows={3}
                  placeholder="輸入此次修改的備註..."
                  className={`w-full resize-none rounded-xl border bg-white px-3.5 py-3 text-sm leading-6 text-slate-900 placeholder-slate-400 outline-none transition-all ${editingTheme.textarea}`}
                />
              </div>

              <div className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-xs leading-5 ${editingTheme.notice}`}>
                <AlertCircle className={`mt-0.5 h-4 w-4 shrink-0 ${editingTheme.noticeIcon}`} />
                <span>這是歷史記錄修正。系統會同步校正錢包；如有待審核提現，將自動取消並留下完整記錄。</span>
              </div>
            </div>

            <div className={`flex gap-2 border-t bg-slate-950/40 px-5 py-4 sm:justify-end ${editingTheme.footer}`}>
              <button
                type="button"
                onClick={cancelEditing}
                disabled={editSaving}
                className="flex-1 rounded-xl border border-slate-600/70 bg-slate-800/70 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:bg-slate-700 hover:text-white disabled:opacity-50 sm:flex-none"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleEditSave(editingWithdrawal)}
                disabled={editSaving}
                className={`inline-flex flex-1 items-center justify-center gap-2 rounded-xl border px-5 py-2.5 text-sm font-bold text-white transition-colors disabled:opacity-50 sm:flex-none ${editingTheme.saveButton}`}
              >
                <Save className="h-4 w-4" />
                {editSaving ? '儲存中...' : '儲存修改'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-950/60">
        {/* Header + Stats */}
        <section className="shrink-0 border-b border-slate-800/70 bg-slate-900/70 px-4 py-1.5 sm:px-5 lg:px-6">
          <div className="flex flex-col gap-1.5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border border-cyan-400/25 bg-gradient-to-br from-blue-600/30 via-cyan-500/15 to-amber-400/10">
                <ArrowUpDown className="h-3 w-3 text-cyan-300" />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="text-sm font-bold tracking-tight text-white sm:text-base">提現審核</h1>
                {scopedStats.pending > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-orange-400/35 bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold text-orange-200">
                    <AlertCircle className="h-3 w-3 text-orange-300" />
                    {scopedStats.pending} 筆待審核
                  </span>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {adminFilterOptions.length > 0 && (
                <div className="relative w-44 shrink-0" ref={groupMenuRef}>
                  <button
                    type="button"
                    onClick={() => setGroupMenuOpen((open) => !open)}
                    className={`flex w-full items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-all ${
                      groupMenuOpen
                        ? 'border-cyan-300/80 bg-gradient-to-r from-blue-700/80 via-cyan-700/60 to-amber-500/35 text-white shadow-lg shadow-cyan-950/60 ring-1 ring-inset ring-cyan-200/20'
                        : 'border-cyan-500/35 bg-gradient-to-r from-slate-800/95 via-blue-950/80 to-cyan-950/70 text-cyan-50 shadow-md shadow-cyan-950/30 ring-1 ring-inset ring-white/5 hover:border-cyan-300/60 hover:from-slate-700/95 hover:via-blue-900/80 hover:to-cyan-900/70 hover:text-white'
                    }`}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-blue-500/60 to-cyan-400/40 text-cyan-100 shadow-inner shadow-cyan-300/20">
                      {adminFilter === 'all' ? <Layers className="h-3 w-3" /> : <Users className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">
                      {adminFilter === 'all' ? '全部分組' : adminFilterOptions.find((opt) => opt.key === adminFilter)?.label || '全部分組'}
                    </span>
                    <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cyan-200/80 transition-transform ${groupMenuOpen ? 'rotate-180' : ''}`} />
                  </button>

                  {groupMenuOpen && (
                    <div className="absolute left-0 z-30 mt-2 w-full max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-cyan-400/30 bg-slate-800/95 shadow-2xl shadow-cyan-950/50 ring-1 ring-white/10 backdrop-blur-xl">
                      <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-cyan-400 to-amber-400" />
                      <div className="max-h-72 overflow-y-auto p-1.5 dark-panel-scroll">
                        <button
                          type="button"
                          onClick={() => {
                            setAdminFilter('all');
                            setGroupMenuOpen(false);
                          }}
                          className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold transition-all ${
                            adminFilter === 'all' ? 'bg-blue-600/90 text-white' : 'text-slate-200 hover:bg-slate-700/80 hover:text-white'
                          }`}
                        >
                          <span className="flex items-center gap-2">
                            <Layers className="h-3.5 w-3.5" />
                            全部分組
                          </span>
                          <span className="flex items-center gap-1.5">
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${adminFilter === 'all' ? 'bg-white/20' : 'bg-slate-700/70 text-slate-300'}`}>
                              {overallStats.total}
                            </span>
                            {adminFilter === 'all' && <Check className="h-3.5 w-3.5" />}
                          </span>
                        </button>

                        <div className="my-1 h-px bg-cyan-300/15" />

                        {adminFilterOptions.map((opt) => (
                          <button
                            key={opt.key}
                            type="button"
                            onClick={() => {
                              setAdminFilter(opt.key);
                              setGroupMenuOpen(false);
                            }}
                            className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium transition-all ${
                              adminFilter === opt.key ? 'bg-blue-600/90 text-white' : 'text-slate-200 hover:bg-slate-700/80 hover:text-white'
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-2">
                              <Users className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{opt.label}</span>
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${adminFilter === opt.key ? 'bg-white/20' : 'bg-slate-700/70 text-slate-300'}`}>
                                {opt.count}
                              </span>
                              {adminFilter === opt.key && <Check className="h-3.5 w-3.5" />}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="flex overflow-x-auto rounded-xl border border-slate-700/60 bg-slate-950/40 scrollbar-hide">
                <div className="min-w-[112px] flex-[1.6] border-r border-yellow-600/40 bg-gradient-to-br from-yellow-500/30 via-amber-500/20 to-yellow-600/10 px-3.5 py-1.5">
                  <div className="text-[11px] font-bold uppercase tracking-[0.14em] text-yellow-200">今日提交</div>
                  <div className="mt-0.5 text-lg font-extrabold tabular-nums text-yellow-50">{todayCount}</div>
                </div>
                <div className="min-w-[82px] flex-1 border-r border-slate-700/60 px-3.5 py-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-orange-300/75">待審核</div>
                  <div className="mt-0.5 text-base font-bold tabular-nums text-orange-200">{scopedStats.pending}</div>
                </div>
                <div className="min-w-[82px] flex-1 border-r border-slate-700/60 px-3.5 py-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-300/75">申請總數</div>
                  <div className="mt-0.5 text-base font-bold tabular-nums text-white">{scopedStats.total}</div>
                </div>
                <div className="min-w-[82px] flex-1 border-r border-slate-700/60 px-3.5 py-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300/75">已批准</div>
                  <div className="mt-0.5 text-base font-bold tabular-nums text-emerald-200">{scopedStats.approved}</div>
                </div>
                <div className="min-w-[82px] flex-1 px-3.5 py-1.5">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-red-300/75">已拒絕</div>
                  <div className="mt-0.5 text-base font-bold tabular-nums text-red-200">{scopedStats.rejected}</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Toolbar: status filter, admin filter, search, sort */}
        <section className="shrink-0 border-b border-slate-800/60 bg-slate-900/35 px-4 py-2 sm:px-5 lg:px-6">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 overflow-x-auto pb-0 scrollbar-hide">
              <div className="flex min-w-max items-center gap-1.5">
                {([
                  { key: 'all', label: '全部', count: scopedStats.total, activeClass: 'bg-blue-600 text-white shadow-md shadow-blue-500/40', activeBadgeClass: 'border-white/80 bg-white text-blue-700', inactiveClass: 'border-blue-500/45 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20 hover:text-blue-100', badgeClass: 'bg-blue-500/20 text-blue-100' },
                  { key: 'today', label: '今日提交', count: todayCount, activeClass: 'bg-amber-500 text-white shadow-md shadow-amber-500/40', activeBadgeClass: 'border-white/80 bg-white text-amber-700', inactiveClass: 'border-amber-500/45 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100', badgeClass: 'bg-amber-500/20 text-amber-100' },
                  { key: 'pending', label: '待審核', count: scopedStats.pending, activeClass: 'bg-orange-600 text-white shadow-md shadow-orange-500/40', activeBadgeClass: 'border-white/80 bg-white text-orange-700', inactiveClass: 'border-orange-500/45 bg-orange-500/10 text-orange-200 hover:bg-orange-500/20 hover:text-orange-100', badgeClass: 'bg-orange-500/20 text-orange-100' },
                  { key: 'approved', label: '已批准', count: scopedStats.approved, activeClass: 'bg-green-600 text-white shadow-md shadow-green-500/40', activeBadgeClass: 'border-white/80 bg-white text-emerald-700', inactiveClass: 'border-green-500/45 bg-green-500/10 text-green-200 hover:bg-green-500/20 hover:text-green-100', badgeClass: 'bg-green-500/20 text-green-100' },
                  { key: 'rejected', label: '已拒絕', count: scopedStats.rejected, activeClass: 'bg-red-600 text-white shadow-md shadow-red-500/40', activeBadgeClass: 'border-white/80 bg-white text-red-700', inactiveClass: 'border-red-500/45 bg-red-500/10 text-red-200 hover:bg-red-500/20 hover:text-red-100', badgeClass: 'bg-red-500/20 text-red-100' },
                  { key: 'cancelled', label: '已取消', count: scopedStats.cancelled, activeClass: 'bg-slate-600 text-white shadow-md shadow-slate-500/40', activeBadgeClass: 'border-white/80 bg-white text-slate-700', inactiveClass: 'border-slate-500/45 bg-slate-500/10 text-slate-200 hover:bg-slate-500/20 hover:text-slate-100', badgeClass: 'bg-slate-500/25 text-slate-100' },
                  { key: 'processed', label: '已處理', count: scopedStats.processed, activeClass: 'bg-cyan-600 text-white shadow-md shadow-cyan-500/40', activeBadgeClass: 'border-white/80 bg-white text-cyan-700', inactiveClass: 'border-cyan-500/45 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20 hover:text-cyan-100', badgeClass: 'bg-cyan-500/20 text-cyan-100' },
                ] as const).map((item) => (
                  <button
                    key={item.key}
                    onClick={() => {
                      setFilterStatus(item.key);
                      if (item.key === 'all') setSelectedDate('all');
                    }}
                    className={`flex items-stretch whitespace-nowrap overflow-hidden rounded-lg border border-transparent text-xs font-semibold transition-all ${
                      filterStatus === item.key && (item.key !== 'all' || selectedDate === 'all')
                        ? item.activeClass
                        : item.inactiveClass
                    }`}
                  >
                    <span className="px-2.5 py-1.5">{item.label}</span>
                    <span className={`inline-flex min-w-[28px] shrink-0 items-center justify-center whitespace-nowrap border-l px-1.5 py-1.5 text-xs font-extrabold leading-none tabular-nums ${filterStatus === item.key && (item.key !== 'all' || selectedDate === 'all') ? item.activeBadgeClass : `border-white/15 ${item.badgeClass}`}`}>
                      {item.count}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative w-44 shrink-0" ref={dateMenuRef}>
                <button
                  type="button"
                  onClick={() => {
                    setDateMenuOpen((open) => !open);
                    setSortMenuOpen(false);
                  }}
                  aria-expanded={dateMenuOpen}
                  aria-haspopup="listbox"
                  className={`flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-1.5 text-left text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50 ${selectedDate !== 'all' ? 'pr-9' : ''} ${
                    dateMenuOpen
                      ? 'border-cyan-300/80 bg-gradient-to-r from-blue-700/90 via-cyan-700/75 to-slate-800 text-white'
                      : selectedDate !== 'all'
                        ? 'border-cyan-400/60 bg-gradient-to-r from-blue-950/95 via-cyan-950/90 to-slate-900 text-cyan-50 hover:border-cyan-300/80'
                        : 'border-slate-600/80 bg-slate-800/95 text-slate-100 hover:border-cyan-400/60 hover:bg-slate-700/95'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-blue-500/55 to-cyan-400/35 text-cyan-100 ring-1 ring-inset ring-cyan-200/15">
                      <CalendarDays className="h-3.5 w-3.5" />
                    </span>
                    <span className="truncate">
                      {selectedDate === 'all' ? '日期选择' : selectedDate.split('-').join('/')}
                    </span>
                  </span>
                  <ChevronDown
                    aria-hidden="true"
                    className={`h-3.5 w-3.5 shrink-0 text-cyan-200/80 transition-[opacity,transform] ${
                      selectedDate === 'all' ? 'opacity-100' : 'pointer-events-none opacity-0'
                    } ${dateMenuOpen ? 'rotate-180' : ''}`}
                  />
                </button>

                <button
                  type="button"
                  disabled={selectedDate === 'all'}
                  tabIndex={selectedDate === 'all' ? -1 : 0}
                  aria-hidden={selectedDate === 'all'}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedDate('all');
                    setDateMenuOpen(false);
                  }}
                  aria-label="取消日期筛选"
                  title="取消日期筛选"
                  className={`absolute right-2 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border border-red-300/70 bg-red-600 text-white transition-[opacity,background-color,border-color] focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300/70 hover:border-red-200 hover:bg-red-500 ${
                    selectedDate === 'all' ? 'pointer-events-none opacity-0' : 'opacity-100'
                  }`}
                >
                  <X className="h-3 w-3" />
                </button>

                {dateMenuOpen && (
                  <div className="absolute left-0 z-40 mt-2 w-full overflow-hidden rounded-xl border border-cyan-300/30 bg-gradient-to-b from-slate-800 via-blue-950 to-cyan-950 shadow-md shadow-black/25">
                    <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-cyan-400 to-amber-400" />
                    <div className="flex items-center justify-between border-b border-slate-700/70 bg-gradient-to-r from-blue-950/80 via-cyan-950/45 to-slate-900/60 px-2.5 py-2">
                      <span className="text-[10px] font-semibold text-slate-300">日期数量</span>
                      <span className="rounded-full border border-cyan-300/35 bg-cyan-400/15 px-2 py-0.5 text-[10px] font-extrabold tabular-nums text-cyan-100">{dateOptions.length}</span>
                    </div>
                    <div className="max-h-72 overflow-y-auto p-1.5 dark-panel-scroll" role="listbox" aria-label="选择提现提交日期">
                      {dateOptions.map((option) => {
                        const isSelected = selectedDate === option.key;
                        const [year, month, day] = option.key.split('-');
                        return (
                          <button
                            key={option.key}
                            type="button"
                            role="option"
                            aria-selected={isSelected}
                            onClick={() => {
                              setSelectedDate(isSelected ? 'all' : option.key);
                              setDateMenuOpen(false);
                            }}
                            className={`flex w-full items-center justify-between gap-1.5 rounded-md px-2 py-1 text-left transition-all ${
                              isSelected
                                ? 'bg-gradient-to-r from-cyan-600/85 via-blue-600/75 to-slate-800 text-white'
                                : 'border border-transparent text-slate-200 hover:border-cyan-300/60 hover:bg-gradient-to-r hover:from-blue-600/75 hover:via-cyan-600/55 hover:to-blue-950 hover:text-white'
                            }`}
                          >
                            <span className="whitespace-nowrap text-[10px] font-bold tabular-nums tracking-wide">{year}/{month}/{day}</span>
                            <span className={`inline-flex h-4 min-w-5 shrink-0 items-center justify-center rounded-full border px-1.5 text-[9px] font-black tabular-nums shadow-sm ${
                              isSelected
                                ? 'border-white/35 bg-white text-blue-800'
                                : 'border-cyan-300/45 bg-cyan-400 text-slate-950'
                            }`}>{option.count}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              <div className="relative" ref={sortMenuRef}>
                <button
                  type="button"
                  onClick={() => setSortMenuOpen((open) => !open)}
                  className={`flex min-w-44 items-center justify-between gap-3 rounded-xl border px-3 py-1.5 text-left text-xs font-semibold shadow-lg transition-all ${
                    sortMenuOpen
                      ? 'border-cyan-300/80 bg-gradient-to-r from-blue-700/85 via-cyan-700/65 to-slate-800 text-white shadow-cyan-950/50 ring-1 ring-inset ring-cyan-200/20'
                      : 'border-slate-600/80 bg-slate-800/95 text-slate-100 shadow-black/25 hover:border-cyan-400/60 hover:bg-slate-700/95'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-cyan-200" />
                    <span className="truncate">{sortOptions.find((option) => option.key === sortOption)?.label}</span>
                  </span>
                  <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cyan-200/80 transition-transform ${sortMenuOpen ? 'rotate-180' : ''}`} />
                </button>

                {sortMenuOpen && (
                  <div className="absolute right-0 z-30 mt-2 w-60 overflow-hidden rounded-xl border border-cyan-400/30 bg-slate-800/95 shadow-2xl shadow-cyan-950/50 ring-1 ring-white/10 backdrop-blur-xl">
                    <div className="h-1 w-full bg-gradient-to-r from-blue-500 via-cyan-400 to-amber-400" />
                    <div className="p-1.5">
                      {sortOptions.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => {
                            setSortOption(option.key);
                            setSortMenuOpen(false);
                          }}
                          className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-all ${
                            sortOption === option.key
                              ? 'bg-cyan-600/85 text-white shadow-md shadow-cyan-950/30'
                              : 'text-slate-200 hover:bg-slate-700/85 hover:text-white'
                          }`}
                        >
                          <span className="min-w-0">
                            <span className="block text-xs font-semibold">{option.label}</span>
                            <span className={`mt-0.5 block text-[10px] ${sortOption === option.key ? 'text-cyan-100/80' : 'text-slate-400'}`}>
                              {option.description}
                            </span>
                          </span>
                          {sortOption === option.key && <Check className="h-3.5 w-3.5 shrink-0 text-cyan-100" />}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="搜尋員工姓名或員工編號"
                  aria-label="搜尋員工姓名或員工編號"
                  className="w-full rounded-xl border border-white/70 bg-white py-1.5 pl-9 pr-3 text-xs font-medium text-slate-800 shadow-lg shadow-black/20 placeholder-slate-400 outline-none transition-all focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30 sm:w-60"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Bulk action bar */}
        {selectedIds.size > 0 && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-blue-400/30 bg-blue-500/10 px-4 py-2.5 sm:px-5 lg:px-6">
            <div className="text-xs font-semibold text-blue-200">
              已選取 {selectedIds.size} 筆提現
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => openBulkAction('approved')}
                className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-green-700"
              >
                <CheckCircle className="h-3.5 w-3.5" />
                批准所選
              </button>
              <button
                onClick={() => openBulkAction('rejected')}
                className="flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white transition-all hover:bg-red-700"
              >
                <XCircle className="h-3.5 w-3.5" />
                拒絕所選
              </button>
              <button
                onClick={() => setSelectedIds(new Set())}
                className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-300 transition-all hover:bg-slate-800 hover:text-white"
              >
                清除
              </button>
            </div>
          </div>
        )}

        {/* Data table */}
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-scroll bg-slate-950/30 dark-panel-scroll" style={{ scrollbarGutter: 'stable' }}>
          <table className={`w-full ${showAdminColumn ? 'min-w-[1032px]' : 'min-w-[920px]'} border-separate border-spacing-0 text-left text-sm`}>
            <thead className={`sticky top-0 z-20 isolate border-b shadow-md shadow-slate-950/25 ${withdrawalTableHeaderThemes[filterStatus]}`}>
              <tr className="h-[40px] text-[10px] font-black uppercase tracking-[0.12em]">
                <th className="h-[40px] w-10 px-3 py-1 text-center">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    className="h-3.5 w-3.5 accent-current"
                    checked={allPendingSelected}
                    onChange={toggleSelectAll}
                    disabled={pendingInView.length === 0}
                    aria-label="選取目前檢視中的所有待審核提現"
                  />
                </th>
                {showAdminColumn && <th className="h-[40px] w-[112px] px-1.5 py-1 text-left">所屬管理員</th>}
                <th className="h-[40px] px-3 py-1 text-left">員工</th>
                <th className="h-[40px] px-3 py-1 text-left">金額</th>
                <th className="h-[40px] px-3 py-1 text-left">狀態</th>
                <th className="h-[40px] w-[42%] min-w-[440px] px-3 py-1 text-left">審核資訊</th>
                <th className="h-[40px] px-3 py-1 text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={showAdminColumn ? 7 : 6} className="px-4 py-14 text-center text-sm text-slate-400">
                    沒有符合目前篩選條件的提現申請
                  </td>
                </tr>
              ) : (
                filteredRows.map((withdrawal, index) => {
                  const isPending = withdrawal.status === 'pending';
                  const isFirstVisibleRow = index === 0;
                  const adminName = withdrawal.admin?.username || '未分配';
                  const displayAuditRemark = formatFinancialCorrectionRemark(withdrawal.audit_remark);
                  const adminAccentClass = withdrawal.admin?.role === 'super_admin'
                    ? 'border-l-amber-300'
                    : withdrawal.admin?.role === 'secondary_admin'
                      ? 'border-l-blue-400'
                      : 'border-l-slate-500';
                  const adminAvatarClass = withdrawal.admin?.role === 'super_admin'
                    ? 'bg-amber-400/15 text-amber-200 ring-amber-300/30'
                    : withdrawal.admin?.role === 'secondary_admin'
                      ? 'bg-blue-500/15 text-blue-200 ring-blue-300/30'
                      : 'bg-slate-700 text-slate-300 ring-slate-500/40';
                  const adminNameClass = withdrawal.admin?.role === 'super_admin'
                    ? 'text-amber-100'
                    : withdrawal.admin?.role === 'secondary_admin'
                      ? 'text-blue-100'
                      : 'text-slate-300';
                  const statusSurfaceClass = withdrawal.status === 'pending'
                    ? 'bg-gradient-to-r from-orange-500/[0.24] via-orange-500/[0.09] to-transparent hover:from-orange-500/[0.32] hover:via-orange-500/[0.14]'
                    : withdrawal.status === 'approved'
                      ? 'bg-gradient-to-r from-emerald-500/[0.19] via-emerald-500/[0.07] to-transparent hover:from-emerald-500/[0.27] hover:via-emerald-500/[0.11]'
                      : withdrawal.status === 'rejected'
                        ? 'bg-gradient-to-r from-red-500/[0.21] via-red-500/[0.08] to-transparent hover:from-red-500/[0.3] hover:via-red-500/[0.12]'
                        : withdrawal.status === 'cancelled'
                          ? 'bg-gradient-to-r from-slate-700/[0.2] via-slate-800/[0.08] to-transparent hover:from-slate-600/[0.28] hover:via-slate-700/[0.12]'
                          : 'bg-gradient-to-r from-cyan-500/[0.19] via-cyan-500/[0.07] to-transparent hover:from-cyan-500/[0.27] hover:via-cyan-500/[0.11]';
                  const amountClass = withdrawal.status === 'pending'
                    ? 'text-orange-200'
                    : withdrawal.status === 'approved'
                      ? 'text-emerald-200'
                      : withdrawal.status === 'rejected'
                        ? 'text-red-200'
                        : withdrawal.status === 'cancelled'
                          ? 'text-slate-400'
                          : 'text-cyan-200';
                  const statusAccentClass = withdrawal.status === 'pending'
                    ? 'border-l-orange-400'
                    : withdrawal.status === 'approved'
                      ? 'border-l-emerald-400'
                      : withdrawal.status === 'rejected'
                        ? 'border-l-red-400'
                        : withdrawal.status === 'cancelled'
                          ? 'border-l-slate-600'
                          : 'border-l-cyan-400';
                  const auditTheme = withdrawal.status === 'pending'
                    ? {
                        trigger: 'border-orange-400/45 text-orange-200 group-hover/remark:border-orange-300 group-hover/remark:text-orange-100',
                        panel: 'border-orange-400/45 bg-orange-950/[0.97]',
                        heading: 'border-orange-300/25 text-orange-200',
                        dot: 'bg-orange-300',
                        body: 'text-orange-50',
                      }
                    : withdrawal.status === 'approved'
                      ? {
                          trigger: 'border-emerald-400/45 text-emerald-200 group-hover/remark:border-emerald-300 group-hover/remark:text-emerald-100',
                          panel: 'border-emerald-400/45 bg-emerald-950/[0.97]',
                          heading: 'border-emerald-300/25 text-emerald-200',
                          dot: 'bg-emerald-300',
                          body: 'text-emerald-50',
                        }
                      : withdrawal.status === 'rejected'
                        ? {
                            trigger: 'border-red-400/45 text-red-200 group-hover/remark:border-red-300 group-hover/remark:text-red-100',
                            panel: 'border-red-400/45 bg-red-950/[0.97]',
                            heading: 'border-red-300/25 text-red-200',
                            dot: 'bg-red-300',
                            body: 'text-red-50',
                          }
                        : withdrawal.status === 'cancelled'
                          ? {
                              trigger: 'border-slate-600 text-slate-400 group-hover/remark:border-slate-500 group-hover/remark:text-slate-300',
                              panel: 'border-slate-600/80 bg-slate-900/[0.98]',
                              heading: 'border-slate-600/80 text-slate-400',
                              dot: 'bg-slate-500',
                              body: 'text-slate-300',
                            }
                          : {
                              trigger: 'border-cyan-400/45 text-cyan-200 group-hover/remark:border-cyan-300 group-hover/remark:text-cyan-100',
                              panel: 'border-cyan-400/45 bg-cyan-950/[0.97]',
                              heading: 'border-cyan-300/25 text-cyan-200',
                              dot: 'bg-cyan-300',
                              body: 'text-cyan-50',
                            };

                  return (
                    <tr key={withdrawal.id} className={`${statusSurfaceClass} transition-colors`}>
                        <td className={`border-l-[3px] px-3 py-2.5 align-top ${statusAccentClass}`}>
                          {isPending && (
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5 accent-blue-500"
                              checked={selectedIds.has(withdrawal.id)}
                              onChange={() => toggleSelectOne(withdrawal.id)}
                              aria-label={`選取 ${withdrawal.employee?.username || '員工'} 的提現申請` }
                            />
                          )}
                        </td>
                        {showAdminColumn && (
                          <td className="w-[124px] px-1.5 py-2.5 align-top">
                            <div
                              title={adminName}
                              aria-label={`所屬管理員：${adminName}`}
                              className={`flex w-full max-w-[112px] items-center gap-1.5 rounded-r-lg border border-slate-700/80 border-l-2 bg-slate-900/65 px-1.5 py-1.5 ${adminAccentClass}`}
                            >
                              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[11px] font-extrabold uppercase ring-1 ring-inset ${adminAvatarClass}`}>
                                {adminName.slice(0, 1)}
                              </span>
                              <span className={`min-w-0 truncate text-[11px] font-semibold ${adminNameClass}`}>{adminName}</span>
                            </div>
                          </td>
                        )}
                        <td className="px-3 py-2.5 align-top">
                          <div className={`font-medium ${amountClass}`}>{withdrawal.employee?.username}</div>
                          <div className={`mt-0.5 text-xs font-medium tracking-wide ${amountClass}`}>
                            {withdrawal.employee?.employee_id}
                          </div>
                        </td>
                        <td className={`px-3 py-2.5 align-top font-bold tabular-nums ${amountClass}`}>
                          <div>${withdrawal.amount.toFixed(2)}</div>
                          <div className={`mt-1 whitespace-nowrap text-[10px] font-bold tabular-nums ${amountClass}`}>
                            {new Date(withdrawal.created_at).toLocaleString()}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 align-top">{getStatusBadge(withdrawal.status)}</td>
                        <td className="w-[42%] min-w-[440px] px-3 py-2.5 align-middle text-xs">
                          {withdrawal.audited_at ? (
                            <>
                              <div className={`font-medium ${amountClass}`}>
                                {new Date(withdrawal.audited_at).toLocaleString()}
                              </div>
                              {displayAuditRemark && (
                                <div className="group/remark relative mt-1 max-w-[440px]">
                                  <div
                                    className={`cursor-help truncate pb-0.5 transition-colors ${auditTheme.trigger}`}
                                    onMouseEnter={(event) => {
                                      const triggerRect = event.currentTarget.getBoundingClientRect();
                                      const popup = event.currentTarget.nextElementSibling;
                                      if (!(popup instanceof HTMLElement)) return;

                                      const popupWidth = Math.min(500, window.innerWidth - 24);
                                      const left = Math.min(
                                        Math.max(12, triggerRect.left),
                                        window.innerWidth - popupWidth - 12,
                                      );
                                      popup.style.left = `${left}px`;
                                      popup.style.top = `${isFirstVisibleRow ? triggerRect.bottom + 8 : triggerRect.top - 8}px`;
                                      popup.style.transform = isFirstVisibleRow ? 'none' : 'translateY(-100%)';
                                    }}
                                  >
                                    {displayAuditRemark}
                                  </div>
                                  <div className={`pointer-events-auto fixed z-[100] hidden w-[500px] max-w-[calc(100vw-2rem)] rounded-xl border p-3 text-left shadow-2xl shadow-black/50 ring-1 ring-white/10 group-hover/remark:block ${auditTheme.panel}`}>
                                    <div className={`flex items-center gap-2 border-b pb-2 text-[10px] font-bold uppercase tracking-[0.16em] ${auditTheme.heading}`}>
                                      <span className={`h-1.5 w-1.5 rounded-full ${auditTheme.dot}`} />
                                      審核備註
                                    </div>
                                    <div className={`mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs font-medium leading-5 dark-panel-scroll ${auditTheme.body}`}>
                                      {displayAuditRemark}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 align-top text-right">
                          {isPending ? (
                            <button
                              type="button"
                              onClick={() => {
                                setReviewing(withdrawal.id);
                                setAuditRemark('');
                                setValidationError(null);
                              }}
                              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/25 bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-blue-500"
                            >
                              <CheckCircle className="h-3 w-3" />
                              審核
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => startEditing(withdrawal)}
                              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${withdrawalStatusThemes[withdrawal.status].editButton}`}
                            >
                              <Pencil className="h-3 w-3" />
                              編輯
                            </button>
                          )}
                        </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Error Display */}
        {error && (
          <div className="shrink-0 border-t border-red-500/40 bg-red-500/10 px-4 py-2.5 sm:px-5 lg:px-6">
            <div className="flex items-center gap-2 text-red-400">
              <AlertCircle className="h-4 w-4" />
              <span className="text-sm font-medium">{error}</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
