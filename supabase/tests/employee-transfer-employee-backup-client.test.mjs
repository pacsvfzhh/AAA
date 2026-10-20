import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { build } from 'esbuild';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

for (const [module, name] of [[globalThis, 'fetch'], [http, 'request'], [https, 'request'], [net, 'connect'], [tls, 'connect']]) {
  mock.method(module, name, () => assert.fail('Network, SDK and production services forbidden'));
}
after(() => { assert.equal(globalThis.fetch.mock.callCount(), 0); mock.restoreAll(); });
const root = fileURLToPath(new URL('../../', import.meta.url));
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/employeeBackup.ts';
  export * from './src/lib/employeeTransfer/container.ts';
  export {decryptTransferStream} from './src/lib/employeeTransfer/crypto.ts';
  export {setHarness} from 'employee-backup-test:state';`, resolveDir: root },
  bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2020', metafile: true,
  plugins: [{ name: 'offline-only', setup(b) {
    b.onResolve({ filter: /^(?:employee-backup-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path }) => ({ contents: path === 'employee-backup-test:state'
      ? 'let h;export const setHarness=v=>{h=v};export const current=()=>h;'
      : path === '../auth' ? 'import{current}from"employee-backup-test:state";export const getAdminFinancialSessionToken=()=>{const h=current();h.tokenReads++;return h.session;};'
        : 'import{current}from"employee-backup-test:state";export const supabase={rpc:(...args)=>current().rpc(...args)};' }));
  } }],
});
assert.ok(!Object.keys(compiled.metafile.inputs).some(path => /node_modules\/@supabase|src\/lib\/(?:supabase|auth)\.ts|archiveBundle\.ts|replacementBackup\.ts/.test(path)));
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const TABLES = [...api.EMPLOYEE_BACKUP_TABLE_KEYS];
const CATALOG = 'get_employee_import_replacement_backup', PAGE = 'get_employee_import_replacement_backup_page', VERIFY = 'employee_import_replacement_backup_verify';
const id = n => `a9000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const SOURCE_SITE = id(1), TARGET_SITE = id(2), PACKAGE = id(3), JOB = id(4), TOKEN = id(5), SESSION = id(6), SOURCE = id(7), TARGET = id(8);
const TIME = '2024-02-29T23:34:56.123456+00:00', PASS = 'independent local employee records backup';
const PRECISE = '12345678901234567890.12345678901234567890', TINY = '0.00000000000000000001';
const SECRET = 'PRIVATE-BACKEND-OR-PLAINTEXT-MUST-NOT-LEAK';
const sha = raw => createHash('sha256').update(raw).digest('hex');
const lines = text => text.match(/[^\n]*\n/g) ?? [];
const rowHash = text => sha(lines(text).map(sha).join(''));
const flags = { records_only: true, media_included: false, can_archive: false, can_replace: false, full_site_complete: false };
const incomplete = { ...flags, complete_employee_backup: false, backup_sealed: false };
const missing = ['chat', 'notifications', 'media', 'dispatch_configuration', 'used_order_data', 'orders_history', 'archive_evidence'];
async function spec(file, domain) {
  const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
  const match = sql.match(new RegExp(`CREATE FUNCTION private.employee_transfer_${domain}_spec\\(\\)[\\s\\S]*?SELECT '([\\s\\S]*?)'::jsonb;`));
  assert.ok(match); return JSON.parse(match[1]);
}
const projections = { ...await spec('20261102000014_export_stage_employee_identities.sql', 'identity'),
  ...await spec('20261102000017_export_stage_employee_finance.sql', 'finance'),
  ...await spec('20261102000019_export_stage_employee_activity.sql', 'activity'),
  ...await spec('20261102000021_export_stage_employee_verification.sql', 'verification'),
  dispatch_group_members: (await spec('20261102000009_export_dispatch_submission_data.sql', 'dispatch')).dispatch_group_members,
  employee_submit_time_settings: { id: 'uuid!', user_id: 'uuid!', group_id: 'uuid', min_seconds: 'integer', max_seconds: 'integer', created_at: 'timestamp with time zone' } };
function row(key, index = 0) {
  const value = Object.fromEntries(Object.entries(projections[key]).map(([field, specification]) => {
    const type = specification.replace(/!$/, '');
    return [field, type === 'uuid' ? id(1000 + TABLES.indexOf(key) * 500 + index)
      : type === 'text' ? '原始文字𠮷 é é' : type === 'numeric' ? '__precise__' : type === 'bigint-text' ? '9007199254740993'
        : type === 'boolean' ? false : type === 'integer' ? 1 : type === 'timestamp with time zone' ? TIME : type === 'text[]' ? ['標籤', null] : null];
  }));
  value.id = ['accounts', 'credentials', 'wallets', 'wallet_balance_baselines', 'work_stop_markers'].includes(key) ? TARGET : value.id;
  if (Object.hasOwn(value, 'user_id')) value.user_id = TARGET;
  if (key === 'accounts') Object.assign(value, { username: 'target-employee', password_hash: '$2a$hashed-account', updated_at: null, remarks: '原始備註\n𠮷', is_pinned: true });
  if (key === 'credentials') value.password_hash = '$2a$hashed-financial-password';
  if (key === 'orders') value.status = index % 2 === 0 ? 'success' : 'failure';
  if (key === 'employee_login_history') Object.assign(value, { session_id: `history-${'a'.repeat(64)}`, device_info: index === 0 || index === 1 ? null : { precise: '__precise__', tiny: '__tiny__', null: null }, device_info_is_sql_null: index === 0 });
  if (key === 'work_sessions') Object.assign(value, { end_time: index === 0 ? null : TIME, last_heartbeat_at: null, duration_minutes: index === 0 ? null : 321 });
  if (key === 'verification_requests') Object.assign(value, { id_front_url: 'https://offline.supabase.co/storage/v1/object/public/verification-documents/front/raw.png', id_back_url: null, selfie_url: null, audit_remark: null });
  if (key === 'wallet_ledger_entries' || key === 'wallet_reconciliation_audit') value.id = ['2', '10', '9007199254740993', '9223372036854775807'][index] ?? String(100 + index);
  return JSON.stringify(value).replaceAll('"__precise__"', PRECISE).replaceAll('"__tiny__"', TINY).replace('"id":', '"\\u0069d":') + ' \r\n';
}
function texts(many = false) {
  return Object.fromEntries(TABLES.map(key => [key, Array.from({ length: key === 'employee_login_history' ? (many ? 205 : 3)
    : ['orders', 'work_sessions'].includes(key) ? 2 : ['wallet_ledger_entries', 'wallet_reconciliation_audit'].includes(key) ? 4 : 1 }, (_, i) => row(key, i)).join('')]));
}
function catalog(text) {
  return { version: 1, protocol: 'replacement-records-v1', scope: 'employee-replacement-records', job_id: JOB,
    source_site_id: SOURCE_SITE, package_id: PACKAGE, target_site_id: TARGET_SITE, source_employee_id: SOURCE, target_employee_id: TARGET,
    username: 'target-employee', source_fingerprint: '1'.repeat(64), fingerprint: '2'.repeat(64),
    tables: TABLES.map(key => ({ key, rows: lines(text[key]).length, bytes: Buffer.byteLength(text[key]), row_hashes_sha256: rowHash(text[key]) })),
    projections: structuredClone(projections), missing_domains: [...missing], excluded_data: ['active_sessions', 'account_locks', 'detailed_orders', 'financial_operations'], ...incomplete };
}
const info = () => ({ exportId: randomUUID(), volumeId: randomUUID(), sourceSiteId: TARGET_SITE, scope: 'replacement-backup',
  volumeIndex: 1, volumeCount: 1, createdAt: '2026-10-20T00:00:00.000Z' });
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'employee-backup-client-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const h = { session: SESSION, tokenReads: 0, calls: [], workspaces: [], events: [], text: texts(options.many), options, transform: null,
    rpcHook: null, workspaceHook: null, cleanupHook: null, fileWriteHook: null, fileReadHook: null, writes: 0, opens: 0, verifyCount: 0 };
  h.catalog = catalog(h.text); h.info = info();
  h.reply = (name, args) => {
    if (name === CATALOG) return structuredClone(h.catalog);
    assert.equal(args.p_catalog_fingerprint, h.catalog.fingerprint);
    if (name === VERIFY) { h.verifyCount++; return { verified: true, protocol: h.catalog.protocol, scope: h.catalog.scope,
      source_employee_id: h.catalog.source_employee_id, target_employee_id: h.catalog.target_employee_id, fingerprint: h.catalog.fingerprint,
      missing_domains: [...h.catalog.missing_domains], ...incomplete }; }
    assert.equal(name, PAGE); assert.ok(TABLES.includes(args.p_table_key)); assert.equal(args.p_limit, 200);
    const all = lines(h.text[args.p_table_key]);
    const start = args.p_after === null ? 0 : all.findIndex(line => JSON.parse(line).id === args.p_after) + 1;
    assert.ok(args.p_after === null || start > 0);
    const selected = all.slice(start, start + (options.pageSize ?? 2)), ndjson = selected.join('');
    return { protocol: h.catalog.protocol, source_employee_id: h.catalog.source_employee_id, target_employee_id: h.catalog.target_employee_id,
      fingerprint: h.catalog.fingerprint, table_key: args.p_table_key, count: selected.length, bytes: Buffer.byteLength(ndjson), ndjson,
      next_after: start + selected.length < all.length ? JSON.parse(selected.at(-1)).id : null, sha256: sha(ndjson), ...flags };
  };
  h.rpc = (name, args) => {
    assert.ok([CATALOG, PAGE, VERIFY].includes(name)); assert.equal(args.p_job_token, TOKEN); assert.equal(args.p_source_employee_id, SOURCE);
    assert.equal(args.p_admin_session_token, h.session);
    assert.deepEqual(Object.keys(args).sort(), (name === CATALOG ? ['p_admin_session_token', 'p_job_token', 'p_source_employee_id']
      : name === VERIFY ? ['p_admin_session_token', 'p_job_token', 'p_source_employee_id', 'p_catalog_fingerprint']
        : ['p_admin_session_token', 'p_job_token', 'p_source_employee_id', 'p_catalog_fingerprint', 'p_table_key', 'p_after', 'p_limit']).sort());
    const query = { signal: undefined, abortSignal(signal) { query.signal = signal; return query; }, then(resolve, reject) {
      return Promise.resolve().then(async () => {
        h.calls.push({ name, args: structuredClone(args), signal: query.signal }); h.events.push(name);
        if (h.rpcHook) await h.rpcHook(name, args, query.signal);
        const value = h.reply(name, args), response = h.transform ? await h.transform(name, value, args) : value;
        return { data: response, error: null };
      }).then(resolve, reject);
    } }; return query;
  };
  h.createWorkspace = () => {
    const base = join(directory, `workspace-${h.workspaces.length}`);
    const w = { base, cleaned: false, cleanups: 0, writes: [],
      async append(path, bytes, signal) {
        assert.equal(w.cleaned, false); assert.equal(signal?.aborted, false);
        assert.ok(path === api.EMPLOYEE_BACKUP_CATALOG_PATH || TABLES.some(key => path === api.employeeBackupEntryPath(key)));
        assert.ok(bytes instanceof Uint8Array); w.writes.push(path);
        if (h.workspaceHook) await h.workspaceHook(w, path, bytes, signal);
        assert.equal(w.cleaned, false); await mkdir(dirname(join(base, path)), { recursive: true });
        assert.equal(w.cleaned, false); await appendFile(join(base, path), bytes);
      },
      open(path) { return { async *[Symbol.asyncIterator]() {
        assert.equal(w.cleaned, false);
        for await (const bytes of createReadStream(join(base, path), { highWaterMark: 137 })) { assert.equal(w.cleaned, false); yield bytes; }
      } }; },
      async abort() {
        w.cleaned = true; w.cleanups++; h.events.push(`cleanup-${h.workspaces.indexOf(w)}`);
        await rm(base, { recursive: true, force: true }); if (h.cleanupHook) await h.cleanupHook(w);
      },
    }; h.workspaces.push(w); return w;
  };
  h.filePath = join(directory, 'independent.edx');
  h.file = {
    async write(source, signal) {
      h.writes++; h.events.push('file-write');
      if (options.shortWrite) { for await (const bytes of source) { assert.ok(bytes.length); break; } return; }
      const handle = await open(h.filePath, 'wx');
      try { for await (const raw of source) { assert.equal(signal.aborted, false); await handle.writeFile(raw); } await handle.sync(); }
      finally { await handle.close(); }
      if (h.fileWriteHook) await h.fileWriteHook(signal);
    },
    open() {
      h.opens++; h.events.push('file-open');
      if (h.fileReadHook) return h.fileReadHook();
      return { async *[Symbol.asyncIterator]() { for await (const bytes of createReadStream(h.filePath, { highWaterMark: 113 })) yield bytes; h.events.push('file-eof'); } };
    },
  };
  h.connect = () => { api.setHarness(h); return api.createEmployeeBackupSession(TOKEN, SOURCE, JOB); };
  h.export = (extra = {}) => api.exportEmployeeBackup(h.connect(), h.file, h.createWorkspace, PASS, h.info, extra);
  return h;
}
function redacted(error) {
  assert.ok(error instanceof api.EmployeeBackupError); assert.equal(error.message.includes(SECRET), false);
  assert.equal('cause' in error, false); assert.match(error.message, /not a complete employee backup/); return true;
}
function cleaned(h) { for (const w of h.workspaces) { assert.equal(w.cleaned, true); assert.equal(w.cleanups, 1); } }
function deviceInfo(h, raw) {
  const original = `"device_info":{"precise":${PRECISE},"tiny":${TINY},"null":null}`;
  const all = lines(h.text.employee_login_history);
  assert.equal(all[2].split(original).length, 2);
  all[2] = all[2].replace(original, `"device_info":${raw}`);
  h.text.employee_login_history = all.join(''); h.catalog = catalog(h.text);
}
function devicePageValidation(h) {
  const key = 'employee_login_history', previous = JSON.parse(lines(h.text[key])[1]).id;
  const page = h.reply(PAGE, { p_table_key: key, p_after: previous, p_catalog_fingerprint: h.catalog.fingerprint, p_limit: 200 });
  const checkedCatalog = api.validateEmployeeBackupCatalog(h.catalog);
  return () => api.validateEmployeeBackupPage(page, checkedCatalog, key, previous);
}
async function collect(source) {
  const chunks = []; for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
async function unpack(h, passphrase = PASS) {
  const files = new Map();
  const manifest = await api.verifyEncryptedVolume(h.file.open(), passphrase, {
    async append(path, raw) { files.set(path, Buffer.concat([files.get(path) ?? Buffer.alloc(0), Buffer.from(raw)])); }, async abort() { files.clear(); },
  }, { expectedMetadata: { exportId: h.info.exportId, volumeId: h.info.volumeId } });
  return { files, manifest };
}
async function rejected(h, options = {}, inspect) {
  await assert.rejects(h.export(options), error => { redacted(error); inspect?.(error); return true; }); cleaned(h);
}

test('real independent encrypted file preserves all 15 raw tables and original package, with distinct backup UUID and two server checks', async t => {
  const h = fixture(t), result = await h.export();
  assert.equal(result.recordsVerified, true); assert.equal(result.completeEmployeeBackup, false); assert.equal(result.mediaIncluded, false);
  assert.equal(result.canArchive, false); assert.equal(result.canReplace, false); assert.equal(result.fullSiteComplete, false); assert.deepEqual(result.missingDomains, missing);
  assert.equal(h.verifyCount, 2); assert.equal(h.writes, 1); assert.equal(h.opens, 1); cleaned(h);
  assert.equal(h.tokenReads, h.calls.length);
  const bytes = await readFile(h.filePath); assert.equal(result.cipherBytes, bytes.length); assert.equal(result.cipherSha256, sha(bytes));
  assert.equal(bytes.includes(Buffer.from(PRECISE)), false); assert.equal(bytes.includes(Buffer.from('$2a$hashed-account')), false);
  const restored = await unpack(h); assert.deepEqual(restored.manifest, result.manifest);
  assert.equal(result.manifest.exportId, h.info.exportId); assert.notEqual(result.backupId, PACKAGE); assert.equal(result.manifest.sourceSiteId, TARGET_SITE);
  assert.deepEqual(result.manifest.entries.map(e => e.path), [...TABLES.map(api.employeeBackupEntryPath), api.EMPLOYEE_BACKUP_CATALOG_PATH]);
  for (const key of TABLES) assert.equal(restored.files.get(api.employeeBackupEntryPath(key)).toString(), h.text[key], key);
  const storedCatalog = JSON.parse(restored.files.get(api.EMPLOYEE_BACKUP_CATALOG_PATH).toString());
  assert.equal(storedCatalog.package_id, PACKAGE); assert.equal(storedCatalog.job_id, JOB); assert.equal(storedCatalog.source_site_id, SOURCE_SITE);
  assert.match(h.text.wallet_transactions, new RegExp(PRECISE.replace('.', '\\.'))); assert.match(h.text.employee_login_history, /"device_info_is_sql_null":true/);
  assert.match(h.text.employee_login_history, /"device_info_is_sql_null":false/); assert.match(h.text.accounts, /"updated_at":null/);
  const firstVerify = h.events.indexOf(VERIFY), write = h.events.indexOf('file-write'), eof = h.events.indexOf('file-eof'), finalVerify = h.events.lastIndexOf(VERIFY);
  assert.ok(firstVerify < write); assert.ok(h.events.indexOf('cleanup-0') < h.events.indexOf('file-open')); assert.ok(eof < finalVerify);
  assert.ok(h.events.indexOf('cleanup-1') > finalVerify);
  await assert.rejects(unpack(h, 'wrong passphrase'));
});
test('multiple real pages and bigint numeric cursors preserve 2,10,large,max-int64 order and exact microseconds', async t => {
  const h = fixture(t, { many: true, pageSize: 200 }); const result = await h.export(); const { files } = await unpack(h);
  assert.equal(files.get(api.employeeBackupEntryPath('employee_login_history')).toString(), h.text.employee_login_history);
  const loginPages = h.calls.filter(c => c.name === PAGE && c.args.p_table_key === 'employee_login_history'); assert.equal(loginPages.length, 2);
  assert.match(files.get(api.employeeBackupEntryPath('wallet_ledger_entries')).toString(), /9223372036854775807/);
  assert.match(files.get(api.employeeBackupEntryPath('wallet_transactions')).toString(), /\.123456\+00:00/);
  assert.equal(result.rows, h.catalog.tables.reduce((n, item) => n + item.rows, 0)); cleaned(h);
});
test('empty optional domains stay zero-byte entries rather than fabricated records', async t => {
  const h = fixture(t);
  for (const key of TABLES.filter(key => key !== 'accounts')) h.text[key] = '';
  h.catalog = catalog(h.text); const result = await h.export(), restored = await unpack(h);
  assert.equal(result.rows, 1); assert.equal(restored.files.get(api.employeeBackupEntryPath('wallets')).length, 0); cleaned(h);
});

const DEVICE_SECRET_KEYS = ['currentSessionToken', 'currentTabId', 'sessionId', 'sessionToken', 'tokenHash',
  'accessToken', 'refreshToken', 'serviceRoleKey', 'anonKey', 'password', 'passwordHash', 'token'];
const normalizeDeviceKey = key => key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
const deviceNesting = [
  pair => `{"hardware":{"details":{"security":{${pair}}}}}`,
  pair => `[{"ordinary":true},[null,{"details":{${pair}}}]]`,
  pair => `{"nested":[[[],{"payload":[{${pair}}]}]]}`,
];
for (const [index, key] of DEVICE_SECRET_KEYS.entries()) {
  const snake = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  const variants = [
    ['camelCase', JSON.stringify(key)],
    ['uppercase', JSON.stringify(key.toUpperCase())],
    ['snake_case', JSON.stringify(snake)],
    ['mixed-case hyphenated', JSON.stringify(snake.replaceAll('_', '-').split('').map((letter, i) => i % 2 ? letter.toUpperCase() : letter.toLowerCase()).join(''))],
    ['interleaved separators', JSON.stringify([...key].join('_-'))],
    ['Unicode-escaped', `"${[...snake].map(letter => `\\u${letter.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"`],
  ];
  for (const [variantIndex, [variant, rawKey]] of variants.entries()) test(`device_info rejects deep ${key} ${variant} before persisting or disclosing content`, async t => {
    assert.equal(normalizeDeviceKey(JSON.parse(rawKey)), normalizeDeviceKey(key));
    const h = fixture(t), payload = deviceNesting[(index + variantIndex) % deviceNesting.length](`${rawKey}:${JSON.stringify(SECRET)}`);
    deviceInfo(h, payload);
    assert.throws(devicePageValidation(h));
    let appended = 0, leakedToWorkspace = false;
    h.workspaceHook = (_w, _path, raw) => {
      appended++; leakedToWorkspace ||= Buffer.from(raw).includes(Buffer.from(SECRET));
    };
    await rejected(h, {}, error => {
      const visible = [String(error), JSON.stringify(error), inspect(error)].join('\n');
      for (const privateText of [SECRET, payload, PASS, SESSION, '$2a$hashed-account', '$2a$hashed-financial-password']) {
        assert.equal(visible.includes(privateText), false, 'Failure details must not expose source contents');
      }
      assert.equal(error.phase, 'records-export'); assert.equal(error.encryptedFileState, 'not-written');
      assert.equal(error.outcomeUnknown, false);
    });
    assert.ok(appended > 0); assert.equal(leakedToWorkspace, false);
    assert.equal(h.writes, 0); assert.equal(h.opens, 0); assert.equal(h.verifyCount, 0);
    await assert.rejects(readFile(h.filePath), { code: 'ENOENT' });
  });
}
for (const value of ['null', 'false', '0', '[]', '{}']) test(`device_info rejects nested current_session_token even with ${value} value`, async t => {
  const h = fixture(t); deviceInfo(h, `{"history":[{"current_session_token":${value}}]}`);
  assert.throws(devicePageValidation(h));
  await rejected(h); assert.equal(h.writes, 0); assert.equal(h.verifyCount, 0);
  await assert.rejects(readFile(h.filePath), { code: 'ENOENT' });
});
const historicalDevice = `{
  "session_created_at": ${JSON.stringify(TIME)},
  "sessionCreatedAt": ${JSON.stringify(TIME)},
  "SeSsIoN-CrEaTeD-At": ${JSON.stringify(TIME)},
  "history": [null, {"\\u0073ession_created_at": ${JSON.stringify(TIME)}, "session_updated_at": null,
    "precision": ${PRECISE}, "tiny": ${TINY}, "nullable": null}],
  "description": ${JSON.stringify('current_session_token, password and tokenHash are historical labels; {"refreshToken":"text, not a structured key"}')}
}`.replaceAll('\n', '');
for (const [shape, raw] of [['object', historicalDevice], ['array', `[null,[${historicalDevice}],{"created_at":${JSON.stringify(TIME)},"value":null}]`]]) {
  test(`device_info historical ${shape} preserves allowed session_created_at, raw precision, escapes and both null markers`, async t => {
    const h = fixture(t); deviceInfo(h, raw); devicePageValidation(h)();
    const result = await h.export(), { files } = await unpack(h);
    const restored = files.get(api.employeeBackupEntryPath('employee_login_history'));
    assert.deepEqual(restored, Buffer.from(h.text.employee_login_history));
    assert.ok(restored.includes(Buffer.from(`"device_info":${raw}`)));
    for (const original of [TIME, PRECISE, TINY, '"\\u0073ession_created_at"', '"session_updated_at": null', '"nullable": null']) {
      assert.ok(restored.includes(Buffer.from(original)), 'Historical JSON bytes must not be normalized or rounded');
    }
    const loginRows = lines(restored.toString()).map(line => JSON.parse(line));
    assert.deepEqual(loginRows.slice(0, 2).map(row => [row.device_info, row.device_info_is_sql_null]), [[null, true], [null, false]]);
    assert.equal(result.recordsVerified, true); assert.equal(h.verifyCount, 2); cleaned(h);
  });
}

// Match SQL39: device_info itself is depth 0, each child adds 1; the login row is not part of this depth.
for (const shape of ['object', 'array']) for (const leaf of ['null', '{}', '[]']) for (const depth of [64, 65]) {
  test(`device_info depth ${depth} ${shape} with ${leaf} leaf ${depth === 64 ? 'preserves raw bytes without counting the login wrapper' : 'rejects before record or encrypted file writes'}`, async t => {
    const opening = shape === 'object' ? '{ "child" : ' : '[ ', closing = shape === 'object' ? ' }' : ' ]';
    const raw = opening.repeat(depth) + leaf + closing.repeat(depth);
    // Exactly `depth` edges separate the device root from the terminal null/empty container.
    let terminal = JSON.parse(raw);
    for (let i = 0; i < depth; i++) terminal = shape === 'object' ? terminal.child : terminal[0];
    assert.deepEqual(terminal, JSON.parse(leaf));
    const h = fixture(t); deviceInfo(h, raw);
    if (depth === 64) {
      const page = devicePageValidation(h)();
      assert.equal(page.count, 1); assert.equal(page.next_after, null);
      assert.deepEqual(Buffer.from(page.raw), Buffer.from(lines(h.text.employee_login_history)[2]));
      const result = await h.export(), { files } = await unpack(h);
      const restored = files.get(api.employeeBackupEntryPath('employee_login_history'));
      assert.deepEqual(restored, Buffer.from(h.text.employee_login_history));
      assert.ok(restored.includes(Buffer.from(`"device_info":${raw}`)));
      assert.equal(result.recordsVerified, true); assert.equal(h.writes, 1); assert.equal(h.verifyCount, 2); cleaned(h);
    } else {
      assert.throws(devicePageValidation(h));
      const blockedId = JSON.parse(lines(h.text.employee_login_history)[2]).id;
      let blockedRowAppended = false, loginAppends = 0;
      h.workspaceHook = (_workspace, path, bytes) => {
        if (path === api.employeeBackupEntryPath('employee_login_history')) {
          loginAppends++; blockedRowAppended ||= Buffer.from(bytes).includes(Buffer.from(blockedId));
        }
      };
      await rejected(h, {}, error => {
        assert.equal(error.phase, 'records-export'); assert.equal(error.encryptedFileState, 'not-written');
        assert.equal(error.outcomeUnknown, false);
      });
      assert.ok(loginAppends > 0); assert.equal(blockedRowAppended, false);
      assert.equal(h.writes, 0); assert.equal(h.opens, 0); assert.equal(h.verifyCount, 0);
      await assert.rejects(readFile(h.filePath), { code: 'ENOENT' });
    }
  });
}

test('employee backup uses separate 1 GiB payload, 1100 MiB ZIP and 1101 MiB ciphertext limits', () => {
  const limits = api.EMPLOYEE_BACKUP_LIMITS, MiB = 1024 * 1024;
  assert.equal(limits.maxTotalBytes, 1024 * MiB);
  assert.equal(limits.maxZipBytes, 1100 * MiB); assert.equal(limits.maxCipherBytes, 1101 * MiB);
  assert.ok(limits.maxZipBytes > limits.maxTotalBytes); assert.ok(limits.maxCipherBytes > limits.maxTotalBytes);
  assert.ok(limits.maxCipherBytes > limits.maxZipBytes); assert.equal(Object.isFrozen(limits), true);
});
test('real encrypted small volume admits ZIP and cipher overhead beyond an exact payload limit without sharing their budgets', async t => {
  const h = fixture(t), defaults = { ...api.EMPLOYEE_BACKUP_LIMITS };
  const payloadBytes = h.catalog.tables.reduce((total, table) => total + table.bytes, 0)
    + Buffer.byteLength(JSON.stringify(api.validateEmployeeBackupCatalog(h.catalog)) + '\n');
  const result = await h.export({ limits: { maxTotalBytes: payloadBytes } });
  const cipher = await readFile(h.filePath);
  const zip = await collect(api.decryptTransferStream(h.file.open(), PASS, {
    expectedMetadata: { exportId: h.info.exportId, volumeId: h.info.volumeId },
  }));
  assert.equal(cipher.subarray(0, 8).toString(), 'EDXSTRM1');
  assert.equal(zip.readUInt32LE(0), 0x04034b50); assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(result.bytes, payloadBytes); assert.equal(result.cipherBytes, cipher.length);
  assert.ok(zip.length > payloadBytes); assert.ok(cipher.length > zip.length);
  assert.ok(cipher.length < 1024 * 1024, 'This test must use a small real file, never a GiB allocation');
  const { files, manifest } = await unpack(h);
  assert.deepEqual(manifest, result.manifest);
  assert.equal([...files.values()].reduce((total, raw) => total + raw.length, 0), payloadBytes);
  const makeSink = () => ({ async append() {}, async abort() {} });
  const source = () => (async function* () { yield cipher; })();
  const expectedMetadata = { exportId: h.info.exportId, volumeId: h.info.volumeId };
  assert.deepEqual(await api.verifyEncryptedVolume(source(), PASS, makeSink(), {
    expectedMetadata, limits: { maxTotalBytes: payloadBytes, maxZipBytes: zip.length },
  }), result.manifest);
  await assert.rejects(api.verifyEncryptedVolume(source(), PASS, makeSink(), {
    expectedMetadata, limits: { maxTotalBytes: payloadBytes - 1, maxZipBytes: zip.length },
  }));
  await assert.rejects(api.verifyEncryptedVolume(source(), PASS, makeSink(), {
    expectedMetadata, limits: { maxTotalBytes: payloadBytes, maxZipBytes: zip.length - 1 },
  }));
  const tooSmall = fixture(t);
  await rejected(tooSmall, { limits: { maxTotalBytes: payloadBytes - 1 } }); assert.equal(tooSmall.writes, 0);
  assert.deepEqual(api.EMPLOYEE_BACKUP_LIMITS, defaults); assert.equal(h.verifyCount, 2); cleaned(h);
});

const catalogEdits = [
  ['version', c => { c.version = 2; }], ['protocol', c => { c.protocol = 'shared-settings'; }], ['scope', c => { c.scope = 'full-site'; }],
  ['source UUID', c => { c.source_employee_id = id(99); }], ['job UUID', c => { c.job_id = id(99); }],
  ['hash shape', c => { c.fingerprint = 'x'.repeat(64); }], ['source fingerprint', c => { c.source_fingerprint = '0'.repeat(63); }],
  ['incomplete flag', c => { c.complete_employee_backup = true; }], ['sealed flag', c => { c.backup_sealed = true; }],
  ['media flag', c => { c.media_included = true; }], ['archive flag', c => { c.can_archive = true; }], ['replace flag', c => { c.can_replace = true; }],
  ['full-site flag', c => { c.full_site_complete = true; }], ['missing chat', c => { c.missing_domains.shift(); }],
  ['excluded sessions', c => { c.excluded_data.shift(); }], ['extra catalog field', c => { c.secret = SECRET; }],
  ['omitted table', c => { c.tables.pop(); }], ['duplicate table', c => { c.tables[1] = { ...c.tables[0] }; }],
  ['rows bound', c => { c.tables[2].rows = 500001; }], ['fractional bytes', c => { c.tables[2].bytes = 1.2; }],
  ['table bytes bound', c => { c.tables[2].bytes = 268435457; }], ['negative rows', c => { c.tables[2].rows = -1; }],
  ['unsafe integer', c => { c.tables[2].rows = Number.MAX_SAFE_INTEGER + 1; }], ['accounts count', c => { c.tables[0].rows = 2; }],
  ['projection secret', c => { c.projections.accounts.current_session_token = 'uuid'; }],
  ['projection detailed order', c => { c.projections.orders.product_value = 'numeric'; }],
  ['projection numeric type', c => { c.projections.wallets.available_balance = 'text'; }],
  ['total volume bytes', c => { for (const table of c.tables) if (['orders', 'wallet_ledger_entries', 'wallet_transactions', 'withdrawals', 'wallet_reconciliation_audit'].includes(table.key)) table.bytes = 268435456; }],
];
for (const [label, edit] of catalogEdits) test(`catalog rejects ${label} before saving any file`, async t => {
  const h = fixture(t); h.transform = (name, c) => { if (name === CATALOG) edit(c); return c; };
  await rejected(h); assert.equal(h.writes, 0); assert.equal(h.calls.length, 1);
});
for (const [label, edit] of [
  ['old source site', i => { i.sourceSiteId = SOURCE_SITE; }], ['old package UUID', i => { i.exportId = PACKAGE; }],
  ['original job UUID', i => { i.exportId = JOB; }], ['non-random UUID format', i => { i.exportId = 'not-a-uuid'; }],
  ['wrong scope', i => { i.scope = 'full-site'; }], ['multiple volumes', i => { i.volumeCount = 2; }],
]) test(`volume binding rejects ${label}`, async t => { const h = fixture(t); edit(h.info); await rejected(h); assert.equal(h.writes, 0); });

const pageEdits = [
  ['count', p => { p.count++; }], ['bytes', p => { p.bytes++; }], ['hash', p => { p.sha256 = '0'.repeat(64); }],
  ['wrong target UUID', p => { p.target_employee_id = id(99); }], ['wrong source UUID', p => { p.source_employee_id = id(99); }],
  ['wrong fingerprint', p => { p.fingerprint = '3'.repeat(64); }], ['wrong table', p => { p.table_key = 'credentials'; }],
  ['early termination', p => { p.next_after = null; }], ['alien continuation', p => { p.next_after = id(999); }],
  ['empty continuation', p => { p.ndjson = ''; p.count = 0; p.bytes = 0; p.sha256 = sha(''); p.next_after = id(999); }],
  ['extra permission', p => { p.can_archive = true; }], ['missing metadata field', p => { delete p.bytes; }],
  ['huge count', p => { p.count = 201; }], ['huge page', p => { p.ndjson = 'x'.repeat(262145); }],
  ['invalid surrogate', p => { p.ndjson = '\ud800\n'; p.count = 1; p.bytes = Buffer.byteLength(p.ndjson); p.sha256 = sha(p.ndjson); }],
];
for (const [label, edit] of pageEdits) test(`page rejects ${label}`, async t => {
  const h = fixture(t); h.transform = (name, p, args) => { if (name === PAGE && args.p_table_key === 'employee_login_history' && args.p_after === null) edit(p); return p; };
  await rejected(h); assert.equal(h.writes, 0);
});
const rowEdits = [
  ['foreign employee', text => text.replaceAll(TARGET, id(999))],
  ['unhashed historical session', text => text.replace(`history-${'a'.repeat(64)}`, 'secret-raw-session')],
  ['duplicate escaped key', text => text.replace('"user_id":', `"user_id":"${TARGET}","\\u0075ser_id":`)],
  ['missing field', text => text.replace(/,"ip_address":"[^"]*"/, '')],
  ['extra secret field', text => text.replace('{', '{"current_session_token":"secret",')],
  ['invalid JSON', () => '{invalid secret}\n'],
  ['lost final LF', text => text.trimEnd()],
  ['duplicate row', text => lines(text)[0] + lines(text)[0] + lines(text).slice(2).join('')],
  ['wrong row order', text => { const all = lines(text); [all[0], all[1]] = [all[1], all[0]]; return all.join(''); }],
  ['SQL null marker inconsistency', text => text.replace('"device_info":null', '"device_info":{"present":true}')],
];
for (const [label, edit] of rowEdits) test(`raw record rejects ${label} even with updated per-page hashes`, async t => {
  const h = fixture(t); h.text.employee_login_history = edit(h.text.employee_login_history); h.catalog = catalog(h.text);
  await rejected(h); assert.equal(h.writes, 0);
});
test('detailed order and active account session keys are refused even if catalog projection is unmodified', async t => {
  for (const key of ['orders', 'accounts']) {
    const h = fixture(t); h.text[key] = h.text[key].replace('{', key === 'orders' ? '{"product_value":10,' : '{"current_tab_id":"secret",'); h.catalog = catalog(h.text);
    await rejected(h); assert.equal(h.writes, 0);
  }
});
test('catalog row hashes detect same-size raw record changes and a silently dropped page', async t => {
  const h = fixture(t); const original = h.text.wallet_transactions; h.text.wallet_transactions = original.replace('原始文字', '變更文字');
  assert.equal(Buffer.byteLength(original), Buffer.byteLength(h.text.wallet_transactions));
  await rejected(h); assert.equal(h.writes, 0);
  const dropped = fixture(t, { many: true });
  dropped.transform = (name, p, args) => { if (name === PAGE && args.p_table_key === 'employee_login_history' && args.p_after === null) { p.ndjson = lines(dropped.text.employee_login_history).slice(2, 4).join(''); p.count = 2; p.bytes = Buffer.byteLength(p.ndjson); p.sha256 = sha(p.ndjson); p.next_after = JSON.parse(lines(p.ndjson).at(-1)).id; } return p; };
  await rejected(dropped); assert.equal(dropped.writes, 0);
});
test('invalid bigint forms, bounds and lexicographic rather than numeric row order fail closed', async t => {
  for (const value of ['09007199254740993', '9223372036854775808', '-1', '0']) {
    const h = fixture(t); h.text.wallet_ledger_entries = h.text.wallet_ledger_entries.replace('"2"', JSON.stringify(value)); h.catalog = catalog(h.text);
    await rejected(h);
  }
  const h = fixture(t); const all = lines(h.text.wallet_ledger_entries); h.text.wallet_ledger_entries = [all[1], all[0], ...all.slice(2)].join(''); h.catalog = catalog(h.text); await rejected(h);
});

for (const stage of [1, 2]) for (const [label, edit] of [
  ['drift', v => { v.fingerprint = '4'.repeat(64); }], ['wrong target', v => { v.target_employee_id = id(99); }],
  ['wrong source', v => { v.source_employee_id = id(99); }], ['not verified', v => { v.verified = false; }],
  ['coverage claim', v => { v.missing_domains = []; }], ['archive permit', v => { v.can_archive = true; }],
]) test(`server verification ${stage} rejects ${label}`, async t => {
  const h = fixture(t); h.transform = (name, value) => { if (name === VERIFY && h.verifyCount === stage) edit(value); return value; };
  await rejected(h); assert.equal(h.writes, stage === 1 ? 0 : 1);
});
for (const name of [CATALOG, PAGE, VERIFY]) test(`${name} transport failure is redacted, not retried and never permits sealing`, async t => {
  const h = fixture(t); h.rpcHook = endpoint => { if (endpoint === name) throw new Error(SECRET); };
  await rejected(h); assert.equal(h.calls.filter(c => c.name === name).length, 1); assert.equal(h.writes, 0);
});

test('unknown completed file write receipt and short consumption cannot report success or be retried', async t => {
  const h = fixture(t); h.fileWriteHook = () => { throw new Error(SECRET); };
  await rejected(h, {}, e => { assert.equal(e.outcomeUnknown, true); assert.equal(e.encryptedFileState, 'unknown'); });
  assert.ok((await readFile(h.filePath)).length); assert.equal(h.writes, 1); assert.equal(h.opens, 0);
  const short = fixture(t, { shortWrite: true }); await rejected(short, {}, e => assert.equal(e.outcomeUnknown, true)); assert.equal(short.writes, 1);
});
test('saved ciphertext tamper, truncation, trailing bytes and invalid password encryption are rejected on actual authentication', async t => {
  for (const type of ['tamper', 'truncate', 'trailing', 'wrong-password']) {
    const h = fixture(t); h.fileWriteHook = async () => {
      const bytes = await readFile(h.filePath);
      if (type === 'tamper') { bytes[Math.floor(bytes.length / 2)] ^= 1; await writeFile(h.filePath, bytes); }
      else if (type === 'truncate') await writeFile(h.filePath, bytes.subarray(0, bytes.length - 1));
      else if (type === 'trailing') await appendFile(h.filePath, Buffer.from([0]));
      else {
        const entries = (async function* () { for (const key of TABLES) yield { path: api.employeeBackupEntryPath(key), bytes: Buffer.byteLength(h.text[key]), open: () => (async function* () { yield Buffer.from(h.text[key]); })() }; })();
        const result = []; for await (const chunk of api.writeEncryptedVolume(entries, h.info, 'different-password')) result.push(Buffer.from(chunk));
        await writeFile(h.filePath, Buffer.concat(result));
      }
    };
    await rejected(h, {}, e => assert.equal(e.encryptedFileState, 'saved')); assert.equal(h.verifyCount, 1); assert.equal(h.writes, 1);
  }
});
test('decrypting a different valid file, even with matching volume identity, cannot substitute the confirmed file', async t => {
  const h = fixture(t); h.fileWriteHook = async () => {
    const entries = (async function* () { yield { path: 'data/replacement.ndjson', bytes: 3, open: () => (async function* () { yield Buffer.from('{}\n'); })() }; })();
    const bytes = []; for await (const raw of api.writeEncryptedVolume(entries, h.info, PASS)) bytes.push(Buffer.from(raw));
    await writeFile(h.filePath, Buffer.concat(bytes));
  }; await rejected(h); assert.equal(h.verifyCount, 1);
});
test('tighter total bound counts catalog metadata, oversize raw rows include LF, and zero-row hash must be empty digest', async t => {
  const h = fixture(t); const selected = h.catalog.tables.reduce((n, table) => n + table.bytes, 0);
  await rejected(h, { limits: { maxTotalBytes: selected } }); assert.equal(h.writes, 0);
  const oversized = fixture(t); oversized.text.accounts = oversized.text.accounts.replace('原始備註', 'x'.repeat(65536)); oversized.catalog = catalog(oversized.text);
  await rejected(oversized); assert.equal(oversized.writes, 0);
  const empty = fixture(t); empty.text.wallets = ''; empty.catalog = catalog(empty.text); empty.catalog.tables.find(t => t.key === 'wallets').row_hashes_sha256 = '0'.repeat(64);
  await rejected(empty); assert.equal(empty.writes, 0);
});
for (const which of [0, 1]) test(`plaintext workspace ${which} cleanup failure denies success and is not retried`, async t => {
  const h = fixture(t); h.cleanupHook = w => { if (h.workspaces.indexOf(w) === which) throw Error(SECRET); };
  await rejected(h, {}, error => assert.equal(error.cleanupRequired, true)); assert.equal(h.writes, 1);
});
test('reused workspace and corrupted readback workspace cannot fake independent confirmation', async t => {
  const h = fixture(t); const factory = h.createWorkspace; let original;
  h.createWorkspace = () => original ??= factory(); await rejected(h);
  const corrupt = fixture(t); corrupt.workspaceHook = (w, path, raw) => { if (corrupt.workspaces.indexOf(w) === 1 && path.endsWith('-accounts.ndjson')) raw[0] ^= 1; };
  await rejected(corrupt); assert.equal(corrupt.verifyCount, 1);
});

for (const stage of ['before', 'page', 'save', 'authenticate', 'cleanup']) test(`cancellation during ${stage} never claims rollback or returns success`, async t => {
  const h = fixture(t), controller = new AbortController();
  if (stage === 'before') controller.abort();
  if (stage === 'page') h.rpcHook = name => { if (name === PAGE) controller.abort(); };
  if (stage === 'save') h.fileWriteHook = () => controller.abort();
  if (stage === 'authenticate') h.fileReadHook = () => (async function* () { controller.abort(); yield Buffer.from([0]); })();
  if (stage === 'cleanup') h.cleanupHook = () => controller.abort();
  await rejected(h, { signal: controller.signal }, error => { assert.equal(error.cancelled, true); assert.match(error.message, /No automatic retry, delete, rollback/); });
});
test('blocked read cancellation closes the iterator and still awaits workspace cleanup', async t => {
  const h = fixture(t), controller = new AbortController(); let started, closed = 0;
  const pending = new Promise(resolve => { started = resolve; });
  h.fileReadHook = () => ({ [Symbol.asyncIterator]() { return { next() { started(); return new Promise(() => {}); }, return() { closed++; return Promise.resolve({ done: true }); } }; } });
  const operation = h.export({ signal: controller.signal }); await pending; controller.abort();
  await assert.rejects(operation, redacted); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, 1); cleaned(h);
});
test('session reads current login token on every RPC and binds job/source/target/fingerprint across re-login', async t => {
  const h = fixture(t), session = h.connect(), cat = await session.catalog();
  h.session = id(90); await session.page(cat, 'accounts', null); h.session = id(91); await session.verify(cat);
  assert.deepEqual(h.calls.map(call => call.args.p_admin_session_token), [SESSION, id(90), id(91)]); assert.equal(h.tokenReads, 3);
  const changed = structuredClone(cat); changed.job_id = id(99);
  await assert.rejects(session.page(changed, 'accounts', null)); await assert.rejects(session.verify(changed)); assert.equal(h.calls.length, 3);
  h.catalog.target_employee_id = id(99); await assert.rejects(session.catalog()); assert.equal(h.calls.length, 4);
});
test('session rejects concurrent requests without an RPC and can continue only after the first finishes', async t => {
  const h = fixture(t), session = h.connect(); let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), wait = new Promise(resolve => { release = resolve; });
  h.rpcHook = async () => { enter(); await wait; };
  const pending = session.catalog(); await entered;
  await assert.rejects(session.catalog()); assert.equal(h.calls.length, 1);
  release(); const c = await pending; h.rpcHook = null; await session.verify(c); assert.equal(h.calls.length, 2);
});
test('missing login/invalid UUID, unknown table and unbound page cannot call transport', async t => {
  const h = fixture(t); const session = h.connect();
  assert.throws(() => api.createEmployeeBackupSession('bad', SOURCE)); await assert.rejects(session.page(h.catalog, 'accounts', null));
  h.session = null; await assert.rejects(session.catalog()); assert.equal(h.calls.length, 0);
  h.session = SESSION; const c = await session.catalog(); await assert.rejects(session.page(c, 'public.users', null));
  await assert.rejects(session.page(c, 'wallet_ledger_entries', '09007199254740993')); assert.equal(h.calls.length, 1);
});
