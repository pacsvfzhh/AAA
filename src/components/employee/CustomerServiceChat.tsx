import { useState, useEffect, useLayoutEffect, useRef, memo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MessageCircle, X, Send, Image, Star, ArrowLeft, Clock, Zap, Sparkles, Award, Gift, ZoomIn, ZoomOut, RotateCcw, Megaphone, ChevronRight } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { sanitizeChatMessage, sanitizeAnnouncementContent } from '../../lib/sanitizeHTML';
import { useLanguage } from '../../lib/i18n/context';
import { CustomerAvatarDisplay } from '../admin/CustomerAvatarPicker';
import { preloadCustomerAvatar } from '../admin/customerAvatarUtils';
import { uploadStorageObjectWithProgress } from '../../lib/storageUpload';
import { uniqueRealtimeChannelName } from '../../lib/realtimeChannel';
import PageLoader from './PageLoader';

function extractImageOnlyUrl(content: string): string | null {
  const container = document.createElement('div');
  container.innerHTML = sanitizeChatMessage(content);
  const images = container.querySelectorAll('img');
  const text = (container.textContent || '').replace(/\u00a0/g, ' ').trim();

  if (images.length !== 1 || text) return null;
  return images[0].getAttribute('src') || null;
}

// Image component with loading state
const ChatImage = memo(({
  src,
  alt,
  onClickImage,
}: {
  src: string;
  alt: string;
  onClickImage: (src: string) => void;
}) => {
  const { t } = useLanguage();
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageError, setImageError] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    setImageLoaded(false);
    setImageError(false);
    const image = imgRef.current;
    if (!image?.complete) return;
    setImageLoaded(image.naturalWidth > 0);
    setImageError(image.naturalWidth === 0);
  }, [src]);

  return (
    <div
      className={`relative flex w-fit max-w-full flex-col overflow-hidden rounded-lg leading-none ${imageLoaded || imageError ? '' : 'min-h-[60px] min-w-[60px]'}`}
      style={{ width: 'fit-content', height: 'fit-content', maxWidth: '200px', backgroundColor: 'transparent' }}
    >
      {/* Loading skeleton - fades out */}
      <div
        className={`absolute inset-0 bg-gray-100 flex items-center justify-center transition-opacity duration-300 ${
          imageLoaded || imageError ? 'opacity-0 pointer-events-none' : 'opacity-100'
        }`}
      >
        <div className="flex flex-col items-center gap-2">
          <div className="w-10 h-10 border-3 border-gray-200 border-t-blue-500 rounded-full animate-spin"></div>
          <span className="text-xs text-gray-400">{t.customerService.loading}</span>
        </div>
      </div>

      {/* Error state - fades in */}
      {imageError && (
        <div className="absolute inset-0 bg-gray-100 flex items-center justify-center border border-red-200">
          <div className="flex flex-col items-center gap-2 text-red-400">
            <svg className="w-10 h-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="text-xs">{t.customerService.loadFailed}</span>
          </div>
        </div>
      )}

      {/* Image - fades in */}
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className={`block rounded-lg object-contain cursor-pointer hover:opacity-90 transition-opacity duration-300 shadow-sm ${
          imageLoaded ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ width: 'auto', height: 'auto', maxWidth: '200px', maxHeight: '250px' }}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); onClickImage(src); }}
        onLoad={() => setImageLoaded(true)}
        onError={() => setImageError(true)}
        loading="eager"
        decoding="async"
      />
    </div>
  );
});

const CustomerAvatar = memo(({
  customer,
  className = 'w-10 h-10'
}: {
  customer: Customer;
  className?: string;
}) => (
  <CustomerAvatarDisplay
    avatar={customer.customer_avatar}
    isVip={customer.is_super || false}
    customAvatarUrl={customer.custom_avatar_url}
    alt={customer.customer_name}
    className={`${className} rounded-lg border-2 ${
      customer.is_super
        ? 'border-amber-400/60'
        : 'border-cyan-400/50'
    }`}
  />
));

type ServiceSourceType = 'aaa_service' | 'ccc_service';

interface Customer {
  id: string;
  customer_name: string;
  customer_id: string;
  customer_avatar: string | null;
  is_super?: boolean | null;
  super_customer_title?: string | null;
  badge_type?: 'diamond' | 'crown' | 'star' | 'vip' | 'premium' | null;
  custom_avatar_url?: string | null;
  vip_label?: string | null;
  employee_pin_top?: boolean;
  employee_always_visible?: boolean;
  target_employee_id?: string | null;
  target_employee_ids?: string[] | null;
  source_type: ServiceSourceType;
}

interface Message {
  id: string;
  customer_id: string;
  employee_id: string;
  sender_type: 'customer' | 'employee';
  message_content: string;
  message_type?: 'text' | 'image' | 'rating_request' | 'rating_result' | 'tip' | 'rich_card' | null;
  title?: string | null;
  subtitle?: string | null;
  image_url?: string | null;
  rating_data?: {
    rating?: number;
    comment?: string | null;
    employee_id?: string;
    status?: string;
    tip_amount?: number;
  } | null;
  is_read: boolean | null;
  created_at: string | null;
  rich_card_content_id?: string | null;
  content_frozen?: boolean;
  rating_value?: number | null;
  source_template_id?: string | null;
  source_auto_message_id?: string | null;
}

type IncomingMessage = Partial<Message> & { customer_id?: string };

interface CustomerConversation {
  customer: Customer;
  unread_count: number;
  last_message: string;
  last_message_time: string;
  last_customer_message_time?: string;
}

interface EmployeeConversationSnapshot {
  conversations: CustomerConversation[];
  unreadCount: number;
}

function ChatMessagesLoader({ label, tone }: { label: string; tone: 'blue' | 'gold' }) {
  return (
    <div className={`chat-loader chat-loader--${tone}`} role="status" aria-live="polite">
      <div className="chat-loader__stage" aria-hidden="true">
        <span className="chat-loader__halo" />
        <span className="chat-loader__ring" />
        <span className="chat-loader__bubble chat-loader__bubble--back" />
        <span className="chat-loader__bubble chat-loader__bubble--front">
          <i /><i /><i />
        </span>
      </div>
      <span className="chat-loader__label">{label}</span>
    </div>
  );
}

function preloadConversationAvatars(conversations: CustomerConversation[]) {
  conversations.forEach(conversation => {
    void preloadCustomerAvatar(conversation.customer.custom_avatar_url);
  });
}

const employeeConversationCache = new Map<string, EmployeeConversationSnapshot>();
const employeeMessageCaches = new Map<string, Map<string, Message[]>>();
const preloadedChatImages = new Set<string>();
const MESSAGE_PAGE_SIZE = 50;
const SOURCE_LOOKUP_CHUNK_SIZE = 100;
const OPEN_CHAT_REFRESH_MS = 30000;
const CLOSED_CHAT_REFRESH_MS = 300000;
const CATCH_UP_MIN_GAP_MS = 10000;
// A customer's source_type never changes, so it is looked up once per page load.
const customerSourceTypes = new Map<string, string>();

function getEmployeeMessageCache(employeeId: string) {
  const existing = employeeMessageCaches.get(employeeId);
  if (existing) return existing;
  const cache = new Map<string, Message[]>();
  employeeMessageCaches.set(employeeId, cache);
  return cache;
}

function preloadChatImages(messages: Message[]) {
  const imageUrls = new Set(
    messages.slice(-12).flatMap(message => {
      const urls = message.image_url ? [message.image_url] : [];
      const embeddedUrls = Array.from(
        message.message_content.matchAll(/<img[^>]+src=["']([^"']+)["']/gi),
        match => match[1],
      );
      return [...urls, ...embeddedUrls];
    }),
  );

  imageUrls.forEach(url => {
    if (!url || preloadedChatImages.has(url)) return;
    preloadedChatImages.add(url);
    const image = document.createElement('img');
    image.decoding = 'async';
    image.src = url;
  });
}

function isSameMessage(previous: Message, next: Message) {
  return previous.id === next.id
    && previous.message_content === next.message_content
    && previous.message_type === next.message_type
    && previous.image_url === next.image_url
    && previous.title === next.title
    && previous.subtitle === next.subtitle
    && previous.is_read === next.is_read
    && previous.rich_card_content_id === next.rich_card_content_id
    && previous.source_template_id === next.source_template_id
    && previous.source_auto_message_id === next.source_auto_message_id
    && JSON.stringify(previous.rating_data) === JSON.stringify(next.rating_data);
}

// The newest page replaces what is on screen; older pages the employee scrolled to and messages
// still being sent stay visible.
function mergeLatestMessages(previous: Message[], latest: Message[], customerId: string) {
  const current = previous.filter(message => message.customer_id === customerId);
  const latestIds = new Set(latest.map(message => message.id));
  const oldestLatestTime = latest[0]?.created_at || '';
  const olderHistory = latest.length >= MESSAGE_PAGE_SIZE
    ? current.filter(message => !message.id.startsWith('temp-')
      && !latestIds.has(message.id)
      && (message.created_at || '') < oldestLatestTime)
    : [];
  const sending = current.filter(message => message.id.startsWith('temp-'));
  const next = [...olderHistory, ...latest, ...sending];
  const unchanged = next.length === previous.length
    && next.every((message, index) => isSameMessage(previous[index], message));
  return unchanged ? previous : next;
}

// A refresh can bring in the saved row before the send call returns; never show it twice.
function replaceSentMessage(messages: Message[], tempId: string, saved: Message) {
  if (messages.some(message => message.id === saved.id)) {
    return messages.filter(message => message.id !== tempId);
  }
  return messages.map(message => (message.id === tempId ? saved : message));
}

interface CustomerServiceChatProps {
  employeeId: string;
}

export default function CustomerServiceChat({ employeeId }: CustomerServiceChatProps) {
  const { t, dateLocale } = useLanguage();
  const initialConversationSnapshot = employeeConversationCache.get(employeeId);

  const [isOpen, setIsOpen] = useState(false);
  const [showConversationList, setShowConversationList] = useState(true);
  const skipListAnimationRef = useRef(false);
  const employeeAdminIdRef = useRef<string | null>(null);
  const [conversations, setConversations] = useState<CustomerConversation[]>(
    () => initialConversationSnapshot?.conversations || [],
  );
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [messageInput, setMessageInput] = useState('');
  const [unreadCount, setUnreadCount] = useState(
    () => initialConversationSnapshot?.unreadCount || 0,
  );
  const [serviceTicketNumber, setServiceTicketNumber] = useState<string>('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const uploadingTempIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [conversationsError, setConversationsError] = useState(false);
  const [messagesError, setMessagesError] = useState(false);
  const [realtimeRetryKey, setRealtimeRetryKey] = useState(0);
  const messagesCache = useRef<Map<string, Message[]>>(getEmployeeMessageCache(employeeId));
  const messagePrefetchRequestsRef = useRef<Map<string, Promise<void>>>(new Map());
  const conversationLoadRequestRef = useRef(0);
  const messagesLoadRequestRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const conversationListRef = useRef<HTMLDivElement>(null);
  const conversationListScrollRef = useRef(0);

  const messagesContainerCallbackRef = (node: HTMLDivElement | null) => {
    if (node) {
      messagesContainerRef.current = node;
    }
  };
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [messagePopup, setMessagePopup] = useState<{ customer: Customer; message: string; time: string } | null>(null);
  const [playingSound, setPlayingSound] = useState(false);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [viewingRichCard, setViewingRichCard] = useState<Message | null>(null);
  const [richCardFullContent, setRichCardFullContent] = useState<string | null>(null);
  const [loadingRichCardContent, setLoadingRichCardContent] = useState(false);
  const richCardCancelRef = useRef(false);
  const richCardCacheRef = useRef<Map<string, string>>(new Map());
  const richCardPrefetchingRef = useRef<Set<string>>(new Set());

  const fetchRichCardContent = useCallback(async (contentId: string): Promise<string | null> => {
    const cached = richCardCacheRef.current.get(contentId);
    if (cached) return cached;
    try {
      const { data, error } = await supabase
        .from('rich_card_contents')
        .select('html_content')
        .eq('id', contentId)
        .maybeSingle();
      if (!error && data?.html_content) {
        richCardCacheRef.current.set(contentId, data.html_content);
        return data.html_content;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  const fetchTemplateContentForViewer = useCallback(async (templateId: string): Promise<string | null> => {
    try {
      const { data, error } = await supabase
        .from('cs_message_templates')
        .select('content')
        .eq('id', templateId)
        .maybeSingle();
      if (!error && data?.content) return data.content;
      return null;
    } catch {
      return null;
    }
  }, []);

  const fetchAutoMsgContentForViewer = useCallback(async (autoMsgId: string): Promise<string | null> => {
    try {
      const { data, error } = await supabase
        .from('customer_auto_messages')
        .select('content')
        .eq('id', autoMsgId)
        .maybeSingle();
      if (!error && data?.content) return data.content;
      return null;
    } catch {
      return null;
    }
  }, []);

  const prefetchRichCard = useCallback((msg: Message | IncomingMessage) => {
    const key = msg.content_frozen && msg.rich_card_content_id ? msg.rich_card_content_id :
                msg.source_template_id ? `tpl:${msg.source_template_id}` :
                msg.source_auto_message_id ? `auto:${msg.source_auto_message_id}` :
                msg.rich_card_content_id || null;
    if (!key) return;
    if (richCardCacheRef.current.has(key)) return;
    if (richCardPrefetchingRef.current.has(key)) return;
    richCardPrefetchingRef.current.add(key);
    const p = msg.content_frozen && msg.rich_card_content_id ? fetchRichCardContent(msg.rich_card_content_id) :
              msg.source_template_id ? fetchTemplateContentForViewer(msg.source_template_id) :
              msg.source_auto_message_id ? fetchAutoMsgContentForViewer(msg.source_auto_message_id) :
              fetchRichCardContent(key);
    p.finally(() => richCardPrefetchingRef.current.delete(key));
  }, [fetchRichCardContent, fetchTemplateContentForViewer, fetchAutoMsgContentForViewer]);

  const openRichCardViewer = useCallback(async (msg: Message) => {
    richCardCancelRef.current = false;
    setViewingRichCard(msg);

    const cacheKey = msg.content_frozen && msg.rich_card_content_id ? msg.rich_card_content_id :
                     msg.source_template_id ? `tpl:${msg.source_template_id}` :
                     msg.source_auto_message_id ? `auto:${msg.source_auto_message_id}` :
                     msg.rich_card_content_id || null;
    if (msg.content_frozen && cacheKey && richCardCacheRef.current.has(cacheKey)) {
      setRichCardFullContent(richCardCacheRef.current.get(cacheKey)!);
      setLoadingRichCardContent(false);
      return;
    }

    setRichCardFullContent(null);
    setLoadingRichCardContent(true);

    try {
      let html: string | null = null;
      if (msg.content_frozen && msg.rich_card_content_id) {
        html = await fetchRichCardContent(msg.rich_card_content_id);
      } else if (msg.source_template_id) {
        html = await fetchTemplateContentForViewer(msg.source_template_id);
      } else if (msg.source_auto_message_id) {
        html = await fetchAutoMsgContentForViewer(msg.source_auto_message_id);
      } else if (msg.rich_card_content_id) {
        html = await fetchRichCardContent(msg.rich_card_content_id);
      } else if (msg.message_type === 'rich_card') {
        for (let i = 0; i < 2; i++) {
          if (richCardCancelRef.current) return;
          await new Promise(r => setTimeout(r, 150));
          const { data: fresh } = await supabase
            .from('customer_employee_conversations')
            .select('rich_card_content_id, content_frozen, source_template_id, source_auto_message_id')
            .eq('id', msg.id)
            .maybeSingle();
          if (fresh?.content_frozen && fresh.rich_card_content_id) {
            html = await fetchRichCardContent(fresh.rich_card_content_id);
            break;
          }
          if (fresh?.source_template_id) {
            html = await fetchTemplateContentForViewer(fresh.source_template_id);
            break;
          }
          if (fresh?.source_auto_message_id) {
            html = await fetchAutoMsgContentForViewer(fresh.source_auto_message_id);
            break;
          }
          if (fresh?.rich_card_content_id) {
            html = await fetchRichCardContent(fresh.rich_card_content_id);
            break;
          }
        }
      }
      if (!richCardCancelRef.current) {
        setRichCardFullContent(html || msg.message_content);
        setLoadingRichCardContent(false);
      }
    } catch {
      if (!richCardCancelRef.current) {
        setLoadingRichCardContent(false);
      }
    }
  }, [fetchRichCardContent, fetchTemplateContentForViewer, fetchAutoMsgContentForViewer]);
  const [imageZoom, setImageZoom] = useState(1);
  const [imageDrag, setImageDrag] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
  const audioRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const popupTimerRef = useRef<NodeJS.Timeout | null>(null);
  const [customerOnlineStatus, setCustomerOnlineStatus] = useState<Map<string, boolean>>(new Map());
  const onlineCheckIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isInitialLoadRef = useRef<boolean>(false);
  const shouldAutoScrollRef = useRef<boolean>(true);
  const loadOlderMessagesRef = useRef<() => void>();
  const conversationOpenedAtRef = useRef<string>('');
  const selectedCustomerRef = useRef<Customer | null>(null);
  const isOpenRef = useRef<boolean>(false);
  const justSentRef = useRef(false);
  const handledUnreadMessageIdsRef = useRef(new Set<string>());
  const notificationMessageIdsRef = useRef(new Set<string>());
  const stableKeyMapRef = useRef<Map<string, string>>(new Map());
  const conversationLoadPromiseRef = useRef<Promise<void> | null>(null);
  const conversationRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conversationRefreshCustomerIdsRef = useRef(new Set<string>());
  const loadConversationsRef = useRef<((force?: boolean) => Promise<void>) | null>(null);
  const applyIncomingConversationMessageRef = useRef<((message: IncomingMessage, incrementUnread?: boolean) => void) | null>(null);
  const prefetchRichCardRef = useRef<((message: Message | IncomingMessage) => void) | null>(null);
  const scheduleConversationRefreshRef = useRef<((customerId?: string) => void) | null>(null);
  const showMessagePopupRef = useRef<((customer: Customer, message: string) => void) | null>(null);
  const updateOnlineStatusRef = useRef<(() => void) | null>(null);
  const loadMessagesRef = useRef<(() => Promise<void>) | null>(null);
  const loadMessagesFromDBRef = useRef<((shouldMarkRead?: boolean) => Promise<void>) | null>(null);
  const refreshChatDataRef = useRef<(() => void) | null>(null);
  const conversationRefreshQueuedRef = useRef(false);
  const messagesRefreshQueuedRef = useRef(false);
  const realtimeConnectedOnceRef = useRef(false);
  const realtimeRetryCountRef = useRef(0);
  const lastChatRefreshAtRef = useRef(0);
  const ticketNumbersRef = useRef(new Map<string, string>());
  const newMessageLabelRef = useRef(t.customerService.newMessage);
  newMessageLabelRef.current = t.customerService.newMessage;
  prefetchRichCardRef.current = prefetchRichCard;

  // Lock body scroll when chat is open (mobile only - full-screen overlay)
  useEffect(() => {
    isOpenRef.current = isOpen;
  }, [isOpen]);

  useEffect(() => {
    selectedCustomerRef.current = selectedCustomer;
  }, [selectedCustomer]);

  useLayoutEffect(() => {
    if (!isOpen || window.innerWidth >= 1024) return;

    const scrollY = window.scrollY;
    const body = document.body;
    const previousStyles = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflowY: body.style.overflowY,
    };
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.width = '100%';
    body.style.overflowY = 'scroll';

    return () => {
      Object.assign(body.style, previousStyles);
      window.scrollTo({ top: scrollY, left: 0, behavior: 'instant' });
    };
  }, [isOpen]);

  useEffect(() => {
    void loadConversationsRef.current?.();

    onlineCheckIntervalRef.current = setInterval(() => {
      updateOnlineStatusRef.current?.();
    }, 30000);

    return () => {
      if (onlineCheckIntervalRef.current) {
        clearInterval(onlineCheckIntervalRef.current);
      }
      if (conversationRefreshTimerRef.current) {
        clearTimeout(conversationRefreshTimerRef.current);
        conversationRefreshTimerRef.current = null;
      }
      conversationRefreshCustomerIdsRef.current.clear();
    };
  }, [employeeId]);

  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleResubscribe = () => {
      if (disposed || retryTimer) return;
      const delay = Math.min(30000, 2000 * 2 ** Math.min(realtimeRetryCountRef.current, 4));
      realtimeRetryCountRef.current += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (!disposed) setRealtimeRetryKey(key => key + 1);
      }, delay);
    };

    const channel = supabase
      .channel(uniqueRealtimeChannelName(`customer_employee_messages_${employeeId}`))
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'customer_employee_conversations',
        filter: `employee_id=eq.${employeeId}`,
      }, async (payload) => {
        const message = payload.new as IncomingMessage;
        if (!message?.customer_id) return;

        scheduleConversationRefreshRef.current?.(message.customer_id);

        if (message.message_type === 'rich_card') {
          prefetchRichCardRef.current?.(message);
        }

        const isNewUnreadMessage = Boolean(
          message.sender_type === 'customer' &&
          message.is_read === false &&
          message.id &&
          !handledUnreadMessageIdsRef.current.has(message.id),
        );
        if (isNewUnreadMessage && message.id) {
          handledUnreadMessageIdsRef.current.add(message.id);
          if (!(isOpenRef.current && selectedCustomerRef.current?.id === message.customer_id)) {
            setUnreadCount(previous => previous + 1);
          }
        }
        applyIncomingConversationMessageRef.current?.(message, isNewUnreadMessage);

        if (
          !isOpenRef.current &&
          message.sender_type === 'customer' &&
          message.is_read === false &&
          message.id &&
          !notificationMessageIdsRef.current.has(message.id)
        ) {
          notificationMessageIdsRef.current.add(message.id);
          const { data: customerData } = await supabase
            .from('simulated_customers')
            .select('*')
            .eq('id', message.customer_id)
            .maybeSingle();

          if (customerData) {
            const newMessageLabel = newMessageLabelRef.current;
            const rawContent = message.message_content || newMessageLabel;
            const hasEmbeddedImg = /<img\s/i.test(rawContent);
            const messageText = message.message_type === 'image'
              ? '\ud83d\udcf7 Photo'
              : message.message_type === 'rich_card'
              ? (message.title || 'Rich Card')
              : (() => {
                  const text = rawContent
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/(?:div|p)>/gi, '\n')
                    .replace(/<[^>]*>/g, '')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();
                  return text || (hasEmbeddedImg ? '\ud83d\udcf7 Photo' : newMessageLabel);
                })();
            showMessagePopupRef.current?.(customerData as Customer, messageText);
          }
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'customer_employee_conversations',
        filter: `employee_id=eq.${employeeId}`,
      }, (payload) => {
        const message = payload.new as Partial<Message>;
        scheduleConversationRefreshRef.current?.(message.customer_id);
      })
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table: 'customer_employee_conversations',
        filter: `employee_id=eq.${employeeId}`,
      }, (payload) => {
        const oldMessage = payload.old as Partial<Message>;
        const newMessage = payload.new as Partial<Message>;
        scheduleConversationRefreshRef.current?.(oldMessage.customer_id || newMessage.customer_id);
      })
      .subscribe((status) => {
        if (disposed) return;
        if (status === 'SUBSCRIBED') {
          if (retryTimer) {
            clearTimeout(retryTimer);
            retryTimer = null;
          }
          realtimeRetryCountRef.current = 0;
          // Events sent while the channel was down are not replayed, so reload after every reconnect.
          if (realtimeConnectedOnceRef.current) refreshChatDataRef.current?.();
          realtimeConnectedOnceRef.current = true;
          return;
        }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          scheduleResubscribe();
        }
      });

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      void supabase.removeChannel(channel);
    };
  }, [employeeId, realtimeRetryKey]);

  useEffect(() => {
    // Realtime does the work normally; this only catches changes missed while it was down.
    const refreshIfStale = (maxAge: number) => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastChatRefreshAtRef.current < maxAge) return;
      refreshChatDataRef.current?.();
    };
    const refreshTimer = window.setInterval(() => {
      refreshIfStale(isOpenRef.current ? OPEN_CHAT_REFRESH_MS : CLOSED_CHAT_REFRESH_MS);
    }, OPEN_CHAT_REFRESH_MS);
    const catchUp = () => refreshIfStale(CATCH_UP_MIN_GAP_MS);
    document.addEventListener('visibilitychange', catchUp);
    window.addEventListener('online', catchUp);
    return () => {
      window.clearInterval(refreshTimer);
      document.removeEventListener('visibilitychange', catchUp);
      window.removeEventListener('online', catchUp);
    };
  }, []);

  useEffect(() => {
    if (selectedCustomer) {
      isInitialLoadRef.current = true;
      messagesRefreshQueuedRef.current = false;
      shouldAutoScrollRef.current = true;
      conversationOpenedAtRef.current = new Date().toISOString();
      void loadMessagesRef.current?.();
    }
  }, [selectedCustomer]);

  const prevMessageCountRef = useRef(0);

  // Column-reverse layout: scrollTop=0 = bottom (latest messages visible)
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || messages.length === 0) return;

    const handleScroll = () => {
      // Column-reverse containers report 0 at the newest message and negative values above it.
      const distanceFromNewest = Math.abs(container.scrollTop);
      shouldAutoScrollRef.current = distanceFromNewest < 150;
      const maxScroll = container.scrollHeight - container.clientHeight;
      if (maxScroll > 0 && maxScroll - distanceFromNewest < 100) {
        loadOlderMessagesRef.current?.();
      }
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    const hadNewMessage = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;

    if (!isInitialLoadRef.current && shouldAutoScrollRef.current && hadNewMessage) {
      container.scrollTop = 0;
    }

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [messages]);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  useEffect(() => {
    updateOnlineStatusRef.current?.();
  }, [conversations]);

  const scrollToBottom = () => {
    const container = messagesContainerRef.current;
    if (container) {
      container.scrollTop = 0;
    }
  };

  const playNotificationSound = (isSuper: boolean) => {
    const AudioContextConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;
    const audioContext = new AudioContextConstructor();

    const playTone = (frequency: number, startTime: number, duration: number, volume: number) => {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.frequency.value = frequency;

      gainNode.gain.setValueAtTime(volume, startTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

      oscillator.start(startTime);
      oscillator.stop(startTime + duration);
    };

    const now = audioContext.currentTime;

    if (isSuper) {
      playTone(880, now, 0.15, 0.4);
      playTone(1108, now + 0.18, 0.15, 0.4);
      playTone(880, now + 0.36, 0.15, 0.4);
      playTone(1320, now + 0.54, 0.25, 0.45);
    } else {
      playTone(659, now, 0.12, 0.35);
      playTone(880, now + 0.15, 0.12, 0.35);
      playTone(1047, now + 0.30, 0.18, 0.38);
    }
  };

  const startContinuousSound = (isSuper: boolean) => {
    if (playingSound) return;
    setPlayingSound(true);

    const interval = setInterval(() => {
      playNotificationSound(isSuper);
    }, isSuper ? 1500 : 2000);

    if (audioRef.current) {
      clearInterval(audioRef.current);
    }
    audioRef.current = interval;
  };

  const stopContinuousSound = () => {
    setPlayingSound(false);
    if (audioRef.current) {
      clearInterval(audioRef.current);
      audioRef.current = null;
    }
  };

  const showMessagePopup = (customer: Customer, message: string) => {
    console.log('🎯 showMessagePopup called:', { customer: customer.customer_name, message, isSuper: customer.is_super });

    if (popupTimerRef.current) {
      clearTimeout(popupTimerRef.current);
      popupTimerRef.current = null;
    }

    setMessagePopup({
      customer,
      message,
      time: new Date().toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })
    });

    console.log('🔊 Starting continuous sound for:', customer.is_super ? 'SUPER customer' : 'regular customer');
    startContinuousSound(customer.is_super || false);
    console.log('⏰ Popup will persist until clicked');
  };
  showMessagePopupRef.current = showMessagePopup;

  const isCustomerOnline = (customerId: string): boolean => {
    const conv = conversations.find(c => c.customer.id === customerId);
    if (!conv || !conv.last_customer_message_time) return false;

    const lastMessageTime = new Date(conv.last_customer_message_time).getTime();
    const now = Date.now();
    const fiveMinutesInMs = 5 * 60 * 1000;

    return (now - lastMessageTime) < fiveMinutesInMs;
  };

  const updateOnlineStatus = () => {
    const newStatus = new Map<string, boolean>();
    conversations.forEach(conv => {
      newStatus.set(conv.customer.id, isCustomerOnline(conv.customer.id));
    });
    setCustomerOnlineStatus(newStatus);
  };
  updateOnlineStatusRef.current = updateOnlineStatus;

  const renderMessageContent = (msg: Message) => {
    if (msg.message_type === 'image' && !msg.image_url) {
      return (
        <div className="relative overflow-hidden rounded-xl" style={{ width: '280px', height: '200px' }}>
          <div className="absolute inset-0 bg-gray-100 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="w-10 h-10 border-3 border-gray-200 border-t-blue-500 rounded-full animate-spin" />
              <span className="text-xs text-gray-400">{t.customerService.loading}</span>
            </div>
          </div>
        </div>
      );
    }
    if (msg.message_type === 'image' && msg.image_url) {
      const isUploading = uploadingImage && uploadingTempIdRef.current === msg.id;
      return (
        <div className="relative">
          <ChatImage
            src={msg.image_url}
            alt="Shared image"
            onClickImage={isUploading ? () => {} : (url: string) => { setPreviewImage(url); setImageZoom(1); setImageDrag({ x: 0, y: 0 }); }}
          />
          {isUploading && (
            <div className="absolute inset-0 bg-black/25 backdrop-blur-[2px] flex flex-col items-center justify-center rounded-xl z-10">
              <div className="relative w-12 h-12 sm:w-14 sm:h-14">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 44 44">
                  <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="2.5" />
                  <circle
                    cx="22" cy="22" r="18" fill="none" stroke="white"
                    strokeWidth="2.5"
                    strokeDasharray={`${uploadProgress * 1.13}, 113`}
                    strokeLinecap="round"
                    className="drop-shadow-sm"
                    style={{ transition: 'stroke-dasharray 0.15s ease-out' }}
                  />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-white text-[11px] sm:text-xs font-bold drop-shadow-sm">{uploadProgress}%</span>
                </div>
              </div>
              <div className="text-white/70 text-[11px] font-medium mt-1.5">
                {uploadProgress < 20 ? t.customerService.preparing :
                 uploadProgress < 85 ? t.customerService.uploading :
                 uploadProgress < 100 ? t.customerService.processing : ''}
              </div>
            </div>
          )}
        </div>
      );
    }

    if (msg.message_type === 'rating_request') {
      return (
        <div className="my-2 w-[280px] sm:w-[300px]">
          <div className="relative rounded-2xl overflow-hidden shadow-lg shadow-blue-600/30 border border-blue-500/40">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-700"></div>
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_60%)]"></div>
            <div className="relative px-5 py-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 bg-white/20 backdrop-blur-sm rounded-lg shadow-md shadow-blue-900/30">
                    <Star className="w-4 h-4 text-white fill-white" />
                  </div>
                  <span className="text-xs font-bold text-white tracking-wide">{t.customerService.serviceRating}</span>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-white/10 border border-white/20 rounded-full">
                  <div className="w-1.5 h-1.5 bg-blue-200 rounded-full animate-pulse"></div>
                  <span className="text-[11px] text-blue-100 font-semibold">{t.customerService.pending}</span>
                </div>
              </div>
              <div className="flex items-center justify-center gap-2.5 py-2">
                {[1, 2, 3, 4, 5].map((s) => (
                  <Star key={s} className="w-6 h-6 text-white/30 fill-white/10" />
                ))}
              </div>
              <p className="text-center text-[11px] text-blue-100/70 mt-2.5 font-medium">{t.customerService.waitingFeedback}</p>
            </div>
          </div>
        </div>
      );
    }

    if (msg.message_type === 'rating_result' && msg.rating_data) {
      const { rating = 0, comment } = msg.rating_data;
      return (
        <div className="my-2 w-[280px] sm:w-[300px]">
          <div className="relative rounded-2xl overflow-hidden shadow-lg shadow-blue-600/30 border border-blue-500/40">
            <div className="absolute inset-0 bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-700"></div>
            <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(255,255,255,0.08),transparent_60%)]"></div>
            <div className="relative px-5 py-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 bg-white/20 backdrop-blur-sm rounded-lg shadow-md shadow-blue-900/30">
                    <Star className="w-4 h-4 text-white fill-white" />
                  </div>
                  <span className="text-xs font-bold text-white tracking-wide">{t.customerService.serviceRating}</span>
                </div>
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-500/20 border border-emerald-400/30 rounded-full">
                  <div className="w-1.5 h-1.5 bg-emerald-300 rounded-full"></div>
                  <span className="text-[11px] text-emerald-200 font-semibold">{t.customerService.completed}</span>
                </div>
              </div>
              <div className="flex items-center justify-between py-2">
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Star
                      key={star}
                      className={`w-6 h-6 transition-all ${
                        star <= rating
                          ? 'text-amber-300 fill-amber-300 drop-shadow-[0_0_6px_rgba(252,211,77,0.7)]'
                          : 'text-white/25 fill-white/10'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-2xl font-black text-white" style={{ textShadow: '0 2px 6px rgba(0,0,0,0.3)' }}>{rating}.0</span>
              </div>
              {comment && (
                <div className="mt-3 pt-3 border-t border-white/10">
                  <p className="text-xs text-blue-100/80 leading-relaxed italic">"{comment}"</p>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (msg.message_type === 'rich_card') {
      return (
        <div className="my-1.5 w-[240px]">
          <button
            type="button"
            onClick={() => openRichCardViewer(msg)}
            onMouseEnter={() => prefetchRichCard(msg)}
            onTouchStart={() => prefetchRichCard(msg)}
            className="w-full text-left rounded-2xl overflow-hidden transition-all duration-250 group shadow-[0_2px_12px_rgba(37,99,246,0.15)] hover:shadow-[0_8px_24px_rgba(37,99,246,0.22)] hover:scale-[1.015]"
          >
            <div className="relative bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 px-4 pt-4 pb-3.5">
              <div className="absolute top-0 right-0 w-20 h-20 bg-white/[0.07] rounded-full -translate-y-8 translate-x-8" />
              <div className="absolute bottom-0 left-0 w-14 h-14 bg-white/[0.05] rounded-full translate-y-6 -translate-x-6" />
              <div className="relative flex items-start gap-2.5">
                <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center">
                  <Megaphone className="w-3.5 h-3.5 text-white" />
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <span className="text-[12.5px] font-semibold text-white block truncate leading-snug">{msg.title || 'View details'}</span>
                  {msg.subtitle && <span className="text-[11px] text-blue-100/80 block truncate mt-1 leading-snug">{msg.subtitle}</span>}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between px-4 py-2 bg-white border-t border-blue-100">
              <span className="text-[10.5px] text-blue-600 font-medium">{t.customerService.richCardNotice || 'View details'}</span>
              <ChevronRight className="w-3.5 h-3.5 text-blue-400 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all duration-200" />
            </div>
          </button>
        </div>
      );
    }

    if (msg.message_type === 'tip' && msg.rating_data) {
      const tipAmt = msg.rating_data?.tip_amount || 0;
      const tipText = tipAmt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const tipComment = msg.rating_data?.comment?.trim();
      const amountSize = tipText.length > 9 ? 'tip-card-amount-long' : '';
      return (
        <div className="tip-card my-1.5">
          <div className="tip-card-frame">
            <div className="tip-card-body">
              <span className="tip-card-rays" aria-hidden="true" />
              <span className="tip-card-sheen" aria-hidden="true" />
              <span className="tip-card-star tip-card-star-1" aria-hidden="true" />
              <span className="tip-card-star tip-card-star-2" aria-hidden="true" />
              <span className="tip-card-star tip-card-star-3" aria-hidden="true" />
              <span className="tip-card-star tip-card-star-4" aria-hidden="true" />

              <div className="tip-card-main">
                <div className="flex items-center justify-center gap-2">
                  <span className="tip-card-coin">
                    <Gift className="h-[15px] w-[15px]" strokeWidth={2.3} />
                  </span>
                  <span className="tip-card-label">{t.customerService.tip}</span>
                </div>

                <div className={`tip-card-amount ${amountSize}`}>
                  <span className="tip-card-currency">$</span>
                  <span className="tabular-nums">{tipText}</span>
                </div>

                {tipComment && (
                  <p className="tip-card-comment" style={{ overflowWrap: 'anywhere' }}>
                    “{tipComment}”
                  </p>
                )}
              </div>

              <div className="tip-card-divider" aria-hidden="true" />

              <div className="tip-card-footer">
                <span className="tip-card-check">
                  <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 6.2 5 8.5l4.5-5" /></svg>
                </span>
                <span className="truncate">{t.customerService.addedToWallet}</span>
              </div>
            </div>
          </div>
        </div>
      );
    }

    const content = msg.message_content;
    const hasHtml = /<[a-z][\s\S]*>/i.test(content);
    const imageOnlyUrl = hasHtml ? extractImageOnlyUrl(content) : null;
    if (imageOnlyUrl) {
      return (
        <ChatImage
          src={imageOnlyUrl}
          alt="Shared image"
          onClickImage={(url: string) => { setPreviewImage(url); setImageZoom(1); setImageDrag({ x: 0, y: 0 }); }}
        />
      );
    }
    if (hasHtml) {
      const sanitized = sanitizeChatMessage(content);
      const hasImgTag = /<img\s/i.test(content);
      return (
        <div
          className={`text-sm leading-relaxed break-words chat-rich-content${hasImgTag ? ' [&_img]:cursor-pointer [&_img]:rounded-xl [&_img]:max-w-[280px] [&_img]:hover:opacity-90 [&_img]:transition-opacity [&_img]:shadow-lg' : ''}`}
          style={{ overflowWrap: 'anywhere' }}
          dangerouslySetInnerHTML={{ __html: sanitized }}
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.tagName === 'IMG') {
              e.stopPropagation();
              e.preventDefault();
              const imgSrc = (target as HTMLImageElement).src;
              if (imgSrc) {
                setPreviewImage(imgSrc);
                setImageZoom(1);
                setImageDrag({ x: 0, y: 0 });
              }
            }
          }}
        />
      );
    }
    return <div className="text-sm leading-relaxed whitespace-pre-wrap break-words" style={{ overflowWrap: 'anywhere' }}>{content}</div>;
  };

  const loadConversations = (force = false) => {
    const pending = conversationLoadPromiseRef.current;
    if (pending) {
      // A forced refresh asked for during a load must still run, or the newest change is lost.
      if (force) conversationRefreshQueuedRef.current = true;
      return pending;
    }

    const requestId = ++conversationLoadRequestRef.current;
    const request = (async () => {
    const cached = force ? null : employeeConversationCache.get(employeeId);
    if (cached) {
      preloadConversationAvatars(cached.conversations);
      setConversations(cached.conversations);
      setUnreadCount(cached.unreadCount);
      setLoadingConversations(false);
    } else {
      setLoadingConversations(true);
    }

    try {
      if (!employeeAdminIdRef.current) {
        const { data: empData, error: empError } = await supabase.from('users').select('created_by').eq('id', employeeId).maybeSingle();
        if (empError) throw empError;
        if (empData?.created_by) employeeAdminIdRef.current = empData.created_by;
      }
      const employeeAdminId = employeeAdminIdRef.current;

      // Without the employee's admin the always-visible query would include other groups' customers.
      const alwaysVisibleRequest = employeeAdminId
        ? supabase
          .from('simulated_customers')
          .select('id, customer_name, customer_id, customer_avatar, is_super, super_customer_title, badge_type, custom_avatar_url, vip_label, employee_pin_top, employee_always_visible, target_employee_id, target_employee_ids, source_type')
          .eq('employee_always_visible', true)
          .eq('is_active', true)
          .eq('admin_id', employeeAdminId)
        : Promise.resolve({ data: [] as never[], error: null });

      const [summaryResult, alwaysVisibleResult] = await Promise.all([
        supabase.rpc('get_employee_conversation_summaries', { p_employee_id: employeeId }),
        alwaysVisibleRequest,
      ]);

      if (summaryResult.error) throw summaryResult.error;
      if (alwaysVisibleResult.error) throw alwaysVisibleResult.error;

      const unknownCustomerIds = (summaryResult.data || [])
        .map(row => row.customer_id)
        .filter(id => !customerSourceTypes.has(id));
      for (let index = 0; index < unknownCustomerIds.length; index += SOURCE_LOOKUP_CHUNK_SIZE) {
        const { data: sourceRows, error: sourceError } = await supabase
          .from('simulated_customers')
          .select('id, source_type')
          .in('id', unknownCustomerIds.slice(index, index + SOURCE_LOOKUP_CHUNK_SIZE));
        if (sourceError) throw sourceError;
        sourceRows?.forEach(row => customerSourceTypes.set(row.id, row.source_type));
      }

      const grouped = new Map<string, CustomerConversation>();
      let totalUnread = 0;

      for (const row of summaryResult.data || []) {
        const sourceType = customerSourceTypes.get(row.customer_id);
        if (sourceType !== 'aaa_service' && sourceType !== 'ccc_service') continue;
        const unread = Number(row.unread_count) || 0;
        totalUnread += unread;
        grouped.set(row.customer_id, {
          customer: {
            id: row.customer_id,
            customer_name: row.customer_name,
            customer_id: row.customer_display_id,
            customer_avatar: row.customer_avatar,
            is_super: row.is_super,
            super_customer_title: row.super_customer_title,
            badge_type: row.badge_type as Customer['badge_type'],
            custom_avatar_url: row.custom_avatar_url || undefined,
            vip_label: row.vip_label || undefined,
            employee_pin_top: row.employee_pin_top ?? false,
            employee_always_visible: row.employee_always_visible ?? false,
            target_employee_id: row.target_employee_id,
            target_employee_ids: row.target_employee_ids,
            source_type: sourceType,
          },
          unread_count: unread,
          last_message: row.last_message_type === 'image' ? '\ud83d\udcf7 Photo' : (row.last_message || ''),
          last_message_time: row.last_message_time || new Date(0).toISOString(),
          last_customer_message_time: row.last_customer_message_time || undefined,
        });
      }

      // Load always-visible customers that may not have messages yet
      for (const customer of alwaysVisibleResult.data || []) {
        const sourceType = customer.source_type === 'aaa_service' || customer.source_type === 'ccc_service'
          ? customer.source_type
          : null;
        const ids = customer.target_employee_ids;
        if (!sourceType || (ids && ids.length > 0 && !ids.includes(employeeId))) continue;
        if (grouped.has(customer.id)) continue;
        grouped.set(customer.id, {
          customer: {
            id: customer.id,
            customer_name: customer.customer_name,
            customer_id: customer.customer_id,
            customer_avatar: customer.customer_avatar,
            is_super: customer.is_super,
            super_customer_title: customer.super_customer_title,
            badge_type: customer.badge_type as Customer['badge_type'],
            custom_avatar_url: customer.custom_avatar_url || undefined,
            vip_label: customer.vip_label || undefined,
            employee_pin_top: customer.employee_pin_top ?? false,
            employee_always_visible: customer.employee_always_visible ?? false,
            target_employee_id: customer.target_employee_id,
            target_employee_ids: customer.target_employee_ids,
            source_type: sourceType,
          },
          unread_count: 0,
          last_message: '',
          last_message_time: new Date(0).toISOString(),
        });
      }

      let conversationList = Array.from(grouped.values());

      // Filter out customers targeted to a different employee
      conversationList = conversationList.filter(conv => {
        const ids = conv.customer.target_employee_ids;
        return !ids || ids.length === 0 || ids.includes(employeeId);
      });

      conversationList.sort((a, b) => {
        // Pinned customers first
        const aPinned = a.customer.employee_pin_top ? 1 : 0;
        const bPinned = b.customer.employee_pin_top ? 1 : 0;
        if (bPinned !== aPinned) return bPinned - aPinned;
        if (b.unread_count !== a.unread_count) return b.unread_count - a.unread_count;
        return new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime();
      });

      const snapshot = {
        conversations: conversationList,
        unreadCount: totalUnread,
      };
      employeeConversationCache.set(employeeId, snapshot);
      lastChatRefreshAtRef.current = Date.now();
      if (requestId !== conversationLoadRequestRef.current) return;

      setConversationsError(false);
      preloadConversationAvatars(snapshot.conversations);
      setConversations(snapshot.conversations);
      setUnreadCount(snapshot.unreadCount);
      snapshot.conversations
        .slice(0, 6)
        .forEach(conversation => { void prefetchMessages(conversation.customer.id); });

      if (selectedCustomerRef.current) {
        const stillExists = snapshot.conversations.some(
          conversation => conversation.customer.id === selectedCustomerRef.current?.id
        );
        if (!stillExists) {
          setSelectedCustomer(null);
          setMessages([]);
          setShowConversationList(true);
        }
      }
    } catch (error) {
      if (requestId === conversationLoadRequestRef.current) {
        console.error('Error loading conversations:', error);
        setConversationsError(true);
      }
      } finally {
        if (requestId === conversationLoadRequestRef.current) {
          setLoadingConversations(false);
        }
      }
    })();

    conversationLoadPromiseRef.current = request;
    const releaseRequest = () => {
      if (conversationLoadPromiseRef.current !== request) return;
      conversationLoadPromiseRef.current = null;
      if (conversationRefreshQueuedRef.current) {
        conversationRefreshQueuedRef.current = false;
        void loadConversationsRef.current?.(true);
      }
    };
    request.then(releaseRequest, releaseRequest);
    return request;
  };
  loadConversationsRef.current = loadConversations;

  const applyIncomingConversationMessage = (message: IncomingMessage, incrementUnread = false) => {
    const customerId = message?.customer_id;
    if (!customerId) return;

    const shouldIncreaseUnread = incrementUnread &&
      !(isOpenRef.current && selectedCustomerRef.current?.id === customerId);

    const updateConversation = (conversation: CustomerConversation): CustomerConversation => ({
      ...conversation,
      unread_count: shouldIncreaseUnread
        ? conversation.unread_count + 1
        : conversation.unread_count,
      last_message: message.message_type === 'image'
        ? '\ud83d\udcf7 Photo'
        : message.message_content || conversation.last_message,
      last_message_time: message.created_at || conversation.last_message_time,
      last_customer_message_time: message.sender_type === 'customer'
        ? message.created_at || conversation.last_customer_message_time
        : conversation.last_customer_message_time,
    });

    const cached = employeeConversationCache.get(employeeId);
    if (cached) {
      const cachedIndex = cached.conversations.findIndex(
        conversation => conversation.customer.id === customerId,
      );
      if (cachedIndex >= 0) {
        const cachedConversations = [...cached.conversations];
        cachedConversations[cachedIndex] = updateConversation(cachedConversations[cachedIndex]);
        employeeConversationCache.set(employeeId, {
          conversations: cachedConversations,
          unreadCount: cached.unreadCount + (shouldIncreaseUnread ? 1 : 0),
        });
      }
    }

    setConversations(previous => {
      const index = previous.findIndex(
        conversation => conversation.customer.id === customerId,
      );
      if (index < 0) return previous;

      const next = [...previous];
      next[index] = updateConversation(next[index]);
      return next;
    });
  };
  applyIncomingConversationMessageRef.current = applyIncomingConversationMessage;

  const scheduleConversationRefresh = (customerId?: string) => {
    if (customerId) {
      conversationRefreshCustomerIdsRef.current.add(customerId);
    }

    if (conversationRefreshTimerRef.current) {
      clearTimeout(conversationRefreshTimerRef.current);
    }

    conversationRefreshTimerRef.current = setTimeout(() => {
      conversationRefreshTimerRef.current = null;
      const customerIds = conversationRefreshCustomerIdsRef.current;
      conversationRefreshCustomerIdsRef.current = new Set<string>();
      const selectedId = selectedCustomerRef.current?.id;

      void loadConversationsRef.current?.(true);
      if (selectedId && customerIds.has(selectedId)) {
        requestMessagesRefresh();
      }
    }, 120);
  };
  scheduleConversationRefreshRef.current = scheduleConversationRefresh;

  // A change that lands while a conversation is still opening is replayed once that load ends.
  const requestMessagesRefresh = () => {
    // A closed panel reloads the open conversation when it is shown again.
    if (!selectedCustomerRef.current || !isOpenRef.current) return;
    if (isInitialLoadRef.current) {
      messagesRefreshQueuedRef.current = true;
      return;
    }
    void loadMessagesFromDBRef.current?.(isOpenRef.current);
  };

  const refreshChatData = () => {
    void loadConversationsRef.current?.(true);
    requestMessagesRefresh();
  };
  refreshChatDataRef.current = refreshChatData;

  useEffect(() => {
    if (!isOpen) return;
    void loadConversationsRef.current?.();
    if (selectedCustomerRef.current && !isInitialLoadRef.current) {
      void loadMessagesFromDBRef.current?.(true);
    }
  }, [isOpen]);

  useEffect(() => { loadOlderMessagesRef.current = loadOlderMessages; });

  const prefetchMessages = async (customerId: string) => {
    if (messagesCache.current.has(customerId)) return;

    const pendingRequest = messagePrefetchRequestsRef.current.get(customerId);
    if (pendingRequest) {
      await pendingRequest;
      return;
    }

    const request = (async () => {
      const { data, error } = await supabase
        .from('customer_employee_conversations')
        .select('*')
        .eq('customer_id', customerId)
        .eq('employee_id', employeeId)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);

      if (error || !data) return;

      const sorted = data.reverse();
      messagesCache.current.set(customerId, sorted);
      preloadChatImages(sorted);
      for (const message of sorted) {
        if (message.message_type === 'rich_card') {
          prefetchRichCardRef.current?.(message);
        }
      }
    })();

    messagePrefetchRequestsRef.current.set(customerId, request);
    request.then(
      () => messagePrefetchRequestsRef.current.delete(customerId),
      () => messagePrefetchRequestsRef.current.delete(customerId),
    );
    try {
      await request;
    } catch {
      // Background prefetch is optional; the foreground load will retry when opened.
    }
  };

  const loadMessages = async () => {
    const currentCustomer = selectedCustomerRef.current;
    if (!currentCustomer) return;

    const requestId = ++messagesLoadRequestRef.current;
    setMessagesError(false);

    try {
      const cachedMessages = messagesCache.current.get(currentCustomer.id);
      if (cachedMessages) {
        setMessages(cachedMessages);
        preloadChatImages(cachedMessages);
        setHasMoreMessages(cachedMessages.length >= MESSAGE_PAGE_SIZE);
        setLoadingMessages(false);
      } else {
        setLoadingMessages(true);
        const pendingPrefetch = messagePrefetchRequestsRef.current.get(currentCustomer.id);
        if (pendingPrefetch) {
          await pendingPrefetch;
          if (
            requestId === messagesLoadRequestRef.current &&
            selectedCustomerRef.current?.id === currentCustomer.id
          ) {
            const prefetchedMessages = messagesCache.current.get(currentCustomer.id);
            if (prefetchedMessages) {
              setMessages(prefetchedMessages);
              preloadChatImages(prefetchedMessages);
              setHasMoreMessages(prefetchedMessages.length >= MESSAGE_PAGE_SIZE);
              setLoadingMessages(false);
            }
          }
        }
      }

      await loadMessagesFromDB(true, requestId);
    } catch (error) {
      console.error('Error loading messages:', error);
    } finally {
      if (requestId === messagesLoadRequestRef.current) {
        setLoadingMessages(false);
        isInitialLoadRef.current = false;
        if (messagesRefreshQueuedRef.current) {
          messagesRefreshQueuedRef.current = false;
          void loadMessagesFromDBRef.current?.(isOpenRef.current);
        }
      }
    }
  };
  loadMessagesRef.current = loadMessages;

  const loadOlderMessages = async () => {
    const currentCustomer = selectedCustomerRef.current;
    if (!currentCustomer || loadingOlderMessages || !hasMoreMessages) return;
    if (messages.length === 0) return;

    setLoadingOlderMessages(true);
    try {
      const oldestTime = messages[0]?.created_at;
      const { data, error } = await supabase
        .from('customer_employee_conversations')
        .select('*')
        .eq('customer_id', currentCustomer.id)
        .eq('employee_id', employeeId)
        .lt('created_at', oldestTime)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);

      if (error) throw error;
      if (data && data.length > 0) {
        const olderMessages = data.reverse();
        preloadChatImages(olderMessages);
        setMessages(prev => [...olderMessages, ...prev]);
        const cached = messagesCache.current.get(currentCustomer.id);
        if (cached) {
          messagesCache.current.set(currentCustomer.id, [...olderMessages, ...cached]);
        }
        setHasMoreMessages(data.length >= MESSAGE_PAGE_SIZE);
        for (const m of olderMessages) {
          if (m.message_type === 'rich_card') {
            prefetchRichCard(m);
          }
        }
      } else {
        setHasMoreMessages(false);
      }
    } catch (error) {
      console.error('Error loading older messages:', error);
    } finally {
      setLoadingOlderMessages(false);
    }
  };

  const loadMessagesFromDB = async (
    shouldMarkRead = true,
    requestId = ++messagesLoadRequestRef.current,
  ) => {
    const currentCustomer = selectedCustomerRef.current;
    if (!currentCustomer) return;
    const customerId = currentCustomer.id;

    try {
      const cachedTicket = ticketNumbersRef.current.get(customerId);
      const sessionRequest = cachedTicket
        ? null
        : supabase.rpc('get_or_create_service_session', {
          p_customer_id: currentCustomer.id,
          p_employee_id: employeeId,
        });
      const messagesResult = await supabase
        .from('customer_employee_conversations')
        .select('*')
        .eq('customer_id', currentCustomer.id)
        .eq('employee_id', employeeId)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);

      if (messagesResult.error) throw messagesResult.error;
      if (
        requestId !== messagesLoadRequestRef.current ||
        selectedCustomerRef.current?.id !== customerId
      ) {
        return;
      }

      const latest = (messagesResult.data || []).reverse();
      messagesCache.current.set(customerId, latest);
      preloadChatImages(latest);
      setHasMoreMessages(latest.length >= MESSAGE_PAGE_SIZE);
      setMessagesError(false);
      // Compare with what is on screen, not the cache, so a filled cache cannot leave the view empty.
      setMessages(previous => mergeLatestMessages(previous, latest, customerId));

      for (const m of latest) {
        if (m.message_type === 'rich_card') {
          prefetchRichCard(m);
        }
      }

      const listedUnread = conversations.find(c => c.customer.id === customerId)?.unread_count || 0;
      const hasUnread = listedUnread > 0 || latest.some(m => m.sender_type === 'customer' && !m.is_read);
      if (shouldMarkRead && hasUnread && latest.length > 0) {
        void markMessagesAsRead(customerId, latest[latest.length - 1].created_at);
      }

      if (cachedTicket) {
        setServiceTicketNumber(cachedTicket);
        return;
      }
      void sessionRequest?.then(({ data: sessionData, error: sessionError }) => {
        if (
          sessionError ||
          !sessionData ||
          sessionData.length === 0 ||
          requestId !== messagesLoadRequestRef.current ||
          selectedCustomerRef.current?.id !== customerId
        ) {
          return;
        }
        ticketNumbersRef.current.set(customerId, sessionData[0].service_ticket_number);
        setServiceTicketNumber(sessionData[0].service_ticket_number);
      }, () => {
        // The ticket number is secondary to displaying the chat messages.
      });
    } catch (error) {
      console.error('Error loading messages from DB:', error);
      if (requestId === messagesLoadRequestRef.current && selectedCustomerRef.current?.id === customerId) {
        setMessagesError(true);
      }
    } finally {
      if (requestId === messagesLoadRequestRef.current) {
        setLoadingMessages(false);
      }
    }
  };
  loadMessagesFromDBRef.current = loadMessagesFromDB;

  // Read receipts are shown to admins, so only messages already on screen in a visible page count.
  const markMessagesAsRead = async (customerId: string, shownUpTo: string | null) => {
    if (
      !shownUpTo ||
      !isOpenRef.current ||
      selectedCustomerRef.current?.id !== customerId ||
      document.visibilityState !== 'visible'
    ) return;

    try {
      const { error } = await supabase
        .from('customer_employee_conversations')
        .update({ is_read: true, read_at: new Date().toISOString() })
        .eq('customer_id', customerId)
        .eq('employee_id', employeeId)
        .eq('sender_type', 'customer')
        .eq('is_read', false)
        .lte('created_at', shownUpTo);
      if (error) throw error;

      void loadConversationsRef.current?.(true);
    } catch (error) {
      console.error('Error marking messages as read:', error);
    }
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedCustomer) return;

    if (!file.type.startsWith('image/')) {
      setNotification({ type: 'error', text: t.customerService.selectImageError });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setNotification({ type: 'error', text: t.customerService.imageSizeError });
      return;
    }

    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = (event) => resolve(event.target?.result as string);
      reader.readAsDataURL(file);
    });

    const tempId = `temp-${Date.now()}`;
    const tempMessage: Message = {
      id: tempId,
      customer_id: selectedCustomer.id,
      employee_id: employeeId,
      sender_type: 'employee',
      message_content: '[Image]',
      message_type: 'image',
      image_url: dataUrl,
      created_at: new Date().toISOString(),
      is_read: false,
      rating_value: null,
    };

    setMessages(prev => [...prev, tempMessage]);
    scrollToBottom();
    uploadingTempIdRef.current = tempId;
    setUploadingImage(true);
    setUploadProgress(0);

    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${selectedCustomer.id}_${employeeId}_${Date.now()}.${fileExt}`;
      const filePath = `${fileName}`;

      await uploadStorageObjectWithProgress({
        bucket: 'chat-images',
        path: filePath,
        body: file,
        onProgress: percentage => setUploadProgress(percentage),
      });

      const { data: { publicUrl } } = supabase.storage
        .from('chat-images')
        .getPublicUrl(filePath);

      setUploadProgress(100);

      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, image_url: publicUrl } : m));
      uploadingTempIdRef.current = null;
      setUploadingImage(false);
      setUploadProgress(0);

      justSentRef.current = true;
      setTimeout(() => { justSentRef.current = false; }, 3000);
      supabase
        .from('customer_employee_conversations')
        .insert({
          customer_id: selectedCustomer.id,
          employee_id: employeeId,
          sender_type: 'employee',
          message_content: '[Image]',
          message_type: 'image',
          image_url: publicUrl,
          is_read: false,
          source_type: selectedCustomer.source_type,
        })
        .select()
        .single()
        .then(({ data: newMsg, error: insertError }) => {
          if (insertError) {
            console.error('Failed to save message:', insertError);
            setMessages(prev => prev.filter(m => m.id !== tempId));
            setNotification({ type: 'error', text: t.customerService.saveImageError });
          } else if (newMsg) {
            stableKeyMapRef.current.set(newMsg.id, tempId);
            setMessages(prev => replaceSentMessage(prev, tempId, newMsg as Message));
          }
        }, (error: unknown) => {
          console.error('Failed to save image message:', error);
          setMessages(prev => prev.filter(m => m.id !== tempId));
          setNotification({ type: 'error', text: t.customerService.saveImageError });
        });
    } catch (error: unknown) {
      setNotification({ type: 'error', text: error instanceof Error ? error.message : t.customerService.uploadError });
      setMessages(prev => prev.filter(m => m.id !== tempId));
      uploadingTempIdRef.current = null;
      setUploadingImage(false);
      setUploadProgress(0);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomer || !messageInput.trim()) return;

    const messageContent = messageInput.trim();
    setMessageInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    // Optimistically add message to UI
    const tempMessage: Message = {
      id: `temp-${Date.now()}`,
      customer_id: selectedCustomer.id,
      employee_id: employeeId,
      sender_type: 'employee',
      message_content: messageContent,
      message_type: 'text',
      is_read: false,
      created_at: new Date().toISOString(),
    };

    setMessages(prev => [...prev, tempMessage]);

    scrollToBottom();
    justSentRef.current = true;
    setTimeout(() => { justSentRef.current = false; }, 3000);

    try {
      const { data: newMsg, error } = await supabase
        .from('customer_employee_conversations')
        .insert({
          customer_id: selectedCustomer.id,
          employee_id: employeeId,
          sender_type: 'employee',
          message_content: messageContent,
          message_type: 'text',
          is_read: false,
          source_type: selectedCustomer.source_type,
        })
        .select()
        .single();

      if (error) {
        setMessages(prev => prev.filter(m => m.id !== tempMessage.id));
        throw error;
      }

      if (newMsg) {
        stableKeyMapRef.current.set(newMsg.id, tempMessage.id);
        setMessages(prev => replaceSentMessage(prev, tempMessage.id, newMsg as Message));
        const cached = messagesCache.current.get(selectedCustomer.id);
        if (cached) {
          messagesCache.current.set(selectedCustomer.id, cached.map(m => m.id === tempMessage.id ? newMsg : m));
        }
      }
    } catch (error) {
      console.error('Error sending message:', error);
      setMessageInput(messageContent);
      setNotification({ type: 'error', text: t.customerService.sendError });
    }
  };

  const handleRequestRating = async () => {
    if (!selectedCustomer) return;

    // Optimistically add rating request to UI
    const tempMessage: Message = {
      id: `temp-rating-${Date.now()}`,
      customer_id: selectedCustomer.id,
      employee_id: employeeId,
      sender_type: 'employee',
      message_content: 'Rating request',
      message_type: 'rating_request',
      rating_data: {
        employee_id: employeeId,
        status: 'pending'
      },
      is_read: false,
      created_at: new Date().toISOString(),
    };

    setMessages(prev => [...prev, tempMessage]);

    scrollToBottom();
    justSentRef.current = true;
    setTimeout(() => { justSentRef.current = false; }, 3000);

    try {
      const { data: newMsg, error } = await supabase
        .from('customer_employee_conversations')
        .insert({
          customer_id: selectedCustomer.id,
          employee_id: employeeId,
          sender_type: 'employee',
          message_type: 'rating_request',
          message_content: 'Rating request',
          rating_data: {
            employee_id: employeeId,
            status: 'pending'
          },
          is_read: false,
          source_type: selectedCustomer.source_type,
        })
        .select()
        .single();

      if (error) {
        setMessages(prev => prev.filter(m => m.id !== tempMessage.id));
        throw error;
      }

      setNotification({ type: 'success', text: t.customerService.ratingRequestSent });
      if (newMsg) {
        stableKeyMapRef.current.set(newMsg.id, tempMessage.id);
        setMessages(prev => replaceSentMessage(prev, tempMessage.id, newMsg as Message));
        const cached = messagesCache.current.get(selectedCustomer.id);
        if (cached) {
          messagesCache.current.set(selectedCustomer.id, cached.map(m => m.id === tempMessage.id ? newMsg : m));
        }
      }
    } catch (error: unknown) {
      setNotification({ type: 'error', text: error instanceof Error ? error.message : t.customerService.ratingRequestError });
    }
  };

  const handleSelectConversation = (customer: Customer) => {
    if (conversationListRef.current) {
      conversationListScrollRef.current = conversationListRef.current.scrollTop;
    }
    void prefetchMessages(customer.id);
    setMessagesError(false);
    setServiceTicketNumber(ticketNumbersRef.current.get(customer.id) || '');
    const cachedMessages = messagesCache.current.get(customer.id);
    if (cachedMessages) {
      setMessages(cachedMessages);
      setLoadingMessages(false);
    } else {
      setMessages([]);
      setLoadingMessages(true);
    }
    setSelectedCustomer(customer);
    setShowConversationList(false);
  };

  const handleBackToList = () => {
    messagesLoadRequestRef.current += 1;
    skipListAnimationRef.current = true;
    setShowConversationList(true);
    setSelectedCustomer(null);
    setMessages([]);
    setMessagesError(false);
    setLoadingMessages(false);
    requestAnimationFrame(() => {
      if (conversationListRef.current) {
        conversationListRef.current.scrollTop = conversationListScrollRef.current;
      }
    });
  };

  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return t.customerService.justNow;
    if (diffInSeconds < 3600) return t.customerService.minsAgo.replace('{n}', String(Math.floor(diffInSeconds / 60)));
    if (diffInSeconds < 86400) return t.customerService.hoursAgo.replace('{n}', String(Math.floor(diffInSeconds / 3600)));

    return date.toLocaleDateString(dateLocale, { month: 'short', day: 'numeric' });
  };

  return (
    <>
      <style>{`
        .chat-loader { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; pointer-events: none; animation: chat-loader-in .3s ease-out both; }
        .chat-loader__stage { position: relative; width: 116px; height: 112px; }
        .chat-loader__halo { position: absolute; left: 50%; top: 50%; width: 132px; height: 132px; margin: -66px 0 0 -66px; border-radius: 9999px; background: radial-gradient(circle, var(--cl-glow) 0%, transparent 70%); animation: chat-loader-breathe 2.4s ease-in-out infinite; }
        .chat-loader__ring { position: absolute; left: 50%; top: 50%; width: 112px; height: 112px; margin: -56px 0 0 -56px; border-radius: 9999px; background: conic-gradient(from 0deg, transparent 0deg, var(--cl-ring) 120deg, transparent 240deg); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px)); mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px)); animation: chat-loader-spin 2.2s linear infinite; }
        .chat-loader__bubble { position: absolute; display: flex; align-items: center; justify-content: center; gap: 5px; border-radius: 16px; }
        .chat-loader__bubble--back { right: 18px; top: 26px; width: 44px; height: 30px; border-bottom-right-radius: 5px; background: var(--cl-back); box-shadow: 0 6px 14px -8px var(--cl-shadow); animation: chat-loader-float 2.4s ease-in-out .3s infinite; }
        .chat-loader__bubble--front { left: 16px; top: 48px; width: 62px; height: 38px; border-bottom-left-radius: 5px; background: var(--cl-front); box-shadow: 0 10px 22px -10px var(--cl-shadow), inset 0 1px 0 rgba(255,255,255,.35); animation: chat-loader-float 2.4s ease-in-out infinite; }
        .chat-loader__bubble--front i { width: 6px; height: 6px; border-radius: 9999px; background: #fff; animation: chat-loader-dot 1.2s ease-in-out infinite; }
        .chat-loader__bubble--front i:nth-child(2) { animation-delay: .15s; }
        .chat-loader__bubble--front i:nth-child(3) { animation-delay: .3s; }
        .chat-loader__label { font-size: 13px; font-weight: 600; letter-spacing: .02em; color: var(--cl-text); }
        .chat-loader--blue { --cl-glow: rgba(96,165,250,.28); --cl-ring: rgba(59,130,246,.75); --cl-front: linear-gradient(135deg,#3b82f6,#2563eb); --cl-back: linear-gradient(135deg,#ffffff,#e0ecff); --cl-shadow: rgba(37,99,235,.55); --cl-text: #64748b; }
        .chat-loader--gold { --cl-glow: rgba(251,191,36,.3); --cl-ring: rgba(245,158,11,.8); --cl-front: linear-gradient(135deg,#f59e0b,#d97706); --cl-back: linear-gradient(135deg,#ffffff,#fef3c7); --cl-shadow: rgba(217,119,6,.55); --cl-text: #92400e; }
        @keyframes chat-loader-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes chat-loader-spin { to { transform: rotate(360deg); } }
        @keyframes chat-loader-breathe { 0%, 100% { transform: scale(.9); opacity: .7; } 50% { transform: scale(1.05); opacity: 1; } }
        @keyframes chat-loader-float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @keyframes chat-loader-dot { 0%, 60%, 100% { transform: translateY(0); opacity: .55; } 30% { transform: translateY(-4px); opacity: 1; } }
        @media (prefers-reduced-motion: reduce) {
          .chat-loader, .chat-loader * { animation: none !important; }
        }
        @keyframes progress-pulse {
          0%, 100% {
            opacity: 0.6;
          }
          50% {
            opacity: 1;
          }
        }

        @keyframes shimmer-progress {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(100%);
          }
        }

        @keyframes shimmer {
          0% {
            background-position: -200% 0;
          }
          100% {
            background-position: 200% 0;
          }
        }

        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }

        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes slideInRight {
          from {
            opacity: 0;
            transform: translateX(20px);
          }
          to {
            opacity: 1;
            transform: translateX(0);
          }
        }

        /* Blockchain & Tech Animations */
        @keyframes spin-slow {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }

        @keyframes spin-reverse-slow {
          from {
            transform: rotate(360deg);
          }
          to {
            transform: rotate(0deg);
          }
        }

        @keyframes pulse-glow {
          0%, 100% {
            opacity: 0.3;
            filter: drop-shadow(0 0 2px currentColor);
          }
          50% {
            opacity: 0.8;
            filter: drop-shadow(0 0 8px currentColor);
          }
        }

        @keyframes pulse-intense {
          0%, 100% {
            opacity: 0.6;
            transform: scale(1);
          }
          50% {
            opacity: 1;
            transform: scale(1.05);
          }
        }

        @keyframes text-shimmer {
          0% {
            background-position: -200% center;
          }
          100% {
            background-position: 200% center;
          }
        }

        @keyframes loading-progress {
          0% {
            transform: translateX(-100%);
          }
          50% {
            transform: translateX(0%);
          }
          100% {
            transform: translateX(100%);
          }
        }

        @keyframes block-chain {
          0%, 100% {
            opacity: 0.2;
            transform: translateY(0) scale(0.8);
          }
          50% {
            opacity: 1;
            transform: translateY(-4px) scale(1.2);
          }
        }

        @keyframes corner-glow {
          0%, 100% {
            opacity: 0.2;
          }
          50% {
            opacity: 0.6;
          }
        }

        /* Mobile shake animation - optimized for performance */
        @keyframes shake-mobile {
          0%, 100% {
            transform: translate3d(0, 0, 0);
          }
          10%, 30%, 50%, 70%, 90% {
            transform: translate3d(-1.5px, 0, 0);
          }
          20%, 40%, 60%, 80% {
            transform: translate3d(1.5px, 0, 0);
          }
        }

        @keyframes ripple-wave {
          0% {
            transform: scale(1);
            opacity: 0.6;
          }
          100% {
            transform: scale(1.8);
            opacity: 0;
          }
        }

        @keyframes color-shift {
          0%, 100% {
            filter: hue-rotate(0deg) brightness(1);
          }
          50% {
            filter: hue-rotate(15deg) brightness(1.1);
          }
        }

        @keyframes breath-intense {
          0%, 100% {
            transform: scale(1);
          }
          50% {
            transform: scale(1.15);
          }
        }

        .animate-color-shift {
          animation: color-shift 2s ease-in-out infinite !important;
        }

        .animate-breath-intense {
          animation: breath-intense 1s ease-in-out infinite !important;
        }

        .animate-ripple-wave {
          animation: ripple-wave 1.5s ease-out infinite !important;
        }

        /* Apply shake animation when there are unread messages */
        .chat-btn-shake {
          animation: shake-desktop 1.5s ease-in-out infinite !important;
          will-change: transform;
        }

        @keyframes shake-desktop {
          0%, 100% {
            transform: scale(1) rotate(0deg);
          }
          10% {
            transform: scale(1.08) rotate(-3deg);
          }
          20% {
            transform: scale(1.08) rotate(3deg);
          }
          30% {
            transform: scale(1.08) rotate(-2deg);
          }
          40% {
            transform: scale(1.08) rotate(2deg);
          }
          50% {
            transform: scale(1) rotate(0deg);
          }
        }

        .upload-progress-bar {
          position: relative;
          overflow: hidden;
        }

        .upload-progress-bar::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255, 255, 255, 0.3),
            transparent
          );
          animation: shimmer-progress 1.5s infinite;
        }

        .animate-shimmer {
          animation: shimmer 2s infinite;
        }

        .animate-spin-slow {
          animation: spin-slow 4s linear infinite;
        }

        .animate-spin-reverse-slow {
          animation: spin-reverse-slow 3s linear infinite;
        }

        .animate-pulse-glow {
          animation: pulse-glow 2s ease-in-out infinite;
        }

        .animate-pulse-intense {
          animation: pulse-intense 1.5s ease-in-out infinite;
        }

        .animate-text-shimmer {
          animation: text-shimmer 3s linear infinite;
        }

        .animate-loading-progress {
          animation: loading-progress 2s ease-in-out infinite;
        }

        .animate-block-chain {
          animation: block-chain 1.2s ease-in-out infinite;
        }

        .animate-corner-glow {
          animation: corner-glow 2s ease-in-out infinite;
        }

        .shadow-glow-sm {
          box-shadow: 0 0 8px currentColor, 0 0 16px currentColor;
        }

        button.customer-service-panel-close,
        button.customer-service-header-btn {
          box-sizing: border-box;
          width: 44px !important;
          height: 44px !important;
          min-width: 44px !important;
          min-height: 44px !important;
          padding: 0 !important;
        }

        button.customer-service-composer-tool {
          box-sizing: border-box;
          width: 44px !important;
          height: 44px !important;
          min-width: 44px !important;
          min-height: 44px !important;
          padding: 0 !important;
        }

        button.customer-service-composer-send {
          box-sizing: border-box;
          height: 44px !important;
          min-height: 44px !important;
          min-width: 52px !important;
          padding: 0 16px !important;
        }

        textarea.customer-service-composer-input {
          box-sizing: border-box;
          min-height: 44px !important;
          padding: 10px 14px !important;
          font-size: 16px !important;
          line-height: 22px !important;
        }

        @media (min-width: 640px) {
          button.customer-service-composer-send {
            min-width: 84px !important;
            padding: 0 20px !important;
          }
        }

        @media (min-width: 1024px) {
          textarea.customer-service-composer-input {
            font-size: 14px !important;
          }
        }

        .customer-service-chat-header {
          z-index: 10;
          margin-bottom: -1px;
          transform: translateZ(0);
          box-shadow: 0 6px 14px -8px rgb(15 23 42 / 45%);
        }

        .cs-viewer-toolbar {
          top: calc(env(safe-area-inset-top) + 12px);
          right: calc(env(safe-area-inset-right) + 12px);
        }

        button.cs-viewer-btn {
          box-sizing: border-box;
          width: 40px !important;
          height: 40px !important;
          min-width: 40px !important;
          min-height: 40px !important;
          padding: 0 !important;
          flex: 0 0 auto;
        }

        @media (pointer: coarse), (max-width: 1023px) {
          button.cs-viewer-btn {
            width: 44px !important;
            height: 44px !important;
            min-width: 44px !important;
            min-height: 44px !important;
          }
        }

        @media (min-width: 640px) {
          .cs-viewer-toolbar {
            top: calc(env(safe-area-inset-top) + 20px);
            right: calc(env(safe-area-inset-right) + 20px);
          }
        }

        @media (max-width: 1023px) {
          .customer-service-panel-header {
            padding-top: calc(env(safe-area-inset-top) + 12px);
          }

          .customer-service-composer {
            padding-bottom: calc(env(safe-area-inset-bottom) + 12px);
          }
        }

        /* Stable scrollbar styles */
        .chat-messages-container {
          overflow-y: scroll;
          overflow-x: hidden;
          scroll-behavior: auto;
          overscroll-behavior: contain;
          -webkit-overflow-scrolling: touch;
        }

        /* Prevent layout shift during scroll */
        .chat-messages-container::-webkit-scrollbar {
          width: 8px;
        }

        .chat-messages-container::-webkit-scrollbar-track {
          background: transparent;
        }

        .chat-messages-container::-webkit-scrollbar-thumb {
          background: rgba(148, 163, 184, 0.4);
          border-radius: 4px;
        }

        .chat-messages-container::-webkit-scrollbar-thumb:hover {
          background: rgba(148, 163, 184, 0.6);
        }
      `}</style>
      {messagePopup && !isOpen && createPortal(
        <div className="customer-service-popup fixed z-[10001] animate-[slideIn_0.3s_ease-out_both] keep-animation" style={{ WebkitTextSizeAdjust: '100%' }}>
          <div className={`relative overflow-hidden rounded-[18px] shadow-2xl animate-[fadeInUp_0.4s_ease-out_both] keep-animation border ${
            messagePopup.customer.is_super
              ? 'bg-gradient-to-br from-amber-500 via-yellow-500 to-amber-600 ring-1 ring-amber-400/50 border-amber-400/30'
              : 'bg-gradient-to-br from-blue-500 via-blue-600 to-indigo-600 ring-1 ring-blue-400/50 border-blue-400/30'
          }`}>
            <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
              <div className={`absolute -right-8 -top-8 h-[104px] w-[104px] rounded-full ${
                messagePopup.customer.is_super ? 'bg-yellow-300/30' : 'bg-cyan-300/25'
              }`}></div>
              <div className={`absolute -bottom-8 -left-8 h-[88px] w-[88px] rounded-full ${
                messagePopup.customer.is_super ? 'bg-orange-400/30' : 'bg-indigo-300/30'
              }`}></div>
              <div className={`absolute -right-10 top-[46%] h-[22px] w-[150px] -rotate-[28deg] rounded-full ${
                messagePopup.customer.is_super ? 'bg-white/15' : 'bg-sky-200/15'
              }`}></div>
              <div className="absolute left-[38%] top-[10px] h-[10px] w-[10px] rotate-45 rounded-[2px] bg-white/30"></div>
              <div className={`absolute bottom-[58px] right-[52px] h-[8px] w-[8px] rounded-full ${
                messagePopup.customer.is_super ? 'bg-amber-100/60' : 'bg-cyan-200/60'
              }`}></div>
            </div>

            <div className="relative p-[12px] sm:p-[16px]">
              <div className="mb-[10px] flex items-start gap-[10px] sm:mb-[12px] sm:gap-[12px]">
                <div className={`relative flex-shrink-0 rounded-xl overflow-hidden ring-2 shadow-lg ${
                  messagePopup.customer.is_super ? 'ring-white/60' : 'ring-white/50'
                }`}>
                  <CustomerAvatar
                    customer={messagePopup.customer}
                    className="h-[40px] w-[40px] sm:h-[44px] sm:w-[44px]"
                  />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="mb-[2px] flex items-center gap-[6px] sm:gap-[8px]">
                    <h3 className="truncate text-[14px] font-bold text-white sm:text-[16px]">
                      {messagePopup.customer.customer_name}
                    </h3>
                    {messagePopup.customer.is_super && (
                      <div className="flex-shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 bg-white/25 backdrop-blur-sm border border-white/40 rounded-full">
                        <Sparkles className="w-2.5 h-2.5 text-white fill-white" />
                        <span className="text-[11px] font-bold text-white">{messagePopup.customer.vip_label || 'VIP'}</span>
                      </div>
                    )}
                  </div>
                  <p className="truncate text-[11px] text-white/80 sm:text-[12px]">
                    ID: {messagePopup.customer.customer_id}
                  </p>
                </div>

                <button
                  onClick={() => {
                    setMessagePopup(null);
                    stopContinuousSound();
                  }}
                  aria-label={t.common.close}
                  className={`emp-close-btn flex h-[36px] w-[36px] flex-shrink-0 items-center justify-center rounded-full !min-h-0 !min-w-0 !p-0 text-white ring-1 ring-white/40 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white ${
                    messagePopup.customer.is_super
                      ? 'bg-amber-900/25 hover:bg-amber-900/40'
                      : 'bg-indigo-900/30 hover:bg-indigo-900/45'
                  }`}
                  style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                >
                  <X className="h-[18px] w-[18px]" strokeWidth={2.75} aria-hidden="true" />
                </button>
              </div>

              <div className={`mb-[12px] overflow-hidden rounded-xl p-[10px] backdrop-blur-sm sm:p-[12px] ${
                messagePopup.customer.is_super
                  ? 'bg-amber-700/40 border border-amber-300/30'
                  : 'bg-blue-800/40 border border-blue-300/20'
              }`}>
                {messagePopup.message.includes('\ud83d\udcf7 Photo') ? (
                  <div className="flex items-center gap-2 text-white/95">
                    <Image className="h-[18px] w-[18px] flex-shrink-0" />
                    <span className="text-[13px] font-medium sm:text-[14px]">{t.customerService.photo}</span>
                  </div>
                ) : (
                  <p className="line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-white/95 sm:text-[14px]">
                    {messagePopup.message}
                  </p>
                )}
              </div>

              <div className={`-mx-[12px] -mb-[12px] flex items-center justify-between gap-[8px] px-[12px] py-[8px] sm:-mx-[16px] sm:-mb-[16px] sm:px-[16px] sm:py-[10px] ${
                messagePopup.customer.is_super ? 'bg-amber-900/25' : 'bg-indigo-900/30'
              }`}>
                <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-white/80 sm:text-[12px]">
                  <Clock className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{messagePopup.time}</span>
                </div>

                <button
                  onClick={() => {
                    setIsOpen(true);
                    setMessagePopup(null);
                    stopContinuousSound();
                    handleSelectConversation(messagePopup.customer);
                  }}
                  className={`inline-flex h-[36px] min-w-[104px] flex-shrink-0 items-center justify-center gap-[6px] whitespace-nowrap rounded-[10px] !min-h-0 !px-[14px] !py-0 !text-[13px] font-bold leading-none shadow-md transition-all hover:scale-[1.03] active:scale-95 sm:h-[40px] sm:!text-[14px] ${
                    messagePopup.customer.is_super
                      ? 'bg-white text-amber-700 hover:bg-amber-50'
                      : 'bg-white text-blue-700 hover:bg-blue-50'
                  }`}
                  style={{ touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' }}
                >
                  <MessageCircle className="h-[15px] w-[15px]" strokeWidth={2.5} aria-hidden="true" />
                  {t.customerService.replyNow}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {!isOpen && createPortal(
        <div
          className="customer-service-fab fixed z-[9999]"
        >
          <button
            onClick={() => {
              setIsOpen(true);
              setMessagePopup(null);
              stopContinuousSound();
            }}
            className={`relative group active:scale-95 transition-transform keep-animation ${unreadCount > 0 ? 'chat-btn-shake' : ''}`}
            style={{
              padding: 0,
              background: 'none',
              border: 'none',
              outline: 'none',
              WebkitAppearance: 'none',
              appearance: 'none',
            }}
          >
            {/* Outer glow effects - Only on larger screens */}
            {unreadCount > 0 && (
              <>
                <div className="hidden sm:block absolute inset-0 rounded-full bg-gradient-to-r from-red-500 via-orange-500 to-yellow-500 blur-xl opacity-40 animate-pulse keep-animation"></div>
                <div className="hidden sm:block absolute inset-0 rounded-full animate-ripple-wave keep-animation">
                  <div className="w-full h-full rounded-full border-2 border-orange-400/60"></div>
                </div>
              </>
            )}

            {/* Main button with gradient border */}
            <div
              className={`absolute inset-0 rounded-xl lg:rounded-3xl overflow-hidden transition-all duration-300 keep-animation ${
                unreadCount > 0
                  ? 'bg-gradient-to-br from-red-500 via-orange-500 to-yellow-500 animate-color-shift'
                  : 'bg-gradient-to-br from-cyan-500 via-blue-600 to-blue-700 animate-pulse'
              }`}
            >
              <div className="absolute inset-[2px] bg-gradient-to-br from-slate-900 via-slate-800 to-slate-950 rounded-[10px] lg:rounded-[22px] flex items-center justify-center overflow-hidden">
                <div className={`absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity ${
                  unreadCount > 0
                    ? 'bg-gradient-to-br from-red-400/30 via-orange-500/40 to-yellow-500/30'
                    : 'bg-gradient-to-br from-cyan-400/20 via-blue-500/30 to-blue-500/20'
                }`}></div>

                <div className={`absolute inset-0 keep-animation ${
                  unreadCount > 0
                    ? 'bg-[radial-gradient(circle_at_50%_50%,rgba(239,68,68,0.4),transparent_70%)] animate-pulse'
                    : 'bg-[radial-gradient(circle_at_50%_50%,rgba(6,182,212,0.3),transparent_70%)]'
                }`}></div>

                <MessageCircle
                  className={`w-7 h-7 sm:w-8 sm:h-8 lg:w-11 lg:h-11 relative z-10 transition-all duration-300 keep-animation ${
                    unreadCount > 0
                      ? 'text-orange-300 drop-shadow-[0_0_6px_rgba(251,146,60,0.6)] animate-pulse'
                      : 'text-cyan-400 group-hover:text-cyan-300'
                  }`}
                  strokeWidth={2.5}
                  style={{
                    position: 'absolute',
                    top: '50%',
                    left: '50%',
                    transform: 'translate(-50%, -50%)'
                  }}
                />

                {/* Spinning particles - Only when unread */}
                {unreadCount > 0 && (
                  <div className="absolute inset-0 hidden sm:flex items-center justify-center">
                    <div className="absolute w-full h-full animate-spin" style={{ animationDuration: '4s' }}>
                      <div className="absolute top-0 left-1/2 w-1.5 h-1.5 -ml-1 bg-yellow-400/80 rounded-full blur-sm"></div>
                      <div className="absolute bottom-0 left-1/2 w-1.5 h-1.5 -ml-1 bg-red-400/80 rounded-full blur-sm"></div>
                    </div>
                    <div className="absolute w-full h-full animate-spin" style={{ animationDuration: '3s', animationDirection: 'reverse' }}>
                      <div className="absolute left-0 top-1/2 w-1.5 h-1.5 -mt-1 bg-orange-400/80 rounded-full blur-sm"></div>
                      <div className="absolute right-0 top-1/2 w-1.5 h-1.5 -mt-1 bg-yellow-300/80 rounded-full blur-sm"></div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Unread count badge */}
            {unreadCount > 0 && (
              <div className="absolute -top-1 -right-1 sm:-top-2 sm:-right-2 flex items-center justify-center z-20">
                <div className="absolute inset-0 bg-red-500 rounded-full animate-ping keep-animation opacity-75"></div>
                <div className="absolute inset-0 bg-gradient-to-br from-red-500 via-orange-500 to-red-600 rounded-full blur-md opacity-80"></div>
                <div className="relative flex items-center justify-center min-w-[22px] sm:min-w-[28px] lg:min-w-[36px] h-[22px] sm:h-7 lg:h-9 px-1.5 sm:px-2 lg:px-3 bg-gradient-to-br from-red-500 via-orange-500 to-red-600 text-white text-[11px] sm:text-xs lg:text-sm font-black rounded-full border-2 border-white shadow-xl animate-breath-intense keep-animation">
                  <span className="relative drop-shadow-lg">{unreadCount > 99 ? '99+' : unreadCount}</span>
                </div>
              </div>
            )}

            {playingSound && (
              <div className="absolute -top-1 -left-1 lg:-top-2 lg:-left-2 w-5 h-5 lg:w-7 lg:h-7 z-20">
                <div className="absolute inset-0 bg-green-400 rounded-full animate-ping opacity-75"></div>
                <div className="absolute inset-0 bg-gradient-to-br from-green-400 to-emerald-500 rounded-full blur-sm"></div>
                <div className="relative w-full h-full bg-gradient-to-br from-green-400 to-emerald-500 rounded-full flex items-center justify-center border-2 border-white shadow-lg">
                  <Zap className="w-2.5 h-2.5 lg:w-4 lg:h-4 text-white animate-pulse" strokeWidth={3} />
                </div>
              </div>
            )}
          </button>
        </div>,
        document.body
      )}

      {isOpen && createPortal(
        <div
          className="employee-modal-surface fixed inset-0 lg:bottom-4 lg:right-4 lg:top-auto lg:left-auto z-[10000] lg:z-50 w-full lg:w-[400px] xl:w-[460px] h-full lg:h-[600px] xl:h-[680px] lg:max-h-[calc(100vh_-_var(--employee-header-height,_76px)_-_2rem)] bg-white lg:rounded-2xl shadow-2xl flex flex-col overflow-hidden"
          style={{
            WebkitOverflowScrolling: 'touch',
          }}
          onTouchMove={(e) => {
            e.stopPropagation();
          }}
        >

          {showConversationList ? (
            <>
              <div className="customer-service-panel-header relative z-10 flex-shrink-0 bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-700 px-4 pt-3 pb-4 lg:px-6 lg:pt-5 lg:pb-5 overflow-hidden">
                {/* Decorative elements */}
                <div className="absolute top-0 right-0 w-48 h-48 bg-white/[0.04] rounded-full -translate-y-1/2 translate-x-1/4"></div>
                <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/[0.04] rounded-full translate-y-1/2 -translate-x-1/4"></div>

                <div className="relative flex items-center gap-3">
                  <div className="flex items-center gap-3 flex-1 min-w-0">
                    <div className="relative flex-shrink-0">
                      <div className="bg-white/20 p-2.5 lg:p-3 rounded-2xl border border-white/30 shadow-lg shadow-blue-900/20">
                        <MessageCircle className="w-5 h-5 lg:w-6 lg:h-6 text-white" />
                      </div>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h2 className="text-[20px] leading-[28px] lg:text-[22px] font-bold text-white tracking-tight">
                        {t.customerService.title}
                      </h2>
                      <p className="text-xs lg:text-sm text-blue-100/90 mt-0.5 font-medium">
                        {t.customerService.subtitle}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsOpen(false)}
                    className="customer-service-panel-close emp-close-btn emp-close-btn--wrap group flex flex-shrink-0 items-center justify-center rounded-xl text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                    aria-label={t.common.close}
                  >
                    <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] border border-white/10 bg-white/20 transition-all group-hover:bg-white/30 group-active:scale-95">
                      <X className="h-4 w-4 shrink-0" strokeWidth={2.5} />
                    </span>
                  </button>
                </div>

                              </div>

              <div
                   ref={conversationListRef}
                   className="relative flex-1 overflow-hidden overflow-y-auto"
                   style={{
                     WebkitOverflowScrolling: 'touch',
                     scrollbarWidth: 'thin',
                     scrollbarColor: 'rgba(148, 163, 184, 0.4) transparent',
                     background: 'linear-gradient(180deg, #f8fafc 0%, #f1f5f9 50%, #e8eef6 100%)'
                   }}>
                {loadingConversations && conversations.length === 0 ? (
                  <div className="p-3 sm:p-4 space-y-2.5" aria-label={t.customerService.loadingMessages}>
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div
                        key={index}
                        className="flex items-center gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm"
                      >
                        <div className="h-11 w-11 flex-shrink-0 animate-pulse rounded-xl bg-slate-200" />
                        <div className="min-w-0 flex-1 space-y-2">
                          <div className="h-3 w-2/5 animate-pulse rounded bg-slate-200" />
                          <div className="h-2.5 w-3/4 animate-pulse rounded bg-slate-100" />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : conversationsError && conversations.length === 0 ? (
                  <div role="alert" className="flex flex-col items-center justify-center h-full text-center px-6">
                    <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-slate-100 to-rose-50 flex items-center justify-center mb-4 shadow-inner">
                      <MessageCircle className="w-10 h-10 text-rose-300" />
                    </div>
                    <p className="text-sm font-medium text-slate-500">{t.customerService.loadFailed}</p>
                    <button
                      type="button"
                      onClick={() => {
                        setConversationsError(false);
                        void loadConversations(true);
                      }}
                      className="mt-4 rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                    >
                      {t.common.retry}
                    </button>
                  </div>
                ) : conversations.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center px-6">
                    <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-slate-100 to-blue-50 flex items-center justify-center mb-4 shadow-inner">
                      <MessageCircle className="w-10 h-10 text-slate-300" />
                    </div>
                    <p className="text-sm font-medium text-slate-500">{t.customerService.noConversations}</p>
                    <p className="text-xs mt-1 text-slate-400">{t.customerService.noConversationsDesc}</p>
                  </div>
                ) : (
                  <div className="p-3 sm:p-4 space-y-2 sm:space-y-2.5">
                    {conversations.map((conv, index) => (
                      <button
                        key={conv.customer.id}
                        onClick={() => handleSelectConversation(conv.customer)}
                        onMouseEnter={() => { void prefetchMessages(conv.customer.id); }}
                        onTouchStart={() => { void prefetchMessages(conv.customer.id); }}
                        onFocus={() => { void prefetchMessages(conv.customer.id); }}
                        className={`w-full rounded-2xl transition-all duration-200 hover:translate-x-0.5 active:scale-[0.98] group relative overflow-hidden ${skipListAnimationRef.current ? '' : 'animate-[fadeInUp_0.4s_ease-out_both]'} ${
                          conv.customer.is_super
                            ? conv.unread_count > 0
                              ? 'p-3.5 pl-[18px] sm:p-4 sm:pl-5 bg-gradient-to-r from-amber-200 via-amber-100 to-orange-100 border border-orange-400 shadow-[0_6px_16px_-8px_rgba(234,88,12,0.5)] hover:shadow-[0_8px_20px_-8px_rgba(234,88,12,0.6)]'
                              : 'p-3.5 pl-[18px] sm:p-4 sm:pl-5 bg-amber-50/60 border border-amber-200 hover:border-amber-300 hover:shadow-md'
                            : conv.unread_count > 0
                              ? 'p-3.5 pl-[18px] sm:p-4 sm:pl-5 bg-gradient-to-r from-blue-200 via-blue-100 to-sky-50 border border-blue-300 shadow-[0_6px_16px_-8px_rgba(37,99,235,0.45)] hover:shadow-[0_8px_20px_-8px_rgba(37,99,235,0.55)]'
                              : 'p-3.5 pl-[18px] sm:p-4 sm:pl-5 bg-white border border-slate-200 hover:border-blue-200 hover:shadow-md'
                        }`}
                        style={skipListAnimationRef.current ? undefined : {
                          animationDelay: `${Math.min(index * 0.05, 0.4)}s`
                        }}
                      >
                        {conv.unread_count > 0 ? (
                          <span className={`pointer-events-none absolute inset-0 rounded-[15px] border-l-[7px] border-t-[5px] [mask-image:linear-gradient(to_right,#000_50%,transparent_100%)] ${conv.customer.is_super ? 'border-orange-500' : 'border-blue-600'}`} aria-hidden="true"></span>
                        ) : (
                          <span className={`pointer-events-none absolute inset-y-0 left-0 w-[4px] ${conv.customer.is_super ? 'bg-amber-400' : 'bg-blue-500/70'}`} aria-hidden="true"></span>
                        )}
                        {conv.customer.is_super ? (
                          /* VIP card: 4-line vertical layout */
                          <div className="relative">
                            <div className="flex items-start gap-3 sm:gap-3.5">
                              <div className="relative flex-shrink-0">
                                {conv.customer.badge_type && (
                                  <div className="absolute -top-1.5 -left-1.5 w-5.5 h-5.5 bg-gradient-to-br from-amber-400 to-orange-500 rounded-md flex items-center justify-center shadow-sm z-10 rotate-12" style={{ width: '22px', height: '22px' }}>
                                    <span className="text-[11px]">
                                      {conv.customer.badge_type === 'diamond' ? '\ud83d\udc8e' :
                                       conv.customer.badge_type === 'crown' ? '\ud83d\udc51' :
                                       conv.customer.badge_type === 'star' ? '\u2b50' :
                                       conv.customer.badge_type === 'vip' ? '\ud83c\udfc6' : '\u2728'}
                                    </span>
                                  </div>
                                )}
                                <CustomerAvatar
                                  customer={conv.customer}
                                  className={`w-11 h-11 sm:w-12 sm:h-12 ${conv.unread_count > 0 ? 'ring-2 ring-orange-400/70 ring-offset-2' : ''}`}
                                />
                                <div className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 sm:w-3.5 sm:h-3.5 rounded-full border-2 border-white transition-colors ${
                                  customerOnlineStatus.get(conv.customer.id)
                                    ? 'bg-emerald-400 shadow-sm shadow-emerald-200'
                                    : 'bg-slate-300'
                                }`}></div>
                              </div>

                              <div className="flex-1 min-w-0 text-left space-y-0.5">
                                {/* Line 1: Customer Name */}
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[15px] sm:text-base font-bold truncate text-amber-800">
                                    {conv.customer.customer_name}
                                  </span>
                                  {conv.unread_count > 0 && (
                                    <span className="flex items-center justify-center min-w-[26px] h-[26px] px-2 bg-gradient-to-br from-red-500 to-orange-500 text-white text-[13px] font-bold leading-none tabular-nums rounded-full shadow-sm flex-shrink-0">
                                      {conv.unread_count > 9 ? '9+' : conv.unread_count}
                                    </span>
                                  )}
                                </div>

                                {/* Line 2: Title Prefix */}
                                {conv.customer.super_customer_title && (
                                  <div className="flex items-center gap-1.5">
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-gradient-to-r from-amber-100 to-orange-100 border border-amber-200/80 rounded-md text-[11px] sm:text-xs font-bold text-amber-700">
                                      <Award className="w-3 h-3 flex-shrink-0" />
                                      {conv.customer.super_customer_title}
                                    </span>
                                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-amber-500/10 border border-amber-300/40 rounded text-[11px] font-bold text-amber-600">
                                      <Sparkles className="w-2.5 h-2.5" />
                                      {conv.customer.vip_label || 'VIP'}
                                    </span>
                                  </div>
                                )}

                                {/* Line 3: Custom ID */}
                                <p className="text-[11px] sm:text-xs font-mono text-amber-600/80">
                                  # {conv.customer.customer_id}
                                </p>

                                {/* Line 4: Chat Content Preview + Time */}
                                <div className="flex items-center justify-between gap-2">
                                  {(() => {
                                    const hasImg = /<img\s/i.test(conv.last_message);
                                    const stripped = conv.last_message.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
                                    const isPhoto = conv.last_message.includes('\ud83d\udcf7 Photo') || (!stripped && hasImg);
                                    if (isPhoto && !stripped) {
                                      return (
                                        <p className={`text-xs truncate flex items-center gap-1 ${conv.unread_count > 0 ? 'font-semibold text-amber-900' : 'text-amber-700/60'}`}>
                                          <Image className="w-3 h-3 flex-shrink-0" />
                                          <span>{t.customerService.photo}</span>
                                        </p>
                                      );
                                    }
                                    const preview = stripped || '';
                                    return (
                                      <p className={`text-xs truncate ${conv.unread_count > 0 ? 'font-semibold text-amber-900' : 'text-amber-700/60'}`}>
                                        {preview.length > 40 ? `${preview.substring(0, 40)}...` : preview}
                                      </p>
                                    );
                                  })()}
                                  <div className={`flex items-center gap-1 text-[11px] flex-shrink-0 ${conv.unread_count > 0 ? 'font-semibold text-orange-600' : 'font-medium text-amber-500/70'}`}>
                                    <Clock className="w-3 h-3" />
                                    {formatTime(conv.last_message_time)}
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          /* Regular card: compact layout */
                          <div className="relative flex items-start gap-2.5 sm:gap-3">
                            <div className="relative flex-shrink-0 mt-0.5">
                              <CustomerAvatar
                                customer={conv.customer}
                                className={`w-10 h-10 sm:w-11 sm:h-11 ${conv.unread_count > 0 ? 'ring-2 ring-blue-500/70 ring-offset-2' : ''}`}
                              />
                              <div className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 sm:w-3 sm:h-3 rounded-full border-2 border-white transition-colors ${
                                customerOnlineStatus.get(conv.customer.id)
                                  ? 'bg-emerald-400 shadow-sm shadow-emerald-200'
                                  : 'bg-slate-300'
                              }`}></div>
                            </div>

                            <div className="flex-1 min-w-0 text-left">
                              <div className="flex items-center justify-between gap-2 mb-0.5">
                                <span className={`text-sm truncate text-gray-900 ${conv.unread_count > 0 ? 'font-bold' : 'font-semibold'}`}>
                                  {conv.customer.customer_name}
                                </span>
                                {conv.unread_count > 0 && (
                                  <span className="flex items-center justify-center min-w-[26px] h-[26px] px-2 bg-gradient-to-br from-red-500 to-orange-500 text-white text-[13px] font-bold leading-none tabular-nums rounded-full shadow-sm flex-shrink-0">
                                    {conv.unread_count > 9 ? '9+' : conv.unread_count}
                                  </span>
                                )}
                              </div>

                              <p className="text-[11px] font-mono mb-0.5 text-gray-500">
                                # {conv.customer.customer_id}
                              </p>

                              <div className="flex items-center justify-between gap-2">
                                {(() => {
                                  const hasImg = /<img\s/i.test(conv.last_message);
                                  const stripped = conv.last_message.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
                                  const isPhoto = conv.last_message.includes('\ud83d\udcf7 Photo') || (!stripped && hasImg);
                                  if (isPhoto && !stripped) {
                                    return (
                                      <p className={`text-xs truncate flex items-center gap-1 ${conv.unread_count > 0 ? 'font-semibold text-slate-900' : 'text-gray-600'}`}>
                                        <Image className="w-3 h-3 flex-shrink-0" />
                                        <span>{t.customerService.photo}</span>
                                      </p>
                                    );
                                  }
                                  const preview = stripped || '';
                                  return (
                                    <p className={`text-xs truncate ${conv.unread_count > 0 ? 'font-semibold text-slate-900' : 'text-gray-600'}`}>
                                      {preview.length > 35 ? `${preview.substring(0, 35)}...` : preview}
                                    </p>
                                  );
                                })()}
                                <div className={`flex items-center gap-1 text-[11px] flex-shrink-0 ${conv.unread_count > 0 ? 'font-semibold text-blue-700' : 'font-medium text-slate-400'}`}>
                                  <Clock className="w-3 h-3" />
                                  {formatTime(conv.last_message_time)}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className={`customer-service-panel-header customer-service-chat-header relative flex-shrink-0 px-4 pt-3 pb-4 lg:px-6 lg:pt-5 lg:pb-5 overflow-hidden ${
                selectedCustomer?.is_super
                  ? 'bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600'
                  : 'bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-700'
              }`}>
                <div className="absolute top-0 right-0 w-48 h-48 bg-white/[0.04] rounded-full -translate-y-1/2 translate-x-1/4"></div>
                <div className="absolute bottom-0 left-0 w-32 h-32 bg-white/[0.04] rounded-full translate-y-1/2 -translate-x-1/4"></div>
                <div className="absolute top-1/2 right-1/4 w-2 h-2 bg-white/10 rounded-full"></div>

                <div className="relative flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleBackToList}
                    className="customer-service-header-btn group -ml-1 flex flex-shrink-0 items-center justify-center rounded-xl text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                    aria-label={t.common.back}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/20 transition-all group-hover:bg-white/30 group-active:scale-95 lg:h-10 lg:w-10">
                      <ArrowLeft className="h-5 w-5 shrink-0" strokeWidth={2.5} />
                    </span>
                  </button>

                  {selectedCustomer && (
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="relative flex-shrink-0">
                        <CustomerAvatar
                          customer={selectedCustomer}
                          className="w-12 h-12"
                        />

                        <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 shadow-sm transition-colors ${
                          selectedCustomer.is_super ? 'border-amber-500' : 'border-blue-500'
                        } ${
                          customerOnlineStatus.get(selectedCustomer.id)
                            ? 'bg-green-400'
                            : 'bg-gray-300'
                        }`}></div>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="h-5 truncate text-sm font-bold leading-5 text-white sm:h-6 sm:text-base sm:leading-6">
                          {selectedCustomer.customer_name}
                        </div>

                        <div className="mt-0.5 flex h-[18px] min-w-0 items-center">
                          {selectedCustomer.is_super ? (
                            selectedCustomer.super_customer_title && (
                              <span className="inline-flex h-[18px] min-w-0 items-center gap-0.5 rounded border border-white/30 bg-white/20 px-1.5 text-[11px] font-bold leading-none text-white sm:text-xs">
                                <Award className="h-2.5 w-2.5 flex-shrink-0" />
                                <span className="truncate">{selectedCustomer.super_customer_title}</span>
                              </span>
                            )
                          ) : serviceTicketNumber ? (
                            <div className="flex min-w-0 items-center gap-1 font-mono text-[11px] leading-none text-blue-100 animate-[fadeIn_0.2s_ease-out] sm:text-xs">
                              <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-green-300"></div>
                              <span className="truncate">{t.customerService.ticket}: {serviceTicketNumber}</span>
                            </div>
                          ) : (
                            <div className="h-2.5 w-32 animate-pulse rounded-full bg-white/20" aria-hidden="true" />
                          )}
                        </div>

                        <div className={`mt-0.5 h-4 truncate font-mono text-[11px] leading-4 sm:text-xs ${
                          selectedCustomer.is_super ? 'text-amber-100' : 'text-blue-100'
                        }`}>
                          # {selectedCustomer.customer_id}
                        </div>
                      </div>
                    </div>
                  )}

                  <button
                    type="button"
                    onClick={handleRequestRating}
                    className="customer-service-header-btn group -mr-1 flex flex-shrink-0 items-center justify-center rounded-xl text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    title={t.customerService.requestRating}
                    aria-label={t.customerService.requestRating}
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/20 transition-all group-hover:bg-white/30 group-active:scale-95 lg:h-10 lg:w-10">
                      <Star className="h-5 w-5 shrink-0" strokeWidth={2.5} />
                    </span>
                  </button>
                </div>
              </div>

              <div
                ref={messagesContainerCallbackRef}
                className="chat-messages-container relative flex-1 flex flex-col-reverse"
                style={{
                  scrollbarWidth: 'thin',
                  scrollbarColor: 'rgba(148, 163, 184, 0.4) transparent',
                  WebkitOverflowScrolling: 'touch',
                  overflowY: 'auto',
                  overflowX: 'hidden',
                  background: selectedCustomer?.is_super
                    ? 'linear-gradient(160deg, #fffbeb 0%, #fef3c7 30%, #fff7ed 60%, #fffbeb 100%)'
                    : 'linear-gradient(160deg, #f0f4f8 0%, #e8eef6 30%, #eef2ff 60%, #f0f4f8 100%)'
                }}
              >
               {loadingMessages && (
                 <ChatMessagesLoader label={t.customerService.loadingMessages} tone={selectedCustomer?.is_super ? 'gold' : 'blue'} />
               )}
               <div className="p-2 sm:p-3 md:p-4 space-y-2 sm:space-y-3 md:space-y-4 mb-auto">
                {loadingMessages ? null : messagesError && messages.length === 0 ? (
                  <div role="alert" className="flex flex-col items-center justify-center h-full text-center px-6 py-10">
                    <p className="text-sm font-medium text-slate-500">{t.customerService.loadFailed}</p>
                    <button
                      type="button"
                      onClick={() => {
                        setMessagesError(false);
                        setLoadingMessages(true);
                        void loadMessagesFromDB(true);
                      }}
                      className="mt-4 rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
                    >
                      {t.common.retry}
                    </button>
                  </div>
                ) : messages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-center animate-[fadeIn_0.5s_ease-out] px-6">
                    <div className="relative mb-6">
                      <div className={`w-24 h-24 rounded-3xl flex items-center justify-center shadow-lg ${
                        selectedCustomer?.is_super
                          ? 'bg-gradient-to-br from-amber-100 via-orange-50 to-amber-100 border border-amber-200/60'
                          : 'bg-gradient-to-br from-blue-100 via-sky-50 to-blue-100 border border-blue-200/60'
                      }`}>
                        <MessageCircle className={`w-11 h-11 ${
                          selectedCustomer?.is_super ? 'text-amber-400' : 'text-blue-400'
                        }`} strokeWidth={1.5} />
                      </div>
                      <div className={`absolute -bottom-1.5 -right-1.5 w-9 h-9 rounded-xl flex items-center justify-center shadow-md ${
                        selectedCustomer?.is_super
                          ? 'bg-gradient-to-br from-amber-400 to-orange-500'
                          : 'bg-gradient-to-br from-blue-500 to-blue-600'
                      }`}>
                        <Clock className="w-4 h-4 text-white" />
                      </div>
                    </div>
                    <p className={`text-base font-semibold ${
                      selectedCustomer?.is_super ? 'text-amber-700' : 'text-slate-600'
                    }`}>{t.customerService.noMessages}</p>
                    <p className={`text-sm mt-2 max-w-[240px] leading-relaxed ${
                      selectedCustomer?.is_super ? 'text-amber-500/70' : 'text-slate-400'
                    }`}>{t.customerService.noMessagesDesc}</p>
                    <div className="flex items-center gap-1.5 mt-5">
                      <div className={`w-2 h-2 rounded-full animate-bounce ${
                        selectedCustomer?.is_super ? 'bg-amber-300' : 'bg-blue-300'
                      }`} style={{ animationDelay: '0s' }}></div>
                      <div className={`w-2 h-2 rounded-full animate-bounce ${
                        selectedCustomer?.is_super ? 'bg-amber-400' : 'bg-blue-400'
                      }`} style={{ animationDelay: '0.15s' }}></div>
                      <div className={`w-2 h-2 rounded-full animate-bounce ${
                        selectedCustomer?.is_super ? 'bg-amber-300' : 'bg-blue-300'
                      }`} style={{ animationDelay: '0.3s' }}></div>
                    </div>
                  </div>
                ) : (
                  <>
                    {loadingOlderMessages && (
                      <div className="flex justify-center py-3">
                        <div className="w-5 h-5 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
                      </div>
                    )}
                    {messages.map((msg, index) => {
                      const stableKey = stableKeyMapRef.current.get(msg.id) || msg.id;
                      const isSwapped = stableKeyMapRef.current.has(msg.id);
                      const messageCreatedAt = msg.created_at || new Date(0).toISOString();
                      const showEntryAnim = !isSwapped && messageCreatedAt > conversationOpenedAtRef.current && index >= messages.length - 3;
                      return (
                    <div
                      key={stableKey}
                      className={`flex gap-3 sm:gap-3 ${msg.sender_type === 'employee' ? 'flex-row-reverse' : 'flex-row'} ${showEntryAnim ? 'animate-[fadeInUp_0.4s_ease-out_both]' : ''}`}
                      style={showEntryAnim ? { animationDelay: `${Math.min((messages.length - index - 1) * 0.05, 0.15)}s` } : undefined}
                    >
                      <div className="flex-shrink-0">
                        {msg.sender_type === 'customer' && selectedCustomer && (
                          <div className="rounded-lg overflow-hidden">
                            <CustomerAvatar
                              customer={selectedCustomer}
                              className="w-10 h-10 sm:w-11 sm:h-11 lg:w-9 lg:h-9"
                            />
                          </div>
                        )}
                      </div>

                      <div className={`flex flex-col ${msg.sender_type === 'employee' ? 'items-end' : 'items-start'} max-w-[75%] sm:max-w-[75%] md:max-w-[70%] min-w-0`}>
                        <div className={`text-[11px] sm:text-xs font-semibold mb-0.5 ${
                          msg.sender_type === 'employee'
                            ? 'text-blue-600'
                            : selectedCustomer?.is_super
                              ? 'text-amber-700'
                              : 'text-gray-700'
                        }`}>
                          {msg.sender_type === 'employee' ? t.customerService.you : selectedCustomer?.customer_name}
                        </div>
                        {(msg.message_type === 'tip' || msg.message_type === 'rating_request' || msg.message_type === 'rating_result' || msg.message_type === 'rich_card') ? (
                          <>
                            {renderMessageContent(msg)}
                          </>
                        ) : (msg.message_type === 'image' && msg.image_url) || (msg.message_type === 'text' && extractImageOnlyUrl(msg.message_content)) ? (
                          <div className="rounded-2xl overflow-hidden shadow-md">
                            {renderMessageContent(msg)}
                          </div>
                        ) : (
                        <div
                          className={`relative px-3.5 sm:px-4 py-2.5 sm:py-3 rounded-2xl text-sm sm:text-[15px] leading-relaxed ${
                            msg.sender_type === 'employee'
                              ? 'bg-gradient-to-br from-blue-600 to-blue-700 text-white rounded-tr-md shadow-md shadow-blue-600/20'
                              : selectedCustomer?.is_super
                                ? 'bg-gradient-to-br from-white to-amber-50/80 text-gray-900 rounded-tl-md border border-amber-200/60 shadow-md shadow-amber-100/30'
                                : 'bg-white text-gray-900 rounded-tl-md border border-slate-200/80 shadow-md shadow-slate-100/50'
                          }`}
                        >
                          <div className="relative z-10">
                            {renderMessageContent(msg)}
                          </div>
                        </div>
                        )}
                        <div className="text-[11px] mt-0.5 sm:mt-1 text-gray-400">
                          {new Date(messageCreatedAt).toLocaleString(dateLocale, {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: false,
                          })}
                        </div>
                      </div>
                    </div>
                  ); })}


                  </>
                )}
               </div>
              </div>

              <form onSubmit={handleSendMessage} className="customer-service-composer relative border-t border-gray-200 bg-white p-3 md:p-4">
                <div className="flex items-end gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleImageSelect}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploadingImage}
                    className="customer-service-composer-tool relative flex flex-shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gray-100 text-gray-500 transition-all hover:bg-gray-200 hover:text-gray-700 active:scale-95 active:bg-gray-300 disabled:bg-blue-50"
                    title={t.customerService.uploadImage}
                    aria-label={t.customerService.uploadImage}
                  >
                    {uploadingImage ? (
                      <div className="flex flex-col items-center">
                        <div className="w-5 h-5 relative">
                          <svg className="w-5 h-5 -rotate-90" viewBox="0 0 20 20">
                            <circle cx="10" cy="10" r="8" fill="none" stroke="#dbeafe" strokeWidth="2" />
                            <circle cx="10" cy="10" r="8" fill="none" stroke="#3b82f6" strokeWidth="2"
                              strokeDasharray={`${uploadProgress * 0.5}, 50`} strokeLinecap="round"
                              style={{ transition: 'stroke-dasharray 0.15s ease-out' }} />
                          </svg>
                        </div>
                        <span className="text-[9px] font-semibold leading-none text-blue-600">{uploadProgress}%</span>
                      </div>
                    ) : (
                      <Image className="w-5 h-5" strokeWidth={2} />
                    )}
                  </button>
                  <textarea
                    ref={textareaRef}
                    value={messageInput}
                    onChange={(e) => {
                      setMessageInput(e.target.value);
                      const el = e.target;
                      el.style.height = 'auto';
                      const lineHeight = 22;
                      const maxHeight = lineHeight * 10 + 22;
                      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (messageInput.trim()) {
                          handleSendMessage(e as unknown as React.FormEvent);
                        }
                      }
                    }}
                    placeholder={t.customerService.typeMessage}
                    rows={1}
                    className="customer-service-composer-input chat-textarea-scroll block min-w-0 flex-1 resize-none rounded-xl border border-gray-200 bg-gray-100 text-gray-900 placeholder-gray-400 transition-all focus:border-blue-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-200"
                    autoComplete="off"
                    style={{ maxHeight: '242px' }}
                  />
                  <button
                    type="submit"
                    disabled={!messageInput.trim()}
                    className="customer-service-composer-send group flex flex-shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-600 font-medium text-white shadow-sm transition-all hover:bg-blue-700 active:scale-95 active:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={t.customerService.send}
                  >
                    <Send className="w-5 h-5 group-hover:translate-x-0.5 transition-transform" strokeWidth={2} />
                    <span className="hidden sm:inline text-sm font-semibold">{t.customerService.send}</span>
                  </button>
                </div>
              </form>
            </>
          )}
        </div>,
        document.body
      )}

      {notification && (
        <div className="fixed top-3 right-3 sm:top-6 sm:right-6 z-[60] animate-slide-in-right max-w-[calc(100%-1.5rem)] sm:max-w-none">
          <div className={`px-4 sm:px-6 py-3 sm:py-4 rounded-xl shadow-lg border ${
            notification.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
              : 'bg-red-50 border-red-200 text-red-700'
          }`}>
            <div className="flex items-center gap-2 sm:gap-3">
              {notification.type === 'success' ? (
                <div className="flex-shrink-0 w-5 h-5 sm:w-6 sm:h-6 bg-emerald-100 rounded-full flex items-center justify-center">
                  <svg className="w-3 h-3 sm:w-4 sm:h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                </div>
              ) : (
                <div className="flex-shrink-0 w-5 h-5 sm:w-6 sm:h-6 bg-red-100 rounded-full flex items-center justify-center">
                  <svg className="w-3 h-3 sm:w-4 sm:h-4" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                </div>
              )}
              <p className="font-medium text-sm sm:text-base">{notification.text}</p>
            </div>
          </div>
        </div>
      )}
      {previewImage && createPortal(
        <div
          className="employee-modal-backdrop fixed inset-0 z-[99999] flex items-center justify-center bg-black/90"
          onClick={(e) => { if (e.target === e.currentTarget) { setPreviewImage(null); setImageZoom(1); setImageDrag({ x: 0, y: 0 }); } }}
        >
          <div className="cs-viewer-toolbar absolute z-10 flex items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={() => setImageZoom(z => Math.max(0.5, z - 0.25))}
              className="cs-viewer-btn flex items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:bg-white/25"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              aria-label="Zoom out"
            >
              <ZoomOut className="h-5 w-5 shrink-0" />
            </button>
            <span className="w-[64px] sm:w-[72px] text-center font-mono text-[17px] sm:text-[19px] leading-none font-semibold tabular-nums text-white/90">{Math.round(imageZoom * 100)}%</span>
            <button
              type="button"
              onClick={() => setImageZoom(z => Math.min(5, z + 0.25))}
              className="cs-viewer-btn flex items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:bg-white/25"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              aria-label="Zoom in"
            >
              <ZoomIn className="h-5 w-5 shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => { setImageZoom(1); setImageDrag({ x: 0, y: 0 }); }}
              className="cs-viewer-btn flex items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 active:bg-white/25"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              aria-label="Reset"
            >
              <RotateCcw className="h-5 w-5 shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => { setPreviewImage(null); setImageZoom(1); setImageDrag({ x: 0, y: 0 }); }}
              className="cs-viewer-btn ml-1 flex items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25 active:bg-white/30"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              aria-label={t.common.close}
            >
              <X className="h-5 w-5 shrink-0" strokeWidth={2.25} />
            </button>
          </div>

          <div
            className="w-full h-full flex items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing"
            onMouseDown={(e) => { setIsDragging(true); dragStartRef.current = { x: e.clientX, y: e.clientY, ox: imageDrag.x, oy: imageDrag.y }; }}
            onMouseMove={(e) => { if (!isDragging) return; setImageDrag({ x: dragStartRef.current.ox + e.clientX - dragStartRef.current.x, y: dragStartRef.current.oy + e.clientY - dragStartRef.current.y }); }}
            onMouseUp={() => setIsDragging(false)}
            onMouseLeave={() => setIsDragging(false)}
            onTouchStart={(e) => { const t = e.touches[0]; setIsDragging(true); dragStartRef.current = { x: t.clientX, y: t.clientY, ox: imageDrag.x, oy: imageDrag.y }; }}
            onTouchMove={(e) => { if (!isDragging) return; const t = e.touches[0]; setImageDrag({ x: dragStartRef.current.ox + t.clientX - dragStartRef.current.x, y: dragStartRef.current.oy + t.clientY - dragStartRef.current.y }); }}
            onTouchEnd={() => setIsDragging(false)}
          >
            <img
              src={previewImage}
              alt="Preview"
              className="max-w-[95vw] max-h-[90vh] sm:max-w-[85vw] sm:max-h-[85vh] object-contain select-none"
              style={{
                transform: `scale(${imageZoom}) translate(${imageDrag.x / imageZoom}px, ${imageDrag.y / imageZoom}px)`,
                transition: isDragging ? 'none' : 'transform 0.2s ease-out',
              }}
              draggable={false}
            />
          </div>
        </div>,
        document.body
      )}
      {viewingRichCard && createPortal(
        <div
          className="employee-modal-backdrop fixed inset-0 z-[10000] flex items-stretch justify-stretch p-0 xl:items-center xl:justify-center xl:p-6 overflow-hidden touch-none"
          onClick={() => { richCardCancelRef.current = true; setViewingRichCard(null); }}
          style={{ background: 'rgba(15, 23, 42, 0.6)', backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)', animation: 'fadeIn 0.2s ease-out', WebkitTapHighlightColor: 'transparent', overscrollBehavior: 'contain' }}
        >
          <div
            className="employee-modal-surface relative w-full h-full xl:max-w-3xl xl:max-h-[85vh] xl:w-[680px] xl:h-auto bg-white rounded-none xl:rounded-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
            style={{ boxShadow: '0 25px 60px -12px rgba(0, 0, 0, 0.25)' }}
          >
            <div
              className="relative flex-shrink-0 overflow-hidden px-5 pb-5 bg-gradient-to-br from-[#1e40af] via-[#2563eb] to-[#1d4ed8]"
              style={{ paddingTop: 'calc(env(safe-area-inset-top) + 16px)' }}
            >
              <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/5 rounded-full blur-2xl"></div>
                <div className="absolute -bottom-8 -left-8 w-32 h-32 bg-blue-300/10 rounded-full blur-xl"></div>
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"></div>
                <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: 'linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)', backgroundSize: '32px 32px' }}></div>
              </div>
              <button
                onClick={() => { richCardCancelRef.current = true; setViewingRichCard(null); }}
                aria-label={t.common.close}
                className="emp-close-btn absolute top-3 right-3 z-20 flex items-center justify-center w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 active:bg-white/30 border border-white/20 transition-all active:scale-90"
                style={{ touchAction: 'manipulation', top: 'calc(env(safe-area-inset-top) + 12px)' }}
              >
                <X className="w-4 h-4 text-white" />
              </button>
              <div className="relative z-10">
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-white/15 rounded-full border border-white/20 w-fit mb-3">
                  <Clock className="w-3 h-3 text-blue-100" />
                  <span className="text-[11px] sm:text-xs text-blue-50 font-medium">
                    {new Date(viewingRichCard.created_at || new Date(0).toISOString()).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 p-2.5 bg-white/15 backdrop-blur-sm rounded-xl border border-white/20 shadow-lg shadow-blue-900/20">
                    <Megaphone className="w-6 h-6 text-white" />
                  </div>
                  <div className="flex-1 pr-8">
                    <h2 className="text-lg sm:text-xl font-bold text-white leading-snug break-words">{viewingRichCard.title || t.customerService.richCardNotice || 'View details'}</h2>
                    {viewingRichCard.subtitle && <p className="text-sm text-blue-100/80 mt-1 break-words">{viewingRichCard.subtitle}</p>}
                  </div>
                </div>
              </div>
              <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-blue-400/30 via-blue-300/50 to-blue-400/30"></div>
            </div>
            <div
              className="relative flex-1 overflow-y-auto min-h-0 hide-scrollbar"
              style={{ WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none', padding: '20px' }}
            >
              {loadingRichCardContent ? (
                <div className="flex items-center justify-center" style={{ minHeight: '40vh' }}>
                  <PageLoader variant="panel" className="!min-h-0" />
                </div>
              ) : (
                <div
                  className="announcement-content mobile-content text-[15px] leading-[1.75] text-gray-700"
                  dangerouslySetInnerHTML={{ __html: sanitizeAnnouncementContent(richCardFullContent || '') }}
                />
              )}
            </div>
            <div
              className="relative flex-shrink-0 border-t border-slate-100 bg-slate-50/80 pt-3 px-5"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
            >
              <button
                onClick={() => { richCardCancelRef.current = true; setViewingRichCard(null); }}
                className="w-full px-5 py-3 min-h-[44px] bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 active:from-blue-800 active:to-blue-700 text-white font-semibold text-sm rounded-xl transition-all duration-200 shadow-md shadow-blue-600/20 hover:shadow-lg hover:shadow-blue-600/30 active:scale-[0.98]"
              >
                {t.common.close}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
