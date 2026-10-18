import type { TemporaryTransferSink } from './container';
import type { TransferByteSource } from './crypto';
import type { VolumeManifest } from './manifest';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';

export const IDENTITY_PROTOCOL = 'employee-identity-v1';
export const IDENTITY_TABLE_KEYS = Object.freeze(['accounts', 'credentials', 'orders'] as const);
export type IdentityTableKey = typeof IDENTITY_TABLE_KEYS[number];
export const IDENTITY_TRANSFER_LIMITS = Object.freeze({
  maxRows: 500000, maxTableBytes: 256 * 1024 * 1024, maxTotalBytes: 768 * 1024 * 1024,
  maxLineBytes: 64 * 1024, maxPageRows: 200, maxPageBytes: 256 * 1024,
  maxChunks: 500001, maxInputBytes: 1024 * 1024,
});
const limits = IDENTITY_TRANSFER_LIMITS;
const { object, count, uuid, hash, checkAbort, withSignal } = dispatchTransferChecks;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const FLAGS = ['maintenance', 'financial_data_pending', 'dependencies_pending', 'replacement_ready', 'full_site_complete'] as const;
export interface IdentityPending {
  maintenance: true; financial_data_pending: true; dependencies_pending: true;
  replacement_ready: false; full_site_complete: false;
}
export interface IdentityTableCatalog {
  key: IdentityTableKey; rows: number; bytes: number; row_hashes_sha256: string;
}
export interface IdentityCatalog {
  version: 1; scope: 'employee-identity'; site_id: string; package_id: string;
  tables: IdentityTableCatalog[]; processing_orders: number; full_site_complete: false;
}
export type IdentityCounts = Record<IdentityTableKey, number>;
export const IDENTITY_CONFLICT_REASONS = Object.freeze([
  'employee_id_conflict', 'username_requires_archive', 'employee_number_conflict', 'administrator_username_conflict',
  'unmapped_administrator', 'order_id_conflict', 'placeholder_product_active', 'dispatch_employee_missing',
  'used_order_missing_or_mismatched',
] as const);
export interface IdentityPlan extends IdentityPending {
  scope: 'employee-identity'; can_restore: boolean; counts: IdentityCounts;
  conflicts: { source_id: string; reason: typeof IDENTITY_CONFLICT_REASONS[number] }[]; plan_hash: string;
}
export interface IdentityReceipt extends IdentityPending {
  success: true; scope: 'employee-identity'; counts: IdentityCounts; next_chunks: IdentityCounts;
  chunks: IdentityCounts; totals: IdentityCounts; verified: boolean; repeated: boolean;
}
export interface IdentityExportSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(key: IdentityTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface IdentityImportTarget {
  bind(catalog: IdentityCatalog, signal?: AbortSignal): Promise<unknown>;
  stage(key: IdentityTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<unknown>;
  plan(signal?: AbortSignal): Promise<unknown>;
}
export interface IdentityImportFiles {
  // Caller must authenticate the ENTIRE volume including EOF first. Reopen only isolated immutable files.
  // This module deliberately cannot decrypt, unzip, authenticate or accept a raw encrypted stream.
  open(path: string): TransferByteSource | ReadableStream<Uint8Array>;
  // Invalidate pending reads/writes and discard all temporary plaintext, including on success.
  abort(reason: unknown): Promise<void>;
}
export interface IdentityProgress {
  scope: 'employee-identity'; phase: 'export' | 'validate' | 'stage' | 'plan';
  tableKey?: IdentityTableKey; rows: number; bytes: number; fullSiteComplete: false;
}
export interface IdentityTransferOptions {
  signal?: AbortSignal; onProgress?: (progress: IdentityProgress) => void;
}
export interface IdentityExportResult {
  catalog: IdentityCatalog; entries: { path: string; kind: 'ndjson'; bytes: number; sha256: string }[];
  rows: number; bytes: number; fullSiteComplete: false;
}
export interface IdentityImportResult {
  plan: IdentityPlan; rows: number; bytes: number; fullSiteComplete: false;
}
export class IdentityTransferCleanupError extends Error {
  readonly cleanupRequired = true;
  constructor(readonly stagingMayExist = false) {
    super('Employee identity temporary plaintext cleanup was not confirmed. Do not reuse the workspace; reconcile any server staging.');
    this.name = 'IdentityTransferCleanupError';
  }
}
export class IdentityImportStagingMayExistError extends Error {
  readonly stagingMayExist = true;
  constructor(readonly cancelled: boolean) {
    super('Employee identity import stopped. Server staging may exist; reconcile before rerunning. No automatic retry, cancel, rollback, restore or close was performed.');
    this.name = 'IdentityImportStagingMayExistError';
  }
}
function invalid(): never { throw new Error('Invalid employee identity transfer.'); }

// Snapshot arrays as well as objects; never invoke an accessor, iterator or a second proxy get.
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !('value' in length)) invalid();
  const size = count(length.value, max);
  const own = Reflect.ownKeys(value);
  if (own.length !== size + 1 || own.some(key => typeof key !== 'string'
    || (key !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= size)))) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < size; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !('value' in field)) invalid();
    result.push(field.value);
  }
  return result;
}
export function identityTableKey(value: unknown): IdentityTableKey {
  const key = IDENTITY_TABLE_KEYS.find(key => value === key);
  if (!key) invalid();
  return key;
}
export function identityEntryPath(key: IdentityTableKey): string { return `data/identity-${identityTableKey(key)}.ndjson`; }
function pending(record: Record<string, unknown>): IdentityPending {
  if (record.maintenance !== true || record.financial_data_pending !== true || record.dependencies_pending !== true
    || record.replacement_ready !== false || record.full_site_complete !== false) invalid();
  return { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
}
function counts(value: unknown, max: number = limits.maxRows): IdentityCounts {
  const record = object(value, IDENTITY_TABLE_KEYS);
  return { accounts: count(record.accounts, max), credentials: count(record.credentials, max), orders: count(record.orders, max) };
}
export function validateIdentityCatalog(value: unknown): IdentityCatalog {
  const record = object(value, ['version', 'scope', 'site_id', 'package_id', 'tables', 'processing_orders', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'employee-identity' || record.full_site_complete !== false) invalid();
  const raw = array(record.tables, 3);
  if (raw.length !== 3) invalid();
  let total = 0;
  const tables = IDENTITY_TABLE_KEYS.map((key, index) => {
    const table = object(raw[index], ['key', 'rows', 'bytes', 'row_hashes_sha256']);
    if (table.key !== key) invalid();
    const rows = count(table.rows, limits.maxRows), bytes = count(table.bytes, limits.maxTableBytes);
    if ((rows === 0) !== (bytes === 0)) invalid();
    total += bytes;
    return { key, rows, bytes, row_hashes_sha256: hash(table.row_hashes_sha256) };
  });
  if (total > limits.maxTotalBytes) invalid();
  return { version: 1, scope: 'employee-identity', site_id: uuid(record.site_id), package_id: uuid(record.package_id), tables,
    processing_orders: count(record.processing_orders, 999999999999999), full_site_complete: false };
}
export function validateIdentityPlan(value: unknown): IdentityPlan {
  const record = object(value, ['scope', 'can_restore', 'counts', 'conflicts', 'plan_hash', ...FLAGS]);
  if (record.scope !== 'employee-identity' || typeof record.can_restore !== 'boolean') invalid();
  const conflicts = array(record.conflicts, limits.maxRows * 9).map(value => {
    const conflict = object(value, ['source_id', 'reason']);
    const reason = IDENTITY_CONFLICT_REASONS.find(reason => reason === conflict.reason);
    if (!reason) invalid();
    return { source_id: uuid(conflict.source_id), reason };
  });
  if (record.can_restore !== (conflicts.length === 0)) invalid();
  return { scope: 'employee-identity', can_restore: record.can_restore, counts: counts(record.counts), conflicts,
    plan_hash: hash(record.plan_hash), ...pending(record) };
}
export function validateIdentityReceipt(value: unknown): IdentityReceipt {
  const record = object(value, ['success', 'scope', 'counts', 'next_chunks', 'chunks', 'totals', 'verified', 'repeated', ...FLAGS]);
  if (record.success !== true || record.scope !== 'employee-identity'
    || typeof record.verified !== 'boolean' || typeof record.repeated !== 'boolean') invalid();
  const restored = counts(record.counts), totals = counts(record.totals);
  const next = counts(record.next_chunks, limits.maxChunks), chunks = counts(record.chunks, limits.maxChunks);
  for (const key of IDENTITY_TABLE_KEYS) {
    if (chunks[key] < 1 || restored[key] > totals[key] || next[key] > chunks[key]
      || (next[key] === 0 && restored[key] !== 0)
      || (record.verified && (restored[key] !== totals[key] || next[key] !== chunks[key]))) invalid();
  }
  return { success: true, scope: 'employee-identity', counts: restored, totals, next_chunks: next, chunks,
    verified: record.verified, repeated: record.repeated, ...pending(record) };
}
export function validateIdentityVerification(value: unknown): { verified: true; scope: 'employee-identity'; full_site_complete: false } {
  const record = object(value, ['verified', 'scope', 'full_site_complete']);
  if (record.verified !== true || record.scope !== 'employee-identity' || record.full_site_complete !== false) invalid();
  return { verified: true, scope: 'employee-identity', full_site_complete: false };
}
export function validateIdentityBind(value: unknown): { success: true; scope: 'employee-identity'; full_site_complete: false; repeated: boolean } {
  const record = object(value, ['success', 'scope', 'full_site_complete', 'repeated']);
  if (record.success !== true || record.scope !== 'employee-identity' || record.full_site_complete !== false
    || typeof record.repeated !== 'boolean') invalid();
  return { success: true, scope: 'employee-identity', full_site_complete: false, repeated: record.repeated };
}
export function validateIdentityClose(value: unknown): { success: true; scope: 'employee-identity'; full_site_complete: false } {
  const record = object(value, ['success', 'scope', 'full_site_complete']);
  if (record.success !== true || record.scope !== 'employee-identity' || record.full_site_complete !== false) invalid();
  return { success: true, scope: 'employee-identity', full_site_complete: false };
}
export function validateIdentityManifest(manifest: VolumeManifest, input: IdentityCatalog): void {
  const catalog = validateIdentityCatalog(input);
  const record = object(manifest, ['version', 'scope', 'exportId', 'volumeId', 'sourceSiteId', 'createdAt', 'volumeIndex', 'volumeCount', 'entries']);
  if (record.version !== 1 || record.scope !== 'replacement-backup' || record.exportId !== catalog.package_id
    || record.sourceSiteId !== catalog.site_id || record.volumeIndex !== 1 || record.volumeCount !== 1) invalid();
  const entries = array(record.entries, 3);
  if (entries.length !== 3) invalid();
  for (let index = 0; index < 3; index++) {
    const entry = object(entries[index], ['path', 'kind', 'bytes', 'sha256']);
    if (entry.path !== identityEntryPath(catalog.tables[index].key) || entry.kind !== 'ndjson'
      || entry.bytes !== catalog.tables[index].bytes) invalid();
    hash(entry.sha256); // Container authentication must already have verified the actual entry digest.
  }
}
function unicode(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit === 0) invalid();
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) invalid();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
  }
}
function timestamp(value: unknown): void {
  if (typeof value !== 'string') invalid();
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.[0-9]{1,6})?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match) invalid();
  const [, ys, ms, ds, hs, mins, ss, zone] = match;
  const y = Number(ys), m = Number(ms), d = Number(ds);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hs) > 23
    || Number(mins) > 59 || Number(ss) > 59 || (zone !== 'Z' && (Number(zone.slice(1, 3)) > 15 || Number(zone.slice(4)) > 59))) invalid();
}
const SPEC: Record<IdentityTableKey, Record<string, string>> = {
  accounts: { id: 'uuid!', username: 'text!', password_hash: 'password!', employee_id: 'text!', is_verified: 'boolean',
    is_active: 'boolean', total_income: 'numeric', first_success_order_date: 'time', created_by: 'uuid', remarks: 'text',
    created_at: 'time', updated_at: 'time', tags: 'tags', is_pinned: 'boolean' },
  credentials: { id: 'uuid!', password_hash: 'password!', created_at: 'time!', updated_at: 'time!' },
  orders: { id: 'uuid!', user_id: 'uuid!', status: 'text!', commission_amount: 'numeric', commission_rate: 'numeric', created_at: 'time', processed_at: 'time' },
};
export function validateIdentityRow(line: string, key: IdentityTableKey): string {
  if (typeof line !== 'string' || line.length > limits.maxLineBytes) invalid();
  unicode(line);
  const bytes = encoder.encode(line);
  if (bytes.length + (line.endsWith('\n') ? 0 : 1) > limits.maxLineBytes) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { invalid(); }
  const spec = SPEC[identityTableKey(key)], row = object(parsed, Object.keys(spec));
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
  for (const [field, type] of Object.entries(spec)) {
    const value = row[field];
    if (value === null) { if (type.endsWith('!')) invalid(); continue; }
    switch (type.replace('!', '')) {
      case 'uuid': uuid(value); break;
      case 'text': if (typeof value !== 'string') invalid(); break;
      case 'password':
        if (typeof value !== 'string' || !/^\$2[aby]\$(0[4-9]|[12][0-9]|3[01])\$[./A-Za-z0-9]{53}$/.test(value)) invalid();
        break;
      case 'boolean': if (typeof value !== 'boolean') invalid(); break;
      // JSON.parse is ONLY a shape check. Even numeric values outside JS precision/range stay in the raw text.
      case 'numeric': if (typeof value !== 'number') invalid(); break;
      case 'time': timestamp(value); break;
      case 'tags': if (!array(value, limits.maxLineBytes).every(tag => tag === null || typeof tag === 'string')) invalid(); break;
      default: invalid();
    }
  }
  if (key === 'orders' && row.status !== 'success' && row.status !== 'failure') invalid();
  return uuid(row.id);
}
export interface IdentityPage {
  table_key: IdentityTableKey; count: number; ndjson: string; next_after: string | null; sha256: string;
}
export function validateIdentityPage(value: unknown, key: IdentityTableKey, after: string | null): IdentityPage {
  const record = object(value, ['table_key', 'count', 'ndjson', 'next_after', 'sha256']);
  if (record.table_key !== identityTableKey(key) || typeof record.ndjson !== 'string' || record.ndjson.length > limits.maxPageBytes) invalid();
  unicode(record.ndjson);
  const bytes = encoder.encode(record.ndjson), size = count(record.count, limits.maxPageRows);
  if (bytes.length > limits.maxPageBytes || (bytes.length > 0 && bytes[bytes.length - 1] !== 10)
    || new Sha256().update(bytes).digestHex() !== hash(record.sha256)) invalid();
  let last = after === null ? null : uuid(after), rows = 0, start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    if (end - start + 1 > limits.maxLineBytes) invalid();
    const id = validateIdentityRow(decoder.decode(bytes.subarray(start, end)), key);
    if (last !== null && id <= last) invalid();
    last = id; rows++; start = end + 1;
  }
  const next = record.next_after === null ? null : uuid(record.next_after);
  if (rows !== size || (next !== null && (size === 0 || next !== last))) invalid();
  return { table_key: key, count: size, ndjson: record.ndjson, next_after: next, sha256: hash(record.sha256) };
}
export function validateIdentityStage(value: unknown, rows: number, bytes: number, digest: string): {
  success: true; rows: number; bytes: number; sha256: string; repeated: boolean;
} {
  const record = object(value, ['success', 'rows', 'bytes', 'sha256', 'repeated']);
  if (record.success !== true || typeof record.repeated !== 'boolean' || record.rows !== rows
    || record.bytes !== bytes || hash(record.sha256) !== digest) invalid();
  return { success: true, rows, bytes, sha256: digest, repeated: record.repeated };
}

// Bounded state only: one input fragment, one line, and two incremental digests per table.
class TableVerifier {
  private readonly line = new Uint8Array(limits.maxLineBytes);
  private readonly digest = new Sha256();
  private readonly rowHashes = new Sha256();
  private last: string | null = null;
  private used = 0;
  private rows = 0;
  private bytes = 0;
  constructor(private readonly expected: IdentityTableCatalog) {}
  async push(input: Uint8Array, signal?: AbortSignal, onLine?: (text: string, raw: Uint8Array) => Promise<void>): Promise<void> {
    checkAbort(signal);
    if (!(input instanceof Uint8Array) || input.length > limits.maxInputBytes) invalid();
    this.bytes += input.length;
    if (this.bytes > this.expected.bytes) invalid();
    const chunk = new Uint8Array(input); // Producer may reuse its buffer across awaits.
    this.digest.update(chunk);
    let start = 0;
    while (start < chunk.length) {
      checkAbort(signal);
      const lf = chunk.indexOf(10, start), end = lf === -1 ? chunk.length : lf + 1;
      if (this.used + end - start > this.line.length) invalid();
      this.line.set(chunk.subarray(start, end), this.used); this.used += end - start; start = end;
      if (lf !== -1) {
        if (++this.rows > this.expected.rows) invalid();
        const raw = this.line.subarray(0, this.used), text = decoder.decode(raw);
        const id = validateIdentityRow(text, this.expected.key);
        if (this.last !== null && id <= this.last) invalid();
        this.last = id;
        this.rowHashes.update(encoder.encode(new Sha256().update(raw).digestHex()));
        if (onLine) await onLine(text, raw);
        checkAbort(signal); this.used = 0;
      }
    }
  }
  finish(): string {
    if (this.used || this.rows !== this.expected.rows || this.bytes !== this.expected.bytes
      || this.rowHashes.digestHex() !== this.expected.row_hashes_sha256) invalid();
    return this.digest.digestHex();
  }
}
export async function exportIdentityData(
  source: IdentityExportSource, sink: TemporaryTransferSink, options: IdentityTransferOptions = {},
): Promise<IdentityExportResult> {
  const { signal, onProgress } = options;
  try {
    const catalog = validateIdentityCatalog(await withSignal(() => source.catalog(signal), signal));
    const entries: IdentityExportResult['entries'] = [];
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      const verifier = new TableVerifier(table), path = identityEntryPath(table.key);
      let after: string | null = null;
      do {
        const page = validateIdentityPage(await withSignal(() => source.page(table.key, after, signal), signal), table.key, after);
        const raw = encoder.encode(page.ndjson), pageBytes = raw.length;
        await verifier.push(raw, signal);
        await withSignal(() => sink.append(path, raw, signal), signal);
        checkAbort(signal);
        rows += page.count; bytes += pageBytes;
        onProgress?.({ scope: 'employee-identity', phase: 'export', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal); after = page.next_after;
      } while (after !== null);
      entries.push({ path, kind: 'ndjson', bytes: table.bytes, sha256: verifier.finish() });
    }
    validateIdentityVerification(await withSignal(() => source.verify(signal), signal));
    checkAbort(signal);
    return { catalog, entries, rows, bytes, fullSiteComplete: false };
  } catch {
    try { await sink.abort(new Error('Employee identity export discarded.')); } catch { throw new IdentityTransferCleanupError(); }
    checkAbort(signal);
    throw new Error('Employee identity export validation, source verification or temporary write failed.');
  }
}
async function scanTable(
  files: IdentityImportFiles, table: IdentityTableCatalog, signal?: AbortSignal,
  onLine?: (text: string, raw: Uint8Array) => Promise<void>,
): Promise<void> {
  checkAbort(signal);
  const source = files.open(identityEntryPath(table.key));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  if (source && 'getReader' in source && typeof source.getReader === 'function') reader = source.getReader();
  else if (source && Symbol.asyncIterator in source && typeof source[Symbol.asyncIterator] === 'function') iterator = source[Symbol.asyncIterator]();
  else invalid();
  const verifier = new TableVerifier(table);
  let ended = false;
  try {
    while (true) {
      const next = reader ? await withSignal(() => reader!.read(), signal) : await withSignal(() => iterator!.next(), signal);
      checkAbort(signal);
      if (next.done) { ended = true; break; }
      await verifier.push(next.value, signal, onLine);
    }
    verifier.finish();
  } finally {
    if (reader) {
      try { if (!ended) void reader.cancel().catch(() => undefined); } finally { reader.releaseLock(); }
    } else if (!ended && iterator?.return) {
      try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* Do not await a blocked producer. */ }
    }
  }
}
export async function stageIdentityImport(
  input: unknown, files: IdentityImportFiles, target: IdentityImportTarget, options: IdentityTransferOptions = {},
): Promise<IdentityImportResult> {
  const { signal, onProgress } = options;
  let stagingMayExist = false;
  let outcome: { result: IdentityImportResult } | { error: unknown };
  try {
    checkAbort(signal);
    const catalog = validateIdentityCatalog(input);
    let checkedRows = 0, checkedBytes = 0;
    for (const table of catalog.tables) {
      await scanTable(files, table, signal);
      checkedRows += table.rows; checkedBytes += table.bytes;
      onProgress?.({ scope: 'employee-identity', phase: 'validate', tableKey: table.key, rows: checkedRows, bytes: checkedBytes, fullSiteComplete: false });
      checkAbort(signal);
    }
    validateIdentityBind(await withSignal(() => {
      stagingMayExist = true;
      return target.bind(validateIdentityCatalog(catalog), signal);
    }, signal));
    checkAbort(signal);
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      let chunkNo = 0, pageRows = 0, pageBytes = 0, page = '', digest = new Sha256();
      const flush = async () => {
        count(chunkNo, limits.maxChunks - 1);
        validateIdentityStage(await withSignal(() => target.stage(table.key, chunkNo, page, signal), signal), pageRows, pageBytes, digest.digestHex());
        checkAbort(signal);
        rows += pageRows; bytes += pageBytes; chunkNo++;
        pageRows = 0; pageBytes = 0; page = ''; digest = new Sha256();
        onProgress?.({ scope: 'employee-identity', phase: 'stage', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
      };
      await scanTable(files, table, signal, async (text, raw) => {
        if (pageBytes + raw.length > limits.maxPageBytes) await flush();
        page += text; pageRows++; pageBytes += raw.length; digest.update(raw);
        if (pageRows === limits.maxPageRows || pageBytes === limits.maxPageBytes) await flush();
      });
      if (pageRows || chunkNo === 0) await flush();
    }
    const plan = validateIdentityPlan(await withSignal(() => target.plan(signal), signal));
    if (catalog.tables.some(table => plan.counts[table.key] !== table.rows)) invalid();
    checkAbort(signal);
    onProgress?.({ scope: 'employee-identity', phase: 'plan', rows, bytes, fullSiteComplete: false });
    checkAbort(signal);
    outcome = { result: { plan, rows, bytes, fullSiteComplete: false } };
  } catch { outcome = { error: true }; }
  try { await files.abort(new Error('Employee identity import plaintext discarded.')); }
  catch { throw new IdentityTransferCleanupError(stagingMayExist); }
  if ('error' in outcome) {
    if (stagingMayExist) throw new IdentityImportStagingMayExistError(signal?.aborted === true);
    checkAbort(signal);
    throw new Error('Employee identity import stopped before server staging began.');
  }
  checkAbort(signal);
  return outcome.result;
}
