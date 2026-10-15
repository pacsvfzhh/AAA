import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { History, ArrowUpRight, CheckCircle, XCircle, Clock, Calendar, MessageSquare, Ban, X, DollarSign, TrendingUp, TrendingDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { formatDateUTC, formatTimeUTC } from '../../lib/dateUtils';
import { Withdrawal, WalletTransaction } from '../../types';
import { useResponsive } from '../../lib/useResponsive';
import { useLanguage } from '../../lib/i18n/context';
import { usePaginatedList } from '../../lib/usePaginatedList';
import { createFinancialOperationId, getEmployeeFinancialSession } from '../../lib/auth';

interface TransactionHistoryProps {
  employeeId: string;
}

type CombinedTransaction =
  | { type: 'withdrawal'; data: Withdrawal; created_at: string }
  | { type: 'wallet_transaction'; data: WalletTransaction; created_at: string };

export default function TransactionHistory({ employeeId }: TransactionHistoryProps) {
  const [transactions, setTransactions] = useState<CombinedTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [selectedTransaction, setSelectedTransaction] = useState<CombinedTransaction | null>(null);
  const { isMobile } = useResponsive();
  const { t } = useLanguage();
  const loadTransactionsRef = useRef<(() => Promise<void>) | null>(null);
  const cancellationOperationIdsRef = useRef(new Map<string, string>());

  const ITEMS_PER_PAGE = isMobile ? 10 : 15;
  const { pageItems, page, totalPages, totalItems, hasNext, hasPrev, goNext, goPrev } = usePaginatedList({
    items: transactions,
    pageSize: ITEMS_PER_PAGE,
  });

  useEffect(() => {
    void loadTransactionsRef.current?.();

    // Realtime subscription for new wallet transactions
    const txChannel = supabase
      .channel(`tx-history-${employeeId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'wallet_transactions', filter: `user_id=eq.${employeeId}` },
        () => {
          void loadTransactionsRef.current?.();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'withdrawal_events', filter: `user_id=eq.${employeeId}` },
        () => {
          void loadTransactionsRef.current?.();
        }
      )
      .subscribe();

    // Fallback polling at longer interval since realtime handles most updates
    const interval = setInterval(() => {
      void loadTransactionsRef.current?.();
    }, 15000);

    return () => {
      supabase.removeChannel(txChannel);
      clearInterval(interval);
    };
  }, [employeeId]);

  const isDetailOpen = Boolean(selectedTransaction);
  useLayoutEffect(() => {
    if (!isDetailOpen) return;

    const scrollY = window.scrollY;
    const body = document.body;
    const previousStyles = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      overflow: body.style.overflow,
    };
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.overflow = 'hidden';

    return () => {
      Object.assign(body.style, previousStyles);
      window.scrollTo({ top: scrollY, behavior: 'instant' });
    };
  }, [isDetailOpen]);

  const loadTransactions = async () => {
    try {
      const [withdrawalsResult, walletTransactionsResult] = await Promise.all([
        supabase
          .from('withdrawals')
          .select('*')
          .eq('user_id', employeeId)
          .order('created_at', { ascending: false }),
        supabase
          .from('wallet_transactions')
          .select('*')
          .eq('user_id', employeeId)
          .in('type', ['manual_adjustment', 'withdrawal_approved', 'withdrawal_rejected', 'performance_bonus'])
          .order('created_at', { ascending: false })
      ]);

      if (withdrawalsResult.error) throw withdrawalsResult.error;
      if (walletTransactionsResult.error) throw walletTransactionsResult.error;

      const withdrawalTransactions: CombinedTransaction[] = (withdrawalsResult.data || []).map(w => ({
        type: 'withdrawal' as const,
        data: w,
        created_at: w.created_at
      }));

      const walletAdjustments: CombinedTransaction[] = (walletTransactionsResult.data || []).map(wt => ({
        type: 'wallet_transaction' as const,
        data: wt,
        created_at: wt.created_at
      }));

      const combined = [...withdrawalTransactions, ...walletAdjustments]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

      setTransactions(combined);
    } catch (error) {
      console.error('Error loading transactions:', error);
    } finally {
      setLoading(false);
    }
  };
  loadTransactionsRef.current = loadTransactions;

  const getTransactionIcon = (transaction: CombinedTransaction) => {
    if (transaction.type === 'withdrawal') {
      const withdrawal = transaction.data as Withdrawal;
      switch (withdrawal.status) {
        case 'approved':
          return <CheckCircle className="w-4 h-4" />;
        case 'rejected':
          return <XCircle className="w-4 h-4" />;
        case 'cancelled':
          return <Ban className="w-4 h-4" />;
        case 'pending':
          return <Clock className="w-4 h-4" />;
        default:
          return null;
      }
    } else {
      const walletTx = transaction.data as WalletTransaction;
      if (walletTx.type === 'withdrawal_approved') return <CheckCircle className="w-4 h-4" />;
      if (walletTx.type === 'withdrawal_rejected') return <XCircle className="w-4 h-4" />;
      if (walletTx.type === 'performance_bonus') return <DollarSign className="w-4 h-4" />;
      return walletTx.amount > 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />;
    }
  };

  const getTransactionStatus = (transaction: CombinedTransaction): string => {
    if (transaction.type === 'withdrawal') {
      return (transaction.data as Withdrawal).status;
    } else {
      const walletTx = transaction.data as WalletTransaction;
      if (walletTx.type === 'withdrawal_approved') return 'approved';
      if (walletTx.type === 'withdrawal_rejected') return 'rejected';
      if (walletTx.type === 'performance_bonus') return 'performance_bonus';
      const amount = walletTx.amount;
      return amount > 0 ? 'adjustment_add' : 'adjustment_subtract';
    }
  };

  const getStatusConfig = (status: string) => {
    const configs = {
      pending: {
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/30',
        text: 'text-amber-400',
        iconBg: 'bg-amber-500/20',
        dotColor: 'bg-amber-400'
      },
      approved: {
        bg: 'bg-emerald-500/10',
        border: 'border-emerald-500/30',
        text: 'text-emerald-400',
        iconBg: 'bg-emerald-500/20',
        dotColor: 'bg-emerald-400'
      },
      rejected: {
        bg: 'bg-rose-500/10',
        border: 'border-rose-500/30',
        text: 'text-rose-400',
        iconBg: 'bg-rose-500/20',
        dotColor: 'bg-rose-400'
      },
      cancelled: {
        bg: 'bg-slate-500/10',
        border: 'border-slate-500/30',
        text: 'text-slate-400',
        iconBg: 'bg-slate-500/20',
        dotColor: 'bg-slate-400'
      },
      adjustment_add: {
        bg: 'bg-blue-500/10',
        border: 'border-blue-500/30',
        text: 'text-blue-400',
        iconBg: 'bg-blue-500/20',
        dotColor: 'bg-blue-400'
      },
      adjustment_subtract: {
        bg: 'bg-orange-500/10',
        border: 'border-orange-500/30',
        text: 'text-orange-400',
        iconBg: 'bg-orange-500/20',
        dotColor: 'bg-orange-400'
      },
      performance_bonus: {
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/30',
        text: 'text-amber-400',
        iconBg: 'bg-amber-500/20',
        dotColor: 'bg-amber-400'
      },
    };

    return configs[status as keyof typeof configs];
  };

  const getTransactionAmount = (transaction: CombinedTransaction): number => {
    if (transaction.type === 'withdrawal') {
      return (transaction.data as Withdrawal).amount;
    } else {
      return (transaction.data as WalletTransaction).amount;
    }
  };

  const getTransactionLabel = (transaction: CombinedTransaction): string => {
    if (transaction.type === 'withdrawal') {
      return (transaction.data as Withdrawal).status.toUpperCase();
    } else {
      const walletTx = transaction.data as WalletTransaction;
      if (walletTx.type === 'withdrawal_approved') return 'WITHDRAWAL COMPLETED';
      if (walletTx.type === 'withdrawal_rejected') return 'WITHDRAWAL REFUNDED';
      if (walletTx.type === 'performance_bonus') return 'PERFORMANCE BONUS';
      const amount = walletTx.amount;
      return amount > 0 ? 'BALANCE ADDED' : 'BALANCE DEDUCTED';
    }
  };

  const getTransactionRemark = (transaction: CombinedTransaction): string | null => {
    if (transaction.type === 'withdrawal') {
      const remark = (transaction.data as Withdrawal).audit_remark;
      if (remark === 'Cancelled by user') return t.withdrawals.cancelledByUser;
      return remark;
    } else {
      const remark = (transaction.data as WalletTransaction).remarks || null;
      if (remark === 'Customer service tip') return t.orderList.tipRemarks;
      return remark;
    }
  };

  const formatDate = (dateString: string) => {
    return formatDateUTC(dateString);
  };

  const formatTime = (dateString: string) => {
    return formatTimeUTC(dateString);
  };

  const handleCancelWithdrawal = async (transaction: CombinedTransaction) => {
    if (transaction.type !== 'withdrawal') return;
    const withdrawal = transaction.data as Withdrawal;

    if (!confirm('Are you sure you want to cancel this withdrawal request? The frozen amount will be returned to your available balance.')) {
      return;
    }

    setCancellingId(withdrawal.id);

    try {
      const financialSession = getEmployeeFinancialSession();
      const operationId = cancellationOperationIdsRef.current.get(withdrawal.id)
        || createFinancialOperationId();
      cancellationOperationIdsRef.current.set(withdrawal.id, operationId);

      const { data: result, error } = await supabase.rpc('cancel_employee_withdrawal', {
        p_user_id: employeeId,
        p_session_token: financialSession.token,
        p_tab_id: financialSession.tabId,
        p_withdrawal_id: withdrawal.id,
        p_operation_id: operationId,
      });

      if (error) throw error;
      if (!result?.success) throw new Error(result?.error || 'Failed to cancel withdrawal.');

      cancellationOperationIdsRef.current.delete(withdrawal.id);
      await loadTransactions();
      alert('Withdrawal cancelled successfully. Funds have been returned to your available balance.');
    } catch (error) {
      console.error('Error cancelling withdrawal:', error);
      alert(`Failed to cancel withdrawal: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again.`);
      // Reload to ensure UI reflects actual state
      void loadTransactionsRef.current?.();
    } finally {
      setCancellingId(null);
    }
  };

  if (loading) {
    return (
      <div className="bg-gradient-to-br from-slate-900/90 to-slate-800/90 backdrop-blur-xl rounded-xl lg:rounded-2xl border border-slate-700/50 p-6 lg:p-8 text-center">
        <div className="inline-flex items-center gap-2 text-slate-400">
          <div className="w-5 h-5 border-2 border-slate-400 border-t-transparent rounded-full animate-spin"></div>
          <span>Loading transaction history...</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{`
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}</style>
      <div className="bg-gradient-to-br from-slate-900/90 to-slate-800/90 backdrop-blur-xl rounded-xl lg:rounded-2xl border border-slate-700/50 shadow-xl overflow-hidden">
      <div className="bg-gradient-to-r from-blue-500/10 via-cyan-500/10 to-teal-500/10 border-b border-slate-700/50 px-4 py-3.5 lg:px-6 lg:py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5 lg:gap-3">
            <div className="p-2 bg-blue-500/20 rounded-lg">
              <History className="w-4 h-4 lg:w-5 lg:h-5 text-blue-400" />
            </div>
            <h2 className="text-base lg:text-xl font-bold text-white">{t.transactions.title}</h2>
          </div>
          {transactions.length > 0 && (
            <div className="text-xs lg:text-sm text-slate-400 font-medium">
              {transactions.length} {transactions.length === 1 ? 'record' : 'records'}
            </div>
          )}
        </div>
      </div>

      <div className="p-4 lg:p-6">
        {transactions.length === 0 ? (
          <div className="text-center py-12 lg:py-16">
            <div className="inline-flex items-center justify-center w-16 h-16 lg:w-20 lg:h-20 rounded-full bg-slate-800/50 mb-4">
              <ArrowUpRight className="w-8 h-8 lg:w-10 lg:h-10 text-slate-600" />
            </div>
            <p className="text-sm lg:text-base text-slate-400 font-medium">{t.transactions.noTransactions}</p>
            <p className="text-xs lg:text-sm text-slate-500 mt-1">Your transactions will appear here</p>
          </div>
        ) : (
          <>
            <div className="lg:hidden space-y-2 overflow-y-auto pr-1 -mr-1 hide-scrollbar" style={{ maxHeight: 'calc(100vh - 320px)', minHeight: '300px', scrollbarWidth: 'none', msOverflowStyle: 'none', WebkitOverflowScrolling: 'touch' }}>
              {pageItems.map((transaction) => {
                const status = getTransactionStatus(transaction);
                const config = getStatusConfig(status);
                const amount = getTransactionAmount(transaction);
                const label = getTransactionLabel(transaction);
                const remark = getTransactionRemark(transaction);
                const id = transaction.type === 'withdrawal' ? (transaction.data as Withdrawal).id : (transaction.data as WalletTransaction).id;

                return (
                  <div
                    key={`${transaction.type}-${id}`}
                    onClick={() => setSelectedTransaction(transaction)}
                    className="relative bg-slate-800/40 backdrop-blur-sm rounded-lg border border-slate-700/50 overflow-hidden cursor-pointer hover:border-slate-600/70 transition-all hover:bg-slate-800/60"
                  >
                    <div className="absolute top-0 left-0 right-0 h-1" style={{
                      background: `linear-gradient(90deg, ${
                        status === 'approved' || status === 'adjustment_add' ? 'rgba(52, 211, 153, 0.6)' :
                        status === 'rejected' || status === 'adjustment_subtract' ? 'rgba(251, 113, 133, 0.6)' :
                        'rgba(251, 191, 36, 0.6)'
                      }, transparent)`
                    }}></div>

                    <div className="p-3 pt-3.5">
                      <div className="flex items-center justify-between mb-2.5">
                        <div className="flex items-center gap-2">
                          <div className={`p-1.5 rounded-lg ${config.iconBg}`}>
                            <span className={config.text}>
                              {getTransactionIcon(transaction)}
                            </span>
                          </div>
                          <div>
                            <div className="flex items-center gap-1 mb-0.5">
                              <span className={`w-1.5 h-1.5 rounded-full ${config.dotColor} animate-pulse`}></span>
                              <span className={`text-xs font-bold uppercase tracking-wide ${config.text}`}>
                                {label}
                              </span>
                            </div>
                            <div className="flex items-center gap-1 text-[11px] text-slate-400">
                              <Calendar className="w-2.5 h-2.5" />
                              <span>{formatDate(transaction.created_at)}</span>
                              <span className="opacity-40">•</span>
                              <span>{formatTime(transaction.created_at)}</span>
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-[11px] text-slate-500 font-semibold uppercase tracking-wider mb-0.5">Amount</div>
                          <div className="text-xl font-black text-white tracking-tight">
                            ${Math.abs(amount).toFixed(2)}
                          </div>
                        </div>
                      </div>

                      {remark ? (
                        <div className={`rounded-lg border ${config.border} ${config.bg} overflow-hidden`}>
                          <div className={`px-2.5 py-1.5 ${config.iconBg} border-b ${config.border} flex items-center gap-1.5`}>
                            <MessageSquare className={`w-3 h-3 ${config.text}`} />
                            <span className={`text-[11px] font-bold uppercase tracking-wider ${config.text}`}>
                              {transaction.type === 'withdrawal' ? 'Feedback' : 'Note'}
                            </span>
                          </div>
                          <div className="p-2.5">
                            <p className="text-xs text-white font-medium leading-relaxed break-words">
                              {remark}
                            </p>
                          </div>
                        </div>
                      ) : (
                        transaction.type === 'withdrawal' && (transaction.data as Withdrawal).status === 'pending' ? (
                          <div className="space-y-2">
                            <div className="rounded-lg border border-slate-700/40 bg-slate-800/30 p-2.5 text-center">
                              <Clock className="w-5 h-5 text-slate-500 mx-auto mb-1.5" />
                              <p className="text-[11px] text-slate-500 font-semibold">Pending Review...</p>
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCancelWithdrawal(transaction);
                              }}
                              disabled={cancellingId === id}
                              className="w-full bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 hover:border-red-500/50 text-red-400 py-2 px-3 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              <Ban className="w-3.5 h-3.5" />
                              {cancellingId === id ? 'Cancelling...' : 'Cancel Withdrawal'}
                            </button>
                          </div>
                        ) : (
                          <div className="rounded-lg border border-slate-700/40 bg-slate-800/30 p-2 text-center">
                            <p className="text-[11px] text-slate-500 italic">No {transaction.type === 'withdrawal' ? 'feedback' : 'note'} provided</p>
                          </div>
                        )
                      )}

                      {transaction.type === 'withdrawal' && (transaction.data as Withdrawal).audited_at && (
                        <div className="mt-2 pt-2 border-t border-slate-700/50">
                          <div className="flex items-center justify-center gap-1.5 text-[11px] text-slate-400">
                            <CheckCircle className="w-3 h-3 text-emerald-400" />
                            <span className="font-medium">Reviewed</span>
                            <span className="opacity-50">·</span>
                            <span>{formatDate((transaction.data as Withdrawal).audited_at!)} {formatTime((transaction.data as Withdrawal).audited_at!)}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="hidden lg:block space-y-3 max-h-[500px] overflow-y-auto pr-2 hide-scrollbar" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
              {pageItems.map((transaction) => {
                const status = getTransactionStatus(transaction);
                const config = getStatusConfig(status);
                const amount = getTransactionAmount(transaction);
                const label = getTransactionLabel(transaction);
                const remark = getTransactionRemark(transaction);
                const id = transaction.type === 'withdrawal' ? (transaction.data as Withdrawal).id : (transaction.data as WalletTransaction).id;

                return (
                  <div
                    key={`${transaction.type}-${id}`}
                    onClick={() => setSelectedTransaction(transaction)}
                    className="group relative bg-slate-800/40 backdrop-blur-sm rounded-xl border border-slate-700/50 overflow-hidden hover:border-slate-600/50 transition-all cursor-pointer hover:bg-slate-800/60"
                  >
                    <div className="absolute top-0 left-0 right-0 h-1" style={{
                      background: `linear-gradient(90deg, ${
                        status === 'approved' || status === 'adjustment_add' ? 'rgba(52, 211, 153, 0.5)' :
                        status === 'rejected' || status === 'adjustment_subtract' ? 'rgba(251, 113, 133, 0.5)' :
                        'rgba(251, 191, 36, 0.5)'
                      }, transparent)`
                    }}></div>

                    <div className="p-5">
                      <div className="grid grid-cols-12 gap-4 items-start">
                        <div className="col-span-3">
                          <div className="flex items-center gap-2.5 mb-2">
                            <div className={`p-2 rounded-lg ${config.iconBg}`}>
                              <span className={config.text}>
                                {getTransactionIcon(transaction)}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className={`w-1.5 h-1.5 rounded-full ${config.dotColor} animate-pulse`}></span>
                              <span className={`text-xs font-bold uppercase tracking-wider ${config.text}`}>
                                {label}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-slate-400">
                            <Calendar className="w-3.5 h-3.5" />
                            <div>
                              <div className="font-medium text-slate-300">{formatDate(transaction.created_at)}</div>
                              <div className="text-slate-500">{formatTime(transaction.created_at)}</div>
                            </div>
                          </div>
                        </div>

                        <div className="col-span-2 flex items-center">
                          <div>
                            <div className="text-xs text-slate-500 mb-1">Amount</div>
                            <div className="text-2xl font-black text-white tracking-tight">
                              ${Math.abs(amount).toFixed(2)}
                            </div>
                          </div>
                        </div>

                        <div className="col-span-5">
                          {remark ? (
                            <div className={`p-3 rounded-lg border ${config.border} ${config.bg}`}>
                              <div className="flex items-start gap-2">
                                <MessageSquare className={`w-4 h-4 flex-shrink-0 mt-0.5 ${config.text}`} />
                                <div className="flex-1 min-w-0">
                                  <div className={`text-[11px] font-bold uppercase tracking-wider ${config.text} mb-1.5`}>
                                    {transaction.type === 'withdrawal' ? 'Feedback' : 'Note'}
                                  </div>
                                  <p className="text-sm text-slate-200 leading-relaxed break-words">
                                    {remark}
                                  </p>
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-center h-full">
                              <span className="text-sm text-slate-600 italic">No {transaction.type === 'withdrawal' ? 'feedback' : 'note'} provided</span>
                            </div>
                          )}
                        </div>

                        <div className="col-span-2">
                          {transaction.type === 'withdrawal' && (transaction.data as Withdrawal).audited_at ? (
                            <div>
                              <div className="text-xs text-slate-500 mb-1">Reviewed</div>
                              <div className="flex items-center gap-1.5 text-xs text-slate-300">
                                <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                                <div>
                                  <div className="font-medium">{formatDate((transaction.data as Withdrawal).audited_at!)}</div>
                                  <div className="text-slate-500">{formatTime((transaction.data as Withdrawal).audited_at!)}</div>
                                </div>
                              </div>
                            </div>
                          ) : (
                            transaction.type === 'withdrawal' && (transaction.data as Withdrawal).status === 'pending' ? (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleCancelWithdrawal(transaction);
                                }}
                                disabled={cancellingId === id}
                                className="bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 hover:border-red-500/50 text-red-400 py-2 px-3 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <Ban className="w-3.5 h-3.5" />
                                {cancellingId === id ? 'Cancelling...' : 'Cancel'}
                              </button>
                            ) : transaction.type === 'wallet_transaction' ? (
                              <div className="flex items-center h-full">
                                <span className="text-sm text-slate-500 italic">Admin Adjustment</span>
                              </div>
                            ) : (
                              <div className="flex items-center h-full">
                                <span className="text-sm text-slate-600 italic">Pending review</span>
                              </div>
                            )
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-4 px-1">
                <button
                  onClick={goPrev}
                  disabled={!hasPrev}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-xs font-medium text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700/60 transition-colors"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span className="hidden sm:inline">Prev</span>
                </button>
                <span className="text-xs text-slate-400 font-medium">
                  {page + 1} / {totalPages}
                  <span className="text-slate-500 ml-1.5">({totalItems})</span>
                </span>
                <button
                  onClick={goNext}
                  disabled={!hasNext}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800/60 border border-slate-700/50 text-xs font-medium text-slate-300 disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700/60 transition-colors"
                >
                  <span className="hidden sm:inline">Next</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </>
        )}
      </div>
      </div>

      {selectedTransaction && createPortal(
        <div
          className="employee-modal-backdrop fixed inset-0 z-[10000] flex bg-black/70
          md:items-stretch md:justify-stretch md:p-0
          lg:items-stretch lg:justify-stretch lg:p-0
          xl:items-center xl:justify-center xl:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setSelectedTransaction(null);
            }
          }}
          style={{
            alignItems: isMobile ? 'stretch' : undefined,
            justifyContent: isMobile ? 'stretch' : undefined,
            padding: isMobile ? '0' : undefined,
            touchAction: 'none',
            overscrollBehavior: 'contain'
          }}
        >
          <div
            className="employee-modal-surface relative bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 w-full flex flex-col overflow-hidden
                       md:m-0 md:rounded-none md:max-w-full md:h-screen
                       xl:m-4 xl:rounded-2xl xl:max-w-3xl xl:max-h-[calc(100vh-2rem)]"
            style={{
              width: isMobile ? '100%' : undefined,
              height: isMobile ? '100dvh' : undefined,
              maxHeight: isMobile ? '100dvh' : undefined,
              margin: isMobile ? '0' : undefined,
              borderRadius: isMobile ? '0' : undefined
            }}
          >
            <div className="absolute inset-0 rounded-xl sm:rounded-2xl md:rounded-none xl:rounded-2xl overflow-hidden pointer-events-none">
              <div className="absolute inset-0 border-2 border-transparent bg-gradient-to-r from-blue-500/30 via-cyan-500/30 to-blue-500/30 bg-clip-border rounded-xl sm:rounded-2xl md:rounded-none xl:rounded-2xl"></div>
              <div className="absolute -inset-[2px] bg-gradient-to-r from-blue-500/20 via-cyan-500/20 to-blue-500/20 blur-xl animate-pulse"></div>
            </div>

            {/* Corner accents - Hidden on mobile and tablet */}
            <div className="hidden sm:block md:hidden xl:block absolute top-0 left-0 w-16 sm:w-20 h-16 sm:h-20 border-l-2 border-t-2 border-blue-500/50 rounded-tl-xl sm:rounded-tl-2xl pointer-events-none"></div>
            <div className="hidden sm:block md:hidden xl:block absolute top-0 right-0 w-16 sm:w-20 h-16 sm:h-20 border-r-2 border-t-2 border-cyan-500/50 rounded-tr-xl sm:rounded-tr-2xl pointer-events-none"></div>
            <div className="hidden sm:block md:hidden xl:block absolute bottom-0 left-0 w-16 sm:w-20 h-16 sm:h-20 border-l-2 border-b-2 border-cyan-500/50 rounded-bl-xl sm:rounded-bl-2xl pointer-events-none"></div>
            <div className="hidden sm:block md:hidden xl:block absolute bottom-0 right-0 w-16 sm:w-20 h-16 sm:h-20 border-r-2 border-b-2 border-blue-500/50 rounded-br-xl sm:rounded-br-2xl pointer-events-none"></div>

            <div
              className="relative bg-gradient-to-r from-slate-900/95 via-blue-900/20 to-slate-900/95 border-b border-blue-500/30 px-4 lg:p-6 flex items-center justify-between flex-shrink-0 backdrop-blur-sm"
              style={{
                paddingTop: isMobile ? 'calc(env(safe-area-inset-top) + 16px)' : undefined,
                paddingBottom: isMobile ? '16px' : undefined
              }}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-blue-600/5 via-cyan-500/10 to-blue-600/5"></div>
              <div
                className="flex items-center gap-3 relative z-10 px-4 sm:px-0"
              >
                <div className="relative">
                  <div className={`absolute inset-0 ${getStatusConfig(getTransactionStatus(selectedTransaction)).iconBg} rounded-xl blur-lg animate-pulse`}></div>
                  <div className={`relative w-10 h-10 sm:w-11 sm:h-11 flex items-center justify-center rounded-xl ${getStatusConfig(getTransactionStatus(selectedTransaction)).iconBg} shadow-lg border ${getStatusConfig(getTransactionStatus(selectedTransaction)).border}`}>
                    <span className={getStatusConfig(getTransactionStatus(selectedTransaction)).text}>
                      {getTransactionIcon(selectedTransaction)}
                    </span>
                  </div>
                </div>
                <div>
                  <h3 className="text-base sm:text-lg lg:text-xl font-black text-white tracking-tight bg-gradient-to-r from-white to-blue-100 bg-clip-text text-transparent">
                    {selectedTransaction.type === 'withdrawal' ? 'WITHDRAWAL DETAILS' : 'BALANCE ADJUSTMENT'}
                  </h3>
                  <div className="flex items-center gap-2 mt-0.5">
                    <div className="w-1 h-1 bg-cyan-400 rounded-full animate-pulse"></div>
                    <p className="text-xs lg:text-sm text-slate-400 font-mono">
                      ID: {selectedTransaction.type === 'withdrawal'
                        ? (selectedTransaction.data as Withdrawal).id.slice(0, 8)
                        : (selectedTransaction.data as WalletTransaction).id.slice(0, 8)
                      }
                    </p>
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSelectedTransaction(null)}
                aria-label={t.common.close}
                className="emp-close-btn relative z-10 w-9 h-9 flex items-center justify-center rounded-xl max-sm:bg-white/10 max-sm:ring-1 max-sm:ring-white/15 hover:bg-white/10 transition-colors flex-shrink-0 mr-4 sm:mr-0"
              >
                <X className="w-4 h-4 text-slate-400 hover:text-white transition-colors" />
              </button>
            </div>

            <div
              className="relative overflow-y-auto flex-1 lg:p-6 flex flex-col"
              style={{
                WebkitOverflowScrolling: 'touch',
                paddingTop: isMobile ? '16px' : '16px',
                paddingBottom: isMobile ? 'calc(env(safe-area-inset-bottom) + 16px)' : '16px',
                paddingLeft: isMobile ? '16px' : undefined,
                paddingRight: isMobile ? '16px' : undefined
              }}
            >
              <div className="space-y-4 lg:space-y-5 flex-1 flex flex-col min-h-0">
                <div className="grid grid-cols-2 gap-3 lg:gap-4 flex-shrink-0">
                  <div className="relative group">
                    <div className="absolute inset-0 bg-gradient-to-br from-emerald-500/20 to-green-500/20 rounded-xl blur-lg opacity-50 group-hover:opacity-75 transition-opacity"></div>
                    <div className="relative bg-gradient-to-br from-slate-800/90 to-slate-900/90 rounded-xl p-3 lg:p-4 border-2 border-emerald-500/30 backdrop-blur-sm">
                      <div className="flex items-center gap-2 mb-1.5 lg:mb-2">
                        <div className="p-1.5 bg-emerald-500/20 rounded-lg">
                          <DollarSign className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-400" />
                        </div>
                        <span className="text-[11px] sm:text-xs text-emerald-300 font-black uppercase tracking-wider">Amount</span>
                      </div>
                      <div className="text-2xl lg:text-3xl font-black bg-gradient-to-r from-emerald-400 to-green-300 bg-clip-text text-transparent">
                        ${Math.abs(getTransactionAmount(selectedTransaction)).toFixed(2)}
                      </div>
                      <div className="absolute top-0 right-0 w-20 h-20 bg-emerald-400/5 rounded-full blur-2xl"></div>
                    </div>
                  </div>

                  <div className="relative group">
                    <div className={`absolute inset-0 bg-gradient-to-br ${getStatusConfig(getTransactionStatus(selectedTransaction)).iconBg} rounded-xl blur-lg opacity-50 group-hover:opacity-75 transition-opacity`}></div>
                    <div className={`relative bg-gradient-to-br from-slate-800/90 to-slate-900/90 rounded-xl p-3 lg:p-4 border-2 ${getStatusConfig(getTransactionStatus(selectedTransaction)).border} backdrop-blur-sm`}>
                      <div className="flex items-center gap-2 mb-1.5 lg:mb-2">
                        <span className={`w-2 h-2 rounded-full ${getStatusConfig(getTransactionStatus(selectedTransaction)).dotColor} animate-pulse shadow-lg`}></span>
                        <span className="text-[11px] sm:text-xs text-slate-300 font-black uppercase tracking-wider">Status</span>
                      </div>
                      <div className={`text-xl lg:text-2xl font-black uppercase ${getStatusConfig(getTransactionStatus(selectedTransaction)).text}`}>
                        {getTransactionLabel(selectedTransaction)}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="relative bg-gradient-to-r from-slate-800/60 via-slate-800/80 to-slate-800/60 rounded-xl px-3 lg:px-4 py-3 lg:py-4 border border-blue-500/30 flex-shrink-0 backdrop-blur-sm">
                  <div className="absolute inset-0 bg-gradient-to-r from-blue-600/5 via-cyan-500/10 to-blue-600/5 rounded-xl"></div>
                  <div className="relative flex flex-col sm:flex-row sm:flex-wrap items-start sm:items-center gap-3 sm:gap-x-6 sm:gap-y-2">
                    <div className="flex items-center gap-2">
                      <div className="p-1.5 bg-blue-500/20 rounded-lg">
                        <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-400" />
                      </div>
                      <span className="text-[11px] sm:text-xs text-blue-300 font-black uppercase tracking-wider">
                        {selectedTransaction.type === 'withdrawal' ? 'Submitted:' : 'Adjusted:'}
                      </span>
                      <span className="text-xs sm:text-sm text-white font-semibold">
                        {formatDate(selectedTransaction.created_at)} {formatTime(selectedTransaction.created_at)}
                      </span>
                    </div>

                    {selectedTransaction.type === 'withdrawal' && (selectedTransaction.data as Withdrawal).audited_at && (
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 bg-emerald-500/20 rounded-lg">
                          <CheckCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-400" />
                        </div>
                        <span className="text-[11px] sm:text-xs text-emerald-300 font-black uppercase tracking-wider">Reviewed:</span>
                        <span className="text-xs sm:text-sm text-white font-semibold">
                          {formatDate((selectedTransaction.data as Withdrawal).audited_at!)} {formatTime((selectedTransaction.data as Withdrawal).audited_at!)}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {getTransactionRemark(selectedTransaction) ? (
                  <div className={`relative rounded-xl border-2 ${getStatusConfig(getTransactionStatus(selectedTransaction)).border} overflow-hidden flex-1 min-h-0 flex flex-col backdrop-blur-sm`}>
                    <div className={`absolute inset-0 ${getStatusConfig(getTransactionStatus(selectedTransaction)).bg} opacity-50`}></div>
                    <div className={`relative px-4 py-2.5 lg:py-3 ${getStatusConfig(getTransactionStatus(selectedTransaction)).iconBg} border-b-2 ${getStatusConfig(getTransactionStatus(selectedTransaction)).border} flex items-center gap-2 flex-shrink-0`}>
                      <div className={`p-1.5 ${getStatusConfig(getTransactionStatus(selectedTransaction)).bg} rounded-lg`}>
                        <MessageSquare className={`w-3.5 h-3.5 sm:w-4 sm:h-4 lg:w-5 lg:h-5 ${getStatusConfig(getTransactionStatus(selectedTransaction)).text}`} />
                      </div>
                      <span className={`text-xs lg:text-sm font-black uppercase tracking-wider ${getStatusConfig(getTransactionStatus(selectedTransaction)).text}`}>
                        {selectedTransaction.type === 'withdrawal' ? 'Feedback' : 'Note'}
                      </span>
                      <div className={`ml-auto w-2 h-2 rounded-full ${getStatusConfig(getTransactionStatus(selectedTransaction)).dotColor} animate-pulse`}></div>
                    </div>
                    <div className="relative p-4 lg:p-5 overflow-y-auto flex-1 bg-gradient-to-br from-slate-900/50 to-slate-800/50">
                      <p className="text-white text-sm lg:text-base leading-relaxed whitespace-pre-wrap break-words">
                        {getTransactionRemark(selectedTransaction)}
                      </p>
                    </div>
                  </div>
                ) : (
                  selectedTransaction.type === 'withdrawal' && (selectedTransaction.data as Withdrawal).status === 'pending' && (
                    <div className="relative rounded-xl border-2 border-slate-700/50 bg-gradient-to-br from-slate-800/40 to-slate-900/40 p-5 lg:p-6 text-center backdrop-blur-sm overflow-hidden">
                      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-32 bg-blue-500/10 rounded-full blur-3xl"></div>
                      <div className="relative">
                        <div className="inline-flex p-3 lg:p-4 bg-slate-800/50 rounded-full mb-3 border border-slate-700/50">
                          <Clock className="w-6 h-6 lg:w-7 lg:h-7 text-slate-400 animate-pulse" />
                        </div>
                        <p className="text-xs lg:text-sm text-slate-400 font-semibold">Awaiting admin review...</p>
                      </div>
                    </div>
                  )
                )}

                {/* Mobile Action Buttons */}
                <div className="sm:hidden flex-shrink-0 mt-4 pt-4 border-t border-slate-700/50 space-y-3" style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}>
                  {selectedTransaction.type === 'withdrawal' && (selectedTransaction.data as Withdrawal).status === 'pending' && (
                    <button
                      onClick={() => {
                        handleCancelWithdrawal(selectedTransaction);
                        setSelectedTransaction(null);
                      }}
                      disabled={cancellingId === (selectedTransaction.data as Withdrawal).id}
                      className="w-full bg-gradient-to-r from-red-500/20 to-red-600/20 active:from-red-500/30 active:to-red-600/30 border-2 border-red-500/40 text-red-400 py-3.5 px-4 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg min-h-[48px] active:scale-95 touch-manipulation"
                    >
                      <Ban className="w-4 h-4" />
                      {cancellingId === (selectedTransaction.data as Withdrawal).id ? 'Cancelling...' : 'Cancel Withdrawal Request'}
                    </button>
                  )}

                  <button
                    onClick={() => setSelectedTransaction(null)}
                    className="w-full bg-gradient-to-r from-slate-700/90 to-slate-600/90 active:from-slate-600/90 active:to-slate-500/90 border-2 border-slate-600/60 text-white py-3.5 px-4 rounded-xl text-sm font-bold transition-all shadow-lg min-h-[48px] active:scale-95 touch-manipulation"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>

            <div className="hidden sm:block relative border-t border-blue-500/30 p-3 sm:p-4 lg:p-6 space-y-2.5 sm:space-y-3 flex-shrink-0 backdrop-blur-sm safe-area-pb">
              <div className="absolute inset-0 bg-gradient-to-t from-slate-900/80 via-slate-900/40 to-transparent"></div>
              <div className="relative space-y-2.5 sm:space-y-3">
                {selectedTransaction.type === 'withdrawal' && (selectedTransaction.data as Withdrawal).status === 'pending' && (
                  <button
                    onClick={() => {
                      handleCancelWithdrawal(selectedTransaction);
                      setSelectedTransaction(null);
                    }}
                    disabled={cancellingId === (selectedTransaction.data as Withdrawal).id}
                    className="w-full bg-gradient-to-r from-red-500/20 to-red-600/20 hover:from-red-500/30 hover:to-red-600/30 border-2 border-red-500/40 hover:border-red-500/60 text-red-400 hover:text-red-300 py-3 sm:py-2.5 lg:py-3 px-4 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-red-500/20 min-h-[48px] active:scale-95"
                  >
                    <Ban className="w-4 lg:w-5 h-4 lg:h-5" />
                    {cancellingId === (selectedTransaction.data as Withdrawal).id ? 'Cancelling...' : 'Cancel Withdrawal Request'}
                  </button>
                )}

                <button
                  onClick={() => setSelectedTransaction(null)}
                  className="w-full bg-gradient-to-r from-slate-800/90 to-slate-700/90 hover:from-slate-700/90 hover:to-slate-600/90 border-2 border-slate-600/60 hover:border-slate-500/80 text-slate-200 hover:text-white py-3 sm:py-2.5 lg:py-3 px-4 rounded-xl text-sm font-bold transition-all shadow-lg min-h-[48px] active:scale-95"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
