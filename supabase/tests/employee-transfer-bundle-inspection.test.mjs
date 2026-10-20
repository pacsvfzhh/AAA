import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Read-only inspectors: in-memory fixtures only, no media session/target/RPC and no network.
// Fixture builders are sliced from the existing synthetic suites so they cannot drift from the stage tests.
mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
const logs = ['log', 'warn', 'error', 'info', 'debug', 'trace'].map(k => mock.method(console, k, () => {}));
const root = fileURLToPath(new URL('../../', import.meta.url));
const tests = fileURLToPath(new URL('./', import.meta.url));
const scopeUrl = pathToFileURL(`${tests}support/transfer-scope.mjs`).href;
const temp = await mkdtemp(join(tmpdir(), 'bundle-inspection-'));
after(async () => {
  for (const log of logs) assert.equal(log.mock.callCount(), 0);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  mock.restoreAll();
  await rm(temp, { recursive: true, force: true });
});

const compiled = await build({
  stdin: { contents: `export * as verification from './src/lib/employeeTransfer/verificationMedia.ts';
    export * as notifications from './src/lib/employeeTransfer/notificationsMedia.ts';
    export * as chat from './src/lib/employeeTransfer/chatMedia.ts';
    export * as archive from './src/lib/employeeTransfer/archiveBundle.ts';
    export {setHarness} from 'inspect-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020',
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://offline.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('offline-test-key') },
  plugins: [{ name: 'offline-only', setup(b) {
    b.onResolve({ filter: /^(?:inspect-test:state|\.\.\/(?:auth|supabase))$/ }, a => ({ path: a.path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === 'inspect-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth' ? "import{current}from'inspect-test:state';export const getAdminFinancialSessionToken=()=>current().session;"
        : "import{current}from'inspect-test:state';export const supabase={rpc:()=>{throw new Error('RPC forbidden')}};" }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);

async function fixtures(name, file, from, to, names) {
  const source = await readFile(`${tests}${file}`, 'utf8');
  const start = source.search(from), end = source.search(to);
  assert.ok(start >= 0 && end > start, `fixture slice ${name}`);
  const body = `import { createHash } from 'node:crypto';\nimport { TRANSFER_SCOPE_COVERAGE_INVENTORY } from ${JSON.stringify(scopeUrl)};\n`
    + `${source.slice(start, end)}\nexport { ${names.join(', ')} };\n`;
  const path = join(temp, `${name}.mjs`);
  await writeFile(path, body);
  return import(pathToFileURL(path).href);
}
const V = await fixtures('verification', 'employee-transfer-verification-client.test.mjs', /^const ORIGIN/m, /^const noNetwork/m,
  ['fixture', 'RECORD_PATH', 'mediaPath', 'sha']);
const C = await fixtures('chat', 'employee-transfer-chat-media-client.test.mjs', /^const ORIGIN/m, /^const plan = f =>/m,
  ['fixture', 'TABLES', 'recordPath', 'mediaPath', 'sha']);
const N = await fixtures('notifications', 'employee-transfer-notifications-media-client.test.mjs', /^const ORIGIN/m, /^function plan\(f\)/m,
  ['fixture', 'TABLES', 'recordPath', 'mediaPath', 'sha']);
const A = await fixtures('archive', 'employee-transfer-archive-bundle.test.mjs', /^const TABLES/m, /^function fixture\(t/m,
  ['texts', 'catalog', 'mediaFor', 'TABLES', 'tablePath', 'SITE', 'PACKAGE', 'VOLUME', 'sha']);

const SECRET = 'never-echo-inspection-secret';
const sha = value => createHash('sha256').update(value).digest('hex');
const copy = f => structuredClone({ ...f, contents: undefined });
function source(contents, hooks = {}) {
  const map = new Map([...contents].map(([path, raw]) => [path, Uint8Array.from(raw)]));
  const state = { aborted: 0, opens: [] };
  return { state, map, paths: () => [...map.keys()], async abort() { state.aborted++; },
    open(path) {
      state.opens.push(path);
      const raw = map.get(path);
      return (async function* () {
        if (hooks.onOpen) await hooks.onOpen(path);
        if (!raw) throw new Error(SECRET);
        for (let at = 0; at < raw.length; at += 113) yield raw.slice(at, at + 113);
      })();
    } };
}
const same = bytes => Uint8Array.from(bytes, (_, i) => bytes[i]);
const generic = error => { assert.ok(error instanceof Error); assert.ok(!String(error.message).includes(SECRET)); assert.equal('cause' in error, false); return true; };

// Per-module adapters: build a fresh mutable bundle, then inspect it.
const adapters = [
  { name: 'verification', fn: api.verification.inspectVerificationBundle, change: '+123', changed: '+124',
    make() {
      const f = V.fixture({ bytes: Uint8Array.of(255, 216, 255, 224, 1, 2, 3, 4, 255, 217) }), contents = new Map(f.contents);
      // The default fixture has a single document; add two more distinct employees' documents by hand is unnecessary.
      return { contents, manifest: structuredClone(f.manifest), mediaList: structuredClone(f.media), catalog: f.catalog,
        input: m => ({ catalog: m.catalog, media: m.mediaList, manifest: m.manifest }), recordPath: V.RECORD_PATH, mediaPath: V.mediaPath, expectFiles: 1 };
    } },
  { name: 'notifications', fn: api.notifications.inspectNotificationsBundle, change: '原文', changed: '原丈',
    make() {
      const f = N.fixture(), contents = new Map(f.contents);
      return { contents, manifest: structuredClone(f.manifest), mediaList: structuredClone(f.media), catalog: f.catalog,
        input: m => ({ catalog: m.catalog, media: m.mediaList, manifest: m.manifest }), recordPath: N.recordPath(N.TABLES[8]), mediaPath: N.mediaPath, expectFiles: 7 };
    } },
  { name: 'chat', fn: api.chat.inspectChatBundle, change: '原文', changed: '原丈',
    make() {
      const f = C.fixture(), contents = new Map(f.contents);
      return { contents, manifest: structuredClone(f.manifest), mediaList: structuredClone(f.media.files), catalog: f.catalog, wrap: f.media,
        input: m => ({ catalog: m.catalog, media: { ...m.wrap, files: m.mediaList }, manifest: m.manifest }), recordPath: C.recordPath(C.TABLES[1]), mediaPath: C.mediaPath, expectFiles: 5 };
    } },
];
function entryOf(m, path) { return m.manifest.entries.find(e => e.path === path); }
function refresh(m, path, raw) { m.contents.set(path, raw); const e = entryOf(m, path); e.bytes = raw.length; e.sha256 = sha(raw); }

for (const a of adapters) {
  const run = (m, files, options) => a.fn(m.input(m), files, options);
  test(`${a.name}: valid bundle is inspected read-only and workspace stays owned by the caller`, async () => {
    const m = a.make(), files = source(m.contents);
    const result = await run(m, files);
    assert.equal(result.files, m.expectFiles); assert.equal(result.fullSiteComplete, false);
    assert.ok(result.rows >= 1); assert.equal(result.bytes, m.manifest.entries.reduce((n, e) => n + e.bytes, 0));
    assert.equal(files.state.aborted, 0);
    assert.ok(files.map.size > 0);
  });
  test(`${a.name}: file removed from media list and manifest while records still reference it is rejected`, async () => {
    const m = a.make(), gone = m.mediaList.pop();
    m.contents.delete(m.mediaPath(gone)); m.manifest.entries = m.manifest.entries.filter(e => e.path !== m.mediaPath(gone));
    await assert.rejects(run(m, source(m.contents)), generic);
  });
  test(`${a.name}: extra physical file or extra manifest entry is rejected`, async () => {
    const extra = a.make(); extra.contents.set('media/extra/unlisted.bin', Uint8Array.of(1, 2, 3));
    await assert.rejects(run(extra, source(extra.contents)), generic);
    const listed = a.make(); listed.manifest.entries.push({ path: 'media/extra/listed.bin', kind: 'media', bytes: 3, sha256: sha(Uint8Array.of(1, 2, 3)) });
    listed.contents.set('media/extra/listed.bin', Uint8Array.of(1, 2, 3));
    await assert.rejects(run(listed, source(listed.contents)), generic);
  });
  test(`${a.name}: actual media byte drift is rejected even when length is unchanged`, async () => {
    const m = a.make(), file = m.mediaList[0], path = m.mediaPath(file), raw = same(m.contents.get(path));
    raw[raw.length - 1] ^= 1; m.contents.set(path, raw);
    await assert.rejects(run(m, source(m.contents)), generic);
  });
  test(`${a.name}: wrong magic is rejected even when hashes were re-signed`, async () => {
    const m = a.make(), file = m.mediaList[0], path = m.mediaPath(file), raw = new Uint8Array(m.contents.get(path).length).fill(90);
    file.sha256 = sha(raw); refresh(m, path, raw);
    await assert.rejects(run(m, source(m.contents)), generic);
  });
  test(`${a.name}: record content change is caught by the per-table hash after the manifest was re-signed`, async () => {
    const m = a.make(), text = Buffer.from(m.contents.get(m.recordPath)).toString('utf8');
    assert.ok(text.includes(a.change));
    const raw = Buffer.from(text.replace(a.change, a.changed));
    assert.equal(raw.length, m.contents.get(m.recordPath).length);
    refresh(m, m.recordPath, Uint8Array.from(raw));
    await assert.rejects(run(m, source(m.contents)), generic);
  });
  test(`${a.name}: pre-aborted and mid-read cancellation reject without cleaning the workspace`, async () => {
    const m = a.make(), pre = new AbortController(); pre.abort();
    const files = source(m.contents);
    await assert.rejects(run(m, files, { signal: pre.signal }), error => generic(error) && error.cancelled === true);
    assert.equal(files.state.opens.length, 0);
    const live = new AbortController(), second = source(m.contents, { onOpen: path => { if (path.startsWith('media/')) live.abort(); } });
    await assert.rejects(run(m, second, { signal: live.signal }), error => generic(error) && error.cancelled === true);
    assert.equal(second.state.aborted, 0);
  });
  test(`${a.name}: backend or reader failures are generalised`, async () => {
    const m = a.make(); m.contents.delete(m.recordPath);
    const files = source(new Map([...m.contents, [m.recordPath, Uint8Array.of(1)]]));
    files.map.delete(m.recordPath);
    files.paths = () => [...m.contents.keys(), m.recordPath];
    await assert.rejects(run(m, files), generic);
    assert.equal(files.state.aborted, 0);
  });
}

function archiveBundle(mutate) {
  const text = A.texts(), catalog = A.catalog(text), { refs, payloads } = A.mediaFor(text, catalog);
  const files = refs.map(ref => payloads.get(ref.key).file), bytes = refs.map(ref => Uint8Array.from(payloads.get(ref.key).raw));
  const m = { text, catalog, files, contents: new Map() };
  mutate?.(m);
  const enc = value => new Uint8Array(Buffer.from(value));
  const directory = enc(m.files.map(file => JSON.stringify(file) + '\n').join(''));
  m.contents = new Map([...A.TABLES.map(key => [A.tablePath(key), enc(m.text[key])]),
    ['data/archive-media.ndjson', directory], ['data/archive-catalog.ndjson', enc(JSON.stringify(m.catalog) + '\n')],
    ...m.files.map((file, i) => [`media/content-audit-evidence/${file.key}`, m.bytes?.[i] ?? bytes[i]])]);
  m.manifest = { version: 1, scope: 'replacement-backup', exportId: A.PACKAGE, volumeId: A.VOLUME, sourceSiteId: A.SITE,
    createdAt: '2026-10-20T00:00:00.000Z', volumeIndex: 1, volumeCount: 1,
    entries: [...m.contents].map(([path, raw]) => ({ path, kind: path.startsWith('media/') ? 'media' : 'ndjson', bytes: raw.length, sha256: sha(raw) })) };
  return m;
}
const archiveErr = error => { assert.equal(error.name, 'ArchiveBundleError'); assert.ok(!String(error.message).includes(SECRET)); return true; };
function workspace(contents, hooks = {}) {
  const state = { aborted: 0, appended: 0, opens: [] };
  return { state, append: async () => { state.appended++; }, abort: async () => { state.aborted++; },
    open(path) {
      state.opens.push(path);
      const raw = contents.get(path);
      return (async function* () {
        if (hooks.onOpen) await hooks.onOpen(path);
        if (!raw) throw new Error(SECRET);
        for (let at = 0; at < raw.length; at += 113) yield raw.slice(at, at + 113);
      })();
    } };
}
test('archive: valid bundle is inspected without import and the external workspace is not cleaned', async () => {
  const m = archiveBundle(), space = workspace(m.contents);
  const result = await api.archive.inspectArchiveBundle(space, m.manifest);
  assert.equal(result.fullSiteComplete, false); assert.ok(result.files >= 1); assert.ok(result.rows >= 6);
  assert.equal(result.bytes, m.manifest.entries.reduce((n, e) => n + e.bytes, 0));
  assert.equal(space.state.aborted, 0); assert.equal(space.state.appended, 0);
});
test('archive: file removed from directory and manifest while records still reference it is rejected', async () => {
  const m = archiveBundle(x => { x.files = x.files.slice(0, -1); x.bytes = x.files.map(() => Uint8Array.of(255, 216, 255, 0, 1, 2, 3, 4)); });
  assert.ok(m.files.length >= 0);
  await assert.rejects(api.archive.inspectArchiveBundle(workspace(m.contents), m.manifest), archiveErr);
});
test('archive: extra manifest entry, media drift, record hash and magic failures are rejected', async () => {
  const extra = archiveBundle(); extra.contents.set('media/extra/x', Uint8Array.of(1));
  extra.manifest.entries.push({ path: 'media/extra/x', kind: 'media', bytes: 1, sha256: sha(Uint8Array.of(1)) });
  await assert.rejects(api.archive.inspectArchiveBundle(workspace(extra.contents), extra.manifest), archiveErr);

  const drift = archiveBundle(), mediaPath = [...drift.contents.keys()].find(p => p.startsWith('media/'));
  const raw = same(drift.contents.get(mediaPath)); raw[raw.length - 1] ^= 1;
  await assert.rejects(api.archive.inspectArchiveBundle(workspace(new Map([...drift.contents, [mediaPath, raw]])), drift.manifest), archiveErr);

  const rec = archiveBundle(), table = A.tablePath(A.TABLES[0]);
  const edited = Uint8Array.from(Buffer.from(Buffer.from(rec.contents.get(table)).toString('utf8').replace('历史管理员', '历史管理吊')));
  assert.equal(edited.length, rec.contents.get(table).length);
  const entry = rec.manifest.entries.find(e => e.path === table); entry.sha256 = sha(edited);
  await assert.rejects(api.archive.inspectArchiveBundle(workspace(new Map([...rec.contents, [table, edited]])), rec.manifest), archiveErr);

  const magic = archiveBundle(), path = [...magic.contents.keys()].find(p => p.startsWith('media/')), bad = new Uint8Array(8).fill(90);
  const file = magic.files.find(f => path.endsWith(f.key)); file.sha256 = sha(bad);
  const resigned = archiveBundle(x => { x.files = x.files.map(f => f.key === file.key ? { ...f, sha256: sha(bad) } : f); x.bytes = x.files.map(() => bad); });
  await assert.rejects(api.archive.inspectArchiveBundle(workspace(resigned.contents), resigned.manifest), archiveErr);
});
test('archive: cancellation and reader failure are generalised and never clean the caller workspace', async () => {
  const m = archiveBundle(), pre = new AbortController(); pre.abort();
  const space = workspace(m.contents);
  await assert.rejects(api.archive.inspectArchiveBundle(space, m.manifest, { signal: pre.signal }), error => archiveErr(error) && error.cancelled === true);
  const live = new AbortController(), second = workspace(m.contents, { onOpen: path => { if (path.startsWith('media/')) live.abort(); } });
  await assert.rejects(api.archive.inspectArchiveBundle(second, m.manifest, { signal: live.signal }), error => archiveErr(error) && error.cancelled === true);
  const broken = new Map(m.contents); broken.delete(A.tablePath(A.TABLES[0]));
  const third = workspace(broken);
  await assert.rejects(api.archive.inspectArchiveBundle(third, m.manifest), archiveErr);
  for (const s of [space, second, third]) assert.equal(s.state.aborted, 0);
});
