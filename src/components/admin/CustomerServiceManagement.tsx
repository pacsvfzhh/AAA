import { useState, useEffect, useCallback, useRef, useMemo, memo } from 'react';
import { createPortal } from 'react-dom';
import { Users, Plus, Send, Trash2, CreditCard as Edit2, User, MessageCircle, ArrowLeft, X, Search, Tag, Filter, Image, Star, Clock, Bold, Underline, Strikethrough, Pencil, Check, Gift, DollarSign, MessageSquarePlus, FileText, BookOpen, Highlighter, Pin, Upload, Zap, CheckCheck, Eye, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import { fetchAdminChatUnreadCounts, fetchConversationSummaryRows, getCachedAdminWorkspaceData, getCachedConversationSummaries, invalidateAdminWorkspaceDataCache, invalidateConversationSummariesCache, prefetchAdminGroups, prefetchAdminWorkspaceData, prefetchConversationSummaries } from '../../lib/serviceWorkspaceCache';
import { uniqueRealtimeChannelName } from '../../lib/realtimeChannel';
import { stripTailwindStyles, sanitizeChatMessage } from '../../lib/sanitizeHTML';
import AdminGroupPicker, { type AdminGroup } from './AdminGroupPicker';
import CustomerAvatarPicker, { CustomerAvatarDisplay } from './CustomerAvatarPicker';
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
}

type CustomerBadgeType = NonNullable<SimulatedCustomer['badge_type']>;
type ConversationSummaryRow = Database['public']['Functions']['get_ccc_conversation_summaries']['Returns'][number];
type SimulatedCustomerInsert = Omit<Database['public']['Tables']['simulated_customers']['Insert'], 'customer_id'> & {
  customer_id?: string;
};
type SimulatedCustomerUpdate = Database['public']['Tables']['simulated_customers']['Update'];

function getCustomerServiceErrorMessage(error: unknown, fallback: string) {
  const message = formatSupabaseError(error);
  return message && message !== 'undefined' ? message : fallback;
}

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
  content: string;
  content_type: 'text' | 'richtext' | 'rich_card';
  sort_order: number;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

interface CustomerServiceManagementProps {
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

function CustomerServiceManagement({ adminId, isSuperAdmin, isActive, initialEmployee, onConsumeInitialEmployee, onUnreadCountChange }: CustomerServiceManagementProps) {
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
    remarks: ''
  });
  const [editingCustomer, setEditingCustomer] = useState<SimulatedCustomer | null>(null);
  const [savingCustomer, setSavingCustomer] = useState(false);
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
  const [fromHistoryFilterMode, setFromHistoryFilterMode] = useState<'all' | 'history' | 'new'>('all');
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
  const [historyFilterMode, setHistoryFilterMode] = useState<'all' | 'history' | 'new'>('all');
  const [historySearchQuery, setHistorySearchQuery] = useState('');
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
  const [templateForm, setTemplateForm] = useState({ name: '', content: '', content_type: 'richtext' as 'text' | 'richtext' | 'rich_card' });
  const templateEditorRef = useRef<HTMLDivElement>(null);
  const templateImageInputRef = useRef<HTMLInputElement>(null);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [uploadingTemplateImage, setUploadingTemplateImage] = useState(false);
  const [templateBoldActive, setTemplateBoldActive] = useState(false);
  const [templateUnderlineActive, setTemplateUnderlineActive] = useState(false);
  const [templateFontSize, setTemplateFontSize] = useState<string | null>(null);

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
  const workspaceConversationHistory = useMemo(
    () => dedupeConversationHistory(allConversationHistory.filter(history =>
      Boolean(history.customer_id) &&
      workspaceCustomerIds.has(history.customer_id!)
    )),
    [allConversationHistory, workspaceCustomerIds],
  );
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
        if (historyFilterMode === 'new' && history.unread_count <= 0) return false;
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
  }, [conversationHistoryForView, workspaceEmployeesById, historyFilterMode, historySearchQuery, historyScope, selectedCustomer?.id, selectedEmployee]);

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
    if (message.source_type && message.source_type !== 'aaa_service') return;
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
        employee_username: existing?.employee_username || employee?.username || '員工',
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
      const { countsByAdmin } = await fetchAdminChatUnreadCounts('customer');
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

      const data = await prefetchAdminGroups(adminId, 'customer', force);
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
      const rows = await fetchConversationSummaryRows(customer.admin_id, 'customer', customer.id);

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
        'customer',
        () => fetchConversationSummaryRows(adminIdToUse, 'customer'),
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
        .eq('simulated_customers.source_type', 'aaa_service')
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
      .eq('simulated_customers.source_type', 'aaa_service')
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
        .eq('simulated_customers.source_type', 'aaa_service')
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
      console.log('[CustomerService] Tab became active, resetting to first panel');
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

    const cachedWorkspace = getCachedAdminWorkspaceData<SimulatedCustomer, Employee>(initialEmployee.adminId, 'customer');
    const cachedSummaries = getCachedConversationSummaries<ConversationSummaryRow>(initialEmployee.adminId, 'customer');
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
      void loadAllConversationHistory(true);
    }
  }, [isActive, loading, selectedAdminId, customers.length, employees.length, selectedCustomer, selectedEmployee, showHistoryView, historyScope, loadAllConversationHistory]);

  // Subscribe to realtime updates for admins table
  useEffect(() => {
    if (isSuperAdmin) {
      const channel = supabase
        .channel(uniqueRealtimeChannelName('customer_service_admins_realtime'))
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
      .channel(uniqueRealtimeChannelName('customer_service_workspace_summary_realtime'))
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
        .channel(uniqueRealtimeChannelName('customer_service_admin_unread_counts_realtime'))
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'customer_employee_conversations'
        }, () => {
          adminIds.forEach(id => invalidateConversationSummariesCache(id, 'customer'));
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
      .channel(uniqueRealtimeChannelName(`customer_service_conversations_${selectedCustomer.id}`))
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
          void loadAllConversationHistory(true);
        }, 120);
      };
      const fallbackTimer = window.setInterval(() => {
        void loadAllConversationHistory(true);
      }, 15000);
      const channel = supabase
        .channel(uniqueRealtimeChannelName(`customer_service_unread_counts_${selectedAdminId}`))
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
        .channel(uniqueRealtimeChannelName(`customer_service_employees_realtime_${selectedAdminId}`))
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
          invalidateAdminWorkspaceDataCache(targetAdminId, 'customer');
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
                  void loadAllConversationHistory(true);
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
    if (!selectedCustomer || !selectedEmployee) return;

    try {
      const { data, error } = await supabase
        .from('customer_employee_conversations')
        .select('*')
        .eq('customer_id', selectedCustomer.id)
        .eq('employee_id', selectedEmployee.id)
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
  }, [selectedCustomer, selectedEmployee]);

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

  useEffect(() => {
    if (messages.length > 0) {
      if (isInitialLoadRef.current) {
        isInitialLoadRef.current = false;
      }
    }
  }, [messages]);

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
          source_type: 'aaa_service',
        });

      if (error) throw error;

      setNotification({ type: 'success', text: '評分已成功提交！' });
      setShowRatingModal(false);
      setRatingValue(0);
      setRatingComment('');
      setPendingRating(null);
      loadMessages();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '提交評分失敗') });
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
          p_source_type: 'aaa_service',
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
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '送出打賞失敗') });
    } finally {
      setSendingTip(false);
    }
  };

  const loadTemplates = useCallback(async () => {
    if (!selectedAdminId) return;
    try {
      const { data, error } = await supabase
        .from('cs_message_templates')
        .select('*')
        .eq('admin_id', selectedAdminId)
        .eq('source_type', 'aaa_service')
        .order('is_pinned', { ascending: false })
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false });
      if (error) throw error;
      setMessageTemplates(data || []);
    } catch (error) {
      console.error('Error loading templates:', formatSupabaseError(error));
    }
  }, [selectedAdminId]);

  const getTemplateContent = (): string => {
    if (templateForm.content_type === 'richtext' && templateEditorRef.current) {
      return stripTailwindStyles(templateEditorRef.current.innerHTML);
    }
    return templateForm.content;
  };

  const isTemplateContentEmpty = (): boolean => {
    if (templateForm.content_type === 'richtext' && templateEditorRef.current) {
      const hasText = (templateEditorRef.current.textContent || '').trim().length > 0;
      const hasImages = templateEditorRef.current.querySelectorAll('img').length > 0;
      return !hasText && !hasImages;
    }
    return !templateForm.content.trim();
  };

  const handleCreateTemplate = async () => {
    if (!selectedAdminId || !templateForm.name.trim()) return;
    const content = getTemplateContent();
    if (isTemplateContentEmpty()) return;
    try {
      const { error } = await supabase
        .from('cs_message_templates')
        .insert({
          admin_id: selectedAdminId,
          name: templateForm.name.trim(),
          content: templateForm.content_type === 'richtext' ? content : content.trim(),
          content_type: templateForm.content_type,
          sort_order: messageTemplates.length,
          source_type: 'aaa_service',
        });
      if (error) throw error;
      setTemplateForm({ name: '', content: '', content_type: 'richtext' });
      if (templateEditorRef.current) templateEditorRef.current.innerHTML = '';
      setNotification({ type: 'success', text: '範本已建立！' });
      loadTemplates();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '建立範本失敗') });
    }
  };

  const handleUpdateTemplate = async () => {
    if (!editingTemplate || !templateForm.name.trim()) return;
    const content = getTemplateContent();
    if (isTemplateContentEmpty()) return;
    try {
      await mutateAuditedContent('template_edit', [editingTemplate.id], {
        name: templateForm.name.trim(),
        content: templateForm.content_type === 'richtext' ? content : content.trim(),
        content_type: templateForm.content_type,
      });
      setEditingTemplate(null);
      setTemplateForm({ name: '', content: '', content_type: 'richtext' });
      if (templateEditorRef.current) templateEditorRef.current.innerHTML = '';
      setNotification({ type: 'success', text: '範本已更新！' });
      loadTemplates();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '更新範本失敗') });
    }
  };

  const handleDeleteTemplate = async (id: string) => {
    try {
      await mutateAuditedContent('template_delete', [id]);
      setNotification({ type: 'success', text: '刪除成功' });
      loadTemplates();
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '刪除範本失敗') });
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
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '更新置頂狀態失敗') });
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
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '圖片上傳失敗') });
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
        const mammoth = await import('mammoth');
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.convertToHtml({ arrayBuffer });
        if (templateEditorRef.current) {
          templateEditorRef.current.innerHTML = result.value;
          setTemplateForm(prev => ({ ...prev, content: result.value, content_type: 'richtext' }));
        }
      } else {
        setNotification({ type: 'error', text: 'Unsupported file type. Use .txt or .docx files.' });
      }
    } catch (error: unknown) {
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, 'Failed to import file') });
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
        'customer',
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
    void prefetchAdminWorkspaceData(group.admin_id, 'customer').catch(() => undefined);
    void prefetchConversationSummaries(group.admin_id, 'customer', () => (
      fetchConversationSummaryRows(group.admin_id, 'customer')
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
    historyScrollTopRef.current = 0;

    const cachedWorkspace = getCachedAdminWorkspaceData<SimulatedCustomer, Employee>(group.admin_id, 'customer');
    const cachedSummaries = getCachedConversationSummaries<ConversationSummaryRow>(group.admin_id, 'customer');

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
    setConversationHistory([]);
    setAllConversationHistory([]);
    conversationHistoryRef.current = [];
    allConversationHistoryRef.current = [];
    historyScrollTopRef.current = 0;
    setCustomers([]);
    setEmployees([]);
    void loadAdminGroups(null, true, true);
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
        setNotification({ type: 'error', text: '請輸入客戶名稱' });
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
          .eq('source_type', 'aaa_service')
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
        source_type: 'aaa_service',
      };

      if (customId) {
        insertData.customer_id = customId;
      }

      const { error } = await supabase
        .from('simulated_customers')
        .insert(insertData as Database['public']['Tables']['simulated_customers']['Insert']);

      if (error) throw error;

      setNotification({ type: 'success', text: '客戶已成功建立！' });
      setShowCustomerForm(false);
      setEditingCustomer(null);
      setCustomerForm({ name: '', avatar: 'customer-avatar:regular:0', isSuper: false, superTitle: '', customId: '', badgeType: '', vipLabel: 'VIP', customAvatarFile: null, useCustomAvatar: false, remarks: '' });
      loadAdminData(selectedAdminId, true, true);
    } catch (error: unknown) {
      const errorMessage = getCustomerServiceErrorMessage(error, '建立客戶失敗');
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
        setNotification({ type: 'error', text: '請輸入客戶名稱' });
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

      setNotification({ type: 'success', text: '客戶已成功更新！' });
      setEditingCustomer(null);
      setCustomerForm({ name: '', avatar: 'customer-avatar:regular:0', isSuper: false, superTitle: '', customId: '', badgeType: '', vipLabel: 'VIP', customAvatarFile: null, useCustomAvatar: false, remarks: '' });
      loadAdminData(selectedAdminId, true, true);
    } catch (error: unknown) {
      const errorMessage = getCustomerServiceErrorMessage(error, '更新客戶失敗');
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
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '更新置頂狀態失敗') });
    }
  };

  const handleDeleteCustomer = async (customerId: string) => {
    const customerToDelete = customers.find(c => c.id === customerId);

    setConfirmDialog({
      show: true,
      title: '刪除客戶',
      message: `確定刪除客戶「${customerToDelete?.customer_name || '此客戶'}」及其所有對話嗎？`,
      scope: 'customer',
      onConfirm: async () => {
        setConfirmDeleting(true);
        try {
          await mutateAuditedContent('customer_delete', [customerId]);

          invalidateAdminWorkspaceDataCache(selectedAdminId || adminId, 'customer');
          if (selectedCustomer?.id === customerId) {
            setSelectedCustomer(null);
            setSelectedEmployee(null);
          }
          setCustomers(prev => prev.filter(c => c.id !== customerId));
          setNotification({ type: 'success', text: '客戶及其對話已刪除。' });
        } catch {
          setNotification({ type: 'error', text: '刪除客戶未完成，請重新整理後核對。' });
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
          source_type: 'aaa_service',
        });

      if (insertError) throw insertError;

      setUploadProgress(100);
      uploadingTempIdRef.current = null;
      setUploadingImage(false);
      setUploadProgress(0);
      void loadConversationHistory();
    } catch (error: unknown) {
      pendingImageMessagesRef.current.delete(tempId);
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '圖片上傳失敗') });
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
    if (msg.message_type === 'image' && msg.image_url) {
      const isUploading = uploadingImage && uploadingTempIdRef.current === msg.id;
      return (
        <div className="relative inline-flex w-fit max-w-full flex-col overflow-hidden rounded-lg" style={{ width: 'fit-content', height: 'fit-content', maxWidth: '200px', backgroundColor: 'transparent' }}>
          <img
            src={msg.image_url}
            alt="分享的圖片"
            className="block rounded-lg object-contain cursor-pointer hover:opacity-90 transition-opacity shadow-sm"
            style={{ width: 'auto', height: 'auto', maxWidth: '200px', maxHeight: '250px' }}
            loading="lazy"
            onClick={(e: React.MouseEvent) => { if (!isUploading) { e.stopPropagation(); e.preventDefault(); setPreviewImage(msg.image_url || null); setAdminImageZoom(1); setAdminImageDrag({ x: 0, y: 0 }); } }}
          />
          {isUploading && (
            <div className="absolute inset-0 bg-black/20 backdrop-blur-[1px] flex flex-col items-center justify-center rounded-lg z-10">
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

    if (msg.message_type === 'tip' && msg.rating_data) {
      const tipAmt = msg.rating_data.tip_amount || 0;
      return (
        <div className="my-2">
          <div className="w-[232px] overflow-hidden rounded-2xl border border-amber-300/45 bg-gradient-to-br from-amber-300/80 via-orange-400 to-amber-700 p-px shadow-xl shadow-amber-950/35">
            <div className="relative overflow-hidden rounded-[15px] bg-gradient-to-br from-amber-950 via-orange-900 to-amber-950 px-4 py-3.5">
              <div className="absolute -right-8 -top-10 h-28 w-28 rounded-full bg-amber-300/15 blur-2xl" />
              <div className="absolute -bottom-10 -left-8 h-24 w-24 rounded-full bg-orange-300/10 blur-2xl" />
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
                  <p className="mt-1 text-[10px] font-medium text-amber-100/75">服務感謝</p>
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
        <div className="relative inline-flex w-fit max-w-full flex-col overflow-hidden rounded-lg" style={{ width: 'fit-content', height: 'fit-content', maxWidth: '200px', backgroundColor: 'transparent' }}>
          <img
            src={imageOnlyUrl}
            alt="分享的圖片"
            className="block rounded-lg object-contain cursor-pointer hover:opacity-90 transition-opacity shadow-sm"
            style={{ width: 'auto', height: 'auto', maxWidth: '200px', maxHeight: '250px' }}
            loading="lazy"
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); setPreviewImage(imageOnlyUrl); setAdminImageZoom(1); setAdminImageDrag({ x: 0, y: 0 }); }}
          />
        </div>
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
          source_type: 'aaa_service',
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
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '訊息傳送失敗') });
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
        } catch (error: unknown) {
          console.error('Delete failed:', formatSupabaseError(error));
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
    if (!file.type.startsWith('image/')) {
      setNotification({ type: 'error', text: '請選擇圖片檔案' });
      return;
    }
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
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '替換圖片失敗') });
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
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '更新訊息失敗') });
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
      setNotification({ type: 'error', text: getCustomerServiceErrorMessage(error, '圖片上傳失敗') });
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
        service="customer"
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
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-orange-300/30 bg-orange-400/15 shadow-[0_0_30px_rgba(251,146,60,0.14)]">
          <span className="absolute inset-1 animate-ping rounded-xl border border-orange-300/25 [animation-duration:1.6s]" />
          <span className="relative h-8 w-8 animate-spin rounded-full border-[3px] border-orange-300/25 border-t-orange-300" />
        </div>
        <div>
          <p className="text-sm font-semibold text-orange-100">正在載入模擬客戶工作區</p>
          <p className="mt-1 text-[11px] text-slate-500">正在同步角色與會話資料，請稍候……</p>
        </div>
      </div>
    );
  }

  if (isSuperAdmin && !selectedAdminId && !initialEmployee) {
    return (
      <AdminGroupPicker
        service="customer"
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
    <div ref={containerRef} className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden px-2 pb-2 pt-3 sm:px-3 sm:pb-3 sm:pt-4">
      {/* Info Bar + History/New Buttons in one row */}
      <div className="flex min-h-10 min-w-0 flex-shrink-0 flex-wrap items-center gap-2">
        {isSuperAdmin && selectedAdminId && (
          <button
            type="button"
            onClick={handleBackToGroups}
            className="flex items-center gap-1.5 px-3 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded-lg transition-colors text-xs font-medium flex-shrink-0 border border-orange-300/70 shadow-md shadow-orange-600/30"
          >
            <ArrowLeft className="w-4 h-4" />
            返回
          </button>
        )}
        {isSuperAdmin && selectedAdminId && (
          <div className="flex items-center gap-2 px-3 h-10 bg-orange-950/50 border border-orange-400/50 rounded-lg flex-shrink-0">
            <div className="w-2 h-2 bg-green-500 rounded-full  flex-shrink-0"></div>
            <span className="text-[10px] font-bold text-orange-200 uppercase tracking-wider flex-shrink-0">管理中</span>
            <div className="h-4 w-px bg-orange-400/40 flex-shrink-0"></div>
            <div className="p-1 bg-gradient-to-br from-orange-500 to-amber-500 rounded flex-shrink-0">
              <User className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm font-bold text-white truncate">{selectedAdminName}</span>
          </div>
        )}
        {selectedEmployee && (
          <div className="flex items-center gap-2 px-3 h-10 bg-orange-700 border border-orange-400/70 rounded-lg flex-shrink-0">
            <div className="w-7 h-7 bg-orange-100 rounded-md flex items-center justify-center flex-shrink-0">
              <MessageCircle className="w-3.5 h-3.5 text-orange-700" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-white leading-none truncate" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>{selectedEmployee?.username} <span className="text-[10px] font-medium text-orange-100">編號： {selectedEmployee?.employee_id}</span></div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedEmployee(null)}
              className="ml-1 p-1 hover:bg-orange-800 rounded-md transition-colors text-orange-100 hover:text-white"
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
                  onClick={() => { setSelectedEmployee(null); setSelectedCustomer(null); setShowHistoryView(true); setHistoryFilterMode('all'); setHistoryScope('all'); historyScrollTopRef.current = 0; void loadAllConversationHistory(true); }}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all border-2 ${
                    showHistoryView && historyScope === 'all' && historyFilterMode !== 'new'
                      ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/40 border-orange-300'
                      : 'bg-orange-950/50 hover:bg-orange-800/50 border-orange-500/50 hover:border-orange-300/70 text-orange-200 hover:text-orange-100 shadow-lg shadow-orange-950/30 hover:shadow-orange-900/40'
                  }`}
                >
                  <Clock className="w-4 h-4" />
                  <span>全部歷史</span>
                  {workspaceConversationHistory.length > 0 && (
                    <span className={`ml-1 px-2 py-0.5 rounded-full text-xs font-black min-w-[24px] text-center ${
                      showHistoryView && historyScope === 'all' && historyFilterMode !== 'new'
                        ? 'bg-white text-orange-700'
                        : 'bg-orange-500 text-white'
                    }`}>{workspaceConversationHistory.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedEmployee(null); setSelectedCustomer(null); setShowHistoryView(true); setHistoryFilterMode('new'); setHistoryScope('all'); historyScrollTopRef.current = 0; void loadAllConversationHistory(true); }}
                  className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all border-2 ${
                    totalUnread > 0
                      ? `${showHistoryView && historyScope === 'all' && historyFilterMode === 'new'
                        ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/40 border-orange-300'
                        : 'bg-orange-950/50 hover:bg-orange-800/50 border-orange-500/50 hover:border-orange-300/70 text-orange-200 hover:text-orange-100 shadow-lg shadow-orange-950/30 hover:shadow-orange-900/40'}`
                      : showHistoryView && historyScope === 'all' && historyFilterMode === 'new'
                        ? 'bg-orange-600 text-white shadow-lg shadow-orange-500/40 border-orange-300'
                        : 'bg-orange-950/50 hover:bg-orange-800/50 border-orange-500/50 hover:border-orange-300/70 text-orange-200 hover:text-orange-100 shadow-lg shadow-orange-950/30 hover:shadow-orange-900/40'
                  }`}
                >
                  <MessageSquarePlus className="w-4 h-4" />
                  <span>全部新訊息</span>
                  {totalUnread > 0 && (
                    <span className={`ml-1 px-2 py-0.5 rounded-full text-xs font-black min-w-[24px] text-center ${
                      showHistoryView && historyScope === 'all' && historyFilterMode === 'new'
                        ? 'bg-white text-orange-700'
                        : 'bg-orange-500 text-white'
                    }`}>{totalUnread}</span>
                  )}
                  {totalUnread > 0 && !(showHistoryView && historyScope === 'all' && historyFilterMode === 'new') && (
                    <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-orange-500 rounded-full "></span>
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
        <div className="flex h-[260px] w-full flex-shrink-0 flex-col overflow-hidden rounded-2xl border border-orange-300/30 bg-gradient-to-b from-slate-900 via-slate-900/95 to-orange-950/35 shadow-2xl shadow-orange-950/25 ring-1 ring-white/[0.03] backdrop-blur-xl lg:h-auto lg:w-[clamp(13rem,20vw,18rem)]">
          {/* Sidebar Header */}
          <div className="border-b border-orange-300/20 bg-gradient-to-r from-orange-500/10 via-slate-800/70 to-transparent p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="flex items-center gap-1.5 text-xs font-black uppercase tracking-[0.12em] text-orange-50">
                <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-orange-300/30 bg-orange-500/15 shadow-sm shadow-orange-950/20">
                  <Users className="h-3.5 w-3.5 text-orange-200" />
                </span>
                客戶
              </h3>
              <button
                type="button"
                onClick={() => setShowCustomerForm(!showCustomerForm)}
                className="flex h-7 w-7 items-center justify-center rounded-lg border border-orange-200/30 bg-orange-500/80 text-white shadow-md shadow-orange-950/30 transition-all duration-200 hover:-translate-y-0.5 hover:border-orange-100/70 hover:bg-orange-400 hover:shadow-lg hover:shadow-orange-950/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-200/70"
              >
                <Plus className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex gap-1 rounded-xl border border-white/[0.06] bg-slate-950/60 p-1 shadow-inner shadow-black/20">
              <button
                onClick={() => setCustomerFilter('all')}
                className={`flex-1 px-2 py-1.5 text-[10px] font-bold rounded-md transition-all duration-200 flex items-center justify-center gap-1 ${
                  customerFilter === 'all'
                    ? 'bg-orange-500/90 text-white shadow-md shadow-orange-950/35 ring-1 ring-orange-200/30'
                    : 'text-slate-400 hover:bg-orange-500/10 hover:text-orange-100'
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
                    ? 'bg-emerald-500/90 text-white shadow-md shadow-emerald-950/35 ring-1 ring-emerald-200/30'
                    : 'text-slate-400 hover:bg-emerald-500/10 hover:text-emerald-100'
                }`}
              >
                一般
              </button>
            </div>
          </div>

          {/* Customer List - Scrollable */}
          <div className="flex-1 overflow-y-auto bg-gradient-to-b from-slate-950/20 via-transparent to-orange-950/10 p-2.5 space-y-1.5 scrollbar-dark">
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
                className={`group relative cursor-pointer rounded-xl transition-all duration-200 hover:-translate-y-px focus-within:ring-2 focus-within:ring-orange-300/60 ${
                  customer.is_super
                    ? selectedCustomer?.id === customer.id
                      ? 'border border-amber-200/80 bg-gradient-to-br from-amber-500 via-orange-500 to-amber-600 p-3.5 shadow-xl shadow-amber-950/40 ring-1 ring-amber-100/30'
                      : 'border border-amber-400/35 bg-gradient-to-br from-slate-800/95 to-amber-950/35 p-3 shadow-md shadow-amber-950/20 hover:border-amber-300/75 hover:shadow-lg hover:shadow-amber-950/35'
                    : selectedCustomer?.id === customer.id
                      ? 'border border-orange-200/80 bg-gradient-to-r from-orange-600 via-orange-500 to-amber-500 p-2.5 shadow-xl shadow-orange-950/40 ring-1 ring-orange-100/30'
                      : 'border border-slate-700/60 bg-slate-800/55 p-2 hover:border-orange-300/65 hover:bg-orange-950/35 hover:shadow-lg hover:shadow-orange-950/35'
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
                    <div className="absolute -top-2 -right-2 min-w-[22px] h-[22px] px-1.5 bg-orange-500 rounded-full flex items-center justify-center z-20 shadow-lg shadow-orange-500/40 ring-2 ring-slate-900/80">
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
                          remarks: customer.remarks || ''
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
                <p className="text-[10px]">尚無客戶</p>
              </div>
            )}
          </div>
        </div>

        {/* Middle: Employee List */}
        <div className="flex h-[240px] w-full flex-shrink-0 flex-col overflow-hidden rounded-xl border border-orange-400/30 bg-gradient-to-b from-orange-950/25 via-slate-900/90 to-slate-950/80 shadow-xl shadow-orange-950/20 backdrop-blur-xl lg:h-auto lg:w-[clamp(11rem,17vw,16rem)]">
          {/* Employee Header */}
          <div className="p-2 border-b border-orange-500/40 bg-slate-800/60 space-y-1.5">
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
                    className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md border border-orange-300/60 bg-orange-700/80 text-orange-50 shadow-sm transition-colors hover:bg-orange-600 hover:text-white"
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
                    className={`relative flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-xs font-bold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70 ${selectedTags.length > 0 ? 'border-orange-300/70 bg-orange-500/25 text-orange-50 shadow-md shadow-orange-950/30' : 'border-orange-300/30 bg-slate-900/55 text-orange-200 hover:border-orange-200/70 hover:bg-orange-500/15 hover:text-orange-100'}`}
                    title="依標籤篩選"
                  >
                    <Tag className="w-3.5 h-3.5" />
                    {selectedTags.length > 0 && (
                      <span className="flex h-4 min-w-[18px] items-center justify-center rounded-md border border-orange-200/30 bg-orange-300 px-1 text-[9px] font-black text-orange-950 shadow-sm">{selectedTags.length}</span>
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
                      <div className="absolute right-0 top-full z-30 mt-2 min-w-[180px] max-h-56 overflow-y-auto rounded-2xl border border-orange-300/35 bg-slate-900 p-2 shadow-2xl shadow-orange-950/35 ring-1 ring-orange-200/10 scrollbar-dark">
                        {allTags.map((tag) => {
                          const isSelected = selectedTags.includes(tag);
                          return (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => isSelected ? setSelectedTags(selectedTags.filter(t => t !== tag)) : setSelectedTags([...selectedTags, tag])}
                              className={`flex w-full cursor-pointer items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-xs font-semibold transition-all duration-200 mb-1 last:mb-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70 ${
                                isSelected
                                  ? 'border-orange-300/45 bg-orange-500/20 text-orange-50 shadow-sm shadow-orange-950/25'
                                  : 'border-transparent bg-transparent text-slate-300 hover:border-orange-300/20 hover:bg-orange-500/10 hover:text-orange-100'
                              }`}
                            >
                              <span className={`w-3.5 h-3.5 rounded flex items-center justify-center flex-shrink-0 border transition-colors ${
                                isSelected
                                  ? 'border-orange-100 bg-orange-100'
                                  : 'border-orange-300/40 bg-white'
                              }`}>
                                {isSelected && <Check className="h-2.5 w-2.5 text-orange-600" />}
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
              <span className="text-[10px] font-bold text-orange-300 tabular-nums flex-shrink-0">{filteredEmployees.length}<span className="text-orange-500/70">/{employees.length}</span></span>
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
                    className={`group relative min-h-[72px] w-full rounded-xl border px-2 py-2 text-left transition-all duration-200 hover:-translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70 ${
                      selectedEmployee?.id === emp.id
                        ? 'border-orange-200/70 bg-gradient-to-r from-orange-600 via-orange-500 to-amber-500 shadow-lg shadow-orange-950/40 ring-1 ring-orange-200/40'
                        : 'border-slate-700/60 bg-slate-800/45 hover:border-orange-400/60 hover:bg-orange-950/45 hover:shadow-md hover:shadow-orange-950/35'
                    }`}
                  >
                    <div className={`flex min-w-0 items-center pr-1 ${selectedEmployee?.id === emp.id ? 'gap-2' : 'gap-1.5'}`}>
                      <div className="relative flex-shrink-0">
                        <div className={`rounded flex items-center justify-center ${
                          selectedEmployee?.id === emp.id ? 'h-9 w-9 bg-white/15 ring-1 ring-white/25' : 'h-7 w-7 border border-slate-700/70 bg-slate-900/70 group-hover:border-orange-400/50 group-hover:bg-orange-950/40'
                        }`}>
                          <User className={`${selectedEmployee?.id === emp.id ? 'h-4 w-4' : 'h-3 w-3'} ${selectedEmployee?.id === emp.id ? 'text-white' : 'text-slate-400 group-hover:text-orange-200'}`} />
                        </div>
                      </div>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex min-w-0 items-center gap-1 leading-4">
                          <span className={`truncate font-bold leading-4 ${selectedEmployee?.id === emp.id ? 'text-[15px] text-white' : 'text-[11px] text-slate-200'}`} style={selectedEmployee?.id === emp.id ? { textShadow: '0 2px 6px rgba(0,0,0,0.5), 0 1px 2px rgba(0,0,0,0.3)' } : undefined}>{emp.username}</span>
                          {selectedEmployee?.id === emp.id && <span className="ml-auto flex-shrink-0 rounded bg-white/25 px-1.5 py-0.5 text-[9px] font-bold leading-relaxed text-white" style={{ textShadow: '0 1px 2px rgba(0,0,0,0.3)' }}>啟用中</span>}
                        </div>
                        <div className={`truncate font-mono leading-3 ${selectedEmployee?.id === emp.id ? 'text-[11px] text-orange-100' : 'text-[10px] text-slate-400 group-hover:text-orange-200/80'}`} style={selectedEmployee?.id === emp.id ? { textShadow: '0 2px 4px rgba(0,0,0,0.45), 0 1px 1px rgba(0,0,0,0.25)' } : undefined}>編號： {emp.employee_id || '—'}</div>
                        <EmployeeMetadataPopover
                          kind="tag"
                          theme="orange"
                          values={emp.tags}
                          selected={selectedEmployee?.id === emp.id}
                          className="w-full max-w-full leading-3"
                        />
                        <EmployeeMetadataPopover
                          kind="note"
                          theme="orange"
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
          <div className="relative flex min-h-[420px] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-orange-400/30 bg-slate-950/75 shadow-2xl shadow-orange-950/15 backdrop-blur-xl">
          {/* History / Sessions Panel */}
          <div className={`absolute inset-0 ${
            showHistoryView || (selectedCustomer && !selectedEmployee)
              ? 'opacity-100 translate-y-0 z-10 pointer-events-auto'
              : 'opacity-0 translate-y-2 z-0 pointer-events-none'
          }`}>
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-orange-400/35 bg-gradient-to-b from-orange-950/20 via-slate-900/90 to-slate-950/95 shadow-2xl shadow-orange-950/20 backdrop-blur-xl">
              {/* Active Sessions Header */}
              <div className="flex h-[72px] min-h-[72px] shrink-0 items-center overflow-hidden border-b border-orange-400/35 bg-gradient-to-r from-slate-900 via-slate-800/95 to-orange-950/25 px-3 py-2">
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
                      <h3 className="text-base font-bold text-white leading-tight truncate">{selectedCustomer ? selectedCustomer.customer_name : '進行中的工作階段'}</h3>
                      {selectedCustomer?.is_super && selectedCustomer?.super_customer_title ? (
                        <p className="text-[11px] text-amber-400 font-medium leading-tight mt-0.5 truncate">{selectedCustomer?.super_customer_title}</p>
                      ) : null}
                      <p className="text-[11px] text-emerald-400 font-mono leading-tight mt-0.5">{selectedCustomer ? `CUS-${selectedCustomer.customer_id}` : '選擇對話以繼續'}</p>
                    </div>
                  </div>
                  <div className="flex min-w-0 max-w-[58%] items-center gap-1">
                    <div className="relative min-w-0 flex-1 basis-[120px]">
                      <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-orange-300/90" />
                      <input
                        type="text"
                        value={historySearchQuery}
                        onChange={(event) => setHistorySearchQuery(event.target.value)}
                        placeholder="搜尋工作階段……"
                        aria-label="搜尋進行中的工作階段"
                        className="h-8 w-full min-w-0 rounded-lg border border-orange-700/80 bg-slate-700/90 pl-7 pr-7 text-[10px] font-semibold text-slate-100 outline-none transition-colors placeholder:text-slate-400 focus:border-orange-400/80 focus:bg-slate-700 focus:ring-2 focus:ring-orange-400/30"
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
                          className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md border border-slate-400/60 bg-slate-800 text-slate-100 shadow-sm transition-colors hover:border-orange-300/80 hover:bg-orange-700/80 hover:text-white"
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
                {visibleConversationHistory.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-slate-400">
                    <MessageCircle className="w-16 h-16 mb-4 opacity-50" />
                    <p>沒有進行中的工作階段</p>
                    <p className="text-xs mt-2">開始對話後會顯示在這裡</p>
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
                        const lastTime = new Date(history.last_message_time);
                        const timeStr = `${lastTime.getFullYear()}/${String(lastTime.getMonth() + 1).padStart(2, '0')}/${String(lastTime.getDate()).padStart(2, '0')} ${lastTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
                        const hasUnread = history.unread_count > 0;
                        const employeeTags = employee?.tags?.length
                          ? employee.tags
                          : history.employee_tags || [];
                        const employeeNote = employee?.remarks?.trim()
                          || history.employee_remarks?.trim()
                          || '';
                        const hasImg = /<img\s/i.test(history.last_message);
                        const plainMessage = history.last_message.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
                        const isPhoto = history.last_message === '__IMAGE__' || (!plainMessage && hasImg);
                        return (
                          <div key={cardKey} className="relative">
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
                                      customer_name: history.customer_name || '客戶',
                                      customer_id: history.customer_id,
                                      customer_avatar: history.customer_avatar || 'customer-avatar:regular:0',
                                      is_active: true,
                                      created_at: history.last_message_time || new Date().toISOString(),
                                      is_super: history.customer_avatar?.startsWith('customer-avatar:vip:') || false,
                                      custom_avatar_url: history.custom_avatar_url,
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
                              className={`w-full px-3 py-2.5 rounded-lg text-left group relative ${
                                isSelected
                                  ? 'bg-orange-500/20 border border-orange-300/70 shadow-md shadow-orange-500/20 ring-2 ring-orange-200/35'
                                  : hasUnread
                                    ? 'bg-gradient-to-r from-orange-950/40 to-amber-950/25 border border-orange-400/60 hover:bg-orange-900/60 hover:ring-2 hover:ring-orange-200/55 shadow-sm shadow-orange-500/20'
                                    : 'bg-slate-800/30 hover:bg-orange-900/55 hover:ring-2 hover:ring-orange-300/50 border border-slate-700/40'
                              }`}
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
                                        alt={history.customer_name || '客戶頭像'}
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
                                    </div>
                                    <span className={`text-[10px] flex-shrink-0 tabular-nums whitespace-nowrap ${
                                      hasUnread ? 'text-orange-300 font-bold' : 'text-orange-200/90 font-semibold'
                                    }`}>{timeStr}</span>
                                  </div>
                                  {hasUnread && (
                                    <div className="absolute right-3 top-1/2 z-10 flex min-w-[30px] h-[30px] -translate-y-1/2 items-center justify-center rounded-full border-2 border-slate-900 bg-gradient-to-br from-orange-500 to-amber-500 px-2 shadow-md shadow-orange-500/40 ">
                                      <span className="text-[12px] font-black leading-none text-white drop-shadow-sm">{history.unread_count > 99 ? '99+' : history.unread_count}</span>
                                    </div>
                                  )}

                                  <div className="flex items-center gap-1.5 mb-1">
                                    <span className={`text-xs font-semibold truncate ${isSelected ? 'text-slate-200' : 'text-slate-300'}`}>{history.employee_username}</span>
                                    <span className="text-[10px] text-orange-200/90 font-mono flex-shrink-0">編號： {history.employee_number || '—'}</span>
                                  </div>

                                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1 pr-1">
                                    <EmployeeMetadataPopover
                                      kind="tag"
                                      theme="orange"
                                      values={employeeTags}
                                      selected={isSelected}
                                      className="relative min-w-0 max-w-[48%]"
                                    />
                                    <EmployeeMetadataPopover
                                      kind="note"
                                      theme="orange"
                                      value={employeeNote}
                                      selected={isSelected}
                                      className="relative min-w-0 max-w-[48%]"
                                    />
                                  </div>

                                  <p className={`mt-1 text-[11px] leading-relaxed truncate ${
                                    hasUnread ? 'text-orange-200 font-semibold' : 'text-slate-500'
                                  }`}>{hasUnread && <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-400 mr-1 mb-px" />}{isPhoto ? <span className="inline-flex items-center gap-1"><Image className="w-3 h-3" />圖片</span> : (plainMessage || '沒有訊息')}</p>
                                </div>
                              </div>
                            </button>
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
            <div className="flex h-full flex-col overflow-hidden rounded-xl border border-orange-400/35 bg-gradient-to-b from-orange-950/20 via-slate-900/90 to-slate-950/95 shadow-2xl shadow-orange-950/20 backdrop-blur-xl">
              {/* Chat Header */}
              <div className="flex h-[72px] min-h-[72px] shrink-0 items-center overflow-hidden border-b border-orange-400/35 bg-gradient-to-r from-slate-900 via-slate-800/95 to-orange-950/25 px-3 py-2">
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
                          void loadAllConversationHistory(true);
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
                    <div className="h-8 w-px bg-orange-500/50 mx-1 flex-shrink-0"></div>
                    <div className="w-9 h-9 flex-shrink-0 rounded-lg border border-orange-300/30 bg-orange-500/20 flex items-center justify-center">
                      <User className="w-5 h-5 text-white" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-white text-sm font-bold leading-tight truncate">{selectedEmployee?.username}</div>
                      <div className="text-[11px] text-orange-300 leading-tight mt-0.5 truncate">編號： {selectedEmployee?.employee_id}</div>
                    </div>
                    {serviceTicketNumber && (
                      <div className="flex max-w-[96px] items-center gap-1.5 rounded-lg border border-orange-400/30 bg-gradient-to-r from-orange-500/15 to-amber-500/10 px-2 py-1.5 ml-1 flex-shrink-0">
                        <div className="w-1.5 h-1.5 bg-blue-400 rounded-full "></div>
                        <span className="truncate text-[11px] text-orange-200 font-mono font-bold tracking-wide">{serviceTicketNumber}</span>
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
                            className="flex items-center gap-1.5 rounded-lg border border-orange-300/60 bg-orange-600 px-2.5 py-1.5 text-xs font-bold text-white shadow-md shadow-orange-600/30 transition-all hover:bg-orange-500 hover:shadow-orange-500/40"
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
              <div className="flex min-h-9 shrink-0 items-center gap-2 overflow-hidden border-b border-orange-400/25 bg-slate-900/80 px-3 py-1.5">
                <span className="flex min-w-0 max-w-[45%] items-center gap-1.5 truncate rounded-md border border-orange-300/35 bg-orange-500/15 px-2 py-1 text-[10px] font-bold text-orange-100" title={selectedEmployee?.tags?.join(' · ') || '無標籤'}>
                  <Tag className="h-3 w-3 shrink-0 text-orange-300" />
                  <span className="truncate">{selectedEmployee?.tags?.length ? selectedEmployee.tags.join(' · ') : '無標籤'}</span>
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-md border border-slate-500/45 bg-slate-800/70 px-2 py-1 text-[10px] font-medium text-slate-200" title={selectedEmployee?.remarks || '無備註'}>
                  <FileText className="h-3 w-3 shrink-0 text-slate-400" />
                  <span className="truncate">{selectedEmployee?.remarks?.trim() || '無備註'}</span>
                </span>
              </div>

              {/* Messages */}
              <div ref={messagesContainerCallbackRef} className="relative flex-1 overflow-y-auto flex flex-col-reverse scrollbar-dark" style={{
                background: 'linear-gradient(180deg, #24170f 0%, #1b1513 40%, #24170f 100%)',
                backgroundImage: `linear-gradient(180deg, #24170f 0%, #1b1513 40%, #24170f 100%), radial-gradient(circle at 20% 50%, rgba(249,115,22,0.05) 0%, transparent 50%), radial-gradient(circle at 80% 30%, rgba(245,158,11,0.04) 0%, transparent 50%)`
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
                            <div className="mt-1 flex shrink-0 flex-col gap-1 rounded-xl border border-orange-200/20 bg-slate-950/70 p-1 opacity-70 shadow-lg shadow-black/20 backdrop-blur-sm transition-all duration-200 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                              <button
                                type="button"
                                onClick={() => handleStartEdit(msg)}
                                className="flex h-7 w-7 items-center justify-center rounded-lg border border-orange-300/20 bg-orange-500/10 text-orange-200 transition-all hover:-translate-y-0.5 hover:border-orange-200/70 hover:bg-orange-500 hover:text-white hover:shadow-md hover:shadow-orange-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
                                title={msg.message_type === 'image' ? '替換圖片' : '編輯訊息'}
                                aria-label={msg.message_type === 'image' ? '替換圖片' : '編輯訊息'}
                              >
                                {msg.message_type === 'image' ? <Image className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                              </button>
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
                            <div className="order-last mt-1 flex shrink-0 flex-col gap-1 rounded-xl border border-orange-200/20 bg-slate-950/70 p-1 opacity-70 shadow-lg shadow-black/20 backdrop-blur-sm transition-all duration-200 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                              <button
                                type="button"
                                onClick={() => handleStartEdit(msg)}
                                className="flex h-7 w-7 items-center justify-center rounded-lg border border-orange-300/20 bg-orange-500/10 text-orange-200 transition-all hover:-translate-y-0.5 hover:border-orange-200/70 hover:bg-orange-500 hover:text-white hover:shadow-md hover:shadow-orange-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
                                title={msg.message_type === 'image' ? '替換圖片' : '編輯訊息'}
                                aria-label={msg.message_type === 'image' ? '替換圖片' : '編輯訊息'}
                              >
                                {msg.message_type === 'image' ? <Image className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                          )}
                          {msg.message_type === 'tip' ? (
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
                              ? 'border-orange-200/80 shadow-slate-950/20'
                              : 'border-orange-300/30 shadow-orange-950/35'
                          }`} style={{ width: 'fit-content', height: 'fit-content', maxWidth: '100%', backgroundColor: 'transparent' }}>
                            <div className="relative inline-flex w-fit max-w-full flex-col" style={{ width: 'fit-content', height: 'fit-content', maxWidth: '100%' }}>
                              {renderMessageContent(msg)}
                              {replacingImageMsgId === msg.id && (
                                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-slate-950/65 backdrop-blur-[2px]">
                                  <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-orange-300" />
                                  <span className="text-xs font-semibold text-white">正在替換圖片……</span>
                                </div>
                              )}
                            </div>
                            <div className={`border-t px-3 py-1.5 text-[10px] ${msg.sender_type === 'customer' ? 'border-slate-100 bg-white text-right text-slate-500' : 'border-orange-200/10 bg-slate-950/25 text-orange-100/60'}`}>
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
                                ? 'rounded-[20px] border-2 border-orange-400 bg-white text-slate-800 ring-2 ring-orange-100 shadow-[0_12px_28px_rgba(249,115,22,0.18)]'
                                : msg.sender_type === 'customer'
                                  ? 'rounded-[20px] rounded-tr-[6px] border-2 border-orange-200/80 bg-white text-slate-800 shadow-[0_10px_24px_rgba(15,23,42,0.2)]'
                                  : 'rounded-[20px] rounded-tl-[6px] border-2 border-orange-300/35 bg-gradient-to-br from-slate-800 via-slate-800 to-orange-950/70 text-slate-100 shadow-[0_10px_24px_rgba(67,32,10,0.34)]'
                            }`}
                          >
                            <div className="relative z-10">
                              <div className={`text-xs font-semibold flex items-center gap-1.5 pb-1.5 mb-1.5 ${
                                msg.sender_type === 'customer'
                                  ? 'border-b border-slate-200/90'
                                  : 'border-b border-orange-200/15'
                              }`}>
                                {msg.sender_type === 'customer' && selectedCustomer?.is_super && (
                                  <span className="text-[10px]">
                                    {selectedCustomer.badge_type === 'diamond' ? '💎' : selectedCustomer.badge_type === 'crown' ? '👑' : selectedCustomer.badge_type === 'star' ? '⭐' : selectedCustomer.badge_type === 'vip' ? '🏆' : '✨'}
                                  </span>
                                )}
                                <span className={msg.sender_type === 'employee' ? 'text-orange-100' : selectedCustomer?.is_super ? 'text-amber-600 font-bold' : 'text-blue-700 font-semibold'}>{msg.sender_type === 'customer' ? selectedCustomer?.customer_name : selectedEmployee?.username}</span>
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
                                  : 'text-orange-100/60'
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
                {showTemplatePopup && (
                  <>
                    <div className="fixed inset-0 z-40" onMouseDown={() => setShowTemplatePopup(false)} />
                    <div className="absolute bottom-full left-0 right-0 mb-2 px-1 z-50">
                      <div className="relative flex max-h-[360px] flex-col overflow-hidden rounded-2xl border border-orange-300/25 bg-gradient-to-b from-slate-900/98 via-slate-900/96 to-orange-950/75 shadow-2xl shadow-orange-950/30 ring-1 ring-orange-200/10 backdrop-blur-xl">
                        <div className="flex shrink-0 items-center justify-between border-b border-orange-200/15 bg-gradient-to-r from-orange-500/15 via-slate-900/40 to-transparent px-4 py-3">
                          <div className="flex items-center gap-2">
                            <div className="flex h-7 w-7 items-center justify-center rounded-xl border border-orange-300/25 bg-orange-500/20 shadow-lg shadow-orange-900/20">
                              <Zap className="w-3 h-3 text-white" />
                            </div>
                            <span className="text-[13px] font-bold text-slate-100 tracking-tight">快速傳送</span>
                            <span className="flex h-5 min-w-5 items-center justify-center rounded-full border border-orange-300/30 bg-orange-500/20 px-1.5 text-[11px] font-bold text-orange-100">{messageTemplates.length}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => { setShowTemplatePopup(false); setShowTemplateManager(true); loadTemplates(); }}
                              className="flex items-center gap-1 rounded-lg border border-orange-300/35 bg-orange-500/15 px-2.5 py-1 text-[11px] font-semibold text-orange-50 shadow-sm shadow-orange-950/20 transition-all duration-150 hover:border-orange-200/70 hover:bg-orange-500 hover:shadow-orange-500/25"
                            >
                              <Pencil className="w-3 h-3" />
                              管理
                            </button>
                            <button type="button" onClick={() => setShowTemplatePopup(false)} className="rounded-lg p-1.5 transition-colors hover:bg-orange-500/15" aria-label="關閉快速傳送">
                              <X className="h-3.5 w-3.5 text-orange-200/70 hover:text-orange-100" />
                            </button>
                          </div>
                        </div>
                        {messageTemplates.length > 0 ? (
                          <div className="overflow-y-auto bg-slate-950/25 p-2.5 space-y-2 scrollbar-dark">
                            {messageTemplates.map((tpl) => {
                              const hasImages = /<img\s/i.test(tpl.content);
                              const plainPreview = tpl.content_type === 'richtext'
                                ? tpl.content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
                                : tpl.content;
                              return (
                                <button
                                  key={tpl.id}
                                  type="button"
                                  onClick={() => {
                                    if (editorRef.current) {
                                      const content = tpl.content_type === 'richtext' ? tpl.content : tpl.content.replace(/\n/g, '<br>');
                                      editorRef.current.innerHTML = content;
                                      const hasText = (editorRef.current.textContent || '').trim().length > 0;
                                      const hasImgs = editorRef.current.querySelector('img') !== null;
                                      setMessageInput(hasText ? editorRef.current.textContent! : hasImgs ? '_img_' : '');
                                    }
                                    setShowTemplatePopup(false);
                                  }}
                                  className={`group w-full rounded-xl border px-3 py-2.5 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70 ${
                                    tpl.is_pinned
                                      ? 'border-orange-400/45 bg-gradient-to-r from-orange-900/55 via-orange-950/35 to-slate-900/70 shadow-orange-950/25 hover:border-orange-300/75 hover:from-orange-800/70 hover:via-orange-900/45 hover:to-slate-900/60'
                                      : 'border-slate-700/70 bg-slate-800/75 hover:border-orange-300/45 hover:bg-slate-800'
                                  }`}
                                >
                                  <div className="flex items-center gap-2">
                                    {tpl.is_pinned && (
                                      <div className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md border border-orange-300/25 bg-orange-500/15">
                                        <Pin className="h-2.5 w-2.5 text-orange-300" />
                                      </div>
                                    )}
                                    <span className={`flex-1 truncate text-[13px] font-semibold ${tpl.is_pinned ? 'text-orange-100 group-hover:text-orange-50' : 'text-slate-200 group-hover:text-white'}`}>{tpl.name}</span>
                                    {hasImages && (
                                      <span className="flex items-center gap-0.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 flex-shrink-0">
                                        <Image className="w-2.5 h-2.5" />
                                        圖片
                                      </span>
                                    )}
                                    {tpl.content_type === 'richtext' && (
                                      <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 flex-shrink-0">富文字</span>
                                    )}
                                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg border border-orange-300/0 bg-orange-500/0 opacity-0 transition-all group-hover:border-orange-300/40 group-hover:bg-orange-500 group-hover:opacity-100" title="填入輸入框">
                                      <Pencil className="w-2.5 h-2.5 text-white" />
                                    </div>
                                  </div>
                                  <div className={`mt-1 ${tpl.is_pinned ? 'pl-7' : ''}`}>
                                    {plainPreview && (
                                      <p className="text-[11px] text-slate-400 group-hover:text-slate-300 truncate leading-relaxed">{plainPreview.substring(0, 100)}</p>
                                    )}
                                    {hasImages && !plainPreview && (
                                      <p className="text-[11px] text-amber-400/70 group-hover:text-amber-300/80 truncate leading-relaxed flex items-center gap-1">
                                        <Image className="w-3 h-3 inline" /> 包含圖片
                                      </p>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="p-6 text-center">
                            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-orange-300/20 bg-orange-500/10 shadow-lg shadow-orange-950/20">
                              <FileText className="h-5 w-5 text-orange-300" />
                            </div>
                            <p className="mb-1 text-sm font-semibold text-slate-100">尚無範本</p>
                            <p className="mb-3 text-[11px] text-slate-400">建立快速回覆範本</p>
                            <button
                              type="button"
                              onClick={() => { setShowTemplatePopup(false); setShowTemplateManager(true); loadTemplates(); }}
                              className="rounded-lg border border-orange-300/35 bg-orange-500/20 px-3.5 py-1.5 text-xs font-semibold text-orange-50 shadow-sm shadow-orange-950/20 transition-all hover:border-orange-200/70 hover:bg-orange-500 hover:shadow-orange-500/25"
                            >
                              建立範本
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
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
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); applyFormat('strikeThrough'); }} className="p-1.5 rounded-md transition-all text-slate-500 hover:bg-slate-200 hover:text-slate-800" title="刪除線">
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
                          <div className="flex items-center gap-1">
                            <div className="w-3.5 h-3.5 border-2 border-slate-300 border-t-blue-500 rounded-full animate-spin"></div>
                            <span className="text-[10px] text-blue-400 font-bold">{uploadProgress}%</span>
                          </div>
                        ) : (
                          <Image className="w-3.5 h-3.5" strokeWidth={2.5} />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => { loadTemplates(); setShowTemplatePopup(!showTemplatePopup); }}
                        className={`group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.04em] transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400/70 ${showTemplatePopup ? 'border-orange-300 bg-gradient-to-r from-orange-500 to-amber-500 text-white shadow-md shadow-orange-500/30' : 'border-orange-300/70 bg-orange-50 text-orange-700 shadow-sm shadow-orange-200/50 hover:-translate-y-0.5 hover:border-orange-500 hover:bg-orange-100 hover:text-orange-800 hover:shadow-md hover:shadow-orange-300/40'}`}
                        title="快速傳送範本"
                        aria-label="開啟快速傳送範本"
                        aria-pressed={showTemplatePopup}
                      >
                        <span className={`flex h-5 w-5 items-center justify-center rounded-md ${showTemplatePopup ? 'bg-white/20' : 'bg-orange-200/70 group-hover:bg-orange-300/70'}`}>
                          <FileText className="h-3.5 w-3.5" strokeWidth={2.5} />
                        </span>
                        <span>快速傳送</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowTipModal(true)}
                        className="group flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-amber-400/80 bg-amber-50 px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-[0.04em] text-amber-800 shadow-sm shadow-amber-200/60 transition-all duration-200 hover:-translate-y-0.5 hover:border-amber-500 hover:bg-amber-100 hover:shadow-md hover:shadow-amber-300/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/70"
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
                      onInput={() => setMessageInput(getEditorHasContent() ? (editorRef.current?.textContent || '_img_') : '')}
                      onSelect={() => {
                        setIsBoldActive(document.queryCommandState('bold'));
                        setIsUnderlineActive(document.queryCommandState('underline'));
                      }}
                      onKeyUp={() => {
                        setIsBoldActive(document.queryCommandState('bold'));
                        setIsUnderlineActive(document.queryCommandState('underline'));
                      }}
                      onMouseUp={() => {
                        setIsBoldActive(document.queryCommandState('bold'));
                        setIsUnderlineActive(document.queryCommandState('underline'));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && e.ctrlKey) {
                          e.preventDefault();
                          handleSendMessage(e as unknown as React.FormEvent);
                        }
                      }}
                      className="min-h-[40px] max-h-[216px] overflow-y-auto px-3 py-2 text-slate-800 focus:outline-none text-sm leading-5 [&_b]:font-bold [&_u]:underline [&_font[size='5']]:text-lg [&_font[size='7']]:text-xl"
                      data-placeholder={`以 ${selectedCustomer?.customer_name || '客戶'} 身分傳送訊息……（Ctrl+Enter 傳送）`}
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
                        {selectedEmployee ? selectedEmployee.username : '客戶服務'}
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
                    <p className="text-xs text-slate-400">請選擇客戶開始聊天</p>
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

      {/* Tip Modal */}
      {showTipModal && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
          <div className="relative w-full max-w-md overflow-hidden rounded-[28px] border border-orange-300/25 bg-gradient-to-b from-slate-900 via-slate-900 to-orange-950/70 shadow-2xl shadow-orange-950/40 ring-1 ring-orange-200/10">
            <div className="absolute -right-16 -top-20 h-48 w-48 rounded-full bg-orange-500/15 blur-3xl" />
            <div className="absolute -bottom-20 -left-16 h-48 w-48 rounded-full bg-amber-500/10 blur-3xl" />
            <div className="relative p-6 sm:p-7">
              <button
                type="button"
                onClick={() => { setShowTipModal(false); setTipAmount(''); }}
                className="absolute right-4 top-4 rounded-xl p-2 text-slate-400 transition-all hover:bg-orange-500/15 hover:text-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-300/70"
                aria-label="關閉送出打賞"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="flex items-center gap-3 pr-8">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-orange-300/30 bg-gradient-to-br from-orange-500/30 to-amber-500/10 shadow-lg shadow-orange-950/30">
                  <Gift className="h-6 w-6 text-orange-200" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-xl font-black tracking-tight text-white">送出打賞</h3>
                    <span className="rounded-full border border-orange-300/25 bg-orange-500/15 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-orange-200">感謝心意</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-slate-400">向 <span className="font-semibold text-orange-200">{selectedEmployee?.username}</span></p>
                </div>
              </div>

              <div className="mt-7 rounded-2xl border border-orange-200/15 bg-slate-950/35 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-[11px] font-bold uppercase tracking-[0.14em] text-orange-100/80">打賞金額</label>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">USD</span>
                </div>
                <div className="relative">
                  <DollarSign className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-orange-300" />
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
                    className="w-full rounded-xl border border-orange-200/20 bg-slate-900/80 py-4 pl-12 pr-16 text-3xl font-black tracking-tight text-white placeholder-slate-700 outline-none transition-all focus:border-orange-300/70 focus:ring-2 focus:ring-orange-400/20"
                    autoFocus
                  />
                  <span className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-bold text-orange-200/60">USD</span>
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
                      className={`rounded-lg border px-2 py-2 text-xs font-bold transition-all ${tipAmount === preset.toString() ? 'border-orange-300 bg-orange-500/25 text-orange-100 shadow-sm shadow-orange-500/20' : 'border-slate-700/80 bg-slate-900/70 text-slate-400 hover:border-orange-300/60 hover:bg-orange-500/10 hover:text-orange-100'}`}
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
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-orange-300/50 bg-gradient-to-r from-orange-500 to-amber-500 px-5 py-3 text-sm font-bold text-white shadow-lg shadow-orange-600/25 transition-all hover:-translate-y-0.5 hover:from-orange-400 hover:to-amber-400 hover:shadow-orange-500/35 disabled:cursor-not-allowed disabled:border-slate-700 disabled:from-slate-800 disabled:to-slate-800 disabled:text-slate-500 disabled:shadow-none"
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
        <div className="fixed inset-0 z-[9999] flex items-center justify-center overflow-y-auto bg-slate-950/85 p-4 backdrop-blur-lg" onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowCustomerForm(false); setEditingCustomer(null); setCustomerForm({ name: '', avatar: 'customer-avatar:regular:0', isSuper: false, superTitle: '', customId: '', badgeType: '', vipLabel: 'VIP', customAvatarFile: null, useCustomAvatar: false, remarks: '' }); } }}>
          <form onClick={(e) => e.stopPropagation()} onSubmit={editingCustomer ? (e) => { e.preventDefault(); handleUpdateCustomer(); } : handleCreateCustomer} className={`create-customer-modal create-customer-modal--orange relative w-full max-h-[calc(100vh-1rem)] overflow-y-auto rounded-[20px] border p-4 shadow-[0_22px_70px_rgba(2,6,23,0.78)] ring-1 ring-white/5 ${customerForm.isSuper ? 'max-w-4xl' : 'max-w-3xl'} transition-all duration-200`}>
            <div className="mb-4 flex items-start justify-between gap-4 border-b border-orange-200/15 pb-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-orange-300/30 bg-gradient-to-br from-orange-500/30 via-amber-500/20 to-slate-900/60 text-orange-100 shadow-lg shadow-orange-950/30">
                  {customerForm.isSuper ? <Star className="h-5 w-5" fill="currentColor" /> : <User className="h-5 w-5" />}
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-orange-300/75">模擬客戶管理</p>
                  <h3 className="mt-1 truncate text-xl font-black tracking-tight text-white">{editingCustomer ? '編輯客戶' : '建立客戶'}</h3>
                  <p className="mt-1 text-xs text-slate-400">{editingCustomer ? '更新現有客戶角色資料' : '建立一個新的客戶角色並設定顯示資料'}</p>
                </div>
              </div>
              <span className="shrink-0 rounded-full border border-orange-300/25 bg-orange-500/10 px-3 py-1 text-[10px] font-bold tracking-wider text-orange-200">{customerForm.isSuper ? 'VIP 客戶' : '一般客戶'}</span>
            </div>
            {/* Super Customer Toggle */}
            <div className={`relative mb-4 overflow-hidden rounded-xl border p-3 transition-all duration-300 ${customerForm.isSuper ? 'border-amber-300/45 bg-gradient-to-br from-amber-500/15 via-orange-500/10 to-slate-950/35 shadow-lg shadow-amber-950/20' : 'border-slate-600/70 bg-slate-900/50'}`}>
              <div className="pointer-events-none absolute -right-10 -top-12 h-28 w-28 rounded-full bg-amber-400/15 blur-3xl" />
              <label className="relative flex cursor-pointer items-center gap-3">
                <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border-2 transition-all ${customerForm.isSuper ? 'border-amber-300 bg-amber-400 text-slate-950 shadow-md shadow-amber-500/30' : 'border-slate-500 bg-slate-950/40'}`}>
                  {customerForm.isSuper && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                </div>
                <input
                  type="checkbox"
                  checked={customerForm.isSuper}
                  onChange={(e) => setCustomerForm({ ...customerForm, isSuper: e.target.checked, avatar: e.target.checked ? 'customer-avatar:vip:0' : 'customer-avatar:regular:0' })}
                  className="sr-only"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Star className={`h-4 w-4 ${customerForm.isSuper ? 'text-amber-300' : 'text-slate-500'}`} fill="currentColor" />
                    <span className={`text-sm font-black ${customerForm.isSuper ? 'text-amber-100' : 'text-slate-200'}`}>超級客戶（VIP）</span>
                    <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${customerForm.isSuper ? 'bg-amber-300/20 text-amber-200' : 'bg-slate-700 text-slate-400'}`}>{customerForm.isSuper ? '已啟用' : '未啟用'}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-slate-400">啟用後可使用 VIP 頭像、標題前綴與專屬徽章設定。</p>
                </div>
                <span className={`hidden shrink-0 rounded-lg px-2.5 py-1.5 text-[10px] font-bold sm:inline-flex ${customerForm.isSuper ? 'bg-amber-400/15 text-amber-200' : 'bg-slate-800 text-slate-500'}`}>{customerForm.isSuper ? 'VIP 模式' : '一般模式'}</span>
              </label>
            </div>

            {customerForm.isSuper ? (
              <div className="grid gap-3 md:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                {/* Left column: basic info + avatar */}
                <div className="min-w-0 rounded-xl border border-slate-700/70 bg-gradient-to-br from-slate-800/75 via-slate-900/60 to-blue-950/25 p-3 shadow-lg shadow-slate-950/20">
                  <div className="mb-3 flex items-center gap-3 border-b border-white/10 pb-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/15 text-blue-300 ring-1 ring-blue-400/25"><User className="h-4 w-4" /></div>
                    <div><h4 className="text-sm font-bold text-white">基本資料與頭像</h4><p className="mt-0.5 text-[10px] text-slate-400">設定客戶名稱與顯示頭像</p></div>
                  </div>
                  <div className="mb-3">
                    <label className="block text-xs font-medium text-slate-400 mb-1.5">客戶名稱</label>
                    <input
                      type="text"
                      value={customerForm.name}
                      onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })}
                      className="w-full px-3 py-2.5 bg-slate-900/50 border border-slate-700 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                      placeholder="客戶名稱"
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
                      <label className="block text-xs font-medium text-amber-300 mb-1.5">VIP 角色頭像</label>
                      <CustomerAvatarPicker
                        value={customerForm.avatar}
                        onChange={(avatar) => setCustomerForm({ ...customerForm, avatar })}
                        theme="orange"
                        variant="vip"
                        size="large"
                      />
                    </div>
                  )}
                </div>

                {/* Right column: VIP settings */}
                <div className="min-w-0 rounded-xl border border-amber-400/30 bg-gradient-to-br from-amber-950/55 via-orange-950/25 to-slate-900/60 p-3 shadow-lg shadow-amber-950/20">
                  <div className="mb-3 flex items-center gap-3 border-b border-amber-300/15 pb-2">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-400/15 text-amber-200 ring-1 ring-amber-300/25"><Star className="h-4 w-4" fill="currentColor" /></div>
                    <div><h4 className="text-sm font-bold text-amber-50">VIP 專屬設定</h4><p className="mt-0.5 text-[10px] text-amber-200/60">自訂身份標籤與聊天顯示風格</p></div>
                  </div>
                  <div className="mb-3">
                    <label className="block text-xs font-medium text-amber-300 mb-1.5">
                      自訂 ID <span className="text-amber-500/70 text-[10px]">（選填）</span>
                    </label>
                    <input
                      type="text"
                      value={customerForm.customId}
                      onChange={(e) => setCustomerForm({ ...customerForm, customId: e.target.value })}
                      className="w-full px-3 py-2.5 bg-amber-900/20 border border-amber-500/30 rounded-lg text-amber-200 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 placeholder:text-amber-600/50"
                      placeholder="例如：VIP-001"
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
                      placeholder="新增備註以識別此客戶……"
                      className="w-full px-3 py-2 bg-slate-800 border border-slate-600 rounded-lg text-white placeholder-slate-500 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      maxLength={100}
                    />
                  </div>
                </div>

              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)]">
                <div className="min-w-0 rounded-2xl border border-orange-400/25 bg-gradient-to-br from-orange-950/35 via-slate-900/65 to-slate-950/50 p-4 shadow-lg shadow-orange-950/15">
                  <div className="mb-4 flex items-center gap-3 border-b border-orange-200/10 pb-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-500/15 text-orange-200 ring-1 ring-orange-300/25"><User className="h-4 w-4" /></div>
                    <div><h4 className="text-sm font-bold text-white">基本資料</h4><p className="mt-0.5 text-[10px] text-slate-400">設定客戶名稱與角色頭像</p></div>
                  </div>
                  <div className="mb-4">
                    <label className="mb-1.5 block text-xs font-semibold text-orange-200/85">客戶名稱</label>
                    <input
                      type="text"
                      value={customerForm.name}
                      onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })}
                      className="w-full rounded-xl border border-slate-700 bg-slate-950/55 px-3.5 py-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-orange-500"
                      placeholder="輸入客戶名稱"
                      required
                    />
                  </div>
                  <div>
                    <label className="mb-3 block text-xs font-semibold text-orange-200/85">選擇角色頭像</label>
                    <CustomerAvatarPicker
                      value={customerForm.avatar}
                      onChange={(avatar) => setCustomerForm({ ...customerForm, avatar })}
                      theme="orange"
                      variant="regular"
                    />
                  </div>
                </div>

                <div className="min-w-0 rounded-2xl border border-slate-700/70 bg-gradient-to-br from-slate-800/70 via-slate-900/60 to-slate-950/55 p-4 shadow-lg shadow-slate-950/20">
                  <div className="mb-4 flex items-center gap-3 border-b border-white/10 pb-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-slate-700/60 text-slate-200 ring-1 ring-slate-500/40"><Tag className="h-4 w-4" /></div>
                    <div><h4 className="text-sm font-bold text-white">補充資料</h4><p className="mt-0.5 text-[10px] text-slate-400">新增備註方便辨識客戶</p></div>
                  </div>
                  <label className="mb-1.5 block text-xs font-semibold text-slate-300">備註（選填）</label>
                  <input
                    type="text"
                    value={customerForm.remarks}
                    onChange={(e) => setCustomerForm({ ...customerForm, remarks: e.target.value })}
                    placeholder="新增備註以識別此客戶……"
                    className="w-full rounded-xl border border-slate-700 bg-slate-950/55 px-3 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500"
                    maxLength={100}
                  />
                  <div className="mt-5 rounded-xl border border-orange-300/10 bg-orange-500/5 p-3 text-[11px] leading-5 text-slate-400">
                    <span className="font-semibold text-orange-200">提示：</span> 客戶建立後可在列表中繼續管理角色資料。
                  </div>
                </div>
              </div>
            )}

            <div className="create-customer-modal__actions mt-4 flex gap-3">
              <button
                type="submit"
                disabled={savingCustomer}
                className="flex-1 px-4 py-3 text-sm text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                {savingCustomer ? '儲存中……' : editingCustomer ? <><Check className="mr-2 inline-block h-4 w-4" />儲存變更</> : <><Plus className="mr-2 inline-block h-4 w-4" />建立客戶</>}
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowCustomerForm(false);
                  setEditingCustomer(null);
                  setCustomerForm({ name: '', avatar: 'customer-avatar:regular:0', isSuper: false, superTitle: '', customId: '', badgeType: '', vipLabel: 'VIP', customAvatarFile: null, useCustomAvatar: false, remarks: '' });
                }}
                className="flex-1 px-4 py-3 text-sm"
              >
                <X className="mr-2 inline-block h-4 w-4" />取消
              </button>
            </div>
          </form>
        </div>
      )}

      {showTemplateManager && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[9999] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowTemplateManager(false); setEditingTemplate(null); setTemplateForm({ name: '', content: '', content_type: 'richtext' }); if (templateEditorRef.current) templateEditorRef.current.innerHTML = ''; } }}>
          <div onClick={(e) => e.stopPropagation()} className="bg-slate-900 rounded-2xl border border-slate-700/50 w-full max-w-5xl h-[85vh] flex flex-col shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700/50 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-teal-600/20 rounded-lg">
                  <BookOpen className="w-5 h-5 text-teal-400" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-white">訊息範本</h3>
                  <p className="text-xs text-slate-400 mt-0.5">{messageTemplates.length} 個範本</p>
                </div>
              </div>
              <button onClick={() => { setShowTemplateManager(false); setEditingTemplate(null); setTemplateForm({ name: '', content: '', content_type: 'richtext' }); if (templateEditorRef.current) templateEditorRef.current.innerHTML = ''; }} className="p-2 hover:bg-slate-800 rounded-lg transition-colors">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            {/* Left/Right body */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
              {/* Left: Editor */}
              <div className="w-1/2 flex flex-col border-r border-slate-700/50 p-4 gap-3">
                <h4 className="text-sm font-bold text-white flex items-center gap-2 flex-shrink-0">
                  {editingTemplate ? <Pencil className="w-3.5 h-3.5 text-blue-400" /> : <Plus className="w-3.5 h-3.5 text-teal-400" />}
                  {editingTemplate ? '編輯範本' : '新增範本'}
                </h4>
                <input
                  type="text"
                  value={templateForm.name}
                  onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })}
                  className="w-full px-3 py-2.5 bg-white border border-slate-300 rounded-lg text-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-blue-400 placeholder:text-slate-400 flex-shrink-0 shadow-sm"
                  placeholder="範本名稱（例如：歡迎訊息、常見問答、跟進……）"
                />
                <input ref={templateImageInputRef} type="file" accept="image/*" onChange={handleTemplateImageUpload} className="hidden" />
                <input id="templateFileImport" type="file" accept=".txt,.doc,.docx" onChange={handleTemplateFileImport} className="hidden" />
                {/* Unified toolbar + editor (light theme, matches chat input) */}
                <div className="flex-1 min-h-0 rounded-xl border border-slate-300 bg-white overflow-hidden focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400/40 transition-all shadow-sm flex flex-col">
                  <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-slate-200 bg-slate-50/80 flex-shrink-0 flex-wrap">
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); ensureEditorFocus(templateEditorRef.current!); document.execCommand('bold'); setTemplateBoldActive(prev => !prev); }} className={`p-1.5 rounded-md transition-all ${templateBoldActive ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`} title="粗體（Ctrl+B）">
                      <Bold className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); ensureEditorFocus(templateEditorRef.current!); document.execCommand('underline'); setTemplateUnderlineActive(prev => !prev); }} className={`p-1.5 rounded-md transition-all ${templateUnderlineActive ? 'bg-blue-500 text-white shadow-sm shadow-blue-500/30' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-800'}`} title="底線（Ctrl+U）">
                      <Underline className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                    <button type="button" onMouseDown={(e) => { e.preventDefault(); ensureEditorFocus(templateEditorRef.current!); document.execCommand('strikeThrough'); }} className="p-1.5 rounded-md transition-all text-slate-500 hover:bg-slate-200 hover:text-slate-800" title="刪除線">
                      <Strikethrough className="w-3.5 h-3.5" strokeWidth={2.5} />
                    </button>
                    <div className="w-px h-5 bg-slate-200 mx-1" />
                    <div className="flex items-center bg-slate-100 rounded-md p-0.5 gap-0.5">
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); setTemplateFontSize(templateFontSize === 'normal' ? null : 'normal'); document.execCommand('fontSize', false, '3'); templateEditorRef.current?.focus(); }} className={`px-1.5 py-0.5 text-[10px] rounded transition-all ${templateFontSize === 'normal' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-semibold hover:text-slate-700 hover:bg-slate-200'}`} title="一般大小">A</button>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); setTemplateFontSize(templateFontSize === 'large' ? null : 'large'); document.execCommand('fontSize', false, '5'); templateEditorRef.current?.focus(); }} className={`px-1.5 py-0.5 text-xs rounded transition-all ${templateFontSize === 'large' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-semibold hover:text-slate-700 hover:bg-slate-200'}`} title="大字">A</button>
                      <button type="button" onMouseDown={(e) => { e.preventDefault(); setTemplateFontSize(templateFontSize === 'xlarge' ? null : 'xlarge'); document.execCommand('fontSize', false, '7'); templateEditorRef.current?.focus(); }} className={`px-1.5 py-0.5 text-sm rounded transition-all ${templateFontSize === 'xlarge' ? 'bg-blue-500 text-white font-bold shadow-sm shadow-blue-500/30' : 'text-slate-400 font-bold hover:text-slate-700 hover:bg-slate-200'}`} title="特大字">A</button>
                    </div>
                    <div className="relative">
                      <button
                        type="button"
                        onMouseDown={(e) => { e.preventDefault(); setShowBgColorPicker(showBgColorPicker === 'template' ? null : 'template'); }}
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
                      }
                    }}
                    onKeyUp={() => { setTemplateBoldActive(document.queryCommandState('bold')); setTemplateUnderlineActive(document.queryCommandState('underline')); }}
                    onMouseUp={() => { setTemplateBoldActive(document.queryCommandState('bold')); setTemplateUnderlineActive(document.queryCommandState('underline')); }}
                    className="flex-1 min-h-[200px] overflow-y-auto px-3 py-2.5 text-slate-800 text-sm focus:outline-none chat-rich-content"
                    style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                    data-placeholder="輸入範本內容、貼上格式化文字或匯入檔案……"
                  />
                </div>
                {/* Action buttons */}
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={editingTemplate ? handleUpdateTemplate : handleCreateTemplate}
                    disabled={!templateForm.name.trim() || isTemplateContentEmpty()}
                    className="flex-1 px-4 py-2.5 bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-500 hover:to-cyan-500 disabled:from-slate-600 disabled:to-slate-600 disabled:text-slate-400 text-white rounded-lg font-semibold text-sm transition-all"
                  >
                    {editingTemplate ? '儲存變更' : '新增範本'}
                  </button>
                  {editingTemplate && (
                    <button
                      type="button"
                      onClick={() => { setEditingTemplate(null); setTemplateForm({ name: '', content: '', content_type: 'richtext' }); if (templateEditorRef.current) templateEditorRef.current.innerHTML = ''; }}
                      className="px-4 py-2.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-semibold text-sm transition-all"
                    >
                      取消
              </button>
                  )}
                </div>
              </div>

              {/* Right: 已儲存的範本 */}
              <div className="w-1/2 flex flex-col p-4 overflow-hidden">
                <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3 flex-shrink-0">
                  已儲存的範本 ({messageTemplates.length})
                </h4>
                {messageTemplates.length > 0 ? (
                  <div className="flex-1 overflow-y-auto space-y-2 scrollbar-dark pr-1">
                    {messageTemplates.map((tpl) => (
                      <div key={tpl.id} className={`rounded-xl border p-3 transition-all group ${tpl.is_pinned ? 'bg-teal-900/20 border-teal-700/50' : 'bg-slate-800/40 border-slate-700/50 hover:border-slate-600/50'}`}>
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              {tpl.is_pinned && (
                                <Pin className="w-3 h-3 text-teal-400 flex-shrink-0" />
                              )}
                              <span className="text-sm font-bold text-white truncate">{tpl.name}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase flex-shrink-0 ${
                                tpl.content_type === 'richtext' ? 'bg-blue-500/20 text-blue-400' : 'bg-teal-500/20 text-teal-400'
                              }`}>{tpl.content_type === 'richtext' ? '富文字' : '純文字'}</span>
                            </div>
                            {tpl.content_type === 'richtext' ? (
                              <div className="text-xs text-slate-400 line-clamp-2 chat-rich-content" dangerouslySetInnerHTML={{ __html: sanitizeChatMessage(tpl.content) }} />
                            ) : (
                              <p className="text-xs text-slate-400 line-clamp-2">{tpl.content}</p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              type="button"
                              onClick={() => handleToggleTemplatePin(tpl)}
                              className={`p-1.5 rounded-md transition-all ${tpl.is_pinned ? 'bg-teal-600 text-white' : 'bg-slate-700 hover:bg-teal-600 text-slate-300 hover:text-white'}`}
                              title={tpl.is_pinned ? '取消置頂' : '置頂'}
                            >
                              <Pin className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingTemplate(tpl);
                                setTemplateForm({ name: tpl.name, content: tpl.content, content_type: tpl.content_type });
                                requestAnimationFrame(() => { if (templateEditorRef.current) templateEditorRef.current.innerHTML = tpl.content; });
                              }}
                              className="p-1.5 bg-slate-700 hover:bg-blue-600 text-slate-300 hover:text-white rounded-md transition-all"
                              title="編輯"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteTemplate(tpl.id)}
                              className="p-1.5 bg-slate-700 hover:bg-red-600 text-slate-300 hover:text-white rounded-md transition-all"
                              title="刪除"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col items-center justify-center text-center">
                    <FileText className="w-12 h-12 text-slate-700 mb-3" />
                    <p className="text-sm text-slate-500 font-medium">尚無範本</p>
                    <p className="text-xs text-slate-600 mt-1">使用左側編輯器建立您的第一個範本</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {confirmDialog && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
          <section role="dialog" aria-modal="true" aria-labelledby="customer-chat-delete-title" className="w-full max-w-md overflow-hidden rounded-[1.75rem] border border-rose-300/25 bg-slate-900 text-slate-100 shadow-[0_28px_90px_rgba(2,6,23,0.8)] ring-1 ring-inset ring-white/5">
            <div className="h-1 bg-gradient-to-r from-rose-600 via-red-400 to-orange-400" />
            <header className="flex items-start gap-3 border-b border-white/10 bg-gradient-to-br from-rose-500/10 via-slate-900 to-slate-900 px-5 py-5 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-rose-300/30 bg-rose-500/15 text-rose-200"><Trash2 className="h-5 w-5" aria-hidden="true" /></div>
              <div className="min-w-0 flex-1"><p className="text-[10px] font-bold uppercase tracking-[0.18em] text-rose-300">模擬客戶 · 刪除確認</p><h3 id="customer-chat-delete-title" className="mt-1 text-lg font-bold tracking-tight text-white">{confirmDialog.title}</h3><p className="mt-1 text-xs text-slate-400">請確認要刪除的內容</p></div>
              <button type="button" onClick={() => setConfirmDialog(null)} disabled={confirmDeleting} aria-label="關閉刪除確認" className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"><X className="h-4 w-4" /></button>
            </header>
            <div className="space-y-4 px-5 py-5 sm:px-6">
              <p className="text-sm leading-6 text-slate-200">{confirmDialog.message}</p>
              <div className="rounded-xl border border-white/10 bg-slate-950/50 p-4"><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">刪除對象</p><p className="mt-2 text-sm font-semibold text-white">{confirmDialog.scope === 'customer' ? '此客戶及其全部對話' : confirmDialog.scope === 'conversation' ? '目前整段對話' : '目前這則聊天訊息'}</p></div>
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
    </div>
  );
}

export default memo(CustomerServiceManagement);
