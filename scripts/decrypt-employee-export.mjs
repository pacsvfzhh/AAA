import { createDecipheriv, pbkdf2, randomUUID } from 'node:crypto';
import { open, link, unlink } from 'node:fs/promises';
import { dirname, basename, resolve, extname } from 'node:path';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);
const MAGIC = Buffer.from('EDXSTRM1', 'ascii');
const ITERATIONS = 600000;
const MAX_HEADER = 1024;
const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_INPUT_CHUNK = 8 * 1024 * 1024;
const MAX_INDEX = 0xffffffff;
const RECORD_SIZE = 17;
const failure = () => new Error('Invalid transfer container or passphrase.');

function checkAbort(signal) {
  if (signal.aborted) throw new Error('Decryption cancelled.');
}

function passwordBytes(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length > 4096
    || /[\uD800-\uDFFF]/u.test(passphrase)
    || [...passphrase].some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
    || [...passphrase].length < 14) throw failure();
  const bytes = Buffer.from(passphrase, 'utf8');
  if (bytes.length > 4096) throw failure();
  return bytes;
}

function validId(value) {
  return Buffer.byteLength(value, 'utf8') <= 256
    && /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._:-]*$/u.test(value);
}

class ByteReader {
  constructor(source, signal) {
    this.iterator = source[Symbol.asyncIterator]();
    this.signal = signal;
    this.current = Buffer.alloc(0);
    this.offset = 0;
    this.ended = false;
  }

  async readUpTo(length) {
    const result = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      checkAbort(this.signal);
      if (this.offset === this.current.length) {
        this.current = Buffer.alloc(0);
        this.offset = 0;
        if (this.ended) break;
        const next = await this.iterator.next();
        checkAbort(this.signal);
        if (next.done) {
          this.ended = true;
          break;
        }
        if (!(next.value instanceof Uint8Array) || next.value.length > MAX_INPUT_CHUNK) throw failure();
        this.current = next.value;
        if (!this.current.length) continue;
      }
      const count = Math.min(length - written, this.current.length - this.offset);
      result.set(this.current.subarray(this.offset, this.offset + count), written);
      written += count;
      this.offset += count;
    }
    return result.subarray(0, written);
  }

  async exact(length) {
    const bytes = await this.readUpTo(length);
    if (bytes.length !== length) throw failure();
    return bytes;
  }

  async close() {
    this.current = Buffer.alloc(0);
    if (!this.ended && this.iterator.return) await this.iterator.return();
  }
}

async function readHeader(reader) {
  const prefix = await reader.exact(12);
  const size = prefix.readUInt32BE(8);
  if (!prefix.subarray(0, 8).equals(MAGIC) || size < 40 || size > MAX_HEADER) throw failure();
  const payload = await reader.exact(size);
  const chunkSize = payload.readUInt32BE(6);
  const exportLength = payload.readUInt16BE(34);
  const volumeLength = payload.readUInt16BE(36);
  if (payload[0] !== 1 || payload[1] !== 1 || payload.readUInt32BE(2) !== ITERATIONS
    || chunkSize < 1 || chunkSize > MAX_CHUNK
    || exportLength < 1 || exportLength > 256 || volumeLength < 1 || volumeLength > 256
    || size !== 38 + exportLength + volumeLength) throw failure();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const exportId = decoder.decode(payload.subarray(38, 38 + exportLength));
  const volumeId = decoder.decode(payload.subarray(38 + exportLength));
  if (!validId(exportId) || !validId(volumeId)) throw failure();
  return {
    bytes: Buffer.concat([prefix, payload]),
    salt: payload.subarray(10, 26),
    nonceBase: payload.subarray(26, 34),
    chunkSize,
  };
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
    if (bytesWritten === 0) throw failure();
    offset += bytesWritten;
  }
}

async function decryptFile(inputPath, outputPath, passphrase, signal) {
  const password = passwordBytes(passphrase);
  const input = resolve(inputPath);
  const output = resolve(outputPath);
  if (input === output || extname(output).toLowerCase() !== '.zip') {
    password.fill(0);
    throw failure();
  }
  const temporary = resolve(dirname(output), `.${basename(output)}.${randomUUID()}.tmp`);
  let inputFile;
  let outputFile;
  let reader;
  let created = false;
  let key;
  try {
    checkAbort(signal);
    inputFile = await open(input, 'r');
    const stream = inputFile.createReadStream({ highWaterMark: 64 * 1024, autoClose: false });
    const abort = () => stream.destroy(new Error('Decryption cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      reader = new ByteReader(stream, signal);
      const header = await readHeader(reader);
      key = await derive(password, header.salt, ITERATIONS, 32, 'sha256');
      password.fill(0);
      checkAbort(signal);
      outputFile = await open(temporary, 'wx', 0o600);
      created = true;
      let index = 0;
      let total = 0n;
      let shortBlock = false;
      while (true) {
        const record = await reader.exact(RECORD_SIZE);
        const flag = record[4];
        const length = record.readUInt32BE(5);
        if (index > MAX_INDEX || record.readUInt32BE(0) !== index || (flag !== 0 && flag !== 1)
          || (flag === 1 ? length !== 0 : length < 1 || length > header.chunkSize || shortBlock || index === MAX_INDEX)
          || record.readBigUInt64BE(9) !== total + BigInt(length)) throw failure();
        const ciphertext = await reader.exact(length + 16);
        const iv = Buffer.alloc(12);
        header.nonceBase.copy(iv);
        iv.writeUInt32BE(index, 8);
        const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
        decipher.setAAD(Buffer.concat([header.bytes, record]));
        decipher.setAuthTag(ciphertext.subarray(length));
        const first = decipher.update(ciphertext.subarray(0, length));
        const last = decipher.final();
        checkAbort(signal);
        if (flag === 1) {
          if ((await reader.readUpTo(1)).length !== 0) throw failure();
          break;
        }
        await writeAll(outputFile, first);
        await writeAll(outputFile, last);
        total += BigInt(length);
        shortBlock = length < header.chunkSize;
        index += 1;
      }
      await outputFile.sync();
      await outputFile.close();
      outputFile = undefined;
      checkAbort(signal);
      await link(temporary, output);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  } finally {
    password.fill(0);
    key?.fill(0);
    try {
      await reader?.close();
    } finally {
      try {
        await inputFile?.close();
      } finally {
        try {
          await outputFile?.close();
        } finally {
          if (created) await unlink(temporary);
        }
      }
    }
  }
}

async function readPipedPassphrase(signal) {
  let bytes = Buffer.alloc(0);
  const abort = () => process.stdin.destroy(new Error('Decryption cancelled.'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    checkAbort(signal);
    for await (const chunk of process.stdin) {
      checkAbort(signal);
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length + value.length > 4098) throw failure();
      const previous = bytes;
      bytes = Buffer.concat([previous, value]);
      previous.fill(0);
    }
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    return decoder.decode(bytes).replace(/\r?\n$/, '');
  } finally {
    signal.removeEventListener('abort', abort);
    bytes.fill(0);
  }
}

async function readHiddenPassphrase(signal) {
  process.stderr.write('Transfer passphrase (hidden): ');
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  try {
    return await new Promise((resolvePassword, reject) => {
      let value = '';
      const cleanup = () => {
        stdin.removeListener('data', data);
        stdin.removeListener('end', end);
        stdin.removeListener('error', error);
        signal.removeEventListener('abort', abort);
      };
      const finish = errorValue => {
        cleanup();
        const result = value;
        value = '';
        if (errorValue) reject(failure());
        else resolvePassword(result);
      };
      const data = chunk => {
        for (const character of chunk) {
          if (character === '\r' || character === '\n') { finish(false); return; }
          if (character === '\u0003' || character === '\u0004') { finish(true); return; }
          if (character === '\u007f' || character === '\b') value = [...value].slice(0, -1).join('');
          else value += character;
          if (Buffer.byteLength(value, 'utf8') > 4096) { finish(true); return; }
        }
      };
      const end = () => finish(true);
      const error = () => finish(true);
      const abort = () => finish(true);
      stdin.on('data', data);
      stdin.once('end', end);
      stdin.once('error', error);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally {
    stdin.setRawMode(wasRaw);
    stdin.pause();
    process.stderr.write('\n');
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some(arg => arg.startsWith('--'))) {
    process.stderr.write('Usage: node decrypt-employee-export.mjs INPUT.edx OUTPUT.zip\nPassphrase: hidden terminal prompt or UTF-8 stdin (one line).\n');
    process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let passphrase;
  try {
    passphrase = process.stdin.isTTY
      ? await readHiddenPassphrase(controller.signal)
      : await readPipedPassphrase(controller.signal);
    await decryptFile(args[0], args[1], passphrase, controller.signal);
    process.stdout.write('Decryption complete.\n');
  } catch {
    process.stderr.write('Decryption failed: invalid input/passphrase, cancelled, or output unavailable. No existing output was replaced.\n');
    process.exitCode = 1;
  } finally {
    passphrase = undefined;
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

await main();
