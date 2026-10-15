import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { formatSupabaseError, isSupabaseAbortError, supabase } from '../../lib/supabase';
import { getAdminFinancialSessionToken } from '../../lib/auth';
import { mutateAuditedContent } from '../../lib/contentAudit';
import { useCurrencyUnit } from '../../lib/useCurrencyUnit';
import EmployeeNotificationDetailPanel from '../employee/EmployeeNotificationDetailPanel';
import TiptapEditor, { type TiptapEditorRef } from './TiptapEditor';
import NotificationAutomation from './NotificationAutomation';
import NotificationDeliverySelector, { type NotificationDeliveryMode } from './NotificationDeliverySelector';
import {
  Send, Users, Bell, AlertCircle, X, Search,
  Check, CheckSquare, Square, Trash2, AlertTriangle,
  Pencil, Save, ChevronDown,
  Tag, Bookmark, Plus, Clock, Radio, Globe, Gift, Sparkles, ShieldCheck, Eye
} from 'lucide-react';

interface AdminGroup {
  id: string;
  username: string;
  role: string;
  total_employees: number;
  active_employees: number;
  verified_employees: number;
}

interface Employee {
  id: string;
  username: string;
  employee_id: string;
  is_active: boolean;
  is_verified: boolean;
  total_income: number;
  created_by: string;
  tags: string[];
  remarks: string;
  is_pinned: boolean;
  message_read_at?: string | null;
}

interface Message {
  id: string;
  sender_id: string;
  sender_username: string;
  title: string;
  content: string;
  message_type: 'realtime' | 'login_popup';
  delivery_mode: NotificationDeliveryMode;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  notification_category?: 'standard' | 'performance_reward' | null;
  reward_amount?: number | null;
  reward_currency?: string | null;
  created_at: string;
  audit_origin: 'manual_admin' | 'automation' | 'unverified';
  automation_execution_id: string | null;
  recipient_ids?: string[];
}

interface MessageStats {
  total_recipients: number;
  read_count: number;
  unread_count: number;
  read_percentage: number;
}

interface Props {
  admin: {
    id: string;
    username: string;
    role: string;
    is_super_admin?: boolean;
  };
  isActive?: boolean;
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
}

const formatMessageDateTime = (value: string) =>
  new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));

const getDeliveryMode = (message: Pick<Message, 'message_type' | 'delivery_mode'>): NotificationDeliveryMode =>
  message.delivery_mode || (message.message_type === 'login_popup' ? 'login_only' : 'realtime_only');

const getNotificationDeliveryLabel = (deliveryMode: NotificationDeliveryMode) => ({
  realtime_with_login_fallback: '結合通知',
  realtime_only: '即時通知',
  login_only: '登入通知',
})[deliveryMode];

const getMessageTypeTone = (deliveryMode: NotificationDeliveryMode) => {
  if (deliveryMode === 'realtime_with_login_fallback') {
    return {
      card: 'border-amber-700/90 bg-gradient-to-br from-amber-950/90 via-orange-950/75 to-slate-900',
      accent: 'bg-gradient-to-r from-amber-300 to-orange-400',
      icon: 'bg-gradient-to-br from-amber-300 to-orange-500 text-amber-950 ring-1 ring-amber-200/70',
      label: 'text-amber-200/75',
      value: 'text-amber-100',
    };
  }
  return deliveryMode === 'login_only'
    ? {
        card: 'border-violet-800/90 bg-gradient-to-br from-violet-950/80 via-slate-800 to-slate-900',
        accent: 'bg-violet-400',
        icon: 'bg-violet-900/80 text-violet-200 ring-1 ring-violet-700/60',
        label: 'text-violet-200/70',
        value: 'text-violet-100',
      }
    : {
        card: 'border-blue-800/90 bg-gradient-to-br from-blue-950/80 via-slate-800 to-slate-900',
        accent: 'bg-blue-400',
        icon: 'bg-blue-900/80 text-blue-200 ring-1 ring-blue-700/60',
        label: 'text-blue-200/70',
        value: 'text-blue-100',
      };
};

const getMessagePriorityTone = (priority: Message['priority']) => {
  switch (priority) {
    case 'urgent':
      return { card: 'border-red-800/90 bg-gradient-to-br from-red-950/80 via-slate-800 to-slate-900', accent: 'bg-red-400', icon: 'bg-red-900/80 text-red-200 ring-1 ring-red-700/60', label: 'text-red-200/70', value: 'text-red-100' };
    case 'high':
      return { card: 'border-amber-800/90 bg-gradient-to-br from-amber-950/80 via-slate-800 to-slate-900', accent: 'bg-amber-400', icon: 'bg-amber-900/80 text-amber-200 ring-1 ring-amber-700/60', label: 'text-amber-200/70', value: 'text-amber-100' };
    case 'normal':
      return { card: 'border-emerald-800/90 bg-gradient-to-br from-emerald-950/80 via-slate-800 to-slate-900', accent: 'bg-emerald-400', icon: 'bg-emerald-900/80 text-emerald-200 ring-1 ring-emerald-700/60', label: 'text-emerald-200/70', value: 'text-emerald-100' };
    default:
      return { card: 'border-slate-700 bg-gradient-to-br from-slate-800 via-slate-800 to-slate-900', accent: 'bg-slate-400', icon: 'bg-slate-700 text-slate-200 ring-1 ring-slate-600', label: 'text-slate-300/70', value: 'text-slate-100' };
  }
};

export default function MessageManagement({ admin, isActive = true, initialEmployee, onConsumeInitialEmployee }: Props) {
  const [adminGroups, setAdminGroups] = useState<AdminGroup[]>([]);
  const [allEmployees, setAllEmployees] = useState<Map<string, Employee[]>>(new Map());
  const [selectedAdminId, setSelectedAdminId] = useState<string>('');
  const selectedAdminIdRef = useRef('');
  selectedAdminIdRef.current = selectedAdminId;
  const [loading, setLoading] = useState(true);

  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<Set<string>>(new Set());
  const employeeListRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (employeeListRef.current) employeeListRef.current.scrollTop = 0;
  }, [selectedEmployeeIds]);
  const [employeeTagPreview, setEmployeeTagPreview] = useState<{ employeeId: string; tags: string[]; left: number; top: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'verified'>('all');
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [allAvailableTags, setAllAvailableTags] = useState<string[]>([]);

  const [messageForm, setMessageForm] = useState({
    title: '',
    content: '',
    deliveryMode: 'realtime_with_login_fallback' as NotificationDeliveryMode,
    priority: 'normal' as 'low' | 'normal' | 'high' | 'urgent'
  });
  const [sending, setSending] = useState(false);
  const [sendProgress, setSendProgress] = useState<{ sent: number; total: number } | null>(null);
  const [showAutomation, setShowAutomation] = useState(false);
  const [employeePreviewOpen, setEmployeePreviewOpen] = useState(false);
  const [manualRewardEnabled, setManualRewardEnabled] = useState(false);
  const [manualRewardAmount, setManualRewardAmount] = useState('');
  const [showRewardConfirm, setShowRewardConfirm] = useState(false);
  const currencyUnit = useCurrencyUnit(admin.id);

  const [sentMessages, setSentMessages] = useState<Message[]>([]);
  const [selectedMessageDetail, setSelectedMessageDetail] = useState<Message | null>(null);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messagesError, setMessagesError] = useState(false);
  const [messageStats, setMessageStats] = useState<Map<string, MessageStats>>(new Map());
  const [readRecipientIdsByMessage, setReadRecipientIdsByMessage] = useState<Map<string, Set<string>>>(new Map());
  const [recipientDetails, setRecipientDetails] = useState<Map<string, { read: Employee[]; unread: Employee[] }>>(new Map());
  const [loadingRecipientDetails, setLoadingRecipientDetails] = useState(false);
  const [recipientSearchQuery, setRecipientSearchQuery] = useState('');
  const [recipientStatusFilter, setRecipientStatusFilter] = useState<'all' | 'read' | 'unread'>('all');

  const [selectedMessageIds, setSelectedMessageIds] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [deleteMode, setDeleteMode] = useState<'selected' | 'all' | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<{ completed: number; total: number } | null>(null);

  const [editingMessage, setEditingMessage] = useState(false);
  const [editForm, setEditForm] = useState({ title: '', content: '' });
  const [saving, setSaving] = useState(false);

  const [messageOriginFilter, setMessageOriginFilter] = useState<'all' | 'manual' | 'automation'>('all');
  const [messageTypeFilter, setMessageTypeFilter] = useState<'all' | NotificationDeliveryMode>('all');
  const [messageScopeFilter] = useState<'all' | 'broadcast' | 'targeted'>('all');
  const [readStatusFilter, setReadStatusFilter] = useState<'all' | 'read' | 'unread' | 'no_recipients'>('all');
  const [sentMessagesSearchQuery, setSentMessagesSearchQuery] = useState('');

  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const [showGroupDropdown, setShowGroupDropdown] = useState(false);

  const [templates, setTemplates] = useState<Array<{id:string; name:string; title:string; content:string}>>([]);
  const [showTemplateDropdown, setShowTemplateDropdown] = useState(false);
  const [showSaveTemplateModal, setShowSaveTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateEditorContent, setTemplateEditorContent] = useState('');
  const [templateFormTitle, setTemplateFormTitle] = useState('');
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const templateEditorRef2 = useRef<TiptapEditorRef>(null);

  const composeEditorRef = useRef<TiptapEditorRef>(null);
  const editEditorRef = useRef<TiptapEditorRef>(null);
  const manualSendOperationRef = useRef<{ id: string; fingerprint: string } | null>(null);
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  const groupDropdownRef = useRef<HTMLDivElement>(null);
  const templateDropdownRef = useRef<HTMLDivElement>(null);

  const hasInitiallyLoaded = useRef(false);
  const initialDataRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialDataRetryCountRef = useRef(0);
  const wasActiveRef = useRef(false);
  const userDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recipientDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onConsumeInitialEmployeeRef = useRef<(() => void) | undefined>(undefined);
  const loadAllDataRef = useRef<((isBackgroundRefresh?: boolean) => Promise<void>) | null>(null);
  const loadSentMessagesRef = useRef<((isBackgroundRefresh?: boolean) => Promise<void>) | null>(null);
  const loadTemplatesRef = useRef<(() => Promise<void>) | null>(null);
  const loadRecipientDetailsRef = useRef<((messageId: string) => Promise<void>) | null>(null);
  const recipientDetailsRequestsRef = useRef(new Set<string>());
  const recipientDetailsLoadingCountRef = useRef(0);
  const scopedEmployeeIdsRef = useRef(new Set<string>());
  const sentMessageIdsRef = useRef(new Set<string>());
  const allDataLoadingRef = useRef(false);
  const templatesLoadingRef = useRef(false);
  const sentMessagesLoadingRef = useRef(false);
  const sentMessagesRefreshPendingRef = useRef(false);
  onConsumeInitialEmployeeRef.current = onConsumeInitialEmployee;

  useEffect(() => {
    if (isActive && !wasActiveRef.current && !initialEmployee) {
      setSelectedEmployeeIds(new Set());
      if (hasInitiallyLoaded.current) {
        void loadAllDataRef.current?.(true);
        void loadSentMessagesRef.current?.(true);
      }
    }

    wasActiveRef.current = isActive;
  }, [isActive, initialEmployee]);

  useEffect(() => {
    if (!isActive || !initialEmployee) return;

    selectedAdminIdRef.current = initialEmployee.adminId;
    setSelectedAdminId(initialEmployee.adminId);
    setAdminGroups(previous => previous.some(group => group.id === initialEmployee.adminId)
      ? previous
      : [{
          id: initialEmployee.adminId,
          username: initialEmployee.adminUsername || '管理員群組',
          role: 'secondary_admin',
          total_employees: 1,
          active_employees: initialEmployee.isActive ? 1 : 0,
          verified_employees: initialEmployee.isVerified ? 1 : 0,
        }, ...previous]);
    setAllEmployees(previous => {
      const groupEmployees = previous.get(initialEmployee.adminId) || [];
      if (groupEmployees.some(employee => employee.id === initialEmployee.id)) return previous;

      const next = new Map(previous);
      next.set(initialEmployee.adminId, [{
        id: initialEmployee.id,
        username: initialEmployee.username,
        employee_id: initialEmployee.employeeId,
        is_active: initialEmployee.isActive,
        is_verified: initialEmployee.isVerified,
        total_income: 0,
        created_by: initialEmployee.adminId,
        tags: initialEmployee.tags,
        remarks: initialEmployee.remarks,
        is_pinned: false,
      }, ...groupEmployees]);
      return next;
    });
    setSearchQuery('');
    setFilterStatus('all');
    setSelectedTags(new Set());
    setSelectedEmployeeIds(new Set([initialEmployee.id]));

    if (loading) return;

    const targetGroup = Array.from(allEmployees.entries()).find(([, employees]) =>
      employees.some(employee => employee.id === initialEmployee.id),
    );
    if (!targetGroup) return;

    onConsumeInitialEmployeeRef.current?.();
  }, [isActive, initialEmployee, loading, allEmployees]);

  useEffect(() => {
    void loadAllDataRef.current?.();
    const auxiliaryDataTimer = globalThis.setTimeout(() => {
      void loadSentMessagesRef.current?.();
      void loadTemplatesRef.current?.();
    }, 250);

    const debouncedLoadAllData = () => {
      if (userDebounceTimer.current) clearTimeout(userDebounceTimer.current);
      userDebounceTimer.current = setTimeout(() => { void loadAllDataRef.current?.(true); }, 3000);
    };

    const debouncedLoadSentMessages = () => {
      if (recipientDebounceTimer.current) clearTimeout(recipientDebounceTimer.current);
      recipientDebounceTimer.current = setTimeout(() => { void loadSentMessagesRef.current?.(true); }, 2000);
    };

    const usersChannel = supabase
      .channel('msg-users-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, payload => {
        if (admin.role === 'secondary_admin') {
          const changedEmployee = (payload.new && Object.keys(payload.new).length > 0
            ? payload.new
            : payload.old) as { id?: unknown; created_by?: unknown };
          const employeeId = typeof changedEmployee?.id === 'string' ? changedEmployee.id : null;
          const createdBy = typeof changedEmployee?.created_by === 'string' ? changedEmployee.created_by : null;
          if (createdBy !== admin.id && (!employeeId || !scopedEmployeeIdsRef.current.has(employeeId))) return;
        }
        debouncedLoadAllData();
      })
      .subscribe();

    const adminsChannel = supabase
      .channel('msg-admins-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'admins' }, payload => {
        if (admin.role === 'secondary_admin') {
          const changedAdmin = (payload.new && Object.keys(payload.new).length > 0
            ? payload.new
            : payload.old) as { id?: unknown };
          if (changedAdmin?.id !== admin.id) return;
        }
        debouncedLoadAllData();
      })
      .subscribe();

    const recipientsChannel = supabase
      .channel('msg-recipients-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_recipients' }, payload => {
        if (admin.role === 'secondary_admin') {
          const changedRecipient = (payload.new && Object.keys(payload.new).length > 0
            ? payload.new
            : payload.old) as { message_id?: unknown };
          const messageId = typeof changedRecipient?.message_id === 'string' ? changedRecipient.message_id : null;
          if (payload.eventType !== 'DELETE' && (!messageId || !sentMessageIdsRef.current.has(messageId))) return;
        }
        debouncedLoadSentMessages();
      })
      .subscribe();

    return () => {
      globalThis.clearTimeout(auxiliaryDataTimer);
      if (userDebounceTimer.current) clearTimeout(userDebounceTimer.current);
      if (recipientDebounceTimer.current) clearTimeout(recipientDebounceTimer.current);
      if (initialDataRetryTimerRef.current) clearTimeout(initialDataRetryTimerRef.current);
      initialDataRetryTimerRef.current = null;
      supabase.removeChannel(usersChannel);
      supabase.removeChannel(adminsChannel);
      supabase.removeChannel(recipientsChannel);
    };
  }, [admin.id, admin.role]);

  useEffect(() => {
    if (!isActive) return;
    const refreshReadStatus = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void loadSentMessagesRef.current?.(true);
      }
    };
    window.addEventListener('online', refreshReadStatus);
    window.addEventListener('focus', refreshReadStatus);
    document.addEventListener('visibilitychange', refreshReadStatus);
    return () => {
      window.removeEventListener('online', refreshReadStatus);
      window.removeEventListener('focus', refreshReadStatus);
      document.removeEventListener('visibilitychange', refreshReadStatus);
    };
  }, [isActive]);

  // Close tag dropdown on outside click
  useEffect(() => {
    if (!showTagDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setShowTagDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTagDropdown]);

  useEffect(() => {
    if (!showGroupDropdown) return;
    const handleClick = (event: MouseEvent) => {
      if (groupDropdownRef.current && !groupDropdownRef.current.contains(event.target as Node)) {
        setShowGroupDropdown(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowGroupDropdown(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showGroupDropdown]);

  // Close template dropdown on outside click
  useEffect(() => {
    if (!showTemplateDropdown) return;
    const handleClick = (e: MouseEvent) => {
      if (templateDropdownRef.current && !templateDropdownRef.current.contains(e.target as Node)) {
        setShowTemplateDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showTemplateDropdown]);

  const loadAllData = async (isBackgroundRefresh = false) => {
    if (allDataLoadingRef.current) return;

    allDataLoadingRef.current = true;
    if (!isBackgroundRefresh) setLoading(true);
    try {
      let adminsQuery = supabase
        .from('admins')
        .select('id, username, role')
        .eq('is_active', true)
        .neq('role', 'emergency_admin')
        .order('role', { ascending: false })
        .order('username');

      if (admin.role === 'secondary_admin') {
        adminsQuery = adminsQuery.eq('id', admin.id);
      }

      let employeesQuery = supabase
        .from('users')
        .select('id, username, employee_id, is_active, is_verified, total_income, created_by, tags, remarks, is_pinned')
        .order('is_pinned', { ascending: false })
        .order('username')
        .order('id');

      if (admin.role === 'secondary_admin') {
        employeesQuery = employeesQuery.eq('created_by', admin.id);
      }

      const { data: allAdmins, error: adminsError } = await adminsQuery;
      if (adminsError) throw adminsError;

      const employeesData: Employee[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await employeesQuery.range(offset, offset + 499);
        if (error) throw error;
        employeesData.push(...(data || []));
        if (!data || data.length < 500) break;
      }

      scopedEmployeeIdsRef.current = admin.role === 'secondary_admin'
        ? new Set((employeesData || []).map(employee => employee.id))
        : new Set();

      const tagsSet = new Set<string>();
      employeesData?.forEach(emp => {
        if (emp.tags && Array.isArray(emp.tags)) {
          emp.tags.forEach((tag: string) => tagsSet.add(tag));
        }
      });
      setAllAvailableTags(Array.from(tagsSet).sort());

      const employeesByAdmin = new Map<string, Employee[]>();
      const countsByAdmin = new Map<string, { total: number; active: number; verified: number }>();

      employeesData?.forEach(emp => {
        const current = employeesByAdmin.get(emp.created_by) || [];
        current.push(emp);
        employeesByAdmin.set(emp.created_by, current);

        const counts = countsByAdmin.get(emp.created_by) || { total: 0, active: 0, verified: 0 };
        counts.total++;
        if (emp.is_active) counts.active++;
        if (emp.is_verified) counts.verified++;
        countsByAdmin.set(emp.created_by, counts);
      });

      const groups: AdminGroup[] = allAdmins?.map(a => ({
        id: a.id,
        username: a.username,
        role: a.role,
        total_employees: countsByAdmin.get(a.id)?.total || 0,
        active_employees: countsByAdmin.get(a.id)?.active || 0,
        verified_employees: countsByAdmin.get(a.id)?.verified || 0
      })) || [];

      const filteredGroups = admin.role === 'secondary_admin'
        ? groups.filter(g => g.id === admin.id)
        : groups;

      initialDataRetryCountRef.current = 0;
      if (initialDataRetryTimerRef.current) {
        clearTimeout(initialDataRetryTimerRef.current);
        initialDataRetryTimerRef.current = null;
      }
      setAdminGroups(filteredGroups);
      setAllEmployees(employeesByAdmin);

      if (admin.role === 'secondary_admin') {
        void loadSentMessagesRef.current?.(true);
      }

      if (filteredGroups.length > 0 && !selectedAdminIdRef.current) {
        selectedAdminIdRef.current = filteredGroups[0].id;
        setSelectedAdminId(filteredGroups[0].id);
      }
    } catch (error) {
      if (!isSupabaseAbortError(error)) {
        console.error('Error loading data:', formatSupabaseError(error));
      }

      if (initialDataRetryCountRef.current < 3) {
        initialDataRetryCountRef.current += 1;
        const retryDelay = Math.min(1000 * 2 ** (initialDataRetryCountRef.current - 1), 8000);
        if (initialDataRetryTimerRef.current) clearTimeout(initialDataRetryTimerRef.current);
        initialDataRetryTimerRef.current = setTimeout(() => {
          initialDataRetryTimerRef.current = null;
          void loadAllDataRef.current?.(true);
        }, retryDelay);
      }
    } finally {
      allDataLoadingRef.current = false;
      setLoading(false);
      hasInitiallyLoaded.current = true;
    }
  };
  loadAllDataRef.current = loadAllData;

  const loadTemplates = async () => {
    if (templatesLoadingRef.current) return;

    templatesLoadingRef.current = true;
    try {
      const { data, error } = await supabase
        .from('message_templates')
        .select('id, name, title, content')
        .eq('admin_id', admin.id)
        .order('sort_order')
        .order('created_at', { ascending: false });
      if (error) throw error;
      setTemplates(data || []);
    } catch (error) {
      if (!isSupabaseAbortError(error)) {
        console.error('Error loading templates:', formatSupabaseError(error));
      }
    } finally {
      templatesLoadingRef.current = false;
    }
  };

  const saveAsTemplate = async () => {
    if (!newTemplateName.trim()) return;
    setSavingTemplate(true);
    try {
      const htmlContent = templateEditorRef2.current?.getContent() || templateEditorContent;
      if (editingTemplateId) {
        const { error } = await supabase.from('message_templates').update({
          name: newTemplateName.trim(),
          title: templateFormTitle,
          content: htmlContent,
        }).eq('id', editingTemplateId);
        if (error) throw error;
        setNotification({ type: 'success', message: '範本已更新！' });
      } else {
        const { error } = await supabase.from('message_templates').insert({
          admin_id: admin.id,
          name: newTemplateName.trim(),
          title: templateFormTitle,
          content: htmlContent,
        });
        if (error) throw error;
        setNotification({ type: 'success', message: `範本「${newTemplateName.trim()}」已儲存！` });
      }
      setEditingTemplateId(null);
      setNewTemplateName('');
      setTemplateEditorContent('');
      setTemplateFormTitle('');
      templateEditorRef2.current?.getEditor()?.commands.clearContent();
      loadTemplates();
    } catch (error: unknown) {
      setNotification({ type: 'error', message: formatSupabaseError(error) || '儲存範本失敗' });
    } finally {
      setSavingTemplate(false);
    }
  };

  const startEditTemplate = (tpl: typeof templates[0]) => {
    setEditingTemplateId(tpl.id);
    setNewTemplateName(tpl.name);
    setTemplateFormTitle(tpl.title);
    setTemplateEditorContent(tpl.content);
    templateEditorRef2.current?.getEditor()?.commands.setContent(tpl.content);
  };

  const startNewTemplate = () => {
    setEditingTemplateId(null);
    setNewTemplateName('');
    setTemplateFormTitle('');
    setTemplateEditorContent('');
    templateEditorRef2.current?.getEditor()?.commands.clearContent();
  };

  const applyTemplate = (template: typeof templates[0]) => {
    setMessageForm(prev => ({
      ...prev,
      title: template.title,
      content: template.content,
    }));
    composeEditorRef.current?.getEditor()?.commands.setContent(template.content);
    setShowTemplateDropdown(false);
    setNotification({ type: 'success', message: `已套用範本「${template.name}」` });
  };

  const deleteTemplate = async (templateId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const { error } = await supabase.from('message_templates').delete().eq('id', templateId);
      if (error) throw error;
      loadTemplates();
    } catch (error) {
      console.error('Error deleting template:', error);
    }
  };

  const toggleEmployeeSelection = (employeeId: string) => {
    setSelectedEmployeeIds(prev => {
      const next = new Set(prev);
      if (next.has(employeeId)) {
        next.delete(employeeId);
      } else {
        next.add(employeeId);
      }
      return next;
    });
  };

  const selectAllEmployees = () => {
    const allIds: string[] = [];
    adminGroups.forEach(group => {
      const employees = allEmployees.get(group.id) || [];
      employees.forEach(emp => allIds.push(emp.id));
    });
    setSelectedEmployeeIds(new Set(allIds));
  };

  const clearSelection = () => {
    setSelectedEmployeeIds(new Set());
  };

  const getFilteredEmployees = (): Employee[] => {
    if (!selectedAdminId) return [];
    const employees = allEmployees.get(selectedAdminId) || [];
    let filtered = employees;

    if (filterStatus === 'active') {
      filtered = filtered.filter(e => e.is_active);
    } else if (filterStatus === 'verified') {
      filtered = filtered.filter(e => e.is_verified);
    }

    if (selectedTags.size > 0) {
      filtered = filtered.filter(e => {
        if (!e.tags || !Array.isArray(e.tags)) return false;
        return Array.from(selectedTags).some(tag => e.tags.includes(tag));
      });
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(e =>
        e.username.toLowerCase().includes(query) ||
        e.employee_id.toLowerCase().includes(query)
      );
    }

    return [...filtered].sort((a, b) => Number(selectedEmployeeIds.has(b.id)) - Number(selectedEmployeeIds.has(a.id)));
  };

  const toggleTagFilter = (tag: string) => {
    setSelectedTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) {
        next.delete(tag);
      } else {
        next.add(tag);
      }
      return next;
    });
  };

  const clearTagFilter = () => {
    setSelectedTags(new Set());
  };

  const validateAndSendMessage = async () => {
    if (!messageForm.title.trim()) {
      setNotification({ type: 'error', message: '請輸入訊息標題' });
      return;
    }

    const content = composeEditorRef.current?.getContent() || '';
    if (!content.trim() || content === '<p></p>') {
      setNotification({ type: 'error', message: '請輸入訊息內容' });
      return;
    }

    if (selectedEmployeeIds.size === 0) {
      setNotification({ type: 'error', message: '請至少選擇一位收件人' });
      return;
    }

    if (admin.role === 'secondary_admin') {
      const myEmployees = allEmployees.get(admin.id) || [];
      const myEmployeeIds = new Set(myEmployees.map(e => e.id));
      const unauthorized = Array.from(selectedEmployeeIds).filter(id => !myEmployeeIds.has(id));

      if (unauthorized.length > 0) {
        setNotification({
          type: 'error',
          message: `無法向 ${unauthorized.length} 名不屬於您管理範圍的員工發送訊息`
        });
        return;
      }
    }

    if (manualRewardEnabled) {
      const amount = Number(manualRewardAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        setNotification({ type: 'error', message: '請輸入有效的績效獎金金額' });
        return;
      }
      setShowRewardConfirm(true);
      return;
    }

    await sendMessage();
  };

  const sendMessage = async () => {
    setSending(true);
    setSendProgress({ sent: 0, total: selectedEmployeeIds.size });

    try {
      const htmlContent = composeEditorRef.current?.getContent() || '';
      const rewardAmount = manualRewardEnabled ? Number(manualRewardAmount) : null;
      if (manualRewardEnabled && (!Number.isFinite(rewardAmount) || Number(rewardAmount) <= 0)) {
        throw new Error('請輸入有效的績效獎金金額');
      }

      const recipientIds = Array.from(selectedEmployeeIds).sort();
      const requestFingerprint = JSON.stringify({
        recipientIds,
        title: messageForm.title.trim(),
        content: htmlContent,
        deliveryMode: messageForm.deliveryMode,
        priority: messageForm.priority,
        rewardAmount,
      });
      if (manualSendOperationRef.current?.fingerprint !== requestFingerprint) {
        manualSendOperationRef.current = {
          id: crypto.randomUUID(),
          fingerprint: requestFingerprint,
        };
      }

      const { data, error } = await supabase.rpc('send_admin_message_with_delivery', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_recipient_ids: recipientIds,
        p_title: messageForm.title.trim(),
        p_content: htmlContent,
        p_delivery_mode: messageForm.deliveryMode,
        p_priority: messageForm.priority,
        p_reward_amount: rewardAmount,
        p_operation_id: manualSendOperationRef.current.id,
      });
      if (error) throw error;

      const result = data as { sent_count?: number; total_reward?: number; currency?: string | null } | null;
      const successCount = Number(result?.sent_count || 0);
      setSendProgress({ sent: successCount, total: selectedEmployeeIds.size });
      setNotification({
        type: 'success',
        message: manualRewardEnabled
          ? `已向 ${successCount} 名員工發送通知並發放 ${Number(result?.total_reward || 0).toFixed(2)} ${result?.currency || currencyUnit}`
          : `訊息已成功發送給 ${successCount} 名員工`,
      });

      manualSendOperationRef.current = null;
      setMessageForm({ title: '', content: '', deliveryMode: 'realtime_with_login_fallback', priority: 'normal' });
      setManualRewardEnabled(false);
      setManualRewardAmount('');
      composeEditorRef.current?.getEditor()?.commands.clearContent();
      setSelectedEmployeeIds(new Set());
      await loadSentMessages();
    } catch (error: unknown) {
      console.error('Error sending message:', formatSupabaseError(error));
      setNotification({ type: 'error', message: formatSupabaseError(error) || '訊息發送失敗' });
    } finally {
      setSending(false);
      setSendProgress(null);
    }
  };
  loadTemplatesRef.current = loadTemplates;

  const loadSentMessages = async (isBackgroundRefresh = false) => {
    if (sentMessagesLoadingRef.current) {
      sentMessagesRefreshPendingRef.current = true;
      return;
    }

    sentMessagesLoadingRef.current = true;
    if (!isBackgroundRefresh) setMessagesLoading(true);
    try {
      const allMessages: Message[] = [];
      for (let offset = 0; ; offset += 200) {
        let query = supabase
          .from('messages')
          .select('*')
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .range(offset, offset + 199);
        if (admin.role !== 'super_admin' && !admin.is_super_admin) {
          query = query.eq('sender_id', admin.id);
        }
        const { data, error } = await query;
        if (error) throw error;
        allMessages.push(...(data || []) as Message[]);
        if (!data || data.length < 200) break;
      }

      const messageIds = allMessages.map(message => message.id);
      const allRecipients: Array<{ message_id: string; recipient_id: string; is_read: boolean | null; read_at: string | null }> = [];
      const scopedEmployeeIds = Array.from(scopedEmployeeIdsRef.current);
      const employeeBatches = admin.role === 'secondary_admin'
        ? Array.from({ length: Math.ceil(scopedEmployeeIds.length / 100) }, (_, index) => scopedEmployeeIds.slice(index * 100, index * 100 + 100))
        : [null];
      for (let index = 0; index < messageIds.length; index += 50) {
        const batch = messageIds.slice(index, index + 50);
        for (const employeeBatch of employeeBatches) {
          for (let offset = 0; ; offset += 500) {
            let query = supabase
              .from('message_recipients')
              .select('message_id, recipient_id, is_read, read_at')
              .in('message_id', batch)
              .order('id')
              .range(offset, offset + 499);
            if (employeeBatch) query = query.in('recipient_id', employeeBatch);
            const { data, error } = await query;
            if (error) throw error;
            allRecipients.push(...(data || []));
            if (!data || data.length < 500) break;
          }
        }
      }

      const recipientIds = Array.from(new Set(allRecipients.map(recipient => recipient.recipient_id)));
      const recipientUsers: Array<{ id: string; username: string; employee_id: string; is_verified: boolean }> = [];
      for (let index = 0; index < recipientIds.length; index += 100) {
        let query = supabase
          .from('users')
          .select('id, username, employee_id, is_verified')
          .in('id', recipientIds.slice(index, index + 100));
        if (admin.role === 'secondary_admin') query = query.eq('created_by', admin.id);
        const { data, error } = await query;
        if (error) throw error;
        recipientUsers.push(...(data || []));
      }

      const recipientEmployeeMap = new Map(recipientUsers?.map(user => [user.id, user]) || []);
      const recipientsByMessage = new Map<string, string[]>();
      const statsByMessage = new Map<string, MessageStats>();
      const readIdsByMessage = new Map<string, Set<string>>();
      const recipientDetailsByMessage = new Map<string, { read: Employee[]; unread: Employee[] }>();

      messageIds.forEach(msgId => {
        recipientsByMessage.set(msgId, []);
        readIdsByMessage.set(msgId, new Set());
        recipientDetailsByMessage.set(msgId, { read: [], unread: [] });
        statsByMessage.set(msgId, { total_recipients: 0, read_count: 0, unread_count: 0, read_percentage: 0 });
      });

      (allRecipients || []).forEach(recipient => {
        const recipientList = recipientsByMessage.get(recipient.message_id)!;
        recipientList.push(recipient.recipient_id);
        if (recipient.is_read) readIdsByMessage.get(recipient.message_id)!.add(recipient.recipient_id);

        const employee = recipientEmployeeMap.get(recipient.recipient_id);
        if (employee) {
          const details = recipientDetailsByMessage.get(recipient.message_id)!;
          const recipientEmployee = { ...employee, message_read_at: recipient.read_at } as Employee;
          if (recipient.is_read) details.read.push(recipientEmployee);
          else details.unread.push(recipientEmployee);
        }

        const stats = statsByMessage.get(recipient.message_id)!;
        stats.total_recipients++;
        if (recipient.is_read) stats.read_count++;
        else stats.unread_count++;
        stats.read_percentage = Math.round((stats.read_count / stats.total_recipients) * 100);
      });

      const messagesWithRecipients = allMessages.map(msg => ({
        ...msg,
        recipient_ids: recipientsByMessage.get(msg.id) || []
      }));

      sentMessageIdsRef.current = new Set(messageIds);
      setSentMessages(messagesWithRecipients);
      setSelectedMessageDetail(previous => previous ? messagesWithRecipients.find(message => message.id === previous.id) || null : null);
      setMessageStats(statsByMessage);
      setReadRecipientIdsByMessage(readIdsByMessage);
      setRecipientDetails(recipientDetailsByMessage);
      setMessagesError(false);
      if (!isBackgroundRefresh) setSelectedMessageIds(new Set());
    } catch (error) {
      if (!isSupabaseAbortError(error)) {
        console.error('Error loading messages:', formatSupabaseError(error));
        setMessagesError(true);
      }
    } finally {
      sentMessagesLoadingRef.current = false;
      if (!isBackgroundRefresh) setMessagesLoading(false);

      if (sentMessagesRefreshPendingRef.current) {
        sentMessagesRefreshPendingRef.current = false;
        void loadSentMessages(true);
      }
    }
  };
  loadSentMessagesRef.current = loadSentMessages;

  const loadRecipientDetails = async (messageId: string) => {
    if (recipientDetails.has(messageId) || recipientDetailsRequestsRef.current.has(messageId)) return;

    recipientDetailsRequestsRef.current.add(messageId);
    recipientDetailsLoadingCountRef.current += 1;
    setLoadingRecipientDetails(true);
    try {
      const scopedEmployeeIds = Array.from(scopedEmployeeIdsRef.current);
      const employeeBatches = admin.role === 'secondary_admin'
        ? Array.from({ length: Math.ceil(scopedEmployeeIds.length / 100) }, (_, index) => scopedEmployeeIds.slice(index * 100, index * 100 + 100))
        : [null];
      const recipients: Array<{ recipient_id: string; is_read: boolean | null; read_at: string | null }> = [];
      for (const employeeBatch of employeeBatches) {
        for (let offset = 0; ; offset += 500) {
          let query = supabase
            .from('message_recipients')
            .select('recipient_id, is_read, read_at')
            .eq('message_id', messageId)
            .order('id')
            .range(offset, offset + 499);
          if (employeeBatch) query = query.in('recipient_id', employeeBatch);
          const { data, error } = await query;
          if (error) throw error;
          recipients.push(...(data || []));
          if (!data || data.length < 500) break;
        }
      }

      const rIds = recipients.map(r => r.recipient_id);
      if (rIds.length === 0) {
        setRecipientDetails(prev => new Map(prev).set(messageId, { read: [], unread: [] }));
        return;
      }

      const employeeMap = new Map(
        Array.from(allEmployees.values())
          .flat()
          .map(employee => [employee.id, employee] as const),
      );
      const missingRecipientIds = rIds.filter(recipientId => !employeeMap.has(recipientId));

      for (let index = 0; index < missingRecipientIds.length; index += 100) {
        let employeesQuery = supabase
          .from('users')
          .select('id, username, employee_id, is_verified')
          .in('id', missingRecipientIds.slice(index, index + 100));
        if (admin.role === 'secondary_admin') employeesQuery = employeesQuery.eq('created_by', admin.id);
        const { data, error } = await employeesQuery;
        if (error) throw error;
        data?.forEach(employee => employeeMap.set(employee.id, employee as Employee));
      }
      const read: Employee[] = [];
      const unread: Employee[] = [];

      recipients.forEach(r => {
        const emp = employeeMap.get(r.recipient_id);
        if (emp) {
          const recipientEmployee = { ...emp, message_read_at: r.read_at } as Employee;
          if (r.is_read) read.push(recipientEmployee);
          else unread.push(recipientEmployee);
        }
      });

      setRecipientDetails(prev => new Map(prev).set(messageId, { read, unread }));
    } catch (error) {
      if (!isSupabaseAbortError(error)) {
        console.error('Error loading recipient details:', formatSupabaseError(error));
      }
    } finally {
      recipientDetailsRequestsRef.current.delete(messageId);
      recipientDetailsLoadingCountRef.current = Math.max(0, recipientDetailsLoadingCountRef.current - 1);
      setLoadingRecipientDetails(recipientDetailsLoadingCountRef.current > 0);
    }
  };
  loadRecipientDetailsRef.current = loadRecipientDetails;

  const handleConfirmDelete = async () => {
    const messageIds = deleteMode === 'selected'
      ? Array.from(selectedMessageIds).filter(id => manageableGroupMessages.some(message => message.id === id))
      : deleteMode === 'all' ? manageableGroupMessages.map(message => message.id) : [];
    if (deleting || messageIds.length === 0) return;

    setDeleting(true);
    setDeleteProgress({ completed: 0, total: messageIds.length });
    let deletedCount = 0;
    try {
      for (let index = 0; index < messageIds.length; index += 100) {
        const batch = messageIds.slice(index, index + 100);
        const result = await mutateAuditedContent('notification_delete', batch);
        deletedCount += result.changed_count;
        const deletedIds = new Set(batch);
        setSentMessages(previous => previous.filter(message => !deletedIds.has(message.id)));
        setSelectedMessageIds(previous => new Set([...previous].filter(id => !deletedIds.has(id))));
        setDeleteProgress({ completed: index + batch.length, total: messageIds.length });
      }
      setShowDeleteConfirm(false);
      setDeleteMode(null);
      setSelectedMessageDetail(null);
      exitSelectionMode();
      setNotification({ type: 'success', message: `已刪除 ${deletedCount} 則已發通知` });
    } catch (error) {
      console.error('Error deleting messages:', error);
      setShowDeleteConfirm(false);
      setDeleteMode(null);
      setNotification({ type: 'error', message: deletedCount > 0
        ? `已刪除 ${deletedCount} 則，其餘未完成；請重新整理後再試。`
        : '刪除訊息失敗；請重新整理後確認狀態。' });
    } finally {
      setDeleting(false);
      setDeleteProgress(null);
      void loadSentMessages(true);
    }
  };

  const handleStartEdit = (msg: Message) => {
    setEditForm({ title: msg.title, content: msg.content });
    setEditingMessage(true);
  };

  const handleSaveEdit = async () => {
    if (!selectedMessageDetail) return;
    const htmlContent = editEditorRef.current?.getContent() || '';
    if (!editForm.title.trim() || !htmlContent.trim() || htmlContent === '<p></p>') {
      setNotification({ type: 'error', message: '標題和內容不能為空' });
      return;
    }

    setSaving(true);
    try {
      await mutateAuditedContent('notification_edit', [selectedMessageDetail.id], {
        title: editForm.title.trim(), content: htmlContent,
      });

      setSelectedMessageDetail({ ...selectedMessageDetail, title: editForm.title.trim(), content: htmlContent });
      setEditingMessage(false);
      setNotification({ type: 'success', message: '訊息已成功更新' });
      loadSentMessages();
    } catch (error: unknown) {
      console.error('Error updating message:', formatSupabaseError(error));
      setNotification({ type: 'error', message: formatSupabaseError(error) || '更新訊息失敗' });
    } finally {
      setSaving(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingMessage(false);
    setEditForm({ title: '', content: '' });
  };

  const toggleMessageSelection = (messageId: string) => {
    const newSelection = new Set(selectedMessageIds);
    if (newSelection.has(messageId)) newSelection.delete(messageId);
    else newSelection.add(messageId);
    setSelectedMessageIds(newSelection);
  };

  const enterSelectionMode = () => {
    setSelectionMode(true);
    setSelectedMessageIds(new Set());
  };

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedMessageIds(new Set());
  };

  const selectedGroupEmployeeIds = new Set(
    (selectedAdminId ? allEmployees.get(selectedAdminId) || [] : []).map(employee => employee.id),
  );
  const selectedGroupMessages = sentMessages.filter(message => (
    !selectedAdminId
    || (message.recipient_ids || []).some(recipientId => selectedGroupEmployeeIds.has(recipientId))
    || (message.recipient_ids?.length === 0 && message.sender_id === selectedAdminId)
  ));
  const getSelectedGroupMessageStats = (message: Message): MessageStats => {
    const existingStats = messageStats.get(message.id) || {
      total_recipients: 0,
      read_count: 0,
      unread_count: 0,
      read_percentage: 0,
    };
    if (!selectedAdminId) return existingStats;

    const scopedRecipientIds = (message.recipient_ids || [])
      .filter(recipientId => selectedGroupEmployeeIds.has(recipientId));
    const readRecipientIds = readRecipientIdsByMessage.get(message.id) || new Set<string>();
    const readCount = scopedRecipientIds.filter(recipientId => readRecipientIds.has(recipientId)).length;
    const totalRecipients = scopedRecipientIds.length;

    return {
      total_recipients: totalRecipients,
      read_count: readCount,
      unread_count: totalRecipients - readCount,
      read_percentage: totalRecipients > 0 ? Math.round((readCount / totalRecipients) * 100) : 0,
    };
  };
  const visibleGroupMessages = selectedGroupMessages.filter(message =>
    messageOriginFilter === 'all'
      || (messageOriginFilter === 'manual' && message.audit_origin === 'manual_admin' && message.automation_execution_id === null)
      || (messageOriginFilter === 'automation' && (message.audit_origin === 'automation' || message.automation_execution_id !== null))
  );
  const manageableGroupMessages = visibleGroupMessages.filter(message => message.automation_execution_id === null && message.audit_origin !== 'automation');
  const sentMessageReadSummary = visibleGroupMessages.reduce(
    (summary, message) => {
      const stats = getSelectedGroupMessageStats(message);
      const isFullyRead = stats.total_recipients > 0 && stats.read_count === stats.total_recipients;

      if (stats.total_recipients === 0) summary.no_recipients += 1;
      else if (isFullyRead) summary.read += 1;
      else summary.unread += 1;
      return summary;
    },
    { total: visibleGroupMessages.length, read: 0, unread: 0, no_recipients: 0 },
  );

  const filteredMessages = visibleGroupMessages.filter(msg => {
    if (messageTypeFilter !== 'all' && getDeliveryMode(msg) !== messageTypeFilter) return false;
    if (messageScopeFilter !== 'all') {
      const isBroadcast = !msg.recipient_ids || msg.recipient_ids.length === 0;
      if (messageScopeFilter === 'broadcast' && !isBroadcast) return false;
      if (messageScopeFilter === 'targeted' && isBroadcast) return false;
    }
    if (readStatusFilter !== 'all') {
      const stats = getSelectedGroupMessageStats(msg);
      if (readStatusFilter === 'read' && (stats.total_recipients === 0 || stats.read_count !== stats.total_recipients)) return false;
      if (readStatusFilter === 'unread' && (stats.total_recipients === 0 || stats.read_count === stats.total_recipients)) return false;
      if (readStatusFilter === 'no_recipients' && stats.total_recipients !== 0) return false;
    }
    if (sentMessagesSearchQuery.trim()) {
      const query = sentMessagesSearchQuery.trim().toLowerCase();
      const recipients = recipientDetails.get(msg.id);
      const matchesRecipient = [...(recipients?.read || []), ...(recipients?.unread || [])]
        .filter(employee => !selectedAdminId || selectedGroupEmployeeIds.has(employee.id))
        .some(employee => employee.username.toLowerCase().includes(query)
          || employee.employee_id.toLowerCase().includes(query));
      if (!matchesRecipient) return false;
    }
    return true;
  });

  useEffect(() => {
    setSelectedMessageIds(new Set());
  }, [selectedAdminId, messageOriginFilter, messageTypeFilter, messageScopeFilter, readStatusFilter, sentMessagesSearchQuery]);

  const selectableMessages = filteredMessages.filter(message => message.automation_execution_id === null && message.audit_origin !== 'automation');
  const allSelectableSelected = selectableMessages.length > 0 && selectableMessages.every(message => selectedMessageIds.has(message.id));
  const toggleSelectAll = () => {
    const nextSelection = new Set(selectedMessageIds);
    if (allSelectableSelected) selectableMessages.forEach(message => nextSelection.delete(message.id));
    else selectableMessages.forEach(message => nextSelection.add(message.id));
    setSelectedMessageIds(nextSelection);
  };

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  const getPriorityLabel = (priority: Message['priority']) => ({
    low: '低',
    normal: '普通',
    high: '重要',
    urgent: '緊急',
  })[priority];

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'urgent': return 'text-red-400 bg-red-500/10 border-red-500/30';
      case 'high': return 'text-amber-400 bg-amber-500/10 border-amber-500/30';
      case 'normal': return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30';
      case 'low': return 'text-slate-400 bg-slate-500/10 border-slate-500/30';
      default: return 'text-slate-400 bg-slate-500/10 border-slate-500/30';
    }
  };

  if (loading && !initialEmployee) {
    return (
      <div className="flex min-h-[280px] flex-1 flex-col items-center justify-center gap-4 text-center text-slate-400">
        <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-300/25 bg-cyan-400/10 shadow-[0_0_30px_rgba(34,211,238,0.12)]">
          <span className="absolute inset-1 animate-ping rounded-xl border border-cyan-300/25 [animation-duration:1.6s]" />
          <span className="relative h-8 w-8 animate-spin rounded-full border-[3px] border-cyan-300/25 border-t-cyan-300" />
        </div>
        <div>
          <p className="text-sm font-semibold text-cyan-100">正在載入訊息</p>
          <p className="mt-1 text-[11px] text-slate-500">正在準備頁面資料，請稍候……</p>
        </div>
      </div>
    );
  }

  const allEmployeesFlat = Array.from(allEmployees.values()).flat();
  const filteredEmployees = getFilteredEmployees();
  const selectedAdminGroup = adminGroups.find(group => group.id === selectedAdminId);
  const selectedGroupEmployees = selectedAdminId ? allEmployees.get(selectedAdminId) || [] : allEmployeesFlat;
  const tagEmployeeCounts = new Map<string, number>();
  selectedGroupEmployees.forEach(employee => {
    new Set(employee.tags || []).forEach(tag => {
      tagEmployeeCounts.set(tag, (tagEmployeeCounts.get(tag) || 0) + 1);
    });
  });
  const selectedGroupEmployeeCount = selectedAdminGroup?.total_employees ?? selectedGroupEmployees.length;
  const selectedInCurrentGroup = selectedGroupEmployees.filter(employee => selectedEmployeeIds.has(employee.id)).length;
  const allEmployeesSelected = allEmployeesFlat.length > 0 && allEmployeesFlat.every(emp => selectedEmployeeIds.has(emp.id));
  const selectedDeliveryMode = selectedMessageDetail ? getDeliveryMode(selectedMessageDetail) : 'realtime_only';
  const messageTypeTone = getMessageTypeTone(selectedDeliveryMode);
  const messagePriorityTone = getMessagePriorityTone(selectedMessageDetail?.priority || 'normal');
  const employeePreviewDialog = employeePreviewOpen && createPortal(
    <div
      className="fixed inset-0 z-[180] flex items-center justify-center bg-slate-900/45 p-0 backdrop-blur-sm sm:p-4"
      role="presentation"
      onMouseDown={() => setEmployeePreviewOpen(false)}
    >
      <div
        className="pointer-events-auto flex h-full w-full max-w-2xl flex-col overflow-hidden sm:h-[82vh] sm:max-h-[88vh] sm:rounded-3xl sm:shadow-2xl sm:shadow-blue-900/20"
        onMouseDown={event => event.stopPropagation()}
      >
        <EmployeeNotificationDetailPanel
          message={{
            title: messageForm.title || '通知標題',
            content: messageForm.content || '<p>通知內容</p>',
            message_type: messageForm.deliveryMode === 'login_only' ? 'login_popup' : 'realtime',
            priority: messageForm.priority,
            notification_category: manualRewardEnabled ? 'performance_reward' : null,
            reward_amount: manualRewardEnabled ? Number(manualRewardAmount || 0) : null,
            reward_currency: currencyUnit,
            created_at: new Date().toISOString(),
            is_read: false,
          }}
          onClose={() => setEmployeePreviewOpen(false)}
        />
      </div>
    </div>,
    document.body,
  );

  if (showAutomation) {
    return (
      <>
        <NotificationAutomation
          admin={admin}
          employees={allEmployeesFlat}
          isActive={isActive}
          onBack={() => setShowAutomation(false)}
        />
        {notification && createPortal(
          <div role={notification.type === 'error' ? 'alert' : 'status'} className={`fixed right-4 top-4 z-[10010] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border px-4 py-3 shadow-2xl backdrop-blur-xl transition-all duration-300 sm:max-w-md ${
            notification.type === 'success'
              ? 'border-green-500/50 bg-green-900/90 text-green-100'
              : 'border-red-500/50 bg-red-900/90 text-red-100'
          }`}>
            {notification.type === 'success' ? <Bell className="h-5 w-5" /> : <AlertCircle className="h-5 w-5" />}
            <span className="font-medium">{notification.message}</span>
            <button type="button" onClick={() => setNotification(null)} aria-label="關閉提示" className="ml-2 text-white/60 transition-colors hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>, document.body,
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {employeePreviewDialog}
      {employeeTagPreview && createPortal(
        <div
          className="pointer-events-none fixed z-[220] max-w-[calc(100vw-2rem)] -translate-y-1/2 rounded-xl border border-amber-300 bg-amber-100 px-2.5 py-2 text-amber-950 shadow-[0_14px_32px_rgba(120,53,15,0.3)]"
          style={{
            left: employeeTagPreview.left,
            top: employeeTagPreview.top,
            maxWidth: `calc(100vw - ${employeeTagPreview.left + 16}px)`,
          }}
        >
          <div className="flex flex-wrap items-center gap-1">
            {employeeTagPreview.tags.map((tag, index) => (
              <span key={`${employeeTagPreview.employeeId}-${index}`} className="rounded-full border border-amber-700 bg-amber-900 px-2 py-0.5 text-[10px] font-semibold text-amber-100 shadow-sm">
                {tag}
              </span>
            ))}
          </div>
        </div>,
        document.body,
      )}
      {showRewardConfirm && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-amber-400/30 bg-slate-900 shadow-2xl shadow-amber-950/50">
            <div className="bg-gradient-to-r from-amber-500/20 to-orange-500/10 p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-400 text-amber-950"><Gift className="h-5 w-5" /></div>
                <div><h3 className="font-bold text-amber-100">確認發放績效獎金</h3><p className="mt-1 text-xs leading-5 text-amber-200/60">獎金會在訊息發送時立即加入員工錢包，不需要員工點擊領取。</p></div>
              </div>
            </div>
            <div className="space-y-3 p-5">
              <div className="grid grid-cols-2 gap-3 text-center">
                <div className="rounded-xl bg-slate-950 p-3"><p className="text-[10px] text-slate-500">收件員工</p><p className="mt-1 text-lg font-black text-white">{selectedEmployeeIds.size} 人</p></div>
                <div className="rounded-xl bg-slate-950 p-3"><p className="text-[10px] text-slate-500">每人獎金</p><p className="mt-1 text-lg font-black text-amber-300">{Number(manualRewardAmount || 0).toFixed(2)} {currencyUnit}</p></div>
              </div>
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 p-3 text-center"><p className="text-[10px] font-bold uppercase tracking-wider text-amber-300/60">預計發放總額</p><p className="mt-1 text-2xl font-black text-amber-200">{(Number(manualRewardAmount || 0) * selectedEmployeeIds.size).toFixed(2)} {currencyUnit}</p></div>
            </div>
            <div className="flex gap-3 border-t border-slate-700 p-4">
              <button onClick={() => setShowRewardConfirm(false)} className="h-10 flex-1 rounded-xl border border-slate-700 bg-slate-800 text-sm font-bold text-slate-300 hover:bg-slate-700">取消</button>
              <button onClick={() => { setShowRewardConfirm(false); void sendMessage(); }} className="h-10 flex-1 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-sm font-black text-amber-950 shadow-lg shadow-amber-950/40">確認發放</button>
            </div>
          </div>
        </div>
      )}

      {/* Notification */}
      {notification && createPortal(
        <div role={notification.type === 'error' ? 'alert' : 'status'} className={`fixed top-4 right-4 z-[10010] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-lg border px-4 py-3 shadow-2xl backdrop-blur-xl transition-all duration-300 sm:max-w-md ${
          notification.type === 'success'
            ? 'bg-green-900/90 border-green-500/50 text-green-100'
            : 'bg-red-900/90 border-red-500/50 text-red-100'
        }`}>
          {notification.type === 'success' ? <Bell className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          <span className="font-medium">{notification.message}</span>
          <button type="button" onClick={() => setNotification(null)} aria-label="關閉提示" className="ml-2 text-white/60 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>, document.body,
      )}

      {/* Send Progress */}
      {sendProgress && (
        <div className="fixed bottom-4 right-4 bg-slate-800 rounded-xl p-4 shadow-2xl border border-blue-500/30 z-50">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 border-4 border-blue-400 border-t-transparent rounded-full animate-spin" />
            <div>
              <div className="font-bold text-white">訊息發送中...</div>
              <div className="text-sm text-slate-400">{sendProgress.sent} / {sendProgress.total} 已發送</div>
            </div>
          </div>
          <div className="w-64 h-2 bg-slate-700 rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-500 transition-all duration-300" style={{ width: `${(sendProgress.sent / sendProgress.total) * 100}%` }} />
          </div>
        </div>
      )}

      {/* Top Bar */}
      <div className="relative flex items-center justify-between overflow-visible border-b border-blue-300/20 bg-gradient-to-r from-slate-950 via-blue-950/95 to-cyan-950/90 px-5 py-2.5 shadow-[0_8px_24px_rgba(15,23,42,0.28)]">
        <div className="pointer-events-none absolute inset-y-0 left-12 w-56 bg-blue-400/10 blur-2xl" />
        <div className="relative flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-blue-200/25 bg-gradient-to-br from-blue-500 to-cyan-500 text-white shadow-sm shadow-blue-950/50">
            <Send className="h-4 w-4" />
          </div>
          <h2 className="text-base font-bold tracking-tight text-white">訊息</h2>
          <div className="flex h-8 w-56 shrink-0 overflow-hidden rounded-lg border border-emerald-300/35 bg-gradient-to-r from-emerald-950/95 via-teal-950/90 to-blue-950/90 shadow-[0_8px_20px_rgba(6,78,59,0.28)] ring-1 ring-cyan-300/10">
            <div className="flex min-w-0 flex-1 items-center gap-2 px-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-emerald-200/30 bg-gradient-to-br from-emerald-400/30 to-blue-400/25 text-emerald-100 shadow-inner shadow-white/10">
                <Users className="h-3.5 w-3.5" />
              </span>
              <span className="text-base font-black tabular-nums leading-none text-white">{selectedGroupEmployeeCount}</span>
              <span className="truncate text-[10px] font-bold text-emerald-100/75">名員工</span>
            </div>
            <div className={`flex h-full min-w-[88px] shrink-0 items-center justify-center gap-1.5 border-l px-2.5 transition-all ${selectedInCurrentGroup > 0 ? 'border-blue-100/55 bg-gradient-to-r from-blue-600 via-blue-500 to-cyan-500 text-white shadow-[-7px_0_18px_rgba(37,99,235,0.3)]' : 'border-blue-300/20 bg-blue-950/65 text-blue-300/70'}`}>
              <Check className="h-3.5 w-3.5" strokeWidth={3} />
              <span className="text-[11px] font-black">已選</span>
              <span className="text-sm font-black tabular-nums leading-none">{selectedInCurrentGroup}</span>
            </div>
          </div>
        </div>
        <div className="relative flex shrink-0 items-center gap-2">
          {admin.role !== 'secondary_admin' && (
            <div ref={groupDropdownRef} className="relative">
              <button
                type="button"
                onClick={() => setShowGroupDropdown(previous => !previous)}
                aria-expanded={showGroupDropdown}
                aria-haspopup="menu"
                className={`flex h-8 w-64 items-center gap-2 rounded-lg border px-2.5 text-[11px] font-bold transition-all ${showGroupDropdown ? 'border-blue-200/70 bg-gradient-to-r from-blue-500 to-cyan-500 text-white shadow-[0_0_18px_rgba(59,130,246,0.3)]' : 'border-blue-300/30 bg-gradient-to-r from-blue-600/25 to-cyan-500/15 text-blue-100 hover:border-blue-200/60 hover:from-blue-500/35 hover:to-cyan-400/25'}`}
              >
                <Users className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left">{selectedAdminGroup?.username || '選擇群組'}</span>
                <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-black tabular-nums ${showGroupDropdown ? 'border-white/25 bg-white/15 text-white' : 'border-blue-300/25 bg-blue-400/15 text-blue-200'}`}>
                  {selectedAdminGroup?.total_employees ?? 0}
                </span>
                <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${showGroupDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showGroupDropdown && (
                <div className="absolute right-0 top-full z-[80] mt-2 w-64 overflow-hidden rounded-2xl border border-blue-300/30 bg-gradient-to-br from-blue-950 via-slate-950 to-cyan-950 shadow-[0_20px_48px_rgba(2,6,23,0.68)] ring-1 ring-white/[0.04] backdrop-blur-xl">
                  <div className="pointer-events-none absolute -right-10 -top-12 h-32 w-32 rounded-full bg-blue-400/15 blur-3xl" />
                  <div className="relative border-b border-blue-200/15 bg-gradient-to-r from-blue-500/20 via-cyan-500/10 to-transparent px-3.5 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-8 w-8 items-center justify-center rounded-xl border border-blue-200/25 bg-blue-400/15 text-blue-200 shadow-inner shadow-white/10">
                          <Users className="h-4 w-4" />
                        </span>
                        <div>
                          <p className="text-[11px] font-black text-white">切換管理員群組</p>
                          <p className="mt-0.5 text-[9px] font-medium text-blue-100/50">選擇要管理的員工群組</p>
                        </div>
                      </div>
                      <span className="rounded-md border border-blue-200/20 bg-blue-400/10 px-1.5 py-0.5 text-[9px] font-black tabular-nums text-blue-200">{adminGroups.length}</span>
                    </div>
                  </div>
                  <div className="max-h-80 space-y-1.5 overflow-y-auto p-2 scrollbar-dark">
                    {adminGroups.map(group => {
                      const isActive = selectedAdminId === group.id;
                      const selectedInGroup = (allEmployees.get(group.id) || [])
                        .filter(employee => selectedEmployeeIds.has(employee.id)).length;
                      return (
                        <button
                          key={group.id}
                          type="button"
                          onClick={() => {
                            setSelectedAdminId(group.id);
                            setSelectedMessageIds(new Set());
                            setSelectedMessageDetail(null);
                            setShowGroupDropdown(false);
                          }}
                          className={`group flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-all ${isActive ? 'border-blue-300/65 bg-gradient-to-r from-blue-500/30 via-cyan-500/15 to-transparent text-white shadow-[0_8px_18px_rgba(37,99,235,0.16)]' : 'border-blue-200/10 bg-slate-900/45 text-slate-300 hover:border-blue-300/40 hover:bg-blue-500/10 hover:text-white'}`}
                        >
                          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-[10px] font-black ${isActive ? 'border-blue-200/45 bg-gradient-to-br from-blue-400 to-cyan-500 text-white' : group.role === 'super_admin' ? 'border-blue-400/25 bg-blue-500/15 text-blue-300' : 'border-cyan-400/20 bg-cyan-500/10 text-cyan-300'}`}>
                            {group.role === 'super_admin' ? 'S' : 'A'}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[11px] font-bold">{group.username}</span>
                            <span className={`mt-0.5 block text-[8px] font-semibold tracking-wider ${isActive ? 'text-blue-100/65' : 'text-slate-500 group-hover:text-blue-200/60'}`}>{group.role === 'super_admin' ? '超級管理員' : '管理員群組'}</span>
                          </span>
                          <span className="shrink-0 text-right">
                            <span className={`flex items-center justify-end gap-1 text-[10px] font-black tabular-nums ${isActive ? 'text-blue-100' : 'text-blue-300'}`}>
                              <Users className="h-3 w-3" /> {group.total_employees}
                            </span>
                            {selectedInGroup > 0 && <span className="mt-0.5 block text-[8px] font-bold text-cyan-300">已選 {selectedInGroup} 人</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
          <button onClick={() => setShowAutomation(true)} className="flex h-8 items-center gap-1.5 rounded-lg border border-cyan-300/30 bg-gradient-to-r from-cyan-500/15 to-blue-500/15 px-3 text-[11px] font-bold text-cyan-100 transition-colors hover:border-cyan-200/55 hover:from-cyan-500/25 hover:to-blue-500/25">
            <Sparkles className="h-3.5 w-3.5" />
            自動化任務
          </button>
        </div>
      </div>

      {/* 3-Panel Horizontal Layout */}
      <div className="flex flex-1 min-h-0 overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/80 shadow-[0_18px_40px_-28px_rgba(15,23,42,0.95)]">

        {/* Panel 1: Employees */}
        <div className="flex w-64 flex-shrink-0 flex-col border-r border-slate-700/70 bg-slate-950/35">
          <div className="space-y-1 border-b border-slate-700/70 bg-slate-900/85 px-2.5 py-1.5">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
              <input
                type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜尋員工..."
                className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pl-8 pr-8 text-[11px] font-medium text-slate-900 placeholder-slate-400 outline-none transition-colors duration-150 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Status + Tag filters row */}
            <div className="flex items-center gap-1.5">
              <div className="flex flex-1 gap-0.5 rounded-lg border border-slate-700/80 bg-slate-950/65 p-0.5">
                {(['all', 'active', 'verified'] as const).map(status => (
                  <button key={status} onClick={() => setFilterStatus(status)}
                    className={`flex-1 rounded-md border px-1 py-1 text-[10px] font-bold transition-colors duration-150 ${
                      filterStatus === status
                        ? status === 'active'
                          ? 'border-emerald-400/70 bg-emerald-500/25 text-emerald-100'
                          : status === 'verified'
                            ? 'border-violet-400/70 bg-violet-500/25 text-violet-100'
                            : 'border-blue-400/70 bg-blue-500/25 text-blue-100'
                        : 'border-slate-700/60 bg-slate-900/40 text-slate-400 hover:border-slate-500 hover:bg-slate-800 hover:text-slate-100'
                    }`}>
                    {status === 'all' ? '全部' : status === 'active' ? '啟用' : '已驗證'}
                  </button>
                ))}
              </div>

              {/* Tag dropdown */}
              {allAvailableTags.length > 0 && (
                <div className="relative" ref={tagDropdownRef}>
                  <button onClick={() => setShowTagDropdown(!showTagDropdown)}
                    aria-expanded={showTagDropdown}
                    aria-haspopup="menu"
                    className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-bold shadow-sm transition-all duration-150 ${
                      selectedTags.size > 0
                        ? 'border-amber-200/80 bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600 text-white shadow-[0_5px_14px_rgba(245,158,11,0.28)] hover:from-amber-400 hover:via-orange-400 hover:to-amber-500'
                        : 'border-amber-300/35 bg-gradient-to-r from-amber-500/20 via-orange-500/10 to-slate-900/70 text-amber-100 hover:border-amber-200/70 hover:from-amber-500/35 hover:via-orange-500/20 hover:to-orange-950/60 hover:text-white'
                    }`}>
                    <Tag className="h-3 w-3" />
                    <span className="hidden min-[1380px]:inline">標籤</span>
                    {selectedTags.size > 0 && <span className="min-w-[18px] rounded-md border border-white/45 bg-white/20 px-1 text-center text-[9px] font-black text-white shadow-inner">{selectedTags.size}</span>}
                    <ChevronDown className={`h-2.5 w-2.5 transition-transform duration-150 ${showTagDropdown ? 'rotate-180' : ''}`} />
                  </button>
                  {showTagDropdown && (
                    <div className="absolute right-0 top-full z-50 mt-2 w-60 max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl border border-amber-300/35 bg-gradient-to-br from-[#3a1c09] via-slate-950/[0.98] to-[#241108] shadow-2xl shadow-slate-950/80 ring-1 ring-orange-200/10 backdrop-blur-xl">
                      <div className="border-b border-amber-300/20 bg-gradient-to-r from-amber-500/25 via-orange-500/10 to-transparent px-3.5 py-3">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="flex h-6 w-6 items-center justify-center rounded-lg border border-amber-200/35 bg-gradient-to-br from-amber-400/35 to-orange-500/20 text-amber-200 shadow-inner shadow-amber-100/10">
                              <Tag className="h-3.5 w-3.5" />
                            </span>
                            <span className="text-xs font-black text-slate-100">依標籤篩選</span>
                          </div>
                          <span className="rounded-md border border-amber-200/25 bg-amber-300/15 px-1.5 py-0.5 text-[9px] font-black tabular-nums text-amber-100">{allAvailableTags.length} 個標籤</span>
                        </div>
                        <p className="mt-1.5 text-[10px] leading-relaxed text-amber-100/60">選擇一個或多個標籤以縮小收件對象範圍。</p>
                        {selectedTags.size > 0 && (
                          <button onClick={() => { clearTagFilter(); setShowTagDropdown(false); }} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-amber-200/35 bg-gradient-to-r from-amber-500/15 to-orange-500/20 px-2 py-1.5 text-[10px] font-extrabold text-amber-100 transition-all hover:border-amber-200/70 hover:from-amber-500/30 hover:to-orange-500/35 hover:text-white">
                            <X className="h-3 w-3" />
                            清除已選標籤
                          </button>
                        )}
                      </div>
                      <div className="max-h-56 space-y-1.5 overflow-y-auto p-2.5 scrollbar-dark">
                        {allAvailableTags.map(tag => (
                          <button key={tag} onClick={() => toggleTagFilter(tag)}
                            className={`group flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-[11px] shadow-sm transition-all duration-150 ${
                              selectedTags.has(tag)
                                ? 'border-amber-200/80 bg-gradient-to-r from-amber-500/40 via-orange-500/30 to-amber-600/20 text-white shadow-[0_5px_14px_rgba(245,158,11,0.18)]'
                                : 'border-orange-200/10 bg-gradient-to-r from-slate-900/80 to-orange-950/20 text-amber-50/80 hover:-translate-y-0.5 hover:border-amber-300/55 hover:from-amber-500/20 hover:to-orange-500/15 hover:text-white hover:shadow-[0_5px_14px_rgba(245,158,11,0.12)]'
                            }`}>
                            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-lg border shadow-inner transition-colors ${selectedTags.has(tag) ? 'border-amber-100/70 bg-gradient-to-br from-amber-300/40 to-orange-500/30 text-amber-50' : 'border-amber-200/20 bg-slate-950/70 text-amber-200/45 group-hover:border-amber-300/55 group-hover:text-amber-100'}`}>
                              {selectedTags.has(tag) ? <Check className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
                            </span>
                            <span className={`min-w-0 flex-1 truncate ${selectedTags.has(tag) ? 'font-black tracking-tight text-amber-50' : 'font-semibold text-amber-50/80 group-hover:text-white'}`}>{tag}</span>
                            <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-black tabular-nums ${selectedTags.has(tag) ? 'border-amber-200/45 bg-amber-200/20 text-amber-50' : 'border-amber-200/20 bg-amber-300/10 text-amber-200/75'}`} aria-label={`${tag}：${tagEmployeeCounts.get(tag) || 0} 名員工`}>{tagEmployeeCounts.get(tag) || 0}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-1.5 border-t border-slate-700/70 pt-1.5">
              <button
                type="button"
                onClick={selectAllEmployees}
                disabled={allEmployeesSelected}
                className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-blue-400/60 bg-blue-600/25 px-2 text-[10px] font-bold text-blue-50 transition-colors duration-150 hover:border-blue-300/80 hover:bg-blue-600/40 disabled:cursor-not-allowed disabled:border-emerald-500/30 disabled:bg-emerald-500/10 disabled:text-emerald-200"
              >
                {allEmployeesSelected ? <><CheckSquare className="h-3.5 w-3.5" /> 已全選</> : <><Users className="h-3.5 w-3.5" /> 全選</>}
              </button>
              <button
                type="button"
                onClick={clearSelection}
                disabled={selectedEmployeeIds.size === 0}
                className="flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-red-400/55 bg-red-500/15 px-2 text-[10px] font-bold text-red-100 transition-colors duration-150 hover:border-red-300/80 hover:bg-red-500/25 disabled:cursor-not-allowed disabled:border-slate-800 disabled:bg-slate-950 disabled:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
                清除選取
              </button>
            </div>

          </div>

          {/* Employee List */}
          <div ref={employeeListRef} className="min-h-0 flex-1 overflow-y-auto scrollbar-dark" onScroll={() => setEmployeeTagPreview(null)}>
            {!selectedAdminId ? (
              <div className="px-4 py-14 text-center">
                <div className="w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center mx-auto mb-3 border border-slate-700/50">
                  <Users className="w-6 h-6 text-slate-500" />
                </div>
                <p className="text-sm text-slate-400 font-medium">請選擇群組</p>
              </div>
            ) : filteredEmployees.length === 0 ? (
              <div className="px-4 py-14 text-center">
                <p className="text-sm text-slate-400 font-medium">找不到員工</p>
              </div>
            ) : (
              <div className="space-y-0.5 p-1.5">
                {filteredEmployees.map(emp => {
                  const isSelected = selectedEmployeeIds.has(emp.id);
                  return (
                    <div
                      key={emp.id}
                      onClick={() => toggleEmployeeSelection(emp.id)}
                      aria-pressed={isSelected}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggleEmployeeSelection(emp.id);
                        }
                      }}
                      className={`group relative cursor-pointer overflow-hidden rounded-lg border transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/60 ${
                        isSelected
                          ? 'border-emerald-400/70 border-l-2 border-l-emerald-300 bg-emerald-500/20 px-2.5 py-2'
                          : 'border-slate-800 bg-slate-900/45 px-2 py-1.5 hover:border-slate-700 hover:bg-slate-800/80'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md border transition-colors duration-150 ${
                          isSelected
                            ? 'border-emerald-300/80 bg-emerald-400/25 text-emerald-50'
                            : 'border-slate-700 bg-slate-950/70 text-slate-600 group-hover:border-slate-600 group-hover:text-slate-300'
                        }`}>
                          {isSelected ? (
                            <Check className="h-4 w-4" strokeWidth={3} />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className={`truncate tracking-tight ${isSelected ? 'text-[13px] font-bold text-white' : 'text-[11px] font-semibold text-slate-300 group-hover:text-white'}`}>
                              {emp.username}
                            </span>
                            {!emp.is_active && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-md bg-red-500/20 text-red-300 font-bold flex-shrink-0 border border-red-500/20">停用</span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className={`font-mono ${isSelected ? 'text-[11px] font-semibold text-emerald-100/90' : 'text-[10px] text-slate-500'}`}>{emp.employee_id}</span>
                            {emp.tags && emp.tags.length > 0 && (
                              <div
                                className="flex min-w-0 items-center gap-0.5 overflow-hidden whitespace-nowrap"
                                onMouseEnter={(event) => {
                                  const bounds = event.currentTarget.getBoundingClientRect();
                                  setEmployeeTagPreview({
                                    employeeId: emp.id,
                                    tags: emp.tags,
                                    left: bounds.right + 8,
                                    top: bounds.top + bounds.height / 2,
                                  });
                                }}
                                onMouseLeave={() => setEmployeeTagPreview(null)}
                              >
                                <span className="min-w-0 max-w-[88px] flex-1 truncate rounded-full border border-amber-500/30 bg-amber-500/20 px-1.5 py-0 text-[10px] font-medium text-amber-400">
                                  {emp.tags[0]}
                                </span>
                                {emp.tags.length > 1 && (
                                  <span className="shrink-0 text-[10px] font-medium text-slate-500">+{emp.tags.length - 1}</span>
                                )}
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

        {/* Panel 2: Compose Message */}
        <div className="flex min-w-0 flex-1 flex-col border-r border-slate-700/60 bg-slate-900/95">
          <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
            <NotificationDeliverySelector
              value={messageForm.deliveryMode}
              onChange={deliveryMode => setMessageForm(previous => ({ ...previous, deliveryMode }))}
              disabled={sending}
              className="shrink-0"
              embedded
            />

            <div className="flex shrink-0 flex-nowrap items-center gap-2">
              {/* Priority selector */}
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="text-[10px] font-semibold text-slate-500 tracking-wide">優先級</span>
                <div className="flex gap-1">
                  {(['normal', 'high', 'urgent'] as const).map((priority) => {
                    const isActive = messageForm.priority === priority;
                    const config: Record<string, { activeBg: string; activeBorder: string; activeShadow: string; inactiveBg: string; inactiveText: string; inactiveBorder: string; hoverBg: string; hoverBorder: string; dot: string }> = {
                      normal: { activeBg: 'bg-emerald-600', activeBorder: 'border-emerald-400', activeShadow: 'shadow-emerald-600/30', inactiveBg: 'bg-emerald-950/30', inactiveText: 'text-emerald-400', inactiveBorder: 'border-emerald-500/30', hoverBg: 'hover:bg-emerald-900/40', hoverBorder: 'hover:border-emerald-500/50', dot: 'bg-emerald-400' },
                      high:   { activeBg: 'bg-amber-600', activeBorder: 'border-amber-400', activeShadow: 'shadow-amber-600/30', inactiveBg: 'bg-amber-950/30', inactiveText: 'text-amber-400', inactiveBorder: 'border-amber-500/30', hoverBg: 'hover:bg-amber-900/40', hoverBorder: 'hover:border-amber-500/50', dot: 'bg-amber-400' },
                      urgent: { activeBg: 'bg-red-600', activeBorder: 'border-red-400', activeShadow: 'shadow-red-600/30', inactiveBg: 'bg-red-950/30', inactiveText: 'text-red-400', inactiveBorder: 'border-red-500/30', hoverBg: 'hover:bg-red-900/40', hoverBorder: 'hover:border-red-500/50', dot: 'bg-red-400' },
                    };
                    const c = config[priority];
                    return (
                      <button key={priority}
                        onClick={() => setMessageForm({ ...messageForm, priority })}
                        className={`flex h-9 w-[4.5rem] items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-[11px] font-bold capitalize transition-colors duration-200 ${
                          isActive
                            ? `${c.activeBg} text-white ${c.activeBorder} shadow-sm`
                            : `${c.inactiveBg} ${c.inactiveText} ${c.inactiveBorder} ${c.hoverBg} ${c.hoverBorder}`
                        }`}>
                        <div className={`h-2 w-2 rounded-full ${c.dot} ${isActive ? 'opacity-100' : 'opacity-60'}`} />
                        {getPriorityLabel(priority)}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Template button */}
              <div className="ml-auto flex shrink-0 items-center gap-1" ref={templateDropdownRef}>
                <button
                  type="button"
                  onClick={() => {
                    setShowTemplateDropdown(false);
                    setEmployeePreviewOpen(true);
                  }}
                  aria-haspopup="dialog"
                  aria-expanded={employeePreviewOpen}
                  className="flex items-center gap-1.5 rounded-lg border border-blue-300/35 bg-blue-500/15 px-3.5 py-2 text-[11px] font-bold text-blue-100 transition-colors duration-200 hover:border-blue-200/70 hover:bg-blue-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300/70"
                >
                  <Eye className="h-3.5 w-3.5" />
                  員工端預覽
                </button>
                <div className="relative">
                  <button
                    onClick={() => { setShowTemplateDropdown(!showTemplateDropdown); }}
                    className={`flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-[11px] font-bold transition-all duration-200 ${
                      showTemplateDropdown
                        ? 'border-emerald-300/70 bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-white shadow-[0_0_18px_rgba(20,184,166,0.28)]'
                        : 'border-emerald-700/70 bg-gradient-to-r from-emerald-950/70 via-teal-950/60 to-slate-900 text-emerald-200 hover:border-emerald-400/70 hover:from-emerald-900/80 hover:to-teal-950/80'
                    }`}>
                    <Bookmark className="w-3.5 h-3.5" />
                    範本
                    {templates.length > 0 && (
                      <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-black ${showTemplateDropdown ? 'bg-white/20 text-white' : 'bg-emerald-400/15 text-emerald-300'}`}>{templates.length}</span>
                    )}
                    <ChevronDown className={`w-3 h-3 transition-transform ${showTemplateDropdown ? 'rotate-180' : ''}`} />
                  </button>

                  {showTemplateDropdown && (
                    <div className="absolute right-0 top-full z-50 mt-1.5 w-[19rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-emerald-300/25 bg-gradient-to-br from-emerald-950 via-slate-950 to-teal-950 shadow-[0_14px_32px_rgba(2,44,34,0.5)]">
                      <div className="pointer-events-none absolute -right-12 -top-12 h-32 w-32 rounded-full bg-emerald-400/15 blur-3xl" />
                      <div className="pointer-events-none absolute -bottom-16 -left-8 h-32 w-32 rounded-full bg-teal-400/10 blur-3xl" />
                      <div className="relative flex items-center justify-between border-b border-emerald-200/15 bg-gradient-to-r from-emerald-500/15 via-teal-500/10 to-transparent px-3 py-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-emerald-200/25 bg-emerald-400/15 text-emerald-200 shadow-inner shadow-white/10">
                            <Bookmark className="h-3.5 w-3.5" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-[10px] font-black tracking-wide text-emerald-50">訊息範本</p>
                            <p className="text-[8px] font-medium text-emerald-200/60">快速套用已儲存的通知內容</p>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => { setShowTemplateDropdown(false); setShowSaveTemplateModal(true); setEditingTemplateId(null); setNewTemplateName(''); setTemplateEditorContent(composeEditorRef.current?.getContent() || ''); setTemplateFormTitle(messageForm.title); }}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-emerald-200/35 bg-gradient-to-r from-emerald-500 to-teal-500 px-2 py-1 text-[9px] font-black text-white shadow-sm shadow-emerald-950/30 transition-all hover:border-emerald-100/70 hover:from-emerald-400 hover:to-teal-400"
                        >
                          <Plus className="h-3 w-3" /> 新增範本
                        </button>
                      </div>
                      {templates.length === 0 ? (
                        <div className="relative px-3 py-5 text-center">
                          <div className="mx-auto mb-1.5 flex h-8 w-8 items-center justify-center rounded-xl border border-emerald-300/20 bg-emerald-400/10 text-emerald-300/70">
                            <Bookmark className="h-4 w-4" />
                          </div>
                          <p className="text-[11px] font-bold text-emerald-100/80">尚無範本</p>
                          <p className="mt-1 text-[10px] text-emerald-200/45">點擊「新增範本」以建立範本</p>
                        </div>
                      ) : (
                        <div className="relative max-h-[32rem] space-y-1.5 overflow-y-auto p-2 scrollbar-dark">
                          {templates.map(tpl => (
                            <div key={tpl.id}
                              onClick={() => applyTemplate(tpl)}
                              className="group relative cursor-pointer overflow-hidden rounded-lg border border-emerald-300/15 bg-gradient-to-br from-emerald-900/45 via-slate-900/80 to-teal-950/35 p-2 shadow-[0_6px_16px_rgba(2,44,34,0.18)] transition-all hover:-translate-y-0.5 hover:border-emerald-300/50 hover:from-emerald-800/55 hover:to-teal-900/45 hover:shadow-[0_8px_18px_rgba(16,185,129,0.14)]"
                            >
                              <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-emerald-300 via-teal-400 to-cyan-400 opacity-70" />
                              <div className="flex items-start gap-2 pl-1">
                                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-emerald-200/20 bg-gradient-to-br from-emerald-400/25 to-teal-500/10 text-emerald-200 shadow-inner shadow-white/10">
                                  <Bookmark className="h-3 w-3" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 truncate text-[10px] font-black text-white">{tpl.name}</div>
                                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                                      <button
                                        type="button"
                                        onClick={(e) => { e.stopPropagation(); setShowTemplateDropdown(false); setShowSaveTemplateModal(true); startEditTemplate(tpl); }}
                                        aria-label={`編輯 ${tpl.name}`}
                                        title="編輯範本"
                                        className="rounded-md p-1 text-emerald-200/60 transition-colors hover:bg-blue-400/20 hover:text-blue-200"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={(e) => deleteTemplate(tpl.id, e)}
                                        aria-label={`刪除 ${tpl.name}`}
                                        title="刪除範本"
                                        className="rounded-md p-1 text-emerald-200/60 transition-colors hover:bg-red-400/20 hover:text-red-200"
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </div>
                                  </div>
                                  {tpl.title && <div className="mt-0.5 truncate text-[9px] font-medium text-emerald-100/65">{tpl.title}</div>}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <section className={`shrink-0 rounded-2xl border p-3 transition-colors duration-200 ${manualRewardEnabled ? 'border-amber-300/45 bg-gradient-to-br from-amber-500/[0.12] via-orange-500/[0.06] to-slate-900 shadow-[0_10px_28px_rgba(120,53,15,0.16)]' : 'border-slate-700/80 bg-slate-900/65 hover:border-slate-600'}`}>
              <div className={`flex items-center justify-between gap-2 border-l-2 pl-3 ${manualRewardEnabled ? 'border-amber-300' : 'border-slate-600'}`}>
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <Gift className={`h-5 w-5 shrink-0 ${manualRewardEnabled ? 'text-amber-300' : 'text-slate-500'}`} />
                  <div className="min-w-0 shrink-0">
                    <h3 className={`whitespace-nowrap text-[15px] font-black ${manualRewardEnabled ? 'text-amber-100' : 'text-slate-100'}`}>績效獎金</h3>
                    <p className={`text-[10px] ${manualRewardEnabled ? 'text-amber-100/70' : 'text-slate-400'}`}>{manualRewardEnabled ? '已啟用，通知會附帶績效獎金' : '關閉時只發送一般通知'}</p>
                  </div>
                  {manualRewardEnabled && (
                    <div className="flex min-w-0 shrink items-center gap-2 rounded-xl border border-amber-300/35 bg-gradient-to-r from-amber-500/[0.16] to-orange-500/[0.1] px-2 py-1 shadow-sm shadow-amber-950/25">
                      <label className="flex shrink-0 items-center gap-2">
                        <span className="text-[11px] font-black text-amber-100">每人獎金</span>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={manualRewardAmount}
                          onChange={event => setManualRewardAmount(event.target.value)}
                          aria-label="每人獎金"
                          className="h-9 w-28 rounded-xl border border-amber-300/70 bg-white px-3 text-base font-black text-slate-900 shadow-[0_2px_8px_rgba(120,53,15,0.18)] outline-none transition-colors hover:border-amber-400 focus:border-amber-500 focus:ring-2 focus:ring-amber-400/35"
                        />
                      </label>
                      <span className="inline-flex h-9 shrink-0 items-center rounded-xl border border-amber-200/45 bg-amber-300/20 px-3 text-xs font-black text-amber-100 shadow-sm" title="網站計量貨幣">
                        {currencyUnit}
                      </span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  aria-pressed={manualRewardEnabled}
                  onClick={() => setManualRewardEnabled(previous => !previous)}
                  className={`group inline-flex shrink-0 items-center gap-2 rounded-xl border px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70 ${manualRewardEnabled ? 'border-amber-200/35 bg-amber-400/[0.1] hover:border-amber-100/60 hover:bg-amber-400/[0.16]' : 'border-slate-700 bg-slate-950/45 hover:border-slate-500 hover:bg-slate-800/70'}`}
                >
                  <span className={`text-[11px] font-black ${manualRewardEnabled ? 'text-amber-100' : 'text-slate-300'}`}>{manualRewardEnabled ? '已啟用' : '未啟用'}</span>
                  <span className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors ${manualRewardEnabled ? 'border-amber-200/80 bg-gradient-to-r from-amber-300 to-orange-500 shadow-[0_0_14px_rgba(245,158,11,0.32)]' : 'border-slate-600 bg-slate-800'}`}>
                    <span className={`h-5 w-5 rounded-full bg-white shadow-md transition-transform ${manualRewardEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
                  </span>
                </button>
              </div>
            </section>

            {/* Title - light input */}
            <div className="shrink-0">
              <div className="mb-1 flex items-center justify-between">
                <label className="text-[10px] font-semibold text-slate-400">標題</label>
                <span className="text-[10px] text-slate-600">{messageForm.title.length}/200</span>
              </div>
              <input type="text" value={messageForm.title}
                onChange={(e) => setMessageForm({ ...messageForm, title: e.target.value.slice(0, 200) })}
                placeholder="輸入訊息標題..."
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            {/* TipTap Editor - fills all remaining space */}
            <div className="flex-1 min-h-0 flex flex-col">
              <label className="block text-[10px] font-semibold text-slate-400 mb-1.5 shrink-0">內容</label>
              <div className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm [&>div]:h-full [&>div]:flex [&>div]:flex-col">
                <TiptapEditor
                  ref={composeEditorRef}
                  content=""
                  onChange={(html: string) => setMessageForm(prev => ({ ...prev, content: html }))}
                  placeholder="在此輸入訊息內容..."
                  theme="light"
                  adminId=""
                  enableQuickCopy
                  onClearAll={() => setMessageForm(previous => ({ ...previous, title: '', content: '' }))}
                />
              </div>
            </div>
          </div>

          {/* Send Button - prominent */}
          <div className="border-t border-slate-700/60 bg-slate-800/35 px-3 py-2.5">
            <button
              onClick={validateAndSendMessage}
              disabled={sending || selectedEmployeeIds.size === 0 || !messageForm.title.trim()}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 py-2.5 text-sm font-bold text-white shadow-md shadow-blue-950/30 transition-colors hover:bg-blue-500 active:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-35 disabled:shadow-none"
            >
              <Send className="w-4 h-4" />
              {sending ? '發送中...' : selectedEmployeeIds.size === 0 ? '請選擇收件人' : `發送給 ${selectedEmployeeIds.size} 位員工`}
            </button>
          </div>
        </div>

        {/* Panel 3: Sent Messages */}
        <div className="flex min-h-0 w-72 flex-shrink-0 flex-col border-l border-slate-700/60 bg-slate-900/95">
          {/* Header */}
          <div className="space-y-1.5 border-b border-slate-700/60 bg-slate-800/45 px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <h3 className="min-w-0 truncate text-[11px] font-bold uppercase tracking-[0.16em] text-slate-200">已發送訊息</h3>
              <div role="group" aria-label="已發送訊息來源" className="grid h-8 w-[168px] shrink-0 grid-cols-[42px_1fr_1fr] gap-0.5 rounded-lg border border-slate-600 bg-slate-950/80 p-0.5 shadow-inner">
                {([['all', '全部'], ['manual', '手動通知'], ['automation', '自動通知']] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={messageOriginFilter === value}
                    onClick={() => { setMessageOriginFilter(value); exitSelectionMode(); }}
                    className={`min-w-0 whitespace-nowrap rounded-md text-[10px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 ${messageOriginFilter === value
                      ? value === 'manual'
                        ? 'bg-cyan-500 text-slate-950 shadow-sm shadow-cyan-500/30'
                        : value === 'automation'
                          ? 'bg-violet-500 text-white shadow-sm shadow-violet-500/30'
                          : 'bg-blue-500 text-white shadow-sm shadow-blue-500/30'
                      : 'text-slate-300 hover:bg-slate-700 hover:text-white'
                    }`}
                  >{label}</button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
                <input type="text" value={sentMessagesSearchQuery} onChange={(e) => setSentMessagesSearchQuery(e.target.value)}
                  placeholder="搜尋員工帳號／ID..."
                  className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-7 pr-7 text-[11px] text-slate-800 shadow-sm outline-none transition-colors placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
                />
                {sentMessagesSearchQuery && (
                  <button onClick={() => setSentMessagesSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-700">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              {manageableGroupMessages.length > 0 && (
                selectionMode ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={toggleSelectAll}
                      disabled={selectableMessages.length === 0}
                      title={allSelectableSelected ? '取消全選' : '全選可管理訊息'}
                      aria-label={allSelectableSelected ? '取消全選訊息' : '全選可管理訊息'}
                      className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        allSelectableSelected
                          ? 'border-cyan-300/60 bg-cyan-500/25 text-cyan-100 hover:bg-cyan-500/35'
                          : 'border-blue-400/40 bg-blue-500/15 text-blue-200 hover:border-blue-300/70 hover:bg-blue-500/25'
                      }`}
                    >
                      {allSelectableSelected
                        ? <CheckSquare className="h-3.5 w-3.5" />
                        : <Square className="h-3.5 w-3.5" />}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setDeleteMode('selected'); setShowDeleteConfirm(true); }}
                      disabled={selectedMessageIds.size === 0}
                      title={selectedMessageIds.size > 0 ? `刪除 ${selectedMessageIds.size} 則已選訊息` : '請先選擇要刪除的訊息'}
                      aria-label="刪除已選訊息"
                      className="relative flex h-7 min-w-7 items-center justify-center rounded-md border border-red-400/40 bg-red-500/15 px-1.5 text-red-200 transition-colors hover:border-red-300/70 hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {selectedMessageIds.size > 0 && <span className="ml-1 text-[8px] font-black">{selectedMessageIds.size}</span>}
                    </button>
                    <button
                      type="button"
                      onClick={exitSelectionMode}
                      title="取消選取"
                      aria-label="取消訊息選取"
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-amber-400/40 bg-amber-500/15 text-amber-200 transition-colors hover:border-amber-300/70 hover:bg-amber-500/25"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={enterSelectionMode}
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-blue-400/40 bg-blue-500/15 text-blue-200 transition-colors hover:border-blue-300/70 hover:bg-blue-500/25"
                      title="選擇訊息"
                      aria-label="選擇訊息"
                    >
                      <CheckSquare className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => { setDeleteMode('all'); setShowDeleteConfirm(true); }}
                      className="flex h-7 w-7 items-center justify-center rounded-md border border-red-400/40 bg-red-500/15 text-red-200 transition-colors hover:border-red-300/70 hover:bg-red-500/25"
                      title={messageOriginFilter === 'manual' ? '清除全部手動通知' : '清除全部可管理通知（不含自動化）'}
                      aria-label={messageOriginFilter === 'manual' ? '清除全部手動通知' : '清除全部可管理通知（不含自動化）'}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )
              )}
            </div>

            {/* Filter tabs */}
            <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <p className="w-[58px] shrink-0 px-0.5 text-center text-[10px] font-extrabold tracking-wide text-cyan-100">訊息類型</p>
                  <div className="flex min-w-0 flex-1 rounded-md border border-slate-700/60 bg-slate-950/35 p-0.5">
                    {([['all', '全部'], ['realtime_with_login_fallback', '結合'], ['realtime_only', '即時'], ['login_only', '登入']] as const).map(([val, label]) => {
                      const activeClass = val === 'realtime_with_login_fallback'
                        ? 'border-amber-300 bg-gradient-to-r from-amber-400 to-orange-500 text-amber-950'
                        : val === 'realtime_only'
                          ? 'border-blue-500 bg-blue-600 text-white'
                          : val === 'login_only'
                            ? 'border-violet-500 bg-violet-600 text-white'
                            : 'border-teal-400 bg-teal-600 text-white';
                      const idleClass = val === 'realtime_with_login_fallback'
                        ? 'text-amber-300 hover:bg-amber-950/70 hover:text-amber-100'
                        : val === 'realtime_only'
                          ? 'text-blue-300/80 hover:bg-blue-950/70 hover:text-blue-100'
                          : val === 'login_only'
                            ? 'text-violet-300/80 hover:bg-violet-950/70 hover:text-violet-100'
                            : 'text-teal-300 hover:bg-teal-950/70 hover:text-teal-100';
                      return (
                        <button key={val} onClick={() => setMessageTypeFilter(val)}
                          className={`min-w-0 flex-1 rounded border px-1 py-1 text-[9px] font-bold transition-colors ${messageTypeFilter === val ? activeClass : `border-transparent ${idleClass}`}`}>
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <p className="w-[58px] shrink-0 px-0.5 text-center text-[10px] font-extrabold tracking-wide text-violet-100">閱讀狀態</p>
                  <div className="flex min-w-0 flex-1 rounded-md border border-slate-700/60 bg-slate-950/35 p-0.5">
                    {([
                      ['all', '全部', sentMessageReadSummary.total],
                      ['read', '已讀', sentMessageReadSummary.read],
                      ['unread', '未讀', sentMessageReadSummary.unread],
                      ['no_recipients', '無收件人', sentMessageReadSummary.no_recipients],
                    ] as const).map(([val, label, count]) => {
                      const activeClass = val === 'read'
                        ? 'border-emerald-500 bg-emerald-600 text-white'
                        : val === 'unread'
                          ? 'border-red-400 bg-red-600 text-white'
                          : val === 'no_recipients'
                            ? 'border-slate-400 bg-slate-600 text-white'
                            : 'border-indigo-400 bg-indigo-600 text-white';
                      const idleClass = val === 'read'
                        ? 'text-emerald-300/80 hover:bg-emerald-950/70 hover:text-emerald-100'
                        : val === 'unread'
                          ? 'text-red-300 hover:bg-red-950/70 hover:text-red-100'
                          : val === 'no_recipients'
                            ? 'text-slate-300 hover:bg-slate-800 hover:text-slate-100'
                            : 'text-indigo-300 hover:bg-indigo-950/70 hover:text-indigo-100';
                      return (
                        <button key={val} onClick={() => setReadStatusFilter(val)}
                          className={`flex min-h-9 min-w-0 flex-1 flex-col items-center justify-center rounded border px-1 py-1 text-[9px] font-bold leading-none transition-colors ${readStatusFilter === val ? activeClass : `border-transparent ${idleClass}`}`}>
                          <span>{label}</span>
                          <span className="mt-1 text-[10px] font-black tabular-nums">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
            </div>
          </div>

          {messagesError && (
            <div role="alert" className="flex items-center justify-between gap-2 border-b border-red-500/30 bg-red-950/60 px-3 py-2 text-xs text-red-200">
              <span>通知閱讀統計未能更新，以下資料可能已過時。</span>
              <button type="button" onClick={() => void loadSentMessages()} className="shrink-0 rounded border border-red-300/40 px-2 py-1 font-bold">重試</button>
            </div>
          )}

          {/* Message List */}
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto border-b border-slate-700/60 p-1.5 scrollbar-dark">
            {messagesLoading ? (
              <div className="text-center py-10 text-slate-500 text-xs">載入中...</div>
            ) : visibleGroupMessages.length === 0 ? (
              <div className="text-center py-10 text-slate-600 text-xs font-medium">{messageOriginFilter === 'manual' ? '尚無手動發送的通知' : messageOriginFilter === 'automation' ? '尚無自動通知' : '尚無訊息'}</div>
            ) : filteredMessages.length === 0 ? (
              <div className="text-center py-10 text-slate-600 text-xs font-medium">沒有符合的結果</div>
            ) : (
              filteredMessages.map(msg => {
                const stats = getSelectedGroupMessageStats(msg);
                const recipientCount = stats.total_recipients;
                const recipientDetail = recipientDetails.get(msg.id);
                const scopedRecipients = [...(recipientDetail?.read || []), ...(recipientDetail?.unread || [])]
                  .filter(employee => !selectedAdminId || selectedGroupEmployeeIds.has(employee.id));
                const soleRecipient = recipientCount === 1 ? scopedRecipients[0] : null;
                const readCount = stats.read_count;
                const isFullyRead = recipientCount > 0 && readCount === recipientCount;
                const isPartiallyRead = readCount > 0 && !isFullyRead;
                const cardTone = recipientCount === 0
                  ? 'border-slate-600/50 border-l-slate-500 bg-gradient-to-r from-slate-800/70 via-slate-900/85 to-slate-900/65 hover:border-slate-400/70'
                  : isFullyRead
                    ? 'border-emerald-500/35 border-l-emerald-400 bg-gradient-to-r from-emerald-950/75 via-slate-900/85 to-slate-900/65 hover:border-emerald-300/80 hover:shadow-[0_6px_18px_rgba(16,185,129,0.22)]'
                    : isPartiallyRead
                      ? 'border-amber-500/35 border-l-amber-400 bg-gradient-to-r from-amber-950/70 via-slate-900/85 to-slate-900/65 hover:border-amber-300/80 hover:shadow-[0_6px_18px_rgba(245,158,11,0.22)]'
                      : 'border-red-500/35 border-l-red-400 bg-gradient-to-r from-red-950/70 via-slate-900/85 to-slate-900/65 hover:border-red-300/80 hover:shadow-[0_6px_18px_rgba(239,68,68,0.22)]';
                const isSelectedMsg = selectedMessageIds.has(msg.id);

                return (
                  <div
                    key={msg.id}
                    onClick={() => {
                      if (selectionMode) {
                        if (msg.automation_execution_id === null && msg.audit_origin !== 'automation') toggleMessageSelection(msg.id);
                      } else {
                        setSelectedMessageDetail(msg);
                        setRecipientSearchQuery('');
                        setRecipientStatusFilter('all');
                        setEditingMessage(false);
                        void loadRecipientDetailsRef.current?.(msg.id);
                      }
                    }}
                    className={`${selectionMode && (msg.automation_execution_id !== null || msg.audit_origin === 'automation') ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'} rounded-md border border-l-[3px] px-2.5 py-2 transition-[transform,box-shadow,border-color,filter] duration-150 hover:translate-x-0.5 hover:brightness-110 ${
                      selectionMode && isSelectedMsg
                        ? 'border-blue-400/50 border-l-blue-400 bg-blue-600/20 ring-1 ring-blue-500/30 hover:border-blue-300/80 hover:shadow-[0_6px_18px_rgba(59,130,246,0.24)]'
                        : cardTone
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      {selectionMode && msg.automation_execution_id === null && msg.audit_origin !== 'automation' && (
                        <div className="flex-shrink-0 mt-0.5">
                          {isSelectedMsg ? <CheckSquare className="w-3.5 h-3.5 text-blue-400" /> : <Square className="w-3.5 h-3.5 text-slate-600" />}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <h4 className="min-w-0 flex-1 truncate text-[10px] font-bold text-slate-100">{msg.title}</h4>
                          {recipientCount > 1 ? (
                            <span className="shrink-0 rounded border border-blue-400/25 bg-blue-500/10 px-1.5 py-0.5 text-[8px] font-bold text-blue-200">
                              {recipientCount} 人
                            </span>
                          ) : soleRecipient ? (
                            <span className="min-w-0 max-w-[136px] shrink-0 truncate text-right text-[9px] leading-none" title={`${soleRecipient.username} · ${soleRecipient.employee_id}`}>
                              <span className="font-bold text-cyan-100">{soleRecipient.username}</span>
                              <span className="ml-1 font-mono font-semibold text-slate-200">{soleRecipient.employee_id}</span>
                            </span>
                          ) : null}
                        </div>
                        <div className="flex min-w-0 items-center justify-between gap-1.5">
                          <div className="flex min-w-0 items-center gap-1">
                            <span className={`rounded-full border px-1.5 py-px text-[7px] font-bold ${getPriorityColor(msg.priority)}`}>
                              {getPriorityLabel(msg.priority)}
                            </span>
                            <span className={`truncate rounded-full border px-1.5 py-px text-[7px] font-semibold ${
                              getDeliveryMode(msg) === 'realtime_with_login_fallback'
                                ? 'border-amber-500/30 bg-amber-500/15 text-amber-300'
                                : getDeliveryMode(msg) === 'login_only'
                                  ? 'border-violet-500/30 bg-violet-500/15 text-violet-300'
                                  : 'border-blue-500/30 bg-blue-500/15 text-blue-300'
                            }`}>
                              {getNotificationDeliveryLabel(getDeliveryMode(msg))}
                            </span>
                            <span className={`shrink-0 rounded-full border px-1.5 py-px text-[7px] font-semibold ${msg.audit_origin === 'automation' || msg.automation_execution_id !== null ? 'border-violet-400/35 bg-violet-500/15 text-violet-200' : msg.audit_origin === 'manual_admin' ? 'border-cyan-400/35 bg-cyan-500/15 text-cyan-200' : 'border-slate-500/40 bg-slate-700/50 text-slate-300'}`}>
                              {msg.audit_origin === 'automation' || msg.automation_execution_id !== null ? '自動' : msg.audit_origin === 'manual_admin' ? '手動' : '待核實'}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <span className={`rounded px-1 py-0.5 text-[7px] font-black ${
                              recipientCount === 0
                                ? 'bg-slate-400/15 text-slate-300'
                                : isFullyRead
                                  ? 'bg-emerald-400/15 text-emerald-300'
                                  : isPartiallyRead
                                    ? 'bg-amber-400/15 text-amber-300'
                                    : 'bg-red-400/15 text-red-300'
                            }`}>
                              {recipientCount === 0 ? '無收件人' : isFullyRead ? '已讀' : isPartiallyRead ? '部分' : '未讀'} {readCount}/{recipientCount}
                            </span>
                            <span className="text-[8px] font-semibold text-slate-200">
                              {formatMessageDateTime(msg.created_at)}
                            </span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

        </div>
      </div>

      {/* Message Detail Modal */}
      {selectedMessageDetail && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={(e) => { if (e.target === e.currentTarget) { setSelectedMessageDetail(null); setEditingMessage(false); } }}>
          <div className="bg-slate-900 rounded-2xl border border-slate-700/50 shadow-2xl max-w-7xl w-full h-[90vh] overflow-hidden flex flex-col">
            {/* Slim Header */}
            <div className="relative flex flex-shrink-0 items-center justify-between overflow-hidden border-b border-cyan-300/20 bg-gradient-to-r from-slate-950 via-blue-950 to-cyan-950 px-5 py-3 shadow-[0_8px_24px_rgba(8,47,73,0.28)]">
              <div className="pointer-events-none absolute -left-8 top-1/2 h-20 w-20 -translate-y-1/2 rounded-full bg-blue-400/15 blur-2xl" />
              <div className="pointer-events-none absolute right-40 top-1/2 h-24 w-24 -translate-y-1/2 rounded-full bg-cyan-300/10 blur-2xl" />
              <div className="relative mr-4 flex min-w-0 items-center gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-200/25 bg-gradient-to-br from-blue-500/30 to-cyan-400/20 text-cyan-100 shadow-inner shadow-white/10">
                  <Bell className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-black tracking-[0.12em] text-cyan-100">已發送訊息詳情</p>
                </div>
              </div>
              <div className="relative flex flex-shrink-0 items-center gap-2">
                {editingMessage ? (
                  <>
                    <button type="button" onClick={handleSaveEdit} disabled={saving}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-emerald-700 bg-emerald-600 px-3.5 text-xs font-bold text-white transition-colors hover:border-emerald-600 hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50">
                      {saving ? <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-100/30 border-t-emerald-100" /> : <Save className="h-3.5 w-3.5" />}
                      {saving ? '儲存中...' : '儲存變更'}
                    </button>
                    <button type="button" onClick={handleCancelEdit} disabled={saving}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-700 px-3.5 text-xs font-bold text-white transition-colors hover:border-slate-500 hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-50">
                      <X className="h-3.5 w-3.5" /> 取消
                    </button>
                  </>
                ) : (
                  <>
                    {selectedMessageDetail.automation_execution_id === null && selectedMessageDetail.audit_origin !== 'automation' && <>
                      <button type="button" onClick={() => handleStartEdit(selectedMessageDetail)}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-700 bg-blue-600 px-3.5 text-xs font-bold text-white transition-colors hover:border-blue-600 hover:bg-blue-500">
                        <Pencil className="h-3.5 w-3.5" /> 編輯
                      </button>
                      <button type="button" onClick={() => { setSelectedMessageIds(new Set([selectedMessageDetail.id])); setDeleteMode('selected'); setShowDeleteConfirm(true); }}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-700 bg-red-600 px-3.5 text-xs font-bold text-white transition-colors hover:border-red-600 hover:bg-red-500">
                        <Trash2 className="h-3.5 w-3.5" /> 刪除
                      </button>
                    </>}
                    <div className="ml-1 border-l border-cyan-200/20 pl-2">
                      <button type="button" onClick={() => { setSelectedMessageDetail(null); setEditingMessage(false); }}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-cyan-200/25 bg-white/10 text-cyan-50 backdrop-blur-sm transition-colors hover:border-cyan-100/50 hover:bg-white/20 hover:text-white"
                        aria-label="關閉訊息詳情"
                        title="關閉">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Two-column body */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
              {/* Left: Content */}
              <div className={`flex min-h-0 w-[60%] flex-col overflow-hidden ${editingMessage ? 'bg-white' : 'bg-[#f0f5ff]'}`}>
                {editingMessage ? (
                  <>
                    <div className="flex-shrink-0 border-b border-gray-200 px-8 pb-4 pt-6">
                      <label className="mb-1.5 block text-[10px] font-bold tracking-wide text-gray-400">標題</label>
                      <input type="text" value={editForm.title} onChange={(e) => setEditForm({ ...editForm, title: e.target.value.slice(0, 200) })}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base font-bold text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="訊息標題..."
                      />
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-dark">
                      <div className="h-full px-8 py-6 [&>div]:flex [&>div]:h-full [&>div]:flex-col">
                        <TiptapEditor
                          ref={editEditorRef}
                          content={editForm.content}
                          onChange={(html: string) => setEditForm(prev => ({ ...prev, content: html }))}
                          placeholder="編輯訊息內容..."
                          theme="light"
                          adminId={admin.id}
                          enableQuickCopy
                        />
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
                    <EmployeeNotificationDetailPanel
                      embedded
                      readOnlyPreview
                      message={{
                        title: selectedMessageDetail.title,
                        content: selectedMessageDetail.content,
                        message_type: selectedDeliveryMode === 'login_only' ? 'login_popup' : 'realtime',
                        priority: selectedMessageDetail.priority,
                        notification_category: selectedMessageDetail.notification_category,
                        reward_amount: selectedMessageDetail.reward_amount,
                        reward_currency: selectedMessageDetail.reward_currency,
                        created_at: selectedMessageDetail.created_at,
                        is_read: false,
                      }}
                      onClose={() => { setSelectedMessageDetail(null); setEditingMessage(false); }}
                    />
                  </div>
                )}
              </div>

              {/* Right: Stats & Info */}
              <div className="w-[40%] flex flex-col min-h-0 overflow-hidden border-l border-slate-700/50 bg-slate-800/30">
                {/* Message details and recipients */}
                <div className="order-1 relative flex min-h-0 flex-1 flex-col overflow-hidden border-b border-teal-400/20 bg-gradient-to-br from-teal-950/70 via-slate-900 to-cyan-950/45 p-4 shadow-[inset_0_1px_0_rgba(94,234,212,0.08)]">
                  <div className="pointer-events-none absolute -right-12 -top-14 h-32 w-32 rounded-full bg-teal-400/10 blur-2xl" />
                  <div className="pointer-events-none absolute -bottom-16 -left-12 h-32 w-32 rounded-full bg-cyan-400/10 blur-2xl" />
                  <div className="relative flex min-h-0 flex-1 flex-col gap-3">
                    <div className="shrink-0 border-b border-teal-200/15 pb-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h4 className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-300">訊息詳情</h4>
                        <span
                          className="inline-flex min-h-7 max-w-[55%] items-center truncate rounded-lg border border-slate-600 bg-slate-800 px-2.5 py-1 text-xs font-semibold text-slate-100 shadow-sm shadow-slate-950/30"
                          title={selectedMessageDetail.sender_username}
                        >
                          {selectedMessageDetail.sender_username}
                        </span>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div className="relative min-h-[82px] min-w-0 overflow-hidden rounded-lg border border-slate-700 bg-gradient-to-br from-slate-800 via-slate-800 to-slate-900 px-2.5 py-2 shadow-[0_8px_18px_-14px_rgba(15,23,42,0.9)]">
                          <div className="absolute inset-x-0 top-0 h-0.5 bg-slate-400" />
                          <div className="mb-2 flex items-center justify-between gap-1.5">
                            <p className="truncate text-[9px] font-black uppercase tracking-[0.14em] text-slate-300/75">發送時間</p>
                            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-700 text-slate-200 ring-1 ring-slate-600">
                              <Clock className="h-3.5 w-3.5" />
                            </div>
                          </div>
                          <p className="whitespace-nowrap text-[9px] font-bold text-white" title={formatMessageDateTime(selectedMessageDetail.created_at)}>{formatMessageDateTime(selectedMessageDetail.created_at)}</p>
                          <p className="mt-0.5 text-[8px] font-medium text-slate-400">日期與時間</p>
                        </div>
                        <div className={`relative min-h-[82px] min-w-0 overflow-hidden rounded-lg border ${messageTypeTone.card} px-2.5 py-2 shadow-[0_8px_18px_-14px_rgba(15,23,42,0.9)]`}>
                          <div className={`absolute inset-x-0 top-0 h-0.5 ${messageTypeTone.accent}`} />
                          <div className="mb-2 flex items-center justify-between gap-1.5">
                            <p className={`truncate text-[9px] font-black uppercase tracking-[0.14em] ${messageTypeTone.label}`}>類型</p>
                            <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${messageTypeTone.icon}`}>
                              {selectedDeliveryMode === 'realtime_with_login_fallback'
                                ? <ShieldCheck className="h-3.5 w-3.5" />
                                : selectedDeliveryMode === 'login_only'
                                  ? <Bell className="h-3.5 w-3.5" />
                                  : <Radio className="h-3.5 w-3.5" />}
                            </div>
                          </div>
                          <p className={`truncate text-[10px] font-black ${messageTypeTone.value}`}>{getNotificationDeliveryLabel(selectedDeliveryMode)}</p>
                          <p className={`mt-0.5 truncate text-[8px] font-medium ${messageTypeTone.label}`}>投遞方式</p>
                        </div>
                        <div className={`relative min-h-[82px] min-w-0 overflow-hidden rounded-lg border ${messagePriorityTone.card} px-2.5 py-2 shadow-[0_8px_18px_-14px_rgba(15,23,42,0.9)]`}>
                          <div className={`absolute inset-x-0 top-0 h-0.5 ${messagePriorityTone.accent}`} />
                          <div className="mb-2 flex items-center justify-between gap-1.5">
                            <p className={`truncate text-[9px] font-black uppercase tracking-[0.14em] ${messagePriorityTone.label}`}>優先級</p>
                            <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${messagePriorityTone.icon}`}>
                              <AlertCircle className="h-3.5 w-3.5" />
                            </div>
                          </div>
                          <p className={`truncate text-[10px] font-black ${messagePriorityTone.value}`}>
                            {getPriorityLabel(selectedMessageDetail.priority)}
                          </p>
                          <p className={`mt-0.5 truncate text-[8px] font-medium ${messagePriorityTone.label}`}>訊息等級</p>
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-teal-300/30 bg-teal-400/15 shadow-lg shadow-teal-950/40">
                          <Users className="h-5 w-5 text-teal-200" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-teal-300/80">主要收件人</p>
                          <h4 className="truncate text-base font-black text-white">發送給員工</h4>
                        </div>
                      </div>
                      <span className="shrink-0 rounded-full border border-teal-200/30 bg-teal-300/15 px-2.5 py-1 text-xs font-black text-teal-100">
                        {selectedMessageDetail.recipient_ids?.length || '全部'}
                      </span>
                    </div>

                    {selectedMessageDetail.recipient_ids && selectedMessageDetail.recipient_ids.length > 0 && (
                      <>
                        <div className="relative shrink-0">
                          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-teal-300/70" />
                          <input
                            type="text"
                            value={recipientSearchQuery}
                            onChange={event => {
                              setRecipientSearchQuery(event.target.value);
                              setRecipientStatusFilter('all');
                            }}
                            placeholder="搜尋員工或帳號 ID..."
                            className="h-9 w-full rounded-lg border border-teal-300/20 bg-slate-950/35 pl-9 pr-8 text-xs font-medium text-slate-100 outline-none transition-colors placeholder:text-teal-100/35 focus:border-teal-300/55 focus:bg-slate-950/60 focus:ring-2 focus:ring-teal-300/15"
                          />
                          {recipientSearchQuery && (
                            <button
                              type="button"
                              onClick={() => {
                                setRecipientSearchQuery('');
                                setRecipientStatusFilter('all');
                              }}
                              className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-teal-200/70 transition-colors hover:bg-teal-300/10 hover:text-white"
                              aria-label="清除收件人搜尋"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                        <div className="grid shrink-0 grid-cols-3 gap-1.5" role="group" aria-label="依閱讀狀態篩選收件人">
                          {(() => {
                            const stats = messageStats.get(selectedMessageDetail.id);
                            const hasSearch = recipientSearchQuery.trim().length > 0;
                            const allActive = !hasSearch && recipientStatusFilter === 'all';
                            const readActive = !hasSearch && recipientStatusFilter === 'read';
                            const unreadActive = !hasSearch && recipientStatusFilter === 'unread';
                            const baseClass = 'flex min-w-0 items-center justify-between gap-1 rounded-lg border px-2 py-1.5 text-[10px] font-bold transition-colors';

                            return (
                              <>
                                <button
                                  type="button"
                                  aria-pressed={allActive}
                                  onClick={() => {
                                    setRecipientSearchQuery('');
                                    setRecipientStatusFilter('all');
                                  }}
                                  className={`${baseClass} ${allActive ? 'border-indigo-400 bg-indigo-600 text-white shadow-sm shadow-indigo-950/35' : 'border-indigo-500/30 bg-indigo-950/20 text-indigo-300 hover:border-indigo-400/60 hover:bg-indigo-950/45 hover:text-indigo-100'}`}
                                >
                                  <span>全部</span>
                                  <span className="font-black">{stats?.total_recipients ?? 0}</span>
                                </button>
                                <button
                                  type="button"
                                  aria-pressed={readActive}
                                  onClick={() => {
                                    setRecipientSearchQuery('');
                                    setRecipientStatusFilter(prev => prev === 'read' ? 'all' : 'read');
                                  }}
                                  className={`${baseClass} ${readActive ? 'border-emerald-400 bg-emerald-600 text-white shadow-sm shadow-emerald-950/35' : 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300 hover:border-emerald-400/60 hover:bg-emerald-950/45 hover:text-emerald-100'}`}
                                >
                                  <span>已讀</span>
                                  <span className="font-black">{stats?.read_count ?? 0}</span>
                                </button>
                                <button
                                  type="button"
                                  aria-pressed={unreadActive}
                                  onClick={() => {
                                    setRecipientSearchQuery('');
                                    setRecipientStatusFilter(prev => prev === 'unread' ? 'all' : 'unread');
                                  }}
                                  className={`${baseClass} ${unreadActive ? 'border-red-400 bg-red-600 text-white shadow-sm shadow-red-950/35' : 'border-red-500/30 bg-red-950/20 text-red-300 hover:border-red-400/60 hover:bg-red-950/45 hover:text-red-100'}`}
                                >
                                  <span>未讀</span>
                                  <span className="font-black">{stats?.unread_count ?? 0}</span>
                                </button>
                              </>
                            );
                          })()}
                        </div>
                      </>
                    )}

                    {(!selectedMessageDetail.recipient_ids || selectedMessageDetail.recipient_ids.length === 0) ? (
                      <div className="flex items-center gap-3 rounded-xl border border-blue-300/25 bg-blue-400/10 px-3.5 py-3">
                        <Globe className="h-5 w-5 shrink-0 text-blue-300" />
                        <div>
                          <p className="text-sm font-bold text-blue-100">所有員工</p>
                          <p className="text-[10px] font-medium text-blue-300/80">廣播通知</p>
                        </div>
                      </div>
                    ) : (
                      (() => {
                        const details = recipientDetails.get(selectedMessageDetail.id);
                        const employees = details ? [...details.read, ...details.unread] : [];
                        const readIds = new Set(details?.read.map(employee => employee.id) || []);
                        const query = recipientSearchQuery.trim().toLowerCase();
                        const visibleEmployees = employees.filter(employee => {
                          const matchesSearch = !query || employee.username.toLowerCase().includes(query) || employee.employee_id.toLowerCase().includes(query);
                          const matchesStatus = query.length > 0 || recipientStatusFilter === 'all' || (recipientStatusFilter === 'read' ? readIds.has(employee.id) : !readIds.has(employee.id));
                          return matchesSearch && matchesStatus;
                        });

                        if (employees.length > 0) {
                          return (
                            <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-dark">
                              {visibleEmployees.length > 0 ? (
                                <div className="overflow-hidden rounded-xl border border-teal-300/15 bg-slate-950/25 divide-y divide-teal-200/10">
                                  {visibleEmployees.map(employee => {
                                    const isRead = readIds.has(employee.id);
                                    return (
                                      <div key={employee.id} className={`flex items-center gap-2.5 px-2.5 py-2 transition-colors ${isRead ? 'bg-emerald-950/45 hover:bg-emerald-900/55' : 'bg-slate-950/60 hover:bg-slate-900/75'}`}>
                                        <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-black ring-1 ${isRead ? 'bg-emerald-900/80 text-emerald-300 ring-emerald-700/60' : 'bg-slate-800 text-slate-500 ring-slate-700'}`}>
                                          {employee.username.slice(0, 1).toUpperCase()}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                          <p className={`truncate text-xs font-bold ${isRead ? 'text-emerald-50' : 'text-slate-400'}`}>{employee.username}</p>
                                          <p className={`truncate font-mono text-[11px] font-semibold ${isRead ? 'text-emerald-300/80' : 'text-slate-500'}`}>{employee.employee_id}</p>
                                        </div>
                                        <div className="shrink-0 text-right">
                                          <span className={`block text-[9px] font-black uppercase tracking-wide ${isRead ? 'text-emerald-300' : 'text-slate-500'}`}>
                                            {isRead ? '已讀' : '未讀'}
                                          </span>
                                          {isRead && (
                                            <span className="mt-0.5 block whitespace-nowrap text-[8px] font-semibold text-emerald-200/70" title={employee.message_read_at ? formatMessageDateTime(employee.message_read_at) : undefined}>
                                              {employee.message_read_at ? formatMessageDateTime(employee.message_read_at) : '時間不可用'}
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="rounded-xl border border-slate-500/25 bg-slate-950/25 px-3 py-3 text-xs text-slate-400">沒有符合的員工帳號。</p>
                              )}
                            </div>
                          );
                        }


                        return loadingRecipientDetails ? (
                          <div className="flex items-center justify-center rounded-xl border border-teal-300/15 bg-slate-950/25 py-6">
                            <div className="h-6 w-6 animate-spin rounded-full border-2 border-teal-400/30 border-t-teal-300" />
                          </div>
                        ) : (
                          <p className="rounded-xl border border-slate-500/25 bg-slate-950/25 px-3 py-3 text-xs text-slate-400">無法取得員工帳號詳情。</p>
                        );
                      })()
                    )}
                  </div>
                </div>

                {messageStats.has(selectedMessageDetail.id) && (() => {
                  const stats = messageStats.get(selectedMessageDetail.id)!;
                  return (
                    <div className="order-3 shrink-0 border-t border-slate-700/40 bg-slate-900/45 px-4 py-2.5">
                      <div className="mb-1.5 flex items-center justify-between gap-3">
                        <h4 className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-500">投遞進度</h4>
                        <span className="text-[9px] font-bold text-slate-400">{stats.read_count}/{stats.total_recipients} 已讀</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-700">
                        <div className={`h-full rounded-full transition-all ${stats.read_percentage === 100 ? 'bg-emerald-500' : 'bg-gradient-to-r from-blue-500 to-cyan-400'}`} style={{ width: `${stats.read_percentage}%` }} />
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {showSaveTemplateModal && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/75 p-3 backdrop-blur-md sm:p-5"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowSaveTemplateModal(false); setEditingTemplateId(null); setNewTemplateName(''); setTemplateEditorContent(''); setTemplateFormTitle(''); } }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative flex h-[calc(100vh-1.5rem)] max-h-[56rem] w-full max-w-[88rem] flex-col overflow-hidden rounded-[1.35rem] border border-emerald-300/25 bg-gradient-to-br from-emerald-950 via-slate-950 to-teal-950 shadow-[0_24px_80px_rgba(2,44,34,0.6)] sm:h-[calc(100vh-2.5rem)]"
          >
            <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-emerald-400/10 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-32 left-1/3 h-80 w-80 rounded-full bg-teal-400/10 blur-3xl" />

            <div className="relative flex shrink-0 items-center justify-between border-b border-emerald-200/15 bg-gradient-to-r from-emerald-500/20 via-teal-500/10 to-transparent px-4 py-3.5 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border shadow-inner shadow-white/10 ${editingTemplateId ? 'border-blue-200/35 bg-blue-400/15 text-blue-200' : 'border-emerald-200/35 bg-emerald-400/15 text-emerald-100'}`}>
                  {editingTemplateId ? <Pencil className="h-5 w-5" /> : <Bookmark className="h-5 w-5" />}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-sm font-black text-white sm:text-base">{editingTemplateId ? '編輯範本' : '建立訊息範本'}</h3>
                    <span className={`hidden rounded-full border px-2 py-0.5 text-[8px] font-black uppercase tracking-[0.16em] sm:inline-flex ${editingTemplateId ? 'border-blue-200/25 bg-blue-400/10 text-blue-200' : 'border-emerald-200/25 bg-emerald-400/10 text-emerald-200'}`}>
                      {editingTemplateId ? '編輯中' : '新範本'}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[10px] font-medium text-emerald-100/55">{editingTemplateId ? '更新已儲存的內容，讓團隊工作流程保持一致' : '建立具備清晰名稱、標題和內容的可重複使用通知'}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => { setShowSaveTemplateModal(false); setEditingTemplateId(null); setNewTemplateName(''); setTemplateEditorContent(''); setTemplateFormTitle(''); }}
                aria-label="關閉範本編輯器"
                className="ml-3 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-200/15 bg-slate-950/25 text-emerald-100/60 transition-all hover:border-emerald-200/45 hover:bg-emerald-400/15 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
              <div className="flex min-h-0 flex-1 flex-col gap-3 border-b border-emerald-200/15 p-4 sm:gap-4 sm:p-5 lg:w-[64%] lg:flex-none lg:border-b-0 lg:border-r">
                <div className="flex shrink-0 flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[9px] font-black tracking-[0.18em] text-emerald-200/70">範本名稱</label>
                    <span className="text-[9px] font-semibold text-emerald-200/45">必填</span>
                  </div>
                  <input
                    type="text"
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value.slice(0, 50))}
                    className="w-full rounded-xl border border-emerald-200/25 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-800 shadow-[0_8px_20px_rgba(2,44,34,0.16)] outline-none transition-all placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/30"
                    placeholder="例如：歡迎訊息或輪班提醒"
                    autoFocus
                  />
                </div>

                <div className="flex shrink-0 flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[9px] font-black tracking-[0.18em] text-emerald-200/70">通知標題</label>
                    <span className="text-[9px] font-semibold tabular-nums text-emerald-200/45">{templateFormTitle.length}/200</span>
                  </div>
                  <input
                    type="text"
                    value={templateFormTitle}
                    onChange={(e) => setTemplateFormTitle(e.target.value.slice(0, 200))}
                    placeholder="輸入簡潔的標題"
                    className="w-full rounded-xl border border-emerald-200/25 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-800 shadow-[0_8px_20px_rgba(2,44,34,0.14)] outline-none transition-all placeholder:text-slate-400 focus:border-emerald-400 focus:ring-2 focus:ring-emerald-400/30"
                  />
                </div>

                <div className="flex min-h-0 flex-1 flex-col gap-1.5">
                  <div className="flex shrink-0 items-center justify-between gap-2">
                    <label className="text-[9px] font-black tracking-[0.18em] text-emerald-200/70">訊息內容</label>
                    <span className="rounded-full border border-emerald-200/15 bg-emerald-400/10 px-2 py-0.5 text-[8px] font-bold text-emerald-200/65">支援豐富文字</span>
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-emerald-200/25 bg-white shadow-[0_10px_28px_rgba(2,44,34,0.18)] [&>div]:h-full [&>div]:flex [&>div]:flex-col">
                    <TiptapEditor
                      ref={templateEditorRef2}
                      content={templateEditorContent}
                      onChange={(html: string) => setTemplateEditorContent(html)}
                      placeholder="在此輸入可重複使用的通知內容..."
                      theme="light"
                      adminId=""
                      enableQuickCopy
                    />
                  </div>
                </div>
              </div>

              <aside className="flex min-h-0 flex-1 flex-col bg-gradient-to-b from-emerald-950/55 via-slate-950/60 to-teal-950/55 lg:w-[36%] lg:flex-none">
                <div className="relative shrink-0 border-b border-emerald-200/15 px-4 py-3.5 sm:px-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-[9px] font-black uppercase tracking-[0.2em] text-emerald-300/75">範本庫</p>
                      <h4 className="mt-1 text-sm font-black text-white">現有範本</h4>
                      <p className="mt-0.5 text-[10px] font-medium text-emerald-100/50">選擇卡片以載入編輯器</p>
                    </div>
                    <span className="shrink-0 rounded-full border border-emerald-200/25 bg-emerald-400/15 px-2 py-1 text-[9px] font-black tabular-nums text-emerald-100">{templates.length}</span>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-dark sm:p-4">
                  {templates.length === 0 ? (
                    <div className="flex h-full min-h-40 flex-col items-center justify-center rounded-2xl border border-dashed border-emerald-200/20 bg-emerald-400/[0.04] px-5 text-center">
                      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-emerald-200/20 bg-emerald-400/10 text-emerald-300/75">
                        <Bookmark className="h-5 w-5" />
                      </div>
                      <p className="text-xs font-bold text-emerald-100/80">尚無範本</p>
                      <p className="mt-1 max-w-52 text-[10px] leading-relaxed text-emerald-100/45">儲存此表單，以建立團隊第一個可重複使用的通知。</p>
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {templates.map(tpl => {
                        const isEditing = editingTemplateId === tpl.id;
                        const contentPreview = tpl.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                        return (
                          <div
                            key={tpl.id}
                            onClick={() => startEditTemplate(tpl)}
                            className={`group relative cursor-pointer overflow-hidden rounded-xl border p-2.5 transition-all hover:-translate-y-0.5 ${isEditing ? 'border-emerald-300/70 bg-gradient-to-br from-emerald-500/20 via-teal-500/10 to-slate-950/60 ring-1 ring-emerald-300/25 shadow-[0_8px_20px_rgba(16,185,129,0.16)]' : 'border-emerald-200/15 bg-gradient-to-br from-emerald-900/35 via-slate-950/60 to-teal-950/30 hover:border-emerald-300/45 hover:from-emerald-800/45 hover:to-teal-900/40 hover:shadow-[0_8px_20px_rgba(16,185,129,0.12)]'}`}
                          >
                            <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-emerald-300 via-teal-400 to-cyan-400 opacity-80" />
                            <div className="flex items-start gap-2 pl-1">
                              <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${isEditing ? 'border-emerald-200/35 bg-emerald-300/20 text-emerald-100' : 'border-emerald-200/15 bg-emerald-400/10 text-emerald-300/80'}`}>
                                <Bookmark className="h-3 w-3" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-start justify-between gap-2">
                                  <div className={`min-w-0 truncate text-[10px] font-black ${isEditing ? 'text-emerald-50' : 'text-white'}`}>{tpl.name}</div>
                                  <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
                                    <button
                                      type="button"
                                      onClick={(e) => { e.stopPropagation(); startEditTemplate(tpl); }}
                                      aria-label={`編輯 ${tpl.name}`}
                                      title="編輯範本"
                                      className="rounded-md p-1 text-emerald-200/60 transition-colors hover:bg-emerald-400/15 hover:text-emerald-100"
                                    >
                                      <Pencil className="h-3 w-3" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(e) => deleteTemplate(tpl.id, e)}
                                      aria-label={`刪除 ${tpl.name}`}
                                      title="刪除範本"
                                      className="rounded-md p-1 text-emerald-200/60 transition-colors hover:bg-red-400/15 hover:text-red-200"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </div>
                                </div>
                                {tpl.title && <div className="mt-0.5 truncate text-[9px] font-semibold text-emerald-100/65">{tpl.title}</div>}
                                {contentPreview && <p className="mt-1 line-clamp-1 text-[8px] leading-relaxed text-emerald-100/45">{contentPreview}</p>}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </aside>
            </div>

            <div className="relative flex shrink-0 flex-col gap-3 border-t border-emerald-200/15 bg-gradient-to-r from-emerald-950/90 via-slate-950/90 to-teal-950/90 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-end sm:px-5">
              <div className="flex items-center gap-2">
                {editingTemplateId && (
                  <button
                    type="button"
                    onClick={startNewTemplate}
                    className="rounded-xl border border-emerald-200/20 bg-emerald-400/10 px-4 py-2.5 text-xs font-bold text-emerald-200 transition-all hover:border-emerald-200/45 hover:bg-emerald-400/20 hover:text-emerald-100"
                  >
                    新增空白範本
                  </button>
                )}
                <button
                  type="button"
                  onClick={saveAsTemplate}
                  disabled={savingTemplate || !newTemplateName.trim()}
                  className={`inline-flex items-center justify-center gap-2 rounded-xl border px-5 py-2.5 text-xs font-black text-white shadow-lg transition-all disabled:cursor-not-allowed disabled:opacity-35 ${editingTemplateId ? 'border-blue-200/30 bg-gradient-to-r from-blue-500 to-indigo-500 shadow-blue-950/30 hover:from-blue-400 hover:to-indigo-400' : 'border-emerald-200/35 bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 shadow-emerald-950/35 hover:from-emerald-400 hover:via-teal-400 hover:to-cyan-400'}`}
                >
                  {savingTemplate ? <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : editingTemplateId ? <Save className="h-4 w-4" /> : <Bookmark className="h-4 w-4" />}
                  {savingTemplate ? '儲存中...' : editingTemplateId ? '更新範本' : '儲存範本'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showDeleteConfirm && deleteMode && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md">
          <section role="dialog" aria-modal="true" aria-labelledby="notification-delete-title" className="w-full max-w-md overflow-hidden rounded-[1.75rem] border border-rose-300/25 bg-slate-900 text-slate-100 shadow-[0_28px_90px_rgba(2,6,23,0.8)] ring-1 ring-inset ring-white/5">
            <div className="h-1 bg-gradient-to-r from-rose-600 via-red-400 to-orange-400" />
            <header className="flex items-start gap-3 border-b border-white/10 bg-gradient-to-br from-rose-500/10 via-slate-900 to-slate-900 px-5 py-5 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-rose-300/30 bg-rose-500/15 text-rose-200">
                <Trash2 className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-rose-300">已發送訊息 · 刪除確認</p>
                <h3 id="notification-delete-title" className="mt-1 text-lg font-bold tracking-tight text-white">{deleteMode === 'selected' ? '刪除所選通知？' : '刪除可管理通知？'}</h3>
                <p className="mt-1 text-xs text-slate-400">請確認要刪除的通知</p>
              </div>
              <button type="button" onClick={() => { setShowDeleteConfirm(false); setDeleteMode(null); }} disabled={deleting} aria-label="關閉刪除確認" className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-40"><X className="h-4 w-4" /></button>
            </header>
            <div className="space-y-4 px-5 py-5 sm:px-6">
              <div className="rounded-xl border border-white/10 bg-slate-950/50 p-4">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">刪除範圍</p>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-slate-100">{deleteMode === 'selected' ? '已選通知' : messageOriginFilter === 'manual' ? '全部手動通知' : '全部可管理通知'}</span>
                  <span className="shrink-0 rounded-lg border border-rose-300/25 bg-rose-500/10 px-2.5 py-1 text-sm font-bold tabular-nums text-rose-100">{deleteProgress?.total ?? (deleteMode === 'selected' ? selectedMessageIds.size : manageableGroupMessages.length)} 則</span>
                </div>
                {deleteMode === 'all' && messageOriginFilter !== 'manual' && <p className="mt-2 text-xs text-slate-400">不包含自動化通知</p>}
              </div>
              <p className="flex items-start gap-2 text-xs leading-5 text-amber-100/80"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" aria-hidden="true" />請核對通知數量後再確認刪除。</p>
              {deleting && deleteProgress && deleteProgress.total > 1 && <div role="progressbar" aria-label="刪除中" aria-valuemin={0} aria-valuemax={deleteProgress.total} aria-valuenow={deleteProgress.completed} className="h-1.5 overflow-hidden rounded-full bg-slate-700"><div className="h-full rounded-full bg-rose-400 transition-all" style={{ width: `${deleteProgress.completed / deleteProgress.total * 100}%` }} /></div>}
            </div>
            <footer className="grid grid-cols-2 gap-3 border-t border-white/10 bg-slate-950/40 px-5 py-4 sm:px-6">
              <button type="button" autoFocus onClick={() => { setShowDeleteConfirm(false); setDeleteMode(null); }} disabled={deleting} className="rounded-xl border border-slate-600 bg-slate-800 px-4 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40">取消</button>
              <button type="button" onClick={handleConfirmDelete} disabled={deleting} className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-300/40 bg-gradient-to-r from-rose-600 to-red-600 px-4 py-2.5 text-sm font-bold text-white shadow-lg shadow-rose-950/30 transition-colors hover:from-rose-500 hover:to-red-500 disabled:cursor-not-allowed disabled:opacity-50">
                {deleting ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden="true" />刪除中…</> : <><Trash2 className="h-4 w-4" aria-hidden="true" />確認刪除</>}
              </button>
            </footer>
          </section>
        </div>, document.body,
      )}
    </div>
  );
}
