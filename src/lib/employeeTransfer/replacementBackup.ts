import {
  MAX_CONTAINER_INPUT_BYTES, writeEncryptedVolume, verifyEncryptedVolume,
  type ContainerLimits, type TemporaryTransferSink, type TransferEntry,
} from './container';
import type { TransferByteSource, TransferByteStream } from './crypto';
import type { VolumeInfo, VolumeManifest } from './manifest';
import { Sha256 } from './sha256';
import {
  SHARED_TABLE_KEYS, exportSharedSettings, validateSharedExportCatalog,
  type SharedExportCatalog, type SharedExportSource,
} from './sharedExport';

export const MAX_REPLACEMENT_BACKUP_BYTES = 9 * 1024 * 1024;
export const REPLACEMENT_BACKUP_PAGE_BYTES = 128 * 1024;

export interface ReplacementBackupDescriptor {
  backup_id: string;
  plan_hash: string;
  target_hash: string;
  catalog: SharedExportCatalog;
}
export interface ReplacementBackupTemporaryFiles extends TemporaryTransferSink {
  // Caller owns an isolated workspace; open must reopen immutable bytes.
  open(path: string): TransferByteSource;
}
export interface ReplacementBackupFile {
  // Resolve only after consuming EOF and durably saving an independent file.
  write(source: TransferByteSource, signal?: AbortSignal): Promise<void>;
  open(): TransferByteSource;
}
export interface ReplacementBackupReceiver {
  // Receiver is already bound server-side to this descriptor; numbering starts at zero.
  append(chunkNo: number, hex: string, signal?: AbortSignal): Promise<{
    success: true; bytes: number; sha256: string; repeated: boolean;
  }>;
  seal(cipherSha256: string, bytes: number, signal?: AbortSignal): Promise<unknown>;
}
export type ReplacementBackupPhase = 'snapshot' | 'save' | 'verify' | 'upload' | 'seal';
export interface ReplacementBackupProgress {
  phase: ReplacementBackupPhase;
  bytes: number;
  completed: boolean;
}
export interface ReplacementBackupOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ReplacementBackupProgress) => void;
}
export interface ReplacementBackupResult {
  descriptor: ReplacementBackupDescriptor;
  cipherSha256: string;
  bytes: number;
  chunks: number;
  sealReceipt: unknown;
}
export class ReplacementBackupError extends Error {
  constructor(
    readonly phase: ReplacementBackupPhase,
    readonly cancelled: boolean,
    readonly serverChunksMayExist: boolean,
    readonly sealMayHaveSucceeded: boolean,
    readonly cleanupRequired: boolean,
  ) {
    super(`Replacement backup stopped during ${phase}. Server ciphertext chunks may already exist; reconcile server state before retrying. Keep and check the independent local encrypted file (it may be incomplete). No automatic retry or apply was performed.${sealMayHaveSucceeded ? ' Seal outcome may be unknown; check the server receipt.' : ''}${cleanupRequired ? ' Temporary plaintext cleanup was not confirmed; do not reuse the workspace.' : ''}`);
    this.name = 'ReplacementBackupError';
  }
}

const limits: Partial<ContainerLimits> = {
  maxEntries: 7, maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024,
  maxZipBytes: MAX_REPLACEMENT_BACKUP_BYTES, maxManifestBytes: 16 * 1024, maxLineBytes: 64 * 1024,
};
function invalid(): never { throw new Error('Replacement backup validation failed.'); }
function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Replacement backup cancelled.', 'AbortError');
}
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
function descriptorFor(value: ReplacementBackupDescriptor): ReplacementBackupDescriptor {
  const record = object(value, ['backup_id', 'plan_hash', 'target_hash', 'catalog']);
  if (typeof record.backup_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.backup_id)
    || typeof record.plan_hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.plan_hash)
    || typeof record.target_hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.target_hash)) invalid();
  return { backup_id: record.backup_id, plan_hash: record.plan_hash, target_hash: record.target_hash,
    catalog: validateSharedExportCatalog(record.catalog) };
}
function matchCatalog(actual: SharedExportCatalog, expected: SharedExportCatalog): void {
  if (actual.site_id !== expected.site_id
    || actual.excluded_system_keys.length !== expected.excluded_system_keys.length
    || actual.excluded_system_keys.some(key => !expected.excluded_system_keys.includes(key))) invalid();
  for (const table of expected.tables) {
    const found = actual.tables.find(entry => entry.key === table.key);
    if (!found || found.bytes !== table.bytes || found.rows !== table.rows || found.sha256 !== table.sha256) invalid();
  }
}
function matchManifest(manifest: VolumeManifest, info: VolumeInfo, catalog: SharedExportCatalog): void {
  if (manifest.scope !== 'replacement-backup' || manifest.exportId !== info.exportId
    || manifest.volumeId !== info.volumeId || manifest.sourceSiteId !== info.sourceSiteId
    || manifest.createdAt !== info.createdAt || manifest.volumeIndex !== 1 || manifest.volumeCount !== 1
    || manifest.entries.length !== SHARED_TABLE_KEYS.length) invalid();
  for (const table of catalog.tables) {
    const entry = manifest.entries.find(entry => entry.path === `data/shared-${table.key}.ndjson`);
    if (!entry || entry.kind !== 'ndjson' || entry.bytes !== table.bytes || entry.sha256 !== table.sha256) invalid();
  }
}
async function withSignal<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new DOMException('Replacement backup cancelled.', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { checkAbort(signal); return operation(); }).then(
      value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); },
    );
  });
}
function close(iterator: AsyncIterator<Uint8Array>): void {
  try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Best-effort read closure. */ }
}
class CipherScan {
  bytes = 0;
  ended = false;
  readonly hash = new Sha256();

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
        if (this.bytes > MAX_REPLACEMENT_BACKUP_BYTES) invalid();
        const chunk = new Uint8Array(next.value);
        this.hash.update(chunk);
        if (chunk.length) yield chunk;
      }
    } finally { if (!this.ended) close(iterator); }
  }
  digest(): string {
    if (!this.ended || this.bytes === 0) invalid();
    return this.hash.digestHex();
  }
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function createReplacementBackup(
  descriptor: ReplacementBackupDescriptor,
  source: SharedExportSource,
  temporary: ReplacementBackupTemporaryFiles,
  file: ReplacementBackupFile,
  receiver: ReplacementBackupReceiver,
  passphrase: string,
  options: ReplacementBackupOptions = {},
): Promise<ReplacementBackupResult> {
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  let phase: ReplacementBackupPhase = 'snapshot';
  let serverChunksMayExist = false;
  let sealMayHaveSucceeded = false;
  let cleanup: Promise<void> | undefined;
  const discard = (): Promise<void> => {
    cleanup ??= Promise.resolve().then(() => temporary.abort(new Error('Replacement backup plaintext discarded.')));
    return cleanup;
  };
  const progress = (bytes: number, completed = false) => {
    checkAbort(signal);
    options.onProgress?.({ phase, bytes, completed });
    checkAbort(signal);
  };
  const workspace: TemporaryTransferSink = {
    append: (path, chunk, writeSignal) => temporary.append(path, chunk, writeSignal), abort: discard,
  };
  try {
    checkAbort(signal);
    const frozen = descriptorFor(descriptor);
    progress(0);
    const snapshot = await exportSharedSettings({
      async catalog(readSignal) {
        const catalog = validateSharedExportCatalog(await source.catalog(readSignal));
        matchCatalog(catalog, frozen.catalog);
        return catalog;
      },
      page: (key, after, readSignal) => source.page(key, after, readSignal),
      verify: readSignal => source.verify(readSignal),
    }, workspace, { signal, onProgress: value => progress(value.bytes) });
    progress(snapshot.bytes, true);
    const info: VolumeInfo = {
      scope: 'replacement-backup', exportId: frozen.backup_id, volumeId: frozen.backup_id,
      sourceSiteId: frozen.catalog.site_id, volumeIndex: 1, volumeCount: 1, createdAt: new Date().toISOString(),
    };
    async function* entries(): AsyncGenerator<TransferEntry> {
      for (const entry of snapshot.entries) {
        yield { path: entry.path, bytes: entry.bytes, open: () => temporary.open(entry.path) };
      }
    }
    phase = 'save';
    progress(0);
    const written = new CipherScan();
    const encrypted = written.read(writeEncryptedVolume(entries(), info, passphrase, { signal, limits }), signal);
    try { await withSignal(() => file.write(encrypted, signal), signal); }
    finally { close(encrypted); }
    checkAbort(signal);
    const cipherSha256 = written.digest();
    progress(written.bytes, true);
    // Plaintext is no longer needed; the saved file must stand on its own.
    await discard();
    checkAbort(signal);

    phase = 'verify';
    progress(0);
    const verified = new CipherScan();
    const saved = verified.read(file.open(), signal);
    let manifest: VolumeManifest;
    try {
      manifest = await verifyEncryptedVolume(saved, passphrase, {
        async append() {}, async abort() {},
      }, { signal, limits, expectedMetadata: { exportId: info.exportId, volumeId: info.volumeId } });
    } finally { close(saved); }
    checkAbort(signal);
    matchManifest(manifest, info, frozen.catalog);
    if (verified.digest() !== cipherSha256 || verified.bytes !== written.bytes) invalid();
    progress(verified.bytes, true);

    phase = 'upload';
    progress(0);
    const uploaded = new CipherScan();
    const upload = uploaded.read(file.open(), signal);
    const page = new Uint8Array(REPLACEMENT_BACKUP_PAGE_BYTES);
    let used = 0;
    let chunks = 0;
    let confirmedBytes = 0;
    const append = async () => {
      const bytes = page.subarray(0, used);
      const sha256 = new Sha256().update(bytes).digestHex();
      const encoded = hex(bytes);
      const ack = object(await withSignal(() => {
        serverChunksMayExist = true;
        return receiver.append(chunks, encoded, signal);
      }, signal), ['success', 'bytes', 'sha256', 'repeated']);
      checkAbort(signal);
      if (ack.success !== true || ack.bytes !== used || ack.sha256 !== sha256 || typeof ack.repeated !== 'boolean') invalid();
      confirmedBytes += used;
      chunks++;
      used = 0;
      progress(confirmedBytes);
    };
    try {
      for await (const chunk of upload) {
        let offset = 0;
        while (offset < chunk.length) {
          const take = Math.min(page.length - used, chunk.length - offset);
          page.set(chunk.subarray(offset, offset + take), used);
          offset += take;
          used += take;
          if (used === page.length) await append();
        }
      }
      if (used) await append();
    } finally { close(upload); }
    if (uploaded.digest() !== cipherSha256 || uploaded.bytes !== written.bytes
      || uploaded.hash.digestHex() !== verified.hash.digestHex() || confirmedBytes !== written.bytes) invalid();
    progress(confirmedBytes, true);
    phase = 'seal';
    progress(0);
    const sealReceipt = await withSignal(() => {
      sealMayHaveSucceeded = true;
      return receiver.seal(cipherSha256, written.bytes, signal);
    }, signal);
    checkAbort(signal);
    // A terminal observer cannot turn an acknowledged seal into a reported failure.
    try { options.onProgress?.({ phase, bytes: written.bytes, completed: true }); } catch { /* Observer only. */ }
    return { descriptor: frozen, cipherSha256, bytes: written.bytes, chunks, sealReceipt };
  } catch {
    const cancelled = options.signal?.aborted === true;
    controller.abort();
    let cleanupRequired = false;
    try { await discard(); } catch { cleanupRequired = true; }
    throw new ReplacementBackupError(phase, cancelled, serverChunksMayExist, sealMayHaveSucceeded, cleanupRequired);
  } finally {
    passphrase = '';
    options.signal?.removeEventListener('abort', cancel);
  }
}
