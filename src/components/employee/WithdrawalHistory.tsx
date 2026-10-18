import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Clock, CheckCircle, XCircle, History, ChevronDown, ChevronUp, TrendingUp, TrendingDown, DollarSign, Wallet } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useResponsive } from '../../lib/useResponsive';
import { useLanguage } from '../../lib/i18n/context';
import { createFinancialOperationId, getEmployeeFinancialSession } from '../../lib/auth';
import PageLoader from './PageLoader';
import PanelColorBlocks from './PanelColorBlocks';

interface Withdrawal {
  id: string;
  amount: number;
  status: string;
  audit_remark: string | null;
  audited_at: string | null;
  created_at: string;
}

interface WalletTransaction {
  id: string;
  type: string;
  amount: number;
  balance_before: number;
  balance_after: number;
  remarks: string | null;
  created_at: string;
}

interface CombinedRecord {
  id: string;
  type: 'withdrawal' | 'adjustment';
  amount: number;
  created_at: string;
  data: Withdrawal | WalletTransaction;
}

interface WithdrawalHistoryProps {
  employeeId: string;
  onClose: () => void;
}

export default function WithdrawalHistory({ employeeId, onClose }: WithdrawalHistoryProps) {
  const [records, setRecords] = useState<CombinedRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const { isMobile } = useResponsive();
  const { t, dateLocale } = useLanguage();
  const loadAllRecordsRef = useRef<(() => Promise<void>) | null>(null);
  const cancellationOperationIdsRef = useRef(new Map<string, string>());
  const batchSize = isMobile ? 10 : 20;
  const [visibleCount, setVisibleCount] = useState(batchSize);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const visibleRecords = records.slice(0, visibleCount);
  const hasMore = visibleCount < records.length;

  useEffect(() => {
    const root = scrollContainerRef.current;
    const sentinel = loadMoreSentinelRef.current;
    if (!root || !sentinel || !hasMore || loadingMore) return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      setLoadingMore(true);
    }, { root, rootMargin: '0px 0px 160px 0px' });

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, visibleCount]);

  useEffect(() => {
    if (!loadingMore) return;
    // Short pause so the loading indicator reads as a transition instead of a flash.
    const timer = setTimeout(() => {
      setVisibleCount(count => count + batchSize);
      setLoadingMore(false);
    }, 450);
    return () => clearTimeout(timer);
  }, [loadingMore, batchSize]);

  useEffect(() => {
    void loadAllRecordsRef.current?.();

    const interval = setInterval(() => {
      void loadAllRecordsRef.current?.();
    }, 5000);

    return () => clearInterval(interval);
  }, [employeeId]);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  useLayoutEffect(() => {
    const body = document.body;
    const html = document.documentElement;

    const originalBodyOverflow = body.style.overflow;
    const originalHtmlOverflow = html.style.overflow;

    body.style.overflow = 'hidden';
    html.style.overflow = 'hidden';

    return () => {
      body.style.overflow = originalBodyOverflow;
      html.style.overflow = originalHtmlOverflow;
    };
  }, []);

  const loadAllRecords = async () => {
    try {
      const [withdrawalsResult, transactionsResult] = await Promise.all([
        supabase
          .from('withdrawals')
          .select('*')
          .eq('user_id', employeeId)
          .order('created_at', { ascending: false }),
        supabase
          .from('wallet_transactions')
          .select('*')
          .eq('user_id', employeeId)
          .eq('type', 'manual_adjustment')
          .order('created_at', { ascending: false })
      ]);

      const withdrawalRecords: CombinedRecord[] = (withdrawalsResult.data || []).map(w => ({
        id: `w-${w.id}`,
        type: 'withdrawal' as const,
        amount: w.amount,
        created_at: w.created_at,
        data: w
      }));

      const transactionRecords: CombinedRecord[] = (transactionsResult.data || []).map(t => ({
        id: `t-${t.id}`,
        type: 'adjustment' as const,
        amount: Math.abs(parseFloat(t.amount.toString())),
        created_at: t.created_at,
        data: t
      }));

      const combined = [...withdrawalRecords, ...transactionRecords].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );

      setRecords(combined);
    } catch (error) {
      console.error('Error loading records:', error);
    } finally {
      setLoading(false);
    }
  };
  loadAllRecordsRef.current = loadAllRecords;

  const handleClose = () => {
    setExpandedId(null);
    onClose();
  };

  const handleCancelWithdrawal = async (withdrawalId: string) => {
    if (cancelling) return;

    setCancelling(withdrawalId);
    setMessage(null);

    try {
      const financialSession = getEmployeeFinancialSession();
      const operationId = cancellationOperationIdsRef.current.get(withdrawalId)
        || createFinancialOperationId();
      cancellationOperationIdsRef.current.set(withdrawalId, operationId);

      const { data: result, error } = await supabase.rpc('cancel_employee_withdrawal', {
        p_user_id: employeeId,
        p_session_token: financialSession.token,
        p_tab_id: financialSession.tabId,
        p_withdrawal_id: withdrawalId,
        p_operation_id: operationId,
      });

      if (error) throw error;
      if (!result?.success) throw new Error(result?.error || t.withdrawals.cancelFailed);

      cancellationOperationIdsRef.current.delete(withdrawalId);
      setMessage({ type: 'success', text: t.withdrawals.cancelSuccess });

      setTimeout(() => loadAllRecords(), 500);
    } catch (error) {
      console.error('Error cancelling withdrawal:', error);
      const errorMessage = error instanceof Error ? error.message : t.withdrawals.cancelFailed;
      setMessage({ type: 'error', text: errorMessage });
      void loadAllRecordsRef.current?.();
    } finally {
      setCancelling(null);
    }
  };

  const getStatusIcon = (record: CombinedRecord) => {
    if (record.type === 'withdrawal') {
      const withdrawal = record.data as Withdrawal;
      switch (withdrawal.status) {
        case 'pending':
          return <Clock className="w-5 h-5 text-white" />;
        case 'approved':
          return <CheckCircle className="w-5 h-5 text-white" />;
        case 'rejected':
          return <XCircle className="w-5 h-5 text-white" />;
        case 'cancelled':
          return <XCircle className="w-5 h-5 text-white" />;
        default:
          return <Clock className="w-5 h-5 text-white" />;
      }
    } else {
      const transaction = record.data as WalletTransaction;
      if (parseFloat(transaction.amount.toString()) > 0) {
        return <TrendingUp className="w-5 h-5 text-white" />;
      } else {
        return <TrendingDown className="w-5 h-5 text-white" />;
      }
    }
  };

  const getStatusBadgeStyle = (record: CombinedRecord) => {
    if (record.type === 'withdrawal') {
      const withdrawal = record.data as Withdrawal;
      switch (withdrawal.status) {
        case 'pending':
          return 'text-amber-700 bg-amber-50 border-amber-200';
        case 'approved':
          return 'text-emerald-700 bg-emerald-50 border-emerald-200';
        case 'rejected':
          return 'text-red-700 bg-red-50 border-red-200';
        case 'cancelled':
          return 'text-gray-600 bg-gray-100 border-gray-200';
        default:
          return 'text-gray-600 bg-gray-100 border-gray-200';
      }
    } else {
      const transaction = record.data as WalletTransaction;
      if (parseFloat(transaction.amount.toString()) > 0) {
        return 'text-emerald-700 bg-emerald-50 border-emerald-200';
      } else {
        return 'text-red-700 bg-red-50 border-red-200';
      }
    }
  };

  const RECORD_THEMES = {
    amber: {
      card: 'border-amber-200 bg-gradient-to-br from-white via-amber-50 to-orange-100/70 shadow-[0_8px_20px_-12px_rgba(245,158,11,0.55)] hover:border-amber-300',
      bar: 'from-amber-400 to-orange-500',
      icon: 'from-amber-400 to-orange-500 shadow-amber-300/60',
      amount: 'text-amber-950',
      time: 'text-amber-800/60',
      chevron: 'bg-amber-100 text-amber-600 ring-1 ring-amber-200/80 hover:bg-amber-200/70',
      pattern: 'border-amber-500',
      divider: 'border-amber-200/70',
      detailBg: 'bg-gradient-to-b from-amber-50/70 to-orange-50/40',
      tile: 'rounded-xl bg-white/80 p-2.5 ring-1 ring-amber-200/60 sm:p-3',
      tileLabel: 'text-amber-700/60',
    },
    emerald: {
      card: 'border-emerald-200 bg-gradient-to-br from-white via-emerald-50 to-teal-100/70 shadow-[0_8px_20px_-12px_rgba(16,185,129,0.55)] hover:border-emerald-300',
      bar: 'from-emerald-400 to-teal-500',
      icon: 'from-emerald-400 to-teal-500 shadow-emerald-300/60',
      amount: 'text-emerald-950',
      time: 'text-emerald-800/60',
      chevron: 'bg-emerald-100 text-emerald-600 ring-1 ring-emerald-200/80 hover:bg-emerald-200/70',
      pattern: 'border-emerald-500',
      divider: 'border-emerald-200/70',
      detailBg: 'bg-gradient-to-b from-emerald-50/70 to-teal-50/40',
      tile: 'rounded-xl bg-white/80 p-2.5 ring-1 ring-emerald-200/60 sm:p-3',
      tileLabel: 'text-emerald-700/60',
    },
    rose: {
      card: 'border-rose-200 bg-gradient-to-br from-white via-rose-50 to-orange-100/60 shadow-[0_8px_20px_-12px_rgba(244,63,94,0.5)] hover:border-rose-300',
      bar: 'from-rose-400 to-orange-400',
      icon: 'from-rose-500 to-orange-500 shadow-rose-300/60',
      amount: 'text-rose-950',
      time: 'text-rose-800/60',
      chevron: 'bg-rose-100 text-rose-600 ring-1 ring-rose-200/80 hover:bg-rose-200/70',
      pattern: 'border-rose-500',
      divider: 'border-rose-200/70',
      detailBg: 'bg-gradient-to-b from-rose-50/70 to-orange-50/40',
      tile: 'rounded-xl bg-white/80 p-2.5 ring-1 ring-rose-200/60 sm:p-3',
      tileLabel: 'text-rose-700/60',
    },
    slate: {
      card: 'border-slate-200 bg-gradient-to-br from-white via-slate-50 to-slate-100 shadow-[0_8px_20px_-12px_rgba(100,116,139,0.45)] hover:border-slate-300',
      bar: 'from-slate-300 to-slate-400',
      icon: 'from-slate-400 to-slate-500 shadow-slate-300/60',
      amount: 'text-slate-800',
      time: 'text-slate-500',
      chevron: 'bg-slate-100 text-slate-500 ring-1 ring-slate-200/80 hover:bg-slate-200/70',
      pattern: 'border-slate-400',
      divider: 'border-slate-200/80',
      detailBg: 'bg-gradient-to-b from-slate-50/80 to-slate-100/50',
      tile: 'rounded-xl bg-white/80 p-2.5 ring-1 ring-slate-200/70 sm:p-3',
      tileLabel: 'text-slate-500',
    },
  } as const;

  const getRecordTheme = (record: CombinedRecord) => {
    if (record.type === 'withdrawal') {
      switch ((record.data as Withdrawal).status) {
        case 'pending': return RECORD_THEMES.amber;
        case 'approved': return RECORD_THEMES.emerald;
        case 'rejected': return RECORD_THEMES.rose;
        default: return RECORD_THEMES.slate;
      }
    }
    return parseFloat((record.data as WalletTransaction).amount.toString()) > 0 ? RECORD_THEMES.emerald : RECORD_THEMES.rose;
  };

  const getStatusLabel = (record: CombinedRecord) => {
    if (record.type === 'withdrawal') {
      const withdrawal = record.data as Withdrawal;
      switch (withdrawal.status) {
        case 'pending':
          return t.withdrawals.pending;
        case 'approved':
          return t.withdrawals.approved;
        case 'rejected':
          return t.withdrawals.rejected;
        case 'cancelled':
          return t.withdrawals.cancelled;
        default:
          return withdrawal.status;
      }
    } else {
      const transaction = record.data as WalletTransaction;
      if (parseFloat(transaction.amount.toString()) > 0) {
        return t.withdrawals.balanceAdded;
      } else {
        return t.withdrawals.balanceDeducted;
      }
    }
  };

  return createPortal(
    <div
      className="employee-modal-backdrop fixed inset-0 flex md:items-stretch md:justify-stretch md:p-0 lg:items-stretch lg:justify-stretch lg:p-0 xl:items-center xl:justify-center xl:p-4"
      style={{
        zIndex: 9999,
        alignItems: isMobile ? 'stretch' : undefined,
        justifyContent: isMobile ? 'stretch' : undefined,
        padding: isMobile ? '0' : undefined
      }}
    >
      <div className="absolute inset-0 bg-black/40"></div>
      <div
        className="employee-modal-surface relative bg-gray-50 w-full overflow-hidden flex flex-col
                   md:h-screen md:max-h-full md:rounded-none
                   xl:h-[88vh] xl:max-h-[90vh] xl:rounded-2xl xl:shadow-2xl xl:max-w-4xl"
        style={{
          width: isMobile ? '100%' : undefined,
          height: isMobile ? '100dvh' : undefined,
          maxHeight: isMobile ? '100dvh' : undefined,
          borderRadius: isMobile ? '0' : undefined
        }}
      >
        {/* Blue Header */}
        <div
          className="relative z-10 bg-gradient-to-r from-blue-600 to-blue-500 sm:px-6 flex items-center justify-between"
          style={{
            paddingTop: isMobile ? 'calc(env(safe-area-inset-top) + 16px)' : '18px',
            paddingBottom: isMobile ? '16px' : '18px',
            paddingLeft: isMobile ? '16px' : undefined,
            paddingRight: isMobile ? '16px' : undefined
          }}
        >
          <div className="flex items-center gap-2.5 sm:gap-3">
            <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center">
              <History className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white leading-tight">
                {t.withdrawals.title}
              </h2>
              <p className="text-[11px] sm:text-xs text-blue-100 mt-0.5">{t.withdrawals.subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label={t.common.close}
            className="emp-close-btn max-sm:-m-0.5 flex !h-[32px] !w-[32px] !min-h-[32px] !min-w-[32px] flex-shrink-0 items-center justify-center rounded-lg bg-white/10 !p-0 text-white/80 ring-1 ring-white/15 transition-colors hover:bg-white/20 hover:text-white active:scale-95 touch-manipulation lg:!h-[40px] lg:!w-[40px] lg:!min-h-[40px] lg:!min-w-[40px] lg:rounded-xl"
          >
            <X className="h-[16px] w-[16px] lg:h-[20px] lg:w-[20px]" strokeWidth={2.25} />
          </button>
        </div>

        {message && (
          <div
            className={`sm:mx-6 sm:mt-4 p-3 sm:p-4 rounded-lg border ${
              message.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                : 'bg-red-50 border-red-200 text-red-700'
            } flex items-center gap-2`}
            style={{
              marginLeft: isMobile ? '16px' : undefined,
              marginRight: isMobile ? '16px' : undefined,
              marginTop: isMobile ? '12px' : undefined
            }}
          >
            {message.type === 'success' ? (
              <CheckCircle className="w-5 h-5 flex-shrink-0" />
            ) : (
              <XCircle className="w-5 h-5 flex-shrink-0" />
            )}
            <span className="text-xs sm:text-sm font-medium">{message.text}</span>
          </div>
        )}

        <div
          className="relative min-h-0 flex-1 overflow-hidden"
          style={{ background: 'linear-gradient(145deg, #ffffff 0%, #f0f7ff 25%, #e6f2fe 50%, #f5faff 75%, #ffffff 100%)' }}
        >
        <PanelColorBlocks />
        <div
          ref={scrollContainerRef}
          className="emp-compact-panel relative h-full overflow-y-auto overscroll-contain sm:p-6"
          style={{
            WebkitOverflowScrolling: 'touch',
            paddingTop: isMobile ? '16px' : undefined,
            paddingBottom: isMobile ? 'calc(env(safe-area-inset-bottom) + 16px)' : undefined,
            paddingLeft: isMobile ? '12px' : undefined,
            paddingRight: isMobile ? '12px' : undefined
          }}
        >
          {loading ? (
            <PageLoader variant="panel" label={t.withdrawals.loadingTransactions} className="h-full" />
          ) : records.length === 0 ? (
            <div className="flex min-h-full flex-col items-center justify-center px-6 py-8 text-center">
              <div className="relative mb-5 h-[96px] w-[120px]" aria-hidden="true">
                <span className="absolute left-1/2 top-1/2 h-[84px] w-[84px] -translate-x-1/2 -translate-y-1/2 -rotate-6 rounded-[28px] border-2 border-sky-300/40"></span>
                <span className="absolute left-1/2 top-1/2 h-[74px] w-[74px] -translate-x-1/2 -translate-y-1/2 rotate-12 rounded-3xl border-2 border-blue-300/50"></span>
                <span className="absolute left-1/2 top-1/2 flex h-[64px] w-[64px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[22px] bg-gradient-to-br from-blue-400 via-sky-400 to-cyan-300 shadow-lg shadow-blue-400/20">
                  <Wallet className="h-8 w-8 text-white" strokeWidth={2} />
                </span>
                <span className="absolute bottom-1 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-white text-blue-500 shadow-md shadow-blue-300/40 ring-2 ring-blue-100">
                  <History className="h-4 w-4" strokeWidth={2.5} />
                </span>
              </div>
              <p className="text-[14px] font-semibold leading-6 text-blue-900 sm:text-base">{t.withdrawals.noWithdrawals}</p>
              <p className="mt-1 max-w-[260px] text-[13px] leading-5 text-blue-800/60">{t.withdrawals.historyHint}</p>
            </div>
          ) : (
          <>
            <div className="space-y-2.5 sm:space-y-3">
              {visibleRecords.map((record) => {
                const isExpanded = expandedId === record.id;
                const theme = getRecordTheme(record);
                return (
                  <div
                    key={record.id}
                    className={`relative overflow-hidden rounded-2xl border transition-all duration-200 hover:-translate-y-px ${theme.card}`}
                  >
                    {/* Left accent bar + content */}
                    <div className="pointer-events-none absolute inset-y-0 right-0 w-36 overflow-hidden opacity-[0.07]" aria-hidden="true">
                      <div className={`absolute right-3 top-3 h-16 w-16 rotate-12 rounded-2xl border-2 ${theme.pattern}`}></div>
                      <div className={`absolute bottom-2 right-10 h-10 w-10 -rotate-6 rounded-lg border-2 ${theme.pattern}`}></div>
                      <div className={`absolute right-2 top-1/2 h-6 w-6 rounded-full border-2 ${theme.pattern}`}></div>
                    </div>
                    <div className="relative flex">
                      <div className={`w-1.5 flex-shrink-0 bg-gradient-to-b sm:w-2 ${theme.bar}`}></div>
                      <div className="flex-1 min-w-0 [overflow-wrap:anywhere]">
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : record.id)}
                          className="w-full p-3 sm:p-4 flex items-center justify-between text-left"
                        >
                          <div className="flex items-start sm:items-center gap-2.5 sm:gap-3 flex-1 min-w-0">
                            <div className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br shadow-md sm:h-10 sm:w-10 ${theme.icon}`}>
                              {getStatusIcon(record)}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 mb-0.5">
                                <span className={`text-lg font-bold tracking-tight sm:text-xl ${theme.amount}`}>
                                  ${parseFloat(record.amount.toString()).toFixed(2)}
                                </span>
                                <span className={`px-2 py-0.5 rounded-md border text-[11px] sm:text-xs font-semibold w-fit ${getStatusBadgeStyle(record)}`}>
                                  {getStatusLabel(record)}
                                </span>
                              </div>
                              <div className={`text-[11px] sm:text-xs ${theme.time}`}>
                                {new Date(record.created_at).toLocaleString(dateLocale, {
                                  year: 'numeric',
                                  month: 'short',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </div>
                            </div>
                          </div>
                          <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-all duration-200 ${isExpanded ? `bg-gradient-to-br text-white shadow-md ${theme.icon}` : theme.chevron}`}>
                            {isExpanded ? (
                              <ChevronUp className="w-4 h-4" />
                            ) : (
                              <ChevronDown className="w-4 h-4" />
                            )}
                          </div>
                        </button>

                        {isExpanded && record.type === 'withdrawal' && (() => {
                          const withdrawal = record.data as Withdrawal;
                          return (
                            <div className={`space-y-2 border-t px-3 pb-3 pt-0 sm:space-y-3 sm:px-4 sm:pb-4 ${theme.divider} ${theme.detailBg}`}>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 pt-3 sm:pt-4">
                                <div className={theme.tile}>
                                  <div className={`mb-1 text-[11px] sm:text-xs ${theme.tileLabel}`}>{t.withdrawals.amount}</div>
                                  <div className="text-base sm:text-lg font-bold text-gray-900">
                                    ${parseFloat(withdrawal.amount.toString()).toFixed(2)}
                                  </div>
                                </div>
                                <div className={theme.tile}>
                                  <div className={`mb-1 text-[11px] sm:text-xs ${theme.tileLabel}`}>{t.withdrawals.status}</div>
                                  <div className={`inline-flex px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md border text-[11px] sm:text-xs font-semibold ${getStatusBadgeStyle(record)}`}>
                                    {getStatusLabel(record)}
                                  </div>
                                </div>
                                <div className={theme.tile}>
                                  <div className={`mb-1 text-[11px] sm:text-xs ${theme.tileLabel}`}>{t.withdrawals.date}</div>
                                  <div className="text-xs sm:text-sm text-gray-700">
                                    {new Date(withdrawal.created_at).toLocaleString(dateLocale, {
                                      year: 'numeric',
                                      month: 'short',
                                      day: 'numeric',
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}
                                  </div>
                                </div>
                                {withdrawal.audited_at && (
                                  <div className={theme.tile}>
                                    <div className={`text-[11px] sm:text-xs mb-1 ${
                                      withdrawal.status === 'approved' ? 'text-emerald-600' :
                                      withdrawal.status === 'rejected' ? 'text-red-600' :
                                      'text-gray-400'
                                    }`}>
                                      {withdrawal.status === 'approved' && t.withdrawals.approvedAt}
                                      {withdrawal.status === 'rejected' && t.withdrawals.rejectedAt}
                                      {withdrawal.status === 'cancelled' && t.withdrawals.cancelledAt}
                                      {!['approved', 'rejected', 'cancelled'].includes(withdrawal.status) && t.withdrawals.processedAt}
                                    </div>
                                    <div className={`text-xs sm:text-sm font-medium ${
                                      withdrawal.status === 'approved' ? 'text-emerald-700' :
                                      withdrawal.status === 'rejected' ? 'text-red-700' :
                                      'text-gray-700'
                                    }`}>
                                      {new Date(withdrawal.audited_at).toLocaleString(dateLocale, {
                                        year: 'numeric',
                                        month: 'short',
                                        day: 'numeric',
                                        hour: '2-digit',
                                        minute: '2-digit',
                                      })}
                                    </div>
                                  </div>
                                )}
                              </div>

                              {withdrawal.status === 'approved' && (
                                <div className="bg-gradient-to-br from-emerald-100/80 to-teal-50 border border-emerald-200 rounded-xl shadow-sm shadow-emerald-100 p-3 sm:p-4">
                                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-0 mb-2">
                                    <div className="flex items-center gap-2 text-emerald-700">
                                      <CheckCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                                      <span className="text-sm sm:text-base font-semibold">{t.withdrawals.withdrawalApproved}</span>
                                    </div>
                                    {withdrawal.audited_at && (
                                      <div className="text-[11px] sm:text-xs text-emerald-500 sm:text-right">
                                        {new Date(withdrawal.audited_at).toLocaleString(dateLocale, {
                                          month: 'short',
                                          day: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </div>
                                    )}
                                  </div>
                                  <p className="text-xs sm:text-sm text-emerald-600">
                                    {t.withdrawals.withdrawalApprovedMsg}
                                  </p>
                                  {withdrawal.audit_remark && (
                                    <div className="mt-2 sm:mt-3 pt-2 sm:pt-3 border-t border-emerald-100">
                                      <div className="text-[11px] sm:text-xs text-emerald-500 mb-1">{t.withdrawals.adminNote}</div>
                                      <div className="text-xs sm:text-sm text-emerald-700">{withdrawal.audit_remark === 'Cancelled by user' ? t.withdrawals.cancelledByUser : withdrawal.audit_remark}</div>
                                    </div>
                                  )}
                                </div>
                              )}

                              {withdrawal.status === 'rejected' && (
                                <div className="bg-gradient-to-br from-rose-100/80 to-orange-50 border border-red-200 rounded-xl shadow-sm shadow-rose-100 p-3 sm:p-4">
                                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-0 mb-2">
                                    <div className="flex items-center gap-2 text-red-700">
                                      <XCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                                      <span className="text-sm sm:text-base font-semibold">{t.withdrawals.withdrawalRejected}</span>
                                    </div>
                                    {withdrawal.audited_at && (
                                      <div className="text-xs text-red-400">
                                        {new Date(withdrawal.audited_at).toLocaleString(dateLocale, {
                                          month: 'short',
                                          day: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </div>
                                    )}
                                  </div>
                                  {withdrawal.audit_remark ? (
                                    <div>
                                      <div className="text-[11px] sm:text-xs text-red-400 mb-1">{t.withdrawals.rejectionReason}</div>
                                      <div className="text-xs sm:text-sm text-red-700">{withdrawal.audit_remark === 'Cancelled by user' ? t.withdrawals.cancelledByUser : withdrawal.audit_remark}</div>
                                    </div>
                                  ) : (
                                    <p className="text-xs sm:text-sm text-red-600">
                                      {t.withdrawals.rejectedContactSupport}
                                    </p>
                                  )}
                                </div>
                              )}

                              {withdrawal.status === 'pending' && (
                                <div className="space-y-2 sm:space-y-3">
                                  <div className="bg-gradient-to-br from-amber-100/80 to-orange-50 border border-amber-200 rounded-xl shadow-sm shadow-amber-100 p-3 sm:p-4">
                                    <div className="flex items-center gap-2 text-amber-700 mb-2">
                                      <Clock className="w-4 h-4 sm:w-5 sm:h-5" />
                                      <span className="text-sm sm:text-base font-semibold">{t.withdrawals.underReview}</span>
                                    </div>
                                    <p className="text-xs sm:text-sm text-amber-600">
                                      {t.withdrawals.underReviewMsg}
                                    </p>
                                  </div>
                                  <button
                                    onClick={() => handleCancelWithdrawal(withdrawal.id)}
                                    disabled={cancelling === withdrawal.id}
                                    className="w-full bg-gradient-to-r from-rose-500 to-red-500 hover:from-rose-600 hover:to-red-600 text-white shadow-md shadow-rose-300/50 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                                  >
                                    <XCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                                    {cancelling === withdrawal.id ? t.withdrawals.cancelling : t.withdrawals.cancelWithdrawal}
                                  </button>
                                </div>
                              )}

                              {withdrawal.status === 'cancelled' && (
                                <div className="bg-gradient-to-br from-slate-100 to-white border border-slate-200 rounded-xl shadow-sm shadow-slate-100 p-3 sm:p-4">
                                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 sm:gap-0 mb-2">
                                    <div className="flex items-center gap-2 text-gray-600">
                                      <XCircle className="w-4 h-4 sm:w-5 sm:h-5" />
                                      <span className="text-sm sm:text-base font-semibold">{t.withdrawals.withdrawalCancelled}</span>
                                    </div>
                                    {withdrawal.audited_at && (
                                      <div className="text-xs text-gray-400">
                                        {new Date(withdrawal.audited_at).toLocaleString(dateLocale, {
                                          month: 'short',
                                          day: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })}
                                      </div>
                                    )}
                                  </div>
                                  {withdrawal.audit_remark ? (
                                    <div>
                                      <div className={`mb-1 text-[11px] sm:text-xs ${theme.tileLabel}`}>{t.withdrawals.reason}</div>
                                      <div className="text-xs sm:text-sm text-gray-600">{withdrawal.audit_remark === 'Cancelled by user' ? t.withdrawals.cancelledByUser : withdrawal.audit_remark}</div>
                                    </div>
                                  ) : (
                                    <p className="text-xs sm:text-sm text-gray-500">
                                      {t.withdrawals.cancelledMsg}
                                    </p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {isExpanded && record.type === 'adjustment' && (() => {
                          const transaction = record.data as WalletTransaction;
                          const isAdd = parseFloat(transaction.amount.toString()) > 0;
                          return (
                            <div className={`space-y-2 border-t px-3 pb-3 pt-0 sm:space-y-3 sm:px-4 sm:pb-4 ${theme.divider} ${theme.detailBg}`}>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 pt-3 sm:pt-4">
                                <div className={theme.tile}>
                                  <div className={`mb-1 text-[11px] sm:text-xs ${theme.tileLabel}`}>{t.withdrawals.transactionType}</div>
                                  <div className={`inline-flex items-center gap-1 sm:gap-1.5 px-2 py-0.5 sm:px-2.5 sm:py-1 rounded-md border text-[11px] sm:text-xs font-semibold ${getStatusBadgeStyle(record)}`}>
                                    {isAdd ? <TrendingUp className="w-3 h-3 sm:w-3.5 sm:h-3.5" /> : <TrendingDown className="w-3 h-3 sm:w-3.5 sm:h-3.5" />}
                                    {isAdd ? t.withdrawals.balanceAdded : t.withdrawals.balanceDeducted}
                                  </div>
                                </div>
                                <div className={theme.tile}>
                                  <div className={`mb-1 text-[11px] sm:text-xs ${theme.tileLabel}`}>{t.withdrawals.amount}</div>
                                  <div className={`text-base sm:text-lg font-bold ${isAdd ? 'text-emerald-600' : 'text-red-600'}`}>
                                    {isAdd ? '+' : ''}${Math.abs(parseFloat(transaction.amount.toString())).toFixed(2)}
                                  </div>
                                </div>
                                <div className={theme.tile}>
                                  <div className={`mb-1 text-[11px] sm:text-xs ${theme.tileLabel}`}>{t.withdrawals.balanceBefore}</div>
                                  <div className="text-xs sm:text-sm text-gray-700">
                                    ${parseFloat(transaction.balance_before.toString()).toFixed(2)}
                                  </div>
                                </div>
                                <div className={theme.tile}>
                                  <div className={`mb-1 text-[11px] sm:text-xs ${theme.tileLabel}`}>{t.withdrawals.balanceAfter}</div>
                                  <div className="text-xs sm:text-sm text-gray-700">
                                    ${parseFloat(transaction.balance_after.toString()).toFixed(2)}
                                  </div>
                                </div>
                                <div className={`col-span-1 sm:col-span-2 ${theme.tile}`}>
                                  <div className={`mb-1 text-[11px] sm:text-xs ${theme.tileLabel}`}>{t.withdrawals.transactionTime}</div>
                                  <div className="text-xs sm:text-sm text-gray-700">
                                    {new Date(transaction.created_at).toLocaleString(dateLocale, {
                                      year: 'numeric',
                                      month: 'short',
                                      day: 'numeric',
                                      hour: '2-digit',
                                      minute: '2-digit',
                                    })}
                                  </div>
                                </div>
                              </div>

                              {transaction.remarks && (
                                <div className={`border rounded-xl shadow-sm p-3 sm:p-4 ${isAdd ? 'border-emerald-200 bg-gradient-to-br from-emerald-100/80 to-teal-50 shadow-emerald-100' : 'border-red-200 bg-gradient-to-br from-rose-100/80 to-orange-50 shadow-rose-100'}`}>
                                  <div className="flex items-center gap-2 mb-2">
                                    <DollarSign className={`w-4 h-4 sm:w-5 sm:h-5 ${isAdd ? 'text-emerald-600' : 'text-red-600'}`} />
                                    <span className={`text-sm sm:text-base font-semibold ${isAdd ? 'text-emerald-700' : 'text-red-700'}`}>
                                      {t.withdrawals.financialAdjustment}
                                    </span>
                                  </div>
                                  <div className={`mb-1 text-[11px] sm:text-xs ${theme.tileLabel}`}>{t.withdrawals.remarks}</div>
                                  <div className={`text-xs sm:text-sm ${isAdd ? 'text-emerald-700' : 'text-red-700'}`}>
                                    {transaction.remarks}
                                  </div>
                                </div>
                              )}

                              {!transaction.remarks && (
                                <div className={`border rounded-xl shadow-sm p-3 sm:p-4 ${isAdd ? 'border-emerald-200 bg-gradient-to-br from-emerald-100/80 to-teal-50 shadow-emerald-100' : 'border-red-200 bg-gradient-to-br from-rose-100/80 to-orange-50 shadow-rose-100'}`}>
                                  <div className="flex items-center gap-2">
                                    <DollarSign className={`w-4 h-4 sm:w-5 sm:h-5 ${isAdd ? 'text-emerald-600' : 'text-red-600'}`} />
                                    <p className={`text-xs sm:text-sm ${isAdd ? 'text-emerald-600' : 'text-red-600'}`}>
                                      {isAdd
                                        ? t.withdrawals.adminAddedFunds
                                        : t.withdrawals.adminDeductedFunds
                                      }
                                    </p>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {hasMore && (
              <div ref={loadMoreSentinelRef} className="flex items-center justify-center py-5" aria-live="polite">
                {loadingMore ? (
                  <div className="flex items-center gap-2 text-gray-400">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent"></div>
                    <span className="text-xs sm:text-sm">{t.common.loading}</span>
                  </div>
                ) : (
                  <div className="h-4" aria-hidden="true"></div>
                )}
              </div>
            )}
          </>
          )}
        </div>
        </div>

        {/* Mobile Close Button */}
        {isMobile && (
        <div className="relative border-t border-gray-200 px-4 py-4 bg-white" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
          <button
            onClick={handleClose}
            className="w-full bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-700 hover:to-cyan-600 text-white shadow-lg shadow-blue-500/25 py-3.5 px-4 rounded-xl text-sm font-semibold transition-all min-h-[48px] active:scale-95 touch-manipulation flex items-center justify-center gap-2"
          >
            <X className="w-4 h-4" />
            {t.common.close}
          </button>
        </div>
        )}

        {/* Desktop Close Button */}
        {!isMobile && (
        <div className="relative border-t border-gray-200 px-4 sm:px-6 py-4 sm:py-5 bg-white">
          <button
            onClick={handleClose}
            className="w-full bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-700 hover:to-cyan-600 text-white shadow-lg shadow-blue-500/25 py-3 sm:py-2.5 rounded-xl font-semibold transition-all min-h-[44px] active:scale-[0.98] text-sm sm:text-base"
          >
            {t.common.close}
          </button>
        </div>
        )}
      </div>
    </div>,
    document.body
  );
}
