import { MAX_CONTAINER_INPUT_BYTES, writeEncryptedVolume, verifyEncryptedVolume, type TransferEntry } from './container';
import type { TransferByteSource, TransferByteStream, TransferMetadata } from './crypto';
import type { VolumeInfo } from './manifest';
import type {
  ReplacementBackupFile, ReplacementBackupTemporaryFiles, ReplacementBackupReceiver,
  ReplacementBackupOptions, ReplacementBackupPhase,
} from './replacementBackup';
import { Sha256 } from './sha256';
import {
  exportProducts, validateProductExportCatalog, validateProductManifest, productTransferChecks,
  PRODUCT_CONTAINER_LIMITS, stageProductsImport, ProductTransferCleanupError, ProductImportStagingMayExistError,
  type ProductExportCatalog, type ProductExportSource, type ProductImportTarget, type ProductImportResult,
  type ProductTransferOptions,
} from './productTransfer';

export const MAX_PRODUCT_BACKUP_BYTES = 9 * 1024 * 1024;
export const PRODUCT_BACKUP_CHUNK_BYTES = 128 * 1024;
export interface ProductBackupDescriptor {
  backup_id: string; plan_hash: string; target_hash: string; catalog: ProductExportCatalog;
}
export interface ProductBackupResult {
  descriptor: ProductBackupDescriptor; cipherSha256: string; bytes: number; chunks: number;
  sealReceipt: { success: true; backup_id: string; sha256: string; bytes: number;
    repeated: boolean; full_site_complete: false };
}
export class ProductBackupError extends Error {
  constructor(
    readonly phase: ReplacementBackupPhase, readonly cancelled: boolean,
    readonly serverChunksMayExist: boolean, readonly sealMayHaveSucceeded: boolean,
    readonly cleanupRequired: boolean,
  ) {
    super(`Product backup stopped during ${phase}. Keep and check the independent encrypted file; server ciphertext or the seal outcome may be uncertain. Reconcile the server before retrying. No automatic retry, apply or close was performed.${cleanupRequired ? ' Temporary plaintext cleanup was not confirmed; do not reuse the workspace.' : ''}`);
    this.name = 'ProductBackupError';
  }
}
// Authenticate the entire encrypted ZIP and its single-table manifest before even sending begin.
export async function importProductsVolume(
  input: unknown, encrypted: TransferByteSource, passphrase: string, expectedMetadata: TransferMetadata,
  temporary: ReplacementBackupTemporaryFiles, target: ProductImportTarget, options: ProductTransferOptions = {},
): Promise<ProductImportResult> {
  let cleanup: Promise<void> | undefined;
  let stagingMayExist = false;
  const discard = () => cleanup ??= Promise.resolve().then(() => temporary.abort(new Error('Product import plaintext discarded.')));
  let outcome: { result: ProductImportResult } | { error: unknown };
  try {
    const catalog = validateProductExportCatalog(input);
    const manifest = await verifyEncryptedVolume(encrypted, passphrase, {
      append: (path, chunk, signal) => temporary.append(path, chunk, signal), abort: discard,
    }, { signal: options.signal, expectedMetadata, limits: PRODUCT_CONTAINER_LIMITS });
    validateProductManifest(manifest, catalog);
    const result = await stageProductsImport(catalog, temporary, {
      begin(value, signal) { stagingMayExist = true; return target.begin(value, signal); },
      stage: (chunkNo, ndjson, signal) => target.stage(chunkNo, ndjson, signal),
      dryRun: signal => target.dryRun(signal),
    }, options);
    outcome = { result };
  } catch (error) { outcome = { error }; }
  finally { passphrase = ''; }
  try { await discard(); } catch { throw new ProductTransferCleanupError(stagingMayExist); }
  if ('error' in outcome) {
    if (outcome.error instanceof ProductImportStagingMayExistError) throw outcome.error;
    checkAbort(options.signal);
    throw new Error('Product encrypted package validation failed before server staging began.');
  }
  return outcome.result;
}
const { object, uuid, hash, checkAbort, withSignal } = productTransferChecks;
function invalid(): never { throw new Error('Invalid product backup.'); }
export function validateProductBackupDescriptor(value: unknown): ProductBackupDescriptor {
  const record = object(value, ['backup_id', 'plan_hash', 'target_hash', 'catalog']);
  return { backup_id: uuid(record.backup_id), plan_hash: hash(record.plan_hash), target_hash: hash(record.target_hash),
    catalog: validateProductExportCatalog(record.catalog) };
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
        if (this.bytes > MAX_PRODUCT_BACKUP_BYTES) invalid();
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
export async function createProductBackup(
  descriptor: ProductBackupDescriptor, source: ProductExportSource,
  temporary: ReplacementBackupTemporaryFiles, file: ReplacementBackupFile, receiver: ReplacementBackupReceiver,
  passphrase: string, options: ReplacementBackupOptions = {},
): Promise<ProductBackupResult> {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let phase: ReplacementBackupPhase = 'snapshot';
  let serverChunksMayExist = false, sealMayHaveSucceeded = false;
  let cleanup: Promise<void> | undefined;
  const discard = () => cleanup ??= Promise.resolve().then(() => temporary.abort(new Error('Product backup plaintext discarded.')));
  const progress = (bytes: number, completed = false) => {
    checkAbort(signal); options.onProgress?.({ phase, bytes, completed }); checkAbort(signal);
  };
  try {
    checkAbort(signal);
    const frozen = validateProductBackupDescriptor(descriptor);
    progress(0);
    const snapshot = await exportProducts({
      async catalog(readSignal) {
        const catalog = validateProductExportCatalog(await source.catalog(readSignal));
        if (JSON.stringify(catalog) !== JSON.stringify(frozen.catalog)) invalid();
        return catalog;
      },
      page: (after, readSignal) => source.page(after, readSignal),
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
      { signal, limits: PRODUCT_CONTAINER_LIMITS }), signal);
    try { await withSignal(() => file.write(encrypted, signal), signal); } finally { close(encrypted); }
    checkAbort(signal);
    const cipherSha256 = written.digest();
    progress(written.bytes, true);
    await discard(); // A durable, independent ciphertext file is now the only file allowed to survive.
    checkAbort(signal);

    phase = 'verify'; progress(0);
    const verified = new CipherScan();
    const saved = verified.read(file.open(), signal);
    let manifest;
    try {
      manifest = await verifyEncryptedVolume(saved, passphrase, { async append() {}, async abort() {} },
        { signal, limits: PRODUCT_CONTAINER_LIMITS, expectedMetadata: { exportId: info.exportId, volumeId: info.volumeId } });
    } finally { close(saved); }
    validateProductManifest(manifest, frozen.catalog);
    if (manifest.exportId !== info.exportId || manifest.volumeId !== info.volumeId || manifest.createdAt !== info.createdAt
      || verified.digest() !== cipherSha256 || verified.bytes !== written.bytes) invalid();
    progress(verified.bytes, true);

    phase = 'upload'; progress(0);
    const uploaded = new CipherScan();
    const upload = uploaded.read(file.open(), signal);
    const page = new Uint8Array(PRODUCT_BACKUP_CHUNK_BYTES);
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
    const sealReceipt: ProductBackupResult['sealReceipt'] = { success: true, backup_id: frozen.backup_id,
      sha256: cipherSha256, bytes: written.bytes, repeated: receipt.repeated, full_site_complete: false };
    try { options.onProgress?.({ phase, bytes: written.bytes, completed: true }); } catch { /* A terminal observer cannot revoke an acknowledged seal. */ }
    return { descriptor: structuredClone(frozen), cipherSha256, bytes: written.bytes, chunks, sealReceipt };
  } catch {
    controller.abort();
    let cleanupRequired = false;
    try { await discard(); } catch { cleanupRequired = true; }
    throw new ProductBackupError(phase, options.signal?.aborted === true, serverChunksMayExist, sealMayHaveSucceeded, cleanupRequired);
  } finally {
    passphrase = '';
    options.signal?.removeEventListener('abort', cancel);
  }
}
