import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync } from 'node:fs';
import { open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Real re-export, archive/media clients, WebCrypto and container authentication.
// ONLY auth/RPC and the Edge transport are synthetic SQL38-shaped receipts.
// Normal ciphertext fixtures are saved to disk; overwrite/loss regressions use
// bounded memory slots. Temporary plaintext is copied, invalidated and zeroed on
// abort. No import, Storage or native PG claim.
mock.method(globalThis, 'fetch', () => assert.fail('All network/production access is forbidden'));
after(() => { assert.equal(globalThis.fetch.mock.callCount(), 0); mock.restoreAll(); });
const root = fileURLToPath(new URL('../../', import.meta.url));
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/archiveReexport.ts';
  export {exportArchiveBundle, ArchiveBundleError, ARCHIVE_BUNDLE_CATALOG_PATH, ARCHIVE_BUNDLE_MEDIA_PATH} from './src/lib/employeeTransfer/archiveBundle.ts';
  export {verifyEncryptedVolume} from './src/lib/employeeTransfer/container.ts';
  export {setHarness} from 'reexport-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://offline.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('offline-test-key') },
  plugins: [{ name: 'offline-reexport', setup(builder) {
    builder.onResolve({ filter: /^(?:reexport-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'offline' }));
    builder.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => {
      if (path === 'reexport-test:state') return { contents: 'let h;export const setHarness=v=>{h=v};export const current=()=>h;' };
      if (path === '../auth') return { contents: "import{current}from'reexport-test:state';export function getAdminFinancialSessionToken(){const h=current();h.tokenReads++;if(h.authError)throw Error(h.authError);return h.session;}" };
      return { contents: "import{current}from'reexport-test:state';export const supabase={rpc:(...args)=>current().rpc(...args)};" };
    });
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const TABLES = ['content_audit_events', 'deleted_employee_accounts', 'deleted_employee_notifications',
  'content_audit_recipient_versions', 'deleted_employee_summaries', 'deleted_employee_withdrawals'];
const id = n => `38000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SITE = id(1), PACKAGE = id(2), SESSION = id(3), RELAY = id(999);
const TIME = '2024-02-29T23:34:56.123456+00:00';
const PRECISE = '12345678901234567890.12345678901234567890';
const PASS = 'offline namespace re-export passphrase', SECRET = 'private backend error must not escape';
const PREFIX = 'get_employee_archive_reexport_';
const READ_RPCS = ['inventory', 'catalog', 'page', 'verify', 'media'].map(key => PREFIX + key);
const sha = value => createHash('sha256').update(value).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
const tablePath = key => `data/archives-${key}.ndjson`;
const mediaPath = key => `media/content-audit-evidence/${key}`;
const verification = { verified: true, scope: 'site-archives', media_pending: true, full_site_complete: false };
// Complete tiny PNG/JPEG files, not JSON receipts or signature-only stand-ins.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCFgA//2Q==', 'base64');
function originalRows(label, event = 100, media = true) {
  return [
    { id: id(event), operation_id: id(10), entity_type: 'notification', entity_id: id(11), action: 'edit',
      owner_admin_id: id(12), owner_username: '原管理员', actor_admin_id: null, actor_username: '原操作者', actor_role: 'super_admin',
      customer_id: null, employee_id: id(13), occurred_at: TIME,
      before_data: null, after_data: { label, amount: '__PRECISE__', session_created_at: TIME, last_heartbeat_at: TIME, optional: null,
        html: '<script>not executed</script>', nested: { tiny: '__TINY__', outsideJS: '__HUGE__' } },
      media_refs: media ? { 'https://source.invalid/evidence.png?a=1&b=2': `${id(14)}/shared/original.png`,
        '原始附件é 𠮷': `${id(14)}/shared/original.jpg` } : {},
      clear_reason: null, clear_started_at: null, cleared_at: null, cleared_by: null, cleared_username: null,
      employee_account: label, message_created_at: TIME, before_data_sql_null: true, after_data_sql_null: false },
    { id: id(110), operation_id: id(10), employee_id: id(13), account_username: label, employee_number: null,
      account_created_at: TIME, account_remarks: null, owner_admin_id: id(12), owner_username: '原管理员', actor_admin_id: id(12),
      actor_username: '原操作者', actor_role: 'super_admin', deletion_source: 'admin', deleted_at: TIME,
      cleared_at: null, cleared_by: null, cleared_username: null, clear_reason: null, account_real_name: null },
    { id: id(112), record_id: id(110), message_id: id(120), message_data: null, recipient_data: null,
      archived_event_id: id(100), cleared_at: null, cleared_by: null, clear_reason: null, message_data_sql_null: true, recipient_data_sql_null: false },
    { id: `${id(120)}:${id(13)}`, message_id: id(120), recipient_id: id(13), recipient_data: { label, amount: '__PRECISE__', optional: null } },
    { id: id(110), employee_id: id(13), source_present: false, is_verified: null, total_income: '__PRECISE__',
      available_balance: null, frozen_balance: '__TINY__', total_orders: '9223372036854775807' },
    { id: `${id(110)}:${id(111)}`, record_id: id(110), withdrawal_id: id(111), employee_id: id(13), amount: '__PRECISE__', status: 'approved', created_at: TIME },
  ];
}
function raw(row) {
  return JSON.stringify(row).replaceAll('"__PRECISE__"', PRECISE).replaceAll('"__TINY__"', '-0.00000000000000000001')
    .replaceAll('"__HUGE__"', '1e400').replace('"after_data":', '"\\u0061fter_data" : ') + ' \r\n';
}
function namespace(site = SITE, pkg = PACKAGE, options = {}) {
  const values = originalRows(options.label ?? '来源甲é 𠮷', 100, options.media !== false);
  const text = Object.fromEntries(TABLES.map((key, index) => [key, options.empty ? '' : raw(values[index])]));
  if (options.events) text[TABLES[0]] = Array.from({ length: options.events }, (_, n) =>
    raw(originalRows(options.label ?? '来源甲é 𠮷', 100 + n, n === 0 && options.media !== false)[0])).join('');
  const catalog = { version: 1, scope: 'site-archives', site_id: site, package_id: pkg,
    tables: TABLES.map(key => ({ key, rows: lines(text[key]).length, bytes: Buffer.byteLength(text[key]),
      row_hashes_sha256: sha(lines(text[key]).map(sha).join('')) })), full_site_complete: false };
  const refs = [], payloads = new Map();
  for (const line of lines(text[TABLES[0]])) {
    const event = JSON.parse(line);
    for (const [ref_key, ref_value] of Object.entries(event.media_refs)) {
      const source_line_sha256 = sha(line);
      const source_url = `archive-evidence-v1:${site}:${pkg}:${event.id}:${source_line_sha256}:${sha(ref_key)}:${sha(ref_value)}`;
      const key = sha(source_url), content_type = ref_value.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const bytes = Buffer.from(content_type === 'image/png' ? PNG : JPEG);
      const file = { key, source_url, bytes: bytes.length, sha256: sha(bytes), content_type };
      refs.push({ key, source_url, event_id: event.id, source_line_sha256, ref_key, ref_value, path: ref_value, bucket: 'content-audit-evidence', file });
      payloads.set(key, { file, bytes });
    }
  }
  refs.sort((a, b) => a.key < b.key ? -1 : 1);
  // SQL38 hash is opaque to the client. The actual SQL hash is covered separately
  // by archive-reexport-db, not fabricated here as a database execution claim.
  const snapshot = { catalog, snapshot_hash: sha(JSON.stringify({ catalog, refs })) };
  return { text, catalog, snapshot, refs, payloads };
}
function inventoryFor(namespaces) {
  const snapshots = namespaces.map(n => structuredClone(n.snapshot)).sort((a, b) =>
    `${a.catalog.site_id}:${a.catalog.package_id}` < `${b.catalog.site_id}:${b.catalog.package_id}` ? -1 : 1);
  return { scope: 'transferred-archives', namespaces: snapshots, fingerprint: sha(JSON.stringify(snapshots)), full_site_complete: false };
}
function mediaFor(n) {
  return { version: 1, scope: 'site-archives-media', direction: 'export', archives_catalog: structuredClone(n.catalog),
    files: structuredClone(n.refs), bound: true, verified: true,
    transferred: n.refs.map(ref => ref.key), checked: n.refs.map(ref => ref.key), full_site_complete: false };
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, ns = [namespace()]) {
  const directory = mkdtempSync(join(tmpdir(), 'archive-reexport-'));
  const h = { session: SESSION, tokenReads: 0, authError: null, namespaces: ns, calls: [], reads: [], spaces: [], outputs: [],
    prepareCalls: [], namespaceProgress: [], progress: [], rpcEdit: null, edgeEdit: null, fileWritten: null, prepareEdit: null };
  api.setHarness(h);
  t.after(async () => {
    assert.ok(h.calls.every(call => READ_RPCS.includes(call.name)), 'no write/import/begin/bind/stage/close RPC');
    assert.ok(h.reads.every(read => read.init.headers['x-transfer-action'] === 'read'));
    for (const space of h.spaces) { assert.equal(space.dead, true); assert.equal(space.cleanups, 1); assert.equal(space.data.size, 0); }
    await rm(directory, { recursive: true, force: true });
  });
  h.rpc = (name, args) => {
    assert.ok(READ_RPCS.includes(name), `Forbidden RPC ${name}`);
    assert.equal(args.p_admin_session_token, h.session, 'fresh admin session, not cached token or admin id');
    const call = { name, args: structuredClone(args), signal: undefined }; h.calls.push(call);
    const query = { abortSignal(signal) { call.signal = signal; return query; }, then(resolve, reject) {
      return Promise.resolve().then(async () => {
        const base = () => {
          if (name === PREFIX + 'inventory') {
            assert.deepEqual(Object.keys(args), ['p_admin_session_token']); return inventoryFor(h.namespaces);
          }
          const n = h.namespaces.find(n => n.catalog.site_id === args.p_source_site_id && n.catalog.package_id === args.p_package_id);
          if (!n) throw Error(SECRET);
          if (name === PREFIX + 'catalog') return structuredClone(n.snapshot);
          if (args.p_snapshot_hash !== n.snapshot.snapshot_hash) throw Error(SECRET);
          if (name === PREFIX + 'verify') return structuredClone(verification);
          if (name === PREFIX + 'media') return mediaFor(n);
          assert.equal(args.p_limit, 200);
          const all = lines(n.text[args.p_table_key]);
          const start = args.p_after === null ? 0 : all.findIndex(line => JSON.parse(line).id === args.p_after) + 1;
          if (args.p_after !== null && start === 0) throw Error(SECRET);
          const picked = []; let size = 0;
          for (const line of all.slice(start, start + 200)) {
            if (size + Buffer.byteLength(line) > 262144) break;
            picked.push(line); size += Buffer.byteLength(line);
          }
          const ndjson = picked.join('');
          return { table_key: args.p_table_key, count: picked.length, ndjson, sha256: sha(ndjson),
            next_after: start + picked.length < all.length ? JSON.parse(picked.at(-1)).id : null };
        };
        let reply = { data: base(), error: null };
        if (h.rpcEdit) reply = await h.rpcEdit(call, reply) ?? reply;
        return reply;
      }).then(resolve, reject);
    } }; return query;
  };
  h.transport = async (url, init) => {
    assert.equal(url, 'https://offline.supabase.co/functions/v1/employee-transfer-media');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    assert.deepEqual(init.headers, { apikey: 'offline-test-key', 'Content-Type': 'application/json',
      'x-transfer-scope': 'archives', 'x-transfer-action': 'read', 'x-admin-session-token': h.session });
    const binding = JSON.parse(init.body);
    assert.deepEqual(Object.keys(binding).sort(), ['event_id', 'package_id', 'ref_key', 'source_site_id']);
    const n = h.namespaces.find(n => n.catalog.site_id === binding.source_site_id && n.catalog.package_id === binding.package_id);
    const ref = n?.refs.find(ref => ref.event_id === binding.event_id && ref.ref_key === binding.ref_key);
    assert.ok(ref, 'only exact namespace/event/original-ref binding; never Storage path, URL or job token');
    const payload = n.payloads.get(ref.key), bytes = Buffer.from(payload.bytes);
    const headers = { 'content-type': payload.file.content_type, 'x-transfer-content-type': payload.file.content_type, 'x-transfer-sha256': sha(bytes) };
    const read = { binding, key: ref.key, init }; h.reads.push(read);
    const response = new Response(bytes, { headers });
    return h.edgeEdit ? await h.edgeEdit(read, response, { bytes, headers, ref, n }) ?? response : response;
  };
  h.createWorkspace = () => {
    const data = new Map(), space = { data, dead: false, cleanups: 0, opens: [] };
    h.spaces.push(space);
    return Object.assign(space, {
      async append(path, bytes, signal) {
        assert.equal(space.dead, false); assert.notEqual(signal?.aborted, true);
        assert.ok(bytes instanceof Uint8Array && bytes.length <= 1048576);
        const previous = data.get(path) ?? Buffer.alloc(0), combined = Buffer.concat([previous, Buffer.from(bytes)]);
        assert.ok(combined.length <= 1048576, 'strict fixture memory bound per entry');
        previous.fill(0); data.set(path, combined);
        assert.ok([...data.values()].reduce((n, value) => n + value.length, 0) <= 4 * 1048576);
      },
      open(path) {
        assert.equal(space.dead, false); assert.ok(data.has(path), `missing temporary entry ${path}`);
        space.opens.push(path);
        return { async *[Symbol.asyncIterator]() {
          const saved = data.get(path);
          for (let i = 0; i < saved.length; i += 137) { assert.equal(space.dead, false); yield Buffer.from(saved.subarray(i, i + 137)); }
        } };
      },
      async abort() {
        space.cleanups++; space.dead = true;
        for (const bytes of data.values()) bytes.fill(0);
        data.clear();
      },
    });
  };
  h.prepare = async (snapshot, index, total) => {
    h.prepareCalls.push({ snapshot: structuredClone(snapshot), index, total });
    const path = join(directory, `namespace-${index}.edx`);
    const info = { scope: 'replacement-backup', exportId: snapshot.catalog.package_id, volumeId: id(10000 + index),
      sourceSiteId: snapshot.catalog.site_id, createdAt: '2026-10-20T00:00:00.000Z', volumeIndex: 1, volumeCount: 1 };
    const output = { path, info, writes: 0, opens: 0, eof: 0 };
    const file = {
      async write(source, signal) {
        output.writes++; const handle = await open(path, 'wx');
        try { for await (const chunk of source) { assert.equal(signal.aborted, false); await handle.writeFile(chunk); } await handle.sync(); }
        finally { await handle.close(); }
        if (h.fileWritten) await h.fileWritten(output);
      },
      open() {
        output.opens++;
        return { async *[Symbol.asyncIterator]() {
          for await (const chunk of createReadStream(path, { highWaterMark: 113 })) yield chunk;
          output.eof++;
        } };
      },
    };
    output.file = file; h.outputs.push(output);
    const prepared = { file, createWorkspace: h.createWorkspace, info };
    if (h.prepareEdit) await h.prepareEdit(prepared, output, index);
    return prepared;
  };
  h.export = (options = {}) => api.exportTransferredArchiveBundles(h.prepare, PASS, { transport: h.transport,
    onNamespace: progress => h.namespaceProgress.push(progress), onProgress: progress => h.progress.push(progress), ...options });
  h.sessionFor = (index = 0, expected = true) => {
    const n = h.namespaces[index];
    return api.createArchiveReexportSession(n.catalog.site_id, n.catalog.package_id, expected ? n.snapshot : undefined, h.transport);
  };
  return h;
}
const sanitized = error => {
  assert.ok(error instanceof Error); assert.equal(String(error).includes(SECRET), false); assert.equal('cause' in error, false); return true;
};
async function unpack(t, output) {
  const data = new Map();
  t.after(() => { for (const bytes of data.values()) bytes.fill(0); data.clear(); });
  const manifest = await api.verifyEncryptedVolume(output.file.open(), PASS, {
    async append(path, bytes) { data.set(path, Buffer.concat([data.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)]));
      assert.ok([...data.values()].reduce((n, value) => n + value.length, 0) <= 4 * 1048576); },
    async abort() { for (const bytes of data.values()) bytes.fill(0); data.clear(); },
  }, { expectedMetadata: { exportId: output.info.exportId, volumeId: output.info.volumeId } });
  return { data, manifest };
}
async function savedMatches(t, output, result, n) {
  assert.equal(output.writes, 1); assert.equal(output.opens, 2);
  assert.equal(output.eof, 2, 'saved ciphertext was authenticated through EOF and finally reopened through EOF');
  const encrypted = await readFile(output.path);
  assert.equal(encrypted.subarray(0, 8).toString(), 'EDXSTRM1');
  assert.equal(encrypted.includes(Buffer.from(PRECISE)), false); assert.equal(sha(encrypted), result.cipherSha256);
  assert.equal(encrypted.length, result.cipherBytes); assert.equal(result.recordsVerified, true); assert.equal(result.mediaVerified, true);
  assert.equal(result.fullSiteComplete, false); assert.deepEqual(result.catalog, n.catalog);
  const opened = await unpack(t, output);
  assert.equal(opened.manifest.sourceSiteId, n.catalog.site_id); assert.equal(opened.manifest.exportId, n.catalog.package_id);
  assert.notEqual(opened.manifest.sourceSiteId, RELAY);
  assert.deepEqual(JSON.parse(opened.data.get(api.ARCHIVE_BUNDLE_CATALOG_PATH)), n.catalog);
  for (const key of TABLES) assert.deepEqual(opened.data.get(tablePath(key)), Buffer.from(n.text[key]), `original ${key} bytes`);
  const files = lines(opened.data.get(api.ARCHIVE_BUNDLE_MEDIA_PATH).toString()).map(line => JSON.parse(line));
  assert.deepEqual(files, n.refs.map(ref => ref.file));
  for (const ref of n.refs) {
    assert.deepEqual(opened.data.get(mediaPath(ref.key)), n.payloads.get(ref.key).bytes);
    assert.ok(ref.source_url.startsWith(`archive-evidence-v1:${n.catalog.site_id}:${n.catalog.package_id}:${ref.event_id}:`));
    assert.ok(ref.source_url.includes(ref.source_line_sha256));
  }
  assert.equal(opened.data.size, 8 + n.refs.length);
  assert.equal(result.rows, n.catalog.tables.reduce((sum, table) => sum + table.rows, 0));
  assert.equal(result.files, n.refs.length);
  return opened;
}

// Deliberately overwritable encrypted save locations, not cached sources: every
// fresh wrapper opens the CURRENT bytes at its path. The adapter exposes only
// write/open, and all retained ciphertext is bounded and zeroed after the test.
function memoryCipherFiles(t) {
  const slots = new Map(), outputs = [], events = [];
  const replace = (path, bytes) => {
    const copied = bytes === null ? null : Buffer.from(bytes);
    assert.ok(copied === null || copied.length <= 1048576);
    slots.get(path)?.fill(0);
    if (copied === null) slots.delete(path); else slots.set(path, copied);
    assert.ok([...slots.values()].reduce((n, value) => n + value.length, 0) <= 4 * 1048576);
  };
  t.after(() => { for (const bytes of slots.values()) bytes.fill(0); slots.clear(); });
  const create = path => {
    const output = { path, writes: 0, opens: 0, eof: 0, saves: [] };
    output.file = {
      async write(source, signal) {
        output.writes++; const chunks = []; let size = 0;
        try {
          for await (const chunk of source) {
            assert.equal(signal.aborted, false); assert.ok(chunk instanceof Uint8Array);
            size += chunk.length; assert.ok(size <= 1048576); chunks.push(Buffer.from(chunk));
          }
          const bytes = Buffer.concat(chunks);
          try { replace(path, bytes); output.saves.push({ bytes: size, sha256: sha(bytes) }); }
          finally { bytes.fill(0); }
          events.push({ kind: 'saved', output });
        } finally { for (const chunk of chunks) chunk.fill(0); }
      },
      open() {
        output.opens++; events.push({ kind: 'open', output });
        return { async *[Symbol.asyncIterator]() {
          const bytes = slots.get(path);
          if (!bytes) throw Object.assign(new Error('Independent ciphertext is unavailable.'), { code: 'ENOENT' });
          for (let i = 0; i < bytes.length; i += 113) yield Buffer.from(bytes.subarray(i, i + 113));
          output.eof++; events.push({ kind: 'eof', output });
        } };
      },
    };
    outputs.push(output); return output;
  };
  return { slots, outputs, events, replace, create };
}

test('isolation includes actual archive/media/container clients but no Supabase/auth initialization', () => {
  const paths = Object.keys(compiled.metafile.inputs);
  for (const name of ['archiveReexport', 'archiveBundle', 'archiveTransfer', 'archiveMedia', 'container', 'crypto'])
    assert.ok(paths.some(path => path.endsWith(`/employeeTransfer/${name}.ts`)), name);
  assert.equal(paths.some(path => /src\/lib\/(?:auth|supabase)\.ts$|node_modules\/@supabase\//.test(path)), false);
});
test('one source: real disk ciphertext/readback retains catalog, raw precision/null/microseconds, original attachment identity and namespace', async t => {
  const n = namespace(SITE, PACKAGE, { events: 203 }), h = harness(t, [n]);
  const result = await h.export();
  assert.equal(result.fullSiteComplete, false); assert.deepEqual(result.inventory, inventoryFor([n]));
  assert.equal(result.volumes.length, 1); const opened = await savedMatches(t, h.outputs[0], result.volumes[0], n);
  const rawEvent = opened.data.get(tablePath(TABLES[0])).toString();
  for (const token of [PRECISE, TIME, '1e400', '-0.00000000000000000001', '"before_data_sql_null":true', '"\\u0061fter_data" : ', ' \r\n'])
    assert.ok(rawEvent.includes(token), token);
  const notification = opened.data.get(tablePath(TABLES[2])).toString();
  assert.ok(notification.includes('"message_data":null')); assert.ok(notification.includes('"message_data_sql_null":true'));
  assert.ok(notification.includes('"recipient_data":null')); assert.ok(notification.includes('"recipient_data_sql_null":false'));
  const eventPages = h.calls.filter(call => call.name === PREFIX + 'page' && call.args.p_table_key === TABLES[0]);
  assert.equal(eventPages.length, 2); assert.equal(eventPages[0].args.p_after, null); assert.equal(eventPages[1].args.p_after, id(299));
  assert.equal(h.calls.filter(call => call.name === PREFIX + 'inventory').length, 2);
  assert.deepEqual(h.namespaceProgress.map(p => p.completed), [0, 1, 1]);
  assert.ok(h.progress.every(p => p.fullSiteComplete === false));
  for (const ref of n.refs) assert.equal(h.reads.filter(read => read.key === ref.key).length, 2, 'download plus real Edge read recheck');
  assert.equal(h.spaces.length, 2); assert.ok(h.spaces.every(space => space.dead));
  assert.deepEqual(await api.getArchiveReexportInventory(), result.inventory, 'no catalog/package rewritten to relay after completion');
});
test('two source sites with the SAME package/event/employee UUID stay in distinct independently authenticated .edx namespaces', async t => {
  const a = namespace(), b = namespace(id(4), PACKAGE, { label: '来源乙' }), h = harness(t, [b, a]);
  const result = await h.export(); assert.equal(result.volumes.length, 2);
  for (const [index, n] of [a, b].entries()) await savedMatches(t, h.outputs[index], result.volumes[index], n);
  assert.notEqual(h.outputs[0].path, h.outputs[1].path); assert.notEqual(h.outputs[0].info.volumeId, h.outputs[1].info.volumeId);
  assert.equal(JSON.parse(lines(a.text[TABLES[0]])[0]).id, JSON.parse(lines(b.text[TABLES[0]])[0]).id);
  assert.equal(JSON.parse(a.text[TABLES[1]]).employee_id, JSON.parse(b.text[TABLES[1]]).employee_id);
  assert.equal(a.refs.some(ref => b.refs.some(other => ref.key === other.key)), false);
  assert.deepEqual(h.prepareCalls.map(p => [p.index, p.total]), [[0, 2], [1, 2]]);
  assert.deepEqual(await api.getArchiveReexportInventory(), inventoryFor([a, b]));
});
test('same site with different original packages remains two namespaces rather than one merged archive', async t => {
  const a = namespace(SITE, PACKAGE, { media: false }), b = namespace(SITE, id(5), { media: false }), h = harness(t, [a, b]);
  const result = await h.export();
  for (const [index, n] of [a, b].entries()) await savedMatches(t, h.outputs[index], result.volumes[index], n);
});
test('verified all-empty six-table namespace still saves/authenticates its own archive and media directory', async t => {
  const n = namespace(SITE, PACKAGE, { empty: true }), h = harness(t, [n]); const result = await h.export();
  const opened = await savedMatches(t, h.outputs[0], result.volumes[0], n);
  assert.equal(result.volumes[0].rows, 0); assert.equal(result.volumes[0].files, 0);
  assert.equal(opened.data.get(api.ARCHIVE_BUNDLE_MEDIA_PATH).length, 0); assert.equal(h.reads.length, 0);
});
test('no namespaces: authenticate and re-read empty inventory, never prepare fake/native/import volumes', async t => {
  const h = harness(t, []), result = await h.export();
  assert.deepEqual(result, { inventory: inventoryFor([]), volumes: [], fullSiteComplete: false });
  assert.deepEqual(h.calls.map(call => call.name), [PREFIX + 'inventory', PREFIX + 'inventory']);
  assert.equal(h.prepareCalls.length, 0); assert.equal(h.spaces.length, 0);
});
test('media verify/recheck require every file actually downloaded AND re-read, despite SQL verified receipts', async t => {
  const h = harness(t), session = h.sessionFor(), files = h.namespaces[0].refs.map(ref => ref.file);
  await session.source.catalog(); await session.media.inventory();
  await assert.rejects(session.media.verify(), sanitized); await assert.rejects(session.media.recheckExport(files), sanitized);
  assert.equal(h.reads.length, 0);
  await session.media.download(h.namespaces[0].refs[0]);
  await assert.rejects(session.media.recheckExport(files), sanitized); await assert.rejects(session.media.verify(), sanitized);
  assert.equal(h.reads.length, 1);
  await session.media.download(h.namespaces[0].refs[1]); await assert.rejects(session.media.verify(), sanitized);
  await session.media.recheckExport(files); assert.equal((await session.media.verify()).verified, true);
  assert.equal(h.reads.length, 4);
});
test('catalog/page/record verify/media share one exclusion lock, released after pending operation finishes', async t => {
  const h = harness(t), session = h.sessionFor(), blocked = deferred(), entered = deferred();
  h.rpcEdit = async call => { if (call.name === PREFIX + 'catalog') { entered.resolve(); await blocked.promise; } };
  const first = session.source.catalog(); await entered.promise;
  for (const action of [() => session.source.catalog(), () => session.source.page(TABLES[0], null), () => session.source.verify(),
    () => session.media.inventory(), () => session.media.status(), () => session.media.download(h.namespaces[0].refs[0]), () => session.media.verify()])
    await assert.rejects(action(), sanitized);
  assert.equal(h.calls.length, 1); blocked.resolve(); await first;
  assert.equal((await session.media.status()).verified, true);
});
test('each SQL38 request and real readArchiveMedia Edge request rereads token after re-login, propagating AbortSignal', async t => {
  const h = harness(t), session = h.sessionFor(), controller = new AbortController();
  const run = async action => { h.session = id(20000 + h.tokenReads); return action(); };
  await run(() => api.getArchiveReexportInventory(controller.signal));
  await run(() => session.source.catalog(controller.signal));
  await run(() => session.source.page(TABLES[0], null, controller.signal));
  await run(() => session.source.verify(controller.signal));
  await run(() => session.media.inventory(controller.signal));
  await run(() => session.media.status(controller.signal));
  for (const ref of h.namespaces[0].refs) await run(() => session.media.download(ref, controller.signal));
  await run(() => session.media.recheckExport(h.namespaces[0].refs.map(ref => ref.file), controller.signal));
  await run(() => session.media.verify(controller.signal));
  assert.equal(h.tokenReads, h.calls.length + h.reads.length);
  assert.ok(h.calls.every(call => call.signal === controller.signal));
  assert.ok(h.reads.every(read => read.init.signal === controller.signal));
  assert.ok(new Set(h.calls.map(call => call.args.p_admin_session_token)).size >= 8);
});
for (const value of [null, '', 'invalid', SITE + '\n', SITE.toUpperCase().replace('38000000', 'ABCDEF00')])
  test(`invalid namespace ${JSON.stringify(value)} never dispatches`, t => {
    const h = harness(t); assert.throws(() => api.createArchiveReexportSession(value, PACKAGE));
    assert.throws(() => api.createArchiveReexportSession(SITE, value)); assert.equal(h.calls.length, 0);
  });
test('expected namespace mismatch and calls needing an absent catalog never dispatch', async t => {
  const h = harness(t), snapshot = structuredClone(h.namespaces[0].snapshot); snapshot.catalog.package_id = id(900);
  assert.throws(() => api.createArchiveReexportSession(SITE, PACKAGE, snapshot));
  const session = h.sessionFor(0, false);
  for (const action of [() => session.source.page(TABLES[0], null), () => session.source.verify(), () => session.media.inventory()]) await assert.rejects(action(), sanitized);
  assert.equal(h.calls.length, 0);
  await session.source.catalog();
  for (const action of [() => session.source.page('users', null), () => session.source.page(TABLES[0], 'invalid'),
    () => session.source.page(TABLES[5], id(1))]) await assert.rejects(action(), sanitized);
  assert.equal(h.calls.length, 1);
});
for (const sessionValue of [null, 'invalid']) test(`missing/revoked local token ${sessionValue} prevents RPC and Edge dispatch`, async t => {
  const h = harness(t); h.session = sessionValue;
  await assert.rejects(api.getArchiveReexportInventory(), sanitized); await assert.rejects(h.sessionFor().source.catalog(), sanitized);
  assert.equal(h.calls.length, 0); assert.equal(h.reads.length, 0);
});
for (const [label, mutate] of [
  ['null snapshot', () => null], ['extra field', s => ({ ...s, job_token: SECRET })],
  ['hash missing', s => { delete s.snapshot_hash; }], ['hash nonhex', s => { s.snapshot_hash = 'g'.repeat(64); }],
  ['hash newline', s => { s.snapshot_hash += '\n'; }], ['catalog scope', s => { s.catalog.scope = 'full-site'; }],
  ['catalog complete', s => { s.catalog.full_site_complete = true; }], ['catalog unknown table', s => { s.catalog.tables[0].key = 'users'; }],
  ['catalog missing table', s => { s.catalog.tables.pop(); }], ['catalog bad counts', s => { s.catalog.tables[0].rows = -1; }],
  ['catalog missing package', s => { delete s.catalog.package_id; }],
]) test(`snapshot strict validator rejects ${label}`, t => {
  const h = harness(t), snapshot = structuredClone(h.namespaces[0].snapshot), replacement = mutate(snapshot);
  assert.throws(() => api.validateArchiveReexportSnapshot(replacement === undefined ? snapshot : replacement));
});
for (const [label, mutate] of [
  ['null', () => null], ['extra key', r => { r.token = SECRET; }], ['wrong scope', r => { r.scope = 'site-archives'; }],
  ['full-site escalation', r => { r.full_site_complete = true; }], ['fingerprint missing', r => { delete r.fingerprint; }],
  ['fingerprint nonhex', r => { r.fingerprint = 'z'.repeat(64); }], ['unsorted namespaces', r => { r.namespaces.reverse(); }],
  ['duplicate namespace', r => { r.namespaces.push(r.namespaces.at(-1)); }], ['nonarray', r => { r.namespaces = {}; }],
  ['sparse array', r => { delete r.namespaces[0]; }], ['unknown array property', r => { r.namespaces.extra = 'hidden'; }],
  ['malformed member', r => { r.namespaces[0].snapshot_hash = null; }],
  ['over 1000 namespaces', r => { r.namespaces = Array.from({ length: 1001 }, () => r.namespaces[0]); }],
]) test(`all-source inventory rejects ${label} rather than truncating or skipping`, t => {
  const h = harness(t, [namespace(), namespace(id(4))]), receipt = inventoryFor(h.namespaces), replacement = mutate(receipt);
  assert.throws(() => api.validateArchiveReexportInventory(replacement === undefined ? receipt : replacement));
});
for (const suffix of ['inventory', 'catalog', 'page', 'verify', 'media']) for (const mode of ['unknown transport', 'RPC error', 'malformed receipt'])
  test(`${suffix}: ${mode} is redacted, no retry/status/write fallback`, async t => {
    const h = harness(t), session = h.sessionFor(), name = PREFIX + suffix;
    h.rpcEdit = call => { if (call.name !== name) return;
      if (mode === 'unknown transport') throw Error(SECRET);
      return mode === 'RPC error' ? { data: null, error: { message: SECRET } } : { data: { unknown: SECRET }, error: null };
    };
    const action = ({ inventory: () => api.getArchiveReexportInventory(), catalog: () => session.source.catalog(),
      page: () => session.source.page(TABLES[0], null), verify: () => session.source.verify(), media: () => session.media.inventory() })[suffix];
    await assert.rejects(action(), sanitized); await tick();
    assert.deepEqual(h.calls.map(call => call.name), [name]); assert.equal(h.reads.length, 0); assert.equal(h.outputs.length, 0);
  });
for (const [label, edit] of [
  ['page hash', page => { page.sha256 = 'f'.repeat(64); }], ['page count', page => { page.count++; }],
  ['page table', page => { page.table_key = TABLES[1]; }], ['page cursor', page => { page.next_after = id(999); }],
  ['missing LF', page => { page.ndjson = page.ndjson.trim(); page.sha256 = sha(page.ndjson); }],
  ['unknown property', page => { page.storage_path = SECRET; }],
]) test(`page rejects ${label} before any saved file`, async t => {
  const h = harness(t);
  h.rpcEdit = (call, reply) => { if (call.name === PREFIX + 'page') edit(reply.data); };
  await assert.rejects(h.export(), sanitized); assert.equal(h.outputs[0].writes, 0);
  assert.equal(h.calls.filter(call => call.name === PREFIX + 'page').length, 1); assert.equal(h.reads.length, 0);
});
for (const label of ['same-count raw content drift', 'missing rows']) test(`catalog row-hash/count rejects ${label} even with fresh page SHA`, async t => {
  const h = harness(t);
  h.rpcEdit = (call, reply) => { if (call.name === PREFIX + 'page' && call.args.p_table_key === TABLES[0]) {
    if (label === 'missing rows') { reply.data.ndjson = ''; reply.data.count = 0; }
    else reply.data.ndjson = reply.data.ndjson.replace('来源甲', '来源丙');
    reply.data.sha256 = sha(reply.data.ndjson);
  } };
  await assert.rejects(h.export(), sanitized); assert.equal(h.outputs[0].writes, 0); assert.equal(h.reads.length, 0);
});
for (const change of ['hash', 'catalog', 'source site', 'source package']) test(`repeated catalog refuses ${change} drift`, async t => {
  const h = harness(t), session = h.sessionFor(); await session.source.catalog();
  h.rpcEdit = (call, reply) => { if (call.name !== PREFIX + 'catalog') return;
    if (change === 'hash') reply.data.snapshot_hash = 'f'.repeat(64);
    if (change === 'catalog') reply.data.catalog.tables[0].bytes++;
    if (change === 'source site') reply.data.catalog.site_id = RELAY;
    if (change === 'source package') reply.data.catalog.package_id = id(998);
  };
  await assert.rejects(session.source.catalog(), sanitized); assert.equal(h.calls.length, 2);
});
for (const suffix of ['page', 'verify', 'media']) test(`server snapshot drift on ${suffix} cannot silently refresh expected hash`, async t => {
  const h = harness(t), session = h.sessionFor(); await session.source.catalog();
  h.namespaces[0].snapshot.snapshot_hash = sha('changed persisted source or sidecar');
  const action = ({ page: () => session.source.page(TABLES[0], null), verify: () => session.source.verify(), media: () => session.media.inventory() })[suffix];
  await assert.rejects(action(), sanitized); assert.equal(h.calls.at(-1).args.p_snapshot_hash.length, 64);
  assert.notEqual(h.calls.at(-1).args.p_snapshot_hash, h.namespaces[0].snapshot.snapshot_hash); assert.equal(h.calls.length, 2);
});
for (const [label, edit] of [
  ['unverified', m => { m.verified = false; }], ['unbound', m => { m.bound = false; }],
  ['missing tuple', m => { m.files[0].file = null; m.transferred.shift(); m.checked.shift(); }],
  ['wrong catalog', m => { m.archives_catalog.package_id = id(999); }],
  ['unknown field', m => { m.storage_origin = SECRET; }], ['wrong direction', m => { m.direction = 'import'; }],
  ['hash changed since inventory', m => { m.files[0].file.sha256 = 'f'.repeat(64); }],
]) test(`media inventory refuses ${label} without accepting a fallback sidecar`, async t => {
  const h = harness(t), session = h.sessionFor();
  if (label === 'hash changed since inventory') await session.media.inventory();
  h.rpcEdit = (call, reply) => { if (call.name === PREFIX + 'media') edit(reply.data); };
  await assert.rejects(session.media.inventory(), sanitized); assert.equal(h.reads.length, 0);
});
for (const mode of ['HTTP failure', 'redirected', 'missing body', 'wrong content type', 'missing hash header', 'wrong hash header',
  'wrong transfer type', 'changed bytes valid headers', 'truncated valid headers', 'bad magic valid hash'])
  test(`real readArchiveMedia refuses ${mode}; no successful download/verify or automatic retry`, async t => {
    const h = harness(t), session = h.sessionFor(), ref = h.namespaces[0].refs[0];
    h.edgeEdit = (_read, response, payload) => {
      const headers = { ...payload.headers }; let bytes = Buffer.from(payload.bytes);
      if (mode === 'HTTP failure') return new Response(SECRET, { status: 503 });
      if (mode === 'redirected') { Object.defineProperty(response, 'redirected', { value: true }); return response; }
      if (mode === 'missing body') return new Response(null, { headers });
      if (mode === 'wrong content type') headers['content-type'] = 'application/octet-stream';
      if (mode === 'missing hash header') delete headers['x-transfer-sha256'];
      if (mode === 'wrong hash header') headers['x-transfer-sha256'] = 'f'.repeat(64);
      if (mode === 'wrong transfer type') headers['x-transfer-content-type'] = 'text/html';
      if (mode === 'changed bytes valid headers') { bytes[bytes.length - 1] ^= 1; headers['x-transfer-sha256'] = sha(bytes); }
      if (mode === 'truncated valid headers') { bytes = bytes.subarray(0, bytes.length - 1); headers['x-transfer-sha256'] = sha(bytes); }
      if (mode === 'bad magic valid hash') { bytes[0] = 0; headers['x-transfer-sha256'] = sha(bytes); }
      return new Response(bytes, { headers });
    };
    await assert.rejects(session.media.download(ref), sanitized);
    assert.equal(h.reads.length, 1); assert.equal(h.calls.filter(call => call.name === PREFIX + 'verify').length, 1, 'no post-read confirmation');
    await assert.rejects(session.media.verify(), sanitized); await assert.rejects(session.media.recheckExport(h.namespaces[0].refs.map(ref => ref.file)), sanitized);
    assert.equal(h.reads.length, 1);
  });
test('unknown Edge transport is redacted, dispatched once, never treated as a downloaded file', async t => {
  const h = harness(t), session = h.sessionFor(); h.edgeEdit = () => { throw Error(SECRET); };
  await assert.rejects(session.media.download(h.namespaces[0].refs[0]), sanitized);
  await assert.rejects(session.media.verify(), sanitized); assert.equal(h.reads.length, 1);
});
test('download cannot use forged original reference, file tuple or unknown key to read arbitrary objects', async t => {
  const h = harness(t), session = h.sessionFor(), ref = h.namespaces[0].refs[0];
  for (const change of [r => { r.key = 'f'.repeat(64); }, r => { r.ref_key += '-forged'; }, r => { r.file.sha256 = 'f'.repeat(64); }, r => { r.path = 'other/private'; }]) {
    const forged = structuredClone(ref); change(forged); await assert.rejects(session.media.download(forged), sanitized);
  }
  assert.equal(h.reads.length, 0);
});
// These two semantic-equality regressions intentionally require valid reconstructed
// DTOs to work. If they fail, report archiveReexport's implementation; do not patch
// production modules or weaken the assertions to match property-order dependence.
test('equivalent media reference with reordered object keys still downloads the exact bound file', async t => {
  const h = harness(t), session = h.sessionFor(), available = await session.media.inventory();
  const original = available.files[0];
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  reordered.file = Object.fromEntries(Object.entries(original.file).reverse());
  assert.deepEqual(reordered, original);
  const result = await session.media.download(reordered);
  assert.deepEqual(result.file, original.file); assert.deepEqual(Buffer.from(result.bytes), h.namespaces[0].payloads.get(original.key).bytes);
  assert.equal(h.reads.length, 1);
});
test('equivalent file tuples with reordered object keys can be rechecked after all actual downloads', async t => {
  const h = harness(t), session = h.sessionFor(), available = await session.media.inventory();
  for (const ref of available.files) await session.media.download(ref);
  const reordered = available.files.map(ref => Object.fromEntries(Object.entries(ref.file).reverse()));
  assert.deepEqual(reordered, available.files.map(ref => ref.file));
  await session.media.recheckExport(reordered);
  assert.equal((await session.media.verify()).verified, true); assert.equal(h.reads.length, available.files.length * 2);
});
test('recheck performs another real read and detects bytes changed after download; failed recheck cannot verify', async t => {
  const h = harness(t), session = h.sessionFor(), n = h.namespaces[0];
  for (const ref of n.refs) await session.media.download(ref);
  h.edgeEdit = (_read, _response, payload) => { const bytes = Buffer.from(payload.bytes); bytes[bytes.length - 1] ^= 1;
    return new Response(bytes, { headers: { ...payload.headers, 'x-transfer-sha256': sha(bytes) } }); };
  await assert.rejects(session.media.recheckExport(n.refs.map(ref => ref.file)), sanitized);
  await assert.rejects(session.media.verify(), sanitized); assert.equal(h.reads.length, n.refs.length + 1);
});
test('record snapshot is verified both before AND after actual media read; post-read drift rejects the download', async t => {
  const h = harness(t), session = h.sessionFor(), n = h.namespaces[0];
  h.edgeEdit = () => { n.snapshot.snapshot_hash = sha('concurrent source snapshot changed'); };
  await assert.rejects(session.media.download(n.refs[0]), sanitized);
  assert.equal(h.reads.length, 1); assert.equal(h.calls.filter(call => call.name === PREFIX + 'verify').length, 2);
});
test('export-only adapter prohibits bind/upload/recheckImport without dispatching ANY RPC/Edge operation', async t => {
  const h = harness(t), session = h.sessionFor(), file = h.namespaces[0].refs[0].file;
  await assert.rejects(session.media.bind([file]), sanitized);
  await assert.rejects(session.media.upload(file, PNG), sanitized);
  await assert.rejects(session.media.recheckImport([file]), sanitized);
  assert.equal(h.calls.length, 0); assert.equal(h.reads.length, 0); assert.equal(session.media.direction, 'export');
  assert.deepEqual(Object.keys(session.source).sort(), ['catalog', 'page', 'verify']);
});
for (const reason of ['unverified namespace', 'orphan physical namespace', 'missing media sidecar'])
  test(`full inventory RPC error for ${reason} aborts ALL export, never skips a source`, async t => {
    const h = harness(t, [namespace(), namespace(id(4))]);
    h.rpcEdit = call => { if (call.name === PREFIX + 'inventory') return { data: null, error: { message: `${SECRET}: ${reason}` } }; };
    await assert.rejects(h.export(), sanitized); assert.equal(h.calls.length, 1); assert.equal(h.prepareCalls.length, 0);
  });
for (const change of ['fingerprint', 'snapshot', 'added namespace', 'removed namespace', 'catalog'])
  test(`all-source final inventory ${change} drift refuses completion and retains already authenticated ciphertext`, async t => {
    const h = harness(t, [namespace(SITE, PACKAGE, { media: false }), namespace(id(4), PACKAGE, { empty: true })]);
    let inventories = 0;
    h.rpcEdit = (call, reply) => { if (call.name !== PREFIX + 'inventory' || ++inventories !== 2) return;
      if (change === 'fingerprint') reply.data.fingerprint = 'f'.repeat(64);
      if (change === 'snapshot') reply.data.namespaces[0].snapshot_hash = 'e'.repeat(64);
      if (change === 'added namespace') reply.data = inventoryFor([...h.namespaces, namespace(id(8), PACKAGE, { empty: true })]);
      if (change === 'removed namespace') reply.data = inventoryFor(h.namespaces.slice(0, 1));
      if (change === 'catalog') reply.data.namespaces[0].catalog.tables[0].bytes++;
    };
    await assert.rejects(h.export(), sanitized); assert.equal(inventories, 2); assert.equal(h.outputs.length, 2);
    for (const output of h.outputs) { assert.equal(output.writes, 1); assert.equal(output.opens, 2); assert.equal(output.eof, 2); assert.ok((await readFile(output.path)).length); await unpack(t, output); }
    assert.equal(h.namespaceProgress.filter(p => p.completed === 2).length, 1, 'no final success progress after changed inventory');
  });
test('final inventory RPC failure is not ignored after all saved files were individually verified', async t => {
  const h = harness(t, [namespace(SITE, PACKAGE, { empty: true })]); let count = 0;
  h.rpcEdit = call => { if (call.name === PREFIX + 'inventory' && ++count === 2) throw Error(SECRET); };
  await assert.rejects(h.export(), sanitized); assert.equal(count, 2);
  assert.equal(h.outputs[0].opens, 2); assert.equal(h.outputs[0].eof, 2); await unpack(t, h.outputs[0]);
});
test('failure reading second namespace does not skip it or falsely return first saved volume as full inventory success', async t => {
  const h = harness(t, [namespace(SITE, PACKAGE, { empty: true }), namespace(id(4))]);
  h.rpcEdit = call => { if (call.name === PREFIX + 'catalog' && call.args.p_source_site_id === id(4)) return { data: null, error: { message: SECRET } }; };
  await assert.rejects(h.export(), sanitized);
  assert.equal(h.outputs[0].eof, 1); assert.equal(h.outputs[1].writes, 0); await unpack(t, h.outputs[0]);
  assert.equal(h.calls.filter(call => call.name === PREFIX + 'inventory').length, 1);
});
for (const change of ['package', 'source site']) test(`prepare cannot relabel ${change} as relay/native export`, async t => {
  const h = harness(t); h.prepareEdit = prepared => { prepared.info[change === 'package' ? 'exportId' : 'sourceSiteId'] = RELAY; };
  await assert.rejects(h.export(), sanitized); assert.equal(h.outputs[0].writes, 0);
  assert.deepEqual(h.calls.map(call => call.name), [PREFIX + 'inventory']);
});
test('two namespaces cannot reuse the same volume UUID', async t => {
  const h = harness(t, [namespace(SITE, PACKAGE, { empty: true }), namespace(id(4), PACKAGE, { empty: true })]);
  h.prepareEdit = prepared => { prepared.info.volumeId = id(50000); };
  await assert.rejects(h.export(), sanitized); assert.equal(h.outputs[0].eof, 1); assert.equal(h.outputs[1].writes, 0);
});
test('different source sites with the same package cannot reuse one file object: reject before the second write', async t => {
  const h = harness(t, [namespace(SITE, PACKAGE, { empty: true }), namespace(id(4), PACKAGE, { empty: true })]);
  const returned = [];
  h.prepareEdit = (prepared, _output, index) => {
    if (index === 1) prepared.file = h.outputs[0].file;
    returned.push(prepared.file);
  };
  await assert.rejects(h.export(), sanitized);
  assert.equal(h.prepareCalls.length, 2); assert.equal(returned[0], returned[1]);
  assert.deepEqual(h.prepareCalls.map(call => [call.snapshot.catalog.site_id, call.snapshot.catalog.package_id]), [[SITE, PACKAGE], [id(4), PACKAGE]]);
  assert.equal(h.outputs[0].writes, 1); assert.equal(h.outputs[1].writes, 0);
  assert.equal(h.outputs[0].opens, 1); assert.equal(h.outputs[0].eof, 1);
  assert.equal(h.spaces.length, 2, 'second namespace must not start even its plaintext workspace');
  assert.equal(h.calls.some(call => call.args.p_source_site_id === id(4)), false);
  assert.equal(h.calls.filter(call => call.name === PREFIX + 'inventory').length, 1);
  assert.deepEqual(h.namespaceProgress.map(progress => progress.completed), [0, 1]);
  await unpack(t, h.outputs[0]); // The first independent saved ciphertext remains authentic.
});
test('fresh file wrappers sharing one overwritable save path are rejected by final ciphertext reread, not reported as two saved volumes', async t => {
  const h = harness(t, [namespace(SITE, PACKAGE, { empty: true }), namespace(id(4), PACKAGE, { empty: true })]);
  const memory = memoryCipherFiles(t);
  h.prepareEdit = prepared => { prepared.file = memory.create('shared.edx').file; };
  await assert.rejects(h.export(), sanitized);
  const [first, second] = memory.outputs;
  assert.notEqual(first.file, second.file); assert.equal(first.path, second.path);
  assert.equal(first.writes, 1); assert.equal(second.writes, 1);
  assert.equal(first.saves[0].bytes, second.saves[0].bytes, 'equal lengths isolate actual hash mismatch rather than size rejection');
  assert.notEqual(first.saves[0].sha256, second.saves[0].sha256);
  assert.equal(sha(memory.slots.get(first.path)), second.saves[0].sha256, 'second write actually replaced current saved bytes');
  assert.deepEqual([first.opens, first.eof, second.opens, second.eof], [2, 2, 1, 1]);
  assert.deepEqual(memory.events.map(event => `${event.kind}:${memory.outputs.indexOf(event.output)}`),
    ['saved:0', 'open:0', 'eof:0', 'saved:1', 'open:1', 'eof:1', 'open:0', 'eof:0']);
  assert.equal(h.calls.filter(call => call.name === PREFIX + 'inventory').length, 1, 'final inventory follows, never precedes, all final file rereads');
  assert.deepEqual(h.namespaceProgress.map(progress => progress.completed), [0, 1, 2], 'no final success callback after aliasing failure');
  assert.ok(h.namespaceProgress.every(progress => progress.fullSiteComplete === false));
});
test('independent first volume tampered with or lost after both volumes finish must fail final reread before inventory success', async t => {
  for (const mode of ['tampered', 'missing']) {
    const h = harness(t, [namespace(SITE, PACKAGE, { empty: true }), namespace(id(4), PACKAGE, { empty: true })]);
    const memory = memoryCipherFiles(t); let changes = 0;
    h.prepareEdit = (prepared, _output, index) => { prepared.file = memory.create(`independent-${index}.edx`).file; };
    await assert.rejects(h.export({ onNamespace(progress) {
      h.namespaceProgress.push(progress);
      if (progress.completed !== 2) return;
      changes++;
      assert.ok(memory.outputs.every(output => output.writes === 1 && output.opens === 1 && output.eof === 1), 'both saved files already authenticated');
      const first = memory.outputs[0], bytes = Buffer.from(memory.slots.get(first.path));
      try {
        if (mode === 'tampered') { bytes[bytes.length - 20] ^= 1; memory.replace(first.path, bytes); }
        else memory.replace(first.path, null); // Only remove a test memory slot, never a disk file.
      } finally { bytes.fill(0); }
    } }), sanitized);
    const [first, second] = memory.outputs;
    assert.equal(changes, 1); assert.notEqual(first.path, second.path); assert.notEqual(first.file, second.file);
    assert.deepEqual([first.writes, second.writes], [1, 1]);
    assert.deepEqual([first.opens, first.eof, second.opens, second.eof], [2, mode === 'tampered' ? 2 : 1, 1, 1]);
    if (mode === 'tampered') {
      assert.equal(memory.slots.get(first.path).length, first.saves[0].bytes);
      assert.notEqual(sha(memory.slots.get(first.path)), first.saves[0].sha256);
    } else assert.equal(memory.slots.has(first.path), false);
    assert.equal(sha(memory.slots.get(second.path)), second.saves[0].sha256, 'unaffected independent ciphertext retained');
    assert.equal(h.calls.filter(call => call.name === PREFIX + 'inventory').length, 1);
    assert.deepEqual(h.namespaceProgress.map(progress => progress.completed), [0, 1, 2], `${mode}: no final successful all-source callback`);
    assert.ok(h.namespaceProgress.every(progress => progress.fullSiteComplete === false));
  }
});
for (const mode of ['saved write response lost', 'writer does not consume EOF', 'saved readback corrupted'])
  test(`${mode}: refuse success, no retry/delete/write RPC and keep independent disk output`, async t => {
    const h = harness(t, [namespace(SITE, PACKAGE, { empty: true })]);
    if (mode === 'saved write response lost') h.fileWritten = () => { throw Error(SECRET); };
    if (mode === 'writer does not consume EOF') h.prepareEdit = (prepared, output) => {
      prepared.file.write = async () => { output.writes++; await writeFile(output.path, 'partial ciphertext'); };
    };
    if (mode === 'saved readback corrupted') h.fileWritten = async output => {
      const bytes = await readFile(output.path); bytes[bytes.length - 20] ^= 1; await writeFile(output.path, bytes);
    };
    await assert.rejects(h.export(), error => { sanitized(error); assert.ok(error instanceof api.ArchiveBundleError);
      assert.equal(error.encryptedFileState, mode === 'saved readback corrupted' ? 'saved' : 'unknown'); return true; });
    assert.equal(h.outputs[0].writes, 1); assert.ok((await readFile(h.outputs[0].path)).length);
    assert.equal(h.outputs[0].opens, mode === 'saved readback corrupted' ? 1 : 0);
  });
test('pre-cancel prevents inventory/auth/prepare and sends no server cancellation', async t => {
  const h = harness(t), controller = new AbortController(); controller.abort();
  await assert.rejects(h.export({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(h.calls.length, 0); assert.equal(h.tokenReads, 0); assert.equal(h.prepareCalls.length, 0);
});
for (const suffix of ['inventory', 'catalog', 'page', 'verify', 'media'])
  test(`cancel blocked ${suffix} rejects promptly, ignores late response, no retry or write/cancel RPC`, async t => {
    const h = harness(t), session = h.sessionFor(), entered = deferred(), blocked = deferred(), controller = new AbortController();
    h.rpcEdit = async call => { if (call.name === PREFIX + suffix) { entered.resolve(); await blocked.promise; } };
    const operation = ({ inventory: () => api.getArchiveReexportInventory(controller.signal), catalog: () => session.source.catalog(controller.signal),
      page: () => session.source.page(TABLES[0], null, controller.signal), verify: () => session.source.verify(controller.signal),
      media: () => session.media.inventory(controller.signal) })[suffix]();
    await entered.promise; controller.abort();
    await assert.rejects(operation, { name: 'AbortError' }); assert.equal(h.calls.length, 1); assert.equal(h.calls[0].signal, controller.signal);
    blocked.resolve(); await tick(); assert.equal(h.calls.length, 1); assert.equal(h.reads.length, 0);
  });
for (const point of ['during Edge read', 'during disk save', 'between namespaces'])
  test(`cancellation ${point} discards plaintext, stops namespace loop, never retries or removes saved ciphertext`, async t => {
    const h = harness(t, [namespace(), namespace(id(4))]), controller = new AbortController();
    if (point === 'during Edge read') h.edgeEdit = () => { controller.abort(); };
    if (point === 'during disk save') h.fileWritten = () => { controller.abort(); };
    const options = { signal: controller.signal };
    if (point === 'between namespaces') options.onNamespace = progress => { if (progress.completed === 1) controller.abort(); };
    await assert.rejects(h.export(options), error => { sanitized(error); assert.ok(error.name === 'AbortError' || error.cancelled === true); return true; });
    await tick(); assert.equal(h.prepareCalls.length, 1); assert.equal(h.calls.filter(call => call.name === PREFIX + 'inventory').length, 1);
    if (point === 'during Edge read') { assert.equal(h.reads.length, 1); assert.equal(h.outputs[0].writes, 0); }
    else { assert.equal(h.outputs[0].writes, 1); assert.ok((await readFile(h.outputs[0].path)).length); }
  });
test('cancel a blocked Edge transport through full export returns without waiting, and late bytes never start save/retry', async t => {
  const h = harness(t), entered = deferred(), blocked = deferred(), controller = new AbortController();
  h.edgeEdit = async () => { entered.resolve(); await blocked.promise; };
  const operation = h.export({ signal: controller.signal }); await entered.promise; controller.abort();
  await assert.rejects(operation, error => { sanitized(error); assert.equal(error.cancelled, true); return true; });
  const calls = h.calls.length; blocked.resolve(); await tick(); await tick();
  assert.equal(h.calls.length, calls); assert.equal(h.reads.length, 1); assert.equal(h.outputs[0].writes, 0);
});
