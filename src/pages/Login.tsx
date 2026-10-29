import { useState, useEffect } from 'react';
import { Shield, Lock, Globe, Package, ClipboardCheck, ArrowRight, AlertTriangle, ShieldAlert, Clock, Info, Check, Eye, EyeOff } from 'lucide-react';
import {
  AccountLockedError,
  EmployeeLoginMaintenanceError,
  clearOpenedElsewhereNotice,
  getRememberedUsername,
  hasOpenedElsewhereNotice,
  login,
  saveRememberMe,
  storeAuth,
} from '../lib/auth';
import { useCompanyName } from '../lib/useCompanyName';
import { useResponsive } from '../lib/useResponsive';
import { checkLoginRateLimit, recordLoginAttempt } from '../lib/rateLimitService';
import { getUserIP } from '../lib/loginHistoryService';
import { formatSupabaseError, isSupabaseAbortError, isSupabaseTransientError, supabase, supabaseConfigurationError } from '../lib/supabase';
import { useLanguage } from '../lib/i18n/context';
import { LANGUAGES } from '../lib/i18n/types';
import { LanguageModal } from '../components/LanguageSwitcher';
import type { Language } from '../lib/i18n/types';
import LoginDecorations from '../components/LoginDecorations';
import EmployeeMaintenanceDialog from '../components/EmployeeMaintenanceDialog';

interface LoginProps {
  onLoginSuccess: () => void;
}

// Kinds instead of text: the server's lock reasons and errors are fixed English, and a stored kind re-renders in the new language if it changes.
type LoginErrorKind = 'invalid' | 'deactivated' | 'network' | 'unavailable' | 'failed' | 'locked';

const ALERT_TONES = {
  error: { surface: 'from-rose-50 via-white to-white ring-rose-200/80', icon: 'from-rose-500 to-red-500 shadow-rose-500/30', title: 'text-rose-950', text: 'text-slate-600' },
  warning: { surface: 'from-amber-50 via-white to-white ring-amber-200/80', icon: 'from-amber-400 to-orange-500 shadow-amber-500/30', title: 'text-amber-950', text: 'text-slate-600' },
};

function LoginAlert({ tone, icon: Icon, title, message, compact, children }: {
  tone: keyof typeof ALERT_TONES;
  icon: typeof Lock;
  title: string;
  message: string;
  compact: boolean;
  children?: React.ReactNode;
}) {
  const s = ALERT_TONES[tone];
  return (
    <div role="alert" className={`login-alert rounded-2xl bg-gradient-to-br shadow-[0_12px_28px_-20px_rgba(15,23,42,0.5)] ring-1 ${s.surface} ${compact ? 'p-3' : 'p-3.5'}`}>
      <div className="flex items-start gap-3">
        <span className={`flex shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md ${s.icon} ${compact ? 'h-8 w-8' : 'h-9 w-9'}`}>
          <Icon className={compact ? 'h-4 w-4' : 'h-[18px] w-[18px]'} strokeWidth={2.25} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`font-bold leading-snug ${s.title} ${compact ? 'text-[13px]' : 'text-sm'}`}>{title}</p>
          <p className={`mt-0.5 leading-relaxed ${s.text} ${compact ? 'text-xs' : 'text-[13px]'}`}>{message}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function getLoginErrorKind(error: unknown): LoginErrorKind {
  if (isSupabaseTransientError(error) || !navigator.onLine) return 'network';
  const message = error instanceof Error ? error.message : formatSupabaseError(error);
  if (message === 'Invalid credentials') return 'invalid';
  if (message.includes('deactivated')) return 'deactivated';
  return 'failed';
}

const stripWhitespace = (value: string) => value.replace(/[\s\u200B-\u200D\u2060\uFEFF]+/g, '');

interface LoginBranding {
  title: string;
  subtitle: string;
}

const LOGIN_BRANDING_CACHE_KEY = `login_branding:v1:${import.meta.env.VITE_SUPABASE_URL}`;

function readLoginBranding(): LoginBranding | null {
  try {
    const cached = JSON.parse(localStorage.getItem(LOGIN_BRANDING_CACHE_KEY) || 'null');
    return cached && typeof cached.title === 'string' && typeof cached.subtitle === 'string'
      ? { title: cached.title, subtitle: cached.subtitle }
      : null;
  } catch {
    return null;
  }
}

export default function Login({ onLoginSuccess }: LoginProps) {
  const [username, setUsername] = useState(() => stripWhitespace(getRememberedUsername()));
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(() => getRememberedUsername() !== '');
  const [openedElsewhere, setOpenedElsewhere] = useState(hasOpenedElsewhereNotice);
  const [loading, setLoading] = useState(false);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [error, setError] = useState<LoginErrorKind | null>(null);
  const [warning, setWarning] = useState<{ attempts?: number } | null>(null);
  const [lockInfo, setLockInfo] = useState<{
    locked: boolean;
    remainingSeconds: number;
    lockUntil?: string;
  } | null>(null);
  const [mounted, setMounted] = useState(false);
  const { companyName, loading: companyNameLoading } = useCompanyName();
  const { isMobile, isTablet, width: viewportWidth, height: viewportHeight } = useResponsive();
  // The two-column tablet layout needs at least 660px, unless the screen is a short landscape one.
  const phoneLayout = isMobile || (isTablet && viewportWidth < 660 && viewportHeight > 520);
  const { t, language, setLanguage, dateLocale } = useLanguage();
  const [showLanguageModal, setShowLanguageModal] = useState(false);
  const [branding, setBranding] = useState<LoginBranding | null>(readLoginBranding);
  const loginTitle = branding?.title || (!companyNameLoading ? companyName : '');
  const loginSubtitle = branding?.subtitle || '';
  const brandingReady = branding !== null && Boolean(loginTitle);

  useEffect(() => {
    setMounted(true);
    loadLoginPageSettings();
    clearOpenedElsewhereNotice();
  }, []);

  const loadLoginPageSettings = async () => {
    if (supabaseConfigurationError) {
      setBranding(previous => previous ?? { title: '', subtitle: '' });
      return;
    }

    try {
      const { data, error } = await supabase
        .from('system_configs')
        .select('key, value')
        .in('key', ['login_title', 'login_subtitle']);

      if (error) throw error;

      const title = data?.find(config => config.key === 'login_title')?.value;
      const subtitle = data?.find(config => config.key === 'login_subtitle')?.value;
      const nextBranding = {
        title: typeof title === 'string' ? title : '',
        subtitle: typeof subtitle === 'string' ? subtitle : '',
      };
      setBranding(nextBranding);
      try {
        localStorage.setItem(LOGIN_BRANDING_CACHE_KEY, JSON.stringify(nextBranding));
      } catch {
        // Storage restrictions must not prevent the brand from rendering.
      }
    } catch (error) {
      setBranding(previous => previous ?? { title: '', subtitle: '' });
      if (!isSupabaseAbortError(error)) {
        console.error('Error loading login page settings:', formatSupabaseError(error));
      }
    }
  };

  useEffect(() => {
    if (!lockInfo?.locked) return;

    const updateCountdown = () => {
      setLockInfo(prev => {
        if (!prev?.locked) return prev;

        const remainingSeconds = prev.lockUntil
          ? Math.max(0, Math.ceil((new Date(prev.lockUntil).getTime() - Date.now()) / 1000))
          : Math.max(0, prev.remainingSeconds - 1);

        if (remainingSeconds <= 0) {
          setError(null);
          setWarning(null);
          return null;
        }

        if (remainingSeconds === prev.remainingSeconds) return prev;
        return { ...prev, remainingSeconds };
      });
    };

    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [lockInfo?.locked, lockInfo?.lockUntil]);

  useEffect(() => {
    if (error && !warning && !lockInfo?.locked) {
      const timer = setTimeout(() => {
        setError(null);
      }, 10000);
      return () => clearTimeout(timer);
    }
  }, [error, warning, lockInfo?.locked]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setOpenedElsewhere(false);
    const normalizedUsername = stripWhitespace(username);

    if (supabaseConfigurationError) {
      console.error('[Login]', supabaseConfigurationError);
      setError('unavailable');
      return;
    }

    setLoading(true);

    try {
      const rateLimitCheck = await checkLoginRateLimit(normalizedUsername, 'username');

      if (!rateLimitCheck.allowed || rateLimitCheck.locked) {
        setLockInfo({
          locked: true,
          remainingSeconds: rateLimitCheck.remaining_seconds || 0,
          lockUntil: rateLimitCheck.lock_until,
        });
        setWarning(null);
        setError('locked');
        setLoading(false);
        return;
      }

      if (rateLimitCheck.warning) {
        setWarning({ attempts: rateLimitCheck.failed_attempts });
      }

      const result = await login({ username: normalizedUsername, password });

      await recordLoginAttempt(
        normalizedUsername,
        'username',
        true,
        undefined,
        navigator.userAgent
      );

      storeAuth(result);
      saveRememberMe(result, rememberMe);
      onLoginSuccess();
    } catch (err) {
      if (isSupabaseAbortError(err)) return;

      if (err instanceof EmployeeLoginMaintenanceError) {
        setWarning(null);
        setLockInfo(null);
        setError(null);
        setShowMaintenance(true);
        return;
      }

      if (err instanceof AccountLockedError) {
        const remainingSeconds = err.lockedUntil
          ? Math.max(0, Math.ceil((new Date(err.lockedUntil).getTime() - Date.now()) / 1000))
          : 15 * 60;
        setLockInfo({
          locked: true,
          remainingSeconds,
          lockUntil: err.lockedUntil,
        });
        setWarning(null);
        setError('locked');
        return;
      }

      const errorKind = getLoginErrorKind(err);
      if (errorKind !== 'invalid') console.error('[Login] Login error:', formatSupabaseError(err));

      const attemptIp = await getUserIP();
      const attemptResult = await recordLoginAttempt(
        normalizedUsername,
        'username',
        false,
        attemptIp,
        navigator.userAgent
      );

      if (attemptResult.locked) {
        const remainingSeconds = Math.max(0, Math.ceil((new Date(attemptResult.lock_until!).getTime() - Date.now()) / 1000));
        setLockInfo({
          locked: true,
          remainingSeconds,
          lockUntil: attemptResult.lock_until,
        });
        setWarning(null);
        setError('locked');
      } else {
        setLockInfo(null);
        if (attemptResult.failed_attempts && attemptResult.failed_attempts >= 3) {
          setError(null);
          setWarning({ attempts: attemptResult.failed_attempts });
        } else {
          setWarning(null);
          setError(errorKind);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  // Global CSS strips native checkbox appearance, so the box is drawn here.
  const rememberMeField = (
    <label className="relative flex w-fit cursor-pointer select-none items-center gap-2.5 py-1 text-[13px] font-medium text-slate-600">
      <input
        type="checkbox"
        checked={rememberMe}
        onChange={(e) => setRememberMe(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={`flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500/40 ${
          rememberMe ? 'border-blue-600 bg-blue-600' : 'border-slate-300 bg-white'
        }`}
      >
        {rememberMe && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
      </span>
      <span>{t.login.rememberMe}</span>
    </label>
  );

  // Global per-width CSS forces button min-heights with !important, so only the fixed inner box is visible and it never reaches the input border; mousedown is cancelled to keep the keyboard open.
  const passwordToggle = (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setShowPassword(visible => !visible)}
      aria-label={showPassword ? t.login.hidePassword : t.login.showPassword}
      aria-pressed={showPassword}
      title={showPassword ? t.login.hidePassword : t.login.showPassword}
      className="group absolute inset-y-[2px] right-[2px] flex w-[44px] !min-h-0 items-center justify-center text-slate-400 focus:outline-none"
    >
      <span className="flex h-[32px] w-[32px] short:h-[28px] short:w-[28px] items-center justify-center rounded-lg transition-colors group-hover:bg-slate-100 group-hover:text-slate-700 group-focus-visible:ring-2 group-focus-visible:ring-blue-500/40">
        {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
      </span>
    </button>
  );

  const currentLanguageName = LANGUAGES.find(l => l.code === language)?.nativeName;

  // Pixel sizes plus !min-h-0 stop the global per-width and touch button rules from resizing this on each device.
  const languageToggle = (
    <button
      type="button"
      onClick={() => setShowLanguageModal(true)}
      className="group relative flex h-[30px] !min-h-0 flex-shrink-0 items-center gap-[6px] rounded-full border border-slate-200/80 bg-gradient-to-r from-slate-50 to-slate-100 px-[12px] text-slate-600 shadow-sm transition-all duration-300 before:absolute before:-inset-[7px] hover:border-blue-200 hover:from-blue-50 hover:to-blue-100 hover:text-blue-700"
    >
      <Globe className="h-[13px] w-[13px] transition-transform duration-300 group-hover:rotate-[20deg]" strokeWidth={2} />
      <span className="text-[11px] font-semibold uppercase leading-none tracking-wide">{currentLanguageName}</span>
    </button>
  );

  const openedElsewhereNotice = openedElsewhere && (
    <div className="flex items-start gap-2.5 rounded-xl border border-blue-200 bg-blue-50 p-3">
      <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" />
      <p className="text-[12px] leading-snug text-blue-800">{t.login.openedInAnotherTab}</p>
    </div>
  );

  const lockCountdown = (seconds: number) => {
    if (seconds < 3600) {
      return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    }
    return new Intl.NumberFormat(dateLocale, { style: 'unit', unit: 'hour', unitDisplay: 'long' }).format(Math.ceil(seconds / 3600));
  };

  const errorMessages: Record<LoginErrorKind, string> = {
    invalid: t.login.errorInvalid,
    deactivated: t.login.errorDeactivated,
    network: t.login.errorNetwork,
    unavailable: t.login.errorUnavailable,
    failed: t.login.errorFailed,
    locked: t.login.lockedDesc,
  };

  const renderLoginAlerts = (compact: boolean) => {
    const [beforeTime, afterTime] = t.login.tryAgainIn.split('{time}');
    return (
      <>
        {warning && (
          <LoginAlert
            tone="warning"
            compact={compact}
            icon={AlertTriangle}
            title={t.login.securityWarning}
            message={warning.attempts ? t.login.attemptsWarning.replace('{n}', String(warning.attempts)) : t.login.multipleFailures}
          />
        )}
        {error && (
          <LoginAlert
            tone="error"
            compact={compact}
            icon={error === 'locked' ? ShieldAlert : Lock}
            title={error === 'locked' ? t.login.accountLocked : t.login.loginFailed}
            message={errorMessages[error]}
          >
            {error === 'locked' && lockInfo?.locked && (
              <p className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-rose-700 ring-1 ring-rose-200/80">
                <Clock className="h-3.5 w-3.5 shrink-0" />
                <span>{beforeTime}<strong className="font-bold tabular-nums">{lockCountdown(lockInfo.remainingSeconds)}</strong>{afterTime}</span>
              </p>
            )}
          </LoginAlert>
        )}
      </>
    );
  };

  const maintenanceDialog = showMaintenance && (
    <EmployeeMaintenanceDialog onClose={() => setShowMaintenance(false)} />
  );

  // Phone layout (phones and narrow portrait tablets)
  if (phoneLayout) {
    const phoneColumn = 'w-full max-w-[520px] self-center';
    return (
      <div className="login-page login-phone flex flex-col relative overflow-hidden" style={{ background: 'linear-gradient(170deg, #1e40af 0%, #2563eb 25%, #3b82f6 40%, #93c5fd 52%, #dbeafe 58%, #f0f5ff 65%, #f8fafc 80%, #ffffff 100%)' }}>
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {/* Large overlapping soft-edge color blocks creating depth */}
          <div className="absolute top-[-5%] right-[-15%] w-[70vw] h-[35vh] rounded-[3rem] bg-gradient-to-bl from-sky-200/[0.12] to-blue-300/[0.05] rotate-[15deg]" />
          <div className="absolute top-[12%] left-[-20%] w-[55vw] h-[28vh] rounded-[2.5rem] bg-gradient-to-tr from-cyan-200/[0.1] to-sky-100/[0.04] -rotate-[8deg]" />
          <div className="absolute top-[30%] right-[-8%] w-[45vw] h-[22vh] rounded-[2rem] bg-gradient-to-l from-blue-100/[0.09] to-transparent rotate-[6deg]" />
          <div className="absolute top-[18%] left-[10%] w-[35vw] h-[18vh] rounded-[2rem] bg-gradient-to-br from-sky-100/[0.08] to-cyan-200/[0.03] rotate-[20deg]" />

        </div>

        {/* Vertical spacing grows with screen height and shrinks to small minimums, so short phones fit without scrolling */}
        <div className={`${phoneColumn} login-phone-brand relative z-10 px-6 pt-[max(calc(env(safe-area-inset-top)_+_8px),clamp(16px,6vh,56px))]`}>
          <div className="flex items-center gap-2.5">
            <div className="login-phone-brand-icon w-10 h-10 flex-shrink-0 bg-white/15 rounded-xl flex items-center justify-center border border-white/20">
              <Globe className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0" aria-busy={!brandingReady} style={{ visibility: brandingReady ? 'visible' : 'hidden' }}>
              <span className="login-phone-brand-name line-clamp-2 text-[15px] font-bold leading-snug text-white">{loginTitle || '\u00a0'}</span>
              {(!brandingReady || loginSubtitle) && <span className="login-phone-brand-subtitle line-clamp-2 text-[11px] leading-snug text-white/50 low:hidden">{loginSubtitle || '\u00a0'}</span>}
            </div>
          </div>
        </div>

        <div aria-hidden="true" className="login-phone-brand-gap min-h-[14px] max-h-[96px] flex-[3_1_0%] low:min-h-[8px]" />

        <div className={`${phoneColumn} login-phone-heading relative z-10 px-6`}>
          <h1 className="login-hero-title login-hero-title--phone text-[26px] font-bold text-white leading-tight tracking-tight short:text-[22px] low:text-[20px]">
            <span className="login-hero-title-text">{t.login.employeeWorkPlatform}</span>
          </h1>
        </div>

        <div aria-hidden="true" className="login-phone-form-gap min-h-[16px] flex-[2_1_0%] low:min-h-[10px]" />

        {/* Login form */}
        <div className={`${phoneColumn} login-phone-card-wrap relative z-10 px-5`}>
          {/* The panel sits ~16px from the screen edges, so the shadow is pulled in with negative spread to avoid a clipped gray band at the edges. */}
          <div className="login-phone-card relative bg-white/95 backdrop-blur-sm rounded-2xl overflow-hidden" style={{ boxShadow: '0 0 0 1px rgba(15, 23, 42, 0.04), 0 16px 28px -20px rgba(30, 64, 175, 0.26)' }}>
            {/* Panel header */}
            <div className="login-phone-card-header flex items-center justify-between gap-3 pb-[10px] pl-6 pr-[14px] pt-[14px] short:pb-[6px] short:pt-[10px]">
              <h3 className="min-w-0 text-[15px] font-bold text-slate-800">{t.login.employeeSignIn}</h3>
              {languageToggle}
            </div>

            <div className="login-phone-form-body px-6 pb-6 short:pb-4">
            <form onSubmit={handleSubmit} className="login-phone-form space-y-5 short:space-y-3">
              {openedElsewhereNotice}
              <div>
                <label htmlFor="username" className="block text-[12px] font-semibold text-slate-600 mb-2 short:mb-1">
                  {t.login.username}
                </label>
                <div className="login-phone-input-wrap relative">
                  <input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(stripWhitespace(e.target.value))}
                    autoComplete="username"
                    required
                    className="w-full pl-11 pr-4 py-3.5 short:py-2.5 bg-white border-2 border-slate-100 rounded-xl text-slate-800 placeholder-slate-400 text-[15px] focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all"
                    placeholder={t.login.usernamePlaceholder}
                  />
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300">
                    <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" /></svg>
                  </div>
                </div>
              </div>

              <div>
                <label htmlFor="password" className="block text-[12px] font-semibold text-slate-600 mb-2 short:mb-1">
                  {t.login.password}
                </label>
                <div className="login-phone-input-wrap relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    className="w-full pl-11 pr-[48px] py-3.5 short:py-2.5 bg-white border-2 border-slate-100 rounded-xl text-slate-800 placeholder-slate-400 text-[15px] focus:outline-none focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 transition-all"
                    placeholder={t.login.passwordPlaceholder}
                  />
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-300">
                    <svg viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" /></svg>
                  </div>
                  {passwordToggle}
                </div>
              </div>

              {rememberMeField}

              {renderLoginAlerts(true)}

              <button
                type="submit"
                disabled={loading}
                className={`keep-animation w-full flex items-center justify-center gap-2 text-white py-4 short:py-3 rounded-xl font-semibold text-[15px] transition-all duration-200 border-0 outline-none appearance-none ${
                  loading
                    ? 'bg-blue-500 cursor-wait'
                    : 'bg-gradient-to-r from-blue-600 to-blue-700 active:from-blue-700 active:to-blue-800 shadow-lg shadow-blue-600/25 active:shadow-md active:scale-[0.98]'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
                style={{ WebkitAppearance: 'none', WebkitTapHighlightColor: 'transparent', MozAppearance: 'none' } as React.CSSProperties}
              >
                {loading ? (
                  <>
                    <div className="keep-animation w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    <span className="keep-animation">{t.login.signingIn}</span>
                  </>
                ) : (
                  <>
                    <span>{t.login.signIn}</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
            </div>
          </div>
        </div>
        <div aria-hidden="true" className="login-phone-bottom-gap min-h-[12px] flex-[2_1_0%] low:min-h-[8px]" />

        {/* Minimal footer */}
        <div className="login-phone-footer relative z-10 flex items-center justify-center pt-[clamp(6px,1.5vh,16px)] pb-[max(env(safe-area-inset-bottom),clamp(12px,3.5vh,32px))] low:hidden">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
            <Lock className="w-3 h-3" />
            <span>{t.login.securedConnection}</span>
          </div>
        </div>

        {maintenanceDialog}
        {showLanguageModal && (
          <LanguageModal
            currentLanguage={language}
            onConfirm={(code: Language) => { setLanguage(code); setShowLanguageModal(false); }}
            onClose={() => setShowLanguageModal(false)}
            t={t}
          />
        )}
      </div>
    );
  }

  // Tablet layout
  if (isTablet) {
    return (
      <div className="login-page login-tablet flex relative overflow-hidden" style={{ background: 'linear-gradient(160deg, #1e40af 0%, #2563eb 20%, #3b82f6 35%, #60a5fa 45%, #93c5fd 52%, #dbeafe 60%, #f0f9ff 70%, #ffffff 85%)' }}>
        {/* Decorative background elements */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {/* Large layered gradient blocks */}
          <div className="absolute top-[-8%] left-[-10%] w-[50%] h-[45%] rounded-[4rem] bg-gradient-to-br from-sky-200/[0.1] to-blue-400/[0.04] rotate-[12deg]" />
          <div className="absolute top-[20%] right-[-5%] w-[40%] h-[35%] rounded-[3rem] bg-gradient-to-bl from-cyan-100/[0.08] to-transparent -rotate-[6deg]" />
          <div className="absolute bottom-[-5%] left-[5%] w-[45%] h-[30%] rounded-[3rem] bg-gradient-to-tr from-blue-100/[0.07] to-transparent rotate-[8deg]" />

        </div>

        {/* Left panel - Branding & info. It may shrink (min-w-0) so the card column always keeps its minimum width; `low:` is the compact landscape-phone version. */}
        <div className="login-tablet-info relative z-10 flex w-[52%] min-w-0 flex-col justify-between py-10 pl-[clamp(24px,4vw,32px)] pr-[clamp(20px,4vw,40px)] short:py-7 low:w-[42%] low:justify-center low:gap-4 low:py-5 low:pl-[max(24px,env(safe-area-inset-left))] low:pr-4">
          {/* Brand - top left */}
          <div className={`login-tablet-brand transition-all duration-1000 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-8'}`}>
            <div className="login-tablet-brand-row flex items-center gap-2.5">
              <div className="login-tablet-brand-icon w-9 h-9 bg-white/15 backdrop-blur-sm rounded-lg flex items-center justify-center border border-white/20 flex-shrink-0">
                <Globe className="w-4.5 h-4.5 text-white" />
              </div>
              <div className="flex-1 min-w-0" aria-busy={!brandingReady} style={{ visibility: brandingReady ? 'visible' : 'hidden' }}>
                <span className="login-tablet-brand-name text-[13px] font-bold text-white block break-words">{loginTitle || '\u00a0'}</span>
                {(!brandingReady || loginSubtitle) && <p className="login-tablet-brand-subtitle text-[10px] text-white/50 mt-0.5 break-words">{loginSubtitle || '\u00a0'}</p>}
              </div>
            </div>
          </div>

          {/* Center content */}
          <div className={`login-tablet-intro transition-all duration-1000 delay-300 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
            <h1 className="login-hero-title login-hero-title--tablet text-[length:clamp(22px,3.4vw,32px)] min-[800px]:text-[length:clamp(28px,3.75vw,32px)] font-bold text-white leading-tight mb-4 break-words low:mb-2">
              <span className="login-hero-title-text">{t.login.employeeWorkPlatform}</span>
            </h1>
            <p className="text-sm text-white/60 leading-relaxed max-w-[340px] max-[699px]:low:hidden">
              {t.login.description}
            </p>
          </div>

          {/* Status - bottom left */}
          <div className={`login-tablet-status transition-all duration-1000 delay-500 low:hidden ${mounted ? 'opacity-100' : 'opacity-0'}`}>
            {/* The bottom of the left column sits on the light part of the gradient, so the text is slate rather than translucent white */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></div>
              <span>{t.login.systemsOnline}</span>
              <span className="mx-2 text-slate-300">|</span>
              <Lock className="w-3 h-3" />
              <span>{t.login.sslSecured}</span>
            </div>
          </div>
        </div>

        {/* Right panel - Login form */}
        <div className="login-tablet-form-panel relative z-10 flex flex-1 items-center justify-center px-[clamp(20px,4vw,32px)] py-8 short:py-5 low:py-2 low:pl-2 low:pr-[max(16px,env(safe-area-inset-right))]">
          <div className={`login-tablet-card-wrap w-full max-w-[400px] min-w-[340px] low:min-w-[296px] transition-all duration-700 delay-200 ${mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95'}`}>
            <div className="relative bg-white/95 backdrop-blur-md rounded-2xl shadow-2xl shadow-blue-900/10 border border-white/80 overflow-hidden">
              {/* Top accent */}
              <div className="h-1 bg-gradient-to-r from-blue-500 via-sky-400 to-blue-500"></div>

              <div className="p-[clamp(24px,3.6vw,32px)] short:py-6 low:p-4">
                {/* Language switcher - own row; on landscape phones it moves into the heading row */}
                <div className="flex justify-end mb-4 short:mb-2 low:float-right low:mb-0 low:ml-2">
                  {languageToggle}
                </div>
                {/* Header */}
                <div className="mb-6 short:mb-4 low:mb-3">
                  <h3 className="text-[22px] font-bold text-slate-800 mb-1 low:mb-0 low:text-[18px]">{t.login.welcomeBack}</h3>
                  <p className="text-sm text-slate-500 low:hidden">{t.login.signInToAccess}</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5 short:space-y-3.5 low:space-y-2.5 low:clear-both">
                  {openedElsewhereNotice}
                  <div>
                    <label htmlFor="username" className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 short:mb-1.5 low:sr-only">
                      {t.login.username}
                    </label>
                    <input
                      id="username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(stripWhitespace(e.target.value))}
                      autoComplete="username"
                      required
                      className="w-full px-4 py-3.5 short:py-3 low:py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 text-[15px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 focus:bg-white transition-all hover:border-slate-300"
                      placeholder={t.login.usernamePlaceholder}
                    />
                  </div>

                  <div>
                    <label htmlFor="password" className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 short:mb-1.5 low:sr-only">
                      {t.login.password}
                    </label>
                    <div className="relative">
                      <input
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        required
                        className="w-full px-4 pr-[48px] py-3.5 short:py-3 low:py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 text-[15px] focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 focus:bg-white transition-all hover:border-slate-300"
                        placeholder={t.login.passwordPlaceholder}
                      />
                      {passwordToggle}
                    </div>
                  </div>

                  {rememberMeField}

                  {renderLoginAlerts(false)}

                  <button
                    type="submit"
                    disabled={loading}
                    className={`keep-animation w-full flex items-center justify-center gap-2.5 text-white py-4 short:py-3.5 low:py-2.5 px-5 rounded-xl font-semibold text-[15px] transition-all duration-200 border-0 outline-none appearance-none ${
                      loading
                        ? 'bg-blue-500 cursor-wait'
                        : 'bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 shadow-lg shadow-blue-600/20 hover:shadow-xl hover:shadow-blue-600/30 active:scale-[0.98]'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {loading ? (
                      <>
                        <div className="keep-animation w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        <span className="keep-animation">{t.login.signingIn}</span>
                      </>
                    ) : (
                      <>
                        <span>{t.login.signIn}</span>
                        <ArrowRight className="w-4.5 h-4.5" />
                      </>
                    )}
                  </button>
                </form>

                {/* Footer */}
                <div className="mt-8 pt-5 border-t border-slate-100 short:mt-5 short:pt-4 low:hidden">
                  <div className="login-tablet-security flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-slate-400">
                    <div className="flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5" />
                      <span>{t.login.encrypted}</span>
                    </div>
                    <div className="w-1 h-1 bg-slate-200 rounded-full"></div>
                    <div className="flex items-center gap-1.5">
                      <Shield className="w-3.5 h-3.5" />
                      <span>{t.login.protected}</span>
                    </div>
                    <div className="w-1 h-1 bg-slate-200 rounded-full"></div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 bg-green-400 rounded-full"></div>
                      <span>{t.login.secure}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {maintenanceDialog}
        {showLanguageModal && (
          <LanguageModal
            currentLanguage={language}
            onConfirm={(code: Language) => { setLanguage(code); setShowLanguageModal(false); }}
            onClose={() => setShowLanguageModal(false)}
            t={t}
          />
        )}
      </div>
    );
  }

  // Desktop layout
  return (
    <div className="login-page relative overflow-hidden">
      {/* Background: white with soft light-blue gradient edges */}
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-white" />
        <div className="absolute inset-0 bg-gradient-to-br from-blue-50/50 via-transparent to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-tl from-blue-50/30 via-transparent to-transparent" />

        {/* Subtle geometric pattern */}
        <div className="absolute inset-0 opacity-[0.025]">
          <svg className="w-full h-full" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <pattern id="grid-pattern" x="0" y="0" width="60" height="60" patternUnits="userSpaceOnUse">
                <path d="M 60 0 L 0 0 0 60" fill="none" stroke="currentColor" strokeWidth="0.5" className="text-slate-800" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid-pattern)" />
          </svg>
        </div>
      </div>

      {/* Trade/cargo decorative elements */}
      <LoginDecorations />

      {/* Main layout - split screen */}
      <div className="relative z-10 min-h-screen flex">
        {/* Left panel - Information */}
        <div className="w-[54%] xl:w-[56%] flex flex-col justify-center pl-16 xl:pl-24 pr-12">
          <div className={`transition-all duration-1000 delay-200 ${mounted ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-12'}`}>
            {/* Brand */}
            <div className="flex items-center gap-3.5 mb-12 [@media(max-height:800px)]:mb-8">
              <div className="w-11 h-11 bg-gradient-to-br from-blue-600 to-blue-700 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/15">
                <Globe className="w-5.5 h-5.5 text-white" />
              </div>
              <div aria-busy={!brandingReady} style={{ visibility: brandingReady ? 'visible' : 'hidden' }}>
                <h2 className="text-lg font-bold text-slate-800">{loginTitle || '\u00a0'}</h2>
                {(!brandingReady || loginSubtitle) && <p className="text-xs text-slate-500 mt-0.5">{loginSubtitle || '\u00a0'}</p>}
              </div>
            </div>

            {/* Headline */}
            <h1 className="login-hero-title login-hero-title--desktop text-4xl xl:text-[44px] font-bold text-slate-800 leading-tight mb-5">
              <span className="login-hero-title-text">{t.login.employeeWorkPlatform}</span>
            </h1>

            <p className="text-base text-slate-500 leading-relaxed mb-10 max-w-md [@media(max-height:800px)]:mb-7">
              {t.login.descriptionDesktop}
            </p>

            {/* Feature cards */}
            <div className="space-y-4 max-w-md">
              <div className="flex items-center gap-4 p-4 rounded-xl bg-white/70 border border-slate-100 shadow-sm hover:shadow-md transition-shadow">
                <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Package className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-700">{t.login.featureOrderTitle}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{t.login.featureOrderDesc}</p>
                </div>
              </div>

              <div className="flex items-center gap-4 p-4 rounded-xl bg-white/70 border border-slate-100 shadow-sm hover:shadow-md transition-shadow">
                <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <ClipboardCheck className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-700">{t.login.featureDispatchTitle}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{t.login.featureDispatchDesc}</p>
                </div>
              </div>

              <div className="flex items-center gap-4 p-4 rounded-xl bg-white/70 border border-slate-100 shadow-sm hover:shadow-md transition-shadow">
                <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center flex-shrink-0">
                  <Shield className="w-5 h-5 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-700">{t.login.featureSecureTitle}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{t.login.featureSecureDesc}</p>
                </div>
              </div>
            </div>

            {/* Status bar */}
            <div className="mt-12 pt-6 border-t border-slate-100 [@media(max-height:800px)]:mt-8">
              <div className="flex items-center gap-6 text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
                  <span>{t.login.systemsOnline}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Shield className="w-3.5 h-3.5" />
                  <span>{t.login.sslSecured}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5" />
                  <span>{t.login.globalNetwork}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right panel - Login form */}
        <div className="flex-1 flex items-center justify-center px-8 xl:px-12">
          <div className={`w-full max-w-[420px] transition-all duration-1000 delay-300 ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8'}`}>
            {/* Login card */}
            <div className="relative bg-white rounded-2xl shadow-xl shadow-slate-200/60 border border-slate-100 overflow-hidden">
              {/* Top gradient line */}
              <div className="h-1 bg-gradient-to-r from-blue-500 via-blue-600 to-blue-500"></div>

              <div className="p-8 xl:p-10">
                {/* Language switcher - absolute top right */}
                <button
                  type="button"
                  onClick={() => setShowLanguageModal(true)}
                  className="absolute top-5 right-5 xl:top-6 xl:right-6 z-10 group h-[34px] !min-h-0 px-3.5 rounded-full bg-gradient-to-r from-slate-50 to-slate-100 hover:from-blue-50 hover:to-blue-100 text-slate-600 hover:text-blue-700 transition-all duration-300 flex items-center gap-2 border border-slate-200/80 hover:border-blue-200 shadow-sm hover:shadow-md hover:shadow-blue-100/50"
                >
                  <Globe className="w-4 h-4 transition-transform duration-300 group-hover:rotate-[20deg]" strokeWidth={2} />
                  <span className="text-xs font-semibold tracking-wide">{currentLanguageName}</span>
                  <div className="w-1 h-1 rounded-full bg-blue-400 opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
                </button>
                {/* Header */}
                <div className="mb-8">
                  <h3 className="text-2xl font-bold text-slate-800 mb-1.5">{t.login.employeeSignIn}</h3>
                  <p className="text-sm text-slate-500">{t.login.accessDashboard}</p>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                  {openedElsewhereNotice}
                  <div>
                    <label htmlFor="username" className="block text-sm font-medium text-slate-700 mb-2">
                      {t.login.username}
                    </label>
                    <input
                      id="username"
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(stripWhitespace(e.target.value))}
                      autoComplete="username"
                      required
                      className="w-full px-4 py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 focus:bg-white transition-all hover:border-slate-300"
                      placeholder={t.login.usernamePlaceholder}
                    />
                  </div>

                  <div>
                    <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-2">
                      {t.login.password}
                    </label>
                    <div className="relative">
                      <input
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete="current-password"
                        required
                        className="w-full px-4 pr-[48px] py-3.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-800 placeholder-slate-400 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 focus:bg-white transition-all hover:border-slate-300"
                        placeholder={t.login.passwordPlaceholder}
                      />
                      {passwordToggle}
                    </div>
                  </div>

                  {rememberMeField}

                  {renderLoginAlerts(false)}

                  <button
                    type="submit"
                    disabled={loading}
                    className={`keep-animation w-full flex items-center justify-center gap-2.5 text-white py-3.5 px-5 rounded-xl font-semibold text-sm transition-all duration-200 border-0 outline-none appearance-none ${
                      loading
                        ? 'bg-blue-500 cursor-wait'
                        : 'bg-blue-600 hover:bg-blue-700 active:bg-blue-800 shadow-lg shadow-blue-600/20 hover:shadow-xl hover:shadow-blue-600/30'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {loading ? (
                      <>
                        <div className="keep-animation w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                        <span className="keep-animation">{t.login.signingIn}</span>
                      </>
                    ) : (
                      <>
                        <span>{t.login.signIn}</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </form>

                {/* Footer */}
                <div className="mt-8 pt-6 border-t border-slate-100">
                  <div className="flex items-center justify-center gap-4 text-xs text-slate-400">
                    <div className="flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5" />
                      <span>{t.login.encrypted}</span>
                    </div>
                    <div className="w-1 h-1 bg-slate-200 rounded-full"></div>
                    <div className="flex items-center gap-1.5">
                      <Shield className="w-3.5 h-3.5" />
                      <span>{t.login.protected}</span>
                    </div>
                    <div className="w-1 h-1 bg-slate-200 rounded-full"></div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 bg-green-400 rounded-full"></div>
                      <span>{t.login.secure}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-5 text-center">
              <p className="text-xs text-slate-400">{t.login.crossBorderOrder}</p>
            </div>
          </div>
        </div>
      </div>

      {maintenanceDialog}
      {showLanguageModal && (
        <LanguageModal
          currentLanguage={language}
          onConfirm={(code: Language) => { setLanguage(code); setShowLanguageModal(false); }}
          onClose={() => setShowLanguageModal(false)}
          t={t}
        />
      )}
    </div>
  );
}
