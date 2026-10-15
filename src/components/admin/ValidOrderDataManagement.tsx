import { useState, useEffect, useRef } from 'react';
import { Database, Upload, Trash2, Plus, FileSpreadsheet, CheckCircle, XCircle, AlertTriangle, X, ChevronDown } from 'lucide-react';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import { useCurrencyUnit } from '../../lib/useCurrencyUnit';

interface ValidOrderData {
  id: string;
  product_value: number;
  transaction_id: string;
  is_active: boolean;
  created_at: string;
}

interface ValidOrderDataManagementProps {
  adminId: string;
}

export default function ValidOrderDataManagement({ adminId }: ValidOrderDataManagementProps) {
  const currencyUnit = useCurrencyUnit(adminId);
  const [validData, setValidData] = useState<ValidOrderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [addMode, setAddMode] = useState<'single' | 'bulk'>('single');
  const [addingSingle, setAddingSingle] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [formData, setFormData] = useState({
    productValue: '',
    transactionId: '',
  });
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0 });
  const [showDeleteAllModal, setShowDeleteAllModal] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 500;
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [statusFilterOpen, setStatusFilterOpen] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [activeCount, setActiveCount] = useState(0);
  const [inactiveCount, setInactiveCount] = useState(0);
  const [pageInput, setPageInput] = useState('');
  const [deleteProgress, setDeleteProgress] = useState({ current: 0, total: 0, percentage: 0 });
  const loadValidDataRef = useRef<(() => Promise<void>) | null>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const statusFilterRef = useRef<HTMLDivElement>(null);
  const statusFilterButtonRef = useRef<HTMLButtonElement>(null);
  const statusFilterMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listScrollRef.current?.scrollTo({ top: 0 });
    void loadValidDataRef.current?.();
  }, [currentPage, statusFilter]);

  useEffect(() => {
    loadStatistics();
  }, []);

  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => {
        setMessage(null);
      }, 4000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  useEffect(() => {
    if (!statusFilterOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !statusFilterRef.current?.contains(event.target)) setStatusFilterOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setStatusFilterOpen(false);
        statusFilterButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [statusFilterOpen]);

  useEffect(() => {
    if (!showAddModal) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !uploading && !addingSingle) setShowAddModal(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showAddModal, uploading, addingSingle]);

  const loadStatistics = async () => {
    try {
      // Get total count
      await supabase
        .from('valid_order_data')
        .select('*', { count: 'exact', head: true });

      // Get active count
      const { count: active } = await supabase
        .from('valid_order_data')
        .select('*', { count: 'exact', head: true })
        .eq('is_active', true);

      // Get inactive count
      const { count: inactive } = await supabase
        .from('valid_order_data')
        .select('*', { count: 'exact', head: true })
        .eq('is_active', false);

      setActiveCount(active || 0);
      setInactiveCount(inactive || 0);
    } catch (error) {
      console.error('Error loading statistics:', error);
    }
  };

  const loadValidData = async () => {
    try {
      setLoading(true);

      // Only load the data for the current page to avoid timeout
      const from = (currentPage - 1) * itemsPerPage;
      const to = from + itemsPerPage - 1;

      // Build query with status filter
      let query = supabase
        .from('valid_order_data')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

      // Apply status filter
      if (statusFilter === 'active') {
        query = query.eq('is_active', true);
      } else if (statusFilter === 'inactive') {
        query = query.eq('is_active', false);
      }

      const { data, error, count } = await query;

      if (error) throw error;
      setValidData(data || []);
      setTotalCount(count || 0);
    } catch (error) {
      console.error('Error loading valid order data:', error);
      setMessage({ type: 'error', text: '載入資料失敗，請稍後再試。' });
    } finally {
      setLoading(false);
    }
  };
  loadValidDataRef.current = loadValidData;

  const handleAddSingle = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddError(null);

    const value = formData.productValue.trim();
    const transactionId = formData.transactionId.trim();
    if (!value) {
      setAddError('請輸入產品金額。');
      return;
    }
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
      setAddError('產品金額須為大於 0 的數字。');
      return;
    }
    if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(value)) {
      setAddError('產品金額格式錯誤，請輸入最多兩位小數的一般數字。');
      return;
    }
    if (!transactionId) {
      setAddError('請輸入交易 ID。');
      return;
    }

    setAddingSingle(true);
    try {
      const { error } = await supabase.from('valid_order_data').insert({
        product_value: Number(value),
        transaction_id: transactionId,
        created_by: adminId,
      });

      if (error) throw error;

      setMessage({ type: 'success', text: '資料新增成功。' });
      setFormData({ productValue: '', transactionId: '' });
      setShowAddModal(false);
      setCurrentPage(1);
      if (currentPage === 1) void loadValidDataRef.current?.();
      loadStatistics();
    } catch (error: unknown) {
      setAddError((error as { code?: string })?.code === '23505'
        ? '資料與現有記錄衝突，請檢查輸入後重試。'
        : '新增資料失敗，請稍後再試。');
    } finally {
      setAddingSingle(false);
    }
  };

  const handleBulkUpload = async () => {
    setAddError(null);
    setMessage(null);

    const lines = bulkText.trim().split('\n').filter(line => line.trim());
    if (lines.length === 0) {
      setAddError('請輸入資料，每行格式為「產品金額,交易 ID」。');
      return;
    }

    if (lines.length > 500000) {
      setAddError(`單次最多可上傳 500,000 筆資料，目前輸入 ${lines.length.toLocaleString()} 筆。`);
      return;
    }

    const dataToInsert = [];
    const errors = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const parts = line.split(',');

      if (parts.length !== 2) {
        errors.push(`第 ${i + 1} 行：格式錯誤，請使用「產品金額,交易 ID」。`);
        continue;
      }

      const productValue = Number(parts[0].trim());
      const transactionId = parts[1].trim();

      if (!Number.isFinite(productValue) || productValue <= 0) {
        errors.push(`第 ${i + 1} 行：產品金額須為大於 0 的數字。`);
        continue;
      }

      if (!transactionId || transactionId.length === 0) {
        errors.push(`第 ${i + 1} 行：請輸入交易 ID。`);
        continue;
      }

      dataToInsert.push({
        product_value: productValue,
        transaction_id: transactionId,
        created_by: adminId,
      });
    }

    if (errors.length > 0) {
      setAddError(`發現以下資料錯誤：\n${errors.join('\n')}`);
      return;
    }

    setUploading(true);
    setUploadProgress({ current: 0, total: dataToInsert.length });

    try {
      // Insert new data in batches (Supabase has a limit per request)
      const batchSize = 1000;
      let uploadedCount = 0;

      for (let i = 0; i < dataToInsert.length; i += batchSize) {
        const batch = dataToInsert.slice(i, i + batchSize);
        const { error } = await supabase.from('valid_order_data').insert(batch);
        if (error) throw error;

        uploadedCount += batch.length;
        setUploadProgress({ current: uploadedCount, total: dataToInsert.length });

        // Show progress message for large uploads
        if (dataToInsert.length > 5000) {
          setMessage({
            type: 'success',
            text: `上傳中：${uploadedCount.toLocaleString()} / ${dataToInsert.length.toLocaleString()} 筆（${Math.round((uploadedCount / dataToInsert.length) * 100)}%）`
          });
        }
      }

      // After successful insert, ensure we only keep 500,000 most recent records
      setMessage({ type: 'success', text: '上傳完成，正在檢查資料池容量…' });
      await cleanupOldRecords();

      setMessage({ type: 'success', text: `已成功上傳 ${dataToInsert.length.toLocaleString()} 筆資料，資料池目前共有 ${(activeCount + inactiveCount + dataToInsert.length).toLocaleString()} 筆。` });
      setBulkText('');
      setShowAddModal(false);
      setCurrentPage(1);
      if (currentPage === 1) void loadValidDataRef.current?.();
      loadStatistics();
    } catch (error: unknown) {
      setMessage(null);
      setAddError((error as { code?: string })?.code === '23505'
        ? '部分資料與現有記錄衝突，請檢查後再上傳。'
        : '批次上傳失敗，請稍後再試。');
    } finally {
      setUploading(false);
      setUploadProgress({ current: 0, total: 0 });
    }
  };

  const cleanupOldRecords = async () => {
    try {
      // Get total count
      const { count } = await supabase
        .from('valid_order_data')
        .select('*', { count: 'exact', head: true });

      if (!count || count <= 500000) return;

      // Get the IDs of records to keep (500,000 most recent)
      const { data: recordsToKeep } = await supabase
        .from('valid_order_data')
        .select('id')
        .order('created_at', { ascending: false })
        .limit(500000);

      if (!recordsToKeep) return;

      const idsToKeep = new Set(recordsToKeep.map(r => r.id));

      // Get all IDs to delete
      const { data: allRecords } = await supabase
        .from('valid_order_data')
        .select('id');

      if (!allRecords) return;

      const idsToDelete = allRecords
        .filter(r => !idsToKeep.has(r.id))
        .map(r => r.id);

      if (idsToDelete.length === 0) return;

      // Delete old records in batches
      const batchSize = 1000;
      for (let i = 0; i < idsToDelete.length; i += batchSize) {
        const batch = idsToDelete.slice(i, i + batchSize);
        const { error } = await supabase
          .from('valid_order_data')
          .delete()
          .in('id', batch);

        if (error) throw error;
      }

      console.log(`Cleanup completed: Deleted ${idsToDelete.length} old records, kept ${idsToKeep.size} recent records`);
    } catch (error: unknown) {
      console.error('Error cleaning up old records:', formatSupabaseError(error));
      // Don't throw - this is a cleanup operation and shouldn't fail the upload
    }
  };

  const handleToggleActive = async (id: string, currentStatus: boolean) => {
    try {
      // Optimistic update - update local state immediately
      const newStatus = !currentStatus;
      setValidData(prevData =>
        prevData.map(item =>
          item.id === id
            ? { ...item, is_active: newStatus, updated_at: new Date().toISOString() }
            : item
        )
      );

      // Update statistics optimistically
      if (newStatus) {
        setActiveCount(prev => prev + 1);
        setInactiveCount(prev => Math.max(0, prev - 1));
      } else {
        setActiveCount(prev => Math.max(0, prev - 1));
        setInactiveCount(prev => prev + 1);
      }

      const { error } = await supabase
        .from('valid_order_data')
        .update({
          is_active: newStatus,
          deactivated_at: newStatus ? null : new Date().toISOString(),
          deactivation_reason: newStatus ? null : 'manual',
          updated_at: new Date().toISOString(),
        })
        .eq('id', id);

      if (error) throw error;

      setMessage({ type: 'success', text: '資料狀態更新成功。' });
    } catch {
      setMessage({ type: 'error', text: '資料狀態更新失敗，請稍後再試。' });
      // Revert on error
      void loadValidDataRef.current?.();
      loadStatistics();
    }
  };

  const handlePageInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPageInput(e.target.value);
  };

  const handlePageInputSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const pageNum = Number(pageInput);
    if (Number.isInteger(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
      setCurrentPage(pageNum);
      setPageInput('');
    } else {
      setMessage({ type: 'error', text: `請輸入 1 至 ${totalPages} 之間的有效頁碼。` });
    }
  };


  const handleDelete = async (id: string) => {
    try {
      // Find the item being deleted to update statistics
      const itemToDelete = validData.find(item => item.id === id);

      // Optimistic update - remove from local state immediately
      setValidData(prevData => prevData.filter(item => item.id !== id));
      setTotalCount(prev => Math.max(0, prev - 1));

      // Update statistics optimistically
      if (itemToDelete) {
        if (itemToDelete.is_active) {
          setActiveCount(prev => Math.max(0, prev - 1));
        } else {
          setInactiveCount(prev => Math.max(0, prev - 1));
        }
      }

      const { error } = await supabase.from('valid_order_data').delete().eq('id', id);

      if (error) throw error;

      setMessage({ type: 'success', text: '資料刪除成功。' });
      setDeletingId(null);
    } catch {
      setMessage({ type: 'error', text: '刪除資料失敗，請稍後再試。' });
      // Revert on error
      void loadValidDataRef.current?.();
      loadStatistics();
    }
  };

  const totalPages = Math.ceil(totalCount / itemsPerPage);

  const handleDeleteAll = async () => {
    if (confirmText !== '刪除全部資料') {
      setMessage({ type: 'error', text: '請輸入「刪除全部資料」以確認操作。' });
      return;
    }

    setDeleting(true);
    setMessage(null);
    setShowDeleteAllModal(false);

    try {
      console.log('[Delete All] Starting deletion process...');

      // Get total count first
      const { count: totalToDelete, error: countError } = await supabase
        .from('valid_order_data')
        .select('*', { count: 'exact', head: true });

      if (countError) throw countError;

      console.log('[Delete All] Total records to delete:', totalToDelete);

      if (!totalToDelete || totalToDelete === 0) {
        setMessage({ type: 'error', text: '沒有可刪除的資料。' });
        setDeleting(false);
        setDeleteProgress({ current: 0, total: 0, percentage: 0 });
        return;
      }

      const BATCH_SIZE = 1000; // Delete 1000 records at a time
      const LARGE_BATCH_THRESHOLD = 5000; // Use batch delete for > 5K records

      // For small datasets, use single delete
      if (totalToDelete <= LARGE_BATCH_THRESHOLD) {
        setDeleteProgress({ current: 0, total: totalToDelete, percentage: 0 });

        const { error: deleteError } = await supabase
          .from('valid_order_data')
          .delete()
          .neq('id', '00000000-0000-0000-0000-000000000000'); // Delete all

        if (deleteError) throw deleteError;

        setDeleteProgress({ current: totalToDelete, total: totalToDelete, percentage: 100 });
        console.log(`[Delete All] Deleted ${totalToDelete} records in single operation`);
      } else {
        // For large datasets, use batch deletion
        console.log(`[Delete All] Using batch deletion (${BATCH_SIZE} per batch)`);

        let totalDeleted = 0;
        let hasMore = true;
        let batchCount = 0;

        while (hasMore && totalDeleted < totalToDelete) {
          batchCount++;
          console.log(`[Delete All] Processing batch ${batchCount}...`);

          // Call database function to delete a batch
          const { data, error: rpcError } = await supabase.rpc('batch_delete_valid_order_data', {
            p_batch_size: BATCH_SIZE
          });

          if (rpcError) {
            console.error(`[Delete All] Batch ${batchCount} RPC error:`, rpcError);
            throw rpcError;
          }

          const deletedCount = data || 0;
          totalDeleted += deletedCount;

          const percentage = Math.min(100, Math.round((totalDeleted / totalToDelete) * 100));

          setDeleteProgress({
            current: totalDeleted,
            total: totalToDelete,
            percentage
          });

          console.log(`[Delete All] Batch ${batchCount}: Deleted ${deletedCount} records. Total: ${totalDeleted}/${totalToDelete} (${percentage}%)`);

          // If we deleted less than BATCH_SIZE, we're done
          if (deletedCount < BATCH_SIZE) {
            hasMore = false;
            console.log(`[Delete All] Last batch completed (${deletedCount} < ${BATCH_SIZE})`);
          }

          // Small delay between batches to avoid overwhelming the database
          if (hasMore) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        console.log(`[Delete All] Completed deletion of ${totalDeleted} records in ${batchCount} batches`);
      }

      setMessage({
        type: 'success',
        text: `已刪除全部 ${totalToDelete.toLocaleString()} 筆有效資料。`
      });
      setConfirmText('');

      // Reset to first page and reload data
      setCurrentPage(1);
      setTimeout(async () => {
        await void loadValidDataRef.current?.();
        await loadStatistics();
        setDeleting(false);
        setDeleteProgress({ current: 0, total: 0, percentage: 0 });
      }, 500);
    } catch (error: unknown) {
      console.error('[Delete All] Error:', formatSupabaseError(error));
      setMessage({
        type: 'error',
        text: '刪除資料失敗，請稍後再試。'
      });
      setDeleting(false);
      setDeleteProgress({ current: 0, total: 0, percentage: 0 });
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top_left,rgba(14,116,144,0.12),transparent_42%),linear-gradient(160deg,#0b1729,#08111f_65%,#0c1726)] text-slate-100">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cyan-400/20 bg-slate-900/65 px-3 py-2 sm:px-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-300/25 bg-cyan-400/10 text-cyan-300"><Database className="h-4 w-4" /></span>
          <div>
            <h2 className="text-sm font-semibold tracking-wide text-white">有效資料</h2>
            <p className="text-[10px] text-slate-400">資料池與記錄管理</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(activeCount + inactiveCount) > 0 && (
            <button
              onClick={() => {
                console.log('[Delete All] Button clicked, opening modal...');
                setShowDeleteAllModal(true);
              }}
              disabled={deleting}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-red-400/30 bg-red-500/10 px-3 text-xs font-semibold text-red-200 transition-colors hover:bg-red-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              {deleting ? '刪除中…' : '刪除全部'}
            </button>
          )}
          <button
            onClick={() => {
              setMessage(null);
              setAddError(null);
              setFormData({ productValue: '', transactionId: '' });
              setBulkText('');
              setAddMode('single');
              setShowAddModal(true);
            }}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 px-3 text-xs font-semibold text-white shadow-sm shadow-cyan-950/40 transition-colors hover:from-blue-500 hover:to-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
          >
            <Plus className="h-3.5 w-3.5" />
            新增資料
          </button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {message && (
          <div className={`shrink-0 border-b px-3 py-2 text-xs flex items-start justify-between sm:px-5 ${message.type === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-red-500/30 bg-red-500/10 text-red-300'}`}>
            <span className="flex-1">{message.text}</span>
            <button
              onClick={() => setMessage(null)}
              aria-label="關閉通知"
              className="ml-3 text-white/60 hover:text-white transition-colors"
            >
              ×
            </button>
          </div>
        )}

        <div className="grid shrink-0 grid-cols-2 border-b border-cyan-400/25 bg-slate-900/35 sm:grid-cols-3">
          <div className="col-span-2 border-b border-cyan-300/30 bg-gradient-to-br from-blue-600/35 via-cyan-500/20 to-slate-900/60 px-3 py-2.5 sm:col-span-1 sm:border-b-0 sm:border-r sm:px-5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-cyan-100">
              <Database className="h-3.5 w-3.5" /> 資料池總量
            </div>
            <div className="mt-0.5 flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="text-2xl font-bold tabular-nums text-white">{(activeCount + inactiveCount).toLocaleString()}</span>
              <span className="text-xs text-cyan-100/85">/ 500,000</span>
            </div>
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-950/60">
              <div
                className={`h-full rounded-full ${
                  (activeCount + inactiveCount) >= 500000 ? 'bg-red-400' :
                  (activeCount + inactiveCount) >= 450000 ? 'bg-amber-400' :
                  'bg-cyan-400'
                }`}
                style={{ width: `${Math.min(((activeCount + inactiveCount) / 500000) * 100, 100)}%` }}
              />
            </div>
            <p className="mt-1 truncate text-[10px] text-cyan-100/85">
              {(activeCount + inactiveCount) >= 500000 ? '資料池已滿，新資料將取代最舊記錄' :
                (activeCount + inactiveCount) >= 450000 ? `資料池已使用 ${Math.round(((activeCount + inactiveCount) / 500000) * 100)}%，即將達到上限` :
                `資料池尚可新增 ${(500000 - (activeCount + inactiveCount)).toLocaleString()} 筆`}
            </p>
          </div>
          <div className="border-r border-emerald-300/30 bg-gradient-to-br from-emerald-600/35 via-teal-500/20 to-slate-900/60 px-3 py-2.5 sm:px-5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-100">
              <CheckCircle className="h-3.5 w-3.5" /> 已啟用記錄
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums text-white">{activeCount.toLocaleString()}</div>
            <div className="mt-1 text-[10px] text-emerald-100/85">可用於比對</div>
          </div>
          <div className="bg-gradient-to-br from-amber-600/30 via-orange-500/15 to-slate-900/60 px-3 py-2.5 sm:px-5">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-100">
              <XCircle className="h-3.5 w-3.5" /> 已停用記錄
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums text-white">{inactiveCount.toLocaleString()}</div>
            <div className="mt-1 text-[10px] text-amber-100/85">目前未使用</div>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative z-30 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-cyan-400/15 bg-slate-900/45 px-3 py-2 sm:px-5">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-cyan-300" />
              <span className="text-xs font-semibold text-white">資料記錄</span>
              <span className="rounded-md bg-cyan-400/10 px-1.5 py-0.5 text-[10px] tabular-nums text-cyan-200">{totalCount.toLocaleString()}</span>
            </div>
            <div ref={statusFilterRef} className="relative flex items-center gap-2" onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setStatusFilterOpen(false);
            }}>
              <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">篩選</span>
              <button
                id="valid-data-status-filter"
                ref={statusFilterButtonRef}
                type="button"
                aria-label={`依狀態篩選資料：${statusFilter === 'active' ? '僅顯示已啟用' : statusFilter === 'inactive' ? '僅顯示已停用' : '全部狀態'}`}
                aria-haspopup="listbox"
                aria-expanded={statusFilterOpen}
                disabled={loading}
                onClick={() => setStatusFilterOpen((open) => !open)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    setStatusFilterOpen(true);
                    requestAnimationFrame(() => statusFilterMenuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus());
                  }
                }}
                className={`group inline-flex h-8 min-w-[136px] items-center justify-between gap-2 rounded-lg border bg-gradient-to-r px-2.5 text-xs font-semibold shadow-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-wait disabled:opacity-60 ${statusFilterOpen ? 'border-cyan-300/70 from-cyan-500/25 to-blue-500/15 text-cyan-50' : 'border-cyan-400/30 from-slate-800 to-slate-900 text-slate-100 hover:border-cyan-300/60 hover:from-cyan-950 hover:to-slate-800'}`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusFilter === 'active' ? 'bg-emerald-400' : statusFilter === 'inactive' ? 'bg-slate-400' : 'bg-cyan-300'}`} />
                  <span>{statusFilter === 'active' ? '僅顯示已啟用' : statusFilter === 'inactive' ? '僅顯示已停用' : '全部狀態'}</span>
                </span>
                <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-cyan-300 transition-transform ${statusFilterOpen ? 'rotate-180' : ''}`} />
              </button>
              {statusFilterOpen && (
                <div
                  id="valid-data-status-options"
                  ref={statusFilterMenuRef}
                  role="listbox"
                  aria-label="資料狀態"
                  onKeyDown={(event) => {
                    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
                    const index = options.indexOf(document.activeElement as HTMLButtonElement);
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
                      event.preventDefault();
                      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                      options[next]?.focus();
                    }
                  }}
                  className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-cyan-300/30 bg-[#0b192c] p-1.5 shadow-[0_16px_40px_rgba(2,6,23,0.75)] ring-1 ring-white/5"
                >
                  <div aria-hidden="true" className="border-b border-cyan-400/15 px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-cyan-300/80">資料狀態</div>
                  {([
                    { value: 'all' as const, label: '全部狀態', description: '顯示所有記錄', count: activeCount + inactiveCount, Icon: Database, color: 'text-cyan-300' },
                    { value: 'active' as const, label: '僅顯示已啟用', description: '可用記錄', count: activeCount, Icon: CheckCircle, color: 'text-emerald-300' },
                    { value: 'inactive' as const, label: '僅顯示已停用', description: '不可用記錄', count: inactiveCount, Icon: XCircle, color: 'text-slate-300' },
                  ]).map(({ value, label, description, count, Icon, color }) => (
                    <button
                      key={value}
                      type="button"
                      role="option"
                      aria-selected={statusFilter === value}
                      onClick={() => {
                        setStatusFilter(value);
                        setCurrentPage(1);
                        setStatusFilterOpen(false);
                        statusFilterButtonRef.current?.focus();
                      }}
                      className={`mt-1 flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${statusFilter === value ? 'border-cyan-400/40 bg-cyan-400/15 text-white' : 'border-transparent text-slate-300 hover:border-cyan-400/20 hover:bg-white/5 hover:text-white'}`}
                    >
                      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/5 ${color}`}><Icon className="h-3.5 w-3.5" /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[11px] font-semibold">{label}</span>
                        <span className="block text-[10px] text-slate-400">{description}</span>
                      </span>
                      <span className="text-[11px] font-semibold tabular-nums text-slate-300">{count.toLocaleString()}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {validData.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center" aria-live="polite">
              {loading ? (
                <>
                  <span className="h-7 w-7 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-300" />
                  <span className="text-xs text-cyan-200">正在載入記錄…</span>
                </>
              ) : (
                <>
                  <FileSpreadsheet className="h-9 w-9 text-slate-500" />
                  <div className="text-sm text-slate-300">目前沒有有效資料</div>
                  <div className="text-xs text-slate-500">可使用上方按鈕新增資料</div>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="relative min-h-0 flex-1">
                <div ref={listScrollRef} className="h-full overflow-auto overscroll-contain dark-panel-scroll">
                  <table className="w-full min-w-[800px] table-fixed">
                    <thead className="sticky top-0 z-10 bg-slate-900/95 backdrop-blur-sm">
                      <tr className="border-b border-cyan-400/20 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                        <th className="w-14 px-3 py-2 text-left">#</th>
                        <th className="w-40 px-3 py-2 text-left">產品金額（{currencyUnit}）</th>
                        <th className="px-3 py-2 text-left">交易 ID</th>
                        <th className="w-28 px-3 py-2 text-left">狀態</th>
                        <th className="w-32 px-3 py-2 text-left">建立時間</th>
                        <th className="w-40 px-3 py-2 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validData.map((data, index) => (
                        <tr key={data.id} className="border-b border-slate-700/25 text-xs transition-colors hover:bg-cyan-400/5">
                          <td className="px-3 py-1.5 font-medium tabular-nums text-slate-500">
                            {(currentPage - 1) * itemsPerPage + index + 1}
                          </td>
                          <td className="px-3 py-1.5 font-semibold tabular-nums text-slate-100">${data.product_value.toFixed(2)}</td>
                          <td className="truncate px-3 py-1.5 font-mono text-[11px] text-cyan-100/85" title={data.transaction_id}>{data.transaction_id}</td>
                          <td className="px-3 py-1.5">
                            {data.is_active ? (
                              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                                <CheckCircle className="w-3 h-3" />
                                已啟用
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded-md bg-slate-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-slate-400">
                                <XCircle className="w-3 h-3" />
                                已停用
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 tabular-nums text-slate-400">
                            {new Date(data.created_at).toLocaleDateString('zh-TW')}
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => handleToggleActive(data.id, data.is_active)}
                                className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${
                                  data.is_active
                                    ? 'bg-amber-500/10 text-amber-400 hover:bg-amber-500/20'
                                    : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                                }`}
                              >
                                {data.is_active ? '停用' : '啟用'}
                              </button>
                              <button
                                onClick={() => setDeletingId(data.id)}
                                aria-label={`刪除記錄 ${data.transaction_id}`}
                                className="rounded-md p-1.5 text-red-400 transition-colors hover:bg-red-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {loading && (
                  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-slate-950/65 text-xs text-cyan-200" role="status">
                    <span className="h-7 w-7 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-300" />
                    正在載入記錄…
                  </div>
                )}
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-cyan-400/15 bg-slate-900/45 px-3 py-2 sm:px-5">
                  <div className="text-[11px] text-slate-400">
                    顯示第 {((currentPage - 1) * itemsPerPage) + 1} 至 {Math.min(currentPage * itemsPerPage, totalCount)} 筆，共 {totalCount} 筆
                    {statusFilter !== 'all' && <span className="text-slate-500">（已篩選）</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
                      disabled={loading || currentPage === 1}
                      className="rounded-md bg-slate-800 px-2 py-1 text-xs text-white transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      上一頁
                    </button>
                    <div className="flex items-center gap-1">
                      {Array.from({ length: totalPages }, (_, i) => i + 1)
                        .filter(page => {
                          // Show first page, last page, current page, and pages around current
                          return page === 1 ||
                                 page === totalPages ||
                                 (page >= currentPage - 1 && page <= currentPage + 1);
                        })
                        .map((page, idx, arr) => (
                          <div key={page} className="flex items-center">
                            {idx > 0 && arr[idx - 1] !== page - 1 && (
                              <span className="px-2 text-slate-500">...</span>
                            )}
                            <button
                              onClick={() => setCurrentPage(page)}
                              disabled={loading}
                              className={`rounded-md px-2 py-1 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${
                                currentPage === page
                                  ? 'bg-blue-600 text-white'
                                  : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                              }`}
                            >
                              {page}
                            </button>
                          </div>
                        ))}
                    </div>
                    <button
                      onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
                      disabled={loading || currentPage === totalPages}
                      className="rounded-md bg-slate-800 px-2 py-1 text-xs text-white transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      下一頁
                    </button>
                    <form onSubmit={handlePageInputSubmit} noValidate className="flex items-center gap-1.5 border-l border-slate-700 pl-2">
                      <span className="text-xs text-slate-400">跳至：</span>
                      <input
                        type="number"
                        min="1"
                        max={totalPages}
                        value={pageInput}
                        disabled={loading}
                        onChange={handlePageInputChange}
                        placeholder={`1-${totalPages}`}
                        className="w-16 rounded-md border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
                      />
                      <button
                        type="submit"
                        disabled={loading}
                        className="rounded-md bg-blue-600 px-2 py-1 text-xs font-semibold text-white transition-colors hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"
                      >
                        跳轉
                      </button>
                    </form>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showAddModal && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm sm:p-6"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !uploading && !addingSingle) setShowAddModal(false);
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="valid-data-add-title" className="flex h-[calc(100dvh-24px)] max-h-[820px] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-cyan-300/25 bg-[#0b192c] text-slate-100 shadow-[0_28px_80px_rgba(2,6,23,0.8)] sm:h-[calc(100dvh-48px)] sm:max-h-[860px]">
            <div className="h-1 shrink-0 bg-gradient-to-r from-blue-600 via-cyan-400 to-emerald-400" />
            <div className="flex shrink-0 items-start justify-between gap-4 border-b border-cyan-400/15 bg-gradient-to-r from-blue-500/10 via-cyan-500/5 to-transparent px-4 py-4 sm:px-6">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-400/10 text-cyan-200">
                  <Database className="h-5 w-5" />
                </div>
                <div>
                  <h2 id="valid-data-add-title" className="text-base font-semibold tracking-wide text-white">新增資料</h2>
                  <p className="mt-0.5 text-xs text-slate-400">新增記錄至有效資料池</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                disabled={uploading || addingSingle}
                aria-label="關閉新增資料視窗"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-cyan-400/15 px-4 py-3 sm:px-6">
              <button
                type="button"
                onClick={() => { setAddMode('single'); setAddError(null); }}
                disabled={uploading || addingSingle}
                aria-pressed={addMode === 'single'}
                className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${addMode === 'single' ? 'border-blue-400/60 bg-blue-500/20 text-blue-100' : 'border-slate-700 bg-slate-900/50 text-slate-400 hover:border-blue-400/30 hover:text-white'}`}
              >
                <Plus className="h-4 w-4" /> 單筆新增
              </button>
              <button
                type="button"
                onClick={() => { setAddMode('bulk'); setAddError(null); }}
                disabled={uploading || addingSingle}
                aria-pressed={addMode === 'bulk'}
                className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${addMode === 'bulk' ? 'border-cyan-400/60 bg-cyan-500/20 text-cyan-100' : 'border-slate-700 bg-slate-900/50 text-slate-400 hover:border-cyan-400/30 hover:text-white'}`}
              >
                <Upload className="h-4 w-4" /> 批量上傳
              </button>
            </div>
            <div className="valid-data-modal-scroll flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-5 [@media(max-height:560px)]:overflow-y-auto sm:px-6">
              {addError && (
                <div role="alert" className="relative mb-4 max-h-32 min-h-0 shrink-0 overflow-hidden rounded-lg border border-red-400/30 bg-red-500/10 text-xs text-red-200">
                  <div className="valid-data-modal-scroll max-h-32 overflow-y-auto whitespace-pre-wrap break-words py-2 pl-3 pr-12">{addError}</div>
                  <button
                    type="button"
                    onClick={() => setAddError(null)}
                    aria-label="關閉錯誤提示"
                    className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md border border-red-400/20 bg-[#251b2e] text-red-200 transition-colors hover:bg-red-500/20 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              )}
              {addMode === 'single' ? (
                <form id="valid-data-single-form" onSubmit={handleAddSingle} noValidate className="space-y-4">
                  <div>
                    <label htmlFor="valid-data-value" className="mb-1.5 block text-xs font-semibold text-slate-300">產品金額（{currencyUnit}）</label>
                    <input
                      id="valid-data-value"
                      type="number"
                      step="0.01"
                      value={formData.productValue}
                      onChange={(event) => setFormData({ ...formData, productValue: event.target.value })}
                      className="h-11 w-full rounded-lg border border-slate-600 bg-slate-100 px-3 text-sm text-slate-950 outline-none transition-colors focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
                      placeholder="0.00"
                      required
                      autoFocus
                    />
                  </div>
                  <div>
                    <label htmlFor="valid-data-transaction" className="mb-1.5 block text-xs font-semibold text-slate-300">交易 ID</label>
                    <input
                      id="valid-data-transaction"
                      type="text"
                      value={formData.transactionId}
                      onChange={(event) => setFormData({ ...formData, transactionId: event.target.value })}
                      className="h-11 w-full rounded-lg border border-slate-600 bg-slate-100 px-3 text-sm text-slate-950 outline-none transition-colors focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/30"
                      placeholder="請輸入交易 ID"
                      required
                    />
                  </div>
                  <p className="rounded-lg border border-blue-400/15 bg-blue-500/5 px-3 py-2 text-xs text-blue-200/80">新增後，資料會立即加入資料池。</p>
                </form>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col gap-4">
                  <div className="flex min-h-0 flex-1 flex-col">
                    <label htmlFor="valid-data-bulk" className="mb-1.5 block text-xs font-semibold text-slate-300">上傳資料</label>
                    <p className="mb-3 text-xs leading-relaxed text-slate-400">每行一筆資料，格式為「產品金額,交易 ID」，每次最多上傳 500,000 筆。</p>
                    <textarea
                      id="valid-data-bulk"
                      value={bulkText}
                      onChange={(event) => setBulkText(event.target.value)}
                      rows={12}
                      placeholder={'100.50,TXN12345678\n200.00,TXN87654321\n150.75,TXN11223344'}
                      className="valid-data-modal-scroll min-h-0 w-full flex-1 resize-none rounded-lg border border-slate-300 bg-slate-50 p-4 font-mono text-sm leading-6 text-slate-900 shadow-inner shadow-slate-900/5 outline-none transition-colors placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-500/25 [@media(max-height:560px)]:min-h-32"
                    />
                  </div>
                  <p className="rounded-lg border border-cyan-400/15 bg-cyan-500/5 px-3 py-2 text-xs leading-relaxed text-cyan-200/80">支援多次批量上傳，資料池最多保留 500,000 筆記錄。</p>
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-cyan-400/15 bg-slate-950/55 px-4 py-3 sm:px-6">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                disabled={uploading || addingSingle}
                className="h-9 rounded-lg border border-slate-600 px-4 text-xs font-semibold text-slate-300 transition-colors hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-50"
              >
                取消
              </button>
              {addMode === 'single' ? (
                <button
                  type="submit"
                  form="valid-data-single-form"
                  disabled={addingSingle}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-cyan-600 px-4 text-xs font-semibold text-white shadow-sm shadow-cyan-950/50 transition-colors hover:from-blue-500 hover:to-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-60"
                >
                  {addingSingle ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <Plus className="h-4 w-4" />}
                  {addingSingle ? '新增中…' : '新增記錄'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleBulkUpload}
                  disabled={uploading}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-cyan-600 to-teal-600 px-4 text-xs font-semibold text-white shadow-sm shadow-cyan-950/50 transition-colors hover:from-cyan-500 hover:to-teal-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-60"
                >
                  {uploading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <Upload className="h-4 w-4" />}
                  {uploading ? `上傳中${uploadProgress.current > 0 ? ` ${Math.round((uploadProgress.current / uploadProgress.total) * 100)}%` : '…'}` : '上傳批量資料'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showDeleteAllModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-gradient-to-br from-slate-900 to-slate-800 rounded-2xl border-2 border-red-500/50 shadow-2xl max-w-md w-full overflow-hidden">
            <div className="bg-gradient-to-r from-red-600/20 to-red-500/20 border-b border-red-500/30 p-6">
              <div className="flex items-center gap-3">
                <div className="p-3 bg-red-500/20 rounded-xl border border-red-500/30">
                  <AlertTriangle className="w-6 h-6 text-red-400" />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-white">刪除全部記錄</h3>
                  <p className="text-sm text-red-300 mt-0.5">此操作無法復原！</p>
                </div>
              </div>
            </div>

            <div className="p-6 space-y-4">
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
                <p className="text-slate-200 text-sm leading-relaxed">
                  即將永久刪除 <span className="text-red-400 font-bold text-lg">{(activeCount + inactiveCount).toLocaleString()}</span> 筆有效資料記錄。
                </p>
                <p className="text-slate-300 text-sm mt-2">
                  所有交易 ID 與產品金額資料都將從系統中移除。
                </p>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-300 mb-2">
                  請輸入 <span className="text-red-400 font-semibold">刪除全部資料</span> 以確認：
                </label>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  placeholder="刪除全部資料"
                  className="w-full px-4 py-3 bg-slate-900/80 border-2 border-slate-600 focus:border-red-500 rounded-lg text-white font-mono focus:outline-none focus:ring-2 focus:ring-red-500/50 transition-all"
                  disabled={deleting}
                  autoFocus
                />
                {message && message.type === 'error' && confirmText.length > 0 && confirmText !== '刪除全部資料' && (
                  <p className="text-red-400 text-xs mt-2">
                    請完整輸入「刪除全部資料」。
                  </p>
                )}
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => {
                    setShowDeleteAllModal(false);
                    setConfirmText('');
                    setMessage(null);
                  }}
                  disabled={deleting}
                  className="flex-1 px-4 py-3 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  取消
                </button>
                <button
                  onClick={handleDeleteAll}
                  disabled={deleting || confirmText !== '刪除全部資料'}
                  className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-500 text-white rounded-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {deleting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                      刪除中…
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-4 h-4" />
                      刪除全部
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {deletingId && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div role="alertdialog" aria-modal="true" aria-labelledby="valid-data-delete-title" aria-describedby="valid-data-delete-description" className="w-full max-w-md overflow-hidden rounded-2xl border border-rose-300/25 bg-[#0b192c] text-slate-100 shadow-[0_28px_80px_rgba(2,6,23,0.8)]">
            <div className="h-1 bg-gradient-to-r from-cyan-500 via-amber-400 to-rose-500" />
            <div className="flex items-start justify-between gap-4 border-b border-rose-400/15 bg-gradient-to-r from-rose-500/15 via-amber-500/5 to-transparent px-5 py-5 sm:px-6">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-rose-400/30 bg-rose-500/15 text-rose-200">
                  <Trash2 className="h-5 w-5" />
                </div>
                <div>
                  <h3 id="valid-data-delete-title" className="text-base font-semibold text-white">確認刪除</h3>
                  <p className="mt-1 text-xs text-rose-200/85">從資料池中移除一筆記錄</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDeletingId(null)}
                aria-label="關閉刪除確認視窗"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 py-5 sm:px-6">
              <p id="valid-data-delete-description" className="text-sm leading-relaxed text-slate-200">
                確定要刪除這筆有效資料嗎？
              </p>
              <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-rose-400/25 bg-rose-500/10 px-3.5 py-3 text-xs leading-relaxed text-rose-100">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                此操作無法復原。
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-cyan-400/15 bg-slate-950/45 px-5 py-4 sm:px-6">
              <button
                type="button"
                onClick={() => setDeletingId(null)}
                autoFocus
                className="h-10 min-w-24 rounded-lg border border-slate-600 bg-slate-800/60 px-4 text-xs font-semibold text-slate-200 transition-colors hover:border-slate-500 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => handleDelete(deletingId)}
                className="inline-flex h-10 min-w-28 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-rose-600 to-red-600 px-4 text-xs font-semibold text-white shadow-sm shadow-rose-950/40 transition-colors hover:from-rose-500 hover:to-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
              >
                <Trash2 className="h-4 w-4" />
                刪除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Progress Modal */}
      {deleting && deleteProgress.total > 0 && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-[60] p-4">
          <div className="bg-gradient-to-br from-slate-900 to-slate-800 border-2 border-red-500/50 rounded-2xl p-8 max-w-md w-full shadow-2xl">
            <div className="flex items-center gap-4 mb-6">
              <div className="w-14 h-14 bg-red-500/20 rounded-full flex items-center justify-center animate-pulse">
                <Trash2 className="w-7 h-7 text-red-500" />
              </div>
              <div>
                <h3 className="text-xl font-bold text-white">正在刪除記錄…</h3>
                <p className="text-sm text-slate-400 mt-1">請稍候，這可能需要一些時間</p>
              </div>
            </div>

            <div className="space-y-4">
              <div className="bg-slate-700/50 backdrop-blur-sm rounded-xl p-4 border border-slate-600">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-sm font-medium text-slate-300">進度</span>
                  <span className="text-lg font-bold text-red-400">{deleteProgress.percentage}%</span>
                </div>

                {/* Progress Bar */}
                <div className="relative w-full h-3 bg-slate-800/80 rounded-full overflow-hidden border border-slate-600">
                  <div
                    className="absolute inset-y-0 left-0 bg-gradient-to-r from-red-500 to-red-600 transition-all duration-300 ease-out rounded-full"
                    style={{ width: `${deleteProgress.percentage}%` }}
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer"></div>
                  </div>
                </div>

                <div className="flex justify-between items-center mt-3">
                  <span className="text-xs text-slate-400">
                    已刪除：<span className="font-semibold text-white">{deleteProgress.current.toLocaleString()}</span>
                  </span>
                  <span className="text-xs text-slate-400">
                    總數：<span className="font-semibold text-white">{deleteProgress.total.toLocaleString()}</span>
                  </span>
                </div>
              </div>

              <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
                <p className="text-xs text-blue-300 text-center">
                  請勿關閉此視窗或重新整理頁面
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
