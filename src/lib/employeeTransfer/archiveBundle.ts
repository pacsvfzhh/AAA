import {
  MAX_CONTAINER_INPUT_BYTES, verifyEncryptedVolume, writeEncryptedVolume,
  type ContainerLimits, type TemporaryTransferSink, type TransferEntry,
} from './container';
import type { TransferByteSource, TransferMetadata } from './crypto';
import { validateTransferMetadata, validateVolumeInfo, type ManifestEntry, type VolumeInfo, type VolumeManifest } from './manifest';
import type { ReplacementBackupFile } from './replacementBackup';
import type { ArchivesImportSession, ArchivesRestoreSession } from './archiveApi';
import {
  ARCHIVES_TABLE_KEYS, ARCHIVES_TRANSFER_LIMITS, archivesEntryPath, exportArchivesData, stageArchivesImport,
  validateArchivesBind, validateArchivesCatalog, validateArchivesRow, validateArchivesStage, validateArchivesStatus, validateArchivesVerification,
  type ArchivesCatalog, type ArchivesExportSource, type ArchivesStatus, type ArchivesTableKey,
} from './archiveTransfer';
import {
  validateArchiveMediaFile, validateArchiveMediaInventory,
  type ArchiveMediaFile, type ArchiveMediaInventory, type ArchiveMediaReference, type ArchiveMediaSession,
} from './archiveMedia';
import { dispatchTransferChecks } from './dispatchTransfer';
import { Sha256 } from './sha256';

// Native SQL33 six-table archives only, NOT namespace re-export or a full-site package.
export const ARCHIVE_BUNDLE_PROTOCOL = 'site-archives-bundle-v1';
export const ARCHIVE_BUNDLE_MEDIA_PATH = 'data/archive-media.ndjson';
export const ARCHIVE_BUNDLE_CATALOG_PATH = 'data/archive-catalog.ndjson';
export const ARCHIVE_BUNDLE_LIMITS = Object.freeze({
  maxTotalBytes: 1024 * 1024 * 1024, maxFiles: 3000, maxEntries: 3008,
  maxCatalogBytes: 8192, maxDirectoryBytes: 2 * 1024 * 1024,
});
export interface ArchiveBundleWorkspace extends TemporaryTransferSink {
  // Fresh isolated storage, immutable reopening; abort invalidates even pending appends.
  open(path: string): TransferByteSource;
}
// Export needs two fresh workspaces: snapshot, then independent saved-file readback.
export type ArchiveBundleWorkspaceFactory = () => ArchiveBundleWorkspace;
export interface ArchiveBundleImportTarget {
  records: ArchivesImportSession;
  restore: ArchivesRestoreSession;
  media: ArchiveMediaSession;
}
export type ArchiveBundlePhase = 'records-export' | 'media-download' | 'source-recheck' | 'save'
  | 'authenticate' | 'validate' | 'stage' | 'restore' | 'media-upload' | 'target-recheck';
export type ArchiveBundleFileState = 'not-written' | 'unknown' | 'saved' | 'verified';
export interface ArchiveBundleProgress {
  scope: 'site-archives-bundle'; phase: ArchiveBundlePhase;
  // Phase-local actual rows/files/bytes, not a percentage or a full-site estimate.
  rows: number; files: number; bytes: number; fullSiteComplete: false;
}
export interface ArchiveBundleOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ArchiveBundleProgress) => void;
  // Optional tighter bounds only. Payload bytes include both metadata NDJSON entries.
  limits?: { maxTotalBytes?: number; maxFiles?: number };
}
export interface ArchiveBundleResult {
  scope: 'site-archives-bundle'; catalog: ArchivesCatalog; manifest: VolumeManifest;
  rows: number; files: number; bytes: number; cipherBytes: number; cipherSha256: string;
  recordsVerified: true; mediaVerified: true; fullSiteComplete: false;
}
export class ArchiveBundleError extends Error {
  constructor(
    readonly phase: ArchiveBundlePhase, readonly cancelled: boolean, readonly outcomeUnknown: boolean,
    readonly encryptedFileState: ArchiveBundleFileState, readonly serverWritesMayExist: boolean,
    readonly recordsVerified: boolean, readonly mediaVerified: boolean, readonly cleanupRequired: boolean,
  ) {
    super('Archive bundle stopped. Keep the independent encrypted file, including incomplete or unconfirmed writes. '
      + 'Reconcile unknown disk writes and server session status explicitly before resuming. '
      + 'No automatic retry, delete, rollback, job close, activation, maintenance release or full-site completion.'
      + (cleanupRequired ? ' Temporary plaintext cleanup was not confirmed; do not reuse the workspace.' : ''));
    this.name = 'ArchiveBundleError';
  }
}
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const { checkAbort, withSignal, count } = dispatchTransferChecks;
const sha = (bytes: Uint8Array) => new Sha256().update(bytes).digestHex();
const mediaPath = (file: ArchiveMediaFile) => `media/content-audit-evidence/${file.key}`;
function invalid(): never { throw new Error('Invalid archive bundle.'); }
function same(a: unknown, b: unknown): void {
  const stable = (value: unknown) => JSON.stringify(value, (_, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
    }
    return item;
  });
  if (stable(a) !== stable(b)) invalid();
}
function bounds(options: ArchiveBundleOptions) {
  const maxTotalBytes = options.limits?.maxTotalBytes ?? ARCHIVE_BUNDLE_LIMITS.maxTotalBytes;
  const maxFiles = options.limits?.maxFiles ?? ARCHIVE_BUNDLE_LIMITS.maxFiles;
  if (count(maxTotalBytes, ARCHIVE_BUNDLE_LIMITS.maxTotalBytes) === 0) invalid();
  count(maxFiles, ARCHIVE_BUNDLE_LIMITS.maxFiles);
  const container: Partial<ContainerLimits> = {
    maxEntries: 8 + maxFiles, maxTotalBytes, maxEntryBytes: ARCHIVES_TRANSFER_LIMITS.maxTableBytes,
    maxLineBytes: ARCHIVES_TRANSFER_LIMITS.maxLineBytes,
  };
  return { maxTotalBytes, maxFiles, container };
}

class Run {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  phase: ArchiveBundlePhase = 'authenticate';
  fileState: ArchiveBundleFileState = 'not-written';
  unknown = false;
  writes = false;
  recordsVerified = false;
  mediaVerified = false;
  private readonly spaces: { workspace: ArchiveBundleWorkspace; cleanup?: Promise<void> }[] = [];
  private readonly cancel = () => this.controller.abort();
  constructor(readonly options: ArchiveBundleOptions, private readonly factory: ArchiveBundleWorkspaceFactory) {
    options.signal?.addEventListener('abort', this.cancel, { once: true });
    if (options.signal?.aborted) this.cancel();
  }
  workspace(): ArchiveBundleWorkspace {
    checkAbort(this.signal);
    const workspace = this.factory();
    if (this.spaces.some(item => item.workspace === workspace)) invalid();
    const item: { workspace: ArchiveBundleWorkspace; cleanup?: Promise<void> } = { workspace };
    this.spaces.push(item);
    return {
      open: path => workspace.open(path),
      append: (path, bytes, signal) => workspace.append(path, bytes, signal),
      abort: reason => item.cleanup ??= Promise.resolve().then(() => workspace.abort(reason)),
    };
  }
  progress(rows: number, files: number, bytes: number): void {
    checkAbort(this.signal);
    this.options.onProgress?.({ scope: 'site-archives-bundle', phase: this.phase, rows, files, bytes, fullSiteComplete: false });
    checkAbort(this.signal);
  }
  async write<T>(operation: () => Promise<T>): Promise<T> {
    return withSignal(async () => {
      this.writes = true; this.unknown = true;
      const result = await operation();
      checkAbort(this.signal); this.unknown = false;
      return result;
    }, this.signal);
  }
  async finish<T>(operation: () => Promise<T>): Promise<T> {
    let result: T | undefined, failed = false, cleanupRequired = false;
    try { result = await operation(); checkAbort(this.signal); }
    catch { failed = true; this.controller.abort(); }
    finally {
      try {
        // Cleanup is awaited even after success; cancellation during cleanup is not success.
        for (const item of this.spaces) {
          item.cleanup ??= Promise.resolve().then(() => item.workspace.abort(new Error('Archive bundle plaintext discarded.')));
          try { await item.cleanup; } catch { cleanupRequired = true; }
        }
      } finally { this.options.signal?.removeEventListener('abort', this.cancel); }
    }
    if (failed || cleanupRequired || this.signal.aborted) {
      throw new ArchiveBundleError(this.phase, this.options.signal?.aborted === true, this.unknown,
        this.fileState, this.writes, this.recordsVerified, this.mediaVerified, cleanupRequired);
    }
    return result!;
  }
}
async function* read(source: TransferByteSource, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') invalid();
  const iterator = source[Symbol.asyncIterator]();
  let ended = false;
  try {
    while (true) {
      const next = await withSignal(() => iterator.next(), signal);
      checkAbort(signal);
      if (next.done) { ended = true; return; }
      if (!(next.value instanceof Uint8Array) || next.value.length > MAX_CONTAINER_INPUT_BYTES) invalid();
      yield new Uint8Array(next.value);
    }
  } finally {
    if (!ended) {
      try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Do not wait for a blocked producer. */ }
    }
  }
}
async function* lines(source: TransferByteSource, maximum: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const buffer = new Uint8Array(ARCHIVES_TRANSFER_LIMITS.maxLineBytes);
  let used = 0, bytes = 0;
  for await (const chunk of read(source, signal)) {
    bytes += chunk.length;
    if (bytes > maximum) invalid();
    let start = 0;
    while (start < chunk.length) {
      const lf = chunk.indexOf(10, start), end = lf < 0 ? chunk.length : lf + 1;
      if (used + end - start > buffer.length) invalid();
      buffer.set(chunk.subarray(start, end), used); used += end - start; start = end;
      if (lf >= 0) { yield buffer.slice(0, used); used = 0; }
    }
  }
  if (used) invalid();
}
async function small(workspace: ArchiveBundleWorkspace, path: string, maximum: number, signal: AbortSignal): Promise<string> {
  const buffer = new Uint8Array(maximum);
  let used = 0;
  for await (const chunk of read(workspace.open(path), signal)) {
    if (used + chunk.length > maximum) invalid();
    buffer.set(chunk, used); used += chunk.length;
  }
  return dec.decode(buffer.subarray(0, used));
}
function canonicalCatalog(text: string): ArchivesCatalog {
  const catalog = validateArchivesCatalog(JSON.parse(text));
  if (text !== JSON.stringify(catalog) + '\n') invalid();
  return catalog;
}
function references(raw: Uint8Array, catalog: ArchivesCatalog): ArchiveMediaReference[] {
  // Only parse to inspect references. The original row (including LF) is hashed and never reserialized.
  const row = JSON.parse(dec.decode(raw)) as Record<string, unknown>;
  const refs = row.media_refs;
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) invalid();
  const entries = Object.entries(refs);
  if (row.cleared_at !== null && entries.length) invalid();
  return entries.map(([ref_key, ref_value]) => {
    if (!ref_key || enc.encode(ref_key).length > 4096 || [...ref_key].some(char => {
      const code = char.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159);
    })
      || typeof ref_value !== 'string' || !ref_value || enc.encode(ref_value).length > 512
      || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(ref_value) || ref_value.includes('..')) invalid();
    const source_line_sha256 = sha(raw);
    const source_url = `archive-evidence-v1:${catalog.site_id}:${catalog.package_id}:${row.id}:${source_line_sha256}:${sha(enc.encode(ref_key))}:${sha(enc.encode(ref_value))}`;
    return { key: sha(enc.encode(source_url)), source_url, event_id: row.id as string, source_line_sha256,
      ref_key, ref_value, path: ref_value, bucket: 'content-audit-evidence', file: null };
  });
}
async function scanRecords(workspace: ArchiveBundleWorkspace, catalog: ArchivesCatalog, entries: readonly ManifestEntry[], run: Run): Promise<ArchiveMediaReference[]> {
  const refs: ArchiveMediaReference[] = [];
  let rows = 0, bytes = 0;
  for (const [index, table] of catalog.tables.entries()) {
    const digest = new Sha256(), rowHashes = new Sha256();
    let n = 0, size = 0, last: string | null = null;
    for await (const raw of lines(workspace.open(archivesEntryPath(table.key)), table.bytes, run.signal)) {
      const id = validateArchivesRow(dec.decode(raw), table.key);
      if ((last !== null && id <= last) || ++n > table.rows) invalid();
      last = id; size += raw.length; digest.update(raw); rowHashes.update(enc.encode(sha(raw)));
      if (table.key === 'content_audit_events') {
        refs.push(...references(raw, catalog));
        if (refs.length > bounds(run.options).maxFiles) invalid();
      }
    }
    if (n !== table.rows || size !== table.bytes || rowHashes.digestHex() !== table.row_hashes_sha256
      || digest.digestHex() !== entries[index]?.sha256) invalid();
    rows += n; bytes += size; run.progress(rows, 0, bytes);
  }
  refs.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return validateArchiveMediaInventory({ version: 1, scope: 'site-archives-media', direction: 'export',
    archives_catalog: catalog, files: refs, bound: true, verified: false, transferred: [], checked: [], full_site_complete: false }, 'export').files;
}
function matchInventory(input: ArchiveMediaInventory, direction: 'export' | 'import', catalog: ArchivesCatalog,
  refs: readonly ArchiveMediaReference[], files?: readonly ArchiveMediaFile[], verified = false): ArchiveMediaInventory {
  const inventory = validateArchiveMediaInventory(input, direction);
  same(inventory.archives_catalog, catalog);
  same(inventory.files.map(ref => ({ ...ref, file: null })), refs);
  if (verified && (!inventory.verified || !inventory.bound || inventory.transferred.length !== refs.length
    || inventory.checked.length !== refs.length)) invalid();
  if (files) for (const [index, ref] of inventory.files.entries()) {
    if (ref.file !== null) same(ref.file, files[index]);
    else if (verified) invalid();
  }
  return inventory;
}
function detect(bytes: Uint8Array): ArchiveMediaFile['content_type'] {
  const starts = (prefix: number[], at = 0) => prefix.every((value, index) => bytes[index + at] === value);
  if (bytes.length >= 8 && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (bytes.length >= 3 && starts([255, 216, 255])) return 'image/jpeg';
  if (bytes.length >= 6 && (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))) return 'image/gif';
  if (bytes.length >= 12 && starts([82, 73, 70, 70]) && starts([87, 69, 66, 80], 8)) return 'image/webp';
  if (bytes.length >= 16 && starts([102, 116, 121, 112], 4)) {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size >= 16 && size <= bytes.length && (size - 16) % 4 === 0) {
      for (let i = 8; i < size; i += i === 8 ? 8 : 4) {
        if (['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ']
          .includes(String.fromCharCode(...bytes.subarray(i, i + 4)))) return 'video/mp4';
      }
    }
  }
  return invalid(); // Magic signatures only; not decoding or malware scanning.
}
function inspect(file: ArchiveMediaFile, bytes: Uint8Array): void {
  if (bytes.length !== file.bytes || sha(bytes) !== file.sha256 || detect(bytes) !== file.content_type) invalid();
}
async function mediaBytes(workspace: ArchiveBundleWorkspace, file: ArchiveMediaFile, signal: AbortSignal): Promise<Uint8Array> {
  const bytes = new Uint8Array(file.bytes);
  let used = 0;
  try {
    for await (const chunk of read(workspace.open(mediaPath(file)), signal)) {
      if (used + chunk.length > bytes.length) invalid();
      bytes.set(chunk, used); used += chunk.length;
    }
    if (used !== bytes.length) invalid();
    inspect(file, bytes); return bytes;
  } catch (error) { bytes.fill(0); throw error; }
}
function matchManifest(manifest: VolumeManifest, catalog: ArchivesCatalog, files: readonly ArchiveMediaFile[], run: Run): void {
  if (manifest.scope !== 'replacement-backup' || manifest.exportId !== catalog.package_id || manifest.sourceSiteId !== catalog.site_id
    || manifest.volumeIndex !== 1 || manifest.volumeCount !== 1 || manifest.entries.length !== 8 + files.length) invalid();
  const expected = [...ARCHIVES_TABLE_KEYS.map(archivesEntryPath), ARCHIVE_BUNDLE_MEDIA_PATH, ARCHIVE_BUNDLE_CATALOG_PATH, ...files.map(mediaPath)];
  for (const [index, entry] of manifest.entries.entries()) {
    if (entry.path !== expected[index] || entry.kind !== (index < 8 ? 'ndjson' : 'media')) invalid();
    if (index < 6 && entry.bytes !== catalog.tables[index].bytes) invalid();
    if (index >= 8 && (entry.bytes !== files[index - 8].bytes || entry.sha256 !== files[index - 8].sha256)) invalid();
  }
  if (manifest.entries.reduce((n, entry) => n + entry.bytes, 0) > bounds(run.options).maxTotalBytes) invalid();
}
async function validateBundle(workspace: ArchiveBundleWorkspace, manifest: VolumeManifest, run: Run) {
  run.phase = 'validate';
  const catalogText = await small(workspace, ARCHIVE_BUNDLE_CATALOG_PATH, ARCHIVE_BUNDLE_LIMITS.maxCatalogBytes, run.signal);
  const catalog = canonicalCatalog(catalogText);
  const directory = await small(workspace, ARCHIVE_BUNDLE_MEDIA_PATH, ARCHIVE_BUNDLE_LIMITS.maxDirectoryBytes, run.signal);
  const files: ArchiveMediaFile[] = [];
  if (directory && !directory.endsWith('\n')) invalid();
  for (const line of directory === '' ? [] : directory.slice(0, -1).split('\n')) {
    const file = validateArchiveMediaFile(JSON.parse(line));
    if (line !== JSON.stringify(file) || (files.length && files[files.length - 1].key >= file.key)) invalid();
    files.push(file);
    if (files.length > bounds(run.options).maxFiles) invalid();
  }
  matchManifest(manifest, catalog, files, run);
  if (manifest.entries[6].bytes !== enc.encode(directory).length || manifest.entries[6].sha256 !== sha(enc.encode(directory))
    || manifest.entries[7].bytes !== enc.encode(catalogText).length || manifest.entries[7].sha256 !== sha(enc.encode(catalogText))) invalid();
  const refs = await scanRecords(workspace, catalog, manifest.entries, run);
  if (refs.length !== files.length) invalid();
  for (const [index, file] of files.entries()) {
    if (file.key !== refs[index].key || file.source_url !== refs[index].source_url) invalid();
  }
  let bytes = catalog.tables.reduce((n, table) => n + table.bytes, 0) + enc.encode(directory).length + enc.encode(catalogText).length;
  const rows = catalog.tables.reduce((n, table) => n + table.rows, 0);
  for (const [index, file] of files.entries()) {
    const raw = await mediaBytes(workspace, file, run.signal);
    raw.fill(0); bytes += file.bytes; run.progress(rows, index + 1, bytes);
  }
  return { catalog, files, refs, rows, bytes };
}
class CipherScan {
  bytes = 0;
  private ended = false;
  private readonly hash = new Sha256();
  async *read(source: TransferByteSource, run: Run): AsyncGenerator<Uint8Array> {
    for await (const chunk of read(source, run.signal)) {
      this.bytes += chunk.length;
      if (this.bytes > 1101 * 1024 * 1024) invalid();
      this.hash.update(chunk); run.progress(0, 0, this.bytes); yield chunk;
    }
    this.ended = true;
  }
  digest(): string { if (!this.ended || !this.bytes) invalid(); return this.hash.digestHex(); }
}
async function authenticate(file: ReplacementBackupFile, passphrase: string, metadata: TransferMetadata, workspace: ArchiveBundleWorkspace, run: Run) {
  run.phase = 'authenticate';
  const scan = new CipherScan();
  const manifest = await verifyEncryptedVolume(scan.read(file.open(), run), passphrase, workspace,
    { signal: run.signal, limits: bounds(run.options).container, expectedMetadata: validateTransferMetadata(metadata) });
  return { manifest, cipherBytes: scan.bytes, cipherSha256: scan.digest() };
}

export async function exportArchiveBundle(
  source: ArchivesExportSource, media: ArchiveMediaSession, file: ReplacementBackupFile,
  createWorkspace: ArchiveBundleWorkspaceFactory, passphrase: string, input: VolumeInfo, options: ArchiveBundleOptions = {},
): Promise<ArchiveBundleResult> {
  const run = new Run(options, createWorkspace);
  return run.finish(async () => {
    const limits = bounds(options), info = validateVolumeInfo(input);
    if (info.scope !== 'replacement-backup' || info.volumeIndex !== 1 || info.volumeCount !== 1 || media.direction !== 'export') invalid();
    const workspace = run.workspace();
    run.phase = 'records-export';
    const snapshot = await exportArchivesData({
      catalog: signal => source.catalog(signal),
      page: (key, after, signal) => source.page(key, after, signal),
      verify: signal => run.write(async () => validateArchivesVerification(await source.verify(signal))),
    }, workspace, { signal: run.signal, onProgress: progress => run.progress(progress.rows, 0, progress.bytes) });
    if (info.exportId !== snapshot.catalog.package_id || info.sourceSiteId !== snapshot.catalog.site_id) invalid();
    run.phase = 'validate';
    const refs = await scanRecords(workspace, snapshot.catalog, snapshot.entries, run);
    const inventory = matchInventory(await withSignal(() => media.inventory(run.signal), run.signal), 'export', snapshot.catalog, refs);
    const files: ArchiveMediaFile[] = [];
    let bytes = snapshot.bytes;
    run.phase = 'media-download';
    for (const ref of inventory.files) {
      const downloaded = await run.write(() => media.download(ref, run.signal));
      const file = validateArchiveMediaFile(downloaded.file), raw = new Uint8Array(downloaded.bytes);
      try {
        if (file.key !== ref.key || file.source_url !== ref.source_url) invalid();
        if (ref.file) same(file, ref.file);
        inspect(file, raw); bytes += raw.length;
        if (bytes > limits.maxTotalBytes) invalid();
        // append/open are bounded to 1MiB even though each service file can be 50MiB.
        for (let offset = 0; offset < raw.length; offset += MAX_CONTAINER_INPUT_BYTES) {
          await withSignal(() => workspace.append(mediaPath(file), raw.slice(offset, offset + MAX_CONTAINER_INPUT_BYTES), run.signal), run.signal);
        }
        files.push(file); run.progress(snapshot.rows, files.length, bytes);
      } finally { raw.fill(0); }
    }
    const directory = enc.encode(files.map(file => JSON.stringify(file) + '\n').join(''));
    const catalog = enc.encode(JSON.stringify(snapshot.catalog) + '\n');
    if (directory.length > ARCHIVE_BUNDLE_LIMITS.maxDirectoryBytes || catalog.length > ARCHIVE_BUNDLE_LIMITS.maxCatalogBytes
      || bytes + directory.length + catalog.length > limits.maxTotalBytes) invalid();
    for (const [path, raw] of [[ARCHIVE_BUNDLE_MEDIA_PATH, directory], [ARCHIVE_BUNDLE_CATALOG_PATH, catalog]] as const) {
      for (let offset = 0; offset < raw.length || offset === 0; offset += MAX_CONTAINER_INPUT_BYTES) {
        await withSignal(() => workspace.append(path, raw.slice(offset, offset + MAX_CONTAINER_INPUT_BYTES), run.signal), run.signal);
      }
    }
    run.phase = 'source-recheck';
    await run.write(() => media.recheckExport(files, run.signal));
    await run.write(async () => matchInventory(await media.verify(run.signal), 'export', snapshot.catalog, refs, files, true));
    const expected = [...snapshot.entries,
      { path: ARCHIVE_BUNDLE_MEDIA_PATH, kind: 'ndjson' as const, bytes: directory.length, sha256: sha(directory) },
      { path: ARCHIVE_BUNDLE_CATALOG_PATH, kind: 'ndjson' as const, bytes: catalog.length, sha256: sha(catalog) },
      ...files.map(file => ({ path: mediaPath(file), kind: 'media' as const, bytes: file.bytes, sha256: file.sha256 }))];
    async function* entries(): AsyncGenerator<TransferEntry> {
      for (const entry of expected) yield { path: entry.path, bytes: entry.bytes, open: () => workspace.open(entry.path) };
    }
    run.phase = 'save';
    const written = new CipherScan();
    const encrypted = written.read(writeEncryptedVolume(entries(), info, passphrase, { signal: run.signal, limits: limits.container }), run);
    try {
      await withSignal(async () => { run.fileState = 'unknown'; run.unknown = true; await file.write(encrypted, run.signal); }, run.signal);
      checkAbort(run.signal);
      written.digest(); run.fileState = 'saved'; run.unknown = false;
    } finally { void encrypted.return(undefined).catch(() => undefined); }
    await workspace.abort(new Error('Saved archive snapshot plaintext discarded.'));
    const readback = run.workspace();
    const authenticated = await authenticate(file, passphrase, { exportId: info.exportId, volumeId: info.volumeId }, readback, run);
    same(authenticated.manifest.entries, expected);
    same(validateVolumeInfo(Object.fromEntries(Object.keys(info).map(key => [key, authenticated.manifest[key as keyof VolumeInfo]]))), info);
    if (authenticated.cipherBytes !== written.bytes || authenticated.cipherSha256 !== written.digest()) invalid();
    const checked = await validateBundle(readback, authenticated.manifest, run);
    same(checked.catalog, snapshot.catalog);
    run.fileState = 'verified'; run.recordsVerified = true; run.mediaVerified = true;
    return { scope: 'site-archives-bundle', catalog: checked.catalog, rows: checked.rows, files: checked.files.length,
      bytes: checked.bytes, ...authenticated, recordsVerified: true, mediaVerified: true, fullSiteComplete: false };
  });
}

export async function importArchiveBundle(
  file: ReplacementBackupFile, passphrase: string, metadata: TransferMetadata, createWorkspace: ArchiveBundleWorkspaceFactory,
  target: ArchiveBundleImportTarget, options: ArchiveBundleOptions = {},
): Promise<ArchiveBundleResult> {
  const run = new Run(options, createWorkspace);
  return run.finish(async () => {
    bounds(options);
    if (target.media.direction !== 'import') invalid();
    const workspace = run.workspace();
    const authenticated = await authenticate(file, passphrase, metadata, workspace, run);
    const checked = await validateBundle(workspace, authenticated.manifest, run);
    run.fileState = 'verified';
    const chunks = new Map<ArchivesTableKey, { rows: number; bytes: number }[]>(ARCHIVES_TABLE_KEYS.map(key => [key, []]));
    run.phase = 'stage';
    const staged = await stageArchivesImport(checked.catalog, {
      open: path => workspace.open(path),
      // The records helper always aborts on return; media still needs these bytes.
      // Run.finish's outer finally really aborts on EVERY outcome, including success.
      async abort() {},
    }, {
      bind: (catalog, signal) => run.write(async () => validateArchivesBind(await target.records.target.bind(catalog, signal))),
      stage: (key, chunkNo, ndjson, signal) => run.write(async () => {
        const raw = enc.encode(ndjson), rows = ndjson === '' ? 0 : ndjson.split('\n').length - 1;
        const receipt = validateArchivesStage(await target.records.target.stage(key, chunkNo, ndjson, signal), rows, raw.length, sha(raw));
        if (chunkNo !== chunks.get(key)!.length) invalid();
        chunks.get(key)!.push({ rows, bytes: raw.length }); return receipt;
      }),
      plan: signal => target.records.plan(signal),
    }, { signal: run.signal, onProgress: progress => {
      if (progress.phase === 'stage') run.progress(progress.rows, 0, progress.bytes);
    } });
    if (!staged.plan.can_restore || staged.plan.conflicts.length) invalid();
    run.phase = 'restore';
    const status = (value: ArchivesStatus, previous?: ArchivesStatus, key?: ArchivesTableKey): ArchivesStatus => {
      const next = validateArchivesStatus(value);
      if (!next.started) invalid();
      for (const table of checked.catalog.tables) {
        if (next.counts[table.key] !== table.rows || next.chunks[table.key] !== chunks.get(table.key)!.length) invalid();
        if (previous && next.completed_chunks[table.key] !== previous.completed_chunks[table.key] + (key === table.key ? 1 : 0)) invalid();
      }
      return next;
    };
    let current = await run.write(async () => status(await target.restore.begin(staged.plan.plan_hash, run.signal)));
    const progress = () => {
      let rows = 0, bytes = 0;
      for (const key of ARCHIVES_TABLE_KEYS) for (const chunk of chunks.get(key)!.slice(0, current.completed_chunks[key])) {
        rows += chunk.rows; bytes += chunk.bytes;
      }
      run.progress(rows, 0, bytes);
    };
    progress();
    for (const key of ARCHIVES_TABLE_KEYS) {
      while (current.completed_chunks[key] < current.chunks[key]) {
        current = await run.write(async () => {
          const next = status(await target.restore.chunk(key, current.completed_chunks[key], run.signal), current, key);
          if (next.records_verified !== current.records_verified) invalid();
          return next;
        });
        progress();
      }
    }
    current = await run.write(async () => {
      const next = status(await target.restore.verify(run.signal), current);
      if (!next.records_verified) invalid();
      return next;
    });
    run.recordsVerified = true;
    run.phase = 'media-upload';
    matchInventory(await withSignal(() => target.media.inventory(run.signal), run.signal), 'import', checked.catalog, checked.refs, checked.files);
    await run.write(() => target.media.bind(checked.files, run.signal));
    let bytes = 0;
    for (const [index, file] of checked.files.entries()) {
      const raw = await mediaBytes(workspace, file, run.signal);
      try { await run.write(() => target.media.upload(file, raw, run.signal)); }
      finally { raw.fill(0); }
      bytes += file.bytes; run.progress(checked.rows, index + 1, bytes);
    }
    run.phase = 'target-recheck';
    await run.write(() => target.media.recheckImport(checked.files, run.signal));
    await run.write(async () => matchInventory(await target.media.verify(run.signal), 'import', checked.catalog, checked.refs, checked.files, true));
    run.mediaVerified = true;
    return { scope: 'site-archives-bundle', catalog: checked.catalog, rows: checked.rows, files: checked.files.length,
      bytes: checked.bytes, ...authenticated, recordsVerified: true, mediaVerified: true, fullSiteComplete: false };
  });
}
