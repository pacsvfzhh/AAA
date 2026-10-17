import type { TemporaryTransferSink } from './container';
import { Sha256 } from './sha256';

export const DISPATCH_TABLE_KEYS = Object.freeze([
  'dispatch_config', 'dispatch_groups', 'dispatch_order_pools', 'dispatch_group_orders',
  'dispatch_group_members', 'valid_order_data', 'used_order_data',
] as const);
export type DispatchTableKey = typeof DISPATCH_TABLE_KEYS[number];
const FIELDS: Record<DispatchTableKey, readonly string[]> = {
  dispatch_config: ['id', 'config_key', 'config_value', 'description', 'updated_at'],
  dispatch_groups: ['id', 'group_name', 'description', 'dispatch_interval_min', 'dispatch_interval_max',
    'session_timeout_minutes', 'dispatch_order_mode', 'is_default', 'is_active', 'created_by', 'created_at',
    'updated_at', 'dispatch_success_rate', 'pool_selection_mode', 'archived_at', 'submit_wait_min_seconds',
    'submit_wait_max_seconds', 'commission_rate', 'withdrawal_amount_threshold', 'withdrawal_orders_threshold',
    'withdrawal_condition_mode', 'grab_success_rate'],
  dispatch_order_pools: ['id', 'group_id', 'pool_name', 'is_base', 'is_active', 'dispatch_interval_min',
    'dispatch_interval_max', 'session_timeout_minutes', 'dispatch_order_mode', 'dispatch_success_rate',
    'archived_at', 'created_by', 'created_at', 'updated_at', 'trigger_probability'],
  dispatch_group_orders: ['id', 'group_id', 'order_content', 'is_active', 'created_by', 'created_at',
    'updated_at', 'pool_id', 'archived_at'],
  dispatch_group_members: ['id', 'group_id', 'user_id', 'assigned_by', 'assigned_at'],
  valid_order_data: ['id', 'product_value', 'transaction_id', 'is_active', 'created_by', 'created_at',
    'updated_at', 'usage_count', 'last_used_at', 'deactivated_at', 'deactivation_reason', 'priority', 'tags'],
  used_order_data: ['id', 'user_id', 'valid_order_data_id', 'order_id', 'created_at'],
};
const MAX_ROWS = 500000;
const MAX_TABLE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface DispatchTableCatalog {
  key: DispatchTableKey; rows: number; bytes: number; row_hashes_sha256: string;
}
export interface DispatchExportCatalog {
  version: 1; scope: 'dispatch-submission'; site_id: string;
  tables: DispatchTableCatalog[]; processing_orders: number; full_site_complete: false;
}
export interface DispatchExportSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(key: DispatchTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface DispatchExportProgress {
  scope: 'dispatch-submission'; tableKey: DispatchTableKey; rows: number; bytes: number; fullSiteComplete: false;
}
export interface DispatchExportResult {
  catalog: DispatchExportCatalog;
  entries: { path: string; kind: 'ndjson'; bytes: number; sha256: string }[];
  rows: number; bytes: number; fullSiteComplete: false;
}
export class DispatchExportCleanupError extends Error {
  readonly cleanupRequired = true;
  constructor() {
    super('Dispatch export temporary plaintext cleanup was not confirmed. Do not reuse the workspace.');
    this.name = 'DispatchExportCleanupError';
  }
}
function invalid(): never { throw new Error('Invalid dispatch/submission transfer response.'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !('value' in field)) invalid();
    result[key] = field.value;
  }
  return result;
}
function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Dispatch export cancelled.', 'AbortError');
}
async function withSignal<T>(operation: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new DOMException('Dispatch export cancelled.', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { checkAbort(signal); return operation(); }).then(
      value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); },
    );
  });
}
export const dispatchTransferChecks = Object.freeze({ object, uuid, checkAbort, withSignal });

export function validateDispatchCatalog(value: unknown): DispatchExportCatalog {
  const record = object(value, ['version', 'scope', 'site_id', 'tables', 'processing_orders', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'dispatch-submission' || record.full_site_complete !== false
    || !Array.isArray(record.tables) || record.tables.length !== DISPATCH_TABLE_KEYS.length) invalid();
  let total = 0;
  const tables = DISPATCH_TABLE_KEYS.map((key, index) => {
    const table = object((record.tables as unknown[])[index], ['key', 'rows', 'bytes', 'row_hashes_sha256']);
    if (table.key !== key) invalid();
    const rows = count(table.rows, MAX_ROWS), bytes = count(table.bytes, MAX_TABLE_BYTES);
    if ((rows === 0) !== (bytes === 0)) invalid();
    total += bytes;
    return { key, rows, bytes, row_hashes_sha256: hash(table.row_hashes_sha256) };
  });
  if (total > MAX_TOTAL_BYTES) invalid();
  return { version: 1, scope: 'dispatch-submission', site_id: uuid(record.site_id), tables,
    processing_orders: count(record.processing_orders), full_site_complete: false };
}
export function validateDispatchVerification(value: unknown): void {
  const record = object(value, ['verified', 'scope', 'full_site_complete']);
  if (record.verified !== true || record.scope !== 'dispatch-submission' || record.full_site_complete !== false) invalid();
}
function unicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
}
function rowIdentity(line: string, key: DispatchTableKey): string {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { invalid(); }
  const row = object(parsed, FIELDS[key]);
  const seen = new Set<string>();
  for (const token of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    const decoded: unknown = JSON.parse(token[0]);
    if (typeof decoded !== 'string') invalid();
    unicode(decoded);
    if (/^[\t\r ]*:/.test(line.slice(token.index! + token[0].length))) {
      if (seen.has(decoded)) invalid();
      seen.add(decoded);
    }
  }
  return uuid(row.id);
}

export async function exportDispatchData(
  source: DispatchExportSource, sink: TemporaryTransferSink,
  options: { signal?: AbortSignal; onProgress?: (progress: DispatchExportProgress) => void } = {},
): Promise<DispatchExportResult> {
  const { signal, onProgress } = options;
  try {
    const catalog = validateDispatchCatalog(await withSignal(() => source.catalog(signal), signal));
    const entries: DispatchExportResult['entries'] = [];
    let rows = 0, bytes = 0;
    for (const expected of catalog.tables) {
      const path = `data/dispatch-${expected.key}.ndjson`;
      const digest = new Sha256(), rowHashes = new Sha256();
      let tableRows = 0, tableBytes = 0;
      let after: string | null = null, lastId: string | null = null;
      do {
        const page = object(await withSignal(() => source.page(expected.key, after, signal), signal),
          ['table_key', 'count', 'ndjson', 'next_after', 'sha256']);
        if (page.table_key !== expected.key || typeof page.ndjson !== 'string'
          || page.ndjson.length > MAX_PAGE_BYTES) invalid();
        unicode(page.ndjson);
        const chunk = encoder.encode(page.ndjson);
        const pageCount = count(page.count, 200);
        const nextAfter = page.next_after === null ? null : uuid(page.next_after);
        if (chunk.length > MAX_PAGE_BYTES || (chunk.length && chunk[chunk.length - 1] !== 10)
          || new Sha256().update(chunk).digestHex() !== hash(page.sha256)) invalid();
        let start = 0, actualRows = 0;
        for (let end = 0; end < chunk.length; end++) {
          if (chunk[end] !== 10) continue;
          if (end - start + 1 > MAX_LINE_BYTES) invalid();
          const id = rowIdentity(decoder.decode(chunk.subarray(start, end)), expected.key);
          if (lastId !== null && id <= lastId) invalid();
          lastId = id;
          rowHashes.update(encoder.encode(new Sha256().update(chunk.subarray(start, end + 1)).digestHex()));
          actualRows++; start = end + 1;
        }
        if (actualRows !== pageCount || (nextAfter !== null && (pageCount === 0 || nextAfter !== lastId))
          || tableRows + pageCount > expected.rows || tableBytes + chunk.length > expected.bytes) invalid();
        digest.update(chunk);
        await withSignal(() => sink.append(path, chunk, signal), signal);
        checkAbort(signal);
        tableRows += pageCount; tableBytes += chunk.length; rows += pageCount; bytes += chunk.length;
        onProgress?.({ scope: 'dispatch-submission', tableKey: expected.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
        after = nextAfter;
      } while (after !== null);
      if (tableRows !== expected.rows || tableBytes !== expected.bytes
        || rowHashes.digestHex() !== expected.row_hashes_sha256) invalid();
      entries.push({ path, kind: 'ndjson', bytes: tableBytes, sha256: digest.digestHex() });
    }
    validateDispatchVerification(await withSignal(() => source.verify(signal), signal));
    checkAbort(signal);
    return { catalog, entries, rows, bytes, fullSiteComplete: false };
  } catch {
    try { await sink.abort(new Error('Dispatch export discarded.')); } catch { throw new DispatchExportCleanupError(); }
    checkAbort(signal);
    throw new Error('Dispatch export validation, source verification or temporary write failed.');
  }
}

const PREFLIGHT_KEYS = Object.freeze(['orders', 'orders_history', 'used_submissions', 'submission_usage',
  'assignments', 'pool_selections', 'dispatch_sessions', 'wallet_transactions', 'ledger_entries', 'withdrawals',
  'wallet_funds', 'income', 'baseline_funds', 'work_sessions', 'legacy_dispatch_content'] as const);
export interface DispatchPreflight {
  scope: 'dispatch-submission'; site_id: string; counts: Record<typeof PREFLIGHT_KEYS[number], number>;
  blockers: { code: typeof PREFLIGHT_KEYS[number]; count: number }[];
  eligible_for_empty_target_mode: boolean; replacement_ready: false; full_site_complete: false;
}
export function validateDispatchPreflight(value: unknown): DispatchPreflight {
  const record = object(value, ['scope', 'site_id', 'counts', 'blockers', 'eligible_for_empty_target_mode',
    'replacement_ready', 'full_site_complete']);
  if (record.scope !== 'dispatch-submission' || record.replacement_ready !== false || record.full_site_complete !== false
    || !Array.isArray(record.blockers)) invalid();
  const raw = object(record.counts, PREFLIGHT_KEYS);
  const counts = Object.fromEntries(PREFLIGHT_KEYS.map(key => [key, count(raw[key])])) as DispatchPreflight['counts'];
  const expected = PREFLIGHT_KEYS.filter(key => counts[key] > 0);
  const seen = new Set<string>();
  const blockers = record.blockers.map(value => {
    const blocker = object(value, ['code', 'count']);
    const code = expected.find(key => key === blocker.code);
    if (!code || seen.has(code) || count(blocker.count) !== counts[code]) invalid();
    seen.add(code);
    return { code, count: counts[code] };
  });
  if (seen.size !== expected.length || record.eligible_for_empty_target_mode !== (seen.size === 0)) invalid();
  return { scope: 'dispatch-submission', site_id: uuid(record.site_id), counts, blockers,
    eligible_for_empty_target_mode: seen.size === 0, replacement_ready: false, full_site_complete: false };
}
