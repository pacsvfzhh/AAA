import { useState, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Lock, Eye, EyeOff, AlertCircle, CheckCircle, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { getEmployeeFinancialSession } from '../../lib/auth';
import { useLanguage } from '../../lib/i18n/context';

interface PasswordChangeProps {
  employeeId: string;
  onClose: () => void;
  onLogout: () => void;
}

export default function PasswordChange({ employeeId, onClose, onLogout }: PasswordChangeProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const { t } = useLanguage();

  useLayoutEffect(() => {
    const scrollY = window.scrollY;
    const body = document.body;
    const previousStyles = {
      position: body.style.position,
      top: body.style.top,
      left: body.style.left,
      right: body.style.right,
      overflow: body.style.overflow,
    };
    body.style.position = 'fixed';
    body.style.top = `-${scrollY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.overflow = 'hidden';
    return () => {
      Object.assign(body.style, previousStyles);
      window.scrollTo({ top: scrollY, behavior: 'instant' });
    };
  }, []);

  const validatePassword = (password: string): string | null => {
    if (password.length < 8) {
      return t.passwordChange.errorMinLength;
    }
    const hasLetter = /[a-zA-Z]/.test(password);
    const hasNumber = /[0-9]/.test(password);
    if (!hasLetter || !hasNumber) {
      return t.passwordChange.errorLettersNumbers;
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (!currentPassword || !newPassword || !confirmPassword) {
      setError(t.passwordChange.allFieldsRequired);
      return;
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }

    if (newPassword !== confirmPassword) {
      setError(t.passwordChange.errorMismatch);
      return;
    }

    if (currentPassword === newPassword) {
      setError(t.passwordChange.errorSameAsCurrent);
      return;
    }

    setLoading(true);

    try {
      const financialSession = getEmployeeFinancialSession();
      const { data, error: updateError } = await supabase.rpc('change_employee_password_atomic', {
        p_user_id: employeeId,
        p_session_token: financialSession.token,
        p_tab_id: financialSession.tabId,
        p_current_password: currentPassword,
        p_new_password: newPassword,
      });

      if (updateError) throw updateError;
      if (!data) throw new Error(t.passwordChange.errorGeneric);

      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');

      setTimeout(() => {
        onClose();
        onLogout();
      }, 2000);

    } catch (error: unknown) {
      console.error('Error changing password:', error);
      setError(error instanceof Error ? error.message : t.passwordChange.errorGeneric);
    } finally {
      setLoading(false);
    }
  };

  return createPortal(
    <div className="employee-modal-backdrop fixed inset-0 bg-slate-900/50 flex items-center justify-center z-[10000] p-4" style={{ touchAction: 'none', overscrollBehavior: 'contain' }}>
      <div className="employee-modal-surface bg-white rounded-2xl shadow-2xl shadow-slate-900/20 max-w-md w-full max-h-[90vh] overflow-y-auto">
        {/* Premium Header */}
        <div className="relative px-6 py-5 bg-gradient-to-br from-blue-600 via-blue-700 to-blue-800 overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,_rgba(255,255,255,0.12)_0%,_transparent_60%)]" />
          <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent" />
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/15 rounded-xl flex items-center justify-center backdrop-blur-sm border border-white/20">
                <Lock className="w-5 h-5 text-white" />
              </div>
              <h2 className="text-lg font-bold text-white">{t.passwordChange.title}</h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="password-change-close emp-close-btn emp-close-btn--wrap group -mr-1.5 flex flex-shrink-0 items-center justify-center rounded-xl text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              style={{ WebkitTapHighlightColor: 'transparent' }}
              aria-label={t.common.close}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/20 bg-white/15 transition-all group-hover:bg-white/25 group-active:scale-95">
                <X className="h-4 w-4 shrink-0" strokeWidth={2.5} />
              </span>
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {error && (
            <div className="bg-red-50 border border-red-100 rounded-xl p-4 flex items-start gap-3">
              <div className="w-8 h-8 bg-red-100 rounded-lg flex items-center justify-center flex-shrink-0">
                <AlertCircle className="w-4 h-4 text-red-500" />
              </div>
              <p className="text-red-600 text-sm mt-1.5">{error}</p>
            </div>
          )}

          {success && (
            <div className="bg-emerald-50 border border-emerald-100 rounded-xl p-4 flex items-start gap-3">
              <div className="w-8 h-8 bg-emerald-100 rounded-lg flex items-center justify-center flex-shrink-0">
                <CheckCircle className="w-4 h-4 text-emerald-500" />
              </div>
              <p className="text-emerald-600 text-sm mt-1.5">{t.passwordChange.success}</p>
            </div>
          )}

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              {t.passwordChange.currentPassword}
            </label>
            <div className="relative group">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2 w-8 h-8 bg-blue-50 group-focus-within:bg-blue-100 rounded-lg flex items-center justify-center transition-colors">
                <Lock className="w-4 h-4 text-blue-500" />
              </div>
              <input
                type={showCurrentPassword ? 'text' : 'password'}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full pl-14 pr-12 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 focus:bg-white transition-all"
                placeholder={t.passwordChange.currentPasswordPlaceholder}
                disabled={loading || success}
              />
              <button
                type="button"
                onClick={() => setShowCurrentPassword(!showCurrentPassword)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg hover:bg-slate-200 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-all"
              >
                {showCurrentPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              {t.passwordChange.newPassword}
            </label>
            <div className="relative group">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2 w-8 h-8 bg-blue-50 group-focus-within:bg-blue-100 rounded-lg flex items-center justify-center transition-colors">
                <Lock className="w-4 h-4 text-blue-500" />
              </div>
              <input
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full pl-14 pr-12 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 focus:bg-white transition-all"
                placeholder={t.passwordChange.newPasswordPlaceholder}
                disabled={loading || success}
              />
              <button
                type="button"
                onClick={() => setShowNewPassword(!showNewPassword)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg hover:bg-slate-200 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-all"
              >
                {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">
              {t.passwordChange.confirmPassword}
            </label>
            <div className="relative group">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2 w-8 h-8 bg-blue-50 group-focus-within:bg-blue-100 rounded-lg flex items-center justify-center transition-colors">
                <Lock className="w-4 h-4 text-blue-500" />
              </div>
              <input
                type={showConfirmPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full pl-14 pr-12 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 focus:bg-white transition-all"
                placeholder={t.passwordChange.confirmPasswordPlaceholder}
                disabled={loading || success}
              />
              <button
                type="button"
                onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg hover:bg-slate-200 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-all"
              >
                {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="bg-gradient-to-br from-blue-50 to-sky-50 border border-blue-100/80 rounded-xl p-4">
            <h4 className="text-sm font-semibold text-blue-700 mb-2">{t.passwordChange.requirements}</h4>
            <ul className="text-xs text-blue-600/80 space-y-1.5">
              <li className="flex items-center gap-2">
                <div className="w-1 h-1 bg-blue-400 rounded-full" />
                {t.passwordChange.reqMinLength}
              </li>
              <li className="flex items-center gap-2">
                <div className="w-1 h-1 bg-blue-400 rounded-full" />
                {t.passwordChange.reqLettersNumbers}
              </li>
              <li className="flex items-center gap-2">
                <div className="w-1 h-1 bg-blue-400 rounded-full" />
                {t.passwordChange.reqDifferent}
              </li>
            </ul>
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 min-h-[44px] px-4 py-3.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-semibold transition-all border border-slate-200"
              disabled={loading}
            >
              {t.passwordChange.cancel}
            </button>
            <button
              type="submit"
              disabled={loading || success}
              className="flex-1 min-h-[44px] px-4 py-3.5 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white rounded-xl font-semibold transition-all shadow-lg shadow-blue-600/25 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
            >
              {loading ? '...' : t.passwordChange.submit}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
