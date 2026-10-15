import { useCallback, useEffect, useMemo, useState, type DragEvent, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  CheckCircle,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { getAdminFinancialSessionToken } from '../../lib/auth';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import { ProductType } from '../../types';

type StatusFilter = 'all' | 'active' | 'disabled';
type DateSortKey = 'created_at' | 'updated_at';
type DateSortDirection = 'asc' | 'desc';

interface ProductTypeManagementProps {
  isActive: boolean;
  onOrderDirtyChange?: (isDirty: boolean) => void;
}

const sortProductTypes = (items: ProductType[]) => [...items].sort((left, right) => (
  left.sort_order - right.sort_order || left.id.localeCompare(right.id)
));

const formatDate = (value: string) => new Intl.DateTimeFormat('zh-TW', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
}).format(new Date(value));

export default function ProductTypeManagement({
  isActive,
  onOrderDirtyChange,
}: ProductTypeManagementProps) {
  const [productTypes, setProductTypes] = useState<ProductType[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [dateSort, setDateSort] = useState<{ key: DateSortKey; direction: DateSortDirection } | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({ name: '' });
  const [savingProduct, setSavingProduct] = useState(false);
  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [productTypeToDelete, setProductTypeToDelete] = useState<{ id: string; name: string } | null>(null);
  const [removingProduct, setRemovingProduct] = useState(false);
  const [showEditConfirm, setShowEditConfirm] = useState(false);
  const [isSorting, setIsSorting] = useState(false);
  const [draftOrder, setDraftOrder] = useState<ProductType[]>([]);
  const [savingOrder, setSavingOrder] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);

  const loadProductTypes = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setLoadError(null);

    try {
      const { data, error } = await supabase
        .from('product_types')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true });

      if (error) throw error;
      setProductTypes(sortProductTypes(data || []));
    } catch (error: unknown) {
      console.error('Error loading product types:', error);
      setLoadError(formatSupabaseError(error) || '無法載入產品資料');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProductTypes();
  }, [loadProductTypes]);

  useEffect(() => {
    if (!notification) return;
    const timer = window.setTimeout(() => setNotification(null), 3200);
    return () => window.clearTimeout(timer);
  }, [notification]);

  const orderedIds = useMemo(() => productTypes.map(item => item.id), [productTypes]);
  const draftIds = useMemo(() => draftOrder.map(item => item.id), [draftOrder]);
  const isOrderDirty = isSorting && draftIds.some((id, index) => id !== orderedIds[index]);

  useEffect(() => {
    onOrderDirtyChange?.(isOrderDirty);
  }, [isOrderDirty, onOrderDirtyChange]);

  useEffect(() => {
    if (isActive || !isSorting) return;
    setIsSorting(false);
    setDraftOrder([]);
    setDraggedId(null);
    setDragOverId(null);
  }, [isActive, isSorting]);

  useEffect(() => {
    if (!isOrderDirty) return;

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isOrderDirty]);

  const searchMatchedProducts = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return productTypes;
    return productTypes.filter(item => item.name.toLocaleLowerCase().includes(normalizedQuery));
  }, [productTypes, searchQuery]);

  const statusCounts = useMemo<Record<StatusFilter, number>>(() => ({
    all: searchMatchedProducts.length,
    active: searchMatchedProducts.filter(item => item.is_active).length,
    disabled: searchMatchedProducts.filter(item => !item.is_active).length,
  }), [searchMatchedProducts]);

  const visibleProducts = useMemo(() => {
    const filteredProducts = isSorting
      ? draftOrder
      : searchMatchedProducts.filter(item => (
        statusFilter === 'all'
        || (statusFilter === 'active' && item.is_active)
        || (statusFilter === 'disabled' && !item.is_active)
      ));

    if (isSorting || !dateSort) return filteredProducts;

    return [...filteredProducts].sort((left, right) => {
      const difference = new Date(left[dateSort.key]).getTime() - new Date(right[dateSort.key]).getTime();
      if (difference !== 0) return dateSort.direction === 'asc' ? difference : -difference;
      return left.sort_order - right.sort_order || left.id.localeCompare(right.id);
    });
  }, [dateSort, draftOrder, isSorting, searchMatchedProducts, statusFilter]);

  const toggleDateSort = (key: DateSortKey) => {
    if (isSorting) return;

    setDateSort(current => {
      if (!current || current.key !== key) return { key, direction: 'asc' };
      if (current.direction === 'asc') return { key, direction: 'desc' };
      return null;
    });
  };

  const listHeaderTheme = {
    all: 'border-blue-400/25 bg-blue-950/35 text-blue-100',
    active: 'border-emerald-400/25 bg-emerald-950/35 text-emerald-100',
    disabled: 'border-amber-400/25 bg-amber-950/35 text-amber-100',
  }[statusFilter];
  const editingProduct = editingId ? productTypes.find(item => item.id === editingId) : null;

  const openCreateForm = () => {
    setShowEditConfirm(false);
    setDateSort(null);
    setEditingId(null);
    setFormData({ name: '' });
    setShowForm(true);
  };

  const startEdit = (productType: ProductType) => {
    setShowForm(false);
    setShowEditConfirm(false);
    setDateSort(null);
    setEditingId(productType.id);
    setFormData({ name: productType.name });
  };

  const closeForm = () => {
    if (savingProduct) return;
    setShowForm(false);
    setShowEditConfirm(false);
    setEditingId(null);
    setFormData({ name: '' });
  };

  const requestInlineEditConfirmation = () => {
    if (!editingId) return;

    const currentProduct = productTypes.find(item => item.id === editingId);
    const productName = formData.name.trim();
    if (!currentProduct) return;

    if (!productName) {
      setNotification({ type: 'error', message: '產品名稱不能留空' });
      return;
    }

    if (productName === currentProduct.name) {
      closeForm();
      return;
    }

    setFormData({ name: productName });
    setShowEditConfirm(true);
  };

  const confirmInlineEdit = async () => {
    if (!editingId || savingProduct) return;

    const currentProduct = productTypes.find(item => item.id === editingId);
    const productName = formData.name.trim();
    if (!currentProduct || !productName) return;

    const previousProducts = productTypes;
    setSavingProduct(true);
    setShowEditConfirm(false);
    setProductTypes(current => current.map(item => (
      item.id === editingId ? { ...item, name: productName } : item
    )));

    try {
      const { data, error } = await supabase
        .from('product_types')
        .update({ name: productName, updated_at: new Date().toISOString() })
        .eq('id', editingId)
        .select()
        .single();

      if (error) throw error;

      setProductTypes(current => sortProductTypes(current.map(item => item.id === data.id ? data : item)));
      setNotification({ type: 'success', message: '產品名稱已更新' });
      setEditingId(null);
      setFormData({ name: '' });
    } catch (error: unknown) {
      setProductTypes(previousProducts);
      console.error('Error updating product name:', error);
      const message = formatSupabaseError(error);
      setNotification({
        type: 'error',
        message: message.includes('23505') || message.toLocaleLowerCase().includes('duplicate')
          ? `「${productName}」已存在，請使用其他名稱`
          : message || '更新產品名稱失敗',
      });
    } finally {
      setSavingProduct(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const productName = formData.name.trim();

    if (!productName) {
      setNotification({ type: 'error', message: '產品名稱不能留空' });
      return;
    }

    setSavingProduct(true);

    try {
      const { data: existing, error: existingError } = await supabase
          .from('product_types')
          .select('*')
          .eq('name', productName)
          .maybeSingle();

        if (existingError) throw existingError;

        let savedProduct: ProductType;
        if (existing) {
          if (existing.is_active) {
            setNotification({ type: 'error', message: `「${productName}」已存在` });
            return;
          }

          const { data, error } = await supabase
            .from('product_types')
            .update({ is_active: true, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
            .select()
            .single();

          if (error) throw error;
          savedProduct = data;
        } else {
          const { data, error } = await supabase
            .from('product_types')
            .insert({ name: productName })
            .select()
            .single();

          if (error) throw error;
          savedProduct = data;
        }

        setProductTypes(current => sortProductTypes([
          ...current.filter(item => item.id !== savedProduct.id),
          savedProduct,
        ]));
      setNotification({
        type: 'success',
        message: existing ? '既有產品已重新啟用' : '產品已新增至列表末端',
      });
      closeForm();
    } catch (error: unknown) {
      console.error('Error saving product type:', error);
      const message = formatSupabaseError(error);
      setNotification({
        type: 'error',
        message: message.includes('23505') || message.toLocaleLowerCase().includes('duplicate')
          ? `「${productName}」已存在，請使用其他名稱`
          : message || '儲存產品失敗',
      });
    } finally {
      setSavingProduct(false);
    }
  };

  const toggleStatus = async (id: string, currentStatus: boolean) => {
    if (togglingId) return;
    setTogglingId(id);

    const previousProducts = productTypes;
    const nextStatus = !currentStatus;
    setProductTypes(current => current.map(item => (
      item.id === id ? { ...item, is_active: nextStatus } : item
    )));

    try {
      const { data, error } = await supabase
        .from('product_types')
        .update({ is_active: nextStatus, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();

      if (error) throw error;
      setProductTypes(current => sortProductTypes(current.map(item => item.id === data.id ? data : item)));
      setNotification({ type: 'success', message: nextStatus ? '產品已啟用' : '產品已停用' });
    } catch (error: unknown) {
      setProductTypes(previousProducts);
      console.error('Error toggling product type status:', error);
      setNotification({ type: 'error', message: formatSupabaseError(error) || '更新狀態失敗' });
    } finally {
      setTogglingId(null);
    }
  };

  const requestDelete = (productType: ProductType) => {
    setProductTypeToDelete({ id: productType.id, name: productType.name });
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (!productTypeToDelete || removingProduct) return;

    const previousProducts = productTypes;
    setRemovingProduct(true);
    setProductTypes(current => current.map(item => (
      item.id === productTypeToDelete.id ? { ...item, is_active: false } : item
    )));

    try {
      const { data, error } = await supabase
        .from('product_types')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', productTypeToDelete.id)
        .select()
        .single();

      if (error) throw error;
      setProductTypes(current => sortProductTypes(current.map(item => item.id === data.id ? data : item)));
      setNotification({ type: 'success', message: '產品已移除，歷史訂單仍完整保留' });
    } catch (error: unknown) {
      setProductTypes(previousProducts);
      const message = formatSupabaseError(error);
      console.error('Error removing product type:', message);
      setNotification({ type: 'error', message: message || '移除產品失敗' });
    } finally {
      setRemovingProduct(false);
      setShowDeleteConfirm(false);
      setProductTypeToDelete(null);
    }
  };

  const startSorting = () => {
    closeForm();
    setSearchQuery('');
    setStatusFilter('all');
    setDateSort(null);
    setDraftOrder(sortProductTypes(productTypes));
    setIsSorting(true);
  };

  const discardOrderChanges = () => {
    setDraftOrder([]);
    setIsSorting(false);
    setDraggedId(null);
    setDragOverId(null);
    setShowDiscardConfirm(false);
  };

  const requestCancelSorting = () => {
    if (isOrderDirty) {
      setShowDiscardConfirm(true);
      return;
    }
    discardOrderChanges();
  };

  const moveProduct = (productId: string, direction: -1 | 1) => {
    setDraftOrder(current => {
      const currentIndex = current.findIndex(item => item.id === productId);
      const targetIndex = currentIndex + direction;
      if (currentIndex < 0 || targetIndex < 0 || targetIndex >= current.length) return current;

      const next = [...current];
      const [movedProduct] = next.splice(currentIndex, 1);
      next.splice(targetIndex, 0, movedProduct);
      return next;
    });
  };

  const handleDragStart = (event: DragEvent<HTMLButtonElement>, productId: string) => {
    setDraggedId(productId);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', productId);
  };

  const handleDrop = (event: DragEvent<HTMLElement>, targetId: string) => {
    event.preventDefault();
    const sourceId = draggedId || event.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === targetId) {
      setDraggedId(null);
      setDragOverId(null);
      return;
    }

    setDraftOrder(current => {
      const sourceIndex = current.findIndex(item => item.id === sourceId);
      const targetIndex = current.findIndex(item => item.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;

      const next = [...current];
      const [movedProduct] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, movedProduct);
      return next;
    });
    setDraggedId(null);
    setDragOverId(null);
  };

  const saveOrder = async () => {
    if (!isOrderDirty || savingOrder) return;
    setSavingOrder(true);

    try {
      const { error } = await supabase.rpc('reorder_product_types', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_product_type_ids: draftOrder.map(item => item.id),
      });

      if (error) throw error;

      const savedAt = new Date().toISOString();
      setProductTypes(draftOrder.map((item, index) => ({
        ...item,
        sort_order: index + 1,
        updated_at: savedAt,
      })));
      setNotification({ type: 'success', message: '產品順序已儲存，員工端選單將同步更新' });
      setDraftOrder([]);
      setIsSorting(false);
      await loadProductTypes(false);
    } catch (error: unknown) {
      console.error('Error saving product type order:', error);
      setNotification({ type: 'error', message: formatSupabaseError(error) || '儲存產品順序失敗' });
    } finally {
      setSavingOrder(false);
    }
  };

  const renderOrderControls = (productType: ProductType, index: number) => (
    <div className="flex items-center justify-end gap-1.5">
      <button
        type="button"
        onClick={() => moveProduct(productType.id, -1)}
        disabled={index === 0 || savingOrder}
        aria-label={`上移 ${productType.name}`}
        className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 transition hover:border-cyan-400/50 hover:bg-cyan-500/10 hover:text-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ArrowUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => moveProduct(productType.id, 1)}
        disabled={index === draftOrder.length - 1 || savingOrder}
        aria-label={`下移 ${productType.name}`}
        className="rounded-lg border border-slate-700 bg-slate-800 p-2 text-slate-300 transition hover:border-cyan-400/50 hover:bg-cyan-500/10 hover:text-cyan-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-30"
      >
        <ArrowDown className="h-4 w-4" />
      </button>
    </div>
  );

  const renderProductActions = (productType: ProductType) => (
    <div className="flex items-center justify-end gap-1.5">
      <button
        type="button"
        onClick={() => startEdit(productType)}
        aria-label={`編輯 ${productType.name}`}
        className="rounded-md p-1.5 text-blue-300 transition hover:bg-blue-500/15 hover:text-blue-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        <Pencil className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => void toggleStatus(productType.id, productType.is_active)}
        disabled={togglingId !== null}
        aria-label={`${productType.is_active ? '停用' : '啟用'} ${productType.name}`}
        className={`rounded-md p-1.5 transition focus:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40 ${productType.is_active
          ? 'text-amber-300 hover:bg-amber-500/15 hover:text-amber-100 focus-visible:ring-amber-400'
          : 'text-emerald-300 hover:bg-emerald-500/15 hover:text-emerald-100 focus-visible:ring-emerald-400'
        }`}
      >
        {togglingId === productType.id ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : productType.is_active ? (
          <EyeOff className="h-4 w-4" />
        ) : (
          <Eye className="h-4 w-4" />
        )}
      </button>
      {productType.is_active && (
        <button
          type="button"
          onClick={() => requestDelete(productType)}
          aria-label={`移除 ${productType.name}`}
          className="rounded-md p-1.5 text-rose-300 transition hover:bg-rose-500/15 hover:text-rose-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  const renderDateSortHeader = (key: DateSortKey, label: string, hidden = false) => {
    const isSelected = dateSort?.key === key;
    const direction = isSelected ? dateSort.direction : null;

    return (
      <button
        type="button"
        onClick={() => toggleDateSort(key)}
        disabled={isSorting}
        aria-label={`${label}${direction === 'asc' ? '，目前升序' : direction === 'desc' ? '，目前降序' : ''}`}
        className={`${hidden ? 'hidden xl:flex' : 'flex'} h-11 min-h-0 w-[140px] max-w-full items-center justify-between gap-1 rounded-md px-2 text-left text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${
          isSelected
            ? key === 'created_at'
              ? 'border border-blue-300 bg-blue-600 text-white shadow-sm'
              : 'border border-cyan-300 bg-cyan-600 text-white shadow-sm'
            : 'text-current/65 hover:bg-white/10 hover:text-current'
        } disabled:cursor-not-allowed disabled:opacity-50`}
      >
        <span>{label}</span>
        {direction === 'asc' ? <ArrowUp className="h-3.5 w-3.5" /> : direction === 'desc' ? <ArrowDown className="h-3.5 w-3.5" /> : <ArrowUpDown className="h-3.5 w-3.5" />}
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950/55">
      {notification && (
        <div className={`fixed right-4 top-4 z-[10000] flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-xl border px-4 py-3 shadow-2xl backdrop-blur-xl ${
          notification.type === 'success'
            ? 'border-emerald-400/30 bg-emerald-950/95 text-emerald-100'
            : 'border-rose-400/30 bg-rose-950/95 text-rose-100'
        }`}>
          {notification.type === 'success' ? <CheckCircle className="h-5 w-5 shrink-0" /> : <AlertTriangle className="h-5 w-5 shrink-0" />}
          <span className="text-sm font-medium">{notification.message}</span>
          <button
            type="button"
            onClick={() => setNotification(null)}
            aria-label="關閉通知"
            className="ml-1 rounded-md p-1 text-white/60 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <header className="relative shrink-0 overflow-hidden border-b border-cyan-400/15 bg-gradient-to-r from-slate-950 via-blue-950/90 to-cyan-950/70 px-3 py-2 shadow-[0_8px_30px_rgba(8,47,73,0.18)] backdrop-blur-xl sm:px-4 lg:px-5">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-300/50 to-transparent" />
        <div className="relative flex flex-col gap-2 xl:flex-row xl:items-center">
          <div className="flex shrink-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-cyan-300/30 bg-gradient-to-br from-blue-500/40 to-cyan-400/20 text-cyan-100 shadow-[0_0_18px_rgba(34,211,238,0.12)]">
              <Package className="h-4 w-4" />
            </div>
            <div className="flex items-center gap-2">
              <h1 className="bg-gradient-to-r from-white to-cyan-100 bg-clip-text text-base font-semibold tracking-tight text-transparent sm:text-lg">產品管理</h1>
              {isSorting && (
                <span className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-100">排序模式</span>
              )}
            </div>
          </div>

          {isSorting ? (
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center xl:justify-end">
              <div className="flex min-w-0 flex-1 items-center gap-2 text-xs text-cyan-100 xl:max-w-xl">
                <GripVertical className="h-4 w-4 shrink-0 text-cyan-300" />
                <span className="truncate">拖動列或使用上下按鈕調整順序，停用產品也會保留位置。</span>
                <span className={`shrink-0 font-semibold ${isOrderDirty ? 'text-amber-300' : 'text-slate-500'}`}>
                  {isOrderDirty ? '未儲存' : '未變更'}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={requestCancelSorting}
                  disabled={savingOrder}
                  className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-slate-600/70 bg-slate-950/50 px-3 text-xs font-medium text-slate-200 transition hover:border-slate-400 hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50"
                >
                  <RotateCcw className="h-4 w-4" />
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void saveOrder()}
                  disabled={!isOrderDirty || savingOrder}
                  className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-cyan-300/30 bg-gradient-to-r from-blue-600 to-cyan-500 px-3 text-xs font-semibold text-white shadow-[0_5px_16px_rgba(6,182,212,0.18)] transition hover:from-blue-500 hover:to-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {savingOrder ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {savingOrder ? '儲存中…' : '儲存順序'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:flex-wrap md:items-center xl:flex-nowrap xl:justify-end">
              <div className="flex min-w-0 items-center gap-2">
                <div className="grid min-w-0 flex-1 grid-cols-3 gap-0.5 rounded-xl border border-slate-700 bg-slate-950 p-0.5 shadow-md md:flex md:w-fit md:flex-none">
                  {([
                    ['all', '全部', Eye, 'bg-blue-950 text-blue-300', 'border-blue-300 bg-blue-600 text-white shadow-sm', 'text-blue-300'],
                    ['active', '已啟用', CheckCircle, 'bg-emerald-950 text-emerald-300', 'border-emerald-300 bg-emerald-600 text-white shadow-sm', 'text-emerald-300'],
                    ['disabled', '已停用', EyeOff, 'bg-amber-950 text-amber-300', 'border-amber-300 bg-amber-600 text-white shadow-sm', 'text-amber-300'],
                  ] as const).map(([value, label, Icon, iconClass, activeClass, countClass]) => {
                    const isSelected = statusFilter === value;

                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setStatusFilter(value)}
                        aria-pressed={isSelected}
                        className={`flex min-h-9 min-w-0 items-center gap-1.5 rounded-lg border px-2 text-left transition-colors focus:outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-cyan-300 sm:px-2.5 ${
                          isSelected
                            ? activeClass
                            : 'border-transparent bg-slate-900 text-slate-400 hover:border-slate-700 hover:bg-slate-800 hover:text-slate-200'
                        }`}
                      >
                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${isSelected ? 'bg-white/15 text-white' : iconClass}`}>
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{label}</span>
                        <span className={`text-sm font-bold tabular-nums ${isSelected ? 'text-white' : countClass}`}>
                          {statusCounts[value]}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <span className="hidden shrink-0 text-[11px] text-cyan-100/50 2xl:inline">顯示 {visibleProducts.length} 項</span>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={startSorting}
                  disabled={loading || productTypes.length < 2}
                  className="group inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-violet-300/30 bg-gradient-to-r from-violet-500/20 to-blue-500/20 px-3 text-xs font-semibold text-violet-50 shadow-[0_4px_14px_rgba(124,58,237,0.12)] transition hover:border-violet-300/50 hover:from-violet-500/30 hover:to-blue-500/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <SlidersHorizontal className="h-4 w-4 text-violet-200 transition group-hover:text-white" />
                  調整順序
                </button>
                <button
                  type="button"
                  onClick={openCreateForm}
                  className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-cyan-200/30 bg-gradient-to-r from-blue-600 to-cyan-500 px-3 text-xs font-semibold text-white shadow-[0_5px_16px_rgba(6,182,212,0.18)] transition hover:from-blue-500 hover:to-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                >
                  <Plus className="h-4 w-4" />
                  新增產品
                </button>
              </div>

              <div className="relative w-full md:ml-auto md:w-72 xl:ml-1 xl:w-80 2xl:w-96">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={event => setSearchQuery(event.target.value)}
                  placeholder="搜尋產品名稱"
                  className="h-9 w-full rounded-lg border border-white/80 bg-slate-50 pl-9 pr-9 text-sm font-medium text-slate-900 shadow-[0_4px_14px_rgba(15,23,42,0.18)] transition placeholder:text-slate-500 focus:border-cyan-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-cyan-300/30"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="清除搜尋"
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-slate-500 transition hover:bg-slate-200 hover:text-slate-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-950/35">
          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-3 text-slate-400">
                <Loader2 className="h-7 w-7 animate-spin text-cyan-400" />
                <span className="text-sm">正在載入產品列表…</span>
              </div>
            </div>
          ) : loadError ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center">
              <div>
                <AlertTriangle className="mx-auto h-8 w-8 text-amber-400" />
                <p className="mt-3 text-sm font-medium text-white">產品資料載入失敗</p>
                <p className="mt-1 max-w-md text-xs text-slate-400">{loadError}</p>
                <button
                  type="button"
                  onClick={() => void loadProductTypes()}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 transition hover:border-cyan-400/40 hover:text-cyan-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
                >
                  <RefreshCw className="h-4 w-4" />
                  重新載入
                </button>
              </div>
            </div>
          ) : visibleProducts.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6 text-center">
              <div>
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-slate-700 bg-slate-800 text-slate-500">
                  <Package className="h-6 w-6" />
                </div>
                <p className="mt-3 text-sm font-medium text-white">找不到符合條件的產品</p>
                <p className="mt-1 text-xs text-slate-500">請調整搜尋文字或狀態篩選</p>
              </div>
            </div>
          ) : (
            <>
              <div className="hidden min-h-0 flex-1 flex-col lg:flex">
                <div className={`grid h-11 min-h-0 shrink-0 grid-cols-[72px_minmax(200px,1fr)_110px_140px_140px] items-center gap-3 border-b px-4 py-0 text-[10px] font-semibold uppercase tracking-[0.1em] xl:grid-cols-[72px_minmax(240px,1fr)_110px_140px_140px_140px] ${listHeaderTheme}`}>
                  <span>順序</span>
                  <span>產品</span>
                  <span>狀態</span>
                  {renderDateSortHeader('created_at', '建立時間', true)}
                  {renderDateSortHeader('updated_at', '更新時間')}
                  <span className="text-right">{isSorting ? '調整' : '操作'}</span>
                </div>
                <div className="product-type-list-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain" data-scroll-theme={statusFilter}>
                  {visibleProducts.map((productType, index) => (
                    <div
                      key={productType.id}
                      data-product-id={productType.id}
                      onDragOver={event => {
                        if (!isSorting || draggedId === productType.id) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = 'move';
                        setDragOverId(productType.id);
                      }}
                      onDragLeave={() => setDragOverId(current => current === productType.id ? null : current)}
                      onDrop={event => handleDrop(event, productType.id)}
                      className={`grid min-h-[44px] grid-cols-[72px_minmax(200px,1fr)_110px_140px_140px] items-center gap-3 border-b px-4 py-1.5 transition xl:grid-cols-[72px_minmax(240px,1fr)_110px_140px_140px_140px] ${
                        dragOverId === productType.id
                          ? 'border-cyan-400/70 bg-cyan-400/[0.07]'
                          : productType.is_active
                            ? 'border-emerald-900/50 bg-emerald-950/[0.10] hover:bg-emerald-900/20'
                            : 'border-amber-900/40 bg-amber-950/[0.08] hover:bg-amber-900/15'
                      } ${draggedId === productType.id ? 'opacity-45' : ''}`}
                    >
                      <div className="flex items-center gap-2">
                        {isSorting && (
                          <button
                            type="button"
                            draggable
                            onDragStart={event => handleDragStart(event, productType.id)}
                            onDragEnd={() => {
                              setDraggedId(null);
                              setDragOverId(null);
                            }}
                            aria-label={`拖動 ${productType.name}`}
                            className="cursor-grab rounded-md p-1 text-slate-500 transition hover:bg-slate-700 hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 active:cursor-grabbing"
                          >
                            <GripVertical className="h-4 w-4" />
                          </button>
                        )}
                        <span className="font-mono text-sm font-semibold text-cyan-300">{String(index + 1).padStart(2, '0')}</span>
                      </div>

                      <div className="min-w-0">
                        {editingId === productType.id ? (
                          <div className="flex items-center gap-1.5">
                            <input
                              autoFocus
                              type="text"
                              value={formData.name}
                              onChange={event => setFormData({ name: event.target.value })}
                              onKeyDown={event => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  requestInlineEditConfirmation();
                                }
                                if (event.key === 'Escape') closeForm();
                              }}
                              maxLength={120}
                              disabled={savingProduct}
                              aria-label={`編輯 ${productType.name}`}
                              className="h-8 min-w-0 flex-1 rounded-md border border-blue-300/60 bg-slate-100 px-2.5 text-sm font-medium text-slate-900 outline-none ring-blue-300/30 placeholder:text-slate-500 focus:ring-2 disabled:opacity-60"
                            />
                            <button
                              type="button"
                              onClick={requestInlineEditConfirmation}
                              disabled={savingProduct}
                              aria-label="確認修改產品名稱"
                              className="rounded-md p-1.5 text-emerald-300 transition hover:bg-emerald-500/15 hover:text-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-40"
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              type="button"
                              onClick={closeForm}
                              disabled={savingProduct}
                              aria-label="取消修改產品名稱"
                              className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-700 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-40"
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <p className="truncate text-sm font-semibold text-slate-100">{productType.name}</p>
                        )}
                      </div>

                      <span className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                        productType.is_active
                          ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
                          : 'border-amber-400/25 bg-amber-950/50 text-amber-300'
                      }`}>
                        <span className={`h-0.5 w-0.5 rounded-full ${productType.is_active ? 'bg-emerald-400' : 'bg-amber-400'}`} />
                        {productType.is_active ? '已啟用' : '已停用'}
                      </span>

                      <span className="hidden text-xs text-slate-400 xl:block">{formatDate(productType.created_at)}</span>
                      <span className="text-xs text-slate-400">{formatDate(productType.updated_at)}</span>
                      {isSorting ? renderOrderControls(productType, index) : renderProductActions(productType)}
                    </div>
                  ))}
                </div>
              </div>

              <div className="product-type-list-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto p-2 lg:hidden" data-scroll-theme={statusFilter}>
                {visibleProducts.map((productType, index) => (
                  <article
                    key={productType.id}
                    className={`rounded-lg border p-2 ${productType.is_active
                      ? 'border-emerald-900/50 bg-emerald-950/[0.12]'
                      : 'border-amber-900/40 bg-amber-950/[0.10]'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-700 bg-slate-900 font-mono text-xs font-bold text-cyan-200">
                        {String(index + 1).padStart(2, '0')}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            {editingId === productType.id ? (
                              <div className="flex items-center gap-1.5">
                                <input
                                  autoFocus
                                  type="text"
                                  value={formData.name}
                                  onChange={event => setFormData({ name: event.target.value })}
                                  onKeyDown={event => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault();
                                      requestInlineEditConfirmation();
                                    }
                                    if (event.key === 'Escape') closeForm();
                                  }}
                                  maxLength={120}
                                  disabled={savingProduct}
                                  aria-label={`編輯 ${productType.name}`}
                                  className="h-8 min-w-0 w-full rounded-md border border-blue-300/60 bg-slate-100 px-2.5 text-sm font-medium text-slate-900 outline-none ring-blue-300/30 placeholder:text-slate-500 focus:ring-2 disabled:opacity-60"
                                />
                                <button
                                  type="button"
                                  onClick={requestInlineEditConfirmation}
                                  disabled={savingProduct}
                                  aria-label="確認修改產品名稱"
                                  className="rounded-md p-1.5 text-emerald-300 transition hover:bg-emerald-500/15 hover:text-emerald-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:opacity-40"
                                >
                                  <Check className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={closeForm}
                                  disabled={savingProduct}
                                  aria-label="取消修改產品名稱"
                                  className="rounded-md p-1.5 text-slate-400 transition hover:bg-slate-700 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-40"
                                >
                                  <X className="h-4 w-4" />
                                </button>
                              </div>
                            ) : (
                              <h2 className="truncate text-sm font-semibold text-white">{productType.name}</h2>
                            )}
                          </div>
                          <span className={`shrink-0 rounded-full border px-2 py-1 text-[10px] font-semibold ${
                            productType.is_active
                              ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200'
                              : 'border-amber-400/25 bg-amber-950/50 text-amber-300'
                          }`}>
                            {productType.is_active ? '已啟用' : '已停用'}
                          </span>
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-3 border-t border-slate-800 pt-2">
                          <span className="text-[11px] text-slate-500">更新 {formatDate(productType.updated_at)}</span>
                          {isSorting ? renderOrderControls(productType, index) : renderProductActions(productType)}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </main>

      {showForm && !isSorting && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <form onSubmit={handleSubmit} className="w-full max-w-lg overflow-hidden rounded-2xl border border-cyan-400/25 bg-slate-900 shadow-2xl shadow-blue-950/40">
            <div className="border-b border-cyan-300/15 bg-gradient-to-r from-blue-950 via-slate-900 to-cyan-950 px-5 py-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-300/30 bg-cyan-400/15 text-cyan-200 shadow-inner">
                    <Plus className="h-5 w-5" />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold tracking-tight text-white">新增產品</h2>
                    <p className="mt-1 text-xs text-cyan-100/70">建立新的產品類型並加入管理列表。</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closeForm}
                  disabled={savingProduct}
                  aria-label="關閉新增產品面板"
                  className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="space-y-4 p-5">
              <label className="block">
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">產品名稱</span>
                <input
                  autoFocus
                  type="text"
                  value={formData.name}
                  onChange={event => setFormData({ name: event.target.value })}
                  maxLength={120}
                  required
                  className="h-11 w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 text-sm font-medium text-slate-900 shadow-inner outline-none transition placeholder:text-slate-500 focus:border-cyan-400 focus:bg-white focus:ring-2 focus:ring-cyan-400/25"
                  placeholder="輸入產品名稱"
                />
              </label>
              <div className="flex items-start gap-2 rounded-xl border border-slate-700/80 bg-slate-950/55 px-3 py-2.5 text-xs text-slate-400">
                <Package className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                <span>新產品會自動加入列表末端，之後仍可在「調整順序」中重新排列。</span>
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={closeForm}
                  disabled={savingProduct}
                  className="min-h-10 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 text-sm font-medium text-slate-300 transition hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={savingProduct}
                  className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 px-3 text-sm font-semibold text-white shadow-[0_6px_18px_rgba(6,182,212,0.18)] transition hover:from-blue-500 hover:to-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingProduct ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  {savingProduct ? '建立中…' : '建立產品'}
                </button>
              </div>
            </div>
          </form>
        </div>,
        document.body,
      )}

      {showEditConfirm && editingProduct && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="edit-product-title" className="w-full max-w-xl overflow-hidden rounded-2xl border border-blue-400/30 bg-slate-900 shadow-2xl shadow-blue-950/40">
            <div className="border-b border-blue-300/15 bg-gradient-to-r from-blue-950 via-slate-900 to-cyan-950 px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-blue-300/30 bg-blue-500/20 text-blue-200">
                  <Pencil className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h2 id="edit-product-title" className="text-base font-semibold text-white">確認修改產品名稱</h2>
                  <p className="mt-1 text-xs text-blue-100/70">請確認以下變更內容，確認後將立即更新產品列表。</p>
                </div>
              </div>
            </div>
            <div className="space-y-3 p-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-700 bg-slate-950/70 p-3">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">修改前</span>
                  <p className="mt-2 truncate text-sm font-semibold text-slate-300">{editingProduct.name}</p>
                </div>
                <div className="rounded-xl border border-blue-400/30 bg-blue-950/40 p-3">
                  <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-300">修改後</span>
                  <p className="mt-2 truncate text-sm font-semibold text-blue-50">{formData.name}</p>
                </div>
              </div>
              <p className="rounded-lg border border-slate-700/80 bg-slate-950/45 px-3 py-2 text-xs text-slate-400">產品排序、啟用狀態與歷史訂單關聯不會受到影響。</p>
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowEditConfirm(false)}
                  disabled={savingProduct}
                  className="min-h-10 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 text-sm font-medium text-slate-300 transition hover:bg-slate-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50"
                >
                  返回修改
                </button>
                <button
                  type="button"
                  onClick={() => void confirmInlineEdit()}
                  disabled={savingProduct}
                  className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 px-3 text-sm font-semibold text-white transition hover:from-blue-500 hover:to-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {savingProduct && <Loader2 className="h-4 w-4 animate-spin" />}
                  {savingProduct ? '儲存中…' : '確認修改'}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {showDeleteConfirm && productTypeToDelete && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="remove-product-title" className="w-full max-w-md rounded-2xl border border-amber-400/30 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-amber-400/20 bg-amber-400/10 text-amber-300">
                <Trash2 className="h-5 w-5" />
              </div>
              <div>
                <h2 id="remove-product-title" className="text-lg font-semibold text-white">移除產品</h2>
                <p className="text-xs text-slate-400">產品會停用，歷史資料會完整保留</p>
              </div>
            </div>
            <div className="my-5 rounded-xl border border-slate-700 bg-slate-950/70 p-4">
              <p className="text-sm font-semibold text-white">{productTypeToDelete.name}</p>
              <div className="mt-3 space-y-2 text-xs">
                <p className="flex items-center gap-2 text-emerald-300"><CheckCircle className="h-4 w-4" />歷史訂單與報表資料將完整保留</p>
                <p className="flex items-center gap-2 text-amber-300"><AlertTriangle className="h-4 w-4" />員工端將不再顯示此產品</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setProductTypeToDelete(null);
                }}
                disabled={removingProduct}
                className="min-h-11 flex-1 rounded-xl border border-slate-700 bg-slate-800 text-sm font-medium text-slate-200 transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={removingProduct}
                className="min-h-11 flex-1 rounded-xl bg-amber-600 text-sm font-semibold text-white transition hover:bg-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50"
              >
                {removingProduct ? '移除中…' : '確認移除'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {showDiscardConfirm && createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="discard-order-title" className="w-full max-w-sm rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400/10 text-amber-300">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div>
                <h2 id="discard-order-title" className="font-semibold text-white">放棄順序調整？</h2>
                <p className="mt-0.5 text-xs text-slate-400">未儲存的產品順序將會還原。</p>
              </div>
            </div>
            <div className="mt-5 flex gap-3">
              <button
                type="button"
                onClick={() => setShowDiscardConfirm(false)}
                className="min-h-10 flex-1 rounded-xl border border-slate-700 bg-slate-800 text-sm font-medium text-slate-200 transition hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
              >
                繼續調整
              </button>
              <button
                type="button"
                onClick={discardOrderChanges}
                className="min-h-10 flex-1 rounded-xl bg-amber-600 text-sm font-semibold text-white transition hover:bg-amber-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
              >
                放棄變更
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
