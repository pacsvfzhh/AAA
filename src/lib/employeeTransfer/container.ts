import { ZipPassThrough } from 'fflate';
import {
  decryptTransferStream, encryptTransferStream,
  type TransferByteSource, type TransferByteStream, type TransferEncryptionOptions, type TransferMetadata,
} from './crypto';
import { Sha256 } from './sha256';
import {
  MANIFEST_PATH, MAX_ENTRY_PATH_BYTES, MAX_MANIFEST_BYTES, MAX_VOLUME_ENTRIES,
  claimEntryPath, parseManifest, serializeManifest, validateTransferMetadata, validateVolumeInfo,
  type ManifestEntry, type VolumeInfo, type VolumeManifest,
} from './manifest';

export const MAX_CONTAINER_INPUT_BYTES = 1024 * 1024;
const ZIP32_MAX = 0xfffffffe;
const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

export interface ContainerLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxZipBytes: number;
  maxManifestBytes: number;
  maxLineBytes: number;
}
export const DEFAULT_CONTAINER_LIMITS: Readonly<ContainerLimits> = Object.freeze({
  maxEntries: MAX_VOLUME_ENTRIES,
  maxEntryBytes: 512 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxZipBytes: 1100 * 1024 * 1024,
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxLineBytes: 1024 * 1024,
});
export interface ContainerProgress {
  phase: 'write' | 'verify';
  // Excludes ZIP framing, manifest and the writer's first-pass scan.
  bytes: number;
  // Completed payloads, not business commits.
  entries: number;
  path?: string;
}
export interface ContainerOptions {
  limits?: Partial<ContainerLimits>;
  signal?: AbortSignal;
  onProgress?: (progress: ContainerProgress) => void;
}
export interface VerifyOptions extends ContainerOptions {
  expectedMetadata?: TransferMetadata;
}
export interface TransferEntry {
  path: string;
  bytes: number;
  // Must reopen immutable bytes twice; one-shot sources require temporary storage.
  open: () => TransferByteSource;
}
export interface TemporaryTransferSink {
  // Temporary writes must respect abort invalidation, including late completions.
  append(path: string, chunk: Uint8Array, signal?: AbortSignal): Promise<void>;
  // Atomically invalidate pending/future writes and discard data without waiting for blocked writes.
  abort(reason: unknown): Promise<void>;
}

function invalid(detail = 'Invalid or incomplete transfer ZIP.'): never {
  throw new Error(detail);
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Transfer cancelled.', 'AbortError');
}
function limitsFor(options: ContainerOptions): ContainerLimits {
  const supplied = options.limits ?? {};
  if (typeof supplied !== 'object' || supplied === null || Array.isArray(supplied)
    || Object.keys(supplied).some(key => !Object.prototype.hasOwnProperty.call(DEFAULT_CONTAINER_LIMITS, key))) invalid('Invalid container limits.');
  const limits = { ...DEFAULT_CONTAINER_LIMITS, ...supplied };
  for (const key of Object.keys(limits) as (keyof ContainerLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > ZIP32_MAX) invalid('Invalid container limits.');
  }
  if (limits.maxEntries > MAX_VOLUME_ENTRIES || limits.maxManifestBytes > MAX_MANIFEST_BYTES) invalid('Container limit exceeds format bound.');
  return limits;
}
function size(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) invalid('Transfer size limit exceeded.');
}
function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function crcStream(path: string): ZipPassThrough {
  const stream = new ZipPassThrough(path);
  stream.ondata = error => { if (error) throw error; };
  return stream;
}

async function withSignal<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return operation();
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Transfer cancelled.', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    // Both handlers stay attached after cancellation, including for a late operation rejection.
    Promise.resolve().then(() => {
      checkAbort(signal);
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function* iterate<T>(source: AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') invalid();
  const iterator = source[Symbol.asyncIterator]();
  let ended = false;
  try {
    while (true) {
      const next = await withSignal(() => iterator.next(), signal);
      checkAbort(signal);
      if (next.done) { ended = true; return; }
      yield next.value;
    }
  } finally {
    if (!ended && iterator.return) {
      const closing = Promise.resolve().then(() => iterator.return?.()).catch(() => undefined);
      if (!signal?.aborted) await closing;
    }
  }
}

async function* bounded(source: TransferByteSource, signal?: AbortSignal): TransferByteStream {
  for await (const chunk of iterate(source, signal)) {
    if (!(chunk instanceof Uint8Array) || chunk.length > MAX_CONTAINER_INPUT_BYTES) invalid('Input chunk exceeds 1 MiB.');
    if (chunk.length) yield chunk;
  }
}

class Reader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private chunk = EMPTY;
  private offset = 0;
  position = 0;
  constructor(source: TransferByteSource, private readonly limits: ContainerLimits, private readonly signal?: AbortSignal) {
    this.iterator = bounded(source, signal)[Symbol.asyncIterator]();
  }
  async take(maximum: number): Promise<Uint8Array> {
    checkAbort(this.signal);
    while (this.offset === this.chunk.length) {
      this.chunk = EMPTY;
      this.offset = 0;
      const next = await this.iterator.next();
      if (next.done) return EMPTY;
      this.chunk = next.value;
    }
    const result = this.chunk.subarray(this.offset, this.offset + Math.min(maximum, this.chunk.length - this.offset));
    this.offset += result.length;
    this.position += result.length;
    size(this.position, this.limits.maxZipBytes);
    return result;
  }
  async exact(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const chunk = await this.take(length - written);
      if (!chunk.length) invalid();
      result.set(chunk, written);
      written += chunk.length;
    }
    return result;
  }
  async close(): Promise<void> {
    this.chunk = EMPTY;
    const closing = Promise.resolve().then(() => this.iterator.return?.()).catch(() => undefined);
    if (!this.signal?.aborted) await closing;
  }
}

// Opaque NDJSON: validate UTF-8 and byte-length of every line without parsing or retaining a line.
class NdjsonCheck {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private lineBytes = 0;
  constructor(private readonly maximum: number) {}
  push(chunk: Uint8Array, final = false): void {
    this.decoder.decode(chunk, { stream: !final });
    for (const byte of chunk) {
      if (byte === 10) this.lineBytes = 0;
      else if (++this.lineBytes > this.maximum) invalid('NDJSON line limit exceeded.');
    }
  }
}

class EntryCheck {
  private readonly crc: ZipPassThrough;
  private readonly hash = new Sha256();
  private readonly ndjson?: NdjsonCheck;
  private bytes = 0;
  constructor(path: string, private readonly expectedBytes: number, lineLimit?: number) {
    this.crc = crcStream(path);
    if (lineLimit !== undefined) this.ndjson = new NdjsonCheck(lineLimit);
  }
  push(chunk: Uint8Array): void {
    this.bytes += chunk.length;
    size(this.bytes, this.expectedBytes);
    this.ndjson?.push(chunk);
    this.hash.update(chunk);
    this.crc.push(chunk, false);
  }
  finish(): { bytes: number; crc: number; sha256: string } {
    if (this.bytes !== this.expectedBytes) invalid('Entry size mismatch.');
    this.ndjson?.push(EMPTY, true);
    this.crc.push(EMPTY, true);
    return { bytes: this.bytes, crc: this.crc.crc >>> 0, sha256: this.hash.digestHex() };
  }
}

interface ZipRecord {
  path: string;
  bytes: number;
  offset: number;
  crc: number;
  flags: number;
  stamp: number;
}

// Two passes provide CRC/sizes up front so binary media never needs unsafe ZIP-signature scanning.
function localHeader(record: ZipRecord): Uint8Array {
  const name = encoder.encode(record.path);
  const bytes = new Uint8Array(30 + name.length);
  const data = view(bytes);
  data.setUint32(0, 0x04034b50, true);
  data.setUint16(4, 20, true);
  data.setUint16(6, record.flags, true);
  data.setUint32(10, record.stamp, true);
  data.setUint32(14, record.crc, true);
  data.setUint32(18, record.bytes, true);
  data.setUint32(22, record.bytes, true);
  data.setUint16(26, name.length, true);
  bytes.set(name, 30);
  return bytes;
}
function centralHeader(record: ZipRecord): Uint8Array {
  const name = encoder.encode(record.path);
  const bytes = new Uint8Array(46 + name.length);
  const data = view(bytes);
  data.setUint32(0, 0x02014b50, true);
  data.setUint16(4, 20, true);
  data.setUint16(6, 20, true);
  data.setUint16(8, record.flags, true);
  data.setUint32(12, record.stamp, true);
  data.setUint32(16, record.crc, true);
  data.setUint32(20, record.bytes, true);
  data.setUint32(24, record.bytes, true);
  data.setUint16(28, name.length, true);
  data.setUint32(42, record.offset, true);
  bytes.set(name, 46);
  return bytes;
}
function endRecord(count: number, centralSize: number, centralOffset: number): Uint8Array {
  const bytes = new Uint8Array(22);
  const data = view(bytes);
  data.setUint32(0, 0x06054b50, true);
  data.setUint16(8, count, true);
  data.setUint16(10, count, true);
  data.setUint32(12, centralSize, true);
  data.setUint32(16, centralOffset, true);
  return bytes;
}
async function* single(bytes: Uint8Array): TransferByteStream {
  for (let offset = 0; offset < bytes.length; offset += MAX_CONTAINER_INPUT_BYTES) yield bytes.subarray(offset, offset + MAX_CONTAINER_INPUT_BYTES);
}

export async function* writePlainVolume(
  entries: AsyncIterable<TransferEntry>, info: VolumeInfo, options: ContainerOptions = {},
): TransferByteStream {
  checkAbort(options.signal);
  const limits = limitsFor(options);
  const identity = validateVolumeInfo(info);
  const records: ZipRecord[] = [];
  const observed: ManifestEntry[] = [];
  const paths = new Set<string>();
  let zipBytes = 0;
  let payloadBytes = 0;
  const account = (chunk: Uint8Array) => {
    zipBytes += chunk.length;
    size(zipBytes, limits.maxZipBytes);
    return chunk;
  };
  const progress = (path: string) => options.onProgress?.({ phase: 'write', bytes: payloadBytes, entries: observed.length, path });

  async function* writeEntry(entry: TransferEntry, manifest = false): TransferByteStream {
    checkAbort(options.signal);
    const kind = manifest ? undefined : claimEntryPath(entry.path, paths);
    if (!manifest && observed.length >= limits.maxEntries) invalid('Entry count limit exceeded.');
    size(entry.bytes, manifest ? limits.maxManifestBytes : limits.maxEntryBytes);
    if (!manifest) size(payloadBytes + entry.bytes, limits.maxTotalBytes);
    const lineLimit = kind === 'ndjson' ? limits.maxLineBytes : undefined;
    const firstCheck = new EntryCheck(entry.path, entry.bytes, lineLimit);
    for await (const chunk of bounded(entry.open(), options.signal)) firstCheck.push(chunk);
    const first = firstCheck.finish();
    const record: ZipRecord = { path: entry.path, bytes: first.bytes, offset: zipBytes, crc: first.crc, flags: 0, stamp: 0x00210000 };
    yield account(localHeader(record));
    const secondCheck = new EntryCheck(entry.path, entry.bytes, lineLimit);
    for await (const chunk of bounded(entry.open(), options.signal)) {
      secondCheck.push(chunk);
      if (!manifest) { payloadBytes += chunk.length; progress(entry.path); }
      yield account(chunk);
    }
    const second = secondCheck.finish();
    if (first.crc !== second.crc || first.sha256 !== second.sha256) invalid('Entry changed between passes.');
    records.push(record);
    if (!manifest) {
      observed.push({ path: entry.path, bytes: first.bytes, sha256: first.sha256, kind: kind! });
      progress(entry.path);
    }
  }

  for await (const entry of iterate(entries, options.signal)) yield* writeEntry(entry);
  const manifestBytes = serializeManifest({ version: 1, ...identity, entries: observed });
  yield* writeEntry({ path: MANIFEST_PATH, bytes: manifestBytes.length, open: () => single(manifestBytes) }, true);
  const centralOffset = zipBytes;
  for (const record of records) {
    checkAbort(options.signal);
    yield account(centralHeader(record));
  }
  yield account(endRecord(records.length, zipBytes - centralOffset, centralOffset));
}

async function readName(reader: Reader, length: number): Promise<string> {
  if (length < 1 || length > MAX_ENTRY_PATH_BYTES) invalid();
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await reader.exact(length));
}

export async function verifyPlainVolume(
  source: TransferByteSource, sink: TemporaryTransferSink, options: VerifyOptions = {},
): Promise<VolumeManifest> {
  let reader: Reader | undefined;
  try {
    checkAbort(options.signal);
    const limits = limitsFor(options);
    const expected = options.expectedMetadata === undefined ? undefined : validateTransferMetadata(options.expectedMetadata);
    reader = new Reader(source, limits, options.signal);
    const records: ZipRecord[] = [];
    const observed: ManifestEntry[] = [];
    const paths = new Set<string>();
    let manifest: VolumeManifest | undefined;
    let payloadBytes = 0;
    const progress = (path: string) => options.onProgress?.({ phase: 'verify', bytes: payloadBytes, entries: observed.length, path });
    const append = (path: string, chunk: Uint8Array) => withSignal(
      () => sink.append(path, new Uint8Array(chunk), options.signal), options.signal,
    );
    let signature = view(await reader.exact(4)).getUint32(0, true);
    while (signature === 0x04034b50) {
      if (manifest) invalid('Manifest must be the last ZIP entry.');
      const offset = reader.position - 4;
      const header = view(await reader.exact(26));
      const flags = header.getUint16(2, true);
      const bytes = header.getUint32(18, true);
      const localCrc = header.getUint32(10, true);
      if (header.getUint16(0, true) !== 20 || flags !== 0
        || header.getUint16(4, true) !== 0 || header.getUint16(24, true) !== 0
        || bytes === 0xffffffff || header.getUint32(14, true) !== bytes) invalid('Unsupported or unsafe ZIP entry.');
      const path = await readName(reader, header.getUint16(22, true));
      const isManifest = path === MANIFEST_PATH;
      const kind = isManifest ? undefined : claimEntryPath(path, paths);
      if (!isManifest && observed.length >= limits.maxEntries) invalid('Entry count limit exceeded.');
      size(bytes, isManifest ? limits.maxManifestBytes : limits.maxEntryBytes);
      if (!isManifest) size(payloadBytes + bytes, limits.maxTotalBytes);
      // Reject advertised lengths past the archive limit before allocating or reading payload.
      size(reader.position + bytes, limits.maxZipBytes);
      const record: ZipRecord = { path, bytes, offset, flags, stamp: header.getUint32(6, true), crc: 0 };
      const crc = crcStream(path);
      const hash = new Sha256();
      const ndjson = kind === 'ndjson' ? new NdjsonCheck(limits.maxLineBytes) : undefined;
      const manifestBytes = isManifest ? new Uint8Array(bytes) : undefined;
      let count = 0;
      if (!bytes && !isManifest) { await append(path, EMPTY); checkAbort(options.signal); }
      while (count < bytes) {
        const chunk = await reader.take(Math.min(MAX_CONTAINER_INPUT_BYTES, bytes - count));
        if (!chunk.length) invalid();
        ndjson?.push(chunk);
        hash.update(chunk);
        crc.push(chunk, false);
        if (manifestBytes) manifestBytes.set(chunk, count);
        else {
          // Always copy, including Node Buffer inputs (Buffer.slice() would alias the producer).
          await append(path, chunk);
          checkAbort(options.signal);
          payloadBytes += chunk.length;
          progress(path);
        }
        count += chunk.length;
      }
      ndjson?.push(EMPTY, true);
      crc.push(EMPTY, true);
      record.crc = crc.crc >>> 0;
      if (record.crc !== localCrc) invalid('ZIP CRC mismatch.');
      records.push(record);
      if (manifestBytes) {
        manifest = parseManifest(manifestBytes);
        if (expected && (manifest.exportId !== expected.exportId || manifest.volumeId !== expected.volumeId)) invalid('Volume metadata mismatch.');
        if (manifest.entries.length !== observed.length || manifest.entries.some((entry, index) => {
          const actual = observed[index];
          return entry.path !== actual.path || entry.kind !== actual.kind || entry.bytes !== actual.bytes || entry.sha256 !== actual.sha256;
        })) invalid('Manifest entry, order, size or SHA-256 mismatch.');
      } else {
        observed.push({ path, bytes, sha256: hash.digestHex(), kind: kind! });
        progress(path);
      }
      signature = view(await reader.exact(4)).getUint32(0, true);
    }
    if (!manifest || signature !== 0x02014b50) invalid();
    const centralOffset = reader.position - 4;
    // Canonical headers also exclude symlinks, extras and alternate disk/offset interpretations.
    for (let index = 0; index < records.length; index++) {
      if (signature !== 0x02014b50) invalid('Missing ZIP central directory.');
      const expectedHeader = centralHeader(records[index]);
      const actual = await reader.exact(expectedHeader.length - 4);
      if (!actual.every((byte, i) => byte === expectedHeader[i + 4])) invalid('ZIP central directory mismatch.');
      signature = view(await reader.exact(4)).getUint32(0, true);
    }
    const centralSize = reader.position - 4 - centralOffset;
    if (signature !== 0x06054b50) invalid('Invalid ZIP end record.');
    const end = await reader.exact(18);
    const expectedEnd = endRecord(records.length, centralSize, centralOffset);
    if (!end.every((byte, index) => byte === expectedEnd[index + 4])) invalid('Invalid ZIP end record.');
    // EOF also authenticates crypto's final record; EOCD alone cannot prove the volume is complete.
    if ((await reader.take(1)).length) invalid('Trailing ZIP bytes.');
    checkAbort(options.signal);
    return manifest;
  } catch (error) {
    try { await sink.abort(error); } catch { /* Preserve the validation failure. */ }
    throw error;
  } finally {
    await reader?.close();
  }
}

export async function* writeEncryptedVolume(
  entries: AsyncIterable<TransferEntry>, info: VolumeInfo, passphrase: string,
  options: ContainerOptions & TransferEncryptionOptions = {},
): TransferByteStream {
  const identity = validateVolumeInfo(info);
  const encrypted = encryptTransferStream(writePlainVolume(entries, identity, options), passphrase,
    { exportId: identity.exportId, volumeId: identity.volumeId }, options);
  // A crypto record may include a 1 MiB payload plus framing; keep public pushes <= 1 MiB.
  for await (const chunk of encrypted) yield* single(chunk);
}

export async function verifyEncryptedVolume(
  source: TransferByteSource, passphrase: string, sink: TemporaryTransferSink,
  options: VerifyOptions & { expectedMetadata: TransferMetadata },
): Promise<VolumeManifest> {
  async function* plaintext(): TransferByteStream {
    const expectedMetadata = validateTransferMetadata(options.expectedMetadata);
    const decrypted = decryptTransferStream(bounded(source, options.signal), passphrase,
      { signal: options.signal, expectedMetadata });
    for await (const chunk of decrypted) yield* single(chunk);
  }
  return verifyPlainVolume(plaintext(), sink, options);
}
