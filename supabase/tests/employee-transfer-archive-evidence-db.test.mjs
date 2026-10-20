import assert from 'node:assert/strict';
import { before, after, test, mock } from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { createSites, adminLogin, rpc as call, scalar, rows } from './support/transfer-harness.mjs';
import { NEW, PASSWORDS, buildNewSite } from './support/transfer-fixtures.mjs';

// Real SQL33/34/35 and public role RPCs; fake Storage only. No production/network access.
const PREFIX = 'employee_transfer_archive_media_';
const id = n => `82000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const PACKAGE = id(1), EVENT = id(2), OP = id(3), ENTITY = id(4);
const REF = 'https://original.invalid/storage/v1/object/public/chat-images/original.png';
const PATH = `${OP}/shared/0`, JPEG = Uint8Array.of(255, 216, 255, 0, 1, 2, 3);
const sha = input => createHash('sha256').update(input).digest('hex');
let source, target, sourceToken, targetToken, sourceJob, dispatchJob, sourceClient, targetClient, catalog, edge, modules;
let currentSite, currentToken, seq = 0;
const stores = new Map(), calls = [], rpcCalls = [];
let lose = false;
async function rpc(site, name, args, role = 'anon') {
  const save = `archive_media_${++seq}`;
  await site.exec(`SAVEPOINT ${save}`);
  try { await site.exec(`SET LOCAL ROLE ${role}`);const result = await call(site, name, args, { role: null });await site.exec(`RESET ROLE;RELEASE SAVEPOINT ${save}`);return result; }
  catch (e) { await site.exec(`ROLLBACK TO SAVEPOINT ${save};RELEASE SAVEPOINT ${save}`);throw e; }
}
function query(site, name, args, role = 'anon') {
  const q = { abortSignal() { return q; }, then(resolve, reject) {
    rpcCalls.push({ name, args, role });return rpc(site, name, args, role).then(data => ({ data, error: null }), () => ({ data: null, error: { message: 'synthetic-private-error' } })).then(resolve, reject);
  } };return q;
}
const activate = (site, token) => { currentSite = site;currentToken = token; };
function store(site) {
  if (!stores.has(site)) stores.set(site, new Map());
  const objects = stores.get(site);
  return {
    async download(bucket, path) { calls.push(['download', bucket, path]);const bytes = objects.get(`${bucket}/${path}`);return { data: bytes ? new Response(bytes) : new Response(null, { status: 404 }) }; },
    async upload(bucket, path, bytes, options) {
      calls.push(['upload', bucket, path, options]);assert.equal(options.upsert, false);
      if (objects.has(`${bucket}/${path}`)) return { error: { statusCode: '409' } };
      objects.set(`${bucket}/${path}`, bytes.slice());return { data: {} };
    },
  };
}
function handler(site) {
  return edge.createEmployeeTransferMediaHandler({ supabaseUrl: 'https://fixture.supabase.co', crypto: webcrypto, store: store(site), rpc: (name, args) => query(site, name, args, 'service_role') });
}
const transport = async (url, init) => {
  assert.equal(url, 'https://fixture.supabase.co/functions/v1/employee-transfer-media');
  const response = await handler(currentSite)(new Request(url, init));
  if (lose) { lose = false;await response.body?.cancel();throw Error('synthetic lost response AFTER commit'); }
  return response;
};
const auth = (job, token) => ({ p_admin_session_token: token, p_job_token: job.job_token });
async function capture(kind) {
  const job = await rpc(source, `employee_export_${kind}_begin`, { p_admin_session_token: sourceToken, p_admin_password: PASSWORDS.root });
  assert.equal(job.success, true);const texts = {};
  for (const table of job.catalog.tables) {
    let after = null;do { const p = await rpc(source, `get_employee_export_${kind}_page`, { ...auth(job, sourceToken), p_table_key: table.key, p_after: after });texts[table.key] = (texts[table.key] ?? '') + p.ndjson;after = p.next_after; } while (after);
  }
  if (kind === 'shared') await rpc(source, 'employee_transfer_cancel', auth(job, sourceToken));
  else { await rpc(source, `employee_export_${kind}_verify`, auth(job, sourceToken));await rpc(source, `employee_export_${kind}_close`, auth(job, sourceToken)); }
  return { catalog: job.catalog, texts };
}
async function prepare(kind, input) {
  activate(target, targetToken);
  const client = kind === 'shared' ? modules.createSharedSettingsReplacementSession(PACKAGE, PASSWORDS.root) : modules.createDispatchImportSession(PACKAGE, PASSWORDS.root);
  await client.target.begin(input.catalog);
  for (const table of input.catalog.tables) await client.target.stage(table.key, 0, input.texts[table.key]);
  const plan = await client.target.dryRun(), backup = await client.backup();
  const plain = new Map();let encrypted = [];
  await (kind === 'shared' ? modules.createReplacementBackup : modules.createDispatchBackup)(backup.descriptor, backup.source, {
    async append(path, bytes) { plain.set(path, [...(plain.get(path) ?? []), bytes.slice()]); },
    open(path) { return (async function* () { yield* plain.get(path) ?? []; })(); },async abort() { plain.clear(); },
  }, {
    async write(stream) { for await (const bytes of stream) encrypted.push(bytes.slice()); },
    open() { return (async function* () { yield* encrypted; })(); },
  }, backup.receiver, 'independent-synthetic-archive-backup-passphrase');
  assert.equal(plain.size, 0);encrypted = [];
  const identity = client.identity();return { client, job: { job_id: identity.jobId, job_token: identity.jobToken }, plan };
}
async function inCase(fn) {
  // A SQL rollback is test isolation, not a real-world session rollback. Do not carry
  // immutable client observations from one synthetic history into the next one.
  sourceClient = modules.createArchiveMediaSession(sourceJob.job_token, 'export', transport);
  targetClient = modules.createArchiveMediaSession(dispatchJob.job_token, 'import', transport);
  await source.exec('SAVEPOINT case_source');await target.exec('SAVEPOINT case_target');
  try { return await fn(); } finally { await source.exec('ROLLBACK TO SAVEPOINT case_source;RELEASE SAVEPOINT case_source');await target.exec('ROLLBACK TO SAVEPOINT case_target;RELEASE SAVEPOINT case_target'); }
}
before(async () => {
  mock.method(globalThis, 'fetch', () => assert.fail('Real network forbidden'));
  const output = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/archiveMedia.ts';export * from './src/lib/employeeTransfer/api.ts';export * from './src/lib/employeeTransfer/replacementBackup.ts';export * from './src/lib/employeeTransfer/dispatchBackup.ts';export * from './supabase/functions/employee-transfer-media/handler.ts';
    import { setHarness } from 'archive-harness';export { setHarness };`, resolveDir: new URL('../..', import.meta.url).pathname }, bundle: true, write: false, format: 'esm', platform: 'browser',
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://fixture.supabase.co'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('synthetic-anon') },
    plugins: [{ name: 'offline', setup(b) {
      b.onResolve({ filter: /archive-harness$/ }, () => ({ path: 'harness', namespace: 'fake' }));
      b.onResolve({ filter: /\/auth$|\/supabase$/ }, args => args.importer.includes('/src/lib/') ? { path: 'harness', namespace: 'fake' } : undefined);
      b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: `let h;export function setHarness(v){h=v}export function getAdminFinancialSessionToken(){return h.token()}export const supabase={rpc:(...args)=>h.rpc(...args)};export function formatSupabaseError(){return 'synthetic-error'};`, loader: 'js' }));
    } }],
  });
  modules = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);edge = modules;
  modules.setHarness({ token: () => currentToken, rpc: (name, args) => query(currentSite, name, args) });
  const sites = await createSites({ upTo: '20261102000035_transfer_archive_evidence.sql' });source = sites.oldSite;target = sites.newSite;
  assert.equal(sites.failures.length, 12);assert.equal(sites.files.length, 562);
  await source.exec('BEGIN');await target.exec('BEGIN');
  await buildNewSite(source);await buildNewSite(target);
  await source.query('UPDATE private.employee_transfer_site SET site_id=$1', [id(5)]);await target.query('UPDATE private.employee_transfer_site SET site_id=$1', [id(6)]);
  await source.query(`INSERT INTO private.content_audit_events(id,operation_id,entity_type,entity_id,action,owner_admin_id,actor_admin_id,actor_username,actor_role,media_refs,before_data)
    VALUES($1,$2,'notification',$3,'edit',$4,$4,'root','super_admin',$5::jsonb,'{"amount":12345678901234567890.123456789,"historical":true}')`, [EVENT, OP, ENTITY, NEW.root, JSON.stringify({ [REF]: PATH })]);
  sourceToken = await adminLogin(source, 'root', PASSWORDS.root);targetToken = await adminLogin(target, 'root', PASSWORDS.root);
  const shared = await capture('shared'), dispatch = await capture('dispatch');
  const replacement = await prepare('shared', shared);assert.equal((await replacement.client.apply(replacement.plan.plan_hash)).success, true);await rpc(target, 'employee_transfer_cancel', auth(replacement.job, targetToken));
  const prepared = await prepare('dispatch', dispatch);dispatchJob = prepared.job;
  await rpc(target, 'employee_import_dispatch_enter_maintenance', { ...auth(dispatchJob, targetToken), p_plan_hash: prepared.plan.plan_hash,
    p_confirmation: '確認暫停業務並導入派單資料', p_admin_password: PASSWORDS.root });
  const config = await rpc(target, 'get_employee_import_dispatch_configuration_plan', auth(dispatchJob, targetToken));
  await rpc(target, 'employee_import_dispatch_apply_configuration', { ...auth(dispatchJob, targetToken), p_plan_hash: config.plan_hash });
  sourceJob = await rpc(source, 'employee_export_archives_begin', { p_admin_session_token: sourceToken, p_admin_password: PASSWORDS.root, p_package_id: PACKAGE });catalog = sourceJob.catalog;
  await rpc(target, 'employee_import_archives_bind', { ...auth(dispatchJob, targetToken), p_catalog: catalog });
  for (const t of catalog.tables) {
    const page = await rpc(source, 'get_employee_export_archives_page', { ...auth(sourceJob, sourceToken), p_table_key: t.key });
    await rpc(target, 'employee_import_archives_stage', { ...auth(dispatchJob, targetToken), p_table_key: t.key, p_chunk_no: 0, p_ndjson: page.ndjson });
  }
  const plan = await rpc(target, 'get_employee_import_archives_plan', auth(dispatchJob, targetToken));assert.equal(plan.can_restore, true);
  const begun = await rpc(target, 'employee_import_archives_begin', { ...auth(dispatchJob, targetToken), p_plan_hash: plan.plan_hash });
  for (const t of catalog.tables) for (let i = 0; i < begun.chunks[t.key]; i++) await rpc(target, 'employee_import_archives_chunk', { ...auth(dispatchJob, targetToken), p_table_key: t.key, p_chunk_no: i });
  await rpc(target, 'employee_import_archives_verify', auth(dispatchJob, targetToken));
  stores.set(source, new Map([[`content-audit-evidence/${PATH}`, JPEG]]));stores.set(target, new Map());
  sourceClient = modules.createArchiveMediaSession(sourceJob.job_token, 'export', transport);targetClient = modules.createArchiveMediaSession(dispatchJob.job_token, 'import', transport);
}, { timeout: 180000 });
after(async () => { await Promise.all([source?.close(), target?.close()]);mock.restoreAll(); });

async function exportMedia() {
  activate(source, sourceToken);const inventory = await sourceClient.inventory();assert.equal(inventory.files.length, 1);
  const downloaded = await sourceClient.download(inventory.files[0]);assert.deepEqual(downloaded.bytes, JPEG);
  await sourceClient.recheckExport([downloaded.file]);assert.equal((await sourceClient.verify()).verified, true);return downloaded;
}
async function restored() {
  const data = await exportMedia();activate(target, targetToken);await targetClient.bind([data.file]);await targetClient.upload(data.file, data.bytes);
  await targetClient.recheckImport([data.file]);assert.equal((await targetClient.verify()).verified, true);return data;
}
const readArgs = () => ({ p_admin_session_token: targetToken, p_source_site_id: catalog.site_id, p_package_id: PACKAGE, p_event_id: EVENT, p_ref_key: REF });

test('real SQL → client → Edge → private fakeStorage → recheck → verify → bound Blob read; raw archives untouched', () => inCase(async () => {
  const before = await rows(target, 'SELECT source_line,body::text FROM private.employee_transfer_archive_records ORDER BY table_key,source_id');
  await restored();
  const context = await rpc(target, PREFIX + 'read_authorize', readArgs(), 'service_role');
  assert.equal(context.path, `transfer-archives/${dispatchJob.job_id}/${context.key}`);
  assert.equal(stores.get(target).get('content-audit-evidence/' + context.path).length, JPEG.length);
  const blob = await modules.readArchiveMedia({ source_site_id: catalog.site_id, package_id: PACKAGE, event_id: EVENT, ref_key: REF }, undefined, transport);
  assert.equal(blob.type, 'image/jpeg');assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), JPEG);
  assert.deepEqual(await rows(target, 'SELECT source_line,body::text FROM private.employee_transfer_archive_records ORDER BY table_key,source_id'), before);
  assert.equal(await scalar(target, 'SELECT count(*)::int FROM private.content_audit_events'), 0);
  assert.equal(await scalar(target, 'SELECT dirty FROM private.employee_transfer_maintenance WHERE singleton'), true);
  assert.ok(calls.every(c => c[1] === 'content-audit-evidence'));assert.ok(!rpcCalls.some(c => /notification_media|chat_media|verification_media/.test(c.name)));
}));

test('lost upload response after real commit: no retry until explicit status; verified remains false until recheck', () => inCase(async () => {
  const data = await exportMedia();activate(target, targetToken);const client = modules.createArchiveMediaSession(dispatchJob.job_token, 'import', transport);
  await client.bind([data.file]);lose = true;const uploads = calls.filter(c => c[0] === 'upload').length;
  await assert.rejects(client.upload(data.file, data.bytes), e => e.outcomeUnknown === true);
  await assert.rejects(client.verify());await assert.rejects(client.upload(data.file, data.bytes));
  assert.equal(calls.filter(c => c[0] === 'upload').length, uploads + 1);
  const status = await client.status();assert.deepEqual(status.transferred, [data.file.key]);assert.equal(status.verified, false);assert.deepEqual(status.checked, []);
  await assert.rejects(client.verify());await client.status();await client.recheckImport([data.file]);assert.equal((await client.verify()).verified, true);
}));

test('lost bind acknowledgement forces explicit status; malformed status cannot clear the uncertainty gate', () => inCase(async () => {
  const data = await exportMedia();activate(target, targetToken);let drop = true, badStatus = false;
  const normal = { token: () => currentToken, rpc: (name, args) => query(currentSite, name, args) };
  modules.setHarness({ token: normal.token, rpc(name, args) {
    const q = { abortSignal() { return q; }, then(resolve, reject) { return Promise.resolve(query(currentSite, name, args)).then(result => {
      if (name === PREFIX + 'bind' && drop) { drop = false;throw Error('synthetic bind response lost after write'); }
      if (name === PREFIX + 'status' && badStatus) return { ...result, data: { ...result.data, full_site_complete: true } };
      return result;
    }).then(resolve, reject); } };return q;
  } });
  try {
    const client = modules.createArchiveMediaSession(dispatchJob.job_token, 'import', transport);
    await assert.rejects(client.bind([data.file]), e => e.outcomeUnknown === true);
    const requests = rpcCalls.length;await assert.rejects(client.bind([data.file]));await assert.rejects(client.upload(data.file, data.bytes));assert.equal(rpcCalls.length, requests);
    badStatus = true;await assert.rejects(client.status());await assert.rejects(client.verify());
    badStatus = false;const status = await client.status();assert.equal(status.bound, true);assert.equal(status.verified, false);
    await client.upload(data.file, data.bytes);await client.recheckImport([data.file]);assert.equal((await client.verify()).verified, true);
  } finally { modules.setHarness(normal); }
}));

test('forged download digest fails locally and requires status; actual source receipt may already exist', () => inCase(async () => {
  activate(source, sourceToken);const client = modules.createArchiveMediaSession(sourceJob.job_token, 'export', async (url, init) => {
    const response = await transport(url, init);const headers = new Headers(response.headers);headers.set('x-transfer-sha256', 'f'.repeat(64));return new Response(response.body, { status: response.status, headers });
  });
  const ref = (await client.inventory()).files[0];await assert.rejects(client.download(ref), e => e.outcomeUnknown === true);
  await assert.rejects(client.download(ref));assert.deepEqual((await client.status()).transferred, [ref.key]);
}));

test('service-only authorize/commit/read; private functions and tables denied even service_role', () => inCase(async () => {
  const fns = await rows(target, `SELECT n.nspname,p.proname,p.oid::regprocedure::text AS signature,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname LIKE 'employee_transfer_archive_media_%'`);
  for (const f of fns) {
    assert.equal(f.prosecdef, true);assert.ok(f.proconfig.includes('search_path=pg_catalog, public, private, pg_temp'));
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const allowed = f.nspname === 'public' && (['authorize', 'commit', 'read_authorize'].some(s => f.proname === PREFIX + s) ? role === 'service_role' : role !== 'service_role');
      assert.equal(await scalar(target, 'SELECT has_function_privilege($1,$2,\'EXECUTE\')', [role, f.signature]), allowed, `${role} ${f.signature}`);
    }
  }
  await assert.rejects(rpc(target, PREFIX + 'read_authorize', readArgs()), /permission denied/);
  for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await scalar(target, `SELECT has_table_privilege($1,'private.employee_transfer_archive_records','SELECT')`, [role]), false);
}));

test('super-admin/session/job/scope/lifetime/maintenance/records gates reject; no caller-defined path', () => inCase(async () => {
  const secondary = await adminLogin(source, 'branch', PASSWORDS.branch), emergency = await adminLogin(source, 'emergency', PASSWORDS.emergency);
  for (const token of [secondary, emergency, id(99)]) await assert.rejects(rpc(source, PREFIX + 'inventory', { ...auth(sourceJob, token), p_direction: 'export' }));
  await assert.rejects(rpc(target, PREFIX + 'inventory', { ...auth(dispatchJob, id(99)), p_direction: 'import' }));
  for (const direction of ['export', '', null, 'chat']) await assert.rejects(rpc(target, PREFIX + 'inventory', { ...auth(dispatchJob, targetToken), p_direction: direction }));
  for (const [field, value] of [['status', 'cancelled'], ['last_activity_at', '2000-01-01'], ['started_at', '2000-01-01']]) {
    await target.exec('SAVEPOINT gate');await target.query(`UPDATE private.employee_transfer_jobs SET ${field}=$1 WHERE id=$2`, [value, dispatchJob.job_id]);
    await assert.rejects(rpc(target, PREFIX + 'inventory', { ...auth(dispatchJob, targetToken), p_direction: 'import' }));await target.exec('ROLLBACK TO SAVEPOINT gate;RELEASE SAVEPOINT gate');
  }
  await target.exec('SAVEPOINT gate');await target.query('UPDATE private.employee_transfer_maintenance SET dirty=false WHERE singleton');
  await assert.rejects(rpc(target, PREFIX + 'inventory', { ...auth(dispatchJob, targetToken), p_direction: 'import' }));await target.exec('ROLLBACK TO SAVEPOINT gate;RELEASE SAVEPOINT gate');
  await target.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_restore,records_verified}','false') WHERE id=$1`, [dispatchJob.job_id]);
  await assert.rejects(rpc(target, PREFIX + 'bind', { ...auth(dispatchJob, targetToken), p_files: [] }));
}));

test('bind exact full tuples, immutable sidecar; unchecked receipt and forged generation cannot verify', () => inCase(async () => {
  const data = await exportMedia();activate(target, targetToken);const file = data.file;
  const bind = p_files => rpc(target, PREFIX + 'bind', { ...auth(dispatchJob, targetToken), p_files });
  for (const input of [[], [file, file], [{ ...file, key: 'f'.repeat(64) }], [{ ...file, source_url: 'https://evil.invalid/a' }], [{ ...file, bytes: 52428801 }], [{ ...file, content_type: 'application/pdf' }], [{ ...file, extra: true }]]) await assert.rejects(bind(input));
  await bind([file]);await assert.rejects(bind([{ ...file, sha256: 'f'.repeat(64) }]));
  const args = { ...auth(dispatchJob, targetToken), p_action: 'upload', p_object_key: file.key };
  const ctx = await rpc(target, PREFIX + 'authorize', args, 'service_role');
  await assert.rejects(rpc(target, PREFIX + 'commit', { ...args, p_bytes: file.bytes, p_sha256: file.sha256, p_content_type: file.content_type, p_storage_origin: 'https://fixture.supabase.co', p_generation: 'f'.repeat(64) }, 'service_role'));
  await assert.rejects(rpc(target, PREFIX + 'verify', { ...auth(dispatchJob, targetToken), p_direction: 'import' }));
  assert.notEqual(ctx.generation, 'f'.repeat(64));
}));

test('source catalog/media_refs drift invalidates authorize and fixed source path safety rejects traversal', () => inCase(async () => {
  await source.query(`UPDATE private.content_audit_events SET media_refs=$1::jsonb WHERE id=$2`, [JSON.stringify({ [REF]: '../secret' }), EVENT]);
  await assert.rejects(rpc(source, PREFIX + 'inventory', { ...auth(sourceJob, sourceToken), p_direction: 'export' }), /source changed/);
  const refreshed = await scalar(source, 'SELECT private.employee_transfer_archives_catalog($1)', [PACKAGE]);
  await source.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_catalog}',$1::jsonb) WHERE id=$2`, [JSON.stringify(refreshed), sourceJob.job_id]);
  await assert.rejects(rpc(source, PREFIX + 'inventory', { ...auth(sourceJob, sourceToken), p_direction: 'export' }), /Unsafe private/);
}));

test('persisted raw-line drift and sidecar path/ref/key/checked tampering block read, even after verified', () => inCase(async () => {
  await restored();
  for (const path of [['refs', '0', 'ref_value'], ['refs', '0', 'source_line_sha256'], ['receipts', (await targetClient.status()).files[0].key, 'path'], ['receipts', (await targetClient.status()).files[0].key, 'checked']]) {
    await target.exec('SAVEPOINT drift');
    await target.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,$1::text[],$2::jsonb) WHERE id=$3`, [['archives_media', ...path], JSON.stringify(path.at(-1) === 'checked' ? false : 'forged-private-value'), dispatchJob.job_id]);
    await assert.rejects(rpc(target, PREFIX + 'read_authorize', readArgs(), 'service_role'));await target.exec('ROLLBACK TO SAVEPOINT drift;RELEASE SAVEPOINT drift');
  }
  // Local privileged attack fixture only: restore guard without changing its definition/inventory.
  await target.exec('ALTER TABLE private.employee_transfer_archive_records DISABLE TRIGGER zz_employee_transfer_maintenance');
  await target.query(`UPDATE private.employee_transfer_archive_records SET source_line=source_line||' ' WHERE source_id=$1`, [EVENT]);
  await target.exec('ALTER TABLE private.employee_transfer_archive_records ENABLE ALWAYS TRIGGER zz_employee_transfer_maintenance');
  await assert.rejects(rpc(target, PREFIX + 'read_authorize', readArgs(), 'service_role'), /namespace changed|records differ/);
}));

test('SQL file bounds and aggregate 1GiB include records; service receipts here are synthetic, not Storage evidence', () => inCase(async () => {
  await rpc(source, 'employee_transfer_cancel', auth(sourceJob, sourceToken));
  const refs = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`opaque-${i}`, `${OP}/shared/${i}`]));
  await source.query('UPDATE private.content_audit_events SET media_refs=$1::jsonb WHERE id=$2', [JSON.stringify(refs), EVENT]);
  const job = await rpc(source, 'employee_export_archives_begin', { p_admin_session_token: sourceToken, p_admin_password: PASSWORDS.root, p_package_id: PACKAGE });
  const inventory = await rpc(source, PREFIX + 'inventory', { ...auth(job, sourceToken), p_direction: 'export' });
  for (const [i, ref] of inventory.files.entries()) {
    const args = { ...auth(job, sourceToken), p_action: 'download', p_object_key: ref.key };
    const ctx = await rpc(source, PREFIX + 'authorize', args, 'service_role');
    const commit = bytes => rpc(source, PREFIX + 'commit', { ...args, p_bytes: bytes, p_sha256: 'f'.repeat(64), p_content_type: 'image/jpeg', p_storage_origin: 'https://fixture.supabase.co', p_generation: ctx.generation }, 'service_role');
    if (i === 0) for (const size of [0, -1, 52428801]) await assert.rejects(commit(size));
    if (i < 20) await commit(52428800);else {
      await assert.rejects(commit(52428800), /1 GiB/);await assert.rejects(commit(24 * 1024 * 1024), /1 GiB/);
      await commit(24 * 1024 * 1024 - job.catalog.tables.reduce((n, t) => n + t.bytes, 0));
    }
  }
}));

test('3001 actual source references fail explicitly rather than truncating inventory', () => inCase(async () => {
  await rpc(source, 'employee_transfer_cancel', auth(sourceJob, sourceToken));
  await source.query(`INSERT INTO private.content_audit_events(id,operation_id,entity_type,entity_id,action,owner_admin_id,actor_admin_id,actor_username,actor_role,media_refs)
    SELECT ('83000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,$1,'notification',$2,'edit',$3,$3,'root','super_admin',$4::jsonb FROM generate_series(1,3000) s(n)`, [OP, ENTITY, NEW.root, JSON.stringify({ [REF]: PATH })]);
  const job = await rpc(source, 'employee_export_archives_begin', { p_admin_session_token: sourceToken, p_admin_password: PASSWORDS.root, p_package_id: PACKAGE });
  await assert.rejects(rpc(source, PREFIX + 'inventory', { ...auth(job, sourceToken), p_direction: 'export' }), /3000 files/);
}));

test('permanent read survives cancel, expiry and staging deletion, but wrong namespace/event/ref and corrupted bytes fail', () => inCase(async () => {
  await restored();
  await rpc(target, 'employee_transfer_cancel', auth(dispatchJob, targetToken));
  await target.query(`UPDATE private.employee_transfer_jobs SET started_at='2000-01-01',last_activity_at='2000-01-01' WHERE id=$1`, [dispatchJob.job_id]);
  await target.query('DELETE FROM private.employee_transfer_staging WHERE job_id=$1', [dispatchJob.job_id]);
  const ctx = await rpc(target, PREFIX + 'read_authorize', readArgs(), 'service_role');assert.equal(ctx.file.sha256, sha(JPEG));
  for (const extra of [{ p_source_site_id: id(99) }, { p_package_id: id(99) }, { p_event_id: id(99) }, { p_ref_key: 'wrong' }]) await assert.rejects(rpc(target, PREFIX + 'read_authorize', { ...readArgs(), ...extra }, 'service_role'));
  const binding = { source_site_id: catalog.site_id, package_id: PACKAGE, event_id: EVENT, ref_key: REF };
  assert.equal((await modules.readArchiveMedia(binding, undefined, transport)).size, JPEG.length);
  stores.get(target).set(`content-audit-evidence/${ctx.path}`, Uint8Array.of(255, 216, 255, 0, 9, 9, 9));
  await assert.rejects(modules.readArchiveMedia(binding, undefined, transport));
}));

test('cleared evidence with remaining media_refs blocks rather than resurrecting or silently skipping attachments', () => inCase(async () => {
  await source.query(`UPDATE private.content_audit_events SET cleared_at='2024-01-01' WHERE id=$1`, [EVENT]);
  // Simulate a genuine source snapshot with inconsistent legacy cleared metadata.
  const refreshed = await scalar(source, 'SELECT private.employee_transfer_archives_catalog($1)', [PACKAGE]);
  await source.query(`UPDATE private.employee_transfer_jobs SET summary=jsonb_set(summary,'{archives_catalog}',$1::jsonb) WHERE id=$2`, [JSON.stringify(refreshed), sourceJob.job_id]);
  await assert.rejects(rpc(source, PREFIX + 'inventory', { ...auth(sourceJob, sourceToken), p_direction: 'export' }), /Cleared archive evidence/);
  assert.equal(await scalar(source, 'SELECT summary ? \'archives_media\' FROM private.employee_transfer_jobs WHERE id=$1', [sourceJob.job_id]), false);
}));

test('unreferenced objects and keys never authorize, including an actual private object outside the frozen archive', () => inCase(async () => {
  const unauthorized = sha(`${OP}/shared/unreferenced`);
  const before = calls.length;
  await assert.rejects(rpc(source, PREFIX + 'authorize', { ...auth(sourceJob, sourceToken), p_action: 'download', p_object_key: unauthorized }, 'service_role'), /outside this job/);
  assert.equal(calls.length, before);
}));

test('actual COMMIT followed by lost upload response and a new client: status and explicit recheck resume permanent sidecar', async () => {
  // Commit authentic SQL34 setup, not fabricated verified flags. A fresh API then observes media COMMIT.
  sourceClient = modules.createArchiveMediaSession(sourceJob.job_token, 'export', transport);
  await source.exec('COMMIT;BEGIN');await target.exec('COMMIT;BEGIN');
  stores.set(target, new Map());const data = await exportMedia();await source.exec('COMMIT;BEGIN');activate(target, targetToken);
  let drop = true;
  const client = modules.createArchiveMediaSession(dispatchJob.job_token, 'import', async (url, init) => {
    const response = await transport(url, init);
    if (drop && init.headers['x-transfer-action'] === 'upload') {
      drop = false;await target.exec('COMMIT;BEGIN');await response.body?.cancel();throw Error('synthetic response lost after real COMMIT');
    }
    return response;
  });
  await client.bind([data.file]);await assert.rejects(client.upload(data.file, data.bytes), e => e.outcomeUnknown === true);
  const resumed = modules.createArchiveMediaSession(dispatchJob.job_token, 'import', transport);
  const status = await resumed.status();assert.deepEqual(status.transferred, [data.file.key]);assert.equal(status.verified, false);
  await resumed.recheckImport([data.file]);assert.equal((await resumed.verify()).verified, true);await target.exec('COMMIT;BEGIN READ ONLY');
  const readonly = await rpc(target, PREFIX + 'read_authorize', readArgs(), 'service_role');assert.equal(readonly.file.sha256, data.file.sha256);
  const blob = await modules.readArchiveMedia({ source_site_id: catalog.site_id, package_id: PACKAGE, event_id: EVENT, ref_key: REF }, undefined, transport);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), JPEG);
});
