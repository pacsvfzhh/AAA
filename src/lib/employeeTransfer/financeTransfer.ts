import type { TemporaryTransferSink } from './container';
import type { TransferByteSource } from './crypto';
import type { VolumeManifest } from './manifest';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import { validateIdentityCatalog, type IdentityCatalog } from './identityTransfer';

export const FINANCE_PROTOCOL = 'employee-finance-v1';
export const FINANCE_TABLE_KEYS = Object.freeze([
  'wallets', 'wallet_balance_baselines', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit',
] as const);
export type FinanceTableKey = typeof FINANCE_TABLE_KEYS[number];
export const FINANCE_TRANSFER_LIMITS = Object.freeze({
  maxRows: 500000, maxTableBytes: 256 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024,
  maxLineBytes: 64 * 1024, maxPageRows: 200, maxPageBytes: 256 * 1024,
  maxChunks: 500001, maxInputBytes: 1024 * 1024,
});
const limits = FINANCE_TRANSFER_LIMITS;
const { object, count, uuid, hash, checkAbort, withSignal } = dispatchTransferChecks;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const FLAGS = ['maintenance', 'financial_data_pending', 'dependencies_pending', 'replacement_ready', 'full_site_complete'] as const;
export interface FinancePending {
  maintenance: true; financial_data_pending: true; dependencies_pending: true;
  replacement_ready: false; full_site_complete: false;
}
export interface FinanceTableCatalog {
  key: FinanceTableKey; rows: number; bytes: number; row_hashes_sha256: string;
}
export interface FinanceCatalog {
  version: 1; scope: 'employee-finance'; site_id: string; package_id: string;
  identity_catalog: IdentityCatalog; tables: FinanceTableCatalog[]; full_site_complete: false;
}
export type FinanceCounts = Record<FinanceTableKey, number>;
export const FINANCE_CONFLICT_REASONS = Object.freeze([
  'financial_target_not_empty', 'financial_uuid_collision', 'financial_unique_collision',
  'unmapped_administrator', 'inconsistent_source_finance', 'source_employee_missing',
] as const);
export interface FinancePlan extends FinancePending {
  scope: 'employee-finance'; can_restore: boolean; counts: FinanceCounts;
  employees: number; pending_withdrawals: { count: number; amount: string };
  conflicts: typeof FINANCE_CONFLICT_REASONS[number][]; plan_hash: string;
}
export interface FinanceVerifyReceipt extends FinancePending {
  success: true; scope: 'employee-finance'; counts: FinanceCounts;
  completed_employees: number; total_employees: number; verified: true; repeated: boolean;
}
export interface FinanceApplyReceipt extends FinanceVerifyReceipt { employee_id: string }
export type FinanceReceipt = FinanceApplyReceipt | FinanceVerifyReceipt;
export interface FinanceExportSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(key: FinanceTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface FinanceImportTarget {
  bind(catalog: FinanceCatalog, signal?: AbortSignal): Promise<unknown>;
  stage(key: FinanceTableKey, chunkNo: number, ndjson: string, signal?: AbortSignal): Promise<unknown>;
  plan(signal?: AbortSignal): Promise<unknown>;
}
export interface FinanceImportFiles {
  // Only reopen isolated immutable files after authenticating the entire volume through EOF.
  open(path: string): TransferByteSource | ReadableStream<Uint8Array>;
  // Invalidate pending reads/writes and discard all temporary plaintext, including on success.
  abort(reason: unknown): Promise<void>;
}
export interface FinanceProgress {
  scope: 'employee-finance'; phase: 'export' | 'validate' | 'stage' | 'plan';
  tableKey?: FinanceTableKey; rows: number; bytes: number; fullSiteComplete: false;
}
export interface FinanceTransferOptions {
  signal?: AbortSignal; onProgress?: (progress: FinanceProgress) => void;
}
export interface FinanceExportResult {
  catalog: FinanceCatalog; entries: { path: string; kind: 'ndjson'; bytes: number; sha256: string }[];
  rows: number; bytes: number; fullSiteComplete: false;
}
export interface FinanceImportResult {
  plan: FinancePlan; rows: number; bytes: number; fullSiteComplete: false;
}
export class FinanceTransferCleanupError extends Error {
  readonly cleanupRequired = true;
  constructor(readonly stagingMayExist = false) {
    super('Employee finance temporary plaintext cleanup was not confirmed. Do not reuse the workspace; reconcile any server staging.');
    this.name = 'FinanceTransferCleanupError';
  }
}
export class FinanceImportStagingMayExistError extends Error {
  readonly stagingMayExist = true;
  constructor(readonly cancelled: boolean) {
    super('Employee finance import stopped. Server staging may exist; reconcile before rerunning. No automatic retry, cancel, rollback, restore or close was performed.');
    this.name = 'FinanceImportStagingMayExistError';
  }
}
function invalid(): never { throw new Error('Invalid employee finance transfer.'); }

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
export function financeTableKey(value: unknown): FinanceTableKey {
  const key = FINANCE_TABLE_KEYS.find(key => value === key);
  if (!key) invalid();
  return key;
}
export function financeEntryPath(key: FinanceTableKey): string { return `data/finance-${financeTableKey(key)}.ndjson`; }
function pending(record: Record<string, unknown>): FinancePending {
  if (record.maintenance !== true || record.financial_data_pending !== true || record.dependencies_pending !== true
    || record.replacement_ready !== false || record.full_site_complete !== false) invalid();
  return { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
}
function counts(value: unknown, max: number = limits.maxRows): FinanceCounts {
  const record = object(value, FINANCE_TABLE_KEYS);
  return {
    wallets: count(record.wallets, max), wallet_balance_baselines: count(record.wallet_balance_baselines, max),
    wallet_ledger_entries: count(record.wallet_ledger_entries, max), wallet_transactions: count(record.wallet_transactions, max),
    withdrawals: count(record.withdrawals, max), wallet_reconciliation_audit: count(record.wallet_reconciliation_audit, max),
  };
}
export function validateFinanceCatalog(value: unknown): FinanceCatalog {
  const record = object(value, ['version', 'scope', 'site_id', 'package_id', 'identity_catalog', 'tables', 'full_site_complete']);
  if (record.version !== 1 || record.scope !== 'employee-finance' || record.full_site_complete !== false) invalid();
  const raw = array(record.tables, FINANCE_TABLE_KEYS.length);
  if (raw.length !== FINANCE_TABLE_KEYS.length) invalid();
  let total = 0;
  const tables = FINANCE_TABLE_KEYS.map((key, index) => {
    const table = object(raw[index], ['key', 'rows', 'bytes', 'row_hashes_sha256']);
    if (table.key !== key) invalid();
    const rows = count(table.rows, limits.maxRows), bytes = count(table.bytes, limits.maxTableBytes);
    if ((rows === 0) !== (bytes === 0)) invalid();
    total += bytes;
    return { key, rows, bytes, row_hashes_sha256: hash(table.row_hashes_sha256) };
  });
  if (total > limits.maxTotalBytes) invalid();
  const site = uuid(record.site_id), packageId = uuid(record.package_id);
  const identity = validateIdentityCatalog(record.identity_catalog);
  if (identity.site_id !== site || identity.package_id !== packageId) invalid();
  return { version: 1, scope: 'employee-finance', site_id: site, package_id: packageId, identity_catalog: identity,
    tables, full_site_complete: false };
}
export function validateFinancePlan(value: unknown): FinancePlan {
  const record = object(value, ['scope', 'can_restore', 'counts', 'employees', 'pending_withdrawals', 'conflicts', 'plan_hash', ...FLAGS]);
  if (record.scope !== 'employee-finance' || typeof record.can_restore !== 'boolean') invalid();
  const conflicts = array(record.conflicts, 200).map(value => {
    const reason = FINANCE_CONFLICT_REASONS.find(reason => reason === value);
    if (!reason) invalid();
    return reason;
  });
  const restored = counts(record.counts), employees = count(record.employees, limits.maxRows);
  const withdrawals = object(record.pending_withdrawals, ['count', 'amount']);
  if (record.can_restore !== (conflicts.length === 0)
    || (restored.wallets !== employees && !conflicts.includes('source_employee_missing'))
    || typeof withdrawals.amount !== 'string' || withdrawals.amount.length > limits.maxLineBytes
    || !/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(withdrawals.amount)) invalid();
  return { scope: 'employee-finance', can_restore: record.can_restore, counts: restored, employees,
    pending_withdrawals: { count: count(withdrawals.count, limits.maxRows), amount: withdrawals.amount }, conflicts,
    plan_hash: hash(record.plan_hash), ...pending(record) };
}
const RECEIPT_FIELDS = ['success', 'scope', 'counts', 'completed_employees', 'total_employees', 'verified', 'repeated', ...FLAGS];
function receipt(record: Record<string, unknown>): FinanceVerifyReceipt {
  if (record.success !== true || record.scope !== 'employee-finance' || record.verified !== true
    || typeof record.repeated !== 'boolean') invalid();
  const completed = count(record.completed_employees, limits.maxRows), total = count(record.total_employees, limits.maxRows);
  if (completed > total) invalid();
  return { success: true, scope: 'employee-finance', counts: counts(record.counts), completed_employees: completed,
    total_employees: total, verified: true, repeated: record.repeated, ...pending(record) };
}
export function validateFinanceApplyReceipt(value: unknown): FinanceApplyReceipt {
  const record = object(value, [...RECEIPT_FIELDS, 'employee_id']);
  const checked = receipt(record);
  if (checked.completed_employees === 0) invalid();
  return { ...checked, employee_id: uuid(record.employee_id) };
}
export function validateFinanceVerifyReceipt(value: unknown): FinanceVerifyReceipt {
  const checked = receipt(object(value, RECEIPT_FIELDS));
  if (checked.completed_employees !== checked.total_employees || checked.counts.wallets !== checked.total_employees) invalid();
  return checked;
}
export function validateFinanceVerification(value: unknown): { verified: true; scope: 'employee-finance'; full_site_complete: false } {
  const record = object(value, ['verified', 'scope', 'full_site_complete']);
  if (record.verified !== true || record.scope !== 'employee-finance' || record.full_site_complete !== false) invalid();
  return { verified: true, scope: 'employee-finance', full_site_complete: false };
}
export function validateFinanceBind(value: unknown): { success: true; scope: 'employee-finance'; full_site_complete: false; repeated: boolean } {
  const record = object(value, ['success', 'scope', 'full_site_complete', 'repeated']);
  if (record.success !== true || record.scope !== 'employee-finance' || record.full_site_complete !== false
    || typeof record.repeated !== 'boolean') invalid();
  return { success: true, scope: 'employee-finance', full_site_complete: false, repeated: record.repeated };
}
export function validateFinanceClose(value: unknown): { success: true; scope: 'employee-finance'; full_site_complete: false } {
  const record = object(value, ['success', 'scope', 'full_site_complete']);
  if (record.success !== true || record.scope !== 'employee-finance' || record.full_site_complete !== false) invalid();
  return { success: true, scope: 'employee-finance', full_site_complete: false };
}
export function validateFinanceManifest(manifest: VolumeManifest, input: FinanceCatalog): void {
  const catalog = validateFinanceCatalog(input);
  const record = object(manifest, ['version', 'scope', 'exportId', 'volumeId', 'sourceSiteId', 'createdAt', 'volumeIndex', 'volumeCount', 'entries']);
  if (record.version !== 1 || record.scope !== 'replacement-backup' || record.exportId !== catalog.package_id
    || record.sourceSiteId !== catalog.site_id || record.volumeIndex !== 1 || record.volumeCount !== 1) invalid();
  const entries = array(record.entries, FINANCE_TABLE_KEYS.length);
  if (entries.length !== FINANCE_TABLE_KEYS.length) invalid();
  for (let index = 0; index < FINANCE_TABLE_KEYS.length; index++) {
    const entry = object(entries[index], ['path', 'kind', 'bytes', 'sha256']);
    if (entry.path !== financeEntryPath(catalog.tables[index].key) || entry.kind !== 'ndjson'
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
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.[0-9]{1,6})?(Z|\+00:00)$/.exec(value);
  if (!match) invalid();
  const [, ys, ms, ds, hs, mins, ss] = match;
  const y = Number(ys), m = Number(ms), d = Number(ds);
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hs) > 23
    || Number(mins) > 59 || Number(ss) > 59) invalid();
}
const SPEC: Record<FinanceTableKey, Record<string, string>> = {
  wallets: { id: 'uuid!', user_id: 'uuid!', available_balance: 'numeric', frozen_balance: 'numeric', created_at: 'time', updated_at: 'time' },
  wallet_balance_baselines: { id: 'uuid!', user_id: 'uuid!', available_balance: 'numeric!', frozen_balance: 'numeric!',
    total_income: 'numeric!', last_ledger_id: 'bigint!', established_at: 'time!' },
  wallet_ledger_entries: { id: 'positiveBigint!', user_id: 'uuid!', operation_id: 'uuid!', source_type: 'text!', source_id: 'uuid!',
    event_type: 'text!', available_delta: 'numeric!', frozen_delta: 'numeric!', income_delta: 'numeric!', created_at: 'time!' },
  wallet_transactions: { id: 'uuid!', user_id: 'uuid!', type: 'text!', amount: 'numeric!', balance_before: 'numeric!',
    balance_after: 'numeric!', reference_id: 'uuid', remarks: 'text', created_by: 'uuid', created_at: 'time', operation_id: 'uuid' },
  withdrawals: { id: 'uuid!', user_id: 'uuid!', amount: 'numeric!', status: 'text!', audit_remark: 'text', audited_by: 'uuid',
    audited_at: 'time', created_at: 'time', last_operation_id: 'uuid' },
  wallet_reconciliation_audit: { id: 'positiveBigint!', user_id: 'uuid!', available_before: 'numeric!', available_after: 'numeric!',
    frozen_before: 'numeric!', frozen_after: 'numeric!', income_before: 'numeric!', income_after: 'numeric!',
    pending_amount: 'numeric!', ledger_total: 'numeric!', reason: 'text!', repaired_at: 'time!' },
};
// Canonical decimal strings preserve bigint IDs above 2^53 and avoid lexicographic pagination.
export function financeBigint(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value)
    || (value.length === 19 && value > '9223372036854775807') || (positive && value === '0')) invalid();
  return value;
}
export function financeCursor(key: FinanceTableKey, value: unknown): string {
  financeTableKey(key);
  return key === 'wallet_ledger_entries' || key === 'wallet_reconciliation_audit' ? financeBigint(value, true) : uuid(value);
}
function increasing(key: FinanceTableKey, previous: string, next: string): boolean {
  return key === 'wallet_ledger_entries' || key === 'wallet_reconciliation_audit'
    ? next.length > previous.length || (next.length === previous.length && next > previous) : next > previous;
}
export function validateFinanceRow(line: string, key: FinanceTableKey): string {
  if (typeof line !== 'string' || line.length > limits.maxLineBytes) invalid();
  unicode(line);
  const bytes = encoder.encode(line);
  if (bytes.length + (line.endsWith('\n') ? 0 : 1) > limits.maxLineBytes) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { invalid(); }
  const spec = SPEC[financeTableKey(key)], row = object(parsed, Object.keys(spec));
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
      case 'bigint': financeBigint(value); break;
      case 'positiveBigint': financeBigint(value, true); break;
      // Shape/finite check only. Never reserialize amounts; SQL owns final numeric precision and constraints.
      case 'numeric': if (typeof value !== 'number' || !Number.isFinite(value)) invalid(); break;
      case 'time': timestamp(value); break;
      default: invalid();
    }
  }
  if ((key === 'wallets' || key === 'wallet_balance_baselines') && row.id !== row.user_id) invalid();
  if (key === 'wallet_ledger_entries' && row.source_type !== 'wallet_transaction' && row.source_type !== 'withdrawal') invalid();
  if (key === 'withdrawals' && !['pending', 'approved', 'rejected', 'cancelled'].includes(row.status as string)) invalid();
  return financeCursor(key, row.id);
}
export interface FinancePage {
  table_key: FinanceTableKey; count: number; ndjson: string; next_after: string | null; sha256: string;
}
export function validateFinancePage(value: unknown, key: FinanceTableKey, after: string | null): FinancePage {
  const record = object(value, ['table_key', 'count', 'ndjson', 'next_after', 'sha256']);
  if (record.table_key !== financeTableKey(key) || typeof record.ndjson !== 'string' || record.ndjson.length > limits.maxPageBytes) invalid();
  unicode(record.ndjson);
  const bytes = encoder.encode(record.ndjson), size = count(record.count, limits.maxPageRows);
  if (bytes.length > limits.maxPageBytes || (bytes.length > 0 && bytes[bytes.length - 1] !== 10)
    || new Sha256().update(bytes).digestHex() !== hash(record.sha256)) invalid();
  let last = after === null ? null : financeCursor(key, after), rows = 0, start = 0;
  for (let end = 0; end < bytes.length; end++) {
    if (bytes[end] !== 10) continue;
    if (end - start + 1 > limits.maxLineBytes) invalid();
    const id = validateFinanceRow(decoder.decode(bytes.subarray(start, end)), key);
    if (last !== null && !increasing(key, last, id)) invalid();
    last = id; rows++; start = end + 1;
  }
  const next = record.next_after === null ? null : financeCursor(key, record.next_after);
  if (rows !== size || (next !== null && (size === 0 || next !== last))) invalid();
  return { table_key: key, count: size, ndjson: record.ndjson, next_after: next, sha256: hash(record.sha256) };
}
export function validateFinanceStage(value: unknown, rows: number, bytes: number, digest: string): {
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
  constructor(private readonly expected: FinanceTableCatalog) {}
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
        const id = validateFinanceRow(text, this.expected.key);
        if (this.last !== null && !increasing(this.expected.key, this.last, id)) invalid();
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
export async function exportFinanceData(
  source: FinanceExportSource, sink: TemporaryTransferSink, options: FinanceTransferOptions = {},
): Promise<FinanceExportResult> {
  const { signal, onProgress } = options;
  try {
    const catalog = validateFinanceCatalog(await withSignal(() => source.catalog(signal), signal));
    const entries: FinanceExportResult['entries'] = [];
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      const verifier = new TableVerifier(table), path = financeEntryPath(table.key);
      let after: string | null = null;
      do {
        const page = validateFinancePage(await withSignal(() => source.page(table.key, after, signal), signal), table.key, after);
        const raw = encoder.encode(page.ndjson), pageBytes = raw.length;
        await verifier.push(raw, signal);
        await withSignal(() => sink.append(path, raw, signal), signal);
        checkAbort(signal);
        rows += page.count; bytes += pageBytes;
        onProgress?.({ scope: 'employee-finance', phase: 'export', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal); after = page.next_after;
      } while (after !== null);
      entries.push({ path, kind: 'ndjson', bytes: table.bytes, sha256: verifier.finish() });
    }
    validateFinanceVerification(await withSignal(() => source.verify(signal), signal));
    checkAbort(signal);
    return { catalog, entries, rows, bytes, fullSiteComplete: false };
  } catch {
    try { await sink.abort(new Error('Employee finance export discarded.')); } catch { throw new FinanceTransferCleanupError(); }
    checkAbort(signal);
    throw new Error('Employee finance export validation, source verification or temporary write failed.');
  }
}
async function scanTable(
  files: FinanceImportFiles, table: FinanceTableCatalog, signal?: AbortSignal,
  onLine?: (text: string, raw: Uint8Array) => Promise<void>,
): Promise<void> {
  checkAbort(signal);
  const source = files.open(financeEntryPath(table.key));
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
export async function stageFinanceImport(
  input: unknown, files: FinanceImportFiles, target: FinanceImportTarget, options: FinanceTransferOptions = {},
): Promise<FinanceImportResult> {
  const { signal, onProgress } = options;
  let stagingMayExist = false;
  let outcome: { result: FinanceImportResult } | { error: unknown };
  try {
    checkAbort(signal);
    const catalog = validateFinanceCatalog(input);
    let checkedRows = 0, checkedBytes = 0;
    for (const table of catalog.tables) {
      await scanTable(files, table, signal);
      checkedRows += table.rows; checkedBytes += table.bytes;
      onProgress?.({ scope: 'employee-finance', phase: 'validate', tableKey: table.key, rows: checkedRows, bytes: checkedBytes, fullSiteComplete: false });
      checkAbort(signal);
    }
    validateFinanceBind(await withSignal(() => {
      stagingMayExist = true;
      return target.bind(validateFinanceCatalog(catalog), signal);
    }, signal));
    checkAbort(signal);
    let rows = 0, bytes = 0;
    for (const table of catalog.tables) {
      let chunkNo = 0, pageRows = 0, pageBytes = 0, page = '', digest = new Sha256();
      const flush = async () => {
        count(chunkNo, limits.maxChunks - 1);
        validateFinanceStage(await withSignal(() => target.stage(table.key, chunkNo, page, signal), signal), pageRows, pageBytes, digest.digestHex());
        checkAbort(signal);
        rows += pageRows; bytes += pageBytes; chunkNo++;
        pageRows = 0; pageBytes = 0; page = ''; digest = new Sha256();
        onProgress?.({ scope: 'employee-finance', phase: 'stage', tableKey: table.key, rows, bytes, fullSiteComplete: false });
        checkAbort(signal);
      };
      await scanTable(files, table, signal, async (text, raw) => {
        if (pageBytes + raw.length > limits.maxPageBytes) await flush();
        page += text; pageRows++; pageBytes += raw.length; digest.update(raw);
        if (pageRows === limits.maxPageRows || pageBytes === limits.maxPageBytes) await flush();
      });
      if (pageRows || chunkNo === 0) await flush();
    }
    const plan = validateFinancePlan(await withSignal(() => target.plan(signal), signal));
    if (catalog.tables.some(table => plan.counts[table.key] !== table.rows)) invalid();
    checkAbort(signal);
    onProgress?.({ scope: 'employee-finance', phase: 'plan', rows, bytes, fullSiteComplete: false });
    checkAbort(signal);
    outcome = { result: { plan, rows, bytes, fullSiteComplete: false } };
  } catch { outcome = { error: true }; }
  try { await files.abort(new Error('Employee finance import plaintext discarded.')); }
  catch { throw new FinanceTransferCleanupError(stagingMayExist); }
  if ('error' in outcome) {
    if (stagingMayExist) throw new FinanceImportStagingMayExistError(signal?.aborted === true);
    checkAbort(signal);
    throw new Error('Employee finance import stopped before server staging began.');
  }
  checkAbort(signal);
  return outcome.result;
}
