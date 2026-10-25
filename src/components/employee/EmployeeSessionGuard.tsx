import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getStoredAuth, logout } from '../../lib/auth';
import { supabase } from '../../lib/supabase';
import { tabSessionManager } from '../../lib/TabSessionManager';
import { useLanguage } from '../../lib/i18n/context';
import EmployeeMaintenanceDialog from '../EmployeeMaintenanceDialog';
import EmployeeBootScreen from './EmployeeBootScreen';
import SessionExpiredModal from './SessionExpiredModal';

type SessionView = 'checking' | 'active' | 'maintenance' | 'expired' | 'unavailable';

interface EmployeeSessionGuardProps {
  employeeId: string;
  children: (onSessionInvalid: () => void) => ReactNode;
}

export default function EmployeeSessionGuard({ employeeId, children }: EmployeeSessionGuardProps) {
  const [view, setView] = useState<SessionView>('checking');
  const [leaving, setLeaving] = useState(false);
  const viewRef = useRef(view);
  const mountedRef = useRef(false);
  const sequenceRef = useRef(0);
  const leavingRef = useRef(false);
  const { t } = useLanguage();

  const updateView = useCallback((next: SessionView) => {
    if (viewRef.current === 'maintenance') return;
    viewRef.current = next;
    setView(next);
    if (next === 'maintenance' || next === 'expired') tabSessionManager.stopSession(false);
  }, []);

  const checkSession = useCallback(async (block = false) => {
    if (!mountedRef.current || viewRef.current === 'maintenance' || leavingRef.current) return;
    const sequence = ++sequenceRef.current;
    if (block) updateView('checking');
    const auth = getStoredAuth();
    if (!auth || auth.userType !== 'employee' || auth.user.id !== employeeId) {
      updateView('expired');
      return;
    }
    try {
      const { data, error } = await supabase.rpc('get_employee_maintenance_status', {
        p_user_id: employeeId,
        p_session_token: auth.financialSessionToken,
        p_tab_id: auth.tabId,
      });
      if (error) throw error;
      if (!data || typeof data.maintenance !== 'boolean' || typeof data.session_valid !== 'boolean') {
        throw new Error('Invalid employee session status');
      }
      if (!mountedRef.current || sequence !== sequenceRef.current) return;
      updateView(data.maintenance ? 'maintenance' : data.session_valid ? 'active' : 'expired');
    } catch {
      if (mountedRef.current && sequence === sequenceRef.current && viewRef.current !== 'active') {
        updateView('unavailable');
      }
    }
  }, [employeeId, updateView]);

  useEffect(() => {
    mountedRef.current = true;
    const channel = supabase.channel(`employee-session-guard-${employeeId}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'users', filter: `id=eq.${employeeId}` }, payload => {
        const auth = getStoredAuth();
        if (auth?.userType === 'employee' && payload.new.current_session_token !== auth.sessionToken) void checkSession(true);
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') void checkSession();
      });
    void checkSession();
    const recover = () => {
      if (document.visibilityState === 'visible') void checkSession();
    };
    const timer = window.setInterval(recover, 15000);
    window.addEventListener('online', recover);
    window.addEventListener('pageshow', recover);
    window.addEventListener('focus', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      mountedRef.current = false;
      sequenceRef.current += 1;
      window.clearInterval(timer);
      window.removeEventListener('online', recover);
      window.removeEventListener('pageshow', recover);
      window.removeEventListener('focus', recover);
      document.removeEventListener('visibilitychange', recover);
      void supabase.removeChannel(channel);
    };
  }, [checkSession, employeeId]);

  const handleSessionInvalid = useCallback(() => { void checkSession(true); }, [checkSession]);
  const handleLogout = useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    setLeaving(true);
    void logout(false);
  }, []);

  if (view === 'active') return children(handleSessionInvalid);
  if (view === 'maintenance') return <EmployeeMaintenanceDialog sessionEnded busy={leaving} onClose={handleLogout} />;
  if (view === 'expired') return <SessionExpiredModal isOpen onClose={handleLogout} />;
  if (view === 'unavailable') {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-slate-50 p-6">
        <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 text-center shadow-lg">
          <p role="alert" className="text-sm leading-6 text-slate-700">{t.login.errorNetwork}</p>
          <button type="button" onClick={handleSessionInvalid} className="mt-5 min-h-11 rounded-xl bg-blue-700 px-5 py-3 text-sm font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700">{t.common.retry}</button>
          <button type="button" onClick={handleLogout} disabled={leaving} className="mt-3 block min-h-11 w-full rounded-xl px-5 py-3 text-sm font-medium text-slate-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-700">{t.session.returnToLogin}</button>
        </section>
      </main>
    );
  }
  return <EmployeeBootScreen />;
}
