import { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Bell, Eye, AlertCircle, CheckCircle, Clock, Zap, Shield, Radio, ChevronRight, Sparkles, Gift, Wallet } from 'lucide-react';
import { formatSupabaseError, isSupabaseTransientError, supabase } from '../../lib/supabase';
import { getEmployeeFinancialSession } from '../../lib/auth';
import { Employee, MessageWithRecipient } from '../../types';
import { useResponsive } from '../../lib/useResponsive';
import { useLanguage } from '../../lib/i18n/context';
import QuickCopyRichContent from './QuickCopyRichContent';
import PageLoader from './PageLoader';
import PanelColorBlocks from './PanelColorBlocks';
import { NOTIFICATION_DETAIL_THEMES, getNotificationDetailTone } from './notificationDetailTheme';

interface MessageCenterProps {
  employee: Employee;
  initialMessage?: MessageWithRecipient | null;
  onClose: () => void;
  onSessionExpired: () => void;
}

const getDeliveredMessageType = (message: MessageWithRecipient): 'realtime' | 'login_popup' =>
  message.delivery_channel
    || (message.messages.delivery_mode === 'realtime_only' ? 'realtime' : 'login_popup');

const MESSAGE_PANEL_ANIMATION_MS = 520;
const MESSAGE_PANEL_ANIMATED_QUERY = '(min-width: 1024px) and (prefers-reduced-motion: no-preference)';

const canScrollInside = (element: Element | null) => {
  let current = element;
  while (current && current !== document.body && current !== document.documentElement) {
    const { overflowY } = getComputedStyle(current);
    if ((overflowY === 'auto' || overflowY === 'scroll') && current.scrollHeight > current.clientHeight) return true;
    current = current.parentElement;
  }
  return false;
};

export default function MessageCenter({ employee, initialMessage, onClose, onSessionExpired }: MessageCenterProps) {
  const { t, dateLocale } = useLanguage();
  const [messages, setMessages] = useState<MessageWithRecipient[]>([]);
  const [unreadMessages, setUnreadMessages] = useState<MessageWithRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'unread' | 'login' | 'realtime'>('all');
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const [selectedMessage, setSelectedMessage] = useState<MessageWithRecipient | null>(initialMessage || null);
  const [failedReadIds, setFailedReadIds] = useState<Set<string>>(new Set());
  const [markingReadId, setMarkingReadId] = useState<string | null>(null);
  const pendingReadIdsRef = useRef(new Set<string>());
  const confirmedReadAtRef = useRef(new Map<string, string>());
  const { isDesktop } = useResponsive();
  const loadMessagesRef = useRef<(() => Promise<void>) | null>(null);
  const loadRequestIdRef = useRef(0);
  const [isClosing, setIsClosing] = useState(false);
  const [panelReady, setPanelReady] = useState(() => !window.matchMedia(MESSAGE_PANEL_ANIMATED_QUERY).matches);
  const closeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (panelReady) return;
    const timer = window.setTimeout(() => setPanelReady(true), MESSAGE_PANEL_ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, [panelReady]);

  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  const requestClose = () => {
    if (isClosing) return;
    if (!window.matchMedia(MESSAGE_PANEL_ANIMATED_QUERY).matches) {
      onClose();
      return;
    }
    setIsClosing(true);
    closeTimerRef.current = window.setTimeout(onClose, MESSAGE_PANEL_ANIMATION_MS);
  };

  useEffect(() => {
    void loadMessagesRef.current?.();
  }, [employee.id, filter]);

  useLayoutEffect(() => {
    const scrollY = window.scrollY;
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById('root');
    const previousHtmlOverflowY = html.style.getPropertyValue('overflow-y');
    const previousHtmlOverflowYPriority = html.style.getPropertyPriority('overflow-y');
    const rootWasInert = root?.inert ?? false;
    const previousStyles = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      overflow: body.style.overflow,
    };

    if (root) root.inert = true;

    if (isDesktop) {
      // Hiding the page scrollbar would resize the page when the panel opens and again when it closes, so block wheel scrolling instead.
      const blockWheel = (event: WheelEvent) => {
        if (!canScrollInside(event.target as Element | null)) event.preventDefault();
      };
      window.addEventListener('wheel', blockWheel, { passive: false });
      return () => {
        window.removeEventListener('wheel', blockWheel);
        if (root) root.inert = rootWasInert;
      };
    }

    html.style.setProperty('overflow-y', 'hidden', 'important');
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.overflow = 'hidden';

    return () => {
      Object.assign(body.style, previousStyles);
      if (previousHtmlOverflowY) html.style.setProperty('overflow-y', previousHtmlOverflowY, previousHtmlOverflowYPriority);
      else html.style.removeProperty('overflow-y');
      if (root) root.inert = rootWasInert;
      window.scrollTo(0, scrollY);
    };
  }, [isDesktop]);

  const loadMessages = async () => {
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    try {
      const session = getEmployeeFinancialSession();
      const listRequest = supabase.rpc('get_employee_notification_messages', {
        p_user_id: employee.id,
        p_session_token: session.token,
        p_tab_id: session.tabId,
        p_filter: filter,
        p_limit: 300,
      });
      const unreadRequest = filter === 'unread' ? null : supabase.rpc('get_employee_notification_messages', {
        p_user_id: employee.id,
        p_session_token: session.token,
        p_tab_id: session.tabId,
        p_filter: 'unread',
        p_limit: 300,
      });
      const [listResult, unreadResult] = await Promise.all([listRequest, unreadRequest]);
      if (listResult.error) throw listResult.error;
      if (unreadResult?.error) throw unreadResult.error;
      if (requestId !== loadRequestIdRef.current) return;

      const withConfirmedReads = (rows: MessageWithRecipient[]) => rows.map(message => {
        const readAt = confirmedReadAtRef.current.get(message.id);
        return readAt ? { ...message, is_read: true, read_at: readAt } : message;
      });
      const visibleMessages = withConfirmedReads((listResult.data || []) as MessageWithRecipient[]);
      const unread = withConfirmedReads(((unreadResult || listResult).data || []) as MessageWithRecipient[]).filter(message => !message.is_read);
      setUnreadMessages(unread);
      setFailedReadIds(previous => new Set([...previous].filter(id => !visibleMessages.some(message => message.id === id && message.is_read))));
      setMessages(filter === 'all'
        ? [...new Map([...visibleMessages, ...unread].map(message => [message.id, message])).values()]
        : filter === 'unread' ? visibleMessages.filter(message => !message.is_read) : visibleMessages);
    } catch (error) {
      if (requestId === loadRequestIdRef.current) {
        console.error('Error loading messages:', error);
        if ((formatSupabaseError(error).toLowerCase().includes('employee session is invalid or expired') || formatSupabaseError(error).toLowerCase().includes('employee session has expired'))) onSessionExpired();
      }
    } finally {
      if (requestId === loadRequestIdRef.current) setLoading(false);
    }
  };
  loadMessagesRef.current = loadMessages;

  const markAsRead = async (recipientId: string) => {
    if (pendingReadIdsRef.current.has(recipientId)) return;
    pendingReadIdsRef.current.add(recipientId);
    setMarkingReadId(recipientId);
    try {
      const session = getEmployeeFinancialSession();
      let readAt: string | null = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data, error } = await supabase.rpc('mark_employee_notification_read', {
          p_user_id: employee.id,
          p_session_token: session.token,
          p_tab_id: session.tabId,
          p_recipient_id: recipientId,
        });
        if (!error) {
          readAt = (data as { read_at?: string } | null)?.read_at || null;
          break;
        }
        if (!navigator.onLine || !isSupabaseTransientError(error) || attempt === 2) throw error;
        await new Promise(resolve => window.setTimeout(resolve, (attempt + 1) * 500));
      }
      if (!readAt) throw new Error('Notification read confirmation was not returned.');
      confirmedReadAtRef.current.set(recipientId, readAt);
      setMessages(prev => filterRef.current === 'unread'
        ? prev.filter(msg => msg.id !== recipientId)
        : prev.map(msg => msg.id === recipientId ? { ...msg, is_read: true, read_at: readAt } : msg)
      );
      setUnreadMessages(prev => prev.filter(msg => msg.id !== recipientId));
      setSelectedMessage(previous => previous?.id === recipientId ? { ...previous, is_read: true, read_at: readAt } : previous);
      setFailedReadIds(previous => {
        const next = new Set(previous);
        next.delete(recipientId);
        return next;
      });
    } catch (error) {
      console.error('Error marking message as read:', error);
      setFailedReadIds(previous => new Set(previous).add(recipientId));
      if ((formatSupabaseError(error).toLowerCase().includes('employee session is invalid or expired') || formatSupabaseError(error).toLowerCase().includes('employee session has expired'))) onSessionExpired();
    } finally {
      pendingReadIdsRef.current.delete(recipientId);
      setMarkingReadId(current => current === recipientId ? null : current);
    }
  };

  const markAsReadRef = useRef(markAsRead);
  markAsReadRef.current = markAsRead;
  useEffect(() => {
    if (selectedMessage && !selectedMessage.is_read) void markAsReadRef.current(selectedMessage.id);
  }, [selectedMessage]);

  const openMessage = (msg: MessageWithRecipient) => {
    setSelectedMessage(msg);
  };

  const getPriorityIcon = (priority: string, className: string) => {
    switch (priority) {
      case 'urgent': return <AlertCircle className={className} />;
      case 'high': return <Zap className={className} />;
      case 'normal': return <Shield className={className} />;
      default: return <Radio className={className} />;
    }
  };

  const getUnreadLine = (priority: string, isReward: boolean) => {
    const [from, to] = isReward ? ['#f59e0b', '#facc15']
      : priority === 'urgent' ? ['#f43f5e', '#fb7185']
      : priority === 'high' ? ['#10b981', '#34d399']
      : ['#2563eb', '#60a5fa'];
    return `linear-gradient(135deg, ${from} 0%, ${to} 45%, ${to}00 85%)`;
  };

  const getCardStyle = (priority: string, isUnread: boolean, isReward: boolean) => {
    if (isReward) {
      return isUnread
        ? {
            card: 'bg-gradient-to-r from-amber-200 via-amber-100 to-orange-50 shadow-xl shadow-amber-200/60',
            iconBg: 'bg-gradient-to-br from-amber-400 via-yellow-400 to-orange-400',
            iconText: 'text-amber-950',
            accent: 'from-amber-500 via-yellow-400 to-orange-400',
            patternColor: 'border-amber-400',
            dotColor: 'bg-amber-500',
            titleColor: 'text-amber-950',
          }
        : {
            card: 'bg-gradient-to-br from-amber-50/70 via-yellow-50/55 to-orange-50/45 ring-1 ring-amber-200/70 shadow-sm shadow-amber-200/30',
            iconBg: 'bg-amber-50',
            iconText: 'text-amber-500',
            accent: 'from-amber-300/70 via-yellow-200/70 to-orange-200/70',
            patternColor: 'border-amber-100',
            dotColor: 'bg-amber-300',
            titleColor: 'text-amber-800',
          };
    }
    if (isUnread) {
      if (priority === 'urgent') {
        return {
          card: 'bg-gradient-to-r from-rose-200 via-rose-100 to-orange-50 shadow-xl shadow-rose-300/70',
          iconBg: 'bg-gradient-to-br from-rose-500 to-orange-500',
          iconText: 'text-white',
          accent: 'from-rose-500 via-red-400 to-orange-400',
          patternColor: 'border-rose-300',
          dotColor: 'bg-rose-500',
          titleColor: 'text-rose-900',
        };
      }
      if (priority === 'high') {
        return {
          card: 'bg-gradient-to-r from-emerald-200 via-emerald-100 to-green-50 shadow-xl shadow-emerald-300/70',
          iconBg: 'bg-gradient-to-br from-emerald-500 to-green-500',
          iconText: 'text-white',
          accent: 'from-emerald-500 via-green-400 to-teal-300',
          patternColor: 'border-emerald-300',
          dotColor: 'bg-emerald-500',
          titleColor: 'text-emerald-900',
        };
      }
      return {
        card: 'bg-gradient-to-r from-blue-200 via-blue-100 to-sky-50 shadow-xl shadow-blue-300/70',
        iconBg: 'bg-gradient-to-br from-blue-500 to-sky-500',
        iconText: 'text-white',
        accent: 'from-blue-500 via-sky-400 to-cyan-400',
        patternColor: 'border-blue-300',
        dotColor: 'bg-blue-500',
        titleColor: 'text-blue-900',
      };
    }

    // Read messages keep a softer version of the priority color.
    if (priority === 'urgent') {
      return {
        card: 'bg-gradient-to-br from-rose-50/70 via-white/85 to-orange-50/50 ring-1 ring-rose-200/70 shadow-sm shadow-rose-200/30',
        iconBg: 'bg-rose-50',
        iconText: 'text-rose-400',
        accent: 'from-rose-300/70 via-red-200/70 to-orange-200/70',
        patternColor: 'border-rose-100',
        dotColor: 'bg-rose-300',
        titleColor: 'text-rose-700',
      };
    }

    if (priority === 'high') {
      return {
        card: 'bg-gradient-to-br from-emerald-50/70 via-white/85 to-green-50/50 ring-1 ring-emerald-200/70 shadow-sm shadow-emerald-200/30',
        iconBg: 'bg-emerald-50',
        iconText: 'text-emerald-400',
        accent: 'from-emerald-300/70 via-green-200/70 to-teal-200/70',
        patternColor: 'border-emerald-100',
        dotColor: 'bg-emerald-300',
        titleColor: 'text-emerald-700',
      };
    }

    return {
      card: 'bg-gradient-to-br from-blue-50/70 via-white/85 to-sky-50/50 ring-1 ring-blue-200/70 shadow-sm shadow-blue-200/30',
      iconBg: 'bg-blue-50',
      iconText: 'text-blue-400',
      accent: 'from-blue-300/70 via-sky-200/70 to-cyan-200/70',
      patternColor: 'border-blue-100',
      dotColor: 'bg-blue-300',
      titleColor: 'text-blue-700',
    };
  };

  const getReadBorder = (priority: string, isReward: boolean) =>
    isReward ? 'border-amber-200/80'
      : priority === 'urgent' ? 'border-rose-200/80'
      : priority === 'high' ? 'border-emerald-200/80'
      : 'border-blue-200/80';

  const unreadCount = unreadMessages.length;
  const detailTone = selectedMessage ? getNotificationDetailTone(selectedMessage.messages.priority, selectedMessage.messages.notification_category) : 'normal';
  const detailTheme = NOTIFICATION_DETAIL_THEMES[detailTone];

  const sortedMessages = [...messages].sort((a, b) => {
    if (!a.is_read && b.is_read) return -1;
    if (a.is_read && !b.is_read) return 1;
    return new Date(b.messages.created_at || 0).getTime() - new Date(a.messages.created_at || 0).getTime();
  });

  const formatRelativeTime = (dateStr: string) => {
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t.messages.justNow;
    if (diffMins < 60) return `${diffMins}${t.messages.minsAgo}`;
    if (diffHours < 24) return `${diffHours}${t.messages.hoursAgo}`;
    if (diffDays < 7) return `${diffDays}${t.messages.daysAgo}`;
    return date.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' });
  };

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="employee-modal-backdrop message-center-backdrop fixed inset-0 bg-slate-900/50"
        style={{
          touchAction: 'none',
          overscrollBehavior: 'contain',
          zIndex: 10000,
          opacity: isClosing ? 0 : 1,
          transition: `opacity ${MESSAGE_PANEL_ANIMATION_MS}ms ease`,
        }}
        onClick={requestClose}
      />

      {/* Message Center Panel - full screen on mobile/tablet with solid background */}
      <div
        className={`employee-modal-surface message-center-panel ${isClosing ? 'message-center-panel--closing' : ''} fixed inset-0 lg:inset-auto lg:top-0 lg:right-0 lg:h-full lg:w-full lg:max-w-2xl lg:rounded-l-2xl lg:shadow-[-12px_0_32px_-12px_rgba(15,23,42,0.35)] overflow-hidden flex flex-col`}
        style={{ zIndex: 10001 }}
      >
        {/* SOLID opaque background - not transparent */}
        <div className="absolute inset-0 bg-[#f0f5ff]" />
        {/* Subtle decorative background pattern */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-[30%] -right-20 w-80 h-80 bg-blue-100/40 rounded-full blur-3xl" />
          <div className="absolute bottom-[20%] -left-20 w-64 h-64 bg-cyan-100/30 rounded-full blur-3xl" />
        </div>

        {/* Header */}
        <div className="relative flex-shrink-0 overflow-hidden">
          {/* Solid header background */}
          <div className="absolute inset-0 bg-gradient-to-br from-blue-600 via-blue-500 to-cyan-500" />

          {/* Decorative geometric shapes */}
          <div className="absolute top-0 right-0 w-64 h-64 opacity-[0.08]">
            <div className="absolute top-4 right-4 w-32 h-32 border-2 border-white rounded-3xl rotate-12" />
            <div className="absolute top-12 right-12 w-24 h-24 border-2 border-white rounded-2xl -rotate-6" />
            <div className="absolute top-2 right-32 w-16 h-16 border-2 border-white rounded-xl rotate-45" />
          </div>
          <div className="absolute -bottom-6 -left-6 w-32 h-32 bg-white/[0.06] rounded-full" />
          <div className="absolute top-1/2 left-1/3 w-2 h-2 bg-cyan-300/30 rounded-full" />
          <div className="absolute top-4 left-2/3 w-1.5 h-1.5 bg-white/20 rounded-full" />

          <div
            className="relative px-4 py-3 lg:px-5 lg:py-4"
            style={{ paddingTop: !isDesktop ? 'calc(env(safe-area-inset-top, 0px) + 12px)' : undefined }}
          >
            <div className="flex items-center gap-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="relative flex-shrink-0">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/25 bg-white/15 shadow-lg backdrop-blur-sm sm:h-10 sm:w-10">
                    <Bell className="w-5 h-5 text-white" />
                  </div>
                  {unreadCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-[20px] px-1 bg-white text-blue-600 text-[11px] font-black rounded-full flex items-center justify-center shadow-lg ring-2 ring-blue-500">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="text-xl font-bold tracking-tight text-white lg:text-2xl">
                    {t.messages.title}
                  </h2>
                  <p className="mt-0.5 text-sm font-medium text-blue-100/90">
                    {unreadCount > 0 ? `${unreadCount} ${t.messages.newMessages}` : t.messages.gotIt}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={requestClose}
                className="notification-panel-list-close emp-close-btn emp-close-btn--wrap group flex shrink-0 items-center justify-center rounded-xl text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                style={{ WebkitTapHighlightColor: 'transparent' }}
                aria-label={t.messages.close}
              >
                <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] border border-white/10 bg-white/20 backdrop-blur-sm transition-all group-hover:bg-white/30 group-active:scale-95">
                  <X className="h-4 w-4 shrink-0" strokeWidth={2.5} />
                </span>
              </button>
            </div>

            {/* Filter tabs */}
            <div className="relative mt-2.5 grid grid-cols-4 gap-1 rounded-xl bg-white/[0.1] p-[3px] ring-1 ring-inset ring-white/20 backdrop-blur-sm sm:mt-3 sm:p-1 lg:mt-4">
              {[
                { id: 'all', label: t.wallet.all },
                { id: 'unread', label: t.messages.unread },
                { id: 'login', label: t.messages.typeLogin },
                { id: 'realtime', label: t.messages.typeLive }
              ].map(f => {
                const isActive = filter === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => setFilter(f.id as typeof filter)}
                    aria-pressed={isActive}
                    className={`message-center-filter-tab msg-force-transition group relative flex min-w-0 items-center justify-center overflow-hidden rounded-lg text-center font-semibold transition-all duration-200 ${
                      isActive
                        ? 'text-blue-700'
                        : 'text-blue-50/90 hover:bg-white/10 hover:text-white'
                    }`}
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    {isActive && (
                      <span className="absolute inset-0 rounded-lg bg-white shadow-[0_6px_16px_-8px_rgba(15,23,42,0.5)]" aria-hidden="true">
                        <span className="absolute bottom-[4px] left-1/2 h-[2px] w-[18px] -translate-x-1/2 rounded-full bg-gradient-to-r from-blue-600 to-cyan-500 shadow-[0_0_6px_rgba(6,182,212,0.55)] sm:bottom-[5px] sm:w-[22px]" />
                      </span>
                    )}
                    <span className={`relative z-10 block max-w-full truncate ${isActive ? 'font-bold' : 'group-hover:font-bold'}`}>{f.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Message List */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <PanelColorBlocks />
          <div className="relative h-full overflow-y-auto overscroll-y-contain">
          <div className="emp-compact-panel flex flex-col gap-4 px-4 lg:px-6 py-4 pb-8">
            {failedReadIds.size > 0 && (
              <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs font-semibold text-rose-700">
                <span>{t.messages.readSyncFailed}</span>
                <button type="button" onClick={() => failedReadIds.forEach(id => void markAsRead(id))} className="shrink-0 rounded-lg border border-rose-200 bg-white px-2.5 py-1.5">{t.common.retry}</button>
              </div>
            )}
            {loading || !panelReady ? (
              <PageLoader variant="panel" label={t.messages.loading} className="!min-h-[calc(100dvh-180px)] lg:!min-h-[calc(100dvh-220px)]" />
            ) : messages.length === 0 ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
                <div className="relative z-10 mb-5 h-[96px] w-[120px]" aria-hidden="true">
                  <span className="absolute left-1/2 top-1/2 h-[84px] w-[84px] -translate-x-1/2 -translate-y-1/2 -rotate-6 rounded-[28px] border-2 border-sky-300/40"></span>
                  <span className="absolute left-1/2 top-1/2 h-[74px] w-[74px] -translate-x-1/2 -translate-y-1/2 rotate-12 rounded-3xl border-2 border-blue-300/50"></span>
                  <span className="absolute left-1/2 top-1/2 flex h-[64px] w-[64px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[22px] bg-gradient-to-br from-blue-400 via-sky-400 to-cyan-300 shadow-lg shadow-blue-400/20">
                    <Bell className="h-8 w-8 text-white" strokeWidth={2} />
                  </span>
                </div>
                <p className="relative z-10 text-[14px] font-semibold leading-6 text-blue-900">{t.messages.noMessages}</p>
                <p className="relative z-10 mt-1 max-w-[250px] text-[13px] leading-5 text-blue-800/60">{t.messages.emptyDesc}</p>
              </div>
            ) : (
              <div className="message-list-fade flex flex-col gap-4">
              {sortedMessages.map((msg) => {
                const isUnread = !msg.is_read;
                const isReward = msg.messages.notification_category === 'performance_reward';
                const deliveredMessageType = getDeliveredMessageType(msg);
                const style = getCardStyle(msg.messages.priority, isUnread, isReward);
                return (
                  <div
                    key={msg.id}
                    onClick={() => openMessage(msg)}
                    className="group relative cursor-pointer msg-force-transition active:scale-[0.98]"
                  >
                    {/* Card */}
                    <div className={`relative rounded-2xl overflow-hidden msg-force-transition hover:-translate-y-0.5 hover:shadow-xl ${isUnread ? 'shadow-[0_10px_30px_rgba(37,99,235,0.28)] brightness-[1.03]' : `border opacity-[0.9] saturate-[0.9] hover:opacity-100 hover:saturate-100 ${getReadBorder(msg.messages.priority, isReward)}`} ${style.card}`}>
                      {/* Accent: unread cards get a left + top L-shaped gradient line, read cards a thin left bar */}
                      {isUnread ? (
                        <div
                          className="pointer-events-none absolute inset-0 rounded-2xl"
                          style={{
                            padding: '3px 0 0 5px',
                            background: getUnreadLine(msg.messages.priority, isReward),
                            WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                            WebkitMaskComposite: 'xor',
                            mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
                          }}
                          aria-hidden="true"
                        />
                      ) : (
                        <div className={`absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b ${style.accent} rounded-l-2xl`} />
                      )}

                      {/* Decorative pattern blocks */}
                      <div className="absolute top-0 right-0 w-32 h-full overflow-hidden pointer-events-none opacity-[0.07]">
                        <div className={`absolute top-3 right-3 w-16 h-16 border-2 ${style.patternColor} rounded-2xl rotate-12`} />
                        <div className={`absolute bottom-2 right-8 w-10 h-10 border-2 ${style.patternColor} rounded-lg -rotate-6`} />
                        <div className={`absolute top-1/2 right-2 w-6 h-6 border-2 ${style.patternColor} rounded-full`} />
                      </div>

                      <div className="relative z-10 py-3 pr-4 pl-5 lg:py-3.5 lg:pr-5 lg:pl-6">
                        <div className="flex items-start gap-3">
                          {/* Priority icon with colored background */}
                          <div className={`flex-shrink-0 w-9 h-9 rounded-xl flex items-center justify-center shadow-sm ${style.iconBg}`}>
                            {isReward
                              ? <Gift className={`h-[18px] w-[18px] ${style.iconText}`} />
                              : getPriorityIcon(msg.messages.priority, `w-[18px] h-[18px] ${style.iconText}`)}
                          </div>

                          {/* Content */}
                          <div className="flex-1 min-w-0">
                            {/* Title row */}
                            <div className="flex items-start justify-between gap-2 mb-0.5">
                              <h3 className={`font-semibold text-[15px] leading-snug line-clamp-1 ${isUnread ? 'font-bold' : ''} ${style.titleColor}`}>
                                {msg.messages.title}
                              </h3>
                              <span className={`relative z-10 text-[11px] font-medium whitespace-nowrap flex-shrink-0 mt-0.5 ${
                                isUnread ? 'text-blue-600' : 'text-slate-500'
                              }`}>
                                {formatRelativeTime(msg.messages.created_at || '')}
                              </span>
                            </div>

                            {isReward && (
                              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                                <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-200/60 px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wider text-amber-800">
                                  <Sparkles className="h-3 w-3" /> {t.messages.rewardTitle}
                                </span>
                                <span className="text-sm font-black text-amber-700">
                                  +{Number(msg.messages.reward_amount || 0).toFixed(2)} {msg.messages.reward_currency}
                                </span>
                              </div>
                            )}

                            {/* Preview */}
                            <p className={`text-xs line-clamp-1 leading-relaxed mb-2 ${
                              isUnread ? 'text-slate-600' : 'text-slate-500'
                            }`}>
                              {msg.messages.content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim()}
                            </p>

                            {/* Bottom meta row */}
                            <div className="flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <span className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-0.5 rounded-md font-bold uppercase tracking-wider ${
                                  deliveredMessageType === 'login_popup'
                                    ? 'bg-sky-100 text-sky-700 ring-1 ring-sky-200/80'
                                    : 'bg-teal-100 text-teal-700 ring-1 ring-teal-200/80'
                                }`}>
                                  {deliveredMessageType === 'login_popup' ? t.messages.typeLogin : t.messages.typeLive}
                                </span>
                                <span className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-0.5 rounded-md font-bold uppercase tracking-wider ${
                                  msg.messages.priority === 'urgent'
                                    ? 'bg-rose-100 text-rose-700 ring-1 ring-rose-200/80'
                                    : msg.messages.priority === 'high'
                                      ? 'bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/80'
                                      : 'bg-blue-100 text-blue-700 ring-1 ring-blue-200/80'
                                }`}>
                                  {msg.messages.priority === 'urgent' ? t.messages.priorityUrgent : msg.messages.priority === 'high' ? t.messages.priorityHigh : msg.messages.priority === 'normal' ? t.messages.priorityNormal : t.messages.priorityLow}
                                </span>
                              </div>
                              <div className="flex items-center gap-1.5">
                                {msg.is_read ? (
                                  <div className="flex items-center gap-1.5 text-slate-500">
                                    <Eye className="w-3.5 h-3.5" />
                                    <span className="text-[11px] font-medium uppercase tracking-wide">{t.messages.read}</span>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1.5 text-blue-600 group-hover:text-blue-700">
                                    <span className="h-2 w-2 rounded-full bg-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.14)]" />
                                    <span className="text-[11px] font-black uppercase tracking-wide">{t.messages.unread}</span>
                                    <ChevronRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>

                          {/* Unread dot */}
                          {isUnread && (
                            <div className="pointer-events-none absolute right-1 top-1">
                              <div className="relative">
                                <div className={`w-3 h-3 ${style.dotColor} rounded-full ring-2 ring-white/80`} />
                                <div className={`absolute inset-0 w-3 h-3 ${style.dotColor} rounded-full ring-2 ring-white/80 msg-anim-ping opacity-75`} />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              </div>
            )}
          </div>
          </div>
        </div>
      </div>

      {/* Message Detail Modal - full screen on all devices, solid background */}
      {selectedMessage && (
        <>
          <div
            className="employee-modal-backdrop fixed inset-0 bg-slate-900/50"
            style={{ zIndex: 10002, touchAction: 'none', overscrollBehavior: 'contain' }}
            onClick={() => setSelectedMessage(null)}
          />
          {/* Centering wrapper for desktop (uses flexbox, no transform conflicts) */}
          <div
            className="fixed inset-0 flex items-center justify-center pointer-events-none"
            style={{ zIndex: 10003 }}
          >
          <div
            className={`
              employee-modal-surface relative overflow-hidden flex flex-col pointer-events-auto bg-[#f0f5ff]
              w-full h-full
              ${isDesktop ? 'lg:w-full lg:max-w-2xl lg:h-[82vh] lg:rounded-3xl lg:shadow-2xl' : ''}
            `}
          >
            {/* Detail Header */}
            <div className="relative flex-shrink-0 overflow-hidden">
              <div className={`absolute inset-0 bg-gradient-to-br ${detailTheme.headerGradient}`} />

              {/* Decorative elements */}
              <div className="absolute top-0 right-0 w-48 h-48 opacity-[0.06]">
                <div className="absolute top-6 right-6 w-24 h-24 border-2 border-white rounded-2xl rotate-12" />
                <div className="absolute top-2 right-28 w-14 h-14 border-2 border-white rounded-xl -rotate-6" />
              </div>
              <div className="absolute bottom-0 left-0 w-24 h-24 bg-white/[0.04] rounded-full translate-y-1/2 -translate-x-1/3" />

              <div
                className="relative px-4 pb-3 pt-6 lg:px-6 lg:pb-3 lg:pt-6"
                style={{
                  paddingTop: !isDesktop ? 'calc(env(safe-area-inset-top, 0px) + 20px)' : undefined
                }}
              >
                {/* Close button */}
                <button
                  type="button"
                  onClick={() => setSelectedMessage(null)}
                  aria-label={t.messages.close}
                  className={`notification-panel-list-close emp-close-btn emp-close-btn--wrap group absolute right-2.5 top-2.5 z-10 flex items-center justify-center rounded-xl focus-visible:outline-none focus-visible:ring-2 lg:right-4 lg:top-3 ${detailTheme.closeOuter}`}
                  style={{
                    WebkitTapHighlightColor: 'transparent',
                    top: !isDesktop ? 'calc(env(safe-area-inset-top, 0px) + 10px)' : undefined,
                  }}
                >
                  <span className={`flex h-9 w-9 items-center justify-center rounded-xl backdrop-blur-sm transition-all group-active:scale-95 ${detailTheme.closeInner}`}>
                    <X className="h-4 w-4 shrink-0" strokeWidth={2.5} />
                  </span>
                </button>

                {/* Title section */}
                <div className="flex items-start gap-2.5 pr-14">
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border backdrop-blur-sm sm:h-10 sm:w-10 ${detailTheme.iconBox}`}>
                    {selectedMessage.messages.notification_category === 'performance_reward'
                      ? <Gift className="h-5 w-5" strokeWidth={2} />
                      : getPriorityIcon(selectedMessage.messages.priority, 'h-5 w-5 text-white')}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className={`mb-1 break-words text-lg font-bold leading-tight lg:text-xl ${detailTheme.titleText}`}>
                      {selectedMessage.messages.title}
                    </h3>
                    <div className={`flex flex-wrap items-center gap-2 text-sm font-medium ${detailTheme.metaText}`}>
                      <div className="flex items-center gap-1.5">
                        <Clock className={`h-3.5 w-3.5 ${detailTheme.clockIcon}`} />
                        <span>
                          {new Date(selectedMessage.messages.created_at || 0).toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' })}
                        </span>
                      </div>
                      <span className={detailTheme.metaDivider}>|</span>
                      <span>
                        {new Date(selectedMessage.messages.created_at || 0).toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Tags */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 pr-14">
                  <span className={`rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${detailTheme.typeTag}`}>
                    {getDeliveredMessageType(selectedMessage) === 'login_popup' ? t.messages.loginNotification : t.messages.liveMessage}
                  </span>
                  <span className={`rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider ${detailTheme.priorityTag}`}>
                    {selectedMessage.messages.priority === 'urgent' ? t.messages.priorityUrgent : selectedMessage.messages.priority === 'high' ? t.messages.priorityHigh : selectedMessage.messages.priority === 'normal' ? t.messages.priorityNormal : t.messages.priorityLow} {t.messages.priority}
                  </span>
                </div>
              </div>
            </div>

            {/* Detail Content */}
            <div
              className="relative flex min-h-0 flex-1 overflow-hidden p-0"
              style={{
                minHeight: 0,
                WebkitOverflowScrolling: 'touch'
              } as React.CSSProperties}
            >
              {/* Content card */}
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden" style={{ background: detailTheme.contentGradient }}>
                <PanelColorBlocks tone={detailTheme.blockTone} />
                {/* Top accent line */}
                <div className={`absolute left-6 right-6 top-0 z-10 h-[2px] rounded-full bg-gradient-to-r from-transparent to-transparent ${detailTheme.accentLine}`} />

                {detailTone === 'reward' && (
                  <div className={`relative ${detailTheme.rewardBannerClass}`}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-black text-amber-800">{t.messages.rewardBonusLabel}</p>
                        <p className="mt-0.5 text-[11px] font-black uppercase tracking-wider text-amber-600 sm:tracking-[0.16em]">{t.messages.rewardWalletLabel}</p>
                      </div>
                      <p className="shrink-0 text-2xl font-black text-amber-700">+{Number(selectedMessage.messages.reward_amount || 0).toFixed(2)} <span className="text-base">{selectedMessage.messages.reward_currency}</span></p>
                    </div>
                    <div className="mt-3 flex items-center gap-2 border-t border-amber-200/80 pt-3">
                      <Wallet className="h-4 w-4 shrink-0 text-emerald-600" />
                      <p className="text-xs font-semibold leading-5 text-emerald-700">{t.messages.rewardAddedMessage}</p>
                    </div>
                  </div>
                )}

                <div className={`relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain p-4 lg:p-5 ${detailTheme.scrollbar}`}>
                  <QuickCopyRichContent
                    html={selectedMessage.messages.content}
                    copyLabel={t.messages.quickCopy}
                    copiedLabel={t.messages.copied}
                    className={`notification-detail-prose max-w-none ${detailTheme.prose} [&_a]:underline [&_img]:!rounded-xl [&_img]:!shadow-md [&_blockquote]:!p-4 [&_blockquote]:!rounded-r-lg [&_h1]:!text-slate-900 [&_h2]:!text-slate-800 [&_h3]:!text-slate-700 [&_p]:!text-slate-700 [&_li]:!text-slate-700 message-content-dark`}
                    style={{ wordBreak: 'break-word', overflowWrap: 'break-word', color: '#1e293b' }}
                  />
                </div>
              </div>
            </div>

            {/* Detail Footer */}
            <div className={`relative flex-shrink-0 bg-white border-t p-4 lg:p-5 ${detailTheme.footerBorder}`}>
              {failedReadIds.has(selectedMessage.id) && (
                <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700">
                  <span>{t.messages.readSyncFailed}</span>
                  <button type="button" onClick={() => void markAsRead(selectedMessage.id)} disabled={markingReadId === selectedMessage.id} className="shrink-0 rounded-lg border border-rose-200 px-2.5 py-1.5 disabled:opacity-50">{t.common.retry}</button>
                </div>
              )}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {selectedMessage.is_read ? (
                    <>
                      <div className="flex items-center justify-center w-9 h-9 bg-emerald-50 rounded-xl ring-1 ring-emerald-200">
                        <CheckCircle className="w-4 h-4 text-emerald-600" />
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">{t.messages.read}</p>
                        <p className="text-sm text-slate-700 font-semibold">{new Date(selectedMessage.read_at!).toLocaleDateString(dateLocale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className={`flex items-center justify-center w-9 h-9 rounded-xl ring-1 ${detailTheme.unreadIconBox}`}>
                        <Sparkles className={`w-4 h-4 ${detailTheme.unreadIcon}`} />
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wide">{t.messages.notification}</p>
                        <p className={`text-sm font-semibold ${detailTheme.unreadLabel}`}>{t.messages.markAsRead}</p>
                      </div>
                    </>
                  )}
                </div>
                <button
                  onClick={() => setSelectedMessage(null)}
                  className={`min-h-[44px] px-6 py-2.5 rounded-xl font-semibold text-sm transition-all active:scale-95 ${detailTheme.footerButton}`}
                >
                  {t.messages.close}
                </button>
              </div>
            </div>
          </div>
          </div>
        </>
      )}
    </>,
    document.body
  );
}
