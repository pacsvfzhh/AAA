import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, Zap, MessageSquarePlus, Megaphone, BookOpen, X, Bold, Underline, Strikethrough, AlignLeft, AlignCenter, AlignRight, Palette, Image, Pencil, Power } from 'lucide-react';
import TiptapEditor, { TiptapEditorRef } from './TiptapEditor';
import { supabase } from '../../lib/supabase';
import { processContentImages } from '../../lib/imageOptimizer';
import { mutateAuditedContent } from '../../lib/contentAudit';

export interface AutoMessage {
  id: string;
  customer_id: string;
  admin_id: string;
  message_type: 'quick_send' | 'rich_card';
  name: string;
  title: string | null;
  subtitle: string | null;
  content: string;
  content_type: 'text' | 'richtext' | 'rich_card';
  sort_order: number;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface AutoMessageDraft {
  id: string;
  message_type: 'quick_send' | 'rich_card';
  name: string;
  title: string | null;
  subtitle: string | null;
  content: string;
  content_type: 'text' | 'richtext' | 'rich_card';
  sort_order: number;
  is_enabled: boolean;
}

interface CustomerAutoMessagesProps {
  customerId: string | null;
  adminId: string;
  sourceType: string;
  draftMessages?: AutoMessageDraft[];
  draftMasterEnabled?: boolean;
  onDraftMessagesChange?: (messages: AutoMessageDraft[]) => void;
  onDraftMasterEnabledChange?: (enabled: boolean) => void;
}

const BG_COLORS = [
  { color: '#fef3c7', label: '黃色' }, { color: '#fee2e2', label: '紅色' },
  { color: '#dbeafe', label: '藍色' }, { color: '#d1fae5', label: '綠色' },
  { color: '#f3e8ff', label: '紫色' }, { color: '#fce7f3', label: '粉紅色' },
  { color: '#e0e7ff', label: '靛色' }, { color: '#ccfbf1', label: '青綠色' },
];

const TEXT_COLORS = [
  { color: '#000000', label: '黑色' }, { color: '#dc2626', label: '紅色' },
  { color: '#2563eb', label: '藍色' }, { color: '#16a34a', label: '綠色' },
  { color: '#d97706', label: '橙色' }, { color: '#7c3aed', label: '紫色' },
  { color: '#be185d', label: '粉紅色' }, { color: '#64748b', label: '灰色' },
];

export default function CustomerAutoMessages({
  customerId,
  adminId,
  draftMessages = [],
  draftMasterEnabled = false,
  onDraftMessagesChange,
  onDraftMasterEnabledChange,
}: CustomerAutoMessagesProps) {
  const [autoMessages, setAutoMessages] = useState<AutoMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [masterEnabled, setMasterEnabled] = useState(false);
  const visibleMessages = customerId ? autoMessages : draftMessages;
  const [togglingMaster, setTogglingMaster] = useState(false);

  // Modal state
  const [showQuickSendModal, setShowQuickSendModal] = useState(false);
  const [showRichCardModal, setShowRichCardModal] = useState(false);
  const [editingMsg, setEditingMsg] = useState<AutoMessage | AutoMessageDraft | null>(null);

  // Quick send editor
  const qsEditorRef = useRef<HTMLDivElement>(null);
  const qsImageInputRef = useRef<HTMLInputElement>(null);
  const [qsName, setQsName] = useState('');
  const [qsBoldActive, setQsBoldActive] = useState(false);
  const [qsUnderlineActive, setQsUnderlineActive] = useState(false);
  const [qsStrikethroughActive, setQsStrikethroughActive] = useState(false);
  const [qsFontSize, setQsFontSize] = useState<string | null>(null);
  const [qsAlign, setQsAlign] = useState<'left' | 'center' | 'right'>('left');
  const [qsShowBgColor, setQsShowBgColor] = useState(false);
  const [qsShowTextColor, setQsShowTextColor] = useState(false);
  const [uploadingQsImage, setUploadingQsImage] = useState(false);

  // Rich card editor
  const rcEditorRef = useRef<TiptapEditorRef>(null);
  const [rcName, setRcName] = useState('');
  const [rcTitle, setRcTitle] = useState('');
  const [rcSubtitle, setRcSubtitle] = useState('');
  const [rcContent, setRcContent] = useState('');

  const loadAutoMessages = useCallback(async () => {
    if (!customerId) {
      setAutoMessages([]);
      setMasterEnabled(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    const [{ data: msgs }, { data: cust }] = await Promise.all([
      supabase.from('customer_auto_messages').select('*').eq('customer_id', customerId).order('sort_order', { ascending: true }),
      supabase.from('simulated_customers').select('auto_messages_enabled').eq('id', customerId).maybeSingle(),
    ]);
    setAutoMessages(msgs || []);
    setMasterEnabled(cust?.auto_messages_enabled ?? false);
    setLoading(false);
  }, [customerId]);

  useEffect(() => { loadAutoMessages(); }, [loadAutoMessages]);

  useEffect(() => {
    if (!customerId) setMasterEnabled(draftMasterEnabled);
  }, [customerId, draftMasterEnabled]);

  const toggleMaster = async () => {
    const newVal = !masterEnabled;
    if (!customerId) {
      setMasterEnabled(newVal);
      onDraftMasterEnabledChange?.(newVal);
      return;
    }
    setTogglingMaster(true);
    await supabase.from('simulated_customers').update({ auto_messages_enabled: newVal }).eq('id', customerId);
    setMasterEnabled(newVal);
    setTogglingMaster(false);
  };

  const resetQuickSend = () => {
    setQsName(''); setQsBoldActive(false); setQsUnderlineActive(false); setQsStrikethroughActive(false);
    setQsFontSize(null); setQsAlign('left'); setQsShowBgColor(false); setQsShowTextColor(false);
    if (qsEditorRef.current) qsEditorRef.current.innerHTML = '';
    setEditingMsg(null);
  };

  const resetRichCard = () => {
    setRcName(''); setRcTitle(''); setRcSubtitle(''); setRcContent('');
    const rce = rcEditorRef.current?.getEditor();
    if (rce) rce.commands.setContent('');
    setEditingMsg(null);
  };

  const openQuickSendModal = (msg?: AutoMessage | AutoMessageDraft) => {
    resetQuickSend();
    if (msg) {
      setEditingMsg(msg);
      setQsName(msg.name);
      setTimeout(() => { if (qsEditorRef.current) qsEditorRef.current.innerHTML = msg.content; }, 50);
    }
    setShowQuickSendModal(true);
  };

  const openRichCardModal = (msg?: AutoMessage | AutoMessageDraft) => {
    resetRichCard();
    if (msg) {
      setEditingMsg(msg);
      setRcName(msg.name);
      setRcTitle(msg.title || '');
      setRcSubtitle(msg.subtitle || '');
      setRcContent(msg.content);
      setTimeout(() => { const rce = rcEditorRef.current?.getEditor(); if (rce) rce.commands.setContent(msg.content); }, 100);
    }
    setShowRichCardModal(true);
  };

  const handleSaveQuickSend = async () => {
    const rawContent = qsEditorRef.current?.innerHTML || '';
    if (!qsName.trim() || !rawContent.trim()) return;
    setSaving(true);
    const content = await processContentImages(rawContent, 'auto-messages');
    const sortOrder = editingMsg ? editingMsg.sort_order : visibleMessages.length;

    if (!customerId) {
      const draft: AutoMessageDraft = {
        id: editingMsg?.id || crypto.randomUUID(),
        message_type: 'quick_send',
        name: qsName.trim(),
        title: null,
        subtitle: null,
        content,
        content_type: 'richtext',
        sort_order: sortOrder,
        is_enabled: editingMsg?.is_enabled ?? true,
      };
      onDraftMessagesChange?.(
        editingMsg
          ? draftMessages.map(message => message.id === editingMsg.id ? draft : message)
          : [...draftMessages, draft],
      );
    } else {
      const payload = {
        customer_id: customerId, admin_id: adminId, message_type: 'quick_send' as const,
        name: qsName.trim(), title: null, subtitle: null, content, content_type: 'richtext' as const,
        sort_order: sortOrder, is_enabled: true,
      };
      if (editingMsg) {
        await mutateAuditedContent('auto_edit', [editingMsg.id], payload);
      } else {
        await supabase.from('customer_auto_messages').insert(payload);
      }
    }
    setSaving(false); setShowQuickSendModal(false); resetQuickSend();
    if (customerId) loadAutoMessages();
  };

  const handleSaveRichCard = async () => {
    const rawContent = rcEditorRef.current?.getContent() || rcContent || '';
    if (!rcName.trim() || !rawContent.trim()) return;
    setSaving(true);
    const content = await processContentImages(rawContent, 'rich-cards');
    const sortOrder = editingMsg ? editingMsg.sort_order : visibleMessages.length;

    if (!customerId) {
      const draft: AutoMessageDraft = {
        id: editingMsg?.id || crypto.randomUUID(),
        message_type: 'rich_card',
        name: rcName.trim(),
        title: rcTitle.trim() || null,
        subtitle: rcSubtitle.trim() || null,
        content,
        content_type: 'rich_card',
        sort_order: sortOrder,
        is_enabled: editingMsg?.is_enabled ?? true,
      };
      onDraftMessagesChange?.(
        editingMsg
          ? draftMessages.map(message => message.id === editingMsg.id ? draft : message)
          : [...draftMessages, draft],
      );
    } else {
      const payload = {
        customer_id: customerId, admin_id: adminId, message_type: 'rich_card' as const,
        name: rcName.trim(), title: rcTitle.trim() || null, subtitle: rcSubtitle.trim() || null,
        content, content_type: 'rich_card' as const,
        sort_order: sortOrder, is_enabled: true,
      };
      if (editingMsg) {
        await mutateAuditedContent('auto_edit', [editingMsg.id], payload);
      } else {
        await supabase.from('customer_auto_messages').insert(payload);
      }
    }
    setSaving(false); setShowRichCardModal(false); resetRichCard();
    if (customerId) loadAutoMessages();
  };

  const handleToggleEnabled = async (id: string, currentEnabled: boolean) => {
    if (!customerId) {
      onDraftMessagesChange?.(draftMessages.map(message =>
        message.id === id ? { ...message, is_enabled: !currentEnabled } : message,
      ));
      return;
    }
    setAutoMessages(prev => prev.map(m => m.id === id ? { ...m, is_enabled: !currentEnabled } : m));
    await supabase.from('customer_auto_messages').update({ is_enabled: !currentEnabled, updated_at: new Date().toISOString() }).eq('id', id);
  };

  const handleDelete = async (id: string) => {
    if (!customerId) {
      onDraftMessagesChange?.(draftMessages.filter(message => message.id !== id));
      return;
    }
    await mutateAuditedContent('auto_delete', [id]);
    loadAutoMessages();
  };

  const stripHtmlToText = (html: string): string => {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || '';
  };

  const handleMoveUp = async (msgId: string) => {
    const enabled = visibleMessages.filter(m => m.is_enabled).sort((a, b) => a.sort_order - b.sort_order);
    const idx = enabled.findIndex(m => m.id === msgId);
    if (idx <= 0) return;
    const prev = enabled[idx - 1];
    const curr = enabled[idx];
    const prevOrder = prev.sort_order;
    const currOrder = curr.sort_order;
    if (!customerId) {
      onDraftMessagesChange?.(draftMessages.map(message =>
        message.id === curr.id ? { ...message, sort_order: prevOrder } :
        message.id === prev.id ? { ...message, sort_order: currOrder } : message,
      ));
      return;
    }
    setAutoMessages(ms => ms.map(m =>
      m.id === curr.id ? { ...m, sort_order: prevOrder } :
      m.id === prev.id ? { ...m, sort_order: currOrder } : m
    ));
    await Promise.all([
      supabase.from('customer_auto_messages').update({ sort_order: prevOrder }).eq('id', curr.id),
      supabase.from('customer_auto_messages').update({ sort_order: currOrder }).eq('id', prev.id),
    ]);
  };

  const handleMoveDown = async (msgId: string) => {
    const enabled = visibleMessages.filter(m => m.is_enabled).sort((a, b) => a.sort_order - b.sort_order);
    const idx = enabled.findIndex(m => m.id === msgId);
    if (idx < 0 || idx >= enabled.length - 1) return;
    const curr = enabled[idx];
    const next = enabled[idx + 1];
    const currOrder = curr.sort_order;
    const nextOrder = next.sort_order;
    if (!customerId) {
      onDraftMessagesChange?.(draftMessages.map(message =>
        message.id === curr.id ? { ...message, sort_order: nextOrder } :
        message.id === next.id ? { ...message, sort_order: currOrder } : message,
      ));
      return;
    }
    setAutoMessages(ms => ms.map(m =>
      m.id === curr.id ? { ...m, sort_order: nextOrder } :
      m.id === next.id ? { ...m, sort_order: currOrder } : m
    ));
    await Promise.all([
      supabase.from('customer_auto_messages').update({ sort_order: nextOrder }).eq('id', curr.id),
      supabase.from('customer_auto_messages').update({ sort_order: currOrder }).eq('id', next.id),
    ]);
  };

  const execQsCommand = (cmd: string, value?: string) => {
    const trackedCommand = cmd === 'bold' || cmd === 'underline' || cmd === 'strikeThrough';
    qsEditorRef.current?.focus();
    const wasActive = trackedCommand ? document.queryCommandState(cmd) : false;
    document.execCommand(cmd, false, value);

    if (cmd === 'bold') setQsBoldActive(!wasActive);
    if (cmd === 'underline') setQsUnderlineActive(!wasActive);
    if (cmd === 'strikeThrough') setQsStrikethroughActive(!wasActive);
  };
  const updateQsToolbar = () => {
    setQsBoldActive(document.queryCommandState('bold'));
    setQsUnderlineActive(document.queryCommandState('underline'));
    setQsStrikethroughActive(document.queryCommandState('strikethrough'));
  };

  const handleQsImageUpload = async (file: File) => {
    if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) return;
    setUploadingQsImage(true);
    const fileName = `auto_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${file.name.split('.').pop()}`;
    const { error } = await supabase.storage.from('chat-images').upload(fileName, file);
    if (!error) {
      const { data: urlData } = supabase.storage.from('chat-images').getPublicUrl(fileName);
      if (urlData?.publicUrl && qsEditorRef.current) {
        qsEditorRef.current.focus();
        document.execCommand('insertImage', false, urlData.publicUrl);
      }
    }
    setUploadingQsImage(false);
  };

  const handleEditClick = (msg: AutoMessage | AutoMessageDraft) => {
    if (msg.message_type === 'rich_card') openRichCardModal(msg);
    else openQuickSendModal(msg);
  };

  // ---- Quick Send Modal ----
  const quickSendModal = showQuickSendModal && createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[10000] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowQuickSendModal(false); resetQuickSend(); } }}>
      <div onClick={(e) => e.stopPropagation()} className="bg-slate-900 rounded-2xl border border-slate-700/50 w-full max-w-5xl h-[85vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700/50 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-teal-600/20"><BookOpen className="w-4 h-4 text-teal-400" /></div>
            <h3 className="text-sm font-bold text-white">{editingMsg ? '編輯' : '新增'}快速傳送自動訊息</h3>
          </div>
          <button onClick={() => { setShowQuickSendModal(false); resetQuickSend(); }} className="p-1.5 hover:bg-slate-800 rounded-lg transition-colors"><X className="w-4 h-4 text-slate-400" /></button>
        </div>
        <div className="flex-1 flex flex-col p-4 gap-3 min-h-0 overflow-hidden">
          <div className="flex items-center gap-3 flex-shrink-0">
            <h4 className="text-sm font-bold text-white flex items-center gap-2 whitespace-nowrap">
              {editingMsg ? <Pencil className="w-3.5 h-3.5 text-blue-400" /> : <Plus className="w-3.5 h-3.5 text-teal-400" />}
              {editingMsg ? '編輯訊息' : '新增訊息'}
            </h4>
            <input type="text" value={qsName} onChange={(e) => setQsName(e.target.value)}
              className="flex-1 min-w-0 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-slate-400 shadow-sm"
              placeholder="訊息名稱（例如：歡迎訊息、問候、促銷……）" />
          </div>
          <div className="flex-1 min-h-0 rounded-xl border border-slate-300 bg-white overflow-hidden focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400/40 transition-all shadow-sm flex flex-col">
            <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-slate-200 bg-slate-50/80 flex-shrink-0 flex-wrap">
              <button type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('bold'); }} className={`p-1.5 rounded-md transition-all ${qsBoldActive ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-200'}`}><Bold className="w-3.5 h-3.5" strokeWidth={2.5} /></button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('underline'); }} className={`p-1.5 rounded-md transition-all ${qsUnderlineActive ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-200'}`}><Underline className="w-3.5 h-3.5" strokeWidth={2.5} /></button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('strikeThrough'); }} className={`p-1.5 rounded-md transition-all ${qsStrikethroughActive ? 'bg-blue-500 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-200'}`}><Strikethrough className="w-3.5 h-3.5" strokeWidth={2.5} /></button>
              <div className="w-px h-5 bg-slate-200 mx-1" />
              <div className="flex items-center bg-slate-100 rounded-md p-0.5 gap-0.5">
                <button type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('fontSize', '3'); setQsFontSize(qsFontSize === 'normal' ? null : 'normal'); }} className={`px-1.5 py-0.5 text-[10px] rounded transition-all ${qsFontSize === 'normal' ? 'bg-blue-500 text-white font-bold' : 'text-slate-400 font-semibold hover:bg-slate-200'}`}>A</button>
                <button type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('fontSize', '5'); setQsFontSize(qsFontSize === 'large' ? null : 'large'); }} className={`px-1.5 py-0.5 text-xs rounded transition-all ${qsFontSize === 'large' ? 'bg-blue-500 text-white font-bold' : 'text-slate-400 font-semibold hover:bg-slate-200'}`}>A</button>
                <button type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('fontSize', '7'); setQsFontSize(qsFontSize === 'xlarge' ? null : 'xlarge'); }} className={`px-1.5 py-0.5 text-sm rounded transition-all ${qsFontSize === 'xlarge' ? 'bg-blue-500 text-white font-bold' : 'text-slate-400 font-bold hover:bg-slate-200'}`}>A</button>
              </div>
              <div className="w-px h-5 bg-slate-200 mx-1" />
              <button type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('justifyLeft'); setQsAlign('left'); }} className={`p-1.5 rounded-md transition-all ${qsAlign === 'left' ? 'bg-blue-500 text-white' : 'text-slate-500 hover:bg-slate-200'}`}><AlignLeft className="w-3.5 h-3.5" /></button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('justifyCenter'); setQsAlign('center'); }} className={`p-1.5 rounded-md transition-all ${qsAlign === 'center' ? 'bg-blue-500 text-white' : 'text-slate-500 hover:bg-slate-200'}`}><AlignCenter className="w-3.5 h-3.5" /></button>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('justifyRight'); setQsAlign('right'); }} className={`p-1.5 rounded-md transition-all ${qsAlign === 'right' ? 'bg-blue-500 text-white' : 'text-slate-500 hover:bg-slate-200'}`}><AlignRight className="w-3.5 h-3.5" /></button>
              <div className="w-px h-5 bg-slate-200 mx-1" />
              <div className="relative">
                <button type="button" onClick={() => { setQsShowTextColor(!qsShowTextColor); setQsShowBgColor(false); }} className="p-1.5 rounded-md text-slate-500 hover:bg-slate-200 transition-all"><span className="text-xs font-bold">A</span></button>
                {qsShowTextColor && (<><div className="fixed inset-0 z-[60]" onMouseDown={() => setQsShowTextColor(false)} /><div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-[61] p-2 grid grid-cols-4 gap-1.5 w-[140px]">
                  {TEXT_COLORS.map((c) => (<button key={c.color} type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('foreColor', c.color); setQsShowTextColor(false); }} className="w-7 h-7 rounded-md border border-slate-600 hover:scale-110 transition-transform flex items-center justify-center" title={c.label}><span className="text-sm font-black" style={{ color: c.color }}>A</span></button>))}
                </div></>)}
              </div>
              <div className="relative">
                <button type="button" onClick={() => { setQsShowBgColor(!qsShowBgColor); setQsShowTextColor(false); }} className="p-1.5 rounded-md text-slate-500 hover:bg-slate-200 transition-all"><Palette className="w-3.5 h-3.5" /></button>
                {qsShowBgColor && (<><div className="fixed inset-0 z-[60]" onMouseDown={() => setQsShowBgColor(false)} /><div className="absolute top-full left-0 mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl z-[61] p-2 grid grid-cols-4 gap-1.5 w-[140px]">
                  <button type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('removeFormat'); setQsShowBgColor(false); }} className="w-7 h-7 rounded-md border border-slate-500 bg-transparent flex items-center justify-center hover:scale-110 transition-transform"><X className="w-3.5 h-3.5 text-slate-400" /></button>
                  {BG_COLORS.map(c => (<button key={c.color} type="button" onMouseDown={(e) => { e.preventDefault(); execQsCommand('hiliteColor', c.color); setQsShowBgColor(false); }} className="w-7 h-7 rounded-md border border-slate-600 hover:scale-110 transition-transform" style={{ backgroundColor: c.color }} title={c.label} />))}
                </div></>)}
              </div>
              <div className="w-px h-5 bg-slate-200 mx-1" />
              <input ref={qsImageInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleQsImageUpload(f); e.target.value = ''; }} />
              <button type="button" onClick={() => qsImageInputRef.current?.click()} disabled={uploadingQsImage} className={`p-1.5 rounded-md transition-all ${uploadingQsImage ? 'opacity-50' : 'text-slate-500 hover:bg-slate-200'}`}><Image className="w-3.5 h-3.5" /></button>
            </div>
            <div ref={qsEditorRef} contentEditable suppressContentEditableWarning
              onInput={() => updateQsToolbar()} onKeyUp={() => updateQsToolbar()} onMouseUp={() => updateQsToolbar()}
              className="flex-1 min-h-0 overflow-y-auto p-4 text-sm text-gray-900 focus:outline-none scrollbar-thin [&_img]:max-w-full [&_img]:rounded-lg [&_img]:my-1"
              style={{ lineHeight: '1.7' }} />
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-700/50 flex-shrink-0">
          <button type="button" onClick={() => { setShowQuickSendModal(false); resetQuickSend(); }} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-all">取消</button>
          <button type="button" onClick={handleSaveQuickSend} disabled={saving || !qsName.trim()}
            className="px-6 py-2 bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-700 hover:to-cyan-700 text-white rounded-lg text-sm font-medium transition-all disabled:opacity-50 shadow-lg shadow-teal-500/20">
            {saving ? '儲存中……' : editingMsg ? '更新訊息' : '新增訊息'}
          </button>
        </div>
      </div>
    </div>, document.body
  );

  // ---- Rich Card Modal ----
  const richCardModal = showRichCardModal && createPortal(
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[10000] p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) { setShowRichCardModal(false); resetRichCard(); } }}>
      <div onClick={(e) => e.stopPropagation()} className="bg-slate-900 rounded-2xl border border-slate-700/50 w-full max-w-[90vw] h-[85vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700/50 flex-shrink-0">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-blue-600/20"><Megaphone className="w-4 h-4 text-blue-400" /></div>
            <h3 className="text-sm font-bold text-white">{editingMsg ? '編輯' : '新增'} Rich Card 自動訊息</h3>
          </div>
          <button onClick={() => { setShowRichCardModal(false); resetRichCard(); }} className="p-1.5 hover:bg-slate-800 rounded-lg transition-colors"><X className="w-4 h-4 text-slate-400" /></button>
        </div>
        <div className="flex-1 flex flex-col p-4 gap-3 min-h-0 overflow-hidden">
          <div className="flex items-center gap-3 flex-shrink-0">
            <h4 className="text-sm font-bold text-white flex items-center gap-2 whitespace-nowrap">
              {editingMsg ? <Pencil className="w-3.5 h-3.5 text-blue-400" /> : <Plus className="w-3.5 h-3.5 text-blue-400" />}
              {editingMsg ? '編輯卡片' : '新增卡片'}
            </h4>
            <input type="text" value={rcName} onChange={(e) => setRcName(e.target.value)}
              className="flex-1 min-w-0 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-slate-800 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder:text-slate-400 shadow-sm"
              placeholder="卡片名稱（例如：歡迎卡片、促銷……）" />
          </div>
          <div className="flex flex-row gap-3 items-center bg-blue-500 rounded-t-xl px-3 py-2 flex-shrink-0">
            <Megaphone className="w-4 h-4 text-white/80 flex-shrink-0" />
            <input type="text" value={rcTitle} onChange={(e) => setRcTitle(e.target.value)}
              className="flex-1 bg-white text-slate-800 text-sm font-semibold placeholder:text-slate-400 focus:outline-none rounded px-2.5 py-1.5 shadow-sm"
              placeholder="主要標題（例如：重要通知）……" />
            <input type="text" value={rcSubtitle} onChange={(e) => setRcSubtitle(e.target.value)}
              className="flex-1 bg-white/90 text-slate-600 text-xs placeholder:text-slate-400 focus:outline-none rounded px-2.5 py-1.5 shadow-sm"
              placeholder="副標題（選填）……" />
          </div>
          <div className="flex-1 min-h-0 rounded-b-xl border border-t-0 border-slate-300 bg-white overflow-hidden shadow-sm flex flex-col focus-within:border-blue-400 focus-within:ring-1 focus-within:ring-blue-400/40 transition-all">
            <div className="flex-1 min-h-0 overflow-hidden">
              <TiptapEditor ref={rcEditorRef} content={rcContent} onChange={setRcContent}
                placeholder="撰寫 Rich Card 內容（圖片、格式、標題）……" adminId={adminId} theme="light" />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-slate-700/50 flex-shrink-0">
          <button type="button" onClick={() => { setShowRichCardModal(false); resetRichCard(); }} className="px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-all">取消</button>
          <button type="button" onClick={handleSaveRichCard} disabled={saving || !rcName.trim()}
            className="px-6 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-lg text-sm font-medium transition-all disabled:opacity-50 shadow-lg shadow-blue-500/20">
            {saving ? '儲存中……' : editingMsg ? '更新卡片' : '新增卡片'}
          </button>
        </div>
      </div>
    </div>, document.body
  );

  // ---- Panel ----
  return (
    <>
      <div className="min-w-0 p-3 bg-slate-900 border border-slate-700 rounded-xl flex flex-col">
        {/* Header with toggle */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-bold text-slate-100">自動訊息</span>
          </div>
          {(customerId || onDraftMasterEnabledChange) && (
            <button
              type="button"
              onClick={toggleMaster}
              disabled={togglingMaster}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none flex-shrink-0 ${masterEnabled ? 'bg-emerald-500' : 'bg-slate-600'}`}
            >
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${masterEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
            </button>
          )}
        </div>

        <>
            {!customerId && (
              <p className="mb-2 text-[10px] italic text-slate-500">
                現在新增的訊息會在建立客戶時一併儲存。
              </p>
            )}
            {/* Status indicator */}
            <div className={`flex items-center gap-1.5 mb-2.5 px-2 py-1 rounded-lg text-[10px] font-semibold ${masterEnabled ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-slate-700/50 text-slate-400 border border-slate-600/30'}`}>
              <Power className="w-3 h-3" />
              <span>{masterEnabled ? '自動傳送已開啟——員工開啟聊天時會自動傳送訊息' : '自動傳送已關閉——不會傳送訊息'}</span>
            </div>

            {/* Add buttons */}
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              <button type="button" onClick={() => openQuickSendModal()}
                className="flex items-center gap-1.5 px-2.5 py-2 bg-teal-700 hover:bg-teal-600 rounded-lg transition-all text-left">
                <MessageSquarePlus className="w-3.5 h-3.5 text-teal-200 flex-shrink-0" />
                <span className="text-[11px] font-medium text-white">+ 快速傳送</span>
              </button>
              <button type="button" onClick={() => openRichCardModal()}
                className="flex items-center gap-1.5 px-2.5 py-2 bg-sky-700 hover:bg-sky-600 rounded-lg transition-all text-left">
                <Megaphone className="w-3.5 h-3.5 text-sky-200 flex-shrink-0" />
                <span className="text-[11px] font-medium text-white">+ Rich Card</span>
              </button>
            </div>

            {/* Message list */}
            <div className="flex-1 min-h-0 overflow-y-auto space-y-2 scrollbar-thin" style={{ maxHeight: '400px' }}>
              {loading ? (
                <div className="flex items-center justify-center py-8">
                  <div className="w-5 h-5 border-2 border-amber-400 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : visibleMessages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-center">
                  <Zap className="w-7 h-7 text-slate-700 mb-2" />
                  <p className="text-[11px] text-slate-500">尚未設定自動訊息</p>
                  <p className="text-[10px] text-slate-600 mt-0.5">從上方新增訊息以開始使用</p>
                </div>
              ) : (
                [...visibleMessages]
                  .sort((a, b) => {
                    if (a.is_enabled && !b.is_enabled) return -1;
                    if (!a.is_enabled && b.is_enabled) return 1;
                    return a.sort_order - b.sort_order;
                  })
                  .map((msg) => {
                  const isRichCard = msg.message_type === 'rich_card';
                  const enabledMessages = visibleMessages.filter(m => m.is_enabled).sort((a, b) => a.sort_order - b.sort_order);
                  const enabledIdx = msg.is_enabled ? enabledMessages.findIndex(m => m.id === msg.id) : -1;
                  return (
                    <div
                      key={msg.id}
                      onClick={() => handleEditClick(msg)}
                      className={`rounded-xl cursor-pointer group transition-all duration-200 overflow-hidden ${
                        !msg.is_enabled
                          ? 'bg-slate-700 opacity-50 hover:opacity-65'
                          : isRichCard
                            ? 'bg-sky-800 hover:bg-sky-750 shadow-sm hover:shadow-md hover:shadow-sky-900/40'
                            : 'bg-teal-800 hover:bg-teal-750 shadow-sm hover:shadow-md hover:shadow-teal-900/40'
                      }`}
                    >
                      {/* Header row */}
                      <div className={`flex items-center gap-1.5 px-2.5 py-1.5 ${
                        !msg.is_enabled ? 'bg-slate-600' : isRichCard ? 'bg-sky-900' : 'bg-teal-900'
                      }`}>
                        {msg.is_enabled ? (
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-black flex-shrink-0 ${
                            isRichCard ? 'bg-white text-sky-700' : 'bg-white text-teal-700'
                          }`}>
                            {enabledIdx + 1}
                          </div>
                        ) : (
                          <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold flex-shrink-0 bg-slate-500 text-slate-300">
                            --
                          </div>
                        )}
                        <span className={`text-[8px] px-1.5 py-0.5 rounded-full font-bold tracking-wider uppercase flex-shrink-0 ${
                          !msg.is_enabled ? 'bg-slate-500 text-slate-300' : isRichCard ? 'bg-sky-600 text-sky-100' : 'bg-teal-600 text-teal-100'
                        }`}>
                          {isRichCard ? 'Rich Card' : '快速傳送'}
                        </span>
                        <div className="flex-1 min-w-0" />
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          {msg.is_enabled && enabledIdx > 0 && (
                            <button type="button" onClick={(e) => { e.stopPropagation(); handleMoveUp(msg.id); }}
                              className="w-5 h-5 rounded-md bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
                              title={`移至第 ${enabledIdx} 則`}>
                              <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
                            </button>
                          )}
                          {msg.is_enabled && enabledIdx < enabledMessages.length - 1 && (
                            <button type="button" onClick={(e) => { e.stopPropagation(); handleMoveDown(msg.id); }}
                              className="w-5 h-5 rounded-md bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
                              title={`移至第 ${enabledIdx + 2} 則`}>
                              <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                            </button>
                          )}
                          <button type="button" onClick={(e) => { e.stopPropagation(); handleEditClick(msg); }}
                            className="w-5 h-5 rounded-md bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
                            title="編輯">
                            <Pencil className="w-2.5 h-2.5 text-white" />
                          </button>
                          <button type="button" onClick={(e) => { e.stopPropagation(); handleDelete(msg.id); }}
                            className="w-5 h-5 rounded-md bg-red-500/70 hover:bg-red-500 flex items-center justify-center transition-colors"
                            title="刪除">
                            <Trash2 className="w-2.5 h-2.5 text-white" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleToggleEnabled(msg.id, msg.is_enabled); }}
                            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors duration-200 ml-0.5 flex-shrink-0 ${msg.is_enabled ? 'bg-emerald-400' : 'bg-slate-500'}`}
                            title={msg.is_enabled ? '停用此訊息' : '啟用此訊息'}
                          >
                            <span className={`inline-block h-2.5 w-2.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${msg.is_enabled ? 'translate-x-[14px]' : 'translate-x-[3px]'}`} />
                          </button>
                        </div>
                      </div>

                      {/* Card body */}
                      <div className="px-2.5 py-2">
                        <p className={`text-[11px] font-semibold truncate mb-0.5 ${!msg.is_enabled ? 'text-slate-300' : 'text-white'}`}>{msg.name || '未命名'}</p>

                        {isRichCard && msg.title && (
                          <div className="flex items-center gap-1 mb-0.5">
                            <Megaphone className={`w-2.5 h-2.5 flex-shrink-0 ${!msg.is_enabled ? 'text-slate-400' : 'text-sky-300'}`} />
                            <p className={`text-[10px] font-medium truncate ${!msg.is_enabled ? 'text-slate-400' : 'text-sky-200'}`}>{msg.title}</p>
                          </div>
                        )}

                        <p className={`text-[10px] line-clamp-2 leading-relaxed ${!msg.is_enabled ? 'text-slate-400' : 'text-white/60'}`}>
                          {stripHtmlToText(msg.content).substring(0, 200)}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Send order note */}
            {visibleMessages.length > 0 && (
              <div className="mt-2 px-2 py-1.5 bg-slate-800 rounded-lg">
                <p className="text-[9px] text-slate-400 text-center">
                  {(() => { const count = visibleMessages.filter(m => m.is_enabled).length; return count > 0 ? (<>員工開啟聊天時，啟用的訊息會依序傳送 <span className="text-amber-300 font-bold">#1</span> {'->'} <span className="text-amber-300 font-bold">#{count}</span></>) : (<span className="text-amber-400">所有訊息均已停用——不會傳送任何訊息</span>); })()}
                </p>
              </div>
            )}
          </>
      </div>

      {quickSendModal}
      {richCardModal}
    </>
  );
}
