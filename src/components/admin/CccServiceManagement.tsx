import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { Users, Plus, Send, Trash2, CreditCard as Edit2, User, MessageCircle, ArrowLeft, ChevronRight, X, Search, Tag, Filter, Image, Star, Clock, Bold, Underline, Strikethrough, Pencil, Check, Gift, DollarSign, MessageSquarePlus, FileText, BookOpen, Highlighter, Pin, Upload, Zap, CheckCheck, Eye, ZoomIn, ZoomOut, RotateCcw, Megaphone, AlignLeft, AlignCenter, AlignRight, Palette } from 'lucide-react';
import { sanitizeAnnouncementContent } from '../../lib/sanitizeHTML';
import CustomerAutoMessages, { type AutoMessageDraft } from './CustomerAutoMessages';
import CustomerAvatarPicker, { CustomerAvatarDisplay } from './CustomerAvatarPicker';
import TiptapEditor, { TiptapEditorRef } from './TiptapEditor';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import { fetchAdminChatUnreadCounts, fetchConversationSummaryRows, getCachedAdminWorkspaceData, getCachedConversationSummaries, invalidateAdminWorkspaceDataCache, invalidateConversationSummariesCache, prefetchAdminGroups, prefetchAdminWorkspaceData, prefetchConversationSummaries } from '../../lib/serviceWorkspaceCache';
import { uniqueRealtimeChannelName } from '../../lib/realtimeChannel';
import { stripTailwindStyles, sanitizeChatMessage } from '../../lib/sanitizeHTML';
import { processContentImages } from '../../lib/imageOptimizer';
import AdminGroupPicker, { type AdminGroup } from './AdminGroupPicker';
import EmployeeMetadataPopover from './EmployeeMetadataPopover';
import type { Database } from '../../types/database';
import { createFinancialOperationId, getAdminFinancialSessionToken } from '../../lib/auth';
import { mutateAuditedContent } from '../../lib/contentAudit';
import { uploadStorageObjectWithProgress } from '../../lib/storageUpload';

function extractImageOnlyUrl(content: string): string | null {
  const container = document.createElement('div');
  container.innerHTML = sanitizeChatMessage(content);
  const images = container.querySelectorAll('img');
  const text = (container.textContent || '').replace(/\u00a0/g, ' ').trim();

  if (images.length !== 1 || text) return null;
  return images[0].getAttribute('src') || null;
}

const AdminChatImage = memo(({ src, isUploading, uploadProgress, onClickImage }: {
  src: string;
  isUploading: boolean;
  uploadProgress: number;
  onClickImage: (url: string) => void;
}) => {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  return (
    <div className={`relative inline-flex w-fit max-w-full flex-col overflow-hidden rounded-lg ${loaded || errored ? '' : 'min-h-[60px] min-w-[60px]'}`} style={{ width: 'fit-content', height: 'fit-content', maxWidth: '200px', backgroundColor: 'transparent' }}>
      {!loaded && !errored && (
        <div className="absolute inset-0 bg-slate-800/60 flex items-center justify-center z-[1]">
          <div className="flex flex-col items-center gap-2">
            <div className="w-10 h-10 border-3 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
            <span className="text-xs text-slate-400">載入中……</span>
          </div>
        </div>
      )}
      {errored && (
        <div className="absolute inset-0 bg-slate-800/60 flex items-center justify-center z-[1]">
          <div className="flex flex-col items-center gap-2 text-slate-400">
            <Image className="w-8 h-8 opacity-50" />
            <span className="text-xs">載入失敗</span>
          </div>
        </div>
      )}
      <img
        ref={imgRef}
        src={src}
        alt="分享的圖片"
        className={`block rounded-lg object-contain cursor-pointer hover:opacity-90 transition-opacity shadow-sm ${
          loaded ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ width: 'auto', height: 'auto', maxWidth: '200px', maxHeight: '250px' }}
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
        onClick={(e: React.MouseEvent) => { if (!isUploading && loaded) { e.stopPropagation(); e.preventDefault(); onClickImage(src); } }}
      />
      {isUploading && (
        <div className="absolute inset-0 bg-black/20 backdrop-blur-[1px] flex flex-col items-center justify-center z-10">
          <div className="relative w-14 h-14">
            <svg className="w-14 h-14 -rotate-90" viewBox="0 0 44 44">
              <circle cx="22" cy="22" r="18" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="3" />
              <circle
                cx="22" cy="22" r="18" fill="none" stroke="white"
                strokeWidth="3"
                strokeDasharray={`${uploadProgress * 1.13}, 113`}
                strokeLinecap="round"
                className="drop-shadow-sm"
                style={{ transition: 'stroke-dasharray 0.15s ease-out' }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-white text-xs font-bold drop-shadow-sm">{uploadProgress}%</span>
            </div>
          </div>
          <div className="text-white/80 text-[10px] font-medium mt-1.5 tracking-wide">
            {uploadProgress < 20 ? '準備中……' :
             uploadProgress < 85 ? '上傳中……' :
             uploadProgress < 100 ? '處理中……' : '完成！'}
          </div>
        </div>
      )}
    </div>
  );
});

interface SimulatedCustomer {
  id: string;
  admin_id: string;
  customer_name: string;
  customer_id: string;
  customer_avatar: string;
  is_active: boolean;
  created_at: string;
  is_super?: boolean;
  super_customer_title?: string;
  badge_type?: 'diamond' | 'crown' | 'star' | 'vip' | 'premium';
  custom_avatar_url?: string | null;
  is_pinned?: boolean;
  vip_label?: string;
  remarks?: string;
  employee_pin_top?: boolean;
  employee_always_visible?: boolean;
  target_employee_id?: string | null;
  target_employee_ids?: string[] | null;
}

type CustomerBadgeType = NonNullable<SimulatedCustomer['badge_type']>;

interface Employee {
  id: string;
  username: string;
  employee_id: string;
  is_verified: boolean;
  is_active: boolean;
  remarks?: string;
  tags?: string[];
}

interface Message {
  id: string;
  customer_id: string;
  employee_id: string;
  sender_type: 'customer' | 'employee';
  message_content: string;
  message_type?: 'text' | 'image' | 'rating_request' | 'rating_result' | 'tip' | 'rich_card';
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
  is_read: boolean;
  source_type?: string;
  read_at?: string | null;
  created_at: string;
  rich_card_content_id?: string | null;
  content_frozen?: boolean;
  source_template_id?: string | null;
  source_auto_message_id?: string | null;
}

interface ConversationHistory {
  employee_id: string;
  employee_username: string;
  employee_number: string;
  employee_tags?: string[];
  employee_remarks?: string;
  message_count: number;
  last_message: string;
  last_message_time: string;
  unread_count: number;
  customer_id?: string;
  customer_name?: string;
  customer_avatar?: string | null;
  custom_avatar_url?: string | null;
}

type ConversationSummaryRow = Database['public']['Functions']['get_ccc_conversation_summaries']['Returns'][number];
type ConversationAnnotation = Database['public']['Functions']['get_ccc_conversation_annotations']['Returns'][number];
const conversationAnnotationKey = (customerId: string, employeeId: string) => `${customerId}:${employeeId}`;
type SimulatedCustomerInsert = Omit<Database['public']['Tables']['simulated_customers']['Insert'], 'customer_id'> & {
  customer_id?: string;
};
type SimulatedCustomerUpdate = Database['public']['Tables']['simulated_customers']['Update'];

function getCccErrorMessage(error: unknown, fallback: string) {
  const message = formatSupabaseError(error);
  return message && message !== 'undefined' ? message : fallback;
}

function dedupeConversationHistory(history: ConversationHistory[]) {
  const byConversation = new Map<string, ConversationHistory>();

  history.forEach(item => {
    if (!item.customer_id) return;
    const key = `${item.customer_id}:${item.employee_id}`;
    const existing = byConversation.get(key);
    if (!existing) {
      byConversation.set(key, item);
      return;
    }

    const latest = new Date(item.last_message_time).getTime() >= new Date(existing.last_message_time).getTime()
      ? item
      : existing;
    byConversation.set(key, {
      ...latest,
      message_count: Math.max(existing.message_count, item.message_count),
      unread_count: Math.max(existing.unread_count, item.unread_count),
    });
  });

  return Array.from(byConversation.values()).sort((a, b) =>
    new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime(),
  );
}

function buildConversationHistory(
  summaries: ConversationSummaryRow[],
  customers: SimulatedCustomer[],
  employees: Employee[],
) {
  const customersById = new Map(customers.map(customer => [customer.id, customer]));
  const employeesById = new Map(employees.map(employee => [employee.id, employee]));

  return dedupeConversationHistory(summaries
    .filter(row => customersById.has(row.customer_id))
    .map(row => {
      const customer = customersById.get(row.customer_id);
      const employee = employeesById.get(row.employee_id);
      return {
        employee_id: row.employee_id,
        employee_username: row.employee_username,
        employee_number: row.employee_number,
        employee_tags: employee?.tags || [],
        employee_remarks: employee?.remarks || '',
        customer_id: row.customer_id,
        customer_name: row.customer_name,
        customer_avatar: customer?.customer_avatar || row.customer_avatar,
        custom_avatar_url: customer?.custom_avatar_url || row.custom_avatar_url,
        message_count: Number(row.message_count),
        last_message: row.last_message_type === 'image' ? '__IMAGE__' : (row.last_message || ''),
        last_message_time: row.last_message_time || '',
        unread_count: Number(row.unread_count),
      };
    }));
}

interface MessageTemplate {
  id: string;
  admin_id: string;
  name: string;
  title: string | null;
  subtitle: string | null;
  content: string;
  content_type: 'text' | 'richtext' | 'rich_card';
  sort_order: number;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

interface CccServiceManagementProps {
  adminId: string;
  isSuperAdmin: boolean;
  isActive: boolean;
  initialEmployee?: {
    id: string;
    username: string;
    employeeId: string;
    adminId: string;
    adminUsername?: string;
    isVerified: boolean;
    isActive: boolean;
    remarks: string;
    tags: string[];
  } | null;
  onConsumeInitialEmployee?: () => void;
  onUnreadCountChange?: (delta: number) => void;
}

function CccServiceManagement({ adminId, isSuperAdmin, isActive, initialEmployee, onConsumeInitialEmployee, onUnreadCountChange }: CccServiceManagementProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wasActiveRef = useRef(false);
  const [adminGroups, setAdminGroups] = useState<AdminGroup[]>([]);
  const [selectedAdminId, setSelectedAdminId] = useState<string | null>(null);
  const selectedAdminIdRef = useRef<string | null>(null);
  const loadedWorkspaceAdminIdRef = useRef<string | null>(null);
  const adminGroupsInitializedRef = useRef(false);
  const [selectedAdminName, setSelectedAdminName] = useState<string>('');
  const [customers, setCustomers] = useState<SimulatedCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<SimulatedCustomer | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [selectedEmployee, setSelectedEmployee] = useState<Employee | null>(null);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistory[]>([]);
  const [allConversationHistory, setAllConversationHistory] = useState<ConversationHistory[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const MESSAGE_PAGE_SIZE = 50;
  const [messageInput, setMessageInput] = useState('');
  const [serviceTicketNumber, setServiceTicketNumber] = useState<string>('');
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const uploadingTempIdRef = useRef<string | null>(null);
  const pendingImageMessagesRef = useRef(new Map<string, Message>());
  // Sent message id -> last load request issued before its insert returned; only later loads may settle it.
  const pendingConfirmAfterRef = useRef(new Map<string, number>());
  const conversationMessagesCacheRef = useRef(new Map<string, Message[]>());
  const pendingConversationMessageRequestsRef = useRef(new Map<string, Promise<void>>());
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [adminImageZoom, setAdminImageZoom] = useState(1);
  const [adminImageDrag, setAdminImageDrag] = useState({ x: 0, y: 0 });
  const [adminIsDragging, setAdminIsDragging] = useState(false);
  const adminDragStartRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
  const [uploadingEditImage, setUploadingEditImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const replaceImageInputRef = useRef<HTMLInputElement>(null);
  const replacingImageMsgIdRef = useRef<string | null>(null);
  const [replacingImageMsgId, setReplacingImageMsgId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [editorFontSize, setEditorFontSize] = useState<'normal' | 'large' | 'xlarge' | null>(null);
  const [isBoldActive, setIsBoldActive] = useState(false);
  const [isUnderlineActive, setIsUnderlineActive] = useState(false);
  const [showBgColorPicker, setShowBgColorPicker] = useState<'main' | 'edit' | 'template' | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [, setEditingContent] = useState('');
  const [isEditBoldActive, setIsEditBoldActive] = useState(false);
  const [isEditUnderlineActive, setIsEditUnderlineActive] = useState(false);
  const [editEditorFontSize, setEditEditorFontSize] = useState<'normal' | 'large' | 'xlarge' | null>(null);
  const editEditorRef = useRef<HTMLDivElement>(null);
  const [, setPendingRating] = useState<Message | null>(null);
  const [showRatingModal, setShowRatingModal] = useState(false);
  const [ratingValue, setRatingValue] = useState(0);
  const [ratingComment, setRatingComment] = useState('');
  const [showCustomerForm, setShowCustomerForm] = useState(false);
  const [customerForm, setCustomerForm] = useState({
    name: '',
    avatar: 'customer-avatar:regular:0',
    isSuper: false,
    superTitle: '',
    customId: '',
    badgeType: '' as '' | CustomerBadgeType,
    vipLabel: 'VIP',
    customAvatarFile: null as File | null,
    useCustomAvatar: false,
    remarks: '',
    employeePinTop: false,
    employeeAlwaysVisible: false,
    targetEmployeeIds: [] as string[],
    _empSearch: ''
  });
  const [editingCustomer, setEditingCustomer] = useState<SimulatedCustomer | null>(null);
  const [savingCustomer, setSavingCustomer] = useState(false);
  const [autoMessageDrafts, setAutoMessageDrafts] = useState<AutoMessageDraft[]>([]);
  const [autoMessageDraftMasterEnabled, setAutoMessageDraftMasterEnabled] = useState(false);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmDeleting, setConfirmDeleting] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean;
    title: string;
    message: string;
    scope: 'customer' | 'message' | 'conversation';
    onConfirm: () => void;
  } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [showHistoryView, setShowHistoryView] = useState(true);
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [fromHistorySource, setFromHistorySource] = useState<'none' | 'customer' | 'all'>('none');
  const [fromHistoryFilterMode, setFromHistoryFilterMode] = useState<'all' | 'history' | 'new' | 'special'>('all');
  const [historyScope, setHistoryScope] = useState<'customer' | 'all'>('all');
  const allCustomersRef = useRef<SimulatedCustomer[]>([]);
  const allEmployeesRef = useRef<Employee[]>([]);
  const conversationHistoryRef = useRef<ConversationHistory[]>([]);
  const conversationHistoryLoadRequestRef = useRef(0);
  const conversationHistoryInitializedRef = useRef(false);
  const workspaceLoadRequestRef = useRef(0);
  const employeeRealtimeRequestRef = useRef(0);
  const consumedInitialEmployeeRef = useRef(false);
  const loadAdminDataRef = useRef<((targetAdminId: string, silent?: boolean, force?: boolean) => Promise<void>) | null>(null);
  const allConversationHistoryRef = useRef<ConversationHistory[]>([]);
  const adminGroupsLoadRequestRef = useRef(0);
  const adminUnreadRequestRef = useRef(0);
  const realtimeConversationIdsRef = useRef(new Set<string>());
  const [historyFilterMode, setHistoryFilterMode] = useState<'all' | 'history' | 'new' | 'special'>('all');
  const [historySearchQuery, setHistorySearchQuery] = useState('');
  const [annotations, setAnnotations] = useState<Record<string, ConversationAnnotation>>({});
  const [annotationsWorkspaceId, setAnnotationsWorkspaceId] = useState<string | null>(null);
  const [annotationLoadFailed, setAnnotationLoadFailed] = useState(false);
  const [annotationReloadKey, setAnnotationReloadKey] = useState(0);
  const [annotationDialog, setAnnotationDialog] = useState<{ kind: 'special' | 'note'; history: ConversationHistory; nextSpecial?: boolean } | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingAnnotation, setSavingAnnotation] = useState(false);
  const annotationLoadRequestRef = useRef(0);
  const [employeeGroupFilter, setEmployeeGroupFilter] = useState<'all' | 'chatted' | 'not_chatted'>('all');
  const [customerFilter, setCustomerFilter] = useState<'all' | 'super' | 'regular'>('all');
  const [adminUnreadCounts, setAdminUnreadCounts] = useState<Record<string, number>>({});
  const [showTipModal, setShowTipModal] = useState(false);
  const [tipAmount, setTipAmount] = useState('');
  const [sendingTip, setSendingTip] = useState(false);
  const tipOperationIdRef = useRef<string | null>(null);
  const [messageTemplates, setMessageTemplates] = useState<MessageTemplate[]>([]);
  const [showTemplateManager, setShowTemplateManager] = useState(false);
  const [showTemplatePopup, setShowTemplatePopup] = useState(false);
  const [showRichCardPopup, setShowRichCardPopup] = useState(false);
  const [templateManagerMode, setTemplateManagerMode] = useState<'richtext' | 'rich_card'>('richtext');
  const [templateForm, setTemplateForm] = useState({ name: '', title: '', subtitle: '', content: '', content_type: 'richtext' as 'text' | 'richtext' | 'rich_card' });
  const templateEditorRef = useRef<HTMLDivElement>(null);
  const templateImageInputRef = useRef<HTMLInputElement>(null);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [uploadingTemplateImage, setUploadingTemplateImage] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [docImportProgress, setDocImportProgress] = useState<{ phase: string; pct: number } | null>(null);
  const [templateBoldActive, setTemplateBoldActive] = useState(false);
  const [templateUnderlineActive, setTemplateUnderlineActive] = useState(false);
  const [templateStrikethroughActive, setTemplateStrikethroughActive] = useState(false);
  const [templateFontSize, setTemplateFontSize] = useState<string | null>(null);
  const [templateAlign, setTemplateAlign] = useState<'left' | 'center' | 'right'>('left');
  const [showTextColorPicker, setShowTextColorPicker] = useState<'template' | null>(null);
  const [, setTemplateTextColor] = useState<string | null>(null);
  const [sendingRichCard, setSendingRichCard] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);
  const richCardEditorRef = useRef<TiptapEditorRef>(null);
  const [richCardContent, setRichCardContent] = useState('');
  const [viewingRichCard, setViewingRichCard] = useState<Message | null>(null);
  const [richCardFullContent, setRichCardFullContent] = useState<string | null>(null);
  const [loadingRichCardContent, setLoadingRichCardContent] = useState(false);

  const openRichCardViewer = useCallback(async (msg: Message) => {
    setViewingRichCard(msg);
    setRichCardFullContent(null);
    setLoadingRichCardContent(true);

    const fetchFromRichCardContents = async (contentId: string): Promise<string | null> => {
      try {
        const { data, error } = await supabase
          .from('rich_card_contents')
          .select('html_content')
          .eq('id', contentId)
          .maybeSingle();
        return (!error && data) ? data.html_content : null;
      } catch {
        return null;
      }
    };

    const fetchFromTemplate = async (templateId: string): Promise<string | null> => {
      try {
        const { data, error } = await supabase
          .from('cs_message_templates')
          .select('content')
          .eq('id', templateId)
          .maybeSingle();
        return (!error && data) ? data.content : null;
      } catch {
        return null;
      }
    };

    const fetchFromAutoMessage = async (autoMsgId: string): Promise<string | null> => {
      try {
        const { data, error } = await supabase
          .from('customer_auto_messages')
          .select('content')
          .eq('id', autoMsgId)
          .maybeSingle();
        return (!error && data) ? data.content : null;
      } catch {
        return null;
      }
    };

    try {
      let html: string | null = null;
      if (msg.content_frozen && msg.rich_card_content_id) {
        html = await fetchFromRichCardContents(msg.rich_card_content_id);
      } else if (msg.source_template_id) {
        html = await fetchFromTemplate(msg.source_template_id);
      } else if (msg.source_auto_message_id) {
        html = await fetchFromAutoMessage(msg.source_auto_message_id);
      } else if (msg.rich_card_content_id) {
        html = await fetchFromRichCardContents(msg.rich_card_content_id);
      } else if (msg.message_type === 'rich_card') {
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setTimeout(r, 500));
          const { data: fresh } = await supabase
            .from('customer_employee_conversations')
            .select('rich_card_content_id, content_frozen, source_template_id, source_auto_message_id')
            .eq('id', msg.id)
            .maybeSingle();
          if (fresh?.content_frozen && fresh.rich_card_content_id) {
            html = await fetchFromRichCardContents(fresh.rich_card_content_id);
            break;
          }
          if (fresh?.source_template_id) {
            html = await fetchFromTemplate(fresh.source_template_id);
            break;
          }
          if (fresh?.source_auto_message_id) {
            html = await fetchFromAutoMessage(fresh.source_auto_message_id);
            break;
          }
          if (fresh?.rich_card_content_id) {
            html = await fetchFromRichCardContents(fresh.rich_card_content_id);
            break;
          }
        }
      }
      setRichCardFullContent(html || msg.message_content);
    } catch {
      setRichCardFullContent(msg.message_content);
    } finally {
      setLoadingRichCardContent(false);
    }
  }, []);

  conversationHistoryRef.current = conversationHistory;
  allConversationHistoryRef.current = allConversationHistory;

  const workspaceCustomerIds = useMemo(
    () => new Set(customers.map(customer => customer.id)),
    [customers],
  );
  const workspaceEmployeesById = useMemo(
    () => new Map(employees.map(employee => [employee.id, employee])),
    [employees],
  );
  const workspaceCustomersById = useMemo(
    () => new Map(customers.map(customer => [customer.id, customer])),
    [customers],
  );
  const currentAnnotations = useMemo(
    () => annotationsWorkspaceId === selectedAdminId ? annotations : {},
    [annotationsWorkspaceId, selectedAdminId, annotations],
  );

  useEffect(() => {
    const requestId = ++annotationLoadRequestRef.current;
    setAnnotations({});
    setAnnotationsWorkspaceId(null);
    setAnnotationLoadFailed(false);
    if (!isActive || !selectedAdminId) return;

    const loadAnnotations = async () => {
      try {
        const { data, error } = await supabase.rpc('get_ccc_conversation_annotations', {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_owner_admin_id: selectedAdminId,
        });
        if (error) throw error;
        if (requestId !== annotationLoadRequestRef.current) return;
        setAnnotations(Object.fromEntries((data || []).map(annotation => [
          conversationAnnotationKey(annotation.customer_id, annotation.employee_id), annotation,
        ])));
        setAnnotationsWorkspaceId(selectedAdminId);
      } catch (error) {
        if (requestId !== annotationLoadRequestRef.current) return;
        setAnnotationLoadFailed(true);
        setNotification({ type: 'error', text: getCccErrorMessage(error, '載入對話註記失敗') });
      }
    };
    void loadAnnotations();
  }, [isActive, selectedAdminId, annotationReloadKey]);

  const workspaceConversationHistory = useMemo(
    () => dedupeConversationHistory(allConversationHistory.filter(history =>
      Boolean(history.customer_id) &&
      workspaceCustomerIds.has(history.customer_id!)
    )),
    [allConversationHistory, workspaceCustomerIds],
  );
  const specialConversationCount = workspaceConversationHistory.filter(history =>
    currentAnnotations[conversationAnnotationKey(history.customer_id!, history.employee_id)]?.is_special
  ).length;
  const customerUnreadCountsForCards = useMemo(() => {
    const historyCounts: Record<string, number> = {};

    workspaceConversationHistory.forEach(history => {
      if (!history.customer_id) return;
      historyCounts[history.customer_id] = (historyCounts[history.customer_id] || 0) + history.unread_count;
    });

    return historyCounts;
  }, [workspaceConversationHistory]);
  const customerLatestMessageTimesForCards = useMemo(() => {
    const latestTimes: Record<string, number> = {};

    workspaceConversationHistory.forEach(history => {
      if (!history.customer_id) return;
      const messageTime = Date.parse(history.last_message_time) || 0;
      latestTimes[history.customer_id] = Math.max(latestTimes[history.customer_id] || 0, messageTime);
    });

    return latestTimes;
  }, [workspaceConversationHistory]);
  const customerLatestUnreadMessageTimesForCards = useMemo(() => {
    const latestTimes: Record<string, number> = {};

    workspaceConversationHistory.forEach(history => {
      if (!history.customer_id || history.unread_count <= 0) return;
      const messageTime = Date.parse(history.last_message_time) || 0;
      latestTimes[history.customer_id] = Math.max(latestTimes[history.customer_id] || 0, messageTime);
    });

    return latestTimes;
  }, [workspaceConversationHistory]);
  const conversationHistoryForView = useMemo(() => {
    const source = historyScope === 'all' ? workspaceConversationHistory : conversationHistory;
    return dedupeConversationHistory(source.filter(history =>
      Boolean(history.customer_id) &&
      workspaceCustomerIds.has(history.customer_id!)
    ));
  }, [conversationHistory, historyScope, workspaceConversationHistory, workspaceCustomerIds]);
  const chattedEmployeeIds = useMemo(
    () => new Set(conversationHistoryForView.map(history => history.employee_id)),
    [conversationHistoryForView],
  );

  const allTags = useMemo(
    () => Array.from(new Set(employees.flatMap(employee => employee.tags || []))).sort(),
    [employees],
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearchQuery(searchQuery), 80);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Filter employees based on search, tags, and chat history
  const filteredEmployees = useMemo(() => employees.filter(emp => {
    // Search filter
    const query = debouncedSearchQuery.toLowerCase();
    const matchesSearch = query === '' ||
      emp.username.toLowerCase().includes(query) ||
      emp.employee_id.toLowerCase().includes(query) ||
      (emp.tags || []).some(tag => tag.toLowerCase().includes(query)) ||
      (emp.remarks && emp.remarks.toLowerCase().includes(query));

    // Tag filter
    const matchesTags = selectedTags.length === 0 ||
      (emp.tags && selectedTags.some(tag => emp.tags!.includes(tag)));

    // Chat history filter
    const hasChatted = chattedEmployeeIds.has(emp.id);
    const matchesGroupFilter =
      employeeGroupFilter === 'all' ||
      (employeeGroupFilter === 'chatted' && hasChatted) ||
      (employeeGroupFilter === 'not_chatted' && !hasChatted);

    return matchesSearch && matchesTags && matchesGroupFilter;
  }).sort((a, b) => {
    const aSelected = selectedEmployee?.id === a.id ? 0 : 1;
    const bSelected = selectedEmployee?.id === b.id ? 0 : 1;
    return aSelected - bSelected;
  }), [employees, debouncedSearchQuery, selectedTags, employeeGroupFilter, chattedEmployeeIds, selectedEmployee]);

  const visibleConversationHistory = useMemo(() => {
    const query = historySearchQuery.trim().toLowerCase();

    return conversationHistoryForView
      .filter((history) => {
        if (historyScope === 'customer' && history.customer_id !== selectedCustomer?.id) return false;
        if (selectedEmployee && history.employee_id !== selectedEmployee.id) return false;
        const conversationNote = currentAnnotations[conversationAnnotationKey(history.customer_id!, history.employee_id)]?.note || '';
        if (historyFilterMode === 'new' && history.unread_count <= 0) return false;
        if (historyFilterMode === 'special' && !currentAnnotations[conversationAnnotationKey(history.customer_id!, history.employee_id)]?.is_special) return false;
        if (!query) return true;

        const employee = workspaceEmployeesById.get(history.employee_id);
        const employeeTags = employee?.tags?.length
          ? employee.tags
          : history.employee_tags || [];
        const employeeNote = employee?.remarks?.trim()
          || history.employee_remarks?.trim()
          || '';
        const searchableText = [
          history.customer_name,
          history.employee_username,
          history.employee_number,
          ...employeeTags,
          employeeNote,
          conversationNote,
        ].filter(Boolean).join(' ').toLowerCase();

        return searchableText.includes(query);
      })
      .sort((a, b) => {
        const aUnread = a.unread_count > 0;
        const bUnread = b.unread_count > 0;
        if (aUnread !== bUnread) return aUnread ? -1 : 1;

        const timeDifference = (Date.parse(b.last_message_time) || 0) - (Date.parse(a.last_message_time) || 0);
        if (timeDifference !== 0) return timeDifference;
        return b.unread_count - a.unread_count;
      });
  }, [conversationHistoryForView, workspaceEmployeesById, currentAnnotations, historyFilterMode, historySearchQuery, historyScope, selectedCustomer?.id, selectedEmployee]);

  const loadMessagesRef = useRef<(markAsRead?: boolean) => void>();
  const messagesLoadRequestRef = useRef(0);
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  selectedAdminIdRef.current = selectedAdminId;
  const justSentRef = useRef(false);
  const loadConversationHistoryRef = useRef<() => void>();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const isInitialLoadRef = useRef(true);
  const preserveScrollUntilRef = useRef(0);
  const loadOlderMessagesRef = useRef<() => void>();
  const historyListRef = useRef<HTMLDivElement>(null);
  const employeeListRef = useRef<HTMLDivElement>(null);
  const historyScrollTopRef = useRef(0);

  const messagesContainerCallbackRef = (node: HTMLDivElement | null) => {
    if (node) {
      messagesContainerRef.current = node;
    }
  };

  useEffect(() => {
    if (!selectedEmployee?.id) return;
    employeeListRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [selectedEmployee?.id]);

  const applyRealtimeConversation = useCallback((payload: { eventType?: string; new?: Partial<Message> }) => {
    const message = payload.new;
    if (!message?.id || !message.customer_id || !message.employee_id || !message.created_at) return;
    if (message.source_type && message.source_type !== 'ccc_service') return;
    if (!workspaceCustomerIds.has(message.customer_id) || !workspaceEmployeesById.has(message.employee_id)) return;

    if (payload.eventType === 'INSERT') {
      if (realtimeConversationIdsRef.current.has(message.id)) return;
      realtimeConversationIdsRef.current.add(message.id);
    }

    const conversationKey = `${message.customer_id}:${message.employee_id}`;
    const isUnreadEmployeeMessage = message.sender_type === 'employee' && message.is_read === false;
    const lastMessage = message.message_type === 'image' ? '__IMAGE__' : message.message_content || '';
    const updateHistory = (history: ConversationHistory[]) => {
      const existingIndex = history.findIndex(item => `${item.customer_id}:${item.employee_id}` === conversationKey);
      const existing = existingIndex >= 0 ? history[existingIndex] : null;
      const customer = allCustomersRef.current.find(item => item.id === message.customer_id);
      const employee = allEmployeesRef.current.find(item => item.id === message.employee_id);
      if (!existing && !customer) return history;

      const nextEntry: ConversationHistory = {
        employee_id: message.employee_id as string,
        employee_username: existing?.employee_username || employee?.username || 'Employee',
        employee_number: existing?.employee_number || employee?.employee_id || '',
        employee_tags: existing?.employee_tags || employee?.tags || [],
        employee_remarks: existing?.employee_remarks || employee?.remarks || '',
        message_count: (existing?.message_count || 0) + (payload.eventType === 'INSERT' ? 1 : 0),
        last_message: lastMessage,
        last_message_time: message.created_at as string,
        unread_count: (existing?.unread_count || 0) + (payload.eventType === 'INSERT' && isUnreadEmployeeMessage ? 1 : 0),
        customer_id: message.customer_id,
        customer_name: existing?.customer_name || customer?.customer_name,
        customer_avatar: existing?.customer_avatar || customer?.customer_avatar,
        custom_avatar_url: existing?.custom_avatar_url || customer?.custom_avatar_url,
      };

      const nextHistory = existingIndex >= 0
        ? history.map((item, index) => index === existingIndex ? { ...item, ...nextEntry } : item)
        : [...history, nextEntry];
      return nextHistory.sort((a, b) => new Date(b.last_message_time).getTime() - new Date(a.last_message_time).getTime());
    };

    const nextAllHistory = dedupeConversationHistory(updateHistory(allConversationHistoryRef.current));
    const nextConversationHistory = selectedCustomer?.id && selectedCustomer.id !== message.customer_id
      ? conversationHistoryRef.current
      : updateHistory(conversationHistoryRef.current);
    allConversationHistoryRef.current = nextAllHistory;
    conversationHistoryRef.current = nextConversationHistory;
    setAllConversationHistory(nextAllHistory);
    setConversationHistory(nextConversationHistory);
  }, [selectedCustomer?.id, workspaceCustomerIds, workspaceEmployeesById]);

  const loadAdminUnreadCounts = async (adminIds: string[]) => {
    const requestId = ++adminUnreadRequestRef.current;
    try {
      const { countsByAdmin } = await fetchAdminChatUnreadCounts('manager');
      if (requestId !== adminUnreadRequestRef.current) return;
      const counts: Record<string, number> = {};
      adminIds.forEach(id => { counts[id] = countsByAdmin.get(id) || 0; });
      setAdminUnreadCounts(prev =>
        adminIds.some(id => prev[id] !== counts[id]) || Object.keys(prev).length !== adminIds.length
          ? counts
          : prev
      );
    } catch (error) {
      console.error('Error loading admin unread counts:', formatSupabaseError(error));
    }
  };

  const loadAdminGroups = useCallback(async (targetEmployee?: {
    id: string;
    username: string;
    adminId: string;
    adminUsername?: string;
  } | null, silent = false, force = false) => {
    const requestId = ++adminGroupsLoadRequestRef.current;

    try {
      if (!silent) setLoading(true);

      if (targetEmployee) {
        selectedAdminIdRef.current = targetEmployee.adminId;
        setSelectedAdminId(targetEmployee.adminId);
        setSelectedAdminName(targetEmployee.adminUsername || '管理員群組');
        await loadAdminDataRef.current?.(targetEmployee.adminId, true, true);
        return;
      }

      const data = await prefetchAdminGroups(adminId, 'manager', force);
      if (requestId !== adminGroupsLoadRequestRef.current) return;

      if (data.length > 0) {
        await loadAdminUnreadCounts(data.map(g => g.admin_id));
      } else {
        setAdminUnreadCounts({});
      }

      if (requestId !== adminGroupsLoadRequestRef.current) return;
      adminGroupsInitializedRef.current = true;
      setAdminGroups(data);
    } catch (error) {
      if (requestId !== adminGroupsLoadRequestRef.current) return;
      console.error('Error loading admin groups:', formatSupabaseError(error));
      setNotification({ type: 'error', text: '載入管理員群組失敗' });
    } finally {
      if (!silent && requestId === adminGroupsLoadRequestRef.current) setLoading(false);
    }
  }, [adminId]);

  const loadConversationHistoryForCustomer = useCallback(async (customer: SimulatedCustomer) => {
    if (employees.length === 0) return;

    const requestId = ++conversationHistoryLoadRequestRef.current;

    try {
      const employeeById = new Map(employees.map(employee => [employee.id, employee]));
      const rows = await fetchConversationSummaryRows(customer.admin_id, 'manager', customer.id);

      if (requestId !== conversationHistoryLoadRequestRef.current) return;
      const nextHistory = buildConversationHistory(
        rows.filter(row => employeeById.has(row.employee_id)),
        [customer],
        employees,
      );
      conversationHistoryRef.current = nextHistory;
      setConversationHistory(nextHistory);
    } catch (error) {
      console.error('Error loading conversation history:', formatSupabaseError(error));
    }
  }, [employees]);

  const loadConversationHistory = useCallback(async () => {
    if (!selectedCustomer) return;
    return loadConversationHistoryForCustomer(selectedCustomer);
  }, [selectedCustomer, loadConversationHistoryForCustomer]);

  const loadAllConversationHistory = useCallback(async (overrideAdminIdOrForce?: string | boolean, force = false) => {
    const overrideAdminId = typeof overrideAdminIdOrForce === 'string' ? overrideAdminIdOrForce : undefined;
    const forceLoad = typeof overrideAdminIdOrForce === 'boolean' ? overrideAdminIdOrForce : force;
    const adminIdToUse = isSuperAdmin ? overrideAdminId || selectedAdminId : adminId;
    if (!adminIdToUse) return;
    const requestId = ++conversationHistoryLoadRequestRef.current;
    try {
      const data = await prefetchConversationSummaries<ConversationSummaryRow>(
        adminIdToUse,
        'manager',
        () => fetchConversationSummaryRows(adminIdToUse, 'manager'),
        forceLoad,
      );

      if (requestId !== conversationHistoryLoadRequestRef.current) return;

      const employeeIds = data.map(row => row.employee_id).filter(Boolean);
      const employeeMetaById = new Map<string, { id: string; tags?: string[]; remarks?: string }>();
      allEmployeesRef.current.forEach(employee => {
        employeeMetaById.set(employee.id, employee);
      });
      const missingEmployeeIds = employeeIds.filter((employeeId: string) => !employeeMetaById.has(employeeId));
      if (missingEmployeeIds.length > 0) {
        const { data: employeeMeta } = await supabase
          .from('users')
          .select('id, username, employee_id, is_verified, is_active, remarks, tags, created_by, created_at')
          .in('id', missingEmployeeIds)
          .eq('created_by', adminIdToUse);
        (employeeMeta || []).forEach(employee => {
          employeeMetaById.set(employee.id, employee);
        });
        if (employeeMeta?.length) {
          const mergedEmployees = Array.from(new Map(
            [...allEmployeesRef.current, ...(employeeMeta as Employee[])].map(employee => [employee.id, employee]),
          ).values()).sort((a, b) => a.username.localeCompare(b.username));
          allEmployeesRef.current = mergedEmployees;
          setEmployees(mergedEmployees);
        }
      }

      const customerIds = new Set(allCustomersRef.current.map(customer => customer.id));
      const summaryHistory = buildConversationHistory(
        data || [],
        allCustomersRef.current,
        allEmployeesRef.current,
      );
      const summaryByKey = new Map(summaryHistory.map(history => [
        `${history.customer_id}:${history.employee_id}`,
        history,
      ]));
      const supplementalHistory = allConversationHistoryRef.current.filter(history => {
        const key = `${history.customer_id}:${history.employee_id}`;
        const summary = summaryByKey.get(key);
        return customerIds.has(history.customer_id || '') &&
          (!summary || new Date(history.last_message_time).getTime() > new Date(summary.last_message_time).getTime());
      });
      const allHistory = dedupeConversationHistory([...summaryHistory, ...supplementalHistory]);

      if (requestId !== conversationHistoryLoadRequestRef.current) return;
      conversationHistoryInitializedRef.current = true;
      conversationHistoryRef.current = allHistory;
      allConversationHistoryRef.current = allHistory;
      setConversationHistory(allHistory);
      setAllConversationHistory(allHistory);
    } catch (error) {
      console.error('Error loading all conversation history:', formatSupabaseError(error));
    }
  }, [adminId, isSuperAdmin, selectedAdminId]);

  const loadOlderMessages = useCallback(async () => {
    if (!selectedCustomer || !selectedEmployee || loadingOlderMessages || !hasMoreMessages) return;
    if (!workspaceCustomerIds.has(selectedCustomer.id) || !workspaceEmployeesById.has(selectedEmployee.id)) return;
    if (messages.length === 0) return;

    setLoadingOlderMessages(true);
    const messageRequestId = messagesLoadRequestRef.current;
    try {
      const oldestTime = messages[0]?.created_at;
      const { data, error } = await supabase
        .from('customer_employee_conversations')
        .select('*, simulated_customers!inner(source_type)')
        .eq('customer_id', selectedCustomer.id)
        .eq('employee_id', selectedEmployee.id)
        .eq('simulated_customers.source_type', 'ccc_service')
        .lt('created_at', oldestTime)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);

      if (error) throw error;
      if (messagesLoadRequestRef.current !== messageRequestId) return;
      if (data && data.length > 0) {
        preserveScrollUntilRef.current = Date.now() + 500;
        setMessages(prev => [...data.reverse(), ...prev]);
        setHasMoreMessages(data.length >= MESSAGE_PAGE_SIZE);
      } else {
        setHasMoreMessages(false);
      }
    } catch (error) {
      console.error('Error loading older messages:', formatSupabaseError(error));
    } finally {
      if (messagesLoadRequestRef.current === messageRequestId) {
        setLoadingOlderMessages(false);
      }
    }
  }, [selectedCustomer, selectedEmployee, messages, loadingOlderMessages, hasMoreMessages, workspaceCustomerIds, workspaceEmployeesById]);

  const clearUnreadConversationLocally = useCallback((customerId: string, employeeId: string) => {
    const threadUnreadCount = Math.max(
      conversationHistoryRef.current.find(history => history.customer_id === customerId && history.employee_id === employeeId)?.unread_count || 0,
      allConversationHistoryRef.current.find(history => history.customer_id === customerId && history.employee_id === employeeId)?.unread_count || 0,
    );

    const nextConversationHistory = conversationHistoryRef.current.map(history => (
      history.customer_id === customerId && history.employee_id === employeeId
        ? { ...history, unread_count: 0 }
        : history
    ));
    const nextAllConversationHistory = allConversationHistoryRef.current.map(history => (
      history.customer_id === customerId && history.employee_id === employeeId
        ? { ...history, unread_count: 0 }
        : history
    ));
    conversationHistoryRef.current = nextConversationHistory;
    allConversationHistoryRef.current = nextAllConversationHistory;
    setConversationHistory(nextConversationHistory);
    setAllConversationHistory(nextAllConversationHistory);

    return threadUnreadCount;
  }, []);

  const restoreCachedMessages = useCallback((customerId: string, employeeId: string) => {
    const cacheKey = `${customerId}:${employeeId}`;
    const cachedMessages = conversationMessagesCacheRef.current.get(cacheKey);
    if (!cachedMessages) return false;

    const pendingMessages = Array.from(pendingImageMessagesRef.current.values()).filter(message =>
      message.customer_id === customerId &&
      message.employee_id === employeeId &&
      !cachedMessages.some(cached => cached.id === message.id || (cached.image_url && cached.image_url === message.image_url))
    );
    const visibleMessages = [...cachedMessages, ...pendingMessages]
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    setMessages(visibleMessages);
    setHasMoreMessages(cachedMessages.length >= MESSAGE_PAGE_SIZE);
    setMessagesLoading(false);
    return true;
  }, []);

  const prefetchMessages = useCallback(async (customerId: string, employeeId: string) => {
    const cacheKey = `${customerId}:${employeeId}`;
    if (conversationMessagesCacheRef.current.has(cacheKey)) return;

    const pending = pendingConversationMessageRequestsRef.current.get(cacheKey);
    if (pending) return pending;

    const request = Promise.resolve(
      supabase
        .from('customer_employee_conversations')
      .select('*, simulated_customers!inner(source_type)')
      .eq('customer_id', customerId)
      .eq('employee_id', employeeId)
      .eq('simulated_customers.source_type', 'ccc_service')
      .order('created_at', { ascending: false })
      .limit(MESSAGE_PAGE_SIZE)
      .then(
        ({ data, error }) => {
          if (!error && data) {
            conversationMessagesCacheRef.current.set(cacheKey, data.reverse());
          }
          pendingConversationMessageRequestsRef.current.delete(cacheKey);
        },
        (error: unknown) => {
          console.error('Error prefetching messages:', formatSupabaseError(error));
          pendingConversationMessageRequestsRef.current.delete(cacheKey);
        },
      ),
    );

    pendingConversationMessageRequestsRef.current.set(cacheKey, request);
    return request;
  }, []);

  const loadMessages = useCallback(async (markAsRead: boolean = true) => {
    if (!selectedCustomer || !selectedEmployee) return;
    if (!workspaceCustomerIds.has(selectedCustomer.id) || !workspaceEmployeesById.has(selectedEmployee.id)) return;

    const cacheKey = `${selectedCustomer.id}:${selectedEmployee.id}`;
    const workspaceRequestId = workspaceLoadRequestRef.current;
    const targetAdminId = selectedAdminIdRef.current;
    restoreCachedMessages(selectedCustomer.id, selectedEmployee.id);
    const requestId = ++messagesLoadRequestRef.current;
    try {
      const { data, error } = await supabase
        .from('customer_employee_conversations')
        .select('*, simulated_customers!inner(source_type)')
        .eq('customer_id', selectedCustomer.id)
        .eq('employee_id', selectedEmployee.id)
        .eq('simulated_customers.source_type', 'ccc_service')
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE_SIZE);

      if (error) throw error;
      if (requestId !== messagesLoadRequestRef.current) return;
      const sorted = (data || []).reverse();
      const pendingMessages = Array.from(pendingImageMessagesRef.current.values()).filter(message =>
        message.customer_id === selectedCustomer.id && message.employee_id === selectedEmployee.id
      );
      const settledPendingIds = new Set(
        pendingMessages
          .filter(pending => {
            const confirmAfter = pendingConfirmAfterRef.current.get(pending.id);
            return (confirmAfter !== undefined && requestId > confirmAfter)
              || sorted.some(message => message.id === pending.id || (pending.image_url && message.image_url === pending.image_url));
          })
          .map(message => message.id)
      );
      settledPendingIds.forEach(messageId => {
        pendingImageMessagesRef.current.delete(messageId);
        pendingConfirmAfterRef.current.delete(messageId);
      });
      const visibleMessages = [...sorted, ...pendingMessages.filter(message => !settledPendingIds.has(message.id))]
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      conversationMessagesCacheRef.current.set(cacheKey, sorted);
      setMessages(visibleMessages);
      setHasMoreMessages((data || []).length >= MESSAGE_PAGE_SIZE);
      setMessagesLoading(false);

      if (markAsRead && isActiveRef.current) {
        const customerId = selectedCustomer.id;
        const employeeId = selectedEmployee.id;

        const { error: markReadError } = await supabase
          .from('customer_employee_conversations')
          .update({ is_read: true, read_at: new Date().toISOString() })
          .eq('customer_id', customerId)
          .eq('employee_id', employeeId)
          .eq('sender_type', 'employee')
          .eq('is_read', false);

        if (
          requestId !== messagesLoadRequestRef.current ||
          workspaceRequestId !== workspaceLoadRequestRef.current ||
          targetAdminId !== selectedAdminIdRef.current
        ) return;

        if (markReadError) {
          console.error('Error marking conversation as read:', markReadError);
          void loadAllConversationHistory(targetAdminId || undefined, true);
        } else {
          const threadUnreadCount = clearUnreadConversationLocally(customerId, employeeId);
          if (threadUnreadCount > 0) onUnreadCountChange?.(-threadUnreadCount);
          void loadAllConversationHistory(targetAdminId || undefined, true);
        }
      }

      if (requestId !== messagesLoadRequestRef.current) return;

      const { data: sessionData } = await supabase.rpc('get_or_create_service_session', {
        p_customer_id: selectedCustomer.id,
        p_employee_id: selectedEmployee.id
      });

      if (requestId !== messagesLoadRequestRef.current) return;
      if (sessionData && sessionData.length > 0) {
        setServiceTicketNumber(sessionData[0].service_ticket_number);
      }
    } catch (error) {
      if (requestId !== messagesLoadRequestRef.current) return;
      console.error('Error loading messages:', formatSupabaseError(error));
      setMessagesLoading(false);
    }
  }, [clearUnreadConversationLocally, loadAllConversationHistory, onUnreadCountChange, restoreCachedMessages, selectedCustomer, selectedEmployee, workspaceCustomerIds, workspaceEmployeesById]);

  useEffect(() => {
    loadMessagesRef.current = loadMessages;
    loadConversationHistoryRef.current = loadConversationHistory;
  }, [loadMessages, loadConversationHistory]);

  // Reset to first panel when tab becomes active (unless navigating with initial employee)
  useEffect(() => {
    if (isActive && !wasActiveRef.current && !initialEmployee) {
      setSelectedCustomer(null);
      setSelectedEmployee(null);
      setMessages([]);
      setConversationHistory(allConversationHistoryRef.current);
      setShowHistoryView(true);
      setHistoryScope('all');
      setHistoryFilterMode('all');
    }

    wasActiveRef.current = isActive;
  }, [isActive, initialEmployee]);

  useEffect(() => {
    if (!isActive) return;

    if (!initialEmployee && consumedInitialEmployeeRef.current) {
      consumedInitialEmployeeRef.current = false;
      return;
    }

    if (isSuperAdmin) {
      if (!initialEmployee) {
        const activeWorkspaceId = selectedAdminIdRef.current;
        if (activeWorkspaceId) {
          const hasLoadedWorkspace = loadedWorkspaceAdminIdRef.current === activeWorkspaceId
            && conversationHistoryInitializedRef.current;
          void loadAdminDataRef.current?.(activeWorkspaceId, hasLoadedWorkspace, hasLoadedWorkspace);
        } else {
          const hasLoadedGroups = adminGroupsInitializedRef.current;
          void loadAdminGroups(null, hasLoadedGroups, hasLoadedGroups);
        }
      }
    } else {
      selectedAdminIdRef.current = adminId;
      setSelectedAdminId(adminId);
      if (!initialEmployee) {
        const hasLoadedWorkspace = loadedWorkspaceAdminIdRef.current === adminId
          && conversationHistoryInitializedRef.current;
        void loadAdminDataRef.current?.(adminId, hasLoadedWorkspace, hasLoadedWorkspace);
      }
    }
  }, [adminId, isActive, isSuperAdmin, initialEmployee, loadAdminGroups]);

  useEffect(() => {
    if (!isActive || !initialEmployee) return;

    const immediateEmployee: Employee = {
      id: initialEmployee.id,
      username: initialEmployee.username,
      employee_id: initialEmployee.employeeId,
      is_verified: initialEmployee.isVerified,
      is_active: initialEmployee.isActive,
      remarks: initialEmployee.remarks,
      tags: initialEmployee.tags,
    };

    const cachedWorkspace = getCachedAdminWorkspaceData<SimulatedCustomer, Employee>(initialEmployee.adminId, 'manager');
    const cachedSummaries = getCachedConversationSummaries<ConversationSummaryRow>(initialEmployee.adminId, 'manager');
    const nextCustomers = cachedWorkspace?.customers || [];
    const cachedEmployees = cachedWorkspace?.employees || [];
    const nextEmployees = cachedEmployees.some(employee => employee.id === immediateEmployee.id)
      ? cachedEmployees
      : [immediateEmployee, ...cachedEmployees];
    const nextHistory = cachedSummaries
      ? buildConversationHistory(cachedSummaries, nextCustomers, nextEmployees)
      : [];

    conversationHistoryInitializedRef.current = cachedSummaries !== null;
    setLoading(false);
    setSelectedCustomer(null);
    setSelectedEmployee(immediateEmployee);
    setCustomers(nextCustomers);
    setEmployees(nextEmployees);
    allCustomersRef.current = nextCustomers;
    allEmployeesRef.current = nextEmployees;
    setMessages([]);
    setConversationHistory(nextHistory);
    setAllConversationHistory(nextHistory);
    conversationHistoryRef.current = nextHistory;
    allConversationHistoryRef.current = nextHistory;
    setShowHistoryView(true);

    if (isSuperAdmin) {
      void loadAdminGroups(initialEmployee, true);
    } else {
      setSelectedAdminId(adminId);
      void loadAdminDataRef.current?.(adminId, true, true);
    }
  }, [adminId, isActive, isSuperAdmin, initialEmployee, loadAdminGroups]);

  // Handle initial employee navigation from other tabs
  useEffect(() => {
    if (!isActive || !initialEmployee || loading) return;
    if (employees.length > 0) {
      const found = employees.find(e => e.id === initialEmployee.id);
      if (found) {
        setSearchQuery('');
        setSelectedTags([]);
        setEmployeeGroupFilter('all');
        setSelectedCustomer(null);
        setConversationHistory([]);
        conversationHistoryRef.current = [];
        setSelectedEmployee(found);
        setMessages([]);
        setShowHistoryView(true);
        setHistoryScope('all');
        setHistoryFilterMode('all');
        if (onConsumeInitialEmployee) {
          consumedInitialEmployeeRef.current = true;
          onConsumeInitialEmployee();
        }
      }
    }
  }, [isActive, initialEmployee, loading, employees, onConsumeInitialEmployee]);

  // Auto-load all conversation history when admin is selected and no customer is focused
  useEffect(() => {
    if (isActive && !loading && !conversationHistoryInitializedRef.current && selectedAdminId && customers.length > 0 && employees.length > 0 && !selectedCustomer && !selectedEmployee && showHistoryView && historyScope === 'all') {
      void loadAllConversationHistory(selectedAdminId, true);
    }
  }, [isActive, loading, selectedAdminId, customers.length, employees.length, selectedCustomer, selectedEmployee, showHistoryView, historyScope, loadAllConversationHistory]);

  // Subscribe to realtime updates for admins table
  useEffect(() => {
    if (isSuperAdmin) {
      const channel = supabase
        .channel(uniqueRealtimeChannelName('manager_service_admins_realtime'))
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'admins'
        }, () => {
          loadAdminGroups(null, true, true);
        })
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [isSuperAdmin, loadAdminGroups]);

  // Refresh summary counts while the workspace picker is visible
  useEffect(() => {
    if (!isSuperAdmin || selectedAdminId || adminGroups.length === 0) return;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const fallbackTimer = window.setInterval(() => {
      void loadAdminGroups(null, true, true);
    }, 15000);
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void loadAdminGroups(null, true, true);
      }, 300);
    };

    const channel = supabase
      .channel(uniqueRealtimeChannelName('manager_workspace_summary_realtime'))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'simulated_customers' }, scheduleRefresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_employee_conversations' }, scheduleRefresh)
      .subscribe();

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      window.clearInterval(fallbackTimer);
      supabase.removeChannel(channel);
    };
  }, [isSuperAdmin, selectedAdminId, adminGroups.length, loadAdminGroups]);

  // Subscribe to realtime updates for admin unread counts
  useEffect(() => {
    if (isSuperAdmin && adminGroups.length > 0) {
      const adminIds = adminGroups.map(g => g.admin_id);
      let refreshTimer: ReturnType<typeof setTimeout> | null = null;
      // Throttled, not debounced: a steady stream of messages must not keep postponing the refresh.
      const scheduleRefresh = () => {
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          void loadAdminUnreadCounts(adminIds);
        }, 1000);
      };
      const channel = supabase
        .channel(uniqueRealtimeChannelName('manager_service_admin_unread_counts_realtime'))
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'customer_employee_conversations'
        }, () => {
          adminIds.forEach(id => invalidateConversationSummariesCache(id, 'manager'));
          scheduleRefresh();
        })
        .subscribe();

      return () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        supabase.removeChannel(channel);
      };
    }
  }, [isSuperAdmin, adminGroups]);



  useEffect(() => {
    if (!isActive || !selectedAdminId || !selectedCustomer?.id) return;

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshMessages = false;
    const scheduleRefresh = (shouldRefreshMessages: boolean) => {
      refreshMessages = refreshMessages || shouldRefreshMessages;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        const shouldLoadMessages = refreshMessages;
        refreshMessages = false;
        refreshTimer = null;
        if (shouldLoadMessages && selectedEmployee?.id) {
          loadMessagesRef.current?.(isActive);
        }
        loadConversationHistoryRef.current?.();
      }, 120);
    };

    const channel = supabase
      .channel(uniqueRealtimeChannelName(`ccc_service_conversations_${selectedCustomer.id}`))
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'customer_employee_conversations',
        filter: `customer_id=eq.${selectedCustomer.id}`
      }, (payload) => {
        const newMessage = payload.new as Partial<Message>;
        scheduleRefresh(!(justSentRef.current && newMessage.sender_type === 'customer'));
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'customer_employee_conversations',
        filter: `customer_id=eq.${selectedCustomer.id}`
      }, () => scheduleRefresh(true))
      .on('postgres_changes', {
        event: 'DELETE',
        schema: 'public',
        table: 'customer_employee_conversations',
        filter: `customer_id=eq.${selectedCustomer.id}`
      }, () => scheduleRefresh(true))
      .subscribe();

    // Realtime can drop silently; this keeps new employee messages and read receipts current.
    const fallbackTimer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || !selectedEmployee?.id) return;
      const container = messagesContainerRef.current;
      if (container && Math.abs(container.scrollTop) > 150) return;
      loadMessagesRef.current?.(isActive);
      loadConversationHistoryRef.current?.();
    }, 15000);

    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      window.clearInterval(fallbackTimer);
      supabase.removeChannel(channel);
    };
  }, [isActive, selectedAdminId, selectedCustomer?.id, selectedEmployee?.id]);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  useEffect(() => {
    if (selectedAdminId && customers.length > 0) {
      let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
      const reconcileAfterChange = () => {
        if (reconcileTimer) clearTimeout(reconcileTimer);
        reconcileTimer = setTimeout(() => {
          reconcileTimer = null;
          void loadAllConversationHistory(undefined, true);
        }, 120);
      };
      const fallbackTimer = window.setInterval(() => {
        void loadAllConversationHistory(undefined, true);
      }, 15000);
      const channel = supabase
        .channel(uniqueRealtimeChannelName(`ccc_service_unread_counts_${selectedAdminId}`))
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'customer_employee_conversations'
        }, (payload) => {
          const changedMessage = payload.new && Object.keys(payload.new).length > 0
            ? payload.new as Partial<Message>
            : payload.old as Partial<Message>;
          if (
            !changedMessage.customer_id
            || !changedMessage.employee_id
            || !workspaceCustomerIds.has(changedMessage.customer_id)
            || !workspaceEmployeesById.has(changedMessage.employee_id)
          ) return;

          conversationHistoryLoadRequestRef.current += 1;
          applyRealtimeConversation({
            eventType: payload.eventType,
            new: payload.new as Partial<Message>,
          });
          if (payload.eventType !== 'INSERT') {
            reconcileAfterChange();
          }
        })
        .subscribe();

      return () => {
        if (reconcileTimer) clearTimeout(reconcileTimer);
        window.clearInterval(fallbackTimer);
        supabase.removeChannel(channel);
      };
    }
  }, [selectedAdminId, customers, applyRealtimeConversation, loadAllConversationHistory, workspaceCustomerIds, workspaceEmployeesById]);

  // Subscribe to realtime updates for employees (users table)
  useEffect(() => {
    if (isActive && selectedAdminId) {
      const targetAdminId = selectedAdminId;
      const channel = supabase
        .channel(uniqueRealtimeChannelName(`ccc_service_employees_realtime_${selectedAdminId}`))
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'users'
        }, (payload) => {
          const changedEmployee = (payload.new && Object.keys(payload.new).length > 0
            ? payload.new
            : payload.old) as { id?: unknown; created_by?: unknown };
          const employeeId = typeof changedEmployee.id === 'string' ? changedEmployee.id : null;
          const createdBy = typeof changedEmployee.created_by === 'string' ? changedEmployee.created_by : null;
          if (createdBy !== targetAdminId && (!employeeId || !allEmployeesRef.current.some(employee => employee.id === employeeId))) return;

          const requestId = ++employeeRealtimeRequestRef.current;
          invalidateAdminWorkspaceDataCache(targetAdminId, 'manager');
          supabase
            .from('users')
            .select('id, username, employee_id, is_verified, is_active, remarks, tags, created_by, created_at')
            .eq('created_by', targetAdminId)
            .order('username')
            .then(
              ({ data, error }) => {
                if (selectedAdminIdRef.current !== targetAdminId || requestId !== employeeRealtimeRequestRef.current) return;
                if (!error && data) {
                  setEmployees(data);
                  allEmployeesRef.current = data;
                  void loadAllConversationHistory(undefined, true);
                }
              },
              (error: unknown) => {
                console.error('Error loading employees:', formatSupabaseError(error));
              },
            );
        })
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [isActive, selectedAdminId, loadAllConversationHistory]);

  const checkPendingRating = useCallback(async () => {
    const customerId = selectedCustomer?.id;
    const employeeId = selectedEmployee?.id;
    if (!customerId || !employeeId) return;

    try {
      const { data, error } = await supabase
        .from('customer_employee_conversations')
        .select('*')
        .eq('customer_id', customerId)
        .eq('employee_id', employeeId)
        .eq('message_type', 'rating_request')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw error;

      if (data) {
        const hasRating = messagesRef.current.some(
          m => m.message_type === 'rating_result' &&
          new Date(m.created_at) > new Date(data.created_at)
        );

        if (!hasRating) {
          setPendingRating(data);
        } else {
          setPendingRating(null);
        }
      } else {
        setPendingRating(null);
      }
    } catch (error) {
      console.error('Error checking pending rating:', formatSupabaseError(error));
    }
  }, [selectedCustomer?.id, selectedEmployee?.id]);

  useEffect(() => {
    if (isActive && selectedCustomer?.id && selectedEmployee?.id) {
      const channel = supabase
        .channel(uniqueRealtimeChannelName(`rating_requests_${selectedCustomer.id}_${selectedEmployee.id}`))
        .on('postgres_changes', {
          event: 'INSERT',
          schema: 'public',
          table: 'rating_requests',
          filter: `customer_id=eq.${selectedCustomer.id}`
        }, () => {
          checkPendingRating();
        })
        .subscribe();

      return () => {
        supabase.removeChannel(channel);
      };
    }
  }, [isActive, selectedCustomer?.id, selectedEmployee?.id, checkPendingRating]);

  useEffect(() => {
    if (isActive && selectedCustomer?.id && employees.length > 0) {
      loadConversationHistory();
    }
  }, [isActive, selectedCustomer?.id, employees.length, loadConversationHistory]);

  // Remove redundant reload - loadAllConversationHistory is already called via realtime subscription
  // useEffect for customers/employees count change is not needed

  useEffect(() => {
    if (isActive && selectedEmployee?.id && selectedCustomer?.id) {
      isInitialLoadRef.current = true;
      setMessagesLoading(true);
      loadMessages();
      checkPendingRating();
    }
  }, [isActive, selectedEmployee?.id, selectedCustomer?.id, loadMessages, checkPendingRating]);

  const scrollToBottom = useCallback((smooth: boolean = true) => {
    const container = messagesContainerRef.current;
    if (container) {
      if (smooth) {
        container.scrollTo({
          top: 0,
          behavior: 'smooth'
        });
      } else {
        container.scrollTop = 0;
      }
    }
  }, []);

  const prevMessageCountRef = useRef(0);

  useEffect(() => {
    if (messages.length > 0) {
      if (Date.now() < preserveScrollUntilRef.current) {
        prevMessageCountRef.current = messages.length;
        return;
      }
      const hadNewMessage = messages.length > prevMessageCountRef.current;
      prevMessageCountRef.current = messages.length;
      if (isInitialLoadRef.current || hadNewMessage) {
        scrollToBottom(false);
      }
      if (isInitialLoadRef.current) {
        isInitialLoadRef.current = false;
      }
    }
  }, [messages, scrollToBottom]);

  useEffect(() => {
    loadOlderMessagesRef.current = loadOlderMessages;
  }, [loadOlderMessages]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const maxScroll = container.scrollHeight - container.clientHeight;
      // Column-reverse containers report 0 at the newest message and negative values above it.
      if (maxScroll > 0 && maxScroll - Math.abs(container.scrollTop) < 100 && hasMoreMessages && !loadingOlderMessages) {
        loadOlderMessagesRef.current?.();
      }
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [hasMoreMessages, loadingOlderMessages]);

  const pendingScrollRestoreRef = useRef(false);

  useEffect(() => {
    if (showHistoryView && pendingScrollRestoreRef.current && historyScrollTopRef.current > 0) {
      requestAnimationFrame(() => {
        if (historyListRef.current) {
          historyListRef.current.scrollTop = historyScrollTopRef.current;
        }
        pendingScrollRestoreRef.current = false;
      });
    }
  }, [showHistoryView, conversationHistory]);


  const handleSubmitRating = async () => {
    if (!selectedCustomer || !selectedEmployee || ratingValue === 0) return;

    try {
      const { error } = await supabase
        .from('customer_employee_conversations')
        .insert({
          customer_id: selectedCustomer.id,
          employee_id: selectedEmployee.id,
          sender_type: 'customer',
          message_type: 'rating_result',
          message_content: '已提交評分',
          rating_data: {
            rating: ratingValue,
            comment: ratingComment.trim() || null,
            employee_id: selectedEmployee.id,
          },
          is_read: false,
          source_type: 'ccc_service',
        });

      if (error) throw error;

      setNotification({ type: 'success', text: '評分已成功提交！' });
      setShowRatingModal(false);
      setRatingValue(0);
      setRatingComment('');
      setPendingRating(null);
      loadMessages();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '提交評分失敗') });
    }
  };

  const handleSendTip = async () => {
    if (!selectedCustomer || !selectedEmployee || !tipAmount) return;
    const amount = parseFloat(tipAmount);
    if (isNaN(amount) || amount <= 0) {
      setNotification({ type: 'error', text: '請輸入有效的打賞金額' });
      return;
    }

    setSendingTip(true);
    try {
      tipOperationIdRef.current ||= createFinancialOperationId();
      const { data: tipResult, error: tipError } = await supabase.rpc(
        'send_customer_service_tip_atomic',
        {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_customer_id: selectedCustomer.id,
          p_employee_id: selectedEmployee.id,
          p_amount: amount,
          p_source_type: 'ccc_service',
          p_operation_id: tipOperationIdRef.current,
        },
      );

      if (tipError) throw tipError;
      if (!tipResult?.success) throw new Error(tipResult?.error || '處理打賞失敗');
      tipOperationIdRef.current = null;

      setNotification({ type: 'success', text: `已向 ${selectedEmployee.username} 送出 $${amount.toFixed(2)} 的打賞！` });
      setShowTipModal(false);
      setTipAmount('');
      loadMessages();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '送出打賞失敗') });
    } finally {
      setSendingTip(false);
    }
  };

  const loadTemplates = useCallback(async () => {
    if (!selectedAdminId) return;
    try {
      const { data, error } = await supabase
        .from('cs_message_templates')
        .select('id, admin_id, name, title, subtitle, content_type, sort_order, is_pinned, created_at, updated_at, source_type')
        .eq('admin_id', selectedAdminId)
        .eq('source_type', 'ccc_service')
        .order('is_pinned', { ascending: false })
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });
      if (error) throw error;
      setMessageTemplates((data || []).map(t => ({ ...t, content: '' })) as MessageTemplate[]);
    } catch (error) {
      console.error('Error loading templates:', formatSupabaseError(error));
    }
  }, [selectedAdminId]);

  const fetchTemplateContent = useCallback(async (templateId: string): Promise<string | null> => {
    try {
      const { data, error } = await supabase
        .from('cs_message_templates')
        .select('content')
        .eq('id', templateId)
        .maybeSingle();
      if (error || !data) return null;
      return data.content;
    } catch {
      return null;
    }
  }, []);

  const getTemplateContent = (): string => {
    if (templateForm.content_type === 'rich_card') {
      return richCardEditorRef.current?.getContent() || richCardContent || templateForm.content;
    }
    if (templateForm.content_type === 'richtext' && templateEditorRef.current) {
      return stripTailwindStyles(templateEditorRef.current.innerHTML);
    }
    return templateForm.content;
  };

  const isTemplateContentEmpty = (): boolean => {
    if (templateForm.content_type === 'rich_card') {
      const content = richCardEditorRef.current?.getContent() || richCardContent || templateForm.content;
      const stripped = content.replace(/<[^>]*>/g, '').trim();
      const hasMedia = /<(img|video|iframe|source)\s/i.test(content);
      return !stripped && !hasMedia;
    }
    if (templateForm.content_type === 'richtext' && templateEditorRef.current) {
      const hasText = (templateEditorRef.current.textContent || '').trim().length > 0;
      const hasMedia = templateEditorRef.current.querySelectorAll('img, video, iframe, source').length > 0;
      return !hasText && !hasMedia;
    }
    return !templateForm.content.trim();
  };

  const handleCreateTemplate = async () => {
    if (!selectedAdminId || !templateForm.name.trim()) return;
    const content = getTemplateContent();
    if (isTemplateContentEmpty()) return;
    setSavingTemplate(true);
    try {
      const folder = templateForm.content_type === 'rich_card' ? 'rich-cards' : 'templates';
      const optimizedContent = (templateForm.content_type === 'richtext' || templateForm.content_type === 'rich_card')
        ? await processContentImages(content, folder)
        : content.trim();
      const { error } = await supabase
        .from('cs_message_templates')
        .insert({
          admin_id: selectedAdminId,
          name: templateForm.name.trim(),
          title: templateForm.content_type === 'rich_card' && templateForm.title.trim() ? templateForm.title.trim() : null,
          subtitle: templateForm.content_type === 'rich_card' && templateForm.subtitle.trim() ? templateForm.subtitle.trim() : null,
          content: optimizedContent,
          content_type: templateForm.content_type,
          sort_order: messageTemplates.length,
          source_type: 'ccc_service',
        });
      if (error) throw error;
      setTemplateForm({ name: '', title: '', subtitle: '', content: '', content_type: 'richtext' });
      if (templateEditorRef.current) templateEditorRef.current.innerHTML = '';
      setRichCardContent(''); { const rce = richCardEditorRef.current?.getEditor(); if (rce) rce.commands.setContent(''); }
      setNotification({ type: 'success', text: '範本已建立！' });
      loadTemplates();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '建立範本失敗') });
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleUpdateTemplate = async () => {
    if (!editingTemplate || !templateForm.name.trim()) return;
    const content = getTemplateContent();
    if (isTemplateContentEmpty()) return;
    setSavingTemplate(true);
    try {
      const folder = templateForm.content_type === 'rich_card' ? 'rich-cards' : 'templates';
      const optimizedContent = (templateForm.content_type === 'richtext' || templateForm.content_type === 'rich_card')
        ? await processContentImages(content, folder)
        : content.trim();
      await mutateAuditedContent('template_edit', [editingTemplate.id], {
        name: templateForm.name.trim(),
        title: templateForm.content_type === 'rich_card' && templateForm.title.trim() ? templateForm.title.trim() : null,
        subtitle: templateForm.content_type === 'rich_card' && templateForm.subtitle.trim() ? templateForm.subtitle.trim() : null,
        content: optimizedContent,
        content_type: templateForm.content_type,
      });
      setEditingTemplate(null);
      setTemplateForm({ name: '', title: '', subtitle: '', content: '', content_type: 'richtext' });
      if (templateEditorRef.current) templateEditorRef.current.innerHTML = '';
      setRichCardContent(''); { const rce = richCardEditorRef.current?.getEditor(); if (rce) rce.commands.setContent(''); }
      setNotification({ type: 'success', text: '範本已更新！' });
      loadTemplates();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '更新範本失敗') });
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await mutateAuditedContent('template_delete', [id]);
      setNotification({ type: 'success', text: '刪除成功' });
      loadTemplates();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '刪除範本失敗') });
    }
  };

  const handleToggleTemplatePin = async (tpl: MessageTemplate) => {
    try {
      const { error } = await supabase
        .from('cs_message_templates')
        .update({ is_pinned: !tpl.is_pinned, updated_at: new Date().toISOString() })
        .eq('id', tpl.id);
      if (error) throw error;
      loadTemplates();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '更新置頂狀態失敗') });
    }
  };

  const handleTemplateImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !templateEditorRef.current) return;
    setUploadingTemplateImage(true);
    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `template_${Date.now()}.${fileExt}`;
      const filePath = `chat-images/${fileName}`;
      const { error: uploadError } = await supabase.storage.from('chat-images').upload(filePath, file);
      if (uploadError) throw uploadError;
      const { data: urlData } = supabase.storage.from('chat-images').getPublicUrl(filePath);
      const img = document.createElement('img');
      img.src = urlData.publicUrl;
      img.style.maxWidth = '100%';
      img.style.borderRadius = '8px';
      img.style.margin = '4px 0';
      templateEditorRef.current.focus();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        range.insertNode(img);
        range.setStartAfter(img);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        templateEditorRef.current.appendChild(img);
      }
      setTemplateForm(prev => ({ ...prev, content: templateEditorRef.current?.innerHTML || '' }));
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '圖片上傳失敗') });
    } finally {
      setUploadingTemplateImage(false);
      if (templateImageInputRef.current) templateImageInputRef.current.value = '';
    }
  };

  const handleTemplateFileImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      if (file.name.endsWith('.txt')) {
        const text = await file.text();
        if (templateEditorRef.current) {
          templateEditorRef.current.innerHTML = text.replace(/\n/g, '<br>');
          setTemplateForm(prev => ({ ...prev, content: templateEditorRef.current?.innerHTML || '', content_type: 'richtext' }));
        }
      } else if (file.name.endsWith('.docx') || file.name.endsWith('.doc')) {
        setDocImportProgress({ phase: '讀取檔案中……', pct: 10 });
        const arrayBuffer = await file.arrayBuffer();
        setDocImportProgress({ phase: '正在載入轉換器……', pct: 30 });
        const mammoth = await import('mammoth');
        setDocImportProgress({ phase: '正在轉換文件……', pct: 60 });
        const result = await mammoth.convertToHtml({ arrayBuffer });
        setDocImportProgress({ phase: '套用內容中……', pct: 90 });
        if (templateEditorRef.current) {
          templateEditorRef.current.innerHTML = result.value;
          setTemplateForm(prev => ({ ...prev, content: result.value, content_type: 'richtext' }));
        }
        setDocImportProgress({ phase: '完成！', pct: 100 });
        setTimeout(() => setDocImportProgress(null), 800);
      } else {
        setNotification({ type: 'error', text: 'Unsupported file type. Use .txt or .docx files.' });
      }
    } catch (error: unknown) {
      setDocImportProgress(null);
      setNotification({ type: 'error', text: getCccErrorMessage(error, 'Failed to import file') });
    }
    e.target.value = '';
  };

  useEffect(() => {
    if (selectedAdminId) {
      loadTemplates();
    }
  }, [selectedAdminId, loadTemplates]);

  const loadAdminData = async (targetAdminId: string, silent = false, force = false) => {
    const requestId = ++workspaceLoadRequestRef.current;
    const scopedAdminId = isSuperAdmin ? targetAdminId : adminId;

    try {
      if (!silent) setLoading(true);

      const { customers, employees } = await prefetchAdminWorkspaceData<SimulatedCustomer, Employee>(
        scopedAdminId,
        'manager',
        force,
      );

      if (requestId !== workspaceLoadRequestRef.current) return;

      setCustomers(customers);
      setEmployees(employees);
      allCustomersRef.current = customers;
      allEmployeesRef.current = employees;
      loadedWorkspaceAdminIdRef.current = scopedAdminId;

      if (customers.length === 0 || employees.length === 0) {
        if (!silent) setLoading(false);
        return;
      }

      await loadAllConversationHistory(scopedAdminId, force);
      if (requestId !== workspaceLoadRequestRef.current) return;
      if (!silent) setLoading(false);

    } catch (error) {
      if (requestId !== workspaceLoadRequestRef.current) return;
      console.error('Error loading admin data:', formatSupabaseError(error));
      setNotification({ type: 'error', text: '載入資料失敗' });
    } finally {
      if (!silent && requestId === workspaceLoadRequestRef.current) setLoading(false);
    }
  };
  loadAdminDataRef.current = loadAdminData;

  const prefetchAdminGroupData = useCallback((group: AdminGroup) => {
    void prefetchAdminWorkspaceData(group.admin_id, 'manager').catch(() => undefined);
    void prefetchConversationSummaries(group.admin_id, 'manager', () => (
      fetchConversationSummaryRows(group.admin_id, 'manager')
    )).catch(() => undefined);
  }, []);

  const handleAdminGroupSelect = (group: AdminGroup) => {
    adminGroupsLoadRequestRef.current += 1;
    workspaceLoadRequestRef.current += 1;
    conversationHistoryLoadRequestRef.current += 1;
    messagesLoadRequestRef.current += 1;
    selectedAdminIdRef.current = group.admin_id;
    conversationHistoryInitializedRef.current = false;
    setSelectedAdminId(group.admin_id);
    setSelectedAdminName(group.admin_username);
    setSelectedCustomer(null);
    setSelectedEmployee(null);
    setMessages([]);
    setMessagesLoading(false);
    setLoadingOlderMessages(false);
    setHasMoreMessages(false);
    setShowHistoryView(true);
    setHistoryScope('all');
    setHistoryFilterMode('all');
    setAnnotationDialog(null);
    setAnnotations({});
    setAnnotationsWorkspaceId(null);
    historyScrollTopRef.current = 0;

    const cachedWorkspace = getCachedAdminWorkspaceData<SimulatedCustomer, Employee>(group.admin_id, 'manager');
    const cachedSummaries = getCachedConversationSummaries<ConversationSummaryRow>(group.admin_id, 'manager');

    if (cachedWorkspace && cachedSummaries) {
      const nextHistory = buildConversationHistory(
        cachedSummaries,
        cachedWorkspace.customers,
        cachedWorkspace.employees,
      );
      setCustomers(cachedWorkspace.customers);
      setEmployees(cachedWorkspace.employees);
      allCustomersRef.current = cachedWorkspace.customers;
      allEmployeesRef.current = cachedWorkspace.employees;
      loadedWorkspaceAdminIdRef.current = group.admin_id;
      setConversationHistory(nextHistory);
      setAllConversationHistory(nextHistory);
      conversationHistoryRef.current = nextHistory;
      allConversationHistoryRef.current = nextHistory;
      conversationHistoryInitializedRef.current = true;
      setLoading(false);
      void loadAdminData(group.admin_id, true, true);
      return;
    }

    setCustomers([]);
    setEmployees([]);
    allCustomersRef.current = [];
    allEmployeesRef.current = [];
    setConversationHistory([]);
    setAllConversationHistory([]);
    conversationHistoryRef.current = [];
    allConversationHistoryRef.current = [];
    setLoading(true);
    void loadAdminData(group.admin_id);
  };

  const handleBackToGroups = () => {
    workspaceLoadRequestRef.current += 1;
    conversationHistoryLoadRequestRef.current += 1;
    messagesLoadRequestRef.current += 1;
    selectedAdminIdRef.current = null;
    conversationHistoryInitializedRef.current = false;
    setSelectedAdminId(null);
    setSelectedAdminName('');
    setSelectedCustomer(null);
    setSelectedEmployee(null);
    setMessages([]);
    setMessagesLoading(false);
    setLoadingOlderMessages(false);
    setHasMoreMessages(false);
    setShowHistoryView(true);
    setHistoryScope('all');
    setHistoryFilterMode('all');
    setAnnotationDialog(null);
    setAnnotations({});
    setAnnotationsWorkspaceId(null);
    setConversationHistory([]);
    setAllConversationHistory([]);
    conversationHistoryRef.current = [];
    allConversationHistoryRef.current = [];
    historyScrollTopRef.current = 0;
    setCustomers([]);
    setEmployees([]);
    void loadAdminGroups(null, true, true);
  };

  const saveConversationAnnotation = async () => {
    if (!annotationDialog || !selectedAdminId || savingAnnotation) return;
    const { history, kind, nextSpecial } = annotationDialog;
    if (!history.customer_id) return;
    const workspaceId = selectedAdminId;
    setSavingAnnotation(true);
    try {
      const { data, error } = await supabase.rpc('update_ccc_conversation_annotation', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_customer_id: history.customer_id,
        p_employee_id: history.employee_id,
        p_is_special: kind === 'special' ? Boolean(nextSpecial) : null,
        p_note: kind === 'note' ? noteDraft.trim() || null : null,
        p_update_note: kind === 'note',
      });
      if (error) throw error;
      if (selectedAdminIdRef.current !== workspaceId) return;
      const annotation = data as ConversationAnnotation;
      setAnnotations(previous => ({
        ...previous,
        [conversationAnnotationKey(annotation.customer_id, annotation.employee_id)]: annotation,
      }));
      setAnnotationDialog(null);
      setNotification({ type: 'success', text: kind === 'note' ? '對話備註已儲存' : nextSpecial ? '已加入特別關注' : '已移除特別關注' });
    } catch (error) {
      if (selectedAdminIdRef.current === workspaceId) {
        setNotification({ type: 'error', text: getCccErrorMessage(error, '儲存對話註記失敗') });
      }
    } finally {
      setSavingAnnotation(false);
    }
  };

  const handleSelectCustomer = async (customer: SimulatedCustomer) => {
    historyScrollTopRef.current = 0;
    messagesLoadRequestRef.current += 1;
    if (selectedCustomer?.id === customer.id) {
      setSelectedCustomer(null);
      setMessages([]);
      setConversationHistory([]);
      setShowHistoryView(false);
      return;
    }
    setSelectedCustomer(customer);
    setMessages([]);
    setLoadingOlderMessages(false);
    setHasMoreMessages(false);
    if (selectedEmployee) setMessagesLoading(true);
    const cachedHistory = allConversationHistoryRef.current.filter(history => history.customer_id === customer.id);
    setConversationHistory(cachedHistory);
    conversationHistoryRef.current = cachedHistory;
    setShowHistoryView(!selectedEmployee);
    setHistoryFilterMode('all');
    setHistoryScope('customer');
  };

  const handleSelectEmployee = (employee: Employee) => {
    messagesLoadRequestRef.current += 1;
    if (selectedEmployee?.id === employee.id) {
      setSelectedEmployee(null);
      setMessages([]);
      return;
    }
    setMessages([]);
    setMessagesLoading(true);
    setLoadingOlderMessages(false);
    setHasMoreMessages(false);
    if (selectedCustomer) {
      restoreCachedMessages(selectedCustomer.id, employee.id);
    }
    setSelectedEmployee(employee);
    setShowHistoryView(false);
    setFromHistorySource('none');
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAdminId || savingCustomer) return;

    if (customerForm.isSuper) {
      if (!customerForm.name.trim()) {
        setNotification({ type: 'error', text: '請輸入經理名稱' });
        return;
      }
      if (!customerForm.badgeType) {
        setNotification({ type: 'error', text: '請選擇徽章類型' });
        return;
      }
    }

    setSavingCustomer(true);
    try {
      const customId = customerForm.isSuper ? (customerForm.customId || '').trim() : '';
      if (customId) {
        const { data: existingCustomer, error: existingCustomerError } = await supabase
          .from('simulated_customers')
          .select('id')
          .eq('customer_id', customId)
          .eq('source_type', 'ccc_service')
          .maybeSingle();

        if (existingCustomerError) throw existingCustomerError;
        if (existingCustomer) {
          setNotification({ type: 'error', text: '此自訂 ID 已被使用，請改用其他 ID。' });
          return;
        }
      }

      let customAvatarUrl = null;

      if (customerForm.customAvatarFile && customerForm.isSuper && customerForm.useCustomAvatar) {
        const fileExt = customerForm.customAvatarFile.name.split('.').pop();
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        const filePath = `avatars/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from('super-customer-avatars')
          .upload(filePath, customerForm.customAvatarFile);

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = supabase.storage
          .from('super-customer-avatars')
          .getPublicUrl(filePath);

        customAvatarUrl = publicUrl;
      }

      const insertData: SimulatedCustomerInsert = {
        admin_id: selectedAdminId,
        customer_name: customerForm.name,
        customer_avatar: customerForm.avatar,
        is_super: customerForm.isSuper,
        super_customer_title: customerForm.isSuper ? customerForm.superTitle : null,
        badge_type: customerForm.isSuper && customerForm.badgeType ? customerForm.badgeType : null,
        vip_label: customerForm.isSuper ? ((customerForm.vipLabel || '').trim() || 'VIP') : null,
        custom_avatar_url: customerForm.useCustomAvatar ? customAvatarUrl : null,
        remarks: (customerForm.remarks || '').trim() || null,
        employee_pin_top: customerForm.employeePinTop,
        employee_always_visible: customerForm.employeeAlwaysVisible,
        target_employee_ids: customerForm.targetEmployeeIds.length > 0 ? customerForm.targetEmployeeIds : null,
        source_type: 'ccc_service',
      };

      if (customId) {
        insertData.customer_id = customId;
      }

      const { data: createdCustomer, error } = await supabase
        .from('simulated_customers')
        .insert(insertData as Database['public']['Tables']['simulated_customers']['Insert'])
        .select('id')
        .single();

      if (error) throw error;

      if (createdCustomer) {
        if (autoMessageDrafts.length > 0) {
          const { error: autoMessagesError } = await supabase
            .from('customer_auto_messages')
            .insert(autoMessageDrafts.map(({ message_type, name, title, subtitle, content, content_type, sort_order, is_enabled }) => ({
              customer_id: createdCustomer.id,
              admin_id: selectedAdminId,
              message_type,
              name,
              title,
              subtitle,
              content,
              content_type,
              sort_order,
              is_enabled,
            })));
          if (autoMessagesError) throw autoMessagesError;
        }

        const { error: autoMessagesSettingError } = await supabase
          .from('simulated_customers')
          .update({ auto_messages_enabled: autoMessageDraftMasterEnabled })
          .eq('id', createdCustomer.id);
        if (autoMessagesSettingError) throw autoMessagesSettingError;
      }

      setNotification({ type: 'success', text: '經理已成功建立！' });
      setShowCustomerForm(false);
      setEditingCustomer(null);
      setAutoMessageDrafts([]);
      setAutoMessageDraftMasterEnabled(false);
      setCustomerForm({ name: '', avatar: 'customer-avatar:regular:0', isSuper: false, superTitle: '', customId: '', badgeType: '', vipLabel: 'VIP', customAvatarFile: null, useCustomAvatar: false, remarks: '', employeePinTop: false, employeeAlwaysVisible: false, targetEmployeeIds: [], _empSearch: '' });
      loadAdminData(selectedAdminId, true, true);
    } catch (error: unknown) {
      const errorMessage = getCccErrorMessage(error, '建立經理失敗');
      const msg = errorMessage.includes('customer_id_unique') ? '此自訂 ID 已被使用，請改用其他 ID。' : errorMessage;
      setNotification({ type: 'error', text: msg });
    } finally {
      setSavingCustomer(false);
    }
  };

  const handleUpdateCustomer = async () => {
    if (!editingCustomer || !selectedAdminId) return;

    if (customerForm.isSuper) {
      if (!customerForm.name.trim()) {
        setNotification({ type: 'error', text: '請輸入經理名稱' });
        return;
      }
      if (!customerForm.badgeType) {
        setNotification({ type: 'error', text: '請選擇徽章類型' });
        return;
      }
    }

    try {
      let customAvatarUrl: string | null = editingCustomer.custom_avatar_url ?? null;

      if (customerForm.useCustomAvatar) {
        if (customerForm.customAvatarFile && customerForm.isSuper) {
          const fileExt = customerForm.customAvatarFile.name.split('.').pop();
          const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
          const filePath = `avatars/${fileName}`;

          const { error: uploadError } = await supabase.storage
            .from('super-customer-avatars')
            .upload(filePath, customerForm.customAvatarFile);

          if (uploadError) throw uploadError;

          const { data: { publicUrl } } = supabase.storage
            .from('super-customer-avatars')
            .getPublicUrl(filePath);

          customAvatarUrl = publicUrl;
        }
      } else {
        customAvatarUrl = null;
      }

      const updateData: SimulatedCustomerUpdate = {
        customer_name: customerForm.name,
        customer_avatar: customerForm.avatar,
        is_super: customerForm.isSuper,
        super_customer_title: customerForm.isSuper ? customerForm.superTitle : null,
        badge_type: customerForm.isSuper && customerForm.badgeType ? customerForm.badgeType : null,
        vip_label: customerForm.isSuper ? ((customerForm.vipLabel || '').trim() || 'VIP') : null,
        custom_avatar_url: customerForm.useCustomAvatar ? customAvatarUrl : null,
        remarks: (customerForm.remarks || '').trim() || null,
        employee_pin_top: customerForm.employeePinTop,
        employee_always_visible: customerForm.employeeAlwaysVisible,
        target_employee_ids: customerForm.targetEmployeeIds.length > 0 ? customerForm.targetEmployeeIds : null,
        updated_at: new Date().toISOString(),
      };

      if (customerForm.isSuper && (customerForm.customId || '').trim()) {
        updateData.customer_id = (customerForm.customId || '').trim();
      }

      const { error } = await supabase
        .from('simulated_customers')
        .update(updateData)
        .eq('id', editingCustomer.id);

      if (error) throw error;

      setNotification({ type: 'success', text: '經理已成功更新！' });
      setEditingCustomer(null);
      setCustomerForm({ name: '', avatar: 'customer-avatar:regular:0', isSuper: false, superTitle: '', customId: '', badgeType: '', vipLabel: 'VIP', customAvatarFile: null, useCustomAvatar: false, remarks: '', employeePinTop: false, employeeAlwaysVisible: false, targetEmployeeIds: [], _empSearch: '' });
      loadAdminData(selectedAdminId, true, true);
    } catch (error: unknown) {
      const errorMessage = getCccErrorMessage(error, '更新經理失敗');
      const msg = errorMessage.includes('customer_id_unique') ? '此自訂 ID 已被使用，請改用其他 ID。' : errorMessage;
      setNotification({ type: 'error', text: msg });
    }
  };

  const handleToggleCustomerPin = async (customer: SimulatedCustomer) => {
    try {
      const { error } = await supabase
        .from('simulated_customers')
        .update({ is_pinned: !customer.is_pinned })
        .eq('id', customer.id);
      if (error) throw error;
      setCustomers(prev => prev.map(c => c.id === customer.id ? { ...c, is_pinned: !c.is_pinned } : c));
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '更新置頂狀態失敗') });
    }
  };

  const handleDeleteCustomer = async (customerId: string) => {
    const customerToDelete = customers.find(c => c.id === customerId);

    setConfirmDialog({
      show: true,
      title: '刪除經理',
      message: `確定刪除經理「${customerToDelete?.customer_name || '此經理'}」及其所有對話嗎？`,
      scope: 'customer',
      onConfirm: async () => {
        setConfirmDeleting(true);
        try {
          await mutateAuditedContent('customer_delete', [customerId]);

          invalidateAdminWorkspaceDataCache(selectedAdminId || adminId, 'manager');
          if (selectedCustomer?.id === customerId) {
            setSelectedCustomer(null);
            setSelectedEmployee(null);
          }
          setCustomers(prev => prev.filter(c => c.id !== customerId));
          setNotification({ type: 'success', text: '經理及其對話已刪除。' });
        } catch {
          setNotification({ type: 'error', text: '刪除經理未完成，請重新整理後核對。' });
        } finally {
          setConfirmDeleting(false);
          setConfirmDialog(null);
        }
      }
    });
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedCustomer || !selectedEmployee) return;

    if (!file.type.startsWith('image/')) {
      setNotification({ type: 'error', text: '請選擇圖片檔案' });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setNotification({ type: 'error', text: '圖片大小必須小於 5MB' });
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
      employee_id: selectedEmployee.id,
      sender_type: 'customer',
      message_content: '[Image]',
      message_type: 'image',
      image_url: dataUrl,
      is_read: false,
      created_at: new Date().toISOString(),
    };

    pendingImageMessagesRef.current.set(tempId, tempMessage);
    setMessages(prev => [...prev, tempMessage]);
    scrollToBottom(false);
    uploadingTempIdRef.current = tempId;
    setUploadingImage(true);
    setUploadProgress(0);

    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `${selectedCustomer.id}_${selectedEmployee.id}_${Date.now()}.${fileExt}`;
      const filePath = `${fileName}`;

      await uploadStorageObjectWithProgress({
        bucket: 'chat-images',
        path: filePath,
        body: file,
        onProgress: percentage => setUploadProgress(Math.round(percentage * 0.9)),
      });

      const { data: { publicUrl } } = supabase.storage
        .from('chat-images')
        .getPublicUrl(filePath);

      setUploadProgress(92);

      const pendingMessage = pendingImageMessagesRef.current.get(tempId);
      if (pendingMessage) {
        pendingImageMessagesRef.current.set(tempId, { ...pendingMessage, image_url: publicUrl });
      }
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, image_url: publicUrl } : m));

      justSentRef.current = true;
      setTimeout(() => { justSentRef.current = false; }, 3000);

      const { error: insertError } = await supabase
        .from('customer_employee_conversations')
        .insert({
          customer_id: selectedCustomer.id,
          employee_id: selectedEmployee.id,
          sender_type: 'customer',
          message_content: '[Image]',
          message_type: 'image',
          image_url: publicUrl,
          is_read: false,
          source_type: 'ccc_service',
        });

      if (insertError) throw insertError;

      setUploadProgress(100);
      uploadingTempIdRef.current = null;
      setUploadingImage(false);
      setUploadProgress(0);
      void loadConversationHistory();
    } catch (error: unknown) {
      pendingImageMessagesRef.current.delete(tempId);
      setNotification({ type: 'error', text: getCccErrorMessage(error, '圖片上傳失敗') });
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

  const renderMessageContent = (msg: Message) => {
    if (msg.message_type === 'image' && !msg.image_url) {
      return (
        <div className="relative aspect-square w-[min(340px,100%)] max-w-full flex-shrink rounded-lg overflow-hidden">
          <div className="absolute inset-0 bg-slate-800/60 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="w-10 h-10 border-3 border-slate-600 border-t-blue-400 rounded-full animate-spin" />
              <span className="text-xs text-slate-400">載入中……</span>
            </div>
          </div>
        </div>
      );
    }
    if (msg.message_type === 'image' && msg.image_url) {
      const isUploading = uploadingImage && uploadingTempIdRef.current === msg.id;
      return (
        <AdminChatImage
          src={msg.image_url}
          isUploading={isUploading}
          uploadProgress={uploadProgress}
          onClickImage={(url) => { setPreviewImage(url); setAdminImageZoom(1); setAdminImageDrag({ x: 0, y: 0 }); }}
        />
      );
    }

    if (msg.message_type === 'rating_request') {
      const hasRating = messages.some(
        m => m.message_type === 'rating_result' &&
        new Date(m.created_at) > new Date(msg.created_at)
      );

      return (
        <div className="my-2">
          <div className="relative bg-white border border-blue-200 rounded-xl px-4 py-3 shadow-sm overflow-hidden" style={{ boxShadow: '0 2px 8px rgba(59,130,246,0.1)' }}>
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-blue-400 via-cyan-400 to-blue-500"></div>
            <div className="flex items-center gap-2 mb-2.5 mt-0.5">
              <div className="p-1.5 bg-blue-500 rounded-lg">
                <Star className="w-3.5 h-3.5 text-white fill-white" />
              </div>
              <span className="text-xs font-bold text-blue-700">評分請求</span>
              {hasRating ? (
                <div className="ml-auto flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 border border-emerald-200 rounded-full">
                  <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></div>
                  <span className="text-[10px] text-emerald-700 font-semibold">已評分</span>
                </div>
              ) : (
                <div className="ml-auto flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 rounded-full">
                  <div className="w-1.5 h-1.5 bg-amber-500 rounded-full "></div>
                  <span className="text-[10px] text-amber-700 font-semibold">待處理</span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-1 mb-2.5 px-1">
              {[1, 2, 3, 4, 5].map((s) => (
                <Star key={s} className="w-4 h-4 fill-slate-200 text-slate-300" />
              ))}
              <span className="ml-1.5 text-xs text-slate-400">等待回覆</span>
            </div>
            {!hasRating && msg.sender_type === 'employee' && (
              <button
                onClick={() => setShowRatingModal(true)}
                className="w-full px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg shadow-sm transition-colors"
              >
                提交評分
              </button>
            )}
          </div>
        </div>
      );
    }

    if (msg.message_type === 'rating_result' && msg.rating_data) {
      const { rating = 0, comment } = msg.rating_data;
      return (
        <div className="my-2">
          <div className="w-[260px] rounded-xl overflow-hidden shadow-md" style={{ boxShadow: '0 4px 12px rgba(16,185,129,0.25)' }}>
            <div className="bg-gradient-to-r from-emerald-500 to-green-500 px-4 py-2.5 flex items-center gap-2">
              <div className="p-1 bg-white/20 rounded-md">
                <Star className="w-3.5 h-3.5 text-white fill-white" />
              </div>
              <span className="text-sm font-bold text-white">服務評分</span>
              <div className="ml-auto px-2 py-0.5 bg-white/20 rounded-full">
                <span className="text-[10px] text-white font-semibold">已完成</span>
              </div>
            </div>
            <div className="bg-white px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex gap-0.5">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <Star
                      key={star}
                      className={`w-5 h-5 ${
                        star <= rating
                          ? 'text-amber-400 fill-amber-400'
                          : 'text-slate-200 fill-slate-200'
                      }`}
                    />
                  ))}
                </div>
                <span className="text-xl font-bold text-emerald-600">{rating}.0</span>
              </div>
              {comment && (
                <div className="mt-2.5 pt-2.5 border-t border-emerald-100">
                  <p className="text-xs text-slate-600 leading-relaxed italic">"{comment}"</p>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (msg.message_type === 'rich_card') {
      return (
        <div className="my-1.5">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); openRichCardViewer(msg); }}
            className="w-[240px] text-left rounded-2xl overflow-hidden transition-all duration-250 group shadow-[0_2px_12px_rgba(37,99,246,0.15)] hover:shadow-[0_8px_24px_rgba(37,99,246,0.22)] hover:scale-[1.015]"
          >
            <div className="relative bg-gradient-to-br from-blue-500 via-blue-600 to-blue-700 px-4 pt-4 pb-3.5">
              <div className="absolute top-0 right-0 w-20 h-20 bg-white/[0.07] rounded-full -translate-y-8 translate-x-8" />
              <div className="absolute bottom-0 left-0 w-14 h-14 bg-white/[0.05] rounded-full translate-y-6 -translate-x-6" />
              <div className="relative flex items-start gap-2.5">
                <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-white/20 backdrop-blur-sm flex items-center justify-center">
                  <Megaphone className="w-3.5 h-3.5 text-white" />
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <span className="text-[12.5px] font-semibold text-white block truncate leading-snug">{msg.title || '查看詳情'}</span>
                  {msg.subtitle && <span className="text-[11px] text-blue-100/80 block truncate mt-1 leading-snug">{msg.subtitle}</span>}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between px-4 py-2 bg-white border-t border-blue-100">
              <span className="text-[10.5px] text-blue-600 font-medium">查看詳情</span>
              <ChevronRight className="w-3.5 h-3.5 text-blue-400 group-hover:text-blue-600 group-hover:translate-x-0.5 transition-all duration-200" />
            </div>
          </button>
        </div>
      );
    }

    if (msg.message_type === 'tip' && msg.rating_data) {
      const tipAmt = msg.rating_data.tip_amount || 0;
      return (
        <div className="my-2">
          <div className="w-[232px] overflow-hidden rounded-2xl border border-amber-300/45 bg-gradient-to-br from-amber-300/80 via-emerald-400 to-emerald-700 p-px shadow-xl shadow-emerald-950/35">
            <div className="relative overflow-hidden rounded-[15px] bg-gradient-to-br from-emerald-950 via-emerald-900 to-amber-950 px-4 py-3.5">
              <div className="absolute -right-8 -top-10 h-28 w-28 rounded-full bg-amber-300/15 blur-2xl" />
              <div className="absolute -bottom-10 -left-8 h-24 w-24 rounded-full bg-emerald-300/10 blur-2xl" />
              <div className="absolute inset-0 opacity-[0.07]" style={{
                backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 3px, rgba(255,255,255,0.65) 3px, rgba(255,255,255,0.65) 4px),
                  repeating-linear-gradient(-45deg, transparent, transparent 3px, rgba(255,255,255,0.4) 3px, rgba(255,255,255,0.4) 4px)`
              }} />
              <div className="relative">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-amber-200/30 bg-amber-200/15">
                      <Gift className="h-3.5 w-3.5 text-amber-100" />
                    </span>
                    <span className="text-[9px] font-black uppercase tracking-[0.16em] text-amber-100">已送出打賞</span>
                  </div>
                  <span className="rounded-full border border-amber-200/25 bg-white/10 px-2 py-0.5 text-[8px] font-bold uppercase tracking-wider text-amber-100/90">謝謝</span>
                </div>
                <div className="py-3 text-center">
                  <div className="flex items-baseline justify-center text-white" style={{ textShadow: '0 3px 8px rgba(0,0,0,0.3)' }}>
                    <span className="mr-0.5 text-xl font-black">$</span>
                    <span className="text-[30px] font-black leading-none tracking-tight">{tipAmt.toFixed(2)}</span>
                  </div>
                  <p className="mt-1 text-[10px] font-medium text-emerald-100/75">服務感謝</p>
                </div>
                <div className="flex items-center justify-center gap-1 border-t border-amber-100/15 pt-2 text-[9px] font-semibold tracking-wide text-amber-100/80">
                  <Star className="h-3 w-3 fill-amber-200/70 text-amber-200" />
                  <span>感謝您的支持</span>
                </div>
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
        <AdminChatImage
          src={imageOnlyUrl}
          isUploading={false}
          uploadProgress={0}
          onClickImage={(url) => { setPreviewImage(url); setAdminImageZoom(1); setAdminImageDrag({ x: 0, y: 0 }); }}
        />
      );
    }
    if (hasHtml) {
      const sanitized = sanitizeChatMessage(content);
      const hasImgTag = /<img\s/i.test(content);
      return (
        <div
          className={`text-sm break-words chat-rich-content${hasImgTag ? ' [&_img]:cursor-pointer [&_img]:rounded-lg [&_img]:w-[260px] [&_img]:h-[260px] [&_img]:object-cover [&_img]:hover:opacity-90 [&_img]:transition-opacity [&_img]:shadow-sm' : ''}`}
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
                setAdminImageZoom(1);
                setAdminImageDrag({ x: 0, y: 0 });
              }
            }
          }}
        />
      );
    }
    return <div className="text-sm whitespace-pre-wrap break-words" style={{ overflowWrap: 'anywhere' }}>{content}</div>;
  };

  const ensureEditorFocus = (editor: HTMLDivElement) => {
    if (document.activeElement !== editor) editor.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  };

  const syncMainFormatState = () => {
    setIsBoldActive(document.queryCommandState('bold'));
    setIsUnderlineActive(document.queryCommandState('underline'));
  };

  const applyFormat = (command: string, value?: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    ensureEditorFocus(editor);
    document.execCommand(command, false, value);
    if (command === 'bold') setIsBoldActive(prev => !prev);
    else if (command === 'underline') setIsUnderlineActive(prev => !prev);
  };

  const getEditorContent = (): string => {
    if (!editorRef.current) return '';
    return stripTailwindStyles(editorRef.current.innerHTML);
  };

  const isEditorEmpty = (): boolean => {
    if (!editorRef.current) return true;
    const text = editorRef.current.textContent || '';
    const hasImages = editorRef.current.querySelector('img') !== null;
    return text.trim().length === 0 && !hasImages;
  };

  const getEditorHasContent = (): boolean => {
    if (!editorRef.current) return false;
    const text = (editorRef.current.textContent || '').trim();
    const hasImages = editorRef.current.querySelector('img') !== null;
    return text.length > 0 || hasImages;
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedCustomer || !selectedEmployee) return;

    const htmlContent = getEditorContent();
    if (isEditorEmpty()) return;

    // Client-generated id: reloads that land before the insert returns can recognise this message.
    const tempMessage: Message = {
      id: crypto.randomUUID(),
      customer_id: selectedCustomer.id,
      employee_id: selectedEmployee.id,
      sender_type: 'customer',
      message_content: htmlContent,
      message_type: 'text',
      is_read: false,
      created_at: new Date().toISOString(),
    };

    pendingImageMessagesRef.current.set(tempMessage.id, tempMessage);
    setMessages(prev => [...prev, tempMessage]);
    if (editorRef.current) editorRef.current.innerHTML = '';
    setMessageInput('');
    justSentRef.current = true;
    setTimeout(() => { justSentRef.current = false; }, 3000);

    try {
      const { data: newMsg, error } = await supabase
        .from('customer_employee_conversations')
        .insert({
          id: tempMessage.id,
          customer_id: selectedCustomer.id,
          employee_id: selectedEmployee.id,
          sender_type: 'customer',
          message_content: htmlContent,
          message_type: 'text',
          is_read: false,
          source_type: 'ccc_service',
        })
        .select()
        .single();

      if (error) {
        pendingImageMessagesRef.current.delete(tempMessage.id);
        setMessages(prev => prev.filter(m => m.id !== tempMessage.id));
        throw error;
      }

      if (newMsg) {
        pendingImageMessagesRef.current.set(newMsg.id, newMsg);
        pendingConfirmAfterRef.current.set(newMsg.id, messagesLoadRequestRef.current);
        const cacheKey = `${selectedCustomer.id}:${selectedEmployee.id}`;
        const cachedMessages = conversationMessagesCacheRef.current.get(cacheKey) || [];
        conversationMessagesCacheRef.current.set(cacheKey, [
          ...cachedMessages.filter(message => message.id !== newMsg.id),
          newMsg,
        ]);
        setMessages(prev => prev.some(m => m.id === newMsg.id)
          ? prev.map(m => m.id === newMsg.id ? newMsg : m)
          : [...prev, newMsg]);
      }
      loadConversationHistory();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '訊息傳送失敗') });
    }
  };

  const handleDeleteMessage = (messageId: string) => {
    setConfirmDialog({
      show: true,
      title: '刪除訊息',
      message: '確定刪除此訊息嗎？',
      scope: 'message',
      onConfirm: async () => {
        setConfirmDeleting(true);
        try {
          await mutateAuditedContent('chat_delete', [messageId]);
          pendingImageMessagesRef.current.delete(messageId);
          pendingConfirmAfterRef.current.delete(messageId);
          if (selectedCustomer && selectedEmployee) {
            const cacheKey = `${selectedCustomer.id}:${selectedEmployee.id}`;
            conversationMessagesCacheRef.current.set(cacheKey,
              (conversationMessagesCacheRef.current.get(cacheKey) || []).filter(message => message.id !== messageId));
          }
          setMessages(previous => previous.filter(message => message.id !== messageId));
          setNotification({ type: 'success', text: '聊天訊息已刪除。' });
          void loadMessages();
          void loadConversationHistory();
        } catch {
          setNotification({ type: 'error', text: '刪除訊息未完成，請重新整理後核對。' });
        } finally {
          setConfirmDeleting(false);
          setConfirmDialog(null);
        }
      },
    });
  };

  const handleStartEdit = (msg: Message) => {
    if (msg.message_type === 'image') {
      replacingImageMsgIdRef.current = msg.id;
      replaceImageInputRef.current?.click();
      return;
    }
    setEditingMessageId(msg.id);
    setEditingContent(msg.message_content);
    setTimeout(() => {
      if (editEditorRef.current) {
        editEditorRef.current.innerHTML = msg.message_content;
        editEditorRef.current.focus();
      }
    }, 50);
  };

  const handleReplaceImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const msgId = replacingImageMsgIdRef.current;
    if (!file || !msgId) return;
    if (file.size > 5 * 1024 * 1024) {
      setNotification({ type: 'error', text: '圖片大小必須小於 5MB' });
      return;
    }
    setReplacingImageMsgId(msgId);
    try {
      const fileExt = file.name.split('.').pop();
      const fileName = `chat-replace-${Date.now()}-${Math.random().toString(36).slice(2)}.${fileExt}`;
      const { data, error: uploadError } = await supabase.storage.from('chat-images').upload(fileName, file);
      if (uploadError) throw uploadError;
      const { data: { publicUrl } } = supabase.storage.from('chat-images').getPublicUrl(data.path);
      await mutateAuditedContent('chat_edit', [msgId], { image_url: publicUrl });

      setNotification({ type: 'success', text: '圖片已成功替換' });
      preserveScrollUntilRef.current = Date.now() + 2000;
      loadMessages();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '替換圖片失敗') });
    } finally {
      replacingImageMsgIdRef.current = null;
      setReplacingImageMsgId(null);
      if (replaceImageInputRef.current) replaceImageInputRef.current.value = '';
    }
  };

  const handleSaveEdit = async () => {
    if (!editingMessageId || !editEditorRef.current) return;
    const newContent = editEditorRef.current.innerHTML;
    const textOnly = editEditorRef.current.textContent || '';
    const hasImages = editEditorRef.current.querySelector('img') !== null;
    if (!textOnly.trim() && !hasImages) return;

    try {
      await mutateAuditedContent('chat_edit', [editingMessageId], { message_content: newContent });

      setEditingMessageId(null);
      setEditingContent('');
      preserveScrollUntilRef.current = Date.now() + 2000;
      loadMessages();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '更新訊息失敗') });
    }
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditingContent('');
    setIsEditBoldActive(false);
    setIsEditUnderlineActive(false);
    setEditEditorFontSize(null);
  };

  const handleEditImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editEditorRef.current) return;
    if (file.size > 5 * 1024 * 1024) {
      setNotification({ type: 'error', text: '圖片大小必須小於 5MB' });
      return;
    }
    setUploadingEditImage(true);
    try {
      const fileName = `chat-edit-${Date.now()}-${Math.random().toString(36).slice(2)}.${file.name.split('.').pop()}`;
      const { data, error } = await supabase.storage.from('chat-images').upload(fileName, file);
      if (error) throw error;
      const { data: { publicUrl } } = supabase.storage.from('chat-images').getPublicUrl(data.path);
      const img = document.createElement('img');
      img.src = publicUrl;
      img.style.maxWidth = '100%';
      img.style.borderRadius = '8px';
      img.style.margin = '4px 0';
      editEditorRef.current.appendChild(img);
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCccErrorMessage(error, '圖片上傳失敗') });
    } finally {
      setUploadingEditImage(false);
      if (editFileInputRef.current) editFileInputRef.current.value = '';
    }
  };

  const applyEditFormat = (command: string, value?: string) => {
    const editor = editEditorRef.current;
    if (!editor) return;
    ensureEditorFocus(editor);
    document.execCommand(command, false, value);
    if (command === 'bold') setIsEditBoldActive(prev => !prev);
    else if (command === 'underline') setIsEditUnderlineActive(prev => !prev);
  };

  const updateEditFormatState = () => {
    setIsEditBoldActive(document.queryCommandState('bold'));
    setIsEditUnderlineActive(document.queryCommandState('underline'));
  };

  const BG_COLORS = [
    { color: '#fef08a', label: '黃色' },
    { color: '#bbf7d0', label: '綠色' },
    { color: '#bfdbfe', label: '藍色' },
    { color: '#fecaca', label: '紅色' },
    { color: '#e9d5ff', label: '紫色' },
    { color: '#fed7aa', label: '橙色' },
    { color: '#99f6e4', label: '青綠色' },
    { color: '#fce7f3', label: '粉紅色' },
  ];

  const TEXT_COLORS = [
    { color: '#000000', label: '黑色' },
    { color: '#dc2626', label: '紅色' },
    { color: '#2563eb', label: '藍色' },
    { color: '#16a34a', label: '綠色' },
    { color: '#d97706', label: '橙色' },
    { color: '#7c3aed', label: '紫色' },
    { color: '#0891b2', label: '青色' },
    { color: '#be185d', label: '粉紅色' },
  ];

  const ensureEditorSelection = (editor: HTMLDivElement) => {
    if (document.activeElement !== editor) editor.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editor.contains(sel.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  };

  const syncTemplateFormatState = () => {
    setTemplateBoldActive(document.queryCommandState('bold'));
    setTemplateUnderlineActive(document.queryCommandState('underline'));
    setTemplateStrikethroughActive(document.queryCommandState('strikeThrough'));
  };

  const execTemplateCmd = (cmd: string, value?: string) => {
    const editor = templateEditorRef.current;
    if (!editor) return;
    ensureEditorSelection(editor);
    document.execCommand(cmd, false, value);
    if (cmd === 'bold') setTemplateBoldActive(prev => !prev);
    else if (cmd === 'underline') setTemplateUnderlineActive(prev => !prev);
    else if (cmd === 'strikeThrough') setTemplateStrikethroughActive(prev => !prev);
  };

  const applyBgColor = (color: string | null, target: 'main' | 'edit' | 'template') => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setShowBgColorPicker(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const walkUp = (node: Node | null): HTMLSpanElement | null => {
      while (node && node !== editorRef.current && node !== editEditorRef.current && node !== templateEditorRef.current) {
        if (node instanceof HTMLSpanElement && node.style.backgroundColor) return node;
        node = node.parentNode;
      }
      return null;
    };
    const existingSpan = walkUp(container.nodeType === Node.TEXT_NODE ? container.parentNode : container);
    if (existingSpan) {
      if (color) {
        existingSpan.style.backgroundColor = color;
      } else {
        const parent = existingSpan.parentNode;
        if (parent) {
          while (existingSpan.firstChild) parent.insertBefore(existingSpan.firstChild, existingSpan);
          parent.removeChild(existingSpan);
        }
      }
    } else if (color) {
      const span = document.createElement('span');
      span.style.backgroundColor = color;
      range.surroundContents(span);
    }
    setShowBgColorPicker(null);
    if (target === 'main') editorRef.current?.focus();
    else if (target === 'edit') editEditorRef.current?.focus();
    else templateEditorRef.current?.focus();
  };

  const handleDeleteConversation = () => {
    if (!selectedCustomer || !selectedEmployee) return;
    setConfirmDialog({
      show: true,
      title: '刪除對話',
      message: `確定刪除與 ${selectedEmployee.username} 的完整對話嗎？`,
      scope: 'conversation',
      onConfirm: async () => {
        setConfirmDeleting(true);
        try {
          await mutateAuditedContent('conversation_delete', [selectedCustomer.id], {}, selectedEmployee.id);
          conversationMessagesCacheRef.current.delete(`${selectedCustomer.id}:${selectedEmployee.id}`);
          setMessages([]);
          setNotification({ type: 'success', text: '整段對話已刪除。' });
          void loadConversationHistory();
        } catch (error: unknown) {
          console.error('Delete conversation failed:', formatSupabaseError(error));
          setNotification({ type: 'error', text: '刪除對話未完成，請重新整理後核對。' });
        } finally {
          setConfirmDeleting(false);
          setConfirmDialog(null);
        }
      },
    });
  };

  if (loading && isSuperAdmin && !selectedAdminId && !initialEmployee) {
    return (
      <AdminGroupPicker
        service="manager"
        groups={adminGroups}
        unreadCounts={adminUnreadCounts}
        fallbackUnreadCount={0}
        loading
        onSelect={handleAdminGroupSelect}
        onPrefetch={prefetchAdminGroupData}
        onRefresh={() => { void loadAdminGroups(null, false, true); }}
      />
    );
  }

  if (loading && !initialEmployee) {
    return (
      <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-4 text-center text-slate-400">
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-300/30 bg-emerald-400/15 shadow-[0_0_30px_rgba(52,211,153,0.14)]">
          <span className="absolute inset-1 animate-ping rounded-xl border border-emerald-300/25 [animation-duration:1.6s]" />
          <span className="relative h-8 w-8 animate-spin rounded-full border-[3px] border-emerald-300/25 border-t-emerald-300" />
        </div>
        <div>
          <p className="text-sm font-semibold text-emerald-100">正在載入經理工作區</p>
          <p className="mt-1 text-[11px] text-slate-500">正在同步角色與會話資料，請稍候……</p>
        </div>
      </div>
    );
  }

  if (isSuperAdmin && !selectedAdminId && !initialEmployee) {
    return (
      <AdminGroupPicker
        service="manager"
        groups={adminGroups}
        unreadCounts={adminUnreadCounts}
        fallbackUnreadCount={0}
        loading={false}
        onSelect={handleAdminGroupSelect}
        onPrefetch={prefetchAdminGroupData}
        onRefresh={() => { void loadAdminGroups(null, false, true); }}
      />
    );
  }

  return (
    <div ref={containerRef} className="relative flex min-w-0 flex-1 flex-col gap-3 overflow-hidden px-2 pb-2 pt-3 sm:px-3 sm:pb-3 sm:pt-4">
      {/* Info Bar + History/New Buttons in one row */}
      <div className="flex min-h-10 min-w-0 flex-shrink-0 flex-wrap items-center gap-2">
        {isSuperAdmin && selectedAdminId && (
          <button
            type="button"
            onClick={handleBackToGroups}
            className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors text-xs font-medium flex-shrink-0 border border-emerald-300/70 shadow-md shadow-emerald-600/30"
          >
            <ArrowLeft className="w-4 h-4" />
            返回
          </button>
        )}
        {isSuperAdmin && selectedAdminId && (
          <div className="flex items-center gap-2 px-3 h-10 bg-emerald-950/50 border border-emerald-400/50 rounded-lg flex-shrink-0">
            <div className="w-2 h-2 bg-green-500 rounded-full  flex-shrink-0"></div>
            <span className="text-[10px] font-bold text-emerald-200 uppercase tracking-wider flex-shrink-0">管理中</span>
            <div className="h-4 w-px bg-emerald-400/40 flex-shrink-0"></div>
            <div className="p-1 bg-gradient-to-br from-emerald-500 to-green-500 rounded flex-shrink-0">
              <User className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm font-bold text-white truncate">{selectedAdminName}</span>
          </div>
        )}
        {selectedEmployee && (
          <div className="flex items-center gap-2 px-3 h-10 bg-emerald-700 border border-emerald-400/70 rounded-lg flex-shrink-0">
            <div className="w-7 h-7 bg-emerald-100 rounded-md flex items-center justify-center flex-shrink-0">
              <MessageCircle className="w-3.5 h-3.5 text-emerald-700" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-white leading-none truncate" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>{selectedEmployee?.username} <span className="text-[10px] font-medium text-emerald-100">編號： {selectedEmployee?.employee_id}</span></div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedEmployee(null)}
              className="ml-1 p-1 hover:bg-emerald-800 rounded-md transition-colors text-emerald-100 hover:text-white"
              title="清除選取"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        <div className="ml-auto flex max-w-full flex-shrink-0 flex-wrap items-center justify-end gap-2">
          {(() => {
            const totalUnread = workspaceConversationHistory.reduce((total, history) => total + history.unread_count, 0);
            return (
              <>
                <button
                  type="button"
                  disabled={annotationsWorkspaceId !== selectedAdminId}
                  onClick={() => { setSelectedEmployee(null); setSelectedCustomer(null); setShowHistoryView(true); setHistoryFilterMode('special'); setHistoryScope('all'); historyScrollTopRef.current = 0; void loadAllConversationHistory(undefined, true); }}
                  className={`flex items-center gap-2 rounded-lg border-2 px-4 py-2 text-sm font-bold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:cursor-wait disabled:opacity-50 ${
                    showHistoryView && historyScope === 'all' && historyFilterMode === 'special'
                      ? 'border-amber-300 bg-amber-600 text-white shadow-lg shadow-amber-500/30'
                      : 'border-amber-500/50 bg-amber-950/50 text-amber-200 hover:border-amber-300 hover:bg-amber-800/50'
                  }`}
                >
                  <Star className="h-4 w-4" />
                  <span>特別關注</span>
                  <span className="rounded-full bg-white/20 px-2 py-0.5 text-xs font-black">{specialConversationCount}</span>
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedEmployee(null); setSelectedCustomer(null); setShowHistoryView(true); setHistoryFilterMode('all'); setHistoryScope('all'); historyScrollTopRef.current = 0; void loadAllConversationHistory(undefined, true); }}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all border-2 ${
                    showHistoryView && historyScope === 'all' && historyFilterMode === 'all'
                      ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/40 border-emerald-300'
                      : 'bg-emerald-950/50 hover:bg-emerald-800/50 border-emerald-500/50 hover:border-emerald-300/70 text-emerald-200 hover:text-emerald-100 shadow-lg shadow-emerald-950/30 hover:shadow-emerald-900/40'
                  }`}
                >
                  <Clock className="w-4 h-4" />
                  <span>全部歷史</span>
                  {workspaceConversationHistory.length > 0 && (
                    <span className={`ml-1 px-2 py-0.5 rounded-full text-xs font-black min-w-[24px] text-center ${
                      showHistoryView && historyScope === 'all' && historyFilterMode === 'all'
                        ? 'bg-white text-emerald-700'
                        : 'bg-emerald-500 text-white'
                    }`}>{workspaceConversationHistory.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedEmployee(null); setSelectedCustomer(null); setShowHistoryView(true); setHistoryFilterMode('new'); setHistoryScope('all'); historyScrollTopRef.current = 0; void loadAllConversationHistory(undefined, true); }}
                  className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all border-2 ${
                    totalUnread > 0
                      ? `${showHistoryView && historyScope === 'all' && historyFilterMode === 'new'
                        ? 'bg-green-600 text-white shadow-lg shadow-green-500/40 border-green-300'
                        : 'bg-green-950/50 hover:bg-green-800/50 border-green-500/50 hover:border-green-300/70 text-green-200 hover:text-green-100 shadow-lg shadow-green-950/30 hover:shadow-green-900/40'}`
                      : showHistoryView && historyScope === 'all' && historyFilterMode === 'new'
                        ? 'bg-green-600 text-white shadow-lg shadow-green-500/40 border-green-300'
                        : 'bg-green-950/50 hover:bg-green-800/50 border-green-500/50 hover:border-green-300/70 text-green-200 hover:text-green-100 shadow-lg shadow-green-950/30 hover:shadow-green-900/40'
                  }`}
                >
                  <MessageSquarePlus className="w-4 h-4" />
                  <span>全部新訊息</span>
                  {totalUnread > 0 && (
                    <span className={`ml-1 px-2 py-0.5 rounded-full text-xs font-black min-w-[24px] text-center ${
                      showHistoryView && historyScope === 'all' && historyFilterMode === 'new'
                        ? 'bg-white text-green-700'
                        : 'bg-green-500 text-white'
                    }`}>{totalUnread}</span>
                  )}
                  {totalUnread > 0 && !(showHistoryView && historyScope === 'all' && historyFilterMode === 'new') && (
                    <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-green-500 rounded-full "></span>
                  )}
                </button>
              </>
            );
          })()}
        </div>
      </div>

      {/* 3-Panel Layout: Customer Sidebar | Employee List | Chat */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto lg:flex-row lg:overflow-hidden">

        {/* Left: Customer Sidebar */}
        <div className="flex h-[260px] w-full flex-shrink-0 flex-col overflow-hidden rounded-2xl border border-emerald-300/30 bg-gradient-to-b from-slate-900 via-slate-900/95 to-emerald-950/35 shadow-2xl shadow-emerald-950/25 ring-1 ring-white/[0.03] backdrop-blur-xl lg:h-auto lg:w-[clamp(13rem,20vw,18rem)]">
          {/* Sidebar Header */}
          <div className="border-b border-emerald-300/20 bg-gradient-to-r from-emerald-500/10 via-slate-800/70 to-transparent p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="flex items-center gap-1.5 text-xs font-black uppercase tracking-[0.12em] text-emerald-50">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-emerald-300/30 bg-emerald-500/15 shadow-sm shadow-emerald-950/20">
                  <Users className="h-3.5 w-3.5 text-emerald-200" />
                </span>
                經理
              </h3>
              <button
                type="button"
                onClick={() => setShowCustomerForm(!showCustomerForm)}
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-200/30 bg-emerald-500/80 text-white shadow-md shadow-emerald-950/30 transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-100/70 hover:bg-emerald-400 hover:shadow-lg hover:shadow-emerald-950/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200/70"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex gap-1 rounded-xl border border-white/[0.06] bg-slate-950/60 p-1 shadow-inner shadow-black/20">
              <button
                onClick={() => setCustomerFilter('all')}
                className={`flex-1 px-2 py-1.5 text-[10px] font-bold rounded-md transition-all duration-200 flex items-center justify-center gap-1 ${
                  customerFilter === 'all'
                    ? 'bg-emerald-500/90 text-white shadow-md shadow-emerald-950/35 ring-1 ring-emerald-200/30'
                    : 'text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-100'
                }`}
              >
                全部
              </button>
              <button
                onClick={() => setCustomerFilter('super')}
                className={`flex-1 px-2 py-1.5 text-[10px] font-bold rounded-md transition-all duration-200 flex items-center justify-center gap-1 ${
                  customerFilter === 'super'
                    ? 'bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-md shadow-amber-950/35 ring-1 ring-amber-200/30'
                    : 'text-slate-400 hover:bg-amber-500/10 hover:text-amber-100'
                }`}
              >
                <Star className="w-2.5 h-2.5" fill={customerFilter === 'super' ? 'currentColor' : 'none'} />
                VIP
              </button>
              <button
                onClick={() => setCustomerFilter('regular')}
                className={`flex-1 px-2 py-1.5 text-[10px] font-bold rounded-md transition-all duration-200 flex items-center justify-center gap-1 ${
                  customerFilter === 'regular'
                    ? 'bg-gradient-to-r from-teal-500 to-emerald-500 text-white shadow-md shadow-emerald-950/35 ring-1 ring-teal-200/30'
                    : 'text-slate-400 hover:bg-teal-500/10 hover:text-teal-100'
                }`}
              >
                一般
              </button>
            </div>
          </div>

          {/* Customer List - Scrollable */}
          <div className="flex-1 overflow-y-auto bg-gradient-to-b from-slate-950/20 via-transparent to-emerald-950/10 p-2.5 space-y-1.5 scrollbar-dark">
            {customers
              .filter(customer => {
                if (customerFilter === 'super') return customer.is_super === true;
                if (customerFilter === 'regular') return !customer.is_super;
                return true;
              })
              .sort((a, b) => {
                const aPinned = a.is_pinned ? 1 : 0;
                const bPinned = b.is_pinned ? 1 : 0;
                if (aPinned !== bPinned) return bPinned - aPinned;

                const aUnread = customerUnreadCountsForCards[a.id] || 0;
                const bUnread = customerUnreadCountsForCards[b.id] || 0;
                if (aUnread > 0 && bUnread === 0) return -1;
                if (aUnread === 0 && bUnread > 0) return 1;

                const aMessageTime = aUnread > 0
                  ? customerLatestUnreadMessageTimesForCards[a.id] || 0
                  : customerLatestMessageTimesForCards[a.id] || 0;
                const bMessageTime = bUnread > 0
                  ? customerLatestUnreadMessageTimesForCards[b.id] || 0
                  : customerLatestMessageTimesForCards[b.id] || 0;
                const timeDifference = bMessageTime - aMessageTime;
                if (timeDifference !== 0) return timeDifference;
                if (aUnread !== bUnread) return bUnread - aUnread;
                if (a.is_super && !b.is_super) return -1;
                if (!a.is_super && b.is_super) return 1;
                return 0;
              })
              .map((customer) => (
              <div
                key={customer.id}
                className={`group relative min-h-[72px] cursor-pointer rounded-xl border transition-all duration-200 hover:-translate-y-px focus-within:ring-2 focus-within:ring-emerald-300/60 ${
                  customer.is_super
                    ? selectedCustomer?.id === customer.id
                      ? 'border border-amber-200/80 bg-gradient-to-br from-amber-500 via-orange-500 to-amber-600 p-3.5 shadow-xl shadow-amber-950/40 ring-1 ring-amber-100/30'
                      : 'border-amber-400/35 bg-gradient-to-br from-slate-800/95 to-amber-950/35 p-3 shadow-md shadow-amber-950/20 hover:border-amber-300/75 hover:shadow-lg hover:shadow-amber-950/35'
                    : selectedCustomer?.id === customer.id
                      ? 'border-emerald-200/80 bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-500 p-2.5 shadow-xl shadow-emerald-950/40 ring-1 ring-emerald-100/30'
                      : 'border-slate-700/60 bg-slate-800/55 p-2 hover:border-emerald-300/65 hover:bg-emerald-950/35 hover:shadow-lg hover:shadow-emerald-950/35'
                }`}
                onClick={() => handleSelectCustomer(customer)}
              >
                {/* Remarks - top right corner */}
                {customer.remarks && (
                  <span className="absolute top-1 right-7 text-[11px] font-medium text-white truncate max-w-[45%] z-10 pointer-events-none leading-tight" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8), 0 0 6px rgba(0,0,0,0.5)' }} title={customer.remarks}>{customer.remarks}</span>
                )}
                {/* Pinned indicator - top left corner */}
                {customer.is_pinned && (
                  <div className="absolute -top-1.5 -left-1.5 w-5 h-5 bg-teal-500 rounded-full flex items-center justify-center z-20 shadow-md shadow-teal-500/40 ring-1 ring-teal-400/60">
                    <Pin className="w-3 h-3 text-white" style={{ transform: 'rotate(-45deg)' }} />
                  </div>
                )}
                {/* Unread Badge */}
                {(() => {
                  const count = customerUnreadCountsForCards[customer.id] || 0;
                  return count > 0 && (
                    <div className="manager-unread-badge absolute -top-2 -right-2 min-w-[22px] h-[22px] px-1.5 bg-red-500 rounded-full flex items-center justify-center z-20 shadow-lg shadow-red-500/40 ring-2 ring-slate-900/80">
                      <span className="text-[10px] font-bold text-white leading-none">{count > 99 ? '99+' : count}</span>
                    </div>
                  );
                })()}
                <div className={`flex items-center ${customer.is_super ? 'gap-3' : selectedCustomer?.id === customer.id ? 'gap-2.5' : 'gap-2'}`}>
                  <div className="relative flex-shrink-0">
                    {customer.is_super && customer.badge_type && (
                      <div className={`absolute -top-1 -left-1 ${customer.is_super ? 'w-5 h-5 text-[10px]' : 'w-4 h-4 text-[8px]'} bg-amber-500 rounded-full flex items-center justify-center z-10`}>
                        {customer.badge_type === 'diamond' ? '💎' : customer.badge_type === 'crown' ? '👑' : customer.badge_type === 'star' ? '⭐' : customer.badge_type === 'vip' ? '🏆' : '✨'}
                      </div>
                    )}
                    <CustomerAvatarDisplay
                      avatar={customer.customer_avatar}
                      isVip={customer.is_super}
                      customAvatarUrl={customer.custom_avatar_url}
                      alt={customer.customer_name}
                      className={`rounded-full ${
                        customer.is_super
                          ? selectedCustomer?.id === customer.id ? 'w-11 h-11' : 'w-10 h-10'
                          : selectedCustomer?.id === customer.id ? 'w-9 h-9' : 'w-8 h-8'
                      } ${
                        selectedCustomer?.id === customer.id
                          ? customer.is_super ? 'bg-amber-800/40 ring-2 ring-white/50' : 'bg-white/20 ring-1 ring-white/30'
                          : customer.is_super ? 'bg-amber-900/50 ring-2 ring-amber-400/50' : 'bg-slate-700 ring-1 ring-slate-500/40'
                      }`}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    {customer.is_super && customer.super_customer_title && (
                      <span className={`font-bold block leading-tight truncate ${
                        selectedCustomer?.id === customer.id ? 'text-[12px]' : 'text-[11px]'
                      } ${
                        selectedCustomer?.id === customer.id ? 'text-amber-950/90' : 'text-amber-400'
                      }`} style={customer.is_super ? { textShadow: selectedCustomer?.id === customer.id ? 'none' : '0 1px 3px rgba(0,0,0,0.5)' } : undefined}>{customer.super_customer_title}</span>
                    )}
                    <span className={`font-semibold block truncate leading-tight ${
                      customer.is_super
                        ? selectedCustomer?.id === customer.id ? 'text-sm' : 'text-sm'
                        : selectedCustomer?.id === customer.id ? 'text-[13px]' : 'text-xs'
                    } ${
                      selectedCustomer?.id === customer.id
                        ? customer.is_super ? 'text-white' : 'text-white'
                        : customer.is_super ? 'text-slate-100' : 'text-slate-200'
                    }`} style={{ textShadow: customer.is_super ? (selectedCustomer?.id === customer.id ? '0 2px 6px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3)' : '0 1px 3px rgba(0,0,0,0.5)') : (selectedCustomer?.id === customer.id ? '0 2px 6px rgba(0,0,0,0.45), 0 1px 2px rgba(0,0,0,0.3)' : '0 1px 2px rgba(0,0,0,0.4)') }} title={customer.customer_name}>{customer.customer_name}</span>
                    <span className={`font-mono block truncate ${
                      customer.is_super
                        ? selectedCustomer?.id === customer.id ? 'text-[12px] font-semibold' : 'text-[10px]'
                        : selectedCustomer?.id === customer.id ? 'text-[11px]' : 'text-[9px]'
                    } ${
                      selectedCustomer?.id === customer.id
                        ? customer.is_super ? 'text-amber-950/80' : 'text-blue-100'
                        : customer.is_super ? 'text-amber-300/70' : 'text-slate-400'
                    }`} style={{ textShadow: customer.is_super ? (selectedCustomer?.id === customer.id ? 'none' : '0 1px 2px rgba(0,0,0,0.4)') : (selectedCustomer?.id === customer.id ? '0 2px 4px rgba(0,0,0,0.35), 0 1px 1px rgba(0,0,0,0.2)' : '0 1px 2px rgba(0,0,0,0.3)') }}>{customer.customer_id}</span>
                    {/* Employee display setting indicators */}
                    {(customer.employee_pin_top || customer.employee_always_visible || (customer.target_employee_ids && customer.target_employee_ids.length > 0)) && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {customer.employee_pin_top && (
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                            selectedCustomer?.id === customer.id ? 'bg-white/20 text-white' : 'bg-teal-500/20 text-teal-300 border border-teal-500/30'
                          }`}>
                            <Pin className="w-2.5 h-2.5" style={{ transform: 'rotate(-45deg)' }} />置頂
                          </span>
                        )}
                        {customer.employee_always_visible && (
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                            selectedCustomer?.id === customer.id ? 'bg-white/20 text-white' : 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30'
                          }`}>
                            <Eye className="w-2.5 h-2.5" />顯示
                          </span>
                        )}
                        {customer.target_employee_ids && customer.target_employee_ids.length > 0 && (
                          <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                            selectedCustomer?.id === customer.id ? 'bg-white/20 text-white' : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                          }`}>
                            <User className="w-2.5 h-2.5" />
                            {customer.target_employee_ids.length === 1
                              ? (employees.find(e => e.id === customer.target_employee_ids![0])?.username || '指定員工')
                              : `${customer.target_employee_ids.length} 位員工`}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {/* Pin/Edit/Delete on hover - bottom right corner */}
                <div className="absolute bottom-1 right-1 opacity-0 group-hover:opacity-100 transition-all duration-200 flex items-center gap-0.5 z-10">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleCustomerPin(customer);
                      }}
                      className={`p-1 rounded transition-all duration-150 border ${customer.is_pinned ? 'bg-teal-600 border-teal-400 text-white' : 'bg-slate-600 border-slate-500 text-white hover:bg-teal-600 hover:border-teal-400'}`}
                      title={customer.is_pinned ? '取消置頂' : '置頂'}
                    >
                      <Pin className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingCustomer(customer);
                        setCustomerForm({
                          name: customer.customer_name,
                          avatar: customer.customer_avatar,
                          isSuper: customer.is_super || false,
                          superTitle: customer.super_customer_title || '',
                          customId: customer.customer_id || '',
                          badgeType: customer.badge_type || '',
                          vipLabel: customer.vip_label || 'VIP',
                          customAvatarFile: null,
                          useCustomAvatar: !!customer.custom_avatar_url,
                          remarks: customer.remarks || '',
                        employeePinTop: customer.employee_pin_top || false,
                        employeeAlwaysVisible: customer.employee_always_visible || false,
                        targetEmployeeIds: customer.target_employee_ids || [],
                        _empSearch: ''
                        });
                      }}
                      className={`p-1 rounded transition-all duration-150 border ${selectedCustomer?.id === customer.id ? (customer.is_super ? 'bg-blue-600 border-blue-400 text-white hover:bg-blue-500' : 'bg-emerald-600 border-emerald-400 text-white hover:bg-emerald-500') : 'bg-slate-600 border-slate-500 text-white hover:bg-blue-600 hover:border-blue-500'}`}
                      title="編輯"
                    >
                      <Edit2 className="w-3 h-3" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteCustomer(customer.id);
                      }}
                      className={`p-1 rounded transition-all duration-150 border ${selectedCustomer?.id === customer.id ? (customer.is_super ? 'bg-red-600 border-red-400 text-white hover:bg-red-500' : 'bg-red-500 border-red-300 text-white hover:bg-red-400') : 'bg-slate-600 border-slate-500 text-white hover:bg-red-600 hover:border-red-500'}`}
                      title="刪除"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
              </div>
            ))}
            {customers.length === 0 && (
              <div className="text-center py-6 text-slate-400">
                <Users className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-[10px]">尚無經理</p>
              </div>
            )}
          </div>
        </div>

        {/* Middle: Employee List */}
        <div className="flex h-[240px] w-full flex-shrink-0 flex-col overflow-hidden rounded-xl border border-emerald-400/30 bg-gradient-to-b from-emerald-950/25 via-slate-900/90 to-slate-950/80 shadow-xl shadow-emerald-950/20 backdrop-blur-xl lg:h-auto lg:w-[clamp(11rem,17vw,16rem)]">
          {/* Employee Header */}
          <div className="p-2 border-b border-emerald-500/40 bg-slate-800/60 space-y-1.5">
            {/* Search + Tag dropdown row */}
            <div className="flex gap-1">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#94a3b8]" />
                <input
                  type="text"
                  placeholder="搜尋員工……"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-8 pr-8 py-2 bg-[#e8ecf1] border border-[#cbd5e1] rounded-lg text-[#1e293b] placeholder-[#94a3b8] text-xs focus:outline-none focus:border-[#3b82f6] focus:ring-2 focus:ring-[#3b82f6] transition-all"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setSearchQuery('');
                    }}
                    onClick={() => setSearchQuery('')}
                    aria-label="清除員工搜尋"
                    className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-emerald-300/60 bg-emerald-700/80 text-emerald-50 shadow-sm transition-colors hover:bg-emerald-600 hover:text-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              {allTags.length > 0 && (
                <div className="relative flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowTagDropdown(!showTagDropdown)}
                    className={`relative flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-bold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70 ${selectedTags.length > 0 ? 'border-emerald-300/70 bg-emerald-500/25 text-emerald-50 shadow-md shadow-emerald-950/30' : 'border-emerald-300/30 bg-slate-900/55 text-emerald-200 hover:border-emerald-200/70 hover:bg-emerald-500/15 hover:text-emerald-100'}`}
                    title="依標籤篩選"
                  >
                    <Tag className="w-3.5 h-3.5" />
                    {selectedTags.length > 0 && (
                      <span className="flex h-4 min-w-[18px] items-center justify-center rounded-md border border-emerald-200/30 bg-emerald-300 px-1 text-[9px] font-black text-emerald-950 shadow-sm">{selectedTags.length}</span>
                    )}
                  </button>
                  {selectedTags.length > 0 && (
                    <button
                      type="button"
                      onClick={() => { setSelectedTags([]); setShowTagDropdown(false); }}
                      className="flex items-center justify-center rounded-xl border border-rose-300/35 bg-rose-500/10 px-1.5 py-1.5 text-rose-200 shadow-sm shadow-rose-950/20 transition-all duration-200 hover:-translate-y-0.5 hover:border-rose-200/80 hover:bg-rose-500 hover:text-white hover:shadow-md hover:shadow-rose-950/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/70"
                      title="清除所有標籤"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                  {showTagDropdown && (
                    <>
                      <div className="fixed inset-0 z-20" onMouseDown={() => setShowTagDropdown(false)} />
                      <div className="absolute right-0 top-full z-30 mt-2 min-w-[180px] max-h-56 overflow-y-auto rounded-2xl border border-emerald-300/35 bg-slate-900 p-2 shadow-2xl shadow-emerald-950/35 ring-1 ring-emerald-200/10 scrollbar-dark">
                        {allTags.map((tag) => {
                          const isSelected = selectedTags.includes(tag);
                          return (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => isSelected ? setSelectedTags(selectedTags.filter(t => t !== tag)) : setSelectedTags([...selectedTags, tag])}
                              className={`flex w-full cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-xs font-semibold transition-all duration-200 mb-1 last:mb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70 ${
                                isSelected
                                  ? 'border-emerald-300/45 bg-emerald-500/20 text-emerald-50 shadow-sm shadow-emerald-950/25'
                                  : 'border-transparent bg-transparent text-slate-300 hover:border-emerald-300/20 hover:bg-emerald-500/10 hover:text-emerald-100'
                              }`}
                            >
                              <span className={`w-3.5 h-3.5 rounded flex items-center justify-center flex-shrink-0 border transition-colors ${
                                isSelected
                                  ? 'border-emerald-100 bg-emerald-100'
                                  : 'border-emerald-300/40 bg-white'
                              }`}>
                                {isSelected && <Check className="h-2.5 w-2.5 text-emerald-600" />}
                              </span>
                              {tag}
                            </button>
                          );
                        })}
                        {selectedTags.length > 0 && (
                          <button type="button" onClick={() => { setSelectedTags([]); setShowTagDropdown(false); }} className="mt-2 w-full rounded-xl border border-rose-300/30 bg-rose-500/10 px-2 py-1.5 text-center text-xs font-bold text-rose-200 transition-all duration-200 hover:border-rose-200/70 hover:bg-rose-500 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/70">全部清除</button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Filter row */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-emerald-300 tabular-nums flex-shrink-0">{filteredEmployees.length}<span className="text-emerald-500/70">/{employees.length}</span></span>
              <div className="flex items-center gap-1 flex-1">
                <button type="button" onClick={() => setEmployeeGroupFilter('all')} className={`flex-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-all border ${employeeGroupFilter === 'all' ? 'bg-blue-500 text-white border-blue-400 shadow-md shadow-blue-500/30' : 'bg-slate-800/60 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'}`}>全部</button>
                <button type="button" onClick={() => setEmployeeGroupFilter('chatted')} className={`flex-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-all border ${employeeGroupFilter === 'chatted' ? 'bg-emerald-500 text-white border-emerald-400 shadow-md shadow-emerald-500/30' : 'bg-slate-800/60 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'}`}>已聊天</button>
                <button type="button" onClick={() => setEmployeeGroupFilter('not_chatted')} className={`flex-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-all border ${employeeGroupFilter === 'not_chatted' ? 'bg-amber-500 text-white border-amber-400 shadow-md shadow-amber-500/30' : 'bg-slate-800/60 border-slate-700/40 text-slate-400 hover:text-slate-200 hover:border-slate-600'}`}>新的</button>
              </div>
            </div>
          </div>

            {/* Employee List - Scrollable */}
            <div ref={employeeListRef} className="flex-1 overflow-y-auto p-1.5 scrollbar-dark">
              <div className="space-y-0.5">
                {filteredEmployees.map((emp) => (
                  <button
                    type="button"
                    key={emp.id}
                    onMouseEnter={() => {
                      if (selectedCustomer) void prefetchMessages(selectedCustomer.id, emp.id);
                    }}
                    onClick={() => handleSelectEmployee(emp)}
                    className={`group relative min-h-[72px] w-full rounded-xl border px-2 py-2 text-left transition-all duration-200 hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70 ${
                      selectedEmployee?.id === emp.id
                        ? 'border-emerald-200/70 bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-500 shadow-lg shadow-emerald-950/40 ring-1 ring-emerald-200/40'
                        : 'border-slate-700/60 bg-slate-800/45 hover:border-emerald-400/60 hover:bg-emerald-950/45 hover:shadow-md hover:shadow-emerald-950/35'
                    }`}
                  >
                    <div className={`flex min-w-0 items-center pr-1 ${selectedEmployee?.id === emp.id ? 'gap-2' : 'gap-1.5'}`}>
                      <div className="relative flex-shrink-0">
                        <div className={`rounded flex items-center justify-center ${
                          selectedEmployee?.id === emp.id ? 'h-9 w-9 bg-white/15 ring-1 ring-white/25' : 'h-7 w-7 border border-slate-700/70 bg-slate-900/70 group-hover:border-emerald-400/50 group-hover:bg-emerald-950/40'
                        }`}>
                          <User className={`${selectedEmployee?.id === emp.id ? 'h-4 w-4' : 'h-3 w-3'} ${selectedEmployee?.id === emp.id ? 'text-white' : 'text-slate-400 group-hover:text-emerald-200'}`} />
                        </div>
                      </div>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex min-w-0 items-center gap-1 leading-4">
                          <span className={`truncate font-bold leading-4 ${selectedEmployee?.id === emp.id ? 'text-[15px] text-white' : 'text-[11px] text-slate-200'}`} style={selectedEmployee?.id === emp.id ? { textShadow: '0 2px 6px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3)' } : undefined}>{emp.username}</span>
                          {selectedEmployee?.id === emp.id && <span className="ml-auto flex-shrink-0 rounded bg-white/25 px-1.5 py-0.5 text-[9px] font-bold leading-relaxed text-white" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>啟用中</span>}
                        </div>
                        <div className={`truncate font-mono leading-3 ${selectedEmployee?.id === emp.id ? 'text-[11px] text-emerald-100' : 'text-[10px] text-slate-400 group-hover:text-emerald-200/80'}`} style={selectedEmployee?.id === emp.id ? { textShadow: '0 2px 4px rgba(0,0,0,0.45), 0 1px 1px rgba(0,0,0,0.25)' } : undefined}>編號： {emp.employee_id || '—'}</div>
                        <EmployeeMetadataPopover
                          kind="tag"
                          theme="emerald"
                          values={emp.tags}
                          selected={selectedEmployee?.id === emp.id}
                          className="w-full max-w-full leading-3"
                        />
                        <EmployeeMetadataPopover
                          kind="note"
                          theme="emerald"
                          value={emp.remarks}
                          selected={selectedEmployee?.id === emp.id}
                          className="w-full max-w-full leading-3"
                        />
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {filteredEmployees.length === 0 && employees.length > 0 && (
                <div className="text-center py-4 text-slate-400">
                  <Filter className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-[10px] font-medium mb-1">沒有符合的結果</p>
                  <button type="button" onClick={() => { setSearchQuery(''); setSelectedTags([]); }} className="text-[10px] text-blue-400 hover:text-blue-300">清除篩選</button>
                </div>
              )}

              {employees.length === 0 && (
                <div className="text-center py-4 text-slate-400">
                  <User className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p className="text-[10px]">尚無員工</p>
                </div>
              )}
            </div>
          </div>

          {/* Right: Chat Interface or History View */}
          <div className="relative flex min-h-[420px] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-emerald-400/30 bg-slate-950/75 shadow-2xl shadow-emerald-950/15 backdrop-blur-xl">
          {/* History / Sessions Panel */}
          <div className={`absolute inset-0 ${
            showHistoryView || (selectedCustomer && !selectedEmployee)
              ? 'opacity-100 translate-y-0 z-10 pointer-events-auto'
              : 'opacity-0 translate-y-2 z-0 pointer-events-none'
          }`}>
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-emerald-400/35 bg-gradient-to-b from-emerald-950/20 via-slate-900/90 to-slate-950/95 shadow-2xl shadow-emerald-950/20 backdrop-blur-xl">
              {/* Active Sessions Header */}
              <div className="flex h-[72px] min-h-[72px] shrink-0 items-center overflow-hidden border-b border-emerald-400/35 bg-gradient-to-r from-slate-900 via-slate-800/95 to-emerald-950/25 px-3 py-2">
                <div className="flex min-w-0 w-full flex-nowrap items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden">
                    {selectedCustomer ? (
                      <CustomerAvatarDisplay
                        avatar={selectedCustomer?.customer_avatar}
                        isVip={selectedCustomer?.is_super}
                        customAvatarUrl={selectedCustomer?.custom_avatar_url}
                        alt={selectedCustomer?.customer_name}
                        className="h-10 w-10 flex-shrink-0 rounded-full bg-slate-700/50 ring-2 ring-slate-600/50"
                      />
                    ) : (
                      <div className="p-2 bg-blue-600 rounded-lg flex-shrink-0">
                        <MessageCircle className="w-5 h-5 text-white" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <h3 className="text-base font-bold text-white leading-tight truncate">{historyFilterMode === 'special' && historyScope === 'all' ? '特別關注' : selectedCustomer ? selectedCustomer.customer_name : '進行中的工作階段'}</h3>
                      {selectedCustomer?.is_super && selectedCustomer?.super_customer_title ? (
                        <p className="text-[11px] text-amber-400 font-medium leading-tight mt-0.5 truncate">{selectedCustomer?.super_customer_title}</p>
                      ) : null}
                      <p className="text-[11px] text-emerald-400 font-mono leading-tight mt-0.5">{selectedCustomer ? `CUS-${selectedCustomer.customer_id}` : '選擇對話以繼續'}</p>
                    </div>
                  </div>
                  <div className="flex min-w-0 max-w-[58%] items-center gap-1">
                    <div className="relative min-w-0 flex-1 basis-[120px]">
                      <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-emerald-300/90" />
                      <input
                        type="text"
                        value={historySearchQuery}
                        onChange={(event) => setHistorySearchQuery(event.target.value)}
                        placeholder="搜尋工作階段……"
                        aria-label="搜尋進行中的工作階段"
                        className="h-8 w-full min-w-0 rounded-lg border border-emerald-700/80 bg-slate-700/90 pl-7 pr-7 text-[10px] font-semibold text-slate-100 outline-none transition-colors placeholder:text-slate-400 focus:border-emerald-400/80 focus:bg-slate-700 focus:ring-2 focus:ring-emerald-400/30"
                      />
                      {historySearchQuery && (
                        <button
                          type="button"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            setHistorySearchQuery('');
                          }}
                          onClick={() => setHistorySearchQuery('')}
                          aria-label="清除工作階段搜尋"
                          className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-slate-400/60 bg-slate-800 text-slate-100 shadow-sm transition-colors hover:border-emerald-300/80 hover:bg-emerald-700/80 hover:text-white"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  {historyScope === 'customer' && (
                  <div className="flex items-center gap-2">
                      {(() => {
                        const customerHistory = selectedCustomer
                          ? conversationHistoryForView.filter(history => history.customer_id === selectedCustomer.id)
                          : [];
                        const scoped = selectedEmployee
                          ? customerHistory.filter(history => history.employee_id === selectedEmployee.id)
                          : customerHistory;
                        const scopedNew = scoped.filter(history => history.unread_count > 0).length;
                        return (
                          <>
                            <button type="button" onClick={() => setHistoryFilterMode('all')} className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all duration-200 ${historyFilterMode !== 'new' ? 'bg-emerald-600 text-white' : 'bg-slate-700/50 text-slate-300 ring-1 ring-slate-600/50 hover:bg-slate-600/50 hover:text-white'}`}>
                              <span>全部</span>
                              {scoped.length > 0 && (
                                <span className={`inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full text-[11px] font-black ${historyFilterMode !== 'new' ? 'bg-white text-emerald-700' : 'bg-slate-500/50 text-slate-200'}`}>{scoped.length}</span>
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setHistoryFilterMode('new')}
                              aria-pressed={historyFilterMode === 'new'}
                              className={`relative flex items-center gap-1.5 rounded-xl border px-3.5 py-2 text-xs font-bold tracking-wide transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 ${scopedNew > 0 ? 'session-unread-action' : ''} ${
                                historyFilterMode === 'new'
                                  ? 'border-orange-300 bg-gradient-to-r from-orange-600 via-orange-500 to-rose-600 text-white shadow-lg shadow-orange-500/45 ring-2 ring-orange-300/30 hover:brightness-110'
                                  : scopedNew > 0
                                    ? 'border-slate-600/50 bg-slate-700/50 text-slate-200 hover:border-slate-500 hover:bg-slate-600/50 hover:text-white'
                                    : 'border-slate-600/50 bg-slate-700/50 text-slate-300 hover:border-slate-500 hover:bg-slate-600/50 hover:text-white'
                              }`}
                            >
                              {scopedNew > 0 && historyFilterMode !== 'new' && (
                                <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-300 shadow-sm shadow-amber-400/80 ring-2 ring-slate-900" />
                              )}
                              <MessageSquarePlus className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>新的</span>
                              {scopedNew > 0 ? (
                                <span className="session-unread-count inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-white px-1.5 text-[11px] font-black text-orange-700 shadow-sm shadow-orange-950/20">{scopedNew}</span>
                              ) : (
                                <span className={`inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full text-[11px] font-black ${historyFilterMode === 'new' ? 'bg-white text-orange-700' : 'bg-slate-500/50 text-slate-400'}`}>0</span>
                              )}
                            </button>
                          </>
                        );
                      })()}
                    </div>
                  )}

                  </div>
                </div>
              </div>

              {/* Active Sessions List */}
              <div ref={historyListRef} className="flex-1 overflow-y-auto p-2 scrollbar-dark">
                {annotationLoadFailed && <button type="button" onClick={() => setAnnotationReloadKey(key => key + 1)} className="mb-2 w-full rounded-lg border border-rose-400/50 bg-rose-950/40 p-2 text-xs text-rose-100 hover:bg-rose-900/50">對話註記載入失敗，點擊重試</button>}
                {visibleConversationHistory.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-slate-400">
                    {historyFilterMode === 'special' ? <Star className="w-16 h-16 mb-4 opacity-50" /> : <MessageCircle className="w-16 h-16 mb-4 opacity-50" />}
                    <p>{historyFilterMode === 'special' ? '目前沒有特別關注的對話' : historySearchQuery.trim() ? '沒有符合的工作階段' : '沒有進行中的工作階段'}</p>
                    <p className="text-xs mt-2">{historyFilterMode === 'special' ? '在對話卡片中加入特別關注' : '開始對話後會顯示在這裡'}</p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {visibleConversationHistory.map((history) => {
                        const employee = workspaceEmployeesById.get(history.employee_id);
                        const historyCustomer = history.customer_id
                          ? workspaceCustomersById.get(history.customer_id)
                            || allCustomersRef.current.find(c => c.id === history.customer_id)
                          : null;
                        const isSelected = selectedEmployee?.id === history.employee_id && selectedCustomer?.id === history.customer_id;
                        const cardKey = `${history.customer_id || ''}_${history.employee_id}`;
                        const annotation = currentAnnotations[conversationAnnotationKey(history.customer_id!, history.employee_id)];
                        const lastTime = new Date(history.last_message_time);
                        const timeStr = `${lastTime.getFullYear()}/${String(lastTime.getMonth() + 1).padStart(2, '0')}/${String(lastTime.getDate()).padStart(2, '0')} ${lastTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                        const hasUnread = history.unread_count > 0;
                        const employeeTags = employee?.tags?.length
                          ? employee.tags
                          : history.employee_tags || [];
                        const employeeNote = employee?.remarks?.trim()
                          || history.employee_remarks?.trim()
                          || '';
                        return (
                          <div key={cardKey} className={`relative overflow-hidden rounded-lg border transition-colors ${
                            isSelected
                              ? 'border-emerald-300/70 bg-emerald-500/20 shadow-md shadow-emerald-500/20 ring-2 ring-emerald-200/35'
                              : hasUnread
                                ? 'border-emerald-400/60 bg-gradient-to-r from-emerald-950/40 to-teal-950/25 shadow-sm shadow-emerald-500/20 hover:bg-emerald-900/60 hover:ring-2 hover:ring-emerald-200/55'
                                : annotation?.is_special
                                  ? 'border-amber-400/45 bg-amber-950/15 hover:bg-emerald-900/55 hover:ring-2 hover:ring-emerald-300/50'
                                  : 'border-slate-700/40 bg-slate-800/30 hover:bg-emerald-900/55 hover:ring-2 hover:ring-emerald-300/50'
                          }`}>
                            <button
                              type="button"
                              onMouseEnter={() => {
                                if (history.customer_id) void prefetchMessages(history.customer_id, history.employee_id);
                              }}
                              onClick={() => {
                                const emp = employee
                                  || workspaceEmployeesById.get(history.employee_id)
                                  || allEmployeesRef.current.find(e => e.id === history.employee_id)
                                  || {
                                    id: history.employee_id,
                                    username: history.employee_username || '員工',
                                    employee_id: history.employee_number || '',
                                    is_verified: true,
                                    is_active: true,
                                    remarks: history.employee_remarks || '',
                                    tags: history.employee_tags || [],
                                  };
                                const cust = history.customer_id
                                  ? workspaceCustomersById.get(history.customer_id)
                                    || allCustomersRef.current.find(c => c.id === history.customer_id)
                                    || {
                                      id: history.customer_id,
                                      admin_id: selectedAdminId || adminId,
                                      customer_name: history.customer_name || '經理',
                                      customer_id: history.customer_id,
                                      customer_avatar: history.customer_avatar || 'customer-avatar:regular:0',
                                      is_active: true,
                                      created_at: history.last_message_time || new Date().toISOString(),
                                      is_super: history.customer_avatar?.startsWith('customer-avatar:vip:') || false,
                                      custom_avatar_url: history.custom_avatar_url,
                                      employee_pin_top: false,
                                      employee_always_visible: false,
                                      target_employee_ids: null,
                                    }
                                  : null;
                                if (!cust) return;

                                if (historyListRef.current) {
                                  historyScrollTopRef.current = historyListRef.current.scrollTop;
                                }
                                setMessages([]);
                                setMessagesLoading(true);
                                restoreCachedMessages(cust.id, emp.id);
                                isInitialLoadRef.current = true;
                                clearUnreadConversationLocally(cust.id, emp.id);
                                setSelectedCustomer(cust);
                                handleSelectEmployee(emp);
                                setFromHistoryFilterMode(historyFilterMode);
                                setFromHistorySource(historyScope);
                              }}
                              className="group relative w-full px-3 pt-2 pb-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-300"
                            >
                              {isSelected ? (
                                <div className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-blue-400" />
                              ) : hasUnread ? (
                                <div className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-orange-400 " />
                              ) : null}
                              <div className="flex items-start gap-2.5">
                                {/* Avatar */}
                                <div className="relative flex-shrink-0 mt-0.5">
                                  {history.customer_name ? (
                                    <div className={`w-9 h-9 rounded-full flex items-center justify-center text-base ring-2 overflow-hidden ${
                                      isSelected ? 'ring-blue-500/40 bg-blue-950/50' : 'ring-slate-600/30 bg-slate-700/50'
                                    }`}>
                                      <CustomerAvatarDisplay
                                        avatar={historyCustomer?.customer_avatar || history.customer_avatar}
                                        isVip={historyCustomer?.is_super || (historyCustomer?.customer_avatar || history.customer_avatar)?.startsWith('customer-avatar:vip:')}
                                        customAvatarUrl={historyCustomer?.custom_avatar_url || history.custom_avatar_url}
                                        alt={history.customer_name || '經理頭像'}
                                        className="h-9 w-9 rounded-full"
                                      />
                                    </div>
                                  ) : (
                                    <div className={`w-9 h-9 rounded-full flex items-center justify-center ring-2 ${
                                      isSelected ? 'ring-blue-500/40 bg-blue-950/50' : 'ring-slate-600/30 bg-slate-700/50'
                                    }`}>
                                      <User className={`w-4 h-4 ${isSelected ? 'text-blue-300' : 'text-slate-400'}`} />
                                    </div>
                                  )}
                                </div>

                                {/* Content */}
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center justify-between gap-2 mb-0.5">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      {history.customer_name && (
                                        <span className={`text-[11px] font-bold truncate ${isSelected ? 'text-blue-300' : 'text-emerald-400'}`}>{history.customer_name}</span>
                                      )}
                                      {annotation?.is_special && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="已特別關注" />}
                                    </div>
                                    <span className={`text-[10px] flex-shrink-0 tabular-nums whitespace-nowrap ${
                                      hasUnread ? 'text-orange-300 font-bold' : 'text-emerald-200/90 font-semibold'
                                    }`}>{timeStr}</span>
                                  </div>
                                  <div className="flex items-center gap-1.5 mb-1">
                                    <span className={`text-xs font-semibold truncate ${isSelected ? 'text-slate-200' : 'text-slate-300'}`}>{history.employee_username}</span>
                                    <span className="text-[10px] text-emerald-200/90 font-mono flex-shrink-0">編號： {history.employee_number || '—'}</span>
                                  </div>

                                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 pr-1">
                                    <EmployeeMetadataPopover
                                      kind="tag"
                                      theme="emerald"
                                      values={employeeTags}
                                      selected={isSelected}
                                      className="relative min-w-0 max-w-[48%]"
                                    />
                                    <EmployeeMetadataPopover
                                      kind="note"
                                      theme="emerald"
                                      value={employeeNote}
                                      selected={isSelected}
                                      className="relative min-w-0 max-w-[48%]"
                                    />
                                  </div>

                                </div>
                              </div>
                            </button>
                            <div className="flex min-w-0 items-center gap-2 pl-[49px] pr-3 pt-0.5 pb-1">
                              <div className="flex shrink-0 items-center gap-1.5">
                                <button
                                  type="button"
                                  disabled={annotationsWorkspaceId !== selectedAdminId}
                                  onClick={() => setAnnotationDialog({ kind: 'special', history, nextSpecial: !annotation?.is_special })}
                                  aria-label={`${annotation?.is_special ? '移除' : '加入'}特別關注：${history.employee_username}（${history.employee_number}）`}
                                  className={`inline-flex h-6 shrink-0 items-center gap-1 rounded border px-2 text-[10px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:cursor-wait disabled:opacity-50 ${annotation?.is_special ? 'border-amber-300 bg-amber-600 text-white hover:bg-amber-500' : 'border-amber-500/50 bg-amber-950/50 text-amber-200 hover:border-amber-300 hover:bg-amber-800/50'}`}
                                >
                                  <Star className={`h-3 w-3 ${annotation?.is_special ? 'fill-amber-200' : ''}`} />
                                  {annotation?.is_special ? '移除關注' : '加入特別關注'}
                                </button>
                                <button
                                  type="button"
                                  disabled={annotationsWorkspaceId !== selectedAdminId}
                                  onClick={() => { setNoteDraft(annotation?.note || ''); setAnnotationDialog({ kind: 'note', history }); }}
                                  aria-label={`編輯對話備註：${history.employee_username}（${history.employee_number}）`}
                                  className="inline-flex h-6 shrink-0 items-center gap-1 rounded border border-blue-400/70 bg-blue-600 px-2 text-[10px] font-semibold text-white transition-colors hover:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 disabled:cursor-wait disabled:opacity-50"
                                >
                                  <Pencil className="h-3 w-3" /> 對話備註
                                </button>
                              </div>
                              {annotation?.note && <p className={`min-w-0 flex-1 truncate text-right text-[10px] text-cyan-300 ${hasUnread ? 'pr-9' : ''}`} title={annotation.note}>備註：{annotation.note}</p>}
                            </div>
                            {hasUnread && (
                              <div className="manager-unread-badge pointer-events-none absolute right-3 top-1/2 z-10 flex h-[30px] min-w-[30px] -translate-y-1/2 items-center justify-center rounded-full border-2 border-slate-900 bg-gradient-to-br from-orange-500 to-red-500 px-2 shadow-md shadow-orange-500/40">
                                <span className="text-[12px] font-black leading-none text-white drop-shadow-sm">{history.unread_count > 99 ? '99+' : history.unread_count}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    {visibleConversationHistory.length === 0 && (
                      <div className="text-center py-6 text-slate-500">
                        <Search className="w-8 h-8 mx-auto mb-2 opacity-30" />
                        <p className="text-[10px]">
                          {historySearchQuery.trim()
                            ? '沒有符合的工作階段'
                            : historyFilterMode === 'new'
                              ? '沒有新訊息'
                              : '找不到工作階段'}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* Chat Panel */}
          <div className={`absolute inset-0 ${
            selectedEmployee && selectedCustomer && !showHistoryView
              ? 'opacity-100 translate-y-0 z-10 pointer-events-auto'
              : 'opacity-0 translate-y-2 z-0 pointer-events-none'
          }`}>
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-emerald-400/35 bg-gradient-to-b from-emerald-950/20 via-slate-900/90 to-slate-950/95 shadow-2xl shadow-emerald-950/20 backdrop-blur-xl">
              {/* Chat Header */}
              <div className="flex h-[72px] min-h-[72px] shrink-0 items-center overflow-hidden border-b border-emerald-400/35 bg-gradient-to-r from-slate-900 via-slate-800/95 to-emerald-950/25 px-3 py-2">
                <div className="flex min-w-0 w-full flex-nowrap items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => {
                        if (fromHistorySource === 'all') {
                          pendingScrollRestoreRef.current = true;
                          const cachedHistory = allConversationHistoryRef.current;
                          setConversationHistory(cachedHistory);
                          setAllConversationHistory(cachedHistory);
                          setSelectedEmployee(null);
                          setSelectedCustomer(null);
                          setShowHistoryView(true);
                          setHistoryFilterMode(fromHistoryFilterMode);
                          setHistoryScope('all');
                          void loadAllConversationHistory(undefined, true);
                        } else if (fromHistorySource === 'customer') {
                          pendingScrollRestoreRef.current = true;
                          const cachedHistory = conversationHistoryRef.current;
                          setConversationHistory(cachedHistory);
                          setSelectedEmployee(null);
                          setShowHistoryView(true);
                          setHistoryFilterMode(fromHistoryFilterMode);
                          setHistoryScope('customer');
                          void loadConversationHistory();
                        } else {
                          setSelectedEmployee(null);
                        }
                      }}
                      className="flex items-center gap-1 px-2 py-1.5 bg-orange-600 hover:bg-orange-500 text-white rounded-md transition-colors border border-orange-400/60 shadow-sm shadow-orange-600/30 text-xs font-medium flex-shrink-0"
                      title="返回"
                    >
                      <ArrowLeft className="w-3.5 h-3.5" />
                      <span>返回</span>
                    </button>
                    <div className="flex min-w-0 items-center gap-2">
                      <CustomerAvatarDisplay
                        avatar={selectedCustomer?.customer_avatar}
                        isVip={selectedCustomer?.is_super}
                        customAvatarUrl={selectedCustomer?.custom_avatar_url}
                        alt={selectedCustomer?.customer_name}
                        className="h-11 w-11 flex-shrink-0 rounded-full border border-slate-600/50 bg-slate-700/50"
                      />
                      <div className="min-w-0">
                        <div className="text-sm text-slate-100 font-bold leading-tight truncate">{selectedCustomer?.customer_name}</div>
                        {selectedCustomer?.is_super && selectedCustomer?.super_customer_title ? (
                          <div className="text-[11px] text-amber-400 font-medium leading-tight mt-0.5 truncate">{selectedCustomer?.super_customer_title}</div>
                        ) : null}
                        <div className="text-[10px] font-mono text-emerald-400 leading-tight mt-0.5">CUS-{selectedCustomer?.customer_id}</div>
                      </div>
                    </div>
                    <div className="h-8 w-px bg-emerald-500/50 mx-1 flex-shrink-0"></div>
                    <div className="w-9 h-9 flex-shrink-0 rounded-lg border border-emerald-300/30 bg-emerald-500/20 flex items-center justify-center">
                      <User className="w-5 h-5 text-white" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-white text-sm font-bold leading-tight truncate">{selectedEmployee?.username}</div>
                      <div className="text-[11px] text-emerald-300 leading-tight mt-0.5 truncate">編號： {selectedEmployee?.employee_id}</div>
                    </div>
                    {serviceTicketNumber && (
                      <div className="flex max-w-[96px] items-center gap-1.5 rounded-lg border border-emerald-400/30 bg-gradient-to-r from-emerald-500/15 to-teal-500/10 px-2 py-1.5 ml-1 flex-shrink-0">
                        <div className="w-1.5 h-1.5 bg-blue-400 rounded-full "></div>
                        <span className="truncate text-[11px] text-emerald-200 font-mono font-bold tracking-wide">{serviceTicketNumber}</span>
                      </div>
                    )}
                  </div>
                  <div className="ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-1">
                    {(() => {
                      const customerHistory = selectedCustomer
                        ? conversationHistoryForView.filter(history => history.customer_id === selectedCustomer.id)
                        : [];
                      const totalUnread = customerHistory.reduce((sum, history) => sum + history.unread_count, 0);
                      return (
                        <div className="relative">
                          <button
                            type="button"
                            onClick={() => {
                              const cachedHistory = Array.from(new Map(
                                [...allConversationHistoryRef.current, ...conversationHistoryRef.current]
                                  .filter(history => history.customer_id === selectedCustomer?.id)
                                  .map(history => [`${history.customer_id}:${history.employee_id}`, history] as const)
                              ).values());
                              setConversationHistory(cachedHistory);
                              conversationHistoryRef.current = cachedHistory;
                              setSelectedEmployee(null);
                              setShowHistoryView(true);
                              setHistoryFilterMode('all');
                              setFromHistorySource('none');
                              setHistoryScope('customer');
                              void loadConversationHistory();
                            }}
                            className="flex items-center gap-1.5 rounded-lg border border-emerald-300/60 bg-emerald-600 px-2.5 py-1.5 text-xs font-bold text-white shadow-md shadow-emerald-600/30 transition-all hover:bg-emerald-500 hover:shadow-emerald-500/40"
                            title="歷史訊息"
                          >
                            <Clock className="w-4 h-4" />
                            <span>歷史紀錄</span>
                            {customerHistory.length > 0 && <span className="px-1.5 py-px bg-white/20 rounded text-[10px] font-black">{customerHistory.length}</span>}
                          </button>
                          {totalUnread > 0 && (
                            <div className="absolute -top-2.5 -right-2.5 min-w-[22px] h-[22px] px-1 bg-orange-500 rounded-full flex items-center justify-center  border-2 border-slate-900 shadow-lg shadow-orange-500/40">
                              <span className="text-[11px] font-black text-white">{totalUnread > 99 ? '99+' : totalUnread}</span>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                    {messages.length > 0 && (
                      <button
                        type="button"
                        onClick={handleDeleteConversation}
                        className="flex items-center gap-1 px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-lg border border-red-400/60 shadow-md shadow-red-600/30 hover:shadow-red-500/40 transition-all text-xs font-bold"
                        title="清除聊天"
                      >
                        <Trash2 className="w-4 h-4" />
                        <span>清除</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex min-h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-emerald-400/25 bg-slate-900/80 px-3 py-1.5">
                <span className="flex min-w-0 max-w-[45%] items-center gap-1.5 truncate rounded-md border border-emerald-300/35 bg-emerald-500/15 px-2 py-1 text-[10px] font-bold text-emerald-100" title={selectedEmployee?.tags?.join(' · ') || '無標籤'}>
                  <Tag className="h-3 w-3 shrink-0 text-emerald-300" />
                  <span className="truncate">{selectedEmployee?.tags?.length ? selectedEmployee.tags.join(' · ') : '無標籤'}</span>
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md border border-slate-500/45 bg-slate-800/70 px-2 py-1 text-[10px] font-medium text-slate-200" title={selectedEmployee?.remarks || '無備註'}>
                  <FileText className="h-3 w-3 shrink-0 text-slate-400" />
                  <span className="truncate">{selectedEmployee?.remarks?.trim() || '無備註'}</span>
                </span>
              </div>

              {/* Messages */}
              <div ref={messagesContainerCallbackRef} className="relative flex-1 overflow-y-auto flex flex-col-reverse scrollbar-dark" style={{
                background: 'linear-gradient(180deg, #0b2118 0%, #101c19 40%, #0b2118 100%)',
                backgroundImage: `linear-gradient(180deg, #0b2118 0%, #101c19 40%, #0b2118 100%), radial-gradient(circle at 20% 50%, rgba(16,185,129,0.05) 0%, transparent 50%), radial-gradient(circle at 80% 30%, rgba(34,197,94,0.04) 0%, transparent 50%)`
              }}>
                <div className="p-4 space-y-3 mb-auto">
                {messages.length === 0 ? (
                  !messagesLoading && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-400">
                    <MessageCircle className="w-16 h-16 mb-4 opacity-30 text-slate-500" />
                    <p className="text-slate-400 font-medium">尚無訊息</p>
                    <p className="text-sm mt-2 text-slate-500">傳送第一則訊息</p>
                  </div>
                  )
                ) : (
                  <>
                {loadingOlderMessages && (
                  <div className="flex justify-center py-3">
                    <div className="w-5 h-5 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
                  </div>
                )}
                {messages.map((msg) => (
                      <div
                        key={msg.id}
                        className={`flex group ${msg.sender_type === 'customer' ? 'justify-end' : 'justify-start'}`}
                      >
                        <div className={`flex items-start gap-2 min-w-0 ${editingMessageId === msg.id ? 'max-w-[90%]' : 'max-w-[80%]'}`}>
                          {/* Action buttons for customer (admin-sent) messages */}
                          {msg.sender_type === 'customer' && editingMessageId !== msg.id && msg.message_type !== 'tip' && msg.message_type !== 'rating_request' && msg.message_type !== 'rating_result' && (
                            <div className="mt-1 flex shrink-0 flex-col gap-1 rounded-xl border border-emerald-200/20 bg-slate-950/70 p-1 opacity-70 shadow-lg shadow-black/20 backdrop-blur-sm transition-all duration-200 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                              {msg.message_type !== 'rich_card' && (
                                <button
                                  type="button"
                                  onClick={() => handleStartEdit(msg)}
                                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-300/20 bg-emerald-500/10 text-emerald-200 transition-all hover:-translate-y-0.5 hover:border-emerald-200/70 hover:bg-emerald-500 hover:text-white hover:shadow-md hover:shadow-emerald-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70"
                                  title={msg.message_type === 'image' ? '替換圖片' : '編輯訊息'}
                                  aria-label={msg.message_type === 'image' ? '替換圖片' : '編輯訊息'}
                                >
                                  {msg.message_type === 'image' ? <Image className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleDeleteMessage(msg.id)}
                                className="flex h-7 w-7 items-center justify-center rounded-lg border border-rose-300/20 bg-rose-500/10 text-rose-200 transition-all hover:-translate-y-0.5 hover:border-rose-200/70 hover:bg-rose-500 hover:text-white hover:shadow-md hover:shadow-rose-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/70"
                                title="刪除訊息"
                                aria-label="刪除訊息"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                          {/* Action buttons for employee messages */}
                          {msg.sender_type === 'employee' && editingMessageId !== msg.id && msg.message_type !== 'tip' && msg.message_type !== 'rating_request' && msg.message_type !== 'rating_result' && (
                            <div className="order-last mt-1 flex shrink-0 flex-col gap-1 rounded-xl border border-emerald-200/20 bg-slate-950/70 p-1 opacity-70 shadow-lg shadow-black/20 backdrop-blur-sm transition-all duration-200 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                              {msg.message_type !== 'rich_card' && (
                                <button
                                  type="button"
                                  onClick={() => handleStartEdit(msg)}
                                  className="flex h-7 w-7 items-center justify-center rounded-lg border border-emerald-300/20 bg-emerald-500/10 text-emerald-200 transition-all hover:-translate-y-0.5 hover:border-emerald-200/70 hover:bg-emerald-500 hover:text-white hover:shadow-md hover:shadow-emerald-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70"
                                  title={msg.message_type === 'image' ? '替換圖片' : '編輯訊息'}
                                  aria-label={msg.message_type === 'image' ? '替換圖片' : '編輯訊息'}
                                >
                                  {msg.message_type === 'image' ? <Image className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => handleDeleteMessage(msg.id)}
                                className="flex h-7 w-7 items-center justify-center rounded-lg border border-rose-300/20 bg-rose-500/10 text-rose-200 transition-all hover:-translate-y-0.5 hover:border-rose-200/70 hover:bg-rose-500 hover:text-white hover:shadow-md hover:shadow-rose-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300/70"
                                title="刪除訊息"
                                aria-label="刪除訊息"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                          {(msg.message_type === 'tip' || msg.message_type === 'rich_card') ? (
                            <div className="relative z-10">
                              {renderMessageContent(msg)}
                              <div className={`text-[10px] mt-1.5 ${msg.sender_type === 'customer' ? 'text-slate-500 text-right' : 'text-slate-500'}`}>
                                {new Date(msg.created_at).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' + new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </div>
                              {msg.sender_type === 'customer' && (
                                <div className={`flex items-center justify-end gap-1 mt-0.5 text-[10px] ${
                                  msg.is_read ? 'text-emerald-500' : 'text-slate-400'
                                }`}>
                                  {msg.is_read ? (
                                    <>
                                      <CheckCheck className="w-3 h-3" />
                                      <span>已讀 {msg.read_at ? new Date(msg.read_at).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' }) + ' ' + new Date(msg.read_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                                    </>
                                  ) : (
                                    <>
                                      <Eye className="w-3 h-3" />
                                      <span>未讀</span>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          ) : (msg.message_type === 'image' && msg.image_url) || (msg.message_type === 'text' && extractImageOnlyUrl(msg.message_content)) ? (
                          <div className={`relative inline-flex w-fit max-w-full flex-col overflow-hidden rounded-[20px] border-2 shadow-lg transition-all duration-200 ${
                            msg.sender_type === 'customer'
                              ? 'border-emerald-200/80 shadow-slate-950/20'
                              : 'border-emerald-300/30 shadow-emerald-950/35'
                          }`} style={{ width: 'fit-content', height: 'fit-content', maxWidth: '100%', backgroundColor: 'transparent' }}>
                            <div className="relative inline-flex w-fit max-w-full flex-col" style={{ width: 'fit-content', height: 'fit-content', maxWidth: '100%' }}>
                              {renderMessageContent(msg)}
                              {replacingImageMsgId === msg.id && (
                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-slate-950/65 backdrop-blur-[2px]">
                                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-emerald-300" />
                                  <span className="text-xs font-semibold text-white">正在替換圖片……</span>
                                </div>
                              )}
                            </div>
                            <div className={`border-t px-3 py-1.5 text-[10px] ${msg.sender_type === 'customer' ? 'border-slate-100 bg-white text-right text-slate-500' : 'border-emerald-200/10 bg-slate-950/25 text-emerald-100/60'}`}>
                              {new Date(msg.created_at).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' + new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </div>
                            {msg.sender_type === 'customer' && (
                              <div className={`flex items-center justify-end gap-1 px-3 pb-1.5 text-[10px] ${
                                msg.is_read ? 'text-emerald-500' : 'text-slate-400'
                              } bg-white`}>
                                {msg.is_read ? (
                                  <>
                                    <CheckCheck className="w-3 h-3" />
                                    <span>已讀 {msg.read_at ? new Date(msg.read_at).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' }) + ' ' + new Date(msg.read_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                                  </>
                                ) : (
                                  <>
                                    <Eye className="w-3 h-3" />
                                    <span>未讀</span>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                          ) : (
                          <div
                            className={`relative overflow-hidden px-4 py-3 transition-all duration-200 ${
                              editingMessageId === msg.id
                                ? 'rounded-[20px] border-2 border-emerald-400 bg-white text-slate-800 ring-2 ring-emerald-100 shadow-[0_12px_28px_rgba(16,185,129,0.18)]'
                                : msg.sender_type === 'customer'
                                  ? 'rounded-[20px] rounded-tr-[6px] border-2 border-emerald-200/80 bg-white text-slate-800 shadow-[0_10px_24px_rgba(15,23,42,0.2)]'
                                  : 'rounded-[20px] rounded-tl-[6px] border-2 border-emerald-300/35 bg-gradient-to-br from-slate-800 via-slate-800 to-emerald-950/70 text-slate-100 shadow-[0_10px_24px_rgba(6,78,59,0.34)]'
                            }`}
                          >
                            <div className="relative z-10">
                              <div className={`text-xs font-semibold flex items-center gap-1.5 pb-1.5 mb-1.5 ${
                                msg.sender_type === 'customer'
                                  ? 'border-b border-slate-200/90'
                                  : 'border-b border-emerald-200/15'
                              }`}>
                                {msg.sender_type === 'customer' && selectedCustomer?.is_super && (
                                  <span className="text-[10px]">
                                    {selectedCustomer.badge_type === 'diamond' ? '💎' : selectedCustomer.badge_type === 'crown' ? '👑' : selectedCustomer.badge_type === 'star' ? '⭐' : selectedCustomer.badge_type === 'vip' ? '🏆' : '✨'}
                                  </span>
                                )}
                                <span className={msg.sender_type === 'employee' ? 'text-emerald-100' : selectedCustomer?.is_super ? 'text-amber-600 font-bold' : 'text-blue-700 font-semibold'}>{msg.sender_type === 'customer' ? selectedCustomer?.customer_name : selectedEmployee?.username}</span>
                                {msg.sender_type === 'customer' && selectedCustomer?.is_super && selectedCustomer?.super_customer_title && (
                                  <span className="text-[9px] px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded-full font-bold">{selectedCustomer?.super_customer_title}</span>
                                )}
                              </div>
                              {editingMessageId === msg.id ? (
                                <div className="min-w-0 max-w-full">
                                  <input
                                    ref={editFileInputRef}
                                    type="file"
                                    accept="image/*"
                                    onChange={handleEditImageSelect}
                                    className="hidden"
                                  />
                                  <div className="rounded-xl border border-slate-300 bg-white overflow-hidden focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400/40 transition-all shadow-sm">
                                    <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-slate-200 bg-slate-50/80">
                                      <button type="button" onMouseDown={(e) => { e.preventDefault(); applyEditFormat('bold'); }} className={`p-1.5 rounded-md transition-all ${isEditBoldActive ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`} title="粗體（Ctrl+B）">
                                        <Bold className="w-3.5 h-3.5" strokeWidth={2.5} />
                                      </button>
                                      <button type="button" onMouseDown={(e) => { e.preventDefault(); applyEditFormat('underline'); }} className={`p-1.5 rounded-md transition-all ${isEditUnderlineActive ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`} title="底線（Ctrl+U）">
                                        <Underline className="w-3.5 h-3.5" strokeWidth={2.5} />
                                      </button>
                                      <button type="button" onMouseDown={(e) => { e.preventDefault(); applyEditFormat('strikeThrough'); }} className="p-1.5 rounded-md transition-all text-slate-500 hover:bg-slate-200 hover:text-slate-800" title="刪除線">
                                        <Strikethrough className="w-3.5 h-3.5" strokeWidth={2.5} />
                                      </button>
                                      <div className="w-px h-5 bg-slate-200 mx-1" />
                                      <div className="flex items-center bg-slate-100 rounded-md p-0.5 gap-0.5">
                                        <button type="button" onMouseDown={(e) => { e.preventDefault(); setEditEditorFontSize(editEditorFontSize === 'normal' ? null : 'normal'); applyEditFormat('fontSize', '3'); }} className={`px-1.5 py-0.5 text-[10px] rounded transition-all ${editEditorFontSize === 'normal' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-semibold hover:text-slate-700 hover:bg-slate-200'}`} title="一般大小">A</button>
                                        <button type="button" onMouseDown={(e) => { e.preventDefault(); setEditEditorFontSize(editEditorFontSize === 'large' ? null : 'large'); applyEditFormat('fontSize', '5'); }} className={`px-1.5 py-0.5 text-xs rounded transition-all ${editEditorFontSize === 'large' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-semibold hover:text-slate-700 hover:bg-slate-200'}`} title="大字">A</button>
                                        <button type="button" onMouseDown={(e) => { e.preventDefault(); setEditEditorFontSize(editEditorFontSize === 'xlarge' ? null : 'xlarge'); applyEditFormat('fontSize', '7'); }} className={`px-1.5 py-0.5 text-sm rounded transition-all ${editEditorFontSize === 'xlarge' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-bold hover:text-slate-700 hover:bg-slate-200'}`} title="特大字">A</button>
                                      </div>
                                      <div className="relative">
                                        <button
                                          type="button"
                                          onMouseDown={(e) => { e.preventDefault(); setShowBgColorPicker(showBgColorPicker === 'edit' ? null : 'edit'); }}
                                          className={`p-1.5 rounded-md transition-all ${showBgColorPicker === 'edit' ? 'bg-yellow-100 text-yellow-700' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`}
                                          title="背景顏色"
                                        >
                                          <Highlighter className="w-3.5 h-3.5" strokeWidth={2.5} />
                                        </button>
                                        {showBgColorPicker === 'edit' && (
                                          <>
                                            <div className="fixed inset-0 z-40" onMouseDown={() => setShowBgColorPicker(null)} />
                                            <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl z-50 p-2 grid grid-cols-4 gap-1.5 w-[140px]">
                                              {BG_COLORS.map((c) => (
                                                <button key={c.color} type="button" onMouseDown={(e) => { e.preventDefault(); applyBgColor(c.color, 'edit'); }} className="w-7 h-7 rounded-md border border-slate-200 hover:scale-110 transition-transform" style={{ backgroundColor: c.color }} title={c.label} />
                                              ))}
                                              <button type="button" onMouseDown={(e) => { e.preventDefault(); applyBgColor(null, 'edit'); }} className="col-span-4 mt-1.5 px-2 py-1.5 text-[11px] font-bold text-red-500 bg-red-50 border border-red-200 hover:bg-red-100 hover:border-red-300 rounded-md transition-all text-center tracking-wide">清除</button>
                                            </div>
                                          </>
                                        )}
                                      </div>
                                      <div className="w-px h-5 bg-slate-200 mx-1" />
                                      <button
                                        type="button"
                                        onClick={() => editFileInputRef.current?.click()}
                                        disabled={uploadingEditImage}
                                        className="p-1.5 hover:bg-slate-200 disabled:opacity-50 rounded-md text-slate-500 hover:text-slate-800 transition-colors"
                                        title="上傳圖片"
                                      >
                                        {uploadingEditImage ? (
                                          <div className="w-3.5 h-3.5 border-2 border-slate-300 border-t-blue-500 rounded-full animate-spin" />
                                        ) : (
                                          <Image className="w-3.5 h-3.5" strokeWidth={2.5} />
                                        )}
                                      </button>
                                    </div>
                                    <div
                                      ref={editEditorRef}
                                      contentEditable
                                      suppressContentEditableWarning
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' && e.ctrlKey) {
                                          e.preventDefault();
                                          handleSaveEdit();
                                        }
                                        if (e.key === 'Escape') {
                                          handleCancelEdit();
                                        }
                                      }}
                                      onKeyUp={updateEditFormatState}
                                      onMouseUp={updateEditFormatState}
                                      onSelect={updateEditFormatState}
                                      className="min-h-[60px] max-h-[216px] overflow-y-auto px-3 py-2.5 text-sm text-slate-800 focus:outline-none chat-rich-content"
                                      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                                    />
                                  </div>
                                  <div className="flex items-center gap-2 mt-2">
                                    <button
                                      type="button"
                                      onClick={handleSaveEdit}
                                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-semibold rounded-lg transition-colors shadow-sm shadow-blue-500/25"
                                    >
                                      <Check className="w-3 h-3" />
                                      儲存
                                    </button>
                                    <button
                                      type="button"
                                      onClick={handleCancelEdit}
                                      className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold rounded-lg transition-colors"
                                    >
                                      取消
                </button>
                                    <span className="text-[10px] text-slate-400 ml-auto">Ctrl+Enter / Esc</span>
                                  </div>
                                </div>
                              ) : (
                                renderMessageContent(msg)
                              )}
                              <div className={`text-[10px] mt-1.5 ${
                                msg.sender_type === 'customer'
                                  ? 'text-slate-500 text-right'
                                  : 'text-emerald-100/60'
                              }`}>
                                {new Date(msg.created_at).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' }) + ' ' + new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </div>
                              {msg.sender_type === 'customer' && (
                                <div className={`flex items-center justify-end gap-1 mt-0.5 text-[10px] ${
                                  msg.is_read ? 'text-emerald-500' : 'text-slate-400'
                                }`}>
                                  {msg.is_read ? (
                                    <>
                                      <CheckCheck className="w-3 h-3" />
                                      <span>已讀 {msg.read_at ? new Date(msg.read_at).toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' }) + ' ' + new Date(msg.read_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                                    </>
                                  ) : (
                                    <>
                                      <Eye className="w-3 h-3" />
                                      <span>未讀</span>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                          )}
                        </div>
                      </div>
                    ))}

                    <div ref={messagesEndRef} />
                  </>
                )}
                </div>
              </div>

              {/* Message Input */}
              <form onSubmit={handleSendMessage} className="px-3 py-2.5 border-t border-slate-700/50 relative">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleImageSelect}
                  className="hidden"
                />
                <input
                  ref={replaceImageInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleReplaceImageSelect}
                  className="hidden"
                />
                {showTemplatePopup && (() => {
                  const filteredTemplates = messageTemplates.filter(t => t.content_type !== 'rich_card');
                  return (
                  <>
                    <div className="fixed inset-0 z-40" onMouseDown={() => setShowTemplatePopup(false)} />
                    <div className="absolute bottom-full left-0 right-0 mb-2 px-1 z-50">
                      <div className="relative flex max-h-[360px] flex-col overflow-hidden rounded-2xl border border-emerald-300/25 bg-gradient-to-b from-slate-900/98 via-slate-900/96 to-emerald-950/75 shadow-2xl shadow-emerald-950/30 ring-1 ring-emerald-200/10 backdrop-blur-xl">
                        <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-gradient-to-r from-slate-800/70 via-slate-900/35 to-transparent px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 items-center justify-center rounded-xl border border-emerald-300/25 bg-emerald-500/20 shadow-lg shadow-emerald-900/20">
                              <Zap className="w-3 h-3 text-white" />
                            </div>
                            <span className="text-[13px] font-bold text-slate-100 tracking-tight">快速傳送</span>
                            <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-emerald-300/30 bg-emerald-500/20 px-1.5 text-[11px] font-bold text-emerald-100">{filteredTemplates.length}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => { setShowTemplatePopup(false); setTemplateManagerMode('richtext'); setShowTemplateManager(true); loadTemplates(); }}
                              className="flex items-center gap-1 rounded-lg border border-emerald-300/35 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-semibold text-emerald-50 shadow-sm shadow-emerald-950/20 transition-all duration-150 hover:border-emerald-200/70 hover:bg-emerald-500 hover:shadow-emerald-500/25"
                            >
                              <Pencil className="w-3 h-3" />
                              管理
                            </button>
                            <button type="button" onClick={() => setShowTemplatePopup(false)} className="rounded-lg p-1.5 transition-colors hover:bg-emerald-500/15" aria-label="關閉快速傳送">
                              <X className="h-3.5 w-3.5 text-emerald-200/70 hover:text-emerald-100" />
                            </button>
                          </div>
                        </div>
                        {filteredTemplates.length > 0 ? (
                          <div className="overflow-y-auto bg-slate-950/25 p-2.5 space-y-2 scrollbar-dark">
                            {filteredTemplates.map((tpl) => {
                              return (
                                <button
                                  key={tpl.id}
                                  type="button"
                                  onClick={async () => {
                                    if (editorRef.current) {
                                      const fullContent = await fetchTemplateContent(tpl.id);
                                      if (!fullContent) return;
                                      const content = tpl.content_type === 'richtext' ? fullContent : fullContent.replace(/\n/g, '<br>');
                                      editorRef.current.innerHTML = content;
                                      const hasText = (editorRef.current.textContent || '').trim().length > 0;
                                      const hasImgs = editorRef.current.querySelector('img') !== null;
                                      setMessageInput(hasText ? editorRef.current.textContent! : hasImgs ? '_img_' : '');
                                    }
                                    setShowTemplatePopup(false);
                                  }}
                                  className={`group w-full rounded-xl border px-3 py-2.5 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70 ${
                                    tpl.is_pinned
                                      ? 'border-emerald-400/45 bg-gradient-to-r from-emerald-900/55 via-emerald-950/35 to-slate-900/70 shadow-emerald-950/25 hover:border-emerald-300/75 hover:from-emerald-800/70 hover:via-emerald-900/45 hover:to-slate-900/60'
                                      : 'border-slate-700/70 bg-slate-800/75 hover:border-emerald-300/45 hover:bg-slate-800'
                                  }`}
                                >
                                  <div className="flex items-center gap-2">
                                    {tpl.is_pinned && (
                                      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border border-emerald-300/25 bg-emerald-500/15">
                                        <Pin className="h-2.5 w-2.5 text-emerald-300" />
                                      </div>
                                    )}
                                    <span className={`flex-1 truncate text-[13px] font-semibold ${tpl.is_pinned ? 'text-emerald-100 group-hover:text-emerald-50' : 'text-slate-200 group-hover:text-white'}`}>{tpl.name}</span>
                                    {tpl.content_type === 'richtext' && (
                                      <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 flex-shrink-0">富文字</span>
                                    )}
                                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border border-emerald-300/0 bg-emerald-500/0 opacity-0 transition-all group-hover:border-emerald-300/40 group-hover:bg-emerald-500 group-hover:opacity-100" title="填入輸入框">
                                      <Pencil className="w-2.5 h-2.5 text-white" />
                                    </div>
                                  </div>
                                  <div className={`mt-1 ${tpl.is_pinned ? 'pl-7' : ''}`}>
                                    <p className="text-[11px] text-slate-400 group-hover:text-slate-300 truncate leading-relaxed">{tpl.name}</p>
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="p-6 text-center">
                            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-emerald-300/20 bg-emerald-500/10 shadow-lg shadow-emerald-950/20">
                              <FileText className="h-5 w-5 text-emerald-300" />
                            </div>
                            <p className="text-sm text-slate-200 mb-1 font-semibold">尚無範本</p>
                            <p className="text-[11px] text-slate-400 mb-3">建立快速回覆範本</p>
                            <button
                              type="button"
                              onClick={() => { setShowTemplatePopup(false); setTemplateManagerMode('richtext'); setShowTemplateManager(true); loadTemplates(); }}
                              className="rounded-lg border border-emerald-300/35 bg-emerald-500/20 px-3.5 py-1.5 text-xs font-semibold text-emerald-50 shadow-sm shadow-emerald-950/20 transition-all hover:border-emerald-200/70 hover:bg-emerald-500 hover:shadow-emerald-500/25"
                            >
                              建立範本
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                  );
                })()}
                {showRichCardPopup && (() => {
                  const richCardTemplates = messageTemplates.filter(t => t.content_type === 'rich_card');
                  return (
                  <>
                    <div className="fixed inset-0 z-40" onMouseDown={() => setShowRichCardPopup(false)} />
                    <div className="absolute bottom-full left-0 right-0 mb-2 px-1 z-50">
                      <div className="relative flex max-h-[360px] flex-col overflow-hidden rounded-2xl border border-sky-300/25 bg-gradient-to-b from-slate-900/98 via-slate-900/96 to-blue-950/80 shadow-2xl shadow-blue-950/35 ring-1 ring-sky-200/10 backdrop-blur-xl">
                        <div className="flex shrink-0 items-center justify-between border-b border-white/10 bg-gradient-to-r from-slate-800/70 via-slate-900/35 to-transparent px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 items-center justify-center rounded-xl border border-sky-300/25 bg-sky-500/20 shadow-lg shadow-blue-900/20">
                              <Megaphone className="w-3 h-3 text-white" />
                            </div>
                            <span className="text-[13px] font-bold text-slate-100 tracking-tight">富媒體卡片</span>
                            <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-sky-300/30 bg-sky-500/20 px-1.5 text-[11px] font-bold text-sky-100">{richCardTemplates.length}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => { setShowRichCardPopup(false); setTemplateManagerMode('rich_card'); setTemplateForm({ name: '', title: '', subtitle: '', content: '', content_type: 'rich_card' }); setShowTemplateManager(true); loadTemplates(); }}
                              className="flex items-center gap-1 rounded-lg border border-sky-300/35 bg-sky-500/15 px-2.5 py-1 text-[11px] font-semibold text-sky-50 shadow-sm shadow-blue-950/20 transition-all duration-150 hover:border-sky-200/70 hover:bg-sky-500 hover:shadow-sky-500/25"
                            >
                              <Pencil className="w-3 h-3" />
                              管理
                            </button>
                            <button type="button" onClick={() => setShowRichCardPopup(false)} className="rounded-lg p-1.5 transition-colors hover:bg-sky-500/15" aria-label="關閉富媒體卡片">
                              <X className="h-3.5 w-3.5 text-sky-200/70 hover:text-sky-100" />
                            </button>
                          </div>
                        </div>
                        {richCardTemplates.length > 0 ? (
                          <div className="overflow-y-auto bg-slate-950/25 p-2.5 space-y-2 scrollbar-dark">
                            {richCardTemplates.map((tpl) => {
                              return (
                                <button
                                  key={tpl.id}
                                  type="button"
                                  onClick={async () => {
                                    if (!selectedCustomer || !selectedEmployee || sendingRichCard) return;
                                    setSendingRichCard(true);
                                    setShowRichCardPopup(false);
                                    const optimisticId = `optimistic-${Date.now()}`;
                                    const optimisticMsg: Message = {
                                      id: optimisticId,
                                      customer_id: selectedCustomer.id,
                                      employee_id: selectedEmployee.id,
                                      sender_type: 'customer',
                                      message_content: tpl.name,
                                      message_type: 'rich_card',
                                      title: tpl.title || null,
                                      subtitle: tpl.subtitle || null,
                                      source_type: 'ccc_service',
                                      created_at: new Date().toISOString(),
                                      is_read: false,
                                    };
                                    setMessages(prev => [...prev, optimisticMsg]);
                                    try {
                                      const { error: msgErr } = await supabase.from('customer_employee_conversations').insert({
                                        customer_id: selectedCustomer.id,
                                        employee_id: selectedEmployee.id,
                                        sender_type: 'customer',
                                        message_content: tpl.name || '',
                                        message_type: 'rich_card',
                                        title: tpl.title || null,
                                        subtitle: tpl.subtitle || null,
                                        is_read: false,
                                        source_type: 'ccc_service',
                                        source_template_id: tpl.id,
                                      }).select('id').single();
                                      if (msgErr) {
                                        setMessages(prev => prev.filter(m => m.id !== optimisticId));
                                        setNotification({ type: 'error', text: msgErr.message || '富媒體卡片傳送失敗' });
                                      } else {
                                        loadMessages();
                                        loadConversationHistory();
                                      }
                                    } catch (err: unknown) {
                                      setMessages(prev => prev.filter(m => m.id !== optimisticId));
                                      setNotification({ type: 'error', text: getCccErrorMessage(err, '富媒體卡片傳送失敗') });
                                    } finally { setSendingRichCard(false); }
                                  }}
                                  className="group w-full rounded-xl border border-sky-400/35 bg-gradient-to-r from-sky-900/55 via-blue-950/45 to-indigo-950/50 px-3 py-2.5 text-left shadow-sm shadow-blue-950/25 transition-all duration-200 hover:-translate-y-0.5 hover:border-sky-300/75 hover:from-sky-800/65 hover:via-blue-900/55 hover:to-indigo-900/60 hover:shadow-lg hover:shadow-blue-950/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70"
                                >
                                  <div className="flex items-center gap-2">
                                    {tpl.is_pinned && (
                                      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border border-sky-300/25 bg-sky-500/15">
                                        <Pin className="h-2.5 w-2.5 text-sky-300" />
                                      </div>
                                    )}
                                    <span className="flex-1 truncate text-[13px] font-semibold text-sky-100 group-hover:text-white">{tpl.name}</span>
                                    {tpl.title && (
                                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-blue-500/20 text-blue-300 border border-blue-400/30 flex-shrink-0 truncate max-w-[120px]">{tpl.title}</span>
                                    )}
                                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border border-sky-300/0 bg-sky-500/0 opacity-0 transition-all group-hover:border-sky-300/40 group-hover:bg-sky-500 group-hover:opacity-100" title="直接傳送">
                                      <Send className="w-2.5 h-2.5 text-white" />
                                    </div>
                                  </div>

                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="p-6 text-center">
                            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-sky-300/20 bg-sky-500/10 shadow-lg shadow-blue-950/20">
                              <Megaphone className="h-5 w-5 text-sky-300" />
                            </div>
                            <p className="text-sm text-slate-200 mb-1 font-semibold">尚無富媒體卡片範本</p>
                            <p className="text-[11px] text-slate-400 mb-3">建立富媒體卡片範本即可直接傳送</p>
                            <button
                              type="button"
                              onClick={() => { setShowRichCardPopup(false); setTemplateManagerMode('rich_card'); setTemplateForm({ name: '', title: '', subtitle: '', content: '', content_type: 'rich_card' }); setShowTemplateManager(true); loadTemplates(); }}
                              className="rounded-lg border border-sky-300/35 bg-sky-500/20 px-3.5 py-1.5 text-xs font-semibold text-sky-50 shadow-sm shadow-blue-950/20 transition-all hover:border-sky-200/70 hover:bg-sky-500 hover:shadow-sky-500/25"
                            >
                              建立富媒體卡片
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                  );
                })()}
                <div className="flex gap-2 items-end">
                  <div className="flex-1 min-w-0 rounded-xl border border-slate-300 bg-white focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400/40 transition-all shadow-sm">
                    {/* Toolbar row */}
                    <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-slate-200 bg-slate-50/80 flex-wrap">
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); applyFormat('bold'); }} className={`p-1.5 rounded-md transition-all ${isBoldActive ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`} title="粗體（Ctrl+B）">
                        <Bold className="w-3.5 h-3.5" strokeWidth={2.5} />
                      </button>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); applyFormat('underline'); }} className={`p-1.5 rounded-md transition-all ${isUnderlineActive ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`} title="底線（Ctrl+U）">
                        <Underline className="w-3.5 h-3.5" strokeWidth={2.5} />
                      </button>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); applyFormat('strikeThrough'); }} className={`p-1.5 rounded-md transition-all text-slate-500 hover:bg-slate-200 hover:text-slate-800`} title="刪除線">
                        <Strikethrough className="w-3.5 h-3.5" strokeWidth={2.5} />
                      </button>
                      <div className="w-px h-5 bg-slate-200 mx-1" />
                      <div className="flex items-center bg-slate-100 rounded-md p-0.5 gap-0.5">
                        <button type="button" onMouseDown={(e) => { e.preventDefault(); setEditorFontSize(editorFontSize === 'normal' ? null : 'normal'); applyFormat('fontSize', '3'); }} className={`px-1.5 py-0.5 text-[10px] rounded transition-all ${editorFontSize === 'normal' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-semibold hover:text-slate-700 hover:bg-slate-200'}`} title="一般大小">A</button>
                        <button type="button" onMouseDown={(e) => { e.preventDefault(); setEditorFontSize(editorFontSize === 'large' ? null : 'large'); applyFormat('fontSize', '5'); }} className={`px-1.5 py-0.5 text-xs rounded transition-all ${editorFontSize === 'large' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-semibold hover:text-slate-700 hover:bg-slate-200'}`} title="大字">A</button>
                        <button type="button" onMouseDown={(e) => { e.preventDefault(); setEditorFontSize(editorFontSize === 'xlarge' ? null : 'xlarge'); applyFormat('fontSize', '7'); }} className={`px-1.5 py-0.5 text-sm rounded transition-all ${editorFontSize === 'xlarge' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-bold hover:text-slate-700 hover:bg-slate-200'}`} title="特大字">A</button>
                      </div>
                      <div className="relative">
                        <button
                          type="button"
                          onMouseDown={(e) => { e.preventDefault(); setShowBgColorPicker(showBgColorPicker === 'main' ? null : 'main'); }}
                          className={`p-1.5 rounded-md transition-all ${showBgColorPicker === 'main' ? 'bg-yellow-100 text-yellow-700' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`}
                          title="背景顏色"
                        >
                          <Highlighter className="w-3.5 h-3.5" strokeWidth={2.5} />
                        </button>
                        {showBgColorPicker === 'main' && (
                          <>
                            <div className="fixed inset-0 z-40" onMouseDown={() => setShowBgColorPicker(null)} />
                            <div className="absolute bottom-full left-0 mb-1 bg-white border border-slate-200 rounded-lg shadow-xl z-50 p-2 grid grid-cols-4 gap-1.5 w-[140px]">
                              {BG_COLORS.map((c) => (
                                <button key={c.color} type="button" onMouseDown={(e) => { e.preventDefault(); applyBgColor(c.color, 'main'); }} className="w-7 h-7 rounded-md border border-slate-200 hover:scale-110 transition-transform" style={{ backgroundColor: c.color }} title={c.label} />
                              ))}
                              <button type="button" onMouseDown={(e) => { e.preventDefault(); applyBgColor(null, 'main'); }} className="col-span-4 mt-1.5 px-2 py-1.5 text-[11px] font-bold text-red-500 bg-red-50 border border-red-200 hover:bg-red-100 hover:border-red-300 rounded-md transition-all text-center tracking-wide">清除</button>
                            </div>
                          </>
                        )}
                      </div>
                      <div className="w-px h-5 bg-slate-200 mx-1" />
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploadingImage}
                        className="p-1.5 hover:bg-slate-200 disabled:opacity-50 rounded-md text-slate-500 hover:text-slate-800 transition-colors"
                        title="上傳圖片"
                      >
                        {uploadingImage ? (
                          <div className="relative w-3.5 h-3.5">
                            <svg className="w-3.5 h-3.5 -rotate-90" viewBox="0 0 16 16">
                              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-300" />
                              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-500" strokeDasharray={`${uploadProgress * 0.377}, 37.7`} strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.3s ease' }} />
                            </svg>
                          </div>
                        ) : (
                          <Image className="w-3.5 h-3.5" strokeWidth={2.5} />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => { loadTemplates(); setShowTemplatePopup(!showTemplatePopup); setShowRichCardPopup(false); }}
                        className={`group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.04em] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 ${showTemplatePopup ? 'border-emerald-300 bg-gradient-to-r from-emerald-500 to-teal-500 text-white shadow-md shadow-emerald-500/30' : 'border-emerald-300/70 bg-emerald-50 text-emerald-700 shadow-sm shadow-emerald-200/50 hover:-translate-y-0.5 hover:border-emerald-500 hover:bg-emerald-100 hover:text-emerald-800 hover:shadow-md hover:shadow-emerald-300/40'}`}
                        title="快速傳送範本"
                        aria-label="開啟快速傳送範本"
                        aria-pressed={showTemplatePopup}
                      >
                        <span className={`flex h-5 w-5 items-center justify-center rounded-md ${showTemplatePopup ? 'bg-white/20' : 'bg-emerald-200/70 group-hover:bg-emerald-300/70'}`}>
                          <FileText className="h-3.5 w-3.5" strokeWidth={2.5} />
                        </span>
                        <span>快速傳送</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => { loadTemplates(); setShowRichCardPopup(!showRichCardPopup); setShowTemplatePopup(false); }}
                        className={`group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.04em] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/70 ${showRichCardPopup ? 'border-sky-300 bg-gradient-to-r from-blue-500 to-sky-500 text-white shadow-md shadow-blue-500/30' : 'border-sky-300/80 bg-sky-50 text-blue-700 shadow-sm shadow-sky-200/50 hover:-translate-y-0.5 hover:border-sky-500 hover:bg-sky-100 hover:text-blue-800 hover:shadow-md hover:shadow-sky-300/40'}`}
                        title="富媒體卡片範本"
                        aria-label="開啟富媒體卡片範本"
                        aria-pressed={showRichCardPopup}
                      >
                        <span className={`flex h-5 w-5 items-center justify-center rounded-md ${showRichCardPopup ? 'bg-white/20' : 'bg-sky-200/70 group-hover:bg-sky-300/70'}`}>
                          <Megaphone className="h-3.5 w-3.5" strokeWidth={2.5} />
                        </span>
                        <span>富媒體卡片</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowTipModal(true)}
                        className="group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-300/70 bg-gradient-to-r from-amber-50 to-emerald-50 px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.04em] text-emerald-800 shadow-sm shadow-emerald-200/50 transition-all duration-200 hover:-translate-y-0.5 hover:border-emerald-400 hover:from-amber-100 hover:to-emerald-100 hover:shadow-md hover:shadow-emerald-300/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70"
                        title="向員工送出打賞"
                        aria-label="開啟送出打賞"
                      >
                        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-amber-200/80 transition-colors group-hover:bg-amber-300/80">
                          <Gift className="h-3.5 w-3.5 text-amber-800" strokeWidth={2.5} />
                        </span>
                        <span>送出打賞</span>
                      </button>
                    </div>
                    {/* Editor area */}
                    <div
                      ref={editorRef}
                      contentEditable
                      suppressContentEditableWarning
                      onInput={() => { setMessageInput(getEditorHasContent() ? (editorRef.current?.textContent || '_img_') : ''); syncMainFormatState(); }}
                      onKeyUp={() => { syncMainFormatState(); setIsBoldActive(document.queryCommandState('bold')); setIsUnderlineActive(document.queryCommandState('underline')); }}
                      onMouseUp={() => { syncMainFormatState(); setIsBoldActive(document.queryCommandState('bold')); setIsUnderlineActive(document.queryCommandState('underline')); }}
                      onSelect={() => { syncMainFormatState(); setIsBoldActive(document.queryCommandState('bold')); setIsUnderlineActive(document.queryCommandState('underline')); }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && e.ctrlKey) {
                          e.preventDefault();
                          handleSendMessage(e as unknown as React.FormEvent);
                        }
                      }}
                      className="min-h-[40px] max-h-[216px] overflow-y-auto px-3 py-2 text-slate-800 focus:outline-none text-sm leading-5 [&_b]:font-bold [&_u]:underline [&_font[size='5']]:text-lg [&_font[size='7']]:text-xl"
                      data-placeholder={`以 ${selectedCustomer?.customer_name || '經理'} 身分傳送訊息……（Ctrl+Enter 傳送）`}
                      style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                    />
                  </div>
                  <div className="flex flex-col gap-2.5 flex-shrink-0">
                    <button
                      type="submit"
                      disabled={!messageInput.trim()}
                      className="px-8 py-2.5 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 disabled:from-slate-300 disabled:to-slate-300 disabled:text-slate-400 text-white rounded-xl transition-all flex items-center justify-center gap-1.5 shadow-lg shadow-blue-600/20 disabled:shadow-none min-w-[64px]"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </div>
          {/* Empty State Panel */}
          <div className={`absolute inset-0 ${
            !showHistoryView && !(selectedEmployee && selectedCustomer) && !(selectedCustomer && !selectedEmployee)
              ? 'opacity-100 translate-y-0 z-10 pointer-events-auto'
              : 'opacity-0 translate-y-2 z-0 pointer-events-none'
          }`}>
            <div className="bg-slate-900/80 backdrop-blur-xl rounded-xl border border-slate-700/50 flex flex-col h-full">
              {/* Header with action buttons */}
              <div className="bg-slate-800/60 px-3 py-2 border-b border-slate-700/50">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-blue-600 rounded-md">
                      <MessageCircle className="w-3.5 h-3.5 text-white" />
                    </div>
                    <div>
                      <h3 className="text-sm font-bold text-white leading-tight">
                        {selectedEmployee ? selectedEmployee.username : '經理服務'}
                      </h3>
                      <p className="text-[10px] text-slate-400">
                        {selectedEmployee ? `編號： ${selectedEmployee.employee_id}` : '請選擇員工開始'}
                      </p>
                    </div>
                  </div>

                </div>
              </div>
              <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-slate-400">
                {selectedEmployee ? (
                  <>
                    <div className="w-14 h-14 mx-auto mb-3 bg-blue-600/15 rounded-xl flex items-center justify-center ring-1 ring-blue-500/30">
                      <User className="w-7 h-7 text-blue-400" />
                    </div>
                    <p className="text-sm font-bold text-white mb-0.5">{selectedEmployee?.username}</p>
                    <p className="text-[10px] text-blue-400 font-mono mb-3">編號： {selectedEmployee?.employee_id}</p>
                    <p className="text-xs text-slate-400">請選擇經理開始聊天</p>
                  </>
                ) : (
                  <>
                    <MessageCircle className="w-14 h-14 mx-auto mb-3 opacity-20" />
                    <p className="text-sm font-semibold mb-1">選擇員工</p>
                    <p className="text-xs">從左側面板選擇員工</p>
                  </>
                )}
              </div>
              </div>
            </div>
          </div>
          </div>
        </div>

      {/* Modals rendered via portal to escape stacking context and cover full viewport */}
      {createPortal(<>
      {/* Rating Modal */}
      {showRatingModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-[9999] p-4">
          <div className="bg-slate-900 border-2 border-yellow-500/30 rounded-3xl p-8 max-w-md w-full shadow-2xl">
            <div className="text-center mb-6">
              <div className="w-16 h-16 bg-gradient-to-br from-yellow-600/30 to-orange-600/30 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <Star className="w-8 h-8 text-yellow-400" />
              </div>
              <h3 className="text-2xl font-bold text-white mb-2">評價服務</h3>
              <p className="text-slate-400">您對 {selectedEmployee?.username} 的服務體驗如何？</p>
            </div>

            <div className="mb-6">
              <div className="flex justify-center gap-2 mb-6">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    key={star}
                    type="button"
                    onClick={() => setRatingValue(star)}
                    className="transition-transform hover:scale-110"
                  >
                    <Star
                      className={`w-10 h-10 ${
                        star <= ratingValue
                          ? 'fill-yellow-400 text-yellow-400'
                          : 'text-slate-600'
                      }`}
                    />
                  </button>
                ))}
              </div>

              <textarea
                value={ratingComment}
                onChange={(e) => setRatingComment(e.target.value)}
                placeholder="分享您的意見（選填）……"
                className="w-full px-4 py-3 bg-slate-800/50 border border-slate-700 rounded-xl text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-yellow-500 resize-none"
                rows={4}
              />
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleSubmitRating}
                disabled={ratingValue === 0}
                className="flex-1 px-6 py-3 bg-gradient-to-r from-yellow-600 to-orange-600 hover:from-yellow-700 hover:to-orange-700 disabled:from-slate-700 disabled:to-slate-700 text-white font-semibold rounded-xl transition-all disabled:cursor-not-allowed"
              >
                提交評分
              </button>
              <button
                onClick={() => {
                  setShowRatingModal(false);
                  setRatingValue(0);
                  setRatingComment('');
                }}
                className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-white rounded-xl transition-all"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rich Card Viewer Modal */}
      {viewingRichCard && createPortal(
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center p-0 xl:p-6"
          onClick={() => setViewingRichCard(null)}
          style={{ background: 'rgba(15, 23, 42, 0.6)', backdropFilter: 'blur(4px)', animation: 'fadeIn 0.2s ease-out' }}
        >
          <div
            className="relative w-full h-full xl:max-w-3xl xl:max-h-[85vh] xl:w-[680px] xl:h-auto bg-white rounded-none xl:rounded-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
            style={{ animation: 'scaleIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)', boxShadow: '0 25px 60px -12px rgba(0, 0, 0, 0.25)' }}
          >
            <div className="relative flex-shrink-0 overflow-hidden" style={{ padding: '24px 20px 20px', background: 'linear-gradient(135deg, #1e40af 0%, #2563eb 40%, #3b82f6 70%, #1d4ed8 100%)' }}>
              <div className="absolute inset-0 pointer-events-none overflow-hidden">
                <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/5 rounded-full blur-2xl"></div>
                <div className="absolute -bottom-8 -left-8 w-32 h-32 bg-blue-300/10 rounded-full blur-xl"></div>
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"></div>
              </div>
              <button onClick={() => setViewingRichCard(null)} className="absolute top-4 right-4 z-20 flex items-center justify-center w-9 h-9 rounded-full bg-white/15 hover:bg-white/25 border border-white/20 transition-all">
                <X className="w-4 h-4 text-white" />
              </button>
              <div className="relative z-10">
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-white/15 rounded-full border border-white/20 w-fit mb-3">
                  <Clock className="w-3 h-3 text-blue-100" />
                  <span className="text-[10px] sm:text-xs text-blue-50 font-medium">
                    {new Date(viewingRichCard.created_at).toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </span>
                </div>
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 p-2.5 bg-white/15 backdrop-blur-sm rounded-xl border border-white/20 shadow-lg shadow-blue-900/20">
                    <Megaphone className="w-6 h-6 text-white" />
                  </div>
                  <div className="flex-1 pr-8">
                    <h2 className="text-lg sm:text-xl font-bold text-white leading-snug break-words">{viewingRichCard.title || '通知'}</h2>
                    {viewingRichCard.subtitle && <p className="text-sm text-blue-100/80 mt-1 break-words">{viewingRichCard.subtitle}</p>}
                  </div>
                </div>
              </div>
              <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-blue-400/30 via-blue-300/50 to-blue-400/30"></div>
            </div>
            <div className="relative flex-1 overflow-y-auto min-h-0 p-6" style={{ WebkitOverflowScrolling: 'touch' }}>
              {loadingRichCardContent ? (
                <div className="flex flex-col items-center justify-center" style={{ minHeight: '40vh', animation: 'fadeIn 0.3s ease-out' }}>
                  <div className="relative mb-6">
                    <div className="w-14 h-14 rounded-full border-4 border-blue-100" style={{ animation: 'pulse 2s ease-in-out infinite' }}></div>
                    <div className="absolute inset-0 w-14 h-14 rounded-full border-4 border-transparent border-t-blue-500 border-r-blue-400 animate-spin"></div>
                    <div className="absolute inset-2 w-10 h-10 rounded-full border-4 border-transparent border-b-blue-300 border-l-blue-200" style={{ animation: 'spin 1.2s linear infinite reverse' }}></div>
                  </div>
                  <div className="w-40 h-1.5 bg-blue-100 rounded-full overflow-hidden mb-3">
                    <div className="h-full w-full bg-gradient-to-r from-blue-400 via-blue-500 to-blue-400 rounded-full" style={{ backgroundSize: '200% 100%', animation: 'shimmer 1.5s ease-in-out infinite' }}></div>
                  </div>
                  <div className="flex items-center gap-1 text-blue-500">
                    <span className="text-sm font-medium">載入內容</span>
                    <span className="flex gap-0.5">
                      <span className="w-1 h-1 bg-blue-400 rounded-full" style={{ animation: 'bounce 1.4s ease-in-out infinite' }}></span>
                      <span className="w-1 h-1 bg-blue-400 rounded-full" style={{ animation: 'bounce 1.4s ease-in-out infinite 0.2s' }}></span>
                      <span className="w-1 h-1 bg-blue-400 rounded-full" style={{ animation: 'bounce 1.4s ease-in-out infinite 0.4s' }}></span>
                    </span>
                  </div>
                </div>
              ) : (
                <div
                  className="announcement-content [&_img]:mx-auto [&_img]:block"
                  style={{ fontSize: '15px', lineHeight: '1.75', color: '#374151' }}
                  dangerouslySetInnerHTML={{ __html: sanitizeAnnouncementContent(richCardFullContent || viewingRichCard.message_content) }}
                />
              )}
            </div>
            <div className="relative flex-shrink-0 border-t border-slate-100 bg-slate-50/80 px-5 py-3">
              <button onClick={() => setViewingRichCard(null)} className="w-full px-5 py-3 bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-700 hover:to-blue-600 text-white font-semibold text-sm rounded-xl transition-all shadow-md shadow-blue-600/20">
                關閉
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Tip Modal */}
      {showTipModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
          <div className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-emerald-300/25 bg-gradient-to-b from-slate-900 via-slate-900 to-emerald-950/70 shadow-2xl shadow-emerald-950/40 ring-1 ring-emerald-200/10">
            <div className="absolute -right-16 -top-20 h-48 w-48 rounded-full bg-emerald-500/15 blur-3xl" />
            <div className="absolute -bottom-20 -left-16 h-48 w-48 rounded-full bg-amber-500/10 blur-3xl" />
            <div className="relative p-6 sm:p-7">
              <button
                type="button"
                onClick={() => { setShowTipModal(false); setTipAmount(''); }}
                className="absolute right-4 top-4 rounded-xl p-2 text-slate-400 transition-all hover:bg-emerald-500/15 hover:text-emerald-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/70"
                aria-label="關閉送出打賞"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="flex items-center gap-3 pr-8">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-emerald-300/30 bg-gradient-to-br from-emerald-500/30 to-amber-500/10 shadow-lg shadow-emerald-950/30">
                  <Gift className="h-6 w-6 text-emerald-200" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-black tracking-tight text-white">送出打賞</h3>
                    <span className="rounded-full border border-amber-300/25 bg-amber-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-amber-200">感謝心意</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-400">向 <span className="font-semibold text-emerald-200">{selectedEmployee?.username}</span></p>
                </div>
              </div>

              <div className="mt-7 rounded-2xl border border-emerald-200/15 bg-slate-950/35 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-[11px] font-bold uppercase tracking-[0.14em] text-emerald-100/80">打賞金額</label>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">USD</span>
                </div>
                <div className="relative">
                  <DollarSign className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-emerald-300" />
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={tipAmount}
                    onChange={(e) => {
                      tipOperationIdRef.current = null;
                      setTipAmount(e.target.value);
                    }}
                    placeholder="0.00"
                    className="w-full rounded-xl border border-emerald-200/20 bg-slate-900/80 py-4 pl-12 pr-16 text-3xl font-black tracking-tight text-white placeholder-slate-700 outline-none transition-all focus:border-emerald-300/70 focus:ring-2 focus:ring-emerald-400/20"
                    autoFocus
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-bold text-emerald-200/60">USD</span>
                </div>
                <p className="mt-2 text-[10px] text-slate-500">選擇預設金額或輸入自訂金額。</p>
                <div className="mt-3 grid grid-cols-5 gap-2">
                  {[5, 10, 20, 50, 100].map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        tipOperationIdRef.current = null;
                        setTipAmount(preset.toString());
                      }}
                      className={`rounded-lg border px-2 py-2 text-xs font-bold transition-all ${tipAmount === preset.toString() ? 'border-emerald-300 bg-emerald-500/25 text-emerald-100 shadow-sm shadow-emerald-500/20' : 'border-slate-700/80 bg-slate-900/70 text-slate-400 hover:border-emerald-300/60 hover:bg-emerald-500/10 hover:text-emerald-100'}`}
                    >
                      ${preset}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-6 flex gap-2.5">
                <button
                  type="button"
                  onClick={handleSendTip}
                  disabled={!tipAmount || parseFloat(tipAmount) <= 0 || sendingTip}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-emerald-300/50 bg-gradient-to-r from-emerald-500 to-teal-500 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-600/25 transition-all hover:-translate-y-0.5 hover:from-emerald-400 hover:to-teal-400 hover:shadow-emerald-500/35 disabled:cursor-not-allowed disabled:border-slate-700 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 disabled:shadow-none"
                >
                  {sendingTip ? <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <><Gift className="h-4 w-4" strokeWidth={2.5} /> 送出打賞</>}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowTipModal(false); setTipAmount(''); }}
                  className="rounded-xl border border-slate-700/80 bg-slate-800/70 px-5 py-3 text-sm font-semibold text-slate-300 transition-all hover:border-slate-600 hover:bg-slate-700 hover:text-white"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Customer Create/Edit Modal */}
      {(showCustomerForm || editingCustomer) && (
        <div className="fixed inset-0 flex items-center justify-center z-[9999] overflow-y-auto bg-slate-950/80 p-4 backdrop-blur-md" onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowCustomerForm(false); setEditingCustomer(null); setAutoMessageDrafts([]); setAutoMessageDraftMasterEnabled(false); setCustomerForm({ name: '', avatar: 'customer-avatar:regular:0', isSuper: false, superTitle: '', customId: '', badgeType: '', vipLabel: 'VIP', customAvatarFile: null, useCustomAvatar: false, remarks: '', employeePinTop: false, employeeAlwaysVisible: false, targetEmployeeIds: [], _empSearch: '' }); } }}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={editingCustomer ? (e) => { e.preventDefault(); handleUpdateCustomer(); } : handleCreateCustomer} className={`create-customer-modal create-customer-modal--emerald w-full max-h-[calc(100vh-2rem)] overflow-y-auto rounded-2xl border p-4 shadow-2xl ${customerForm.isSuper ? 'max-w-[95vw]' : 'max-w-5xl'} transition-all duration-200`}>
            <h3 className="mb-3 border-b border-emerald-200/15 pb-2 text-lg font-black tracking-tight text-white">{editingCustomer ? '編輯經理' : '建立經理'}</h3>
            {/* Super Customer Toggle */}
            <div className="mb-3 p-2.5 bg-gradient-to-r from-amber-900/30 to-orange-900/30 border border-amber-500/30 rounded-lg">
              <label className="flex items-center gap-3 cursor-pointer">
                <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${customerForm.isSuper ? 'bg-amber-500 border-amber-400' : 'border-amber-500/60 bg-transparent'}`}>
                  {customerForm.isSuper && (
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <input
                  type="checkbox"
                  checked={customerForm.isSuper}
                  onChange={(e) => setCustomerForm({ ...customerForm, isSuper: e.target.checked, avatar: e.target.checked ? 'customer-avatar:vip:0' : 'customer-avatar:regular:0' })}
                  className="sr-only"
                />
                <div className="flex items-center gap-2">
                  <Star className="w-5 h-5 text-amber-400" fill="currentColor" />
                  <span className="text-sm font-bold text-amber-200">超級經理（VIP）</span>
                </div>
              </label>
            </div>

            {customerForm.isSuper ? (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                {/* Left column: basic info + avatar */}
                <div className="min-w-0 p-3 bg-slate-800/40 border border-blue-500/30 rounded-xl">
                  <div className="mb-3">
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">經理名稱</label>
                    <input
                      type="text"
                      value={customerForm.name}
                      onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })}
                      className="w-full px-3 py-2.5 bg-slate-900/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                      placeholder="經理名稱"
                      required
                    />
                  </div>

                  {/* Avatar */}
                  <div className="mb-3">
                    <label className="flex items-center gap-2 cursor-pointer p-2.5 bg-amber-900/20 border border-amber-500/30 rounded-lg hover:bg-amber-900/30 transition-all">
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${customerForm.useCustomAvatar ? 'bg-amber-500 border-amber-400' : 'border-amber-500/60 bg-transparent'}`}>
                        {customerForm.useCustomAvatar && (
                          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                      <input
                        type="checkbox"
                        checked={customerForm.useCustomAvatar}
                        onChange={(e) => setCustomerForm({ ...customerForm, useCustomAvatar: e.target.checked })}
                        className="sr-only"
                      />
                      <div className="flex items-center gap-1.5">
                        <Image className="w-4 h-4 text-amber-400" />
                        <span className="text-xs font-medium text-amber-200">自訂照片頭像</span>
                      </div>
                    </label>
                  </div>

                  {customerForm.useCustomAvatar ? (
                    <div className="mb-3">
                      <input
                        ref={avatarFileInputRef}
                        type="file"
                        accept="image/*"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) setCustomerForm({ ...customerForm, customAvatarFile: file });
                        }}
                        className="hidden"
                      />
                      <button
                        type="button"
                        onClick={() => avatarFileInputRef.current?.click()}
                        className="flex w-full min-w-0 items-center justify-center gap-2 overflow-hidden rounded-lg border-2 border-amber-500/50 bg-amber-900/20 px-3 py-2.5 text-sm font-medium text-amber-200 transition-all hover:bg-amber-900/30"
                        title={customerForm.customAvatarFile?.name || '上傳照片'}
                      >
                        <Image className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 truncate">
                          {customerForm.customAvatarFile ? customerForm.customAvatarFile.name : '上傳照片'}
                        </span>
                      </button>
                      {customerForm.customAvatarFile && (
                        <div className="mt-1.5 p-2 bg-slate-900/50 rounded-lg flex items-center gap-2">
                          <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                            <Image className="w-5 h-5 text-amber-400" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-amber-200 font-medium truncate">{customerForm.customAvatarFile.name}</p>
                            <p className="text-[10px] text-amber-400">{(customerForm.customAvatarFile.size / 1024).toFixed(1)} KB</p>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div>
                      <label className="block text-xs font-medium text-amber-300 mb-1.5">VIP 經理頭像</label>
                      <CustomerAvatarPicker
                        value={customerForm.avatar}
                        onChange={(avatar) => setCustomerForm({ ...customerForm, avatar })}
                        theme="emerald"
                        variant="vip"
                      />
                    </div>
                  )}
                </div>

                {/* Center column: VIP settings */}
                <div className="min-w-0 p-3 bg-amber-950/30 border border-amber-500/30 rounded-xl">
                  <div className="mb-3">
                    <label className="block text-xs font-medium text-amber-300 mb-1.5">
                      自訂 ID <span className="text-amber-500/70 text-[10px]">（選填）</span>
                    </label>
                    <input
                      type="text"
                      value={customerForm.customId}
                      onChange={(e) => setCustomerForm({ ...customerForm, customId: e.target.value })}
                      className="w-full px-3 py-2.5 bg-amber-900/20 border border-amber-500/30 rounded-lg text-amber-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 placeholder:text-amber-600/50 truncate"
                      placeholder="例如：VIP-001"
                      maxLength={30}
                    />
                  </div>

                  <div className="mb-3">
                    <label className="block text-xs font-medium text-amber-300 mb-1.5">
                      標題前綴
                    </label>
                    <input
                      type="text"
                      value={customerForm.superTitle}
                      onChange={(e) => setCustomerForm({ ...customerForm, superTitle: e.target.value })}
                      className="w-full px-3 py-2.5 bg-amber-900/20 border border-amber-500/30 rounded-lg text-amber-200 font-bold text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 placeholder:text-amber-600/50 truncate"
                      placeholder="例如：鑽石、VIP 金牌"
                      maxLength={30}
                      style={{ textShadow: '0 0 10px rgba(251, 191, 36, 0.5)' }}
                    />
                    {customerForm.superTitle && (
                      <div className="mt-1.5 p-1.5 bg-slate-900/50 rounded-lg overflow-hidden">
                        <p className="text-[10px] text-slate-400 mb-0.5">預覽：</p>
                        <p className="text-sm font-black bg-gradient-to-r from-amber-400 via-yellow-400 to-amber-500 bg-clip-text text-transparent break-all leading-snug">{customerForm.superTitle}</p>
                        <p className="text-sm text-white break-all leading-snug">{customerForm.name || '名稱'}</p>
                      </div>
                    )}
                  </div>

                  <div className="mb-3">
                    <label className="block text-xs font-medium text-amber-300 mb-1.5">徽章類型</label>
                    <div className="grid grid-cols-5 gap-1.5">
                      {[
                        { value: 'diamond', icon: '💎', label: '鑽石' },
                        { value: 'crown', icon: '👑', label: '皇冠' },
                        { value: 'star', icon: '⭐', label: '星星' },
                        { value: 'vip', icon: '🏆', label: 'VIP' },
                        { value: 'premium', icon: '✨', label: '尊享' }
                      ].map((badge) => (
                        <button
                          key={badge.value}
                          type="button"
                          onClick={() => setCustomerForm({ ...customerForm, badgeType: badge.value as CustomerBadgeType })}
                          className={`p-2 rounded-lg flex flex-col items-center gap-0.5 transition-all ${
                            customerForm.badgeType === badge.value
                              ? 'bg-amber-600 scale-105 ring-2 ring-amber-400'
                              : 'bg-slate-800 hover:bg-slate-700'
                          }`}
                        >
                          <span className="text-lg">{badge.icon}</span>
                          <span className={`text-[9px] text-white ${customerForm.badgeType === badge.value ? 'font-bold' : 'font-medium'}`}>{badge.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mb-3">
                    <label className="block text-xs font-medium text-amber-300 mb-1.5">VIP 徽章標籤</label>
                    <input
                      type="text"
                      value={customerForm.vipLabel}
                      onChange={(e) => setCustomerForm({ ...customerForm, vipLabel: e.target.value })}
                      placeholder="VIP"
                      maxLength={30}
                      className="w-full px-3 py-2.5 bg-slate-800 border border-amber-500/30 rounded-lg text-white text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/50 placeholder-gray-500"
                    />
                    <p className="text-[10px] text-slate-400 mt-1">聊天卡片上的徽章文字（例如：VIP、SVIP、GOLD）</p>
                  </div>

                  <div className="pt-3 mt-auto border-t border-amber-500/20">
                    <label className="block text-xs font-medium text-slate-300 mb-1.5">備註（選填）</label>
                    <input
                      type="text"
                      value={customerForm.remarks}
                      onChange={(e) => setCustomerForm({ ...customerForm, remarks: e.target.value })}
                      placeholder="新增備註以識別此經理……"
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      maxLength={100}
                    />
                  </div>
                </div>

                {/* Right column: 員工顯示設定 Settings */}
                <div className="min-w-0 p-3 bg-gradient-to-br from-teal-900/30 to-cyan-900/30 border border-teal-500/30 rounded-xl flex flex-col">
                  <div className="flex items-center gap-2 mb-3">
                    <Eye className="w-4 h-4 text-teal-400" />
                    <span className="text-sm font-bold text-teal-200">員工顯示設定</span>
                  </div>

                  <div className="space-y-2 mb-3">
                    <label className="flex items-center gap-2 cursor-pointer p-2 bg-slate-800/60 border border-teal-500/20 rounded-lg hover:bg-slate-800/80 transition-colors">
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${customerForm.employeePinTop ? 'bg-teal-500 border-teal-400' : 'border-teal-500/60 bg-transparent'}`}>
                        {customerForm.employeePinTop && (
                          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                        )}
                      </div>
                      <input type="checkbox" checked={customerForm.employeePinTop} onChange={(e) => setCustomerForm({ ...customerForm, employeePinTop: e.target.checked })} className="sr-only" />
                      <div>
                        <span className="text-xs font-medium text-slate-200 leading-tight block">置頂</span>
                        <p className="text-[10px] text-slate-400 leading-tight">置於聊天清單頂端</p>
                      </div>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer p-2 bg-slate-800/60 border border-teal-500/20 rounded-lg hover:bg-slate-800/80 transition-colors">
                      <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${customerForm.employeeAlwaysVisible ? 'bg-teal-500 border-teal-400' : 'border-teal-500/60 bg-transparent'}`}>
                        {customerForm.employeeAlwaysVisible && (
                          <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                        )}
                      </div>
                      <input type="checkbox" checked={customerForm.employeeAlwaysVisible} onChange={(e) => setCustomerForm({ ...customerForm, employeeAlwaysVisible: e.target.checked })} className="sr-only" />
                      <div>
                        <span className="text-xs font-medium text-slate-200 leading-tight block">始終顯示</span>
                        <p className="text-[10px] text-slate-400 leading-tight">即使沒有訊息也顯示</p>
                      </div>
                    </label>
                  </div>

                  {/* 可見對象 - dual panel picker */}
                  <div className="flex-1 min-h-0 flex flex-col">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-xs font-medium text-teal-300">可見對象</span>
                      <button
                        type="button"
                        onClick={() => setCustomerForm({ ...customerForm, targetEmployeeIds: [] })}
                        className={`text-[11px] px-3 py-1.5 rounded-lg font-semibold transition-all shadow-sm ${customerForm.targetEmployeeIds.length === 0 ? 'bg-teal-600 text-white border border-teal-500' : 'bg-amber-600 text-white border border-amber-500 hover:bg-amber-700'}`}
                      >
                        {customerForm.targetEmployeeIds.length === 0 ? '所有員工' : '重設為全部'}
                      </button>
                    </div>

                    <div className="relative mb-2">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                      <input
                        type="text"
                        value={customerForm._empSearch || ''}
                        onChange={(e) => setCustomerForm({ ...customerForm, _empSearch: e.target.value })}
                        className="w-full pl-7 pr-2 py-1.5 bg-slate-900/60 border border-slate-600/50 rounded-lg text-white text-[11px] focus:outline-none focus:ring-1 focus:ring-teal-500/50 placeholder:text-slate-500"
                        placeholder="搜尋員工……"
                      />
                    </div>

                    <div className="grid grid-rows-2 gap-2" style={{ height: '360px' }}>
                      {/* 可選員工 employees */}
                      <div className="min-h-0 flex flex-col bg-slate-900/40 border border-slate-600/30 rounded-lg overflow-hidden">
                        <div className="px-2 py-1 bg-slate-800/80 border-b border-slate-600/30 flex-shrink-0">
                          <span className="text-[10px] font-medium text-slate-400">可選員工 ({employees.filter(emp => !customerForm.targetEmployeeIds.includes(emp.id) && (!customerForm._empSearch || emp.username.toLowerCase().includes((customerForm._empSearch || '').toLowerCase()) || emp.employee_id.toLowerCase().includes((customerForm._empSearch || '').toLowerCase()))).length})</span>
                        </div>
                        <div className="flex-1 overflow-y-auto p-1 space-y-0.5 scrollbar-thin scrollbar-manager">
                          {employees.filter(emp => !customerForm.targetEmployeeIds.includes(emp.id) && (!customerForm._empSearch || emp.username.toLowerCase().includes((customerForm._empSearch || '').toLowerCase()) || emp.employee_id.toLowerCase().includes((customerForm._empSearch || '').toLowerCase()))).map(emp => (
                            <button
                              key={emp.id}
                              type="button"
                              onClick={() => setCustomerForm({ ...customerForm, targetEmployeeIds: [...customerForm.targetEmployeeIds, emp.id] })}
                              className="w-full flex items-center gap-1.5 py-1.5 px-2 rounded-md hover:bg-teal-500/20 transition-colors text-left group"
                            >
                              <div className="w-4 h-4 rounded-full bg-teal-500/20 border border-teal-500/40 flex items-center justify-center flex-shrink-0 group-hover:bg-teal-500/40 group-hover:border-teal-400 transition-all">
                                <Plus className="w-2.5 h-2.5 text-teal-400" strokeWidth={3} />
                              </div>
                              <span className="text-[11px] text-white font-medium truncate">{emp.username}</span>
                              <span className="text-[10px] text-cyan-400/70 font-mono flex-shrink-0 ml-auto">{emp.employee_id}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                      {/* 已選員工 employees */}
                      <div className="min-h-0 flex flex-col bg-teal-900/20 border border-teal-500/20 rounded-lg overflow-hidden">
                        <div className="px-2 py-1 bg-teal-900/40 border-b border-teal-500/20 flex-shrink-0">
                          <span className="text-[10px] font-medium text-teal-300">已選員工 ({customerForm.targetEmployeeIds.length})</span>
                        </div>
                        <div className="flex-1 overflow-y-auto p-1 space-y-0.5 scrollbar-thin scrollbar-manager">
                          {customerForm.targetEmployeeIds.length === 0 ? (
                            <div className="flex items-center justify-center h-full">
                              <span className="text-[10px] text-teal-400/60 italic">所有員工（未指定個別員工）</span>
                            </div>
                          ) : (
                            customerForm.targetEmployeeIds.filter(id => {
                              if (!customerForm._empSearch) return true;
                              const emp = employees.find(e => e.id === id);
                              if (!emp) return false;
                              const q = (customerForm._empSearch || '').toLowerCase();
                              return emp.username.toLowerCase().includes(q) || emp.employee_id.toLowerCase().includes(q);
                            }).map(id => {
                              const emp = employees.find(e => e.id === id);
                              if (!emp) return null;
                              return (
                                <button
                                  key={id}
                                  type="button"
                                  onClick={() => setCustomerForm({ ...customerForm, targetEmployeeIds: customerForm.targetEmployeeIds.filter(eid => eid !== id) })}
                                  className="w-full flex items-center gap-1.5 py-1.5 px-2 rounded-md hover:bg-red-500/20 transition-colors text-left group"
                                >
                                  <div className="w-4 h-4 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center flex-shrink-0 group-hover:bg-red-500/40 group-hover:border-red-400 transition-all">
                                    <X className="w-2.5 h-2.5 text-red-400" strokeWidth={3} />
                                  </div>
                                  <span className="text-[11px] text-white font-medium truncate">{emp.username}</span>
                                  <span className="text-[10px] text-cyan-400/70 font-mono flex-shrink-0 ml-auto">{emp.employee_id}</span>
                                </button>
                              );
                            })
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              {/* 4th column: Auto Messages */}
                <CustomerAutoMessages
                  customerId={editingCustomer?.id || null}
                  adminId={selectedAdminId || adminId}
                  sourceType="ccc_service"
                  draftMessages={autoMessageDrafts}
                  draftMasterEnabled={autoMessageDraftMasterEnabled}
                  onDraftMessagesChange={setAutoMessageDrafts}
                  onDraftMasterEnabledChange={setAutoMessageDraftMasterEnabled}
                />
              </div>
            </>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr]">
                  {/* Left: Name, Avatar, Remarks */}
                  <div className="min-w-0">
                    <div className="mb-4">
                      <input
                        type="text"
                        value={customerForm.name}
                        onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })}
                        className="w-full px-4 py-3 bg-slate-900/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="經理名稱"
                        required
                      />
                    </div>

                    <div className="mb-3">
                      <label className="block text-sm font-medium text-emerald-200 mb-2">選擇經理頭像</label>
                      <CustomerAvatarPicker
                        value={customerForm.avatar}
                        onChange={(avatar) => setCustomerForm({ ...customerForm, avatar })}
                        theme="emerald"
                        variant="regular"
                        size="large"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-slate-300 mb-1.5">備註（選填）</label>
                      <input
                        type="text"
                        value={customerForm.remarks}
                        onChange={(e) => setCustomerForm({ ...customerForm, remarks: e.target.value })}
                        placeholder="新增備註以識別此經理……"
                        className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        maxLength={100}
                      />
                    </div>
                  </div>

                  {/* Right: 員工顯示設定 Settings */}
                  <div className="min-w-0 p-3 bg-gradient-to-br from-teal-900/30 to-cyan-900/30 border border-teal-500/30 rounded-xl flex flex-col">
                    <div className="flex items-center gap-2 mb-3">
                      <Eye className="w-4 h-4 text-teal-400" />
                      <span className="text-sm font-bold text-teal-200">員工顯示設定</span>
                    </div>

                    <div className="space-y-2 mb-3">
                      <label className="flex items-center gap-2 cursor-pointer p-2 bg-slate-800/60 border border-teal-500/20 rounded-lg hover:bg-slate-800/80 transition-colors">
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${customerForm.employeePinTop ? 'bg-teal-500 border-teal-400' : 'border-teal-500/60 bg-transparent'}`}>
                          {customerForm.employeePinTop && (
                            <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                          )}
                        </div>
                        <input type="checkbox" checked={customerForm.employeePinTop} onChange={(e) => setCustomerForm({ ...customerForm, employeePinTop: e.target.checked })} className="sr-only" />
                        <div>
                          <span className="text-xs font-medium text-slate-200 leading-tight block">置頂</span>
                          <p className="text-[10px] text-slate-400 leading-tight">置於聊天清單頂端</p>
                        </div>
                      </label>
                      <label className="flex items-center gap-2 cursor-pointer p-2 bg-slate-800/60 border border-teal-500/20 rounded-lg hover:bg-slate-800/80 transition-colors">
                        <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${customerForm.employeeAlwaysVisible ? 'bg-teal-500 border-teal-400' : 'border-teal-500/60 bg-transparent'}`}>
                          {customerForm.employeeAlwaysVisible && (
                            <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                          )}
                        </div>
                        <input type="checkbox" checked={customerForm.employeeAlwaysVisible} onChange={(e) => setCustomerForm({ ...customerForm, employeeAlwaysVisible: e.target.checked })} className="sr-only" />
                        <div>
                          <span className="text-xs font-medium text-slate-200 leading-tight block">始終顯示</span>
                          <p className="text-[10px] text-slate-400 leading-tight">即使沒有訊息也顯示</p>
                        </div>
                      </label>
                    </div>

                    {/* 可見對象 - dual panel picker */}
                    <div className="flex-1 min-h-0 flex flex-col">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-medium text-teal-300">可見對象</span>
                        <button
                          type="button"
                          onClick={() => setCustomerForm({ ...customerForm, targetEmployeeIds: [] })}
                          className={`text-[11px] px-3 py-1.5 rounded-lg font-semibold transition-all shadow-sm ${customerForm.targetEmployeeIds.length === 0 ? 'bg-teal-600 text-white border border-teal-500' : 'bg-amber-600 text-white border border-amber-500 hover:bg-amber-700'}`}
                        >
                          {customerForm.targetEmployeeIds.length === 0 ? '所有員工' : '重設為全部'}
                        </button>
                      </div>

                      <div className="relative mb-2">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
                        <input
                          type="text"
                          value={customerForm._empSearch || ''}
                          onChange={(e) => setCustomerForm({ ...customerForm, _empSearch: e.target.value })}
                          className="w-full pl-7 pr-2 py-1.5 bg-slate-900/60 border border-slate-600/50 rounded-lg text-white text-[11px] focus:outline-none focus:ring-1 focus:ring-teal-500/50 placeholder:text-slate-500"
                          placeholder="搜尋員工……"
                        />
                      </div>

                      <div className="grid grid-rows-2 gap-2" style={{ height: '360px' }}>
                        {/* 可選員工 employees */}
                        <div className="min-h-0 flex flex-col bg-slate-900/40 border border-slate-600/30 rounded-lg overflow-hidden">
                          <div className="px-2 py-1 bg-slate-800/80 border-b border-slate-600/30 flex-shrink-0">
                            <span className="text-[10px] font-medium text-slate-400">可選員工 ({employees.filter(emp => !customerForm.targetEmployeeIds.includes(emp.id) && (!customerForm._empSearch || emp.username.toLowerCase().includes((customerForm._empSearch || '').toLowerCase()) || emp.employee_id.toLowerCase().includes((customerForm._empSearch || '').toLowerCase()))).length})</span>
                          </div>
                          <div className="flex-1 overflow-y-auto p-1 space-y-0.5 scrollbar-thin scrollbar-manager">
                            {employees.filter(emp => !customerForm.targetEmployeeIds.includes(emp.id) && (!customerForm._empSearch || emp.username.toLowerCase().includes((customerForm._empSearch || '').toLowerCase()) || emp.employee_id.toLowerCase().includes((customerForm._empSearch || '').toLowerCase()))).map(emp => (
                              <button
                                key={emp.id}
                                type="button"
                                onClick={() => setCustomerForm({ ...customerForm, targetEmployeeIds: [...customerForm.targetEmployeeIds, emp.id] })}
                                className="w-full flex items-center gap-1.5 py-1.5 px-2 rounded-md hover:bg-teal-500/20 transition-colors text-left group"
                              >
                                <div className="w-4 h-4 rounded-full bg-teal-500/20 border border-teal-500/40 flex items-center justify-center flex-shrink-0 group-hover:bg-teal-500/40 group-hover:border-teal-400 transition-all">
                                  <Plus className="w-2.5 h-2.5 text-teal-400" strokeWidth={3} />
                                </div>
                                <span className="text-[11px] text-white font-medium truncate">{emp.username}</span>
                                <span className="text-[10px] text-cyan-400/70 font-mono flex-shrink-0 ml-auto">{emp.employee_id}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                        {/* 已選員工 employees */}
                        <div className="min-h-0 flex flex-col bg-teal-900/20 border border-teal-500/20 rounded-lg overflow-hidden">
                          <div className="px-2 py-1 bg-teal-900/40 border-b border-teal-500/20 flex-shrink-0">
                            <span className="text-[10px] font-medium text-teal-300">已選員工 ({customerForm.targetEmployeeIds.length})</span>
                          </div>
                          <div className="flex-1 overflow-y-auto p-1 space-y-0.5 scrollbar-thin scrollbar-manager">
                            {customerForm.targetEmployeeIds.length === 0 ? (
                              <div className="flex items-center justify-center h-full">
                                <span className="text-[10px] text-teal-400/60 italic">所有員工（未指定個別員工）</span>
                              </div>
                            ) : (
                              customerForm.targetEmployeeIds.filter(id => {
                                if (!customerForm._empSearch) return true;
                                const emp = employees.find(e => e.id === id);
                                if (!emp) return false;
                                const q = (customerForm._empSearch || '').toLowerCase();
                                return emp.username.toLowerCase().includes(q) || emp.employee_id.toLowerCase().includes(q);
                              }).map(id => {
                                const emp = employees.find(e => e.id === id);
                                if (!emp) return null;
                                return (
                                  <button
                                    key={id}
                                    type="button"
                                    onClick={() => setCustomerForm({ ...customerForm, targetEmployeeIds: customerForm.targetEmployeeIds.filter(eid => eid !== id) })}
                                    className="w-full flex items-center gap-1.5 py-1.5 px-2 rounded-md hover:bg-red-500/20 transition-colors text-left group"
                                  >
                                    <div className="w-4 h-4 rounded-full bg-red-500/20 border border-red-500/40 flex items-center justify-center flex-shrink-0 group-hover:bg-red-500/40 group-hover:border-red-400 transition-all">
                                      <X className="w-2.5 h-2.5 text-red-400" strokeWidth={3} />
                                    </div>
                                    <span className="text-[11px] text-white font-medium truncate">{emp.username}</span>
                                    <span className="text-[10px] text-cyan-400/70 font-mono flex-shrink-0 ml-auto">{emp.employee_id}</span>
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                {/* 3rd column: Auto Messages (regular customer) */}
                <CustomerAutoMessages
                  customerId={editingCustomer?.id || null}
                  adminId={selectedAdminId || adminId}
                  sourceType="ccc_service"
                  draftMessages={autoMessageDrafts}
                  draftMasterEnabled={autoMessageDraftMasterEnabled}
                  onDraftMessagesChange={setAutoMessageDrafts}
                  onDraftMasterEnabledChange={setAutoMessageDraftMasterEnabled}
                />
                </div>
              </>
            )}

            <div className="create-customer-modal__actions flex gap-2 mt-4">
              <button
                type="submit"
                disabled={savingCustomer}
                className="flex-1 px-4 py-2 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-700 hover:to-cyan-700 text-white rounded-lg transition-all font-medium disabled:cursor-not-allowed disabled:opacity-60"
              >
                {savingCustomer ? '儲存中……' : editingCustomer ? '儲存' : '建立'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCustomerForm(false);
                  setEditingCustomer(null);
                  setAutoMessageDrafts([]);
                  setAutoMessageDraftMasterEnabled(false);
                  setCustomerForm({ name: '', avatar: 'customer-avatar:regular:0', isSuper: false, superTitle: '', customId: '', badgeType: '', vipLabel: 'VIP', customAvatarFile: null, useCustomAvatar: false, remarks: '', employeePinTop: false, employeeAlwaysVisible: false, targetEmployeeIds: [], _empSearch: '' });
                }}
                className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg transition-all"
              >
                取消
              </button>
            </div>
          </form>
        </div>
      )}

      {showTemplateManager && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowTemplateManager(false); setEditingTemplate(null); setTemplateForm({ name: '', title: '', subtitle: '', content: '', content_type: 'richtext' }); if (templateEditorRef.current) templateEditorRef.current.innerHTML = ''; setRichCardContent(''); const rce = richCardEditorRef.current?.getEditor(); if (rce) rce.commands.setContent(''); } }}>
          <div onClick={(e) => e.stopPropagation()} className={`bg-slate-900 rounded-2xl border border-slate-700/50 w-full h-[92vh] flex flex-col shadow-2xl transition-all duration-300 ${templateForm.content_type === 'rich_card' ? 'max-w-[90vw]' : 'max-w-5xl'}`}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700/50 flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className={`p-1.5 rounded-lg ${templateManagerMode === 'rich_card' ? 'bg-blue-600/20' : 'bg-teal-600/20'}`}>
                  {templateManagerMode === 'rich_card' ? <Megaphone className="w-4 h-4 text-blue-400" /> : <BookOpen className="w-4 h-4 text-teal-400" />}
                </div>
                <h3 className="text-sm font-bold text-white">{templateManagerMode === 'rich_card' ? '富媒體卡片範本' : '訊息範本'}</h3>
                <span className="text-[11px] text-slate-500 font-medium ml-1">{messageTemplates.filter(t => templateManagerMode === 'rich_card' ? t.content_type === 'rich_card' : t.content_type !== 'rich_card').length} 個範本</span>
              </div>
              <button onClick={() => { setShowTemplateManager(false); setEditingTemplate(null); setTemplateForm({ name: '', title: '', subtitle: '', content: '', content_type: 'richtext' }); if (templateEditorRef.current) templateEditorRef.current.innerHTML = ''; }} className="p-1.5 hover:bg-slate-800 rounded-lg transition-colors">
                <X className="w-4 h-4 text-slate-400" />
              </button>
            </div>

            {/* Left/Right body */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
              {/* Left: Editor */}
              <div className={`flex flex-col border-r border-slate-700/50 p-4 gap-3 ${templateForm.content_type === 'rich_card' ? 'w-[72%]' : 'w-1/2'}`}>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <h4 className="text-sm font-bold text-white flex items-center gap-2 whitespace-nowrap">
                    {editingTemplate ? <Pencil className="w-3.5 h-3.5 text-blue-400" /> : <Plus className="w-3.5 h-3.5 text-teal-400" />}
                    {editingTemplate ? '編輯範本' : '新增範本'}
                  </h4>
                  <input
                    type="text"
                    value={templateForm.name}
                    onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })}
                    className="flex-1 min-w-0 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 placeholder:text-slate-400 shadow-sm"
                    placeholder="範本名稱（例如：歡迎訊息、常見問答、跟進……）"
                  />
                </div>
                <input ref={templateImageInputRef} type="file" accept="image/*" onChange={handleTemplateImageUpload} className="hidden" />
                <input id="templateFileImport" type="file" accept=".txt,.doc,.docx" onChange={handleTemplateFileImport} className="hidden" />
                {/* Content type toggle */}
                {templateManagerMode !== 'rich_card' && (
                <div className="flex items-center gap-1 p-1 bg-slate-800 rounded-lg flex-shrink-0">
                  <button type="button" onClick={() => { setTemplateForm(f => ({ ...f, content_type: 'richtext' })); }} className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-md transition-all ${templateForm.content_type === 'richtext' ? 'bg-teal-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}>
                    富文字
                  </button>
                  <button type="button" onClick={() => { setTemplateForm(f => ({ ...f, content_type: 'rich_card' })); }} className={`flex-1 px-3 py-1.5 text-xs font-semibold rounded-md transition-all flex items-center justify-center gap-1.5 ${templateForm.content_type === 'rich_card' ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-400 hover:text-white'}`}>
                    <Megaphone className="w-3 h-3" />
                    富媒體卡片
                  </button>
                </div>
                )}
                {templateForm.content_type === 'rich_card' ? (
                  <>
                  <div className="flex flex-row gap-3 items-center bg-blue-500 rounded-t-xl px-3 py-2 flex-shrink-0">
                    <Megaphone className="w-4 h-4 text-white/80 flex-shrink-0" />
                    <input
                      type="text"
                      value={templateForm.title}
                      onChange={(e) => setTemplateForm(f => ({ ...f, title: e.target.value }))}
                      className="flex-1 bg-white text-slate-800 text-sm font-semibold placeholder:text-slate-400 focus:outline-none rounded px-2.5 py-1.5 shadow-sm"
                      placeholder="主要標題（例如：重要通知）……"
                    />
                    <input
                      type="text"
                      value={templateForm.subtitle}
                      onChange={(e) => setTemplateForm(f => ({ ...f, subtitle: e.target.value }))}
                      className="flex-1 bg-white/90 text-slate-600 text-xs placeholder:text-slate-400 focus:outline-none rounded px-2.5 py-1.5 shadow-sm"
                      placeholder="副標題（選填）……"
                    />
                  </div>
                  <div className="flex-1 min-h-0 rounded-b-xl border border-t-0 border-slate-300 bg-white overflow-hidden shadow-sm flex flex-col focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400/40 transition-all">
                    <div className="flex-1 min-h-0 overflow-hidden">
                      <TiptapEditor
                        ref={richCardEditorRef}
                        content={richCardContent}
                        onChange={(c) => { setRichCardContent(c); setTemplateForm(f => ({ ...f, content: c })); }}
                        placeholder="撰寫富媒體卡片內容（圖片、格式、標題）……"
                        adminId={adminId}
                        theme="light"
                      />
                    </div>
                  </div>
                  </>
                ) : (
                <>
                {docImportProgress && (
                  <div className="px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg flex-shrink-0 mb-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-semibold text-blue-700">{docImportProgress.phase}</span>
                      <span className="text-[10px] font-bold text-blue-500">{docImportProgress.pct}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-blue-100 rounded-full overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 rounded-full transition-all duration-300 ease-out" style={{ width: `${docImportProgress.pct}%` }} />
                    </div>
                  </div>
                )}
                {/* Unified toolbar + editor (light theme, matches chat input) */}
                <div className="flex-1 min-h-0 rounded-xl border border-slate-300 bg-white overflow-hidden focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400/40 transition-all shadow-sm flex flex-col">
                  <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-slate-200 bg-slate-50/80 flex-shrink-0 flex-wrap">
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); execTemplateCmd('bold'); }} className={`p-1.5 rounded-md transition-all ${templateBoldActive ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`} title="粗體（Ctrl+B）">
                      <Bold className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); execTemplateCmd('underline'); }} className={`p-1.5 rounded-md transition-all ${templateUnderlineActive ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`} title="底線（Ctrl+U）">
                      <Underline className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); execTemplateCmd('strikeThrough'); }} className={`p-1.5 rounded-md transition-all ${templateStrikethroughActive ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`} title="刪除線">
                      <Strikethrough className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                    <div className="w-px h-5 bg-slate-200 mx-1" />
                    <div className="flex items-center bg-slate-100 rounded-md p-0.5 gap-0.5">
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); const next = templateFontSize === 'normal' ? null : 'normal'; execTemplateCmd('fontSize', next ? '3' : '3'); setTemplateFontSize(next); }} className={`px-1.5 py-0.5 text-[10px] rounded transition-all ${templateFontSize === 'normal' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-semibold hover:text-slate-700 hover:bg-slate-200'}`} title="一般大小">A</button>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); const next = templateFontSize === 'large' ? null : 'large'; execTemplateCmd('fontSize', next ? '5' : '3'); setTemplateFontSize(next); }} className={`px-1.5 py-0.5 text-xs rounded transition-all ${templateFontSize === 'large' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-semibold hover:text-slate-700 hover:bg-slate-200'}`} title="大字">A</button>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); const next = templateFontSize === 'xlarge' ? null : 'xlarge'; execTemplateCmd('fontSize', next ? '7' : '3'); setTemplateFontSize(next); }} className={`px-1.5 py-0.5 text-sm rounded transition-all ${templateFontSize === 'xlarge' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-bold hover:text-slate-700 hover:bg-slate-200'}`} title="特大字">A</button>
                    </div>
                    <div className="w-px h-5 bg-slate-200 mx-1" />
                    <div className="flex items-center bg-slate-100 rounded-md p-0.5 gap-0.5">
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); execTemplateCmd('justifyLeft'); setTemplateAlign('left'); }} className={`p-1 rounded transition-all ${templateAlign === 'left' ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-200'}`} title="靠左對齊">
                        <AlignLeft className="w-3 h-3" strokeWidth={2.5} />
                      </button>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); execTemplateCmd('justifyCenter'); setTemplateAlign('center'); }} className={`p-1 rounded transition-all ${templateAlign === 'center' ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-200'}`} title="置中對齊">
                        <AlignCenter className="w-3 h-3" strokeWidth={2.5} />
                      </button>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); execTemplateCmd('justifyRight'); setTemplateAlign('right'); }} className={`p-1 rounded transition-all ${templateAlign === 'right' ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-400 hover:text-slate-700 hover:bg-slate-200'}`} title="靠右對齊">
                        <AlignRight className="w-3 h-3" strokeWidth={2.5} />
                      </button>
                    </div>
                    <div className="relative">
                      <button
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); setShowTextColorPicker(showTextColorPicker === 'template' ? null : 'template'); setShowBgColorPicker(null); }}
                        className={`p-1.5 rounded-md transition-all ${showTextColorPicker === 'template' ? 'bg-blue-500/20 text-blue-600' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`}
                        title="文字顏色"
                      >
                        <Palette className="w-3.5 h-3.5" strokeWidth={2.5} />
                      </button>
                      {showTextColorPicker === 'template' && (
                        <>
                          <div className="fixed inset-0 z-[60]" onMouseDown={() => setShowTextColorPicker(null)} />
                          <div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-[61] p-2 grid grid-cols-4 gap-1.5 w-[140px]">
                            {TEXT_COLORS.map((c) => (
                              <button key={c.color} type="button" onMouseDown={(e) => { e.preventDefault(); execTemplateCmd('foreColor', c.color); setTemplateTextColor(c.color); setShowTextColorPicker(null); }} className="w-7 h-7 rounded-md border border-slate-600 hover:scale-110 transition-transform flex items-center justify-center" title={c.label}>
                                <span className="text-sm font-bold" style={{ color: c.color }}>A</span>
                              </button>
                            ))}
                            <button type="button" onMouseDown={(e) => { e.preventDefault(); execTemplateCmd('removeFormat'); setTemplateTextColor(null); setShowTextColorPicker(null); }} className="col-span-4 mt-1.5 px-2 py-1.5 text-[11px] font-bold text-red-500 bg-red-50 border border-red-200 hover:bg-red-100 hover:border-red-300 rounded-md transition-all text-center tracking-wide">清除</button>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="relative">
                      <button
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); setShowBgColorPicker(showBgColorPicker === 'template' ? null : 'template'); setShowTextColorPicker(null); }}
                        className={`p-1.5 rounded-md transition-all ${showBgColorPicker === 'template' ? 'bg-yellow-500/30 text-yellow-600' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`}
                        title="背景顏色"
                      >
                        <Highlighter className="w-3.5 h-3.5" strokeWidth={2.5} />
                      </button>
                      {showBgColorPicker === 'template' && (
                        <>
                          <div className="fixed inset-0 z-[60]" onMouseDown={() => setShowBgColorPicker(null)} />
                          <div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-[61] p-2 grid grid-cols-4 gap-1.5 w-[140px]">
                            {BG_COLORS.map((c) => (
                              <button key={c.color} type="button" onMouseDown={(e) => { e.preventDefault(); applyBgColor(c.color, 'template'); }} className="w-7 h-7 rounded-md border border-slate-600 hover:scale-110 transition-transform" style={{ backgroundColor: c.color }} title={c.label} />
                            ))}
                            <button type="button" onMouseDown={(e) => { e.preventDefault(); applyBgColor(null, 'template'); }} className="col-span-4 mt-1.5 px-2 py-1.5 text-[11px] font-bold text-red-500 bg-red-50 border border-red-200 hover:bg-red-100 hover:border-red-300 rounded-md transition-all text-center tracking-wide">清除</button>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="w-px h-5 bg-slate-200 mx-1" />
                    <button
                      type="button"
                      onClick={() => templateImageInputRef.current?.click()}
                      disabled={uploadingTemplateImage}
                      className="p-1.5 rounded-md text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors disabled:opacity-50"
                      title="插入圖片"
                    >
                      {uploadingTemplateImage ? (
                        <div className="w-3.5 h-3.5 border-2 border-slate-300 border-t-blue-500 rounded-full animate-spin" />
                      ) : (
                        <Image className="w-3.5 h-3.5" strokeWidth={2.5} />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => document.getElementById('templateFileImport')?.click()}
                      className="p-1.5 rounded-md text-slate-500 hover:bg-slate-200 hover:text-slate-800 transition-colors"
                      title="從 .txt 或 .docx 匯入"
                    >
                      <Upload className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                  </div>
                  <div
                    ref={templateEditorRef}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={() => {
                      if (templateEditorRef.current) {
                        setTemplateForm(prev => ({ ...prev, content: templateEditorRef.current?.innerHTML || '' }));
                        syncTemplateFormatState();
                      }
                    }}
                    onKeyUp={syncTemplateFormatState}
                    onMouseUp={syncTemplateFormatState}
                    onSelect={syncTemplateFormatState}
                    className="flex-1 min-h-[200px] overflow-y-auto px-3 py-2.5 text-slate-800 text-sm focus:outline-none chat-rich-content"
                    style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                    data-placeholder="輸入範本內容、貼上格式化文字或匯入檔案……"
                  />
                </div>
                </>
                )}
                {/* Action buttons */}
                <div className="flex gap-2 flex-shrink-0 flex-col">
                  {savingTemplate && (
                    <div className="bg-slate-800 rounded-lg px-3 py-2 border border-teal-500/30">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] font-semibold text-teal-400">正在儲存範本……</span>
                        <div className="w-3.5 h-3.5 border-2 border-teal-500/30 border-t-teal-400 rounded-full animate-spin" />
                      </div>
                      <div className="w-full h-1.5 bg-slate-700 rounded-full overflow-hidden">
                        <div className="h-full bg-gradient-to-r from-teal-400 to-cyan-400 rounded-full" style={{ width: '100%', backgroundSize: '200% 100%', animation: 'shimmer 1.2s ease-in-out infinite' }} />
                      </div>
                    </div>
                  )}
                  <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={editingTemplate ? handleUpdateTemplate : handleCreateTemplate}
                    disabled={!templateForm.name.trim() || isTemplateContentEmpty() || savingTemplate}
                    className="flex-1 px-4 py-2.5 bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-500 hover:to-cyan-500 disabled:from-slate-600 disabled:to-slate-600 disabled:text-slate-400 text-white rounded-lg font-semibold text-sm transition-all flex items-center justify-center gap-2"
                  >
                    {savingTemplate ? (
                      <>
                        <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        儲存中……
                      </>
                    ) : (
                      editingTemplate ? '儲存變更' : '新增範本'
                    )}
                  </button>
                  {editingTemplate && (
                    <button
                      type="button"
                      onClick={() => { setEditingTemplate(null); setTemplateForm({ name: '', title: '', subtitle: '', content: '', content_type: 'richtext' }); if (templateEditorRef.current) templateEditorRef.current.innerHTML = ''; setRichCardContent(''); const rce = richCardEditorRef.current?.getEditor(); if (rce) rce.commands.setContent(''); }}
                      className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-semibold text-sm transition-all"
                    >
                      取消
                </button>
                  )}
                  </div>
                </div>
              </div>

              {/* Right: 已儲存的範本 */}
              <div className={`flex flex-col p-4 overflow-hidden ${templateForm.content_type === 'rich_card' ? 'w-[28%]' : 'w-1/2'}`}>
                {(() => {
                  const filteredTpls = messageTemplates.filter(t => templateManagerMode === 'rich_card' ? t.content_type === 'rich_card' : t.content_type !== 'rich_card');
                  return (<>
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex-shrink-0">
                  已儲存的範本 ({filteredTpls.length})
                </h4>
                {filteredTpls.length > 0 ? (
                  <div className="flex-1 overflow-y-auto space-y-2 scrollbar-dark pr-1">
                    {filteredTpls.map((tpl) => (
                      <div key={tpl.id} className={`rounded-xl border-2 p-3 transition-all cursor-pointer ${editingTemplate?.id === tpl.id ? 'border-blue-500 bg-blue-500/10 shadow-lg shadow-blue-500/10' : tpl.is_pinned ? 'bg-slate-800/80 border-teal-600/50 hover:border-teal-500/70' : 'bg-slate-800/50 border-slate-700/50 hover:border-slate-500/70 hover:bg-slate-800/70'}`}
                        onClick={async () => {
                          setEditingTemplate(tpl);
                          setTemplateForm({ name: tpl.name, title: tpl.title || '', subtitle: tpl.subtitle || '', content: '', content_type: tpl.content_type as 'text' | 'richtext' | 'rich_card' });
                          const fullContent = await fetchTemplateContent(tpl.id);
                          if (fullContent) {
                            setTemplateForm(prev => ({ ...prev, content: fullContent }));
                            if (tpl.content_type === 'rich_card') {
                              setRichCardContent(fullContent);
                              requestAnimationFrame(() => { const editor = richCardEditorRef.current?.getEditor(); if (editor) editor.commands.setContent(fullContent); });
                            } else {
                              requestAnimationFrame(() => { if (templateEditorRef.current) templateEditorRef.current.innerHTML = fullContent; });
                            }
                          }
                        }}
                      >
                        <div className="flex items-start gap-2.5">
                          <div className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center mt-0.5 ${tpl.content_type === 'rich_card' ? 'bg-blue-500/20' : 'bg-teal-500/20'}`}>
                            {tpl.content_type === 'rich_card' ? <Megaphone className="w-4 h-4 text-blue-400" /> : <FileText className="w-4 h-4 text-teal-400" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              {tpl.is_pinned && <Pin className="w-3 h-3 text-teal-400 flex-shrink-0" />}
                              <span className="text-[13px] font-semibold text-slate-100 truncate">{tpl.name}</span>
                            </div>
                            {tpl.title && templateManagerMode === 'rich_card' && (
                              <p className="text-[11px] text-slate-400 truncate mt-0.5">{tpl.title}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              type="button"
                              onClick={async (e) => {
                                e.stopPropagation();
                                setEditingTemplate(tpl);
                                setTemplateForm({ name: tpl.name, title: tpl.title || '', subtitle: tpl.subtitle || '', content: '', content_type: tpl.content_type as 'text' | 'richtext' | 'rich_card' });
                                const fullContent = await fetchTemplateContent(tpl.id);
                                if (fullContent) {
                                  setTemplateForm(prev => ({ ...prev, content: fullContent }));
                                  if (tpl.content_type === 'rich_card') {
                                    setRichCardContent(fullContent);
                                    requestAnimationFrame(() => { const editor = richCardEditorRef.current?.getEditor(); if (editor) editor.commands.setContent(fullContent); });
                                  } else {
                                    requestAnimationFrame(() => { if (templateEditorRef.current) templateEditorRef.current.innerHTML = fullContent; });
                                  }
                                }
                              }}
                              className="p-1.5 rounded-lg bg-slate-700/60 text-slate-400 hover:text-blue-400 hover:bg-blue-500/20 transition-all"
                              title="編輯"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleToggleTemplatePin(tpl); }}
                              className={`p-1.5 rounded-lg transition-all ${tpl.is_pinned ? 'bg-teal-500/20 text-teal-400 hover:text-teal-300' : 'bg-slate-700/60 text-slate-400 hover:text-teal-400 hover:bg-teal-500/20'}`}
                              title={tpl.is_pinned ? '取消置頂' : '置頂'}
                            >
                              <Pin className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setTemplateToDelete(tpl.id); }}
                              className="p-1.5 rounded-lg bg-slate-700/60 text-slate-400 hover:text-red-400 hover:bg-red-500/20 transition-all"
                              title="刪除"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center">
                    {templateManagerMode === 'rich_card' ? <Megaphone className="w-12 h-12 text-slate-700 mb-3" /> : <FileText className="w-12 h-12 text-slate-700 mb-3" />}
                    <p className="text-sm text-slate-500 font-medium">尚無範本</p>
                    <p className="text-xs text-slate-600 mt-1">使用左側編輯器建立您的第一個範本</p>
                  </div>
                )}
                </>);
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {annotationDialog && createPortal(
        <div
          role="presentation"
          className="fixed inset-0 z-[99999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
          onMouseDown={(event) => { if (event.target === event.currentTarget && !savingAnnotation) setAnnotationDialog(null); }}
          onKeyDown={(event) => { if (event.key === 'Escape' && !savingAnnotation) setAnnotationDialog(null); }}
        >
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="conversation-annotation-title"
            onSubmit={(event) => { event.preventDefault(); void saveConversationAnnotation(); }}
            className={`max-h-[calc(100dvh-2rem)] w-full max-w-md min-w-0 overflow-y-auto rounded-2xl border bg-slate-900 shadow-2xl shadow-black/50 ${annotationDialog.kind === 'note' ? 'border-sky-400/40' : 'border-amber-400/50 shadow-amber-950/35'}`}
          >
            <div className={`flex items-start justify-between gap-3 border-b px-5 py-4 ${annotationDialog.kind === 'note' ? 'border-sky-400/25 bg-gradient-to-r from-blue-950 via-slate-900 to-cyan-950/70' : 'border-amber-400/25 bg-gradient-to-r from-amber-950/90 via-slate-900 to-amber-950/60'}`}>
              <div className="flex min-w-0 items-center gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${annotationDialog.kind === 'note' ? 'border-sky-400/40 bg-sky-500/15 text-sky-300' : 'border-amber-400/40 bg-amber-500/15 text-amber-300'}`}>
                  {annotationDialog.kind === 'special' ? <Star className="h-5 w-5" /> : <Pencil className="h-5 w-5" />}
                </span>
                <div className="min-w-0">
                  <h3 id="conversation-annotation-title" className="text-base font-bold text-white">{annotationDialog.kind === 'special' ? annotationDialog.nextSpecial ? '加入特別關注' : '移除特別關注' : '編輯對話備註'}</h3>
                  <p className={`mt-0.5 text-xs ${annotationDialog.kind === 'note' ? 'text-sky-200/80' : 'text-amber-200/85'}`}>{annotationDialog.kind === 'note' ? '只記錄這段經理與員工的對話' : '請核對對話身份後確認操作'}</p>
                </div>
              </div>
              <button type="button" disabled={savingAnnotation} onClick={() => setAnnotationDialog(null)} aria-label="關閉面板" className={`shrink-0 rounded-lg p-1.5 text-slate-300 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 ${annotationDialog.kind === 'note' ? 'focus-visible:ring-sky-300' : 'focus-visible:ring-amber-300'}`}><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-4 px-5 py-5">
              <div className={`min-w-0 rounded-xl border p-4 text-sm ${annotationDialog.kind === 'note' ? 'border-sky-400/25 bg-gradient-to-br from-slate-800 to-sky-950/40' : 'border-amber-400/30 bg-gradient-to-br from-slate-800 via-slate-800 to-amber-950/40'}`}>
                <p className="font-semibold text-white">員工：{annotationDialog.history.employee_username}</p>
                <p className={`mt-1 break-all text-xs ${annotationDialog.kind === 'note' ? 'text-sky-200' : 'text-amber-200'}`}>員工編號：{annotationDialog.history.employee_number || '—'}</p>
                <p className="mt-1 break-all text-xs text-slate-400">員工 ID：{annotationDialog.history.employee_id}</p>
                <p className="mt-3 border-t border-white/10 pt-2 text-xs text-slate-200">經理：{annotationDialog.history.customer_name || '—'}（{customers.find(customer => customer.id === annotationDialog.history.customer_id)?.customer_id || annotationDialog.history.customer_id}）</p>
              </div>
              {annotationDialog.kind === 'special' ? (
                <div className="rounded-xl border border-amber-400/25 bg-amber-950/35 px-4 py-3.5 text-sm leading-relaxed text-amber-100">
                  {annotationDialog.nextSpecial ? '確認將這段對話加入特別關注？加入後可在上方集中查看。' : '確認將這段對話移出特別關注？對話備註不會被刪除。'}
                </div>
              ) : (
                <div>
                  <label htmlFor="conversation-note" className="mb-2 block text-sm font-semibold text-sky-100">此對話的獨立備註</label>
                  <textarea id="conversation-note" autoFocus rows={5} maxLength={2000} value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="輸入這段對話的備註……" className="block w-full resize-y rounded-xl border border-sky-200 bg-slate-50 p-3.5 text-sm leading-relaxed text-slate-900 shadow-inner shadow-slate-400/10 outline-none placeholder:text-slate-500 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/35" />
                  <div className="mt-2 flex items-center justify-between gap-2 text-xs text-slate-400">
                    <button type="button" onClick={() => setNoteDraft('')} disabled={savingAnnotation || !noteDraft} className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-rose-400/70 bg-rose-600 px-3 text-xs font-bold text-white shadow-sm shadow-rose-950/30 transition-colors hover:bg-rose-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 disabled:cursor-not-allowed disabled:border-rose-400/50 disabled:bg-rose-700/70 disabled:text-white disabled:shadow-none"><Trash2 className="h-3.5 w-3.5" />清空備註</button>
                    <span className="tabular-nums">{noteDraft.length}/2000</span>
                  </div>
                </div>
              )}
              <div className={`flex flex-wrap justify-end gap-2 border-t pt-4 ${annotationDialog.kind === 'note' ? 'border-white/10' : 'border-amber-400/20'}`}>
                <button type="button" disabled={savingAnnotation} onClick={() => setAnnotationDialog(null)} className="min-h-10 rounded-lg border border-slate-500 bg-slate-700 px-4 text-sm font-semibold text-white hover:bg-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:opacity-50">取消</button>
                <button type="submit" autoFocus={annotationDialog.kind === 'special'} disabled={savingAnnotation} className={`min-h-10 rounded-lg px-5 text-sm font-semibold text-white shadow-md focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 ${annotationDialog.kind === 'special' ? 'border border-amber-300/70 bg-amber-600 shadow-amber-500/25 hover:bg-amber-500 focus-visible:ring-amber-300' : 'bg-blue-600 shadow-blue-950/40 hover:bg-blue-500 focus-visible:ring-sky-300'}`}>{savingAnnotation ? '儲存中……' : annotationDialog.kind === 'note' ? '儲存備註' : annotationDialog.nextSpecial ? '確認加入' : '確認移除'}</button>
              </div>
            </div>
          </form>
        </div>,
        document.body
      )}

      {confirmDialog && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
          <section role="dialog" aria-modal="true" aria-labelledby="manager-chat-delete-title" className="w-full max-w-md overflow-hidden rounded-[1.75rem] border border-rose-300/25 bg-slate-900 text-slate-100 shadow-[0_28px_90px_rgba(2,6,23,0.8)] ring-1 ring-inset ring-white/5">
            <div className="h-1 bg-gradient-to-r from-rose-600 via-red-400 to-orange-400" />
            <header className="flex items-start gap-3 border-b border-white/10 bg-gradient-to-br from-rose-500/10 via-slate-900 to-slate-900 px-5 py-5 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-rose-300/30 bg-rose-500/15 text-rose-200"><Trash2 className="h-5 w-5" aria-hidden="true" /></div>
              <div className="min-w-0 flex-1"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-rose-300">經理頁 · 刪除確認</p><h3 id="manager-chat-delete-title" className="mt-1 text-lg font-bold tracking-tight text-white">{confirmDialog.title}</h3><p className="mt-1 text-xs text-slate-400">請確認要刪除的內容</p></div>
              <button type="button" onClick={() => setConfirmDialog(null)} disabled={confirmDeleting} aria-label="關閉刪除確認" className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"><X className="h-4 w-4" /></button>
            </header>
            <div className="space-y-4 px-5 py-5 sm:px-6">
              <p className="text-sm leading-6 text-slate-200">{confirmDialog.message}</p>
              <div className="rounded-xl border border-white/10 bg-slate-950/50 p-4"><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">刪除對象</p><p className="mt-2 text-sm font-semibold text-white">{confirmDialog.scope === 'customer' ? '此經理及其全部對話' : confirmDialog.scope === 'conversation' ? '目前整段對話' : '目前這則聊天訊息'}</p></div>
            </div>
            <footer className="grid grid-cols-2 gap-3 border-t border-white/10 bg-slate-950/40 px-5 py-4 sm:px-6">
              <button type="button" autoFocus onClick={() => setConfirmDialog(null)} disabled={confirmDeleting} className="rounded-xl border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40">取消</button>
              <button type="button" onClick={confirmDialog.onConfirm} disabled={confirmDeleting} className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-300/40 bg-gradient-to-r from-rose-600 to-red-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-rose-950/30 transition-colors hover:from-rose-500 hover:to-red-500 disabled:cursor-not-allowed disabled:opacity-50">{confirmDeleting ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />刪除中…</> : <><Trash2 className="h-4 w-4" aria-hidden="true" />確認刪除</>}</button>
            </footer>
          </section>
        </div>, document.body,
      )}

      {notification && createPortal(
        <div role={notification.type === 'error' ? 'alert' : 'status'} className={`fixed top-4 right-4 z-[100000] max-w-[calc(100vw-2rem)] px-4 py-3 rounded-xl shadow-2xl border backdrop-blur-md transition-all animate-[slideInRight_0.3s_ease-out] sm:max-w-md ${
          notification.type === 'success'
            ? 'bg-green-500/90 text-white border-green-400/50 shadow-green-500/30'
            : 'bg-red-500/90 text-white border-red-400/50 shadow-red-500/30'
        }`}>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{notification.text}</span>
            <button type="button" onClick={() => setNotification(null)} aria-label="關閉提示" className="ml-2 p-0.5 hover:bg-white/20 rounded transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>,
        document.body
      )}
      {previewImage && (
        <div
          className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/90 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) { setPreviewImage(null); setAdminImageZoom(1); setAdminImageDrag({ x: 0, y: 0 }); } }}
        >
          <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
            <button
              onClick={() => setAdminImageZoom(z => Math.max(0.5, z - 0.25))}
              className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <ZoomOut className="w-5 h-5" />
            </button>
            <span className="text-white/70 text-xs font-mono min-w-[3rem] text-center">{Math.round(adminImageZoom * 100)}%</span>
            <button
              onClick={() => setAdminImageZoom(z => Math.min(5, z + 0.25))}
              className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <ZoomIn className="w-5 h-5" />
            </button>
            <button
              onClick={() => { setAdminImageZoom(1); setAdminImageDrag({ x: 0, y: 0 }); }}
              className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <RotateCcw className="w-5 h-5" />
            </button>
            <button
              onClick={() => { setPreviewImage(null); setAdminImageZoom(1); setAdminImageDrag({ x: 0, y: 0 }); }}
              className="p-2.5 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div
            className="w-full h-full flex items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing"
            onMouseDown={(e) => { setAdminIsDragging(true); adminDragStartRef.current = { x: e.clientX, y: e.clientY, ox: adminImageDrag.x, oy: adminImageDrag.y }; }}
            onMouseMove={(e) => { if (!adminIsDragging) return; setAdminImageDrag({ x: adminDragStartRef.current.ox + e.clientX - adminDragStartRef.current.x, y: adminDragStartRef.current.oy + e.clientY - adminDragStartRef.current.y }); }}
            onMouseUp={() => setAdminIsDragging(false)}
            onMouseLeave={() => setAdminIsDragging(false)}
          >
            <img
              src={previewImage}
              alt="預覽"
              className="max-w-[85vw] max-h-[85vh] object-contain select-none"
              style={{
                transform: `scale(${adminImageZoom}) translate(${adminImageDrag.x / adminImageZoom}px, ${adminImageDrag.y / adminImageZoom}px)`,
                transition: adminIsDragging ? 'none' : 'transform 0.2s ease-out',
              }}
              draggable={false}
            />
          </div>
        </div>
      )}
      </>, document.body)}

      {templateToDelete && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setTemplateToDelete(null)}>
          <div className="bg-slate-800 rounded-xl p-6 max-w-sm w-full mx-4 border border-slate-700 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-2">刪除範本</h3>
            <p className="text-sm text-slate-400 mb-6">確定要刪除此範本嗎？此操作無法復原。</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setTemplateToDelete(null)}
                className="px-4 py-2 text-sm rounded-lg bg-slate-700 text-slate-300 hover:bg-slate-600 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => { handleDeleteTemplate(templateToDelete); setTemplateToDelete(null); }}
                className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors"
              >
                刪除
              </button>
            </div>
          </div>
        </div>
      , document.body)}
    </div>
  );
}

export default memo(CccServiceManagement);
