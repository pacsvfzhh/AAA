import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, mock, after } from 'node:test';
import { build } from 'esbuild';

// Synthetic transport only. This file never creates a Supabase client or fetches Storage.
mock.method(globalThis, 'fetch', () => assert.fail('Real network/production access forbidden'));
after(() => { assert.equal(globalThis.fetch.mock.callCount(), 0);mock.restoreAll(); });
const id = n => `84000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SITE = id(1), PACKAGE = id(2), EVENT = id(3), JOB = id(4), SESSION = id(5);
const REF = 'https://original.invalid/storage/v1/object/public/chat-images/a.png', PATH = `${id(6)}/shared/0`;
const sha = input => createHash('sha256').update(input).digest('hex');
const PREFIX = 'employee_transfer_archive_media_';
const TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4'];
const JPEG = Uint8Array.of(255, 216, 255, 0, 1, 2);
const TABLES = ['content_audit_events', 'deleted_employee_accounts', 'deleted_employee_notifications', 'content_audit_recipient_versions', 'deleted_employee_summaries', 'deleted_employee_withdrawals'];
const SOURCE = `archive-evidence-v1:${SITE}:${PACKAGE}:${EVENT}:${'a'.repeat(64)}:${sha(REF)}:${sha(PATH)}`;
const KEY = sha(SOURCE);
const FILE = { key: KEY, source_url: SOURCE, bytes: JPEG.length, sha256: sha(JPEG), content_type: 'image/jpeg' };
const ref = () => ({ key: KEY, source_url: SOURCE, event_id: EVENT, source_line_sha256: 'a'.repeat(64), ref_key: REF, ref_value: PATH, bucket: 'content-audit-evidence', path: PATH, file: null });
const catalog = () => ({ version: 1, scope: 'site-archives', site_id: SITE, package_id: PACKAGE,
  tables: TABLES.map((key, i) => ({ key, rows: i ? 0 : 1, bytes: i ? 0 : 128, row_hashes_sha256: i ? sha('') : 'b'.repeat(64) })), full_site_complete: false });
const receipt = file => ({ success: true, key: file.key, bytes: file.bytes, sha256: file.sha256, content_type: file.content_type, full_site_complete: false });
const built = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/archiveMedia.ts';export {setHarness} from 'archive-client:harness';`,
  resolveDir: new URL('../..', import.meta.url).pathname }, bundle: true, write: false, platform: 'browser', format: 'esm',
  define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://fixture.supabase.co'), 'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('synthetic-anon') },
  plugins: [{ name: 'offline', setup(b) {
    b.onResolve({ filter: /^archive-client:harness$|\/auth$|\/supabase$/ }, () => ({ path: 'harness', namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents: `let h;export const setHarness=v=>{h=v};export const getAdminFinancialSessionToken=()=>h.session;export const supabase={rpc:(...args)=>h.rpc(...args)};` }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
function harness(direction = 'import') {
  const h = { session: SESSION, calls: [], bound: direction === 'export', verified: false, transferred: false, checked: false,
    file: null, mutateStatus: null, lose: null, malformed: null };
  h.inventory = () => ({ version: 1, scope: 'site-archives-media', direction, archives_catalog: catalog(), files: [{ ...ref(), file: h.file }],
    bound: h.bound, verified: h.verified, transferred: h.transferred ? [KEY] : [], checked: h.checked ? [KEY] : [], full_site_complete: false });
  h.rpc = (name, args) => {
    h.calls.push({ op: name, args: structuredClone(args) });
    const q = { abortSignal() { return q; }, then(resolve, reject) { return Promise.resolve().then(() => {
      let data;
      if (name === PREFIX + 'bind') {
        h.bound = true;h.file = structuredClone(args.p_files[0]);data = { success: true, files: 1, bytes: JPEG.length, repeated: false, full_site_complete: false };
      } else if (name === PREFIX + 'verify') {
        if (!h.checked) return { error: new Error('private-secret') };
        h.verified = true;data = h.inventory();
      } else data = h.inventory();
      if (name === PREFIX + 'status' && h.mutateStatus) { data = structuredClone(data);h.mutateStatus(data); }
      if (h.lose === name) { h.lose = null;throw Error('private-secret'); }
      if (h.malformed === name) { h.malformed = null;data = { success: false }; }
      return { data, error: null };
    }).then(resolve, reject); } };return q;
  };
  h.transport = async (url, init) => {
    assert.equal(url, 'https://fixture.supabase.co/functions/v1/employee-transfer-media');
    assert.equal(init.redirect, 'error');assert.equal(init.credentials, 'omit');assert.equal(init.cache, 'no-store');
    const action = init.headers['x-transfer-action'];h.calls.push({ op: action, init: structuredClone({ ...init, signal: undefined }) });
    assert.equal(init.headers['x-transfer-scope'], 'archives');
    let response;
    if (action === 'read') response = new Response(JPEG, { headers: { 'content-type': FILE.content_type, 'x-transfer-content-type': FILE.content_type, 'x-transfer-sha256': FILE.sha256 } });
    else {
      assert.equal(init.headers['x-transfer-job-token'], JOB);assert.equal(init.headers['x-transfer-object-key'], KEY);
      h.transferred = true;h.file = { ...FILE };if (action.startsWith('recheck-')) h.checked = true;
      response = action === 'download' ? new Response(JPEG, { headers: { 'content-type': 'application/octet-stream', 'x-transfer-content-type': FILE.content_type, 'x-transfer-sha256': FILE.sha256 } }) : Response.json(receipt(FILE));
    }
    if (h.lose === action) { h.lose = null;await response.body.cancel();throw Error('private-secret'); }
    if (h.malformed === action) { h.malformed = null;return Response.json({ success: false }); }
    return response;
  };
  api.setHarness(h);h.client = api.createArchiveMediaSession(JOB, direction, h.transport);return h;
}
const unknown = error => error instanceof api.ArchiveMediaError && error.outcomeUnknown === true && !error.message.includes('private-secret');
const clone = value => structuredClone(value);

for (const direction of ['export', 'import']) test(`${direction} explicit inventory → transfer → recheck → verify`, async () => {
  const h = harness(direction);const inventory = await h.client.inventory();assert.equal(inventory.verified, false);
  if (direction === 'export') {
    const downloaded = await h.client.download(inventory.files[0]);assert.deepEqual(downloaded.bytes, JPEG);assert.deepEqual(downloaded.file, FILE);
    await h.client.recheckExport([downloaded.file]);
  } else { await h.client.bind([FILE]);await h.client.upload(FILE, JPEG);await h.client.recheckImport([FILE]); }
  assert.equal((await h.client.verify()).verified, true);
  assert.equal(h.calls.filter(c => c.op === 'upload').length, direction === 'export' ? 0 : 1);
  assert.ok(h.calls.filter(c => c.op.startsWith(PREFIX)).every(c => c.args.p_admin_session_token === SESSION));
});
for (const loss of ['lose', 'malformed']) for (const operation of ['bind', 'upload', 'verify']) test(`${loss} ${operation}: explicit status required before any further write`, async () => {
  const h = harness();if (operation !== 'bind') await h.client.bind([FILE]);
  if (operation === 'verify') { await h.client.upload(FILE, JPEG);await h.client.recheckImport([FILE]); }
  h[loss] = operation === 'upload' ? operation : PREFIX + operation;
  await assert.rejects(operation === 'bind' ? h.client.bind([FILE]) : operation === 'upload' ? h.client.upload(FILE, JPEG) : h.client.verify(), unknown);
  const n = h.calls.length;await assert.rejects(h.client.upload(FILE, JPEG), unknown);await assert.rejects(h.client.verify(), unknown);
  await assert.rejects(h.client.inventory(), unknown);assert.equal(h.calls.length, n);
  assert.equal((await h.client.status()).bound, true);await h.client.recheckImport([FILE]);
});
for (const [label, mutate] of [
  ['catalog', s => s.archives_catalog.package_id = id(99)],
  ['file hash', s => s.files[0].file.sha256 = 'f'.repeat(64)],
  ['reference identity', s => { const r = s.files[0];r.ref_key = 'other-ref';const parts = r.source_url.split(':');parts[5] = sha(r.ref_key);r.source_url = parts.join(':');r.key = sha(r.source_url);r.file.key = r.key;r.file.source_url = r.source_url; }],
]) test(`lost bind: well-shaped but changed ${label} status cannot release uncertainty`, async () => {
  const h = harness();h.lose = PREFIX + 'bind';await assert.rejects(h.client.bind([FILE]), unknown);h.mutateStatus = mutate;
  await assert.rejects(h.client.status());const n = h.calls.length;await assert.rejects(h.client.upload(FILE, JPEG), unknown);assert.equal(h.calls.length, n);
  h.mutateStatus = null;await h.client.status();await h.client.upload(FILE, JPEG);
});
test('unknown bind can be reconciled as not committed, then explicitly rebound only to the same files', async () => {
  const h = harness();h.lose = PREFIX + 'bind';await assert.rejects(h.client.bind([FILE]), unknown);
  h.bound = false;h.file = null;assert.equal((await h.client.status()).bound, false);
  await assert.rejects(h.client.bind([{ ...FILE, sha256: 'f'.repeat(64) }]));
  await h.client.bind([FILE]);assert.equal((await h.client.status()).bound, true);
});
for (const field of ['bound', 'verified', 'transferred', 'checked']) test(`confirmed ${field} cannot regress through status`, async () => {
  const h = harness();await h.client.bind([FILE]);await h.client.upload(FILE, JPEG);await h.client.recheckImport([FILE]);await h.client.verify();
  h.lose = 'upload';await assert.rejects(h.client.upload(FILE, JPEG), unknown);
  h.mutateStatus = s => { if (field === 'bound') { s.bound = false;s.verified = false; } else if (field === 'verified') s.verified = false;else { s[field] = [];s.verified = false;if (field === 'transferred') s.checked = []; } };
  await assert.rejects(h.client.status());await assert.rejects(h.client.upload(FILE, JPEG), unknown);
});
test('caller mutation of returned inventory cannot erase confirmed progress or file bindings', async () => {
  const h = harness();await h.client.bind([FILE]);await h.client.upload(FILE, JPEG);await h.client.recheckImport([FILE]);
  const result = await h.client.verify();result.verified = false;result.checked.length = 0;result.transferred.length = 0;result.files[0].file.sha256 = 'f'.repeat(64);
  h.mutateStatus = s => { s.verified = false;s.checked = [];s.transferred = []; };
  await assert.rejects(h.client.status());
});
test('download tuple observed from status cannot later disappear or change', async () => {
  const h = harness('export');const ref = (await h.client.inventory()).files[0];await h.client.download(ref);await h.client.status();
  h.mutateStatus = s => { s.files[0].file.sha256 = 'c'.repeat(64); };await assert.rejects(h.client.status());
});

for (const [field, value] of [['key', 'f'.repeat(64)], ['source_url', 'https://evil.invalid/file'], ['bytes', 0], ['bytes', 52428801], ['bytes', 1.5], ['sha256', 'not-a-hash'], ['content_type', 'application/pdf'], ['extra', true]]) test(`reject invalid file ${field}=${value} before transport`, async () => {
  const h = harness();await assert.rejects(h.client.upload({ ...FILE, [field]: value }, JPEG));assert.equal(h.calls.length, 0);
});
for (const bytes of [new Uint8Array(), Uint8Array.of(255, 216, 255, 9, 9, 9), new Uint8Array(JPEG.length + 1)]) test(`upload checks original length/hash/signature ${sha(bytes)} before dispatch`, async () => {
  const h = harness();await assert.rejects(h.client.upload(FILE, bytes));assert.equal(h.calls.length, 0);
});
for (const type of TYPES) test(`allowed file metadata ${type} roundtrips without URL conversion`, () => {
  const file = api.validateArchiveMediaFile({ ...FILE, content_type: type });assert.equal(file.source_url, SOURCE);
});
for (const modify of [r => r.bucket = 'chat-images', r => r.path = '../private', r => r.ref_value = '../private', r => r.source_line_sha256 = 'c'.repeat(64), r => r.ref_key = 'wrong', r => r.source_url += '?token=secret']) test(`inventory rejects unbound private metadata ${modify}`, () => {
  const h = harness('export'), input = h.inventory();modify(input.files[0]);assert.throws(() => api.validateArchiveMediaInventory(input, 'export'));
});
test('sparse files and duplicate transferred/checked keys are never accepted as full catalog', () => {
  const h = harness('export');const sparse = h.inventory();sparse.files = new Array(1);assert.throws(() => api.validateArchiveMediaInventory(sparse, 'export'));
  for (const field of ['transferred', 'checked']) { const input = h.inventory();input[field] = [KEY, KEY];assert.throws(() => api.validateArchiveMediaInventory(input, 'export')); }
});
test('inventory rejects impossible source bound/file-receipt and target unbound/file combinations', () => {
  const source = harness('export').inventory();source.bound = false;assert.throws(() => api.validateArchiveMediaInventory(source, 'export'));
  source.bound = true;source.files[0].file = FILE;assert.throws(() => api.validateArchiveMediaInventory(source, 'export'));
  const target = harness('import').inventory();target.files[0].file = FILE;assert.throws(() => api.validateArchiveMediaInventory(target, 'import'));
});
test('expired session is re-read per request; no cached administrator identity', async () => {
  const h = harness();await h.client.inventory();h.session = id(88);await h.client.status();
  assert.equal(h.calls.at(-1).args.p_admin_session_token, id(88));
});
test('read Blob uses namespace/event/ref binding only; no job/path/signed URL or sidecar writes', async () => {
  const h = harness();const binding = { source_site_id: SITE, package_id: PACKAGE, event_id: EVENT, ref_key: REF };
  const blob = await api.readArchiveMedia(binding, undefined, h.transport);assert.equal(blob.type, 'image/jpeg');assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), JPEG);
  assert.equal(h.calls.length, 1);const sent = h.calls[0].init;assert.equal(sent.headers['x-transfer-job-token'], undefined);assert.equal(sent.headers['x-transfer-object-key'], undefined);assert.deepEqual(JSON.parse(sent.body), binding);
  await assert.rejects(api.readArchiveMedia({ ...binding, path: PATH }, undefined, h.transport));assert.equal(h.calls.length, 1);
});
test('corrupted Blob response and pre-aborted request are rejected without exposing raw errors', async () => {
  const h = harness(), binding = { source_site_id: SITE, package_id: PACKAGE, event_id: EVENT, ref_key: REF };
  await assert.rejects(api.readArchiveMedia(binding, undefined, async () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg', 'x-transfer-content-type': 'image/jpeg', 'x-transfer-sha256': 'f'.repeat(64) } })));
  const controller = new AbortController();controller.abort();await assert.rejects(api.readArchiveMedia(binding, controller.signal, h.transport));assert.equal(h.calls.length, 0);
});
for (const direction of ['export', 'import']) test(`${direction}: metadata limits enforce 3000 and record+media 1GiB`, () => {
  const h = harness(direction);const input = h.inventory();input.files = new Array(3001).fill(ref());assert.throws(() => api.validateArchiveMediaInventory(input, direction));
  const tooLarge = clone(h.inventory());tooLarge.archives_catalog.tables[0].bytes = 256 * 1024 * 1024;
  tooLarge.archives_catalog.tables[1] = { ...tooLarge.archives_catalog.tables[1], rows: 1, bytes: 256 * 1024 * 1024, row_hashes_sha256: 'b'.repeat(64) };
  tooLarge.archives_catalog.tables[2] = { ...tooLarge.archives_catalog.tables[1], key: TABLES[2] };
  tooLarge.archives_catalog.tables[3] = { ...tooLarge.archives_catalog.tables[1], key: TABLES[3] };
  tooLarge.files[0].file = FILE;assert.throws(() => api.validateArchiveMediaInventory(tooLarge, direction));
});
