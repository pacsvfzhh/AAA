import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// LOCAL ONLY: real crypto/container/archive helper, real supabase.ts transport,
// and real siteImport/siteRestore admission clients. Targets, fetch/XHR, SDK
// initialization and the already-authenticated bundle owner are explicit doubles.
// No SQL replay, PostgreSQL/Storage, eleven-file acceptance or business release.
const root = fileURLToPath(new URL('../../', import.meta.url));
const ORIGIN = 'https://offline.supabase.co';
const env = { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(ORIGIN),
  'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('offline-security-key') };
const id = n => `86000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SITE = id(1), PACKAGE = id(2), VOLUME = id(3), SESSION = id(4), TARGET = id(5);
const PASS = 'offline security regression passphrase';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tables = ['content_audit_events', 'deleted_employee_accounts', 'deleted_employee_notifications',
  'content_audit_recipient_versions', 'deleted_employee_summaries', 'deleted_employee_withdrawals'];
const info = { scope: 'replacement-backup', exportId: PACKAGE, volumeId: VOLUME, sourceSiteId: SITE,
  createdAt: '2026-10-20T00:00:00.000Z', volumeIndex: 1, volumeCount: 1 };
const metadata = { exportId: PACKAGE, volumeId: VOLUME };
const flags = { maintenance: true, financial_data_pending: true, dependencies_pending: true,
  replacement_ready: false, full_site_complete: false };
const foreign = [];
let http;
function route(kind, input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== ORIGIN || !http) {
    foreign.push({ kind, origin: url.origin });
    throw new Error('External/unexpected transport forbidden by offline test');
  }
  return http(kind, url, init);
}
mock.method(globalThis, 'fetch', async (input, init) => route('fetch', input, init));
const originalXhr = Object.getOwnPropertyDescriptor(globalThis, 'XMLHttpRequest');
class OfflineXhr {
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader() {}
  getAllResponseHeaders() { return 'content-type: application/json\r\n'; }
  send(body) {
    Promise.resolve().then(() => route('xhr', this.url, { method: this.method, body })).then(async response => {
      this.status = response.status;
      this.statusText = response.statusText;
      this.responseURL = this.url;
      this.response = await response.arrayBuffer();
      this.onload?.();
    }).catch(() => this.onerror?.());
  }
  abort() { this.onabort?.(); }
}
Object.defineProperty(globalThis, 'XMLHttpRequest', { configurable: true, writable: true, value: OfflineXhr });
after(() => {
  mock.restoreAll();
  if (originalXhr) Object.defineProperty(globalThis, 'XMLHttpRequest', originalXhr);
  else delete globalThis.XMLHttpRequest;
  assert.deepEqual(foreign, [], 'zero external or unexpected transport attempts');
});
const load = output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

const archive = await load(await build({ stdin: { contents: `
  export * from './src/lib/employeeTransfer/archiveBundle.ts';
  export {writeEncryptedVolume, verifyEncryptedVolume} from './src/lib/employeeTransfer/container.ts';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', define: env,
  plugins: [{ name: 'forbid-archive-backend', setup(b) {
    b.onResolve({ filter: /^\.\.\/(?:auth|supabase)$/ }, a => ({ path: a.path, namespace: 'archive' }));
    b.onLoad({ filter: /.*/, namespace: 'archive' }, ({ path }) => ({ contents: path === '../auth'
      ? `export const getAdminFinancialSessionToken=()=> '${SESSION}';`
      : `export const supabase={rpc(){throw Error('Archive helper must use only its explicit target double');}};` }));
  } }],
}));

// Capture the actual fetchWithTimeout passed to createClient, without importing
// the SDK/auth or rewriting/extracting either production transport function.
const transport = await load(await build({ stdin: { contents: `
  export * from './src/lib/supabase.ts'; export {clients} from 'security-test:transport';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm',
  define: env,
  plugins: [{ name: 'capture-real-transport', setup(b) {
    b.onResolve({ filter: /^(?:@supabase\/supabase-js|security-test:transport)$/ }, a => ({ path: a.path, namespace: 'transport' }));
    b.onLoad({ filter: /.*/, namespace: 'transport' }, ({ path }) => ({ contents: path === 'security-test:transport'
      ? 'export const clients=[];'
      : `import {clients} from 'security-test:transport'; export const createClient=(url,key,options)=>{
          clients.push({url,fetch:options.global.fetch}); return {}; };` }));
  } }],
}));
assert.equal(transport.clients.length, 1);
assert.equal(transport.clients[0].url, ORIGIN);
const request = transport.clients[0].fetch;
const ok = () => Response.json({ synthetic: true });
const unavailable = () => Response.json({ message: 'synthetic unavailable' }, { status: 503 });

// Keep the actual admission and shared driver. Only the authenticated-bundle
// owner and auth/RPC boundary are replaced; a positive control reaches the real
// shared begin, so a failing gate cannot pass merely because all imports fail.
const admission = await load(await build({ stdin: { contents: `
  export * from './src/lib/employeeTransfer/siteImport.ts'; export {setHarness} from 'security-test:admission';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm',
  define: env,
  plugins: [{ name: 'isolate-admission-boundaries', setup(b) {
    b.onResolve({ filter: /^(?:security-test:admission|\.\.\/(?:auth|supabase))$/ }, a => ({ path: a.path, namespace: 'admission' }));
    b.onResolve({ filter: /^\.\/siteTransfer$/ }, () => ({ path: 'bundle-owner', namespace: 'admission' }));
    b.onLoad({ filter: /.*/, namespace: 'admission' }, ({ path }) => ({ contents: path === 'security-test:admission'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth' ? `export const getAdminFinancialSessionToken=()=> '${SESSION}';`
      : path === '../supabase' ? `import {current} from 'security-test:admission';
          export const formatSupabaseError=()=> 'offline stop';export const supabase={rpc:(...args)=>current().rpc(...args)};`
      : `import {current} from 'security-test:admission';
          export const SITE_DOMAINS=['shared','products','dispatch','identity','finance','activity','verification','notifications','chat','archives'];
          export const withAuthenticatedSiteBundleSet=async(files,pass,create,consume)=>consume(current().bundle);` }));
  } }],
}));

function workspaces() {
  const spaces = [];
  return { spaces, create() {
    const data = new Map();
    const space = { dead: false, async append(path, bytes) {
      assert.equal(space.dead, false);
      assert.ok(bytes instanceof Uint8Array && bytes.length <= 1048576);
      data.set(path, Buffer.concat([data.get(path) ?? Buffer.alloc(0), Buffer.from(bytes)]));
    }, open(path) {
      assert.equal(space.dead, false); assert.ok(data.has(path), path);
      return { async *[Symbol.asyncIterator]() {
        const raw = data.get(path);
        for (let at = 0; at < raw.length; at += 137) { assert.equal(space.dead, false); yield Uint8Array.from(raw.subarray(at, at + 137)); }
      } };
    }, async abort() { space.dead = true; for (const raw of data.values()) raw.fill(0); data.clear(); } };
    spaces.push(space); return space;
  } };
}
async function* bytes(raw) { yield Uint8Array.from(raw); }
function event(text) {
  const time = '2024-02-29T12:34:56.123456+00:00';
  return { id: id(100), operation_id: id(20), entity_type: 'message', entity_id: id(21), action: 'delete',
    owner_admin_id: id(22), owner_username: 'historical', actor_admin_id: null, actor_username: 'historical',
    actor_role: 'super_admin', customer_id: null, employee_id: id(23), occurred_at: time, before_data: { text },
    after_data: null, media_refs: {}, clear_reason: null, clear_started_at: null, cleared_at: null, cleared_by: null,
    cleared_username: null, employee_account: 'historical', message_created_at: time,
    before_data_sql_null: false, after_data_sql_null: true };
}
function records(text) { return Object.fromEntries(tables.map((key, index) => [key, index === 0 ? JSON.stringify(event(text)) + '\n' : ''])); }
function catalog(raw) {
  return { version: 1, scope: 'site-archives', site_id: SITE, package_id: PACKAGE,
    tables: tables.map(key => ({ key, rows: raw[key] ? 1 : 0, bytes: Buffer.byteLength(raw[key]),
      row_hashes_sha256: sha(raw[key] ? sha(raw[key]) : '') })), full_site_complete: false };
}
async function encryptRecords(raw) {
  const c = catalog(raw), data = new Map(tables.map(key => [`data/archives-${key}.ndjson`, Buffer.from(raw[key])]));
  data.set('data/archive-media.ndjson', Buffer.alloc(0));
  data.set('data/archive-catalog.ndjson', Buffer.from(JSON.stringify(c) + '\n'));
  async function* entries() { for (const [path, raw] of data) yield { path, bytes: raw.length, open: () => bytes(raw) }; }
  const chunks = [];
  for await (const raw of archive.writeEncryptedVolume(entries(), info, PASS)) chunks.push(Buffer.from(raw));
  const cipher = Buffer.concat(chunks);
  return { raw, catalog: c, cipher, expected: { catalog: c, cipherSha256: sha(cipher), cipherBytes: cipher.length },
    file: { open: () => bytes(cipher) } };
}
let original, changed, reencrypted;
before(async () => {
  original = await encryptRecords(records('ORIGINAL'));
  changed = await encryptRecords(records('MODIFIED'));
  reencrypted = await encryptRecords(original.raw);
  assert.notEqual(original.expected.cipherSha256, reencrypted.expected.cipherSha256);
});
function archiveTarget(volume) {
  const calls = [], staged = new Map(), restored = new Map();
  const counts = Object.fromEntries(volume.catalog.tables.map(t => [t.key, t.rows]));
  const completed = Object.fromEntries(tables.map(key => [key, 0]));
  let started = false, verified = false, mediaBound = false;
  const status = () => ({ scope: 'site-archives', started, records_verified: verified, counts,
    chunks: Object.fromEntries(tables.map(key => [key, started ? 1 : 0])), completed_chunks: { ...completed }, media_pending: true, ...flags });
  const inventory = checked => ({ version: 1, scope: 'site-archives-media', direction: 'import', archives_catalog: volume.catalog,
    files: [], bound: mediaBound, verified: checked, transferred: [], checked: [], full_site_complete: false });
  return { calls, restored, target: {
    records: { target: {
      async bind(c) { calls.push('bind'); assert.deepEqual(c, volume.catalog);
        return { success: true, scope: 'site-archives', media_pending: true, full_site_complete: false, repeated: false }; },
      async stage(key, no, raw) { calls.push('stage'); assert.equal(no, 0); staged.set(key, raw);
        return { success: true, rows: raw ? 1 : 0, bytes: Buffer.byteLength(raw), sha256: sha(raw), repeated: false }; },
    }, async plan() { calls.push('plan'); return { scope: 'site-archives', checked: true, can_restore: true, counts,
      conflicts: [], plan_hash: 'a'.repeat(64), media_pending: true, ...flags }; } },
    restore: {
      async status() { calls.push('status'); return status(); },
      async begin() { calls.push('begin'); started = true; return status(); },
      async chunk(key, no) { calls.push('chunk'); assert.equal(no, completed[key]); restored.set(key, staged.get(key)); completed[key]++; return status(); },
      async verify() { calls.push('verify'); for (const key of tables) assert.equal(restored.get(key), volume.raw[key]); verified = true; return status(); },
    }, media: { direction: 'import', async inventory() { calls.push('inventory'); return inventory(false); },
      async bind(files) { calls.push('media-bind'); assert.deepEqual(files, []); mediaBound = true; },
      async recheckImport(files) { calls.push('media-recheck'); assert.deepEqual(files, []); },
      async verify() { calls.push('media-verify'); return inventory(true); } },
  } };
}
async function rejectBeforeStage(volume, expectedSource, phase = 'validate') {
  const w = workspaces(), target = archiveTarget(volume);
  await assert.rejects(archive.importArchiveBundle(volume.file, PASS, metadata, w.create, target.target, { expectedSource }), error => {
    assert.ok(error instanceof archive.ArchiveBundleError);
    assert.equal(error.phase, phase, 'valid replacement must reach source validation, not fail crypto accidentally');
    assert.equal(error.serverWritesMayExist, false); assert.equal(error.recordsVerified, false);
    assert.equal(error.mediaVerified, false); assert.equal(error.cleanupRequired, false); return true;
  });
  assert.deepEqual(target.calls, [], 'not even bind/stage/plan/media may run');
  assert.ok(w.spaces.length > 0 && w.spaces.every(s => s.dead));
}
test('valid same-metadata/same-row-count archive replacement is rejected before bind, including catalog-only mismatch', async () => {
  assert.deepEqual(changed.catalog.tables.map(t => [t.rows, t.bytes]), original.catalog.tables.map(t => [t.rows, t.bytes]));
  assert.notDeepEqual(changed.catalog, original.catalog);
  const w = workspaces(), space = w.create();
  try {
    const manifest = await archive.verifyEncryptedVolume(changed.file.open(), PASS, space, { expectedMetadata: metadata });
    assert.equal(manifest.exportId, PACKAGE); assert.equal(manifest.volumeId, VOLUME);
    await archive.inspectArchiveBundle(space, manifest);
  } finally { await space.abort(); }
  // Matching the replacement ciphertext itself must not neutralize the ORIGINAL catalog gate.
  await rejectBeforeStage(changed, { ...changed.expected, catalog: original.catalog });
  await rejectBeforeStage(changed, original.expected);
});
test('re-encryption of identical original records is valid crypto but rejected by exact ciphertext hash', async () => {
  assert.deepEqual(reencrypted.catalog, original.catalog);
  assert.equal(reencrypted.cipher.length, original.cipher.length);
  await rejectBeforeStage(reencrypted, original.expected);
});
test('ciphertext byte-count binding rejects even when catalog and SHA-256 match', async () => {
  await rejectBeforeStage(original, { ...original.expected, cipherBytes: original.cipher.length + 1 });
});
test('correct expectedSource preserves explicit approval, raw staging, restore and final media verification', async () => {
  const w = workspaces(), target = archiveTarget(original);
  const result = await archive.importArchiveBundle(original.file, PASS, metadata, w.create, target.target,
    { expectedSource: original.expected, approvePlan: async plan => { target.calls.push('approve'); assert.equal(plan.can_restore, true); return true; } });
  assert.equal(result.recordsVerified, true); assert.equal(result.mediaVerified, true); assert.equal(result.fullSiteComplete, false);
  assert.equal(result.cipherSha256, original.expected.cipherSha256); assert.equal(result.cipherBytes, original.expected.cipherBytes);
  assert.deepEqual(result.catalog, original.catalog);
  assert.equal(target.restored.get(tables[0]), original.raw[tables[0]]);
  assert.equal(target.calls.filter(c => c === 'stage').length, 6);
  assert.ok(target.calls.indexOf('approve') < target.calls.indexOf('begin'));
  assert.ok(target.calls.indexOf('verify') < target.calls.indexOf('media-recheck'));
  assert.equal(target.calls.at(-1), 'media-verify'); assert.ok(w.spaces.every(s => s.dead));
});
test('correct expectedSource does not bypass approval rejection or late content authentication', async () => {
  const w = workspaces(), target = archiveTarget(original);
  await assert.rejects(archive.importArchiveBundle(original.file, PASS, metadata, w.create, target.target,
    { expectedSource: original.expected, approvePlan: async () => false }), archive.ArchiveBundleError);
  assert.ok(target.calls.includes('stage')); assert.equal(target.calls.includes('begin'), false);
  assert.ok(w.spaces.every(s => s.dead));
  const damaged = Buffer.from(original.cipher); damaged[damaged.length - 1] ^= 1;
  await rejectBeforeStage({ ...original, file: { open: () => bytes(damaged) } }, original.expected, 'authenticate');
});

const importQueries = ['get_employee_import_shared_replace_dry_run', 'get_employee_import_products_dry_run',
  'get_employee_import_dispatch_dry_run', 'get_employee_import_notification_configuration_plan',
  'get_employee_import_notifications_restore_status', 'get_employee_import_chat_merge_plan', 'get_employee_import_chat_restore_status'];
for (const mode of ['503', 'network']) {
  test(`real transport: import queries and non-get writes have ONE attempt on ${mode}`, async () => {
    for (const name of [...importQueries, 'employee_import_site_verify_prerequisites', 'employee_import_shared_replace_apply']) {
      const attempts = [];
      http = async kind => { attempts.push(kind); if (mode === 'network') throw new TypeError('Failed to fetch'); return unavailable(); };
      try {
        const pending = request(`${ORIGIN}/rest/v1/rpc/${name}`, { method: 'POST', body: '{}' });
        if (mode === 'network') await assert.rejects(pending, { name: 'SupabaseNetworkError' });
        else assert.equal((await pending).status, 503);
        assert.deepEqual(attempts, ['fetch'], name);
      } finally { http = undefined; }
    }
  });
}
test('real transport: read-only export queries still retry 503 and use offline XHR after a fetch network failure', async () => {
  const attempts = [];
  http = async kind => { attempts.push(kind); return attempts.length === 1 ? unavailable() : ok(); };
  try {
    assert.equal((await request(`${ORIGIN}/rest/v1/rpc/get_employee_export_archives_page`, { method: 'POST', body: '{}' })).status, 200);
    assert.deepEqual(attempts, ['fetch', 'fetch']);
    attempts.length = 0;
    http = async kind => { attempts.push(kind); if (kind === 'fetch') throw new TypeError('Failed to fetch'); return ok(); };
    assert.equal((await request(`${ORIGIN}/rest/v1/rpc/get_employee_export_shared_page`, { method: 'POST', body: '{}' })).status, 200);
    assert.deepEqual(attempts, ['fetch', 'xhr']);
  } finally { http = undefined; }
});
test('real transport: case/encoding, Request input, prefix boundary and GET method are classified independently', async () => {
  for (const [input, init, expected] of [
    [`${ORIGIN}/REST/v1/RPC/GeT_EmPlOyEe_ImPoRt_Shared_Replace_Dry_Run?x=1`, { method: 'pOsT' }, 1],
    [new Request(`${ORIGIN}/rest/v1/rpc/%67et_employee_import_chat_merge_plan`, { method: 'POST', body: '{}' }), undefined, 1],
    [`${ORIGIN}/rest/v1/rpc/GET_EMPLOYEE_EXPORT_SHARED_PAGE`, { method: 'post' }, 2],
    [`${ORIGIN}/rest/v1/rpc/get_employee_imported_archive_page`, { method: 'POST' }, 2],
    [`${ORIGIN}/rest/v1/rpc/get_employee_import_shared_replace_dry_run`, { method: 'GET' }, 2],
  ]) {
    const attempts = [];
    http = async kind => { attempts.push(kind); return attempts.length === 1 ? unavailable() : ok(); };
    try { assert.equal((await request(input, init)).status, expected === 1 ? 503 : 200); assert.equal(attempts.length, expected); }
    finally { http = undefined; }
  }
});
test('real transport: import POST timeout never falls back or retries', async t => {
  // Trigger ONLY the production 120s timeout; do not shorten retry/backoff timers.
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    assert.equal(delay, 120000); queueMicrotask(() => callback(...args)); return 0;
  });
  const attempts = [];
  http = async (kind, _url, init) => {
    attempts.push(kind);
    return new Promise((_, reject) => {
      const abort = () => reject(init.signal.reason);
      if (init.signal.aborted) abort(); else init.signal.addEventListener('abort', abort, { once: true });
    });
  };
  try {
    await assert.rejects(request(`${ORIGIN}/rest/v1/rpc/get_employee_import_shared_replace_dry_run`, { method: 'POST' }), { name: 'SupabaseTimeoutError' });
    assert.deepEqual(attempts, ['fetch']);
  } finally { http = undefined; }
});

const eligible = () => ({ version: 1, protocol: 'site-maintenance-restore-v3', site_id: TARGET, source_site_id: SITE,
  can_restore_to_maintenance: true, blockers: [], missing_rpcs: [], full_site_complete: false, can_release: false });
function admissionHarness(response, error = null) {
  const calls = [], domains = [];
  const identity = { version: 1, scope: 'employee-identity', site_id: SITE, package_id: PACKAGE,
    tables: ['accounts', 'credentials', 'orders'].map(key => ({ key, rows: 0, bytes: 0, row_hashes_sha256: sha('') })),
    processing_orders: 0, full_site_complete: false };
  const sharedKeys = ['admins', 'financial_admin_credentials', 'admin_groups', 'admin_group_members', 'admin_configs', 'system_configs', 'history_cleanup_config'];
  const shared = { version: 1, scope: 'shared-settings', site_id: SITE,
    tables: sharedKeys.map(key => ({ key, rows: 0, bytes: 0, sha256: sha('') })), excluded_system_keys: [], full_site_complete: false };
  const h = { rpc(name, args) {
    assert.equal(args.p_admin_session_token, SESSION);
    calls.push(name);
    return { abortSignal() { return this; }, then(resolve, reject) {
      return Promise.resolve().then(() => {
        if (name === 'get_employee_import_site_preflight') {
          assert.equal(args.p_source_site_id, SITE); return { data: structuredClone(response), error };
        }
        assert.equal(name, 'employee_import_shared_replace_begin', 'no later writes, cancellation or release');
        return { data: null, error: { message: 'intentional stop at first shared write' } };
      }).then(resolve, reject);
    } };
  }, bundle: { packageId: PACKAGE, sourceSiteId: SITE, volumes: [], async readDomain(domain, consume) {
    domains.push(domain);
    if (domain === 'identity') return consume({ catalog: identity });
    assert.equal(domain, 'shared');
    return consume({ catalog: shared, media: null, manifest: { ...info, version: 1, entries: [] },
      file: {}, workspace: { open: () => bytes(Buffer.alloc(0)) }, cipherSha256: sha(''), cipherBytes: 1 });
  } } };
  admission.setHarness(h);
  return { calls, domains, run: () => admission.importSiteBundleSetToMaintenance({
    files: [], confirmation: '確認導入員工資料', adminPassword: 'synthetic-admin-password', passphrase: PASS,
    createWorkspace() { assert.fail('no new workspace before shared begin'); },
    directory: { createFile() { assert.fail('no backup before shared begin'); } },
    approvePlan: async () => assert.fail('no plan approval before shared begin'), chooseChatRoles: async () => assert.fail('no chat stage'),
  }) };
}
test('real admission rejects SQL44-only v1 success before reading domains or sending shared writes', async () => {
  const h = admissionHarness({ ...eligible(), protocol: 'site-maintenance-restore-v1' });
  await assert.rejects(h.run(), /prerequisites could not be confirmed/);
  assert.deepEqual(h.calls, ['get_employee_import_site_preflight']); assert.deepEqual(h.domains, []);
});
test('real admission rejects malformed/inconsistent v2 flags and preserves valid blockers without shared writes', async () => {
  for (const patch of [
    { version: 2 }, { full_site_complete: true }, { can_release: true }, { can_restore_to_maintenance: 'true' },
    { can_restore_to_maintenance: true, blockers: ['target_has_business'] },
    { site_id: SITE }, { source_site_id: id(99) },
    { missing_rpcs: ['public.employee_import_site_verify_prerequisites(uuid,uuid)'] },
    { can_restore_to_maintenance: false, blockers: ['missing_backend_support'], missing_rpcs: ['public.employee_import_site_verify_prerequisites(uuid,uuid)'] },
  ]) {
    const h = admissionHarness({ ...eligible(), ...patch });
    await assert.rejects(h.run()); assert.deepEqual(h.calls, ['get_employee_import_site_preflight']); assert.deepEqual(h.domains, []);
  }
  const h = admissionHarness(eligible(), { message: 'synthetic RPC error' });
  await assert.rejects(h.run()); assert.deepEqual(h.calls, ['get_employee_import_site_preflight']);
});
test('real v2 client accepts eligible response and reaches the actual shared-begin driver (controlled stop)', async () => {
  const h = admissionHarness(eligible());
  assert.deepEqual(await admission.getSiteImportPreflight(SITE), eligible()); h.calls.length = 0;
  await assert.rejects(h.run(), error => { assert.equal(error.domain, 'shared'); return true; });
  assert.deepEqual(h.domains, ['identity', 'shared']);
  assert.deepEqual(h.calls, ['get_employee_import_site_preflight', 'employee_import_shared_replace_begin']);
});
