import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Wallet as WalletIcon, DollarSign, Lock, TrendingUp, AlertCircle, CheckCircle2, Send, Clock, History, ShieldCheck, X, Loader2, ChevronRight, Check } from 'lucide-react';
import { supabase, formatSupabaseError } from '../../lib/supabase';
import { Wallet, Employee, VerificationRequest } from '../../types';
import VerificationForm from './VerificationForm';
import WithdrawalHistory from './WithdrawalHistory';
import PageLoader from './PageLoader';
import { useDeviceOptimization } from '../../lib/useDeviceOptimization';
import { useCurrencyUnit } from '../../lib/useCurrencyUnit';
import { useLanguage } from '../../lib/i18n/context';
import { createFinancialOperationId, getEmployeeFinancialSession } from '../../lib/auth';

// "Submit Withdrawal" runs the eligibility check as a short application sequence: steps 2 and 3 advance on these
// timers (step 1 shows with the card), and the result waits for both the server and WD_MIN_CHECK_MS.
const WD_STEP_AT_MS = [2250, 3300];
const WD_MIN_CHECK_MS = 4400;
const WD_RESULT_HOLD_MS = 800;
// Curtains close in 1.8s; the card finishes entering at 1150ms + 620ms.
const WD_INTRO_MS = 1850;
// Longest wd-reveal-stagger child: 0.6s delay + 0.7s animation.
const WD_REVEAL_MS = 1400;
const WD_STEP_PROGRESS = [0.32, 0.64, 0.88];

const VERIFY_TONES = {
  amber: { title: 'text-amber-800', body: 'text-amber-900/65', foot: 'text-amber-700/70', line: 'from-amber-400 via-orange-400 to-amber-300', glow: 'bg-amber-100/70', icon: 'from-amber-400 to-orange-500 shadow-orange-500/30', halo: 'ring-amber-100', mark: 'text-amber-500/[0.07]', button: 'from-amber-500 to-orange-500 shadow-orange-500/25', note: 'bg-amber-50 text-amber-900 ring-amber-200/80' },
  blue: { title: 'text-blue-800', body: 'text-blue-900/60', foot: 'text-blue-700/70', line: 'from-[#12356d] via-blue-600 to-cyan-400', glow: 'bg-blue-100/70', icon: 'from-sky-400 to-blue-600 shadow-blue-500/30', halo: 'ring-blue-100', mark: 'text-blue-500/[0.07]', button: 'from-blue-600 to-indigo-600 shadow-blue-600/25', note: 'bg-blue-50 text-blue-900 ring-blue-200/80' },
  red: { title: 'text-rose-800', body: 'text-rose-900/65', foot: 'text-rose-700/70', line: 'from-rose-500 via-red-400 to-orange-300', glow: 'bg-rose-100/70', icon: 'from-rose-500 to-red-500 shadow-rose-500/30', halo: 'ring-rose-100', mark: 'text-rose-500/[0.07]', button: 'from-rose-500 to-red-500 shadow-rose-500/25', note: 'bg-rose-50 text-rose-900 ring-rose-200/80' },
  emerald: { title: 'text-emerald-800', body: 'text-teal-900/65', foot: 'text-emerald-700/70', line: 'from-emerald-400 via-teal-400 to-cyan-400', glow: 'bg-emerald-100/60', icon: 'from-emerald-500 to-teal-500 shadow-emerald-500/30', halo: 'ring-emerald-100', mark: 'text-emerald-500/[0.07]', button: 'from-emerald-500 to-teal-500 shadow-emerald-500/25', note: 'bg-emerald-50 text-emerald-900 ring-emerald-200/80' },
};

function VerificationStatusCard({ tone, icon: Icon, title, mobileTitle, message, note, footnote, action }: {
  tone: keyof typeof VERIFY_TONES;
  icon: typeof AlertCircle;
  title: string;
  mobileTitle?: string;
  message: string;
  note?: { label: string; text: string } | null;
  footnote?: string;
  action?: { label: string; onClick: () => void };
}) {
  const { language } = useLanguage();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mobileTitleRef = useRef<HTMLSpanElement>(null);
  const s = VERIFY_TONES[tone];

  useLayoutEffect(() => {
    const heading = headingRef.current;
    const text = mobileTitleRef.current;
    if (!mobileTitle || !heading || !text) return;

    const mobile = window.matchMedia('(max-width: 639px)');
    const fitTitle = () => {
      heading.style.removeProperty('font-size');
      if (!mobile.matches || !heading.clientWidth) return;

      const rootSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const maximum = rootSize * 0.84375;
      const minimum = rootSize * 0.71875;
      heading.style.fontSize = `${maximum}px`;
      text.style.whiteSpace = 'nowrap';
      const textWidth = text.getBoundingClientRect().width;
      if (textWidth > heading.clientWidth) {
        heading.style.fontSize = `${Math.max(minimum, maximum * (heading.clientWidth - 1) / textWidth)}px`;
      }
      text.style.removeProperty('white-space');
    };

    fitTitle();
    const observer = new ResizeObserver(fitTitle);
    observer.observe(heading);
    mobile.addEventListener('change', fitTitle);
    document.fonts.addEventListener('loadingdone', fitTitle);
    return () => {
      observer.disconnect();
      mobile.removeEventListener('change', fitTitle);
      document.fonts.removeEventListener('loadingdone', fitTitle);
      heading.style.removeProperty('font-size');
    };
  }, [mobileTitle]);
  return (
    <div lang={language} className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white via-white to-slate-50/80 shadow-[0_12px_32px_-24px_rgba(15,40,90,0.45)] [container-type:inline-size]">
      <span className={`pointer-events-none absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r ${s.line}`} aria-hidden="true" />
      <span className={`pointer-events-none absolute -left-10 -top-12 h-32 w-32 rounded-full blur-2xl ${s.glow}`} aria-hidden="true" />
      <ShieldCheck className={`pointer-events-none absolute -bottom-4 right-2 h-[90px] w-[90px] sm:-bottom-6 sm:right-3 sm:h-28 sm:w-28 ${s.mark}`} strokeWidth={1.4} aria-hidden="true" />
      <div className="relative flex flex-col gap-3 px-3.5 pb-3.5 pt-4 sm:flex-row sm:items-center sm:gap-5 sm:px-5 sm:pb-4 sm:pt-[18px]">
        <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center sm:gap-4">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md ring-4 sm:h-11 sm:w-11 ${s.icon} ${s.halo}`}>
            <Icon className="h-[18px] w-[18px] sm:h-5 sm:w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 ref={headingRef} className={`hyphens-none text-[clamp(0.75rem,4cqi,0.84375rem)] font-bold leading-snug tracking-tight [overflow-wrap:anywhere] sm:text-[15px] ${s.title}`}>
              {mobileTitle ? <><span ref={mobileTitleRef} className="sm:hidden">{mobileTitle}</span><span className="hidden sm:inline">{title}</span></> : title}
            </h3>
            <p className={`mt-1 hyphens-none text-[clamp(0.71875rem,4cqi,0.78125rem)] leading-[1.75] [overflow-wrap:anywhere] [text-wrap:pretty] sm:mt-0.5 sm:text-[13px] sm:leading-[1.55] ${s.body}`}>{message}</p>
            {note && (
              <div className={`mt-2 rounded-lg px-3 py-1.5 ring-1 ${s.note}`}>
                <p className="text-[11px] font-semibold opacity-75">{note.label}</p>
                <p className="mt-0.5 text-[12px] leading-snug sm:text-[13px]">{note.text}</p>
              </div>
            )}
            {footnote && <p className={`mt-1.5 text-[11px] sm:text-xs ${s.foot}`}>{footnote}</p>}
          </div>
        </div>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className={`flex min-h-[40px] w-full shrink-0 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r px-5 text-[13px] font-bold text-white shadow-md transition-all hover:brightness-105 active:scale-[0.98] sm:w-auto ${s.button}`}
          >
            {action.label}
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

const NOTICE_TONES = {
  success: {
    card: 'border-emerald-200/80 from-white via-emerald-50/40 to-teal-50/60',
    line: 'from-emerald-400 via-teal-400 to-cyan-400',
    glow: 'bg-emerald-200/40',
    icon: 'from-emerald-500 to-teal-500 shadow-emerald-500/30 ring-emerald-100',
    text: 'text-emerald-900/80',
  },
  error: {
    card: 'border-rose-200/80 from-white via-rose-50/40 to-orange-50/50',
    line: 'from-rose-500 via-red-400 to-orange-300',
    glow: 'bg-rose-200/40',
    icon: 'from-rose-500 to-red-500 shadow-rose-500/30 ring-rose-100',
    text: 'text-rose-900/80',
  },
};

function WithdrawalNotice({ type, text }: { type: keyof typeof NOTICE_TONES; text: string }) {
  const { language } = useLanguage();
  const s = NOTICE_TONES[type];
  const Icon = type === 'success' ? CheckCircle2 : AlertCircle;
  return (
    <div
      role={type === 'error' ? 'alert' : 'status'}
      className={`relative overflow-hidden rounded-xl border bg-gradient-to-br shadow-[0_10px_28px_-20px_rgba(15,40,90,0.45)] [container-type:inline-size] sm:rounded-2xl ${s.card}`}
    >
      <span className={`pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b ${s.line}`} aria-hidden="true" />
      <span className={`pointer-events-none absolute -left-8 -top-10 h-24 w-24 rounded-full blur-2xl ${s.glow}`} aria-hidden="true" />
      <div className="relative flex items-start gap-3 px-4 py-3 sm:items-center sm:gap-3.5 sm:px-4 sm:py-3">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-md ring-4 sm:h-9 sm:w-9 sm:rounded-xl ${s.icon}`}>
          <Icon className="h-4 w-4 sm:h-[18px] sm:w-[18px]" strokeWidth={2.4} aria-hidden="true" />
        </span>
        <p lang={language} className={`min-w-0 flex-1 self-center hyphens-none text-left text-[clamp(0.71875rem,4cqi,0.78125rem)] font-medium leading-[1.75] [overflow-wrap:anywhere] [text-wrap:pretty] sm:text-[13px] sm:leading-[1.55] ${s.text}`}>{text}</p>
      </div>
    </div>
  );
}

interface WalletOverviewProps {
  employeeId: string;
  employee: Employee;
  onWithdrawalHistoryChange?: (show: boolean) => void;
}

export default function WalletOverview({ employeeId, employee, onWithdrawalHistoryChange }: WalletOverviewProps) {
  const { t, dateLocale, language } = useLanguage();
  const currencyUnit = useCurrencyUnit(employee.created_by);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showWithdrawalForm, setShowWithdrawalForm] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showVerificationForm, setShowVerificationForm] = useState(false);
  const [showWithdrawalHistory, setShowWithdrawalHistory] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [messageLeaving, setMessageLeaving] = useState(false);
  const messageWrapRef = useRef<HTMLDivElement>(null);
  const [localEmployee, setLocalEmployee] = useState(employee);
  const [verificationRequest, setVerificationRequest] = useState<VerificationRequest | null>(null);
  const [checkingEligibility, setCheckingEligibility] = useState(false);
  const [eligibilityOverlayLeaving, setEligibilityOverlayLeaving] = useState(false);
  const contentInnerRef = useRef<HTMLDivElement>(null);
  const withdrawPanelRef = useRef<HTMLDivElement>(null);
  const [curtainHeight, setCurtainHeight] = useState<number | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [contentResizing, setContentResizing] = useState(false);
  const resizeArmedRef = useRef(false);
  const [contentRevealActive, setContentRevealActive] = useState(false);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [eligibilityStep, setEligibilityStep] = useState(0);
  const [eligibilityOutcome, setEligibilityOutcome] = useState<'passed' | 'blocked' | null>(null);
  // Once the curtains and card are in, drop their intro animations: CSS animations restart whenever the Wallet
  // tab is shown again, so leaving them on would replay the closing curtains after a tab switch mid-check.
  const [eligibilityIntroDone, setEligibilityIntroDone] = useState(false);
  const { deviceType } = useDeviceOptimization();
  const loadWalletRef = useRef<(() => Promise<void>) | null>(null);
  const loadEmployeeDataRef = useRef<(() => Promise<void>) | null>(null);
  const loadVerificationRequestRef = useRef<(() => Promise<void>) | null>(null);
  const withdrawalOperationIdRef = useRef<string | null>(null);

  const isTabletDevice = deviceType === 'tablet';

  // Dynamic font size calculation for tablet to prevent overflow
  const getTabletFontSize = (amount: number) => {
    const formattedValue = amount.toFixed(2);
    const length = formattedValue.length;

    // Base size for tablet
    let fontSize = '1.5rem'; // 24px base

    if (length <= 6) {
      fontSize = '1.5rem'; // 24px
    } else if (length <= 8) {
      fontSize = '1.25rem'; // 20px
    } else if (length <= 10) {
      fontSize = '1.125rem'; // 18px
    } else {
      fontSize = '1rem'; // 16px
    }

    return fontSize;
  };

  useEffect(() => {
    void loadWalletRef.current?.();
    void loadEmployeeDataRef.current?.();
    void loadVerificationRequestRef.current?.();

    // Set up real-time subscription for employee verification status changes
    const userChannel = supabase
      .channel(`user-verification-${employeeId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'users', filter: `id=eq.${employeeId}` },
        (payload) => {
          console.log('Employee data changed:', payload);
          if (payload.new) {
            setLocalEmployee(payload.new as Employee);
          }
        }
      )
      .subscribe();

    // Set up real-time subscription for verification request changes
    const verificationChannel = supabase
      .channel(`verification-request-${employeeId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'verification_requests', filter: `user_id=eq.${employeeId}` },
        (payload) => {
          console.log('Verification request changed:', payload);
          // If verification request was deleted, set to null
          if (payload.eventType === 'DELETE') {
            setVerificationRequest(null);
          } else {
            void loadVerificationRequestRef.current?.();
          }
        }
      )
      .subscribe();

    // Set up real-time subscription for wallet changes
    const walletChannel = supabase
      .channel(`wallet-${employeeId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'wallets', filter: `user_id=eq.${employeeId}` },
        (payload) => {
          console.log('Wallet changed:', payload);
          if (payload.new) {
            setWallet(payload.new as Wallet);
          }
        }
      )
      .subscribe();

    // Listen for new wallet transactions (tips, commissions, admin adjustments)
    // This provides a second signal to refresh wallet data immediately
    const txChannel = supabase
      .channel(`wallet-tx-${employeeId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'wallet_transactions', filter: `user_id=eq.${employeeId}` },
        () => {
          void loadWalletRef.current?.();
        }
      )
      .subscribe();

    // Fallback polling for redundancy
    const interval = setInterval(() => {
      void loadWalletRef.current?.();
    void loadEmployeeDataRef.current?.();
    void loadVerificationRequestRef.current?.();
    }, 15000);

    return () => {
      supabase.removeChannel(userChannel);
      supabase.removeChannel(verificationChannel);
      supabase.removeChannel(walletChannel);
      supabase.removeChannel(txChannel);
      clearInterval(interval);
    };
  }, [employeeId]);

  useLayoutEffect(() => {
    const el = messageWrapRef.current;
    if (!el) return;
    if (!messageLeaving) {
      el.style.height = '';
      return;
    }
    el.style.height = `${el.offsetHeight}px`;
    void el.offsetHeight;
    el.style.height = '0px';
  }, [messageLeaving]);

  useEffect(() => {
    if (!messageLeaving) return;
    const timer = setTimeout(() => {
      setMessage(null);
      setMessageLeaving(false);
      setContentResizing(false);
    }, 520);
    return () => clearTimeout(timer);
  }, [messageLeaving]);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessageLeaving(true), message.type === 'error' ? 8000 : 4000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  useLayoutEffect(() => {
    if (!showConfirmModal) return;

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
  }, [showConfirmModal]);

  useLayoutEffect(() => {
    const inner = contentInnerRef.current;
    if (!inner) return;
    let frame = 0;
    let lastHeight = inner.offsetHeight;
    let wasHidden = false;
    setContentHeight(lastHeight);
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextHeight = inner.offsetHeight;
        // The Wallet tab is display:none while another tab shows and measures 0. Keep the last height, so coming
        // back neither animates the panel open from 0 nor animates changes that happened while it was hidden.
        if (nextHeight === 0) {
          wasHidden = true;
          setContentResizing(false);
          return;
        }
        if (nextHeight === lastHeight) {
          wasHidden = false;
          return;
        }
        lastHeight = nextHeight;
        if (resizeArmedRef.current && !wasHidden) setContentResizing(true);
        wasHidden = false;
        setContentHeight(nextHeight);
      });
    });
    observer.observe(inner);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [loading]);

  const loadEmployeeData = async () => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('id, username, employee_id, is_verified, is_active, total_income, first_success_order_date, created_by, remarks, tags, is_pinned, current_session_token, session_created_at, last_heartbeat_at, current_tab_id, created_at, updated_at')
        .eq('id', employeeId)
        .single();

      if (error) throw error;
      if (data) {
        setLocalEmployee(data);
      }
    } catch (error) {
      console.error('Error loading employee data:', formatSupabaseError(error));
    }
  };

  const loadVerificationRequest = async () => {
    try {
      const { data, error } = await supabase
        .from('verification_requests')
        .select('*')
        .eq('user_id', employeeId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;
      setVerificationRequest(data);
    } catch (error) {
      console.error('Error loading verification request:', formatSupabaseError(error));
    }
  };

  const loadWallet = async () => {
    try {
      const walletResult = await supabase
        .from('wallets')
        .select('*')
        .eq('user_id', employeeId)
        .maybeSingle();
      const walletData = walletResult.data;
      if (walletResult.error) throw walletResult.error;
      if (!walletData) throw new Error('Employee wallet was not found.');

      setWallet(walletData);
    } catch (error) {
      console.error('Error loading wallet:', formatSupabaseError(error));
    } finally {
      setLoading(false);
    }
  };
  loadWalletRef.current = loadWallet;
  loadEmployeeDataRef.current = loadEmployeeData;
  loadVerificationRequestRef.current = loadVerificationRequest;

  const handleVerificationComplete = () => {
    setShowVerificationForm(false);
    loadEmployeeData();
    loadVerificationRequest();
  };

  useEffect(() => {
    if (verificationRequest?.status === 'rejected') {
      setShowVerificationForm(false);
    }
  }, [verificationRequest]);

  const isExpectedWithdrawalRejection = (error: unknown) => {
    const normalized = formatSupabaseError(error).toLowerCase();
    return normalized.includes('pending withdrawal already exists')
      || normalized.includes('session is invalid or expired')
      || normalized.includes('insufficient available balance')
      || normalized.includes('eligibility requirements are not met');
  };

  const describeWithdrawalError = (error: unknown, fallback?: string) => {
    const raw = formatSupabaseError(error);
    const normalized = raw.toLowerCase();
    if (normalized.includes('pending withdrawal already exists')) return t.wallet.pendingWithdrawalExists;
    if (normalized.includes('session is invalid or expired')) return t.wallet.withdrawalSessionExpired;
    if (normalized.includes('insufficient available balance')) return t.wallet.insufficientBalanceError;
    if (normalized.includes('eligibility requirements are not met')) return t.wallet.withdrawalRequirementsNotMet;
    const message = error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string'
      ? ((error as { message: string }).message.trim() || null)
      : null;
    return fallback ?? t.wallet.withdrawalRequestFailed(message || (raw.startsWith('Unknown') ? t.wallet.unknownError : raw));
  };

  const checkWithdrawalEligibility = async () => {
    const { data: pendingWithdrawals, error: pendingError } = await supabase
      .from('withdrawals')
      .select('id')
      .eq('user_id', employeeId)
      .eq('status', 'pending')
      .limit(1);
    if (pendingError) throw pendingError;
    if (pendingWithdrawals && pendingWithdrawals.length > 0) {
      return { eligible: false, message: t.wallet.pendingWithdrawalExists };
    }

    const financialSession = getEmployeeFinancialSession();
    const { data: policy, error } = await supabase.rpc('get_employee_withdrawal_policy_secure', {
      p_user_id: employeeId,
      p_session_token: financialSession.token,
      p_tab_id: financialSession.tabId,
    });
    if (error) throw error;
    if (!policy) throw new Error(t.wallet.eligibilityFailed);
    if (!policy.available) {
      return { eligible: false, message: policy.message || t.wallet.eligibilityFailed };
    }
    if (!policy.verified) return { eligible: false, message: t.wallet.verificationNeeded };
    if (!policy.available_balance || policy.available_balance <= 0) {
      return { eligible: false, message: t.wallet.insufficientBalance };
    }
    if (policy.amount_threshold === undefined || policy.orders_threshold === undefined ||
        policy.completed_orders_count === undefined || !policy.condition_mode) {
      throw new Error(t.wallet.eligibilityFailed);
    }

    const amountThreshold = policy.amount_threshold;
    const ordersThreshold = policy.orders_threshold;
    const completedOrdersCount = policy.completed_orders_count;
    const availableBalance = policy.available_balance;
    const amountMet = availableBalance >= amountThreshold;
    const ordersMet = completedOrdersCount >= ordersThreshold;
    const conditionMode = policy.condition_mode.toUpperCase();

    let eligible = false;
    let message = '';

    switch (conditionMode) {
      case 'AMOUNT_ONLY':
        eligible = amountMet;
        if (!eligible) {
          message = t.wallet.eligibilityAmountOnly(String(amountThreshold), availableBalance.toFixed(2));
        }
        break;

      case 'DAYS_ONLY':
        eligible = ordersMet;
        if (!eligible) {
          message = t.wallet.eligibilityDaysOnly(ordersThreshold, completedOrdersCount);
        }
        break;

      case 'AND':
      case 'BOTH':
        eligible = amountMet && ordersMet;
        if (!eligible) {
          const reasons = [];
          if (!amountMet) {
            reasons.push(t.wallet.eligibilityBalanceReason(String(amountThreshold), availableBalance.toFixed(2)));
          }
          if (!ordersMet) {
            reasons.push(t.wallet.eligibilityOrdersReason(ordersThreshold, completedOrdersCount));
          }
          message = t.wallet.eligibilityBothPrefix + reasons.join(t.wallet.eligibilityAnd);
        }
        break;

      case 'OR':
      case 'EITHER':
      default:
        eligible = amountMet || ordersMet;
        if (!eligible) {
          message = t.wallet.eligibilityEitherPrefix + t.wallet.eligibilityBalanceReason(String(amountThreshold), availableBalance.toFixed(2)) + t.wallet.eligibilityOr + t.wallet.eligibilityOrdersReason(ordersThreshold, completedOrdersCount);
        }
        break;
    }

    return { eligible: policy.eligible === true, message: policy.eligible ? '' : message || t.wallet.eligibilityFailed };
  };

  // Pin curtain artwork to the panel's settled height so later resizes don't stretch it.
  useLayoutEffect(() => {
    if (!checkingEligibility) {
      setCurtainHeight(null);
      return;
    }
    const panel = withdrawPanelRef.current;
    const inner = contentInnerRef.current;
    const wrapper = inner?.parentElement;
    if (!panel || !inner || !wrapper) return;
    // The previous result message is collapsing; counting it would centre the card below the settled panel.
    const leavingMessageHeight = messageWrapRef.current?.offsetHeight ?? 0;
    setCurtainHeight(panel.offsetHeight - wrapper.offsetHeight + inner.offsetHeight - leavingMessageHeight);
  }, [checkingEligibility]);

  // One-shot: left on, the reveal would replay every time the Wallet tab is shown again.
  const playContentReveal = () => {
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
    setContentRevealActive(true);
    revealTimerRef.current = setTimeout(() => setContentRevealActive(false), WD_REVEAL_MS);
  };

  useEffect(() => () => {
    if (revealTimerRef.current) clearTimeout(revealTimerRef.current);
  }, []);

  const handleRequestWithdrawal = async () => {
    if (checkingEligibility) return;
    resizeArmedRef.current = true;
    if (message) setMessageLeaving(true);
    setEligibilityOverlayLeaving(false);
    setEligibilityStep(0);
    setEligibilityOutcome(null);
    setEligibilityIntroDone(false);
    setCheckingEligibility(true);

    const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const stepTimers = [
      ...WD_STEP_AT_MS.map((at, index) => setTimeout(() => setEligibilityStep(index + 1), at)),
      setTimeout(() => setEligibilityIntroDone(true), WD_INTRO_MS),
    ];
    let nextMessage: { type: 'success' | 'error'; text: string } | null = null;
    let openForm = false;

    try {
      // Keep the overlay up long enough to read as a deliberate step, even on fast networks.
      const [eligibility] = await Promise.all([checkWithdrawalEligibility(), wait(WD_MIN_CHECK_MS)]);
      if (eligibility.eligible) {
        openForm = true;
      } else {
        nextMessage = { type: 'error', text: eligibility.message };
      }
    } catch (error) {
      if (!isExpectedWithdrawalRejection(error)) {
        console.error('Error in handleRequestWithdrawal:', formatSupabaseError(error));
      }
      nextMessage = { type: 'error', text: describeWithdrawalError(error, t.wallet.eligibilityFailed) };
    }

    // The result only shows once the server has answered; hold it briefly before the curtains open.
    stepTimers.forEach(clearTimeout);
    setEligibilityStep(WD_STEP_AT_MS.length + 1);
    setEligibilityOutcome(openForm ? 'passed' : 'blocked');
    await wait(WD_RESULT_HOLD_MS);

    if (openForm) setShowWithdrawalForm(true);
    if (nextMessage) setMessage(nextMessage);
    playContentReveal();
    setEligibilityOverlayLeaving(true);
    await wait(1780);
    setCheckingEligibility(false);
    setEligibilityOverlayLeaving(false);
  };

  const handleConfirmWithdrawal = async () => {
    if (submitting) return;

    console.log('handleConfirmWithdrawal called');
    setMessage(null);
    setSubmitting(true);

    try {
      // Re-check eligibility to prevent race conditions
      const eligibility = await checkWithdrawalEligibility();
      console.log('Final eligibility check:', eligibility);

      if (!eligibility.eligible) {
        setMessage({ type: 'error', text: eligibility.message });
        setShowConfirmModal(false);
        setShowWithdrawalForm(false);
        playContentReveal();
        setSubmitting(false);
        return;
      }

      if (!wallet || wallet.available_balance <= 0) {
        setMessage({ type: 'error', text: t.wallet.insufficientBalanceError });
        setShowConfirmModal(false);
        setShowWithdrawalForm(false);
        playContentReveal();
        setSubmitting(false);
        return;
      }

      const financialSession = getEmployeeFinancialSession();
      withdrawalOperationIdRef.current ||= createFinancialOperationId();
      const { data: result, error: withdrawalError } = await supabase.rpc(
        'request_employee_withdrawal',
        {
          p_user_id: employeeId,
          p_session_token: financialSession.token,
          p_tab_id: financialSession.tabId,
          p_operation_id: withdrawalOperationIdRef.current,
        },
      );

      if (withdrawalError) throw withdrawalError;
      if (!result?.success) {
        throw new Error(result?.error || t.wallet.eligibilityFailed);
      }

      withdrawalOperationIdRef.current = null;
      setMessage({ type: 'success', text: t.wallet.withdrawalSuccess });
      setShowConfirmModal(false);

      // Reset form after short delay to show success message
      setTimeout(() => {
        setShowWithdrawalForm(false);
        playContentReveal();
      }, 3000);

      loadWallet();
    } catch (error: unknown) {
      if (!isExpectedWithdrawalRejection(error)) {
        console.error('Error in handleConfirmWithdrawal:', formatSupabaseError(error));
      }
      withdrawalOperationIdRef.current = null;
      setMessage({ type: 'error', text: describeWithdrawalError(error) });
      setShowConfirmModal(false);
      setShowWithdrawalForm(false);
      playContentReveal();
      loadWallet();
    } finally {
      setSubmitting(false);
    }
  };

  const buttonLoading = checkingEligibility && !eligibilityOverlayLeaving;

  const dollarBlocks = (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {/* Tiled in px rows so a growing panel reveals more blocks instead of stretching them */}
      {[0, 1, 2, 3].flatMap((row) => {
        const tile = curtainHeight ?? 170;
        const mirrored = row % 2 === 1;
        return [
          { left: 5, top: 0.1, size: 46, rot: -12 },
          { left: 80, top: 0.07, size: 58, rot: 14 },
          { left: 12, top: 0.64, size: 38, rot: 10 },
          { left: 86, top: 0.6, size: 42, rot: -8 },
          { left: 44, top: 0.8, size: 32, rot: 18 },
          { left: 62, top: 0.24, size: 28, rot: -16 },
          { left: 28, top: 0.3, size: 24, rot: 8 },
        ].map((block, index) => {
          const rot = mirrored ? -block.rot : block.rot;
          const order = row * 7 + index;
          return (
            <div
              key={order}
              className="keep-animation absolute flex items-center justify-center rounded-xl bg-white/[0.12] font-bold text-white/45 ring-1 ring-white/20"
              style={{
                left: mirrored ? `calc(${100 - block.left}% - ${block.size}px)` : `${block.left}%`,
                top: Math.round(row * tile + block.top * tile),
                width: block.size,
                height: block.size,
                fontSize: Math.round(block.size * 0.5),
                ['--wd-rot' as string]: `${rot}deg`,
                transform: `rotate(${rot}deg)`,
                animation: `wd-dollar-float ${2.8 + (index % 3) * 0.5}s ease-in-out ${(order % 7) * 0.25}s infinite alternate`,
              }}
            >
              $
            </div>
          );
        });
      })}
    </div>
  );

  if (loading) {
    return (
      <PageLoader />
    );
  }

  const totalAssets = (wallet?.available_balance || 0) + (wallet?.frozen_balance || 0);

  return (
    <div className="space-y-4 sm:space-y-6">
      {!localEmployee.is_verified && showVerificationForm && (
        <VerificationForm
          employeeId={employeeId}
          onVerificationComplete={handleVerificationComplete}
          onClose={() => setShowVerificationForm(false)}
          existingRequest={verificationRequest?.status === 'rejected' ? {
            id: verificationRequest.id,
            real_name: verificationRequest.real_name,
            wallet_address: verificationRequest.wallet_address,
            phone: verificationRequest.phone,
            email: verificationRequest.email,
          } : null}
        />
      )}

      {localEmployee.is_verified && (
        <VerificationStatusCard tone="emerald" icon={ShieldCheck} title={t.wallet.verificationComplete} mobileTitle={t.wallet.verificationCompleteMobile} message={t.wallet.verificationMotivation} />
      )}

      {!localEmployee.is_verified && verificationRequest?.status === 'pending' && !verificationRequest.audited_at && (
        <VerificationStatusCard
          tone="blue"
          icon={Clock}
          title={t.wallet.verificationUnderReview}
          message={t.wallet.verificationReviewMsg}
          footnote={`${t.wallet.submitted}: ${new Date(verificationRequest.created_at).toLocaleString(dateLocale)}`}
        />
      )}

      {!localEmployee.is_verified && verificationRequest?.status === 'pending' && verificationRequest.audited_at && (
        <VerificationStatusCard
          tone="amber"
          icon={AlertCircle}
          title={t.wallet.verificationReset}
          message={t.wallet.verificationResetMsg}
          note={verificationRequest.audit_remark ? { label: t.wallet.previousNote, text: verificationRequest.audit_remark } : null}
          action={{ label: t.wallet.resubmitVerification, onClick: () => setShowVerificationForm(true) }}
        />
      )}

      {!localEmployee.is_verified && verificationRequest?.status === 'rejected' && (
        <VerificationStatusCard
          tone="red"
          icon={AlertCircle}
          title={t.wallet.verificationRejected}
          message={t.wallet.verificationRejectedMsg}
          note={verificationRequest.audit_remark ? { label: t.wallet.rejectionReason, text: verificationRequest.audit_remark } : null}
          action={{ label: t.wallet.supplementResubmit, onClick: () => setShowVerificationForm(true) }}
        />
      )}

      {!localEmployee.is_verified && !verificationRequest && (
        <VerificationStatusCard
          tone="amber"
          icon={ShieldCheck}
          title={t.wallet.verificationRequired}
          message={t.wallet.verificationRequiredMsg}
          action={{ label: t.wallet.startVerification, onClick: () => setShowVerificationForm(true) }}
        />
      )}

      <style>{`
        @keyframes gradientShift {
          0%, 100% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
        }

        @keyframes floatParticle {
          0% {
            transform: translate(0, 0) scale(0);
            opacity: 0;
          }
          20% { opacity: 1; }
          80% { opacity: 1; }
          100% {
            transform: translate(var(--tx), var(--ty)) scale(1);
            opacity: 0;
          }
        }

        @keyframes bounceIn {
          0% {
            transform: scale(0) translateY(50px);
            opacity: 0;
          }
          60% {
            transform: scale(1.1) translateY(0);
            opacity: 1;
          }
          100% {
            transform: scale(1) translateY(0);
            opacity: 1;
          }
        }

        @keyframes coinDrop {
          0%, 100% {
            transform: translateY(0) rotate(0deg);
          }
          50% {
            transform: translateY(8px) rotate(180deg);
          }
        }

        @keyframes scaleUp {
          0% {
            transform: scaleX(0);
            opacity: 0;
          }
          100% {
            transform: scaleX(1);
            opacity: 1;
          }
        }

        @keyframes twinkle {
          0%, 100% {
            opacity: 0.3;
            transform: scale(1);
          }
          50% {
            opacity: 1;
            transform: scale(1.5);
          }
        }

        @keyframes secureFlash {
          0%, 100% {
            opacity: 0.4;
            transform: scale(1);
          }
          50% {
            opacity: 1;
            transform: scale(1.3);
          }
        }

        @keyframes successGlow {
          0%, 100% {
            opacity: 0.5;
            transform: scale(1);
          }
          50% {
            opacity: 1;
            transform: scale(1.4);
          }
        }

        @keyframes twinkleGold {
          0%, 100% {
            opacity: 0.4;
            transform: scale(1);
          }
          50% {
            opacity: 1;
            transform: scale(1.5);
          }
        }

        @keyframes coinFloat {
          0%, 100% {
            transform: translateY(0) rotate(0deg);
          }
          50% {
            transform: translateY(-10px) rotate(180deg);
          }
        }

        @keyframes flyCoins {
          0% {
            transform: translateX(0) translateY(0) rotate(0deg);
            opacity: 0;
          }
          20% {
            opacity: 0.8;
          }
          80% {
            opacity: 0.8;
          }
          100% {
            transform: translateX(calc(100vw - 100%)) translateY(-30px) rotate(720deg);
            opacity: 0;
          }
        }

        @keyframes miniCoinOrbit {
          0%, 100% {
            transform: translate(0, 0) scale(1);
            opacity: 0.6;
          }
          50% {
            transform: translate(-8px, -8px) scale(1.2);
            opacity: 1;
          }
        }

        @keyframes glowPulse {
          0%, 100% {
            opacity: 0.5;
            filter: blur(8px);
          }
          50% {
            opacity: 1;
            filter: blur(12px);
          }
        }

        @keyframes ripple {
          0% {
            transform: scale(0.8);
            opacity: 1;
          }
          100% {
            transform: scale(2);
            opacity: 0;
          }
        }

        @keyframes rotate3d {
          from { transform: rotateY(0deg) rotateX(5deg); }
          to { transform: rotateY(360deg) rotateX(5deg); }
        }

        @keyframes circuitFlow {
          0% {
            background-position: 0% 0%;
            opacity: 0.2;
          }
          50% {
            opacity: 0.4;
          }
          100% {
            background-position: 100% 100%;
            opacity: 0.2;
          }
        }

        @keyframes hexPulse {
          0%, 100% {
            opacity: 0.05;
            transform: scale(1);
          }
          50% {
            opacity: 0.15;
            transform: scale(1.05);
          }
        }

        @keyframes dataFlow {
          0% {
            transform: translateY(-100%);
            opacity: 0;
          }
          10% {
            opacity: 0.6;
          }
          90% {
            opacity: 0.6;
          }
          100% {
            transform: translateY(200%);
            opacity: 0;
          }
        }

        @keyframes orbFloat {
          0%, 100% {
            transform: translate(0, 0) scale(1);
          }
          33% {
            transform: translate(10px, -10px) scale(1.1);
          }
          66% {
            transform: translate(-10px, 10px) scale(0.9);
          }
        }

        @keyframes nodePulse {
          0%, 100% {
            transform: scale(1);
            box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7);
          }
          50% {
            transform: scale(1.2);
            box-shadow: 0 0 0 8px rgba(59, 130, 246, 0);
          }
        }

        @keyframes lineFlow {
          0% {
            stroke-dashoffset: 1000;
            opacity: 0.2;
          }
          50% {
            opacity: 0.8;
          }
          100% {
            stroke-dashoffset: 0;
            opacity: 0.2;
          }
        }

        @keyframes scanMove {
          0% {
            top: -100%;
            opacity: 0;
          }
          10% {
            opacity: 0.6;
          }
          90% {
            opacity: 0.6;
          }
          100% {
            top: 200%;
            opacity: 0;
          }
        }

        .crypto-card {
          position: relative;
          overflow: hidden;
          border: 1px solid rgba(255, 255, 255, 0.1);
          transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .crypto-card:hover {
          transform: translateY(-4px) scale(1.02);
          border-color: rgba(255, 255, 255, 0.2);
        }

        .crypto-card::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: inherit;
          filter: brightness(1.1);
          opacity: 0;
          transition: opacity 0.4s ease;
        }

        .crypto-card:hover::before {
          opacity: 1;
        }

        .card-blue {
          background: linear-gradient(135deg,
            rgba(99, 102, 241, 0.15) 0%,
            rgba(59, 130, 246, 0.1) 50%,
            rgba(14, 165, 233, 0.15) 100%);
          background-size: 200% 200%;
          animation: gradientShift 8s ease infinite;
        }

        .card-green {
          background: linear-gradient(135deg,
            rgba(16, 185, 129, 0.15) 0%,
            rgba(5, 150, 105, 0.1) 50%,
            rgba(6, 182, 212, 0.15) 100%);
          background-size: 200% 200%;
          animation: gradientShift 8s ease infinite;
          animation-delay: 2s;
        }

        .card-orange {
          background: linear-gradient(135deg,
            rgba(251, 146, 60, 0.15) 0%,
            rgba(249, 115, 22, 0.1) 50%,
            rgba(234, 88, 12, 0.15) 100%);
          background-size: 200% 200%;
          animation: gradientShift 8s ease infinite;
          animation-delay: 4s;
        }

        .card-purple {
          background: linear-gradient(135deg,
            rgba(168, 85, 247, 0.15) 0%,
            rgba(147, 51, 234, 0.1) 50%,
            rgba(126, 34, 206, 0.15) 100%);
          background-size: 200% 200%;
          animation: gradientShift 8s ease infinite;
          animation-delay: 6s;
        }

        .glow-orb {
          position: absolute;
          border-radius: 50%;
          animation: glowPulse 3s ease-in-out infinite;
          pointer-events: none;
        }

        .particle {
          position: absolute;
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: currentColor;
          animation: floatParticle 4s ease-in-out infinite;
          pointer-events: none;
        }

        .ripple-effect {
          position: absolute;
          border-radius: 50%;
          border: 2px solid currentColor;
          animation: ripple 3s ease-out infinite;
          pointer-events: none;
        }

        .mesh-gradient {
          position: absolute;
          inset: -50%;
          opacity: 0.3;
          filter: blur(40px);
          background: radial-gradient(circle at center, currentColor 0%, transparent 70%);
          animation: rotate3d 20s linear infinite;
          pointer-events: none;
        }

        .icon-glow {
          filter: drop-shadow(0 0 8px currentColor);
        }

        .number-glow {
          text-shadow: 0 0 20px currentColor, 0 0 40px currentColor;
        }

        .glass-panel {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.05);
        }

        /* Withdraw Funds Panel Styles */
        .withdraw-funds-panel {
          position: relative;
        }

        .blockchain-circuit {
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(90deg, rgba(6, 182, 212, 0.12) 1px, transparent 1px),
            linear-gradient(rgba(6, 182, 212, 0.12) 1px, transparent 1px),
            linear-gradient(90deg, rgba(14, 165, 233, 0.08) 1px, transparent 1px),
            linear-gradient(rgba(14, 165, 233, 0.08) 1px, transparent 1px);
          background-size: 40px 40px, 40px 40px, 8px 8px, 8px 8px;
          animation: circuitFlow 15s linear infinite;
          pointer-events: none;
          z-index: 0;
        }

        .hex-grid {
          position: absolute;
          inset: 0;
          background-image:
            radial-gradient(circle, rgba(59, 130, 246, 0.1) 1px, transparent 1px);
          background-size: 30px 30px;
          animation: hexPulse 4s ease-in-out infinite;
          pointer-events: none;
          z-index: 0;
        }

        .data-stream {
          position: absolute;
          width: 2px;
          height: 100px;
          background: linear-gradient(to bottom,
            transparent,
            rgba(59, 130, 246, 0.8),
            rgba(6, 182, 212, 0.8),
            transparent);
          animation: dataFlow 3s ease-in-out infinite;
          pointer-events: none;
          z-index: 1;
        }

        .data-stream-1 {
          left: 15%;
          animation-delay: 0s;
        }

        .data-stream-2 {
          left: 50%;
          animation-delay: 1s;
        }

        .data-stream-3 {
          left: 85%;
          animation-delay: 2s;
        }

        .tech-orb {
          position: absolute;
          border-radius: 50%;
          background: radial-gradient(circle,
            rgba(59, 130, 246, 0.4) 0%,
            rgba(6, 182, 212, 0.2) 50%,
            transparent 100%);
          filter: blur(20px);
          animation: orbFloat 8s ease-in-out infinite;
          pointer-events: none;
          z-index: 1;
        }

        .tech-orb-1 {
          width: 150px;
          height: 150px;
          top: -50px;
          right: -50px;
          animation-delay: 0s;
        }

        .tech-orb-2 {
          width: 120px;
          height: 120px;
          bottom: -40px;
          left: -40px;
          animation-delay: 2.5s;
        }

        .tech-orb-3 {
          width: 100px;
          height: 100px;
          top: 50%;
          left: 50%;
          margin-left: -50px;
          margin-top: -50px;
          animation-delay: 5s;
        }

        .blockchain-node {
          position: absolute;
          width: 8px;
          height: 8px;
          background: rgba(59, 130, 246, 0.8);
          border-radius: 50%;
          animation: nodePulse 2s ease-in-out infinite;
          pointer-events: none;
          z-index: 2;
        }

        .node-1 {
          top: 20%;
          left: 20%;
          animation-delay: 0s;
        }

        .node-2 {
          top: 30%;
          right: 25%;
          animation-delay: 0.5s;
        }

        .node-3 {
          bottom: 25%;
          left: 30%;
          animation-delay: 1s;
        }

        .node-4 {
          bottom: 20%;
          right: 20%;
          animation-delay: 1.5s;
        }

        .connection-lines {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 1;
        }

        .connect-line {
          stroke: rgba(59, 130, 246, 0.3);
          stroke-width: 1;
          stroke-dasharray: 1000;
          stroke-dashoffset: 1000;
          animation: lineFlow 8s ease-in-out infinite;
        }

        .line-1 {
          animation-delay: 0s;
        }

        .line-2 {
          animation-delay: 2.5s;
        }

        .line-3 {
          animation-delay: 5s;
        }

        .scan-line {
          position: absolute;
          left: 0;
          right: 0;
          height: 2px;
          background: linear-gradient(to right,
            transparent,
            rgba(6, 182, 212, 0.8),
            rgba(59, 130, 246, 0.8),
            transparent);
          box-shadow: 0 0 10px rgba(6, 182, 212, 0.8);
          animation: scanMove 5s ease-in-out infinite;
          pointer-events: none;
          z-index: 2;
        }




        @keyframes shimmer {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(100%);
          }
        }
      `}</style>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3 md:gap-4">
        {/* Total Assets Card */}
        <div className="emp-stat-card rounded-xl p-3 sm:p-4 md:p-5 bg-gradient-to-b from-amber-50 to-white border border-amber-200 hover:border-amber-300 hover:shadow-md transition-all duration-200 group">
          <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3 md:mb-4">
            <div className="emp-stat-icon w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-amber-100 flex items-center justify-center group-hover:bg-amber-200 transition-colors">
              <WalletIcon className="w-4 h-4 text-amber-600" />
            </div>
            <span className="emp-stat-label min-w-0 break-words hyphens-auto text-[11px] sm:text-xs md:text-sm font-semibold text-amber-600 uppercase tracking-wider leading-tight">{t.wallet.balance}</span>
          </div>
          <div
            className={`emp-stat-value flex items-baseline gap-0.5 sm:gap-1 min-w-0 w-full ${
              isTabletDevice ? '' : 'text-base sm:text-xl md:text-2xl lg:text-3xl'
            }`}
            style={isTabletDevice ? { fontSize: getTabletFontSize(totalAssets) } : {}}
          >
            <span className="text-amber-600 text-[1.15em] font-bold leading-none flex-shrink-0">$</span>
            <span
              className="font-bold text-amber-700 leading-tight truncate"
              title={`$${totalAssets.toFixed(2)}`}
            >
              {totalAssets.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Available Card */}
        <div className="emp-stat-card rounded-xl p-3 sm:p-4 md:p-5 bg-gradient-to-b from-emerald-50 to-white border border-emerald-200 hover:border-emerald-300 hover:shadow-md transition-all duration-200 group">
          <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3 md:mb-4">
            <div className="emp-stat-icon w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-emerald-100 flex items-center justify-center group-hover:bg-emerald-200 transition-colors">
              <DollarSign className="w-4 h-4 text-emerald-600" />
            </div>
            <span className="emp-stat-label min-w-0 break-words hyphens-auto text-[11px] sm:text-xs md:text-sm font-semibold text-emerald-600 uppercase tracking-wider leading-tight">{t.wallet.availableBalance}</span>
          </div>
          <div
            className={`emp-stat-value flex items-baseline gap-0.5 sm:gap-1 min-w-0 w-full ${
              isTabletDevice ? '' : 'text-base sm:text-xl md:text-2xl lg:text-3xl'
            }`}
            style={isTabletDevice ? { fontSize: getTabletFontSize(wallet?.available_balance || 0) } : {}}
          >
            <span className="text-emerald-600 text-[1.15em] font-bold leading-none flex-shrink-0">$</span>
            <span
              className="font-bold text-emerald-700 leading-tight truncate"
              title={`$${wallet?.available_balance.toFixed(2)}`}
            >
              {(wallet?.available_balance || 0).toFixed(2)}
            </span>
          </div>
        </div>

        {/* Total Earnings Card */}
        <div className="emp-stat-card rounded-xl p-3 sm:p-4 md:p-5 bg-gradient-to-b from-blue-50 to-white border border-blue-200 hover:border-blue-300 hover:shadow-md transition-all duration-200 group">
          <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3 md:mb-4">
            <div className="emp-stat-icon w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-blue-100 flex items-center justify-center group-hover:bg-blue-200 transition-colors">
              <TrendingUp className="w-4 h-4 text-blue-600" />
            </div>
            <span className="emp-stat-label min-w-0 break-words hyphens-auto text-[11px] sm:text-xs md:text-sm font-semibold text-blue-600 uppercase tracking-wider leading-tight">{t.wallet.totalEarnings}</span>
          </div>
          <div
            className={`emp-stat-value flex items-baseline gap-0.5 sm:gap-1 min-w-0 w-full ${
              isTabletDevice ? '' : 'text-base sm:text-xl md:text-2xl lg:text-3xl'
            }`}
            style={isTabletDevice ? { fontSize: getTabletFontSize(localEmployee.total_income) } : {}}
          >
            <span className="text-blue-600 text-[1.15em] font-bold leading-none flex-shrink-0">$</span>
            <span
              className="font-bold text-blue-700 leading-tight truncate"
              title={`$${localEmployee.total_income.toFixed(2)}`}
            >
              {localEmployee.total_income.toFixed(2)}
            </span>
          </div>
        </div>

        {/* Frozen Card */}
        <div className="emp-stat-card rounded-xl p-3 sm:p-4 md:p-5 bg-gradient-to-b from-orange-50 to-white border border-orange-200 hover:border-orange-300 hover:shadow-md transition-all duration-200 group">
          <div className="flex items-center gap-1.5 sm:gap-2 mb-2.5 sm:mb-3 md:mb-4">
            <div className="emp-stat-icon w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-orange-100 flex items-center justify-center group-hover:bg-orange-200 transition-colors">
              <Lock className="w-4 h-4 text-orange-600" />
            </div>
            <span className="emp-stat-label min-w-0 break-words hyphens-auto text-[11px] sm:text-xs md:text-sm font-semibold text-orange-600 uppercase tracking-wider leading-tight">{t.wallet.frozenFunds}</span>
          </div>
          <div
            className={`emp-stat-value flex items-baseline gap-0.5 sm:gap-1 min-w-0 w-full ${
              isTabletDevice ? '' : 'text-base sm:text-xl md:text-2xl lg:text-3xl'
            }`}
            style={isTabletDevice ? { fontSize: getTabletFontSize(wallet?.frozen_balance || 0) } : {}}
          >
            <span className="text-orange-600 text-[1.15em] font-bold leading-none flex-shrink-0">$</span>
            <span
              className="font-bold text-orange-700 leading-tight truncate"
              title={`$${wallet?.frozen_balance.toFixed(2)}`}
            >
              {(wallet?.frozen_balance || 0).toFixed(2)}
            </span>
          </div>
        </div>
      </div>

      {/* Withdraw Funds Panel - Wealth Transfer Theme */}
      <div ref={withdrawPanelRef} className={`relative rounded-2xl overflow-hidden border transition-[border-color,box-shadow] duration-500 ease-out ${
        contentResizing
          ? 'border-cyan-300 shadow-[0_0_0_4px_rgba(103,232,249,0.18),0_14px_32px_-14px_rgba(37,99,235,0.35)]'
          : 'border-gray-200 shadow-sm'
      }`}>
        {/* Curtain animation overlay - appears during checking */}
        {checkingEligibility && (
          <>
            <style>{'.wd-water{-webkit-mask-size:300% 100%;mask-size:300% 100%;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}.wd-water-l{-webkit-mask-image:linear-gradient(to right,#000 0%,#000 33.4%,rgba(0,0,0,.9) 40%,rgba(0,0,0,.7) 46%,rgba(0,0,0,.48) 52%,rgba(0,0,0,.26) 58%,rgba(0,0,0,.1) 63%,transparent 66.6%,transparent 100%);mask-image:linear-gradient(to right,#000 0%,#000 33.4%,rgba(0,0,0,.9) 40%,rgba(0,0,0,.7) 46%,rgba(0,0,0,.48) 52%,rgba(0,0,0,.26) 58%,rgba(0,0,0,.1) 63%,transparent 66.6%,transparent 100%)}.wd-water-r{-webkit-mask-image:linear-gradient(to left,#000 0%,#000 33.4%,rgba(0,0,0,.9) 40%,rgba(0,0,0,.7) 46%,rgba(0,0,0,.48) 52%,rgba(0,0,0,.26) 58%,rgba(0,0,0,.1) 63%,transparent 66.6%,transparent 100%);mask-image:linear-gradient(to left,#000 0%,#000 33.4%,rgba(0,0,0,.9) 40%,rgba(0,0,0,.7) 46%,rgba(0,0,0,.48) 52%,rgba(0,0,0,.26) 58%,rgba(0,0,0,.1) 63%,transparent 66.6%,transparent 100%)}@keyframes wd-card-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}@keyframes wd-card-out{from{opacity:1}to{opacity:0;transform:translateY(-6px)}}@keyframes wd-step-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}@keyframes wd-icon-pop{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:none}}@keyframes wd-dollar-float{from{transform:translateY(0) rotate(var(--wd-rot))}to{transform:translateY(-7px) rotate(var(--wd-rot))}}@keyframes wd-water-l-in{from{-webkit-mask-position:100% 0;mask-position:100% 0}to{-webkit-mask-position:0% 0;mask-position:0% 0}}@keyframes wd-water-l-out{from{-webkit-mask-position:0% 0;mask-position:0% 0}to{-webkit-mask-position:100% 0;mask-position:100% 0}}@keyframes wd-water-r-in{from{-webkit-mask-position:0% 0;mask-position:0% 0}to{-webkit-mask-position:100% 0;mask-position:100% 0}}@keyframes wd-water-r-out{from{-webkit-mask-position:100% 0;mask-position:100% 0}to{-webkit-mask-position:0% 0;mask-position:0% 0}}'}</style>
            {/* Left curtain: original colours over an opaque white base so nothing behind shows through */}
            <div
              className="wd-water wd-water-l keep-animation absolute inset-0 z-50"
              style={{
                backgroundImage: 'linear-gradient(to right, rgba(6,182,212,0.95), rgba(37,99,235,0.9), transparent), linear-gradient(#ffffff, #ffffff)',
                ...(eligibilityOverlayLeaving
                  ? { animation: 'wd-water-l-out 1600ms cubic-bezier(0.45, 0.05, 0.35, 1) 150ms both' }
                  : eligibilityIntroDone
                    ? { WebkitMaskPosition: '0% 0', maskPosition: '0% 0' }
                    : { animation: 'wd-water-l-in 1800ms cubic-bezier(0.45, 0.05, 0.35, 1) both' }),
              }}
            >{dollarBlocks}</div>
            {/* Right curtain */}
            <div
              className="wd-water wd-water-r keep-animation absolute inset-0 z-50"
              style={{
                backgroundImage: 'linear-gradient(to left, rgba(37,99,235,0.95), rgba(6,182,212,0.9), transparent), linear-gradient(to right, rgba(6,182,212,0.95), rgba(37,99,235,0.9), transparent), linear-gradient(#ffffff, #ffffff)',
                ...(eligibilityOverlayLeaving
                  ? { animation: 'wd-water-r-out 1600ms cubic-bezier(0.45, 0.05, 0.35, 1) 150ms both' }
                  : eligibilityIntroDone
                    ? { WebkitMaskPosition: '100% 0', maskPosition: '100% 0' }
                    : { animation: 'wd-water-r-in 1800ms cubic-bezier(0.45, 0.05, 0.35, 1) both' }),
              }}
            >{dollarBlocks}</div>

            {/* Application card: white surface so the status reads clearly over the curtains. */}
            <div
              className="keep-animation absolute inset-x-0 top-0 z-50 flex items-center justify-center px-3 sm:px-6"
              style={{ height: curtainHeight ?? '100%', animation: eligibilityOverlayLeaving ? 'wd-card-out 320ms cubic-bezier(0.4, 0, 1, 1) both' : eligibilityIntroDone ? undefined : 'wd-card-in 620ms cubic-bezier(0.22, 1, 0.36, 1) 1150ms both' }}
              role="status"
              aria-live="polite"
            >
              {(() => {
                const done = eligibilityOutcome !== null;
                const blocked = eligibilityOutcome === 'blocked';
                const step = Math.min(eligibilityStep, WD_STEP_PROGRESS.length - 1);
                const progress = done ? 1 : WD_STEP_PROGRESS[step];
                const title = done ? (blocked ? t.wallet.wdBlockedTitle : t.wallet.wdPassedTitle) : t.wallet.wdApplyTitle;
                const line = done
                  ? (blocked ? t.wallet.wdBlockedLine : t.wallet.wdPassedLine)
                  : `${[t.wallet.wdStepVerify, t.wallet.wdStepEligibility, t.wallet.wdStepPrepare][step]}…`;
                return (
                  <div className="w-full max-w-[344px] rounded-2xl bg-white px-4 py-3.5 shadow-[0_20px_44px_-18px_rgba(15,23,42,0.6),0_2px_6px_rgba(15,23,42,0.08)] ring-1 ring-white/80 sm:max-w-[392px] sm:px-5 sm:py-4">
                    <div className="flex items-center gap-3 sm:gap-3.5">
                      <div className="relative h-11 w-11 flex-shrink-0 sm:h-12 sm:w-12" aria-hidden="true">
                        <span className={`absolute inset-0 rounded-full border-[3px] transition-colors duration-500 ${done ? (blocked ? 'border-amber-300' : 'border-blue-500') : 'border-blue-100'}`}></span>
                        {!done && <span className="keep-animation absolute inset-0 animate-spin rounded-full border-[3px] border-transparent border-r-cyan-500 border-t-blue-600" style={{ animationDuration: '1.1s' }}></span>}
                        <span
                          key={eligibilityOutcome ?? 'busy'}
                          className={`absolute inset-[6px] flex items-center justify-center rounded-full text-white shadow-md ${blocked ? 'bg-amber-500 shadow-amber-500/30' : 'bg-gradient-to-br from-blue-600 to-cyan-500 shadow-blue-600/30'}`}
                          style={done ? { animation: 'wd-icon-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1) both' } : undefined}
                        >
                          {done ? (blocked ? <AlertCircle className="h-4 w-4 sm:h-[18px] sm:w-[18px]" strokeWidth={2.5} /> : <Check className="h-4 w-4 sm:h-[18px] sm:w-[18px]" strokeWidth={3} />) : <ShieldCheck className="h-4 w-4 sm:h-[18px] sm:w-[18px]" strokeWidth={2.25} />}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className={`line-clamp-2 text-[14px] font-bold leading-snug sm:text-[15px] ${blocked ? 'text-amber-800' : 'text-slate-900'}`}>{title}</p>
                        <p key={line} className="mt-0.5 line-clamp-2 text-[12px] font-medium leading-snug text-slate-500 sm:text-[13px]" style={{ animation: 'wd-step-in 360ms cubic-bezier(0.22, 1, 0.36, 1) both' }}>{line}</p>
                      </div>
                      {!done && (
                        <span className="flex-shrink-0 self-start rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-bold tabular-nums text-blue-700 ring-1 ring-blue-100">{step + 1}/{WD_STEP_PROGRESS.length}</span>
                      )}
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-100 sm:mt-3.5">
                      <div
                        className={`h-full rounded-full ${blocked ? 'bg-gradient-to-r from-amber-400 to-amber-500' : 'bg-gradient-to-r from-blue-600 to-cyan-500'}`}
                        style={{
                          transform: `translateX(${((progress - 1) * 100).toFixed(1)}%)`,
                          transition: `transform ${done ? 450 : step === WD_STEP_PROGRESS.length - 1 ? 1400 : 900}ms cubic-bezier(0.22, 1, 0.36, 1)`,
                        }}
                      ></div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </>
        )}

        {/* Light Blue Background */}
        <div className="absolute inset-0 bg-white"></div>

        {/* Elegant static grid pattern - mobile optimized */}
        <div className="absolute inset-0 opacity-[0.03] sm:opacity-[0.06]">
          <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="hex-withdraw" x="0" y="0" width="50" height="43.3" patternUnits="userSpaceOnUse">
                <path d="M25 0 L37.5 7.2 L37.5 21.6 L25 28.8 L12.5 21.6 L12.5 7.2 Z" fill="none" stroke="rgba(59,130,246,0.25)" strokeWidth="0.5"/>
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#hex-withdraw)"/>
          </svg>
        </div>

        {/* Static accent lines - desktop only to preserve performance */}
        <svg className="hidden sm:block absolute inset-0 w-full h-full opacity-8">
          <defs>
            <linearGradient id="circuit-grad-1" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="rgba(59,130,246,0)"/>
              <stop offset="50%" stopColor="rgba(6,182,212,0.6)"/>
              <stop offset="100%" stopColor="rgba(59,130,246,0)"/>
            </linearGradient>
          </defs>
          <line x1="0" y1="30%" x2="100%" y2="30%" stroke="url(#circuit-grad-1)" strokeWidth="1" strokeDasharray="10,5"/>
          <line x1="0" y1="70%" x2="100%" y2="70%" stroke="url(#circuit-grad-1)" strokeWidth="1" strokeDasharray="10,5"/>
          <line x1="25%" y1="0" x2="25%" y2="100%" stroke="url(#circuit-grad-1)" strokeWidth="0.5" strokeDasharray="8,4"/>
          <line x1="75%" y1="0" x2="75%" y2="100%" stroke="url(#circuit-grad-1)" strokeWidth="0.5" strokeDasharray="8,4"/>
        </svg>

        {/* Money Transfer Animation - Flying Gold Coins - Hidden on mobile */}
        <div className="hidden sm:block absolute top-1/4 right-0 w-full h-32 pointer-events-none">
          {/* Coin 1 */}
          <div className="absolute top-0 right-[80%] w-12 h-12 rounded-full bg-gradient-to-br from-yellow-200 via-amber-400 to-yellow-600 shadow-2xl animate-[flyCoins_4s_ease-in-out_infinite] opacity-40">
            <div className="absolute inset-2 rounded-full bg-gradient-to-br from-amber-300 to-amber-500 flex items-center justify-center">
              <span className="text-amber-900 text-lg font-black">$</span>
            </div>
          </div>
          {/* Coin 2 */}
          <div className="absolute top-8 right-[75%] w-10 h-10 rounded-full bg-gradient-to-br from-yellow-300 via-amber-500 to-yellow-700 shadow-xl animate-[flyCoins_4s_ease-in-out_infinite] delay-500 opacity-30">
            <div className="absolute inset-2 rounded-full bg-gradient-to-br from-amber-400 to-amber-600"></div>
          </div>
          {/* Coin 3 */}
          <div className="absolute top-4 right-[85%] w-14 h-14 rounded-full bg-gradient-to-br from-amber-200 via-yellow-400 to-amber-600 shadow-2xl animate-[flyCoins_4s_ease-in-out_infinite] delay-1000 opacity-35">
            <div className="absolute inset-2 rounded-full bg-gradient-to-br from-yellow-300 to-yellow-500 flex items-center justify-center">
              <span className="text-yellow-900 text-xl font-black">$</span>
            </div>
          </div>
        </div>

        {/* Blockchain Network Nodes - Hidden on mobile */}
        <div className="hidden sm:block absolute top-4 left-6 w-3 h-3 rounded-full bg-cyan-400 shadow-[0_0_20px_rgba(6,182,212,1)] animate-[nodePulse_2s_ease-in-out_infinite]"></div>
        <div className="hidden sm:block absolute top-12 left-12 w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_15px_rgba(59,130,246,1)] animate-[nodePulse_2.5s_ease-in-out_infinite] delay-500"></div>
        <div className="hidden sm:block absolute bottom-12 left-8 w-2.5 h-2.5 rounded-full bg-cyan-300 shadow-[0_0_18px_rgba(103,232,249,1)] animate-[nodePulse_3s_ease-in-out_infinite] delay-1000"></div>
        <div className="hidden sm:block absolute top-8 right-10 w-2 h-2 rounded-full bg-blue-300 shadow-[0_0_15px_rgba(147,197,253,1)] animate-[nodePulse_2.7s_ease-in-out_infinite] delay-700"></div>
        <div className="hidden sm:block absolute bottom-8 right-16 w-3 h-3 rounded-full bg-cyan-500 shadow-[0_0_20px_rgba(6,182,212,1)] animate-[nodePulse_2.3s_ease-in-out_infinite] delay-1200"></div>

        {/* Wealth Sparkles - Hidden on mobile */}
        <div className="hidden sm:block absolute top-16 right-24 w-2 h-2 bg-yellow-300 rounded-full shadow-[0_0_20px_rgba(253,224,71,1)] animate-[twinkleGold_2s_ease-in-out_infinite]"></div>
        <div className="hidden sm:block absolute top-24 right-32 w-1.5 h-1.5 bg-amber-300 rounded-full shadow-[0_0_15px_rgba(252,211,77,1)] animate-[twinkleGold_2.5s_ease-in-out_infinite] delay-600"></div>
        <div className="hidden sm:block absolute bottom-20 left-20 w-2 h-2 bg-yellow-400 rounded-full shadow-[0_0_18px_rgba(250,204,21,1)] animate-[twinkleGold_3s_ease-in-out_infinite] delay-1200"></div>

        {/* Corner Decorations - Hidden on mobile */}
        <div className="hidden sm:block absolute top-0 left-0 w-16 h-16 border-t-2 border-l-2 border-blue-400/40 rounded-tl-2xl"></div>
        <div className="hidden sm:block absolute top-0 right-0 w-16 h-16 border-t-2 border-r-2 border-cyan-400/40 rounded-tr-2xl"></div>
        <div className="hidden sm:block absolute bottom-0 left-0 w-16 h-16 border-b-2 border-l-2 border-cyan-400/40 rounded-bl-2xl"></div>
        <div className="hidden sm:block absolute bottom-0 right-0 w-16 h-16 border-b-2 border-r-2 border-blue-400/40 rounded-br-2xl"></div>

        {/* Mobile-only elegant static decorative elements */}
        <div className="sm:hidden absolute inset-0 pointer-events-none overflow-hidden">
          {/* Elegant gradient orbs - subtle and refined */}
          <div className="absolute -top-20 -right-20 w-64 h-64 bg-gradient-radial from-cyan-500/8 via-blue-500/4 to-transparent rounded-full"></div>
          <div className="absolute -bottom-20 -left-20 w-64 h-64 bg-gradient-radial from-blue-500/8 via-cyan-500/4 to-transparent rounded-full"></div>

          {/* Refined corner brackets - minimalist design */}
          <div className="absolute top-0 left-0 w-16 h-16">
            <div className="absolute top-0 left-0 w-full h-0.5 bg-gradient-to-r from-cyan-400/40 via-cyan-400/20 to-transparent"></div>
            <div className="absolute top-0 left-0 w-0.5 h-full bg-gradient-to-b from-cyan-400/40 via-cyan-400/20 to-transparent"></div>
            <div className="absolute top-0 left-0 w-2 h-2 bg-cyan-400/60 rounded-full"></div>
          </div>
          <div className="absolute top-0 right-0 w-16 h-16">
            <div className="absolute top-0 right-0 w-full h-0.5 bg-gradient-to-l from-blue-400/40 via-blue-400/20 to-transparent"></div>
            <div className="absolute top-0 right-0 w-0.5 h-full bg-gradient-to-b from-blue-400/40 via-blue-400/20 to-transparent"></div>
            <div className="absolute top-0 right-0 w-2 h-2 bg-blue-400/60 rounded-full"></div>
          </div>
          <div className="absolute bottom-0 left-0 w-16 h-16">
            <div className="absolute bottom-0 left-0 w-full h-0.5 bg-gradient-to-r from-cyan-400/40 via-cyan-400/20 to-transparent"></div>
            <div className="absolute bottom-0 left-0 w-0.5 h-full bg-gradient-to-t from-cyan-400/40 via-cyan-400/20 to-transparent"></div>
            <div className="absolute bottom-0 left-0 w-2 h-2 bg-cyan-400/60 rounded-full"></div>
          </div>
          <div className="absolute bottom-0 right-0 w-16 h-16">
            <div className="absolute bottom-0 right-0 w-full h-0.5 bg-gradient-to-l from-blue-400/40 via-blue-400/20 to-transparent"></div>
            <div className="absolute bottom-0 right-0 w-0.5 h-full bg-gradient-to-t from-blue-400/40 via-blue-400/20 to-transparent"></div>
            <div className="absolute bottom-0 right-0 w-2 h-2 bg-blue-400/60 rounded-full"></div>
          </div>

          {/* Geometric accent lines - clean and elegant */}
          <div className="absolute top-1/3 left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-400/15 to-transparent"></div>
          <div className="absolute bottom-1/3 left-0 right-0 h-px bg-gradient-to-r from-transparent via-blue-400/15 to-transparent"></div>

          {/* Minimalist side accents */}
          <div className="absolute top-1/4 left-0 w-px h-20 bg-gradient-to-b from-transparent via-cyan-400/20 to-transparent"></div>
          <div className="absolute bottom-1/4 right-0 w-px h-20 bg-gradient-to-b from-transparent via-blue-400/20 to-transparent"></div>

          {/* Refined send icon watermark - larger and more elegant */}
          <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 opacity-[0.03]">
            <Send className="w-40 h-40 text-blue-600" />
          </div>

          {/* Subtle diagonal accent */}
          <div className="absolute top-0 right-0 w-32 h-32 border-t border-r border-blue-400/10 rounded-tr-2xl"></div>
          <div className="absolute bottom-0 left-0 w-32 h-32 border-b border-l border-cyan-400/10 rounded-bl-2xl"></div>
        </div>

        <div className="relative z-10 p-3 sm:p-4 md:p-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 sm:gap-0 mb-6 sm:mb-8">
          <div className="flex items-center gap-2 sm:gap-3">
            {/* Animated Wallet Icon with Gold Coins */}
            <div className="relative w-10 h-10 sm:w-12 sm:h-12 md:w-14 md:h-14">
              {/* Glowing background - Hidden on mobile */}
              <div className="hidden sm:block absolute inset-0 bg-gradient-to-br from-blue-500/40 to-cyan-500/40 blur-xl rounded-full animate-pulse"></div>

              {/* Icon container */}
              <div className="relative w-full h-full bg-gradient-to-br from-blue-600/30 to-cyan-600/30 rounded-xl border-2 border-cyan-400/50 flex items-center justify-center backdrop-blur-sm overflow-hidden">
                {/* Rotating ring */}
                <div className="absolute inset-0 border-2 border-blue-400/20 rounded-xl animate-[spin_4s_linear_infinite]"></div>

                {/* Small gold coins flying around - Hidden on mobile */}
                <div className="hidden sm:block absolute top-0 right-0 w-3 h-3 rounded-full bg-gradient-to-br from-yellow-300 to-amber-500 shadow-lg animate-[miniCoinOrbit_3s_ease-in-out_infinite]"></div>
                <div className="hidden sm:block absolute bottom-1 left-1 w-2.5 h-2.5 rounded-full bg-gradient-to-br from-amber-300 to-yellow-600 shadow-md animate-[miniCoinOrbit_3s_ease-in-out_infinite] delay-1000"></div>

                <Send className="w-4 h-4 sm:w-5 sm:h-5 md:w-6 md:h-6 text-blue-600 drop-shadow-[0_0_10px_rgba(6,182,212,0.8)] relative z-10" />
              </div>
            </div>

            <div>
              <h2 className="text-base sm:text-xl md:text-2xl font-bold text-blue-600 leading-tight">
                {t.wallet.withdraw}
              </h2>
              <p className="text-[11px] sm:text-xs text-gray-500 font-medium leading-tight">{t.wallet.transferSubtitle}</p>
            </div>
          </div>
          <button
            onClick={() => {
              setShowWithdrawalHistory(true);
              onWithdrawalHistoryChange?.(true);
            }}
            className="emp-compact-btn group relative inline-flex !h-[36px] !min-h-[36px] shrink-0 items-center gap-[8px] overflow-hidden whitespace-nowrap rounded-[12px] bg-gradient-to-r from-orange-500 to-amber-500 pl-[6px] pr-[12px] text-white shadow-[0_6px_16px_-6px_rgba(249,115,22,0.6)] ring-1 ring-inset ring-white/25 transition-all duration-200 hover:-translate-y-px hover:shadow-[0_10px_22px_-8px_rgba(249,115,22,0.7)] active:translate-y-0 lg:!h-[40px] lg:!min-h-[40px] lg:pl-[8px] lg:pr-[16px]"
          >
            <span className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/20 to-transparent" aria-hidden="true"></span>
            <span className="relative flex h-[24px] w-[24px] items-center justify-center rounded-[8px] bg-white/20 lg:h-[28px] lg:w-[28px]">
              <History className="h-[14px] w-[14px] transition-transform duration-300 group-hover:-rotate-[20deg] lg:h-[16px] lg:w-[16px]" />
            </span>
            <span className="relative text-[12px] font-bold tracking-wide sm:text-[13px] lg:text-[14px]">{t.wallet.withdrawalHistory}</span>
            <ChevronRight className="relative h-[14px] w-[14px] opacity-80 transition-transform duration-200 group-hover:translate-x-0.5 lg:h-[16px] lg:w-[16px]" />
          </button>
        </div>

        <style>{'@keyframes wd-btn-cover{from{opacity:1}to{opacity:0}}@keyframes wd-reveal{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}.wd-reveal-stagger>*{animation:wd-reveal 700ms cubic-bezier(.22,1,.36,1) both}.wd-reveal-stagger>*:nth-child(1){animation-delay:.22s}.wd-reveal-stagger>*:nth-child(2){animation-delay:.32s}.wd-reveal-stagger>*:nth-child(3){animation-delay:.42s}.wd-reveal-stagger>*:nth-child(4){animation-delay:.52s}.wd-reveal-stagger>*:nth-child(n+5){animation-delay:.6s}.wd-reveal-stagger>.wd-reveal-skip{animation:none}@media (prefers-reduced-motion:reduce){.wd-reveal-stagger>*{animation:none}}'}</style>
        {/* Content wrapper with transition animation */}
        <div
          className="relative z-10"
          style={{
            height: contentHeight ?? undefined,
            transition: contentResizing && !messageLeaving ? 'height 640ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
            overflow: contentResizing ? 'hidden' : undefined,
          }}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget && event.propertyName === 'height') setContentResizing(false);
          }}
        >
        <div ref={contentInnerRef}>
          {/* Transitioning content area */}
          {!showWithdrawalForm ? (
            <div className={contentRevealActive ? 'wd-reveal-stagger' : ''}>
              {message && (
                <div
                  ref={messageWrapRef}
                  className="overflow-hidden"
                  style={{ transition: 'height 500ms cubic-bezier(0.22, 1, 0.36, 1)' }}
                >
                  <div
                    className="transition-opacity duration-300 ease-out"
                    style={{ opacity: messageLeaving ? 0 : 1 }}
                  >
                    <div className="pb-3 sm:pb-4">
                      <WithdrawalNotice type={message.type} text={message.text} />
                    </div>
                  </div>
                </div>
              )}

              <button
                onClick={handleRequestWithdrawal}
                disabled={checkingEligibility}
                className={`wd-reveal-skip relative w-full min-h-[44px] text-white py-2.5 sm:py-3 md:py-4 px-3 sm:px-4 rounded-lg sm:rounded-xl font-bold flex items-center justify-center gap-1.5 sm:gap-2 group overflow-hidden disabled:cursor-not-allowed text-sm sm:text-base transition-all duration-300 ${
                  buttonLoading
                    ? 'keep-animation bg-blue-600 cursor-wait shadow-2xl shadow-blue-500/50'
                    : 'bg-gradient-to-r from-blue-600 via-blue-500 to-cyan-600 hover:from-blue-500 hover:via-cyan-500 hover:to-blue-600 shadow-2xl shadow-blue-500/50 hover:shadow-cyan-500/50 hover:scale-[1.02] active:scale-[0.98]'
                }`}
                style={buttonLoading ? { animation: 'wd-btn-cover 1300ms cubic-bezier(0.4, 0, 0.6, 1) both' } : undefined}
              >
                {/* Hover effect when not loading */}
                {!buttonLoading && (
                  <div className="absolute inset-0 bg-gradient-to-r from-blue-600 via-cyan-500 to-blue-600 opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                )}

                {/* Icon and text */}
                <span className="relative z-10 flex items-center justify-center gap-2">
                  {buttonLoading ? (
                    <>
                      {/* Double spinner effect - outer ring + inner ring */}
                      <div className="keep-animation relative">
                        {/* Outer ring - clockwise */}
                        <div className="keep-animation w-5 h-5 sm:w-6 sm:h-6 border-2 sm:border-[3px] border-white/30 border-t-white rounded-full animate-spin"></div>
                        {/* Inner ring - counter-clockwise (desktop only) */}
                        <div className="keep-animation hidden sm:block absolute inset-0 w-6 h-6 border-[3px] border-transparent border-t-cyan-300 rounded-full animate-spin" style={{ animationDuration: '0.8s', animationDirection: 'reverse' }}></div>
                      </div>
                      <span className="keep-animation tracking-wide">{t.wallet.checking}</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-4 h-4 sm:w-5 sm:h-5 transition-transform duration-300 group-hover:scale-110" />
                      <span className="tracking-wide">{t.wallet.submitWithdrawal}</span>
                    </>
                  )}
                </span>
              </button>
            </div>
          ) : (
            <div
              className={`space-y-3 sm:space-y-4 interactive-transition ${contentRevealActive ? 'wd-reveal-stagger' : ''}`}
            >
            {/* Withdrawal Request Header Card */}
            <div className="relative rounded-xl sm:rounded-2xl overflow-hidden border border-gray-200 shadow-sm">
              {/* Blue Header Banner */}
              <div className="bg-gradient-to-r from-blue-600 to-blue-500 px-3 sm:px-5 md:px-6 py-3 sm:py-4">
                <div className="flex items-center gap-2.5 sm:gap-3">
                  <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center">
                    <Send className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
                  </div>
                  <div>
                    <h3 className="text-sm sm:text-base md:text-lg font-bold text-white leading-tight">
                      {t.wallet.submitWithdrawal}
                    </h3>
                    <p className="text-blue-100 text-[11px] sm:text-xs mt-0.5">
                      {t.wallet.withdrawFullBalance}
                    </p>
                  </div>
                </div>
              </div>

              {/* Card Body */}
              <div className="bg-white p-3 sm:p-5 md:p-6 space-y-3 sm:space-y-4">
                {/* Amount Display */}
                <div className="bg-gradient-to-br from-blue-50/60 to-white rounded-xl p-4 sm:p-5 md:p-6 border border-blue-100">
                  <div className="flex items-center justify-between mb-3 sm:mb-4">
                    <span className="text-blue-700 text-xs sm:text-sm font-semibold">{t.wallet.withdrawalAmount}</span>
                    <span className="px-2 py-0.5 sm:px-2.5 sm:py-1 bg-blue-100 border border-blue-200 rounded-md text-[11px] sm:text-xs text-blue-700 font-bold uppercase tracking-wide">
                      {t.wallet.submitWithdrawal}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 sm:gap-3 justify-center py-2 sm:py-3">
                    <div className="w-8 h-8 sm:w-11 sm:h-11 rounded-full bg-emerald-100 border border-emerald-200 flex items-center justify-center">
                      <DollarSign className="w-5 h-5 sm:w-6 sm:h-6 text-emerald-600" />
                    </div>
                    <div className="text-2xl sm:text-4xl md:text-5xl font-black text-blue-900">
                      {wallet?.available_balance.toFixed(2)}
                    </div>
                    <div className="px-2 py-1 sm:px-3 sm:py-1.5 bg-blue-100 border border-blue-200 rounded-lg">
                      <span className="text-sm sm:text-lg text-blue-700 font-bold">{currencyUnit}</span>
                    </div>
                  </div>

                  <div className="mt-3 sm:mt-4 pt-3 sm:pt-4 border-t border-blue-100 space-y-2">
                    <div className="flex items-center justify-between text-xs sm:text-sm">
                      <span className="text-blue-600/80">{t.wallet.amount}</span>
                      <span className="text-emerald-600 font-bold">${wallet?.available_balance.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs sm:text-sm">
                      <span className="text-blue-600/80">{t.wallet.afterWithdrawal}</span>
                      <span className="text-blue-700 font-bold">$0.00</span>
                    </div>
                  </div>
                </div>

                {message && <WithdrawalNotice type={message.type} text={message.text} />}

                <div className="flex gap-2 sm:gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowWithdrawalForm(false);
                      setMessage(null);
                    }}
                    className="flex-1 min-h-[44px] bg-white hover:bg-gray-50 border border-gray-300 hover:border-gray-400 text-gray-700 py-2.5 sm:py-3 px-3 sm:px-4 rounded-lg sm:rounded-xl font-semibold transition-all text-xs sm:text-sm md:text-base"
                  >
                    {t.common.cancel}
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowConfirmModal(true)}
                    disabled={!wallet || wallet.available_balance <= 0}
                    className="flex-1 min-h-[44px] bg-blue-600 hover:bg-blue-700 text-white py-2.5 sm:py-3 px-3 sm:px-4 rounded-lg sm:rounded-xl font-bold shadow-md shadow-blue-200 hover:shadow-lg hover:shadow-blue-200 transition-all flex items-center justify-center gap-1.5 sm:gap-2 disabled:opacity-50 disabled:cursor-not-allowed text-xs sm:text-sm md:text-base"
                  >
                    <Send className="w-4 h-4 sm:w-5 sm:h-5" />
                    <span className="hidden sm:inline">{t.wallet.submitWithdrawal}</span>
                    <span className="sm:hidden">{t.wallet.withdraw}</span>
                  </button>
                </div>
              </div>
            </div>

            <div className="bg-blue-50 rounded-lg p-3 sm:p-4 border border-blue-100">
              <p className="text-blue-700 text-[11px] sm:text-xs leading-relaxed">
                <span className="font-semibold">{t.wallet.importantNotice}:</span> {t.wallet.withdrawalNote}
              </p>
            </div>
          </div>
          )}
        </div>
        </div>
        </div>
      </div>

      {showConfirmModal && createPortal(
        <div className="wd-wrap fixed inset-0 flex items-center justify-center p-3 sm:p-4" style={{ zIndex: 10000 }}>
          <style>{'@keyframes wd-backdrop-in{from{opacity:0}to{opacity:1}}@keyframes wd-panel-in{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}@media (prefers-reduced-motion:reduce){.wd-anim{animation:none!important}}@media (max-width:359.98px){.wd-wrap{padding:0!important}.wd-surface{height:100%!important;max-height:none!important;max-width:none!important;border-radius:0!important;box-shadow:none!important}.wd-head{padding-top:max(14px,env(safe-area-inset-top))!important}.wd-foot{padding-bottom:max(14px,env(safe-area-inset-bottom))!important}}'}</style>
          <div
            className="wd-anim employee-modal-backdrop absolute inset-0 bg-slate-900/60 backdrop-blur-[2px]"
            style={{ animation: 'wd-backdrop-in 200ms ease-out' }}
            onClick={() => { if (!submitting) setShowConfirmModal(false); }}
          ></div>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="withdrawal-confirm-title"
            className="wd-anim wd-surface employee-modal-surface relative flex w-full max-w-md md:max-w-lg max-h-[90vh] flex-col overflow-hidden rounded-2xl isolate transform-gpu shadow-[0_24px_60px_-12px_rgba(15,23,42,0.45)]"
            style={{ animation: 'wd-panel-in 260ms cubic-bezier(0.22, 1, 0.36, 1)' }}
          >
            <div className="wd-head relative flex-shrink-0 overflow-hidden bg-[linear-gradient(135deg,#1e3a8a_0%,#1d4ed8_55%,#2563eb_100%)] px-5 pb-6 pt-4 text-white sm:px-7 sm:pb-7 sm:pt-5">
              <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                <div className="absolute -right-10 -top-12 h-40 w-40 rotate-12 rounded-[2rem] bg-white/[0.06]"></div>
                <div className="absolute right-16 top-10 h-16 w-16 rotate-12 rounded-xl bg-sky-300/[0.10]"></div>
                <div className="absolute -bottom-14 -left-8 h-32 w-32 -rotate-6 rounded-[1.75rem] bg-white/[0.05]"></div>
                <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"></div>
              </div>

              <div className="relative flex items-center justify-between gap-3">
                <h3 id="withdrawal-confirm-title" className="flex min-w-0 items-center gap-2.5 text-[17px] font-semibold leading-snug tracking-wide sm:gap-3 sm:text-[18px]">
                  <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-white/15 ring-1 ring-white/20">
                    <ShieldCheck className="h-[18px] w-[18px] sm:h-5 sm:w-5" />
                  </span>
                  <span className="truncate">{t.wallet.submitWithdrawal}</span>
                </h3>
                <button
                  type="button"
                  onClick={() => setShowConfirmModal(false)}
                  disabled={submitting}
                  aria-label={t.common.close}
                  className="emp-close-btn max-sm:-m-0.5 flex !h-[32px] !w-[32px] !min-h-[32px] !min-w-[32px] flex-shrink-0 items-center justify-center rounded-lg bg-white/10 lg:-mr-1 lg:!h-[40px] lg:!w-[40px] lg:!min-h-[40px] lg:!min-w-[40px] lg:rounded-xl !p-0 text-white/80 ring-1 ring-white/15 transition-colors hover:bg-white/20 hover:text-white disabled:opacity-40"
                >
                  <X className="h-[16px] w-[16px] lg:h-[20px] lg:w-[20px]" strokeWidth={2.25} />
                </button>
              </div>

              <div className="relative mt-5 text-center sm:mt-6">
                <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-blue-100/80 sm:text-xs">
                  {t.wallet.withdrawalAmount}
                </div>
                <div className="mt-2 flex items-baseline justify-center gap-1 font-bold leading-none tabular-nums">
                  <span className="text-[1.75rem] text-blue-100 sm:text-[2rem]">$</span>
                  <span className="break-all text-[2.25rem] tracking-tight sm:text-[2.75rem]">{wallet?.available_balance.toFixed(2)}</span>
                </div>
                <span className="mt-3 inline-flex items-center rounded-full bg-white/[0.12] px-2.5 py-0.5 text-[11px] font-semibold tracking-wider text-white/90 ring-1 ring-white/20">
                  {currencyUnit}
                </span>
              </div>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain bg-white px-5 py-5 sm:space-y-5 sm:px-7 sm:py-6">
              <dl className="rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-1 text-sm sm:px-5">
                <div className="flex items-center justify-between gap-3 py-3">
                  <dt className="flex items-center gap-2 text-slate-500">
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-500" aria-hidden="true"></span>
                    {t.wallet.amount}
                  </dt>
                  <dd className="font-bold tabular-nums text-emerald-600">${wallet?.available_balance.toFixed(2)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-dashed border-slate-200 py-3">
                  <dt className="flex items-center gap-2 text-slate-500">
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-500" aria-hidden="true"></span>
                    {t.wallet.afterWithdrawal}
                  </dt>
                  <dd className="font-bold tabular-nums text-blue-700">$0.00</dd>
                </div>
              </dl>

              <div lang={language} className="relative overflow-hidden rounded-xl border border-amber-200/70 bg-amber-50/60 px-4 py-4 [container-type:inline-size] sm:py-4 sm:pl-5 sm:pr-4">
                <div className="absolute inset-y-0 left-0 w-1 bg-amber-400" aria-hidden="true"></div>
                <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-amber-900 sm:text-sm">
                  <Clock className="h-4 w-4 flex-shrink-0 text-amber-500" />
                  {t.wallet.importantNotice}
                </div>
                <ol className="space-y-3 sm:space-y-2.5">
                  {[t.wallet.noticeSubmitted, t.wallet.noticeFrozen, t.wallet.noticeContact].map((line, index) => (
                    <li key={index} className="grid grid-cols-[18px_minmax(0,1fr)] items-start gap-x-2.5 text-[clamp(0.71875rem,4cqi,0.78125rem)] leading-[1.75] text-amber-800/90 sm:flex sm:gap-2.5 sm:text-xs sm:leading-relaxed">
                      <span className="mt-px flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-amber-100 text-[10px] font-bold text-amber-700 ring-1 ring-amber-200">
                        {index + 1}
                      </span>
                      <span className="min-w-0 hyphens-none text-left [overflow-wrap:anywhere] [text-wrap:pretty]">{line}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <div className="wd-foot flex flex-shrink-0 gap-2.5 border-t border-slate-100 bg-slate-50 px-5 py-3.5 sm:gap-3 sm:px-7 sm:py-4">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                disabled={submitting}
                className="flex-1 min-h-[44px] rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm font-medium leading-tight text-slate-700 transition-colors hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t.common.cancel}
              </button>
              <button
                type="button"
                onClick={handleConfirmWithdrawal}
                disabled={submitting}
                className="flex-1 min-h-[44px] flex items-center justify-center gap-1.5 rounded-lg bg-[linear-gradient(135deg,#1d4ed8_0%,#2563eb_100%)] px-2 py-2 text-sm font-semibold leading-tight text-white shadow-[0_6px_16px_-6px_rgba(37,99,235,0.6)] transition-all duration-200 hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Send className="h-4 w-4 shrink-0" />}
                {submitting ? t.common.loading : t.wallet.submitWithdrawal}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {showWithdrawalHistory && (
        <WithdrawalHistory
          employeeId={employeeId}
          onClose={() => {
            setShowWithdrawalHistory(false);
            onWithdrawalHistoryChange?.(false);
          }}
        />
      )}
    </div>
  );
}
