import { useState, useEffect, lazy, Suspense } from 'react';
import { flushSync } from 'react-dom';
import Login from './pages/Login';
import BlockchainBackground from './components/BlockchainBackground';
import ErrorBoundary from './components/ErrorBoundary';
import PhoneLandscapeGuard from './components/PhoneLandscapeGuard';
import EmployeeBootScreen from './components/employee/EmployeeBootScreen';
import EmployeeSessionGuard from './components/employee/EmployeeSessionGuard';
import { LanguageProvider } from './lib/i18n';
import {
  AUTH_HANDOVER_EVENT,
  AUTH_LOGOUT_EVENT,
  getStoredAuth,
  hasRememberedSession,
  PROFILE_UPDATED_EVENT,
  resumeRememberedSession,
} from './lib/auth';
import { useDeviceOptimization } from './lib/useDeviceOptimization';
import { useResponsive, useApplyResponsiveMeta } from './lib/useResponsive';
import type { AuthState } from './types';

const loadEmployeeDashboard = () => import('./components/employee/EmployeeDashboard');
const EmployeeDashboard = lazy(loadEmployeeDashboard);
const AdminDashboard = lazy(() => import('./components/admin/AdminDashboard'));

const EMPTY_AUTH_STATE: AuthState = {
  user: null,
  userType: null,
};

function App() {
  const [authState, setAuthState] = useState<AuthState>(() => getStoredAuth() || EMPTY_AUTH_STATE);
  const [resumingSession, setResumingSession] = useState(() => !getStoredAuth() && hasRememberedSession());

  const { deviceName, tier, isLowEnd } = useDeviceOptimization();
  const responsive = useResponsive();
  useApplyResponsiveMeta();

  useEffect(() => {
    const setVH = () => {
      const vh = window.innerHeight * 0.01;
      document.documentElement.style.setProperty('--vh', `${vh}px`);
    };
    setVH();
    // Scrolling collapses the mobile toolbar and changes innerHeight; resizing body/#root min-height on each of
    // those re-lays out the whole page mid-scroll, so only a real width change (rotation, window resize) updates --vh.
    let lastWidth = window.innerWidth;
    const handleResize = () => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      setVH();
    };
    const handleOrientation = () => {
      lastWidth = window.innerWidth;
      setVH();
      window.setTimeout(setVH, 300);
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleOrientation);

    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleOrientation);
    };
  }, []);

  useEffect(() => {
    console.log(`[App] Device Mode: ${deviceName} (${tier})`);
    console.log(`[App] Screen: ${responsive.deviceName} (${responsive.width}x${responsive.height})`);
    console.log(`[App] Pixel Ratio: ${responsive.pixelRatio}x`);
    console.log(`[App] Layout: ${JSON.stringify({
      compactMode: responsive.compactMode,
      needsSafeArea: responsive.needsSafeArea,
      isNotchDevice: responsive.isNotchDevice
    })}`);
    if (isLowEnd) {
      console.log('[App] Low-end device detected, performance optimizations active');
    }
  }, [
    deviceName,
    tier,
    isLowEnd,
    responsive.width,
    responsive.height,
    responsive.compactMode,
    responsive.deviceName,
    responsive.isNotchDevice,
    responsive.needsSafeArea,
    responsive.pixelRatio,
  ]);

  useEffect(() => {
    if (!resumingSession) return;

    let cancelled = false;
    void loadEmployeeDashboard();
    void resumeRememberedSession().then((restored) => {
      if (cancelled) return;
      if (restored) setAuthState(restored);
      setResumingSession(false);
    });

    return () => {
      cancelled = true;
    };
  }, [resumingSession]);

  useEffect(() => {
    const stored = getStoredAuth();
    if (stored) {
      setAuthState(stored);
    }

    const handleLogout = () => {
      setAuthState({ user: null, userType: null });
    };
    window.addEventListener(AUTH_LOGOUT_EVENT, handleLogout);

    // Unmount synchronously so the old dashboard's listeners cannot act on the session the new tab owns.
    const handleHandover = () => {
      flushSync(() => setAuthState({ user: null, userType: null }));
    };
    window.addEventListener(AUTH_HANDOVER_EVENT, handleHandover);

    const handleProfileUpdate = () => {
      const updated = getStoredAuth();
      if (updated) {
        setAuthState(updated);
      }
    };
    window.addEventListener(PROFILE_UPDATED_EVENT, handleProfileUpdate);

    return () => {
      window.removeEventListener(AUTH_LOGOUT_EVENT, handleLogout);
      window.removeEventListener(AUTH_HANDOVER_EVENT, handleHandover);
      window.removeEventListener(PROFILE_UPDATED_EVENT, handleProfileUpdate);
    };
  }, []);

  const onLoginScreen = !resumingSession && (!authState.user || !authState.userType);
  useEffect(() => {
    if (!onLoginScreen) return;
    const timer = setTimeout(() => void loadEmployeeDashboard(), 1500);
    return () => clearTimeout(timer);
  }, [onLoginScreen]);

  const handleLoginSuccess = () => {
    const stored = getStoredAuth();
    if (stored) {
      setAuthState(stored);
    }
  };

  if (resumingSession) {
    return (
      <LanguageProvider>
        <EmployeeBootScreen />
      </LanguageProvider>
    );
  }

  if (!authState.user || !authState.userType) {
    return (
      <LanguageProvider>
        <BlockchainBackground />
        <Login onLoginSuccess={handleLoginSuccess} />
        <PhoneLandscapeGuard />
      </LanguageProvider>
    );
  }

  if (authState.userType === 'employee') {
    const employee = authState.user;
    return (
      <LanguageProvider>
        <ErrorBoundary>
          <EmployeeSessionGuard key={employee.id} employeeId={employee.id}>
            {onSessionInvalid => (
              <Suspense fallback={<EmployeeBootScreen />}>
                <EmployeeDashboard employee={employee} onSessionInvalid={onSessionInvalid} />
              </Suspense>
            )}
          </EmployeeSessionGuard>
        </ErrorBoundary>
      </LanguageProvider>
    );
  }

  if (authState.userType === 'admin') {
    return (
      <>
        <ErrorBoundary>
          <Suspense fallback={null}>
            <AdminDashboard admin={authState.user} />
          </Suspense>
        </ErrorBoundary>
      </>
    );
  }

  return null;
}

export default App;
