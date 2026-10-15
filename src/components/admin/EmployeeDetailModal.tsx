import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  X,
  TrendingUp,
  CheckCircle,
  XCircle,
  Ban,
  Calendar,
  ChevronDown,
  DollarSign,
  Gift,
  User,
  Clock,
  MessageSquare,
  FileText,
  Shield,
  Mail,
  Phone,
  CreditCard,
  Wallet,
  Eye,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from "lucide-react";
import {
  formatSupabaseError,
  isFinancialAdminSessionError,
  isSupabaseAbortError,
  supabase,
} from "../../lib/supabase";
import { getAdminFinancialSessionToken, logout } from "../../lib/auth";
import { Employee } from "../../types";
import type { Database } from "../../types/database";

type EmployeeDetailSummary = Database["public"]["Functions"]["get_employee_detail_summary_for_admin"]["Returns"];
type DailyStats = EmployeeDetailSummary["dailyStats"][number];
type WalletTransaction = Database["public"]["Functions"]["get_employee_transaction_page_for_admin"]["Returns"]["rows"][number];
type WithdrawalRecord = Database["public"]["Functions"]["get_employee_withdrawal_page_for_admin"]["Returns"]["rows"][number];
type VerificationRequest = NonNullable<EmployeeDetailSummary["verification"]>;

const withdrawalStatusConfig: Record<
  string,
  {
    label: string;
    className: string;
    cardClassName: string;
    iconClassName: string;
    amountClassName: string;
  }
> = {
  pending: {
    label: "待處理",
    className: "border-amber-200/60 bg-amber-500/20 text-amber-100",
    cardClassName:
      "border-amber-300/45 bg-gradient-to-r from-amber-950/75 via-slate-900/90 to-yellow-950/45 hover:border-amber-200/75",
    iconClassName: "border-amber-200/45 bg-amber-500/20 text-amber-200",
    amountClassName: "text-amber-100",
  },
  approved: {
    label: "已核准",
    className: "border-emerald-200/60 bg-emerald-500/20 text-emerald-100",
    cardClassName:
      "border-emerald-300/45 bg-gradient-to-r from-emerald-950/75 via-slate-900/90 to-teal-950/45 hover:border-emerald-200/75",
    iconClassName: "border-emerald-200/45 bg-emerald-500/20 text-emerald-200",
    amountClassName: "text-emerald-100",
  },
  rejected: {
    label: "已拒絕",
    className: "border-rose-200/60 bg-rose-500/20 text-rose-100",
    cardClassName:
      "border-rose-300/45 bg-gradient-to-r from-rose-950/75 via-slate-900/90 to-red-950/45 hover:border-rose-200/75",
    iconClassName: "border-rose-200/45 bg-rose-500/20 text-rose-200",
    amountClassName: "text-rose-100",
  },
  cancelled: {
    label: "已取消",
    className: "border-slate-300/55 bg-slate-600/50 text-slate-100",
    cardClassName:
      "border-slate-400/40 bg-gradient-to-r from-slate-800/90 via-slate-900/90 to-slate-700/55 hover:border-slate-300/70",
    iconClassName: "border-slate-300/45 bg-slate-600/45 text-slate-200",
    amountClassName: "text-slate-100",
  },
};

interface EmployeeDetailModalProps {
  employee: Employee;
  onClose: () => void;
}

interface ImagePreview {
  images: { url: string; label: string }[];
  currentIndex: number;
  scale: number;
}

interface PageNavigatorProps {
  page: number;
  pageCount: number;
  onPageChange: (page: number) => void;
  tone: "cyan" | "amber" | "emerald";
  disabled?: boolean;
}

function PageNavigator({
  page,
  pageCount,
  onPageChange,
  tone,
  disabled = false,
}: PageNavigatorProps) {
  const [pageInput, setPageInput] = useState(String(page));
  const toneStyles = {
    cyan: {
      border: "border-cyan-200/60 bg-slate-950/90",
      text: "text-cyan-50",
      button: "border-cyan-200/55 bg-cyan-500/25 text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] hover:-translate-y-0.5 hover:border-cyan-100 hover:bg-cyan-400/45 hover:text-white hover:shadow-md",
    },
    amber: {
      border: "border-amber-200/60 bg-slate-950/90",
      text: "text-amber-50",
      button: "border-amber-200/55 bg-amber-500/25 text-amber-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] hover:-translate-y-0.5 hover:border-amber-100 hover:bg-amber-400/45 hover:text-white hover:shadow-md",
    },
    emerald: {
      border: "border-emerald-200/60 bg-slate-950/90",
      text: "text-emerald-50",
      button: "border-emerald-200/55 bg-emerald-500/25 text-emerald-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] hover:-translate-y-0.5 hover:border-emerald-100 hover:bg-emerald-400/45 hover:text-white hover:shadow-md",
    },
  }[tone];

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const commitPage = () => {
    const requestedPage = Number(pageInput);

    if (!Number.isInteger(requestedPage)) {
      setPageInput(String(page));
      return;
    }

    const nextPage = Math.min(pageCount, Math.max(1, requestedPage));
    setPageInput(String(nextPage));
    if (nextPage !== page) {
      onPageChange(nextPage);
    }
  };

  const buttonClass = `inline-flex h-8 w-8 items-center justify-center rounded-md border text-sm font-bold transition-all duration-150 active:translate-y-0 active:scale-[0.92] active:border-white active:bg-white active:text-slate-950 active:shadow-[0_0_0_2px_rgba(255,255,255,0.65)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/90 focus-visible:ring-offset-1 focus-visible:ring-offset-slate-950 disabled:translate-y-0 disabled:cursor-not-allowed disabled:border-slate-700/70 disabled:bg-slate-900/70 disabled:text-slate-600 disabled:shadow-none disabled:opacity-100 ${toneStyles.button}`;

  return (
    <div className={`flex items-center gap-1.5 rounded-xl border-2 p-1.5 shadow-lg shadow-slate-950/50 focus-within:ring-2 focus-within:ring-white/30 ${toneStyles.border}`}>
      <button
        type="button"
        onClick={() => onPageChange(1)}
        disabled={disabled || page === 1}
        aria-label="第一頁"
        title="第一頁"
        className={buttonClass}
      >
        <ChevronsLeft className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={disabled || page === 1}
        aria-label="上一頁"
        title="上一頁"
        className={buttonClass}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <div className={`flex items-center gap-1.5 px-1 text-xs font-bold tabular-nums ${toneStyles.text}`}>
        <input
          type="number"
          min={1}
          max={pageCount}
          inputMode="numeric"
          value={pageInput}
          onChange={(event) => setPageInput(event.target.value)}
          onBlur={commitPage}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitPage();
              event.currentTarget.blur();
            }
          }}
          disabled={disabled}
          aria-label="目前頁面"
          className="h-8 w-12 rounded-md border-2 border-white/90 bg-slate-100 px-1 text-center text-sm font-black text-slate-900 shadow-[inset_0_1px_2px_rgba(15,23,42,0.25)] outline-none transition-all focus:border-white focus:ring-2 focus:ring-white/90 focus:shadow-[0_0_0_2px_rgba(255,255,255,0.5)] disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-700 disabled:text-slate-300"
        />
        <span className="whitespace-nowrap">/ {pageCount}</span>
      </div>
      <button
        type="button"
        onClick={() => onPageChange(Math.min(pageCount, page + 1))}
        disabled={disabled || page === pageCount}
        aria-label="下一頁"
        title="下一頁"
        className={buttonClass}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onPageChange(pageCount)}
        disabled={disabled || page === pageCount}
        aria-label="最後一頁"
        title="最後一頁"
        className={buttonClass}
      >
        <ChevronsRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function EmployeeDetailModal({
  employee,
  onClose,
}: EmployeeDetailModalProps) {
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [totalOrderCount, setTotalOrderCount] = useState<number | null>(null);
  const [firstOrderDate, setFirstOrderDate] = useState<string | null>(null);
  const [totalTipAmount, setTotalTipAmount] = useState<number | null>(null);
  const [totalManualAdditionAmount, setTotalManualAdditionAmount] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [transactionTotalCount, setTransactionTotalCount] = useState<number | null>(null);
  const [transactionPage, setTransactionPage] = useState(1);
  const [transactionDateCounts, setTransactionDateCounts] = useState<Record<string, number>>({});
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [withdrawalTotalCount, setWithdrawalTotalCount] = useState<number | null>(null);
  const [verificationData, setVerificationData] = useState<VerificationRequest | null>(null);
  const [activeTab, setActiveTab] = useState<"daily" | "transactions" | "withdrawals" | "verification">("daily");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedTransactionDate, setSelectedTransactionDate] = useState("");
  const [isDateFilterOpen, setIsDateFilterOpen] = useState(false);
  const [withdrawalPage, setWithdrawalPage] = useState(1);
  const [walletBalance, setWalletBalance] = useState({
    available: 0,
    frozen: 0,
  });
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingTransactions, setLoadingTransactions] = useState(true);
  const [loadingWithdrawals, setLoadingWithdrawals] = useState(true);
  const [loadingVerification, setLoadingVerification] = useState(true);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [transactionError, setTransactionError] = useState<string | null>(null);
  const [transactionDateCountsError, setTransactionDateCountsError] = useState<string | null>(null);
  const [withdrawalError, setWithdrawalError] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [imageLoading, setImageLoading] = useState(false);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const loadControllerRef = useRef<AbortController | null>(null);
  const transactionDateCountsLoadedRef = useRef(false);
  const transactionRequestIdRef = useRef(0);
  const withdrawalRequestIdRef = useRef(0);
  const loadEmployeeDetailsRef = useRef<((signal: AbortSignal) => Promise<void>) | null>(null);
  const loadTransactionPageRef = useRef<((page: number, date: string, signal?: AbortSignal) => Promise<void>) | null>(null);
  const loadTransactionDateCountsRef = useRef<((signal?: AbortSignal) => Promise<void>) | null>(null);
  const loadWithdrawalPageRef = useRef<((page: number, signal?: AbortSignal) => Promise<void>) | null>(null);
  const nextImageRef = useRef<(() => void) | null>(null);
  const prevImageRef = useRef<(() => void) | null>(null);
  const zoomInRef = useRef<(() => void) | null>(null);
  const zoomOutRef = useRef<(() => void) | null>(null);
  const resetZoomRef = useRef<(() => void) | null>(null);
  const itemsPerPage = 10;
  const transactionPageSize = 100;
  const withdrawalPageSize = itemsPerPage;

  useEffect(() => {
    const controller = new AbortController();
    loadControllerRef.current?.abort();
    loadControllerRef.current = controller;
    transactionDateCountsLoadedRef.current = false;
    transactionRequestIdRef.current += 1;
    withdrawalRequestIdRef.current += 1;

    setSelectedTransactionDate("");
    setIsDateFilterOpen(false);
    setDailyStats([]);
    setTotalOrderCount(null);
    setFirstOrderDate(null);
    setTotalTipAmount(null);
    setTotalManualAdditionAmount(null);
    setTransactions([]);
    setTransactionTotalCount(null);
    setTransactionPage(1);
    setTransactionDateCounts({});
    setWithdrawalPage(1);
    setWithdrawals([]);
    setWithdrawalTotalCount(null);
    setVerificationData(null);
    setWalletBalance({ available: 0, frozen: 0 });
    setSummaryError(null);
    setTransactionError(null);
    setTransactionDateCountsError(null);
    setWithdrawalError(null);
    setLoadingStats(true);
    setLoadingTransactions(true);
    setLoadingWithdrawals(true);
    setLoadingVerification(true);
    setCurrentPage(1);
    void loadEmployeeDetailsRef.current?.(controller.signal);

    return () => {
      controller.abort();
      transactionRequestIdRef.current += 1;
      withdrawalRequestIdRef.current += 1;
      if (loadControllerRef.current === controller) {
        loadControllerRef.current = null;
      }
    };
  }, [employee.id]);

  useEffect(() => {
    if (activeTab !== "transactions" || transactionTotalCount !== null) {
      return;
    }

    void loadTransactionPageRef.current?.(1, "", loadControllerRef.current?.signal);
  }, [activeTab, employee.id, transactionTotalCount]);

  useEffect(() => {
    if (
      activeTab !== "transactions" ||
      transactionDateCountsLoadedRef.current
    ) {
      return;
    }

    transactionDateCountsLoadedRef.current = true;
    void loadTransactionDateCountsRef.current?.(loadControllerRef.current?.signal);
  }, [activeTab, employee.id]);

  useEffect(() => {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    };
  }, []);

  const loadTransactionPage = async (
    page: number,
    date: string,
    signal?: AbortSignal,
  ) => {
    const requestId = ++transactionRequestIdRef.current;
    setLoadingTransactions(true);
    setTransactionError(null);

    try {
      const { data, error } = await supabase
        .rpc("get_employee_transaction_page_for_admin", {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_user_id: employee.id,
          p_page: page,
          p_page_size: transactionPageSize,
          p_activity_date: date || null,
        })
        .abortSignal(signal ?? new AbortController().signal);

      if (signal?.aborted || requestId !== transactionRequestIdRef.current) {
        return;
      }
      if (error) throw error;
      if (!data) throw new Error("Transaction page response was empty.");

      setTransactions(data.rows);
      setTransactionTotalCount(data.total_count);
    } catch (error: unknown) {
      if (signal?.aborted || isSupabaseAbortError(error)) return;
      if (isFinancialAdminSessionError(error)) {
        setTransactionError("管理員登入已失效，請重新登入。");
        void logout(false);
        return;
      }
      if (requestId === transactionRequestIdRef.current) {
        console.error("Transaction page load error:", formatSupabaseError(error));
        setTransactionError("交易紀錄載入失敗，請重試。");
      }
    } finally {
      if (!signal?.aborted && requestId === transactionRequestIdRef.current) {
        setLoadingTransactions(false);
      }
    }
  };

  const loadTransactionDateCounts = async (signal?: AbortSignal) => {
    setTransactionDateCountsError(null);

    try {
      const { data, error } = await supabase
        .rpc("get_employee_transaction_date_counts_for_admin", {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_user_id: employee.id,
        })
        .abortSignal(signal ?? new AbortController().signal);

      if (signal?.aborted) return;
      if (error) throw error;

      setTransactionDateCounts(
        data.reduce<Record<string, number>>((counts, row) => {
          counts[row.date] = row.count;
          return counts;
        }, {}),
      );
    } catch (error: unknown) {
      if (signal?.aborted || isSupabaseAbortError(error)) return;
      transactionDateCountsLoadedRef.current = false;
      if (isFinancialAdminSessionError(error)) {
        setTransactionDateCountsError("管理員登入已失效，請重新登入。");
        void logout(false);
        return;
      }
      console.error("Transaction date counts load error:", formatSupabaseError(error));
      setTransactionDateCountsError("交易日期載入失敗，請重試。");
    }
  };

  const loadEmployeeSummary = async (signal: AbortSignal) => {
    setLoadingStats(true);
    setLoadingVerification(true);
    setSummaryError(null);

    try {
      const { data, error } = await supabase
        .rpc("get_employee_detail_summary_for_admin", {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_user_id: employee.id,
        })
        .abortSignal(signal);

      if (signal.aborted) return;
      if (error) throw error;
      if (!data) throw new Error("Employee detail summary response was empty.");

      setWalletBalance(data.wallet);
      setDailyStats(data.dailyStats);
      setTotalOrderCount(data.totalOrderCount);
      setFirstOrderDate(data.firstOrderDate);
      setTotalTipAmount(data.totalTipAmount);
      setTotalManualAdditionAmount(data.totalManualAdditionAmount);
      setVerificationData(data.verification);
    } catch (error: unknown) {
      if (signal.aborted || isSupabaseAbortError(error)) return;
      if (isFinancialAdminSessionError(error)) {
        setSummaryError("管理員登入已失效，請重新登入。");
        void logout(false);
        return;
      }
      console.error("Employee detail summary load error:", formatSupabaseError(error));
      setSummaryError("員工詳情載入失敗，請重試。");
    } finally {
      if (!signal.aborted) {
        setLoadingStats(false);
        setLoadingVerification(false);
      }
    }
  };

  const loadWithdrawalPage = async (page: number, signal?: AbortSignal) => {
    const requestId = ++withdrawalRequestIdRef.current;
    setLoadingWithdrawals(true);
    setWithdrawalError(null);

    try {
      const { data, error } = await supabase
        .rpc("get_employee_withdrawal_page_for_admin", {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_user_id: employee.id,
          p_page: page,
          p_page_size: withdrawalPageSize,
        })
        .abortSignal(signal ?? new AbortController().signal);

      if (signal?.aborted || requestId !== withdrawalRequestIdRef.current) {
        return;
      }
      if (error) throw error;
      if (!data) throw new Error("Withdrawal page response was empty.");

      setWithdrawals(data.rows);
      setWithdrawalTotalCount(data.total_count);
    } catch (error: unknown) {
      if (signal?.aborted || isSupabaseAbortError(error)) return;
      if (isFinancialAdminSessionError(error)) {
        setWithdrawalError("管理員登入已失效，請重新登入。");
        void logout(false);
        return;
      }
      if (requestId === withdrawalRequestIdRef.current) {
        console.error("Withdrawal page load error:", formatSupabaseError(error));
        setWithdrawalError("提現紀錄載入失敗，請重試。");
      }
    } finally {
      if (!signal?.aborted && requestId === withdrawalRequestIdRef.current) {
        setLoadingWithdrawals(false);
      }
    }
  };

  const loadEmployeeDetails = async (signal: AbortSignal) => {
    await Promise.all([
      loadEmployeeSummary(signal),
      loadWithdrawalPage(1, signal),
    ]);
  };

  const openImagePreview = () => {
    if (!verificationData) return;

    const images: { url: string; label: string }[] = [];

    if (verificationData.id_front_url) {
      images.push({ url: verificationData.id_front_url, label: '證件正面' });
    }
    if (verificationData.id_back_url) {
      images.push({ url: verificationData.id_back_url, label: '證件背面' });
    }
    if (verificationData.selfie_url) {
      images.push({ url: verificationData.selfie_url, label: '自拍照' });
    }

    if (images.length > 0) {
      setImagePreview({ images, currentIndex: 0, scale: 1 });
      setPosition({ x: 0, y: 0 });
      setImageLoading(!loadedImages.has(images[0].url));
    }
  };

  const closeImagePreview = () => {
    setImagePreview(null);
    setPosition({ x: 0, y: 0 });
    setImageLoading(false);
  };

  const handleImageLoad = (url: string) => {
    setLoadedImages(prev => new Set(prev).add(url));
    setImageLoading(false);
  };

  loadEmployeeDetailsRef.current = loadEmployeeDetails;
  loadTransactionPageRef.current = loadTransactionPage;
  loadTransactionDateCountsRef.current = loadTransactionDateCounts;
  loadWithdrawalPageRef.current = loadWithdrawalPage;

  const nextImage = () => {
    if (imagePreview && imagePreview.currentIndex < imagePreview.images.length - 1) {
      const nextIndex = imagePreview.currentIndex + 1;
      const nextUrl = imagePreview.images[nextIndex].url;
      setImagePreview({ ...imagePreview, currentIndex: nextIndex });
      setPosition({ x: 0, y: 0 });
      setImageLoading(!loadedImages.has(nextUrl));
    }
  };

  const prevImage = () => {
    if (imagePreview && imagePreview.currentIndex > 0) {
      const prevIndex = imagePreview.currentIndex - 1;
      const prevUrl = imagePreview.images[prevIndex].url;
      setImagePreview({ ...imagePreview, currentIndex: prevIndex });
      setPosition({ x: 0, y: 0 });
      setImageLoading(!loadedImages.has(prevUrl));
    }
  };

  const zoomIn = () => {
    if (imagePreview && imagePreview.scale < 3) {
      setImagePreview({ ...imagePreview, scale: imagePreview.scale + 0.25 });
    }
  };

  const zoomOut = () => {
    if (imagePreview && imagePreview.scale > 0.5) {
      setImagePreview({ ...imagePreview, scale: imagePreview.scale - 0.25 });
      if (imagePreview.scale <= 1) {
        setPosition({ x: 0, y: 0 });
      }
    }
  };

  const resetZoom = () => {
    if (imagePreview) {
      setImagePreview({ ...imagePreview, scale: 1 });
      setPosition({ x: 0, y: 0 });
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (imagePreview && imagePreview.scale > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && imagePreview && imagePreview.scale > 1) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  nextImageRef.current = nextImage;
  prevImageRef.current = prevImage;
  zoomInRef.current = zoomIn;
  zoomOutRef.current = zoomOut;
  resetZoomRef.current = resetZoom;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!imagePreview) return;

      if (e.key === 'Escape') {
        closeImagePreview();
      } else if (e.key === 'ArrowLeft' && imagePreview.currentIndex > 0) {
        prevImageRef.current?.();
      } else if (e.key === 'ArrowRight' && imagePreview.currentIndex < imagePreview.images.length - 1) {
        nextImageRef.current?.();
      } else if (e.key === '+' || e.key === '=') {
        zoomInRef.current?.();
      } else if (e.key === '-' || e.key === '_') {
        zoomOutRef.current?.();
      } else if (e.key === '0') {
        resetZoomRef.current?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [imagePreview]);

  const getTransactionTypeLabel = (type: string) => {
    const labels: Record<string, string> = {
      commission: "訂單佣金",
      withdrawal_request: "提現申請",
      withdrawal_approved: "提現已核准",
      withdrawal_rejected: "提現已拒絕",
      manual_adjustment: "管理員調整",
      tip: "小費",
    };
    return labels[type] || type;
  };

  const getTransactionStyle = (type: string, amount: number): {
    card: string;
    icon: string;
    iconBg: string;
    amount: string;
    meta: string;
    backgroundImage?: string;
  } => {
    if (amount < 0 && type !== "tip" && !type.startsWith("withdrawal_")) {
      return {
        card: "border-red-300/45 border-l-red-300 bg-red-950/40 hover:border-red-200/65 hover:bg-red-950/55",
        icon: "text-red-200",
        iconBg: "border-red-300/35 bg-red-950/70",
        amount: "text-red-200",
        meta: "text-red-100",
      };
    }

    const styles: Record<string, {
      card: string;
      icon: string;
      iconBg: string;
      amount: string;
      meta: string;
      backgroundImage?: string;
    }> = {
      commission: {
        card: "border-emerald-300/45 border-l-emerald-300 bg-emerald-950/35 hover:border-emerald-200/65 hover:bg-emerald-950/50",
        icon: "text-emerald-200",
        iconBg: "border-emerald-300/35 bg-emerald-950/70",
        amount: "text-emerald-200",
        meta: "text-emerald-100",
      },
      tip: {
        card: "border-violet-300/45 border-l-violet-300 bg-gradient-to-br from-violet-950/80 via-violet-950/55 to-amber-950/55 hover:border-violet-200/65 hover:from-violet-900/80 hover:to-amber-900/60",
        icon: "text-amber-200",
        iconBg: "border-amber-300/30 bg-violet-950/75",
        amount: "text-amber-100",
        meta: "text-amber-100",
      },
      withdrawal_request: {
        card: "border-amber-300/45 border-l-amber-300 bg-amber-950/35 hover:border-amber-200/65 hover:bg-amber-950/50",
        icon: "text-amber-100",
        iconBg: "border-amber-300/30 bg-amber-950/70",
        amount: "text-amber-100",
        meta: "text-amber-100",
      },
      withdrawal_approved: {
        card: "border-amber-300/45 border-l-amber-300 bg-amber-950/35 hover:border-amber-200/65 hover:bg-amber-950/50",
        icon: "text-amber-100",
        iconBg: "border-amber-300/30 bg-amber-950/70",
        amount: "text-amber-100",
        meta: "text-amber-100",
      },
      withdrawal_rejected: {
        card: "border-rose-300/50 border-l-rose-300 bg-rose-950/35 hover:border-rose-200/70 hover:bg-rose-950/50",
        icon: "text-rose-100",
        iconBg: "border-rose-300/35 bg-rose-950/70",
        amount: "text-rose-100",
        meta: "text-rose-100",
      },
      manual_adjustment: {
        card: "border-blue-300/45 border-l-blue-300 bg-blue-950/35 hover:border-blue-200/65 hover:bg-blue-950/50",
        icon: "text-blue-100",
        iconBg: "border-blue-300/35 bg-blue-950/70",
        amount: "text-blue-100",
        meta: "text-blue-100",
      },
    };

    return styles[type] ?? {
      card: "border-slate-500/60 border-l-slate-300 bg-slate-800/95 hover:border-slate-300/70",
      icon: "text-slate-200",
      iconBg: "border-slate-500/50 bg-slate-900/70",
      amount: "text-slate-100",
      meta: "text-slate-200",
    };
  };

  const availableTransactionDates = Object.keys(transactionDateCounts).sort((a, b) => b.localeCompare(a));

  return createPortal(
    <>
      {/* Image Preview Modal */}
      {imagePreview && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/90">
          <div className="relative max-w-7xl w-full h-[95vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between mb-4 px-4 py-3 bg-slate-900/90 backdrop-blur rounded-t-xl border border-slate-700">
              <div className="flex items-center gap-3">
                <FileText className="w-5 h-5 text-cyan-400" />
                <h3 className="text-lg font-bold text-white">
                  {imagePreview.images[imagePreview.currentIndex].label}
                </h3>
                <span className="text-sm text-slate-400">
                  {imagePreview.currentIndex + 1} / {imagePreview.images.length}
                </span>
                <span className="text-sm text-cyan-400 ml-2">
                  {Math.round(imagePreview.scale * 100)}%
                </span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={zoomOut}
                  disabled={imagePreview.scale <= 0.5}
                  className={`p-2 rounded-lg transition-all ${
                    imagePreview.scale <= 0.5
                      ? 'text-slate-600 cursor-not-allowed'
                      : 'hover:bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                  title="縮小"
                >
                  <ZoomOut className="w-5 h-5" />
                </button>
                <button
                  onClick={resetZoom}
                  className="p-2 hover:bg-slate-800 rounded-lg transition-all text-slate-400 hover:text-white"
                  title="重設縮放"
                >
                  <Maximize2 className="w-5 h-5" />
                </button>
                <button
                  onClick={zoomIn}
                  disabled={imagePreview.scale >= 3}
                  className={`p-2 rounded-lg transition-all ${
                    imagePreview.scale >= 3
                      ? 'text-slate-600 cursor-not-allowed'
                      : 'hover:bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                  title="放大"
                >
                  <ZoomIn className="w-5 h-5" />
                </button>
                <div className="w-px h-6 bg-slate-700 mx-2"></div>
                <button
                  onClick={closeImagePreview}
                  className="p-2 hover:bg-slate-800 rounded-lg transition-all text-slate-400 hover:text-white"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>

            {/* Image Container */}
            <div
              className="flex-1 relative bg-slate-900/90 backdrop-blur rounded-b-xl border border-slate-700 border-t-0 flex items-center justify-center overflow-hidden"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{ cursor: imagePreview.scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
            >
              {/* Loading Spinner */}
              {imageLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm z-20">
                  <div className="flex flex-col items-center gap-4">
                    <div className="relative w-16 h-16">
                      <div className="absolute inset-0 border-4 border-slate-700 rounded-full"></div>
                      <div className="absolute inset-0 border-4 border-transparent border-t-cyan-500 rounded-full animate-spin"></div>
                    </div>
                    <div className="text-cyan-400 font-medium">圖片載入中……</div>
                  </div>
                </div>
              )}

              <img
                src={imagePreview.images[imagePreview.currentIndex].url}
                alt={imagePreview.images[imagePreview.currentIndex].label}
                className="max-w-full max-h-full object-contain transition-transform select-none"
                style={{
                  transform: `scale(${imagePreview.scale}) translate(${position.x / imagePreview.scale}px, ${position.y / imagePreview.scale}px)`,
                  transformOrigin: 'center center',
                  opacity: imageLoading ? 0 : 1,
                  transition: 'opacity 0.3s ease-in-out'
                }}
                draggable={false}
                onLoad={() => handleImageLoad(imagePreview.images[imagePreview.currentIndex].url)}
                onError={() => setImageLoading(false)}
              />

              {/* Navigation Buttons */}
              {imagePreview.images.length > 1 && (
                <>
                  <button
                    onClick={prevImage}
                    disabled={imagePreview.currentIndex === 0}
                    className={`absolute left-4 p-3 rounded-full backdrop-blur-sm transition-all z-10 ${
                      imagePreview.currentIndex === 0
                        ? 'bg-slate-800/30 text-slate-600 cursor-not-allowed'
                        : 'bg-blue-950/35 text-white hover:bg-slate-700 hover:scale-110'
                    }`}
                  >
                    <ChevronLeft className="w-6 h-6" />
                  </button>
                  <button
                    onClick={nextImage}
                    disabled={imagePreview.currentIndex === imagePreview.images.length - 1}
                    className={`absolute right-4 p-3 rounded-full backdrop-blur-sm transition-all z-10 ${
                      imagePreview.currentIndex === imagePreview.images.length - 1
                        ? 'bg-slate-800/30 text-slate-600 cursor-not-allowed'
                        : 'bg-blue-950/35 text-white hover:bg-slate-700 hover:scale-110'
                    }`}
                  >
                    <ChevronRight className="w-6 h-6" />
                  </button>
                </>
              )}

              {/* Zoom Instructions */}
              {imagePreview.scale > 1 && (
                <div className="absolute bottom-4 left-1/2 transform -translate-x-1/2 px-4 py-2 bg-slate-900/80 backdrop-blur border border-slate-700 rounded-lg text-slate-300 text-sm">
                  按住並拖曳以平移圖片
                </div>
              )}
            </div>

            {/* Thumbnails */}
            {imagePreview.images.length > 1 && (
              <div className="flex justify-center gap-2 mt-4">
                {imagePreview.images.map((img, index) => (
                  <button
                    key={index}
                    onClick={() => {
                      setImagePreview({ ...imagePreview, currentIndex: index });
                      setPosition({ x: 0, y: 0 });
                      setImageLoading(!loadedImages.has(img.url));
                    }}
                    className={`px-4 py-2 rounded-lg font-medium transition-all ${
                      index === imagePreview.currentIndex
                        ? 'bg-cyan-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                    }`}
                  >
                    {img.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/65 p-3 backdrop-blur-sm sm:p-4">
      <div className="flex h-[92vh] min-h-0 w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-cyan-300/30 bg-slate-900 shadow-2xl shadow-blue-950/50 max-h-[92vh]">
        {/* Header */}
        <div className="shrink-0 bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 px-4 py-3.5 sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500/25 to-blue-600/25 text-cyan-300 ring-1 ring-inset ring-cyan-300/25">
                <User className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="truncate text-xl font-bold text-white sm:text-2xl">
                  {employee.username}
                </h2>
                <p className="mt-0.5 truncate text-xs text-slate-400 sm:text-sm">
                  員工 ID：<span className="font-mono text-cyan-200/90">{employee.employee_id}</span>
                </p>
                {employee.remarks && (
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-amber-300/80">
                    <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate" title={employee.remarks}>{employee.remarks}</span>
                  </div>
                )}
              </div>
            </div>
            <div className="flex min-w-0 items-stretch gap-2">
              <div className="grid min-w-0 flex-1 grid-cols-2 overflow-hidden rounded-xl border border-cyan-300/20 bg-slate-800/70 sm:grid-cols-5 lg:w-[680px] lg:flex-none">
                <div className="min-w-0 border-b border-slate-700/70 p-2.5 sm:border-b-0 sm:border-r">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-cyan-100">狀態</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${employee.is_active ? "border-emerald-300/40 bg-emerald-500/20 text-emerald-200" : "border-red-300/40 bg-red-500/20 text-red-200"}`}>
                      {employee.is_active ? "啟用" : "停用"}
                    </span>
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${employee.is_verified ? "border-emerald-300/40 bg-emerald-500/20 text-emerald-200" : "border-red-300/40 bg-red-500/20 text-red-200"}`}>
                      {employee.is_verified ? "已驗證" : "未驗證"}
                    </span>
                  </div>
                </div>
                <div className="min-w-0 border-b border-slate-700/70 p-2.5 sm:border-b-0 sm:border-r">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-200">總收入</p>
                  <p className="mt-1 truncate text-sm font-bold text-emerald-400">${employee.total_income.toFixed(2)}</p>
                </div>
                <div className="min-w-0 border-slate-700/70 p-2.5 sm:border-r">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-violet-200">錢包餘額</p>
                  <p className="mt-1 truncate text-sm font-bold text-purple-400">${walletBalance.available.toFixed(2)}</p>
                  {walletBalance.frozen > 0 && <p className="truncate text-[10px] text-slate-500">凍結：${walletBalance.frozen.toFixed(2)}</p>}
                </div>
                <div className="min-w-0 border-b border-slate-700/70 p-2.5 sm:border-b-0 sm:border-r">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-blue-300">總訂單數</p>
                  <p className="mt-1 truncate text-sm font-bold text-blue-400">
                    {totalOrderCount === null ? "—" : totalOrderCount.toLocaleString()}
                  </p>
                  <p className="truncate text-[10px] text-blue-200/70">全部歷史紀錄</p>
                </div>
                <div className="min-w-0 p-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-sky-200">加入日期</p>
                  <p className="mt-1 truncate text-xs font-bold text-white">{new Date(employee.created_at).toLocaleDateString("zh-CN")}</p>
                  {firstOrderDate && <p className="truncate text-[10px] text-sky-200/75">首筆訂單：{new Date(firstOrderDate).toLocaleDateString("zh-CN")}</p>}
                </div>
              </div>
              <button
                onClick={onClose}
                className="shrink-0 self-start rounded-xl border border-red-400/50 bg-red-500/15 p-2 text-red-300 transition-colors hover:border-red-300 hover:bg-red-500/30 hover:text-white lg:self-center"
                aria-label="關閉員工詳情"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="grid shrink-0 grid-cols-2 border-b border-cyan-300/20 border-t border-cyan-300/15 bg-gradient-to-r from-slate-900 via-blue-950 to-slate-900 sm:grid-cols-4">
          <button
            type="button"
            onClick={() => setActiveTab("daily")}
            aria-pressed={activeTab === "daily"}
            className={`group flex min-w-0 items-center justify-center gap-1.5 border-b-2 border-r border-cyan-300/15 px-2 py-2.5 text-[11px] font-semibold transition-colors even:border-r-0 sm:border-b-2 sm:border-r sm:last:border-r-0 sm:py-3 sm:text-xs ${
              activeTab === "daily"
                ? "border-cyan-100 bg-cyan-400/25 text-white shadow-[inset_0_-3px_0_rgba(103,232,249,0.95)]"
                : "text-slate-400 hover:bg-cyan-500/10 hover:text-cyan-100"
            }`}
          >
            <TrendingUp className={`h-4 w-4 shrink-0 ${activeTab === "daily" ? "text-cyan-100" : "text-cyan-300/70"}`} />
            <span className="truncate sm:whitespace-nowrap">每日統計</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("transactions")}
            aria-pressed={activeTab === "transactions"}
            className={`group flex min-w-0 items-center justify-center gap-1.5 border-b-2 border-r border-cyan-300/15 px-2 py-2.5 text-[11px] font-semibold transition-colors even:border-r-0 sm:border-b-2 sm:border-r sm:last:border-r-0 sm:py-3 sm:text-xs ${
              activeTab === "transactions"
                ? "border-emerald-100 bg-emerald-400/25 text-white shadow-[inset_0_-3px_0_rgba(52,211,153,0.95)]"
                : "text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-100"
            }`}
          >
            <DollarSign className={`h-4 w-4 shrink-0 ${activeTab === "transactions" ? "text-emerald-100" : "text-emerald-300/70"}`} />
            <span className="truncate sm:whitespace-nowrap">交易紀錄</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("withdrawals")}
            aria-pressed={activeTab === "withdrawals"}
            className={`group flex min-w-0 items-center justify-center gap-1.5 border-b-2 border-r border-cyan-300/15 px-2 py-2.5 text-[11px] font-semibold transition-colors even:border-r-0 sm:border-b-2 sm:border-r sm:last:border-r-0 sm:py-3 sm:text-xs ${
              activeTab === "withdrawals"
                ? "border-amber-100 bg-amber-400/25 text-white shadow-[inset_0_-3px_0_rgba(251,191,36,0.95)]"
                : "text-slate-400 hover:bg-amber-500/10 hover:text-amber-100"
            }`}
          >
            <Wallet className={`h-4 w-4 shrink-0 ${activeTab === "withdrawals" ? "text-amber-100" : "text-amber-300/70"}`} />
            <span className="truncate sm:whitespace-nowrap">提現紀錄</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("verification")}
            aria-pressed={activeTab === "verification"}
            className={`group flex min-w-0 items-center justify-center gap-1.5 border-b-2 border-r border-cyan-300/15 px-2 py-2.5 text-[11px] font-semibold transition-colors even:border-r-0 sm:border-b-2 sm:border-r sm:last:border-r-0 sm:py-3 sm:text-xs ${
              activeTab === "verification"
                ? "border-violet-100 bg-violet-400/25 text-white shadow-[inset_0_-3px_0_rgba(196,181,253,0.95)]"
                : "text-slate-400 hover:bg-violet-500/10 hover:text-violet-100"
            }`}
          >
            <Shield className={`h-4 w-4 shrink-0 ${activeTab === "verification" ? "text-violet-100" : "text-violet-300/70"}`} />
            <span className="truncate sm:whitespace-nowrap">驗證資訊</span>
          </button>
        </div>

        {/* Content */}
        <div className={`employee-detail-scrollbar employee-detail-scrollbar--${activeTab === "withdrawals" ? "amber" : activeTab === "verification" ? "violet" : "cyan"} min-h-0 flex-1 overflow-y-auto bg-slate-900 ${activeTab === "transactions" || activeTab === "withdrawals" ? "p-0" : "p-4 sm:p-5"}`}>
          <div className={activeTab === "daily" ? "-mx-4 -my-4 min-h-full space-y-0 sm:-mx-5 sm:-my-5" : "hidden"}>
            {summaryError ? (
              <div className="mx-4 mt-4 flex items-center justify-between gap-3 rounded-lg border border-red-300/30 bg-red-950/35 px-3 py-2 text-xs text-red-100 sm:mx-5">
                <span>{summaryError}</span>
                <button
                  type="button"
                  onClick={() => void loadEmployeeSummary(loadControllerRef.current?.signal ?? new AbortController().signal)}
                  className="shrink-0 rounded-md border border-red-200/40 bg-red-500/15 px-2.5 py-1 font-bold text-red-100 hover:bg-red-500/30"
                >
                  重試
                </button>
              </div>
            ) : loadingStats ? (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <div className="w-10 h-10 border-4 border-cyan-500/25 border-t-cyan-300 rounded-full animate-spin"></div>
                <div className="text-slate-400 text-sm">
                  正在載入統計資料……
                </div>
              </div>
            ) : dailyStats.length === 0 ? (
              <div className="flex min-h-[360px] items-center justify-center text-center text-slate-400">
                沒有可用的訂單資料
              </div>
            ) : (
              <>
                {/* Overall Statistics Summary */}
                <div className="w-full border-b border-cyan-300/20 px-4 pb-3 pt-3 sm:px-5">
                  <div className="mb-3 flex items-center gap-2">
                    <TrendingUp className="h-4 w-4 text-cyan-300" />
                    <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">
                      整體統計
                    </h3>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-[5fr_5fr_5fr_3fr_3fr_3fr]">
                    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-blue-950/35 px-2.5 py-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <DollarSign className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                        <span className="truncate text-[10px] font-bold text-emerald-300">
                          總營收
                        </span>
                      </div>
                      <div className="shrink-0 text-sm font-black leading-none text-emerald-400">
                        $
                        {dailyStats
                          .reduce((sum, stat) => sum + stat.totalCommission, 0)
                          .toFixed(2)}
                      </div>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-violet-500/30 bg-blue-950/35 px-2.5 py-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <Gift className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                        <span className="truncate text-[10px] font-bold text-violet-200">
                          小費金額
                        </span>
                      </div>
                      <div className="shrink-0 text-sm font-black leading-none text-violet-200">
                        {totalTipAmount === null ? "—" : `$${totalTipAmount.toFixed(2)}`}
                      </div>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-sky-500/30 bg-blue-950/35 px-2.5 py-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <CreditCard className="h-3.5 w-3.5 shrink-0 text-sky-300" />
                        <span className="truncate text-[10px] font-bold text-sky-200">
                          管理員新增
                        </span>
                      </div>
                      <div className="shrink-0 text-sm font-black leading-none text-sky-200">
                        {totalManualAdditionAmount === null ? "—" : `$${totalManualAdditionAmount.toFixed(2)}`}
                      </div>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-blue-500/30 bg-blue-950/35 px-2.5 py-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <TrendingUp className="h-3.5 w-3.5 shrink-0 text-blue-400" />
                        <span className="truncate text-[10px] font-bold text-blue-300">
                          訂單數
                        </span>
                      </div>
                      <div className="shrink-0 text-sm font-black leading-none text-blue-200">
                        {dailyStats.reduce(
                          (sum, stat) => sum + stat.totalOrders,
                          0,
                        )}
                      </div>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-green-500/30 bg-blue-950/35 px-2.5 py-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <CheckCircle className="h-3.5 w-3.5 shrink-0 text-green-400" />
                        <span className="truncate text-[10px] font-bold text-green-300">
                          成功
                        </span>
                      </div>
                      <div className="shrink-0 text-sm font-black leading-none text-green-400">
                        {dailyStats.reduce(
                          (sum, stat) => sum + stat.successCount,
                          0,
                        )}
                      </div>
                    </div>
                    <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-red-500/30 bg-blue-950/35 px-2.5 py-2">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-red-400" />
                        <span className="truncate text-[10px] font-bold text-red-300">
                          失敗
                        </span>
                      </div>
                      <div className="shrink-0 text-sm font-black leading-none text-red-400">
                        {dailyStats.reduce(
                          (sum, stat) => sum + stat.failureCount,
                          0,
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Daily Breakdown with Pagination */}
                <div className="w-full overflow-hidden">
                  <div className="flex flex-col gap-3 border-b border-slate-600/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                    <div>
                      <h3 className="text-sm font-bold uppercase tracking-wider text-slate-200">
                        每日明細
                      </h3>
                      <p className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-cyan-300/25 bg-cyan-500/10 px-2.5 py-1 text-xs font-semibold tracking-wide text-cyan-100">
                        <Calendar className="h-3.5 w-3.5 text-cyan-300" />
                        <span>{dailyStats.length} 天的活動紀錄</span>
                      </p>
                    </div>
                    {dailyStats.length > itemsPerPage && (
                      <PageNavigator
                        page={currentPage}
                        pageCount={Math.ceil(dailyStats.length / itemsPerPage)}
                        onPageChange={setCurrentPage}
                        tone="cyan"
                      />
                    )}
                  </div>
                  <div className="employee-detail-scrollbar employee-detail-scrollbar--cyan overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b border-cyan-300/20 bg-blue-950/45">
                          <th className="text-left px-4 py-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
                            <div className="flex items-center gap-2">
                              <Calendar className="w-3.5 h-3.5 text-blue-400" />
                              日期
                            </div>
                          </th>
                          <th className="text-center px-3 py-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
                            <div className="flex items-center justify-center gap-1.5">
                              <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
                              總數
                            </div>
                          </th>
                          <th className="text-center px-3 py-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
                            <div className="flex items-center justify-center gap-1.5">
                              <CheckCircle className="w-3.5 h-3.5 text-green-400" />
                              成功
                            </div>
                          </th>
                          <th className="text-center px-3 py-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
                            <div className="flex items-center justify-center gap-1.5">
                              <XCircle className="w-3.5 h-3.5 text-red-400" />
                              失敗
                            </div>
                          </th>
                          <th className="text-right px-4 py-2 text-xs font-bold text-slate-300 uppercase tracking-wider">
                            <div className="flex items-center justify-end gap-1.5">
                              <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                              收益
                            </div>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {dailyStats
                          .slice(
                            (currentPage - 1) * itemsPerPage,
                            currentPage * itemsPerPage,
                          )
                          .map((stat, index) => (
                            <tr
                              key={`${stat.date}-${index}`}
                              className="border-b border-slate-700/20 hover:bg-slate-700/30 transition-colors"
                            >
                              <td className="px-4 py-2">
                                <div className="flex items-center gap-2">
                                  <div className="w-1 h-1 rounded-full bg-blue-400"></div>
                                  <span className="text-sm text-slate-200 font-medium">
                                    {stat.date.split("-").join("/")}
                                  </span>
                                </div>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className="text-sm font-bold text-white">
                                  {stat.totalOrders}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className="text-sm font-bold text-green-400">
                                  {stat.successCount}
                                </span>
                              </td>
                              <td className="px-3 py-2 text-center">
                                <span className="text-sm font-bold text-red-400">
                                  {stat.failureCount}
                                </span>
                              </td>
                              <td className="px-4 py-2 text-right">
                                <span className="text-sm font-bold text-emerald-400">
                                  ${stat.totalCommission.toFixed(2)}
                                </span>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </div>

          <div
            className={activeTab === "transactions" ? "space-y-0" : "hidden"}
          >
            {transactionError && (
              <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-300/30 bg-red-950/35 px-3 py-2 text-xs text-red-100 sm:mx-5">
                <span>{transactionError}</span>
                <button
                  type="button"
                  onClick={() => void loadTransactionPageRef.current?.(transactionPage, selectedTransactionDate, loadControllerRef.current?.signal)}
                  className="shrink-0 rounded-md border border-red-200/40 bg-red-500/15 px-2.5 py-1 font-bold text-red-100 hover:bg-red-500/30"
                >
                  重試
                </button>
              </div>
            )}
            {transactionDateCountsError && (
              <div className="mx-4 mt-2 flex items-center justify-between gap-3 rounded-lg border border-amber-300/30 bg-amber-950/35 px-3 py-2 text-xs text-amber-100 sm:mx-5">
                <span>{transactionDateCountsError}</span>
                <button
                  type="button"
                  onClick={() => {
                    transactionDateCountsLoadedRef.current = true;
                    void loadTransactionDateCountsRef.current?.(loadControllerRef.current?.signal);
                  }}
                  className="shrink-0 rounded-md border border-amber-200/40 bg-amber-500/15 px-2.5 py-1 font-bold text-amber-100 hover:bg-amber-500/30"
                >
                  重試
                </button>
              </div>
            )}
            {loadingTransactions && transactions.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <div className="w-10 h-10 border-4 border-cyan-500/25 border-t-cyan-300 rounded-full animate-spin"></div>
                <div className="text-slate-400 text-sm">
                  正在載入交易紀錄……
                </div>
              </div>
            ) : transactions.length === 0 && transactionError ? null : transactions.length === 0 ? (
              <div className="flex min-h-[360px] items-center justify-center text-center text-slate-400">
                沒有可用的交易歷史紀錄
              </div>
            ) : (
              <>
                <div className="sticky top-0 z-30 flex flex-col gap-2 border-b border-cyan-300/25 bg-slate-900 px-4 py-2 shadow-lg shadow-slate-950/30 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-300/25 bg-cyan-500/10">
                      <DollarSign className="h-4 w-4 text-cyan-300" />
                    </div>
                    <div>
                      <p className="text-xs font-bold text-slate-100">Transaction History</p>
                      <p className="mt-0.5 inline-flex items-baseline gap-1.5 rounded-md border border-cyan-300/30 bg-cyan-500/15 px-2 py-0.5">
                        <span className="text-base font-black leading-none tabular-nums text-cyan-50">
                          {transactionTotalCount === null ? "—" : transactionTotalCount.toLocaleString()}
                        </span>
                        <span className="text-[10px] font-bold uppercase tracking-wide text-cyan-200">
                          {selectedTransactionDate ? "符合的錢包紀錄" : "所有錢包紀錄"}
                        </span>
                      </p>
                    </div>
                  </div>
                  <div className="relative flex items-center gap-2 self-start sm:self-center">
                    {selectedTransactionDate && (
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedTransactionDate("");
                          setTransactionPage(1);
                          void loadTransactionPageRef.current?.(1, "", loadControllerRef.current?.signal);
                        }}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-blue-300/35 bg-blue-950/80 px-2.5 text-xs font-semibold text-blue-100 transition-colors hover:border-blue-200/55 hover:bg-blue-900/90 hover:text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                        所有日期
                      </button>
                    )}
                    <div className="relative">
                      <button
                        type="button"
                        onClick={() => setIsDateFilterOpen((open) => !open)}
                        aria-expanded={isDateFilterOpen}
                        aria-haspopup="listbox"
                        className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors ${
                          selectedTransactionDate
                            ? "border-cyan-200/60 bg-cyan-500/15 text-cyan-50"
                            : "border-slate-600/70 bg-slate-800 text-slate-300 hover:border-cyan-300/45 hover:bg-cyan-500/10 hover:text-cyan-100"
                        }`}
                      >
                        <Calendar className="h-3.5 w-3.5 text-cyan-300" />
                        <span>
                          {selectedTransactionDate
                            ? selectedTransactionDate.split("-").join("/")
                            : "選擇日期"}
                        </span>
                        <ChevronDown className={`h-3.5 w-3.5 transition-transform ${isDateFilterOpen ? "rotate-180" : ""}`} />
                      </button>
                      {isDateFilterOpen && (
                        <div
                          className="absolute right-0 top-full z-50 mt-2 w-60 overflow-hidden rounded-xl border border-cyan-300/30 bg-slate-950 shadow-2xl shadow-slate-950/80"
                          aria-label="可用交易日期"
                        >
                          <div className="flex items-center justify-between gap-3 border-b border-cyan-300/20 bg-blue-950/80 px-3 py-2">
                            <p className="text-[10px] font-bold uppercase tracking-wider text-cyan-200">
                              活動日期
                            </p>
                            <p className="shrink-0 text-[11px] font-semibold tabular-nums text-slate-300">
                              {availableTransactionDates.length} 個有紀錄的日期
                            </p>
                          </div>
                          <div
                            className="employee-detail-scrollbar employee-detail-scrollbar--cyan max-h-64 overscroll-contain overflow-y-auto p-1"
                            role="listbox"
                          >
                            {availableTransactionDates.map((date) => (
                              <button
                                key={date}
                                type="button"
                                onClick={() => {
                                  setSelectedTransactionDate(date);
                                  setTransactionPage(1);
                                  setIsDateFilterOpen(false);
                                  void loadTransactionPage(1, date, loadControllerRef.current?.signal);
                                }}
                                className={`flex w-full items-center justify-between gap-3 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                                  selectedTransactionDate === date
                                    ? "border-cyan-300/35 bg-cyan-950/65 text-cyan-50"
                                    : "border-slate-800/80 bg-slate-900 text-slate-300 hover:border-cyan-300/25 hover:bg-slate-800 hover:text-cyan-100"
                                }`}
                                role="option"
                                aria-selected={selectedTransactionDate === date}
                              >
                                <span className="text-[13px] font-semibold tabular-nums">
                                  {date.split("-").join("/")}
                                </span>
                                <span className="shrink-0 text-[11px] font-semibold tabular-nums text-amber-200/90">
                                  {transactionDateCounts[date]} 筆紀錄
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                    <PageNavigator
                      page={transactionPage}
                      pageCount={Math.max(1, Math.ceil((transactionTotalCount ?? 0) / transactionPageSize))}
                      onPageChange={(page) => {
                        setTransactionPage(page);
                        void loadTransactionPage(page, selectedTransactionDate, loadControllerRef.current?.signal);
                      }}
                      tone="cyan"
                      disabled={loadingTransactions}
                    />
                  </div>
                </div>

                {/* Transaction List */}
                <div className="relative px-4 pt-3 sm:px-5">
                  {loadingTransactions && (
                    <div className="pointer-events-none absolute inset-x-4 top-3 z-10 flex items-center justify-center sm:inset-x-5">
                      <div className="inline-flex items-center gap-2 rounded-full border border-cyan-300/35 bg-slate-950/90 px-3 py-1.5 text-[11px] font-semibold text-cyan-100 shadow-lg shadow-slate-950/40">
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-cyan-300/30 border-t-cyan-200"></span>
                        正在載入頁面……
                      </div>
                    </div>
                  )}
                  <div className={`space-y-2.5 transition-opacity ${loadingTransactions ? "opacity-45" : ""}`}>
                    {transactions.map((tx) => {
                      const style = getTransactionStyle(tx.type, Number(tx.amount));
                      const activityDate = tx.activity_date;
                      const icon =
                        tx.type === "commission" ? (
                          <TrendingUp className={`h-4 w-4 ${style.icon}`} />
                        ) : tx.type === "tip" ? (
                          <DollarSign className={`h-4 w-4 ${style.icon}`} />
                        ) : tx.type === "withdrawal_request" ? (
                          <Clock className={`h-4 w-4 ${style.icon}`} />
                        ) : tx.type === "withdrawal_approved" ? (
                          <CheckCircle className={`h-4 w-4 ${style.icon}`} />
                        ) : tx.type === "withdrawal_rejected" ? (
                          <XCircle className={`h-4 w-4 ${style.icon}`} />
                        ) : (
                          <Wallet className={`h-4 w-4 ${style.icon}`} />
                        );

                      return (
                        <div
                          key={tx.id}
                          className={`rounded-xl border border-l-4 p-3 shadow-sm shadow-slate-950/25 transition-all ${style.card}`}
                          style={style.backgroundImage ? {
                            backgroundImage: style.backgroundImage,
                            backgroundBlendMode: "screen",
                          } : undefined}
                        >
                          <div className="flex items-start gap-3">
                            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${style.iconBg}`}>
                              {icon}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <span className="text-sm font-semibold text-slate-100">
                                  {getTransactionTypeLabel(tx.type)}
                                </span>
                                <span className={`text-base font-black ${style.amount}`}>
                                  {Number(tx.amount) >= 0 ? "+" : "-"}${Math.abs(Number(tx.amount)).toFixed(2)}
                                </span>
                              </div>
                              {tx.remarks && (
                                <div className="mt-1 break-words text-[11px] leading-relaxed text-slate-300">
                                  <span className="font-semibold text-slate-500">Note:</span> {tx.remarks}
                                </div>
                              )}
                            </div>
                            <div className="shrink-0 text-right text-[10px] font-normal leading-tight sm:text-[11px]">
                              <div>
                                <span className="inline-block w-11 text-left text-slate-400">調整前</span>
                                <span className={style.meta}>${Number(tx.balance_before).toFixed(2)}</span>
                              </div>
                              <div>
                                <span className="inline-block w-11 text-left text-slate-400">調整後</span>
                                <span className={style.meta}>${Number(tx.balance_after).toFixed(2)}</span>
                              </div>
                              <div className="mt-0.5 whitespace-nowrap text-white">
                                {activityDate ? activityDate.split("-").join("/") : "日期不詳"}
                                <span className="ml-1 text-slate-300">
                                  {tx.created_at
                                    ? new Date(tx.created_at).toLocaleTimeString("zh-CN", {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })
                                    : "—"}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          <div
            className={activeTab === "withdrawals" ? "space-y-0" : "hidden"}
          >
            {withdrawalError && (
              <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-lg border border-red-300/30 bg-red-950/35 px-3 py-2 text-xs text-red-100 sm:mx-5">
                <span>{withdrawalError}</span>
                <button
                  type="button"
                  onClick={() => void loadWithdrawalPageRef.current?.(withdrawalPage, loadControllerRef.current?.signal)}
                  className="shrink-0 rounded-md border border-red-200/40 bg-red-500/15 px-2.5 py-1 font-bold text-red-100 hover:bg-red-500/30"
                >
                  重試
                </button>
              </div>
            )}
            {loadingWithdrawals && withdrawals.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center gap-3">
                <div className="h-10 w-10 animate-spin rounded-full border-4 border-amber-500/25 border-t-amber-300"></div>
                <div className="text-sm text-slate-400">正在載入提現紀錄……</div>
              </div>
            ) : withdrawals.length === 0 && withdrawalError ? null : withdrawals.length === 0 ? (
              <div className="flex min-h-[360px] items-center justify-center text-center text-slate-400">
                沒有可用的提現紀錄
              </div>
            ) : (
              <>
                <div className="sticky top-0 z-30 flex flex-col gap-2 border-b border-amber-300/25 bg-slate-900 px-4 py-2 shadow-lg shadow-slate-950/30 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-amber-300/25 bg-amber-500/10">
                      <Wallet className="h-4 w-4 text-amber-300" />
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-xs font-bold text-slate-100">提現紀錄</p>
                      <p className="inline-flex items-center gap-1.5 rounded-md border border-amber-300/30 bg-amber-500/15 px-2 py-0.5">
                        <FileText className="h-3 w-3 text-amber-300" />
                        <span className="text-base font-black leading-none tabular-nums text-amber-50">
                          {withdrawalTotalCount === null ? "—" : withdrawalTotalCount.toLocaleString()}
                        </span>
                        <span className="text-[10px] font-bold uppercase tracking-wide text-amber-200">
                          總數
                        </span>
                      </p>
                    </div>
                  </div>
                  {(withdrawalTotalCount ?? 0) > withdrawalPageSize && (
                    <PageNavigator
                      page={withdrawalPage}
                      pageCount={Math.max(1, Math.ceil((withdrawalTotalCount ?? 0) / withdrawalPageSize))}
                      onPageChange={(page) => {
                        setWithdrawalPage(page);
                        void loadWithdrawalPageRef.current?.(page, loadControllerRef.current?.signal);
                      }}
                      tone="amber"
                    />
                  )}
                </div>

                <div className="relative px-4 pt-3 sm:px-5">
                  {loadingWithdrawals && (
                    <div className="pointer-events-none absolute inset-x-4 top-3 z-10 flex items-center justify-center sm:inset-x-5">
                      <div className="inline-flex items-center gap-2 rounded-full border border-amber-300/35 bg-slate-950/90 px-3 py-1.5 text-[11px] font-semibold text-amber-100 shadow-lg shadow-slate-950/40">
                        <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-300/30 border-t-amber-200"></span>
                        正在載入頁面……
                      </div>
                    </div>
                  )}
                  <div className={`space-y-2.5 transition-opacity ${loadingWithdrawals ? "opacity-45" : ""}`}>
                    {withdrawals.map((withdrawal) => {
                      const status = withdrawalStatusConfig[withdrawal.status] ?? {
                        label: withdrawal.status,
                        className: "border-slate-300/55 bg-slate-600/50 text-slate-100",
                        cardClassName:
                          "border-slate-400/40 bg-gradient-to-r from-slate-800/90 via-slate-900/90 to-slate-700/55 hover:border-slate-300/70",
                        iconClassName: "border-slate-300/45 bg-slate-600/45 text-slate-200",
                        amountClassName: "text-slate-100",
                      };

                      return (
                        <div
                          key={withdrawal.id}
                          className={`rounded-lg border p-2.5 shadow-sm shadow-slate-950/20 transition-colors ${status.cardClassName}`}
                        >
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div className="flex min-w-0 items-start gap-2">
                              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${status.iconClassName}`}>
                                {withdrawal.status === "approved" ? (
                                  <CheckCircle className="h-4 w-4" />
                                ) : withdrawal.status === "rejected" ? (
                                  <XCircle className="h-4 w-4" />
                                ) : withdrawal.status === "cancelled" ? (
                                  <Ban className="h-4 w-4" />
                                ) : (
                                  <Clock className="h-4 w-4" />
                                )}
                              </div>
                              <div className="min-w-0">
                                <p className="truncate text-xs font-bold text-slate-100">提現申請</p>
                                <p className="mt-0.5 truncate text-[10px] text-slate-300/80">
                                  提交時間 {new Date(withdrawal.created_at).toLocaleString("zh-CN")}
                                </p>
                              </div>
                            </div>
                            <div className="shrink-0 text-right">
                              <p className={`text-base font-black leading-none ${status.amountClassName}`}>
                                -${Number(withdrawal.amount).toFixed(2)}
                              </p>
                              <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${status.className}`}>
                                {status.label}
                              </span>
                            </div>
                          </div>
                          {(withdrawal.audit_remark || withdrawal.audited_at) && (
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 border-t border-white/10 pt-2 text-[10px] leading-tight text-slate-300/80">
                              {withdrawal.audited_at && (
                                <span>處理時間 {new Date(withdrawal.audited_at).toLocaleString("zh-CN")}</span>
                              )}
                              {withdrawal.audit_remark && (
                                <span className="text-slate-100/85">備註：{withdrawal.audit_remark}</span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>

          <div
            className={activeTab === "verification" ? "space-y-4" : "hidden"}
          >
            {summaryError ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-red-300/30 bg-red-950/35 px-3 py-2 text-xs text-red-100">
                <span>{summaryError}</span>
                <button
                  type="button"
                  onClick={() => void loadEmployeeSummary(loadControllerRef.current?.signal ?? new AbortController().signal)}
                  className="shrink-0 rounded-md border border-red-200/40 bg-red-500/15 px-2.5 py-1 font-bold text-red-100 hover:bg-red-500/30"
                >
                  重試
                </button>
              </div>
            ) : loadingVerification ? (
              <div className="flex flex-col items-center justify-center h-48 gap-3">
                <div className="w-10 h-10 border-4 border-cyan-500/25 border-t-cyan-300 rounded-full animate-spin"></div>
                <div className="text-slate-400 text-sm">
                  正在載入驗證資訊……
                </div>
              </div>
            ) : !verificationData ? (
              <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
                <FileText className="mb-4 h-8 w-8 text-cyan-300/60" />
                <p className="mb-2 text-lg font-medium text-slate-300">
                  尚未提交驗證
                </p>
                <p className="text-sm text-slate-400">
                  此員工尚未提交驗證資訊。
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {/* Status Badge */}
                <div className="rounded-xl border border-cyan-300/20 bg-gradient-to-br from-blue-950/45 via-slate-800/65 to-cyan-950/25 p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider">
                      驗證狀態
                    </h3>
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-bold ${
                        verificationData.status === "approved"
                          ? "bg-green-500/20 text-green-400 border border-green-500/50"
                          : verificationData.status === "rejected"
                          ? "bg-red-500/20 text-red-400 border border-red-500/50"
                          : "bg-yellow-500/20 text-yellow-400 border border-yellow-500/50"
                      }`}
                    >
                      {verificationData.status === "approved" ? "已核准" : verificationData.status === "rejected" ? "已拒絕" : "待處理"}
                    </span>
                  </div>
                  {verificationData.audit_remark && (
                    <div className="mt-3 rounded-lg border border-cyan-300/15 bg-blue-950/40 p-3">
                      <p className="text-xs text-slate-400 mb-1">管理員備註：</p>
                      <p className="text-sm text-white">{verificationData.audit_remark}</p>
                    </div>
                  )}
                  {verificationData.audited_at && (
                    <div className="mt-2 text-xs text-slate-500">
                      審核時間 {new Date(verificationData.audited_at).toLocaleString("zh-CN")}
                    </div>
                  )}
                </div>

                {/* 個人資訊 */}
                <div className="overflow-hidden rounded-xl border border-cyan-300/20 bg-gradient-to-br from-blue-950/45 via-slate-800/65 to-cyan-950/25">
                  <div className="border-b border-cyan-300/15 bg-blue-950/30 p-4">
                    <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                      <User className="w-4 h-4 text-blue-400" />
                      個人資訊
                    </h3>
                  </div>
                  <div className="p-4 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="rounded-lg border border-cyan-300/15 bg-blue-950/25 p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <User className="w-4 h-4 text-blue-400" />
                          <span className="text-xs text-slate-400 font-medium">真實姓名</span>
                        </div>
                        <p className="text-white font-semibold">{verificationData.real_name}</p>
                      </div>
                      <div className="rounded-lg border border-cyan-300/15 bg-blue-950/25 p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <Phone className="w-4 h-4 text-green-400" />
                          <span className="text-xs text-slate-400 font-medium">電話號碼</span>
                        </div>
                        <p className="text-white font-semibold">{verificationData.phone}</p>
                      </div>
                      <div className="rounded-lg border border-cyan-300/15 bg-blue-950/25 p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <Mail className="w-4 h-4 text-purple-400" />
                          <span className="text-xs text-slate-400 font-medium">電子郵件地址</span>
                        </div>
                        <p className="text-white font-semibold break-all">{verificationData.email}</p>
                      </div>
                      <div className="rounded-lg border border-cyan-300/15 bg-blue-950/25 p-3">
                        <div className="flex items-center gap-2 mb-1">
                          <CreditCard className="w-4 h-4 text-amber-400" />
                          <span className="text-xs text-slate-400 font-medium">錢包地址</span>
                        </div>
                        <p className="text-white font-mono text-xs break-all">{verificationData.wallet_address}</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Document Images */}
                {(verificationData.id_front_url || verificationData.id_back_url || verificationData.selfie_url) && (
                  <div className="overflow-hidden rounded-xl border border-cyan-300/20 bg-gradient-to-br from-blue-950/45 via-slate-800/65 to-cyan-950/25">
                    <div className="border-b border-cyan-300/15 bg-blue-950/30 p-4">
                      <h3 className="text-sm font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                        <FileText className="w-4 h-4 text-blue-400" />
                        驗證文件
                      </h3>
                    </div>
                    <div className="p-4">
                      <button
                        onClick={openImagePreview}
                        className="w-full px-4 py-3 bg-gradient-to-r from-cyan-600/20 to-blue-600/20 hover:from-cyan-600/30 hover:to-blue-600/30 border border-cyan-500/50 rounded-lg text-cyan-300 font-medium transition-all flex items-center justify-center gap-2 mb-4"
                      >
                        <Eye className="w-4 h-4" />
                        檢視驗證文件
                      </button>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        {verificationData.id_front_url && (
                          <div className="rounded-lg border border-cyan-300/15 bg-blue-950/25 p-3">
                            <p className="text-xs text-slate-400 font-medium mb-2">證件正面</p>
                            <div className="flex h-24 w-full items-center justify-center rounded border border-cyan-300/20 bg-blue-950/35">
                              <FileText className="w-8 h-8 text-slate-500" />
                            </div>
                          </div>
                        )}
                        {verificationData.id_back_url && (
                          <div className="rounded-lg border border-cyan-300/15 bg-blue-950/25 p-3">
                            <p className="text-xs text-slate-400 font-medium mb-2">證件背面</p>
                            <div className="flex h-24 w-full items-center justify-center rounded border border-cyan-300/20 bg-blue-950/35">
                              <FileText className="w-8 h-8 text-slate-500" />
                            </div>
                          </div>
                        )}
                        {verificationData.selfie_url && (
                          <div className="rounded-lg border border-cyan-300/15 bg-blue-950/25 p-3">
                            <p className="text-xs text-slate-400 font-medium mb-2">自拍照</p>
                            <div className="flex h-24 w-full items-center justify-center rounded border border-cyan-300/20 bg-blue-950/35">
                              <FileText className="w-8 h-8 text-slate-500" />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Submission Date */}
                <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    <Clock className="w-4 h-4" />
                    <span>
                      提交時間 {new Date(verificationData.created_at).toLocaleString("zh-CN")}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
    </>,
    document.body
  );
}
