import { useState, useEffect, useRef } from 'react';
import { CheckCircle, XCircle, Clock, User, Wallet, Phone, Mail, Trash2, RotateCcw, AlertCircle, Eye, FileText, Image as ImageIcon, Shield, Search, Users, X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { formatSupabaseError, supabase } from '../../lib/supabase';
import { VerificationRequest, Employee, Admin } from '../../types';
import { getAdminFinancialSessionToken } from '../../lib/auth';

interface VerificationWithEmployee extends VerificationRequest {
  employee?: Employee;
}

interface VerificationReviewProps {
  admin: Admin;
}

type ViewMode = 'all' | 'requests' | 'verified' | 'rejected';
type SelectedAdminId = 'all' | string;

interface ImagePreview {
  images: { url: string; label: string }[];
  currentIndex: number;
  scale: number;
}

interface VerificationDetailPanel {
  employee: Employee;
  verification?: VerificationWithEmployee;
}

export default function VerificationReview({ admin }: VerificationReviewProps) {
  const [verifications, setVerifications] = useState<VerificationWithEmployee[]>([]);
  const [verifiedEmployees, setVerifiedEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [reviewAction, setReviewAction] = useState<'approved' | 'rejected' | null>(null);
  const [auditRemark, setAuditRemark] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('all');
  const [selectedAdminId, setSelectedAdminId] = useState<SelectedAdminId>(admin.role === 'super_admin' ? 'all' : admin.id);
  const [detailPanel, setDetailPanel] = useState<VerificationDetailPanel | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [walletBalances, setWalletBalances] = useState<Map<string, number>>(new Map());
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    confirmText: string;
    confirmColor: 'red' | 'amber';
  } | null>(null);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [imageLoading, setImageLoading] = useState(false);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());
  const loadVerificationsRef = useRef<(() => Promise<void>) | null>(null);
  const loadVerifiedEmployeesRef = useRef<(() => Promise<void>) | null>(null);
  const loadAdminsRef = useRef<(() => Promise<void>) | null>(null);
  const nextImageRef = useRef<(() => void) | null>(null);
  const prevImageRef = useRef<(() => void) | null>(null);
  const zoomInRef = useRef<(() => void) | null>(null);
  const zoomOutRef = useRef<(() => void) | null>(null);
  const resetZoomRef = useRef<(() => void) | null>(null);
  const isSuperAdmin = admin.role === 'super_admin';

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!imagePreview) return;

      if (e.key === 'Escape') {
        closeImagePreview();
      } else if (e.key === 'ArrowLeft' && imagePreview.currentIndex > 0) {
        prevImageRef.current?.();
      } else if (e.key === 'ArrowRight' && imagePreview.currentIndex < imagePreview.images.length - 1) {
        nextImageRef.current?.();
      } else if (e.key === '+' || e.key === '=') {
        zoomInRef.current?.();
      } else if (e.key === '-' || e.key === '_') {
        zoomOutRef.current?.();
      } else if (e.key === '0') {
        resetZoomRef.current?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [imagePreview]);

  useEffect(() => {
    void loadVerificationsRef.current?.();
    void loadVerifiedEmployeesRef.current?.();
    if (isSuperAdmin) {
      void loadAdminsRef.current?.();
    }

    // Set up real-time subscription for verification requests
    let verifyDebounce: ReturnType<typeof setTimeout> | null = null;
    const verificationChannel = supabase
      .channel('verification-changes')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'verification_requests' },
        (payload) => {
          if (payload.new) {
            setVerifications(prev => prev.map(v =>
              v.id === payload.new.id ? { ...v, ...payload.new } : v
            ));
            return;
          }
          if (verifyDebounce) clearTimeout(verifyDebounce);
          verifyDebounce = setTimeout(() => { void loadVerificationsRef.current?.(); }, 800);
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'verification_requests' },
        () => {
          if (verifyDebounce) clearTimeout(verifyDebounce);
          verifyDebounce = setTimeout(() => { void loadVerificationsRef.current?.(); }, 800);
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'verification_requests' },
        () => {
          if (verifyDebounce) clearTimeout(verifyDebounce);
          verifyDebounce = setTimeout(() => { void loadVerificationsRef.current?.(); }, 800);
        }
      )
      .subscribe();

    // Set up real-time subscription for user verification status changes
    let userDebounce: ReturnType<typeof setTimeout> | null = null;
    const userChannel = supabase
      .channel('user-verification-changes')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'users', filter: 'is_verified=eq.true' },
        () => {
          if (userDebounce) clearTimeout(userDebounce);
          userDebounce = setTimeout(() => { void loadVerifiedEmployeesRef.current?.(); }, 800);
        }
      )
      .subscribe();

    // Set up real-time subscription for wallet balance changes
    const walletChannel = supabase
      .channel('wallet-balance-changes')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'wallets' },
        (payload) => {
          console.log('Wallet balance change detected:', payload);
          // Update the balance in the map
          if (payload.new && payload.new.user_id) {
            setWalletBalances(prev => {
              const newMap = new Map(prev);
              newMap.set(payload.new.user_id, Number(payload.new.available_balance) || 0);
              return newMap;
            });
          }
        }
      )
      .subscribe();

    return () => {
      if (verifyDebounce) clearTimeout(verifyDebounce);
      if (userDebounce) clearTimeout(userDebounce);
      supabase.removeChannel(verificationChannel);
      supabase.removeChannel(userChannel);
      supabase.removeChannel(walletChannel);
    };
  }, [isSuperAdmin]);

  const loadVerifications = async () => {
    try {
      console.log('Loading verifications for admin:', admin.id, 'role:', admin.role);

      // Test query to verify connection
      const { data: testData, error: testError } = await supabase
        .from('verification_requests')
        .select('count');
      console.log('Test query - count:', testData, 'error:', testError);

      let employeeIds: string[] = [];

      if (admin.role === 'secondary_admin') {
        const { data: employees } = await supabase
          .from('users')
          .select('id')
          .eq('created_by', admin.id);
        employeeIds = employees?.map((e) => e.id) || [];
        console.log('Secondary admin employee IDs:', employeeIds);
      }

      let query = supabase
        .from('verification_requests')
        .select('*')
        .order('created_at', { ascending: false });

      if (admin.role === 'secondary_admin' && employeeIds.length > 0) {
        query = query.in('user_id', employeeIds);
      }

      const { data: verificationsData, error: verificationsError } = await query;
      console.log('Loaded verifications:', verificationsData);
      console.log('Verifications error:', verificationsError);
      console.log('Verifications count:', verificationsData?.length);
      if (verificationsError) {
        console.error('Error fetching verifications:', verificationsError);
        throw verificationsError;
      }

      const { data: employees } = await supabase.from('users').select('id, username, employee_id, is_verified, is_active, total_income, first_success_order_date, created_by, remarks, tags, is_pinned, current_session_token, session_created_at, last_heartbeat_at, current_tab_id, created_at, updated_at');
      const employeeMap = new Map(employees?.map((e) => [e.id, e]));

      const verificationsWithEmployees = verificationsData?.map((v) => ({
        ...v,
        employee: employeeMap.get(v.user_id),
      })) || [];

      // Sort: pending first, then by created_at descending
      verificationsWithEmployees.sort((a, b) => {
        if (a.status === 'pending' && b.status !== 'pending') return -1;
        if (a.status !== 'pending' && b.status === 'pending') return 1;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      setVerifications(verificationsWithEmployees);
      setError(null);
    } catch (error: unknown) {
      console.error('Error loading verifications:', formatSupabaseError(error));
      setError(formatSupabaseError(error) || '載入驗證資料失敗');
    } finally {
      setLoading(false);
    }
  };
  loadVerificationsRef.current = loadVerifications;

  const loadVerifiedEmployees = async () => {
    try {
      console.log('Loading verified employees...');

      let query = supabase
        .from('users')
        .select('id, username, employee_id, is_verified, is_active, total_income, first_success_order_date, created_by, remarks, tags, is_pinned, current_session_token, session_created_at, last_heartbeat_at, current_tab_id, created_at, updated_at')
        .eq('is_verified', true)
        .order('created_at', { ascending: false });

      if (admin.role === 'secondary_admin') {
        query = query.eq('created_by', admin.id);
      }

      const { data, error } = await query;
      if (error) throw error;

      console.log('Verified employees loaded:', data);
      setVerifiedEmployees(data || []);

      // Load wallet balances for verified employees
      if (data && data.length > 0) {
        const userIds = data.map(e => e.id);

        // Load wallet balances
        const { data: walletsData, error: walletsError } = await supabase
          .from('wallets')
          .select('user_id, available_balance')
          .in('user_id', userIds);

        if (!walletsError && walletsData) {
          const balanceMap = new Map<string, number>();
          walletsData.forEach(wallet => {
            balanceMap.set(wallet.user_id, Number(wallet.available_balance) || 0);
          });
          setWalletBalances(balanceMap);
          console.log('Wallet balances loaded:', balanceMap);
        }

        // Also reload verifications to ensure we have the verification details
        const { data: verificationData, error: verificationError } = await supabase
          .from('verification_requests')
          .select('*')
          .in('user_id', userIds)
          .eq('status', 'approved');

        console.log('Verification details loaded:', verificationData);
        if (!verificationError && verificationData) {
          // Merge with existing verifications to avoid losing pending requests
          setVerifications(prev => {
            const newVerifications = [...prev];
            verificationData.forEach(v => {
              const index = newVerifications.findIndex(nv => nv.id === v.id);
              if (index === -1) {
                newVerifications.push(v);
              }
            });
            return newVerifications;
          });
        }
      }
    } catch (error: unknown) {
      console.error('Error loading verified employees:', formatSupabaseError(error));
    }
  };
  loadVerifiedEmployeesRef.current = loadVerifiedEmployees;

  const loadAdmins = async () => {
    try {
      const { data, error } = await supabase
        .from('admins')
        .select('id, username, role, parent_id, is_active, is_pinned, created_at, updated_at')
        .eq('is_active', true)
        .order('username', { ascending: true });

      if (error) throw error;
      setAdmins(data || []);
      console.log('Admins loaded:', data);
    } catch (error: unknown) {
      console.error('Error loading admins:', formatSupabaseError(error));
    }
  };
  loadAdminsRef.current = loadAdmins;

  const handleReview = async (verificationId: string, status: 'approved' | 'rejected') => {
    if (status === 'rejected' && !auditRemark.trim()) {
      setValidationError('請填寫拒絕原因，並說明需要補充的證件資料');
      return;
    }

    // Clear any previous errors
    setValidationError(null);

    try {
      const verification = verifications.find((v) => v.id === verificationId);
      if (!verification) {
        console.error('Verification not found:', verificationId);
        return;
      }

      console.log('Reviewing verification:', {
        verificationId,
        status,
        auditRemark,
        adminId: admin.id,
      });

      const updateData = {
        status,
        audit_remark: auditRemark || null,
        audited_by: admin.id,
        audited_at: new Date().toISOString(),
      };

      console.log('Updating with data:', updateData);

      const { data: updateResult, error: updateError } = await supabase
        .from('verification_requests')
        .update(updateData)
        .eq('id', verificationId)
        .select();

      console.log('Update result:', { updateResult, updateError });

      if (updateError) {
        console.error('Update error details:', updateError);
        throw updateError;
      }

      if (status === 'approved') {
        console.log('Updating user verification status for user:', verification.user_id);
        const { error: userError } = await supabase.rpc('admin_update_employee_account', {
          p_admin_session_token: getAdminFinancialSessionToken(),
          p_user_id: verification.user_id,
          p_updates: { is_verified: true },
        });

        if (userError) {
          console.error('User update error:', userError);
          throw userError;
        }
      }

      console.log('Review completed successfully');

      // Update local state immediately for instant feedback
      setVerifications((prev) =>
        prev.map((v) =>
          v.id === verificationId
            ? {
                ...v,
                status: status as 'pending' | 'approved' | 'rejected',
                audit_remark: auditRemark || null,
                audited_by: admin.id,
                audited_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              }
            : v
        )
      );

      setReviewing(null);
      setReviewAction(null);
      setAuditRemark('');
      setValidationError(null);

      // Reload from server to ensure consistency
      console.log('Reloading verifications from server...');
      await loadVerifications();

      // If approved, also reload verified employees list
      if (status === 'approved') {
        console.log('Reloading verified employees...');
        await loadVerifiedEmployees();
      }
      console.log('Verifications reloaded');
    } catch (error) {
      console.error('Error reviewing verification:', error);
      setError(`驗證審核失敗：${error instanceof Error ? error.message : '未知錯誤'}`);
    }
  };

  const handleDelete = async (verificationId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: '刪除驗證申請',
      message: '確定要刪除此驗證申請嗎？此操作無法復原。',
      confirmText: '刪除',
      confirmColor: 'red',
      onConfirm: async () => {
        setConfirmDialog(null);
        setDeleting(verificationId);
        try {
          const { error } = await supabase
            .from('verification_requests')
            .delete()
            .eq('id', verificationId);

          if (error) throw error;

          // Update local state immediately
          setVerifications((prev) => prev.filter((v) => v.id !== verificationId));

          // Reload from server to ensure consistency
          await loadVerifications();
        } catch (error) {
          console.error('Error deleting verification:', error);
          setError('刪除驗證申請失敗');
        } finally {
          setDeleting(null);
        }
      }
    });
  };

  const handleReset = async (verificationId: string) => {
    setConfirmDialog({
      isOpen: true,
      title: '重設驗證申請',
      message: '確定要將此驗證申請重設為待審核嗎？員工將可重新提交資料。',
      confirmText: '重設為待審核',
      confirmColor: 'amber',
      onConfirm: async () => {
        setConfirmDialog(null);
        setResetting(verificationId);
        try {
          const verification = verifications.find((v) => v.id === verificationId);
          if (!verification) return;

          const { error: updateError } = await supabase
            .from('verification_requests')
            .update({
              status: 'pending',
              audit_remark: null,
              audited_by: null,
              audited_at: null,
            })
            .eq('id', verificationId);

          if (updateError) throw updateError;

          if (verification.status === 'approved') {
            const { error: userError } = await supabase.rpc('admin_update_employee_account', {
              p_admin_session_token: getAdminFinancialSessionToken(),
              p_user_id: verification.user_id,
              p_updates: { is_verified: false },
            });

            if (userError) throw userError;
          }

          // Update local state immediately
          setVerifications((prev) =>
            prev.map((v) =>
              v.id === verificationId
                ? {
                    ...v,
                    status: 'pending',
                    audit_remark: null,
                    audited_by: null,
                    audited_at: null,
                  }
                : v
            )
          );

          // Reload from server to ensure consistency
          await loadVerifications();
          if (verification.status === 'approved') {
            await loadVerifiedEmployees();
          }
        } catch (error) {
          console.error('Error resetting verification:', error);
          setError('重設驗證申請失敗');
        } finally {
          setResetting(null);
        }
      }
    });
  };

  const getStatusBadge = (status: string) => {
    const styles = {
      pending: 'border-amber-500/25 bg-amber-950/45 text-amber-200/90',
      approved: 'border-emerald-500/25 bg-emerald-950/45 text-emerald-200/90',
      rejected: 'border-rose-500/25 bg-rose-950/45 text-rose-200/90',
    };
    const labels = { pending: '待審核', approved: '已驗證', rejected: '已拒絕' };
    const icons = {
      pending: <Clock className="h-3.5 w-3.5" />,
      approved: <CheckCircle className="h-3.5 w-3.5" />,
      rejected: <XCircle className="h-3.5 w-3.5" />,
    };
    const typedStatus = status as keyof typeof styles;

    return (
      <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-black ${styles[typedStatus]}`}>
        {icons[typedStatus]}
        {labels[typedStatus]}
      </span>
    );
  };

  const adminOptions = Array.from(
    new Map([admin, ...admins].map(adminOption => [adminOption.id, adminOption])).values()
  )
    .filter(adminOption => adminOption.username.toLowerCase() !== 'emergency_admin')
    .sort((a, b) => {
      if (a.id === admin.id) return -1;
      if (b.id === admin.id) return 1;
      return a.username.localeCompare(b.username);
    });


  const employeeOwnerById = new Map<string, string>();
  verifiedEmployees.forEach(employee => employeeOwnerById.set(employee.id, employee.created_by));
  verifications.forEach(verification => {
    if (verification.employee?.created_by) {
      employeeOwnerById.set(verification.user_id, verification.employee.created_by);
    }
  });

  const getVerificationOwnerId = (verification: VerificationWithEmployee) =>
    verification.employee?.created_by || employeeOwnerById.get(verification.user_id) || '';

  const matchesVerificationSearch = (verification: VerificationWithEmployee) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    const employee = verification.employee || verifiedEmployees.find(item => item.id === verification.user_id);
    return [
      employee?.id,
      employee?.employee_id,
      employee?.username,
      verification.phone,
      verification.email,
      verification.wallet_address,
      verification.real_name,
    ].some(value => value?.toLowerCase().includes(query));
  };

  const matchesEmployeeSearch = (employee: Employee) => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return true;
    const verification = verifications.find(item => item.user_id === employee.id && item.status === 'approved');
    return [
      employee.id,
      employee.employee_id,
      employee.username,
      verification?.phone,
      verification?.email,
      verification?.wallet_address,
      verification?.real_name,
    ].some(value => value?.toLowerCase().includes(query));
  };

  const belongsToSelectedAdmin = (ownerId: string) =>
    !isSuperAdmin || selectedAdminId === 'all' || ownerId === selectedAdminId;

  const pendingVerifications = verifications.filter(item => item.status === 'pending');
  const rejectedVerifications = verifications.filter(item => item.status === 'rejected');
  const filteredVerifications = pendingVerifications.filter(item =>
    belongsToSelectedAdmin(getVerificationOwnerId(item)) && matchesVerificationSearch(item)
  );
  const filteredRejectedVerifications = rejectedVerifications.filter(item =>
    belongsToSelectedAdmin(getVerificationOwnerId(item)) && matchesVerificationSearch(item)
  );
  const filteredVerifiedEmployees = verifiedEmployees.filter(item =>
    belongsToSelectedAdmin(item.created_by) && matchesEmployeeSearch(item)
  );

  const overallStats = {
    pending: pendingVerifications.length,
    approved: verifiedEmployees.length,
    rejected: rejectedVerifications.length,
  };

  const getAdminStats = (adminId: string) => ({
    pending: pendingVerifications.filter(item => getVerificationOwnerId(item) === adminId).length,
    approved: verifiedEmployees.filter(item => item.created_by === adminId).length,
    rejected: rejectedVerifications.filter(item => getVerificationOwnerId(item) === adminId).length,
  });

  const selectedAdminName = selectedAdminId === 'all'
    ? '全部管理員'
    : adminOptions.find(item => item.id === selectedAdminId)?.username || admin.username;
  const selectedGroupStats = selectedAdminId === 'all' ? overallStats : getAdminStats(selectedAdminId);

  const allFilteredItems = [
    ...filteredVerifications.map(item => ({
      type: 'verification' as const,
      item,
      timestamp: new Date(item.created_at).getTime(),
    })),
    ...filteredVerifiedEmployees.map(item => {
      const verification = verifications.find(record => record.user_id === item.id && record.status === 'approved');
      return {
        type: 'employee' as const,
        item,
        timestamp: new Date(verification?.audited_at || verification?.created_at || item.created_at).getTime(),
      };
    }),
    ...filteredRejectedVerifications.map(item => ({
      type: 'verification' as const,
      item,
      timestamp: new Date(item.audited_at || item.created_at).getTime(),
    })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  const activeResultCount = viewMode === 'all'
    ? allFilteredItems.length
    : viewMode === 'requests'
      ? filteredVerifications.length
      : viewMode === 'verified'
        ? filteredVerifiedEmployees.length
        : filteredRejectedVerifications.length;

  const listHeaderTheme = viewMode === 'all'
    ? 'border-cyan-300/25 bg-[linear-gradient(90deg,rgba(8,47,73,0.98),rgba(15,23,42,0.98)_55%,rgba(8,47,73,0.92))] text-cyan-100'
    : viewMode === 'requests'
      ? 'border-amber-300/30 bg-[linear-gradient(90deg,rgba(120,53,15,0.96),rgba(30,41,59,0.98)_55%,rgba(120,53,15,0.88))] text-amber-100'
      : viewMode === 'verified'
        ? 'border-emerald-300/30 bg-[linear-gradient(90deg,rgba(6,78,59,0.96),rgba(30,41,59,0.98)_55%,rgba(6,78,59,0.88))] text-emerald-100'
        : 'border-rose-300/30 bg-[linear-gradient(90deg,rgba(136,19,55,0.94),rgba(30,41,59,0.98)_55%,rgba(136,19,55,0.86))] text-rose-100';

  const clearReviewDraft = () => {
    setReviewing(null);
    setReviewAction(null);
    setAuditRemark('');
    setValidationError(null);
  };

  const applyContextChange = (nextViewMode: ViewMode, nextAdminId: SelectedAdminId) => {
    clearReviewDraft();
    setDetailPanel(null);
    setViewMode(nextViewMode);
    setSelectedAdminId(nextAdminId);
  };

  const changeContext = (nextViewMode: ViewMode, nextAdminId: SelectedAdminId) => {
    if (reviewing && (reviewAction || auditRemark.trim())) {
      setConfirmDialog({
        isOpen: true,
        title: '放棄目前審核內容？',
        message: '切換狀態或管理員分組後，尚未提交的審核備註將被清除。',
        confirmText: '放棄並切換',
        confirmColor: 'amber',
        onConfirm: () => {
          setConfirmDialog(null);
          applyContextChange(nextViewMode, nextAdminId);
        },
      });
      return;
    }
    applyContextChange(nextViewMode, nextAdminId);
  };

  const getAdminName = (adminId: string) =>
    adminOptions.find(item => item.id === adminId)?.username || adminId;

  const openImagePreview = (verification: VerificationWithEmployee) => {
    const images: { url: string; label: string }[] = [];

    if (verification.id_front_url) {
      images.push({ url: verification.id_front_url, label: '身分證正面' });
    }
    if (verification.id_back_url) {
      images.push({ url: verification.id_back_url, label: '身分證背面' });
    }
    if (verification.selfie_url) {
      images.push({ url: verification.selfie_url, label: '本人自拍照' });
    }

    if (images.length > 0) {
      setImagePreview({ images, currentIndex: 0, scale: 1 });
      setPosition({ x: 0, y: 0 });
      setImageLoading(!loadedImages.has(images[0].url));
      document.body.style.overflow = 'hidden';
    }
  };

  const closeImagePreview = () => {
    setImagePreview(null);
    setPosition({ x: 0, y: 0 });
    setImageLoading(false);
    document.body.style.overflow = 'unset';
  };

  const handleImageLoad = (url: string) => {
    setLoadedImages(prev => new Set(prev).add(url));
    setImageLoading(false);
  };

  const nextImage = () => {
    if (imagePreview && imagePreview.currentIndex < imagePreview.images.length - 1) {
      const nextIndex = imagePreview.currentIndex + 1;
      const nextUrl = imagePreview.images[nextIndex].url;
      setImagePreview({ ...imagePreview, currentIndex: nextIndex });
      setPosition({ x: 0, y: 0 });
      setImageLoading(!loadedImages.has(nextUrl));
    }
  };

  const prevImage = () => {
    if (imagePreview && imagePreview.currentIndex > 0) {
      const prevIndex = imagePreview.currentIndex - 1;
      const prevUrl = imagePreview.images[prevIndex].url;
      setImagePreview({ ...imagePreview, currentIndex: prevIndex });
      setPosition({ x: 0, y: 0 });
      setImageLoading(!loadedImages.has(prevUrl));
    }
  };

  const zoomIn = () => {
    if (imagePreview && imagePreview.scale < 3) {
      setImagePreview({ ...imagePreview, scale: imagePreview.scale + 0.25 });
    }
  };

  const zoomOut = () => {
    if (imagePreview && imagePreview.scale > 0.5) {
      setImagePreview({ ...imagePreview, scale: imagePreview.scale - 0.25 });
      if (imagePreview.scale <= 1) {
        setPosition({ x: 0, y: 0 });
      }
    }
  };

  const resetZoom = () => {
    if (imagePreview) {
      setImagePreview({ ...imagePreview, scale: 1 });
      setPosition({ x: 0, y: 0 });
    }
  };

  nextImageRef.current = nextImage;
  prevImageRef.current = prevImage;
  zoomInRef.current = zoomIn;
  zoomOutRef.current = zoomOut;
  resetZoomRef.current = resetZoom;

  const handleMouseDown = (e: React.MouseEvent) => {
    if (imagePreview && imagePreview.scale > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && imagePreview && imagePreview.scale > 1) {
      setPosition({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const openReviewModal = (verification: VerificationWithEmployee) => {
    clearReviewDraft();
    setDetailPanel(null);
    setReviewing(verification.id);
  };

  const openDetailPanel = (employee: Employee, verification?: VerificationWithEmployee) => {
    clearReviewDraft();
    setDetailPanel({ employee, verification });
  };

  const renderVerificationCard = (verification: VerificationWithEmployee) => {
    const employee = verification.employee || verifiedEmployees.find(item => item.id === verification.user_id);
    if (!employee) return null;

    const ownerId = getVerificationOwnerId(verification);
    const isPending = verification.status === 'pending';
    const rowTheme = isPending
      ? {
          surface: 'border-amber-500/15 border-l-amber-500/60 bg-[linear-gradient(90deg,rgba(120,53,15,0.16),rgba(30,41,59,0.96)_26%,rgba(15,23,42,0.98))] hover:border-amber-400/25',
          title: 'text-amber-100',
          label: 'text-amber-300/65',
          value: 'text-amber-50/90',
          secondary: 'text-amber-100/65',
          identity: 'text-amber-200/90',
          admin: 'border-amber-500/20 bg-amber-950/35 text-amber-200/80',
          time: 'text-amber-200/90',
          timeSecondary: 'text-amber-200/60',
          action: 'border-amber-500/20 bg-amber-950/30 text-amber-200 hover:bg-amber-900/35',
        }
      : {
          surface: 'border-rose-500/15 border-l-rose-500/60 bg-[linear-gradient(90deg,rgba(136,19,55,0.14),rgba(30,41,59,0.96)_26%,rgba(15,23,42,0.98))] hover:border-rose-400/25',
          title: 'text-rose-100',
          label: 'text-rose-300/65',
          value: 'text-rose-50/90',
          secondary: 'text-rose-100/65',
          identity: 'text-rose-200/90',
          admin: 'border-rose-500/20 bg-rose-950/35 text-rose-200/80',
          time: 'text-rose-200/90',
          timeSecondary: 'text-rose-200/60',
          action: 'border-rose-500/20 bg-rose-950/30 text-rose-200 hover:bg-rose-900/35',
        };

    return (
      <article key={verification.id} className={`overflow-hidden rounded-xl border border-l-[3px] shadow-sm shadow-black/20 transition-colors duration-150 lg:h-[74px] ${rowTheme.surface}`}>
        <div className="grid min-w-0 gap-2 px-3 py-2.5 sm:px-4 lg:grid-cols-[minmax(180px,1.25fr)_minmax(120px,0.8fr)_minmax(160px,1.1fr)_minmax(120px,0.7fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className={`truncate text-xs font-black ${rowTheme.title}`}>{employee.username}</span>
              {getStatusBadge(verification.status)}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] font-bold text-slate-300">
              <span className={`truncate ${rowTheme.identity}`}>{employee.employee_id}</span>
              {isSuperAdmin && ownerId && <span className={`inline-flex max-w-full items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-[10px] ${rowTheme.admin}`}><Users className="h-3 w-3 shrink-0" />{getAdminName(ownerId)}</span>}
            </div>
          </div>

          <div className="min-w-0">
            <p className={`text-[10px] font-black uppercase tracking-wider lg:hidden ${rowTheme.label}`}>身分資料</p>
            <p className={`truncate text-xs font-bold ${verification.real_name ? rowTheme.value : 'text-cyan-300'}`}>{verification.real_name || '未填寫真實姓名'}</p>
            <p className={`mt-0.5 truncate text-[11px] ${verification.phone ? rowTheme.secondary : 'font-bold text-cyan-300'}`}>{verification.phone || '未填寫電話'}</p>
          </div>

          <div className="min-w-0">
            <p className={`text-[10px] font-black uppercase tracking-wider lg:hidden ${rowTheme.label}`}>聯絡方式</p>
            <p className={`truncate text-xs font-semibold ${rowTheme.value}`} title={verification.email || ''}>{verification.email || '未填寫電子郵件'}</p>
            <p className={`mt-0.5 line-clamp-2 break-all font-mono text-[10px] leading-[13px] ${verification.wallet_address ? rowTheme.secondary : 'text-cyan-300'}`} title={verification.wallet_address || ''}>{verification.wallet_address || '未填寫錢包地址'}</p>
          </div>

          <div className="min-w-0">
            <p className={`text-[10px] font-black uppercase tracking-wider lg:hidden ${rowTheme.label}`}>提交時間</p>
            <p className={`truncate text-[9px] font-black ${rowTheme.time}`}>提交 {new Date(verification.created_at).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</p>
            <p className={`mt-1 truncate text-[9px] font-semibold ${rowTheme.timeSecondary}`}>{verification.audited_at ? `審核 ${new Date(verification.audited_at).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}` : '尚未審核'}</p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 lg:justify-end">
            <button type="button" onClick={() => openDetailPanel(employee, verification)} className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-[10px] font-black transition-colors ${rowTheme.action}`}>
              <Eye className="h-3.5 w-3.5" />查看資料
            </button>
            {isPending && (
              <button type="button" onClick={() => openReviewModal(verification)} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-800/70 px-2.5 text-[10px] font-black text-amber-50 transition-colors hover:bg-amber-700/80">
                <Shield className="h-3.5 w-3.5" />開始驗證
              </button>
            )}
          </div>
        </div>
      </article>
    );
  };

  const renderVerifiedEmployeeCard = (employee: Employee) => {
    const verification = verifications.find(item => item.user_id === employee.id && item.status === 'approved');

    return (
      <article key={employee.id} className="overflow-hidden rounded-xl border border-emerald-500/15 border-l-[3px] border-l-emerald-500/60 bg-[linear-gradient(90deg,rgba(6,78,59,0.14),rgba(30,41,59,0.96)_26%,rgba(15,23,42,0.98))] shadow-sm shadow-black/20 transition-colors duration-150 hover:border-emerald-400/25 lg:h-[74px]">
        <div className="grid min-w-0 gap-2 px-3 py-2.5 sm:px-4 lg:grid-cols-[minmax(180px,1.25fr)_minmax(120px,0.8fr)_minmax(160px,1.1fr)_minmax(120px,0.7fr)_auto] lg:items-center">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="truncate text-xs font-black text-emerald-50">{employee.username}</span>
              {getStatusBadge('approved')}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] font-bold text-slate-300">
              <span className="truncate text-emerald-200/90">{employee.employee_id}</span>
              {isSuperAdmin && <span className="inline-flex max-w-full items-center gap-1 truncate rounded-md border border-emerald-500/20 bg-emerald-950/35 px-1.5 py-0.5 text-[10px] text-emerald-200/80"><Users className="h-3 w-3 shrink-0" />{getAdminName(employee.created_by)}</span>}
            </div>
          </div>

          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-wider text-emerald-200/70 lg:hidden">身分資料</p>
            <p className={`truncate text-xs font-bold ${verification?.real_name ? 'text-emerald-50/90' : 'text-cyan-300'}`}>{verification?.real_name || '未填寫真實姓名'}</p>
            <p className={`mt-0.5 truncate text-[11px] ${verification?.phone ? 'text-emerald-100/70' : 'font-bold text-cyan-300'}`}>{verification?.phone || '未填寫電話'}</p>
          </div>

          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-wider text-emerald-200/70 lg:hidden">聯絡／帳戶資訊</p>
            <p className={`truncate text-xs font-semibold ${verification?.email ? 'text-emerald-50/90' : 'text-cyan-300'}`} title={verification?.email || ''}>{verification?.email || '未填寫電子郵件'}</p>
            <p className={`mt-0.5 line-clamp-2 break-all font-mono text-[10px] leading-[13px] ${verification?.wallet_address ? 'text-emerald-100/65' : 'text-cyan-300'}`} title={verification?.wallet_address || ''}>{verification?.wallet_address || '未填寫錢包地址'}</p>
          </div>

          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-wider text-emerald-200/70 lg:hidden">驗證時間</p>
            <p className="truncate text-[9px] font-black text-emerald-200/90">提交 {verification ? new Date(verification.created_at).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未記錄'}</p>
            <p className="mt-1 truncate text-[9px] font-semibold text-emerald-200/60">審核 {verification?.audited_at ? new Date(verification.audited_at).toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '未記錄'}</p>
          </div>

          <div className="flex items-center lg:justify-end">
            <button type="button" onClick={() => openDetailPanel(employee, verification)} className="inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-950/30 px-2.5 text-[10px] font-black text-emerald-200 transition-colors hover:bg-emerald-900/35">
              <Eye className="h-3.5 w-3.5" />查看資料
            </button>
          </div>
        </div>
      </article>
    );
  };

  const reviewVerification = reviewing ? verifications.find(item => item.id === reviewing) : undefined;
  const reviewEmployee = reviewVerification?.employee || verifiedEmployees.find(item => item.id === reviewVerification?.user_id);
  const detailVerification = detailPanel?.verification;
  const detailEmployee = detailPanel?.employee;
  const detailHasDocuments = Boolean(detailVerification && (detailVerification.id_front_url || detailVerification.id_back_url || detailVerification.selfie_url));

  return (
    <>
      {reviewVerification && reviewEmployee && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm sm:p-6">
          <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-amber-300/25 bg-slate-900 shadow-2xl shadow-black/50">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-300/15 bg-[linear-gradient(110deg,rgba(120,53,15,0.5),rgba(15,23,42,0.98)_58%)] px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-amber-300/30 bg-amber-500/15 text-amber-200"><Shield className="h-5 w-5" /></span>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-black text-white sm:text-base">驗證審核 · {reviewEmployee.username}</h3>
                  <p className="mt-0.5 truncate text-[10px] font-bold text-amber-100/55">核對身分資料和證件後提交審核結果</p>
                </div>
              </div>
              <button type="button" onClick={clearReviewDraft} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-600/70 bg-slate-950/40 text-slate-400 transition hover:bg-slate-800 hover:text-white" aria-label="關閉審核彈窗"><X className="h-4 w-4" /></button>
            </div>

            <div className="dark-panel-scroll grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="space-y-3 p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/70 bg-slate-950/40 px-3 py-2.5">
                  <span className="text-sm font-black text-white">{reviewEmployee.username}</span>
                  <span className="rounded-md border border-slate-600/70 bg-slate-900 px-2 py-0.5 text-[10px] font-bold text-slate-300">{reviewEmployee.employee_id}</span>
                  {getStatusBadge(reviewVerification.status)}
                  {isSuperAdmin && <span className="inline-flex items-center gap-1 rounded-full border border-cyan-400/25 bg-cyan-500/10 px-2 py-1 text-[10px] font-black text-cyan-200"><Users className="h-3 w-3" />{getAdminName(getVerificationOwnerId(reviewVerification))}</span>}
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  {[
                    { icon: User, label: '真實姓名', value: reviewVerification.real_name },
                    { icon: Phone, label: '電話號碼', value: reviewVerification.phone },
                    { icon: Mail, label: '電子郵件地址', value: reviewVerification.email },
                    { icon: Wallet, label: '錢包地址', value: reviewVerification.wallet_address },
                  ].map(({ icon: Icon, label, value }) => (
                    <div key={label} className="min-w-0 rounded-xl border border-slate-700/60 bg-slate-950/35 p-3">
                      <p className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider text-slate-500"><Icon className="h-3 w-3 text-amber-300/75" />{label}</p>
                      <p className={`mt-1.5 break-words text-xs font-semibold text-slate-100 ${label === '錢包地址' ? 'font-mono' : ''}`}>{value || '—'}</p>
                    </div>
                  ))}
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-700/60 bg-slate-950/35 px-3 py-2.5">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-wider text-slate-500">提交時間</p>
                    <p className="mt-1 text-xs font-bold text-slate-200">{new Date(reviewVerification.created_at).toLocaleString()}</p>
                  </div>
                  {(reviewVerification.id_front_url || reviewVerification.id_back_url || reviewVerification.selfie_url) ? (
                    <button type="button" onClick={() => openImagePreview(reviewVerification)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 text-[10px] font-black text-cyan-200 transition hover:bg-cyan-500/20"><ImageIcon className="h-3.5 w-3.5" />查看驗證證件</button>
                  ) : (
                    <span className="text-[10px] font-bold text-slate-600">未上傳證件</span>
                  )}
                </div>
              </div>

              <div className="border-t border-slate-600/70 bg-slate-900/85 p-4 lg:border-l lg:border-t-0 sm:p-5">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-200">審核結果</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => { setReviewAction('approved'); setValidationError(null); }} className={`flex h-11 items-center justify-center gap-2 rounded-xl border text-xs font-black transition ${reviewAction === 'approved' ? 'border-emerald-300/70 bg-emerald-600 text-white' : 'border-emerald-400/20 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20'}`}><CheckCircle className="h-4 w-4" />通過驗證</button>
                  <button type="button" onClick={() => { setReviewAction('rejected'); setValidationError(null); }} className={`flex h-11 items-center justify-center gap-2 rounded-xl border text-xs font-black transition ${reviewAction === 'rejected' ? 'border-rose-300/70 bg-rose-600 text-white' : 'border-rose-400/20 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20'}`}><XCircle className="h-4 w-4" />拒絕申請</button>
                </div>

                <label className="mt-4 block text-[10px] font-black text-slate-200">審核備註{reviewAction === 'rejected' ? '（必填）' : '（選填）'}</label>
                <textarea
                  value={auditRemark}
                  onChange={event => { setAuditRemark(event.target.value); if (validationError) setValidationError(null); }}
                  rows={6}
                  placeholder={reviewAction === 'rejected' ? '請填寫拒絕原因及需要補充的資料' : '可填寫審核說明'}
                  className={`mt-2 w-full resize-none rounded-xl border bg-slate-100 px-3 py-2.5 text-xs font-semibold leading-5 text-slate-900 outline-none placeholder:text-slate-500 focus:ring-2 ${validationError ? 'border-rose-500 focus:ring-rose-500/25' : 'border-slate-300 focus:border-cyan-500 focus:ring-cyan-500/20'}`}
                />
                {validationError && <p className="mt-2 text-[10px] font-bold leading-4 text-rose-300">{validationError}</p>}

                <div className="mt-4 grid grid-cols-[auto_1fr] gap-2">
                  <button type="button" onClick={clearReviewDraft} className="h-10 rounded-xl border border-slate-500 bg-slate-700 px-4 text-xs font-black text-white transition hover:bg-slate-600">取消</button>
                  <button type="button" disabled={!reviewAction} onClick={() => reviewAction && void handleReview(reviewVerification.id, reviewAction)} className={`h-10 rounded-xl border text-xs font-black transition ${!reviewAction ? 'cursor-not-allowed border-slate-300 bg-slate-100 text-slate-800' : reviewAction === 'rejected' ? 'border-rose-300/60 bg-gradient-to-r from-rose-600 to-red-600 text-white hover:from-rose-500 hover:to-red-500' : 'border-emerald-300/60 bg-gradient-to-r from-emerald-600 to-teal-600 text-white hover:from-emerald-500 hover:to-teal-500'}`}>{reviewAction === 'rejected' ? '確認拒絕' : reviewAction === 'approved' ? '確認通過' : '請選擇審核結果'}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {detailPanel && detailEmployee && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm sm:p-6">
          <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-cyan-300/25 bg-slate-900 shadow-2xl shadow-black/50">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-cyan-300/15 bg-[linear-gradient(110deg,rgba(8,47,73,0.7),rgba(15,23,42,0.98)_62%)] px-4 py-3 sm:px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-500/10 text-cyan-200"><FileText className="h-5 w-5" /></span>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="truncate text-sm font-black text-white sm:text-base">{detailEmployee.username} · 驗證資料</h3>
                    {detailVerification && getStatusBadge(detailVerification.status)}
                  </div>
                  <p className="mt-0.5 truncate text-[10px] font-bold text-cyan-100/50">員工編號 {detailEmployee.employee_id}</p>
                </div>
              </div>
              <button type="button" onClick={() => setDetailPanel(null)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-600/70 bg-slate-950/40 text-slate-400 transition hover:bg-slate-800 hover:text-white" aria-label="關閉資料彈窗"><X className="h-4 w-4" /></button>
            </div>

            <div className="dark-panel-scroll min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-5">
              <div className="grid gap-2 sm:grid-cols-2">
                {[
                  { icon: User, label: '真實姓名', value: detailVerification?.real_name },
                  { icon: Phone, label: '電話號碼', value: detailVerification?.phone },
                  { icon: Mail, label: '電子郵件地址', value: detailVerification?.email },
                  { icon: Wallet, label: '錢包地址', value: detailVerification?.wallet_address },
                ].map(({ icon: Icon, label, value }) => (
                  <div key={label} className="min-w-0 rounded-xl border border-slate-700/60 bg-slate-950/35 p-3">
                    <p className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-wider text-slate-500"><Icon className="h-3 w-3 text-cyan-300/70" />{label}</p>
                    <p className={`mt-1.5 break-words text-xs font-semibold text-slate-100 ${label === '錢包地址' ? 'font-mono' : ''}`}>{value || '—'}</p>
                  </div>
                ))}
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-xl border border-slate-700/60 bg-slate-950/35 p-3"><p className="text-[9px] font-black uppercase tracking-wider text-slate-500">錢包餘額</p><p className="mt-1.5 text-sm font-black text-emerald-300">${(walletBalances.get(detailEmployee.id) || 0).toFixed(2)}</p></div>
                <div className="rounded-xl border border-slate-700/60 bg-slate-950/35 p-3"><p className="text-[9px] font-black uppercase tracking-wider text-slate-500">提交時間</p><p className="mt-1.5 text-xs font-bold text-slate-200">{detailVerification ? new Date(detailVerification.created_at).toLocaleString() : '—'}</p></div>
                <div className="rounded-xl border border-slate-700/60 bg-slate-950/35 p-3"><p className="text-[9px] font-black uppercase tracking-wider text-slate-500">審核時間</p><p className="mt-1.5 text-xs font-bold text-slate-200">{detailVerification?.audited_at ? new Date(detailVerification.audited_at).toLocaleString() : '—'}</p></div>
              </div>

              {detailVerification?.audit_remark && (
                <div className={`rounded-xl border p-3 ${detailVerification.status === 'rejected' ? 'border-rose-400/25 bg-rose-500/10' : 'border-slate-700/60 bg-slate-950/35'}`}>
                  <p className="text-[9px] font-black uppercase tracking-wider text-slate-500">審核備註</p>
                  <p className={`mt-1.5 text-xs leading-5 ${detailVerification.status === 'rejected' ? 'text-rose-100' : 'text-slate-200'}`}>{detailVerification.audit_remark}</p>
                </div>
              )}
            </div>

            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-slate-700/70 bg-slate-950/35 px-4 py-3 sm:px-5">
              <button type="button" onClick={() => setDetailPanel(null)} className="h-9 rounded-lg border border-slate-600 bg-slate-800 px-3 text-[10px] font-bold text-slate-300 transition hover:bg-slate-700 hover:text-white">關閉</button>
              {detailVerification && detailHasDocuments && <button type="button" onClick={() => openImagePreview(detailVerification)} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 text-[10px] font-black text-cyan-200 transition hover:bg-cyan-500/20"><ImageIcon className="h-3.5 w-3.5" />查看驗證證件</button>}
              {detailVerification?.status === 'pending' && <button type="button" onClick={() => openReviewModal(detailVerification)} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-gradient-to-r from-amber-500 to-orange-600 px-3 text-[10px] font-black text-white transition hover:from-amber-400 hover:to-orange-500"><Shield className="h-3.5 w-3.5" />開始驗證</button>}
              {detailVerification && detailVerification.status !== 'pending' && <button type="button" onClick={() => { setDetailPanel(null); handleReset(detailVerification.id); }} disabled={resetting === detailVerification.id} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-amber-600 px-3 text-[10px] font-black text-white transition hover:bg-amber-500 disabled:opacity-50"><RotateCcw className="h-3.5 w-3.5" />{resetting === detailVerification.id ? '重設中…' : '重設為待審核'}</button>}
              {detailVerification?.status === 'rejected' && <button type="button" onClick={() => { setDetailPanel(null); handleDelete(detailVerification.id); }} disabled={deleting === detailVerification.id} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 text-[10px] font-black text-rose-300 transition hover:bg-rose-500/20 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />{deleting === detailVerification.id ? '刪除中…' : '刪除申請'}</button>}
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      {confirmDialog?.isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl max-w-md w-full p-6 animate-in fade-in zoom-in duration-200">
            <div className="flex items-start gap-4 mb-4">
              <div className={`p-3 rounded-full ${
                confirmDialog.confirmColor === 'red'
                  ? 'bg-red-500/10 border border-red-500/50'
                  : 'bg-amber-500/10 border border-amber-500/50'
              }`}>
                <AlertCircle className={`w-6 h-6 ${
                  confirmDialog.confirmColor === 'red' ? 'text-red-400' : 'text-amber-400'
                }`} />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-white mb-2">{confirmDialog.title}</h3>
                <p className="text-slate-300 text-sm">{confirmDialog.message}</p>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button
                onClick={() => setConfirmDialog(null)}
                className="flex-1 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg font-medium transition-all"
              >
                取消
              </button>
              <button
                onClick={confirmDialog.onConfirm}
                className={`flex-1 px-4 py-2.5 text-white rounded-lg font-medium transition-all ${
                  confirmDialog.confirmColor === 'red'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-amber-600 hover:bg-amber-700'
                }`}
              >
                {confirmDialog.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Image Preview Modal */}
      {imagePreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-2 sm:p-4">
          <div className="relative flex h-[96vh] w-full max-w-7xl flex-col sm:h-[95vh]">
            {/* Header */}
            <div className="mb-2 flex items-center justify-between gap-2 rounded-t-xl border border-slate-700 bg-slate-900/90 px-2 py-2 backdrop-blur sm:mb-4 sm:px-4 sm:py-3">
              <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                <ImageIcon className="h-4 w-4 shrink-0 text-cyan-400 sm:h-5 sm:w-5" />
                <h3 className="truncate text-sm font-bold text-white sm:text-lg">
                  {imagePreview.images[imagePreview.currentIndex].label}
                </h3>
                <span className="shrink-0 text-xs text-slate-400 sm:text-sm">
                  {imagePreview.currentIndex + 1} / {imagePreview.images.length}
                </span>
                <span className="shrink-0 text-xs text-cyan-400 sm:ml-2 sm:text-sm">
                  {Math.round(imagePreview.scale * 100)}%
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 sm:gap-2">
                <button
                  onClick={zoomOut}
                  disabled={imagePreview.scale <= 0.5}
                  className={`rounded-lg p-1.5 transition-all sm:p-2 ${
                    imagePreview.scale <= 0.5
                      ? 'text-slate-600 cursor-not-allowed'
                      : 'hover:bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                  title="縮小"
                >
                  <ZoomOut className="h-4 w-4 sm:h-5 sm:w-5" />
                </button>
                <button
                  onClick={resetZoom}
                  className="rounded-lg p-1.5 text-slate-400 transition-all hover:bg-slate-800 hover:text-white sm:p-2"
                  title="重設縮放"
                >
                  <Maximize2 className="h-4 w-4 sm:h-5 sm:w-5" />
                </button>
                <button
                  onClick={zoomIn}
                  disabled={imagePreview.scale >= 3}
                  className={`rounded-lg p-1.5 transition-all sm:p-2 ${
                    imagePreview.scale >= 3
                      ? 'text-slate-600 cursor-not-allowed'
                      : 'hover:bg-slate-800 text-slate-400 hover:text-white'
                  }`}
                  title="放大"
                >
                  <ZoomIn className="h-4 w-4 sm:h-5 sm:w-5" />
                </button>
                <div className="mx-0.5 h-5 w-px bg-slate-700 sm:mx-2 sm:h-6" />
                <button
                  onClick={closeImagePreview}
                  className="rounded-lg p-1.5 text-slate-400 transition-all hover:bg-slate-800 hover:text-white sm:p-2"
                >
                  <X className="h-5 w-5 sm:h-6 sm:w-6" />
                </button>
              </div>
            </div>

            {/* Image Container */}
            <div
              className="flex-1 relative bg-slate-900/90 backdrop-blur rounded-b-xl border border-slate-700 border-t-0 flex items-center justify-center overflow-hidden"
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{ cursor: imagePreview.scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
            >
              {/* Loading Spinner */}
              {imageLoading && (
                <div className="absolute inset-0 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm z-20">
                  <div className="flex flex-col items-center gap-4">
                    <div className="relative w-16 h-16">
                      <div className="absolute inset-0 border-4 border-slate-700 rounded-full"></div>
                      <div className="absolute inset-0 border-4 border-transparent border-t-cyan-500 rounded-full animate-spin"></div>
                    </div>
                    <div className="text-cyan-400 font-medium">正在載入圖片…</div>
                  </div>
                </div>
              )}

              <img
                src={imagePreview.images[imagePreview.currentIndex].url}
                alt={imagePreview.images[imagePreview.currentIndex].label}
                className="max-w-full max-h-full object-contain transition-transform select-none"
                style={{
                  transform: `scale(${imagePreview.scale}) translate(${position.x / imagePreview.scale}px, ${position.y / imagePreview.scale}px)`,
                  transformOrigin: 'center center',
                  opacity: imageLoading ? 0 : 1,
                  transition: 'opacity 0.3s ease-in-out'
                }}
                draggable={false}
                onLoad={() => handleImageLoad(imagePreview.images[imagePreview.currentIndex].url)}
                onError={() => setImageLoading(false)}
              />

              {/* Navigation Buttons */}
              {imagePreview.images.length > 1 && (
                <>
                  <button
                    onClick={prevImage}
                    disabled={imagePreview.currentIndex === 0}
                    className={`absolute left-2 z-10 rounded-full p-2 backdrop-blur-sm transition-all sm:left-4 sm:p-3 ${
                      imagePreview.currentIndex === 0
                        ? 'bg-slate-800/30 text-slate-600 cursor-not-allowed'
                        : 'bg-slate-800/80 text-white hover:bg-slate-700 hover:scale-110'
                    }`}
                  >
                    <ChevronLeft className="h-5 w-5 sm:h-6 sm:w-6" />
                  </button>
                  <button
                    onClick={nextImage}
                    disabled={imagePreview.currentIndex === imagePreview.images.length - 1}
                    className={`absolute right-2 z-10 rounded-full p-2 backdrop-blur-sm transition-all sm:right-4 sm:p-3 ${
                      imagePreview.currentIndex === imagePreview.images.length - 1
                        ? 'bg-slate-800/30 text-slate-600 cursor-not-allowed'
                        : 'bg-slate-800/80 text-white hover:bg-slate-700 hover:scale-110'
                    }`}
                  >
                    <ChevronRight className="h-5 w-5 sm:h-6 sm:w-6" />
                  </button>
                </>
              )}

              {/* Zoom Instructions */}
              {imagePreview.scale > 1 && (
                <div className="absolute bottom-4 left-1/2 hidden -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-900/80 px-4 py-2 text-sm text-slate-300 backdrop-blur sm:block">
                  按住並拖曳以移動圖片
                </div>
              )}
            </div>

            {/* Thumbnails */}
            {imagePreview.images.length > 1 && (
              <div className="mt-2 flex flex-wrap justify-center gap-1.5 sm:mt-4 sm:gap-2">
                {imagePreview.images.map((img, index) => (
                  <button
                    key={index}
                    onClick={() => {
                      setImagePreview({ ...imagePreview, currentIndex: index });
                      setPosition({ x: 0, y: 0 });
                      setImageLoading(!loadedImages.has(img.url));
                    }}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all sm:px-4 sm:py-2 sm:text-sm ${
                      index === imagePreview.currentIndex
                        ? 'bg-cyan-600 text-white'
                        : 'bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white'
                    }`}
                  >
                    {img.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-slate-950">
        <header className="relative z-20 shrink-0 border-b border-cyan-300/20 bg-[radial-gradient(circle_at_top_left,rgba(8,145,178,0.2),transparent_36%),linear-gradient(105deg,rgba(8,47,73,0.94),rgba(15,23,42,0.98)_70%)] px-3 py-2.5 shadow-lg shadow-slate-950/25 sm:px-4">
          <div className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-center">
            <div className="flex min-w-0 shrink-0 items-center gap-2.5 lg:w-[210px]">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-300/25 bg-cyan-500/10 text-cyan-200 shadow-inner shadow-cyan-950/30">
                <Shield className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-black text-white sm:text-base">驗證管理</h2>
                <p className="mt-0.5 truncate text-[10px] font-bold text-cyan-100/60">{selectedAdminName} · {activeResultCount} 條記錄</p>
              </div>
            </div>

            <div className="grid min-w-0 flex-1 grid-cols-4 gap-1.5 rounded-xl border border-slate-600/70 bg-[linear-gradient(135deg,rgba(2,6,23,0.72),rgba(15,23,42,0.82))] p-1 shadow-inner shadow-black/20 lg:ml-auto lg:max-w-[430px]">
              {([
                {
                  value: 'all',
                  label: '全部',
                  count: selectedGroupStats.pending + selectedGroupStats.approved + selectedGroupStats.rejected,
                  active: 'border-cyan-200/70 bg-gradient-to-r from-blue-600 to-cyan-600 text-white',
                  idle: 'border-blue-400/25 bg-blue-500/10 text-blue-200 hover:border-blue-300/50 hover:bg-blue-500/20',
                },
                {
                  value: 'requests',
                  label: '待審核',
                  count: selectedGroupStats.pending,
                  active: 'border-amber-200/70 bg-gradient-to-r from-amber-500 to-orange-600 text-white',
                  idle: 'border-amber-400/25 bg-amber-500/10 text-amber-200 hover:border-amber-300/50 hover:bg-amber-500/20',
                },
                {
                  value: 'verified',
                  label: '已驗證',
                  count: selectedGroupStats.approved,
                  active: 'border-emerald-200/70 bg-gradient-to-r from-emerald-500 to-teal-600 text-white',
                  idle: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-200 hover:border-emerald-300/50 hover:bg-emerald-500/20',
                },
                {
                  value: 'rejected',
                  label: '已拒絕',
                  count: selectedGroupStats.rejected,
                  active: 'border-rose-200/70 bg-gradient-to-r from-rose-500 to-red-600 text-white',
                  idle: 'border-rose-400/25 bg-rose-500/10 text-rose-200 hover:border-rose-300/50 hover:bg-rose-500/20',
                },
              ] as const).map(item => (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => changeContext(item.value, selectedAdminId)}
                  aria-pressed={viewMode === item.value}
                  className={`flex h-9 min-w-0 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-black transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200/60 ${viewMode === item.value ? item.active : item.idle}`}
                >
                  <span className="truncate">{item.label}</span>
                  <span className={`min-w-5 rounded-md px-1.5 py-0.5 text-center text-[11px] leading-none ${viewMode === item.value ? 'bg-black/20 text-white' : 'bg-black/20 text-current'}`}>{item.count}</span>
                </button>
              ))}
            </div>

            <div className="relative min-w-0 flex-1 lg:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-cyan-200/55" />
              <input
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder="搜尋員工、電話、電子郵件或錢包"
                className="h-9 w-full rounded-xl border border-cyan-300/20 bg-slate-950/45 pl-9 pr-9 text-xs font-bold text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-300/60 focus:ring-2 focus:ring-cyan-400/15"
              />
              {searchQuery && (
                <button type="button" onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-slate-500 hover:bg-slate-800 hover:text-white" aria-label="清除搜尋">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </header>

        {isSuperAdmin && (
          <div className="shrink-0 border-b border-slate-700 bg-slate-900 p-2 lg:hidden">
            <select
              value={selectedAdminId}
              onChange={event => changeContext(viewMode, event.target.value)}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-800 px-2 text-xs font-black text-white outline-none focus:border-cyan-400"
            >
              <option value="all">全部管理員</option>
              {adminOptions.map(adminOption => (
                <option key={adminOption.id} value={adminOption.id}>{adminOption.username}</option>
              ))}
            </select>
          </div>
        )}

        <div className={`grid min-h-0 flex-1 ${isSuperAdmin ? 'lg:grid-cols-[250px_minmax(0,1fr)]' : 'grid-cols-1'}`}>
          {isSuperAdmin && (
          <aside className="hidden min-h-0 flex-col border-r border-emerald-200/15 bg-[radial-gradient(circle_at_12%_0%,rgba(16,185,129,0.13),transparent_30%),linear-gradient(165deg,#101c1a_0%,#0b1516_50%,#070d12_100%)] shadow-xl shadow-black/30 lg:flex">
            <div className="flex h-10 shrink-0 items-center justify-between border-b border-emerald-200/10 bg-[linear-gradient(90deg,rgba(6,78,59,0.34),rgba(15,23,42,0.78))] px-3">
              <span className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-emerald-100/80"><Users className="h-3.5 w-3.5" />管理員分組</span>
              <span className="rounded-md border border-emerald-400/20 bg-emerald-950/50 px-1.5 py-0.5 text-[9px] font-black text-emerald-200/75">{adminOptions.length}</span>
            </div>

            <div className="dark-panel-scroll min-h-0 flex-1 space-y-2 overflow-y-auto bg-[radial-gradient(circle_at_100%_8%,rgba(16,185,129,0.08),transparent_34%),linear-gradient(180deg,rgba(15,23,42,0.08),rgba(2,6,23,0.34))] p-2.5">
              {isSuperAdmin && (
                <div className={`group relative w-full overflow-hidden rounded-xl border p-2 shadow-md shadow-black/20 transition-colors duration-200 ${selectedAdminId === 'all' ? 'border-emerald-300/60 bg-[linear-gradient(135deg,rgba(6,95,70,0.98),rgba(13,148,136,0.86))] text-white' : 'border-white/10 bg-[linear-gradient(135deg,rgba(30,41,59,0.94),rgba(15,42,39,0.92))] text-slate-200 hover:border-emerald-400/35 hover:bg-[linear-gradient(135deg,rgba(30,54,52,0.96),rgba(15,52,46,0.94))]'}`}>
                  {selectedAdminId === 'all' && <span className="absolute bottom-1.5 left-0 top-1.5 w-1 rounded-r-full bg-emerald-200" />}
                  <button
                    type="button"
                    onClick={() => changeContext(viewMode, 'all')}
                    aria-pressed={selectedAdminId === 'all'}
                    className="flex w-full items-center justify-between gap-2 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200/70"
                  >
                    <span className="flex items-center gap-2 text-xs font-black"><span className={`flex h-7 w-7 items-center justify-center rounded-lg border ${selectedAdminId === 'all' ? 'border-emerald-100/30 bg-emerald-100/15 text-white' : 'border-slate-600/70 bg-slate-950/45 text-emerald-300'}`}><Users className="h-3.5 w-3.5" /></span>全部管理員</span>
                    {overallStats.pending > 0 ? (
                      <span className="inline-flex items-center gap-1 rounded-full border border-orange-200/70 bg-gradient-to-r from-orange-500 to-red-600 px-2 py-1 text-[10px] font-black text-white"><AlertCircle className="h-3 w-3" />待審核 {overallStats.pending}</span>
                    ) : (
                      <span className="text-[9px] font-black text-emerald-200">彙總</span>
                    )}
                  </button>
                </div>
              )}

              {adminOptions.map(adminOption => {
                const stats = getAdminStats(adminOption.id);
                const selected = selectedAdminId === adminOption.id;
                return (
                  <div key={adminOption.id} className={`group relative w-full overflow-hidden rounded-xl border p-2 shadow-md shadow-black/20 transition-colors duration-200 ${selected ? 'border-emerald-300/60 bg-[linear-gradient(135deg,rgba(6,95,70,0.98),rgba(13,148,136,0.86))] text-white' : 'border-white/10 bg-[linear-gradient(135deg,rgba(30,41,59,0.94),rgba(15,42,39,0.92))] text-slate-200 hover:border-emerald-400/35 hover:bg-[linear-gradient(135deg,rgba(30,54,52,0.96),rgba(15,52,46,0.94))]'}`}>
                    {selected && <span className="absolute bottom-1.5 left-0 top-1.5 w-1 rounded-r-full bg-emerald-200" />}
                    <button
                      type="button"
                      onClick={() => changeContext(viewMode, adminOption.id)}
                      aria-pressed={selected}
                      className="flex w-full min-w-0 items-center gap-2 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200/70"
                    >
                      <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${selected ? 'border-emerald-100/30 bg-emerald-100/15 text-white' : 'border-slate-600/70 bg-slate-950/45 text-emerald-300'}`}><User className="h-3.5 w-3.5" /></span>
                      <span className="min-w-0 flex-1 truncate text-xs font-black">{adminOption.username}</span>
                      {stats.pending > 0 && <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-orange-200/70 bg-gradient-to-r from-orange-500 to-red-600 px-1.5 py-1 text-[9px] font-black text-white"><AlertCircle className="h-3 w-3" />待審核 {stats.pending}</span>}
                    </button>
                  </div>
                );
              })}
            </div>

          </aside>
          )}

          <main className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-[radial-gradient(circle_at_top_right,rgba(8,145,178,0.08),transparent_32%),#0f172a]">
            <div className={`hidden h-10 shrink-0 grid-cols-[minmax(180px,1.25fr)_minmax(120px,0.8fr)_minmax(160px,1.1fr)_minmax(120px,0.7fr)_auto] items-center gap-2 border-b px-8 text-[10px] font-black uppercase tracking-[0.12em] shadow-md shadow-slate-950/20 lg:grid ${listHeaderTheme}`}>
              <span>員工與狀態</span>
              <span>身分資料</span>
              <span>聯絡／帳戶資訊</span>
              <span>時間</span>
              <span className="min-w-[168px] text-right">操作</span>
            </div>

            <div className="dark-panel-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden p-2.5 sm:p-4">
              {error && (
                <div className="mb-3 flex items-center gap-2 rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2.5 text-xs font-bold text-rose-200"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>
              )}
              {loading ? (
                <div className="flex h-full min-h-64 flex-col items-center justify-center text-center">
                  <span className="mb-3 h-9 w-9 animate-spin rounded-full border-2 border-slate-700 border-t-cyan-400" />
                  <p className="text-xs font-bold text-slate-400">正在載入驗證資料…</p>
                </div>
              ) : activeResultCount === 0 ? (
                <div className="flex h-full min-h-64 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-700 bg-slate-950/25 px-6 text-center">
                  <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-400/20 bg-cyan-500/10 text-cyan-300"><FileText className="h-5 w-5" /></span>
                  <h3 className="text-sm font-black text-white">沒有符合條件的記錄</h3>
                  <p className="mt-1.5 max-w-sm text-xs leading-5 text-slate-500">請切換管理員分組、審核狀態，或調整搜尋條件後再查看。</p>
                  {searchQuery && <button type="button" onClick={() => setSearchQuery('')} className="mt-4 h-8 rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-3 text-[10px] font-black text-cyan-200 hover:bg-cyan-500/20">清除搜尋</button>}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {viewMode === 'all' && allFilteredItems.map(entry =>
                    entry.type === 'employee'
                      ? renderVerifiedEmployeeCard(entry.item)
                      : renderVerificationCard(entry.item)
                  )}
                  {viewMode === 'requests' && filteredVerifications.map(renderVerificationCard)}
                  {viewMode === 'verified' && filteredVerifiedEmployees.map(renderVerifiedEmployeeCard)}
                  {viewMode === 'rejected' && filteredRejectedVerifications.map(renderVerificationCard)}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    </>
  );
}
