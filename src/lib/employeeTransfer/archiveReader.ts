import { getAdminFinancialSessionToken } from '../auth';
import { supabase } from '../supabase';
import { dispatchTransferChecks } from './dispatchTransfer';
import {
  ARCHIVES_TABLE_KEYS, ARCHIVES_TRANSFER_LIMITS, archivesCursor, archivesTableKey,
  validateArchivesPage, validateArchivesRow,
  type ArchivesCounts, type ArchivesPage, type ArchivesTableKey,
} from './archiveTransfer';

export interface TransferredArchiveNamespace {
  readonly source_site_id: string;
  readonly package_id: string;
  readonly imported_at: string;
  readonly counts: Readonly<ArchivesCounts>;
  readonly media_pending: boolean;
}
export interface TransferredArchiveNamespacesPage {
  readonly items: readonly TransferredArchiveNamespace[];
  readonly next_after: string | null;
}
export interface TransferredArchiveRow {
  readonly sourceId: string;
  // Includes the original trailing LF. Never reconstruct this from parsed display data.
  readonly sourceLine: string;
}
export interface TransferredArchivePage extends Readonly<ArchivesPage> {
  readonly rows: readonly TransferredArchiveRow[];
}
export interface TransferredArchivesReader {
  namespaces(after?: string | null, limit?: number, signal?: AbortSignal): Promise<TransferredArchiveNamespacesPage>;
  page(sourceSiteId: string, packageId: string, key: ArchivesTableKey, after?: string | null,
    limit?: number, signal?: AbortSignal): Promise<TransferredArchivePage>;
}

const { object, count, withSignal, checkAbort } = dispatchTransferChecks;
const failure = '遷入檔案讀取或回執核驗失敗，請重試；若持續失敗，請重新登入並請管理員核對來源檔案。';
function invalid(): never { throw new Error(failure); }
function uuid(value: unknown): string {
  const result = dispatchTransferChecks.uuid(value);
  if (result.length !== 36) invalid();
  return result;
}
function cursor(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 73 || value[36] !== ':') invalid();
  uuid(value.slice(0, 36)); uuid(value.slice(37));
  return value;
}
function pageLimit(value: number, max: number): number {
  if (count(value, max) === 0) invalid();
  return value;
}
export function validateTransferredArchiveNamespaces(
  value: unknown, after: string | null = null, limit = 30,
): TransferredArchiveNamespacesPage {
  pageLimit(limit, 100);
  let last = after === null ? null : cursor(after);
  const record = object(value, ['items', 'next_after']);
  if (!Array.isArray(record.items) || record.items.length > limit) invalid();
  const items = Array.from(record.items, value => {
    const item = object(value, ['source_site_id', 'package_id', 'imported_at', 'counts', 'media_pending']);
    const sourceSiteId = uuid(item.source_site_id), packageId = uuid(item.package_id);
    const current = `${sourceSiteId}:${packageId}`;
    if (last !== null && current <= last) invalid();
    last = current;
    if (typeof item.imported_at !== 'string' || item.imported_at.length > 64
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(item.imported_at)
      || !Number.isFinite(Date.parse(item.imported_at)) || typeof item.media_pending !== 'boolean') invalid();
    const rawCounts = object(item.counts, ARCHIVES_TABLE_KEYS);
    const counts = Object.fromEntries(ARCHIVES_TABLE_KEYS.map(key => [key, count(rawCounts[key], ARCHIVES_TRANSFER_LIMITS.maxRows)])) as ArchivesCounts;
    return Object.freeze({ source_site_id: sourceSiteId, package_id: packageId, imported_at: item.imported_at,
      counts: Object.freeze(counts), media_pending: item.media_pending });
  });
  const next = record.next_after === null ? null : cursor(record.next_after);
  if (next !== null && (items.length !== limit || next !== last)) invalid();
  return Object.freeze({ items: Object.freeze(items), next_after: next });
}
export function validateTransferredArchivePage(
  value: unknown, key: ArchivesTableKey, after: string | null = null, limit = 100,
): TransferredArchivePage {
  pageLimit(limit, 200);
  const page = validateArchivesPage(value, key, after);
  if (page.count > limit) invalid();
  const rows: TransferredArchiveRow[] = [];
  let start = 0;
  for (let end = 0; end < page.ndjson.length; end++) {
    if (page.ndjson[end] !== '\n') continue;
    const sourceLine = page.ndjson.slice(start, end + 1);
    rows.push(Object.freeze({ sourceId: validateArchivesRow(sourceLine, key), sourceLine }));
    start = end + 1;
  }
  return Object.freeze({ ...page, rows: Object.freeze(rows) });
}

type Query = PromiseLike<{ data: unknown; error: unknown }> & { abortSignal(signal: AbortSignal): Query };
async function request<T>(operation: () => Query, validate: (data: unknown) => T, signal?: AbortSignal): Promise<T> {
  try {
    checkAbort(signal);
    const { data, error } = await withSignal(() => {
      const query = operation();
      return signal ? query.abortSignal(signal) : query;
    }, signal);
    checkAbort(signal);
    if (error) invalid();
    const result = validate(data);
    checkAbort(signal);
    return result;
  } catch {
    if (signal?.aborted) throw new DOMException('檔案讀取已取消。', 'AbortError');
    // Do not echo SQL errors, historical content or authentication material.
    throw new Error(failure);
  }
}
export function createTransferredArchivesReader(): TransferredArchivesReader {
  return {
    async namespaces(after = null, limit = 30, signal) {
      if (after !== null) cursor(after);
      pageLimit(limit, 100);
      return request(() => supabase.rpc('get_employee_transferred_archive_namespaces', {
        p_admin_session_token: uuid(getAdminFinancialSessionToken()), p_after: after, p_limit: limit,
      }),
        data => validateTransferredArchiveNamespaces(data, after, limit), signal);
    },
    async page(sourceSiteId, packageId, key, after = null, limit = 100, signal) {
      uuid(sourceSiteId); uuid(packageId); archivesTableKey(key); pageLimit(limit, 200);
      if (after !== null) archivesCursor(key, after);
      return request(() => supabase.rpc('get_employee_transferred_archive_page', {
        p_admin_session_token: uuid(getAdminFinancialSessionToken()),
        p_source_site_id: sourceSiteId, p_package_id: packageId, p_table_key: key, p_after: after, p_limit: limit,
      }), data => validateTransferredArchivePage(data, key, after, limit), signal);
    },
  };
}
