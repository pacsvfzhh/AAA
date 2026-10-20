import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

mock.method(globalThis, 'fetch', () => assert.fail('Network and production access forbidden'));
after(() => {
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  mock.restoreAll();
});
const root = fileURLToPath(new URL('../../', import.meta.url));
const compiled = await build({
  stdin: { contents: `export * from './src/lib/employeeTransfer/browserStorage.ts';
    export {MAX_CONTAINER_INPUT_BYTES, writeEncryptedVolume, verifyEncryptedVolume} from './src/lib/employeeTransfer/container.ts';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
});
assert.ok(Object.keys(compiled.metafile.inputs).every(path => !/supabase\.ts|auth\.ts|database\.ts/.test(path)));
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const MAX = api.MAX_CONTAINER_INPUT_BYTES;
const bytes = text => new TextEncoder().encode(text);
const source = (...parts) => (async function* () { for (const part of parts) yield typeof part === 'string' ? bytes(part) : part; })();
const tick = () => new Promise(resolve => setImmediate(resolve));
const abortError = error => error?.name === 'AbortError';
const cleanupError = /plaintext cleanup could not be confirmed/;
const domError = name => new DOMException(name, name);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function gate() {
  const entered = deferred(), released = deferred();
  return { entered: entered.promise, release: released.resolve, fail: released.reject,
    async block() { entered.resolve(); await released.promise; } };
}
async function promptly(operation, ms = 250) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Operation waited for blocked I/O')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function collect(input) {
  const chunks = [];
  for await (const chunk of input) {
    assert.ok(chunk instanceof Uint8Array);
    assert.ok(chunk.length <= MAX);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class SyntheticFS {
  constructor() {
    this.log = [];
    this.hook = null;
    this.selected = this.directory('selected', null);
    this.opfs = this.directory('opfs', null);
  }
  async run(event, operation) {
    this.log.push(event);
    await this.hook?.({ ...event, phase: 'before' });
    const result = operation();
    await this.hook?.({ ...event, phase: 'after' });
    return result;
  }
  attached(node) {
    if (node.removed) throw domError('NotFoundError');
    if (node.parent) this.attached(node.parent);
  }
  directory(name, parent) {
    const fs = this, path = parent ? `${parent.path}/${name}` : name;
    const node = { kind: 'directory', name, parent, path, entries: new Map(), removed: false,
      getDirectoryHandle(child, options) {
        return fs.run({ method: 'directory', path: `${path}/${child}`, create: options?.create === true }, () => {
          fs.attached(node);
          let found = node.entries.get(child);
          if (!found && options?.create) { found = fs.directory(child, node); node.entries.set(child, found); }
          if (!found) throw domError('NotFoundError');
          if (found.kind !== 'directory') throw domError('TypeMismatchError');
          return found;
        });
      },
      getFileHandle(child, options) {
        return fs.run({ method: 'file', path: `${path}/${child}`, create: options?.create === true }, () => {
          fs.attached(node);
          let found = node.entries.get(child);
          if (!found && options?.create) { found = fs.file(child, node); node.entries.set(child, found); }
          if (!found) throw domError('NotFoundError');
          if (found.kind !== 'file') throw domError('TypeMismatchError');
          return found;
        });
      },
      removeEntry(child, options) {
        return fs.run({ method: 'remove', path: `${path}/${child}`, options }, () => {
          assert.deepEqual(options, { recursive: true });
          fs.attached(node);
          const found = node.entries.get(child);
          if (!found) throw domError('NotFoundError');
          found.removed = true;
          node.entries.delete(child);
        });
      },
    };
    return node;
  }
  file(name, parent, content = Buffer.alloc(0)) {
    const fs = this, path = `${parent.path}/${name}`;
    const node = { kind: 'file', name, parent, path, removed: false, content: Buffer.from(content),
      getFile() {
        return fs.run({ method: 'getFile', path }, () => {
          fs.attached(node);
          const snapshot = new Blob([node.content]);
          return { size: snapshot.size,
            arrayBuffer() { assert.fail('Whole-file reads forbidden'); },
            stream() { assert.fail('Only bounded disk slices are permitted'); },
            slice(start, end) {
              assert.ok(end - start <= MAX);
              return { arrayBuffer: () => fs.run({ method: 'read', path, start, end }, () => snapshot.slice(start, end).arrayBuffer()) };
            },
          };
        });
      },
      createWritable(options) {
        return fs.run({ method: 'writer', path, options }, () => {
          fs.attached(node);
          assert.deepEqual(options, { keepExistingData: false, mode: 'exclusive' });
          let ended = false;
          const parts = [];
          return {
            write(input) {
              return fs.run({ method: 'write', path, size: input.length }, () => {
                fs.attached(node);
                if (ended) throw domError('InvalidStateError');
                assert.ok(input instanceof Uint8Array && input.length <= MAX);
                parts.push(Buffer.from(input));
              });
            },
            close() {
              return fs.run({ method: 'close', path }, () => {
                fs.attached(node);
                if (ended) throw domError('InvalidStateError');
                ended = true;
                node.content = Buffer.concat(parts);
                parts.length = 0;
              });
            },
            abort() {
              return fs.run({ method: 'abort', path }, () => {
                ended = true;
                parts.length = 0;
              });
            },
          };
        });
      },
    };
    return node;
  }
  seed(parent, name, text) {
    const node = this.file(name, parent, bytes(text));
    parent.entries.set(name, node);
    return node;
  }
  find(path) {
    const [rootName, ...parts] = path.split('/');
    let node = rootName === 'opfs' ? this.opfs : this.selected;
    for (const part of parts) node = node?.entries?.get(part);
    return node;
  }
}
function fixture(t) {
  const fs = new SyntheticFS();
  const originals = new Map(['window', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const browser = { showDirectoryPicker(options) {
    fs.log.push({ method: 'picker', options });
    assert.deepEqual(options, { mode: 'readwrite' });
    return Promise.resolve(fs.selected);
  } };
  const navigator = { userActivation: { isActive: true }, storage: { getDirectory() {
    fs.log.push({ method: 'opfs' });
    return Promise.resolve(fs.opfs);
  } } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigator });
  t.after(() => {
    for (const [key, original] of originals) {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    }
  });
  return { fs, browser, navigator };
}

test('picker is invoked synchronously in the caller gesture and creates only a fresh UTC/UUID child', async t => {
  const { fs } = fixture(t);
  fs.seed(fs.selected, 'keep.txt', 'existing user data');
  const operation = api.pickTransferDirectory();
  assert.equal(fs.log[0].method, 'picker');
  const directory = await operation;
  assert.match(directory.name, /^migration-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.ok(directory.name.startsWith(`migration-${new Date().toISOString().slice(0, 10)}-`));
  assert.deepEqual([...fs.selected.entries.keys()].sort(), ['keep.txt', directory.name].sort());
  assert.equal(fs.selected.entries.get('keep.txt').content.toString(), 'existing user data');
  const next = await api.pickTransferDirectory();
  assert.notEqual(next.name, directory.name);
});

for (const unsupported of ['window', 'picker', 'gesture', 'storage', 'opfs', 'uuid']) test(`unsupported ${unsupported} fails without fallback or network`, async t => {
  const { fs, browser, navigator } = fixture(t);
  if (unsupported === 'window') delete globalThis.window;
  if (unsupported === 'picker') delete browser.showDirectoryPicker;
  if (unsupported === 'gesture') navigator.userActivation.isActive = false;
  if (unsupported === 'storage') delete navigator.storage;
  if (unsupported === 'opfs') delete navigator.storage.getDirectory;
  if (unsupported === 'uuid') {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    t.after(() => Object.defineProperty(globalThis, 'crypto', original));
  }
  if (['storage', 'opfs'].includes(unsupported)) await assert.rejects(api.createBrowserWorkspaceFactory(), /support/);
  else await assert.rejects(api.pickTransferDirectory(), /support|gesture|UUID/);
  assert.equal(fs.selected.entries.size, 0);
  assert.equal(fs.opfs.entries.size, 0);
  assert.equal(fs.log.filter(event => event.method === 'picker').length, unsupported === 'uuid' ? 1 : 0);
});

test('picker cancellation and OPFS permission failures propagate unchanged', async t => {
  const { browser, navigator } = fixture(t);
  const denied = domError('NotAllowedError'), cancelled = domError('AbortError');
  browser.showDirectoryPicker = () => Promise.reject(cancelled);
  await assert.rejects(api.pickTransferDirectory(), error => error === cancelled);
  navigator.storage.getDirectory = () => Promise.reject(denied);
  await assert.rejects(api.createBrowserWorkspaceFactory(), error => error === denied);
});

for (const kind of ['file', 'directory']) test(`random output child collision with existing ${kind} never overwrites or removes it`, async t => {
  const { fs } = fixture(t);
  const uuid = kind === 'file' ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000002';
  t.mock.method(globalThis.crypto, 'randomUUID', () => uuid);
  const name = `migration-${new Date().toISOString().slice(0, 10)}-${uuid}`;
  const original = kind === 'file' ? fs.seed(fs.selected, name, 'keep') : fs.directory(name, fs.selected);
  fs.selected.entries.set(name, original);
  await assert.rejects(api.pickTransferDirectory());
  assert.equal(fs.selected.entries.get(name), original);
  assert.ok(fs.log.every(event => !event.create && event.method !== 'remove' && event.method !== 'writer'));
});

const unsafeNames = ['', '.', '..', '../escape', '/absolute', 'a/b', 'a\\b', 'a:b', 'a?b', 'a*b', 'a|b', 'a<b', 'a>b', 'a"b', 'a%2fb',
  'a\0b', 'a\nb', 'a\tb', 'a\u007fb', 'a\u0085b', 'a\u202eb', 'a ', ' a', '.hidden', 'trailing.', 'double..dot', 'CON', 'nul.edx',
  'Com1.txt', 'lpt9', 'COM¹.edx', 'LPT²', 'é'.repeat(128), 'a'.repeat(256), 'e\u0301', 'a\uD800', 42, null];
for (const name of unsafeNames) test(`unsafe output filename ${JSON.stringify(name)} is rejected before filesystem work`, async t => {
  const { fs } = fixture(t);
  const directory = await api.pickTransferDirectory(), before = fs.log.length;
  assert.throws(() => directory.createFile(name), /Unsafe/);
  await assert.rejects(directory.writeText(name, 'text'), /Unsafe/);
  assert.equal(fs.log.length, before);
});

test('output name reservations reject same/case aliases, including failed and concurrent attempts', async t => {
  const { fs } = fixture(t);
  const directory = await api.pickTransferDirectory();
  const file = directory.createFile('backup.edx');
  assert.throws(() => directory.createFile('backup.edx'), /Duplicate/);
  assert.throws(() => directory.createFile('BACKUP.edx'), /Duplicate/);
  const first = file.write(source('one'));
  await assert.rejects(file.write(source('two')), /only be written once/);
  await first;
  await assert.rejects(file.write(source('three')), /only be written once/);
  assert.equal(fs.find(`selected/${directory.name}/backup.edx`).content.toString(), 'one');
  assert.equal(fs.log.filter(event => event.method === 'writer').length, 1);
});

for (const kind of ['file', 'directory']) test(`pre-existing ${kind} at the output filename is not opened for writing`, async t => {
  const { fs } = fixture(t);
  const directory = await api.pickTransferDirectory(), parent = fs.find(`selected/${directory.name}`);
  const original = kind === 'file' ? fs.seed(parent, 'saved.edx', 'original') : fs.directory('saved.edx', parent);
  parent.entries.set('saved.edx', original);
  const file = directory.createFile('saved.edx');
  await assert.rejects(file.write(source('replacement')));
  await assert.rejects(file.write(source('retry')), /only be written once/);
  assert.equal(parent.entries.get('saved.edx'), original);
  if (kind === 'file') assert.equal(original.content.toString(), 'original');
  assert.ok(fs.log.every(event => event.method !== 'writer' && event.method !== 'remove'));
});

test('output streams with backpressure, waits for EOF/close, and every reopen reads disk in bounded slices', async t => {
  const { fs } = fixture(t);
  const directory = await api.pickTransferDirectory(), file = directory.createFile('large.edx');
  assert.throws(() => file.open(), /not been successfully saved/);
  const blocked = gate();
  let produced = 0;
  fs.hook = async event => { if (event.method === 'write' && event.phase === 'before' && produced === 1) await blocked.block(); };
  const saving = file.write((async function* () {
    for (let i = 0; i < 6; i++) { produced++; yield new Uint8Array(MAX).fill(i); }
  })());
  await blocked.entered;
  assert.equal(produced, 1);
  assert.throws(() => file.open(), /not been successfully saved/);
  blocked.release();
  await saving;
  assert.equal(produced, 6);
  const content = await collect(file.open());
  assert.equal(content.length, MAX * 6);
  for (let i = 0; i < 6; i++) assert.ok(content.subarray(i * MAX, (i + 1) * MAX).every(value => value === i));
  const actual = fs.find(`selected/${directory.name}/large.edx`);
  actual.content = Buffer.from('changed on disk');
  const reopenable = file.open();
  assert.equal((await collect(reopenable)).toString(), 'changed on disk');
  actual.content = Buffer.from('changed again');
  assert.equal((await collect(reopenable)).toString(), 'changed again');
  assert.equal(fs.log.filter(event => event.method === 'getFile').length, 3);
  assert.ok(fs.log.findIndex(event => event.method === 'getFile') > fs.log.findIndex(event => event.method === 'close'));
  assert.ok(fs.log.every(event => event.method !== 'remove'));
});

test('writeText incrementally encodes Unicode across surrogate boundaries and saves empty files', async t => {
  const { fs } = fixture(t);
  const directory = await api.pickTransferDirectory();
  const text = 'a'.repeat(MAX / 4 - 1) + '𠮷' + 'é汉🙂'.repeat(200000) + '\n';
  await directory.writeText('說明.txt', text);
  assert.equal(fs.find(`selected/${directory.name}/說明.txt`).content.toString(), text);
  await directory.writeText('empty.txt', '');
  assert.equal(fs.find(`selected/${directory.name}/empty.txt`).content.length, 0);
  assert.ok(fs.log.filter(event => event.method === 'write').every(event => event.size <= MAX));
  await assert.rejects(directory.writeText('invalid.txt', null), /must be a string/);
  assert.equal(fs.find(`selected/${directory.name}/invalid.txt`), undefined);
});

for (const input of [null, {}, 'text', new Uint8Array(MAX + 1)]) test(`invalid output input ${input?.constructor?.name ?? 'null'} cannot be retried`, async t => {
  const { fs } = fixture(t);
  const file = (await api.pickTransferDirectory()).createFile('invalid.edx');
  await assert.rejects(file.write(input instanceof Uint8Array ? source(input) : input));
  await assert.rejects(file.write(source('retry')), /only be written once/);
  assert.throws(() => file.open(), /not been successfully saved/);
  assert.ok(fs.log.every(event => event.method !== 'remove'));
});

for (const method of ['file', 'writer', 'write', 'close']) test(`output ${method} failure propagates with no retry/delete`, async t => {
  const { fs } = fixture(t);
  const file = (await api.pickTransferDirectory()).createFile('failed.edx');
  const failure = Error('synthetic disk failure');
  fs.hook = event => { if (event.method === method && (method !== 'file' || event.create) && event.phase === 'before') throw failure; };
  await assert.rejects(file.write(source('ciphertext')), error => error === failure);
  await assert.rejects(file.write(source('retry')), /only be written once/);
  assert.equal(fs.log.filter(event => event.method === method && (method !== 'file' || event.create)).length, 1);
  assert.ok(fs.log.every(event => event.method !== 'remove'));
});

for (const point of ['before', 'next', 'writer', 'write', 'close']) test(`output cancellation at ${point} never waits for stuck source/I/O or deletes ciphertext`, async t => {
  const { fs } = fixture(t);
  const file = (await api.pickTransferDirectory()).createFile('cancelled.edx');
  const controller = new AbortController(), blocked = gate();
  let returns = 0;
  const input = point === 'next' ? { [Symbol.asyncIterator]() { return {
    next: () => blocked.block(), return: () => { returns++; return new Promise(() => {}); },
  }; } } : source('ciphertext');
  if (point === 'before') controller.abort();
  fs.hook = event => { if (event.method === point && event.phase === 'before') return blocked.block(); };
  const result = assert.rejects(file.write(input, controller.signal), abortError);
  if (point !== 'before') { await blocked.entered; controller.abort(); }
  await promptly(result);
  assert.throws(() => file.open(), /not been successfully saved/);
  await assert.rejects(file.write(source('retry')), /only be written once/);
  if (point === 'next') assert.equal(returns, 1);
  if (point !== 'next') blocked.release();
  await tick();
  assert.ok(fs.log.every(event => event.method !== 'remove'));
  if (point === 'writer') assert.ok(fs.log.some(event => event.method === 'abort'));
});

test('factory and workspaces are lazy, isolate every invocation, and clean only their own plaintext', async t => {
  const { fs } = fixture(t);
  fs.seed(fs.opfs, 'unrelated', 'keep OPFS data');
  const saved = (await api.pickTransferDirectory()).createFile('keep.edx');
  await saved.write(source('encrypted'));
  const factory = await api.createBrowserWorkspaceFactory(), a = factory(), b = factory();
  const anotherFactory = await api.createBrowserWorkspaceFactory(), c = anotherFactory();
  assert.equal(fs.opfs.entries.size, 1);
  assert.throws(() => a.open('missing.ndjson'), /does not exist/);
  await Promise.all([a.append('data/a.ndjson', bytes('one')), b.append('data/a.ndjson', bytes('two')), c.append('media/a/b.bin', bytes('three'))]);
  assert.equal(fs.opfs.entries.size, 4);
  assert.equal((await collect(a.open('data/a.ndjson'))).toString(), 'one');
  assert.equal((await collect(b.open('data/a.ndjson'))).toString(), 'two');
  const cleanup = a.abort('discard');
  assert.equal(a.abort('again'), cleanup);
  await cleanup;
  assert.equal(fs.opfs.entries.size, 3);
  assert.throws(() => a.open('data/a.ndjson'), abortError);
  await assert.rejects(a.append('data/new.ndjson', bytes('late')), abortError);
  assert.equal((await collect(b.open('data/a.ndjson'))).toString(), 'two');
  await b.abort('discard');
  await c.abort('discard');
  assert.deepEqual([...fs.opfs.entries.keys()], ['unrelated']);
  assert.equal((await collect(saved.open())).toString(), 'encrypted');
  assert.ok(fs.log.filter(event => event.method === 'remove').every(event => event.path.startsWith('opfs/migration-plaintext-')));
});

test('abort of an unused workspace performs no directory creation or deletion', async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())();
  await workspace.abort('never used');
  assert.ok(fs.log.every(event => !event.create && event.method !== 'remove'));
});

test('workspace append extends a single writer; open freezes immediately, closes once, and is re-iterable', async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())();
  await workspace.append('data/table.ndjson', bytes('first'));
  await workspace.append('data/table.ndjson', bytes('second'));
  const input = workspace.open('data/table.ndjson');
  await assert.rejects(workspace.append('data/table.ndjson', bytes('third')), /frozen/);
  assert.equal((await collect(input)).toString(), 'firstsecond');
  assert.equal((await collect(input)).toString(), 'firstsecond');
  assert.equal((await collect(workspace.open('data/table.ndjson'))).toString(), 'firstsecond');
  assert.equal(fs.log.filter(event => event.method === 'writer').length, 1);
  assert.equal(fs.log.filter(event => event.method === 'close').length, 1);
  assert.equal(fs.log.filter(event => event.method === 'getFile').length, 3);
  assert.ok(fs.log.findIndex(event => event.method === 'close') < fs.log.findIndex(event => event.method === 'getFile'));
  await workspace.abort('done');
});

test('open concurrent with append waits for that append and rejects additional concurrent appends instead of buffering', async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())(), blocked = gate();
  fs.hook = event => { if (event.method === 'write' && event.phase === 'before') return blocked.block(); };
  const appending = workspace.append('data/a.ndjson', bytes('pending'));
  await blocked.entered;
  await assert.rejects(workspace.append('data/a.ndjson', bytes('extra')), /in progress/);
  const reading = collect(workspace.open('data/a.ndjson'));
  let resolved = false;
  reading.then(() => { resolved = true; });
  await tick();
  assert.equal(resolved, false);
  blocked.release();
  await appending;
  assert.equal((await reading).toString(), 'pending');
  await workspace.abort('done');
});

for (const path of [...unsafeNames.filter(name => typeof name === 'string' && name !== 'a/b'), 'data//a', 'data/../a', 'data/./a', 'data/a/', 'a/'.repeat(33) + 'b']) {
  test(`unsafe workspace path ${JSON.stringify(path)} is rejected without creating plaintext`, async t => {
    const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())();
    await assert.rejects(workspace.append(path, bytes('secret')), /Unsafe/);
    assert.throws(() => workspace.open(path), /Unsafe/);
    assert.equal(fs.opfs.entries.size, 0);
    await workspace.abort('done');
  });
}

for (const [first, second] of [['data/a', 'data/a/b'], ['data/a/b', 'data/a'], ['data/a', 'DATA/b'], ['data/a', 'data/A']]) {
  test(`workspace rejects file/directory/case aliases ${first} -> ${second}`, async t => {
    fixture(t);
    const workspace = (await api.createBrowserWorkspaceFactory())();
    await workspace.append(first, bytes('original'));
    await assert.rejects(workspace.append(second, bytes('conflict')), /Conflicting/);
    assert.equal((await collect(workspace.open(first))).toString(), 'original');
    await workspace.abort('done');
  });
}

test('empty and MAX-sized appends are accepted, oversized/invalid chunks do not allocate disk', async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())();
  for (const input of [new Uint8Array(MAX + 1), 'bad', null]) await assert.rejects(workspace.append('data/bad', input), /Invalid/);
  assert.equal(fs.opfs.entries.size, 0);
  await workspace.append('data/empty.ndjson', new Uint8Array(0));
  assert.equal((await collect(workspace.open('data/empty.ndjson'))).length, 0);
  await workspace.append('data/full.ndjson', new Uint8Array(MAX).fill(7));
  const raw = await collect(workspace.open('data/full.ndjson'));
  assert.equal(raw.length, MAX);
  assert.ok(raw.every(value => value === 7));
  await workspace.abort('done');
});

test('concurrent distinct paths share lazily created parents without sharing writers or bytes', async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())();
  await Promise.all(Array.from({ length: 12 }, (_, index) => workspace.append(`data/${index}.ndjson`, bytes(`row-${index}`))));
  for (let index = 0; index < 12; index++) assert.equal((await collect(workspace.open(`data/${index}.ndjson`))).toString(), `row-${index}`);
  assert.equal(fs.log.filter(event => event.method === 'directory' && event.create).length, 2);
  assert.equal(fs.log.filter(event => event.method === 'writer').length, 12);
  await workspace.abort('done');
  assert.equal(fs.opfs.entries.size, 0);
});

test('append snapshots at most the current bounded chunk against caller mutation', async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())(), blocked = gate();
  const raw = bytes('original');
  fs.hook = event => { if (event.method === 'write' && event.phase === 'before') return blocked.block(); };
  const appending = workspace.append('data/a.ndjson', raw);
  await blocked.entered;
  raw.fill(0);
  blocked.release();
  await appending;
  assert.equal((await collect(workspace.open('data/a.ndjson'))).toString(), 'original');
  await workspace.abort('done');
});

for (const method of ['directory', 'file', 'writer', 'write', 'close']) test(`workspace ${method} failure cannot produce a successful read or retry`, async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())();
  const error = Error(`failed ${method}`);
  fs.hook = event => { if (event.method === method && event.phase === 'before' && (method !== 'directory' && method !== 'file' || event.create)) throw error; };
  if (method === 'close') {
    await workspace.append('data/a.ndjson', bytes('secret'));
    await assert.rejects(collect(workspace.open('data/a.ndjson')), failure => failure === error);
  } else await assert.rejects(workspace.append('data/a.ndjson', bytes('secret')), failure => failure === error);
  await assert.rejects(collect(workspace.open('data/a.ndjson')));
  await assert.rejects(workspace.append('data/a.ndjson', bytes('retry')), /frozen/);
  fs.hook = null;
  await workspace.abort('failed');
  assert.equal(fs.opfs.entries.size, 0);
});

for (const phase of ['before', 'after']) for (const point of ['root-create', 'nested-create', 'file-create', 'writer', 'write', 'close']) {
  test(`cancel blocked ${phase} ${point}: promptly invalidates plaintext, reports unconfirmed cleanup, and late I/O cannot revive it`, async t => {
    const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())(), blocked = gate(), controller = new AbortController();
    const match = event => event.phase === phase && ({
      'root-create': event.method === 'directory' && event.create && event.path.split('/').length === 2,
      'nested-create': event.method === 'directory' && event.create && event.path.endsWith('/data'),
      'file-create': event.method === 'file' && event.create,
      writer: event.method === 'writer', write: event.method === 'write', close: event.method === 'close',
    })[point];
    fs.hook = event => { if (match(event)) return blocked.block(); };
    let result;
    if (point === 'close') {
      await workspace.append('data/a.ndjson', bytes('secret'));
      result = assert.rejects(collect(workspace.open('data/a.ndjson')), abortError);
    } else result = assert.rejects(workspace.append('data/a.ndjson', bytes('secret'), controller.signal), abortError);
    await blocked.entered;
    controller.abort();
    const cleanup = workspace.abort('cancel');
    await promptly(result);
    await promptly(assert.rejects(cleanup, cleanupError));
    assert.throws(() => workspace.open('data/a.ndjson'), abortError);
    await assert.rejects(workspace.append('data/new.ndjson', bytes('late')), abortError);
    blocked.release();
    await tick(); await tick();
    assert.equal(fs.opfs.entries.size, 0);
    assert.equal(workspace.abort('again'), cleanup);
    await assert.rejects(workspace.abort('again'), cleanupError);
    assert.ok(fs.log.filter(event => event.method === 'write').length <= 1);
  });
}

test('already-aborted append signal invalidates the entire workspace without creating a directory', async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())(), controller = new AbortController();
  controller.abort();
  await assert.rejects(workspace.append('data/a.ndjson', bytes('secret'), controller.signal), abortError);
  await workspace.abort('again');
  await assert.rejects(workspace.append('data/b.ndjson', bytes('late')), abortError);
  assert.equal(fs.opfs.entries.size, 0);
});

test('cancellation of a blocked disk read returns promptly and pre-opened sources stay invalidated', async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())(), blocked = gate();
  await workspace.append('data/a.ndjson', bytes('secret'));
  const input = workspace.open('data/a.ndjson');
  fs.hook = event => { if (event.method === 'read' && event.phase === 'before') return blocked.block(); };
  const result = assert.rejects(collect(input), abortError);
  await blocked.entered;
  await workspace.abort('cancel');
  await promptly(result);
  blocked.release();
  await assert.rejects(collect(input), abortError);
  assert.equal(fs.opfs.entries.size, 0);
});

for (const method of ['remove', 'abort']) test(`actual cleanup ${method} failure rejects persistently rather than claiming success`, async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())();
  await workspace.append('data/a.ndjson', bytes('secret'));
  fs.hook = event => { if (event.method === method && event.phase === 'before') throw domError('NotAllowedError'); };
  const cleanup = workspace.abort('cancel');
  await assert.rejects(cleanup, cleanupError);
  assert.equal(workspace.abort('retry'), cleanup);
  await assert.rejects(workspace.abort('retry'), cleanupError);
  if (method === 'remove') assert.equal(fs.opfs.entries.size, 1);
  assert.throws(() => workspace.open('data/a.ndjson'), abortError);
  assert.equal(fs.log.filter(event => event.method === method).length, 1);
});

for (const method of ['remove', 'abort']) test(`permanently blocked cleanup ${method} is bounded and reported as unconfirmed`, { timeout: 4000 }, async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())();
  await workspace.append('data/a.ndjson', bytes('secret'));
  fs.hook = event => { if (event.method === method && event.phase === 'before') return new Promise(() => {}); };
  const start = performance.now();
  await promptly(assert.rejects(workspace.abort('cancel'), cleanupError), 2500);
  assert.ok(performance.now() - start < 2500);
  assert.throws(() => workspace.open('data/a.ndjson'), abortError);
});

test('external removal of the owned temporary directory is already clean, unrelated data is untouched', async t => {
  const { fs } = fixture(t), workspace = (await api.createBrowserWorkspaceFactory())();
  await workspace.append('data/a.ndjson', bytes('secret'));
  await collect(workspace.open('data/a.ndjson'));
  const name = [...fs.opfs.entries.keys()][0];
  await fs.opfs.removeEntry(name, { recursive: true });
  await workspace.abort('already removed');
  assert.equal(fs.opfs.entries.size, 0);
});

test('OPFS UUID collisions are refused without claiming/deleting existing workspaces', async t => {
  const { fs } = fixture(t);
  t.mock.method(globalThis.crypto, 'randomUUID', () => '00000000-0000-4000-8000-000000000000');
  const factory = await api.createBrowserWorkspaceFactory(), a = factory();
  assert.throws(() => factory(), /Duplicate/);
  await a.append('data/a.ndjson', bytes('original'));
  const existing = [...fs.opfs.entries.values()][0];
  const otherFactory = await api.createBrowserWorkspaceFactory();
  assert.throws(() => otherFactory(), /Duplicate/);
  assert.equal([...fs.opfs.entries.values()][0], existing);
  assert.equal((await collect(a.open('data/a.ndjson'))).toString(), 'original');
  await a.abort('done');
});

test('concurrent output picks cannot reuse a UUID even before directory creation finishes', async t => {
  const { fs } = fixture(t);
  t.mock.method(globalThis.crypto, 'randomUUID', () => '00000000-0000-4000-8000-000000000003');
  const results = await Promise.allSettled([api.pickTransferDirectory(), api.pickTransferDirectory()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(fs.selected.entries.size, 1);
  assert.equal(fs.log.filter(event => event.create).length, 1);
});

for (const kind of ['file', 'directory']) test(`pre-existing OPFS ${kind} collision is never claimed or cleaned`, async t => {
  const { fs } = fixture(t);
  const uuid = kind === 'file' ? '00000000-0000-4000-8000-000000000004' : '00000000-0000-4000-8000-000000000005';
  t.mock.method(globalThis.crypto, 'randomUUID', () => uuid);
  const name = `migration-plaintext-${uuid}`;
  const existing = kind === 'file' ? fs.seed(fs.opfs, name, 'keep') : fs.directory(name, fs.opfs);
  fs.opfs.entries.set(name, existing);
  const workspace = (await api.createBrowserWorkspaceFactory())();
  await assert.rejects(workspace.append('data/a.ndjson', bytes('replacement')));
  await workspace.abort('collision');
  assert.equal(fs.opfs.entries.get(name), existing);
  assert.ok(fs.log.every(event => !event.create && event.method !== 'remove'));
});

test('synthetic browser disk adapters round-trip a real encrypted container and independent readback workspace', async t => {
  const { fs } = fixture(t), directory = await api.pickTransferDirectory();
  const factory = await api.createBrowserWorkspaceFactory(), snapshot = factory(), readback = factory();
  const path = 'data/records.ndjson', text = '{"amount":12345678901234567890.123456789,"nullable":null}\r\n';
  await snapshot.append(path, bytes(text));
  const file = directory.createFile('archive.edx');
  const info = { scope: 'replacement-backup', exportId: 'offline-export', volumeId: 'offline-volume',
    sourceSiteId: '00000000-0000-4000-8000-000000000000', createdAt: '2026-10-20T00:00:00.000Z', volumeIndex: 1, volumeCount: 1 };
  const passphrase = 'offline browser storage passphrase';
  const entries = (async function* () { yield { path, bytes: bytes(text).length, open: () => snapshot.open(path) }; })();
  await file.write(api.writeEncryptedVolume(entries, info, passphrase));
  await snapshot.abort('snapshot discarded');
  const manifest = await api.verifyEncryptedVolume(file.open(), passphrase, readback, {
    expectedMetadata: { exportId: info.exportId, volumeId: info.volumeId },
  });
  assert.equal(manifest.entries.length, 1);
  assert.equal((await collect(readback.open(path))).toString(), text);
  await readback.abort('authenticated temporary plaintext discarded');
  assert.equal(fs.opfs.entries.size, 0);
  assert.ok(fs.find(`selected/${directory.name}/archive.edx`).content.length > text.length);
  const raw = await collect(file.open());
  assert.equal(raw.includes(Buffer.from(text)), false);
  assert.ok(fs.log.filter(event => event.method === 'remove').every(event => event.path.startsWith('opfs/')));
});
