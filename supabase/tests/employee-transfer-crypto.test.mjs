import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';

const passphrase = '迁移密钥-𠮷-correct-horse-42';
const metadata = { exportId: 'export-测试-01', volumeId: 'volume-一-01' };
const script = fileURLToPath(new URL('../../scripts/decrypt-employee-export.mjs', import.meta.url));
let temporary;
let api;
let fixture;
let emptyFixture;
let otherVolume;
let otherExport;
const plaintext = Buffer.from('多字节 UTF-8 数据 𠮷 café\n'.repeat(30));

async function* fragments(bytes, sizes = [bytes.length || 1]) {
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const length = sizes[index++ % sizes.length];
    yield bytes.subarray(offset, offset + length);
    offset += length;
  }
}

async function collect(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function encrypt(bytes, meta = metadata, options = { chunkSize: 64 }, password = passphrase) {
  return collect(api.encryptTransferStream(fragments(bytes, [1, 7, 3, 64, 5]), password, meta, options));
}

function decrypt(bytes, password = passphrase, sizes = [1, 2, 13, 5, 79]) {
  return collect(api.decryptTransferStream(fragments(bytes, sizes), password));
}

function layout(bytes) {
  const headerEnd = 12 + bytes.readUInt32BE(8);
  const records = [];
  let offset = headerEnd;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset + 5);
    const end = offset + 17 + length + 16;
    records.push(bytes.subarray(offset, end));
    offset = end;
  }
  assert.equal(offset, bytes.length);
  return { header: bytes.subarray(0, headerEnd), records };
}

function replaceRecord(bytes, index, record) {
  const { header, records } = layout(bytes);
  records[index] = record;
  return Buffer.concat([header, ...records]);
}

function cli(input, output, password = passphrase, extra = [], env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, input, output, ...extra], {
      stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Standalone decryption timed out.'));
    }, 15000);
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      try {
        for (const secret of [passphrase, password.replace(/\r?\n$/, '')].filter(Boolean)) {
          assert.ok(!stdout.includes(secret) && !stderr.includes(secret));
        }
        resolve({ code, signal, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(password);
  });
}

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'employee-transfer-crypto-'));
  const output = join(temporary, 'crypto.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('../../src/lib/employeeTransfer/crypto.ts', import.meta.url))],
    outfile: output, bundle: true, format: 'esm', platform: 'browser', target: 'es2020', logLevel: 'silent',
  });
  api = await import(pathToFileURL(output).href);
  fixture = await encrypt(plaintext);
  emptyFixture = await encrypt(Buffer.alloc(0));
  otherVolume = await encrypt(plaintext, { ...metadata, volumeId: 'volume-二-02' });
  otherExport = await encrypt(plaintext, { ...metadata, exportId: 'export-另一个-02' });
});

after(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

test('固定安全常量与 UTF-8 多块、任意输入碎片往返', async () => {
  assert.equal(api.MIN_TRANSFER_PASSPHRASE_LENGTH, 14);
  assert.equal(api.PBKDF2_ITERATIONS, 600000);
  assert.equal(api.DEFAULT_TRANSFER_CHUNK_SIZE, 1024 * 1024);
  assert.deepEqual(await decrypt(fixture), plaintext);
  const { header, records } = layout(fixture);
  assert.equal(header.readUInt32BE(14), 600000);
  assert.equal(header[12], 1);
  assert.equal(header[13], 1);
  assert.ok(records.length > 10);
  const nonces = new Set();
  for (let index = 0; index < records.length; index++) {
    assert.equal(records[index].readUInt32BE(0), index);
    const nonce = Buffer.alloc(12);
    header.copy(nonce, 0, 38, 46);
    nonce.writeUInt32BE(index, 8);
    nonces.add(nonce.toString('hex'));
  }
  assert.equal(nonces.size, records.length);
});

test('空卷有经过认证的显式零长度结束记录', async () => {
  const { header, records } = layout(emptyFixture);
  assert.equal(records.length, 1);
  assert.equal(records[0][4], 1);
  assert.equal(records[0].length, 33);
  assert.equal(records[0].readBigUInt64BE(9), 0n);
  assert.deepEqual(await decrypt(emptyFixture), Buffer.alloc(0));
  await assert.rejects(decrypt(header));
  const changed = Buffer.from(emptyFixture);
  changed[changed.length - 1] ^= 1;
  await assert.rejects(decrypt(changed));
});

test('默认 1 MiB 分块跨边界且不聚合整个卷', async () => {
  const bytes = randomBytes(api.DEFAULT_TRANSFER_CHUNK_SIZE * 2 + 17);
  const encrypted = await collect(api.encryptTransferStream(fragments(bytes, [65537]), passphrase, metadata));
  const { header, records } = layout(encrypted);
  assert.equal(header.readUInt32BE(18), api.DEFAULT_TRANSFER_CHUNK_SIZE);
  assert.deepEqual(records.map(record => record.readUInt32BE(5)), [1048576, 1048576, 17, 0]);
  assert.deepEqual(await decrypt(encrypted, passphrase, [65521, 3, 131071]), bytes);
  const input = join(temporary, 'large.edx');
  const output = join(temporary, 'large.zip');
  await writeFile(input, encrypted);
  const result = await cli(input, output);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readFile(output), bytes);
});

test('整块输入、单字节块与 14 个 Unicode 字符口令', async () => {
  const bytes = randomBytes(73);
  const password = '𠮷'.repeat(14);
  const encrypted = await collect(api.encryptTransferStream(fragments(bytes), password, metadata, { chunkSize: 1 }));
  assert.deepEqual(await decrypt(encrypted, password, [encrypted.length]), bytes);
  const exact = await encrypt(Buffer.alloc(128, 1));
  assert.deepEqual(layout(exact).records.map(record => record.readUInt32BE(5)), [64, 64, 0]);
  assert.deepEqual(await decrypt(exact), Buffer.alloc(128, 1));
});

test('每卷随机 salt 和 nonce 基数；同一内容不会复用密文', async () => {
  const another = await encrypt(plaintext);
  assert.notDeepEqual(another.subarray(22, 38), fixture.subarray(22, 38));
  assert.notDeepEqual(another.subarray(38, 46), fixture.subarray(38, 46));
  assert.notDeepEqual(another, fixture);
});

test('错误口令不泄漏输入且不会输出首块', async () => {
  const wrong = 'wrong-password-private-0987654321';
  let yielded = 0;
  await assert.rejects(async () => {
    for await (const chunk of api.decryptTransferStream(fragments(fixture), wrong)) yielded += chunk.length;
  }, error => !error.message.includes(wrong) && /authentication/i.test(error.message));
  assert.equal(yielded, 0);
  await assert.rejects(decrypt(emptyFixture, wrong));
});

test('认证精确头部字节：ID、salt、nonce、块大小与版本', async t => {
  const exportLength = fixture.readUInt16BE(46);
  for (const [name, offset] of [
    ['magic', 0], ['version', 7], ['salt', 22], ['nonce', 38],
    ['exportId', 50], ['volumeId', 50 + exportLength], ['chunkSize', 21],
  ]) {
    await t.test(name, async () => {
      const changed = Buffer.from(fixture);
      changed[offset] ^= 1;
      await assert.rejects(decrypt(changed));
    });
  }
});

test('密文和认证标签翻转被拒绝，包括最后结束块', async t => {
  const { records } = layout(fixture);
  for (const [name, index, offset] of [
    ['ciphertext', 0, 17], ['tag', 1, records[1].length - 1],
    ['final-tag', records.length - 1, 32],
  ]) {
    await t.test(name, async () => {
      const record = Buffer.from(records[index]);
      record[offset] ^= 1;
      await assert.rejects(decrypt(replaceRecord(fixture, index, record)));
    });
  }
});

test('块序号、标志、长度、累计长度均认证', async t => {
  const { records } = layout(fixture);
  for (const [name, index, offset] of [
    ['index', 0, 3], ['flag', 0, 4], ['length', 0, 8], ['total', 0, 16],
    ['final-flag', records.length - 1, 4], ['final-total', records.length - 1, 16],
  ]) {
    await t.test(name, async () => {
      const record = Buffer.from(records[index]);
      record[offset] ^= 1;
      await assert.rejects(decrypt(replaceRecord(fixture, index, record)));
    });
  }
});

test('拒绝截断、缺末块、重排、重复、删除块和尾部追加', async t => {
  const { header, records } = layout(fixture);
  const swapped = [...records];
  [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
  const attacks = [
    ['truncated-prefix', fixture.subarray(0, 11)],
    ['truncated-header', fixture.subarray(0, header.length - 1)],
    ['truncated-data', fixture.subarray(0, header.length + 29)],
    ['truncated-tag', fixture.subarray(0, fixture.length - 1)],
    ['no-final', Buffer.concat([header, ...records.slice(0, -1)])],
    ['reordered', Buffer.concat([header, ...swapped])],
    ['duplicate', Buffer.concat([header, records[0], ...records])],
    ['deleted', Buffer.concat([header, ...records.slice(1)])],
    ['appended-byte', Buffer.concat([fixture, Buffer.from([0])])],
    ['appended-final', Buffer.concat([fixture, records.at(-1)])],
    ['appended-volume', Buffer.concat([fixture, otherVolume])],
  ];
  for (const [name, attack] of attacks) await t.test(name, () => assert.rejects(decrypt(attack)));
});

test('恶意记录长度、结束标志和序号在分配前拒绝', async t => {
  const { records } = layout(fixture);
  for (const [name, mutate] of [
    ['huge-length', record => record.writeUInt32BE(0xffffffff, 5)],
    ['zero-data-length', record => record.writeUInt32BE(0, 5)],
    ['unknown-flag', record => { record[4] = 2; }],
    ['overflow-index', record => record.writeUInt32BE(0xffffffff, 0)],
  ]) {
    await t.test(name, async () => {
      const record = Buffer.from(records[0]);
      mutate(record);
      await assert.rejects(decrypt(replaceRecord(fixture, 0, record)), /Invalid/);
    });
  }
});

test('跨卷、跨包与同身份重新加密的块替换均被拒绝', async () => {
  for (const other of [otherVolume, otherExport, await encrypt(plaintext)]) {
    const record = layout(other).records[0];
    await assert.rejects(decrypt(replaceRecord(fixture, 0, record)));
  }
});

test('短口令、非法 Unicode 与无效元数据拒绝且不读取 source', async () => {
  let pulls = 0;
  async function* source() { pulls++; yield Buffer.from([1]); }
  for (const password of ['short', 'x'.repeat(13), '𠮷'.repeat(13), '\ud800'.repeat(14), 'x'.repeat(4097), 'x'.repeat(14) + '\n']) {
    await assert.rejects(collect(api.encryptTransferStream(source(), password, metadata)));
    await assert.rejects(collect(api.decryptTransferStream(source(), password)));
  }
  for (const invalid of [null, {}, { exportId: '', volumeId: 'v' }, { ...metadata, extra: 1 },
    { exportId: '../outside', volumeId: 'v' }, { exportId: 'x'.repeat(257), volumeId: 'v' },
    { exportId: 1, volumeId: 'v' }, { exportId: 'e', volumeId: '\ud800' },
    { exportId: 'e', volumeId: ' ' }, { exportId: 'e', volumeId: 'x\u0000' },
  ]) await assert.rejects(collect(api.encryptTransferStream(source(), passphrase, invalid)));
  for (const chunkSize of [0, -1, 1.5, NaN, Infinity, api.MAX_TRANSFER_CHUNK_SIZE + 1]) {
    await assert.rejects(collect(api.encryptTransferStream(source(), passphrase, metadata, { chunkSize })));
  }
  assert.equal(pulls, 0);
});

test('恶意头部在读取记录前拒绝，不允许扩大 KDF 或分配', async t => {
  const { header } = layout(fixture);
  const cases = [
    ['huge-header', bytes => bytes.writeUInt32BE(0xffffffff, 8)],
    ['short-header', bytes => bytes.writeUInt32BE(1, 8)],
    ['algorithm', bytes => { bytes[12] = 2; }],
    ['kdf', bytes => { bytes[13] = 2; }],
    ['huge-iterations', bytes => bytes.writeUInt32BE(0xffffffff, 14)],
    ['weak-iterations', bytes => bytes.writeUInt32BE(1, 14)],
    ['huge-chunk', bytes => bytes.writeUInt32BE(0xffffffff, 18)],
    ['zero-chunk', bytes => bytes.writeUInt32BE(0, 18)],
    ['id-length', bytes => bytes.writeUInt16BE(0xffff, 46)],
    ['zero-id', bytes => bytes.writeUInt16BE(0, 48)],
    ['bad-utf8', bytes => { bytes[50] = 0xff; }],
    ['surrogate-utf8', bytes => { bytes.set([0xed, 0xa0, 0x80], 50); }],
    ['bom-id', bytes => { bytes.set([0xef, 0xbb, 0xbf], 50); }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const changed = Buffer.from(header);
      mutate(changed);
      let readBeyondHeader = false;
      async function* source() {
        yield changed;
        readBeyondHeader = true;
        throw new Error('Parser must reject this header before reading records.');
      }
      await assert.rejects(collect(api.decryptTransferStream(source(), passphrase)), /Invalid/);
      assert.equal(readBeyondHeader, false);
    });
  }
});

test('bounded source：加密背压、读取上限及取消消费关闭源', async () => {
  let pulls = 0;
  let closed = false;
  async function* source() {
    try {
      for (let i = 0; i < 1000000; i++) { pulls++; yield Buffer.alloc(64, i % 256); }
    } finally { closed = true; }
  }
  const iterator = api.encryptTransferStream(source(), passphrase, metadata, { chunkSize: 64 });
  await iterator.next();
  assert.equal(pulls, 0);
  await iterator.next();
  assert.equal(pulls, 1);
  await iterator.next();
  assert.equal(pulls, 2);
  await iterator.return();
  assert.equal(closed, true);
  let decryptedPulls = 0;
  let decryptionClosed = false;
  const { header, records } = layout(fixture);
  async function* encryptedSource() {
    try {
      decryptedPulls++; yield header;
      for (const record of records) { decryptedPulls++; yield record; }
    } finally { decryptionClosed = true; }
  }
  const decryption = api.decryptTransferStream(encryptedSource(), passphrase);
  const first = await decryption.next();
  assert.deepEqual(Buffer.from(first.value), plaintext.subarray(0, 64));
  assert.equal(decryptedPulls, 2);
  await decryption.return();
  assert.equal(decryptionClosed, true);
  const oversized = Buffer.alloc(api.MAX_TRANSFER_INPUT_CHUNK_SIZE + 1);
  await assert.rejects(collect(api.encryptTransferStream(fragments(oversized), passphrase, metadata)));
  await assert.rejects(collect(api.decryptTransferStream(fragments(oversized), passphrase)));
  async function* invalidSource() { yield 'not bytes'; }
  await assert.rejects(collect(api.encryptTransferStream(invalidSource(), passphrase, metadata)));
  await assert.rejects(collect(api.decryptTransferStream(invalidSource(), passphrase)));
});

test('空输入碎片合法，源错误向外传播并关闭源', async () => {
  async function* source() { yield Buffer.alloc(0); yield plaintext; yield Buffer.alloc(0); }
  const encrypted = await collect(api.encryptTransferStream(source(), passphrase, metadata));
  assert.deepEqual(await decrypt(encrypted), plaintext);
  let closed = false;
  async function* failingSource() {
    try { yield Buffer.alloc(64); throw new Error('Synthetic source failure.'); }
    finally { closed = true; }
  }
  await assert.rejects(collect(api.encryptTransferStream(failingSource(), passphrase, metadata, { chunkSize: 64 })), /Synthetic/);
  assert.equal(closed, true);
});

test('abort：开始前、中途和等待 source 时均拒绝', async () => {
  const early = new AbortController();
  early.abort('private cancellation reason');
  await assert.rejects(collect(api.encryptTransferStream(fragments(plaintext), passphrase, metadata, { signal: early.signal })), { name: 'AbortError' });
  const controller = new AbortController();
  let closed = false;
  async function* source() {
    try { while (true) yield Buffer.alloc(64); }
    finally { closed = true; }
  }
  const iterator = api.encryptTransferStream(source(), passphrase, metadata, { chunkSize: 64, signal: controller.signal });
  await iterator.next();
  await iterator.next();
  controller.abort();
  await assert.rejects(iterator.next(), { name: 'AbortError' });
  assert.equal(closed, true);
  const waiting = new AbortController();
  let returned = false;
  let resolveNext;
  const stalled = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(resolve => { resolveNext = resolve; }),
        return: async () => { returned = true; return { done: true }; },
      };
    },
  };
  const paused = api.encryptTransferStream(stalled, passphrase, metadata, { signal: waiting.signal });
  await paused.next();
  const pending = paused.next();
  await new Promise(resolve => setImmediate(resolve));
  waiting.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  resolveNext({ done: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(returned, true);
});

test('Standalone Node20 用 node:crypto 跨实现解密空卷、多块及 UTF-8 口令', async () => {
  for (const [name, bytes, expected, password] of [
    ['multi', fixture, plaintext, passphrase],
    ['empty', emptyFixture, Buffer.alloc(0), passphrase],
    ['empty-zip', await encrypt(Buffer.from('504b0506000000000000000000000000000000000000', 'hex')),
      Buffer.from('504b0506000000000000000000000000000000000000', 'hex'), passphrase],
    ['unicode', await encrypt(plaintext, metadata, { chunkSize: 97 }, '𠮷'.repeat(14)), plaintext, '𠮷'.repeat(14)],
  ]) {
    const input = join(temporary, `${name}.edx`);
    const output = join(temporary, `${name}.zip`);
    await writeFile(input, bytes);
    const result = await cli(input, output, `${password}\n`);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await readFile(output), expected);
  }
  assert.deepEqual((await readdir(temporary)).filter(name => name.endsWith('.tmp')), []);
});

test('Standalone 拒绝损坏、缺结束、追加、跨卷和恶意头；清理自己的临时文件', async t => {
  const { header, records } = layout(fixture);
  const corrupted = Buffer.from(fixture);
  corrupted[corrupted.length - 1] ^= 1;
  const huge = Buffer.from(fixture);
  huge.writeUInt32BE(0xffffffff, 14);
  const utf8 = Buffer.from(fixture);
  utf8[50] = 0xff;
  for (const [name, bytes, password] of [
    ['wrong-password', fixture, 'incorrect-password-123456'],
    ['bad-tag', corrupted, passphrase],
    ['no-final', Buffer.concat([header, ...records.slice(0, -1)]), passphrase],
    ['appended', Buffer.concat([fixture, Buffer.from([1])]), passphrase],
    ['cross-volume', replaceRecord(fixture, 0, layout(otherVolume).records[0]), passphrase],
    ['huge-kdf', huge, passphrase], ['invalid-utf8', utf8, passphrase],
  ]) {
    await t.test(name, async () => {
      const input = join(temporary, `bad-${name}.edx`);
      const output = join(temporary, `bad-${name}.zip`);
      await writeFile(input, bytes);
      assert.notEqual((await cli(input, output, password)).code, 0);
      await assert.rejects(readFile(output), { code: 'ENOENT' });
      assert.deepEqual((await readdir(temporary)).filter(value => value.endsWith('.tmp')), []);
    });
  }
});

test('Standalone 不覆盖文件/符号链接，忽略环境口令并禁止口令参数', async () => {
  const input = join(temporary, 'safe.edx');
  const output = join(temporary, 'protected.zip');
  const original = Buffer.from('keep this existing file');
  const unrelated = join(temporary, '.unrelated.tmp');
  await writeFile(input, fixture);
  await writeFile(output, original);
  await writeFile(unrelated, original);
  assert.notEqual((await cli(input, output)).code, 0);
  assert.deepEqual(await readFile(output), original);
  const symlinkOutput = join(temporary, 'symlink.zip');
  await symlink(output, symlinkOutput);
  assert.notEqual((await cli(input, symlinkOutput)).code, 0);
  assert.deepEqual(await readFile(output), original);
  assert.deepEqual(await readFile(unrelated), original);
  assert.deepEqual((await readdir(temporary)).filter(value => value.endsWith('.tmp')), ['.unrelated.tmp']);
  await rm(unrelated);
  const argumentOutput = join(temporary, 'argument.zip');
  assert.notEqual((await cli(input, argumentOutput, '', [passphrase])).code, 0);
  const envOutput = join(temporary, 'environment.zip');
  assert.notEqual((await cli(input, envOutput, '', [], { ...process.env, TRANSFER_PASSPHRASE: passphrase })).code, 0);
  assert.notEqual((await cli(input, join(temporary, 'not-a-zip.txt'))).code, 0);
  for (const path of [argumentOutput, envOutput, join(temporary, 'not-a-zip.txt')]) {
    await assert.rejects(readFile(path), { code: 'ENOENT' });
  }
});
