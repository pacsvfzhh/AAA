import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle, Loader2, LockKeyhole, RefreshCw, Shield } from 'lucide-react';
import { getAdminFinancialSessionToken } from '../../lib/auth';
import { isFinancialAdminSessionError, isSupabaseTransientError, supabase } from '../../lib/supabase';

interface EmployeeLoginMaintenanceSettingsProps {
  ownerAdminId: string;
  ownerName: string;
  // Let a containing dialog prevent closing or submitting its brand form during a write.
  onSavingChange?: (saving: boolean) => void;
}

interface MaintenanceState {
  ownerAdminId: string;
  enabled: boolean;
  updatedAt: string | null;
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
);

const formatTime = (value: string | number | null) => {
  if (value === null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date)}（UTC+8）`;
};

export default function EmployeeLoginMaintenanceSettings({
  ownerAdminId, ownerName, onSavingChange,
}: EmployeeLoginMaintenanceSettingsProps) {
  const id = useId();
  const [maintenance, setMaintenance] = useState<MaintenanceState | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [confirmationTarget, setConfirmationTarget] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const mountedRef = useRef(false);
  const requestSequence = useRef(0);
  const savingRef = useRef(false);
  const currentOwnerRef = useRef(ownerAdminId);
  const savingChangeRef = useRef(onSavingChange);
  const passwordRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const restoreActionRef = useRef(false);
  currentOwnerRef.current = ownerAdminId;
  savingChangeRef.current = onSavingChange;

  const locked = lockedUntil !== null && lockedUntil > now;
  const ready = !loading && !readError && maintenance?.ownerAdminId === ownerAdminId;
  const enabled = ready ? maintenance.enabled : null;

  const loadSettings = useCallback(async () => {
    if (savingRef.current) return;
    const sequence = ++requestSequence.current;
    const isCurrent = () => mountedRef.current && sequence === requestSequence.current
      && currentOwnerRef.current === ownerAdminId;
    setLoading(true);
    setReadError('');
    setSaveError('');
    setNotice('');
    setConfirmationTarget(null);
    setPassword('');
    try {
      const { data, error } = await supabase.rpc('get_employee_login_maintenance', {
        p_admin_session_token: getAdminFinancialSessionToken(), p_owner_admin_id: ownerAdminId,
      });
      if (error) throw error;
      const result = asRecord(data);
      if (!result || result.owner_admin_id !== ownerAdminId || typeof result.enabled !== 'boolean'
        || !(result.updated_at === null || typeof result.updated_at === 'string')) throw new Error('Unavailable');
      if (!isCurrent()) return;
      setMaintenance({ ownerAdminId, enabled: result.enabled, updatedAt: result.updated_at });
    } catch (error) {
      if (!isCurrent()) return;
      const code = asRecord(error)?.code;
      setReadError(['PGRST202', '42883', '42P01'].includes(String(code))
        ? '維護功能的資料庫更新尚未部署，或伺服器介面尚未重新載入。請先完成後端更新，再重新讀取狀態；目前無法開啟維護。'
        : isFinancialAdminSessionError(error)
          ? '管理員登入已失效，請重新登入後讀取維護狀態。'
          : code === '42501'
            ? '目前管理員沒有讀取此團隊維護狀態的權限。'
            : isSupabaseTransientError(error)
              ? '暫時無法連線至伺服器，請檢查網路後重新讀取維護狀態。'
              : '無法讀取此團隊的維護狀態，請確認團隊是否仍存在及後端更新是否完整，再重試。');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [ownerAdminId]);

  useEffect(() => {
    mountedRef.current = true;
    setMaintenance(null);
    setSaving(false);
    setLockedUntil(null);
    restoreActionRef.current = false;
    void loadSettings();
    return () => {
      mountedRef.current = false;
      requestSequence.current += 1;
      if (savingRef.current) savingChangeRef.current?.(false);
      savingRef.current = false;
    };
  }, [loadSettings]);

  useEffect(() => {
    if (lockedUntil === null) return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (time >= lockedUntil) {
        setLockedUntil(null);
        setSaveError('鎖定時間已結束，請重新輸入目前操作者的管理員密碼。');
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [lockedUntil]);

  useEffect(() => {
    if (saving) return;
    if (confirmationTarget !== null && !locked) passwordRef.current?.focus();
    else if (confirmationTarget === null && restoreActionRef.current) {
      restoreActionRef.current = false;
      actionRef.current?.focus();
    }
  }, [confirmationTarget, locked, saving]);

  useEffect(() => {
    if (!saving) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [saving]);

  const cancelConfirmation = () => {
    if (savingRef.current) return;
    restoreActionRef.current = true;
    setPassword('');
    setSaveError('');
    setConfirmationTarget(null);
  };

  const saveSettings = async () => {
    if (savingRef.current || !ready || confirmationTarget === null || !password || locked) return;
    const sequence = ++requestSequence.current;
    const isCurrent = () => mountedRef.current && sequence === requestSequence.current
      && currentOwnerRef.current === ownerAdminId;
    savingRef.current = true;
    setSaving(true);
    savingChangeRef.current?.(true);
    setPassword('');
    setSaveError('');
    setNotice('');
    try {
      const { data, error } = await supabase.rpc('set_employee_login_maintenance', {
        p_admin_session_token: getAdminFinancialSessionToken(), p_owner_admin_id: ownerAdminId,
        p_admin_password: password, p_enabled: confirmationTarget,
      });
      if (!isCurrent()) return;
      const result = asRecord(data);
      if (error || !result || (result.owner_admin_id !== undefined && result.owner_admin_id !== ownerAdminId)) {
        throw new Error('Unavailable');
      }
      if (result.success === false && result.error === 'invalid_password') {
        setSaveError('管理員密碼不正確，請重新輸入目前操作者的密碼後再試。');
        return;
      }
      if (result.success === false && result.error === 'confirmation_locked') {
        const until = typeof result.locked_until === 'string' ? Date.parse(result.locked_until) : NaN;
        setNow(Date.now());
        setLockedUntil(Number.isFinite(until) && until > Date.now() ? until : null);
        setSaveError('密碼確認暫時鎖定，請稍後再試。此團隊的維護狀態未因本次確認而變更。');
        return;
      }
      if (result.success !== true || typeof result.enabled !== 'boolean') throw new Error('Unavailable');
      setMaintenance({ ownerAdminId, enabled: result.enabled, updatedAt: typeof result.updated_at === 'string' ? result.updated_at : null });
      setLockedUntil(null);
      restoreActionRef.current = true;
      setConfirmationTarget(null);
      setNotice(result.enabled ? '已開啟此團隊維護，員工工作已停止，舊會話已失效。' : '已關閉此團隊維護，員工可重新登入；不會自動恢復舊會話或工作。');
    } catch {
      if (isCurrent()) {
        setConfirmationTarget(null);
        setReadError('未能確認儲存結果，請重新讀取狀態後再操作。請確認登入狀態、管理權限及網路連線；系統不會自動重送。');
      }
    } finally {
      if (isCurrent()) {
        savingRef.current = false;
        setSaving(false);
        savingChangeRef.current?.(false);
      }
    }
  };

  const updatedAt = ready ? formatTime(maintenance.updatedAt) : null;
  const focusClass = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';

  return (
    <section
      aria-labelledby={`${id}-title`}
      aria-busy={loading || saving}
      className="rounded-xl border border-cyan-300/25 bg-gradient-to-br from-slate-950/85 via-slate-900/90 to-cyan-950/50 p-4 sm:p-5"
      onKeyDown={event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          if (event.nativeEvent.isComposing || savingRef.current) return;
          if (event.target === passwordRef.current) void saveSettings();
          else if (event.target instanceof HTMLButtonElement && !event.target.disabled) event.target.click();
        } else if (event.key === 'Escape' && (confirmationTarget !== null || savingRef.current)) {
          event.preventDefault();
          event.stopPropagation();
          cancelConfirmation();
        }
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Shield className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" aria-hidden="true" />
          <div className="min-w-0">
            <h3 id={`${id}-title`} className="text-sm font-semibold text-cyan-50">員工團隊維護</h3>
            <p className="mt-1 break-all text-xs text-slate-300">所屬管理員：{ownerName}</p>
          </div>
        </div>
        <span role="status" className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${enabled === true ? 'border-amber-300/50 bg-amber-400/15 text-amber-200' : enabled === false ? 'border-emerald-300/40 bg-emerald-400/10 text-emerald-200' : 'border-slate-500/50 bg-slate-800 text-slate-300'}`}>
          {enabled === true ? <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> : enabled === false ? <CheckCircle className="h-3.5 w-3.5" aria-hidden="true" /> : loading ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
          {enabled === true ? '維護中 · 全員停工' : enabled === false ? '正常 · 允許登入與工作' : loading ? '正在讀取狀態…' : '狀態未確認'}
        </span>
      </div>
      <p id={`${id}-scope`} className="mt-3 text-xs leading-6 text-slate-300">開啟後，此管理員名下所有員工（包含已在線及「記住我」會話）立即停止工作，舊登入失效；在線員工收到維護提示，確認後退出。維護期間重新登入也會顯示提示。管理員及其他團隊不受影響，與品牌設定來源無關。</p>
      <p className="text-xs leading-6 text-slate-400">已提交的訂單繼續正常結算，不刪除訂單或資金紀錄。關閉維護後，員工須重新登入並手動開工。每次開啟或關閉皆須輸入目前操作者的管理員密碼，獨立儲存，不需按品牌的「儲存設定」。</p>
      {updatedAt && <p className="mt-1 text-[11px] text-slate-400">最近更新：{updatedAt}</p>}

      {readError && (
        <div className="mt-3 rounded-lg border border-rose-300/30 bg-rose-950/30 p-3">
          <p role="alert" className="text-xs leading-5 text-rose-100">{readError}</p>
          <button type="button" onClick={() => void loadSettings()} disabled={loading || saving} className={`mt-2 inline-flex min-h-9 items-center gap-2 rounded-lg border border-cyan-300/40 px-3 text-xs font-semibold text-cyan-100 hover:bg-cyan-400/10 disabled:opacity-50 ${focusClass}`}><RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />重新讀取狀態</button>
        </div>
      )}
      {notice && <p role="status" className="mt-3 text-xs leading-5 text-emerald-200">{notice}</p>}
      {locked && <p id={`${id}-locked`} role="status" className="mt-3 text-xs leading-5 text-amber-200">密碼確認已暫時鎖定，請於 {formatTime(lockedUntil)} 後再試。</p>}

      {ready && confirmationTarget === null && (
        <button
          ref={actionRef}
          type="button"
          aria-expanded={false}
          aria-controls={`${id}-confirmation`}
          aria-describedby={`${id}-scope`}
          onClick={() => {
            setPassword('');
            setSaveError('');
            setNotice('');
            setConfirmationTarget(!maintenance.enabled);
          }}
          disabled={saving}
          className={`mt-3 inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${enabled ? 'border-emerald-300/40 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/20' : 'border-amber-300/40 bg-amber-400/10 text-amber-100 hover:bg-amber-400/20'} ${focusClass}`}
        >
          <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />{enabled ? '關閉維護，恢復登入' : '開啟維護，停止團隊工作'}
        </button>
      )}

      {ready && confirmationTarget !== null && (
        <div id={`${id}-confirmation`} className="mt-4 space-y-3 rounded-lg border border-cyan-300/25 bg-slate-950/60 p-3 sm:p-4">
          <p className="text-sm font-semibold text-slate-100">確認{confirmationTarget ? '開啟' : '關閉'}「{ownerName}」團隊維護</p>
          {confirmationTarget && <p className="text-xs leading-6 text-amber-200">此操作會立即停止本團隊所有員工的工作並使舊登入失效，包含在線及「記住我」會話；關閉維護不會自動恢復工作。請確認後再繼續。</p>}
          <label htmlFor={`${id}-password`} className="block text-xs font-medium text-cyan-100">目前操作者的管理員密碼（不是目標管理員的密碼）</label>
          <input
            ref={passwordRef}
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            autoCapitalize="none"
            spellCheck={false}
            value={password}
            onChange={event => setPassword(event.target.value)}
            disabled={saving || locked}
            aria-invalid={Boolean(saveError)}
            aria-describedby={saveError ? `${id}-error` : locked ? `${id}-locked` : `${id}-scope`}
            className="block h-10 w-full rounded-lg border border-slate-500 bg-slate-900 px-3 text-sm text-white outline-none focus:border-cyan-300 focus:ring-2 focus:ring-cyan-300/30 disabled:opacity-60"
          />
          {saveError && <p id={`${id}-error`} role="alert" className="text-xs leading-5 text-amber-200">{saveError}</p>}
          <p role={saving ? 'status' : undefined} className="text-xs leading-5 text-slate-400">{saving ? '正在儲存，請勿關閉面板、切換頁面或重新整理；請等待伺服器回覆。' : '送出後請等待結果；儲存期間無法取消或關閉此編輯面板。'}</p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={cancelConfirmation} disabled={saving} className={`min-h-9 rounded-lg border border-slate-500/60 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-white/10 disabled:opacity-50 ${focusClass}`}>取消</button>
            <button type="button" onClick={() => void saveSettings()} disabled={saving || locked || !password} className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-cyan-700 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:opacity-50 ${focusClass}`}>
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}{saving ? '正在儲存…' : confirmationTarget ? '確認開啟維護' : '確認關閉維護'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
