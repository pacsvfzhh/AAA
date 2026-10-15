import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Package, Wallet, BarChart3, LogOut, User, PackageSearch, X, Lock, ChevronDown, Gift, AlertCircle, Zap, Shield, Radio } from 'lucide-react';
import { Employee, MessageWithRecipient } from '../../types';
import { AUTH_STORAGE_KEY, getEmployeeFinancialSession, getStoredAuth, leaveSessionForAnotherTab, logout } from '../../lib/auth';
import { logEmployeeLogin } from '../../lib/loginHistoryService';
import { formatSupabaseError, isSupabaseTransientError, supabase } from '../../lib/supabase';
import { useCompanyName } from '../../lib/useCompanyName';
import { useResponsive } from '../../lib/useResponsive';
import { tabSessionManager } from '../../lib/TabSessionManager';
import { useLanguage } from '../../lib/i18n/context';
import type { Language } from '../../lib/i18n/types';
import type { Database } from '../../types/database';
import LanguageSwitcher, { LanguageModal } from '../LanguageSwitcher';
import PhoneLandscapeGuard from '../PhoneLandscapeGuard';
import SessionExpiredModal from './SessionExpiredModal';
import MessageCenter from './MessageCenter';
import LoginPopupMessages from './LoginPopupMessages';
import PasswordChange from './PasswordChange';

import PageLoader from './PageLoader';
import EmployeeBootScreen from './EmployeeBootScreen';

const AnnouncementBoard = lazy(() => import('./AnnouncementBoard'));
const loadOrderSubmission = () => import('./OrderSubmission');
const loadOrderList = () => import('./OrderList');
const loadWalletOverview = () => import('./WalletOverview');
const loadDailyStatistics = () => import('./DailyStatistics');
const loadOrderDispatch = () => import('./OrderDispatch');
const OrderSubmission = lazy(loadOrderSubmission);
const OrderList = lazy(loadOrderList);
const WalletOverview = lazy(loadWalletOverview);
const DailyStatistics = lazy(loadDailyStatistics);
const OrderDispatch = lazy(loadOrderDispatch);
const PAGE_CHUNKS = [loadOrderDispatch, loadOrderSubmission, loadOrderList, loadDailyStatistics, loadWalletOverview];
const CustomerServiceChat = lazy(() => import('./CustomerServiceChat'));

interface EmployeeDashboardProps {
  employee: Employee;
}

type RealtimeNotificationClaim = {
  claim_token: string;
  recipient: Omit<MessageWithRecipient, 'messages'>;
  message: MessageWithRecipient['messages'];
};

type MessageToast = {
  recipientId: string;
  title: string;
  content: string;
  priority: string;
  notificationCategory: string;
  rewardAmount: number | null;
  rewardCurrency: string | null;
  notification: MessageWithRecipient;
  summaryCount?: number;
};

const REALTIME_BACKLOG_SUMMARY_THRESHOLD = 3;

type EmployeeFinancialSession = ReturnType<typeof getEmployeeFinancialSession>;

function isExpiredEmployeeSession(error: unknown) {
  const message = formatSupabaseError(error).toLowerCase();
  return message.includes('employee session is invalid or expired')
    || message.includes('employee session has expired');
}

export default function EmployeeDashboard({ employee: initialEmployee }: EmployeeDashboardProps) {
  const [employee, setEmployee] = useState<Employee>(initialEmployee);
  const [activeTab, setActiveTab] = useState<'announcements' | 'orders' | 'wallet' | 'statistics' | 'dispatch'>('announcements');
  const [loadedTabs, setLoadedTabs] = useState<Set<string>>(new Set(['announcements']));
  const [showMessageCenter, setShowMessageCenter] = useState(false);
  const [messageToOpen, setMessageToOpen] = useState<MessageWithRecipient | null>(null);
  const [showLoginPopup, setShowLoginPopup] = useState(false);
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);
  const [hasNewMessage, setHasNewMessage] = useState(false);
  const [hasNewOrder, setHasNewOrder] = useState(false);
  const [hasOrderTimeout, setHasOrderTimeout] = useState(false);
  const [showMessageToast, setShowMessageToast] = useState(false);
  const [latestMessage, setLatestMessage] = useState<MessageToast | null>(null);
  const [messageToastQueue, setMessageToastQueue] = useState<MessageToast[]>([]);
  const [audioContextReady, setAudioContextReady] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [showSessionExpired, setShowSessionExpired] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showLanguageModal, setShowLanguageModal] = useState(false);
  const [showWithdrawalHistory, setShowWithdrawalHistory] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const employeeHeaderRef = useRef<HTMLElement>(null);
  const bellWrapRef = useRef<HTMLDivElement>(null);
  const toastCardRef = useRef<HTMLDivElement>(null);
  const [toastPos, setToastPos] = useState<{ top: number; right: number; arrow: number } | null>(null);
  const employeeNavRef = useRef<HTMLElement>(null);
  const { companyName } = useCompanyName(employee.created_by);
  const { isMobile, isTablet } = useResponsive();
  const { t, language, setLanguage } = useLanguage();
  const [bootPhase, setBootPhase] = useState<'show' | 'exit' | 'done'>('show');
  useEffect(() => {
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const showTimer = setTimeout(() => {
      setBootPhase('exit');
      exitTimer = setTimeout(() => setBootPhase('done'), 360);
    }, 600);
    return () => {
      clearTimeout(showTimer);
      if (exitTimer) clearTimeout(exitTimer);
    };
  }, []);
  const loadUnreadCountRef = useRef<(() => Promise<void>) | null>(null);
  const checkLoginPopupMessagesRef = useRef<((combinedOnly?: boolean, attempt?: number) => Promise<void>) | null>(null);
  const loginPopupGenerationRef = useRef(0);
  const processRealtimeRecipientRef = useRef<((recipientId: string) => Promise<void>) | null>(null);
  const recoverRealtimeNotificationsRef = useRef<(() => Promise<void>) | null>(null);
  const notificationChannelStatusRef = useRef('CLOSED');
  const notificationDeliveryActiveRef = useRef(false);
  const financialSessionInvalidRef = useRef(false);
  const deliveredRecipientIdsRef = useRef(new Set<string>());
  const realtimeDeliveryChainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const header = employeeHeaderRef.current;
    if (!header) return;

    let frame = 0;
    const syncHeaderHeight = () => {
      const value = `${header.getBoundingClientRect().height}px`;
      if (document.documentElement.style.getPropertyValue('--employee-header-height') !== value) {
        document.documentElement.style.setProperty('--employee-header-height', value);
      }
    };
    // Writing the variable inside the observer callback resizes <body>, which triggers the "ResizeObserver loop" warning.
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncHeaderHeight);
    });
    observer.observe(header);
    syncHeaderHeight();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.documentElement.style.removeProperty('--employee-header-height');
    };
  }, []);

  useEffect(() => {
    const body = document.body;
    const root = document.documentElement;
    // Modal scroll locks (fixed <body> with negative top, or overflow:hidden) drag the sticky header off-screen.
    const syncScrollLockOffset = () => {
      let offset = 0;
      if (body.style.position === 'fixed') {
        offset = Math.max(0, -parseFloat(body.style.top || '0') || 0);
      } else if (body.style.overflow === 'hidden' || root.style.overflow === 'hidden') {
        offset = Math.max(0, window.scrollY);
      }
      const value = `${offset}px`;
      if (root.style.getPropertyValue('--employee-scroll-lock-offset') !== value) {
        root.style.setProperty('--employee-scroll-lock-offset', value);
      }
    };
    const observer = new MutationObserver(syncScrollLockOffset);
    observer.observe(body, { attributes: true, attributeFilter: ['style'] });
    observer.observe(root, { attributes: true, attributeFilter: ['style'] });
    syncScrollLockOffset();
    return () => {
      observer.disconnect();
      root.style.removeProperty('--employee-scroll-lock-offset');
    };
  }, []);

  useLayoutEffect(() => {
    const nav = employeeNavRef.current;
    if (!nav) return;

    let frame = 0;
    const syncNavHeight = () => {
      const value = `${nav.getBoundingClientRect().height}px`;
      if (document.documentElement.style.getPropertyValue('--employee-bottom-nav-height') !== value) {
        document.documentElement.style.setProperty('--employee-bottom-nav-height', value);
      }
    };
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncNavHeight);
    });
    observer.observe(nav);
    syncNavHeight();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.documentElement.style.removeProperty('--employee-bottom-nav-height');
    };
  }, []);

  // Trigger auto messages for all eligible customers on login
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: customers } = await supabase
          .from('simulated_customers')
          .select('id')
          .eq('auto_messages_enabled', true)
          .eq('is_active', true)
          .eq('admin_id', employee.created_by);
        if (cancelled || !customers || customers.length === 0) return;

        const customerIds = customers.map(c => c.id);

        const [autoMsgsRes, logsRes] = await Promise.all([
          supabase
            .from('customer_auto_messages')
            .select('id, customer_id, content_type, title, subtitle, is_enabled')
            .in('customer_id', customerIds)
            .eq('is_enabled', true)
            .order('sort_order', { ascending: true }),
          supabase
            .from('customer_auto_message_logs')
            .select('auto_message_id')
            .in('customer_id', customerIds)
            .eq('employee_id', employee.id),
        ]);
        if (cancelled) return;

        const sentIds = new Set((logsRes.data || []).map(l => l.auto_message_id));
        const unsent = (autoMsgsRes.data || []).filter(m => !sentIds.has(m.id));
        if (unsent.length === 0) return;

        const unsentIds = unsent.map(m => m.id);
        const { data: fullMsgs } = await supabase
          .from('customer_auto_messages')
          .select('*')
          .in('id', unsentIds);
        if (cancelled || !fullMsgs || fullMsgs.length === 0) return;

        const fullMsgMap = new Map(fullMsgs.map(m => [m.id, m]));


        const baseTime = Date.now();
        const conversationPayloads = unsent.map((msg, idx: number) => {
          const full = fullMsgMap.get(msg.id) || { ...msg, content: '' };
          const isRichCard = full.content_type === 'rich_card';
          const payload: Database['public']['Tables']['customer_employee_conversations']['Insert'] = {
            customer_id: full.customer_id,
            employee_id: employee.id,
            sender_type: 'customer',
            message_content: isRichCard ? (full.title || 'Rich Card') : full.content,
            message_type: isRichCard ? 'rich_card' : 'text',
            created_at: new Date(baseTime + idx).toISOString(),
          };
          if (full.title) payload.title = full.title;
          if (full.subtitle) payload.subtitle = full.subtitle;
          if (isRichCard) payload.source_auto_message_id = full.id;
          return payload;
        });

        const logPayloads = unsent.map(msg => ({
          customer_id: msg.customer_id,
          employee_id: employee.id,
          auto_message_id: msg.id,
        }));

        await Promise.all([
          supabase.from('customer_employee_conversations').insert(conversationPayloads),
          supabase.from('customer_auto_message_logs').insert(logPayloads),
        ]);
      } catch (err) {
        console.error('Dashboard auto-message trigger error:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [employee.id, employee.created_by]);

  // Real-time sync employee data (especially is_verified status and session token)
  useEffect(() => {
    console.log('[EmployeeDashboard] Setting up real-time sync for employee data');

    // Get current session token from sessionStorage
    const auth = sessionStorage.getItem(AUTH_STORAGE_KEY);
    const currentSessionToken = auth ? JSON.parse(auth).sessionToken : null;

    // Subscribe to changes in the users table for this employee
    const channel = supabase
      .channel(`employee-${employee.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'users',
          filter: `id=eq.${employee.id}`
        },
        (payload) => {
          console.log('[EmployeeDashboard] Employee data updated:', payload.new);
          const updatedEmployee = payload.new as Employee;

          // Check if session token has changed (another login kicked us out)
          if (currentSessionToken && updatedEmployee.current_session_token !== currentSessionToken) {
            financialSessionInvalidRef.current = true;
            setShowSessionExpired(true);
            return;
          }

          // Update state
          setEmployee(updatedEmployee);

          // Update sessionStorage
          const auth = sessionStorage.getItem(AUTH_STORAGE_KEY);
          if (auth) {
            const authData = JSON.parse(auth);
            authData.user = updatedEmployee;
            sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authData));
            console.log('[EmployeeDashboard] Updated sessionStorage with new employee data');
          }
        }
      )
      .subscribe();

    // Cleanup
    return () => {
      console.log('[EmployeeDashboard] Cleaning up real-time subscription');
      supabase.removeChannel(channel);
    };
  }, [employee.id]);

  // Initialize tab session tracking
  useEffect(() => {
    const handleSessionExpired = () => {
      financialSessionInvalidRef.current = true;
      setShowSessionExpired(true);
    };

    const auth = getStoredAuth();
    const employeeAuth = auth?.userType === 'employee' ? auth : null;

    // Start tracking this tab's session
    tabSessionManager.startSession(employee.id, 'employee', handleSessionExpired, undefined, {
      sessionMarker: employeeAuth?.sessionToken,
      expiresAt: employeeAuth?.expiresAt,
      onHandover: leaveSessionForAnotherTab,
    });

    // Cleanup on unmount
    return () => {
      // Don't broadcast on unmount, just cleanup
      tabSessionManager.stopSession(false);
    };
  }, [employee.id]);

  // Handle session expired modal close
  const handleSessionExpiredClose = async () => {
    setShowSessionExpired(false);
    // Pass false to indicate this is NOT user-initiated logout (kicked out by another tab)
    await logout(false);
  };

  // Initialize audio context on first user interaction
  useEffect(() => {
    const initAudioContext = () => {
      if (!audioContextReady) {
        try {
          const AudioContextConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!AudioContextConstructor) return;
          const audioContext = new AudioContextConstructor();
          audioContext.resume().then(() => {
            setAudioContextReady(true);
            console.log('Audio context initialized and ready');
          });
        } catch (error) {
          console.error('Error initializing audio context:', error);
        }
      }
    };

    // Listen for any user interaction to initialize audio
    const events = ['click', 'touchstart', 'keydown'];
    events.forEach(event => {
      document.addEventListener(event, initAudioContext, { once: true });
    });

    return () => {
      events.forEach(event => {
        document.removeEventListener(event, initAudioContext);
      });
    };
  }, [audioContextReady]);

  // Handle click outside user menu to close it
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };

    if (showUserMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showUserMenu]);

  const handleOrderStatusChange = useCallback((newOrder: boolean, timeout: boolean) => {
    setHasNewOrder(newOrder);
    setHasOrderTimeout(timeout);
  }, []);
  const handleDispatchSessionExpired = useCallback(() => {
    financialSessionInvalidRef.current = true;
    setShowSessionExpired(true);
  }, []);
  const openOrdersTab = useCallback(() => setActiveTab('orders'), []);
  const openDispatchTab = useCallback(() => setActiveTab('dispatch'), []);
  const ordersActive = activeTab === 'orders';

  // Visited tabs stay mounted behind display:none; stable elements let a tab switch skip re-rendering every page.
  const announcementsPage = useMemo(() => <AnnouncementBoard userId={employee.id} />, [employee.id]);
  const dispatchPage = useMemo(() => (
    <OrderDispatch employee={employee} onStatusChange={handleOrderStatusChange} onSessionExpired={handleDispatchSessionExpired} onNavigateToOrders={openOrdersTab} />
  ), [employee, handleOrderStatusChange, handleDispatchSessionExpired, openOrdersTab]);
  const orderSubmissionPage = useMemo(() => (
    <OrderSubmission employeeId={employee.id} isActive={ordersActive} adminId={employee.created_by} onNavigateToDispatch={openDispatchTab} />
  ), [employee.id, employee.created_by, ordersActive, openDispatchTab]);
  const orderListPage = useMemo(() => <OrderList employeeId={employee.id} />, [employee.id]);
  const walletPage = useMemo(() => (
    <WalletOverview employeeId={employee.id} employee={employee} onWithdrawalHistoryChange={setShowWithdrawalHistory} />
  ), [employee]);
  const statisticsPage = useMemo(() => <DailyStatistics employeeId={employee.id} />, [employee.id]);
  const isTabMounted = (tab: string) => activeTab === tab || loadedTabs.has(tab);

  const tabs = [
    { id: 'announcements' as const, label: t.nav.announcements, mobileLabel: t.nav.announcementsMobile, icon: Bell },
    { id: 'dispatch' as const, label: t.nav.orderAssignment, mobileLabel: t.nav.orderAssignmentMobile, icon: PackageSearch },
    { id: 'orders' as const, label: t.nav.orders, mobileLabel: t.nav.ordersMobile, icon: Package },
    { id: 'statistics' as const, label: t.nav.dailyStatistics, mobileLabel: t.nav.dailyStatisticsMobile, icon: BarChart3 },
    { id: 'wallet' as const, label: t.nav.wallet, mobileLabel: t.nav.walletMobile, icon: Wallet },
  ];

  const isFirstTabRenderRef = useRef(true);
  useLayoutEffect(() => {
    if (isFirstTabRenderRef.current) {
      isFirstTabRenderRef.current = false;
      return;
    }
    // html has scroll-behavior: smooth; an animated scroll here shows as a jolt on the new tab
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [activeTab]);

  useEffect(() => {
    setLoadedTabs(prev => (prev.has(activeTab) ? prev : new Set(prev).add(activeTab)));
  }, [activeTab]);

  // Fetch page code in the background so a first visit renders without a loading screen.
  useEffect(() => {
    if (bootPhase !== 'done') return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      for (const load of PAGE_CHUNKS) {
        if (cancelled || !navigator.onLine) return;
        await load().catch(() => undefined);
      }
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [bootPhase]);

  useEffect(() => {
    const reconcileLoginAndNotifications = async () => {
      const storedAuth = sessionStorage.getItem(AUTH_STORAGE_KEY);
      const sessionMarker = storedAuth
        ? (JSON.parse(storedAuth) as { sessionToken?: string }).sessionToken
        : undefined;

      if (sessionMarker) {
        await logEmployeeLogin(
          employee.id,
          employee.username,
          employee.employee_id,
          sessionMarker,
        );
      }

      void loadUnreadCountRef.current?.();
      void checkLoginPopupMessagesRef.current?.(false);
    };

    void reconcileLoginAndNotifications();

    let recoveryQueued = false;
    let recoveryFailures = 0;
    let recoveryRetryAt = 0;
    let transientWarningShown = false;
    let cancelled = false;
    notificationDeliveryActiveRef.current = true;

    const recoverWhileActive = () => {
      if (
        cancelled
        || recoveryQueued
        || Date.now() < recoveryRetryAt
        || financialSessionInvalidRef.current
        || document.visibilityState !== 'visible'
        || !navigator.onLine
      ) return;

      recoveryQueued = true;
      void loadUnreadCountRef.current?.();
      realtimeDeliveryChainRef.current = realtimeDeliveryChainRef.current
        .then(async () => {
          if (cancelled || financialSessionInvalidRef.current || document.visibilityState !== 'visible' || !navigator.onLine) return;
          await recoverRealtimeNotificationsRef.current?.();
          recoveryFailures = 0;
          recoveryRetryAt = 0;
          transientWarningShown = false;
        })
        .catch(error => {
          if (cancelled) return;
          if (isExpiredEmployeeSession(error)) {
            financialSessionInvalidRef.current = true;
            setShowSessionExpired(true);
            return;
          }
          if (isSupabaseTransientError(error)) {
            recoveryFailures += 1;
            recoveryRetryAt = Date.now() + Math.min(30000 * 2 ** (recoveryFailures - 1), 300000);
            if (!transientWarningShown) {
              console.warn('Realtime notification recovery temporarily unavailable; retrying automatically:', formatSupabaseError(error));
              transientWarningShown = true;
            }
            return;
          }
          console.error('Error recovering realtime notifications:', formatSupabaseError(error));
        })
        .finally(() => { recoveryQueued = false; });
    };

    const recoverAfterInterruption = () => {
      if (cancelled || financialSessionInvalidRef.current || document.visibilityState !== 'visible' || !navigator.onLine) return;

      recoveryRetryAt = 0;
      void loadUnreadCountRef.current?.();
      recoverWhileActive();
      void checkLoginPopupMessagesRef.current?.(true);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') recoverAfterInterruption();
    };

    window.addEventListener('online', recoverAfterInterruption);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    const recoveryTimer = window.setInterval(recoverWhileActive, 30000);

    let channel: ReturnType<typeof supabase.channel> | null = null;
    const subscribeTimer = window.setTimeout(() => {
      channel = supabase
        .channel(`employee_new_messages_${employee.id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'message_recipients',
            filter: `recipient_id=eq.${employee.id}`
          },
          payload => {
            void loadUnreadCountRef.current?.();
            const recipientId = String((payload.new as { id?: string }).id || '');
            if (!recipientId || financialSessionInvalidRef.current || document.visibilityState !== 'visible' || !navigator.onLine || notificationChannelStatusRef.current !== 'SUBSCRIBED') return;
            realtimeDeliveryChainRef.current = realtimeDeliveryChainRef.current
              .then(() => processRealtimeRecipientRef.current?.(recipientId))
              .then(() => undefined)
              .catch(error => console.error('Error draining realtime notifications:', formatSupabaseError(error)));
          }
        )
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'message_recipients',
            filter: `recipient_id=eq.${employee.id}`
          },
          () => {
            void loadUnreadCountRef.current?.();
          }
        )
        .subscribe(status => {
          notificationChannelStatusRef.current = status;
          if (status === 'SUBSCRIBED') recoverAfterInterruption();
        });
    }, 0);

    return () => {
      cancelled = true;
      notificationDeliveryActiveRef.current = false;
      window.removeEventListener('online', recoverAfterInterruption);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.clearInterval(recoveryTimer);
      window.clearTimeout(subscribeTimer);
      notificationChannelStatusRef.current = 'CLOSED';
      if (channel) void supabase.removeChannel(channel);
    };
  }, [employee.employee_id, employee.id, employee.username]);



  const playNotificationSound = () => {
    // Create a pleasant notification sound with two tones
    try {
      const AudioContextConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextConstructor) return;
      const audioContext = new AudioContextConstructor();

      // Resume audio context if suspended (browser autoplay policy)
      if (audioContext.state === 'suspended') {
        audioContext.resume();
      }

      // First tone (higher pitch)
      const oscillator1 = audioContext.createOscillator();
      const gainNode1 = audioContext.createGain();

      oscillator1.connect(gainNode1);
      gainNode1.connect(audioContext.destination);

      oscillator1.frequency.value = 880; // A5 note
      oscillator1.type = 'sine';

      gainNode1.gain.setValueAtTime(0, audioContext.currentTime);
      gainNode1.gain.linearRampToValueAtTime(0.15, audioContext.currentTime + 0.05);
      gainNode1.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

      oscillator1.start(audioContext.currentTime);
      oscillator1.stop(audioContext.currentTime + 0.3);

      // Second tone (lower pitch) - plays after first
      const oscillator2 = audioContext.createOscillator();
      const gainNode2 = audioContext.createGain();

      oscillator2.connect(gainNode2);
      gainNode2.connect(audioContext.destination);

      oscillator2.frequency.value = 660; // E5 note
      oscillator2.type = 'sine';

      gainNode2.gain.setValueAtTime(0, audioContext.currentTime + 0.15);
      gainNode2.gain.linearRampToValueAtTime(0.15, audioContext.currentTime + 0.2);
      gainNode2.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);

      oscillator2.start(audioContext.currentTime + 0.15);
      oscillator2.stop(audioContext.currentTime + 0.5);

      console.log('Notification sound played successfully');
    } catch (error) {
      console.error('Error playing notification sound:', error);
    }
  };

  const loadUnreadCount = async () => {
    try {
      const { count, error } = await supabase
        .from('message_recipients')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_id', employee.id)
        .eq('is_read', false);

      if (!error && count !== null) {
        setUnreadMessageCount(count);
      }
    } catch (error) {
      console.error('Error loading unread count:', error);
    }
  };

  const checkLoginPopupMessages = async (combinedOnly = false, attempt = 0): Promise<void> => {
    if (financialSessionInvalidRef.current) return;
    const generation = loginPopupGenerationRef.current;
    try {
      const session = getEmployeeFinancialSession();
      const { data, error } = await supabase.rpc('has_pending_employee_login_notifications', {
        p_user_id: employee.id,
        p_session_token: session.token,
        p_tab_id: session.tabId,
        p_combined_only: combinedOnly,
      });
      if (error) throw error;
      if (data && generation === loginPopupGenerationRef.current) setShowLoginPopup(true);
    } catch (error) {
      if (isExpiredEmployeeSession(error)) {
        financialSessionInvalidRef.current = true;
        setShowSessionExpired(true);
        return;
      }
      if (isSupabaseTransientError(error)) {
        const retryDelays = [3000, 8000, 20000];
        if (attempt < retryDelays.length) {
          window.setTimeout(() => {
            if (generation !== loginPopupGenerationRef.current || document.visibilityState !== 'visible') return;
            void checkLoginPopupMessagesRef.current?.(combinedOnly, attempt + 1);
          }, retryDelays[attempt]);
          return;
        }
        console.warn('Login popup check skipped: Supabase is unreachable.', formatSupabaseError(error));
        return;
      }
      console.error('Error checking login popup messages:', formatSupabaseError(error));
    }
  };

  const confirmClaimedRealtimeNotification = async (
    result: RealtimeNotificationClaim,
    session: EmployeeFinancialSession,
  ): Promise<MessageToast | null> => {
    if (financialSessionInvalidRef.current) return null;
    const recipientId = result.recipient.id;
    const completionPayload = {
      p_user_id: employee.id,
      p_session_token: session.token,
      p_tab_id: session.tabId,
      p_recipient_id: recipientId,
      p_claim_token: result.claim_token,
      p_mark_read: false,
    };
    let completion = await supabase.rpc('complete_notification_delivery', completionPayload);
    if (completion.error && navigator.onLine && isSupabaseTransientError(completion.error)) {
      await new Promise(resolve => window.setTimeout(resolve, 300));
      if (financialSessionInvalidRef.current) return null;
      completion = await supabase.rpc('complete_notification_delivery', completionPayload);
    }
    if (completion.error) throw completion.error;
    const delivered = completion.data as { success?: boolean; delivery_channel?: MessageWithRecipient['delivery_channel']; delivered_at?: string; is_read?: boolean; read_at?: string | null } | null;
    if (!delivered?.success) {
      throw new Error('Notification delivery could not be confirmed.');
    }
    if (deliveredRecipientIdsRef.current.has(recipientId)) return null;

    deliveredRecipientIdsRef.current.add(recipientId);
    return {
      recipientId,
      title: result.message.title,
      content: result.message.content,
      priority: result.message.priority,
      notificationCategory: result.message.notification_category || 'standard',
      rewardAmount: result.message.reward_amount || null,
      rewardCurrency: result.message.reward_currency || null,
      notification: {
        ...result.recipient,
        delivery_channel: delivered.delivery_channel || 'realtime',
        delivered_at: delivered.delivered_at || null,
        is_read: delivered.is_read || false,
        read_at: delivered.read_at || null,
        messages: result.message,
      },
    };
  };

  const presentRealtimeNotifications = (toasts: MessageToast[]) => {
    if (toasts.length === 0) return;
    const latest = toasts[toasts.length - 1];
    const items: MessageToast[] = toasts.length > REALTIME_BACKLOG_SUMMARY_THRESHOLD
      ? [{
          ...latest,
          recipientId: `summary:${latest.recipientId}`,
          priority: 'normal',
          notificationCategory: 'standard',
          rewardAmount: null,
          rewardCurrency: null,
          summaryCount: toasts.length,
        }]
      : toasts;
    playNotificationSound();
    setHasNewMessage(true);
    setMessageToastQueue(previous => [
      ...previous,
      ...items.filter(item => !previous.some(existing => existing.recipientId === item.recipientId)),
    ]);
    void loadUnreadCountRef.current?.();
  };

  const processRealtimeRecipient = async (recipientId: string) => {
    if (financialSessionInvalidRef.current || deliveredRecipientIdsRef.current.has(recipientId)) return;

    try {
      const session = getEmployeeFinancialSession();
      const { data, error } = await supabase.rpc('claim_realtime_notification_delivery', {
        p_user_id: employee.id,
        p_session_token: session.token,
        p_tab_id: session.tabId,
        p_recipient_id: recipientId,
        p_lease_seconds: 120,
      });
      if (error) throw error;

      const result = data as RealtimeNotificationClaim | null;
      if (!result) return;
      const toast = await confirmClaimedRealtimeNotification(result, session);
      if (toast) presentRealtimeNotifications([toast]);
    } catch (error) {
      if (isExpiredEmployeeSession(error)) {
        financialSessionInvalidRef.current = true;
        setShowSessionExpired(true);
        return;
      }
      console.error('Error processing realtime notification:', formatSupabaseError(error));
    }
  };

  const recoverRealtimeNotifications = async () => {
    if (financialSessionInvalidRef.current) return;
    const session = getEmployeeFinancialSession();
    const recoveredToasts: MessageToast[] = [];
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (financialSessionInvalidRef.current || document.visibilityState !== 'visible' || !navigator.onLine || !notificationDeliveryActiveRef.current) return;

        const { data, error } = await supabase.rpc('claim_next_realtime_notification_delivery', {
          p_user_id: employee.id,
          p_session_token: session.token,
          p_tab_id: session.tabId,
          p_lease_seconds: 120,
        });
        if (error) throw error;

        const result = data as RealtimeNotificationClaim | null;
        if (!result) return;
        const toast = await confirmClaimedRealtimeNotification(result, session);
        if (toast) recoveredToasts.push(toast);
      }
    } finally {
      if (notificationDeliveryActiveRef.current) presentRealtimeNotifications(recoveredToasts);
    }
  };

  loadUnreadCountRef.current = loadUnreadCount;
  checkLoginPopupMessagesRef.current = checkLoginPopupMessages;
  processRealtimeRecipientRef.current = processRealtimeRecipient;
  recoverRealtimeNotificationsRef.current = recoverRealtimeNotifications;

  const dismissMessageToast = () => {
    setShowMessageToast(false);
    setLatestMessage(null);
  };

  useEffect(() => {
    if (messageToastQueue.length === 0) return;
    setLatestMessage(messageToastQueue[messageToastQueue.length - 1]);
    setMessageToastQueue([]);
    setShowMessageToast(true);
  }, [messageToastQueue]);

  useLayoutEffect(() => {
    if (!showMessageToast || !latestMessage) {
      setToastPos(null);
      return;
    }
    const update = () => {
      const bell = bellWrapRef.current?.getBoundingClientRect();
      const card = toastCardRef.current;
      if (!bell || !card) return;
      const viewportWidth = document.documentElement.clientWidth;
      const width = card.offsetWidth;
      const right = Math.max(12, Math.min(viewportWidth - bell.right, viewportWidth - width - 12));
      const bellCenter = bell.left + bell.width / 2;
      const arrow = Math.min(Math.max(viewportWidth - right - bellCenter - 6, 16), width - 28);
      const top = bell.bottom + 10;
      setToastPos(previous => previous && previous.top === top && previous.right === right && previous.arrow === arrow ? previous : { top, right, arrow });
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [latestMessage, showMessageToast]);

  useEffect(() => {
    deliveredRecipientIdsRef.current.clear();
    setMessageToastQueue([]);
    setShowMessageToast(false);
    setLatestMessage(null);
  }, [employee.id]);

  const toastIsReward = latestMessage?.notificationCategory === 'performance_reward';
  const toastPriorityLabel = latestMessage?.priority === 'urgent' ? t.header.urgent
    : latestMessage?.priority === 'high' ? t.header.highPriority
    : latestMessage?.priority === 'normal' ? t.header.normal
    : t.messages.priorityLow;
  const toastPriorityStyle = latestMessage?.priority === 'urgent' ? 'bg-rose-300 text-rose-950'
    : latestMessage?.priority === 'high' ? 'bg-yellow-300 text-amber-950'
    : latestMessage?.priority === 'normal' ? (toastIsReward ? 'bg-amber-300 text-amber-950' : 'bg-emerald-300 text-emerald-950')
    : 'bg-sky-300 text-sky-950';

  return (
    <div className={`min-h-screen relative nav-root-padding employee-shell`} style={{ background: '#f8fafc' }}>
      {/* Fixed Background Layer */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute inset-0 bg-gradient-to-br from-slate-50 via-white to-blue-50/60"></div>
        {!isMobile && !isTablet && (
          <>
            <div className="absolute top-0 right-0 w-[50%] h-[50%] bg-gradient-to-bl from-blue-50/50 via-transparent to-transparent"></div>
            <div className="absolute bottom-0 left-0 w-[40%] h-[40%] bg-gradient-to-tr from-slate-100/60 via-transparent to-transparent"></div>
            <div className="absolute top-[20%] right-[15%] w-[500px] h-[500px] bg-blue-50/40 rounded-full blur-[150px]"></div>
            <div className="absolute bottom-[20%] left-[10%] w-[400px] h-[400px] bg-sky-50/30 rounded-full blur-[130px]"></div>

            {/* Decorative color blocks - desktop */}
            <div className="absolute top-[12%] left-[5%] w-24 h-24 bg-gradient-to-br from-blue-100/60 to-cyan-100/40 rounded-2xl rotate-12 opacity-60"></div>
            <div className="absolute top-[8%] right-[8%] w-16 h-16 bg-gradient-to-br from-sky-100/70 to-blue-100/50 rounded-xl -rotate-6 opacity-50"></div>
            <div className="absolute top-[35%] right-[5%] w-20 h-20 bg-gradient-to-br from-cyan-100/50 to-teal-100/30 rounded-2xl rotate-45 opacity-40"></div>
            <div className="absolute bottom-[30%] left-[3%] w-14 h-14 bg-gradient-to-br from-blue-100/60 to-sky-100/40 rounded-lg rotate-12 opacity-50"></div>
            <div className="absolute bottom-[15%] right-[12%] w-28 h-28 bg-gradient-to-br from-sky-50/80 to-cyan-50/60 rounded-3xl -rotate-12 opacity-40"></div>
            <div className="absolute top-[55%] left-[8%] w-10 h-10 bg-gradient-to-br from-teal-100/50 to-cyan-100/30 rounded-lg rotate-45 opacity-60"></div>
            <div className="absolute bottom-[40%] right-[20%] w-12 h-12 bg-gradient-to-br from-blue-100/40 to-sky-100/30 rounded-xl rotate-6 opacity-45"></div>

            {/* Geometric line patterns */}
            <svg className="absolute inset-0 w-full h-full opacity-[0.025]" xmlns="http://www.w3.org/2000/svg">
              <pattern id="bg-dots-desktop" x="0" y="0" width="48" height="48" patternUnits="userSpaceOnUse">
                <circle cx="24" cy="24" r="1.5" fill="#3b82f6" />
              </pattern>
              <rect width="100%" height="100%" fill="url(#bg-dots-desktop)" />
            </svg>

            {/* Decorative border lines */}
            <div className="absolute top-[25%] left-0 right-0 h-px opacity-[0.04]" style={{ background: 'linear-gradient(90deg, transparent, #3b82f6 30%, #06b6d4 70%, transparent)' }}></div>
            <div className="absolute top-[65%] left-0 right-0 h-px opacity-[0.03]" style={{ background: 'linear-gradient(90deg, transparent, #0ea5e9 20%, #3b82f6 80%, transparent)' }}></div>
          </>
        )}
        {(isMobile || isTablet) && (
          <>
            <div className="absolute top-0 right-0 w-[60%] h-[30%] bg-gradient-to-bl from-blue-50/40 via-transparent to-transparent"></div>
            <div className="absolute bottom-[10%] left-0 w-[50%] h-[30%] bg-gradient-to-tr from-slate-50/60 via-transparent to-transparent"></div>

            {/* Decorative color blocks - mobile/tablet */}
            <div className="absolute top-[15%] right-[5%] w-14 h-14 bg-gradient-to-br from-blue-100/50 to-sky-100/30 rounded-xl rotate-12 opacity-50"></div>
            <div className="absolute top-[40%] left-[3%] w-10 h-10 bg-gradient-to-br from-cyan-100/40 to-teal-100/20 rounded-lg -rotate-6 opacity-45"></div>
            <div className="absolute bottom-[25%] right-[8%] w-16 h-16 bg-gradient-to-br from-sky-100/50 to-blue-100/30 rounded-2xl rotate-45 opacity-35"></div>
            <div className="absolute bottom-[45%] left-[6%] w-8 h-8 bg-gradient-to-br from-blue-100/40 to-cyan-100/20 rounded-md rotate-12 opacity-40"></div>

            {/* Subtle dot pattern - mobile */}
            <svg className="absolute inset-0 w-full h-full opacity-[0.02]" xmlns="http://www.w3.org/2000/svg">
              <pattern id="bg-dots-mobile" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse">
                <circle cx="20" cy="20" r="1" fill="#3b82f6" />
              </pattern>
              <rect width="100%" height="100%" fill="url(#bg-dots-mobile)" />
            </svg>
          </>
        )}
        {/* Subtle grid - hidden on mobile for performance */}
        {!isMobile && (
          <div className="absolute inset-0 opacity-[0.02]" style={{
            backgroundImage: `
              linear-gradient(to right, #94a3b8 1px, transparent 1px),
              linear-gradient(to bottom, #94a3b8 1px, transparent 1px)
            `,
            backgroundSize: '60px 60px'
          }} />
        )}
      </div>

      <header
          ref={employeeHeaderRef}
          className={`employee-header transition-transform duration-300 ${showWithdrawalHistory && isMobile ? '-translate-y-full' : ''}`}
          style={{
            paddingTop: 'env(safe-area-inset-top)',
            backgroundImage: isMobile
              ? 'linear-gradient(135deg, #1e40af 0%, #2563eb 50%, #3b82f6 100%)'
              : isTablet
                ? 'linear-gradient(135deg, #1e40af 0%, #2563eb 40%, #3b82f6 80%, #2563eb 100%)'
                : 'linear-gradient(118deg, #0b1f55 0%, #163a9a 32%, #1d4ed8 64%, #2563eb 100%)',
            border: 'none',
            borderRadius: 0,
            outline: 'none',
            boxShadow: 'none',
          }}
        >
          <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{
            background: 'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.04) 100%)'
          }}>
            {/* Geometric decorative blocks in header */}
            <div className="absolute top-2 right-[15%] w-8 h-8 border-2 border-white/[0.08] rounded-lg rotate-12"></div>
            <div className="absolute top-1 right-[30%] w-5 h-5 border-2 border-white/[0.06] rounded-md -rotate-6"></div>
            <div className="absolute bottom-1 left-[20%] w-6 h-6 border-2 border-cyan-200/[0.08] rounded-lg rotate-45"></div>
            <div className="absolute top-3 left-[40%] w-4 h-4 bg-white/[0.04] rounded-full"></div>
            <div className="absolute bottom-2 right-[45%] w-3 h-3 bg-cyan-200/[0.06] rounded-full"></div>
            <div className="absolute top-1/2 left-[60%] w-10 h-10 border border-white/[0.05] rounded-xl rotate-12 -translate-y-1/2"></div>
            {!isMobile && !isTablet && (
              <>
                <div className="absolute -top-16 right-[8%] h-40 w-40 rotate-12 rounded-[28px] bg-gradient-to-br from-cyan-300/20 to-transparent"></div>
                <div className="absolute -bottom-20 right-[24%] h-36 w-36 -rotate-6 rounded-[24px] bg-gradient-to-tr from-indigo-300/15 to-transparent"></div>
                <div className="absolute -top-10 left-[30%] h-24 w-24 rotate-45 rounded-2xl border border-white/10"></div>
                <div className="absolute -left-10 top-4 h-28 w-28 rounded-full bg-cyan-400/10 blur-2xl"></div>
              </>
            )}
          </div>
          <div className={`emp-header-row max-w-7xl mx-auto relative border-0 border-none ${isMobile ? 'px-2 xs:px-3 pt-3 pb-2' : isTablet ? 'px-5 pt-4 pb-3' : 'px-8 pt-3.5 pb-2'}`}>
            <div className="flex justify-between items-center gap-2">
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <div
                  className={`emp-header-logo ${isMobile ? 'h-8 w-8 min-w-8 rounded-lg' : isTablet ? 'h-9 w-9 min-w-9 rounded-xl' : 'h-8 w-8 min-w-8 rounded-[10px]'} relative flex aspect-square flex-shrink-0 items-center justify-center overflow-hidden bg-white shadow-[0_6px_16px_-6px_rgba(2,6,23,0.6)] ring-1 ring-inset ring-slate-900/5`}
                >
                  <span className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-slate-100 to-transparent" aria-hidden="true"></span>
                  <svg viewBox="0 0 24 24" className="relative block h-[58%] w-[58%] flex-shrink-0" fill="none" aria-hidden="true">
                    <defs>
                      <linearGradient id="employee-logo-grad" x1="6" y1="2" x2="17" y2="22" gradientUnits="userSpaceOnUse">
                        <stop offset="0" stopColor="#22d3ee" />
                        <stop offset="0.5" stopColor="#2563eb" />
                        <stop offset="1" stopColor="#4338ca" />
                      </linearGradient>
                    </defs>
                    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" fill="url(#employee-logo-grad)" stroke="url(#employee-logo-grad)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
                  </svg>
                </div>
                {!isMobile && !isTablet ? (
                  <div className="flex min-w-0 flex-1 items-center gap-4">
                    <h1 className="truncate text-[20px] font-bold leading-none tracking-tight text-white" style={{ textShadow: '0 1px 12px rgba(56,189,248,0.25)' }}>
                      {companyName}
                    </h1>
                    <span className="h-6 w-px flex-shrink-0 bg-gradient-to-b from-transparent via-white/35 to-transparent" aria-hidden="true"></span>
                    <div className="flex min-w-0 items-center gap-2">
                      <User className="h-4 w-4 flex-shrink-0 text-blue-200/80" strokeWidth={2} />
                      <span className="truncate text-sm font-medium text-blue-50/90">{employee.username}</span>
                      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-400" aria-label="Online"></span>
                    </div>
                  </div>
                ) : (
                <div className="flex-1 min-w-0" style={{ maxWidth: isMobile ? 'calc(100vw - 140px)' : undefined }}>
                  <h1 className={`${isMobile ? 'text-[15px]' : 'text-lg'} font-bold text-white truncate tracking-tight leading-tight`}>
                    {companyName}
                  </h1>
                  <div className="flex items-center gap-1.5 mt-px">
                    <div className="w-1.5 h-1.5 bg-emerald-300 rounded-full animate-pulse flex-shrink-0"></div>
                    <span className={`${isMobile ? 'text-[11px]' : 'text-xs'} text-blue-100/90 font-medium truncate`}>{employee.username}</span>
                  </div>
                </div>
                )}
              </div>
              <div className={`flex flex-shrink-0 items-center ${isMobile ? 'gap-1.5' : isTablet ? 'gap-2' : 'gap-3'}`}>
                {/* Message Center Button */}
                <div className="relative" ref={bellWrapRef}>
                  <button
                    onClick={() => {
                      dismissMessageToast();
                      setMessageToOpen(null);
                      setShowMessageCenter(true);
                      setHasNewMessage(false);
                    }}
                    className={`employee-header-action relative flex-shrink-0 ${isMobile || isTablet ? 'rounded-full' : 'rounded-lg'} transition-all duration-200 group ${
                      unreadMessageCount > 0
                        ? 'bg-amber-400/20 hover:bg-amber-400/30'
                        : 'bg-white/10 hover:bg-white/20'
                    }`}
                    style={{
                      width: isMobile ? '38px' : isTablet ? '42px' : '32px',
                      height: isMobile ? '38px' : isTablet ? '42px' : '32px',
                      minWidth: isMobile ? '38px' : isTablet ? '42px' : '32px',
                      minHeight: isMobile ? '38px' : isTablet ? '42px' : '32px',
                      padding: '0',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      position: 'relative',
                      border: unreadMessageCount > 0 ? '1px solid rgba(251, 191, 36, 0.4)' : '1px solid rgba(255,255,255,0.2)'
                    }}
                  >
                  {/* Bell icon with breathing pulse when unread */}
                  <div className={`z-10 relative ${unreadMessageCount > 0 ? 'animate-bell-pulse keep-animation' : ''}`}>
                    <Bell
                      className={`w-[18px] h-[18px] flex-shrink-0 keep-animation ${
                        unreadMessageCount > 0 ? 'animate-bell-ring text-amber-300' : 'text-white'
                      }`}
                      strokeWidth={2.2}
                      fill={unreadMessageCount > 0 ? 'currentColor' : 'none'}
                    />
                  </div>

                  {/* Unread count badge */}
                  {unreadMessageCount > 0 && (
                    <div
                      className={`absolute -top-2 -right-2 min-w-[22px] h-[22px] px-1.5 bg-red-500 text-white text-[12px] leading-none font-bold tabular-nums rounded-full shadow-[0_2px_6px_rgba(220,38,38,0.45)] flex items-center justify-center border-2 border-white z-20 keep-animation ${hasNewMessage ? 'animate-badge-bounce' : ''}`}
                      style={{ willChange: hasNewMessage ? 'transform' : 'auto' }}
                    >
                      {unreadMessageCount > 99 ? '99+' : unreadMessageCount}
                    </div>
                  )}
                  </button>

                  {/* New message toast: portaled and measured against the bell so it never hangs off the screen edge */}
                  {showMessageToast && latestMessage && createPortal(
                    <div
                      ref={toastCardRef}
                      className="employee-header-toast fixed animate-slide-in-down"
                      style={{
                        top: toastPos?.top ?? 'calc(var(--employee-header-height, 64px) + 8px)',
                        right: toastPos?.right ?? 12,
                        width: 'min(calc(100vw - 24px), 340px)',
                        WebkitTextSizeAdjust: '100%',
                      }}
                    >
                      {/* Arrow */}
                      <div
                        className={`absolute -top-[6px] h-3 w-3 rotate-45 border border-b-0 border-r-0 ${toastIsReward ? 'border-amber-300/40 bg-amber-500' : 'border-emerald-400/30 bg-emerald-600'}`}
                        style={{ right: toastPos?.arrow ?? 28 }}
                      ></div>

                      <div className={`relative overflow-hidden rounded-[16px] border shadow-2xl ring-1 ${toastIsReward ? 'border-amber-300/30 bg-gradient-to-br from-amber-500 via-yellow-500 to-orange-500 ring-amber-300/50' : 'border-emerald-500/20 bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-600 ring-emerald-400/40'}`}>
                        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
                          <div className={`absolute -right-8 -top-8 h-[88px] w-[88px] rounded-full ${toastIsReward ? 'bg-yellow-300/30' : 'bg-cyan-300/25'}`}></div>
                          <div className={`absolute -bottom-8 -left-8 h-[72px] w-[72px] rounded-full ${toastIsReward ? 'bg-orange-400/30' : 'bg-teal-300/30'}`}></div>
                          <div className={`absolute -right-10 top-[44%] h-[18px] w-[130px] -rotate-[28deg] rounded-full ${toastIsReward ? 'bg-white/15' : 'bg-white/10'}`}></div>
                          <div className="absolute left-[44%] top-[10px] h-[8px] w-[8px] rotate-45 rounded-[2px] bg-white/30"></div>
                        </div>

                        {/* Top accent line */}
                        <div className="relative h-[2px]" style={{ background: 'linear-gradient(90deg, transparent, #6ee7b7, #a7f3d0, #6ee7b7, transparent)' }} />

                        <button
                          onClick={(e) => { e.stopPropagation(); dismissMessageToast(); }}
                          aria-label={t.common.close}
                          className={`absolute right-[8px] top-[10px] z-10 flex h-[26px] w-[26px] items-center justify-center rounded-full !min-h-0 !min-w-0 !p-0 text-white ring-1 ring-white/40 transition-colors after:absolute after:-inset-[9px] after:content-[''] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
                            toastIsReward ? 'bg-amber-900/25 hover:bg-amber-900/40' : 'bg-emerald-950/30 hover:bg-emerald-950/45'
                          }`}
                          style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation' }}
                        >
                          <X className="h-[14px] w-[14px]" strokeWidth={3} aria-hidden="true" />
                        </button>

                        {/* Content */}
                        <div
                          onClick={() => { setMessageToOpen(latestMessage.summaryCount ? null : latestMessage.notification); dismissMessageToast(); setShowMessageCenter(true); setHasNewMessage(false); }}
                          className="relative cursor-pointer touch-manipulation"
                          style={{ WebkitTapHighlightColor: 'transparent' }}
                        >
                          <div className="flex items-start gap-[12px] px-[14px] pb-[12px] pt-[12px] sm:gap-[14px] sm:px-[16px] sm:pb-[14px] sm:pt-[14px]">
                            <div className="relative mt-[2px] flex-shrink-0">
                              <div className="flex h-[38px] w-[38px] items-center justify-center rounded-xl border border-white/25 bg-white/15 shadow-inner ring-1 ring-white/10 sm:h-[42px] sm:w-[42px]">
                                {toastIsReward ? <Gift className="h-[19px] w-[19px] text-white" strokeWidth={2.2} /> : <Bell className="h-[19px] w-[19px] text-white" strokeWidth={2.2} />}
                              </div>
                              <div className="absolute -right-1.5 -top-1.5 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-white px-[3px] shadow-md">
                                <span className={`text-[10px] font-black leading-none ${toastIsReward ? 'text-amber-600' : 'text-emerald-600'}`}>{latestMessage.summaryCount ? (latestMessage.summaryCount > 99 ? '99+' : latestMessage.summaryCount) : 1}</span>
                              </div>
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="mb-[5px] flex items-center gap-[8px] pr-[24px]">
                                <span className={`h-[18px] w-[4px] flex-shrink-0 rounded-full bg-gradient-to-b ${toastIsReward ? 'from-white to-amber-100/50' : 'from-white to-emerald-100/50'}`} aria-hidden="true"></span>
                                <span className="truncate text-[15px] font-extrabold leading-[20px] tracking-[0.01em] text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.28)] sm:text-[16px] sm:leading-[22px]">
                                  {toastIsReward ? 'Performance Reward' : t.header.newMessage}
                                </span>
                              </div>
                              <h3 className="mb-[3px] line-clamp-2 break-words text-[13px] font-semibold leading-[1.35] text-white/95 sm:text-[14px]">
                                {latestMessage.summaryCount
                                  ? t.header.newMessagesSummary.replace('{n}', String(latestMessage.summaryCount))
                                  : latestMessage.title}
                              </h3>
                              <p className="line-clamp-1 text-[11px] leading-[16px] text-white/90 sm:line-clamp-2 sm:text-[12px] sm:leading-[17px]">
                                {latestMessage.summaryCount
                                  ? t.header.newMessagesSummaryHint
                                  : latestMessage.content.replace(/<[^>]*>/g, '').slice(0, 80)}
                              </p>
                            </div>
                          </div>

                          {/* Footer */}
                          <div className={`flex items-center justify-between gap-[8px] px-[14px] py-[8px] sm:px-[16px] sm:py-[10px] ${toastIsReward ? 'bg-amber-900/25' : 'bg-emerald-950/30'}`}>
                            <div className="flex min-w-0 items-center gap-[8px]">
                              <span className={`inline-flex h-[24px] flex-shrink-0 items-center gap-[5px] rounded-full px-[9px] text-[11px] font-bold leading-none shadow-md ring-1 ring-white/50 ${toastPriorityStyle}`}>
                                {latestMessage.priority === 'urgent' ? <AlertCircle className="h-[14px] w-[14px] min-h-[14px] min-w-[14px] flex-shrink-0" width={14} height={14} strokeWidth={2.75} aria-hidden="true" />
                                  : latestMessage.priority === 'high' ? <Zap className="h-[14px] w-[14px] min-h-[14px] min-w-[14px] flex-shrink-0" width={14} height={14} strokeWidth={2.75} aria-hidden="true" />
                                  : latestMessage.priority === 'normal' ? <Shield className="h-[14px] w-[14px] min-h-[14px] min-w-[14px] flex-shrink-0" width={14} height={14} strokeWidth={2.75} aria-hidden="true" />
                                  : <Radio className="h-[14px] w-[14px] min-h-[14px] min-w-[14px] flex-shrink-0" width={14} height={14} strokeWidth={2.75} aria-hidden="true" />}
                                <span className="whitespace-nowrap">{toastPriorityLabel}</span>
                              </span>
                              {toastIsReward && (
                                <span className="min-w-0 truncate">
                                  <span className="mr-[8px] hidden text-[11px] font-bold uppercase tracking-wider text-white/85 sm:inline">{t.messages.rewardWalletLabel}</span>
                                  <span className="whitespace-nowrap text-[12px] font-black text-white sm:text-[13px]">+{Number(latestMessage.rewardAmount || 0).toFixed(2)} {latestMessage.rewardCurrency}</span>
                                </span>
                              )}
                            </div>
                            <div className={`flex h-[28px] flex-shrink-0 items-center justify-center gap-[6px] whitespace-nowrap rounded-[9px] bg-white px-[12px] shadow-md transition-all hover:scale-105 active:scale-95 sm:h-[32px] sm:rounded-[10px] sm:px-[14px] ${toastIsReward ? 'text-amber-700' : 'text-emerald-700'}`}>
                              <span className="text-[11px] font-bold sm:text-[12px]">{t.header.view}</span>
                              <svg className="h-[11px] w-[11px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>,
                    document.body
                  )}
                </div>

                {/* Desktop: Language Switcher, Change Password & Logout Buttons */}
                {!isMobile && !isTablet && (
                <div className="flex items-center gap-0.5 rounded-xl bg-white/[0.07] p-0.5 ring-1 ring-inset ring-white/15">
                  <LanguageSwitcher variant="toolbar" />

                  <span className="h-4 w-px bg-white/15" aria-hidden="true"></span>

                  <button
                    onClick={() => setShowPasswordChange(true)}
                    className="group flex h-7 items-center gap-1.5 rounded-lg px-3 text-blue-50/90 transition-all duration-200 hover:bg-indigo-50 hover:text-indigo-700 hover:shadow-md hover:shadow-blue-950/20 active:bg-indigo-100"
                  >
                    <Lock className="h-3.5 w-3.5" strokeWidth={2} />
                    <span className="grid text-xs"><span className="col-start-1 row-start-1 text-center font-medium group-hover:font-bold">{t.header.password}</span><span className="invisible col-start-1 row-start-1 font-bold" aria-hidden="true">{t.header.password}</span></span>
                  </button>

                  <span className="h-4 w-px bg-white/15" aria-hidden="true"></span>

                  <button
                    onClick={() => logout()}
                    className="group flex h-7 items-center gap-1.5 rounded-lg px-3 text-blue-50/90 transition-all duration-200 hover:bg-rose-50 hover:text-rose-600 hover:shadow-md hover:shadow-blue-950/20 active:bg-rose-100"
                  >
                    <LogOut className="h-3.5 w-3.5" strokeWidth={2} />
                    <span className="grid text-xs"><span className="col-start-1 row-start-1 text-center font-medium group-hover:font-bold">{t.header.logout}</span><span className="invisible col-start-1 row-start-1 font-bold" aria-hidden="true">{t.header.logout}</span></span>
                  </button>
                </div>
                )}

                {/* Mobile & Tablet: User Menu Dropdown */}
                {(isMobile || isTablet) && (
                <div className="relative" ref={userMenuRef}>
                  <button
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    aria-haspopup="menu"
                    aria-expanded={showUserMenu}
                    className={`employee-header-action emp-user-pill relative flex-shrink-0 rounded-full ${showUserMenu ? 'bg-white/25' : 'bg-white/10'} hover:bg-white/20 active:bg-white/30 transition-colors group`}
                    style={{
                      width: isMobile ? '58px' : '66px',
                      height: isMobile ? '38px' : '42px',
                      minWidth: isMobile ? '58px' : '66px',
                      minHeight: isMobile ? '38px' : '42px',
                      padding: isMobile ? '0 6px 0 4px' : '0 8px 0 4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      position: 'relative',
                      border: '1px solid rgba(255,255,255,0.2)'
                    }}
                  >
                    <div className="relative z-10 flex w-full items-center justify-between">
                      <span className={`emp-user-avatar flex items-center justify-center rounded-full bg-white text-blue-700 shadow-sm ${isMobile ? 'h-[30px] w-[30px]' : 'h-[34px] w-[34px]'}`}>
                        <User className={isMobile ? 'h-4 w-4' : 'h-[18px] w-[18px]'} strokeWidth={2.4} />
                      </span>
                      <ChevronDown className={`${isMobile ? 'h-3.5 w-3.5' : 'h-4 w-4'} text-white transition-transform duration-200 ${showUserMenu ? 'rotate-180' : ''}`} strokeWidth={2.6} />
                    </div>
                  </button>

                  {/* Dropdown Menu */}
                  {showUserMenu && (
                    <div className="absolute top-full right-0 mt-3 w-64 z-50 animate-[menuAppear_0.15s_ease-out]">
                      <div className="relative overflow-hidden rounded-2xl bg-white shadow-2xl shadow-slate-900/20">
                        {/* User Info Header */}
                        <div className="relative px-5 py-4 bg-gradient-to-br from-blue-600 via-blue-700 to-blue-800 overflow-hidden">
                          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(255,255,255,0.1)_0%,_transparent_60%)]" />
                          <div className="relative flex items-center gap-3">
                            <div className="w-10 h-10 bg-white/15 rounded-xl flex items-center justify-center backdrop-blur-sm border border-white/20">
                              <User className="w-5 h-5 text-white" />
                            </div>
                            <div>
                              <span className="text-sm font-bold text-white block">{employee.username}</span>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <div className="w-1.5 h-1.5 bg-green-400 rounded-full shadow-sm shadow-green-400/50" />
                                <span className="text-xs text-blue-100">{t.header.online}</span>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* Menu Items */}
                        <div className="relative p-2">
                          <LanguageSwitcher variant="mobile" onOpenModal={() => {
                            setShowUserMenu(false);
                            setShowLanguageModal(true);
                          }} />

                          <button
                            onClick={() => {
                              setShowUserMenu(false);
                              setShowPasswordChange(true);
                            }}
                            className="w-full px-4 py-3 flex items-center gap-3 rounded-xl hover:bg-blue-50 transition-all duration-200 group"
                          >
                            <div className="w-8 h-8 bg-blue-50 group-hover:bg-blue-100 rounded-lg flex items-center justify-center transition-colors">
                              <Lock className="w-4 h-4 text-blue-600" />
                            </div>
                            <span className="text-sm font-medium text-slate-700 group-hover:text-slate-900 transition-colors">{t.header.changePassword}</span>
                          </button>

                          <button
                            onClick={() => {
                              setShowUserMenu(false);
                              logout();
                            }}
                            className="w-full px-4 py-3 flex items-center gap-3 rounded-xl hover:bg-red-50 transition-all duration-200 group"
                          >
                            <div className="w-8 h-8 bg-slate-50 group-hover:bg-red-100 rounded-lg flex items-center justify-center transition-colors">
                              <LogOut className="w-4 h-4 text-slate-400 group-hover:text-red-500 transition-colors" />
                            </div>
                            <span className="text-sm font-medium text-slate-700 group-hover:text-red-600 transition-colors">{t.header.logout}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                )}
              </div>
            </div>
            {/* Desktop navigation, integrated into the sticky header */}
            <nav className="nav-desktop relative mt-1.5" aria-label="Primary">
              <div className="relative flex gap-1 rounded-xl bg-white/[0.08] p-1 ring-1 ring-inset ring-white/15 backdrop-blur-sm">
                {tabs.map((tab) => {
                  const Icon = tab.icon;
                  const isActive = activeTab === tab.id;
                  const isDispatchTab = tab.id === 'dispatch';
                  const showNewOrderEffect = isDispatchTab && hasNewOrder;
                  const showTimeoutEffect = isDispatchTab && hasOrderTimeout;
                  const alerting = showNewOrderEffect || showTimeoutEffect;

                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      aria-current={isActive ? 'page' : undefined}
                      className={`group relative flex min-w-max flex-1 items-center justify-center gap-2 overflow-hidden rounded-lg px-3 py-2 font-semibold transition-all duration-200 xl:px-4 ${
                        alerting
                          ? 'text-white'
                          : isActive
                            ? 'text-blue-700'
                            : 'text-blue-100/90 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      {showNewOrderEffect && (
                        <>
                          <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-amber-500 to-orange-500 animate-pulse"></div>
                          <div className="absolute inset-0">
                            {[...Array(8)].map((_, i) => (
                              <div
                                key={i}
                                className="absolute h-2 w-2 rounded-full bg-white"
                                style={{
                                  left: `${(i * 12.5)}%`,
                                  animation: `bubble-float ${2 + i * 0.2}s ease-in-out ${i * 0.3}s infinite`
                                }}
                              />
                            ))}
                          </div>
                        </>
                      )}

                      {showTimeoutEffect && !showNewOrderEffect && (
                        <>
                          <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-rose-600 to-red-600 animate-pulse-urgent"></div>
                          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer-urgent"></div>
                        </>
                      )}

                      {isActive && !alerting && (
                        <div className="absolute inset-0 rounded-lg bg-white shadow-[0_6px_18px_-8px_rgba(15,23,42,0.55)]">
                          <div className="absolute inset-x-6 bottom-0 h-[3px] rounded-full" style={{ background: 'linear-gradient(90deg, rgba(59,130,246,0) 0%, #3b82f6 18%, #22d3ee 50%, #3b82f6 82%, rgba(59,130,246,0) 100%)' }}></div>
                        </div>
                      )}

                      <Icon className={`relative z-10 h-[17px] w-[17px] flex-shrink-0 ${isActive && !alerting ? 'text-blue-600' : ''}`} />
                      {/* Hidden bold copy reserves the hover width, so tabs sized to a long label don't shift on hover */}
                      <span className="relative z-10 grid justify-items-center whitespace-nowrap text-sm">
                        <span className="invisible col-start-1 row-start-1 font-bold" aria-hidden="true">{tab.label}</span>
                        <span className="col-start-1 row-start-1 group-hover:font-bold">{tab.label}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </nav>
          </div>
          <div className="nav-desktop pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-cyan-300/60 to-transparent" aria-hidden="true"></div>
      </header>

      <div className="nav-content-pt relative">
        <div className={`max-w-7xl mx-auto ${isMobile ? 'px-3 pt-[calc(0.75rem-1px)] pb-2' : isTablet ? 'px-5 pt-[calc(0.75rem-1px)] pb-4' : 'px-8 py-6 pb-6'}`}>
          <Suspense fallback={<PageLoader />}>
          <div>
            <div className="emp-tab-pane sm:max-lg:pb-[100px]" style={{ display: activeTab === 'announcements' ? 'block' : 'none' }}>
              {isTabMounted('announcements') && <Suspense fallback={<PageLoader />}>{announcementsPage}</Suspense>}
            </div>
            <div style={{ display: activeTab === 'dispatch' ? 'block' : 'none' }} className="emp-tab-pane pb-[84px] max-[359px]:pb-[78px] min-[480px]:pb-[76px] lg:pb-[100px] min-[1025px]:pb-[92px]">
              {isTabMounted('dispatch') && <Suspense fallback={<PageLoader />}>{dispatchPage}</Suspense>}
            </div>
            <div className="emp-tab-pane space-y-4 sm:space-y-6 pb-[84px] max-[359px]:pb-[78px] min-[480px]:pb-[76px] lg:pb-[100px] min-[1025px]:pb-[92px]" style={{ display: activeTab === 'orders' ? 'block' : 'none' }}>
              {isTabMounted('orders') && <Suspense fallback={<PageLoader />}>{orderSubmissionPage}{orderListPage}</Suspense>}
            </div>
            <div className="emp-tab-pane pb-[100px] lg:pb-[108px]" style={{ display: activeTab === 'wallet' ? 'block' : 'none' }}>
              {isTabMounted('wallet') && <Suspense fallback={<PageLoader />}>{walletPage}</Suspense>}
            </div>
            <div className="emp-tab-pane pb-[84px] max-[359px]:pb-[78px] min-[480px]:pb-[76px] lg:pb-[100px] min-[1025px]:pb-[92px]" style={{ display: activeTab === 'statistics' ? 'block' : 'none' }}>
              {isTabMounted('statistics') && <Suspense fallback={<PageLoader />}>{statisticsPage}</Suspense>}
            </div>
          </div>
          </Suspense>
        </div>

        </div>

      {/* Bottom Navigation - portaled to document.body */}
      {createPortal(
      <nav ref={employeeNavRef} className="nav-mobile safe-area-pb employee-nav" style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9998 }}>
        <div className="absolute inset-0 bg-white border-t border-slate-200/60"
          style={{ boxShadow: '0 -1px 12px rgba(0,0,0,0.04)' }}
        ></div>

        {/* Navigation Items */}
        <div className="emp-bottom-nav-row relative flex px-2 sm:px-4 pt-2 sm:pt-2.5 pb-1.5 sm:pb-2">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            const isDispatchTab = tab.id === 'dispatch';
            const showNewOrderEffect = isDispatchTab && hasNewOrder;
            const showTimeoutEffect = isDispatchTab && hasOrderTimeout;

            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className="relative flex-1 flex flex-col items-center justify-start py-1 transition-all duration-200 active:scale-95"
                // Cancels the global 16px touch-target side padding, which squeezed labels onto two lines
                style={{ WebkitTapHighlightColor: 'transparent', touchAction: 'manipulation', minWidth: '44px', paddingLeft: 0, paddingRight: 0 }}
              >
                {/* Active pill background */}
                {isActive && !showNewOrderEffect && !showTimeoutEffect && (
                  <div className="absolute inset-x-2 inset-y-0.5 bg-blue-50/80 rounded-xl transition-all duration-300"></div>
                )}

                {/* Special Effect Backgrounds */}
                {showNewOrderEffect && (
                  <div className="absolute inset-x-2 inset-y-0.5 bg-gradient-to-b from-amber-50 to-amber-100/80 rounded-xl border border-amber-200/40 animate-pulse"></div>
                )}
                {showTimeoutEffect && !showNewOrderEffect && (
                  <div className="absolute inset-x-2 inset-y-0.5 bg-gradient-to-b from-red-50 to-red-100/80 rounded-xl border border-red-200/40 animate-pulse"></div>
                )}

                {/* Icon */}
                <div className="relative z-10 mb-0.5">
                  <Icon className={`w-5 h-5 transition-all duration-200 ${
                    isActive
                      ? 'text-blue-600'
                      : showNewOrderEffect
                        ? 'text-amber-600'
                        : showTimeoutEffect
                          ? 'text-red-600'
                          : 'text-slate-400'
                  }`} strokeWidth={isActive ? 2.3 : 1.7} fill={isActive ? 'currentColor' : 'none'} style={{ opacity: isActive ? 1 : 0.85 }} />

                  {isDispatchTab && (hasNewOrder || hasOrderTimeout) && (
                    <div className={`absolute -top-0.5 -right-1 w-2 h-2 rounded-full animate-pulse ring-2 ring-white ${
                      hasOrderTimeout ? 'bg-red-500' : 'bg-amber-500'
                    }`} />
                  )}
                </div>

                {/* Label */}
                <span className={`relative z-10 text-[11px] text-center leading-tight tracking-tight text-balance ${
                  isActive
                    ? 'text-blue-600 font-bold'
                    : showNewOrderEffect
                      ? 'text-amber-600 font-medium'
                      : showTimeoutEffect
                        ? 'text-red-600 font-medium'
                        : 'text-slate-400 font-medium'
                }`}>
                  <span className="min-[768px]:hidden">{tab.mobileLabel}</span>
                  <span className="hidden min-[768px]:inline">{tab.label}</span>
                </span>
              </button>
            );
          })}
        </div>
      </nav>,
      document.body
      )}

      {/* Password Change Modal */}
      {showPasswordChange && (
        <PasswordChange
          employeeId={employee.id}
          onClose={() => setShowPasswordChange(false)}
          onLogout={logout}
        />
      )}

      {/* Language Selection Modal */}
      {showLanguageModal && (
        <LanguageModal
          currentLanguage={language}
          onConfirm={(code: Language) => {
            setLanguage(code);
            setShowLanguageModal(false);
          }}
          onClose={() => setShowLanguageModal(false)}
          t={t}
        />
      )}

      <style>{`
        /* CRITICAL: Navigation visibility - raw CSS, no Tailwind dependency */
        .nav-desktop { display: none; }
        .nav-mobile { display: block; }
        .nav-root-padding { padding-bottom: var(--employee-bottom-nav-height, calc(72px + env(safe-area-inset-bottom, 0px))); }
        .nav-content-pt { padding-top: 0; }

        .employee-header {
          position: sticky !important;
          top: var(--employee-scroll-lock-offset, 0px) !important;
          width: 100% !important;
          border: none !important;
          border-radius: 0 !important;
          outline: none !important;
          box-shadow: none !important;
          background-clip: border-box;
          isolation: isolate;
          z-index: 10020 !important;
        }
        body:has(.employee-modal-backdrop, .employee-modal-surface) .employee-header {
          z-index: 9000 !important;
        }
        body:has(.employee-modal-backdrop, .employee-modal-surface) .customer-service-fab {
          visibility: hidden;
        }
        .employee-header-toast { z-index: 10021; }
        body:has(.employee-modal-backdrop, .employee-modal-surface) .employee-header-toast { z-index: 9000; }
        .employee-nav {
          position: fixed !important;
          bottom: 0 !important;
          left: 0 !important;
          right: 0 !important;
          z-index: 9998 !important;
        }

        /* Tablet/mobile: use dvh-based layout to prevent address bar jitter */
        @supports (height: 100dvh) {
          .employee-shell {
            min-height: 100dvh;
          }
        }

        /* Ensure fixed nav stays in its own compositing layer on iOS */
        .employee-nav {
          -webkit-transform: translate3d(0,0,0);
          transform: translate3d(0,0,0);
        }

        @media (min-width: 600px) {
          .nav-content-pt { padding-top: 0; }
        }

        @media (min-width: 1025px) {
          .nav-desktop { display: block !important; }
          .nav-mobile { display: none !important; }
          .nav-root-padding { padding-bottom: 0; }
          .nav-content-pt { padding-top: 8px; }
        }

        @keyframes shimmer-slide {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(200%);
          }
        }

        .animate-shimmer-slide {
          animation: shimmer-slide 3s ease-in-out infinite;
        }

        @keyframes float-horizontal {
          0% {
            transform: translateX(-20px);
            opacity: 0;
          }
          10% {
            opacity: 1;
          }
          90% {
            opacity: 1;
          }
          100% {
            transform: translateX(calc(100vw + 20px));
            opacity: 0;
          }
        }

        @keyframes pulse-glow {
          0%, 100% {
            opacity: 0.3;
          }
          50% {
            opacity: 0.8;
          }
        }

        .animate-pulse-glow {
          animation: pulse-glow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }

        @keyframes border-flow {
          0%, 100% {
            opacity: 0.5;
          }
          50% {
            opacity: 1;
          }
        }

        .animate-border-flow {
          animation: border-flow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }

        @keyframes float {
          0%, 100% {
            transform: translateY(0px);
          }
          50% {
            transform: translateY(-3px);
          }
        }

        .animate-float {
          animation: float 3s ease-in-out infinite;
        }

        .animate-pulse-slow {
          animation: pulse-slow 3s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }

        @keyframes pulse-slow {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.7;
          }
        }

        .delay-150 {
          animation-delay: 150ms;
        }

        .no-scrollbar {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }

        .no-scrollbar::-webkit-scrollbar {
          display: none;
        }

        .scrollbar-hide {
          -ms-overflow-style: none;
          scrollbar-width: none;
        }

        .scrollbar-hide::-webkit-scrollbar {
          display: none;
        }

        @keyframes slideInDown {
          from {
            transform: translateY(-10px);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }


        .animate-slide-in-down {
          animation: slideInDown 0.4s ease-out;
        }


      `}</style>

      {/* Message Center */}
      {showMessageCenter && (
        <MessageCenter
          employee={employee}
          initialMessage={messageToOpen}
          onClose={() => {
            setShowMessageCenter(false);
            setMessageToOpen(null);
            void loadUnreadCountRef.current?.();
          }}
          onSessionExpired={() => {
            financialSessionInvalidRef.current = true;
            setShowMessageCenter(false);
            setMessageToOpen(null);
            setShowSessionExpired(true);
          }}
        />
      )}

      {/* Login Popup Messages */}
      {showLoginPopup && (
        <LoginPopupMessages
          employee={employee}
          onClose={() => {
            loginPopupGenerationRef.current += 1;
            setShowLoginPopup(false);
            void loadUnreadCountRef.current?.();
          }}
          onSessionExpired={() => {
            loginPopupGenerationRef.current += 1;
            financialSessionInvalidRef.current = true;
            setShowLoginPopup(false);
            setShowSessionExpired(true);
          }}
        />
      )}

      {/* Customer Service Chat Widget */}
      <Suspense fallback={null}>
        <CustomerServiceChat employeeId={employee.id} />
      </Suspense>

      {/* Session Expired Modal */}
      <SessionExpiredModal
        isOpen={showSessionExpired}
        onClose={handleSessionExpiredClose}
      />

      {bootPhase !== 'done' && <EmployeeBootScreen exiting={bootPhase === 'exit'} />}

      <PhoneLandscapeGuard
        notice={
          hasNewOrder
            ? { message: t.orientation.newOrder, tone: 'order' }
            : hasOrderTimeout
              ? { message: t.orientation.orderAttention, tone: 'urgent' }
              : null
        }
      />
    </div>
  );
}
