export const MIN_TRANSFER_PASSPHRASE_LENGTH = 14;
export const PBKDF2_ITERATIONS = 600000;
export const DEFAULT_TRANSFER_CHUNK_SIZE = 1024 * 1024;
export const MAX_TRANSFER_CHUNK_SIZE = 4 * 1024 * 1024;
export const MAX_TRANSFER_HEADER_SIZE = 1024;
export const MAX_TRANSFER_INPUT_CHUNK_SIZE = 8 * 1024 * 1024;

export interface TransferMetadata {
  exportId: string;
  volumeId: string;
}

export interface TransferEncryptionOptions {
  chunkSize?: number;
  signal?: AbortSignal;
}

export interface TransferDecryptionOptions {
  signal?: AbortSignal;
  expectedMetadata?: TransferMetadata;
}

export type TransferByteSource = AsyncIterable<Uint8Array>;
export type TransferByteStream = AsyncGenerator<Uint8Array, void, unknown>;

const MAGIC = new TextEncoder().encode('EDXSTRM1');
const PREFIX_SIZE = 12;
const FIXED_HEADER_SIZE = 38;
const RECORD_SIZE = 17;
const TAG_SIZE = 16;
const MAX_INDEX = 0xffffffff;
const encoder = new TextEncoder();

function invalidFormat(): Error {
  return new Error('Invalid or incomplete transfer container.');
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Transfer cancelled.', 'AbortError');
}

function validatePassphrase(passphrase: string): Uint8Array {
  if (typeof passphrase !== 'string' || passphrase.length > 4096
    || /[\uD800-\uDFFF]/u.test(passphrase)
    || [...passphrase].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
    || [...passphrase].length < MIN_TRANSFER_PASSPHRASE_LENGTH) {
    throw new Error('Transfer passphrase must contain at least 14 Unicode characters.');
  }
  const bytes = encoder.encode(passphrase);
  if (bytes.length > 4096) throw new Error('Transfer passphrase is too long.');
  return bytes;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && encoder.encode(value).length <= 256
    && /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._:-]*$/u.test(value);
}

function validateMetadata(value: unknown): TransferMetadata {
  if (typeof value !== 'object' || value === null) throw invalidFormat();
  const keys = Reflect.ownKeys(value);
  const metadata = value as Record<string, unknown>;
  if (keys.length !== 2 || !keys.includes('exportId') || !keys.includes('volumeId')
    || !validId(metadata.exportId) || !validId(metadata.volumeId)) throw invalidFormat();
  return { exportId: metadata.exportId, volumeId: metadata.volumeId };
}

function validChunkSize(size: number): boolean {
  return Number.isInteger(size) && size >= 1 && size <= MAX_TRANSFER_CHUNK_SIZE;
}

function concatenate(first: Uint8Array, second: Uint8Array): Uint8Array {
  const result = new Uint8Array(first.length + second.length);
  result.set(first);
  result.set(second, first.length);
  return result;
}

class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current = new Uint8Array(0);
  private offset = 0;
  private ended = false;

  constructor(source: TransferByteSource, private readonly signal?: AbortSignal) {
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw invalidFormat();
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async next(): Promise<IteratorResult<Uint8Array>> {
    checkAbort(this.signal);
    if (!this.signal) return this.iterator.next();
    const signal = this.signal;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new DOMException('Transfer cancelled.', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => {
        checkAbort(signal);
        return this.iterator.next();
      }).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  async readUpTo(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      checkAbort(this.signal);
      if (this.offset === this.current.length) {
        this.current = new Uint8Array(0);
        this.offset = 0;
        if (this.ended) break;
        const next = await this.next();
        checkAbort(this.signal);
        if (next.done) {
          this.ended = true;
          break;
        }
        if (!(next.value instanceof Uint8Array)
          || next.value.length > MAX_TRANSFER_INPUT_CHUNK_SIZE) throw invalidFormat();
        this.current = next.value;
        if (!this.current.length) continue;
      }
      const count = Math.min(length - written, this.current.length - this.offset);
      result.set(this.current.subarray(this.offset, this.offset + count), written);
      this.offset += count;
      written += count;
    }
    return result.subarray(0, written);
  }

  async exact(length: number): Promise<Uint8Array> {
    const bytes = await this.readUpTo(length);
    if (bytes.length !== length) throw invalidFormat();
    return bytes;
  }

  async close(): Promise<void> {
    this.current = new Uint8Array(0);
    if (!this.ended && this.iterator.return) {
      const closing = Promise.resolve().then(() => this.iterator.return?.()).catch(() => undefined);
      if (!this.signal?.aborted) await closing;
    }
  }
}

interface ContainerHeader {
  metadata: TransferMetadata;
  bytes: Uint8Array;
  salt: Uint8Array;
  nonceBase: Uint8Array;
  chunkSize: number;
}

function createHeader(metadata: TransferMetadata, chunkSize: number): ContainerHeader {
  const exportId = encoder.encode(metadata.exportId);
  const volumeId = encoder.encode(metadata.volumeId);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonceBase = crypto.getRandomValues(new Uint8Array(8));
  const payloadSize = FIXED_HEADER_SIZE + exportId.length + volumeId.length;
  const bytes = new Uint8Array(PREFIX_SIZE + payloadSize);
  bytes.set(MAGIC);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, payloadSize);
  bytes[12] = 1;
  bytes[13] = 1;
  view.setUint32(14, PBKDF2_ITERATIONS);
  view.setUint32(18, chunkSize);
  bytes.set(salt, 22);
  bytes.set(nonceBase, 38);
  view.setUint16(46, exportId.length);
  view.setUint16(48, volumeId.length);
  bytes.set(exportId, 50);
  bytes.set(volumeId, 50 + exportId.length);
  return { metadata, bytes, salt, nonceBase, chunkSize };
}

async function readHeader(reader: ByteReader): Promise<ContainerHeader> {
  const prefix = await reader.exact(PREFIX_SIZE);
  if (!MAGIC.every((byte, index) => byte === prefix[index])) throw invalidFormat();
  const size = new DataView(prefix.buffer).getUint32(8);
  if (size < FIXED_HEADER_SIZE + 2 || size > MAX_TRANSFER_HEADER_SIZE) throw invalidFormat();
  const payload = await reader.exact(size);
  const view = new DataView(payload.buffer);
  const chunkSize = view.getUint32(6);
  const exportLength = view.getUint16(34);
  const volumeLength = view.getUint16(36);
  if (payload[0] !== 1 || payload[1] !== 1 || view.getUint32(2) !== PBKDF2_ITERATIONS
    || !validChunkSize(chunkSize) || exportLength < 1 || exportLength > 256
    || volumeLength < 1 || volumeLength > 256
    || size !== FIXED_HEADER_SIZE + exportLength + volumeLength) throw invalidFormat();
  let metadata: TransferMetadata;
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    metadata = validateMetadata({
      exportId: decoder.decode(payload.subarray(38, 38 + exportLength)),
      volumeId: decoder.decode(payload.subarray(38 + exportLength)),
    });
  } catch {
    throw invalidFormat();
  }
  return {
    metadata,
    bytes: concatenate(prefix, payload),
    salt: payload.slice(10, 26),
    nonceBase: payload.slice(26, 34),
    chunkSize,
  };
}

// Header identity is untrusted until the entire encrypted volume is authenticated.
export async function readTransferMetadata(source: TransferByteSource, signal?: AbortSignal): Promise<TransferMetadata> {
  const reader = new ByteReader(source, signal);
  try { return { ...(await readHeader(reader)).metadata }; }
  finally { await reader.close(); }
}

async function deriveKey(passphraseBytes: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  try {
    const material = await crypto.subtle.importKey('raw', passphraseBytes, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
  } finally {
    passphraseBytes.fill(0);
  }
}

function nonce(base: Uint8Array, index: number): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes.set(base);
  new DataView(bytes.buffer).setUint32(8, index);
  return bytes;
}

function recordHeader(index: number, final: boolean, length: number, total: bigint): Uint8Array {
  const bytes = new Uint8Array(RECORD_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, index);
  bytes[4] = final ? 1 : 0;
  view.setUint32(5, length);
  view.setBigUint64(9, total);
  return bytes;
}

export async function* encryptTransferStream(
  source: TransferByteSource,
  passphrase: string,
  metadata: TransferMetadata,
  options: TransferEncryptionOptions = {},
): TransferByteStream {
  checkAbort(options.signal);
  const validatedMetadata = validateMetadata(metadata);
  const chunkSize = options.chunkSize ?? DEFAULT_TRANSFER_CHUNK_SIZE;
  if (!validChunkSize(chunkSize)) throw new Error('Invalid transfer chunk size.');
  const passphraseBytes = validatePassphrase(passphrase);
  const reader = new ByteReader(source, options.signal);
  try {
    const header = createHeader(validatedMetadata, chunkSize);
    const key = await deriveKey(passphraseBytes, header.salt);
    checkAbort(options.signal);
    yield header.bytes.slice();
    let index = 0;
    let total = 0n;
    while (true) {
      const plaintext = await reader.readUpTo(chunkSize);
      const final = plaintext.length === 0;
      if (index > MAX_INDEX || (!final && index === MAX_INDEX)) throw new Error('Transfer volume is too large.');
      total += BigInt(plaintext.length);
      const record = recordHeader(index, final, plaintext.length, total);
      checkAbort(options.signal);
      const encrypted = await crypto.subtle.encrypt({
        name: 'AES-GCM', iv: nonce(header.nonceBase, index),
        additionalData: concatenate(header.bytes, record), tagLength: 128,
      }, key, plaintext);
      checkAbort(options.signal);
      yield concatenate(record, new Uint8Array(encrypted));
      if (final) return;
      index += 1;
    }
  } finally {
    passphraseBytes.fill(0);
    await reader.close();
  }
}

// 逐块认证不代表整卷完整；调用方须等流正常结束后再提交业务资料。
export async function* decryptTransferStream(
  source: TransferByteSource,
  passphrase: string,
  options: TransferDecryptionOptions = {},
): TransferByteStream {
  checkAbort(options.signal);
  const expected = options.expectedMetadata === undefined ? undefined : validateMetadata(options.expectedMetadata);
  const passphraseBytes = validatePassphrase(passphrase);
  const reader = new ByteReader(source, options.signal);
  try {
    const header = await readHeader(reader);
    if (expected && (header.metadata.exportId !== expected.exportId || header.metadata.volumeId !== expected.volumeId)) {
      throw new Error('Transfer package or volume identity does not match.');
    }
    const key = await deriveKey(passphraseBytes, header.salt);
    checkAbort(options.signal);
    let index = 0;
    let total = 0n;
    let shortBlock = false;
    while (true) {
      const record = await reader.exact(RECORD_SIZE);
      const view = new DataView(record.buffer);
      const flag = record[4];
      const length = view.getUint32(5);
      if (index > MAX_INDEX || view.getUint32(0) !== index || (flag !== 0 && flag !== 1)
        || (flag === 1 ? length !== 0 : length < 1 || length > header.chunkSize || shortBlock || index === MAX_INDEX)
        || view.getBigUint64(9) !== total + BigInt(length)) throw invalidFormat();
      const ciphertext = await reader.exact(length + TAG_SIZE);
      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt({
          name: 'AES-GCM', iv: nonce(header.nonceBase, index),
          additionalData: concatenate(header.bytes, record), tagLength: 128,
        }, key, ciphertext);
      } catch {
        throw new Error('Transfer authentication failed or container is damaged.');
      }
      checkAbort(options.signal);
      if (flag === 1) {
        if ((await reader.readUpTo(1)).length !== 0) throw invalidFormat();
        return;
      }
      total += BigInt(length);
      shortBlock = length < header.chunkSize;
      index += 1;
      yield new Uint8Array(plaintext);
    }
  } finally {
    passphraseBytes.fill(0);
    await reader.close();
  }
}
