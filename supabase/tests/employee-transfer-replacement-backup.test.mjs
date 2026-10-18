import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = new URL('../../', import.meta.url);
async function compile(name, plugins = []) {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL(`src/lib/employeeTransfer/${name}.ts`, root))],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2020', plugins,
  });
  return import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
}
const api = await compile('replacementBackup');
const container = await compile('container');
const KEYS = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members',
  'admin_configs', 'system_configs', 'history_cleanup_config'];
const passphrase = 'local-backup-only-strong-passphrase';
const sensitive = 'local-only-sensitive-hash';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pathFor = key => `data/shared-${key}.ndjson`;
const backupId = '9cf79729-1122-4433-8a99-010203040506';
const siteId = '82f20fb2-1122-4433-8a99-010203040506';
const defaults = {
  admins: '{ "label":"管理员𠮷", "n":1e2 }\n',
  financial_admin_credentials: `{"opaque_hash":"${sensitive}"}\n`,
  admin_groups: '{}\n', admin_group_members: '',
  admin_configs: '{"中文":"é é 𠮷", "nested":{"x":[1,true,null]}}\r\n',
  system_configs: '{"key":"display","value":null}\n', history_cleanup_config: '',
};
const ackFor = bytes => ({ success: true, bytes: bytes.length, sha256: hash(bytes), repeated: false });
const rowCount = bytes => bytes.reduce((sum, byte) => sum + (byte === 10 ? 1 : 0), 0);
const roots = [];
after(async () => { await Promise.all(roots.map(path => rm(path, { recursive: true, force: true }))); });

function trackedSource(body, record, chunkSize = 65521) {
  let offset = 0;
  return {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      record.reads++;
      if (offset === body.length) { record.ended = true; return { done: true }; }
      const value = body.subarray(offset, offset + chunkSize);
      offset += value.length;
      return { done: false, value };
    },
    async return() { record.returns++; return { done: true }; },
  };
}
function fixture(texts = defaults) {
  const bodies = Object.fromEntries(KEYS.map(key => [key, Buffer.from(texts[key] ?? '')]));
  const catalog = {
    version: 1, scope: 'shared-settings', site_id: siteId,
    tables: KEYS.map(key => ({ key, rows: rowCount(bodies[key]), bytes: bodies[key].length, sha256: hash(bodies[key]) })),
    excluded_system_keys: ['ios_config'], full_site_complete: false,
  };
  const descriptor = { backup_id: backupId, plan_hash: hash('local-plan'), target_hash: hash('local-target'), catalog };
  const calls = { catalog: 0, pages: [], verify: 0, writes: 0, opens: [], appends: [], seals: [],
    tempOpens: [], tempAborts: 0, apply: 0, deleted: 0 };
  const events = [];
  const files = new Map();
  const value = { descriptor, catalog, bodies, calls, events, files, saved: undefined, invalidated: false, progress: [] };
  value.source = {
    async catalog() { calls.catalog++; events.push('catalog'); return catalog; },
    async page(key, after) {
      calls.pages.push(key);
      assert.equal(after, null);
      const body = bodies[key];
      return { table_key: key, count: rowCount(body), ndjson: body.toString(), next_after: null, sha256: hash(body) };
    },
    async verify() { calls.verify++; events.push('snapshot-verified');
      return { verified: true, scope: 'shared-settings', full_site_complete: false }; },
  };
  value.temporary = {
    async append(path, bytes) {
      assert.equal(value.invalidated, false);
      if (!files.has(path)) files.set(path, []);
      files.get(path).push(Buffer.from(bytes));
    },
    open(path) {
      assert.equal(value.invalidated, false);
      const record = { path, reads: 0, returns: 0, ended: false };
      calls.tempOpens.push(record);
      return trackedSource(Buffer.concat(files.get(path)), record, 4093);
    },
    async abort() { calls.tempAborts++; value.invalidated = true; files.clear(); events.push('temp-abort'); },
  };
  value.file = {
    async write(source) {
      calls.writes++;
      const chunks = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      value.saved = Buffer.concat(chunks);
      events.push('file-saved');
    },
    open() {
      assert.ok(value.saved, 'must save before opening');
      assert.equal(value.invalidated, true, 'saved ciphertext must be independent of deleted plaintext');
      const record = { reads: 0, returns: 0, ended: false };
      calls.opens.push(record);
      events.push(`file-open:${calls.opens.length}`);
      return trackedSource(value.saved, record);
    },
    async abort() { calls.deleted++; assert.fail('never abort the saved encrypted file'); },
    async delete() { calls.deleted++; assert.fail('never delete the saved encrypted file'); },
  };
  value.receiver = {
    async append(chunkNo, hex, signal) {
      assert.ok(calls.opens[0]?.ended, 'full saved-file authentication must finish before upload');
      const bytes = Buffer.from(hex, 'hex');
      calls.appends.push({ chunkNo, hex, bytes, signal });
      events.push(`append:${chunkNo}`);
      return ackFor(bytes);
    },
    async seal(sha256, bytes, signal) {
      assert.ok(calls.opens.every(record => record.ended));
      calls.seals.push({ sha256, bytes, signal }); events.push('seal');
      return { sealed: true, backup_id: backupId };
    },
    async apply() { calls.apply++; assert.fail('backup never applies business changes'); },
  };
  return value;
}
function run(value, options = {}, implementation = api) {
  return implementation.createReplacementBackup(value.descriptor, value.source, value.temporary,
    value.file, value.receiver, passphrase, { onProgress: progress => value.progress.push(progress), ...options });
}
async function reject(value, options = {}, implementation = api) {
  let failure;
  await assert.rejects(run(value, options, implementation), error => { failure = error; return true; });
  assert.equal(failure.name, 'ReplacementBackupError');
  assert.match(failure.message, /Server ciphertext chunks may already exist/);
  assert.match(failure.message, /Keep and check the independent local encrypted file/);
  assert.doesNotMatch(`${failure.stack}${JSON.stringify(failure)}${JSON.stringify(value.progress)}`, new RegExp(`${sensitive}|${passphrase}`));
  assert.equal('cause' in failure, false);
  assert.equal(value.calls.apply, 0);
  assert.equal(value.calls.deleted, 0);
  assert.equal(value.calls.tempAborts, 1);
  return failure;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function soon(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('cancellation stalled')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
async function collect(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function* fragments(bytes, size = 65521) {
  for (let offset = 0; offset < bytes.length; offset += size) yield bytes.subarray(offset, offset + size);
}
async function* entries(value, mutate = items => items) {
  const items = KEYS.map(key => ({ path: pathFor(key), body: value.bodies[key] }));
  for (const item of mutate(items)) {
    yield { path: item.path, bytes: item.body.length, open: () => fragments(item.body) };
  }
}

// Real filesystem adapter, not a download-trigger or in-memory save acknowledgement.
test('real encrypted disk save, full decrypt reread, independent upload reread, exact manifest and progress', async () => {
  const value = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'employee-replacement-backup-'));
  roots.push(directory);
  const cipherPath = join(directory, 'independent.edx');
  const paths = new Map(KEYS.map((key, index) => [pathFor(key), join(directory, `plain-${index}`)]));
  value.temporary = {
    async append(path, chunk) {
      const handle = await open(paths.get(path), 'a');
      try { await handle.writeFile(chunk); } finally { await handle.close(); }
    },
    open(path) { return diskSource(paths.get(path)); },
    async abort() {
      value.calls.tempAborts++;
      await Promise.all([...paths.values()].map(path => rm(path, { force: true })));
    },
  };
  function diskSource(path) {
    return { async *[Symbol.asyncIterator]() {
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(65521);
        while (true) {
          const { bytesRead } = await handle.read(buffer);
          if (!bytesRead) break;
          yield buffer.subarray(0, bytesRead);
        }
      } finally { await handle.close(); }
    } };
  }
  value.file = {
    async write(source) {
      value.calls.writes++;
      const handle = await open(cipherPath, 'wx');
      try { for await (const chunk of source) await handle.writeFile(chunk); await handle.sync(); }
      finally { await handle.close(); }
      value.events.push('file-saved');
    },
    open() { value.events.push('disk-open'); return diskSource(cipherPath); },
  };
  value.receiver = {
    async append(chunkNo, hex) {
      const bytes = Buffer.from(hex, 'hex');
      value.calls.appends.push({ chunkNo, bytes });
      return { ...ackFor(bytes), repeated: true };
    },
    async seal(sha256, bytes) { value.calls.seals.push({ sha256, bytes }); return { sealed: true }; },
  };
  const result = await run(value);
  const saved = await readFile(cipherPath);
  assert.equal(value.calls.writes, 1);
  assert.equal(value.calls.tempAborts, 1);
  assert.equal(value.events.filter(event => event === 'disk-open').length, 2);
  assert.equal(result.cipherSha256, hash(saved));
  assert.equal(result.bytes, saved.length);
  assert.deepEqual(Buffer.concat(value.calls.appends.map(call => call.bytes)), saved);
  assert.deepEqual(value.calls.seals, [{ sha256: hash(saved), bytes: saved.length }]);
  for (const path of paths.values()) await assert.rejects(stat(path), { code: 'ENOENT' });
  const plain = new Map();
  const manifest = await container.verifyEncryptedVolume(diskSource(cipherPath), passphrase, {
    async append(path, bytes) { if (!plain.has(path)) plain.set(path, []); plain.get(path).push(Buffer.from(bytes)); },
    async abort() { assert.fail('valid disk backup'); },
  }, { expectedMetadata: { exportId: backupId, volumeId: backupId } });
  assert.equal(manifest.scope, 'replacement-backup');
  assert.equal(manifest.sourceSiteId, siteId);
  assert.equal(manifest.exportId, backupId);
  assert.equal(manifest.volumeId, backupId);
  assert.equal(manifest.volumeIndex, 1);
  assert.equal(manifest.volumeCount, 1);
  assert.equal(new Date(manifest.createdAt).toISOString(), manifest.createdAt);
  assert.equal(manifest.entries.length, 7);
  for (const key of KEYS) {
    assert.deepEqual(Buffer.concat(plain.get(pathFor(key))), value.bodies[key]);
    assert.deepEqual(manifest.entries.find(entry => entry.path === pathFor(key)), {
      path: pathFor(key), kind: 'ndjson', bytes: value.bodies[key].length, sha256: hash(value.bodies[key]),
    });
  }
  const phases = [...new Set(value.progress.map(progress => progress.phase))];
  assert.deepEqual(phases, ['snapshot', 'save', 'verify', 'upload', 'seal']);
  for (const phase of phases) {
    const progress = value.progress.filter(progress => progress.phase === phase);
    assert.equal(progress[0].bytes, 0);
    assert.equal(progress.at(-1).completed, true);
    assert.ok(progress.every((p, index) => index === 0 || p.bytes >= progress[index - 1].bytes));
    assert.deepEqual(Object.keys(progress[0]).sort(), ['bytes', 'completed', 'phase']);
  }
  assert.equal(value.progress.at(-1).bytes, saved.length);
  assert.deepEqual(result.descriptor, value.descriptor);
  assert.notEqual(result.descriptor.catalog.tables, value.catalog.tables);
  assert.deepEqual(result.sealReceipt, { sealed: true });
});

test('seven empty tables remain present, frozen catalog order is immaterial', async () => {
  const value = fixture({});
  value.catalog.tables.reverse();
  const result = await run(value);
  assert.equal(value.calls.tempOpens.length, 14);
  assert.ok(value.calls.tempOpens.every(record => record.ended));
  assert.equal(result.chunks, 1);
  assert.equal(value.calls.opens.length, 2);
  assert.ok(value.calls.opens.every(record => record.ended));
  assert.equal(value.calls.seals.length, 1);
});

for (const [name, mutate] of [
  ['backup UUID', value => { value.descriptor.backup_id = 'invalid'; }],
  ['plan SHA', value => { value.descriptor.plan_hash = 'A'.repeat(64); }],
  ['target SHA', value => { value.descriptor.target_hash = 'short'; }],
  ['unexpected field', value => { value.descriptor.password = sensitive; }],
  ['missing table', value => { value.catalog.tables.pop(); }],
  ['over 8 MiB snapshot', value => { value.catalog.tables[0].bytes = 8 * 1024 * 1024 + 1; }],
  ['catalog accessor', value => { Object.defineProperty(value.descriptor, 'catalog', { enumerable: true,
    get() { assert.fail('do not execute untrusted getters'); } }); }],
]) {
  test(`reject invalid descriptor before reads/writes: ${name}`, async () => {
    const value = fixture(); mutate(value);
    const failure = await reject(value);
    assert.equal(failure.phase, 'snapshot');
    assert.equal(value.calls.catalog, 0);
    assert.equal(value.calls.writes, 0);
    assert.equal(value.calls.seals.length, 0);
  });
}
for (const [name, mutate] of [
  ['site', catalog => { catalog.site_id = backupId; }],
  ['rows', catalog => { catalog.tables[0].rows++; }],
  ['bytes', catalog => { catalog.tables[0].bytes++; }],
  ['hash', catalog => { catalog.tables[0].sha256 = hash('different'); }],
  ['exclusions', catalog => { catalog.excluded_system_keys = []; }],
]) {
  test(`reject snapshot catalog inconsistent with descriptor: ${name}`, async () => {
    const value = fixture();
    const changed = structuredClone(value.catalog); mutate(changed);
    value.source.catalog = async () => changed;
    await reject(value);
    assert.equal(value.calls.pages.length, 0);
    assert.equal(value.calls.writes, 0);
    assert.equal(value.calls.seals.length, 0);
  });
}

test('freeze server descriptor before awaiting source, not a caller-mutable reference', async () => {
  const value = fixture();
  value.source.catalog = async () => {
    value.descriptor.plan_hash = hash('changed-plan');
    value.catalog.tables[0].sha256 = hash('changed-table');
    return value.catalog;
  };
  await reject(value);
  assert.equal(value.calls.writes, 0);
});

test('temporary plaintext changed consistently between snapshot and packaging is rejected against server catalog', async () => {
  const value = fixture();
  const reopen = value.temporary.open;
  // Preserve byte count so the writer can produce an internally valid but wrong archive.
  const wrong = Buffer.from(value.bodies.admins);
  wrong[wrong.indexOf(Buffer.from('1e2'))] = 50;
  value.temporary.open = path => path === pathFor('admins') ? fragments(wrong) : reopen(path);
  const failure = await reject(value);
  assert.equal(failure.phase, 'verify');
  assert.ok(value.saved);
  assert.equal(value.calls.appends.length, 0);
  assert.equal(value.calls.seals.length, 0);
});

for (const [name, mutate] of [
  ['cipher corruption', bytes => { bytes[Math.floor(bytes.length / 2)] ^= 1; return bytes; }],
  ['truncation', bytes => bytes.subarray(0, bytes.length - 1)],
  ['trailing bytes', bytes => Buffer.concat([bytes, Buffer.from([0])])],
  ['wrong file', () => Buffer.from('not an encrypted backup')],
]) {
  test(`saved-file verification rejects ${name} before any upload`, async () => {
    const value = fixture();
    const write = value.file.write;
    value.file.write = async source => { await write(source); value.saved = mutate(Buffer.from(value.saved)); };
    const failure = await reject(value);
    assert.equal(failure.phase, 'verify');
    const record = value.calls.opens[0];
    assert.ok(record.ended || record.returns === 1, 'exhaust or release the source');
    assert.equal(value.calls.appends.length, 0);
    assert.equal(value.calls.seals.length, 0);
    assert.ok(value.saved);
  });
}

for (const [name, modifyInfo, modifyEntries] of [
  ['scope', info => { info.scope = 'full-site'; }],
  ['site', info => { info.sourceSiteId = backupId; }],
  ['export ID', info => { info.exportId = 'different-export'; }],
  ['volume ID', info => { info.volumeId = 'different-volume'; }],
  ['volume count', info => { info.volumeCount = 2; }],
  ['createdAt', info => { info.createdAt = '2020-01-01T00:00:00.000Z'; }],
  ['missing entry', () => {}, items => items.slice(1)],
  ['extra entry', () => {}, items => [...items, { path: 'data/extra.ndjson', body: Buffer.from('{}\n') }]],
  ['path', () => {}, items => items.map((item, index) => index ? item : { ...item, path: 'data/other.ndjson' })],
  ['hash', () => {}, items => items.map((item, index) => index ? item : { ...item,
    body: Buffer.from(item.body.toString().replace('1e2', '2e2')) })],
  ['bytes', () => {}, items => items.map((item, index) => index ? item : { ...item, body: Buffer.from('{}\n') })],
]) {
  test(`reject another valid encrypted volume with mismatched manifest ${name}`, async () => {
    const value = fixture();
    const originalWrite = value.file.write;
    value.file.write = async source => {
      await originalWrite(source);
      const original = await container.verifyEncryptedVolume(fragments(value.saved), passphrase, {
        async append() {}, async abort() {},
      }, { expectedMetadata: { exportId: backupId, volumeId: backupId } });
      const info = { ...original }; delete info.version; delete info.entries;
      modifyInfo(info);
      value.saved = await collect(container.writeEncryptedVolume(entries(value, modifyEntries), info, passphrase));
    };
    const failure = await reject(value);
    assert.equal(failure.phase, 'verify');
    assert.equal(value.calls.appends.length, 0);
    assert.equal(value.calls.seals.length, 0);
  });
}

test('different independently encrypted copy of the same manifest fails original-write ciphertext SHA check', async () => {
  const value = fixture();
  const originalWrite = value.file.write;
  value.file.write = async source => {
    await originalWrite(source);
    const manifest = await container.verifyEncryptedVolume(fragments(value.saved), passphrase, {
      async append() {}, async abort() {},
    }, { expectedMetadata: { exportId: backupId, volumeId: backupId } });
    const info = { ...manifest }; delete info.version; delete info.entries;
    value.saved = await collect(container.writeEncryptedVolume(entries(value), info, passphrase));
  };
  await reject(value);
  assert.equal(value.calls.appends.length, 0);
  assert.equal(value.calls.seals.length, 0);
});

for (const mode of ['fail before reading', 'fail after partial save', 'resolve without EOF', 'resolve after bytes without EOF']) {
  test(`storage failure never opens or uploads: ${mode}`, async () => {
    const value = fixture();
    value.file.write = async source => {
      value.calls.writes++;
      if (mode !== 'fail before reading' && mode !== 'resolve without EOF') {
        const iterator = source[Symbol.asyncIterator]();
        value.saved = Buffer.from((await iterator.next()).value);
      }
      if (mode.startsWith('fail')) throw new Error(`${passphrase} ${sensitive}`);
    };
    const failure = await reject(value);
    assert.equal(failure.phase, 'save');
    assert.equal(value.calls.writes, 1);
    assert.equal(value.calls.opens.length, 0);
    assert.equal(value.calls.appends.length, 0);
    assert.equal(value.calls.seals.length, 0);
  });
}

for (const [name, mutate] of [
  ['wrong byte count', ack => { ack.bytes++; }],
  ['wrong SHA', ack => { ack.sha256 = hash('bad-ack'); }],
  ['uppercase SHA', ack => { ack.sha256 = ack.sha256.toUpperCase(); }],
  ['success false', ack => { ack.success = false; }],
  ['missing repeated', ack => { delete ack.repeated; }],
  ['nonboolean repeated', ack => { ack.repeated = 0; }],
  ['unexpected field', ack => { ack.body = sensitive; }],
  ['accessor', ack => { Object.defineProperty(ack, 'sha256', { enumerable: true,
    get() { assert.fail('do not execute ack getter'); } }); }],
]) {
  test(`reject append acknowledgement: ${name}; never retry or seal`, async () => {
    const value = fixture();
    const append = value.receiver.append;
    value.receiver.append = async (...args) => { const ack = await append(...args); mutate(ack); return ack; };
    const failure = await reject(value);
    assert.equal(failure.serverChunksMayExist, true);
    assert.equal(failure.phase, 'upload');
    assert.equal(value.calls.appends.length, 1);
    assert.equal(value.calls.seals.length, 0);
    assert.equal(value.progress.filter(progress => progress.phase === 'upload').at(-1).bytes, 0);
    assert.ok(value.saved);
  });
}

test('append request outcome unknown: retain saved file and chunks, no retry, no seal', async () => {
  const value = fixture();
  const append = value.receiver.append;
  value.receiver.append = async (...args) => { await append(...args); throw new Error(`${sensitive}: disconnected`); };
  const failure = await reject(value);
  assert.equal(failure.serverChunksMayExist, true);
  assert.equal(failure.sealMayHaveSucceeded, false);
  assert.equal(value.calls.appends.length, 1);
  assert.equal(value.calls.seals.length, 0);
});

test('upload reread changed after successful verification: whole-ciphertext hash prevents seal', async () => {
  const value = fixture();
  const openFile = value.file.open;
  value.file.open = () => {
    if (value.calls.opens.length === 1) value.saved[200] ^= 1;
    return openFile();
  };
  const failure = await reject(value);
  assert.equal(failure.phase, 'upload');
  assert.equal(value.calls.opens.length, 2);
  assert.equal(value.calls.appends.length, 1);
  assert.equal(value.calls.seals.length, 0);
});

test('snapshot and saved-file read errors are sanitized, plaintext cleanup failure is explicit', async () => {
  const value = fixture();
  value.source.page = async () => { throw new Error(`${sensitive} ${passphrase}`); };
  value.temporary.abort = async () => { value.calls.tempAborts++; throw new Error(sensitive); };
  const failure = await reject(value);
  assert.equal(failure.cleanupRequired, true);
  assert.match(failure.message, /do not reuse the workspace/);
  assert.equal(value.calls.seals.length, 0);
});

for (const which of ['verify', 'upload']) {
  test(`release iterator after saved-file ${which} read throws`, async () => {
    const value = fixture();
    const openFile = value.file.open;
    value.file.open = () => {
      const source = openFile();
      const pass = value.calls.opens.length;
      if (pass === (which === 'verify' ? 1 : 2)) source.next = async () => { throw new Error(sensitive); };
      return source;
    };
    const failure = await reject(value);
    assert.equal(failure.phase, which);
    assert.equal(value.calls.opens.at(-1).returns, 1);
    assert.equal(value.calls.seals.length, 0);
  });
}

for (const phase of ['snapshot', 'save', 'verify', 'upload', 'seal']) {
  test(`cancel before ${phase} begins: no seal and no encrypted-file deletion`, async () => {
    const value = fixture();
    const controller = new AbortController();
    const failure = await reject(value, { signal: controller.signal, onProgress(progress) {
      value.progress.push(progress);
      if (progress.phase === phase) controller.abort();
    } });
    assert.equal(failure.cancelled, true);
    assert.equal(failure.phase, phase);
    assert.equal(value.calls.seals.length, 0);
  });
}

for (const stage of ['snapshot write', 'save', 'verify read', 'upload read', 'append']) {
  test(`cancel stalled ${stage} promptly, observe late rejection, never seal`, async () => {
    const value = fixture();
    const controller = new AbortController();
    const reached = deferred();
    const blocked = deferred();
    if (stage === 'snapshot write') value.temporary.append = async () => { reached.resolve(); return blocked.promise; };
    if (stage === 'save') value.file.write = async () => { reached.resolve(); return blocked.promise; };
    if (stage.endsWith('read')) {
      const openFile = value.file.open;
      value.file.open = () => {
        const source = openFile();
        if (value.calls.opens.length === (stage === 'verify read' ? 1 : 2)) {
          source.next = async () => { reached.resolve(); return blocked.promise; };
        }
        return source;
      };
    }
    if (stage === 'append') {
      const append = value.receiver.append;
      value.receiver.append = async (...args) => { await append(...args); reached.resolve(); return blocked.promise; };
    }
    const pending = reject(value, { signal: controller.signal });
    await soon(reached.promise);
    controller.abort();
    const failure = await soon(pending);
    assert.equal(failure.cancelled, true);
    assert.equal(value.calls.seals.length, 0);
    if (stage.endsWith('read')) assert.equal(value.calls.opens.at(-1).returns, 1);
    blocked.reject(new Error('late failure'));
    await nextTurn();
    assert.equal(value.calls.seals.length, 0);
  });
}

test('cancel before invocation does not read/write; error still has recovery guidance', async () => {
  const value = fixture();
  const controller = new AbortController(); controller.abort();
  const failure = await reject(value, { signal: controller.signal });
  assert.equal(failure.cancelled, true);
  assert.equal(value.calls.catalog, 0);
  assert.equal(value.calls.writes, 0);
  assert.equal(value.calls.seals.length, 0);
});

test('snapshot paging backpressure waits for temporary append', async () => {
  const value = fixture();
  const reached = deferred(); const blocked = deferred();
  const append = value.temporary.append;
  value.temporary.append = async (...args) => {
    if (value.calls.pages.length === 1) { reached.resolve(); await blocked.promise; }
    return append(...args);
  };
  const pending = run(value);
  await reached.promise; await nextTurn();
  assert.equal(value.calls.pages.length, 1);
  assert.equal(value.calls.writes, 0);
  blocked.resolve(); await pending;
  assert.equal(value.calls.seals.length, 1);
});

test('bounded upload pagination, reused input Buffer ownership, sequential append backpressure', async () => {
  const value = fixture({ admins: '{"x":"' + 'a'.repeat(40000) + '"}\n' });
  // Build >128 KiB with legal individual lines/page bounds.
  value.bodies.admins = Buffer.from(value.bodies.admins.toString().repeat(5));
  const table = value.catalog.tables[0];
  Object.assign(table, { bytes: value.bodies.admins.length, rows: 5, sha256: hash(value.bodies.admins) });
  const reached = deferred(); const blocked = deferred();
  const openFile = value.file.open;
  let uploadRecord;
  let producerBuffer;
  value.file.open = () => {
    const original = openFile();
    if (value.calls.opens.length === 1) return original;
    uploadRecord = value.calls.opens.at(-1);
    const buffer = Buffer.alloc(1024 * 1024);
    producerBuffer = buffer;
    value.saved.copy(buffer);
    let sent = false;
    return {
      [Symbol.asyncIterator]() { return this; },
      async next() {
        uploadRecord.reads++;
        if (sent) { uploadRecord.ended = true; return { done: true }; }
        sent = true;
        return { done: false, value: buffer.subarray(0, value.saved.length) };
      },
      async return() { uploadRecord.returns++; return { done: true }; },
      buffer,
    };
  };
  const append = value.receiver.append;
  let inFlight = 0;
  value.receiver.append = async (...args) => {
    assert.equal(inFlight++, 0);
    const ack = await append(...args);
    if (args[0] === 0) { producerBuffer.fill(0); reached.resolve(); await blocked.promise; }
    inFlight--;
    return ack;
  };
  const pending = run(value);
  await reached.promise; await nextTurn();
  assert.equal(value.calls.appends.length, 1);
  assert.equal(uploadRecord.reads, 1, 'must not read ahead during append');
  assert.equal(value.calls.seals.length, 0);
  blocked.resolve();
  const result = await pending;
  assert.equal(result.chunks, 2);
  assert.equal(value.calls.appends[0].bytes.length, api.REPLACEMENT_BACKUP_PAGE_BYTES);
  assert.deepEqual(value.calls.appends.map(call => call.chunkNo), [0, 1]);
  assert.ok(value.calls.appends.every(call => call.hex.length <= 2 * 128 * 1024 && /^[0-9a-f]+$/.test(call.hex)));
  assert.equal(hash(Buffer.concat(value.calls.appends.map(call => call.bytes))), result.cipherSha256);
});

for (const phase of ['verify', 'upload']) {
  test(`reject saved-file input chunk >1 MiB during ${phase}, release reader`, async () => {
    const value = fixture();
    const openFile = value.file.open;
    value.file.open = () => {
      const source = openFile();
      if (value.calls.opens.length === (phase === 'verify' ? 1 : 2)) {
        source.next = async () => ({ done: false, value: new Uint8Array(1024 * 1024 + 1) });
      }
      return source;
    };
    const failure = await reject(value);
    assert.equal(failure.phase, phase);
    assert.equal(value.calls.opens.at(-1).returns, 1);
    assert.equal(value.calls.seals.length, 0);
  });
}

test('ciphertext reread >9 MiB is bounded and never sealed, even with valid per-page receipts', async () => {
  const value = fixture();
  const openFile = value.file.open;
  let reads = 0;
  value.file.open = () => {
    const source = openFile();
    if (value.calls.opens.length === 2) source.next = async () => {
      reads++; return { done: false, value: new Uint8Array(1024 * 1024) };
    };
    return source;
  };
  const failure = await reject(value);
  assert.equal(failure.phase, 'upload');
  assert.equal(reads, 10);
  assert.equal(value.calls.appends.length, 72);
  assert.equal(value.calls.seals.length, 0);
  assert.equal(value.calls.opens.at(-1).returns, 1);
});

// Isolated writer fault injection exercises bounds unreachable from the valid <=8 MiB snapshot.
const faultWriter = mode => [{
  name: `fault-writer-${mode}`,
  setup(build) {
    build.onResolve({ filter: /^\.\/container$/ }, args => args.importer.endsWith('replacementBackup.ts')
      ? { path: 'container', namespace: 'fault' } : undefined);
    build.onLoad({ filter: /.*/, namespace: 'fault' }, () => ({ contents: `
      export const MAX_CONTAINER_INPUT_BYTES = 1024 * 1024;
      export async function* writeEncryptedVolume() {
        ${mode === 'chunk' ? 'yield new Uint8Array(1024 * 1024 + 1);' : 'for (let i = 0; i < 10; i++) yield new Uint8Array(1024 * 1024);'}
      }
      export async function verifyEncryptedVolume() { throw new Error('must not verify failed save'); }
    ` }));
  },
}];
for (const mode of ['chunk', 'volume']) {
  test(`writer output ${mode} bound enforced while saving, no unbounded accumulation or upload`, async () => {
    const implementation = await compile('replacementBackup', faultWriter(mode));
    const value = fixture();
    let persisted = 0;
    value.file.write = async source => { for await (const chunk of source) persisted += chunk.length; };
    const failure = await reject(value, {}, implementation);
    assert.equal(failure.phase, 'save');
    assert.equal(persisted, mode === 'chunk' ? 0 : api.MAX_REPLACEMENT_BACKUP_BYTES);
    assert.equal(value.calls.opens.length, 0);
    assert.equal(value.calls.seals.length, 0);
  });
}

test('seal failure or cancellation is reported as unknown, never automatically retried', async () => {
  for (const cancel of [false, true]) {
    const value = fixture();
    const controller = new AbortController();
    value.receiver.seal = async (...args) => {
      value.calls.seals.push(args);
      if (cancel) controller.abort();
      throw new Error(sensitive);
    };
    const failure = await reject(value, { signal: controller.signal });
    assert.equal(failure.sealMayHaveSucceeded, true);
    assert.match(failure.message, /Seal outcome may be unknown/);
    assert.equal(failure.cancelled, cancel);
    assert.equal(value.calls.seals.length, 1);
    assert.ok(value.saved);
  }
});

test('full 8 MiB snapshot succeeds below 9 MiB ciphertext bound with 1 MiB reread chunks', async () => {
  const line = '{"x":"' + 'a'.repeat(65536 - 9) + '"}\n';
  const value = fixture({ admins: line.repeat(128) });
  const page = value.source.page;
  value.source.page = async (key, after) => {
    if (key !== 'admins') return page(key, after);
    const index = after === null ? 0 : Number(after);
    const body = value.bodies.admins.subarray(index * 262144, (index + 1) * 262144);
    return { table_key: key, count: 4, ndjson: body.toString(), sha256: hash(body),
      next_after: index < 31 ? String(index + 1) : null };
  };
  value.temporary.open = path => fragments(Buffer.concat(value.files.get(path)), 1024 * 1024);
  const openFile = value.file.open;
  value.file.open = () => {
    openFile();
    return trackedSource(value.saved, value.calls.opens.at(-1), 1024 * 1024);
  };
  const result = await run(value);
  assert.ok(result.bytes > 8 * 1024 * 1024);
  assert.ok(result.bytes <= api.MAX_REPLACEMENT_BACKUP_BYTES);
  assert.ok(value.calls.opens.every(record => record.ended));
  assert.equal(value.calls.seals.length, 1);
  assert.equal(hash(Buffer.concat(value.calls.appends.map(call => call.bytes))), hash(value.saved));
});

test('save backpressure does not prefetch plaintext while saved-file consumer is blocked', async () => {
  const value = fixture();
  const reached = deferred(); const blocked = deferred();
  value.file.write = async source => {
    const iterator = source[Symbol.asyncIterator]();
    const chunks = [Buffer.from((await iterator.next()).value)];
    reached.resolve(); await blocked.promise;
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      chunks.push(Buffer.from(next.value));
    }
    value.saved = Buffer.concat(chunks);
  };
  const pending = run(value);
  await reached.promise; await nextTurn();
  assert.equal(value.calls.tempOpens.length, 0);
  assert.equal(value.calls.opens.length, 0);
  assert.equal(value.calls.appends.length, 0);
  blocked.resolve(); await pending;
  assert.equal(value.calls.seals.length, 1);
});

test('cancel stalled plaintext reader during encryption releases iterator and retains partial ciphertext', async () => {
  const value = fixture();
  const reached = deferred(); const blocked = deferred();
  const controller = new AbortController();
  let returns = 0;
  value.temporary.open = () => ({
    [Symbol.asyncIterator]() { return this; },
    async next() { reached.resolve(); return blocked.promise; },
    async return() { returns++; return { done: true }; },
  });
  value.file.write = async source => {
    for await (const chunk of source) value.saved = Buffer.from(chunk);
  };
  const pending = reject(value, { signal: controller.signal });
  await soon(reached.promise); controller.abort();
  const failure = await soon(pending);
  assert.equal(failure.phase, 'save');
  assert.equal(failure.cancelled, true);
  assert.ok(value.saved.length > 0);
  assert.equal(value.calls.seals.length, 0);
  await nextTurn();
  assert.equal(returns, 1);
  blocked.reject(new Error('late plaintext failure')); await nextTurn();
});

test('cleanup failure after saved file prevents verification/upload, retains encrypted file', async () => {
  const value = fixture();
  value.temporary.abort = async reason => {
    value.calls.tempAborts++;
    assert.doesNotMatch(reason.message, new RegExp(`${sensitive}|${passphrase}`));
    throw new Error(sensitive);
  };
  const failure = await reject(value);
  assert.equal(failure.cleanupRequired, true);
  assert.ok(value.saved);
  assert.equal(value.calls.opens.length, 0);
  assert.equal(value.calls.seals.length, 0);
});

test('cancel after acknowledged append stops before seal and keeps recovery file', async () => {
  const value = fixture();
  const controller = new AbortController();
  const failure = await reject(value, { signal: controller.signal, onProgress(progress) {
    value.progress.push(progress);
    if (progress.phase === 'upload' && progress.bytes > 0) controller.abort();
  } });
  assert.equal(failure.cancelled, true);
  assert.equal(value.calls.appends.length, 1);
  assert.equal(value.calls.seals.length, 0);
  assert.ok(value.saved);
});

test('nonterminal progress observer failure never seals or leaks thrown data', async () => {
  const value = fixture();
  const failure = await reject(value, { onProgress(progress) {
    if (progress.phase === 'seal') throw new Error(`${sensitive} ${passphrase}`);
  } });
  assert.equal(failure.phase, 'seal');
  assert.equal(failure.sealMayHaveSucceeded, false);
  assert.equal(value.calls.seals.length, 0);
});

test('completed seal observer failure does not falsely report backup failure', async () => {
  const value = fixture();
  const result = await run(value, { onProgress(progress) {
    if (progress.phase === 'seal' && progress.completed) throw new Error('observer failed');
  } });
  assert.equal(result.sealReceipt.sealed, true);
  assert.equal(value.calls.seals.length, 1);
});
