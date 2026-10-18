import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database';

const REQUEST_TIMEOUT_MS = 8000;
const AUDIT_REQUEST_TIMEOUT_MS = 120000;
const getRequestTimeout = (input: RequestInfo | URL) =>
  /\/(?:functions\/v1\/content-audit|rest\/v1\/rpc\/(?:archive_employee_without_media|employee_export_shared_begin|employee_export_shared_verify|get_employee_export_shared_catalog|get_employee_export_shared_page|employee_import_shared_begin|employee_import_shared_stage|get_employee_import_shared_dry_run|employee_import_shared_apply|employee_import_shared_replace_begin|get_employee_import_shared_replace_dry_run|get_employee_import_shared_backup|get_employee_import_shared_backup_page|employee_import_shared_backup_append|employee_import_shared_backup_seal|get_employee_shared_saved_backup_chunk|employee_import_shared_replace_apply|employee_export_products_begin|get_employee_export_products_page|employee_export_products_verify|employee_import_products_begin|employee_import_products_stage|get_employee_import_products_dry_run|get_employee_import_products_backup|get_employee_import_products_backup_page|employee_import_products_backup_append|employee_import_products_backup_seal|get_employee_products_saved_backup_chunk|employee_import_products_apply|employee_products_close|employee_export_dispatch_begin|get_employee_export_dispatch_page|employee_export_dispatch_verify|employee_export_dispatch_close|get_employee_import_dispatch_preflight|employee_import_dispatch_begin|employee_import_dispatch_stage|get_employee_import_dispatch_dry_run|get_employee_import_dispatch_backup|get_employee_import_dispatch_backup_page|employee_import_dispatch_backup_append|employee_import_dispatch_backup_seal|get_employee_dispatch_saved_backup_chunk))(?:\?|\/|$)/.test(input instanceof Request ? input.url : input.toString())
    ? AUDIT_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
const MAX_NETWORK_RETRIES = 2;
const NETWORK_RETRY_DELAY_MS = 250;
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigurationError = !supabaseUrl || !supabaseAnonKey
  ? 'Supabase environment variables are missing. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  : supabaseUrl.includes('placeholder.supabase.co')
    ? 'Supabase is still using a placeholder URL. Replace VITE_SUPABASE_URL with your real project URL.'
    : null;

const stringifySupabaseErrorValue = (value: unknown, seen = new Set<object>()): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed && trimmed !== '[object Object]' ? trimmed : null;
  }

  if (typeof value === 'number' || typeof value === 'bigint') return String(value);

  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const details = value as Record<string, unknown>;
  const parts = ['message', 'code', 'details', 'hint']
    .map(key => stringifySupabaseErrorValue(details[key], seen))
    .filter((part): part is string => Boolean(part));

  if (parts.length > 0) return [...new Set(parts)].join(' | ');

  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized !== '{}' ? serialized : null;
  } catch {
    return null;
  }
};

export function formatSupabaseError(error: unknown): string {
  return stringifySupabaseErrorValue(error) || 'Unknown Supabase error';
}

export function isSupabaseAbortError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.name === 'AbortError' || error.message === 'signal is aborted without reason';
  }

  if (error && typeof error === 'object') {
    const details = error as { name?: unknown; message?: unknown };
    return details.name === 'AbortError' || details.message === 'signal is aborted without reason';
  }

  return false;
}

const isSupabaseTimeoutError = (error: unknown) => {
  if (error instanceof Error) return error.name === 'SupabaseTimeoutError';
  return Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'SupabaseTimeoutError');
};

export function isFinancialAdminSessionError(error: unknown): boolean {
  const message = formatSupabaseError(error).toLowerCase();
  return message.includes('financial administrator session is invalid or expired')
    || message.includes('administrator session has expired');
}

export function isEmployeeSessionEndedError(error: unknown): boolean {
  const message = formatSupabaseError(error).toLowerCase();
  return message.includes('employee session is invalid or expired')
    || message.includes('employee session has expired')
    || message.includes('invalid employee logout session')
    || message.includes('invalid employee login session');
}

export function isSupabaseTransientError(error: unknown): boolean {
  const name = error && typeof error === 'object' && 'name' in error
    ? String(error.name)
    : '';
  const status = error && typeof error === 'object' && 'status' in error
    ? Number(error.status)
    : NaN;
  const message = formatSupabaseError(error).toLowerCase();

  return name === 'SupabaseTimeoutError'
    || name === 'SupabaseNetworkError'
    || name === 'TypeError'
    || [408, 425, 429, 500, 502, 503, 504].includes(status)
    || message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('unable to connect to supabase')
    || message.includes('timed out');
}

const clientUrl = supabaseUrl || 'https://placeholder.supabase.co';
const clientKey = supabaseAnonKey || 'missing-anon-key';
const nativeFetch = globalThis.fetch.bind(globalThis);

const createSupabaseAbortError = () => {
  const abortError = new Error('Supabase request was cancelled.');
  abortError.name = 'AbortError';
  return abortError;
};

const isNetworkFetchError = (error: unknown) => {
  const errorName = typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : '';
  const errorMessage = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message)
      : String(error);

  return errorName === 'TypeError'
    || errorMessage === 'Failed to fetch'
    || errorMessage.includes('NetworkError');
};

const waitForNetworkRetry = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  let settled = false;

  const cleanup = () => signal?.removeEventListener('abort', handleAbort);
  const handleAbort = () => {
    if (settled) return;
    settled = true;
    globalThis.clearTimeout(timeoutId);
    cleanup();
    reject(createSupabaseAbortError());
  };

  const timeoutId = globalThis.setTimeout(() => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
  }, NETWORK_RETRY_DELAY_MS);

  signal?.addEventListener('abort', handleAbort, { once: true });
  if (signal?.aborted) handleAbort();
});

const getRequestMethod = (input: RequestInfo | URL, init?: RequestInit) => (
  init?.method || (input instanceof Request ? input.method : 'GET')
).toUpperCase();

const isReadOnlyRpcRequest = (input: RequestInfo | URL, method: string) => {
  if (method !== 'POST') return false;

  const url = input instanceof Request ? input.url : input.toString();
  const match = url.match(/\/rpc\/([^/?#]+)/i);
  if (!match) return false;

  const functionName = decodeURIComponent(match[1]).toLowerCase();
  if (functionName === 'get_or_create_service_session') return false;

  return functionName.startsWith('get_')
    || functionName.startsWith('count_')
    || functionName === 'preview_cleanup'
    || functionName === 'admin_preview_history_cleanup'
    || functionName === 'admin_get_history_cleanup_schedule'
    || functionName === 'check_login_rate_limit'
    || functionName === 'validate_employee_session';
};

const fetchWithXhrFallback: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = request?.url || input.toString();
  const method = init?.method || request?.method || 'GET';
  const signal = init?.signal || request?.signal;
  const headers = new Headers(request?.headers);

  if (init?.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  if (signal?.aborted) throw createSupabaseAbortError();

  let body: BodyInit | null | undefined;
  try {
    body = init?.body ?? (
      request && method !== 'GET' && method !== 'HEAD'
        ? await request.clone().text()
        : undefined
    );
  } catch (error) {
    if (signal?.aborted || isSupabaseAbortError(error)) throw createSupabaseAbortError();
    throw error;
  }

  if (signal?.aborted) throw createSupabaseAbortError();

  return new Promise<Response>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', handleAbort);
    const resolveOnce = (response: Response) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = () => {
      if (settled) return;
      rejectOnce(createSupabaseAbortError());
      xhr.abort();
    };

    xhr.open(method, url, true);
    xhr.responseType = 'arraybuffer';
    xhr.timeout = getRequestTimeout(input);
    xhr.withCredentials = (init?.credentials || request?.credentials) === 'include';
    headers.forEach((value, key) => xhr.setRequestHeader(key, value));

    xhr.onload = () => {
      const responseHeaders = new Headers();
      xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).forEach(line => {
        const separator = line.indexOf(':');
        if (separator > 0) {
          try {
            responseHeaders.append(
              line.slice(0, separator).trim(),
              line.slice(separator + 1).trim(),
            );
          } catch {
            return;
          }
        }
      });
      resolveOnce(new Response(xhr.response, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: responseHeaders,
      }));
    };
    xhr.onerror = () => rejectOnce(new TypeError('Failed to fetch'));
    xhr.ontimeout = () => {
      const timeoutError = new Error('Supabase request timed out. Check your project URL and network connection.');
      timeoutError.name = 'SupabaseTimeoutError';
      rejectOnce(timeoutError);
    };
    xhr.onabort = () => rejectOnce(createSupabaseAbortError());

    signal?.addEventListener('abort', handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }

    try {
      xhr.send(body as XMLHttpRequestBodyInit | Document | null | undefined);
    } catch (error) {
      rejectOnce(error);
    }
  });
};

const isReadOnlyAuditRequest = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : input.toString();
  if (getRequestMethod(input, init) !== 'POST' || !/\/functions\/v1\/content-audit(?:\?|$)/.test(url)
    || typeof init?.body !== 'string') return false;
  try {
    return ['media', 'pending_deletes'].includes(JSON.parse(init.body).action);
  } catch {
    return false;
  }
};

const fetchWithNetworkFallback: typeof fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : input.toString();
  // Delivery RPCs use one transport attempt to avoid replaying a committed claim.
  if (getRequestMethod(input, init) === 'POST'
    && /\/rest\/v1\/rpc\/(?:claim_realtime_notification_delivery|claim_next_realtime_notification_delivery|complete_notification_delivery)(?:\?|$)/.test(url)) {
    return fetchWithXhrFallback(input, init);
  }

  try {
    return await nativeFetch(input, init);
  } catch (error) {
    const method = getRequestMethod(input, init);
    if (!isNetworkFetchError(error)
      || (!['GET', 'HEAD', 'OPTIONS'].includes(method)
        && !isReadOnlyRpcRequest(input, method)
        && !isReadOnlyAuditRequest(input, init))) throw error;
    return fetchWithXhrFallback(input, init);
  }
};

const fetchWithTimeout: typeof fetch = async (input, init) => {
  const callerSignal = init?.signal || (input instanceof Request ? input.signal : undefined);
  if (callerSignal?.aborted) throw createSupabaseAbortError();

  const requestMethod = getRequestMethod(input, init);
  const canRetry = ['GET', 'HEAD', 'OPTIONS'].includes(requestMethod)
    || isReadOnlyRpcRequest(input, requestMethod)
    || isReadOnlyAuditRequest(input, init);

  for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      const timeoutError = new Error('Supabase request timed out. Check your project URL and network connection.');
      timeoutError.name = 'SupabaseTimeoutError';
      controller.abort(timeoutError);
    }, getRequestTimeout(input));
    const forwardCallerAbort = () => controller.abort(createSupabaseAbortError());

    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true });

    try {
      const response = await fetchWithNetworkFallback(input, { ...init, signal: controller.signal });
      const retryableStatus = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
      if (canRetry && retryableStatus && attempt < MAX_NETWORK_RETRIES) {
        await waitForNetworkRetry(callerSignal);
        continue;
      }
      return response;
    } catch (error) {
      if (callerSignal?.aborted) throw createSupabaseAbortError();

      let requestError = error;
      if (timedOut && canRetry) {
        try {
          return await fetchWithXhrFallback(input, init);
        } catch (fallbackError) {
          requestError = fallbackError;
        }
      }

      if (callerSignal?.aborted) throw createSupabaseAbortError();

      const isTimeout = timedOut || isSupabaseTimeoutError(requestError);
      if (!isTimeout && isSupabaseAbortError(requestError)) {
        throw createSupabaseAbortError();
      }

      const shouldRetry = canRetry
        && attempt < MAX_NETWORK_RETRIES
        && (isTimeout || isNetworkFetchError(requestError));

      if (shouldRetry) {
        await waitForNetworkRetry(callerSignal);
        continue;
      }

      if (isTimeout) {
        const timeoutError = new Error('Supabase request timed out. Check your project URL and network connection.');
        timeoutError.name = 'SupabaseTimeoutError';
        throw timeoutError;
      }

      if (isNetworkFetchError(requestError)) {
        const connectionError = new Error('Unable to connect to Supabase. Check your network connection and project URL.');
        connectionError.name = 'SupabaseNetworkError';
        throw connectionError;
      }
      throw requestError;
    } finally {
      globalThis.clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', forwardCallerAbort);
    }
  }

  throw new Error('Supabase request failed after retries.');
};

export const supabase = createClient<Database>(clientUrl, clientKey, {
  global: { fetch: fetchWithTimeout }
});
