import { useState, useEffect, useLayoutEffect, useRef, useId } from 'react';
import { createPortal } from 'react-dom';
import { Send, Search, Check, ChevronDown, Package, DollarSign, Hash, FileText, AlertTriangle, X, Ship, ClipboardCheck, Lock, ShieldCheck, Clock, Coins, Wallet, type LucideIcon } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { ProductType } from '../../types';
import { useCurrencyUnit } from '../../lib/useCurrencyUnit';
import { useLanguage } from '../../lib/i18n/context';
import { getStoredAuth } from '../../lib/auth';
import DispatchGulls from './DispatchGulls';
import { DispatchWaves } from './DispatchVeil';
import OrderPanelShip from './OrderPanelShip';

const FIELD_LABEL = 'flex items-center gap-2 text-xs sm:text-sm font-semibold text-slate-600 mb-2 sm:mb-2.5';
const LABEL_ICON = 'flex h-5 w-5 sm:h-6 sm:w-6 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-700 ring-1 ring-blue-100';
// 1px border with +1px padding keeps the previous 2px-border field height.
const FIELD_INPUT = 'w-full px-3 py-[11px] sm:px-4 sm:py-[15px] bg-white border border-slate-200 rounded-lg sm:rounded-xl text-slate-900 text-sm sm:text-base placeholder-slate-400 shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] transition-[border-color,box-shadow] duration-200 hover:border-slate-300 focus:outline-none focus:border-blue-500 focus:shadow-[0_0_0_3px_rgba(37,99,235,0.12)]';

interface OrderSubmissionProps {
  employeeId: string;
  isActive: boolean;
  adminId?: string | null;
  onNavigateToDispatch?: () => void;
}

export default function OrderSubmission({ employeeId, isActive, adminId: propAdminId, onNavigateToDispatch }: OrderSubmissionProps) {
  const { t } = useLanguage();
  const [adminId, setAdminId] = useState<string | null>(propAdminId || null);
  const currencyUnit = useCurrencyUnit(adminId);
  const [productTypes, setProductTypes] = useState<ProductType[]>([]);
  const [filteredProductTypes, setFilteredProductTypes] = useState<ProductType[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedProductType, setSelectedProductType] = useState<ProductType | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const productTypeButtonRef = useRef<HTMLButtonElement>(null);

  const [formData, setFormData] = useState({
    userNumber: '',
    productTypeId: '',
    productValue: '',
    orderNumber: '',
    transactionId: '',
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmEntering, setConfirmEntering] = useState(false);
  const [confirmOpenedAt, setConfirmOpenedAt] = useState(() => new Date());
  const [declarationCode, setDeclarationCode] = useState(makeDeclarationCode);
  const [confirmPhase, setConfirmPhase] = useState<'idle' | 'sealing' | 'leaving'>('idle');
  const [showResultModal, setShowResultModal] = useState(false);
  const [resultType, setResultType] = useState<'success' | 'error'>('success');
  const [resultMessage, setResultMessage] = useState('');
  const [commissionEstimate, setCommissionEstimate] = useState<CommissionEstimate | null>(null);
  const [showSubmitAnimation, setShowSubmitAnimation] = useState(false);
  const [submissionProgress, setSubmissionProgress] = useState(0);
  const [submissionStage, setSubmissionStage] = useState<'encrypting' | 'validating' | 'broadcasting' | 'confirming'>('encrypting');
  const [showValidationAlert, setShowValidationAlert] = useState(false);
  const [validationMessage, setValidationMessage] = useState('');
  const [activeAssignment, setActiveAssignment] = useState<{ id: string; assignment_id: string } | null>(null);
  const loadProductTypesRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (propAdminId) {
      setAdminId(propAdminId);
      return;
    }
    supabase
      .from('users')
      .select('created_by')
      .eq('id', employeeId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.created_by) {
          setAdminId(data.created_by);
        }
      });
  }, [employeeId, propAdminId]);

  useEffect(() => {
    if (!isActive) return;

    let cancelled = false;
    const fetchActiveAssignment = async () => {
      const { data: session } = await supabase
        .from('dispatch_sessions')
        .select('id')
        .eq('user_id', employeeId)
        .eq('status', 'online')
        .limit(1)
        .maybeSingle();

      if (cancelled) return;
      if (!session) {
        setActiveAssignment(null);
        return;
      }

      const { data } = await supabase
        .from('dispatch_assignments')
        .select('id, assignment_id')
        .eq('user_id', employeeId)
        .eq('status', 'accepted')
        .eq('order_submitted', false)
        .not('assignment_id', 'is', null)
        .order('accepted_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) {
        setActiveAssignment(data?.assignment_id ? { id: data.id, assignment_id: data.assignment_id } : null);
      }
    };
    void fetchActiveAssignment();
    const interval = window.setInterval(() => { void fetchActiveAssignment(); }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [employeeId, isActive]);

  useEffect(() => {
    void loadProductTypesRef.current?.();

    // Subscribe to real-time updates for product types with debouncing
    let reloadTimeout: NodeJS.Timeout | null = null;

    const channel = supabase
      .channel('product_types_changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'product_types'
        },
        (payload) => {
          // Debounce to avoid excessive reloads
          if (reloadTimeout) clearTimeout(reloadTimeout);

          reloadTimeout = setTimeout(() => {
            void loadProductTypesRef.current?.();

            // Check if selected product type was affected
            if (selectedProductType) {
              if (payload.eventType === 'DELETE' && payload.old?.id === selectedProductType.id) {
                setSelectedProductType(null);
                setFormData(prev => ({ ...prev, productTypeId: '' }));
              } else if (payload.eventType === 'UPDATE' && payload.new?.id === selectedProductType.id) {
                // Check if it was deactivated
                if (payload.new.is_active === false) {
                  setSelectedProductType(null);
                  setFormData(prev => ({ ...prev, productTypeId: '' }));
                  setMessage({
                    type: 'error',
                    text: `"${payload.old?.name}" has been disabled. Please select another product type.`
                  });
                  setTimeout(() => setMessage(null), 5000);
                }
              }
            }
          }, 500); // 500ms debounce
        }
      )
      .subscribe();

    return () => {
      if (reloadTimeout) clearTimeout(reloadTimeout);
      supabase.removeChannel(channel);
    };
  }, [selectedProductType]);

  const dropdownMenuRef = useRef<HTMLDivElement>(null);
  const [dropdownMenuH, setDropdownMenuH] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!showDropdown) return;
    const measure = () => {
      const menu = dropdownMenuRef.current;
      const panel = menu?.closest<HTMLElement>('.order-submission-panel');
      if (!menu || !panel) return;
      const panelInnerBottom = panel.getBoundingClientRect().bottom - parseFloat(getComputedStyle(panel).borderBottomWidth);
      // offsetTop avoids the slide-in animation's transform skewing the measurement.
      const menuTop = (menu.offsetParent as HTMLElement).getBoundingClientRect().top + menu.offsetTop;
      setDropdownMenuH(Math.max(160, Math.floor(panelInnerBottom - menuTop)));
    };
    measure();

    const panel = dropdownMenuRef.current?.closest<HTMLElement>('.order-submission-panel');
    const nav = document.querySelector<HTMLElement>('.employee-nav');
    const navRect = nav?.getBoundingClientRect();
    if (panel && navRect && navRect.height > 0) {
      const hidden = panel.getBoundingClientRect().bottom + 12 - navRect.top;
      if (hidden > 0) window.scrollBy({ top: hidden, behavior: 'smooth' });
    }

    // Breakpoint switches re-layout the panel after the resize event, so watch the elements themselves.
    const observer = new ResizeObserver(measure);
    if (panel) observer.observe(panel);
    const anchor = dropdownMenuRef.current?.offsetParent;
    if (anchor) observer.observe(anchor);
    return () => observer.disconnect();
  }, [showDropdown]);

  useLayoutEffect(() => {
    if (!isActive || !showConfirmModal) setConfirmEntering(false);
  }, [isActive, showConfirmModal]);

  const isAnyModalOpen = showResultModal || showValidationAlert;
  useLayoutEffect(() => {
    if (!isAnyModalOpen) return;

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
  }, [isAnyModalOpen]);

  useEffect(() => {
    const filtered = productTypes.filter(type =>
      type.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
    setFilteredProductTypes(filtered);
  }, [searchQuery, productTypes]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadProductTypes = async () => {
    try {
      const { data, error } = await supabase
        .from('product_types')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error) throw error;

      const newProductTypes = data || [];
      setProductTypes(newProductTypes);

      // Preserve search query when updating
      if (searchQuery) {
        const filtered = newProductTypes.filter(type =>
          type.name.toLowerCase().includes(searchQuery.toLowerCase())
        );
        setFilteredProductTypes(filtered);
      } else {
        setFilteredProductTypes(newProductTypes);
      }

      if (selectedProductType) {
        const currentProductType = newProductTypes.find(type => type.id === selectedProductType.id);
        if (!currentProductType) {
          setSelectedProductType(null);
          setFormData(prev => ({ ...prev, productTypeId: '' }));
        } else if (currentProductType.name !== selectedProductType.name) {
          setSelectedProductType(currentProductType);
        }
      }
    } catch (error) {
      console.error('Error loading product types:', error);
    }
  };
  loadProductTypesRef.current = loadProductTypes;

  const handleProductTypeSelect = (type: ProductType) => {
    setSelectedProductType(type);
    setFormData({ ...formData, productTypeId: type.id });
    setSearchQuery('');
    setShowDropdown(false);
  };

  const handleProductTypeClear = () => {
    setSelectedProductType(null);
    setFormData(prev => ({ ...prev, productTypeId: '' }));
    setSearchQuery('');
    setShowDropdown(false);
    productTypeButtonRef.current?.focus();
  };

  const showValidationError = (message: string) => {
    setValidationMessage(message);
    setShowValidationAlert(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    // Validate all required fields
    if (!formData.userNumber.trim()) {
      showValidationError(t.orderSubmission.userNumber);
      return;
    }

    if (!selectedProductType || !formData.productTypeId) {
      showValidationError(t.orderSubmission.selectProduct);
      return;
    }

    if (!formData.productValue || parseFloat(formData.productValue) <= 0) {
      showValidationError(t.orderSubmission.enterValidValue);
      return;
    }

    if (!formData.orderNumber.trim()) {
      showValidationError(t.orderSubmission.enterProductNumber);
      return;
    }

    if (formData.orderNumber.length !== 9) {
      showValidationError(t.orderSubmission.productNumberDigits);
      return;
    }

    if (!formData.transactionId.trim()) {
      showValidationError(t.orderSubmission.enterTransactionId);
      return;
    }

    if (formData.transactionId.length !== 11) {
      showValidationError(t.orderSubmission.transactionIdChars);
      return;
    }

    // Final validation: ensure product type is still active
    if (selectedProductType) {
      const currentProductType = productTypes.find(t => t.id === selectedProductType.id);
      if (!currentProductType) {
        showValidationError(t.orderSubmission.productUnavailable);
        setSelectedProductType(null);
        setFormData(prev => ({ ...prev, productTypeId: '' }));
        return;
      }
    }

    setConfirmOpenedAt(new Date());
    setDeclarationCode(makeDeclarationCode());
    setConfirmEntering(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    setShowConfirmModal(true);
  };

  const closeConfirmSheet = () => {
    setShowConfirmModal(false);
    setConfirmPhase('idle');
  };

  const handleConfirmSubmit = async () => {
    setConfirmPhase('sealing');
    setLoading(true);
    setCommissionEstimate(null);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Gives the stamp press time to land before the sheet hands over to the loader.
    const sealPause = new Promise((resolve) => setTimeout(resolve, reduceMotion ? 0 : 750));
    setSubmissionProgress(0);
    setSubmissionStage('encrypting');

    // Smooth progress animation that runs for exactly the specified duration
    const animateFullProgress = (targetDuration: number): { cancel: () => void; done: Promise<void> } => {
      let cancelled = false;
      const startTime = performance.now();
      let lastDisplayed = 0;
      let lastUpdateTime = 0;
      const stages: { pct: number; label: typeof submissionStage }[] = [
        { pct: 20, label: 'encrypting' },
        { pct: 50, label: 'validating' },
        { pct: 75, label: 'broadcasting' },
        { pct: 100, label: 'confirming' },
      ];

      const done = new Promise<void>((resolve) => {
        const tick = () => {
          if (cancelled) { resolve(); return; }
          const now = performance.now();
          const elapsed = now - startTime;
          const rawProgress = Math.min(100, (elapsed / targetDuration) * 100);

          // Only update display every 200ms to prevent flickering
          if (now - lastUpdateTime >= 200 || rawProgress >= 100) {
            // Ensure progress only moves forward, with slight randomness in speed
            const targetPct = Math.floor(rawProgress);
            const newDisplay = Math.max(lastDisplayed, targetPct);
            if (newDisplay !== lastDisplayed) {
              lastDisplayed = newDisplay;
              setSubmissionProgress(newDisplay);
            }
            lastUpdateTime = now;
          }

          // Update stage label
          for (const stage of stages) {
            if (rawProgress <= stage.pct) {
              setSubmissionStage(stage.label);
              break;
            }
          }

          if (elapsed >= targetDuration) {
            setSubmissionProgress(100);
            resolve();
          } else {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      });

      return { cancel: () => { cancelled = true; }, done };
    };

    let animation: ReturnType<typeof animateFullProgress> | undefined;
    let submissionAssignment: { id: string; assignment_id: string } | null = null;
    try {
      const auth = getStoredAuth();
      if (auth?.userType !== 'employee' || auth.user.id !== employeeId) {
        throw new Error('Employee session has expired. Please sign in again.');
      }
      const [{ data: timing, error: timingError }] = await Promise.all([
        supabase.rpc('get_employee_dispatch_submit_wait_secure', {
          p_user_id: auth.user.id,
          p_session_token: auth.financialSessionToken,
          p_tab_id: auth.tabId,
        }),
        sealPause,
      ]);
      if (timingError) throw timingError;
      if (!timing?.available || timing.min_seconds == null || timing.max_seconds == null) {
        throw new Error(timing?.message || '請先將員工指派至已啟用的訂單分組。');
      }
      if (timing.assignment_id && timing.assignment_code) {
        submissionAssignment = { id: timing.assignment_id, assignment_id: timing.assignment_code };
      }
      setActiveAssignment(submissionAssignment);
      const totalDuration = (timing.min_seconds + Math.random() * (timing.max_seconds - timing.min_seconds)) * 1000;
      setShowSubmitAnimation(true);
      setConfirmPhase('leaving');
      setTimeout(closeConfirmSheet, reduceMotion ? 0 : 500);
      animation = animateFullProgress(totalDuration);

      // Run DB operations in parallel with the animation
      const productValue = parseFloat(formData.productValue);
      const transactionId = formData.transactionId;

      const { data: validDataList, error: validError } = await supabase
        .from('valid_order_data')
        .select('id')
        .eq('product_value', productValue)
        .eq('transaction_id', transactionId)
        .eq('is_active', true);

      if (validError) throw validError;

      if (!validDataList || validDataList.length === 0) {
        await animation.done;
        setShowSubmitAnimation(false);
        setResultType('error');
        setResultMessage(t.orderSubmission.orderInfoError);
        setShowResultModal(true);
        setLoading(false);
        return;
      }

      const validIds = validDataList.map(v => v.id);
      const { data: usedDataList, error: usedError } = await supabase
        .from('used_order_data')
        .select('valid_order_data_id')
        .eq('user_id', employeeId)
        .in('valid_order_data_id', validIds);

      if (usedError) throw usedError;

      const usedIds = new Set(usedDataList?.map(u => u.valid_order_data_id) || []);
      const availableData = validDataList.find(v => !usedIds.has(v.id));

      if (!availableData) {
        await animation.done;
        setShowSubmitAnimation(false);
        setResultType('error');
        setResultMessage(t.orderSubmission.orderExists);
        setShowResultModal(true);
        setLoading(false);
        return;
      }

      const validData = availableData;

      const { data: orderData, error: orderError } = await supabase
        .from('orders')
        .insert({
          user_id: employeeId,
          username: formData.userNumber,
          product_type_id: formData.productTypeId,
          product_value: productValue,
          order_number: formData.orderNumber,
          transaction_id: transactionId,
          status: 'processing',
          ...(submissionAssignment ? { assignment_id: submissionAssignment.assignment_id } : {}),
        })
        .select()
        .single();

      if (orderError) throw orderError;

      const { error: usageError } = await supabase
        .from('used_order_data')
        .insert({
          user_id: employeeId,
          valid_order_data_id: validData.id,
          order_id: orderData.id,
        });

      if (usageError) {
        await supabase.from('orders').delete().eq('id', orderData.id);
        throw usageError;
      }

      if (submissionAssignment) {
        const { data: markedSubmitted, error: markError } = await supabase.rpc(
          'mark_dispatch_assignment_submitted_secure',
          {
            p_user_id: auth.user.id,
            p_session_token: auth.financialSessionToken,
            p_tab_id: auth.tabId,
            p_assignment_id: submissionAssignment.id,
            p_assignment_code: submissionAssignment.assignment_id,
            p_order_id: orderData.id,
          },
        );
        if (markError || !markedSubmitted) {
          await supabase.from('used_order_data').delete().eq('order_id', orderData.id);
          await supabase.from('orders').delete().eq('id', orderData.id);
          throw markError || new Error('The dispatch assignment is no longer active.');
        }
      }

      // Display-only: mirrors process_pending_orders (product_value × the rate snapshotted on insert); nothing is written.
      const rateSnapshot = orderData.dispatch_commission_rate_snapshot;
      setCommissionEstimate(rateSnapshot != null ? {
        amount: Number(orderData.product_value),
        rate: Number(rateSnapshot),
        commission: Number(orderData.product_value) * Number(rateSnapshot),
      } : null);

      // Wait for animation to complete (it always takes exactly totalDuration)
      await animation.done;
      setShowSubmitAnimation(false);
      setResultType('success');
      setResultMessage(t.orderSubmission.orderSuccessProcessing);
      setShowResultModal(true);

      setFormData({
        userNumber: '',
        productTypeId: '',
        productValue: '',
        orderNumber: '',
        transactionId: '',
      });
      setSelectedProductType(null);
      setSearchQuery('');

      // Auto-return to dispatch tab after submission if there was an active assignment
      if (submissionAssignment) {
        setActiveAssignment(null);
        setTimeout(() => {
          onNavigateToDispatch?.();
        }, 1500);
      }

    } catch (error: unknown) {
      console.error('Order submission error:', error);
      animation?.cancel();
      if (animation) setSubmissionProgress(100);
      setShowSubmitAnimation(false);
      closeConfirmSheet();
      setResultType('error');
      setResultMessage(error instanceof Error ? error.message : t.orderSubmission.failedRetry);
      setShowResultModal(true);
    } finally {
      setLoading(false);
    }
  };

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const confirmStamp = `${confirmOpenedAt.getFullYear()}-${pad2(confirmOpenedAt.getMonth() + 1)}-${pad2(confirmOpenedAt.getDate())} ${pad2(confirmOpenedAt.getHours())}:${pad2(confirmOpenedAt.getMinutes())}:${pad2(confirmOpenedAt.getSeconds())}`;

  return (
    <div className={`order-submission-panel relative isolate overflow-hidden rounded-xl bg-white p-4 shadow-[0_18px_48px_-30px_rgba(15,23,42,0.45)] sm:rounded-3xl sm:p-8 ${showConfirmModal || showSubmitAnimation ? 'border-0' : 'border border-slate-200'}`}>
      <div className="relative flex flex-wrap items-center gap-2.5 sm:gap-4 mb-4 sm:mb-8">
        <div className="relative flex items-center justify-center w-10 h-10 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl bg-gradient-to-br from-[#1b4b84] via-blue-600 to-sky-500 text-white shadow-[0_10px_24px_-12px_rgba(37,99,235,0.85)] ring-1 ring-white/50 flex-shrink-0">
          <Ship className="w-5 h-5 sm:w-6 sm:h-6" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-[8rem] sm:min-w-[15rem]">
          <h2 className="text-base sm:text-2xl font-bold tracking-tight text-[#12356d] leading-tight break-words">
            {t.orderSubmission.title}
          </h2>
          <p className="text-slate-500 text-xs sm:text-sm mt-0.5 sm:mt-1 flex items-center gap-1.5 sm:gap-2">
            <span className="w-1.5 h-1.5 bg-cyan-500 rounded-full shadow-[0_0_8px_rgba(6,182,212,0.5)] flex-shrink-0"></span>
            <span className="truncate">{t.orderSubmission.fillDetails}</span>
          </p>
        </div>
        {activeAssignment ? (
          <div className="flex-shrink-0 inline-flex items-center gap-1.5 sm:gap-2.5 rounded-full border border-blue-200 bg-white/90 px-3 sm:px-4 py-1.5 sm:py-2 shadow-[0_6px_20px_-12px_rgba(37,99,235,0.55)] backdrop-blur-sm">
            <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 bg-cyan-500 rounded-full shadow-[0_0_8px_rgba(6,182,212,0.5)]"></span>
            <span className="hidden sm:inline text-[10px] sm:text-xs font-semibold text-slate-500 uppercase tracking-wider">{t.dispatch.assignmentIdLabel}</span>
            <span className="text-xs sm:text-base font-bold text-[#12356d] font-mono tracking-widest">{activeAssignment.assignment_id}</span>
          </div>
        ) : null}
        <div className="order-panel-band pointer-events-none absolute -inset-x-4 -top-4 -bottom-2 -z-10 overflow-hidden border-b border-slate-200/80 bg-gradient-to-br from-sky-50 via-white to-blue-50/70 sm:-inset-x-8 sm:-top-8 sm:-bottom-5" aria-hidden="true">
          <DispatchGulls />
          <OrderPanelShip />
          <DispatchWaves wavelengths={[320, 220, 320]} speeds={[18, 26, 34]} className="order-panel-sea" />
        </div>
      </div>

      <form onSubmit={handleSubmit} className="order-submission-form space-y-3 sm:space-y-5">
        <div className="order-submission-grid grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-5">
          <div>
            <label className={FIELD_LABEL}>
              <span className={LABEL_ICON}><Hash className="w-3 h-3 sm:w-3.5 sm:h-3.5" /></span>
              {t.orderSubmission.userNumber}
            </label>
            <input
              type="text"
              value={formData.userNumber}
              onChange={(e) => setFormData({ ...formData, userNumber: e.target.value.replace(/\s+/g, '') })}
              className={FIELD_INPUT}
              placeholder={t.orderSubmission.enterUserNumber}
            />
          </div>

          <div className="relative" ref={dropdownRef}>
            <label className={FIELD_LABEL}>
              <span className={LABEL_ICON}><Package className="w-3 h-3 sm:w-3.5 sm:h-3.5" /></span>
              {t.orderSubmission.productType}
            </label>
            <div className="relative">
              <button
                type="button"
                ref={productTypeButtonRef}
                onClick={() => setShowDropdown(!showDropdown)}
                aria-expanded={showDropdown}
                className={`${FIELD_INPUT} flex items-center justify-between text-left ${
                  showDropdown ? '!border-blue-500 shadow-[0_0_0_3px_rgba(37,99,235,0.12)]' : ''
                } ${selectedProductType ? '!text-blue-700 font-semibold' : '!text-slate-400'}`}
              >
                <span className={`truncate ${selectedProductType ? 'pr-10' : ''}`}>
                  {selectedProductType ? selectedProductType.name : t.orderSubmission.selectProduct}
                </span>
                <ChevronDown className={`w-4 h-4 sm:w-5 sm:h-5 text-slate-400 transition-transform duration-300 flex-shrink-0 ${showDropdown ? 'rotate-180 text-blue-600' : ''}`} />
              </button>
              {selectedProductType && (
                <button
                  type="button"
                  onClick={handleProductTypeClear}
                  aria-label="Clear product type"
                  className="absolute right-8 sm:right-10 top-1/2 flex !h-[28px] !w-[28px] !min-h-[28px] !min-w-[28px] -translate-y-1/2 items-center justify-center rounded-full bg-blue-50 !p-0 text-blue-600 transition-colors hover:bg-blue-100 hover:text-blue-700 active:bg-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                >
                  <X className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
                </button>
              )}

              {showDropdown && (
                <div
                  ref={dropdownMenuRef}
                  className="absolute z-50 mt-2 flex w-full flex-col overflow-hidden rounded-lg border border-blue-200 bg-white shadow-[0_24px_48px_-22px_rgba(18,53,109,0.5)] animate-slideDown sm:rounded-xl"
                  style={dropdownMenuH ? { height: dropdownMenuH } : undefined}
                >
                  <span className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[3px] bg-gradient-to-r from-[#12356d] via-blue-600 to-cyan-400" aria-hidden="true" />
                  <div className="shrink-0 p-2 sm:p-2.5 border-b border-blue-100 bg-gradient-to-br from-sky-50 via-blue-50/70 to-white">
                    <div className="relative">
                      <Search className="absolute left-2.5 sm:left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-500 z-10 pointer-events-none" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={t.orderSubmission.search}
                        className="w-full !h-9 !min-h-[36px] pl-8 sm:pl-10 pr-10 sm:pr-11 py-0 bg-white border border-blue-100 rounded-lg text-slate-900 text-xs sm:text-sm placeholder-slate-400 shadow-[0_1px_2px_rgba(37,99,235,0.06)] transition-[border-color,box-shadow] hover:border-blue-200 focus:outline-none focus:border-blue-500 focus:shadow-[0_0_0_3px_rgba(37,99,235,0.12)] relative"
                      />
                      {searchQuery && (
                        <button
                          type="button"
                          onClick={() => setSearchQuery('')}
                          className="absolute right-1.5 top-1/2 z-10 flex !h-7 !w-7 !min-h-[28px] !min-w-[28px] -translate-y-1/2 items-center justify-center rounded-full bg-blue-50 !p-0 text-blue-600 transition-colors hover:bg-blue-100 hover:text-blue-700 active:bg-blue-200"
                          aria-label="Clear search"
                        >
                          <X className="h-4 w-4" strokeWidth={2.5} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto custom-scrollbar p-1.5 sm:p-2 bg-gradient-to-b from-white to-sky-50/60">
                    {filteredProductTypes.length > 0 ? (
                      filteredProductTypes.map((type, index) => {
                        const isSelected = selectedProductType?.id === type.id;
                        return (
                          <button
                            key={type.id}
                            type="button"
                            onClick={() => handleProductTypeSelect(type)}
                            aria-pressed={isSelected}
                            className={`relative w-full !h-10 !min-h-[40px] sm:!h-11 sm:!min-h-[44px] px-3 py-0 sm:px-3.5 text-left flex items-center gap-2.5 group/item overflow-hidden rounded-lg sm:rounded-xl mb-1 sm:mb-1.5 last:mb-0 border transition-[background-color,border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 active:scale-[0.99] ${
                              isSelected
                                ? 'border-transparent bg-gradient-to-r from-[#12356d] via-blue-700 to-blue-600 shadow-[0_10px_22px_-12px_rgba(18,53,109,0.85)]'
                                : 'border-slate-200/80 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] hover:border-blue-300 hover:bg-gradient-to-r hover:from-sky-50 hover:to-blue-100/70 hover:shadow-[0_8px_18px_-12px_rgba(37,99,235,0.7)]'
                            }`}
                          >
                            {!isSelected && (
                              <span className="pointer-events-none absolute inset-y-0 left-0 w-1 origin-center scale-y-0 bg-gradient-to-b from-blue-600 to-cyan-400 transition-transform duration-200 group-hover/item:scale-y-100" aria-hidden="true" />
                            )}
                            <span className={`flex-shrink-0 w-6 h-6 sm:w-7 sm:h-7 rounded-md sm:rounded-lg flex items-center justify-center font-bold tabular-nums text-[11px] sm:text-xs ring-1 transition-colors ${
                              isSelected
                                ? 'bg-white/20 text-white ring-white/35'
                                : 'bg-blue-50 text-blue-700 ring-blue-200 group-hover/item:bg-blue-600 group-hover/item:text-white group-hover/item:ring-blue-600'
                            }`}>
                              {index + 1}
                            </span>
                            <span className={`flex-1 min-w-0 truncate text-[13px] sm:text-sm font-semibold transition-colors ${
                              isSelected ? 'text-white' : 'text-slate-700 group-hover/item:text-[#12356d]'
                            }`}>
                              {type.name}
                            </span>
                            {isSelected && (
                              <span className="flex-shrink-0 flex h-5 w-5 sm:h-6 sm:w-6 items-center justify-center rounded-full bg-white text-blue-700 shadow-[0_2px_8px_rgba(15,23,42,0.25)] animate-fadeIn">
                                <Check className="w-3 h-3 sm:w-3.5 sm:h-3.5" strokeWidth={3} />
                              </span>
                            )}
                          </button>
                        );
                      })
                    ) : (
                      <div className="px-4 py-8 text-center text-slate-400 text-sm">
                        {t.orderSubmission.noProductTypes}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div>
            <label className={FIELD_LABEL}>
              <span className={LABEL_ICON}><DollarSign className="w-3 h-3 sm:w-3.5 sm:h-3.5" /></span>
              <span className="truncate">{t.orderSubmission.productValue} ({currencyUnit})</span>
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              value={formData.productValue}
              onChange={(e) => setFormData({ ...formData, productValue: e.target.value.replace(/\s+/g, '') })}
              className={`${FIELD_INPUT} number-input-blue`}
              placeholder="0.00"
            />
          </div>

          <div>
            <label className={FIELD_LABEL}>
              <span className={LABEL_ICON}><Hash className="w-3 h-3 sm:w-3.5 sm:h-3.5" /></span>
              {t.orderSubmission.productNumber}
            </label>
            <input
              type="text"
              value={formData.orderNumber}
              onChange={(e) => setFormData({ ...formData, orderNumber: e.target.value.replace(/\s+/g, '') })}
              maxLength={9}
              className={FIELD_INPUT}
              placeholder={t.orderSubmission.nineDigits}
            />
          </div>

          <div className="lg:col-span-2">
            <label className={FIELD_LABEL}>
              <span className={LABEL_ICON}><FileText className="w-3 h-3 sm:w-3.5 sm:h-3.5" /></span>
              {t.orderSubmission.transactionId}
            </label>
            <input
              type="text"
              value={formData.transactionId}
              onChange={(e) => setFormData({ ...formData, transactionId: e.target.value.replace(/\s+/g, '') })}
              maxLength={11}
              className={FIELD_INPUT}
              placeholder={t.orderSubmission.elevenChars}
            />
          </div>
        </div>

        {message && (
          <div
            className={`relative rounded-xl p-4 border animate-slideDown ${
              message.type === 'success'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                : 'bg-rose-50 border-rose-200 text-rose-700'
            }`}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5">
                {message.type === 'success' ? (
                  <Check className="w-5 h-5" />
                ) : (
                  <AlertTriangle className="w-5 h-5" />
                )}
              </div>
              <p className="text-sm font-medium flex-1">{message.text}</p>
            </div>
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="order-submission-submit group relative w-full min-h-[44px] overflow-hidden bg-gradient-to-r from-[#12356d] via-blue-700 to-blue-600 text-white py-3 sm:py-4 px-4 sm:px-6 rounded-lg sm:rounded-xl font-semibold tracking-wide text-sm sm:text-base shadow-[0_14px_30px_-14px_rgba(18,53,109,0.8)] transition-all duration-300 hover:brightness-110 hover:shadow-[0_18px_36px_-14px_rgba(18,53,109,0.9)] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 sm:gap-3 active:scale-[0.98]"
        >
          <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/30" aria-hidden="true"></span>
          <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000" aria-hidden="true"></span>
          <Send className={`w-4 h-4 sm:w-5 sm:h-5 relative z-10 flex-shrink-0 ${loading ? 'animate-pulse' : ''}`} />
          <span className="relative z-10 truncate">{loading ? t.orderSubmission.submitting : t.orderSubmission.submit}</span>
        </button>
      </form>
      <span className="pointer-events-none absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#12356d] via-blue-600 to-cyan-400" aria-hidden="true" />
      <span className="dispatch-panel-arc dispatch-panel-arc-bottom-left pointer-events-none -z-10" aria-hidden="true" />
      <span className="dispatch-panel-arc dispatch-panel-arc-bottom-right pointer-events-none -z-10" aria-hidden="true" />


      {showConfirmModal && (
        <div
          className={`confirm-sheet ${confirmEntering ? 'confirm-sheet-enter' : ''} absolute inset-0 z-[9999] flex flex-col overflow-hidden rounded-xl bg-white sm:rounded-3xl ${confirmPhase === 'sealing' ? 'is-sealing' : ''} ${confirmPhase === 'leaving' ? 'is-leaving' : ''}`}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === 'confirmSheetIn') {
              setConfirmEntering(false);
            }
          }}
        >
          <span className="pointer-events-none absolute inset-x-0 top-0 z-10 h-1 bg-gradient-to-r from-[#12356d] via-blue-600 to-cyan-400" aria-hidden="true" />
          <span className="confirm-seal-light pointer-events-none" aria-hidden="true" />

          <div className="confirm-band relative flex-shrink-0 overflow-hidden border-b border-slate-200/80 bg-gradient-to-br from-sky-50 via-white to-blue-50/70 px-4 pb-3.5 pt-5 sm:px-8 sm:pb-4 sm:pt-5">
            <span className="pointer-events-none absolute -left-8 -top-10 h-24 w-24 rotate-[18deg] rounded-[30%] bg-sky-200/30" aria-hidden="true" />
            <OrderPanelShip />
            <div className="relative flex items-center gap-3 sm:gap-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#1b4b84] via-blue-600 to-sky-500 text-white shadow-[0_10px_24px_-12px_rgba(37,99,235,0.85)] ring-1 ring-white/50 sm:h-11 sm:w-11">
                <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-bold leading-tight tracking-tight text-[#12356d] sm:text-xl">{t.orderSubmission.confirmSubmission}</h2>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-500 sm:text-sm">
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.5)]" aria-hidden="true" />
                  <span className="truncate">{t.orderSubmission.verifyDetails}</span>
                </p>
              </div>
            </div>
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-white">
            <div className="grid w-full flex-1 grid-rows-[auto_1fr] lg:grid-cols-[minmax(0,8fr)_minmax(0,4fr)] lg:grid-rows-1">
              <section className="relative flex min-w-0 flex-col bg-white">
                <span className="pointer-events-none absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-[#12356d] via-blue-600 to-cyan-400" aria-hidden="true" />

                <div className="confirm-doc-head relative flex items-center justify-between gap-3 border-b border-dashed border-slate-300 bg-gradient-to-r from-slate-50 via-white to-sky-50/70 py-3 pl-4 pr-3 sm:gap-6 sm:py-4 sm:pl-7 sm:pr-6">
                  <span className="pointer-events-none absolute inset-0 bg-[repeating-linear-gradient(135deg,rgba(18,53,109,0.04)_0_2px,transparent_2px_9px)]" aria-hidden="true" />
                  <div className="relative flex min-w-0 flex-col gap-1.5 sm:gap-2">
                    <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 sm:text-[11px]">
                      <Clock className="h-3 w-3 flex-shrink-0 text-blue-700 sm:h-3.5 sm:w-3.5" strokeWidth={2.4} aria-hidden="true" />
                      <span className="truncate">{t.orderSubmission.declaredAt}</span>
                    </span>
                    <span className="font-mono text-[13px] font-bold tracking-wider text-[#12356d] tabular-nums sm:text-lg">{confirmStamp}</span>
                    {activeAssignment ? (
                      <span className="inline-flex w-fit max-w-full items-center gap-1.5 rounded-md bg-[#12356d] px-2 py-0.5 text-[10px] font-semibold text-white sm:text-[11px]">
                        <span className="truncate text-blue-100/80">{t.dispatch.assignmentIdLabel}</span>
                        <span className="font-mono tracking-wider">{activeAssignment.assignment_id}</span>
                      </span>
                    ) : null}
                  </div>
                  <div className="relative flex flex-shrink-0 flex-col items-center rounded-md bg-white px-2.5 pb-1 pt-2 ring-1 ring-slate-200 shadow-[0_6px_16px_-12px_rgba(15,23,42,0.5)] sm:px-4 sm:pt-2.5">
                    <DocBarcode value={declarationCode} className="h-9 w-32 text-slate-900 sm:h-14 sm:w-56" />
                    <span className="mt-1 font-mono text-[9px] font-semibold tracking-[0.22em] text-slate-700 sm:text-xs sm:tracking-[0.3em]">{declarationCode}</span>
                  </div>
                </div>

                <dl className="relative grid flex-1 grid-cols-2 grid-rows-2">
                  {[
                    { label: t.orderSubmission.userNumber, value: formData.userNumber, mono: true },
                    { label: t.orderSubmission.productType, value: selectedProductType?.name || 'N/A', mono: false },
                    { label: t.orderSubmission.productNumber, value: formData.orderNumber, mono: true },
                    { label: t.orderSubmission.transactionId, value: formData.transactionId, mono: true },
                  ].map(({ label, value, mono }, index) => (
                    <div key={label} className={`confirm-field flex min-w-0 flex-col justify-center border-slate-200 py-3 pl-4 pr-3 sm:py-4 sm:pl-7 sm:pr-6 ${index % 2 === 0 ? 'border-r' : ''} ${index >= 2 ? 'border-t' : ''}`}>
                      <dt className="flex min-w-0 items-center gap-1.5">
                        <span className="flex-shrink-0 rounded bg-[#12356d] px-1 py-px font-mono text-[9px] font-bold leading-tight text-white">{String(index + 1).padStart(2, '0')}</span>
                        <span className="truncate text-[11px] font-semibold text-slate-500 sm:text-[13px]">{label}</span>
                      </dt>
                      <dd className={`mt-1.5 truncate text-sm font-semibold text-[#12356d] sm:mt-2.5 sm:text-xl ${mono ? 'font-mono tracking-wide' : ''}`}>{value}</dd>
                    </div>
                  ))}
                  <span
                    key={confirmPhase === 'idle' ? 'pending' : 'sealed'}
                    className={`confirm-stamp pointer-events-none absolute bottom-1 right-1 h-16 w-16 mix-blend-multiply sm:bottom-3 sm:right-5 sm:h-28 sm:w-28 ${confirmPhase === 'idle' ? 'text-blue-700/50' : 'is-sealed text-blue-700/80'}`}
                  >
                    <ConfirmStamp
                      ring={t.orderSubmission.stampRing}
                      center={confirmPhase === 'idle' ? t.orderSubmission.stampCenter : t.orderSubmission.stampSealed}
                      date={confirmStamp.slice(0, 10)}
                      className="h-full w-full rotate-[-14deg]"
                    />
                  </span>
                </dl>

                <div className="confirm-warning flex items-center gap-2 border-t border-amber-200/80 bg-amber-50/70 py-2.5 pl-4 pr-3 sm:py-3 sm:pl-7 sm:pr-6">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-600" strokeWidth={2.4} aria-hidden="true" />
                  <p className="text-xs font-medium text-amber-800 sm:text-[13px]">
                    {t.orderSubmission.irreversible} <span className="font-bold text-red-600">{t.orderSubmission.irreversibleBold}</span> {t.orderSubmission.onceConfirmed}
                  </p>
                </div>
              </section>

              <aside className="confirm-amount relative order-first flex flex-col justify-between overflow-hidden bg-gradient-to-br from-[#12356d] via-[#1b4b8f] to-blue-600 px-4 py-3 text-white sm:px-7 sm:py-4 lg:order-last lg:justify-center lg:px-6 lg:py-5">
                <span className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rotate-[18deg] rounded-[30%] bg-white/10" aria-hidden="true" />
                <svg className="pointer-events-none absolute -bottom-1 right-3 h-12 w-20 text-white/15 sm:h-14 sm:w-24 lg:h-20 lg:w-36" viewBox="0 0 120 64" fill="none" aria-hidden="true">
                  <g stroke="currentColor" strokeWidth="1.5">
                    <rect x="4" y="34" width="54" height="26" rx="2" />
                    <rect x="60" y="34" width="54" height="26" rx="2" />
                    <rect x="32" y="6" width="54" height="26" rx="2" />
                    <path d="M14 39v16M24 39v16M34 39v16M44 39v16M70 39v16M80 39v16M90 39v16M100 39v16M42 11v16M52 11v16M62 11v16M72 11v16" />
                  </g>
                </svg>
                <div className="relative">
                  <p className="flex items-center gap-2 text-sm font-semibold tracking-wide text-blue-50 sm:text-base">
                    <span className="rounded bg-white/15 px-1.5 py-px font-mono text-[10px] font-bold tracking-normal text-white">05</span>
                    {t.orderSubmission.totalAmount}
                  </p>
                  <div className="mt-1.5 flex flex-nowrap items-baseline gap-x-2 lg:mt-3">
                    <span className="text-[30px] font-semibold leading-none tracking-tight tabular-nums sm:text-4xl">
                      {parseFloat(formData.productValue).toFixed(2)}
                    </span>
                    <span className="text-base font-semibold leading-none tracking-wider text-blue-100 sm:text-xl">{currencyUnit}</span>
                  </div>
                  <p className="mt-2 hidden truncate text-xs text-blue-100/80 lg:block">{selectedProductType?.name}</p>
                </div>
                <div className="relative mt-3 hidden items-center gap-3 border-t border-white/15 pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-100/90 lg:flex">
                  <span className="inline-flex items-center gap-1.5">
                    <Lock className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
                    {t.orderSubmission.encrypted}
                  </span>
                  <span className="h-3 w-px bg-white/25" aria-hidden="true" />
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldCheck className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />
                    {t.orderSubmission.secure}
                  </span>
                </div>
              </aside>
            </div>
          </div>

          <div className="confirm-footer relative flex-shrink-0 overflow-hidden border-t border-slate-200 bg-gradient-to-r from-blue-50/60 via-white to-blue-50/70 px-4 py-3 sm:px-8 sm:py-4">
            <span className="pointer-events-none absolute -left-8 -top-10 h-24 w-24 rotate-[18deg] rounded-[30%] bg-gradient-to-br from-blue-200/50 to-transparent" aria-hidden="true" />
            <span className="pointer-events-none absolute -bottom-14 left-[20%] h-24 w-24 rounded-full bg-gradient-to-tr from-blue-100 to-transparent" aria-hidden="true" />
            <span className="pointer-events-none absolute -right-10 -bottom-14 h-32 w-32 -rotate-[14deg] rounded-[30%] bg-gradient-to-tl from-blue-200/50 to-transparent" aria-hidden="true" />
            <div className="relative mx-auto grid max-w-4xl grid-cols-2 gap-3 sm:flex sm:justify-end">
              <button
                type="button"
                onClick={closeConfirmSheet}
                disabled={confirmPhase !== 'idle'}
                className="min-h-[44px] rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 transition-opacity hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 sm:min-w-[140px]"
              >
                {t.common.cancel}
              </button>
              <button
                type="button"
                onClick={handleConfirmSubmit}
                disabled={loading}
                className="relative flex min-h-[44px] items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-[#12356d] via-blue-700 to-blue-600 px-5 text-sm font-semibold tracking-wide text-white shadow-[0_14px_30px_-14px_rgba(18,53,109,0.85)] hover:brightness-110 disabled:cursor-wait disabled:hover:brightness-100 sm:min-w-[200px]"
              >
                <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/30" aria-hidden="true" />
                {loading ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" aria-hidden="true" />
                    {t.orderSubmission.wait}
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4" strokeWidth={2.6} aria-hidden="true" />
                    {t.orderSubmission.confirm}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSubmitAnimation && (() => {
        const milestones = [
          { label: t.orderSubmission.encrypt, progress: 0 },
          { label: t.orderSubmission.validate, progress: 20 },
          { label: t.orderSubmission.broadcast, progress: 50 },
          { label: t.orderSubmission.confirm, progress: 75 },
        ];
        const currentIndex = milestones.reduce((acc, m, i) => (submissionProgress >= m.progress ? i : acc), 0);
        return (
          <div className="submit-port absolute inset-0 z-50 overflow-hidden rounded-xl sm:rounded-3xl" role="status" aria-live="polite">
            <span className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[3px] bg-gradient-to-r from-[#12356d] via-blue-600 to-cyan-400" aria-hidden="true" />
            <div className="pointer-events-none absolute inset-0" aria-hidden="true">
              <span className="port-block port-block-1" />
              <span className="port-block port-block-2" />
              <span className="port-block port-block-3" />
              <span className="port-block port-block-4" />
              <span className="port-block port-block-5" />
              <span className="port-block port-block-6" />
            </div>
            <div className="submit-port-layout relative z-10 flex h-full w-full flex-col lg:flex-row">
              <div className="submit-port-info relative z-10 mx-auto flex w-full max-w-[400px] shrink-0 flex-col items-center px-4 pt-5 text-center sm:max-w-[480px] sm:px-5 sm:pt-9 lg:mx-0 lg:w-[44%] lg:max-w-[470px] lg:items-start lg:pl-12 lg:pr-0 lg:pt-8 lg:text-left">
                <div className="submit-port-eyebrow inline-flex max-w-full items-center gap-2 rounded-full border border-blue-100 bg-white/85 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-blue-700 shadow-[0_4px_14px_-10px_rgba(37,99,235,0.6)] sm:text-[11px]">
                  <span className="port-live relative h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-500" />
                  <span className="truncate">{t.orderSubmission.title}</span>
                </div>

                <h3 className="mt-3 text-lg font-semibold tracking-tight text-[#12356d] sm:mt-4 sm:text-[26px] sm:leading-tight">
                  {submissionStage === 'encrypting' && t.orderSubmission.encryptingData}
                  {submissionStage === 'validating' && t.orderSubmission.validatingOrder}
                  {submissionStage === 'broadcasting' && t.orderSubmission.broadcastingNetwork}
                  {submissionStage === 'confirming' && t.orderSubmission.confirmingTransaction}
                </h3>
                <p className="submit-port-sub mt-1 text-xs text-slate-500 sm:text-sm">{t.orderSubmission.securelyProcessing}</p>

                <div className="submit-port-card mt-4 w-full rounded-2xl border border-white/90 bg-white/75 p-3.5 text-left shadow-[0_20px_44px_-30px_rgba(18,53,109,0.6)] ring-1 ring-blue-100/80 backdrop-blur-md sm:mt-6 sm:p-5 lg:mt-5">
                <div className="flex items-end justify-between gap-3">
                  <div className="flex items-baseline gap-1">
                    <span className="port-percent text-[40px] font-extrabold leading-none tracking-tight tabular-nums sm:text-[56px]">{submissionProgress}</span>
                    <span className="port-percent text-base font-bold sm:text-2xl">%</span>
                  </div>
                  <span className="mb-0.5 rounded-full bg-blue-50 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-blue-700 ring-1 ring-blue-100 sm:text-[11px]">
                    {String(currentIndex + 1).padStart(2, '0')} / {String(milestones.length).padStart(2, '0')}
                  </span>
                </div>

                <div className="relative mt-3">
                  <div className="h-1 overflow-hidden rounded-full bg-slate-200/80">
                    <div
                      className="relative h-full overflow-hidden rounded-full bg-gradient-to-r from-[#12356d] via-blue-600 to-cyan-400 transition-[width] duration-300 ease-out"
                      style={{ width: `${submissionProgress}%` }}
                    >
                      <div className="submit-anim-shimmer absolute inset-0 bg-gradient-to-r from-transparent via-white/60 to-transparent"></div>
                    </div>
                  </div>
                  <span
                    className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white ring-2 ring-cyan-400 shadow-[0_0_0_4px_rgba(34,211,238,0.16),0_0_12px_rgba(34,211,238,0.75)] transition-[left] duration-300 ease-out"
                    style={{ left: `${submissionProgress}%` }}
                  />
                </div>

                <ol className="mt-4 grid grid-cols-4">
                  {milestones.map((milestone, index) => {
                    const done = index < currentIndex;
                    const current = index === currentIndex;
                    return (
                      <li key={milestone.label} className="relative flex flex-col items-center gap-1.5">
                        {index > 0 && (
                          <span className={`absolute left-[calc(-50%+14px)] right-[calc(50%+14px)] top-[9px] h-px transition-colors duration-300 ${done || current ? 'bg-blue-500' : 'bg-slate-200'}`} />
                        )}
                        <span className={`relative flex h-[18px] w-[18px] items-center justify-center rounded-full transition-colors duration-300 ${
                          done
                            ? 'bg-[#12356d] text-white'
                            : current
                              ? 'bg-white ring-[1.5px] ring-blue-600 shadow-[0_0_0_4px_rgba(37,99,235,0.12)]'
                              : 'bg-white text-slate-400 ring-1 ring-slate-300'
                        }`}>
                          {done ? (
                            <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
                          ) : current ? (
                            <span className="h-1.5 w-1.5 rounded-full bg-blue-600 submit-anim-pulse" />
                          ) : (
                            <span className="font-mono text-[8px] font-semibold leading-none">{index + 1}</span>
                          )}
                        </span>
                        <span className={`submit-port-step whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.08em] sm:text-[11px] ${done || current ? 'text-[#12356d]' : 'text-slate-400'}`}>
                          {milestone.label}
                        </span>
                      </li>
                    );
                  })}
                </ol>

                <div className="submit-port-badges mt-4 hidden items-center gap-4 border-t border-slate-100 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 sm:flex">
                  <span className="inline-flex items-center gap-1.5">
                    <Lock className="h-3 w-3 text-emerald-600" strokeWidth={2.5} />
                    {t.orderSubmission.encrypted}
                  </span>
                  <span className="h-3 w-px bg-slate-200" />
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldCheck className="h-3 w-3 text-blue-600" strokeWidth={2.5} />
                    {t.orderSubmission.secure}
                  </span>
                </div>
                </div>

                <div className="submit-port-warning mt-3 inline-flex items-center gap-2 rounded-full border border-amber-200/70 bg-amber-50/80 px-3 py-1.5 sm:mt-4">
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-amber-600" />
                  <p className="text-left text-xs font-medium text-amber-800 sm:text-[13px]">{t.orderSubmission.doNotClose}</p>
                </div>
              </div>
              <div className="submit-port-scene relative min-h-0 flex-1" aria-hidden="true">
                <PortScene />
              </div>
            </div>
          </div>
        );
      })()}

      {showResultModal && resultType === 'success' && (
        <SubmitSuccessNotice
          title={t.orderSubmission.orderSubmitted}
          message={resultMessage}
          action={t.orderSubmission.done}
          estimate={commissionEstimate}
          currencyUnit={currencyUnit}
          labels={{
            estimated: t.orderSubmission.estimatedCommission,
            note: t.orderSubmission.commissionOnSuccess,
            amount: t.orderSubmission.orderAmount,
            rate: t.orderSubmission.commissionRate,
          }}
          onClose={() => setShowResultModal(false)}
        />
      )}

      {showResultModal && resultType === 'error' && (
        <SubmitNotice
          tone="error"
          eyebrow={t.orderSubmission.title}
          title={t.orderSubmission.submissionFailed}
          message={resultMessage}
          action={t.orderSubmission.done}
          onClose={() => setShowResultModal(false)}
        />
      )}

      {showValidationAlert && (
        <SubmitNotice
          tone="warning"
          eyebrow={t.orderSubmission.title}
          title={t.orderSubmission.missingInfo}
          message={validationMessage}
          action={t.common.ok}
          onClose={() => setShowValidationAlert(false)}
        />
      )}

      <style>{`
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-slideDown { animation: slideDown 0.3s ease-out; }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #f1f5f9; border-radius: 3px; margin: 4px 0; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
        .number-input-blue::-webkit-inner-spin-button,
        .number-input-blue::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        .number-input-blue {
          -moz-appearance: textfield;
        }
      `}</style>
    </div>
  );
}

type NoticeTone = 'error' | 'warning';

type CommissionEstimate = { amount: number; rate: number; commission: number };

function useCountUp(target: number, duration: number, delay: number) {
  const [value, setValue] = useState(duration ? 0 : target);
  useEffect(() => {
    if (!duration) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / duration));
      setValue(target * (1 - Math.pow(1 - p, 3)));
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, delay]);
  return value;
}

const formatRate = (rate: number) => `${Number((rate * 100).toFixed(3))}%`;

function SubmitSuccessNotice({ title, message, action, estimate, currencyUnit, labels, onClose }: {
  title: string;
  message: string;
  action: string;
  estimate: CommissionEstimate | null;
  currencyUnit: string;
  labels: { estimated: string; note: string; amount: string; rate: string };
  onClose: () => void;
}) {
  const [reduceMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const shown = useCountUp(estimate?.commission ?? 0, reduceMotion ? 0 : 1100, 450);
  return createPortal(
    <div
      className="employee-modal-backdrop fixed inset-0 z-[10000] flex items-center justify-center bg-slate-900/50 p-4 sm:p-6"
      style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
      onClick={onClose}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="submit-notice-title"
        aria-describedby="submit-notice-desc"
        className="employee-modal-surface submit-success relative w-full max-w-[400px] overflow-hidden rounded-3xl bg-white shadow-[0_40px_80px_-30px_rgba(6,78,59,0.6)] ring-1 ring-emerald-100"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`relative overflow-hidden bg-gradient-to-br from-emerald-500 via-teal-500 to-cyan-600 px-6 pt-7 text-center text-white ${estimate ? 'pb-14' : 'pb-7'}`}>
          <span className="pointer-events-none absolute -left-8 -top-10 h-32 w-32 rotate-[22deg] rounded-[30%] bg-white/10" aria-hidden="true" />
          <span className="pointer-events-none absolute -right-10 top-6 h-28 w-28 -rotate-12 rounded-[30%] bg-cyan-300/20" aria-hidden="true" />
          <span className="pointer-events-none absolute bottom-6 left-10 h-3 w-3 rotate-12 rounded-[4px] bg-white/25" aria-hidden="true" />
          <svg className="pointer-events-none absolute inset-x-0 bottom-0 h-10 w-full" viewBox="0 0 400 40" preserveAspectRatio="none" fill="none" aria-hidden="true">
            <path d="M0 24C60 12 120 34 200 22S330 8 400 20" stroke="rgb(255 255 255 / 0.22)" />
            <path d="M0 32C70 22 130 40 210 30S340 18 400 28" stroke="rgb(255 255 255 / 0.14)" />
          </svg>
          {[
            { l: '18%', t: '30%', d: '0.5s', s: 10 },
            { l: '80%', t: '24%', d: '0.8s', s: 8 },
            { l: '72%', t: '62%', d: '1.1s', s: 12 },
            { l: '26%', t: '66%', d: '1.4s', s: 7 },
            { l: '88%', t: '50%', d: '0.65s', s: 6 },
          ].map((p, i) => (
            <svg key={i} className="submit-success-spark pointer-events-none absolute" style={{ left: p.l, top: p.t, width: p.s, height: p.s, animationDelay: p.d }} viewBox="0 0 10 10" aria-hidden="true">
              <path d="M5 0L6.2 3.8L10 5L6.2 6.2L5 10L3.8 6.2L0 5L3.8 3.8Z" fill="#fff" />
            </svg>
          ))}

          <div className="relative mx-auto h-[72px] w-[72px]" aria-hidden="true">
            <span className="submit-success-ring absolute inset-0 rounded-full border-2 border-white/70" />
            <span className="submit-success-ring submit-success-ring-2 absolute inset-0 rounded-full border-2 border-white/50" />
            <span className="submit-success-badge absolute inset-0 rounded-full bg-white shadow-[0_14px_30px_-10px_rgba(4,47,46,0.55)]" />
            <svg className="absolute inset-0" viewBox="0 0 72 72" fill="none">
              <path className="submit-success-check" d="M23 37l9 9 18-20" stroke="#059669" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" pathLength={1} />
            </svg>
          </div>
          <h3 id="submit-notice-title" className="relative mt-4 text-xl font-bold tracking-tight sm:text-2xl">{title}</h3>
          <p id="submit-notice-desc" className="relative mx-auto mt-1.5 flex max-w-[310px] items-start justify-center gap-1.5 text-[13px] leading-snug text-emerald-50/95">
            <Clock className="mt-[3px] h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{message}</span>
          </p>
        </div>

        {estimate && (
          <div className="relative -mt-9 px-5 sm:px-6">
            <div className="submit-success-card relative overflow-hidden rounded-2xl border border-amber-200/80 bg-gradient-to-br from-amber-50 via-white to-emerald-50/70 p-4 shadow-[0_20px_40px_-22px_rgba(180,83,9,0.5)] sm:p-5">
              <span className="submit-success-shine pointer-events-none absolute inset-y-0 -left-1/2 w-1/2" aria-hidden="true" />
              <span className="pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-[30%] bg-amber-200/30" aria-hidden="true" />
              <p className="relative flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-amber-700">
                <span className="flex h-5 w-5 items-center justify-center rounded-md bg-gradient-to-br from-amber-400 to-orange-500 text-white shadow-sm" aria-hidden="true">
                  <Coins className="h-3 w-3" strokeWidth={2.4} />
                </span>
                {labels.estimated}
              </p>
              <div className="relative mt-2.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="sr-only">{`${estimate.commission.toFixed(2)} ${currencyUnit}`}</span>
                <span className="flex min-w-0 items-baseline" aria-hidden="true">
                  <span className="mr-0.5 text-2xl font-black text-amber-500 sm:text-[28px]">+</span>
                  <span className="min-w-0 break-all bg-gradient-to-br from-amber-500 via-orange-500 to-amber-600 bg-clip-text text-[34px] font-black leading-none tracking-tight text-transparent tabular-nums sm:text-[40px]">
                    {shown.toFixed(2)}
                  </span>
                </span>
                <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-bold tracking-wider text-amber-700 ring-1 ring-amber-200" aria-hidden="true">{currencyUnit}</span>
              </div>
              <dl className="relative mt-3.5 grid grid-cols-2 gap-3 border-t border-dashed border-amber-200 pt-3 text-xs">
                <div className="min-w-0">
                  <dt className="truncate text-slate-500">{labels.amount}</dt>
                  <dd className="mt-0.5 truncate font-semibold tabular-nums text-slate-800">{estimate.amount.toFixed(2)} <span className="text-slate-400">{currencyUnit}</span></dd>
                </div>
                <div className="min-w-0 text-right">
                  <dt className="truncate text-slate-500">{labels.rate}</dt>
                  <dd className="mt-0.5 font-semibold tabular-nums text-emerald-700">{formatRate(estimate.rate)}</dd>
                </div>
              </dl>
              <p className="relative mt-3 flex items-start gap-1.5 rounded-lg bg-emerald-500/[0.07] px-2.5 py-2 text-[11px] leading-snug text-emerald-800">
                <Wallet className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0">{labels.note}</span>
              </p>
            </div>
          </div>
        )}

        <div className="px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[46px] w-full rounded-xl bg-gradient-to-r from-emerald-500 to-teal-600 px-4 py-3 text-sm font-semibold tracking-wide text-white shadow-[0_14px_28px_-14px_rgba(5,150,105,0.8)] transition hover:brightness-105 active:scale-[0.99] sm:text-base"
          >
            {action}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

const NOTICE_TONES: Record<NoticeTone, {
  accent: string;
  band: string;
  block: string;
  tile: string;
  dot: string;
  box: string;
  chip: string;
  button: string;
  Icon: LucideIcon;
}> = {
  warning: {
    accent: 'from-amber-400 via-orange-400 to-amber-500',
    band: 'from-amber-50 via-orange-50/50 to-white border-amber-100',
    block: 'bg-amber-200/40',
    tile: 'from-amber-400 to-orange-500 shadow-[0_10px_22px_-10px_rgba(234,88,12,0.7)]',
    dot: 'bg-amber-500',
    box: 'border-amber-200/80 bg-amber-50/70 text-amber-900',
    chip: 'bg-white text-amber-600 ring-amber-200',
    button: 'from-amber-500 to-orange-500 shadow-[0_14px_28px_-14px_rgba(234,88,12,0.8)]',
    Icon: AlertTriangle,
  },
  error: {
    accent: 'from-rose-400 via-red-500 to-rose-500',
    band: 'from-rose-50 via-red-50/50 to-white border-rose-100',
    block: 'bg-rose-200/40',
    tile: 'from-rose-500 to-red-600 shadow-[0_10px_22px_-10px_rgba(220,38,38,0.7)]',
    dot: 'bg-rose-500',
    box: 'border-rose-200/80 bg-rose-50/70 text-rose-900',
    chip: 'bg-white text-rose-600 ring-rose-200',
    button: 'from-rose-500 to-red-600 shadow-[0_14px_28px_-14px_rgba(220,38,38,0.8)]',
    Icon: X,
  },
};

function SubmitNotice({ tone, eyebrow, title, message, action, onClose }: {
  tone: NoticeTone;
  eyebrow: string;
  title: string;
  message: string;
  action: string;
  onClose: () => void;
}) {
  const style = NOTICE_TONES[tone];
  const { Icon } = style;
  return createPortal(
    <div
      className="employee-modal-backdrop fixed inset-0 z-[10000] flex items-center justify-center bg-slate-900/45 p-4 sm:p-6"
      style={{ touchAction: 'none', overscrollBehavior: 'contain' }}
      onClick={onClose}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="submit-notice-title"
        className="employee-modal-surface relative w-full max-w-[380px] overflow-hidden rounded-2xl bg-white shadow-[0_30px_70px_-30px_rgba(15,23,42,0.55)] ring-1 ring-slate-200 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <span className={`pointer-events-none absolute inset-x-0 top-0 z-10 h-1 bg-gradient-to-r ${style.accent}`} aria-hidden="true" />

        <div className={`relative overflow-hidden border-b bg-gradient-to-br px-5 pb-5 pt-6 sm:px-6 ${style.band}`}>
          <span className={`pointer-events-none absolute -right-6 -top-8 h-24 w-24 rotate-[18deg] rounded-[30%] ${style.block}`} aria-hidden="true" />
          <span className={`pointer-events-none absolute right-16 top-12 h-3 w-3 rotate-12 rounded-[4px] ${style.block}`} aria-hidden="true" />
          <div className="relative flex items-center gap-3">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white ring-1 ring-white/60 ${style.tile}`}>
              <Icon className="h-5 w-5" strokeWidth={2.6} aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h3 id="submit-notice-title" className="text-lg font-bold leading-tight tracking-tight text-slate-900 sm:text-xl">
                {title}
              </h3>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
                <span className="truncate">{eyebrow}</span>
              </p>
            </div>
          </div>
        </div>

        <div className="px-5 pb-5 pt-5 sm:px-6 sm:pb-6">
          <div className={`flex items-start gap-3 rounded-xl border px-3.5 py-3 ${style.box}`}>
            <span className={`mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ${style.chip}`} aria-hidden="true">
              <Icon className="h-3.5 w-3.5" strokeWidth={2.6} />
            </span>
            <p className="min-w-0 break-words pt-0.5 text-sm font-medium leading-relaxed">{message}</p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className={`mt-4 min-h-[46px] w-full rounded-xl bg-gradient-to-r px-4 py-3 text-sm font-semibold tracking-wide text-white hover:brightness-105 sm:text-base ${style.button}`}
          >
            {action}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function makeDeclarationCode() {
  const r = crypto.getRandomValues(new Uint32Array(14));
  const pick = (set: string, i: number) => set[r[i] % set.length];
  const digits = (from: number, n: number) => Array.from({ length: n }, (_, i) => String(r[from + i] % 10)).join('');
  return `${pick(CODE_LETTERS, 0)}${pick(CODE_LETTERS, 1)}${digits(2, 6)}${pick(CODE_ALNUM, 8)}${pick(CODE_ALNUM, 9)}${digits(10, 4)}`;
}

// Visual-only barcode: a seeded bar/space sequence so each declaration code renders a distinct, stable pattern.
function DocBarcode({ value, className }: { value: string; className?: string }) {
  let seed = 2166136261;
  for (const ch of value) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619);
  const next = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const bars: { x: number; w: number }[] = [];
  let x = 0;
  const pattern = [2, 1, 1, 2, 3, 2];
  for (let i = 0; i < 64; i++) pattern.push(1 + Math.floor(next() * (i % 2 === 0 ? 3.4 : 3)));
  pattern.push(2, 3, 3, 1, 1, 1, 2);
  pattern.forEach((w, i) => {
    if (i % 2 === 0) bars.push({ x, w });
    x += w;
  });
  return (
    <svg className={className} viewBox={`0 0 ${x} 40`} preserveAspectRatio="none" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      {bars.map((bar, i) => <rect key={i} x={bar.x} y="0" width={bar.w} height="40" />)}
    </svg>
  );
}

function ConfirmStamp({ ring, center, date, className }: { ring: string; center: string; date: string; className?: string }) {
  const pathId = useId();
  const ringText = ring.length <= 12 ? `${ring} ★ ${ring} ★ ` : `${ring} ★ `;
  return (
    <svg className={className} viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <defs>
        <path id={pathId} d="M60 60m-39 0a39 39 0 1 1 78 0a39 39 0 1 1-78 0" />
      </defs>
      <circle cx="60" cy="60" r="56" stroke="currentColor" strokeWidth="3" />
      <circle cx="60" cy="60" r="51" stroke="currentColor" strokeWidth="1" />
      <circle cx="60" cy="60" r="32" stroke="currentColor" strokeWidth="1.2" />
      <text fill="currentColor" fontSize="9" fontWeight="700">
        <textPath href={`#${pathId}`} textLength="240" lengthAdjust="spacing">{ringText}</textPath>
      </text>
      <path d="M60 36l1.8 3.7 4 .6-2.9 2.8.7 4-3.6-1.9-3.6 1.9.7-4-2.9-2.8 4-.6z" fill="currentColor" />
      <path d="M36 52h48M36 70h48" stroke="currentColor" strokeWidth="1" />
      <text x="60" y="65" fill="currentColor" fontSize={center.length <= 4 ? 13 : center.length <= 7 ? 11 : 9.5} fontWeight="800" textAnchor="middle">{center}</text>
      <text x="60" y="80" fill="currentColor" fontSize="6.5" fontWeight="600" textAnchor="middle" fontFamily="ui-monospace, monospace">{date}</text>
    </svg>
  );
}

const PORT_NAVY = '#12356d';
const PORT_DEEP = '#0b2350';
const PORT_LATTICE = `M48 55${'l4-4.5 4 4.5'.repeat(36)}`;
const PORT_HULL = 'M184 139C192 141 204 145.6 218 146H398L395 158Q392 170 382 176H214Q204 176 199 168Q188 160 184 139Z';
const PORT_JOINTS = Array.from({ length: 16 }, (_, i) => `M${-392 + i * 36} 153v23`).join('');
const PORT_WINDOWS = [120.5, 128.5, 136.5].flatMap((y) => [355, 360, 365, 370, 375].map((x) => `M${x} ${y}h3v2h-3z`)).join('');

const PORT_WAVE_LENGTH = 72;

// Repeated wide enough to slide one wavelength seamlessly; crest height is amp / 2.
function PortWave({ y, amp, offset = 0, fill, opacity, crest, className }: { y: number; amp: number; offset?: number; fill: string; opacity: number; crest: number; className: string }) {
  const half = PORT_WAVE_LENGTH / 2;
  const start = -460 - offset;
  const line = `M${start} ${y}${` q${half / 2} ${-amp} ${half} 0 t${half} 0`.repeat(21)}`;
  return (
    <g className={`port-wave ${className}`}>
      <path d={`${line} V240 H${start}Z`} fill={fill} fillOpacity={opacity} />
      <path d={line} stroke="#ffffff" strokeOpacity={crest} strokeWidth="0.8" strokeLinecap="round" />
    </g>
  );
}

type PortBoxTone = 'navy' | 'blue' | 'sky' | 'silver' | 'cyan';

function PortBox({ x, y, w = 34, tone }: { x: number; y: number; w?: number; tone: PortBoxTone }) {
  const inner = w - 6;
  const count = Math.round(inner / 3);
  const ribs = Array.from({ length: count - 1 }, (_, i) => `M${x + 1.5 + (inner * (i + 1)) / count} ${y + 2}v10`).join('');
  const corner = (cx: number, cy: number) => `M${cx} ${cy}h1.6v1.6h-1.6z`;
  return (
    <g>
      <rect x={x} y={y} width={w} height={14} fill={`url(#pg-c-${tone})`} stroke={PORT_DEEP} strokeOpacity="0.28" strokeWidth="0.4" />
      <path d={ribs} stroke={PORT_DEEP} strokeOpacity={tone === 'silver' ? 0.13 : 0.22} strokeWidth="0.5" />
      <rect x={x + w - 4.5} y={y} width="4.5" height="14" fill={PORT_DEEP} fillOpacity="0.14" />
      <path d={`M${x + w - 3} ${y + 2}v10M${x + w - 1.5} ${y + 2}v10`} stroke="#ffffff" strokeOpacity="0.4" strokeWidth="0.4" />
      <rect x={x} y={y} width={w} height="1.2" fill="#ffffff" fillOpacity="0.55" />
      <rect x={x} y={y + 12.8} width={w} height="1.2" fill={PORT_DEEP} fillOpacity="0.25" />
      <path d={corner(x, y) + corner(x + w - 1.6, y) + corner(x, y + 12.4) + corner(x + w - 1.6, y + 12.4)} fill={PORT_DEEP} fillOpacity="0.35" />
    </g>
  );
}

// Shaded port illustration. Ship docks first, then the crane loops: lift a box off the ship, run along the boom, set it on the quay.
function PortScene() {
  return (
    <svg className="submit-port-svg" viewBox="40 0 360 210" fill="none" preserveAspectRatio="xMidYMax meet" overflow="visible">
      <defs>
        <linearGradient id="pg-steel" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#3a6fc4" />
          <stop offset="0.35" stopColor="#1d4f96" />
          <stop offset="1" stopColor="#10305f" />
        </linearGradient>
        <linearGradient id="pg-steel-v" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a6fc4" />
          <stop offset="1" stopColor="#10305f" />
        </linearGradient>
        <linearGradient id="pg-house" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#d5dfee" />
        </linearGradient>
        <linearGradient id="pg-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7ee7fb" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
        <linearGradient id="pg-spreader" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f1f5f9" />
          <stop offset="1" stopColor="#8fa3bf" />
        </linearGradient>
        <linearGradient id="pg-hull" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#21529e" />
          <stop offset="0.55" stopColor={PORT_NAVY} />
          <stop offset="1" stopColor={PORT_DEEP} />
        </linearGradient>
        <linearGradient id="pg-hull-sheen" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.22" stopColor="#ffffff" stopOpacity="0.13" />
          <stop offset="0.4" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="pg-reflect" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={PORT_NAVY} stopOpacity="0.3" />
          <stop offset="1" stopColor={PORT_NAVY} stopOpacity="0" />
        </linearGradient>
        <linearGradient id="pg-quay-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f8fafc" />
          <stop offset="1" stopColor="#dbe4f1" />
        </linearGradient>
        <linearGradient id="pg-quay-face" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dce6f4" />
          <stop offset="1" stopColor="#b3c5e1" />
        </linearGradient>
        <linearGradient id="pg-water" x1="0" y1="156" x2="0" y2="214" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#93c5fd" stopOpacity="0.6" />
          <stop offset="1" stopColor="#dbeafe" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="pg-c-navy" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2f62b8" />
          <stop offset="1" stopColor="#163d7a" />
        </linearGradient>
        <linearGradient id="pg-c-blue" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5b9bff" />
          <stop offset="1" stopColor="#1d4ed8" />
        </linearGradient>
        <linearGradient id="pg-c-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b2e8fe" />
          <stop offset="1" stopColor="#5bc0ee" />
        </linearGradient>
        <linearGradient id="pg-c-silver" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#cfd9e8" />
        </linearGradient>
        <linearGradient id="pg-c-cyan" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6eecff" />
          <stop offset="1" stopColor="#0e8fc4" />
        </linearGradient>
        <linearGradient id="port-sweep" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="port-sweep-fade" x1="0" y1="20" x2="0" y2="176" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.6" stopColor="#ffffff" stopOpacity="1" />
        </linearGradient>
        <linearGradient id="port-sweep-edge" x1="0" y1="20" x2="0" y2="176" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#22d3ee" stopOpacity="0" />
          <stop offset="1" stopColor="#22d3ee" stopOpacity="0.7" />
        </linearGradient>
        <mask id="port-sweep-mask" maskUnits="userSpaceOnUse" x="-40" y="16" width="44" height="164">
          <rect x="-40" y="20" width="44" height="156" fill="url(#port-sweep-fade)" />
        </mask>
        <filter id="pg-glow" x="-50%" y="-80%" width="200%" height="260%">
          <feGaussianBlur stdDeviation="2.6" />
        </filter>
        <filter id="pg-soft" x="-20%" y="-200%" width="140%" height="500%">
          <feGaussianBlur stdDeviation="1.4" />
        </filter>
        <clipPath id="pg-hull-clip">
          <path d={PORT_HULL} />
        </clipPath>
      </defs>

      <rect x="-400" y="156" width="1200" height="74" fill="url(#pg-water)" />
      <PortWave y={160} amp={2.4} fill="#b6d4fa" opacity={0.55} crest={0.65} className="port-wave-back" />

      <rect x="-400" y="153" width="580" height="23" fill="url(#pg-quay-face)" />
      <path d={PORT_JOINTS} stroke="#9fb3d4" strokeOpacity="0.7" strokeWidth="0.5" />
      <rect x="-400" y="150" width="580" height="3.2" fill="url(#pg-quay-top)" />
      <path d="M-400 150H180M-400 153.2H180" stroke="#8aa3c8" strokeWidth="0.5" />
      <path d="M60 150.4H180" stroke={PORT_NAVY} strokeOpacity="0.5" strokeWidth="0.6" />
      <rect x="177" y="150" width="3" height="26" fill="#a9bddb" />
      <rect x="178.5" y="155" width="3.5" height="13" rx="1.6" fill={PORT_DEEP} />
      <path d="M0 150v-2.2h1v-1h3v1h1v2.2zM171 150v-2.2h1v-1h3v1h1v2.2z" fill={PORT_NAVY} />

      <g className="port-yard-far">
        <rect x="-28" y="148.5" width="62" height="3" fill={PORT_DEEP} fillOpacity="0.18" filter="url(#pg-soft)" />
        <PortBox x={-26} y={136} w={30} tone="navy" />
        <PortBox x={4} y={136} w={30} tone="silver" />
        <PortBox x={-11} y={122} w={30} tone="sky" />
        <PortBox x={19} y={122} w={30} tone="silver" />
      </g>
      <rect x="32" y="148.5" width="34" height="3" fill={PORT_DEEP} fillOpacity="0.18" filter="url(#pg-soft)" />
      <PortBox x={34} y={136} w={30} tone="blue" />
      <g className="port-yard-near">
        <PortBox x={34} y={122} w={30} tone="silver" />
      </g>
      <g className="port-quay-slot">
        <PortBox x={102} y={136} tone="cyan" />
      </g>

      <g className="port-ship-arrive">
        <path d="M206 176H384L380 191H214Z" fill="url(#pg-reflect)" />
        <g className="port-ship-bob">
          <path d="M360 101V88.5M356 92h8" stroke={PORT_NAVY} strokeWidth="0.9" strokeLinecap="round" />
          <rect className="port-radar" x="355.5" y="87.5" width="9" height="1.4" rx="0.7" fill={PORT_NAVY} />
          <circle className="port-ping" cx="360" cy="88.2" r="12" stroke="#38bdf8" strokeWidth="0.8" />
          <circle className="port-ping port-ping-late" cx="360" cy="88.2" r="12" stroke="#38bdf8" strokeWidth="0.8" />
          <path d="M370 101L372 87H383L382 101Z" fill="url(#pg-steel-v)" />
          <rect x="371.6" y="90" width="11.2" height="2.4" fill="#60a5fa" />
          <rect x="372" y="86" width="11" height="1.6" fill={PORT_DEEP} />

          <rect x="352" y="110" width="30" height="36" fill="url(#pg-house)" stroke="#9fb3d1" strokeWidth="0.5" />
          <path d="M352 118h30M352 126h30M352 134h30" stroke="#9fb3d1" strokeOpacity="0.8" strokeWidth="0.5" />
          <path d={PORT_WINDOWS} fill={PORT_NAVY} fillOpacity="0.8" />
          <rect x="348" y="102.5" width="38" height="7.5" fill="url(#pg-house)" stroke="#9fb3d1" strokeWidth="0.5" />
          <rect x="350" y="104.6" width="34" height="3.4" rx="0.5" fill="url(#pg-glass)" />
          <path d="M354 104.6l2 3.4M366 104.6l2 3.4M378 104.6l2 3.4" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="0.5" />
          <rect x="345" y="101" width="44" height="1.8" rx="0.6" fill={PORT_NAVY} />

          <PortBox x={202} y={132} tone="navy" />
          <PortBox x={236} y={132} tone="silver" />
          <PortBox x={270} y={132} tone="blue" />
          <PortBox x={304} y={132} tone="silver" />
          <PortBox x={202} y={118} tone="sky" />
          <PortBox x={270} y={118} tone="silver" />
          <PortBox x={304} y={118} tone="navy" />
          <g className="port-ship-slot">
            <PortBox x={236} y={118} tone="cyan" />
          </g>

          <path d="M194 140.5V126.5M395 146V135" stroke={PORT_NAVY} strokeWidth="0.85" strokeLinecap="round" />
          <circle cx="194" cy="126" r="1" fill="#ffffff" stroke={PORT_NAVY} strokeWidth="0.5" />
          <circle cx="395" cy="134.6" r="0.8" fill="#ffffff" stroke={PORT_NAVY} strokeWidth="0.4" />
          <path d={PORT_HULL} fill="url(#pg-hull)" />
          <rect x="184" y="139" width="214" height="37" fill="url(#pg-hull-sheen)" clipPath="url(#pg-hull-clip)" />
          <rect x="180" y="164" width="222" height="14" fill="#081a3a" fillOpacity="0.5" clipPath="url(#pg-hull-clip)" />
          <path d="M186 141.4C194 143.4 205 147.4 218 147.8H396.6" stroke="#ffffff" strokeOpacity="0.6" strokeWidth="1" />
          <circle cx="190.5" cy="146" r="1.1" fill={PORT_DEEP} />
        </g>
      </g>
      <g className="port-swell">
        <PortWave y={172.5} amp={3.2} offset={24} fill="#cfe3fc" opacity={0.8} crest={0.95} className="port-wave-front" />
      </g>
      <PortWave y={184} amp={2.8} offset={48} fill="#a9cbf6" opacity={0.42} crest={0.55} className="port-wave-mid" />
      <PortWave y={196} amp={2.2} offset={12} fill="#97bff3" opacity={0.32} crest={0.45} className="port-wave-low" />

      <g className="port-route-wrap">
        <path className="port-route" d="M253 118V84H119V136" stroke="#22d3ee" strokeOpacity="0.5" strokeWidth="0.9" strokeDasharray="2 4" strokeLinecap="round" strokeLinejoin="round" />
      </g>

      <rect x="68" y="144" width="18" height="3" rx="0.8" fill={PORT_NAVY} />
      <rect x="152" y="144" width="18" height="3" rx="0.8" fill={PORT_NAVY} />
      <g fill={PORT_DEEP}>
        <circle cx="71.5" cy="148.4" r="1.8" />
        <circle cx="77" cy="148.4" r="1.8" />
        <circle cx="82.5" cy="148.4" r="1.8" />
        <circle cx="155.5" cy="148.4" r="1.8" />
        <circle cx="161" cy="148.4" r="1.8" />
        <circle cx="166.5" cy="148.4" r="1.8" />
      </g>
      <rect x="74" y="60" width="6" height="84" fill="url(#pg-steel)" />
      <rect x="158" y="60" width="6" height="84" fill="url(#pg-steel)" />
      <path d="M74.8 62V144M158.8 62V144" stroke="#7fa8ea" strokeOpacity="0.7" strokeWidth="0.6" />
      <path d="M80 64L158 95M158 64L80 95" stroke="#1d4f96" strokeOpacity="0.55" strokeWidth="1.2" />
      <rect x="80" y="95" width="78" height="3" fill="url(#pg-steel-v)" />
      <rect x="70" y="57" width="98" height="7" rx="0.8" fill="url(#pg-steel-v)" />

      <path d="M119 15L338 50M119 17L268 50M119 15L46 50" stroke={PORT_NAVY} strokeOpacity="0.6" strokeWidth="0.8" />
      <path d="M107 57L117.5 14H120.5L131 57H127L119 21L111 57Z" fill="url(#pg-steel)" />
      <rect x="112" y="38" width="14" height="2" fill="url(#pg-steel-v)" />
      <rect x="115" y="11" width="8" height="4" rx="0.8" fill={PORT_NAVY} />
      <circle className="port-beacon" cx="119" cy="9.6" r="3.2" fill="#f87171" fillOpacity="0.35" />
      <circle className="port-beacon" cx="119" cy="9.6" r="1.3" fill="#ef4444" />

      <rect x="44" y="49" width="296" height="7" rx="1" fill="url(#pg-steel-v)" />
      <path d={PORT_LATTICE} stroke="#8fb4f0" strokeOpacity="0.45" strokeWidth="0.6" />
      <rect x="44" y="49" width="296" height="1" rx="0.5" fill="#ffffff" fillOpacity="0.3" />
      <circle cx="338" cy="52.5" r="1.6" fill="#8fb4f0" />

      <rect x="48" y="37" width="36" height="12" rx="1" fill="url(#pg-house)" stroke="#9fb3d1" strokeWidth="0.5" />
      <rect x="48" y="37" width="36" height="2.2" rx="1" fill={PORT_NAVY} />
      <path d="M53 42v4M56 42v4M59 42v4M62 42v4" stroke="#9fb3d1" strokeWidth="0.6" />
      <rect x="66" y="42.5" width="13" height="1.6" rx="0.8" fill="#38bdf8" />
      <circle className="port-blink" cx="80.5" cy="46.5" r="1" fill="#38bdf8" />

      <g className="port-sweep">
        <rect x="-36" y="20" width="36" height="156" fill="url(#port-sweep)" mask="url(#port-sweep-mask)" />
        <path d="M0 20V176" stroke="url(#port-sweep-edge)" strokeWidth="0.8" />
      </g>

      <g className="port-trolley">
        <rect x="244" y="56" width="18" height="5.5" rx="1" fill="url(#pg-steel-v)" />
        <circle cx="247.5" cy="56.2" r="1.2" fill={PORT_DEEP} />
        <circle cx="258.5" cy="56.2" r="1.2" fill={PORT_DEEP} />
        <rect x="242.5" y="60.5" width="7.5" height="6.5" rx="1.2" fill="url(#pg-house)" stroke="#9fb3d1" strokeWidth="0.4" />
        <rect x="243.3" y="62" width="5.9" height="2.8" rx="0.5" fill="url(#pg-glass)" />
        <circle className="port-blink" cx="260" cy="58.8" r="0.8" fill="#38bdf8" />
        <rect className="port-cable" x="251.3" y="62" width="0.9" height="12" fill={PORT_DEEP} fillOpacity="0.8" />
        <rect className="port-cable" x="253.8" y="62" width="0.9" height="12" fill={PORT_DEEP} fillOpacity="0.8" />
        <g className="port-load">
          <rect x="248" y="71.5" width="10" height="2.6" rx="0.6" fill={PORT_NAVY} />
          <rect x="233" y="73.6" width="40" height="3.4" rx="0.8" fill="url(#pg-spreader)" stroke="#7b8fae" strokeWidth="0.4" />
          <path d="M233 77h2v1.2h-2zM271 77h2v1.2h-2z" fill={PORT_DEEP} />
          <circle cx="234.8" cy="75.3" r="0.8" fill="#38bdf8" />
          <circle cx="271.2" cy="75.3" r="0.8" fill="#38bdf8" />
          <g className="port-cargo">
            <rect className="port-glow" x="234" y="76" width="38" height="17" rx="2" fill="#22d3ee" fillOpacity="0.55" filter="url(#pg-glow)" />
            <PortBox x={236} y={77} tone="cyan" />
          </g>
        </g>
      </g>
    </svg>
  );
}
