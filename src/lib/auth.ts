import { formatSupabaseError, isEmployeeSessionEndedError, supabase } from './supabase';
import { tabSessionManager } from './TabSessionManager';
import { logEmployeeLogin, logEmployeeLogout } from './loginHistoryService';
import type { Admin, Employee } from '../types';

export const AUTH_STORAGE_KEY = 'work_platform_auth';
export const AUTH_LOGOUT_EVENT = 'work_platform_logout';
export const AUTH_HANDOVER_EVENT = 'work_platform_handover';
export const PROFILE_UPDATED_EVENT = 'work_platform_profile_updated';
const LEGACY_AUTH_STORAGE_KEY = ['quantum', 'trader', 'auth'].join('_');
const REMEMBERED_AUTH_KEY = 'work_platform_remembered_auth';
const REMEMBERED_USERNAME_KEY = 'work_platform_remembered_username';
const OPENED_ELSEWHERE_NOTICE_KEY = 'work_platform_opened_elsewhere';
// Matches the server-side lifetime set by create_employee_financial_session.
const EMPLOYEE_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const RESUME_CHECK_TIMEOUT_MS = 5000;
const EMPLOYEE_PROFILE_COLUMNS = 'id, username, employee_id, is_verified, is_active, total_income, first_success_order_date, created_by, remarks, tags, is_pinned, current_session_token, session_created_at, last_heartbeat_at, current_tab_id, created_at, updated_at';

export interface LoginCredentials {
  username: string;
  password: string;
}

type EmployeeAuth = {
  user: Employee;
  userType: 'employee';
  sessionToken: string;
  financialSessionToken: string;
  tabId: string;
  expiresAt?: number;
};

type RememberedAuth = EmployeeAuth & { expiresAt: number };

export type StoredAuth =
  | {
      user: Admin;
      userType: 'admin';
      adminSessionToken: string;
    }
  | EmployeeAuth;

type FinancialLoginResult<T> = {
  success?: boolean;
  error?: string;
  code?: string;
  locked_until?: string;
  session_token?: string;
  session_marker?: string;
  user?: T;
};

export class AccountLockedError extends Error {
  readonly lockedUntil?: string;

  constructor(lockedUntil?: string) {
    super('Account is temporarily locked.');
    this.name = 'AccountLockedError';
    this.lockedUntil = lockedUntil;
  }
}

export class EmployeeLoginMaintenanceError extends Error {
  constructor() {
    super('Employee login is temporarily unavailable during maintenance.');
    this.name = 'EmployeeLoginMaintenanceError';
  }
}

export async function login(credentials: LoginCredentials): Promise<StoredAuth> {
  const username = credentials.username.trim();
  const [adminAccount, employeeAccount] = await Promise.all([
    supabase
      .from('admins')
      .select('id, is_active')
      .eq('username', username)
      .maybeSingle(),
    supabase
      .from('users')
      .select('id, is_active')
      .eq('username', username)
      .maybeSingle(),
  ]);

  if (adminAccount.error) throw adminAccount.error;
  if (employeeAccount.error) throw employeeAccount.error;

  if (adminAccount.data) {
    if (!adminAccount.data.is_active) {
      throw new Error('Account has been deactivated. Please contact administrator.');
    }

    const { data, error } = await supabase.rpc('create_admin_financial_session', {
      p_username: username,
      p_password: credentials.password,
    });
    if (error) throw error;

    const result = data as FinancialLoginResult<Admin>;
    if (!result.success || !result.session_token || !result.user) {
      if (result.error === 'Account is temporarily locked.') {
        throw new AccountLockedError(result.locked_until);
      }
      throw new Error(result.error || 'Invalid credentials');
    }

    return {
      user: result.user,
      userType: 'admin',
      adminSessionToken: result.session_token,
    };
  }

  if (employeeAccount.data) {
    if (!employeeAccount.data.is_active) {
      throw new Error('Account has been deactivated. Please contact administrator.');
    }

    const tabId = tabSessionManager.getTabId();
    const requestedAt = Date.now();
    const { data, error } = await supabase.rpc('create_employee_financial_session', {
      p_username: username,
      p_password: credentials.password,
      p_tab_id: tabId,
    });
    if (error) throw error;

    const result = data as FinancialLoginResult<Employee>;
    if (result.code === 'employee_login_maintenance') {
      throw new EmployeeLoginMaintenanceError();
    }
    if (!result.success || !result.session_token || !result.session_marker || !result.user) {
      if (result.error === 'Account is temporarily locked.') {
        throw new AccountLockedError(result.locked_until);
      }
      throw new Error(result.error || 'Invalid credentials');
    }

    const authData: StoredAuth = {
      user: result.user,
      userType: 'employee',
      sessionToken: result.session_marker,
      financialSessionToken: result.session_token,
      tabId,
      expiresAt: requestedAt + EMPLOYEE_SESSION_DURATION_MS,
    };
    storeAuth(authData);

    logEmployeeLogin(
      result.user.id,
      result.user.username,
      result.user.employee_id,
      result.session_marker,
    ).catch(err => console.error('Failed to log employee login:', err));

    return authData;
  }

  throw new Error('Invalid credentials');
}

export async function logout(isUserInitiated: boolean = true) {
  const auth = getStoredAuth();

  if (auth) {
    const financialSessionToken = auth.userType === 'admin'
      ? auth.adminSessionToken
      : auth.financialSessionToken;
    const revokeFinancialSession = () => supabase
      .rpc('revoke_financial_session', { p_token: financialSessionToken })
      .then(() => undefined, () => undefined);
    const operations: Array<PromiseLike<unknown>> = [];

    if (auth.userType === 'employee' && !isUserInitiated) {
      // The server already ended this session (expired, taken over elsewhere or deactivated); stopping work or
      // recording a logout would only be rejected, and must not touch a newer session that replaced it.
      forgetRememberedSession(auth.sessionToken);
      operations.push(revokeFinancialSession());
    } else if (auth.userType === 'employee') {
      forgetRememberedSession(auth.sessionToken);
      const reportStopError = (error: unknown) => {
        if (!isEmployeeSessionEndedError(error)) {
          console.error('Failed to stop employee sessions during logout:', formatSupabaseError(error));
        }
      };
      operations.push(
        (async () => {
          try {
            const { error } = await supabase.rpc('end_employee_dispatch_session_secure', {
              p_user_id: auth.user.id,
              p_session_token: auth.financialSessionToken,
              p_tab_id: auth.tabId,
              p_session_id: null,
            });
            if (error) reportStopError(error);
          } catch (error) {
            reportStopError(error);
          } finally {
            await revokeFinancialSession();
          }
        })(),
        logEmployeeLogout(
          auth.user.id,
          auth.financialSessionToken,
          auth.tabId,
          auth.sessionToken,
        ).catch(() => undefined),
      );
    } else {
      operations.push(revokeFinancialSession());
    }

    try {
      await Promise.race([
        Promise.all(operations),
        new Promise(resolve => setTimeout(resolve, 500)),
      ]);
    } catch {
      // Logout must continue even when the network is unavailable.
    }

    if (auth.userType === 'employee') {
      tabSessionManager.stopSession(isUserInitiated);
    }
  }

  clearTabAuthStorage();
  window.dispatchEvent(new Event(AUTH_LOGOUT_EVENT));
}

function clearTabAuthStorage() {
  sessionStorage.removeItem(AUTH_STORAGE_KEY);
  sessionStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
  sessionStorage.removeItem('tabId');
  sessionStorage.removeItem('announcement_admin_id');
  sessionStorage.removeItem('announcement_categories');
  sessionStorage.removeItem('announcement_carousel_enabled');
  sessionStorage.removeItem('announcement_carousel_speed');
  sessionStorage.removeItem('announcements_cache');
  sessionStorage.removeItem('announcements_cache_time');
  sessionStorage.removeItem('announcements_cache_user_id');
}

// The same login was reopened in another tab: step aside without revoking the shared server session.
export function leaveSessionForAnotherTab() {
  clearTabAuthStorage();
  try {
    sessionStorage.setItem(OPENED_ELSEWHERE_NOTICE_KEY, '1');
  } catch { /* ignore */ }
  tabSessionManager.stopSession(false);
  window.dispatchEvent(new Event(AUTH_HANDOVER_EVENT));
}

export function hasOpenedElsewhereNotice(): boolean {
  try {
    return sessionStorage.getItem(OPENED_ELSEWHERE_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearOpenedElsewhereNotice() {
  try {
    sessionStorage.removeItem(OPENED_ELSEWHERE_NOTICE_KEY);
  } catch { /* ignore */ }
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch { /* storage unavailable, e.g. private browsing */ }
}

function removeLocal(key: string) {
  try {
    localStorage.removeItem(key);
  } catch { /* ignore */ }
}

function readRememberedAuth(): RememberedAuth | null {
  const stored = readLocal(REMEMBERED_AUTH_KEY);
  if (!stored) return null;

  try {
    const auth = JSON.parse(stored) as Partial<EmployeeAuth>;
    if (
      auth.userType === 'employee'
      && auth.user?.id
      && auth.sessionToken
      && auth.financialSessionToken
      && auth.tabId
      && typeof auth.expiresAt === 'number'
    ) {
      return auth as RememberedAuth;
    }
  } catch { /* discard malformed value below */ }

  removeLocal(REMEMBERED_AUTH_KEY);
  return null;
}

function forgetRememberedSession(sessionToken: string) {
  if (readRememberedAuth()?.sessionToken === sessionToken) {
    removeLocal(REMEMBERED_AUTH_KEY);
  }
}

export function getRememberedUsername(): string {
  return readLocal(REMEMBERED_USERNAME_KEY) || '';
}

export function saveRememberMe(auth: StoredAuth, remember: boolean) {
  if (remember) writeLocal(REMEMBERED_USERNAME_KEY, auth.user.username);
  else removeLocal(REMEMBERED_USERNAME_KEY);

  if (auth.userType !== 'employee') return;
  if (remember) writeLocal(REMEMBERED_AUTH_KEY, JSON.stringify(auth));
  else removeLocal(REMEMBERED_AUTH_KEY);
}

export function hasRememberedSession(): boolean {
  const remembered = readRememberedAuth();
  if (!remembered) return false;
  if (remembered.expiresAt > Date.now()) return true;
  removeLocal(REMEMBERED_AUTH_KEY);
  return false;
}

export async function resumeRememberedSession(): Promise<StoredAuth | null> {
  const remembered = readRememberedAuth();
  if (!remembered) return null;
  if (remembered.expiresAt <= Date.now()) {
    removeLocal(REMEMBERED_AUTH_KEY);
    return null;
  }

  let timer = 0;
  const timeout = new Promise<null>(resolve => {
    timer = window.setTimeout(() => resolve(null), RESUME_CHECK_TIMEOUT_MS);
  });
  const [validation, profile] = await Promise.all([
    Promise.race([
      supabase.rpc('validate_employee_session', {
        p_user_id: remembered.user.id,
        p_session_token: remembered.financialSessionToken,
        p_tab_id: remembered.tabId,
      }),
      timeout,
    ]),
    Promise.race([
      supabase
        .from('users')
        .select(EMPLOYEE_PROFILE_COLUMNS)
        .eq('id', remembered.user.id)
        .maybeSingle(),
      timeout,
    ]),
  ]).catch(() => [null, null] as const);
  window.clearTimeout(timer);

  // Only a definite "invalid" answer drops the session; network trouble lets the dashboard recover on its own.
  if (validation && !validation.error && validation.data !== true) {
    forgetRememberedSession(remembered.sessionToken);
    return null;
  }

  const freshProfile = profile && !profile.error && profile.data
    ? (profile.data as Partial<Employee>)
    : null;
  const restored: EmployeeAuth = {
    ...remembered,
    user: freshProfile ? { ...remembered.user, ...freshProfile } : remembered.user,
  };
  storeAuth(restored);
  return restored;
}

export function getStoredAuth(): StoredAuth | null {
  let stored = sessionStorage.getItem(AUTH_STORAGE_KEY);

  if (!stored) {
    const legacyStored = sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY);
    if (legacyStored) {
      sessionStorage.setItem(AUTH_STORAGE_KEY, legacyStored);
      sessionStorage.removeItem(LEGACY_AUTH_STORAGE_KEY);
      stored = legacyStored;
    }
  }

  if (!stored) return null;

  try {
    const auth = JSON.parse(stored) as StoredAuth;
    if (auth.userType === 'admin' && !auth.adminSessionToken) return null;
    if (auth.userType === 'employee' && (!auth.financialSessionToken || !auth.sessionToken)) return null;
    return auth;
  } catch {
    return null;
  }
}

export function storeAuth(data: StoredAuth) {
  sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(data));
  if (data.userType === 'employee' && readRememberedAuth()?.sessionToken === data.sessionToken) {
    writeLocal(REMEMBERED_AUTH_KEY, JSON.stringify(data));
  }
}

export function getAdminFinancialSessionToken(): string {
  const auth = getStoredAuth();
  if (!auth || auth.userType !== 'admin' || !auth.adminSessionToken) {
    throw new Error('Administrator session has expired. Please sign in again.');
  }
  return auth.adminSessionToken;
}

export function getEmployeeFinancialSession() {
  const auth = getStoredAuth();
  if (!auth || auth.userType !== 'employee' || !auth.financialSessionToken) {
    throw new Error('Employee session has expired. Please sign in again.');
  }
  return {
    token: auth.financialSessionToken,
    tabId: auth.tabId,
  };
}

export function createFinancialOperationId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
    const random = Math.random() * 16 | 0;
    const value = character === 'x' ? random : (random & 0x3 | 0x8);
    return value.toString(16);
  });
}

export function updateStoredUsername(newUsername: string) {
  const stored = getStoredAuth();
  if (stored) {
    if (getRememberedUsername() === stored.user.username) {
      writeLocal(REMEMBERED_USERNAME_KEY, newUsername);
    }
    stored.user.username = newUsername;
    storeAuth(stored);
    window.dispatchEvent(new Event(PROFILE_UPDATED_EVENT));
  }
}

export async function validateEmployeeSession(
  userId: string,
  sessionToken: string,
  tabId?: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('validate_employee_session', {
      p_user_id: userId,
      p_session_token: sessionToken,
      p_tab_id: tabId || null,
    });

    if (error) {
      console.error('Session validation error:', error);
      return false;
    }

    return data === true;
  } catch (error) {
    console.error('Failed to validate session:', error);
    return false;
  }
}
