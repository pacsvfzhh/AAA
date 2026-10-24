import { formatSupabaseError, isEmployeeSessionEndedError, supabase } from './supabase';
import { collectLoginDeviceInfo, parseLoginDeviceInfo } from './deviceInfo';

const IP_FAILURE_RETRY_MS = 60_000;
let cachedIp: string | null = null;
let ipRequest: Promise<string> | null = null;
let lastIpFailureAt = 0;

async function fetchUserIP(): Promise<string> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch('https://api.ipify.org?format=json', {
      signal: controller.signal,
    });
    const data = await response.json();
    if (typeof data.ip === 'string' && data.ip) {
      cachedIp = data.ip;
      return data.ip;
    }
    lastIpFailureAt = Date.now();
    return 'Unknown';
  } catch (error) {
    lastIpFailureAt = Date.now();
    // The 2s timeout aborting the request is expected on slow or blocked networks.
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      console.warn('IP lookup unavailable:', formatSupabaseError(error));
    }
    return 'Unknown';
  } finally {
    window.clearTimeout(timeout);
  }
}

export function getUserIP(): Promise<string> {
  if (cachedIp) return Promise.resolve(cachedIp);
  if (ipRequest) return ipRequest;
  if (Date.now() - lastIpFailureAt < IP_FAILURE_RETRY_MS) return Promise.resolve('Unknown');

  ipRequest = fetchUserIP().finally(() => {
    ipRequest = null;
  });
  return ipRequest;
}

export async function logEmployeeLogin(
  userId: string,
  username: string,
  employeeId: string,
  sessionId?: string
): Promise<void> {
  try {
    const userAgent = typeof navigator === 'undefined' ? undefined : navigator.userAgent;
    const [ipAddress, deviceInfo] = await Promise.all([
      getUserIP(),
      collectLoginDeviceInfo().catch(() => parseLoginDeviceInfo(userAgent)),
    ]);

    const { error: structuredError } = await supabase.rpc('log_employee_login_with_device_info', {
      p_user_id: userId,
      p_username: username,
      p_employee_id: employeeId,
      p_ip_address: ipAddress,
      p_user_agent: userAgent,
      p_session_id: sessionId || null,
      p_device_info: deviceInfo,
    });

    if (!structuredError) return;
    // The session was ended server-side (taken over by another login, logged out, expired or deactivated); the plain RPC checks the same thing and would be rejected too.
    if (isEmployeeSessionEndedError(structuredError)) return;

    const { error: fallbackError } = await supabase.rpc('log_employee_login', {
      p_user_id: userId,
      p_username: username,
      p_employee_id: employeeId,
      p_ip_address: ipAddress,
      p_user_agent: userAgent,
      p_session_id: sessionId || null,
    });

    if (fallbackError && !isEmployeeSessionEndedError(fallbackError)) {
      console.error(
        'Error logging employee login:',
        `${formatSupabaseError(fallbackError)} (structured RPC: ${formatSupabaseError(structuredError)})`,
      );
    }
  } catch (error) {
    console.error('Error in logEmployeeLogin:', formatSupabaseError(error));
  }
}

export async function logEmployeeLogout(
  userId: string,
  financialToken: string,
  tabId: string,
  sessionId: string
): Promise<void> {
  try {
    const userAgent = typeof navigator === 'undefined' ? undefined : navigator.userAgent;
    const deviceInfo = await collectLoginDeviceInfo().catch(() => parseLoginDeviceInfo(userAgent));
    const { error } = await supabase.rpc('log_employee_logout_secure', {
      p_user_id: userId,
      p_financial_token: financialToken,
      p_tab_id: tabId,
      p_session_id: sessionId,
      p_user_agent: userAgent || null,
      p_device_info: deviceInfo,
    });

    if (error && !isEmployeeSessionEndedError(error)) {
      console.error('Error logging employee logout:', formatSupabaseError(error));
    }
  } catch (error) {
    console.error('Error in logEmployeeLogout:', formatSupabaseError(error));
  }
}
