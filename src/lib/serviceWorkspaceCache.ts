import { isSupabaseTransientError, supabase } from './supabase';
import type { AdminGroup } from '../components/admin/AdminGroupPicker';
import type { Database } from '../types/database';
import { getAdminFinancialSessionToken } from './auth';

export type ServiceWorkspace = 'customer' | 'manager';

type WorkspaceSource = 'aaa_service' | 'ccc_service';

const pendingRequests = new Map<string, Promise<AdminGroup[]>>();
const cachedGroups = new Map<string, AdminGroup[]>();

export interface ServiceWorkspaceData<TCustomer = Record<string, unknown>, TEmployee = Record<string, unknown>> {
  customers: TCustomer[];
  employees: TEmployee[];
}

const pendingDataRequests = new Map<string, Promise<ServiceWorkspaceData>>();
const cachedWorkspaceData = new Map<string, ServiceWorkspaceData>();
const pendingConversationRequests = new Map<string, Promise<unknown[]>>();
const cachedConversationSummaries = new Map<string, unknown[]>();
const CACHE_RETRY_LIMIT = 2;
const CACHE_RETRY_DELAY_MS = 350;
const SUMMARY_PAGE_SIZE = 1000;

export type ConversationSummaryRow = Database['public']['Functions']['get_ccc_conversation_summaries']['Returns'][number];

const waitForCacheRetry = () => new Promise<void>(resolve => {
  globalThis.setTimeout(resolve, CACHE_RETRY_DELAY_MS);
});

async function loadWithTransientRetry<T>(loader: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= CACHE_RETRY_LIMIT; attempt += 1) {
    try {
      return await loader();
    } catch (error) {
      if (!isSupabaseTransientError(error) || attempt === CACHE_RETRY_LIMIT) throw error;
      await waitForCacheRetry();
    }
  }

  throw new Error('Service workspace request failed after retries.');
}

function queueRequest<T>(
  pendingRequests: Map<string, Promise<T>>,
  cacheKey: string,
  loader: () => Promise<T>,
  onSuccess: (value: T) => void,
) {
  const pending = pendingRequests.get(cacheKey);
  if (pending) return pending;

  const request = loadWithTransientRetry(loader).then(value => {
    if (pendingRequests.get(cacheKey) === trackedRequest) {
      onSuccess(value);
    }
    return value;
  });
  const trackedRequest = request.finally(() => {
    if (pendingRequests.get(cacheKey) === trackedRequest) {
      pendingRequests.delete(cacheKey);
    }
  });
  pendingRequests.set(cacheKey, trackedRequest);
  return trackedRequest;
}

function getSourceType(service: ServiceWorkspace): WorkspaceSource {
  return service === 'customer' ? 'aaa_service' : 'ccc_service';
}

function getCacheKey(adminId: string, service: ServiceWorkspace) {
  return `${adminId}:${service}`;
}

function getDataCacheKey(adminId: string, service: ServiceWorkspace) {
  return `${adminId}:${service}:data`;
}

function normalizeAdminGroups(data: unknown): AdminGroup[] {
  if (!Array.isArray(data)) {
    throw new Error('Admin groups response is not an array');
  }
  return data as AdminGroup[];
}

// Unread employee messages per admin group, counted in the database for the signed-in admin's scope.
export async function fetchAdminChatUnreadCounts(service?: ServiceWorkspace) {
  const { data, error } = await supabase.rpc('get_admin_chat_unread_counts', {
    p_admin_session_token: getAdminFinancialSessionToken(),
  });
  if (error) throw error;
  const sourceType = service ? getSourceType(service) : null;
  const counts = new Map<string, number>();
  (data || []).forEach(row => {
    if (sourceType && row.source_type !== sourceType) return;
    counts.set(row.admin_id, (counts.get(row.admin_id) || 0) + Number(row.unread_count));
  });
  return { rows: data || [], countsByAdmin: counts };
}

export function prefetchAdminGroups(
  adminId: string,
  service: ServiceWorkspace,
  force = false,
): Promise<AdminGroup[]> {
  const cacheKey = getCacheKey(adminId, service);
  if (!force) {
    const cached = cachedGroups.get(cacheKey);
    if (cached) return Promise.resolve(cached);
  }

  const loadGroups = () => Promise.resolve(
    supabase.rpc('get_admin_groups_for_customer_service', {
      p_source_type: getSourceType(service),
    }),
  ).then(({ data, error }) => {
    if (error) throw error;
    return normalizeAdminGroups(data).map(group => ({
      ...group,
      conversation_count: Number(group.conversation_count) || 0,
    }));
  });

  return queueRequest(
    pendingRequests,
    cacheKey,
    loadGroups,
    groups => cachedGroups.set(cacheKey, groups),
  );
}

export function prefetchAdminWorkspaceData<TCustomer = Record<string, unknown>, TEmployee = Record<string, unknown>>(
  adminId: string,
  service: ServiceWorkspace,
  force = false,
): Promise<ServiceWorkspaceData<TCustomer, TEmployee>> {
  const cacheKey = getDataCacheKey(adminId, service);
  if (!force) {
    const cached = cachedWorkspaceData.get(cacheKey);
    if (cached) return Promise.resolve(cached as ServiceWorkspaceData<TCustomer, TEmployee>);
  }

  return queueRequest(
    pendingDataRequests as Map<string, Promise<ServiceWorkspaceData<TCustomer, TEmployee>>>,
    cacheKey,
    () => Promise.all([
      supabase
        .from('simulated_customers')
        .select('id, admin_id, customer_name, customer_id, customer_avatar, is_active, created_at, is_super, super_customer_title, badge_type, custom_avatar_url, is_pinned, vip_label, remarks, employee_pin_top, employee_always_visible, target_employee_ids, auto_messages_enabled')
        .eq('admin_id', adminId)
        .eq('source_type', getSourceType(service))
        .order('created_at', { ascending: false }),
      supabase
        .from('users')
        .select('id, username, employee_id, is_verified, is_active, remarks, tags, created_by, created_at')
        .eq('created_by', adminId)
        .order('username'),
    ]).then(([customersRes, employeesRes]) => {
      if (customersRes.error) throw customersRes.error;
      if (employeesRes.error) throw employeesRes.error;

      return {
        customers: customersRes.data || [],
        employees: employeesRes.data || [],
      } as ServiceWorkspaceData<TCustomer, TEmployee>;
    }),
    data => cachedWorkspaceData.set(cacheKey, data as ServiceWorkspaceData),
  );
}

// PostgREST caps each response at 1000 rows, so large workspaces are read page by page.
export async function fetchConversationSummaryRows(
  adminId: string,
  service: ServiceWorkspace,
  customerId?: string,
): Promise<ConversationSummaryRow[]> {
  const rows: ConversationSummaryRow[] = [];
  for (let from = 0; ; from += SUMMARY_PAGE_SIZE) {
    let query = supabase.rpc('get_ccc_conversation_summaries', {
      p_admin_id: adminId,
      p_source_type: getSourceType(service),
    });
    if (customerId) query = query.eq('customer_id', customerId);
    const { data, error } = await query
      .order('customer_id')
      .order('employee_id')
      .range(from, from + SUMMARY_PAGE_SIZE - 1);

    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < SUMMARY_PAGE_SIZE) return rows;
  }
}

export function invalidateAdminGroupsCache(
  adminId: string,
  service: ServiceWorkspace,
) {
  cachedGroups.delete(getCacheKey(adminId, service));
}

export function prefetchConversationSummaries<TSummary = unknown>(
  adminId: string,
  service: ServiceWorkspace,
  loader: () => Promise<TSummary[]>,
  force = false,
): Promise<TSummary[]> {
  const cacheKey = `${getCacheKey(adminId, service)}:conversations`;
  if (!force) {
    const cached = cachedConversationSummaries.get(cacheKey);
    if (cached) return Promise.resolve(cached as TSummary[]);
  }

  return queueRequest(
    pendingConversationRequests as Map<string, Promise<TSummary[]>>,
    cacheKey,
    loader,
    summaries => cachedConversationSummaries.set(cacheKey, summaries as unknown[]),
  );
}

export function getCachedAdminWorkspaceData<TCustomer = Record<string, unknown>, TEmployee = Record<string, unknown>>(
  adminId: string,
  service: ServiceWorkspace,
): ServiceWorkspaceData<TCustomer, TEmployee> | null {
  return cachedWorkspaceData.get(getDataCacheKey(adminId, service)) as ServiceWorkspaceData<TCustomer, TEmployee> | undefined || null;
}

export function getCachedConversationSummaries<TSummary = unknown>(
  adminId: string,
  service: ServiceWorkspace,
): TSummary[] | null {
  return cachedConversationSummaries.get(`${getCacheKey(adminId, service)}:conversations`) as TSummary[] | undefined || null;
}

export function invalidateAdminWorkspaceDataCache(
  adminId: string,
  service: ServiceWorkspace,
) {
  const cacheKey = getDataCacheKey(adminId, service);
  pendingDataRequests.delete(cacheKey);
  cachedWorkspaceData.delete(cacheKey);
}

export function invalidateConversationSummariesCache(
  adminId: string,
  service: ServiceWorkspace,
) {
  const cacheKey = `${getCacheKey(adminId, service)}:conversations`;
  pendingConversationRequests.delete(cacheKey);
  cachedConversationSummaries.delete(cacheKey);
}
