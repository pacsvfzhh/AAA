import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  Gauge,
  Globe,
  LayoutList,
  Monitor,
  Pause,
  Pin,
  PinOff,
  Play,
  Plus,
  Save,
  Search,
  Trash2,
  Users,
  X,
  CreditCard as Edit,
} from 'lucide-react';
import { parse as marked, setOptions } from 'marked';
import { supabase } from '../../lib/supabase';
import { getAdminFinancialSessionToken } from '../../lib/auth';
import { Announcement, Admin } from '../../types';
import { sanitizeAnnouncementContent } from '../../lib/sanitizeHTML';
import { processContentImages } from '../../lib/imageOptimizer';
import { cleanupContentImages } from '../../lib/storageCleanup';
import AnnouncementDetailModal from '../AnnouncementDetailModal';
import TiptapEditor, { TiptapEditorRef } from './TiptapEditor';

interface AnnouncementManagementProps {
  admin: Admin;
}

interface SecondaryAdmin {
  id: string;
  username: string;
}

interface AnnouncementGroup {
  adminId: string;
  adminName: string;
  announcements: Announcement[];
}

interface AnnouncementDraft {
  title: string;
  content: string;
  isPinned: boolean;
  isGlobal: boolean;
  isHidden: boolean;
  pinOrder: number;
  publishAt: string;
}

type AnnouncementUpdate = Pick<Announcement, 'title' | 'content' | 'is_pinned' | 'is_hidden' | 'pin_order' | 'publish_at'>
  & Partial<Pick<Announcement, 'is_global'>>;
type AnnouncementInsert = AnnouncementUpdate & Pick<Announcement, 'created_by'>;
type StatusFilter = 'all' | 'pinned' | 'hidden' | 'global';
type WorkspaceMode = 'preview' | 'edit';
type EditorMode = 'create' | 'edit';
const MAX_ANNOUNCEMENT_CONTENT_BYTES = 500 * 1024;

const emptyDraft = (): AnnouncementDraft => ({
  title: '',
  content: '',
  isPinned: false,
  isGlobal: false,
  isHidden: false,
  pinOrder: 999,
  publishAt: formatLocalDateTime(new Date()),
});

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

function normalizeSearchText(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function fuzzyMatches(value: string, query: string) {
  const normalizedValue = normalizeSearchText(value);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery || normalizedValue.includes(normalizedQuery)) return true;

  const queryCharacters = Array.from(normalizedQuery);
  const valueCharacters = Array.from(normalizedValue);
  const maximumDistance = Math.floor(queryCharacters.length * 0.1);
  if (maximumDistance === 0 || valueCharacters.length === 0) return false;

  let previousRow = new Array<number>(valueCharacters.length + 1).fill(0);

  for (let queryIndex = 1; queryIndex <= queryCharacters.length; queryIndex += 1) {
    const currentRow = new Array<number>(valueCharacters.length + 1);
    currentRow[0] = queryIndex;

    for (let valueIndex = 1; valueIndex <= valueCharacters.length; valueIndex += 1) {
      const substitutionCost = queryCharacters[queryIndex - 1] === valueCharacters[valueIndex - 1] ? 0 : 1;
      currentRow[valueIndex] = Math.min(
        previousRow[valueIndex] + 1,
        currentRow[valueIndex - 1] + 1,
        previousRow[valueIndex - 1] + substitutionCost
      );
    }

    previousRow = currentRow;
  }

  return previousRow.reduce(
    (minimumDistance, distance) => Math.min(minimumDistance, distance),
    Number.POSITIVE_INFINITY
  ) <= maximumDistance;
}

function sortAnnouncements(announcements: Announcement[]) {
  return [...announcements].sort((a, b) => {
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1;
    if (a.is_pinned && b.is_pinned && a.pin_order !== b.pin_order) return a.pin_order - b.pin_order;
    return new Date(b.publish_at).getTime() - new Date(a.publish_at).getTime();
  });
}

function parseLocalDateTime(value: string) {
  const [datePart = '', timePart = ''] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hours = 0, minutes = 0] = timePart.split(':').map(Number);
  if (!year || !month || !day) return new Date();
  return new Date(year, month - 1, day, hours, minutes);
}

function formatLocalDateTime(value: Date) {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

setOptions({ breaks: true, gfm: true, pedantic: false });

export default function AnnouncementManagement({ admin }: AnnouncementManagementProps) {
  const isSuperAdmin = admin.role === 'super_admin';
  const editorRef = useRef<TiptapEditorRef>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const carouselMenuRef = useRef<HTMLDivElement>(null);
  const publishPickerRef = useRef<HTMLDivElement>(null);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [secondaryAdmins, setSecondaryAdmins] = useState<SecondaryAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAdminId, setSelectedAdminId] = useState(admin.id);
  const [selectedAnnouncementId, setSelectedAnnouncementId] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>('preview');
  const [editorMode, setEditorMode] = useState<EditorMode>('edit');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creatingForAdminId, setCreatingForAdminId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AnnouncementDraft>(emptyDraft);
  const [initialDraftSnapshot, setInitialDraftSnapshot] = useState(JSON.stringify(emptyDraft()));
  const [savingAnnouncement, setSavingAnnouncement] = useState(false);
  const [announcementSuccessMessage, setAnnouncementSuccessMessage] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [hiddenConfirmId, setHiddenConfirmId] = useState<string | null>(null);
  const [pinOrderModalId, setPinOrderModalId] = useState<string | null>(null);
  const [pinOrderValue, setPinOrderValue] = useState(999);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [showEmployeePreview, setShowEmployeePreview] = useState(false);
  const [carouselEnabled, setCarouselEnabled] = useState(true);
  const [carouselSpeed, setCarouselSpeed] = useState(0.6);
  const [savingCarouselSettings, setSavingCarouselSettings] = useState(false);
  const [showCarouselSuccessMessage, setShowCarouselSuccessMessage] = useState(false);
  const [carouselErrorMessage, setCarouselErrorMessage] = useState<string | null>(null);
  const [carouselPanelOpen, setCarouselPanelOpen] = useState(false);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const [publishPickerOpen, setPublishPickerOpen] = useState(false);

  const isDirty = workspaceMode === 'edit' && JSON.stringify(draft) !== initialDraftSnapshot;

  const renderMarkdown = useCallback((content: string) => {
    if (!content) return '';
    const lines = content.split('\n');
    const processedLines: string[] = [];

    lines.forEach((line, index) => {
      const previousLine = index > 0 ? lines[index - 1] : '';
      const isOrderedList = /^\s*\d+[.)]\s/.test(line);
      if (isOrderedList && index > 0 && previousLine.trim() && !/^\s*\d+[.)]\s/.test(previousLine)) {
        processedLines.push('');
      }
      processedLines.push(line);
    });

    const rendered = marked(processedLines.join('\n'));
    return typeof rendered === 'string' ? rendered : '';
  }, []);

  const loadSecondaryAdmins = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('admins')
        .select('id, username')
        .eq('role', 'secondary_admin')
        .eq('is_active', true)
        .order('username');
      if (error) throw error;
      setSecondaryAdmins(data || []);
    } catch (error) {
      console.error('Error loading secondary admins:', error);
    }
  }, []);

  const loadCarouselSettings = useCallback(async () => {
    try {
      const [{ data: enabledData, error: enabledError }, { data: speedData, error: speedError }] = await Promise.all([
        supabase.from('system_configs').select('value').eq('key', 'announcement_carousel_enabled').maybeSingle(),
        supabase.from('system_configs').select('value').eq('key', 'announcement_carousel_speed').maybeSingle(),
      ]);
      if (enabledError) throw enabledError;
      if (speedError) throw speedError;
      if (enabledData?.value !== undefined) setCarouselEnabled(enabledData.value === true);
      if (speedData?.value !== undefined) {
        setCarouselSpeed(typeof speedData.value === 'number' ? speedData.value : 0.6);
      }
    } catch (error) {
      console.error('Error loading carousel settings:', error);
    }
  }, []);

  const loadAnnouncements = useCallback(async () => {
    try {
      let query = supabase.from('announcements').select('*');
      if (!isSuperAdmin) query = query.eq('created_by', admin.id);
      const { data, error } = await query
        .order('is_pinned', { ascending: false })
        .order('pin_order', { ascending: true })
        .order('publish_at', { ascending: false });
      if (error) throw error;
      setAnnouncements(data || []);
      return data || [];
    } catch (error) {
      console.error('Error loading announcements:', error);
      return [];
    } finally {
      setLoading(false);
    }
  }, [admin.id, isSuperAdmin]);

  useEffect(() => {
    void loadAnnouncements();
    if (isSuperAdmin) {
      void loadSecondaryAdmins();
      void loadCarouselSettings();
    }
  }, [isSuperAdmin, loadAnnouncements, loadCarouselSettings, loadSecondaryAdmins]);

  useEffect(() => {
    if (deletingId || hiddenConfirmId || pinOrderModalId || pendingNavigation || showEmployeePreview) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [deletingId, hiddenConfirmId, pendingNavigation, pinOrderModalId, showEmployeePreview]);

  useEffect(() => {
    if (!groupMenuOpen && !carouselPanelOpen && !publishPickerOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (groupMenuOpen && !groupMenuRef.current?.contains(target)) setGroupMenuOpen(false);
      if (carouselPanelOpen && !carouselMenuRef.current?.contains(target)) setCarouselPanelOpen(false);
      if (publishPickerOpen && !publishPickerRef.current?.contains(target)) setPublishPickerOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setGroupMenuOpen(false);
        setCarouselPanelOpen(false);
        setPublishPickerOpen(false);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [carouselPanelOpen, groupMenuOpen, publishPickerOpen]);

  const groupedAnnouncements = useMemo<AnnouncementGroup[]>(() => {
    if (!isSuperAdmin) {
      return [{ adminId: admin.id, adminName: admin.username || '我的公告', announcements: sortAnnouncements(announcements) }];
    }

    return [
      {
        adminId: admin.id,
        adminName: `${admin.username}（超级管理员）`,
        announcements: sortAnnouncements(announcements.filter(item => item.created_by === admin.id)),
      },
      ...secondaryAdmins.map(secondaryAdmin => ({
        adminId: secondaryAdmin.id,
        adminName: secondaryAdmin.username,
        announcements: sortAnnouncements(announcements.filter(item => item.created_by === secondaryAdmin.id)),
      })),
    ];
  }, [admin.id, admin.username, announcements, isSuperAdmin, secondaryAdmins]);

  const selectedGroup = groupedAnnouncements.find(group => group.adminId === selectedAdminId) || groupedAnnouncements[0];
  const selectedAnnouncement = announcements.find(item => item.id === selectedAnnouncementId) || null;
  const selectedAdminName = selectedGroup?.adminName || admin.username;
  const selectedPublishDate = useMemo(() => parseLocalDateTime(draft.publishAt), [draft.publishAt]);

  const searchMatchedAnnouncements = useMemo(() => (
    (selectedGroup?.announcements || []).filter(item => fuzzyMatches(item.title, searchQuery))
  ), [searchQuery, selectedGroup]);

  const statusCounts = useMemo<Record<StatusFilter, number>>(() => ({
    all: searchMatchedAnnouncements.length,
    pinned: searchMatchedAnnouncements.filter(item => item.is_pinned).length,
    hidden: searchMatchedAnnouncements.filter(item => item.is_hidden).length,
    global: searchMatchedAnnouncements.filter(item => item.is_global).length,
  }), [searchMatchedAnnouncements]);

  const visibleAnnouncements = useMemo(() => (
    searchMatchedAnnouncements.filter(item => (
      statusFilter === 'all'
      || (statusFilter === 'pinned' && item.is_pinned)
      || (statusFilter === 'hidden' && item.is_hidden)
      || (statusFilter === 'global' && item.is_global)
    ))
  ), [searchMatchedAnnouncements, statusFilter]);

  useEffect(() => {
    if (!selectedGroup && groupedAnnouncements.length > 0) {
      setSelectedAdminId(groupedAnnouncements[0].adminId);
    }
  }, [groupedAnnouncements, selectedGroup]);

  const requestNavigation = (action: () => void) => {
    if (isDirty) {
      setPendingNavigation(() => action);
      return;
    }
    action();
  };

  const openPreview = (announcement: Announcement) => {
    requestNavigation(() => {
      setSelectedAdminId(announcement.created_by);
      setSelectedAnnouncementId(announcement.id);
      setWorkspaceMode('preview');
      setEditingId(null);
      setCreatingForAdminId(null);
    });
  };

  const toggleAnnouncementSelection = (announcement: Announcement) => {
    if (selectedAnnouncementId !== announcement.id) {
      openPreview(announcement);
      return;
    }

    requestNavigation(() => {
      setSelectedAnnouncementId(null);
      setWorkspaceMode('preview');
      setEditingId(null);
      setCreatingForAdminId(null);
    });
  };

  const startEdit = (announcement: Announcement) => {
    requestNavigation(() => {
      const nextDraft: AnnouncementDraft = {
        title: announcement.title,
        content: announcement.content,
        isPinned: announcement.is_pinned,
        isGlobal: announcement.is_global || false,
        isHidden: announcement.is_hidden || false,
        pinOrder: announcement.pin_order || 999,
        publishAt: formatLocalDateTime(new Date(announcement.publish_at)),
      };
      setSelectedAdminId(announcement.created_by);
      setSelectedAnnouncementId(announcement.id);
      setEditingId(announcement.id);
      setCreatingForAdminId(announcement.created_by);
      setEditorMode('edit');
      setDraft(nextDraft);
      setInitialDraftSnapshot(JSON.stringify(nextDraft));
      setWorkspaceMode('edit');
    });
  };

  const startCreateForAdmin = (adminId: string) => {
    requestNavigation(() => {
      const nextDraft = emptyDraft();
      setSelectedAdminId(adminId);
      setSelectedAnnouncementId(null);
      setEditingId(null);
      setCreatingForAdminId(adminId);
      setEditorMode('create');
      setDraft(nextDraft);
      setInitialDraftSnapshot(JSON.stringify(nextDraft));
      setWorkspaceMode('edit');
    });
  };

  const leaveEditor = () => {
    requestNavigation(() => {
      setWorkspaceMode('preview');
      setEditingId(null);
      setCreatingForAdminId(null);
    });
  };

  const changeAdminGroup = (adminId: string) => {
    requestNavigation(() => {
      setSelectedAdminId(adminId);
      setSelectedAnnouncementId(null);
      setWorkspaceMode('preview');
      setEditingId(null);
      setCreatingForAdminId(null);
      setSearchQuery('');
      setStatusFilter('all');
      setGroupMenuOpen(false);
    });
  };

  const saveCarouselSettings = async (enabled = carouselEnabled) => {
    setSavingCarouselSettings(true);
    setCarouselErrorMessage(null);
    try {
      const token = getAdminFinancialSessionToken();
      const { error: enabledError } = await supabase.rpc('admin_save_shared_system_config', {
        p_admin_session_token: token,
        p_key: 'announcement_carousel_enabled',
        p_value: enabled,
      });
      if (enabledError) throw enabledError;

      const { error: speedError } = await supabase.rpc('admin_save_shared_system_config', {
        p_admin_session_token: token,
        p_key: 'announcement_carousel_speed',
        p_value: carouselSpeed,
      });
      if (speedError) throw speedError;

      setShowCarouselSuccessMessage(true);
      window.setTimeout(() => setShowCarouselSuccessMessage(false), 3000);
      return true;
    } catch (error) {
      console.error('Error saving carousel settings:', error);
      setCarouselErrorMessage(getErrorMessage(error, '保存轮播设置失败'));
      window.setTimeout(() => setCarouselErrorMessage(null), 5000);
      return false;
    } finally {
      setSavingCarouselSettings(false);
    }
  };

  const toggleCarouselEnabled = async () => {
    if (savingCarouselSettings) return;
    const previousValue = carouselEnabled;
    const nextValue = !previousValue;
    setCarouselEnabled(nextValue);
    const saved = await saveCarouselSettings(nextValue);
    if (!saved) setCarouselEnabled(previousValue);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.title.trim()) {
      alert('请输入公告标题');
      return;
    }

    setSavingAnnouncement(true);
    try {
      const rawContent = editorRef.current?.getContent() || draft.content;
      const editorContent = await processContentImages(rawContent, 'announcements');
      const contentSize = new Blob([editorContent]).size;
      if (contentSize > MAX_ANNOUNCEMENT_CONTENT_BYTES) {
        throw new Error('公告正文资料超过 500KB，请减少内嵌内容或重新上传过大的媒体');
      }
      const publishAtUtc = parseLocalDateTime(draft.publishAt).toISOString();
      let savedAnnouncementId = editingId;

      if (editingId) {
        const updateData: AnnouncementUpdate = {
          title: draft.title.trim(),
          content: editorContent,
          is_pinned: draft.isPinned,
          is_hidden: draft.isHidden,
          pin_order: draft.pinOrder,
          publish_at: publishAtUtc,
        };
        if (isSuperAdmin) updateData.is_global = draft.isGlobal;
        const { error } = await supabase.from('announcements').update(updateData).eq('id', editingId);
        if (error) throw error;
      } else {
        const insertData: AnnouncementInsert = {
          title: draft.title.trim(),
          content: editorContent,
          is_pinned: draft.isPinned,
          is_hidden: draft.isHidden,
          pin_order: draft.pinOrder,
          publish_at: publishAtUtc,
          created_by: creatingForAdminId || selectedAdminId || admin.id,
          is_global: isSuperAdmin ? draft.isGlobal : false,
        };
        const { data, error } = await supabase.from('announcements').insert(insertData).select('*').single();
        if (error) throw error;
        savedAnnouncementId = data.id;
      }

      const refreshed = await loadAnnouncements();
      const savedAnnouncement = refreshed.find(item => item.id === savedAnnouncementId);
      setSelectedAnnouncementId(savedAnnouncementId);
      if (savedAnnouncement) setSelectedAdminId(savedAnnouncement.created_by);
      setWorkspaceMode('preview');
      setEditingId(null);
      setCreatingForAdminId(null);
      setInitialDraftSnapshot(JSON.stringify({ ...draft, content: editorContent }));
      setAnnouncementSuccessMessage(editingId ? '公告更新成功' : '公告新增成功');
      window.setTimeout(() => setAnnouncementSuccessMessage(null), 3500);
    } catch (error) {
      console.error('Error saving announcement:', error);
      alert(`保存公告失败：${getErrorMessage(error, '未知错误')}`);
    } finally {
      setSavingAnnouncement(false);
    }
  };

  const deleteAnnouncement = async (id: string) => {
    try {
      const announcement = announcements.find(item => item.id === id);
      if (announcement?.content) await cleanupContentImages(announcement.content).catch(() => undefined);
      const { error } = await supabase.from('announcements').delete().eq('id', id);
      if (error) throw error;
      setDeletingId(null);
      if (selectedAnnouncementId === id) {
        setSelectedAnnouncementId(null);
        setWorkspaceMode('preview');
      }
      await loadAnnouncements();
    } catch (error) {
      console.error('Error deleting announcement:', error);
    }
  };

  const toggleHidden = async (announcement: Announcement) => {
    const nextHiddenState = !announcement.is_hidden;
    setAnnouncements(previous => previous.map(item => (
      item.id === announcement.id ? { ...item, is_hidden: nextHiddenState } : item
    )));
    try {
      const { error } = await supabase
        .from('announcements')
        .update({ is_hidden: nextHiddenState })
        .eq('id', announcement.id);
      if (error) throw error;
    } catch (error) {
      console.error('Error toggling hidden state:', error);
      await loadAnnouncements();
    }
  };

  const toggleGlobal = async (announcement: Announcement) => {
    if (!isSuperAdmin) return;
    const nextGlobalState = !announcement.is_global;
    setAnnouncements(previous => previous.map(item => (
      item.id === announcement.id ? { ...item, is_global: nextGlobalState } : item
    )));
    try {
      const { error } = await supabase
        .from('announcements')
        .update({ is_global: nextGlobalState })
        .eq('id', announcement.id);
      if (error) throw error;
    } catch (error) {
      console.error('Error toggling global state:', error);
      await loadAnnouncements();
      alert('更新全局状态失败');
    }
  };

  const togglePin = async (announcement: Announcement) => {
    if (!announcement.is_pinned) {
      setPinOrderModalId(announcement.id);
      setPinOrderValue(announcement.pin_order || 999);
      return;
    }

    setAnnouncements(previous => previous.map(item => (
      item.id === announcement.id ? { ...item, is_pinned: false } : item
    )));
    try {
      const { error } = await supabase.from('announcements').update({ is_pinned: false }).eq('id', announcement.id);
      if (error) throw error;
    } catch (error) {
      console.error('Error toggling pin:', error);
      await loadAnnouncements();
      alert('更新置顶状态失败');
    }
  };

  const confirmPin = async () => {
    if (!pinOrderModalId) return;
    const announcement = announcements.find(item => item.id === pinOrderModalId);
    if (!announcement) return;

    setAnnouncements(previous => previous.map(item => (
      item.id === pinOrderModalId ? { ...item, is_pinned: true, pin_order: pinOrderValue } : item
    )));
    try {
      const { error } = await supabase
        .from('announcements')
        .update({ is_pinned: true, pin_order: pinOrderValue })
        .eq('id', pinOrderModalId);
      if (error) throw error;
      setPinOrderModalId(null);
    } catch (error) {
      console.error('Error pinning announcement:', error);
      await loadAnnouncements();
      setPinOrderModalId(null);
      alert('置顶公告失败');
    }
  };

  const actionButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70';

  const renderStatusBadges = (announcement: Announcement, highContrast = false) => (
    <div className="flex flex-wrap items-center gap-1.5">
      {announcement.is_pinned && (
        <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${highContrast ? 'border-white/35 bg-slate-950/35 text-white shadow-sm' : 'border-amber-400/30 bg-amber-500/10 text-amber-300'}`}>
          <Pin className="h-2.5 w-2.5" />置顶 {announcement.pin_order}
        </span>
      )}
      {announcement.is_global && (
        <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${highContrast ? 'border-white/35 bg-slate-950/35 text-white shadow-sm' : 'border-emerald-400/30 bg-emerald-500/10 text-emerald-300'}`}>
          <Globe className="h-2.5 w-2.5" />全局
        </span>
      )}
      {announcement.is_hidden && (
        <span className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold ${highContrast ? 'border-white/35 bg-slate-950/35 text-white shadow-sm' : 'border-red-400/35 bg-red-500/12 text-red-300'}`}>
          <EyeOff className="h-2.5 w-2.5" />隐藏
        </span>
      )}
    </div>
  );

  const getAnnouncementCardTone = (announcement: Announcement) => {
    if (announcement.is_hidden) {
      return {
        active: 'border-red-300/80 bg-[linear-gradient(105deg,rgba(220,38,38,0.95),rgba(153,27,27,0.94)_58%,rgba(76,5,25,0.96))] shadow-lg shadow-red-950/60',
        idle: 'border-red-900/60 bg-[linear-gradient(105deg,rgba(127,29,29,0.25),rgba(15,23,42,0.72))] shadow-red-950/20 hover:border-red-500/50 hover:bg-[linear-gradient(105deg,rgba(153,27,27,0.32),rgba(15,23,42,0.82))]',
        accent: 'from-red-300 to-rose-600 shadow-[0_0_8px_rgba(248,113,113,0.72)]',

        date: 'border-red-400/30 bg-red-500/10 text-red-100',
      };
    }
    if (announcement.is_pinned) {
      return {
        active: 'border-amber-200/85 bg-[linear-gradient(105deg,rgba(217,119,6,0.96),rgba(180,83,9,0.94)_58%,rgba(69,26,3,0.97))] shadow-lg shadow-amber-950/60',
        idle: 'border-amber-800/55 bg-[linear-gradient(105deg,rgba(120,53,15,0.25),rgba(15,23,42,0.72))] shadow-amber-950/20 hover:border-amber-500/50 hover:bg-[linear-gradient(105deg,rgba(146,64,14,0.33),rgba(15,23,42,0.82))]',
        accent: 'from-amber-200 to-orange-500 shadow-[0_0_8px_rgba(251,191,36,0.72)]',
        date: 'border-amber-400/30 bg-amber-500/10 text-amber-100',
      };
    }
    if (announcement.is_global) {
      return {
        active: 'border-emerald-200/80 bg-[linear-gradient(105deg,rgba(5,150,105,0.96),rgba(4,120,87,0.94)_58%,rgba(2,44,34,0.97))] shadow-lg shadow-emerald-950/60',
        idle: 'border-emerald-900/55 bg-[linear-gradient(105deg,rgba(6,78,59,0.25),rgba(15,23,42,0.72))] shadow-emerald-950/20 hover:border-emerald-500/45 hover:bg-[linear-gradient(105deg,rgba(6,95,70,0.32),rgba(15,23,42,0.82))]',
        accent: 'from-emerald-300 to-teal-600 shadow-[0_0_8px_rgba(52,211,153,0.68)]',
        date: 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100',
      };
    }
    return {
      active: 'border-cyan-200/80 bg-[linear-gradient(105deg,rgba(8,145,178,0.96),rgba(14,116,144,0.94)_58%,rgba(8,47,73,0.97))] shadow-lg shadow-cyan-950/60',
      idle: 'border-blue-700/60 bg-[linear-gradient(105deg,rgba(30,64,175,0.34),rgba(8,47,73,0.68)_62%,rgba(15,23,42,0.78))] shadow-blue-950/25 hover:border-cyan-400/55 hover:bg-[linear-gradient(105deg,rgba(37,99,235,0.42),rgba(14,116,144,0.72),rgba(15,23,42,0.82))]',
      accent: 'from-cyan-300 to-blue-500 shadow-[0_0_8px_rgba(34,211,238,0.7)]',
      date: 'border-blue-400/30 bg-blue-950/45 text-blue-100',
    };
  };

  const hiddenConfirmAnnouncement = announcements.find(item => item.id === hiddenConfirmId) || null;
  const deletingAnnouncement = announcements.find(item => item.id === deletingId) || null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950 text-slate-100">
      <div className="relative z-30 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cyan-300/20 bg-[linear-gradient(90deg,rgba(8,47,73,0.78),rgba(15,23,42,0.94))] px-3 py-2 sm:px-4">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <div className="flex shrink-0 items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200">
              <LayoutList className="h-4.5 w-4.5" />
            </span>
            <h2 className="whitespace-nowrap text-sm font-black text-white sm:text-base">公告内容管理</h2>
          </div>

          <div ref={groupMenuRef} className="relative">
            <button
              type="button"
              onClick={() => {
                setGroupMenuOpen(value => !value);
                setCarouselPanelOpen(false);
              }}
              className="inline-flex h-9 w-[250px] items-center gap-2 rounded-xl border border-cyan-300/25 bg-slate-950/45 px-3 text-left shadow-sm transition hover:border-cyan-300/45 hover:bg-slate-900"
              aria-expanded={groupMenuOpen}
              aria-haspopup="menu"
            >
              <Users className="h-4 w-4 shrink-0 text-cyan-300" />
              <span className="min-w-0 flex-1 truncate text-sm font-black leading-none text-white">{selectedAdminName}</span>
              <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${groupMenuOpen ? 'rotate-180' : ''}`} />
            </button>
            {groupMenuOpen && (
              <div role="menu" className="announcement-group-menu absolute left-0 top-[calc(100%+6px)] z-50 max-h-[360px] w-full overflow-y-auto rounded-xl border border-cyan-300/30 bg-[linear-gradient(145deg,rgba(8,47,73,0.98),rgba(15,23,42,0.99)_55%,rgba(2,12,27,0.99))] p-1.5 shadow-[0_20px_50px_rgba(0,0,0,0.62),0_0_24px_rgba(8,145,178,0.1)]">
                <div className="mb-1 flex items-center justify-between px-2 py-1.5">
                  <span className="text-[10px] font-black text-slate-200">管理员分组</span>
                  <span className="rounded-full border border-cyan-300/20 bg-cyan-500/10 px-2 py-0.5 text-[9px] font-black text-cyan-100">{announcements.length} 则公告</span>
                </div>
                <div className="space-y-1">
                  {groupedAnnouncements.map(group => {
                    const active = group.adminId === selectedAdminId;
                    return (
                      <button
                        key={group.adminId}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        onClick={() => changeAdminGroup(group.adminId)}
                        className={`relative flex w-full items-center gap-2 rounded-lg border px-2.5 py-2.5 text-left transition ${active ? 'border-cyan-400/45 bg-cyan-500/15 text-white' : 'border-transparent bg-slate-900/35 text-slate-200 hover:border-slate-700 hover:bg-slate-800 hover:text-white'}`}
                      >
                        {active && <span className="absolute bottom-1.5 left-0 top-1.5 w-1 rounded-r-full bg-cyan-400" />}
                        {group.adminId === admin.id ? <Globe className="h-3.5 w-3.5 shrink-0 text-emerald-300" /> : <Users className="h-3.5 w-3.5 shrink-0 text-blue-300" />}
                        <span className="min-w-0 flex-1 truncate text-xs font-black text-slate-100">{group.adminName}</span>
                        <span className={`inline-flex min-w-8 shrink-0 items-center justify-center rounded-md border px-1.5 py-1 text-[11px] font-black tabular-nums ${active ? 'border-cyan-300/40 bg-cyan-500/25 text-white' : 'border-sky-300/30 bg-sky-500/15 text-sky-100'}`} title={`${group.announcements.length} 则公告`}>{group.announcements.length}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {isSuperAdmin && (
            <div ref={carouselMenuRef} className="relative flex h-9 w-[250px] items-stretch overflow-visible rounded-xl border border-emerald-300/30 bg-[linear-gradient(100deg,rgba(6,78,59,0.28),rgba(15,23,42,0.5))] shadow-sm shadow-emerald-950/20">
              <button
                type="button"
                onClick={() => void toggleCarouselEnabled()}
                disabled={savingCarouselSettings}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-l-xl px-2.5 text-left transition hover:bg-emerald-500/10 disabled:opacity-60"
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border ${carouselEnabled ? 'border-emerald-300/35 bg-emerald-500/20 text-emerald-200' : 'border-slate-500 bg-slate-700/80 text-slate-200'}`}>
                  {carouselEnabled ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1 whitespace-nowrap text-[13px] font-black leading-none text-slate-100">公告栏自动滚动</span>
                <span className={`relative h-5 w-9 shrink-0 rounded-full transition ${carouselEnabled ? 'bg-emerald-500' : 'bg-slate-600'}`}>
                  <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${carouselEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                </span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setCarouselPanelOpen(value => !value);
                  setGroupMenuOpen(false);
                }}
                className="flex w-8 shrink-0 items-center justify-center rounded-r-xl border-l border-emerald-300/20 text-emerald-200/70 transition hover:bg-emerald-500/15 hover:text-white"
                aria-label="调整自动滚动速度"
                aria-expanded={carouselPanelOpen}
              >
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${carouselPanelOpen ? 'rotate-180' : ''}`} />
              </button>
              {carouselPanelOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-50 flex h-[330px] w-[300px] flex-col overflow-hidden rounded-2xl border border-emerald-300/30 bg-[linear-gradient(145deg,rgba(6,78,59,0.98),rgba(15,23,42,0.99)_52%,rgba(2,12,27,0.99))] p-3.5 shadow-[0_22px_60px_rgba(0,0,0,0.68),0_0_28px_rgba(16,185,129,0.1)]">
                  <div className="flex items-start justify-between gap-3 border-b border-emerald-300/15 pb-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-emerald-300/25 bg-emerald-500/15 text-emerald-200"><Gauge className="h-4 w-4" /></span>
                      <div className="min-w-0">
                        <h3 className="text-xs font-black text-white">自动滚动设置</h3>
                        <p className="mt-1 text-[10px] leading-none text-emerald-100/65">调整员工端公告轮播速度</p>
                      </div>
                    </div>
                    <span className={`rounded-lg border px-2 py-1 text-[9px] font-black ${carouselEnabled ? 'border-emerald-300/30 bg-emerald-500/15 text-emerald-100' : 'border-slate-500/40 bg-slate-700/60 text-slate-200'}`}>{carouselEnabled ? '已开启' : '已关闭'}</span>
                  </div>
                  <div className="mt-3 rounded-xl border border-emerald-300/15 bg-slate-950/45 p-3">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-[11px] font-black text-slate-100">滚动速度</span>
                      <span className="rounded-lg border border-emerald-300/25 bg-emerald-500/15 px-2.5 py-1 font-mono text-[11px] font-black text-emerald-100">{carouselSpeed.toFixed(1)}x</span>
                    </div>
                    <input type="range" min="0.1" max="5" step="0.1" value={carouselSpeed} onChange={event => setCarouselSpeed(Number(event.target.value))} className="h-2 w-full cursor-pointer accent-emerald-400" />
                    <div className="mt-1 flex justify-between text-[9px] font-bold text-slate-400"><span>较慢</span><span>较快</span></div>
                    <div className="mt-3 grid grid-cols-5 gap-1.5">
                      {[0.3, 0.6, 1, 2, 3].map(speed => <button key={speed} type="button" onClick={() => setCarouselSpeed(speed)} className={`rounded-lg border py-1.5 text-[10px] font-black transition ${Math.abs(carouselSpeed - speed) < 0.05 ? 'border-emerald-300/50 bg-emerald-600 text-white shadow-sm shadow-emerald-950/40' : 'border-slate-600/70 bg-slate-800/90 text-slate-200 hover:border-emerald-400/35 hover:bg-slate-700 hover:text-white'}`}>{speed}x</button>)}
                    </div>
                  </div>
                  <div className="mt-2.5 h-10 shrink-0">
                    {showCarouselSuccessMessage ? (
                      <p className="flex h-full items-center gap-1.5 rounded-lg border border-emerald-300/20 bg-emerald-500/10 px-2.5 text-[10px] font-bold text-emerald-100"><CheckCircle2 className="h-3.5 w-3.5 shrink-0" />滚动速度已保存</p>
                    ) : carouselErrorMessage ? (
                      <p className="line-clamp-2 flex h-full items-center gap-1.5 rounded-lg border border-red-400/25 bg-red-500/10 px-2.5 text-[10px] font-bold leading-4 text-red-100"><AlertCircle className="h-3.5 w-3.5 shrink-0" />{carouselErrorMessage}</p>
                    ) : (
                      <p className="flex h-full items-center rounded-lg border border-slate-600/40 bg-slate-900/35 px-2.5 text-[10px] font-bold text-slate-300">调整速度后点击下方按钮保存</p>
                    )}
                  </div>
                  <button type="button" onClick={() => void saveCarouselSettings()} disabled={savingCarouselSettings} className="mt-auto flex h-9 w-full shrink-0 items-center justify-center gap-1.5 rounded-xl border border-emerald-300/25 bg-gradient-to-r from-emerald-700 to-teal-700 text-[11px] font-black text-white shadow-md shadow-emerald-950/35 transition hover:from-emerald-600 hover:to-teal-600 disabled:opacity-50"><Save className="h-3.5 w-3.5" />{savingCarouselSettings ? '保存中…' : '保存滚动速度'}</button>
                </div>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => startCreateForAdmin(selectedAdminId)}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-r from-cyan-600 to-blue-700 px-3 text-xs font-black text-white shadow-lg shadow-cyan-950/30 transition hover:from-cyan-500 hover:to-blue-600"
        >
          <Plus className="h-4 w-4" />新增公告
        </button>
      </div>

      <div className="shrink-0 border-b border-slate-700 bg-slate-900 p-2 lg:hidden">
        <select
          value={selectedAnnouncementId || ''}
          onChange={event => {
            const announcement = announcements.find(item => item.id === event.target.value);
            if (announcement) openPreview(announcement);
          }}
          className="w-full min-w-0 rounded-lg border border-slate-600 bg-slate-800 px-2 py-2 text-xs font-bold text-white outline-none focus:border-cyan-400"
        >
          <option value="">选择公告</option>
          {(selectedGroup?.announcements || []).map(announcement => (
            <option key={announcement.id} value={announcement.id}>{announcement.title}</option>
          ))}
        </select>
      </div>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="hidden min-h-0 flex-col border-r border-cyan-950/70 bg-[linear-gradient(180deg,rgba(15,23,42,0.98),rgba(8,20,38,0.98))] lg:flex">
          <div className="relative shrink-0 overflow-hidden border-b border-cyan-900/45 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.13),transparent_42%),linear-gradient(145deg,rgba(15,23,42,0.98),rgba(8,47,73,0.4))] p-3">
            <div className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-cyan-400/10 blur-2xl" />
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
              <input
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder="搜索公告标题（相似度 ≥ 90%）"
                className="h-10 w-full rounded-xl border border-white/80 bg-slate-50 pl-9 pr-9 text-xs font-bold text-slate-800 shadow-[0_8px_22px_rgba(2,8,23,0.22),inset_0_1px_0_rgba(255,255,255,0.9)] outline-none transition placeholder:font-medium placeholder:text-slate-400 focus:border-cyan-400 focus:bg-white focus:ring-2 focus:ring-cyan-400/20"
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-200 hover:text-slate-700" aria-label="清除搜索">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <div className="relative mt-2 grid grid-cols-4 gap-1 rounded-xl border border-white/10 bg-slate-950/35 p-1 shadow-inner shadow-slate-950/50">
              {([
                { value: 'all', label: '全部', activeClass: 'border-sky-300/60 bg-sky-500 text-white shadow-sky-950/40', idleClass: 'border-transparent text-sky-200 hover:bg-sky-500/15' },
                { value: 'global', label: '全局', activeClass: 'border-violet-300/60 bg-violet-500 text-white shadow-violet-950/40', idleClass: 'border-transparent text-violet-200 hover:bg-violet-500/15' },
                { value: 'pinned', label: '置顶', activeClass: 'border-amber-200/60 bg-amber-500 text-white shadow-amber-950/40', idleClass: 'border-transparent text-amber-200 hover:bg-amber-500/15' },
                { value: 'hidden', label: '隐藏', activeClass: 'border-rose-300/60 bg-rose-600 text-white shadow-rose-950/40', idleClass: 'border-transparent text-rose-200 hover:bg-rose-500/15' },
              ] as const).map(({ value, label, activeClass, idleClass }) => {
                const active = statusFilter === value;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setStatusFilter(value)}
                    aria-pressed={active}
                    className={`flex h-7 min-w-0 items-center justify-center gap-1 rounded-lg border px-1 text-[10px] font-black leading-none shadow-md transition duration-200 ${active ? activeClass : idleClass}`}
                  >
                    <span>{label}</span>
                    <span className={`inline-flex min-w-4 items-center justify-center rounded px-1 py-0.5 text-[9px] font-black tabular-nums ${active ? 'bg-white/20 text-white' : 'bg-slate-950/35 text-current'}`}>
                      {statusCounts[value]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="dark-panel-scroll min-h-0 flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top_left,rgba(14,116,144,0.08),transparent_34%)] p-1.5">
            {loading ? (
              <div className="py-10 text-center text-xs text-slate-500">正在加载公告…</div>
            ) : visibleAnnouncements.length === 0 ? (
              <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-950/30 px-4 text-center">
                <LayoutList className="mb-2 h-7 w-7 text-slate-600" />
                <p className="text-xs font-bold text-slate-400">当前分组没有符合条件的公告</p>
                <button type="button" onClick={() => startCreateForAdmin(selectedAdminId)} className="mt-3 text-[11px] font-bold text-cyan-300 hover:text-cyan-200">新增第一则公告</button>
              </div>
            ) : visibleAnnouncements.map((announcement, index) => {
              const active = announcement.id === selectedAnnouncementId;
              const cardTone = getAnnouncementCardTone(announcement);
              return (
                <button
                  key={announcement.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => toggleAnnouncementSelection(announcement)}
                  className={`group relative mb-1 w-full overflow-hidden rounded-lg border px-2 py-2 text-left shadow-sm transition duration-200 hover:-translate-y-px hover:brightness-110 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 ${active ? `${cardTone.active} z-10 ring-1 ring-inset ring-white/25` : cardTone.idle}`}
                >
                  {active && <span className={`absolute bottom-1 left-0 top-1 w-1 rounded-r-full bg-gradient-to-b ${cardTone.accent}`} />}
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[10px] font-black tabular-nums ${active ? 'border-white/40 bg-slate-950/40 text-white shadow-sm ring-1 ring-white/25' : `${cardTone.date} opacity-85 group-hover:opacity-100`}`}>
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <h3 className={`min-w-0 flex-1 truncate text-[11px] font-black leading-4 ${active ? 'text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.65)]' : 'text-slate-200 group-hover:text-white'}`}>{announcement.title}</h3>
                        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform group-hover:translate-x-0.5 ${active ? 'text-white drop-shadow-md' : 'text-slate-600 group-hover:text-slate-300'}`} />
                      </div>
                      <div className="mt-1.5 flex min-w-0 items-center justify-between gap-1.5">
                        <div className="min-w-0 overflow-hidden">{renderStatusBadges(announcement, active)}</div>
                        <span className={`inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-[9px] font-black tabular-nums ${active ? 'border-white/35 bg-slate-950/35 text-white shadow-sm' : cardTone.date}`}>
                          <Calendar className="h-2.5 w-2.5" />
                          {new Date(announcement.publish_at).toLocaleDateString()}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

        </aside>

        <main className="min-h-0 min-w-0 overflow-hidden bg-[radial-gradient(circle_at_top_right,rgba(8,145,178,0.08),transparent_34%),#0f172a]">
          {workspaceMode === 'edit' ? (
            <form onSubmit={handleSubmit} className="flex h-full min-h-0 flex-col">
              <div className="relative z-20 shrink-0 border-b border-cyan-300/20 bg-[radial-gradient(circle_at_top_left,rgba(8,145,178,0.2),transparent_38%),linear-gradient(105deg,rgba(8,47,73,0.88),rgba(15,23,42,0.98)_68%)] px-3 py-2.5 shadow-lg shadow-slate-950/20 sm:px-4">
                <div className="pointer-events-none absolute -left-8 -top-12 h-32 w-32 rounded-full bg-cyan-400/10 blur-3xl" />
                <div className="relative flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <button type="button" onClick={leaveEditor} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-300/25 bg-slate-950/35 text-cyan-100 transition hover:border-cyan-300/45 hover:bg-cyan-500/15 hover:text-white" aria-label="返回公告预览">
                      <ArrowLeft className="h-4 w-4" />
                    </button>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-white">{editorMode === 'create' ? '新增公告' : '编辑公告'}</p>
                      <p className="mt-0.5 truncate text-[10px] font-bold text-cyan-100/65">所属管理员：<span className="text-white">{selectedAdminName}</span></p>
                    </div>
                    {editorMode === 'edit' && isDirty && <span className="hidden rounded-full border border-amber-300/25 bg-amber-500/15 px-2 py-0.5 text-[9px] font-black text-amber-200 sm:inline">未保存</span>}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button type="button" onClick={() => setShowEmployeePreview(true)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-violet-300/25 bg-violet-500/10 px-2.5 text-[10px] font-black text-violet-100 transition hover:bg-violet-500/20">
                      <Monitor className="h-3.5 w-3.5" />员工端预览
                    </button>
                    <button type="submit" disabled={savingAnnouncement} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-cyan-300/30 bg-gradient-to-r from-cyan-600 to-blue-700 px-3 text-[10px] font-black text-white shadow-md shadow-cyan-950/35 transition hover:from-cyan-500 hover:to-blue-600 disabled:opacity-50">
                      <Save className="h-3.5 w-3.5" />{savingAnnouncement ? '保存中…' : '保存公告'}
                    </button>
                  </div>
                </div>

                <div className="relative mt-2 flex flex-wrap items-center gap-1.5">
                  <div ref={publishPickerRef} className="relative">
                    <button
                      type="button"
                      onClick={() => setPublishPickerOpen(previous => !previous)}
                      aria-expanded={publishPickerOpen}
                      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border bg-slate-950/35 px-2.5 text-[10px] font-bold text-slate-200 transition ${publishPickerOpen ? 'border-cyan-300/60 ring-2 ring-cyan-400/15' : 'border-blue-300/20 hover:border-cyan-300/40 hover:bg-cyan-500/10'}`}
                    >
                      <Calendar className="h-3.5 w-3.5 shrink-0 text-blue-300" />
                      <span className="shrink-0 text-slate-400">发布时间</span>
                      <strong className="font-black tabular-nums text-white">
                        {selectedPublishDate.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}
                      </strong>
                      <ChevronDown className={`h-3 w-3 text-cyan-200 transition-transform ${publishPickerOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {publishPickerOpen && (
                      <div className="absolute left-0 top-10 z-[80] w-[min(310px,calc(100vw-24px))] overflow-hidden rounded-2xl border border-cyan-300/30 bg-[linear-gradient(150deg,rgba(8,47,73,0.99),rgba(15,23,42,0.99)_65%)] text-white shadow-2xl shadow-slate-950/70 ring-1 ring-white/5">
                        <div className="flex items-center justify-between border-b border-cyan-300/15 bg-cyan-950/35 px-3.5 py-3">
                          <div className="flex items-center gap-2.5">
                            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-cyan-300/25 bg-gradient-to-br from-cyan-500/25 to-blue-600/20 text-cyan-100 shadow-inner"><Calendar className="h-4 w-4" /></span>
                            <div>
                              <p className="text-xs font-black">设置发布时间</p>
                              <p className="mt-0.5 text-[10px] font-black tabular-nums text-cyan-100/65">
                                {selectedPublishDate.toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                              </p>
                            </div>
                          </div>
                          <button type="button" onClick={() => setPublishPickerOpen(false)} className="flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-slate-300 transition hover:bg-white/10 hover:text-white" aria-label="关闭发布时间选择器"><X className="h-3.5 w-3.5" /></button>
                        </div>

                        <div className="p-3">
                          <div className="grid grid-cols-[1fr_112px] gap-2">
                            <label className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm transition focus-within:border-cyan-400 focus-within:ring-2 focus-within:ring-cyan-400/20">
                              <span className="mb-1 flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-slate-500"><Calendar className="h-3 w-3 text-cyan-600" />日期</span>
                              <input
                                type="date"
                                value={draft.publishAt.split('T')[0]}
                                onChange={event => setDraft(previous => ({ ...previous, publishAt: `${event.target.value}T${previous.publishAt.split('T')[1]?.slice(0, 5) || '00:00'}` }))}
                                className="h-7 w-full bg-transparent text-xs font-black text-slate-900 outline-none [color-scheme:light]"
                              />
                            </label>
                            <label className="rounded-xl border border-slate-200 bg-white p-2 shadow-sm transition focus-within:border-cyan-400 focus-within:ring-2 focus-within:ring-cyan-400/20">
                              <span className="mb-1 flex items-center gap-1 text-[9px] font-black uppercase tracking-wider text-slate-500"><Clock className="h-3 w-3 text-blue-600" />时间</span>
                              <input
                                type="time"
                                value={draft.publishAt.split('T')[1]?.slice(0, 5) || '00:00'}
                                onChange={event => setDraft(previous => ({ ...previous, publishAt: `${previous.publishAt.split('T')[0]}T${event.target.value}` }))}
                                className="h-7 w-full bg-transparent text-xs font-black text-slate-900 outline-none [color-scheme:light]"
                              />
                            </label>
                          </div>

                          <button type="button" onClick={() => setPublishPickerOpen(false)} className="mt-3 flex h-9 w-full items-center justify-center rounded-xl border border-cyan-200/30 bg-gradient-to-r from-cyan-600 to-blue-700 text-[11px] font-black text-white shadow-md shadow-cyan-950/40 transition hover:from-cyan-500 hover:to-blue-600">确认发布时间</button>
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setDraft(previous => ({ ...previous, isPinned: !previous.isPinned }))}
                    aria-pressed={draft.isPinned}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[10px] font-black shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-200/70 ${draft.isPinned ? 'border-amber-200/75 bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-amber-950/45 hover:from-amber-400 hover:to-orange-500' : 'border-amber-300/45 bg-slate-950/65 text-amber-100 hover:border-amber-200/65 hover:bg-amber-950/70'}`}
                  >
                    <Pin className={`h-3.5 w-3.5 ${draft.isPinned ? 'text-white' : 'text-amber-300'}`} />
                    <span>置顶</span>
                    <span className={`rounded-md border px-1.5 py-0.5 leading-none ${draft.isPinned ? 'border-white/30 bg-white/20 text-white' : 'border-amber-300/30 bg-amber-300/10 text-amber-100'}`}>{draft.isPinned ? '已开启' : '已关闭'}</span>
                  </button>
                  {draft.isPinned && (
                    <label className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-300/45 bg-amber-950/65 px-2 text-[10px] font-black text-amber-50 shadow-sm shadow-amber-950/30">
                      <span className="shrink-0 text-amber-100">顺序</span>
                      <input type="number" min="1" max="999" value={draft.pinOrder} onChange={event => setDraft(previous => ({ ...previous, pinOrder: Number(event.target.value) || 999 }))} className="h-6 w-14 rounded-md border border-amber-300/25 bg-white px-1.5 text-center font-black text-slate-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-400/20" aria-label="置顶顺序" />
                    </label>
                  )}
                  {isSuperAdmin && (creatingForAdminId || selectedAdminId) === admin.id && (
                    <button
                      type="button"
                      onClick={() => setDraft(previous => ({ ...previous, isGlobal: !previous.isGlobal }))}
                      aria-pressed={draft.isGlobal}
                      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[10px] font-black shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200/70 ${draft.isGlobal ? 'border-emerald-200/70 bg-gradient-to-r from-emerald-600 to-teal-700 text-white shadow-emerald-950/45 hover:from-emerald-500 hover:to-teal-600' : 'border-rose-300/45 bg-slate-950/65 text-rose-100 hover:border-rose-200/65 hover:bg-rose-950/65'}`}
                    >
                      <Globe className={`h-3.5 w-3.5 ${draft.isGlobal ? 'text-white' : 'text-rose-300'}`} />
                      <span>全局</span>
                      <span className={`rounded-md border px-1.5 py-0.5 leading-none ${draft.isGlobal ? 'border-white/30 bg-white/20 text-white' : 'border-rose-300/30 bg-rose-300/10 text-rose-100'}`}>{draft.isGlobal ? '已开启' : '已关闭'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setDraft(previous => ({ ...previous, isHidden: !previous.isHidden }))}
                    aria-pressed={draft.isHidden}
                    className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[10px] font-black shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-200/70 ${draft.isHidden ? 'border-orange-200/70 bg-gradient-to-r from-orange-600 to-red-700 text-white shadow-red-950/45 hover:from-orange-500 hover:to-red-600' : 'border-slate-400/55 bg-slate-950/65 text-slate-100 hover:border-orange-300/55 hover:bg-slate-800/90'}`}
                  >
                    {draft.isHidden ? <EyeOff className="h-3.5 w-3.5 text-white" /> : <Eye className="h-3.5 w-3.5 text-orange-300" />}
                    <span>隐藏</span>
                    <span className={`rounded-md border px-1.5 py-0.5 leading-none ${draft.isHidden ? 'border-white/30 bg-white/20 text-white' : 'border-slate-400/35 bg-slate-700/70 text-slate-100'}`}>{draft.isHidden ? '已开启' : '已关闭'}</span>
                  </button>
                </div>
              </div>

              <div className="dark-panel-scroll min-h-0 flex-1 overflow-y-auto bg-white xl:overflow-hidden">
                <section className="flex min-h-[520px] flex-col overflow-hidden bg-white xl:h-full xl:min-h-0">
                  <div className="shrink-0 border-b border-slate-200 bg-white px-4 py-3">
                    <label htmlFor="announcement-title" className="mb-1.5 block text-[10px] font-black uppercase tracking-[0.16em] text-cyan-700">公告标题</label>
                    <textarea
                      id="announcement-title"
                      rows={2}
                      value={draft.title}
                      onChange={event => setDraft(previous => ({ ...previous, title: event.target.value }))}
                      placeholder="请输入公告标题"
                      className="announcement-title-scroll h-[50px] max-h-[50px] w-full resize-none overflow-y-auto rounded-lg border border-slate-300 bg-slate-50 px-3 py-1.5 text-sm font-black leading-[18px] text-slate-900 shadow-inner outline-none transition placeholder:font-medium placeholder:text-slate-400 focus:border-cyan-500 focus:bg-white focus:ring-2 focus:ring-cyan-500/20"
                      required
                    />
                  </div>
                  <div className="announcement-editor-content min-h-0 flex-1 bg-white">
                    <TiptapEditor
                      key={`${editorMode}-${editingId || creatingForAdminId || selectedAdminId}`}
                      ref={editorRef}
                      content={draft.content}
                      onChange={content => setDraft(previous => ({ ...previous, content }))}
                      placeholder="开始输入公告内容……"
                      adminId={admin.id}
                      theme="light"
                    />
                  </div>
                </section>
              </div>
            </form>
          ) : selectedAnnouncement ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="relative flex min-h-[132px] shrink-0 flex-wrap items-start justify-between gap-3 overflow-hidden border-b border-cyan-300/20 bg-[radial-gradient(circle_at_top_left,rgba(8,145,178,0.2),transparent_38%),linear-gradient(105deg,rgba(8,47,73,0.88),rgba(15,23,42,0.98)_68%)] px-4 py-3 shadow-lg shadow-slate-950/20 lg:h-[96px] lg:min-h-0 lg:flex-nowrap">
                <div className="pointer-events-none absolute -left-8 -top-12 h-32 w-32 rounded-full bg-cyan-400/10 blur-3xl" />
                <div className="relative flex min-w-[240px] flex-1 flex-col lg:self-stretch">
                  <h2 className="line-clamp-2 h-10 max-w-4xl break-words text-sm font-black leading-5 text-white [text-shadow:0_1px_2px_rgba(0,0,0,0.45)] sm:text-[15px]">{selectedAnnouncement.title}</h2>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 lg:mt-auto">
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-300/20 bg-slate-950/35 px-2 py-1 text-[10px] font-bold text-slate-200">
                      <Users className="h-3 w-3 text-cyan-300" />
                      <span className="text-slate-400">所属管理员</span>
                      <strong className="font-black text-white">{selectedAdminName}</strong>
                    </span>
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-blue-300/20 bg-slate-950/35 px-2 py-1 text-[10px] font-bold text-slate-200">
                      <Calendar className="h-3 w-3 text-blue-300" />
                      <span className="text-slate-400">发布时间</span>
                      <strong className="font-black tabular-nums text-white">{new Date(selectedAnnouncement.publish_at).toLocaleString()}</strong>
                    </span>
                  </div>
                </div>
                <div className="relative flex shrink-0 flex-col items-end gap-2">
                  <div className="flex items-center justify-end gap-1.5">
                    <button type="button" onClick={() => togglePin(selectedAnnouncement)} className={`${actionButtonClass} border-amber-400/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20`} title={selectedAnnouncement.is_pinned ? '取消置顶' : '置顶'}>
                      {selectedAnnouncement.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                    </button>
                    <button type="button" onClick={() => setHiddenConfirmId(selectedAnnouncement.id)} className={`${actionButtonClass} border-orange-400/30 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20`} title={selectedAnnouncement.is_hidden ? '显示公告' : '隐藏公告'}>
                      {selectedAnnouncement.is_hidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                    <button type="button" onClick={() => setShowEmployeePreview(true)} className={`${actionButtonClass} border-violet-400/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20`} title="员工端预览">
                      <Monitor className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" onClick={() => startEdit(selectedAnnouncement)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-cyan-300/35 bg-cyan-600/25 px-2.5 text-[10px] font-black text-cyan-100 transition hover:bg-cyan-500/35">
                      <Edit className="h-3.5 w-3.5" />编辑
                    </button>
                    <button type="button" onClick={() => setDeletingId(selectedAnnouncement.id)} className={`${actionButtonClass} border-red-400/30 bg-red-500/10 text-red-300 hover:bg-red-500/20`} title="删除公告">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {isSuperAdmin && (
                    <button
                      type="button"
                      onClick={() => void toggleGlobal(selectedAnnouncement)}
                      aria-pressed={selectedAnnouncement.is_global}
                      className={`inline-flex h-8 w-[244px] items-center justify-between gap-2 overflow-hidden rounded-lg border px-3 text-white shadow-md transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 ${selectedAnnouncement.is_global ? 'border-emerald-200/60 bg-gradient-to-r from-emerald-600 to-teal-700 shadow-emerald-950/45 hover:from-emerald-500 hover:to-teal-600' : 'border-red-300/55 bg-gradient-to-r from-red-700 to-rose-800 shadow-red-950/45 hover:from-red-600 hover:to-rose-700'}`}
                      title={selectedAnnouncement.is_global ? '点击关闭全局公告' : '点击开启全局公告'}
                    >
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-black">
                        <Globe className="h-4 w-4" />全局管理员显示
                      </span>
                      <span className="shrink-0 text-[11px] font-black">{selectedAnnouncement.is_global ? '已开启' : '已关闭'}</span>
                      <span className="relative h-5 w-9 shrink-0 overflow-hidden rounded-full border border-white/30 bg-slate-950/30 shadow-inner">
                        <span className={`absolute left-0 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-md transition-transform ${selectedAnnouncement.is_global ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                      </span>
                    </button>
                  )}
                </div>
              </div>
              <div className="dark-panel-scroll min-h-0 flex-1 overflow-y-auto bg-white">
                <article className="min-h-full w-full bg-white p-5 text-slate-800 sm:p-8">
                  <div
                    className="announcement-preview prose prose-slate max-w-none text-slate-800"
                    dangerouslySetInnerHTML={{ __html: sanitizeAnnouncementContent(renderMarkdown(selectedAnnouncement.content)) }}
                  />
                </article>
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-[360px] flex-col items-center justify-center px-6 text-center">
              <span className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl border border-cyan-300/20 bg-cyan-400/10 text-cyan-300">
                <LayoutList className="h-7 w-7" />
              </span>
              <h3 className="text-base font-black text-white">选择一则公告开始管理</h3>
              <p className="mt-2 max-w-md text-xs leading-5 text-slate-500">从左侧公告列表选择内容进行预览和编辑，或为当前管理员分组新增公告。</p>
              <button type="button" onClick={() => startCreateForAdmin(selectedAdminId)} className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-cyan-700 px-4 text-xs font-black text-white hover:bg-cyan-600">
                <Plus className="h-4 w-4" />新增公告
              </button>
            </div>
          )}
        </main>
      </div>

      <style>{`
        .announcement-title-scroll {
          scrollbar-width: thin;
          scrollbar-color: rgb(6 182 212) rgb(226 232 240);
        }
        .announcement-title-scroll::-webkit-scrollbar { width: 6px; }
        .announcement-title-scroll::-webkit-scrollbar-track {
          border-radius: 999px;
          background: rgb(226 232 240);
        }
        .announcement-title-scroll::-webkit-scrollbar-thumb {
          border-radius: 999px;
          background: linear-gradient(180deg, rgb(6 182 212), rgb(37 99 235));
        }
        .announcement-editor-content .ProseMirror img {
          display: block;
          margin-left: auto !important;
          margin-right: auto !important;
        }
        .announcement-preview img,
        .announcement-preview video {
          display: block;
          max-width: 100%;
          height: auto;
          margin: 1rem 0;
          border-radius: 0.75rem;
          border: 1px solid rgb(203 213 225);
          background: rgb(248 250 252);
          box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
        }
        .announcement-preview img { margin-left: auto; margin-right: auto; }
        .announcement-preview p { margin: 0.65rem 0; }
        .announcement-preview p:has(img),
        .announcement-preview p:has(video) { margin: 0; }
        .announcement-preview > *:first-child { margin-top: 0; }
        .announcement-preview > *:last-child { margin-bottom: 0; }
        .announcement-preview ol,
        .announcement-preview ul { margin: 0.75rem 0; padding-left: 2rem; list-style-position: outside; }
        .announcement-preview ol { list-style-type: decimal; }
        .announcement-preview ul { list-style-type: disc; }
        .announcement-preview li { margin: 0.25rem 0; padding-left: 0.25rem; }
        .announcement-group-menu {
          scrollbar-width: thin;
          scrollbar-color: rgba(34, 211, 238, 0.62) rgba(8, 47, 73, 0.38);
        }
        .announcement-group-menu::-webkit-scrollbar { width: 7px; }
        .announcement-group-menu::-webkit-scrollbar-track {
          margin: 8px 0;
          border-radius: 999px;
          background: rgba(8, 47, 73, 0.38);
        }
        .announcement-group-menu::-webkit-scrollbar-thumb {
          border: 1px solid rgba(103, 232, 249, 0.22);
          border-radius: 999px;
          background: linear-gradient(180deg, rgba(34, 211, 238, 0.78), rgba(14, 116, 144, 0.78));
        }
        .announcement-group-menu::-webkit-scrollbar-thumb:hover {
          background: linear-gradient(180deg, rgba(103, 232, 249, 0.92), rgba(6, 182, 212, 0.88));
        }
        @keyframes announcement-save-notice {
          from { transform: scaleX(1); }
          to { transform: scaleX(0); }
        }
      `}</style>

      {announcementSuccessMessage && createPortal(
        <div className="pointer-events-none fixed right-4 top-4 z-[100000] w-[min(360px,calc(100vw-32px))]" role="status" aria-live="polite">
          <div className="pointer-events-auto overflow-hidden rounded-2xl border border-emerald-200/55 bg-[linear-gradient(135deg,rgba(5,150,105,0.98),rgba(13,148,136,0.98))] text-white shadow-[0_20px_55px_rgba(2,44,34,0.5)] ring-1 ring-white/15">
            <div className="flex items-center gap-3 px-4 py-3.5">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/25 bg-white/15 shadow-inner">
                <CheckCircle2 className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-black">{announcementSuccessMessage}</p>
                <p className="mt-0.5 text-[10px] font-bold text-emerald-50/80">公告内容和显示设置均已保存</p>
              </div>
              <button type="button" onClick={() => setAnnouncementSuccessMessage(null)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-slate-950/10 text-white/75 transition hover:bg-white/15 hover:text-white" aria-label="关闭保存成功通知">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="h-1 bg-white/15"><div className="h-full w-full origin-left bg-white/65 [animation:announcement-save-notice_3.5s_linear_forwards]" /></div>
          </div>
        </div>,
        document.body,
      )}

      {pinOrderModalId && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md" onClick={() => setPinOrderModalId(null)}>
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="pin-order-title"
            className="w-full max-w-md overflow-hidden rounded-3xl border border-amber-300/35 bg-[radial-gradient(circle_at_top_right,rgba(245,158,11,0.16),transparent_38%),linear-gradient(145deg,rgba(30,41,59,0.99),rgba(15,23,42,0.99)_58%,rgba(69,26,3,0.96))] shadow-[0_28px_90px_rgba(0,0,0,0.72),0_0_36px_rgba(245,158,11,0.12)]"
            onClick={event => event.stopPropagation()}
            onSubmit={event => {
              event.preventDefault();
              void confirmPin();
            }}
          >
            <div className="relative flex items-center justify-between overflow-hidden border-b border-amber-300/20 bg-gradient-to-r from-amber-500/20 via-orange-500/10 to-transparent px-5 py-4">
              <div className="pointer-events-none absolute -left-6 -top-10 h-24 w-24 rounded-full bg-amber-400/15 blur-2xl" />
              <div className="relative flex min-w-0 items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-amber-200/40 bg-gradient-to-br from-amber-400 to-orange-600 text-white shadow-lg shadow-amber-950/40">
                  <Pin className="h-5 w-5 fill-white/20" />
                </span>
                <div className="min-w-0">
                  <h3 id="pin-order-title" className="text-base font-black text-white">设置置顶顺序</h3>
                  <p className="mt-0.5 text-[10px] font-bold text-amber-100/70">调整公告在员工端置顶区域的排列位置</p>
                </div>
              </div>
              <button type="button" onClick={() => setPinOrderModalId(null)} className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-slate-950/30 text-slate-400 transition hover:border-white/20 hover:bg-slate-800 hover:text-white" aria-label="关闭置顶顺序弹窗">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5">
              <div className="rounded-2xl border border-amber-300/15 bg-slate-950/35 px-3.5 py-3">
                <p className="text-[9px] font-black uppercase tracking-[0.18em] text-amber-300/75">即将置顶</p>
                <p className="mt-1.5 line-clamp-2 text-xs font-black leading-5 text-slate-100">
                  {announcements.find(item => item.id === pinOrderModalId)?.title || '当前公告'}
                </p>
              </div>

              <label className="mt-4 block">
                <span className="mb-2 flex items-center justify-between text-[11px] font-black text-slate-100">
                  <span>置顶优先顺序</span>
                  <span className="rounded-lg border border-amber-300/25 bg-amber-500/10 px-2 py-1 text-[9px] text-amber-200">范围 1–999</span>
                </span>
                <div className="relative">
                  <input
                    type="number"
                    min="1"
                    max="999"
                    value={pinOrderValue}
                    onChange={event => setPinOrderValue(Number(event.target.value) || 999)}
                    className="h-14 w-full rounded-2xl border border-amber-300/35 bg-white px-4 pr-16 text-center text-2xl font-black tabular-nums text-slate-900 shadow-[0_10px_28px_rgba(2,6,23,0.28),inset_0_1px_0_rgba(255,255,255,0.9)] outline-none transition focus:border-amber-500 focus:ring-4 focus:ring-amber-400/20"
                    autoFocus
                  />
                  <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 rounded-lg bg-amber-100 px-2 py-1 text-[9px] font-black text-amber-800">顺序</span>
                </div>
              </label>

              <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300/15 bg-amber-500/10 px-3 py-2.5 text-[10px] font-bold leading-4 text-amber-100/80">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
                <p><strong className="text-amber-200">数字越小，优先级越高。</strong>顺序为 1 的公告会显示在所有置顶公告的最前方。</p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 border-t border-white/10 bg-slate-950/25 px-5 py-4">
              <button type="button" onClick={() => setPinOrderModalId(null)} className="h-10 rounded-xl border border-slate-500/45 bg-slate-800/80 text-xs font-black text-slate-200 transition hover:border-slate-400 hover:bg-slate-700 hover:text-white">取消</button>
              <button type="submit" className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-amber-200/35 bg-gradient-to-r from-amber-500 to-orange-600 text-xs font-black text-white shadow-lg shadow-amber-950/35 transition hover:from-amber-400 hover:to-orange-500">
                <Pin className="h-3.5 w-3.5" />确认置顶
              </button>
            </div>
          </form>
        </div>,
        document.body,
      )}

      {hiddenConfirmAnnouncement && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-md" onClick={() => setHiddenConfirmId(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="hidden-announcement-title" className={`w-full max-w-md overflow-hidden rounded-3xl border shadow-[0_28px_90px_rgba(0,0,0,0.72)] ${hiddenConfirmAnnouncement.is_hidden ? 'border-emerald-300/30 bg-[radial-gradient(circle_at_top_right,rgba(16,185,129,0.16),transparent_38%),linear-gradient(145deg,rgba(15,23,42,0.99),rgba(2,44,34,0.97))]' : 'border-orange-300/35 bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.18),transparent_38%),linear-gradient(145deg,rgba(30,41,59,0.99),rgba(67,20,7,0.97))]'}`} onClick={event => event.stopPropagation()}>
            <div className="flex items-start justify-between border-b border-white/10 px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border text-white shadow-lg ${hiddenConfirmAnnouncement.is_hidden ? 'border-emerald-200/35 bg-gradient-to-br from-emerald-500 to-teal-700 shadow-emerald-950/40' : 'border-orange-200/35 bg-gradient-to-br from-orange-500 to-red-700 shadow-orange-950/40'}`}>
                  {hiddenConfirmAnnouncement.is_hidden ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
                </span>
                <div className="min-w-0">
                  <h3 id="hidden-announcement-title" className="text-base font-black text-white">{hiddenConfirmAnnouncement.is_hidden ? '恢复显示这则公告？' : '确认隐藏这则公告？'}</h3>
                  <p className={`mt-1 text-[10px] font-bold ${hiddenConfirmAnnouncement.is_hidden ? 'text-emerald-100/70' : 'text-orange-100/70'}`}>{hiddenConfirmAnnouncement.is_hidden ? '恢复后员工可再次查看此公告' : '隐藏后员工端将立即停止显示'}</p>
                </div>
              </div>
              <button type="button" onClick={() => setHiddenConfirmId(null)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-slate-950/30 text-slate-400 transition hover:bg-slate-800 hover:text-white" aria-label="关闭隐藏确认弹窗"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-5">
              <div className="rounded-2xl border border-white/10 bg-slate-950/35 px-3.5 py-3">
                <p className="text-[9px] font-black uppercase tracking-[0.18em] text-slate-400">操作公告</p>
                <p className="mt-1.5 line-clamp-2 text-xs font-black leading-5 text-white">{hiddenConfirmAnnouncement.title}</p>
              </div>
              <div className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-3 text-[11px] font-bold leading-5 ${hiddenConfirmAnnouncement.is_hidden ? 'border-emerald-300/20 bg-emerald-500/10 text-emerald-100/85' : 'border-orange-300/20 bg-orange-500/10 text-orange-100/85'}`}>
                <AlertCircle className={`mt-0.5 h-4 w-4 shrink-0 ${hiddenConfirmAnnouncement.is_hidden ? 'text-emerald-300' : 'text-orange-300'}`} />
                <p>{hiddenConfirmAnnouncement.is_hidden ? '恢复显示不会修改公告内容、置顶顺序或发布时间。' : '此操作不会删除公告内容，之后可随时从隐藏列表中恢复显示。'}</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-white/10 bg-slate-950/25 px-5 py-4">
              <button type="button" onClick={() => setHiddenConfirmId(null)} className="h-10 rounded-xl border border-slate-500/45 bg-slate-800/80 text-xs font-black text-slate-200 transition hover:bg-slate-700 hover:text-white">取消</button>
              <button type="button" onClick={() => { setHiddenConfirmId(null); void toggleHidden(hiddenConfirmAnnouncement); }} className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border text-xs font-black text-white shadow-lg transition ${hiddenConfirmAnnouncement.is_hidden ? 'border-emerald-200/35 bg-gradient-to-r from-emerald-500 to-teal-700 shadow-emerald-950/35 hover:from-emerald-400 hover:to-teal-600' : 'border-orange-200/35 bg-gradient-to-r from-orange-500 to-red-700 shadow-orange-950/35 hover:from-orange-400 hover:to-red-600'}`}>
                {hiddenConfirmAnnouncement.is_hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                {hiddenConfirmAnnouncement.is_hidden ? '恢复显示' : '确认隐藏'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {deletingAnnouncement && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-md" onClick={() => setDeletingId(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-announcement-title" className="w-full max-w-md overflow-hidden rounded-3xl border border-red-300/35 bg-[radial-gradient(circle_at_top_right,rgba(239,68,68,0.2),transparent_38%),linear-gradient(145deg,rgba(30,41,59,0.99),rgba(69,10,10,0.98))] shadow-[0_28px_90px_rgba(0,0,0,0.75),0_0_38px_rgba(239,68,68,0.1)]" onClick={event => event.stopPropagation()}>
            <div className="flex items-start justify-between border-b border-red-300/15 px-5 py-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-red-200/35 bg-gradient-to-br from-red-500 to-rose-800 text-white shadow-lg shadow-red-950/45"><Trash2 className="h-5 w-5" /></span>
                <div className="min-w-0">
                  <h3 id="delete-announcement-title" className="text-base font-black text-white">永久删除这则公告？</h3>
                  <p className="mt-1 text-[10px] font-bold text-red-100/70">此操作无法撤销或恢复</p>
                </div>
              </div>
              <button type="button" onClick={() => setDeletingId(null)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-slate-950/30 text-slate-400 transition hover:bg-slate-800 hover:text-white" aria-label="关闭删除确认弹窗"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-5">
              <div className="rounded-2xl border border-red-300/15 bg-slate-950/35 px-3.5 py-3">
                <p className="text-[9px] font-black uppercase tracking-[0.18em] text-red-300/70">即将删除</p>
                <p className="mt-1.5 line-clamp-2 text-xs font-black leading-5 text-white">{deletingAnnouncement.title}</p>
              </div>
              <div className="mt-3 rounded-xl border border-red-300/20 bg-red-500/10 px-3 py-3">
                <div className="flex items-start gap-2 text-[11px] font-bold leading-5 text-red-100/90">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-300" />
                  <div><p className="font-black text-red-200">删除后将同时清理：</p><ul className="mt-1 list-inside list-disc space-y-0.5 text-red-100/75"><li>公告标题、正文及所有状态设置</li><li>正文关联的图片与媒体文件</li><li>员工端当前可访问的公告内容</li></ul></div>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 border-t border-white/10 bg-slate-950/25 px-5 py-4">
              <button type="button" onClick={() => setDeletingId(null)} className="h-10 rounded-xl border border-slate-500/45 bg-slate-800/80 text-xs font-black text-slate-200 transition hover:bg-slate-700 hover:text-white">保留公告</button>
              <button type="button" onClick={() => void deleteAnnouncement(deletingAnnouncement.id)} className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-red-200/35 bg-gradient-to-r from-red-600 to-rose-800 text-xs font-black text-white shadow-lg shadow-red-950/40 transition hover:from-red-500 hover:to-rose-700"><Trash2 className="h-3.5 w-3.5" />确认永久删除</button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {pendingNavigation && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md">
          <div role="dialog" aria-modal="true" aria-labelledby="discard-title" className="w-full max-w-sm rounded-2xl border border-amber-400/30 bg-slate-900 p-6 shadow-2xl">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-amber-400/30 bg-amber-500/15 text-amber-300"><AlertCircle className="h-5 w-5" /></span>
            <h3 id="discard-title" className="mt-4 text-base font-black text-white">放弃未保存的修改？</h3>
            <p className="mt-2 text-xs leading-5 text-slate-400">当前公告内容尚未保存，离开后这些修改将会丢失。</p>
            <div className="mt-5 flex gap-2">
              <button type="button" onClick={() => setPendingNavigation(null)} className="flex-1 rounded-lg bg-slate-700 px-4 py-2.5 text-xs font-bold text-white hover:bg-slate-600">继续编辑</button>
              <button type="button" onClick={() => { const action = pendingNavigation; setPendingNavigation(null); action(); }} className="flex-1 rounded-lg bg-amber-600 px-4 py-2.5 text-xs font-black text-white hover:bg-amber-500">放弃修改</button>
            </div>
          </div>
        </div>,
        document.body,
      )}


      {showEmployeePreview && (
        <AnnouncementDetailModal
          title={workspaceMode === 'edit' ? draft.title || '未命名公告' : selectedAnnouncement?.title || '未命名公告'}
          content={workspaceMode === 'edit' ? draft.content : selectedAnnouncement?.content || ''}
          publishAt={workspaceMode === 'edit' ? draft.publishAt : selectedAnnouncement?.publish_at || new Date().toISOString()}
          isPinned={workspaceMode === 'edit' ? draft.isPinned : selectedAnnouncement?.is_pinned || false}
          onClose={() => setShowEmployeePreview(false)}
          pinnedLabel="置顶"
          closeLabel="关闭"
        />
      )}
    </div>
  );
}
