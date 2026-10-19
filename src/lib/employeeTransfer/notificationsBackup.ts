import {
  MAX_CONTAINER_INPUT_BYTES, writeEncryptedVolume, verifyEncryptedVolume,
  type ContainerLimits, type TransferEntry,
} from './container';
import type { TransferByteSource, TransferByteStream } from './crypto';
import type { VolumeInfo, VolumeManifest } from './manifest';
import type {
  ReplacementBackupTemporaryFiles, ReplacementBackupFile, ReplacementBackupOptions, ReplacementBackupPhase,
} from './replacementBackup';
import { dispatchTransferChecks } from './dispatchTransfer';
import {
  NOTIFICATIONS_TABLE_KEYS, NOTIFICATIONS_TRANSFER_LIMITS, notificationsEntryPath,
  validateNotificationsPage, validateNotificationsRow,
  type NotificationsTableCatalog, type NotificationsTableKey,
} from './notificationsTransfer';
import { Sha256 } from './sha256';

export const MAX_NOTIFICATIONS_BACKUP_PLAINTEXT_BYTES = 8 * 1024 * 1024;
export const MAX_NOTIFICATIONS_BACKUP_BYTES = 9 * 1024 * 1024;
export const NOTIFICATIONS_BACKUP_CHUNK_BYTES = 128 * 1024;
export const NOTIFICATIONS_BACKUP_CONTAINER_LIMITS: Readonly<Partial<ContainerLimits>> = Object.freeze({
  maxEntries: NOTIFICATIONS_TABLE_KEYS.length, maxEntryBytes: MAX_NOTIFICATIONS_BACKUP_PLAINTEXT_BYTES,
  maxTotalBytes: MAX_NOTIFICATIONS_BACKUP_PLAINTEXT_BYTES, maxZipBytes: MAX_NOTIFICATIONS_BACKUP_BYTES,
  maxManifestBytes: 16 * 1024, maxLineBytes: NOTIFICATIONS_TRANSFER_LIMITS.maxLineBytes,
});
export interface NotificationsBackupCatalog {
  version: 1; scope: 'notification-backup'; site_id: string; package_id: string; date_runs_supported: boolean;
  tables: NotificationsTableCatalog[]; media_included: false; full_site_complete: false;
}
export interface NotificationsBackupDescriptor {
  backup_id: string; plan_hash: string; target_hash: string; catalog: NotificationsBackupCatalog;
}
export interface NotificationsBackupSource {
  catalog(signal?: AbortSignal): Promise<unknown>;
  page(key: NotificationsTableKey, after: string | null, signal?: AbortSignal): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<unknown>;
}
export interface NotificationsBackupVerification {
  verified: true; backup_id: string; plan_hash: string; target_hash: string;
  media_included: false; full_site_complete: false;
}
export interface NotificationsBackupAppendReceipt {
  success: true; bytes: number; sha256: string; repeated: boolean;
}
export interface NotificationsBackupSealReceipt {
  success: true; backup_id: string; sha256: string; bytes: number; repeated: boolean;
  media_pending: true; full_site_complete: false;
}
export interface NotificationsBackupReceiver {
  append(chunkNo: number, hex: string, signal?: AbortSignal): Promise<NotificationsBackupAppendReceipt>;
  seal(cipherSha256: string, bytes: number, signal?: AbortSignal): Promise<NotificationsBackupSealReceipt>;
}
export interface NotificationsBackupResult {
  descriptor: NotificationsBackupDescriptor; cipherSha256: string; bytes: number; chunks: number;
  sealReceipt: NotificationsBackupSealReceipt;
}
export class NotificationsBackupLimitError extends Error {
  constructor(readonly kind: 'plaintext' | 'ciphertext') {
    super(`Notifications backup exceeds the ${kind === 'plaintext' ? '8 MiB plaintext' : '9 MiB ciphertext'} limit. Backup blocked without truncation.`);
    this.name = 'NotificationsBackupLimitError';
  }
}
export class NotificationsBackupError extends Error {
  constructor(
    readonly phase: ReplacementBackupPhase, readonly cancelled: boolean,
    readonly serverChunksMayExist: boolean, readonly sealMayHaveSucceeded: boolean,
    readonly cleanupRequired: boolean, readonly limitExceeded = false,
  ) {
    super(`Notifications backup stopped during ${phase}. Keep and check the independent encrypted file (it may be incomplete); server ciphertext or the seal outcome may be uncertain. Reconcile the server before retrying. No automatic cancel RPC, retry, apply or close was performed. Media is not backed up and restoration is not available.${limitExceeded ? ' Backup exceeds the 8 MiB plaintext or 9 MiB ciphertext limit; blocked without truncation.' : ''}${cleanupRequired ? ' Temporary plaintext cleanup was not confirmed; do not reuse the workspace.' : ''}`);
    this.name = 'NotificationsBackupError';
  }
}
const { object, count, checkAbort, withSignal } = dispatchTransferChecks;
const limits = NOTIFICATIONS_TRANSFER_LIMITS;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const EMPTY_HASH = new Sha256().digestHex();
function invalid(): never { throw new Error('Invalid notifications backup.'); }
function uuid(value: unknown): string {
  const result = dispatchTransferChecks.uuid(value);
  if (result.length !== 36) invalid();
  return result;
}
function hash(value: unknown): string {
  const result = dispatchTransferChecks.hash(value);
  if (result.length !== 64) invalid();
  return result;
}
export function validateNotificationsBackupCatalog(value: unknown): NotificationsBackupCatalog {
  try {
    const record = object(value, ['version', 'scope', 'site_id', 'package_id', 'date_runs_supported', 'tables', 'media_included', 'full_site_complete']);
    if (record.version !== 1 || record.scope !== 'notification-backup' || typeof record.date_runs_supported !== 'boolean'
      || record.media_included !== false || record.full_site_complete !== false
      || !Array.isArray(record.tables) || Object.getPrototypeOf(record.tables) !== Array.prototype) invalid();
    const raw: unknown[] = record.tables;
    const length = Object.getOwnPropertyDescriptor(raw, 'length');
    if (!length || !('value' in length) || length.value !== NOTIFICATIONS_TABLE_KEYS.length
      || Reflect.ownKeys(raw).length !== NOTIFICATIONS_TABLE_KEYS.length + 1) invalid();
    let total = 0;
    const tables = NOTIFICATIONS_TABLE_KEYS.map((key, index) => {
      const field = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!field?.enumerable || !('value' in field)) invalid();
      const table = object(field.value, ['key', 'rows', 'bytes', 'row_hashes_sha256']);
      if (table.key !== key) invalid();
      const rows = count(table.rows, limits.maxRows), bytes = count(table.bytes, limits.maxTableBytes);
      const digest = hash(table.row_hashes_sha256);
      if ((rows === 0) !== (bytes === 0) || (rows === 0 && digest !== EMPTY_HASH)
        || (!record.date_runs_supported && key === 'notification_automation_date_runs' && rows !== 0)) invalid();
      total += bytes;
      return { key, rows, bytes, row_hashes_sha256: digest };
    });
    if (total > MAX_NOTIFICATIONS_BACKUP_PLAINTEXT_BYTES) throw new NotificationsBackupLimitError('plaintext');
    return { version: 1, scope: 'notification-backup', site_id: uuid(record.site_id), package_id: uuid(record.package_id),
      date_runs_supported: record.date_runs_supported, tables, media_included: false, full_site_complete: false };
  } catch (error) {
    if (error instanceof NotificationsBackupLimitError) throw error;
    invalid();
  }
}
export function validateNotificationsBackupDescriptor(value: unknown): NotificationsBackupDescriptor {
  try {
    const record = object(value, ['backup_id', 'plan_hash', 'target_hash', 'catalog']);
    return { backup_id: uuid(record.backup_id), plan_hash: hash(record.plan_hash), target_hash: hash(record.target_hash),
      catalog: validateNotificationsBackupCatalog(record.catalog) };
  } catch (error) {
    if (error instanceof NotificationsBackupLimitError) throw error;
    invalid();
  }
}
class TableVerifier {
  private readonly line = new Uint8Array(limits.maxLineBytes);
  private readonly digest = new Sha256();
  private readonly rowHashes = new Sha256();
  private used = 0;
  private rows = 0;
  private bytes = 0;
  private last: string | null = null;
  constructor(private readonly expected: NotificationsTableCatalog) {}
  push(input: Uint8Array, signal: AbortSignal): void {
    checkAbort(signal);
    if (!(input instanceof Uint8Array) || input.length > limits.maxInputBytes) invalid();
    this.bytes += input.length;
    if (this.bytes > this.expected.bytes) invalid();
    const chunk = new Uint8Array(input);
    this.digest.update(chunk);
    let start = 0;
    while (start < chunk.length) {
      checkAbort(signal);
      const lf = chunk.indexOf(10, start), end = lf === -1 ? chunk.length : lf + 1;
      if (this.used + end - start > this.line.length) invalid();
      this.line.set(chunk.subarray(start, end), this.used); this.used += end - start; start = end;
      if (lf !== -1) {
        if (++this.rows > this.expected.rows) invalid();
        const raw = this.line.subarray(0, this.used);
        const id = validateNotificationsRow(decoder.decode(raw), this.expected.key);
        if (this.last !== null && id <= this.last) invalid();
        this.last = id;
        this.rowHashes.update(encoder.encode(new Sha256().update(raw).digestHex()));
        this.used = 0;
      }
    }
  }
  finish(): string {
    if (this.used || this.rows !== this.expected.rows || this.bytes !== this.expected.bytes
      || this.rowHashes.digestHex() !== this.expected.row_hashes_sha256) invalid();
    return this.digest.digestHex();
  }
}
function close(iterator: AsyncIterator<Uint8Array>): void {
  try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* A blocked producer must not delay cancellation. */ }
}
class CipherScan {
  bytes = 0;
  ended = false;
  private readonly hash = new Sha256();
  async *read(source: TransferByteSource, signal: AbortSignal): TransferByteStream {
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') invalid();
    const iterator = source[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await withSignal(() => iterator.next(), signal);
        checkAbort(signal);
        if (next.done) { this.ended = true; return; }
        if (!(next.value instanceof Uint8Array) || next.value.length > MAX_CONTAINER_INPUT_BYTES) invalid();
        this.bytes += next.value.length;
        if (this.bytes > MAX_NOTIFICATIONS_BACKUP_BYTES) throw new NotificationsBackupLimitError('ciphertext');
        const chunk = new Uint8Array(next.value);
        this.hash.update(chunk);
        if (chunk.length) yield chunk;
      }
    } finally { if (!this.ended) close(iterator); }
  }
  digest(): string {
    if (!this.ended || !this.bytes) invalid();
    return this.hash.digestHex();
  }
}
export async function createNotificationsBackup(
  descriptor: NotificationsBackupDescriptor, source: NotificationsBackupSource,
  temporary: ReplacementBackupTemporaryFiles, file: ReplacementBackupFile, receiver: NotificationsBackupReceiver,
  passphrase: string, options: ReplacementBackupOptions = {},
): Promise<NotificationsBackupResult> {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let phase: ReplacementBackupPhase = 'snapshot';
  let serverChunksMayExist = false, sealMayHaveSucceeded = false;
  let cleanup: Promise<void> | undefined;
  const discard = () => cleanup ??= Promise.resolve().then(() => temporary.abort(new Error('Notifications backup plaintext discarded.')));
  const progress = (bytes: number, completed = false) => {
    checkAbort(signal); options.onProgress?.({ phase, bytes, completed }); checkAbort(signal);
  };
  try {
    checkAbort(signal);
    const frozen = validateNotificationsBackupDescriptor(descriptor);
    progress(0);
    const catalog = validateNotificationsBackupCatalog(await withSignal(() => source.catalog(signal), signal));
    if (JSON.stringify(catalog) !== JSON.stringify(frozen.catalog)) invalid();
    const snapshot: { path: string; kind: 'ndjson'; bytes: number; sha256: string }[] = [];
    let snapshotBytes = 0;
    for (const table of catalog.tables) {
      const path = notificationsEntryPath(table.key), verifier = new TableVerifier(table);
      let after: string | null = null;
      do {
        const page = validateNotificationsPage(await withSignal(() => source.page(table.key, after, signal), signal), table.key, after);
        const raw = encoder.encode(page.ndjson);
        verifier.push(raw, signal);
        await withSignal(() => temporary.append(path, raw, signal), signal);
        checkAbort(signal);
        snapshotBytes += raw.length;
        progress(snapshotBytes);
        after = page.next_after;
      } while (after !== null);
      snapshot.push({ path, kind: 'ndjson', bytes: table.bytes, sha256: verifier.finish() });
    }
    const verification = object(await withSignal(() => source.verify(signal), signal),
      ['verified', 'backup_id', 'plan_hash', 'target_hash', 'media_included', 'full_site_complete']);
    if (verification.verified !== true || verification.backup_id !== frozen.backup_id
      || verification.plan_hash !== frozen.plan_hash || verification.target_hash !== frozen.target_hash
      || verification.media_included !== false || verification.full_site_complete !== false) invalid();
    progress(snapshotBytes, true);
    const info: VolumeInfo = { scope: 'replacement-backup', exportId: frozen.backup_id, volumeId: frozen.backup_id,
      sourceSiteId: frozen.catalog.site_id, volumeIndex: 1, volumeCount: 1, createdAt: new Date().toISOString() };
    async function* entries(): AsyncGenerator<TransferEntry> {
      for (const entry of snapshot) yield { path: entry.path, bytes: entry.bytes, open: () => temporary.open(entry.path) };
    }
    phase = 'save'; progress(0);
    const written = new CipherScan();
    const encrypted = written.read(writeEncryptedVolume(entries(), info, passphrase,
      { signal, limits: NOTIFICATIONS_BACKUP_CONTAINER_LIMITS }), signal);
    try { await withSignal(() => file.write(encrypted, signal), signal); } finally { close(encrypted); }
    checkAbort(signal);
    const cipherSha256 = written.digest();
    progress(written.bytes, true);
    await discard();
    checkAbort(signal);

    phase = 'verify'; progress(0);
    const verified = new CipherScan();
    const saved = verified.read(file.open(), signal);
    const verifiers = new Map(catalog.tables.map(table => [notificationsEntryPath(table.key), new TableVerifier(table)]));
    const seen = new Set<string>();
    let manifest: VolumeManifest;
    try {
      manifest = await verifyEncryptedVolume(saved, passphrase, {
        async append(path, chunk) {
          const verifier = verifiers.get(path);
          if (!verifier) invalid();
          seen.add(path);
          verifier.push(chunk, signal);
        },
        async abort() {},
      }, { signal, limits: NOTIFICATIONS_BACKUP_CONTAINER_LIMITS,
        expectedMetadata: { exportId: info.exportId, volumeId: info.volumeId } });
    } finally { close(saved); }
    if (manifest.scope !== info.scope || manifest.exportId !== info.exportId || manifest.volumeId !== info.volumeId
      || manifest.sourceSiteId !== info.sourceSiteId || manifest.createdAt !== info.createdAt
      || manifest.volumeIndex !== 1 || manifest.volumeCount !== 1 || manifest.entries.length !== NOTIFICATIONS_TABLE_KEYS.length
      || verified.digest() !== cipherSha256 || verified.bytes !== written.bytes || seen.size !== NOTIFICATIONS_TABLE_KEYS.length) invalid();
    for (let index = 0; index < snapshot.length; index++) {
      const entry = snapshot[index], actual = manifest.entries[index];
      if (!seen.has(entry.path) || verifiers.get(entry.path)!.finish() !== entry.sha256
        || actual.path !== entry.path || actual.kind !== 'ndjson' || actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) invalid();
    }
    progress(verified.bytes, true);

    phase = 'upload'; progress(0);
    const uploaded = new CipherScan();
    const upload = uploaded.read(file.open(), signal);
    const page = new Uint8Array(NOTIFICATIONS_BACKUP_CHUNK_BYTES);
    let used = 0, chunks = 0, confirmedBytes = 0;
    const append = async () => {
      const bytes = page.subarray(0, used);
      const sha256 = new Sha256().update(bytes).digestHex();
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      const ack = object(await withSignal(() => {
        serverChunksMayExist = true;
        return receiver.append(chunks, hex, signal);
      }, signal), ['success', 'bytes', 'sha256', 'repeated']);
      if (ack.success !== true || ack.bytes !== used || ack.sha256 !== sha256 || typeof ack.repeated !== 'boolean') invalid();
      checkAbort(signal);
      confirmedBytes += used; chunks++; used = 0;
      progress(confirmedBytes);
    };
    try {
      for await (const chunk of upload) {
        let offset = 0;
        while (offset < chunk.length) {
          const take = Math.min(page.length - used, chunk.length - offset);
          page.set(chunk.subarray(offset, offset + take), used);
          used += take; offset += take;
          if (used === page.length) await append();
        }
      }
      if (used) await append();
    } finally { close(upload); }
    if (uploaded.digest() !== cipherSha256 || uploaded.bytes !== written.bytes || confirmedBytes !== written.bytes) invalid();
    progress(confirmedBytes, true);
    phase = 'seal'; progress(0);
    const receipt = object(await withSignal(() => {
      sealMayHaveSucceeded = true;
      return receiver.seal(cipherSha256, written.bytes, signal);
    }, signal), ['success', 'backup_id', 'sha256', 'bytes', 'repeated', 'media_pending', 'full_site_complete']);
    if (receipt.success !== true || receipt.backup_id !== frozen.backup_id || receipt.sha256 !== cipherSha256
      || receipt.bytes !== written.bytes || typeof receipt.repeated !== 'boolean'
      || receipt.media_pending !== true || receipt.full_site_complete !== false) invalid();
    checkAbort(signal);
    const sealReceipt: NotificationsBackupSealReceipt = { success: true, backup_id: frozen.backup_id,
      sha256: cipherSha256, bytes: written.bytes, repeated: receipt.repeated, media_pending: true, full_site_complete: false };
    try { options.onProgress?.({ phase, bytes: written.bytes, completed: true }); }
    catch { /* A terminal observer cannot revoke an acknowledged seal. */ }
    return { descriptor: structuredClone(frozen), cipherSha256, bytes: written.bytes, chunks, sealReceipt };
  } catch (error) {
    controller.abort();
    let cleanupRequired = false;
    try { await discard(); } catch { cleanupRequired = true; }
    throw new NotificationsBackupError(phase, options.signal?.aborted === true, serverChunksMayExist,
      sealMayHaveSucceeded, cleanupRequired, error instanceof NotificationsBackupLimitError);
  } finally {
    passphrase = '';
    options.signal?.removeEventListener('abort', cancel);
  }
}
