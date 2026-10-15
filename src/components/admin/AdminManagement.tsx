import { useState, useEffect, useCallback } from 'react';
import { UserPlus, Shield, Trash2, Eye, EyeOff, CreditCard as Edit2 } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getAdminFinancialSessionToken } from '../../lib/auth';
import { mutateAuditedContent } from '../../lib/contentAudit';
import { Admin } from '../../types';

interface AdminManagementProps {
  admin: Admin;
}

export default function AdminManagement({ admin }: AdminManagementProps) {
  const [admins, setAdmins] = useState<Admin[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [deletingAdminId, setDeletingAdminId] = useState<string | null>(null);
  const [editingAdmin, setEditingAdmin] = useState<Admin | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showEditPassword, setShowEditPassword] = useState(false);
  const [creating, setCreating] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
  });
  const [editFormData, setEditFormData] = useState({
    username: '',
    password: '',
  });

  const loadAdmins = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('admins')
        .select('id, username, role, parent_id, is_active, is_pinned, created_at, updated_at')
        .eq('role', 'secondary_admin')
        .order('created_at', { ascending: false });

      if (error) throw error;
      setAdmins(data || []);
    } catch (error) {
      console.error('Error loading admins:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (admin.role === 'super_admin') {
      void loadAdmins();
    }
  }, [admin.role, loadAdmins]);

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreating(true);

    try {
      if (!formData.username.trim()) {
        throw new Error('Username is required');
      }
      if (formData.password.length < 6) {
        throw new Error('Password must be at least 6 characters');
      }

      const { data, error } = await supabase.rpc('admin_create_secondary_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_username: formData.username.trim(),
        p_password: formData.password,
      });

      if (error) {
        if (error.code === '23505') {
          throw new Error('Username already exists');
        }
        throw error;
      }

      if (!data?.success) {
        throw new Error('Failed to create admin - no data returned');
      }

      setFormData({ username: '', password: '' });
      setShowCreateForm(false);
      setShowPassword(false);
      await loadAdmins();
    } catch (error: unknown) {
      console.error('Error creating admin:', error);
      setError(error instanceof Error ? error.message : 'Failed to create admin. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  const toggleAdminStatus = async (adminId: string, currentStatus: boolean) => {
    try {
      const { error } = await supabase.rpc('admin_update_admin_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_target_admin_id: adminId,
        p_updates: { is_active: !currentStatus },
      });

      if (error) throw error;
      void loadAdmins();
    } catch (error) {
      console.error('Error toggling admin status:', error);
    }
  };

  const handleDeleteAdmin = async (adminId: string) => {
    try {
      setDeleteError(null);
      const result = await mutateAuditedContent('admin_delete', [adminId]);
      if (!result.success) throw new Error('Unable to delete administrator.');

      setDeletingAdminId(null);
      void loadAdmins();
    } catch (error: unknown) {
      console.error('Error deleting admin:', error);
      const message = error instanceof Error ? error.message : 'Failed to delete admin. Please try again.';
      setDeleteError(message);
    }
  };

  const openEditModal = (secondaryAdmin: Admin) => {
    setEditingAdmin(secondaryAdmin);
    setEditFormData({
      username: secondaryAdmin.username,
      password: '',
    });
    setShowEditPassword(false);
    setEditError(null);
  };

  const handleUpdateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingAdmin) return;

    setEditError(null);
    setUpdating(true);

    try {
      if (!editFormData.username.trim()) {
        throw new Error('Username is required');
      }

      if (editFormData.password && editFormData.password.length < 6) {
        throw new Error('Password must be at least 6 characters');
      }

      const { error } = await supabase.rpc('admin_update_secondary_account', {
        p_admin_session_token: getAdminFinancialSessionToken(),
        p_target_admin_id: editingAdmin.id,
        p_username: editFormData.username.trim(),
        p_new_password: editFormData.password || null,
      });

      if (error) {
        if (error.code === '23505') {
          throw new Error('Username already exists');
        }
        throw error;
      }

      setEditingAdmin(null);
      setEditFormData({ username: '', password: '' });
      setShowEditPassword(false);
      await loadAdmins();
    } catch (error: unknown) {
      console.error('Error updating admin:', error);
      setEditError(error instanceof Error ? error.message : 'Failed to update admin. Please try again.');
    } finally {
      setUpdating(false);
    }
  };

  if (admin.role !== 'super_admin') {
    return null;
  }

  const deletingAdmin = admins.find(item => item.id === deletingAdminId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-gradient-to-br from-[#17243a] via-[#122838] to-[#102c33] text-slate-100">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-cyan-400/20 bg-gradient-to-r from-[#1b2d47] to-[#17343e] px-4 py-3 sm:px-6">
        <div>
          <h1 className="text-lg font-semibold text-white">二級管理員</h1>
          <p className="mt-0.5 text-xs text-slate-300">建立與管理二級管理員帳號</p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreateForm(true)}
          aria-haspopup="dialog"
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
        >
          <UserPlus className="h-4 w-4" />
          新增二級管理員
        </button>
      </div>

      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center py-10 text-sm text-slate-400">正在載入管理員…</div>
      ) : (
        <div className="min-h-0 flex-1 bg-slate-900/15">
          {admins.map((secondaryAdmin) => (
            <div
              key={secondaryAdmin.id}
              className={`relative flex min-h-[57px] flex-wrap items-center justify-between gap-3 border-b px-4 py-1 transition-colors sm:px-6 ${secondaryAdmin.is_active
                ? 'border-emerald-400/20 bg-gradient-to-r from-emerald-900/55 via-slate-800/30 to-emerald-950/35 hover:from-emerald-800/60 hover:to-emerald-900/45'
                : 'border-rose-400/20 bg-gradient-to-r from-rose-950/55 via-slate-800/30 to-red-950/35 hover:from-rose-900/60 hover:to-red-900/45'
              }`}
            >
              <span aria-hidden="true" className={`absolute inset-y-2 left-0 w-0.5 rounded-r ${secondaryAdmin.is_active ? 'bg-emerald-400/80' : 'bg-rose-400/80'}`} />
              <div className="flex min-w-0 flex-1 items-center gap-3.5">
                <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border ${secondaryAdmin.is_active
                  ? 'border-emerald-300/30 bg-gradient-to-br from-emerald-500 to-green-800 text-emerald-50'
                  : 'border-rose-300/30 bg-gradient-to-br from-rose-500 to-red-900 text-rose-50'
                }`}>
                  <Shield className="h-4 w-4" />
                </div>
                <div className="flex min-w-0 items-center gap-2.5">
                  <h3 className="min-w-0 truncate text-base font-semibold tracking-wide text-white" title={secondaryAdmin.username}>{secondaryAdmin.username}</h3>
                  <span className="shrink-0 whitespace-nowrap text-xs text-slate-400">
                    建立於 {new Date(secondaryAdmin.created_at).toLocaleDateString('zh-TW')}
                  </span>
                </div>
              </div>
              <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
                <button
                  onClick={() => toggleAdminStatus(secondaryAdmin.id, secondaryAdmin.is_active)}
                  className={`inline-flex min-h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 ${
                    secondaryAdmin.is_active
                      ? 'border-emerald-400/50 bg-emerald-600/30 text-emerald-100 hover:bg-emerald-500/40 focus-visible:ring-emerald-400'
                      : 'border-rose-400/50 bg-rose-600/30 text-rose-100 hover:bg-rose-500/40 focus-visible:ring-rose-400'
                  }`}
                >
                  <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${secondaryAdmin.is_active ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                  {secondaryAdmin.is_active ? '使用中' : '已停用'}
                </button>
                <button
                  onClick={() => openEditModal(secondaryAdmin)}
                  className="inline-flex min-h-9 items-center justify-center rounded-lg border border-blue-400/60 bg-blue-600/75 px-3 text-xs font-semibold text-white shadow-sm shadow-blue-950/40 transition-colors hover:border-blue-300 hover:bg-blue-500 active:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                  title="編輯管理員"
                  aria-label={`編輯 ${secondaryAdmin.username}`}
                >
                  編輯
                </button>
                <button
                  onClick={() => setDeletingAdminId(secondaryAdmin.id)}
                  className="inline-flex min-h-9 items-center justify-center rounded-lg border border-rose-400/60 bg-rose-600/75 px-3 text-xs font-semibold text-white shadow-sm shadow-rose-950/40 transition-colors hover:border-rose-300 hover:bg-rose-500 active:bg-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
                  title="刪除管理員"
                  aria-label={`刪除 ${secondaryAdmin.username}`}
                >
                  刪除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreateForm && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="create-admin-title" className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-cyan-300/25 bg-[#18283d] shadow-2xl shadow-slate-950/70">
            <div className="flex items-center gap-3 border-b border-cyan-300/20 bg-gradient-to-r from-[#1d3b61] via-[#1b3651] to-[#164752] px-5 py-5 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-200/25 bg-white/10 text-cyan-100 shadow-sm">
                <UserPlus className="h-5 w-5" />
              </div>
              <div>
                <h3 id="create-admin-title" className="text-lg font-semibold text-white">新增二級管理員</h3>
                <p className="mt-0.5 text-xs text-cyan-100/75">建立新的管理員帳號</p>
              </div>
            </div>
            <form onSubmit={handleCreateAdmin} className="space-y-5 p-5 sm:p-6">
              {error && (
                <div role="alert" className="rounded-lg border border-rose-400/30 bg-rose-950/40 p-3 text-sm text-rose-100">
                  {error}
                </div>
              )}
              <div>
                <label htmlFor="create-admin-username" className="mb-2 block text-xs font-semibold tracking-wide text-slate-200">登入帳號</label>
                <input
                  id="create-admin-username"
                  type="text"
                  autoComplete="username"
                  value={formData.username}
                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                  required
                  className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 shadow-sm outline-none transition-colors focus:border-cyan-500 focus:ring-2 focus:ring-cyan-400/30"
                />
              </div>
              <div>
                <label htmlFor="create-admin-password" className="mb-2 block text-xs font-semibold tracking-wide text-slate-200">登入密碼</label>
                <div className="relative">
                  <input
                    id="create-admin-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                    required
                    className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 pr-11 text-sm text-slate-900 shadow-sm outline-none transition-colors focus:border-cyan-500 focus:ring-2 focus:ring-cyan-400/30"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? '隱藏密碼' : '顯示密碼'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                  >
                    {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-slate-400">密碼至少需要 6 個字元</p>
              </div>
              <div className="flex gap-3 border-t border-white/10 pt-5">
                <button
                  type="button"
                  onClick={() => {
                    setShowCreateForm(false);
                    setError(null);
                    setFormData({ username: '', password: '' });
                    setShowPassword(false);
                  }}
                  disabled={creating}
                  className="min-h-11 flex-1 rounded-xl border border-slate-500/50 bg-white/5 px-4 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={creating || !formData.username.trim() || !formData.password}
                  className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 px-4 text-sm font-semibold text-white shadow-lg shadow-blue-950/30 transition-colors hover:from-blue-500 hover:to-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {creating ? (
                    <>
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                      建立中…
                    </>
                  ) : (
                    '建立帳號'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deletingAdminId && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="delete-admin-title" className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-rose-400/25 bg-slate-900 shadow-2xl shadow-slate-950/60">
            <div className="flex items-center gap-3 border-b border-rose-400/20 bg-gradient-to-r from-rose-950/75 via-slate-900 to-slate-900 px-5 py-4 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-rose-400/25 bg-rose-500/15 text-rose-200">
                <Trash2 className="h-5 w-5" />
              </div>
              <div>
                <h3 id="delete-admin-title" className="text-lg font-semibold text-white">刪除管理員</h3>
                <p className="mt-0.5 text-xs text-rose-200/75">此操作無法復原</p>
              </div>
            </div>
            <div className="space-y-5 p-5 sm:p-6">
              <div>
                <p className="text-sm text-slate-300">確定要刪除以下管理員嗎？</p>
                <div className="mt-3 flex items-center gap-3 rounded-xl border border-rose-400/20 bg-rose-950/20 px-3.5 py-3">
                  <Shield className="h-5 w-5 shrink-0 text-rose-300" />
                  <span className="min-w-0 break-words text-sm font-semibold text-white">{deletingAdmin?.username}</span>
                </div>
              </div>
              {deleteError && (
                <div role="alert" className="rounded-lg border border-rose-500/30 bg-rose-950/40 p-3 text-sm text-rose-200">
                  {deleteError}
                </div>
              )}
              <div className="flex gap-3 border-t border-slate-700/70 pt-4">
                <button
                  onClick={() => {
                    setDeletingAdminId(null);
                    setDeleteError(null);
                  }}
                  className="min-h-10 flex-1 rounded-lg border border-slate-600 bg-slate-800 px-4 text-sm text-slate-200 transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                >
                  取消
                </button>
                <button
                  onClick={() => handleDeleteAdmin(deletingAdminId)}
                  className="min-h-10 flex-1 rounded-lg bg-rose-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
                >
                  確認刪除
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingAdmin && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div role="dialog" aria-modal="true" aria-labelledby="edit-admin-title" className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-cyan-300/25 bg-[#18283d] shadow-2xl shadow-slate-950/70">
            <div className="flex items-center gap-3 border-b border-cyan-300/20 bg-gradient-to-r from-[#1d3b61] via-[#1b3651] to-[#164752] px-5 py-5 sm:px-6">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-cyan-200/25 bg-white/10 text-cyan-100 shadow-sm">
                <Edit2 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h3 id="edit-admin-title" className="text-lg font-semibold text-white">編輯管理員</h3>
                <p className="mt-0.5 truncate text-xs text-cyan-100/75">{editingAdmin.username}</p>
              </div>
            </div>

            <form onSubmit={handleUpdateAdmin} className="space-y-5 p-5 sm:p-6">
              {editError && (
                <div className="rounded-lg border border-rose-500/30 bg-rose-950/40 p-3 text-sm text-rose-200">
                  {editError}
                </div>
              )}

              <div>
                <label htmlFor="edit-admin-username" className="mb-2 block text-xs font-semibold tracking-wide text-slate-200">登入帳號</label>
                <input
                  id="edit-admin-username"
                  type="text"
                  autoComplete="username"
                  value={editFormData.username}
                  onChange={(e) => setEditFormData({ ...editFormData, username: e.target.value })}
                  required
                  className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 text-sm text-slate-900 shadow-sm outline-none transition-colors focus:border-cyan-500 focus:ring-2 focus:ring-cyan-400/30"
                />
              </div>

              <div>
                <label htmlFor="edit-admin-password" className="mb-2 block text-xs font-semibold tracking-wide text-slate-200">
                  新密碼 <span className="text-slate-400">（留空則保持不變）</span>
                </label>
                <div className="relative">
                  <input
                    id="edit-admin-password"
                    type={showEditPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={editFormData.password}
                    onChange={(e) => setEditFormData({ ...editFormData, password: e.target.value })}
                    placeholder="輸入新密碼"
                    className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3.5 pr-11 text-sm text-slate-900 shadow-sm outline-none placeholder:text-slate-400 focus:border-cyan-500 focus:ring-2 focus:ring-cyan-400/30"
                  />
                  <button
                    type="button"
                    onClick={() => setShowEditPassword(!showEditPassword)}
                    aria-label={showEditPassword ? '隱藏新密碼' : '顯示新密碼'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-slate-500 transition-colors hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
                  >
                    {showEditPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                  </button>
                </div>
                <p className="mt-1.5 text-xs text-slate-400">若修改密碼，至少需要 6 個字元</p>
              </div>

              <div className="flex gap-3 border-t border-white/10 pt-5">
                <button
                  type="button"
                  onClick={() => {
                    setEditingAdmin(null);
                    setEditFormData({ username: '', password: '' });
                    setShowEditPassword(false);
                    setEditError(null);
                  }}
                  disabled={updating}
                  className="min-h-11 flex-1 rounded-xl border border-slate-500/50 bg-white/5 px-4 text-sm font-medium text-slate-100 transition-colors hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={updating || !editFormData.username.trim()}
                  className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-cyan-600 px-4 text-sm font-semibold text-white shadow-lg shadow-blue-950/30 transition-colors hover:from-blue-500 hover:to-cyan-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {updating ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      儲存中…
                    </>
                  ) : (
                    '儲存變更'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
