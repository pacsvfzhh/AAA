import type { ContainerLimits, TemporaryTransferSink } from './container';
import type { TransferByteSource } from './crypto';
import type { VolumeManifest } from './manifest';
import { Sha256 } from './sha256';

const MAX_INPUT_BYTES = 1024 * 1024;
export const PRODUCT_ENTRY_PATH = 'data/products.ndjson';
export const PRODUCT_MAX_BYTES = 8 * 1024 * 1024;
export const PRODUCT_MAX_PAGE_BYTES = 256 * 1024;
export const PRODUCT_MAX_LINE_BYTES = 64 * 1024; // Excludes the LF delimiter, like the SQL exporter/container.
export const PRODUCT_MAX_ROWS = 10000;
export const PRODUCT_MAX_PAGE_ROWS = 200;
export const PRODUCT_CONTAINER_LIMITS: Readonly<Partial<ContainerLimits>> = Object.freeze({
  maxEntries: 1, maxEntryBytes: PRODUCT_MAX_BYTES, maxTotalBytes: PRODUCT_MAX_BYTES,
  maxZipBytes: 9 * 1024 * 1024, maxManifestBytes: 16 * 1024, maxLineBytes: PRODUCT_MAX_LINE_BYTES,
});
export interface ProductTableCatalog {
  key: 'product_types'; rows: number; bytes: number; sha256: string;
}
export interface ProductExportCatalog {
  version: 1; scope: 'product-catalog'; site_id: string;
  tables: [ProductTableCatalog]; full_site_complete: false;
}
export interface ProductExportSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface ProductTransferProgress {
  scope: 'product-catalog'; phase: 'export' | 'validate' | 'stage' | 'dry-run';
  rows: number; bytes: number; fullSiteComplete: false;
}
export interface ProductTransferOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ProductTransferProgress) => void;
}
export interface ProductExportResult {
  catalog: ProductExportCatalog;
  entries: [{ path: typeof PRODUCT_ENTRY_PATH; kind: 'ndjson'; bytes: number; sha256: string }];
  rows: number; bytes: number; fullSiteComplete: false;
}
export interface ProductImportFiles {
  // Only isolated, immutable files from a fully authenticated volume; use importProductsVolume for encrypted input.
  open(path: typeof PRODUCT_ENTRY_PATH): TransferByteSource | ReadableStream<Uint8Array>;
}
export interface ProductImportTarget {
  begin(catalog: ProductExportCatalog, signal?: AbortSignal): Promise<unknown>;
  stage(chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<unknown>;
  dryRun(signal?: AbortSignal): Promise<unknown>;
}
export interface ProductImportDryRun {
  scope: 'product-catalog'; full_site_complete: false; can_apply: boolean;
  conflicts: unknown[]; records: unknown[]; plan_hash: string;
}
export interface ProductImportResult {
  dryRun: ProductImportDryRun; rows: number; bytes: number; fullSiteComplete: false;
}
export class ProductTransferCleanupError extends Error {
  readonly cleanupRequired = true;
  constructor(readonly stagingMayExist = false) {
    super('Product transfer temporary plaintext cleanup was not confirmed. Do not reuse the workspace; reconcile any server staging before retrying.');
    this.name = 'ProductTransferCleanupError';
  }
}
export class ProductImportStagingMayExistError extends Error {
  readonly stagingMayExist = true;
  constructor(readonly cancelled: boolean) {
    super('Product import stopped. Server staging may already exist; reconcile it before rerunning. No automatic retry, rollback, apply or close was performed.');
    this.name = 'ProductImportStagingMayExistError';
  }
}
function invalid(): never { throw new Error('Invalid product-catalog transfer.'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const record: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !('value' in field)) invalid();
    record[key] = field.value;
  }
  return record;
}
function count(value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid();
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
  if (signal?.aborted) throw new DOMException('Product transfer cancelled.', 'AbortError');
}
async function withSignal<T>(operation: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new DOMException('Product transfer cancelled.', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    // Late completions/rejections are observed, but cannot resume a cancelled operation.
    Promise.resolve().then(() => { checkAbort(signal); return operation(); }).then(
      value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); },
    );
  });
}
// Product-only helpers, shared with its own API and backup; no seven-table adapters or protocol changes.
export const productTransferChecks = Object.freeze({ object, count, uuid, hash, checkAbort, withSignal });

export function validateProductExportCatalog(value: unknown): ProductExportCatalog {
  const record = object(value, ['version', 'scope', 'site_id', 'tables', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'product-catalog' || record.full_site_complete !== false
    || !Array.isArray(record.tables) || record.tables.length !== 1) invalid();
  const table = object(record.tables[0], ['key', 'rows', 'bytes', 'sha256']);
  if (table.key !== 'product_types') invalid();
  return { version: 1, scope: 'product-catalog', site_id: uuid(record.site_id), tables: [{
    key: 'product_types', rows: count(table.rows, PRODUCT_MAX_ROWS), bytes: count(table.bytes, PRODUCT_MAX_BYTES),
    sha256: hash(table.sha256),
  }], full_site_complete: false };
}
export function validateProductVerification(value: unknown): void {
  const record = object(value, ['verified', 'scope', 'full_site_complete']);
  if (record.verified !== true || record.scope !== 'product-catalog' || record.full_site_complete !== false) invalid();
}
export function validateProductManifest(manifest: VolumeManifest, catalog: ProductExportCatalog): void {
  const expected = catalog.tables[0];
  const entry = manifest.entries[0];
  if (manifest.scope !== 'replacement-backup' || manifest.sourceSiteId !== catalog.site_id
    || manifest.volumeIndex !== 1 || manifest.volumeCount !== 1 || manifest.entries.length !== 1 || !entry
    || entry.path !== PRODUCT_ENTRY_PATH || entry.kind !== 'ndjson'
    || entry.bytes !== expected.bytes || entry.sha256 !== expected.sha256) invalid();
}
function unicode(text: string): void {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit === 0 || (unit >= 0x202a && unit <= 0x202e) || (unit >= 0x2066 && unit <= 0x2069)
      || unit === 0x061c || unit === 0x200e || unit === 0x200f || unit === 0xfeff) invalid();
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
}
function timestamp(value: unknown): void {
  if (value === null) return;
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!match) invalid();
  const [, y, m, d, h, minute, s, , zh, zm] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]
    || Number(h) > 23 || Number(minute) > 59 || Number(s) > 59
    || (zh !== undefined && (Number(zh) > 15 || Number(zm) > 59)) || !Number.isFinite(Date.parse(value))) invalid();
}
class ProductRows {
  private lastId: string | null = null;
  private readonly names = new Set<string>();
  get last(): string | null { return this.lastId; }
  read(line: string): void {
    unicode(line);
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { invalid(); }
    // JSON.parse discards duplicate keys. Decode every JSON string token to catch escaped key aliases.
    const keys = new Set<string>();
    const tokens = /"(?:[^"\\]|\\.)*"/g;
    for (const token of line.matchAll(tokens)) {
      const decoded: unknown = JSON.parse(token[0]);
      if (typeof decoded !== 'string') invalid();
      unicode(decoded);
      if (/^[\t\r ]*:/.test(line.slice(token.index! + token[0].length))) {
        if (keys.has(decoded)) invalid();
        keys.add(decoded);
      }
    }
    const row = object(parsed, ['id', 'name', 'is_active', 'sort_order', 'created_at', 'updated_at']);
    const id = uuid(row.id);
    if ((this.lastId !== null && id <= this.lastId) || typeof row.name !== 'string'
      || row.name.trim().length === 0 || this.names.has(row.name)
      || (row.is_active !== null && typeof row.is_active !== 'boolean')
      || typeof row.sort_order !== 'number' || !Number.isInteger(row.sort_order)
      || row.sort_order < -2147483648 || row.sort_order > 2147483647) invalid();
    timestamp(row.created_at); timestamp(row.updated_at);
    this.lastId = id;
    this.names.add(row.name);
  }
}
const encoder = new TextEncoder();
const decoder = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export async function exportProducts(
  source: ProductExportSource, sink: TemporaryTransferSink, options: ProductTransferOptions = {},
): Promise<ProductExportResult> {
  const { signal, onProgress } = options;
  try {
    const catalog = validateProductExportCatalog(await withSignal(() => source.catalog(signal), signal));
    const expected = catalog.tables[0];
    const rowsCheck = new ProductRows();
    const digest = new Sha256();
    let rows = 0, bytes = 0;
    let after: string | null = null;
    do {
      const page = object(await withSignal(() => source.page(after, signal), signal),
        ['table_key', 'count', 'ndjson', 'next_after', 'sha256']);
      if (page.table_key !== 'product_types' || typeof page.ndjson !== 'string'
        || page.ndjson.length > PRODUCT_MAX_PAGE_BYTES) invalid();
      const pageRows = count(page.count, PRODUCT_MAX_PAGE_ROWS);
      const nextAfter = page.next_after === null ? null : uuid(page.next_after);
      unicode(page.ndjson);
      const chunk = encoder.encode(page.ndjson);
      if (chunk.length > PRODUCT_MAX_PAGE_BYTES || (chunk.length && chunk[chunk.length - 1] !== 10)
        || new Sha256().update(chunk).digestHex() !== hash(page.sha256)) invalid();
      let start = 0, actualRows = 0;
      for (let end = 0; end < chunk.length; end++) {
        if (chunk[end] !== 10) continue;
        if (end - start > PRODUCT_MAX_LINE_BYTES) invalid();
        rowsCheck.read(decoder().decode(chunk.subarray(start, end)));
        actualRows++;
        start = end + 1;
      }
      if (actualRows !== pageRows || (nextAfter !== null && (pageRows === 0 || nextAfter !== rowsCheck.last))
        || rows + pageRows > expected.rows || bytes + chunk.length > expected.bytes) invalid();
      digest.update(chunk);
      await withSignal(() => sink.append(PRODUCT_ENTRY_PATH, chunk, signal), signal);
      checkAbort(signal);
      rows += pageRows; bytes += chunk.length;
      onProgress?.({ scope: 'product-catalog', phase: 'export', rows, bytes, fullSiteComplete: false });
      checkAbort(signal);
      after = nextAfter;
    } while (after !== null);
    const sha256 = digest.digestHex();
    if (rows !== expected.rows || bytes !== expected.bytes || sha256 !== expected.sha256) invalid();
    validateProductVerification(await withSignal(() => source.verify(signal), signal));
    checkAbort(signal);
    return { catalog, entries: [{ path: PRODUCT_ENTRY_PATH, kind: 'ndjson', bytes, sha256 }],
      rows, bytes, fullSiteComplete: false };
  } catch {
    try { await sink.abort(new Error('Product export discarded.')); } catch { throw new ProductTransferCleanupError(); }
    checkAbort(signal);
    throw new Error('Product export validation or temporary write failed.');
  }
}
async function scanProducts(
  files: ProductImportFiles, table: ProductTableCatalog, signal?: AbortSignal,
  onLine?: (text: string, raw: Uint8Array) => Promise<void>,
): Promise<void> {
  checkAbort(signal);
  const source = files.open(PRODUCT_ENTRY_PATH);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  if (source && 'getReader' in source && typeof source.getReader === 'function') reader = source.getReader();
  else if (source && Symbol.asyncIterator in source && typeof source[Symbol.asyncIterator] === 'function') {
    iterator = source[Symbol.asyncIterator]();
  } else invalid();
  const line = new Uint8Array(PRODUCT_MAX_LINE_BYTES + 1);
  const digest = new Sha256();
  const rowsCheck = new ProductRows();
  let used = 0, rows = 0, bytes = 0;
  let ended = false;
  try {
    while (true) {
      const next = reader ? await withSignal(() => reader!.read(), signal) : await withSignal(() => iterator!.next(), signal);
      checkAbort(signal);
      if (next.done) { ended = true; break; }
      if (!(next.value instanceof Uint8Array) || next.value.length > MAX_INPUT_BYTES) invalid();
      bytes += next.value.length;
      if (bytes > table.bytes) invalid();
      const chunk = new Uint8Array(next.value);
      digest.update(chunk);
      let start = 0;
      while (start < chunk.length) {
        const lf = chunk.indexOf(10, start);
        const end = lf === -1 ? chunk.length : lf + 1;
        if (used + end - start > line.length) invalid();
        line.set(chunk.subarray(start, end), used);
        used += end - start; start = end;
        if (lf !== -1) {
          if (++rows > table.rows) invalid();
          const raw = line.subarray(0, used);
          const text = decoder().decode(raw);
          rowsCheck.read(text);
          if (onLine) await onLine(text, raw);
          checkAbort(signal);
          used = 0;
        }
      }
    }
    if (used || rows !== table.rows || bytes !== table.bytes || digest.digestHex() !== table.sha256) invalid();
  } finally {
    if (reader) {
      if (!ended) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    } else if (!ended && iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* Read closure only. */ }
    }
  }
}
export async function stageProductsImport(
  input: unknown, files: ProductImportFiles, target: ProductImportTarget, options: ProductTransferOptions = {},
): Promise<ProductImportResult> {
  const { signal, onProgress } = options;
  let stagingMayExist = false;
  try {
    const catalog = validateProductExportCatalog(input);
    const table = catalog.tables[0];
    await scanProducts(files, table, signal);
    onProgress?.({ scope: 'product-catalog', phase: 'validate', rows: table.rows, bytes: table.bytes, fullSiteComplete: false });
    const begin = object(await withSignal(() => {
      stagingMayExist = true;
      return target.begin(validateProductExportCatalog(catalog), signal);
    }, signal), ['success', 'scope', 'full_site_complete']);
    if (begin.success !== true || begin.scope !== 'product-catalog' || begin.full_site_complete !== false) invalid();
    let rows = 0, bytes = 0, chunkNo = 0, pageRows = 0, pageBytes = 0;
    let page = '', pageHash = new Sha256();
    const flush = async () => {
      const sha256 = pageHash.digestHex();
      const ack = object(await withSignal(() => target.stage(chunkNo, page, signal), signal),
        ['success', 'rows', 'bytes', 'sha256', 'repeated']);
      if (ack.success !== true || typeof ack.repeated !== 'boolean' || ack.rows !== pageRows
        || ack.bytes !== pageBytes || ack.sha256 !== sha256) invalid();
      checkAbort(signal);
      rows += pageRows; bytes += pageBytes; chunkNo++;
      page = ''; pageRows = 0; pageBytes = 0; pageHash = new Sha256();
      onProgress?.({ scope: 'product-catalog', phase: 'stage', rows, bytes, fullSiteComplete: false });
      checkAbort(signal);
    };
    await scanProducts(files, table, signal, async (text, raw) => {
      if (pageBytes + raw.length > PRODUCT_MAX_PAGE_BYTES) await flush();
      page += text; pageRows++; pageBytes += raw.length; pageHash.update(raw);
      if (pageRows === PRODUCT_MAX_PAGE_ROWS || pageBytes === PRODUCT_MAX_PAGE_BYTES) await flush();
    });
    if (pageRows || chunkNo === 0) await flush();
    const record = object(await withSignal(() => target.dryRun(signal), signal),
      ['scope', 'full_site_complete', 'can_apply', 'conflicts', 'records', 'plan_hash']);
    if (record.scope !== 'product-catalog' || record.full_site_complete !== false || typeof record.can_apply !== 'boolean'
      || !Array.isArray(record.records) || !Array.isArray(record.conflicts)) invalid();
    const dryRun: ProductImportDryRun = { scope: 'product-catalog', full_site_complete: false,
      can_apply: record.can_apply, conflicts: structuredClone(record.conflicts), records: structuredClone(record.records),
      plan_hash: hash(record.plan_hash) };
    checkAbort(signal);
    onProgress?.({ scope: 'product-catalog', phase: 'dry-run', rows, bytes, fullSiteComplete: false });
    checkAbort(signal);
    return { dryRun, rows, bytes, fullSiteComplete: false };
  } catch {
    if (stagingMayExist) throw new ProductImportStagingMayExistError(signal?.aborted === true);
    checkAbort(signal);
    throw new Error('Product import stopped before server staging began.');
  }
}
