import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Unzip, zipSync, unzipSync } from 'fflate';

const root = new URL('../../', import.meta.url);
const passphrase = 'local-only-correct-horse-2026';
const info = {
  exportId: 'export-本地-1', volumeId: 'volume-1',
  sourceSiteId: '82f20fb2-1122-4433-8a99-010203040506',
  createdAt: '2026-10-17T01:02:03.000Z', scope: 'full-site', volumeIndex: 1, volumeCount: 1,
};
const expectedMetadata = { exportId: info.exportId, volumeId: info.volumeId };
const data = Buffer.from('{"opaque":"中文𠮷"}\n{"n":2}\n');
const media = Buffer.concat([randomBytes(143), Buffer.from('PK\x03\x04PK\x07\x08PK\x01\x02PK\x05\x06'), randomBytes(43)]);
const files = [
  { path: 'data/users.ndjson', bytes: data },
  { path: 'media/chat-images/nested/photo.png', bytes: media },
  { path: 'media/content-audit-evidence/empty.bin', bytes: Buffer.alloc(0) },
];
let temporary;
let api;
let manifestApi;
let cryptoApi;
let fixture;
let encryptedFixture;
let manifest;

function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function* fragments(bytes, sizes = [65521]) {
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
async function* entries(items = files) {
  for (const item of items) yield { path: item.path, bytes: item.bytes.length, open: () => fragments(item.bytes, [1, 7, 3, 65521]) };
}
function temporarySink() {
  const chunks = new Map();
  return {
    aborts: 0, calls: 0, chunks,
    async append(path, bytes) {
      this.calls++;
      if (!chunks.has(path)) chunks.set(path, []);
      chunks.get(path).push(Buffer.from(bytes));
    },
    async abort() { this.aborts++; chunks.clear(); },
  };
}
async function rejectPlain(bytes, options = {}, sizes) {
  const sink = temporarySink();
  let verified;
  await assert.rejects(async () => { verified = await api.verifyPlainVolume(fragments(bytes, sizes), sink, options); });
  assert.equal(verified, undefined);
  assert.equal(sink.aborts, 1);
  assert.equal(sink.chunks.size, 0);
  return sink;
}
async function rejectEncrypted(bytes, options = {}, password = passphrase) {
  const sink = temporarySink();
  let verified;
  await assert.rejects(async () => {
    verified = await api.verifyEncryptedVolume(fragments(bytes), password, sink, { expectedMetadata, ...options });
  });
  assert.equal(verified, undefined);
  assert.equal(sink.aborts, 1);
  assert.equal(sink.chunks.size, 0);
  return sink;
}
function manifestFor(items = files, identity = info) {
  return {
    version: 1, ...identity,
    entries: items.map(item => ({ path: item.path, bytes: item.bytes.length, sha256: hash(item.bytes),
      kind: item.path.startsWith('data/') ? 'ndjson' : 'media' })),
  };
}
function manifestFile(value = manifestFor()) {
  return { path: 'manifest.json', bytes: manifestApi.serializeManifest(value) };
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
// Independent ZIP fixture builder (not production writer); optional descriptors, exact central directory.
function rawZip(items) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const item of items) {
    const name = Buffer.from(item.path);
    const bytes = Buffer.from(item.bytes);
    const crc = crc32(bytes);
    const flags = item.descriptor ? 8 : 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(item.method ?? 0, 8);
    local.writeUInt32LE(flags ? 0 : crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const descriptor = Buffer.alloc(item.descriptor ? 16 : 0);
    if (item.descriptor) {
      descriptor.writeUInt32LE(0x08074b50);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeUInt32LE(bytes.length, 8);
      descriptor.writeUInt32LE(bytes.length, 12);
    }
    locals.push(local, bytes, descriptor);
    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(item.method ?? 0, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(bytes.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    name.copy(header, 46);
    central.push(header);
    offset += local.length + bytes.length + descriptor.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
function layout(bytes) {
  const result = [];
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const size = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength;
    const descriptor = bytes.readUInt16LE(offset + 6) & 8 ? 16 : 0;
    result.push({ offset, start, size, end: start + size, nameLength });
    offset = start + size + descriptor;
  }
  return { entries: result, central: offset, eocd: bytes.length - 22 };
}
function encryptedLayout(bytes) {
  const header = 12 + bytes.readUInt32BE(8);
  let offset = header;
  const records = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset + 5);
    records.push({ offset, end: offset + 17 + length + 16 });
    offset += 17 + length + 16;
  }
  return { header, records };
}

before(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'employee-transfer-container-'));
  const outputs = ['container', 'manifest', 'crypto'];
  const modules = await Promise.all(outputs.map(async name => {
    const output = join(temporary, `${name}.mjs`);
    await build({ entryPoints: [fileURLToPath(new URL(`src/lib/employeeTransfer/${name}.ts`, root))],
      outfile: output, bundle: true, format: 'esm', platform: 'browser', target: 'es2020', logLevel: 'silent' });
    return import(pathToFileURL(output).href);
  }));
  [api, manifestApi, cryptoApi] = modules;
  fixture = await collect(api.writePlainVolume(entries(), info));
  manifest = manifestFor();
  encryptedFixture = await collect(api.writeEncryptedVolume(entries(), info, passphrase, { chunkSize: 113 }));
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

test('plain and encrypted roundtrip, reference SHA-256, last manifest and actual progress', async () => {
  const writing = [];
  const zip = await collect(api.writePlainVolume(entries(), info, { onProgress: value => writing.push(value) }));
  assert.deepEqual(zip, fixture);
  const independent = unzipSync(zip);
  assert.deepEqual(Object.keys(independent), [...files.map(file => file.path), 'manifest.json']);
  assert.deepEqual(JSON.parse(Buffer.from(independent['manifest.json']).toString()), manifest);
  const verification = [];
  const sink = temporarySink();
  assert.deepEqual(await api.verifyPlainVolume(fragments(zip, [1, 3, 7, 113]), sink,
    { expectedMetadata, onProgress: value => verification.push(value) }), manifest);
  for (const item of files) assert.deepEqual(Buffer.concat(sink.chunks.get(item.path)), item.bytes);
  for (const progress of [writing, verification]) {
    assert.ok(progress.length > 0);
    assert.equal(progress.at(-1).bytes, files.reduce((sum, file) => sum + file.bytes.length, 0));
    assert.equal(progress.at(-1).entries, files.length);
    for (let i = 1; i < progress.length; i++) {
      assert.ok(progress[i].bytes >= progress[i - 1].bytes);
      assert.ok(progress[i].entries >= progress[i - 1].entries);
      assert.ok(!('percent' in progress[i]));
    }
  }
  const encryptedSink = temporarySink();
  assert.deepEqual(await api.verifyEncryptedVolume(fragments(encryptedFixture, [1, 11, 331]), passphrase,
    encryptedSink, { expectedMetadata }), manifest);
  assert.equal(encryptedSink.aborts, 0);
});

test('empty volume and empty UTF-8 entries are valid without fake byte progress', async () => {
  const progress = [];
  const bytes = await collect(api.writePlainVolume(entries([]), info, { onProgress: value => progress.push(value) }));
  const sink = temporarySink();
  assert.deepEqual(await api.verifyPlainVolume(fragments(bytes), sink), manifestFor([]));
  assert.equal(sink.calls, 0);
  assert.deepEqual(progress, []);
  const empty = [{ path: 'data/empty.ndjson', bytes: Buffer.alloc(0) }];
  assert.deepEqual(await api.verifyPlainVolume(fragments(rawZip([...empty, manifestFile(manifestFor(empty))])), temporarySink()), manifestFor(empty));
});

test('all seven allowed buckets and signature-looking media work with one-byte boundaries', async () => {
  const items = manifestApi.MEDIA_BUCKETS.map(bucket => ({ path: `media/${bucket}/a/sub.bin`, bytes: media }));
  const bytes = await collect(api.writePlainVolume(entries(items), info));
  assert.deepEqual(await api.verifyPlainVolume(fragments(bytes, [1]), temporarySink()), manifestFor(items));
});

test('fflate.Unzip one-byte interoperability preserves every PK signature inside media', async () => {
  const signatures = Buffer.from('PK\x03\x04PK\x07\x08PK\x01\x02PK\x05\x06');
  const payload = Buffer.concat([signatures, media, signatures, signatures]);
  const items = [{ path: 'media/chat-images/signatures.bin', bytes: payload },
    { path: 'data/empty.ndjson', bytes: Buffer.alloc(0) }];
  const bytes = await collect(api.writePlainVolume(entries(items), info));
  const extracted = new Map();
  const ended = new Set();
  const unzip = new Unzip(file => {
    assert.equal(file.compression, 0);
    assert.ok(!extracted.has(file.name));
    extracted.set(file.name, []);
    file.ondata = (error, chunk, final) => {
      assert.ifError(error);
      extracted.get(file.name).push(Buffer.from(chunk));
      if (final) ended.add(file.name);
    };
    file.start();
  });
  for (let index = 0; index < bytes.length; index++) unzip.push(bytes.subarray(index, index + 1), index === bytes.length - 1);
  assert.deepEqual([...extracted.keys()], [...items.map(item => item.path), 'manifest.json']);
  assert.equal(ended.size, extracted.size);
  for (const item of items) assert.deepEqual(Buffer.concat(extracted.get(item.path)), item.bytes);
  assert.deepEqual(JSON.parse(Buffer.concat(extracted.get('manifest.json')).toString()), manifestFor(items));
  for (const entry of layout(bytes).entries) {
    assert.equal(bytes.readUInt16LE(entry.offset + 6), 0);
    assert.equal(bytes.readUInt32LE(entry.offset + 14), crc32(bytes.subarray(entry.start, entry.end)));
    assert.equal(bytes.readUInt32LE(entry.offset + 18), entry.size);
  }
});

test('sink retains independent Uint8Arrays when a Buffer producer reuses and zeroes its storage at EOF', async () => {
  for (const chunkSize of [fixture.length, 97]) {
    const reusable = Buffer.alloc(chunkSize);
    const retained = new Map();
    async function* source() {
      for (let offset = 0; offset < fixture.length; offset += reusable.length) {
        reusable.fill(0);
        const length = Math.min(reusable.length, fixture.length - offset);
        fixture.copy(reusable, 0, offset, offset + length);
        yield reusable.subarray(0, length);
      }
      reusable.fill(0);
    }
    const sink = {
      async append(path, chunk) {
        assert.equal(Buffer.isBuffer(chunk), false);
        if (!retained.has(path)) retained.set(path, []);
        retained.get(path).push(chunk); // Deliberately retain the exact supplied reference, no defensive copy.
      },
      async abort() { assert.fail('unexpected abort'); },
    };
    assert.deepEqual(await api.verifyPlainVolume(source(), sink), manifest);
    assert.ok(reusable.every(byte => byte === 0));
    for (const file of files) assert.deepEqual(Buffer.concat(retained.get(file.path)), file.bytes);
  }
});

test('only flags=0 stored ZIP is supported; all descriptor profiles are rejected before any append', async () => {
  assert.deepEqual(await api.verifyPlainVolume(fragments(rawZip([...files, manifestFile()])), temporarySink()), manifest);
  for (const advertised of ['known', 'zero', 'zip64']) {
    const bytes = rawZip([...files.map(file => ({ ...file, descriptor: true })), manifestFile()]);
    if (advertised !== 'known') {
      bytes.writeUInt32LE(advertised === 'zero' ? 0 : 0xffffffff, 18);
      bytes.writeUInt32LE(advertised === 'zero' ? 0 : 0xffffffff, 22);
    }
    assert.equal((await rejectPlain(bytes)).calls, 0);
  }
});

test('wrong passphrase, ciphertext/header/final tag tamper, missing final and trailing ciphertext abort once', async t => {
  await t.test('wrong passphrase', () => rejectEncrypted(encryptedFixture, {}, 'not-the-correct-passphrase'));
  const { records } = encryptedLayout(encryptedFixture);
  for (const [name, offset] of [['header', 50], ['ciphertext', records[0].offset + 17],
    ['end tag', encryptedFixture.length - 1]]) {
    await t.test(name, async () => {
      const changed = Buffer.from(encryptedFixture);
      changed[offset] ^= 1;
      await rejectEncrypted(changed);
    });
  }
  await t.test('missing final', () => rejectEncrypted(encryptedFixture.subarray(0, records.at(-1).offset)));
  await t.test('truncated tag', () => rejectEncrypted(encryptedFixture.subarray(0, -1)));
  await t.test('extra ciphertext', () => rejectEncrypted(Buffer.concat([encryptedFixture, Buffer.from([0])])));
});

test('no verified result until encrypted final authentication has completed, even after all temp appends', async () => {
  const { records } = encryptedLayout(encryptedFixture);
  const final = records.at(-1).offset;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sink = temporarySink();
  let settled = false;
  async function* source() {
    yield encryptedFixture.subarray(0, final);
    await gate;
    yield encryptedFixture.subarray(final);
  }
  const result = api.verifyEncryptedVolume(source(), passphrase, sink, { expectedMetadata }).then(value => { settled = true; return value; });
  for (let i = 0; i < 1000 && sink.calls < 3; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(sink.calls >= 3);
  assert.equal(settled, false);
  release();
  assert.deepEqual(await result, manifest);
  const damaged = Buffer.from(encryptedFixture);
  damaged[damaged.length - 1] ^= 1;
  const failed = await rejectEncrypted(damaged);
  assert.ok(failed.calls > 0, 'temporary bytes must still be discarded after late authentication failure');
});

test('authenticated outer IDs and manifest IDs are both bound to caller metadata', async () => {
  for (const expected of [{ ...expectedMetadata, volumeId: 'other' }, { ...expectedMetadata, exportId: 'other' }]) {
    await rejectEncrypted(encryptedFixture, { expectedMetadata: expected });
    await rejectPlain(fixture, { expectedMetadata: expected });
  }
  const mismatchedOuter = await collect(cryptoApi.encryptTransferStream(fragments(fixture), passphrase,
    { ...expectedMetadata, volumeId: 'other' }));
  await rejectEncrypted(mismatchedOuter);
  await rejectEncrypted(mismatchedOuter, { expectedMetadata: { ...expectedMetadata, volumeId: 'other' } });
  await rejectEncrypted(encryptedFixture, { expectedMetadata: undefined });
});

test('valid encryption cannot make a ZIP missing its central directory valid', async () => {
  const truncated = fixture.subarray(0, layout(fixture).central);
  const authenticated = await collect(cryptoApi.encryptTransferStream(fragments(truncated), passphrase, expectedMetadata));
  const sink = await rejectEncrypted(authenticated);
  assert.ok(sink.calls > 0);
});

test('reject each truncation in payload, central directory and EOCD, plus trailing bytes', async t => {
  const { entries: local, central, eocd } = layout(fixture);
  const cuts = new Set([0, 1, 29, local[0].end - 1, local[0].end, central - 1, central, central + 1,
    eocd - 1, eocd, ...Array.from({ length: 21 }, (_, index) => eocd + index + 1)]);
  for (const cut of cuts) await t.test(`cut-${cut}`, () => rejectPlain(fixture.subarray(0, cut)));
  await rejectPlain(Buffer.concat([fixture, Buffer.from('trailing')]));
});

test('central directory and EOCD fields cannot lie about entries, sizes, CRC, flags, names, offsets or disks', async t => {
  const { central, eocd } = layout(fixture);
  for (const [name, offset] of [
    ['central signature', central], ['made by', central + 4], ['version', central + 6],
    ['flags', central + 8], ['method', central + 10], ['crc', central + 16],
    ['packed size', central + 20], ['size', central + 24], ['name size', central + 28],
    ['extra size', central + 30], ['comment size', central + 32], ['disk', central + 34],
    ['internal attrs', central + 36], ['symlink attrs', central + 38], ['offset', central + 42],
    ['name', central + 46], ['end signature', eocd], ['disk number', eocd + 4],
    ['directory disk', eocd + 6], ['disk count', eocd + 8], ['entry count', eocd + 10],
    ['directory size', eocd + 12], ['directory offset', eocd + 16], ['end comment', eocd + 20],
  ]) await t.test(name, async () => {
    const changed = Buffer.from(fixture);
    changed[offset] ^= 1;
    await rejectPlain(changed);
  });
});

test('local header, declared size and CRC tampering is rejected', async t => {
  const { entries: local } = layout(fixture);
  for (const offset of [4, 6, 8, 14, 18, 22, 26, 28, local[0].start, local[0].end,
    local[0].end + 4, local[0].end + 8, local[0].end + 12]) await t.test(`offset-${offset}`, async () => {
    const changed = Buffer.from(fixture);
    changed[offset] ^= 1;
    await rejectPlain(changed);
  });
  const stored = rawZip([...files, manifestFile()]);
  stored[layout(stored).entries[0].start] ^= 1;
  await rejectPlain(stored);
});

const unsafePaths = [
  '../data/users.ndjson', '/data/users.ndjson', 'data/../users.ndjson', 'data//users.ndjson',
  'data/./users.ndjson', 'data\\users.ndjson', 'C:/data/users.ndjson', 'data/%2e%2e.ndjson',
  'data/users.ndjson/', 'data/.ndjson', 'data/space name.ndjson', 'data/users.json',
  'data/nested/users.ndjson', 'Data/users.ndjson', 'media/not-a-bucket/file.bin',
  'media/chat-images/../escape', 'media/chat-images/a/../../escape', 'media/chat-images/a\\b',
  'media/chat-images/.hidden', 'media/chat-images/a.', 'media/chat-images/CON.jpg',
  'media/chat-images/a:ads', 'media/chat-images/a%2fb', 'media/chat-images/中文',
  'media/chat-images/a\0b', 'media/chat-images/a\nb', 'media/chat-images/' + 'x'.repeat(129),
  'media/chat-images/' + ('a/'.repeat(250)) + 'a',
];
test('unsafe paths are rejected on export, manifest and ZIP verification without normalization', async t => {
  for (const path of unsafePaths) await t.test(JSON.stringify(path), async () => {
    assert.throws(() => manifestApi.validateEntryPath(path));
    await assert.rejects(collect(api.writePlainVolume(entries([{ path, bytes: data }]), info)));
    const sink = await rejectPlain(rawZip([{ path, bytes: data }, manifestFile()]));
    assert.equal(sink.calls, 0);
  });
});

test('reject duplicate paths, case aliases and media file/directory collisions', async t => {
  for (const paths of [
    ['data/users.ndjson', 'data/users.ndjson'], ['data/users.ndjson', 'data/Users.ndjson'],
    ['media/chat-images/a', 'media/chat-images/a/b'], ['media/chat-images/a/b', 'media/chat-images/a'],
  ]) await t.test(paths.join(' + '), async () => {
    const items = paths.map(path => ({ path, bytes: data }));
    await assert.rejects(collect(api.writePlainVolume(entries(items), info)));
    await rejectPlain(rawZip([...items, manifestFile()]));
    assert.throws(() => manifestApi.validateManifest(manifestFor(items)));
  });
});

test('manifest is mandatory, unique and last; order, exact sizes, hashes and no unlisted entries', async t => {
  for (const [name, value] of [
    ['hash', { ...manifest, entries: manifest.entries.map((entry, i) => i ? entry : { ...entry, sha256: '0'.repeat(64) }) }],
    ['size', { ...manifest, entries: manifest.entries.map((entry, i) => i ? entry : { ...entry, bytes: entry.bytes + 1 }) }],
    ['order', { ...manifest, entries: [...manifest.entries].reverse() }],
    ['missing entry', { ...manifest, entries: manifest.entries.slice(1) }],
    ['extra entry', { ...manifest, entries: [...manifest.entries, { path: 'data/extra.ndjson', bytes: 0, sha256: hash(Buffer.alloc(0)), kind: 'ndjson' }] }],
  ]) await t.test(name, () => rejectPlain(rawZip([...files, manifestFile(value)])));
  await rejectPlain(rawZip(files));
  await rejectPlain(rawZip([manifestFile(), ...files]));
  await rejectPlain(rawZip([...files, manifestFile(), manifestFile()]));
});

test('strict manifest keys, types, version, identities, UUID, ISO time and positive volume indices', async t => {
  const bad = [
    { ...manifest, version: 2 }, { ...manifest, version: '1' }, { ...manifest, unknown: 1 },
    { ...manifest, exportId: '' }, { ...manifest, volumeId: '../bad' },
    { ...manifest, sourceSiteId: 'not-a-uuid' }, { ...manifest, createdAt: 'yesterday' },
    { ...manifest, createdAt: '2026-02-30T01:02:03.000Z' }, { ...manifest, scope: 'employees' },
    { ...manifest, volumeIndex: 0 }, { ...manifest, volumeCount: 0 },
    { ...manifest, volumeIndex: 2 }, { ...manifest, volumeCount: 4097 },
    { ...manifest, volumeIndex: 0.5 }, { ...manifest, volumeCount: '1' },
    { ...manifest, entries: {} }, { ...manifest, entries: [null] },
    { ...manifest, entries: new Array(1) },
    ...[
      { kind: 'html' }, { kind: 'media' }, { bytes: -1 }, { bytes: 0.5 }, { bytes: '2' },
      { bytes: 0xffffffff }, { sha256: 'A'.repeat(64) }, { sha256: '0'.repeat(63) }, { surprise: true },
    ].map(change => ({ ...manifest, entries: [{ ...manifest.entries[0], ...change }] })),
  ];
  for (let index = 0; index < bad.length; index++) await t.test(`invalid-${index}`, () => {
    assert.throws(() => manifestApi.validateManifest(bad[index]));
  });
  assert.throws(() => manifestApi.validateVolumeInfo({ ...info, unknown: true }));
  assert.throws(() => manifestApi.validateTransferMetadata({ ...expectedMetadata, unknown: true }));
});

test('canonical manifest bytes reject duplicate JSON keys, escapes, BOM, junk and malformed UTF-8', async () => {
  const canonical = Buffer.from(manifestApi.serializeManifest(manifest));
  const text = canonical.toString();
  const invalid = [
    Buffer.from(text.replace('"version":1', '"version":1,"version":1')),
    Buffer.from(text.replace('"bytes":' + data.length, '"bytes":0,"bytes":' + data.length)),
    Buffer.from(text.replace('"version":1', '"version":1.0')),
    Buffer.from(text.replace('users.ndjson', '\\u0075sers.ndjson')),
    Buffer.from(' ' + text), Buffer.from(text + '\n'), Buffer.concat([Buffer.from([239, 187, 191]), canonical]),
    Buffer.from([0xc3, 0x28]), Buffer.from('{'), Buffer.from('null'), Buffer.from('[]'),
  ];
  for (const bytes of invalid) {
    assert.throws(() => manifestApi.parseManifest(bytes));
    await rejectPlain(rawZip([...files, { path: 'manifest.json', bytes }]));
  }
});

test('manifest bound, entry count/size, total bytes, ZIP bytes and decompression profile limits', async t => {
  for (const limits of [
    { maxEntries: 2 }, { maxEntryBytes: data.length - 1 }, { maxTotalBytes: data.length + media.length - 1 },
    { maxZipBytes: fixture.length - 1 }, { maxManifestBytes: 20 },
  ]) await t.test(JSON.stringify(limits), async () => {
    await rejectPlain(fixture, { limits });
    await assert.rejects(collect(api.writePlainVolume(entries(), info, { limits })));
  });
  for (const limits of [{ maxEntries: 4097 }, { maxEntryBytes: Infinity }, { maxLineBytes: 0 },
    { maxTotalBytes: -1 }, { maxZipBytes: 0xffffffff }, { maxEntries: 1.5 }, { alien: 1 }]) {
    await rejectPlain(fixture, { limits });
    await assert.rejects(collect(api.writePlainVolume(entries(), info, { limits })));
  }
  const bomb = zipSync({ 'media/chat-images/bomb.bin': new Uint8Array(8 * 1024 * 1024) }, { level: 9 });
  assert.ok(bomb.length < 10000);
  assert.equal((await rejectPlain(bomb)).calls, 0, 'reject compression before decompression/allocation');
  const oversized = Buffer.from(fixture);
  oversized.writeUInt32LE(0x7fffffff, 18);
  oversized.writeUInt32LE(0x7fffffff, 22);
  assert.equal((await rejectPlain(oversized)).calls, 0);
  assert.throws(() => manifestApi.parseManifest(new Uint8Array(manifestApi.MAX_MANIFEST_BYTES + 1)));
});

test('NDJSON is opaque but validates streaming UTF-8 and bounded lines across chunk boundaries', async () => {
  const valid = [Buffer.from('opaque-not-json\n'), Buffer.from('中文𠮷'), Buffer.from('1234\n12\r\n1234')];
  for (const bytes of valid) {
    const items = [{ path: 'data/opaque.ndjson', bytes }];
    const zip = await collect(api.writePlainVolume(entries(items), info));
    assert.deepEqual(await api.verifyPlainVolume(fragments(zip, [1]), temporarySink()), manifestFor(items));
  }
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xf0, 0x9f]), Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from('12345'), Buffer.from('1234\n12345\n'), Buffer.from('𠮷x')]) {
    const items = [{ path: 'data/opaque.ndjson', bytes }];
    await assert.rejects(collect(api.writePlainVolume(entries(items), info, { limits: { maxLineBytes: 4 } })));
    await rejectPlain(rawZip([...items, manifestFile(manifestFor(items))]), { limits: { maxLineBytes: 4 } }, [1]);
  }
});

test('1 MiB per-push bound for entry, plain ZIP and encrypted inputs', async () => {
  const oversized = new Uint8Array(api.MAX_CONTAINER_INPUT_BYTES + 1);
  async function* source() { yield oversized; }
  async function* input() { yield { path: 'media/chat-images/a', bytes: oversized.length, open: source }; }
  await assert.rejects(collect(api.writePlainVolume(input(), info)));
  const plainSink = temporarySink();
  await assert.rejects(api.verifyPlainVolume(source(), plainSink));
  assert.equal(plainSink.aborts, 1);
  const encryptedSink = temporarySink();
  await assert.rejects(api.verifyEncryptedVolume(source(), passphrase, encryptedSink, { expectedMetadata }));
  assert.equal(encryptedSink.aborts, 1);
});

test('writer refuses declared size mismatches and closes entry source on failure or cancellation', async () => {
  for (const declared of [data.length - 1, data.length + 1, -1, 0.5]) {
    async function* input() { yield { path: 'data/users.ndjson', bytes: declared, open: () => fragments(data) }; }
    await assert.rejects(collect(api.writePlainVolume(input(), info)));
  }
  let closed = 0;
  async function* source() { try { yield data; yield data; } finally { closed++; } }
  async function* input() { yield { path: 'data/users.ndjson', bytes: data.length * 2, open: source }; }
  const writer = api.writePlainVolume(input(), info);
  await writer.next(); // first pass fully consumed/closed before emitting the CRC-bearing local header
  assert.equal(closed, 1);
  await writer.next(); // second pass has begun; returning must close that pass too
  await writer.return();
  assert.equal(closed, 2);
});

test('two-pass writer rejects size/hash/UTF-8/line mutations and equal-CRC different-content sources', async t => {
  const first = Buffer.from('1234\n');
  const cases = [
    ['same size', 'data/mutation.ndjson', first, Buffer.from('4321\n')],
    ['shorter', 'data/mutation.ndjson', first, Buffer.from('123\n')],
    ['longer', 'data/mutation.ndjson', first, Buffer.from('12345\n')],
    ['bad UTF-8', 'data/mutation.ndjson', first, Buffer.from([0xc3, 0x28, 0x31, 0x32, 0x0a])],
    ['line too long', 'data/mutation.ndjson', first, Buffer.from('12345')],
    ['CRC collision', 'media/chat-images/mutation.bin', Buffer.from('plumless'), Buffer.from('buckeroo')],
  ];
  assert.equal(crc32(cases.at(-1)[2]), crc32(cases.at(-1)[3]));
  for (const [name, path, before, after] of cases) await t.test(name, async () => {
    let opens = 0;
    const output = [];
    async function* input() {
      yield { path, bytes: before.length, open: () => fragments(opens++ === 0 ? before : after, [1, 3]) };
    }
    await assert.rejects(async () => {
      for await (const chunk of api.writePlainVolume(input(), info, { limits: { maxLineBytes: 4 } })) output.push(Buffer.from(chunk));
    });
    assert.equal(opens, 2);
    assert.ok(output.length > 0);
    assert.equal(output[0].readUInt16LE(6), 0);
    assert.equal(output[0].readUInt32LE(14), crc32(before));
    assert.ok(!Buffer.concat(output).includes(Buffer.from('manifest.json')));
  });
});

test('first-pass size or UTF-8 failure emits no local header or payload and never reopens the source', async () => {
  for (const [bytes, declared] of [[Buffer.from('valid\n'), 7], [Buffer.from([0xf0, 0x9f]), 2]]) {
    let opens = 0;
    let output = 0;
    async function* input() {
      yield { path: 'data/invalid.ndjson', bytes: declared, open: () => { opens++; return fragments(bytes); } };
    }
    await assert.rejects(async () => { for await (const chunk of api.writePlainVolume(input(), info)) output += chunk.length; });
    assert.equal(opens, 1);
    assert.equal(output, 0);
  }
});

test('async sink backpressure prevents reading ahead or concurrent append calls', async () => {
  let reads = 0;
  let calls = 0;
  let active = 0;
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  async function* source() { for await (const chunk of fragments(fixture, [31])) { reads++; yield chunk; } }
  const sink = {
    async append() {
      assert.equal(active++, 0);
      calls++;
      if (calls === 1) { entered(); await gate; }
      active--;
    },
    async abort() { assert.fail('unexpected abort'); },
  };
  const result = api.verifyPlainVolume(source(), sink);
  await started;
  const pausedReads = reads;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, pausedReads);
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await result, manifest);
});

test('large media uses two bounded passes, no first-pass payload output and second-pass sink backpressure', async () => {
  const part = randomBytes(65536);
  const count = 129;
  const total = part.length * count;
  const produced = [0, 0];
  const progress = [];
  let opens = 0;
  let consumed = 0;
  let maxLag = 0;
  const expected = createHash('sha256');
  for (let i = 0; i < count; i++) expected.update(part);
  async function* source(pass) { for (let i = 0; i < count; i++) { produced[pass]++; yield part; } }
  function open() { const pass = opens++; assert.ok(pass < 2); return source(pass); }
  async function* input() { yield { path: 'media/chat-images/large.bin', bytes: total, open }; }
  const writer = api.writePlainVolume(input(), info, { onProgress: value => progress.push(value) });
  const header = await writer.next();
  assert.equal(opens, 1);
  assert.deepEqual(produced, [count, 0]); // Complete bounded first scan before the first ZIP bytes.
  assert.deepEqual(progress, []); // Scanning is not counted as written payload.
  assert.ok(header.value.length < 1024);
  async function* zip() {
    yield header.value;
    for await (const chunk of writer) {
      assert.ok(chunk.length <= api.MAX_CONTAINER_INPUT_BYTES);
      maxLag = Math.max(maxLag, produced[1] * part.length - consumed);
      yield chunk;
    }
  }
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const actual = createHash('sha256');
  const sink = {
    async append(path, bytes) {
      assert.equal(path, 'media/chat-images/large.bin');
      if (!consumed) { entered(); await gate; }
      actual.update(bytes);
      consumed += bytes.length;
    },
    async abort() { assert.fail('unexpected abort'); },
  };
  const result = api.verifyPlainVolume(zip(), sink);
  await started;
  assert.equal(opens, 2);
  assert.deepEqual(produced, [count, 1]);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(produced, [count, 1]); // No extra reads while the first temporary append waits.
  release();
  const verified = await result;
  assert.equal(verified.entries[0].sha256, expected.digest('hex'));
  assert.equal(actual.digest('hex'), verified.entries[0].sha256);
  assert.equal(opens, 2);
  assert.deepEqual(produced, [count, count]);
  assert.equal(consumed, total);
  assert.equal(progress.at(-1).bytes, total);
  assert.equal(progress.at(-1).entries, 1);
  assert.ok(maxLag <= part.length);
});

test('encrypted default 1 MiB boundaries remain incremental and all public pushes are bounded', async () => {
  const payload = randomBytes(2 * 1024 * 1024 + 17);
  const items = [{ path: 'media/chat-images/large.bin', bytes: payload }];
  const chunks = [];
  for await (const chunk of api.writeEncryptedVolume(entries(items), info, passphrase)) {
    assert.ok(chunk.length <= api.MAX_CONTAINER_INPUT_BYTES);
    chunks.push(Buffer.from(chunk));
  }
  const sink = temporarySink();
  const verified = await api.verifyEncryptedVolume(fragments(Buffer.concat(chunks), [65521, 1, 1048576]), passphrase,
    sink, { expectedMetadata });
  assert.equal(verified.entries[0].sha256, hash(payload));
  assert.deepEqual(Buffer.concat(sink.chunks.get(items[0].path)), payload);
});

test('source/sink/progress failures abort once and preserve original errors, even if abort throws', async () => {
  const failure = new Error('local failure');
  for (const mode of ['source', 'sink', 'progress']) {
    let closed = 0;
    let aborts = 0;
    async function* source() {
      try { yield fixture.subarray(0, 100); if (mode === 'source') throw failure; yield fixture.subarray(100); }
      finally { closed++; }
    }
    const sink = {
      async append() { if (mode === 'sink') throw failure; },
      async abort() { aborts++; throw new Error('abort cleanup failure'); },
    };
    await assert.rejects(api.verifyPlainVolume(source(), sink,
      { onProgress: () => { if (mode === 'progress') throw failure; } }), error => error === failure);
    assert.equal(aborts, 1);
    assert.equal(closed, 1);
  }
});

test('abort signal rejects pre-aborted, pending source and late sink work without validated result', async () => {
  const pre = new AbortController();
  pre.abort();
  await rejectPlain(fixture, { signal: pre.signal });
  await rejectEncrypted(encryptedFixture, { signal: pre.signal });
  const controller = new AbortController();
  let resolveNext;
  const pending = new Promise(resolve => { resolveNext = resolve; });
  const sink = temporarySink();
  const source = { [Symbol.asyncIterator]() { return { next: () => pending }; } };
  const result = api.verifyPlainVolume(source, sink, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(result, { name: 'AbortError' });
  assert.equal(sink.aborts, 1);
  resolveNext({ done: true });
  const late = new AbortController();
  const lateSink = temporarySink();
  lateSink.append = async () => late.abort();
  await assert.rejects(api.verifyPlainVolume(fragments(fixture), lateSink, { signal: late.signal }), { name: 'AbortError' });
  assert.equal(lateSink.aborts, 1);
});

test('cancellation rejects promptly while append never resolves and calls abort exactly once', async () => {
  const controller = new AbortController();
  let entered;
  let aborts = 0;
  let verified;
  const started = new Promise(resolve => { entered = resolve; });
  const sink = {
    append(path, bytes, signal) {
      assert.equal(signal, controller.signal);
      assert.ok(path && bytes.length);
      entered();
      return new Promise(() => {});
    },
    async abort(reason) { assert.equal(reason.name, 'AbortError'); aborts++; },
  };
  const result = api.verifyPlainVolume(fragments(fixture), sink, { signal: controller.signal })
    .then(value => { verified = value; });
  await started;
  controller.abort();
  let timer;
  try {
    await assert.rejects(Promise.race([result, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Cancellation waited for an unresolvable append.')), 1000);
    })]), { name: 'AbortError' });
  } finally { clearTimeout(timer); }
  assert.equal(verified, undefined);
  assert.equal(aborts, 1);
});

test('abort fences pending/future writes so late append completion or rejection cannot resurrect temporary data', async t => {
  for (const completion of ['resolve', 'reject']) await t.test(completion, async () => {
    const controller = new AbortController();
    let entered;
    let release;
    let valid = true;
    let aborts = 0;
    let calls = 0;
    let lateFinished = false;
    let verified;
    const storage = new Map();
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const lateFailure = new Error('late append rejection');
    const sink = {
      async append(path, bytes, signal) {
        if (!valid) throw new Error('Temporary sink was invalidated.');
        calls++;
        if (calls > 1) {
          entered();
          await gate; // Model storage that cannot cancel its in-flight I/O itself.
          lateFinished = true;
          if (completion === 'reject') throw lateFailure;
        }
        // The adapter's atomic invalidation/generation fence is essential, not the promise race.
        if (!valid || signal?.aborted) return;
        if (!storage.has(path)) storage.set(path, []);
        storage.get(path).push(bytes);
      },
      async abort(reason) {
        assert.equal(reason.name, 'AbortError');
        aborts++;
        valid = false; // Invalidate synchronously on invocation, before any asynchronous cleanup.
        storage.clear();
      },
    };
    const result = api.verifyPlainVolume(fragments(fixture, [16]), sink, { signal: controller.signal })
      .then(value => { verified = value; });
    await started;
    assert.ok(storage.size > 0);
    controller.abort();
    let timer;
    try {
      await assert.rejects(Promise.race([result, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cancellation waited for late storage I/O.')), 1000);
      })]), { name: 'AbortError' });
    } finally { clearTimeout(timer); }
    assert.equal(verified, undefined);
    assert.equal(storage.size, 0);
    assert.equal(aborts, 1);
    assert.equal(lateFinished, false);
    release();
    // Any late rejection must be handled by the parser's existing operation handlers.
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lateFinished, true);
    assert.equal(storage.size, 0);
    assert.equal(aborts, 1);
    const countAfterAbort = calls;
    await assert.rejects(sink.append('data/future.ndjson', Buffer.from('x')), /invalidated/);
    assert.equal(calls, countAfterAbort);
    assert.equal(storage.size, 0);
  });
});

test('volume set requires every index, unique IDs/paths, same package/source/scope/time and count', () => {
  const first = manifestFor([files[0]], { ...info, volumeCount: 2 });
  const second = manifestFor(files.slice(1), { ...info, volumeId: 'volume-2', volumeIndex: 2, volumeCount: 2 });
  assert.deepEqual(manifestApi.validateVolumeSet([second, first]), [first, second]);
  for (const values of [
    [], [first], [second], [first, first], [first, { ...second, volumeId: first.volumeId }],
    [first, { ...second, volumeIndex: 1 }], [first, { ...second, exportId: 'other' }],
    [first, { ...second, sourceSiteId: '11111111-1111-4111-8111-111111111111' }],
    [first, { ...second, scope: 'replacement-backup' }], [first, { ...second, volumeCount: 3 }],
    [first, { ...second, createdAt: '2026-10-18T01:02:03.000Z' }],
    [first, { ...second, entries: first.entries }], [first, second, second],
  ]) assert.throws(() => manifestApi.validateVolumeSet(values));
  const backup = manifestFor(files, { ...info, scope: 'replacement-backup' });
  assert.deepEqual(manifestApi.validateVolumeSet([backup]), [backup]);
});
