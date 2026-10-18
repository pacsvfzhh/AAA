import type { TemporaryTransferSink } from './container';
import { Sha256 } from './sha256';

export const SHARED_TABLE_KEYS = Object.freeze([
  'admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config',
] as const);
export type SharedTableKey = typeof SHARED_TABLE_KEYS[number];

const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_TABLE_ROWS = 10000;
const MAX_PAGE_ROWS = 200;
const MAX_PAGE_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const EXCLUDED_SYSTEM_KEYS = ['ios_config', 'auto_cleanup_schedule', 'auto_cleanup_history'];
const encoder = new TextEncoder();

export interface SharedTableCatalog {
  key: SharedTableKey;
  rows: number;
  bytes: number;
  sha256: string;
}
export interface SharedExportCatalog {
  version: 1;
  scope: 'shared-settings';
  site_id: string;
  tables: SharedTableCatalog[];
  excluded_system_keys: string[];
  full_site_complete: false;
}
export interface SharedExportPage {
  table_key: SharedTableKey;
  count: number;
  ndjson: string;
  next_after: string | null;
  sha256: string;
}
export interface SharedExportSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(key: SharedTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface SharedExportProgress {
  scope: 'shared-settings';
  tableKey: SharedTableKey;
  rows: number;
  bytes: number;
  fullSiteComplete: false;
}
export interface SharedExportOptions {
  signal?: AbortSignal;
  onProgress?: (progress: SharedExportProgress) => void;
}
export interface SharedExportEntry {
  path: string;
  bytes: number;
  sha256: string;
  kind: 'ndjson';
}
export class SharedExportCleanupError extends Error {
  readonly cleanupRequired = true;
  readonly originalError: unknown;

  constructor(originalError: unknown) {
    super('Shared-settings export failed and temporary cleanup could not be confirmed. Do not reuse the temporary workspace.');
    this.name = 'SharedExportCleanupError';
    this.originalError = originalError;
  }
}

export interface SharedExportResult {
  catalog: SharedExportCatalog;
  entries: SharedExportEntry[];
  rows: number;
  bytes: number;
  fullSiteComplete: false;
}

function invalid(detail: string): never {
  // Never include source values, NDJSON, parser diagnostics or credentials in validation errors.
  throw new Error(`Invalid shared-settings export: ${detail}.`);
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('object shape');
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) {
    invalid('object fields');
  }
  const record: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid('object field descriptor');
    record[key] = descriptor.value;
  }
  return record;
}

function integer(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    invalid('count or byte limit');
  }
  return value;
}

function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid('SHA-256 format');
  return value;
}

function tableKey(value: unknown): SharedTableKey {
  const key = SHARED_TABLE_KEYS.find(key => key === value);
  if (key === undefined) invalid('table key');
  return key;
}

export function validateSharedExportCatalog(value: unknown): SharedExportCatalog {
  const record = object(value, ['version', 'scope', 'site_id', 'tables', 'excluded_system_keys', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'shared-settings' || record.full_site_complete !== false
    || typeof record.site_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.site_id)
    || !Array.isArray(record.tables) || record.tables.length !== SHARED_TABLE_KEYS.length
    || !Array.isArray(record.excluded_system_keys)
    || record.excluded_system_keys.length > EXCLUDED_SYSTEM_KEYS.length) invalid('catalog');
  const tables: SharedTableCatalog[] = [];
  const seen = new Set<SharedTableKey>();
  let totalBytes = 0;
  for (const value of record.tables) {
    const entry = object(value, ['key', 'rows', 'bytes', 'sha256']);
    const key = tableKey(entry.key);
    if (seen.has(key)) invalid('duplicate table');
    seen.add(key);
    const rows = integer(entry.rows, MAX_TABLE_ROWS);
    const bytes = integer(entry.bytes, MAX_TOTAL_BYTES);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) invalid('total byte limit');
    tables.push({ key, rows, bytes, sha256: sha256(entry.sha256) });
  }
  const excludedKeys: string[] = [];
  for (const key of record.excluded_system_keys) {
    if (typeof key !== 'string' || !EXCLUDED_SYSTEM_KEYS.includes(key) || excludedKeys.includes(key)) {
      invalid('excluded system keys');
    }
    excludedKeys.push(key);
  }
  return {
    version: 1, scope: 'shared-settings', site_id: record.site_id,
    tables, excluded_system_keys: excludedKeys, full_site_complete: false,
  };
}

function validatePage(value: unknown, key: SharedTableKey): SharedExportPage {
  const record = object(value, ['table_key', 'count', 'ndjson', 'next_after', 'sha256']);
  if (record.table_key !== key || typeof record.ndjson !== 'string'
    || (record.next_after !== null && (typeof record.next_after !== 'string'
      || record.next_after.length === 0 || record.next_after.length > 128))) {
    invalid('page');
  }
  return {
    table_key: key, count: integer(record.count, MAX_PAGE_ROWS), ndjson: record.ndjson,
    next_after: record.next_after, sha256: sha256(record.sha256),
  };
}

function validateVerification(value: unknown): void {
  const record = object(value, ['verified', 'scope', 'full_site_complete']);
  if (record.verified !== true || record.scope !== 'shared-settings' || record.full_site_complete !== false) {
    invalid('source verification');
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Shared-settings export cancelled.', 'AbortError');
}

async function withSignal<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(new DOMException('Shared-settings export cancelled.', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    // Keep rejection handlers on late operations. Cancellation must not await a stalled source/write.
    Promise.resolve().then(() => {
      checkAbort(signal);
      return operation();
    }).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function checkUnicode(text: string): void {
  // TextEncoder replaces unpaired surrogates; reject them rather than silently hashing different text.
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid('NDJSON Unicode');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid('NDJSON Unicode');
  }
}

function checkObjectLine(line: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { invalid('NDJSON syntax'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) invalid('NDJSON object row');

  // JSON.parse loses duplicate keys; scan iteratively to reject escaped aliases without recursive stack growth.
  const stack: (Set<string> | null)[] = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '{') stack.push(new Set<string>());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = index;
      while (++index < line.length) {
        if (line[index] === '\\') index++;
        else if (line[index] === '"') break;
      }
      let after = index + 1;
      while (line[after] === ' ' || line[after] === '\t' || line[after] === '\r') after++;
      if (line[after] === ':') {
        const keys = stack[stack.length - 1];
        const key: unknown = JSON.parse(line.slice(start, index + 1));
        if (!keys || typeof key !== 'string' || keys.has(key)) invalid('duplicate NDJSON key');
        keys.add(key);
      }
    }
  }
}

function pageBytes(page: SharedExportPage): Uint8Array {
  // UTF-8 cannot use fewer bytes than UTF-16 code units. Bound allocation before encoding/parsing.
  if (page.ndjson.length > MAX_PAGE_BYTES) invalid('page byte limit');
  checkUnicode(page.ndjson);
  const bytes = encoder.encode(page.ndjson);
  if (bytes.length > MAX_PAGE_BYTES) invalid('page byte limit');
  if (new Sha256().update(bytes).digestHex() !== page.sha256) invalid('page SHA-256 mismatch');
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) invalid('NDJSON final newline');
  let start = 0;
  let count = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    // Line limit excludes the LF delimiter, matching the container's NDJSON line bound.
    if (end - start > MAX_LINE_BYTES) invalid('NDJSON line byte limit');
    count++;
    if (count > MAX_PAGE_ROWS) invalid('page row limit');
    checkObjectLine(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start, end)));
    start = end + 1;
  }
  if (count !== page.count) invalid('page count mismatch');
  return bytes;
}

export async function exportSharedSettings(
  source: SharedExportSource,
  sink: TemporaryTransferSink,
  options: SharedExportOptions = {},
): Promise<SharedExportResult> {
  const { signal, onProgress } = options;
  try {
    const catalog = validateSharedExportCatalog(await withSignal(() => source.catalog(signal), signal));
    checkAbort(signal);
    const entries: SharedExportEntry[] = [];
    let rows = 0;
    let bytes = 0;
    for (const key of SHARED_TABLE_KEYS) {
      const expected = catalog.tables.find(table => table.key === key)!;
      const path = `data/shared-${key}.ndjson`;
      const hash = new Sha256();
      const cursors = new Set<string>();
      let after: string | null = null;
      let tableRows = 0;
      let tableBytes = 0;
      do {
        const page = validatePage(await withSignal(() => source.page(key, after, signal), signal), key);
        checkAbort(signal);
        const chunk = pageBytes(page);
        if (page.next_after !== null) {
          if (page.count === 0 || cursors.has(page.next_after)) invalid('non-advancing page cursor');
          cursors.add(page.next_after);
        }
        const nextRows = tableRows + page.count;
        const nextBytes = tableBytes + chunk.length;
        if (nextRows > expected.rows || nextRows > MAX_TABLE_ROWS || nextBytes > expected.bytes
          || bytes + chunk.length > MAX_TOTAL_BYTES) invalid('table totals exceeded');
        // Hash original bytes before handing the buffer to a third-party sink; no reserialization.
        hash.update(chunk);
        await withSignal(() => sink.append(path, chunk, signal), signal);
        checkAbort(signal);
        tableRows = nextRows;
        tableBytes = nextBytes;
        rows += page.count;
        bytes += chunk.length;
        onProgress?.({ scope: 'shared-settings', tableKey: key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
        after = page.next_after;
      } while (after !== null);
      const digest = hash.digestHex();
      if (tableRows !== expected.rows || tableBytes !== expected.bytes || digest !== expected.sha256) {
        invalid('table totals or SHA-256 mismatch');
      }
      entries.push({ path, bytes: tableBytes, sha256: digest, kind: 'ndjson' });
    }
    validateVerification(await withSignal(() => source.verify(signal), signal));
    checkAbort(signal);
    return { catalog, entries, rows, bytes, fullSiteComplete: false };
  } catch (error) {
    // abort must invalidate pending/late appends as well as delete already written files.
    try { await sink.abort(error); } catch { throw new SharedExportCleanupError(error); }
    throw error;
  }
}
