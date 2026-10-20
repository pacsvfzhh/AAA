import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, mock, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TRANSFER_PRODUCTION_COVERAGE_INVENTORY } from './support/transfer-scope.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const TABLES = ['content_audit_events', 'deleted_employee_accounts', 'deleted_employee_notifications',
  'content_audit_recipient_versions', 'deleted_employee_summaries', 'deleted_employee_withdrawals'];
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(1), PACKAGE = id(2), SESSION = id(3), PRECISE = '12345678901234567890.12345678901234567890';
const sha = raw => createHash('sha256').update(raw).digest('hex');
const counts = () => Object.fromEntries(TABLES.map(key => [key, 1]));
const source = (n = 1) => ({ source_site_id: id(n), package_id: PACKAGE,
  imported_at: '2024-02-29T23:34:56.123456+00:00', counts: counts(), media_pending: true });
const namespaces = (items = [source()], next_after = null) => ({ items, next_after });
function row(key, n = 10) {
  if (key === TABLES[4]) return { id: id(n), employee_id: id(9), source_present: false, is_verified: null,
    total_income: 0, available_balance: null, frozen_balance: 0, total_orders: '9223372036854775807' };
  if (key === TABLES[5]) return { id: `${id(9)}:${id(n)}`, record_id: id(9), withdrawal_id: id(n), employee_id: id(9),
    amount: 0, status: 'approved', created_at: '2024-02-29T23:34:56.123456Z' };
  const columns = TRANSFER_PRODUCTION_COVERAGE_INVENTORY.find(t => t.schema === 'private' && t.name === key).columns;
  const result = Object.fromEntries(columns.map(c => [c.name, c.nullable ? null : ({ uuid: id(n), text: '<img src=x onerror=alert(1)>',
    jsonb: { text: '<script>alert(1)</script>', precise: 0 }, 'timestamp with time zone': '2024-02-29T23:34:56.123456Z' })[c.type]]));
  if (key === TABLES[0]) Object.assign(result, { before_data_sql_null: true, after_data_sql_null: true });
  if (key === TABLES[2]) Object.assign(result, { message_data_sql_null: true, recipient_data_sql_null: true });
  if (key === TABLES[3]) result.id = `${result.message_id}:${result.recipient_id}`;
  return result;
}
const line = (key, n = 10) => JSON.stringify(row(key, n)).replaceAll('"precise":0', `"precise":${PRECISE}`)
  .replaceAll('"amount":0', `"amount":${PRECISE}`).replaceAll('"total_income":0', `"total_income":${PRECISE}`) + '\n';
const page = (key, raw = line(key), next_after = null) => ({ table_key: key, count: raw ? raw.split('\n').length - 1 : 0,
  ndjson: raw, next_after, sha256: sha(raw) });
mock.method(globalThis, 'fetch', () => assert.fail('All network/production/Storage access is prohibited'));
after(() => mock.restoreAll());
const compiled = await build({ stdin: { contents: `export * from './src/lib/employeeTransfer/archiveReader.ts';
  export {default as Panel, TestRowSummary, TestSourceIdentity, TestPager, TestArchiveRow} from './src/components/admin/TransferredArchivesPanel.tsx';
  export {setHarness} from 'reader-test:state';`, resolveDir: root, loader: 'js' },
  bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2020', jsx: 'automatic', metafile: true,
  plugins: [{ name: 'isolated-reader', setup(builder) {
    builder.onResolve({ filter: /^(?:react(?:\/.*)?|lucide-react)$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
    builder.onResolve({ filter: /^(reader-test:state|\.\.\/(?:auth|supabase))$/ }, args => ({ path: args.path, namespace: 'reader-test' }));
    builder.onLoad({ filter: /TransferredArchivesPanel\.tsx$/ }, async args => ({ loader: 'tsx', contents:
      await readFile(args.path, 'utf8') + '\nexport {RowSummary as TestRowSummary, SourceIdentity as TestSourceIdentity, Pager as TestPager, ArchiveRow as TestArchiveRow};' }));
    builder.onLoad({ filter: /.*/, namespace: 'reader-test' }, ({ path }) => {
      if (path === 'reader-test:state') return { contents: 'let h;export const setHarness=v=>{h=v};export const current=()=>h;' };
      if (path === '../auth') return { contents: `import{current}from'reader-test:state';export function getAdminFinancialSessionToken(){const h=current();h.reads++;return h.session;}` };
      return { contents: `import{current}from'reader-test:state';export const supabase={rpc:(...args)=>current().rpc(...args)};` };
    });
  } }] });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
function harness() {
  const h = { session: SESSION, reads: 0, calls: [], reply: namespaces(), error: null, wait: null, rpc(name, args) {
    assert.ok(['get_employee_transferred_archive_namespaces', 'get_employee_transferred_archive_page'].includes(name));
    const call = { name, args, signal: null }; h.calls.push(call);
    const q = { abortSignal(s) { call.signal = s; return q; }, then(resolve, reject) {
      return (h.wait ?? Promise.resolve({ data: h.reply, error: h.error })).then(resolve, reject);
    } }; return q;
  } }; api.setHarness(h); return h;
}
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('reader bundles no real authentication, Supabase client or write/media APIs', () => {
  assert.equal(Object.keys(compiled.metafile.inputs).some(p => /src\/lib\/(?:auth|supabase)\.ts/.test(p)), false);
  assert.deepEqual(Object.keys(api.createTransferredArchivesReader()).sort(), ['namespaces', 'page']);
});
test('namespace RPC reads a fresh session for each request and passes cursor, limit and abort signal', async () => {
  const h = harness(), reader = api.createTransferredArchivesReader(), controller = new AbortController();
  assert.deepEqual(await reader.namespaces(null, 30, controller.signal), namespaces());
  assert.equal(h.calls[0].name, 'get_employee_transferred_archive_namespaces');
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_after: null, p_limit: 30 });
  assert.equal(h.calls[0].signal, controller.signal);
  h.session = id(4); h.reply = namespaces([]); await reader.namespaces(`${SITE}:${PACKAGE}`, 1);
  assert.equal(h.calls[1].args.p_admin_session_token, id(4)); assert.equal(h.reads, 2);
});
for (const key of TABLES) test(`${key}: validates real six-table shape and preserves original bytes, ID and NDJSON`, async () => {
  const h = harness(), reader = api.createTransferredArchivesReader(), raw = line(key); h.reply = page(key, raw);
  const result = await reader.page(SITE, PACKAGE, key);
  assert.equal(result.ndjson, raw); assert.equal(result.rows[0].sourceLine, raw);
  assert.equal(result.rows[0].sourceId, row(key).id); assert.equal(result.sha256, sha(raw));
  assert.equal(Object.isFrozen(result.rows[0]), true);
  assert.deepEqual(h.calls[0].args, { p_admin_session_token: SESSION, p_source_site_id: SITE,
    p_package_id: PACKAGE, p_table_key: key, p_after: null, p_limit: 100 });
});
for (const mutate of [p => { p.sha256 = 'a'.repeat(64); }, p => { p.count++; }, p => { p.next_after = id(99); },
  p => { p.table_key = TABLES[1]; }, p => { p.ndjson = p.ndjson.trim(); p.sha256 = sha(p.ndjson); },
  p => { p.ndjson += p.ndjson; p.sha256 = sha(p.ndjson); p.count = 2; }]) {
  test(`row receipt rejects corrupted hash/count/cursor/order/line contract ${mutate.toString()}`, () => {
    const p = page(TABLES[0]); mutate(p); assert.throws(() => api.validateTransferredArchivePage(p, TABLES[0]));
  });
}
test('row pages enforce requested limit, nonrepeating after and next cursor with byte-limited short pages', () => {
  const key = TABLES[4], raw = line(key), p = page(key, raw, id(10));
  assert.equal(api.validateTransferredArchivePage(p, key, null, 100).next_after, id(10));
  assert.throws(() => api.validateTransferredArchivePage(p, key, id(10)));
  const two = page(key, raw + line(key, 11)); assert.throws(() => api.validateTransferredArchivePage(two, key, null, 1));
  assert.equal(api.validateTransferredArchivePage(page(key, ''), key).count, 0);
});
for (const mutate of [p => { p.items[0].source_site_id = 'not-a-uuid'; }, p => { p.items[0].media_pending = 'false'; },
  p => { p.items[0].counts.content_audit_events = 9007199254740992; }, p => { delete p.items[0].counts.deleted_employee_summaries; },
  p => { p.items[0].imported_at = '2024-01-01'; }, p => { p.next_after = `${id(99)}:${PACKAGE}`; },
  p => { p.items.push(p.items[0]); }, p => { p.secret = 'unexpected'; }]) {
  test(`namespace contract rejects malformed receipt ${mutate.toString()}`, () => {
    const p = namespaces(); mutate(p); assert.throws(() => api.validateTransferredArchiveNamespaces(p));
  });
}
test('namespace pages enforce C ordering, canonical cursor, next cursor and exact requested page size', () => {
  const items = [source(1), source(2)], after = `${id(2)}:${PACKAGE}`;
  assert.deepEqual(api.validateTransferredArchiveNamespaces(namespaces(items, after), null, 2).items, items);
  assert.throws(() => api.validateTransferredArchiveNamespaces(namespaces(items.reverse()), null, 2));
  assert.throws(() => api.validateTransferredArchiveNamespaces(namespaces([source()]), `${SITE}:${PACKAGE}`));
  assert.throws(() => api.validateTransferredArchiveNamespaces(namespaces(), null, 0));
  assert.throws(() => api.validateTransferredArchiveNamespaces(namespaces(), null, 101));
});
test('invalid inputs cannot dispatch RPCs; backend errors are redacted without retry', async () => {
  const h = harness(), reader = api.createTransferredArchivesReader();
  for (const action of [() => reader.namespaces('broken'), () => reader.namespaces(null, 0),
    () => reader.page(SITE, PACKAGE, 'users'), () => reader.page(SITE, PACKAGE, TABLES[0], 'broken')]) await assert.rejects(action());
  assert.equal(h.calls.length, 0);
  h.error = { message: 'secret-backend-raw-token' };
  await assert.rejects(reader.namespaces(), error => !String(error).includes('secret-backend-raw-token') && !('cause' in error));
  assert.equal(h.calls.length, 1);
});
test('pre-abort and mid-read cancellation discard responses without automatic retry or cancel-job call', async () => {
  const h = harness(), reader = api.createTransferredArchivesReader(); const before = new AbortController(); before.abort();
  await assert.rejects(reader.namespaces(null, 30, before.signal), { name: 'AbortError' }); assert.equal(h.calls.length, 0);
  let resolve; h.wait = new Promise(yes => { resolve = yes; }); const during = new AbortController();
  const pending = reader.namespaces(null, 30, during.signal); await new Promise(yes => setImmediate(yes)); during.abort();
  await assert.rejects(pending, { name: 'AbortError' }); resolve({ data: namespaces(), error: null });
  assert.equal(h.calls.length, 1);
});
test('UI initial contract is read-only and does not fetch on SSR or expose old attachment links', () => {
  const h = harness(); const html = render(api.Panel);
  for (const text of ['超級管理員唯讀', '來源站', '來源包', '附件待核驗', '不與新站在職帳戶或財務資料串聯', '來源上一頁', '來源下一頁']) assert.ok(html.includes(text), text);
  assert.equal(h.calls.length, 0); assert.doesNotMatch(html, /<(?:a|iframe|video)\b|dangerouslySetInnerHTML/);
});
test('UI identifies site/package and formats import and historical time as UTC+8', () => {
  const html = render(api.TestSourceIdentity, { source: source() });
  assert.ok(html.includes(SITE)); assert.ok(html.includes(PACKAGE)); assert.match(html, /2024\/03\/01\s+07:34:56 \(UTC\+8\)/);
  const summary = render(api.TestRowSummary, { row: { sourceId: row(TABLES[5]).id, sourceLine: line(TABLES[5]) }, tableKey: TABLES[5] });
  assert.ok(summary.includes('UTC+8')); assert.equal(summary.includes('1234567890'), false, 'no rounded financial summary');
});
test('UI summaries escape hostile HTML; original precision, SQL-null markers and source line remain untouched', () => {
  const raw = line(TABLES[0]); const checked = api.validateTransferredArchivePage(page(TABLES[0], raw), TABLES[0]);
  const html = render(api.TestRowSummary, { row: checked.rows[0], tableKey: TABLES[0] });
  assert.ok(html.includes('&lt;img')); assert.doesNotMatch(html, /<img|<script/);
  assert.equal(checked.rows[0].sourceLine, raw); assert.ok(raw.includes('"before_data_sql_null":true'));
  for (const key of [TABLES[4], TABLES[5]]) assert.ok(api.validateTransferredArchivePage(page(key), key).rows[0].sourceLine.includes(PRECISE));
});
for (const key of TABLES) test(`${key}: actual expandable row renders ORIGINAL text safely without amount/ID reserialization`, () => {
  const raw = line(key), checked = api.validateTransferredArchivePage(page(key, raw), key);
  const html = render(api.TestArchiveRow, { row: checked.rows[0], tableKey: key });
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1];
  const decoded = pre.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  assert.equal(decoded, raw);
  assert.doesNotMatch(html, /<(?:script|img|iframe|a)\b/);
  assert.match(html, /<details/); assert.match(html, /來源原始行/);
});
test('numeric values outside JS float range are retained as raw numeric tokens, not Infinity or null', () => {
  const key = TABLES[5], raw = line(key).replace(PRECISE, '1e400');
  const checked = api.validateTransferredArchivePage(page(key, raw), key);
  const html = render(api.TestArchiveRow, { row: checked.rows[0], tableKey: key });
  assert.ok(html.includes('1e400')); assert.equal(html.includes('Infinity'), false); assert.equal(checked.ndjson, raw);
});
test('UI pager preserves confirmed page on error, exposes explicit retry, and wires previous/next actions', () => {
  let previous = 0, next = 0, retry = 0;
  const state = { loaded: { data: { next_after: id(20) }, navigation: { after: id(10), history: [null] } },
    loading: false, error: true, previous: () => previous++, next: () => next++, retry: () => retry++ };
  const html = render(api.TestPager, { page: state, label: '檔案記錄' });
  assert.match(html, /第 2 頁/); assert.match(html, /保留目前確認的頁面/); assert.match(html, /重試檔案記錄/);
  const tree = api.TestPager({ page: { ...state, error: false }, label: '檔案記錄' });
  tree.props.children[0].props.onClick(); tree.props.children[2].props.onClick();
  api.TestPager({ page: state, label: '檔案記錄' }).props.children[4].props.children[1].props.onClick();
  assert.deepEqual([previous, next, retry], [1, 1, 1]);
});
test('third tab is lazy-only; original two workflows remain separate and raw pre never executes HTML', async () => {
  const audit = await readFile(`${root}src/components/admin/ContentAuditPanel.tsx`, 'utf8');
  const panel = await readFile(`${root}src/components/admin/TransferredArchivesPanel.tsx`, 'utf8');
  assert.match(audit, /lazy\(\(\) => import\('\.\/TransferredArchivesPanel'\)\)/);
  assert.match(audit, /\['archives', '遷入檔案'\]/); assert.match(audit, /view === 'employees' &&/); assert.match(audit, /view === 'content' &&/);
  assert.match(panel, /<pre[^>]*[\s\S]*?\{row\.sourceLine\}<\/pre>/);
  assert.match(panel, /whitespace-pre-wrap/); assert.match(panel, /overflow-wrap:anywhere/);
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML|JSON\.stringify|href=|\.from\(/);
});
