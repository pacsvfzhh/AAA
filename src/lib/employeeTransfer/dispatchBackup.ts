import {
  MAX_CONTAINER_INPUT_BYTES, writeEncryptedVolume, verifyEncryptedVolume,
  type ContainerLimits, type TransferEntry,
} from './container';
import type { TransferByteSource, TransferByteStream, TransferMetadata } from './crypto';
import type { VolumeInfo, VolumeManifest } from './manifest';
import type {
  ReplacementBackupFile, ReplacementBackupTemporaryFiles, ReplacementBackupReceiver,
  ReplacementBackupOptions, ReplacementBackupPhase,
} from './replacementBackup';
import { Sha256 } from './sha256';
import {
  DISPATCH_TABLE_KEYS, DISPATCH_TRANSFER_LIMITS, dispatchTransferChecks,
  exportDispatchData, validateDispatchCatalog,
  type DispatchExportCatalog, type DispatchExportSource,
} from './dispatchTransfer';
import {
  DispatchImportCleanupError, DispatchImportStagingMayExistError, DispatchTableVerifier,
  dispatchImportChecks, stageDispatchImport, validateDispatchManifest,
  type DispatchImportTarget, type DispatchImportResult, type DispatchImportOptions,
} from './dispatchImport';

export const MAX_DISPATCH_BACKUP_PLAINTEXT_BYTES = 8 * 1024 * 1024;
export const MAX_DISPATCH_BACKUP_BYTES = 9 * 1024 * 1024;
export const DISPATCH_BACKUP_CHUNK_BYTES = 128 * 1024;
export const DISPATCH_BACKUP_CONTAINER_LIMITS: Readonly<Partial<ContainerLimits>> = Object.freeze({
  maxEntries: DISPATCH_TABLE_KEYS.length, maxEntryBytes: MAX_DISPATCH_BACKUP_PLAINTEXT_BYTES,
  maxTotalBytes: MAX_DISPATCH_BACKUP_PLAINTEXT_BYTES, maxZipBytes: MAX_DISPATCH_BACKUP_BYTES,
  maxManifestBytes: 16 * 1024, maxLineBytes: DISPATCH_TRANSFER_LIMITS.maxLineBytes,
});
// Source imports retain the export protocol's larger bounds; target safety backups do not.
export const DISPATCH_IMPORT_CONTAINER_LIMITS: Readonly<Partial<ContainerLimits>> = Object.freeze({
  maxEntries: DISPATCH_TABLE_KEYS.length, maxEntryBytes: DISPATCH_TRANSFER_LIMITS.maxTableBytes,
  maxTotalBytes: DISPATCH_TRANSFER_LIMITS.maxTotalBytes,
  maxZipBytes: DISPATCH_TRANSFER_LIMITS.maxTotalBytes + 1024 * 1024,
  maxManifestBytes: 16 * 1024, maxLineBytes: DISPATCH_TRANSFER_LIMITS.maxLineBytes,
});
export interface DispatchBackupDescriptor {
  backup_id: string; plan_hash: string; target_hash: string; catalog: DispatchExportCatalog;
}
export interface DispatchBackupResult {
  descriptor: DispatchBackupDescriptor; cipherSha256: string; bytes: number; chunks: number;
  sealReceipt: { success: true; backup_id: string; sha256: string; bytes: number;
    repeated: boolean; full_site_complete: false };
}
export class DispatchBackupLimitError extends Error {
  constructor(readonly kind: 'plaintext' | 'ciphertext') {
    super(`Dispatch backup exceeds the ${kind === 'plaintext' ? '8 MiB plaintext' : '9 MiB ciphertext'} limit. Backup blocked without truncation.`);
    this.name = 'DispatchBackupLimitError';
  }
}
export class DispatchBackupError extends Error {
  constructor(
    readonly phase: ReplacementBackupPhase, readonly cancelled: boolean,
    readonly serverChunksMayExist: boolean, readonly sealMayHaveSucceeded: boolean,
    readonly cleanupRequired: boolean, readonly limitExceeded = false,
  ) {
    super(`Dispatch backup stopped during ${phase}. Keep and check the independent encrypted file (it may be incomplete); server ciphertext or the seal outcome may be uncertain. Reconcile the server before retrying. No automatic cancel RPC, retry, apply or close was performed.${limitExceeded ? ' Backup exceeds the 8 MiB plaintext or 9 MiB ciphertext limit; blocked without truncation.' : ''}${cleanupRequired ? ' Temporary plaintext cleanup was not confirmed; do not reuse the workspace.' : ''}`);
    this.name = 'DispatchBackupError';
  }
}
const { object, uuid, hash } = dispatchTransferChecks;
const { checkAbort, withSignal } = dispatchImportChecks;
function invalid(): never { throw new Error('Invalid dispatch backup.'); }

export function validateDispatchBackupDescriptor(value: unknown): DispatchBackupDescriptor {
  const record = object(value, ['backup_id', 'plan_hash', 'target_hash', 'catalog']);
  const catalog = validateDispatchCatalog(record.catalog);
  if (catalog.tables.reduce((total, table) => total + table.bytes, 0) > MAX_DISPATCH_BACKUP_PLAINTEXT_BYTES) {
    throw new DispatchBackupLimitError('plaintext');
  }
  return { backup_id: uuid(record.backup_id), plan_hash: hash(record.plan_hash), target_hash: hash(record.target_hash), catalog };
}
function close(iterator: AsyncIterator<Uint8Array>): void {
  try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Read closure only. */ }
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
        if (this.bytes > MAX_DISPATCH_BACKUP_BYTES) throw new DispatchBackupLimitError('ciphertext');
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

export async function createDispatchBackup(
  descriptor: DispatchBackupDescriptor, source: DispatchExportSource,
  temporary: ReplacementBackupTemporaryFiles, file: ReplacementBackupFile, receiver: ReplacementBackupReceiver,
  passphrase: string, options: ReplacementBackupOptions = {},
): Promise<DispatchBackupResult> {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let phase: ReplacementBackupPhase = 'snapshot';
  let serverChunksMayExist = false, sealMayHaveSucceeded = false;
  let cleanup: Promise<void> | undefined;
  const discard = () => cleanup ??= Promise.resolve().then(() => temporary.abort(new Error('Dispatch backup plaintext discarded.')));
  const progress = (bytes: number, completed = false) => {
    checkAbort(signal); options.onProgress?.({ phase, bytes, completed }); checkAbort(signal);
  };
  try {
    checkAbort(signal);
    const frozen = validateDispatchBackupDescriptor(descriptor);
    progress(0);
    const snapshot = await exportDispatchData({
      async catalog(readSignal) {
        const catalog = validateDispatchCatalog(await source.catalog(readSignal));
        if (JSON.stringify(catalog) !== JSON.stringify(frozen.catalog)) invalid();
        return catalog;
      },
      page: (key, after, readSignal) => source.page(key, after, readSignal),
      verify: readSignal => source.verify(readSignal),
    }, { append: (path, chunk, readSignal) => temporary.append(path, chunk, readSignal), abort: discard },
    { signal, onProgress: value => progress(value.bytes) });
    progress(snapshot.bytes, true);
    const info: VolumeInfo = { scope: 'replacement-backup', exportId: frozen.backup_id, volumeId: frozen.backup_id,
      sourceSiteId: frozen.catalog.site_id, volumeIndex: 1, volumeCount: 1, createdAt: new Date().toISOString() };
    async function* entries(): AsyncGenerator<TransferEntry> {
      for (const entry of snapshot.entries) yield { path: entry.path, bytes: entry.bytes, open: () => temporary.open(entry.path) };
    }
    phase = 'save'; progress(0);
    const written = new CipherScan();
    const encrypted = written.read(writeEncryptedVolume(entries(), info, passphrase,
      { signal, limits: DISPATCH_BACKUP_CONTAINER_LIMITS }), signal);
    try { await withSignal(() => file.write(encrypted, signal), signal); } finally { close(encrypted); }
    checkAbort(signal);
    const cipherSha256 = written.digest();
    progress(written.bytes, true);
    await discard(); // Only the durable, independent encrypted file may survive.
    checkAbort(signal);

    phase = 'verify'; progress(0);
    const verified = new CipherScan();
    const saved = verified.read(file.open(), signal);
    const verifiers = new Map<string, DispatchTableVerifier>(frozen.catalog.tables.map(table =>
      [`data/dispatch-${table.key}.ndjson`, new DispatchTableVerifier(table)]));
    const seen = new Set<string>();
    let manifest: VolumeManifest;
    try {
      manifest = await verifyEncryptedVolume(saved, passphrase, {
        async append(path, chunk) {
          const verifier = verifiers.get(path);
          if (!verifier) invalid();
          seen.add(path);
          // Discard as we scan: plaintext is neither retained nor written back to the invalidated workspace.
          await verifier.push(chunk, signal);
        },
        async abort() {},
      }, { signal, limits: DISPATCH_BACKUP_CONTAINER_LIMITS,
        expectedMetadata: { exportId: info.exportId, volumeId: info.volumeId } });
    } finally { close(saved); }
    validateDispatchManifest(manifest, frozen.catalog);
    if (manifest.exportId !== info.exportId || manifest.volumeId !== info.volumeId || manifest.createdAt !== info.createdAt
      || verified.digest() !== cipherSha256 || verified.bytes !== written.bytes || seen.size !== DISPATCH_TABLE_KEYS.length) invalid();
    for (const entry of snapshot.entries) {
      // A valid ZIP with the right byte sizes is insufficient: compare catalog row hashes and original file SHA-256.
      if (!seen.has(entry.path) || verifiers.get(entry.path)!.finish() !== entry.sha256
        || manifest.entries.find(value => value.path === entry.path)?.sha256 !== entry.sha256) invalid();
    }
    progress(verified.bytes, true);

    phase = 'upload'; progress(0);
    const uploaded = new CipherScan();
    const upload = uploaded.read(file.open(), signal);
    const page = new Uint8Array(DISPATCH_BACKUP_CHUNK_BYTES);
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
    }, signal), ['success', 'backup_id', 'sha256', 'bytes', 'repeated', 'full_site_complete']);
    if (receipt.success !== true || receipt.backup_id !== frozen.backup_id || receipt.sha256 !== cipherSha256
      || receipt.bytes !== written.bytes || typeof receipt.repeated !== 'boolean' || receipt.full_site_complete !== false) invalid();
    checkAbort(signal);
    const sealReceipt: DispatchBackupResult['sealReceipt'] = { success: true, backup_id: frozen.backup_id,
      sha256: cipherSha256, bytes: written.bytes, repeated: receipt.repeated, full_site_complete: false };
    try { options.onProgress?.({ phase, bytes: written.bytes, completed: true }); } catch { /* Terminal observer only. */ }
    return { descriptor: structuredClone(frozen), cipherSha256, bytes: written.bytes, chunks, sealReceipt };
  } catch (error) {
    controller.abort();
    let cleanupRequired = false;
    try { await discard(); } catch { cleanupRequired = true; }
    throw new DispatchBackupError(phase, options.signal?.aborted === true, serverChunksMayExist,
      sealMayHaveSucceeded, cleanupRequired, error instanceof DispatchBackupLimitError);
  } finally {
    passphrase = '';
    options.signal?.removeEventListener('abort', cancel);
  }
}

// Authenticate the complete single volume (including EOF) before staging; this never applies business data.
export async function importDispatchVolume(
  input: unknown, encrypted: TransferByteSource, passphrase: string, expectedMetadata: TransferMetadata,
  temporary: ReplacementBackupTemporaryFiles, target: DispatchImportTarget, options: DispatchImportOptions = {},
): Promise<DispatchImportResult> {
  let cleanup: Promise<void> | undefined;
  let stagingMayExist = false;
  const discard = () => cleanup ??= Promise.resolve().then(() => temporary.abort(new Error('Dispatch import plaintext discarded.')));
  let outcome: { result: DispatchImportResult } | { error: unknown };
  try {
    checkAbort(options.signal);
    const catalog = validateDispatchCatalog(input);
    const manifest = await verifyEncryptedVolume(encrypted, passphrase, {
      append: (path, chunk, signal) => temporary.append(path, chunk, signal), abort: discard,
    }, { signal: options.signal, expectedMetadata, limits: DISPATCH_IMPORT_CONTAINER_LIMITS });
    validateDispatchManifest(manifest, catalog);
    const result = await stageDispatchImport(catalog, temporary, {
      begin(value, signal) { stagingMayExist = true; return target.begin(value, signal); },
      stage: (key, chunkNo, ndjson, signal) => target.stage(key, chunkNo, ndjson, signal),
      dryRun: signal => target.dryRun(signal),
    }, options);
    outcome = { result };
  } catch (error) { outcome = { error }; }
  finally { passphrase = ''; }
  try { await discard(); } catch { throw new DispatchImportCleanupError(stagingMayExist); }
  if ('error' in outcome) {
    if (outcome.error instanceof DispatchImportStagingMayExistError) throw outcome.error;
    checkAbort(options.signal);
    throw new Error('Dispatch encrypted package validation failed before server staging began.');
  }
  return outcome.result;
}
