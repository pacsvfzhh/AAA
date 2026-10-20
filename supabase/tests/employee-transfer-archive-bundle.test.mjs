import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Real crypto/container/record/media clients; ONLY RPC and Edge transport are synthetic.
// No Supabase client initialization, production access, Storage or native PG acceptance.
mock.method(globalThis, 'fetch', () => assert.fail('Network and production access forbidden'));
after(() => { assert.equal(globalThis.fetch.mock.callCount(), 0); mock.restoreAll(); });
const root = fileURLToPath(new URL('../../', import.meta.url));
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/archiveBundle.ts';
  export * from './src/lib/employeeTransfer/archiveApi.ts';
  export * from './src/lib/employeeTransfer/archiveMedia.ts';
  export * from './src/lib/employeeTransfer/container.ts';
  export {setHarness} from 'bundle-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', metafile: true,
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://offline.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('offline-test-key') },
  plugins: [{ name: 'offline-only', setup(b) {
    b.onResolve({ filter: /^(?:bundle-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => {
      if (path === 'bundle-test:state') return { contents: 'let h;export const setHarness=v=>{h=v};export const current=()=>h;' };
      if (path === '../auth') return { contents: "import{current}from'bundle-test:state';export const getAdminFinancialSessionToken=()=>current().session;" };
      return { contents: "import{current}from'bundle-test:state';export const supabase={rpc:(...args)=>current().rpc(...args)};" };
    });
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const TABLES = ['content_audit_events', 'deleted_employee_accounts', 'deleted_employee_notifications',
  'content_audit_recipient_versions', 'deleted_employee_summaries', 'deleted_employee_withdrawals'];
const tablePath = key => `data/archives-${key}.ndjson`;
const id = n => `85000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SITE = id(1), PACKAGE = id(2), VOLUME = id(3), JOB = id(4), TOKEN = id(5), SESSION = id(6);
const TIME = '2024-02-29T12:34:56.123456+00:00', PASS = 'offline archive bundle passphrase';
const PRECISE = '12345678901234567890.12345678901234567890', SECRET = 'never expose private backend or plaintext';
const sha = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value);
const lineList = text => text.match(/[^\n]*\n/g) ?? [];
const rowHash = text => sha(lineList(text).map(sha).join(''));
const counts = (value = 0) => Object.fromEntries(TABLES.map(key => [key, value]));
const flags = { maintenance: true, financial_data_pending: true, dependencies_pending: true, replacement_ready: false, full_site_complete: false };
const info = () => ({ scope: 'replacement-backup', exportId: PACKAGE, volumeId: VOLUME, sourceSiteId: SITE,
  createdAt: '2026-10-20T00:00:00.000Z', volumeIndex: 1, volumeCount: 1 });
const metadata = { exportId: PACKAGE, volumeId: VOLUME };
const verification = { verified: true, scope: 'site-archives', media_pending: true, full_site_complete: false };
const bind = () => ({ success: true, scope: 'site-archives', media_pending: true, full_site_complete: false, repeated: false });
function rows(n = 1, attachments = true) {
  const event = { id: id(n + 100), operation_id: id(20), entity_type: 'message', entity_id: id(21), action: 'delete',
    owner_admin_id: id(22), owner_username: '历史管理员', actor_admin_id: null, actor_username: '历史操作者', actor_role: 'super_admin',
    customer_id: null, employee_id: id(23), occurred_at: TIME, before_data: { amount: 0, nested: { session_created_at: TIME } },
    after_data: null, media_refs: attachments ? { 'https://old.invalid/image?a=1&b=2': `${id(24)}/shared/0`, 'opaque-original-reference': `${id(24)}/shared/0` } : {},
    clear_reason: null, clear_started_at: null, cleared_at: null, cleared_by: null, cleared_username: null,
    employee_account: '旧员工é 𠮷', message_created_at: TIME, before_data_sql_null: false, after_data_sql_null: true };
  const account = { id: id(30), operation_id: id(20), employee_id: id(23), account_username: '历史员工', employee_number: '0001',
    account_created_at: TIME, account_remarks: null, owner_admin_id: id(22), owner_username: null, actor_admin_id: id(25),
    actor_username: '历史操作者', actor_role: 'super_admin', deletion_source: 'admin', deleted_at: TIME,
    cleared_at: null, cleared_by: null, cleared_username: null, clear_reason: null, account_real_name: null };
  const notification = { id: id(31), record_id: id(30), message_id: id(32), message_data: null, recipient_data: { text: '原文' },
    archived_event_id: null, cleared_at: null, cleared_by: null, clear_reason: null, message_data_sql_null: false, recipient_data_sql_null: false };
  return [event, account, notification, { id: `${id(32)}:${id(23)}`, message_id: id(32), recipient_id: id(23), recipient_data: null },
    { id: id(30), employee_id: id(23), source_present: false, is_verified: null, total_income: 0,
      available_balance: null, frozen_balance: null, total_orders: '9223372036854775807' },
    { id: `${id(30)}:${id(33)}`, record_id: id(30), withdrawal_id: id(33), employee_id: id(23), amount: 0, status: 'completed', created_at: TIME }];
}
function texts(options = {}) {
  const values = Object.fromEntries(TABLES.map((key, i) => [key, JSON.stringify(rows(1, !options.noMedia)[i])
    .replace('"amount":0', `"amount":${PRECISE}`).replace('"total_income":0', `"total_income":${PRECISE}`)
    .replace('"before_data":', '"\\u0062efore_data":') + ' \r\n']));
  if (options.empty) return Object.fromEntries(TABLES.map(key => [key, '']));
  if (options.many) values[TABLES[0]] = Array.from({ length: 205 }, (_, i) => JSON.stringify(rows(i + 1, i === 0)[0]) + '\n').join('');
  return values;
}
function catalog(text) { return { version: 1, scope: 'site-archives', site_id: SITE, package_id: PACKAGE,
  tables: TABLES.map(key => ({ key, rows: lineList(text[key]).length, bytes: Buffer.byteLength(text[key]), row_hashes_sha256: rowHash(text[key]) })), full_site_complete: false }; }
function mediaFor(text, cat) {
  const refs = [], payloads = new Map();
  for (const line of lineList(text[TABLES[0]])) {
    const event = JSON.parse(line);
    for (const [ref_key, ref_value] of Object.entries(event.media_refs)) {
      const source_line_sha256 = sha(line);
      const source_url = `archive-evidence-v1:${cat.site_id}:${cat.package_id}:${event.id}:${source_line_sha256}:${sha(ref_key)}:${sha(ref_value)}`;
      const key = sha(source_url), raw = Buffer.from([255, 216, 255, 0, 1, 2, 3, 4]);
      const file = { key, source_url, bytes: raw.length, sha256: sha(raw), content_type: 'image/jpeg' };
      refs.push({ key, source_url, event_id: event.id, source_line_sha256, ref_key, ref_value,
        bucket: 'content-audit-evidence', path: ref_value, file: null });
      payloads.set(key, { file, raw });
    }
  }
  refs.sort((a, b) => a.key < b.key ? -1 : 1);
  return { refs, payloads };
}
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'archive-bundle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const h = { session: SESSION, text: texts(options), calls: [], workspaces: [], progress: [], options,
    lose: null, malformed: null, hook: null, fileWrites: 0, fileOpens: 0, staged: new Map(), restored: new Map(),
    started: false, recordsVerified: false, mediaBound: false, mediaVerified: false,
    completed: counts(), transfer: new Set(), checked: new Set(), boundFiles: [], mode: 'export',
    fileWriteBehavior: null, fileOpenBehavior: null, cleanupBehavior: null };
  h.cat = catalog(h.text);
  Object.assign(h, mediaFor(h.text, h.cat));
  h.recordCounts = () => Object.fromEntries(h.cat.tables.map(table => [table.key, table.rows]));
  h.plan = () => ({ scope: 'site-archives', checked: true, can_restore: true, counts: h.recordCounts(), conflicts: [],
    plan_hash: 'a'.repeat(64), media_pending: true, ...flags });
  h.status = () => ({ scope: 'site-archives', started: h.started, records_verified: h.recordsVerified, counts: h.recordCounts(),
    chunks: Object.fromEntries(TABLES.map(key => [key, h.started ? h.staged.get(key)?.length ?? 0 : 0])),
    completed_chunks: { ...h.completed }, media_pending: true, ...flags });
  h.inventory = direction => ({ version: 1, scope: 'site-archives-media', direction, archives_catalog: h.cat,
    files: h.refs.map(ref => ({ ...ref, file: (direction === 'export' ? h.transfer.has(ref.key) : h.mediaBound) ? h.payloads.get(ref.key).file : null })),
    bound: direction === 'export' || h.mediaBound, verified: h.mediaVerified,
    transferred: [...h.transfer].sort(), checked: [...h.checked].sort(), full_site_complete: false });
  h.invoke = async (name, args, action) => {
    h.calls.push({ name, args: structuredClone(args) });
    let result = await action();
    if (h.hook) await h.hook(name, args);
    if (h.lose === name) { h.lose = null; throw Error(SECRET); }
    if (h.malformed === name) { h.malformed = null; result = { success: false, secret: SECRET }; }
    return result;
  };
  h.rpc = (name, args) => {
    assert.equal(args.p_admin_session_token, SESSION);
    const query = { abortSignal() { return query; }, then(resolve, reject) {
      return h.invoke(name, args, () => {
        if (name === 'employee_export_archives_begin') return { success: true, job_id: JOB, job_token: TOKEN,
          site_id: SITE, catalog: h.cat, scope: 'site-archives', media_pending: true, full_site_complete: false };
        assert.equal(args.p_job_token, TOKEN);
        if (name === 'get_employee_export_archives_page') {
          const all = lineList(h.text[args.p_table_key]);
          const start = args.p_after === null ? 0 : all.findIndex(line => JSON.parse(line).id === args.p_after) + 1;
          const page = all.slice(start, start + 200), ndjson = page.join('');
          return { table_key: args.p_table_key, count: page.length, ndjson, sha256: sha(ndjson),
            next_after: start + page.length < all.length ? JSON.parse(page.at(-1)).id : null };
        }
        if (name === 'employee_export_archives_verify') return verification;
        if (name === 'employee_import_archives_bind') { assert.deepEqual(args.p_catalog, h.cat); return bind(); }
        if (name === 'employee_import_archives_stage') {
          const chunks = h.staged.get(args.p_table_key) ?? []; chunks[args.p_chunk_no] = args.p_ndjson;
          h.staged.set(args.p_table_key, chunks);
          return { success: true, rows: lineList(args.p_ndjson).length, bytes: Buffer.byteLength(args.p_ndjson), sha256: sha(args.p_ndjson), repeated: false };
        }
        if (name === 'get_employee_import_archives_plan') return h.plan();
        if (name === 'employee_import_archives_begin') {
          assert.equal(args.p_plan_hash, 'a'.repeat(64)); h.started = true; return h.status();
        }
        if (name === 'employee_import_archives_chunk') {
          assert.equal(args.p_chunk_no, h.completed[args.p_table_key]);
          const restored = h.restored.get(args.p_table_key) ?? [];
          restored.push(h.staged.get(args.p_table_key)[args.p_chunk_no]); h.restored.set(args.p_table_key, restored);
          h.completed[args.p_table_key]++; return h.status();
        }
        if (name === 'employee_import_archives_verify') {
          for (const key of TABLES) assert.equal((h.restored.get(key) ?? []).join(''), h.text[key]);
          h.recordsVerified = true; return h.status();
        }
        if (name === 'employee_transfer_archive_media_inventory' || name === 'employee_transfer_archive_media_status') return h.inventory(args.p_direction);
        if (name === 'employee_transfer_archive_media_bind') {
          assert.equal(h.recordsVerified, true); h.boundFiles = args.p_files; h.mediaBound = true;
          return { success: true, files: h.boundFiles.length, bytes: h.boundFiles.reduce((n, file) => n + file.bytes, 0), repeated: false, full_site_complete: false };
        }
        if (name === 'employee_transfer_archive_media_verify') {
          assert.equal(h.checked.size, h.refs.length); h.mediaVerified = true; return h.inventory(args.p_direction);
        }
        assert.fail(`Forbidden/unexpected RPC ${name}`);
      }).then(data => ({ data, error: null })).then(resolve, reject);
    } }; return query;
  };
  h.transport = async (url, init) => {
    assert.equal(url, 'https://offline.supabase.co/functions/v1/employee-transfer-media');
    assert.equal(init.headers['x-transfer-job-token'], TOKEN); assert.equal(init.headers['x-transfer-scope'], 'archives');
    const key = init.headers['x-transfer-object-key'], action = init.headers['x-transfer-action'];
    const { file, raw } = h.payloads.get(key);
    return h.invoke(action, { key }, async () => {
      if (action === 'upload') { assert.equal(h.recordsVerified, true); assert.deepEqual(Buffer.from(init.body), raw); }
      if (action === 'download' || action === 'upload') h.transfer.add(key);
      if (action.startsWith('recheck-')) h.checked.add(key);
      if (action === 'download') return new Response(raw, { headers: { 'content-type': 'application/octet-stream',
        'x-transfer-sha256': file.sha256, 'x-transfer-content-type': file.content_type } });
      return Response.json({ success: true, key, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, full_site_complete: false });
    });
  };
  h.createWorkspace = () => {
    const base = join(directory, `workspace-${h.workspaces.length}`);
    const w = { base, aborted: false, cleanupCount: 0, appends: [], opens: [],
      async append(path, input, signal) {
        assert.equal(w.aborted, false); assert.equal(signal?.aborted, false); assert.ok(input.length <= 1048576);
        w.appends.push(path); await mkdir(dirname(join(base, path)), { recursive: true });
        assert.equal(w.aborted, false); await appendFile(join(base, path), input);
      },
      open(path) {
        assert.equal(w.aborted, false); w.opens.push(path);
        return { async *[Symbol.asyncIterator]() {
          h.calls.push({ name: 'workspace-open', args: { path, base } });
          for await (const chunk of createReadStream(join(base, path), { highWaterMark: options.ioChunkBytes ?? 137 })) {
            assert.equal(w.aborted, false); yield chunk;
          }
        } };
      },
      async abort() {
        w.cleanupCount++; w.aborted = true; h.calls.push({ name: 'cleanup', args: { base } });
        await rm(base, { recursive: true, force: true });
        if (h.cleanupBehavior) await h.cleanupBehavior(w);
      },
    };
    h.workspaces.push(w); return w;
  };
  const filePath = join(directory, 'independent.edx');
  h.file = {
    async write(source, signal) {
      h.fileWrites++; h.calls.push({ name: 'file-write' });
      const handle = await open(filePath, 'wx');
      try {
        for await (const chunk of source) { assert.equal(signal.aborted, false); await handle.writeFile(chunk); }
        await handle.sync();
      } finally { await handle.close(); }
      if (h.fileWriteBehavior) await h.fileWriteBehavior();
    },
    open() {
      h.fileOpens++; h.calls.push({ name: 'file-open' });
      if (h.fileOpenBehavior) return h.fileOpenBehavior();
      return { async *[Symbol.asyncIterator]() {
        for await (const chunk of createReadStream(filePath, { highWaterMark: options.ioChunkBytes ?? 113 })) yield chunk;
        h.calls.push({ name: 'file-eof' });
      } };
    },
  };
  h.filePath = filePath;
  h.export = async (extra = {}) => {
    api.setHarness(h); h.mode = 'export';
    const session = api.createArchivesExportSession(PACKAGE, 'offline-admin-password');
    await session.begin();
    const media = api.createArchiveMediaSession(TOKEN, 'export', h.transport);
    return api.exportArchiveBundle(session.source, media, h.file, h.createWorkspace, PASS, info(),
      { onProgress: p => h.progress.push(p), ...extra });
  };
  h.import = async (extra = {}) => {
    api.setHarness(h); h.mode = 'import'; h.transfer.clear(); h.checked.clear(); h.mediaVerified = false;
    h.importRecords = api.createArchivesImportSession(TOKEN);
    h.importRestore = api.createArchivesRestoreSession(TOKEN, h.cat);
    h.importMedia = api.createArchiveMediaSession(TOKEN, 'import', h.transport);
    return api.importArchiveBundle(h.file, extra.passphrase ?? PASS, extra.metadata ?? metadata, h.createWorkspace,
      { records: h.importRecords, restore: h.importRestore, media: h.importMedia },
      { onProgress: p => h.progress.push(p), ...extra });
  };
  return h;
}
const redacted = error => {
  assert.ok(error instanceof api.ArchiveBundleError); assert.equal(error.message.includes(SECRET), false);
  assert.equal('cause' in error, false); assert.equal(error.fullSiteComplete, undefined); return true;
};
const cleaned = h => { for (const w of h.workspaces) { assert.equal(w.aborted, true); assert.equal(w.cleanupCount, 1); } };
const noDbWrites = h => assert.equal(h.calls.some(c => /^employee_import_archives_|^employee_transfer_archive_media_(?:bind|verify)$|^upload$/.test(c.name)), false);
async function unpack(h) {
  const data = new Map();
  const manifest = await api.verifyEncryptedVolume(h.file.open(), PASS, {
    async append(path, raw) { data.set(path, Buffer.concat([data.get(path) ?? Buffer.alloc(0), Buffer.from(raw)])); }, async abort() { data.clear(); },
  }, { expectedMetadata: metadata });
  return { manifest, data };
}
async function repack(h, edit) {
  const { manifest, data } = await unpack(h);
  await edit(data, manifest);
  async function* entries() {
    for (const [path, raw] of data) yield { path, bytes: raw.length, open: () => ({ async *[Symbol.asyncIterator]() { yield raw; } }) };
  }
  const output = [];
  for await (const chunk of api.writeEncryptedVolume(entries(), info(), PASS)) output.push(chunk);
  await writeFile(h.filePath, Buffer.concat(output));
}
function rewriteCatalog(data, edit) {
  const catalog = JSON.parse(data.get(api.ARCHIVE_BUNDLE_CATALOG_PATH)); edit(catalog);
  data.set(api.ARCHIVE_BUNDLE_CATALOG_PATH, Buffer.from(JSON.stringify(catalog) + '\n'));
}
function rewriteDirectory(data, edit) {
  const files = lineList(data.get(api.ARCHIVE_BUNDLE_MEDIA_PATH).toString()).map(line => JSON.parse(line)); edit(files);
  data.set(api.ARCHIVE_BUNDLE_MEDIA_PATH, Buffer.from(files.map(file => JSON.stringify(file) + '\n').join('')));
}

test('scope and hard bounds: native six-table archive, 8 record entries / 3008 total, no network client dependency', () => {
  assert.equal(api.ARCHIVE_BUNDLE_PROTOCOL, 'site-archives-bundle-v1');
  assert.deepEqual(api.ARCHIVE_BUNDLE_LIMITS, { maxTotalBytes: 1073741824, maxFiles: 3000, maxEntries: 3008, maxCatalogBytes: 8192, maxDirectoryBytes: 2097152 });
  assert.equal(Object.keys(compiled.metafile.inputs).some(path => /src\/lib\/(?:auth|supabase)\.ts$/.test(path)), false);
});
test('durable encrypted export and complete authentication restore through real records/media sessions, original source_line bytes unchanged', async t => {
  const h = fixture(t, { many: true });
  const exported = await h.export(); cleaned(h);
  assert.equal(exported.scope, 'site-archives-bundle'); assert.equal(exported.rows, 210);
  assert.equal(exported.files, 2); assert.equal(exported.manifest.entries.length, 10);
  assert.equal(exported.recordsVerified, true); assert.equal(exported.mediaVerified, true); assert.equal(exported.fullSiteComplete, false);
  assert.deepEqual(exported.catalog, h.cat);
  const encrypted = await readFile(h.filePath);
  assert.equal(encrypted.subarray(0, 8).toString(), 'EDXSTRM1'); assert.equal(encrypted.includes(Buffer.from(PRECISE)), false);
  assert.equal(exported.cipherSha256, sha(encrypted)); assert.equal(exported.cipherBytes, encrypted.length);
  const disk = await unpack(h);
  for (const key of TABLES) assert.equal(disk.data.get(tablePath(key)).toString(), h.text[key]);
  assert.deepEqual(JSON.parse(disk.data.get(api.ARCHIVE_BUNDLE_CATALOG_PATH)), h.cat);
  assert.deepEqual(exported.manifest.entries.map(entry => entry.path), [...TABLES.map(tablePath), api.ARCHIVE_BUNDLE_MEDIA_PATH,
    api.ARCHIVE_BUNDLE_CATALOG_PATH, ...h.refs.map(ref => `media/content-audit-evidence/${ref.key}`)]);
  const cleanupIndex = h.calls.findIndex(call => call.name === 'cleanup');
  const firstFileOpen = h.calls.findIndex(call => call.name === 'file-open');
  assert.ok(cleanupIndex < firstFileOpen, 'snapshot cleared before independent encrypted-file readback');
  const start = h.calls.length;
  const imported = await h.import(); cleaned(h);
  assert.equal(imported.recordsVerified, true); assert.equal(imported.mediaVerified, true); assert.equal(imported.fullSiteComplete, false);
  assert.equal(imported.bytes, exported.bytes); assert.equal(imported.cipherSha256, exported.cipherSha256);
  for (const key of TABLES) assert.equal(h.restored.get(key).join(''), h.text[key]);
  assert.equal(h.staged.get(TABLES[0]).length, 2);
  const calls = h.calls.slice(start), names = calls.map(call => call.name);
  assert.ok(names.indexOf('file-eof') >= 0 && names.indexOf('file-eof') < names.indexOf('employee_import_archives_bind'), 'complete encrypted EOF before any DB write');
  const beforeBind = calls.slice(0, names.indexOf('employee_import_archives_bind'));
  for (const ref of h.refs) assert.ok(beforeBind.some(call => call.name === 'workspace-open' && call.args.path.endsWith(ref.key)), 'all media read before DB bind');
  const recordVerify = names.indexOf('employee_import_archives_verify'), upload = names.indexOf('upload');
  assert.ok(recordVerify < names.indexOf('employee_transfer_archive_media_bind')); assert.ok(recordVerify < upload);
  assert.ok(names.lastIndexOf('recheck-import') < names.lastIndexOf('employee_transfer_archive_media_verify'));
  assert.equal(names.at(-1), 'cleanup');
  assert.equal(h.calls.some(call => /close|cancel|delete|finalize|release/.test(call.name)), false);
  const restore = h.progress.filter(p => p.phase === 'restore');
  assert.equal(restore.at(-1).rows, 210); assert.equal(restore.at(-1).bytes, h.cat.tables.reduce((n, table) => n + table.bytes, 0));
  assert.ok(restore.some(p => p.rows === 200));
  assert.deepEqual(h.progress.filter(p => p.phase === 'media-upload').map(p => [p.files, p.bytes]), [[1, 8], [2, 16]]);
  for (const progress of h.progress) assert.equal(progress.fullSiteComplete, false);
});
for (const options of [{ empty: true }, { noMedia: true }]) test(`zero-media archive completes real zero-file bind/recheck/verify ${JSON.stringify(options)}`, async t => {
  const h = fixture(t, options); const exported = await h.export(); const imported = await h.import();
  assert.equal(exported.files, 0); assert.equal(imported.files, 0); assert.equal(imported.mediaVerified, true);
  assert.equal(h.calls.some(call => call.name === 'upload' || call.name === 'download'), false);
  for (const key of TABLES) assert.equal(h.restored.get(key).join(''), h.text[key]); cleaned(h);
});
for (const mode of ['wrong passphrase', 'metadata mismatch', 'tamper', 'truncate', 'trailing ciphertext']) test(`${mode}: reject authenticated envelope before any DB write`, async t => {
  const h = fixture(t); await h.export();
  const raw = await readFile(h.filePath);
  if (mode === 'tamper') raw[raw.length - 20] ^= 1;
  if (mode === 'truncate') await writeFile(h.filePath, raw.subarray(0, -1));
  else if (mode === 'trailing ciphertext') await writeFile(h.filePath, Buffer.concat([raw, Buffer.of(0)]));
  else if (mode === 'tamper') await writeFile(h.filePath, raw);
  h.calls.length = 0;
  await assert.rejects(h.import(mode === 'wrong passphrase' ? { passphrase: PASS + '-wrong' }
    : mode === 'metadata mismatch' ? { metadata: { ...metadata, volumeId: id(999) } } : {}), redacted);
  noDbWrites(h); cleaned(h);
});
for (const [label, edit] of [
  ['missing media entry', data => data.delete([...data.keys()].find(path => path.startsWith('media/')))],
  ['extra media entry', data => data.set(`media/content-audit-evidence/${'f'.repeat(64)}`, Buffer.from([255, 216, 255]))],
  ['extra NDJSON entry', data => data.set('data/unexpected.ndjson', Buffer.from('{}\n'))],
  ['missing catalog', data => data.delete(api.ARCHIVE_BUNDLE_CATALOG_PATH)],
  ['missing directory', data => data.delete(api.ARCHIVE_BUNDLE_MEDIA_PATH)],
  ['wrong entry order', data => { const first = data.entries().next().value; data.delete(first[0]); data.set(...first); }],
  ['extra directory tuple', data => rewriteDirectory(data, files => files.push(files[0]))],
  ['missing directory tuple', data => rewriteDirectory(data, files => files.pop())],
  ['duplicate tuple key', data => rewriteDirectory(data, files => files[1] = files[0])],
  ['unsorted tuple directory', data => rewriteDirectory(data, files => files.reverse())],
  ['tuple extra field', data => rewriteDirectory(data, files => files[0].path = '/private')],
  ['tuple wrong content_type', data => rewriteDirectory(data, files => files[0].content_type = 'image/png')],
  ['media bytes differ, archive/manifest self-consistent', data => { const path = [...data.keys()].find(path => path.startsWith('media/')); const raw = Buffer.from(data.get(path)); raw[3] ^= 1; data.set(path, raw); }],
  ['media magic differs even with consistent file/manifest hashes', data => {
    rewriteDirectory(data, files => { const file = files[0], raw = Buffer.from(data.get(`media/content-audit-evidence/${file.key}`)); raw[0] = 0;
      file.sha256 = sha(raw); data.set(`media/content-audit-evidence/${file.key}`, raw); });
  }],
  ['catalog full-site escalation', data => rewriteCatalog(data, cat => cat.full_site_complete = true)],
  ['catalog scope escalation', data => rewriteCatalog(data, cat => cat.scope = 'full-site')],
  ['catalog extra key', data => rewriteCatalog(data, cat => cat.identity_catalog = {})],
  ['catalog raw duplicate key', data => { const path = api.ARCHIVE_BUNDLE_CATALOG_PATH; data.set(path, Buffer.from(data.get(path).toString().replace('{', '{"version":1,'))); }],
  ['directory raw duplicate key', data => { const path = api.ARCHIVE_BUNDLE_MEDIA_PATH; data.set(path, Buffer.from(data.get(path).toString().replace('{', '{"bytes":8,'))); }],
  ['catalog noncanonical JSON', data => { const path = api.ARCHIVE_BUNDLE_CATALOG_PATH; data.set(path, Buffer.from(' ' + data.get(path))); }],
]) test(`valid new encryption still rejects ${label} before DB writes`, async t => {
  const h = fixture(t); await h.export(); await repack(h, edit); h.calls.length = 0;
  await assert.rejects(h.import(), redacted); noDbWrites(h); cleaned(h);
});
for (const key of TABLES) for (const field of ['rows', 'bytes', 'row_hashes_sha256']) test(`authenticated catalog must match actual ${key}.${field}`, async t => {
  const h = fixture(t); await h.export(); await repack(h, data => rewriteCatalog(data, cat => {
    const table = cat.tables.find(table => table.key === key);
    table[field] = field === 'row_hashes_sha256' ? 'f'.repeat(64) : table[field] + 1;
  })); h.calls.length = 0;
  await assert.rejects(h.import(), redacted); noDbWrites(h); cleaned(h);
});
for (const change of ['whitespace', 'reference', 'event', 'cleared', 'unsupported media_refs']) test(`self-consistent catalog + raw ${change} cannot detach media identities from source_line`, async t => {
  const h = fixture(t); await h.export(); await repack(h, data => {
    const path = tablePath(TABLES[0]); let text = data.get(path).toString();
    if (change === 'whitespace') text = ' ' + text;
    if (change === 'reference') text = text.replace('shared/0', 'shared/1');
    if (change === 'event') text = text.replace(id(101), id(999));
    if (change === 'cleared') text = text.replace('"cleared_at":null', `"cleared_at":"${TIME}"`);
    if (change === 'unsupported media_refs') text = text.replace(/"media_refs":\{[^}]*\}/, '"media_refs":[]');
    data.set(path, Buffer.from(text)); rewriteCatalog(data, cat => { cat.tables[0].bytes = Buffer.byteLength(text); cat.tables[0].row_hashes_sha256 = rowHash(text); });
  }); h.calls.length = 0;
  await assert.rejects(h.import(), redacted); noDbWrites(h); cleaned(h);
});
test('independent durable write response lost after EOF remains unknown and file is never deleted or retried', async t => {
  const h = fixture(t); h.fileWriteBehavior = () => { throw Error(SECRET); };
  await assert.rejects(h.export(), error => { redacted(error); assert.equal(error.encryptedFileState, 'unknown'); assert.equal(error.outcomeUnknown, true); return true; });
  assert.equal(h.fileWrites, 1); assert.equal(h.fileOpens, 0); assert.ok((await readFile(h.filePath)).length > 0); cleaned(h);
});
test('writer that resolves without EOF cannot establish saved or verified', async t => {
  const h = fixture(t); h.file.write = async () => { h.fileWrites++; await writeFile(h.filePath, 'incomplete'); };
  await assert.rejects(h.export(), error => { redacted(error); assert.equal(error.encryptedFileState, 'unknown'); assert.equal(error.outcomeUnknown, true); return true; });
  assert.equal(h.fileWrites, 1); assert.equal(h.fileOpens, 0); assert.equal(await readFile(h.filePath, 'utf8'), 'incomplete'); cleaned(h);
});
test('saved-file readback corruption cannot be called verified; encrypted file retained', async t => {
  const h = fixture(t); h.fileWriteBehavior = async () => { const raw = await readFile(h.filePath); raw[raw.length - 20] ^= 1; await writeFile(h.filePath, raw); };
  await assert.rejects(h.export(), error => { redacted(error); assert.equal(error.encryptedFileState, 'saved'); assert.equal(error.recordsVerified, false); return true; });
  assert.ok((await readFile(h.filePath)).length); cleaned(h);
});
for (const name of ['employee_import_archives_bind', 'employee_import_archives_stage', 'employee_import_archives_begin',
  'employee_import_archives_chunk', 'employee_import_archives_verify', 'employee_transfer_archive_media_bind', 'upload',
  'recheck-import', 'employee_transfer_archive_media_verify']) test(`unknown ${name} response stops immediately, retains committed work and requires explicit reconciliation`, async t => {
  const h = fixture(t); await h.export(); h.calls.length = 0; h.lose = name;
  await assert.rejects(h.import(), error => { redacted(error); assert.equal(error.outcomeUnknown, true); assert.equal(error.serverWritesMayExist, true); return true; });
  assert.equal(h.calls.filter(call => call.name === name).length, 1);
  assert.equal(h.calls.filter(call => /status|close|cancel|rollback/.test(call.name)).length, 0);
  const index = h.calls.findIndex(call => call.name === name);
  assert.ok(h.calls.slice(index + 1).every(call => call.name === 'cleanup'));
  assert.ok((await readFile(h.filePath)).length); cleaned(h);
});
for (const name of ['employee_import_archives_bind', 'employee_import_archives_stage', 'employee_import_archives_begin',
  'employee_import_archives_chunk', 'employee_import_archives_verify', 'employee_transfer_archive_media_bind', 'employee_transfer_archive_media_verify']) {
  test(`malformed ${name} receipt never clears unknown writes or reports completion`, async t => {
    const h = fixture(t); await h.export(); h.calls.length = 0; h.malformed = name;
    await assert.rejects(h.import(), error => { redacted(error); assert.equal(error.outcomeUnknown, true); return true; }); cleaned(h);
  });
}
for (const point of ['before export', 'during download', 'during save', 'during stage', 'during restore', 'during upload', 'during final cleanup']) {
  test(`cancellation ${point}: clears plaintext once, never closes/retries/rolls back or removes saved ciphertext`, async t => {
    const h = fixture(t), controller = new AbortController();
    if (point === 'before export') controller.abort();
    if (point === 'during download') h.hook = name => { if (name === 'download') controller.abort(); };
    if (point === 'during save') h.fileWriteBehavior = () => controller.abort();
    const importing = ['during stage', 'during restore', 'during upload', 'during final cleanup'].includes(point);
    if (importing) {
      await h.export(); h.calls.length = 0;
      if (point === 'during final cleanup') h.cleanupBehavior = () => controller.abort();
      else h.hook = name => { if (name === ({ 'during stage': 'employee_import_archives_stage', 'during restore': 'employee_import_archives_chunk', 'during upload': 'upload' })[point]) controller.abort(); };
    }
    await assert.rejects(importing ? h.import({ signal: controller.signal }) : h.export({ signal: controller.signal }), error => {
      redacted(error); assert.equal(error.cancelled, true);
      if (point === 'during save') assert.equal(error.encryptedFileState, 'unknown'); return true;
    });
    assert.equal(h.calls.some(call => /close|cancel|delete|rollback/.test(call.name)), false); cleaned(h);
    if (importing || point === 'during save') assert.ok((await readFile(h.filePath)).length);
  });
}
test('cleanup failure after full target verification is failure, preserves true confirmations and encrypted file', async t => {
  const h = fixture(t); await h.export(); h.cleanupBehavior = () => { throw Error(SECRET); };
  await assert.rejects(h.import(), error => { redacted(error); assert.equal(error.cleanupRequired, true);
    assert.equal(error.recordsVerified, true); assert.equal(error.mediaVerified, true); return true; });
  assert.ok((await readFile(h.filePath)).length); cleaned(h);
});
for (const limits of [{ maxFiles: 1 }, { maxTotalBytes: 1 }, { maxFiles: 3001 }, { maxTotalBytes: 1073741825 }]) test(`export rejects tightened or invalid bundle bounds ${JSON.stringify(limits)} without writing ciphertext`, async t => {
  const h = fixture(t); await assert.rejects(h.export({ limits }), redacted);
  assert.equal(h.fileWrites, 0); cleaned(h);
});
test('import payload limit is enforced while authenticating, before any target write', async t => {
  const h = fixture(t); await h.export(); h.calls.length = 0;
  await assert.rejects(h.import({ limits: { maxTotalBytes: 100 } }), redacted); noDbWrites(h); cleaned(h);
});
for (const name of ['employee_export_archives_verify', 'download', 'recheck-export', 'employee_transfer_archive_media_verify']) {
  test(`export unknown ${name}: preserve uncertainty, no ciphertext save, no automatic reconciliation`, async t => {
    const h = fixture(t); h.lose = name;
    await assert.rejects(h.export(), error => { redacted(error); assert.equal(error.outcomeUnknown, true); return true; });
    assert.equal(h.fileWrites, 0); assert.equal(h.calls.filter(call => call.name === name).length, 1);
    assert.equal(h.calls.some(call => /close|status|rollback/.test(call.name)), false); cleaned(h);
  });
}
for (const mode of ['export', 'import']) test(`cancel blocked ${mode} plaintext append: abort invalidates it before late completion`, async t => {
  const h = fixture(t), controller = new AbortController();
  if (mode === 'import') await h.export();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const factory = h.createWorkspace;
  h.createWorkspace = () => {
    const workspace = factory(), append = workspace.append;
    workspace.append = async (...args) => { entered(); await blocked; return append(...args); };
    return workspace;
  };
  const operation = mode === 'export' ? h.export({ signal: controller.signal }) : h.import({ signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(operation, error => { redacted(error); assert.equal(error.cancelled, true); return true; });
  cleaned(h); release(); await new Promise(resolve => setImmediate(resolve));
  for (const workspace of h.workspaces) await assert.rejects(readFile(join(workspace.base, tablePath(TABLES[0]))), { code: 'ENOENT' });
  if (mode === 'import') assert.ok((await readFile(h.filePath)).length);
});
test('cancel blocked target write returns unknown without waiting for or undoing a late committed response', async t => {
  const h = fixture(t); await h.export(); h.calls.length = 0;
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  h.hook = async name => { if (name === 'employee_import_archives_stage') { entered(); await blocked; } };
  const operation = h.import({ signal: controller.signal });
  await started; controller.abort();
  await assert.rejects(operation, error => { redacted(error); assert.equal(error.outcomeUnknown, true); assert.equal(error.serverWritesMayExist, true); return true; });
  assert.equal(h.staged.get(TABLES[0]).length, 1); cleaned(h);
  const afterCancel = h.calls.length; release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, afterCancel); assert.equal(h.started, false);
});
test('snapshot cleanup failure blocks readback and success without deleting the saved independent file', async t => {
  const h = fixture(t); h.cleanupBehavior = () => { throw Error(SECRET); };
  await assert.rejects(h.export(), error => { redacted(error); assert.equal(error.cleanupRequired, true); assert.equal(error.encryptedFileState, 'saved'); return true; });
  assert.equal(h.fileOpens, 0); assert.ok((await readFile(h.filePath)).length); cleaned(h);
});
test('export refuses reuse of a destroyed snapshot workspace for independent readback', async t => {
  const h = fixture(t), factory = h.createWorkspace;
  let workspace;
  h.createWorkspace = () => workspace ??= factory();
  await assert.rejects(h.export(), error => { redacted(error); assert.equal(error.encryptedFileState, 'saved'); return true; });
  assert.equal(h.fileOpens, 0); cleaned(h);
});
for (const [type, payload] of [
  ['image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0])],
  ['image/gif', Buffer.from('GIF89a-test')],
  ['image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])],
  ['video/mp4', Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])],
]) test(`real byte/type/hash checks at export, readback, import and upload support ${type}`, async t => {
  const h = fixture(t);
  for (const value of h.payloads.values()) {
    value.raw = payload; value.file = { ...value.file, bytes: payload.length, sha256: sha(payload), content_type: type };
  }
  const exported = await h.export(); const imported = await h.import();
  assert.equal(imported.files, 2); assert.equal(exported.mediaVerified, true); assert.equal(imported.mediaVerified, true); cleaned(h);
});
for (const [label, mutate] of [
  ['full-site manifest', volume => { volume.scope = 'full-site'; }],
  ['multiple volumes', volume => { volume.volumeCount = 2; }],
  ['source site mismatch', volume => { volume.sourceSiteId = id(999); }],
]) test(`authenticated ${label} is never accepted as native archive bundle`, async t => {
  const h = fixture(t); await h.export();
  const { data } = await unpack(h), volume = info(); mutate(volume);
  async function* entries() { for (const [path, raw] of data) yield { path, bytes: raw.length, open: () => ({ async *[Symbol.asyncIterator]() { yield raw; } }) }; }
  const output = []; for await (const chunk of api.writeEncryptedVolume(entries(), volume, PASS)) output.push(chunk);
  await writeFile(h.filePath, Buffer.concat(output)); h.calls.length = 0;
  await assert.rejects(h.import(), redacted); noDbWrites(h); cleaned(h);
});
test('actual media spanning multiple 1MiB encryption records is reopened and fully hashed at every layer', async t => {
  const h = fixture(t, { ioChunkBytes: 65536 });
  const payload = Buffer.alloc(1048576 + 37, 42); payload.set([255, 216, 255]);
  for (const value of h.payloads.values()) {
    value.raw = payload; value.file = { ...value.file, bytes: payload.length, sha256: sha(payload) };
  }
  const exported = await h.export(), imported = await h.import();
  assert.ok(exported.cipherBytes > 2 * 1048576); assert.equal(imported.bytes, exported.bytes);
  for (const entry of exported.manifest.entries.filter(entry => entry.kind === 'media')) assert.equal(entry.sha256, sha(payload));
  assert.equal(imported.mediaVerified, true); cleaned(h);
});
test('valid replacement encryption of identical contents is still not the exact saved ciphertext', async t => {
  const h = fixture(t); h.fileWriteBehavior = () => repack(h, () => {});
  await assert.rejects(h.export(), error => { redacted(error); assert.equal(error.encryptedFileState, 'saved'); assert.equal(error.recordsVerified, false); return true; });
  assert.ok((await readFile(h.filePath)).length); cleaned(h);
});
test('SQL33 source export refusal stays a refusal, no namespace bypass or media/file request', async t => {
  const h = fixture(t); api.setHarness(h);
  const source = { async catalog() { throw Error(SECRET); }, async page() { assert.fail(); }, async verify() { assert.fail(); } };
  await assert.rejects(api.exportArchiveBundle(source, api.createArchiveMediaSession(TOKEN, 'export', h.transport),
    h.file, h.createWorkspace, PASS, info()), redacted);
  assert.equal(h.calls.some(call => /archive_media/.test(call.name)), false); assert.equal(h.fileWrites, 0); cleaned(h);
});
