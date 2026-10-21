import {
  withAuthenticatedEmployeeSafetyBackup, employeeSafetyBackupEntryPath, validateEmployeeSafetyBackupRow,
  EMPLOYEE_SAFETY_BACKUP_TABLE_KEYS, EMPLOYEE_SAFETY_BACKUP_LIMITS,
  type EmployeeSafetyBackupCatalog, type EmployeeSafetyBackupTableKey,
} from './employeeSafetyBackup';
import { withAuthenticatedEmployeeSafetyMediaBackup, EMPLOYEE_SAFETY_MEDIA_TIMEOUT_MS } from './employeeSafetyMedia';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';
import type { TransferByteSource } from './crypto';
import type { ArchiveBundleWorkspace, ArchiveBundleWorkspaceFactory } from './archiveBundle';
import type { ReplacementBackupFile } from './replacementBackup';

const FIELDS: Record<EmployeeSafetyBackupTableKey, readonly string[]> = {
  accounts: ['id'], credentials: ['id'], orders: ['user_id'], wallets: ['id', 'user_id'],
  wallet_balance_baselines: ['id', 'user_id'], wallet_ledger_entries: ['user_id'], wallet_transactions: ['user_id'],
  withdrawals: ['user_id'], wallet_reconciliation_audit: ['user_id'], employee_login_history: ['user_id'],
  work_sessions: ['user_id'], work_stop_markers: ['id', 'user_id'], verification_requests: ['user_id'],
  dispatch_group_members: ['user_id'], employee_submit_time_settings: ['user_id'],
  simulated_customers: ['target_employee_id', 'target_employee_ids'], cs_message_templates: [], customer_auto_messages: [], rich_card_contents: [],
  customer_employee_conversations: ['employee_id'], customer_service_sessions: ['employee_id'],
  ccc_conversation_annotations: ['employee_id'], customer_auto_message_logs: ['employee_id'], rating_requests: ['employee_id'], service_ratings: ['employee_id'],
  notification_automation_plans: [], notification_automation_tasks: [], notification_automation_plan_members: ['id', 'user_id'],
  notification_automation_task_recipients: ['user_id'], notification_automation_progress: ['user_id'],
  notification_automation_executions: ['user_id'], notification_automation_date_runs: [], notification_automation_failures: ['user_id'],
  messages: [], message_recipients: ['recipient_id'], message_templates: [], broadcast_messages: [], broadcast_recipients: ['employee_id'],
  dispatch_config: [], dispatch_groups: [], dispatch_order_pools: [], dispatch_group_orders: [], valid_order_data: [], used_order_data: ['user_id'],
  content_audit_events: [], content_audit_recipient_versions: [], orders_history: ['user_id'], administrators: [],
};
for (const fields of Object.values(FIELDS)) Object.freeze(fields);
export const EMPLOYEE_IDENTITY_PROJECTION_FIELDS = Object.freeze(FIELDS);
export const EMPLOYEE_IDENTITY_PROJECTION_PENDING = Object.freeze([
  'server_identity_reservation', 'dependent_record_ids', 'shared_configuration_resolution', 'ledger_cursor_mapping',
  'media_relocation', 'archive_namespace', 'work_session_finalization', 'database_restore_and_verify',
] as const);
export type EmployeeIdentityProjectionBlocker = typeof EMPLOYEE_IDENTITY_PROJECTION_PENDING[number]
  | 'submit_time_group_not_in_backup' | 'external_employee_visibility';
export interface EmployeeIdentityProjectionTable { key: EmployeeSafetyBackupTableKey; rows: number; bytes: number; sha256: string }
export interface EmployeeIdentityProjection {
  readonly sourceSiteId: string; readonly sourceJobId: string; readonly sourceEmployeeId: string; readonly targetEmployeeId: string;
  readonly sourceFingerprint: string; readonly recordsCipherSha256: string; readonly recordsCipherBytes: number;
  readonly tables: readonly EmployeeIdentityProjectionTable[]; readonly blockers: readonly EmployeeIdentityProjectionBlocker[];
  readonly canRestore: false; readonly completeEmployeeBackup: false; readonly canArchive: false; readonly canReplace: false; readonly fullSiteComplete: false;
  open(key: EmployeeSafetyBackupTableKey): TransferByteSource;
}
export interface EmployeeIdentityProjectionOptions {
  signal?: AbortSignal;
  onProgress?: (value: { tables: number; rows: number; bytes: number; canRestore: false; fullSiteComplete: false }) => void;
}
export class EmployeeIdentityProjectionError extends Error {
  constructor(readonly cancelled: boolean, readonly cleanupRequired: boolean) {
    super('Employee identity projection was not confirmed. No database restore, identity reservation, archive, replacement, retry, activation or maintenance release was performed.'
      + (cleanupRequired ? ' Temporary plaintext cleanup was not confirmed; do not reuse the workspace.' : ''));
    this.name = 'EmployeeIdentityProjectionError';
  }
}
const { checkAbort, withSignal } = dispatchTransferChecks;
const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const FLAGS = Object.freeze({ canRestore: false, completeEmployeeBackup: false, canArchive: false, canReplace: false, fullSiteComplete: false } as const);
const IMMUTABLE = new Set<EmployeeSafetyBackupTableKey>(['content_audit_events', 'content_audit_recipient_versions', 'administrators']);
const COMPOSITE = new Set<EmployeeSafetyBackupTableKey>(['notification_automation_task_recipients', 'notification_automation_progress', 'notification_automation_failures']);
const usedWorkspaces = new WeakSet<ArchiveBundleWorkspace>();
const BLOCK_BYTES = 64 * 1024;
function invalid(): never { throw new Error('Invalid employee identity projection.'); }
function uuid(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 36) invalid();
  return dispatchTransferChecks.uuid(value);
}
async function* read(source: TransferByteSource, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await withSignal(() => iterator.next(), signal); checkAbort(signal);
      if (next.done) return;
      if (!(next.value instanceof Uint8Array) || next.value.length > 1024 * 1024) invalid();
      yield new Uint8Array(next.value);
    }
  } finally { try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Cancellation cannot wait on IO. */ } }
}
function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '"') return i + 1;
  }
  return invalid();
}
function spans(line: string): Map<string, { start: number; end: number }> {
  const fields = new Map<string, { start: number; end: number }>();
  let i = 0;
  const space = () => { while (/\s/.test(line[i] ?? '') && i < line.length) i++; };
  space(); if (line[i++] !== '{') invalid();
  for (;;) {
    space(); if (line[i] === '}') break;
    if (line[i] !== '"') invalid();
    const end = stringEnd(line, i), key: unknown = JSON.parse(line.slice(i, end));
    if (typeof key !== 'string' || fields.has(key)) invalid();
    i = end; space(); if (line[i++] !== ':') invalid(); space();
    const start = i; let depth = 0;
    for (; i < line.length; i++) {
      const char = line[i];
      if (char === '"') i = stringEnd(line, i) - 1;
      else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') { if (depth === 0) break; depth--; }
      else if (char === ',' && depth === 0) break;
    }
    fields.set(key, { start, end: start + line.slice(start, i).trimEnd().length });
    if (line[i] === '}') break;
    if (line[i++] !== ',') invalid();
  }
  return fields;
}
function project(line: string, key: EmployeeSafetyBackupTableKey, source: string, target: string): string {
  if (IMMUTABLE.has(key)) return line;
  const row = JSON.parse(line) as Record<string, unknown>, fields = spans(line);
  const changes: { start: number; end: number; value: string }[] = [];
  const replace = (field: string, value: string) => {
    const span = fields.get(field); if (!span) invalid(); changes.push({ ...span, value });
  };
  for (const field of FIELDS[key]) {
    const span = fields.get(field); if (!span) invalid();
    if (field === 'target_employee_ids' && Array.isArray(row[field])) {
      const value = line.slice(span.start, span.end).replace(/"(?:[^"\\]|\\.)*"/g, token => JSON.parse(token) === source ? JSON.stringify(target) : token);
      if (value !== line.slice(span.start, span.end)) replace(field, value);
    } else if (row[field] === source) replace(field, JSON.stringify(target));
  }
  if (COMPOSITE.has(key)) replace('id', JSON.stringify(`${row.task_id}:${target}`));
  if (key === 'ccc_conversation_annotations') replace('id', JSON.stringify(`${row.customer_id}:${target}`));
  let result = line;
  for (const change of changes.sort((a, b) => b.start - a.start)) result = result.slice(0, change.start) + change.value + result.slice(change.end);
  return result;
}
async function eachLine(source: TransferByteSource, signal: AbortSignal, consume: (raw: Uint8Array) => Promise<void>): Promise<void> {
  const line = new Uint8Array(EMPLOYEE_SAFETY_BACKUP_LIMITS.maxLineBytes); let used = 0;
  try {
    for await (const raw of read(source, signal)) {
      let start = 0;
      while (start < raw.length) {
        checkAbort(signal);
        const lf = raw.indexOf(10, start), end = lf < 0 ? raw.length : lf + 1;
        if (end - start > line.length - used) invalid();
        line.set(raw.subarray(start, end), used); used += end - start; start = end;
        if (lf >= 0) { await consume(line.subarray(0, used)); used = 0; }
      }
    }
    if (used) invalid();
  } finally { line.fill(0); }
}
export async function withEmployeeSafetyIdentityProjection<T>(
  recordsFile: Pick<ReplacementBackupFile, 'open'>, mediaFile: Pick<ReplacementBackupFile, 'open'>, passphrase: string,
  targetEmployeeId: string, factory: ArchiveBundleWorkspaceFactory, consume: (projection: EmployeeIdentityProjection) => Promise<T>,
  options: EmployeeIdentityProjectionOptions = {},
): Promise<T> {
  const lifetime = new AbortController(), signal = lifetime.signal, abort = () => lifetime.abort();
  options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
  let cleanupRequired = false, failed = false, result: T | undefined;
  const spaces: { workspace: ArchiveBundleWorkspace; cleanup?: Promise<void> }[] = [];
  const discard = (item: typeof spaces[number], reason: unknown): Promise<void> => item.cleanup ??= (async () => {
    const cleanup = new AbortController(); let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { abortTimer ??= setTimeout(() => cleanup.abort(), 0); };
    options.signal?.addEventListener('abort', stop, { once: true }); if (options.signal?.aborted) stop();
    const timer = setTimeout(() => cleanup.abort(), EMPLOYEE_SAFETY_MEDIA_TIMEOUT_MS);
    try { await withSignal(() => item.workspace.abort(reason), cleanup.signal); }
    catch { cleanupRequired = true; throw new EmployeeIdentityProjectionError(options.signal?.aborted === true, true); }
    finally { clearTimeout(timer); clearTimeout(abortTimer); options.signal?.removeEventListener('abort', stop); }
  })();
  const trackedFactory = () => {
    checkAbort(signal); const w = factory(); if (usedWorkspaces.has(w)) invalid(); usedWorkspaces.add(w);
    const item: typeof spaces[number] = { workspace: w }; spaces.push(item);
    return { open: (path: string) => w.open(path), append: (path: string, raw: Uint8Array, s: AbortSignal) => w.append(path, raw, s),
      abort: (reason: unknown) => discard(item, reason) };
  };
  const scans: { digest: Sha256; bytes: number; complete: boolean }[] = [];
  const scannedRecords = { open(): TransferByteSource {
    const scan = { digest: new Sha256(), bytes: 0, complete: false }; scans.push(scan);
    return { async *[Symbol.asyncIterator]() {
      for await (const raw of read(recordsFile.open(), signal)) { scan.digest.update(raw); scan.bytes += raw.length; yield raw; }
      scan.complete = true;
    } };
  } };
  try {
    if (recordsFile === mediaFile) invalid();
    const target = uuid(targetEmployeeId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(target)) invalid();
    result = await withAuthenticatedEmployeeSafetyMediaBackup(scannedRecords, mediaFile, passphrase, trackedFactory, async pair => {
      const baseline = scans[scans.length - 1]; if (!baseline?.complete) invalid();
      const recordsCipherSha256 = baseline.digest.digestHex(), recordsCipherBytes = baseline.bytes, original = pair.inventory.records_catalog;
      if ([original.employee_id, original.site_id, original.job_id].includes(target)) invalid();
      return withAuthenticatedEmployeeSafetyBackup(scannedRecords, passphrase, trackedFactory, async records => {
        const current = scans[scans.length - 1];
        if (!current?.complete || current.bytes !== recordsCipherBytes || current.digest.digestHex() !== recordsCipherSha256
          || JSON.stringify(records.catalog) !== JSON.stringify(original)) invalid();
        const manifest = records.manifest;
        if ([manifest.exportId, manifest.volumeId].includes(target)) invalid();
        const workspace = trackedFactory(), blocks = new Map<EmployeeSafetyBackupTableKey, string[]>();
        const catalog: EmployeeSafetyBackupCatalog = { ...original, employee_id: target };
        const tables: EmployeeIdentityProjectionTable[] = [], blockers = new Set<EmployeeIdentityProjectionBlocker>(EMPLOYEE_IDENTITY_PROJECTION_PENDING);
        let totalRows = 0, totalBytes = 0;
        for (const [index, table] of original.tables.entries()) {
          const digest = new Sha256(), rowHashes = new Sha256(), projectedHash = new Sha256();
          let bytes = 0, rows = 0, projectedBytes = 0, blockUsed = 0;
          const block = new Uint8Array(BLOCK_BYTES), blockHashes: string[] = [];
          const path = employeeSafetyBackupEntryPath(table.key), expected = manifest.entries[index];
          await withSignal(() => workspace.append(path, new Uint8Array(), signal), signal);
          await eachLine(records.open(path), signal, async raw => {
            const line = dec.decode(raw), row = JSON.parse(line) as Record<string, unknown>;
            validateEmployeeSafetyBackupRow(line, table.key, original);
            if (row.id === target) invalid();
            if (table.key === 'simulated_customers') {
              const ids = [row.target_employee_id, ...(Array.isArray(row.target_employee_ids) ? row.target_employee_ids : [])];
              if (ids.includes(target)) invalid();
              if (ids.some(id => id !== null && id !== original.employee_id)) blockers.add('external_employee_visibility');
            }
            if (table.key === 'employee_submit_time_settings' && row.group_id !== null) blockers.add('submit_time_group_not_in_backup');
            bytes += raw.length; rows++;
            if (rows > table.rows || bytes > table.bytes) invalid();
            digest.update(raw); rowHashes.update(enc.encode(new Sha256().update(raw).digestHex()));
            const projected = project(line, table.key, original.employee_id, target);
            validateEmployeeSafetyBackupRow(projected, table.key, IMMUTABLE.has(table.key) ? original : catalog);
            const next = enc.encode(projected);
            projectedBytes += next.length;
            if (projectedBytes > EMPLOYEE_SAFETY_BACKUP_LIMITS.maxTableBytes) invalid();
            projectedHash.update(next);
            for (let offset = 0; offset < next.length;) {
              const size = Math.min(BLOCK_BYTES - blockUsed, next.length - offset);
              block.set(next.subarray(offset, offset + size), blockUsed); blockUsed += size; offset += size;
              if (blockUsed === BLOCK_BYTES) { blockHashes.push(new Sha256().update(block).digestHex()); blockUsed = 0; }
            }
            await withSignal(() => workspace.append(path, next, signal), signal);
          });
          if (rows !== table.rows || bytes !== table.bytes || rowHashes.digestHex() !== table.row_hashes_sha256
            || expected.path !== path || expected.bytes !== bytes || expected.sha256 !== digest.digestHex()) invalid();
          if (blockUsed) blockHashes.push(new Sha256().update(block.subarray(0, blockUsed)).digestHex());
          block.fill(0); blocks.set(table.key, blockHashes);
          tables.push({ key: table.key, rows, bytes: projectedBytes, sha256: projectedHash.digestHex() });
          totalRows += rows; totalBytes += projectedBytes;
          if (totalBytes > EMPLOYEE_SAFETY_BACKUP_LIMITS.maxTotalBytes) invalid();
          options.onProgress?.({ tables: tables.length, rows: totalRows, bytes: totalBytes, canRestore: false, fullSiteComplete: false });
          checkAbort(signal);
        }
        for (const table of tables) {
          const hash = new Sha256(); let bytes = 0, rows = 0;
          await eachLine(workspace.open(employeeSafetyBackupEntryPath(table.key)), signal, async raw => {
            validateEmployeeSafetyBackupRow(dec.decode(raw), table.key, IMMUTABLE.has(table.key) ? original : catalog);
            hash.update(raw); bytes += raw.length; rows++;
          });
          if (bytes !== table.bytes || rows !== table.rows || hash.digestHex() !== table.sha256) invalid();
        }
        let active = true;
        const readerLifetime = new AbortController(), stopReader = () => readerLifetime.abort();
        signal.addEventListener('abort', stopReader, { once: true }); if (signal.aborted) stopReader();
        const readerSignal = readerLifetime.signal;
        const projection: EmployeeIdentityProjection = Object.freeze({
          sourceSiteId: original.site_id, sourceJobId: original.job_id, sourceEmployeeId: original.employee_id, targetEmployeeId: target,
          sourceFingerprint: original.fingerprint, recordsCipherSha256, recordsCipherBytes,
          tables: Object.freeze(tables.map(t => Object.freeze({ ...t }))), blockers: Object.freeze([...blockers]), ...FLAGS,
          open(key: EmployeeSafetyBackupTableKey): TransferByteSource {
            if (!active || !(EMPLOYEE_SAFETY_BACKUP_TABLE_KEYS as readonly string[]).includes(key)) invalid();
            const expected = tables.find(t => t.key === key)!;
            return { async *[Symbol.asyncIterator]() {
              const block = new Uint8Array(BLOCK_BYTES); let used = 0, index = 0;
              try {
                if (!active) invalid(); const hash = new Sha256(); let bytes = 0;
                for await (const raw of read(workspace.open(employeeSafetyBackupEntryPath(key)), readerSignal)) {
                  if (!active) invalid(); bytes += raw.length; if (bytes > expected.bytes) invalid(); hash.update(raw);
                }
                if (!active || bytes !== expected.bytes || hash.digestHex() !== expected.sha256) invalid();
                const expectedBlocks = blocks.get(key)!;
                for await (const raw of read(workspace.open(employeeSafetyBackupEntryPath(key)), readerSignal)) {
                  if (!active) invalid();
                  for (let offset = 0; offset < raw.length;) {
                    const size = Math.min(BLOCK_BYTES - used, raw.length - offset);
                    block.set(raw.subarray(offset, offset + size), used); used += size; offset += size;
                    if (used === BLOCK_BYTES) {
                      if (!active || new Sha256().update(block).digestHex() !== expectedBlocks[index++]) invalid();
                      checkAbort(readerSignal); yield block.slice(); if (!active) invalid(); used = 0;
                    }
                  }
                }
                if (used) {
                  if (!active || new Sha256().update(block.subarray(0, used)).digestHex() !== expectedBlocks[index++]) invalid();
                  checkAbort(readerSignal); yield block.slice(0, used);
                }
                if (!active || index !== expectedBlocks.length) invalid();
              } catch { throw new EmployeeIdentityProjectionError(options.signal?.aborted === true, cleanupRequired); }
              finally { block.fill(0); }
            } };
          },
        });
        try { return await withSignal(() => consume(projection), signal); }
        finally { active = false; readerLifetime.abort(); signal.removeEventListener('abort', stopReader); }
      }, { signal });
    }, { signal });
    checkAbort(signal);
  } catch (error) {
    failed = true;
    if (error && typeof error === 'object' && 'cleanupRequired' in error && error.cleanupRequired === true) cleanupRequired = true;
  } finally {
    lifetime.abort(); options.signal?.removeEventListener('abort', abort);
    for (const item of spaces) {
      try { await discard(item, new Error('Employee identity projection discarded.')); } catch { cleanupRequired = true; }
    }
  }
  if (failed || cleanupRequired || options.signal?.aborted) throw new EmployeeIdentityProjectionError(options.signal?.aborted === true, cleanupRequired);
  return result!;
}
